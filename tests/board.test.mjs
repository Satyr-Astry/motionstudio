import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BOARD_DEFAULT,
    BOARD_MAX,
    BOARD_MIN,
    boardIsEmpty,
    boardLabel,
    boardToObjectDraft,
    clearBoard,
    createBoard,
    markBoardDirty,
    resizeBoard,
    setBoardSurface,
} from '../app/core/board.mjs';

const surf = (w, h) => ({ width: w, height: h, tag: 's' });

test('createBoard 缺省尺寸与默认名', () => {
    const b = createBoard();
    assert.equal(b.width, BOARD_DEFAULT.width);
    assert.equal(b.height, BOARD_DEFAULT.height);
    assert.ok(b.name.startsWith('画板 '));
    assert.equal(b.surface, null);
    assert.equal(b.dirty, false);
    assert.ok(b.id);
});

test('createBoard 序列号递增且名字不撞', () => {
    const a = createBoard();
    const b = createBoard();
    assert.notEqual(a.id, b.id);
    assert.notEqual(a.name, b.name);
});

test('createBoard 尺寸被钳制到合法区间', () => {
    assert.equal(createBoard({ width: 1, height: 1 }).width, BOARD_MIN);
    assert.equal(createBoard({ width: 999999, height: 999999 }).height, BOARD_MAX);
    assert.equal(createBoard({ width: 'abc', height: null }).width, BOARD_DEFAULT.width);
    assert.equal(createBoard({ width: 320.4, height: 240.6 }).width, 320);
});

test('boardIsEmpty：无位图 / 有位图但没落笔 / 落过笔', () => {
    const b = createBoard();
    assert.equal(boardIsEmpty(b), true);
    const withSurf = setBoardSurface(b, surf(10, 10));
    assert.equal(boardIsEmpty(withSurf), false);
    const fresh = setBoardSurface(b, surf(10, 10));
    const untouched = Object.assign({}, fresh, { dirty: false });
    assert.equal(boardIsEmpty(untouched), true);
    assert.equal(boardIsEmpty(markBoardDirty(untouched)), false);
    assert.equal(boardIsEmpty(null), true);
});

test('setBoardSurface 不改入参', () => {
    const b = createBoard();
    const next = setBoardSurface(b, surf(8, 8));
    assert.equal(b.surface, null);
    assert.ok(next.surface);
    assert.notEqual(b, next);
});

test('markBoardDirty 幂等且不可变', () => {
    const b = createBoard();
    const once = markBoardDirty(b);
    assert.equal(once.dirty, true);
    const twice = markBoardDirty(once);
    assert.equal(twice, once);
    assert.equal(b.dirty, false);
});

test('clearBoard 清掉内容但保留尺寸与名字', () => {
    const b = markBoardDirty(setBoardSurface(createBoard({ width: 300, height: 200, name: '草稿' }), surf(300, 200)));
    const c = clearBoard(b);
    assert.equal(c.dirty, false);
    assert.equal(c.width, 300);
    assert.equal(c.height, 200);
    assert.equal(c.name, '草稿');
});

test('resizeBoard 丢内容并钳制', () => {
    const b = markBoardDirty(setBoardSurface(createBoard(), surf(640, 480)));
    const r = resizeBoard(b, 800, -5);
    assert.equal(r.surface, null);
    assert.equal(r.dirty, false);
    assert.equal(r.width, 800);
    assert.equal(r.height, b.height);
    assert.equal(resizeBoard(b, 1, 1).width, BOARD_MIN);
});

test('boardLabel 带名字与尺寸', () => {
    const b = createBoard({ width: 320, height: 240, name: '角色' });
    assert.equal(boardLabel(b), '角色 · 320×240');
    assert.equal(boardLabel(null), '画板');
});

test('boardToObjectDraft 透传位图与尺寸', () => {
    const s = surf(320, 240);
    const b = markBoardDirty(setBoardSurface(createBoard({ width: 320, height: 240, name: '角色' }), s));
    const d = boardToObjectDraft(b, { name: '英雄', at: 1.5 });
    assert.equal(d.name, '英雄');
    assert.equal(d.image, s);
    assert.equal(d.width, 320);
    assert.equal(d.height, 240);
    assert.equal(d.at, 1.5);
});

test('boardToObjectDraft 无 opts 时用画板名与 0 秒', () => {
    const b = markBoardDirty(setBoardSurface(createBoard({ name: 'B' }), surf(4, 4)));
    const d = boardToObjectDraft(b);
    assert.equal(d.name, 'B');
    assert.equal(d.at, 0);
});

