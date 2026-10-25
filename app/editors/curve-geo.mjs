// 曲线编辑器的几何与通道模型：坐标换算、逐通道值域、通道定义表。
//
// 这一层是**纯函数 + 常量**，零 DOM、零 ctx：可以在 Node 里直接 import 做单元测试。
// 所有依赖外部状态的函数都把状态（geo / shown / vView）收成显式参数，
// 保证「同样的输入 → 同样的输出」，不会因为闭包里的模块变量漂移。
//
// 数据模型有两条：共用 `track.keys`（一个关键帧携带全部通道）与
// `track.channels[field]`（单通道自己的关键帧）。这里的取数一律**通道优先**，
// 统一收成 `channelKeysOf()` 一种形状 —— 绘制、命中、拖动就不用各记一套索引规则。

import { normalizeLattice, createLattice } from '../core/lattice.mjs';
import { T_EPS } from './timeline-geo.mjs';
import { docDuration } from '../core/cel.mjs';
import {
    moveKey, setKeyState, setKeyEase, autoTangents as coreAutoTangents,
    TRACK_FIELDS, channelOf, promoteChannel, setChannelKey, setChannelKeyEase, moveChannelKey,
} from '../core/transform.mjs';

export const PAD_L = 46;
// 右侧留出 28px：每条显示中的曲线要在那里标自己的当前数值（各通道量纲不同，光靠 Y 轴读不出参考线）
export const PAD_R = 28;
export const PAD_T = 12;
export const PAD_B = 16;
export const KEY_R = 4.5;
export const HIT_PX = 8;
export const SAMPLES = 360;

const CORNERS = ['tl', 'tr', 'br', 'bl'];
const CORNER_LABEL = { tl: '左上', tr: '右上', br: '右下', bl: '左下' };

/** 标量通道（固定 8 条）：id / 标签 / 短名 / 颜色 / 从 state 取值。 */
export const SCALAR_CHANNELS = [
    { id: 'x', label: '位置 X', short: 'X', color: '#e0556b', get: (s) => s.x },
    { id: 'y', label: '位置 Y', short: 'Y', color: '#59a86a', get: (s) => s.y },
    { id: 'scaleX', label: '缩放 X', short: 'SX', color: '#4a7dff', get: (s) => s.scaleX },
    { id: 'scaleY', label: '缩放 Y', short: 'SY', color: '#8a6ce0', get: (s) => s.scaleY },
    { id: 'rotate', label: '旋转', short: 'R', color: '#d08a3a', get: (s) => s.rotate },
    { id: 'skewX', label: '斜切 X', short: 'KX', color: '#3aa8a0', get: (s) => s.skewX },
    { id: 'skewY', label: '斜切 Y', short: 'KY', color: '#a0559a', get: (s) => s.skewY },
    { id: 'opacity', label: '不透明度', short: 'A', color: '#9aa1ac', get: (s) => s.opacity },
];

/**
 * 网格顶点通道：随当前对象的网格维度动态生成。
 * id 形如 `warp.<顶点序号>.<0|x|1|y>`，序号行优先 index = row*(cols+1)+col。
 */
export function buildWarpChannels(cols, rows) {
    const out = [];
    const stride = cols + 1;
    for (let r = 0; r <= rows; r++) {
        for (let c = 0; c <= cols; c++) {
            const idx = r * stride + c;
            const isCorner = (r === 0 || r === rows) && (c === 0 || c === cols);
            for (const axis of ['x', 'y']) {
                out.push({
                    id: 'warp.' + idx + '.' + axis,
                    label: '网格 ' + c + ',' + r + ' ' + axis.toUpperCase() + (isCorner ? '（角）' : ''),
                    short: c + ',' + r + axis,
                    color: axis === 'x' ? '#5b8ad6' : '#6fa87a',
                    get: (s) => {
                        const lat = normalizeLattice(s.warp);
                        const p = lat && lat.pts[idx];
                        return p ? p[axis === 'x' ? 0 : 1] : 0;
                    },
                });
            }
        }
    }
    return out;
}

let warpChs = buildWarpChannels(1, 1);
let warpDimKey = '1:1';

/** 当前网格顶点通道表（随网格尺寸变化而重建）。 */
export function warpChannels() {
    return warpChs;
}

/** 网格尺寸变了就重建通道表；返回是否变了 */
export function ensureWarpChannels(cols, rows) {
    const k = Math.max(1, cols | 0) + ':' + Math.max(1, rows | 0);
    if (k === warpDimKey) return false;
    warpDimKey = k;
    warpChs = buildWarpChannels(Math.max(1, cols | 0), Math.max(1, rows | 0));
    return true;
}

