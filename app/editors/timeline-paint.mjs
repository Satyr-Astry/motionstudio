// 时间轴的「画」：把 DOM 建出来、把最新状态写进 style。
// 这里不碰文档、不绑业务事件（段帧率条的内联输入框例外：它只是编辑器 UI，
// 真正写文档的 commit 由主文件注入）。
//
// 结构：
//   .tline
//     .tline-tools   播放 / 上一画格 / 下一画格 / 加画格 / 删画格 / − 缩放 + / 倍率 / 总时长
//     .tline-ruler   秒刻度尺 + .tline-fpslane 段帧率条 + 播放头
//     .tline-rows    每个对象一行
//       .tline-row
//         .tline-label   对象名（sticky 96px）
//         .tline-lane
//           （画格块已移除：画格挂在关键帧上，换图看 .tline-kf.has-drawing）
//           .tline-kf[data-layer][data-t]   关键帧菱形
//
// 几何（left/top/width/height）一律内联写入，CSS 只负责颜色与手感。

import { docDuration, drawingsOf, drawingIdOf, imageAt, objectById, objectsOf } from '../core/doc-model.mjs';
import {
    CEL_SIZE,
    CEL_TOP,
    CUR_EPS_PX,
    DEFAULT_FPS,
    EASE_TEXT,
    FPS_H,
    KF_SIZE,
    KF_TOP,
    LABEL_W,
    ROW_H,
    RULER_H,
    T_EPS,
    ZOOM_MAX,
    ZOOM_MIN,
    celLeft,
    celMarks,
    currentCelIndex,
    fmt2,
    keyGroups,
    keySummary,
    rulerTicks,
    segmentIndexAtTime,
    timeSegments,
    timeToX,
    trackOf,
} from './timeline-geo.mjs';

/* ─────────────────────────── 外壳 + 工具条 + 刻度尺 + 行区 ─────────────────────────── */

