// app/core/psd.mjs 的契约测试
//
// 所有样本都在本文件里用 Buffer 手写构造：不依赖任何外部 .psd 图片，也不用第三方库。
// 覆盖 raw / RLE / zip / zip+预测 四种通道压缩，PSD 与 PSB 两种长度字段，
// 'lsct' 分组、'luni' unicode 名、负数矩形与非法输入。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, deflateSync } from 'node:zlib';

import { PSD_FORMAT, parsePsd } from '../app/core/psd.mjs';

// ── 字节小工具 ────────────────────────────────────────────────────────────────

const u8 = (v) => Buffer.from([v & 0xff]);

function u16(v) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(v & 0xffff);
    return b;
}

function i16(v) {
    const b = Buffer.alloc(2);
    b.writeInt16BE(v);
    return b;
}

function u32(v) {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(v >>> 0);
    return b;
}

function i32(v) {
    const b = Buffer.alloc(4);
    b.writeInt32BE(v);
    return b;
}

function u64(v) {
    const b = Buffer.alloc(8);
    b.writeUInt32BE(Math.floor(v / 4294967296), 0);
    b.writeUInt32BE(v >>> 0, 4);
    return b;
}

/** PSD 用 4 字节长度字段，PSB 用 8 字节。 */
function lenField(n, psb) {
    return psb ? u64(n) : u32(n);
}

/** 图层数：PSD 是 i16，PSB 是 i64（两者对正数同一套字节序）。 */
function countField(n, psb) {
    return psb ? u64(n) : u16(n);
}

/** pascal 名：1 字节长度 + 内容，整体补齐到 4 的倍数（长度字节也计入）。 */
function pascal(name) {
    const body = Buffer.from(name, 'latin1');
    const used = 1 + body.length;
    const pad = (4 - (used % 4)) % 4;
    return Buffer.concat([u8(body.length), body, Buffer.alloc(pad)]);
}

/** 'luni'：4 字节 UTF-16 码元数 + UTF-16BE 字符。 */
function unicodeName(name) {
    const body = Buffer.alloc(name.length * 2);
    for (let i = 0; i < name.length; i += 1) body.writeUInt16BE(name.charCodeAt(i), i * 2);
    return Buffer.concat([u32(name.length), body]);
}

/** 附加块：'8BIM' + key + 长度（PSD 4 / PSB 8）+ 数据。 */
function tagged(key, data, psb) {
    return Buffer.concat([Buffer.from('8BIM', 'latin1'), Buffer.from(key, 'latin1'), lenField(data.length, psb), data]);
}

// ── 通道数据编码 ──────────────────────────────────────────────────────────────

/** 简化 PackBits：整行按 ≤128 字节的字面量块切片，合法但未必最短。 */
function packBitsRow(row) {
    const parts = [];
    for (let i = 0; i < row.length; i += 128) {
        const chunk = row.subarray(i, Math.min(i + 128, row.length));
        parts.push(u8(chunk.length - 1), Buffer.from(chunk));
    }
    return Buffer.concat(parts);
}

function channelData(plane, width, height, common) {
    const compression = common.compression ?? 0;
    if (compression === 0) return Buffer.concat([u16(0), Buffer.from(plane)]);
    if (compression === 1) {
        const table = [];
        const rows = [];
        for (let y = 0; y < height; y += 1) {
            const packed = packBitsRow(plane.subarray(y * width, (y + 1) * width));
            table.push(common.psb ? u32(packed.length) : u16(packed.length));
            rows.push(packed);
        }
        return Buffer.concat([u16(1), ...table, ...rows]);
    }
    const body = Buffer.from(plane);
    if (common.prediction) {
        // 压缩方式 3：每行做水平差分（第一个像素保留原值）
        for (let y = 0; y < height; y += 1) {
            for (let x = width - 1; x >= 1; x -= 1) {
                body[y * width + x] = (body[y * width + x] - body[y * width + x - 1]) & 0xff;
            }
        }
    }
    const deflated = common.zlib ? deflateSync(body) : deflateRawSync(body);
    return Buffer.concat([u16(compression), deflated]);
}

// ── 图层与整份文档 ────────────────────────────────────────────────────────────

