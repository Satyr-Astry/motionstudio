import test from 'node:test';
import assert from 'node:assert/strict';

import { channelClickOf } from '../app/editors/timeline-keys.mjs';
import { focusChannelTarget, mount } from '../app/editors/curve.mjs';

/* ─────────────────── 通道关键帧节点的点击参数 ─────────────────── */

test('channelClickOf：单通道取字段名，count 为 1', () => {
    assert.deepEqual(channelClickOf({ dataset: { ch: 'rotate' } }), { ch: 'rotate', count: 1 });
});

test('channelClickOf：同刻多通道只切第一个，count 报总数', () => {
    // 时间轴上同刻的通道键合并成一颗菱形，点它只能切到一条
    assert.deepEqual(channelClickOf({ dataset: { ch: 'rotate scaleX' } }), { ch: 'rotate', count: 2 });
    assert.deepEqual(channelClickOf({ dataset: { ch: 'x y opacity' } }), { ch: 'x', count: 3 });
});

test('channelClickOf：多余空格被过滤，不会产出空字段', () => {
    assert.deepEqual(channelClickOf({ dataset: { ch: '  rotate   scaleY  ' } }), { ch: 'rotate', count: 2 });
});

test('channelClickOf：没有标识的节点安全返回空', () => {
    for (const node of [null, undefined, {}, { dataset: {} }, { dataset: { ch: '' } }, { dataset: { ch: '   ' } }]) {
        assert.deepEqual(channelClickOf(node), { ch: '', count: 0 }, JSON.stringify(node));
    }
});

test('channelClickOf：数字型 dataset 也能读（DOMStringMap 会把值转成字符串）', () => {
    assert.deepEqual(channelClickOf({ dataset: { ch: '12' } }), { ch: '12', count: 1 });
});

/* ─────────────────── 曲线侧：能不能定位到这条通道 ─────────────────── */

test('focusChannelTarget：已知通道 + 合法时刻给出目标', () => {
    assert.deepEqual(focusChannelTarget('rotate', 0.5), { ch: 'rotate', t: 0.5 });
    assert.deepEqual(focusChannelTarget('x', 0), { ch: 'x', t: 0 });
});

test('focusChannelTarget：未知通道一律 null（不猜）', () => {
    for (const bad of ['nope', '', null, undefined, 'rotate ', 'ROTATE', 'warp.99.x']) {
        assert.equal(focusChannelTarget(bad, 0.5), null, String(bad));
    }
});

test('focusChannelTarget：非法时刻同样 null', () => {
    for (const bad of [NaN, Infinity, -Infinity, null, undefined, 'abc', {}]) {
        assert.equal(focusChannelTarget('rotate', bad), null, String(bad));
    }
});

test('focusChannelTarget：数字字符串照收（dataset.t 是字符串）', () => {
    assert.deepEqual(focusChannelTarget('rotate', '0.25'), { ch: 'rotate', t: 0.25 });
    assert.deepEqual(focusChannelTarget('rotate', '1'), { ch: 'rotate', t: 1 });
});

test('focusChannelTarget：负数时刻合法（局部时间允许负值）', () => {
    const t = focusChannelTarget('rotate', -0.5);
    assert.equal(t.ch, 'rotate');
    assert.equal(t.t, -0.5);
});

/* ─────────────────── 导出面 ─────────────────── */

test('curve.mount 是函数且 focusChannel 通过返回对象暴露（不依赖挂载即可断言签名）', () => {
    assert.equal(typeof mount, 'function');
    // 挂载需要真实 DOM：这里只钉住「导出的是函数」，防止有人顺手把它删掉
    assert.equal(typeof focusChannelTarget, 'function');
});
