// 对象面板（编辑器 id 仍为 layers，见 CONTRACT-v2 §1）：直接渲染 objectsOf(doc)（第 0 项是最上层）。
// 结构变更全部委托 core/cel.mjs 与 paint/ops.mjs 的纯函数，本文件只管交互与重绘。
// 选中态：.is-active = 当前操作对象（ctx.activeLayerId），.is-sel = 画布/面板选中的对象（ctx.selection）。

import { addLayer, removeLayer, moveLayer, patchLayer, celAt, imageAt, celTimes, objectsOf } from '../core/cel.mjs';
import { objectSize } from '../core/doc-model.mjs';
import { icon } from '../core/icons.mjs';
import { duplicateLayer, mergeDown } from '../paint/ops.mjs';
import { textureCount } from '../core/textures.mjs';

// 对象种类文案（CONTRACT-v2 §1：kind = 'paint' 手绘 / 'image' 导入图片）
const KIND_TEXT = { paint: '手绘', image: '图片' };
let dragId = null;   // v5：正在拖拽的对象 id（dragstart 里写入）
// v10：折叠体系随「叠放列表扁平化」下线 —— 本面板只回答「谁盖谁」，没有子层级可折；
// 父子层级与折叠归「父子」面板（tree.mjs）。旧 localStorage 键不再写入。
let popover = null;   // v5：时间通道浮层（懒创建、模块级复用）

// v8（第十六批）：对象动作不再折进 ⋯ 菜单。
// 上一版把 5 个动作收进菜单是为了省宽度，代价是「复制 / 上移 / 下移 / 合并 / 删除」每次都要先开菜单 ——
// 这五个都是对象栈的常用动作，宽度也用不着省（6 个 22px 按钮 ≈ 150px，面板 230px）。
// [act, 图标名, 提示] —— 图标来自 core/icons.mjs，全部纯图标，靠 title + aria-label 说明
const BAR_ACTS = [
    ['add', 'plus', '新建对象'],
    ['dup', 'copy', '复制对象'],
    ['up', 'chevron-up', '上移一层'],
    ['down', 'chevron-down', '下移一层'],
    ['merge', 'merge-down', '向下合并（结果会落到下层对象的坐标系）'],
    ['del', 'trash', '删除对象'],
];
// 动作全集：状态同步（置灰）与守卫提示都按这一份走
const ACTS = BAR_ACTS;

/* ───────────────────── 树形显示与拖拽落点：纯逻辑，零 DOM ─────────────────────
 * 单测在 tests/layers-tree.test.mjs。约定：
 * - objects 数组顺序 = 绘制顺序（composite 按它画），parentId 只表达归属；
 * - 深度优先遍历保证「父在前、子紧随」，同层内部仍按数组相对顺序；
 * - 环由 maxDepth / seen 兜住（core 的 setParent 已做环检测，这里只防脏数据）。 */

const MAX_TREE_DEPTH = 64;

/** 深度优先展开：返回 [{ layer, depth }]。根 = parentId 为空或指向不存在的对象。 */
export function treeOrder(all) {
    const list = Array.isArray(all) ? all.filter((o) => o && o.id != null) : [];
    const ids = new Set(list.map((o) => o.id));
    const byParent = new Map();
    for (const o of list) {
        if (o.parentId == null || !ids.has(o.parentId)) continue;
        const arr = byParent.get(o.parentId);
        if (arr) arr.push(o);
        else byParent.set(o.parentId, [o]);
    }
    const out = [];
    const seen = new Set();
    const walk = (o, depth) => {
        if (!o || seen.has(o.id) || depth > MAX_TREE_DEPTH) return;
        seen.add(o.id);
        out.push({ layer: o, depth });
        const kids = byParent.get(o.id);
        if (kids) for (const k of kids) walk(k, depth + 1);
    };
    for (const o of list) {
        if (o.parentId == null || !ids.has(o.parentId)) walk(o, 0);
    }
    // 父链成环的孤岛遍历不到，按原顺序补到最后（depth 记 0，至少让人看得见）
    for (const o of list) {
        if (!seen.has(o.id)) {
            seen.add(o.id);
            out.push({ layer: o, depth: 0 });
        }
    }
    return out;
}

/** 自身 + 全部后代的 id（深度优先，含自身）。 */
export function subtreeIds(all, id) {
    const list = Array.isArray(all) ? all : [];
    if (id == null) return [];
    const out = [];
    const seen = new Set();
    const queue = [id];
    while (queue.length) {
        const cur = queue.shift();
        if (cur == null || seen.has(cur)) continue;
        seen.add(cur);
        if (!list.some((o) => o && o.id === cur)) continue;
        out.push(cur);
        for (const o of list) if (o && o.parentId === cur) queue.push(o.id);
    }
    return out;
}

/** id 是否落在 ancestorId 的子树里（含 ancestorId 自身）。 */
export function isDescendantId(all, id, ancestorId) {
    if (id == null || ancestorId == null) return false;
    return subtreeIds(all, ancestorId).includes(id);
}

/** 三区判定：上缘 25% = 插到前、中间 50% = 投进去、下缘 25% = 插到后。 */
export function dropZone(ratio) {
    const r = Number.isFinite(ratio) ? ratio : 0.5;
    if (r < 0.25) return 'before';
    if (r > 0.75) return 'after';
    return 'into';
}

