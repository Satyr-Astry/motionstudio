/**
 * 画布编辑器（v2：对象选中 / 手柄 / 变换叠加层）
 *
 * 引擎只有一个显示画布，它的宿主 `div.cv-host` 是模块级全局单例：
 * 换编辑器、拖分隔条、换工作区时都只是把这个 div 搬来搬去，
 * 绝不重建——重建会丢 engine 的 canvas 引用和 zoom / pan 视图状态。
 *
 * 本模块在宿主里额外挂一张 `.cv-gizmo`（pointer-events:none）：
 * 画出选中对象的四边形、8 个缩放手柄、旋转手柄、锚点十字，warp 模式画四角。
 * 交互走宿主上的捕获阶段 pointerdown：
 *   - 工具 = select  ：全程接管（选中 / 拖动对象 / 拖手柄）
 *   - 其它工具       ：只接管「点中手柄」，其余放行给引擎落笔
 *
 * 分工：手柄几何 / 命中 / 拖动数学在 core/gizmo.mjs（纯函数，可 Node 测）；
 * DOM 零件（HUD / 工具条 / 效果菜单 / 宿主搬迁）在 canvas-chrome.mjs；
 * 这里只剩宿主单例、引擎挂载、叠加层绘制、事件绑定。
 */

import { layerById, patchLayer } from '../core/cel.mjs';
import { createTrack, addKey, setKeyState, stateAt } from '../core/transform.mjs';
import {
    elementLattice, handlePoints, elementWorldMatrix, elementSize, applyMatrix, anchorPoint,
} from '../core/element.mjs';
import { BONE_DEFAULTS } from '../core/doc-model.mjs';
import { boneWorldMatrix, skinOf } from '../core/skin.mjs';
import { ikChains, solveIk } from '../core/ik.mjs';
import { WEIGHT_EPS, skinVertices, mainBoneIndex, boneColorOf } from '../core/weight-paint.mjs';
import { HANDLE_NAMES, HANDLE_PX, handlePositions } from '../core/gizmo.mjs';
import { buildChrome } from './canvas-chrome.mjs';
import { createInput } from './canvas-input.mjs';

let activeBarSync = null;

/** 外壳改了选中对象/帧/时间后调用：立刻重画叠加层与浮动工具条（不依赖 rAF） */
export function syncSelectionUI() {
    if (typeof activeBarSync === 'function') {
        try { activeBarSync(); } catch (err) { /* 画布未就绪时忽略 */ }
    }
}

const HOST_CLASS = 'cv-host';
const GIZMO_CLASS = 'cv-gizmo';
const ACCENT = '#4a7dff';

/** 把影响范围圈夹在对象的参数空间里（圈外没有几何可影响） */
function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

let hostEl = null;          // 全局唯一宿主
let attached = false;       // 引擎只 attach 一次，detach 由外壳决定

/** 懒建宿主，避免模块导入时就依赖 document */
function ensureHost() {
    if (hostEl) return hostEl;
    hostEl = document.createElement('div');
    hostEl.className = HOST_CLASS;
    // 引擎按宿主 rect 决定显示画布像素尺寸，必须铺满整块区域
    hostEl.style.position = 'absolute';
    hostEl.style.inset = '0';
    return hostEl;
}

/** 返回全局宿主对象（可能尚未插入 DOM） */
export function canvasHost() {
    return ensureHost();
}

/**
 * 把全局宿主搬进 target。顺序保持「宿主在前、HUD 在后」。
 * @param {HTMLElement} target
 * @returns {HTMLElement} 宿主本身
 */
export function placeCanvas(target) {
    const host = ensureHost();
    if (!target || host.parentNode === target) return host;
    const hud = target.querySelector(':scope > .cv-hud');
    if (hud) target.insertBefore(host, hud);
    else target.appendChild(host);
    return host;
}

/* ─────────────────────────── 关键帧写入 ─────────────────────────── */

function keyIndexAt(trk, t) {
    const keys = trk && trk.keys ? trk.keys : [];
    for (let i = 0; i < keys.length; i++) {
        if (Math.abs(keys[i].t - t) < 1e-4) return i;
    }
    return -1;
}

/**
 * 在时间 t 写一个关键帧：已存在就改值，不存在就先按当前求值补一个再改。
 * 这是 v2 的核心语义——「改任何数值 = 在当前时间打帧」。
 */
