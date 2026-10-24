/**
 * element.mjs 单测（时间模型 v6）。
 *
 * 契约变化：几何 API 的第 3 / 4 个参数统一是 `time`（秒），不再有 frameIndex；
 * 文档里也没有 `doc.frames` 了 —— 对象的画格是 `obj.cels = [{ at, image }]`，
 * 取某一时刻的位图用 doc-model 的 `imageAt(obj, t)`（画格一直沿用到下一个画格）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HANDLES, elementState, elementSize, anchorPoint, mulMatrix, invertMatrix, applyMatrix,
    elementMatrix, quadPoint, quadInverse, elementQuad, worldToLocal, localToWorld,
    handlePoints, pixelAlpha, hitTest,
} from '../app/core/element.mjs';
import { createDoc, imageAt, objectById, patchObject, setImageAt } from '../app/core/doc-model.mjs';
import { addKey } from '../app/core/transform.mjs';

/** 造一个假位图：只有 alpha 有意义（轻量壳，不引入 canvas 依赖） */
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
                            const a = alphaAt(x + i, y + j);
                            const o = (j * ww + i) * 4;
                            data[o] = 0; data[o + 1] = 0; data[o + 2] = 0; data[o + 3] = a;
                        }
                    }
                    return { data, width: ww, height: hh };
                },
            };
        },
    };
}

/**
 * 100x80 文档，唯一对象的左 40% 不透明、其余为 0（留出边界余量，便于旋转测试）。
 * 画格是 `{at: 0, image}` —— 从 0 秒起一直有效。
 */
function makeDoc(withPixel) {
    const base = createDoc({ width: 100, height: 80, fps: 10 });
    const el = base.objects[0];
    if (!withPixel) return { doc: base, el };
    const img = fakeImage(100, 80, (x) => (x < 40 ? 255 : 0));
    const doc = patchObject(base, el.id, (o) => setImageAt(o, 0, img));
    return { doc, el: objectById(doc, el.id) };
}

/** 在 t=0 打一条轨道（transform 只由它决定，避开对象自身轨道） */
function withKeys(el, keys) {
    const e = Object.assign({}, el, { transform: { keys: [] } });
    keys.forEach((k) => { e.transform = addKey(e.transform, k.t, k.state, k.ease || 'linear'); });
    return e;
}

