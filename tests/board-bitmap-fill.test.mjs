// 导入位图的油漆桶（A1）：`board.mjs` 的 `fillImportedBitmap` + `app.mjs` 的 `setCelImage`。
//
// 背景：导入的 PNG/PSD 纹理是 `ImageBitmap`（没有 `getContext`），画板其它工具原地改画布，
// 它改不了；而**同一张位图可能被多个关键帧共享**，所以也不能就地替换。
// 做法是「复制到离屏画布 → 填充 → 用 setCelImage 写回当前关键帧的 drawing」，
// 写回与其它画板写路径一样是「一次 setDoc、一步撤销」。
//
// node 里没有 canvas / ImageBitmap，所以这里只能做源码守卫 + 纯逻辑验证。
// 真正的像素行为靠 `npm run smoke` 与真机手测。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { floodFillRegion } from '../app/paint/fill.mjs';

const BOARD = readFileSync(new URL('../app/editors/board.mjs', import.meta.url), 'utf8');
const APP = readFileSync(new URL('../app/shell/app.mjs', import.meta.url), 'utf8');

test('画板：导入位图不再直接拒绝，而是走 fillImportedBitmap', () => {
    assert.ok(BOARD.includes('function fillImportedBitmap('), '缺 fillImportedBitmap');
    assert.ok(BOARD.includes('return fillImportedBitmap(e)'), 'bitmap 分支没有转过去');
    // 老外壳（没有 ctx.setCelImage）才用「不支持」提示 —— 这条兜底必须留着
    assert.ok(/typeof c\.setCelImage !== 'function'[\s\S]{0,120}board\.bucket\.imported/.test(BOARD),
        '缺「老外壳」兜底提示');
});

test('画板：复制到位图大小的离屏画布上，且用同一套 floodFillRegion', () => {
    assert.ok(BOARD.includes('const cv = createSurface(W, H)'), '离屏画布尺寸必须跟位图一致');
    assert.ok(BOARD.includes('g.drawImage(src, 0, 0)'), '没把位图画进离屏画布');
    assert.ok(BOARD.includes('floodFillRegion(frame.data, W, H, x, y, color)'), '填充算法没复用同一个');
    assert.ok(BOARD.includes('c.setCelImage(obj.id, cv)'), '结果没写回纹理');
    // 写回之后要刷新叠加层与合成
    assert.ok(/c\.setCelImage\(obj\.id, cv\)[\s\S]{0,200}requestRender/.test(BOARD), '写回后没请求重绘');
});

test('shell：setCelImage 走 setImageAt（与落笔克隆同一条真源路径），并带 undo 标签', () => {
    assert.ok(APP.includes('function setCelImage(layerId, image)'), '缺 setCelImage');
    assert.ok(APP.includes('setImageAt(res.obj, at, image)'), '必须用 setImageAt 写回关键帧的 drawing');
    assert.ok(APP.includes("label: t('shell.cel.replaceImage')"), '缺 undo 标签');
    // 两处 ctx 都要暴露（主 ctx + view-host ctx）
    const exposed = APP.split('setCelImage,').length - 1;
    assert.ok(exposed >= 2, 'setCelImage 至少要在两处 ctx 暴露，实际 ' + exposed);
});

test('纯逻辑：填充算法本身对「全透明」与「有内容」两种位图都给出结果', () => {
    // 4×2 全透明
    const clear = new Uint8ClampedArray(4 * 2 * 4);
    const r1 = floodFillRegion(clear, 4, 2, 1, 1, '#ff0000');
    assert.equal(r1.changed, true, '全透明位图也应能整片填色');
    assert.equal(r1.painted, 8, '应当填满 8 个像素');
    // 同色再填一次 → 不改
    const r2 = floodFillRegion(clear, 4, 2, 0, 0, '#ff0000');
    assert.equal(r2.changed, false, '已经是目标色时不该产生改动');
    // 越界坐标 → 不改
    const r3 = floodFillRegion(clear, 4, 2, 99, 99, '#00ff00');
    assert.equal(r3.changed, false, '越界点不该改动');
});
