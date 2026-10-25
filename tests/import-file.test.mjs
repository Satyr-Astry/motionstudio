// app/shell/import-file.mjs 的契约测试
//
// 样本全部用 Buffer 手写构造（手法照 tests/psd.test.mjs：不依赖外部 .psd 文件、
// 不引第三方库，只写 raw 通道 —— RLE / zip 已由 psd.test.mjs 覆盖）。
// 只在 node 里跑：没有 Electron、没有 DOM、没有 ImageData，
// 于是 psdToObjects 的默认解码会落到「裸像素描述」兜底，顺带把那条兜底也测了。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    alphaBounds,
    extOf,
    kindOf,
    toBytes,
    psdToObjects,
    psdLayerImage,
    imageToObject,
    importBuffer,
    pickAndImport,
    mixModeOf,
} from '../app/shell/import-file.mjs';
import { createDoc } from '../app/core/doc-model.mjs';
import { createEvaluator } from '../app/core/evaluator.mjs';

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

/** PSD（不是 PSB）：长度字段固定 4 字节。 */
const lenField = (n) => u32(n);

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

/** 附加块：'8BIM' + key + 4 字节长度 + 数据。 */
function tagged(key, data) {
    return Buffer.concat([Buffer.from('8BIM', 'latin1'), Buffer.from(key, 'latin1'), lenField(data.length), data]);
}

/** 扁平 RGBA → 通道平面（0=R/灰度、1=G、2=B、-1=alpha）。 */
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

