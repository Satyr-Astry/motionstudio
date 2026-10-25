/**
 * 换父级保位置（L1）。
 *
 * 钉的是「对象原点在世界坐标里不动」。注意**只保位置、不保姿态**：
 * 父级带旋转/缩放时，子对象的姿态必然随父改变 —— 那是父子层级的定义，
 * 不是缺陷。所以这里一律拿锚点（默认就是原点）映射过去比较，
 * 而不是拿对象的某个局部点：拿局部点会误判成「应该保持姿态」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDoc, makeObject, addObject, patchObject, objectById } from '../app/core/doc-model.mjs';
import { createTrack, addKey } from '../app/core/transform.mjs';
import { elementSize, elementWorldMatrix, applyMatrix, reparentOffset } from '../app/core/element.mjs';
import { setParent } from '../app/core/timegraph.mjs';

const EPS = 1e-9;

/** 祖先链矩阵（不含自身，自根向下累乘）—— 与生产的 chainMatrix 同义，测试里独立实现以免自证。 */
function parentMatrixOf(doc, el, t) {
    const chain = [];
    let cur = el && el.parentId != null ? objectById(doc, el.parentId) : null;
    let guard = 0;
    while (cur && guard < 64) {
        chain.push(cur);
        cur = cur.parentId != null ? objectById(doc, cur.parentId) : null;
        guard += 1;
    }
    let M = null;
    for (let i = chain.length - 1; i >= 0; i--) {
        M = elementWorldMatrix(chain[i], t, elementSize(doc, chain[i], t), M);
    }
    return M;
}

function worldOf(doc, id, t) {
    const el = objectById(doc, id);
    return elementWorldMatrix(el, t, elementSize(doc, el, t), parentMatrixOf(doc, el, t));
}

function worldPoint(doc, id, t, p) {
    const el = objectById(doc, id);
    const size = elementSize(doc, el, t);
    // 锚点默认 (0,0) 就是对象原点；用 anchor 而不是硬编码 {0,0}，
    // 将来锚点改了这里也仍然对
    const a = el.anchor && typeof el.anchor === 'object' ? el.anchor : { x: 0.5, y: 0.5 };
    return applyMatrix(worldOf(doc, id, t), p || { x: (size.w || 0) * a.x, y: (size.h || 0) * a.y });
}

function near(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y) < EPS;
}

function withTransform(doc, id, list) {
    let track = createTrack();
    for (const st of list) track = addKey(track, Number(st.at) || 0, st);
    return patchObject(doc, id, (o) => ({ ...o, transform: track }));
}

/** 父 p + 子 c（子固定在 40,30）。 */
function baseDoc() {
    let doc = createDoc({ width: 200, height: 120, fps: 12 });
    doc = addObject(doc, makeObject({ id: 'p', name: '父' }));
    doc = addObject(doc, makeObject({ id: 'c', name: '子' }));
    doc = withTransform(doc, 'c', [{ at: 0, x: 40, y: 30 }]);
    return doc;
}

function reparent(doc, id, parentId) {
    // 生产里 offsetOf 只收 (el, parentId) 两参，时刻由调用方闭包捕获（ctx-time 用 now()）
    return setParent(doc, id, parentId, (el, pid) => reparentOffset(doc, el, pid, 0));
}

test('换父：父没有任何变换时，子对象在世界里不动', () => {
    const doc = baseDoc();
    const before = worldPoint(doc, 'c', 0);
    const res = reparent(doc, 'c', 'p');
    assert.equal(res.ok, true, res.reason);
    assert.equal(objectById(res.doc, 'c').parentId, 'p');
    assert.ok(near(before, worldPoint(res.doc, 'c', 0)), '世界坐标必须一致');
});

test('换父：父旋转 30° 且带位移时，子对象在世界里不动', () => {
    const doc = withTransform(baseDoc(), 'p', [{ at: 0, x: 30, y: 20, rotate: 30 }]);
    const before = worldPoint(doc, 'c', 0);
    const res = reparent(doc, 'c', 'p');
    assert.equal(res.ok, true, res.reason);
    assert.ok(near(before, worldPoint(res.doc, 'c', 0)), '旋转父级下世界坐标必须一致');
});

test('换父：父缩放 0.5 与 2 时，子对象在世界里不动', () => {
    for (const s of [0.5, 2]) {
        const doc = withTransform(baseDoc(), 'p', [{ at: 0, x: 10, y: -6, scaleX: s, scaleY: s }]);
        const before = worldPoint(doc, 'c', 0);
        const res = reparent(doc, 'c', 'p');
        assert.equal(res.ok, true, res.reason);
        assert.ok(near(before, worldPoint(res.doc, 'c', 0)), '缩放 ' + s + ' 父级下世界坐标必须一致');
    }
});

test('换父：父的变换不可逆时拒绝，并给中文原因（不静默跳位）', () => {
    const doc = withTransform(baseDoc(), 'p', [{ at: 0, scaleX: 0 }]);
    const res = reparent(doc, 'c', 'p');
    assert.equal(res.ok, false);
    assert.match(res.reason, /无法求逆|跳位/);
    // 文档原样返回，parentId 没被改
    assert.equal(objectById(res.doc, 'c').parentId == null, true);
});

