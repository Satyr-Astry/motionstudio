/**
 * `app/paint/trim.mjs` 的纯函数测试。
 *
 * 这里的每个函数都不碰 canvas / DOM，所以期望值全部手算写死，
 * 不做「只断言长度对」这种会放过错位 bug 的检查。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    TRIM_ALPHA_MIN,
    TEXTURE_MAX,
    alignOffset,
    clampTextureSize,
    contentBounds,
    cropRgba,
    placeRgba,
} from '../app/paint/trim.mjs';

/** 造一张 w×h 的 RGBA，`alphaAt(x, y)` 给 alpha，颜色按坐标填一个可辨认的值。 */
function makeRgba(w, h, alphaAt) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            const i = (y * w + x) * 4;
            out[i] = x * 10;
            out[i + 1] = y * 10;
            out[i + 2] = 7;
            out[i + 3] = alphaAt ? alphaAt(x, y) : 255;
        }
    }
    return out;
}

function px(rgba, w, x, y) {
    const i = (y * w + x) * 4;
    return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
}

test('口径常量：alpha 下限 8、纹理上限 4096', () => {
    assert.equal(TRIM_ALPHA_MIN, 8);
    assert.equal(TEXTURE_MAX, 4096);
});

test('contentBounds：alpha 7 不算内容、8 与 9 都算（阈值是「大于等于」）', () => {
    const seven = makeRgba(4, 4, () => 0);
    seven[(1 * 4 + 1) * 4 + 3] = 7;
    assert.equal(contentBounds(seven, 4, 4), null, 'alpha=7 < 8，不该算内容');

    const eight = makeRgba(4, 4, () => 0);
    eight[(1 * 4 + 1) * 4 + 3] = 8;
    assert.deepEqual(contentBounds(eight, 4, 4), { x: 1, y: 1, w: 1, h: 1 }, 'alpha=8 刚好算内容');

    const nine = makeRgba(4, 4, () => 0);
    nine[(2 * 4 + 2) * 4 + 3] = 9;
    assert.deepEqual(contentBounds(nine, 4, 4), { x: 2, y: 2, w: 1, h: 1 });
});

test('contentBounds：全透明返回 null，不给 0 尺寸盒子', () => {
    assert.equal(contentBounds(makeRgba(6, 5, () => 0), 6, 5), null);
});

test('contentBounds：单像素命中给出 1×1', () => {
    const img = makeRgba(6, 5, () => 0);
    img[(3 * 6 + 4) * 4 + 3] = 255;
    assert.deepEqual(contentBounds(img, 6, 5), { x: 4, y: 3, w: 1, h: 1 });
});

test('contentBounds：四周留白时收紧到内容，整幅不透明时不回退', () => {
    // 10×8，内容在 (2,3)-(5,4) 这块 4×2
    const img = makeRgba(10, 8, (x, y) => (x >= 2 && x <= 5 && y >= 3 && y <= 4 ? 255 : 0));
    assert.deepEqual(contentBounds(img, 10, 8), { x: 2, y: 3, w: 4, h: 2 });
    // 整幅不透明 → 整幅
    assert.deepEqual(contentBounds(makeRgba(10, 8), 10, 8), { x: 0, y: 0, w: 10, h: 8 });
});

test('contentBounds：坏入参一律 null（不抛）', () => {
    assert.equal(contentBounds(null, 4, 4), null);
    assert.equal(contentBounds(new Uint8ClampedArray(4), 0, 4), null);
    assert.equal(contentBounds(new Uint8ClampedArray(4), 4, -1), null);
    assert.equal(contentBounds(new Uint8ClampedArray(8), 4, 4), null, '缓冲不够长也要拒绝');
    assert.equal(contentBounds(new Uint8ClampedArray(64), 4, 4, NaN), null, 'NaN 阈值落回 8，仍全透明');
});

test('cropRgba：逐像素搬对位置（不是只长度对）', () => {
    const img = makeRgba(6, 5);
    const cut = cropRgba(img, 6, 5, { x: 1, y: 2, w: 3, h: 2 });
    assert.equal(cut.length, 3 * 2 * 4);
    // 新图 (0,0) 应等于旧图 (1,2)
    assert.deepEqual(px(cut, 3, 0, 0), px(img, 6, 1, 2));
    assert.deepEqual(px(cut, 3, 2, 1), px(img, 6, 3, 3));
});

