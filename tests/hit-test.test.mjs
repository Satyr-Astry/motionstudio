/**
 * 命中测试与逆变换（W4b）
 *
 * 覆盖 task-8 的取证结论：hitTest 此前用 worldToLocal + `uv ∈ [0,1]` 判定，
 * 而 worldToLocal 会把越界点夹回 [0,1]、且自身带 2px 包围盒容差，
 * 于是出现「上/左边界外 1px 能选中、右/下边界本身却选不中」。
 *
 * 这里把四个方向的 ±1/±2/±3 像素钉死，并把「容差 = 屏幕像素 / zoom」的语义写进断言。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDoc, objectById, patchObject, setImageAt } from '../app/core/doc-model.mjs';
import { addKey } from '../app/core/transform.mjs';
import {
    hitTest, localUv, localToWorld, worldToLocal, elementSize, elementQuad,
} from '../app/core/element.mjs';
import { createLattice, latticeInverse, latticeInverseRaw } from '../app/core/lattice.mjs';

/**
 * 轻量位图壳：只实现 hitTest 用到的 getImageData。
 * `alphaAt(x,y)` 决定每个像素的 alpha。
 */
function fakeImage(w, h, alphaAt) {
    return {
        width: w,
        height: h,
        getContext() {
            return {
                getImageData(x, y, ww = 1, hh = 1) {
                    const data = new Uint8ClampedArray(ww * hh * 4);
                    for (let j = 0; j < hh; j++) {
                        for (let i = 0; i < ww; i++) {
                            data[(j * ww + i) * 4 + 3] = alphaAt(x + i, y + j);
                        }
                    }
                    return { data, width: ww, height: hh };
                },
            };
        },
    };
}

/** 100×80 全不透明对象，t=0 打一条变换轨道（state 覆盖默认值） */
function makeScene(state) {
    const base = createDoc({ width: 200, height: 160, fps: 10 });
    const el0 = base.objects[0];
    const img = fakeImage(100, 80, () => 255);
    let doc = patchObject(base, el0.id, (o) => setImageAt(o, 0, img));
    if (state) {
        doc = patchObject(doc, el0.id, (o) => {
            const t = o.transform && Array.isArray(o.transform.keys) ? o.transform : { keys: [] };
            const next = addKey(t, 0, { x: 0, y: 0, scaleX: 1, scaleY: 1, rotate: 0, ...state }, 'linear');
            return Object.assign({}, o, { transform: next });
        });
    }
    return { doc, el: objectById(doc, el0.id) };
}

/** 局部点 → 世界点（沿用生产路径的 projection，避免测试自己算一套） */
function worldOf(doc, el, local) {
    return localToWorld(doc, el, 0, local);
}

/** 四个方向的边界点（局部坐标） */
function edgePoints(w, h) {
    return {
        top: { x: w / 2, y: 0 },
        bottom: { x: w / 2, y: h },
        left: { x: 0, y: h / 2 },
        right: { x: w, y: h / 2 },
    };
}

/** 某个方向按 d 像素外移（d>0 朝外） */
function outward(w, h, side, d) {
    const e = edgePoints(w, h)[side];
    if (side === 'top') return { x: e.x, y: e.y - d };
    if (side === 'bottom') return { x: e.x, y: e.y + d };
    if (side === 'left') return { x: e.x - d, y: e.y };
    return { x: e.x + d, y: e.y };
}

test('hitTest：四个方向的边界本身都算命中（含右下最后一列像素）', () => {
    const { doc, el } = makeScene(null);
    const size = elementSize(doc, el, 0);
    assert.deepEqual(size, { w: 100, h: 80 });
    for (const side of ['top', 'bottom', 'left', 'right']) {
        const local = outward(size.w, size.h, side, 0);
        const p = worldOf(doc, el, local);
        assert.ok(hitTest(doc, 0, p.x, p.y), `${side} 边界本身应命中`);
    }
});

test('hitTest：无容差时四个方向的边界外 1/2/3 像素都不命中', () => {
    const { doc, el } = makeScene(null);
    const size = elementSize(doc, el, 0);
    for (const side of ['top', 'bottom', 'left', 'right']) {
        for (const d of [1, 2, 3]) {
            const p = worldOf(doc, el, outward(size.w, size.h, side, d));
            assert.equal(hitTest(doc, 0, p.x, p.y), null, `${side} 外 ${d}px 不该命中`);
        }
    }
});

test('hitTest：边界内 1/2/3 像素都命中（不因夹取而漏掉内圈）', () => {
    const { doc, el } = makeScene(null);
    const size = elementSize(doc, el, 0);
    for (const side of ['top', 'bottom', 'left', 'right']) {
        for (const d of [-1, -2, -3]) {
            const p = worldOf(doc, el, outward(size.w, size.h, side, d));
            assert.ok(hitTest(doc, 0, p.x, p.y), `${side} 内 ${-d}px 应命中`);
        }
    }
});

