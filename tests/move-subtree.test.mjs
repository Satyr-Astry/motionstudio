/**
 * 整棵子树搬家：换父 + 重排，一次产出新文档（对象面板三区拖拽的写入口）。
 *
 * 钉三件事：
 * ① 四个 mode 的数组结果（父在子前、子树连续）；
 * ② `into` / `rootEnd` 换父时世界坐标守恒（父旋转、父缩放两组）；
 * ③ 一次调用只产生一次写入 —— 用 mock 的 setDoc 计数，防止有人拼成两次。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { moveSubtreeDoc } from '../app/core/timegraph.mjs';
import { timeCtx } from '../app/shell/ctx-time.mjs';
import { objectById, objectsOf } from '../app/core/doc-model.mjs';
import { elementSize, elementWorldMatrix, applyMatrix, reparentOffset } from '../app/core/element.mjs';

/** 生产里由外壳注入：按当下这一刻算换父位移。 */
const keepPlace = (doc, t = 0) => (el, pid) => reparentOffset(doc, el, pid, t);

function obj(id, parentId, x = 0, y = 0, extra = {}) {
    return {
        id,
        parentId,
        kind: 'paint',
        anchor: { x: 0, y: 0 },
        transform: {
            keys: [{
                t: 0,
                state: {
                    x, y, scaleX: 1, scaleY: 1, rotate: 0, skewX: 0, skewY: 0, opacity: 1,
                },
            }],
        },
        drawings: [],
        cels: [],
        ...extra,
    };
}

function baseDoc() {
    return {
        width: 400,
        height: 300,
        fps: 10,
        duration: 2,
        objects: [
            obj('p', null, 0, 0),
            obj('c', 'p', 40, 30),
            obj('g', 'c', 5, 5),
            obj('q', null, 120, 0),
            obj('z', null, 200, 100),
        ],
    };
}

function ids(doc) {
    return objectsOf(doc).map((o) => o.id);
}

function worldOf(doc, id, t = 0) {
    const el = objectById(doc, id);
    if (!el) return null;
    const size = elementSize(doc, el, t);
    const parentM = el.parentId == null ? null : worldOf(doc, el.parentId, t);
    return elementWorldMatrix(el, t, size, parentM);
}

/** 只比原点（锚点默认就在原点）：契约保的是位置，不是姿态。 */
function originOf(doc, id, t = 0) {
    return applyMatrix(worldOf(doc, id, t), { x: 0, y: 0 });
}

function near(a, b, msg, eps = 1e-9) {
    assert.ok(
        Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps,
        `${msg}（实际 ${JSON.stringify(a)} / 期望 ${JSON.stringify(b)}）`,
    );
}

/** 「父在子前」+ 子树连续：同一棵子树的 id 在数组里必须挨在一起。 */
function assertParentBeforeChild(doc) {
    const list = objectsOf(doc);
    const at = new Map(list.map((o, i) => [o.id, i]));
    for (const o of list) {
        if (o.parentId == null) continue;
        assert.ok(at.has(o.parentId), `${o.id} 的父 ${o.parentId} 不在数组里`);
        assert.ok(at.get(o.parentId) < at.get(o.id), `${o.id} 必须排在父 ${o.parentId} 之后`);
    }
}

test('before：整棵子树搬到目标之前，且父在子前', () => {
    const doc = baseDoc();
    const r = moveSubtreeDoc(doc, 'p', 'before', 'q');
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(ids(r.doc), ['p', 'c', 'g', 'q', 'z']);
    assert.equal(objectById(r.doc, 'c').parentId, 'p', '子对象仍跟着父');
    assert.equal(objectById(r.doc, 'p').parentId, null, 'before 不改变父级');
    assertParentBeforeChild(r.doc);
});

test('after：插在目标之后', () => {
    const doc = baseDoc();
    const r = moveSubtreeDoc(doc, 'p', 'after', 'q');
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(ids(r.doc), ['q', 'p', 'c', 'g', 'z']);
    assertParentBeforeChild(r.doc);
});

test('after 目标自己带子树时，插在它整棵子树之后（不插进父子中间）', () => {
    const doc = baseDoc();
    const r = moveSubtreeDoc(doc, 'z', 'after', 'p');
    assert.equal(r.ok, true, r.reason);
    // p 的子树是 p,c,g —— z 要落在 g 后面，而不是 p 与 c 之间
    assert.deepEqual(ids(r.doc), ['p', 'c', 'g', 'z', 'q']);
    assertParentBeforeChild(r.doc);
});

