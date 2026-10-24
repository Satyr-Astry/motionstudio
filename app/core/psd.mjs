/**
 * Kleks Motion —— Photoshop 文档（PSD / PSB）解析器
 *
 * 用途：把 .psd / .psb 字节流读成「文档尺寸 + 自底向上的图层列表」。每层给矩形、
 *      可见性、不透明度、混合模式、直接父组名，以及直通 alpha（未预乘）的 RGBA。
 * 环境：浏览器 ESM（Electron 渲染进程 / Chromium 130+）与 Node 18+，零依赖；
 *      zip 压缩的通道走全局 DecompressionStream（环境没有就按空白通道处理）。
 *
 * 段布局（按此顺序推进；每个长度字段都参与「越界」检查，读不够就抛中文错误）：
 *
 *   Header            '8BPS' | version u16 | 6×0 | channels u16
 *                     | height u32 | width u32 | depth u16 | colorMode u16
 *   Color Mode Data   u32 长度 + 数据                            —— 整体跳过
 *   Image Resources   u32 长度 + 数据                            —— 整体跳过
 *   Layer & Mask      PSD u32 / PSB u64 长度 + 数据              —— 只取 Layer Info
 *     Layer Info      PSD u32 / PSB u64 长度 + 数据
 *       图层数        PSD i16 / PSB i64（负值表示合并图省掉了首个 alpha，取绝对值）
 *       图层记录 × N  rect 4×i32(top,left,bottom,right) | 通道数 u16
 *                     | 通道信息 × M [id i16 | 数据长度 u32 / PSB u64]
 *                     | '8BIM' | 混合模式码 4 字节 | opacity u8 | clipping u8
 *                     | flags u8 | 填充 u8 | 附加数据长度 u32 | 附加数据
 *       附加数据       蒙版[4+len] | 混合范围[4+len] | pascal 名（4 字节对齐）
 *                     | 附加块 × K ['8BIM'/'8B64' | key 4 | 长度 u32/PSB u64 | 数据]
 *       通道数据       N × M 段，每段：压缩方式 u16 + 数据
 *                     （0 raw / 1 RLE-PackBits / 2 zip / 3 zip+水平差分预测）
 *     Global Layer Mask u32 长度 + 数据                          —— 跳过
 *   合并图像数据       不解析（图层才是导入来源）
 *
 * 限制：只支持 8 位/通道、RGB(3) 与灰度(1)；16/32 位、CMYK、Lab、索引色一律报错。
 *      蒙版 / 调整层 / 文本层 / 智能对象只保留像素与基本属性，路径、效果、动画不读。
 *      组靠 'lsct' 识别：真实 PSD 以类型 3（bounding section divider）收尾；没有 3 的
 *      文件（部分工具与合成样本）把类型 2 当作结束标志，见 assembleLayers 的说明。
 *      图层矩形沿用文档坐标（可能为负）；像素是直通 alpha，不预乘、不做色彩管理。
 */

export const PSD_FORMAT = { name: 'Photoshop 文档', ext: ['.psd', '.psb'] };

// 单个图层的像素上限：再大就分配不出 RGBA，这里先给中文错误而不是 RangeError。
const MAX_LAYER_PIXELS = 64 * 1024 * 1024;
// 图层记录的最小字节数：rect(16) + 通道数(2) + 签名(4) + 模式(4) + 4×u8 + 附加长度(4)。
const MIN_LAYER_RECORD = 34;
// 长度为 0 的通道数据共用同一块空缓冲，避免每层都 new 一次。
const EMPTY = new Uint8Array(0);

// 混合模式 4 字节码 → 可读名字。'pass' 是图层里的 normal，'norm' 是合并图里的写法。
// 未知码不猜，原样返回 4 字节串，方便排障时对着文件查。
const BLEND_MODES = Object.freeze({
    'pass': 'normal',
    'norm': 'normal',
    'diss': 'dissolve',
    'dark': 'darken',
    'mul ': 'multiply',
    'idiv': 'color burn',
    'lbrn': 'linear burn',
    'dkCl': 'darker color',
    'lite': 'lighten',
    'scrn': 'screen',
    'div ': 'color dodge',
    'lddg': 'linear dodge',
    'lgCl': 'lighter color',
    'over': 'overlay',
    'sLit': 'soft light',
    'hLit': 'hard light',
    'vLit': 'vivid light',
    'lLit': 'linear light',
    'pLit': 'pin light',
    'hMix': 'hard mix',
    'diff': 'difference',
    'smud': 'exclusion',
    'fsub': 'subtract',
    'fdiv': 'divide',
    'hue ': 'hue',
    'sat ': 'saturation',
    'colr': 'color',
    'lum ': 'luminosity',
});

