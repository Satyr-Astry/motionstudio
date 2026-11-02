// APNG 编码器的验收测试：不解码成像素去比画面，而是**按 PNG/APNG 规范逐块回读**。
//
// 测试自己带一个极简的分块解析器（`readChunks`），CRC 用 `node:zlib` 的 `crc32` 独立
// 核对（不复用被测实现），像素数据用 `node:zlib` 的 `inflateSync` 解压 —— 它能顺带
// 验掉 adler32：我们算错一位，`inflateSync` 立刻抛「invalid adler32」。
// 所以这组测试真正验证的是「别人（标准库）能读懂这份文件」，而不是「我的写法和我自己的
// 写法一致」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync, crc32 as zlibCrc32 } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { encodeApng, canEncodeApng, APNG_DEFAULT_DELAY_MS, APNG_LOOP_FOREVER } from '../app/core/apng.mjs';

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// ── 测试用工具 ─────────────────────────────────────────────

/** 把字节流拆成块列表：{ type, data, crc, raw }（raw = 类型到数据末尾，喂给 CRC 用）。 */
function readChunks(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const out = [];
    let at = 8;
    while (at + 12 <= bytes.length) {
        const length = view.getUint32(at);
        const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
        const data = bytes.subarray(at + 8, at + 8 + length);
        out.push({ type, data, crc: view.getUint32(at + 8 + length), raw: bytes.subarray(at + 4, at + 8 + length) });
        at += 12 + length;
        if (type === 'IEND') break;
    }
    return out;
}

/** 取某个类型的全部块。 */
function chunksOfType(chunks, type) {
    return chunks.filter((c) => c.type === type);
}

/** 把块的数据段当大端整数读。 */
function u32At(data, at) {
    return new DataView(data.buffer, data.byteOffset, data.length).getUint32(at);
}

function u16At(data, at) {
    return new DataView(data.buffer, data.byteOffset, data.length).getUint16(at);
}

/** 造一帧纯色 RGBA。 */
function solidFrame(width, height, [r, g, b, a]) {
    const data = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
        data[i * 4] = r;
        data[i * 4 + 1] = g;
        data[i * 4 + 2] = b;
        data[i * 4 + 3] = a;
    }
    return { width, height, data };
}

/** 解压一帧的数据块，返回去掉了每行过滤字节的像素（同时断言过滤字节全是 0）。 */
function inflatePixels(zlibData, width, height) {
    const raw = inflateSync(Buffer.from(zlibData));
    const stride = width * 4;
    assert.equal(raw.length, height * (stride + 1), '解压后的扫描行总长不对');
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        const at = y * (stride + 1);
        assert.equal(raw[at], 0, `第 ${y} 行的 filter 字节应为 0（None）`);
        out.set(raw.subarray(at + 1, at + 1 + stride), y * stride);
    }
    return out;
}

const RED = solidFrame(2, 2, [255, 0, 0, 255]);
const BLUE = solidFrame(2, 2, [0, 0, 255, 255]);

// ── 结构 ───────────────────────────────────────────────────

test('文件签名是 PNG 魔数，第一块是 IHDR', async () => {
    const bytes = await encodeApng([RED]);
    assert.deepEqual([...bytes.subarray(0, 8)], SIGNATURE, 'PNG 签名不对');
    const chunks = readChunks(bytes);
    assert.equal(chunks[0].type, 'IHDR', '第一块必须是 IHDR');
    assert.equal(chunks.at(-1).type, 'IEND', '最后一块必须是 IEND');
});

test('IHDR 回读：宽高、位深 8、颜色类型 6（RGBA）、无隔行', async () => {
    const bytes = await encodeApng([solidFrame(7, 3, [1, 2, 3, 4])]);
    const [ihdr] = chunksOfType(readChunks(bytes), 'IHDR');
    assert.equal(ihdr.data.length, 13, 'IHDR 数据段必须是 13 字节');
    assert.equal(u32At(ihdr.data, 0), 7, '宽要按大端写');
    assert.equal(u32At(ihdr.data, 4), 3, '高要按大端写');
    assert.equal(ihdr.data[8], 8, '位深必须是 8');
    assert.equal(ihdr.data[9], 6, '颜色类型必须是 6（真彩+alpha）');
    assert.equal(ihdr.data[10], 0, '压缩方法必须是 0');
    assert.equal(ihdr.data[11], 0, '过滤方法必须是 0');
    assert.equal(ihdr.data[12], 0, '隔行必须关掉');
});

