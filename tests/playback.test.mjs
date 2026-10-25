// 预览播放的纯逻辑：四种方式的时间映射 + 速度档位。
//
// 为什么先测纯函数：`playLoop` 跑在 rAF 里、要真的有一份文档与引擎，端到端只能验
// 「播了几秒后停在哪儿」；而「累计秒 → 显示时刻」的每一条边界（末尾折返、单次到底、
// 反向起播）都是纯算术，能在这里逐条钉住。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    PLAY_MODES, PLAY_MODE_IDS, SPEEDS, DEFAULT_SPEED, LOOP_REVERSE,
    clampSpeed, formatSpeed, isPlayMode, modeInfo, nextSpeed, playbackAt,
} from '../app/core/playback.mjs';
import { LOOP_CYCLE, LOOP_NONE, LOOP_PINGPONG } from '../app/core/cel.mjs';

test('播放方式表：四种，id 与文档字段同值', () => {
    assert.deepEqual(PLAY_MODE_IDS, [LOOP_CYCLE, LOOP_PINGPONG, LOOP_REVERSE, LOOP_NONE]);
    assert.deepEqual(PLAY_MODE_IDS, ['cycle', 'pingpong', 'reverse', 'none']);
    for (const m of PLAY_MODES) {
        assert.equal(typeof m.label, 'string');
        assert.ok(m.label.length > 0, m.id + ' 缺中文名');
        assert.equal(typeof m.icon, 'string');
        assert.ok(m.hint.length > 0, m.id + ' 缺一句话说明（按钮 title 要用）');
    }
});

test('isPlayMode 只认这四个，未知字符串一律 false', () => {
    for (const id of PLAY_MODE_IDS) assert.equal(isPlayMode(id), true);
    for (const bad of ['loop', 'ping-pong', 'REVERSE', '', null, undefined, 0]) {
        assert.equal(isPlayMode(bad), false, String(bad) + ' 不该被当成播放方式');
    }
});

test('clampSpeed：夹到 0.25–4，非数字退回 1', () => {
    assert.equal(clampSpeed(1), 1);
    assert.equal(clampSpeed('1.5'), 1.5);
    assert.equal(clampSpeed(0.1), 0.25);
    assert.equal(clampSpeed(0), DEFAULT_SPEED);
    assert.equal(clampSpeed(-2), DEFAULT_SPEED);
    assert.equal(clampSpeed(9), 4);
    assert.equal(clampSpeed(NaN), DEFAULT_SPEED);
    assert.equal(clampSpeed(null), DEFAULT_SPEED);
    assert.equal(clampSpeed(undefined), DEFAULT_SPEED);
    // 档位表自身必须在夹取范围内，否则换档会撞到夹取边界
    for (const v of SPEEDS) assert.equal(clampSpeed(v), v);
});

test('nextSpeed：就近落档再前后挪一格，两端回绕', () => {
    assert.equal(nextSpeed(1, 1), 1.5);
    assert.equal(nextSpeed(1, -1), 0.5);
    assert.equal(nextSpeed(1), 1.5, 'dir 缺省为 +1');
    assert.equal(nextSpeed(4, 1), 0.25, '最大档再往上回到最小档');
    assert.equal(nextSpeed(0.25, -1), 4, '最小档再往下回到最大档');
    // 不在表里的值先就近落档：1.2 最近是 1，往下是 0.5
    assert.equal(nextSpeed(1.2, -1), 0.5);
    assert.equal(nextSpeed(1.2, 1), 1.5);
    // 坏值按 1 处理
    assert.equal(nextSpeed(NaN, 1), 1.5);
});

test('formatSpeed：整数不带小数点，其余最多两位', () => {
    assert.equal(formatSpeed(1), '1×');
    assert.equal(formatSpeed(2), '2×');
    assert.equal(formatSpeed(0.5), '0.5×');
    assert.equal(formatSpeed(1.5), '1.5×');
    assert.equal(formatSpeed(0.25), '0.25×');
    assert.equal(formatSpeed(NaN), '1×', '坏值退回原速读数');
});

test('modeInfo：未知值按循环处理（旧存档只有 cycle / pingpong / none）', () => {
    assert.equal(modeInfo('pingpong').label, '来回');
    assert.equal(modeInfo('reverse').label, '反向循环');
    assert.equal(modeInfo('none').label, '单次');
    assert.equal(modeInfo('').label, '循环');
    assert.equal(modeInfo(undefined).label, '循环');
});

