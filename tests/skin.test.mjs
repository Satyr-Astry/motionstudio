// 骨骼 P2-A 单测：蒙皮模型（skin.mjs）与求值接缝。
//
// 三条主线：
//   1. 数学：手算 W = Σ w_k·(M_k·B_k⁻¹)·P，与 applySkin / evaluator 的 map(u,v) 对拍（1e-6）
//   2. 数据：normalizeSkin 的夹取与重采样、存档往返、makeObject 不吞 skin
//   3. 边界：Σw = 0 的顶点当纯 warp 用（不产 NaN）、无 skin 的对象求值零回归
//
// 全部用「无纹理对象 + 手写矩阵」构造，不碰 DOM 与 canvas。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createDoc, makeObject, objectsOf } from '../app/core/doc-model.mjs';
import { createKey } from '../app/core/transform.mjs';
import { createLattice, latticeOffset, setVertex } from '../app/core/lattice.mjs';
import { createEvaluator } from '../app/core/evaluator.mjs';
import {
    SKIN_DEFAULTS,
    SKIN_MAX_BONES_PER_POINT,
    applySkin,
    autoWeights,
    bindSkin,
    boneMatrices,
    normalizeSkin,
    resampleWeights,
    skinOf,
} from '../app/core/skin.mjs';
import { docToFile, jsonToDoc } from '../app/shell/project-store.mjs';

const DOC = { width: 800, height: 600 };
const docOf = (objects) => createDoc({ width: DOC.width, height: DOC.height, objects });
const ID = [1, 0, 0, 1, 0, 0];

/** 骨骼：默认 120×14、锚点在根部（x=0, y=0.5），沿局部 +x 伸展。 */
function boneDoc(keys, extra = {}) {
    return makeObject({ id: 'b1', name: 'B1', kind: 'bone', bone: { len: 120, width: 14 }, transform: { keys }, ...extra });
}

/** 皮肤：无纹理 → elementSize 回退文档尺寸 800×600，世界矩阵取参数传进来的那个。 */
const skinLayerOf = (skin) => makeObject({ id: 's1', name: 'Skin', kind: 'paint', skin });

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const assertPt = (p, x, y, eps = 1e-6) => {
    assert.ok(near(p[0], x, eps), `x 应为 ${x}，实际 ${p[0]}`);
    assert.ok(near(p[1], y, eps), `y 应为 ${y}，实际 ${p[1]}`);
};

/** 手造蒙皮：权重完全可控，用来做精确数值对拍。 */
function handmade(weights, bind = ID, grid = { cols: 1, rows: 1 }) {
    return { grid, bones: [{ id: 'b1', bind }], pts: weights.map((w) => w) };
}

/* ─────────────────────── 数学：单骨纯平移 ─────────────────────── */

test('单骨平移：网格每个顶点整体平移，偏移不含旋转缩放', () => {
    const bone = boneDoc([createKey(0, {}), createKey(1, { x: 100, y: 0 })]);
    const layer = skinLayerOf(handmade([[{ b: 0, w: 1 }], [{ b: 0, w: 1 }], [{ b: 0, w: 1 }], [{ b: 0, w: 1 }]]));
    const doc = docOf([bone, layer]);
    // bind = 单位阵 = t=0 时骨骼的世界矩阵（位移 0）
    const out = applySkin(doc, layer, createLattice(1, 1), ID, { w: DOC.width, h: DOC.height }, 1);
    assert.equal(out.pts.length, 4);
    for (const p of out.pts) assertPt(p, 100, 0);
});

test('单骨平移：t=0（绑定姿态）时偏移为零', () => {
    const bone = boneDoc([createKey(0, {}), createKey(1, { x: 100, y: 0 })]);
    const layer = skinLayerOf(handmade([[{ b: 0, w: 1 }], [{ b: 0, w: 1 }], [{ b: 0, w: 1 }], [{ b: 0, w: 1 }]]));
    const doc = docOf([bone, layer]);
    const out = applySkin(doc, layer, createLattice(1, 1), ID, { w: DOC.width, h: DOC.height }, 0);
    for (const p of out.pts) assertPt(p, 0, 0);
});

