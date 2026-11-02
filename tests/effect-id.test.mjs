/**
 * 效果身份（`layer.effects[i].id = 'fx-<n>'`）单测。
 *
 * 背景：效果原先只靠数组下标寻址。`prop-object.mjs` 的删除按钮闭包里记的是构建 DOM 时那份
 * 文档的 `idx`，重绘前点一下就会删错；`dataset.fxIndex` 更是全仓无读取者的死字段。
 * 24b（效果参数接入曲线编辑器）还需要一条稳定寻址串，通道 id 定为 `fx.<effectId>.<paramKey>`。
 *
 * 这里锁住五件事：
 * 1. 确定性补号：老档（没有 id）反复载入得到同一组 id，保存后不再漂移；
 * 2. 不碰数据：补号不动参数、不动轨道引用、不改渲染输出；
 * 3. 冲突处理：重复 id / 非法字符（尤其含「.」）/ 非字符串 → 重发；
 * 4. 手写 id（`fx-outline` 这种非序号）原样保留，且不污染新号高水位；
 * 5. 补号只发生在「载入 + 写入」两处，绝不能落在 `defaultEffect` / `normalizeEffect`
 *    （后者会丢 tracks，且是渲染期每帧路径）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as store from '../app/shell/project-store.mjs';
import {
    ensureEffectIds,
    findEffectById,
    hasTracks,
    indexOfEffect,
    effectAt,
    filterStringAt,
} from '../app/paint/effects.mjs';
import { addKey, createTrack } from '../app/core/transform.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const nodeOf = (file) => (file && file.doc ? file.doc : file);
const ids = (list) => list.map((e) => e && e.id);

/** 手写一份 v4 老节点（elements 里可以塞任意 effects 原文）。 */
function nodeWithEffects(effects) {
    return {
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
            effects,
        }],
        tags: [],
    };
}

test('补号：没有 id 的效果按数组顺序得到 fx-1、fx-2', () => {
    assert.deepEqual(ids(ensureEffectIds([{ type: 'blur' }, { type: 'glow' }])), ['fx-1', 'fx-2']);
});

test('幂等：全部合法时返回原数组引用，不制造新对象', () => {
    const once = ensureEffectIds([{ type: 'blur' }, { type: 'glow' }]);
    const twice = ensureEffectIds(once);
    assert.equal(twice, once, '第二次调用必须原样返回同一引用');
});

test('手写 id 保留，且不抬高序号高水位', () => {
    const list = ensureEffectIds([{ type: 'outline', id: 'fx-outline' }, { type: 'blur' }]);
    assert.equal(list[0].id, 'fx-outline', '非序号 id 原样保留');
    assert.equal(list[1].id, 'fx-1', 'fx-outline 不匹配 ^fx-(\\d+)$，新号仍从 1 起');
});

test('重复 id：前一条保留，后一条重发', () => {
    const list = ensureEffectIds([{ type: 'blur', id: 'fx-1' }, { type: 'glow', id: 'fx-1' }]);
    assert.deepEqual(ids(list), ['fx-1', 'fx-2']);
});

test('非法 id 一律重发（含「.」，否则通道 id 的 split 会有歧义）', () => {
    const list = ensureEffectIds([
        { type: 'blur', id: 'a.b' },
        { type: 'glow', id: '' },
        { type: 'shadow', id: 42 },
        { type: 'outline', id: null },
    ]);
    assert.deepEqual(ids(list), ['fx-1', 'fx-2', 'fx-3', 'fx-4']);
    for (const e of list) assert.match(e.id, /^[A-Za-z0-9_-]+$/);
});

test('补号不碰参数与轨道引用', () => {
    const track = addKey(createTrack(), 0, { x: 6 }, 'bezier');
    const src = { type: 'blur', amount: 6, tracks: { amount: track } };
    const out = ensureEffectIds([src])[0];
    assert.equal(out.amount, 6, '静态参数不变');
    assert.equal(out.tracks, src.tracks, '轨道对象必须是同一引用（不能浅拷贝丢键）');
    assert.equal(hasTracks(out), true);
    assert.equal(src.id, undefined, '原对象不被就地修改');
});