export function allChannels() {
    return SCALAR_CHANNELS.concat(warpChs);
}

export function chById(id) {
    for (const c of SCALAR_CHANNELS) if (c.id === id) return c;
    for (const c of warpChs) if (c.id === id) return c;
    return null;
}

export const EASE_LABEL = { linear: '线性', bezier: '贝塞尔', hold: '保持' };

export function chValue(state, chId) {
    const ch = chById(chId);
    return ch ? ch.get(state) : 0;
}

/**
 * 把一个通道值转成 setKeyState 能吃的 patch。
 * 标量通道直接 {x: 120}；warp 通道必须拼出完整 warp 对象 —— setKeyState 只认
 * TRACK_FIELDS 与 'warp' 整体，`{ 'warp.<i>.x': 12 }` 会被静默丢弃。
 * warp 现在存的是网格，写回去要保留 cols/rows 与所有顶点。
 */
export function statePatch(chId, v, prev) {
    if (!chId.startsWith('warp.')) return { [chId]: v };
    const parts = chId.split('.');
    const i = Number(parts[1]);
    const axis = parts[2];
    const lat = normalizeLattice(prev && prev.warp) || createLattice(1, 1);
    const pts = lat.pts.map((p) => [p[0], p[1]]);
    if (Number.isInteger(i) && pts[i]) pts[i][axis === 'x' ? 0 : 1] = v;
    return { warp: { cols: lat.cols, rows: lat.rows, pts } };
}

/* ── 通道关键帧视图（通道优先，统一形状） ── */

/**
 * warp 顶点通道没有独立轨道：TRACK_FIELDS 里没有它们，core 的 setChannelKey 会直接抛 TypeError。
 * 写盘前必须先分流，否则拖一个网格顶点就把编辑器打崩。
 */
export function isChannelField(chId) {
    return TRACK_FIELDS.includes(chId);
}

/**
 * 某通道此刻真正参与绘制的关键帧：有独立轨道就用它自己的键，否则回退到共用键的该通道分量。
 * 统一成 `{ t, ease, h1, h2, value, state }` 一种形状 —— 两种数据模型各写一套索引逻辑，
 * 迟早会在「第几个点」上对不齐（而 sel.index 只有一份）。
 * `state` 只为 warp 保留：写顶点要整份 state 兜底；独立轨道的键没有这个概念，置 null。
 */
export function channelKeysOf(track, chId) {
    if (isChannelField(chId)) {
        const ch = channelOf(track, chId);
        if (ch) {
            return ch.keys.map((k) => ({ t: k.t, ease: k.ease, h1: k.h1, h2: k.h2, value: Number(k.value), state: null }));
        }
    }
    return ((track && track.keys) || []).map((k) => ({
        t: k.t, ease: k.ease, h1: k.h1, h2: k.h2, value: chValue(k.state, chId), state: k.state,
    }));
}

/**
 * 写盘前提升：没有 channels[field] 时先由共用关键帧拷贝出一份独立轨道，
 * 否则通道 API 全是空操作（channelOf 返回 null，setChannelKey 什么都不改）。
 * 只对 focus 通道调用 —— 参考线是只读的，替别的通道提升等于偷偷改数据。
 */
export function ensureChannel(track, chId) {
    if (!isChannelField(chId)) return track;
    return channelOf(track, chId) ? track : promoteChannel(track, chId);
}

/**
 * 这一刻该怎么写：`'channel'` = 该字段已有独立轨道，`'shared'` = 还没独立。
 *
 * 曲线的**所有编辑**都必须先问这一句。以前拖动/改缓动/删除都无条件 `ensureChannel`，
 * 结果只是「拖了一个点」就把该字段悄悄提升成独立轨道 —— 共用关键帧还在原位，两个视图
 * 从此各拿一套时刻，用户看到的就是「时间轴和曲线不同步」。提升必须是显式动作
 * （双击加点、右键「提升为通道轨」），拖动不该顺手改数据模型。
 */
export function writeModeOf(track, chId) {
    if (!isChannelField(chId)) return 'shared';
    return channelOf(track, chId) ? 'channel' : 'shared';
}

/**
 * 目标时刻是否已经被**别的**关键帧占着（`skipIndex` 是被拖的那一颗）。
 *
 * 时间轴那边遇到同刻冲突是「显式跳过并回报数量」；曲线以前没有这道闸，`moveKey` 会把
 * 两颗键静默合并成一颗 —— 用户只是把点挪了一下，另一个点就没了，画面上还看不出来。
 */
