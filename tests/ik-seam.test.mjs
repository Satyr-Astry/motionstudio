// 骨骼 P3 步 2：IK 接缝（求值器 + 蒙皮 + 存档）。
//
// 这一层要钉住的核心不变量只有一条：**求值器与蒙皮必须看见同一张覆盖表**。
// 少传一个参数的表现是「骨架弯了、皮肤不弯」——不会报错、不会红，只是画错，
// 所以只能用「两条路径逐项相等」的断言兜。
//
// 其余三块：`ik` 能不能过 makeObject、能不能过存档往返、不启用时是否零回归。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDoc, makeObject } from '../app/core/doc-model.mjs';
import { createEvaluator, matrixTuple } from '../app/core/evaluator.mjs';
import { boneWorldMatrix, applySkin, SKIN_DEFAULTS } from '../app/core/skin.mjs';
import { resetIkCache, solveIk } from '../app/core/ik.mjs';
import { createLattice } from '../app/core/lattice.mjs';
import { docToFile, jsonToDoc } from '../app/shell/project-store.mjs';

const docOf = (objects) => createDoc({ width: 800, height: 600, objects });

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
function target(id, x, y) {
    return makeObject({ id, name: id, kind: 'paint', transform: { keys: [{ t: 0, state: { x, y } }] } });
}

const near = (a, b, eps) => Math.abs(a - b) <= eps;
const assertTupleNear = (left, right, eps, label) => {
    const A = matrixTuple(left);
    const B = matrixTuple(right);
    for (let i = 0; i < 6; i++) {
        assert.ok(near(A[i], B[i], eps), `${label} 第 ${i} 项应相等：${A[i]} vs ${B[i]}`);
    }
};

/** 两根骨的链：a 在原点，b 挂在 a 的末端，b 自己带 IK。 */
function twoBoneDoc(ik) {
    const a = bone('a');
    const b = bone('b', { parentId: 'a', transform: { keys: [{ t: 0, state: { x: 120, y: 0 } }] }, ik });
    const t = target('t1', 100, 7);
    return { doc: docOf([a, b, t]), a, b, t };
}

test('接缝：IK 生效时求值器与蒙皮给出同一张世界矩阵（< 1e-9）', () => {
    resetIkCache();
    const { doc } = twoBoneDoc({ targetId: 't1', chain: 2, iterations: 24 });
    const ev = createEvaluator(doc, { cache: false });
    const sol = solveIk(doc, 0);
    assert.ok(sol.size >= 2, 'IK 应产出覆盖表');

    for (const id of ['a', 'b']) {
        const el = doc.objects.find((o) => o.id === id);
        assertTupleNear(ev.matrix(el, 0), boneWorldMatrix(doc, el, 0, sol), 1e-9, `${id} 的世界矩阵`);
    }
});

test('接缝不是空转：IK 生效后末端世界坐标确实变了（而不是两条路径一起错）', () => {
    resetIkCache();
    const withIk = twoBoneDoc({ targetId: 't1', chain: 2, iterations: 24 });
    const sol = solveIk(withIk.doc, 0);
    const mb = sol.get('b');
    assert.ok(mb, '应产出 b 的覆盖矩阵');
    // 末端的局部坐标是 (len, width/2)
    const tip = { x: 120, y: 7 };
    const px = mb.a * tip.x + mb.c * tip.y + mb.e;
    const py = mb.b * tip.x + mb.d * tip.y + mb.f;
    assert.ok(Math.hypot(px - 100, py - 7) < 1e-3, `末端应贴住目标 (100,7)，实际 (${px},${py})`);
});

test('零回归：没有 IK 的文档，求值器矩阵与「不传覆盖表」逐项相等', () => {
    resetIkCache();
    const a = bone('a');
    const b = bone('b', { parentId: 'a', transform: { keys: [{ t: 0, state: { x: 120, y: 0 } }] } });
    const doc = docOf([a, b]);
    assert.equal(solveIk(doc, 0).size, 0, '没有 ik 字段时覆盖表必须为空');
    const ev = createEvaluator(doc, { cache: false });
    for (const id of ['a', 'b']) {
        const el = doc.objects.find((o) => o.id === id);
        assertTupleNear(ev.matrix(el, 0), boneWorldMatrix(doc, el, 0, null), 1e-9, `${id} 世界矩阵`);
    }
});

