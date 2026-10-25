/**
 * MotionStudio —— 视图宿主：区域树、几何排布、编辑器生命周期、分隔条拖拽
 *
 * 契约 §9 的三条硬约束都在这里落地：
 * 1. 每个工作区（animate / draw / free）有**独立的一棵区域树 + 一套 DOM**，
 *    全部是 #ws-host 的绝对定位子对象；切工作区只切 display，不销毁编辑器。
 * 2. 几何完全由 layout.mjs 的 computeRects 求出，外壳只写 left/top/width/height；
 *    拖分隔条期间绝不重建 DOM（引擎画布不搬家，撤销栈不清空）。
 * 3. 编辑器实例按区域缓存，只有换编辑器才 destroy + 重挂；画布是工作区单实例，
 *    区域搬家时调 editors/canvas.mjs 的 placeCanvas 搬宿主，而不是重建引擎。
 *
 * 依赖方向：doc-state（状态 / 小工具 / 面板刷新）、areas、layout、registry、
 * chrome、persist、editors/canvas；以及 app.mjs 的 ctx ——
 * `def.mount(slot.body, ctx)` 只在运行期解引用，所以 app.mjs ↔ view-host.mjs
 * 的循环引用不会在初始化期碰到未初始化的绑定。
 */

import {
    createArea,
    findNode,
    walkAreas,
    splitNode,
    joinNode,
    swapEditors,
    serialize,
    deserialize,
} from './areas.mjs';
import { computeRects, resizeAcross, freezeAxis, MIN_AREA } from './layout.mjs';
import { EDITORS, editorDef, editorTitle } from './registry.mjs';
import { WS_IDS } from './chrome.mjs';
import { icon } from '../core/icons.mjs';
import { saveLayout, clearLayout } from './persist.mjs';
import * as canvasEditor from '../editors/canvas.mjs';
import {
    FALLBACK_EDITOR,
    state,
    shell,
    el,
    px,
    viewList,
    activeView,
    engine,
    scheduleRefresh,
    flash,
    updateChrome,
} from './doc-state.mjs';
// 运行期注入：顶层 import app.mjs 会形成 app ↔ view-host 循环，
// 循环中 app.mjs 顶层立即展开 ctx-time 时绑定还没就绪。
let CTX = null;
/** 由 app.mjs 在 boot() 里注入（那时 ctx 已全部建好）。 */
export function setCtx(c) {
    CTX = c;
}

/* ─────────────────────────── 默认布局 ─────────────────────────── */

/** 进动画工作区前的工具（切回来时恢复，避免用户在绘图区拿到 select 画不出东西）。 */
let lastDrawTool = 'brush';

function areaNode(editor, size) {
    const a = createArea(editor);
    if (typeof size === 'number') a.size = size;
    return a;
}

/** 三种工作区的默认区域树（契约 §默认布局）。 */
function defaultTree(ws) {
    if (ws === 'draw') {
        // v8 定稿：画板是**独立的纹理编辑器**，有自己的 canvas 和自己的相机，
        // 与编排区的画布（舞台）互不相干。绘图区 = 左列（对象与纹理栈 / 调色）+ 画板。
        // 画板只认「当前时刻的那一张纹理」，不套对象变换、不参与合成。
        // v8 收口：画板自带工具条（画笔入口），引擎的 toolbar 区域在这里是重复的第二套，不放。
        return {
            type: 'split',
            dir: 'row',
            children: [
                // 左列整列定宽 232；里层的 260 是列内**高度**，与宽度互不干扰
                {
                    type: 'split',
                    dir: 'col',
                    size: 232,
                    // 调色定高，对象栈吃掉剩下的高度：对象/画格是这一屏的主角
                    children: [areaNode('layers'), areaNode('palette', 260)],
                },
                areaNode('board'),
            ],
        };
    }
    if (ws === 'free') {
        // 设置模式：上排是全局设置（文档 / 洋葱皮 / 偏好 三块定宽，信息吃余量），
        // 下排是帮助 —— 帮助条目又多又长，横着铺开比挤在窄列里好读。
        return {
            type: 'split',
            dir: 'col',
            children: [
                {
                    type: 'split',
                    dir: 'row',
                    size: 330,
                    children: [areaNode('doc', 300), areaNode('onion', 300), areaNode('prefs', 320), areaNode('info')],
                },
                areaNode('help'),
            ],
        };
    }
    // 编排模式：不画画，所以不放工具条与调色板（画笔在这里是锁死的，放出来只是噪音）。
    // 撤销/重做已上移到顶栏，随时可用。
    return {
        type: 'split',
        dir: 'col',
        children: [
            {
                type: 'split',
                dir: 'row',
                children: [
                    // 左列整列定宽 232，画布吃掉剩下的宽度，属性面板定宽 292。
                    {
                        type: 'split',
                        dir: 'col',
                        size: 232,
                        children: [areaNode('layers', 200)],
                    },
                    areaNode('canvas'),
                    areaNode('properties', 292),
                ],
            },
            // 下方并排：画格（像素属于哪一格）+ 曲线（对象在画格之间怎么动）
            {
                type: 'split',
                dir: 'row',
                size: 220,
                children: [areaNode('timeline'), areaNode('curve', 560)],
            },
        ],
    };
}

