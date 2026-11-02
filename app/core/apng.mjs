// APNG 导出（动态 PNG）：把一串「ImageData 形状」的帧编成一张能循环播放的动态 PNG。
//
// 纯函数、零依赖、零 DOM：输入是 `{ data, width, height }` 数组，输出是字节流。
// 与 gif.mjs 的分工：GIF 走 256 色调色板，体积小但色带与硬边明显；APNG 存全彩 RGBA，
// 渐变、半透明、文字都无损，代价是体积大一些。两者出口一致：帧序列 → 字节流 →
// `ipc.saveBinaryChecked(path, bytes, mime)`。
//
// 三条实现选择（都有取舍，写在前面）：
//   1. 压缩只用平台自带的 `CompressionStream('deflate-raw')` 拿裸 deflate，再自己补
//      zlib 头（0x78 0x9C）与 adler32 尾。不引第三方、也不自己写 deflate：自己写会慢
//      一个数量级，且没有任何好处。代价是这个文件只能在支持 CompressionStream 的
//      环境跑（Chromium 103+ / Node 18+），所以先问 `canEncodeApng()` 再调用。
//   2. 每帧独立压缩、各自一个 IDAT（或 fdAT）块，不做帧间差分，也不把一块拆成多块。
//      APNG 规范允许这么写，解码器普遍支持；优点是一帧坏不牵连别帧、代码短一个数量级，
//      缺点是比「最优 APNG」略大，且单块可能到几十 KB —— 这在本地文件里无所谓。
//   3. 每个扫描行前统一写 filter 字节 0（None），不做行过滤优化（Sub / Up / Paeth）。
//      像素画与特效动画行内相关性通常不高，选 None 换实现简单与输出可预测。
//
// 两个最容易写错的地方（tests/apng.test.mjs 里都钉死了）：
//   - `fcTL` 与 `fdAT` **共用一个 sequence 计数器**，从 0 起严格连续递增；`fdAT` 的数据
//     前面还要再多 4 字节 sequence。只给 fcTL 编号、或两个计数器各编各的，文件看着
//     结构完整，播放器却只放第一帧。
//   - `blend_op` 用 0（SOURCE）而不是 1（OVER）：OVER 会把半透明帧叠在上一帧上出叠影，
//     而我们是整帧导出，每帧本来就是完整画面。

/** PNG 签名：8 字节魔数，后面紧跟 IHDR。 */
const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

/** 延时缺省值（毫秒）：APNG 用「分子/分母」表示秒，这里分母固定 1000，分子就是毫秒。 */
export const APNG_DEFAULT_DELAY_MS = 100;

/** num_plays = 0 表示无限循环（APNG 规范的定义）。 */
export const APNG_LOOP_FOREVER = 0;

/** delay_den 固定 1000：分母写 1000 时 delay_num 就是毫秒，不需要约定精度。 */
const DELAY_DEN = 1000;

/** dispose_op = 1：每帧显示完把这块区域清成透明，下一帧整帧覆盖，不留残影。 */
const APNG_DISPOSE_OP_BACKGROUND = 1;

/** blend_op = 0：源覆盖（见文件头注释，不用 1=OVER）。 */
const APNG_BLEND_OP_SOURCE = 0;

/** IHDR 的位深与颜色类型：8 位/通道、6 = 真彩 + alpha。 */
const BIT_DEPTH = 8;
const COLOR_TYPE_RGBA = 6;

/** 行过滤类型：0 = None。 */
const FILTER_NONE = 0;

/** zlib 头：CMF=0x78（deflate, 32K 窗口）、FLG=0x9C，两者拼起来能被 31 整除。 */
const ZLIB_CMF = 0x78;
const ZLIB_FLG = 0x9c;

/** CRC32 查表（多项式 0xEDB88320，反射式），模块加载时算一次。 */
const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[i] = c >>> 0;
    }
    return table;
})();

/**
 * 当前环境能不能编 APNG。
 *
 * 只看一件事：有没有 `CompressionStream('deflate-raw')`。火狐与 Safari 支持 APNG
 * 播放，但 CompressionStream 要 2023 之后；导出入口先问这一句，能给出人话提示，
 * 而不是让用户看到「导出失败」四个字。
 */
export function canEncodeApng() {
    try {
        if (typeof CompressionStream !== 'function') return false;
        // 构造函数不认 'deflate-raw' 时会抛，这里就是那句 catch 的用处。
        new CompressionStream('deflate-raw');
        return true;
    } catch {
        return false;
    }
}

