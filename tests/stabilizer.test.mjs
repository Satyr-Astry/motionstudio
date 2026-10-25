import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_LEVEL,
    LEVEL_ALPHA,
    MAX_LEVEL,
    MIN_STEP,
    alphaFor,
    clampLevel,
    createStabilizer,
} from '../app/paint/stabilizer.mjs';

test('clampLevel：0–5 取整，越界夹紧，非数字回落默认档', () => {
    assert.equal(clampLevel(0), 0);
    assert.equal(clampLevel(5), 5);
    assert.equal(clampLevel(-3), 0);
    assert.equal(clampLevel(9), 5);
    assert.equal(clampLevel(2.4), 2);
    assert.equal(clampLevel(2.6), 3);
    assert.equal(clampLevel('3'), 3, '数字字符串也认');
    assert.equal(clampLevel('abc'), DEFAULT_LEVEL);
    assert.equal(clampLevel(null), DEFAULT_LEVEL);
    assert.equal(clampLevel(undefined), DEFAULT_LEVEL);
    assert.equal(clampLevel(NaN), DEFAULT_LEVEL);
    assert.equal(clampLevel(Infinity), DEFAULT_LEVEL, 'Infinity 不是有限数，回落');
});

test('alphaFor / LEVEL_ALPHA：档位越高系数越小，且都在 (0, 1]', () => {
    assert.equal(DEFAULT_LEVEL, 0);
    assert.equal(MAX_LEVEL, 5);
    assert.equal(LEVEL_ALPHA.length, MAX_LEVEL + 1);
    assert.equal(alphaFor(0), 1, 'level 0 = 直通');
    for (let i = 1; i < LEVEL_ALPHA.length; i += 1) {
        assert.ok(LEVEL_ALPHA[i] < LEVEL_ALPHA[i - 1], 'α 必须随档位严格递减');
        assert.ok(LEVEL_ALPHA[i] > 0 && LEVEL_ALPHA[i] <= 1);
    }
    assert.equal(alphaFor(99), alphaFor(5), '越界档位按最高档取系数');
    assert.equal(alphaFor(-1), alphaFor(0));
});

test('level 0：输出逐位等于输入（不改变既有手感）', () => {
    const s = createStabilizer(0);
    const pts = [[10, 20], [11.5, 20.25], [-3, 0.5], [0, 0]];
    for (const [x, y] of pts) {
        const r = s.push(x, y);
        assert.deepEqual({ x: r.x, y: r.y, moved: r.moved }, { x, y, moved: true });
        assert.deepEqual(r.target, { x, y });
    }
});

test('level 越大跟随越慢：同一点第一次 push 的推进量单调减小', () => {
    const offsets = [];
    for (let level = 0; level <= MAX_LEVEL; level += 1) {
        const s = createStabilizer(level);
        s.push(0, 0);              // 起笔
        const r = s.push(100, 0);  // 一步拖到 100
        offsets.push(r.x);
    }
    assert.equal(offsets[0], 100, 'level 0 一步到位');
    for (let i = 1; i < offsets.length; i += 1) {
        assert.ok(offsets[i] < offsets[i - 1], `level ${i} 应比 level ${i - 1} 慢`);
    }
    assert.ok(offsets[MAX_LEVEL] < 100 * 0.2, 'level 5 一步只走一小段（强阻尼）');
});

test('level 越大跟随越慢：同样三次 push 之后笔尖离目标更远', () => {
    const reach = (level) => {
        const s = createStabilizer(level);
        s.push(0, 0);                       // 起笔
        let last = 0;
        for (let i = 1; i <= 3; i += 1) {
            const r = s.push(100, 0);
            if (r.moved) last = r.x;
        }
        return last;
    };
    const byLevel = [];
    for (let level = 0; level <= MAX_LEVEL; level += 1) byLevel.push(reach(level));
    assert.equal(byLevel[0], 100, 'level 0 三次 push 早已到位');
    for (let i = 1; i < byLevel.length; i += 1) {
        assert.ok(byLevel[i] < byLevel[i - 1], `level ${i} 应比 level ${i - 1} 落后`);
    }
});

test('不松手时会有固定残差（阈值死区），所以必须靠 target 追平线尾', () => {
    const s = createStabilizer(5);
    s.push(0, 0);
    for (let i = 0; i < 400; i += 1) s.push(100, 0);
    // 笔停住后平滑点收敛到 100 附近，但最小移动阈值让它不再落笔 —— 收敛由 target 负责
    const tail = s.push(100, 0);
    assert.equal(tail.moved, false, '静止时不该再落笔');
    assert.deepEqual(tail.target, { x: 100, y: 0 }, 'target 始终是原始输入，供松手追平');
});

test('最小移动阈值：亚像素抖动不落点（moved=false），且不把阈值一点点吃掉', () => {
    const s = createStabilizer(1);   // α = 0.6
    s.push(0, 0);
    const seen = [];
    for (let i = 1; i <= 6; i += 1) seen.push(s.push(0.05 * i, 0));
    // 累积位移 ≈ 0.05*6*0.6 量级，远小于 0.75，全都该被吞掉
    assert.ok(seen.every((r) => r.moved === false), '抖动期不该落笔');
    assert.ok(seen.every((r) => r.x === 0 && r.y === 0), '被吞掉时坐标停在上一个输出点');
    assert.equal(MIN_STEP, 0.75);

    // 跨过一次真实移动后应恢复落笔
    let out = null;
    for (let i = 1; i <= 40 && !(out && out.moved); i += 1) out = s.push(i * 2, 0);
    assert.ok(out.moved, '真实位移必须能落笔');
});

test('reset()：清空滤波与阈值状态，下一次 push 当作起笔', () => {
    const s = createStabilizer(5);
    s.push(0, 0);
    const far = s.push(100, 0);
    assert.ok(far.x < 20, '强阻尼下不该一步到位');
    s.reset();
    const r = s.push(50, 50);
    assert.deepEqual({ x: r.x, y: r.y, moved: r.moved }, { x: 50, y: 50, moved: true });
});

test('非法档位回落，且 setLevel 中途改档不抛、保留位置', () => {
    const bad = createStabilizer('nope');
    assert.equal(bad.level, DEFAULT_LEVEL);
    const r = bad.push(3, 4);
    assert.deepEqual({ x: r.x, y: r.y, moved: r.moved }, { x: 3, y: 4, moved: true });

    const s = createStabilizer(1);
    s.push(0, 0);
    s.push(100, 0);
    assert.equal(s.setLevel(3), 3);
    assert.equal(s.level, 3);
    const after = s.push(100, 0);
    assert.ok(Number.isFinite(after.x) && Number.isFinite(after.y));
    assert.equal(s.setLevel(-9), 0, '非法档位按 clampLevel 收口');
});
