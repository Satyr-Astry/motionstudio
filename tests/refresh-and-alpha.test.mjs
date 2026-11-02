// 「刷新分级」的登记完整性 + 两处透明度阈值的语义区分。
//
// 这两件事都属「不报错、不红、只会悄悄错」的类型，所以用源码守卫钉住：
//   1. 新增编辑器必须显式归入「时间档 / 纹理粒度 / 静止」三者之一，
//      漏登记的症状是「播放时这个面板不更新」。
//   2. 命中测试与取色器的 alpha 阈值语义**相反**（一个 > 才算命中、一个 < 就当取不到），
//      合并它们会让命中被噪点抓住、或让取色取不到浅色 —— 两边注释要互相指认。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    CEL_GRANULAR_EDITORS,
    STATIC_EDITORS,
    TIME_DRIVEN_EDITORS,
} from '../app/shell/refresh-plan.mjs';

const ELEMENT = readFileSync(new URL('../app/core/element.mjs', import.meta.url), 'utf8');
const ENGINE = readFileSync(new URL('../app/paint/engine.mjs', import.meta.url), 'utf8');

test('静止编辑器清单存在，且覆盖注册表里剩下那些（不由「不在前两档」隐式推出）', () => {
    assert.ok(STATIC_EDITORS instanceof Set, '缺 STATIC_EDITORS');
    assert.ok(STATIC_EDITORS.size >= 8, '静止编辑器太少，实际 ' + STATIC_EDITORS.size);
    for (const id of ['help', 'projects', 'prefs', 'palette']) {
        assert.ok(STATIC_EDITORS.has(id), id + ' 应归入静止档');
    }
});

test('三档并集 == 注册表（从源码抽 id，避免 import 拉起 DOM）', () => {
    const src = readFileSync(new URL('../app/shell/registry.mjs', import.meta.url), 'utf8');
    const ids = [...src.matchAll(/\{\s*id:\s*'([a-z][a-z-]*)',\s*mount:/g)].map((m) => m[1]);
    const all = new Set([...TIME_DRIVEN_EDITORS, ...CEL_GRANULAR_EDITORS, ...STATIC_EDITORS]);
    assert.deepEqual([...all].sort(), ids.sort());
});

test('命中测试与取色器的 alpha 阈值互相指认（语义相反，禁止合并）', () => {
    assert.ok(ELEMENT.includes('alpha > threshold 才算命中'), 'element.mjs 缺命中语义说明');
    assert.ok(ELEMENT.includes('pixelHex'), 'element.mjs 没有指认对面那个函数');
    assert.ok(ENGINE.includes('alpha < 阈值就算取不到'), 'engine.mjs 缺取色语义说明');
    assert.ok(ENGINE.includes('hitTest'), 'engine.mjs 没有指认命中测试');
    // 两边都不许悄悄改成同一个方向
    assert.ok(ELEMENT.includes('threshold == null ? 8 :'), '命中阈值仍应是 8');
    assert.ok(ENGINE.includes('alphaMin) ? alphaMin : 8'), '取色阈值仍应是 8');
});
