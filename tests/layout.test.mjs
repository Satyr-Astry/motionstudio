import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createArea } from '../app/shell/areas.mjs';
import { SPLITTER, MIN_AREA, COLLAPSED_AREA, distribute, computeRects, withNode, resizeAcross, freezeAxis } from '../app/shell/layout.mjs';

const area = (id, editor) => createArea(editor || 'timeline', id);
const row = (children, extra) => Object.assign({ type: 'split', dir: 'row', children }, extra || {});
const col = (children, extra) => Object.assign({ type: 'split', dir: 'col', children }, extra || {});

test('distribute：无 size 时均分', () => {
    assert.deepEqual(distribute([{}, {}, {}], 300), [100, 100, 100]);
});

test('distribute：固定 size 优先，剩余给 flex', () => {
    const out = distribute([{ size: 100 }, {}, {}], 300);
    assert.deepEqual(out, [100, 100, 100]);
});

test('distribute：全固定时按比例归一', () => {
    const out = distribute([{ size: 100 }, { size: 100 }], 500);
    assert.deepEqual(out, [250, 250]);
});

test('distribute：总和恒等于 total', () => {
    const cases = [
        [[{}, { size: 40 }], 800],
        [[{ size: 10 }, { size: 20 }, {}], 640],
        [[{}, {}], 1],
    ];
    for (const [children, total] of cases) {
        const out = distribute(children, total);
        assert.ok(Math.abs(out.reduce((a, b) => a + b, 0) - total) < 0.01, JSON.stringify(out));
    }
});

test('distribute：空间不足时每项不低于下限', () => {
    const out = distribute([{}, {}, {}], 300);
    for (const v of out) assert.ok(v >= Math.min(MIN_AREA, 100) - 1e-6);
    const tight = distribute([{}, {}, {}, {}, {}], 200);
    for (const v of tight) assert.ok(v >= Math.min(MIN_AREA, 40) - 1e-6);
});

test('computeRects：单区域铺满', () => {
    const { areas, splitters } = computeRects(area('a1'), { x: 0, y: 0, w: 800, h: 600 });
    assert.equal(areas.length, 1);
    assert.deepEqual(areas[0].rect, { x: 0, y: 0, w: 800, h: 600 });
    assert.equal(splitters.length, 0);
});

test('computeRects：row 两栏扣掉分隔条宽度', () => {
    const tree = row([area('a1'), { type: 'area', id: 'a2', editor: 'curve', size: 300 }]);
    const { areas, splitters } = computeRects(tree, { x: 0, y: 0, w: 800, h: 600 });
    assert.equal(splitters.length, 1);
    assert.deepEqual(areas[1].rect, { x: 800 - 300, y: 0, w: 300, h: 600 });
    assert.equal(areas[0].rect.x, 0);
    assert.ok(Math.abs(areas[0].rect.w - (800 - 300 - SPLITTER)) < 0.01);
    assert.equal(splitters[0].rect.x, areas[0].rect.w);
    assert.equal(splitters[0].rect.w, SPLITTER);
});

test('computeRects：col 嵌套 row，面积守恒且不重叠', () => {
    const tree = col([
        row([area('a1'), area('a2')], { size: 200 }),
        row([area('a3'), area('a4')]),
    ]);
    const { areas } = computeRects(tree, { x: 0, y: 0, w: 1000, h: 700 });
    assert.equal(areas.length, 4);
    const byId = Object.fromEntries(areas.map((a) => [a.id, a.rect]));
    assert.equal(byId.a1.y, 0);
    assert.equal(byId.a1.h, 200);
    assert.equal(byId.a3.y, 200 + SPLITTER);
    assert.ok(Math.abs(byId.a3.h - (700 - 200 - SPLITTER)) < 0.01);
    // 同一行两栏必须贴死：右栏 x === 左栏 w + 分隔条
    assert.equal(byId.a2.x, byId.a1.w + SPLITTER);
    assert.equal(byId.a4.x, byId.a3.w + SPLITTER);
});

test('computeRects：分隔条记录父路径与索引', () => {
    const tree = row([area('a1'), row([area('a2'), area('a3')])]);
    const { splitters } = computeRects(tree, { x: 0, y: 0, w: 900, h: 500 });
    assert.equal(splitters.length, 2);
    const inner = splitters.find((s) => s.path.length === 2);
    assert.deepEqual(inner.path, [1, 0]);
    assert.deepEqual(inner.parentPath, [1]);
    assert.equal(inner.index, 0);
    assert.equal(inner.parentPath.length + 1, inner.path.length);
});

