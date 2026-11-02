// 骨骼 P1-A 单测：文档模型认识第三种对象 kind='bone'，带 bone 外观字段并能存档往返。
//
// 这一层只做「模型 + 序列化」。画布怎么画骨骼、求值器怎么处理它都不在这里测 ——
// 骨骼没有纹理，绘制侧天然走「无图不画」的旧分支，不需要为它改任何求值逻辑。

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BONE_DEFAULTS,
    BONE_ANCHOR,
    normalizeBone,
    makeObject,
    createDoc,
    objectsOf,
} from '../app/core/doc-model.mjs';
import { elementSize, anchorPoint, hitTest } from '../app/core/element.mjs';
import { docToFile, jsonToDoc, VERSION } from '../app/shell/project-store.mjs';

const DOC = { width: 800, height: 600 };
const docOf = (objects) => createDoc({ width: DOC.width, height: DOC.height, objects });

/* ─────────────────────── normalizeBone ─────────────────────── */

test('normalizeBone：不是对象就没有骨骼字段', () => {
    assert.equal(normalizeBone(null), null);
    assert.equal(normalizeBone(undefined), null);
    assert.equal(normalizeBone('骨骼'), null);
    assert.equal(normalizeBone(120), null);
    assert.equal(normalizeBone(['len', 200]), null);
});

test('normalizeBone：空对象得到整份缺省', () => {
    assert.deepEqual(normalizeBone({}), {
        len: BONE_DEFAULTS.len,
        width: BONE_DEFAULTS.width,
        color: BONE_DEFAULTS.color,
    });
});

test('normalizeBone：长度与粗细越界一律夹进区间，不丢弃', () => {
    assert.equal(normalizeBone({ len: 0 }).len, 8);
    assert.equal(normalizeBone({ len: -100 }).len, 8);
    assert.equal(normalizeBone({ len: 99999 }).len, 4096);
    assert.equal(normalizeBone({ width: 0 }).width, 2);
    assert.equal(normalizeBone({ width: 9999 }).width, 256);
    // 区间内原样保留（含小数，骨骼长度不受整数约束）
    assert.equal(normalizeBone({ len: 200 }).len, 200);
    assert.equal(normalizeBone({ len: 200.5 }).len, 200.5);
});

test('normalizeBone：非数值退回缺省（字符串数字也不认）', () => {
    assert.equal(normalizeBone({ len: '200' }).len, BONE_DEFAULTS.len);
    assert.equal(normalizeBone({ len: NaN }).len, BONE_DEFAULTS.len);
    assert.equal(normalizeBone({ width: null }).width, BONE_DEFAULTS.width);
    assert.equal(normalizeBone({ width: Infinity }).width, BONE_DEFAULTS.width);
});

test('normalizeBone：颜色只认 #rgb / #rrggbb，其余退回缺省', () => {
    assert.equal(normalizeBone({ color: '#abc' }).color, '#abc');
    assert.equal(normalizeBone({ color: '#AABBCC' }).color, '#aabbcc');
    assert.equal(normalizeBone({ color: ' #123456 ' }).color, '#123456');
    assert.equal(normalizeBone({ color: 'red' }).color, BONE_DEFAULTS.color);
    assert.equal(normalizeBone({ color: '#ab' }).color, BONE_DEFAULTS.color);
    assert.equal(normalizeBone({ color: '#abcd' }).color, BONE_DEFAULTS.color);
    assert.equal(normalizeBone({ color: 'rgb(1,2,3)' }).color, BONE_DEFAULTS.color);
    assert.equal(normalizeBone({ color: 0x112233 }).color, BONE_DEFAULTS.color);
});

/* ─────────────────────── makeObject ─────────────────────── */

test("makeObject：kind='bone' 挂上 bone，缺的字段补缺省", () => {
    const obj = makeObject({ kind: 'bone', bone: { len: 200 } });
    assert.equal(obj.kind, 'bone');
    assert.equal(obj.bone.len, 200);
    assert.equal(obj.bone.width, BONE_DEFAULTS.width);
    assert.equal(obj.bone.color, BONE_DEFAULTS.color);
});

test("makeObject：kind='bone' 但没给 bone 时也给一份缺省", () => {
    const obj = makeObject({ kind: 'bone' });
    assert.equal(obj.kind, 'bone');
    assert.deepEqual(obj.bone, {
        len: BONE_DEFAULTS.len,
        width: BONE_DEFAULTS.width,
        color: BONE_DEFAULTS.color,
    });
});

