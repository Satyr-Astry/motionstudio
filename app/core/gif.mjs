// GIF 导出（GIF89a）：把一串「ImageData 形状」的帧编成一张能循环播放的透明动图。
//
// 纯函数、零依赖、零 DOM：输入是 `{ data, width, height }` 数组，输出是字节流，
// 整条链路只有三步 —— 全局调色板量化 → 逐帧索引化（可选抖动）→ LZW 压进 GIF 块。
//
// 三条已知限制（导出提示里要写出来，别让用户以为遇到 bug）：
//   1. GIF 的透明只有 1 位：alpha 只有「透 / 不透」两态，半透明描边与羽化会变硬边。
//   2. 全局调色板最多 256 色（透明还占一格）：渐变与柔和阴影会出现色带；换成每帧
//      局部调色板颜色能翻倍，但每帧都带一张表，动画体积也跟着翻倍，不划算。
//   3. 同画质下 GIF 比 WebM / APNG 都大：LZW 只压行内的重复，没有帧间压缩。

/** 文件头魔数（GIF89a；87a 不支持透明与循环扩展，这里只写 89a）。 */
const HEADER = 'GIF89a';

/** 流结束标记。 */
const TRAILER = 0x3b;

/** 调色板最多 256 色：GIF 的全局色表上限，也是 8 位索引的上限。 */
export const GIF_MAX_COLORS = 256;

/** alpha 低于它就算透明：GIF 没有中间态，只能二选一。 */
export const GIF_ALPHA_CUTOFF = 128;

/** 延时缺省值（毫秒）：GIF 单位是 1/100 秒，100ms = 10 个 tick，整数不丢精度。 */
export const GIF_DEFAULT_DELAY_MS = 100;

/** 浏览器对 delay < 2 的历史特例：很多解码器把 0/1 当 10 个 tick 处理，所以兜到 2。 */
const MIN_DELAY_TICKS = 2;

/** LZW 最小码宽的规范下限：2 位才装得下 clear + eoi 两个保留码。 */
const MIN_CODE_SIZE = 2;

/** LZW 字典上限：12 位码最多 4096 项，满了要发 clear 重开。 */
const MAX_LZW_CODES = 4096;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const depthOf = (capacity) => Math.round(Math.log2(capacity));

// ---- 输入校验 -------------------------------------------------------------

/**
 * 校验帧数组：形状不对就抛，绝不静默产出坏文件。
 * @param {Array<{data: Uint8ClampedArray|Uint8Array|number[], width: number, height: number}>} frames
 * @returns {Array<object>} 原样返回（只读）
 */
function assertFrames(frames) {
    if (!Array.isArray(frames) || frames.length === 0) {
        throw new RangeError('gif：至少要有一帧才能编码（空数组直接抛，避免写出 0 字节的坏文件）');
    }
    for (let i = 0; i < frames.length; i++) {
        const f = frames[i];
        if (!f || !f.data || !(f.width > 0) || !(f.height > 0)) {
            throw new TypeError('gif：第 ' + i + ' 帧缺 data / width / height');
        }
        if (f.data.length !== f.width * f.height * 4) {
            throw new RangeError(
                'gif：第 ' + i + ' 帧的 data 长度是 ' + f.data.length + '，应为 ' + f.width * f.height * 4,
            );
        }
    }
    return frames;
}

/** 帧尺寸不一致时取第一帧当逻辑屏幕，其余帧各自按自己的尺寸贴左上角。 */
function screenSize(frames) {
    return { width: frames[0].width, height: frames[0].height };
}

// ---- 量化：直方图 + 中位切分 -------------------------------------------------

/**
 * 中位切分（median cut）：把颜色立方体按「最宽通道的中位」一刀刀切到目标盒子数，
 * 每个盒子取加权平均色。
 *
 * 选它的理由：像素画与特效动画的调色板通常只有几十色，中位切分在这种「颜色少而
 * 分明」的输入上比八叉树更准（八叉树会按位层级砍掉本来能分开的颜色），实现也短；
 * 代价是极端多样的照片类输入会慢一点，但导出是离线操作，不值得为它引入依赖。
 *
 * @param {Array<{r: number, g: number, b: number, n: number}>} bins 直方图桶（r/g/b 是累加值）
 * @param {number} limit 最多切出几个颜色
 * @returns {Array<{r: number, g: number, b: number}>} 平均色（整数 0–255）
 */