test('playbackAt · 循环：acc 折叠进 [0,total)', () => {
    assert.deepEqual(playbackAt(0, 2, 'cycle'), { t: 0, done: false });
    assert.deepEqual(playbackAt(0.5, 2, 'cycle'), { t: 0.5, done: false });
    assert.deepEqual(playbackAt(2.5, 2, 'cycle'), { t: 0.5, done: false });
    assert.deepEqual(playbackAt(4, 2, 'cycle'), { t: 0, done: false });
    assert.deepEqual(playbackAt(-0.3, 2, 'cycle'), { t: 0, done: false }, '负累计不该出负数');
});

test('playbackAt · 来回：到末尾折返，三角波两个方向对称', () => {
    const total = 2;
    const at = (a) => playbackAt(a, total, 'pingpong').t;
    assert.equal(at(0), 0);
    assert.equal(at(1), 1);
    assert.equal(at(2), 2);
    assert.equal(at(3), 1, '过了末尾往回走');
    assert.equal(at(4), 0, '一个来回回到开头');
    assert.equal(at(3.5), 0.5);
    // 对称性：折返点是**末尾**，所以在 total 两侧等距的累计量应落到同一时刻
    for (const d of [0.1, 0.25, 0.5]) {
        assert.ok(Math.abs(at(total - d) - at(total + d)) < 1e-12, '在 ' + total + ' s 处应镜像对称');
    }
});

test('playbackAt · 反向循环：从末尾往开头走，走完一圈回到末尾', () => {
    const total = 2;
    const at = (a) => playbackAt(a, total, 'reverse').t;
    assert.equal(at(0), 2, '起点在末尾');
    assert.equal(at(0.5), 1.5);
    assert.equal(at(1), 1);
    assert.equal(at(1.5), 0.5);
    assert.equal(at(2), 2, '走完一圈回到末尾，不是 0');
    assert.equal(at(2.5), 1.5);
    // 反向与正向逐点互补
    for (const a of [0.3, 0.7, 1.1, 1.9]) {
        const fwd = playbackAt(a, total, 'cycle').t;
        const rev = at(a);
        assert.ok(Math.abs(fwd + rev - total) < 1e-12 || Math.abs(rev - total) < 1e-12,
            't=' + a + '：' + fwd + ' + ' + rev + ' 应等于 ' + total);
    }
});

test('playbackAt · 单次：到末尾停下并报告 done，之后一直停在末尾', () => {
    assert.deepEqual(playbackAt(0.5, 2, 'none'), { t: 0.5, done: false });
    assert.deepEqual(playbackAt(2, 2, 'none'), { t: 2, done: true }, '正好到末尾即完成');
    assert.deepEqual(playbackAt(9, 2, 'none'), { t: 2, done: true }, '越界仍停在末尾');
    assert.equal(playbackAt(1.99, 2, 'none').done, false);
});

test('playbackAt · 退化输入：总时长为 0 / 非有限 / acc 非数字都退到 0 且不报完成', () => {
    for (const total of [0, -1, NaN, undefined, null]) {
        assert.deepEqual(playbackAt(1, total, 'cycle'), { t: 0, done: false });
        assert.deepEqual(playbackAt(1, total, 'none'), { t: 0, done: false });
    }
    for (const acc of [NaN, undefined, null, Infinity]) {
        assert.deepEqual(playbackAt(acc, 2, 'cycle'), { t: 0, done: false }, 'acc=' + String(acc));
    }
});

test('playbackAt · 不认识的模式按循环处理（不抛错、不再多一套行为）', () => {
    assert.deepEqual(playbackAt(2.5, 2, 'what'), playbackAt(2.5, 2, 'cycle'));
    assert.deepEqual(playbackAt(2.5, 2, undefined), playbackAt(2.5, 2, 'cycle'));
});

test('playbackAt · 累计量单调增长时输出连续（不出现跳变）', () => {
    const total = 3;
    let prev = null;
    for (let i = 0; i <= 300; i++) {
        const a = (i / 100) * 1; // 0 → 3 s，覆盖恰好一整圈
        const { t } = playbackAt(a, total, 'cycle');
        if (prev != null && i > 0 && Math.abs(a - total) > 1e-9) {
            // 除了跨圈那一个点，相邻采样之间的步长都不该超过采样间隔
            const d = Math.abs(t - prev);
            assert.ok(d <= 0.01 + 1e-9 || d >= total - 0.01, 'a=' + a + ' 出现跳变：' + prev + ' → ' + t);
        }
        prev = t;
    }
});