// ── 字节读取器：所有越界都在 need() 里变成中文错误 ──────────────────────────────

class Reader {
    /**
     * @param {Uint8Array} bytes 完整字节流
     * @param {number} start 起点（含）
     * @param {number} end 终点（不含）
     */
    constructor(bytes, start = 0, end = bytes.length) {
        this.buf = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this.pos = start;
        this.end = Math.min(end, bytes.length);
    }

    get left() {
        return this.end - this.pos;
    }

    /** 长度字段可能是负数、NaN 或超出剩余字节：统一在这里报「越界」。 */
    need(n, what) {
        const left = this.end - this.pos;
        if (!(n >= 0) || n > left) {
            throw new Error(`PSD 数据越界：读取「${what}」需要 ${n} 字节，仅剩 ${left} 字节`);
        }
    }

    u8(what) {
        this.need(1, what);
        const v = this.view.getUint8(this.pos);
        this.pos += 1;
        return v;
    }

    u16(what) {
        this.need(2, what);
        const v = this.view.getUint16(this.pos);
        this.pos += 2;
        return v;
    }

    i16(what) {
        this.need(2, what);
        const v = this.view.getInt16(this.pos);
        this.pos += 2;
        return v;
    }

    u32(what) {
        this.need(4, what);
        const v = this.view.getUint32(this.pos);
        this.pos += 4;
        return v;
    }

    i32(what) {
        this.need(4, what);
        const v = this.view.getInt32(this.pos);
        this.pos += 4;
        return v;
    }

    /** PSB 的 8 字节长度字段：高 32 位 × 2^32 + 低 32 位（文件远不到 2^53）。 */
    u64(what) {
        this.need(8, what);
        const hi = this.view.getUint32(this.pos);
        const lo = this.view.getUint32(this.pos + 4);
        this.pos += 8;
        return hi * 4294967296 + lo;
    }

    /** PSB 的 8 字节有符号数（图层数用；-1 表示负计数）。 */
    i64(what) {
        this.need(8, what);
        const hi = this.view.getInt32(this.pos);
        const lo = this.view.getUint32(this.pos + 4);
        this.pos += 8;
        return hi * 4294967296 + lo;
    }

    bytes(n, what) {
        this.need(n, what);
        const out = this.buf.subarray(this.pos, this.pos + n);
        this.pos += n;
        return out;
    }

    skip(n, what) {
        this.need(n, what);
        this.pos += n;
    }

    /** 4 字节 ASCII 码（'8BPS' / '8BIM' / 混合模式码），不做字符集猜测。 */
    ascii(n, what) {
        return latin1(this.bytes(n, what));
    }

    /** 切出 n 字节的独立子读取器，父读取器同步前进。 */
    sub(n, what) {
        const body = this.bytes(n, what);
        return new Reader(body, 0, body.length);
    }
}

function latin1(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
    return out;
}

function utf16be(bytes) {
    let out = '';
    const n = bytes.length >> 1;
    for (let i = 0; i < n; i += 1) out += String.fromCharCode((bytes[2 * i] << 8) | bytes[2 * i + 1]);
    return out;
}

function toBytes(buffer) {
    if (buffer instanceof Uint8Array) return buffer;
    if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
    if (buffer && ArrayBuffer.isView(buffer)) {
        return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    }
    throw new Error('PSD 解析失败：入参必须是 ArrayBuffer 或 Uint8Array');
}

// ── Header ────────────────────────────────────────────────────────────────────

function readHeader(r) {
    const signature = r.ascii(4, '文件签名');
    if (signature !== '8BPS') throw new Error(`不是 PSD 文件：签名为 "${signature}"，应为 "8BPS"`);
    const version = r.u16('版本号');
    if (version !== 1 && version !== 2) throw new Error(`不支持的版本号：${version}（只支持 1=PSD、2=PSB）`);
    r.skip(6, '预留字段');
    const channels = r.u16('通道数');
    const height = r.u32('文档高度');
    const width = r.u32('文档宽度');
    const depth = r.u16('位深');
    const colorMode = r.u16('色彩模式');
    if (depth !== 8) throw new Error(`不支持的位深：${depth} 位/通道（只支持 8 位）`);
    if (colorMode !== 3 && colorMode !== 1) {
        throw new Error(`不支持的色彩模式：${colorMode}（只支持 3=RGB、1=灰度）`);
    }
    if (width < 1 || height < 1 || width > 300000 || height > 300000) {
        throw new Error(`文档尺寸非法：${width} × ${height}`);
    }
    return { psb: version === 2, channels, width, height, depth, colorMode };
}

