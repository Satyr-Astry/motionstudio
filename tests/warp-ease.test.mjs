/**
 * 网格变形的两处行为：
 *   1) 缓动（尤其贝塞尔，含预冲/过冲）必须作用到 warp 网格顶点，而不是只有标量动；
 *   2) 三角形贴图在共享边上不能留 1px 透明缝 —— 外扩裁剪三角形后的纯几何断言。
 *
 * 这里不依赖 canvas：缝合修复被拆成纯函数 inflateTriangle / devicePad，
 * drawTexCell 的接线用一个只记录 clip 路径的假 ctx 验证。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    createTrack,
    addKey,
    stateAt,
    segmentProgress,
    solveBezierYForX,
} from '../app/core/transform.mjs';
import { lerpLattice } from '../app/core/lattice.mjs';
import { inflateTriangle, devicePad, drawLatticeImage } from '../app/paint/composite.mjs';

const near = (a, b, msg = '', tol = 1e-9) => {
    assert.ok(Math.abs(a - b) < tol, `${msg}: 期望 ${b}，实得 ${a}（差 ${Math.abs(a - b)}）`);
};

// 1×1 网格、只把第 0 号顶点沿 x 拉出 offset —— 顶点坐标就是可读的标量
const latch = (x) => ({ cols: 1, rows: 1, pts: [[x, 0], [0, 0], [0, 0], [0, 0]] });
const warpX = (st) => st.warp.pts[0][0];
const warpPts = (st) => st.warp.pts.map((p) => [p[0], p[1]]);
const ZERO_PTS = [[0, 0], [0, 0], [0, 0], [0, 0]];

/** 0s(0 → 100) 到 2s，span 固定 2 秒，便于把 t 换算成 u = t / 2 */
function trackWith(ease, h1, h2) {
    let trk = createTrack();
    trk = addKey(trk, 0, { x: 0, warp: latch(0) }, ease, h1, h2);
    trk = addKey(trk, 2, { x: 100, warp: latch(100) }, 'linear');
    return trk;
}

// ---------- 1. 缓动作用到 warp ----------

test('warp 使用缓动后的进度：linear 与 bezier 的中间顶点不同', () => {
    const lin = trackWith('linear');
    const bez = trackWith('bezier', [0.42, 0], [0.58, 1]); // 对称 ease-in-out

    // t=0.5s → u=0.25：缓动落后于线性
    const L1 = stateAt(lin, 0.5);
    const B1 = stateAt(bez, 0.5);
    near(warpX(L1), 25, 'linear t=0.5 应为 100·0.25');
    near(segmentProgress(bez.keys[0], 0.25), 0.12916193104788043, 'p(0.25)');
    near(warpX(B1), 12.916193104788043, 'bezier t=0.5 应为 100·p(0.25)');
    assert.ok(warpX(B1) < warpX(L1), 'ease-in 段首应滞后于线性');
    assert.notDeepEqual(warpPts(B1), warpPts(L1), '整组顶点必须不同，而不是只有标量动');

    // t=1.5s → u=0.75：缓动超前于线性
    const L3 = stateAt(lin, 1.5);
    const B3 = stateAt(bez, 1.5);
    near(warpX(L3), 75, 'linear t=1.5');
    near(segmentProgress(bez.keys[0], 0.75), 0.8708380689521196, 'p(0.75)');
    near(warpX(B3), 87.08380689521195, 'bezier t=1.5 应为 100·p(0.75)');
    assert.ok(warpX(B3) > warpX(L3), 'ease-out 段尾应超前于线性');

    // 对称曲线的数学必然：p(0.5)=0.5，所以段中点两者恰好相同（数值不同只能靠 u≠0.5 取样）
    near(segmentProgress(bez.keys[0], 0.5), 0.5, '对称 ease-in-out 的中点');
    near(warpX(stateAt(lin, 1)), warpX(stateAt(bez, 1)), '段中点两者相同');
});

