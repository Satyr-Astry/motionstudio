// W21 / B2：7 支笔的默认间距按 Klecks 的「半径倍数」口径重标定 + 一次性迁移。
//
// 口径：我们的 spacing 是**直径**倍数（brush.mjs 注释），Klecks 的 settingSpacing 乘的是
// **半径**（pen-brush.ts:33 + :189 arc(x, y, size)），所以同一个落点前进量对应
//   ours = klecks / 2。
// 这里锁三件事：新默认值确实等于换算值、旧值仍能从 LEGACY_SPACING 认出来、
// 迁移只删「恰好是旧默认」的覆写（用户自己拖过的值不许动）。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BRUSH_PRESETS,
    KLEKS_PEN_GAP_DIAMETER,
    KLEKS_PEN_SPACING,
    LEGACY_SPACING,
    SPACING_VERSION,
    brushById,
    migrateBrushOverrides,
    resolveBrush,
    spacingPx,
} from '../app/paint/brush.mjs';

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} ≉ ${b}`);
const preset = (id) => BRUSH_PRESETS.find((b) => b.id === id);

/** 把「直径倍数」换算回 Klecks 的「半径倍数」，用来核对换算没跑偏。 */
const toRadiusRatio = (id, size) => spacingPx(preset(id), size) / (size / 2);

test('换算常量：0.8489（半径口径）÷ 2 = 0.42445（直径口径）', () => {
    assert.equal(KLEKS_PEN_SPACING, 0.8489);
    near(KLEKS_PEN_GAP_DIAMETER, 0.42445, 1e-12);
});

test('圆笔默认间距与 Klecks pen 对齐：落点前进 = R × 0.8489', () => {
    const d = preset('round');
    assert.equal(d.spacing, KLEKS_PEN_GAP_DIAMETER);
    for (const size of [4, 8, 20, 60]) {
        near(toRadiusRatio('round', size), 0.8489, 1e-9, 'size ' + size);
        near(spacingPx(d, size), size * 0.42445, 1e-9, 'gap px @' + size);
    }
    // 旧值 0.12 换成半径口径是 0.24：比它密 3.54 倍（docs 的 3.5 倍）
    near(LEGACY_SPACING.round * 2, 0.24, 1e-12);
    near(0.8489 / 0.24, 3.5370833333333335, 1e-9);
});

test('新默认值一览：7 支笔逐个核对（口径 + 参考来源）', () => {
    // 圆/软/铅/散 = Klecks pen 的 0.8489R；橡皮 = Klecks eraser 0.4R×0.5 = 0.2R；
    // 晕染 = 0.2R（搬运式 smudge 越密越糊，取 Klecks 线工具/橡皮量级）；像素笔不变（方块边长 = 直径）。
    const want = {
        pixel: 1,
        round: KLEKS_PEN_GAP_DIAMETER,
        soft: KLEKS_PEN_GAP_DIAMETER,
        pencil: KLEKS_PEN_GAP_DIAMETER,
        smudge: 0.1,
        scatter: KLEKS_PEN_GAP_DIAMETER,
        eraser: 0.1,
    };
    assert.deepEqual(Object.keys(want).sort(), BRUSH_PRESETS.map((b) => b.id).sort());
    for (const [id, spacing] of Object.entries(want)) {
        assert.equal(preset(id).spacing, spacing, id);
    }
    // 半径口径读数（报告里的换算表就用这几个数）
    near(toRadiusRatio('round', 20), 0.8489, 1e-9);
    near(toRadiusRatio('soft', 20), 0.8489, 1e-9);
    near(toRadiusRatio('pencil', 20), 0.8489, 1e-9);
    near(toRadiusRatio('scatter', 20), 0.8489, 1e-9);
    near(toRadiusRatio('eraser', 20), 0.2, 1e-9);
    near(toRadiusRatio('smudge', 20), 0.2, 1e-9);
    near(toRadiusRatio('pixel', 20), 2, 1e-9);   // 方块笔尖：前进 = 1 个直径
});

test('所有默认间距都在可调区间内，且与旧值的疏密关系有据', () => {
    for (const b of BRUSH_PRESETS) {
        assert.ok(b.spacing >= 0.01 && b.spacing <= 2, b.id + ' 在 BRUSH_PARAM_RANGE.spacing 内');
        assert.ok(Number.isFinite(LEGACY_SPACING[b.id]), b.id + ' 有旧值可认');
    }
    // 变稀：圆/软/铅/散（对齐 Klecks pen 的 0.8489R），晕染（0.12R → 0.2R，减少搬运次数）
    for (const id of ['round', 'soft', 'pencil', 'scatter', 'smudge']) {
        assert.ok(preset(id).spacing > LEGACY_SPACING[id], id + ' 新值必须更稀疏');
    }
    // 变密：橡皮。Klecks eraser 的不透明度 1 前进量是 R×0.2，比我们旧的 R×0.24 还密一点（1.2 倍）
    assert.ok(preset('eraser').spacing < LEGACY_SPACING.eraser, 'eraser 变小');
    near(LEGACY_SPACING.eraser / preset('eraser').spacing, 1.2, 1e-12, 'eraser 密 1.2 倍');
    // 不动：像素笔（方块边长 = 直径，间距 1 倍直径刚好首尾相切）
    assert.equal(preset('pixel').spacing, LEGACY_SPACING.pixel);
});

test('spacingPx 读数（size 20）与旧值对照', () => {
    const rows = BRUSH_PRESETS.map((b) => ({
        id: b.id,
        oldPx: spacingPx({ ...b, spacing: LEGACY_SPACING[b.id] }, 20),
        newPx: spacingPx(b, 20),
    }));
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    near(by.round.oldPx, 2.4, 1e-9);
    near(by.round.newPx, 8.489, 1e-9);
    near(by.soft.oldPx, 1.6, 1e-9);
    near(by.pencil.oldPx, 2, 1e-9);
    near(by.smudge.oldPx, 1.2, 1e-9);
    near(by.smudge.newPx, 2, 1e-9);
    near(by.scatter.oldPx, 1, 1e-9);
    near(by.eraser.oldPx, 2.4, 1e-9);
    near(by.eraser.newPx, 2, 1e-9);
    assert.equal(by.pixel.oldPx, 20);
    assert.equal(by.pixel.newPx, 20);
});

test('像素笔：间距恒为整格，不会因为重标定而跳格', () => {
    for (const size of [1, 4, 8, 13, 64]) {
        const gap = spacingPx(preset('pixel'), size);
        assert.equal(gap, Math.max(1, Math.round(size)), 'size ' + size);
        assert.ok(Number.isInteger(gap));
    }
});

test('迁移：恰好是旧默认值的 spacing 被删（让新默认生效）', () => {
    const cases = [
        ['round', 0.12],
        ['soft', 0.08],
        ['pencil', 0.1],
        ['smudge', 0.06],
        ['scatter', 0.05],
        ['eraser', 0.12],
    ];
    for (const [id, legacy] of cases) {
        assert.deepEqual(migrateBrushOverrides({ spacing: legacy }, id), {}, id + ' 整条被删空');
        // 其余参数保留
        assert.deepEqual(
            migrateBrushOverrides({ spacing: legacy, flow: 0.5, hardness: 0.3 }, id),
            { hardness: 0.3, flow: 0.5 },
            id + ' 只删 spacing',
        );
        // 数字字符串也认（localStorage 里可能存成字符串）
        assert.deepEqual(migrateBrushOverrides({ spacing: String(legacy) }, id), {}, id + ' 字符串');
    }
});

test('迁移：用户自己调过的 spacing 原样保留', () => {
    for (const id of ['round', 'soft', 'pencil', 'smudge', 'scatter', 'eraser']) {
        assert.equal(migrateBrushOverrides({ spacing: 0.3 }, id), null, id + ' 自定义值不动');
        assert.equal(migrateBrushOverrides({ spacing: 0.4245 }, id), null, id + ' 已是新值不动');
        assert.equal(migrateBrushOverrides({ spacing: 1 }, id), null, id + ' 开到最大不动');
    }
});

test('迁移：默认值没变的笔不迁（像素笔 / 未知 id / 空白表）', () => {
    assert.equal(migrateBrushOverrides({ spacing: 1 }, 'pixel'), null, '像素笔默认没变');
    assert.equal(migrateBrushOverrides({ spacing: 0.12 }, 'nope'), null, '未知 id');
    assert.equal(migrateBrushOverrides({}, 'round'), null);
    assert.equal(migrateBrushOverrides({ flow: 0.4 }, 'round'), null, '没存过 spacing');
    for (const bad of [null, undefined, 42, 'x', true, [], '{"spacing":0.12}']) {
        assert.equal(migrateBrushOverrides(bad, 'round'), null, '非法输入 ← ' + String(bad));
    }
});

test('迁移：不动入参，且白名单外的键不会带进新表', () => {
    const input = { spacing: 0.12, flow: 0.4, size: 999, erase: true };
    const out = migrateBrushOverrides(input, 'round');
    assert.deepEqual(out, { flow: 0.4 });
    assert.equal(input.spacing, 0.12, '入参未被改');
    assert.equal(input.size, 999);
});

test('迁移后落到的默认值就是新表（resolveBrush 无覆写）', () => {
    for (const b of BRUSH_PRESETS) {
        const clean = migrateBrushOverrides({ spacing: LEGACY_SPACING[b.id] }, b.id);
        const ov = clean === null ? { spacing: LEGACY_SPACING[b.id] } : clean;
        assert.equal(resolveBrush(b.id, ov).spacing, b.spacing, b.id);
    }
    assert.equal(SPACING_VERSION, 2);
    assert.equal(brushById('round').spacing, KLEKS_PEN_GAP_DIAMETER);
});
