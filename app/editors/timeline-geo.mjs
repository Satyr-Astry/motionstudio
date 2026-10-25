// 时间轴的几何 / 纯数据层：坐标与时间换算、刻度、画格与关键帧分组。
// 零 DOM、零外壳依赖 —— 可以直接在 Node 里 import 来测。
//
// 契约：docs/CONTRACT-v6-时间模型.md
//   · 内容属于「某一秒」：obj.cels = [{ at, image }]，画格开启后一直沿用到下一个画格。
//   · 时间轴上只有两种东西：画格切换点（方块）与变换关键帧（菱形）。
//
// 坐标系（唯一，且与契约逐字一致）：
//   pxPerSecond(doc, zoomX) = 28 * (doc.fps || 12) * zoomX
//   timeToX(doc, t, zoomX)  = t * pxPerSecond(doc, zoomX)
//   xToTime(doc, x, zoomX)  = x / pxPerSecond(doc, zoomX)
// 缩放范围 0.25 … 4，步进 1.25。

import { celIndexAt, docDuration, objectsOf } from '../core/doc-model.mjs';
import { normalizeSegments } from '../core/timebase.mjs';

/* ─────────────────────────── 常量 ─────────────────────────── */

/** zoomX = 1 时「一秒」的像素宽（再乘 fps）。 */
export const SEC_PX = 28;
export const ROW_H = 28;
export const LABEL_W = 96;
export const RULER_H = 30;
// 段帧率条的高度。曾经是 9：10px 的「12fps」在 9px 条里靠 overflow:hidden 侥幸不裁，
// 但行高与字号只差 1px 时字形上下沿会贴边（升部被削）。12 给 10px 字留出上下各 1px 的呼吸，
// 且仍在刻度数字带（RULER_H 30 的下部）之上 —— 见 timeline-paint.mjs 的 fpsLane 定位。
export const FPS_H = 12;
export const CEL_SIZE = 8;
export const CEL_TOP = 4;
export const KF_SIZE = 7;
export const KF_TOP = 17;
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
export const ZOOM_STEP = 1.25;
/** 秒刻度最小间距（px）：小于它就换更大的步长。 */
export const TICK_MIN_PX = 46;
export const TICK_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10];
/** Shift 拖动关键帧时的吸附网格（秒）。 */
export const SNAP_GRID = 0.1;
/** 时间比较容差（秒）。 */
export const T_EPS = 1e-6;
/** 播放头与关键帧的「重合」判定（px）。 */
export const CUR_EPS_PX = 3;

export const DEFAULT_FPS = 12;

export const EASES = [
    ['linear', '线性'],
    ['bezier', '贝塞尔'],
    ['hold', '保持'],
];

export const EASE_TEXT = { linear: '线性', bezier: '贝塞尔', hold: '保持' };

export const clampNum = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const fmt2 = (n) => (Number.isFinite(Number(n)) ? Number(n) : 0).toFixed(2);

/* ─────────────────────────── 纯几何 / 纯数据 ─────────────────────────── */

/** 文档有效帧率（缺省 12）。 */
export function fpsOf(doc) {
    const f = Number(doc && doc.fps);
    return f > 0 && Number.isFinite(f) ? f : DEFAULT_FPS;
}

/** 每秒多少像素：28 * fps * zoomX。 */
export function pxPerSecond(doc, zoomX = 1) {
    const z = Number(zoomX);
    const zoom = Number.isFinite(z) && z > 0 ? z : 1;
    return SEC_PX * fpsOf(doc) * zoom;
}

/** 时间（秒）→ 像素。 */
export function timeToX(doc, t, zoomX = 1) {
    const v = Number(t);
    if (!Number.isFinite(v)) return 0;
    return v * pxPerSecond(doc, zoomX);
}

/** 像素 → 时间（秒）；负值钳到 0。 */
export function xToTime(doc, x, zoomX = 1) {
    const v = Number(x);
    if (!Number.isFinite(v)) return 0;
    const p = pxPerSecond(doc, zoomX);
    return v > 0 && p > 0 ? v / p : 0;
}