/** 建出静态骨架并返回引用表；rowRefs / segRefs 是随绘制增长的节点缓存。 */
export function createView(el) {
    const root = document.createElement('div');
    root.className = 'tline';

    const tools = document.createElement('div');
    tools.className = 'tline-bar tline-tools';

    /** 工具条分组：分隔线由 .tline-grp 的 border-left 提供，不靠 margin 堆。 */
    let lastZone = null;
    const grp = (name, zone) => {
        const g = document.createElement('div');
        g.className = 'tline-grp';
        g.dataset.grp = name;
        if (zone) {
            g.dataset.zone = zone;
            // 只在「段的起点」打标记：分隔线与 8px 间距由 panels.css 末尾的 v8 块负责
            if (lastZone !== null && zone !== lastZone) g.dataset.zoneStart = '1';
            lastZone = zone;
        }
        tools.appendChild(g);
        return g;
    };

    const mkBtn = (host, act, text, title) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tline-btn';
        b.dataset.act = act;
        if (host && host.dataset && host.dataset.grp) b.dataset.grp = host.dataset.grp;
        b.textContent = text;
        b.title = title;
        host.appendChild(b);
        return b;
    };

    /* ── 1. 播放控制（v8：从顶栏搬进来的，时间轴才是它的老家） ──
       ⏮ ‹ ▶ › ⏭ 是行业通用字形；中文字号在 22px 按钮里会挤，标题写中文。 */
    const gTr = grp('transport', 'transport');
    const first = mkBtn(gTr, 'first', '⏮', '回到开头（Home）');
    const prev = mkBtn(gTr, 'prev', '‹', '上一帧（←）');
    const play = mkBtn(gTr, 'play', '▶', '播放 / 暂停（空格）');
    const next = mkBtn(gTr, 'next', '›', '下一帧（→）');
    const last = mkBtn(gTr, 'last', '⏭', '跳到结尾（End）');

    /* ── 2. 时间读数：当前时间与总时长都是可输入的数字 ──
       「总时长调整不直观」的根因就是它原本只是一段只读文字。 */
    // 读数跟着播放控制走（同属 transport 段），这样工具条只切三段：播放 / 编辑 / 缩放
    const gTime = grp('time', 'transport');
    const nowEl = document.createElement('input');
    nowEl.type = 'text';
    nowEl.className = 'tline-now';
    nowEl.inputMode = 'decimal';
    nowEl.spellcheck = false;
    nowEl.title = '当前时间（秒）· 回车跳到该时间';
    nowEl.value = '0.00';
    const sepEl = document.createElement('span');
    sepEl.className = 'tline-sep';
    sepEl.textContent = '/';
    const totalEl = document.createElement('input');
    totalEl.type = 'text';
    totalEl.className = 'tline-total';
    totalEl.inputMode = 'decimal';
    totalEl.spellcheck = false;
    totalEl.title = '总时长（秒）· 回车生效，或在刻度尺上拖右端的方块';
    totalEl.value = '0.00';
    const unitEl = document.createElement('span');
    unitEl.className = 'tline-unit';
    unitEl.textContent = 's';
    gTime.append(nowEl, sepEl, totalEl, unitEl);

    /* ── 3. 画格（从这一刻起换图） ── */
    const gCel = grp('cel', 'edit');
    // 用「格」而不是箭头字符：◀ ▶ 在部分系统字体里缺字形，会渲染成空白
    const prevCel = mkBtn(gCel, 'prevcel', '上一格', '跳到上一个画格点');
    const nextCel = mkBtn(gCel, 'nextcel', '下一格', '跳到下一个画格点');
    const add = mkBtn(gCel, 'addcel', '加曝光', '在播放头处再加一次曝光（复用当前画格，不新建图）');
    const del = mkBtn(gCel, 'delcel', '删画格', '删除当前时间生效的画格');

    /* ── 4. 关键帧 ── */
    const gKey = grp('key', 'edit');
    const addKey = mkBtn(gKey, 'addkey', '◆', '在当前时间打一个变换关键帧（也可双击对应泳道）');
    // 磁铁：拖动关键帧 / 画格 / 时长手柄时吸附到整帧（AE、Aseprite 的默认行为）。
    const snap = mkBtn(gKey, 'snap', '磁铁', '吸附到整帧（拖动时按住 Shift 可临时自由）');
    if (typeof snap.setAttribute === 'function') snap.setAttribute('aria-pressed', 'true');

    /* ── 5. 缩放 ── */
    const gZoom = grp('zoom', 'zoom');
    const zoomOut = mkBtn(gZoom, 'zoomout', '−', '横向缩小（Ctrl+滚轮）');
    const zoomIn = mkBtn(gZoom, 'zoomin', '＋', '横向放大（Ctrl+滚轮）');

    const zoomEl = document.createElement('span');
    zoomEl.className = 'tline-zoom';
    zoomEl.textContent = '1.0×';
    zoomEl.title = '横向缩放（只影响视图，不影响文档）· 双击复位';
    gZoom.appendChild(zoomEl);

    /* ── 刻度尺 ── */

    const ruler = document.createElement('div');
    ruler.className = 'tline-ruler';
    ruler.style.position = 'relative';
    ruler.style.flex = '0 0 ' + RULER_H + 'px';
    ruler.style.height = RULER_H + 'px';
    ruler.style.overflow = 'hidden';
    ruler.style.userSelect = 'none';

    // 随横向滚动平移的内容层：刻度、段帧率条、播放头都挂它
    const rInner = document.createElement('div');
    rInner.className = 'tline-ruler-inner';
    rInner.style.position = 'absolute';
    rInner.style.left = '0';
    rInner.style.top = '0';
    rInner.style.height = RULER_H + 'px';
    rInner.style.width = '0px';
    rInner.style.transform = 'translateX(' + LABEL_W + 'px)';
    rInner.style.willChange = 'transform';
    ruler.appendChild(rInner);

    const fpsLane = document.createElement('div');
    fpsLane.className = 'tline-fpslane';
    fpsLane.style.position = 'absolute';
    fpsLane.style.left = '0';
    fpsLane.style.top = '0';
    fpsLane.style.height = FPS_H + 'px';
    fpsLane.style.width = '100%';
    fpsLane.style.pointerEvents = 'none';
    rInner.appendChild(fpsLane);

    const rulerPlayhead = document.createElement('div');
    rulerPlayhead.className = 'tline-playhead is-ruler';
    rulerPlayhead.style.position = 'absolute';
    rulerPlayhead.style.top = '0';
    rulerPlayhead.style.left = '0';
    rulerPlayhead.style.width = '1px';
    rulerPlayhead.style.height = RULER_H + 'px';
    rulerPlayhead.style.pointerEvents = 'none';
    rInner.appendChild(rulerPlayhead);

    // 左侧 96px 遮罩：横向滚动时刻度不会跑到对象名列底下
    const rulerPad = document.createElement('div');
    rulerPad.className = 'tline-pad';
    rulerPad.style.position = 'absolute';
    rulerPad.style.left = '0';
    rulerPad.style.top = '0';
    rulerPad.style.width = LABEL_W + 'px';
    rulerPad.style.height = RULER_H + 'px';
    rulerPad.style.zIndex = '2';
    ruler.appendChild(rulerPad);

    /* ── 行区（同时是横向 + 纵向滚动容器） ── */

    const rows = document.createElement('div');
    rows.className = 'tline-rows';
    rows.style.position = 'relative';
    rows.style.display = 'flex';
    rows.style.flexDirection = 'column';
    rows.style.flex = '1 1 auto';
    rows.style.width = 'auto';
    rows.style.minWidth = '0';
    rows.style.minHeight = '0';
    rows.style.overflow = 'auto';

    const rowsPlayhead = document.createElement('div');
    rowsPlayhead.className = 'tline-playhead is-rows';
    rowsPlayhead.style.position = 'absolute';
    rowsPlayhead.style.top = '0';
    rowsPlayhead.style.left = '0';
    rowsPlayhead.style.width = '1px';
    rowsPlayhead.style.height = '0px';
    rowsPlayhead.style.zIndex = '1';
    rowsPlayhead.style.pointerEvents = 'none';
    rows.appendChild(rowsPlayhead);

    root.append(tools, ruler, rows);
    el.appendChild(root);

    return {
        root,
        tools,
        ruler,
        rInner,
        fpsLane,
        rulerPlayhead,
        rulerPad,
        rows,
        rowsPlayhead,
        zoomEl,
        nowEl,
        totalEl,
        // v8 的五组按钮：播放控制 / 时间读数 / 画格 / 关键帧 / 缩放
        btns: {
            first,
            prev,
            play,
            next,
            last,
            prevCel,
            nextCel,
            addCel: add,
            delCel: del,
            addKey,
            snap,
            zoomOut,
            zoomIn,
        },
        rowRefs: [],
        segRefs: [],
    };
}

