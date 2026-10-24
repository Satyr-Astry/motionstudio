import test from 'node:test';
import assert from 'node:assert/strict';
import { createDoc, makeObject, objectsOf, swapCelAt, celTimes, imageAt } from '../app/core/doc-model.mjs';

function doc3() {
    const objs = [
        makeObject({ id: 'a', name: '甲', cels: [{ at: 0, image: 'img0' }, { at: 1, image: 'img1' }, { at: 2, image: 'img2' }] }),
        makeObject({ id: 'b', name: '乙', cels: [{ at: 0, image: 'bi0' }] }),
    ];
    const d = createDoc({ width: 100, height: 100 });
    return { ...d, objects: objs };
}

test('swapCelAt：两格时刻互换，内容跟着自己的格走', () => {
    const d = doc3();
    const next = swapCelAt(d, 'a', 0, 2);
    assert.notEqual(next, d);
    const o = objectsOf(next).find((x) => x.id === 'a');
    assert.deepEqual(celTimes(o), [0, 1, 2]);
    assert.equal(imageAt(o, 2), 'img0');
    assert.equal(imageAt(o, 0), 'img2');
    assert.equal(imageAt(o, 1), 'img1');
});

test('swapCelAt：不改原文档（不可变）', () => {
    const d = doc3();
    swapCelAt(d, 'a', 0, 1);
    const o = objectsOf(d).find((x) => x.id === 'a');
    assert.equal(imageAt(o, 0), 'img0');
    assert.equal(imageAt(o, 1), 'img1');
});

test('swapCelAt：时刻不存在 / 相同 / 非法入参 → 原样返回同一个引用', () => {
    const d = doc3();
    assert.equal(swapCelAt(d, 'a', 0, 9), d);
    assert.equal(swapCelAt(d, 'a', 1, 1), d);
    assert.equal(swapCelAt(d, 'a', 'x', 1), d);
    assert.equal(swapCelAt(d, 'zzz', 0, 1), d);
});

test('swapCelAt：不影响同一文档里的其它对象', () => {
    const d = doc3();
    const next = swapCelAt(d, 'a', 0, 2);
    const b = objectsOf(next).find((x) => x.id === 'b');
    const b0 = objectsOf(d).find((x) => x.id === 'b');
    assert.equal(b, b0);
});
