// 播放刷新分级：纯决策。不 mock DOM、不依赖外壳与引擎。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    planRefresh,
    celSignature,
    TIME_DRIVEN_EDITORS,
    CEL_GRANULAR_EDITORS,
} from '../app/shell/refresh-plan.mjs';

const WORKSPACE = ['canvas', 'layers', 'properties', 'timeline', 'curve'];

test('planRefresh：默认（文档档）全刷，一个都不放过', () => {
    const { run, skip } = planRefresh(WORKSPACE);
    assert.deepEqual(run, WORKSPACE);
    assert.deepEqual(skip, []);
});

test('planRefresh：显式 full:true 与默认同语义', () => {
    const { run, skip } = planRefresh(['palette', 'help', 'timeline'], { full: true });
    assert.deepEqual(run, ['palette', 'help', 'timeline']);
    assert.deepEqual(skip, []);
});

test('planRefresh：时间档只刷「跟时间走」的，其余进 skip', () => {
    const all = ['canvas', 'layers', 'properties', 'timeline', 'curve', 'palette', 'help', 'projects'];
    const { run, skip } = planRefresh(all, { full: false, celChanged: false });
    assert.deepEqual(run, ['canvas', 'properties', 'timeline', 'curve']);
    assert.deepEqual(skip, ['layers', 'palette', 'help', 'projects']);
});

test('planRefresh：纹理变了才带上 layers（缩略图只随纹理变）', () => {
    const withCel = planRefresh(WORKSPACE, { full: false, celChanged: true });
    assert.ok(withCel.run.includes('layers'));
    const noCel = planRefresh(WORKSPACE, { full: false, celChanged: false });
    assert.ok(!noCel.run.includes('layers'));
});

test('planRefresh：时间档不刷陌生编辑器（新增面板默认不跟时间走）', () => {
    const { run, skip } = planRefresh(['doc', 'onion', 'info', 'prefs'], { full: false, celChanged: true });
    assert.deepEqual(run, []);
    assert.deepEqual(skip, ['doc', 'onion', 'info', 'prefs']);
});

test('planRefresh：同一编辑器的多个实例各算一次（分屏）', () => {
    const { run, skip } = planRefresh(['timeline', 'timeline', 'palette'], { full: false, celChanged: false });
    assert.deepEqual(run, ['timeline', 'timeline']);
    assert.deepEqual(skip, ['palette']);
});

test('planRefresh：空值与非字符串被跳过，不会产出空 id', () => {
    const { run, skip } = planRefresh([null, '', undefined, 'timeline', 42], { full: false });
    assert.deepEqual(run, ['timeline']);
    assert.deepEqual(skip, []);
});

test('planRefresh：非数组入参安全返回空计划', () => {
    for (const bad of [null, undefined, 0, 'canvas', {}]) {
        const { run, skip } = planRefresh(bad, { full: false });
        assert.deepEqual(run, []);
        assert.deepEqual(skip, []);
    }
});

test('planRefresh：两个清单互不重叠，且都是稳定集合', () => {
    for (const id of TIME_DRIVEN_EDITORS) assert.ok(!CEL_GRANULAR_EDITORS.has(id), id + ' 不该同时在两个清单里');
    assert.ok(TIME_DRIVEN_EDITORS.has('canvas'));
    assert.ok(TIME_DRIVEN_EDITORS.has('timeline'));
    assert.ok(CEL_GRANULAR_EDITORS.has('layers'));
});

test('celSignature：同一纹理内连续时间变化 → 签名不变', () => {
    const objs = [{ cels: [{ at: 0 }, { at: 0.5 }, { at: 1 }] }];
    const a = celSignature(objs, 0.1);
    const b = celSignature(objs, 0.2);
    const c = celSignature(objs, 0.49);
    assert.equal(a, b);
    assert.equal(b, c);
});

test('celSignature：跨过纹理边界 → 签名变化', () => {
    const objs = [{ cels: [{ at: 0 }, { at: 0.5 }] }];
    assert.notEqual(celSignature(objs, 0.4), celSignature(objs, 0.5));
    // 进到纹理 1 之后就不会再变了（纹理一直生效到下一个切换点）
    assert.equal(celSignature(objs, 0.5), celSignature(objs, 1.2));
});

test('celSignature：第一个纹理之前是 -1，切到纹理 0 就变', () => {
    const objs = [{ cels: [{ at: 1, image: {} }] }];
    assert.equal(celSignature(objs, 0.5), '1,-1');
    assert.equal(celSignature(objs, 1), '1,0');
});

test('celSignature：每个对象各算各的纹理，任一变化都要让签名变', () => {
    const objs = [
        { cels: [{ at: 0 }, { at: 1 }] },
        { cels: [{ at: 0 }, { at: 0.25 }] },
    ];
    // 0.1：两个对象都还在纹理 0
    assert.equal(celSignature(objs, 0.1), '2,0,0');
    // 0.3：第二个对象进入纹理 1，第一个还不动
    assert.equal(celSignature(objs, 0.3), '2,0,1');
    assert.notEqual(celSignature(objs, 0.1), celSignature(objs, 0.3));
});

test('celSignature：对象数变化 → 签名变化（增删对象要重画列表）', () => {
    const one = [{ cels: [{ at: 0 }] }];
    const two = [{ cels: [{ at: 0 }] }, { cels: [{ at: 0 }] }];
    assert.notEqual(celSignature(one, 0), celSignature(two, 0));
});

test('celSignature：空文档与非法入参安全', () => {
    assert.equal(celSignature(null, 0), '0');
    assert.equal(celSignature([], 0), '0');
    assert.equal(celSignature('nope', 0), '0');
    // 没有纹理的空对象：签名仍稳定
    assert.equal(celSignature([{}], 0), '1,-1');
    assert.equal(celSignature([{}], 3), '1,-1');
});

test('celSignature：非法时间按 0 算，不产生 NaN', () => {
    const objs = [{ cels: [{ at: 0 }, { at: 1 }] }];
    assert.equal(celSignature(objs, NaN), celSignature(objs, 0));
    assert.equal(celSignature(objs, undefined), celSignature(objs, 0));
    assert.ok(!celSignature(objs, NaN).includes('NaN'));
});
