/**
 * 导出选项的纯逻辑：归一化、帧数、采样时刻、目录名去重。
 *
 * 刻意不碰 DOM / IPC —— 这样导出对话框、序列导出与测试用的是同一套判定，
 * 而且能在 node 里直跑（`tests/export-options.test.mjs`）。
 */

/** 允许的缩放范围。0.25× 是「够小的预览」，4× 是「够大的放大还原」。 */
export const SCALE_MIN = 0.05;
export const SCALE_MAX = 4;

/** 帧率覆盖范围。0 表示「跟随文档」。 */
export const FPS_MIN = 1;
export const FPS_MAX = 120;

/**
 * 图集边长范围。
 *
 * 上限 8192 是「给强卡留的余地」，缺省 4096 —— 与仓库其它尺寸出口一致
 * （`core/doc-model.mjs` 的 `Math.min(4096,…)`、画板 `BOARD_MAX`、属性输入框 `input.max`）。
 * 下限 512：再小连两格都放不下，分张会碎成一堆没用的文件。
 */
export const TEXTURE_MIN = 512;
export const TEXTURE_MAX = 8192;
export const TEXTURE_DEFAULT = 4096;

/**
 * 位图格式白名单。
 *
 * **JPEG 不支持透明**：导出时调用方必须把 `background` 落成某个具体颜色并告诉用户
 * 用了哪个色（否则透明区会变成黑底，用户以为是渲染 bug）。
 */
export const FORMATS = Object.freeze(['png', 'webp', 'jpeg']);

/** 引擎帧表：自家格式 / Phaser 3 JSON Hash / 两者都要。 */
export const ENGINES = Object.freeze(['own', 'phaser', 'both']);

/** 缺省选项。`dir` 为空串表示「用系统图片目录下的默认子目录」。 */
export const EXPORT_DEFAULTS = Object.freeze({
    scale: 1,
    fps: 0,
    from: 0,
    to: 0,
    background: 'transparent',
    bgColor: '#000000',
    openAfter: true,
    dir: '',
    maxTextureSize: TEXTURE_DEFAULT,
    trim: true,
    format: 'png',
    quality: 0.92,
    engine: 'own',
});

/** 只接受有限数字（含可转成数字的非空字符串），其余一律 null。 */
function numOf(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

/** 夹到 [lo, hi]；坏值返回 fallback（不夹到边界 —— 坏输入不等于最小值）。 */
function clampOr(v, lo, hi, fallback) {
    const n = numOf(v);
    if (n === null) return fallback;
    return Math.min(hi, Math.max(lo, n));
}

/** 文档总时长（与 core/doc-model 的 docDuration 同口径，这里不引入它以避免循环依赖）。 */
function totalOf(doc) {
    const d = doc && numOf(doc.duration);
    return d !== null && d > 0 ? d : 0;
}

function fpsOf(doc) {
    const f = doc && numOf(doc.fps);
    return f !== null && f > 0 ? f : 12;
}

/**
 * 把「用户填的 / 存档里读回来的」选项收成一份可信配置。
 *
 * 帧率的语义：`fps === 0` 表示「跟随文档」（归一化后仍是 0，取帧率时用 `effectiveFps`）。
 * 时间范围以秒计、左闭右开（见 `sampleTimesFor`），出点缺省 = 文档总时长。
 *
 * @param {object|null} raw 原始选项（可能缺字段、可能是字符串、可能是 null）
 * @param {object|null} doc 文档（读 duration / fps / width / height）
 * @returns {{scale:number, fps:number, from:number, to:number, background:string,
 *   bgColor:string, openAfter:boolean, dir:string, maxTextureSize:number, trim:boolean,
 *   format:string, quality:number, engine:string, width:number, height:number,
 *   total:number, count:number}}
 */
export function normalizeExportOptions(raw, doc) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const total = totalOf(doc);
    const baseFps = fpsOf(doc);

    const scale = clampOr(o.scale, SCALE_MIN, SCALE_MAX, EXPORT_DEFAULTS.scale);
    // fps = 0 是「跟随文档」的合法值，不能用 clampOr 的 fallback 语义把它吃掉
    const rawFps = numOf(o.fps);
    const fps = rawFps === null || rawFps === 0 ? 0 : Math.min(FPS_MAX, Math.max(FPS_MIN, rawFps));

    const from = Math.max(0, Math.min(total, numOf(o.from) === null ? 0 : numOf(o.from)));
    const toRaw = numOf(o.to);
    const to = Math.max(0, Math.min(total, toRaw === null || toRaw <= 0 ? total : toRaw));

    const docW = doc && numOf(doc.width) !== null ? numOf(doc.width) : 0;
    const docH = doc && numOf(doc.height) !== null ? numOf(doc.height) : 0;

    return {
        scale,
        fps,
        from,
        to,
        background: o.background === 'color' ? 'color' : 'transparent',
        bgColor: typeof o.bgColor === 'string' && /^#[0-9a-f]{6}$/i.test(o.bgColor) ? o.bgColor : EXPORT_DEFAULTS.bgColor,
        openAfter: o.openAfter !== false,
        dir: typeof o.dir === 'string' ? o.dir : '',
        // 图集上限：坏值回落缺省（4096），合法值夹到 [512, 8192] 并取整
        maxTextureSize: Math.round(clampOr(o.maxTextureSize, TEXTURE_MIN, TEXTURE_MAX, EXPORT_DEFAULTS.maxTextureSize)),
        // trim 缺省开；只有显式 false 才关（存档里写 undefined 不该把用户的选择弄丢）
        trim: o.trim !== false,
        format: FORMATS.includes(o.format) ? o.format : EXPORT_DEFAULTS.format,
        quality: clampOr(o.quality, 0.1, 1, EXPORT_DEFAULTS.quality),
        engine: ENGINES.includes(o.engine) ? o.engine : EXPORT_DEFAULTS.engine,
        width: Math.max(1, Math.round(docW * scale)),
        height: Math.max(1, Math.round(docH * scale)),
        total,
        count: frameCount({ from, to, fps: fps || baseFps }),
    };
}

