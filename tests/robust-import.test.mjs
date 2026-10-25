import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canReplaceDoc, mergeImportedDoc } from '../app/core/import-merge.mjs';

/* 导入落库合并：快照还有效 → 整体替换（原行为）；快照过期 → 只并入新对象。 */

test('canReplaceDoc：只有同一个对象才算「快照还有效」', () => {
    const doc = { objects: [] };
    assert.equal(canReplaceDoc(doc, doc), true);
    // 内容一样但换了对象引用（切换过项目、撤销/重做重建过文档）也算过期
    assert.equal(canReplaceDoc({ objects: [] }, { objects: [] }), false);
    assert.equal(canReplaceDoc(null, doc), false);
    assert.equal(canReplaceDoc(doc, null), false);
    assert.equal(canReplaceDoc(undefined, undefined), false);
});

test('mergeImportedDoc：只并当前文档没有的对象，且排在最前', () => {
    const kept = { id: 'old', name: '老对象' };
    const cur = { width: 640, height: 480, objects: [kept] };
    const fresh = { id: 'new', name: '刚导入' };
    // next 是「基于旧快照」拼出来的：旧对象也在里面
    const next = { width: 900, height: 640, objects: [fresh, kept] };
    const out = mergeImportedDoc(cur, next);
    assert.equal(out.objects.length, 2);
    assert.equal(out.objects[0].id, 'new');
    assert.equal(out.objects[1], kept);
    // 尺寸等文档字段一律用当前文档的，不被旧快照改回去
    assert.equal(out.width, 640);
    assert.equal(out.height, 480);
    assert.notEqual(out, cur);
});

test('mergeImportedDoc：没有新对象时原样返回当前文档（不制造空的 setDoc）', () => {
    const cur = { objects: [{ id: 'a' }] };
    const next = { objects: [{ id: 'a' }] };
    assert.equal(mergeImportedDoc(cur, next), cur);
});

test('mergeImportedDoc：兼容旧模型的 layers 容器', () => {
    const cur = { layers: [{ id: 'a' }] };
    const next = { layers: [{ id: 'b' }, { id: 'a' }] };
    const out = mergeImportedDoc(cur, next);
    assert.deepEqual(out.layers.map((o) => o.id), ['b', 'a']);
    assert.equal(out.objects, undefined);
});

test('mergeImportedDoc：id 按字符串归一（数字 7 与 "7" 视为同一个对象）', () => {
    const cur = { objects: [{ id: 7 }] };
    const next = { objects: [{ id: '7' }, { id: 8 }] };
    const out = mergeImportedDoc(cur, next);
    assert.deepEqual(out.objects.map((o) => o.id), [8, 7]);
});

test('mergeImportedDoc：脏输入不抛，且不做无意义的替换', () => {
    // 当前文档没法用时退回导入结果（否则这次导入就白做了）
    assert.equal(mergeImportedDoc(null, { objects: [{ id: 'x' }] }).objects.length, 1);
    const cur = { objects: [] };
    assert.equal(mergeImportedDoc(cur, null), cur);
    assert.equal(mergeImportedDoc(cur, { objects: 'nope' }), cur);
    // 当前文档没有容器字段时，按导入结果那一侧决定用 objects 还是 layers
    assert.equal(mergeImportedDoc({}, { objects: [{ id: 'z' }] }).objects[0].id, 'z');
    // 没有 id 的对象当成新对象收下
    assert.equal(mergeImportedDoc({ objects: [] }, { objects: [{ name: '匿名' }] }).objects.length, 1);
});
