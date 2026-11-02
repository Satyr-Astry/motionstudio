// 骨骼 P3 增强：两骨链的解析解与肘部朝向（`app/core/ik.mjs`）。
//
// 为什么单独一个文件：CCD 那套是「迭代逼近」，两骨解析解是「一步算准」，
// 两者的验收标准不同 —— 解析解要求 1e-6 量级命中（迭代解只到 1e-3），
// 而且它多了一个能力：**指定肘部朝左还是朝右**。混在 ik.test.mjs 里会让
// 「哪条路径在负责什么」变得模糊。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDoc, makeObject } from '../app/core/doc-model.mjs';
import { applyMatrix, elementMatrix, elementSize, anchorPoint } from '../app/core/element.mjs';
import { localTimeOf } from '../app/core/timegraph.mjs';
import { IK_BENDS, normalizeIk, resetIkCache, solveIk } from '../app/core/ik.mjs';

const docOf = (objects) => {
    const doc = createDoc({ width: 800, height: 600, objects });
    for (const src of objects) {
        if (!src || !src.ik) continue;
        const t = doc.objects.find((o) => o && o.id === src.id);
        if (t) t.ik = src.ik;
    }
    return doc;
};

function bone(id, extra = {}) {
    return makeObject({
        id,
        name: id,
        kind: 'bone',
        bone: { len: 120, width: 14 },
        transform: { keys: [{ t: 0, state: { x: 0, y: 0 } }] },
        ...extra,
    });
}
const targetAt = (x, y) => makeObject({ id: 't1', name: 'T', kind: 'paint', transform: { keys: [{ t: 0, state: { x, y } }] } });

/** 两根骨组成的链：a 在原点，b 挂在 a 的末端。返回 doc 与 tip 的世界坐标读取器。 */
function twoBone(target, ik) {
    const a = bone('a');
    const b = bone('b', { parentId: 'a', transform: { keys: [{ t: 0, state: { x: 120, y: 0 } }] }, ik });
    const doc = docOf([a, b, targetAt(target.x, target.y)]);
    return doc;
}

/** 用解算后的矩阵读「中关节」(b 的根) 与「末端」(b 的尖) 的世界坐标。 */
function jointsOf(doc, sol) {
    const b = doc.objects.find((o) => o.id === 'b');
    const mb = sol.get('b');
    const pivot = anchorPoint(b, elementSize(doc, b, localTimeOf(doc, b, 0)));
    const size = elementSize(doc, b, localTimeOf(doc, b, 0));
    const P1 = applyMatrix(mb, pivot);
    const E = applyMatrix(mb, { x: size.w - pivot.x, y: size.h / 2 });
    return { P1, E };
}

/**
 * 肘部在中线哪一侧。
 *
 * 用 cross(根→目标, 根→肘) = vx·uy − vy·ux：正号 = 肘部在「顺时针一侧」
 * （屏幕坐标 y 向下，所以视觉上是偏向 +y 那侧）。约定 right=+1 / left=−1。
 */
function elbowSide(doc, sol, target) {
    const a = doc.objects.find((o) => o.id === 'a');
    const joint = anchorPoint(a, elementSize(doc, a, localTimeOf(doc, a, 0)));
    const P0 = applyMatrix(sol.get('a'), joint);
    const { P1 } = jointsOf(doc, sol);
    const ux = P1.x - P0.x;
    const uy = P1.y - P0.y;
    const vx = target.x - P0.x;
    const vy = target.y - P0.y;
    return Math.sign(vx * uy - vy * ux);
}

test('两骨链解析解：可达目标命中误差 < 1e-6（比 CCD 的 1e-3 精确三个数量级）', () => {
    resetIkCache();
    const doc = twoBone({ x: 100, y: 7 }, { targetId: 't1', chain: 2, bend: 'auto' });
    const sol = solveIk(doc, 0);
    const { E } = jointsOf(doc, sol);
    const d = Math.hypot(E.x - 100, E.y - 7);
    assert.ok(d < 1e-6, '解析解应当一步命中，实际偏差 ' + d);
});

