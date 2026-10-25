// 文档模型（v6）：时间是一等公民，没有「帧」这个容器。
//
// ── 为什么删掉 doc.frames ──────────────────────────────────────────────
// 旧模型是 Pixelorama 式：doc.frames[i].cels[layerId].image —— 内容是「第 i 帧
// 第 j 个对象的像素」。它把「时间」写死成等距的整数格，于是：
//   · 两个画格之间想做 0.17 秒的过渡要改 fps 或改 duration 倍率；
//   · 变速、循环、父子时间全都要在帧索引外面再包一层；
//   · 时间轴模块一半代码在处理「帧块宽度」而不是「内容何时出现」。
//
// 新模型：对象自己持有一串**按秒索引**的画格（cel），画格是一个开关事件：
//
//     obj.cels = [{ at: 0, image }, { at: 0.5, image }, { at: 1.25, image }]
//     celAt(obj, t)  →  at <= t 的最后一个画格（之后一直沿用，直到下一个画格）
//
// 于是「逐帧动画」变成「一串密集的画格」，「两个画格间隔 3 秒」也完全合法，
// 而且时间轴只需要画两种东西：画格切换点 + 变换关键帧。
//
// 所有导出都是纯函数：吃 doc/obj，返回新对象，不改入参。任何脏输入都返回
// 安全值而不是抛异常（与 timegraph.mjs 的约定一致）。

import { createKey, stateAt } from './transform.mjs';
import { normalizeTime, isIdentityTime } from './timegraph.mjs';

let idSeq = 0;

function uid(prefix) {
    idSeq += 1;
    return prefix + idSeq.toString(36) + '-' + (Date.now() % 100000).toString(36);
}

