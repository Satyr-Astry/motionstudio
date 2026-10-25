import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    isPrimaryButton,
    clickIntent,
    rangeBetween,
    invertSet,
    toggleIn,
    nextAnchor,
    moveInSelection,
    pruneSelection,
} from '../app/core/selection.mjs';

const L = { button: 0 };
const ev = (patch) => Object.assign({ button: 0 }, patch);

test('clickIntent：无修饰 → 未选则 single、已选则 promote', () => {
    assert.equal(clickIntent(L, false), 'single');
    // 点在已选中的上面不清空其它，只把主选中挪过来（Blender 行为）
    assert.equal(clickIntent(L, true), 'promote');
});

test('clickIntent：Shift / Ctrl / Cmd 都是累加-移出', () => {
    for (const key of ['shiftKey', 'ctrlKey', 'metaKey']) {
        assert.equal(clickIntent(ev({ [key]: true }), false), 'add', key + ' 未选 → add');
        assert.equal(clickIntent(ev({ [key]: true }), true), 'remove', key + ' 已选 → remove');
    }
});

test('clickIntent：Shift+Alt → range（连选，优先级高于累加）', () => {
    assert.equal(clickIntent(ev({ shiftKey: true, altKey: true }), false), 'range');
    assert.equal(clickIntent(ev({ shiftKey: true, altKey: true }), true), 'range');
    // Ctrl+Alt 不是连选，仍走累加
    assert.equal(clickIntent(ev({ ctrlKey: true, altKey: true }), false), 'add');
});

test('clickIntent：非左键忽略，不改选择', () => {
    assert.equal(clickIntent(ev({ button: 2 }), false), 'ignore');
    assert.equal(clickIntent(ev({ button: 1 }), false), 'ignore');
    assert.equal(clickIntent(ev({ button: 2, shiftKey: true }), true), 'ignore');
    // 缺省 button 视为左键
    assert.equal(clickIntent({}, false), 'single');
    assert.equal(isPrimaryButton(null), true);
});

test('rangeBetween：正序、倒序都含两端', () => {
    const ids = ['a', 'b', 'c', 'd', 'e'];
    assert.deepEqual(rangeBetween(ids, 'b', 'd'), ['b', 'c', 'd']);
    assert.deepEqual(rangeBetween(ids, 'd', 'b'), ['b', 'c', 'd']);
});

test('rangeBetween：同点退化成单个；任一端缺失也只给目标', () => {
    const ids = ['a', 'b', 'c'];
    assert.deepEqual(rangeBetween(ids, 'b', 'b'), ['b']);
    assert.deepEqual(rangeBetween(ids, 'zz', 'b'), ['b']);
    assert.deepEqual(rangeBetween(ids, 'a', 'zz'), []);
    assert.deepEqual(rangeBetween([], 'a', 'b'), []);
});

test('invertSet：取补集并保持 all 的顺序', () => {
    assert.deepEqual(invertSet(['a', 'b', 'c'], ['b']), ['a', 'c']);
    assert.deepEqual(invertSet(['a', 'b'], []), ['a', 'b']);
    assert.deepEqual(invertSet(['a', 'b'], ['a', 'b']), []);
    // sel 里有 all 之外的 id 不影响结果
    assert.deepEqual(invertSet(['a'], ['x']), ['a']);
});

test('toggleIn：有则删、无则加，顺序保持', () => {
    assert.deepEqual(toggleIn(['a', 'b'], 'c'), ['a', 'b', 'c']);
    assert.deepEqual(toggleIn(['a', 'b', 'c'], 'b'), ['a', 'c']);
    assert.deepEqual(toggleIn([], 'a'), ['a']);
    // 不改原数组
    const src = ['a'];
    toggleIn(src, 'b');
    assert.deepEqual(src, ['a']);
});

test('nextAnchor：反选掉主选中后退到集合里最早的一颗', () => {
    assert.equal(nextAnchor([]), null);
    assert.equal(nextAnchor(['b', 'c']), 'b');
    // 主选中被反选掉：调用方拿新集合求锚点
    assert.equal(nextAnchor(invertSet(['a', 'b', 'c'], ['a'])), 'b');
});

test('moveInSelection：整体平移一格，贴边不动', () => {
    const ids = ['a', 'b', 'c', 'd'];
    assert.deepEqual(moveInSelection(ids, ['b'], 1), ['c']);
    assert.deepEqual(moveInSelection(ids, ['c'], -1), ['b']);
    assert.deepEqual(moveInSelection(ids, ['b', 'c'], 1), ['c', 'd']);
    // 到尾部不动
    assert.deepEqual(moveInSelection(ids, ['d'], 1), ['d']);
    // 到头部不动
    assert.deepEqual(moveInSelection(ids, ['a'], -1), ['a']);
    // 空集 / 元素已不在全集里
    assert.deepEqual(moveInSelection(ids, [], 1), []);
    assert.deepEqual(moveInSelection(ids, ['zz'], 1), []);
});

test('pruneSelection：丢掉已消失的 id，保持顺序', () => {
    assert.deepEqual(pruneSelection(['a', 'c'], ['a', 'b', 'c']), ['a', 'c']);
    assert.deepEqual(pruneSelection(['a'], ['b']), []);
    assert.deepEqual(pruneSelection([], ['a']), []);
});