test('LBS 公式：M_k·B_k⁻¹ 含旋转时，偏移是绕骨骼根部的旋转', () => {
    const bone = boneDoc([createKey(0, {}), createKey(1, { rotate: 90 })]);
    const layer = skinLayerOf(handmade([[{ b: 0, w: 1 }], [{ b: 0, w: 1 }], [{ b: 0, w: 1 }], [{ b: 0, w: 1 }]]));
    const doc = docOf([bone, layer]);
    const out = applySkin(doc, layer, createLattice(1, 1), ID, { w: DOC.width, h: DOC.height }, 1);
    // 手算 rel = M(1)·B(0)⁻¹，再逐顶点 W = rel·P、off = W - P
    const rel = relOf(boneMatrices(doc, skinOf(layer), 1)[0]);
    for (let i = 0; i < 4; i++) {
        const c = i % 2;
        const r = Math.floor(i / 2);
        const P = { x: c * DOC.width, y: r * DOC.height };
        const W = applyRel(rel, P);
        assertPt(out.pts[i], W.x - P.x, W.y - P.y);
    }
    // 参照点：局部原点在骨骼根部上方半个身位（宽 14 → 7px），绕根部转 90° 后跑到右边
    assertPt(out.pts[0], 7, 7);
});

/* ─────────────────────── 数学：两骨混合 ─────────────────────── */

test('两骨：权重 1/0、0.5/0.5、空权重各走各的分支', () => {
    const b1 = boneDoc([createKey(0, {}), createKey(1, { x: 100, y: 0 })]);
    const b2 = makeObject({ id: 'b2', kind: 'bone', transform: { keys: [createKey(0, {}), createKey(1, { y: 50 })] } });
    const layer = skinLayerOf({
        grid: { cols: 1, rows: 1 },
        bones: [
            { id: 'b1', bind: ID },
            { id: 'b2', bind: ID },
        ],
        pts: [
            [{ b: 0, w: 1 }], // 全给 b1 → (100, 0)
            [{ b: 1, w: 1 }], // 全给 b2 → (0, 50)
            [
                { b: 0, w: 0.5 },
                { b: 1, w: 0.5 },
            ], // 各一半 → (50, 25)
            [], // 没有骨骼 → 当纯 warp，偏移 0
        ],
    });
    const doc = docOf([b1, b2, layer]);
    const out = applySkin(doc, layer, createLattice(1, 1), ID, { w: DOC.width, h: DOC.height }, 1);
    assertPt(out.pts[0], 100, 0);
    assertPt(out.pts[1], 0, 50);
    assertPt(out.pts[2], 50, 25);
    assertPt(out.pts[3], 0, 0);
});

test('失效骨骼：缺 now 的骨被跳过，剩余权重重新归一（不是按比例缩小）', () => {
    const b1 = boneDoc([createKey(0, {}), createKey(1, { x: 100, y: 0 })]);
    const layer = skinLayerOf({
        grid: { cols: 1, rows: 1 },
        bones: [
            { id: 'b1', bind: ID },
            { id: 'ghost', bind: ID }, // 指向不存在的对象
        ],
        pts: [
            [
                { b: 0, w: 0.5 },
                { b: 1, w: 0.5 },
            ],
            [], [], [],
        ],
    });
    const doc = docOf([b1, layer]);
    const out = applySkin(doc, layer, createLattice(1, 1), ID, { w: DOC.width, h: DOC.height }, 1);
    // 若按 Σw<1 直接乘，会得到 (50, 0) 这种「缩向原点」的错值
    assertPt(out.pts[0], 100, 0);
});