// ── 图层段 ────────────────────────────────────────────────────────────────────

async function readLayerSection(section, head) {
    if (section.left < (head.psb ? 8 : 4)) return [];
    const infoLen = head.psb ? section.u64('图层信息长度') : section.u32('图层信息长度');
    if (infoLen === 0) return [];
    const info = section.sub(infoLen, '图层信息');

    const countRaw = head.psb ? info.i64('图层数') : info.i16('图层数');
    const count = Math.abs(countRaw);
    if (!Number.isFinite(count)) throw new Error(`PSD 数据异常：图层数为 ${countRaw}`);
    if (count * MIN_LAYER_RECORD > info.left) {
        throw new Error(`PSD 数据越界：声明 ${count} 个图层，图层信息段却只有 ${info.left} 字节`);
    }

    const records = [];
    for (let i = 0; i < count; i += 1) records.push(readLayerRecord(info, head));

    // 通道数据紧接在所有记录之后，顺序与通道信息一致：先按声明长度切出来，
    // 再逐个解码（zip 要等 DecompressionStream，所以这里是异步的）。
    const pending = [];
    for (const rec of records) {
        for (const ch of rec.channels) {
            pending.push({
                rec,
                id: ch.id,
                body: ch.length > 0 ? info.bytes(ch.length, '图层通道数据') : EMPTY,
            });
        }
    }
    for (const item of pending) {
        item.rec.planes.set(item.id, await decodeChannel(item.body, item.rec, head));
    }

    return assembleLayers(records, head);
}

function readLayerRecord(r, head) {
    const top = r.i32('图层矩形 top');
    const left = r.i32('图层矩形 left');
    const bottom = r.i32('图层矩形 bottom');
    const right = r.i32('图层矩形 right');
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);

    const channelCount = r.u16('图层通道数');
    const channels = [];
    for (let i = 0; i < channelCount; i += 1) {
        const id = r.i16('通道 id');
        const length = head.psb ? r.u64('通道数据长度') : r.u32('通道数据长度');
        channels.push({ id, length });
    }

    r.skip(4, '混合模式签名'); // 固定 '8BIM'，长度固定，读掉即可
    const blendKey = r.ascii(4, '混合模式码');
    const opacity = r.u8('不透明度');
    r.skip(1, '剪切标记');
    const flags = r.u8('图层标志');
    r.skip(1, '填充字节');
    const extraLen = r.u32('图层附加数据长度');

    const rec = {
        name: '',
        visible: (flags & 0x02) === 0, // bit1 = 隐藏
        opacity: opacity / 255,
        blendMode: BLEND_MODES[blendKey] || blendKey,
        left,
        top,
        width,
        height,
        divider: 0,
        channels,
        planes: new Map(),
    };
    readExtraData(r, extraLen, head, rec);
    if (rec.width * rec.height > MAX_LAYER_PIXELS) {
        throw new Error(`图层「${rec.name}」尺寸过大：${rec.width} × ${rec.height}`);
    }
    return rec;
}

/** 附加数据：蒙版、混合范围、pascal 名、附加块。不认识的块按长度跳过。 */
function readExtraData(r, extraLen, head, rec) {
    if (extraLen <= 0) return;
    const end = Math.min(r.pos + extraLen, r.end);
    skipBlock(r, '图层蒙版数据');
    skipBlock(r, '混合范围');

    if (r.pos < end) {
        const nameLen = r.u8('图层名字节数');
        if (nameLen > 0) rec.name = latin1(r.bytes(nameLen, '图层名'));
        const used = 1 + nameLen;
        const pad = (4 - (used % 4)) % 4;
        if (pad > 0 && r.pos + pad <= end) r.skip(pad, '图层名对齐填充');
    }

    const minBlock = head.psb ? 16 : 12;
    while (end - r.pos >= minBlock) {
        const at = r.pos;
        const signature = r.ascii(4, '附加块签名');
        if (signature !== '8BIM' && signature !== '8B64') {
            r.pos = end; // 块边界已错位：放弃剩余附加数据，不让它污染后面的图层
            break;
        }
        const key = r.ascii(4, '附加块标识');
        const len = head.psb ? r.u64('附加块长度') : r.u32('附加块长度');
        if (len > r.end - r.pos) {
            r.pos = end;
            break;
        }
        const block = r.sub(len, `附加块 ${key}`);
        if (key === 'luni') readUnicodeName(block, rec);
        else if (key === 'lsct' || key === 'lsdk') rec.divider = block.u32('分组类型');
        // 少数写出器不把奇数长度补齐算进长度字段；下一个块能对齐才补 1 字节。
        if ((len & 1) !== 0 && r.pos < end) r.skip(1, '附加块对齐');
        if (r.pos <= at) {
            r.pos = end;
            break;
        }
    }
    r.pos = end;
}

