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
 *                 transform?, effects?, onionIgnore?, onClickIgnore?,
 *                 cels:[{ at, image:{ ref, w, h } | { w, h, dataUrl } | null }] }],
 *     assets:{ <对象id>:'data:image/png;base64,…', <对象id>#2:… },
 *     tags:[] }
 *
 * 时间模型：`at` 是秒，纹理从 `at` 起一直生效到下一个纹理；没有帧对象、没有帧计数。
 * 因此文件里**没有 frames 段落**，`duration` 由 docDuration(doc) 算出（内容时长兜底）。
 *
 * 可读形状（jsonToDoc 全部吃下）：
 *   a) v4 扁平文件（上面这个结构本身）
 *   b) 库/外壳写的信封 `{format,version,name,savedAt,doc:{…a}}`
 *   c) v1/v2/v3 节点 `{…,elements|layers:[…],frames:[…]}` —— 走 migrateFromFrames 迁移
 *
 * assets 去重规则（按位图对象身份）：每个对象的第一张位图存成 `assets[对象id]`，同一对象
 * 的第 2、3… 张不同位图存成 `assets[对象id#2]`、`#3`；引用了这些资产的纹理只写
 * `image:{ref,w,h}`，base64 不重复。同一张位图被 20 个纹理引用，文件里也只有 1 份。
 *
 * 约定：本模块不碰引擎、不碰 DOM 结构（只借用 canvas 做位图编码/解码），
 * 所有导出都是纯函数或幂等的存储操作，任何异常都收敛成 null / 空数组，绝不抛给调用方。
 */

import { createKey } from '../core/transform.mjs';
import { defaultEffect, ensureEffectIds } from '../paint/effects.mjs';
import { drawingsOf, keyHasDrawing } from '../core/doc-model.mjs';
import { docDuration, makeObject, migrateFromFrames, objectsOf, normalizeBone, BONE_ANCHOR, defaultObjectName } from '../core/doc-model.mjs';
import { drawOrderOf, normalizeDrawOrder } from '../core/draw-order.mjs';
import { normalizeSkin } from '../core/skin.mjs';
import { normalizeIk } from '../core/ik.mjs';

export const FORMAT = 'motionstudio-project';
/**
 * 文件版本。加骨骼（`kind: 'bone'` + `bone` 字段）与蒙皮（`skin` 字段）时**故意不升**：
 * 两者都是纯增量字段，v4 读入器对没有它们的对象本来就按「无该字段」处理，
 * 旧版本应用读新文件也只会把骨骼当成不认识的值而收敛回手绘、把 skin 丢掉，不会崩。
 * 升版本号反而要写迁移、要维护两条读路径，收益为零。
 */
export const VERSION = 4;
/** 旧版本号：v1/v2/v3 读入时按帧模型迁移（migrateFromFrames）。 */
export const VERSION_V1 = 1;
export const VERSION_V2 = 2;
/** 最后一个「带 frames」的版本；<= 它的文件都要迁移。 */
export const VERSION_FRAMES = 3;

/**
 * 整库备份包的格式标记与版本（`exportLibrary` 写出、`importProjectFile` 认回来）。
 *
 * 必须与单项目文件的 `FORMAT` **不同**：导入端先认这个标记，才不会把一份装着
 * 多个项目的备份当成「一个项目」丢给 `jsonToDoc` —— 那只会得到 null，
 * 用户看到的是「项目内容损坏」，而手里 20 个项目一个都没回来。
 */
export const LIBRARY_FORMAT = 'motionstudio-library';
export const LIBRARY_VERSION = 1;

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

/**
 * 读入时画布边长的上限。与仓库其它尺寸出口保持一致（`core/doc-model.mjs` 的
 * `Math.min(4096, …)`、画板 `BOARD_MAX = 4096`、属性输入框 `input.max = 4096`）：
 * 手改过或第三方生成的存档不再能把画布开到 10 万，害得 `fitView` 把画面缩成一个点。
 * 下限保持 1 —— 历史文件里有 1×1 的，抬到 16 会让它们打不开。
 */
const MAX_DIM = 4096;

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

/**
 * anchor 归一：`{x,y}`，非有限数一律用缺省值。
 * 缺省值随 kind 变（骨骼在根部，其余居中），由调用方通过 fallback 传入。
 */
function normAnchor(raw, fallback) {
    const dflt = fallback || DEFAULT_ANCHOR;
    if (!raw || typeof raw !== 'object') return { x: dflt.x, y: dflt.y };
    const x = Number(raw.x);
    const y = Number(raw.y);
    return {
        x: Number.isFinite(x) ? x : dflt.x,
        y: Number.isFinite(y) ? y : dflt.y,
    };
}

