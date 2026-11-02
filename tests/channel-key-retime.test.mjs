// 时间轴上拖动「通道键」只改时刻：retimeChannelKeys 是纯函数，写盘前先在这里体检。
// 覆盖：效果参数键 / 变换通道键 / 同刻整组 / 同通道冲突拒绝 / 缺键安全返回 /
// 不碰共用关键帧与别的参数 / 原 layer 不被就地修改。

import test from 'node:test';
import assert from 'node:assert/strict';

import { retimeChannelKeys } from '../app/editors/curve-geo.mjs';
import { addKey, createTrack, setChannelKey, channelOf } from '../app/core/transform.mjs';
import { createDoc, makeObject } from '../app/core/doc-model.mjs';
import { createKeys } from '../app/editors/timeline-keys.mjs';
import { pxPerSecond } from '../app/editors/timeline-geo.mjs';
import { t } from '../app/i18n/index.mjs';

/** 一条效果参数轨道：形状与 core 的通道轨道一致，值在 state.x 里。 */
function fxTrack(points) {
    return {
        keys: points.map((p) => ({
            t: p.t,
            ease: p.ease || 'linear',
            h1: p.h1 || [0.33, 0],
            h2: p.h2 || [0.67, 1],
            state: { x: p.x },
        })),
    };
}

/** 造一个带效果的图层（效果 id 用 fx-1 这种形态，和编辑器里生成的一致）。 */
function layerWithEffect(track, extra = {}) {
    return {
        id: 'layer-1',
        transform: createTrack(),
        effects: [{ id: 'fx-1', type: 'blur', amount: 0, tracks: { amount: track } }],
        ...extra,
    };
}

/* ─────────────────── 效果参数键 ─────────────────── */

test('retimeChannelKeys：效果参数键搬到新时刻，值和缓动原样保留', () => {
    const layer = layerWithEffect(fxTrack([{ t: 0, x: 0 }, { t: 1, x: 10, ease: 'hold', h1: [0.1, 0.2], h2: [0.8, 0.9] }]));
    const r = retimeChannelKeys(layer, ['fx.fx-1.amount'], 1, 2);
    assert.equal(r.blocked, false);
    assert.equal(r.moved, 1);
    const keys = r.layer.effects[0].tracks.amount.keys;
    assert.deepEqual(keys.map((k) => k.t), [0, 2]);
    assert.equal(keys[1].state.x, 10);
    assert.equal(keys[1].ease, 'hold');
    assert.deepEqual(keys[1].h1, [0.1, 0.2]);
    assert.deepEqual(keys[1].h2, [0.8, 0.9]);
    // 入参不被就地修改（一次 setDoc 才能干净地产生一条撤销记录）
    assert.equal(layer.effects[0].tracks.amount.keys[1].t, 1);
    assert.notEqual(r.layer, layer);
});

test('retimeChannelKeys：往前搬会自动重排成升序，键序不会乱', () => {
    const layer = layerWithEffect(fxTrack([{ t: 0, x: 0 }, { t: 1, x: 1 }, { t: 2, x: 2 }]));
    const r = retimeChannelKeys(layer, ['fx.fx-1.amount'], 2, 0.5);
    assert.equal(r.moved, 1);
    const keys = r.layer.effects[0].tracks.amount.keys;
    assert.deepEqual(keys.map((k) => k.t), [0, 0.5, 1]);
    assert.equal(keys[1].state.x, 2);
});

test('retimeChannelKeys：同一刻的多条效果参数整组搬，只动时刻', () => {
    const layer = layerWithEffect(fxTrack([{ t: 1, x: 4 }]));
    layer.effects[0].tracks.radius = fxTrack([{ t: 1, x: 8 }]);
    const r = retimeChannelKeys(layer, ['fx.fx-1.amount', 'fx.fx-1.radius'], 1, 2);
    assert.equal(r.moved, 2);
    assert.equal(r.blocked, false);
    assert.deepEqual(r.fields, ['fx.fx-1.amount', 'fx.fx-1.radius']);
    assert.equal(r.layer.effects[0].tracks.amount.keys[0].state.x, 4);
    assert.equal(r.layer.effects[0].tracks.radius.keys[0].state.x, 8);
    assert.equal(r.layer.effects[0].tracks.amount.keys[0].t, 2);
});