test('lerpLattice 不夹取进度：p<0 预冲、p>1 过冲都要如实外插', () => {
    const a = latch(0);
    const b = latch(100);
    near(lerpLattice(a, b, 0.25).pts[0][0], 25, '常规段');
    near(lerpLattice(a, b, -0.25).pts[0][0], -25, '预冲（原来会被夹到 0）');
    near(lerpLattice(a, b, 1.5).pts[0][0], 150, '过冲（原来会被夹到 100）');
    near(lerpLattice(a, b, NaN).pts[0][0], 0, '非有限值回落 0');
    near(lerpLattice(a, b, Infinity).pts[0][0], 0, '非有限值回落 0');
    // 边界分支不能被改动波及
    assert.equal(lerpLattice(null, null, 0.5), null, '两侧都空 → null');
    near(lerpLattice(null, b, 0.5).pts[0][0], 50, '起点为空视作零偏移');
    near(lerpLattice(a, null, 0.5).pts[0][0], 0, '终点为空视作零偏移');
});

test('贝塞尔预冲/过冲作用于 warp，且与标量通道逐点同相位', () => {
    // h1.y=-0.3 → 曲线先向下拱，p 在前 1/3 段时间内为负
    const antic = trackWith('bezier', [0.34, -0.3], [0.36, 1]);
    const pAntic = solveBezierYForX(0.34, -0.3, 0.36, 1, 0.05);
    near(pAntic, -0.033963443590932146, 'p(0.05) 为负');
    const s = stateAt(antic, 0.1);
    near(s.x, 100 * pAntic, '标量如实预冲');
    near(warpX(s), 100 * pAntic, 'warp 必须同步预冲（修复前恒为 0）');
    assert.ok(warpX(s) < 0, '预冲阶段网格应越过起始帧朝反方向走');

    // h1.y=1.56 → 过冲，p 在段中后段超过 1
    const over = trackWith('bezier', [0.34, 1.56], [0.64, 1]);
    for (const t of [0.6, 0.8, 1, 1.2]) {
        const st = stateAt(over, t);
        near(warpX(st), st.x, `t=${t} 时 warp 与 x 必须逐点相等`);
    }
    near(warpX(stateAt(over, 1)), 108.74006702187825, 't=1 的过冲量');
    assert.ok(warpX(stateAt(over, 1)) > 100, '过冲阶段应越过末帧的 100');
});

test('ease:hold 整段保持起始帧状态（含 warp）', () => {
    const hold = trackWith('hold');
    for (const t of [0, 0.5, 1, 1.5, 1.999999]) {
        const st = stateAt(hold, t);
        near(st.x, 0, `t=${t} 标量保持`);
        near(warpX(st), 0, `t=${t} warp 保持`);
        assert.deepEqual(warpPts(st), ZERO_PTS, `t=${t} 网格应完全是起始帧的零偏移`);
    }
    // hold 只压住段内；到下一帧的时间点仍取下一帧本身
    near(warpX(stateAt(hold, 2)), 100, '段末端点属于下一帧');
});

test('端点值不受缓动影响（含贝塞尔手柄、hold）', () => {
    const cases = [
        ['linear'],
        ['bezier', [0.42, 0], [0.58, 1]],
        ['bezier', [0.34, 1.56], [0.64, 1]],
        ['bezier', [0.34, -0.3], [0.36, 1]],
        ['hold'],
    ];
    for (const [ease, h1, h2] of cases) {
        const trk = trackWith(ease, h1, h2);
        const label = `${ease} ${JSON.stringify(h1 || null)}`;
        assert.deepEqual(warpPts(stateAt(trk, 0)), ZERO_PTS, `${label} t=0 取关键帧本身`);
        assert.deepEqual(warpPts(stateAt(trk, 2)), [[100, 0], [0, 0], [0, 0], [0, 0]], `${label} 段末取关键帧本身`);
        near(stateAt(trk, 0).x, 0, `${label} t=0 标量`);
        near(stateAt(trk, 2).x, 100, `${label} 段末标量`);
        // 区间外夹到端点，不外插
        near(warpX(stateAt(trk, -5)), 0, `${label} 负时间夹到起点`);
        near(warpX(stateAt(trk, 99)), 100, `${label} 超段时间夹到终点`);
    }
});