/**
 * 把帧序列编成 APNG 字节流。
 *
 * @param {Array<{width:number,height:number,data:Uint8Array|Uint8ClampedArray}>} frames
 *        至少一帧；`data` 是 RGBA 字节，长度必须 `width*height*4`；所有帧尺寸必须一致。
 * @param {{delayMs?:number|number[], loop?:number}} [opts]
 *        `delayMs` 可给单值（广播）或逐帧数组；`loop` 是播放次数，0 = 无限。
 * @returns {Promise<Uint8Array>} 完整 PNG 文件字节（含签名与 IEND）。
 * @throws {RangeError} 空数组、尺寸非法、尺寸不一致、data 长度对不上。
 * @throws {TypeError} 帧不是对象、data 不是字节数组。
 * @throws {Error} 当前环境没有 CompressionStream。
 */
export async function encodeApng(frames, opts = {}) {
    if (!canEncodeApng()) {
        throw new Error('这个环境没有 CompressionStream，无法生成 APNG');
    }
    const list = assertFrames(frames);
    const { width, height } = list[0];
    const delaySpec = opts.delayMs === undefined ? APNG_DEFAULT_DELAY_MS : opts.delayMs;
    const plays = normalizePlays(opts.loop);

    const parts = [
        PNG_SIGNATURE,
        chunkOf('IHDR', ihdrData(width, height)),
        chunkOf('acTL', actlData(list.length, plays)),
    ];

    // sequence 从 0 起，fcTL 与 fdAT 交替消费同一个计数器（见文件头注释第一坑）。
    let sequence = 0;
    for (let i = 0; i < list.length; i++) {
        const frame = list[i];
        parts.push(chunkOf('fcTL', fctlData(sequence++, width, height, delayOf(delaySpec, i))));
        const zlib = await zlibDeflate(scanlinesOf(frame.data, width, height));
        if (i === 0) {
            // 第一帧的图像数据必须是 IDAT，且要紧跟在它的 fcTL 之后。
            parts.push(chunkOf('IDAT', zlib));
        } else {
            parts.push(chunkOf('fdAT', fdatData(sequence++, zlib)));
        }
    }
    parts.push(chunkOf('IEND', new Uint8Array(0)));
    return concatBytes(parts);
}

// ── 输入校验 ───────────────────────────────────────────────

function assertFrames(frames) {
    if (!Array.isArray(frames) || frames.length === 0) {
        throw new RangeError('APNG 至少要有一帧');
    }
    const out = [];
    let width = 0;
    let height = 0;
    for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        if (!frame || typeof frame !== 'object') throw new TypeError(`第 ${i} 帧不是对象`);
        const w = frame.width;
        const h = frame.height;
        if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
            throw new RangeError(`第 ${i} 帧尺寸不合法：${w}×${h}（必须是正整数）`);
        }
        const data = frame.data;
        if (!(data instanceof Uint8Array) && !(data instanceof Uint8ClampedArray)) {
            throw new TypeError(`第 ${i} 帧的 data 必须是 Uint8Array 或 Uint8ClampedArray`);
        }
        if (data.length !== w * h * 4) {
            throw new RangeError(`第 ${i} 帧的 data 长度 ${data.length} 与 ${w}×${h} 对不上（要 ${w * h * 4}）`);
        }
        if (i === 0) {
            width = w;
            height = h;
        } else if (w !== width || h !== height) {
            // IHDR 只有一份，APNG 所有帧必须同尺寸；要放不同尺寸得写 x_offset/y_offset 拼贴。
            throw new RangeError(`第 ${i} 帧尺寸 ${w}×${h} 与第一帧 ${width}×${height} 不一致`);
        }
        out.push({ width: w, height: h, data });
    }
    return out;
}

function normalizePlays(loop) {
    if (loop === undefined) return APNG_LOOP_FOREVER;
    if (!Number.isFinite(loop)) return APNG_LOOP_FOREVER;
    return Math.max(0, Math.floor(loop));
}

/**
 * 取第 index 帧的延时（毫秒）。钳到 ≥1 是因为「全部延时为 0」的动画在某些播放器里
 * 会被当成「尽快播完」而加速到看不出内容。
 */
function delayOf(spec, index) {
    const raw = Array.isArray(spec) ? spec[index] : spec;
    const ms = Number.isFinite(raw) ? raw : APNG_DEFAULT_DELAY_MS;
    return Math.max(1, Math.round(ms));
}

// ── 像素 → zlib 数据流 ──────────────────────────────────────