test('retimeChannelKeys：效果键搬走不碰同效果的其他参数轨', () => {
    const layer = layerWithEffect(fxTrack([{ t: 0, x: 0 }, { t: 1, x: 10 }]));
    layer.effects[0].tracks.radius = fxTrack([{ t: 1, x: 3 }]);
    const r = retimeChannelKeys(layer, ['fx.fx-1.amount'], 1, 3);
    assert.equal(r.layer.effects[0].tracks.radius.keys[0].t, 1);
    assert.equal(r.layer.effects[0].tracks.amount.keys[1].t, 3);
});

/* ─────────────────── 变换通道键 ─────────────────── */

test('retimeChannelKeys：变换通道键搬时刻，值保留；共用键不动', () => {
    let track = createTrack();
    track = addKey(track, 0, { x: 0, y: 0 }, 'linear');
    track = setChannelKey(track, 'rotate', 1, 30);
    const layer = { id: 'layer-1', transform: track };
    const r = retimeChannelKeys(layer, ['rotate'], 1, 2);
    assert.equal(r.moved, 1);
    const ch = channelOf(r.layer.transform, 'rotate');
    assert.deepEqual(ch.keys.map((k) => k.t), [2]);
    assert.equal(ch.keys[0].value, 30);
    // 共用关键帧一根没少、时刻没动
    assert.deepEqual(r.layer.transform.keys.map((k) => k.t), [0]);
    assert.equal(layer.transform.keys[0].t, 0);
});

test('retimeChannelKeys：变换通道与效果通道可以同刻整组搬', () => {
    let track = setChannelKey(createTrack(), 'rotate', 1, 30);
    track = setChannelKey(track, 'scaleX', 1, 2);
    const layer = layerWithEffect(fxTrack([{ t: 1, x: 5 }]), { transform: track });
    const r = retimeChannelKeys(layer, ['rotate', 'scaleX', 'fx.fx-1.amount'], 1, 1.5);
    assert.equal(r.moved, 3);
    assert.equal(r.blocked, false);
    assert.deepEqual(channelOf(r.layer.transform, 'rotate').keys.map((k) => k.t), [1.5]);
    assert.deepEqual(channelOf(r.layer.transform, 'scaleX').keys.map((k) => k.t), [1.5]);
    assert.equal(r.layer.effects[0].tracks.amount.keys[0].t, 1.5);
});

/* ─────────────────── 冲突：整组拒绝 ─────────────────── */

test('retimeChannelKeys：同通道目标时刻已有键 → 整组 blocked 且不改任何东西', () => {
    let track = setChannelKey(createTrack(), 'rotate', 1, 30);
    track = setChannelKey(track, 'rotate', 2, 60);
    track = setChannelKey(track, 'scaleX', 1, 2);
    const layer = { id: 'layer-1', transform: track, effects: [{ id: 'fx-1', type: 'blur', tracks: { amount: fxTrack([{ t: 1, x: 5 }]) } }] };
    const r = retimeChannelKeys(layer, ['rotate', 'scaleX', 'fx.fx-1.amount'], 1, 2);
    assert.equal(r.blocked, true);
    assert.equal(r.moved, 0);
    assert.equal(r.layer, layer);
    assert.deepEqual(channelOf(layer.transform, 'rotate').keys.map((k) => k.t), [1, 2]);
    assert.equal(layer.transform.channels.scaleX.keys[0].t, 1);
});

test('retimeChannelKeys：目标时刻有键的是「另一条」通道时不冲突', () => {
    let track = setChannelKey(createTrack(), 'rotate', 1, 30);
    track = setChannelKey(track, 'rotate', 2, 60);
    const layer = { id: 'layer-1', transform: track };
    // rotate 1→2 会撞自己，拒绝；rotate 2→0 目标空旷，放行
    assert.equal(retimeChannelKeys(layer, ['rotate'], 1, 2).blocked, true);
    const ok = retimeChannelKeys(layer, ['rotate'], 2, 0);
    assert.equal(ok.blocked, false);
    assert.deepEqual(channelOf(ok.layer.transform, 'rotate').keys.map((k) => k.t), [0, 1]);
});

test('retimeChannelKeys：想搬到已有共用键的时刻允许（通道键本来就覆盖共用键）', () => {
    let track = addKey(createTrack(), 2, { x: 0, rotate: 0 }, 'linear');
    track = setChannelKey(track, 'rotate', 1, 30);
    const r = retimeChannelKeys({ id: 'layer-1', transform: track }, ['rotate'], 1, 2);
    assert.equal(r.blocked, false);
    assert.equal(r.moved, 1);
    assert.equal(channelOf(r.layer.transform, 'rotate').keys[0].t, 2);
});