// ---------- 2. 三角形缝隙 ----------

const polyArea = (poly) => {
    let s = 0;
    for (let i = 0; i < poly.length; i += 1) {
        const a = poly[i];
        const b = poly[(i + 1) % poly.length];
        s += a[0] * b[1] - b[0] * a[1];
    }
    return s / 2;
};

// 凸多边形（逆时针）包含判定，带容差
function inside(p, tri, eps = 1e-9) {
    for (let i = 0; i < tri.length; i += 1) {
        const a = tri[i];
        const b = tri[(i + 1) % tri.length];
        const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
        if (cross < -eps) return false;
    }
    return true;
}

// Sutherland–Hodgman：用凸多边形的每条边所在半平面裁一刀
function clipHalfPlane(poly, a, b) {
    const out = [];
    const side = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    for (let i = 0; i < poly.length; i += 1) {
        const cur = poly[i];
        const nxt = poly[(i + 1) % poly.length];
        const sc = side(cur);
        const sn = side(nxt);
        if (sc >= 0) out.push(cur);
        if ((sc > 0 && sn < 0) || (sc < 0 && sn > 0)) {
            const k = sc / (sc - sn);
            out.push([cur[0] + (nxt[0] - cur[0]) * k, cur[1] + (nxt[1] - cur[1]) * k]);
        }
    }
    return out;
}

function intersectConvex(subject, clip) {
    let out = subject;
    for (let i = 0; i < clip.length && out.length; i += 1) {
        out = clipHalfPlane(out, clip[i], clip[(i + 1) % clip.length]);
    }
    return out;
}

test('inflateTriangle：新边与原边平行、间距恰为 pad，原三角形被整个包住', () => {
    const pad = 0.5;
    const T = [[0, 0], [10, 0], [0, 10]];
    const snapshot = JSON.stringify(T);
    const I = inflateTriangle(T, pad);
    assert.equal(JSON.stringify(T), snapshot, '不得就地修改入参');

    for (let i = 0; i < 3; i += 1) {
        const a = T[i];
        const b = T[(i + 1) % 3];
        const c = I[i];
        const d = I[(i + 1) % 3];
        const ex = b[0] - a[0];
        const ey = b[1] - a[1];
        const fx = d[0] - c[0];
        const fy = d[1] - c[1];
        const len = Math.hypot(ex, ey);
        near(ex * fy - ey * fx, 0, `边${i} 必须与对应原边平行`, 1e-9);
        assert.ok(ex * fx + ey * fy > 0, `边${i} 方向不得翻转`);
        // 逆时针三角形内部在 a→b 左侧，外扩后应为 -pad
        near((ex * (c[1] - a[1]) - ey * (c[0] - a[0])) / len, -pad, `边${i} 外移距离`);
    }
    for (const p of T) assert.ok(inside(p, I), `原顶点 ${JSON.stringify(p)} 应落在外扩三角形内`);
    near(polyArea(I), 68.528174593052, '外扩后面积', 1e-6);
    assert.ok(polyArea(I) > polyArea(T), `面积应变大：${polyArea(I)} > ${polyArea(T)}`);
});

test('inflateTriangle：退化与边界输入都不产生 NaN', () => {
    const T = [[0, 0], [10, 0], [0, 10]];
    assert.deepEqual(inflateTriangle(T, 0), T, 'pad=0 时原样返回（逐边等距 0）');
    const collinear = inflateTriangle([[0, 0], [5, 5], [10, 10]], 0.5);
    for (const p of collinear) for (const v of p) assert.ok(Number.isFinite(v), '三点共线不得出 NaN');
    const dup = inflateTriangle([[0, 0], [0, 0], [10, 0]], 0.5);
    for (const p of dup) for (const v of p) assert.ok(Number.isFinite(v), '零长边不得出 NaN');
    // 顺时针输入同样外扩（方向由有向面积决定）
    const cw = inflateTriangle([[0, 0], [0, 10], [10, 0]], 0.5);
    near(polyArea(cw), -68.528174593052, '顺时针三角形面积取负、绝对值同样变大', 1e-6);
    for (const p of cw) for (const v of p) assert.ok(Number.isFinite(v), '顺时针不得出 NaN');
});

