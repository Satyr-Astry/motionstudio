/**
 * 画布锚点（旋转原点）拖动的纯函数单测。
 *
 * 这块的几何全在 core 里，外壳只负责接线：命中判定 `pickAnchor` 与
 * 「指针 doc 坐标 → 锚点 uv」的 `anchorUvFromMatrix` 都是无 DOM 的纯函数，
 * 所以这里不需要 canvas 也能钉住两条最容易退化的约定：
 *
 *   1. 锚点必须**先于** 8 个缩放手柄命中。锚点默认在 (0,0)，和 nw 手柄完全重合，
 *      若交给 pickHandle 一并判，同距时手柄先返回，用户就永远拖不到原点
 *      （只会把对象缩小甚至翻转 —— 这才是「画布上拖不了旋转原点」的真因）。
 *   2. 锚点反解不能用 worldToLocal：那条路径有 1e-3 的严格容差，锚点正好压在
 *      对象边界上（v≈0），起步第一帧会被判成「出界」丢帧，表现为拖半天不动。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { HIT_PX, pickAnchor, pickHandle, anchorUvFromMatrix } from '../app/core/gizmo.mjs';
import { anchorPoint, invertMatrix, applyMatrix, elementMatrix, worldToLocal } from '../app/core/element.mjs';
import { createDoc, objectById, patchObject } from '../app/core/doc-model.mjs';

/** 100×80 的文档里放一个对象，返回 { doc, el } */
function scene(anchor) {
    let doc = createDoc({ width: 100, height: 80 });
    const id = doc.objects[0].id;
    doc = patchObject(doc, id, (o) => ({ ...o, anchor: anchor || { x: 0, y: 0 } }));
    return { doc, el: objectById(doc, id) };
}

/** 手工四边形（core 的 quad 是四角命名 tl/tr/br/bl）：左上 (10,20)，120×60，无旋转 */
const QUAD = {
    tl: { x: 10, y: 20 }, tr: { x: 130, y: 20 },
    br: { x: 130, y: 80 }, bl: { x: 10, y: 80 },
};

test('pickAnchor：半径内命中，半径外放行给手柄', () => {
    const a = { x: 100, y: 40 };
    assert.deepEqual(pickAnchor(a, { x: 100, y: 40 }), { kind: 'anchor', name: 'anchor' });
    assert.deepEqual(pickAnchor(a, { x: 100 + HIT_PX, y: 40 }), { kind: 'anchor', name: 'anchor' });
    assert.equal(pickAnchor(a, { x: 100 + HIT_PX + 0.5, y: 40 }), null);
    // 6 CSS px 是任务里的最小可用半径，HIT_PX 必须不低于它
    assert.ok(HIT_PX >= 6);
    // 自定阈值优先于 HIT_PX
    assert.equal(pickAnchor(a, { x: 103, y: 40 }, 2), null);
    assert.deepEqual(pickAnchor(a, { x: 103, y: 40 }, 4), { kind: 'anchor', name: 'anchor' });
});

test('pickAnchor：锚点坐标缺失或非数值时不猜（返回 null，不出 NaN 命中）', () => {
    assert.equal(pickAnchor(null, { x: 0, y: 0 }), null);
    assert.equal(pickAnchor({ x: 0, y: 0 }, null), null);
    // 历史 bug 现场：anchor 是 {x,y} 却被当成 [x,y] 取，得到 undefined
    assert.equal(pickAnchor({ x: undefined, y: undefined }, { x: 0, y: 0 }), null);
    assert.equal(pickAnchor([5, 5], { x: 5, y: 5 }), null);
});

test('pickAnchor 先于 pickHandle：锚点与 nw 手柄重合时仍然能拖到原点', () => {
    const p = { x: QUAD.tl.x, y: QUAD.tl.y };
    // 只判手柄 → nw 抢走，这正是修复前的行为
    assert.equal(pickHandle(QUAD, p).kind, 'scale');
    assert.equal(pickHandle(QUAD, p).name, 'nw');
    // 先判锚点 → anchor 赢
    assert.equal(pickAnchor(QUAD.tl, p).kind, 'anchor');
    // 锚点移开之后，nw 手柄照常可用（不能为了锚点把角上的缩放手柄废掉）
    const moved = { x: 100, y: 40 };
    assert.equal(pickAnchor(moved, p), null);
    assert.equal(pickHandle(QUAD, p).name, 'nw');
});

