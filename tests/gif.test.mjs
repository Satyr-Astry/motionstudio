// GIF 编码器（app/core/gif.mjs）的字节级守卫。
//
// 这里不做「看起来像 GIF」的断言：每条用例要么读回结构字段，要么按规范自己解码一遍。
// 特别是 LZW —— 码宽切换比字典容量晚一步这个坑，只有把码流解回来才能钉住，所以测试里
// 带一个**按规范写的**解码器（增长条件 `dict.length === 1 << size`），与编码器的
// `nextCode > 1 << codeSize` 互为镜像；两边都在，切换点错一位就会立刻红。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { GIF_ALPHA_CUTOFF, GIF_DEFAULT_DELAY_MS, GIF_MAX_COLORS, encodeGif, quantizeFrames } from '../app/core/gif.mjs';

const SRC = readFileSync(new URL('../app/core/gif.mjs', import.meta.url), 'utf8');

// ---- 造帧 -------------------------------------------------------------------

/** 单色帧：所有像素同色。`alpha` 给 0 就是全透明帧。 */
function solidFrame(width, height, [r, g, b, a = 255]) {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        data[i * 4] = r;
        data[i * 4 + 1] = g;
        data[i * 4 + 2] = b;
        data[i * 4 + 3] = a;
    }
    return { data, width, height };
}

/** 确定性伪随机帧：用来把 LZW 字典撑过 256 项，逼出码宽增长。 */
function noisyFrame(width, height) {
    const data = new Uint8ClampedArray(width * height * 4);
    let seed = 12345;
    for (let i = 0; i < width * height; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        data[i * 4] = seed & 0xff;
        data[i * 4 + 1] = (seed >> 8) & 0xff;
        data[i * 4 + 2] = (seed >> 16) & 0xff;
        data[i * 4 + 3] = 255;
    }
    return { data, width, height };
}

// ---- 一个按规范实现的解码器（测试自用） ---------------------------------------

function lzwDecode(bytes, minCodeSize) {
    const clear = 1 << minCodeSize;
    const eoi = clear + 1;
    let size = minCodeSize + 1;
    let dict = [];
    const reset = () => {
        dict = [];
        for (let i = 0; i < clear; i++) dict.push([i]);
        dict.push(null); // clear 占位
        dict.push(null); // eoi 占位
        size = minCodeSize + 1;
    };
    reset();
    let bitPos = 0;
    let prev = null;
    const out = [];
    const read = () => {
        let code = 0;
        for (let i = 0; i < size; i++) {
            const byte = bytes[(bitPos + i) >> 3] || 0;
            code |= ((byte >> ((bitPos + i) & 7)) & 1) << i;
        }
        bitPos += size;
        return code;
    };
    for (let guard = 0; guard < 1e7; guard++) {
        const code = read();
        if (code === clear) {
            reset();
            prev = null;
            continue;
        }
        if (code === eoi) return Uint8Array.from(out);
        let entry;
        if (code < dict.length && dict[code]) entry = dict[code];
        else if (code === dict.length && prev) entry = prev.concat(prev[0]);
        else throw new Error('LZW 码非法：' + code + '（字典长度 ' + dict.length + '）');
        for (const v of entry) out.push(v);
        if (prev) {
            dict.push(prev.concat(entry[0]));
            if (dict.length === 1 << size && size < 12) size += 1;
        }
        prev = entry;
    }
    throw new Error('LZW 解码没有遇到 eoi');
}