export function writeKey(doc, elId, t, patch) {
    const el = layerById(doc, elId);
    if (!el) return doc;
    let trk = el.transform && Array.isArray(el.transform.keys) ? el.transform : createTrack();
    let idx = keyIndexAt(trk, t);
    if (idx < 0) {
        trk = addKey(trk, t, stateAt(trk, t), 'linear');
        idx = keyIndexAt(trk, t);
        if (idx < 0) return doc;
    }
    trk = setKeyState(trk, idx, patch);
    return patchLayer(doc, elId, { transform: trk });
}

/* ─────────────────────────── mount ─────────────────────────── */

/**
 * @param {HTMLElement} el 已带 `area-body ed ed-canvas` 的空容器
 * @param {object} ctx 外壳上下文
 */
export function mount(el, ctx) {
    if (!el) return {};

    const engine = ctx && ctx.engine ? ctx.engine : null;

    // 外壳通常先清空 el；万一没清，移除上一轮残留的 HUD，避免叠成两层
    for (const old of Array.from(el.querySelectorAll(':scope > .cv-hud'))) old.remove();

    const host = placeCanvas(el);

    // 旧 gizmo 从宿主里清掉（同一宿主可能被多次 mount）
    for (const old of Array.from(host.querySelectorAll(':scope > .' + GIZMO_CLASS))) old.remove();

    /* ── 坐标换算：doc 空间 ↔ 宿主 CSS 像素 ── */

    function viewport() {
        const st = (engine && engine.state) || {};
        const zoom = Number.isFinite(st.zoom) && st.zoom > 0 ? st.zoom : 1;
        const panX = Number.isFinite(st.panX) ? st.panX : 0;
        const panY = Number.isFinite(st.panY) ? st.panY : 0;
        return { zoom, panX, panY };
    }

    function toDocPoint(e) {
        const r = host.getBoundingClientRect();
        const v = viewport();
        return {
            x: (e.clientX - r.left - v.panX) / v.zoom,
            y: (e.clientY - r.top - v.panY) / v.zoom,
        };
    }

    function toScreen(p) {
        const v = viewport();
        return { x: v.panX + p.x * v.zoom, y: v.panY + p.y * v.zoom };
    }

    /** 四角投影到屏幕空间（手柄几何交给 core/gizmo） */
    function toScreenQuad(q) {
        return { tl: toScreen(q.tl), tr: toScreen(q.tr), br: toScreen(q.br), bl: toScreen(q.bl) };
    }

    /** 网格顶点映射的返回值是 [x, y] 数组 */
    function toScreenArr(a) {
        return toScreen({ x: a[0], y: a[1] });
    }

    /* ── 手势命中 ── */

    function selectionInfo() {
        const doc = ctx && typeof ctx.doc === 'function' ? ctx.doc() : null;
        if (!doc) return null;
        const sel = typeof ctx.selection === 'function' ? ctx.selection() : null;
        if (!sel || !sel.id) return null;
        const el = layerById(doc, sel.id);
        if (!el) return null;
        // 祖先链矩阵：父对象旋转/缩放后，选框与拖动方向都必须跟着走。
        const parentM = typeof ctx.objectParentMatrix === 'function' ? ctx.objectParentMatrix(sel.id, ctx.time()) : null;
        return { doc, el, sel, time: ctx.time(), parentM };
    }

    /**
     * 画所有骨骼对象的骨架（不只选中的）：骨架是场景结构，必须常显，
     * 否则建完骨骼在画布上什么都看不见。所以这段排在 `selectionInfo()` 判空**之前**。
     *
     * 世界变换 = 父链矩阵（ctx.objectParentMatrix）× 自身 element 矩阵（elementWorldMatrix）。
     * 为什么不走求值器：求值器按「该时刻有纹理」绘制，骨骼没有纹理、它根本不认识骨骼；
     * 而选框与手柄用的就是这条路径（handlePoints / anchorPoint 同一套矩阵），
     * 走同一条路，骨头的根部圆点才能和选框严格对齐。
     *
     * 局部几何按约定：骨头从 (0, width/2) 画到 (len, width/2)，配合 anchor={x:0,y:0.5}
     * 就是「原点在根部中点，旋转围绕根部」。
     */
    function drawBones(g) {
        const doc = ctx && typeof ctx.doc === 'function' ? ctx.doc() : null;
        if (!doc || !Array.isArray(doc.objects)) return;
        const sel = typeof ctx.selection === 'function' ? ctx.selection() : null;
        const selId = sel && sel.id ? String(sel.id) : null;
        // 权重态下的「目标骨」：这一刷会落到它身上，所以它得比其它骨显眼。
        // 与选中态分开画 —— 用户可能选着 A 骨却在刷 B 骨（目标骨由下拉/最近骨决定）。
        const weightBone = typeof ctx.weightBone === 'function' ? ctx.weightBone() : null;
        const time = typeof ctx.time === 'function' ? ctx.time() : 0;
        const z = viewport().zoom;
        for (const el of doc.objects) {
            if (!el || el.kind !== 'bone') continue;
            // 老档或手改过的对象可能缺 bone 字段：兜底成缺省骨头，别整条消失
            const b = el.bone && typeof el.bone === 'object' ? el.bone : {};
            const len = Number.isFinite(b.len) ? b.len : BONE_DEFAULTS.len;
            const width = Number.isFinite(b.width) ? b.width : BONE_DEFAULTS.width;
            const color = typeof b.color === 'string' ? b.color : BONE_DEFAULTS.color;
            const parentM = typeof ctx.objectParentMatrix === 'function' ? ctx.objectParentMatrix(el.id, time) : null;
            // 骨骼没有纹理，尺寸就是骨头的长与宽（不能问 objectSize：它对无位图对象返回 null）
            const m = elementWorldMatrix(el, time, { w: len, h: width }, parentM);
            const root = toScreen(applyMatrix(m, { x: 0, y: width / 2 }));
            const tip = toScreen(applyMatrix(m, { x: len, y: width / 2 }));
            const on = selId === el.id;
            const isTarget = !!weightBone && String(weightBone) === String(el.id);
            // 线宽跟着视图缩放，但两头夹住：缩到很小还得看得见，放到很大别糊成一团
            const lw = Math.max(2, Math.min(48, width * z));
            g.save();
            g.lineCap = 'round';
            // 未选中的骨架退到背景：它是结构提示，不该跟选框、手柄抢注意力
            g.globalAlpha = on || isTarget ? 1 : 0.42;
            // 加粗/加亮的垫层：目标骨用强调色垫一圈且比选中更粗，选中骨按原样
            const boost = isTarget ? 6 : (on ? 3 : 0);
            if (boost > 0) {
                g.strokeStyle = isTarget ? '#ffd479' : ACCENT;
                g.lineWidth = lw + boost;
                g.beginPath();
                g.moveTo(root.x, root.y);
                g.lineTo(tip.x, tip.y);
                g.stroke();
            }
            g.strokeStyle = color;
            g.lineWidth = lw;
            g.beginPath();
            g.moveTo(root.x, root.y);
            g.lineTo(tip.x, tip.y);
            g.stroke();
            // 根部关节：实心圆 + 深色描边（描边色与手柄同一套，叠在任何底色上都分得清）
            g.fillStyle = color;
            g.strokeStyle = '#0d0f12';
            g.lineWidth = 1;
            g.beginPath();
            g.arc(root.x, root.y, Math.max(3, lw * 0.6), 0, Math.PI * 2);
            g.fill();
            g.stroke();
            // 末端小圆点：标出骨头的「尖」，后续接蒙皮时这里就是子骨骼的挂点
            g.beginPath();
            g.arc(tip.x, tip.y, Math.max(2.5, lw * 0.34), 0, Math.PI * 2);
            g.fill();
            g.restore();
        }
    }

    /**
     * IK 叠加层（P3 步 4）：把「链尾骨骼 → 目标对象」这条关系画出来。
     *
     * 为什么需要它：约束存在数据里，肉眼完全看不出来 —— 用户会看到骨头自己动，
     * 却不知道是哪个对象在拽它，也不知道这根骨属不属于某条链。
     *
     * 只在「选中参与解算的骨」或「选中的正是目标对象」时画；其余时候整层不出现，
     * 免得每根带 IK 的骨都在画布上拖一条虚线。
     *
     * 末端位置必须走 boneWorldMatrix(..., sol)：它与求值器、蒙皮是同一张覆盖表，
     * 用 elementWorldMatrix 会画在**未解算**的位置上，连线与骨头对不上。
     */
    function drawIk(g) {
        const doc = ctx && typeof ctx.doc === 'function' ? ctx.doc() : null;
        if (!doc || !Array.isArray(doc.objects)) return;
        const sel = typeof ctx.selection === 'function' ? ctx.selection() : null;
        const selId = sel && sel.id ? String(sel.id) : null;
        if (!selId) return;
        const time = typeof ctx.time === 'function' ? ctx.time() : 0;
        const chains = ikChains(doc);
        if (!chains || !chains.length) return;
        const sol = solveIk(doc, time);
        const IK_LINK = '#7dd3fc';
        for (const chain of chains) {
            const ids = chain.bones.map((b) => b.id);
            if (ids.indexOf(selId) < 0 && selId !== chain.targetId) continue;
            const tipEl = chain.bones[chain.bones.length - 1];
            const tb = tipEl && tipEl.bone && typeof tipEl.bone === 'object' ? tipEl.bone : {};
            const len = Number.isFinite(tb.len) ? tb.len : BONE_DEFAULTS.len;
            const width = Number.isFinite(tb.width) ? tb.width : BONE_DEFAULTS.width;
            const tip = toScreen(applyMatrix(boneWorldMatrix(doc, tipEl, time, sol), { x: len, y: width / 2 }));
            const targetEl = doc.objects.find((o) => o && o.id === chain.targetId);
            if (!targetEl) continue;
            const tParent = typeof ctx.objectParentMatrix === 'function' ? ctx.objectParentMatrix(targetEl.id, time) : null;
            const tSize = elementSize(doc, targetEl, time);
            const tm = elementWorldMatrix(targetEl, time, tSize, tParent);
            const tp = toScreen(applyMatrix(tm, anchorPoint(targetEl, tSize)));

            g.save();
            g.setLineDash([6, 5]);
            g.strokeStyle = IK_LINK;
            g.lineWidth = 1.5;
            g.beginPath();
            g.moveTo(tip.x, tip.y);
            g.lineTo(tp.x, tp.y);
            g.stroke();
            // 目标点：空心圆 + 十字。压在别的骨头上时，光一个圆会被误认成末端关节
            g.setLineDash([]);
            g.beginPath();
            g.arc(tp.x, tp.y, 6, 0, Math.PI * 2);
            g.stroke();
            g.beginPath();
            g.moveTo(tp.x - 9, tp.y);
            g.lineTo(tp.x + 9, tp.y);
            g.moveTo(tp.x, tp.y - 9);
            g.lineTo(tp.x, tp.y + 9);
            g.stroke();
            g.restore();
        }
    }

    /**
     * 权重叠加层（P2-C 步 1）：把蒙皮网格的顶点画在**形变之后**的位置上。
     *
     * 位置一律来自 core/weight-paint 的 skinVertices（applySkin 同密度分支）。
     * 不能用 elementLattice：它只读 st.warp、看不见蒙皮偏移，顶点会停在绑定姿势，
     * 与用户看到的画面错开一截 —— 眼睛在 A 点、鼠标得去 B 点，这种 bug 极难自查。
     *
     * 只画「正在编辑的那个对象」（ctx.weightLayerId）：用户为换目标骨会去点骨骼，
     * 那一刻选区变成骨骼，靠选区找对象的话顶点会当场消失。
     */
    function drawSkinWeights(g) {
        if (typeof ctx.weightMode !== 'function' || !ctx.weightMode()) return;
        const doc = ctx && typeof ctx.doc === 'function' ? ctx.doc() : null;
        const layerId = typeof ctx.weightLayerId === 'function' ? ctx.weightLayerId() : null;
        const el = doc && layerId ? layerById(doc, layerId) : null;
        const skin = el ? skinOf(el) : null;
        if (!el || !skin) return;
        const time = typeof ctx.time === 'function' ? ctx.time() : 0;
        const parentM = typeof ctx.objectParentMatrix === 'function' ? ctx.objectParentMatrix(el.id, time) : null;
        const verts = skinVertices(doc, el, time, parentM);
        if (!verts) return;
        const selVertex = typeof ctx.weightVertex === 'function' ? ctx.weightVertex() : null;
        const { cols, rows } = verts;
        g.save();
        g.setLineDash([]);
        // 网格线自己按 map 采样。禁用 latticeWireframe：它返回的是「已含偏移的局部像素」，
        // 再套一次 map 就等于偏移加了两遍。
        g.strokeStyle = 'rgba(125,143,168,0.55)';
        g.lineWidth = 1;
        g.beginPath();
        for (let r = 0; r <= rows; r++) {
            for (let c = 0; c <= cols; c++) {
                const s = toScreen(verts.map(cols ? c / cols : 0, rows ? r / rows : 0));
                if (c === 0) g.moveTo(s.x, s.y);
                else g.lineTo(s.x, s.y);
            }
        }
        for (let c = 0; c <= cols; c++) {
            for (let r = 0; r <= rows; r++) {
                const s = toScreen(verts.map(cols ? c / cols : 0, rows ? r / rows : 0));
                if (r === 0) g.moveTo(s.x, s.y);
                else g.lineTo(s.x, s.y);
            }
        }
        g.stroke();
        // 顶点：填充色 = 该顶点**主骨**的颜色（一眼看出这块皮归哪根骨）；
        // 主权重低就压暗（globalAlpha 随 mainW 抬升），因为「这块只有一点点属于它」；
        // 当前选中用 #ffd479（与 warp 顶点同一套强调色）；
        // Σw≈0 的点不受任何骨影响，用警示色画空心方框（填充会让人以为它有重量）
        for (let i = 0; i < verts.pts.length; i++) {
            const s = toScreen(verts.pts[i]);
            const dead = !(verts.sums[i] > WEIGHT_EPS);
            const picked = i === selVertex;
            g.beginPath();
            g.rect(s.x - HANDLE_PX, s.y - HANDLE_PX, HANDLE_PX * 2, HANDLE_PX * 2);
            if (dead) {
                g.strokeStyle = picked ? '#ffd479' : '#ff6b6b';
                g.lineWidth = 1.5;
                g.stroke();
            } else {
                const slot = skin.pts && skin.pts[i] ? skin.pts[i] : [];
                const mainIdx = mainBoneIndex(slot);
                let mainW = 0;
                for (const it of slot) {
                    if (it && it.b === mainIdx && Number.isFinite(it.w)) { mainW = it.w; break; }
                }
                // 先前的版本一律用 BONE_DEFAULTS.color，所有顶点一个色，
                // 「这块皮归哪根骨」只能靠点开面板逐个读 —— 涂权重时几乎没法自查。
                g.globalAlpha = 0.45 + 0.55 * (mainW > 0 ? Math.min(1, mainW) : 0);
                g.fillStyle = picked ? '#ffd479' : boneColorOf(doc, skin, mainIdx);
                g.strokeStyle = '#0d0f12';
                g.lineWidth = 1;
                g.fill();
                g.stroke();
                g.globalAlpha = 1;
            }
        }

        // 笔刷圈：与软拖预览同构 —— 参数空间画圆、透 map 投到屏幕，
        // 所以对象有旋转 / 已有蒙皮形变时圈仍贴着真实影响区。
        // 半径语义与 core/weight-paint.brushVertices 用的是同一个（参数空间距离）。
        const brush = typeof input.weightBrush === 'function' ? input.weightBrush() : null;
        if (brush && brush.elId === el.id && brush.radius > 0) {
            const STEPS = 64;
            g.save();
            g.strokeStyle = 'rgba(74,125,255,0.85)';
            g.fillStyle = 'rgba(74,125,255,0.10)';
            g.lineWidth = 1.5;
            g.setLineDash([]);
            g.beginPath();
            for (let i = 0; i <= STEPS; i++) {
                const a = (i / STEPS) * Math.PI * 2;
                // 夹到 [0,1]：圈外的参数空间没有几何可影响，画到对象外面只会误导
                const su = clamp01(brush.u + Math.cos(a) * brush.radius);
                const sv = clamp01(brush.v + Math.sin(a) * brush.radius);
                const s = toScreen(verts.map(su, sv));
                if (i === 0) g.moveTo(s.x, s.y);
                else g.lineTo(s.x, s.y);
            }
            g.closePath();
            g.fill();
            g.stroke();
            g.restore();
        }
        g.restore();
    }

    /* ── 指针交互：命中判定 + 拖动生命周期（纯数学在 core/gizmo.mjs，
       事件节流与关键帧写入在 canvas-input.mjs） ── */

    const input = createInput({
        host, ctx, engine, toDocPoint, toScreen, toScreenQuad, selectionInfo, writeKey,
    });

    /* ── DOM 零件（HUD / 工具条 / 效果菜单） ──
       必须在 engine.attach 之前建好：DOM 顺序决定叠放次序（宿主里
       引擎显示画布排在这些零件之后，零件靠 CSS z-index 浮在上面）。 */

    const chrome = buildChrome({
        el, host, engine, ctx, gizmoClass: GIZMO_CLASS,
        toScreen, selectionInfo, placeCanvas,
    });
    const { gizmo, syncZoom, ensureVisibleHost } = chrome;

    host.addEventListener('pointerdown', input.onDown, true);
    // 笔刷圈要跟手：hover 只更新状态（不排渲染），重画交给 gizmo 的每帧 rAF。
    host.addEventListener('pointermove', input.onHover);
    host.addEventListener('pointerleave', input.onHoverEnd);

    /* ── 引擎挂载 ── */

    if (engine && !attached && typeof engine.attach === 'function') {
        try {
            const view = engine.attach(host) || (typeof engine.view === 'function' ? engine.view() : null);
            attached = true;
            if (view && view.style) {
                view.style.display = 'block';
                view.style.width = '100%';
                view.style.height = '100%';
            }
        } catch (err) {
            // 即使 attach 中途失败，视图对象可能已经建好并挂进宿主；
            // 这里标记已挂，避免下一轮再 attach 造出第二张画布
            attached = true;
            console.warn('[canvas] 引擎挂载异常：', err);
        }
    }

    /** 视图尺寸/缩放没跟随宿主时校正一次（只在初始视图状态下做，不打断用户缩放）。 */
    function syncViewOnce() {
        if (!engine || typeof engine.fitView !== 'function') return;
        const st = engine.state || {};
        const view = typeof engine.view === 'function' ? engine.view() : null;
        if (!view) return;
        const hr = host.getBoundingClientRect();
        if (hr.width < 8 || hr.height < 8) return;
        const pristine = (st.zoom === 1 && !st.panX && !st.panY) || view.width <= 2;
        const stale = Math.abs(view.width - Math.round(hr.width * (window.devicePixelRatio || 1))) > 4;
        if (pristine || stale) {
            try {
                engine.fitView();
                // 直接同步渲染一次：rAF 链路在某些时序下会被跳过（例如窗口后台化），
                // 视图尺寸就不会跟随宿主，这里是唯一能保证首屏出图的路径
                if (typeof engine.render === 'function') engine.render();
            } catch (err) {
                /* 布局尚未生效时忽略 */
            }
        }
    }

    /* ── 叠加层绘制 ── */

    function resizeGizmo() {
        const r = host.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(r.width * dpr));
        const h = Math.max(1, Math.round(r.height * dpr));
        if (gizmo.width !== w || gizmo.height !== h) {
            gizmo.width = w;
            gizmo.height = h;
        }
        return dpr;
    }

    function drawGizmo() {
    // 纹理画布模式（绘图工作区）：这里画的是这张纹理本身，1:1、无对象变换，
    // 变换手柄在这个语境里没有意义，画出来只会挡视线。
    if (engine && typeof engine.isDrawingBoard === "function" && engine.isDrawingBoard()) {
        const cg = host && host.getContext ? host.getContext("2d") : null;
        if (cg) cg.clearRect(0, 0, host.width, host.height);
        return;
    }
        const dpr = resizeGizmo();
        const g = gizmo.getContext('2d');
        if (!g) return;
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, gizmo.width, gizmo.height);
        g.setTransform(dpr, 0, 0, dpr, 0, 0);

        // 骨架先画：它要常显，所以必须在 selectionInfo() 判空之前（没选中也得有骨架）
        drawBones(g);
        // 权重顶点紧随骨架：同样要常显（编辑权重时选区可能落在骨骼上），也得在判空之前
        drawSkinWeights(g);
        // IK 连线画在最后：它只在「选中参与解算的骨或它的目标」时出现，平时不打扰
        drawIk(g);

        const info = selectionInfo();
        if (!info) return;
        const { doc, el, sel, time, parentM } = info;
        const mode = sel.mode === 'warp' ? 'warp' : 'transform';
        const hp = handlePoints(doc, el, time, parentM);
        const pos = handlePositions(toScreenQuad(hp.quad));   // 8 手柄 + 旋转柄的屏幕坐标
        const q = hp.quad;

        // 四边形轮廓
        const pts = [toScreen(q.tl), toScreen(q.tr), toScreen(q.br), toScreen(q.bl)];
        g.save();
        g.strokeStyle = mode === 'warp' ? '#e0a15a' : ACCENT;
        g.lineWidth = 1;
        g.setLineDash([4, 3]);
        g.beginPath();
        g.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y);
        g.closePath();
        g.stroke();
        g.restore();

        // 手柄
        const drawSquare = (pt, fill) => {
            g.fillStyle = fill;
            g.strokeStyle = '#0d0f12';
            g.lineWidth = 1;
            g.beginPath();
            g.rect(pt.x - HANDLE_PX, pt.y - HANDLE_PX, HANDLE_PX * 2, HANDLE_PX * 2);
            g.fill();
            g.stroke();
        };

        if (mode === 'warp') {
            // 网格线：自己按 uv 采样，和顶点走同一个 lat.map —— 保证线与顶点严格重合。
            // 曾经用 latticeWireframe（它返回的是已含偏移的局部像素），又除以 w/h 再 lat.map 一次，
            // 等于偏移了两遍，网格线与顶点就错开了（用户报的「网格点和网格线焦点不对齐」）。
            const lat = elementLattice(doc, el, time, parentM);
            const { cols, rows } = lat.lattice;
            const N = 6; // 每个 cell 再细分 6 段，弯曲时线才跟得上
            g.strokeStyle = 'rgba(224,161,90,0.55)';
            g.lineWidth = 1;
            g.setLineDash([]);
            g.beginPath();
            for (let r = 0; r <= rows; r++) {
                for (let i = 0; i <= cols * N; i++) {
                    const s = toScreenArr(lat.map(i / (cols * N), r / rows));
                    if (i === 0) g.moveTo(s.x, s.y);
                    else g.lineTo(s.x, s.y);
                }
            }
            for (let c = 0; c <= cols; c++) {
                for (let i = 0; i <= rows * N; i++) {
                    const s = toScreenArr(lat.map(c / cols, i / (rows * N)));
                    if (i === 0) g.moveTo(s.x, s.y);
                    else g.lineTo(s.x, s.y);
                }
            }
            g.stroke();

            for (let r = 0; r <= rows; r++) {
                for (let c = 0; c <= cols; c++) {
                    const s = toScreenArr(lat.map(c / cols, r / rows));
                    const isSel = sel.vertex === r * (cols + 1) + c;
                    drawSquare(s, isSel ? '#ffd479' : '#e0a15a');
                }
            }
            // 网格模式下仍然给出整体缩放手柄与旋转柄（细一号、蓝色，与橙色顶点区分）
            for (const name of HANDLE_NAMES) {
                const s = pos[name];
                g.fillStyle = ACCENT;
                g.strokeStyle = '#0d0f12';
                g.lineWidth = 1;
                g.beginPath();
                g.rect(s.x - HANDLE_PX + 1.5, s.y - HANDLE_PX + 1.5, (HANDLE_PX - 1.5) * 2, (HANDLE_PX - 1.5) * 2);
                g.fill();
                g.stroke();
            }

            // 软拖预览：把这次拖动的影响范围画出来（参数空间椭圆 → lat.map → 屏幕）。
            // 走 lat.map 而不是像素矩形，旋转与已有变形都自动跟随。
            const pvSoft = typeof input.previewSoftDrag === 'function' ? input.previewSoftDrag() : null;
            if (pvSoft && pvSoft.elId === el.id) {
                const STEPS = 64;
                g.save();
                g.strokeStyle = 'rgba(255,212,121,0.9)';
                g.lineWidth = 1.5;
                g.setLineDash([5, 4]);
                g.beginPath();
                for (let i = 0; i <= STEPS; i++) {
                    const a = (i / STEPS) * Math.PI * 2;
                    // 夹到 [0,1]：圈外的参数空间没有几何可影响，画到对象外面只会误导
                    const su = clamp01(pvSoft.u + Math.cos(a) * pvSoft.radiusX);
                    const sv = clamp01(pvSoft.v + Math.sin(a) * pvSoft.radiusY);
                    const s = toScreenArr(lat.map(su, sv));
                    if (i === 0) g.moveTo(s.x, s.y);
                    else g.lineTo(s.x, s.y);
                }
                g.stroke();
                g.setLineDash([]);
                // 拖动点：一个小实心圆，告诉用户「鼓包鼓在这里」
                const dot = toScreenArr(lat.map(pvSoft.u, pvSoft.v));
                g.fillStyle = '#ffd479';
                g.beginPath();
                g.arc(dot.x, dot.y, 3, 0, Math.PI * 2);
                g.fill();
                g.restore();
            }
            g.strokeStyle = ACCENT;
            g.lineWidth = 1;
            g.beginPath();
            g.moveTo(pos.top.x, pos.top.y);
            g.lineTo(pos.rotate.x, pos.rotate.y);
            g.stroke();
            g.fillStyle = ACCENT;
            g.beginPath();
            g.arc(pos.rotate.x, pos.rotate.y, HANDLE_PX - 1, 0, Math.PI * 2);
            g.fill();
        } else {
            for (const name of HANDLE_NAMES) drawSquare(pos[name], ACCENT);
            // 旋转手柄
            g.strokeStyle = ACCENT;
            g.lineWidth = 1;
            g.beginPath();
            g.moveTo(pos.top.x, pos.top.y);
            g.lineTo(pos.rotate.x, pos.rotate.y);
            g.stroke();
            g.fillStyle = ACCENT;
            g.beginPath();
            g.arc(pos.rotate.x, pos.rotate.y, HANDLE_PX, 0, Math.PI * 2);
            g.fill();
        }

        // 锚点十字：拖动中读 input 的预览态——那时文档还没写，只是十字跟手。
        // 预览态用虚线画出「即将落点」，松手才真正 setAnchor（见 canvas-input.mjs）。
        const pvAnchor = typeof input.previewAnchor === 'function' ? input.previewAnchor() : null;
        const pv = pvAnchor && pvAnchor.elId === el.id ? pvAnchor : null;
        const anchorLocal = pv
            ? { x: hp.quad.size.w * pv.u, y: hp.quad.size.h * pv.v }
            : anchorPoint(el, hp.quad.size);
        const a = toScreen(applyMatrix(elementWorldMatrix(el, time, hp.quad.size, parentM), anchorLocal));
        g.strokeStyle = '#f0c674';
        g.lineWidth = 1;
        g.setLineDash(pv ? [3, 3] : []);
        g.beginPath();
        g.moveTo(a.x - 6, a.y);
        g.lineTo(a.x + 6, a.y);
        g.moveTo(a.x, a.y - 6);
        g.lineTo(a.x, a.y + 6);
        g.stroke();
        // 中心小圆点：锚点落在角上时与 nw 手柄重叠，靠这个点区分「这次拖的是原点」
        g.setLineDash([]);
        g.fillStyle = pv ? 'rgba(240,198,116,0.75)' : '#f0c674';
        g.beginPath();
        g.arc(a.x, a.y, 2, 0, Math.PI * 2);
        g.fill();
    }

    /* ── 每帧的工作 ── */

    let gizmoRaf = 0;
    let lastGuard = 0;

    /** 一帧的工作：兜底搬宿主、校正视图、重画叠加层 */
    const tickOnce = () => {
        if (!host.isConnected) return;
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (now - lastGuard > 400) {
            lastGuard = now;
            ensureVisibleHost();
            syncViewOnce();
        }
        drawGizmo();
    };

    const gizmoTick = () => {
        gizmoRaf = requestAnimationFrame(gizmoTick);
        tickOnce();
    };
    if (typeof requestAnimationFrame === 'function') gizmoRaf = requestAnimationFrame(gizmoTick);
    // rAF 在后台窗口 / 最小化时会被整段暂停，叠加层与工具条就永远不刷新。
    // 定时器兜底（浏览器会把它节流到 ~1s，但至少事件驱动的刷新不会丢）。
    const gizmoTimer = setInterval(() => {
        if (host.isConnected) tickOnce();
    }, 120);

    // 首屏与布局稳定后各校正一次视图
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => syncViewOnce());
    setTimeout(() => syncViewOnce(), 320);
    setTimeout(() => syncViewOnce(), 900);

    const refresh = () => {
        if (engine && typeof engine.scheduleRender === 'function') engine.scheduleRender();
        else if (ctx && typeof ctx.requestRender === 'function') ctx.requestRender();
        syncZoom();
        // 外壳每次 render / setSelection 都会调 refresh，叠加层就地更新，
        // 不依赖 rAF（后台窗口会被暂停）
        try { drawGizmo(); } catch (err) { /* 画布未就绪时忽略 */ }
    };

    const destroy = () => {
        chrome.disposeHud();
        host.removeEventListener('pointerdown', input.onDown, true);
        host.removeEventListener('pointermove', input.onHover);
        host.removeEventListener('pointerleave', input.onHoverEnd);
        input.dispose();
        if (gizmoRaf) cancelAnimationFrame(gizmoRaf);
        gizmoRaf = 0;
        clearInterval(gizmoTimer);
        activeBarSync = null;
        // 刻意不 detach 引擎、不删宿主：画布是全局单例，换面板只搬不建
    };

    refresh();
    activeBarSync = () => { drawGizmo(); };
    return { destroy, refresh, focusFrame: refresh };
}
