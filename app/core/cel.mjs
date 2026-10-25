// 文档模型适配层（v6）：时间是一等公民，「帧」这个容器已经整体删除。
//
// 权威实现在 core/doc-model.mjs —— 纹理（cel）是按秒索引的开关事件：
//     obj.cels = [{ at, image }, ...]        // at 升序；纹理开启后一直生效到下一个纹理
// 本模块只剩三件事：
//   1) 把外壳仍在使用的老名字转发给 doc-model（createDocument / totalSeconds / layerById …）；
//   2) 保留少量同样纯函数、且不属于文档模型的辅助（循环折叠 wrapTime、分段帧率 fpsAtTime、
//      洋葱皮配置归一 normalizeOnion）；
//   3) 不再持有任何「帧数组 / 帧序号 / 跨帧继承」概念 —— 旧导出已按契约整体删除。
//
// 约定（与 shell/areas.mjs 一致）：所有导出都是纯函数，返回新 doc，绝不改入参。
// cel.image 是「不透明的图像句柄」——浏览器里是 canvas，Node 测试里是任意值；
// 本模块从不读写图像内容，由调用方（editors/canvas.mjs）负责。

// ── doc-model 全量转发：外壳从这里取用即可，不要再实现一遍 ──────────────────

export {
    normAt,
    makeObject,
    normCel,
    createDoc as createDocument,
    objectsOf,
    objectById,
    celTimes,
    celIndexAt,
    celAt,
    imageAt,
    hasCelAt,
    isCelBoundary,
    ensureCelAt,
    setImageAt,
    removeCelAt,
    moveCel,
    contentDuration,
    docDuration,
    totalSeconds,
    patchObject,
    addObject,
    removeObject,
    reorderObject,
    migrateFromFrames,
    eventTimes,
    sampleTimes,
    stateOf,
    emptyTrack,
    makeKey,
} from './doc-model.mjs';

import {
    objectsOf,
    objectById,
    makeObject,
    docDuration,
    patchObject,
    removeObject,
    reorderObject,
} from './doc-model.mjs';

export const LOOP_CYCLE = 'cycle';
export const LOOP_PINGPONG = 'pingpong';
export const LOOP_NONE = 'none';
// v9：反向循环。时间的**流向**由播放推进负责（app/core/playback.mjs 的 playbackAt），
// 这里只需要认得这个值、别把它当未知模式：折叠规则与 cycle 相同。
export const LOOP_REVERSE = 'reverse';

// ── 对象（老名 layer，与 doc.objects 一一对应） ─────────────────────────────

/** id → 对象。 */
export function layerById(doc, layerId) {
    return objectById(doc, layerId);
}

/**
 * 改对象属性（老签名：直接给字段补丁）。
 * 内部走 doc-model 的不可变更新；未命中 id 或补丁为空时原样返回入参。
 */
export function patchLayer(doc, layerId, patch) {
    const p = patch && typeof patch === 'object' ? patch : null;
    if (!p || !Object.keys(p).length) return doc;
    return patchObject(doc, layerId, (o) => Object.assign({}, o, p));
}

/** 新对象插到最前（doc.objects[0] 是最上层，合成时倒序绘制）。 */
export function addLayer(doc, name) {
    if (!doc) return doc;
    const list = objectsOf(doc);
    const obj = makeObject({ name: name || '对象 ' + (list.length + 1) });
    return Object.assign({}, doc, { objects: [obj].concat(list) });
}

/**
 * 删除对象。v8：允许删到「一个对象都没有」——空文档是合法状态，
 * 旧版这里「至少保留一个」的守卫会让用户的删除按钮变成死胡同。
 */
export function removeLayer(doc, layerId) {
    if (!doc) return doc;
    return removeObject(doc, layerId);
}

/** 调整对象顺序（越界夹取）。 */
export function moveLayer(doc, layerId, toIndex) {
    return reorderObject(doc, layerId, toIndex);
}

/**
 * 按给定定义**重建**对象列表，defs 的顺序就是最终顺序（第 0 项 = 最上层）。
 *
 * 与 addLayer 的区别：addLayer 插到最前，连续调用会把顺序反转 ——
 * 拿外部列表逐个 addLayer 去对齐时顺序会颠倒，于是面板顺序与画布叠放顺序相反。
 * 这里一次性重建：同 id 保留原字段（含 transform 轨道与全部纹理），缺的字段用 defs 覆盖。
 */
