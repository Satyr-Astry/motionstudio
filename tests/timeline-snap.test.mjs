// 时间轴的吸附（磁铁）：snapFrame / snapTime 是纯函数，缩放与拖动都靠它们对齐整帧。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { snapFrame, snapTime, snapGrid, SNAP_GRID } from '../app/editors/timeline-geo.mjs';

const doc = (fps) => ({ width: 100, height: 100, fps, duration: 3, objects: [] });

test('snapFrame：吸到最近的整帧（12 fps = 1/12 秒一格）', () => {
    const d = doc(12);
    assert.equal(snapFrame(d, 0), 0);
    assert.equal(snapFrame(d, 0.041), 0); // 0.041*12 = 0.492，更靠近第 0 帧
    assert.equal(snapFrame(d, 0.06), 1 / 12);
    assert.equal(snapFrame(d, 0.5), 6 / 12);
    assert.ok(Math.abs(snapFrame(d, 0.7333) - 9 / 12) < 1e-12);
});

test('snapFrame：24 fps 时格子是一半宽', () => {
    const d = doc(24);
    assert.ok(Math.abs(snapFrame(d, 0.03) - 1 / 24) < 1e-12);
    assert.ok(Math.abs(snapFrame(d, 0.02) - 0) < 1e-12);
});

test('snapFrame：fps 缺失/非法时退回默认 12 fps（fpsOf 的既有语义）', () => {
    // fpsOf() 对非法 fps 一律给 DEFAULT_FPS，吸附跟着它走，不会把时间吞成 0
    for (const bad of [{}, { fps: 0 }, { fps: NaN }]) {
        assert.equal(snapFrame(bad, 0.317), Math.round(0.317 * 12) / 12);
    }
});

test('snapFrame：非数字输入归 0', () => {
    const d = doc(12);
    assert.equal(snapFrame(d, NaN), 0);
    assert.equal(snapFrame(d, undefined), 0);
    assert.equal(snapFrame(d, 'abc'), 0);
});

test('snapTime：关掉磁铁时原样返回，但仍把负数夹到 0', () => {
    const d = doc(12);
    assert.equal(snapTime(d, 0.3123, false), 0.3123);
    assert.equal(snapTime(d, -2, false), 0);
    assert.equal(snapTime(d, -2, true), 0);
});

test('snapTime：开着时等价于 snapFrame', () => {
    const d = doc(12);
    assert.equal(snapTime(d, 0.3123, true), snapFrame(d, 0.3123));
    assert.ok(Math.abs(snapTime(d, 0.3123, true) - 4 / 12) < 1e-12);
});

test('磁铁与 Shift 的网格吸附互不干扰：snapGrid 仍是 0.1 s', () => {
    assert.equal(SNAP_GRID, 0.1);
    assert.ok(Math.abs(snapGrid(0.317) - 0.3) < 1e-12);
    assert.ok(Math.abs(snapFrame(doc(12), 0.317) - 0.3333333333333333) < 1e-12);
});