test('Σw = 0 的顶点不产 NaN（当纯 warp 用）', () => {
    const b1 = boneDoc([createKey(0, {}), createKey(1, { x: 100, y: 0 })]);
    const layer = skinLayerOf({
        grid: { cols: 1, rows: 1 },
        bones: [{ id: 'b1', bind: ID }],
        pts: [[], [], [], []],
    });
    const doc = docOf([b1, layer]);
    const out = applySkin(doc, layer, createLattice(1, 1), ID, { w: DOC.width, h: DOC.height }, 1);
    for (const p of out.pts) {
        assert.ok(Number.isFinite(p[0]) && Number.isFinite(p[1]), '不能出现 NaN');
        assertPt(p, 0, 0);
    }
});

test('退化矩阵（尺度为 0）：直接返回原网格，不崩', () => {
    const b1 = boneDoc([createKey(0, {}), createKey(1, { x: 100 })]);
    const layer = skinLayerOf(handmade([[{ b: 0, w: 1 }], [{ b: 0, w: 1 }], [{ b: 0, w: 1 }], [{ b: 0, w: 1 }]]));
    const doc = docOf([b1, layer]);
    const out = applySkin(doc, layer, createLattice(1, 1), [0, 0, 0, 0, 0, 0], { w: 100, h: 100 }, 1);
    for (const p of out.pts) assertPt(p, 0, 0);
});

/* ─────────────────────── 与 evaluator 的 map(u,v) 对拍 ─────────────────────── */

test('map(u,v) 与手算 W_i 对拍：求值器里的 map 就是蒙皮后的局部点 + 世界矩阵', () => {
    const b1 = boneDoc([createKey(0, {}), createKey(1, { x: 60, y: 30 })]);
    const layer = skinLayerOf({
        grid: { cols: 1, rows: 1 },
        bones: [{ id: 'b1', bind: ID }],
        pts: [[{ b: 0, w: 1 }], [{ b: 0, w: 1 }], [{ b: 0, w: 1 }], [{ b: 0, w: 1 }]],
    });
    const doc = docOf([b1, layer]);
    const ev = createEvaluator(doc);
    const rec = ev.lattice(layer, 1);
    // 手算：rel = M(1)·B⁻¹ = 平移 (60,30)；P(u,v) = (u*800, v*600)；off = rel·P - P
    for (const [u, v] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
        [0.5, 0.5],
    ]) {
        const P = { x: u * DOC.width, y: v * DOC.height };
        const W = { x: P.x + 60, y: P.y + 30 };
        // 层自身世界矩阵是单位阵，所以 map = W 本身。map 返回 [x, y] 数组（同 quad）。
        const got = rec.map(u, v);
        assert.ok(near(got[0], W.x) && near(got[1], W.y), `map(${u},${v}) 应为 (${W.x},${W.y})，实际 (${got})`);
    }
});

test('map(u,v) 对拍：层自身带旋转时，偏移必须先用世界矩阵的逆转回局部', () => {
    const b1 = boneDoc([createKey(0, {}), createKey(1, { x: 0, y: 0, rotate: 90 })]);
    const layer = makeObject({
        id: 's1',
        kind: 'paint',
        skin: { grid: { cols: 1, rows: 1 }, bones: [{ id: 'b1', bind: ID }], pts: [[{ b: 0, w: 1 }], [{ b: 0, w: 1 }], [{ b: 0, w: 1 }], [{ b: 0, w: 1 }]] },
        // 层自身绕中心转 90°：世界矩阵非单位阵
        transform: { keys: [createKey(0, { rotate: 90 })] },
    });
    const doc = docOf([b1, layer]);
    const ev = createEvaluator(doc);
    const rec = ev.lattice(layer, 1);
    const P = { x: DOC.width, y: 0 }; // map(1, 0) 的局部点
    // 手算：骨骼 rel = R90（绕骨骼根部）→ W = rel·P；再经层世界矩阵 M 变成文档坐标
    const mats = boneMatrices(doc, skinOf(layer), 1);
    const rel = relOf(mats[0]);
    const Wp = applyRel(rel, P);
    const M = rec.matrix;
    // map 输出的是**文档坐标**：局部点先被 applySkin 用 M⁻¹ 搬回局部、map 再乘 M 回来，
    // 所以正确的结果直接就是 W（骨骼变换作用在 P 上）。若错用 parentMatrix 或少乘一次
    // 层自身的旋转，这里就会偏掉。
    const expected = Wp;
    const got = rec.map(1, 0);
    assert.ok(near(got[0], expected.x) && near(got[1], expected.y), `map(1,0) 应为 (${expected.x}, ${expected.y})，实际 (${got})`);
    // 反证：层的世界矩阵确实不是单位阵，否则这条测试会假绿
    assert.ok(!near(M[0], 1) || !near(M[1], 0), '层必须真的带旋转');
});

