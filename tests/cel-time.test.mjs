// 「画格按时间生效」的核心语义（v6 时间模型）
//
// 旧 tests/hold.test.mjs 守的是「帧序号 + hold 开关」——那套概念已经不存在：
// hold 不再是一个需要开关的字段，**沿用**就是默认行为，画格一直生效到下一个画格。
// 所以这里改守时间语义本身：
//   · ensureCelAt 复用 / 新建（新建继承上一张图）
//   · imageAt 沿用到下一个画格，t 早于首格时没有画面
//   · removeCelAt 不许删掉最后一个
//   · moveCel 改时间（含覆盖与脏输入）
//   · contentDuration 按时长推算

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    makeObject,
    createDocument,
    objectsOf,
    patchObject,
    celTimes,
    celIndexAt,
    celAt,
    imageAt,
    hasCelAt,
    isCelBoundary,
    ensureCelAt,
    setImageAt,
    removeCelAt,
    moveCel,
    contentDuration,
    docDuration,
    eventTimes,
} from '../app/core/cel.mjs';

/** 造一个只关心时间的对象：cels 由 [at, image] 对给出。 */
const obj = (pairs) => makeObject({ name: 'A', cels: pairs.map(([at, image]) => ({ at, image })) });
const times = (o) => celTimes(o);

test('画格按时间生效：imageAt 沿用到下一个画格', () => {
    const o = obj([[0, 'A'], [1, 'B'], [2.5, 'C']]);
    assert.deepEqual(times(o), [0, 1, 2.5]);
    assert.equal(imageAt(o, 0), 'A');
    assert.equal(imageAt(o, 0.5), 'A', '0~1 秒沿用第一格');
    assert.equal(imageAt(o, 1), 'B', '切换点归后一格');
    assert.equal(imageAt(o, 2.49), 'B');
    assert.equal(imageAt(o, 2.5), 'C');
    assert.equal(imageAt(o, 99), 'C', '最后一格一直生效');
    assert.equal(celAt(o, 0.9).image, 'A');
});

test('t 早于第一个画格时没有生效画格', () => {
    const o = obj([[1, 'A']]);
    assert.equal(celAt(o, 0.5), null);
    assert.equal(imageAt(o, 0.5), null);
    assert.equal(celIndexAt(o, 0.5), -1);
    assert.equal(imageAt(o, 1), 'A');
    assert.equal(celIndexAt(o, 1), 0);
});

test('画格间隔完全自由：3 秒一格与 0.17 秒一格同样合法', () => {
    const o = obj([[0, 'A'], [0.17, 'B'], [3.17, 'C']]);
    assert.deepEqual(times(o), [0, 0.17, 3.17]);
    assert.equal(imageAt(o, 3.169), 'B');
    assert.equal(imageAt(o, 3.17), 'C');
    assert.equal(celIndexAt(o, 3.169), 1);
    assert.equal(celIndexAt(o, 3.17), 2);
});

test('ensureCelAt 命中已有画格时复用，不造新对象', () => {
    const o = obj([[0, 'A'], [1, 'B']]);
    const hit = ensureCelAt(o, 1);
    assert.equal(hit.created, false);
    assert.equal(hit.obj, o);
    assert.equal(hit.cel.image, 'B');
    const near = ensureCelAt(o, 1 + 1e-12);
    assert.equal(near.created, false, '容差内视为同一画格');
});

test('ensureCelAt 新建画格继承上一张图，且不改入参', () => {
    const o = obj([[0, 'A']]);
    const r = ensureCelAt(o, 2);
    assert.equal(r.created, true);
    assert.notEqual(r.obj, o);
    assert.equal(o.cels.length, 1);
    assert.deepEqual(times(r.obj), [0, 2]);
    assert.equal(r.cel.at, 2);
    assert.equal(r.cel.image, 'A', '默认继承上一画格的位图');

    const plain = ensureCelAt(o, 2, { inherit: false });
    assert.equal(plain.cel.image, null, 'inherit: false 时新格是空的');
});

test('ensureCelAt 插入后仍按 at 升序，并遮蔽到下一格为止', () => {
    const o = obj([[0, 'A'], [4, 'D']]);
    const r = ensureCelAt(o, 2);
    assert.deepEqual(times(r.obj), [0, 2, 4]);
    assert.equal(imageAt(r.obj, 1.9), 'A');
    assert.equal(imageAt(r.obj, 3), 'A', '新格覆盖 2~4 秒区间');
    assert.equal(imageAt(r.obj, 4), 'D');
});

test('ensureCelAt 把脏时间当 0，非法对象安全返回', () => {
    const o = obj([[0, 'A']]);
    assert.equal(ensureCelAt(o, -5).created, false, '负时间归一为 0');
    assert.equal(ensureCelAt(o, 'x').created, false, '非数字归一为 0');
    const bad = ensureCelAt(null, 1);
    assert.equal(bad.obj, null);
    assert.equal(bad.cel, null);
    assert.equal(bad.created, false);
});

