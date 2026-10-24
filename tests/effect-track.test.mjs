// 效果参数的关键帧轨道：数据层复用变换的 stateAt，渲染入口是 filterStringAt。
// 这里只测纯函数（不碰 DOM / canvas），覆盖「插值连续」「三种缓动」「静态回退」
// 「CSS 字符串在时间轴上的变化」「多效果多参数互不串味」这几件真机上会出事的事。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { effectAt, filterStringAt, hasTracks, filterString, normalizeEffect } from '../app/paint/effects.mjs';
import { createTrack, addKey } from '../app/core/transform.mjs';

/** 造一条标量轨道：值是关键帧的 state.x（效果参数借用变换轨道的 x 通道） */
function scalarTrack(keys) {
    let track = createTrack();
    for (const k of keys) {
        track = addKey(track, k.t, { x: k.x }, k.ease || 'linear', k.h1, k.h2);
    }
    return track;
}

const blurTrack = (track) => [{ type: 'blur', amount: 0, tracks: { amount: track } }];

/* ─────────────────── 单参数：两关键帧的连续插值 ─────────────────── */

test('effectAt 单参数两关键帧线性插值：中间时间取连续值', () => {
    const fx = { type: 'blur', amount: 0, tracks: { amount: scalarTrack([{ t: 0, x: 0 }, { t: 1, x: 20 }]) } };
    assert.equal(effectAt(fx, 0).amount, 0);
    assert.equal(effectAt(fx, 0.25).amount, 5);
    assert.equal(effectAt(fx, 0.5).amount, 10);
    assert.equal(effectAt(fx, 0.75).amount, 15);
    assert.equal(effectAt(fx, 1).amount, 20);
});

test('effectAt 关键帧之间不是「取最近 key」：0.4 秒的值不等于任一端的值', () => {
    const fx = { type: 'blur', amount: 0, tracks: { amount: scalarTrack([{ t: 0, x: 0 }, { t: 1, x: 20 }]) } };
    const mid = effectAt(fx, 0.4).amount;
    assert.ok(mid > 0 && mid < 20, '0.4s 应落在两个关键帧之间，实际 ' + mid);
    assert.equal(mid, 8);
});

test('effectAt 轨道区间外保持端点值（不外插）', () => {
    const fx = { type: 'blur', amount: 0, tracks: { amount: scalarTrack([{ t: 0.2, x: 4 }, { t: 0.8, x: 12 }]) } };
    assert.equal(effectAt(fx, 0).amount, 4);
    assert.equal(effectAt(fx, -1).amount, 4);
    assert.equal(effectAt(fx, 1).amount, 12);
    assert.equal(effectAt(fx, 5).amount, 12);
});

test('effectAt 贝塞尔：切线柄改变中间值，端点仍然精确', () => {
    const fx = {
        type: 'blur',
        amount: 0,
        tracks: {
            amount: scalarTrack([
                { t: 0, x: 0, ease: 'bezier', h1: [0.9, 0.05], h2: [0.9, 0.05] },
                { t: 1, x: 20 },
            ]),
        },
    };
    assert.equal(effectAt(fx, 0).amount, 0);
    assert.equal(effectAt(fx, 1).amount, 20);
    const mid = effectAt(fx, 0.5).amount;
    assert.ok(mid > 0 && mid < 20);
    // 非对称手柄必须让中点明显低于线性中点 10，否则说明贝塞尔没生效
    assert.ok(mid < 2, '缓入手柄应压低中点，实际 ' + mid);
});

test('effectAt 保持：关键帧之间不插值，到点才跳', () => {
    const fx = {
        type: 'blur',
        amount: 0,
        tracks: { amount: scalarTrack([{ t: 0, x: 0, ease: 'hold' }, { t: 1, x: 20, ease: 'hold' }]) },
    };
    for (const t of [0, 0.25, 0.5, 0.99]) assert.equal(effectAt(fx, t).amount, 0);
    assert.equal(effectAt(fx, 1).amount, 20);
    assert.equal(effectAt(fx, 2).amount, 20);
});

/* ─────────────────── 无轨道：回落到静态值 ─────────────────── */

test('effectAt 无轨道时原样返回静态效果对象', () => {
    const fx = { type: 'blur', amount: 7 };
    assert.equal(effectAt(fx, 0.5), fx);
    assert.equal(effectAt(fx, 0.5).amount, 7);
});

test('effectAt 轨道为空时不改写参数', () => {
    const fx = { type: 'blur', amount: 7, tracks: { amount: createTrack() } };
    assert.equal(effectAt(fx, 0.5).amount, 7);
    assert.equal(hasTracks(fx), false);
});

test('hasTracks 只看真的有 key 的轨道', () => {
    assert.equal(hasTracks({ type: 'blur', amount: 0 }), false);
    assert.equal(hasTracks({ type: 'blur', amount: 0, tracks: {} }), false);
    assert.equal(hasTracks({ type: 'blur', amount: 0, tracks: { amount: createTrack() } }), false);
    assert.equal(hasTracks({ type: 'blur', amount: 0, tracks: { amount: scalarTrack([{ t: 0, x: 1 }]) } }), true);
});

/* ─────────────────── filterStringAt：CSS 字符串随时间变 ─────────────────── */

test('filterStringAt 在 0 / 0.5 / 1 秒输出对应字符串', () => {
    const effects = blurTrack(scalarTrack([{ t: 0, x: 0 }, { t: 1, x: 20 }]));
    assert.equal(filterStringAt(effects, 0), 'none');
    assert.equal(filterStringAt(effects, 0.5), 'blur(10px)');
    assert.equal(filterStringAt(effects, 1), 'blur(20px)');
});

