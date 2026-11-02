// 锚点拖动松手时的决策（`core/gizmo.mjs` 的 `anchorDropAction`）。
//
// 这段以前只有真机验证（待修清单 D7）：三条规则每条都踩过坑 ——
// Esc 取消不能写、整段拖动只写一次、外壳没提供 setAnchor 时既不能写也不能谎报「已取消」。
// 决策现在是纯函数，可以在 node 里钉死；接线由源码守卫保证。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { anchorDropAction } from '../app/core/gizmo.mjs';

const SRC = readFileSync(new URL('../app/editors/canvas-input.mjs', import.meta.url), 'utf8');

test('Esc 取消 → cancel（什么都不写）', () => {
    assert.equal(anchorDropAction({ hasPreview: true, canceled: true, canSetAnchor: true }), 'cancel');
});

test('有预览 + 外壳给入口 → commit（写一次）', () => {
    assert.equal(anchorDropAction({ hasPreview: true, canceled: false, canSetAnchor: true }), 'commit');
});

test('有预览但外壳没给 setAnchor → none（不写，也不谎报已取消）', () => {
    assert.equal(anchorDropAction({ hasPreview: true, canceled: false, canSetAnchor: false }), 'none');
});

test('没有预览（没真正拖到锚点）→ none，即使 canceled 也不提示', () => {
    assert.equal(anchorDropAction({ hasPreview: false, canceled: false, canSetAnchor: true }), 'none');
    assert.equal(anchorDropAction({ hasPreview: false, canceled: true, canSetAnchor: true }), 'none');
});

test('坏输入不抛：缺字段/非对象一律当「什么都没发生」', () => {
    assert.equal(anchorDropAction(), 'none');
    assert.equal(anchorDropAction(null), 'none');
    assert.equal(anchorDropAction('x'), 'none');
    assert.equal(anchorDropAction({}), 'none');
});

test('接线守卫：canvas-input 用 anchorDropAction 决策，且 commit 分支只调一次 setAnchor', () => {
    assert.ok(SRC.includes('anchorDropAction({'), 'canvas-input 没用纯决策');
    assert.ok(SRC.includes("action === 'cancel'"), '缺 cancel 分支');
    assert.ok(SRC.includes("action === 'commit'"), '缺 commit 分支');
    // 整个文件里 setAnchor 的调用点应当只有 commit 分支那一次（Esc 不回滚、不二次写）
    const calls = SRC.split('ctx.setAnchor(').length - 1;
    assert.equal(calls, 1, 'setAnchor 应只在 commit 分支调用一次，实际 ' + calls);
    // 锚点分支里不许再有「取消也提交」的历史写法
    const anchorBranch = SRC.slice(SRC.indexOf('if (pv) {'), SRC.indexOf('if (pv) {') + 900);
    assert.ok(!/if \(!dragCanceled\)\s*\{[\s\S]{0,200}setAnchor/.test(anchorBranch), '别把取消写成提交');
});