function buildLayer(layer) {
    const left = layer.left ?? 0;
    const top = layer.top ?? 0;
    const width = layer.width ?? 0;
    const height = layer.height ?? 0;
    // 通道一律用压缩方式 0（raw）：本文件不测压缩算法
    const channels = (layer.planes || []).map((plane) => ({
        id: plane.id,
        data: Buffer.concat([u16(0), Buffer.from(plane.data)]),
    }));

    const extra = [u32(0), u32(0), pascal(layer.name)];
    if (/[^\x00-\xff]/.test(layer.name || '')) extra.push(tagged('luni', unicodeName(layer.name)));
    if (layer.divider !== undefined) extra.push(tagged('lsct', u32(layer.divider)));
    const extraData = Buffer.concat(extra);

    const record = Buffer.concat([
        i32(top),
        i32(left),
        i32(top + height),
        i32(left + width),
        u16(channels.length),
        ...channels.map((ch) => Buffer.concat([i16(ch.id), lenField(ch.data.length)])),
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
    const built = (spec.layers || []).map(buildLayer);
    const layerInfo = Buffer.concat([u16(built.length), ...built.map((b) => b.record), ...built.map((b) => b.data)]);
    const layerMask = Buffer.concat([
        lenField(layerInfo.length),
        layerInfo,
        u32(0), // 全局蒙版数据长度
    ]);
    const header = Buffer.concat([
        Buffer.from('8BPS', 'latin1'),
        u16(1), // version：1 = PSD
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
        lenField(layerMask.length),
        layerMask,
        u16(0), // 合并图像：压缩方式 0，后面没有数据
    ]);
}

// 2×2 像素样本（同 tests/psd.test.mjs，方便对照）
const PIXELS = [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 128, 128, 128, 128];
const ALT = [10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255];

// ── 用例 ──────────────────────────────────────────────────────────────────────

test('extOf / kindOf：只认白名单，其它一律空串', () => {
    assert.equal(extOf('A.PSD'), 'psd');
    assert.equal(extOf('D:/素材/final.psb'), 'psb');
    assert.equal(extOf('noext'), '');
    assert.equal(extOf(null), '');
    assert.equal(kindOf('a.psd'), 'psd');
    assert.equal(kindOf('a.PSB'), 'psd');
    assert.equal(kindOf('a.jpeg'), 'image');
    assert.equal(kindOf('a.webp'), 'image');
    assert.equal(kindOf('a.txt'), '');
    assert.equal(kindOf('a'), '');
});

test('toBytes：ArrayBuffer / Uint8Array / 视图都认，其它返回 null', () => {
    const buf = new Uint8Array([1, 2, 3, 4]).buffer;
    assert.deepEqual(Array.from(toBytes(buf)), [1, 2, 3, 4]);
    assert.deepEqual(Array.from(toBytes(new Uint8Array([5, 6]))), [5, 6]);
    // 视图只取自己那一段，不能把整个底层 buffer 都算进去
    const big = new Uint8Array([9, 8, 7, 6]);
    assert.deepEqual(Array.from(toBytes(new DataView(big.buffer, 1, 2))), [8, 7]);
    assert.equal(toBytes(null), null);
    assert.equal(toBytes(undefined), null);
    assert.equal(toBytes('abc'), null);
    assert.equal(toBytes(42), null);
});

test('psdToObjects：单图层 → 一个对象，位置落首帧关键帧，画格 at=0', async () => {
    const psd = buildPsd({
        width: 2,
        height: 2,
        layers: [{ name: '底层', width: 2, height: 2, left: 3, top: 4, planes: planesOf(PIXELS) }],
    });
    const res = await psdToObjects(psd);
    assert.equal(res.ok, true);
    assert.equal(res.report.imported, 1);
    assert.equal(res.report.hidden, 0);
    assert.equal(res.doc.objects.length, 1);

    const obj = res.doc.objects[0];
    assert.equal(obj.name, '底层');
    assert.equal(obj.kind, 'image');
    assert.equal(obj.visible, true);
    assert.equal(obj.opacity, 1);
    assert.equal(obj.cels.length, 1);
    assert.equal(obj.cels[0].at, 0);
    // node 里没有 ImageData / createImageBitmap：走「裸像素描述」兜底
    assert.equal(obj.cels[0].image.width, 2);
    assert.equal(obj.cels[0].image.height, 2);
    assert.ok(obj.cels[0].image.data instanceof Uint8ClampedArray);
    assert.equal(obj.cels[0].image.data.length, 16);
    assert.deepEqual(Array.from(obj.cels[0].image.data), PIXELS);

    // left/top → keys[0].state.x/y（anchor 为 {0,0} 时它就是图层左上角）
    const state = obj.transform.keys[0].state;
    assert.deepEqual([obj.transform.keys[0].t, state.x, state.y], [0, 3, 4]);
    assert.equal(res.activeId, obj.id);
    // 没有基准 doc 时按 PSD 尺寸新建
    assert.deepEqual([res.doc.width, res.doc.height], [2, 2]);
});

test('psdToObjects：PSD 自底向上的数组 → objects[0] 是最上层', async () => {
    const psd = buildPsd({
        width: 2,
        height: 2,
        layers: [
            { name: '底', width: 2, height: 2, planes: planesOf(PIXELS) },
            { name: '顶', width: 2, height: 2, planes: planesOf(ALT) },
        ],
    });
    const res = await psdToObjects(psd);
    assert.equal(res.ok, true);
    // 视觉顺序：合成时倒序遍历 objects，所以第 0 项盖在最上面
    assert.deepEqual(res.doc.objects.map((o) => o.name), ['顶', '底']);
    assert.equal(res.report.order, 'top-first');
    // 选中项是最上层那个
    assert.equal(res.activeId, res.doc.objects[0].id);
});

test("psdToObjects：order:'array' 保留数组原序（自底向上）", async () => {
    const psd = buildPsd({
        width: 2,
        height: 2,
        layers: [
            { name: '底', width: 2, height: 2, planes: planesOf(PIXELS) },
            { name: '顶', width: 2, height: 2, planes: planesOf(ALT) },
        ],
    });
    const res = await psdToObjects(psd, { order: 'array' });
    assert.equal(res.ok, true);
    assert.deepEqual(res.doc.objects.map((o) => o.name), ['底', '顶']);
    assert.equal(res.report.order, 'array');
});

test('psdToObjects：隐藏图层跳过，PSD 不透明度落到对象 opacity', async () => {
    const psd = buildPsd({
        width: 2,
        height: 2,
        layers: [
            { name: '可见', width: 2, height: 2, planes: planesOf(PIXELS) },
            { name: '隐藏', width: 2, height: 2, flags: 0x02, opacity: 0.5, planes: planesOf(ALT) },
        ],
    });
    const res = await psdToObjects(psd);
    assert.equal(res.ok, true);
    assert.equal(res.report.imported, 1);
    assert.equal(res.report.hidden, 1);
    assert.deepEqual(res.doc.objects.map((o) => o.name), ['可见']);
    assert.equal(res.doc.objects[0].opacity, 1);

    // 反过来：让带 0.5 的那层可见，opacity 必须跟过来（u8 量化后允许 0.005 误差）
    const half = await psdToObjects(
        buildPsd({
            width: 2,
            height: 2,
            layers: [{ name: '半透明', width: 2, height: 2, opacity: 0.5, planes: planesOf(ALT) }],
        }),
    );
    assert.ok(Math.abs(half.doc.objects[0].opacity - 0.5) < 0.005);
});

test('psdToObjects：组生成组对象，组内图层的 parentId 都指向它', async () => {
    const psd = buildPsd({
        width: 2,
        height: 2,
        layers: [
            { name: '按钮', divider: 1, opacity: 0.5 },
            { name: '底色', width: 2, height: 2, left: 3, top: 4, planes: planesOf(PIXELS) },
            { name: '描边', width: 2, height: 2, left: 5, top: 6, planes: planesOf(ALT) },
            { name: '按钮', divider: 2 },
            { name: '组外', width: 2, height: 2, left: 7, top: 8, planes: planesOf(PIXELS) },
        ],
    });
    const res = await psdToObjects(psd);
    assert.equal(res.ok, true);
    // objects[0] 是最上层：组外 > [按钮 > 描边 > 底色]，组对象排在自己的子对象前面
    assert.deepEqual(res.doc.objects.map((o) => o.name), ['组外', '按钮', '描边', '底色']);
    const [outer, group, top, bottom] = res.doc.objects;

    // 组对象：没有位图，但有画格槽位、自己的不透明度、没有父
    assert.equal(group.kind, 'image');
    assert.equal(group.cels.length, 1);
    assert.equal(group.cels[0].at, 0);
    assert.equal(group.cels[0].image, null);
    assert.ok(Math.abs(group.opacity - 0.5) < 0.005);
    assert.equal(group.parentId, undefined);

    // 两层都挂到同一个组对象上
    assert.equal(top.parentId, group.id);
    assert.equal(bottom.parentId, group.id);
    assert.equal(outer.parentId, undefined);

    // 组位移为 0，子对象写相对父原点的偏移 → 仍是文档坐标，画面位置不变
    assert.deepEqual([group.transform.keys[0].state.x, group.transform.keys[0].state.y], [0, 0]);
    assert.deepEqual([top.transform.keys[0].state.x, top.transform.keys[0].state.y], [5, 6]);
    assert.deepEqual([bottom.transform.keys[0].state.x, bottom.transform.keys[0].state.y], [3, 4]);
    assert.deepEqual([outer.transform.keys[0].state.x, outer.transform.keys[0].state.y], [7, 8]);

    // 组名不再拼进对象名；统计口径分开：groups = 组对象数，grouped = 挂进组的图层数
    assert.deepEqual(res.doc.objects.map((o) => o.name), ['组外', '按钮', '描边', '底色']);
    assert.equal(res.report.groups, 1);
    assert.equal(res.report.grouped, 2);
    assert.equal(res.report.imported, 4);
});

test('psdToObjects：嵌套组 → 二级 parentId 指向内层组，坐标层层相对', async () => {
    const psd = buildPsd({
        width: 2,
        height: 2,
        layers: [
            { name: '外框', divider: 1 },
            { name: '内芯', divider: 1 },
            { name: '深层', width: 2, height: 2, left: 5, top: 6, planes: planesOf(PIXELS) },
            { name: '内芯', divider: 2 },
            { name: '直属', width: 2, height: 2, left: 9, top: 10, planes: planesOf(ALT) },
            { name: '外框', divider: 2 },
        ],
    });
    const res = await psdToObjects(psd);
    assert.equal(res.ok, true);
    // 外框 > [直属, 内芯 > 深层]，每个组对象都在自己的子对象前面
    assert.deepEqual(res.doc.objects.map((o) => o.name), ['外框', '直属', '内芯', '深层']);
    const [outerGroup, direct, inner, deep] = res.doc.objects;

    // 二级关系：深层 → 内芯，内芯 → 外框，外框没有父
    assert.equal(deep.parentId, inner.id);
    assert.equal(inner.parentId, outerGroup.id);
    assert.equal(outerGroup.parentId, undefined);
    assert.equal(direct.parentId, outerGroup.id);

    // 每层组位移都是 0，所以深层仍是文档坐标 (5,6)
    assert.deepEqual([deep.transform.keys[0].state.x, deep.transform.keys[0].state.y], [5, 6]);
    assert.equal(res.report.groups, 2);
    assert.equal(res.report.grouped, 2);

    // 再拿真实求值器复核：父链叠加后的世界平移必须还原成文档坐标，画面位置不变
    const ev = createEvaluator(res.doc);
    const worldXY = (o) => {
        const m = ev.matrix(o, 0); // 4×4→六元组 [a, b, c, d, e, f]
        return [m[4], m[5]];
    };
    assert.deepEqual(worldXY(outerGroup), [0, 0]);
    assert.deepEqual(worldXY(inner), [0, 0]);
    assert.deepEqual(worldXY(direct), [9, 10]);
    assert.deepEqual(worldXY(deep), [5, 6]);
});


test('psdToObjects：真实 PSD 的组结束标记（divider 3）也能正确配对', async () => {
    // Photoshop 实际写的是「组头 divider=1 + 组尾 divider=3」，组尾记录还带一个占位名
    const psd = buildPsd({
        width: 2,
        height: 2,
        layers: [
            { name: '</Layer group>', divider: 1 },
            { name: '组内', width: 2, height: 2, planes: planesOf(PIXELS) },
            { name: '</Layer group>', divider: 3 },
            { name: '组外', width: 2, height: 2, planes: planesOf(ALT) },
        ],
    });
    const res = await psdToObjects(psd);
    assert.equal(res.ok, true);
    assert.deepEqual(res.doc.objects.map((o) => o.name), ['组外', '</Layer group>', '组内']);
    const [outside, group, inside] = res.doc.objects;
    assert.equal(group.parentId, undefined);
    assert.equal(inside.parentId, group.id);
    assert.equal(outside.parentId, undefined);
    assert.equal(res.report.groups, 1);
    assert.equal(res.report.grouped, 1);
});

test('psdToObjects：不可见组 → 组对象 visible=false，整棵子树跟着不渲染', async () => {
    const psd = buildPsd({
        width: 2,
        height: 2,
        layers: [
            { name: '隐藏组', divider: 1, flags: 0x02 },
            { name: '内容', width: 2, height: 2, planes: planesOf(PIXELS) },
            { name: '隐藏组', divider: 2 },
            { name: '可见层', width: 2, height: 2, planes: planesOf(ALT) },
        ],
    });
    const res = await psdToObjects(psd);
    assert.equal(res.ok, true);
    assert.deepEqual(res.doc.objects.map((o) => o.name), ['可见层', '隐藏组', '内容']);
    const [shown, group, child] = res.doc.objects;
    assert.equal(group.visible, false);
    // 求值器只看本层 visible（不沿 parentId 往上查），所以祖先隐藏必须落到子对象身上
    assert.equal(child.visible, false);
    assert.equal(child.parentId, group.id);
    assert.equal(shown.visible, true);
    // 组记录不是「被丢掉的图层」：hidden 只数图层
    assert.equal(res.report.hidden, 0);
    assert.equal(res.report.groups, 1);
});

test('psdToObjects：blendMode 只映射 canvas 认识的混色，其余回退 source-over', async () => {
    const layer = (name, blend) => ({ name, blend, width: 2, height: 2, planes: planesOf(PIXELS) });
    const psd = buildPsd({
        width: 2,
        height: 2,
        layers: [
            layer('正常', 'norm'),
            layer('正片叠底', 'mul '),
            layer('滤色', 'scrn'),
            layer('强光', 'hLit'),
            layer('溶解', 'diss'), // canvas 没有对应枚举 → 回退
            layer('线性减淡', 'lddg'), // 'lighter' 是合成算子（连 alpha 一起加），语义不同 → 回退
            layer('未知码', 'zzzz'), // 认不出的码 → 回退
        ],
    });
    const res = await psdToObjects(psd);
    assert.equal(res.ok, true);
    const got = new Map(res.doc.objects.map((o) => [o.name, o.mixMode]));
    assert.equal(got.get('正常'), 'source-over');
    assert.equal(got.get('正片叠底'), 'multiply');
    assert.equal(got.get('滤色'), 'screen');
    assert.equal(got.get('强光'), 'hard-light');
    assert.equal(got.get('溶解'), 'source-over');
    assert.equal(got.get('线性减淡'), 'source-over');
    assert.equal(got.get('未知码'), 'source-over');

    // 映射函数本身：大小写/空格不敏感，非字符串有兜底
    assert.equal(mixModeOf('MULTIPLY'), 'multiply');
    assert.equal(mixModeOf(' Color Burn '), 'color-burn');
    assert.equal(mixModeOf(null), 'source-over');
    assert.equal(mixModeOf(undefined), 'source-over');
    assert.equal(mixModeOf(''), 'source-over');
    assert.equal(mixModeOf('linear dodge'), 'source-over');
});

test('psdToObjects：空组不留痕（组里没有可导入子对象就不生成组对象）', async () => {
    const psd = buildPsd({
        width: 2,
        height: 2,
        layers: [
            { name: '空组', divider: 1 },
            { name: '里面全隐藏', width: 2, height: 2, flags: 0x02, planes: planesOf(PIXELS) },
            { name: '空组', divider: 2 },
            { name: '真实层', width: 2, height: 2, planes: planesOf(ALT) },
        ],
    });
    const res = await psdToObjects(psd);
    assert.equal(res.ok, true);
    assert.deepEqual(res.doc.objects.map((o) => o.name), ['真实层']);
    assert.equal(res.report.groups, 0);
    assert.equal(res.report.hidden, 1);

    // 整份 PSD 只剩空壳：仍然是「没有可导入的图层」，不能产出一个空组对象
    const only = await psdToObjects(
        buildPsd({
            width: 2,
            height: 2,
            layers: [
                { name: '空组', divider: 1 },
                { name: '空组', divider: 2 },
            ],
        }),
    );
    assert.equal(only.ok, false);
    assert.match(only.error, /没有可导入的图层/);
    assert.equal(only.report.groups, 0);
});

test('psdToObjects：并进已有 doc 且不原地改它（导入对象在最上层）', async () => {
    const base = createDoc({
        width: 900,
        height: 640,
        objects: [{ id: 'keep', name: '已有', cels: [{ at: 0, image: null }] }],
    });
    const snapshot = JSON.stringify({ w: base.width, h: base.height, names: base.objects.map((o) => o.name) });
    const psd = buildPsd({
        width: 2,
        height: 2,
        layers: [{ name: '新层', width: 2, height: 2, left: 10, top: 20, planes: planesOf(PIXELS) }],
    });
    const res = await psdToObjects(psd, { doc: base });
    assert.equal(res.ok, true);
    // 已有文档的尺寸不变；导入的排在第 0 位，老对象被顶下去
    assert.deepEqual([res.doc.width, res.doc.height], [900, 640]);
    assert.deepEqual(res.doc.objects.map((o) => o.name), ['新层', '已有']);
    assert.equal(res.doc.objects[1].id, 'keep');
    // 入参没被改动
    assert.equal(
        JSON.stringify({ w: base.width, h: base.height, names: base.objects.map((o) => o.name) }),
        snapshot,
    );
    assert.notEqual(res.doc, base);
});

test('psdToObjects：16 位 PSD 透出 parsePsd 的中文原因，不抛', async () => {
    const psd = buildPsd({
        width: 2,
        height: 2,
        depth: 16,
        layers: [{ name: '深层', width: 2, height: 2, planes: planesOf(PIXELS) }],
    });
    const res = await psdToObjects(psd);
    assert.equal(res.ok, false);
    assert.match(res.error, /位深/);
    assert.equal(res.doc, undefined);
});

test('psdToObjects：空 buffer / 非 PSD 字节都是 {ok:false}，不抛', async () => {
    const empty = await psdToObjects(new Uint8Array(0));
    assert.equal(empty.ok, false);
    assert.match(empty.error, /没有读到/);

    const junk = await psdToObjects(Buffer.from('this is definitely not a psd', 'latin1'));
    assert.equal(junk.ok, false);
    assert.match(junk.error, /PSD|签名|越界/);

    // null / 莫名类型也不能炸
    assert.equal((await psdToObjects(null)).ok, false);
});

test('psdToObjects：图层全隐藏时报「没有可导入的图层」', async () => {
    const psd = buildPsd({
        width: 2,
        height: 2,
        layers: [{ name: '只此一层', width: 2, height: 2, flags: 0x02, planes: planesOf(PIXELS) }],
    });
    const res = await psdToObjects(psd);
    assert.equal(res.ok, false);
    assert.match(res.error, /没有可导入的图层/);
    assert.equal(res.report.hidden, 1);
});

test('imageToObject：kind=image、尺寸按图片、画布尺寸不变、默认居中', async () => {
    const base = createDoc({ width: 900, height: 640, objects: [{ name: '已有', cels: [{ at: 0, image: null }] }] });
    // 注入解码器：node 里没有 createImageBitmap
    const bitmap = { width: 40, height: 20 };
    const res = await imageToObject(new Uint8Array([1, 2, 3]), {
        doc: base,
        name: '照片.PNG',
        decode: () => bitmap,
    });
    assert.equal(res.ok, true);
    assert.equal(res.report.imported, 1);
    assert.deepEqual([res.report.width, res.report.height], [40, 20]);
    // 画布尺寸不动
    assert.deepEqual([res.doc.width, res.doc.height], [900, 640]);
    const obj = res.doc.objects[0];
    assert.equal(obj.name, '照片');
    assert.equal(obj.kind, 'image');
    assert.deepEqual(res.doc.objects.map((o) => o.name), ['照片', '已有']);
    const state = obj.transform.keys[0].state;
    assert.deepEqual([state.x, state.y], [430, 310]);
    // 画格直接持有解码出来的位图（不再复制 / 二次加工）
    assert.equal(obj.cels[0].image, bitmap);
});

test('imageToObject：给了 x/y 就用给的坐标；解码失败返回中文原因', async () => {
    const placed = await imageToObject(new Uint8Array([1]), {
        doc: createDoc({ width: 100, height: 100, objects: [{ name: 'a', cels: [{ at: 0, image: null }] }] }),
        name: 'a.png',
        x: 7,
        y: 9,
        decode: () => ({ width: 10, height: 10 }),
    });
    assert.deepEqual([placed.report.x, placed.report.y], [7, 9]);

    const broken = await imageToObject(new Uint8Array([1]), { name: 'a.png', decode: () => null });
    assert.equal(broken.ok, false);
    assert.match(broken.error, /解码失败/);

    assert.equal((await imageToObject(new Uint8Array(0), { name: 'a.png' })).ok, false);
});

test('importBuffer：按扩展名分派；不支持的类型给中文原因', async () => {
    const img = await importBuffer(
        { name: 'b.JPEG', data: new Uint8Array([1, 2]) },
        { decode: () => ({ width: 8, height: 8 }) },
    );
    assert.equal(img.ok, true);
    assert.equal(img.report.kind, 'image');

    // 同一份分派器走 PSD 分支：图层为空时给出可读原因
    const empty = await importBuffer({ name: 'c.psd', data: buildPsd({ width: 2, height: 2, layers: [] }) });
    assert.equal(empty.ok, false);
    assert.match(empty.error, /没有可导入的图层/);

    const bad = await importBuffer({ name: 'notes.txt', data: new Uint8Array([1]) });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /不支持的文件类型：\.txt/);
});

test('pickAndImport：没有 preload 桥时返回 {ok:false}，不抛', async () => {
    const res = await pickAndImport({});
    assert.equal(res.ok, false);
    assert.match(res.error, /桌面版/);
});

// ── alpha 包围盒裁剪（图层矩形 ≠ 内容矩形） ───────────────────────────────────
//
// PSD 的图层矩形常常等于整幅画布，留白却全是 alpha=0。裁到内容包围盒能让对象
// 自己的「纸」贴合内容（缩略图、画板编辑、缩放都不再被空白带偏），代价是原点
// 要跟着偏移 dx/dy —— 这两件事必须成对成立，所以下面按「尺寸 + 坐标」一起断言。

/** 4×4 里只有中间 2×2 有像素，alpha 只给 1：裁剪只认 alpha>0，不看 RGB。 */
const INSET_4X4 = (() => {
    const px = new Array(16 * 4).fill(0);
    for (const [x, y] of [[1, 1], [2, 1], [1, 2], [2, 2]]) {
        const at = (y * 4 + x) * 4;
        px[at] = 200;
        px[at + 1] = 100;
        px[at + 2] = 50;
        px[at + 3] = 1;
    }
    return px;
})();

const ALL_TRANSPARENT_4X4 = new Array(16 * 4).fill(0);

test('alphaBounds：只认 alpha、四周留白收缩、全透明返回 null', () => {
    assert.deepEqual(alphaBounds(INSET_4X4, 4, 4), { x: 1, y: 1, w: 2, h: 2 });

    const one = new Uint8ClampedArray(3 * 3 * 4);
    one[(1 * 3 + 2) * 4 + 3] = 255;
    assert.deepEqual(alphaBounds(one, 3, 3), { x: 2, y: 1, w: 1, h: 1 });

    // 全透明 → null（调用方据此保留原矩形，不裁）
    assert.equal(alphaBounds(ALL_TRANSPARENT_4X4, 4, 4), null);
    // 参数不成立时也返回 null，而不是抛
    assert.equal(alphaBounds(INSET_4X4, 0, 4), null);
    assert.equal(alphaBounds(null, 4, 4), null);
    // 缓冲比 w*h*4 短 → 不猜，直接 null
    assert.equal(alphaBounds(INSET_4X4.slice(0, 16 * 4 - 1), 4, 4), null);
});

test('psdToObjects：图层带透明留白 → 位图裁到内容，坐标补上 dx/dy', async () => {
    const psd = buildPsd({
        width: 40,
        height: 30,
        layers: [{
            name: '留白层',
            left: 10,
            top: 6,
            width: 4,
            height: 4,
            planes: planesOf(INSET_4X4),
        }],
    });
    const res = await psdToObjects(psd);
    assert.equal(res.ok, true);

    const obj = res.doc.objects[0];
    const img = obj.cels[0].image;
    assert.deepEqual([img.width, img.height], [2, 2]);
    // 世界位置不变：left + dx = 10 + 1，top + dy = 6 + 1
    const state = obj.transform.keys[0].state;
    assert.deepEqual([state.x, state.y], [11, 7]);
    // 裁出来的像素就是原图中间那 4 个点（行优先，颜色与 alpha 原样保留）
    assert.deepEqual(Array.from(img.data), [
        200, 100, 50, 1, 200, 100, 50, 1,
        200, 100, 50, 1, 200, 100, 50, 1,
    ]);
});

test('psdToObjects：满内容层与全透明层都不改矩形，坐标不偏', async () => {
    const full = await psdToObjects(buildPsd({
        width: 8,
        height: 8,
        layers: [{ name: '满层', left: 3, top: 2, width: 2, height: 2, planes: planesOf(PIXELS) }],
    }));
    assert.equal(full.ok, true);
    const a = full.doc.objects[0];
    assert.deepEqual([a.cels[0].image.width, a.cels[0].image.height], [2, 2]);
    assert.deepEqual([a.transform.keys[0].state.x, a.transform.keys[0].state.y], [3, 2]);

    // alpha 全 0：alphaBounds 给 null，矩形原样保留，偏移补 0
    const clear = await psdToObjects(buildPsd({
        width: 8,
        height: 8,
        layers: [{ name: '全透明', left: 4, top: 5, width: 2, height: 2, planes: planesOf(ALL_TRANSPARENT_4X4) }],
    }));
    assert.equal(clear.ok, true);
    const b = clear.doc.objects[0];
    assert.deepEqual([b.cels[0].image.width, b.cels[0].image.height], [2, 2]);
    assert.deepEqual([b.transform.keys[0].state.x, b.transform.keys[0].state.y], [4, 5]);
});

test('psdToObjects：组内的留白层，裁剪偏移与父对象偏移各算各的', async () => {
    const psd = buildPsd({
        width: 40,
        height: 30,
        layers: [
            { name: '组', divider: 1 },
            { name: '组内留白层', left: 10, top: 6, width: 4, height: 4, planes: planesOf(INSET_4X4) },
            { name: '', divider: 3 },
        ],
    });
    const res = await psdToObjects(psd);
    assert.equal(res.ok, true);
    assert.equal(res.report.groups, 1);

    const child = res.doc.objects.find((o) => o.name === '组内留白层');
    const group = res.doc.objects.find((o) => o.name === '组');
    assert.ok(child && group);
    assert.equal(child.parentId, group.id);
    assert.deepEqual([child.cels[0].image.width, child.cels[0].image.height], [2, 2]);
    // 组原点恒为 0（组自身不位移），所以子对象仍是文档坐标：left + dx
    assert.deepEqual([child.transform.keys[0].state.x, child.transform.keys[0].state.y], [11, 7]);
});

// ── alphaBounds 的两条执行路径 ────────────────────────────────────────────────
//
// 满内容层走「边界抽查」快路径（O(w+h)），有留白的层必须整体扫描。
// 两条路径给出同一个答案才算对，所以这里逐项对照，专门挑会互相打架的形状。

/** 造 w×h 的 RGBA 缓冲，`on(x,y)` 返回 alpha（0 = 透明）。 */
function rgbaMask(w, h, on) {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            const a = on(x, y);
            if (a) px[(y * w + x) * 4 + 3] = a;
        }
    }
    return px;
}