/* ─────────────────────── warp 叠加 ─────────────────────── */

test('st.warp 与蒙皮偏移逐顶点相加，且 st.warp 本身不被改写', () => {
    // setVertex 是纯函数，返回新网格 —— 别指望它改手上的那个
    const warp = setVertex(createLattice(1, 1), 0, 10, -5); // 左上角先被用户拖过
    const before = JSON.parse(JSON.stringify(warp));
    const b1 = boneDoc([createKey(0, {}), createKey(1, { x: 100, y: 0 })]);
    const layer = makeObject({
        id: 's1',
        kind: 'paint',
        skin: { grid: { cols: 1, rows: 1 }, bones: [{ id: 'b1', bind: ID }], pts: [[{ b: 0, w: 1 }], [{ b: 0, w: 1 }], [{ b: 0, w: 1 }], [{ b: 0, w: 1 }]] },
        transform: { keys: [createKey(0, { warp })] },
    });
    const doc = docOf([b1, layer]);
    const out = applySkin(doc, layer, warp, ID, { w: DOC.width, h: DOC.height }, 1);
    assertPt(out.pts[0], 110, -5); // 10+100, -5+0
    assertPt(out.pts[3], 100, 0);
    assert.deepEqual(warp, before, '传入的 warp 网格必须原封不动');
    assert.deepEqual(layer.transform.keys[0].state.warp, before, '对象上的 warp 也不能被写');
});

test('skin 网格与 warp 网格密度不同：偏移按 latticeOffset 重采样到 warp 的密度', () => {
    const warp = createLattice(6, 6); // 7×7 = 49 顶点
    const b1 = boneDoc([createKey(0, {}), createKey(1, { x: 100, y: 0 })]);
    const layer = skinLayerOf(handmade([[{ b: 0, w: 1 }], [{ b: 0, w: 1 }], [{ b: 0, w: 1 }], [{ b: 0, w: 1 }]]));
    const doc = docOf([b1, layer]);
    const out = applySkin(doc, layer, warp, ID, { w: DOC.width, h: DOC.height }, 1);
    assert.equal(out.cols, 6);
    assert.equal(out.rows, 6);
    assert.equal(out.pts.length, 49);
    // 纯平移的偏移场重采样后仍是同一个平移
    for (const p of out.pts) assertPt(p, 100, 0);
});

/* ─────────────────────── normalizeSkin ─────────────────────── */

test('normalizeSkin：不是对象就没有蒙皮', () => {
    assert.equal(normalizeSkin(null), null);
    assert.equal(normalizeSkin(undefined), null);
    assert.equal(normalizeSkin('skin'), null);
    assert.equal(normalizeSkin(42), null);
    assert.equal(normalizeSkin([{ b: 0, w: 1 }]), null);
});

test('normalizeSkin：空对象得到缺省网格密度与全空权重', () => {
    const s = normalizeSkin({});
    assert.deepEqual(s.grid, { cols: SKIN_DEFAULTS.grid.cols, rows: SKIN_DEFAULTS.grid.rows });
    assert.deepEqual(s.bones, []);
    assert.equal(s.pts.length, (SKIN_DEFAULTS.grid.cols + 1) * (SKIN_DEFAULTS.grid.rows + 1));
    for (const p of s.pts) assert.deepEqual(p, []);
});