/** 每行前面补一个 filter 字节 0（None），这是 PNG 的扫描行格式要求。 */
function scanlinesOf(data, width, height) {
    const stride = width * 4;
    const out = new Uint8Array(height * (stride + 1));
    for (let y = 0; y < height; y++) {
        const at = y * (stride + 1);
        out[at] = FILTER_NONE;
        out.set(data.subarray(y * stride, (y + 1) * stride), at + 1);
    }
    return out;
}

/**
 * 裸 deflate + 自己拼 zlib 容器：2 字节头 + deflate 数据 + 4 字节 adler32（大端）。
 *
 * adler32 算在**未压缩**数据上 —— 写错了 `inflateSync` 会直接抛，属于一测就露的那种错。
 */
async function zlibDeflate(bytes) {
    const raw = await deflateRaw(bytes);
    const out = new Uint8Array(2 + raw.length + 4);
    out[0] = ZLIB_CMF;
    out[1] = ZLIB_FLG;
    out.set(raw, 2);
    writeU32(out, 2 + raw.length, adler32(bytes));
    return out;
}

/** 走 CompressionStream 拿裸 deflate 字节。边写边读，避免大块输入把管道堵死。 */
async function deflateRaw(bytes) {
    const stream = new CompressionStream('deflate-raw');
    const writing = (async () => {
        const writer = stream.writable.getWriter();
        await writer.write(bytes);
        await writer.close();
    })();
    const chunks = [];
    const reader = stream.readable.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    await writing;
    return concatBytes(chunks);
}

/** adler32：两个模 65521 的累加器，b 是 a 的前缀和。 */
function adler32(bytes) {
    let a = 1;
    let b = 0;
    for (let i = 0; i < bytes.length; i++) {
        a = (a + bytes[i]) % 65521;
        b = (b + a) % 65521;
    }
    return (b * 0x10000 + a) >>> 0;
}

// ── PNG 分块 ───────────────────────────────────────────────

/** 拼一个完整的 PNG 块：长度(4) + 类型(4) + 数据 + CRC32(4)，CRC 覆盖类型+数据。 */
function chunkOf(type, data) {
    const out = new Uint8Array(12 + data.length);
    writeU32(out, 0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    writeU32(out, 8 + data.length, crc32(out, 4, 8 + data.length));
    return out;
}

function ihdrData(width, height) {
    const data = new Uint8Array(13);
    writeU32(data, 0, width);
    writeU32(data, 4, height);
    data[8] = BIT_DEPTH;
    data[9] = COLOR_TYPE_RGBA;
    data[10] = 0; // compression method：只有 0 一种
    data[11] = 0; // filter method：只有 0 一种
    data[12] = 0; // interlace：0 = 不隔行
    return data;
}

function actlData(frames, plays) {
    const data = new Uint8Array(8);
    writeU32(data, 0, frames);
    writeU32(data, 4, plays);
    return data;
}

function fctlData(sequence, width, height, delayMs) {
    const data = new Uint8Array(26);
    writeU32(data, 0, sequence);
    writeU32(data, 4, width);
    writeU32(data, 8, height);
    writeU32(data, 12, 0); // x_offset：整帧导出，恒 0
    writeU32(data, 16, 0); // y_offset：同上
    writeU16(data, 20, delayMs); // delay_num：分母是 1000，所以这里就是毫秒
    writeU16(data, 22, DELAY_DEN);
    data[24] = APNG_DISPOSE_OP_BACKGROUND;
    data[25] = APNG_BLEND_OP_SOURCE;
    return data;
}

/** fdAT = 4 字节 sequence + 该帧的 zlib 数据（这就是「比 IDAT 多 4 字节」的那处）。 */
function fdatData(sequence, zlib) {
    const data = new Uint8Array(4 + zlib.length);
    writeU32(data, 0, sequence);
    data.set(zlib, 4);
    return data;
}

// ── 字节工具 ───────────────────────────────────────────────

function crc32(bytes, from, to) {
    let crc = 0xffffffff;
    for (let i = from; i < to; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function writeU32(out, at, value) {
    out[at] = (value >>> 24) & 0xff;
    out[at + 1] = (value >>> 16) & 0xff;
    out[at + 2] = (value >>> 8) & 0xff;
    out[at + 3] = value & 0xff;
}

function writeU16(out, at, value) {
    out[at] = (value >>> 8) & 0xff;
    out[at + 1] = value & 0xff;
}

function concatBytes(list) {
    let total = 0;
    for (const part of list) total += part.length;
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of list) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}
