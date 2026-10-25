// app/core/evaluator.mjs 的单元测试（v6 纯时间模型）。
// 文档一律手搓字面量：求值器只读 doc，不需要建文档的辅助函数。
// v6 起没有「帧」这回事，纹理是 { at(秒), image }，测试全部以秒为单位断言。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createEvaluator,
    drawEvaluated,
    mulMatrix,
    matrixTuple,
    transformPoint,
    IDENTITY_MATRIX,
} from '../app/core/evaluator.mjs';
import { createTrack, addKey } from '../app/core/transform.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

// ---- 夹具 ---------------------------------------------------------------

/** 假位图：求值器只需要 width/height，绘制时原样丢给 ctx.drawImage。 */
function imageOf(w, h, tag) {
    return { width: w, height: h, tag: tag || 'img' };
}

function trackOf(x, y) {
    let trk = createTrack();
    trk = addKey(trk, 0, { x: x || 0, y: y || 0, rotate: 0, scaleX: 1, scaleY: 1, opacity: 1 }, 'linear');
    return trk;
}

/** 一个对象：默认 at:0 的空纹理，父级为 null。 */
function objectOf(id, patch) {
    return Object.assign(
        {
            id,
            name: id,
            visible: true,
            locked: false,
            opacity: 1,
            mixMode: 'source-over',
            effects: [],
            parentId: null,
            cels: [{ at: 0, image: null }],
        },
        patch || {},
    );
}

function docOf(objects, patch) {
    return Object.assign({ width: 100, height: 80, fps: 10, duration: 4, objects }, patch || {});
}

function fakeCtx() {
    const calls = [];
    const stack = [];
    const g = {
        calls,
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        filter: 'none',
        save() {
            stack.push({ alpha: g.globalAlpha, mix: g.globalCompositeOperation, filter: g.filter });
            calls.push(['save']);
        },
        restore() {
            const s = stack.pop();
            if (s) {
                g.globalAlpha = s.alpha;
                g.globalCompositeOperation = s.mix;
                g.filter = s.filter;
            }
            calls.push(['restore']);
        },
        transform(a, b, c, d, e, f) {
            calls.push(['transform', a, b, c, d, e, f]);
        },
        drawImage(img, x, y) {
            calls.push(['drawImage', img, x, y]);
        },
        drewImage() {
            return calls.some((c) => c[0] === 'drawImage');
        },
    };
    return g;
}

// ---- 纹理：按时间取图 ---------------------------------------------------

test('imageOf / celAt 按时间取纹理，对象与 id 都吃得下', () => {
    const A = imageOf(64, 48, 'A');
    const B = imageOf(80, 60, 'B');
    const obj = objectOf('a', {
        cels: [
            { at: 0, image: A },
            { at: 2, image: B },
        ],
    });
    const ev = createEvaluator(docOf([obj]));

    assert.equal(ev.imageOf('a', 0), A);
    assert.equal(ev.imageOf(obj, 1.999), A, '下一个纹理生效前仍是 A');
    assert.equal(ev.imageOf('a', 2), B, 'at:2 起换成 B');
    assert.equal(ev.imageOf('a', 3.5), B, '一直生效到文档末尾');

    assert.equal(ev.celAt('a', 1).at, 0);
    assert.equal(ev.celAt('a', 2).at, 2);
    assert.equal(ev.celAt('a', 2).image, B);
});

test('t 早于第一个纹理时没有生效纹理', () => {
    const A = imageOf(30, 30, 'A');
    const ev = createEvaluator(docOf([objectOf('a', { cels: [{ at: 3, image: A }] })]));
    assert.equal(ev.imageOf('a', 1), null);
    assert.equal(ev.celAt('a', 1), null);
    assert.equal(ev.imageOf('a', 3), A);
});

test('尺寸取生效位图；没有位图回退文档尺寸', () => {
    const ev = createEvaluator(
        docOf([
            objectOf('a', { cels: [{ at: 0, image: imageOf(64, 48) }] }),
            objectOf('b', { cels: [{ at: 0, image: null }] }),
        ]),
    );
    assert.deepEqual(ev.lattice('a', 0).size, { w: 64, h: 48 });
    assert.deepEqual(ev.lattice('b', 0).size, { w: 100, h: 80 }, '回退 doc.width/height');
});

// ---- 四角 ---------------------------------------------------------------

test('quad 返回 {tl,tr,br,bl} 的 [x,y] 数组', () => {
    const ev = createEvaluator(docOf([objectOf('a', { cels: [{ at: 0, image: imageOf(100, 80) }] })]));
    const q = ev.quad('a', 0);
    for (const k of ['tl', 'tr', 'br', 'bl']) {
        assert.ok(Array.isArray(q[k]), `${k} 是数组`);
        assert.equal(q[k].length, 2, `${k} 是 [x,y]`);
        assert.ok(Number.isFinite(q[k][0]) && Number.isFinite(q[k][1]), `${k} 数值有限`);
    }
    assert.deepEqual(q.tl, [0, 0]);
    assert.deepEqual(q.tr, [100, 0]);
    assert.deepEqual(q.br, [100, 80]);
    assert.deepEqual(q.bl, [0, 80]);
});