test('makeObject：非骨骼对象身上不出现 bone 键', () => {
    for (const kind of ['paint', 'image', 'nonsense', undefined]) {
        const obj = makeObject({ kind, bone: { len: 200 } });
        assert.equal('bone' in obj, false, `kind=${kind} 不该有 bone 字段`);
    }
});

test('makeObject：未知 kind 收敛成 paint', () => {
    assert.equal(makeObject({ kind: 'bone' }).kind, 'bone');
    assert.equal(makeObject({ kind: 'image' }).kind, 'image');
    assert.equal(makeObject({ kind: 'paint' }).kind, 'paint');
    assert.equal(makeObject({ kind: 'skeleton' }).kind, 'paint');
    assert.equal(makeObject({}).kind, 'paint');
});

test('makeObject：骨骼的缺省锚点在根部，其它种类仍在原点', () => {
    assert.deepEqual(makeObject({ kind: 'bone' }).anchor, { x: 0, y: 0.5 });
    assert.deepEqual(makeObject({ kind: 'paint' }).anchor, { x: 0, y: 0 });
    assert.deepEqual(makeObject({ kind: 'image' }).anchor, { x: 0, y: 0 });
    // 显式给的锚点一律照收，骨骼也不例外
    assert.deepEqual(makeObject({ kind: 'bone', anchor: { x: 1, y: 0 } }).anchor, { x: 1, y: 0 });
});

test('anchorPoint：没有 anchor 字段的骨骼按根部算，其它按中心算', () => {
    const size = { w: 200, h: 20 };
    assert.deepEqual(anchorPoint({ kind: 'bone' }, size), { x: 0, y: size.h * BONE_ANCHOR.y });
    assert.deepEqual(anchorPoint({ kind: 'paint' }, size), { x: 100, y: 10 });
});

/* ─────────────────────── elementSize ─────────────────────── */

test('elementSize：骨骼取 bone 的长度与粗细，不回退文档尺寸', () => {
    const doc = { width: 800, height: 600 };
    const bone = makeObject({ kind: 'bone', bone: { len: 240, width: 18 } });
    assert.deepEqual(elementSize(doc, bone, 0), { w: 240, h: 18 });
});

test('elementSize：骨骼缺少 bone 字段时用缺省，不是文档尺寸', () => {
    const doc = { width: 800, height: 600 };
    // 手搓一个没有 bone 的骨骼对象：模型层兜住，仍然不能等于画布大小
    const bone = { kind: 'bone', anchor: { x: 0, y: 0.5 }, transform: { keys: [] } };
    assert.deepEqual(elementSize(doc, bone, 0), { w: BONE_DEFAULTS.len, h: BONE_DEFAULTS.width });
});

test('elementSize：没有纹理的手绘对象仍回退文档尺寸', () => {
    const doc = { width: 800, height: 600 };
    const paint = makeObject({ kind: 'paint' });
    assert.deepEqual(elementSize(doc, paint, 0), { w: 800, h: 600 });
});

/* ─────────────────────── 序列化 ─────────────────────── */

test('存档往返：kind 与 bone 都原样回来', async () => {
    const doc = docOf([
        { name: 'B1', kind: 'bone', bone: { len: 200, width: 20, color: '#123456' } },
        { name: 'P1', kind: 'paint' },
    ]);
    const file = docToFile(doc, { name: '骨骼往返', savedAt: 1 });
    const back = await jsonToDoc(file);
    const objs = objectsOf(back);
    const bone = objs.find((o) => o.name === 'B1');
    assert.equal(bone.kind, 'bone');
    assert.deepEqual(bone.bone, { len: 200, width: 20, color: '#123456' });
    assert.equal(objs.find((o) => o.name === 'P1').kind, 'paint');
});

test('存档里只有骨骼对象带 bone 字段', () => {
    const doc = docOf([
        { name: 'B1', kind: 'bone', bone: { len: 200 } },
        { name: 'P1', kind: 'paint', bone: { len: 200 } },
        { name: 'I1', kind: 'image', bone: { len: 200 } },
    ]);
    const els = docToFile(doc, { name: '纯净', savedAt: 1 }).elements;
    const byName = (n) => els.find((e) => e.name === n);
    assert.deepEqual(byName('B1').bone, { len: 200, width: BONE_DEFAULTS.width, color: BONE_DEFAULTS.color });
    assert.equal('bone' in byName('P1'), false);
    assert.equal('bone' in byName('I1'), false);
});