/**
 * 设置模式的「偏好」区域是后加的：老布局存档里没有它，纯靠 defaultTree 不会出现
 * （有存档就整棵树来自 deserialize）。这里就地补一个，省得用户为此去按「重置布局」。
 */
function ensurePrefsArea(tree) {
    if (!tree) return tree;
    if (walkAreas(tree).some((a) => a.editor === 'prefs')) return tree;
    const prefs = areaNode('prefs', 320);
    if (tree.type === 'split' && tree.dir === 'row' && Array.isArray(tree.children)) {
        const children = tree.children.slice();
        // 没有 size 的区域是弹性项，习惯留在最右边：新定宽区域插到它前面
        const flexAt = children.findIndex((c) => c && c.type === 'area' && typeof c.size !== 'number');
        children.splice(flexAt < 0 ? children.length : flexAt, 0, prefs);
        return { ...tree, children };
    }
    // 根不是横向分栏（用户自己改成竖排了）：单独包一层，保证这块面板一定在
    return { type: 'split', dir: 'row', children: [tree, prefs] };
}

function ensureHelpArea(tree) {
    if (!tree) return tree;
    if (walkAreas(tree).some((a) => a.editor === 'help')) return tree;
    const help = areaNode('help');
    // 帮助是长文本，纵向追加到底部最合适；根不是竖排就单独包一层
    if (tree.type === 'split' && tree.dir === 'col' && Array.isArray(tree.children)) {
        return { ...tree, children: [...tree.children, help] };
    }
    return { type: 'split', dir: 'col', children: [tree, help] };
}

function createView(ws) {
    return {
        ws,
        tree: null,
        map: new Map(), // areaId -> {id, el, head, body, sel, editor, inst}
        splitters: new Map(), // 路径键 -> splitter 对象
        canvasAreaId: null,
        canvasInst: null,
        canvasBody: null,
        canvasHostEl: null,
    };
}

/**
 * 绘图工作区回归「对象管理 + 画板」：画板曾经是一个独立的缓冲区编辑器（board），
 * v8 起画板＝主画布上的当前画格，所以老布局存档里那张 board 区域必须就地换回 canvas。
 * 只改 editor 字段，id / 尺寸 / 用户自己摆的结构全部保留。
 */
function retargetDrawAreas(node) {
    // draw 工作区的画布区域在 v8 里换成独立的画板编辑器（board），见下方 walk 逻辑
    if (!node || typeof node !== 'object') return node;
    // 反过来：老存档里 draw 的 canvas 区域要迁移成 board（独立画板）
    if (node.type === 'area') return node.editor === 'canvas' ? { ...node, editor: 'board' } : node;
    if (node.type !== 'split' || !Array.isArray(node.children)) return node;
    let changed = false;
    const children = node.children.map((c) => {
        const next = retargetDrawAreas(c);
        if (next !== c) changed = true;
        return next;
    });
    return changed ? { ...node, children } : node;
}

/**
 * v8 收口：绘图工作区不再要引擎的工具条 —— 画板（board）自带画笔入口，
 * 两套画笔并排只是重复。老存档里残留的 toolbar 区域就地摘掉（纯函数，不改入参）：
 * - area 且 editor==='toolbar' → null（标记删除）
 * - split → 递归过滤；空壳返回 null；只剩一个孩子时上顶（子节点自己的 size/grow
 *   优先，否则继承父 split），与 areas.mjs 的 removeArea 同语义
 * - 没碰到 toolbar 时原样返回同一引用，调用方可以据此跳过写入
 */
function stripDrawToolbar(node) {
    if (!node || typeof node !== 'object') return node;
    if (node.type === 'area') return node.editor === 'toolbar' ? null : node;
    if (node.type !== 'split' || !Array.isArray(node.children)) return node;
    const children = [];
    let changed = false;
    for (const child of node.children) {
        const next = stripDrawToolbar(child);
        if (next !== child) changed = true;
        if (next) children.push(next);
    }
    if (!changed) return node;
    if (children.length === 0) return null;
    if (children.length === 1) {
        // 上提：父 split 的布局字段转交给唯一的子节点（子节点自己的值优先）
        const only = { ...children[0] };
        if (only.size === undefined && typeof node.size === 'number') only.size = node.size;
        if (only.grow === undefined && typeof node.grow === 'boolean') only.grow = node.grow;
        return only;
    }
    return { ...node, children };
}