/** 落点合法性：非法时 reason 直接进 title / 光标提示，不弹窗。 */
export function dropVerdict(all, fromId, targetId, mode) {
    if (fromId == null) return { ok: false, reason: '没有可拖动的对象' };
    if (mode === 'rootEnd') return { ok: true, reason: '' };
    if (targetId == null) return { ok: false, reason: '没有落点' };
    if (fromId === targetId) return { ok: false, reason: '不能拖到自身' };
    if (isDescendantId(all, targetId, fromId)) return { ok: false, reason: '不能拖进自己的子对象里' };
    return { ok: true, reason: '' };
}

/**
 * 插入线的 `top`（内容坐标）。
 *
 * `.lyr-list` 是 `overflow-y: auto` + `position: relative`，插入线是它的绝对定位子元素 ——
 * 子元素的 top 跟**内容**一起滚，而 `getBoundingClientRect()` 给的是**视口**坐标。
 * 少加 `scrollTop` 就会出现「列表滚过之后，插入线还画在滚动前的位置」。
 *
 * @param {number} rowTop 目标行的 rect.top（视口坐标）
 * @param {number} rowBottom 目标行的 rect.bottom（视口坐标）
 * @param {number} listTop 列表的 rect.top（视口坐标）
 * @param {number} scrollTop 列表当前 scrollTop
 * @param {'before'|'after'} where 插在行的上缘还是下缘
 * @returns {number} 可直接写进 `style.top` 的像素值（不小于 0）
 */
export function dropLineTop(rowTop, rowBottom, listTop, scrollTop, where) {
    const edge = where === 'before' ? rowTop : rowBottom;
    const y = edge - listTop + (Number(scrollTop) || 0) - 1;
    return Number.isFinite(y) ? Math.max(0, Math.round(y)) : 0;
}

