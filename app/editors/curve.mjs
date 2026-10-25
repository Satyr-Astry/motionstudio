// 曲线编辑器（Graph Editor）：把对象变换轨道的每个标量通道画成连续曲线 ——
// 时间轴（帧带）回答「这一格像素属于哪一帧」，这里回答「对象在两帧之间怎么动」。
// 数据有两个层次：共用 `layer.transform.keys`（一个关键帧携带全部通道）与
// `transform.channels[field].keys`（某通道自己的关键帧）。取数一律**通道优先**：
// 通道有独立轨道就用它自己的键，否则回退到共用键里该通道的分量。
// 分工：curve-geo.mjs=坐标/通道/值域/命中（纯函数），curve-draw.mjs=只画，本文件=DOM/状态/事件/写回。
//
// 显示模型：一次只「编辑」一条曲线。
//   focus = 当前通道：满色曲线 + 关键帧圆点 + 独占 Y 轴真实刻度
//   refs  = 叠加的参考线：细、半透明、无圆点，数值看右边缘同色读数
// 原因：通道量纲互不相同（X 是像素、A 是比例、R 是角度），多条曲线共用一套 Y 轴刻度时，
// 任何单一数字都只对其中一条成立 —— 干脆让刻度永远跟着聚焦通道走，其余只对照形状。
//
// 独立轨道的时机：第一次在某个通道上拖动/加点/删点/改缓动时，先把共用关键帧提升成它的
// 独立轨道（promoteChannel，同一时刻取值完全相等，所以画面不跳），之后只动它自己。
// 参考线是只读的 —— 替别的通道提升等于偷偷改数据。

import {
    stateAt, addKey, removeKey, setKeyEase, autoTangents as applyAutoTangents,
    channelOf, clearChannel, setChannelKey, removeChannelKey, setChannelKeyEase,
} from '../core/transform.mjs';
import { icon } from '../core/icons.mjs';
import { clickIntent } from '../core/selection.mjs';
import { normalizeLattice, latticeIsZero } from '../core/lattice.mjs';
import { patchLayer, layerById, celTimes, objectsOf } from '../core/cel.mjs';
import {
    PAD_L, PAD_R, PAD_T, PAD_B, EASE_LABEL, SCALAR_CHANNELS, ensureWarpChannels, warpChannels, chById, chValue,
    clamp, fmt2, fmtVal, totalSeconds, computeRange, xToT, yToV,
    hitTest as geoHitTest, pickInRect, dragKeyTo, dragHandleTo, selectionIndexes,
    channelKeysOf, writeModeOf, occupiedAt, isChannelField, dragChannelKeyTo, dragChannelHandleTo, autoTangentsChannel,
} from './curve-geo.mjs';
import { resizeCanvas, beginFrame, paintCanvas } from './curve-draw.mjs';
// 曲线里「拖出来/打出来的时刻」也要落在整帧上，否则时间轴帧带里对不上位置
import { snapForDrag } from './timeline-geo.mjs';
import { snapOnNow } from './timeline-keys.mjs';
import { hideTip, showTip } from './drag-tip.mjs';

/**
 * `focusChannel` 的判定部分：只回答「这条通道 + 这个时刻能不能定位」，
 * 不碰 DOM、不改状态。抽出来是为了能在 node 里单测守卫——未知通道不许猜。
 *
 * @param {string} chId 通道 id（`rotate` / `scaleX` / `warp.0.x` …）
 * @param {number} t 时刻（对象局部秒）
 * @returns {{ch: string, t: number}|null} 不认识的通道或非法时刻一律 null
 */
export function focusChannelTarget(chId, t) {
    if (!chById(chId)) return null;
    // `Number(null)` / `Number('')` 都是 0：不挡掉的话「没给时刻」会被静默当成 0 s，
    // 播放头莫名跳到开头，比什么都不做还难查。
    if (t === null || t === undefined || t === '') return null;
    const at = Number(t);
    if (!Number.isFinite(at)) return null;
    return { ch: chId, t: at };
}

