// 图层变换关键帧模型（纯函数，无外部依赖）。
// 时间单位：秒；角度单位：deg；warp 偏移单位：像素（网格 warp 见 lattice.mjs）。

import { normalizeLattice, lerpLattice, latticeIsZero, latticePoint } from './lattice.mjs';

const EPS = 1e-9;
const DEG = Math.PI / 180;
const EASES = ['linear', 'hold', 'bezier'];
const DEFAULT_H1 = Object.freeze([0.25, 0.1]);
const DEFAULT_H2 = Object.freeze([0.75, 0.9]);
const WARP_CORNERS = ['tl', 'tr', 'br', 'bl'];
const ZERO_WARP = Object.freeze({
  cols: 1,
  rows: 1,
  pts: Object.freeze([
    Object.freeze([0, 0]), Object.freeze([0, 0]),
    Object.freeze([0, 0]), Object.freeze([0, 0]),
  ]),
});

/** 冻结的默认状态：所有缺省字段均取此值。 */
export const DEFAULT_STATE = Object.freeze({
  x: 0, y: 0, scaleX: 1, scaleY: 1, rotate: 0,
  skewX: 0, skewY: 0, opacity: 1, warp: null,
});

/** 可插值的标量字段（warp 按四角单独插值）。 */
export const TRACK_FIELDS = Object.freeze([
  'x', 'y', 'scaleX', 'scaleY', 'rotate', 'skewX', 'skewY', 'opacity',
]);

// ---------- 内部工具 ----------

const isNum = (v) => Number.isFinite(v);
const num = (v, d) => (isNum(v) ? v : d);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const normEase = (e) => (EASES.includes(e) ? e : 'linear');

function normPt(p, d) {
  if (Array.isArray(p)) return [num(p[0], d[0]), num(p[1], d[1])];
  return [d[0], d[1]];
}

// warp 深拷贝：绝不与入参共享数组引用（网格 warp 走 lattice.normalizeLattice）
function normWarp(w) {
  return normalizeLattice(w);
}

// 规范化 state：缺省字段一律补默认值
function normState(state) {
  const s = state && typeof state === 'object' ? state : {};
  return {
    x: num(s.x, 0),
    y: num(s.y, 0),
    scaleX: num(s.scaleX, 1),
    scaleY: num(s.scaleY, 1),
    rotate: num(s.rotate, 0),
    skewX: num(s.skewX, 0),
    skewY: num(s.skewY, 0),
    opacity: num(s.opacity, 1),
    warp: normWarp(s.warp),
  };
}

// cubic-bezier 单轴求值
function bezierAxis(t, p1, p2) {
  const mt = 1 - t;
  return 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t;
}

// warp 与标量共用同一个缓动进度 p（见 segmentProgress），故形参直接叫 p
function lerpWarp(a, b, p) {
  return lerpLattice(a, b, p);
}

function lerpState(a, b, u) {
  const out = {};
  for (const f of TRACK_FIELDS) out[f] = lerp(a[f], b[f], u);
  out.warp = lerpWarp(a.warp, b.warp, u);
  return out;
}

function checkIndex(keys, index) {
  return Array.isArray(keys) && Number.isInteger(index) && index >= 0 && index < keys.length;
}

// ---------- 轨道与关键帧 ----------

export function createTrack() {
  return { keys: [] };
}

export function createKey(t, state, ease = 'linear', h1, h2) {
  if (!isNum(t)) throw new TypeError('createKey: t 必须是有限数字');
  return {
    t,
    ease: normEase(ease),
    h1: normPt(h1, DEFAULT_H1),
    h2: normPt(h2, DEFAULT_H2),
    state: normState(state),
  };
}

// 插入并按 t 排序；t 相同（差 < 1e-9）视为同一帧，替换之
export function addKey(track, t, state, ease = 'linear', h1, h2) {
  const base = track && Array.isArray(track.keys) ? track : createTrack();
  const key = createKey(t, state, ease, h1, h2);
  const keys = base.keys.filter((k) => Math.abs(k.t - key.t) >= EPS);
  keys.push(key);
  keys.sort((a, b) => a.t - b.t);
  return { ...base, keys };
}

export function removeKey(track, index) {
  const keys = track ? track.keys : null;
  if (!checkIndex(keys, index)) return track;
  return { ...track, keys: keys.filter((_, i) => i !== index) };
}