test('into：成为目标的子对象，世界坐标守恒（父旋转 30°）', () => {
    const doc = baseDoc();
    const p = objectById(doc, 'p');
    p.transform.keys[0].state = { ...p.transform.keys[0].state, rotate: 30, x: 30, y: 12 };
    const before = originOf(doc, 'z');
    const r = moveSubtreeDoc(doc, 'z', 'into', 'p', keepPlace(doc));
    assert.equal(r.ok, true, r.reason);
    assert.equal(objectById(r.doc, 'z').parentId, 'p');
    near(originOf(r.doc, 'z'), before, 'into 之后世界坐标必须不变');
    assertParentBeforeChild(r.doc);
});

test('into：父缩放 0.5 时也守恒', () => {
    const doc = baseDoc();
    const p = objectById(doc, 'p');
    p.transform.keys[0].state = { ...p.transform.keys[0].state, scaleX: 0.5, scaleY: 0.5, x: 60, y: 40 };
    const before = originOf(doc, 'z');
    const r = moveSubtreeDoc(doc, 'z', 'into', 'p', keepPlace(doc));
    assert.equal(r.ok, true, r.reason);
    near(originOf(r.doc, 'z'), before, '父缩放 0.5 时世界坐标必须不变');
});

test('rootEnd：脱离父级、落到根层末尾，世界坐标守恒', () => {
    const doc = baseDoc();
    const before = originOf(doc, 'c');
    const r = moveSubtreeDoc(doc, 'c', 'rootEnd', null, keepPlace(doc));
    assert.equal(r.ok, true, r.reason);
    assert.equal(objectById(r.doc, 'c').parentId, null);
    assert.deepEqual(ids(r.doc), ['p', 'q', 'z', 'c', 'g'], '子树连续地落到末尾');
    near(originOf(r.doc, 'c'), before, 'rootEnd 之后世界坐标必须不变');
    assertParentBeforeChild(r.doc);
});

test('非法目标一律 false，且文档原样不动', () => {
    const doc = baseDoc();
    const snapshot = JSON.stringify(doc);
    const cases = [
        ['into', 'c', '自己的子对象里'],
        ['into', 'p', '它自己身上'],
        ['before', 'nope', '目标对象不存在'],
        ['after', null, '没有指定目标对象'],
        ['sideways', 'q', '移动方式不合法'],
    ];
    for (const [mode, targetId, want] of cases) {
        const r = moveSubtreeDoc(doc, 'p', mode, targetId);
        assert.equal(r.ok, false, `${mode}/${targetId} 应当被拒绝`);
        assert.ok(String(r.reason).includes(want), `${mode}/${targetId} 的原因文案：${r.reason}`);
        assert.equal(JSON.stringify(doc), snapshot, '被拒绝时不允许改原文档');
    }
});

test('不存在的对象也拒绝', () => {
    const doc = baseDoc();
    const r = moveSubtreeDoc(doc, 'ghost', 'rootEnd', null);
    assert.equal(r.ok, false);
    assert.match(r.reason, /找不到/);
});

test('ctx.moveSubtree：一次调用只写一次文档（一条撤销）', () => {
    let doc = baseDoc();
    let writes = 0;
    let lastLabel = '';
    const ctx = timeCtx({
        getDoc: () => doc,
        setDoc: (updater, opts) => {
            writes += 1;
            lastLabel = (opts && opts.label) || '';
            doc = typeof updater === 'function' ? updater(doc) : updater;
        },
        flash: () => {},
        now: () => 0,
        activeId: () => null,
        evaluatorFor: () => null,
        writeKeyAt: () => {},
    });
    assert.equal(typeof ctx.moveSubtree, 'function', '外壳要能探测到这个入口');
    const before = originOf(doc, 'z');
    assert.equal(ctx.moveSubtree('z', { mode: 'into', targetId: 'p' }), true);
    assert.equal(writes, 1, '换父 + 重排必须在同一次 setDoc 里落地');
    assert.equal(lastLabel, '移动对象');
    assert.equal(objectById(doc, 'z').parentId, 'p');
    near(originOf(doc, 'z'), before, '经 ctx 调用也要守恒');
    assertParentBeforeChild(doc);
});

test('ctx.moveSubtree：失败返回 false、不写文档、给出中文原因', () => {
    let doc = baseDoc();
    let writes = 0;
    const hints = [];
    const ctx = timeCtx({
        getDoc: () => doc,
        setDoc: () => { writes += 1; },
        flash: (m) => { hints.push(String(m)); },
        now: () => 0,
        activeId: () => null,
        evaluatorFor: () => null,
        writeKeyAt: () => {},
    });
    assert.equal(ctx.moveSubtree('p', { mode: 'into', targetId: 'c' }), false);
    assert.equal(writes, 0);
    assert.equal(hints.length, 1);
    assert.match(hints[0], /子对象|不能/);
});
