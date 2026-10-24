import test from 'node:test';
import assert from 'node:assert/strict';
import { createDoc, makeObject, objectsOf, parentChainOf, effectiveVisible, effectiveOpacity } from '../app/core/doc-model.mjs';
import { createEvaluator } from '../app/core/evaluator.mjs';

function doc2() {
    const parent = makeObject({ id: 'p', name: '组', parentId: null, visible: true, opacity: 1 });
    const child = makeObject({ id: 'c', name: '子', parentId: 'p', visible: true, opacity: 1 });
    const other = makeObject({ id: 'o', name: '外部', parentId: null, visible: true, opacity: 1 });
    const d = createDoc({ width: 100, height: 100 });
    d.objects = [child, parent, other];
    return d;
}

test('parentChainOf：自身在首位，父链按 parentId 上溯', () => {
    const d = doc2();
    const child = objectsOf(d).find((o) => o.id === 'c');
    const parent = objectsOf(d).find((o) => o.id === 'p');
    assert.deepEqual(parentChainOf(d, child).map((o) => o.id), ['c', 'p']);
    assert.deepEqual(parentChainOf(d, parent).map((o) => o.id), ['p']);
});

test('parentChainOf：环形 parentId 不死循环', () => {
    const d = doc2();
    d.objects = d.objects.map((o) => (o.id === 'p' ? { ...o, parentId: 'c' } : o));
    const child = objectsOf(d).find((o) => o.id === 'c');
    const chain = parentChainOf(d, child);
    assert.ok(chain.length <= 64);
    assert.ok(chain.length >= 2);
});

test('effectiveVisible：祖先隐藏 → 子对象不可见', () => {
    const d = doc2();
    assert.equal(effectiveVisible(d, objectsOf(d).find((o) => o.id === 'c')), true);
    const hidden = { ...d, objects: d.objects.map((o) => (o.id === 'p' ? { ...o, visible: false } : o)) };
    assert.equal(effectiveVisible(hidden, objectsOf(hidden).find((o) => o.id === 'c')), false);
    assert.equal(effectiveVisible(hidden, objectsOf(hidden).find((o) => o.id === 'o')), true);
});

test('effectiveVisible：visible 缺省视为可见', () => {
    const d = doc2();
    const loose = { ...d, objects: d.objects.map((o) => ({ ...o, visible: undefined })) };
    assert.equal(effectiveVisible(loose, objectsOf(loose).find((o) => o.id === 'c')), true);
});

test('effectiveOpacity：祖先与自身连乘', () => {
    const d = doc2();
    const half = { ...d, objects: d.objects.map((o) => (o.id === 'p' ? { ...o, opacity: 0.5 } : o)) };
    const child = objectsOf(half).find((o) => o.id === 'c');
    assert.equal(effectiveOpacity(half, child), 0.5);
    const both = { ...half, objects: half.objects.map((o) => (o.id === 'c' ? { ...o, opacity: 0.5 } : o)) };
    assert.equal(effectiveOpacity(both, objectsOf(both).find((o) => o.id === 'c')), 0.25);
});

test('effectiveOpacity：非法值按 1 处理且夹在 0..1', () => {
    const d = doc2();
    const bad = { ...d, objects: d.objects.map((o) => (o.id === 'p' ? { ...o, opacity: 'x' } : o)) };
    assert.equal(effectiveOpacity(bad, objectsOf(bad).find((o) => o.id === 'c')), 1);
    const over = { ...d, objects: d.objects.map((o) => (o.id === 'p' ? { ...o, opacity: 2 } : o)) };
    assert.equal(effectiveOpacity(over, objectsOf(over).find((o) => o.id === 'c')), 1);
});

test('求值器：祖先隐藏时子对象在 sample 记录里 visible=false（渲染前就被挡下）', () => {
    const d = doc2();
    const ev = createEvaluator(d);
    const rec = (r, id) => r.layers.find((x) => x.layer.id === id);
    assert.equal(rec(ev.sample(0), 'c').visible, true);
    const hidden = { ...d, objects: d.objects.map((o) => (o.id === 'p' ? { ...o, visible: false } : o)) };
    ev.doc = hidden;
    assert.equal(rec(ev.sample(0), 'c').visible, false);
});

test('求值器：祖先隐藏不影响无关对象', () => {
    const d = doc2();
    const hidden = { ...d, objects: d.objects.map((o) => (o.id === 'p' ? { ...o, visible: false } : o)) };
    const ev = createEvaluator(hidden);
    const r = ev.sample(0).layers.find((x) => x.layer.id === 'o');
    assert.equal(r.visible, true);
});

test('合成前的不透明度：doc-model 有效值把祖先前乘好，求值器记录里只含本层', () => {
    const d = doc2();
    const half = { ...d, objects: d.objects.map((o) => (o.id === 'p' ? { ...o, opacity: 0.5 } : o)) };
    const child = objectsOf(half).find((o) => o.id === 'c');
    assert.equal(effectiveOpacity(half, child), 0.5);
    const ev = createEvaluator(half);
    const r = ev.sample(0).layers.find((x) => x.layer.id === 'c');
    // 记录的 opacity 只含本层（1），祖先那 0.5 由 composite 用 effectiveOpacity 再乘一次
    assert.equal(r.opacity, 1);
});