/**
 * kind 的落盘白名单：只写 'paint' / 'image' / 'bone' 三值。
 * 写侧与读侧共用同一个函数，否则「写进去什么」和「认得什么」会各自演化，
 * 某个值只能写不能读时，存档会静默降级成手绘。
 */
function kindOf(raw) {
    return raw === 'bone' ? 'bone' : raw === 'image' ? 'image' : DEFAULT_KIND;
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

/**
 * 效果的一个参数轨道 → 可 JSON 化结构。
 *
 * 为什么沿用 `trackToJSON` 的骨架（`{keys:[{t,state,ease,h1,h2}]}`）而不是另造一套格式：
 * 效果轨道本来就是用 `createTrack()` 造出来的同一个结构，只是值放在 `state.x`
 * （写入见 `shell/commands.mjs` 的 setEffectParam / keyEffectParam，求值见
 * `paint/effects.mjs` 的 effectAt）。沿用同一骨架，读回来能直接交给同一个 `stateAt` 求值，
 * 不必为效果再养第三套轨道解析。差别只有两点：
 *   ① 每个参数包一层 `{keys}`（对象的 `transform` 是一条轨道，效果是「参数名 → 轨道」字典）；
 *   ② 只写 `state.x` —— 一个通道只有一个标量，`state` 里其余字段都是 `normState` 补出来的
 *      变换默认值（y / scaleX / warp …），写进存档纯属噪声，读回时 `stateAt` 会照样兜底。
 */
function fxTrackToJSON(track) {
    const json = trackToJSON(track);
    if (!json) return null;
    const keys = [];
    for (const k of json.keys) {
        const x = Number(k.state && k.state.x);
        if (!Number.isFinite(x)) continue;
        const out = { t: k.t, state: { x: x }, ease: k.ease };
        if (k.h1) out.h1 = k.h1;
        if (k.h2) out.h2 = k.h2;
        keys.push(out);
    }
    return keys.length ? { keys: keys } : null;
}

/** 效果轨道字典 → 可 JSON 化结构；空字典不落盘（与「无效果不写字段」同口径）。 */
function fxTracksToJSON(tracks) {
    if (!tracks || typeof tracks !== 'object') return null;
    const out = {};
    for (const key of Object.keys(tracks)) {
        const json = fxTrackToJSON(tracks[key]);
        if (json) out[key] = json;
    }
    return Object.keys(out).length ? out : null;
}

/**
 * 效果数组 → 可 JSON 化结构（没有效果时返回 null，字段整个不落下）。
 *
 * 落盘形状与运行期对象**同构**：参数扁平写在效果上（`{type, amount, color, tracks}`），
 * 不再嵌一层 `params`。理由是运行期本来就是扁平的 —— `paint/effects.mjs` 的
 * defaultEffect / normalizeEffect 产出 `{type, ...参数}`，编辑器读写走 `fx[key]`
 * （`editors/prop-object.mjs`、`shell/commands.mjs`），多包一层只会让读写两边各搬运一次。
 * 读入侧两种形状都认（见 effectsFromJSON），将来真要加 `params` 子对象也不会读不进来。
 */
function effectsToJSON(list) {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const type = typeof raw.type === 'string' ? raw.type : '';
        if (!type) continue;
        const fx = { type: type };
        if (typeof raw.id === 'string' && raw.id) fx.id = raw.id;
        // 参数：只抄标量与字符串（对象 / 函数进不了存档）；`params` 包装存在时一并认
        const sources = raw.params && typeof raw.params === 'object' ? [raw, raw.params] : [raw];
        for (const src of sources) {
            for (const key of Object.keys(src)) {
                if (key === 'type' || key === 'tracks' || key === 'params' || key === 'id') continue;
                const v = src[key];
                if (typeof v === 'number') {
                    if (Number.isFinite(v)) fx[key] = v;
                } else if (typeof v === 'string') {
                    fx[key] = v;
                }
            }
        }
        const tracks = fxTracksToJSON(raw.tracks);
        if (tracks) fx.tracks = tracks;
        out.push(fx);
    }
    return out.length ? out : null;
}

