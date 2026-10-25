/**
 * 精灵图 trim（去空白）：`trimCellBox` 的矩形语义 + `buildSpritesheets` 的落图位置
 *
 * 坐标系约定（写一次，别混）：
 * - `x/y/w/h` = **格在图集里的位置**，从不因 trim 改变；
 * - `sx/sy/sw/sh` = **内容在原帧坐标系里**的矩形（`sx/sy` 相对原始帧左上角）；
 * - `trimmed` = 这一格是否真的裁过（全透明格保留整格并标 false）。
 *
 * 消费方（Phaser 的 `frame` / `spriteSourceSize`）靠的是「格位 + 偏移」两套一起用，
 * 所以下面既钉 `trimCellBox` 的数值，也钉 `buildSpritesheets` 里 `x/y` 没被 trim 动过。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { trimCellBox, buildSpritesheets, sheetLayout } from '../app/shell/spritesheet.mjs';

/** 造一块 w×h 的 RGBA，`on(x,y)` 返回 true 的位置 alpha=255，其余为 0。 */
function rgba(w, h, on) {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            if (on && on(x, y)) {
                px[i] = 200;
                px[i + 1] = 100;
                px[i + 2] = 50;
                px[i + 3] = 255;
            }
        }
    }
    return px;
}

/** 只记调用、不真的画：`buildSpritesheets` 只要求 getContext 返回能用的一套方法。 */
function fakeCanvas(w, h) {
    const drawn = [];
    const cv = {
        width: w,
        height: h,
        __drawn: drawn,
        getContext() {
            return {
                setTransform() {},
                clearRect() {},
                fillRect() {},
                getImageData() {
                    return { data: new Uint8ClampedArray(w * h * 4) };
                },
                drawImage(...args) {
                    drawn.push(args.length >= 9
                        ? { sx: args[1], sy: args[2], sw: args[3], sh: args[4], x: args[5], y: args[6] }
                        : { x: args[1], y: args[2] });
                },
            };
        },
    };
    return cv;
}

function doc(w = 20, h = 10, frames = 3) {
    return { width: w, height: h, duration: frames / 10, fps: 10, objects: [] };
}

test('内容在左上角外侧留白：sx/sy 给出内容偏移，sw/sh 给出内容尺寸', () => {
    const box = trimCellBox(rgba(8, 6, (x, y) => x >= 2 && x < 6 && y >= 1 && y < 5), 8, 6);
    assert.deepEqual(box, { sx: 2, sy: 1, sw: 4, sh: 4, trimmed: true });
});

test('单像素内容：矩形塌到 1×1，仍算裁过', () => {
    const box = trimCellBox(rgba(5, 5, (x, y) => x === 3 && y === 4), 5, 5);
    assert.deepEqual(box, { sx: 3, sy: 4, sw: 1, sh: 1, trimmed: true });
});

test('内容占满整格：trimmed=false，矩形就是整格（不用白改坐标）', () => {
    const box = trimCellBox(rgba(4, 3, () => true), 4, 3);
    assert.deepEqual(box, { sx: 0, sy: 0, sw: 4, sh: 3, trimmed: false });
});

test('全透明格：保留整格并标 trimmed=false（否则消费方会拿到 0×0 帧）', () => {
    const box = trimCellBox(rgba(6, 4, () => false), 6, 4);
    assert.deepEqual(box, { sx: 0, sy: 0, sw: 6, sh: 4, trimmed: false });
});

test('坏输入（空缓冲 / null）一律退回整格，不抛', () => {
    assert.deepEqual(trimCellBox(null, 3, 2), { sx: 0, sy: 0, sw: 3, sh: 2, trimmed: false });
    assert.deepEqual(trimCellBox(new Uint8ClampedArray(0), 3, 2), { sx: 0, sy: 0, sw: 3, sh: 2, trimmed: false });
});

