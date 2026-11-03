// 时间轴的「画」：把 DOM 建出来、把最新状态写进 style。
// 这里不碰文档、不绑业务事件（段帧率条的内联输入框例外：它只是编辑器 UI，
// 真正写文档的 commit 由主文件注入；另有一个行区 scroll 监听，只更新滚动缓存，
// 见文件底部 noteRowsScroll()）。
//
// 结构：
//   .tline
//     .tline-tools   播放 / 再曝光 / 删曝光 / 关键帧 / − 缩放 + / 倍率 / 总时长
//     .tline-ruler   秒刻度尺 + .tline-fpslane 段帧率条 + 播放头
//     .tline-rows    每个对象一行
//       .tline-row
//         .tline-label   对象名（sticky 96px）
//         .tline-lane
//           （纹理块已移除：纹理挂在关键帧上，换图看 .tline-kf.has-drawing）
//           .tline-kf[data-layer][data-t]   关键帧菱形
//
// 几何（left/top/width/height）一律内联写入，CSS 只负责颜色与手感。

import { icon, escapeAttr } from '../core/icons.mjs';
import { getLocale, t } from '../i18n/index.mjs';
// 播放速度的读数与播放方式的名/图标：与 core/playback.mjs 的判定表同源
import { formatSpeed, modeInfo } from '../core/playback.mjs';
// 图例的唯一数据源在 help.mjs：设置里的「图例」分组与这个浮层读同一份，不再各写一套
import { LEGEND_ITEMS } from './help.mjs';
// B1：独立通道键的配色与曲线区共用同一张色表（channelColorOf）
import { channelColorOf, effectChannelEntries, effectKeyTimes } from './curve-geo.mjs';
// 效果参数通道的关键帧也要画进时间轴（与曲线 0.7.0 的通道同源）
import { EFFECT_DEFS } from '../paint/effects.mjs';
import { celTimes, docDuration, objectById, objectsOf } from '../core/doc-model.mjs';
import {
    CUR_EPS_PX,
    DEFAULT_FPS,
    FPS_H,
    KF_SIZE,
    KF_TOP,
    LABEL_W,
    ROW_H,
    RULER_H,
    T_EPS,
    ZOOM_MAX,
    ZOOM_MIN,
    easeText,
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

    /**
     * 建一个工具条按钮。
     * spec.text 为空 = 纯图标按钮：走 ms-icon-btn（22×22 方盒，等比缩放的图标），
     * 并强制补 aria-label —— 没有文字时标题就是唯一的可读名。
     * spec.text 有值 = 图标 + 文字（ms-icon-label），宽度按内容走。
     */
    const mkBtn = (host, act, spec) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tline-btn ' + (spec.text ? 'ms-icon-label' : 'ms-icon-btn');
        b.dataset.act = act;
        if (host && host.dataset && host.dataset.grp) b.dataset.grp = host.dataset.grp;
        b.innerHTML = icon(spec.icon) + (spec.text ? '<span>' + escapeAttr(spec.text) + '</span>' : '');
        b.title = spec.title;
        // 测试里的假 DOM 只有 createElement 的极简壳，没有 setAttribute —— 照旧防御
        if (typeof b.setAttribute === 'function') b.setAttribute('aria-label', spec.title);
        host.appendChild(b);
        return b;
    };

    /* ── 1. 播放控制（v8：从顶栏搬进来的，时间轴才是它的老家） ──
       图标化：字形（⏮ ‹ ▶ › ⏭）在不同系统字体里缺字或粗细不一，换成自绘 SVG 后
       5 个按钮仍然各占 22px，工具条总宽不变。标题照旧写中文（含快捷键）。 */
    const gTr = grp('transport', 'transport');
    const first = mkBtn(gTr, 'first', { icon: 'step-back', text: '', title: t('timeline.btn.first') });
    const prev = mkBtn(gTr, 'prev', { icon: 'chevron-left', text: '', title: t('timeline.btn.prev') });
    const play = mkBtn(gTr, 'play', { icon: 'play', text: '', title: t('timeline.btn.play') });
    const next = mkBtn(gTr, 'next', { icon: 'chevron-right', text: '', title: t('timeline.btn.next') });
    const last = mkBtn(gTr, 'last', { icon: 'step-forward', text: '', title: t('timeline.btn.last') });
    /* v10：预览的两件事放在走带后面 —— 它们只影响播放，不影响文档内容。
       速度是观看偏好（存 ms.prefs），方式是文档字段（doc.loopMode），点一下换下一种。 */
    const speedBtn = mkBtn(gTr, 'play-speed', { icon: 'gauge', text: formatSpeed(1), title: t('timeline.btn.speed', { speed: formatSpeed(1) }) });
    const modeBtn = mkBtn(gTr, 'play-mode', { icon: 'loop', text: '', title: t('timeline.btn.mode', { label: modeInfo(null).label }) });

    /* ── 2. 时间读数：当前时间与总时长都是可输入的数字 ──
       「总时长调整不直观」的根因就是它原本只是一段只读文字。 */
    // 读数跟着播放控制走（同属 transport 段），这样工具条只切三段：播放 / 编辑 / 缩放
    const gTime = grp('time', 'transport');
    const nowEl = document.createElement('input');
    nowEl.type = 'text';
    nowEl.className = 'tline-now';
    nowEl.inputMode = 'decimal';
    nowEl.spellcheck = false;
    nowEl.title = t('timeline.now.title');
    nowEl.value = '0.00';
    const sepEl = document.createElement('span');
    sepEl.className = 'tline-sep';
    sepEl.textContent = '/';
    const totalEl = document.createElement('input');
    totalEl.type = 'text';
    totalEl.className = 'tline-total';
    totalEl.inputMode = 'decimal';
    totalEl.spellcheck = false;
    totalEl.title = t('timeline.total.title');
    totalEl.value = '0.00';
    const unitEl = document.createElement('span');
    unitEl.className = 'tline-unit';
    unitEl.textContent = 's';
    gTime.append(nowEl, sepEl, totalEl, unitEl);

    /* ── 3. 曝光（某段时刻显示哪张纹理） ──
       「上一格 / 下一格」已删：时间轴上没有「格」这个单位，跳纹理切换点由 Shift+, / Shift+.
       和命令面板承担（app.mjs 的 goPrevCel / goNextCel），工具条只留两个真入口。
       组名 cel → tex 是术语清算的一部分：data-grp 只是分组标记，panels.css 只认
       [data-zone-start]，不认它的值。 */
    const gTex = grp('tex', 'edit');
    const add = mkBtn(gTex, 'addcel', { icon: 'plus', text: t('timeline.btn.addcel.text'), title: t('timeline.btn.addcel') });
    const del = mkBtn(gTex, 'delcel', { icon: 'trash', text: t('timeline.btn.delcel.text'), title: t('timeline.btn.delcel') });

    /* ── 4. 关键帧 ── */
    const gKey = grp('key', 'edit');
    const addKey = mkBtn(gKey, 'addkey', { icon: 'diamond', text: '', title: t('timeline.btn.addKey') });
    // 磁铁：拖动关键帧 / 纹理 / 时长手柄时吸附到整帧（AE、Aseprite 的默认行为）。
    const snap = mkBtn(gKey, 'snap', { icon: 'magnet', text: t('timeline.btn.snap.text'), title: t('timeline.btn.snap') });
    if (typeof snap.setAttribute === 'function') snap.setAttribute('aria-pressed', 'true');

    /* ── 5. 缩放 ── */
    const gZoom = grp('zoom', 'zoom');
    const zoomOut = mkBtn(gZoom, 'zoomout', { icon: 'minus', text: '', title: t('timeline.btn.zoomOut') });
    const zoomIn = mkBtn(gZoom, 'zoomin', { icon: 'plus', text: '', title: t('timeline.btn.zoomIn') });

    const zoomEl = document.createElement('span');
    zoomEl.className = 'tline-zoom';
    zoomEl.textContent = '1.0×';
    zoomEl.title = t('timeline.zoom.title');
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

    const view = {
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
        // v8 的五组按钮：播放控制 / 时间读数 / 曝光 / 关键帧 / 缩放
        btns: {
            first,
            prev,
            play,
            next,
            last,
            speed: speedBtn,
            mode: modeBtn,
            addCel: add,
            delCel: del,
            addKey,
            snap,
            zoomOut,
            zoomIn,
        },
        rowRefs: [],
        segRefs: [],
        // 行区滚动位置缓存：重绘只读这两个字段，读 DOM 的地方只有 noteRowsScroll()
        scrollL: 0,
        scrollT: 0,
    };
    // 行区滚动时刷新缓存（passive：不挡滚动）。重绘路径不再读 scrollLeft，
    // 见 syncRulerScroll() 的注释。
    if (typeof rows.addEventListener === 'function') rows.addEventListener('scroll', () => noteRowsScroll(view), { passive: true });
    return view;
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