function buildViews(saved) {
    for (const ws of WS_IDS) {
        const view = createView(ws);
        const raw = saved && saved.trees ? saved.trees[ws] : null;
        const restored = raw ? deserialize(raw) : null;
        view.tree = restored && walkAreas(restored).length ? restored : defaultTree(ws);
        if (ws === 'draw') {
            const migrated = stripDrawToolbar(retargetDrawAreas(view.tree));
            // 极端存档（整棵树只剩一条 toolbar）摘空后回到默认布局
            view.tree = migrated && walkAreas(migrated).length ? migrated : defaultTree('draw');
        }
        if (ws === 'free') view.tree = ensureHelpArea(ensurePrefsArea(view.tree));
        state.views[ws] = view;
    }
    const want = saved && saved.active && WS_IDS.indexOf(saved.active) >= 0 ? saved.active : 'animate';
    state.workspace = want;
    // 冷启动就按工作区上锁：动画工作区不落笔，只做选择/变换/关键帧
    state.drawLocked = want === 'animate';
    if (state.drawLocked && engine.state.tool !== 'select') engine.setTool('select');
}

function syncActiveTree() {
    const view = activeView();
    state.activeTree = view ? view.tree : null;
}

function saveCurrentLayout() {
    const trees = {};
    for (const ws of WS_IDS) {
        const v = state.views[ws];
        trees[ws] = v ? serialize(v.tree) : null;
    }
    saveLayout({ active: state.workspace, trees });
}

/* ─────────────────────────── 几何 ─────────────────────────── */

function hostBox() {
    const host = shell.host;
    const w = host ? host.clientWidth : 0;
    const h = host ? host.clientHeight : 0;
    const vw = typeof window !== 'undefined' ? window.innerWidth : 0;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 0;
    return { x: 0, y: 0, w: Math.max(1, Math.round(w || vw || 1)), h: Math.max(1, Math.round(h || vh || 1)) };
}

function place(elmt, r) {
    elmt.style.left = px(r.x);
    elmt.style.top = px(r.y);
    elmt.style.width = px(r.w);
    elmt.style.height = px(r.h);
}

function pathKey(path) {
    return path.join(':');
}

/** 只写几何：拖分隔条期间走这条路径，保证 DOM 不重建。 */
function applyRects(view, rects, geometryOnly) {
    for (const a of rects.areas) {
        const slot = view.map.get(a.id);
        if (slot) place(slot.el, a.rect);
    }
    const seen = new Set();
    for (const sp of rects.splitters) {
        const key = pathKey(sp.path);
        let spEl = view.splitters.get(key);
        if (!spEl) {
            if (geometryOnly) continue;
            spEl = createSplitter(view, sp);
            view.splitters.set(key, spEl);
        }
        spEl._info = { parentPath: sp.parentPath, index: sp.index, dir: sp.dir };
        place(spEl, sp.rect);
        seen.add(key);
    }
    if (geometryOnly) return;
    for (const [key, spEl] of Array.from(view.splitters)) {
        if (seen.has(key)) continue;
        if (spEl.parentNode) spEl.parentNode.removeChild(spEl);
        view.splitters.delete(key);
    }
}

function applyVisibility(view) {
    const on = view.ws === state.workspace;
    const display = on ? '' : 'none';
    for (const slot of view.map.values()) {
        if (slot.el.style.display !== display) slot.el.style.display = display;
    }
    for (const spEl of view.splitters.values()) {
        if (spEl.style.display !== display) spEl.style.display = display;
    }
}

/** 一个工作区的完整渲染：结构同步 + 几何 + 可见性。 */
function renderView(view) {
    if (!shell.host) return;
    if (!view.tree) view.tree = defaultTree(view.ws);
    const rects = computeRects(view.tree, hostBox());
    syncAreas(view, rects);
    applyRects(view, rects, false);
    applyVisibility(view);
    // 画布宿主是全局单例：渲染隐藏工作区时，那边的画布编辑器 mount 会把宿主搬进自己
    // 的 body（canvas.mjs 的 mount 内部就调 placeCanvas），所以这里立刻收回到当前工作区，
    // 维持「谁可见，宿主就在谁那里」这条不变量 —— 否则宿主会留在 display:none 的区域里。
    if (view !== activeView()) syncCanvasToActive();
}

