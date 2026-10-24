import test from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeSegments,
    hasTimebase,
    fpsAt,
    segmentIndexAt,
    segmentRange,
    addSegment,
    removeSegment,
    setSegmentFps,
    setSegmentAt,
    resetTimebase,
    sampleTimes,
    MIN_FPS,
    MAX_FPS,
    MAX_SEGMENTS,
} from '../app/core/timebase.mjs';

const doc = (extra) => Object.assign({ width: 100, height: 100, fps: 12, frames: [] }, extra || {});

test('缺省 timebase = 单段且等于 doc.fps', () => {
    const d = doc();
    const segs = normalizeSegments(d);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].at, 0);
    assert.equal(segs[0].fps, 12);
    assert.equal(hasTimebase(d), false);
});

test('normalizeSegments 强制首段 at=0 并按时间排序', () => {
    const d = doc({ timebase: { segments: [{ at: 2, fps: 30 }, { at: 0, fps: 6 }] } });
    const segs = normalizeSegments(d);
    assert.deepEqual(segs.map((s) => s.at), [0, 2]);
    assert.deepEqual(segs.map((s) => s.fps), [6, 30]);
});

test('normalizeSegments 丢弃非法项与重复时间点', () => {
    const d = doc({
        timebase: {
            segments: [
                { at: 0, fps: 12 },
                { at: 0, fps: 24 },
                { at: -3, fps: 10 },
                { at: 'x', fps: 10 },
                null,
                { at: 1, fps: 12 },
                { at: 1.00000001, fps: 30 },
            ],
        },
    });
    const segs = normalizeSegments(d);
    assert.deepEqual(segs.map((s) => s.at), [0, 1]);
});

test('fps 被夹在 [MIN_FPS, MAX_FPS]', () => {
    const d = doc({ timebase: { segments: [{ at: 0, fps: 0 }, { at: 1, fps: 9999 }] } });
    const segs = normalizeSegments(d);
    assert.equal(segs[0].fps, 12); // 非法 → 回退 doc.fps
    assert.equal(segs[1].fps, MAX_FPS);
    const d2 = doc({ timebase: { segments: [{ at: 0, fps: -5 }] } });
    assert.equal(normalizeSegments(d2)[0].fps, 12);
    assert.ok(MIN_FPS >= 1);
});

test('段数上限', () => {
    const segments = [];
    for (let i = 0; i < MAX_SEGMENTS + 10; i++) segments.push({ at: i, fps: 12 + (i % 5) });
    const segs = normalizeSegments(doc({ timebase: { segments } }));
    assert.equal(segs.length, MAX_SEGMENTS);
});

test('fpsAt 命中正确的段（边界包含）', () => {
    const d = doc({ timebase: { segments: [{ at: 0, fps: 12 }, { at: 2, fps: 24 }, { at: 5, fps: 6 }] } });
    assert.equal(fpsAt(d, 0), 12);
    assert.equal(fpsAt(d, 1.99), 12);
    assert.equal(fpsAt(d, 2), 24);
    assert.equal(fpsAt(d, 4.9), 24);
    assert.equal(fpsAt(d, 5), 6);
    assert.equal(fpsAt(d, 99), 6);
});

test('segmentIndexAt / segmentRange', () => {
    const d = doc({ timebase: { segments: [{ at: 0, fps: 12 }, { at: 2, fps: 24 }] } });
    assert.equal(segmentIndexAt(d, 0.5), 0);
    assert.equal(segmentIndexAt(d, 2.5), 1);
    assert.deepEqual(segmentRange(d, 0, 6), { at: 0, end: 2, fps: 12 });
    assert.deepEqual(segmentRange(d, 1, 6), { at: 2, end: 6, fps: 24 });
});

test('addSegment 落在已有时间点只改 fps', () => {
    const d = doc();
    const a = addSegment(d, 0, 30);
    assert.equal(normalizeSegments(a)[0].fps, 30);
    const b = addSegment(a, 3, 24);
    assert.equal(normalizeSegments(b).length, 2);
    assert.equal(fpsAt(b, 3.5), 24);
    assert.equal(fpsAt(b, 2), 30);
});

test('addSegment 不可变', () => {
    const d = doc();
    const b = addSegment(d, 1, 24);
    assert.equal(d.timebase, undefined);
    assert.equal(normalizeSegments(b).length, 2);
});

test('removeSegment 至少保留一段', () => {
    const d = doc({ timebase: { segments: [{ at: 0, fps: 12 }, { at: 2, fps: 24 }] } });
    const one = removeSegment(d, 1);
    assert.equal(normalizeSegments(one).length, 1);
    const still = removeSegment(one, 0);
    assert.equal(normalizeSegments(still).length, 1);
});

test('setSegmentFps / resetTimebase', () => {
    const d = doc({ timebase: { segments: [{ at: 0, fps: 12 }, { at: 2, fps: 24 }] } });
    const s = setSegmentFps(d, 1, 30);
    assert.equal(fpsAt(s, 2), 30);
    const r = resetTimebase(d);
    assert.equal(normalizeSegments(r).length, 1);
    assert.equal(normalizeSegments(r)[0].fps, 12);
    assert.equal(hasTimebase(r), false);
});

test('setSegmentAt 夹在相邻段之间且不动首段', () => {
    const d = doc({ timebase: { segments: [{ at: 0, fps: 12 }, { at: 2, fps: 24 }, { at: 4, fps: 30 }] } });
    const moved = setSegmentAt(d, 1, 10);
    assert.equal(normalizeSegments(moved)[1].at, 4 - 1e-3);
    const lo = setSegmentAt(d, 1, -5);
    assert.ok(normalizeSegments(lo)[1].at > 0);
    assert.equal(setSegmentAt(d, 0, 3), d); // 首段不可动
});

test('sampleTimes 单段按 1/fps 铺满', () => {
    const d = doc();
    const ts = sampleTimes(d, 1);
    assert.equal(ts.length, 12);
    assert.equal(ts[0].t, 0);
    assert.equal(ts[11].t, Math.round((11 / 12) * 1e6) / 1e6);
    assert.ok(ts.every((x) => x.fps === 12));
});

test('sampleTimes 多段各按自己的帧率', () => {
    const d = doc({ timebase: { segments: [{ at: 0, fps: 12 }, { at: 1, fps: 24 }] } });
    const ts = sampleTimes(d, 2);
    const first = ts.filter((x) => x.t < 1);
    const second = ts.filter((x) => x.t >= 1);
    assert.equal(first.length, 12);
    assert.equal(second.length, 24);
    assert.ok(first.every((x) => x.fps === 12));
    assert.ok(second.every((x) => x.fps === 24));
});

test('sampleTimes 边界与空片', () => {
    assert.deepEqual(sampleTimes(doc(), 0), []);
    const d = doc({ timebase: { segments: [{ at: 0, fps: 10 }, { at: 0.25, fps: 40 }] } });
    const ts = sampleTimes(d, 0.5);
    assert.equal(ts.length, 3 + 10); // 0,0.1,0.2 + 0.25..0.475 十点
    assert.equal(ts[3].t, 0.25);
});

test('sampleTimes 不产生与段起点重复的时间', () => {
    const d = doc({ timebase: { segments: [{ at: 0, fps: 12 }, { at: 0.5, fps: 12 }] } });
    const ts = sampleTimes(d, 1);
    const uniq = new Set(ts.map((x) => x.t));
    assert.equal(uniq.size, ts.length);
    assert.equal(ts.length, 12);
});