test('normalizeSkin：网格密度越界被夹进 1..12', () => {
    assert.deepEqual(normalizeSkin({ grid: { cols: 0, rows: 999 } }).grid, { cols: 1, rows: 12 });
    assert.deepEqual(normalizeSkin({ grid: { cols: -5, rows: 3 } }).grid, { cols: 1, rows: 3 });
    assert.deepEqual(normalizeSkin({ grid: { cols: 4.6, rows: 2 } }).grid, { cols: 5, rows: 2 });
});

test('normalizeSkin：每顶点最多 4 根骨、按权重降序、Σ归一', () => {
    const bones = [0, 1, 2, 3, 4].map((i) => ({ id: 'b' + i, bind: ID }));
    const s = normalizeSkin({
        grid: { cols: 1, rows: 1 },
        bones,
        pts: [
            [0, 1, 2, 3, 4].map((b) => ({ b, w: 0.1 * (b + 1) })), // 5 项 → 截 4
            [],
            [],
            [],
        ],
    });
    const top = s.pts[0];
    assert.equal(top.length, SKIN_MAX_BONES_PER_POINT);
    assert.deepEqual(top.map((e) => e.b), [4, 3, 2, 1], '权重大的在前');
    const sum = top.reduce((a, e) => a + e.w, 0);
    assert.ok(near(sum, 1), `权重和应为 1，实际 ${sum}`);
});

test('normalizeSkin：越界骨骼下标被剔除，无效权重项被丢弃', () => {
    const s = normalizeSkin({
        grid: { cols: 1, rows: 1 },
        bones: [{ id: 'b0', bind: ID }],
        pts: [[{ b: 0, w: 0.5 }, { b: 7, w: 0.5 }, { b: 0, w: 0 }, { b: -1, w: 1 }], [], [], []],
    });
    assert.deepEqual(s.pts[0], [{ b: 0, w: 1 }]);
});

test('normalizeSkin：bind 无效的骨骼保留槽位（pts 的下标不能漂）', () => {
    const s = normalizeSkin({
        grid: { cols: 1, rows: 1 },
        bones: [{ id: 'b0', bind: ID }, { id: 'b1', bind: [1, 2, 3] }, { id: 'b2', bind: null }],
        pts: [[{ b: 2, w: 1 }], [], [], []],
    });
    assert.equal(s.bones.length, 3);
    assert.equal(s.bones[1].bind, null);
    assert.deepEqual(s.bones[1].id, 'b1');
    assert.deepEqual(s.pts[0], [{ b: 2, w: 1 }], '下标 2 仍指向 b2');
});

test('normalizeSkin：pts 长度与网格不符时按序号对齐，缺的补空、多的丢弃', () => {
    // 2×2 网格要 9 个顶点，只给 3 个 → 后 6 个为空
    const s = normalizeSkin({
        grid: { cols: 2, rows: 2 },
        bones: [{ id: 'b0', bind: ID }],
        pts: [[{ b: 0, w: 1 }], [{ b: 0, w: 1 }], [{ b: 0, w: 1 }]],
    });
    assert.equal(s.pts.length, 9);
    assert.deepEqual(s.pts[0], [{ b: 0, w: 1 }]);
    assert.deepEqual(s.pts[2], [{ b: 0, w: 1 }]);
    for (let i = 3; i < 9; i++) assert.deepEqual(s.pts[i], []);
    // 给多了只取前 n 个
    const many = Array.from({ length: 30 }, () => [{ b: 0, w: 1 }]);
    assert.equal(normalizeSkin({ grid: { cols: 1, rows: 1 }, bones: [{ id: 'b0', bind: ID }], pts: many }).pts.length, 4);
});

test('resampleWeights：每个顶点的权重和都是 1，空源得到空数组', () => {
    const src = [];
    for (let i = 0; i < 4; i++) src.push([{ b: 0, w: 1 }]);
    const out = resampleWeights(src, { cols: 1, rows: 1 }, { cols: 3, rows: 3 });
    assert.equal(out.length, 16);
    for (const p of out) {
        const sum = p.reduce((a, e) => a + e.w, 0);
        assert.ok(near(sum, 1), `权重和应为 1，实际 ${sum}`);
    }
    const empty = resampleWeights([], { cols: 1, rows: 1 }, { cols: 2, rows: 2 });
    for (const p of empty) assert.deepEqual(p, []);
});

