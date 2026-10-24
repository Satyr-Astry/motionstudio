/**
 * core/gizmo.mjs 单测：手柄几何 / 命中 / 变换应用 / 拖动补丁。
 *
 * 全部是纯函数，不需要 DOM、canvas 上下文或外壳上下文：
 * 坐标一律是「宿主相对的屏幕像素」，边长 100×80 的矩形四角在 (0,0)-(100,80)。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    HANDLE_NAMES, HANDLE_UV, HANDLE_PX, HIT_PX, ROTATE_GAP,
    handlePositions, pickHandle, applyScale, applyRotate, angleOf,
    clampScale, wrapDeg, localDelta, dragPatch, quadPoint,
} from '../app/core/gizmo.mjs';
import { createDoc, patchObject, objectById } from '../app/core/doc-model.mjs';
import {
    elementSize, anchorPoint, elementWorldMatrix, applyMatrix, elementState,
} from '../app/core/element.mjs';

/** 正放的矩形四角（屏幕空间） */
const RECT = {
    tl: { x: 0, y: 0 },
    tr: { x: 100, y: 0 },
    br: { x: 100, y: 80 },
    bl: { x: 0, y: 80 },
};

/** 同一个矩形旋转 90° 后的四角：上边朝 +x */
const ROT90 = {
    tl: { x: 100, y: 0 },
    tr: { x: 100, y: 80 },
    br: { x: 0, y: 80 },
    bl: { x: 0, y: 0 },
};

/** 浮点近似比较（几何结果只保证到 1e-9） */
function near(actual, expected, eps = 1e-9) {
    assert.ok(Math.abs(actual - expected) <= eps, `${actual} ≉ ${expected}`);
}

function nearPoint(actual, expected, eps = 1e-9) {
    near(actual.x, expected.x, eps);
    near(actual.y, expected.y, eps);
}

