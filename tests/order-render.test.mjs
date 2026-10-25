// 绘制顺序 = doc.drawOrder（docs/层级与叠放-2026-10.md §4）。
//
// 这一批把「层级（parentId，跟谁动）」与「叠放（drawOrder，谁盖谁）」拆成两个事实，
// 存储顺序（doc.objects）从此只表示存储。所以所有绘制路径都必须问 drawOrderOf，
// 不能再看数组下标 —— 本文件钉的就是这件事：同一批对象，两种 drawOrder ⇒ 两种绘制序。
//
// 断言方式：假 ctx 记录 drawImage 的位图 tag，直接比较「谁先画、谁后画」。
// 末尾画的在最上面，所以绘制序 = drawOrder 的逆序。

import test from 'node:test';
import assert from 'node:assert/strict';

import { compositeFrame } from '../app/paint/composite.mjs';
import { createEvaluator, drawEvaluated } from '../app/core/evaluator.mjs';
import { createTrack, addKey } from '../app/core/transform.mjs';
import { drawOrderOf, normalizeDrawOrder } from '../app/core/draw-order.mjs';

// ---- 夹具（与 tests/evaluator.test.mjs 同源，独立一份避免互相影响）---------

/** 假位图：求值器只要 width/height，绘制时原样丢给 ctx.drawImage。 */
function imageOf(w, h, tag) {
    return { width: w, height: h, tag: tag || 'img' };
}

function trackOf() {
    let trk = createTrack();
    trk = addKey(trk, 0, { x: 0, y: 0, rotate: 0, scaleX: 1, scaleY: 1, opacity: 1 }, 'linear');
    return trk;
}

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
            transform: trackOf(),
            cels: [{ at: 0, image: null }],
        },
        patch || {},
    );
}

function docOf(objects, patch) {
    return Object.assign({ width: 100, height: 80, fps: 10, duration: 4, objects }, patch || {});
}

/** 三个对象 a/b/c，分别拿 A/B/C 三张位图（tag 就是身份）。 */
function threeObjects() {
    return [
        objectOf('a', { cels: [{ at: 0, image: imageOf(100, 80, 'A') }] }),
        objectOf('b', { cels: [{ at: 0, image: imageOf(100, 80, 'B') }] }),
        objectOf('c', { cels: [{ at: 0, image: imageOf(100, 80, 'C') }] }),
    ];
}

function fakeCtx() {
    const calls = [];
    const g = {
        calls,
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        filter: 'none',
        save() {},
        restore() {},
        setTransform() {},
        transform() {},
        clearRect() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        closePath() {},
        clip() {},
        drawImage(img) {
            calls.push(['drawImage', img]);
        },
    };
    return g;
}

/** 绘制序（位图 tag 数组）—— 末尾画的在最上。 */
function paintedTags(g) {
    return g.calls.filter((c) => c[0] === 'drawImage').map((c) => c[1].tag);
}

// ---- drawOrderOf：缺字段回退、脏值规整 ----------------------------------

test('drawOrderOf：缺 drawOrder 时按 objects 顺序现算，且不改 doc', () => {
    const doc = docOf(threeObjects());
    assert.deepEqual(drawOrderOf(doc), ['a', 'b', 'c']);
    assert.equal(doc.drawOrder, undefined, 'drawOrderOf 不得写回 doc');
});

test('drawOrderOf：有 drawOrder 时以它为准，未知 id 与重复项被丢掉', () => {
    const doc = docOf(threeObjects(), { drawOrder: ['c', 'zzz', 'a', 'c', 'b'] });
    assert.deepEqual(drawOrderOf(doc), ['c', 'a', 'b']);
});

test('normalizeDrawOrder：漏掉的对象补在末尾（集合恒等，不丢行）', () => {
    const objs = threeObjects();
    assert.deepEqual(normalizeDrawOrder(objs, ['b']), ['b', 'a', 'c']);
    assert.deepEqual(normalizeDrawOrder(objs, []), ['a', 'b', 'c']);
    assert.deepEqual(normalizeDrawOrder(objs, null), ['a', 'b', 'c']);
});

// ---- compositeFrame：两种 drawOrder ⇒ 两种绘制序 ------------------------

test('compositeFrame：drawOrder=[a,b,c] 时绘制序为 c,b,a（a 在最上，最后画）', () => {
    const g = fakeCtx();
    const doc = docOf(threeObjects(), { drawOrder: ['a', 'b', 'c'] });
    assert.equal(compositeFrame(g, doc, 0, { clear: false }), true);
    assert.deepEqual(paintedTags(g), ['C', 'B', 'A']);
});