function medianCut(bins, limit) {
    if (bins.length === 0) return [];
    const boxes = [bins.slice(0)];
    while (boxes.length < limit) {
        let pick = -1;
        let widest = 0;
        for (let i = 0; i < boxes.length; i++) {
            if (boxes[i].length < 2) continue;
            const span = boxSpan(boxes[i]);
            if (span.extent > widest) {
                widest = span.extent;
                pick = i;
            }
        }
        if (pick < 0) break;
        const box = boxes[pick];
        const axis = boxSpan(box).axis;
        box.sort((a, b) => axisValue(a, axis) - axisValue(b, axis));
        // 按人口（像素数）找中位，而不是按桶个数：大片底色不该被零碎杂色挤掉。
        const total = box.reduce((sum, bin) => sum + bin.n, 0);
        let acc = 0;
        let cut = 1;
        for (let i = 0; i < box.length - 1; i++) {
            acc += box[i].n;
            if (acc * 2 >= total) {
                cut = i + 1;
                break;
            }
        }
        boxes.splice(pick, 1, box.slice(0, cut), box.slice(cut));
    }
    return boxes.map(averageBin);
}

const AXES = ['r', 'g', 'b'];

function axisValue(bin, axis) {
    return bin[axis] / bin.n;
}

/** 盒子最宽的通道与它的跨度。 */
function boxSpan(box) {
    let best = 0;
    let axis = 'r';
    for (const ch of AXES) {
        let lo = Infinity;
        let hi = -Infinity;
        for (const bin of box) {
            const v = axisValue(bin, ch);
            if (v < lo) lo = v;
            if (v > hi) hi = v;
        }
        if (hi - lo > best) {
            best = hi - lo;
            axis = ch;
        }
    }
    return { axis, extent: best };
}

function averageBin(box) {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (const bin of box) {
        r += bin.r;
        g += bin.g;
        b += bin.b;
        n += bin.n;
    }
    const d = n || 1;
    return { r: Math.round(r / d), g: Math.round(g / d), b: Math.round(b / d) };
}

// ---- 全局调色板 + 逐帧索引化 -------------------------------------------------

/**
 * 把所有帧量化到一张**全局**调色板，并产出每帧的索引图。
 *
 * @param {Array<{data: Uint8ClampedArray|number[], width: number, height: number}>} frames
 * @param {{ maxColors?: number, dither?: boolean }} [opts]
 * @returns {{
 *   palette: number[], indexed: Uint8Array[], width: number, height: number,
 *   hasTransparent: boolean, transparentIndex: number, colorCount: number
 * }}
 */