test('落盘纯净性：kind 只可能是 paint / image / bone 三值', () => {
    const doc = docOf([
        { name: 'a', kind: 'bone' },
        { name: 'b', kind: 'image' },
        { name: 'c', kind: 'paint' },
        { name: 'd', kind: 'unknown-kind' },
    ]);
    const els = docToFile(doc, { name: '白名单', savedAt: 1 }).elements;
    for (const el of els) assert.ok(['paint', 'image', 'bone'].includes(el.kind), `非法 kind：${el.kind}`);
});

test('加骨骼不升文件版本：仍是 v4，老档没有 bone 字段也能读', async () => {
    assert.equal(VERSION, 4);
    const file = docToFile(docOf([{ name: 'B1', kind: 'bone' }]), { name: '版本', savedAt: 1 });
    assert.equal(file.version, 4);
    const back = await jsonToDoc(file);
    assert.equal(objectsOf(back)[0].kind, 'bone');
});

test('读入脏 bone：越界与坏色被归一，kind 仍然是 bone', async () => {
    const file = {
        format: 'motionstudio-project',
        version: 4,
        width: 800,
        height: 600,
        elements: [
            {
                id: 'e1',
                name: 'B1',
                kind: 'bone',
                anchor: { x: 0, y: 0.5 },
                bone: { len: -5, width: 9999, color: 'tomato' },
                cels: [{ at: 0, image: null }],
            },
        ],
    };
    const back = await jsonToDoc(file);
    const bone = objectsOf(back)[0];
    assert.equal(bone.kind, 'bone');
    assert.deepEqual(bone.bone, { len: 8, width: 256, color: BONE_DEFAULTS.color });
});

test('读入老档（对象没有 bone 字段）：骨骼拿到缺省外观', async () => {
    const file = {
        format: 'motionstudio-project',
        version: 4,
        width: 800,
        height: 600,
        elements: [{ id: 'e1', name: 'B1', kind: 'bone', anchor: { x: 0, y: 0.5 }, cels: [{ at: 0, image: null }] }],
    };
    const back = await jsonToDoc(file);
    const bone = objectsOf(back)[0];
    assert.deepEqual(bone.bone, {
        len: BONE_DEFAULTS.len,
        width: BONE_DEFAULTS.width,
        color: BONE_DEFAULTS.color,
    });
});

test('读入没有 anchor 的骨骼：锚点补在根部，不是中心', async () => {
    const file = {
        format: 'motionstudio-project',
        version: 4,
        width: 800,
        height: 600,
        elements: [{ id: 'e1', name: 'B1', kind: 'bone', cels: [{ at: 0, image: null }] }],
    };
    const bone = objectsOf(await jsonToDoc(file))[0];
    assert.deepEqual(bone.anchor, { x: 0, y: 0.5 });
});

/* ─────────────────────── 命中 ─────────────────────── */

// 骨骼没有纹理，通用命中路径对无图对象是直接 continue；不单独放行的话，
// 画布上看得见一根骨头却点不中 —— 用户只会以为工具坏了。
test('骨骼能被点中：沿骨头长度命中，粗细方向有阈值放宽', () => {
    const bone = makeObject({ id: 'b1', kind: 'bone', bone: { len: 200, width: 14 } });
    const doc = docOf([bone]);
    // 骨头中线上的点（局部 x=100、y=width/2=7）
    const hit = hitTest(doc, 0, 100, 7);
    assert.ok(hit, '骨头中线上应该命中');
    assert.equal(hit.id, 'b1');
    // 超出粗细一半 + threshold 之外：不命中
    assert.equal(hitTest(doc, 0, 100, 120), null);
    // 超出长度末端 + threshold 之外：不命中
    assert.equal(hitTest(doc, 0, 400, 7), null);
});

test('骨骼放行不影响空手绘对象：没画任何东西的手绘对象仍然整块不可点', () => {
    const empty = makeObject({ id: 'p1', kind: 'paint' });
    const doc = docOf([empty]);
    assert.equal(hitTest(doc, 0, 20, 20), null);
});
