import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_STATE, TRACK_FIELDS, createTrack, createKey, addKey, removeKey, moveKey,
  setKeyState, setKeyEase, stateAt, isIdentity, matrixOf, warpQuad,
  lerp, solveBezierYForX,
} from '../app/core/transform.mjs';

// 浮点近似断言（容差 1e-6）
const near = (a, b, m = '') => assert.ok(Math.abs(a - b) < 1e-6, `${m} ${a} vs ${b}`);

// x: 0 → 100，t 从 0 到 1
const walk = () => addKey(addKey(createTrack(), 1, { x: 100 }), 0, { x: 0 });

test('DEFAULT_STATE 冻结，TRACK_FIELDS 为标量字段表', () => {
  assert.ok(Object.isFrozen(DEFAULT_STATE));
  assert.equal(DEFAULT_STATE.warp, null);
  assert.equal(DEFAULT_STATE.scaleX, 1);
  assert.deepEqual([...TRACK_FIELDS], ['x', 'y', 'scaleX', 'scaleY', 'rotate', 'skewX', 'skewY', 'opacity']);
});

test('createTrack 每次返回独立的空轨道', () => {
  const a = createTrack();
  assert.deepEqual(a, { keys: [] });
  assert.notEqual(createTrack(), a);
});

test('createKey 补齐缺省 state 与 ease', () => {
  const k = createKey(0.5, { x: 10 });
  assert.equal(k.t, 0.5);
  assert.equal(k.ease, 'linear');
  assert.deepEqual(k.h1, [0.25, 0.1]);
  assert.deepEqual(k.h2, [0.75, 0.9]);
  assert.deepEqual(k.state, {
    x: 10, y: 0, scaleX: 1, scaleY: 1, rotate: 0, skewX: 0, skewY: 0, opacity: 1, warp: null,
  });
});

test('createKey 拒绝非法 t，非法 ease 回落 linear', () => {
  assert.throws(() => createKey(NaN, {}), TypeError);
  assert.throws(() => createKey(Infinity, {}), TypeError);
  assert.throws(() => createKey('1', {}), TypeError);
  assert.equal(createKey(1, {}, 'hold').ease, 'hold');
  assert.equal(createKey(1, {}, 'bogus').ease, 'linear');
  assert.deepEqual(createKey(1, {}, 'bezier', [0.1, 0.2], [0.8, 0.9]).h1, [0.1, 0.2]);
});

test('createKey 深拷贝 warp，不与入参共享数组', () => {
  const warp = { tl: [1, 2] };
  const k = createKey(0, { warp });
  // 旧四角格式读入时升级成 1×1 网格：pts = [tl, tr, bl, br]
  assert.equal(k.state.warp.cols, 1);
  assert.equal(k.state.warp.rows, 1);
  assert.deepEqual(k.state.warp.pts, [[1, 2], [0, 0], [0, 0], [0, 0]]);
  assert.notEqual(k.state.warp.pts[0], warp.tl);
});

test('addKey 按 t 升序插入', () => {
  let trk = createTrack();
  trk = addKey(trk, 2, { x: 2 });
  trk = addKey(trk, 0, { x: 0 });
  trk = addKey(trk, 1, { x: 1 });
  assert.deepEqual(trk.keys.map((k) => k.t), [0, 1, 2]);
  assert.deepEqual(trk.keys.map((k) => k.state.x), [0, 1, 2]);
});

test('addKey 同一 t（差 <1e-9）替换原帧', () => {
  const trk = addKey(addKey(createTrack(), 1, { x: 1 }), 1 + 1e-12, { x: 9, opacity: 0.5 });
  assert.equal(trk.keys.length, 1);
  assert.equal(trk.keys[0].state.x, 9);
  assert.equal(trk.keys[0].state.opacity, 0.5);
});

test('addKey 不修改入参 track', () => {
  const src = walk();
  const snapshot = JSON.parse(JSON.stringify(src));
  addKey(src, 0.5, { x: 50 });
  assert.deepEqual(JSON.parse(JSON.stringify(src)), snapshot);
});

test('removeKey 越界返回原引用，正常删除只删一帧', () => {
  const trk = walk();
  assert.equal(removeKey(trk, -1), trk);
  assert.equal(removeKey(trk, 2), trk);
  assert.equal(removeKey(trk, 1.5), trk);
  const next = removeKey(trk, 0);
  assert.deepEqual(next.keys.map((k) => k.t), [1]);
  assert.equal(trk.keys.length, 2);
});

test('moveKey 改时间并重新排序，不改入参', () => {
  const trk = addKey(walk(), 0.5, { x: 50 });
  const next = moveKey(trk, 0, 3);
  assert.deepEqual(next.keys.map((k) => k.t), [0.5, 1, 3]);
  assert.equal(next.keys[2].state.x, 0);
  assert.deepEqual(trk.keys.map((k) => k.t), [0, 0.5, 1]);
});