/** 对象（v1 里叫 layer）→ v4 对象节点（cels 由 docToJSON 编码后补上）。 */
function elementToJSON(l) {
    const src = l || {};
    const kind = kindOf(src.kind);
    const out = {
        id: src.id,
        name: src.name,
        visible: !!src.visible,
        locked: !!src.locked,
        opacity: Number.isFinite(src.opacity) ? src.opacity : 1,
        mixMode: src.mixMode || 'source-over',
        kind: kind,
        anchor: normAnchor(src.anchor, kind === 'bone' ? BONE_ANCHOR : DEFAULT_ANCHOR),
        onionIgnore: !!src.onionIgnore,
    };
    // 骨骼外观只跟着骨骼对象落盘：非骨骼对象写 bone 只是存档噪声，
    // 还会让「同一份文档存两次得两个形状」。
    if (kind === 'bone') {
        const bone = normalizeBone(src.bone);
        if (bone) out.bone = bone;
    }
    // 蒙皮：只有归一后有效才落盘。坏 skin 写进文件只会让下次读入时更难判断
    // 「到底是没绑过，还是绑坏了」，所以坏数据一律当作没绑。
    const skin = normalizeSkin(src.skin);
    if (skin) out.skin = skin;
    // IK：只有归一后有效才落盘（坏约束写进文件只会让下次读入更难判断）
    const ik = normalizeIk(src.ik);
    if (ik) out.ik = ik;
    if (src.onClickIgnore) out.onClickIgnore = true;
    // v5：父子层级与时间通道（恒等值不落盘，老文件读进来也是干净对象）
    if (src.parentId != null) out.parentId = src.parentId;
    const time = timeToJSON(src.time);
    if (time) out.time = time;
    const transform = trackToJSON(src.transform);
    if (transform) out.transform = transform;
    const effects = effectsToJSON(src.effects);
    if (effects) out.effects = effects;
    return out;
}

/**
 * 序列化口径：「哪些时刻有纹理」只认**真源** —— 关键帧上的 `drawing` 属性 + 纹理库。
 *
 * 为什么不直接读 `obj.cels`：v8 起 `obj.cels` 只是 `makeObject` / `syncLibrary` 里
 * `projectCels` 现算出来的**镜像**（`core/doc-model.mjs`），而时间轴的移动 / 删除关键帧
 * 走的是 `editors/timeline-geo.mjs:308` 那个 `setTransform` 浅替换，根本不会重算镜像。
 * 于是 `obj.cels` 会停在旧时刻：照抄它等于把纹理写回移动前的位置，甚至把用户已经删掉的
 * 纹理又写进存档 —— 存档往返后纹理静默错位 / 复活。
 *
 * 返回值与 `projectCels` 同口径：按时间升序，每颗带 `drawing` 属性的关键帧一条；
 * `image` 从 `drawingsOf` 取，与 `celAt` / `imageAt` 是同一条取图路径（不另开一套口径）。
 * 只有对象连关键帧轴都没有（`transform.keys` 不是数组，v7 及更早的裸对象）时才退回 `cels`。
 */
function drawingCelsOf(obj) {
    const track = obj && obj.transform;
    const keys = track && Array.isArray(track.keys) ? track.keys : null;
    if (!keys) return Array.isArray(obj && obj.cels) ? obj.cels : [];
    const lib = new Map();
    for (const d of drawingsOf(obj)) lib.set(d.id, d.image);
    const out = [];
    for (const k of keys) {
        if (!keyHasDrawing(k)) continue;
        const id = k.drawing == null ? null : String(k.drawing);
        out.push({ at: k.t, image: id == null ? null : lib.get(id) || null });
    }
    out.sort((a, b) => a.at - b.at);
    return out;
}

/**
 * doc → v4 节点（不含 format/version 外壳，那个由 docToFile / makeRecord 加）。
 * 对象顺序、id、变换轨道、纹理时间点、标签、洋葱皮设置全保留；只有位图变 dataURL。
 * 文件里没有 frames：纹理是 `{ at, image }`，at 为秒。
 */
