/**
 * MotionStudio —— 项目存储：文档序列化（v2 对象格式）+ 本地项目库
 *
 * 为什么需要这一层：core/cel.mjs 的 doc 里 `cel.image` 是 canvas / OffscreenCanvas，
 * **不能 JSON 化**（JSON.stringify 会把它变成 `{}`，像素全丢）。所以序列化时把每张位图
 * 压成 `{w, h, dataUrl}`，反序列化时用 `new Image()` + `await decode()` 还原成位图，
 * 再由外壳用 cel.mjs 的 setCelImage 装回去。
 *
 * 存储分两层：
 * 1. **本地项目库**（listProjects / putProject …）：Chromium 里的 IndexedDB，
 *    没有 IndexedDB 的环境（Node 单测、静态托管兜底）退化成进程内 Map，接口不变。
 * 2. **项目文件**（.msp，兼容旧的 .json）：由 ipc.mjs 走主进程的保存/打开对话框，
 *    内容就是本模块 serialize 出来的同一个结构 —— 库里的项目可以另存成文件，文件也能重新导入库。
 *
 * 文件格式（契约 v6 · 时间模型，version 4）：
 *   { format:'motionstudio-project', version:4, name, savedAt,
 *     width, height, fps, loopMode, duration, onion?, timebase?,
 *     elements:[{ id,name,visible,locked,opacity,mixMode,kind,anchor,parentId?,time?,
 *                 transform?, onionIgnore?, onClickIgnore?,
 *                 cels:[{ at, image:{ ref, w, h } | { w, h, dataUrl } | null }] }],
 *     assets:{ <对象id>:'data:image/png;base64,…', <对象id>#2:… },
 *     tags:[] }
 *
 * 时间模型：`at` 是秒，画格从 `at` 起一直生效到下一个画格；没有帧对象、没有帧计数。
 * 因此文件里**没有 frames 段落**，`duration` 由 docDuration(doc) 算出（内容时长兜底）。
 *
 * 可读形状（jsonToDoc 全部吃下）：
 *   a) v4 扁平文件（上面这个结构本身）
 *   b) 库/外壳写的信封 `{format,version,name,savedAt,doc:{…a}}`
 *   c) v1/v2/v3 节点 `{…,elements|layers:[…],frames:[…]}` —— 走 migrateFromFrames 迁移
 *
 * assets 去重规则（按位图对象身份）：每个对象的第一张位图存成 `assets[对象id]`，同一对象
 * 的第 2、3… 张不同位图存成 `assets[对象id#2]`、`#3`；引用了这些资产的画格只写
 * `image:{ref,w,h}`，base64 不重复。同一张位图被 20 个画格引用，文件里也只有 1 份。
 *
 * 约定：本模块不碰引擎、不碰 DOM 结构（只借用 canvas 做位图编码/解码），
 * 所有导出都是纯函数或幂等的存储操作，任何异常都收敛成 null / 空数组，绝不抛给调用方。
 */

import { createKey } from '../core/transform.mjs';
import { drawingsOf } from '../core/doc-model.mjs';
import { docDuration, makeObject, migrateFromFrames, objectsOf } from '../core/doc-model.mjs';

export const FORMAT = 'motionstudio-project';
export const VERSION = 4;
/** 旧版本号：v1/v2/v3 读入时按帧模型迁移（migrateFromFrames）。 */
export const VERSION_V1 = 1;
export const VERSION_V2 = 2;
/** 最后一个「带 frames」的版本；<= 它的文件都要迁移。 */
export const VERSION_FRAMES = 3;

/** 对象的缺省几何：paint = 普通绘制层，anchor 默认居中。 */
export const DEFAULT_KIND = 'paint';
const DEFAULT_ANCHOR = { x: 0.5, y: 0.5 };

/** IndexedDB 的名字与对象仓库。 */
const DB_NAME = 'motionstudio';
const DB_VERSION = 1;
const STORE = 'projects';

/** localStorage 里记住「当前项目 id」的键（库本身不放这里）。 */
const LS_CURRENT = 'klm-project';

/** 缺省文档尺寸：与外壳 DEFAULT_W/DEFAULT_H/DEFAULT_FPS 对齐，仅用于坏数据的兜底。 */
const FALLBACK = { width: 900, height: 640, fps: 12, loopMode: 'cycle' };

let idSeq = 0;
let dbPromise = null;

/** IndexedDB 不可用时的兜底仓库（Node 单测、非 Chromium 环境）。 */
const memory = new Map();

/**
 * 测试注入点：Node 里没有 document / OffscreenCanvas，纯函数单测需要替身。
 * 生产代码永远不设置它们，三个工厂都为 null 时走真实 DOM。
 */
const codec = { canvas: null, surface: null, decode: null };

/** 仅测试使用：替换位图编码 canvas / 解码 surface / dataURL 解码器（传 null 复位）。 */
export function __setCodec(next) {
    const n = next || {};
    for (const key of ['canvas', 'surface', 'decode']) {
        if (Object.prototype.hasOwnProperty.call(n, key)) codec[key] = n[key] || null;
    }
}