/** 文档为空：读数归零、整条工具条禁用（这时任何时间操作都没有意义）。 */
export function setEmptyChrome(view, zoomX) {
    if (view.nowEl) view.nowEl.value = '0.00';
    if (view.totalEl) view.totalEl.value = '0.00';
    view.zoomEl.textContent = zoomX.toFixed(1) + '×';
    for (const b of Object.values(view.btns)) {
        if (b && 'disabled' in b) b.disabled = true;
    }
}

/* ─────────────────────────── 图例：画格 vs 关键帧 ─────────────────────────── */

const LEGEND_ROWS = [
    ['is-cel', '■', '画格', '从这一秒起换成这张图，直到下一个画格；格与格之间不插值。'],
    ['is-kf', '◆', '关键帧', '位移 / 缩放 / 旋转 / 不透明度在这里连续插值，与相邻关键帧平滑过渡。'],
];

/**
 * 工具条右侧的「?」图例。点开两行说明，点别处或 Esc 收起。
 *
 * 卡片挂在 document.body 上而不是 .tline 里：.tline 的孩子数量与顺序被
 * tests/timeline.test.mjs 钉死（tools / ruler / rows 三块），图例不能挤进去。
 * 卡片 pointer-events:none —— 它只是说明文字，绝不挡住时间轴上的操作。
 */
export function createLegend() {
    let card = null;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tline-legend';
    btn.textContent = '?';
    btn.title = '画格与关键帧有什么区别（点开看图例）';

    function close() {
        if (card && typeof card.remove === 'function') card.remove();
        card = null;
        btn.classList.toggle('is-on', false); // 用 toggle 而不是 remove：测试里的假 classList 只有 add/contains/toggle
        document.removeEventListener('pointerdown', onOutside, true);
        document.removeEventListener('keydown', onKey, true);
    }

    function onOutside(e) {
        if (e.target === btn || (typeof btn.contains === 'function' && btn.contains(e.target))) return;
        close();
    }

    function onKey(e) {
        if (e.key !== 'Escape') return;
        if (typeof e.preventDefault === 'function') e.preventDefault();
        close();
    }

    function buildCard() {
        const wrap = document.createElement('div');
        wrap.className = 'tline-legend-card';
        wrap.style.position = 'fixed';
        wrap.style.zIndex = '95';
        wrap.style.display = 'flex';
        wrap.style.flexDirection = 'column';
        wrap.style.gap = '6px';
        wrap.style.maxWidth = '330px';
        wrap.style.pointerEvents = 'none';

        for (const [cls, mark, name, text] of LEGEND_ROWS) {
            const line = document.createElement('div');
            line.className = 'tline-legend-row';

            const m = document.createElement('span');
            m.className = 'tline-legend-mark ' + cls;
            m.textContent = mark;

            const n = document.createElement('b');
            n.className = 'tline-legend-name';
            n.textContent = name;

            const t = document.createElement('span');
            t.className = 'tline-legend-text';
            t.textContent = text;

            line.append(m, n, t);
            wrap.appendChild(line);
        }
        return wrap;
    }

    function open() {
        close();
        card = buildCard();
        const host = document.body || document.documentElement;
        host.appendChild(card);

        // 先量后定位：贴着按钮下沿弹出，右侧越界就整体左移
        const r = typeof btn.getBoundingClientRect === 'function' ? btn.getBoundingClientRect() : { left: 0, bottom: 0 };
        const cw = typeof card.getBoundingClientRect === 'function' ? card.getBoundingClientRect().width : 300;
        const vw = Number(window.innerWidth) || 1200;
        card.style.left = Math.max(4, Math.round(Math.min(Number(r.left) - 4, vw - cw - 8))) + 'px';
        card.style.top = Math.round((Number(r.bottom) || 0) + 4) + 'px';

        btn.classList.add('is-on');
        document.addEventListener('pointerdown', onOutside, true);
        document.addEventListener('keydown', onKey, true);
    }

    return {
        el: btn,
        open,
        close,
        toggle: () => (card ? close() : open()),
        isOpen: () => !!card,
    };
}