export function occupiedAt(track, chId, t, skipIndex = -1) {
    const keys = channelKeysOf(track, chId);
    const v = Number(t);
    if (!Number.isFinite(v)) return false;
    return keys.some((k, i) => i !== skipIndex && Math.abs(Number(k.t) - v) <= T_EPS);
}

export function clamp(n, lo, hi) {
    return n < lo ? lo : n > hi ? hi : n;
}

export function fmt2(n) {
    return (Number.isFinite(n) ? n : 0).toFixed(2);
}

/**
 * 右栏读数 / 通道面板里的紧凑数值写法。
 * 同屏可能有像素、角度、比例三种量纲，小数位与单位必须按通道定，否则 640 和 1 长得一样。
 */
export function fmtVal(chId, v) {
    const n = Number.isFinite(v) ? v : 0;
    if (chId === 'opacity' || chId === 'scaleX' || chId === 'scaleY') return n.toFixed(2);
    if (chId === 'rotate' || chId === 'skewX' || chId === 'skewY') {
        return (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(1)) + '°';
    }
    return n.toFixed(0);   // x / y / warp 顶点位移都是像素
}

// 总时长（秒）：纯时间模型下由 docDuration 直接给出（含内容兜底）
export function totalSeconds(doc) {
    const total = docDuration(doc);
    return total > 0 ? total : 1;
}

/* ── 坐标换算（横轴 = 时间，纵轴 = 通道值） ── */

export function tToX(geo, t) {
    const span = geo.t1 - geo.t0 || 1;
    return geo.x0 + ((t - geo.t0) / span) * (geo.x1 - geo.x0);
}

export function xToT(geo, x) {
    const w = geo.x1 - geo.x0 || 1;
    return geo.t0 + clamp((x - geo.x0) / w, 0, 1) * (geo.t1 - geo.t0);
}

/** 某通道自己的值域；没算过就退回主通道（保证恒有值域）。 */
export function rangeOf(geo, chId) {
    return (chId && geo.ranges && geo.ranges.get(chId)) || { vMin: geo.vMin, vMax: geo.vMax };
}

export function vToY(geo, v, chId) {
    const r = rangeOf(geo, chId);
    const span = r.vMax - r.vMin || 1;
    return geo.y1 - ((v - r.vMin) / span) * (geo.y1 - geo.y0);
}

export function yToV(geo, y, chId) {
    const r = rangeOf(geo, chId);
    const h = geo.y1 - geo.y0 || 1;
    return r.vMin + clamp((geo.y1 - y) / h, -0.5, 1.5) * (r.vMax - r.vMin);
}

/**
 * 值域：**每个通道各算一份**。
 *
 * 之前是「所有显示通道共用一个值域」，后果是 X 的 0–640 与不透明度的 0–1 同屏时，
 * 后者被压成一条贴着底边的直线，等于看不见。逐通道归一化后每条曲线都用自己的刻度铺满高度。
 * 主通道（shown 的第一个 = 聚焦通道）额外作为 Y 轴刻度与 yToV 的缺省依据。
 *
 * frozen：拖动期间传上一帧的结果就把值域钉住。否则被拖的那个点自己参与 min/max 计算，
 * 它一动整条曲线的刻度就跟着重算 —— 没被拖的点也会在屏幕上跳几十像素，手感像是「曲线在飞」。
 */
/**
 * 通道的「合理值域」预设。曲线纵轴默认跟着数据 min/max 走，于是旋转 0°→10° 会被拉成满屏，
 * 而 ±180 才是有意义的读法。这里给每个通道一个语义区间：
 *  - rotate / skewX / skewY：-180..180（度）
 *  - opacity：0..1
 *  - scaleX / scaleY：0..2
 *  - x / y：0..画布边长（没给就退到 ±数据）
 * 数据超出预设时仍以数据为准（否则曲线会画到框外）。
 */
export function channelRange(chId, opts) {
    const o = opts || {};
    const id = String(chId || '');
    if (id === 'rotate' || id === 'skewX' || id === 'skewY') return { lo: -180, hi: 180 };
    if (id === 'opacity') return { lo: 0, hi: 1 };
    if (id === 'scaleX' || id === 'scaleY') return { lo: 0, hi: 2 };
    if (id === 'x') return { lo: 0, hi: Math.max(1, Number(o.width) || 0) || null };
    if (id === 'y') return { lo: 0, hi: Math.max(1, Number(o.height) || 0) || null };
    return null;
}