test('cropRgba：盒子越界部分补透明', () => {
    const img = makeRgba(4, 4, () => 255);
    const cut = cropRgba(img, 4, 4, { x: 2, y: 2, w: 4, h: 4 });
    assert.equal(cut.length, 4 * 4 * 4);
    assert.equal(px(cut, 4, 0, 0)[3], 255, '界内照旧');
    assert.equal(px(cut, 4, 3, 3)[3], 0, '界外补 0');
});

test('cropRgba：坏入参返回全零缓冲而不是抛', () => {
    assert.equal(cropRgba(null, 4, 4, { x: 0, y: 0, w: 2, h: 2 }).length, 2 * 2 * 4);
    assert.equal(cropRgba(new Uint8ClampedArray(64), 4, 4, null).length, 0);
});

test('placeRgba：内容按偏移落位，越界被裁掉', () => {
    const src = makeRgba(2, 2);
    const placed = placeRgba(src, 2, 2, 4, 4, 1, 1);
    assert.equal(placed.length, 4 * 4 * 4);
    assert.equal(px(placed, 4, 0, 0)[3], 0, '留白是透明的');
    assert.deepEqual(px(placed, 4, 1, 1), px(src, 2, 0, 0));
    assert.deepEqual(px(placed, 4, 2, 2), px(src, 2, 1, 1));

    // 负偏移：左上一半被裁掉
    const clipped = placeRgba(src, 2, 2, 2, 2, -1, 0);
    assert.equal(px(clipped, 2, 0, 0)[3], 255);
    assert.deepEqual(px(clipped, 2, 0, 0), px(src, 2, 1, 0), '新图 (0,0) 来自旧图 (1,0)');
});

test('placeRgba：新画布比旧的小时只保留重叠部分', () => {
    const src = makeRgba(4, 4);
    const small = placeRgba(src, 4, 4, 2, 2, 0, 0);
    assert.equal(small.length, 2 * 2 * 4);
    assert.deepEqual(px(small, 2, 1, 1), px(src, 4, 1, 1));
});

test('alignOffset：九宫格数值表（10×8 → 20×16）', () => {
    const dw = 10;
    const dh = 8;
    const cases = [
        ['nw', 0, 0],
        ['n', 5, 0],
        ['ne', 10, 0],
        ['w', 0, 4],
        ['c', 5, 4],
        ['e', 10, 4],
        ['sw', 0, 8],
        ['s', 5, 8],
        ['se', 10, 8],
    ];
    for (const [align, ox, oy] of cases) {
        assert.deepEqual(alignOffset(dw, dh, 20, 16, align), { ox, oy }, align);
    }
    assert.deepEqual(alignOffset(dw, dh, 20, 16), { ox: 5, oy: 4 }, '缺省居中');
    assert.deepEqual(alignOffset(dw, dh, 20, 16, '??'), { ox: 5, oy: 4 }, '不认识的档位也居中');
});

test('alignOffset：缩小时偏移为负', () => {
    assert.deepEqual(alignOffset(20, 16, 10, 8, 'c'), { ox: -5, oy: -4 });
    assert.deepEqual(alignOffset(20, 16, 10, 8, 'nw'), { ox: 0, oy: 0 });
    assert.deepEqual(alignOffset(20, 16, 10, 8, 'se'), { ox: -10, oy: -8 });
});

test('clampTextureSize：1 与 4096 收、0 与 4097 与 NaN 拒', () => {
    assert.equal(clampTextureSize(1), 1);
    assert.equal(clampTextureSize(4096), 4096);
    assert.equal(clampTextureSize(0), null);
    assert.equal(clampTextureSize(4097), null);
    assert.equal(clampTextureSize(NaN), null);
    assert.equal(clampTextureSize(Infinity), null);
    assert.equal(clampTextureSize(null), null);
    assert.equal(clampTextureSize(''), null);
    assert.equal(clampTextureSize('640'), 640, '表单值常是字符串');
    assert.equal(clampTextureSize(639.6), 640, '四舍五入');
});