test('脱离父级：回到原来的世界位置', () => {
    const doc = withTransform(baseDoc(), 'p', [{ at: 0, x: 30, y: 20, rotate: 30, scaleX: 0.5, scaleY: 0.5 }]);
    const origin = worldPoint(doc, 'c', 0);
    const joined = reparent(doc, 'c', 'p');
    assert.equal(joined.ok, true, joined.reason);
    assert.ok(near(origin, worldPoint(joined.doc, 'c', 0)));
    const out = reparent(joined.doc, 'c', null);
    assert.equal(out.ok, true, out.reason);
    assert.equal(objectById(out.doc, 'c').parentId == null, true);
    assert.ok(near(origin, worldPoint(out.doc, 'c', 0)), '进出父级一个来回，世界坐标必须回到原处');
});

test('父级带关键帧：换父这一刻不跳，其它时刻随父运动（这是父子的定义）', () => {
    // 父在 t=0 平移 0、t=1 平移 (100,40)。换父时按 t=0 算位移（父那一刻没位移，
    // 所以子局部不变），于是 t=1 的子世界位置自然跟着父走 —— 那不是「漂移」，
    // 是父子层级的正常效果。真正要钉住的是「换父这一刻画面不跳」。
    //
    // 为什么补偿不是「逐帧各算一次」：`setParent` 只在**调用的那一刻**算一次 dx/dy，
    // 再把它加到该对象的所有关键帧上。逐帧各算会把子对象自己的动画曲线一起改写掉 ——
    // 换父是层级操作，不是「让子对象在任何时刻都定格在原来的世界位置」。子对象有自己
    // 的关键帧时，换父之后跟着父一起动才是它该有的行为；补偿只发生在换父那一瞬间。
    // 所以下面的断言是「t=0 不跳」+「t=1 随父移动 (100,40)」，而不是「t=0 与 t=1 都不动」。
    const doc = withTransform(baseDoc(), 'p', [
        { at: 0, x: 0, y: 0 },
        { at: 1, x: 100, y: 40 },
    ]);
    const b0 = worldPoint(doc, 'c', 0);
    const res = reparent(doc, 'c', 'p');
    assert.equal(res.ok, true, res.reason);
    assert.ok(near(b0, worldPoint(res.doc, 'c', 0)), '换父这一刻的世界坐标必须一致');
    const after1 = worldPoint(res.doc, 'c', 1);
    assert.ok(near({ x: b0.x + 100, y: b0.y + 40 }, after1), '其它时刻应随父运动，而不是留在原地');
});

test('一步撤销：旧 doc 原封不动，换父只产出新 doc', () => {
    const doc = baseDoc();
    const beforeChild = objectById(doc, 'c');
    const res = reparent(doc, 'c', 'p');
    assert.equal(res.ok, true, res.reason);
    assert.notEqual(res.doc, doc, '必须换新引用（不可变），否则撤销拿不回旧状态');
    // 旧 doc 完全没被改：层级与位置都在原处 —— 撤销 = 切回这个引用
    assert.equal(objectById(doc, 'c').parentId == null, true);
    assert.equal(objectById(doc, 'c').transform.keys[0].state.x, beforeChild.transform.keys[0].state.x);
    assert.ok(near(worldPoint(doc, 'c', 0), worldPoint(res.doc, 'c', 0)), '旧 doc 与换父后的画面必须一致');
});

test('环与自指仍然拒绝（原有语义不能因为加位移而松动）', () => {
    const doc = baseDoc();
    assert.equal(reparent(doc, 'c', 'c').ok, false);
    const joined = reparent(doc, 'c', 'p');
    assert.equal(joined.ok, true);
    const cyc = reparent(joined.doc, 'p', 'c');
    assert.equal(cyc.ok, false);
    assert.match(cyc.reason, /环/);
});

test('不传 offsetOf 时退化为旧行为（只改 parentId）', () => {
    const doc = baseDoc();
    const res = setParent(doc, 'c', 'p');
    assert.equal(res.ok, true);
    assert.equal(objectById(res.doc, 'c').parentId, 'p');
    // 位置保持原样，这正是旧行为 —— 保留它是为了不让不关心几何的调用方被迫适配
    assert.equal(objectById(res.doc, 'c').transform.keys[0].state.x, 40);
    assert.equal(objectById(res.doc, 'c').transform.keys[0].state.y, 30);
});

test('reparentOffset 的直线情形：应等于负的新父位移', () => {
    const doc = withTransform(baseDoc(), 'p', [{ at: 0, x: 70, y: -25 }]);
    const r = reparentOffset(doc, objectById(doc, 'c'), 'p', 0);
    assert.equal(r.ok, true, r.reason);
    assert.ok(Math.abs(r.dx + 70) < EPS, 'dx 应为 -70，实际 ' + r.dx);
    assert.ok(Math.abs(r.dy - 25) < EPS, 'dy 应为 +25，实际 ' + r.dy);
});
