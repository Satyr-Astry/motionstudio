// 曲线写盘模式：该字段有没有独立轨道，决定「改的是通道键还是共用键」。
// 用户报的「关键帧移动逻辑有问题、时间轴和曲线不同步」就是这里失控造成的：
// 只要拖一下就把字段悄悄提升成独立轨道，共用关键帧留在原位，两个视图从此各拿一套时刻。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { writeModeOf, dragKeyTo, occupiedAt } from '../app/editors/curve-geo.mjs';
import { promoteChannel, createKey, createTrack } from '../app/core/transform.mjs';
import { magnetOf, snapForDrag } from '../app/editors/timeline-geo.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const src = read('../app/editors/curve.mjs');
const doc = (fps) => ({ width: 100, height: 100, fps, duration: 2, objects: [] });

const trk = () => ({ ...createTrack(), keys: [createKey(0, { x: 0, y: 0 }), createKey(1, { x: 40, y: 0 })] });

test('writeModeOf：没独立轨道的字段一律写共用键', () => {
    assert.equal(writeModeOf(trk(), 'x'), 'shared');
    assert.equal(writeModeOf(trk(), 'rotate'), 'shared');
    assert.equal(writeModeOf(trk(), 'opacity'), 'shared');
});

test('writeModeOf：非通道字段（warp 顶点）永远是共用键', () => {
    // warp 顶点不在 TRACK_FIELDS 里，无论 channels 怎么长都只能改共用键
    assert.equal(writeModeOf(trk(), 'warp.0.0'), 'shared');
    assert.equal(writeModeOf(trk(), 'warp.3.2'), 'shared');
});

test('writeModeOf：提升之后才报 channel，而且只影响被提升的那个字段', () => {
    const promoted = promoteChannel(trk(), 'x');
    assert.equal(writeModeOf(promoted, 'x'), 'channel');
    assert.equal(writeModeOf(promoted, 'y'), 'shared', '只提升 x，不能顺带把 y 也独立掉');
});

test('writeModeOf：空/缺字段的 track 不抛错，按共用键处理', () => {
    assert.equal(writeModeOf(null, 'x'), 'shared');
    assert.equal(writeModeOf({}, 'x'), 'shared');
    assert.equal(writeModeOf({ keys: [] }, 'x'), 'shared');
});

test('magnetOf：磁铁开时吸帧、Shift 反转成自由；磁铁关时自由、Shift 变 0.1s 网格', () => {
    assert.equal(magnetOf({}, true), 'frame');
    assert.equal(magnetOf({ shiftKey: true }, true), 'off');
    assert.equal(magnetOf({}, false), 'off');
    assert.equal(magnetOf({ shiftKey: true }, false), 'grid');
    assert.equal(magnetOf(undefined, true), 'frame', '没事件也要有确定档位');
});

test('snapForDrag：12fps 下吸帧落整帧、Shift 关磁铁可落在两帧之间', () => {
    const d = doc(12);
    // 0.6652s × 12 = 7.98 帧 → 吸到 8 帧（0.6667s）
    assert.equal(Number(snapForDrag(d, 0.6652892561983471, {}, true).toFixed(6)), 0.666667);
    // 磁铁开 + Shift = 自由：原样保留，不再有「Shift 吸画格」这层
    assert.equal(snapForDrag(d, 0.6652892561983471, { shiftKey: true }, true), 0.6652892561983471);
    // 磁铁关 + Shift = 0.1s 网格
    assert.equal(Number(snapForDrag(d, 0.6652892561983471, { shiftKey: true }, false).toFixed(6)), 0.7);
    // 磁铁关且不按 Shift = 完全自由
    assert.equal(snapForDrag(d, 0.6652892561983471, {}, false), 0.6652892561983471);
});

test('snapForDrag：负时刻与 NaN 都收成 0，不把非法值带进文档', () => {
    assert.equal(snapForDrag(doc(12), -1, {}, true), 0);
    assert.equal(snapForDrag(doc(12), NaN, {}, false), 0);
    assert.equal(snapForDrag(null, 0.5, {}, true), 0.5, 'doc 缺失时不崩');
});