/** 仅测试使用：把注入点全部复位。 */
export function __resetCodec() {
    codec.canvas = null;
    codec.surface = null;
    codec.decode = null;
}

/* ─────────────────────────── 小工具 ─────────────────────────── */

function plain(obj) {
    if (obj == null) return undefined;
    try {
        return JSON.parse(JSON.stringify(obj));
    } catch (err) {
        return undefined;
    }
}

function posNumber(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** anchor 归一：`{x,y}`，非有限数一律回 0.5。 */
function normAnchor(raw) {
    if (!raw || typeof raw !== 'object') return { x: DEFAULT_ANCHOR.x, y: DEFAULT_ANCHOR.y };
    const x = Number(raw.x);
    const y = Number(raw.y);
    return {
        x: Number.isFinite(x) ? x : DEFAULT_ANCHOR.x,
        y: Number.isFinite(y) ? y : DEFAULT_ANCHOR.y,
    };
}

/* ─────────────────────────── 位图 ⇄ dataURL ─────────────────────────── */

function surfaceSize(image) {
    const w = Number(image && (image.width || image.naturalWidth));
    const h = Number(image && (image.height || image.naturalHeight));
    return { w: Number.isFinite(w) && w > 0 ? Math.round(w) : 0, h: Number.isFinite(h) && h > 0 ? Math.round(h) : 0 };
}

/** 编码用画布：生产走 document.createElement，测试走注入工厂。 */
function encodeCanvas(w, h) {
    if (codec.canvas) return codec.canvas(w, h);
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    return cv;
}

/**
 * 位图 → `{w, h, dataUrl}`。
 * 走「临时 canvas 重绘 + toDataURL」而不是 `image.toDataURL()`：
 * 浏览器里的 cel 位图是 OffscreenCanvas，它**没有** toDataURL，只有 convertToBlob（异步）。
 * 重绘一遍既是同步的，也顺手把 OffscreenCanvas / canvas / Image 三种来源统一了。
 */
export function imageToJSON(image) {
    if (!image) return null;
    const size = surfaceSize(image);
    const w = Math.max(1, size.w || 1);
    const h = Math.max(1, size.h || 1);
    let dataUrl = null;
    try {
        const cv = encodeCanvas(w, h);
        const g = cv.getContext('2d');
        if (g) {
            g.clearRect(0, 0, w, h);
            g.drawImage(image, 0, 0);
            dataUrl = cv.toDataURL('image/png');
        }
    } catch (err) {
        dataUrl = null;
    }
    return { w: w, h: h, dataUrl: dataUrl };
}

function loadImage(dataUrl) {
    return new Promise((resolve) => {
        let img;
        try {
            img = new Image();
        } catch (err) {
            resolve(null);
            return;
        }
        let settled = false;
        let guard = 0;
        const done = (v) => {
            if (settled) return;
            settled = true;
            if (guard) clearTimeout(guard);
            resolve(v);
        };
        img.onload = () => done(img);
        img.onerror = () => done(null);
        try {
            // 兜底：任何环境（含只有 onload 不触发的测试替身）都不能让载入永远挂在 await 上
            guard = setTimeout(() => done(img), 1500);
            img.src = dataUrl;
            if (typeof img.decode === 'function') {
                img.decode().then(
                    () => done(img),
                    () => done(null)
                );
            }
        } catch (err) {
            done(null);
        }
    });
}

/** dataURL → Image（测试可注入 decode 替身）。永不 reject。 */
async function decodeImage(dataUrl) {
    if (typeof dataUrl !== 'string' || !dataUrl) return null;
    if (codec.decode) {
        try {
            return (await codec.decode(dataUrl)) || null;
        } catch (err) {
            return null;
        }
    }
    return loadImage(dataUrl);
}

/** 延迟 import，避免本模块在极早期就被 paint/ 链路拖住（也方便 Node 里替换）。 */
let surfaceMod = null;
async function surfaceModule() {
    if (!surfaceMod) surfaceMod = await import('../paint/surface.mjs');
    return surfaceMod;
}

/** 造一张空白位图（生产是 canvas / OffscreenCanvas）。 */
async function newSurface(w, h) {
    if (codec.surface) return codec.surface(w, h);
    const { createSurface } = await surfaceModule();
    return createSurface(w, h);
}

/**
 * `{w,h,dataUrl}` → 位图。尺寸以存下来的 w/h 为准；
 * 缺尺寸时用解码图的自然尺寸兜底（assets 里的裸 dataURL 就走这条）。
 */
async function bitmapFromJSON(raw, cache) {
    if (!raw || typeof raw !== 'object') return null;
    const url = typeof raw.dataUrl === 'string' ? raw.dataUrl : '';
    if (url && cache && cache.has(url)) return cache.get(url);
    const image = await decodeImage(url);
    const nat = surfaceSize(image);
    const w = Math.max(1, Math.round(posNumber(raw.w, nat.w || 1)));
    const h = Math.max(1, Math.round(posNumber(raw.h, nat.h || 1)));
    const surface = await newSurface(w, h);
    if (image && surface && typeof surface.getContext === 'function') {
        try {
            const g = surface.getContext('2d');
            if (g) {
                g.setTransform(1, 0, 0, 1, 0, 0);
                g.clearRect(0, 0, w, h);
                g.drawImage(image, 0, 0);
            }
        } catch (err) {
            /* 解码失败就留一张空白位图，至少结构是对的 */
        }
    }
    if (url && cache) cache.set(url, surface);
    return surface;
}

/* ─────────────────────────── 文档 → v2 节点 ─────────────────────────── */

/** v5 时间通道 → 可 JSON 化结构（恒等一律不落盘，避免文件里全是零字段）。 */
function timeToJSON(time) {
    if (!time || typeof time !== 'object') return null;
    const mode = typeof time.mode === 'string' ? time.mode : 'none';
    const out = {};
    if (Number.isFinite(time.offset) && time.offset !== 0) out.offset = time.offset;
    if (Number.isFinite(time.scale) && time.scale !== 1) out.scale = time.scale;
    if (mode !== 'none') out.mode = mode;
    if (Number.isFinite(time.from) && time.from > 0) out.from = time.from;
    if (Number.isFinite(time.to) && time.to > 0) out.to = time.to;
    if (time.hold === true) {
        out.hold = true;
        if (Number.isFinite(time.holdAt) && time.holdAt !== 0) out.holdAt = time.holdAt;
    }
    return Object.keys(out).length ? out : null;
}

/** 变换轨道 → 可 JSON 化结构（t / state / ease / h1 / h2 全保留）。 */
function trackToJSON(track) {
    if (!track || typeof track !== 'object') return null;
    const keys = Array.isArray(track.keys) ? track.keys : [];
    const out = [];
    for (const k of keys) {
        if (!k || !Number.isFinite(k.t)) continue;
        const key = { t: k.t, state: plain(k.state) || {}, ease: k.ease || 'linear' };
        if (Array.isArray(k.h1)) key.h1 = [Number(k.h1[0]), Number(k.h1[1])];
        if (Array.isArray(k.h2)) key.h2 = [Number(k.h2[0]), Number(k.h2[1])];
        out.push(key);
    }
    return { keys: out };
}

/** 对象（v1 里叫 layer）→ v4 对象节点（cels 由 docToJSON 编码后补上）。 */
function elementToJSON(l) {
    const src = l || {};
    const out = {
        id: src.id,
        name: src.name,
        visible: !!src.visible,
        locked: !!src.locked,
        opacity: Number.isFinite(src.opacity) ? src.opacity : 1,
        mixMode: src.mixMode || 'source-over',
        kind: src.kind === 'image' ? 'image' : DEFAULT_KIND,
        anchor: normAnchor(src.anchor),
        onionIgnore: !!src.onionIgnore,
    };
    if (src.onClickIgnore) out.onClickIgnore = true;
    // v5：父子层级与时间通道（恒等值不落盘，老文件读进来也是干净对象）
    if (src.parentId != null) out.parentId = src.parentId;
    const time = timeToJSON(src.time);
    if (time) out.time = time;
    const transform = trackToJSON(src.transform);
    if (transform) out.transform = transform;
    return out;
}

/**
 * doc → v4 节点（不含 format/version 外壳，那个由 docToFile / makeRecord 加）。
 * 对象顺序、id、变换轨道、画格时间点、标签、洋葱皮设置全保留；只有位图变 dataURL。
 * 文件里没有 frames：画格是 `{ at, image }`，at 为秒。
 */
export function docToJSON(doc) {
    if (!doc || typeof doc !== 'object') return null;
    const srcObjects = objectsOf(doc);

    // 同一个位图对象只编码一次（几十个画格共用一张图 → 1 次 toDataURL）。
    const encoded = new Map();
    const encode = (image) => {
        if (!image) return null;
        if (encoded.has(image)) return encoded.get(image);
        const out = imageToJSON(image);
        encoded.set(image, out);
        return out;
    };

    const elements = srcObjects.map(elementToJSON);
    const assets = {};

    for (let i = 0; i < srcObjects.length; i++) {
        const src = srcObjects[i];
        const el = elements[i];
        const cels = Array.isArray(src && src.cels) ? src.cels : [];
        // 位图对象身份 → assets key：该对象第 1 张图用对象 id，第 2、3… 张用 `id#2`、`id#3`
        const refs = new Map();
        const assetKeys = [];
        const outCels = [];
        for (const cel of cels) {
            const at = Number(cel && cel.at);
            const item = encode(cel && cel.image);
            let image = null;
            if (item) {
                const url = typeof item.dataUrl === 'string' ? item.dataUrl : '';
                if (url && cel && cel.image) {
                    if (!refs.has(cel.image)) {
                        const key = assetKeys.length === 0 ? el.id : el.id + '#' + (assetKeys.length + 1);
                        refs.set(cel.image, key);
                        assetKeys.push({ key: key, url: url });
                    }
                    image = { ref: refs.get(cel.image), w: item.w, h: item.h };
                } else {
                    image = { w: item.w, h: item.h };
                }
            }
            outCels.push({ at: Number.isFinite(at) && at > 0 ? Math.round(at * 1000) / 1000 : 0, image: image });
        }
        // 画格库：obj.drawings 里的每张图都要有 assets key，
        // 这样「切走之后暂时没用到的画格」也能存档，重新打开还能切回来。
        // 画格库：以 drawingsOf 的库视图为准（关键帧上引用的画格 + 暂时没被用到的画格都在里面）
        const drawings = drawingsOf(src);
        const outDrawings = [];
        for (const d of drawings) {
            if (d && d.drawing === null) continue;
            const item = encode(d && d.image);
            if (!item) continue;
            const url = typeof item.dataUrl === 'string' ? item.dataUrl : '';
            if (!url || !d.image) continue;
            if (!refs.has(d.image)) {
                const key = assetKeys.length === 0 ? el.id : el.id + '#' + (assetKeys.length + 1);
                refs.set(d.image, key);
                assetKeys.push({ key: key, url: url });
            }
            outDrawings.push({ ref: refs.get(d.image), w: item.w, h: item.h });
        }
        for (const a of assetKeys) assets[a.key] = a.url;
        el.cels = outCels.length ? outCels : [{ at: 0, image: null }];
        if (outDrawings.length) el.drawings = outDrawings;
    }

    const out = {
        width: Math.max(1, Math.round(posNumber(doc.width, FALLBACK.width))),
        height: Math.max(1, Math.round(posNumber(doc.height, FALLBACK.height))),
        fps: Number.isFinite(doc.fps) && doc.fps > 0 ? doc.fps : FALLBACK.fps,
        loopMode: doc.loopMode || FALLBACK.loopMode,
        duration: Math.round(docDuration(doc) * 1000) / 1000,
        elements: elements,
        assets: assets,
        tags: Array.isArray(doc.tags) ? plain(doc.tags) || [] : [],
    };
    const onion = plain(doc.onion);
    if (onion) out.onion = onion;
    // v5 时间轴分段（timebase.mjs）原样透传
    const timebase = plain(doc.timebase);
    if (timebase) out.timebase = timebase;
    return out;
}

/** doc → §6 扁平项目文件对象（.msp 落盘就是它的 JSON.stringify）。 */
export function docToFile(doc, meta) {
    const node = docToJSON(doc);
    if (!node) return null;
    const m = meta || {};
    const name = String(m.name == null ? '' : m.name).trim() || '未命名项目';
    return Object.assign(
        {
            format: FORMAT,
            version: VERSION,
            name: name,
            savedAt: Number.isFinite(m.savedAt) ? m.savedAt : Date.now(),
        },
        node
    );
}

/* ─────────────────────────── v4 节点 → 文档 ─────────────────────────── */

/**
 * 剥掉可能的外壳，拿到「文档节点」：
 * 信封 `{…,doc:{…}}` → doc；扁平文件 / v1 节点 / v4 节点 → 自己。
 * 顶层 format 存在且不认识时返回 null（别的应用的文件不该被当项目读进来）。
 */
export function projectNode(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.format != null && obj.format !== FORMAT) return null;
    const inner = obj.doc;
    if (inner && typeof inner === 'object' && !Array.isArray(inner)) return inner;
    return obj;
}

