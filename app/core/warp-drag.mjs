/**
 * 网格软拖（在网格编辑里拖「非格点处」→ 影响附近格点）
 *
 * 过去的网格编辑只有一条路：拖顶点本身。用户在图像内部按住拖动时，命中的是
 * 「移动对象」，整块图被搬走 —— 这与 Klecks 的手感相反：那里在变形区域内部
 * 拖拽，是把附近几个控制点一起推出去，得到一个像橡皮泥的鼓包。
 *
 * 本模块把 Klecks 的 `transform/ffd.ts :: warpLatticeViaPoint` 移植过来，
 * 但**影响半径按格子数算**，不是按整块补丁的比例算。原因见 INFLUENCE_CELLS 注释。
 *
 * 只做几何：输入当前网格 + 参数坐标 + 局部像素位移，输出新网格顶点。
 * 不碰 DOM、不碰文档、不进撤销栈（那些由 editors/canvas-input.mjs 负责）。
 */

import { createLattice, latticeOffset, normalizeLattice } from './lattice.mjs';

/**
 * 影响半径，单位是「整块补丁的比例」，与 Klecks 的 `ffd.ts:325 influenceRadius` 同值。
 *
 * Klecks 的网格固定 5×5 个控制点（`kl-app-select.ts` 里 `n(5, 5, ...)`），
 * 也就是 4×4 个格子，所以 1/3 补丁 ≈ 1.33 格。
 */
export const KLEKS_PATCH_RADIUS = 1 / 3;

/**
 * 半径下限，单位是格子。
 *
 * 为什么必须有下限：我们的网格密度是用户可选的（1×1…12×12，见 lattice.MAX_DIV）。
 * 按补丁比例算时，1×1 网格的半径只有 0.33 格，而四角离中心的距离是 0.707 格 ——
 * 在中心拖拽会**一个顶点都碰不到**，也就是「拖了完全不动」（Klecks 从不出这种网格，
 * 所以它没有这个问题）。下限取 1 格，刚好让中心拖拽够到四角。
 */
export const MIN_INFLUENCE_CELLS = 1;

/**
 * 边缘衰减：Klecks 对「离拖动点比离中心更远」的轴再乘一次 0.5。
 * 效果是鼓包更贴合拖动点所在的一侧，而不是整块均匀鼓起。
 */
export const EDGE_FALLOFF = 0.5;

/** 增益下限：`|J|` 小于它时退回原始权重（退化网格的兜底） */
export const GAIN_EPS = 1e-6;

const F = [
    1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880, 3628800, 39916800, 479001600,
];

/** 伯恩斯坦基 `C(n,k)·(1-t)^(n-k)·t^k`，与 Klecks 的 bernstein 同式（阶乘表避免重复算） */
export function bernstein(n, k, t) {
    if (k < 0 || k > n) return 0;
    return (F[n] / (F[k] * F[n - k])) * (1 - t) ** (n - k) * t ** k;
}

/**
 * 算出每个顶点在这次拖动里的权重与强度（不含 1/J 归一化）。
 *
 * 返回按顶点索引排列的数组（长度 = (cols+1)×(rows+1)），每项
 * `{ index, weight, strength, alpha }`；`alpha` 已含 `1/Σw²·strength`，
 * 也就是 Klecks 的 `w / sumWeightsSq * strength`。
 *
 * @param {object} lattice 当前 warp（会先 normalize；空则按 1×1）
 * @param {number} u 拖动点参数横坐标（未夹取，越界也算，便于贴着边拖）
 * @param {number} v 拖动点参数纵坐标
 * @param {object} [opts] `{ patchRadius, minCells, edgeFalloff }`
 */