export function mount(el, ctx) {
    // 布局由 styles/panels.css 的 .lyr* 规则承担，这里不写内联样式
    const root = document.createElement('div');
    root.className = 'lyr';

    // ── 工具条：6 个对象动作全部常显（纯图标，title + aria-label 说明）
    const bar = document.createElement('div');
    bar.className = 'lyr-bar';
    const actBtn = new Map();   // act → 要同步置灰的控件
    for (const [act, iconName, title] of BAR_ACTS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'lyr-btn ms-icon-btn';
        b.innerHTML = icon(iconName);
        b.dataset.act = act;
        b.title = title;
        b.setAttribute('aria-label', title);
        bar.appendChild(b);
        actBtn.set(act, b);
    }

    // ── 当前对象不透明度
    const alphaWrap = document.createElement('div');
    alphaWrap.className = 'lyr-alpha';
    const alpha = document.createElement('input');
    alpha.className = 'lyr-alpha-range';
    alpha.type = 'range';
    alpha.min = '0';
    alpha.max = '100';
    alpha.step = '1';
    alpha.value = '100';
    alpha.title = '当前对象不透明度';
    const alphaVal = document.createElement('span');
    alphaVal.className = 'lyr-alpha-val';
    alphaVal.textContent = '100%';
    alphaWrap.append(alpha, alphaVal);

    // ── 列表与底栏
    const list = document.createElement('div');
    list.className = 'lyr-list';

    // v10：纹理库整块已迁到属性面板的「纹理」组（app/editors/prop-textures.mjs）。
    // 对象面板只回答「谁盖谁」，同一功能不留两个入口。

    const foot = document.createElement('div');
    foot.className = 'lyr-foot';
    const countEl = document.createElement('span');
    countEl.className = 'lyr-count';
    foot.appendChild(countEl);

    root.append(bar, alphaWrap, list, foot);
    el.appendChild(root);

    /* ── L3：列表空白区 = 移到根层末尾（拖到列表下方松手就提起父级） ── */
    function visibleRows() {
        return [...list.querySelectorAll('.lyr-row')].filter((r) => r.style.display !== 'none');
    }

    list.addEventListener('dragover', (e) => {
        if (!dragId) return;
        const rowEl = e.target && e.target.closest ? e.target.closest('.lyr-row') : null;
        if (rowEl) return;   // 行内的落点由行自己处理
        e.preventDefault();
        dropState = { targetId: null, mode: 'rootEnd', ok: true };
        clearDropMarks();
        const last = visibleRows().pop() || null;
        if (last) showDropLine(last, 'after', indentOf(0));
        else {
            dropLine.style.setProperty('--drop-indent', indentOf(0) + 'px');
            dropLine.style.top = '0px';
            dropLine.hidden = false;
        }
        autoScroll(e);
    });

    list.addEventListener('drop', (e) => {
        if (!dragId) return;
        const rowEl = e.target && e.target.closest ? e.target.closest('.lyr-row') : null;
        if (rowEl) return;
        e.preventDefault();
        const from = dragId;
        dragId = null;
        endDropHover();
        if (from) commitDrop(from, { mode: 'rootEnd', targetId: null });
    });

    // layerId → 行内对象引用，避免每次重绘重建 DOM
    const rows = new Map();

    const notify = (msg) => {
        if (typeof ctx.notify === 'function') ctx.notify(msg);
    };

    /* ── L3：拖拽落点状态与视觉 ──
       只在「目标 / 模式」变化时重绘；dragover 每帧都会来，改 class 比重建 DOM 便宜得多。 */
    let dropState = { targetId: null, mode: null, ok: false };

    const dropLine = document.createElement('div');
    dropLine.className = 'lyr-drop-line';
    dropLine.hidden = true;
    list.appendChild(dropLine);

    // L2 空态：一个对象都没有时列表不能只是一片空白（用户会以为面板坏了）
    const emptyEl = document.createElement('div');
    emptyEl.className = 'lyr-empty';
    emptyEl.hidden = true;
    emptyEl.textContent = '还没有对象。点上方 ＋ 新建，或用「导入」放一张图进来。';
    list.appendChild(emptyEl);

    // 超过 6 级不再继续缩进（12px×7 就把名字挤没了），改用行尾的 +N 标记说明还剩几层
    const MAX_VISIBLE_DEPTH = 6;
    const indentOf = (depth) => 6 + Math.min(MAX_VISIBLE_DEPTH, Math.max(0, Number(depth) || 0)) * 12;

    /** 「N 个子对象」：优先用 ctx 现成的子树计数，没有就自己按 parentId 数（不重复造轮子，但要能降级）。 */
    function kidCountOf(all, id) {
        if (typeof ctx.subtreeCount === 'function') return Math.max(0, Number(ctx.subtreeCount(id)) || 0);
        return Math.max(0, subtreeIds(all, id).length - 1);
    }

    function depthOf(id) {
        return typeof ctx.layerDepth === 'function' ? Number(ctx.layerDepth(id)) || 0 : 0;
    }

    function clearDropMarks() {
        for (const rec of rows.values()) {
            rec.row.classList.remove('drop-before', 'drop-after', 'drop-into', 'drop-invalid');
        }
        dropLine.hidden = true;
    }

    function showDropLine(rowEl, where, indent) {
        if (!rowEl) return;
        const r = rowEl.getBoundingClientRect();
        const lr = list.getBoundingClientRect();
        // 列表是滚动容器：rect 是视口坐标，插入线的 top 是内容坐标，必须补 scrollTop
        const y = dropLineTop(r.top, r.bottom, lr.top, list.scrollTop, where);
        dropLine.style.setProperty('--drop-indent', indent + 'px');
        dropLine.style.top = y + 'px';
        dropLine.hidden = false;
    }

    function endDropHover() {
        clearDropMarks();
        dropState = { targetId: null, mode: null, ok: false };
    }

    function hoverRow(targetId, mode) {
        const doc = ctx.doc();
        const all = doc ? objectsOf(doc) : [];
        const v = dropVerdict(all, dragId, targetId, mode);
        dropState = { targetId, mode, ok: v.ok };
        clearDropMarks();
        const rec = rows.get(targetId);
        if (!rec) return;
        if (!v.ok) {
            rec.row.classList.add('drop-invalid');
            return;
        }
        if (mode === 'into') {
            rec.row.classList.add('drop-into');
            return;
        }
        const indent = indentOf(depthOf(targetId));
        rec.row.classList.add(mode === 'before' ? 'drop-before' : 'drop-after');
        showDropLine(rec.row, mode, indent);
    }

    /** 列表上/下边缘 24px 内自动滚动：拖长列表时不必先松手再滚。 */
    function autoScroll(e) {
        const lr = list.getBoundingClientRect();
        const EDGE = 24;
        if (e.clientY < lr.top + EDGE) list.scrollTop -= 10;
        else if (e.clientY > lr.bottom - EDGE) list.scrollTop += 10;
    }

    /** 一次落点 = 一条撤销记录。优先原子接口 `ctx.moveSubtree`（L1 线提供），
        没有时降级成「改父 + 移动」两步 —— 撤销会变两步，但功能不丢。 */
    function commitDrop(fromId, opts) {
        const doc = ctx.doc();
        if (!doc) return;
        const all = objectsOf(doc);
        const v = dropVerdict(all, fromId, opts.targetId, opts.mode);
        if (!v.ok) {
            notify(v.reason);
            return;
        }
        if (typeof ctx.moveSubtree === 'function') {
            if (ctx.moveSubtree(fromId, { mode: opts.mode, targetId: opts.targetId }) === false) notify('移动失败');
            paint();
            return;
        }
        // 降级路径：L1 的 moveSubtree 落地前，撤销会多一步
        const target = opts.targetId == null ? null : all.find((o) => o.id === opts.targetId) || null;
        if (opts.mode === 'rootEnd') {
            if (typeof ctx.setLayerParent === 'function') ctx.setLayerParent(fromId, null);
            if (typeof ctx.moveLayerTo === 'function') ctx.moveLayerTo(fromId, all.length - 1);
        } else if (opts.mode === 'into') {
            if (typeof ctx.setLayerParent === 'function') ctx.setLayerParent(fromId, opts.targetId);
        } else if (target) {
            const parentId = target.parentId == null ? null : target.parentId;
            if (typeof ctx.setLayerParent === 'function') ctx.setLayerParent(fromId, parentId);
            const ti = all.findIndex((o) => o.id === opts.targetId);
            if (ti >= 0 && typeof ctx.moveLayerTo === 'function') {
                ctx.moveLayerTo(fromId, opts.mode === 'before' ? ti : ti + 1);
            }
        }
        paint();
    }

    // 当前对象：activeLayerId 可能指向已删除的对象，回落到最上层
    function activeId(doc) {
        const all = objectsOf(doc);
        const id = typeof ctx.activeLayerId === 'function' ? ctx.activeLayerId() : null;
        if (id && all.some((l) => l.id === id)) return id;
        return all.length ? all[0].id : null;
    }

    // 选中对象（可能是 null：点空白取消选中，但当前操作对象不变）
    function selectedId(doc) {
        const sel = typeof ctx.selection === 'function' ? ctx.selection() : null;
        const id = sel && sel.id ? sel.id : null;
        return id && objectsOf(doc).some((l) => l.id === id) ? id : null;
    }

    // 唯一时间源：ctx.time()（连续秒）。缩略图与「生效纹理」都按这个时间取。
    function nowTime() {
        const fn = typeof ctx.time === 'function' ? ctx.time : null;
        const v = fn ? Number(fn()) : 0;
        return Number.isFinite(v) ? v : 0;
    }

    function makeRow(layer) {
        const row = document.createElement('div');
        row.className = 'lyr-row';
        row.dataset.id = layer.id;

        // v10：扁平「叠放」列表没有子层级，折叠箭头随折叠体系一起下线。
        const vis = document.createElement('button');
        vis.type = 'button';
        vis.className = 'lyr-vis ms-icon-btn';
        vis.title = '显示 / 隐藏';
        vis.innerHTML = icon('eye');
        vis.dataset.icon = 'eye';

        const meta = document.createElement('div');
        meta.className = 'lyr-meta';
        const name = document.createElement('div');
        name.className = 'lyr-name';
        name.title = '双击重命名';
        const sub = document.createElement('div');
        sub.className = 'lyr-sub';
        meta.append(name, sub);

        // v5：时间通道徽章。恒等时置灰，点开可改 offset / 倍率 / 循环 / 冻结。
        // 徽章是 24×24 热区（视觉是 14px 淡色图标），点击目标不受图标尺寸影响。
        const timeBadge = document.createElement('button');
        timeBadge.type = 'button';
        timeBadge.className = 'lyr-time is-off ms-icon-btn';
        timeBadge.innerHTML = icon('timer');
        timeBadge.title = '时间通道（偏移 / 倍率 / 循环 / 冻结）';
        timeBadge.setAttribute('aria-label', timeBadge.title);
        timeBadge.addEventListener('pointerdown', (e) => e.stopPropagation());
        timeBadge.addEventListener('click', (e) => {
            e.stopPropagation();
            openTimePopover(layer.id, timeBadge);
        });

        // L2：有子对象的行尾一颗「N 个子对象」胶囊。10px + tabular-nums，
        // 它是「这行下面还压着多少东西」的提示，不该抢名字的宽度。
        const kids = document.createElement('span');
        kids.className = 'lyr-kids';
        kids.hidden = true;

        // L3：三区拖拽 —— 上缘 25% 插到该行前 / 中间 50% 投进去当子对象 / 下缘 25% 插到该行后。
        // 不再用「左 45% 调顺序、右 55% 当子对象」那种靠猜的分区。
        row.draggable = true;
        row.addEventListener('dragstart', (e) => {
            dragId = layer.id;
            row.classList.add('is-dragging');
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
                try {
                    e.dataTransfer.setData('text/plain', layer.id);
                } catch (err) {
                    /* setData 受限时忽略，dragId 已够 */
                }
                // 不要原生幽灵图：它会盖住插入线，也会挡住「投进哪一行」的判断
                try {
                    const ghost = document.createElement('canvas');
                    ghost.width = 1;
                    ghost.height = 1;
                    e.dataTransfer.setDragImage(ghost, 0, 0);
                } catch (err) {
                    /* 个别环境不支持 setDragImage，忽略 */
                }
            }
        });
        row.addEventListener('dragend', () => {
            dragId = null;
            row.classList.remove('is-dragging');
            endDropHover();
        });
        row.addEventListener('dragover', (e) => {
            if (!dragId || dragId === layer.id) return;
            e.preventDefault();
            const r = row.getBoundingClientRect();
            const ratio = r.height > 0 ? (e.clientY - r.top) / r.height : 0.5;
            hoverRow(layer.id, dropZone(ratio));
            autoScroll(e);
        });
        row.addEventListener('dragleave', (e) => {
            // 进入行内子元素也会触发 dragleave，只有真离开这一行才清
            const to = e.relatedTarget;
            if (to && row.contains(to)) return;
            if (dropState.targetId === layer.id) endDropHover();
        });
        row.addEventListener('drop', (e) => {
            e.preventDefault();
            const from = dragId;
            const mode = dropState.mode;
            const targetId = dropState.targetId;
            dragId = null;
            row.classList.remove('is-dragging');
            endDropHover();
            if (!from || from === layer.id || !mode) return;
            commitDrop(from, { mode, targetId });
        });

        row.append(vis, meta, kids, timeBadge);
        return { row, vis, name, sub, timeBadge, kids };
    }

    // ── 时间通道浮层（v5）
    const TIME_EASE_TEXT = [['linear', '匀速'], ['in', '渐快'], ['out', '渐慢'], ['inout', '缓入缓出']];