/** 节点里的对象数组：v4 是 elements（doc 内也可能是 objects），v1 是 layers。 */
function elementList(node) {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node.elements)) return node.elements;
    if (Array.isArray(node.objects)) return node.objects;
    if (Array.isArray(node.layers)) return node.layers;
    return [];
}

/** v5 时间通道反序列化：非法输入返回 null（等价恒等，不写字段）。 */
function timeFromJSON(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    if (Number.isFinite(raw.offset)) out.offset = raw.offset;
    if (Number.isFinite(raw.scale)) out.scale = raw.scale;
    if (typeof raw.mode === 'string') out.mode = raw.mode;
    if (Number.isFinite(raw.from)) out.from = raw.from;
    if (Number.isFinite(raw.to)) out.to = raw.to;
    if (raw.hold === true) out.hold = true;
    if (Number.isFinite(raw.holdAt)) out.holdAt = raw.holdAt;
    return Object.keys(out).length ? out : null;
}

/** 轨道归一：坏关键帧跳过，ease/h1/h2 交给 createKey 归一。 */
function trackFromJSON(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const keys = Array.isArray(raw.keys) ? raw.keys : [];
    const out = [];
    for (const k of keys) {
        if (!k || typeof k !== 'object') continue;
        const t = Number(k.t);
        if (!Number.isFinite(t)) continue;
        const h1 = Array.isArray(k.h1) ? [Number(k.h1[0]), Number(k.h1[1])] : undefined;
        const h2 = Array.isArray(k.h2) ? [Number(k.h2[0]), Number(k.h2[1])] : undefined;
        try {
            out.push(createKey(t, plain(k.state) || {}, k.ease, h1, h2));
        } catch (err) {
            /* 单个坏关键帧不该毁掉整个项目 */
        }
    }
    out.sort((a, b) => a.t - b.t);
    return { keys: out };
}