test('alphaBounds：四条边都满 → 整张；某条边整条透明 → 收缩一条', () => {
    // 边界抽查命中：矩形就是整张
    assert.deepEqual(alphaBounds(rgbaMask(6, 5, () => 255), 6, 5), { x: 0, y: 0, w: 6, h: 5 });
    // 角落缺一个像素不算「缺边」——其余边界像素仍不透明，包围盒没变
    assert.deepEqual(alphaBounds(rgbaMask(6, 5, (x, y) => (x === 0 && y === 0 ? 0 : 255)), 6, 5), { x: 0, y: 0, w: 6, h: 5 });
    // 单点内容：四条边都透明，包围盒是 1×1
    assert.deepEqual(alphaBounds(rgbaMask(6, 5, (x, y) => (x === 3 && y === 2 ? 255 : 0)), 6, 5), { x: 3, y: 2, w: 1, h: 1 });

    // 每条边各整条透明一次：抽查发现透明 → 全扫定边界
    assert.deepEqual(alphaBounds(rgbaMask(6, 5, (x, y) => (y === 0 ? 0 : 255)), 6, 5), { x: 0, y: 1, w: 6, h: 4 });
    assert.deepEqual(alphaBounds(rgbaMask(6, 5, (x, y) => (y === 4 ? 0 : 255)), 6, 5), { x: 0, y: 0, w: 6, h: 4 });
    assert.deepEqual(alphaBounds(rgbaMask(6, 5, (x, y) => (x === 0 ? 0 : 255)), 6, 5), { x: 1, y: 0, w: 5, h: 5 });
    assert.deepEqual(alphaBounds(rgbaMask(6, 5, (x, y) => (x === 5 ? 0 : 255)), 6, 5), { x: 0, y: 0, w: 5, h: 5 });
    // 1 像素高/宽的退化层：不能因为「没有中间行可抽」就越界读数
    assert.deepEqual(alphaBounds(rgbaMask(1, 5, () => 255), 1, 5), { x: 0, y: 0, w: 1, h: 5 });
    assert.deepEqual(alphaBounds(rgbaMask(5, 1, (x) => (x === 2 ? 255 : 0)), 5, 1), { x: 2, y: 0, w: 1, h: 1 });
});

