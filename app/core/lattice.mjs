// 网格 warp（lattice deform）：把对象切成 cols × rows 的方格，
// (cols+1)×(rows+1) 个顶点各自带一个像素偏移，整块网格一起变形。
//
// 顶点索引行优先：index = r * (cols + 1) + c（r 自上而下，c 自左向右）。
// 1×1 网格等价于过去的「四角变形」：pts = [tl, tr, bl, br]。
//
// 本模块只做几何，不碰 DOM / canvas，可单独测试。

const EPS = 1e-9;
export const MAX_DIV = 12;

const isNum = (v) => Number.isFinite(v);
const num = (v, d) => (isNum(v) ? v : d);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clampInt = (v, lo, hi) => clamp(Math.round(num(v, lo)), lo, hi);

function normPt(p) {
    if (Array.isArray(p)) return [num(p[0], 0), num(p[1], 0)];
    if (p && typeof p === 'object') return [num(p.x, 0), num(p.y, 0)];
    return [0, 0];
}

/** 顶点总数 */
export function vertexCount(cols, rows) {
    return (clampInt(cols, 1, MAX_DIV) + 1) * (clampInt(rows, 1, MAX_DIV) + 1);
}

/** 造一块零偏移网格 */
export function createLattice(cols = 1, rows = 1) {
    const c = clampInt(cols, 1, MAX_DIV);
    const r = clampInt(rows, 1, MAX_DIV);
    const pts = [];
    for (let i = 0; i < (c + 1) * (r + 1); i++) pts.push([0, 0]);
    return { cols: c, rows: r, pts };
}

/**
 * 规范化任意传入的 warp：
 * - 旧格式 `{tl,tr,br,bl}` → 1×1 网格
 * - 新格式 `{cols,rows,pts}` → 深拷贝，缺的顶点补 0
 * 非法输入返回 null（表示「没有 warp」）。
 */
export function normalizeLattice(w) {
    if (!w || typeof w !== 'object') return null;
    let cols;
    let rows;
    let src;
    if (Array.isArray(w.pts)) {
        cols = clampInt(w.cols, 1, MAX_DIV);
        rows = clampInt(w.rows, 1, MAX_DIV);
        src = w.pts;
    } else if (w.tl || w.tr || w.br || w.bl) {
        cols = 1;
        rows = 1;
        src = [w.tl, w.tr, w.bl, w.br];
    } else {
        return null;
    }
    const n = (cols + 1) * (rows + 1);
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(normPt(src[i]));
    return { cols, rows, pts };
}

/** 1×1 网格 → 四角对象（与旧代码互通） */
export function latticeToQuad(lat) {
    const L = normalizeLattice(lat);
    if (!L) return null;
    return { tl: L.pts[0].slice(), tr: L.pts[1].slice(), bl: L.pts[2].slice(), br: L.pts[3].slice() };
}

/** 四角对象 → 1×1 网格 */
export function latticeFromQuad(q) {
    if (!q) return null;
    return normalizeLattice({ tl: q.tl, tr: q.tr, bl: q.bl, br: q.br });
}

/** 网格是否等价于「没变形」 */
export function latticeIsZero(lat) {
    const L = normalizeLattice(lat);
    if (!L) return true;
    for (const p of L.pts) {
        if (Math.abs(p[0]) > EPS || Math.abs(p[1]) > EPS) return false;
    }
    return true;
}

/** 顶点的 uv（归一化参数坐标） */
export function vertexUV(lat, index) {
    const L = normalizeLattice(lat) || createLattice(1, 1);
    const stride = L.cols + 1;
    const r = Math.floor(index / stride);
    const c = index - r * stride;
    return [c / L.cols, r / L.rows];
}

/** 改一个顶点的偏移（返回新网格） */
export function setVertex(lat, index, x, y) {
    const L = normalizeLattice(lat) || createLattice(1, 1);
    if (index < 0 || index >= L.pts.length) return L;
    const pts = L.pts.map((p) => p.slice());
    pts[index] = [num(x, 0), num(y, 0)];
    return { cols: L.cols, rows: L.rows, pts };
}

// 一个 cell 的四角：左上、右上、左下、右下（行优先存储）
function cellCorners(L, ci, cj) {
    const stride = L.cols + 1;
    const i00 = cj * stride + ci;
    return [L.pts[i00], L.pts[i00 + 1], L.pts[i00 + stride], L.pts[i00 + stride + 1]];
}

