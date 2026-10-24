// 通道独立轨道（v8）：验证「单独调一条曲线，别的曲线不跟随」。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createTrack, addKey, stateAt, setChannelKey, channelOf, hasChannelTracks,
    channelValueAt, removeChannelKey, moveChannelKey, setChannelKeyEase,
    promoteChannel, clearChannel, TRACK_FIELDS,
} from '../app/core/transform.mjs';

function track3() {
    let t = createTrack();
    t = addKey(t, 0, { x: 0, rotate: 0, opacity: 1 }, 'linear');
    t = addKey(t, 1, { x: 100, rotate: 90, opacity: 0.2 }, 'linear');
    t = addKey(t, 2, { x: 0, rotate: 0, opacity: 1 }, 'linear');
    return t;
}

test('没有通道轨道时 stateAt 与旧行为一致', () => {
    const t = track3();
    assert.equal(hasChannelTracks(t), false);
    assert.equal(stateAt(t, 0.5).x, 50);
    assert.equal(stateAt(t, 0.5).rotate, 45);
    assert.ok(Math.abs(stateAt(t, 0.5).opacity - 0.6) < 1e-9);
});

test('promoteChannel 提升后画面完全不变', () => {
    const t = track3();
    const p = promoteChannel(t, 'rotate');
    for (const at of [0, 0.25, 0.5, 0.75, 1, 1.5, 2]) {
        assert.ok(Math.abs(stateAt(t, at).rotate - stateAt(p, at).rotate) < 1e-9, 'rotate @' + at);
        assert.ok(Math.abs(stateAt(t, at).x - stateAt(p, at).x) < 1e-9, 'x @' + at);
    }
    assert.equal(hasChannelTracks(p), true);
});

test('改通道关键帧的时间，不动共用轨道，其它通道不跟随', () => {
    let t = promoteChannel(track3(), 'rotate');
    // 把 rotate 的第二个关键帧从 t=1 移到 t=1.5
    const before = stateAt(t, 1.0);
    t = moveChannelKey(t, 'rotate', 1, 1.5);
    const after = stateAt(t, 1.0);
    // rotate 变了（因为它自己的关键帧挪了），但 x / opacity 必须一点没动
    assert.ok(Math.abs(after.x - before.x) < 1e-9, 'x 不该跟随');
    assert.ok(Math.abs(after.opacity - before.opacity) < 1e-9, 'opacity 不该跟随');
    assert.ok(Math.abs(after.rotate - before.rotate) > 1e-6, 'rotate 应该变');
});

test('改通道值不影响其它通道', () => {
    let t = promoteChannel(track3(), 'opacity');
    const before = stateAt(t, 0.5);
    t = setChannelKey(t, 'opacity', 0.5, 0.9);
    const after = stateAt(t, 0.5);
    assert.ok(Math.abs(after.opacity - 0.9) < 1e-9);
    assert.ok(Math.abs(after.x - before.x) < 1e-9);
    assert.ok(Math.abs(after.rotate - before.rotate) < 1e-9);
});

test('setChannelKey 省略 value 时取当前值，不跳变', () => {
    const t = promoteChannel(track3(), 'x');
    const v = stateAt(t, 0.4).x;
    const t2 = setChannelKey(t, 'x', 0.4);
    assert.ok(Math.abs(stateAt(t2, 0.4).x - v) < 1e-9);
    assert.equal(channelOf(t2, 'x').keys.length, 4); // 原 3 个 + 新的 1 个
});

test('同刻打键覆盖而非叠加', () => {
    let t = promoteChannel(track3(), 'x');
    t = setChannelKey(t, 'x', 1, 500);
    assert.equal(channelOf(t, 'x').keys.length, 3);
    assert.equal(stateAt(t, 1).x, 500);
});

test('通道关键帧支持 hold 与 bezier', () => {
    let t = promoteChannel(track3(), 'opacity');
    t = setChannelKeyEase(t, 'opacity', 0, 'hold');
    assert.equal(stateAt(t, 0.5).opacity, 1); // hold：整段保持起点
    // 非对称控制点：慢起快落，中点应明显高于线性值 0.6
    t = setChannelKeyEase(t, 'opacity', 0, 'bezier', [0.9, 0], [0.95, 0.1]);
    const mid = stateAt(t, 0.5).opacity;
    assert.ok(mid > 0.9, '非对称贝塞尔中点应接近起点: ' + mid);
});

test('删通道关键帧；删光后回落到共用轨道', () => {
    let t = promoteChannel(track3(), 'x');
    t = removeChannelKey(t, 'x', 0);
    assert.equal(channelOf(t, 'x').keys.length, 2);
    t = removeChannelKey(t, 'x', 0);
    t = removeChannelKey(t, 'x', 0);
    assert.equal(channelOf(t, 'x'), null);
    assert.ok(Math.abs(stateAt(t, 0.5).x - 50) < 1e-9);
});

test('clearChannel 回到共用轨道', () => {
    let t = promoteChannel(track3(), 'rotate');
    t = moveChannelKey(t, 'rotate', 1, 1.5);
    t = clearChannel(t, 'rotate');
    assert.equal(hasChannelTracks(t), false);
    assert.equal(stateAt(t, 0.5).rotate, 45);
});

test('区间外取端点，不外插', () => {
    let t = promoteChannel(track3(), 'x'); // 3 个通道键：t=0/1/2，x 分别 0/100/0
    const ch = channelOf(t, 'x');
    assert.equal(channelValueAt(ch, -5, 999), 0);
    assert.equal(channelValueAt(ch, 99, 999), 0);
});

test('多通道同时独立', () => {
    let t = promoteChannel(track3(), 'x');
    t = promoteChannel(t, 'rotate');
    t = setChannelKey(t, 'x', 0.5, 999);
    t = setChannelKey(t, 'rotate', 0.5, -90);
    const s = stateAt(t, 0.5);
    assert.equal(s.x, 999);
    assert.equal(s.rotate, -90);
    assert.ok(Math.abs(s.opacity - 0.6) < 1e-9); // 未提升的通道仍走共用
});

test('未知通道名报错而不是静默', () => {
    assert.throws(() => setChannelKey(createTrack(), 'nope', 0, 1), /未知通道/);
});

test('空轨道也能打通道键', () => {
    let t = setChannelKey(createTrack(), 'x', 0, 5);
    assert.equal(stateAt(t, 0).x, 5);
    assert.equal(TRACK_FIELDS.length, 8);
});
