/**
 * 效果（`layer.effects`）存档往返单测。
 *
 * 背景：效果对象一直是「渲染有、存档无」的孤儿 —— `elementToJSON` / `elementShell` 两个白名单
 * 都没有 `effects`，`docToJSON` 出来的节点里根本没有这个字段，读回经 `makeObject` 恒为 `[]`。
 * 用户加好的五种效果（静态参数 + 参数级关键帧）一存一取全消失，而且界面上没有任何提示。
 *
 * 这里锁住三件事：
 * 1. 往返保真：type / 每个参数 / 每条轨道的 `t`、`ease`、`h1`、`h2`、`state.x` 都不丢，
 *    并且渲染期求值（filter 串）与存档前完全一致；
 * 2. 向后兼容：没有 effects 字段的老档读成 `[]`，落盘也不会凭空长出字段；
 * 3. 脏数据 fail-soft：非数组、未知 type、缺参数、坏轨道都只降级，绝不抛异常。
 *
 * 纯数据测试：不碰位图 / 画布，所以不需要 `__setCodec` 替身。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as store from '../app/shell/project-store.mjs';
import { defaultEffect, effectAt, filterStringAt, hasTracks } from '../app/paint/effects.mjs';
import { createDoc, makeObject, objectsOf } from '../app/core/doc-model.mjs';
import { addKey, createTrack } from '../app/core/transform.mjs';

/** 文件可能是扁平节点，也可能包着 `{doc}` 信封（两种都吃过），统一取节点。 */
const nodeOf = (file) => (file && file.doc ? file.doc : file);

/** 五种效果全用上：静态参数、带 alpha 的颜色、两条参数轨道（bezier + hold）。 */
function effectsFixture() {
    // 真实写路径用的就是 createTrack + addKey（commands.mjs 里的效果关键帧同理），
    // 所以关键帧的 state 会带 normState 补出来的整份变换字段 —— 存档只留 state.x。
    let track = addKey(createTrack(), 0, { x: 0 }, 'bezier');
    track = addKey(track, 2, { x: 12 }, 'hold');
    return [
        { type: 'blur', amount: 0.5 },
        { type: 'glow', amount: 8, color: '#4a7dff' },
        { type: 'shadow', dx: 4, dy: -2, amount: 6, color: 'rgba(0,0,0,0.45)' },
        { type: 'adjust', brightness: 1.4, contrast: 0.8, saturate: 2, hue: -45 },
        { type: 'outline', id: 'fx-outline', amount: 2, color: '#000000', tracks: { amount: track } },
    ];
}

function docWithEffects(effects) {
    return createDoc({ width: 8, height: 8, fps: 10, objects: [makeObject({ id: 'obj-1', name: '对象 1', effects: effects })] });
}

/** 手写一份 v4 老节点（只有 cels、没有 effects 字段），用来验向后兼容与脏数据。 */
function v4Node(extra) {
    return Object.assign({
        format: store.FORMAT,
        version: 4,
        name: '老档',
        savedAt: 1,
        width: 8,
        height: 8,
        fps: 10,
        duration: 1,
        drawOrder: ['obj-1'],
        assets: {},
        elements: [{
            id: 'obj-1',
            name: '对象 1',
            visible: true,
            locked: false,
            opacity: 1,
            mixMode: 'source-over',
            kind: 'paint',
            anchor: { x: 0.5, y: 0.5 },
            transform: { keys: [{ t: 0, ease: 'linear' }] },
            cels: [{ at: 0, image: null }],
        }],
        tags: [],
    }, extra || {});
}

/** 用一段 effects 原文当存档里的 effects 字段 */
function nodeWithEffects(effects) {
    const node = v4Node();
    node.elements[0].effects = effects;
    return node;
}

/* ─────────────────────────── 往返保真 ─────────────────────────── */

test('往返保真：五种效果（静态参数 + rgba 颜色 + 参数轨道）落盘后再读回不丢字段', async () => {
    const effects = effectsFixture();
    const doc = docWithEffects(effects);
    const el = nodeOf(store.docToFile(doc, { name: '效果', savedAt: 1 })).elements[0];

    // ① 静态效果：参数扁平落盘（与运行期对象同构），顺序即渲染顺序
    assert.deepEqual(el.effects.map((e) => e.type), ['blur', 'glow', 'shadow', 'adjust', 'outline']);
    assert.deepEqual(el.effects[0], { type: 'blur', amount: 0.5 });
    assert.deepEqual(el.effects[1], { type: 'glow', amount: 8, color: '#4a7dff' });
    // ② 带 alpha 的颜色原样保留（不按 #rrggbb 校验）
    assert.equal(el.effects[2].color, 'rgba(0,0,0,0.45)');
    assert.deepEqual(el.effects[3], { type: 'adjust', brightness: 1.4, contrast: 0.8, saturate: 2, hue: -45 });
    // ③ 参数轨道：每颗关键帧的 t / state.x / ease / 切线柄
    assert.equal(el.effects[4].id, 'fx-outline', 'id 存在就原样保留（非序号的 id 也留着）');
    assert.deepEqual(el.effects[4].tracks.amount.keys, [
        { t: 0, state: { x: 0 }, ease: 'bezier', h1: [0.25, 0.1], h2: [0.75, 0.9] },
        { t: 2, state: { x: 12 }, ease: 'hold', h1: [0.25, 0.1], h2: [0.75, 0.9] },
    ]);

    // ④ 读回来：条数、type、参数、轨道、id 全在
    const rt = objectsOf(await store.jsonToDoc(store.docToFile(doc, { name: '效果', savedAt: 1 })))[0].effects;
    assert.deepEqual(rt.map((e) => e.type), ['blur', 'glow', 'shadow', 'adjust', 'outline']);
    assert.deepEqual(rt[0], { type: 'blur', amount: 0.5, id: 'fx-1' });
    assert.equal(rt[2].color, 'rgba(0,0,0,0.45)');
    assert.deepEqual(rt[3], { type: 'adjust', brightness: 1.4, contrast: 0.8, saturate: 2, hue: -45, id: 'fx-4' });
    assert.equal(rt[4].id, 'fx-outline');
    assert.equal(hasTracks(rt[4]), true);

    // ⑤ 语义没变：两端在多个时刻的 filter 串与轨道求值逐字相等（证明插值也一起活下来了）
    for (const t of [0, 0.5, 1, 2]) {
        assert.equal(filterStringAt(rt, t), filterStringAt(effects, t), 't=' + t + ' 的 filter 串应一致');
        assert.equal(effectAt(rt[4], t).amount, effectAt(effects[4], t).amount, 't=' + t + ' 的轨道求值应一致');
    }
});

