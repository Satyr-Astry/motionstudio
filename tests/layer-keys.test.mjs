import test from 'node:test';
import assert from 'node:assert/strict';

import {
    installLayerKeys,
    isTypingTarget,
    resolveMove,
} from '../app/editors/layer-keys.mjs';

// 文档对象数组的顺序就是层序（前面 = 更靠上层），parentId 指向父对象。
function doc() {
    return [
        { id: 'a', parentId: null },
        { id: 'a1', parentId: 'a' },
        { id: 'a2', parentId: 'a' },
        { id: 'b', parentId: null },
        { id: 'c', parentId: null },
    ];
}

test('resolveMove：上移取「前一个兄弟」并插在它之前', () => {
    assert.deepEqual(resolveMove(doc(), 'c', 'up'), { mode: 'before', targetId: 'b' });
});

test('resolveMove：下移取「后一个兄弟」并插在它整棵子树之后', () => {
    // a 有俩孩子，b 下移时要跨过 a 的整棵子树 —— moveSubtreeDoc 的 after 就是「目标子树之后」
    assert.deepEqual(resolveMove(doc(), 'b', 'down'), { mode: 'after', targetId: 'c' });
});

test('resolveMove：缩进取上一个兄弟做父', () => {
    assert.deepEqual(resolveMove(doc(), 'c', 'right'), { mode: 'into', targetId: 'b' });
});

test('resolveMove：提升以父为目标、模式是 after（落点即「父之后」）', () => {
    assert.deepEqual(resolveMove(doc(), 'a2', 'left'), { mode: 'after', targetId: 'a' });
});

test('resolveMove：到边界一律返回 null，不猜', () => {
    // 首个根对象没有上一个兄弟
    assert.equal(resolveMove(doc(), 'a', 'up'), null);
    // 最后一个根对象没有下一个兄弟
    assert.equal(resolveMove(doc(), 'c', 'down'), null);
    // 首个兄弟没有「上一个兄弟」可当父
    assert.equal(resolveMove(doc(), 'a', 'right'), null);
    // 已经是根层，没有父可提升
    assert.equal(resolveMove(doc(), 'b', 'left'), null);
});

test('resolveMove：id 不存在、数组为空、键名未知都返回 null', () => {
    assert.equal(resolveMove(doc(), 'nope', 'up'), null);
    assert.equal(resolveMove([], 'a', 'up'), null);
    assert.equal(resolveMove(null, 'a', 'up'), null);
    assert.equal(resolveMove(doc(), 'b', 'space'), null);
});

test('resolveMove：结果是 moveSubtree 能直接吃的形状', () => {
    for (const key of ['up', 'down', 'left', 'right']) {
        const move = resolveMove(doc(), 'a1', key);
        if (!move) continue;
        assert.ok(['before', 'after', 'into'].includes(move.mode));
        assert.equal(typeof move.targetId, 'string');
        assert.notEqual(move.targetId, 'a1');
    }
});

test('isTypingTarget：输入类元素算输入态，普通元素不算', () => {
    assert.equal(isTypingTarget({ tagName: 'input' }), true);
    assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true);
    assert.equal(isTypingTarget({ tagName: 'select' }), true);
    assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
    assert.equal(isTypingTarget({ tagName: 'DIV' }), false);
    assert.equal(isTypingTarget(null), false);
});

// ── 接线层：用一个假事件源与假 ctx，验证「该调的调了、该吞的吞了、没选中就什么都不做」

function fakeTarget() {
    const handlers = new Map();
    return {
        addEventListener(type, fn) { handlers.set(type, fn); },
        removeEventListener(type) { handlers.delete(type); },
        fire(e) {
            const fn = handlers.get('keydown');
            if (fn) fn(e);
        },
        get count() { return handlers.size; },
    };
}

function keyEvent(over) {
    return Object.assign({
        key: 'ArrowUp',
        altKey: true,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        defaultPrevented: false,
        target: { tagName: 'DIV' },
        prevented: false,
        preventDefault() { this.prevented = true; },
    }, over);
}

function fakeCtx(over) {
    const calls = [];
    const ctx = Object.assign({
        doc: () => ({ objects: doc() }),
        selection: () => ({ id: 'c' }),
        activeLayerId: () => 'a2',
        moveSubtree: (id, move) => { calls.push([id, move]); return true; },
    }, over);
    return { ctx, calls };
}

test('installLayerKeys：Alt+↑ 命中选中对象并调用 moveSubtree', () => {
    const target = fakeTarget();
    const { ctx, calls } = fakeCtx();
    const off = installLayerKeys(ctx, { target });
    const e = keyEvent();
    target.fire(e);
    assert.deepEqual(calls.map(([id, m]) => [id, m.mode, m.targetId]), [['c', 'before', 'b']]);
    assert.equal(typeof calls[0][1].coalesce, 'string');
    assert.equal(e.prevented, true);
    off();
    assert.equal(target.count, 0);
});

test('installLayerKeys：没有选中就退回 activeLayerId', () => {
    const target = fakeTarget();
    const { ctx, calls } = fakeCtx({ selection: () => null });
    installLayerKeys(ctx, { target });
    target.fire(keyEvent({ key: 'ArrowLeft' }));
    assert.deepEqual(calls.map(([id, m]) => [id, m.mode, m.targetId]), [['a2', 'after', 'a']]);
});

test('installLayerKeys：连按两次带不同的合并键，撤销才不会被并成一步', () => {
    const target = fakeTarget();
    const { ctx, calls } = fakeCtx();
    installLayerKeys(ctx, { target });
    target.fire(keyEvent());
    target.fire(keyEvent());
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0][1].coalesce, calls[1][1].coalesce);
});

test('installLayerKeys：输入态、缺少修饰键、有 ctrl/shift 时都不接管', () => {
    const target = fakeTarget();
    const { ctx, calls } = fakeCtx();
    installLayerKeys(ctx, { target });
    target.fire(keyEvent({ target: { tagName: 'INPUT' } }));
    target.fire(keyEvent({ altKey: false }));
    target.fire(keyEvent({ ctrlKey: true }));
    target.fire(keyEvent({ shiftKey: true }));
    assert.deepEqual(calls, []);
});

test('installLayerKeys：到边界也吃掉按键（避免 Alt+← 触发宿主后退），但不写文档', () => {
    const target = fakeTarget();
    const { ctx, calls } = fakeCtx({ selection: () => ({ id: 'a' }) });
    installLayerKeys(ctx, { target });
    const e = keyEvent({ key: 'ArrowUp' });
    target.fire(e);
    assert.deepEqual(calls, []);
    assert.equal(e.prevented, true);
});

test('installLayerKeys：ctx 没有 moveSubtree 时整条链静默不装（不报错、不抛）', () => {
    const target = fakeTarget();
    const off = installLayerKeys({ doc: () => ({ objects: doc() }) }, { target });
    assert.equal(target.count, 0);
    assert.equal(typeof off, 'function');
    off();
});