export function docToJSON(doc) {
    if (!doc || typeof doc !== 'object') return null;
    const srcObjects = objectsOf(doc);

    // 同一个位图对象只编码一次（几十个纹理共用一张图 → 1 次 toDataURL）。
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
        // 纹理从真源重算（见 drawingCelsOf）：`src.cels` 是可能过期的镜像，不能当口径用。
        const cels = drawingCelsOf(src);
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
        // 纹理库：obj.drawings 里的每张图都要有 assets key，
        // 这样「切走之后暂时没用到的纹理」也能存档，重新打开还能切回来。
        // 纹理库：以 drawingsOf 的库视图为准（关键帧上引用的纹理 + 暂时没被用到的纹理都在里面）
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
    // v10：叠放顺序（`drawOrder[0]` = 最上层）。缺字段的老存档靠
    // `normalizeDrawOrder` 从 objects 顺序派生，与拆分之前完全等价。
    out.drawOrder = drawOrderOf(doc);
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

/**
 * 文件里的效果轨道字典 → 运行期轨道（宽松归一，坏通道丢掉而不是整条效果报废）。
 *
 * 与 `trackFromJSON` 的差别只在「通道」这一层：对象的 transform 是一条轨道，效果是
 * `参数名 → 轨道` 的字典，所以逐通道调一次同样的归一；值仍收在 `state.x`。
 */
function fxTracksFromJSON(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    for (const key of Object.keys(raw)) {
        const channel = raw[key];
        // `keys` 不是数组 ⇒ 这个参数根本没有轨道，丢掉通道（不猜、不补空帧）
        if (!channel || typeof channel !== 'object' || !Array.isArray(channel.keys)) continue;
        const keys = [];
        for (const k of channel.keys) {
            if (!k || typeof k !== 'object') continue;
            const t = Number(k.t);
            const x = Number(k.state && k.state.x);
            if (!Number.isFinite(t) || !Number.isFinite(x)) continue;
            const h1 = Array.isArray(k.h1) ? [Number(k.h1[0]), Number(k.h1[1])] : undefined;
            const h2 = Array.isArray(k.h2) ? [Number(k.h2[0]), Number(k.h2[1])] : undefined;
            try {
                // 借 createKey 归一 ease / 切线柄（它顺带把 state 补成整份变换状态），
                // 再收回成 `{x: …}`：效果轨道只认这一个标量，留着补出来的 y / scaleX 只是噪声。
                const made = createKey(t, { x: x }, k.ease, h1, h2);
                keys.push({ t: made.t, ease: made.ease, h1: made.h1, h2: made.h2, state: { x: made.state.x } });
            } catch (err) {
                /* 单个坏关键帧不该毁掉整个项目 */
            }
        }
        if (!keys.length) continue;
        keys.sort((a, b) => a.t - b.t);
        out[key] = { keys: keys };
    }
    return Object.keys(out).length ? out : null;
}

/**
 * 文件里的效果数组 → 运行期效果对象。
 *
 * 刻意**不**调 `normalizeEffect`：它按 `EFFECT_DEFS` 白名单收键，会把整个 `tracks` 丢掉
 * （`paint/effects.mjs` 里它只服务渲染），一调效果动画就全没了。这里的规则：
 * - 非数组 / 元素不是对象 / 缺 type / 不认识的 type → 丢掉该条（渲染侧本来也不认它）；
 * - 参数先取 `defaultEffect(type)` 的默认值，再让存档里同名字段覆盖 ⇒ 缺键自动补齐；
 * - 数值只认有限数，颜色只认非空串（`rgba(0,0,0,0.45)` 这种带 alpha 的照原样留着，
 *   不按 `#rrggbb` 校验 —— 渲染侧的 readColor 也只要求非空）；
 * - 不在这里 clamp：夹取是渲染期的职责（effectAt / normalizeEffect 各自管），载入时静默
 *   改用户存的数只会让人以为文件被写坏。
 */
function effectsFromJSON(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') continue;
        const base = defaultEffect(typeof item.type === 'string' ? item.type : '');
        if (!base) continue;
        // 兼容将来可能出现的 `{type, params:{…}}` 包装；现在运行期是扁平的
        const src = item.params && typeof item.params === 'object' ? item.params : item;
        for (const key of Object.keys(base)) {
            if (key === 'type' || !Object.prototype.hasOwnProperty.call(src, key)) continue;
            const v = src[key];
            // 参数是数值还是颜色由默认值的类型决定（EFFECT_DEFS 里 num / rgb 的产物）：
            // 颜色只认非空串，数值只认有限数（字符串数字也认，方便手改的文件）
            if (typeof base[key] === 'string') {
                if (typeof v === 'string' && v.trim() !== '') base[key] = v.trim();
                continue;
            }
            const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
            if (Number.isFinite(n)) base[key] = n;
        }
        if (typeof item.id === 'string' && item.id) base.id = item.id;
        const tracks = fxTracksFromJSON(item.tracks);
        if (tracks) base.tracks = tracks;
        out.push(base);
    }
    // 补号码：老档（v8.25 之前保存的）效果没有 id，这里按数组顺序发 fx-1..fx-n，
    // 用户一保存就落盘；确定性发号保证同一份档反复载入得到同一组 id。
    return ensureEffectIds(out);
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
    const kind = kindOf(s.kind);
    const element = {
        id: s.id ? String(s.id) : 'element' + (++idSeq) + '-' + i,
        name: s.name || defaultObjectName(i + 1),
        visible: s.visible !== false,
        locked: !!s.locked,
        opacity: Number.isFinite(s.opacity) ? s.opacity : 1,
        mixMode: s.mixMode || 'source-over',
        // v1 没有 kind / anchor：升级时补 paint + 居中锚点；骨骼补根部锚点
        kind: kind,
        anchor: normAnchor(s.anchor, kind === 'bone' ? BONE_ANCHOR : DEFAULT_ANCHOR),
        onionIgnore: !!s.onionIgnore,
    };
    // 骨骼外观：档里有就收（越界/坏色归一），没有就交给 makeObject 补缺省 ——
    // 所以这里**不写** bone 键，让「缺省」只有一个真源（BONE_DEFAULTS）。
    if (kind === 'bone') {
        const bone = normalizeBone(s.bone);
        if (bone) element.bone = bone;
    }
    // 蒙皮：档里有就收（夹取网格、裁权重、重归一），没有就不写字段 ——
    // 和 bone 同一策略：缺省只有一个来源（skinOf/normalizeSkin）。
    const skin = normalizeSkin(s.skin);
    if (skin) element.skin = skin;
    // 与 bone 同一策略：缺省只有一个来源（ik.mjs 的 normalizeIk）
    const ik = normalizeIk(s.ik);
    if (ik) element.ik = ik;
    if (s.onClickIgnore) element.onClickIgnore = true;
    // v5：parentId 与时间通道；缺省时不写字段（保持对象形状干净）
    if (s.parentId != null) element.parentId = String(s.parentId);
    const time = timeFromJSON(s.time);
    if (time) element.time = time;
    const track = trackFromJSON(s.transform);
    if (track) element.transform = track;
    // 效果（含参数级关键帧）：缺字段 / 坏数据一律收敛成 []，老档读进来行为不变（由 makeObject 兜成空数组）
    const effects = effectsFromJSON(s.effects);
    if (effects.length) element.effects = effects;
    return element;
}

