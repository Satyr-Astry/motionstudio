import test from 'node:test';
import assert from 'node:assert/strict';

import {
    EXPORT_DEFAULTS,
    EXPORT_CHUNK,
    SCALE_MIN,
    SCALE_MAX,
    FPS_MIN,
    FPS_MAX,
    normalizeExportOptions,
    effectiveFps,
    frameCount,
    sampleTimesFor,
    uniqueDirName,
    chunkPlan,
} from '../app/core/export-options.mjs';

const DOC = { width: 900, height: 640, fps: 12, duration: 2 };

test('frameCount：左闭右开，四组验收数字', () => {
    assert.equal(frameCount({ from: 0, to: 1, fps: 12 }), 12, '0–1s@12 必须正好 12 帧');
    assert.equal(frameCount({ from: 0.5, to: 2.0, fps: 24 }), 36, '0.5–2.0s@24 必须是 36 帧，不是 37');
    assert.equal(frameCount({ from: 0, to: 0.04, fps: 24 }), 1, '最短非空区间也要给 1 帧');
    assert.equal(frameCount({ from: 1, to: 1, fps: 24 }), 0, 'out == in 是空区间');
    assert.equal(frameCount({ from: 2, to: 1, fps: 24 }), 0, 'out < in 也是空区间');
});

test('frameCount：坏输入一律 0，不抛也不猜', () => {
    assert.equal(frameCount(null), 0);
    assert.equal(frameCount({}), 0);
    assert.equal(frameCount({ from: 0, to: 1, fps: 0 }), 0);
    assert.equal(frameCount({ from: 0, to: 1, fps: -5 }), 0);
    assert.equal(frameCount({ from: NaN, to: 1, fps: 12 }), 0);
    assert.equal(frameCount({ from: 0, to: Infinity, fps: 12 }), 0, 'Infinity 不是有限数');
});

test('sampleTimesFor：长度恒等于 frameCount，首元素是 from，末元素严格小于 to', () => {
    const cases = [
        { from: 0, to: 1, fps: 12 },
        { from: 0.5, to: 2.0, fps: 24 },
        { from: 0, to: 0.04, fps: 24 },
        { from: 0.25, to: 2, fps: 30 },
    ];
    for (const c of cases) {
        const ts = sampleTimesFor(c);
        assert.equal(ts.length, frameCount(c), JSON.stringify(c) + ' 的长度必须与 frameCount 一致');
        assert.equal(ts[0], c.from);
        assert.ok(ts[ts.length - 1] < c.to, JSON.stringify(c) + ' 的末元素必须严格小于出点');
        for (let i = 1; i < ts.length; i++) {
            assert.ok(ts[i] > ts[i - 1], '时刻必须严格递增');
        }
    }
    assert.deepEqual(sampleTimesFor({ from: 0, to: 1, fps: 12 }).slice(0, 3), [0, 0.083333, 0.166667]);
});

test('sampleTimesFor：空区间返回空数组（调用方据此提示「范围为空」）', () => {
    assert.deepEqual(sampleTimesFor({ from: 1, to: 1, fps: 24 }), []);
    assert.deepEqual(sampleTimesFor({ from: 0, to: 1, fps: 0 }), []);
});

test('normalizeExportOptions：缩放夹取与坏值回落', () => {
    const d = normalizeExportOptions({ scale: 0.5 }, DOC);
    assert.equal(d.scale, 0.5);
    assert.equal(d.width, 450);
    assert.equal(d.height, 320);

    assert.equal(normalizeExportOptions({ scale: 99 }, DOC).scale, SCALE_MAX);
    assert.equal(normalizeExportOptions({ scale: 0.0001 }, DOC).scale, SCALE_MIN);
    assert.equal(normalizeExportOptions({ scale: 'abc' }, DOC).scale, 1, '坏值回落默认而不是夹到下限');
    assert.equal(normalizeExportOptions({ scale: null }, DOC).scale, 1);
    assert.equal(normalizeExportOptions({ scale: '2' }, DOC).scale, 2, '数字字符串可收');
});

test('normalizeExportOptions：帧率 0 表示跟随文档，越界才夹', () => {
    assert.equal(normalizeExportOptions({ fps: 0 }, DOC).fps, 0);
    assert.equal(normalizeExportOptions({}, DOC).fps, 0);
    assert.equal(normalizeExportOptions({ fps: 24 }, DOC).fps, 24);
    assert.equal(normalizeExportOptions({ fps: 999 }, DOC).fps, FPS_MAX);
    assert.equal(normalizeExportOptions({ fps: -3 }, DOC).fps, FPS_MIN);
    assert.equal(normalizeExportOptions({ fps: 'x' }, DOC).fps, 0, '坏值 = 跟随文档');
});