/* ─────────────────────── boneMatrices ─────────────────────── */

test('boneMatrices：骨骼世界矩阵沿 parentId 自算（子骨跟着父骨走）', () => {
    const parent = makeObject({ id: 'b1', kind: 'bone', transform: { keys: [createKey(0, {})] } });
    const child = makeObject({ id: 'b2', kind: 'bone', parentId: 'b1', transform: { keys: [createKey(0, { x: 0, y: 0 })] } });
    const doc = docOf([parent, child]);
    const skin = { bones: [{ id: 'b2', bind: ID }], pts: [] };
    const [m] = boneMatrices(doc, skin, 0);
    assert.ok(m.ok);
    // 父骨在 x=200、子骨自身无位移 → 子骨世界矩阵的平移就是 200
    const moved = docOf([
        makeObject({ id: 'b1', kind: 'bone', transform: { keys: [createKey(0, { x: 200 })] } }),
        child,
    ]);
    const [m2] = boneMatrices(moved, skin, 0);
    assert.ok(near(m2.now[4], 200), `子骨平移应为 200，实际 ${m2.now[4]}`);
});

test('boneMatrices：指向非骨骼对象时 ok=false，槽位仍在', () => {
    const paint = makeObject({ id: 'p1', kind: 'paint' });
    const doc = docOf([paint]);
    const mats = boneMatrices(doc, { bones: [{ id: 'p1', bind: ID }, { id: 'nope', bind: ID }], pts: [] }, 0);
    assert.equal(mats.length, 2);
    assert.equal(mats[0].ok, false);
    assert.equal(mats[1].ok, false);
});

/* ─────────────────────── autoWeights / bindSkin ─────────────────────── */

test('autoWeights：顶点离哪根骨近就归哪根，权重和为 1', () => {
    // 两根平行横骨，一根在 y=0 附近，一根在 y=600 附近
    const b1 = makeObject({ id: 'b1', kind: 'bone', bone: { len: 400, width: 14 } });
    const b2 = makeObject({ id: 'b2', kind: 'bone', bone: { len: 400, width: 14 }, anchor: { x: 0, y: 0.5 }, transform: { keys: [createKey(0, { y: 600 })] } });
    const layer = makeObject({ id: 's1', kind: 'paint' });
    const doc = docOf([b1, b2, layer]);
    const pts = autoWeights(doc, layer, { cols: 1, rows: 1 }, ['b1', 'b2'], 0);
    assert.equal(pts.length, 4);
    // (u,v)=(0,0) 与 (1,0) 在上边缘 → 归 b1；(0,1)、(1,1) 在下边缘 → 归 b2
    assert.equal(pts[0][0].b, 0);
    assert.equal(pts[1][0].b, 0);
    assert.equal(pts[2][0].b, 1);
    assert.equal(pts[3][0].b, 1);
    for (const item of pts) {
        const sum = item.reduce((a, e) => a + e.w, 0);
        assert.ok(near(sum, 1), `权重和应为 1，实际 ${sum}`);
    }
});

test('autoWeights：没有可用骨骼时全是空权重', () => {
    const layer = makeObject({ id: 's1', kind: 'paint' });
    const doc = docOf([layer]);
    const pts = autoWeights(doc, layer, { cols: 1, rows: 1 }, [], 0);
    for (const item of pts) assert.deepEqual(item, []);
});

test('bindSkin：跳过非骨骼 id，bind 存的是此刻世界矩阵的快照', () => {
    const b1 = boneDoc([createKey(0, { x: 30 })]);
    const paint = makeObject({ id: 'p1', kind: 'paint' });
    const layer = makeObject({ id: 's1', kind: 'paint' });
    const doc = docOf([b1, paint, layer]);
    const skin = bindSkin(doc, layer, ['b1', 'p1', 'ghost'], { grid: { cols: 1, rows: 1 } });
    assert.equal(skin.bones.length, 1, '只有真骨骼进 bones');
    assert.equal(skin.bones[0].id, 'b1');
    assert.ok(near(skin.bones[0].bind[4], 30), `bind 应含 x=30，实际 ${skin.bones[0].bind[4]}`);
    assert.equal(skin.pts.length, 4);
});