function buildLayer(layer, common) {
    const left = layer.left ?? 0;
    const top = layer.top ?? 0;
    const width = layer.width ?? 0;
    const height = layer.height ?? 0;
    const channels = (layer.planes || []).map((plane) => ({
        id: plane.id,
        data: channelData(plane.data, width, height, common),
    }));

    const extra = [u32(0), u32(0), pascal(layer.name)];
    // pascal 名是 latin1（MacRoman）字节，非 latin1 名字照真实写盘习惯再补一个 'luni'。
    const unicode = layer.unicodeName !== undefined ? layer.unicodeName : /[^\x00-\xff]/.test(layer.name || '') ? layer.name : null;
    if (unicode !== null) extra.push(tagged('luni', unicodeName(unicode), common.psb));
    if (layer.divider !== undefined) extra.push(tagged('lsct', u32(layer.divider), common.psb));
    for (const block of layer.blocks || []) extra.push(tagged(block.key, block.data, common.psb));
    const extraData = Buffer.concat(extra);

    const record = Buffer.concat([
        i32(top),
        i32(left),
        i32(top + height),
        i32(left + width),
        u16(channels.length),
        ...channels.map((ch) => Buffer.concat([i16(ch.id), lenField(ch.data.length, common.psb)])),
        Buffer.from('8BIM', 'latin1'),
        Buffer.from(layer.blend ?? 'norm', 'latin1'),
        u8(Math.round((layer.opacity ?? 1) * 255)),
        u8(0),
        u8(layer.flags ?? 0),
        u8(0),
        u32(extraData.length),
        extraData,
    ]);

    return { record, data: Buffer.concat(channels.map((ch) => ch.data)) };
}

function buildPsd(spec) {
    const psb = spec.version === 2;
    const common = { psb, compression: spec.compression ?? 0, prediction: !!spec.prediction, zlib: !!spec.zlib };
    const built = (spec.layers || []).map((layer) => buildLayer(layer, common));

    const layerInfo = Buffer.concat([
        countField(built.length, psb),
        ...built.map((b) => b.record),
        ...built.map((b) => b.data),
    ]);
    const layerMask = Buffer.concat([
        lenField(layerInfo.length, psb),
        layerInfo,
        u32(0), // 全局蒙版数据长度
    ]);

    const header = Buffer.concat([
        Buffer.from('8BPS', 'latin1'),
        u16(spec.version ?? 1),
        Buffer.alloc(6),
        u16(spec.channels ?? 4),
        u32(spec.height),
        u32(spec.width),
        u16(spec.depth ?? 8),
        u16(spec.colorMode ?? 3),
    ]);

    return Buffer.concat([
        header,
        u32(0), // Color Mode Data
        u32(0), // Image Resources
        lenField(layerMask.length, psb),
        layerMask,
        u16(0), // 合并图像：压缩方式 0，后面没有数据（图层才是导入来源）
    ]);
}

// ── 像素样本 ──────────────────────────────────────────────────────────────────

// 2×2：红 / 绿 / 蓝 / 半透明灰
const PIXELS = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 128, 128, 128, 128];
// 2×2：另一组不透明像素（叠层用）
const ALT = [10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255];
// 2×2 灰度：0 / 128 / 255 / 10，alpha 取每像素第 4 分量
const GRAY = [0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 128, 10, 10, 10, 0];

/** 把扁平 RGBA 拆成通道平面；gray=true 时只出 gray + alpha。 */
function planesOf(pixels, opts = {}) {
    const count = pixels.length / 4;
    const plane = (offset) => {
        const data = new Uint8Array(count);
        for (let i = 0; i < count; i += 1) data[i] = pixels[i * 4 + offset];
        return data;
    };
    const out = [{ id: 0, data: plane(0) }];
    if (!opts.gray) out.push({ id: 1, data: plane(1) }, { id: 2, data: plane(2) });
    if (opts.alpha !== false) out.push({ id: -1, data: plane(3) });
    return out;
}

function baseSample(spec = {}) {
    return buildPsd({
        width: 2,
        height: 2,
        layers: [{ name: '底层', width: 2, height: 2, left: 3, top: 4, planes: planesOf(PIXELS) }],
        ...spec,
    });
}

const rgba = (layer) => Array.from(layer.rgba);
const CHINESE = /[\u4e00-\u9fa5]/;

// ── 用例 ──────────────────────────────────────────────────────────────────────

test('PSD_FORMAT 声明扩展名与中文名', () => {
    assert.equal(PSD_FORMAT.name, 'Photoshop 文档');
    assert.deepEqual(PSD_FORMAT.ext, ['.psd', '.psb']);
});

test('8 位 RGB + raw 通道：头部、图层名、可见性、opacity、像素', async () => {
    const doc = await parsePsd(baseSample({ compression: 0 }));
    assert.equal(doc.width, 2);
    assert.equal(doc.height, 2);
    assert.equal(doc.depth, 8);
    assert.equal(doc.colorMode, 3);
    assert.equal(doc.layers.length, 1);

    const layer = doc.layers[0];
    assert.equal(layer.name, '底层');
    assert.equal(layer.visible, true);
    assert.equal(layer.opacity, 1);
    assert.equal(layer.blendMode, 'normal');
    assert.deepEqual([layer.left, layer.top, layer.width, layer.height], [3, 4, 2, 2]);
    assert.equal(layer.isGroup, false);
    assert.equal(layer.parentName, null);
    assert.ok(layer.rgba instanceof Uint8ClampedArray);
    assert.equal(layer.rgba.length, 16);
    assert.deepEqual(rgba(layer), PIXELS);
});