test('boardToObjectDraft 非法画板返回 null', () => {
    assert.equal(boardToObjectDraft(null), null);
});

// 这条是被真机发现的漏网之鱼：ensureCelAt 曾经忽略 opts.image，
// createObjectFromBoard 建出来的画格 at 对、image 却是 null，而且不报错。
test('ensureCelAt 接受 opts.image（对象工厂的出生路径）', async () => {
    const { ensureCelAt } = await import('../app/core/doc-model.mjs');
    const img = { width: 8, height: 8, tag: 'board' };
    const obj = { id: 'o1', cels: [] };
    const res = ensureCelAt(obj, 0.5, { image: img });
    assert.equal(res.created, true);
    assert.equal(res.cel.at, 0.5);
    assert.equal(res.cel.image, img);
});

test('工厂从画板建出的对象，画格必须真的带图', async () => {
    const { createDoc } = await import('../app/core/doc-model.mjs');
    const { createBoard, setBoardSurface, markBoardDirty } = await import('../app/core/board.mjs');
    const { createObjectFromBoard } = await import('../app/shell/object-factory.mjs');
    const doc = createDoc({ width: 64, height: 64, fps: 12 });
    const surface = { width: 32, height: 32, tag: 'surface' };
    let b = createBoard({ width: 32, height: 32, surface });
    b = setBoardSurface(b, surface);
    b = markBoardDirty(b);
    const res = createObjectFromBoard(doc, b, { at: 0.25 });
    assert.ok(res.object, '应该建出对象');
    const cel = (res.object.cels || []).find((c) => Math.abs(c.at - 0.25) < 1e-9);
    assert.ok(cel, '应该有 0.25 秒的画格');
    assert.equal(cel.image, surface, '画格必须带画板位图');
});

test('objectSize 取第一个有图画格的尺寸，空对象返回 null', async () => {
    const { objectSize } = await import('../app/core/doc-model.mjs');
    assert.equal(objectSize({ cels: [] }), null);
    assert.equal(objectSize({ cels: [{ at: 0, image: null }] }), null);
    const img = { width: 48, height: 32 };
    assert.deepEqual(objectSize({ cels: [{ at: 0, image: null }, { at: 1, image: img }] }), { w: 48, h: 32 });
});

test('ensureCelAt 在尺寸不一致时用 fitImage 校正（对象内画格必须同尺寸）', async () => {
    const { ensureCelAt } = await import('../app/core/doc-model.mjs');
    const base = { width: 40, height: 40, tag: 'base' };
    const big = { width: 80, height: 80, tag: 'big' };
    const obj = { id: 'o', cels: [{ at: 0, image: base }] };
    let asked = null;
    const fit = (img, w, h) => { asked = { from: [img.width, img.height], to: [w, h] }; return { width: w, height: h, tag: 'fitted' }; };
    const res = ensureCelAt(obj, 1, { image: big, fitImage: fit });
    assert.deepEqual(asked, { from: [80, 80], to: [40, 40] }, '应该按基准尺寸请求校正');
    assert.equal(res.cel.image.width, 40);
    assert.equal(res.cel.image.tag, 'fitted');
});

test('ensureCelAt 尺寸一致时不调用 fitImage', async () => {
    const { ensureCelAt } = await import('../app/core/doc-model.mjs');
    const base = { width: 40, height: 40 };
    const same = { width: 40, height: 40, tag: 'same' };
    const obj = { id: 'o', cels: [{ at: 0, image: base }] };
    let called = false;
    const res = ensureCelAt(obj, 1, { image: same, fitImage: () => { called = true; return same; } });
    assert.equal(called, false);
    assert.equal(res.cel.image, same);
});

test('ensureCelAt 命中已有画格时也要写入 image（对象工厂的真实路径）', async () => {
    const { ensureCelAt } = await import('../app/core/doc-model.mjs');
    const img = { width: 16, height: 16, tag: 'painted' };
    // addObject 会先造一个空画格，工厂接着往里塞图
    const obj = { id: 'o', cels: [{ at: 0, image: null }] };
    const res = ensureCelAt(obj, 0, { image: img });
    assert.equal(res.created, false);
    assert.equal(res.cel.image, img);
    assert.equal(res.obj.cels[0].image, img);
    assert.equal(obj.cels[0].image, null, '不能改入参');
});
