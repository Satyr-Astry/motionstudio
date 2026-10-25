/**
 * Kleks Motion —— 图层合成
 *
 * 把某个时间点 t 的所有可见纹理按「图层变换 + 不透明度 + 混合模式」画到目标画布上。
 * 只做像素合成，不碰 DOM 布局；显示画布、导出的 PNG 序列、洋葱皮都用它。
 *
 * v6：时间只有秒。取图走 imageAt(obj, t)（纹理开启后一直生效到下一个纹理），
 * 已经没有「第几帧」这个维度，所以 drawLayer / layerStateAt / compositeFrame
 * 的签名里不再有 frameIndex。
 */

import { celAt, imageAt, objectsOf } from '../core/cel.mjs';
import { effectiveVisible, effectiveOpacity } from '../core/doc-model.mjs';
import { isIdentity } from '../core/transform.mjs';
import { localTimeOf } from '../core/timegraph.mjs';
import { elementState, elementMatrix } from '../core/element.mjs';
import { normalizeLattice, latticeOffset } from '../core/lattice.mjs';
// v5：世界矩阵与整帧绘制来自统一求值器（paint → core 单向依赖）
import { drawEvaluated, mulMatrix, matrixTuple } from '../core/evaluator.mjs';
// 叠放顺序的唯一真源（docs/层级与叠放-2026-10.md §1/§4）：`drawOrder[0]` 最上，
// 渲染从数组尾往头画。缺字段时 drawOrderOf 会按 objects 顺序现算，等价于旧行为。
import { drawOrderOf } from '../core/draw-order.mjs';

/** 由两组三角形的对应关系解出仿射矩阵（四角变形用两片三角近似）。 */
export function triAffine(s0, s1, s2, d0, d1, d2) {
    const det = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s2[0] - s0[0]) * (s1[1] - s0[1]);
    if (Math.abs(det) < 1e-9) return null;
    const a = ((d1[0] - d0[0]) * (s2[1] - s0[1]) - (d2[0] - d0[0]) * (s1[1] - s0[1])) / det;
    const c = ((d2[0] - d0[0]) * (s1[0] - s0[0]) - (d1[0] - d0[0]) * (s2[0] - s0[0])) / det;
    const b = ((d1[1] - d0[1]) * (s2[1] - s0[1]) - (d2[1] - d0[1]) * (s1[1] - s0[1])) / det;
    const d = ((d2[1] - d0[1]) * (s1[0] - s0[0]) - (d1[1] - d0[1]) * (s2[0] - s0[0])) / det;
    return { a, b, c, d, e: d0[0] - a * s0[0] - c * s0[1], f: d0[1] - b * s0[0] - d * s0[1] };
}

/** 四边形上的双线性插值点。 */
export function quadBilinear(quad, u, v) {
    const tx = quad.tl[0] + (quad.tr[0] - quad.tl[0]) * u;
    const ty = quad.tl[1] + (quad.tr[1] - quad.tl[1]) * u;
    const bx = quad.bl[0] + (quad.br[0] - quad.bl[0]) * u;
    const by = quad.bl[1] + (quad.br[1] - quad.bl[1]) * u;
    return [tx + (bx - tx) * v, ty + (by - ty) * v];
}