test('RLE（PackBits）与 raw 解出完全相同的像素', async () => {
    const raw = await parsePsd(baseSample({ compression: 0 }));
    const rle = await parsePsd(baseSample({ compression: 1 }));
    assert.deepEqual(rgba(rle.layers[0]), PIXELS);
    assert.deepEqual(rgba(rle.layers[0]), rgba(raw.layers[0]));
});

test('两个图层：自底向上排序，第二个图层 hidden 标记生效', async () => {
    const doc = await parsePsd(
        buildPsd({
            width: 2,
            height: 2,
            compression: 1,
            layers: [
                { name: '底', width: 2, height: 2, blend: 'norm', planes: planesOf(PIXELS) },
                { name: '顶', width: 2, height: 2, flags: 0x02, opacity: 0.5, blend: 'mul ', planes: planesOf(ALT) },
            ],
        }),
    );
    assert.deepEqual(doc.layers.map((l) => l.name), ['底', '顶']);
    assert.equal(doc.layers[0].visible, true);
    assert.equal(doc.layers[1].visible, false);
    assert.equal(doc.layers[0].blendMode, 'normal');
    assert.equal(doc.layers[1].blendMode, 'multiply');
    assert.ok(Math.abs(doc.layers[1].opacity - 0.5) < 0.005);
    assert.deepEqual(rgba(doc.layers[1]), ALT);
});

test("'lsct' 类型 1/2 的组开始/结束不产出图层，真实图层带 parentName", async () => {
    const doc = await parsePsd(
        buildPsd({
            width: 2,
            height: 2,
            compression: 0,
            layers: [
                { name: '组', divider: 1 },
                { name: '组内', width: 2, height: 2, planes: planesOf(PIXELS) },
                { name: '组', divider: 2 },
                { name: '组外', width: 2, height: 2, planes: planesOf(ALT) },
            ],
        }),
    );
    assert.deepEqual(doc.layers.map((l) => l.name), ['组内', '组外']);
    assert.equal(doc.layers[0].parentName, '组');
    assert.equal(doc.layers[1].parentName, null);
    assert.ok(!doc.layers.some((l) => l.name === '组'));
});

test('嵌套组：parentName 取直接父组，真实 PSD 的 lsct 类型 3 也能收尾', async () => {
    const nested = await parsePsd(
        buildPsd({
            width: 2,
            height: 2,
            layers: [
                { name: '外组', divider: 1 },
                { name: '外组内层', width: 2, height: 2, planes: planesOf(PIXELS) },
                { name: '内组', divider: 1 },
                { name: '内组内层', width: 2, height: 2, planes: planesOf(ALT) },
                { name: '内组', divider: 2 },
                { name: '外组', divider: 2 },
            ],
        }),
    );
    assert.deepEqual(nested.layers.map((l) => l.name), ['外组内层', '内组内层']);
    assert.deepEqual(nested.layers.map((l) => l.parentName), ['外组', '内组']);

    const bounded = await parsePsd(
        buildPsd({
            width: 2,
            height: 2,
            layers: [
                { name: '组A', divider: 1 },
                { name: '组A内层', width: 2, height: 2, planes: planesOf(PIXELS) },
                { name: '</Layer group>', divider: 3 },
                { name: '组A外', width: 2, height: 2, planes: planesOf(ALT) },
            ],
        }),
    );
    assert.deepEqual(bounded.layers.map((l) => l.name), ['组A内层', '组A外']);
    assert.deepEqual(bounded.layers.map((l) => l.parentName), ['组A', null]);
});

test('非法输入：签名错 / 16 位 / CMYK / 截断都抛中文错误', async () => {
    const badSignature = Buffer.from(baseSample());
    badSignature[0] = 0x39; // '9BPS'
    await assert.rejects(() => parsePsd(badSignature), (err) => {
        assert.equal(err instanceof Error, true);
        assert.match(err.message, CHINESE);
        assert.match(err.message, /签名/);
        assert.match(err.message, /9BPS/);
        return true;
    });

    await assert.rejects(() => parsePsd(baseSample({ depth: 16 })), (err) => {
        assert.match(err.message, CHINESE);
        assert.match(err.message, /16/);
        return true;
    });

    await assert.rejects(() => parsePsd(baseSample({ colorMode: 4 })), (err) => {
        assert.match(err.message, CHINESE);
        assert.match(err.message, /色彩模式/);
        return true;
    });

    await assert.rejects(() => parsePsd(baseSample().subarray(0, 30)), (err) => {
        assert.match(err.message, CHINESE);
        assert.match(err.message, /越界/);
        return true;
    });
});

