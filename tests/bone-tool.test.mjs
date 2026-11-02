/**
 * 骨骼工具（工具栏 K）的纯几何 + 接线契约。
 *
 * 纯函数部分测真值：建骨拖动换算父空间、拖末梢保持根不动、世界端点与渲染同源。
 * 接线部分按项目惯例钉源码（画布输入、叠加层、工具注册）——这三处散在三个文件，
 * 少了任何一处用户都只看到「多了一个按钮，但按了没反应」。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { createTrack, addKey } from '../app/core/transform.mjs';
import { invertMatrix } from '../app/core/element.mjs';
import { TOOLS, downIntent } from '../app/paint/engine.mjs';
import { boneDragGeometry, boneTipGeometry, boneWorldEnds } from '../app/core/bone-tool.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function boneOf({ state = { x: 0, y: 0 }, len = 120, width = 14, t = 0, parentId = null } = {}) {
    return {
        id: 'b1',
        kind: 'bone',
        name: 'Bone 1',
        parentId,
        anchor: { x: 0, y: 0.5 },
        bone: { len, width, color: '#7d8fa8' },
        transform: addKey(
            createTrack(),
            t,
            Object.assign({ scaleX: 1, scaleY: 1, rotate: 0, skewX: 0, skewY: 0, opacity: 1 }, state),
            'linear',
        ),
    };
}

/* ─────────────────────────── 建骨拖动 ─────────────────────────── */

test('水平拖动：起点是骨根，长度=拖动距离，角度 0', () => {
    const g = boneDragGeometry({ from: { x: 100, y: 100 }, to: { x: 200, y: 100 } });
    // anchor=(0,0.5) → x 不退，y 退半个宽度（7）
    assert.deepEqual(g, { x: 100, y: 93, rotate: 0, len: 100 });
});

test('斜拖 45°：角度按 atan2 取，长度是斜边', () => {
    const g = boneDragGeometry({ from: { x: 0, y: 0 }, to: { x: 100, y: 100 } });
    assert.equal(g.rotate, 45);
    assert.equal(g.len, 141.42);
    assert.equal(g.x, 0);
    assert.equal(g.y, -7);
});

test('父空间换算：给了父链逆矩阵就按父空间取参数', () => {
    const parentM = { a: 2, b: 0, c: 0, d: 2, e: 10, f: 20 };
    const g = boneDragGeometry({
        from: { x: 110, y: 220 },
        to: { x: 150, y: 220 },
        parentInverse: invertMatrix(parentM),
    });
    // 父空间：from=(50,100)、to=(70,100) → x=50、y=100-7=93、len=20
    assert.deepEqual(g, { x: 50, y: 93, rotate: 0, len: 20 });
});

test('原地点击：长度夹到最小值 8，不产出零长骨头', () => {
    const g = boneDragGeometry({ from: { x: 5, y: 5 }, to: { x: 5, y: 5 } });
    assert.equal(g.len, 8);
});

test('坏参数返回 null（不造半个骨骼）', () => {
    assert.equal(boneDragGeometry(null), null);
    assert.equal(boneDragGeometry({ from: { x: 0, y: 0 } }), null);
    assert.equal(boneDragGeometry({ from: { x: NaN, y: 0 }, to: { x: 1, y: 1 } }), null);
});

test('角度归一到 (-180,180]：反向拖动是 180 而不是 -180', () => {
    const g = boneDragGeometry({ from: { x: 100, y: 0 }, to: { x: 0, y: 0 } });
    assert.equal(g.rotate, 180);
});

/* ─────────────────────────── 拖末梢 ─────────────────────────── */

test('拖末梢：根不动，长度=指针到根的距离，角度跟随', () => {
    // root = state + (0, width/2) = (10, 27)
    const g = boneTipGeometry({ state: { x: 10, y: 20 }, width: 14, point: { x: 130, y: 27 } });
    assert.deepEqual(g, { rotate: 0, len: 120 });
});