test('常量：8 个手柄按 nw → w 排序，命中半径仍是 9 屏幕像素', () => {
    assert.deepEqual(HANDLE_NAMES, ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']);
    assert.equal(HANDLE_PX, 4);
    assert.equal(HIT_PX, 9);
    assert.equal(ROTATE_GAP, 26);
    // 归一化位置与 element.mjs 的四边形参数一致：四角 0/1，边中点 0.5
    assert.deepEqual(HANDLE_UV.nw, [0, 0]);
    assert.deepEqual(HANDLE_UV.n, [0.5, 0]);
    assert.deepEqual(HANDLE_UV.e, [1, 0.5]);
    assert.deepEqual(HANDLE_UV.s, [0.5, 1]);
    assert.deepEqual(HANDLE_UV.w, [0, 0.5]);
});

test('handlePositions：正放四边形的 8 个手柄落在角与边中点上', () => {
    const pos = handlePositions(RECT);
    nearPoint(pos.nw, { x: 0, y: 0 });
    nearPoint(pos.n, { x: 50, y: 0 });
    nearPoint(pos.ne, { x: 100, y: 0 });
    nearPoint(pos.e, { x: 100, y: 40 });
    nearPoint(pos.se, { x: 100, y: 80 });
    nearPoint(pos.s, { x: 50, y: 80 });
    nearPoint(pos.sw, { x: 0, y: 80 });
    nearPoint(pos.w, { x: 0, y: 40 });
});

test('handlePositions：旋转柄沿上边法线外扩 ROTATE_GAP', () => {
    const pos = handlePositions(RECT);
    nearPoint(pos.top, { x: 50, y: 0 });
    nearPoint(pos.bottom, { x: 50, y: 80 });
    nearPoint(pos.center, { x: 50, y: 40 });
    // 上边朝外 = 朝屏幕上方 = (0,-1)
    nearPoint(pos.dir, { x: 0, y: -1 });
    nearPoint(pos.rotate, { x: 50, y: -26 });
    // 手柄自带名字，方便绘制循环直接用
    assert.equal(pos.nw.name, 'nw');
    assert.equal(pos.se.name, 'se');
});

test('handlePositions：旋转 90° 的四边形手柄跟着走，法线仍朝外', () => {
    const pos = handlePositions(ROT90);
    nearPoint(pos.nw, { x: 100, y: 0 });
    nearPoint(pos.n, { x: 100, y: 40 });
    nearPoint(pos.ne, { x: 100, y: 80 });
    nearPoint(pos.e, { x: 50, y: 80 });
    nearPoint(pos.se, { x: 0, y: 80 });
    nearPoint(pos.s, { x: 0, y: 40 });
    nearPoint(pos.sw, { x: 0, y: 0 });
    nearPoint(pos.w, { x: 50, y: 0 });
    // 上边中点 (100,40)、下边中点 (0,40) → 朝外是 +x，旋转柄在右侧 26px
    nearPoint(pos.dir, { x: 1, y: 0 });
    nearPoint(pos.rotate, { x: 100 + ROTATE_GAP, y: 40 });
});

test('handlePositions：退化成线的四边形不会算出 NaN（法线兜底）', () => {
    const flat = {
        tl: { x: 0, y: 0 }, tr: { x: 100, y: 0 }, br: { x: 100, y: 0 }, bl: { x: 0, y: 0 },
    };
    const pos = handlePositions(flat);
    assert.ok(Number.isFinite(pos.rotate.x) && Number.isFinite(pos.rotate.y));
    assert.ok(Number.isFinite(pos.dir.x) && Number.isFinite(pos.dir.y));
});

test('pickHandle：8 个手柄各自精确命中，返回 kind=scale', () => {
    const pos = handlePositions(RECT);
    for (const name of HANDLE_NAMES) {
        const hit = pickHandle(RECT, pos[name], { mode: 'transform' });
        assert.deepEqual(hit, { kind: 'scale', name }, `手柄 ${name} 未命中`);
    }
});

test('pickHandle：手柄外围 HIT_PX 内命中，超出一个像素就落空', () => {
    // ne 在 (100,0)，(105,-5) 距离 ≈ 7.07 < 9
    assert.deepEqual(pickHandle(RECT, { x: 105, y: -5 }, { mode: 'transform' }), { kind: 'scale', name: 'ne' });
    // (100,-10) 距离 10 > 9，且离其它手柄更远
    assert.equal(pickHandle(RECT, { x: 100, y: -10 }, { mode: 'transform' }), null);
});

test('pickHandle：旋转柄命中范围同样是 HIT_PX', () => {
    const pos = handlePositions(RECT);
    assert.deepEqual(pickHandle(RECT, pos.rotate, { mode: 'transform' }), { kind: 'rotate', name: 'rotate' });
    // 往下 8px（离上边 18px）仍在 9px 内
    assert.deepEqual(pickHandle(RECT, { x: 50, y: -18 }, { mode: 'transform' }), { kind: 'rotate', name: 'rotate' });
    // 往下 10px（离手柄 10px > 9）落空
    assert.equal(pickHandle(RECT, { x: 50, y: -16 }, { mode: 'transform' }), null);
});

test('pickHandle：四边形内部缺省判为移动，inside:false 可关掉', () => {
    const center = { x: 50, y: 40 };
    // 缺省：按四角双线性反解判定，内部 → move
    assert.deepEqual(pickHandle(RECT, center, { mode: 'transform' }), { kind: 'move', name: 'move' });
    // 明确关掉移动（画笔等工具就是这么做的）
    assert.equal(pickHandle(RECT, center, { mode: 'transform', inside: false }), null);
    // 也可以给谓词，参数是那个点（外壳传 worldToLocal，网格变形时更精确）
    let seen = null;
    const hit = pickHandle(RECT, center, { mode: 'transform', inside: (p) => { seen = p; return true; } });
    assert.deepEqual(hit, { kind: 'move', name: 'move' });
    assert.deepEqual(seen, center);
});

test('pickHandle：手柄优先于移动，外部点返回 null', () => {
    // 正好压在 nw 上：即使内部判定为真也要先被判成缩放手柄
    assert.deepEqual(
        pickHandle(RECT, { x: 0, y: 0 }, { mode: 'transform' }),
        { kind: 'scale', name: 'nw' },
    );
    // 四边形外面、离所有手柄都远
    assert.equal(pickHandle(RECT, { x: -200, y: -200 }, { mode: 'transform' }), null);
    assert.equal(pickHandle(RECT, { x: 300, y: 300 }, { mode: 'transform' }), null);
    // 布尔 true 表示「无条件算在内部」——这是给调用方的口子
    assert.deepEqual(pickHandle(RECT, { x: -200, y: -200 }, { mode: 'transform', inside: true }), { kind: 'move', name: 'move' });
});


test('pickHandle：warp 模式只命中网格顶点，顶点之间交给移动/整体手柄', () => {
    const lattice = {
        cols: 2,
        rows: 1,
        points: [[0, 0], [50, 0], [100, 0], [0, 80], [50, 80], [100, 80]],
    };
    const opts = { mode: 'warp', lattice };
    // 四个角是顶点（索引 r*(cols+1)+c）
    assert.deepEqual(pickHandle(RECT, { x: 0, y: 0 }, opts), { kind: 'lattice', name: 'v0', vertex: 0 });
    assert.deepEqual(pickHandle(RECT, { x: 100, y: 0 }, opts), { kind: 'lattice', name: 'v2', vertex: 2 });
    assert.deepEqual(pickHandle(RECT, { x: 0, y: 80 }, opts), { kind: 'lattice', name: 'v3', vertex: 3 });
    assert.deepEqual(pickHandle(RECT, { x: 100, y: 80 }, opts), { kind: 'lattice', name: 'v5', vertex: 5 });
    // 单元格中心既不是顶点也不靠近手柄 → 不命中顶点（内部再判为移动，不是 lattice）
    assert.equal(pickHandle(RECT, { x: 50, y: 40 }, opts).kind, 'move');
    // 关掉移动后就没有任何命中
    assert.equal(pickHandle(RECT, { x: 50, y: 40 }, { ...opts, inside: false }), null);
});

test('pickHandle：warp 模式下 8 个整体手柄仍然可用', () => {
    const lattice = { cols: 1, rows: 1, points: [[0, 0], [100, 0], [0, 80], [100, 80]] };
    const opts = { mode: 'warp', lattice };
    // (100,40) 离最近顶点 (100,0)/(100,80) 都是 40px，不构成顶点命中
    assert.deepEqual(pickHandle(RECT, { x: 100, y: 40 }, opts), { kind: 'scale', name: 'e' });
    assert.deepEqual(pickHandle(RECT, { x: 0, y: 40 }, opts), { kind: 'scale', name: 'w' });
    // 旋转柄同理
    assert.deepEqual(pickHandle(RECT, { x: 50, y: -26 }, opts), { kind: 'rotate', name: 'rotate' });
});

test('pickHandle：等距顶点取最后一个（与原实现一致），threshold 可覆盖', () => {
    const lattice = {
        cols: 2,
        rows: 1,
        points: [[0, 0], [50, 0], [100, 0], [0, 80], [50, 80], [100, 80]],
    };
    // (25,0) 到 v0 / v1 都是 25px：放宽 threshold 后两个都命中，后者胜出
    assert.deepEqual(
        pickHandle(RECT, { x: 25, y: 0 }, { mode: 'warp', lattice, threshold: 30 }),
        { kind: 'lattice', name: 'v1', vertex: 1 },
    );
    // 默认 9px 阈值下这根线中间谁也命不中（关掉移动判定后即为 null）
    assert.equal(pickHandle(RECT, { x: 25, y: 0 }, { mode: 'warp', lattice, inside: false }), null);
});

test('pickHandle：lattice 也可以给 map(u,v) 回调，数组或点对象都接受', () => {
    const asArray = { cols: 1, rows: 1, map: (u, v) => [u * 100, v * 80] };
    assert.deepEqual(
        pickHandle(RECT, { x: 0, y: 80 }, { mode: 'warp', lattice: asArray }),
        { kind: 'lattice', name: 'v2', vertex: 2 },
    );
    const asPoint = { cols: 1, rows: 1, map: (u, v) => ({ x: u * 100, y: v * 80 }) };
    assert.deepEqual(
        pickHandle(RECT, { x: 100, y: 0 }, { mode: 'warp', lattice: asPoint }),
        { kind: 'lattice', name: 'v1', vertex: 1 },
    );
});

test('applyScale：只返回被该手柄驱动的轴', () => {
    const s = { scaleX: 2, scaleY: 3 };
    assert.deepEqual(applyScale(s, 'nw', 1.5, 0.5), { scaleX: 3, scaleY: 1.5 });
    assert.deepEqual(applyScale(s, 'se', 1.5, 0.5), { scaleX: 3, scaleY: 1.5 });
    // n / s 只动 y，e / w 只动 x
    assert.deepEqual(applyScale(s, 'n', 9, 0.5), { scaleY: 1.5 });
    assert.deepEqual(applyScale(s, 's', 9, 2), { scaleY: 6 });
    assert.deepEqual(applyScale(s, 'e', 2, 9), { scaleX: 4 });
    assert.deepEqual(applyScale(s, 'w', 0.5, 9), { scaleX: 1 });
});

test('applyScale：退化轴（null / NaN）跳过，缺字段按 1 起算', () => {
    assert.deepEqual(applyScale({ scaleX: 2, scaleY: 3 }, 'se', null, 2), { scaleY: 6 });
    assert.deepEqual(applyScale({ scaleX: 2, scaleY: 3 }, 'se', 2, null), { scaleX: 4 });
    assert.deepEqual(applyScale({ scaleX: 2, scaleY: 3 }, 'se', NaN, NaN), {});
    assert.deepEqual(applyScale({}, 'se', 2, 3), { scaleX: 2, scaleY: 3 });
    assert.deepEqual(applyScale(null, 'se', 2, 3), { scaleX: 2, scaleY: 3 });
});

test('applyScale：clampScale 上下限（0.01 / ±50 / 非有限值）', () => {
    assert.equal(clampScale(0), 0.01);
    assert.equal(clampScale(-0), 0.01);
    assert.equal(clampScale(-0.001), -0.01);
    assert.equal(clampScale(0.0005), 0.01);
    assert.equal(clampScale(1e6), 50);
    assert.equal(clampScale(-1e6), -50);
    assert.equal(clampScale(NaN), 1);
    assert.equal(clampScale(Infinity), 1);
    assert.equal(clampScale(1.25), 1.25);
    // 通过 applyScale 也走同一层保护
    assert.deepEqual(applyScale({ scaleX: 40, scaleY: -40 }, 'se', 10, -10), { scaleX: 50, scaleY: 50 });
});

test('applyRotate：叠加角度增量并归一化到 (-180, 180]', () => {
    assert.equal(applyRotate({ rotate: 0 }, 0), 0);
    // 0 度不是 -0
    assert.ok(Object.is(applyRotate({ rotate: 0 }, 0), 0));
    assert.equal(applyRotate({ rotate: 10.5 }, 5.5), 16);
    assert.equal(applyRotate({ rotate: -30 }, -15), -45);
    // 正向超 180 折回负半区
    assert.equal(applyRotate({ rotate: 170 }, 20), -170);
    assert.equal(applyRotate({ rotate: 0 }, 190), -170);
    // 负向到 -180 折成 +180（区间左开）
    assert.equal(applyRotate({ rotate: 0 }, -180), 180);
    assert.equal(applyRotate({ rotate: 180 }, 180), 0);
    // 整圈归零
    assert.equal(applyRotate({ rotate: 0 }, 360), 0);
    assert.equal(applyRotate({ rotate: 45 }, -405), 0);
    // 缺省 / 非法输入
    assert.equal(applyRotate({}, 30), 30);
    assert.equal(applyRotate(null, 30), 30);
    assert.equal(applyRotate({ rotate: 20 }, NaN), 20);
});

test('wrapDeg：0 / 负数 / 超 180 的归一化', () => {
    assert.equal(wrapDeg(0), 0);
    assert.equal(wrapDeg(180), 180);
    assert.equal(wrapDeg(-180), 180);
    assert.equal(wrapDeg(-181), 179);
    assert.equal(wrapDeg(181), -179);
    assert.equal(wrapDeg(270), -90);
    assert.equal(wrapDeg(720), 0);
    assert.equal(wrapDeg(NaN), 0);
});

test('angleOf：两点夹角（弧度），0 度 / 负角 / 原点退化', () => {
    const o = { x: 0, y: 0 };
    near(angleOf(o, { x: 1, y: 0 }), 0);
    near(angleOf(o, { x: 0, y: 1 }), Math.PI / 2);
    near(angleOf(o, { x: -1, y: 0 }), Math.PI);
    // 屏幕坐标 y 向下 → 往上走是负角
    near(angleOf(o, { x: 0, y: -1 }), -Math.PI / 2);
    // 平移不变：中心不在原点时结果一致
    near(angleOf({ x: 30, y: 40 }, { x: 30, y: 30 }), -Math.PI / 2);
    // 两点重合 / 缺参时退回 0
    assert.equal(angleOf(o, o), 0);
    assert.equal(angleOf(null, { x: 1, y: 1 }), 0);
});

test('localDelta：世界位移经父链逆矩阵换成局部位移', () => {
    assert.deepEqual(localDelta(null, 10, 5), { x: 10, y: 5 });
    // 父级旋转 90°（x' = -y, y' = x）→ 逆矩阵把世界 (10,0) 换成局部 (0,-10)
    const inv = { a: 0, b: -1, c: 1, d: 0, e: 0, f: 0 };
    assert.deepEqual(localDelta(inv, 10, 0), { x: 0, y: -10 });
    // 父级 2 倍缩放 → 位移减半
    assert.deepEqual(localDelta({ a: 0.5, b: 0, c: 0, d: 0.5, e: 0, f: 0 }, 10, 4), { x: 5, y: 2 });
});

/* ── 拖动补丁：四分支各一条 ── */

function makeDocAndEl(patch) {
    const base = createDoc({ width: 100, height: 80 });
    const first = base.objects[0];
    const doc = patch ? patchObject(base, first.id, patch) : base;
    return { doc, el: objectById(doc, first.id) };
}

test('dragPatch：move 无父级时直接用世界位移', () => {
    const { doc, el } = makeDocAndEl(null);
    const size = elementSize(doc, el, 0);
    const out = dragPatch({
        pick: { kind: 'move' },
        doc, el, time: 0, parentM: null,
        start: { x: 10, y: 20, scaleX: 1, scaleY: 1, rotate: 0 },
        p0: { x: 0, y: 0 }, p: { x: 12, y: -7 }, size,
        anchorWorld: applyMatrix(elementWorldMatrix(el, 0, size, null), anchorPoint(el, size)),
    });
    assert.deepEqual(out, { x: 22, y: 13 });
});

test('dragPatch：move 走父链逆矩阵（父级旋转 90° 时位移换轴）', () => {
    const { doc, el } = makeDocAndEl(null);
    const size = elementSize(doc, el, 0);
    const out = dragPatch({
        pick: { kind: 'move' },
        doc, el, time: 0,
        parentM: { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 },   // 父级旋转 90°
        start: { x: 0, y: 0 },
        p0: { x: 0, y: 0 }, p: { x: 10, y: 0 }, size,
        anchorWorld: { x: 0, y: 0 },
    });
    assert.deepEqual(out, { x: 0, y: -10 });
});

test('dragPatch：rotate 用锚点两侧的世界角差，且不做 ±180 折叠', () => {
    const { doc, el } = makeDocAndEl(null);
    const size = elementSize(doc, el, 0);
    const base = dragPatch({
        pick: { kind: 'rotate' },
        doc, el, time: 0, parentM: null,
        start: { rotate: 0 },
        p0: { x: 100, y: 0 }, p: { x: 0, y: 100 }, size,
        anchorWorld: { x: 0, y: 0 },
    });
    near(base.rotate, 90);
    // 再拖 90°：170 + 90 = 260 —— 保留原实现，不折到 -100
    // （属性面板直接显示这个数，折叠会让重构前后的关键帧内容对不上）
    const raw = dragPatch({
        pick: { kind: 'rotate' },
        doc, el, time: 0, parentM: null,
        start: { rotate: 170 },
        p0: { x: 100, y: 0 }, p: { x: 0, y: 100 }, size,
        anchorWorld: { x: 0, y: 0 },
    });
    near(raw.rotate, 260);
});

test('dragPatch：scale 按局部轴投影算比例，单轴手柄只写一轴', () => {
    const { doc, el } = makeDocAndEl(null);
    const size = elementSize(doc, el, 0);
    const anchorWorld = { x: 0, y: 0 };
    // e 手柄：沿 +x 拉出 30%，y 方向不变
    assert.deepEqual(dragPatch({
        pick: { kind: 'scale', name: 'e' },
        doc, el, time: 0, parentM: null,
        start: { scaleX: 1, scaleY: 1 },
        p0: { x: 100, y: 40 }, p: { x: 130, y: 40 }, size, anchorWorld,
    }), { scaleX: 1.3 });
    // se 手柄：两轴同时放大 1.5 倍
    const both = dragPatch({
        pick: { kind: 'scale', name: 'se' },
        doc, el, time: 0, parentM: null,
        start: { scaleX: 1, scaleY: 1 },
        p0: { x: 100, y: 80 }, p: { x: 150, y: 120 }, size, anchorWorld,
    });
    near(both.scaleX, 1.5);
    near(both.scaleY, 1.5);
});

test('dragPatch：warp 顶点位移换算到对象局部空间后累加', () => {
    const { doc, el } = makeDocAndEl((o) => {
        o.transform = { keys: [{ t: 0, state: Object.assign({}, elementState(o, 0)) }] };
        return o;
    });
    const size = elementSize(doc, el, 0);
    const out = dragPatch({
        pick: { kind: 'lattice', vertex: 0 },
        doc, el, time: 0, parentM: null,
        start: { warp: { cols: 1, rows: 1, pts: [[5, 5], [100, 0], [0, 80], [100, 80]] } },
        p0: { x: 0, y: 0 }, p: { x: 10, y: 5 }, size,
        anchorWorld: { x: 0, y: 0 },
    });
    assert.equal(out.warp.cols, 1);
    assert.equal(out.warp.rows, 1);
    assert.deepEqual(out.warp.pts[0], [15, 10]);
    // 其它顶点保持原样
    assert.deepEqual(out.warp.pts.slice(1), [[100, 0], [0, 80], [100, 80]]);
});

test('dragPatch：没有命中 / 未知 kind 时返回空补丁', () => {
    const { doc, el } = makeDocAndEl(null);
    const size = elementSize(doc, el, 0);
    const common = {
        doc, el, time: 0, parentM: null, start: { x: 1, y: 2 },
        p0: { x: 0, y: 0 }, p: { x: 10, y: 10 }, size, anchorWorld: { x: 0, y: 0 },
    };
    assert.deepEqual(dragPatch({ ...common, pick: null }), {});
    assert.deepEqual(dragPatch({ ...common, pick: { kind: 'nope' } }), {});
});

test('quadPoint：与 element.mjs 的双线性插值保持同一实现', () => {
    // 顶点
    assert.deepEqual(quadPoint(RECT, 0, 0), { x: 0, y: 0 });
    assert.deepEqual(quadPoint(RECT, 1, 1), { x: 100, y: 80 });
    // 中心
    assert.deepEqual(quadPoint(RECT, 0.5, 0.5), { x: 50, y: 40 });
    // 旋转四边形：u 沿上边，v 沿左边
    assert.deepEqual(quadPoint(ROT90, 0.5, 0), { x: 100, y: 40 });
    assert.deepEqual(quadPoint(ROT90, 0, 0.5), { x: 50, y: 0 });
});