test('anchorUvFromMatrix：与 anchorPoint 的 size*a 严格互逆', () => {
    const size = { w: 100, h: 50 };
    const inv = invertMatrix({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    assert.deepEqual(anchorUvFromMatrix(inv, size, { x: 50, y: 25 }), { u: 0.5, v: 0.5 });
    assert.deepEqual(anchorUvFromMatrix(inv, size, { x: 0, y: 0 }), { u: 0, v: 0 });
    assert.deepEqual(anchorUvFromMatrix(inv, size, { x: 100, y: 50 }), { u: 1, v: 1 });
    // 越界统一夹到 [0,1]：拖出对象也只是把原点贴到边上，不产生负 uv
    assert.deepEqual(anchorUvFromMatrix(inv, size, { x: -40, y: 999 }), { u: 0, v: 1 });
});

test('anchorUvFromMatrix：带平移缩放旋转的矩阵也互逆', () => {
    const size = { w: 200, h: 100 };
    // 缩放 2x + 旋转 90° + 平移 (30,40)
    const m = { a: 0, b: 2, c: -2, d: 0, e: 30, f: 40 };
    const inv = invertMatrix(m);
    for (const [u, v] of [[0, 0], [0.25, 0.75], [1, 1], [0.5, 0.5]]) {
        const local = { x: size.w * u, y: size.h * v };
        const world = applyMatrix(m, local);
        const back = anchorUvFromMatrix(inv, size, world);
        assert.ok(Math.abs(back.u - u) < 1e-9, `u ${u} -> ${back.u}`);
        assert.ok(Math.abs(back.v - v) < 1e-9, `v ${v} -> ${back.v}`);
    }
});

test('anchorUvFromMatrix：与真实 elementMatrix/anchorPoint 闭环（锚点在对象角上也不丢帧）', () => {
    // 锚点故意放在 (0,0)：这正是默认值，也是「起步压在边界」的现场
    const { doc, el } = scene({ x: 0, y: 0 });
    const obj = { ...objectById(doc, el.id), anchor: { x: 0, y: 0 } };
    const size = { w: 100, h: 80 };
    const m = elementMatrix(obj, 0, size);
    const inv = invertMatrix(m);
    // 锚点世界坐标：反解回去必须是 (0,0)，也就是指针正好压在原点上时能拿到有效 uv
    const aWorld = applyMatrix(m, anchorPoint(obj, size));
    const uv = anchorUvFromMatrix(inv, size, aWorld);
    assert.ok(uv, '压在角上必须给出 uv，否则拖动第一帧丢帧');
    assert.ok(Math.abs(uv.u - 0) < 1e-6);
    assert.ok(Math.abs(uv.v - 0) < 1e-6);
    // 挪到对象中心再解，应得 0.5/0.5
    const centerWorld = applyMatrix(m, { x: size.w / 2, y: size.h / 2 });
    const cuv = anchorUvFromMatrix(inv, size, centerWorld);
    assert.ok(Math.abs(cuv.u - 0.5) < 1e-6);
    assert.ok(Math.abs(cuv.v - 0.5) < 1e-6);
});

test('anchorUvFromMatrix：矩阵不可逆或尺寸退化时返回 null 而不是 NaN', () => {
    const size = { w: 100, h: 50 };
    assert.equal(anchorUvFromMatrix(null, size, { x: 1, y: 1 }), null);
    assert.equal(anchorUvFromMatrix(undefined, size, { x: 1, y: 1 }), null);
    assert.equal(anchorUvFromMatrix(invertMatrix({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), null, { x: 1, y: 1 }), null);
    const inv = invertMatrix({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    assert.equal(anchorUvFromMatrix(inv, { w: 0, h: 50 }, { x: 1, y: 1 }), null);
    assert.equal(anchorUvFromMatrix(inv, { w: 100, h: 0 }, { x: 1, y: 1 }), null);
    assert.equal(anchorUvFromMatrix(inv, { w: 100, h: 50 }, { x: NaN, y: 1 }), null);
    // 零矩阵求逆得 null，走的是同一条早退
    assert.equal(anchorUvFromMatrix(invertMatrix({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 }), size, { x: 1, y: 1 }), null);
});

test('命中半径按屏幕像素算：zoom 1 / 2 / 0.5 下同一屏幕偏移的判定完全一致', () => {
    // pickAnchor 收的是屏幕坐标、阈值是 HIT_PX（屏幕像素），所以判定与 zoom 无关。
    // 反证：若阈值跟着 zoom 缩放（HIT_PX * zoom），缩小视图时命中区会一起变小，
    // 用户在 50% 缩放下就再也点不到原点。
    const aScr = { x: 100, y: 60 };
    for (const zoom of [1, 2, 0.5]) {
        assert.equal(pickAnchor(aScr, { x: aScr.x + 8, y: aScr.y }, HIT_PX).kind, 'anchor', `zoom ${zoom} 命中`);
        assert.equal(pickAnchor(aScr, { x: aScr.x + 10, y: aScr.y }, HIT_PX), null, `zoom ${zoom} 放行`);
    }
    // 只有当阈值被错误地乘上 zoom 时，8 屏幕像素才会在 50% 缩放下落空
    assert.equal(pickAnchor(aScr, { x: aScr.x + 8, y: aScr.y }, HIT_PX * 0.5), null);
});

test('锚点反解不靠 latticeInverse：指针拖到对象外很远时仍然给出夹取后的 uv', () => {
    // 这条钉的是「为什么不复用 worldToLocal」：latticeInverse 的包围盒只外扩
    // pad=2 像素（core/lattice.mjs:271-273），点一跑出对象就到 null，
    // 帧被丢弃 → 预览卡在边界。锚点只需要一次矩阵除法，越界夹到 [0,1] 就好。
    const { doc, el } = scene({ x: 0, y: 0 });
    const size = { w: 100, h: 80 };
    const obj = { ...objectById(doc, el.id), anchor: { x: 0, y: 0 } };
    const m = elementMatrix(obj, 0, size);
    const inv = invertMatrix(m);

    // 对象外 50px（局部坐标 -50,-50）：旧路子给 null
    const far = applyMatrix(m, { x: -50, y: -50 });
    assert.equal(worldToLocal(doc, obj, 0, far), null);
    assert.deepEqual(anchorUvFromMatrix(inv, size, far), { u: 0, v: 0 });

    // 边界附近（-1,-1）旧路子还能解出来 —— 说明它的问题不是「边界不收敛」，而是「一离开就 null」
    const near = applyMatrix(m, { x: -1, y: -1 });
    assert.ok(worldToLocal(doc, obj, 0, near));
    assert.deepEqual(anchorUvFromMatrix(inv, size, near), { u: 0, v: 0 });

    // 对象外的对角（右下方向跑出去）同样夹到 (1,1)
    const farBR = applyMatrix(m, { x: 260, y: 200 });
    assert.deepEqual(anchorUvFromMatrix(inv, size, farBR), { u: 1, v: 1 });
});