test('invertMatrix：单位矩阵求逆仍是单位矩阵', () => {
    const inv = invertMatrix({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    assert.deepEqual(inv, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
});

test('invertMatrix：平移矩阵求逆得到反方向平移', () => {
    const inv = invertMatrix({ a: 1, b: 0, c: 0, d: 1, e: 30, f: -12 });
    assert.equal(inv.e, -30);
    assert.equal(inv.f, 12);
});

test('invertMatrix：退化矩阵返回 null', () => {
    assert.equal(invertMatrix({ a: 0, b: 0, c: 0, d: 0, e: 5, f: 5 }), null);
});

test('applyMatrix + invertMatrix：点往返一致', () => {
    const m = { a: 2, b: 0.3, c: -0.7, d: 1.5, e: 12, f: -8 };
    const inv = invertMatrix(m);
    const back = applyMatrix(inv, applyMatrix(m, { x: 17, y: 23 }));
    assert.ok(Math.abs(back.x - 17) < 1e-9);
    assert.ok(Math.abs(back.y - 23) < 1e-9);
});

test('mulMatrix：与单位矩阵相乘不变', () => {
    const m = { a: 1.2, b: 0.1, c: -0.2, d: 0.9, e: 4, f: 5 };
    const id = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    assert.deepEqual(mulMatrix(m, id), m);
    assert.deepEqual(mulMatrix(id, m), m);
});

test('elementState：无轨道时给出默认状态', () => {
    const st = elementState({}, 0.5);
    assert.equal(st.x, 0);
    assert.equal(st.scaleX, 1);
    assert.equal(st.rotate, 0);
});

test('elementSize：有画格位图时用位图尺寸', () => {
    const { doc, el } = makeDoc(true);
    const size = elementSize(doc, el, 0);
    assert.deepEqual(size, { w: 100, h: 80 });
    // 画格沿用：t=3.7 仍取 at=0 那张图
    assert.equal(imageAt(el, 3.7), imageAt(el, 0));
});

test('elementSize：画格没有位图时回退文档尺寸', () => {
    const { doc, el } = makeDoc(false);
    assert.equal(imageAt(el, 0), null);
    assert.deepEqual(elementSize(doc, el, 0), { w: 100, h: 80 });
});

test('anchorPoint：默认取中心', () => {
    assert.deepEqual(anchorPoint({}, { w: 100, h: 80 }), { x: 50, y: 40 });
});

test('elementMatrix：锚点中心旋转 90° 后中心不动', () => {
    const size = { w: 100, h: 80 };
    const el = withKeys({ anchor: { x: 0.5, y: 0.5 } }, [{ t: 0, state: { rotate: 90 } }]);
    const m = elementMatrix(el, 0, size);
    const c = applyMatrix(m, { x: 50, y: 40 });
    assert.ok(Math.abs(c.x - 50) < 1e-9);
    assert.ok(Math.abs(c.y - 40) < 1e-9);
});

test('elementMatrix：锚点中心缩放 2x 后中心不动、左上角外扩', () => {
    const size = { w: 100, h: 80 };
    const el = withKeys({ anchor: { x: 0.5, y: 0.5 } }, [{ t: 0, state: { scaleX: 2, scaleY: 2 } }]);
    const m = elementMatrix(el, 0, size);
    const c = applyMatrix(m, { x: 50, y: 40 });
    assert.ok(Math.abs(c.x - 50) < 1e-9);
    const tl = applyMatrix(m, { x: 0, y: 0 });
    assert.ok(Math.abs(tl.x - -50) < 1e-9);
    assert.ok(Math.abs(tl.y - -40) < 1e-9);
});

test('elementMatrix：无锚点（0,0）时等于 matrixOf', () => {
    const el = withKeys({ anchor: { x: 0, y: 0 } }, [{ t: 0, state: { x: 10, y: 20, rotate: 30 } }]);
    const m = elementMatrix(el, 0, { w: 100, h: 80 });
    assert.ok(Math.abs(m.e - 10) < 1e-9);
    assert.ok(Math.abs(m.f - 20) < 1e-9);
});

test('quadPoint：四角与中点', () => {
    const q = { tl: { x: 0, y: 0 }, tr: { x: 10, y: 0 }, br: { x: 10, y: 10 }, bl: { x: 0, y: 10 } };
    assert.deepEqual(quadPoint(q, 0, 0), { x: 0, y: 0 });
    assert.deepEqual(quadPoint(q, 1, 1), { x: 10, y: 10 });
    assert.deepEqual(quadPoint(q, 0.5, 0.5), { x: 5, y: 5 });
});

test('quadInverse：矩形内点能解回 uv', () => {
    const q = { tl: { x: 0, y: 0 }, tr: { x: 100, y: 0 }, br: { x: 100, y: 80 }, bl: { x: 0, y: 80 } };
    const uv = quadInverse(q, { x: 25, y: 20 });
    assert.ok(Math.abs(uv.u - 0.25) < 1e-6);
    assert.ok(Math.abs(uv.v - 0.25) < 1e-6);
});

test('quadInverse：歪斜四边形也能解回', () => {
    const q = { tl: { x: 10, y: 0 }, tr: { x: 110, y: 15 }, br: { x: 95, y: 95 }, bl: { x: 0, y: 80 } };
    const p = quadPoint(q, 0.3, 0.7);
    const uv = quadInverse(q, p);
    assert.ok(Math.abs(uv.u - 0.3) < 1e-4);
    assert.ok(Math.abs(uv.v - 0.7) < 1e-4);
});

test('quadInverse：远离四边形返回 null', () => {
    const q = { tl: { x: 0, y: 0 }, tr: { x: 10, y: 0 }, br: { x: 10, y: 10 }, bl: { x: 0, y: 10 } };
    assert.equal(quadInverse(q, { x: 500, y: 500 }), null);
});

test('elementQuad：无变换时等于内容矩形', () => {
    const { doc, el } = makeDoc(false);
    const q = elementQuad(doc, el, 0);
    assert.deepEqual(q.tl, { x: 0, y: 0 });
    assert.deepEqual(q.br, { x: 100, y: 80 });
});

test('elementQuad：warp 生效后四角跟着移动', () => {
    const { doc, el } = makeDoc(false);
    const e = withKeys(el, [{ t: 0, state: { warp: { tl: [10, 5], tr: [0, 0], br: [0, 0], bl: [0, 0] } } }]);
    const q = elementQuad(doc, e, 0);
    assert.deepEqual(q.tl, { x: 10, y: 5 });
    assert.deepEqual(q.tr, { x: 100, y: 0 });
});

test('elementQuad：平移后四角整体位移', () => {
    const { doc, el } = makeDoc(false);
    const e = withKeys(el, [{ t: 0, state: { x: 30, y: -10 } }]);
    const q = elementQuad(doc, e, 0);
    assert.deepEqual(q.tl, { x: 30, y: -10 });
    assert.deepEqual(q.br, { x: 130, y: 70 });
});

test('worldToLocal / localToWorld：中心往返（第 3 参是秒）', () => {
    const { doc, el } = makeDoc(false);
    const e = withKeys(el, [{ t: 0, state: { x: 15, y: 5, scaleX: 1.5, rotate: 20 } }]);
    const world = localToWorld(doc, e, 0, { x: 30, y: 20 });
    const back = worldToLocal(doc, e, 0, world);
    assert.ok(Math.abs(back.u - 30 / 100) < 1e-4);
    assert.ok(Math.abs(back.v - 20 / 80) < 1e-4);
});

test('handlePoints：八个手柄，顺序固定', () => {
    const { doc, el } = makeDoc(false);
    const hp = handlePoints(doc, el, 0);
    assert.equal(hp.handles.length, 8);
    assert.deepEqual(hp.handles.map((h) => h.name), HANDLES);
});

test('handlePoints：nw 在左上、se 在右下', () => {
    const { doc, el } = makeDoc(false);
    const hp = handlePoints(doc, el, 0);
    const nw = hp.handles.find((h) => h.name === 'nw');
    const se = hp.handles.find((h) => h.name === 'se');
    assert.deepEqual({ x: nw.x, y: nw.y }, { x: 0, y: 0 });
    assert.deepEqual({ x: se.x, y: se.y }, { x: 100, y: 80 });
});

test('handlePoints：旋转手柄在上边中点，方向朝上', () => {
    const { doc, el } = makeDoc(false);
    const hp = handlePoints(doc, el, 0);
    assert.deepEqual({ x: hp.rotate.x, y: hp.rotate.y }, { x: 50, y: 0 });
    assert.ok(Math.abs(hp.rotate.dir.x) < 1e-9);
    assert.ok(Math.abs(hp.rotate.dir.y + 1) < 1e-9);
});

test('pixelAlpha：越界返回 0', () => {
    const { el } = makeDoc(true);
    const image = imageAt(el, 0);
    assert.equal(pixelAlpha(image, -1, 0), 0);
    assert.equal(pixelAlpha(image, 200, 0), 0);
    assert.equal(pixelAlpha(null, 0, 0), 0);
});

test('hitTest：不透明处命中', () => {
    const { doc, el } = makeDoc(true);
    const r = hitTest(doc, 0, 20, 40);
    assert.ok(r);
    assert.equal(r.id, el.id);
    assert.equal(r.alpha, 255);
});

test('hitTest：透明处不命中', () => {
    const { doc } = makeDoc(true);
    assert.equal(hitTest(doc, 0, 90, 40), null);
});

test('hitTest：画布外不命中', () => {
    const { doc } = makeDoc(true);
    assert.equal(hitTest(doc, 0, -20, 40), null);
});

test('hitTest：隐藏或锁定的元素跳过', () => {
    const { doc, el } = makeDoc(true);
    const hidden = Object.assign({}, doc, { objects: [Object.assign({}, el, { visible: false })] });
    assert.equal(hitTest(hidden, 0, 20, 40), null);
    const locked = Object.assign({}, doc, { objects: [Object.assign({}, el, { locked: true })] });
    assert.equal(hitTest(locked, 0, 20, 40), null);
});

test('hitTest：skip 指定的元素被穿透', () => {
    const { doc, el } = makeDoc(true);
    assert.equal(hitTest(doc, 0, 20, 40, { skip: [el.id] }), null);
});

test('hitTest：旋转 90° 后命中区域跟着转', () => {
    const { doc, el } = makeDoc(true);
    // 左半不透明；绕中心旋转 90° 后，不透明区域转到「上半」
    // anchor 必须写在 el 之后：el 自带 anchor {0,0}，否则旋转是绕左上角而不是绕中心
    const e = withKeys(Object.assign({}, el, { anchor: { x: 0.5, y: 0.5 } }), [{ t: 0, state: { rotate: 90 } }]);
    const rot = Object.assign({}, doc, { objects: [e] });
    assert.equal(hitTest(doc, 0, 20, 40) !== null, true, '未旋转时左侧命中');
    assert.equal(hitTest(rot, 0, 20, 40), null, '旋转后原左侧不命中');
    assert.ok(hitTest(rot, 0, 50, 20), '旋转后上半命中');
});

test('hitTest：多层时取最上层', () => {
    const { doc, el } = makeDoc(true);
    // objects[0] 是最上层；两层共用同一个画格位图
    const extra = Object.assign({}, el, { id: 'top', transform: { keys: [] } });
    const two = Object.assign({}, doc, { objects: [extra, el] });
    const r = hitTest(two, 0, 20, 40);
    assert.equal(r.id, 'top');
});

test('hitTest：opacity 为 0 的元素仍参与命中（像素决定）', () => {
    const { doc, el } = makeDoc(true);
    const faded = Object.assign({}, doc, { objects: [Object.assign({}, el, { opacity: 0 })] });
    const r = hitTest(faded, 0, 20, 40);
    assert.equal(r.id, el.id);
});