test('项目库记录同样带效果：makeRecord 里嵌的不是丢效果的副本', () => {
    const rec = store.makeRecord({ name: '效果', doc: docWithEffects(effectsFixture()) });
    const el = rec.project.doc.elements[0];
    assert.equal(el.effects.length, 5);
    assert.equal(el.effects[4].tracks.amount.keys.length, 2);
    assert.equal(rec.bytes > 0, true);
});

/* ─────────────────────────── 向后兼容 ─────────────────────────── */

test('向后兼容：没有 effects 字段的老档读成 []，落盘也不凭空长出 effects', async () => {
    const back = await store.jsonToDoc(v4Node());
    assert.ok(back, '老档要能读进来');
    assert.deepEqual(objectsOf(back)[0].effects, []);

    const el = nodeOf(store.docToFile(back, { name: '老档', savedAt: 2 })).elements[0];
    assert.equal('effects' in el, false, '空效果不落字段，文件形状与改前一致');
    assert.equal(el.cels.length, 1, '纹理口径不受影响');
});

/* ─────────────────────────── 脏数据 ─────────────────────────── */

test('脏数据 fail-soft：非数组 / 未知 type / 缺参数 / 坏颜色只降级，不抛', async () => {
    const nope = await store.jsonToDoc(nodeWithEffects('nope'));
    assert.deepEqual(objectsOf(nope)[0].effects, [], '字段不是数组 → 当成没有效果');

    const mixed = await store.jsonToDoc(nodeWithEffects([null, 'x', { type: 'unknown', amount: 3 }, { type: 'blur' }]));
    // 缺的参数按 `EFFECT_DEFS` 的默认值补齐（blur 的 amount 默认不是 0，别把默认值写死在测试里）；
    // 侧载入侧会给没有 id 的效果确定性补一个 `fx-1`
    assert.deepEqual(objectsOf(mixed)[0].effects, [Object.assign(defaultEffect('blur'), { id: 'fx-1' })], '认不出的条目丢掉，只留合法的那条并按默认补参');

    const badColor = await store.jsonToDoc(nodeWithEffects([{ type: 'glow', amount: 8, color: 123 }]));
    assert.equal(objectsOf(badColor)[0].effects[0].color, '#4a7dff', '颜色不是字符串 → 回默认值');
});

test('脏数据 fail-soft：轨道形状坏就丢通道，坏关键帧逐颗跳掉', async () => {
    const noArray = await store.jsonToDoc(nodeWithEffects([{ type: 'blur', amount: 2, tracks: { amount: { keys: 'nope' }, stale: 7 } }]));
    const fx1 = objectsOf(noArray)[0].effects[0];
    assert.equal(fx1.amount, 2, '轨道坏不影响静态参数');
    assert.equal('tracks' in fx1, false, 'keys 不是数组 → 丢掉该通道');

    const dirty = await store.jsonToDoc(nodeWithEffects([{ type: 'blur', amount: 2, tracks: { amount: { keys: [{ t: 'x', state: { x: 1 } }, { t: 1 }, { t: 2, state: { x: 6 }, ease: 'wobble' }] } } }]));
    const trk = objectsOf(dirty)[0].effects[0].tracks.amount;
    assert.equal(trk.keys.length, 1, 't 非法 / 没有 state.x 的帧逐颗丢掉');
    assert.deepEqual(trk.keys[0].state, { x: 6 });
    assert.equal(trk.keys[0].ease, 'linear', '不认识的 ease 归一到 linear');
});

/* ─────────────────────── 未知类型的取舍 ─────────────────────── */

test('未知效果类型：落盘照原样保留（不替用户删数据），读入时才丢弃', async () => {
    const file = store.docToFile(docWithEffects([{ type: 'not-yet', amount: 3 }, { type: 'blur', amount: 1 }]), { name: '未来类型', savedAt: 1 });
    const el = nodeOf(file).elements[0];
    assert.deepEqual(el.effects.map((e) => e.type), ['not-yet', 'blur'], '写盘不做白名单裁剪');

    const back = await store.jsonToDoc(file);
    assert.deepEqual(objectsOf(back)[0].effects.map((e) => e.type), ['blur'], '读入认不出的类型丢掉该条');
});
