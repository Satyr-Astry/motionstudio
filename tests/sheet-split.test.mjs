/**
 * 精灵图分张（splitSheetLayout）与帧表（sheetJSON / phaserJSON）
 *
 * 全走纯函数，不解码、不落盘。分张的判据是「每张边长 ≤ maxTextureSize」，
 * 最容易写错的两处：① 单帧就超限时该报错而不是硬切；② 切完之后帧的 `index`
 * 仍是全局序号、`x/y` 是**张内**坐标（消费方按 `sheets[]` 顺序加载才对得上）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    sheetLayout,
    splitSheetLayout,
    sheetJSON,
    phaserJSON,
} from '../app/shell/spritesheet.mjs';

/** 64×32、1 秒 12fps 的文档 → 12 个采样点。 */
function baseDoc(w = 64, h = 32, duration = 1, fps = 12) {
    return { width: w, height: h, duration, fps, objects: [] };
}

test('不超限时保持单张，帧数组原样（兼容旧行为）', () => {
    const layout = sheetLayout(baseDoc(), {});
    const out = splitSheetLayout(layout, 4096);
    assert.equal(out.ok, true);
    assert.equal(out.sheets.length, 1);
    const one = out.sheets[0];
    assert.equal(one.file, 'sheet-1.png');
    assert.equal(one.width, layout.width);
    assert.equal(one.height, layout.height);
    assert.deepEqual(one.frames, layout.frames);
});

test('恰好塞满：perSheet == 帧数时只出一张', () => {
    // 12 帧、每张最多 1 列 × 3 行 = 3 格 → 12 帧要 4 张；
    // 这里让上限刚好容纳 12 格：6 列 × 2 行
    const layout = sheetLayout(baseDoc(), {});
    const perRow = 6 * 64;
    const out = splitSheetLayout(layout, Math.max(perRow, 2 * 32));
    assert.equal(out.ok, true);
    assert.equal(out.sheets.length, 1);
    assert.equal(out.sheets[0].frames.length, 12);
});

test('放不下就多一张，帧按顺序连续切', () => {
    const layout = sheetLayout(baseDoc(), {});
    // 上限 64：1 列（64 宽）× 2 行（32 高 ×2）= 每张 2 格 → 12 帧切 6 张
    const out = splitSheetLayout(layout, 64);
    assert.equal(out.ok, true);
    assert.equal(out.sheets.length, 6);
    assert.deepEqual(out.sheets.map((s) => s.frames.length), new Array(6).fill(2));
    // 全局 index 连续、不重排
    const idx = out.sheets.flatMap((s) => s.frames.map((f) => f.index));
    assert.deepEqual(idx, layout.frames.map((f) => f.index));
});

test('每张的宽高都不超过上限', () => {
    const layout = sheetLayout(baseDoc(100, 50), {});
    const max = 400;
    const out = splitSheetLayout(layout, max);
    assert.equal(out.ok, true);
    for (const s of out.sheets) {
        assert.ok(s.width <= max, '宽超限：' + s.width);
        assert.ok(s.height <= max, '高超限：' + s.height);
    }
    // 总格数守恒
    assert.equal(out.sheets.reduce((n, s) => n + s.frames.length, 0), layout.frames.length);
});

test('sheets 与文件一一对应：文件名递增、顺序即播放顺序', () => {
    const layout = sheetLayout(baseDoc(), {});
    const out = splitSheetLayout(layout, 96);
    assert.equal(out.ok, true);
    assert.deepEqual(out.sheets.map((s) => s.file), out.sheets.map((_, i) => 'sheet-' + (i + 1) + '.png'));
});

test('单帧本身就超过上限：明确报错，不产出超限图', () => {
    const layout = sheetLayout(baseDoc(5000, 20), {});
    const out = splitSheetLayout(layout, 4096);
    assert.equal(out.ok, false);
    assert.match(out.reason, /单帧 5000px 超过图集上限 4096px/);
    assert.deepEqual(out.sheets, []);
});

test('没有可导出的帧：报错而不是返回空图集', () => {
    assert.equal(splitSheetLayout({ frames: [] }, 4096).ok, false);
    assert.equal(splitSheetLayout(null, 4096).ok, false);
    assert.equal(splitSheetLayout({ frames: [] }, 4096).reason, '没有可导出的帧');
});

test('sheetJSON：sheets[] 与帧的 sx/sy/sw/sh/trimmed 默认值（等价旧帧表）', () => {
    const layout = sheetLayout(baseDoc(), {});
    const json = sheetJSON(layout);
    assert.deepEqual(json.sheets, [{ file: 'sheet-1.png', width: layout.width, height: layout.height }]);
    for (const f of json.frames) {
        assert.equal(f.sx, 0);
        assert.equal(f.sy, 0);
        assert.equal(f.sw, f.w);
        assert.equal(f.sh, f.h);
        assert.equal(f.trimmed, false);
    }
});

test('phaserJSON：frame 是内容在图集里的矩形，spriteSourceSize 是内容在原帧里的矩形', () => {
    const sheet = {
        width: 128,
        height: 64,
        cellWidth: 64,
        cellHeight: 32,
        frames: [{
            index: 7, x: 64, y: 0, w: 64, h: 32, t: 0.5, duration: 0.0833,
            sx: 10, sy: 6, sw: 20, sh: 12, trimmed: true,
        }],
    };
    const json = phaserJSON(sheet, { image: 'sheet-2.png' });
    const f = json.frames.frame_0007;
    // 内容在图集里的位置 = 格位 + 偏移
    assert.deepEqual(f.frame, { x: 74, y: 6, w: 20, h: 12 });
    assert.deepEqual(f.spriteSourceSize, { x: 10, y: 6, w: 20, h: 12 });
    assert.deepEqual(f.sourceSize, { w: 64, h: 32 });
    assert.equal(f.rotated, false);
    assert.equal(f.trimmed, true);
    assert.equal(json.meta.image, 'sheet-2.png');
    assert.equal(json.meta.frameCount, 1);
    assert.equal(json.meta.size.w, 128);
});

test('phaserJSON：没裁过的帧 trimmed=false，frame 等于格位', () => {
    const sheet = {
        width: 64, height: 32, cellWidth: 64, cellHeight: 32,
        frames: [{ index: 0, x: 0, y: 0, w: 64, h: 32, t: 0, duration: 0.0833 }],
    };
    const f = phaserJSON(sheet).frames.frame_0000;
    assert.equal(f.trimmed, false);
    assert.deepEqual(f.frame, { x: 0, y: 0, w: 64, h: 32 });
    assert.deepEqual(f.spriteSourceSize, { x: 0, y: 0, w: 64, h: 32 });
});

test('phaserJSON 帧名补四位，与 Phaser 的 generateFrameNames 对得上', () => {
    const sheet = {
        width: 64, height: 32, cellWidth: 64, cellHeight: 32,
        frames: [0, 1, 2].map((i) => ({ index: i, x: i * 0, y: 0, w: 64, h: 32, t: 0, duration: 0.0833 })),
    };
    const names = Object.keys(phaserJSON(sheet).frames);
    assert.deepEqual(names, ['frame_0000', 'frame_0001', 'frame_0002']);
});

test('phaserJSON 对空输入返回 null，不抛', () => {
    assert.equal(phaserJSON(null), null);
    assert.equal(phaserJSON({}), null);
});
