// 导出路径的「warp + 效果」离屏合成（0.12.1 性能/正确性修复的回归守卫）。
//
// 背景：导出 / 缩略图 / 录制以前都不给 compositeFrame 传 filterFor，效果器只在画布上
// 生效；补上之后又会踩到「warp 每个子格一次 drawImage、滤镜跑 N 遍还留接缝」的老问题。
// composite.drawLayer 现在支持 opts.layerSurface：先不带滤镜画进离屏，再整层一次滤镜合回。
import test from 'node:test';
import assert from 'node:assert/strict';

import { drawLayer } from '../app/paint/composite.mjs';

function fakeCtx(label) {
    const log = { label, draws: 0, filteredDraws: 0, filters: new Set(), clips: 0, transforms: 0 };
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
        fillRect() {},
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

const IMG = { width: 160, height: 120 };

/** 3×3 顶点网格（真实 warp 的编辑器形状），四角都有明显偏移。 */
const PTS = [
    [10, -8], [0, 0], [12, 6],
    [0, 0], [0, 0], [0, 0],
    [6, 10], [0, 0], [-10, -6],
];

function warpLayer() {
    return {
        id: 'o1',
        name: 'warped',
        kind: 'image',
        opacity: 1,
        cels: [{ at: 0, image: IMG }],
        transform: {
            keys: [{
                t: 0,
                ease: 'linear',
                h1: null,
                h2: null,
                state: {
                    x: 0, y: 0, scaleX: 1, scaleY: 1, rotate: 0, skewX: 0, skewY: 0,
                    opacity: 1, warp: { cols: 2, rows: 2, pts: PTS },
                },
            }],
        },
    };
}

const doc = { width: 900, height: 640, fps: 12, duration: 3, objects: [warpLayer()], drawOrder: ['o1'] };
const layer = doc.objects[0];
const blur = () => 'blur(8px)';

function run(opts) {
    const target = fakeCtx('target');
    target.ctx.canvas = { width: 900, height: 640 };
    const painted = drawLayer(target.ctx, doc, layer, 0, opts);
    return { painted, target };
}

test('warp + 效果 + layerSurface：离屏按网格画，目标只做一次带滤镜的合成', () => {
    const off = fakeCtx('offscreen');
    off.ctx.canvas = { width: 900, height: 640 };
    const { painted, target } = run({ filterFor: blur, layerSurface: { canvas: off.ctx.canvas, ctx: off.ctx } });

    assert.equal(painted, true);
    assert.ok(off.log.draws > 1, `离屏应画多片网格，实际 ${off.log.draws}`);
    assert.equal(off.log.filteredDraws, 0, '离屏里绝不能逐片套滤镜');
    assert.equal(off.log.filters.has('none'), true);
    assert.equal(off.log.clips > 0, true);

    assert.equal(target.log.draws, 1);
    assert.equal(target.log.filteredDraws, 1);
    assert.ok([...target.log.filters].some((f) => f.includes('blur')));
});

test('warp + 效果、没有离屏缓冲：退回逐片滤镜（旧行为，导出仍能出图）', () => {
    const { painted, target } = run({ filterFor: blur });
    assert.equal(painted, true);
    assert.ok(target.log.draws > 1);
    assert.equal(target.log.filteredDraws, target.log.draws);
});

test('warp 但效果为 none：不进离屏（不白跑一趟）', () => {
    const off = fakeCtx('offscreen');
    off.ctx.canvas = { width: 900, height: 640 };
    const { painted, target } = run({ filterFor: () => 'none', layerSurface: { canvas: off.ctx.canvas, ctx: off.ctx } });
    assert.equal(painted, true);
    assert.equal(off.log.draws, 0);
    assert.ok(target.log.draws > 1);
    assert.equal(target.log.filteredDraws, 0);
});

test('没有 warp：效果仍然是单次 drawImage（不经过离屏）', () => {
    const plain = warpLayer();
    plain.transform.keys[0].state.warp = null;
    const plainDoc = { width: 900, height: 640, fps: 12, duration: 3, objects: [plain], drawOrder: ['o1'] };
    const off = fakeCtx('offscreen');
    off.ctx.canvas = { width: 900, height: 640 };
    const target = fakeCtx('target');
    target.ctx.canvas = { width: 900, height: 640 };
    assert.equal(drawLayer(target.ctx, plainDoc, plain, 0, {
        filterFor: blur,
        layerSurface: { canvas: off.ctx.canvas, ctx: off.ctx },
    }), true);
    assert.equal(off.log.draws, 0);
    assert.equal(target.log.draws, 1);
    assert.equal(target.log.filteredDraws, 1);
});