test('bindSkin：没有任何骨骼时得到空权重但仍是合法 skin', () => {
    const layer = makeObject({ id: 's1', kind: 'paint' });
    const doc = docOf([layer]);
    const skin = bindSkin(doc, layer, [], {});
    assert.deepEqual(skin.bones, []);
    for (const p of skin.pts) assert.deepEqual(p, []);
});

/* ─────────────────────── 零回归 / 序列化 ─────────────────────── */

test('没有 skin 的对象：求值结果与「直接用 warp」完全一致', () => {
    const warp = setVertex(createLattice(2, 2), 4, 7, -3);
    const layer = makeObject({ id: 's1', kind: 'paint', transform: { keys: [createKey(0, { warp })] } });
    const doc = docOf([layer]);
    const ev = createEvaluator(doc);
    const rec = ev.lattice(layer, 0);
    assert.deepEqual(rec.lattice, warp);
    for (const [u, v] of [
        [0, 0],
        [0.5, 0.5],
        [1, 1],
    ]) {
        const off = latticeOffset(warp, u, v);
        assert.ok(near(rec.map(u, v)[0], u * DOC.width + off.x));
        assert.ok(near(rec.map(u, v)[1], v * DOC.height + off.y));
    }
});

test('skinOf：对象上没有蒙皮字段时返回 null', () => {
    assert.equal(skinOf(makeObject({ id: 'p1', kind: 'paint' })), null);
    assert.equal(skinOf(null), null);
});

test('makeObject：skin 原样挂载（同一引用），不被白名单吞掉', () => {
    const skin = { grid: { cols: 1, rows: 1 }, bones: [], pts: [] };
    const obj = makeObject({ id: 's1', kind: 'paint', skin });
    assert.equal(obj.skin, skin, '必须是同一引用，证明没被拷成新对象或被丢掉');
});

test('makeObject：骨骼不带 skin（骨骼是驱动器，不是被蒙皮对象）', () => {
    const obj = makeObject({ id: 'b1', kind: 'bone', skin: { grid: { cols: 1, rows: 1 }, bones: [], pts: [] } });
    assert.equal(obj.skin, undefined);
});

test('存档往返：skin 的三个字段都活着，网格与骨骼不变形', async () => {
    const b1 = boneDoc([createKey(0, {}), createKey(1, { x: 40 })]);
    const layer = makeObject({
        id: 's1',
        name: 'Skin',
        kind: 'paint',
        skin: {
            grid: { cols: 2, rows: 2 },
            bones: [{ id: 'b1', bind: ID }],
            pts: Array.from({ length: 9 }, () => [{ b: 0, w: 1 }]),
        },
    });
    const doc = docOf([b1, layer]);
    const back = await jsonToDoc(docToFile(doc));
    const skinLayer = objectsOf(back).find((o) => o.id === 's1');
    assert.ok(skinLayer.skin, 'skin 必须存活');
    assert.deepEqual(skinLayer.skin.grid, { cols: 2, rows: 2 });
    assert.equal(skinLayer.skin.bones.length, 1);
    assert.equal(skinLayer.skin.bones[0].id, 'b1');
    assert.deepEqual(skinLayer.skin.bones[0].bind, ID);
    assert.equal(skinLayer.skin.pts.length, 9);
});

test('存档：没有 skin 的对象不会凭空多出 skin 字段', () => {
    const layer = makeObject({ id: 's1', kind: 'paint' });
    const file = docToFile(docOf([layer]));
    const el = file.elements.find((e) => e.id === 's1');
    assert.equal('skin' in el, false);
});

/* ─────────────────────── 源码守卫 ─────────────────────── */

