// 时间重映射缓动（retime ease）：让「时间流速」本身非线性。
//
// 语义：区间 [from, from+span] 内，位置 u 先经缓动曲线映射成 u'，再还原成秒。
// 只在单调模式（none / clamp）生效；loop / pingpong 是周期性的，加缓动会破坏首尾相等。
import test from 'node:test';
import assert from 'node:assert/strict';

import { applyTime, isIdentityTime, normalizeTime, describeTime, TIME_EASES } from '../app/core/timegraph.mjs';

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('ease 字段默认 linear，非法值归一成 linear', () => {
    assert.equal(normalizeTime({}).ease, 'linear');
    assert.equal(normalizeTime({ ease: 'bogus' }).ease, 'linear');
    assert.equal(normalizeTime({ ease: 'in' }).ease, 'in');
    assert.deepEqual([...TIME_EASES], ['linear', 'in', 'out', 'inout']);
});

test('只有 ease 非 linear 时不再算恒等', () => {
    assert.equal(isIdentityTime({}), true);
    assert.equal(isIdentityTime({ ease: 'linear' }), true);
    assert.equal(isIdentityTime({ ease: 'in' }), false);
});

test('ease:in —— 区间中点被压到 25%', () => {
    // from 0、to 2（span 2），全局 t=1 落在区间中点 u=0.5
    const time = { from: 0, to: 2, ease: 'in' };
    // u' = 0.25 → 局部时间 0.5
    assert.ok(near(applyTime(time, 1, 2), 0.5), String(applyTime(time, 1, 2)));
});

test('ease:out —— 区间中点被推到 75%', () => {
    const time = { from: 0, to: 2, ease: 'out' };
    // u' = 0.75 → 局部时间 1.5
    assert.ok(near(applyTime(time, 1, 2), 1.5), String(applyTime(time, 1, 2)));
});

test('ease:inout —— 两侧对称（0.25→0.125、0.75→0.875）', () => {
    const time = { from: 0, to: 4, ease: 'inout' };
    assert.ok(near(applyTime(time, 1, 4), 0.5), String(applyTime(time, 1, 4)));
    assert.ok(near(applyTime(time, 3, 4), 3.5), String(applyTime(time, 3, 4)));
});

test('ease 与 offset / scale 叠加：先平移缩放，再重映射', () => {
    // offset 0.5、scale 2 → raw = (1 - 0.5) * 2 = 1；区间 0–2 的 u=0.5 → ease in → 0.5
    const time = { offset: 0.5, scale: 2, from: 0, to: 2, ease: 'in' };
    assert.ok(near(applyTime(time, 1, 2), 0.5), String(applyTime(time, 1, 2)));
});

test('loop 模式忽略 ease（保住循环接缝）', () => {
    const base = { from: 0, to: 2, mode: 'loop' };
    const eased = applyTime({ ...base, ease: 'in' }, 4.5, 2);
    const plain = applyTime(base, 4.5, 2);
    assert.ok(near(eased, plain), eased + ' vs ' + plain);
});

test('pingpong 模式忽略 ease', () => {
    const base = { from: 0, to: 2, mode: 'pingpong' };
    assert.ok(near(applyTime({ ...base, ease: 'out' }, 1, 2), applyTime(base, 1, 2)));
});

test('clamp 模式下区间内仍做缓动', () => {
    const time = { from: 0, to: 2, mode: 'clamp', ease: 'in' };
    assert.ok(near(applyTime(time, 1, 2), 0.5), String(applyTime(time, 1, 2)));
    // 超出区间被夹住，不施加缓动
    assert.ok(near(applyTime(time, 5, 2), 2), String(applyTime(time, 5, 2)));
});

test('区间外（u<=0 或 u>=1）不施加缓动', () => {
    const time = { from: 1, to: 3, ease: 'in' };
    assert.ok(near(applyTime(time, 0.5, 3), 0.5), String(applyTime(time, 0.5, 3)));
    assert.ok(near(applyTime(time, 4, 3), 4), String(applyTime(time, 4, 3)));
});

test('holding / scale=0 优先级高于 ease', () => {
    assert.equal(applyTime({ hold: true, holdAt: 1.2, ease: 'in' }, 5, 3), 1.2);
    assert.equal(applyTime({ scale: 0, holdAt: 0.8, ease: 'in' }, 5, 3), 0.8);
});

test('describeTime 会提到缓动档位', () => {
    assert.match(describeTime({ ease: 'in' }), /缓动/);
    assert.match(describeTime({ ease: 'out' }), /缓动/);
    assert.equal(describeTime({ ease: 'linear' }), '无时间变换');
});
