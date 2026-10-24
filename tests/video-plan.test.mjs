import test from 'node:test';
import assert from 'node:assert/strict';
import {
    VIDEO_MIME_LIST, pickVideoMime, videoBitrate, videoCanvasSize, videoFps, videoFrameCount, videoSeconds,
} from '../app/shell/video-plan.mjs';

test('pickVideoMime：按 vp9 → vp8 → webm 的顺序挑第一个支持的', () => {
    assert.equal(pickVideoMime(() => true), VIDEO_MIME_LIST[0]);
    assert.equal(pickVideoMime((m) => m.includes('vp8') || m === 'video/webm'), VIDEO_MIME_LIST[1]);
    assert.equal(pickVideoMime((m) => m === 'video/webm'), 'video/webm');
    assert.equal(pickVideoMime(() => false), '');
});

test('pickVideoMime：不支持函数 / 回调抛错都安全返回空串或继续试', () => {
    assert.equal(pickVideoMime(null), '');
    assert.equal(pickVideoMime(undefined), '');
    const flaky = (m) => {
        if (m.includes('vp9')) throw new Error('boom');
        return m.includes('vp8');
    };
    assert.equal(pickVideoMime(flaky), VIDEO_MIME_LIST[1]);
});

test('pickVideoMime：可以传入自定义候选表', () => {
    assert.equal(pickVideoMime(() => true, ['video/webm']), 'video/webm');
    assert.equal(pickVideoMime(() => true, []), VIDEO_MIME_LIST[0]);
});

test('videoFps：夹到 1..60，非法回落到文档帧率再回落 12', () => {
    assert.equal(videoFps(24, 12), 24);
    assert.equal(videoFps(0, 12), 12);
    assert.equal(videoFps('x', 30), 30);
    assert.equal(videoFps(null, null), 12);
    assert.equal(videoFps(999, 12), 60);
    assert.equal(videoFps(-5, 12), 12);
});

test('videoSeconds：夹到 0.1..600，非法回落到文档时长再回落 1', () => {
    assert.equal(videoSeconds(3, 1), 3);
    assert.equal(videoSeconds(0, 2.5), 2.5);
    assert.equal(videoSeconds(null, null), 1);
    assert.equal(videoSeconds(1e9, 1), 600);
    assert.equal(videoSeconds(0.01, 1), 0.1);
});

test('videoFrameCount：至少 1 帧且按四舍五入', () => {
    assert.equal(videoFrameCount(1, 12), 12);
    assert.equal(videoFrameCount(0.5, 24), 12);
    assert.equal(videoFrameCount(1, 2.4), 2);
    assert.equal(videoFrameCount(0, 12), 1);
    assert.equal(videoFrameCount(NaN, NaN), 1);
});

test('videoCanvasSize：取整并至少 1×1', () => {
    assert.deepEqual(videoCanvasSize(900, 640), { width: 900, height: 640 });
    assert.deepEqual(videoCanvasSize(900.6, 640.2), { width: 901, height: 640 });
    assert.deepEqual(videoCanvasSize(0, -10), { width: 1, height: 1 });
    assert.deepEqual(videoCanvasSize(undefined, undefined), { width: 1, height: 1 });
});

test('videoBitrate：按像素×帧率估，下限 1.2 Mbps', () => {
    // 900×640@12 的估算值 829440 低于下限，所以会被抬到 1.2 Mbps
    assert.equal(videoBitrate(900, 640, 12), 1200000);
    assert.equal(videoBitrate(10, 10, 1), 1200000);
    // 超过下限时按公式走
    assert.equal(videoBitrate(1920, 1080, 30), Math.round(1920 * 1080 * 30 * 0.12));
    assert.ok(videoBitrate(1920, 1080, 30) > videoBitrate(900, 640, 12));
});
