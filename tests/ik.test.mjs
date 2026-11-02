// 骨骼 P3 步 1：IK 解算器（`app/core/ik.mjs`）单测。
//
// 这一层**没有任何消费者**（求值器与蒙皮还没接），所以测的是三件事：
//   1. 数学：CCD 解完后末端是否真的落到目标上（可达 / 不可达两种）
//   2. 形状：normalizeIk 的夹取、ikChains 的链收集与环检测
//   3. 边界：不产 NaN、链长到根为止、目标在链内时拒绝解算、缓存命中同一张表
//
// 全部用「无纹理骨骼 + 手写关键帧」构造，不碰 DOM 与 canvas。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createDoc, makeObject } from '../app/core/doc-model.mjs';
import {
    IK_MAX_CHAIN,
    IK_TOLERANCE,
    ikChains,
    normalizeIk,
    resetIkCache,
    solveIk,
} from '../app/core/ik.mjs';

/**
 * 建文档，并把 `ik` 约束挂到文档里的对象上。
 *
 * 为什么要补挂：`createDoc`/`makeObject` 是白名单构造器，`ik` 还没进白名单
 * （那一行属于步 2），所以直接传进去会被静默吃掉 —— 这正是 `effects` 与 `skin`
 * 各自踩过一次的坑。步 2 把 `ik` 加进白名单后，这段补挂会自动变成空操作。
 */
function docOf(objects) {
    const doc = createDoc({ width: 800, height: 600, objects });
    for (const src of objects) {
        if (!src || !src.ik) continue;
        const target = doc.objects.find((o) => o && o.id === src.id);
        if (target) target.ik = src.ik;
    }
    return doc;
}

/** 骨骼：默认 120×14、锚点根部（x=0,y=0.5）、沿局部 +x 伸展。 */
function bone(id, extra = {}) {
    const o = makeObject({
        id,
        name: id,
        kind: 'bone',
        bone: { len: 120, width: 14 },
        transform: { keys: [] },
        ...extra,
    });
    // makeObject 是白名单构造器：约束字段还没进白名单（那是步 2 的事），
    // 所以这里手动挂上 —— 步 1 的验收就是「没有消费者时解算器自己是对的」。
    if (extra.ik) o.ik = extra.ik;
    return o;
}

/** 一根骨的根部在世界里的位置（anchor = (0, 7)）。 */
const rootOf = (m, w = 14) => ({ x: m.a * 0 + m.c * (w / 2) + m.e, y: m.b * 0 + m.d * (w / 2) + m.f });

/** 一根骨的末端在世界里的位置（末端局部 = (len, w/2)）。 */
function tipOf(m, len = 120, w = 14) {
    const x = len;
    const y = w / 2;
    return { x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f };
}

const finite = (m) => ['a', 'b', 'c', 'd', 'e', 'f'].every((k) => Number.isFinite(m[k]));

/* ── 1. 数学 ───────────────────────────────────────────────────────── */

test('单骨 180°：目标在根的另一侧同距离 → 解算后末端落到目标上', () => {
    resetIkCache();
    // 根在 (0,7)，末端在 (120,7)。目标放 (100,0) 附近不合适，直接放「反转方向」
    const b = bone('b1', { ik: { targetId: 't1', chain: 1, iterations: 24 } });
    const t = makeObject({ id: 't1', name: 'T', kind: 'paint', transform: { keys: [] } });
    // 非骨对象的缺省 anchor 是原点（makeObject 按 kind 分），所以它的 x/y 就是目标点
    t.transform.keys = [{ t: 0, state: { x: -120, y: 7 } }];
    const doc = docOf([b, t]);
    const sol = solveIk(doc, 0);
    const m = sol.get('b1');
    assert.ok(m, '应产出 b1 的覆盖矩阵');
    const tip = tipOf(m);
    // 目标点 = (-120, 7)；单骨长度 120，可达
    const d = Math.hypot(tip.x - (-120), tip.y - 7);
    assert.ok(d <= 5e-3, `末端应贴住目标，实际偏差 ${d}`);
});

