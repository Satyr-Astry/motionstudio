// 对象面板的树形渲染（L2）与三区拖拽判定（L3）—— 只测纯逻辑。
// 这些函数从 app/editors/layers.mjs 导出，Node 能直接 import：DOM 调用全在 mount() 内。
import test from 'node:test';
import assert from 'node:assert/strict';

import { treeOrder, subtreeIds, isDescendantId, dropZone, dropVerdict, dropLineTop } from '../app/editors/layers.mjs';

const obj = (id, parentId) => ({ id, parentId, name: id });

test('treeOrder：三层嵌套按父子链深度优先，父在前、子紧随', () => {
    const all = [obj('a'), obj('b'), obj('c', 'b'), obj('d', 'c')];
    const out = treeOrder(all);
    assert.deepEqual(out.map((x) => x.layer.id), ['a', 'b', 'c', 'd']);
    assert.deepEqual(out.map((x) => x.depth), [0, 0, 1, 2]);
});

test('treeOrder：子对象在数组里排在父前面，也要拉到父后面（L2 的修复点）', () => {
    const all = [obj('c', 'b'), obj('b'), obj('a')];
    const out = treeOrder(all);
    assert.deepEqual(out.map((x) => x.layer.id), ['b', 'c', 'a']);
    assert.deepEqual(out.map((x) => x.depth), [0, 1, 0]);
});

test('treeOrder：parentId 指向不存在的对象时当根处理，不丢行', () => {
    const all = [obj('a', 'gone'), obj('b')];
    const out = treeOrder(all);
    assert.deepEqual(out.map((x) => x.layer.id), ['a', 'b']);
    assert.equal(out[0].depth, 0);
});

test('treeOrder：脏数据成环时不重复也不丢行', () => {
    const all = [obj('a', 'b'), obj('b', 'a')];
    const out = treeOrder(all);
    assert.equal(out.length, 2);
    assert.deepEqual(new Set(out.map((x) => x.layer.id)), new Set(['a', 'b']));
});

test('treeOrder：空输入返回空数组，不抛', () => {
    assert.deepEqual(treeOrder([]), []);
    assert.deepEqual(treeOrder(null), []);
});

test('subtreeIds：自身 + 全部后代，不含旁支', () => {
    const all = [obj('a'), obj('b', 'a'), obj('c', 'b'), obj('x')];
    assert.deepEqual(subtreeIds(all, 'a').sort(), ['a', 'b', 'c']);
    assert.deepEqual(subtreeIds(all, 'x'), ['x']);
    assert.deepEqual(subtreeIds(all, 'nope'), []);
});

test('isDescendantId：自身算真，旁支算假', () => {
    const all = [obj('a'), obj('b', 'a'), obj('x')];
    assert.equal(isDescendantId(all, 'a', 'a'), true);
    assert.equal(isDescendantId(all, 'b', 'a'), true);
    assert.equal(isDescendantId(all, 'x', 'a'), false);
    assert.equal(isDescendantId(all, 'a', null), false);
});

test('dropZone：上缘 25% 前 / 中间 50% 投进 / 下缘 25% 后，边界归中间', () => {
    assert.equal(dropZone(0), 'before');
    assert.equal(dropZone(0.2), 'before');
    assert.equal(dropZone(0.25), 'into');
    assert.equal(dropZone(0.5), 'into');
    assert.equal(dropZone(0.75), 'into');
    assert.equal(dropZone(0.8), 'after');
    assert.equal(dropZone(0.99), 'after');
    // 量不到几何（NaN）时按「投进去」——它是唯一不会误删层级的落点
    assert.equal(dropZone(NaN), 'into');
});

test('dropVerdict：拖到自身或自己的后代一律非法，理由可读', () => {
    const all = [obj('a'), obj('b', 'a'), obj('c', 'b')];
    assert.equal(dropVerdict(all, 'a', 'a', 'into').ok, false);
    assert.equal(dropVerdict(all, 'a', 'b', 'into').ok, false);
    assert.equal(dropVerdict(all, 'a', 'c', 'after').ok, false);
    assert.match(dropVerdict(all, 'a', 'b', 'into').reason, /子对象/);
});

test('dropVerdict：正常落点与「移到根层末尾」都允许', () => {
    const all = [obj('a'), obj('b', 'a'), obj('x')];
    assert.equal(dropVerdict(all, 'x', 'a', 'before').ok, true);
    assert.equal(dropVerdict(all, 'b', 'x', 'into').ok, true);
    assert.equal(dropVerdict(all, 'b', null, 'rootEnd').ok, true);
    // 已经在根层的对象再拖到根层末尾不算非法（只是原地不动）
    assert.equal(dropVerdict(all, 'b', 'b', 'rootEnd').ok, true);
});

test('dropVerdict：没有源对象时直接拒绝', () => {
    assert.equal(dropVerdict([], null, 'a', 'into').ok, false);
    assert.equal(dropVerdict([obj('a')], 'a', null, 'into').ok, false);
});

// 插入线坐标（用户报的「列表下滚后插入线留在滚动前的位置」）
test('dropLineTop：未滚动时就是「行边 - 列表顶 - 1」', () => {
    assert.equal(dropLineTop(100, 128, 50, 0, 'after'), 77);
    assert.equal(dropLineTop(100, 128, 50, 0, 'before'), 49);
});

test('dropLineTop：滚动后必须加上 scrollTop，否则线会留在滚动前的位置', () => {
    // 同一个行、同一个视口位置，滚了 240px 之后它在内容里就高了 240px
    assert.equal(dropLineTop(100, 128, 50, 240, 'after'), 317);
    assert.equal(dropLineTop(100, 128, 50, 240, 'before'), 289);
    // 差值恒等于 scrollTop，与行列位置无关
    const a = dropLineTop(300, 328, 50, 0, 'after');
    const b = dropLineTop(300, 328, 50, 512, 'after');
    assert.equal(b - a, 512);
});

test('dropLineTop：非法/缺失输入不产生 NaN，且不给出负数 top', () => {
    assert.equal(dropLineTop(10, 20, 50, 0, 'before'), 0);
    assert.equal(dropLineTop(NaN, 20, 50, 0, 'after'), 0);
    assert.equal(dropLineTop(100, 128, 50, undefined, 'after'), 77);
});