const TIME_MODE_TEXT = [
        ['none', '无'],
        ['loop', '循环'],
        ['pingpong', '往返'],
        ['clamp', '夹取'],
    ];

    function ensurePopover() {
        if (popover) return popover;
        popover = document.createElement('div');
        popover.className = 'lyr-tp';
        popover.hidden = true;
        popover.addEventListener('pointerdown', (e) => e.stopPropagation());
        document.body.appendChild(popover);
        document.addEventListener(
            'pointerdown',
            (e) => {
                if (!popover || popover.hidden) return;
                if (popover.contains(e.target)) return;
                popover.hidden = true;
            },
            true
        );
        return popover;
    }

    function rowOf(control, text) {
        const line = document.createElement('div');
        line.className = 'lyr-tp-row';
        const label = document.createElement('span');
        label.className = 'lyr-tp-label';
        label.textContent = text;
        line.appendChild(label);
        if (control) line.appendChild(control);
        return line;
    }

    function numField(value, min, max, step, onChange) {
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.className = 'lyr-tp-num';
        inp.min = String(min);
        inp.max = String(max);
        inp.step = String(step);
        inp.value = String(value);
        inp.addEventListener('change', () => {
            const v = Number(inp.value);
            if (!Number.isFinite(v)) return;
            onChange(Math.max(min, Math.min(max, v)));
        });
        inp.addEventListener('pointerdown', (e) => e.stopPropagation());
        return inp;
    }

    function openTimePopover(id, anchor) {
        const host = ensurePopover();
        const cur = typeof ctx.layerTime === 'function' ? ctx.layerTime(id) : null;
        const t = cur || { offset: 0, scale: 1, mode: 'none', from: 0, to: 0, hold: false, holdAt: 0, ease: 'linear' };
        const set = (patch) => {
            if (typeof ctx.setLayerTime === 'function') ctx.setLayerTime(id, patch);
        };
        host.textContent = '';
        const title = document.createElement('div');
        title.className = 'lyr-tp-title';
        const layer = objectsOf(ctx.doc()).find((l) => l.id === id);
        title.textContent = (layer ? layer.name : '对象') + ' · 时间通道';
        host.appendChild(title);

        host.appendChild(rowOf(numField(t.offset, -9999, 9999, 0.05, (v) => set({ offset: v })), '偏移 s'));
        host.appendChild(rowOf(numField(t.scale, -100, 100, 0.1, (v) => set({ scale: v })), '倍率 ×'));
        host.appendChild(rowOf(numField(t.from, 0, 9999, 0.05, (v) => set({ from: v })), '区间起 s'));
        host.appendChild(rowOf(numField(t.to, 0, 9999, 0.05, (v) => set({ to: v })), '区间止 s'));

        const modeWrap = document.createElement('div');
        modeWrap.className = 'lyr-tp-modes';
        for (const [val, text] of TIME_MODE_TEXT) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'lyr-tp-mode' + (t.mode === val ? ' is-on' : '');
            b.textContent = text;
            b.addEventListener('click', () => {
                set({ mode: val });
                for (const other of modeWrap.children) other.classList.toggle('is-on', other === b);
            });
            modeWrap.appendChild(b);
        }
        host.appendChild(rowOf(modeWrap, '模式'));

        // retime 缓动：让时间流速本身非线性（只在单调模式下生效，loop/pingpong 会忽略）
        const easeWrap = document.createElement('div');
        easeWrap.className = 'lyr-tp-modes';
        for (const [val, text] of TIME_EASE_TEXT) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'lyr-tp-mode' + ((t.ease || 'linear') === val ? ' is-on' : '');
            b.textContent = text;
            b.title = val === 'linear' ? '时间匀速前进' : '时间流速按曲线变化（loop / pingpong 下不生效）';
            b.addEventListener('click', () => {
                set({ ease: val });
                for (const other of easeWrap.children) other.classList.toggle('is-on', other === b);
            });
            easeWrap.appendChild(b);
        }
        host.appendChild(rowOf(easeWrap, '缓动'));

        const holdBtn = document.createElement('button');
        holdBtn.type = 'button';
        holdBtn.className = 'lyr-tp-hold' + (t.hold ? ' is-on' : '');
        holdBtn.textContent = t.hold ? '已冻结' : '冻结在此刻';
        holdBtn.addEventListener('click', () => {
            if (t.hold) set({ hold: false });
            else set({ hold: true, holdAt: typeof ctx.time === 'function' ? ctx.time() : 0 });
            openTimePopover(id, anchor);
        });
        host.appendChild(rowOf(holdBtn, '冻结'));

        const foot = document.createElement('div');
        foot.className = 'lyr-tp-foot';
        const reset = document.createElement('button');
        reset.type = 'button';
        reset.className = 'lyr-tp-reset';
        reset.textContent = '恢复恒等';
        reset.addEventListener('click', () => {
            set({ offset: 0, scale: 1, mode: 'none', from: 0, to: 0, hold: false, holdAt: 0, ease: 'linear' });
            host.hidden = true;
        });
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'lyr-tp-reset';
        close.textContent = '关闭';
        close.addEventListener('click', () => {
            host.hidden = true;
        });
        foot.append(reset, close);
        host.appendChild(foot);

        host.hidden = false;
        const r = anchor.getBoundingClientRect();
        const w = host.offsetWidth || 250;
        const h = host.offsetHeight || 220;
        let left = r.right + 6;
        if (left + w > window.innerWidth - 8) left = Math.max(8, r.left - w - 6);
        let top = r.top;
        if (top + h > window.innerHeight - 8) top = Math.max(8, window.innerHeight - h - 8);
        host.style.left = Math.round(left) + 'px';
        host.style.top = Math.round(top) + 'px';
    }


    function kindLabel(layer) {
        return KIND_TEXT[layer && layer.kind] || KIND_TEXT.paint;
    }

    function keyCount(layer) {
        const track = layer && layer.transform;
        return track && Array.isArray(track.keys) ? track.keys.length : 0;
    }

    function syncRows(doc, active, sel, t) {
        const seen = new Set();
        let prev = null;
        const all = objectsOf(doc);
        // 扁平化（docs/层级与叠放-2026-10.md §5）：叠放面板只回答「谁盖谁」，
        // 顺序直接取 drawOrder（[0] = 最上层），与画布绘制顺序同源；
        // 层级缩进与父子排序归「父子」面板（tree.mjs 走 core/hierarchy 的 treeOrder）。
        const order = typeof ctx.drawOrder === 'function' ? ctx.drawOrder() : [];
        const byId = new Map(all.map((o) => [o && o.id, o]));
        const flat = order.length ? order.map((id) => byId.get(id)).filter(Boolean) : all.slice();
        flat.forEach((layer) => {
            let rec = rows.get(layer.id);
            if (!rec) {
                rec = makeRow(layer);
                rows.set(layer.id, rec);
            }
            seen.add(layer.id);

            // 顺序即显示顺序：layers[0] 在最上面
            const want = prev ? prev.nextSibling : list.firstChild;
            if (want !== rec.row) list.insertBefore(rec.row, want);
            prev = rec.row;

            const cel = celAt(layer, t);

            rec.row.classList.toggle('is-active', layer.id === active);
            rec.row.classList.toggle('is-sel', layer.id === sel);
            rec.row.classList.toggle('is-hold', !!(cel && cel.hold && !cel.image));
            rec.row.classList.toggle('is-linked', !!(cel && cel.group));
            rec.vis.classList.toggle('is-off', !layer.visible);
            rec.vis.title = layer.visible ? '隐藏「' + layer.name + '」' : '显示「' + layer.name + '」';
            rec.vis.setAttribute('aria-label', rec.vis.title);
            // 眼睛图标跟随可见性：可见 = eye，隐藏 = eye-off。同样只在切换时重建。
            const wantEye = layer.visible ? 'eye' : 'eye-off';
            if (rec.vis.dataset.icon !== wantEye) {
                rec.vis.dataset.icon = wantEye;
                rec.vis.innerHTML = icon(wantEye);
            }
            if (rec.name.textContent !== layer.name) rec.name.textContent = layer.name;
            // 副标题：种类 + 库内纹理张数 + 关键帧数。
            // 这里必须短：.lyr-sub 的宽度预算实测只有 134px（11px 字号 ≈ 12 个汉字），
            // 原先「0 纹理 · 1 曝露 · 1 关键帧」写完 141px 会被 CSS 截成「1 关…」，
            // 用户看到的是半截词。曝光处数不是「几个时刻在用它」，完整版放进 row.title。
            const libCount = textureCount(layer);
            const expoCount = celTimes(layer).length;
            let sub = kindLabel(layer) + ' · ' + libCount + ' 纹理 · ' + keyCount(layer) + ' 键';
    // 对象自己带分辨率：只有和文档画布不一样时才标出来，否则每行都挂一遍 900×640 是噪音
    const osz = objectSize(layer);
    if (osz && doc && (osz.w !== doc.width || osz.h !== doc.height)) sub += ' · ' + osz.w + '×' + osz.h;
            if (cel && cel.group != null) sub += ' · 链接';
            if (rec.sub.textContent !== sub) rec.sub.textContent = sub;
            const pct = Math.round((layer.opacity == null ? 1 : layer.opacity) * 100);
            const tip = layer.name + ' · 不透明度 ' + pct + '% · ' + sub + ' · 曝光 ' + expoCount + ' 处';
            if (rec.row.title !== tip) rec.row.title = tip;

            // 叠放列表是纯扁平的（docs/层级与叠放-2026-10.md §5）：
            // 层级与缩进归「父子」面板（tree.mjs），这里只回答「谁盖谁」，所以不再算 depth 缩进。
            rec.row.classList.remove('is-child');
            if (rec.row.style.paddingLeft) rec.row.style.paddingLeft = '';
            if (rec.row.style.getPropertyValue('--guide-w')) rec.row.style.removeProperty('--guide-w');
            if (rec.row.dataset.deep) delete rec.row.dataset.deep;
            // 行尾角标改成「N 纹」：叠放面板该说的是「这个对象有几张纹理」；
            // 子对象数属于父子树（那边有自己的「N 个子对象」胶囊），两个面板各说各的。
            const texCount = textureCount(layer);
            rec.kids.hidden = false;
            const ktxt = texCount + ' 纹';
            if (rec.kids.textContent !== ktxt) rec.kids.textContent = ktxt;
            const ktip = '共 ' + texCount + ' 张纹理（这个角标不表示子对象数，子对象看「父子」面板）';
            if (rec.kids.title !== ktip) rec.kids.title = ktip;
            const ident = typeof ctx.isLayerTimeIdentity === 'function' ? ctx.isLayerTimeIdentity(layer.id) : true;
            rec.timeBadge.classList.toggle('is-off', ident);
            const timeTip =
                (typeof ctx.describeLayerTime === 'function' ? ctx.describeLayerTime(layer.id) : '无时间变换') +
                '（点击编辑）';
            if (rec.timeBadge.title !== timeTip) rec.timeBadge.title = timeTip;
        });

        // 清理已删除的对象行
        for (const [id, rec] of rows) {
            if (seen.has(id)) continue;
            rec.row.remove();
            rows.delete(id);
        }

        // L2 空态：没有对象时列表不能只剩一片空白
        if (emptyEl) emptyEl.hidden = all.length > 0;
    }

    // 不可用动作只做视觉置灰，但仍可点击：让守卫路径向 ctx.notify 报中文提示
    function setOff(btn, off) {
        btn.disabled = false;
        btn.style.opacity = off ? '0.4' : '';
        if (typeof btn.setAttribute === 'function') btn.setAttribute('aria-disabled', off ? 'true' : 'false');
    }

    function syncBar(doc, active) {
        const i = objectsOf(doc).findIndex((l) => l.id === active);
        const last = objectsOf(doc).length - 1;
        setOff(actBtn.get('up'), i <= 0 || i < 0);
        setOff(actBtn.get('down'), i < 0 || i >= last);
        setOff(actBtn.get('merge'), i < 0 || i >= last);
        setOff(actBtn.get('del'), i < 0);
        setOff(actBtn.get('dup'), i < 0);
        countEl.textContent = objectsOf(doc).length + ' 个对象';
    }

    function syncAlpha(doc, active) {
        const layer = objectsOf(doc).find((l) => l.id === active) || null;
        if (!layer) {
            alpha.disabled = true;
            alphaVal.textContent = '—';
            return;
        }
        alpha.disabled = false;
        const pct = Math.round((layer.opacity == null ? 1 : layer.opacity) * 100);
        // 拖动滑块时不回写，避免和用户手势抢值
        if (document.activeElement !== alpha) alpha.value = String(pct);
        alphaVal.textContent = pct + '%';
    }

    // v10：纹理库（纹理库）整块已迁到属性面板的「纹理」组，这里不再维护第二份。
    function paint() {
        const doc = ctx.doc();
        if (!doc) {
            list.textContent = '';
            rows.clear();
            countEl.textContent = '—';
            alpha.disabled = true;
            alphaVal.textContent = '—';
            for (const b of actBtn.values()) b.disabled = true;
            return;
        }
        const active = activeId(doc);
        syncRows(doc, active, selectedId(doc), nowTime());
        syncBar(doc, active);
        syncAlpha(doc, active);
    }

    // ── 工具条 / ⋯ 菜单动作：动作体只有这一份，两个入口都走 runAct
    function runAct(act, doc) {
        const active = activeId(doc);
        if (act === 'add') {
            let newId = null;
            ctx.setDoc((d) => {
                const n = addLayer(d, '对象 ' + (objectsOf(d).length + 1));
                newId = objectsOf(n).length ? objectsOf(n)[0].id : null;
                return n;
            });
            const after = ctx.doc();
            const target = newId || (after && objectsOf(after).length ? objectsOf(after)[0].id : null);
            if (target) {
                ctx.setActiveLayer(target);
                if (typeof ctx.setSelection === 'function') ctx.setSelection({ id: target });
            }
        } else if (act === 'dup') {
            if (!active) return;
            let newId = null;
            ctx.setDoc((d) => {
                const n = duplicateLayer(d, active);
                const i = objectsOf(n).findIndex((l) => l.id === active);
                if (i >= 0 && objectsOf(n)[i - 1]) newId = objectsOf(n)[i - 1].id;
                return n;
            });
            if (newId) ctx.setActiveLayer(newId);
        } else if (act === 'up' || act === 'down') {
            if (!active) return;
            const i = objectsOf(doc).findIndex((l) => l.id === active);
            const to = act === 'up' ? i - 1 : i + 1;
            if (to < 0 || to >= objectsOf(doc).length) return;
            ctx.setDoc((d) => moveLayer(d, active, to));
        } else if (act === 'merge') {
            if (!active) return;
            const i = objectsOf(doc).findIndex((l) => l.id === active);
            const lower = i >= 0 ? objectsOf(doc)[i + 1] : null;
            let error = null;
            ctx.setDoc((d) => {
                const res = mergeDown(d, active);
                if (res && res.error) {
                    error = res.error;
                    return d;
                }
                return res && res.doc ? res.doc : d;
            });
            if (error) notify(error);
            else if (lower) ctx.setActiveLayer(lower.id);
        } else if (act === 'del') {
            if (!active) return;
            // v8：不再有「至少保留一个对象」的死胡同 —— 删光就得到一个空文档
            const i = objectsOf(doc).findIndex((l) => l.id === active);
            const name = (objectsOf(doc)[i] || {}).name || '对象';
            ctx.setDoc((d) => removeLayer(d, active), { label: '删除对象' });
            const rest = ctx.doc();
            if (rest && objectsOf(rest).length) {
                const next = objectsOf(rest)[Math.min(Math.max(i, 0), objectsOf(rest).length - 1)];
                if (next) ctx.setActiveLayer(next.id);
            } else if (typeof ctx.setActiveLayer === 'function') {
                ctx.setActiveLayer(null);
            }
            notify('已删除对象「' + name + '」');
        }
    }

    bar.addEventListener('click', (e) => {
        const btn = e.target.closest ? e.target.closest('.lyr-btn') : null;
        if (!btn || btn.disabled) return;
        const doc = ctx.doc();
        if (!doc) return;
        runAct(btn.dataset.act, doc);
        paint();
    });

    // v10：纹理库的动作与行交互整块随库一起搬到属性面板「纹理」组（prop-textures.mjs）。
    // ── 行内交互：选对象 / 切可见性 / 双击改名
    list.addEventListener('click', (e) => {
        const row = e.target.closest ? e.target.closest('.lyr-row') : null;
        if (!row) return;
        const id = row.dataset.id;
        // v10：折叠箭头已随扁平化下线（层级在 tree.mjs），这里不再处理 .lyr-caret。
        const vis = e.target.closest ? e.target.closest('.lyr-vis') : null;
        if (vis) {
            ctx.setDoc((d) => patchLayer(d, id, { visible: !isVisible(d, id) }));
            paint();
            return;
        }
        if (id) {
            // 当前操作对象 + 选中态同时同步（画布叠加层读的是 ctx.selection）
            ctx.setActiveLayer(id);
            if (typeof ctx.setSelection === 'function') ctx.setSelection({ id });
        }
        paint();
    });

    list.addEventListener('dblclick', (e) => {
        const nameEl = e.target.closest ? e.target.closest('.lyr-name') : null;
        const row = nameEl && nameEl.closest('.lyr-row');
        if (!row) return;
        const id = row.dataset.id;
        const doc = ctx.doc();
        if (!doc) return;
        const layer = objectsOf(doc).find((l) => l.id === id);
        if (!layer) return;
        const input = askName(layer);
        if (input == null) return;
        const name = String(input).trim();
        if (!name || name === layer.name) return;
        ctx.setDoc((d) => patchLayer(d, id, { name: name }));
        paint();
    });

    /**
     * 取名：契约要求双击用 window.prompt，但 Electron 渲染进程不实现 prompt（调用即抛错）。
     * 因此先走 prompt，抛错或不可用时退化为行内输入框，保证改名可用。
     */
    function askName(layer) {
        if (typeof window === 'undefined' || !window || typeof window.prompt !== 'function') return null;
        try {
            return window.prompt('对象名称', layer.name);
        } catch (err) {
            const row = rows.get(layer.id);
            if (row) renameInline(row.row, layer);
            return null;
        }
    }

    // 行内改名：Enter / 失焦提交，Esc 取消
    function renameInline(row, layer) {
        const nameEl = row.querySelector ? row.querySelector('.lyr-name') : null;
        if (!nameEl) return;
        const box = document.createElement('input');
        box.className = 'lyr-rename';
        box.value = layer.name;
        let done = false;
        const finish = (commit) => {
            if (done) return;
            done = true;
            const name = commit ? String(box.value == null ? '' : box.value).trim() : '';
            if (name && name !== layer.name) ctx.setDoc((d) => patchLayer(d, layer.id, { name: name }));
            paint();
        };
        box.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                finish(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                finish(false);
            }
            if (typeof e.stopPropagation === 'function') e.stopPropagation();
        });
        box.addEventListener('blur', () => finish(true));
        nameEl.textContent = '';
        nameEl.appendChild(box);
        if (typeof box.focus === 'function') box.focus();
        if (typeof box.select === 'function') box.select();
    }

    function isVisible(doc, id) {
        const l = objectsOf(doc).find((x) => x.id === id);
        return !!(l && l.visible);
    }

    alpha.addEventListener('input', () => {
        const doc = ctx.doc();
        if (!doc) return;
        const active = activeId(doc);
        if (!active) return;
        const v = Math.max(0, Math.min(100, Number(alpha.value) || 0)) / 100;
        ctx.setDoc((d) => patchLayer(d, active, { opacity: v }));
        alphaVal.textContent = Math.round(v * 100) + '%';
    });

    const off = typeof ctx.subscribeDoc === 'function' ? ctx.subscribeDoc(() => paint()) : () => {};

    // 切帧 / 切对象时把当前对象行滚进可视区；重绘交给 refresh，避免重复绘制缩略图
    // 把一个行滚进可视区（对象行与纹理行共用）。
    // 坐标必须按滚动盒自己的内容系算：offsetTop 相对的是最近的定位祖先（这里是 .area-body），
    // 和 box.scrollTop 不是一个参考系，列表一滚就会算飞；rect 相减才是「行在内容里的位置」。
    function scrollRowInto(box, row) {
        if (!box || !row) return;
        const viewH = Number(box.clientHeight) || 0;
        if (!viewH) return;
        const bRect = box.getBoundingClientRect();
        const rRect = row.getBoundingClientRect ? row.getBoundingClientRect() : null;
        const top = rRect
            ? rRect.top - bRect.top + (Number(box.scrollTop) || 0)
            : (Number(row.offsetTop) || 0);
        const h = (rRect && rRect.height) || Number(row.offsetHeight) || 28;
        const st = Number(box.scrollTop) || 0;
        if (top < st) box.scrollTop = top;
        else if (top + h > st + viewH) box.scrollTop = top + h - viewH;
    }

    function focusFrame() {
        const doc = ctx.doc();
        if (!doc) return;
        const rec = rows.get(activeId(doc));
        scrollRowInto(list, rec && rec.row);
    }

    paint();

    return {
        refresh: paint,
        focusFrame,
        destroy() {
            off();
            rows.clear();
            root.remove();
        },
    };
}
