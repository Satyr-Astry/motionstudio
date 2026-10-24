// doc-model.mjs 单测：v6「无帧」文档模型。
//
// 核心断言只有一句：内容属于「时间点」，不属于「第几帧」。
// 同一份像素可以出现在任意两个时间点之间，间隔多长都合法。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    normAt,
    makeObject,
    normCel,
    createDoc,
    createDocument,
    objectsOf,
    objectById,
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
    totalSeconds,
    patchObject,
    addObject,
    removeObject,
    reorderObject,
    migrateFromFrames,
    eventTimes,
    sampleTimes,
    stateOf,
    emptyTrack,
    makeKey,
} from '../app/core/doc-model.mjs';

const img = (tag) => ({ tag, width: 4, height: 4 });
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

/* ─────────────────────────── 基础工具 ─────────────────────────── */

test('normAt：负数/NaN/字符串/undefined 都收敛到合法秒数', () => {
    assert.equal(normAt(1.5), 1.5);
    assert.equal(normAt(-2), 0);
    assert.equal(normAt(NaN), 0);
    assert.equal(normAt(undefined), 0);
    assert.equal(normAt('0.75'), 0.75);
    assert.equal(normAt(null), 0);
});

test('normCel：at 非法返回 null，合法则保留 image', () => {
    assert.equal(normCel(null), null);
    assert.equal(normCel({ at: -1 }), null);
    assert.equal(normCel({ at: 'x', image: img('a') }), null);
    const c = normCel({ at: 0.5, image: img('a') });
    assert.equal(c.at, 0.5);
    assert.equal(c.image.tag, 'a');
});

test('makeObject：没有画格时自动补一个 at=0 的空画格', () => {
    const o = makeObject({ name: '甲' });
    assert.equal(o.cels.length, 1);
    assert.equal(o.cels[0].at, 0);
    assert.equal(o.cels[0].image, null);
    assert.equal(o.name, '甲');
});

test('makeObject：画格按 at 升序整理', () => {
    const o = makeObject({ cels: [{ at: 2, image: img('c') }, { at: 0, image: img('a') }, { at: 1, image: img('b') }] });
    assert.deepEqual(o.cels.map((c) => c.at), [0, 1, 2]);
});

test('makeObject：恒等时间通道不落字段', () => {
    const o = makeObject({ name: 'x', time: { offset: 0, scale: 1, mode: 'none' } });
    assert.equal(o.time, undefined);
    const o2 = makeObject({ name: 'y', time: { scale: 2 } });
    assert.equal(o2.time.scale, 2);
});

test('makeObject：parentId 与 effects 保留', () => {
    const o = makeObject({ parentId: 'p1', effects: [{ type: 'blur', amount: 2 }] });
    assert.equal(o.parentId, 'p1');
    assert.equal(o.effects.length, 1);
});

/* ─────────────────────────── 文档 ─────────────────────────── */

test('createDoc：默认 900×640 / 12fps / 至少一个对象', () => {
    const d = createDoc();
    assert.equal(d.width, 900);
    assert.equal(d.height, 640);
    assert.equal(d.fps, 12);
    assert.equal(d.objects.length, 1);
    assert.ok(!Array.isArray(d.frames), 'v6 没有 frames 数组');
});

test('createDoc：尺寸与 fps 被钳制', () => {
    const d = createDoc({ width: -5, height: 0, fps: 999 });
    assert.equal(d.width, 900);
    assert.equal(d.height, 640);
    assert.equal(d.fps, 120);
});

test('createDoc：显式 duration 优先，内容更长时以内容为准', () => {
    const a = createDoc({ duration: 4 });
    near(docDuration(a), 4);
    const b = createDoc({ duration: 1, objects: [{ name: 'x', cels: [{ at: 0, image: null }, { at: 3, image: img('z') }] }] });
    near(docDuration(b), 3);
});

test('createDocument 是 createDoc 的别名', () => {
    assert.equal(createDocument, createDoc);
});