/** 把整份 GIF 拆成结构字段，顺带把每帧 LZW 解回索引图。 */
function parseGif(bytes) {
    let p = 0;
    const header = String.fromCharCode(...bytes.slice(0, 6));
    p = 6;
    const width = bytes[p] | (bytes[p + 1] << 8);
    const height = bytes[p + 2] | (bytes[p + 3] << 8);
    p += 4;
    const packed = bytes[p++];
    const bg = bytes[p++];
    const aspect = bytes[p++];
    const hasGct = (packed & 0x80) !== 0;
    const sizeField = packed & 0x07;
    const gctSize = hasGct ? 1 << (sizeField + 1) : 0;
    let gct = null;
    if (hasGct) {
        gct = [...bytes.slice(p, p + gctSize * 3)];
        p += gctSize * 3;
    }
    const frames = [];
    let loop = null;
    while (p < bytes.length) {
        const b = bytes[p];
        if (b === 0x3b) {
            p += 1;
            break;
        }
        if (b === 0x21) {
            const label = bytes[p + 1];
            const len = bytes[p + 2];
            const body = [...bytes.slice(p + 3, p + 3 + len)];
            p += 3 + len;
            const subs = [];
            while (bytes[p] !== 0) {
                const n = bytes[p];
                subs.push([...bytes.slice(p + 1, p + 1 + n)]);
                p += 1 + n;
            }
            p += 1;
            if (label === 0xff) {
                const id = String.fromCharCode(...body);
                if (id === 'NETSCAPE2.0') {
                    loop = { id, count: subs.length ? subs[0][1] | (subs[0][2] << 8) : -1 };
                }
            } else if (label === 0xf9) {
                frames.push({
                    gce: {
                        disposal: (body[0] >> 2) & 0x07,
                        transparent: (body[0] & 0x01) === 1,
                        delay: body[1] | (body[2] << 8),
                        transparentIndex: body[3],
                    },
                });
            }
            continue;
        }
        if (b === 0x2c) {
            p += 1;
            const left = bytes[p] | (bytes[p + 1] << 8);
            const top = bytes[p + 2] | (bytes[p + 3] << 8);
            const fw = bytes[p + 4] | (bytes[p + 5] << 8);
            const fh = bytes[p + 6] | (bytes[p + 7] << 8);
            p += 8;
            const flags = bytes[p++];
            const minCodeSize = bytes[p++];
            const payload = [];
            while (bytes[p] !== 0) {
                const n = bytes[p];
                for (let i = 0; i < n; i++) payload.push(bytes[p + 1 + i]);
                p += 1 + n;
            }
            p += 1;
            const frame = frames[frames.length - 1];
            Object.assign(frame, {
                left,
                top,
                width: fw,
                height: fh,
                flags,
                minCodeSize,
                indices: lzwDecode(payload, minCodeSize),
            });
            continue;
        }
        throw new Error('无法识别的块：0x' + b.toString(16) + ' @' + p);
    }
    return { header, width, height, packed, bg, aspect, hasGct, sizeField, gctSize, gct, loop, frames, tail: bytes[bytes.length - 1] };
}

// ---- 用例 -------------------------------------------------------------------