test('每个块的 CRC32 都与 node:zlib 独立算出的一致', async () => {
    const bytes = await encodeApng([RED, BLUE]);
    const chunks = readChunks(bytes);
    // 两帧一共 7 块：IHDR → acTL → fcTL → IDAT → fcTL → fdAT → IEND
    assert.equal(chunks.length, 7, '块数不对，解析器可能没读完或者多读了');
    for (const c of chunks) {
        assert.equal(c.crc, zlibCrc32(Buffer.from(c.raw)) >>> 0, `${c.type} 块的 CRC 不对`);
    }
});

test('acTL 记录帧数与播放次数，缺省是无限循环', async () => {
    const bytes = await encodeApng([RED, BLUE]);
    const [actl] = chunksOfType(readChunks(bytes), 'acTL');
    assert.ok(actl, '缺 acTL 就不是 APNG 了');
    assert.equal(u32At(actl.data, 0), 2, 'num_frames 应该是 2');
    assert.equal(u32At(actl.data, 4), APNG_LOOP_FOREVER, '缺省 num_plays 应该是 0（无限）');
    // acTL 必须排在第一个 IDAT 前面，否则播放器不认
    const chunks = readChunks(bytes);
    assert.ok(
        chunks.findIndex((c) => c.type === 'acTL') < chunks.findIndex((c) => c.type === 'IDAT'),
        'acTL 必须排在 IDAT 之前',
    );
});

test('loop: 3 时 num_plays 跟着变', async () => {
    const bytes = await encodeApng([RED, BLUE], { loop: 3 });
    const [actl] = chunksOfType(readChunks(bytes), 'acTL');
    assert.equal(u32At(actl.data, 4), 3);
});

test('fcTL 与 fdAT 共用一个 sequence 计数器，从 0 起严格连续', async () => {
    const bytes = await encodeApng([RED, BLUE, RED]);
    const chunks = readChunks(bytes);
    const seen = [];
    for (const c of chunks) {
        if (c.type === 'fcTL' || c.type === 'fdAT') seen.push(u32At(c.data, 0));
    }
    // 3 帧：fcTL#0, fcTL#1, fdAT#1, fcTL#2, fdAT#2
    assert.deepEqual(seen, [0, 1, 2, 3, 4], 'fcTL/fdAT 的 sequence 必须跨两类块连续递增');
});

test('第一帧的像素在 IDAT 里，后续帧在 fdAT 里', async () => {
    const bytes = await encodeApng([RED, BLUE]);
    const chunks = readChunks(bytes);
    const types = chunks.map((c) => c.type);
    assert.equal(types.filter((t) => t === 'IDAT').length, 1, '只有第一帧该用 IDAT');
    assert.equal(types.filter((t) => t === 'fdAT').length, 1, '第二帧该用 fdAT');

    // 块序：IHDR → acTL → fcTL → IDAT → fcTL → fdAT → IEND
    assert.deepEqual(types, ['IHDR', 'acTL', 'fcTL', 'IDAT', 'fcTL', 'fdAT', 'IEND']);

    const idat = chunksOfType(chunks, 'IDAT')[0];
    assert.deepEqual([...inflatePixels(idat.data, 2, 2)], [...RED.data], 'IDAT 里应该是第一帧（红）');

    // fdAT 的数据比 IDAT 多 4 字节 sequence，且它等于这一帧的 fcTL sequence + 1
    const fdat = chunksOfType(chunks, 'fdAT')[0];
    const secondFctl = chunksOfType(chunks, 'fcTL')[1];
    assert.equal(u32At(fdat.data, 0), u32At(secondFctl.data, 0) + 1, 'fdAT 的 sequence 要紧跟在这一帧的 fcTL 之后');
    assert.deepEqual([...inflatePixels(fdat.data.subarray(4), 2, 2)], [...BLUE.data], 'fdAT 里应该是第二帧（蓝）');
});

test('延时写法是「毫秒/1000」，40ms 回读成 num=40 den=1000', async () => {
    const bytes = await encodeApng([RED], { delayMs: 40 });
    const [fctl] = chunksOfType(readChunks(bytes), 'fcTL');
    assert.equal(u16At(fctl.data, 20), 40, 'delay_num 应该是毫秒数');
    assert.equal(u16At(fctl.data, 22), 1000, 'delay_den 应该是 1000');
});

test('delayMs 给数组时逐帧生效，缺省值与 0 都被兜到 ≥1', async () => {
    const bytes = await encodeApng([RED, BLUE, RED], { delayMs: [40, 250, 0] });
    const nums = chunksOfType(readChunks(bytes), 'fcTL').map((c) => u16At(c.data, 20));
    assert.deepEqual(nums, [40, 250, 1], '0 要钳到 1：全 0 延时的动画在部分播放器里会被加速');
    // 不给 delayMs 时用缺省值
    const dflt = await encodeApng([RED]);
    assert.equal(u16At(chunksOfType(readChunks(dflt), 'fcTL')[0].data, 20), APNG_DEFAULT_DELAY_MS);
});

