import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_TOLERANCE, floodFillRegion, parseHex } from '../app/paint/fill.mjs';

/** 造一块 RGBA 数据；fn(x, y) 返回 [r,g,b,a]，默认全透明。 */
function makeData(w, h, fn) {
    const d = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            const px = fn ? fn(x, y) : [0, 0, 0, 0];
            const i = (y * w + x) * 4;
            d[i] = px[0];
            d[i + 1] = px[1];
            d[i + 2] = px[2];
            d[i + 3] = px[3] === undefined ? 255 : px[3];
        }
    }
    return d;
}

function setPx(d, w, x, y, [r, g, b, a]) {
    const i = (y * w + x) * 4;
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a === undefined ? 255 : a;
}

function getPx(d, w, x, y) {
    const i = (y * w + x) * 4;
    return [d[i], d[i + 1], d[i + 2], d[i + 3]];
}

test('parseHex：#rrggbb / 无 # / 大小写都认，坏输入回落黑色', () => {
    assert.deepEqual(parseHex('#ff0000'), [255, 0, 0, 255]);
    assert.deepEqual(parseHex('00AA00'), [0, 170, 0, 255]);
    assert.deepEqual(parseHex('  #123456  '), [18, 52, 86, 255]);
    assert.deepEqual(parseHex('#abc'), [0, 0, 0, 255], '短 hex 不认，回落黑');
    assert.deepEqual(parseHex('rgba(1,2,3,1)'), [0, 0, 0, 255]);
    assert.deepEqual(parseHex(null), [0, 0, 0, 255]);
    assert.deepEqual(parseHex(undefined), [0, 0, 0, 255]);
    assert.equal(DEFAULT_TOLERANCE, 24);
});

test('起点越界：不碰数据、painted=0（调用方据此不产生撤销命令）', () => {
    const w = 4;
    const h = 3;
    const base = makeData(w, h);
    for (const [sx, sy] of [[-1, 0], [0, -1], [w, 0], [0, h], [w + 9, h + 9], [NaN, 1], [1, Infinity]]) {
        const d = Uint8ClampedArray.from(base);
        const r = floodFillRegion(d, w, h, sx, sy, '#ff0000');
        assert.deepEqual(r, { changed: false, painted: 0 }, `越界起点 (${sx}, ${sy}) 应直接返回`);
        assert.deepEqual(Array.from(d), Array.from(base), '越界时一个字节都不该动');
    }
    // 尺寸非法同样静默返回（这函数在 pointerdown 同步路径上，抛出去会卡死手势）
    assert.deepEqual(floodFillRegion(base, 0, 3, 0, 0, '#ff0000'), { changed: false, painted: 0 });
    // 不传容差 == 传 DEFAULT_TOLERANCE（两块独立数据，否则第二次调用会被第一次的结果污染）
    const a = makeData(w, h);
    const b = makeData(w, h);
    assert.deepEqual(
        floodFillRegion(a, w, h, 0, 0, '#ff0000', DEFAULT_TOLERANCE),
        floodFillRegion(b, w, h, 0, 0, '#ff0000'),
        '不传容差等价于传默认值 24',
    );
    assert.deepEqual(Array.from(a), Array.from(b), '两次结果要逐字节一致');
});

test('起点已是目标色：changed=false，且不改写任何像素', () => {
    const w = 3;
    const h = 3;
    const d = makeData(w, h, () => [255, 0, 0, 255]);
    const before = Uint8ClampedArray.from(d);
    const r = floodFillRegion(d, w, h, 1, 1, '#ff0000');
    assert.deepEqual(r, { changed: false, painted: 0 });
    assert.deepEqual(Array.from(d), Array.from(before), '同一色不该产生任何写入');
});

test('alpha=0 的连通区一次整片填满，且填完 alpha 写 255', () => {
    const w = 5;
    const h = 4;
    const d = makeData(w, h);            // 全透明
    setPx(d, w, 4, 3, [0, 0, 0, 0]);     // 仍是透明
    const r = floodFillRegion(d, w, h, 2, 2, '#00ff00');
    assert.equal(r.changed, true);
    assert.equal(r.painted, w * h, '全图透明 → 一次填满全部像素（含 RGB 是垃圾值的透明像素）');
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            assert.deepEqual(getPx(d, w, x, y), [0, 255, 0, 255], `(${x},${y}) 应被填成实心绿`);
        }
    }
});