/* ─────────────────────────── 对象名后面的时间通道徽章 ─────────────────────────── */

/**
 * 给对象名后面挂一个时间通道徽章（v5 行为保留）。
 * 只在该对象「时间被改过」时出现，避免一排全是空徽章。
 */
export function appendTimeBadge(label, obj) {
    const time = obj && obj.time;
    if (!time || typeof time !== 'object') return;
    const scale = Number.isFinite(time.scale) ? time.scale : 1;
    const offset = Number.isFinite(time.offset) ? time.offset : 0;
    const mode = typeof time.mode === 'string' ? time.mode : 'none';
    const hold = time.hold === true;
    if (!hold && scale === 1 && offset === 0 && mode === 'none') return;
    let text = '';
    if (hold) text = '⏸';
    else if (scale !== 1) text = '×' + Math.round(scale * 1000) / 1000;
    else if (mode === 'loop') text = '↻';
    else if (mode === 'pingpong') text = '⇄';
    else if (mode === 'clamp') text = '⇥';
    if (offset !== 0) text += (offset > 0 ? '+' : '') + Math.round(offset * 100) / 100 + 's';
    const badge = document.createElement('span');
    badge.className = 'tline-tbadge';
    badge.textContent = text || '⏱';
    badge.title = '时间通道：' + badge.textContent + '（在对象列表点 ⏱ 可改）';
    label.appendChild(badge);
}

/* ─────────────────────────── 行结构 ─────────────────────────── */

function makeKfNode(objId) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tline-kf';
    b.dataset.layer = objId;
    b.dataset.t = '0';
    b.style.position = 'absolute';
    b.style.top = KF_TOP + 'px';
    b.style.width = KF_SIZE + 'px';
    b.style.height = KF_SIZE + 'px';
    b.style.padding = '0';
    b.style.margin = '0'; // panels.css 用 margin 做居中；内联 left 已是 kfLeft，必须归零
    b.style.transform = 'rotate(45deg)';
    return b;
}

/** 清掉所有行（保留播放头）并把 rowRefs 归零。 */
export function resetRows(view) {
    for (const node of Array.from(view.rows.childNodes)) {
        if (node === view.rowsPlayhead) continue;
        if (node && typeof node.remove === 'function') node.remove();
    }
    view.rowRefs = [];
}

/** 建结构：每个对象一行。 */
export function rebuildRows(view, doc) {
    resetRows(view);

    for (const obj of objectsOf(doc)) {
        const row = document.createElement('div');
        row.className = 'tline-row';
        row.dataset.layer = obj.id;
        row.style.height = ROW_H + 'px';

        const label = document.createElement('div');
        label.className = 'tline-label';
        label.style.flex = '0 0 ' + LABEL_W + 'px';
        label.style.width = LABEL_W + 'px';
        label.style.height = ROW_H + 'px';
        label.style.lineHeight = ROW_H - 2 + 'px';
        label.style.boxSizing = 'border-box';

        const nameEl = document.createElement('span');
        nameEl.className = 'tline-label-name';
        nameEl.textContent = obj.name || '对象';
        nameEl.style.overflow = 'hidden';
        nameEl.style.textOverflow = 'ellipsis';
        nameEl.style.whiteSpace = 'nowrap';
        label.appendChild(nameEl);
        appendTimeBadge(label, obj);

        const lane = document.createElement('div');
        lane.className = 'tline-lane';
        lane.dataset.layer = obj.id;
        lane.style.position = 'relative';
        lane.style.flex = '1 1 auto';
        lane.style.height = ROW_H + 'px';
        // 空白区本来就能双击，但没有任何提示；悬停在空白处时由这条 title 告诉用户。
        // 画格/菱形自带 title，浏览器会优先显示更内层的那条，互不干扰。
        lane.title = '双击空白处打一个变换关键帧 · 右键看更多';

        row.append(label, lane);
        view.rows.appendChild(row);

        view.rowRefs.push({
            id: obj.id,
            row,
            label,
            nameEl,
            lane,
            cels: [],
            kfs: [],
            chKfs: [],
            lastWidth: -1,
            lastName: obj.name || '',
        });
    }
}

export function rowOf(view, id) {
    return view.rowRefs.find((r) => r.id === id) || null;
}

/* ─────────────────────────── 刻度尺 ─────────────────────────── */

export function resetRuler(view) {
    for (const node of Array.from(view.rInner.childNodes)) {
        if (node === view.fpsLane || node === view.rulerPlayhead) continue;
        if (node && typeof node.remove === 'function') node.remove();
    }
}

