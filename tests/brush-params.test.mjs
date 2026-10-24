import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BRUSH_DEFAULTS,
    BRUSH_PARAM_KEYS,
    BRUSH_PARAM_RANGE,
    BRUSH_PRESETS,
    brushById,
    resolveBrush,
    spacingPx,
    tipDiameter,
    tipKey,
} from '../app/paint/brush.mjs';

test('BRUSH_PARAM_KEYS 是四条可调参数的白名单', () => {
    assert.deepEqual([...BRUSH_PARAM_KEYS], ['hardness', 'spacing', 'jitter', 'flow']);
});

test('resolveBrush 无覆写时等于预设值（预设缺项回落 BRUSH_DEFAULTS）', () => {
    for (const preset of BRUSH_PRESETS) {
        const b = resolveBrush(preset.id);
        for (const key of BRUSH_PARAM_KEYS) {
            const want = preset[key] === undefined ? BRUSH_DEFAULTS[key] : preset[key];
            assert.equal(b[key], want, preset.id + '.' + key);
        }
    }
});

test('resolveBrush 返回新对象，不改预设常量', () => {
    const base = brushById('round');
    const before = base.hardness;
    const b = resolveBrush('round', { hardness: 0.2 });
    assert.notEqual(b, base);
    assert.equal(b.hardness, 0.2);
    assert.equal(base.hardness, before);
});

test('resolveBrush 保留预设的非参数属性', () => {
    const b = resolveBrush('pixel', { hardness: 0.1 });
    assert.equal(b.id, 'pixel');
    assert.equal(b.pixelGrid, true);
    assert.equal(b.antialias, false);
    assert.equal(b.hardness, 0.1);
});

test('resolveBrush 未知 id 与 brushById 一致回落到圆笔', () => {
    const a = resolveBrush('nope', { jitter: 0.4 });
    const b = resolveBrush('round', { jitter: 0.4 });
    assert.equal(a.id, 'round');
    assert.equal(a.jitter, 0.4);
    assert.deepEqual({ ...a }, { ...b });
});

test('resolveBrush 数字越界被钳到区间', () => {
    const b = resolveBrush('round', {
        hardness: 5,
        spacing: -3,
        jitter: 9,
        flow: 0,
    });
    assert.equal(b.hardness, BRUSH_PARAM_RANGE.hardness[1]);
    assert.equal(b.spacing, BRUSH_PARAM_RANGE.spacing[0]);
    assert.equal(b.jitter, BRUSH_PARAM_RANGE.jitter[1]);
    assert.equal(b.flow, BRUSH_PARAM_RANGE.flow[0]);
});

test('resolveBrush 非法值回落到预设值', () => {
    const preset = brushById('soft');
    for (const bad of [NaN, Infinity, -Infinity, null, undefined, '', '  ', true, {}, [], () => 0]) {
        const b = resolveBrush('soft', { hardness: bad, flow: bad });
        assert.equal(b.hardness, preset.hardness, 'hardness ← ' + String(bad));
        assert.equal(b.flow, preset.flow, 'flow ← ' + String(bad));
    }
});

test('resolveBrush 接受数字字符串', () => {
    const b = resolveBrush('round', { hardness: '0.4', jitter: '0.25' });
    assert.equal(b.hardness, 0.4);
    assert.equal(b.jitter, 0.25);
});

test('resolveBrush overrides 为 null / 非对象时按预设', () => {
    for (const ov of [null, undefined, 42, 'x', true]) {
        const b = resolveBrush('pencil', ov);
        assert.equal(b.hardness, brushById('pencil').hardness);
        assert.equal(b.jitter, brushById('pencil').jitter);
    }
});

test('resolveBrush 忽略白名单外的键', () => {
    const b = resolveBrush('round', { size: 999, opacity: 0.01, id: 'eraser', erase: true });
    assert.equal(b.id, 'round');
    assert.equal(b.erase, undefined);
    assert.notEqual(b.size, 999);
    assert.notEqual(b.opacity, 0.01);
});

test('预设缺 jitter 时回落到 BRUSH_DEFAULTS.jitter', () => {
    assert.equal(BRUSH_DEFAULTS.jitter, 0);
    const b = resolveBrush('round', {});
    assert.equal(b.jitter, 0);
});

test('resolveBrush 的结果真的驱动 spacingPx 与 tipDiameter', () => {
    const tight = resolveBrush('pencil', { spacing: 0.02 });
    const loose = resolveBrush('pencil', { spacing: 0.9 });
    assert.ok(spacingPx(tight, 20) < spacingPx(loose, 20));
    assert.equal(spacingPx(loose, 20), 18);

    // pixelGrid 笔刷间距取整且至少 1
    const px = resolveBrush('pixel', { spacing: 0.05 });
    assert.ok(spacingPx(px, 8) >= 1);

    assert.ok(tipDiameter(resolveBrush('round', { hardness: 0.1 }), 16) > 0);
});

test('tipKey 把 hardness 纳入缓存键（改硬度不会命中旧笔尖）', () => {
    const hard = resolveBrush('round', { hardness: 0.05 });
    const soft = resolveBrush('round', { hardness: 0.95 });
    assert.notEqual(tipKey(hard, 12, '#000000', 1), tipKey(soft, 12, '#000000', 1));
    assert.equal(tipKey(hard, 12, '#000000', 1), tipKey(resolveBrush('round', { hardness: 0.05 }), 12, '#000000', 1));
});