test('透明像素的 RGB 是垃圾值，也不能挡住填充（双方 alpha=0 直接算匹配）', () => {
    const w = 3;
    const h = 1;
    const d = makeData(w, h);
    setPx(d, w, 0, 0, [0, 0, 0, 0]);
    setPx(d, w, 1, 0, [200, 30, 90, 0]);  // 透明，但 RGB 是上一次绘制留下的残色
    setPx(d, w, 2, 0, [7, 7, 7, 0]);
    const r = floodFillRegion(d, w, h, 0, 0, '#0000ff');
    assert.equal(r.painted, 3, '残色不该把透明区分割成碎片');
    assert.deepEqual(getPx(d, w, 1, 0), [0, 0, 255, 255]);
});

test('容差边界：正好 24 填、25 不填（含 alpha 通道也参与比较）', () => {
    const w = 4;
    const h = 1;
    const d = makeData(w, h, () => [255, 255, 255, 255]);
    setPx(d, w, 0, 0, [0, 0, 0, 255]);        // 起点：黑
    setPx(d, w, 1, 0, [24, 24, 24, 255]);     // 差 24 → 命中
    setPx(d, w, 2, 0, [25, 25, 25, 255]);     // 差 25 → 挡住
    setPx(d, w, 3, 0, [0, 0, 0, 255]);        // 白墙之后，不可达
    const r = floodFillRegion(d, w, h, 0, 0, '#ff0000', 24);
    assert.equal(r.painted, 2, '只填起点和差 24 那一个');
    assert.deepEqual(getPx(d, w, 1, 0), [255, 0, 0, 255]);
    assert.deepEqual(getPx(d, w, 2, 0), [25, 25, 25, 255], '差 25 必须原样保留');
    assert.deepEqual(getPx(d, w, 3, 0), [0, 0, 0, 255], '白墙之后不可达');
});

test('连通性：被异色墙隔开的同色区域不填（四邻域，不穿对角）', () => {
    // 3x3，中间一列是白墙，左右两侧都是透明
    const w = 5;
    const h = 3;
    const d = makeData(w, h);
    for (let y = 0; y < h; y += 1) setPx(d, w, 2, y, [255, 255, 255, 255]);
    const r = floodFillRegion(d, w, h, 0, 1, '#ff0000');
    assert.equal(r.painted, 6, '左半边 5x3 减掉一列墙 = 6 个像素');
    assert.deepEqual(getPx(d, w, 0, 0), [255, 0, 0, 255]);
    assert.deepEqual(getPx(d, w, 3, 1), [0, 0, 0, 0], '墙右边不该被填');
});

test('单像素图：能填，且不会因为邻居越界而抛', () => {
    const d = makeData(1, 1, () => [10, 20, 30, 255]);
    const r = floodFillRegion(d, 1, 1, 0, 0, '#ffffff');
    assert.deepEqual(r, { changed: true, painted: 1 });
    assert.deepEqual(getPx(d, 1, 0, 0), [255, 255, 255, 255]);

    const same = makeData(1, 1, () => [255, 255, 255, 255]);
    assert.deepEqual(floodFillRegion(same, 1, 1, 0, 0, '#ffffff'), { changed: false, painted: 0 });
});

test('painted 计数 = 实际被改写的像素数（逐像素核对）', () => {
    const w = 6;
    const h = 5;
    const d = makeData(w, h, (x, y) => ((x + y) % 3 === 0 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
    const before = Uint8ClampedArray.from(d);
    const r = floodFillRegion(d, w, h, 0, 0, '#123456', 0);
    assert.equal(r.changed, true);
    let counted = 0;
    for (let i = 0; i < d.length; i += 4) {
        const changed = d[i] !== before[i] || d[i + 1] !== before[i + 1] || d[i + 2] !== before[i + 2] || d[i + 3] !== before[i + 3];
        if (changed) counted += 1;
    }
    assert.equal(r.painted, counted, 'painted 必须等于真正变了的像素数');
    // 容差 0：起点的黑只连通到相邻的黑，杂色区域不该被吃进来
    assert.ok(r.painted < w * h, '容差 0 时不该填满全图');
});

test('数据长度不够：静默返回，不抛不做半截写入', () => {
    const short = new Uint8ClampedArray(4 * 3);   // 声称 2x2 但只够 3 像素
    const r = floodFillRegion(short, 2, 2, 0, 0, '#ff0000');
    assert.deepEqual(r, { changed: false, painted: 0 });
    assert.deepEqual(Array.from(short), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(floodFillRegion(null, 2, 2, 0, 0, '#ff0000'), { changed: false, painted: 0 });
});