// 改时间后重排；若与既有帧撞时间，以被移动的帧为准
export function moveKey(track, index, t) {
  if (!isNum(t)) throw new TypeError('moveKey: t 必须是有限数字');
  const keys = track ? track.keys : null;
  if (!checkIndex(keys, index)) return track;
  const moved = { ...keys[index], t };
  const rest = keys.filter((_, i) => i !== index)
    .filter((k) => Math.abs(k.t - t) >= EPS);
  rest.push(moved);
  rest.sort((a, b) => a.t - b.t);
  return { ...track, keys: rest };
}

export function setKeyState(track, index, patch) {
  const keys = track ? track.keys : null;
  if (!checkIndex(keys, index)) return track;
  const next = normState(keys[index].state);
  const p = patch && typeof patch === 'object' ? patch : {};
  for (const f of TRACK_FIELDS) if (isNum(p[f])) next[f] = p[f];
  if ('warp' in p) next.warp = normWarp(p.warp);
  return { ...track, keys: keys.map((k, i) => (i === index ? { ...k, state: next } : k)) };
}

export function setKeyEase(track, index, ease, h1, h2) {
  const keys = track ? track.keys : null;
  if (!checkIndex(keys, index)) return track;
  const next = { ...keys[index], ease: normEase(ease) };
  if (h1 !== undefined) next.h1 = normPt(h1, DEFAULT_H1);
  if (h2 !== undefined) next.h2 = normPt(h2, DEFAULT_H2);
  return { ...track, keys: keys.map((k, i) => (i === index ? next : k)) };
}

// ---------- 求值 ----------

export function lerp(a, b, u) {
  return a + (b - a) * u;
}

/**
 * CSS cubic-bezier(x1,y1,x2,y2) 语义：以段内归一化时间 x∈[0,1] 反解参数 t，
 * 再取 y(t)。x 方向在 x1,x2∈[0,1] 时单调，二分足够收敛（<1e-12）。
 */
export function solveBezierYForX(x1, y1, x2, y2, x) {
  const ax = clamp(num(x1, 0), 0, 1);
  const bx = clamp(num(x2, 1), 0, 1);
  const ay = num(y1, 0);
  const by = num(y2, 1);
  const u = clamp(num(x, 0), 0, 1);
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  let lo = 0;
  let hi = 1;
  let mid = u;
  for (let i = 0; i < 64; i += 1) {
    mid = (lo + hi) / 2;
    const v = bezierAxis(mid, ax, bx);
    if (Math.abs(v - u) < 1e-12) break;
    if (v < u) lo = mid; else hi = mid;
  }
  return bezierAxis(mid, ay, by);
}

/**
 * 段内缓动进度：把归一化时间 u∈[0,1] 按该关键帧的 ease 换算成进度 p。
 *
 * 这是**唯一**的缓动来源：标量字段（lerpState）、通道轨道（channelValueAt）与
 * warp 网格（lerpWarp → lerpLattice）必须共用同一个 p，用户的贝塞尔手柄才能同时
 * 作用到位移和网格变形。p 允许越界（预冲 p<0 / 过冲 p>1），由 lerp / lerpLattice
 * 如实外插 —— 网格侧若夹住 p，视觉上就退化成「网格只有线性」。
 * hold 的「整段保持起始帧」语义由调用方在取 p 之前短路。
 */
export function segmentProgress(key, u) {
  const x = clamp(num(u, 0), 0, 1);
  const ease = key ? key.ease : 'linear';
  if (ease !== 'bezier') return x;
  const h1 = normPt(key.h1, DEFAULT_H1);
  const h2 = normPt(key.h2, DEFAULT_H2);
  return solveBezierYForX(h1[0], h1[1], h2[0], h2[1], x);
}

/**
 * 求时间 t 的状态（仅共用轨道）。
 * ease 描述「本帧 → 下一帧」这一段；hold 整段保持；区间外取端点，不外插。
 */
function baseStateAt(track, t) {
  const keys = track && Array.isArray(track.keys) ? track.keys : [];
  if (keys.length === 0) return normState(null);
  const tt = isNum(t) ? t : keys[0].t;
  if (tt <= keys[0].t) return normState(keys[0].state);
  const last = keys[keys.length - 1];
  if (tt >= last.t) return normState(last.state);

  let i = 0;
  for (let k = 0; k < keys.length - 1; k += 1) {
    if (tt >= keys[k].t && tt < keys[k + 1].t) { i = k; break; }
  }
  const k0 = keys[i];
  const k1 = keys[i + 1];
  const span = k1.t - k0.t;
  if (span <= 0) return normState(k1.state);
  if (k0.ease === 'hold') return normState(k0.state);

  const u = (tt - k0.t) / span;
  const p = segmentProgress(k0, u);
  return lerpState(normState(k0.state), normState(k1.state), p);
}

