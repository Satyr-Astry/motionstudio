import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createArea,
  splitNode,
  joinNode,
  swapEditors,
  findNode,
  walkAreas,
  serialize,
  deserialize,
} from '../app/shell/areas.mjs';

function deepFreeze(o) {
  if (o && typeof o === 'object') {
    for (const k of Object.keys(o)) deepFreeze(o[k]);
    Object.freeze(o);
  }
  return o;
}

const snap = (x) => JSON.stringify(x);
const count = (root) => walkAreas(root).length;
const ids = (root) => walkAreas(root).map((a) => a.id);

/** 固定 id 的树，便于断言结构与互逆 */
function fixture() {
  return {
    type: 'split',
    dir: 'row',
    children: [
      createArea('canvas', 'A'),
      {
        type: 'split',
        dir: 'col',
        children: [createArea('timeline', 'B'), createArea('curve', 'C')],
      },
    ],
  };
}

test('createArea 生成 area 节点，带非空 id 与 editor', () => {
  const a = createArea('timeline');
  assert.equal(a.type, 'area');
  assert.equal(a.editor, 'timeline');
  assert.equal(typeof a.id, 'string');
  assert.ok(a.id.length > 0);
  assert.notEqual(createArea('timeline').id, a.id, '两次创建 id 必须不同');
});

test('createArea 支持显式 id 与默认 editor', () => {
  assert.deepStrictEqual(createArea('curve', 'fixed-1'), { type: 'area', id: 'fixed-1', editor: 'curve' });
  assert.equal(createArea().editor, 'timeline');
});

test('findNode 找 area / 找不到返回 null', () => {
  const root = fixture();
  assert.equal(findNode(root, 'C').editor, 'curve');
  assert.equal(findNode(root, 'A').id, 'A');
  assert.equal(findNode(root, 'nope'), null);
  assert.equal(findNode(null, 'A'), null);
});

test('walkAreas 按遍历顺序返回全部区域，空/单节点也正常', () => {
  assert.deepStrictEqual(ids(fixture()), ['A', 'B', 'C']);
  assert.equal(count(createArea('canvas', 'solo')), 1);
  assert.equal(walkAreas(null).length, 0);
});

test('splitNode 让区域数 +1，同 editor，保留原 id 与顺序', () => {
  const root = createArea('timeline', 'A');
  const next = splitNode(root, 'A', 'row');
  assert.equal(next.type, 'split');
  assert.equal(next.dir, 'row');
  assert.equal(count(next), 2);
  assert.equal(next.children[0].id, 'A', '原区域保留 id 且在首位');
  assert.equal(next.children[1].editor, 'timeline', '一分为二的两个区域 editor 相同');
  assert.notEqual(next.children[1].id, 'A');
});

test('splitNode 用 dir=col 产生竖向切分', () => {
  const next = splitNode(createArea('curve', 'A'), 'A', 'col');
  assert.equal(next.dir, 'col');
  assert.equal(count(next), 2);
});

test('splitNode 在深层嵌套里只改动命中路径（兄弟分支共享引用）', () => {
  const root = fixture();
  const before = snap(root);
  const next = splitNode(root, 'B', 'row');
  assert.equal(snap(root), before, 'splitNode 不得修改入参');
  assert.equal(count(next), 4);
  assert.equal(next.children[0], root.children[0], '未改动的分支共享引用');
  assert.notEqual(next, root);
  const inner = next.children[1];
  assert.equal(inner.type, 'split');
  assert.equal(inner.dir, 'col');
  const fresh = inner.children[0].children[1].id;
  assert.deepStrictEqual(ids(next), ['A', 'B', fresh, 'C']);
});

test('splitNode 找不到 id / 入参非法时返回原树（同一引用，不抛异常）', () => {
  const root = fixture();
  assert.equal(splitNode(root, 'nope', 'row'), root);
  assert.equal(splitNode(root, undefined, 'row'), root);
  assert.equal(splitNode(null, 'A', 'row'), null);
  assert.equal(splitNode(root, 'A', 'row') === root, false, '合法 id 应返回新树');
});