export function computeRange(track, shown, vView, frozen, opts) {
    if (frozen && frozen.ranges) return frozen;
    const ranges = new Map();
    let primary = null;
    for (const id of shown) {
        let lo = Infinity;
        let hi = -Infinity;
        // 按「该通道此刻真正参与绘制的关键帧」算值域：独立轨道的键时间与共用键不同，
        // 拿共用 keys 估价会让曲线的点落到自己刻度之外。
        for (const k of channelKeysOf(track, id)) {
            const v = k.value;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
        }
        if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
            lo = -1;
            hi = 1;
        }
        if (hi - lo < 1e-6) {
            const mid2 = hi;
            const half0 = Math.max(1, Math.abs(mid2) * 0.5);
            lo = mid2 - half0;
            hi = mid2 + half0;
        }
        // 先并上通道语义区间（让旋转显示成 -180..180 而不是把 0..10 拉满屏）。
        // 数据完全落在预设区间里时**直接用预设、不再加 12% 余量** —— 旋转就该正好是 ±180，
        // 多出来的一圈空白会让刻度变成 202 这种怪数字。
        const preset = channelRange(id, opts);
        const inside = !!preset && preset.lo != null && preset.hi != null && lo >= preset.lo && hi <= preset.hi;
        if (inside) {
            lo = preset.lo;
            hi = preset.hi;
        } else if (preset && preset.lo != null && preset.hi != null) {
            lo = Math.min(lo, preset.lo);
            hi = Math.max(hi, preset.hi);
        }
        const mid = (lo + hi) / 2;
        const half = ((hi - lo) / 2) * (inside ? 1 : 1.12) * vView;
        const r = { vMin: mid - half, vMax: mid + half };
        ranges.set(id, r);
        if (!primary) primary = r;
    }
    if (!primary) primary = { vMin: -1, vMax: 1 };
    return { vMin: primary.vMin, vMax: primary.vMax, ranges };
}

/* ---------- 命中（纯几何，不读 DOM / 不读 ctx） ---------- */

/**
 * 命中测试：切线柄优先（画在点上面），其次是关键帧圆点。
 * 返回 `{ layerId, chId, index, part }` 或 null；不修改任何状态。
 */
export function hitTest(geo, track, layerId, sel, shown, px, py) {
    if (sel && shown.has(sel.chId)) {
        const keys = channelKeysOf(track, sel.chId);
        const i = sel.index;
        const k0 = keys[i];
        const k1 = keys[i + 1];
        if (k0 && k1) {
            const v0 = k0.value;
            const v1 = k1.value;
            const pos = (hx, hy) => ({ x: tToX(geo, k0.t + (k1.t - k0.t) * hx), y: vToY(geo, v0 + (v1 - v0) * hy, sel.chId) });
            const a = pos(k0.h1[0], k0.h1[1]);
            const b = pos(k0.h2[0], k0.h2[1]);
            if (Math.hypot(px - a.x, py - a.y) <= HIT_PX) return { layerId, chId: sel.chId, index: i, part: 'h1' };
            if (Math.hypot(px - b.x, py - b.y) <= HIT_PX) return { layerId, chId: sel.chId, index: i, part: 'h2' };
        }
    }
    let best = null;
    let bestD = HIT_PX;
    for (const id of shown) {
        const keys = channelKeysOf(track, id);
        for (let i = 0; i < keys.length; i++) {
            const d = Math.hypot(px - tToX(geo, keys[i].t), py - vToY(geo, keys[i].value, id));
            if (d <= bestD) {
                bestD = d;
                best = { layerId, chId: id, index: i, part: 'key' };
            }
        }
    }
    return best;
}

/** 框选：矩形里的关键帧（当前对象 × 已显示通道 × 该通道自己的键）。 */
export function pickInRect(geo, track, layerId, shown, x0, x1, y0, y1) {
    const picked = [];
    for (const chId of shown) {
        const keys = channelKeysOf(track, chId);
        for (let i = 0; i < keys.length; i += 1) {
            const px = tToX(geo, keys[i].t);
            const py = vToY(geo, keys[i].value, chId);
            if (px >= x0 && px <= x1 && py >= y0 && py <= y1) {
                picked.push({ layerId, chId, index: i, part: 'key' });
            }
        }
    }
    return picked;
}

/**
 * 拖点吸附：在「画格切换点 + 0 秒」里找最近的一个，0.12 秒内才吸。
 * marks 由调用方给（= celTimes(layer)），这里不碰 doc。
 */
export function snapTime(t, marks) {
    let best = t;
    let bestD = Infinity;
    for (const at of [0].concat(marks)) {
        const d = Math.abs(at - t);
        if (d < bestD) {
            bestD = d;
            best = at;
        }
    }
    return bestD <= 0.12 ? best : t;
}

/**
 * 拖柄落点：横向比例夹在 (0, 1)、纵向按值域换算；span 是拖动开始时那段的两端。
 * 两种数据模型都要算这套几何，抽出来共用 —— 各写一份迟早会走样。
 */
