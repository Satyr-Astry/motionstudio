// 多选（第 28 批）：对象面板的整块搬计划 + 选择意图在「列表顺序」上的落点。
//
// 这两件事都是纯逻辑，不需要 DOM：blockMovePlan 从 layers.mjs 逻辑导出，
// clickIntent / rangeBetween 来自 core/selection.mjs。面板内部的点击接线靠真机验，
// 这里只钉住「搬哪些、搬去哪、范围怎么截」这类算错就静默出错的部分。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { blockMovePlan } from '../app/editors/layers.mjs';
import { clickIntent, rangeBetween } from '../app/core/selection.mjs';

test('blockMovePlan：多选按原相对次序落位，to 依次顺延', () => {
    const order = ['a', 'b', 'c', 'd', 'e'];
    // 选中 b、d（在 order 里不相邻），整块搬到 c 的位置
    const plan = blockMovePlan(order, ['d', 'b'], 2);
    assert.deepEqual(plan, [
        { id: 'b', to: 2 },
        { id: 'd', to: 3 },
    ]);
});

test('blockMovePlan：只选一个时返回空数组（那是单对象拖拽，走 commitReorder）', () => {
    assert.deepEqual(blockMovePlan(['a', 'b', 'c'], ['b'], 0), []);
    assert.deepEqual(blockMovePlan(['a', 'b', 'c'], [], 0), []);
});

test('blockMovePlan：to 越界时夹紧到末位，不产生越界下标', () => {
    const order = ['a', 'b', 'c'];
    const plan = blockMovePlan(order, ['a', 'b'], 99);
    assert.equal(plan.length, 2);
    assert.ok(plan.every((p) => p.to >= 0 && p.to < order.length));
    assert.deepEqual(plan.map((p) => p.to), [2, 2]);
});

test('blockMovePlan：顺序无关的入参得到同一份计划', () => {
    const order = ['a', 'b', 'c', 'd'];
    assert.deepEqual(blockMovePlan(order, ['c', 'b'], 0), blockMovePlan(order, ['b', 'c'], 0));
});

test('blockMovePlan：moving 里不存在的 id 被忽略，未选中的行不进计划', () => {
    const plan = blockMovePlan(['a', 'b', 'c'], ['b', 'ghost', 'c'], 0);
    assert.deepEqual(plan.map((p) => p.id), ['b', 'c']);
    assert.ok(!plan.some((p) => p.id === 'a'));
});

test('clickIntent + rangeBetween：Shift 连点得到的范围与列表顺序一致', () => {
    const order = ['a', 'b', 'c', 'd', 'e'];
    // 先点 a（锚点），再 Shift+点 d：应覆盖 a..d 四项，且保持列表顺序
    const anchor = 'a';
    const target = 'd';
    assert.equal(clickIntent({ button: 0, shiftKey: true }, false), 'add');
    assert.deepEqual(rangeBetween(order, anchor, target), ['a', 'b', 'c', 'd']);
    // 反向连选也按列表顺序返回，不返回倒序
    assert.deepEqual(rangeBetween(order, 'd', 'a'), ['a', 'b', 'c', 'd']);
});

test('clickIntent：多选态再点已选行是 remove，不会把整批清空', () => {
    assert.equal(clickIntent({ button: 0 }, true), 'promote');
    assert.equal(clickIntent({ button: 0, shiftKey: true }, true), 'remove');
    assert.equal(clickIntent({ button: 0, ctrlKey: true }, true), 'remove');
});
