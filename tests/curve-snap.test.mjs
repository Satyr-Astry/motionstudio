// 曲线编辑器打出来的时刻必须落在整帧上：曲线按「秒」定位、时间轴按「帧」定位，
// 中间不吸帧的话，同一个关键帧在帧带里会落在两帧之间（看起来就是「不同步」）。
//
// 这里钉两件事：① 落点换算的语义 ② curve.mjs 的接线（双击与拖拽两条路径都过 snapFrame）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { snapFrame } from '../app/editors/timeline-geo.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const src = read('../app/editors/curve.mjs');
const doc = (fps) => ({ width: 100, height: 100, fps, duration: 1, objects: [] });

test('曲线落点：真机取证的两个非帧时刻会被吸到整帧', () => {
    // 改前实测：双击曲线画布 42% / 72% 处得到的 t 是这两个值（乘 12 得 4.661 / 8.802 帧）。
    // 这两个数字是缺陷的原始证据，不能改：它们必须吸成 5 帧与 9 帧。
    const d = doc(12);
    assert.ok(Math.abs(snapFrame(d, 0.3884297520661157) - 5 / 12) < 1e-12);
    assert.ok(Math.abs(snapFrame(d, 0.7334710743801653) - 9 / 12) < 1e-12);
});

test('曲线落点：任意时刻吸附后乘 fps 都是整数（时间轴按这个数定位菱形）', () => {
    const d = doc(12);
    for (let i = 0; i <= 400; i += 1) {
        const t = snapFrame(d, i / 397); // 397 与 12 互质，扫到的基本都是非帧时刻
        const frame = t * 12;
        assert.ok(Math.abs(frame - Math.round(frame)) < 1e-9, '未吸到整帧：t=' + t + ' → ' + frame);
    }
});

test('曲线落点：吸附结果不含浮点毛刺（写回文档的 t 要能直接比较）', () => {
    const d = doc(12);
    // Math.round(v*fps)/fps 的既有实现：5/12 这类值参与 JSON 往返后仍相等
    const t = snapFrame(d, 0.3884297520661157);
    assert.equal(JSON.parse(JSON.stringify({ t })).t, t);
    assert.equal(snapFrame(d, t), t, '吸附必须幂等');
});

test('curve.mjs 接线：双击加点用 snapFrame(doc, xToT(...))', () => {
    assert.match(src, /const t = snapFrame\(doc, xToT\(geo, x\)\);/, '双击落点必须先吸帧再写回');
    // 写回用的是吸附后的 t，不是原始的 xToT 结果
    assert.match(src, /setChannelKey\(ensureChannel\(old, focus\), focus, t, undefined, 'bezier'\)/);
    assert.match(src, /addKey\(old, t, stateAt\(track, t\), 'bezier'\)/);
});

test('curve.mjs 接线：本地 snapTime 先吸帧、再谈 Shift 的画格吸附', () => {
    const body = src.slice(src.indexOf('function snapTime(t, ev)'), src.indexOf('/* ── 指针交互 ──'));
    assert.ok(body.includes('snapFrame(doc, t)'), 'snapTime 里必须先吸帧');
    const iFrame = body.indexOf('snapFrame(doc, t)');
    const iGeo = body.indexOf('geoSnapTime(');
    assert.ok(iFrame > 0 && iGeo > iFrame, '顺序必须是「先帧、后画格」');
    // 关键语义：不按 Shift 也要吸帧（改前是无 Shift 直接原样返回，拖动就落在两帧之间）
    assert.match(body, /if \(!ev\.shiftKey\) return framed;/, '不按 Shift 也必须返回吸帧结果');
    assert.ok(!/if \(!doc \|\| !ev\.shiftKey\) return t;/.test(body), '旧的「无 Shift 原样返回」必须消失');
});

test('curve.mjs 接线：拖拽关键帧仍走 snapTime（不能绕过吸附直接写 xToT）', () => {
    assert.match(src, /const t = snapTime\(xToT\(geo, x\), ev\);/, '拖拽分支必须过 snapTime');
});

test('curve.mjs 接线：snapFrame 从 timeline-geo 导入且不重复实现', () => {
    assert.match(src, /import \{ snapFrame \} from '\.\/timeline-geo\.mjs';/);
    assert.ok(!/function snapFrame/.test(src), '不许在 curve.mjs 里另写一份吸帧实现');
});