test('文件头是 GIF89a 六个字节', () => {
    const gif = encodeGif([solidFrame(2, 2, [255, 0, 0])]);
    assert.deepEqual([...gif.slice(0, 6)], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    assert.equal(parseGif(gif).header, 'GIF89a');
});

test('2×2 纯色 2 帧：带 NETSCAPE2.0 无限循环，流以 0x3B 收尾', () => {
    const gif = encodeGif([solidFrame(2, 2, [255, 0, 0]), solidFrame(2, 2, [0, 0, 255])]);
    const at = gif.indexOf(0x21);
    assert.equal(gif[at], 0x21, '应用扩展引导字节');
    assert.equal(gif[at + 1], 0xff, '应用扩展标签');
    assert.equal(gif[at + 2], 0x0b, 'NETSCAPE2.0 的块长度是 11');
    assert.equal(String.fromCharCode(...gif.slice(at + 3, at + 14)), 'NETSCAPE2.0');
    const parsed = parseGif(gif);
    assert.equal(parsed.loop.count, 0, 'loop count 0 = 无限循环');
    assert.equal(parsed.tail, 0x3b);
    assert.equal(parsed.frames.length, 2);
});

test('逻辑屏幕宽高按小端读回来等于输入尺寸', () => {
    const gif = encodeGif([solidFrame(3, 5, [10, 20, 30])]);
    const parsed = parseGif(gif);
    assert.equal(parsed.width, 3);
    assert.equal(parsed.height, 5);
    const only = parsed.frames[0];
    assert.deepEqual([only.left, only.top, only.width, only.height], [0, 0, 3, 5]);
});

test('色表容量是 2 的幂、不超过 256，且与 LSD 的 size 字段一致', () => {
    const gif = encodeGif([solidFrame(4, 4, [1, 2, 3])]);
    const parsed = parseGif(gif);
    assert.ok(parsed.hasGct, '应写全局色表');
    const cap = parsed.gctSize;
    assert.ok(cap >= 1 && cap <= GIF_MAX_COLORS, '色表容量越界：' + cap);
    assert.equal(cap, 1 << Math.round(Math.log2(cap)), '容量必须是 2 的幂');
    assert.equal(parsed.gct.length, cap * 3);
    // size 字段 = 容量位数 - 1：容量 2^(n+1)
    assert.equal(cap, 1 << (parsed.sizeField + 1));
    // LZW 最小码宽 ≥ 2，且必须装得下所有索引
    assert.ok(parsed.frames[0].minCodeSize >= 2);
    assert.ok(parsed.frames[0].minCodeSize >= Math.round(Math.log2(cap)));
});

test('quantizeFrames：黑 / 白 / 红三帧各得一个不同索引，且调色板里有这三个颜色', () => {
    const frames = [solidFrame(2, 2, [0, 0, 0]), solidFrame(2, 2, [255, 255, 255]), solidFrame(2, 2, [255, 0, 0])];
    const q = quantizeFrames(frames);
    assert.equal(q.indexed.length, 3);
    assert.equal(q.hasTransparent, false);
    const idx = q.indexed.map((f) => f[0]);
    assert.equal(new Set(idx).size, 3, '三个纯色应落在三个不同索引上: ' + idx.join(','));
    const triples = [];
    for (let i = 0; i < q.palette.length; i += 3) triples.push(q.palette.slice(i, i + 3).join(','));
    for (const want of ['0,0,0', '255,255,255', '255,0,0']) {
        assert.ok(triples.includes(want), '调色板里找不到 ' + want + '，实际：' + triples.join(' | '));
    }
    assert.ok(q.palette.length <= GIF_MAX_COLORS * 3);
});

test('全透明帧能编码，且 GCE 标了透明索引（alpha 门槛 ' + GIF_ALPHA_CUTOFF + '）', () => {
    const gif = encodeGif([solidFrame(2, 2, [0, 0, 0, 0])]);
    const parsed = parseGif(gif);
    const f = parsed.frames[0];
    assert.equal(f.gce.transparent, true, '全透明帧必须置透明标志');
    assert.equal(f.gce.transparentIndex, 0, '透明索引固定保留在 0');
    assert.equal(f.gce.disposal, 2, '有透明时用「还原到背景」，否则会叠出鬼影');
    assert.equal(parsed.bg, 0, '背景色索引指向透明格');
    assert.ok(f.indices.every((v) => v === 0), '全透明帧的每个索引都应是透明索引');
});

test('1×1 单帧也能编码（最小尺寸边界）', () => {
    const gif = encodeGif([solidFrame(1, 1, [9, 9, 9])]);
    const parsed = parseGif(gif);
    assert.equal(parsed.width, 1);
    assert.equal(parsed.height, 1);
    assert.equal(parsed.frames[0].width, 1);
    assert.equal(parsed.frames[0].height, 1);
    assert.equal(parsed.frames[0].indices.length, 1);
});

test('delayMs 换算成 1/100 秒：40ms → 4，10ms → 兜到 2', () => {
    const gif = encodeGif([solidFrame(1, 1, [1, 1, 1]), solidFrame(1, 1, [2, 2, 2])], { delayMs: [40, 10] });
    const parsed = parseGif(gif);
    assert.equal(parsed.frames[0].gce.delay, 4);
    assert.equal(parsed.frames[1].gce.delay, 2, '小于 2 个 tick 会被播放器当 100ms，必须兜到 2');
    // 单值广播 + 缺省值
    const single = parseGif(encodeGif([solidFrame(1, 1, [1, 1, 1])], { delayMs: 250 }));
    assert.equal(single.frames[0].gce.delay, 25);
    const fallback = parseGif(encodeGif([solidFrame(1, 1, [1, 1, 1])]));
    assert.equal(fallback.frames[0].gce.delay, Math.round(GIF_DEFAULT_DELAY_MS / 10));
});

test('不透明帧的 GCE 不置透明位，处置方式用 1（不处置）', () => {
    const parsed = parseGif(encodeGif([solidFrame(2, 2, [7, 8, 9])]));
    assert.equal(parsed.frames[0].gce.transparent, false);
    assert.equal(parsed.frames[0].gce.disposal, 1);
});

test('loop:false 不写 NETSCAPE2.0（单次播放）', () => {
    const parsed = parseGif(encodeGif([solidFrame(1, 1, [1, 2, 3])], { loop: false }));
    assert.equal(parsed.loop, null);
});

test('LZW 往返：解码回来的索引图与 quantizeFrames 逐字节一致（含码宽切换）', () => {
    const frame = noisyFrame(64, 64);
    const q = quantizeFrames([frame]);
    const parsed = parseGif(encodeGif([frame]));
    assert.equal(parsed.frames[0].indices.length, 64 * 64);
    assert.deepEqual([...parsed.frames[0].indices], [...q.indexed[0]]);
    assert.ok(parsed.frames[0].minCodeSize >= 8, '64×64 噪声图会把字典撑大，最小码宽应不小');
});

test('帧尺寸不一致时各帧按自己的宽高贴左上角（逻辑屏幕仍取第一帧）', () => {
    const frames = [solidFrame(4, 4, [0, 0, 0]), solidFrame(2, 2, [255, 255, 255])];
    const parsed = parseGif(encodeGif(frames));
    assert.deepEqual([parsed.width, parsed.height], [4, 4]);
    assert.deepEqual([parsed.frames[1].width, parsed.frames[1].height], [2, 2]);
    assert.deepEqual([parsed.frames[1].left, parsed.frames[1].top], [0, 0]);
    assert.equal(parsed.frames[1].indices.length, 4);
});

test('dither 默认关；打开后仍然是合法 GIF，确定性且与关闭时不同', () => {
    const frame = noisyFrame(16, 16);
    const plain = parseGif(encodeGif([frame]));
    const dithered = parseGif(encodeGif([frame], { dither: true }));
    assert.equal(dithered.frames[0].indices.length, 16 * 16);
    // 同一输入两次编码必须逐字节相同（抖动是确定性的，不引入随机数）
    assert.deepEqual([...encodeGif([frame], { dither: true })], [...encodeGif([frame], { dither: true })]);
    assert.notDeepEqual([...plain.frames[0].indices], [...dithered.frames[0].indices], '抖动应改变索引分布');
});

test('空帧数组抛 RangeError（不返回 null：null 会一路沉默到写文件那一步）', () => {
    // 选「抛」而不是「返回 null」：调用链是 encodeGif → ipc.saveBinaryChecked，
    // 返回 null 会被当成一段合法字节写下去，错误点离现场太远，排查成本远高于抛错。
    assert.throws(() => encodeGif([]), RangeError);
    assert.throws(() => quantizeFrames([]), RangeError);
    assert.throws(() => encodeGif([{ data: new Uint8ClampedArray(3), width: 1, height: 1 }]), RangeError);
});

test('源码守卫：不 import 任何模块、不碰 DOM', () => {
    assert.ok(!/^\s*import\s/m.test(SRC), 'gif.mjs 必须是零依赖的纯 core 模块');
    for (const bad of ['document.', 'window.', 'canvas', 'requestAnimationFrame', 'OffscreenCanvas']) {
        assert.ok(!SRC.includes(bad), 'gif.mjs 里不该出现 ' + bad);
    }
    assert.ok(!SRC.includes('require('), 'gif.mjs 里不该出现 require(');
});