/* ─────────────────── 无效输入：安全返回 ─────────────────── */

test('retimeChannelKeys：缺键的通道跳过，其余照搬', () => {
    let track = setChannelKey(createTrack(), 'rotate', 1, 30);
    const layer = { id: 'layer-1', transform: track };
    const r = retimeChannelKeys(layer, ['rotate', 'scaleX'], 1, 2);
    assert.equal(r.moved, 1);
    assert.deepEqual(r.fields, ['rotate']);
});

test('retimeChannelKeys：完全没有可搬的键 → 原样返回同一个 layer', () => {
    let track = setChannelKey(createTrack(), 'rotate', 1, 30);
    const layer = { id: 'layer-1', transform: track };
    const r = retimeChannelKeys(layer, ['rotate'], 5, 7);
    assert.equal(r.moved, 0);
    assert.equal(r.blocked, false);
    assert.equal(r.layer, layer);
});

test('retimeChannelKeys：坏参数一律安全返回（不抛、不改）', () => {
    const track = setChannelKey(createTrack(), 'rotate', 1, 30);
    const layer = { id: 'layer-1', transform: track };
    for (const args of [
        [null, ['rotate'], 1, 2],
        [layer, null, 1, 2],
        [layer, [], 1, 2],
        [layer, ['rotate'], NaN, 2],
        [layer, ['rotate'], 1, Infinity],
        [layer, ['rotate'], 1, 1],
    ]) {
        const r = retimeChannelKeys(...args);
        assert.equal(r.moved, 0, JSON.stringify(args));
        assert.equal(r.blocked, false, JSON.stringify(args));
    }
});

test('retimeChannelKeys：未知/坏形状的通道 id 不制造假键', () => {
    const layer = { id: 'layer-1', transform: createTrack() };
    for (const id of ['nope', 'fx.', 'fx.a', 'fx..x', '']) {
        const r = retimeChannelKeys(layer, [id], 1, 2);
        assert.equal(r.moved, 0, id);
        assert.equal(r.layer, layer, id);
    }
});

/* ─────────────────── 真代码路径：createKeys 的通道键拖动 ───────────────────
   纯函数只证明「怎么搬」是对的，「按下 → 拖 → 松手」这条手势链还得跑真代码。
   这里用最小 document / window 桩，直接调用导出的 createKeys()，不需要画布。 */

function chNode(at, layerId, fields) {
    const cls = new Set(['tline-kf', 'is-ch']);
    return {
        dataset: { t: String(at), layer: layerId, ch: fields },
        title: 'channel-key',
        style: { left: '10px' },
        classList: {
            contains: (n) => cls.has(n),
            add: (n) => cls.add(n),
            remove: (n) => cls.delete(n),
            toggle: (n, force) => {
                if (force === undefined ? !cls.has(n) : force) cls.add(n);
                else cls.delete(n);
            },
        },
    };
}

/** 装一套最小 DOM：document 只要事件登记表 + dispatchEvent，window 只要 localStorage。 */
function installDom() {
    const listeners = new Map();
    const dispatched = [];
    const documentStub = {
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        },
        removeEventListener(type, fn) {
            listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn));
        },
        dispatchEvent(ev) {
            dispatched.push(ev);
            return true;
        },
    };
    const prevDoc = globalThis.document;
    const prevWin = globalThis.window;
    globalThis.document = documentStub;
    globalThis.window = { localStorage: { getItem() { throw new Error('no storage'); } } };
    return {
        dispatched,
        fire(type, ev) {
            for (const fn of [...(listeners.get(type) || [])]) fn(ev);
        },
        restore() {
            globalThis.document = prevDoc;
            globalThis.window = prevWin;
        },
    };
}

/** 造「一个对象 + 一条效果参数轨」的文档，并返回拖动用的 deps。 */
function dragFixture(trackKeys) {
    const doc0 = createDoc({ fps: 12, duration: 3 });
    const obj = makeObject({
        id: doc0.objects[0].id,
        transform: addKey(createTrack(), 0, { x: 0 }, 'linear'),
        effects: [{ id: 'fx-1', type: 'blur', tracks: { amount: { keys: trackKeys } } }],
    });
    doc0.objects[0] = obj;
    const state = { doc: doc0, writes: 0 };
    const notes = [];
    const keys = createKeys({
        notify: (m) => notes.push(m),
        has: (n) => n === 'setDoc',
        call: (name, args) => {
            if (name !== 'setDoc') return;
            state.writes += 1;
            state.doc = args[0](state.doc) || state.doc;
        },
        notWired: () => {},
        docNow: () => state.doc,
        timeNow: () => 0.5,
        setActive: () => {},
        keepTime: () => {},
        paint: () => {},
        zoomOf: () => 1,
        menu: { close() {} },
        rowsEl: () => null,
    });
    return { state, notes, keys, obj };
}