export function replaceLayers(doc, defs) {
    if (!doc) return doc;
    const base = new Map(objectsOf(doc).map((o) => [o && o.id, o]));
    const objects = (defs || []).map((d) => {
        const src = d && typeof d === 'object' ? d : {};
        const old = base.get(src.id) || null;
        return makeObject(Object.assign({}, old || {}, src));
    });
    if (!objects.length) return doc;
    return Object.assign({}, doc, { objects });
}

/** 深拷贝文档（图像句柄按 JSON 语义降级，调用方注意只在纯结构快照上用）。 */
export function cloneDocument(doc) {
    return JSON.parse(JSON.stringify(doc));
}

// ── 洋葱皮配置归一 ────────────────────────────────────────────────────────

export const ONION_DEFAULTS = Object.freeze({
    enabled: false,
    before: 1,
    after: 1,
    mode: 'tint',
    past: '#c8555a',
    next: '#3f9a63',
    opacity: 0.4,
});

/**
 * 洋葱皮配置 → 完整、已夹取的配置对象。
 * before/after 是「前后各几个纹理切换点」，0~12；opacity 0~1；mode 只认 tint / fade。
 */
export function normalizeOnion(input) {
    const src = input && typeof input === 'object' ? input : {};
    const int = (v, d) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(0, Math.min(12, Math.round(n))) : d;
    };
    const unit = (v, d) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : d;
    };
    return {
        enabled: src.enabled === true,
        before: int(src.before, ONION_DEFAULTS.before),
        after: int(src.after, ONION_DEFAULTS.after),
        mode: src.mode === 'fade' ? 'fade' : 'tint',
        past: typeof src.past === 'string' ? src.past : ONION_DEFAULTS.past,
        next: typeof src.next === 'string' ? src.next : ONION_DEFAULTS.next,
        opacity: unit(src.opacity, ONION_DEFAULTS.opacity),
        ignoreTransform: src.ignoreTransform === true,
    };
}

// ── 时间辅助 ──────────────────────────────────────────────────────────────

// 可变帧率（v4 遗留）：每段自己有 fps，只影响「导出取哪些采样点」，不影响纹理归属。
// 这里内联一份极简段表解析，避免 core/cel 与 core/timebase 互相 import。
function segmentsOf(doc) {
    const raw = doc && doc.timebase && Array.isArray(doc.timebase.segments) ? doc.timebase.segments : null;
    if (!raw || !raw.length) return null;
    const rawFps = Number(doc.fps);
    const base = rawFps > 0 ? rawFps : 0; // 非法 doc.fps 不做兜底，让调用方拿到 0
    const list = raw
        .map((s) => ({
            at: Math.max(0, Number(s.at) || 0),
            fps: Number(s.fps) > 0 ? Number(s.fps) : base,
        }))
        .sort((a, b) => a.at - b.at);
    if (!list.length) return null;
    if (Math.abs(list[0].at) > 1e-9) list.unshift({ at: 0, fps: base });
    return list;
}

/** 时间 t 所在分段的帧率；没有 timebase 时就是 doc.fps。 */
export function fpsAtTime(doc, t) {
    const segs = segmentsOf(doc);
    if (!segs) return Number(doc && doc.fps) > 0 ? Number(doc.fps) : 0;
    const time = Number(t) || 0;
    let fps = segs[0].fps;
    for (const s of segs) {
        if (s.at <= time + 1e-9) fps = s.fps;
        else break;
    }
    return fps > 0 ? fps : 0;
}

// 把任意 t 折叠进 [0, total) 的有效时间轴（按 doc.loopMode）。
// 返回 null 表示「该循环模式下 t 超出范围」（LOOP_NONE 的越界）。
// 注意：不能用 ((t % total) + total) % total —— 那会把 0.1 变成 0.09999999999999998，
// 让恰好落在纹理切换点上的时间掉回上一个纹理。这里只在结果越界时才加减一个周期。
export function wrapTime(doc, t) {
    const total = docDuration(doc);
    if (!(total > 0)) return 0;
    const mode = doc && doc.loopMode;
    if (mode === LOOP_NONE) return t < 0 || t >= total ? null : t;
    if (mode === LOOP_PINGPONG) {
        const period = total * 2;
        let p = t % period;
        if (p < 0) p += period;
        if (p !== p) return 0;
        return p <= total ? p : period - p;
    }
    let m = t % total;
    if (m < 0) m += total;
    if (m >= total) m -= total;
    return m;
}
