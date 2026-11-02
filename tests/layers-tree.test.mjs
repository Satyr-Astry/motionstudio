// 对象面板（父子树）的行序与叠放列表的落点判定 —— 只测纯逻辑。
// 行序的唯一实现在 app/core/hierarchy.mjs（深度优先 + 同级按 drawOrder）；
// 落点判定在 app/editors/layers.mjs。两边都是纯函数，Node 能直接 import：DOM 调用全在 mount() 内。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { treeOrder, collectSubtree } from '../app/core/hierarchy.mjs';
import { dropZone, dropVerdict, dropLineTop } from '../app/editors/layers.mjs';
import { DEFAULT_LOCALE, setLocale } from '../app/i18n/index.mjs';

const obj = (id, parentId) => ({ id, parentId, name: id });
/** 造 doc：objects 按入参顺序；给了 drawOrder 就用它当同级先后（index 0 = 最上层）。 */
const docOf = (objects, drawOrder) => (drawOrder ? { objects, drawOrder } : { objects });
const rowIds = (rows) => rows.map((r) => r.obj.id);
const rowDepths = (rows) => rows.map((r) => r.depth);

test('treeOrder：三层嵌套按父子链深度优先，父在前、子紧随', () => {
    const rows = treeOrder(docOf([obj('a'), obj('b'), obj('c', 'b'), obj('d', 'c')]));
    assert.deepEqual(rowIds(rows), ['a', 'b', 'c', 'd']);
    assert.deepEqual(rowDepths(rows), [0, 0, 1, 2]);
});

test('treeOrder：子对象在数组里排在父前面，也要拉到父后面（L2 的修复点）', () => {
    const rows = treeOrder(docOf([obj('c', 'b'), obj('b'), obj('a')]));
    assert.deepEqual(rowIds(rows), ['b', 'c', 'a']);
    assert.deepEqual(rowDepths(rows), [0, 1, 0]);
});

test('treeOrder：parentId 指向不存在的对象时当根处理，不丢行', () => {
    const rows = treeOrder(docOf([obj('a', 'gone'), obj('b')]));
    assert.deepEqual(rowIds(rows), ['a', 'b']);
    assert.equal(rows[0].depth, 0);
});

test('treeOrder：脏数据成环时不重复也不丢行', () => {
    const rows = treeOrder(docOf([obj('a', 'b'), obj('b', 'a')]));
    assert.equal(rows.length, 2);
    assert.deepEqual(new Set(rowIds(rows)), new Set(['a', 'b']));
});

test('treeOrder：空输入返回空数组，不抛', () => {
    assert.deepEqual(treeOrder(null), []);
    assert.deepEqual(treeOrder({ objects: [] }), []);
});

// v11 的行序回归点：叠放面板上移一层只改 doc.drawOrder（ctx.moveDrawOrder），从不碰 doc.objects。
// 若行序仍按数组顺序，用户会看到「叠放动了、父子面板没动」——两套排序打架。
test('treeOrder：同级行序跟随 drawOrder，而不是 objects 数组顺序', () => {
    // 数组顺序 p1 → k2 → k1 → p2（根里 p1 在前、p1 的孩子里 k2 在前）
    // 叠放顺序 p2 盖过 p1、k1 盖过 k2 —— 根与子两级都和数组顺序相反
    const objects = [obj('p1'), obj('k2', 'p1'), obj('k1', 'p1'), obj('p2')];
    const drawOrder = ['p2', 'k1', 'k2', 'p1'];
    const rows = treeOrder(docOf(objects, drawOrder));

    assert.deepEqual(rowIds(rows), ['p2', 'p1', 'k1', 'k2'], '两级都按 drawOrder 排');
    assert.deepEqual(rowDepths(rows), [0, 0, 1, 1], '排序没有打乱层级缩进');
    assert.deepEqual(rows.map((r) => r.parentId), [null, null, 'p1', 'p1']);
    // 判别性：这条用例只有两套顺序真的不同时才证明得了东西
    // （按数组顺序 DFS 会得到 p1, k2, k1, p2）
    assert.notDeepEqual(rowIds(rows), objects.map((o) => o.id));
});