export function quantizeFrames(frames, opts) {
    const list = assertFrames(frames);
    const options = opts || {};
    const size = screenSize(list);

    // 第一遍：建直方图，顺便确认有没有透明像素（透明要占掉一个保留索引）。
    const hist = new Map();
    let hasTransparent = false;
    for (const f of list) {
        const d = f.data;
        for (let i = 0; i < d.length; i += 4) {
            if (d[i + 3] < GIF_ALPHA_CUTOFF) {
                hasTransparent = true;
                continue;
            }
            // 5 位/通道分桶：32768 个桶足够把相近的抖动噪点并起来，又不至于让中位切分太慢。
            const key = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3);
            const bin = hist.get(key);
            if (bin) {
                bin.r += d[i];
                bin.g += d[i + 1];
                bin.b += d[i + 2];
                bin.n += 1;
            } else {
                hist.set(key, { r: d[i], g: d[i + 1], b: d[i + 2], n: 1 });
            }
        }
    }

    const wanted = Math.max(2, Math.min(GIF_MAX_COLORS, Math.round(options.maxColors) || GIF_MAX_COLORS));
    const colorLimit = hasTransparent ? wanted - 1 : wanted;
    const colors = medianCut([...hist.values()], colorLimit);

    // 透明索引固定在最前面（0），不透明颜色从 offset 开始 —— 这样不用为了留位子再重映射一遍。
    const transparentIndex = 0;
    const offset = hasTransparent ? 1 : 0;
    const palette = [];
    if (hasTransparent) palette.push(0, 0, 0);
    if (colors.length === 0) {
        // 全透明帧：调色板至少要有一格，否则 GIF 的色表长度会变成 0。
        palette.push(0, 0, 0);
    } else {
        for (const c of colors) palette.push(c.r, c.g, c.b);
    }
    const colorCount = palette.length / 3;

    const indexed = [];
    const cache = new Map();
    for (const f of list) {
        indexed.push(
            options.dither
                ? ditherFrame(f, palette, offset, colorCount - offset, transparentIndex, cache)
                : nearestFrame(f, palette, offset, colorCount - offset, transparentIndex, cache),
        );
    }

    return {
        palette,
        indexed,
        width: size.width,
        height: size.height,
        hasTransparent,
        transparentIndex,
        colorCount,
    };
}

/** 最近色：线性扫（≤256 项），按 24 位 RGB 缓存，像素画基本只有几十次真扫。 */
function nearestIndex(palette, offset, count, r, g, b, cache) {
    const key = (r << 16) | (g << 8) | b;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    let best = offset;
    let bestDist = Infinity;
    for (let i = 0; i < count; i++) {
        const p = (offset + i) * 3;
        const dr = r - palette[p];
        const dg = g - palette[p + 1];
        const db = b - palette[p + 2];
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) {
            bestDist = dist;
            best = offset + i;
            if (dist === 0) break;
        }
    }
    cache.set(key, best);
    return best;
}

function nearestFrame(frame, palette, offset, count, transparentIndex, cache) {
    const d = frame.data;
    const out = new Uint8Array(frame.width * frame.height);
    let p = 0;
    for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] < GIF_ALPHA_CUTOFF) {
            out[p++] = transparentIndex;
            continue;
        }
        out[p++] = nearestIndex(palette, offset, count, d[i], d[i + 1], d[i + 2], cache);
    }
    return out;
}

/**
 * Floyd–Steinberg 抖动：把量化误差按 7/16、3/16、5/16、1/16 摊给右、左下、下、右下。
 * 默认关 —— 像素画要的是干净色块，抖动反而把硬边弄脏；渐变类素材才需要它。
 */
function ditherFrame(frame, palette, offset, count, transparentIndex, cache) {
    const { width: w, height: h } = frame;
    const d = frame.data;
    const out = new Uint8Array(w * h);
    let cur = new Float32Array(w * 3);
    let next = new Float32Array(w * 3);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const o = y * w + x;
            if (d[i + 3] < GIF_ALPHA_CUTOFF) {
                out[o] = transparentIndex;
                continue;
            }
            const e = x * 3;
            const r = clamp(d[i] + cur[e], 0, 255);
            const g = clamp(d[i + 1] + cur[e + 1], 0, 255);
            const b = clamp(d[i + 2] + cur[e + 2], 0, 255);
            const idx = nearestIndex(palette, offset, count, Math.round(r), Math.round(g), Math.round(b), cache);
            out[o] = idx;
            const p = idx * 3;
            const er = r - palette[p];
            const eg = g - palette[p + 1];
            const eb = b - palette[p + 2];
            spread(cur, next, e, x, w, er, eg, eb);
        }
        const swap = cur;
        cur = next;
        next = swap;
        next.fill(0);
    }
    return out;
}

