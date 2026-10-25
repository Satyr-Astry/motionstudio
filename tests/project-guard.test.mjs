import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DRAFT_ID,
    guardDecision,
    choiceOutcome,
    deleteConfirmText,
    draftPromptText,
    draftName,
    isDraftRecord,
} from '../app/core/project-guard.mjs';

/* ───────────────────────── guardDecision ───────────────────────── */

test('guardDecision：没有改动就什么都不问', () => {
    const out = guardDecision({ dirty: false, id: '', name: '' });
    assert.equal(out.action, 'proceed');
    assert.equal(out.reason, 'clean');
});

test('guardDecision：有改动且存过（有 id 有名字）→ 先静默入库再走', () => {
    const out = guardDecision({ dirty: true, id: 'p-1', name: '项目A' });
    assert.equal(out.action, 'save-then-proceed');
    assert.equal(out.reason, 'dirty-saved');
});

test('guardDecision：有改动但没名字 → 必须问', () => {
    const out = guardDecision({ dirty: true, id: '', name: '' });
    assert.equal(out.action, 'ask');
    assert.equal(out.reason, 'dirty-unnamed');
});

test('guardDecision：脏、有 id 但名字是空白 → 也要问（没人给过名字）', () => {
    assert.equal(guardDecision({ dirty: true, id: 'p-1', name: '   ' }).action, 'ask');
});

test('guardDecision：脏、有名字但没 id → 也要问（没进过库）', () => {
    assert.equal(guardDecision({ dirty: true, id: '', name: '项目A' }).action, 'ask');
    assert.equal(guardDecision({ dirty: true, id: '', name: '项目A' }).reason, 'dirty-unsaved');
});

test('guardDecision：脏但只有 id、没有名字 → ask', () => {
    assert.equal(guardDecision({ dirty: true, id: 'p-1', name: '' }).action, 'ask');
});

test('guardDecision：入参缺失/为 null/非对象时按「没改动」处理，不抛', () => {
    for (const bad of [undefined, null, 0, '', 'x', [], true]) {
        assert.equal(guardDecision(bad).action, 'proceed');
    }
});

test('guardDecision：脏标记只认真值（1 / "yes" 都算脏，0 / "" 不算）', () => {
    assert.equal(guardDecision({ dirty: 1, id: 'p', name: 'n' }).action, 'save-then-proceed');
    assert.equal(guardDecision({ dirty: 'yes', id: 'p', name: 'n' }).action, 'save-then-proceed');
    assert.equal(guardDecision({ dirty: 0, id: 'p', name: 'n' }).action, 'proceed');
    assert.equal(guardDecision({ dirty: '', id: 'p', name: 'n' }).action, 'proceed');
});

/* ───────────────────────── choiceOutcome ───────────────────────── */

test('choiceOutcome：三选各自落到明确动作', () => {
    assert.deepEqual(choiceOutcome('save'), { action: 'save', reason: 'user-save' });
    assert.deepEqual(choiceOutcome('discard'), { action: 'proceed', reason: 'user-discard' });
    assert.deepEqual(choiceOutcome('cancel'), { action: 'abort', reason: 'user-cancel' });
});

test('choiceOutcome：关闭浮层（null）与任何不认识的返回值都当成「别动」', () => {
    for (const bad of [null, undefined, '', 'SAVE', 'later', 0, {}]) {
        assert.equal(choiceOutcome(bad).action, 'abort');
    }
    assert.equal(choiceOutcome(undefined).reason, 'no-choice');
});

/* ───────────────────────── 文案 ───────────────────────── */

test('deleteConfirmText：带项目名；删当前项目时说明文档还在内存', () => {
    assert.equal(deleteConfirmText('项目A', false), '删除「项目A」？');
    assert.match(deleteConfirmText('项目A', true), /删除「项目A」/);
    assert.match(deleteConfirmText('项目A', true), /还在内存/);
});

test('deleteConfirmText：名字为空时不留一个空引号', () => {
    assert.equal(deleteConfirmText('', false), '删除「未命名项目」？');
    assert.equal(deleteConfirmText(null, false), '删除「未命名项目」？');
    assert.equal(deleteConfirmText('   ', false), '删除「未命名项目」？');
});

test('draftPromptText：有时间就给时:分，没时间就给一句干净的话', () => {
    const t = new Date(2026, 9, 25, 21, 7, 0).getTime();
    assert.match(draftPromptText(t), /草稿/);
    assert.match(draftPromptText(t), /21:07/);
    for (const bad of [undefined, null, 0, -1, NaN, 'abc']) {
        assert.equal(draftPromptText(bad), '发现上次未保存的草稿，要恢复吗？');
    }
});

test('draftName：空名字也能读出「这是一份草稿」', () => {
    assert.equal(draftName(''), '未命名草稿');
    assert.equal(draftName('  '), '未命名草稿');
    assert.equal(draftName('项目A'), '项目A（草稿）');
});

/* ───────────────────────── 草稿记录 ───────────────────────── */

test('isDraftRecord：认 __draft 标记，也认固定键（老记录可能只有 id）', () => {
    assert.equal(isDraftRecord({ id: DRAFT_ID }), true);
    assert.equal(isDraftRecord({ id: 'x', __draft: true }), true);
    assert.equal(isDraftRecord({ id: 'x', name: '项目A' }), false);
    assert.equal(isDraftRecord(null), false);
    assert.equal(isDraftRecord('__draft__'), false);
});

test('DRAFT_ID 是一个不会和真实项目 id 撞车的固定键', () => {
    assert.equal(DRAFT_ID, '__draft__');
    assert.notEqual(DRAFT_ID, '');
});