function fxKey(at, x) {
    return { t: at, ease: 'linear', h1: [0.33, 0], h2: [0.67, 1], state: { x } };
}

function downEvent(x) {
    return { button: 0, clientX: x, shiftKey: false, preventDefault() {}, stopPropagation() {} };
}

test('createKeys：拖动通道键只写一次文档，落点吸附整帧并给出读数', () => {
    const dom = installDom();
    try {
        const { state, notes, keys, obj } = dragFixture([fxKey(1, 5)]);
        const node = chNode(1, obj.id, 'fx.fx-1.amount');
        keys.kfDown(downEvent(100), node);
        assert.ok(node.classList.contains('is-drag'), '按下后进入拖动态');

        const pps = pxPerSecond(state.doc, 1);
        dom.fire('pointermove', { clientX: 100 + pps, shiftKey: false });
        assert.equal(node.title, t('timeline.drag.chTitle', { t: '2.00' }));
        assert.notEqual(node.style.left, '10px', '拖动中挪了 DOM 左偏移');
        assert.equal(state.writes, 0, 'pointermove 不许写文档');

        dom.fire('pointerup', {});
        assert.equal(state.writes, 1, '整次拖动 = 一次 setDoc');
        const moved = state.doc.objects[0].effects[0].tracks.amount.keys;
        assert.deepEqual(moved.map((k) => k.t), [2]);
        assert.equal(moved[0].state.x, 5);
        assert.equal(notes.at(-1), t('timeline.drag.chMoved', { t: '2.00', n: 1 }));
        assert.ok(!node.classList.contains('is-drag'));
    } finally {
        dom.restore();
    }
});

test('createKeys：没拖动的松手 = 点击，派 ms:channel-key-click 且不写文档', () => {
    const dom = installDom();
    try {
        const { state, keys, obj } = dragFixture([fxKey(1, 5)]);
        const node = chNode(1, obj.id, 'fx.fx-1.amount');
        keys.kfDown(downEvent(100), node);
        dom.fire('pointerup', {});
        assert.equal(state.writes, 0);
        assert.equal(dom.dispatched.length, 1);
        assert.equal(dom.dispatched[0].type, 'ms:channel-key-click');
        assert.deepEqual(
            { ...dom.dispatched[0].detail },
            { layerId: obj.id, t: 1, ch: 'fx.fx-1.amount', count: 1 },
        );
    } finally {
        dom.restore();
    }
});

test('createKeys：Esc 取消拖动 → 回滚 DOM、不写文档、提示已取消', () => {
    const dom = installDom();
    try {
        const { state, notes, keys, obj } = dragFixture([fxKey(1, 5)]);
        const node = chNode(1, obj.id, 'fx.fx-1.amount');
        keys.kfDown(downEvent(100), node);
        const pps = pxPerSecond(state.doc, 1);
        dom.fire('pointermove', { clientX: 100 + pps, shiftKey: false });
        dom.fire('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} });
        assert.equal(state.writes, 0);
        assert.equal(node.style.left, '10px', '左偏移回到按下时的快照');
        assert.equal(node.title, 'channel-key');
        assert.equal(notes.at(-1), t('timeline.drag.cancelled'));
        assert.equal(node.classList.contains('is-drag'), false);
    } finally {
        dom.restore();
    }
});

test('createKeys：目标时刻已有同通道键 → 提示 blocked，不写文档', () => {
    const dom = installDom();
    try {
        const { state, notes, keys, obj } = dragFixture([fxKey(1, 5), fxKey(2, 7)]);
        const node = chNode(1, obj.id, 'fx.fx-1.amount');
        keys.kfDown(downEvent(100), node);
        const pps = pxPerSecond(state.doc, 1);
        dom.fire('pointermove', { clientX: 100 + pps, shiftKey: false });
        dom.fire('pointerup', {});
        assert.equal(state.writes, 0, '被拒绝的拖动不该产生空撤销');
        assert.equal(notes.at(-1), t('timeline.drag.chBlocked', { t: '2.00' }));
        assert.deepEqual(state.doc.objects[0].effects[0].tracks.amount.keys.map((k) => k.t), [1, 2]);
    } finally {
        dom.restore();
    }
});