test('collectSubtree：自身 + 全部后代，不含旁支', () => {
    const doc = docOf([obj('a'), obj('b', 'a'), obj('c', 'b'), obj('x')]);
    assert.deepEqual(collectSubtree(doc, 'a'), ['a', 'b', 'c']);
    assert.deepEqual(collectSubtree(doc, 'x'), ['x']);
    assert.deepEqual(collectSubtree(doc, 'nope'), []);
});

// 守卫：layers.mjs 里不该再长回第二套树序 / 后代判定（行序只有 core/hierarchy 一处）
test('layers.mjs 不再自带树序实现（行序只有 core/hierarchy 一处）', () => {
    const src = readFileSync(new URL('../app/editors/layers.mjs', import.meta.url), 'utf8');
    assert.equal(/export\s+function\s+treeOrder/.test(src), false, 'treeOrder 只该在 core/hierarchy');
    assert.equal(/isDescendantId|MAX_TREE_DEPTH/.test(src), false, '后代判定只该用 core 的 isDescendant');
});

// v11：叠放列表改成两区（上/下），「投进去」这一区下线 —— 改层级归父子面板
test('dropZone：上半插到之上、下半插到之下，量不到几何时当作下半', () => {
    assert.equal(dropZone(0), 'above');
    assert.equal(dropZone(0.2), 'above');
    assert.equal(dropZone(0.49), 'above');
    assert.equal(dropZone(0.5), 'below');
    assert.equal(dropZone(0.8), 'below');
    assert.equal(dropZone(0.99), 'below');
    // 越界钳到 0–1，NaND 当作下半（插到它下面是最保守的落点）
    assert.equal(dropZone(-2), 'above');
    assert.equal(dropZone(9), 'below');
    assert.equal(dropZone(NaN), 'below');
});

test('dropVerdict：叠放只重排，只拒绝「拖到自身」', () => {
    const all = [obj('a'), obj('b', 'a'), obj('c', 'b')];
    assert.equal(dropVerdict(all, 'a', 'a').ok, false);
    // 拒绝原因现在是词条（`layers.drop.self`），两种语言都要说出来 —— 只断「有话说」会假绿
    assert.match(dropVerdict(all, 'a', 'a').reason, /itself/);
    try {
        setLocale('zh-Hans');
        assert.match(dropVerdict(all, 'a', 'a').reason, /自身/);
    } finally {
        setLocale(DEFAULT_LOCALE);
    }
    // 拖到自己的后代在叠放里是合法的（只换图层顺序，不动 parentId）
    assert.equal(dropVerdict(all, 'a', 'c').ok, true);
    assert.equal(dropVerdict(all, 'c', 'a').ok, true);
    assert.equal(dropVerdict(all, null, 'a').ok, false);
    assert.equal(dropVerdict(all, 'a', null).ok, false);
});

// 插入线坐标（用户报的「列表下滚后插入线留在滚动前的位置」）
test('dropLineTop：未滚动时就是「行边 - 列表顶 - 1」', () => {
    assert.equal(dropLineTop(100, 128, 50, 0, 'after'), 77);
    assert.equal(dropLineTop(100, 128, 50, 0, 'before'), 49);
});

test('dropLineTop：滚动后必须加上 scrollTop，否则线会留在滚动前的位置', () => {
    // 同一个行、同一个视口位置，滚了 240px 之后它在内容里就高了 240px
    assert.equal(dropLineTop(100, 128, 50, 240, 'after'), 317);
    assert.equal(dropLineTop(100, 128, 50, 240, 'before'), 289);
    // 差值恒等于 scrollTop，与行列位置无关
    const a = dropLineTop(300, 328, 50, 0, 'after');
    const b = dropLineTop(300, 328, 50, 512, 'after');
    assert.equal(b - a, 512);
});

test('dropLineTop：非法/缺失输入不产生 NaN，且不给出负数 top', () => {
    assert.equal(dropLineTop(10, 20, 50, 0, 'before'), 0);
    assert.equal(dropLineTop(NaN, 20, 50, 0, 'after'), 0);
    assert.equal(dropLineTop(100, 128, 50, undefined, 'after'), 77);
});