function render() {
    for (const ws of WS_IDS) {
        const view = state.views[ws];
        if (view) renderView(view);
    }
    syncActiveTree();
    // 隐藏工作区的画布挂载可能把单例引擎抢走，这里统一收回到当前工作区
    syncCanvasToActive();
    engine.scheduleRender();
    updateChrome();
}

/* ─────────────────────────── 区域 DOM ─────────────────────────── */

function createSlot(view, areaNodeSrc) {
    const areaEl = el('div', 'area');
    areaEl.dataset.id = areaNodeSrc.id;
    areaEl.dataset.ws = view.ws;

    const head = el('div', 'area-head');

    const grip = el('div', 'area-grip');
    grip.title = '拖动可与其它区域互换位置';
    head.appendChild(grip);

    const sel = el('select', 'area-type');
    sel.title = '区域类型';
    for (const def of EDITORS) {
        const opt = el('option', null, def.title);
        opt.value = def.id;
        opt.title = def.hint || '';
        sel.appendChild(opt);
    }
    head.appendChild(sel);

    head.appendChild(el('div', 'area-gap'));

    const acts = [
        ['split-h', 'rows', '横向分割（上下）'],
        ['split-v', 'columns', '竖向分割（左右）'],
        ['close', 'x', '关闭区域'],
    ];
    for (const [act, iconName, title] of acts) {
        const b = el('button', 'area-btn ms-icon-btn');
        b.type = 'button';
        b.dataset.act = act;
        b.innerHTML = icon(iconName);
        b.title = title;
        b.setAttribute('aria-label', title);
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            onAreaAct(view, areaNodeSrc.id, act);
        });
        head.appendChild(b);
    }

    // 双击标题栏 = 折叠/展开：折叠后这个区域只有标题栏高度（layout.mjs 的 COLLAPSED_AREA），
    // 它的兄弟区域自动吃掉剩余空间；状态随布局一起存盘。
    head.addEventListener('dblclick', (e) => {
        const t = e.target;
        if (t && t.closest && (t.closest('button') || t.closest('select'))) return;
        e.preventDefault();
        toggleAreaCollapsed(view, areaNodeSrc.id);
    });

    const body = el('div', 'area-body');

    areaEl.appendChild(head);
    areaEl.appendChild(body);
    shell.host.appendChild(areaEl);

    const slot = { id: areaNodeSrc.id, el: areaEl, head, body, sel, editor: '', inst: null };
    view.map.set(areaNodeSrc.id, slot);

    sel.value = areaNodeSrc.editor;
    sel.addEventListener('change', () => setAreaEditor(view, slot.id, sel.value));
    grip.addEventListener('pointerdown', (e) => onGripDown(view, slot, e));
    return slot;
}

/** 结构同步：删掉树里已经没有的区域，为每个区域保证「正确的编辑器在位」。 */
/**
 * 把某个区域折/展并提交布局。
 * 只改树上这一个节点的 collapsed 标记 —— 尺寸归 distribute 算，不在这里写死左右邻居。
 */
function mapAreaNodes(node, fn) {
    if (!node || typeof node !== 'object') return node;
    if (node.type === 'area') return fn(node);
    if (node.type !== 'split' || !Array.isArray(node.children)) return node;
    return { ...node, children: node.children.map((c) => mapAreaNodes(c, fn)) };
}

function toggleAreaCollapsed(view, areaId) {
    let hit = false;
    const next = mapAreaNodes(view.tree, (node) => {
        if (node.id !== areaId) return node;
        hit = true;
        const out = { ...node };
        if (node.collapsed === true) delete out.collapsed;
        else out.collapsed = true;
        return out;
    });
    if (!hit) return false;
    commitTree(view, next);
    return true;
}