test('拖末梢：竖直向上是 -90°，长度照样算', () => {
    const g = boneTipGeometry({ state: { x: 0, y: 0 }, width: 14, point: { x: 0, y: 7 - 50 } });
    assert.equal(g.rotate, -90);
    assert.equal(g.len, 50);
});

test('缩放过的骨骼：长度按 |scaleX| 折算，末梢跟手', () => {
    const g = boneTipGeometry({ state: { x: 0, y: 0, scaleX: 2 }, width: 14, point: { x: 240, y: 7 } });
    assert.equal(g.len, 120);
});

test('拖末梢过短：夹最小值 8', () => {
    const g = boneTipGeometry({ state: { x: 0, y: 0 }, width: 14, point: { x: 1, y: 7 } });
    assert.equal(g.len, 8);
});

test('拖末梢坏参数返回 null', () => {
    assert.equal(boneTipGeometry(null), null);
    assert.equal(boneTipGeometry({ point: { x: NaN, y: 0 } }), null);
});

/* ─────────────────────────── 世界端点 ─────────────────────────── */

test('世界端点：与 drawBones 同一张矩阵（局部 y=width/2）', () => {
    const el = boneOf({ state: { x: 10, y: 20 } });
    const ends = boneWorldEnds(el, 0, null);
    assert.deepEqual(ends.root, { x: 10, y: 27 });
    assert.deepEqual(ends.tip, { x: 130, y: 27 });
    assert.equal(ends.len, 120);
    assert.equal(ends.width, 14);
});

test('世界端点：旋转 90° 时绕根部转，末梢从 +x 变 +y', () => {
    const el = boneOf({ state: { x: 0, y: 0, rotate: 90 } });
    const ends = boneWorldEnds(el, 0, null);
    assert.ok(Math.abs(ends.root.x - 0) < 1e-9);
    assert.ok(Math.abs(ends.root.y - 7) < 1e-9);
    assert.ok(Math.abs(ends.tip.x - 0) < 1e-9);
    assert.ok(Math.abs(ends.tip.y - 127) < 1e-9);
});

test('世界端点：父链矩阵参与（嵌套骨骼不会画错位）', () => {
    const el = boneOf({ state: { x: 0, y: 0 } });
    const ends = boneWorldEnds(el, 0, { a: 1, b: 0, c: 0, d: 1, e: 100, f: 0 });
    assert.deepEqual(ends.root, { x: 100, y: 7 });
    assert.deepEqual(ends.tip, { x: 220, y: 7 });
});

test('非骨骼对象：不给端点', () => {
    assert.equal(boneWorldEnds({ id: 'o1', kind: 'paint' }, 0, null), null);
    assert.equal(boneWorldEnds(null, 0, null), null);
});

/* ─────────────────────────── 接线契约 ─────────────────────────── */

test('工具注册：TOOLS 有 bone、按 K、downIntent 判为 select（引擎永不落笔）', () => {
    const tool = TOOLS.find((t) => t.id === 'bone');
    assert.ok(tool, 'TOOLS 缺 bone');
    assert.equal(tool.key, 'K');
    assert.equal(downIntent(0, 'bone', false, false), 'select', '骨骼工具必须让引擎走 select 分支（不画）');
    assert.equal(downIntent(0, 'bone', true, false), 'pan', '按住空格仍然让给平移');
});

test('快捷键表：K 对应 bone', () => {
    const src = read('app/shell/doc-state.mjs');
    assert.match(src, /const TOOL_KEYS = \{[^}]*\bk: 'bone'/);
});