test('alphaBounds：整行透明被短路跳过，稀疏内容仍得到紧包围盒', () => {
    // 只有四个角 + 一条斜线：每行/每列都可能被跳过，两端收缩必须收敛到真实边界
    const sparse = rgbaMask(9, 7, (x, y) => (x === y || (x === 0 && y === 6) || (x === 8 && y === 0) ? 255 : 0));
    assert.deepEqual(alphaBounds(sparse, 9, 7), { x: 0, y: 0, w: 9, h: 7 });

    // 内容只在第 3 行第 4 列一个点：上下左右都留白
    const dot = rgbaMask(9, 7, (x, y) => (x === 4 && y === 3 ? 1 : 0));
    assert.deepEqual(alphaBounds(dot, 9, 7), { x: 4, y: 3, w: 1, h: 1 });

    // 一行两段不连续的内容：整行短路不能把中间的空洞算进包围盒（两端收缩只看外侧）
    const two = rgbaMask(9, 1, (x) => (x === 1 || x === 7 ? 255 : 0));
    assert.deepEqual(alphaBounds(two, 9, 1), { x: 1, y: 0, w: 7, h: 1 });

    // alpha=1 也算内容（只认 alpha>0，不设阈值）
    const faint = rgbaMask(4, 4, (x, y) => (x === 2 && y === 2 ? 1 : 0));
    assert.deepEqual(alphaBounds(faint, 4, 4), { x: 2, y: 2, w: 1, h: 1 });
});