function handlePointOf(prevH, span, t, v) {
    const dt = span.t1 - span.t0 || 1;
    const dv = span.v1 - span.v0;
    const hx = clamp((t - span.t0) / dt, 0.001, 0.999);
    const hy = Math.abs(dv) < 1e-9 ? prevH[1] : (v - span.v0) / dv;
    return [hx, Number.isFinite(hy) ? hy : prevH[1]];
}

/** 拖柄（共用轨道版）：把选中的这段曲线改成正向/反向的贝塞尔切线。 */
export function dragHandleTo(trk, index, kind, prevH, span, t, v) {
    const nextH = handlePointOf(prevH, span, t, v);
    return setKeyEase(trk, index, 'bezier', kind === 'h1' ? nextH : undefined, kind === 'h2' ? nextH : undefined);
}

/** 拖柄（独立轨道版）：只改该通道自己的切线，其余通道完全不受影响。 */
export function dragChannelHandleTo(track, chId, index, kind, prevH, span, t, v) {
    const cur = channelOf(track, chId);
    if (!cur || !cur.keys[index]) return track;
    const nextH = handlePointOf(prevH, span, t, v);
    return setChannelKeyEase(track, chId, index, 'bezier', kind === 'h1' ? nextH : undefined, kind === 'h2' ? nextH : undefined);
}

/** 选区里属于该对象的索引（升序去重）——批量缓动 / 批量删除共用。 */
export function selectionIndexes(selKeys, layerId) {
    return [...new Set(selKeys.filter((s) => s.layerId === layerId && s.part === 'key').map((s) => s.index))]
        .sort((a, b) => a - b);
}

/**
 * 拖点：把 index 那个关键帧的时间改成 t、该通道的值改成 v（其余通道不动）。
 * 移动可能改变顺序，所以返回重新定位后的索引（-1 = 没定位到）。
 */
export function dragKeyTo(trk, index, t, chId, v, baseState) {
    let next = moveKey(trk, index, Math.max(0, t));
    let idx = -1;
    let bestD = Infinity;
    next.keys.forEach((k, i) => {
        const d = Math.abs(k.t - Math.max(0, t));
        if (d < bestD) {
            bestD = d;
            idx = i;
        }
    });
    if (idx >= 0) next = setKeyState(next, idx, statePatch(chId, v, baseState));
    return { track: next, index: idx };
}

/** 通道键里离 t 最近的索引：moveChannelKey 会重排，旧索引不能直接沿用。 */
function nearestChannelIndex(track, chId, t) {
    const ch = channelOf(track, chId);
    if (!ch) return -1;
    let idx = -1;
    let bestD = Infinity;
    ch.keys.forEach((k, i) => {
        const d = Math.abs(k.t - t);
        if (d < bestD) {
            bestD = d;
            idx = i;
        }
    });
    return idx;
}

/**
 * 拖点（独立轨道版）：改该通道键的时间与值，共用 `track.keys` 一字不碰 ——
 * 这正是「单独调一条曲线，别的曲线不跟随」。
 * 值必须走 setChannelKey 并把原 ease/h1/h2 带回去：它默认 ease 是 linear，
 * 少传两个参数就把这段贝塞尔静默拉直（拖完形状莫名变了就是这么来的）。
 */
export function dragChannelKeyTo(track, chId, index, t, v) {
    const cur = channelOf(track, chId);
    if (!cur || !cur.keys[index]) return { track, index: -1 };
    const tt = Math.max(0, t);
    let next = moveChannelKey(track, chId, index, tt);
    const moved = nearestChannelIndex(next, chId, tt);
    if (moved < 0) return { track: next, index: -1 };
    const at = channelOf(next, chId).keys[moved];
    next = setChannelKey(next, chId, at.t, v, at.ease, at.h1, at.h2);
    return { track: next, index: nearestChannelIndex(next, chId, at.t) };
}

/**
 * 自动切线（独立轨道版）：把该通道自己的键序列伪装成一条单通道轨道，交给 core 的
 * autoTangents 算 —— 复用同一份切线数学，另写一套迟早与共用轨道的结果对不上。
 * 它按「斜率绝对值最大的字段」选主通道；这里只有 chId 有值，所以主通道必然是该通道。
 */
export function autoTangentsChannel(track, chId, index) {
    const fake = {
        keys: channelKeysOf(track, chId).map((k) => ({
            t: k.t, ease: k.ease, h1: k.h1, h2: k.h2, state: { [chId]: k.value },
        })),
    };
    return coreAutoTangents(fake, index);
}