test('moveKey 撞时间时以被移动的帧为准', () => {
  const trk = addKey(walk(), 0.5, { x: 50 });
  const next = moveKey(trk, 1, 1); // 把 t=0.5 挪到 1，撞上原 t=1
  assert.deepEqual(next.keys.map((k) => k.t), [0, 1]);
  assert.equal(next.keys[1].state.x, 50);
});

test('setKeyState 合并补丁，保留未涉及字段，不改入参', () => {
  const trk = addKey(createTrack(), 0, { x: 1, scaleX: 2, opacity: 0.5 });
  const next = setKeyState(trk, 0, { x: 7, rotate: 45 });
  assert.equal(next.keys[0].state.x, 7);
  assert.equal(next.keys[0].state.rotate, 45);
  assert.equal(next.keys[0].state.scaleX, 2);
  assert.equal(next.keys[0].state.opacity, 0.5);
  assert.equal(trk.keys[0].state.x, 1);
  assert.equal(next.keys[0].state.y, 0);
});

test('setKeyState 用 warp:null 清空 warp，越界无副作用', () => {
  const trk = addKey(createTrack(), 0, { warp: { tl: [3, 4] } });
  const cleared = setKeyState(trk, 0, { warp: null });
  assert.equal(cleared.keys[0].state.warp, null);
  assert.equal(setKeyState(trk, 9, { x: 1 }), trk);
});

test('setKeyEase 设置 ease 与手柄', () => {
  const trk = addKey(createTrack(), 0, { x: 0 });
  const next = setKeyEase(trk, 0, 'bezier', [0.42, 0], [0.58, 1]);
  assert.equal(next.keys[0].ease, 'bezier');
  assert.deepEqual(next.keys[0].h1, [0.42, 0]);
  assert.deepEqual(next.keys[0].h2, [0.58, 1]);
  assert.equal(next.keys[0].state.x, 0);
  const keep = setKeyEase(next, 0, 'linear');
  assert.deepEqual(keep.keys[0].h1, [0.42, 0]);
  assert.equal(setKeyEase(trk, 5, 'hold'), trk);
});

test('stateAt 空轨道返回默认状态的新副本', () => {
  const s = stateAt(createTrack(), 1);
  assert.deepEqual(s, {
    x: 0, y: 0, scaleX: 1, scaleY: 1, rotate: 0, skewX: 0, skewY: 0, opacity: 1, warp: null,
  });
  assert.notEqual(s, DEFAULT_STATE);
});

test('stateAt 区间外取端点，不外插', () => {
  const trk = walk();
  assert.equal(stateAt(trk, -5).x, 0);
  assert.equal(stateAt(trk, 0).x, 0);
  assert.equal(stateAt(trk, 1).x, 100);
  assert.equal(stateAt(trk, 99).x, 100);
});

test('stateAt linear 线性插值', () => {
  const trk = addKey(walk(), 0.5, { x: 50, scaleX: 3, rotate: 90, opacity: 0 });
  near(stateAt(trk, 0.25).x, 25);
  near(stateAt(trk, 0.25).scaleX, 2);
  near(stateAt(trk, 0.25).rotate, 45);
  near(stateAt(trk, 0.25).opacity, 0.5);
});

test('stateAt hold 整段保持，下一帧起点才跳变', () => {
  const trk = addKey(addKey(createTrack(), 0, { x: 10 }, 'hold'), 1, { x: 90 });
  assert.equal(stateAt(trk, 0).x, 10);
  assert.equal(stateAt(trk, 0.5).x, 10);
  assert.equal(stateAt(trk, 0.999).x, 10);
  assert.equal(stateAt(trk, 1).x, 90);
});

test('stateAt bezier 对称曲线中点 0.5，且段内单调', () => {
  const trk = addKey(addKey(createTrack(), 0, { x: 0 }, 'bezier'), 1, { x: 100 });
  near(stateAt(trk, 0.5).x, 50);
  let prev = -1;
  for (let i = 0; i <= 10; i += 1) {
    const v = stateAt(trk, i / 10).x;
    assert.ok(v >= prev - 1e-9, `非单调 @ ${i / 10}`);
    prev = v;
  }
  const easeIn = addKey(
    addKey(createTrack(), 0, { x: 0 }, 'bezier', [0.42, 0], [1, 1]), 1, { x: 100 },
  );
  const mid = stateAt(easeIn, 0.5).x;
  assert.ok(mid > 0 && mid < 50, `ease-in 中点应小于 50，实际 ${mid}`);
});

test('stateAt 返回新对象，不污染关键帧状态', () => {
  const trk = addKey(addKey(createTrack(), 0, { warp: { tl: [1, 2] } }), 1, { warp: { tl: [3, 4] } });
  const s = stateAt(trk, 0.5);
  s.warp.pts[0][0] = 999;
  assert.equal(trk.keys[1].state.warp.pts[0][0], 3);
  assert.equal(stateAt(trk, 0.5).warp.pts[0][0], 2);
});

