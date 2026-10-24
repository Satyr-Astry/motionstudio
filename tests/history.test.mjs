import test from 'node:test';
import assert from 'node:assert/strict';

import { createHistory } from '../app/core/history.mjs';
import { BRUSH_PRESETS, brushById, tipDiameter, spacingPx, tipKey } from '../app/paint/brush.mjs';
import {
    point,
    dist,
    spacingPoints,
    smoothPoints,
    pressureCurve,
    strokeLength,
    bounds,
    snapPixel,
    clamp01,
} from '../app/paint/stroke.mjs';

test('history：push / undo / redo 走通，且 redo 栈被新 push 清空', () => {
    const h = createHistory();
    let v = 0;
    h.push({
        label: 'a',
        undo: () => {
            v = 0;
        },
        redo: () => {
            v = 1;
        },
    });
    assert.equal(v, 0);
    assert.equal(h.canUndo(), true);
    assert.equal(h.canRedo(), false);
    h.undo();
    assert.equal(h.canUndo(), false);
    assert.equal(h.canRedo(), true);
    h.redo();
    assert.equal(v, 1);
    assert.equal(h.size(), 1);
    h.undo();
    h.push({
        label: 'b',
        undo: () => {},
        redo: () => {},
    });
    assert.equal(h.canRedo(), false);
    assert.deepEqual(h.labels(), ['b']);
});

test('history：超过 limit 丢最旧，非法命令被拒绝', () => {
    const h = createHistory(2);
    for (const n of [1, 2, 3]) {
        h.push({ label: 'k' + n, undo() {}, redo() {} });
    }
    assert.deepEqual(h.labels(), ['k2', 'k3']);
    assert.equal(h.push(null), false);
    assert.equal(h.push({ label: 'bad' }), false);
    assert.equal(h.size(), 2);
});

test('history：subscribe / clear', () => {
    const h = createHistory();
    let n = 0;
    const off = h.subscribe(() => {
        n++;
    });
    h.push({ undo() {}, redo() {} });
    assert.equal(n, 1);
    h.undo();
    assert.equal(n, 2);
    h.clear();
    assert.equal(n, 3);
    assert.deepEqual(h.depth(), { undo: 0, redo: 0 });
    off();
    h.push({ undo() {}, redo() {} });
    assert.equal(n, 3);
});

test('brush：未知 id 退回圆笔，像素笔直径取整', () => {
    assert.equal(brushById('nope').id, 'round');
    assert.equal(brushById('pixel').id, 'pixel');
    assert.equal(tipDiameter(brushById('pixel'), 7.6), 8);
    assert.equal(tipDiameter(brushById('round'), 7.6), 7.6);
    assert.equal(tipDiameter(brushById('round'), 0), 8);
});

test('brush：间距不小于半像素，像素笔至少一格', () => {
    const pixel = brushById('pixel');
    const round = brushById('round');
    assert.ok(spacingPx(pixel, 1) >= 1);
    assert.ok(spacingPx(round, 1) >= 0.5);
    assert.ok(spacingPx(round, 40) > spacingPx(round, 10));
    assert.equal(spacingPx(pixel, 10), 10);
});

test('brush：缓存键含颜色与不透明度', () => {
    const b = brushById('round');
    assert.notEqual(tipKey(b, 8, '#000', 1), tipKey(b, 8, '#f00', 1));
    assert.notEqual(tipKey(b, 8, '#000', 1), tipKey(b, 8, '#000', 0.5));
    assert.equal(tipKey(b, 8.1, '#000', 1), tipKey(b, 8.1, '#000', 1));
});

test('stroke：clamp01 / dist / point', () => {
    assert.equal(clamp01(-3), 0);
    assert.equal(clamp01(2), 1);
    assert.equal(dist({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
    const p = point('a', undefined, 5);
    assert.deepEqual(p, { x: 0, y: 0, p: 1 });
});

test('stroke：spacingPoints 在直线上等距落点', () => {
    const { points } = spacingPoints({ x: 0, y: 0, p: 1 }, { x: 100, y: 0, p: 1 }, 10);
    assert.equal(points.length, 10);
    for (let i = 0; i < points.length; i++) {
        assert.equal(Math.round(points[i].x), (i + 1) * 10);
    }
});

test('stroke：spacingPoints 的 carry 跨事件保持连续', () => {
    const first = spacingPoints({ x: 0, y: 0, p: 1 }, { x: 6, y: 0, p: 1 }, 10);
    assert.equal(first.points.length, 0);
    assert.equal(first.carry, 4);
    const second = spacingPoints({ x: 6, y: 0, p: 1 }, { x: 12, y: 0, p: 1 }, 10, first.carry);
    assert.equal(second.points.length, 1);
    assert.equal(Math.round(second.points[0].x), 12);
});

test('stroke：零长度段不产生点', () => {
    const r = spacingPoints({ x: 5, y: 5, p: 1 }, { x: 5, y: 5, p: 1 }, 3);
    assert.deepEqual(r.points, []);
});

test('stroke：压感在段内线性插值', () => {
    const { points } = spacingPoints({ x: 0, y: 0, p: 0 }, { x: 100, y: 0, p: 1 }, 25);
    assert.equal(points.length, 4);
    assert.ok(Math.abs(points[1].p - 0.5) < 1e-9);
    assert.ok(Math.abs(points[3].p - 1) < 1e-9);
});

test('stroke：smoothPoints 只动中间点且端点保持', () => {
    const pts = [
        { x: 0, y: 0, p: 1 },
        { x: 10, y: 10, p: 1 },
        { x: 20, y: 0, p: 1 },
    ];
    const out = smoothPoints(pts, 1);
    assert.deepEqual([out[0].x, out[0].y], [0, 0]);
    assert.deepEqual([out[2].x, out[2].y], [20, 0]);
    assert.deepEqual([out[1].x, out[1].y], [10, 0]);
    const same = smoothPoints(pts, 0);
    assert.deepEqual(same, pts);
});

test('stroke：pressureCurve / strokeLength / bounds / snapPixel', () => {
    assert.equal(pressureCurve(0.5, 0), 0.5);
    assert.ok(pressureCurve(0.5, 1) < 0.5);
    assert.ok(pressureCurve(0.5, -1) > 0.5);
    assert.equal(strokeLength([{ x: 0, y: 0 }, { x: 3, y: 4 }]), 5);
    assert.equal(bounds([]), null);
    const b = bounds([{ x: 10, y: 20 }, { x: 30, y: 40 }], 2);
    assert.deepEqual([b.x, b.y, b.w, b.h], [8, 18, 25, 25]);
    assert.deepEqual(snapPixel({ x: 7, y: 13, p: 1 }, 4), { x: 6, y: 14, p: 1 });
});

test('brush 预设齐全且字段合法', () => {
    const ids = BRUSH_PRESETS.map((b) => b.id);
    for (const id of ['pixel', 'round', 'soft', 'pencil', 'eraser']) {
        assert.ok(ids.includes(id), id);
    }
    for (const b of BRUSH_PRESETS) {
        assert.ok(b.spacing > 0 && b.spacing <= 1);
        assert.ok(b.hardness >= 0 && b.hardness <= 1);
    }
    assert.equal(brushById('eraser').erase, true);
});
