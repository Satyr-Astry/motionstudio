// 嵌套时间组合（v6 时间图）：父对象的时间通道先把全局时间变形，
// 再把结果作为子对象的输入时间，逐级向叶传递。
//
// 这是「嵌套组」语义的核心断言 —— 父级 scale / offset / loop 要真的驱动子级的
// 画格切换与关键帧推进，而不只是挪动父级自己的矩阵。
//
// 语义（见 app/core/timegraph.mjs 的 applyTime）：
//   raw = (tGlobal - offset) * scale      ← offset 是「延后」，不是「提前」
//   loop / pingpong / clamp 再对 raw 回卷或钳制，span 默认取文档总时长。
// 恒等通道走快路径直接返回全局时间。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createEvaluator } from '../app/core/evaluator.mjs';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

const img = (tag) => ({ width: 10, height: 10, tag });

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
            cels: [{ at: 0, image: null }],
        },
        patch || {},
    );
}

function docOf(objects) {
    return { width: 100, height: 80, fps: 10, duration: 4, objects };
}

function twoLevel(parentTime) {
    const parent = objectOf('p', parentTime ? { time: parentTime } : {});
    const kid = objectOf('k', {
        parentId: 'p',
        cels: [
            { at: 0, image: img('first') },
            { at: 1, image: img('second') },
        ],
    });
    return docOf([kid, parent]);
}

test('无时间通道时，子级局部时间等于全局时间', () => {
    const ev = createEvaluator(twoLevel(null));
    near(ev.localTime('k', 0.25), 0.25);
    near(ev.localTime('p', 0.25), 0.25);
});

test('父级 scale=2 让子级时间跑两倍快', () => {
    const ev = createEvaluator(twoLevel({ scale: 2 }));
    near(ev.localTime('k', 0.5), 1);
    assert.equal(ev.imageOf('k', 0.5).tag, 'second');
    near(ev.localTime('k', 0.25), 0.5);
    assert.equal(ev.imageOf('k', 0.25).tag, 'first');
});

test('父级 offset=0.5 把子级整体延后', () => {
    const ev = createEvaluator(twoLevel({ offset: 0.5 }));
    near(ev.localTime('k', 0.5), 0);
    near(ev.localTime('k', 1.5), 1);
    assert.equal(ev.imageOf('k', 1.5).tag, 'second');
});

test('父级 loop 让子级时间回卷', () => {
    const ev = createEvaluator(twoLevel({ mode: 'loop', from: 0, to: 1 }));
    near(ev.localTime('k', 2.5), 0.5);
    assert.equal(ev.imageOf('k', 2.5).tag, 'first');
    near(ev.localTime('k', 3.5), 0.5);
});

test('父子各自的时间通道逐级叠加（不覆盖）', () => {
    const kid = objectOf('k', {
        parentId: 'p',
        time: { scale: 3 },
        cels: [
            { at: 0, image: img('first') },
            { at: 1, image: img('second') },
        ],
    });
    const parent = objectOf('p', { time: { scale: 2 } });
    const ev = createEvaluator(docOf([kid, parent]));
    near(ev.localTime('k', 0.1), 0.6);
});

test('三层：祖父 offset → 父 scale → 子自身 scale', () => {
    const grand = objectOf('g', { time: { offset: 1 } });
    const parent = objectOf('p', { parentId: 'g', time: { scale: 2 } });
    const kid = objectOf('k', {
        parentId: 'p',
        time: { scale: 0.5 },
        cels: [{ at: 0, image: img('first') }],
    });
    const ev = createEvaluator(docOf([kid, parent, grand]));
    near(ev.localTime('k', 3), 2);
});

test('父与子在同一个全局时刻得到同一个局部时间', () => {
    const parent = objectOf('p', { time: { scale: 2 } });
    const kid = objectOf('k', { parentId: 'p' });
    const ev = createEvaluator(docOf([kid, parent]));
    near(ev.localTime('k', 0.3), ev.localTime('p', 0.3));
});

test('环引用不致死循环，链在原处截断', () => {
    const a = objectOf('a', { parentId: 'b' });
    const b = objectOf('b', { parentId: 'a', time: { offset: 0.5 } });
    const ev = createEvaluator(docOf([a, b]));
    const t = ev.localTime('a', 0);
    assert.ok(Number.isFinite(t), '环引用下仍要返回有限数');
});

test('非法时间通道退化为安全值（不抛异常）', () => {
    const ev = createEvaluator(twoLevel({ scale: 0 }));
    near(ev.localTime('k', 0.5), 0);
    const ev2 = createEvaluator(twoLevel({ mode: 'nope' }));
    near(ev2.localTime('k', 0.5), 0.5);
});

test('image() / cel() 对外也走局部时间（不是全局时间）', () => {
    const ev = createEvaluator(twoLevel({ scale: 2 }));
    assert.equal(ev.imageOf('k', 0.5).tag, 'second');
    assert.equal(ev.celAt('k', 0.5).at, 1);
});