function skipBlock(r, what) {
    const len = r.u32(`${what}长度`);
    if (len > 0) r.skip(len, what);
}

/** 'luni'：4 字节字符数（UTF-16 码元）+ UTF-16BE 字符。空串时保留 pascal 名。 */
function readUnicodeName(block, rec) {
    if (block.left < 4) return;
    const chars = block.u32('Unicode 图层名字符数');
    if (chars <= 0 || chars * 2 > block.left) return;
    const text = utf16be(block.bytes(chars * 2, 'Unicode 图层名'));
    if (text) rec.name = text;
}

/**
 * 记录 → 输出图层。组的分隔层不产出图层，只维护组名栈给 parentName 用。
 *
 * 分隔类型：1/2 是「组开始」（真实 PSD 里 2 只是表示折叠），3 是「组结束」。
 * 但有些工具/样本只写 1 和 2（用 2 当结束），所以文件里没有 3 时把 2 当结束，
 * 这样真实 PSD 与只写 1/2 的简化文件都能对齐；配对失败时退化成「1 开、2 开」。
 */
function assembleLayers(records, head) {
    const hasEndMarker = records.some((rec) => rec.divider === 3);
    const groups = [];
    const out = [];
    for (const rec of records) {
        const type = rec.divider;
        if (type === 3) {
            if (groups.length > 0) groups.pop();
            continue;
        }
        if (type === 1 || type === 2) {
            if (type === 2 && !hasEndMarker && groups.length > 0) {
                groups.pop();
                continue;
            }
            groups.push(rec.name);
            continue;
        }
        out.push({
            name: rec.name,
            visible: rec.visible,
            opacity: rec.opacity,
            blendMode: rec.blendMode,
            left: rec.left,
            top: rec.top,
            width: rec.width,
            height: rec.height,
            rgba: composeRgba(rec, head.colorMode),
            isGroup: false,
            parentName: groups.length > 0 ? groups[groups.length - 1] : null,
        });
    }
    return out;
}

// ── 通道解码 ──────────────────────────────────────────────────────────────────

async function decodeChannel(body, rec, head) {
    const width = rec.width;
    const height = rec.height;
    const size = width * height;
    const out = new Uint8Array(size);
    if (size === 0 || body.length < 2) return out;

    const r = new Reader(body);
    const compression = r.u16('通道压缩方式');
    if (compression === 0) {
        const copy = Math.min(size, r.left);
        out.set(body.subarray(r.pos, r.pos + copy));
        return out;
    }
    if (compression === 1) return decodePackBits(r, width, height, head.psb);
    if (compression === 2 || compression === 3) {
        const flat = await inflateChannel(body.subarray(2));
        if (!flat || flat.length === 0) return out;
        out.set(flat.subarray(0, Math.min(size, flat.length)));
        if (compression === 3) unpredictRows(out, width, height);
        return out;
    }
    // 其它压缩方式（规范未定义）按空白通道处理，导入不因此失败
    return out;
}

/** 压缩方式 1：每行一个长度表项（PSD u16 / PSB u32），行数据是 PackBits 流。 */
function decodePackBits(r, rowBytes, height, psb) {
    const out = new Uint8Array(rowBytes * height);
    const rows = new Array(height);
    for (let y = 0; y < height; y += 1) {
        rows[y] = psb ? r.u32('RLE 行字节数') : r.u16('RLE 行字节数');
    }
    for (let y = 0; y < height; y += 1) {
        const count = Math.min(rows[y], r.left);
        if (count === 0) continue;
        unpackRow(r.bytes(count, 'RLE 行数据'), out, y * rowBytes, rowBytes);
    }
    return out;
}