/** 文件版本号：外壳（信封）上的优先，其次节点自身。 */
function fileVersion(json, node) {
    const a = json && typeof json === 'object' ? Number(json.version) : NaN;
    if (Number.isFinite(a)) return a;
    const b = Number(node && node.version);
    return Number.isFinite(b) ? b : NaN;
}

/** 是不是「帧模型」节点：带 frames，或对象里还没有 cels。 */
function isFrameNode(node, version) {
    if (Array.isArray(node.frames) && node.frames.length) return true;
    if (Number.isFinite(version) && version <= VERSION_FRAMES) return true;
    const list = elementList(node);
    return list.length > 0 && list.every((o) => o && typeof o === 'object' && !Array.isArray(o.cels));
}

/** 文件里的对象节点 → 干净对象外壳（不含 cels，位图要等解码）。 */
function elementShell(src, i) {
    const s = src && typeof src === 'object' ? src : {};
    const element = {
        id: s.id ? String(s.id) : 'element' + (++idSeq) + '-' + i,
        name: s.name || '对象 ' + (i + 1),
        visible: s.visible !== false,
        locked: !!s.locked,
        opacity: Number.isFinite(s.opacity) ? s.opacity : 1,
        mixMode: s.mixMode || 'source-over',
        // v1 没有 kind / anchor：升级时补 paint + 居中锚点
        kind: s.kind === 'image' ? 'image' : DEFAULT_KIND,
        anchor: normAnchor(s.anchor),
        onionIgnore: !!s.onionIgnore,
    };
    if (s.onClickIgnore) element.onClickIgnore = true;
    // v5：parentId 与时间通道；缺省时不写字段（保持对象形状干净）
    if (s.parentId != null) element.parentId = String(s.parentId);
    const time = timeFromJSON(s.time);
    if (time) element.time = time;
    const track = trackFromJSON(s.transform);
    if (track) element.transform = track;
    return element;
}