test('curve.mjs 接线：拖动关键帧不再顺手提升通道（这条是用户报的 bug 的回归钉子）', () => {
    assert.ok(
        !/const base = ensureChannel\(trk, drag\.chId\)/.test(src),
        '拖动分支不许再调用 ensureChannel —— 提升必须是显式动作'
    );
    assert.match(src, /writeModeOf\(trk, drag\.chId\) === 'channel'/, '拖动分支要先问写盘模式');
    assert.match(src, /writeModeOf\(trk, drag\.chId\) === 'channel'\s*\n\s*\? dragChannelHandleTo/, '手柄同理');
});

test('curve.mjs 接线：改缓动与删点也按写盘模式分流', () => {
    assert.ok(!/setChannelKeyEase\(ensureChannel\(/.test(src), '改缓动不许顺带提升');
    assert.ok(!/removeChannelKey\(acc, chId, i\), base\)/.test(src), '删点不许顺带提升');
    assert.match(src, /writeModeOf\(trk, chId\) === 'channel'/, '右键缓动/删除都要先问模式');
});

test('curve.mjs 接线：双击加点在未独立时写共用键', () => {
    assert.ok(!/setChannelKey\(ensureChannel\(old, focus\)/.test(src), '双击加点不许自动提升');
    assert.match(src, /if \(writeModeOf\(track, focus\) === 'channel'\)/, '要按模式分流');
});

test('dragKeyTo：拖共用键只改共用轨道，绝不产生 channels（用户报的「拖一下就不同步」）', () => {
    const t0 = trk();
    const r = dragKeyTo(t0, 0, 0.5, 'x', 12, t0.keys[0].state);
    assert.deepEqual(r.track.keys.map((k) => Number(k.t.toFixed(6))), [0.5, 1]);
    assert.equal(r.track.keys[0].state.x, 12);
    assert.equal(r.track.keys[0].state.y, 0, '拖 x 不能顺带改 y');
    assert.deepEqual(Object.keys(r.track.channels || {}), [], '不许顺手提升成独立通道');
    // 原轨道没被就地改动
    assert.deepEqual(t0.keys.map((k) => Number(k.t.toFixed(6))), [0, 1]);
});

test('dragKeyTo：落到与邻居同刻时不会把两个键留在一起（moveKey 以拖动的为准）', () => {
    const r = dragKeyTo(trk(), 0, 1, 'x', 12, trk().keys[0].state);
    assert.equal(r.track.keys.length, 1, '同刻合并成一个键');
    assert.equal(Number(r.track.keys[0].t.toFixed(6)), 1);
});
test('occupiedAt：同刻有别的键才算占用，被拖的那一颗自己不算', () => {
    const t0 = trk();
    assert.equal(occupiedAt(t0, 'x', 1), true, '1s 上本来就有一颗');
    assert.equal(occupiedAt(t0, 'x', 1, 1), false, '被拖的就是 1s 那颗：不算占用自己');
    assert.equal(occupiedAt(t0, 'x', 0, 0), false);
    assert.equal(occupiedAt(t0, 'x', 0.5), false);
});

test('occupiedAt：浮点抖动按 T_EPS 判定，非法时刻一律不占用', () => {
    const t0 = trk();
    assert.equal(occupiedAt(t0, 'x', 1 + 1e-9), true);
    assert.equal(occupiedAt(t0, 'x', 1.0005), false);
    assert.equal(occupiedAt(t0, 'x', NaN), false);
    assert.equal(occupiedAt(null, 'x', 1), false);
});

test('curve.mjs 接线：拖到已占用的时刻要跳过并提示，不许静默合并', () => {
    assert.match(src, /occupiedAt\(cur, drag\.chId, t, drag\.index\)/, '拖动分支必须有同刻闸门');
    assert.ok(!/if \(occupiedAt\(trk, drag\.chId/.test(src), '闸门要在写之前，不能靠 updater 里 return 原轨道（那样会白记一条撤销）');
    assert.match(src, /已经有关键帧了/, '跳过时要给人话提示');
});