/** 文档外壳：尺寸/循环/时长/标签/洋葱皮/时间轴分段（objects 由调用方造好）。 */
function docShell(node, objects, opts) {
    const doc = {
        width: Math.max(1, Math.min(MAX_DIM, Math.round(posNumber(node.width, FALLBACK.width)))),
        height: Math.max(1, Math.min(MAX_DIM, Math.round(posNumber(node.height, FALLBACK.height)))),
        fps: Number.isFinite(node.fps) && node.fps > 0 ? node.fps : FALLBACK.fps,
        loopMode: node.loopMode || FALLBACK.loopMode,
        objects: objects,
        tags: Array.isArray(node.tags) ? plain(node.tags) || [] : [],
    };
    const declared = Number(node.duration);
    // 老存档可能根本没有 duration 字段。以前这里是「有值才写」，读进来的文档连
    // duration 这个键都没有，与 createDocument 的形状不一致（那边一定是 number）。
    // 补成 0 而不是编一个时长：0 表示「没有声明」，用时由 docDuration 按内容兜底，
    // 行为与以前完全一样。
    doc.duration = Number.isFinite(declared) && declared > 0 ? declared : 0;
    const o = opts || {};
    const onion = plain(o.onion !== undefined ? o.onion : node.onion);
    if (onion) doc.onion = onion;
    const timebase = plain(node.timebase);
    if (timebase) doc.timebase = timebase;
    // v10：叠放顺序。老存档没有这个字段时按 objects 顺序派生（与拆分前等价）；
    // 存档里带着未知 id 或重复项时由 normalizeDrawOrder 修掉。
    doc.drawOrder = normalizeDrawOrder(objects, node.drawOrder);
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
    // 资产尺寸藏在引用它的纹理里（`image:{ ref, w, h }`）
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

/** v1/v2/v3 节点：帧模型 → 时间模型（migrateFromFrames），只给「内容变化」的帧建纹理。 */
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
    // 相邻两帧位图是同一个对象引用 ⇒ 内容没变 ⇒ 不建纹理（否则老项目会炸成几千个纹理）
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
    // dataURL → 位图：同一张图被多个纹理引用时只解码一次
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
 * 语义：对象插到最上层，并在 t=0 建一个携带该位图的纹理 —— 时间模型里纹理从 at 起
 * 一直生效，所以「一个纹理 = 整条时间轴都可见」，序列化时位图进 assets 只存一份。
 * 需要后续改变像素时，外壳会在当前时间再建纹理。
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

    // 走 makeObject 而不是手拼：它是「cels → 关键帧上的 drawing」唯一的规范化入口。
    // 手拼出来的 element 只有 cels 有图、关键帧上没有纹理，会成为「按真源重算」时的孤例
    // （纹理在存档里凭空消失）；经 makeObject 吸收后文档里只剩一条关键帧时间轴。
    const element = makeObject(Object.assign({}, base, {
        id: id,
        transform: { keys: [createKey(0, state)] },
        cels: [{ at: 0, image: spec.image || null }],
    }));

    const next = Object.assign({}, doc, { objects: [element].concat(existing) });
    return { doc: next, element: element, celCount: 1 };
}