function syncAreas(view, rects) {
    const alive = new Set(rects.areas.map((a) => a.id));
    const canvasIds = rects.areas.filter((a) => a.editor === 'canvas').map((a) => a.id);
    view.canvasAreaId = canvasIds.length ? canvasIds[0] : null;

    for (const [id, slot] of Array.from(view.map)) {
        if (alive.has(id)) continue;
        // 画布实例不随区域销毁，留给新的宿主区域
        const keepCanvas = !!slot.inst && slot.inst === view.canvasInst;
        if (keepCanvas) slot.inst = null;
        dropSlot(view, slot, keepCanvas);
    }
    if (!view.canvasAreaId && view.canvasInst) destroyCanvasInstance(view);

    // 画布宿主先处理：先把实例搬到新区域，其它区域才不会误销毁它
    const ordered = [];
    const rest = [];
    for (const a of rects.areas) {
        if (a.id === view.canvasAreaId) ordered.push(a);
        else rest.push(a);
    }
    for (const a of rest) ordered.push(a);

    for (const a of ordered) {
        let slot = view.map.get(a.id);
        if (!slot) slot = createSlot(view, a);
        if (slot.sel.value !== a.editor) slot.sel.value = a.editor;
        // 折叠只影响「身体」是否显示：标题栏始终在，双击即可展开。
        // 折起来的那一维是「窄条」还是「扁条」由父容器方向决定，靠纵横 class 区分排版。
        if (slot.collapsed !== a.collapsed) {
            slot.collapsed = a.collapsed;
            slot.el.classList.toggle('is-collapsed', a.collapsed);
            slot.body.style.display = a.collapsed ? 'none' : '';
        }
        if (a.collapsed) {
            const vertical = a.rect && a.rect.w < a.rect.h;
            slot.el.classList.toggle('is-collapsed-v', !!vertical);
            slot.el.classList.toggle('is-collapsed-h', !vertical);
            const label = editorDef(a.editor).title;
            if (slot.head.getAttribute('data-title') !== label) slot.head.setAttribute('data-title', label);
        }
        if (a.editor === 'canvas') {
            if (a.id === view.canvasAreaId) ensureCanvas(view, slot);
            else showNote(view, slot, 'canvas', '画布在每个工作区只有一个：请把该区域换成别的编辑器，或关闭原画布区域');
        } else if (slot.editor !== a.editor) {
            slot.failedFor = null;
            mountEditor(view, a.editor, a.id);
        } else if (!slot.inst && !slot.failedFor) {
            // 挂载失败过的编辑器不再每帧重试，避免报错刷屏
            mountEditor(view, a.editor, a.id);
        }
    }
}

function dropSlot(view, slot, keepCanvas) {
    if (keepCanvas) slot.inst = null;
    else unmountSlot(view, slot);
    if (slot.el && slot.el.parentNode) slot.el.parentNode.removeChild(slot.el);
    if (view.canvasBody === slot.body) view.canvasBody = null;
    view.map.delete(slot.id);
}

/**
 * 销毁一个区域的编辑器实例。画布实例绝不在这里销毁：
 * 它属于整个工作区，只能由 destroyCanvasInstance 处理（否则引擎画布会丢）。
 */
function unmountSlot(view, slot) {
    const inst = slot.inst;
    slot.inst = null;
    if (inst && inst === view.canvasInst) {
        console.warn('[shell] 阻止在区域销毁时卸载画布实例');
    } else if (inst && typeof inst.destroy === 'function') {
        try {
            inst.destroy();
        } catch (err) {
            console.error('[shell] 销毁编辑器失败：' + slot.editor, err);
        }
    }
    if (slot.body) {
        slot.body.textContent = '';
        slot.body.className = 'area-body';
    }
}

function showNote(view, slot, editorId, text) {
    if (slot.inst && slot.inst === view.canvasInst) return; // 保护正在运行的画布
    slot.inst = null;
    slot.editor = editorId;
    slot.body.className = 'area-body ed ed-' + editorId;
    slot.body.textContent = '';
    slot.body.appendChild(el('div', 'area-note', text));
}

/* ─────────────────────────── 编辑器挂载 ─────────────────────────── */

/**
 * 挂载编辑器。已有实例且类型未变时**不重挂**（重挂会丢掉面板内部状态）。
 * @param {object} view 工作区视图
 * @param {string} editorId 编辑器 id
 * @param {string} [areaId] 指定区域；省略时取该编辑器在树里的第一个区域
 */
function mountEditor(view, editorId, areaId) {
    const area = areaId ? findNode(view.tree, areaId) : walkAreas(view.tree).find((a) => a.editor === editorId);
    if (!area || area.type !== 'area') return null;
    if (area.editor !== editorId) return null;
    const slot = view.map.get(area.id);
    if (!slot) return null;
    if (slot.editor === editorId && slot.inst) return slot.inst;
    if (editorId === 'canvas' && view.canvasInst) {
        slot.editor = editorId;
        slot.inst = view.canvasInst;
        moveCanvasInto(view, slot);
        return view.canvasInst;
    }

    unmountSlot(view, slot);
    slot.editor = editorId;
    slot.body.className = 'area-body ed ed-' + editorId;

    const def = editorDef(editorId);
    let inst = null;
    if (!def) {
        slot.failedFor = editorId;
        showNote(view, slot, editorId, '未知编辑器：' + editorId);
        return null;
    }
    try {
        inst = def.mount(slot.body, CTX) || null;
    } catch (err) {
        console.error('[shell] 挂载编辑器失败：' + editorId, err);
        slot.failedFor = editorId;
        showNote(view, slot, editorId, '编辑器加载失败：' + editorId);
        return null;
    }
    slot.inst = inst;
    if (editorId === 'canvas') {
        view.canvasInst = inst;
        view.canvasBody = slot.body;
        const v = engine.view();
        view.canvasHostEl = (v && v.parentNode) || slot.body.querySelector('.cv-host') || null;
        scheduleAttachToActive();
        // canvas.mjs 的 mount 会把单例宿主 placeCanvas 到自己 body 里：若这次挂的是
        // 隐藏工作区，宿主就被抢走了，立刻还给当前工作区。
        if (view !== activeView()) syncCanvasToActive();
    }
    return inst;
}