test('quad 跟着平移走', () => {
    const ev = createEvaluator(
        docOf([objectOf('a', { cels: [{ at: 0, image: imageOf(100, 80) }], transform: trackOf(10, 20) })]),
    );
    const q = ev.quad('a', 0);
    assert.deepEqual(q.tl, [10, 20]);
    assert.deepEqual(q.br, [110, 100]);
});

// ---- 世界矩阵 -----------------------------------------------------------

test('matrix 走父链：父 × 子逐级相乘', () => {
    const parent = objectOf('p', { transform: trackOf(10, 0) });
    const child = objectOf('c', { parentId: 'p', transform: trackOf(5, 0) });
    const ev = createEvaluator(docOf([parent, child]));

    const m = ev.matrix('c', 0);
    assert.ok(Array.isArray(m), '矩阵是 [a,b,c,d,e,f] 六元组');
    near(m[0], 1);
    near(m[3], 1);
    near(m[4], 15, 1e-9);
    near(m[5], 0, 1e-9);
    near(ev.matrix('p', 0)[4], 10, 1e-9);
    assert.deepEqual(matrixTuple(m), m, '六元组可二次传入');
});

test('parentId 成环时就地停下，不会死循环', () => {
    const a = objectOf('a', { parentId: 'b', transform: trackOf(1, 0) });
    const b = objectOf('b', { parentId: 'a', transform: trackOf(2, 0) });
    const ev = createEvaluator(docOf([a, b]));
    const m = ev.matrix('a', 0);
    assert.ok(Number.isFinite(m[4]) && Number.isFinite(m[5]));
    assert.equal(ev.imageOf('a', 0), null);
});

test('超长父链（>64 层）安全截断', () => {
    const objects = [];
    for (let i = 0; i < 90; i++) {
        objects.push(objectOf('l' + i, { parentId: i === 0 ? null : 'l' + (i - 1), transform: trackOf(1, 0) }));
    }
    const ev = createEvaluator(docOf(objects));
    const m = ev.matrix('l89', 0);
    assert.ok(Number.isFinite(m[4]), 'e 有限');
    assert.ok(Number.isFinite(m[0]) && Number.isFinite(m[3]), 'a/d 有限');
});

// ---- 时间通道 -----------------------------------------------------------

test('localTime 走时间通道，父级时间会传给子级', () => {
    const fast = objectOf('a', {
        time: { mode: 'none', offset: 0, scale: 2 },
        transform: trackOf(50, 0),
    });
    const ev = createEvaluator(docOf([fast]));

    near(ev.localTime(fast, 1), 2, 1e-9, '局部时间被放大两倍');
    near(ev.state('a', 1).x, 50, 1e-9);
    near(ev.matrix('a', 1)[4], 50, 1e-9);

    // 非法输入回到全局时间，不抛
    const ev2 = createEvaluator(docOf([objectOf('b')]));
    assert.equal(ev2.localTime(null, 3), 3);
});

// ---- sample / 缓存 ------------------------------------------------------

test('sample 记录：没有 frame 字段，每层带 celAt', () => {
    const A = imageOf(20, 10, 'A');
    const obj = objectOf('a', {
        cels: [
            { at: 0, image: A },
            { at: 2, image: imageOf(20, 10, 'B') },
        ],
    });
    const ev = createEvaluator(docOf([obj]));
    const rec = ev.sample(1);

    assert.deepEqual(Object.keys(rec).sort(), ['layers', 't', 'total']);
    assert.equal(rec.t, 1);
    assert.equal(rec.total, 4);
    assert.equal('frame' in rec, false, '顶层不再有 frame');
    assert.equal(rec.layers.length, 1);
    const L = rec.layers[0];
    assert.equal('frame' in L, false, '层记录不再有 frame');
    assert.equal(L.celAt, 0, '当前生效纹理的 at');
    assert.equal(L.image, A);
    assert.equal(L.visible, true);
    assert.ok(Array.isArray(L.matrix));
    assert.deepEqual(Object.keys(L.quad).sort(), ['bl', 'br', 'tl', 'tr']);

    assert.equal(ev.sample(2).layers[0].celAt, 2);
    assert.equal(ev.sample(1).layers[0].celAt, 0);
});