test('载入侧补号：老档读进来带 fx-1，保存时落到盘上', async () => {
    const doc = await store.jsonToDoc(nodeWithEffects([{ type: 'blur', amount: 0.5 }]));
    const effects = doc.objects[0].effects;
    assert.equal(effects[0].id, 'fx-1');

    const els = nodeOf(store.docToFile(doc, { name: '补号', savedAt: 2 })).elements;
    assert.equal(els[0].effects[0].id, 'fx-1', '落盘要带 id');
});

test('二次往返不漂移：读 → 存 → 读 → 存，两次落盘的 elements 逐字相同', async () => {
    const first = store.docToFile(await store.jsonToDoc(nodeWithEffects([{ type: 'blur' }, { type: 'glow', amount: 8 }])), { name: 'A', savedAt: 1 });
    const second = store.docToFile(await store.jsonToDoc(nodeOf(first)), { name: 'A', savedAt: 9 });
    assert.deepEqual(nodeOf(first).elements, nodeOf(second).elements);
});

test('老档轨道跟效果走：id 是新的，轨道值与求值结果一字不差', async () => {
    const doc = await store.jsonToDoc(nodeWithEffects([{
        type: 'blur',
        amount: 0.5,
        tracks: { amount: { keys: [{ t: 0, state: { x: 6 } }, { t: 1, state: { x: 12 } }] } },
    }]));
    const fx = doc.objects[0].effects[0];
    assert.equal(fx.id, 'fx-1');
    assert.equal(effectAt(fx, 0).amount, 6);
    assert.equal(effectAt(fx, 1).amount, 12);
    assert.equal(doc.channels, undefined, '文档里不存在第二张「通道 → 轨道」表，轨道只挂在效果自己身上');
});

test('按 id 寻址：删掉中间一条之后，剩下的 id 仍指向各自的效果', () => {
    let list = ensureEffectIds([
        { type: 'blur', amount: 1 },
        { type: 'blur', amount: 2 },
        { type: 'blur', amount: 3 },
    ]);
    assert.equal(indexOfEffect(list, 'fx-2'), 1);
    // 删中间：闭包里记的 idx=1 从此指的是 fx-3，按 id 找才对得上
    list = list.filter((e) => e.id !== 'fx-2');
    assert.equal(indexOfEffect(list, 'fx-3'), 1, '下标变了，但 id 仍能找到 fx-3');
    assert.equal(findEffectById(list, 'fx-3').amount, 3);
    assert.equal(findEffectById(list, 'fx-9'), null);
    assert.equal(indexOfEffect(list, 'fx-9'), -1);
});

test('渲染不受 id 影响：补号前后 filter 串逐字相同', () => {
    const raw = [
        { type: 'blur', amount: 4 },
        { type: 'shadow', dx: 2, dy: 2, amount: 3, color: 'rgba(0,0,0,0.45)' },
        { type: 'outline', amount: 1, color: '#000000' },
    ];
    const before = [0, 0.5, 1].map((t) => filterStringAt(raw, t));
    const after = [0, 0.5, 1].map((t) => filterStringAt(ensureEffectIds(raw), t));
    assert.deepEqual(after, before);
});

test('源码守卫：发号只落在 ensureEffectIds，不污染 defaultEffect / normalizeEffect', () => {
    const src = read('../app/paint/effects.mjs');
    const body = (name) => {
        const start = src.indexOf('export function ' + name);
        assert.ok(start > 0, name + ' 必须存在');
        const next = src.indexOf('\nexport ', start + 1);
        return src.slice(start, next < 0 ? src.length : next);
    };
    for (const name of ['defaultEffect', 'normalizeEffect']) {
        const text = body(name);
        assert.doesNotMatch(text, /ensureEffectIds/, name + ' 不能自己发号');
        assert.doesNotMatch(text, /'fx-'/, name + ' 不能自己造 id 字面量');
        assert.doesNotMatch(text, /\bid:\s*['"]/, name + ' 不能写死 id');
    }
});