test('joinNode 撤销 split（split→join 回原树，deepEqual）', () => {
  const root = createArea('timeline', 'A');
  const split = splitNode(root, 'A', 'row');
  const joined = joinNode(split, split.children[1].id);
  assert.deepStrictEqual(joined, root);
  assert.equal(count(joined), 1);
});

test('joinNode 保留 size/grow：split 承接布局，上提后还原', () => {
  const root = { type: 'area', id: 'A', editor: 'timeline', size: 2, grow: false };
  const split = splitNode(root, 'A', 'col');
  assert.equal(split.size, 2);
  assert.equal(split.grow, false);
  assert.equal(split.children[0].size, undefined);
  assert.deepStrictEqual(joinNode(split, split.children[1].id), root);
});

test('只剩一个区域时 joinNode 返回原树', () => {
  const root = createArea('canvas', 'only');
  assert.equal(joinNode(root, 'only'), root);
  assert.equal(count(joinNode(root, 'only')), 1);
});

test('joinNode 找不到 id 时返回原树', () => {
  const root = fixture();
  assert.equal(joinNode(root, 'nope'), root);
  assert.equal(joinNode(root, null), root);
  assert.equal(joinNode(null, 'A'), null);
});

test('joinNode 在 3 子 split 中只减一，不触发上提', () => {
  const root = {
    type: 'split',
    dir: 'row',
    children: [createArea('canvas', 'A'), createArea('timeline', 'B'), createArea('curve', 'C')],
  };
  const next = joinNode(root, 'B');
  assert.equal(next.type, 'split');
  assert.equal(next.dir, 'row');
  assert.equal(next.children.length, 2);
  assert.deepStrictEqual(ids(next), ['A', 'C']);
  assert.equal(ids(root).includes('B'), true, '入参必须保持原样');
});

test('深层嵌套 join 逐级上提：3 层 → 单区域，id 一路保留', () => {
  // split(row, [A, split(col, [B, split(row, [C, D])])])
  let root = {
    type: 'split',
    dir: 'row',
    children: [
      createArea('canvas', 'A'),
      {
        type: 'split',
        dir: 'col',
        children: [
          createArea('timeline', 'B'),
          { type: 'split', dir: 'row', children: [createArea('curve', 'C'), createArea('canvas', 'D')] },
        ],
      },
    ],
  };
  assert.equal(count(root), 4);

  root = joinNode(root, 'D'); // C 上提到内层 row 的位置
  assert.equal(count(root), 3);
  assert.deepStrictEqual(ids(root), ['A', 'B', 'C']);

  root = joinNode(root, 'C'); // B 上提到 col 的位置
  assert.equal(root.type, 'split');
  assert.equal(root.dir, 'row');
  assert.equal(root.children.length, 2);
  assert.deepStrictEqual(ids(root), ['A', 'B']);

  root = joinNode(root, 'B'); // A 上提为根
  assert.equal(root.type, 'area');
  assert.equal(root.id, 'A');
  assert.equal(count(root), 1);
});

test('swapEditors 交换两个区域的 editor，id 不动', () => {
  const root = fixture();
  const next = swapEditors(root, 'A', 'C');
  assert.equal(findNode(next, 'A').editor, 'curve');
  assert.equal(findNode(next, 'C').editor, 'canvas');
  assert.equal(findNode(next, 'B').editor, 'timeline', '无关区域不变');
  assert.deepStrictEqual(ids(next), ['A', 'B', 'C']);
  assert.equal(findNode(root, 'A').editor, 'canvas', 'swap 不得修改入参');
});