/**
 * 数值中心差分求斜率（v5，§4 可微）。
 * 用于「自动切线」：把某关键帧的 h1/h2 按相邻斜率摆平。
 * 端点上 due 到 stateAt 的区间外夹取，一侧会退化成 0 —— 这是期望行为。
 */
export function slopeAt(track, t, eps) {
  const e = isNum(eps) && eps > 0 ? eps : 1e-4;
  const a = stateAt(track, (isNum(t) ? t : 0) - e);
  const b = stateAt(track, (isNum(t) ? t : 0) + e);
  const out = {};
  for (const f of TRACK_FIELDS) {
    const va = Number(a[f]);
    const vb = Number(b[f]);
    out[f] = Number.isFinite(va) && Number.isFinite(vb) ? (vb - va) / (2 * e) : 0;
  }
  return out;
}

/**
 * 为一个关键帧算「自动切线」的控制点（v5，§5）。
 * 用相邻两段的斜率估计该点切线，再换算成段内归一化 h1/h2：
 *   - 对第 i 个关键帧，前段是 (i-1 → i)，后段是 (i → i+1)
 *   - 返回值给 setKeyEase(track, i, 'bezier', h1, h2) 用
 * 只有单点或端点时，切线为水平（h1=[1/3,0]、h2=[2/3,1]）。
 */
export function autoTangents(track, index) {
  const keys = track && Array.isArray(track.keys) ? track.keys : [];
  const i = Number.isInteger(index) ? index : -1;
  if (i < 0 || i >= keys.length) return null;
  const k = keys[i];
  const prev = i > 0 ? keys[i - 1] : null;
  const next = i + 1 < keys.length ? keys[i + 1] : null;
  // 该点的斜率（每单位时间的值变化）：用前后两点估计，取平均
  const slopeOf = (a, b) => {
    const dt = b.t - a.t;
    if (!(dt > 0)) return null;
    const sa = normState(a.state);
    const sb = normState(b.state);
    const out = {};
    for (const f of TRACK_FIELDS) out[f] = (sb[f] - sa[f]) / dt;
    return out;
  };
  const sp = prev ? slopeOf(prev, k) : null;
  const sn = next ? slopeOf(k, next) : null;
  // 前段的 h2、后段的 h1 由「该点的瞬时斜率」给出；另外两个端点保持平滑
  const pick = (f) => {
    const a = sp ? sp[f] : null;
    const b = sn ? sn[f] : null;
    if (a != null && b != null) return (a + b) / 2;
    return a != null ? a : b != null ? b : 0;
  };
  const values = {};
  for (const f of TRACK_FIELDS) values[f] = pick(f);
  // 用 opacity 之外的「主通道」决定切线形状（取绝对值最大者），其余通道共用同一组 h1/h2
  let main = 'x';
  let best = 0;
  for (const f of TRACK_FIELDS) {
    const mag = Math.abs(values[f] || 0);
    if (mag > best) {
      best = mag;
      main = f;
    }
  }
  const st = normState(k.state);
  const dIn = prev ? st[main] - normState(prev.state)[main] : 0;
  const dOut = next ? normState(next.state)[main] - st[main] : 0;
  const dtIn = prev ? k.t - prev.t : 0;
  const dtOut = next ? next.t - k.t : 0;
  // 归一化到段内：h1 属于「前段」，h2 属于「后段」。但 setKeyEase 的 h1/h2 是同一个 key 的
  // 前后两手柄，分别作用于「进入本 key 的段」与「离开本 key 的段」，所以这里各自独立算。
  const h1y = dtIn > 0 ? clampUnit(0.5 + (values[main] * dtIn) / (2 * (dIn || 1e-6))) : 0.5;
  const h2y = dtOut > 0 ? clampUnit(0.5 + (values[main] * dtOut) / (2 * (dOut || 1e-6))) : 0.5;
  return { h1: [1 / 3, clampUnit(h1y)], h2: [2 / 3, clampUnit(h2y)], main };
}

function clampUnit(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  // 允许轻微过冲（-0.5 ~ 1.5），再大就夹住，避免曲线炸飞
  return n < -0.5 ? -0.5 : n > 1.5 ? 1.5 : n;
}