test('两骨可达：解算后末端与目标距离 < 1e-3', () => {
    resetIkCache();
    // A 在原点（根 (0,7)，末端 (120,7)），B 挂在 A 上、局部 x=120 起（即 A 的末端）
    const a = bone('a', { transform: { keys: [{ t: 0, state: { x: 0, y: 0 } }] } });
    const b = bone('b', { parentId: 'a', transform: { keys: [{ t: 0, state: { x: 120, y: 0 } }] }, ik: { targetId: 't1', chain: 2, iterations: 24 } });
    const t = makeObject({ id: 't1', name: 'T', kind: 'paint', transform: { keys: [{ t: 0, state: { x: 100, y: 7 } }] } });
    const doc = docOf([a, b, t]);
    const sol = solveIk(doc, 0);
    const mb = sol.get('b');
    assert.ok(mb, '应产出 b 的覆盖矩阵');
    const tip = tipOf(mb);
    const d = Math.hypot(tip.x - 100, tip.y - 7);
    assert.ok(d <= 1e-3, `两骨应能贴住目标 (100,7)，实际偏差 ${d}`);
});

test('不可达：目标比链总长更远 → 退化为伸直，不抛错、矩阵无 NaN', () => {
    resetIkCache();
    const a = bone('a');
    const b = bone('b', { parentId: 'a', transform: { keys: [{ t: 0, state: { x: 120, y: 0 } }] }, ik: { targetId: 't1', chain: 2 } });
    const t = makeObject({ id: 't1', name: 'T', kind: 'paint', transform: { keys: [{ t: 0, state: { x: 600, y: 7 } }] } });
    const doc = docOf([a, b, t]);
    const sol = solveIk(doc, 0);
    const mb = sol.get('b');
    assert.ok(finite(mb), '矩阵必须逐项有限');
    const tip = tipOf(mb);
    const d = Math.hypot(tip.x - 600, tip.y - 7);
    // 根在 (0,7)、链总长 240、目标在 (600,7)：伸直后末端应在 (240,7)，
    // 于是「末端到目标」= 600 − 240 = 360 —— 这是「够不着」的正确形状。
    assert.ok(Math.abs(d - 360) < 1, `伸直后末端到目标应约等于 360（600 − 240），实际 ${d}`);
    assert.ok(Math.abs(tip.y - 7) < 1, `伸直后末端应在 y≈7 这条线上，实际 y=${tip.y}`);
});

test('chain=1 只转自身；chain 超过实际父链长度时取到根为止', () => {
    resetIkCache();
    const a = bone('a', { transform: { keys: [{ t: 0, state: { x: 0, y: 0 } }] } });
    const b = bone('b', { parentId: 'a', transform: { keys: [{ t: 0, state: { x: 120, y: 0 } }] }, ik: { targetId: 't1', chain: 99 } });
    const t = makeObject({ id: 't1', name: 'T', kind: 'paint', transform: { keys: [] } });
    const doc = docOf([a, b, t]);
    const chains = ikChains(doc);
    assert.equal(chains.length, 1);
    assert.equal(chains[0].bones.length, 2, 'chain 超长应被实际父链（2 根）截断');
    assert.deepEqual(chains[0].bones.map((x) => x.id), ['a', 'b'], '必须由根到叶排列');
});

/* ── 2. 形状 ───────────────────────────────────────────────────────── */

test('normalizeIk：夹取 chain / iterations，坏 targetId 整条作废', () => {
    assert.equal(normalizeIk(null), null);
    assert.equal(normalizeIk([]), null);
    assert.equal(normalizeIk({}), null, '没有 targetId 就没有约束');
    assert.equal(normalizeIk({ targetId: 42 }), null, 'targetId 必须是字符串');
    const a = normalizeIk({ targetId: 'x' });
    assert.deepEqual(a, { targetId: 'x', chain: 2, iterations: 8, enabled: true, bend: 'auto' });
    assert.equal(normalizeIk({ targetId: 'x', chain: 0 }).chain, 1);
    assert.equal(normalizeIk({ targetId: 'x', chain: 99 }).chain, IK_MAX_CHAIN);
    assert.equal(normalizeIk({ targetId: 'x', iterations: 0 }).iterations, 1);
    assert.equal(normalizeIk({ targetId: 'x', enabled: false }).enabled, false);
    // 肘部朝向：只认 auto/left/right，坏值回落 auto
    assert.equal(normalizeIk({ targetId: 'x' }).bend, 'auto');
    assert.equal(normalizeIk({ targetId: 'x', bend: 'left' }).bend, 'left');
    assert.equal(normalizeIk({ targetId: 'x', bend: '旁' }).bend, 'auto');
});