test('filterStringAt 无轨道时与 filterString 完全一致', () => {
    const staticFx = [{ type: 'blur', amount: 4 }, { type: 'glow', amount: 8, color: '#4a7dff' }];
    for (const t of [0, 0.5, 1]) assert.equal(filterStringAt(staticFx, t), filterString(staticFx));
});

test('filterStringAt 空数组与空值一律 none', () => {
    assert.equal(filterStringAt([], 0), 'none');
    assert.equal(filterStringAt(null, 0), 'none');
    assert.equal(filterStringAt([{ type: '不存在的效果' }], 0), 'none');
});

/* ─────────────────── 非法值：不能拼出会被整串丢弃的 CSS ─────────────────── */

test('轨道求值越界时夹到参数范围（贝塞尔过冲 / 手改存档）', () => {
    const effects = blurTrack(scalarTrack([{ t: 0, x: 10 }, { t: 1, x: -20 }]));
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const s = filterStringAt(effects, t);
        assert.ok(!/-/.test(s), 'blur 不能为负：' + s);
    }
    assert.equal(effectAt(effects[0], 1).amount, 0);
    // 上限同样按 def 夹取（blur 上限 40）
    const big = blurTrack(scalarTrack([{ t: 0, x: 999 }]));
    assert.equal(filterStringAt(big, 0), 'blur(40px)');
});

test('filterStringAt 补齐缺省参数，不输出 undefined', () => {
    const effects = [{ type: 'glow', tracks: { amount: scalarTrack([{ t: 0, x: 8 }]) } }];
    const s = filterStringAt(effects, 0);
    assert.equal(s, 'drop-shadow(0 0 8px #4a7dff)');
    assert.ok(!s.includes('undefined'), s);
    assert.equal(s, filterString([{ type: 'glow', amount: 8 }]));
});

/* ─────────────────── 多效果 / 多参数各自独立 ─────────────────── */

test('多效果多参数各自独立求值，互不串味', () => {
    const effects = [
        {
            type: 'shadow',
            dx: 0,
            dy: 0,
            amount: 0,
            color: '#000000',
            tracks: {
                dx: scalarTrack([{ t: 0, x: 0 }, { t: 1, x: 10 }]),
                amount: scalarTrack([{ t: 0, x: 0 }, { t: 1, x: 20 }]),
            },
        },
        {
            type: 'adjust',
            brightness: 1,
            contrast: 1,
            saturate: 1,
            hue: 0,
            tracks: { hue: scalarTrack([{ t: 0, x: 0 }, { t: 1, x: 180 }]) },
        },
    ];
    const half = effectAt(effects[0], 0.5);
    // 同一效果内两个参数在同一时刻各自求值（不是只取其中一个）
    assert.equal(half.dx, 5);
    assert.equal(half.amount, 10);
    assert.equal(effectAt(effects[0], 0).dx, 0);
    assert.equal(effectAt(effects[0], 1).amount, 20);
    // 第二个效果只看自己的轨道
    assert.equal(effectAt(effects[1], 0.5).hue, 90);
    assert.equal(effectAt(effects[1], 0.5).brightness, 1);
    // 字符串层面：两段都出现且顺序不变
    const s = filterStringAt(effects, 0.5);
    assert.equal(s, 'drop-shadow(5px 0px 10px #000000) hue-rotate(90deg)');
});

test('同一效果里一个参数有轨道、另一个没有：静态值照旧生效', () => {
    const effects = [
        {
            type: 'adjust',
            brightness: 1.5,
            contrast: 1,
            saturate: 1,
            hue: 0,
            tracks: { contrast: scalarTrack([{ t: 0, x: 1 }, { t: 1, x: 2 }]) },
        },
    ];
    assert.equal(filterStringAt(effects, 0), 'brightness(1.5)');
    assert.equal(filterStringAt(effects, 0.5), 'brightness(1.5) contrast(1.5)');
});

test('effectAt 不改写原效果对象（轨道求值走副本）', () => {
    const fx = { type: 'blur', amount: 0, tracks: { amount: scalarTrack([{ t: 0, x: 0 }, { t: 1, x: 20 }]) } };
    const before = JSON.stringify(fx);
    effectAt(fx, 0.5);
    assert.equal(JSON.stringify(fx), before);
});

test('颜色参数上的数值轨道被忽略，不会写坏颜色', () => {
    // UI 不给颜色参数打帧，但手改存档可能出现；数值塞进颜色会拼出非法 CSS
    const fx = {
        type: 'glow',
        amount: 8,
        color: '#4a7dff',
        tracks: { color: scalarTrack([{ t: 0, x: 3 }]) },
    };
    assert.equal(effectAt(fx, 0).color, '#4a7dff');
    assert.equal(filterStringAt([fx], 0), 'drop-shadow(0 0 8px #4a7dff)');
});

/* ─────────────────── 归一化仍然只认静态字段 ─────────────────── */

test('normalizeEffect 取的是求值后的值而不是轨道', () => {
    const fx = { type: 'blur', amount: 0, tracks: { amount: scalarTrack([{ t: 0, x: 0 }, { t: 1, x: 20 }]) } };
    const norm = normalizeEffect(effectAt(fx, 0.5));
    assert.deepEqual(norm, { type: 'blur', amount: 10 });
});