test('hitTest：tolerance=2 时四方向外 1-2px 命中、3px 不命中', () => {
    const { doc, el } = makeScene(null);
    const size = elementSize(doc, el, 0);
    const opts = { tolerance: 2 };
    for (const side of ['top', 'bottom', 'left', 'right']) {
        for (const d of [1, 2]) {
            const p = worldOf(doc, el, outward(size.w, size.h, side, d));
            assert.ok(hitTest(doc, 0, p.x, p.y, opts), `${side} 外 ${d}px 在容差内`);
        }
        const far = worldOf(doc, el, outward(size.w, size.h, side, 3));
        assert.equal(hitTest(doc, 0, far.x, far.y, opts), null, `${side} 外 3px 超出容差`);
    }
});

test('hitTest：旋转 30° 后边界行为与未旋转一致（容差按局部像素算）', () => {
    const { doc, el } = makeScene({ rotate: 30 });
    const size = elementSize(doc, el, 0);
    for (const side of ['top', 'bottom', 'left', 'right']) {
        const on = worldOf(doc, el, outward(size.w, size.h, side, 0));
        assert.ok(hitTest(doc, 0, on.x, on.y), `旋转后 ${side} 边界命中`);
        const out1 = worldOf(doc, el, outward(size.w, size.h, side, 1));
        assert.equal(hitTest(doc, 0, out1.x, out1.y), null, `旋转后 ${side} 外 1px 不命中`);
        const out2 = worldOf(doc, el, outward(size.w, size.h, side, 2));
        assert.ok(hitTest(doc, 0, out2.x, out2.y, { tolerance: 2 }), `旋转后 ${side} 外 2px 在容差内`);
    }
});

test('hitTest：缩放 2× 与 0.5× 下，容差仍然以局部像素计（不随缩放放大）', () => {
    for (const scale of [2, 0.5]) {
        const { doc, el } = makeScene({ scaleX: scale, scaleY: scale });
        const size = elementSize(doc, el, 0);
        const right0 = worldOf(doc, el, outward(size.w, size.h, 'right', 0));
        assert.ok(hitTest(doc, 0, right0.x, right0.y), `scale=${scale} 右边界命中`);
        const right1 = worldOf(doc, el, outward(size.w, size.h, 'right', 1));
        assert.equal(hitTest(doc, 0, right1.x, right1.y), null, `scale=${scale} 外 1 局部像素不命中`);
        const right2 = worldOf(doc, el, outward(size.w, size.h, 'right', 2));
        assert.ok(hitTest(doc, 0, right2.x, right2.y, { tolerance: 2 }), `scale=${scale} 外 2 局部像素在容差内`);
    }
});

test('hitTest：容差按「屏幕像素 / zoom」换算时，命中距离与 zoom 无关', () => {
    const { doc, el } = makeScene(null);
    const size = elementSize(doc, el, 0);
    const screenPx = 3;
    for (const zoom of [2, 1, 0.5]) {
        const tol = screenPx / zoom;          // 屏幕 3px 对应的 doc 像素
        const inside = worldOf(doc, el, outward(size.w, size.h, 'right', tol * 0.9));
        const outside = worldOf(doc, el, outward(size.w, size.h, 'right', tol * 1.1));
        assert.ok(hitTest(doc, 0, inside.x, inside.y, { tolerance: tol }), `zoom=${zoom} 屏幕 2.7px 内命中`);
        assert.equal(hitTest(doc, 0, outside.x, outside.y, { tolerance: tol }), null, `zoom=${zoom} 屏幕 3.3px 外不命中`);
    }
});

test('hitTest：父级矩阵参与命中（父对象旋转 90° 后子对象仍按世界位置判定）', () => {
    const { doc, el } = makeScene(null);
    // 90° 旋转 + 平移 (200,40)：世界 = R·local + t
    const parentM = { a: 0, b: 1, c: -1, d: 0, e: 200, f: 40 };
    const local = { x: 50, y: 40 };
    const world = {
        x: parentM.a * local.x + parentM.c * local.y + parentM.e,
        y: parentM.b * local.x + parentM.d * local.y + parentM.f,
    };
    const opts = { parentMatrix: () => parentM };
    assert.ok(hitTest(doc, 0, world.x, world.y, opts), '父级旋转后仍能命中');
    // 同样的世界点，不给父级矩阵时远离对象本体 → 不该命中
    assert.equal(hitTest(doc, 0, world.x, world.y), null);
});