export function warpAllocation(lattice, u, v, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const radius = Number.isFinite(o.patchRadius) && o.patchRadius > 0 ? o.patchRadius : KLEKS_PATCH_RADIUS;
    const minCells = Number.isFinite(o.minCells) && o.minCells > 0 ? o.minCells : MIN_INFLUENCE_CELLS;
    const falloff = Number.isFinite(o.edgeFalloff) && o.edgeFalloff > 0 ? o.edgeFalloff : EDGE_FALLOFF;
    const L = normalizeLattice(lattice) || createLattice(1, 1);
    const { cols, rows } = L;
    // 每个轴单独取下限：非等比网格（比如 3×9）两侧的影响范围才都够得到附近顶点
    const ru = Math.max(radius, minCells / cols);
    const rv = Math.max(radius, minCells / rows);
    const out = [];
    let sumSq = 0;
    for (let r = 0; r <= rows; r++) {
        for (let c = 0; c <= cols; c++) {
            const sv = c / cols;
            const tv = r / rows;
            const weight = bernstein(cols, c, u) * bernstein(rows, r, v);
            const dist = Math.hypot((sv - u) / ru, (tv - v) / rv);
            let strength = Math.max(0, 1 - dist);
            if (Math.abs(sv - 0.5) > Math.abs(u - 0.5) || Math.abs(tv - 0.5) > Math.abs(v - 0.5)) {
                strength *= falloff;
            }
            sumSq += weight * weight * strength;
            out.push({ index: r * (cols + 1) + c, weight, strength, alpha: 0 });
        }
    }
    if (sumSq > 1e-12) {
        for (const it of out) it.alpha = (it.weight / sumSq) * it.strength;
    }
    return out;
}

/**
 * (u,v) 落在哪个 cell 里、以及该 cell 四角各自的权重 —— 与 latticeOffset 双线性一支同式。
 * 返回 `[[顶点索引, 权重], ...]`（最多 4 项）。
 */
function cellWeights(L, u, v) {
    const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
    const cu = clamp01(u) * L.cols;
    const cv = clamp01(v) * L.rows;
    const ci = Math.min(L.cols - 1, Math.floor(cu));
    const cj = Math.min(L.rows - 1, Math.floor(cv));
    const s = cu - ci;
    const t = cv - cj;
    const stride = L.cols + 1;
    const i00 = cj * stride + ci;
    return [
        [i00, (1 - s) * (1 - t)],
        [i00 + 1, s * (1 - t)],
        [i00 + stride, (1 - s) * t],
        [i00 + stride + 1, s * t],
    ];
}

/**
 * 增益 `J = Σ W_k·α_k`：`W_k` 是「只移动第 k 个顶点 1px」时 (u,v) 处的偏移增量。
 *
 * 因为 `latticeOffset` 对顶点是线性的（每个 cell 内双线性、权重只依赖 u,v，
 * 与顶点偏移本身无关），所以 `Σ α_k·Δ` 造成的实际位移正好是 `J·Δ`。
 * 除以 `J` 之后拖动点严格跟手——一次除法即闭合，不需要迭代求解
 * （实测 1×1…12×12、含边角与贴边位置，误差 ≤ 7.1e-15）。
 */
export function warpGain(lattice, u, v, allocation) {
    const L = normalizeLattice(lattice) || createLattice(1, 1);
    let J = 0;
    for (const [index, weight] of cellWeights(L, u, v)) {
        const it = allocation[index];
        if (!it || !it.alpha) continue;
        J += weight * it.alpha;
    }
    return J;
}

/**
 * 核心：在 (u,v) 处拖 `delta`（对象局部的像素位移）时，附近格点该怎么动。
 *
 * @param {object} lattice 拖动开始时的网格（基准，不含本次位移）
 * @param {number} u 拖动点参数横坐标
 * @param {number} v 拖动点参数纵坐标
 * @param {{x:number,y:number}} delta 局部像素位移
 * @param {object} [opts] `{ influenceCells, edgeFalloff }`
 * @returns {{ pts:number[][], moved:number, err:number, gain:number, maxShift:number }}
 *   `pts` 是新的绝对顶点偏移（与输入同形）；`moved` 是实际移动的顶点数；
 *   `err` 是用 `latticeOffset` 重算出来的「(u,v) 处实际位移 − delta」的模长。
 */