test('工具条：骨骼按钮与图标都存在', () => {
    const bar = read('app/editors/toolbar.mjs');
    assert.match(bar, /\{ id: 'bone', icon: 'bone', nameKey: 'tool\.bone\.name', key: 'K' \}/);
    const icons = read('app/core/icons.mjs');
    assert.match(icons, /\n    bone: '/);
});

test('画布输入：骨骼分支自己接管按下，拖动写 ctx.writeBoneTip / createBoneFromDrag', () => {
    const src = read('app/editors/canvas-input.mjs');
    assert.ok(src.includes("if (tool === 'bone')"), 'onDown 没有骨骼分支');
    assert.ok(src.includes('startBoneDown('), '没有 startBoneDown');
    assert.ok(src.includes('boneAtTip('), '没有末梢命中');
    assert.ok(src.includes('ctx.writeBoneTip('), '拖末梢没有写文档');
    assert.ok(src.includes('ctx.createBoneFromDrag('), '建骨没有落到文档');
    assert.ok(src.includes("tr('canvas.bone.tip')"), '松手没有撤销标签（词条）');
    assert.ok(src.includes('function bonePreview()'), '叠加层拿不到预览');
    assert.ok(src.includes('detachBoneDrag();'), 'dispose 没摘骨骼监听');
    // 顶层骨骼的父链矩阵是 null，invertMatrix(null) 会抛 —— 两处都要先判空
    assert.equal((src.match(/parentInv: parentM \? invertMatrix\(parentM\) : null/g) || []).length, 2,
        '建骨/拖末梢的 invertMatrix 没有判空（顶层骨骼会崩）');
});

test('叠加层：骨骼工具手柄与预览已接进 drawGizmo', () => {
    const src = read('app/editors/canvas.mjs');
    assert.ok(src.includes('function drawBoneTool(g)'));
    assert.ok(src.includes('drawBoneTool(g);'), 'drawGizmo 没调用 drawBoneTool');
    assert.ok(src.includes("from '../core/bone-tool.mjs'"), '没有复用 bone-tool 的几何');
});

test('工作区：骨骼工具不被动画工作区收走，离开动画工作区自动回 select', () => {
    const src = read('app/shell/view-host.mjs');
    assert.ok(src.includes("engine.state.tool !== 'bone'"), '进动画工作区会把 bone 收走');
    assert.match(src, /else if \(engine\.state\.tool === 'bone'\)/);
});

test('外壳：ctx 暴露建骨/拖末梢，且骨骼工具会切到动画工作区', () => {
    const src = read('app/shell/app.mjs');
    assert.ok(src.includes('createBoneFromDrag,'));
    assert.ok(src.includes('writeBoneTip,'));
    assert.ok(src.includes('function createBoneFromDrag('));
    assert.ok(src.includes('function writeBoneTip('));
    assert.match(src, /id === 'bone' && state\.workspace !== 'animate'/, '选中骨骼工具时没切动画工作区');
});

test('画布左上角有常驻的骨骼工具开关（动画工作区默认没有工具条）', () => {
    const chrome = read('app/editors/canvas-chrome.mjs');
    assert.ok(chrome.includes("mkBtn('bone'"), 'canvas-chrome 没有骨骼工具按钮');
    assert.ok(chrome.includes('cv-tools'), '没有独立的工具开关容器');
    assert.ok(chrome.includes("t('chrome.boneTool')"), '按钮标题没走词条');
    assert.ok(chrome.includes("ctx.setTool(toolNow() === 'bone' ? 'select' : 'bone')"), '点击没有切换工具');
    assert.ok(chrome.includes('engine.on(\'tool\', syncTool)'), '按钮状态没跟引擎工具事件同步');
    const canvas = read('app/editors/canvas.mjs');
    assert.ok(canvas.includes("':scope > .cv-hud, :scope > .cv-tools'"), '重复挂载没清旧按钮');
    assert.ok(canvas.includes('syncTool()'), 'refresh 没同步按钮状态');
    assert.ok(chrome.includes("'chrome.boneTool'") || read('app/i18n/parts/panels.mjs').includes("'chrome.boneTool'"), '词条缺 chrome.boneTool');
});