test('alphaBounds：字节视图未对齐、或不是 Uint8ClampedArray 也能算对', () => {
    const px = rgbaMask(5, 4, (x, y) => (x >= 1 && x <= 3 && y >= 1 && y <= 2 ? 200 : 0));
    const want = { x: 1, y: 1, w: 3, h: 2 };
    assert.deepEqual(alphaBounds(px, 5, 4), want);

    // 同一份像素装进大缓冲的奇数偏移：byteOffset 不能被 4 整除，
    // 直接拿 Uint32Array 视图会错位，所以内部必须先拷一份对齐的
    const host = new Uint8ClampedArray(px.length + 5);
    host.set(px, 3);
    const unaligned = host.subarray(3, 3 + px.length);
    assert.equal(unaligned.byteOffset % 4, 3);
    assert.deepEqual(alphaBounds(unaligned, 5, 4), want);

    // 普通数组也算（走拷贝分支）；Uint32Array 视图同样接受
    assert.deepEqual(alphaBounds(Array.from(px), 5, 4), want);
    const u32view = new Uint32Array(new Uint8ClampedArray(px).buffer);
    assert.deepEqual(alphaBounds(u32view, 5, 4), want);
});

// ── psdLayerImage 的返回形状（不再往 layer 上挂 __trim） ───────────────────────