test('objectsOf / objectById：认 objects 也认 layers', () => {
    const d = createDoc({ objects: [{ id: 'k1', name: '一' }, { id: 'k2', name: '二' }] });
    assert.equal(objectsOf(d).length, 2);
    assert.equal(objectById(d, 'k2').name, '二');
    assert.equal(objectById(d, 'nope'), null);
    assert.equal(objectsOf({ layers: [{ id: 'L' }] }).length, 1);
    assert.deepEqual(objectsOf(null), []);
});

/* ─────────────────── 画格查找：时间是唯一索引 ─────────────────── */

test('celTimes：升序去重', () => {
    const o = makeObject({ cels: [{ at: 1, image: null }, { at: 0, image: null }, { at: 1, image: null }] });
    assert.deepEqual(celTimes(o), [0, 1]);
    assert.deepEqual(celTimes(makeObject({})), [0]);
    assert.deepEqual(celTimes(null), []);
});

test('celAt：at<=t 的最后一个（画格一直沿用到下一个）', () => {
    const o = makeObject({
        cels: [{ at: 0, image: img('a') }, { at: 0.5, image: img('b') }, { at: 2, image: img('c') }],
    });
    assert.equal(celAt(o, 0).image.tag, 'a');
    assert.equal(celAt(o, 0.2).image.tag, 'a');
    assert.equal(celAt(o, 0.5).image.tag, 'b');
    assert.equal(celAt(o, 1.9).image.tag, 'b');
    assert.equal(celAt(o, 2).image.tag, 'c');
    assert.equal(celAt(o, 99).image.tag, 'c');
});

test('celAt：t 早于第一个画格时返回 null', () => {
    const o = makeObject({ cels: [{ at: 1, image: img('a') }] });
    assert.equal(celAt(o, 0.5), null);
    assert.equal(celAt(o, 1).image.tag, 'a');
});

test('imageAt：直接取位图，空画格返回 null', () => {
    const o = makeObject({ cels: [{ at: 0, image: null }, { at: 1, image: img('z') }] });
    assert.equal(imageAt(o, 0.5), null);
    assert.equal(imageAt(o, 1.5).tag, 'z');
    assert.equal(imageAt(null, 1), null);
});

test('celIndexAt：二分定位，越界返回 -1', () => {
    const o = makeObject({ cels: [{ at: 0, image: null }, { at: 1, image: null }, { at: 2, image: null }] });
    assert.equal(celIndexAt(o, 0), 0);
    assert.equal(celIndexAt(o, 1.5), 1);
    assert.equal(celIndexAt(o, 2), 2);
    assert.equal(celIndexAt(o, 9), 2);
    const late = makeObject({ cels: [{ at: 1, image: null }] });
    assert.equal(celIndexAt(late, 0), -1);
});

test('hasCelAt / isCelBoundary：只认「正好落在这里」', () => {
    const o = makeObject({ cels: [{ at: 0, image: null }, { at: 1, image: null }] });
    assert.equal(hasCelAt(o, 0), true);
    assert.equal(hasCelAt(o, 1), true);
    assert.equal(hasCelAt(o, 0.5), false);
    assert.equal(isCelBoundary(o, 1), true);
    assert.equal(isCelBoundary(o, 0.5), false);
});

/* ─────────────────────────── 画格编辑 ─────────────────────────── */

test('ensureCelAt：已有则复用，没有则新建并继承上一张图', () => {
    const o = makeObject({ cels: [{ at: 0, image: img('a') }] });
    const r1 = ensureCelAt(o, 0.5);
    assert.equal(r1.created, true);
    assert.equal(r1.cel.image.tag, 'a', '默认继承上一张');
    assert.equal(o.cels.length, 1, '入参不被改');
    const r2 = ensureCelAt(r1.obj, 0.5);
    assert.equal(r2.created, false);
    assert.equal(r2.obj, r1.obj);
});