test('bend:left / bend:right 让肘部落在中线两侧（互为镜像）', () => {
    resetIkCache();
    const left = twoBone({ x: 100, y: 7 }, { targetId: 't1', chain: 2, bend: 'left' });
    const right = twoBone({ x: 100, y: 7 }, { targetId: 't1', chain: 2, bend: 'right' });
    const sl = solveIk(left, 0);
    const sideL = elbowSide(left, sl, { x: 100, y: 7 });
    resetIkCache();
    const sr = solveIk(right, 0);
    const sideR = elbowSide(right, sr, { x: 100, y: 7 });
    assert.equal(sideL, -1, 'left 应把肘部放在负侧，实际 ' + sideL);
    assert.equal(sideR, 1, 'right 应把肘部放在正侧，实际 ' + sideR);
    // 两侧都要命中目标（只是姿态不同）
    for (const [doc, sol] of [[left, sl], [right, sr]]) {
        const { E } = jointsOf(doc, sol);
        assert.ok(Math.hypot(E.x - 100, E.y - 7) < 1e-6, '两种 bend 都必须命中目标');
    }
});

test('bend:auto 保持当前那侧（不因为目标轻微移动就翻面）', () => {
    resetIkCache();
    // 初始姿态：直链朝 +x。目标放在上方偏左，auto 应沿用当前叉积符号
    const doc = twoBone({ x: 100, y: 7 }, { targetId: 't1', chain: 2, bend: 'auto' });
    const sol = solveIk(doc, 0);
    const side1 = elbowSide(doc, sol, { x: 100, y: 7 });
    assert.ok(side1 === 1 || side1 === -1, 'auto 必须给出某一侧');
    // 极小移动目标后，同一侧不翻
    resetIkCache();
    const doc2 = twoBone({ x: 101, y: 7.5 }, { targetId: 't1', chain: 2, bend: 'auto' });
    const sol2 = solveIk(doc2, 0);
    assert.equal(elbowSide(doc2, sol2, { x: 101, y: 7.5 }), side1, '轻微移动不该让肘部翻面');
});

test('解析解仍处理够不着：太远伸直、太近折叠，都不抛错也不产 NaN', () => {
    resetIkCache();
    const far = twoBone({ x: 900, y: 7 }, { targetId: 't1', chain: 2, bend: 'auto' });
    const sf = solveIk(far, 0);
    const { E: Ef, P1: P1f } = jointsOf(far, sf);
    for (const v of [Ef.x, Ef.y, P1f.x, P1f.y]) assert.ok(Number.isFinite(v), '伸直后不许有 NaN');
    // 伸直：中关节与末端几乎共线（叉积接近 0）
    const a = far.objects.find((o) => o.id === 'a');
    const P0 = applyMatrix(sf.get('a'), anchorPoint(a, elementSize(far, a, localTimeOf(far, a, 0))));
    const cross = Math.abs((P1f.x - P0.x) * (Ef.y - P0.y) - (P1f.y - P0.y) * (Ef.x - P0.x));
    assert.ok(cross < 1, '够不着时应伸直（共线），叉积 ' + cross);

    resetIkCache();
    // 太近：目标几乎贴着根关节
    const near = twoBone({ x: 5, y: 7 }, { targetId: 't1', chain: 2, bend: 'auto' });
    const sn = solveIk(near, 0);
    const { E: En } = jointsOf(near, sn);
    assert.ok(Number.isFinite(En.x) && Number.isFinite(En.y), '折叠后不许有 NaN');
});

test('三骨及以上仍走 CCD（解析解只负责两骨）', () => {
    resetIkCache();
    const a = bone('a');
    const b = bone('b', { parentId: 'a', transform: { keys: [{ t: 0, state: { x: 120, y: 0 } }] } });
    const c = bone('c', { parentId: 'b', transform: { keys: [{ t: 0, state: { x: 120, y: 0 } }] }, ik: { targetId: 't1', chain: 3, iterations: 32 } });
    const doc = docOf([a, b, c, targetAt(150, 7)]);
    const sol = solveIk(doc, 0);
    assert.ok(sol.size >= 3, '三骨链应有覆盖');
    for (const [, m] of sol) for (const k of ['a', 'b', 'c', 'd', 'e', 'f']) assert.ok(Number.isFinite(m[k]), '矩阵必须有限');
});

test('IK_BENDS 只认三个值，normalizeIk 的缺省是 auto', () => {
    assert.deepEqual([...IK_BENDS], ['auto', 'left', 'right']);
    assert.equal(normalizeIk({ targetId: 'x' }).bend, 'auto');
    assert.equal(normalizeIk({ targetId: 'x', bend: 'right' }).bend, 'right');
    assert.equal(normalizeIk({ targetId: 'x', bend: 'UP' }).bend, 'auto');
});