export function warpOffsetAt(lattice, u, v, delta, opts) {
    const L = normalizeLattice(lattice) || createLattice(1, 1);
    const dx = Number.isFinite(delta && delta.x) ? delta.x : 0;
    const dy = Number.isFinite(delta && delta.y) ? delta.y : 0;
    const allocation = warpAllocation(L, u, v, opts);
    if (!dx && !dy) {
        return { pts: L.pts.map((p) => p.slice()), moved: 0, err: 0, gain: 1, maxShift: 0 };
    }
    const J = warpGain(L, u, v, allocation);
    const gain = Math.abs(J) > GAIN_EPS ? J : 1;
    const k = 1 / gain;
    const pts = L.pts.map((p, i) => [p[0] + dx * allocation[i].alpha * k, p[1] + dy * allocation[i].alpha * k]);
    let moved = 0;
    let maxShift = 0;
    for (let i = 0; i < pts.length; i++) {
        const shift = Math.hypot(pts[i][0] - L.pts[i][0], pts[i][1] - L.pts[i][1]);
        if (shift > 1e-6) moved += 1;
        if (shift > maxShift) maxShift = shift;
    }
    // 误差用导出的 latticeOffset 重算，不信中间量：这样「归一化是否真的精确」是被测出来的
    const before = latticeOffset(L, u, v);
    const after = latticeOffset({ cols: L.cols, rows: L.rows, pts }, u, v);
    const err = Math.hypot(after.x - before.x - dx, after.y - before.y - dy);
    return { pts, moved, err, gain, maxShift };
}

/**
 * 参数坐标是否落在图像内部（`localUv` 给的是未夹取的 uv，越界会 > 1 或 < 0）。
 *
 * 判据与 canvas-input 里「内部 → 移动」那条完全一致：`x = u·w, y = v·h`，
 * 所以 `0 ≤ u ≤ 1` 等价于 `0 ≤ 局部 x ≤ w`。`opts.tolerance` 默认 0（严格）。
 */
export function hitInside(u, v, opts) {
    const tol = opts && Number.isFinite(opts.tolerance) ? opts.tolerance : 0;
    if (!Number.isFinite(u) || !Number.isFinite(v)) return false;
    return u >= -tol && u <= 1 + tol && v >= -tol && v <= 1 + tol;
}

/**
 * 把命中结果分成三档，决定按下之后拖什么：
 * - `'vertex'` 命中网格顶点 → 只拖那一个顶点（原有行为）
 * - `'soft'` 网格模式 + 落在图像内部 → 软拖附近格点（本模块）
 * - `'move'` 其余情况（含非网格模式）→ 移动整个对象
 * - `'handle'` 缩放/旋转/锚点手柄 → 交给 gizmo 原有分支
 * - `'none'` 没命中任何东西
 *
 * @param {{kind?:string, inside?:boolean}|null} hit gizmo.pickHandle 的返回值
 * @param {{mode?:string, inside?:boolean}} [opts] `mode === 'warp'` 表示当前是网格编辑；
 *        `inside` 由调用方按 localUv 判定（pickHandle 自己不带这个字段）
 */
export function zoneOf(hit, opts) {
    if (!hit || !hit.kind) return 'none';
    if (hit.kind === 'lattice') return 'vertex';
    if (hit.kind !== 'move') return 'handle';
    const o = opts && typeof opts === 'object' ? opts : {};
    const inside = typeof o.inside === 'boolean' ? o.inside : !!hit.inside;
    if (o.mode === 'warp' && inside) return 'soft';
    return 'move';
}

/** 用新顶点拼出可写进关键帧的 warp（深拷贝，改返回值不会污染输入） */
export function softPatch(lattice, pts) {
    const L = normalizeLattice(lattice) || createLattice(1, 1);
    const src = Array.isArray(pts) && pts.length === L.pts.length ? pts : L.pts;
    return { cols: L.cols, rows: L.rows, pts: src.map((p) => (Array.isArray(p) ? [p[0], p[1]] : [0, 0])) };
}
