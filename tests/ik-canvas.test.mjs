// 骨骼 P3 步 4：IK 画布叠加层（`app/editors/canvas.mjs` 的 `drawIk`）。
//
// 这一层全是画布绘制代码，node 里没有 2d context，所以只做源码守卫 +
// 「它用的是哪条矩阵路径」的断言。真正的视觉验收在 `npm run smoke` 与手测。
//
// 最关键的一条：末端位置必须来自 `boneWorldMatrix(..., sol)`。
// 用 `elementWorldMatrix` 会画在**未解算**的位置上 —— 骨头在 A 点、连线从 B 点出发，
// 这种错位肉眼一看就错，但如果没测过，改一行就会发生。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../app/editors/canvas.mjs', import.meta.url), 'utf8');

test('drawIk 存在，且在 drawSkinWeights 之后、selectionInfo 判空之前被调用', () => {
    assert.ok(SRC.includes('function drawIk(g)'), '缺 drawIk');
    const callAt = SRC.indexOf('        drawIk(g);');
    const skinAt = SRC.indexOf('        drawSkinWeights(g);');
    const infoAt = SRC.indexOf('        const info = selectionInfo();');
    assert.ok(callAt > 0, 'drawIk 没有被调用');
    assert.ok(callAt > skinAt, 'drawIk 应在权重层之后（连线压在最上面）');
    assert.ok(callAt < infoAt, 'drawIk 必须在 selectionInfo 判空之前（否则没选中就不画了）');
});

test('末端位置走 boneWorldMatrix + solveIk 的同一张覆盖表', () => {
    const body = SRC.slice(SRC.indexOf('function drawIk(g)'), SRC.indexOf('function drawSkinWeights(g)'));
    assert.ok(body.includes('boneWorldMatrix(doc, tipEl, time, sol)'),
        '末端必须用 boneWorldMatrix(..., sol)（用 elementWorldMatrix 会画在未解算位置）');
    assert.ok(body.includes('solveIk(doc, time)'), '必须先取覆盖表');
    assert.ok(body.includes('ikChains(doc)'), '链必须来自 ikChains（与解算器同一套判定）');
});

test('只在选中链上骨或目标对象时画，平时不打扰画面', () => {
    const body = SRC.slice(SRC.indexOf('function drawIk(g)'), SRC.indexOf('function drawSkinWeights(g)'));
    assert.ok(body.includes('if (!selId) return;'), '没选中就该整层不画');
    assert.ok(body.includes('ids.indexOf(selId) < 0 && selId !== chain.targetId'),
        '必须按「选中链上骨或目标」过滤');
});

test('画的是虚线 + 目标点十字（区分「目标」与「末端关节」）', () => {
    const body = SRC.slice(SRC.indexOf('function drawIk(g)'), SRC.indexOf('function drawSkinWeights(g)'));
    assert.ok(body.includes('setLineDash([6, 5])'), '连线应是虚线');
    assert.ok(body.includes('setLineDash([])'), '画目标点前要复位虚线（否则十字也变虚线）');
    assert.ok(/moveTo\(tp\.x - 9, tp\.y\)/.test(body), '目标点要有十字横线');
    assert.ok(/moveTo\(tp\.x, tp\.y - 9\)/.test(body), '目标点要有十字竖线');
    assert.ok(body.includes('g.save()') && body.includes('g.restore()'), '绘制必须成对保存/恢复画布状态');
});

test('目标点取元素锚点位置，而不是对象原点', () => {
    const body = SRC.slice(SRC.indexOf('function drawIk(g)'), SRC.indexOf('function drawSkinWeights(g)'));
    assert.ok(body.includes('anchorPoint(targetEl, tSize)'), '目标点必须按 anchor 取（与命中/选框同一口径）');
});