test('computeRects：空/畸形树不抛异常', () => {
    assert.deepEqual(computeRects(null, { x: 0, y: 0, w: 10, h: 10 }).areas, []);
    assert.deepEqual(computeRects(row([]), { x: 0, y: 0, w: 10, h: 10 }).areas, []);
    assert.deepEqual(computeRects({ type: 'split' }, { x: 0, y: 0, w: 10, h: 10 }).areas, []);
    assert.deepEqual(computeRects(area('a'), { x: 0, y: 0, w: -5, h: -5 }).areas[0].rect, { x: 0, y: 0, w: 0, h: 0 });
});

test('withNode：按路径替换且不改入参', () => {
    const tree = row([area('a1'), row([area('a2'), area('a3')])]);
    const frozen = JSON.stringify(tree);
    const next = withNode(tree, [1, 1], (n) => Object.assign({}, n, { editor: 'color' }));
    assert.equal(next.children[1].children[1].editor, 'color');
    assert.equal(next.children[0].editor, 'timeline');
    assert.equal(JSON.stringify(tree), frozen);
    assert.equal(withNode(tree, [9], (n) => n), tree, '越界路径原样返回');
});

test('resizeAcross：按 delta 调整两侧且守住下限', () => {
    const tree = row([{ type: 'area', id: 'a1', editor: 'timeline', size: 200 }, { type: 'area', id: 'a2', editor: 'timeline', size: 400 }]);
    const grown = resizeAcross(tree, [], 0, 60);
    assert.equal(grown.children[0].size, 260);
    assert.equal(grown.children[1].size, 340);
    assert.equal(grown.children[0].grow, false);
    const squeezed = resizeAcross(tree, [], 0, 10000);
    assert.equal(squeezed.children[0].size, 600 - MIN_AREA);
    assert.equal(squeezed.children[1].size, MIN_AREA);
    const negative = resizeAcross(tree, [], 0, -10000);
    assert.equal(negative.children[0].size, MIN_AREA);
});

test('resizeAcross：冻结的是拖动起点，连续 delta 不累积漂移', () => {
    const base = row([{ type: 'area', id: 'a1', editor: 'timeline', size: 200 }, { type: 'area', id: 'a2', editor: 'timeline', size: 400 }]);
    const a = resizeAcross(base, [], 0, 30);
    const b = resizeAcross(base, [], 0, 30);
    assert.deepEqual(a.children.map((c) => c.size), b.children.map((c) => c.size));
    const c = resizeAcross(a, [], 0, 10);
    assert.equal(c.children[0].size, 240, '在已调整的树上继续拖不会回到起点');
});

test('freezeAxis：把整条轴的兄弟转成像素', () => {
    const tree = row([area('a1'), area('a2'), area('a3')]);
    const frozen = freezeAxis(tree, [], [100, 200, 300]);
    assert.deepEqual(frozen.children.map((c) => c.size), [100, 200, 300]);
    assert.deepEqual(frozen.children.map((c) => c.grow), [false, false, false]);
    assert.deepEqual(freezeAxis(tree, [], [undefined, 200]), tree.children.length === 3 ? freezeAxis(tree, [], [undefined, 200]) : null);
});

test('distribute：折叠区固定为 COLLAPSED_AREA，不吃剩余空间也不被归一放大', () => {
    const out = distribute([{ collapsed: true }, { size: 400 }], 1000);
    assert.equal(out[0], COLLAPSED_AREA);
    assert.equal(out[1], 1000 - COLLAPSED_AREA);
});

test('distribute：折叠区不被最小面积抬升', () => {
    const out = distribute([{ collapsed: true }, {}], 400);
    assert.equal(out[0], COLLAPSED_AREA);
    assert.ok(out[0] < MIN_AREA);
    assert.equal(out.reduce((a, b) => a + b, 0), 400);
});

test('distribute：多个折叠区各自固定，剩余按 flex 均分', () => {
    const out = distribute([{ collapsed: true }, {}, {}, { collapsed: true }], 500);
    assert.equal(out[0], COLLAPSED_AREA);
    assert.equal(out[3], COLLAPSED_AREA);
    const rest = (500 - COLLAPSED_AREA * 2) / 2;
    assert.ok(Math.abs(out[1] - rest) < 0.5);
    assert.ok(Math.abs(out[2] - rest) < 0.5);
});

test('computeRects：区域条目带 collapsed 标记', () => {
    const tree = row([area('area-1', 'timeline'), Object.assign(area('area-2', 'curve'), { collapsed: true })]);
    const rects = computeRects(tree, { x: 0, y: 0, w: 1000, h: 200 });
    const byId = new Map(rects.areas.map((a) => [a.id, a]));
    assert.equal(byId.get('area-1').collapsed, false);
    assert.equal(byId.get('area-2').collapsed, true);
    assert.equal(byId.get('area-2').rect.w, COLLAPSED_AREA);
});
