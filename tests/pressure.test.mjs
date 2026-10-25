// W21 / B1：画板压感的**纯计算**（映射三条：压力采样 → 直径 / 透明度）。
//
// 真机读数（笔迹包围盒高度、中位数/四分位）在浏览器里量，见 W21 报告；
// 这里锁的是「什么时候该缩放、什么时候必须不动」的规则：
//   鼠标 / 无压感设备 → pointerPressure() 恒 1 → sizeScaleAt() 恒 1
//   → 画板 stamp() 走不缩放的 3 参 drawImage，与改动前逐像素一致。
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    BRUSH_PRESETS,
    PRESSURE_MIN,
    alphaScaleAt,
    brushById,
    marchStamps,
    pointerPressure,
    resolveBrush,
    sizeScaleAt,
    spacingPx,
} from '../app/paint/brush.mjs';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} ${a} ≉ ${b}`);

test('pointerPressure：鼠标恒 1（压感关时笔迹不许变）', () => {
    // Chrome 的鼠标指针 pressure 是 0.5，Firefox / Safari 可能是 0 或 0.45
    for (const p of [0.5, 0.45, 0.2, 0, 1]) {
        assert.equal(pointerPressure({ pointerType: 'mouse', pressure: p }), 1, 'mouse pressure ' + p);
    }
    // 没有 pointerType 的合成事件（测试 / 老浏览器）也按压力判断
    assert.equal(pointerPressure({ pressure: 0.5 }), 1);
});

test('pointerPressure：0.5 是「设备不支持压感」的规范值，回 1', () => {
    assert.equal(pointerPressure({ pointerType: 'pen', pressure: 0.5 }), 1);
    assert.equal(pointerPressure({ pointerType: 'touch', pressure: 0.5 }), 1);
});

test('pointerPressure：真实压感设备的中间值原样透传', () => {
    for (const p of [0.05, 0.2, 0.31, 0.8, 0.99]) {
        assert.equal(pointerPressure({ pointerType: 'pen', pressure: p }), p, 'pen pressure ' + p);
    }
    assert.equal(pointerPressure({ pointerType: 'touch', pressure: 0.37 }), 0.37);
});

test('pointerPressure：非法 / 越界压力回 1 或夹到 1', () => {
    for (const bad of [NaN, Infinity, -Infinity, '0.3', null, undefined, {}, true]) {
        assert.equal(pointerPressure({ pointerType: 'pen', pressure: bad }), 1, 'bad ← ' + String(bad));
    }
    assert.equal(pointerPressure({ pointerType: 'pen', pressure: 0 }), 1);     // 抬起事件会给 0
    assert.equal(pointerPressure({ pointerType: 'pen', pressure: -0.2 }), 1);
    assert.equal(pointerPressure({ pointerType: 'pen', pressure: 1.4 }), 1);
    // 事件本身缺失
    for (const e of [null, undefined, 0, 'x', []]) assert.equal(pointerPressure(e), 1);
});

test('sizeScaleAt：压力 1 或开关关闭 → 恒 1（快路径，逐像素不变）', () => {
    const round = resolveBrush('round');
    assert.equal(round.sizePressure, true);
    assert.equal(sizeScaleAt(round, 1), 1);
    assert.equal(sizeScaleAt(round, 0.999) < 1, true);
    assert.equal(sizeScaleAt(round, undefined), 1);
    assert.equal(sizeScaleAt(round, NaN), 1);
    // 开关没开（或干脆不是笔刷对象）一律 1
    assert.equal(sizeScaleAt({ ...round, sizePressure: false }, 0.2), 1);
    assert.equal(sizeScaleAt({ ...round, sizePressure: 'yes' }, 0.2), 1);
    assert.equal(sizeScaleAt(null, 0.2), 1);
});

test('sizeScaleAt：开压感的笔刷线性缩直径，下限 PRESSURE_MIN', () => {
    const round = resolveBrush('round');
    near(sizeScaleAt(round, 0.2), 0.2, '0.2 压 → 20% 直径');
    near(sizeScaleAt(round, 0.8), 0.8);
    near(sizeScaleAt(round, 0.05), PRESSURE_MIN, '压到底也不小于 10%');
    near(sizeScaleAt(round, -1), PRESSURE_MIN);
    near(sizeScaleAt(round, 0), PRESSURE_MIN);
    assert.equal(PRESSURE_MIN, 0.1);
});

test('sizeScaleAt：像素笔与晕染不跟压感（各自的几何原因见 brush.mjs 预设注释）', () => {
    for (const id of ['pixel', 'smudge']) {
        const b = resolveBrush(id);
        assert.equal(b.sizePressure, false, id);
        assert.equal(sizeScaleAt(b, 0.2), 1, id);
    }
    for (const id of ['round', 'soft', 'pencil', 'scatter', 'eraser']) {
        assert.equal(resolveBrush(id).sizePressure, true, id);
    }
});

test('每支预设都显式声明 sizePressure（新增笔刷不许漏）', () => {
    for (const preset of BRUSH_PRESETS) {
        assert.equal(typeof preset.sizePressure, 'boolean', preset.id + '.sizePressure');
    }
});

test('alphaScaleAt：默认关（压感只改粗细不改浓淡），打开后按 p²', () => {
    for (const preset of BRUSH_PRESETS) {
        assert.equal(resolveBrush(preset.id).opacityPressure, undefined, preset.id + ' 默认不声明');
        near(alphaScaleAt(resolveBrush(preset.id), 0.2), 1, preset.id);
    }
    const on = { ...resolveBrush('round'), opacityPressure: true };
    near(alphaScaleAt(on, 0.5), 0.25, 'p²');
    near(alphaScaleAt(on, 1), 1);
    near(alphaScaleAt(on, 0.01), PRESSURE_MIN ** 2);
    assert.equal(alphaScaleAt(null, 0.5), 1);
});

test('resolveBrush 保留压感开关（覆写表只认四条滑杆，不会误删）', () => {
    const b = resolveBrush('pencil', { spacing: 0.3, hardness: 0.2 });
    assert.equal(b.sizePressure, true);
    assert.equal(b.spacing, 0.3);
    assert.equal(brushById('pencil').spacing === 0.3, false);
});

test('压感两档的直径倍数：无压感 1 / 压感 p（B1 验收 0.2·0.8·1.0）', () => {
    const round = resolveBrush('round');
    const mouse = pointerPressure({ pointerType: 'mouse', pressure: 0.5 });
    assert.equal(sizeScaleAt(round, mouse), 1);
    near(sizeScaleAt(round, pointerPressure({ pointerType: 'pen', pressure: 0.2 })), 0.2);
    near(sizeScaleAt(round, pointerPressure({ pointerType: 'pen', pressure: 0.8 })), 0.8);
    near(sizeScaleAt(round, pointerPressure({ pointerType: 'pen', pressure: 1 })), 1);
});

/* ── 落点行军：间距必须跟着压感走，否则细笔画断成点 ── */

test('marchStamps：满压 / 鼠标的步长恒等于间距（外观与改动前一致）', () => {
    const b = resolveBrush('round');
    const gap = spacingPx(b, 20);
    near(gap, 20 * b.spacing, 'spacingPx 口径');
    const r = marchStamps({ x: 0, y: 0 }, { x: 100, y: 0 }, { brush: b, gap });
    assert.equal(r.stamps.length, 11, '100 ÷ 8.49 → 11 个落点');
    r.stamps.forEach((st, i) => {
        near(st.y, 0, '不偏航');
        near(st.p, 1, '满压');
        if (i === 0) near(st.x, gap);
        else near(st.x - r.stamps[i - 1].x, gap, '步长 = 间距');
    });
    assert.equal(r.carry, 0, '从不越过目标点');
});

test('marchStamps：压到 20% 时步长按 0.2 缩，落点密到不出现断笔', () => {
    const b = resolveBrush('round');
    const gap = spacingPx(b, 20);
    const tip = 20 * sizeScaleAt(b, 0.2);          // 4.4px 的细尖
    const r = marchStamps({ x: 0, y: 0 }, { x: 100, y: 0 }, { brush: b, gap, pressureTo: 0.2, pressureFrom: 0.2 });
    assert.equal(r.stamps.length, 58, '100 ÷ (8.49×0.2)');
    for (let i = 1; i < r.stamps.length; i += 1) {
        const d = r.stamps[i].x - r.stamps[i - 1].x;
        near(d, gap * 0.2, '细笔画步长');
        assert.ok(d < tip, `步长 ${d} 必须小于细尖直径 ${tip}，否则一串断点`);
    }
    near(r.stamps[0].p, 0.2);
});

test('marchStamps：一段内压力线性插值（指针采样远稀于落点）', () => {
    const b = resolveBrush('round');
    const gap = spacingPx(b, 40);
    const r = marchStamps({ x: 0, y: 0 }, { x: 60, y: 30 }, { brush: b, gap, pressureFrom: 1, pressureTo: 0.2 });
    assert.ok(r.stamps.length > 3);
    const ps = r.stamps.map((s) => s.p);
    assert.ok(ps[0] < 1 && ps[0] > 0.2, '第一个落点已经开始变细');
    assert.ok(ps[ps.length - 1] > 0.2 && ps[ps.length - 1] < ps[0], '末点仍在收缩');
    for (let i = 1; i < ps.length; i += 1) assert.ok(ps[i] < ps[i - 1], '压力单调降 → 笔画逐渐变细');
    // 斜向也要按弧长推进，不能按 x 分量
    const d0 = Math.hypot(r.stamps[0].x, r.stamps[0].y);
    near(d0, r.stamps[0].p === 1 ? gap : d0, '斜向首段弧长 = 步长');
});

test('marchStamps：亚像素抖动不落笔、carry 原样带回', () => {
    const b = resolveBrush('round');
    const r = marchStamps({ x: 5, y: 5 }, { x: 5.004, y: 5.002 }, { brush: b, gap: 8, carry: 3 });
    assert.deepEqual(r.stamps, []);
    assert.equal(r.carry, 3);
});

test('marchStamps：间距极小也有 0.5px 兜底，不会死循环', () => {
    const b = resolveBrush('round');
    const r = marchStamps({ x: 0, y: 0 }, { x: 10, y: 0 }, { brush: b, gap: 0.01 });
    assert.equal(r.stamps.length, 20);
    near(r.stamps[0].x, 0.5);
});

test('marchStamps：不跟压感的笔（像素/晕染）步长不随压力变', () => {
    for (const id of ['pixel', 'smudge']) {
        const b = resolveBrush(id);
        const gap = spacingPx(b, 20);
        const a = marchStamps({ x: 0, y: 0 }, { x: 80, y: 0 }, { brush: b, gap, pressureFrom: 1, pressureTo: 1 });
        const c = marchStamps({ x: 0, y: 0 }, { x: 80, y: 0 }, { brush: b, gap, pressureFrom: 1, pressureTo: 0.2 });
        assert.equal(a.stamps.length, c.stamps.length, id + ' 落点数不变');
        assert.deepEqual(a.stamps.map((s) => s.x), c.stamps.map((s) => s.x), id + ' 落点位置不变');
    }
});
