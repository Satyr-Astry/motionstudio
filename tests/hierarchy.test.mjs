// 层级（app/core/hierarchy.mjs）—— 只回答「跟谁动」，不碰叠放。
// 锁四件事：树形展示序是深度优先且同级按 drawOrder；脏父子（自指/父不存在/成环）被修成根；
// normalizeParents 等幂且不改入参；parentChainOf/collectSubtree/isDescendant 与既有实现同源。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDoc, objectsOf } from '../app/core/doc-model.mjs';
import {
    treeOrder, normalizeParents, parentChainOf, collectSubtree, isDescendant,
} from '../app/core/hierarchy.mjs';

/** 造 doc：第一个参数是「名字:父名字」或纯名字 */
function build(...specs) {
    const byName = new Map();
    const objects = specs.map((spec) => {
        const [name, parentName] = String(spec).split(':');
        const o = { name, parentId: null };
        byName.set(name, o);
        if (parentName) o.__parent = parentName;
        return o;
    });
    for (const o of objects) {
        if (o.__parent) o.parentId = byName.get(o.__parent).id || undefined;
        delete o.__parent;
    }
    return { doc: createDoc({ objects: objects.map(({ name }) => ({ name })) }), byName };
}

test('treeOrder：深度优先，子对象紧跟父对象，depth 逐级 +1', () => {
    const doc = createDoc({ objects: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] });
    const [a, b, c] = objectsOf(doc);
    const nested = {
        ...doc,
        objects: [
            { ...a, parentId: undefined },
            { ...b, parentId: a.id },
            { ...c, parentId: b.id },
        ],
    };
    const rows = treeOrder(nested);
    assert.deepEqual(rows.map((r) => r.obj.name), ['a', 'b', 'c']);
    assert.deepEqual(rows.map((r) => r.depth), [0, 1, 2]);
    assert.deepEqual(rows.map((r) => r.parentId), [null, a.id, b.id]);
});

test('treeOrder：同级先后按 drawOrder，而不是数组顺序', () => {
    const doc = createDoc({ objects: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] });
    const [a, b, c] = objectsOf(doc);
    const reordered = { ...doc, drawOrder: [c.id, a.id, b.id] };
    assert.deepEqual(treeOrder(reordered).map((r) => r.obj.name), ['c', 'a', 'b']);
});

test('treeOrder：孤儿（父不在文档里）按根处理，成环的也不会死循环', () => {
    const doc = createDoc({ objects: [{ name: 'a' }, { name: 'b' }] });
    const [a, b] = objectsOf(doc);
    const orphan = { ...doc, objects: [{ ...a, parentId: 'gone' }, { ...b, parentId: undefined }] };
    assert.deepEqual(treeOrder(orphan).map((r) => r.obj.name).sort(), ['a', 'b']);

    // 互相为父的环：DFS 会先走 a → b → (a 已访问) 停下，两个都出现在结果里
    const ring = {
        ...doc,
        objects: [{ ...a, parentId: b.id }, { ...b, parentId: a.id }],
    };
    const rows = treeOrder(ring);
    assert.equal(rows.length, 2);
    assert.deepEqual(new Set(rows.map((r) => r.obj.name)), new Set(['a', 'b']));
});

test('normalizeParents：自指、父不存在、成环 → 升根；干净的输入原样返回（同一引用）', () => {
    const clean = objectsOf(createDoc({ objects: [{ name: 'a' }, { name: 'b' }] }));
    assert.equal(normalizeParents(clean), clean, '干净输入应返回原数组引用');

    const doc = createDoc({ objects: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] });
    const [a, b, c] = objectsOf(doc);
    const selfRef = normalizeParents([{ ...a, parentId: a.id }, b, c]);
    assert.equal(selfRef[0].parentId, undefined);

    const dangling = normalizeParents([{ ...a, parentId: 'nope' }, b, c]);
    assert.equal(dangling[0].parentId, undefined);

    const ring = normalizeParents([{ ...a, parentId: b.id }, { ...b, parentId: a.id }, c]);
    assert.equal(ring.some((o) => o.parentId === a.id || o.parentId === b.id), false);
});

test('normalizeParents 等幂', () => {
    const doc = createDoc({ objects: [{ name: 'a' }, { name: 'b' }] });
    const [a, b] = objectsOf(doc);
    const dirty = [{ ...a, parentId: b.id }, { ...b, parentId: a.id }];
    const once = normalizeParents(dirty);
    const twice = normalizeParents(once);
    assert.deepEqual(twice.map((o) => o.parentId), once.map((o) => o.parentId));
    assert.equal(twice, once, '第二次不应再产生新数组');
});

test('parentChainOf / collectSubtree / isDescendant 与既有实现一致', () => {
    const doc = createDoc({ objects: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] });
    const [a, b, c] = objectsOf(doc);
    const nested = {
        ...doc,
        objects: [
            { ...a, parentId: undefined },
            { ...b, parentId: a.id },
            { ...c, parentId: b.id },
        ],
    };
    const chain = parentChainOf(nested, objectsOf(nested)[2]);
    assert.deepEqual(chain.map((o) => o.name), ['c', 'b', 'a']);
    assert.deepEqual(collectSubtree(nested, a.id), [a.id, b.id, c.id]);
    assert.equal(isDescendant(nested, c.id, a.id), true);
    assert.equal(isDescendant(nested, a.id, c.id), false);
});
