// 时间基准：写关键帧必须用「对象局部时间」，不是播放头（文档时间）。
//
// 求值侧一直走局部时间：app/core/evaluator.mjs 的 trackState/effectsAt 都过
// localTime(layer, t)（= core/timegraph.localTimeOf），曲线编辑器也按
// ctx.objectLocalTime 把播放头换算成对象时间再显示与落点（app/editors/curve.mjs:348-355）。
// 而 app/shell/commands.mjs 的效果写入口与 writeKeyAt 曾经直接用 state.time ——
// 对象一旦挂父级或改过时间通道，帧就打在错误的时刻：曲线把播放头画在局部 4，
// 新帧却出现在 3，越拖越偏。本文件锁住这条基准。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { localTimeOf } from '../app/core/timegraph.mjs';
import { createTrack, addKey, stateAt } from '../app/core/transform.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** 一个最小文档：单个对象，可选时间通道。localTimeOf 只读 doc.duration 与 doc.objects。 */
function docWithOneObject(time) {
    const obj = {
        id: 'a',
        name: 'a',
        parentId: null,
        time,
        transform: createTrack(),
        cels: [],
        drawings: [],
    };
    return { width: 100, height: 100, duration: 10, objects: [obj] };
}

test('localTimeOf：offset/scale 的换算是 (全局 - offset) × scale', () => {
    const doc = docWithOneObject({ offset: 1, scale: 2, mode: 'none' });
    const obj = doc.objects[0];
    assert.equal(localTimeOf(doc, obj, 3), 4, '播放头 3 秒 → 局部 4 秒');
    assert.equal(localTimeOf(doc, obj, 1), 0, '播放头落在 offset 上 → 局部 0');
});

test('时间通道恒等时局部时间等于播放头（普通对象零影响）', () => {
    const doc = docWithOneObject(undefined);
    const obj = doc.objects[0];
    assert.equal(localTimeOf(doc, obj, 2.75), 2.75);
});

test('用播放头写帧会在时间子树里落错位置（旧行为）', () => {
    const doc = docWithOneObject({ offset: 1, scale: 2, mode: 'none' });
    const obj = doc.objects[0];
    const playhead = 3;
    const lt = localTimeOf(doc, obj, playhead);
    assert.equal(lt, 4);

    // 旧写法：把播放头当轨道时间
    const wrong = addKey(createTrack(), playhead, { x: 9 }, 'linear');
    assert.equal(wrong.keys[0].t, 3, '帧落在文档时间 3');
    assert.notEqual(wrong.keys[0].t, lt, '与求值用的局部时间 4 不是同一个时刻 —— 这就是错位');

    // 新写法：先换算
    const right = addKey(createTrack(), lt, { x: 9 }, 'linear');
    assert.equal(right.keys[0].t, 4, '帧落在局部时间 4');
    assert.equal(stateAt(right, lt).x, 9, '回读一致：按局部时间求值取得到这一帧');
});

test('效果轨道的时间与变换轨道同一基准（stateAt 用局部时间取得到）', () => {
    const doc = docWithOneObject({ offset: 2, scale: 1, mode: 'none' });
    const obj = doc.objects[0];
    const lt = localTimeOf(doc, obj, 5); // (5-2)*1 = 3
    assert.equal(lt, 3);

    const fxTrack = addKey({ keys: [] }, lt, { x: 0.5 }, 'bezier');
    assert.equal(fxTrack.keys[0].t, 3);
    assert.equal(stateAt(fxTrack, lt).x, 0.5);
    assert.notEqual(fxTrack.keys[0].t, 5, '效果轨道里不能存播放头时间');
});

test('commands.mjs 守卫：效果写入口与 writeKeyAt 都过 localTimeOf', () => {
    const src = read('../app/shell/commands.mjs');
    assert.match(src, /import \{ localTimeOf \} from '\.\.\/core\/timegraph\.mjs';/, '必须 import localTimeOf');
    assert.match(src, /function localTimeOfLayer\(doc, layer\)/, '必须有统一的换算入口');
    assert.match(src, /localTimeOf\(doc, obj, raw\)/, 'writeKeyAt 必须换算');
    assert.match(src, /patchEffect\([^)]*\) \{\n[\s\S]*?mutate\(fx, localTimeOfLayer\(doc, layer\)\)/, '效果回调拿到局部时间');
    assert.doesNotMatch(src, /stateAt\(cur, state\.time\)/, '不得再把播放头当轨道时间');
    assert.doesNotMatch(src, /const t = state\.time;/, '效果写入口里不得再抓 state.time');
});