/* ─────────────────────────── 项目记录 ─────────────────────────── */

function newId() {
    return 'proj-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
}

/**
 * 标签的边界（alpha.46 P2）。数字写在这里而不是各处 magic number：
 * 面板侧同一批也要按 8×24 截断，两边口径必须一样，否则「面板里能存、库里被丢掉」。
 */
export const MAX_TAGS = 8;
export const MAX_TAG_LEN = 24;

/**
 * 标签清洗（纯函数）：只留字符串 → trim → 去空 → 每个截到 24 个字符 → 去重 → 最多 8 个。
 *
 * 为什么超长是**截断**而不是丢弃：用户从别处粘一串 30 字的标签，截到 24 至少保住他的本意，
 * 整条丢掉则等于「输入了但没保存」。去重放在截断之后 —— 两条长标签截完可能同名。
 * 用 `Array.from` 数「字符」而不是 `slice` 数字节：emoji 被劈成半个代理对会变成乱码。
 * 非字符串（旧档 / 手改文件里的 1、null、对象）一律丢弃，库记录里只存干净字符串。
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
export function normalizeTags(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const item of raw) {
        if (typeof item !== 'string') continue;
        const trimmed = item.trim();
        if (!trimmed) continue;
        const chars = Array.from(trimmed);
        const tag = (chars.length > MAX_TAG_LEN ? chars.slice(0, MAX_TAG_LEN).join('') : trimmed).trim();
        if (!tag || seen.has(tag)) continue;
        seen.add(tag);
        out.push(tag);
        if (out.length >= MAX_TAGS) break;
    }
    return out;
}

/**
 * 组装一条库记录：轻量元信息（列表直接读）+ 完整项目（点开才用）。
 * 注意 `rec.layers` / `rec.frames` 是**对象数 / 纹理时间点数**的展示口径，projects.mjs
 * 直接读它，键名不能改；时间模型里没有帧对象了，`frames` 取「所有对象出现过的时间点」。
 *
 * `openedAt` 是「最近一次打开这条记录」的时刻，与 `savedAt`（最近一次保存）是两件事：
 * 保存不该把项目顶到「最近打开」列表最前面，打开也不该让存档看起来更新了。
 * 不给 `openedAt` 时退回 `savedAt`（老调用方 / 第一次入库都是这个语义）。
 *
 * `pinned`（收藏置顶）与 `tags`（标签）是 alpha.46 的 P2 元信息：只影响列表怎么排、怎么筛，
 * 与项目内容无关，所以也不用 `plain()` 深拷贝 —— `normalizeTags` 每次都造新数组。
 * `pinned` 只认布尔 true：旧档 / 手改文件里的 `1`、`'true'` 不算置顶，
 * 否则一条脏记录就会永远占住列表最前面，用户没有任何地方能看出来为什么。
 * @param {{id?:string,name?:string,doc:object,thumb?:string,file?:string,openedAt?:number,pinned?:boolean,tags?:string[]}} spec
 */
