/**
 * 画板取色：右键取色的两条纯逻辑（像素 → 颜色、按键 → 动作）。
 *
 * 为什么单独一个文件：`app/paint/engine.mjs` 的实现要 DOM，但它把「取色判定」
 * 榨成了两个不碰 DOM 的函数。右键取色最容易回归的地方不是像素读取，而是
 * **onDown 的分支顺序**——曾经 `button === 2` 被排在平移前面，右键永远取不到色。
 * 这里把那个顺序固化成断言，谁再往回调都会红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { downIntent, pixelHex } from '../app/paint/engine.mjs';

test('pixelHex：不透明像素转成 #rrggbb', () => {
    assert.equal(pixelHex([255, 0, 0, 255]), '#ff0000');
    assert.equal(pixelHex([0, 128, 255, 255]), '#0080ff');
    assert.equal(pixelHex([17, 17, 17, 255]), '#111111');
    assert.equal(pixelHex([0, 0, 0, 255]), '#000000');
    assert.equal(pixelHex([255, 255, 255, 255]), '#ffffff');
});

test('pixelHex：alpha < 8 视为取不到（透明像素没有颜色）', () => {
    assert.equal(pixelHex([255, 0, 0, 0]), null);
    assert.equal(pixelHex([255, 0, 0, 7]), null);
    assert.equal(pixelHex([255, 0, 0, 8]), '#ff0000');   // 阈值本身算「取得到」
    assert.equal(pixelHex([9, 9, 9, 255], 256), null);   // 阈值可调
});

test('pixelHex：坏输入不抛异常，一律 null', () => {
    assert.equal(pixelHex(null), null);
    assert.equal(pixelHex(undefined), null);
    assert.equal(pixelHex([]), null);
    assert.equal(pixelHex([1, 2, 3]), null);         // 只有 RGB、没有 alpha
    assert.equal(pixelHex(new Uint8ClampedArray(0)), null);
});

test('pixelHex：小数四舍五入、超界夹到 0–255、NaN 当 0', () => {
    assert.equal(pixelHex([0.4, 127.6, 254.5, 255]), '#0080ff');
    assert.equal(pixelHex([-10, 300, 128, 255]), '#00ff80');
    assert.equal(pixelHex([NaN, 64, 64, 255]), '#004040');
    assert.equal(pixelHex(new Uint8ClampedArray([255, 128, 0, 255])), '#ff8000');
});

test('downIntent：右键永远取色——优先于平移工具、优先于空格', () => {
    assert.equal(downIntent(2, 'brush', false), 'pick');
    assert.equal(downIntent(2, 'pan', false), 'pick');
    assert.equal(downIntent(2, 'brush', true), 'pick');
    assert.equal(downIntent(2, 'select', false), 'pick');
    assert.equal(downIntent(2, 'bucket', false), 'pick');
});

test('downIntent：中键 / 空格 / 平移工具仍然是平移', () => {
    assert.equal(downIntent(1, 'brush', false), 'pan');
    assert.equal(downIntent(0, 'brush', true), 'pan');
    assert.equal(downIntent(0, 'pan', false), 'pan');
    assert.equal(downIntent(0, 'pan', true), 'pan');
});

test('downIntent：左键按工具走，绘制不受右键改动影响', () => {
    assert.equal(downIntent(0, 'brush', false), 'stroke');
    assert.equal(downIntent(0, undefined, false), 'stroke');
    assert.equal(downIntent(0, 'bucket', false), 'bucket');
    assert.equal(downIntent(0, 'picker', false), 'pick');
    assert.equal(downIntent(0, 'select', false), 'select');
});

test('downIntent：Alt+左键 = 临时取色（Klecks 的 eyedropper 同样吃 alt）', () => {
    assert.equal(downIntent(0, 'brush', false, true), 'pick');
    assert.equal(downIntent(0, 'eraser', false, true), 'pick');
    assert.equal(downIntent(0, undefined, false, true), 'pick');
    // 右键不受 alt 影响，语义不变
    assert.equal(downIntent(2, 'brush', false, true), 'pick');
});

test('downIntent：Alt 不抢平移（空格 / 平移工具 / 中键都优先）', () => {
    assert.equal(downIntent(0, 'brush', true, true), 'pan', '按住空格拖画布时顺手按 Alt 不该变成取色');
    assert.equal(downIntent(0, 'pan', false, true), 'pan');
    assert.equal(downIntent(1, 'brush', false, true), 'pan');
});
