import test from 'node:test';
import assert from 'node:assert/strict';
import {
    makeObject, createDoc, drawingsOf, drawingIdAt, drawingIdOf, placeDrawing, makeUnique,
    removeDrawing, drawingUseCount, celAt,
} from '../app/core/doc-model.mjs';

/** 造一张假的位图（只要 width/height + getContext 能画就行）。 */
function fakeImage(w, h, fill) {
    const calls = [];
    return {
        width: w,
        height: h,
        calls,
        getContext() {
            return { drawImage(src) { calls.push(src); }, fillStyle: '', fillRect() {} };
        },
        fill,
    };
}

test('drawingsOf：同一张图出现在多个时刻 → 只有一条画格记录', () => {
    const a = fakeImage(10, 10, 'a');
    const obj = makeObject({ cels: [{ at: 0, image: a }, { at: 1, image: a }, { at: 2, image: fakeImage(10, 10, 'b') }] });
    const list = drawingsOf(obj);
    assert.equal(list.length, 2);
    assert.deepEqual(list[0].times, [0, 1]);
    assert.deepEqual(list[1].times, [2]);
    assert.equal(list[0].id, drawingIdOf(a));
});

test('drawingsOf：空画格（image=null）不进库；非对象安全返回空数组', () => {
    const obj = makeObject({ cels: [{ at: 0, image: null }, { at: 1, image: fakeImage(4, 4) }] });
    assert.equal(drawingsOf(obj).length, 1);
    assert.deepEqual(drawingsOf(null), []);
    assert.deepEqual(drawingsOf({}), []);
});

test('placeDrawing：把已有画格放到新时刻 → 共享同一个位图引用', () => {
    const a = fakeImage(10, 10, 'a');
    const b = fakeImage(10, 10, 'b');
    const obj = makeObject({ cels: [{ at: 0, image: a }, { at: 1, image: b }] });
    const next = placeDrawing(obj, 2, drawingIdOf(a));
    assert.equal(next.cels.length, 3);
    assert.equal(celAt(next, 2).image, a);
    assert.equal(drawingUseCount(next, drawingIdOf(a)), 2);
    // 原对象不被就地改
    assert.equal(obj.cels.length, 2);
});

test('placeDrawing：目标时刻已有画格 → 替换它的图，不新增时刻', () => {
    const a = fakeImage(10, 10, 'a');
    const b = fakeImage(10, 10, 'b');
    const obj = makeObject({ cels: [{ at: 0, image: a }, { at: 1, image: b }] });
    const next = placeDrawing(obj, 1, drawingIdOf(a));
    assert.equal(next.cels.length, 2);
    assert.equal(celAt(next, 1).image, a);
});

test('placeDrawing：画格 id 不存在 → 原样返回', () => {
    const obj = makeObject({ cels: [{ at: 0, image: fakeImage(2, 2) }] });
    assert.equal(placeDrawing(obj, 1, 'nope'), obj);
});

test('makeUnique：独特化后是新图、内容拷过去、id 不同，其它时刻不受影响', () => {
    const a = fakeImage(10, 10, 'a');
    const obj = makeObject({ cels: [{ at: 0, image: a }, { at: 1, image: a }] });
    const next = makeUnique(obj, 1, (w, h) => fakeImage(w, h, 'copy'));
    assert.equal(next.cels.length, 2);
    const cel0 = celAt(next, 0);
    const cel1 = celAt(next, 1);
    assert.equal(cel0.image, a, '0s 仍是原来那张');
    assert.notEqual(cel1.image, a, '1s 换成了新图');
    assert.notEqual(drawingIdOf(cel1.image), drawingIdOf(a));
    assert.equal(cel1.image.width, 10);
    assert.equal(cel1.image.calls.length, 1, '拷图时应该 drawImage 一次');
});

test('makeUnique：没有位图 / 没有 makeImage → 原样返回', () => {
    const obj = makeObject({ cels: [{ at: 0, image: null }] });
    assert.equal(makeUnique(obj, 0, () => fakeImage(2, 2)), obj);
    const obj2 = makeObject({ cels: [{ at: 0, image: fakeImage(2, 2) }] });
    assert.equal(makeUnique(obj2, 0, null), obj2);
});

test('removeDrawing：删掉一张画格会移除它所有的曝光时刻', () => {
    const a = fakeImage(4, 4, 'a');
    const b = fakeImage(4, 4, 'b');
    const obj = makeObject({ cels: [{ at: 0, image: a }, { at: 1, image: a }, { at: 2, image: b }] });
    const next = removeDrawing(obj, drawingIdOf(a));
    assert.equal(next.cels.length, 1);
    assert.equal(celAt(next, 2).image, b);
});

test('removeDrawing：会删光时拒绝（至少留一格）；id 不存在也原样返回', () => {
    const a = fakeImage(4, 4, 'a');
    const obj = makeObject({ cels: [{ at: 0, image: a }] });
    assert.equal(removeDrawing(obj, drawingIdOf(a)), obj);
    assert.equal(removeDrawing(obj, 'nope'), obj);
});

test('drawingIdAt：取某时刻正在曝光的画格 id（沿用「上一格一直生效」）', () => {
    const a = fakeImage(4, 4, 'a');
    const b = fakeImage(4, 4, 'b');
    const obj = makeObject({ cels: [{ at: 0, image: a }, { at: 2, image: b }] });
    assert.equal(drawingIdAt(obj, 0), drawingIdOf(a));
    assert.equal(drawingIdAt(obj, 1.5), drawingIdOf(a));
    assert.equal(drawingIdAt(obj, 2), drawingIdOf(b));
});

test('stampDrawing 幂等：同一张图反复取 id 不变', () => {
    const a = fakeImage(2, 2);
    const first = drawingIdOf(a);
    const second = drawingIdOf(a);
    assert.equal(first, second);
    assert.ok(first && first.startsWith('dw-'));
});

test('drawingsOf 不改入参顺序：按时刻升序返回', () => {
    const a = fakeImage(2, 2, 'a');
    const b = fakeImage(2, 2, 'b');
    const obj = makeObject({ cels: [{ at: 3, image: b }, { at: 0, image: a }] });
    const list = drawingsOf(obj);
    assert.deepEqual(list.map((d) => d.times[0]), [0, 3]);
});