test('compositeFrame：drawOrder=[c,a,b] 时绘制序变为 b,a,c —— 与存储顺序无关', () => {
    const g = fakeCtx();
    const doc = docOf(threeObjects(), { drawOrder: ['c', 'a', 'b'] });
    assert.equal(compositeFrame(g, doc, 0, { clear: false }), true);
    assert.deepEqual(paintedTags(g), ['B', 'A', 'C']);
});

test('compositeFrame：缺 drawOrder 时回退 objects 顺序，与旧行为逐项一致', () => {
    const g = fakeCtx();
    const doc = docOf(threeObjects());
    compositeFrame(g, doc, 0, { clear: false });
    // objects=[a,b,c] 的旧逆序就是 c,b,a
    assert.deepEqual(paintedTags(g), ['C', 'B', 'A']);
});

test('compositeFrame：drawOrder 与 objects 顺序相反时，绘制序随之翻转', () => {
    const g = fakeCtx();
    const doc = docOf(threeObjects(), { drawOrder: ['c', 'b', 'a'] });
    compositeFrame(g, doc, 0, { clear: false });
    assert.deepEqual(paintedTags(g), ['A', 'B', 'C']);
});

// ---- compositeEvaluated：同一份顺序，走求值器那条路 ---------------------

test('compositeEvaluated：drawOrder=[c,a,b] 时同样绘制 b,a,c', () => {
    const g = fakeCtx();
    const doc = docOf(threeObjects(), { drawOrder: ['c', 'a', 'b'] });
    const ev = createEvaluator(doc);
    assert.equal(drawEvaluated(g, ev, 0), true);
    assert.deepEqual(paintedTags(g), ['B', 'A', 'C']);
});

test('drawEvaluated：缺 drawOrder 时与 compositeFrame 的回退结果一致', () => {
    const doc = docOf(threeObjects());
    const g1 = fakeCtx();
    const g2 = fakeCtx();
    compositeFrame(g1, doc, 0, { clear: false });
    drawEvaluated(g2, createEvaluator(doc), 0);
    assert.deepEqual(paintedTags(g2), paintedTags(g1));
    assert.deepEqual(paintedTags(g2), ['C', 'B', 'A']);
});

// ---- 边界 ---------------------------------------------------------------

test('空文档：两条路径都返回 false，不抛', () => {
    const g = fakeCtx();
    assert.equal(compositeFrame(g, docOf([]), 0, { clear: false }), false);
    assert.equal(drawEvaluated(g, createEvaluator(docOf([])), 0), false);
    assert.deepEqual(paintedTags(g), []);
});

test('skipLayerId：被跳过的对象不出现在绘制序里，其余顺序不变', () => {
    const g = fakeCtx();
    const doc = docOf(threeObjects(), { drawOrder: ['a', 'b', 'c'] });
    compositeFrame(g, doc, 0, { clear: false, skipLayerId: 'b' });
    assert.deepEqual(paintedTags(g), ['C', 'A']);
});

test('隐藏对象：默认不画；skipHidden:false + force 时按同一顺序画出来', () => {
    const objs = threeObjects();
    objs[1].visible = false; // b 隐藏
    const doc = docOf(objs, { drawOrder: ['a', 'b', 'c'] });

    const gDefault = fakeCtx();
    compositeFrame(gDefault, doc, 0, { clear: false });
    assert.deepEqual(paintedTags(gDefault), ['C', 'A'], 'b 隐藏，剩 c,a');

    // 注意：可见性有三道判定 —— compositeFrame 的 skipHidden、drawLayer 里的
    // `!o.force && !shown`，以及 `o.onlyVisible !== false && !shown`。
    // 要真的画出隐藏层，三个开关都要松（这是既有语义，本批没动）。
    const gAll = fakeCtx();
    compositeFrame(gAll, doc, 0, { clear: false, skipHidden: false, force: true, onlyVisible: false });
    assert.deepEqual(paintedTags(gAll), ['C', 'B', 'A'], '强制全画时 b 回到自己的层位');
});

test('drawOrder 里有未知 id：忽略它，不抛，也不影响其余顺序', () => {
    const g = fakeCtx();
    const doc = docOf(threeObjects(), { drawOrder: ['b', 'ghost', 'a', 'c'] });
    compositeFrame(g, doc, 0, { clear: false });
    assert.deepEqual(paintedTags(g), ['C', 'A', 'B']);
});

test('单对象：两条路径都画一次', () => {
    const g1 = fakeCtx();
    const g2 = fakeCtx();
    const doc = docOf([objectOf('only', { cels: [{ at: 0, image: imageOf(10, 10, 'O') }] })]);
    compositeFrame(g1, doc, 0, { clear: false });
    drawEvaluated(g2, createEvaluator(doc), 0);
    assert.deepEqual(paintedTags(g1), ['O']);
    assert.deepEqual(paintedTags(g2), ['O']);
});