test('sample 同一时刻命中缓存，invalidate / 换 doc 后失效', () => {
    const ev = createEvaluator(docOf([objectOf('a', { transform: trackOf(7, 0) })]));
    const r1 = ev.sample(1);
    const r2 = ev.sample(1);
    assert.equal(r1, r2, '同一 key 返回同一对象');
    near(r2.layers[0].matrix[4], 7, 1e-9);
    // 浮点噪声落在同一微秒键上，也算命中
    assert.equal(ev.sample(1 + 1e-9), r1);

    ev.invalidate();
    const r3 = ev.sample(1);
    assert.notEqual(r3, r1, 'invalidate 后重算');
    near(r3.layers[0].matrix[4], 7, 1e-9);

    ev.doc = docOf([objectOf('a', { transform: trackOf(9, 0) })]);
    const r4 = ev.sample(1);
    near(r4.layers[0].matrix[4], 9, 1e-9, '换 doc 后按新文档求值');
});

test('缓存容量 64：最旧的时刻会被淘汰', () => {
    const ev = createEvaluator(docOf([objectOf('a', { transform: trackOf(1, 0) })]));
    const first = ev.sample(0);
    for (let i = 1; i <= 70; i++) ev.sample(i * 0.5);
    const again = ev.sample(0);
    assert.notEqual(again, first, 'sample(0) 已被挤出缓存');
    near(again.layers[0].matrix[4], 1, 1e-9);
});

// ---- 脏输入 -------------------------------------------------------------

test('doc 为 null / 字段脏 / t 为 NaN 都不抛异常', () => {
    const empty = createEvaluator(null);
    assert.equal(empty.total(), 0);
    assert.deepEqual(empty.sample(0).layers, []);
    assert.deepEqual(empty.sample(NaN).layers, []);
    assert.equal(empty.imageOf(null, 0), null);
    assert.equal(empty.celAt('nope', 0), null);
    assert.deepEqual(empty.matrix(null, 0), [1, 0, 0, 1, 0, 0]);
    const q = empty.quad(null, 0);
    for (const k of ['tl', 'tr', 'br', 'bl']) {
        assert.ok(Number.isFinite(q[k][0]) && Number.isFinite(q[k][1]));
    }

    const weird = createEvaluator({ width: 'x', height: null, objects: [null, 3, { id: 'a' }] });
    assert.doesNotThrow(() => weird.sample(NaN));
    const rec = weird.sample(NaN);
    assert.ok(Number.isFinite(rec.t));
    assert.equal(rec.layers.length, 1, '脏元素被跳过，合法的留下');

    assert.equal(createEvaluator({ layers: 'nope' }).sample(0).layers.length, 0);
});

test('旧字段 layers 也能兜住（objectsOf 兼容）', () => {
    const A = imageOf(16, 16, 'A');
    const doc = { width: 50, height: 40, layers: [{ id: 'a', visible: true, cels: [{ at: 0, image: A }] }] };
    const ev = createEvaluator(doc);
    assert.equal(ev.imageOf('a', 0), A);
    assert.equal(ev.sample(0).layers.length, 1);
});

// ---- 绘制 ---------------------------------------------------------------

test('drawEvaluated 只画可见层，画完 alpha 复原', () => {
    const A = imageOf(100, 80, 'A');
    const doc = docOf([objectOf('a', { cels: [{ at: 0, image: A }] })]);
    const ev = createEvaluator(doc);
    const g = fakeCtx();

    assert.equal(drawEvaluated(g, ev, 1, {}), true);
    assert.ok(g.drewImage());
    near(g.globalAlpha, 1, 1e-12, 'restore 把 alpha 还原');
    assert.deepEqual(g.calls.find((c) => c[0] === 'drawImage').slice(1), [A, 0, 0]);

    const hidden = createEvaluator(docOf([objectOf('a', { visible: false, cels: [{ at: 0, image: A }] })]));
    const g2 = fakeCtx();
    assert.equal(drawEvaluated(g2, hidden, 1, {}), false);
    assert.equal(g2.drewImage(), false);

    assert.equal(drawEvaluated(null, ev, 0, {}), false);
    assert.equal(drawEvaluated(g, null, 0, {}), false);
});

// ---- 矩阵工具 -----------------------------------------------------------

test('mulMatrix / matrixTuple / transformPoint / IDENTITY_MATRIX', () => {
    const t1 = [1, 0, 0, 1, 10, 20];
    const t2 = [1, 0, 0, 1, 1, 2];
    const m = mulMatrix(t1, t2);
    near(m[4], 11, 1e-9);
    near(m[5], 22, 1e-9);

    assert.deepEqual(matrixTuple(t1), [1, 0, 0, 1, 10, 20]);
    assert.deepEqual(matrixTuple({ a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 }), t1, '对象形式同样吃');
    assert.deepEqual(transformPoint(t1, 0, 0), [10, 20]);
    assert.deepEqual(IDENTITY_MATRIX, [1, 0, 0, 1, 0, 0]);
    assert.ok(Object.isFrozen(IDENTITY_MATRIX));
});
