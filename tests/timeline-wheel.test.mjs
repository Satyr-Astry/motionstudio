// 时间轴滚轮行为（`app/editors/timeline.mjs` 的 `onWheelZoom`）。
//
// 为什么单独测：`Shift+滚轮 = 横向滚动` 是这个面板里**唯一不带按钮**的操作，
// 用户不会「发现」它，只能靠试或看帮助。所以它必须一直被守住：
//   · 组合键要互斥（Shift 优先于 Ctrl，否则按住 Shift 再滚会变成缩放）
//   · 竖滚轮在 Shift 下也要能横滚（鼠标用户只有 deltaY）
//   · 横向位置不能滚成负数
//
// 这里既测纯函数，也用源码守卫钉住「分支真的接在 wheel 上」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { nextScrollLeft } from '../app/editors/timeline.mjs';

const SRC = readFileSync(new URL('../app/editors/timeline.mjs', import.meta.url), 'utf8');

test('nextScrollLeft：正常累加，且不低于 0', () => {
    assert.equal(nextScrollLeft(100, 40), 140);
    assert.equal(nextScrollLeft(100, -40), 60);
    assert.equal(nextScrollLeft(10, -40), 0, '不能滚成负数');
    assert.equal(nextScrollLeft(0, 0), 0);
});

test('nextScrollLeft：坏输入当 0 处理（DOM 读数可能是 undefined）', () => {
    assert.equal(nextScrollLeft(undefined, 30), 30);
    assert.equal(nextScrollLeft(50, undefined), 50);
    assert.equal(nextScrollLeft(null, NaN), 0);
    assert.equal(nextScrollLeft('120', '30'), 150, '数字字符串也要认（scrollLeft 有时是字符串）');
});

test('源码守卫：Shift 分支存在，且与 Ctrl/Cmd 缩放分支互斥', () => {
    assert.ok(/e\.shiftKey\s*&&\s*!e\.ctrlKey\s*&&\s*!e\.metaKey/.test(SRC),
        '缺 Shift 分支，或没有和 Ctrl/Cmd 互斥');
    assert.ok(SRC.includes('box.scrollLeft = nextScrollLeft(box.scrollLeft, delta)'),
        '横向滚动没接到纯函数上');
    assert.ok(SRC.includes('syncRulerScroll(view)'), '滚了 rows 没同步刻度尺 → 刻度与内容错位');
});

test('源码守卫：竖滚轮在 Shift 下当横向用（鼠标只有 deltaY）', () => {
    assert.ok(/Number\(e\.deltaX\)\s*!==\s*0\s*\?\s*Number\(e\.deltaX\)\s*:\s*Number\(e\.deltaY\)/.test(SRC),
        '缺「deltaX 优先、否则用 deltaY」的兜底');
});

test('源码守卫：滚轮监听仍绑在 rows 与 ruler 上（两处都要，否则刻度尺滚不动）', () => {
    const binds = SRC.split("addEventListener('wheel', onWheelZoom").length - 1;
    assert.equal(binds, 2, 'wheel 监听应绑两处（rows + ruler），实际 ' + binds);
});
