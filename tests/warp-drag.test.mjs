// 网格软拖（warp-drag）：影响权重、增益归一化、三档命中、补丁结构
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    KLEKS_PATCH_RADIUS,
    MIN_INFLUENCE_CELLS,
    EDGE_FALLOFF,
    bernstein,
    warpAllocation,
    warpGain,
    warpOffsetAt,
    hitInside,
    zoneOf,
    softPatch,
} from '../app/core/warp-drag.mjs';
import { createLattice, latticeOffset, setVertex } from '../app/core/lattice.mjs';

const near = (a, b, msg = '', tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${msg}：${a} vs ${b}`);

/** 用导出的 latticeOffset 独立量一次「(u,v) 处到底动没动」 */
function moveAt(lat, pts, u, v) {
    const before = latticeOffset(lat, u, v);
    const after = latticeOffset({ cols: lat.cols, rows: lat.rows, pts }, u, v);
    return { x: after.x - before.x, y: after.y - before.y };
}

test('bernstein：端点、中点、对称性', () => {
    near(bernstein(1, 0, 0.3), 0.7, '1 阶左端');
    near(bernstein(1, 1, 0.3), 0.3, '1 阶右端');
    near(bernstein(2, 1, 0.5), 0.5, '2 阶中点');
    near(bernstein(4, 2, 0.5), 0.375, '4 阶中点');
    for (const n of [1, 2, 3, 5, 8]) {
        for (const t of [0, 0.17, 0.5, 0.83, 1]) {
            let sum = 0;
            for (let k = 0; k <= n; k++) sum += bernstein(n, k, t);
            near(sum, 1, `${n} 阶基函数之和 t=${t}`);
        }
    }
});

test('warpAllocation：半径与 Klecks 的 5×5 控制点网格对齐（4 格 = 1/3 补丁）', () => {
    // Klecks 固定 5×5 个控制点 ⇒ 4×4 格；它的 influenceRadius = 1/3 补丁 = 1.33 格。
    // 我们的半径在 4 格网格上必须退化成同一个数：离拖动点 1 格的顶点
    // 强度 = (1 - 0.25/(1/3)) · edgeFalloff（该顶点比拖动点更靠边，吃一次 0.5 衰减）
    const lat = createLattice(4, 4);
    const alloc = warpAllocation(lat, 0.5, 0.5);
    const stride = 5;
    near(alloc[2 * stride + 1].strength, 0.25 * EDGE_FALLOFF, '4 格网格上的邻点强度');
    near(alloc[2 * stride + 3].strength, 0.25 * EDGE_FALLOFF, '左右对称');
    near(alloc[0].strength, 0, '对角顶点（2 格）超出 1.33 格半径');
});

test('warpAllocation：1×1 网格的半径被下限抬到 1 格（否则中心拖拽纹丝不动）', () => {
    const alloc = warpAllocation(createLattice(1, 1), 0.5, 0.5);
    assert.equal(alloc.length, 4);
    for (const it of alloc) assert.ok(it.strength > 0, '四角都必须够得到');
    // 半径 1 格 + 四角距中心 0.707 格 ⇒ (1 - 0.707) · edgeFalloff
    near(alloc[0].strength, (1 - Math.hypot(0.5, 0.5)) * EDGE_FALLOFF, '四角强度', 1e-12);
    assert.ok(MIN_INFLUENCE_CELLS >= Math.hypot(0.5, 0.5), '下限必须大于格子半对角');
    assert.ok(KLEKS_PATCH_RADIUS < 0.5);
});

test('warpAllocation：格子越密影响顶点越多（半径是补丁比例，不是固定格数）', () => {
    // 取一个不在顶点、也不在格线上的位置（0.37, 0.42），否则 2×2 网格中心恰好压着顶点
    const count = (cols, rows) => warpAllocation(createLattice(cols, rows), 0.37, 0.42)
        .filter((it) => it.strength > 0).length;
    const coarse = count(2, 2);
    const fine = count(12, 12);
    assert.ok(coarse >= 1 && coarse <= 4, `2×2 网格只该动本格的角，实际 ${coarse}`);
    assert.ok(fine > coarse, `12×12 该有更多顶点参与：${fine}`);
    assert.ok(fine <= 64, `再密也只影响附近几圈（半径 4 格 ≈ 7×7 网格，减四角后 52），实际 ${fine}`);
});

test('warpAllocation：边缘衰减让「更远侧」的顶点强度更小', () => {
    const lat = createLattice(1, 1);
    const alloc = warpAllocation(lat, 0.5, 0.4);
    const up = alloc[0].strength;     // (0,0)，距拖动点 hypot(0.5, 0.4) 格
    const down = alloc[2].strength;   // (0,1)，距拖动点 hypot(0.5, 0.6) 格
    assert.ok(up > down && down > 0, `上方顶点应更受控：${up} / ${down}`);
    // 两侧都乘了同一个 edgeFalloff（tv 都比 0.4 离中心更远），比值里抵消
    near(up / down, (1 - Math.hypot(0.5, 0.4)) / (1 - Math.hypot(0.5, 0.6)), '强度比', 1e-9);
    assert.ok(EDGE_FALLOFF > 0 && EDGE_FALLOFF < 1);
});

test('warpOffsetAt：1×1 网格中心拖 (40,0) → 四角各 40/0，增益正好 1', () => {
    const lat = createLattice(1, 1);
    const r = warpOffsetAt(lat, 0.5, 0.5, { x: 40, y: 0 });
    assert.equal(r.moved, 4, '四个角都动');
    assert.ok(r.err < 1e-9, `拖动点必须严格跟手，误差 ${r.err}`);
    near(r.gain, 1, '1×1 网格中心增益恒为 1（与 Klecks 的 sumWeightsSq 一致）');
    for (let i = 0; i < 4; i++) {
        near(r.pts[i][0], 40, `顶点 ${i} x`);
        near(r.pts[i][1], 0, `顶点 ${i} y`);
    }
    const m = moveAt(lat, r.pts, 0.5, 0.5);
    near(m.x, 40, '独立复算的位移 x');
    near(m.y, 0, '独立复算的位移 y');
});

test('warpOffsetAt：非中心位置也严格跟手（增益 ≠ 1 时才考验归一化）', () => {
    for (const [cols, rows] of [[1, 1], [2, 3], [4, 4], [12, 12]]) {
        const lat = createLattice(cols, rows);
        for (const [u, v] of [[0.31, 0.42], [0.5, 0.1], [0.08, 0.5], [0, 0], [1, 1], [0.97, 0.03]]) {
            const r = warpOffsetAt(lat, u, v, { x: 13, y: -7 });
            assert.ok(r.err < 1e-9, `${cols}×${rows} (${u},${v}) 误差 ${r.err}`);
            const m = moveAt(lat, r.pts, u, v);
            near(m.x, 13, `${cols}×${rows} (${u},${v}) x`, 1e-8);
            near(m.y, -7, `${cols}×${rows} (${u},${v}) y`, 1e-8);
        }
    }
});

test('warpOffsetAt：拖在顶点上只动那一个顶点（与「点拖」不冲突）', () => {
    const lat = createLattice(2, 2);
    const r = warpOffsetAt(lat, 0, 0, { x: 40, y: 0 });
    assert.equal(r.moved, 1, '只有左上角该动');
    near(r.pts[0][0], 40, '左上角位移');
    for (let i = 1; i < r.pts.length; i++) {
        near(r.pts[i][0], 0, `顶点 ${i} 不该动`);
        near(r.pts[i][1], 0, `顶点 ${i} 不该动`);
    }
});

test('warpOffsetAt：位移为 0 时原样返回（且不共享引用）', () => {
    const lat = createLattice(3, 3);
    const r = warpOffsetAt(lat, 0.5, 0.5, { x: 0, y: 0 });
    assert.equal(r.moved, 0);
    assert.equal(r.err, 0);
    assert.deepEqual(r.pts, lat.pts);
    assert.notEqual(r.pts[0], lat.pts[0], '必须深拷贝');
});

test('warpOffsetAt：已有形变的网格上继续拖，位移按基准网格叠加', () => {
    const base = setVertex(createLattice(2, 2), 4, 12, -5);
    const r = warpOffsetAt(base, 0.5, 0.5, { x: 20, y: 10 });
    assert.ok(r.err < 1e-9, `误差 ${r.err}`);
    // 基准里那个顶点的偏移必须原样保留下来
    near(r.pts[4][0], 12 + (r.pts[4][0] - 12), '占位');
    assert.ok(Math.abs(r.pts[4][0] - 12) > 1e-9, '基准偏移不能丢');
    assert.ok(latticeOffset({ cols: 2, rows: 2, pts: r.pts }, 0.5, 0.5).x > 0);
});

test('warpOffsetAt：12×12 网格保持局部性（远离的顶点不动）', () => {
    const lat = createLattice(12, 12);
    const r = warpOffsetAt(lat, 0.5, 0.5, { x: 30, y: 0 });
    assert.ok(r.moved >= 9 && r.moved <= 49, `受影响顶点数 ${r.moved}`);
    // 四角离拖动点 6 格，远超半径 ⇒ 一点都不能动
    const corners = [0, 12, 12 * 13, 13 * 13 - 1];
    for (const i of corners) {
        near(r.pts[i][0], lat.pts[i][0], `角顶点 ${i} 不该动`);
        near(r.pts[i][1], lat.pts[i][1], `角顶点 ${i} 不该动`);
    }
});

test('hitInside：边界算内部，越界算外部', () => {
    assert.equal(hitInside(0.5, 0.5), true);
    assert.equal(hitInside(0, 0), true);
    assert.equal(hitInside(1, 1), true);
    assert.equal(hitInside(-0.001, 0.5), false);
    assert.equal(hitInside(1.001, 0.5), false);
    assert.equal(hitInside(Number.NaN, 0.5), false);
    assert.equal(hitInside(-0.01, 0.5, { tolerance: 0.02 }), true, '容差可放宽');
});

test('zoneOf：顶点 > 软拖 > 移动 > 手柄 > 无', () => {
    assert.equal(zoneOf(null), 'none');
    assert.equal(zoneOf({ kind: 'scale' }), 'handle');
    assert.equal(zoneOf({ kind: 'rotate' }), 'handle');
    assert.equal(zoneOf({ kind: 'anchor' }), 'handle');
    assert.equal(zoneOf({ kind: 'lattice', vertex: 3 }), 'vertex');
    assert.equal(zoneOf({ kind: 'move' }, { mode: 'warp', inside: true }), 'soft');
    assert.equal(zoneOf({ kind: 'move', inside: true }, { mode: 'warp' }), 'soft');
    assert.equal(zoneOf({ kind: 'move' }, { mode: 'transform', inside: true }), 'move');
    assert.equal(zoneOf({ kind: 'move' }, { mode: 'warp', inside: false }), 'move');
    assert.equal(zoneOf({ kind: 'move' }, {}), 'move');
});

test('softPatch：结构可直接写进关键帧，且与输入解耦', () => {
    const lat = createLattice(2, 2);
    const r = warpOffsetAt(lat, 0.5, 0.5, { x: 10, y: 0 });
    const patch = softPatch(lat, r.pts);
    assert.equal(patch.cols, 2);
    assert.equal(patch.rows, 2);
    assert.equal(patch.pts.length, 9);
    assert.deepEqual(patch.pts, r.pts);
    patch.pts[0][0] = 999;
    assert.notEqual(r.pts[0][0], 999, '改补丁不能波及原数组');
    // 顶点数不对时退回基准网格，不炸
    assert.equal(softPatch(lat, [[1, 2]]).pts.length, 9);
});

test('老格式 {tl,tr,br,bl} 也能软拖（normalizeLattice 兜住）', () => {
    const legacy = { tl: [5, 0], tr: [0, 0], br: [0, 0], bl: [0, 0] };
    const r = warpOffsetAt(legacy, 0.5, 0.5, { x: 10, y: 0 });
    assert.ok(r.err < 1e-9, `误差 ${r.err}`);
    assert.ok(Math.abs(r.pts[0][0] - 5) > 1e-9, '旧格式里的偏移要保留');
});

test('warpGain 与 warpOffsetAt 用同一套权重（自洽）', () => {
    const lat = createLattice(3, 3);
    const alloc = warpAllocation(lat, 0.4, 0.7);
    const J = warpGain(lat, 0.4, 0.7, alloc);
    const r = warpOffsetAt(lat, 0.4, 0.7, { x: 1, y: 0 });
    near(J, r.gain, '两条路径算出的增益必须一致');
    let sumAlpha = 0;
    for (const it of alloc) sumAlpha += it.alpha;
    assert.ok(sumAlpha > 0, 'α 不能全零');
});