function ensureCanvas(view, slot) {
    if (view.canvasInst) {
        if (slot.editor !== 'canvas') unmountSlot(view, slot);
        slot.editor = 'canvas';
        slot.inst = view.canvasInst;
        moveCanvasInto(view, slot);
        scheduleAttachToActive();
        return view.canvasInst;
    }
    if (slot.inst && slot.editor === 'canvas') return slot.inst;
    return mountEditor(view, 'canvas', slot.id);
}

/** 把画布宿主搬到新区域 —— 优先用 canvas.mjs 的 placeCanvas，缺失时自己搬 .cv-host。 */
function moveCanvasInto(view, slot) {
    if (view.canvasBody === slot.body) {
        slot.body.className = 'area-body ed ed-canvas';
        return true;
    }
    slot.body.textContent = '';
    slot.body.className = 'area-body ed ed-canvas';
    // 旧宿主区域还挂着的画布引用先摘掉，免得它被销毁时把画布一起带走
    for (const s of view.map.values()) {
        if (s !== slot && s.inst && s.inst === view.canvasInst) s.inst = null;
    }
    view.canvasBody = slot.body;
    // 宿主单例只有一个：渲染隐藏工作区时绝不搬它，否则会把当前工作区的画布抢走。
    // 等这个工作区被激活，syncCanvasToActive 会把它搬进来。
    if (view !== activeView()) {
        view.canvasHostEl = null;
        return true;
    }
    let ok = false;
    if (typeof canvasEditor.placeCanvas === 'function') {
        try {
            canvasEditor.placeCanvas(slot.body);
            ok = true;
        } catch (err) {
            console.error('[shell] placeCanvas 失败：', err);
        }
    }
    if (!ok) {
        const target =
            view.canvasHostEl ||
            (view.canvasBody && view.canvasBody.querySelector && view.canvasBody.querySelector('.cv-host')) ||
            engine.view();
        if (target && target !== slot.body) slot.body.appendChild(target);
    }
    const v = engine.view();
    view.canvasHostEl = (v && v.parentNode) || slot.body.querySelector('.cv-host') || null;
    return true;
}

/**
 * 清掉宿主里残留的引擎画布：编辑器模块可能在多次 mount 里重复 attach，
 * 而 paint/engine 的 attach 不会清理旧 canvas，这里统一收尾。
 */
function cleanStaleViews(hostEl) {
    const cur = engine.view();
    const list = hostEl.querySelectorAll('.kl-view');
    for (const node of list) {
        if (node === cur) continue;
        if (node.parentNode) node.parentNode.removeChild(node);
    }
}

/**
 * 画布宿主与引擎都是**单例**：三个工作区共用一块 `div.cv-host` 和一张显示画布。
 * 所以每次结构变化 / 切工作区之后，都要把宿主搬回当前工作区的画布区域，
 * 引擎只在「没挂上」或「挂在别处」时重挂 —— 已经在正确宿主里就是空操作，
 * 不重置缩放，也不重画。
 */
function syncCanvasToActive() {
    const view = activeView();
    const slot = view && view.canvasAreaId ? view.map.get(view.canvasAreaId) : null;
    if (!slot) return false;

    // 画布的 .cv-host 是 editors/canvas.mjs 的模块级单例，引擎只往它里面 attach 一次。
    // 三个工作区共用它，所以「跟随当前工作区」等于把宿主 div 搬过去 —— 搬而不是重建，
    // 这样引擎的画布、缩放与平移状态全都原样保留。
    if (typeof canvasEditor.placeCanvas === 'function') {
        try {
            canvasEditor.placeCanvas(slot.body);
        } catch (err) {
            console.warn('[shell] placeCanvas 失败：', err);
        }
    }
    const hostEl = slot.body.querySelector('.cv-host') || slot.body;
    view.canvasHostEl = hostEl;
    cleanStaleViews(hostEl);
    const cur = engine.view();
    if (cur && cur.parentNode === hostEl) return true;

    // 走到这里说明引擎没挂、或还挂在别的宿主里（刚启动、刚关过画布区域）
    try {
        engine.detach();
    } catch (err) {
        /* 引擎本来就没挂上 */
    }
    try {
        engine.attach(hostEl);
        try {
            engine.fitView();
        } catch (err2) {
            /* 布局尚未生效时 fitView 可能拿到 0 尺寸，忽略 */
        }
    } catch (err) {
        console.error('[shell] 引擎 attach 失败：', err);
        return false;
    }
    return true;
}