test('psdLayerImage：返回 {image,trim}，图层对象上不留 __trim', async () => {
    const psd = buildPsd({
        width: 40,
        height: 30,
        layers: [{ name: '留白层', left: 10, top: 6, width: 4, height: 4, planes: planesOf(INSET_4X4) }],
    });
    // 直接从解析结果里拿图层，验证函数对这个对象的副作用
    const { parsePsd } = await import('../app/core/psd.mjs');
    const parsed = await parsePsd(psd);
    assert.equal(parsed.layers.length, 1);
    const layer = parsed.layers[0];
    const before = Object.keys(layer).sort();

    const out = await psdLayerImage(layer);
    assert.deepEqual([out.image.width, out.image.height], [2, 2]);
    assert.deepEqual(out.trim, { dx: 1, dy: 1, srcW: 4, srcH: 4, trimmed: true });
    // 关键：共享的图层对象一个键都不能多（旧实现会挂 __trim）
    assert.deepEqual(Object.keys(layer).sort(), before);
    assert.equal('__trim' in layer, false);
});

test('psdLayerImage：交给 ImageData 的是裁后缓冲，长度与尺寸严格配对', async () => {
    const hadImageData = 'ImageData' in globalThis;
    const hadBitmap = 'createImageBitmap' in globalThis;
    const oldImageData = globalThis.ImageData;
    const oldBitmap = globalThis.createImageBitmap;
    const seen = [];
    // 桩：Chromium 的 ImageData 构造器在 data 长度 ≠ w*h*4 时抛 IndexSizeError，
    // 这里照抄那条约束，于是「不抛」就等于「缓冲和尺寸配上了」
    globalThis.ImageData = class {
        constructor(data, width, height) {
            if (data.length !== width * height * 4) throw new Error('IndexSizeError: bad input data length');
            this.data = data;
            this.width = width;
            this.height = height;
            seen.push({ len: data.length, width, height });
        }
    };
    globalThis.createImageBitmap = async (d) => ({ kind: 'ImageBitmap', width: d.width, height: d.height });
    try {
        const psd = buildPsd({
            width: 40,
            height: 30,
            layers: [{ name: '留白层', left: 10, top: 6, width: 4, height: 4, planes: planesOf(INSET_4X4) }],
        });
        const res = await psdToObjects(psd);
        assert.equal(res.ok, true);
        assert.equal(res.report.trimmed, 1);
        assert.deepEqual(seen, [{ len: 2 * 2 * 4, width: 2, height: 2 }]);
        const obj = res.doc.objects[0];
        assert.equal(obj.cels[0].image.kind, 'ImageBitmap');
        assert.deepEqual([obj.cels[0].image.width, obj.cels[0].image.height], [2, 2]);
        assert.deepEqual([obj.transform.keys[0].state.x, obj.transform.keys[0].state.y], [11, 7]);
    } finally {
        if (hadImageData) globalThis.ImageData = oldImageData; else delete globalThis.ImageData;
        if (hadBitmap) globalThis.createImageBitmap = oldBitmap; else delete globalThis.createImageBitmap;
    }
});