export function buildRuler(view, doc, zoomX) {
    resetRuler(view);

    const ticks = rulerTicks(doc, zoomX);
    const contentW = Math.max(LABEL_W + 1, LABEL_W + ticks.totalPx + 24);
    view.rInner.style.width = contentW + 'px';

    for (const m of ticks.minor) {
        const tk = document.createElement('div');
        tk.className = 'tline-tick';
        tk.style.position = 'absolute';
        tk.style.bottom = '0';
        tk.style.width = '1px';
        tk.style.height = '5px';
        tk.style.pointerEvents = 'none';
        tk.style.left = m.x.toFixed(2) + 'px';
        view.rInner.appendChild(tk);
    }

    for (const m of ticks.major) {
        const tk = document.createElement('div');
        tk.className = 'tline-tick is-major';
        tk.style.position = 'absolute';
        tk.style.top = '0';
        tk.style.bottom = '0';
        tk.style.width = '1px';
        tk.style.pointerEvents = 'none';
        tk.style.left = m.x.toFixed(2) + 'px';
        view.rInner.appendChild(tk);

        const lab = document.createElement('span');
        lab.className = 'tline-tick-label';
        lab.textContent = m.label;
        lab.style.position = 'absolute';
        lab.style.bottom = '2px';
        lab.style.left = (m.x + 3).toFixed(2) + 'px';
        lab.style.height = '10px';
        lab.style.whiteSpace = 'nowrap';
        view.rInner.appendChild(lab);
    }

    // 右端的时长手柄：拖它就是改总时长（旧版只能去属性面板绕一圈，这就是「不直观」）
    //
    // 位置按「时长末端」算，但默认缩放下 3 秒就超过刻度尺视口了 —— 末端在视野外时
    // 手柄会被裁掉、看不见也抓不到（v8 修）。所以末端越过视口右缘时把手柄钉在右缘，
    // 加 .is-edge 表示「末端还在更右边」，此时拖动走相对位移，不会跳变。
    view.durHandle = ensureDurHandle(view);
    // rInner 自身已经有 translateX(LABEL_W)，所以这里的坐标是「刻度尺内容坐标」：
    // 末端位置 = ticks.totalPx，可视右缘 = 视口宽 - LABEL_W。
    const endX = ticks.totalPx;
    const viewW = Math.max(80, (Number(view.ruler.clientWidth) || 0) - LABEL_W);
    const edge = endX > viewW - 11;
    const leftX = edge ? Math.max(0, viewW - 11) : endX;
    view.durHandle.classList.toggle('is-edge', edge);
    view.durHandle.style.left = leftX.toFixed(2) + 'px';
    view.durHandle.title = '拖动改总时长（当前 ' + fmt2(docDuration(doc)) + ' s）'
        + (edge ? ' · 末端在视野外，缩小时刻度尺或直接在里面输入' : '');
}

/** 时长手柄是常驻节点（每次重画只挪位置），免得拖拽中节点被重建、指针事件丢失。 */
function ensureDurHandle(view) {
    if (view.durHandle && view.durHandle.parentNode === view.rInner) return view.durHandle;
    const h = document.createElement('div');
    h.className = 'tline-durhandle';
    h.style.position = 'absolute';
    h.style.top = '0';
    h.style.height = RULER_H + 'px';
    h.style.width = '9px';
    h.style.cursor = 'ew-resize';
    h.style.pointerEvents = 'auto';
    view.rInner.appendChild(h);
    return h;
}

/* ─────────────────────────── 段帧率条（.tline-fpsseg） ─────────────────────────── */

export function resetSegments(view) {
    for (const node of Array.from(view.fpsLane.childNodes)) {
        if (node && typeof node.remove === 'function') node.remove();
    }
    view.segRefs = [];
}

/**
 * @param onEdit 双击段条时的回调（主文件注入，负责内联输入框与写文档）
 */