test('目标落在链内（自引用/祖先）→ 拒绝解算，产出空表', () => {
    resetIkCache();
    const a = bone('a');
    const b = bone('b', { parentId: 'a', transform: { keys: [{ t: 0, state: { x: 120, y: 0 } }] }, ik: { targetId: 'a', chain: 2 } });
    const doc = docOf([a, b]);
    assert.equal(ikChains(doc).length, 0, '目标在链上必须被剔除');
    assert.equal(solveIk(doc, 0).size, 0);
});

test('没有 ik 的骨骼、以及 enabled:false 的约束 → 空表（零回归）', () => {
    resetIkCache();
    const a = bone('a');
    const b = bone('b', { parentId: 'a', ik: { targetId: 't1', enabled: false } });
    const t = makeObject({ id: 't1', name: 'T', kind: 'paint', transform: { keys: [] } });
    const doc = docOf([a, b, t]);
    assert.equal(solveIk(doc, 0).size, 0);
});

test('链只能由骨组成：中间插入非骨对象时链在断点处停止', () => {
    resetIkCache();
    const a = bone('a');
    const mid = makeObject({ id: 'm', name: 'M', kind: 'paint', parentId: 'a', transform: { keys: [] } });
    const b = bone('b', { parentId: 'm', transform: { keys: [{ t: 0, state: { x: 120, y: 0 } }] }, ik: { targetId: 't1', chain: 3 } });
    const t = makeObject({ id: 't1', name: 'T', kind: 'paint', transform: { keys: [] } });
    const doc = docOf([a, mid, b, t]);
    const chains = ikChains(doc);
    assert.equal(chains.length, 1);
    assert.deepEqual(chains[0].bones.map((x) => x.id), ['b'], '父级不是骨 → 链只到 b 自己');
});

/* ── 3. 边界 ───────────────────────────────────────────────────────── */

test('单槽缓存：同一 doc + 同一时间两次调用返回同一张表', () => {
    resetIkCache();
    const b = bone('b1', { ik: { targetId: 't1', chain: 1 } });
    const t = makeObject({ id: 't1', name: 'T', kind: 'paint', transform: { keys: [] } });
    const doc = docOf([b, t]);
    const one = solveIk(doc, 0);
    const two = solveIk(doc, 0);
    assert.equal(two, one, '同帧必须复用同一张表（否则 evaluator 与 skin 会各算一遍）');
    // 换时间 → 必须重算（新表）
    const three = solveIk(doc, 0.5);
    assert.notEqual(three, one);
});

test('解算不修改输入文档：ik 与 transform.keys 保持原样', () => {
    resetIkCache();
    const keys = [{ t: 0, state: { x: 0, y: 0 } }];
    const b = bone('b1', { transform: { keys }, ik: { targetId: 't1', chain: 1 } });
    const t = makeObject({ id: 't1', name: 'T', kind: 'paint', transform: { keys: [{ t: 0, state: { x: 500, y: 0 } }] } });
    const doc = docOf([b, t]);
    const before = JSON.stringify(doc.objects);
    solveIk(doc, 0);
    assert.equal(JSON.stringify(doc.objects), before, '解算必须只产出覆盖表，绝不回写 doc');
});

test('源码守卫：ik.mjs 不碰 DOM、不 import 求值器/蒙皮（防循环依赖）', () => {
    const src = readFileSync(new URL('../app/core/ik.mjs', import.meta.url), 'utf8');
    assert.ok(!/document\.|window\.|canvas/.test(src), 'ik.mjs 必须是纯 core');
    assert.ok(!/from '\.\/evaluator\.mjs'/.test(src), '不许 import evaluator（会成环）');
    assert.ok(!/from '\.\/skin\.mjs'/.test(src), '不许 import skin（会成环）');
    assert.ok(src.includes('export function solveIk'), '必须导出 solveIk');
    assert.ok(src.includes('export function normalizeIk'), '必须导出 normalizeIk');
});

test('IK_TOLERANCE 是一个合理的小量（防止被改成 1e-12 导致永不收敛）', () => {
    assert.ok(IK_TOLERANCE > 0 && IK_TOLERANCE <= 0.01, '容差应在 (0, 0.01]，实际 ' + IK_TOLERANCE);
});