test('swapEditors 连续交换两次复原', () => {
  const root = fixture();
  const once = swapEditors(root, 'A', 'B');
  assert.equal(findNode(once, 'A').editor, 'timeline');
  const twice = swapEditors(once, 'A', 'B');
  assert.deepStrictEqual(twice, root);
});

test('swapEditors 有任一 id 不存在时返回原树', () => {
  const root = fixture();
  assert.equal(swapEditors(root, 'A', 'ghost'), root);
  assert.equal(swapEditors(root, 'ghost', 'B'), root);
  assert.equal(swapEditors(root, null, 'B'), root);
});

test('swapEditors 同 id 是空操作', () => {
  const root = fixture();
  assert.equal(swapEditors(root, 'A', 'A'), root);
});

test('serialize/deserialize 互逆（含嵌套 split 与布局字段）', () => {
  const root = {
    type: 'split',
    dir: 'col',
    size: 3,
    children: [
      createArea('canvas', 'A'),
      {
        type: 'split',
        dir: 'row',
        grow: true,
        children: [createArea('timeline', 'B'), createArea('curve', 'C')],
      },
    ],
  };
  const back = deserialize(JSON.parse(JSON.stringify(serialize(root))));
  assert.deepStrictEqual(back, root);
  assert.deepStrictEqual(serialize(back), serialize(root));
});

test('serialize 产出可直接 JSON.stringify，且不带 undefined 键', () => {
  const s = serialize(createArea('timeline', 'A'));
  assert.deepStrictEqual(s, { type: 'area', id: 'A', editor: 'timeline' });
  assert.equal(Object.prototype.hasOwnProperty.call(s, 'size'), false);
  assert.equal(JSON.parse(JSON.stringify(s)).id, 'A');
});

test('serialize/deserialize 对多次 split 后的树仍互逆', () => {
  let root = createArea('canvas', 'A');
  root = splitNode(root, 'A', 'row');
  root = splitNode(root, root.children[1].id, 'col');
  root = splitNode(root, 'A', 'col');
  const back = deserialize(JSON.parse(JSON.stringify(serialize(root))));
  assert.deepStrictEqual(back, root);
  assert.equal(count(back), 4);
});

test('deserialize 遇到非法结构返回 null（不抛异常）', () => {
  assert.equal(deserialize(null), null);
  assert.equal(deserialize('nope'), null);
  assert.equal(deserialize([]), null);
  assert.equal(deserialize({ type: 'area' }), null);
  assert.equal(deserialize({ type: 'split', children: [] }), null);
  assert.equal(deserialize({ type: 'split', children: [{ type: 'area' }] }), null);
  assert.equal(deserialize({ type: 'weird' }), null);
  assert.equal(serialize(null), null);
});

test('全部操作对深冻结的树都不抛异常、不改入参', () => {
  const root = deepFreeze(fixture());
  const before = snap(root);
  const split = splitNode(root, 'B', 'row');
  const joined = joinNode(split, split.children[1].children[0].children[1].id);
  const swapped = swapEditors(root, 'A', 'B');
  const ser = serialize(root);
  assert.equal(snap(root), before, '冻结树在全部操作后必须保持不变');
  assert.doesNotThrow(() => deserialize(ser));
  assert.equal(count(split), 4);
  assert.equal(count(joined), 3);
  assert.equal(findNode(swapped, 'A').editor, 'timeline');
});

test('split → join 交叉操作不产生空节点或重复 id', () => {
  let root = createArea('timeline', 'A');
  root = splitNode(root, 'A', 'row');
  const newId = root.children[1].id;
  root = splitNode(root, newId, 'col');
  assert.equal(count(root), 3);
  const list = ids(root);
  assert.equal(new Set(list).size, list.length, 'id 必须唯一');
  root = joinNode(root, newId);
  assert.equal(count(root), 2);
  assert.equal(root.type, 'split');
  root = joinNode(root, root.children[1].id);
  assert.deepStrictEqual(root, createArea('timeline', 'A'));
});
