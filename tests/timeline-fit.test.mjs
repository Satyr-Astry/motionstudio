// createDoc / fitZoom（双击刻度尺 = 适应全长）单测。
// fitZoom 是纯算术：把整段时长装进可用宽度所需的 zoomX，并夹在 [ZOOM_MIN, ZOOM_MAX]。
// 面板只负责「可用宽度 = 行区宽度 − 左侧名列 − 右侧留白」这一步换算。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDoc } from '../app/core/doc-model.mjs';
import { docDuration } from '../app/core/doc-model.mjs';
import { ZOOM_MIN, ZOOM_MAX, fitZoom, pxPerSecond, timeToX } from '../app/editors/timeline-geo.mjs';

const doc2s = () => createDoc({ width: 900, height: 640, fps: 12, duration: 2 });

test('fitZoom：2 秒 / 12fps 在 600px 里恰好装下（28*12*2 = 672px → 0.893×）', () => {
    const doc = doc2s();
    const z = fitZoom(doc, 600);
    assert.ok(Math.abs(z - 600 / 672) < 1e-12, 'zoomX = avail / (total * pxPerSecond(1))');
    // 闭环：按这个缩放换算回去，正好等于可用宽度
    assert.ok(Math.abs(timeToX(doc, docDuration(doc), z) - 600) < 1e-9);
});

test('fitZoom：可用宽度很大时夹到 ZOOM_MAX，很小时夹到 ZOOM_MIN', () => {
    assert.equal(fitZoom(doc2s(), 100000), ZOOM_MAX);
    assert.equal(fitZoom(doc2s(), 1), ZOOM_MIN);
});

test('fitZoom：时长为 0 / 可用宽度非正 / doc 缺 fps 一律返回 null（不猜）', () => {
    assert.equal(fitZoom(createDoc({ duration: 0 }), 600), null);
    assert.equal(fitZoom(doc2s(), 0), null);
    assert.equal(fitZoom(doc2s(), -10), null);
    assert.equal(fitZoom(doc2s(), NaN), null);
    assert.equal(fitZoom(null, 600), null);
    // fps 被钳到 >= 1，pxPerSecond 不会为 0；这里钉住「不会因 fps 异常而返回 0 或 NaN」
    const odd = fitZoom(createDoc({ fps: 0, duration: 1 }), 600);
    assert.ok(Number.isFinite(odd) && odd > 0);
});

test('fitZoom：结果是「装下」，不是「贴边」—— pxPerSecond 单调，zoom 加倍时间轴就加倍', () => {
    const doc = doc2s();
    const z = fitZoom(doc, 1200);
    assert.ok(Math.abs(pxPerSecond(doc, z) / pxPerSecond(doc, z / 2) - 2) < 1e-12);
});