/** 网格上 (u,v) 处的偏移量（每个 cell 内部双线性 —— 与三角形的渲染细分严格一致） */
export function latticeOffset(lat, u, v) {
    const L = normalizeLattice(lat);
    if (!L) return { x: 0, y: 0 };
    const cu = clamp(u, 0, 1) * L.cols;
    const cv = clamp(v, 0, 1) * L.rows;
    const ci = Math.min(L.cols - 1, Math.floor(cu));
    const cj = Math.min(L.rows - 1, Math.floor(cv));
    const s = cu - ci;
    const t = cv - cj;
    const [p00, p10, p01, p11] = cellCorners(L, ci, cj);
    const top = [p00[0] + (p10[0] - p00[0]) * s, p00[1] + (p10[1] - p00[1]) * s];
    const bot = [p01[0] + (p11[0] - p01[0]) * s, p01[1] + (p11[1] - p01[1]) * s];
    return { x: top[0] + (bot[0] - top[0]) * t, y: top[1] + (bot[1] - top[1]) * t };
}

/** 网格上 (u,v) 处的绝对点（基准矩形 w×h + 偏移） */
export function latticePoint(lat, w, h, u, v) {
    const o = latticeOffset(lat, u, v);
    return { x: u * w + o.x, y: v * h + o.y };
}

/** 第 ci,cj 个 cell 变换后的四个角（绝对坐标，用于渲染与命中） */
export function cellQuad(lat, w, h, ci, cj) {
    const L = normalizeLattice(lat) || createLattice(1, 1);
    const stride = L.cols + 1;
    const i00 = cj * stride + ci;
    const idx = [i00, i00 + 1, i00 + stride + 1, i00 + stride];
    const cu = [ci / L.cols, (ci + 1) / L.cols];
    const cv = [cj / L.rows, (cj + 1) / L.rows];
    return {
        tl: { x: cu[0] * w + L.pts[idx[0]][0], y: cv[0] * h + L.pts[idx[0]][1] },
        tr: { x: cu[1] * w + L.pts[idx[1]][0], y: cv[0] * h + L.pts[idx[1]][1] },
        br: { x: cu[1] * w + L.pts[idx[2]][0], y: cv[1] * h + L.pts[idx[2]][1] },
        bl: { x: cu[0] * w + L.pts[idx[3]][0], y: cv[1] * h + L.pts[idx[3]][1] },
    };
}

function lerp2(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** 同尺寸的零偏移网格 */
function zeroLike(L) {
    const pts = [];
    for (let i = 0; i < L.pts.length; i++) pts.push([0, 0]);
    return { cols: L.cols, rows: L.rows, pts };
}

/**
 * 两张网格逐点插值；一侧为 null 视作零偏移；尺寸不同时把 b 重采样到 a 的顶点上。
 *
 * `t` 是**缓动后的段内进度 p**（transform.stateAt → lerpWarp），不是原始时间比例，
 * 因此这里刻意**不**把 p 夹到 [0,1]：贝塞尔手柄允许预冲（p<0）与过冲（p>1），
 * 标量走 lerp(a,b,p) 会跟着冲出区间；若网格被夹住，段首会整段冻结、过冲段被削平，
 * 视觉上就成了「网格变形只有线性、贝塞尔不生效」。非有限值仍回落 0。
 */
export function lerpLattice(a, b, t) {
    const A = normalizeLattice(a);
    const B = normalizeLattice(b);
    if (!A && !B) return null;
    if (!A) return lerpLattice(zeroLike(B), B, t);
    if (!B) return lerpLattice(A, zeroLike(A), t);
    const u = num(t, 0);
    const same = A.cols === B.cols && A.rows === B.rows;
    const pts = [];
    for (let r = 0; r <= A.rows; r++) {
        for (let c = 0; c <= A.cols; c++) {
            const i = r * (A.cols + 1) + c;
            if (same) {
                pts.push(lerp2(A.pts[i], B.pts[i], u));
            } else {
                const uv = [c / A.cols, r / A.rows];
                const ob = latticeOffset(B, uv[0], uv[1]);
                pts.push(lerp2(A.pts[i], [ob.x, ob.y], u));
            }
        }
    }
    return { cols: A.cols, rows: A.rows, pts };
}

/**
 * 改变网格密度：保留四角位置，中间顶点按原网格重采样。
 * 这样从 1×1 切到 3×3 时，已经拉过的四个角不会跳掉。
 */
export function resizeLattice(lat, cols, rows) {
    const L = normalizeLattice(lat) || createLattice(1, 1);
    const c = clampInt(cols, 1, MAX_DIV);
    const r = clampInt(rows, 1, MAX_DIV);
    const pts = [];
    for (let j = 0; j <= r; j++) {
        for (let i = 0; i <= c; i++) {
            const o = latticeOffset(L, i / c, j / r);
            pts.push([o.x, o.y]);
        }
    }
    return { cols: c, rows: r, pts };
}

/** 网格的轴对齐包围（含偏移），单位与 w/h 相同 */
export function latticeBounds(lat, w, h) {
    const L = normalizeLattice(lat) || createLattice(1, 1);
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let r = 0; r <= L.rows; r++) {
        for (let c = 0; c <= L.cols; c++) {
            const p = L.pts[r * (L.cols + 1) + c];
            const x = (c / L.cols) * w + p[0];
            const y = (r / L.rows) * h + p[1];
            if (x < x0) x0 = x;
            if (y < y0) y0 = y;
            if (x > x1) x1 = x;
            if (y > y1) y1 = y;
        }
    }
    return { x0, y0, x1, y1 };
}

