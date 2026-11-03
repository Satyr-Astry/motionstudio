// 网格 warp + canvas filter 的离屏合成分支（性能修复的回归守卫）。
//
// 背景：warp 的每个子格都是一次 drawImage。如果同一层还开着 canvas filter，
// 浏览器会对每一次 drawImage 各跑一遍滤镜（12×12 网格一帧上千次，编辑必卡）。
// 有离屏缓冲时 drawOne 必须把 warp 画进离屏（filter 保持 'none'），
// 再整层**一次** drawImage + filter 合回目标画布。
import test from 'node:test';
import assert from 'node:assert/strict';

import { createDoc } from '../app/core/doc-model.mjs';
import { createEvaluator, drawEvaluated } from '../app/core/evaluator.mjs';
import { filterString } from '../app/paint/effects.mjs';

/** 记账用的假 2D 上下文：只记录「带 filter 的 drawImage」与几何调用。 */
function fakeCtx(label) {
    const log = { label, draws: 0, filteredDraws: 0, filters: new Set(), transforms: 0, clips: 0 };
    const state = { filter: 'none', stack: [] };
    const ctx = {
        canvas: null,
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        get filter() {
            return state.filter;
        },
        set filter(v) {
            state.filter = String(v == null ? 'none' : v);
            log.filters.add(state.filter);
        },
        save() {
            state.stack.push(state.filter);
        },
        restore() {
            state.filter = state.stack.length ? state.stack.pop() : 'none';
        },
        setTransform() {
            log.transforms += 1;
        },
        transform() {
            log.transforms += 1;
        },
        drawImage() {
            log.draws += 1;
            if (state.filter && state.filter !== 'none') log.filteredDraws += 1;
        },
        clearRect() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        closePath() {},
        clip() {
            log.clips += 1;
        },
    };
    return { ctx, log };
}

const IMG = { width: 200, height: 120 };

function warpDoc() {
    const pts = [];
    for (let r = 0; r <= 2; r += 1) {
        for (let c = 0; c <= 2; c += 1) pts.push([c === 0 ? -12 : 6, r === 0 ? 8 : -5]);
    }
    return createDoc({
        width: 900,
        height: 640,
        duration: 3,
        fps: 12,
        objects: [{
            id: 'o1',
            name: 'warped',
            kind: 'image',
            cels: [{ at: 0, image: IMG }],
            effects: [{ type: 'blur', amount: 8 }],
            transform: {
                keys: [{
                    t: 0, ease: 'linear', h1: null, h2: null,
                    state: {
                        x: 10, y: 20, scaleX: 1, scaleY: 1, rotate: 0, skewX: 0, skewY: 0,
                        opacity: 1, warp: { cols: 2, rows: 2, pts },
                    },
                }],
            },
        }],
        drawOrder: ['o1'],
    });
}

const filterFor = (layer) => filterString(layer.effects);

test('warp + 效果：给了离屏缓冲时，目标画布只做一次带 filter 的 drawImage', () => {
    const doc = warpDoc();
    const ev = createEvaluator(doc);
    const target = fakeCtx('target');
    const off = fakeCtx('offscreen');
    const layerSurface = { canvas: { width: 900, height: 640 }, ctx: off.ctx };
    off.ctx.canvas = layerSurface.canvas;
    target.ctx.canvas = { width: 900, height: 640 };

    assert.equal(drawEvaluated(target.ctx, ev, 0, { filterFor, layerSurface }), true);
    // 离屏里画的是 warp 网格本体：多次 drawImage，但绝不能被滤镜包住
    assert.ok(off.log.draws > 1, `离屏应画多片网格，实际 ${off.log.draws}`);
    assert.equal(off.log.filteredDraws, 0);
    assert.equal(off.log.filters.has('none'), true);
    // 目标画布：整层一次合成，且这一次是带 filter 的
    assert.equal(target.log.draws, 1);
    assert.equal(target.log.filteredDraws, 1);
    assert.ok([...target.log.filters].some((f) => f.includes('blur')));
});

test('warp + 效果：没有离屏缓冲时退回逐格滤镜（旧行为，保证契约不变）', () => {
    const doc = warpDoc();
    const ev = createEvaluator(doc);
    const target = fakeCtx('target');
    target.ctx.canvas = { width: 900, height: 640 };

    assert.equal(drawEvaluated(target.ctx, ev, 0, { filterFor }), true);
    // 旧路径：每个三角形各自一次带 filter 的 drawImage（这正是要避免的乘法）
    assert.ok(target.log.draws > 1);
    assert.equal(target.log.filteredDraws, target.log.draws);
});

test('warp 但没有效果：不进离屏分支，直接按网格画到目标', () => {
    const doc = warpDoc();
    for (const obj of doc.objects) obj.effects = [];
    const ev = createEvaluator(doc);
    const target = fakeCtx('target');
    const off = fakeCtx('offscreen');
    target.ctx.canvas = { width: 900, height: 640 };
    off.ctx.canvas = { width: 900, height: 640 };

    assert.equal(drawEvaluated(target.ctx, ev, 0, {
        filterFor,
        layerSurface: { canvas: { width: 900, height: 640 }, ctx: off.ctx },
    }), true);
    assert.equal(off.log.draws, 0, '没有效果时不该白跑一趟离屏');
    assert.ok(target.log.draws > 1);
    assert.equal(target.log.filteredDraws, 0);
});

test('效果但没有 warp：仍然是单次 drawImage（不需要离屏）', () => {
    const doc = warpDoc();
    for (const obj of doc.objects) {
        for (const k of obj.transform.keys) k.state.warp = null;
    }
    const ev = createEvaluator(doc);
    const target = fakeCtx('target');
    const off = fakeCtx('offscreen');
    target.ctx.canvas = { width: 900, height: 640 };
    off.ctx.canvas = { width: 900, height: 640 };

    assert.equal(drawEvaluated(target.ctx, ev, 0, {
        filterFor,
        layerSurface: { canvas: { width: 900, height: 640 }, ctx: off.ctx },
    }), true);
    assert.equal(off.log.draws, 0);
    assert.equal(target.log.draws, 1);
    assert.equal(target.log.filteredDraws, 1);
});