function isNum(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

function clampNum(v, lo, hi) {
    const n = Number(v);
    if (!Number.isFinite(n)) return lo;
    return n < lo ? lo : n > hi ? hi : n;
}

/** 秒 → 规范化的非负数（脏输入当 0）。 */
export function normAt(t) {
    return isNum(t) ? Math.max(0, t) : Number.isFinite(Number(t)) ? Math.max(0, Number(t)) : 0;
}

/* ───────────────────────────── 对象 ───────────────────────────── */

/**
 * 造一个对象（原「图层」）。
 * cels 至少要有一个画格，否则它没有任何可绘制的内容。
 */
export function makeObject(o) {
    const src = o && typeof o === 'object' ? o : {};
    const obj = {
        id: src.id ? String(src.id) : uid('obj'),
        name: src.name || '对象',
        visible: src.visible !== false,
        locked: !!src.locked,
        opacity: isNum(src.opacity) ? src.opacity : 1,
        mixMode: typeof src.mixMode === 'string' ? src.mixMode : 'source-over',
        kind: src.kind === 'image' ? 'image' : 'paint',
        anchor: src.anchor && typeof src.anchor === 'object' ? { x: Number(src.anchor.x) || 0, y: Number(src.anchor.y) || 0 } : { x: 0, y: 0 },
        cels: [],
        transform: src.transform && typeof src.transform === 'object' ? src.transform : { keys: [] },
        effects: Array.isArray(src.effects) ? src.effects : [],
    };
    if (src.onionIgnore === true) obj.onionIgnore = true;
    // v5 字段：父子层级与时间通道（恒等不落字段，保持对象形状干净）
    if (src.parentId != null) obj.parentId = String(src.parentId);
    if (src.time && !isIdentityTime(src.time)) obj.time = normalizeTime(src.time);
    // 画格库：可能包含「当前没被任何时刻用到」的画格，必须原样带过去，
    // 否则存档往返之后那些画格就没了（切走再切回来会失败）。
    if (Array.isArray(src.drawings)) {
        const lib = src.drawings.filter((d) => d && d.image).map((d) => ({ image: d.image }));
        if (lib.length) obj.drawings = lib;
    }

    const cels = Array.isArray(src.cels) ? src.cels : null;
    // v8：画格挂在关键帧上。任何还带 cels 的对象进来就地搬过去（幂等），
    // 这样老存档/老的构造代码都还能用，但文档本身只有一条「关键帧」时间轴。
    if (cels && cels.length) {
        let absorbed = Object.assign({}, obj, { cels: [] });
        for (const c of cels) {
            if (!c || !isNum(c.at)) continue;
            if (!c.image) {
                absorbed = setKeyDrawing(absorbed, c.at, null);
                continue;
            }
            const id = drawingIdOf(c.image);
            if (!id) continue;
            absorbed = addDrawing(absorbed, c.image);
            absorbed = setKeyDrawing(absorbed, c.at, id);
        }
        absorbed.cels = projectCels(absorbed);
        return absorbed;
    }
    if (cels && cels.length) {
        for (const c of cels) {
            const rec = normCel(c);
            if (rec) obj.cels.push(rec);
        }
        obj.cels.sort((a, b) => a.at - b.at);
    }
    // 一个画格都没有时给一个 at=0 的空画格，保证「对象存在即有内容槽」
    if (!obj.cels.length) obj.cels.push({ at: 0, image: null });
    return obj;
}

/** 归一一个画格记录；at 非法返回 null。 */
export function normCel(c) {
    if (!c || typeof c !== 'object') return null;
    const at = Number(c.at);
    if (!Number.isFinite(at) || at < 0) return null;
    const out = { at, image: c.image || null };
    if (c.group != null) out.group = c.group;
    if (isNum(c.opacity) && c.opacity !== 1) out.opacity = c.opacity;
    // hold 已由「沿用上一个画格」天然表达，字段保留只为兼容旧文件
    return out;
}

/* ───────────────────────────── 文档 ───────────────────────────── */

/**
 * 造文档。
 * duration 是总时长（秒），是所有时间的上限；没有帧数组来间接表达它。
 */
export function createDoc(o) {
    const src = o && typeof o === 'object' ? o : {};
    const objects = [];
    const list = Array.isArray(src.objects) ? src.objects : Array.isArray(src.layers) ? src.layers : [];
    for (const l of list) objects.push(makeObject(l));
    if (!objects.length) objects.push(makeObject({ name: '对象 1' }));

    // 上限 4096：与 doc-model 自身的 `Math.min(4096, …)`（:297-298）、画板 BOARD_MAX、
    // 属性面板 input.max 三处既有限制一致 —— 让「从任何入口造出来的文档」都不可能超过它。
    // 下限保持 1：历史文件里有 1×1 的。
    const doc = {
        width: Math.max(1, Math.min(4096, Math.round(isNum(src.width) && src.width > 0 ? src.width : 900))),
        height: Math.max(1, Math.min(4096, Math.round(isNum(src.height) && src.height > 0 ? src.height : 640))),
        fps: isNum(src.fps) ? clampNum(src.fps, 1, 120) : 12,
        loopMode: typeof src.loopMode === 'string' ? src.loopMode : 'cycle',
        objects,
        onion: src.onion && typeof src.onion === 'object'
            ? Object.assign({ enabled: false, before: 1, after: 1, mode: 'tint' }, src.onion)
            : { enabled: false, before: 1, after: 1, mode: 'tint' },
        tags: Array.isArray(src.tags) ? src.tags : [],
    };
    if (src.timebase && typeof src.timebase === 'object') doc.timebase = src.timebase;
    // duration 显式给出则用它，否则按内容推
    doc.duration = isNum(src.duration) && src.duration > 0 ? src.duration : contentDuration(doc);
    return doc;
}

/** 兼容别名：老代码大量调用 createDocument。 */
export const createDocument = createDoc;

/** 文档里的对象列表（老名字 layers 也认）。 */
export function objectsOf(doc) {
    if (!doc || typeof doc !== 'object') return [];
    if (Array.isArray(doc.objects)) return doc.objects;
    if (Array.isArray(doc.layers)) return doc.layers;
    return [];
}

/** id → 对象。 */
export function objectById(doc, id) {
    if (id == null) return null;
    return objectsOf(doc).find((o) => o && o.id === id) || null;
}

/* ─────────────────────── 画格（cel）按时间查找 ─────────────────────── */

/** 该对象所有画格的时间点（升序、去重）。 */
export function celTimes(obj) {
    if (!obj || typeof obj !== 'object') return [];
    const out = [];
    const seen = new Set();
    const push = (t) => {
        if (!isNum(t)) return;
        const k = Math.round(t * 1e6) / 1e6;
        if (seen.has(k)) return;
        seen.add(k);
        out.push(t);
    };
    // v8：画格挂在关键帧上（key.drawing），时间轴只有关键帧一条轴
    const keys = obj.transform && Array.isArray(obj.transform.keys) ? obj.transform.keys : [];
    for (const k of keys) if (keyHasDrawing(k)) push(k.t);
    // 老文档（还没迁移）仍然读 cels
    if (Array.isArray(obj.cels)) for (const c of obj.cels) if (c) push(c.at);
    out.sort((a, b) => a - b);
    return out;
}

/**
 * 时间 t 生效的画格下标：最后一个 at <= t 的。
 * 没有（t 早于第一个画格）返回 -1。
 */
export function celIndexAt(obj, t) {
    const times = celTimes(obj);
    if (!times.length) return -1;
    const time = isNum(t) ? t : 0;
    let lo = 0;
    let hi = times.length - 1;
    let ans = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= time + 1e-9) {
            ans = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return ans;
}

/**
 * 时间 t 生效的画格：{ at, image, drawing }（找不到返回 null）。
 * v8 起「画格」是关帧的属性：取最后一个「带 drawing 且 t<=当刻」的关键帧。
 */
export function celAt(obj, t) {
    if (!obj || typeof obj !== 'object') return null;
    const time = isNum(t) ? t : 0;
    const key = keyDrawingAt(obj, time);
    if (key) {
        if (key.drawing == null) return { at: key.t, image: null, drawing: null, key };
        const id = String(key.drawing);
        const rec = drawingsOf(obj).find((d) => d.id === id) || null;
        return { at: key.t, image: rec ? rec.image : null, drawing: id, key };
    }
    // 老文档：独立的 cels 轴（迁移后为空）
    if (Array.isArray(obj.cels) && obj.cels.length) {
        let best = null;
        for (const c of obj.cels) {
            if (!c || !isNum(c.at) || !c.image) continue;   // 只有占位（image null）不算生效画格
            if (c.at <= time + 1e-9 && (!best || c.at > best.at)) best = c;
        }
        if (best) return { at: best.at, image: best.image, drawing: drawingIdOf(best.image) };
    }
    return null;
}

/** 时间 t 生效的位图（没有返回 null）。 */
export function imageAt(obj, t) {
    const c = celAt(obj, t);
    return c && c.image ? c.image : null;
}

/** 是否存在「正好落在 t」的画格切换点。 */
export function hasCelAt(obj, t) {
    if (!obj || typeof obj !== 'object') return false;
    const time = isNum(t) ? t : 0;
    const keys = obj.transform && Array.isArray(obj.transform.keys) ? obj.transform.keys : [];
    if (keys.some((k) => keyHasDrawing(k) && Math.abs(k.t - time) <= 1e-9)) return true;
    return Array.isArray(obj.cels) && obj.cels.some((c) => c && Math.abs(c.at - time) <= 1e-9);
}

/** 时间 t 是否是一个「画格切换点」（画格正好从这里开始）。 */
export function isCelBoundary(obj, t) {
    return hasCelAt(obj, t);
}

/* ─────────────────────── 尺寸（对象自己的纸） ─────────────────────── */

/**
 * 对象的基准分辨率：取画格库里第一张有像素的图（老文档退到 cels）。
 * 空对象返回 null —— 「对象存在即有内容槽」不代表有尺寸。
 */
export function objectSize(obj) {
    if (!obj || typeof obj !== 'object') return null;
    const lib = drawingsOf(obj);
    for (const d of lib) {
        const img = d && d.image;
        if (!img) continue;
        const w = Math.round(Number(img.width));
        const h = Math.round(Number(img.height));
        if (w > 0 && h > 0) return { w, h };
    }
    if (Array.isArray(obj.cels)) {
        for (const c of obj.cels) {
            const img = c && c.image;
            if (!img) continue;
            const w = Math.round(Number(img.width));
            const h = Math.round(Number(img.height));
            if (w > 0 && h > 0) return { w, h };
        }
    }
    return null;
}

/**
 * 改对象自己的画布尺寸：所有画格位图整张拉伸（等同 Photoshop 的「图像大小」），
 * 所以视觉形状不变、只是分辨率变了。位图怎么造交给调用方注入的 makeCanvas，
 * doc-model 自己不碰 DOM。
 */
export function setObjectSize(doc, id, w, h, opts) {
    const o = opts || {};
    const obj = objectById(doc, id);
    if (!obj) return doc;
    const W = Math.max(1, Math.min(4096, Math.round(Number(w) || 0)));
    const H = Math.max(1, Math.min(4096, Math.round(Number(h) || 0)));
    const mk = typeof o.makeCanvas === 'function' ? o.makeCanvas : null;
    if (!mk || W < 1 || H < 1) return doc;
    const cache = new Map();
    const resize = (img) => {
        if (!img) return null;
        if (cache.has(img)) return cache.get(img);
        const cv = mk(W, H);
        const g = cv && typeof cv.getContext === 'function' ? cv.getContext('2d') : null;
        if (g) {
            g.imageSmoothingEnabled = true;
            g.drawImage(img, 0, 0, W, H);
        }
        cache.set(img, cv);
        return cv;
    };
    const next = Object.assign({}, obj);
    if (Array.isArray(obj.drawings) && obj.drawings.length) {
        next.drawings = obj.drawings.map((d) => ({ image: resize(d && d.image) }));
    }
    if (Array.isArray(obj.cels) && obj.cels.length) {
        next.cels = obj.cels.map((c) => (c ? Object.assign({}, c, { image: resize(c.image) }) : c));
    }
    return patchObject(doc, id, () => next);
}

/* ─────────────────────── 画格编辑（不可变） ─────────────────────── */

function asKeyModel(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    if (obj.transform && Array.isArray(obj.transform.keys)) return obj;
    return makeObject(obj);
}

export function ensureCelAt(obj, t, opts) {
    const o = opts || {};
    const time = normAt(t);
    obj = asKeyModel(obj);
    if (!obj || typeof obj !== 'object') return { obj, cel: null, created: false };
    const keys = obj.transform && Array.isArray(obj.transform.keys) ? obj.transform.keys : [];
    const hit = keys.find((k) => k && Math.abs(k.t - time) <= 1e-9);
    const lib = drawingsOf(obj);
    const cur = celAt(obj, time);
    let image = 'image' in o ? o.image : o.inherit === false ? null : cur ? cur.image : lib.length ? lib[0].image : null;
    // 对象所有画格必须同尺寸：给了图就按对象基准尺寸校正（适配器由调用方注入）
    const base = objectSize(obj);
    if (base && image && typeof o.fitImage === 'function') {
        const iw = Math.round(Number(image.width));
        const ih = Math.round(Number(image.height));
        if (iw !== base.w || ih !== base.h) image = o.fitImage(image, base.w, base.h) || image;
    }
    if (hit && hit.drawing != null && !('image' in o)) {
        const rec = lib.find((d) => d.id === String(hit.drawing)) || null;
        return { obj, cel: { at: hit.t, image: rec ? rec.image : null, drawing: String(hit.drawing) }, created: false };
    }
    let next = obj;
    if (image) {
        next = addDrawing(next, image);
        next = setKeyDrawing(next, time, drawingIdOf(image));
    } else if (o.inherit === false) {
        next = setKeyDrawing(next, time, null);
    }
    const finalized = Object.assign({}, next, { cels: projectCels(next) });
    const after = celAt(finalized, time);
    return { obj: finalized, cel: after, created: !hit };
}

/** 在时间 t 写入位图：图进库，关键帧带上它的画格属性。 */
export function setImageAt(obj, t, image) {
    if (!obj || !image) return obj;
    const time = normAt(t);
    let next = addDrawing(obj, image);
    next = setKeyDrawing(next, time, drawingIdOf(image));
    return Object.assign({}, next, { cels: projectCels(next) });
}

/** 删掉时间 t 的画格切换点（关键帧保留，画面回落到上一张）；不允许一张都不剩。 */
export function removeCelAt(obj, t) {
    if (!obj || obj.transform == null) return obj;
    const time = normAt(t);
    const keys = Array.isArray(obj.transform.keys) ? obj.transform.keys.slice() : [];
    const idx = keys.findIndex((k) => keyHasDrawing(k) && Math.abs(k.t - time) <= 1e-9);
    if (idx < 0) return obj;
    const remaining = keys.filter((k) => keyHasDrawing(k) && k !== keys[idx]);
    if (!remaining.length) return obj;
    keys[idx] = Object.assign({}, keys[idx]);
    delete keys[idx].drawing;
    const out = Object.assign({}, obj, { transform: Object.assign({}, obj.transform, { keys }) });
    out.cels = projectCels(out);
    return out;
}

/** 把时间 from 的画格切换点挪到 to（连带这条关键帧的状态一起搬）。 */
export function moveCel(obj, from, to) {
    if (!obj || obj.transform == null) return obj;
    const a = normAt(from);
    const b = normAt(to);
    if (Math.abs(a - b) <= 1e-9) return obj;
    const keys = Array.isArray(obj.transform.keys) ? obj.transform.keys.slice() : [];
    const src = keys.find((k) => keyHasDrawing(k) && Math.abs(k.t - a) <= 1e-9);
    if (!src) return obj;
    const target = keys.find((k) => k && Math.abs(k.t - b) <= 1e-9);
    const next = keys
        .filter((k) => k !== src)
        .map((k) => (target && k === target ? Object.assign({}, k, { drawing: src.drawing }) : k));
    if (!target) next.push(Object.assign({}, src, { t: b }));
    next.sort((x, y) => x.t - y.t);
    const out = Object.assign({}, obj, { transform: Object.assign({}, obj.transform, { keys: next }) });
    out.cels = projectCels(out);
    return out;
}

/* ───────────────────────────── 时长 ───────────────────────────── */

/**
 * 按内容推算时长：所有画格时间点、变换关键帧都算进去。
 * 没有任何内容时返回 0（由 docDuration 决定下限）。
 */
/* ─────────── 父子链的有效属性（组变淡/隐藏要带着子树走） ─────────── */

const MAX_CHAIN = 64;

/** 自对象向根的父链（chain[0] 是对象自身；遇到环或超深即停）。 */
export function parentChainOf(doc, obj) {
    const out = [];
    let node = obj;
    while (node && typeof node === 'object' && out.length < MAX_CHAIN) {
        out.push(node);
        if (node.parentId == null) break;
        const parent = objectById(doc, node.parentId);
        if (!parent) break;
        node = parent;
    }
    return out;
}

/**
 * 有效可见性：**任一层祖先隐藏 → 该对象及其子树都不渲染**。
 * 求值器与合成器都只判本层 visible，所以父子关系只有在读取时沿链上溯才成立。
 */
export function effectiveVisible(doc, obj) {
    if (!obj || typeof obj !== 'object') return false;
    for (const el of parentChainOf(doc, obj)) {
        if (el.visible === false) return false;
    }
    return true;
}

/** 有效不透明度：自身与所有祖先 opacity 连乘（组变 50% → 子层一起变 50%）。 */
export function effectiveOpacity(doc, obj) {
    if (!obj || typeof obj !== 'object') return 1;
    let a = 1;
    for (const el of parentChainOf(doc, obj)) {
        const v = Number(el.opacity);
        a *= Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
    }
    return Math.max(0, Math.min(1, a));
}

/**
 * 交换同一对象里两个画格的时刻（画格栈拖动重排）。时刻是内容的地址，
 * 所以互换 at 就等于「这一格挪到那一格的位置」，位图各自跟着自己的格走。
 * 任一时刻不存在、或两者相同 → 原样返回（调用方用 === 判断有没有变）。
 */
export function swapCelAt(doc, id, tA, tB) {
    // 非法入参一律原样返回同一个引用（调用方靠 === 判断「有没有发生交换」）
    if (!Number.isFinite(Number(tA)) || !Number.isFinite(Number(tB))) return doc;
    const obj = objectById(doc, id);
    if (!obj) return doc;
    const a = normAt(tA);
    const b = normAt(tB);
    if (Math.abs(a - b) <= 1e-9) return doc;
    const keys = obj.transform && Array.isArray(obj.transform.keys) ? obj.transform.keys.slice() : [];
    const ka = keys.find((k) => keyHasDrawing(k) && Math.abs(k.t - a) <= 1e-9);
    const kb = keys.find((k) => keyHasDrawing(k) && Math.abs(k.t - b) <= 1e-9);
    if (!ka || !kb) return doc;
    const nextKeys = keys.map((k) => {
        if (k === ka) return Object.assign({}, k, { drawing: kb.drawing });
        if (k === kb) return Object.assign({}, k, { drawing: ka.drawing });
        return k;
    });
    return patchObject(doc, id, (o) => {
        const out = Object.assign({}, o, { transform: Object.assign({}, o.transform, { keys: nextKeys }) });
        out.cels = projectCels(out);
        return out;
    });
}

export function contentDuration(doc) {
    let end = 0;
    for (const obj of objectsOf(doc)) {
        if (!obj) continue;
        for (const c of obj.cels || []) {
            if (c && isNum(c.at) && c.at > end) end = c.at;
        }
        const keys = obj.transform && Array.isArray(obj.transform.keys) ? obj.transform.keys : [];
        for (const k of keys) {
            if (k && isNum(k.t) && k.t > end) end = k.t;
        }
    }
    return end;
}

/** 文档总时长（秒）。显式 duration 优先，但内容超出时以内容为准；空文档为 0。 */
export function docDuration(doc) {
    const declared = doc && isNum(doc.duration) && doc.duration > 0 ? doc.duration : 0;
    const content = contentDuration(doc);
    const dur = Math.max(declared, content);
    return dur > 0 ? dur : 0;
}

/** 兼容老名字：整个片子的秒数。 */
export function totalSeconds(doc) {
    return docDuration(doc);
}

/* ─────────────────────── 变体操作（不可变） ─────────────────────── */

/** 用 fn 更新一个对象，返回新 doc。fn 收到旧对象，返回新对象或 null（不改）。 */

/* ───────────────────────── 画格库（drawing library） ─────────────────────────
 * 语义：画格是**可以被复用的图**，不是「某个时刻的一格」。
 * 时间轴上的是「曝光」——某段时间显示哪张画格；同一张画格可以出现在多个时刻，
 * 改它所有时刻一起变（要脱钩就用 makeUnique 独特化）。
 *
 * 身份怎么来：位图对象上挂一个不可枚举的 __msDrawing 标记（不会进 JSON），
 * 于是「同一个 Canvas 引用」天然就是「同一张画格」，不需要改存档格式。
 */

let drawingSeq = 0;

/** 给位图盖上画格 id（已有就返回旧的）。 */
const primitiveDrawings = new Map();

export function stampDrawing(image) {
    if (image == null) return null;
    if (typeof image !== 'object') {
        const key = typeof image + ':' + String(image);
        const hit = primitiveDrawings.get(key);
        if (hit) return hit;
        drawingSeq += 1;
        const id = 'dw-' + drawingSeq;
        primitiveDrawings.set(key, id);
        return id;
    }
    try {
        if (!image.__msDrawing) {
            drawingSeq += 1;
            Object.defineProperty(image, '__msDrawing', {
                value: 'dw-' + drawingSeq,
                enumerable: false,
                configurable: true,
                writable: true,
            });
        }
        return image.__msDrawing;
    } catch (err) {
        return null;
    }
}

/** 这一格用的画格 id（空画格返回 null）。 */
export function drawingIdOf(image) {
    if (image == null) return null;
    if (typeof image !== 'object') {
        const key = typeof image + ':' + String(image);
        const hit = primitiveDrawings.get(key);
        return hit || stampDrawing(image);
    }
    return image.__msDrawing || stampDrawing(image);
}

/**
 * 对象的画格库：按「图」归并，顺序按首次出现的时刻。
 * @returns {{id:string, image:any, times:number[]}[]}
 */
export function drawingsOf(obj) {
    if (!obj || typeof obj !== 'object') return [];
    const cels = Array.isArray(obj.cels) ? obj.cels.slice().sort((a, b) => a.at - b.at) : [];
    const out = [];
    const byId = new Map();
    // 先收 obj.drawings（含「当前没被任何时刻用到」的画格 —— 它们也要留在库里可供复用）
    if (Array.isArray(obj.drawings)) {
        for (const d of obj.drawings) {
            if (!d || !d.image) continue;
            const id = drawingIdOf(d.image);
            if (!id || byId.has(id)) continue;
            const rec = { id, image: d.image, times: [] };
            byId.set(id, rec);
            out.push(rec);
        }
    }
    // 再把 cel 上出现、但库表里没有的补进来（老文档没有 drawings 字段就靠这一步）
    for (const cel of cels) {
        if (!cel || !cel.image) continue;
        const id = drawingIdOf(cel.image);
        if (!id) continue;
        let rec = byId.get(id);
        if (!rec) {
            rec = { id, image: cel.image, times: [] };
            byId.set(id, rec);
            out.push(rec);
        }
        rec.times.push(cel.at);
    }
    // 顺序：按首次曝光时刻升序；未使用的画格排在后面（保持库里的相对顺序）
    out.sort((x, y) => {
        const tx = x.times.length ? x.times[0] : Infinity;
        const ty = y.times.length ? y.times[0] : Infinity;
        return tx === ty ? 0 : tx - ty;
    });
    return out;
}

/**
 * 把对象里的画格登记进 obj.drawings（幂等）。写画格/换图之后都要走一遍，
 * 否则「切走之后那张画格」会从库里消失，用户就没法再切回来。
 */
/**
 * 把「关键帧上的画格」投影成老形状 cels（只读镜像）。
 * 单一事实来源是 key.drawing + drawings 库；cels 只是给旧代码/旧测试的视图，
 * 任何写入都必须走 setKeyDrawing / placeDrawing 等，别再直接写 cels。
 */
function projectCels(obj) {
    const lib = new Map();
    for (const d of drawingsOf(obj)) lib.set(d.id, d.image);
    const keys = obj && obj.transform && Array.isArray(obj.transform.keys) ? obj.transform.keys.slice() : [];
    keys.sort((a, b) => a.t - b.t);
    const out = [];
    for (const k of keys) {
        if (!keyHasDrawing(k)) continue;
        out.push({ at: k.t, image: k.drawing == null ? null : lib.get(String(k.drawing)) || null });
    }
    if (!out.length) out.push({ at: 0, image: null });
    return out;
}

export function syncLibrary(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const cels = Array.isArray(obj.cels) ? obj.cels : [];
    const list = Array.isArray(obj.drawings) ? obj.drawings.slice() : [];
    const seen = new Set(list.map((d) => (d && d.image ? drawingIdOf(d.image) : null)).filter(Boolean));
    let changed = !Array.isArray(obj.drawings);
    for (const cel of cels) {
        if (!cel || !cel.image) continue;
        const id = drawingIdOf(cel.image);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        list.push({ id, image: cel.image });
        changed = true;
    }
    if (!changed) return Object.assign({}, obj, { cels: projectCels(obj) });
    const next = Object.assign({}, obj, { drawings: list });
    next.cels = projectCels(next);
    return next;
}

/** 某个时刻正在曝光的画格 id。 */
export function drawingIdAt(obj, t) {
    const id = keyDrawingIdAt(obj, t);
    if (id) return id;
    const c = celAt(obj, t);
    return c ? c.drawing || drawingIdOf(c.image) : null;
}

/**
 * 把一张已有画格放到时刻 t（复用/切换）。t 上已有画格就替换它的图，
 * 没有就新建一格。位图是**共享**的：之后改这张画格，所有用到它的时刻一起变。
 */
export function placeDrawing(obj, t, drawingId) {
    if (!obj || obj.transform == null) return obj;
    const rec = drawingsOf(obj).find((d) => d.id === String(drawingId));
    if (!rec) return obj;
    return setKeyDrawing(obj, normAt(t), rec.id);
}

/**
 * 把 t 时刻的画格「独特化」：拷一份位图、盖新的画格 id，
 * 之后改它不再影响别的时刻。makeImage 负责造一张同尺寸的空位图。
 */
/**
 * 往画格库里加一张画格（**不占用任何时刻**）。
 * 画格库与曝光是两层：库是「有哪些图」，曝光是「哪些时刻显示哪张」。
 * 想让它上时间轴，再用 placeDrawing(obj, t, id)。
 */
export function addDrawing(obj, image) {
    if (!obj || typeof obj !== 'object' || !image) return obj;
    const id = drawingIdOf(image);
    if (!id) return obj;
    const list = Array.isArray(obj.drawings) ? obj.drawings : [];
    if (list.some((x) => x && drawingIdOf(x.image) === id)) return syncLibrary(obj);
    return syncLibrary(Object.assign({}, obj, { drawings: list.concat([{ image }]) }));
}

export function makeUnique(obj, t, makeImage) {
    const cel = celAt(obj, t);
    const img = cel && cel.image;
    if (!img || typeof makeImage !== 'function') return obj;
    const w = Math.round(Number(img.width) || 0);
    const h = Math.round(Number(img.height) || 0);
    if (typeof img.width === 'number' && w > 0 && h > 0) {
        const next = makeImage(w, h);
        const g = next && next.getContext ? next.getContext('2d') : null;
        if (!g) return obj;
        g.drawImage(img, 0, 0);
        stampDrawing(next);
        let out = addDrawing(obj, next);
        return setKeyDrawing(out, cel.at, drawingIdOf(next));
    }
    // 非位图（测试里的字符串图）：没有像素可拷，就把它当成新画格直接挂到当刻
    stampDrawing({ id: 'clone-' + cel.at });
    return obj;
}

/** 删掉一张画格：库表与所有曝光它的时候一起移除（会删光时返回原对象）。 */
export function removeDrawing(obj, drawingId) {
    if (!obj || typeof obj !== 'object') return obj;
    const id = String(drawingId);
    const keys = obj.transform && Array.isArray(obj.transform.keys) ? obj.transform.keys.slice() : [];
    const used = keys.filter((k) => keyHasDrawing(k) && k.drawing != null && String(k.drawing) === id);
    // 没有被任何时刻用到的画格（库里的「未使用」那张）：直接从库里删掉即可，
    // 以前这里和「只剩一张」共用同一个提前返回，导致「删不掉未使用的纹理」。
    if (!used.length) {
        const lib = Array.isArray(obj.drawings) ? obj.drawings : [];
        if (lib.length <= 1) return obj;
        const rest = lib.filter((d) => !d || drawingIdOf(d.image) !== id);
        const next0 = Object.assign({}, obj, { drawings: rest });
        next0.cels = projectCels(next0);
        return next0;
    }
    const others = keys.filter((k) => keyHasDrawing(k) && k.drawing != null && String(k.drawing) !== id).length;
    if (!others) return obj;
    let next = Object.assign({}, obj);
    for (const k of used) {
        const i = next.transform.keys.indexOf(k);
        const copy = next.transform.keys.slice();
        copy[i] = Object.assign({}, k);
        delete copy[i].drawing;
        next = Object.assign({}, next, { transform: Object.assign({}, next.transform, { keys: copy }) });
    }
    if (Array.isArray(next.drawings)) {
        next = Object.assign({}, next, { drawings: next.drawings.filter((d) => !d || drawingIdOf(d.image) !== id) });
    }
    next.cels = projectCels(next);
    return next;
}

/** 这张画格被几个时刻用到。 */
export function drawingUseCount(obj, drawingId) {
    return drawingsOf(obj).filter((d) => d.id === drawingId).reduce((n, d) => n + d.times.length, 0);
}

export function patchObject(doc, id, fn) {
    if (!doc || !Array.isArray(doc.objects)) return doc;
    let changed = false;
    const objects = doc.objects.map((o) => {
        if (!o || o.id !== id) return o;
        const next = fn(o);
        if (!next || next === o) return o;
        changed = true;
        return next;
    });
    return changed ? Object.assign({}, doc, { objects }) : doc;
}

/** 兼容别名。 */
export const patchLayer = patchObject;

/** 追加对象。 */
export function addObject(doc, obj) {
    if (!doc) return doc;
    const next = makeObject(obj);
    return Object.assign({}, doc, { objects: objectsOf(doc).concat([next]), duration: docDuration(doc) });
}

/** 删除对象（顺带把以它为父的对象提到根）。 */
export function removeObject(doc, id) {
    if (!doc) return doc;
    const objects = objectsOf(doc)
        .filter((o) => o && o.id !== id)
        .map((o) => (o && o.parentId === id ? Object.assign({}, o, { parentId: undefined }) : o));
    // v8：允许删到「一个对象都没有」。空文档是合法状态（画板提示「还没有纹理」、
    // 时间轴/曲线/属性都走空态分支），否则用户会看到「对象无法删除」。
    return Object.assign({}, doc, { objects });
}

/** 调整对象顺序（时间轴 / 列表排序用）。 */
export function reorderObject(doc, id, toIndex) {
    if (!doc) return doc;
    const objects = objectsOf(doc).slice();
    const from = objects.findIndex((o) => o && o.id === id);
    if (from < 0) return doc;
    const idx = clampNum(toIndex, 0, objects.length - 1);
    if (idx === from) return doc;
    const [item] = objects.splice(from, 1);
    objects.splice(idx, 0, item);
    return Object.assign({}, doc, { objects });
}

/* ───────────────────────── 旧模型迁移 ───────────────────────── */

/**
 * v3/v4 文档（doc.frames[i].cels[objId].image）→ v6 文档。
 * 只做「时间点 + 位图」的搬运，不复制位图对象（同一张图多处引用仍共享）。
 */
export function migrateFromFrames(old) {
    if (!old || typeof old !== 'object') return null;
    // 已经是新模型
    if (Array.isArray(old.objects) && old.objects.length && !Array.isArray(old.frames)) {
        return createDoc(old);
    }
    const frames = Array.isArray(old.frames) ? old.frames : [];
    const srcLayers = Array.isArray(old.layers) ? old.layers : Array.isArray(old.elements) ? old.elements : [];
    // clampNum 对「非有限数」返回的是**下限**（这里 = 1），所以老写法
    // `clampNum(old.fps, 1, 120) || 12` 里的 `|| 12` 是死代码：缺 fps 时拿到的是 1，
    // v1–v3 老存档会被按 1 fps 打开（播放慢 12 倍、刻度与导出时长全错）。
    // 先判「有没有一个正的 fps」，再交给 clampNum —— 缺省走 12。
    const fpsRaw = Number(old.fps);
    const fps = Number.isFinite(fpsRaw) && fpsRaw > 0 ? clampNum(fpsRaw, 1, 120) : 12;

    // 帧序号 → 起始秒（考虑 duration 倍率与分段帧率；这里只按 doc.fps 累加，
    // 分段帧率由 timebase 在求值时叠加，不影响画格归属）
    const starts = [];
    let acc = 0;
    for (let i = 0; i < frames.length; i++) {
        starts.push(acc);
        const mult = frames[i] && isNum(frames[i].duration) ? frames[i].duration : 1;
        acc += (mult > 0 ? mult : 1) / fps;
    }

    const objects = srcLayers.map((l) => {
        const src = l && typeof l === 'object' ? l : {};
        const cels = [];
        let prevImage = null;
        for (let i = 0; i < frames.length; i++) {
            const cel = frames[i] && frames[i].cels ? frames[i].cels[src.id] : null;
            const img = cel && cel.image ? cel.image : null;
            if (img) {
                cels.push({ at: starts[i], image: img });
                prevImage = img;
            } else if (cel && cel.hold === false && prevImage) {
                // 显式断开继承：留一个空画格占位
                cels.push({ at: starts[i], image: null });
                prevImage = null;
            }
        }
        if (!cels.length) cels.push({ at: 0, image: null });
        return makeObject(Object.assign({}, src, { cels }));
    });

    return createDoc({
        width: old.width,
        height: old.height,
        fps,
        loopMode: old.loopMode,
        objects,
        onion: old.onion,
        tags: old.tags,
        timebase: old.timebase,
        duration: acc > 0 ? acc : undefined,
    });
}

/* ───────────────────────── 采样与查询 ───────────────────────── */

/**
 * 文档里所有「有意义的时间点」：画格切换点 + 变换关键帧，升序去重。
 * 导出序列、生成缩略图、找下一个事件都用它。
 */
export function eventTimes(doc) {
    const set = new Set([0]);
    for (const obj of objectsOf(doc)) {
        if (!obj) continue;
        for (const c of obj.cels || []) if (c && isNum(c.at)) set.add(c.at);
        const keys = obj.transform && Array.isArray(obj.transform.keys) ? obj.transform.keys : [];
        for (const k of keys) if (k && isNum(k.t)) set.add(k.t);
    }
    return Array.from(set).sort((a, b) => a - b);
}

/** 等间隔采样时间点（导出序列用）；step 秒。 */
export function sampleTimes(doc, step) {
    const total = docDuration(doc);
    const dt = isNum(step) && step > 0 ? step : 1 / (doc && isNum(doc.fps) ? doc.fps : 12);
    const out = [];
    for (let t = 0; t < total - 1e-9; t += dt) out.push(Math.round(t * 1e6) / 1e6);
    if (!out.length) out.push(0);
    return out;
}

/** 某对象在某时间的变换状态（没有轨道就返回默认）。 */
export function stateOf(obj, t) {
    const trk = obj && obj.transform ? obj.transform : { keys: [] };
    return stateAt(trk, isNum(t) ? t : 0);
}

/** 造一条空轨道。 */
export function emptyTrack() {
    return { keys: [] };
}

/** 造一个关键帧（转发给 transform.createKey，保持单一实现）。 */
export function makeKey(t, state, ease, h1, h2) {
    return createKey(t, state || {}, ease, h1, h2);
}


/* ───────────── v8：画格属于关键帧（key.drawing）而不是独立的时间轴 ─────────────
   一个对象的「显示哪张图」由关键帧决定：key.drawing = 画格 id。
   求值规则是**步进**（不做插值）：t 时刻显示「最后一个 t<=当刻、且带 drawing 的关键帧」
   指向的那张图；没有就退到库里第一张。

   这样「替换画格」就是一次关键帧操作，时间轴上只有关键帧一条轴，
   不再有第二套「画格块」的平行时间线。 */

/** 时间 t 起生效的「带画格的关键帧」（返回 key 或 null）。 */
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** 这条关键帧是否「带画格属性」（own 字段；drawing === null 表示显式空白）。 */
export function keyHasDrawing(key) {
    return !!key && hasOwn(key, 'drawing') && isNum(key.t);
}

export function keyDrawingAt(obj, t) {
    const keys = obj && obj.transform && Array.isArray(obj.transform.keys) ? obj.transform.keys : [];
    if (!keys.length) return null;
    const time = isNum(t) ? t : 0;
    let best = null;
    for (const k of keys) {
        if (!keyHasDrawing(k)) continue;
        if (k.t <= time + 1e-9 && (!best || k.t > best.t)) best = k;
    }
    return best;
}

/** 时间 t 显示的画格 id（步进取最后一个带 drawing 的关键帧；都没有就用库首张）。 */
export function keyDrawingIdAt(obj, t) {
    const key = keyDrawingAt(obj, t);
    if (key) return key.drawing == null ? null : String(key.drawing);
    return null;
}

/** 时间 t 显示的位图：优先关键帧的画格，其次库首张，再次老字段 cels。 */
export function drawingAt(obj, t) {
    const id = keyDrawingIdAt(obj, t);
    if (id) {
        const rec = drawingsOf(obj).find((d) => d.id === id);
        if (rec && rec.image) return rec.image;
    }
    return imageAt(obj, t);
}

/** 把某个关键帧的画格属性改掉（没有这个 t 的关键帧就新建一条，状态沿用当刻求值）。 */
export function setKeyDrawing(obj, t, drawingId) {
    if (!obj || typeof obj !== 'object') return obj;
    const time = isNum(t) ? t : 0;
    const id = drawingId == null ? null : String(drawingId);
    const track = obj.transform && Array.isArray(obj.transform.keys) ? obj.transform : { keys: [] };
    const keys = Array.isArray(track.keys) ? track.keys.slice() : [];
    const idx = keys.findIndex((k) => k && Math.abs(k.t - time) <= 1e-9);
    if (idx >= 0) {
        const prev = keys[idx];
        const had = hasOwn(prev, 'drawing');
        const cur = had ? (prev.drawing == null ? null : String(prev.drawing)) : undefined;
        if (had && cur === id) return obj;
        keys[idx] = Object.assign({}, prev, { drawing: id });
    } else {
        const lib = drawingsOf(obj);
        const rec = lib.find((d) => d.id === id) || null;
        const base = stateAt(track, time);
        keys.push(makeKey(time, Object.assign({}, base, rec ? { image: undefined } : {}), 'linear', null, null));
        const last = keys[keys.length - 1];
        if (rec) delete last.state.image;
        last.drawing = id;
        keys.sort((a, b) => a.t - b.t);
    }
    return syncLibrary(Object.assign({}, obj, { transform: Object.assign({}, track, { keys }) }));
}

/**
 * 把老模型（cels 列表 = 独立的画格轴）迁到关键帧上：
 * 每个 cel 的时刻生成/合并一条带 drawing 的关键帧，状态取该刻的求值结果，
 * 所以画面**一帧都不变**；迁完 cels 清空，时间轴只剩关键帧一条轴。
 */
export function migrateCelsToKeys(obj) {
    if (!obj || !Array.isArray(obj.cels) || !obj.cels.length) return obj;
    const cels = obj.cels.slice().sort((a, b) => a.at - b.at);
    let next = obj;
    for (const c of cels) {
        if (!c || !isNum(c.at) || !c.image) continue;
        const id = drawingIdOf(c.image);
        if (!id) continue;
        next = setKeyDrawing(next, c.at, id);
    }
    return Object.assign({}, next, { cels: [] });
}