function spread(cur, next, e, x, w, er, eg, eb) {
    if (x + 1 < w) {
        cur[e + 3] += (er * 7) / 16;
        cur[e + 4] += (eg * 7) / 16;
        cur[e + 5] += (eb * 7) / 16;
    }
    if (x > 0) {
        next[e - 3] += (er * 3) / 16;
        next[e - 2] += (eg * 3) / 16;
        next[e - 1] += (eb * 3) / 16;
    }
    next[e] += (er * 5) / 16;
    next[e + 1] += (eg * 5) / 16;
    next[e + 2] += (eb * 5) / 16;
    if (x + 1 < w) {
        next[e + 3] += er / 16;
        next[e + 4] += eg / 16;
        next[e + 5] += eb / 16;
    }
}

// ---- LZW（GIF 变体） --------------------------------------------------------

/**
 * GIF 版 LZW：码流按 LSB 优先塞进字节，字典满 4096 项发 clear 重开。
 *
 * 三个容易写错的地方：
 *   1. 码宽切换必须比「字典容量」晚一步 —— 解码器永远比编码器晚一条建表，所以这里
 *      的判断是 `nextCode > (1 << codeSize)`，而不是 `>=`；写成 `>=` 会在切换点错位一码。
 *   2. clear 码用**当前**码宽发出去之后再复位，不能先复位再发。
 *   3. 最后一码之后不足一字节的残余位要补零写出去，解码器才收得到 eoi。
 *
 * @param {Uint8Array} indices 索引图
 * @param {number} minCodeSize 最小码宽（≥2）
 * @returns {number[]} 压缩后的字节（不含块长度前缀）
 */
function lzwCompress(indices, minCodeSize) {
    const out = [];
    let bitBuf = 0;
    let bitLen = 0;
    const clearCode = 1 << minCodeSize;
    const eoiCode = clearCode + 1;
    let codeSize = minCodeSize + 1;
    let nextCode = eoiCode + 1;
    const dict = new Map();

    const emit = (code) => {
        bitBuf |= code << bitLen;
        bitLen += codeSize;
        while (bitLen >= 8) {
            out.push(bitBuf & 0xff);
            bitBuf >>>= 8;
            bitLen -= 8;
        }
    };

    emit(clearCode);
    if (indices.length === 0) {
        emit(eoiCode);
        if (bitLen > 0) out.push(bitBuf & 0xff);
        return out;
    }

    let prefix = indices[0];
    for (let i = 1; i < indices.length; i++) {
        const k = indices[i];
        const key = (prefix << 8) | k;
        const hit = dict.get(key);
        if (hit !== undefined) {
            prefix = hit;
            continue;
        }
        emit(prefix);
        if (nextCode < MAX_LZW_CODES) {
            dict.set(key, nextCode);
            nextCode += 1;
            if (nextCode > (1 << codeSize) && codeSize < 12) codeSize += 1;
        } else {
            emit(clearCode);
            dict.clear();
            codeSize = minCodeSize + 1;
            nextCode = eoiCode + 1;
        }
        prefix = k;
    }
    emit(prefix);
    emit(eoiCode);
    if (bitLen > 0) out.push(bitBuf & 0xff);
    return out;
}

// ---- 字节流写出 -------------------------------------------------------------

function byteWriter() {
    const bytes = [];
    return {
        bytes,
        byte(v) {
            bytes.push(v & 0xff);
        },
        u16(v) {
            bytes.push(v & 0xff, (v >> 8) & 0xff);
        },
        ascii(s) {
            for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff);
        },
        chunk(data) {
            // GIF 的子块：每块 ≤255 字节，前置长度字节，最后用 0 长度收尾。
            for (let i = 0; i < data.length; i += 255) {
                const part = data.slice(i, i + 255);
                bytes.push(part.length);
                for (const b of part) bytes.push(b);
            }
            bytes.push(0);
        },
    };
}

/** 容量向上取到 2 的幂（GIF 色表长度只能是 2^(n+1)）。 */
function pow2Ceil(n) {
    let cap = 1;
    while (cap < n) cap *= 2;
    return cap;
}

// ---- 编码主入口 -------------------------------------------------------------