test('setImageAt 在任意时刻写入位图（必要时新建画格）', () => {
    const o = obj([[0, 'A']]);
    const b = setImageAt(o, 1.5, 'B');
    assert.equal(imageAt(b, 1.5), 'B');
    assert.equal(imageAt(b, 1.4), 'A');
    assert.equal(imageAt(o, 1.5), 'A', '不改入参');
    assert.deepEqual(times(b), [0, 1.5]);

    const overwrite = setImageAt(o, 0, 'A2');
    assert.equal(imageAt(overwrite, 0), 'A2');
    assert.deepEqual(times(overwrite), [0], '精确命中时不新增画格');
});

test('removeCelAt 不允许删掉最后一个画格', () => {
    const one = obj([[0, 'A']]);
    assert.equal(removeCelAt(one, 0), one, '只剩一格时原样返回');

    const two = obj([[0, 'A'], [1, 'B']]);
    const next = removeCelAt(two, 0);
    assert.deepEqual(times(next), [1]);
    assert.equal(imageAt(next, 0), null, '删掉首格后 t=0 不再有生效画格');
    assert.equal(imageAt(next, 1), 'B');
    assert.equal(two.cels.length, 2, '不改入参');

    assert.deepEqual(times(removeCelAt(two, 9)), [0, 1], '该时刻没有画格时内容不变');
});

test('moveCel 改时间：整体搬家、目标已存在则覆盖、相同时间不动', () => {
    const o = obj([[0, 'A'], [1, 'B']]);
    const moved = moveCel(o, 0, 2);
    assert.deepEqual(times(moved), [1, 2]);
    assert.equal(imageAt(moved, 2), 'A');
    assert.equal(imageAt(moved, 1.5), 'B');
    assert.equal(imageAt(o, 0), 'A', '不改入参');

    const over = moveCel(o, 0, 1);
    assert.deepEqual(times(over), [1]);
    assert.equal(imageAt(over, 1), 'A', '目标画格被覆盖');

    assert.equal(moveCel(o, 0, 0), o, '同一时间 → 原引用');
    assert.equal(moveCel(o, 9, 3), o, '源不存在 → 原引用');

    const back = moveCel(o, 1, -2);
    assert.deepEqual(times(back), [0]);
    assert.equal(imageAt(back, 0), 'B', '负时间归一为 0');
});

test('contentDuration / docDuration 按时长推算', () => {
    const doc = { objects: [obj([[0, null], [2.5, null]])] };
    assert.equal(contentDuration(doc), 2.5);
    assert.equal(docDuration(doc), 2.5);

    const bare = { objects: [makeObject({})] };
    assert.equal(contentDuration(bare), 0, '只有 at=0 的空画格 → 没有内容');
    assert.equal(docDuration(bare), 0, '空文档时长为 0');

    assert.equal(docDuration({ objects: [obj([[0, null]])], duration: 5 }), 5, '显式时长优先');
    assert.equal(
        docDuration({ objects: [obj([[0, null], [7, null]])], duration: 2 }),
        7,
        '内容超出显式时长时以内容为准',
    );

    const keyed = makeObject({ transform: { keys: [{ t: 3.25 }] } });
    assert.equal(contentDuration({ objects: [keyed] }), 3.25, '变换关键帧也计入内容时长');
});

test('eventTimes 汇总 0、画格切换点与变换关键帧', () => {
    const doc = createDocument({
        objects: [
            {
                name: 'A',
                cels: [{ at: 0, image: null }, { at: 0.5, image: null }],
                transform: { keys: [{ t: 1.25 }] },
            },
            { name: 'B', cels: [{ at: 0, image: null }, { at: 2, image: null }] },
        ],
    });
    assert.deepEqual(eventTimes(doc), [0, 0.5, 1.25, 2]);
});

test('hasCelAt / isCelBoundary 只在切换点上为真', () => {
    const o = obj([[0, 'A'], [1.5, 'B']]);
    assert.equal(hasCelAt(o, 0), true);
    assert.equal(hasCelAt(o, 1.5 + 1e-12), true);
    assert.equal(hasCelAt(o, 0.75), false);
    assert.equal(isCelBoundary(o, 1.5), true);
    assert.equal(isCelBoundary(o, 3), false);
});

test('改某一时刻的画面不影响其它时刻（纯函数语义）', () => {
    const doc = createDocument({ objects: [{ name: 'A', cels: [{ at: 0, image: 'A0' }] }] });
    const id = objectsOf(doc)[0].id;
    const next = patchObject(doc, id, (o) => setImageAt(o, 2, 'A2'));
    assert.equal(imageAt(objectsOf(next)[0], 2), 'A2');
    assert.equal(imageAt(objectsOf(next)[0], 1), 'A0', '2 秒之前仍沿用首格');
    assert.equal(imageAt(objectsOf(doc)[0], 2), 'A0', '入参文档没被改');
});
