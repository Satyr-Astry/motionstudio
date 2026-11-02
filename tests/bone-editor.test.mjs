/**
 * 骨骼编辑（P1-B）单测：画布骨架叠加 / 属性面板骨骼段 / `object.add-bone` 命令 / 词条。
 *
 * 三条口径来自任务书与 CONTRACT：
 * 1. 骨骼是对象的一种 kind（`kind === 'bone'`），几何由 `el.bone = {len,width,color}` 决定，
 *    锚点固定在根部中点、局部骨头从 `(0, width/2)` 画到 `(len, width/2)`；
 * 2. 画布骨架必须**常显**（没选中也要看得见），所以绘制排在 `selectionInfo()` 判空之前；
 * 3. 译文永远不进存档：`.msp` 里只有 kind / 标量 / id，没有词条键、没有「骨骼」「Bone」。
 *
 * 骨架绘制与面板挂载都是 DOM 代码，这里不引 jsdom：用源码守卫锁住「接线正确」，
 * 再用 core 的纯函数（makeObject / normalizeBone / elementSize / addObject）锁住行为。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    BONE_DEFAULTS, BONE_ANCHOR, normalizeBone,
    addObject, createDoc, makeObject, objectsOf,
} from '../app/core/doc-model.mjs';
import { elementSize } from '../app/core/element.mjs';
import { docToJSON } from '../app/shell/project-store.mjs';
import { t, setLocale, has } from '../app/i18n/index.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const CANVAS = read('../app/editors/canvas.mjs');
const PROP_OBJECT = read('../app/editors/prop-object.mjs');
const LAYERS = read('../app/editors/layers.mjs');
const APP = read('../app/shell/app.mjs');
const COMMANDS = read('../app/i18n/parts/commands.mjs');

/* ───────────────────────── 画布：骨架叠加 ───────────────────────── */

test('画布有 drawBones()，且排在 selectionInfo() 判空之前（骨架要常显）', () => {
    assert.match(CANVAS, /function drawBones\(g\)/, 'canvas.mjs 缺 drawBones()');
    const call = CANVAS.indexOf('        drawBones(g);');
    assert.ok(call > 0, 'drawGizmo 里没调用 drawBones(g)');
    // 清屏之后才画（否则被 clearRect 擦掉），判空之前就画（否则没选中时骨架消失）
    const cleared = CANVAS.indexOf('g.setTransform(dpr, 0, 0, dpr, 0, 0);');
    const guard = CANVAS.indexOf('const info = selectionInfo();');
    assert.ok(cleared > 0 && guard > 0, 'canvas.mjs 的 drawGizmo 结构变了，请同步本条断言');
    assert.ok(call > cleared, 'drawBones 必须在 setTransform(dpr …) 之后调用');
    assert.ok(call < guard, 'drawBones 必须在 selectionInfo() 判空之前调用');
});

