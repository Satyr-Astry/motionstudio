// L4 层级键盘操作的纯函数契约。
// 这些函数只算「目标父级 + 目标全局下标」，真正改文档的接线在 layers.mjs（Lead 接），
// 所以这里能把落点语义钉死，而不依赖任何 DOM。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    siblingsOf,
    subtreeEndIndex,
    siblingMoveTarget,
    demoteTarget,
    promoteTarget,
    layerKeyTarget,
    layerKeyFromEvent,
} from '../app/core/layer-order.mjs';
import { SHORTCUT_GROUPS } from '../app/editors/help.mjs';

// 下标 0 = 最上层；子对象连续排在父之后（与 doc-model 的约定一致）
//   0 a
//   1   a1
//   2   a2
//   3 b
//   4   b1
//   5 c
const TREE = [
    { id: 'a' },
    { id: 'a1', parentId: 'a' },
    { id: 'a2', parentId: 'a' },
    { id: 'b' },
    { id: 'b1', parentId: 'b' },
    { id: 'c' },
];

test('siblingsOf：只收同一父级的对象，保持数组顺序', () => {
    assert.deepEqual(siblingsOf(TREE, null).map((o) => o.id), ['a', 'b', 'c']);
    assert.deepEqual(siblingsOf(TREE, 'a').map((o) => o.id), ['a1', 'a2']);
    assert.deepEqual(siblingsOf(TREE, 'z'), []);
    // undefined / '' / null 都归一成根层，否则存档里的空串父级会造出一个隐形分组
    assert.deepEqual(siblingsOf([{ id: 'r' }, { id: 's', parentId: '' }], null).map((o) => o.id), ['r', 's']);
});

test('subtreeEndIndex：含自身的子树末位；不是后代就停；查不到返回 -1', () => {
    assert.equal(subtreeEndIndex(TREE, 'a'), 2);
    assert.equal(subtreeEndIndex(TREE, 'b'), 4);
    assert.equal(subtreeEndIndex(TREE, 'b1'), 4);
    assert.equal(subtreeEndIndex(TREE, 'c'), 5);
    assert.equal(subtreeEndIndex(TREE, 'nope'), -1);
    // 两层嵌套：x 的子树一直延到末位
    const deep = [{ id: 'x' }, { id: 'x1', parentId: 'x' }, { id: 'x11', parentId: 'x1' }];
    assert.equal(subtreeEndIndex(deep, 'x'), 2);
    assert.equal(subtreeEndIndex(deep, 'x11'), 2);
});

test('同级上移/下移：与相邻兄弟交换，首尾不动作', () => {
    // b 夹在 a 与 c 之间
    assert.deepEqual(siblingMoveTarget(TREE, 'b', -1), { parentId: null, index: 0 });
    assert.deepEqual(siblingMoveTarget(TREE, 'b', 1), { parentId: null, index: 5 });
    // 首位上移、末位下移都不动作
    assert.equal(siblingMoveTarget(TREE, 'a', -1), null);
    assert.equal(siblingMoveTarget(TREE, 'c', 1), null);
    // 子级同一套语义，且不跨越父级（a1 不会跑到 b 上面去）
    assert.equal(siblingMoveTarget(TREE, 'a1', -1), null);
    assert.deepEqual(siblingMoveTarget(TREE, 'a2', -1), { parentId: 'a', index: 1 });
    assert.deepEqual(siblingMoveTarget(TREE, 'a1', 1), { parentId: 'a', index: 2 });
    // 不存在的 id
    assert.equal(siblingMoveTarget(TREE, 'nope', 1), null);
});

test('降级：成为前一个兄弟的最后一个子对象；首兄弟不动作', () => {
    // b 的前一个兄弟是 a，a 的子树到下标 2，所以插到 3
    assert.deepEqual(demoteTarget(TREE, 'b'), { parentId: 'a', index: 3 });
    // c 的前一个兄弟是 b，b 的子树到下标 4，所以插到 5
    assert.deepEqual(demoteTarget(TREE, 'c'), { parentId: 'b', index: 5 });
    // 首兄弟没有「前一个兄弟」
    assert.equal(demoteTarget(TREE, 'a'), null);
    assert.equal(demoteTarget(TREE, 'a1'), null);
    assert.equal(demoteTarget(TREE, 'nope'), null);
});