/** 吸附到网格（秒），默认 0.1s。 */
export function snapGrid(t, grid = SNAP_GRID) {
    const v = Number(t);
    if (!Number.isFinite(v)) return 0;
    const g = Number(grid) > 0 ? Number(grid) : SNAP_GRID;
    return Math.round(v / g) * g;
}

/** 吸附到最近整帧（按文档 fps）。fps 不可用时原样返回。 */
export function snapFrame(doc, t) {
    const v = Number(t);
    if (!Number.isFinite(v)) return 0;
    const fps = fpsOf(doc);
    if (!(fps > 0)) return v;
    return Math.round(v * fps) / fps;
}

/**
 * 时间吸附总入口：磁铁开着吸到整帧，关掉就原样返回（仍夹到 >= 0）。
 * 面板里所有「拖动出来的时刻」都过这里，别各自 Math.round。
 */
export function snapTime(doc, t, on) {
    const v = Number(t);
    const base = Number.isFinite(v) && v > 0 ? v : 0;
    return on ? snapFrame(doc, base) : base;
}

/** 刻度步长：候选里第一个使刻度间距 ≥ 46px 的；都不够就用最大候选。 */
export function tickStep(doc, zoomX = 1) {
    const pps = pxPerSecond(doc, zoomX);
    for (const s of TICK_STEPS) {
        if (s * pps >= TICK_MIN_PX) return s;
    }
    return TICK_STEPS[TICK_STEPS.length - 1];
}

/** 刻度文字：步长小于 1 秒时保留一位小数。 */
export function tickLabel(t, step) {
    const v = Number(t);
    const s = Number(step);
    const safe = Number.isFinite(v) ? v : 0;
    const digits = Number.isFinite(s) && s < 1 ? 1 : 0;
    return safe.toFixed(digits) + 's';
}

/**
 * 刻度尺内容：主刻度（带 `${s}s` 标签）与次刻度（步长的 1/5，太密就不画）。
 * 全部按当前 zoomX 计算，缩放后重算。
 */
export function rulerTicks(doc, zoomX = 1) {
    const pps = pxPerSecond(doc, zoomX);
    const total = docDuration(doc);
    const step = tickStep(doc, zoomX);
    const major = [];
    const last = Math.floor(total / step + 1e-9);
    for (let i = 0; i <= last; i++) {
        const t = Math.round(i * step * 1e6) / 1e6;
        major.push({ t, x: timeToX(doc, t, zoomX), label: tickLabel(t, step) });
    }
    const minor = [];
    const sub = step / 5;
    if (sub * pps >= 6) {
        const n = Math.floor(total / sub + 1e-9);
        for (let k = 1; k <= n; k++) {
            const t = Math.round(k * sub * 1e6) / 1e6;
            const ratio = t / step;
            if (Math.abs(ratio - Math.round(ratio)) < 1e-6) continue; // 与主刻度重合
            minor.push({ t, x: timeToX(doc, t, zoomX) });
        }
    }
    return { pps, step, total, totalPx: timeToX(doc, total, zoomX), major, minor };
}

/** 画格点方块的 left（中心对齐到时间刻度）。 */
export function celLeft(doc, t, zoomX = 1) {
    return timeToX(doc, t, zoomX) - CEL_SIZE / 2;
}

/** 关键帧菱形的 left（中心对齐到时间刻度）。 */
export function kfLeft(doc, t, zoomX = 1) {
    return timeToX(doc, t, zoomX) - KF_SIZE / 2;
}

/** 对象的画格标记（升序）：{ at, empty }。 */
export function celMarks(obj) {
    const out = [];
    for (const cel of obj && Array.isArray(obj.cels) ? obj.cels : []) {
        if (!cel || !Number.isFinite(Number(cel.at))) continue;
        out.push({ at: Number(cel.at), empty: !cel.image });
    }
    out.sort((a, b) => a.at - b.at);
    return out;
}