test('骨架绘制只挑 bone 对象，并走与选框同一套矩阵（objectParentMatrix × elementWorldMatrix）', () => {
    const body = CANVAS.slice(CANVAS.indexOf('function drawBones(g)'), CANVAS.indexOf('const info = selectionInfo();'));
    assert.match(body, /el\.kind !== 'bone'/, 'drawBones 必须先滤 kind');
    assert.match(body, /ctx\.objectParentMatrix\(/, '骨架没走 ctx.objectParentMatrix —— 会和选框错位');
    assert.match(body, /elementWorldMatrix\(/, '骨架没用 elementWorldMatrix');
    assert.match(body, /BONE_DEFAULTS/, '缺 el.bone 时没兜底 BONE_DEFAULTS');
    // 局部端点：(0, width/2) → (len, width/2)
    assert.match(body, /\{ x: 0, y: width \/ 2 \}/);
    assert.match(body, /\{ x: len, y: width \/ 2 \}/);
});

/* ───────────────────────── 属性面板：骨骼段 ───────────────────────── */

test('属性面板的骨骼段有三个字段，且只在骨骼对象上出现', () => {
    assert.match(PROP_OBJECT, /props\.obj\.groupBone/, '缺骨骼分组标题的词条');
    assert.match(PROP_OBJECT, /min: 8, max: 4096, step: 1[\s\S]{0,120}key: 'bone-len'/, '长度框的区间不对（8–4096 step 1）');
    assert.match(PROP_OBJECT, /min: 2, max: 256, step: 1[\s\S]{0,120}key: 'bone-width'/, '粗细框的区间不对（2–256 step 1）');
    assert.match(PROP_OBJECT, /boneColor\.type = 'color'/, '颜色框不是 <input type="color">');
    // 写口：走 patchActive（ctx.setDoc + patchLayer），只改 bone 字段
    assert.match(PROP_OBJECT, /patchActive\(\{ bone: next \}\)/, '骨骼写口没走 patchActive');
    assert.match(PROP_OBJECT, /layer\.kind !== 'bone'/, '写口没有拦非骨骼对象');
    // 显隐：非骨骼整组收起
    assert.ok(PROP_OBJECT.includes("group.style.display = bone ? '' : 'none'"), '非骨骼对象没收起骨骼组');
});

test('layers.mjs 认定 bone 种类，且 kindLabel 用的是真绑定（tr）', () => {
    assert.match(LAYERS, /bone: 'kind\.bone'/, 'layers 的 KIND_KEYS 缺 bone');
    // 这个文件把 i18n 的 t 导入成 tr（syncRows 的形参 t 是时刻）；以前写成 t(…) 会 ReferenceError
    assert.match(LAYERS, /return tr\(KIND_KEYS\[kind\]\);/, 'kindLabel 应该调用 tr(…)，本文件没有名为 t 的绑定');
});

/* ───────────────────────── 命令：object.add-bone ───────────────────────── */

test('命令表里有 object.add-bone，且真的用 addObject 造骨骼（kind 由 core 归一）', () => {
    assert.match(APP, /id: 'object\.add-bone'/, 'app.mjs 命令表缺 object.add-bone');
    assert.match(APP, /t\('cmd\.object\.addBone'\)/, '命令标题没走词条');
    assert.match(APP, /addObject\(doc, \{ name: nextObjectName\(doc\), kind: 'bone'/, '命令没走 addObject + kind: bone');
    assert.match(APP, /parentId/, '命令没处理「同层」');
});

test('commands 分片两表都有骨骼命令的标题与提示，且与源码 id 对得上', () => {
    for (const key of ['cmd.object.addBone', 'cmd.object.addBone.hint']) {
        assert.ok(has(key), `词典缺 ${key}`);
        const en = COMMANDS.match(new RegExp(`'${key.replace(/\./g, '\\.')}': '([^']+)'`, 'g')) || [];
        assert.equal(en.length, 2, `${key} 应该 en / zh-Hans 各一条，实际 ${en.length} 条`);
    }
    assert.ok(has('cmd.group.edit'), '骨骼命令借用了「编辑」分组，分组标题必须在词典里');
});

/* ───────────────────────── 行为：core 归一 / 几何 / 存档 ───────────────────────── */

test('makeObject 补齐骨骼：kind / anchor(根部中点) / bone 缺省值', () => {
    const o = makeObject({ name: 'b1', kind: 'bone' });
    assert.equal(o.kind, 'bone');
    assert.deepEqual(o.anchor, { x: BONE_ANCHOR.x, y: BONE_ANCHOR.y });
    assert.equal(o.anchor.x, 0);
    assert.equal(o.anchor.y, 0.5);
    assert.deepEqual(o.bone, { ...BONE_DEFAULTS });
});

test('normalizeBone 夹取长度 / 粗细，坏颜色退回缺省，垃圾输入给 null', () => {
    const low = normalizeBone({ len: -5, width: 0 });
    assert.equal(low.len, 8);
    assert.equal(low.width, 2);
    const high = normalizeBone({ len: 99999, width: 99999 });
    assert.equal(high.len, 4096);
    assert.equal(high.width, 256);
    assert.equal(normalizeBone({ color: 'red' }).color, BONE_DEFAULTS.color, '非法颜色必须退回缺省');
    assert.equal(normalizeBone({ color: '#ABCDEF' }).color, '#abcdef', '颜色应统一小写');
    assert.equal(normalizeBone(null), null);
    assert.equal(normalizeBone([]), null);
    assert.equal(normalizeBone('bone'), null);
});

test('addObject 造出来的骨骼：kind / bone / anchor 一次到位，且追加在末尾', () => {
    const doc = createDoc({ objects: [{ name: 'a' }] });
    const before = objectsOf(doc).length;
    const next = addObject(doc, { name: 'b2', kind: 'bone', parentId: null });
    const list = objectsOf(next);
    assert.equal(list.length, before + 1);
    const bone = list[list.length - 1];
    assert.equal(bone.kind, 'bone');
    assert.deepEqual(bone.bone, { ...BONE_DEFAULTS });
    assert.deepEqual(bone.anchor, { x: 0, y: 0.5 });
});

test('elementSize 用骨骼自己的 len × width，不落回文档尺寸', () => {
    const doc = createDoc({ width: 900, height: 640 });
    const bone = makeObject({ kind: 'bone', bone: { len: 240, width: 18, color: '#112233' } });
    const size = elementSize(doc, bone, 0);
    assert.deepEqual(size, { w: 240, h: 18 });
    // 缺 bone 的脏对象也不会退化成整张画布
    const bare = Object.assign({}, bone, { bone: null });
    assert.deepEqual(elementSize(doc, bare, 0), { w: BONE_DEFAULTS.len, h: BONE_DEFAULTS.width });
});

test('骨骼的译文不进存档：.msp 里只有 kind / 标量 / id', () => {
    const doc = createDoc({
        objects: [
            { name: 'obj-1' },
            { name: 'obj-2', kind: 'bone', bone: { len: 200, width: 16, color: '#7d8fa8' } },
        ],
    });
    const json = JSON.stringify(docToJSON(doc));
    assert.match(json, /"kind":"bone"/, '存档应保留 kind: bone');
    assert.match(json, /"len":200/, '存档应保留骨骼长度');
    // 译文 / 词条键都不许出现在存档里
    for (const banned of ['骨骼', 'Bone', 'props.obj.boneLen', 'props.obj.groupBone', 'kind.bone']) {
        assert.ok(!json.includes(banned), `存档里出现了 ${banned}`);
    }
    // bone 只允许三个字段
    const saved = docToJSON(doc);
    const node = (saved.elements || saved.objects || saved.layers || []).find((o) => o.kind === 'bone');
    assert.ok(node, '存档里找不到骨骼节点');
    assert.deepEqual(Object.keys(node.bone).sort(), ['color', 'len', 'width']);
});

test('骨骼段的四个词条中英都齐，且 en 侧不是中文', () => {
    const keys = ['props.obj.groupBone', 'props.obj.boneLen', 'props.obj.boneWidth', 'props.obj.boneColor', 'kind.bone'];
    for (const key of keys) assert.ok(has(key), `词典缺 ${key}`);
    setLocale('zh-Hans');
    const zh = keys.map((k) => t(k));
    setLocale('en');
    const en = keys.map((k) => t(k));
    setLocale('en');
    assert.deepEqual(zh, ['骨骼', '长度', '宽度', '颜色', '骨骼']);
    assert.deepEqual(en, ['Bone', 'Length', 'Thickness', 'Bone colour', 'Bone']);
    for (const text of en) assert.ok(!/[\u4e00-\u9fff]/.test(text), `en 侧出现中文：${text}`);
});