/** 文档外壳：尺寸/循环/时长/标签/洋葱皮/时间轴分段（objects 由调用方造好）。 */
function docShell(node, objects, opts) {
    const doc = {
        width: Math.max(1, Math.round(posNumber(node.width, FALLBACK.width))),
        height: Math.max(1, Math.round(posNumber(node.height, FALLBACK.height))),
        fps: Number.isFinite(node.fps) && node.fps > 0 ? node.fps : FALLBACK.fps,
        loopMode: node.loopMode || FALLBACK.loopMode,
        objects: objects,
        tags: Array.isArray(node.tags) ? plain(node.tags) || [] : [],
    };
    const declared = Number(node.duration);
    if (Number.isFinite(declared) && declared > 0) doc.duration = declared;
    const o = opts || {};
    const onion = plain(o.onion !== undefined ? o.onion : node.onion);
    if (onion) doc.onion = onion;
    const timebase = plain(node.timebase);
    if (timebase) doc.timebase = timebase;
    return doc;
}

/** assets → 位图：key 可以是对象 id（v2 assets），也可以是 `对象id#2`（v4 多张图）。 */
async function decodeAssets(node, dims, cache) {
    const rawAssets = node.assets && typeof node.assets === 'object' ? node.assets : {};
    const out = new Map();
    for (const key of Object.keys(rawAssets)) {
        const url = rawAssets[key];
        if (typeof url !== 'string' || !url) continue;
        const d = dims.get(key) || {};
        out.set(key, await bitmapFromJSON({ w: d.w, h: d.h, dataUrl: url }, cache));
    }
    return out;
}

/** v4 节点：对象自带 cels（时间模型）。 */
async function docFromTimeNode(node, cache, opts) {
    const rawElements = elementList(node);
    // 资产尺寸藏在引用它的画格里（`image:{ ref, w, h }`）
    const refDims = new Map();
    for (const el of rawElements) {
        const cels = Array.isArray(el && el.cels) ? el.cels : [];
        for (const cel of cels) {
            const img = cel && cel.image;
            if (img && typeof img === 'object' && typeof img.ref === 'string' && !refDims.has(img.ref)) {
                refDims.set(img.ref, { w: img.w, h: img.h });
            }
        }
        const drawings = Array.isArray(el && el.drawings) ? el.drawings : [];
        for (const d of drawings) {
            if (d && typeof d.ref === 'string' && !refDims.has(d.ref)) refDims.set(d.ref, { w: d.w, h: d.h });
        }
    }
    const assetImages = await decodeAssets(node, refDims, cache);

    const objects = [];
    for (let i = 0; i < rawElements.length; i++) {
        const src = rawElements[i];
        const shell = elementShell(src, i);
        const cels = [];
        const rawCels = Array.isArray(src && src.cels) ? src.cels : [];
        for (const cel of rawCels) {
            const at = Number(cel && cel.at);
            if (!Number.isFinite(at) || at < 0) continue;
            const raw = cel && cel.image;
            let image = null;
            if (raw && typeof raw === 'object') {
                if (typeof raw.ref === 'string' && assetImages.has(raw.ref)) image = assetImages.get(raw.ref);
                else if (raw.dataUrl) image = await bitmapFromJSON(raw, cache);
            }
            cels.push({ at: at, image: image });
        }
        const lib = [];
        const rawDrawings = Array.isArray(src && src.drawings) ? src.drawings : [];
        for (const d of rawDrawings) {
            const ref = d && typeof d.ref === 'string' ? d.ref : '';
            const image = ref && assetImages.has(ref) ? assetImages.get(ref) : null;
            if (image) lib.push({ image: image });
        }
        const shellWithLib = lib.length ? Object.assign({}, shell, { drawings: lib }) : shell;
        objects.push(makeObject(Object.assign({}, shellWithLib, { cels: cels })));
    }
    return docShell(node, objects, opts);
}