test('设备像素换算：缩放越大，用户空间的 pad 越小', () => {
    const at = (a, d) => ({ getTransform: () => ({ a, b: 0, c: 0, d, e: 0, f: 0 }) });
    near(devicePad(at(2, 2), 0.5), 0.25, '2× 缩放 → 0.25 用户单位 = 0.5 设备像素');
    near(devicePad(at(0.5, 0.5), 0.5), 1, '0.5× 缩放 → 1 用户单位');
    near(devicePad(at(1, 4), 0.5), 0.5, '两轴取较小者，保证两个方向都够 0.5 设备像素');
    near(devicePad({}, 0.5), 0.5, '没有 getTransform 的上下文按原值');
    near(devicePad(at(0, 0), 0.5), 0.5, '零缩放兜底');
    near(devicePad(at(1, 1), -1), 0.5, '非法 pad 回落到半个设备像素');
});

test('相邻三角形外扩后共享边两侧重叠（这就是缝被盖住的证据）', () => {
    const pad = 0.5;
    // 10×10 方块沿对角线劈成两片，共享边 (0,0)-(10,10)
    const T1 = [[0, 0], [10, 0], [10, 10]];
    const T2 = [[0, 0], [10, 10], [0, 10]];
    const I1 = inflateTriangle(T1, pad);
    const I2 = inflateTriangle(T2, pad);

    // 修复前：两片只在共享边上「接触」，交集面积恒为 0 —— 抗锯齿一削就是透明缝
    near(polyArea(intersectConvex(T1, T2)), 0, '未外扩时交集面积为 0', 1e-9);

    const mid = [5, 5];
    assert.ok(inside(mid, I1), '共享边中点应落进 T1 的外扩区域');
    assert.ok(inside(mid, I2), '共享边中点应落进 T2 的外扩区域');

    const inter = intersectConvex(I1, I2);
    const area = Math.abs(polyArea(inter));
    assert.ok(area > 0, `重叠面积必须 > 0，实得 ${area}`);
    // 量级：沿长度 10√2 的共享边铺一条 2·pad 宽的带
    assert.ok(area > 10, `重叠面积应达到 2·pad·len 的量级，实得 ${area}`);
    near(area, 15.056349186104029, '重叠面积', 1e-6);
});

test('drawTexCell 的裁剪片面积大于原始三角形且两片互相重叠', () => {
    const clips = [];
    let cur = null;
    const g = {
        save() {},
        restore() {},
        beginPath() { cur = []; },
        moveTo(x, y) { cur = [[x, y]]; },
        lineTo(x, y) { if (cur) cur.push([x, y]); },
        closePath() {},
        clip() { if (cur) clips.push(cur); },
        transform() {},
        drawImage() {},
        getTransform() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; },
    };
    // 注意：平行四边形（仿射）走快路径 —— 一次 drawImage、零次 clip，所以这里
    // 特意用一个「非仿射」的网格（左上顶点偏移）来测两片三角形 + 重叠。
    const lat = { cols: 1, rows: 1, pts: [[6, 8], [0, 0], [0, 0], [0, 0]] };
    drawLatticeImage(g, { width: 40, height: 40 }, lat, 40, 40, 1);
    assert.equal(clips.length, 2, '非仿射子格拆两片三角形 → 两次 clip');
    for (const tri of clips) {
        // 40×40 的格子、左上角被拖开 6/8，剖出的三角形约 560；外扩后只会更大
        assert.ok(polyArea(tri) > 400, `外扩后每片面积应 > 400，实得 ${polyArea(tri)}`);
    }
    const area = Math.abs(polyArea(intersectConvex(clips[0], clips[1])));
    assert.ok(area > 0, `相邻两片必须重叠，实得 ${area}`);
});