test('ensureCelAt：inherit=false 时不继承', () => {
    const o = makeObject({ cels: [{ at: 0, image: img('a') }] });
    const r = ensureCelAt(o, 1, { inherit: false });
    assert.equal(r.cel.image, null);
});

test('setImageAt：写入指定时间的画格，不动别的画格', () => {
    const o = makeObject({ cels: [{ at: 0, image: img('a') }] });
    const next = setImageAt(o, 0.5, img('b'));
    assert.equal(next.cels.length, 2);
    assert.equal(imageAt(next, 0.1).tag, 'a');
    assert.equal(imageAt(next, 0.5).tag, 'b');
    assert.equal(imageAt(o, 0.5).tag, 'a', '入参不变');
});

test('setImageAt：覆盖同一时间的画格', () => {
    const o = makeObject({ cels: [{ at: 0, image: img('a') }] });
    const next = setImageAt(o, 0, img('q'));
    assert.equal(next.cels.length, 1);
    assert.equal(imageAt(next, 0).tag, 'q');
});

test('removeCelAt：删得掉中间，删不掉最后一个', () => {
    const o = makeObject({ cels: [{ at: 0, image: img('a') }, { at: 1, image: img('b') }] });
    const one = removeCelAt(o, 0);
    assert.equal(one.cels.length, 1);
    assert.equal(imageAt(one, 1).tag, 'b', '剩下的画格在它自己的时间点生效');
    assert.equal(imageAt(one, 0), null, '删掉首格后 0 秒没有任何画格');
    const kept = removeCelAt(makeObject({ cels: [{ at: 0, image: null }] }), 0);
    assert.equal(kept.cels.length, 1, '最后一个不能删');
});

test('moveCel：把画格挪到别的时间点，目标已存在则覆盖', () => {
    const o = makeObject({ cels: [{ at: 0, image: img('a') }, { at: 1, image: img('b') }] });
    const m = moveCel(o, 1, 0.5);
    assert.deepEqual(m.cels.map((c) => c.at), [0, 0.5]);
    assert.equal(imageAt(m, 0.5).tag, 'b');
    const ov = moveCel(o, 0, 1);
    assert.deepEqual(ov.cels.map((c) => c.at), [1]);
    assert.equal(imageAt(ov, 1).tag, 'a', '覆盖目标');
});

/* ─────────────────────────── 时长 ─────────────────────────── */

test('contentDuration：取画格与关键帧的最晚时间', () => {
    const d = createDoc({
        objects: [
            { cels: [{ at: 0, image: null }, { at: 1.5, image: img('a') }] },
            { cels: [{ at: 0, image: null }], transform: { keys: [{ t: 2.25, state: {} }] } },
        ],
    });
    near(contentDuration(d), 2.25);
});

test('docDuration：空文档为 0，有画格/关键帧时按内容推算', () => {
    // near(a, b, eps)：第三参是容差不是说明文字
    near(docDuration(createDoc()), 0);
    near(totalSeconds(createDoc()), 0);
    near(docDuration({ duration: 3 }), 3);
    const d = createDoc();
    d.objects[0].cels = [{ at: 0, image: null }, { at: 2.5, image: null }];
    near(docDuration(d), 2.5);
    near(docDuration({ duration: 9, objects: d.objects }), 9);
});

/* ─────────────────────── 变体操作（不可变） ─────────────────────── */