export function buildSegments(view, opts, onEdit) {
    const segs = timeSegments(opts.doc, opts.total);
    while (view.segRefs.length < segs.length) {
        const node = document.createElement('div');
        node.className = 'tline-fpsseg';
        node.style.position = 'absolute';
        node.style.top = '0';
        node.style.height = FPS_H + 'px';
        node.style.pointerEvents = 'auto';
        node.style.fontSize = '8px';
        node.style.lineHeight = FPS_H - 1 + 'px';
        node.style.paddingLeft = '2px';
        node.style.zIndex = '1';

        node.addEventListener('pointerdown', (e) => {
            e.stopPropagation();
        });
        node.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            if (typeof e.preventDefault === 'function') e.preventDefault();
            onEdit(node);
        });
        view.fpsLane.appendChild(node);
        view.segRefs.push(node);
    }
    while (view.segRefs.length > segs.length) {
        const dead = view.segRefs.pop();
        if (dead && typeof dead.remove === 'function') dead.remove();
    }

    const cur = segmentIndexAtTime(segs, opts.now);
    view.segRefs.forEach((node, i) => {
        const seg = segs[i];
        const x0 = timeToX(opts.doc, seg.at, opts.zoomX);
        const x1 = timeToX(opts.doc, seg.end, opts.zoomX);
        const left = x0.toFixed(2) + 'px';
        const width = Math.max(2, x1 - x0).toFixed(2) + 'px';
        if (node.style.left !== left) node.style.left = left;
        if (node.style.width !== width) node.style.width = width;
        node.dataset.i = String(i);
        node.dataset.fps = String(seg.fps);
        node.classList.toggle('is-cur', i === cur);
        node.title = Math.round(seg.fps) + ' fps · ' + fmt2(seg.at) + '–' + fmt2(seg.end) + ' s（双击改帧率）';
        if (node.dataset.editing) return; // 正在编辑就别改文字
        // 段太窄时不写字：8px 字号下「12fps」要 32px，硬挤会变成「12ps」这种残字
        const narrow = (x1 - x0) < 34;
        const text = narrow ? '' : Math.round(seg.fps) + 'fps';
        if (node.textContent !== text) node.textContent = text;
    });
}

/**
 * 双击段条改该段 fps：Electron 渲染进程没有 window.prompt，用内联 input。
 * @param done 完成后调用的重绘回调（主文件注入）
 * @param commit 提交帧率（主文件注入，负责写文档与提示）
 */
export function beginFpsEdit(node, deps) {
    if (node.dataset.editing) return;
    node.dataset.editing = '1';
    const idx = Number(node.dataset.i);
    const cur = Number(node.dataset.fps);

    const inp = document.createElement('input');
    inp.type = 'number';
    inp.min = '1';
    inp.max = '120';
    inp.step = '1';
    inp.value = String(Number.isFinite(cur) ? Math.round(cur) : DEFAULT_FPS);
    inp.style.cssText =
        'position:absolute;left:0;top:0;width:100%;height:100%;font-size:8px;line-height:1;' +
        'border:0;padding:0 2px;background:var(--panel-2,#26282d);color:#fff;outline:1px solid var(--accent,#4a7dff);';

    const done = (ok) => {
        if (!node.dataset.editing) return;
        delete node.dataset.editing;
        const v = Number(inp.value);
        if (inp.parentNode) inp.remove();
        if (ok && Number.isFinite(v) && v >= 1 && v <= 120) deps.commit(idx, v);
        deps.repaint();
    };

    inp.addEventListener('pointerdown', (e) => e.stopPropagation());
    inp.addEventListener('dblclick', (e) => e.stopPropagation());
    inp.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') done(true);
        else if (ev.key === 'Escape') done(false);
    });
    inp.addEventListener('blur', () => done(true));

    node.textContent = '';
    node.appendChild(inp);
    if (typeof inp.focus === 'function') inp.focus();
    if (typeof inp.select === 'function') inp.select();
}

/* ─────────────────────────── 行内容：画格点 + 关键帧菱形 ─────────────────────────── */

/** frame = { doc, now, totalPx, zoomX, active }；celDrag 来自主文件（拖动中的节点不被拉回）。 */
export function paintRows(view, frame, celDrag) {
    const doc = frame.doc;
    const now = frame.now;
    const totalPx = frame.totalPx;
    const zoomX = frame.zoomX;
    const byId = new Map(objectsOf(doc).map((o) => [o && o.id, o]));
    const pxWidth = totalPx + 'px';

    for (const ref of view.rowRefs) {
        const obj = byId.get(ref.id);
        if (!obj) continue;

        if (ref.lastWidth !== totalPx) {
            ref.lastWidth = totalPx;
            ref.lane.style.width = pxWidth;
            ref.lane.style.minWidth = pxWidth;
        }

        const name = obj.name || '对象';
        if (ref.lastName !== name) {
            ref.lastName = name;
            ref.nameEl.textContent = name;
            ref.label.title = name + ' · ' + fmt2(now) + ' s';
        }

    }

    // 活动对象的行高亮（用类名，不在 CSS 里写几何）
    for (const ref of view.rowRefs) ref.row.classList.toggle('is-active', ref.id === frame.active);
}

/** 选中集合里有没有这颗（同层同刻，容差与 keyGroups 一致）。 */
function isSelKey(selKeys, layerId, t) {
    for (const k of selKeys) {
        if (k && k.layerId === layerId && Math.abs(k.t - t) <= T_EPS) return true;
    }
    return false;
}