test('一帧纯红：解压回读的像素与输入逐字节相等', async () => {
    const bytes = await encodeApng([RED]);
    const [idat] = chunksOfType(readChunks(bytes), 'IDAT');
    const pixels = inflatePixels(idat.data, 2, 2);
    assert.deepEqual([...pixels], [...RED.data]);
    assert.deepEqual([...pixels.subarray(0, 4)], [255, 0, 0, 255], '第一个像素必须正好是不透明纯红');
});

test('全透明帧原样保留（alpha 全 0，不做任何预乘）', async () => {
    const clear = solidFrame(3, 2, [0, 0, 0, 0]);
    const bytes = await encodeApng([clear]);
    const [idat] = chunksOfType(readChunks(bytes), 'IDAT');
    assert.deepEqual([...inflatePixels(idat.data, 3, 2)], [...clear.data]);
});

test('1×1 这种边界也能编', async () => {
    const one = solidFrame(1, 1, [9, 8, 7, 6]);
    const bytes = await encodeApng([one, one]);
    const chunks = readChunks(bytes);
    const [ihdr] = chunksOfType(chunks, 'IHDR');
    assert.equal(u32At(ihdr.data, 0), 1);
    assert.equal(u32At(ihdr.data, 4), 1);
    assert.deepEqual([...inflatePixels(chunksOfType(chunks, 'IDAT')[0].data, 1, 1)], [9, 8, 7, 6]);
});

test('dispose_op 用 1（BACKGROUND）、blend_op 用 0（SOURCE）', async () => {
    const bytes = await encodeApng([RED, BLUE]);
    for (const fctl of chunksOfType(readChunks(bytes), 'fcTL')) {
        assert.equal(fctl.data[24], 1, 'dispose_op 必须是 1，否则上一帧会留在画布上');
        assert.equal(fctl.data[25], 0, 'blend_op 必须是 0（SOURCE），1（OVER）会让半透明帧叠影');
    }
});

test('坏输入抛 RangeError：空数组、长度对不上、帧尺寸不一致、尺寸为 0', async () => {
    await assert.rejects(() => encodeApng([]), RangeError);
    await assert.rejects(() => encodeApng([{ width: 2, height: 2, data: new Uint8Array(4) }]), RangeError);
    await assert.rejects(() => encodeApng([RED, solidFrame(3, 2, [0, 0, 0, 255])]), RangeError);
    await assert.rejects(() => encodeApng([{ width: 0, height: 2, data: new Uint8Array(0) }]), RangeError);
    // 帧不是对象 / data 不是字节数组 → TypeError（和 RangeError 分开，调用方能区分「数据坏」与「用法错」）
    await assert.rejects(() => encodeApng([null]), TypeError);
    await assert.rejects(() => encodeApng([{ width: 1, height: 1, data: [1, 2, 3, 4] }]), TypeError);
});

test('canEncodeApng 在当前 node 环境为 true，且 encodeApng 返回 Uint8Array', async () => {
    assert.equal(canEncodeApng(), true, 'node 24 自带 CompressionStream(deflate-raw)，这里应该为 true');
    const bytes = await encodeApng([RED]);
    assert.ok(bytes instanceof Uint8Array, '返回值必须是 Uint8Array');
    assert.ok(bytes.length > 8 + 25, '长度至少得装得下签名与 IHDR');
});

test('环境缺 CompressionStream 时：canEncodeApng 为 false，encodeApng 抛带解释的 Error', async () => {
    const saved = globalThis.CompressionStream;
    globalThis.CompressionStream = undefined;
    try {
        assert.equal(canEncodeApng(), false, '没有 CompressionStream 时必须是 false');
        await assert.rejects(() => encodeApng([RED]), (err) => {
            assert.ok(err instanceof Error);
            assert.match(err.message, /CompressionStream/, '提示里要点名缺的是什么');
            return true;
        });
    } finally {
        globalThis.CompressionStream = saved;
    }
    assert.equal(canEncodeApng(), true, '恢复后要能重新为 true');
});

test('源码守卫：不 import 任何模块、不碰 DOM、不用 require', () => {
    const src = readFileSync(new URL('../app/core/apng.mjs', import.meta.url), 'utf8');
    assert.ok(!/^\s*import\s/m.test(src), 'apng.mjs 必须零依赖，不许 import 任何模块');
    assert.ok(!/\brequire\s*\(/.test(src), 'apng.mjs 不许用 require');
    assert.ok(!/\bdocument\b/.test(src), 'apng.mjs 是纯 core，不许摸 document');
    assert.ok(!/\bwindow\b/.test(src), 'apng.mjs 是纯 core，不许摸 window');
    assert.ok(!/OffscreenCanvas|createImageBitmap|requestAnimationFrame/.test(src), '不许依赖画布 API');
});