export function makeRecord(spec) {
    const s = spec || {};
    const doc = s.doc;
    const docJson = docToJSON(doc);
    const name = String(s.name == null ? '' : s.name).trim() || '未命名项目';
    const savedAt = Date.now();
    const openedRaw = Number(s.openedAt);
    const openedAt = Number.isFinite(openedRaw) && openedRaw > 0 ? openedRaw : savedAt;
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
        openedAt: openedAt,
        pinned: s.pinned === true,
        tags: normalizeTags(s.tags),
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
        // 原样透传：老记录（alpha.44 及以前）没有 openedAt 就是 0，
        // 面板据此不显示「最近打开」—— 拿 savedAt 顶替等于编一个没发生过的打开动作
        openedAt: rec.openedAt || 0,
        // 老记录（alpha.45 及以前）没有这两个字段：缺省 false / []，面板据此显示「未置顶、无标签」。
        // 顺手再清洗一遍 tags：库里被手改 / 旧版写坏的标签不该把面板搞崩。
        pinned: rec.pinned === true,
        tags: normalizeTags(rec.tags),
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

/**
 * 是不是一份**整库备份包**（`exportLibrary` 写出、`importProjectFile` 认回来的结构）。
 *
 * 只认结构不认内容：`projects` 里每一条是否真能读，由 `jsonToDoc` 逐条校验。
 * 这样坏了其中一条也只丢那一条，不会让整份备份变成「不是项目文件」。
 */
export function isLibraryPayload(obj) {
    if (!obj || typeof obj !== 'object') return false;
    return obj.format === LIBRARY_FORMAT && Array.isArray(obj.projects);
}

/**
 * 把一整库记录打包成备份包（纯函数，不碰存储）。
 *
 * 结构：`{format:'motionstudio-library', version:1, exportedAt, app:'motionstudio', projects:[…]}`
 * - `projects` 里放的是**完整的项目文件节点**（`rec.project`，含 `doc`），导入端因此可以
 *   逐条走 `jsonToDoc`，与单个 `.msp` 完全同一条校验路径；
 * - 没有 `project` 的坏记录直接跳过 —— 一条损坏的历史记录不该毁掉整份备份；
 * - 深拷贝（`plain`）：备份包与库里记录共引用时，调用方改包会顺手改库。
 *
 * @param {Array<object>} records 完整库记录（`getProject` 的返回，不是 stripRecord 的轻量视图）
 * @param {{exportedAt?:number}} [opts] 测试注入用；不给就取当前时间
 * @returns {{format:string,version:number,exportedAt:number,app:string,projects:object[]}}
 */
export function libraryBundleOf(records, opts) {
    const o = opts || {};
    const rows = Array.isArray(records) ? records : [];
    const projects = [];
    for (const rec of rows) {
        if (!rec || typeof rec !== 'object') continue;
        const node = plain(rec.project);
        if (node && typeof node === 'object') projects.push(node);
    }
    const stamp = Number(o.exportedAt);
    return {
        format: LIBRARY_FORMAT,
        version: LIBRARY_VERSION,
        exportedAt: Number.isFinite(stamp) && stamp > 0 ? stamp : Date.now(),
        app: 'motionstudio',
        projects: projects,
    };
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
        // 未命名草稿与真实项目同库（键 __draft__），但它不是「一个项目」，列表里不能出现
        .filter((r) => r && r.id && r.__draft !== true && r.id !== '__draft__')
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

/**
 * 库内复制（「另存为副本」）：把一条记录抄成一条新记录，内容一字不差。
 *
 * **副本一律清掉 `file`**：绑定路径若跟着抄过来，用户下次在副本里按 Ctrl+S 就会把
 * 副本内容写回**原项目的文件** —— 两份不同的内容抢同一个交付物，这是真丢数据的路径
 * （与「跨卡片另存为改绑定」是同一类坑，alpha.44 已堵过一次）。
 * `thumb` / `project` 原样复用；`savedAt` / `openedAt` 刷新成现在。
 *
 * P2 的两个元信息**分开处理**（alpha.46）：
 * - `pinned` 不继承（固定 false）：收藏是「我要盯住这一条」，复制出来一条同名的也置顶
 *   会把原项目挤下去，用户却找不到是谁把列表弄乱了；
 * - `tags` 跟着抄：标签是分类信息，从「角色」分叉出来的副本通常还是角色，
 *   让用户再打一遍标签纯属浪费。
 * @param {string} id 源记录 id
 * @param {{name?:string}} [opts] 副本名字（「副本」这类字眼由调用方按语言拼好）
 * @returns {Promise<object|null>} 新记录的轻量视图；源记录不存在时 null
 */
export async function duplicateProject(id, opts) {
    if (!id) return null;
    const o = opts || {};
    const src = await getProject(id);
    if (!src || !src.project) return null;
    const project = plain(src.project);
    if (!project || typeof project !== 'object') return null;
    const now = Date.now();
    const name = String(o.name == null ? '' : o.name).trim() || String(src.name || '');
    const rec = {
        id: newId(),
        name: name,
        savedAt: now,
        openedAt: now,
        // 见上：置顶不跟抄，标签跟抄
        pinned: false,
        tags: normalizeTags(src.tags),
        width: src.width,
        height: src.height,
        frames: src.frames,
        layers: src.layers,
        thumb: typeof src.thumb === 'string' ? src.thumb : '',
        // 副本不继承文件绑定：否则 Ctrl+S 会把副本写进原项目的文件
        file: '',
        // 名字与 savedAt 跟着新记录走：否则「存为文件」写出来的项目文件还是旧名字/旧时间
        project: Object.assign({}, project, { name: name, savedAt: now }),
        bytes: Number(src.bytes) || 0,
    };
    const saved = await putProject(rec);
    return saved || null;
}

/**
 * 只改「库元信息」的白名单字段（alpha.46 P2：`pinned` / `tags`）。
 *
 * 为什么单独开一个函数而不是复用 `putProject`：卡片上的置顶 / 标签是**旁路动作**，
 * 调用方手里只有 `id`（列表给的是轻量视图），没有完整记录。让面板自己读整条记录再写回，
 * 等于把「读-改-写」的竞态和「别把 name/file/project 冲掉」的责任丢给每个 UI 调用点。
 * 白名单是硬约束：`{name}`、`{file}`、`{project}` 一律忽略 —— 改名有 `renameProject`、
 * 绑定归属走 `writeProjectFile`，各有各的校验，不能被一条 patch 绕过。
 *
 * 没有任何白名单字段时只读不写（返回当前 stripRecord）：空 patch 不该产生一次写库。
 * @param {string} id
 * @param {{pinned?:boolean,tags?:string[]}} patch
 * @returns {Promise<object|null>} 更新后的轻量视图；记录不存在返回 null
 */
export async function updateProjectMeta(id, patch) {
    if (!id) return null;
    const rec = await getProject(id);
    if (!rec) return null;
    const p = patch && typeof patch === 'object' ? patch : {};
    const has = (key) => Object.prototype.hasOwnProperty.call(p, key);
    if (!has('pinned') && !has('tags')) return stripRecord(rec);
    const next = Object.assign({}, rec);
    if (has('pinned')) next.pinned = p.pinned === true;
    if (has('tags')) next.tags = normalizeTags(p.tags);
    const saved = await putProject(next);
    return saved || stripRecord(next);
}

/** 项目库排序模式（面板侧下拉框的四个选项；顺序即界面顺序）。 */
export const SORT_MODES = Object.freeze(['saved', 'opened', 'name', 'size']);

/** 时间戳 / 体积这类数值字段的兜底：坏数据按 0（不让 NaN 把整个排序搅乱）。 */
function numOf(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 四种模式的组内比较器（返回值 <0 表示 a 在前）。pinned 分组由 sortProjects 负责。 */
const SORT_COMPARE = {
    // 最近保存 / 最近打开：时间倒序（新的在前）
    saved: (a, b) => numOf(b && b.savedAt) - numOf(a && a.savedAt),
    opened: (a, b) => numOf(b && b.openedAt) - numOf(a && a.openedAt),
    // 名称：localeCompare（跟随系统语言，中文按拼音、英文按字母）
    name: (a, b) => String((a && a.name) == null ? '' : a.name).localeCompare(String((b && b.name) == null ? '' : b.name)),
    // 体积：字节倒序（大的在前）
    size: (a, b) => numOf(b && b.bytes) - numOf(a && a.bytes),
};

/**
 * 项目库排序（纯函数，alpha.46 P2）：**pinned 永远排最前**，组内按 mode 排。
 *
 * - mode 只认 `SORT_MODES` 里的四个值，其它一律退回 `'saved'`（localStorage 里的旧值 /
 *   手改配置不该让列表变成随机顺序）；
 * - 同值保持原顺序：不依赖引擎 sort 的稳定性（ES2019 起才写入规范，而这里有 Electron /
 *   浏览器 / Node 三个运行环境），用下标做最后一道比较；
 * - **不修改入参**：先 `slice()` 再排，面板可以在自己手里的数组上反复按不同模式排。
 *
 * @param {Array<object>} rows 轻量记录（`listProjects` 的产出）
 * @param {'saved'|'opened'|'name'|'size'} mode
 * @returns {Array<object>} 排好的新数组（元素仍是原记录引用）
 */
export function sortProjects(rows, mode) {
    const list = Array.isArray(rows) ? rows.slice() : [];
    const m = SORT_MODES.includes(mode) ? mode : 'saved';
    const compare = SORT_COMPARE[m];
    return list
        .map((row, index) => ({ row: row, index: index }))
        .sort((a, b) => {
            // 置顶是一级键：与 mode 无关，收藏的项目永远先出现
            const pa = a.row && a.row.pinned === true ? 0 : 1;
            const pb = b.row && b.row.pinned === true ? 0 : 1;
            if (pa !== pb) return pa - pb;
            const d = compare(a.row, b.row);
            return d !== 0 ? d : a.index - b.index;
        })
        .map((item) => item.row);
}

/**
 * 库统计（纯函数）：项目数与占用字节总和。面板的「N 个项目 · 共 X」直接读这个。
 *
 * 坏数据（null / 非对象）不计入 count；对象但 bytes 不是正数的按 0 累加 ——
 * 统计条是给用户看「库有多大」的，一条脏记录不该让整行数字变成 NaN。
 * @param {Array<object>} rows 轻量记录
 * @returns {{count:number,bytes:number}}
 */
export function libraryTotals(rows) {
    const list = Array.isArray(rows) ? rows : [];
    let count = 0;
    let bytes = 0;
    for (const row of list) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
        count += 1;
        bytes += numOf(row.bytes);
    }
    return { count: count, bytes: bytes };
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