/** frame = { doc, now, zoomX, selKey, selKeys }；选择集合由关键帧模块持有（selKey 是其中的主键）。 */
export function paintTracks(view, frame) {
    const doc = frame.doc;
    const zoomX = frame.zoomX;
    const selKeys = Array.isArray(frame.selKeys) ? frame.selKeys : frame.selKey ? [frame.selKey] : [];
    const selKey = frame.selKey || (selKeys.length ? selKeys[selKeys.length - 1] : null);
    const curX = timeToX(doc, frame.now, zoomX);
    const byId = new Map(objectsOf(doc).map((o) => [o && o.id, o]));

    for (const ref of view.rowRefs) {
        const obj = byId.get(ref.id);
        if (!obj) continue;
        const keys = trackOf(obj).keys;
        const groups = keyGroups(keys);

        while (ref.kfs.length < groups.length) {
            const node = makeKfNode(ref.id);
            ref.lane.appendChild(node);
            ref.kfs.push(node);
        }
        while (ref.kfs.length > groups.length) {
            const dead = ref.kfs.pop();
            if (dead && typeof dead.remove === 'function') dead.remove();
        }

        groups.forEach((g, i) => {
            const node = ref.kfs[i];
            if (!node) return;
            const x = timeToX(doc, g.t, zoomX);
            const left = Math.max(0, x - KF_SIZE / 2).toFixed(2) + 'px';
            if (node.style.left !== left) node.style.left = left;
            node.dataset.t = String(g.t);
            node.dataset.layer = ref.id;
            // v8：画格挂在关键帧上 —— 带画格的键要能一眼看出来（.has-drawing / .is-blank）
            const kfOwn = keys[g.idx[0]];
            const carries = !!kfOwn && Object.prototype.hasOwnProperty.call(kfOwn, 'drawing');
            node.classList.toggle('has-drawing', carries && kfOwn.drawing != null);
            node.classList.toggle('is-blank', carries && kfOwn.drawing == null);
            if (carries) node.dataset.drawing = kfOwn.drawing == null ? '' : String(kfOwn.drawing);
            else if (node.dataset && 'drawing' in node.dataset) delete node.dataset.drawing;

            node.classList.toggle('is-cur', Math.abs(x - curX) <= CUR_EPS_PX);
            // 主键沿用 is-sel（旧样式立刻有反馈），多选里的其余键再叠 is-sel2，
            // 这样「刚点的那颗」和「跟着走的那些」能分开上色（CSS 由主线补）
            const sel = isSelKey(selKeys, ref.id, g.t);
            const isMain = !!selKey && selKey.layerId === ref.id && Math.abs(selKey.t - g.t) <= T_EPS;
            node.classList.toggle('is-sel', sel);
            node.classList.toggle('is-sel2', sel && !isMain);
            node.classList.toggle('is-hold', g.ease === 'hold');
            node.classList.toggle('is-bezier', g.ease === 'bezier');

            // 菱形原本不带任何数值信息，用户看不出这个键到底改了什么；摘要补上这一点
            const own = keys[g.idx[0]];
            const tip =
                '关键帧 ' + g.t.toFixed(3) + ' s · ' + (EASE_TEXT[g.ease] || '线性') +
                ' · ' + keySummary(own && own.state) +
                (g.idx.length > 1 ? ' · ' + g.idx.length + ' 个通道同刻' : '') +
                ' · 连续插值：与相邻关键帧之间平滑过渡' +
                ' · 拖动改时间（Shift 吸附 0.1s）/ 双击删除 / 右键菜单';
            if (node.title !== tip) node.title = tip;
        });

        // 通道独立轨道的键：曲线区给某通道单独打点时，这里也要看得见，
        // 否则那些点只活在曲线面板里、时间轴一片空白。
        // 与共用键重合的时刻不再画（会和蓝菱形叠在一起），只在「独立出来的时刻」出现。
        const chPoints = channelKeyTimes(trackOf(obj), keys);
        while (ref.chKfs.length < chPoints.length) {
            const node = makeKfNode(ref.id);
            node.classList.add('is-ch');
            ref.lane.appendChild(node);
            ref.chKfs.push(node);
        }
        while (ref.chKfs.length > chPoints.length) {
            const dead = ref.chKfs.pop();
            if (dead && typeof dead.remove === 'function') dead.remove();
        }
        chPoints.forEach((p, i) => {
            const node = ref.chKfs[i];
            if (!node) return;
            const x = timeToX(doc, p.t, zoomX);
            node.style.left = (x - KF_SIZE / 2).toFixed(2) + 'px';
            node.dataset.t = String(p.t);
            node.dataset.layer = ref.id;
            node.classList.toggle('is-sel',
                !!selKey && selKey.layerId === ref.id && Math.abs(selKey.t - p.t) <= T_EPS);
            node.classList.toggle('is-sel2', false); // 通道键不参与多选集合，别残留上一帧的类
            const tip2 = '通道关键帧 ' + p.t.toFixed(3) + ' s · ' + p.fields.join(' / ') +
                ' · 只作用于这些通道，其余通道仍按共用关键帧走 · 到曲线区编辑';
            if (node.title !== tip2) node.title = tip2;
        });
    }
}

