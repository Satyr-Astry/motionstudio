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

// v11：叠放列表改成两区（上/下），「投进去」这一区下线 —— 改层级归父子面板
test('dropZone：上半插到之上、下半插到之下，量不到几何时当作下半', () => {
    assert.equal(dropZone(0), 'above');
    assert.equal(dropZone(0.2), 'above');
    assert.equal(dropZone(0.49), 'above');
    assert.equal(dropZone(0.5), 'below');
    assert.equal(dropZone(0.8), 'below');
    assert.equal(dropZone(0.99), 'below');
    // 越界钳到 0–1，NaND 当作下半（插到它下面是最保守的落点）
    assert.equal(dropZone(-2), 'above');
    assert.equal(dropZone(9), 'below');
    assert.equal(dropZone(NaN), 'below');
});

test('dropVerdict：叠放只重排，只拒绝「拖到自身」', () => {
    const all = [obj('a'), obj('b', 'a'), obj('c', 'b')];
    assert.equal(dropVerdict(all, 'a', 'a').ok, false);
    assert.match(dropVerdict(all, 'a', 'a').reason, /自身/);
    // 拖到自己的后代在叠放里是合法的（只换图层顺序，不动 parentId）
    assert.equal(dropVerdict(all, 'a', 'c').ok, true);
    assert.equal(dropVerdict(all, 'c', 'a').ok, true);
    assert.equal(dropVerdict(all, null, 'a').ok, false);
    assert.equal(dropVerdict(all, 'a', null).ok, false);
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