test('升级：成为父的兄弟、紧插在父之后；根层不动作', () => {
    assert.deepEqual(promoteTarget(TREE, 'a1'), { parentId: null, index: 1 });
    assert.deepEqual(promoteTarget(TREE, 'b1'), { parentId: null, index: 4 });
    // 已经在根层
    assert.equal(promoteTarget(TREE, 'a'), null);
    assert.equal(promoteTarget(TREE, 'nope'), null);
    // 祖父不是根时，升级后落到祖父下面
    const nested = [
        { id: 'g' },
        { id: 'p', parentId: 'g' },
        { id: 'k', parentId: 'p' },
        { id: 'tail' },
    ];
    assert.deepEqual(promoteTarget(nested, 'k'), { parentId: 'g', index: 2 });
});

test('layerKeyTarget：四个方向走同一条落点语义，未知键返回 null', () => {
    assert.deepEqual(layerKeyTarget(TREE, 'b', 'up'), siblingMoveTarget(TREE, 'b', -1));
    assert.deepEqual(layerKeyTarget(TREE, 'b', 'down'), siblingMoveTarget(TREE, 'b', 1));
    // 方向按「在树上走」：→ 往里（缩进成子对象），← 往外（提升为父的兄弟）。
    // 注意这与 demote/promote 的命名顺序相反 —— 接反过一次，真机读数抓到的。
    assert.deepEqual(layerKeyTarget(TREE, 'b', 'right'), demoteTarget(TREE, 'b'));
    assert.deepEqual(layerKeyTarget(TREE, 'b1', 'left'), promoteTarget(TREE, 'b1'));
    assert.equal(layerKeyTarget(TREE, 'b', 'space'), null);
});

test('layerKeyFromEvent：只认「单独按 Alt + 方向键」', () => {
    assert.equal(layerKeyFromEvent({ altKey: true, key: 'ArrowUp' }), 'up');
    assert.equal(layerKeyFromEvent({ altKey: true, key: 'ArrowDown' }), 'down');
    assert.equal(layerKeyFromEvent({ altKey: true, key: 'ArrowLeft' }), 'left');
    assert.equal(layerKeyFromEvent({ altKey: true, key: 'ArrowRight' }), 'right');
    // 没有 Alt / 混了别的修饰键 / 别的键 都不算层级键（否则会抢走画板的 Ctrl+方向与系统的 Alt+Tab）
    assert.equal(layerKeyFromEvent({ key: 'ArrowUp' }), null);
    assert.equal(layerKeyFromEvent({ altKey: true, ctrlKey: true, key: 'ArrowUp' }), null);
    assert.equal(layerKeyFromEvent({ altKey: true, shiftKey: true, key: 'ArrowUp' }), null);
    assert.equal(layerKeyFromEvent({ altKey: true, key: 'a' }), null);
    assert.equal(layerKeyFromEvent(null), null);
});

test('帮助表：对象层级组存在，两条键位与实现同源', () => {
    const layer = SHORTCUT_GROUPS.find((g) => g.id === 'layer');
    assert.ok(layer, 'SHORTCUT_GROUPS 缺 layer 组');
    assert.equal(layer.items.length, 2, '层级组应为两条（同级换位 / 降级升级）');
    const keys = layer.items.map((it) => it.keys).join(' | ');
    assert.match(keys, /Alt\+↑/, '缺少「Alt+↑/↓」');
    assert.match(keys, /Alt\+←/, '缺少「Alt+←/→」');
    assert.match(keys, /Alt\+↓/);
    assert.match(keys, /Alt\+→/);
    // 每条都要有中文动作名，不许空着（表是唯一数据源，浮层直接渲染它）
    for (const it of layer.items) assert.ok(it.name && it.name.length >= 3, '层级键缺动作名：' + JSON.stringify(it));
});