test('sx/sy 能把内容放回原处：格位 + 偏移 = 内容在整图里的真实位置', () => {
    // 格在 (40, 20)，内容在格内的 (3, 2)
    const cellX = 40;
    const cellY = 20;
    const box = trimCellBox(rgba(10, 8, (x, y) => x >= 3 && x < 7 && y >= 2 && y < 6), 10, 8);
    assert.equal(cellX + box.sx, 43);
    assert.equal(cellY + box.sy, 22);
    // 内容尺寸没变
    assert.equal(box.sw, 4);
    assert.equal(box.sh, 4);
});

test('buildSpritesheets：开了 trim 时按内容矩形贴图，格位 x/y 不动', () => {
    const res = buildSpritesheets(doc(20, 10, 2), {
        createCanvas: fakeCanvas,
        // 每格内容固定在左上角留白 (2,1) 起 6×5 —— 用注入读像素免得碰真画布
        readCellAlpha: () => rgba(20, 10, (x, y) => x >= 2 && x < 8 && y >= 1 && y < 6),
    });
    assert.equal(res.ok, true);
    assert.equal(res.sheets.length, 1);
    const sheet = res.sheets[0];
    for (const f of sheet.frames) {
        assert.equal(f.trimmed, true);
        assert.deepEqual([f.sx, f.sy, f.sw, f.sh], [2, 1, 6, 5]);
    }
    // 两张贴图的起点严格等于「格位 + 内容偏移」的格位部分 —— x/y 本身没被 trim 改动
    const drawn = sheet.canvas.__drawn;
    assert.deepEqual(drawn.map((d) => [d.x, d.y]), sheet.frames.map((f) => [f.x, f.y]));
    // 源矩形就是内容矩形（从格画布上裁出来贴）
    assert.deepEqual([drawn[0].sx, drawn[0].sy, drawn[0].sw, drawn[0].sh], [2, 1, 6, 5]);
});

test('buildSpritesheets：trim:false 时贴整格，帧的 sx/sy 全是 0', () => {
    const res = buildSpritesheets(doc(20, 10, 2), { createCanvas: fakeCanvas, trim: false });
    assert.equal(res.ok, true);
    for (const f of res.sheets[0].frames) {
        assert.deepEqual([f.sx, f.sy, f.sw, f.sh, f.trimmed], [0, 0, 20, 10, false]);
    }
});

test('buildSpritesheets：读不到像素（假画布/替身）时退回不裁，不抛', () => {
    const res = buildSpritesheets(doc(12, 8, 2), {
        createCanvas: fakeCanvas,
        readCellAlpha: () => null,
    });
    assert.equal(res.ok, true);
    for (const f of res.sheets[0].frames) assert.equal(f.trimmed, false);
});

test('buildSpritesheets：全透明格保留整格，且不影响别的格', () => {
    let call = 0;
    const res = buildSpritesheets(doc(16, 8, 2), {
        createCanvas: fakeCanvas,
        readCellAlpha: () => {
            call += 1;
            // 第一帧全透明，第二帧有内容
            return call === 1 ? rgba(16, 8, () => false) : rgba(16, 8, (x, y) => x >= 4 && x < 9 && y >= 2 && y < 6);
        },
    });
    assert.equal(res.ok, true);
    const frames = res.sheets[0].frames;
    assert.deepEqual([frames[0].sx, frames[0].sy, frames[0].sw, frames[0].sh, frames[0].trimmed], [0, 0, 16, 8, false]);
    assert.deepEqual([frames[1].sx, frames[1].sy, frames[1].sw, frames[1].sh, frames[1].trimmed], [4, 2, 5, 4, true]);
});

test('sheetLayout 的帧矩形与 trim 无关（trim 只动贴图，不动布局）', () => {
    const layout = sheetLayout(doc(20, 10, 3), {});
    assert.deepEqual(layout.frames.map((f) => [f.x, f.y, f.w, f.h]),
        [[0, 0, 20, 10], [20, 0, 20, 10], [40, 0, 20, 10]]);
});
