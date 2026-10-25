// 层级 × 叠放的分工（v11）：`moveSubtreeDoc` 改 parentId 的同时必须把整块子树搬进 drawOrder，
// 否则「在父子面板拖到 A 下面」在按 drawOrder 排的列表里看起来像没反应。
// 这一组测试钉的就是「一次 moveSubtreeDoc 之后，objects 与 drawOrder 同时正确」。

import test from 'node:test';
import assert from 'node:assert/strict';

import { moveSubtreeDoc } from '../app/core/timegraph.mjs';
import { drawOrderOf, normalizeDrawOrder } from '../app/core/draw-order.mjs';
import { reorderIndex, treeZone } from '../app/core/layer-order.mjs';
import { makeObject, createDoc } from '../app/core/doc-model.mjs';

/** 造 doc：ids 的顺序同时作为初始 drawOrder（[0] = 最上层）。 */
function docOf(...ids) {
    const objects = ids.map((id) => makeObject({ id, name: id }));
    const base = createDoc({ width: 100, height: 100 });
    return Object.assign({}, base, { objects, drawOrder: ids.slice() });
}

/** ids 在 drawOrder 里的先后，便于断言顺序。 */
const order = (doc) => drawOrderOf(doc).join(',');

test('before：子树块插到目标之上，父子与叠放一起变', () => {
    const doc = docOf('a', 'b', 'c');
    const res = moveSubtreeDoc(doc, 'c', 'before', 'a');
    assert.equal(res.ok, true);
    assert.equal(order(res.doc), 'c,a,b');
    // objects 数组同样把 c 放到最前（父在子前、子树连续）
    assert.equal(res.doc.objects.map((o) => o.id).join(','), 'c,a,b');
});

test('after：子树块落到目标（含其子树）之下', () => {
    const doc = docOf('a', 'b', 'c', 'd');
    const withKid = moveSubtreeDoc(doc, 'b', 'into', 'a').doc;
    // a 的子树现在是 a,b；把 d 插到 a 之后 → 必须落在整块子树的后面
    const res = moveSubtreeDoc(withKid, 'd', 'after', 'a');
    assert.equal(res.ok, true);
    assert.equal(order(res.doc), 'a,b,d,c');
});

test('into：成为目标的最后一个子对象，且排在目标整棵子树之后', () => {
    const doc = docOf('a', 'b', 'c');
    const res = moveSubtreeDoc(doc, 'c', 'into', 'a');
    assert.equal(res.ok, true);
    assert.equal(res.doc.objects.find((o) => o.id === 'c').parentId, 'a');
    assert.equal(order(res.doc), 'a,c,b');
});

test('rootEnd：脱父并排到最底（叠放末尾）', () => {
    const doc = docOf('a', 'b', 'c');
    const nested = moveSubtreeDoc(doc, 'c', 'into', 'a').doc;
    assert.equal(order(nested), 'a,c,b');
    const res = moveSubtreeDoc(nested, 'c', 'rootEnd', null);
    assert.equal(res.ok, true);
    // 脱父之后 parentId 归一成 null（模型允许 undefined，但 rootEnd 这条路径统一写 null）
    assert.equal(res.doc.objects.find((o) => o.id === 'c').parentId, null);
    assert.equal(order(res.doc), 'a,b,c');
});

test('移动带子对象的父级时，整棵子树在 drawOrder 里保持连续', () => {
    const doc = docOf('p', 'x', 'y');
    const withKids = moveSubtreeDoc(moveSubtreeDoc(doc, 'x', 'into', 'p').doc, 'y', 'into', 'p').doc;
    assert.equal(order(withKids), 'p,x,y');
    const res = moveSubtreeDoc(withKids, 'p', 'rootEnd', null);
    assert.equal(res.ok, true);
    // p、x、y 三个必须挨在一起，不能被别的对象插入
    assert.equal(order(res.doc), 'p,x,y');
    const idx = res.doc.drawOrder;
    assert.equal(idx.indexOf('y') - idx.indexOf('p'), 2);
});

test('drawOrder 集合始终与 objects 相等（移动不会丢 id 或多出 id）', () => {
    let doc = docOf('a', 'b', 'c', 'd');
    doc = moveSubtreeDoc(doc, 'b', 'into', 'a').doc;
    doc = moveSubtreeDoc(doc, 'd', 'before', 'a').doc;
    const ids = doc.objects.map((o) => o.id).sort().join(',');
    const ord = drawOrderOf(doc).slice().sort().join(',');
    assert.equal(ord, ids);
});

test('normalizeDrawOrder 幂等：已正确的顺序再归一化不变', () => {
    const ids = ['a', 'b', 'c'];
    assert.deepEqual(normalizeDrawOrder(ids.map((id) => ({ id })), ['a', 'b', 'c']), ['a', 'b', 'c']);
});

test('treeZone：上缘 25% before / 中间 50% into / 下缘 25% after', () => {
    assert.equal(treeZone(0), 'before');
    assert.equal(treeZone(0.24), 'before');
    assert.equal(treeZone(0.25), 'into');
    assert.equal(treeZone(0.5), 'into');
    assert.equal(treeZone(0.75), 'into');
    assert.equal(treeZone(0.76), 'after');
    assert.equal(treeZone(1), 'after');
    assert.equal(treeZone(NaN), 'into');
});

test('reorderIndex：给出「移除自身之后」的下标，向下拖不会差一位', () => {
    const ord = ['a', 'b', 'c'];
    // 把 a 拖到 b 上面 → a 原位（0）；把 a 拖到 b 下面 → 1（移除 a 后 b 在 0，插到 1）
    assert.equal(reorderIndex(ord, 'a', 'b', 'above'), 0);
    assert.equal(reorderIndex(ord, 'a', 'b', 'below'), 1);
    // 把 c 拖到 a 上面 → 0
    assert.equal(reorderIndex(ord, 'c', 'a', 'above'), 0);
    // 拖到自身 / 找不到目标 → -1
    assert.equal(reorderIndex(ord, 'a', 'a', 'above'), -1);
    assert.equal(reorderIndex(ord, 'a', 'zz', 'below'), -1);
    assert.equal(reorderIndex([], 'a', 'b', 'above'), -1);
});