/** v1/v2/v3 节点：帧模型 → 时间模型（migrateFromFrames），只给「内容变化」的帧建画格。 */
async function docFromFramesNode(node, cache, opts) {
    const rawElements = elementList(node);
    const rawFrames = Array.isArray(node.frames) ? node.frames : [];

    // 老格式 assets 以「对象 id」为键，尺寸藏在任何一帧的 cel.image 里
    const dims = new Map();
    for (const f of rawFrames) {
        const src = (f && f.cels) || {};
        for (const id of Object.keys(src)) {
            const img = src[id] && src[id].image;
            if (img && typeof img === 'object' && img.dataUrl && !dims.has(id)) dims.set(id, { w: img.w, h: img.h });
        }
    }
    const assetImages = await decodeAssets(node, dims, cache);

    const shells = rawElements.map(elementShell);
    // 相邻两帧位图是同一个对象引用 ⇒ 内容没变 ⇒ 不建画格（否则老项目会炸成几千个画格）
    const prev = new Map();
    const frames = [];
    for (const f of rawFrames) {
        const cels = {};
        const src = (f && f.cels) || {};
        for (const id of Object.keys(src)) {
            const cel = src[id];
            if (!cel) continue;
            const raw = cel.image;
            let image = null;
            if (raw && typeof raw === 'object') image = await bitmapFromJSON(raw, cache);
            else if (!raw && assetImages.has(id)) image = assetImages.get(id);
            if (!image || prev.get(id) === image) continue;
            prev.set(id, image);
            cels[id] = { image: image };
        }
        frames.push({
            duration: Number.isFinite(f && f.duration) && f.duration > 0 ? f.duration : 1,
            tag: (f && f.tag) || null,
            cels: cels,
        });
    }

    const legacy = {
        width: node.width,
        height: node.height,
        fps: node.fps,
        loopMode: node.loopMode,
        duration: node.duration,
        onion: node.onion,
        tags: node.tags,
        timebase: node.timebase,
        elements: shells,
        frames: frames,
    };
    const migrated = migrateFromFrames(legacy);
    // migrateFromFrames 用 makeObject 建模，会丢掉 onClickIgnore —— 读回来补上
    const extras = new Map();
    for (const shell of shells) if (shell.onClickIgnore) extras.set(shell.id, true);
    let objects = objectsOf(migrated);
    if (extras.size) {
        objects = objects.map((o) => (extras.has(o.id) ? Object.assign({}, o, { onClickIgnore: true }) : o));
    }
    return docShell(migrated, objects, opts);
}

/**
 * 反序列化：v4 扁平文件 / 外壳信封 / v1~v3 帧节点都能吃。异步（Image.decode 必须等）。
 * 输入不合法时返回 null，绝不抛异常。
 */
export async function jsonToDoc(json, opts) {
    const node = projectNode(json);
    if (!node || typeof node !== 'object') return null;
    if (!elementList(node).length) return null;
    // dataURL → 位图：同一张图被多个画格引用时只解码一次
    const cache = new Map();
    if (isFrameNode(node, fileVersion(json, node))) return docFromFramesNode(node, cache, opts);
    return docFromTimeNode(node, cache, opts);
}

/* ─────────────────────────── 导入图片 ─────────────────────────── */

function stripExt(name) {
    return String(name == null ? '' : name)
        .replace(/^.*[\\/]/, '')
        .replace(/\.[a-z0-9]{1,5}$/i, '')
        .trim();
}

function newElementId() {
    return 'img-' + Date.now().toString(36) + '-' + (++idSeq);
}

/**
 * 图片文件 → 「可直接 addLayer 的对象定义」+ 首帧可用的位图。
 *
 * 纯函数（除解码外不碰 DOM 结构），`width/height` 给了就用，没给就从解码结果取。
 * 返回 null 表示不是一张可用的图片。真正的挂进文档请用 addImageElement。
 *
 * @param {{name?:string, dataUrl:string, width?:number, height?:number, id?:string}} spec
 * @returns {Promise<{element:object, image:object|null, asset:string, width:number, height:number}|null>}
 */