/** 实际使用的帧率：覆盖值优先，0 表示跟随文档。 */
export function effectiveFps(opts, doc) {
    const o = opts || {};
    const n = numOf(o.fps);
    if (n !== null && n > 0) return Math.min(FPS_MAX, Math.max(FPS_MIN, n));
    return fpsOf(doc);
}

/**
 * 帧数：**左闭右开**，与 `core/doc-model.sampleTimes` 一致（老工程导出帧数不变）。
 *
 * `0–1s @12` = 12、`0.5–2.0s @24` = 36、`0–0.04s @24` = 1、`out <= in` = 0。
 * 用 `ceil(x - 1e-9)` 而不是 `floor(x)+1`，就是为了让「正好整帧」的区间不多出一帧。
 *
 * @param {{from:number, to:number, fps:number}} opts
 * @returns {number}
 */
export function frameCount(opts) {
    const o = opts || {};
    const from = numOf(o.from);
    const to = numOf(o.to);
    const fps = numOf(o.fps);
    if (from === null || to === null || fps === null || fps <= 0) return 0;
    const span = to - from;
    if (!(span > 0)) return 0;
    const n = Math.ceil(span * fps - 1e-9);
    return n > 0 ? n : 0;
}

/**
 * 采样时刻：从 `from` 起、步长 `1/fps`、**`t < to - 1e-9` 才收**（左闭右开）。
 *
 * 返回的长度恒等于 `frameCount`（测试里钉住这条等价关系）。
 *
 * @param {{from:number, to:number, fps:number}} opts
 * @returns {number[]}
 */
export function sampleTimesFor(opts) {
    const o = opts || {};
    const from = numOf(o.from) === null ? 0 : numOf(o.from);
    const to = numOf(o.to);
    const fps = numOf(o.fps);
    if (to === null || fps === null || fps <= 0) return [];
    const count = frameCount({ from, to, fps });
    const out = [];
    for (let i = 0; i < count; i++) {
        // 末尾统一保留 6 位，避免 0.30000000000000004 这类脏值进画布
        out.push(Math.round((from + i / fps) * 1e6) / 1e6);
    }
    return out;
}

/**
 * 目录名去重：`base` 被占用就依次试 `base-2`、`base-3`…
 *
 * `exists` 由调用方注入（主进程用 `fs.existsSync`，测试里用 Set），
 * 这样这个函数既不依赖 fs 也不依赖路径分隔符。
 *
 * @param {string} base 期望的目录名
 * @param {(name:string) => boolean} exists
 * @param {number} [max=999] 上限，超过就返回空串（由调用方报错，不静默覆盖）
 * @returns {string}
 */
export function uniqueDirName(base, exists, max) {
    const name = String(base == null ? '' : base);
    const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : 999;
    if (!name) return '';
    if (typeof exists !== 'function') return name;
    if (!exists(name)) return name;
    for (let i = 2; i <= limit; i++) {
        const tryName = name + '-' + i;
        if (!exists(tryName)) return tryName;
    }
    return '';
}

/** 分片大小：每片 16 帧（主进程按 startIndex 续写，省掉每帧一次 IPC）。 */
export const EXPORT_CHUNK = 16;

/**
 * 把帧数组切成分片描述（不含图像数据本身，调用方按 `startIndex` 取）。
 * @param {number} count 总帧数
 * @param {number} [size=EXPORT_CHUNK]
 * @returns {{startIndex:number, count:number}[]}
 */
export function chunkPlan(count, size) {
    const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    const step = Number.isFinite(size) && size > 0 ? Math.floor(size) : EXPORT_CHUNK;
    const out = [];
    for (let i = 0; i < n; i += step) out.push({ startIndex: i, count: Math.min(step, n - i) });
    return out;
}