test('screen: 存档文本里没有中文、也没有词条键（.msp 是数据，不是界面）', async () => {
    const b1 = boneDoc([createKey(0, {}), createKey(1, { x: 40 })]);
    const layer = makeObject({
        id: 's1',
        kind: 'paint',
        skin: { grid: { cols: 1, rows: 1 }, bones: [{ id: 'b1', bind: ID }], pts: [{ b: 0, w: 1 }, { b: 0, w: 1 }, { b: 0, w: 1 }, { b: 0, w: 1 }] },
    });
    const file = await docToFile(docOf([b1, layer]));
    const el = file.elements.find((e) => e.id === 's1');
    const json = JSON.stringify(el.skin);
    assert.ok(!/[\u4e00-\u9fff]/.test(json), 'skin 子树里不能出现中文');
    assert.ok(!/layers\.|curve\.|dragtip\./.test(json), 'skin 子树里不能出现 i18n 词条键');
});

test('skin.mjs 不 import DOM / shell / editors，也不 import evaluator / objectsOf（防成环）', () => {
    const src = readFileSync(new URL('../app/core/skin.mjs', import.meta.url), 'utf8');
    const imports = src.match(/^import .*$/gm) || [];
    assert.ok(!imports.some((l) => l.includes("'./evaluator.mjs'")), 'skin.mjs 不能 import evaluator.mjs');
    assert.ok(!imports.some((l) => /\bobjectsOf\b/.test(l)), 'skin.mjs 直接用 doc.objects，不借 objectsOf');
    assert.ok(!imports.some((l) => /'\.\.\/(shell|editors|paint)\//.test(l)), 'core 不许反向依赖上层');
    assert.ok(!/\b(typeof\s+(document|window)\b|window\.|document\.)/.test(src), 'core 是纯函数，不碰 DOM');
    assert.ok(/export const SKIN_MAX_BONES_PER_POINT = 4/.test(src));
    assert.ok(/export function applySkin\(doc, layer, lattice, matrix, size, t\)/.test(src), 'applySkin 必须是 6 个位置参数');
});

test('evaluator.mjs 的接缝只调一次 applySkin，且没有 worldMatrix 回调参数', () => {
    const src = readFileSync(new URL('../app/core/evaluator.mjs', import.meta.url), 'utf8');
    const calls = src.match(/applySkin\(/g) || [];
    assert.equal(calls.length, 1, `applySkin 只应在接缝处调用一次，实际 ${calls.length} 次`);
    assert.ok(!/worldMatrixOf/.test(src), '回调注入的旧写法必须彻底消失');
    assert.ok(/import \{ applySkin, skinOf \} from '\.\/skin\.mjs';/.test(src));
});

/* ─────────────────────── 小工具（测试内部用） ─────────────────────── */

/** 六元组/对象矩阵 → 对象，再点乘。 */
function applySix(m, p) {
    const t = Array.isArray(m) ? m : [m.a, m.b, m.c, m.d, m.e, m.f];
    return { x: t[0] * p.x + t[2] * p.y + t[4], y: t[1] * p.x + t[3] * p.y + t[5] };
}

/** boneMatrices 的一项 → (now · bind⁻¹) 六元组。 */
function relOf(m) {
    const now = m.now;
    const b = m.bind;
    // 只用于纯平移/旋转的 bind，直接 2×3 求逆再相乘
    const det = b[0] * b[3] - b[1] * b[2];
    const inv = [b[3] / det, -b[1] / det, -b[2] / det, b[0] / det, 0, 0];
    inv[4] = -(inv[0] * b[4] + inv[2] * b[5]);
    inv[5] = -(inv[1] * b[4] + inv[3] * b[5]);
    return [
        now[0] * inv[0] + now[2] * inv[1],
        now[1] * inv[0] + now[3] * inv[1],
        now[0] * inv[2] + now[2] * inv[3],
        now[1] * inv[2] + now[3] * inv[3],
        now[0] * inv[4] + now[2] * inv[5] + now[4],
        now[1] * inv[4] + now[3] * inv[5] + now[5],
    ];
}

const applyRel = (rel, p) => applySix(rel, p);