/* ─────────────────────────── 图例：纹理 vs 关键帧 ─────────────────────────── */

/**
 * 工具条右侧的「?」图例。点开两行说明，点别处或 Esc 收起。
 *
 * 卡片挂在 document.body 上而不是 .tline 里：.tline 的孩子数量与顺序被
 * tests/timeline.test.mjs 钉死（tools / ruler / rows 三块），图例不能挤进去。
 * 卡片 pointer-events:none —— 它只是说明文字，绝不挡住时间轴上的操作。
 * 文案来自 help.mjs 的 LEGEND_ITEMS（与设置工作区同源）。
 */
export function createLegend() {
    let card = null;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tline-legend';
    btn.innerHTML = icon('help');
    btn.title = t('timeline.legend.title');
    if (typeof btn.setAttribute === 'function') btn.setAttribute('aria-label', btn.title);

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

        for (const item of LEGEND_ITEMS) {
            const line = document.createElement('div');
            line.className = 'tline-legend-row';

            const m = document.createElement('span');
            m.className = 'tline-legend-mark is-' + item.kind;
            m.textContent = item.mark;

            const n = document.createElement('b');
            n.className = 'tline-legend-name';
            n.textContent = item.name;

            const t = document.createElement('span');
            t.className = 'tline-legend-text';
            t.textContent = item.text;

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
    badge.title = t('timeline.badge.title', { text: badge.textContent });
    label.appendChild(badge);
}

/* ─────────────────────────── 行结构 ─────────────────────────── */

function makeKfNode(objId) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tline-kf';
    // 兜底文案：节点刚建、还没被 paint() 覆写 title 的那一帧也必须可读（悬停不能是空的）。
    // 真正的摘要（时刻 / 缓动 / 通道数 / 拖动说明）由 paint 里的 tip 覆盖。
    b.title = t('timeline.kf.title');
    if (typeof b.setAttribute === 'function') b.setAttribute('aria-label', t('timeline.kf.aria'));
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
        // 骨骼行带自己的颜色标识（与层级面板同一口径）
        const rowKind = obj.kind || 'paint';
        row.dataset.kind = rowKind;
        row.classList.toggle('is-bone', rowKind === 'bone');
        if (rowKind === 'bone' && obj.bone && obj.bone.color && row.style && typeof row.style.setProperty === 'function') {
            row.style.setProperty('--bone', obj.bone.color);
        }
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
        nameEl.textContent = obj.name || t('timeline.objectFallback');
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
        // 纹理/菱形自带 title，浏览器会优先显示更内层的那条，互不干扰。
        lane.title = t('timeline.lane.title');

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
    view.durHandle.title = edge
        ? t('timeline.durHandle.edge', { dur: fmt2(docDuration(doc)) })
        : t('timeline.durHandle', { dur: fmt2(docDuration(doc)) });
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
        node.style.fontSize = '10px';
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
        node.title = t('timeline.seg.fps', { fps: Math.round(seg.fps), from: fmt2(seg.at), to: fmt2(seg.end) });
        if (node.dataset.editing) return; // 正在编辑就别改文字
        // 段太窄时不写字：10px 字号下「12fps」要 40px，硬挤会变成「12ps」这种残字
        const narrow = (x1 - x0) < 42;
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
        'position:absolute;left:0;top:0;width:100%;height:100%;font-size:10px;line-height:1;' +
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

/* ─────────────────────────── 行内容：纹理点 + 关键帧菱形 ─────────────────────────── */

/**
 * 每帧重绘的缓存。
 *
 * 文档是结构共享的不可变结构：没有编辑过的对象，`transform.keys` / `effects`
 * 的引用逐帧不变。所以「按引用记忆派生结果」是安全的 —— 一旦用户改了这个对象，
 * 新文档里就是一个新引用，缓存自然失效。
 *
 * 为什么值得做：一帧里 240 行 × 24 个键 = 5760 个菱形要过一遍，`keyGroups` 的
 * 排序、`effectChannelEntries` 的展开、`keySummary` + `t()` 的标题拼装会重复做
 * 同样的活；而写 DOM（style/dataset/title/classList）比算 DOM 贵得多，节点上
 * 记一个「上次写进去的值」就能把绝大多数写操作省掉。
 */
const groupsCache = new WeakMap(); // keys 数组 → keyGroups()
const chCache = new WeakMap(); // 对象 → { effects, points }（通道/效果独立的键）

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

        const name = obj.name || t('timeline.objectFallback');
        if (ref.lastName !== name) {
            ref.lastName = name;
            ref.nameEl.textContent = name;
            ref.label.title = name + ' · ' + fmt2(now) + ' s';
        }

    }

    // 活动对象的行高亮（用类名，不在 CSS 里写几何）
    const active = frame.active;
    for (const ref of view.rowRefs) {
        const on = ref.id === active;
        if (ref.lastActive !== on) {
            ref.lastActive = on;
            ref.row.classList.toggle('is-active', on);
        }
    }
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

    const locale = getLocale();
    for (const ref of view.rowRefs) {
        const obj = byId.get(ref.id);
        if (!obj) continue;
        const track = trackOf(obj);
        const keys = track.keys;
        let groups = groupsCache.get(keys);
        if (!groups) {
            groups = keyGroups(keys);
            groupsCache.set(keys, groups);
        }

        while (ref.kfs.length < groups.length) {
            const node = makeKfNode(ref.id);
            ref.lane.appendChild(node);
            ref.kfs.push(node);
        }
        while (ref.kfs.length > groups.length) {
            const dead = ref.kfs.pop();
            if (dead && typeof dead.remove === 'function') dead.remove();
        }

        for (let i = 0; i < groups.length; i++) {
            const g = groups[i];
            const node = ref.kfs[i];
            if (!node) continue;
            const x = timeToX(doc, g.t, zoomX);
            const left = Math.max(0, x - KF_SIZE / 2).toFixed(2) + 'px';
            if (node._left !== left) {
                node._left = left;
                node.style.left = left;
            }
            const ts = String(g.t);
            if (node._t !== ts) {
                node._t = ts;
                node.dataset.t = ts;
            }
            if (node._layer !== ref.id) {
                node._layer = ref.id;
                node.dataset.layer = ref.id;
            }
            // v8：纹理挂在关键帧上 —— 带纹理的键要能一眼看出来（.has-drawing / .is-blank）
            const kfOwn = keys[g.idx[0]];
            const carries = !!kfOwn && Object.prototype.hasOwnProperty.call(kfOwn, 'drawing');
            const hasDr = carries && kfOwn.drawing != null;
            const blank = carries && kfOwn.drawing == null;
            if (node._hasDr !== hasDr) {
                node._hasDr = hasDr;
                node.classList.toggle('has-drawing', hasDr);
            }
            if (node._blank !== blank) {
                node._blank = blank;
                node.classList.toggle('is-blank', blank);
            }
            const dr = carries ? (kfOwn.drawing == null ? '' : String(kfOwn.drawing)) : undefined;
            if (node._dr !== dr) {
                node._dr = dr;
                if (dr === undefined) {
                    if (node.dataset && 'drawing' in node.dataset) delete node.dataset.drawing;
                } else {
                    node.dataset.drawing = dr;
                }
            }

            const isCur = Math.abs(x - curX) <= CUR_EPS_PX;
            if (node._cur !== isCur) {
                node._cur = isCur;
                node.classList.toggle('is-cur', isCur);
            }
            // 主键沿用 is-sel（旧样式立刻有反馈），多选里的其余键再叠 is-sel2，
            // 这样「刚点的那颗」和「跟着走的那些」能分开上色（CSS 由主线补）
            const sel = isSelKey(selKeys, ref.id, g.t);
            const isMain = !!selKey && selKey.layerId === ref.id && Math.abs(selKey.t - g.t) <= T_EPS;
            if (node._sel !== sel) {
                node._sel = sel;
                node.classList.toggle('is-sel', sel);
            }
            const sel2 = sel && !isMain;
            if (node._sel2 !== sel2) {
                node._sel2 = sel2;
                node.classList.toggle('is-sel2', sel2);
            }
            const hold = g.ease === 'hold';
            if (node._hold !== hold) {
                node._hold = hold;
                node.classList.toggle('is-hold', hold);
            }
            const bez = g.ease === 'bezier';
            if (node._bez !== bez) {
                node._bez = bez;
                node.classList.toggle('is-bezier', bez);
            }

            // 菱形原本不带任何数值信息，用户看不出这个键到底改了什么；摘要补上这一点。
            // 标题（keySummary + 两次 t()）是这一帧最贵的一类活，所以按「键对象 + 组大小 +
            // 缓动 + 语言」记忆：文档没编辑时这些全都不变，逐帧重算纯属浪费。
            if (node._tipOwner !== kfOwn || node._tipN !== g.idx.length
                || node._tipEase !== g.ease || node._tipLocale !== locale) {
                const tipArgs = {
                    t: g.t.toFixed(3),
                    ease: easeText(g.ease),
                    summary: keySummary(kfOwn && kfOwn.state),
                    n: g.idx.length,
                };
                const tip = t(g.idx.length > 1 ? 'timeline.tip.kf.multi' : 'timeline.tip.kf.single', tipArgs);
                node._tipOwner = kfOwn;
                node._tipN = g.idx.length;
                node._tipEase = g.ease;
                node._tipLocale = locale;
                if (node.title !== tip) node.title = tip;
            }
        }

        // 通道独立轨道的键：曲线区给某通道单独打点时，这里也要看得见，
        // 否则那些点只活在曲线面板里、时间轴一片空白。
        // 与共用键重合的时刻不再画（会和蓝菱形叠在一起），只在「独立出来的时刻」出现。
        // 效果参数通道（`0.7.0` 起进曲线）的关键帧也按同样方式出现在这里 ——
        // 否则效果动画只在曲线里可见，时间轴看起来像「什么都没发生」。
        // 派生结果按对象引用记忆：同一个对象（没被编辑）这些数组逐帧完全一样。
        let ch = chCache.get(obj);
        if (!ch) {
            const entries = effectChannelEntries(obj.effects, EFFECT_DEFS);
            ch = {
                entries,
                color: new Map(entries.map((e) => [e.id, e.color])),
                label: new Map(entries.map((e) => [e.id, t(e.def.nameKey) + ' ' + t(e.param.labelKey)])),
                locale,
                points: mergeChannelPoints(
                    channelKeyTimes(trackOf(obj), keys),
                    effectKeyTimes(obj.effects, EFFECT_DEFS)
                ),
            };
            chCache.set(obj, ch);
        } else if (ch.locale !== locale) {
            // 切语言：只有人看的标签要重取，配色与时刻不变
            ch.locale = locale;
            ch.color = new Map(ch.entries.map((e) => [e.id, e.color]));
            ch.label = new Map(ch.entries.map((e) => [e.id, t(e.def.nameKey) + ' ' + t(e.param.labelKey)]));
        }
        const chPoints = ch.points;
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
        for (let i = 0; i < chPoints.length; i++) {
            const p = chPoints[i];
            const node = ref.chKfs[i];
            if (!node) continue;
            const x = timeToX(doc, p.t, zoomX);
            const left = (x - KF_SIZE / 2).toFixed(2) + 'px';
            if (node._left !== left) {
                node._left = left;
                node.style.left = left;
            }
            const ts = String(p.t);
            if (node._t !== ts) {
                node._t = ts;
                node.dataset.t = ts;
            }
            if (node._layer !== ref.id) {
                node._layer = ref.id;
                node.dataset.layer = ref.id;
            }
            // 通道标识（空格分隔的字段名，同刻多通道已合并成一条）。
            // 点这颗菱形要把曲线焦点切到对应通道，没有它就只能猜。
            const chs = p.fields.join(' ');
            if (node._chs !== chs) {
                node._chs = chs;
                node.dataset.ch = chs;
            }
            // B1：**按通道上色**。时间轴上「只在某通道单独打的键」与共用关键帧都是菱形，
            // 以前两者都是同一个空心 accent 色，看不出这颗属于哪个通道；现在与曲线同色，
            // 多通道合并的那颗用第一个通道的颜色（title 里列全部字段）。
            const chColor = ch.color.get(p.fields[0]) || channelColorOf(p.fields[0]);
            if (node._chColor !== chColor) {
                node._chColor = chColor;
                if (node.style && typeof node.style.setProperty === 'function') {
                    node.style.setProperty('--ch', chColor);
                }
            }
            const selCh = !!selKey && selKey.layerId === ref.id && Math.abs(selKey.t - p.t) <= T_EPS;
            if (node._sel !== selCh) {
                node._sel = selCh;
                node.classList.toggle('is-sel', selCh);
            }
            if (node._sel2) {
                node._sel2 = false;
                node.classList.toggle('is-sel2', false); // 通道键不参与多选集合，别残留上一帧的类
            }
            if (node._tipLocale !== locale || node._tipFields !== p.fields) {
                const labels = p.fields.map((id) => ch.label.get(id) || id).join(' / ');
                const tip2 = t('timeline.tip.channelKey', { t: p.t.toFixed(3), fields: labels });
                node._tipLocale = locale;
                node._tipFields = p.fields;
                if (node.title !== tip2) node.title = tip2;
            }
        }
    }
}

