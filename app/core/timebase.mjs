// 时间基（timebase）：把「时间轴」当成一等公民。
//
// 模型：
//   doc.timebase = { segments: [ { at: 0, fps: 12 }, { at: 3.5, fps: 24 } ] }
//   - at 是**秒**，升序，首段必须 at = 0。
//   - 每段从自己的 at 起，到下一段的 at 止，用该段的 fps 采样。
//   - 缺省（没有 timebase 或 segments 为空）= 全片用 doc.fps，等价于单段。
//
// 帧（doc.frames）仍然是 cel 的存储单位，但**时间才是主轴**：
// 一段里放几帧、每帧多长，由 frame.duration/fps 算出秒，帧块在时间轴上的
// 宽度就是它的秒数。timebase 只决定「渲染 / 导出时按什么网格采样」。

export const MIN_FPS = 1;
export const MAX_FPS = 120;
export const MAX_SEGMENTS = 32;

function clampFps(v, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.max(MIN_FPS, Math.min(MAX_FPS, Math.round(n * 100) / 100));
}

function docFps(doc) {
    const n = Number(doc && doc.fps);
    return Number.isFinite(n) && n > 0 ? n : 12;
}

/** 规范化：过滤非法段、强制首段 at=0、按 at 升序、限制数量。始终返回新数组。 */
export function normalizeSegments(doc) {
    const base = docFps(doc);
    const raw = doc && doc.timebase && Array.isArray(doc.timebase.segments) ? doc.timebase.segments : [];
    const list = [];
    for (const s of raw) {
        if (!s || typeof s !== 'object') continue;
        const at = Number(s.at);
        if (!Number.isFinite(at) || at < 0) continue;
        list.push({ at, fps: clampFps(s.fps, base) });
    }
    list.sort((a, b) => a.at - b.at);
    // 去掉重复时间点（保留先出现的）
    const out = [];
    for (const s of list) {
        if (out.length && Math.abs(out[out.length - 1].at - s.at) < 1e-6) continue;
        out.push(s);
        if (out.length >= MAX_SEGMENTS) break;
    }
    if (!out.length || out[0].at > 1e-9) out.unshift({ at: 0, fps: out.length ? out[0].fps : base });
    out[0] = { at: 0, fps: out[0].fps };
    return out;
}

/** 是否真的是「多段」——单段且 fps 等于 doc.fps 时视为未启用。 */
export function hasTimebase(doc) {
    const segs = normalizeSegments(doc);
    if (segs.length > 1) return true;
    return Math.abs(segs[0].fps - docFps(doc)) > 1e-6;
}

/** 某时刻所属段的帧率。 */
export function fpsAt(doc, t) {
    const segs = normalizeSegments(doc);
    const tt = Number(t);
    if (!Number.isFinite(tt)) return segs[0].fps;
    let cur = segs[0];
    for (const s of segs) {
        if (s.at <= tt + 1e-9) cur = s;
        else break;
    }
    return cur.fps;
}

/** 某时刻所属段的索引。 */
export function segmentIndexAt(doc, t) {
    const segs = normalizeSegments(doc);
    const tt = Number(t);
    let idx = 0;
    segs.forEach((s, i) => {
        if (Number.isFinite(tt) && s.at <= tt + 1e-9) idx = i;
    });
    return idx;
}

/** 段起止（秒）。最后一段的 end 由调用方给出（通常是 totalSeconds）。 */
export function segmentRange(doc, index, total) {
    const segs = normalizeSegments(doc);
    const i = Math.max(0, Math.min(index, segs.length - 1));
    const at = segs[i].at;
    const next = i + 1 < segs.length ? segs[i + 1].at : Math.max(Number(total) || 0, at);
    return { at, end: next, fps: segs[i].fps };
}

/** 纯函数式改 timebase。 */
function withSegments(doc, segs) {
    return Object.assign({}, doc, { timebase: { segments: segs } });
}

export function addSegment(doc, at, fps) {
    const segs = normalizeSegments(doc);
    const t = Math.max(0, Number(at) || 0);
    // 落在已有的段时间点上就只改它的 fps
    const hit = segs.find((s) => Math.abs(s.at - t) < 1e-6);
    if (hit) return withSegments(doc, segs.map((s) => (s === hit ? { at: s.at, fps: clampFps(fps, s.fps) } : s)));
    if (segs.length >= MAX_SEGMENTS) return doc;
    const next = segs.map((s) => ({ at: s.at, fps: s.fps }));
    next.push({ at: t, fps: clampFps(fps, docFps(doc)) });
    next.sort((a, b) => a.at - b.at);
    return withSegments(doc, next);
}

export function removeSegment(doc, index) {
    const segs = normalizeSegments(doc);
    if (segs.length <= 1) return withSegments(doc, [{ at: 0, fps: segs[0].fps }]);
    const next = segs.filter((_, i) => i !== index).map((s) => ({ at: s.at, fps: s.fps }));
    return withSegments(doc, next);
}

export function setSegmentFps(doc, index, fps) {
    const segs = normalizeSegments(doc);
    return withSegments(
        doc,
        segs.map((s, i) => (i === index ? { at: s.at, fps: clampFps(fps, s.fps) } : { at: s.at, fps: s.fps }))
    );
}

export function setSegmentAt(doc, index, at) {
    const segs = normalizeSegments(doc);
    if (index <= 0 || index >= segs.length) return doc;
    const lo = segs[index - 1].at + 1e-3;
    const hi = index + 1 < segs.length ? segs[index + 1].at - 1e-3 : Number.POSITIVE_INFINITY;
    const t = Math.max(lo, Math.min(Number(at) || lo, hi));
    return withSegments(
        doc,
        segs.map((s, i) => (i === index ? { at: t, fps: s.fps } : { at: s.at, fps: s.fps }))
    );
}

export function resetTimebase(doc) {
    return Object.assign({}, doc, { timebase: { segments: [{ at: 0, fps: docFps(doc) }] } });
}

/**
 * 导出 / 播放用的采样网格：按段帧率生成一串时间点（秒）。
 * total 缺省取 totalSeconds(doc)（由调用方传入以避免循环依赖）。
 * 每段严格从 at 起，按 1/fps 步进，最后一点不会等于段末（避免与下一段首点重复）。
 */
export function sampleTimes(doc, total) {
    const segs = normalizeSegments(doc);
    const end0 = Number(total);
    const end = Number.isFinite(end0) && end0 > 0 ? end0 : 0;
    const out = [];
    if (!(end > 0)) return out;
    for (let i = 0; i < segs.length; i++) {
        const at = segs[i].at;
        if (at >= end - 1e-9) break;
        const segEnd = i + 1 < segs.length ? Math.min(segs[i + 1].at, end) : end;
        const step = 1 / segs[i].fps;
        let t = at;
        let guard = 0;
        while (t < segEnd - 1e-9 && guard < 100000) {
            out.push({ t: Math.round(t * 1e6) / 1e6, fps: segs[i].fps });
            t += step;
            guard++;
        }
    }
    return out;
}