/** 延迟一帧再同步：留给编辑器模块在 mount 之后自己摆好宿主。 */
function scheduleAttachToActive() {
    requestAnimationFrame(() => syncCanvasToActive());
}

function destroyCanvasInstance(view) {
    const inst = view.canvasInst;
    view.canvasInst = null;
    view.canvasBody = null;
    view.canvasHostEl = null;
    for (const slot of view.map.values()) if (slot.inst === inst) slot.inst = null;
    if (inst && typeof inst.destroy === 'function') {
        try {
            inst.destroy();
        } catch (err) {
            console.error('[shell] 销毁画布失败：', err);
        }
    }
    // 编辑器没自己 detach 时兜底，否则下一区域会拿不到引擎画布
    if (engine.view()) engine.detach();
}

function destroyView(view) {
    for (const slot of Array.from(view.map.values())) {
        const isCanvas = !!slot.inst && slot.inst === view.canvasInst;
        if (!isCanvas) unmountSlot(view, slot);
        if (slot.el && slot.el.parentNode) slot.el.parentNode.removeChild(slot.el);
    }
    view.map.clear();
    for (const spEl of view.splitters.values()) if (spEl.parentNode) spEl.parentNode.removeChild(spEl);
    view.splitters.clear();
    destroyCanvasInstance(view);
}

/* ─────────────────────────── 区域操作 ─────────────────────────── */

function onAreaAct(view, areaId, act) {
    if (act === 'close') {
        const next = joinNode(view.tree, areaId);
        if (next === view.tree) {
            flash('只剩一个区域，不能再关闭');
            updateChrome();
            return;
        }
        commitTree(view, next);
        return;
    }
    const dir = act === 'split-v' ? 'row' : 'col';
    const next = splitNode(view.tree, areaId, dir);
    if (next === view.tree) return;
    commitTree(view, next);
}

function mapAreaEditor(tree, areaId, editorId) {
    if (!tree) return tree;
    if (tree.type === 'area') return tree.id === areaId ? { ...tree, editor: editorId } : tree;
    if (tree.type !== 'split' || !Array.isArray(tree.children)) return tree;
    return { ...tree, children: tree.children.map((c) => mapAreaEditor(c, areaId, editorId)) };
}

function setAreaEditor(view, areaId, editorId) {
    const target = findNode(view.tree, areaId);
    if (!target || target.type !== 'area') return;
    const want = editorId || FALLBACK_EDITOR;
    if (target.editor === want) return;
    if (want === 'canvas') {
        // 画布单实例：已有画布区域时做互换（Blender 的换编辑器语义）
        const other = walkAreas(view.tree).find((a) => a.editor === 'canvas' && a.id !== areaId);
        if (other) {
            commitTree(view, swapEditors(view.tree, areaId, other.id));
            flash('画布已移到该区域');
            updateChrome();
            return;
        }
    }
    commitTree(view, mapAreaEditor(view.tree, areaId, want));
    flash('已切换为' + editorTitle(want));
    updateChrome();
}

function commitTree(view, tree) {
    if (!tree) return;
    if (tree !== view.tree) view.tree = tree;
    syncActiveTree();
    saveCurrentLayout();
    render();
    flash('区域已更新');
    updateChrome();
}

function createSplitter(view, sp) {
    const spEl = el('div', 'splitter splitter--' + (sp.dir === 'col' ? 'col' : 'row'));
    spEl.dataset.ws = view.ws;
    spEl.addEventListener('pointerdown', (e) => onSplitDown(view, spEl, e));
    shell.host.appendChild(spEl);
    return spEl;
}

/** 拖动分隔条：freezeAxis 把整条轴钉成像素，之后每帧只重算矩形并写样式。 */
function onSplitDown(view, spEl, e) {
    const info = spEl._info;
    if (!info || e.button !== 0) return;
    e.preventDefault();
    const rects = computeRects(view.tree, hostBox());
    const sizes = childSizes(rects, info.parentPath, info.dir);
    const base = freezeAxis(view.tree, info.parentPath, sizes);
    const startX = e.clientX;
    const startY = e.clientY;
    let live = base;
    spEl.classList.add('is-dragging');
    try {
        spEl.setPointerCapture(e.pointerId);
    } catch (err) {
        /* 合成事件没有指针捕获，忽略 */
    }

    const move = (ev) => {
        const delta = info.dir === 'row' ? ev.clientX - startX : ev.clientY - startY;
        live = resizeAcross(base, info.parentPath, info.index, delta, MIN_AREA);
        applyRects(view, computeRects(live, hostBox()), true);
        engine.scheduleRender();
    };
    const up = () => {
        spEl.removeEventListener('pointermove', move);
        spEl.removeEventListener('pointerup', up);
        spEl.removeEventListener('pointercancel', up);
        spEl.classList.remove('is-dragging');
        commitTree(view, live);
    };
    spEl.addEventListener('pointermove', move);
    spEl.addEventListener('pointerup', up);
    spEl.addEventListener('pointercancel', up);
}

