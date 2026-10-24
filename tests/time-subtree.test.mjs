// 子树收集（时间图「组时间」的地基）。
// 语义：以 id 为根的 BFS，含自身，环引用与缺失父级都安全，每个 id 只出现一次。

import test from 'node:test';
import assert from 'node:assert/strict';

import { collectSubtree, subtreeSize, childrenOf } from '../app/core/timegraph.mjs';

const obj = (id, parentId) => ({ id, name: id, parentId: parentId ?? null, cels: [{ at: 0, image: null }] });
const doc = (...objects) => ({ width: 100, height: 100, fps: 12, duration: 1, objects });

test('单对象：只返回自己', () => {
    const d = doc(obj('a'));
    assert.deepEqual(collectSubtree(d, 'a'), ['a']);
    assert.equal(subtreeSize(d, 'a'), 0);
});

test('两层：父在前，子在后', () => {
    const d = doc(obj('p'), obj('k', 'p'));
    assert.deepEqual(collectSubtree(d, 'p'), ['p', 'k']);
    assert.equal(subtreeSize(d, 'p'), 1);
});

test('三层：按层级广度优先', () => {
    const d = doc(obj('g'), obj('p', 'g'), obj('k', 'p'));
    assert.deepEqual(collectSubtree(d, 'g'), ['g', 'p', 'k']);
    assert.equal(subtreeSize(d, 'g'), 2);
    // 从中间开始的子树不含祖先
    assert.deepEqual(collectSubtree(d, 'p'), ['p', 'k']);
});

test('多子同层：兄弟都在，顺序稳定', () => {
    const d = doc(obj('p'), obj('a', 'p'), obj('b', 'p'), obj('c', 'p'));
    const ids = collectSubtree(d, 'p');
    assert.equal(ids[0], 'p');
    assert.deepEqual(new Set(ids), new Set(['p', 'a', 'b', 'c']));
    assert.equal(ids.length, 4);
});

test('无关对象不会被卷进来', () => {
    const d = doc(obj('p'), obj('k', 'p'), obj('x'), obj('y', 'x'));
    assert.deepEqual(new Set(collectSubtree(d, 'p')), new Set(['p', 'k']));
    assert.deepEqual(new Set(collectSubtree(d, 'x')), new Set(['x', 'y']));
});

test('环引用不致死循环', () => {
    const d = doc(obj('a', 'b'), obj('b', 'a'));
    const ids = collectSubtree(d, 'a');
    assert.equal(ids.length, 2);
    assert.deepEqual(new Set(ids), new Set(['a', 'b']));
});

test('父级缺失时按根处理', () => {
    const d = doc(obj('k', 'missing'));
    assert.deepEqual(collectSubtree(d, 'k'), ['k']);
});

test('未知 id 返回空数组', () => {
    const d = doc(obj('a'));
    assert.deepEqual(collectSubtree(d, 'nope'), []);
    assert.deepEqual(collectSubtree(d, null), []);
    assert.deepEqual(collectSubtree(null, 'a'), []);
});

test('childrenOf 只给直接子级', () => {
    const d = doc(obj('g'), obj('p', 'g'), obj('k', 'p'));
    assert.deepEqual(childrenOf(d, 'g').map((o) => o.id), ['p']);
    assert.deepEqual(childrenOf(d, 'p').map((o) => o.id), ['k']);
    assert.deepEqual(childrenOf(d, 'k'), []);
});