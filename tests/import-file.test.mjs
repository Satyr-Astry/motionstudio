// app/shell/import-file.mjs 的契约测试
//
// 样本全部用 Buffer 手写构造（手法照 tests/psd.test.mjs：不依赖外部 .psd 文件、
// 不引第三方库，只写 raw 通道 —— RLE / zip 已由 psd.test.mjs 覆盖）。
// 只在 node 里跑：没有 Electron、没有 DOM、没有 ImageData，
// 于是 psdToObjects 的默认解码会落到「裸像素描述」兜底，顺带把那条兜底也测了。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    extOf,
    kindOf,
    toBytes,
    psdToObjects,
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
