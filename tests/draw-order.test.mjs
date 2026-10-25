// 叠放顺序（app/core/draw-order.mjs）与它在文档写出点的接线。
// 锁四件事：`drawOrder[0]` 是最上层；缺字段时派生结果与旧行为一致（老存档零迁移）；
// 归一化等幂且会丢掉脏 id；新建/删除/复制/合并都不再让「数组顺序」偷偷决定画序。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDoc, addObject, removeObject, objectsOf } from '../app/core/doc-model.mjs';
import {
    normalizeDrawOrder, drawOrderOf, orderIndex, moveInOrder, insertInOrder, removeFromOrder,
} from '../app/core/draw-order.mjs';

function docOf(...names) {
    return createDoc({ objects: names.map((n) => ({ name: n })) });
}

test('缺 drawOrder 时按 objects 顺序派生，且不写回 doc', () => {
    const doc = docOf('a', 'b', 'c');
    delete doc.drawOrder;
    assert.deepEqual(drawOrderOf(doc), objectsOf(doc).map((o) => o.id));
    assert.equal('drawOrder' in doc, false, 'drawOrderOf 不许改入参');
});

test('createDoc 会写 drawOrder，且与 objects 顺序一致（0 = 最上层）', () => {
    const doc = docOf('a', 'b');
    assert.deepEqual(doc.drawOrder, objectsOf(doc).map((o) => o.id));
    assert.equal(orderIndex(doc, objectsOf(doc)[0].id), 0);
    assert.equal(orderIndex(doc, '不存在'), -1);
});

test('normalizeDrawOrder：丢未知 id、丢重复、补缺失到末尾', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    assert.deepEqual(normalizeDrawOrder(list, ['c', 'zzz', 'c', 'a']), ['c', 'a', 'b']);
    assert.deepEqual(normalizeDrawOrder(list, null), ['a', 'b', 'c']);
    assert.deepEqual(normalizeDrawOrder(list, 'nonsense'), ['a', 'b', 'c']);
    assert.deepEqual(normalizeDrawOrder([], ['a']), []);
});

test('normalizeDrawOrder 等幂', () => {
    const list = [{ id: 'a' }, { id: 'b' }];
    const once = normalizeDrawOrder(list, ['b', 'q', 'a', 'a']);
    assert.deepEqual(normalizeDrawOrder(list, once), once);
});

test('moveInOrder / insertInOrder / removeFromOrder 都不改入参', () => {
    const order = ['a', 'b', 'c'];
    assert.deepEqual(moveInOrder(order, 'a', 2), ['b', 'c', 'a']);
    assert.deepEqual(moveInOrder(order, 'a', 99), ['b', 'c', 'a'], '越界钳到末尾');
    assert.deepEqual(moveInOrder(order, 'zz', 1), ['a', 'b', 'c'], '找不到原样返回');
    assert.deepEqual(insertInOrder(order, 'd', 1), ['a', 'd', 'b', 'c']);
    assert.deepEqual(insertInOrder(order, 'b', 0), ['b', 'a', 'c'], '已在表里则先摘再插');
    assert.deepEqual(removeFromOrder(order, 'b'), ['a', 'c']);
    assert.deepEqual(order, ['a', 'b', 'c']);
});

test('addObject 把新对象放最上层；removeObject 从叠放里摘掉', () => {
    const doc = addObject(docOf('a'), { name: '新' });
    const ids = objectsOf(doc).map((o) => o.id);
    assert.deepEqual(doc.drawOrder, [ids[ids.length - 1]].concat(ids.slice(0, -1)));

    const first = doc.drawOrder[0];
    const pruned = removeObject(doc, first);
    assert.equal(pruned.drawOrder.includes(first), false);
    // 剩下的顺序不变
    assert.deepEqual(pruned.drawOrder, doc.drawOrder.slice(1));
});

test('画序与数组顺序解耦：打乱数组不影响 drawOrder，反之亦然', () => {
    const doc = docOf('a', 'b', 'c');
    const [x, y, z] = objectsOf(doc).map((o) => o.id);
    const shuffled = { ...doc, objects: objectsOf(doc).slice().reverse() };
    assert.deepEqual(drawOrderOf(shuffled), [x, y, z], '数组反了，叠放不变');
    const reordered = { ...doc, drawOrder: [z, y, x] };
    assert.deepEqual(drawOrderOf(reordered), [z, y, x]);
    assert.deepEqual(objectsOf(reordered).map((o) => o.id), [x, y, z], '叠放变了，数组不变');
});

test('删除父对象后，孩子的 parentId 被清成 undefined（升根），叠放表仍完整', () => {
    const doc = docOf('父', '子');
    const [p, c] = objectsOf(doc);
    const withParent = { ...doc, objects: [{ ...p }, { ...c, parentId: p.id }] };
    const next = removeObject(withParent, p.id);
    assert.deepEqual(objectsOf(next).map((o) => o.id), [c.id]);
    assert.equal(objectsOf(next)[0].parentId, undefined);
    assert.deepEqual(next.drawOrder, [c.id]);
});