test('hitTest：网格 4×4 变形后，容差与 1×1 一致（不再随网格密度塌缩）', () => {
    const L = createLattice(4, 4);
    L.pts[12] = [0, -25];
    const { doc, el } = makeScene(null);
    const warpDoc = patchObject(doc, el.id, (o) => {
        const t = addKey({ keys: [] }, 0, { x: 0, y: 0, scaleX: 1, scaleY: 1, rotate: 0, warp: L }, 'linear');
        return Object.assign({}, o, { transform: t });
    });
    const warpEl = objectById(warpDoc, el.id);
    // 变形不平移边界：左边 x=0 外 1 局部像素在 1×1 下是 null、4×4 下也必须是 null
    const out1 = { x: -1, y: 40 };
    assert.equal(hitTest(warpDoc, 0, out1.x, out1.y), null, '4×4 网格外 1px 不命中');
    assert.ok(hitTest(warpDoc, 0, out1.x, out1.y, { tolerance: 2 }), '4×4 网格外 1px 在 tol=2 内命中');
    const out3 = { x: -3, y: 40 };
    assert.equal(hitTest(warpDoc, 0, out3.x, out3.y, { tolerance: 2 }), null, '4×4 网格外 3px 超出 tol=2');
    // 变形区域内部的点仍命中
    assert.ok(hitTest(warpDoc, 0, 50, 40), '变形网格内部命中');
    assert.equal(hitTest(warpDoc, 0, 50, -80), null, '远离变形区域不命中');
});

test('localUv：不夹取 —— 边界外的点给出负值/大于 1 的 uv', () => {
    const { doc, el } = makeScene(null);
    const size = elementSize(doc, el, 0);
    const inside = localUv(doc, el, 0, { x: 50, y: 40 }, null, 0);
    assert.ok(inside);
    assert.equal(inside.x, 50);
    assert.equal(inside.y, 40);

    const left1 = localUv(doc, el, 0, { x: -1, y: 40 }, null, 0);
    assert.ok(left1, 'tol=0 时仍有局部坐标（容差只影响判定，不影响反解）');
    assert.equal(left1.x, -1);
    assert.ok(left1.u < 0, `边界外 u 应为负，实际 ${left1.u}`);

    const right1 = localUv(doc, el, 0, { x: size.w + 1, y: 40 }, null, 0);
    assert.ok(right1.u > 1, `右边界外 u 应大于 1，实际 ${right1.u}`);
});

test('localUv 与 worldToLocal 的分歧：越界点前者保留、后者夹到边界', () => {
    const { doc, el } = makeScene(null);
    const p = { x: -1, y: 40 };
    const raw = localUv(doc, el, 0, p, null, 2);
    const clipped = worldToLocal(doc, el, 0, p);
    assert.ok(raw.u < 0, 'localUv 保留越界');
    assert.equal(clipped.u, 0, 'worldToLocal 夹到 0（这正是旧 hitTest 误判的来源）');
});

test('latticeInverseRaw：返回未夹取的 uv；latticeInverse 仍夹到 [0,1]', () => {
    const L = createLattice(1, 1);
    const w = 100;
    const h = 80;
    const raw = latticeInverseRaw(L, w, h, { x: -1, y: 40 }, { pad: 2, edge: 0.02 });
    assert.ok(raw, 'pad=2 时边界外 1px 能反解出来');
    assert.ok(raw[0] < 0, `未夹取 u 应为负，实际 ${raw[0]}`);
    const clipped = latticeInverse(L, w, h, { x: -1, y: 40 });
    assert.ok(clipped, '老接口仍能反解');
    assert.equal(clipped[0], 0, '老接口把 u 夹到 0');
    // 远点两边都是 null
    assert.equal(latticeInverseRaw(L, w, h, { x: -40, y: 40 }), null);
    assert.equal(latticeInverse(L, w, h, { x: -40, y: 40 }), null);
});

test('latticeInverse：默认参数下与改造前等价（1×1 网格往返 + 远点 null）', () => {
    const L = createLattice(1, 1);
    for (const p of [{ x: 10, y: 12 }, { x: 50, y: 40 }, { x: 99, y: 79 }]) {
        const back = latticeInverse(L, 100, 80, p);
        assert.ok(back);
        assert.ok(Math.abs(back[0] * 100 - p.x) < 1e-6);
        assert.ok(Math.abs(back[1] * 80 - p.y) < 1e-6);
    }
    assert.equal(latticeInverse(L, 100, 80, { x: 50, y: 300 }), null);
});

test('hitTest：透明像素仍决定命中（几何在内但 alpha=0 不命中）', () => {
    const base = createDoc({ width: 200, height: 160, fps: 10 });
    const el0 = base.objects[0];
    const img = fakeImage(100, 80, (x) => (x < 40 ? 255 : 0));
    const doc = patchObject(base, el0.id, (o) => setImageAt(o, 0, img));
    const el = objectById(doc, el0.id);
    assert.ok(hitTest(doc, 0, 20, 40), '不透明处命中');
    assert.equal(hitTest(doc, 0, 60, 40), null, '透明处不命中');
    // 右边界那列是透明的：几何在界内也不命中，但也不会因为 floor(1.0*w) 越界而崩
    const right = worldOf(doc, el, { x: 100, y: 40 });
    assert.equal(hitTest(doc, 0, right.x, right.y), null);
});

test('hitTest：对象尺寸为 0 时安全跳过（不产生 NaN 索引）', () => {
    const base = createDoc({ width: 200, height: 160, fps: 10 });
    const el0 = base.objects[0];
    const img = fakeImage(0, 0, () => 255);
    const doc = patchObject(base, el0.id, (o) => setImageAt(o, 0, img));
    assert.equal(hitTest(doc, 0, 50, 40), null);
});