test('splitLayerImage 的兼容边界：注入裸位图时 trim 为 0，不补偏移', async () => {
    const psd = buildPsd({
        width: 40,
        height: 30,
        layers: [{ name: '留白层', left: 10, top: 6, width: 4, height: 4, planes: planesOf(INSET_4X4) }],
    });
    // 老用法：makeImage 返回裸位图（没有 trim 键）→ 偏移一律 0，坐标就是 layer.left/top
    const bare = await psdToObjects(psd, { makeImage: () => ({ width: 9, height: 9 }) });
    assert.equal(bare.ok, true);
    assert.equal(bare.report.trimmed, 0);
    const a = bare.doc.objects[0];
    assert.deepEqual([a.cels[0].image.width, a.cels[0].image.height], [9, 9]);
    assert.deepEqual([a.transform.keys[0].state.x, a.transform.keys[0].state.y], [10, 6]);

    // 新用法：makeImage 自己返回容器 → trim 生效
    const boxed = await psdToObjects(psd, {
        makeImage: () => ({ image: { width: 7, height: 7 }, trim: { dx: 2, dy: 3, srcW: 4, srcH: 4, trimmed: true } }),
    });
    assert.equal(boxed.report.trimmed, 1);
    const b = boxed.doc.objects[0];
    assert.deepEqual([b.cels[0].image.width, b.cels[0].image.height], [7, 7]);
    assert.deepEqual([b.transform.keys[0].state.x, b.transform.keys[0].state.y], [12, 9]);

    // makeImage 返回 null：当作空位图计数，不抛
    const empty = await psdToObjects(psd, { makeImage: () => null });
    assert.equal(empty.ok, false);
    assert.match(empty.error, /没有可导入的图层/);
});