export async function imageElementFromFile(spec, opts) {
    const s = spec || {};
    const dataUrl = typeof s.dataUrl === 'string' ? s.dataUrl : '';
    if (!/^data:image\//i.test(dataUrl)) return null;
    const decoded = await decodeImage(dataUrl);
    const nat = surfaceSize(decoded);
    const width = Math.max(1, Math.round(posNumber(s.width, nat.w || 0)));
    const height = Math.max(1, Math.round(posNumber(s.height, nat.h || 0)));
    if (!width || !height) return null;

    const image = await newSurface(width, height);
    if (image && decoded && typeof image.getContext === 'function') {
        try {
            const g = image.getContext('2d');
            if (g) {
                g.setTransform(1, 0, 0, 1, 0, 0);
                g.clearRect(0, 0, width, height);
                g.drawImage(decoded, 0, 0);
            }
        } catch (err) {
            /* 位图拷贝失败：留空白位图，尺寸仍然正确 */
        }
    }

    const o = opts || {};
    const element = {
        id: s.id ? String(s.id) : 'img-' + (++idSeq),
        name: stripExt(s.name) || '图片 ' + width + '×' + height,
        visible: true,
        locked: false,
        opacity: 1,
        mixMode: 'source-over',
        kind: 'image',
        anchor: { x: DEFAULT_ANCHOR.x, y: DEFAULT_ANCHOR.y },
        onionIgnore: false,
        // 位置在 addImageElement 里按文档尺寸居中（这里只管几何原型）
        transform: { keys: [createKey(0, o.state || {})] },
    };
    return { element: element, image: image, asset: dataUrl, width: width, height: height };
}

/**
 * 把 imageElementFromFile 的结果挂进文档（不改入参 doc，返回新 doc）。
 *
 * 语义：对象插到最上层，并在 t=0 建一个携带该位图的画格 —— 时间模型里画格从 at 起
 * 一直生效，所以「一个画格 = 整条时间轴都可见」，序列化时位图进 assets 只存一份。
 * 需要后续改变像素时，外壳会在当前时间再建画格。
 *
 * @returns {{doc:object, element:object, celCount:number}|null}
 */
export function addImageElement(doc, spec) {
    if (!doc || !spec || !spec.element) return null;
    const base = spec.element;
    const width = Math.max(1, Math.round(posNumber(spec.width, 1)));
    const height = Math.max(1, Math.round(posNumber(spec.height, 1)));
    const docW = posNumber(doc.width, FALLBACK.width);
    const docH = posNumber(doc.height, FALLBACK.height);

    // 居中：anchor 是对象锚点（0.5/0.5 = 对象中心），平移量落在文档中心。
    const firstKey = Array.isArray(base.transform && base.transform.keys) ? base.transform.keys[0] : null;
    const state = Object.assign({}, (firstKey && firstKey.state) || {}, {
        x: Math.round((docW - width) / 2),
        y: Math.round((docH - height) / 2),
    });

    const existing = objectsOf(doc);
    const taken = new Set(existing.map((l) => l && l.id));
    let id = base.id || newElementId();
    while (taken.has(id)) id = newElementId();

    const element = Object.assign({}, base, {
        id: id,
        transform: { keys: [createKey(0, state)] },
        cels: [{ at: 0, image: spec.image || null }],
    });

    const next = Object.assign({}, doc, { objects: [element].concat(existing) });
    return { doc: next, element: element, celCount: 1 };
}

/* ─────────────────────────── 项目记录 ─────────────────────────── */

function newId() {
    return 'proj-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

/**
 * 组装一条库记录：轻量元信息（列表直接读）+ 完整项目（点开才用）。
 * 注意 `rec.layers` / `rec.frames` 是**对象数 / 画格时间点数**的展示口径，projects.mjs
 * 直接读它，键名不能改；时间模型里没有帧对象了，`frames` 取「所有对象出现过的时间点」。
 * @param {{id?:string,name?:string,doc:object,thumb?:string,file?:string}} spec
 */
export function makeRecord(spec) {
    const s = spec || {};
    const doc = s.doc;
    const docJson = docToJSON(doc);
    const name = String(s.name == null ? '' : s.name).trim() || '未命名项目';
    const savedAt = Date.now();
    const project = { format: FORMAT, version: VERSION, name: name, savedAt: savedAt, doc: docJson };
    const elementCount = docJson && Array.isArray(docJson.elements) ? docJson.elements.length : 0;
    const times = new Set();
    for (const el of (docJson && docJson.elements) || []) {
        for (const cel of (el && el.cels) || []) times.add(cel.at);
    }
    const rec = {
        id: s.id || newId(),
        name: name,
        savedAt: savedAt,
        width: docJson ? docJson.width : FALLBACK.width,
        height: docJson ? docJson.height : FALLBACK.height,
        frames: times.size,
        layers: elementCount,
        thumb: typeof s.thumb === 'string' ? s.thumb : '',
        file: typeof s.file === 'string' ? s.file : '',
        project: project,
        bytes: 0,
    };
    try {
        rec.bytes = JSON.stringify(project).length;
    } catch (err) {
        rec.bytes = 0;
    }
    return rec;
}

/** 列表用的轻量视图（去掉 project.doc，避免把几十兆位图读进内存）。 */
export function stripRecord(rec) {
    if (!rec) return null;
    return {
        id: rec.id,
        name: rec.name,
        savedAt: rec.savedAt,
        width: rec.width,
        height: rec.height,
        frames: rec.frames,
        layers: rec.layers,
        thumb: rec.thumb || '',
        file: rec.file || '',
        bytes: rec.bytes || 0,
    };
}

/**
 * 是不是一份项目文件：外壳信封（必须带 doc）或 v2 扁平文件（必须带 elements/layers）。
 * 版本号只做宽松校验（1 与 2 都认），过不去再看结构。
 */
export function isProjectPayload(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (obj.format !== undefined && obj.format !== FORMAT) return false;
    const node = projectNode(obj);
    if (!node || typeof node !== 'object') return false;
    if (obj.doc) return true; // 信封：doc 是节点，下面由 jsonToDoc 校验
    return obj.format === FORMAT && elementList(node).length > 0;
}

/* ─────────────────────────── IndexedDB 通路 ─────────────────────────── */

function idbAvailable() {
    try {
        return typeof indexedDB !== 'undefined' && !!indexedDB;
    } catch (err) {
        return false;
    }
}

function openDb() {
    if (!idbAvailable()) return Promise.resolve(null);
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
        let req = null;
        try {
            req = indexedDB.open(DB_NAME, DB_VERSION);
        } catch (err) {
            resolve(null);
            return;
        }
        req.onupgradeneeded = () => {
            try {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
            } catch (err) {
                /* 升库失败就当没有库 */
            }
        };
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
    });
    return dbPromise;
}