test('normalizeExportOptions：时间范围裁到 [0, total]，出点缺省是整段', () => {
    const all = normalizeExportOptions({}, DOC);
    assert.equal(all.from, 0);
    assert.equal(all.to, 2);
    assert.equal(all.total, 2);

    const cut = normalizeExportOptions({ from: 0.5, to: 1.5 }, DOC);
    assert.equal(cut.from, 0.5);
    assert.equal(cut.to, 1.5);
    assert.equal(cut.count, 12, '1.0s @12fps = 12 帧');

    assert.equal(normalizeExportOptions({ from: -5 }, DOC).from, 0);
    assert.equal(normalizeExportOptions({ to: 99 }, DOC).to, 2, '出点不能超过总时长');
    assert.equal(normalizeExportOptions({ to: 0 }, DOC).to, 2, '0 视为「没填」= 整段');
    assert.equal(normalizeExportOptions({ from: 1.5, to: 1 }, DOC).count, 0, '出点早于入点 → 0 帧');
});

test('normalizeExportOptions：背景与打开目录的布尔/枚举收敛', () => {
    assert.equal(normalizeExportOptions({}, DOC).background, 'transparent');
    assert.equal(normalizeExportOptions({ background: 'color' }, DOC).background, 'color');
    assert.equal(normalizeExportOptions({ background: 'weird' }, DOC).background, 'transparent');
    assert.equal(normalizeExportOptions({ bgColor: '#ff0000' }, DOC).bgColor, '#ff0000');
    assert.equal(normalizeExportOptions({ bgColor: 'red' }, DOC).bgColor, EXPORT_DEFAULTS.bgColor);
    assert.equal(normalizeExportOptions({}, DOC).openAfter, true);
    assert.equal(normalizeExportOptions({ openAfter: false }, DOC).openAfter, false);
    assert.equal(normalizeExportOptions(null, null).count, 0, '空 doc 不抛');
});

test('effectiveFps：覆盖优先，0 回落文档帧率', () => {
    assert.equal(effectiveFps({ fps: 24 }, DOC), 24);
    assert.equal(effectiveFps({ fps: 0 }, DOC), 12);
    assert.equal(effectiveFps({}, DOC), 12);
    assert.equal(effectiveFps({}, { fps: 0 }), 12, '文档 fps 为 0 时回落 12');
    assert.equal(effectiveFps({ fps: 999 }, DOC), FPS_MAX);
});

test('uniqueDirName：冲突依次追加 -2 / -3，超出上限返回空串', () => {
    const taken = new Set(['导出']);
    assert.equal(uniqueDirName('导出', (n) => taken.has(n)), '导出-2');
    taken.add('导出-2');
    assert.equal(uniqueDirName('导出', (n) => taken.has(n)), '导出-3');
    taken.add('导出-3');
    assert.equal(uniqueDirName('导出', (n) => taken.has(n)), '导出-4');
    assert.equal(uniqueDirName('导出', (n) => taken.has(n), 2), '', '上限用尽返回空串，由调用方报错');
    assert.equal(uniqueDirName('新名字', (n) => taken.has(n)), '新名字');
    assert.equal(uniqueDirName('', () => false), '');
    assert.equal(uniqueDirName(null, () => false), '');
    assert.equal(uniqueDirName('x', null), 'x', '没有 exists 时原样返回');
});

test('chunkPlan：每 16 帧一片，末片按余数', () => {
    assert.equal(EXPORT_CHUNK, 16);
    assert.deepEqual(chunkPlan(0), []);
    assert.deepEqual(chunkPlan(1), [{ startIndex: 0, count: 1 }]);
    assert.deepEqual(chunkPlan(16), [{ startIndex: 0, count: 16 }]);
    assert.deepEqual(chunkPlan(17), [
        { startIndex: 0, count: 16 },
        { startIndex: 16, count: 1 },
    ]);
    const plan = chunkPlan(36);
    assert.equal(plan.length, 3);
    assert.deepEqual(plan[2], { startIndex: 32, count: 4 });
    assert.equal(
        plan.reduce((s, p) => s + p.count, 0),
        36,
        '分片总和必须等于总帧数'
    );
    assert.deepEqual(chunkPlan(5, 2), [
        { startIndex: 0, count: 2 },
        { startIndex: 2, count: 2 },
        { startIndex: 4, count: 1 },
    ]);
});