// ── 位图（PNG/JPG/WebP）走同一套裁剪规则 ──────────────────────────────────────
//
// 位图没有「图层矩形」，所以裁剪只影响两件事：画格位图尺寸、原点偏移。
// 居中仍按原图尺寸算 —— 裁掉的只是透明的纸，画面位置不能挪。

test('imageToObject：留白 PNG 裁到内容，原点补 dx/dy，居中原点不变', async () => {
    // 40×20 里内容在 (5,4) 起的 10×6，其余全透明
    const px = new Uint8ClampedArray(40 * 20 * 4);
    for (let y = 4; y < 10; y += 1) {
        for (let x = 5; x < 15; x += 1) {
            const at = (y * 40 + x) * 4;
            px[at] = 12;
            px[at + 1] = 34;
            px[at + 2] = 56;
            px[at + 3] = 255;
        }
    }
    const base = createDoc({ width: 900, height: 640, objects: [{ name: '已有', cels: [{ at: 0, image: null }] }] });
    const res = await imageToObject(new Uint8Array([1]), {
        doc: base,
        name: '带留白的图.png',
        decode: () => ({ width: 40, height: 20, data: px }),
    });
    assert.equal(res.ok, true);
    // 居中原点 = ((900-40)/2, (640-20)/2) = (430, 310)，再补内容偏移 (5, 4)
    assert.deepEqual([res.report.x, res.report.y], [435, 314]);
    assert.deepEqual([res.doc.objects[0].transform.keys[0].state.x, res.doc.objects[0].transform.keys[0].state.y], [435, 314]);
    // report 的 width/height 仍是原图尺寸（既有语义不改），裁后尺寸另给字段
    assert.deepEqual([res.report.width, res.report.height], [40, 20]);
    assert.equal(res.report.trimmed, true);
    assert.deepEqual([res.report.contentWidth, res.report.contentHeight], [10, 6]);
    assert.equal(res.report.trimSkipped, '');

    const img = res.doc.objects[0].cels[0].image;
    assert.deepEqual([img.width, img.height], [10, 6]);
    // node 里没有 canvas，裁出来的只能是裸像素描述：首像素就是原图 (5,4)
    assert.deepEqual(Array.from(img.data.slice(0, 4)), [12, 34, 56, 255]);
    assert.equal(img.data.length, 10 * 6 * 4);
});

test('imageToObject：裁不了就保持原图 —— 读不到像素/超大图/关开关/全透明都不算失败', async () => {
    const cases = [
        // 只有尺寸、没有 data：node 里没有 canvas 可读，读不到就是读不到
        { name: 'nopixels', bitmap: { width: 40, height: 20 }, opts: {}, skipped: 'nopixels' },
        // 超过上限：再读一份像素会让峰值内存翻倍，宁可保持原样
        { name: 'big', bitmap: { width: 5000, height: 5000 }, opts: {}, skipped: 'big' },
        // 调用方明确不要裁剪
        {
            name: 'off',
            bitmap: { width: 4, height: 4, data: rgbaMask(4, 4, () => 255) },
            opts: { trim: false },
            skipped: 'off',
        },
        // 全透明：没有内容可裁（alphaBounds 返回 null），保留原矩形
        {
            name: 'clear',
            bitmap: { width: 4, height: 4, data: rgbaMask(4, 4, () => 0) },
            opts: {},
            skipped: 'clear',
        },
        // 边界全不透明：包围盒等于整张，等于没裁
        {
            name: 'full',
            bitmap: { width: 4, height: 4, data: rgbaMask(4, 4, () => 255) },
            opts: {},
            skipped: 'full',
        },
    ];
    for (const c of cases) {
        const res = await imageToObject(new Uint8Array([1]), {
            name: c.name + '.png',
            ...c.opts,
            decode: () => c.bitmap,
        });
        assert.equal(res.ok, true, c.name + ' 必须导入成功');
        assert.equal(res.report.trimSkipped, c.skipped, c.name + ' 的跳过原因');
        assert.equal(res.report.trimmed, false, c.name + ' 不该标成已裁剪');
        // 位图原样保留（同一个对象引用），坐标 = 纯居中
        assert.equal(res.doc.objects[0].cels[0].image, c.bitmap, c.name + ' 位图不该被替换');
        assert.deepEqual([res.report.contentWidth, res.report.contentHeight], [c.bitmap.width, c.bitmap.height]);
    }
});
