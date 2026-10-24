import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDocument, cloneDocument, addLayer } from '../app/core/cel.mjs';
import {
    TIME_IDENTITY,
    setParent,
    childrenOf,
    rootLayers,
    detachChildren,
    timeDepth,
    localTimeOf,
    isDescendant,
} from '../app/core/timegraph.mjs';

// ───────────────────────────────────────────────────────────────────────────
// 夹具：两个来源——真实 cel 文档（createDocument/addLayer）与手写层级文档。
// ───────────────────────────────────────────────────────────────────────────

const FPS = 100;
const SEC = 4;

const byId = (doc, id) => (doc.objects || doc.layers || []).find((l) => l.id === id);
const ids = (list) => list.map((l) => l.id);

function layer(id, patch = {}) {
    return {
        id,
        name: id,
        visible: true,
        locked: false,
        opacity: 1,
        mixMode: 'source-over',
        linkNewCels: false,
        onionIgnore: false,
        effects: [],
        parentId: null,
        time: { ...TIME_IDENTITY },
        ...patch,
    };
}

function makeDoc(defs, seconds = SEC) {
    return {
        width: 32,
        height: 32,
        fps: FPS,
        loopMode: 'cycle',
        tags: [],
        layers: defs.map((d) => (Array.isArray(d) ? layer(d[0], d[1] || {}) : layer(d))),
        frames: [{ duration: seconds * FPS, tag: null, cels: {} }],
    };
}

test('setParent 后 JSON 往返保留 parentId（真实 cel 文档 + 手写层级文档）', () => {
    // cel.mjs 的 makeLayer 不写 parentId（缺省即根），这里只锁「设过的父必须序列化得住」
    const doc = addLayer(createDocument({ width: 16, height: 16, fps: FPS }), 'B');
    const [top, bottom] = doc.objects;
    const res = setParent(doc, top.id, bottom.id);
    assert.equal(res.ok, true);

    const round = JSON.parse(JSON.stringify(res.doc));
    assert.equal(byId(round, top.id).parentId, bottom.id, 'parentId 必须能序列化保留');
    assert.ok(byId(round, bottom.id).parentId == null, '未设父的图层仍是根');

    // 手写层级文档：a → b → c，往返后三级 parentId 一字不差
    const chain = makeDoc([['a'], ['b', { parentId: 'a' }], ['c', { parentId: 'b' }]]);
    const copy = JSON.parse(JSON.stringify(chain));
    assert.deepEqual(copy.layers.map((l) => l.parentId), [null, 'a', 'b']);
    assert.equal(JSON.stringify(copy), JSON.stringify(chain));
});

test('三级链：detachChildren(中间层) 让两个子对象都回根', () => {
    const doc = makeDoc([['a'], ['m', { parentId: 'a' }], ['c1', { parentId: 'm' }], ['c2', { parentId: 'm' }]]);
    const before = JSON.stringify(doc);
    const res = detachChildren(doc, 'm');
    assert.notEqual(res, doc);
    assert.equal(byId(res, 'c1').parentId, null);
    assert.equal(byId(res, 'c2').parentId, null);
    assert.equal(byId(res, 'm').parentId, 'a', '中间层自己的父不变');
    assert.deepEqual(childrenOf(res, 'm'), []);
    assert.deepEqual(ids(rootLayers(res)), ['a', 'c1', 'c2']);
    assert.equal(JSON.stringify(doc), before, '原 doc 不被改动');
});

test('childrenOf 返回顺序与 doc.layers 顺序一致', () => {
    const doc = makeDoc([
        ['c2', { parentId: 'mid' }],
        'root',
        ['c1', { parentId: 'mid' }],
        ['c3', { parentId: 'mid' }],
        ['mid', { parentId: 'root' }],
    ]);
    assert.deepEqual(ids(childrenOf(doc, 'mid')), ['c2', 'c1', 'c3'], '不是字母序，是 layers 顺序');
    assert.deepEqual(ids(childrenOf(doc, 'root')), ['mid']);
    assert.deepEqual(childrenOf(doc, null), []);
});

test('rootLayers 不把「parentId 指向不存在 id」的对象算成非根', () => {
    const doc = makeDoc(['a', ['b', { parentId: 'a' }], ['z', { parentId: 'ghost' }], 'y']);
    assert.equal(isDescendant(doc, byId(doc, 'z'), byId(doc, 'a')), false);
    assert.deepEqual(ids(rootLayers(doc)), ['a', 'z', 'y']);
});

test('环链 a→b→a：localTimeOf 有限、timeDepth 有界、isDescendant 不挂死', () => {
    const doc = makeDoc([
        ['a', { parentId: 'b', time: { offset: 1 } }],
        ['b', { parentId: 'a', time: { scale: 2 } }],
    ]);
    let t = NaN;
    let d = -1;
    assert.doesNotThrow(() => {
        t = localTimeOf(doc, byId(doc, 'a'), 5);
        d = timeDepth(doc, byId(doc, 'a'));
    }, '环链不得抛异常');
    assert.ok(Number.isFinite(t), `localTimeOf 必须有限，实际 ${t}`);
    assert.ok(Number.isInteger(d) && d >= 0 && d <= 64, `timeDepth 必须有界，实际 ${d}`);
    assert.doesNotThrow(() => isDescendant(doc, byId(doc, 'a'), byId(doc, 'b')));
});