test('solveBezierYForX 端点固定且直线采样近似恒等', () => {
  assert.equal(solveBezierYForX(0.25, 0.1, 0.75, 0.9, 0), 0);
  assert.equal(solveBezierYForX(0.25, 0.1, 0.75, 0.9, 1), 1);
  for (const x of [0.1, 0.3, 0.5, 0.7, 0.9]) near(solveBezierYForX(0.25, 0.25, 0.75, 0.75, x), x);
  near(solveBezierYForX(0, 0, 1, 1, 0.37), 0.37);
});

test('solveBezierYForX 允许 y 方向越界（回弹）', () => {
  const y = solveBezierYForX(0.34, 1.56, 0.64, 1, 0.5);
  assert.ok(y > 1, `回弹曲线中点应大于 1，实际 ${y}`);
});

test('stateAt warp 两端插值', () => {
  const a = { tl: [0, 0], tr: [10, 0], br: [10, 10], bl: [0, 10] };
  const b = { tl: [2, 4], tr: [10, 0], br: [10, 10], bl: [0, 10] };
  const trk = addKey(addKey(createTrack(), 0, { warp: a }), 1, { warp: b });
  const s = stateAt(trk, 0.5);
  near(s.warp.pts[0][0], 1);
  near(s.warp.pts[0][1], 2);
  near(s.warp.pts[3][0], 10);
});

test('stateAt warp 一端为 null 视作四角零偏移', () => {
  const trk = addKey(addKey(createTrack(), 0, {}), 1, { warp: { tl: [8, 8] } });
  const s = stateAt(trk, 0.25);
  near(s.warp.pts[0][0], 2);
  near(s.warp.pts[1][0], 0);
  const back = stateAt(trk, 0.75);
  near(back.warp.pts[0][0], 6);
});

test('stateAt warp 两端 null 结果为 null', () => {
  const trk = addKey(addKey(createTrack(), 0, {}), 1, { x: 5 });
  assert.equal(stateAt(trk, 0.5).warp, null);
});

test('stateAt 的时间可以停在任意浮点秒（v6 没有帧序号）', () => {
  const layer = { transform: walk() };
  near(stateAt(layer.transform, 0).x, 0);
  near(stateAt(layer.transform, 0.1).x, 10);
  near(stateAt(layer.transform, 0.3).x, 30);
  near(stateAt(null, 2).x, 0);
  near(stateAt({ keys: [] }, 0.5).x, 0);
});

test('isIdentity 判定默认、零 warp 与非零差异', () => {
  assert.equal(isIdentity({}), true);
  assert.equal(isIdentity(DEFAULT_STATE), true);
  assert.equal(isIdentity({ warp: { tl: [0, 0], tr: [0, 0], br: [0, 0], bl: [0, 0] } }), true);
  assert.equal(isIdentity({ scaleX: 1 + 1e-10 }), true);
  assert.equal(isIdentity({ opacity: 0 }), false);
  assert.equal(isIdentity({ x: 0.5 }), false);
  assert.equal(isIdentity({ rotate: 1 }), false);
  assert.equal(isIdentity({ warp: { tl: [1, 0] } }), false);
});

test('matrixOf 默认状态为单位矩阵', () => {
  const m = matrixOf({});
  assert.deepEqual(Object.keys(m).sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
  near(m.a, 1); near(m.b, 0); near(m.c, 0); near(m.d, 1); near(m.e, 0); near(m.f, 0);
});

test('matrixOf 合成顺序：缩放 → 斜切 → 旋转 → 平移', () => {
  const t = matrixOf({ x: 10, y: 20, scaleX: 2, scaleY: 3 });
  near(t.a, 2); near(t.d, 3); near(t.e, 10); near(t.f, 20);
  const r = matrixOf({ rotate: 90 });
  near(r.a, 0); near(r.b, 1); near(r.c, -1); near(r.d, 0);
  // 先缩放再旋转：(1,0) 经 scaleX=2 得 (2,0)，再转 90° 得 (0,2)
  const sr = matrixOf({ scaleX: 2, rotate: 90 });
  near(sr.a, 0); near(sr.b, 2); near(sr.c, -1); near(sr.d, 0);
});

test('matrixOf 斜切（角度 deg）', () => {
  const kx = matrixOf({ skewX: 45 });
  near(kx.a, 1); near(kx.b, 0); near(kx.c, 1); near(kx.d, 1);
  const ky = matrixOf({ skewY: 45 });
  near(ky.a, 1); near(ky.b, 1); near(ky.c, 0); near(ky.d, 1);
});

test('warpQuad 返回四角绝对坐标', () => {
  assert.deepEqual(warpQuad({}, 10, 20), { tl: [0, 0], tr: [10, 0], br: [10, 20], bl: [0, 20] });
  const q = warpQuad({ warp: { tl: [1, 2], br: [-3, -4] } }, 10, 20);
  assert.deepEqual(q.tl, [1, 2]);
  assert.deepEqual(q.tr, [10, 0]);
  assert.deepEqual(q.br, [7, 16]);
  assert.deepEqual(q.bl, [0, 20]);
});

test('lerp 基本行为', () => {
  assert.equal(lerp(0, 100, 0.25), 25);
  assert.equal(lerp(4, 4, 0.9), 4);
  assert.equal(lerp(-1, 1, 0.5), 0);
});