/**
 * 收集「通道独立轨道上、且不与共用关键帧重合」的时刻。
 * 返回 [{ t, fields: ['rotate', ...] }]，按时间升序，同刻合并成一条。
 */
function channelKeyTimes(track, sharedKeys) {
    const ch = track && track.channels;
    if (!ch) return [];
    const shared = new Set((sharedKeys || []).map((k) => Math.round(k.t * 1e6)));
    const byT = new Map();
    for (const field of Object.keys(ch)) {
        const c = ch[field];
        if (!c || !Array.isArray(c.keys)) continue;
        for (const k of c.keys) {
            if (!k || !Number.isFinite(k.t)) continue;
            const sig = Math.round(k.t * 1e6);
            if (shared.has(sig)) continue;
            const hit = byT.get(sig);
            if (hit) hit.fields.push(field);
            else byT.set(sig, { t: k.t, fields: [field] });
        }
    }
    return Array.from(byT.values()).sort((a, b) => a.t - b.t);
}

export function paintPlayhead(view, frame) {
    const x = timeToX(frame.doc, frame.now, frame.zoomX);
    const lx = x.toFixed(2) + 'px';
    if (view.rulerPlayhead.style.left !== lx) view.rulerPlayhead.style.left = lx;
    const rx = (LABEL_W + x).toFixed(2) + 'px';
    if (view.rowsPlayhead.style.left !== rx) view.rowsPlayhead.style.left = rx;
    const h = view.rowRefs.length * ROW_H;
    const hs = Math.max(h, 26) + 'px';
    if (view.rowsPlayhead.style.height !== hs) view.rowsPlayhead.style.height = hs;
}

export function syncRulerScroll(view) {
    const s = Number(view.rows.scrollLeft) || 0;
    const tx = 'translateX(' + (LABEL_W - s) + 'px)';
    if (view.rInner.style.transform !== tx) view.rInner.style.transform = tx;
}

/**
 * frame = { doc, now, total, totalPx, active, playing, zoomX, selKey, selKeys }
 *
 * 工具条是状态的镜子：可编辑性、读数、播放按钮字形只在这里写。
 * 别在别处再写 nowEl/totalEl —— 两处写法会互相覆盖，读数就会跳。
 */
export function updateTools(view, frame) {
    const obj = objectById(frame.doc, frame.active);
    const marks = obj ? celMarks(obj) : [];
    const playing = !!frame.playing;
    const zoomX = frame.zoomX;
    const total = Number(frame.total) || 0;
    const now = Number(frame.now) || 0;

    // 播放：字形跟着状态走，标题说明「按下会发生什么」
    view.btns.play.textContent = playing ? '❚❚' : '▶';
    view.btns.play.title = playing ? '暂停（空格）' : '播放 / 暂停（空格）';
    view.btns.play.classList.toggle('is-on', playing);

    // 读数：正在输入的那个框不抢，否则每帧重绘会把光标和选区踢掉
    const focused = document.activeElement;
    if (view.nowEl && focused !== view.nowEl) view.nowEl.value = now.toFixed(2);
    if (view.totalEl && focused !== view.totalEl) view.totalEl.value = total.toFixed(2);

    // 播放控制：播放头贴边就禁用对应方向，逐帧在文档非空时永远可用
    view.btns.first.disabled = now <= T_EPS;
    view.btns.prev.disabled = now <= T_EPS;
    view.btns.next.disabled = now >= total - T_EPS;
    view.btns.last.disabled = now >= total - T_EPS;

    // 画格动作：必须先选对象；删画格还要留一格
    view.btns.prevCel.disabled = !obj || !marks.some((m) => m.at < now - T_EPS);
    view.btns.nextCel.disabled = !obj || !marks.some((m) => m.at > now + T_EPS);
    view.btns.addCel.disabled = !obj;
    view.btns.delCel.disabled = !obj || marks.length <= 1;
    view.btns.addKey.disabled = !obj;

    view.btns.zoomOut.disabled = zoomX <= ZOOM_MIN + 1e-9;
    view.btns.zoomIn.disabled = zoomX >= ZOOM_MAX - 1e-9;
    view.zoomEl.textContent = zoomX.toFixed(1) + '×';

    // 磁铁：按下态就是当前吸附状态（开着=吸整帧）
    const on = frame.snapOn !== false;
    view.btns.snap.classList.toggle('is-on', on);
    if (typeof view.btns.snap.setAttribute === 'function') view.btns.snap.setAttribute('aria-pressed', on ? 'true' : 'false');
    view.btns.snap.title = on
        ? '吸附到整帧：开（拖动时按住 Shift 可临时自由）'
        : '吸附到整帧：关（拖动时按住 Shift 可临时吸附到 0.1 s 网格）';
}