export function mount(el, ctx) {
    const root = document.createElement('div');
    root.className = 'curve';

    /* ── 工具条：一行装完 —— 通道入口 + 缓动图标 + 一句状态 ── */
    const bar = document.createElement('div');
    bar.className = 'curve-bar';

    // 通道不再常驻 chip：动不动 17 个以上（3×3 网格就有 32 个顶点通道），
    // 一行塞不下只能裁掉，用户看到的是半截按钮。收进弹出面板后既完整又不占高度。
    const chBtn = document.createElement('button');
    chBtn.type = 'button';
    chBtn.className = 'curve-ch-btn';
    const chLabel = document.createElement('span');
    chLabel.className = 'curve-ch-label';
    chBtn.appendChild(chLabel);
    // 「已独立」角标：这条通道有了自己的轨道就不再跟随共用关键帧。少了这个标记，
    // 用户拖动时会以为「别的曲线没反应」是 bug。
    const chSolo = document.createElement('span');
    chSolo.className = 'curve-solo';
    chSolo.textContent = '⤴';
    chBtn.appendChild(chSolo);
    bar.appendChild(chBtn);

    /* ── 缓动预设：选中关键帧后一键换线型（比拖柄快得多）。图标化，语义留在 title 里 ── */
    const PRESETS = [
        ['linear', 'curve-line', '线', '线性', 'linear', null],
        ['in', 'curve-in', '入', '进入', 'bezier', [[0.42, 0], [1, 1]]],
        ['out', 'curve-out', '出', '退出', 'bezier', [[0, 0], [0.58, 1]]],
        ['inout', 'curve-both', '双', '双向', 'bezier', [[0.42, 0], [0.58, 1]]],
        ['back', 'curve-overshoot', '冲', '回弹', 'bezier', [[0.34, 1.56], [0.64, 1]]],
    ];
    const presets = document.createElement('div');
    presets.className = 'curve-presets';
    for (const [key, iconName, glyph, label, ease, hs] of PRESETS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'curve-preset ms-icon-label';
        b.dataset.preset = key;
        b.innerHTML = icon(iconName, { size: 'sm' }) + '<span>' + glyph + '</span>';
        b.title = ease === 'linear' ? label + '：选中关键帧 → 这一段改为线性'
            : label + '：选中关键帧 → 这一段改为贝塞尔「' + label + '」';
        b.addEventListener('click', (ev) => {
            ev.stopPropagation();
            applyPreset(ease, hs);
        });
        presets.appendChild(b);
    }
    // v5：自动切线 —— 按相邻关键帧的斜率生成平滑曲线（Catmull-Rom 风格）
    const autoBtn = document.createElement('button');
    autoBtn.type = 'button';
    autoBtn.className = 'curve-preset is-auto ms-icon-label';
    autoBtn.innerHTML = icon('curve-auto', { size: 'sm' }) + '<span>自</span>';
    autoBtn.title = '自由：自动切线 —— 按相邻关键帧的斜率自动摆平切线（再按一次回到手动，曲线可自由拖）';
    autoBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        applyAuto();
    });
    presets.appendChild(autoBtn);
    bar.appendChild(presets);

    const hint = document.createElement('span');
    hint.className = 'curve-hint';
    bar.appendChild(hint);

    /* ── 通道面板（浮层）：点一行切曲线，Shift+点一行叠参考线 ── */
    const pop = document.createElement('div');
    pop.className = 'curve-pop';
    pop.hidden = true;

    const wrap = document.createElement('div');
    wrap.className = 'curve-plot-wrap';

    const cv = document.createElement('canvas');
    cv.className = 'curve-plot';
    wrap.appendChild(cv);

    // 读数浮层改为与时间轴共用 editors/drag-tip.mjs（常驻 document.body，视口内夹取），
    // 这里不再自带 .curve-tip 节点。

    root.append(bar, pop, wrap);
    el.appendChild(root);

    /* ── 模块内状态 ── */
    let focus = 'x';          // 正在编辑的通道（Y 轴刻度与圆点只跟它走）
    const refs = new Set();   // 叠加成参考线的通道
    let vView = 1;            // 纵向缩放（滚轮 + Shift）
    let timeSpan = 0;         // 0 = 自动铺满总时长
    let timeOffset = 0;       // 横轴窗口起点（秒）。中键拖动可以平移，滚轮只改窗口宽度
    let selKeys = [];         // 多选：[{ layerId, chId, index, part }]
    let sel = null;           // primary（最后点中的那个），切线柄与提示条只跟它走

    /** 同一个曲线点（通道 + 下标 + 部位）。选择集与命中测试共用同一判等，避免两处口径漂移。 */
    const sameKey = (a, b) => !!a && !!b && a.layerId === b.layerId && a.chId === b.chId
        && a.index === b.index && a.part === b.part;

    /** 这个点现在是否已在选择集里（clickIntent 需要它来区分累加与移出）。 */
    function isSelKey(hit) {
        return !!hit && selKeys.some((s) => sameKey(s, hit));
    }

    /** 统一的选择入口：additive 为真时切换该点，否则独占。 */
    function setSel(hit, additive) {
        if (!hit) { selKeys = []; sel = null; return; }
        if (additive) {
            const at = selKeys.findIndex((s) => sameKey(s, hit));
            if (at >= 0) { selKeys.splice(at, 1); sel = selKeys[selKeys.length - 1] || null; return; }
        } else {
            selKeys = [];
        }
        selKeys.push(hit);
        sel = hit;
    }

    let drag = null;
    // 框选：无命中点时按下拖动拉一个矩形，把落在里面的关键帧一次选中
    let marquee = null;   // { x0, y0, x1, y1, additive, moved }
    let menu = null;
    let lastSig = '';

    /* ── 显示集 ── */
    /** 要画的通道：聚焦通道排第一（computeRange 拿第一个当 Y 轴刻度）。 */
    function shownNow() {
        const s = new Set();
        if (chById(focus)) s.add(focus);
        for (const id of refs) if (id !== focus && chById(id)) s.add(id);
        return s;
    }

    /** 命中/框选只认聚焦通道：参考线是给人看的，不承载编辑。 */
    const focusOnly = () => new Set(chById(focus) ? [focus] : []);

    function setFocus(id) {
        if (!chById(id) || id === focus) return;
        focus = id;
        refs.delete(id);
        // 选择属于「某个通道上的某个点」，换通道就清空：否则切线柄会画在看不见的曲线上
        setSel(null);
        syncPopRows();
        paint();
    }

    /**
     * 时间轴上点了一颗通道关键帧（外壳/时间轴派发的 `ms:channel-key-click`）：
     * 把焦点切到那条通道、播放头挪到该刻。未知通道不猜，直接返回 false。
     *
     * 通道键不在 `track.keys` 里，时间轴那边不参与选择也不参与拖动，
     * 所以「点了没反应」是这里之前唯一的结局——用户点它就是想看那条曲线。
     */
    function focusChannel(layerId, chId, t) {
        const tgt = focusChannelTarget(chId, t);
        if (!tgt) return false;
        // 曲线画的是「选中对象」的轨道：点的是别的对象的键，先把它选上，
        // 否则焦点切了、播放头也动了，画面还是那条曲线（看起来仍然像没反应）。
        if (layerId && typeof ctx.setSelection === 'function') {
            const cur = typeof ctx.selection === 'function' ? ctx.selection() : null;
            if (!cur || cur.id !== layerId) ctx.setSelection({ id: layerId });
        }
        setFocus(tgt.ch); // 已经在焦点上时它提前返回，下面补一次 paint
        if (typeof ctx.setTime === 'function') ctx.setTime(tgt.t);
        paint();
        return true;
    }

    function onChannelKeyClick(e) {
        const d = e && e.detail ? e.detail : null;
        if (!d || !el.isConnected) return;
        // 三个工作区各有一个曲线实例：只让当前可见的那个响应，
        // 否则隐藏面板会跟着把播放头抢过去。
        if (typeof wrap.clientWidth === 'number' && wrap.clientWidth <= 0) return;
        if (!focusChannel(d.layerId, d.ch, d.t)) return;
        const ch = chById(d.ch);
        const name = ch ? ch.short : String(d.ch || '通道');
        notify('已定位到通道关键帧 · ' + name + ' · ' + fmt2(d.t) + ' s' +
            (Number(d.count) > 1 ? '（该时刻有 ' + d.count + ' 个通道，已切到 ' + name + '）' : ''));
    }

    function toggleRef(id) {
        if (!chById(id) || id === focus) return;
        if (refs.has(id)) refs.delete(id);
        else refs.add(id);
        syncPopRows();
        paint();
    }

    /* ── 通道面板 ── */
    let popVals = new Map();

    function buildPop() {
        pop.textContent = '';
        popVals = new Map();
        const group = (title, list) => {
            if (!list.length) return;
            const h = document.createElement('div');
            h.className = 'curve-ch-group';
            h.textContent = title;
            pop.appendChild(h);
            for (const ch of list) pop.appendChild(chRow(ch));
        };
        group('变换', SCALAR_CHANNELS);
        group('网格顶点', warpChannels());
        syncPopRows();
        syncPopValues(trackOf(activeLayer(docOf())));
    }

    function chRow(ch) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'curve-ch-row';
        row.dataset.ch = ch.id;
        row.style.setProperty('--ch', ch.color);
        const name = document.createElement('span');
        name.className = 'curve-ch-name';
        name.textContent = ch.label;
        const solo = document.createElement('span');
        solo.className = 'curve-solo';
        solo.textContent = '⤴';
        const val = document.createElement('span');
        val.className = 'curve-ch-val';
        row.append(name, solo, val);
        popVals.set(ch.id, val);
        row.title = '点击：切到这条曲线 · Shift+点击：当作参考线叠加';
        row.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (ev.shiftKey) toggleRef(ch.id);
            else {
                setFocus(ch.id);
                closePop();
            }
        });
        return row;
    }

    function syncPopRows(track) {
        const trk = track || trackOf(activeLayer(docOf()));
        for (const row of pop.querySelectorAll('.curve-ch-row')) {
            const id = row.dataset.ch;
            const solo = isSolo(trk, id);
            row.classList.toggle('is-focus', id === focus);
            row.classList.toggle('is-ref', id !== focus && refs.has(id));
            row.classList.toggle('is-solo', solo);
            row.title = id === focus
                ? (solo ? '当前编辑的曲线 · 已独立：只动它自己' : '当前编辑的曲线')
                : (solo ? '已独立：有自己的关键帧时间 · 点击切到这条曲线' : '点击：切到这条曲线 · Shift+点击：当作参考线叠加');
        }
    }

    /** 面板里每行右侧的当前值：通道一多，光看名字对不上哪条线。 */
    function syncPopValues(track) {
        const st = stateAt(track, nowTime());
        for (const [id, node] of popVals) node.textContent = fmtVal(id, chValue(st, id));
    }

    function openPop() {
        buildPop();
        pop.hidden = false;
        chBtn.classList.add('is-on');
    }

    function closePop() {
        pop.hidden = true;
        chBtn.classList.remove('is-on');
    }

    chBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (pop.hidden) openPop();
        else closePop();
    });

    // 点别处收起面板。用捕获阶段：画布上的 pointerdown 会立刻改选中，面板得先让路
    const onDocDown = (ev) => {
        if (pop.hidden) return;
        if (pop.contains(ev.target) || chBtn.contains(ev.target)) return;
        closePop();
    };
    document.addEventListener('pointerdown', onDocDown, true);
    // 时间轴上那颗「通道关键帧」菱形点不动的时候，用户唯一的指望就是这里
    document.addEventListener('ms:channel-key-click', onChannelKeyClick);

    /* ── 取数 ── */
    const notify = (m) => {
        if (typeof ctx.notify === 'function') ctx.notify(m);
    };
    const docOf = () => (typeof ctx.doc === 'function' ? ctx.doc() : null);
    /**
     * 曲线横轴的零点与坐标全部是**对象局部时间**。
     * 关键帧的 t 本来就是局部时间（transform 用 ltime 求值），
     * 所以播放头也必须换算到局部时间，否则对象一旦加了时间通道，
     * 播放头与关键帧就用两套坐标，看起来完全对不上。
     */
    const localNow = (doc, layer) => {
        const g = typeof ctx.time === 'function' ? Number(ctx.time()) : 0;
        const t = Number.isFinite(g) ? g : 0;
        if (!layer || typeof ctx.objectLocalTime !== 'function') return t;
        const lt = ctx.objectLocalTime(layer.id, t);
        return Number.isFinite(lt) ? lt : t;
    };
    const nowTime = () => {
        const v = typeof ctx.time === 'function' ? Number(ctx.time()) : 0;
        return Number.isFinite(v) ? v : 0;
    };

    function activeLayer(doc) {
        const list = objectsOf(doc);
        if (!list.length) return null;
        const sel1 = typeof ctx.selection === 'function' ? ctx.selection() : null;
        const wanted = (sel1 && sel1.id) || (typeof ctx.activeLayerId === 'function' ? ctx.activeLayerId() : null);
        return list.find((l) => l.id === wanted) || list[0];
    }

    function trackOf(layer) {
        if (!layer) return { keys: [] };
        const trk = layer.transform;
        return trk && Array.isArray(trk.keys) ? trk : { keys: [] };
    }

    /** 该通道是否已有独立轨道（= 不再跟随共用关键帧）。 */
    function isSolo(track, chId) {
        return isChannelField(chId) && !!channelOf(track, chId);
    }

    /* ── 视口几何 ── */
    let geo = { x0: PAD_L, x1: 100, y0: PAD_T, y1: 100, t0: 0, t1: 1, vMin: -1, vMax: 1 };

    function paint() {
        const doc = docOf();
        const size = resizeCanvas(cv, wrap);
        const g = cv.getContext('2d');
        if (!g) return;
        beginFrame(g, size);

        const layer = activeLayer(doc);
        const track = trackOf(layer);

        // 网格维度跟着当前对象走：2×2 就有 9 个顶点通道，通道面板也要重建
        const curLat = normalizeLattice(stateAt(track, nowTime()).warp);
        const dimsChanged = ensureWarpChannels(curLat ? curLat.cols : 1, curLat ? curLat.rows : 1);
        if (dimsChanged) {
            // 网格缩回去后旧顶点通道不存在了：焦点与参考线都得摘掉，否则画的是幽灵
            for (const id of [...refs]) if (!chById(id)) refs.delete(id);
            if (!chById(focus)) focus = 'x';
            if (!pop.hidden) buildPop();
        }

        const shown = shownNow();
        geo = {
            x0: PAD_L, x1: Math.max(PAD_L + 40, size.w - PAD_R),
            y0: PAD_T, y1: Math.max(PAD_T + 24, size.h - PAD_B),
            t0: (() => {
                const total = totalSeconds(doc);
                const span = timeSpan > 0 ? timeSpan : total;
                // 窗口不许越界：起点夹在 [0, total - span]
                const maxOff = Math.max(0, total - span);
                timeOffset = Math.max(0, Math.min(maxOff, timeOffset));
                return timeOffset;
            })(),
            t1: (() => {
                const total = totalSeconds(doc);
                const span = timeSpan > 0 ? timeSpan : total;
                const maxOff = Math.max(0, total - span);
                timeOffset = Math.max(0, Math.min(maxOff, timeOffset));
                return timeOffset + span;
            })(),
            // 拖动期间冻结值域：否则被拖的点自己参与 min/max，整条曲线会随手指重新缩放
            ...computeRange(track, shown, vView, drag ? drag.frozen : null, { width: doc.width, height: doc.height }),
        };

        paintCanvas({
            g, geo, layer, track, shown, focus,
            // 聚焦通道的关键帧视图与「是否已独立」：圆点、切线柄、同刻线都跟着它走
            focusKeys: channelKeysOf(track, focus),
            focusSolo: isSolo(track, focus),
            sel, selKeys, marquee,
            now: localNow(doc, layer), total: totalSeconds(doc),
            describeLayerTime: ctx.describeLayerTime, objectLocalTime: ctx.objectLocalTime,
        });

        syncBar(track, layer);
    }

    /** 工具条只放最短信息，完整说明进 title。 */
    function syncBar(track, layer) {
        const ch = chById(focus);
        const keys = channelKeysOf(track, focus);
        const solo = isSolo(track, focus);
        chLabel.textContent = ch ? ch.short : '—';
        chBtn.style.setProperty('--ch', ch ? ch.color : 'var(--accent)');
        chBtn.classList.toggle('is-solo', solo);
        chBtn.title = (ch ? ch.label : '通道') +
            (solo ? ' · 已独立：有自己的关键帧时间，不再跟随共用关键帧' : '') +
            ' —— 点开切换曲线（Shift+点击列表项可叠加参考线）';

        if (!layer) {
            hint.textContent = '无对象';
            hint.title = '';
            return;
        }
        const easeName = keys.length > 1 ? EASE_LABEL[keys[Math.min(sel ? sel.index : 0, keys.length - 1)].ease] : '—';
        // 对象一旦有非恒等时间通道，横轴就是「它自己的时间」，必须标出来
        const td = typeof ctx.describeLayerTime === 'function' ? ctx.describeLayerTime(layer.id) : '无时间变换';
        const timeTag = td && td !== '无时间变换' ? ' · 对象时间' : '';
        const refTag = refs.size ? ' · 参考 ' + refs.size : '';
        hint.textContent = keys.length + ' 键 · ' + easeName + (solo ? ' · ⤴独立' : '') + refTag + timeTag;
        hint.title =
            (td && td !== '无时间变换' ? '横轴 = 该对象的局部时间（' + td + '）\n' : '') +
            '拖点改时间/数值 · 拖柄改曲线 · 右键改缓动 · 双击空白加点 · Delete 删点 · Shift 吸附纹理\n' +
            (solo
                ? '这条通道已独立（⤴）：只动它自己的关键帧，其余曲线不受影响。右键「回到共用关键帧」可撤销。'
                : '第一次单独拖这条曲线时，它会拷贝一份自己的关键帧（⤴ 独立），之后只影响它自己。');
        if (!pop.hidden) {
            syncPopRows(track);
            syncPopValues(track);
        }
    }

    /* ── 命中 ── */
    function localPoint(ev) {
        const r = cv.getBoundingClientRect();
        return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    }

    function keysNow() {
        const doc = docOf();
        const layer = activeLayer(doc);
        const track = trackOf(layer);
        // keys = 聚焦通道的关键帧视图（独立轨道优先），命中与索引都按它算
        return { doc, layer, track, keys: channelKeysOf(track, focus) };
    }

    function hitTest(px, py) {
        const { layer, track } = keysNow();
        if (!layer) return null;
        return geoHitTest(geo, track, layer.id, sel, focusOnly(), px, py);
    }

    /* ── 写入 ── */
    /** 缓动预设：作用于当前选中的关键帧（没选中就提示） */
    function applyPreset(ease, hs) {
        const doc = ctx.doc();
        if (!doc) return;
        const layer = layerById(doc, sel ? sel.layerId : (typeof ctx.activeLayer === 'function' ? ctx.activeLayer() : null));
        if (!layer) return;
        // 批量：同一对象上所有被选中的关键帧一起改缓动
        const idxs = selectionIndexes(selKeys, layer.id);
        if (!idxs.length) {
            hint.textContent = '先选点';
            return;
        }
        // 批量：同一对象上所有被选中的点一起改缓动。走哪套 API 由 writeModeOf 决定 ——
        // 已经是独立轨道才改通道键，否则改共用关键帧（别因为「点了缓动按钮」就把字段独立掉）
        const chId = sel ? sel.chId : focus;
        writeTrack(layer.id, (trk) => {
            const chMode = writeModeOf(trk, chId) === 'channel';
            return idxs.reduce((acc, i) => {
                if (!chMode) return hs ? setKeyEase(acc, i, ease, hs[0], hs[1]) : setKeyEase(acc, i, ease);
                return setChannelKeyEase(acc, chId, i, ease, hs ? hs[0] : undefined, hs ? hs[1] : undefined);
            }, trk);
        });
        hint.textContent = '缓动 ' + (ease === 'linear' ? '线性' : ease === 'hold' ? '保持' : '贝塞尔') + (idxs.length > 1 ? ' ×' + idxs.length : '');
    }

    /**
     * v5 自动切线：按相邻关键帧的斜率摆平该 key 的 h1/h2。
     * 没有手动拖过的 key 就能一键变「顺」，再按一次仍走自动（幂等）。
     */
    function applyAuto() {
        const doc = ctx.doc();
        if (!doc) return;
        const layer = layerById(doc, sel ? sel.layerId : (typeof ctx.activeLayer === 'function' ? ctx.activeLayer() : null));
        if (!layer) return;
        const idxs = selectionIndexes(selKeys, layer.id);
        if (!idxs.length) {
            hint.textContent = '先选点';
            return;
        }
        // 批量：逐个算切线（每次都基于最新轨道，避免后一个用到过期的邻居值）
        const chId = sel ? sel.chId : focus;
        let done = 0;
        for (const i of idxs) {
            const cur = layerById(docOf(), layer.id);
            const trk = (cur && cur.transform) || { keys: [] };
            if (writeModeOf(trk, chId) === 'channel') {
                // 已是独立轨道：切线只按这条通道自己的键算
                const tg = autoTangentsChannel(trk, chId, i);
                if (!tg) continue;
                writeTrack(layer.id, (t2) => setChannelKeyEase(t2, chId, i, 'bezier', tg.h1, tg.h2));
            } else {
                const tg = applyAutoTangents(trk, i);
                if (!tg) continue;
                writeTrack(layer.id, (t2) => setKeyEase(t2, i, 'bezier', tg.h1, tg.h2));
            }
            done += 1;
        }
        hint.textContent = '自动切线 ×' + done;
    }

    function writeTrack(layerId, mut) {
        const doc = docOf();
        if (!doc) return;
        const layer = layerById(doc, layerId);
        if (!layer) return;
        const trk = trackOf(layer);
        const next = mut(trk, layer);
        if (!next || next === trk) return;
        const patched = patchLayer(doc, layerId, { transform: next });
        if (patched === doc) return;
        if (typeof ctx.setDoc === 'function') ctx.setDoc(patched);
        if (typeof ctx.requestRender === 'function') ctx.requestRender();
    }

    /**
     * 曲线里的吸附必须与时间轴**同一套判据**（`magnetOf` + `snapForDrag`）：
     * 磁铁开 = 吸整帧、Shift = 关磁铁（可落在两帧之间）；磁铁关 = 自由、Shift = 吸 0.1s 网格。
     *
     * 以前这里自己写「无条件吸帧、Shift 吸纹理」，于是同一个关键帧在两个面板里
     * 拖到同一像素位置会落到不同时刻 —— 那才是「时间轴和曲线不同步」的真身。
     */
    function snapTime(t, ev) {
        const doc = docOf();
        if (!doc) return t;
        return snapForDrag(doc, t, ev, snapOnNow());
    }

    /* ── 指针交互 ── */
    cv.addEventListener('pointerdown', (ev) => {
        if (ev.button === 2) return;
        const { x, y } = localPoint(ev);
        const hit = hitTest(x, y);
        if (!hit) {
            // 空白处按下先起框；没拖动就松手 = 点空白（移播放头 + 清选中）
            // 框选追加：Shift 或 Ctrl/Cmd 拖都是「加进来」而不是「换成这批」（与时间轴一致）
            const additive = !!(ev.shiftKey || ev.ctrlKey || ev.metaKey);
            marquee = { x0: x, y0: y, x1: x, y1: y, additive, moved: false };
            // 新起一次框选：不是叠加模式就先把旧选择清掉（否则框了个空的反而留着上一次的点）
            if (!additive) setSel(null);
            try {
                cv.setPointerCapture(ev.pointerId);
            } catch (err) {
                /* 合成事件里 pointerId 可能无效 */
            }
            paint();
            return;
        }
        ev.preventDefault();
        // 与时间轴同一套语义（core/selection.mjs 的 clickIntent）：
        //   单击=只选它 / Shift 或 Ctrl+点=累加，再点移出 / Shift+Alt+点=连选
        // 曲线的「连选」没有线性顺序（一个通道一条曲线，跨通道怎么连没有公认答案），
        // 所以 range 在这里退化成独占 —— 时间轴那边的连选是真连选，别把两边当同一件事。
        const intent = clickIntent({
            shiftKey: ev.shiftKey, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, altKey: ev.altKey, button: ev.button,
        }, isSelKey(hit));
        if (intent === 'ignore') return;
        if (intent === 'add' || intent === 'remove') setSel(hit, true);
        else if (intent === 'promote') sel = hit; // 已在集合里：只挪主选中，不动集合
        else setSel(hit, false);
        const { layer, keys } = keysNow();
        // 拖动期间的值域 = 按下这一刻屏幕上的值域（drag.frozen 交给 computeRange 复用）
        const frozen = { vMin: geo.vMin, vMax: geo.vMax, ranges: geo.ranges };
        if (hit.part === 'key') {
            drag = {
                kind: 'key', layerId: layer.id, index: hit.index, chId: hit.chId,
                t0: keys[hit.index].t, x0: x, y0: y, v0: keys[hit.index].value,
                // warp 通道的 patch 要拼完整 warp 对象；base 必须定格在拖动开始那一刻，
                // 否则每次 move 拿实时 state 当 base 会把别的角一起改写（独立轨道没有 state，置 null）
                baseState: keys[hit.index].state,
                frozen,
            };
        } else {
            const k0 = keys[hit.index];
            const k1 = keys[hit.index + 1];
            drag = {
                kind: hit.part, layerId: layer.id, index: hit.index, chId: hit.chId, x0: x, y0: y,
                h: hit.part === 'h1' ? k0.h1.slice() : k0.h2.slice(),
                span: { t0: k0.t, t1: k1.t, v0: k0.value, v1: k1.value },
                frozen,
            };
        }
        // 合成事件（测试脚本）里 pointerId 可能无效，捕获失败不该中断交互
        try {
            cv.setPointerCapture(ev.pointerId);
        } catch (err) {
            /* ignore */
        }
        paint();
    });

    cv.addEventListener('pointermove', (ev) => {
        // 松手丢了 pointerup（capture 失效 / 合成事件）时不至于永远卡在拖拽态：
        // 鼠标键已抬起的 pointermove 一律视为拖拽结束
        if (drag && ev.buttons === 0) drag = null;
        if (marquee && ev.buttons === 0) marquee = null;
        const { x, y } = localPoint(ev);
        if (marquee) {
            marquee.x1 = x;
            marquee.y1 = y;
            if (Math.abs(x - marquee.x0) > 3 || Math.abs(y - marquee.y0) > 3) marquee.moved = true;
            cv.style.cursor = 'crosshair';
            paint();
            return;
        }
        if (!drag) {
            const hit = hitTest(x, y);
            cv.style.cursor = hit ? 'grab' : 'crosshair';
            if (hit) {
                const { keys } = keysNow();
                const k = keys[hit.index];
                // 读数浮层与时间轴共用一份实现（editors/drag-tip.mjs），不再自带 .curve-tip
                showTip({
                    x: ev.clientX + 14,
                    y: ev.clientY + 18,
                    text: 't = ' + fmt2(k.t) + ' s · ' + EASE_LABEL[k.ease] + (k.ease === 'bezier' ? ' · h1[' + fmt2(k.h1[0]) + ', ' + fmt2(k.h1[1]) + '] h2[' + fmt2(k.h2[0]) + ', ' + fmt2(k.h2[1]) + ']' : ''),
                });
            } else {
                hideTip();
            }
            return;
        }
        cv.style.cursor = 'grabbing';
        if (drag.kind === 'key') {
            const t = snapTime(xToT(geo, x), ev);
            const v = yToV(geo, y, drag.chId);
            // 目标时刻已经有别的关键帧：在**写之前**就挡掉（与时间轴同一条规矩）。
            // 早先的做法是在 updater 里 return 原轨道，那会白白记一条撤销、还报「关键帧已更新」。
            const cur = keysNow().track;
            if (cur && occupiedAt(cur, drag.chId, t, drag.index)) {
                if (!drag.blockedNotified) {
                    drag.blockedNotified = true;
                    notify('这个时刻已经有关键帧了：换一帧再拖，或先把那一颗删掉');
                }
                return;
            }
            writeTrack(drag.layerId, (trk) => {
                // 只有该字段**已经**是独立轨道时才写通道轨；否则挪的就是时间轴上那颗共用菱形
                // （整组一起搬，两个视图永远看同一套时刻）。绝不因为「拖了一下」就顺手提升。
                const r = writeModeOf(trk, drag.chId) === 'channel'
                    ? dragChannelKeyTo(trk, drag.chId, drag.index, t, v)
                    : dragKeyTo(trk, drag.index, t, drag.chId, v, drag.baseState);
                if (r.index >= 0) {
                    drag.index = r.index;
                    sel = { layerId: drag.layerId, chId: drag.chId, index: r.index, part: 'key' };
                }
                return r.track;
            });
        } else {
            const t = xToT(geo, x);
            const v = yToV(geo, y, drag.chId);
            writeTrack(drag.layerId, (trk) => {
                // 手柄同理：共用键的手柄改的是共用键自己的缓动，不该把字段提升成独立轨道
                return writeModeOf(trk, drag.chId) === 'channel'
                    ? dragChannelHandleTo(trk, drag.chId, drag.index, drag.kind, drag.h, drag.span, t, v)
                    : dragHandleTo(trk, drag.index, drag.kind, drag.h, drag.span, t, v);
            });
        }
        paint();
    });

    /** 把矩形里的关键帧收进选择集：当前对象 × 聚焦通道 × 每个 key。 */
    function commitMarquee() {
        const m = marquee;
        marquee = null;
        if (!m) return;
        const { layer, track } = keysNow();
        if (!layer) {
            paint();
            return;
        }
        if (!m.moved) {
            // 没拖动 = 点空白：移播放头并清空选择
            if (typeof ctx.setTime === 'function') ctx.setTime(xToT(geo, m.x0));
            setSel(null);
            paint();
            return;
        }
        const x0 = Math.min(m.x0, m.x1);
        const x1 = Math.max(m.x0, m.x1);
        const y0 = Math.min(m.y0, m.y1);
        const y1 = Math.max(m.y0, m.y1);
        const picked = pickInRect(geo, track, layer.id, focusOnly(), x0, x1, y0, y1);
        if (!m.additive) selKeys = [];
        for (const hit of picked) {
            const dup = selKeys.some((s) => s.layerId === hit.layerId && s.chId === hit.chId && s.index === hit.index && s.part === hit.part);
            if (!dup && selKeys.length < 2000) selKeys.push(hit);
        }
        sel = selKeys[selKeys.length - 1] || null;
        if (picked.length) notify('框选 ' + picked.length + ' 颗关键帧');
        paint();
    }

    function endDrag(ev) {
        if (marquee) {
            commitMarquee();
            try {
                if (ev && cv.hasPointerCapture && cv.hasPointerCapture(ev.pointerId)) cv.releasePointerCapture(ev.pointerId);
            } catch (err) {
                /* ignore */
            }
            return;
        }
        if (!drag) return;
        drag = null;
        cv.style.cursor = 'crosshair';
        try {
            if (ev && cv.hasPointerCapture && cv.hasPointerCapture(ev.pointerId)) cv.releasePointerCapture(ev.pointerId);
        } catch (err) {
            /* ignore */
        }
        notify('关键帧已更新');
        paint();
    }
    cv.addEventListener('pointerup', endDrag);
    cv.addEventListener('pointercancel', endDrag);
    // capture 丢事件时（切窗口 / 合成事件）window 兜底，避免拖拽态永久卡住
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    /* ── 双击空白：在该时间加关键帧 ── */
    cv.addEventListener('dblclick', (ev) => {
        const { x } = localPoint(ev);
        const hit = hitTest(x, localPoint(ev).y);
        if (hit) return;
        const { doc, layer, track } = keysNow();
        if (!doc || !layer) return;
        // 双击落点同样过磁铁：曲线里新建的关键帧就是时间轴里的那一帧
        const t = snapTime(xToT(geo, x), ev);
        // 没独立就用共用关键帧加点（＝时间轴双击泳道做的同一件事）；已独立才写通道轨
        if (writeModeOf(track, focus) === 'channel') {
            // 省略 value = 取该时刻当前求值，所以加点不会让曲线跳一下
            writeTrack(layer.id, (old) => setChannelKey(old, focus, t, undefined, 'bezier'));
        } else {
            writeTrack(layer.id, (old) => addKey(old, t, stateAt(track, t), 'bezier'));
        }
        if (typeof ctx.setTime === 'function') ctx.setTime(t);
        const after = layerById(docOf(), layer.id);
        const solo = isSolo(trackOf(after), focus);
        notify('已添加关键帧 t = ' + fmt2(t) + ' s' + (solo && chById(focus) ? ' · ' + chById(focus).short + ' 已独立' : ''));
        paint();
    });

    /* ── 右键：缓动 + 删除 + 回到共用 ── */
    cv.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        closeMenu();
        const { x, y } = localPoint(ev);
        const hit = hitTest(x, y);
        const { layer, track, keys } = keysNow();
        if (!layer) return;
        const solo = isSolo(track, focus);
        // 空白处也允许弹菜单：通道一旦独立，「回到共用」就必须随手可得，
        // 否则用户只能靠删光关键帧来撤销（而删掉最后一个通道键时 core 会静默回到共用）
        if (!hit && !solo) return;
        if (hit) {
            const same = (s) => s.layerId === hit.layerId && s.chId === hit.chId && s.index === hit.index && s.part === hit.part;
            if (!selKeys.some(same)) setSel(hit, false);
            else sel = hit;
            paint();
        }
        const m = document.createElement('div');
        m.className = 'curve-menu';
        if (hit) {
            for (const ease of ['linear', 'bezier', 'hold']) {
                const b = document.createElement('button');
                b.type = 'button';
                b.textContent = EASE_LABEL[ease];
                if (keys[hit.index] && keys[hit.index].ease === ease) b.classList.add('is-on');
                b.addEventListener('click', () => {
                    const chId = hit.chId;
                    writeTrack(layer.id, (trk) => (writeModeOf(trk, chId) === 'channel'
                        ? setChannelKeyEase(trk, chId, hit.index, ease)
                        : setKeyEase(trk, hit.index, ease)));
                    notify('缓动改为' + EASE_LABEL[ease]);
                    closeMenu();
                    paint();
                });
                m.appendChild(b);
            }
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'is-danger';
            del.textContent = '删除关键帧';
            del.addEventListener('click', () => {
                // 右键的删除也走批量：点中的点若在选区里，就删整个选区
                const same = (s) => s.layerId === hit.layerId && s.chId === hit.chId && s.index === hit.index && s.part === hit.part;
                const idxs = selKeys.some(same) ? selectionIndexes(selKeys, layer.id) : [hit.index];
                closeMenu();
                removeKeysOn(layer.id, hit.chId, idxs);
            });
            m.appendChild(del);
        }
        if (solo) m.appendChild(soloItem(layer.id, focus));
        m.style.left = Math.round(x) + 'px';
        m.style.top = Math.round(y) + 'px';
        wrap.appendChild(m);
        menu = m;
    });

    /** 批量删点：已有独立轨道就走它自己的键，否则删的是共用关键帧（＝时间轴上那颗菱形）。 */
    function removeKeysOn(layerId, chId, idxs) {
        const list = idxs.slice().sort((a, b) => b - a);
        if (!list.length) return;
        writeTrack(layerId, (trk) => {
            if (writeModeOf(trk, chId) === 'channel') {
                return list.reduce((acc, i) => removeChannelKey(acc, chId, i), trk);
            }
            return list.reduce((acc, i) => removeKey(acc, i), trk);
        });
        setSel(null);
        notify('已删除 ' + list.length + ' 颗关键帧');
    }

    /** 菜单项「回到共用」：删掉该通道的独立轨道。 */
    function soloItem(layerId, chId) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'is-solo-back';
        b.textContent = '⤴ 回到共用关键帧';
        b.title = '删掉这条通道自己的轨道，重新跟随共用关键帧（数值会立刻变回共用求值）';
        b.addEventListener('click', () => {
            closeMenu();
            backToShared(layerId, chId);
        });
        return b;
    }

    function backToShared(layerId, chId) {
        const layer = layerById(docOf(), layerId);
        if (!layer || !isSolo(trackOf(layer), chId)) return;
        writeTrack(layerId, (trk) => clearChannel(trk, chId));
        // 选择集里的索引属于刚被删掉的通道轨道，必须一起作废
        setSel(null);
        const ch = chById(chId);
        notify((ch ? ch.label : chId) + ' 已回到共用关键帧');
        paint();
    }

    function closeMenu() {
        if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
        menu = null;
    }

    /* ── 横轴平移：中键（或 Alt+左键）拖动 = 移动时间窗口 ── */
    let pan = null;
    cv.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 1 && !(ev.altKey && ev.button === 0)) return;
        ev.preventDefault();
        ev.stopPropagation();
        const total = totalSeconds(docOf());
        const span = geo ? geo.t1 - geo.t0 : total;
        pan = { x: ev.clientX, t0: geo ? geo.t0 : 0, span: span, total: total, width: Math.max(1, cv.clientWidth) };
        try { cv.setPointerCapture(ev.pointerId); } catch (err) { /* 忽略 */ }
    });
    window.addEventListener('pointermove', (ev) => {
        if (!pan) return;
        const perPx = pan.span / Math.max(1, pan.width - PAD_L - PAD_R);
        const maxOff = Math.max(0, pan.total - pan.span);
        // 往右拖 = 看更早的时间
        timeSpan = pan.span;
        timeOffset = Math.max(0, Math.min(maxOff, pan.t0 - (ev.clientX - pan.x) * perPx));
        paint();
    });
    window.addEventListener('pointerup', () => { pan = null; });

    /* ── 滚轮：横向缩放时间 / Shift 纵向缩放值域 ── */
    cv.addEventListener(
        'wheel',
        (ev) => {
            ev.preventDefault();
            const doc = docOf();
            const total = totalSeconds(doc);
            if (ev.shiftKey) {
                vView = clamp(vView * (ev.deltaY > 0 ? 1.15 : 1 / 1.15), 0.05, 20);
            } else if (ev.ctrlKey || ev.metaKey) {
                timeSpan = clamp((timeSpan > 0 ? timeSpan : total) * (ev.deltaY > 0 ? 1.2 : 1 / 1.2), 0.05, total);
            } else {
                const t0 = geo.t1 - geo.t0;
                timeSpan = clamp(t0 * (ev.deltaY > 0 ? 1.2 : 1 / 1.2), 0.05, total);
            }
            paint();
        },
        { passive: false }
    );

    /* ── 键盘 ── */
    function onKey(ev) {
        if (root.offsetParent === null) return;
        const tag = ev.target && ev.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        // Ctrl+A：把聚焦通道上所有关键帧一次选中（配合批量缓动 / 批量删除）
        if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'a' || ev.key === 'A')) {
            const { layer, keys } = keysNow();
            if (!layer || !keys.length) return;
            ev.preventDefault();
            const ch = chById(focus);
            if (!ch) return;
            selKeys = [];
            for (let i = 0; i < keys.length; i += 1) selKeys.push({ layerId: layer.id, chId: ch.id, index: i, part: 'key' });
            sel = selKeys[selKeys.length - 1] || null;
            // 报数只由时间轴负责（同屏时两边都响应 Ctrl+A，各报一条会盖成两条）
            paint();
            return;
        }
        if (ev.key === 'Delete' && selKeys.length) {
            ev.preventDefault();
            const { layer } = keysNow();
            if (!layer) return;
            // 选区只可能落在聚焦通道上（参考线只读），所以统一交给 removeKeysOn 按通道分派
            const chId = sel ? sel.chId : focus;
            const idxs = selectionIndexes(selKeys, layer.id);
            if (!idxs.length) return;
            removeKeysOn(layer.id, chId, idxs);
            paint();
            return;
        }
        // Alt+A：取消全部（与上面的 Ctrl+A 全选成对，Blender 同款）
        if (ev.altKey && !ev.ctrlKey && !ev.metaKey && (ev.key === 'a' || ev.key === 'A')) {
            ev.preventDefault();
            setSel(null);
            paint();
            return;
        }
        // Ctrl+I：反选 —— 聚焦通道上「还没被选中」的关键帧全部选上
        if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'i' || ev.key === 'I')) {
            const { layer, keys } = keysNow();
            const ch = chById(focus);
            if (!layer || !ch || !keys.length) return;
            ev.preventDefault();
            const next = [];
            for (let i = 0; i < keys.length; i += 1) {
                const hit = { layerId: layer.id, chId: ch.id, index: i, part: 'key' };
                if (!isSelKey(hit)) next.push(hit);
            }
            selKeys = next;
            sel = next[next.length - 1] || null;
            // 同上：选择集照改，报数交给时间轴（它读的是全片关键帧，文案统一用「颗」）
            paint();
            return;
        }
        if (ev.key === 'Escape') {
            setSel(null);
            closeMenu();
            closePop();
            paint();
        }
    }
    document.addEventListener('keydown', onKey);

    /* ── 订阅 ── */
    let unsub = null;
    if (typeof ctx.subscribeDoc === 'function') {
        unsub = ctx.subscribeDoc(() => {
            const doc = docOf();
            const layer = activeLayer(doc);
            const sig = (layer ? layer.id : 'none') + '|' + celTimes(layer).length + '|' + focus + '|' + [...refs].join(',');
            if (sig !== lastSig) {
                lastSig = sig;
                setSel(null);
            }
            paint();
        });
    }

    /**
     * 对象一旦有了非零 warp，就在通道按钮上挂个点。
     * 通道收进弹出面板后，没有这个提示用户不会知道网格顶点也有曲线可看。
     */
    function autoRevealWarp() {
        const { layer } = keysNow();
        let has = false;
        for (const k of trackOf(layer).keys || []) {
            const lat = normalizeLattice(k.state && k.state.warp);
            if (!lat) continue;
            if (!latticeIsZero(lat) || lat.cols > 1 || lat.rows > 1) {
                has = true;
                break;
            }
        }
        chBtn.classList.toggle('has-warp', has);
    }

    const ro = new ResizeObserver(() => paint());
    ro.observe(wrap);

    autoRevealWarp();
    paint();

    return {
        destroy() {
            document.removeEventListener('keydown', onKey);
            document.removeEventListener('pointerdown', onDocDown, true);
            document.removeEventListener('ms:channel-key-click', onChannelKeyClick);
            ro.disconnect();
            if (typeof unsub === 'function') unsub();
            closeMenu();
            closePop();
        },
        refresh() {
            autoRevealWarp();
            paint();
        },
        focusFrame() {
            paint();
        },
        // 时间轴点通道关键帧时外壳/时间轴派 ms:channel-key-click，本模块自己接住；
        // 这个导出给测试与将来的「从别处定位某通道」用。
        focusChannel,
    };
}