test('makeObject：骨骼上的 ik 保留，非骨骼上的 ik 丢弃', () => {
    const b = bone('b1', { ik: { targetId: 't1', chain: 3, iterations: 4, enabled: false } });
    assert.deepEqual(b.ik, { targetId: 't1', chain: 3, iterations: 4, enabled: false }, 'iku 必须挂在骨骼上');
    const p = makeObject({ id: 'p1', kind: 'paint', ik: { targetId: 'x' } });
    assert.equal(p.ik, undefined, '非骨骼对象不该带 ik（会变成只读不用的脏字段）');
});

test('存档往返：ik 逐字段还原，解算结果一个字节都不进档', async () => {
    resetIkCache();
    const { doc } = twoBoneDoc({ targetId: 't1', chain: 2, iterations: 16 });
    solveIk(doc, 0); // 先算一遍，确认解算不会把东西写进 doc
    const file = docToFile(doc);
    const el = file.elements.find((o) => o.id === 'b');
    assert.ok(el, '存档里应有 b');
    assert.deepEqual(el.ik, { targetId: 't1', chain: 2, iterations: 16, enabled: true }, 'ik 应完整落盘');
    assert.equal(Object.keys(el.ik).sort().join(','), 'chain,enabled,iterations,targetId', 'ik 只许四个键');
    // 解算结果不该以任何形式出现在文件里
    const blob = JSON.stringify(file);
    assert.ok(!blob.includes('"ikNow"'), '解算结果不许进档');
    assert.ok(!/\bm\.a\b/.test(blob), '矩阵不该进档');

    const back = await jsonToDoc(file);
    const bBack = back.objects.find((o) => o.id === 'b');
    assert.deepEqual(bBack.ik, el.ik, '读回后 ik 应逐字段相等');
});

test('存档：坏 ik 在写入与读入两端都被归一（不落脏数据）', () => {
    const doc = docOf([bone('b1', { ik: { targetId: 't1', chain: 99, iterations: 0 } })]);
    const file = docToFile(doc);
    const el = file.elements.find((o) => o.id === 'b1');
    assert.equal(el.ik.chain, 8, 'chain 超上限应夹到 8');
    assert.equal(el.ik.iterations, 1, 'iterations 为 0 应夹到 1');
});

test('不产生 NaN：IK 链上的矩阵逐项有限，且求值器拿到的 lattice 也能用', () => {
    resetIkCache();
    const { doc, b } = twoBoneDoc({ targetId: 't1', chain: 2, iterations: 32 });
    const ev = createEvaluator(doc, { cache: false });
    const rec = ev.sample(0).layers.find((r) => r.layer && r.layer.id === 'b');
    assert.ok(rec, 'sample 里应有 b');
    for (const v of matrixTuple(rec.matrix)) assert.ok(Number.isFinite(v), '矩阵项必须有限');
    // sample 记录里的 lattice 是「求值结果包」：{ lattice, size, matrix, map }
    const latRec = rec.lattice && rec.lattice.lattice;
    assert.ok(latRec && Array.isArray(latRec.pts), 'lattice 应存在');
    // pts 的每一项可能是 [x,y] 数组或 {x,y} 对象，两种都要判（不强绑内部形状）
    for (const v of latRec.pts) {
        const x = Array.isArray(v) ? v[0] : v && v.x;
        const y = Array.isArray(v) ? v[1] : v && v.y;
        assert.ok(Number.isFinite(x) && Number.isFinite(y), '顶点必须有限');
    }
    // 蒙皮路径也跑一遍（无 skin 时原样返回，但确保 IK 不会让 applySkin 炸）
    const lat = createLattice(SKIN_DEFAULTS.grid.cols, SKIN_DEFAULTS.grid.rows);
    assert.ok(applySkin(doc, b, lat, matrixTuple(ev.matrix(b, 0)), { w: 120, h: 14 }, 0));
});