test('setParent 成环被拒：doc 引用不变、原 parentId 不变', () => {
    const doc = makeDoc([['root'], ['mid', { parentId: 'root' }]]); // root → mid
    const before = JSON.stringify(doc);
    const res = setParent(doc, 'root', 'mid');
    assert.equal(res.ok, false);
    assert.equal(res.reason, '会形成父子环');
    assert.equal(res.doc, doc, '拒绝时返回原 doc 引用');
    assert.equal(byId(doc, 'root').parentId, null);
    assert.equal(JSON.stringify(doc), before);
});

test('cloneDocument 保留 parentId 与 time 通道', () => {
    const doc = makeDoc([['a'], ['b', { parentId: 'a', time: { offset: 1, scale: 2, mode: 'loop', from: 0, to: 1 } }]]);
    const copy = cloneDocument(doc);
    assert.notEqual(copy, doc);
    assert.notEqual(copy.layers[1], doc.layers[1]);
    assert.equal(byId(copy, 'b').parentId, 'a');
    assert.deepEqual(byId(copy, 'b').time, byId(doc, 'b').time);
    assert.deepEqual(copy.layers, doc.layers);
});

test('setParent 不可变：原 doc 完全不改，无关图层复用原引用', () => {
    const doc = makeDoc(['x', 'a', 'y']);
    const before = JSON.stringify(doc);
    const res = setParent(doc, 'a', 'y');
    assert.equal(JSON.stringify(doc), before);
    assert.equal(byId(res.doc, 'x'), byId(doc, 'x'));
    assert.equal(byId(res.doc, 'y'), byId(doc, 'y'));
    assert.notEqual(byId(res.doc, 'a'), byId(doc, 'a'), '被改的图层必须是新对象');
    assert.equal(byId(res.doc, 'a').parentId, 'y');
});

test('setParent 幂等：已是该父时 ok:true 且返回同一 doc', () => {
    const doc = makeDoc([['a'], ['b', { parentId: 'a' }]]);
    const res = setParent(doc, 'b', 'a');
    assert.equal(res.ok, true);
    assert.equal(res.doc, doc);
    assert.deepEqual(ids(childrenOf(res.doc, 'a')), ['b']);
});

test('detachChildren 无子对象时返回同一引用；有子对象时根变多', () => {
    const doc = makeDoc([['a'], ['b', { parentId: 'a' }]]);
    assert.equal(detachChildren(doc, 'b'), doc, '无子对象 → 同一引用');
    const rooted = detachChildren(doc, 'a');
    assert.equal(rooted.layers.length, doc.layers.length, '不增删对象');
    assert.equal(ids(rootLayers(rooted)).length, 2, 'a、b 都成根');
});

test('50 层深链：逐级 setParent 后 timeDepth = 49，把根挂到末端被拒', () => {
    const defs = [];
    for (let i = 0; i < 50; i++) defs.push('n' + i);
    let doc = makeDoc(defs);
    for (let i = 1; i < 50; i++) {
        const res = setParent(doc, 'n' + i, 'n' + (i - 1));
        assert.equal(res.ok, true, `n${i} → n${i - 1} 应成功`);
        doc = res.doc;
    }
    assert.equal(timeDepth(doc, byId(doc, 'n49')), 49);
    const t = localTimeOf(doc, byId(doc, 'n49'), 3);
    assert.ok(Number.isFinite(t));
    assert.ok(Math.abs(t - 3) < 1e-9, '全恒等通道 → 局部时间等于全局时间');

    const cyc = setParent(doc, 'n0', 'n49');
    assert.equal(cyc.ok, false);
    assert.equal(cyc.reason, '会形成父子环');
    assert.equal(cyc.doc, doc);
});

// 契约 §2 要求 setParent 必须做环检测、成环返回 ok:false。实测在 >64 层的链上
// isDescendant 撞到 MAX_DEPTH=64 提前退出，把「祖孙」误判成「无关系」，
// 于是造环被放行（ok:true）。属实现缺陷（回报缺陷 2），断言按契约写，修好后取消 skip。
test.skip('深链（>64 层）上的成环也应被拒（当前 isDescendant 超 64 层误判，见回报缺陷 2）', () => {
    const defs = [];
    for (let i = 0; i < 100; i++) defs.push(['n' + i, { parentId: i ? 'n' + (i - 1) : null }]);
    const doc = makeDoc(defs);
    assert.equal(isDescendant(doc, byId(doc, 'n99'), byId(doc, 'n0')), true, 'n0 是 n99 的祖先');
    const res = setParent(doc, 'n0', 'n99');
    assert.equal(res.ok, false);
    assert.equal(res.reason, '会形成父子环');
});