test('patchObject：只换目标对象，其它引用不变', () => {
    const d = createDoc({ objects: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
    const next = patchObject(d, 'b', (o) => Object.assign({}, o, { name: 'B2' }));
    assert.notEqual(next, d);
    assert.equal(next.objects[0], d.objects[0], '无关对象复用引用');
    assert.equal(objectById(next, 'b').name, 'B2');
    assert.equal(objectById(d, 'b').name, 'B', '原 doc 不变');
});

test('patchObject：fn 返回 null 时不动', () => {
    const d = createDoc({ objects: [{ id: 'a' }] });
    assert.equal(patchObject(d, 'a', () => null), d);
    assert.equal(patchObject(d, 'nope', (o) => Object.assign({}, o, { name: 'x' })), d);
});

test('addObject / removeObject', () => {
    const d = createDoc({ objects: [{ id: 'a' }] });
    const d2 = addObject(d, { name: '新的' });
    assert.equal(d2.objects.length, 2);
    const d3 = removeObject(d2, 'a');
    assert.equal(d3.objects.length, 1);
    const rootKept = removeObject(createDoc({ objects: [{ id: 'a' }, { id: 'b', parentId: 'a' }] }), 'a');
    assert.equal(rootKept.objects.length, 1);
    assert.equal(rootKept.objects[0].parentId, undefined, '子对象被提到根');
});

test('reorderObject：夹取目标下标', () => {
    const d = createDoc({ objects: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] });
    assert.deepEqual(reorderObject(d, 'c', 0).objects.map((o) => o.id), ['c', 'a', 'b']);
    assert.deepEqual(reorderObject(d, 'a', 99).objects.map((o) => o.id), ['b', 'c', 'a']);
    assert.equal(reorderObject(d, 'zz', 0), d);
});

/* ─────────────────────── 旧模型迁移 ─────────────────────── */

test('migrateFromFrames：帧序号换成秒，空画格跳过', () => {
    const old = {
        width: 10,
        height: 10,
        fps: 10,
        layers: [{ id: 'L', name: 'L' }],
        frames: [
            { duration: 1, cels: { L: { image: img('p0') } } },
            { duration: 1, cels: { L: { image: null } } },
            { duration: 2, cels: { L: { image: img('p2') } } },
        ],
    };
    const d = migrateFromFrames(old);
    assert.ok(!Array.isArray(d.frames));
    const o = d.objects[0];
    assert.deepEqual(o.cels.map((c) => c.at), [0, 0.2]);
    assert.equal(o.cels[0].image.tag, 'p0');
    assert.equal(o.cels[1].image.tag, 'p2');
    near(docDuration(d), 0.4);
});

test('migrateFromFrames：已经是新模型则原样归一', () => {
    const d = migrateFromFrames({ width: 5, height: 5, objects: [{ id: 'a', cels: [{ at: 0.5, image: img('x') }] }] });
    assert.equal(d.objects[0].cels[0].at, 0.5);
    assert.equal(d.width, 5);
});

test('migrateFromFrames：脏输入返回 null', () => {
    assert.equal(migrateFromFrames(null), null);
    assert.equal(migrateFromFrames(undefined), null);
});

/* ─────────────────────── 采样与查询 ─────────────────────── */

test('eventTimes：画格点与关键帧合并升序，总含 0', () => {
    const d = createDoc({
        objects: [
            { cels: [{ at: 0, image: null }, { at: 1, image: null }] },
            { cels: [{ at: 0, image: null }], transform: { keys: [{ t: 0.25, state: {} }, { t: 1, state: {} }] } },
        ],
    });
    assert.deepEqual(eventTimes(d), [0, 0.25, 1]);
});

test('sampleTimes：按步长铺满，不足一帧也至少给一个点', () => {
    const d = createDoc({ duration: 0.5 });
    assert.deepEqual(sampleTimes(d, 0.25), [0, 0.25]);
    assert.equal(sampleTimes(d, 0.1).length, 5);
    assert.deepEqual(sampleTimes(createDoc(), 1), [0]);
});

test('stateOf：没有轨道返回默认状态', () => {
    const s = stateOf(makeObject({}), 0.5);
    assert.equal(s.x, 0);
    assert.equal(s.scaleX, 1);
    assert.equal(s.opacity, 1);
});

test('emptyTrack / makeKey 走同一个实现', () => {
    assert.deepEqual(emptyTrack(), { keys: [] });
    const k = makeKey(0.5, { x: 10 });
    assert.equal(k.t, 0.5);
    assert.equal(k.state.x, 10);
    assert.equal(k.ease, 'linear');
});