/** 某个 split 下每个子节点在轴上的实际像素长度（从矩形表反推，避免再算一遍 distribute）。 */
function childSizes(rects, parentPath, dir) {
    const depth = parentPath.length;
    const groups = new Map();
    for (const a of rects.areas) {
        if (a.path.length <= depth) continue;
        let match = true;
        for (let i = 0; i < depth; i++) {
            if (a.path[i] !== parentPath[i]) {
                match = false;
                break;
            }
        }
        if (!match) continue;
        const idx = a.path[depth];
        let g = groups.get(idx);
        if (!g) {
            g = { min: Infinity, max: -Infinity };
            groups.set(idx, g);
        }
        if (dir === 'row') {
            g.min = Math.min(g.min, a.rect.x);
            g.max = Math.max(g.max, a.rect.x + a.rect.w);
        } else {
            g.min = Math.min(g.min, a.rect.y);
            g.max = Math.max(g.max, a.rect.y + a.rect.h);
        }
    }
    return Array.from(groups.keys())
        .sort((a, b) => a - b)
        .map((i) => Math.max(0, groups.get(i).max - groups.get(i).min));
}

/** 拖区域头：命中判定用当前矩形表，松手才 swapEditors（不搬家 DOM）。 */
function onGripDown(view, slot, e) {
    if (e.button !== 0) return;
    e.preventDefault();
    const rects = computeRects(view.tree, hostBox());
    const hostRect = shell.host.getBoundingClientRect();
    slot.el.classList.add('is-dragging');
    let target = null;
    const move = (ev) => {
        const hit = hitArea(rects, hostRect, ev.clientX, ev.clientY, slot.id);
        if (hit === target) return;
        if (target) {
            const prev = view.map.get(target);
            if (prev) prev.el.classList.remove('is-drop');
        }
        target = hit;
        if (target) {
            const next = view.map.get(target);
            if (next) next.el.classList.add('is-drop');
        }
    };
    const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        slot.el.classList.remove('is-dragging');
        if (target) {
            const t = view.map.get(target);
            if (t) t.el.classList.remove('is-drop');
        }
        if (target && target !== slot.id) commitTree(view, swapEditors(view.tree, slot.id, target));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
}

function hitArea(rects, hostRect, clientX, clientY, excludeId) {
    const x = clientX - hostRect.left;
    const y = clientY - hostRect.top;
    for (const a of rects.areas) {
        if (a.id === excludeId) continue;
        const r = a.rect;
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return a.id;
    }
    return null;
}

/* ─────────────────────────── 工作区 ─────────────────────────── */

function setWorkspace(id) {
    if (!state.views[id]) return;
    // 锁与工作区解耦：冷启动、面板切换、快捷键都要一致。
    // 进动画工作区自动切「选择」并记住上一个工具，回绘图 / 自由时恢复 ——
    // 否则用户切到绘图工作区会拿到一个画不出东西的 select。
    const lock = id === 'animate';
    state.drawLocked = lock;
    if (lock) {
        if (engine.state.tool !== 'select') {
            lastDrawTool = engine.state.tool;
            engine.setTool('select');
        }
    } else if (engine.state.tool === 'select' && lastDrawTool && lastDrawTool !== 'select') {
        engine.setTool(lastDrawTool);
    }
    if (state.workspace !== id) {
        state.workspace = id;
        syncActiveTree();
        for (const view of viewList()) applyVisibility(view);
        saveCurrentLayout();
        engine.scheduleRender();
        scheduleRefresh();
        syncCanvasToActive();
    }
    updateChrome();
}

function resetLayout() {
    for (const ws of WS_IDS) {
        const view = state.views[ws];
        if (view) destroyView(view);
    }
    state.views = Object.create(null);
    buildViews(null);
    clearLayout();
    syncActiveTree();
    render();
    saveCurrentLayout();
    flash('布局已重置');
    updateChrome();
    syncCanvasToActive();
    return state.activeTree;
}


export {
    buildViews,
    syncActiveTree,
    setWorkspace,
    resetLayout,
    render,
    syncCanvasToActive,
    scheduleAttachToActive,
    stripDrawToolbar,
};