/**
 * 合并两组通道键时刻（变换通道 + 效果参数通道）：同一时刻合并成一条（字段去重），
 * 按时间升序。两条来源各自已经升序，这里只做「按 1e-6 对齐的并集」。
 *
 * @param {{t:number, fields:string[]}[]} a
 * @param {{t:number, fields:string[]}[]} b
 * @returns {{t:number, fields:string[]}[]}
 */
export function mergeChannelPoints(a, b) {
    const byT = new Map();
    const push = (list) => {
        for (const p of Array.isArray(list) ? list : []) {
            const t = Number(p && p.t);
            if (!Number.isFinite(t)) continue;
            const sig = Math.round(t * 1e6);
            const hit = byT.get(sig);
            if (!hit) {
                byT.set(sig, { t: t, fields: Array.from(new Set(p.fields || [])) });
                continue;
            }
            for (const f of p.fields || []) if (!hit.fields.includes(f)) hit.fields.push(f);
        }
    };
    push(a);
    push(b);
    return Array.from(byT.values()).sort((x, y) => x.t - y.t);
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

/**
 * 行区滚动的唯一读数点：把 scrollLeft/scrollTop 记进 view，再立刻贴刻度尺。
 *
 * 为什么不在重绘里读 `rows.scrollLeft`：那是一次强制布局读数。paint() 每帧都调
 * syncRulerScroll()，而上一帧刚写完几十条 style，这时候读会把整条时间轴的布局
 * 同步结算掉（240 行文档逐帧重绘实测占掉一大块）。scroll 事件最多每帧一次，
 * 且事件里布局是干净的，读一次记下来即可。
 *
 * 这里同步调 syncRulerScroll 而不是等 rAF：滚动时标尺必须当帧跟随，延后一帧会
 * 看见刻度尺「追不上」。写 transform 不触发布局，在 scroll 事件里是廉价操作。
 */
function noteRowsScroll(view) {
    view.scrollL = Number(view.rows.scrollLeft) || 0;
    view.scrollT = Number(view.rows.scrollTop) || 0;
    syncRulerScroll(view);
}

/**
 * 把刻度尺内容层平移到「行区已横向滚过的距离」。
 *
 * 只读 view.scrollL 缓存（由 noteRowsScroll 在 scroll 事件里刷新）：paint() 每帧
 * 都会调到这里，绝不能读 DOM 布局属性。程序化设置 scrollLeft 之后（缩放 / 适应
 * 窗口 / 拖播放头）缓存会短暂落后，浏览器随后派发的 scroll 事件会把它补齐，
 * 下一帧重绘也就一致了。
 */
export function syncRulerScroll(view) {
    const s = Number(view.scrollL) || 0;
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
    // 判据用 celTimes（关键帧上的真源），不用 celMarks（obj.cels 那条只读投影）
    const times = obj ? celTimes(obj) : [];
    const playing = !!frame.playing;
    const zoomX = frame.zoomX;
    const total = Number(frame.total) || 0;
    const now = Number(frame.now) || 0;

    // 播放：图标跟着状态走，标题说明「按下会发生什么」
    view.btns.play.innerHTML = icon(playing ? 'pause' : 'play');
    view.btns.play.title = playing ? t('timeline.btn.pause') : t('timeline.btn.play');
    if (typeof view.btns.play.setAttribute === 'function') view.btns.play.setAttribute('aria-label', view.btns.play.title);
    view.btns.play.classList.toggle('is-on', playing);

    /* 速度与方式：这两个按钮的读数从「偏好」与「文档字段」来，不在这里写状态 ——
       点一下只负责把值交给 ctx（时间轴主文件分派），这里照值画。 */
    if (view.btns.speed) {
        const speedTxt = formatSpeed(Number(frame.speed) || 1);
        // 只改文字那一格：整块 textContent 会把左边的 SVG 一起抹掉
        const lab = view.btns.speed.querySelector ? view.btns.speed.querySelector('span') : null;
        if (lab) lab.textContent = speedTxt;
        else view.btns.speed.textContent = speedTxt;
        view.btns.speed.title = t('timeline.btn.speed', { speed: speedTxt });
        if (typeof view.btns.speed.setAttribute === 'function') view.btns.speed.setAttribute('aria-label', t('timeline.btn.speedAria', { speed: speedTxt }));
        view.btns.speed.classList.toggle('is-odd', speedTxt !== '1×');
    }
    if (view.btns.mode) {
        const info = modeInfo(frame.doc && frame.doc.loopMode);
        view.btns.mode.innerHTML = icon(info.icon);
        view.btns.mode.title = t('timeline.btn.mode', { label: info.label });
        if (typeof view.btns.mode.setAttribute === 'function') view.btns.mode.setAttribute('aria-label', t('timeline.btn.modeAria', { label: info.label }));
        view.btns.mode.classList.toggle('is-odd', info.id !== 'cycle');
    }

    // 读数：正在输入的那个框不抢，否则每帧重绘会把光标和选区踢掉
    const focused = document.activeElement;
    if (view.nowEl && focused !== view.nowEl) view.nowEl.value = now.toFixed(2);
    if (view.totalEl && focused !== view.totalEl) view.totalEl.value = total.toFixed(2);

    // 播放控制：播放头贴边就禁用对应方向，逐帧在文档非空时永远可用
    view.btns.first.disabled = now <= T_EPS;
    view.btns.prev.disabled = now <= T_EPS;
    view.btns.next.disabled = now >= total - T_EPS;
    view.btns.last.disabled = now >= total - T_EPS;

    // 曝光动作：必须先选对象；删曝光要留一次（removeCelAt 也不允许一张不剩）
    view.btns.addCel.disabled = !obj;
    view.btns.delCel.disabled = !obj || times.length <= 1;
    view.btns.addKey.disabled = !obj;

    view.btns.zoomOut.disabled = zoomX <= ZOOM_MIN + 1e-9;
    view.btns.zoomIn.disabled = zoomX >= ZOOM_MAX - 1e-9;
    view.zoomEl.textContent = zoomX.toFixed(1) + '×';

    // 磁铁：按下态就是当前吸附状态（开着=吸整帧）
    const on = frame.snapOn !== false;
    view.btns.snap.classList.toggle('is-on', on);
    if (typeof view.btns.snap.setAttribute === 'function') view.btns.snap.setAttribute('aria-pressed', on ? 'true' : 'false');
    view.btns.snap.title = on ? t('timeline.snapOn') : t('timeline.snapOff');
}
