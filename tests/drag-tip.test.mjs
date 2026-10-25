/**
 * 拖动浮层与冲突判定的纯逻辑测试。
 *
 * 这些函数被时间轴（`timeline-keys.mjs`）和曲线（`curve.mjs`）共用，
 * 只测「输入 → 文案/判定」，不碰 DOM（`showTip/hideTip` 在 Node 里是空操作）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { formatTip, snapText, frameOf, findConflict, showTip, hideTip, tipMounted } from '../app/editors/drag-tip.mjs';

test('snapText：三态映射，未知值一律「自由」', () => {
    assert.equal(snapText('frame'), '吸附:帧');
    assert.equal(snapText('grid'), '吸附:网格');
    assert.equal(snapText('off'), '自由');
    assert.equal(snapText(undefined), '自由');
    assert.equal(snapText('奇怪的值'), '自由');
});

test('frameOf：秒换算帧号（0 起算），非法 fps 返回 null', () => {
    assert.equal(frameOf(0, 12), 0);
    assert.equal(frameOf(1.417, 12), 17);
    assert.equal(frameOf(1 / 12, 12), 1);
    assert.equal(frameOf(1, 0), null);
    assert.equal(frameOf(1, -1), null);
    assert.equal(frameOf(1, NaN), null);
    assert.equal(frameOf(NaN, 12), null);
});

test('formatTip：秒 · 帧 · 缓动 · 吸附 四段齐全', () => {
    const r = formatTip({ t: 1.417, fps: 12, easeText: '线性', snapped: 'frame' });
    assert.equal(r.text, 't = 1.417 s · 第 17 帧 · 线性 · 吸附:帧');
    assert.equal(r.suffix, '');
});

test('formatTip：fps 缺失时不印帧号，但秒仍在', () => {
    assert.equal(formatTip({ t: 2, fps: undefined }).text, 't = 2.000 s');
});

test('formatTip：超时长单独一段', () => {
    assert.equal(formatTip({ t: 5, fps: 12, duration: 4 }).text, 't = 5.000 s · 第 60 帧 · 超出时长');
    // 刚好等于总时长不算超
    assert.equal(formatTip({ t: 4, fps: 12, duration: 4 }).text, 't = 4.000 s · 第 48 帧');
});

test('formatTip：NaN / 负数回落成占位，不印 NaN', () => {
    assert.equal(formatTip({ t: NaN }).text, 't = —');
    assert.equal(formatTip({ t: -1 }).text, 't = —');
    assert.equal(formatTip({}).text, 't = —');
});

test('formatTip：冲突后缀两种说法', () => {
    assert.equal(formatTip({ t: 1, conflict: 'blocked' }).suffix, '该时刻已有关键帧');
    assert.equal(formatTip({ t: 1, conflict: 'merge' }).suffix, '会合并到同一时刻');
    assert.equal(formatTip({ t: 1, conflict: 'none' }).suffix, '');
});

test('findConflict：目标刻被别的键占着 → blocked', () => {
    const keys = [{ layerId: 'a', t: 1 }, { layerId: 'a', t: 2 }];
    const r = findConflict({ keys, sel: [{ layerId: 'a', t: 1 }], fromT: 1, dt: 1, layerId: 'a' });
    assert.equal(r.kind, 'blocked');
    assert.deepEqual(r.hits, [{ layerId: 'a', t: 2 }]);
});

test('findConflict：目标刻空着 → none（空轨道也一样）', () => {
    const keys = [{ layerId: 'a', t: 1 }, { layerId: 'a', t: 3 }];
    assert.equal(findConflict({ keys, sel: [{ layerId: 'a', t: 1 }], fromT: 1, dt: 1, layerId: 'a' }).kind, 'none');
    assert.equal(findConflict({ keys: [], sel: [{ layerId: 'a', t: 1 }], fromT: 1, dt: 1, layerId: 'a' }).kind, 'none');
});

test('findConflict：目标刻落在集合内另一颗的旧位上 → merge', () => {
    const keys = [{ layerId: 'a', t: 1 }, { layerId: 'a', t: 2 }];
    const sel = [{ layerId: 'a', t: 1 }, { layerId: 'a', t: 2 }];
    const r = findConflict({ keys, sel, fromT: 1, dt: 1, layerId: 'a' });
    assert.equal(r.kind, 'merge');
    assert.deepEqual(r.hits, [{ layerId: 'a', t: 2 }]);
});

test('findConflict：别的层同刻不算冲突', () => {
    const keys = [{ layerId: 'a', t: 1 }, { layerId: 'b', t: 2 }];
    const r = findConflict({ keys, sel: [{ layerId: 'a', t: 1 }], fromT: 1, dt: 1, layerId: 'a' });
    assert.equal(r.kind, 'none');
});

test('findConflict：容差内的抖动算撞上，容差外不算', () => {
    const keys = [{ layerId: 'a', t: 1 }, { layerId: 'a', t: 2 }];
    const hit = findConflict({ keys, sel: [{ layerId: 'a', t: 1 }], fromT: 1, dt: 0.9999995, layerId: 'a' });
    assert.equal(hit.kind, 'blocked');
    const miss = findConflict({ keys, sel: [{ layerId: 'a', t: 1 }], fromT: 1, dt: 0.999, layerId: 'a' });
    assert.equal(miss.kind, 'none');
});

test('findConflict：dt/fromT 非数字时静默返回 none', () => {
    assert.equal(findConflict({ keys: [], sel: [], fromT: NaN, dt: 1 }).kind, 'none');
    assert.equal(findConflict({}).kind, 'none');
});

test('showTip/hideTip 在无 DOM 环境下是安全空操作', () => {
    assert.equal(tipMounted(), false);
    showTip({ t: 1, x: 0, y: 0 });
    assert.equal(tipMounted(), false);
    hideTip();
    assert.equal(tipMounted(), false);
});
