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

// 判定变更记录（0.1.2-alpha.9）：曲线曾经自己写一套「无条件吸帧、Shift 吸纹理」，
// 与时间轴的「磁铁开=吸帧 / Shift=关磁铁（可落两帧之间）/ 磁铁关=自由 / Shift=吸 0.1s 网格」不一致 ——
// 同一个关键帧在两个面板拖到同一像素位置会落到不同时刻。现在两边共用
// `snapForDrag(doc, t, e, snapOn)`（`app/editors/timeline-geo.mjs`），这三条接线断言随之改口径。
test('curve.mjs 接线：双击加点也过 snapTime（与时间轴双击泳道同一套吸附）', () => {
    assert.match(src, /const t = snapTime\(xToT\(geo, x\), ev\);/, '双击落点必须过 snapTime');
    // 写回用的是吸附后的 t，不是原始的 xToT 结果
    assert.match(src, /setChannelKey\(old, focus, t, undefined, 'bezier'\)/);
    assert.match(src, /addKey\(old, t, stateAt\(track, t\), 'bezier'\)/);
});

test('curve.mjs 接线：本地 snapTime 委托给 timeline-geo 的 snapForDrag', () => {
    const body = src.slice(src.indexOf('function snapTime(t, ev)'), src.indexOf('/* ── 指针交互 ──'));
    assert.match(body, /snapForDrag\(doc, t, ev, snapOnNow\(\)\)/, '必须走共用的吸附判据');
    assert.ok(!/geoSnapTime/.test(src), '旧的「Shift 吸纹理」口径要彻底消失，别再留第二条吸附语义');
});

test('curve.mjs 接线：拖拽关键帧仍走 snapTime（不能绕过吸附直接写 xToT）', () => {
    assert.match(src, /const t = snapTime\(xToT\(geo, x\), ev\);/, '拖拽分支必须过 snapTime');
});

test('curve.mjs 接线：吸附与磁铁都从 timeline-geo 导入，不重复实现', () => {
    assert.match(src, /import \{ snapForDrag \} from '\.\/timeline-geo\.mjs';/);
    assert.ok(!/function snapFrame/.test(src), '不许在 curve.mjs 里另写一份吸帧实现');
    assert.ok(!/function magnetOf/.test(src), '磁铁判据也只许有一份');
});