function ask(request) {
    return new Promise((resolve) => {
        if (!request) {
            resolve(null);
            return;
        }
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
    });
}

/** 当前到底用的哪种存储（调试 / 报告用）。 */
export function storageKind() {
    return idbAvailable() ? 'indexeddb' : 'memory';
}

export async function listProjects() {
    const db = await openDb();
    let rows = [];
    if (db) {
        try {
            rows = (await ask(db.transaction(STORE, 'readonly').objectStore(STORE).getAll())) || [];
        } catch (err) {
            rows = [];
        }
    }
    if (!rows.length) rows = Array.from(memory.values());
    return rows
        .filter((r) => r && r.id)
        .map(stripRecord)
        .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

export async function getProject(id) {
    if (!id) return null;
    const db = await openDb();
    if (db) {
        try {
            const row = await ask(db.transaction(STORE, 'readonly').objectStore(STORE).get(id));
            if (row) return row;
        } catch (err) {
            /* 落回内存 */
        }
    }
    return memory.get(id) || null;
}

export async function putProject(rec) {
    if (!rec || !rec.id) return null;
    const db = await openDb();
    if (db) {
        try {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(rec);
            const ok = await new Promise((resolve) => {
                tx.oncomplete = () => resolve(true);
                tx.onerror = () => resolve(false);
                tx.onabort = () => resolve(false);
            });
            if (!ok) memory.set(rec.id, rec);
        } catch (err) {
            memory.set(rec.id, rec);
        }
    } else {
        memory.set(rec.id, rec);
    }
    return stripRecord(rec);
}

export async function renameProject(id, name) {
    const rec = await getProject(id);
    if (!rec) return null;
    const next = Object.assign({}, rec, { name: String(name == null ? '' : name).trim() || rec.name });
    if (next.project) next.project = Object.assign({}, next.project, { name: next.name });
    return putProject(next);
}

export async function deleteProject(id) {
    if (!id) return false;
    memory.delete(id);
    const db = await openDb();
    if (!db) return true;
    try {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(id);
        await new Promise((resolve) => {
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
            tx.onabort = () => resolve(false);
        });
    } catch (err) {
        return false;
    }
    if (currentProjectId() === id) setCurrentProjectId('');
    return true;
}

/* ─────────────────────────── 当前项目 ─────────────────────────── */

function ls() {
    try {
        return globalThis.localStorage || null;
    } catch (err) {
        return null;
    }
}

export function currentProjectId() {
    const store = ls();
    if (!store) return '';
    try {
        return store.getItem(LS_CURRENT) || '';
    } catch (err) {
        return '';
    }
}

export function setCurrentProjectId(id) {
    const store = ls();
    if (!store) return;
    try {
        if (id) store.setItem(LS_CURRENT, String(id));
        else store.removeItem(LS_CURRENT);
    } catch (err) {
        /* 隐私模式 / 配额满了：只是记不住当前项目，不影响保存 */
    }
}

/** 本模块仅供测试重置内存兜底仓库。 */
export function __resetMemory() {
    memory.clear();
}