/** PackBits：n>=0 复制 n+1 个字节，n<0 重复下一字节 1-n 次，-128 空操作。 */
function unpackRow(src, dst, offset, rowBytes) {
    let i = 0;
    let o = offset;
    const end = offset + rowBytes;
    while (i < src.length && o < end) {
        const n = (src[i] << 24) >> 24;
        i += 1;
        if (n >= 0) {
            const count = n + 1;
            const take = Math.min(count, src.length - i, end - o);
            dst.set(src.subarray(i, i + take), o);
            i += take;
            o += take;
            if (take < count) break;
        } else if (n !== -128) {
            if (i >= src.length) break;
            const value = src[i];
            i += 1;
            const count = 1 - n;
            const take = Math.min(count, end - o);
            dst.fill(value, o, o + take);
            o += take;
            if (take < count) break;
        }
    }
}

/** 压缩方式 3：每行第一个像素差分基准，之后逐个累加回原值（8 位/通道）。 */
function unpredictRows(flat, rowBytes, height) {
    for (let y = 0; y < height; y += 1) {
        const base = y * rowBytes;
        for (let x = 1; x < rowBytes; x += 1) {
            flat[base + x] = (flat[base + x] + flat[base + x - 1]) & 0xff;
        }
    }
}

/**
 * 压缩方式 2/3：通道里是 deflate 流。Photoshop 写裸 deflate，个别工具会带 zlib 头，
 * 所以按头部特征选顺序，两种都试；都失败或环境没有 DecompressionStream 时返回 null
 * （上层按空白通道处理，不抛异常）。
 */
async function inflateChannel(data) {
    if (data.length === 0 || typeof DecompressionStream !== 'function') return null;
    const formats = looksLikeZlib(data) ? ['deflate', 'deflate-raw'] : ['deflate-raw', 'deflate'];
    for (const format of formats) {
        try {
            return await inflateWith(data, format);
        } catch (err) {
            // 换另一种封装再试
        }
    }
    return null;
}

async function inflateWith(data, format) {
    const stream = new DecompressionStream(format);
    const writer = stream.writable.getWriter();
    // 数据损坏时写入侧会拒绝；错误统一由读取侧抛出，这里先兜住避免未处理的拒绝。
    const written = writer.write(data).then(() => writer.close()).catch(() => {});
    const reader = stream.readable.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length) {
            chunks.push(value);
            total += value.length;
        }
    }
    await written.catch(() => {});
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(total);
    let off = 0;
    for (const chunk of chunks) {
        out.set(chunk, off);
        off += chunk.length;
    }
    return out;
}

function looksLikeZlib(data) {
    if (data.length < 2) return false;
    return (data[0] & 0x0f) === 8 && ((data[0] << 8) | data[1]) % 31 === 0;
}

// ── 通道合并成 RGBA ───────────────────────────────────────────────────────────

function composeRgba(rec, colorMode) {
    const width = rec.width;
    const height = rec.height;
    const size = width * height;
    if (size === 0) return new Uint8ClampedArray(0);
    const rgba = new Uint8ClampedArray(size * 4);
    const alpha = rec.planes.get(-1);
    if (colorMode === 3) {
        const red = rec.planes.get(0);
        const green = rec.planes.get(1);
        const blue = rec.planes.get(2);
        for (let i = 0, p = 0; i < size; i += 1, p += 4) {
            rgba[p] = red ? red[i] : 0;
            rgba[p + 1] = green ? green[i] : 0;
            rgba[p + 2] = blue ? blue[i] : 0;
            rgba[p + 3] = alpha ? alpha[i] : 255;
        }
        return rgba;
    }
    const gray = rec.planes.get(0);
    for (let i = 0, p = 0; i < size; i += 1, p += 4) {
        const v = gray ? gray[i] : 0;
        rgba[p] = v;
        rgba[p + 1] = v;
        rgba[p + 2] = v;
        rgba[p + 3] = alpha ? alpha[i] : 255;
    }
    return rgba;
}

// ── 入口 ──────────────────────────────────────────────────────────────────────

/**
 * 解析 PSD / PSB。
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Promise<{ width:number, height:number, depth:number, colorMode:number, layers:object[] }>}
 */
export async function parsePsd(buffer) {
    const bytes = toBytes(buffer);
    const r = new Reader(bytes);
    const head = readHeader(r);

    r.skip(r.u32('色彩模式数据长度'), '色彩模式数据');
    r.skip(r.u32('图像资源长度'), '图像资源');

    const sectionLen = head.psb ? r.u64('图层与蒙版段长度') : r.u32('图层与蒙版段长度');
    const section = r.sub(sectionLen, '图层与蒙版段');
    const layers = await readLayerSection(section, head);

    return {
        width: head.width,
        height: head.height,
        depth: head.depth,
        colorMode: head.colorMode,
        layers,
    };
}