export function isIdentity(state) {
  const s = normState(state);
  if (Math.abs(s.x) > EPS || Math.abs(s.y) > EPS) return false;
  if (Math.abs(s.scaleX - 1) > EPS || Math.abs(s.scaleY - 1) > EPS) return false;
  if (Math.abs(s.rotate) > EPS || Math.abs(s.skewX) > EPS || Math.abs(s.skewY) > EPS) return false;
  if (Math.abs(s.opacity - 1) > EPS) return false;
  if (s.warp && !latticeIsZero(s.warp)) return false;
  return true;
}

/**
 * 合成顺序：缩放 → 斜切 → 旋转 → 平移（等价 canvas setTransform）。
 * M = T * R * K * S，其中 K = [[1, tanX], [tanY, 1]]。
 * 输出 canvas 顺序 {a,b,c,d,e,f}：x' = a*x + c*y + e，y' = b*x + d*y + f。
 */
export function matrixOf(state) {
  const s = normState(state);
  const rad = s.rotate * DEG;
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);
  const kx = Math.tan(s.skewX * DEG);
  const ky = Math.tan(s.skewY * DEG);
  const sx = s.scaleX;
  const sy = s.scaleY;
  return {
    a: cosR * sx - sinR * ky * sx,
    b: sinR * sx + cosR * ky * sx,
    c: cosR * kx * sy - sinR * sy,
    d: sinR * kx * sy + cosR * sy,
    e: s.x,
    f: s.y,
  };
}

// 四角绝对坐标：warp 为 null 时即矩形四角（网格 >1×1 时给出外框四角）
export function warpQuad(state, w, h) {
  const s = normState(state);
  const W = num(w, 0);
  const H = num(h, 0);
  const base = { tl: [0, 0], tr: [W, 0], br: [W, H], bl: [0, H] };
  if (!s.warp) return base;
  const corner = (u, v) => {
    const p = latticePoint(s.warp, W, H, u, v);
    return [p.x, p.y];
  };
  return { tl: corner(0, 0), tr: corner(1, 0), br: corner(1, 1), bl: corner(0, 1) };
}

/** 网格 warp 的绝对顶点（行优先），供渲染与叠加层使用 */
export function warpMesh(state, w, h) {
  const s = normState(state);
  const W = num(w, 0);
  const H = num(h, 0);
  const lat = s.warp || ZERO_WARP;
  const out = [];
  for (let r = 0; r <= lat.rows; r++) {
    for (let c = 0; c <= lat.cols; c++) {
      const p = latticePoint(lat, W, H, c / lat.cols, r / lat.rows);
      out.push([p.x, p.y]);
    }
  }
  return { cols: lat.cols, rows: lat.rows, pts: out };
}

// ---------- 通道独立轨道（v8） ----------
//
// 背景：`track.keys` 是「一个关键帧携带全部通道值」的单轨道模型。它有一个硬约束——
// 移动某个关键帧的时间，等于同时移动所有通道的时间基准，于是「单独调一条曲线」时
// 其它曲线会跟着变。
//
// 这里补一层可选的「通道轨道」：`track.channels[field] = { keys: [{t,ease,h1,h2,value}] }`。
// 有通道轨道的字段优先用它自己的关键帧求值，没有的继续走共用 `keys`。
// 两者可以长期共存：共用轨道仍是最省事的默认，通道轨道只在需要单独调时出现。

/** 取某字段的通道轨道；没有则返回 null。 */
export function channelOf(track, field) {
    const ch = track && track.channels ? track.channels[field] : null;
    return ch && Array.isArray(ch.keys) && ch.keys.length ? ch : null;
}

/** 是否存在任何通道轨道。 */
export function hasChannelTracks(track) {
    if (!track || !track.channels) return false;
    for (const f of TRACK_FIELDS) if (channelOf(track, f)) return true;
    return false;
}

/** 通道关键帧求值；区间外取端点，不外插。 */
export function channelValueAt(ch, t, fallback) {
    const keys = ch && Array.isArray(ch.keys) ? ch.keys : null;
    if (!keys || !keys.length) return fallback;
    const tt = isNum(t) ? t : keys[0].t;
    if (tt <= keys[0].t) return num(keys[0].value, fallback);
    const last = keys[keys.length - 1];
    if (tt >= last.t) return num(last.value, fallback);
    let i = 0;
    for (let k = 0; k < keys.length - 1; k += 1) {
        if (tt >= keys[k].t && tt < keys[k + 1].t) { i = k; break; }
    }
    const k0 = keys[i];
    const k1 = keys[i + 1];
    const span = k1.t - k0.t;
    if (!(span > 0)) return num(k1.value, fallback);
    if (k0.ease === 'hold') return num(k0.value, fallback);
    const u = (tt - k0.t) / span;
    const p = segmentProgress(k0, u);
    return lerp(num(k0.value, fallback), num(k1.value, fallback), p);
}

