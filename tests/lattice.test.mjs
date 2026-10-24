// 网格 warp（lattice）的纯几何行为：顶点序、双线性、反解、重采样、插值
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MAX_DIV,
    createLattice,
    normalizeLattice,
    vertexCount,
    vertexUV,
    setVertex,
    latticeToQuad,
    latticeFromQuad,
    latticeIsZero,
    latticeOffset,
    latticePoint,
    cellQuad,
    lerpLattice,
    resizeLattice,
    latticeBounds,
    latticeInverse,
    latticeWireframe,
} from '../app/core/lattice.mjs';

const near = (a, b, m = '', tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${m} ${a} vs ${b}`);

test('vertexCount 与顶点序号：行优先 (cols+1)*(rows+1)', () => {
    assert.equal(vertexCount(1, 1), 4);
    assert.equal(vertexCount(2, 3), 12);
    assert.equal(vertexCount(0, 0), 4); // 至少 1×1
    assert.equal(vertexCount(-5, 2), 6); // 非法列数按 1 处理
});

test('createLattice 生成零偏移网格', () => {
    const L = createLattice(2, 2);
    assert.equal(L.cols, 2);
    assert.equal(L.rows, 2);
    assert.equal(L.pts.length, 9);
    for (const p of L.pts) assert.deepEqual(p, [0, 0]);
});

test('normalizeLattice 把旧四角格式升级成 1×1 网格', () => {
    const L = normalizeLattice({ tl: [1, 2], tr: [3, 4], br: [5, 6], bl: [7, 8] });
    assert.equal(L.cols, 1);
    assert.equal(L.rows, 1);
    // pts 顺序 [tl, tr, bl, br]
    assert.deepEqual(L.pts, [[1, 2], [3, 4], [7, 8], [5, 6]]);
});

test('normalizeLattice 对 null / 非对象返回 null', () => {
    assert.equal(normalizeLattice(null), null);
    assert.equal(normalizeLattice(undefined), null);
    assert.equal(normalizeLattice(42), null);
    assert.equal(normalizeLattice('warp'), null);
});

test('normalizeLattice 归一化已有网格：钳制行列数并补齐顶点', () => {
    const L = normalizeLattice({ cols: 99, rows: 1, pts: [[1, 1]] });
    assert.equal(L.cols, MAX_DIV);
    assert.equal(L.rows, 1);
    assert.equal(L.pts.length, vertexCount(MAX_DIV, 1));
    assert.deepEqual(L.pts[0], [1, 1]);
    assert.deepEqual(L.pts[1], [0, 0]);
});

test('vertexUV：左上 (0,0)、右下 (1,1)', () => {
    const L = createLattice(2, 2);
    assert.deepEqual(vertexUV(L, 0), [0, 0]);
    assert.deepEqual(vertexUV(L, 2), [1, 0]);
    assert.deepEqual(vertexUV(L, 6), [0, 1]);
    assert.deepEqual(vertexUV(L, 8), [1, 1]);
    assert.deepEqual(vertexUV(L, 4), [0.5, 0.5]);
});

test('setVertex 不改原网格，返回新对象', () => {
    const L = createLattice(1, 1);
    const M = setVertex(L, 0, 5, -3);
    assert.deepEqual(L.pts[0], [0, 0]);
    assert.deepEqual(M.pts[0], [5, -3]);
});

test('latticeToQuad / latticeFromQuad 互为逆（1×1）', () => {
    const q = { tl: [1, 2], tr: [30, 0], br: [28, 40], bl: [0, 44] };
    const L = latticeFromQuad(q);
    assert.equal(L.cols, 1);
    assert.deepEqual(latticeToQuad(L), q);
});

test('latticeIsZero：全零为真，任一顶点偏移为假', () => {
    assert.equal(latticeIsZero(createLattice(2, 2)), true);
    assert.equal(latticeIsZero({ cols: 1, rows: 1, pts: [[0, 0], [0, 0.5], [0, 0], [0, 0]] }), false);
});

test('latticeOffset 零网格恒为 0', () => {
    const L = createLattice(2, 2);
    for (const [u, v] of [[0, 0], [0.3, 0.7], [1, 1], [0.5, 0.5]]) {
        const o = latticeOffset(L, u, v);
        assert.deepEqual(o, { x: 0, y: 0 });
    }
});

test('latticeOffset 单顶点偏移只影响相邻 cell，并在顶点处取到该偏移', () => {
    const L = setVertex(createLattice(2, 2), 4, 10, 20); // 中心顶点
    near(latticeOffset(L, 0.5, 0.5).x, 10);
    near(latticeOffset(L, 0.5, 0.5).y, 20);
    // 角落顶点不受中心偏移影响
    near(latticeOffset(L, 0, 0).x, 0);
    near(latticeOffset(L, 1, 1).y, 0);
    // 相邻 cell 的边界（u=0.5,v=0）应有半个偏移量
    near(latticeOffset(L, 0.5, 0).y, 0);
    near(latticeOffset(L, 0.25, 0.25).x, 2.5);
});

test('latticePoint：零网格等于矩形上的 (u*w, v*h)', () => {
    const L = createLattice(3, 3);
    const p = latticePoint(L, 200, 100, 0.25, 0.75);
    near(p.x, 50);
    near(p.y, 75);
});

test('latticePoint：顶点偏移直接叠加到矩形坐标', () => {
    const L = setVertex(createLattice(1, 1), 0, -7, 9); // tl
    const p = latticePoint(L, 100, 80, 0, 0);
    near(p.x, -7);
    near(p.y, 9);
    const c = latticePoint(L, 100, 80, 1, 1);
    near(c.x, 100);
    near(c.y, 80);
});

test('cellQuad：返回该 cell 的四角绝对坐标', () => {
    const L = createLattice(2, 1);
    const q = cellQuad(L, 100, 100, 1, 0); // 右半
    near(q.tl.x, 50);
    near(q.tr.x, 100);
    near(q.br.y, 100);
    near(q.bl.x, 50);
});

test('latticeInverse：零网格上正反解一致', () => {
    const L = createLattice(2, 2);
    for (const [u, v] of [[0, 0], [0.5, 0.5], [1, 1], [0.2, 0.8]]) {
        const p = latticePoint(L, 120, 90, u, v);
        const back = latticeInverse(L, 120, 90, p);
        assert.ok(back, `应能反解 ${u},${v}`);
        near(back[0], u, 'u', 1e-3);
        near(back[1], v, 'v', 1e-3);
    }
});

test('latticeInverse：带偏移的网格仍能反解回同一 uv', () => {
    let L = createLattice(2, 2);
    // 把四个角都拉开，制造明显的透视效果
    L = setVertex(L, 0, -20, -10);
    L = setVertex(L, 2, 25, -5);
    L = setVertex(L, 6, -15, 30);
    L = setVertex(L, 8, 20, 25);
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.35, 0.62]]) {
        const p = latticePoint(L, 160, 120, u, v);
        const back = latticeInverse(L, 160, 120, p);
        assert.ok(back, `应能反解 ${u},${v}`);
        near(back[0], u, 'u', 2e-3);
        near(back[1], v, 'v', 2e-3);
    }
});

test('latticeInverse：网格外的点返回 null', () => {
    const L = createLattice(1, 1);
    assert.equal(latticeInverse(L, 100, 80, { x: -40, y: 40 }), null);
    assert.equal(latticeInverse(L, 100, 80, { x: 50, y: 300 }), null);
});

test('latticeBounds：零网格等于矩形，偏移后外扩', () => {
    const L = createLattice(1, 1);
    assert.deepEqual(latticeBounds(L, 100, 80), { x0: 0, y0: 0, x1: 100, y1: 80 });
    const M = setVertex(L, 0, -10, -5);
    const b = latticeBounds(M, 100, 80);
    near(b.x0, -10);
    near(b.y0, -5);
    near(b.x1, 100);
    near(b.y1, 80);
});

test('resizeLattice：保留四角，升级与降级都不丢失角点', () => {
    let L = createLattice(1, 1);
    L = setVertex(L, 0, -4, -6);   // tl
    L = setVertex(L, 3, 8, 9);     // br
    const big = resizeLattice(L, 3, 3);
    assert.equal(big.cols, 3);
    assert.equal(big.rows, 3);
    near(big.pts[0][0], -4, 'tl.x');
    near(big.pts[0][1], -6, 'tl.y');
    near(big.pts[big.pts.length - 1][0], 8, 'br.x');
    near(big.pts[big.pts.length - 1][1], 9, 'br.y');
    const back = resizeLattice(big, 1, 1);
    near(back.pts[0][0], -4, 'tl.x 回来后');
    near(back.pts[3][0], 8, 'br.x 回来后');
});

test('resizeLattice：同尺寸时等价于归一化副本', () => {
    const L = setVertex(createLattice(2, 2), 4, 12, -8);
    const same = resizeLattice(L, 2, 2);
    near(same.pts[4][0], 12);
    near(same.pts[4][1], -8);
});

test('lerpLattice：两端插值与端点复现', () => {
    const a = latticeFromQuad({ tl: [0, 0], tr: [0, 0], br: [0, 0], bl: [0, 0] });
    const b = latticeFromQuad({ tl: [10, 20], tr: [0, 0], br: [0, 0], bl: [0, 0] });
    near(lerpLattice(a, b, 0.25).pts[0][0], 2.5);
    near(lerpLattice(a, b, 0.25).pts[0][1], 5);
    near(lerpLattice(a, b, 0).pts[0][0], 0);
    near(lerpLattice(a, b, 1).pts[0][0], 10);
});

test('lerpLattice：一侧为 null 视作零偏移，而不是直接取另一侧', () => {
    const b = latticeFromQuad({ tl: [8, 8], tr: [0, 0], br: [0, 0], bl: [0, 0] });
    near(lerpLattice(null, b, 0.25).pts[0][0], 2);
    near(lerpLattice(b, null, 0.75).pts[0][0], 2);
    assert.equal(lerpLattice(null, null, 0.5), null);
});

test('lerpLattice：行列数不同时以 a 为准重采样 b', () => {
    const a = createLattice(1, 1);
    let b = createLattice(3, 3);
    b = setVertex(b, 0, 9, 9);   // b 的 tl
    b = setVertex(b, 15, 30, 30); // b 的 br
    const m = lerpLattice(a, b, 0.5);
    assert.equal(m.cols, 1);
    assert.equal(m.rows, 1);
    near(m.pts[0][0], 4.5);
    near(m.pts[3][0], 15);
});

test('latticeWireframe：横线 rows+1 条、竖线 cols+1 条，端点贴合边界', () => {
    const L = createLattice(1, 1);
    const lines = latticeWireframe(L, 100, 80, 4);
    assert.equal(lines.length, 4);       // 2 横 + 2 竖
    assert.equal(lines[0].length, 5);    // 横线：cols*n+1 = 1*4+1
    assert.equal(lines[2].length, 5);    // 竖线：rows*n+1
    near(lines[0][0].x, 0);
    near(lines[0][0].y, 0);
    near(lines[0][4].x, 100);
    near(lines[2][4].y, 80);
    const two = latticeWireframe(createLattice(2, 2), 100, 80, 2);
    assert.equal(two.length, 6);         // 3 横 + 3 竖
    assert.equal(two[0].length, 5);      // 2*2+1
});