// 合成层不依赖 core 的数值小工具，这里自带一个兜底
function numOf(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

// 有向面积两倍（>0 即逆时针）；只用来决定外法线朝哪侧，与 canvas 的 y 向下无关
function cross3(ax, ay, bx, by, cx, cy) {
    return (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
}

// 两条直线 (x,y)+t·(dx,dy) 的交点；近乎平行返回 null
function lineCross(l1, l2) {
    const det = l1.dx * -l2.dy - l1.dy * -l2.dx;
    if (!(Math.abs(det) > 1e-12)) return null;
    const rx = l2.x - l1.x;
    const ry = l2.y - l1.y;
    const t = (rx * -l2.dy - ry * -l2.dx) / det;
    return [l1.x + l1.dx * t, l1.y + l1.dy * t];
}

/** 斜接长度上限：45° 尖角本身就要 1/sin(22.5°) ≈ 2.6 倍 pad，超过 6 倍宁可退回中轴位移 */
const MITER_LIMIT = 6;

/**
 * 把三角形的三条边各自向外平移 pad（斜接），返回三个新顶点；不修改入参。
 *
 * 为什么要外扩：drawTexCell 用 clip() 贴两片三角形，共享边两侧都被抗锯齿削掉约半个
 * 像素的覆盖率，两片叠起来 alpha 只剩 ~75%，放大看就是一条 1px 的透明缝。让相邻的
 * 三角形各自多铺 pad（≈ 半个设备像素）即可把缝盖住 —— 多出来的部分仍是同一张图的
 * 仿射延伸，与邻片的填充在共享边上取值一致，肉眼不可辨。
 *
 * 几何性质（tests/warp-ease.test.mjs 直接断言）：每条新边与原边平行、间距恰为 pad，
 * 且原三角形整体含于新三角形内。退化情形（零长边、三点共线、尖角过长）沿角平分线
 * 推 pad，绝不产生 NaN。
 */
export function inflateTriangle(pts, pad) {
    const P = [0, 1, 2].map((i) => {
        const p = Array.isArray(pts) ? pts[i] : null;
        return [numOf(p && p[0], 0), numOf(p && p[1], 0)];
    });
    const d = numOf(pad, 0);
    if (!(Math.abs(d) > 1e-9)) return P;
    // 逆时针时外法线取 (dy, -dx)，顺时针取反
    const sign = cross3(P[0][0], P[0][1], P[1][0], P[1][1], P[2][0], P[2][1]) >= 0 ? 1 : -1;
    const edges = [];
    for (let i = 0; i < 3; i += 1) {
        const a = P[i];
        const b = P[(i + 1) % 3];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const len = Math.hypot(dx, dy);
        if (!(len > 1e-12)) {
            edges.push(null);
            continue;
        }
        const ux = dx / len;
        const uy = dy / len;
        const nx = sign * uy;
        const ny = -sign * ux;
        edges.push({ x: a[0] + nx * d, y: a[1] + ny * d, dx: ux, dy: uy, nx, ny });
    }
    const out = [];
    for (let i = 0; i < 3; i += 1) {
        const prev = edges[(i + 2) % 3];
        const next = edges[i];
        let v = prev && next ? lineCross(prev, next) : null;
        if (!v || Math.hypot(v[0] - P[i][0], v[1] - P[i][1]) > Math.abs(d) * MITER_LIMIT) {
            let bx = 0;
            let by = 0;
            if (prev) { bx += prev.nx; by += prev.ny; }
            if (next) { bx += next.nx; by += next.ny; }
            let bl = Math.hypot(bx, by);
            if (!(bl > 1e-12)) {
                // 两条外法线正好相反（三点共线）：朝重心外侧推
                bx = P[i][0] - (P[0][0] + P[1][0] + P[2][0]) / 3;
                by = P[i][1] - (P[0][1] + P[1][1] + P[2][1]) / 3;
                bl = Math.hypot(bx, by);
            }
            v = bl > 1e-12
                ? [P[i][0] + (bx / bl) * d, P[i][1] + (by / bl) * d]
                : [P[i][0], P[i][1]];
        }
        out.push(v);
    }
    return out;
}

/**
 * pad（设备像素）换算到当前用户空间的长度。
 * clip 的抗锯齿按设备像素算，所以必须除以当前变换的缩放；取两轴较小者，
 * 保证两个方向上都至少铺到 pad 个设备像素。
 */
export function devicePad(g, px) {
    const base = numOf(px, 0.5) > 0 ? numOf(px, 0.5) : 0.5;
    const m = g && typeof g.getTransform === 'function' ? g.getTransform() : null;
    if (!m) return base;
    const sx = Math.hypot(numOf(m.a, 0), numOf(m.b, 0));
    const sy = Math.hypot(numOf(m.c, 0), numOf(m.d, 0));
    const s = Math.min(sx, sy);
    if (!(s > 1e-6)) return base;
    return Math.min(base / s, 1024);
}

/**
 * 按四角目标形状贴图。
 * 用 `seg × seg` 网格细分（默认 8），每格两片三角形做仿射贴图 —— 四角任意拉伸时
 * 画面不会像两片大三角那样出现明显的对角线撕裂。
 */
export function drawQuadImage(g, img, quad, seg) {
    const w = img.width;
    const h = img.height;
    if (!w || !h) return;
    const n = Math.max(1, Math.min(24, seg == null ? 8 : seg | 0));
    for (let iy = 0; iy < n; iy += 1) {
        for (let ix = 0; ix < n; ix += 1) {
            const u0 = ix / n;
            const u1 = (ix + 1) / n;
            const v0 = iy / n;
            const v1 = (iy + 1) / n;
            drawTexCell(g, img, w, h, u0, v0, u1, v1, [
                quadBilinear(quad, u0, v0),
                quadBilinear(quad, u1, v0),
                quadBilinear(quad, u1, v1),
                quadBilinear(quad, u0, v1),
            ]);
        }
    }
}

/** 一个纹理子格（源 UV 矩形 → 目标四角），内部拆两片三角形贴图 */
/**
 * 这一片格子是不是「平行四边形」（即纯仿射）？
 * 是的话不需要切成两片三角形，一次 setTransform + drawImage 就能精确铺满，
 * 既没有共享边的抗锯齿缝，又省掉一次 clip（clip 是这条管线里最贵的调用）。
 */
function isAffineQuad(D, eps) {
    const e = Number.isFinite(eps) ? eps : 0.01;
    if (!D || D.length < 4) return false;
    const [p0, p1, p2, p3] = D;
    const dx1 = p2[0] - p1[0] - (p3[0] - p0[0]);
    const dy1 = p2[1] - p1[1] - (p3[1] - p0[1]);
    const dx2 = p3[0] - p0[0] - (p2[0] - p1[0]);
    const dy2 = p3[1] - p0[1] - (p2[1] - p1[1]);
    return Math.abs(dx1) <= e && Math.abs(dy1) <= e && Math.abs(dx2) <= e && Math.abs(dy2) <= e;
}

function drawTexCell(g, img, w, h, u0, v0, u1, v1, D, padIn) {
    const S = [
        [u0 * w, v0 * h],
        [u1 * w, v0 * h],
        [u1 * w, v1 * h],
        [u0 * w, v1 * h],
    ];
    // 半个设备像素：正好补回 clip 抗锯齿在边界上吃掉的覆盖率
    const pad = Number.isFinite(padIn) ? padIn : devicePad(g, 0.5);

    if (isAffineQuad(D)) {
        // 仿射快路径：0-1-3 三点即可定矩阵，第 4 点由仿射关系推出，画出来正好是整片平行四边形
        const m = triAffine(S[0], S[1], S[3], D[0], D[1], D[3]);
        if (m) {
            g.save();
            g.transform(m.a, m.b, m.c, m.d, m.e, m.f);
            g.drawImage(img, 0, 0);
            g.restore();
            return;
        }
    }
    for (const [i0, i1, i2] of [
        [0, 1, 3],
        [1, 2, 3],
    ]) {
        const m = triAffine(S[i0], S[i1], S[i2], D[i0], D[i1], D[i2]);
        if (!m) continue;
        // 仿射仍按原始三角形解（贴图映射不能变），只把裁剪三角形沿各边外扩半个设备像素：
        // 相邻两片在共享边两侧各多铺一点，抗锯齿削掉的覆盖率就被补回来，缝消失。
        const tri = inflateTriangle([D[i0], D[i1], D[i2]], pad);
        g.save();
        g.beginPath();
        g.moveTo(tri[0][0], tri[0][1]);
        g.lineTo(tri[1][0], tri[1][1]);
        g.lineTo(tri[2][0], tri[2][1]);
        g.closePath();
        g.clip();
        g.transform(m.a, m.b, m.c, m.d, m.e, m.f);
        g.drawImage(img, 0, 0);
        g.restore();
    }
}

/**
 * 网格 warp 贴图：把图层按 cols×rows 的网格（每个顶点独立偏移）绘制。
 * 每个 cell 再细分 seg×seg 个子格，逐格两片三角形 —— 与 lattice.latticeOffset 的双线性完全一致。
 * lattice 的顶点是「相对基准矩形的像素偏移」，基准矩形就是 w×h。
 */
export function drawLatticeImage(g, img, lat, w, h, seg) {
    if (!img || !img.width || !img.height) return;
    const L = normalizeLattice(lat);
    if (!L) {
        drawQuadImage(g, img, { tl: [0, 0], tr: [w, 0], br: [w, h], bl: [0, h] }, seg);
        return;
    }
    const maxN = Math.max(1, Math.min(12, seg == null ? 6 : seg | 0));
    // pad 只算一次（每片都 look getTransform 会是几十次矩阵读）
    const pad = devicePad(g, 0.5);
    for (let r = 0; r < L.rows; r += 1) {
        for (let c = 0; c < L.cols; c += 1) {
            // 细分数跟着格子实际大小走：400px 的格子切 6×6 只是在给 GPU 添堵，
            // 40px 的格子切 1×1 又会把变形画成折线。经验分档 + 上限由调用方给的 seg 决定。
            // 双线性变形在格子内部本来就是平滑的，2 段已经足够把折线感消掉；
            // 只有超大的格子才值得再细分（每多一段，三角形数量翻倍）。
            const cellPx = Math.max(w / L.cols, h / L.rows);
            const n = Math.max(1, Math.min(maxN, cellPx <= 64 ? 1 : cellPx <= 200 ? 2 : 3));
            for (let j = 0; j < n; j += 1) {
                for (let i = 0; i < n; i += 1) {
                    const u0 = (c + i / n) / L.cols;
                    const u1 = (c + (i + 1) / n) / L.cols;
                    const v0 = (r + j / n) / L.rows;
                    const v1 = (r + (j + 1) / n) / L.rows;
                    const p = (u, v) => {
                        const o = latticeOffset(L, u, v);
                        return [u * w + o.x, v * h + o.y];
                    };
                    drawTexCell(g, img, img.width, img.height, u0, v0, u1, v1, [
                        p(u0, v0),
                        p(u1, v0),
                        p(u1, v1),
                        p(u0, v1),
                    ]);
                }
            }
        }
    }
}

/**
 * 对象在给定时间的有效变换（按连续时间求值）。
 * 返回 null 表示「没有轨道或恰好恒等」，调用方可以省掉矩阵运算。
 */
export function layerStateAt(doc, layer, t) {
    if (!layer || !layer.transform) return null;
    const st = elementState(layer, t == null ? 0 : t);
    return st && !isIdentity(st) ? st : null;
}

/** 纹理位图在 doc 空间的基准矩形：位图尺寸优先，回退文档尺寸。 */
function contentSize(doc, img) {
    const w = img && img.width ? img.width : Math.max(1, (doc && doc.width) | 0);
    const h = img && img.height ? img.height : Math.max(1, (doc && doc.height) | 0);
    return { w, h };
}

/**
 * 画一个对象在时间 t 的 cel 到目标上下文。
 * @param t 时间（秒）
 * @param opts.ignoreTransform 强制恒等（洋葱皮不叠变换）
 * @param opts.time 兼容兜底：t 未给出时用它，再缺省为 0
 * @returns 是否真的画了内容
 */
export function drawLayer(g, doc, layer, t, opts) {
    if (!g || !doc || !layer) return false;
    const o = opts || {};
    // 可见性沿 parentId 上溯：组隐藏时整棵子树都不画（求值器只判本层）
    const shown = effectiveVisible(doc, layer);
    if (!o.force && !shown) return false;
    if (o.onlyVisible !== false && !shown) return false;
    const time = t == null ? (o.time == null ? 0 : o.time) : t;
    // 时间通道（offset / scale / loop / hold）必须先算出**对象局部时间**，
    // 否则缩略图、洋葱皮、导出会与画布显示不一致。
    const lt = localTimeOf(doc, layer, time);
    const cel = celAt(layer, lt);
    const img = imageAt(layer, lt);
    if (!cel || !img) return false;

    // v5：外壳传了求值器（opts.ev）就用它的属性状态与世界矩阵；没有就保持原逻辑。
    const ev = o.ev && typeof o.ev.state === 'function' && typeof o.ev.matrix === 'function' ? o.ev : null;
    const st = o.ignoreTransform ? null : ev ? ev.state(layer, time) : elementState(layer, lt);
    // 不透明度同样连乘祖先：组 50% 时子层一起变淡
    const layerAlpha = effectiveOpacity(doc, layer);
    const cellAlpha = cel.opacity == null ? 1 : cel.opacity;
    const alpha = Math.max(0, Math.min(1, layerAlpha * cellAlpha * (st ? st.opacity : 1)));
    if (alpha <= 0.001) return false;

    g.save();
    g.globalAlpha = g.globalAlpha * alpha;
    if (layer.mixMode) g.globalCompositeOperation = layer.mixMode;
    // 效果器：由外壳注入 filterFor(layer, time)，返回 canvas filter 字符串
    if (typeof o.filterFor === 'function') {
        const fs = o.filterFor(layer, time);
        g.filter = fs || 'none';
    }
    if (st && st.warp) {
        // 网格 warp：每个顶点偏移叠加锚点矩阵后，按 cell 细分贴图
        if (ev) {
            // 求值路径：世界矩阵（含父链）必须先叠上去，网格才有正确的落点
            const info = ev.lattice(layer, time);
            const m = transformOf(layer, time, ev, o);
            g.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
            drawLatticeImage(g, img, info.lattice, info.size.w || img.width, info.size.h || img.height, o.warpSeg);
        } else {
            // 旧路径原样：不叠矩阵（既有行为，保持逐字不变）
            const size = contentSize(doc, img);
            drawLatticeImage(g, img, st.warp, size.w, size.h, o.warpSeg);
        }
    } else if (st) {
        const m = transformOf(layer, time, ev, o);
        g.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
        g.drawImage(img, 0, 0);
    } else {
        g.drawImage(img, 0, 0);
    }
    g.restore();
    return true;
}

/**
 * 本层的绘制矩阵（六元组）。
 * 有 ev 时直接用它的世界矩阵（父链已乘好），否则 elementMatrix；
 * `opts.baseMatrix`（可选）左乘，用于把整帧画进缩放/平移过的视图。
 * 内容矩形 = 当前时间生效的位图尺寸（v6 不再有「某帧的 cel」这层间接）。
 */
function transformOf(layer, t, ev, o) {
    if (ev) {
        const world = ev.matrix(layer, t);
        return o.baseMatrix ? mulMatrix(o.baseMatrix, world) : matrixTuple(world);
    }
    const img = imageAt(layer, t);
    const size = { w: img && img.width ? img.width : 0, h: img && img.height ? img.height : 0 };
    const local = elementMatrix(layer, t, size);
    if (o.baseMatrix) return mulMatrix(o.baseMatrix, local);
    return [local.a, local.b, local.c, local.d, local.e, local.f];
}

/**
 * 合成整帧。`doc.objects[0]` 是最上层，所以倒序遍历。
 * @param t 时间（秒）
 * @param target 目标 canvas 对象或它的 2D 上下文（两种都接受）
 */
export function compositeFrame(target, doc, t, opts) {
    if (!target || !doc) return false;
    const isCanvas = typeof target.getContext === 'function';
    const g = isCanvas ? target.getContext('2d') : target;
    if (!g) return false;
    const o = opts || {};
    const time = t == null ? (o.time == null ? 0 : o.time) : t;
    const W = Math.max(1, doc.width | 0);
    const H = Math.max(1, doc.height | 0);
    if (isCanvas && (target.width !== W || target.height !== H)) {
        target.width = W;
        target.height = H;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    if (o.clear !== false) g.clearRect(0, 0, W, H);
    const list = objectsOf(doc);
    // 按 id 取对象：叠放顺序与存储顺序从此解耦（drawOrder 只决定谁盖谁）
    const byId = new Map();
    for (let i = 0; i < list.length; i++) {
        const it = list[i];
        if (it && it.id != null) byId.set(String(it.id), it);
    }
    // drawOrder[0] 是最上层，所以从数组尾往头画（与旧的逆序循环等价）
    const order = drawOrderOf(doc);
    let painted = false;
    for (let i = order.length - 1; i >= 0; i--) {
        const layer = byId.get(order[i]);
        if (!layer) continue;
        if (o.skipHidden !== false && !effectiveVisible(doc, layer)) continue;
        if (layer.id === o.skipLayerId) continue;
        if (drawLayer(g, doc, layer, time, o)) painted = true;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    return painted;
}

/**
 * v5：用统一求值器画整帧 —— 只读 `ev.sample(t)` 的结果，不再自行求值。
 * 与 compositeFrame 的区别：逐层状态来自求值器（含父链世界矩阵），时间同样只由 t 决定。
 * @param target 目标 canvas 对象或它的 2D 上下文（两种都接受）
 * @param opts 与 compositeFrame 相同（clear / skipHidden / skipLayerId），
 *             另有 ignoreTransform / filterFor / warpSeg / baseMatrix / force
 * @returns 是否真的画了内容
 */
export function compositeEvaluated(target, ev, t, opts) {
    if (!target || !ev || typeof ev.sample !== 'function') return false;
    const isCanvas = typeof target.getContext === 'function';
    const g = isCanvas ? target.getContext('2d') : target;
    if (!g) return false;
    const o = opts || {};
    const doc = ev.doc;
    const W = Math.max(1, (doc && doc.width) | 0);
    const H = Math.max(1, (doc && doc.height) | 0);
    if (isCanvas && (target.width !== W || target.height !== H)) {
        target.width = W;
        target.height = H;
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    if (o.clear !== false) g.clearRect(0, 0, W, H);
    const painted = drawEvaluated(g, ev, t, o);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    return painted;
}