// 把通道轨道的值覆盖到状态上（就地改传入对象，调用方保证它是新建的）
function applyChannels(track, t, state) {
    if (!track || !track.channels) return state;
    for (const f of TRACK_FIELDS) {
        const ch = channelOf(track, f);
        if (ch) state[f] = channelValueAt(ch, t, state[f]);
    }
    return state;
}

/** 求时间 t 的状态：先按共用关键帧求基线，再用各通道轨道覆盖。 */
export function stateAt(track, t) {
    return applyChannels(track, t, baseStateAt(track, t));
}

function mkChannelKeys(keys) {
    const out = keys.filter((k) => isNum(k.t))
        .map((k) => ({
            t: k.t,
            ease: normEase(k.ease),
            h1: normPt(k.h1, DEFAULT_H1),
            h2: normPt(k.h2, DEFAULT_H2),
            value: num(k.value, 0),
        }))
        .sort((a, b) => a.t - b.t);
    return out;
}

function withChannel(track, field, chKeys) {
    const base = track && typeof track === 'object' ? track : createTrack();
    const channels = { ...(base.channels || {}) };
    if (!chKeys || !chKeys.length) delete channels[field];
    else channels[field] = { keys: chKeys };
    return { ...base, channels };
}

/**
 * 给某个通道在该时刻打一个关键帧。
 * value 省略时取该时刻的当前求值（这样「只是把点拎起来」不会跳变）。
 */
export function setChannelKey(track, field, t, value, ease = 'linear', h1, h2) {
    if (!TRACK_FIELDS.includes(field)) throw new TypeError('setChannelKey: 未知通道 ' + field);
    if (!isNum(t)) throw new TypeError('setChannelKey: t 必须是有限数字');
    const cur = channelOf(track, field);
    const v = isNum(value) ? value : channelValueAt(cur, t, num(stateAt(track, t)[field], 0));
    const next = { t, ease: normEase(ease), h1: normPt(h1, DEFAULT_H1), h2: normPt(h2, DEFAULT_H2), value: v };
    const keys = mkChannelKeys((cur ? cur.keys : []).filter((k) => Math.abs(k.t - t) >= EPS).concat([next]));
    return withChannel(track, field, keys);
}

export function removeChannelKey(track, field, index) {
    const cur = channelOf(track, field);
    if (!cur || !checkIndex(cur.keys, index)) return track;
    return withChannel(track, field, cur.keys.filter((_, i) => i !== index));
}

export function moveChannelKey(track, field, index, t) {
    if (!isNum(t)) throw new TypeError('moveChannelKey: t 必须是有限数字');
    const cur = channelOf(track, field);
    if (!cur || !checkIndex(cur.keys, index)) return track;
    const moved = { ...cur.keys[index], t };
    const rest = cur.keys.filter((_, i) => i !== index).filter((k) => Math.abs(k.t - t) >= EPS);
    return withChannel(track, field, mkChannelKeys(rest.concat([moved])));
}

export function setChannelKeyEase(track, field, index, ease, h1, h2) {
    const cur = channelOf(track, field);
    if (!cur || !checkIndex(cur.keys, index)) return track;
    const next = { ...cur.keys[index], ease: normEase(ease) };
    if (h1 !== undefined) next.h1 = normPt(h1, DEFAULT_H1);
    if (h2 !== undefined) next.h2 = normPt(h2, DEFAULT_H2);
    return withChannel(track, field, cur.keys.map((k, i) => (i === index ? next : k)));
}

/**
 * 把某通道的共用关键帧「提升」成独立通道轨道：保持当前画面不变。
 * 曲线编辑器在用户第一次单独拖某条曲线时调用它。
 */
export function promoteChannel(track, field) {
    if (!TRACK_FIELDS.includes(field)) return track;
    if (channelOf(track, field)) return track;
    const base = track && Array.isArray(track.keys) ? track : createTrack();
    const keys = base.keys.map((k) => ({
        t: k.t,
        ease: k.ease,
        h1: k.h1,
        h2: k.h2,
        value: normState(k.state)[field],
    }));
    return withChannel(base, field, keys);
}

/** 删掉通道轨道，回到跟随共用关键帧。 */
export function clearChannel(track, field) {
    if (!channelOf(track, field)) return track;
    return withChannel(track, field, null);
}