/**
 * 把帧数组编成一张 GIF89a 动图。
 *
 * @param {Array<{data: Uint8ClampedArray|number[], width: number, height: number}>} frames
 * @param {{ delayMs?: number|number[], loop?: boolean, maxColors?: number, dither?: boolean }} [opts]
 *   `delayMs` 单值或逐帧数组（毫秒）；`loop` 默认 true；`maxColors` 默认 256（含透明格）。
 * @returns {Uint8Array} 完整 GIF 字节流
 */
export function encodeGif(frames, opts) {
    const options = opts || {};
    const q = quantizeFrames(frames, options);
    const capacity = Math.max(2, pow2Ceil(q.colorCount));
    const depth = depthOf(capacity);
    const delay = delayTable(options.delayMs, frames.length);
    const w = byteWriter();

    w.ascii(HEADER);
    // 逻辑屏幕描述符：宽、高、打包字段、背景色索引、像素宽高比（0 = 未指定）。
    w.u16(q.width);
    w.u16(q.height);
    w.byte(0x80 | ((depth - 1) << 4) | (depth - 1)); // 有全局色表 | 颜色分辨率 | 色表长度
    w.byte(q.hasTransparent ? q.transparentIndex : 0);
    w.byte(0);

    // 全局色表补齐到 2^depth 项（不足的写黑）。
    for (let i = 0; i < capacity; i++) {
        const p = i * 3;
        w.byte(p < q.palette.length ? q.palette[p] : 0);
        w.byte(p + 1 < q.palette.length ? q.palette[p + 1] : 0);
        w.byte(p + 2 < q.palette.length ? q.palette[p + 2] : 0);
    }

    if (options.loop !== false) writeNetscapeLoop(w);
    for (let i = 0; i < q.indexed.length; i++) {
        writeFrame(w, frames[i], q.indexed[i], {
            delay: delay[i],
            transparent: q.hasTransparent,
            transparentIndex: q.transparentIndex,
            depth,
        });
    }
    w.byte(TRAILER);
    return Uint8Array.from(w.bytes);
}

/** 每帧延时（单位 1/100 秒）：数组按帧取，单值广播；缺省 100ms。 */
function delayTable(delayMs, frameCount) {
    const out = [];
    for (let i = 0; i < frameCount; i++) {
        const raw = Array.isArray(delayMs) ? delayMs[i] : delayMs;
        const ms = typeof raw === 'number' && Number.isFinite(raw) ? raw : GIF_DEFAULT_DELAY_MS;
        out.push(Math.max(MIN_DELAY_TICKS, Math.round(ms / 10)));
    }
    return out;
}

/** NETSCAPE2.0 应用扩展：loop count 0 = 无限循环。没有它，多数播放器只播一遍。 */
function writeNetscapeLoop(w) {
    w.byte(0x21);
    w.byte(0xff);
    w.byte(0x0b);
    w.ascii('NETSCAPE2.0');
    w.byte(0x03);
    w.byte(0x01);
    w.u16(0);
    w.byte(0);
}

/**
 * 一帧 = 图形控制扩展（GCE）+ 图像描述符 + LZW 数据。
 *
 * disposal 选 2（还原到背景）而不是 1（不处置）：有透明通道时，上一帧没擦掉的部分
 * 会从这一帧的透明区透出来，叠成鬼影；2 每帧先清成背景色，透明才是真透明。
 */
function writeFrame(w, frame, indices, cfg) {
    w.byte(0x21);
    w.byte(0xf9);
    w.byte(0x04);
    w.byte((cfg.transparent ? 2 : 1) << 2 | (cfg.transparent ? 1 : 0)); // 处置方式 | 透明标志
    w.u16(cfg.delay);
    w.byte(cfg.transparent ? cfg.transparentIndex : 0);
    w.byte(0);
    w.byte(0x2c);
    w.u16(0);
    w.u16(0);
    w.u16(frame.width);
    w.u16(frame.height);
    w.byte(0); // 无局部色表、不交织
    const minCodeSize = Math.max(MIN_CODE_SIZE, cfg.depth);
    w.byte(minCodeSize);
    w.chunk(lzwCompress(indices, minCodeSize));
}