/** 当前时间生效的画格下标（-1 = 还没到第一个画格）。 */
export function currentCelIndex(obj, t) {
    return celIndexAt(obj, t);
}

/**
 * 同刻合并：把一个轨道里所有关键帧按时间分组，一组只画一个菱形。
 * idx 是**原数组下标**，直接交给 moveKey / removeKey / setKeyEase。
 */
export function keyGroups(keys) {
    const src = Array.isArray(keys) ? keys : [];
    const items = [];
    src.forEach((k, i) => {
        if (k && Number.isFinite(Number(k.t))) items.push({ i, t: Number(k.t), ease: k.ease });
    });
    items.sort((a, b) => a.t - b.t || a.i - b.i);
    const out = [];
    for (const it of items) {
        const g = out[out.length - 1];
        if (g && Math.abs(it.t - g.t) <= T_EPS) {
            g.idx.push(it.i);
            continue;
        }
        out.push({ t: it.t, idx: [it.i], ease: it.ease });
    }
    return out;
}

/* ─────────────────────── 关键帧值的可读摘要（title 里给人看） ─────────────────────── */

/** 通道显示名（只用于文案，顺序与 transform 的 TRACK_FIELDS 一致）。 */
const STATE_LABELS = [
    ['x', '位移 X'],
    ['y', '位移 Y'],
    ['scaleX', '缩放 X'],
    ['scaleY', '缩放 Y'],
    ['rotate', '旋转', '°'],
    ['skewX', '斜切 X', '°'],
    ['skewY', '斜切 Y', '°'],
    ['opacity', '不透明度'],
];
const STATE_DEFAULTS = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotate: 0, skewX: 0, skewY: 0, opacity: 1 };

/**
 * 把关键帧的 state 压成一句人话：只列偏离默认值的通道。
 * 时间轴上的菱形原本没有任何数值信息，用户只能去曲线区猜这个键到底改了什么。
 */
export function keySummary(state, max = 3) {
    const s = state && typeof state === 'object' ? state : {};
    const parts = [];
    for (const [field, label, unit] of STATE_LABELS) {
        const v = Number(s[field]);
        if (!Number.isFinite(v) || Math.abs(v - STATE_DEFAULTS[field]) < 1e-6) continue;
        parts.push(label + '=' + Math.round(v * 1000) / 1000 + (unit || ''));
        if (parts.length >= max) break;
    }
    return parts.length ? parts.join(' · ') : '与默认值相同';
}

/** 段帧率条的数据：每段 { index, at, fps, end }，最后一段的 end = 总时长。 */
export function timeSegments(doc, total) {
    const end = Number.isFinite(Number(total)) && Number(total) > 0 ? Number(total) : docDuration(doc);
    return normalizeSegments(doc).map((s, i, list) => ({
        index: i,
        at: s.at,
        fps: s.fps,
        end: i + 1 < list.length ? list[i + 1].at : Math.max(end, s.at),
    }));
}

/** 某时刻属于哪一段（返回段下标）。 */
export function segmentIndexAtTime(segs, t) {
    const list = Array.isArray(segs) ? segs : [];
    const time = Number.isFinite(Number(t)) ? Number(t) : 0;
    let idx = 0;
    list.forEach((s, i) => {
        if (s && s.at <= time + 1e-9) idx = i;
    });
    return idx;
}

/* ─────────────────────────── 纯数据小工具（不进文档结构） ─────────────────────────── */

export const trackOf = (obj) => (obj && obj.transform && Array.isArray(obj.transform.keys) ? obj.transform : { keys: [] });
export const setTransform = (obj, track) => Object.assign({}, obj, { transform: track });

/** 行结构的签名：对象 id 序列变了才重建行。 */
export const structSignature = (doc) => objectsOf(doc).map((o) => (o && o.id) || '').join(',');