test('zip（压缩方式 2）与 zip+预测（3）解出同样的像素', async () => {
    const zipped = await parsePsd(baseSample({ compression: 2 }));
    assert.deepEqual(rgba(zipped.layers[0]), PIXELS);

    const predicted = await parsePsd(baseSample({ compression: 3, prediction: true }));
    assert.deepEqual(rgba(predicted.layers[0]), PIXELS);

    const zlibbed = await parsePsd(baseSample({ compression: 2, zlib: true }));
    assert.deepEqual(rgba(zlibbed.layers[0]), PIXELS);
});

test('PSB：8 字节长度字段、4 字节 RLE 行表、8 字节附加块长度', async () => {
    const doc = await parsePsd(
        buildPsd({
            version: 2,
            width: 2,
            height: 2,
            compression: 1,
            layers: [
                { name: 'psb 组', divider: 1 },
                { name: 'PSB 层', width: 2, height: 2, unicodeName: 'PSB 图层', planes: planesOf(PIXELS) },
                { name: '</Layer group>', divider: 3 },
            ],
        }),
    );
    assert.equal(doc.width, 2);
    assert.equal(doc.layers.length, 1);
    assert.equal(doc.layers[0].name, 'PSB 图层');
    assert.equal(doc.layers[0].parentName, 'psb 组');
    assert.deepEqual(rgba(doc.layers[0]), PIXELS);
});

test("'luni' 名字优先于 pascal 名（含代理对），负数矩形原样保留", async () => {
    const doc = await parsePsd(
        buildPsd({
            width: 2,
            height: 2,
            layers: [{ name: 'ascii', unicodeName: '中文层😀', width: 2, height: 2, left: -5, top: -7, planes: planesOf(PIXELS) }],
        }),
    );
    const layer = doc.layers[0];
    assert.equal(layer.name, '中文层😀');
    assert.deepEqual([layer.left, layer.top, layer.width, layer.height], [-5, -7, 2, 2]);
});

test('灰度模式：RGB 三通道取同一灰度值，缺少 alpha 时按 255', async () => {
    const doc = await parsePsd(
        buildPsd({
            width: 2,
            height: 2,
            colorMode: 1,
            channels: 2,
            layers: [{ name: '灰度层', width: 2, height: 2, planes: planesOf(GRAY, { gray: true }) }],
        }),
    );
    assert.equal(doc.colorMode, 1);
    assert.deepEqual(rgba(doc.layers[0]), [
        0, 0, 0, 255,
        128, 128, 128, 255,
        255, 255, 255, 128,
        10, 10, 10, 0,
    ]);

    const noAlpha = await parsePsd(
        buildPsd({
            width: 2,
            height: 2,
            colorMode: 1,
            channels: 1,
            layers: [{ name: '无 alpha', width: 2, height: 2, planes: planesOf(GRAY, { gray: true, alpha: false }) }],
        }),
    );
    assert.deepEqual(rgba(noAlpha.layers[0]).filter((_, i) => i % 4 === 3), [255, 255, 255, 255]);
});

test('空图层、空文档、不认识的附加块都不会中断解析', async () => {
    const doc = await parsePsd(
        buildPsd({
            width: 4,
            height: 4,
            layers: [
                { name: '空层', blocks: [{ key: 'zzzz', data: Buffer.from([1, 2, 3, 4]) }] },
                { name: '有像素', width: 2, height: 2, planes: planesOf(PIXELS) },
            ],
        }),
    );
    assert.equal(doc.layers.length, 2);
    assert.equal(doc.layers[0].width, 0);
    assert.equal(doc.layers[0].height, 0);
    assert.equal(doc.layers[0].rgba.length, 0);
    assert.deepEqual(rgba(doc.layers[1]), PIXELS);

    const empty = await parsePsd(buildPsd({ width: 8, height: 8, layers: [] }));
    assert.deepEqual(empty.layers, []);
});

test('入参接受 Uint8Array / ArrayBuffer 两种形态', async () => {
    const bytes = baseSample();
    const fromBytes = await parsePsd(new Uint8Array(bytes));
    const plain = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const fromBuffer = await parsePsd(plain);
    assert.deepEqual(rgba(fromBytes.layers[0]), PIXELS);
    assert.deepEqual(rgba(fromBuffer.layers[0]), PIXELS);
    await assert.rejects(() => parsePsd('8BPS'), (err) => CHINESE.test(err.message));
});