/** 单 cell 双线性反解：给定点 p，在四边形 q 内求 (s,t)，越界返回 null */
function quadInverseLocal(q, p, tol = 1e-4) {
    let s = 0.5;
    let t = 0.5;
    for (let k = 0; k < 12; k++) {
        const ax = q.tl.x + (q.tr.x - q.tl.x) * s;
        const ay = q.tl.y + (q.tr.y - q.tl.y) * s;
        const bx = q.bl.x + (q.br.x - q.bl.x) * s;
        const by = q.bl.y + (q.br.y - q.bl.y) * s;
        const cx = ax + (bx - ax) * t;
        const cy = ay + (by - ay) * t;
        const ex = cx - p.x;
        const ey = cy - p.y;
        if (Math.abs(ex) < tol && Math.abs(ey) < tol) break;
        // 数值雅可比（对 s、t 求偏导）
        const dsx = (q.tr.x - q.tl.x) * (1 - t) + (q.br.x - q.bl.x) * t;
        const dsy = (q.tr.y - q.tl.y) * (1 - t) + (q.br.y - q.bl.y) * t;
        const dtx = (q.bl.x - q.tl.x) * (1 - s) + (q.br.x - q.tr.x) * s;
        const dty = (q.bl.y - q.tl.y) * (1 - s) + (q.br.y - q.tr.y) * s;
        const det = dsx * dty - dsy * dtx;
        if (Math.abs(det) < 1e-9) break;
        s -= (ex * dty - ey * dtx) / det;
        t -= (dsx * ey - dsy * ex) / det;
        s = clamp(s, -0.5, 1.5);
        t = clamp(t, -0.5, 1.5);
    }
    if (s < -0.02 || s > 1.02 || t < -0.02 || t > 1.02) return null;
    return [clamp(s, 0, 1), clamp(t, 0, 1)];
}

/**
 * 世界点 → (u,v)。遍历所有 cell 取最优解，找不到（点在网格外）返回 null。
 * 网格很稠时先按包围盒粗筛，再逐 cell 反解。
 */
export function latticeInverse(lat, w, h, p) {
    const L = normalizeLattice(lat) || createLattice(1, 1);
    const bb = latticeBounds(L, w, h);
    const pad = 2;
    if (p.x < bb.x0 - pad || p.x > bb.x1 + pad || p.y < bb.y0 - pad || p.y > bb.y1 + pad) return null;
    let best = null;
    let bestD = Infinity;
    for (let r = 0; r < L.rows; r++) {
        for (let c = 0; c < L.cols; c++) {
            const q = cellQuad(L, w, h, c, r);
            const st = quadInverseLocal(q, p);
            if (!st) continue;
            const got = latticePoint(L, w, h, (c + st[0]) / L.cols, (r + st[1]) / L.rows);
            const d = Math.hypot(got.x - p.x, got.y - p.y);
            if (d < bestD) {
                bestD = d;
                best = [(c + st[0]) / L.cols, (r + st[1]) / L.rows];
            }
        }
    }
    return bestD <= Math.max(1.5, pad) ? best : null;
}

/** 网格线：返回若干条折线（每条是 uv 采样点），供画布叠加层绘制 */
export function latticeWireframe(lat, w, h, samplesPerCell = 4) {
    const L = normalizeLattice(lat) || createLattice(1, 1);
    const lines = [];
    const n = Math.max(1, samplesPerCell | 0);
    for (let r = 0; r <= L.rows; r++) {
        const row = [];
        for (let c = 0; c < L.cols; c++) {
            for (let k = 0; k < n; k++) {
                const u = (c + k / n) / L.cols;
                row.push(latticePoint(L, w, h, u, r / L.rows));
            }
        }
        row.push(latticePoint(L, w, h, 1, r / L.rows));
        lines.push(row);
    }
    for (let c = 0; c <= L.cols; c++) {
        const col = [];
        for (let r = 0; r < L.rows; r++) {
            for (let k = 0; k < n; k++) {
                const v = (r + k / n) / L.rows;
                col.push(latticePoint(L, w, h, c / L.cols, v));
            }
        }
        col.push(latticePoint(L, w, h, c / L.cols, 1));
        lines.push(col);
    }
    return lines;
}
