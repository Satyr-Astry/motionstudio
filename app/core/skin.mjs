// 骨骼蒙皮（LBS：linear blend skinning）：把纹理对象的网格顶点按权重绑到骨骼上，
// 骨骼一动，顶点就被加权推动 —— 一张手臂纹理因此能在肘部自然弯折。
//
// 纯函数、零 DOM、零 canvas，可单独测试。依赖方向：
//   skin.mjs → lattice.mjs（网格与偏移场）、element.mjs（矩阵工具 + 对象尺寸 + 父链世界矩阵）
//              doc-model.mjs（骨骼常量、docDuration）、timegraph.mjs（时间通道）
// 刻意**不** import evaluator.mjs：evaluator 要求值蒙皮，反过来 import 它就是循环依赖。
// 所以这里的 `boneWorldMatrix` 与 evaluator 的 `worldMatrix` 是同一套公式的**第二份实现**
// （elementWorldMatrix 逐级相乘），重复它是因为 `matrixOfChain` 是 evaluator 的私有函数、
// 在那一边没法复用。两边口径由 tests/skin.test.mjs 的「map(u,v) 与手算 W_i 对拍」钉住。
//
// ---------------------------------------------------------------------------
// 三条硬约束（写死，别改）：
//
// 1. 蒙皮对象**不许**把 `parentId` 指向骨骼。
//    皮肤与骨骼通过权重关联，不走父链；否则骨骼变换会被 matrixOfChain（父链）
//    与蒙皮各乘一次 = 双重变形。P2-A 只写这条注释，拦截留给 P2-B 的 UI。
//
// 2. 偏移必须用 `worldMatrix(layer, t)⁻¹` 转回局部坐标，不能用 parentMatrix。
//    drawOne 先 `g.transform(rec.matrix)`（= 世界矩阵，含自身），再让 paintWarped
//    在局部空间画 `P + off`；用 parentMatrix 会漏掉对象自身的旋转/缩放。
//
// 3. `st.warp` 是用户数据（会存盘），蒙皮是求值产物（不存盘）：
//    两者逐顶点**相加**，且 `st.warp` 一个字节都不改。
//    skin 的网格密度与 warp 不同时，蒙皮偏移按 latticeOffset 重采样到 warp 的密度。
// ---------------------------------------------------------------------------

import { MAX_DIV, createLattice, latticeOffset, normalizeLattice } from './lattice.mjs';
import { applyMatrix, elementSize, elementWorldMatrix, invertMatrix, mulMatrix } from './element.mjs';
import { BONE_ANCHOR, BONE_DEFAULTS, docDuration } from './doc-model.mjs';
import { applyTime } from './timegraph.mjs';
// IK 覆盖表：与 evaluator 用同一个 solveIk（单槽缓存保证同帧同表）。
// 依赖方向 core/skin → core/ik → core/element，无环（ik 不 import skin/evaluator）。
import { solveIk } from './ik.mjs';

/** 每个顶点最多受几根骨骼影响（超出按权重从大到小裁剪）。 */
export const SKIN_MAX_BONES_PER_POINT = 4;

/** 蒙皮的缺省网格密度：4×4 足够弯一根手臂，又不至于让权重编辑变成表格填数。 */
export const SKIN_DEFAULTS = Object.freeze({ grid: Object.freeze({ cols: 4, rows: 4 }) });

/** 父链最大深度，与 evaluator / timegraph 的 MAX_DEPTH 对齐。 */
const MAX_DEPTH = 64;
/** 权重求和的下限：低于它视作「这个顶点不受任何骨骼影响」。 */
const EPS_W = 1e-12;
/** 距离 → 权重公式里的软化项，避免顶点正好落在骨骼线上时权重炸成 Infinity。 */
const EPS_DIST = 1e-4;

const IDENTITY = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d) => (isNum(v) ? v : d);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clampInt = (v, lo, hi) => clamp(Math.round(num(v, lo)), lo, hi);

// ---- 矩阵形状转换（落盘用六元组 [a,b,c,d,e,f]，element.mjs 用 {a..f}）------

/** 任意矩阵 → {a..f}；非法项按单位阵兜底。 */
function asMatrix(m) {
    if (Array.isArray(m) && m.length >= 6) {
        const out = { a: num(m[0], 1), b: num(m[1], 0), c: num(m[2], 0), d: num(m[3], 1), e: num(m[4], 0), f: num(m[5], 0) };
        return out;
    }
    if (m && typeof m === 'object') {
        return {
            a: num(m.a, 1),
            b: num(m.b, 0),
            c: num(m.c, 0),
            d: num(m.d, 1),
            e: num(m.e, 0),
            f: num(m.f, 0),
        };
    }
    return { ...IDENTITY };
}

/** {a..f} → 六元组（落盘形状）。 */
const tupleOf = (m) => [m.a, m.b, m.c, m.d, m.e, m.f];

/** 六元组；不可逆（退化）的矩阵返回 null，表示「这根骨这一帧没绑上」。 */
function bindTuple(v) {
    if (!Array.isArray(v) || v.length < 6) return null;
    const m = asMatrix(v);
    if (!invertMatrix(m)) return null;
    return tupleOf(m);
}

// ---- 世界矩阵（与 evaluator.worldMatrix 同口径，见文件头注释）--------------

/** 按 id 找对象：直接读 doc.objects，不 import doc-model 的 objectsOf（少一层依赖）。 */
function findById(doc, id) {
    if (!doc || id == null) return null;
    const list = Array.isArray(doc.objects) ? doc.objects : Array.isArray(doc.layers) ? doc.layers : [];
    for (const el of list) if (el && el.id === id) return el;
    return null;
}

/** 自对象向根收集父链（最多 64 层，遇环即停）。chain[0] 是自身。 */
function chainOf(doc, el) {
    const chain = [];
    const seen = new Set();
    let node = el;
    while (node && typeof node === 'object' && chain.length < MAX_DEPTH) {
        if (node.id != null) {
            if (seen.has(node.id)) break;
            seen.add(node.id);
        }
        chain.push(node);
        if (node.parentId == null) break;
        const parent = findById(doc, node.parentId);
        if (!parent || typeof parent !== 'object') break;
        node = parent;
    }
    return chain;
}

/** 父链由根到叶逐级套用时间通道 —— 与 evaluator.localTime 同一公式。 */
function localTimeOf(doc, el, t) {
    const tt = num(t, 0);
    if (!doc) return tt;
    const chain = chainOf(doc, el);
    const span = docDuration(doc);
    let out = tt;
    for (let i = chain.length - 1; i >= 0; i--) {
        out = applyTime(chain[i].time, out, span);
        if (!isNum(out)) return tt;
    }
    return out;
}

/**
 * 对象的世界矩阵（{a..f}）：自根向叶逐级 `mulMatrix(parent, own)`。
 * 与 evaluator.matrixOfChain 同构：每一级用自己的局部时间与该级尺寸。
 *
 * 导出给 core/weight-paint 算「最近骨」用：那边要在画布上量顶点到骨骼线段的距离，
 * 骨骼如果挂在别的对象/骨骼下面，缺了父链就会量错 —— 让它自己抄一遍这十几行，
 * 迟早和这里算岔，所以只留一份实现。
 */
export function boneWorldMatrix(doc, el, t, sol) {
    if (!el || typeof el !== 'object') return { ...IDENTITY };
    const chain = chainOf(doc, el);
    let M = null;
    for (let i = chain.length - 1; i >= 0; i--) {
        const p = chain[i];
        // IK 覆盖表：命中就用绝对世界矩阵（与 evaluator.matrixOfChain 同一张表、
        // 同一处判断）。少传这一叉的后果是「骨架弯了、皮肤不弯」。
        const hit = sol && p && p.id != null ? sol.get(p.id) : null;
        if (hit) { M = hit; continue; }
        const size = elementSize(doc, p, localTimeOf(doc, p, t));
        const own = elementWorldMatrix(p, localTimeOf(doc, p, t), size, null);
        M = M ? mulMatrix(M, own) : own;
    }
    return M || { ...IDENTITY };
}

// ---- 规范化 ---------------------------------------------------------------

/**
 * 网格密度：给的数字夹进 1..MAX_DIV；**没给**整份字段时用 SKIN_DEFAULTS（4×4）。
 * 两者要分开判，否则 `clampInt(undefined, 1, …)` 会悄悄变成 1×1 —— 一个「没有 grid
 * 字段的畸形 skin」看起来就和「用户特意设了最粗网格」一模一样了。
 */
function normalizeGrid(g) {
    const src = g && typeof g === 'object' && !Array.isArray(g) ? g : {};
    const pick = (v, dflt) => (isNum(v) ? clampInt(v, 1, MAX_DIV) : dflt);
    return {
        cols: pick(src.cols, SKIN_DEFAULTS.grid.cols),
        rows: pick(src.rows, SKIN_DEFAULTS.grid.rows),
    };
}

/**
 * 骨骼槽位：`{ id, bind }`。
 * `id` 无效（空/非字符串）的项剔除；`bind` 无效的项**保留槽位**、bind 置 null ——
 * 保留是因为 `pts[].b` 是这个数组的下标，删一项就会让所有后续权重指向错的骨骼。
 */
function normalizeBones(list) {
    const src = Array.isArray(list) ? list : [];
    const out = [];
    for (const b of src) {
        if (!b || typeof b !== 'object') {
            out.push({ id: '', bind: null });
            continue;
        }
        const id = typeof b.id === 'string' ? b.id : b.id != null ? String(b.id) : '';
        out.push({ id, bind: bindTuple(b.bind) });
    }
    return out;
}

/** 单个顶点的权重项：剔掉越界 / 非正权重，按权重降序截到 4 项，Σ 归一到 1。 */
function normalizePtsItem(item, boneCount) {
    const src = Array.isArray(item) ? item : [];
    const list = [];
    for (const e of src) {
        if (!e || typeof e !== 'object') continue;
        const b = Math.round(num(e.b, -1));
        const w = num(e.w, 0);
        if (b < 0 || b >= boneCount) continue; // 越界骨骼下标：坏数据
        if (!(w > 0)) continue; // 0 权重的项没有信息量
        list.push({ b, w: clamp(w, 0, 1) });
    }
    if (list.length === 0) return [];
    list.sort((x, y) => y.w - x.w);
    const top = list.slice(0, SKIN_MAX_BONES_PER_POINT);
    let sum = 0;
    for (const e of top) sum += e.w;
    if (!(sum > EPS_W)) return [];
    // 归一放在这里、不放求值时：求值路径每帧每顶点都跑，多一次除法就是白烧时间。
    return top.map((e) => ({ b: e.b, w: e.w / sum }));
}

/**
 * 权重场重采样：把 `pts` 从 `from` 网格按 (u,v) 双线性搬到 `to` 网格。
 *
 * 为什么是双线性而不是按下标硬对：改网格密度时顶点序号完全对不上（4×4 的第 5 个
 * 顶点和 8×8 的第 5 个顶点在完全不同的位置），按序号对齐就是规格里禁止的「凑合对齐」。
 * 做法与 `latticeOffset` 对偏移场做的事一模一样：四角线性混合，再取 top 4 归一。
 */
export function resampleWeights(pts, from, to) {
    const F = normalizeGrid(from);
    const T = normalizeGrid(to);
    const src = Array.isArray(pts) ? pts : [];
    const fStride = F.cols + 1;
    const fRows = F.rows + 1;

    // 源网格的顶点 → 清洗过的权重项（这里只洗形状，越界下标不判，留给下方归一）
    const field = [];
    for (let i = 0; i < fStride * fRows; i++) {
        const item = Array.isArray(src[i]) ? src[i] : [];
        const out = [];
        for (const e of item) {
            if (!e || typeof e !== 'object') continue;
            const b = Math.round(num(e.b, -1));
            const w = num(e.w, 0);
            if (b < 0 || !(w > 0)) continue;
            out.push({ b, w });
        }
        field.push(out);
    }

    const out = [];
    for (let r = 0; r <= T.rows; r++) {
        for (let c = 0; c <= T.cols; c++) {
            const u = c / T.cols;
            const v = r / T.rows;
            const cu = u * F.cols;
            const cv = v * F.rows;
            const ci = Math.min(F.cols - 1, Math.floor(cu));
            const cj = Math.min(F.rows - 1, Math.floor(cv));
            const s = cu - ci;
            const t = cv - cj;
            const i00 = cj * fStride + ci;
            const i10 = i00 + 1;
            const i01 = i00 + fStride;
            const i11 = i01 + 1;
            const acc = new Map();
            const add = (list, k) => {
                if (!(k > 0)) return;
                for (const e of list) acc.set(e.b, (acc.get(e.b) || 0) + e.w * k);
            };
            add(field[i00], (1 - s) * (1 - t));
            add(field[i10], s * (1 - t));
            add(field[i01], (1 - s) * t);
            add(field[i11], s * t);
            const merged = [];
            for (const [b, w] of acc) if (w > 0) merged.push({ b, w });
            merged.sort((x, y) => y.w - x.w);
            const top = merged.slice(0, SKIN_MAX_BONES_PER_POINT);
            let sum = 0;
            for (const e of top) sum += e.w;
            out.push(sum > EPS_W ? top.map((e) => ({ b: e.b, w: e.w / sum })) : []);
        }
    }
    return out;
}

/**
 * 规范化任意传入的 `skin`：
 * - 非对象 → null（表示「没有蒙皮」）
 * - `grid` 夹到 1..MAX_DIV（缺字段用 SKIN_DEFAULTS）；`bones` 逐项清洗（见 normalizeBones）
 * - `pts` 长度与网格不符时按序号尽量对齐、缺的补空 —— **不**在这里重采样：
 *   改网格密度是编辑器侧的动作（先 `resampleWeights(旧 pts, 旧 grid, 新 grid)`
 *   再写回），读入路径拿到的是自相矛盾的坏数据，重采样只会把矛盾藏起来。
 * - 每顶点权重截到 4 项并归一到 1；空数组 = 该顶点不受骨骼影响（当纯 warp 用）
 */
export function normalizeSkin(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const grid = normalizeGrid(v.grid);
    const bones = normalizeBones(v.bones);
    const n = (grid.cols + 1) * (grid.rows + 1);
    const srcPts = Array.isArray(v.pts) ? v.pts : [];

    const pts = [];
    for (let i = 0; i < n; i++) pts.push(normalizePtsItem(srcPts[i], bones.length));
    return { grid, bones, pts };
}

/** 取对象上的蒙皮；没有/坏数据返回 null。 */
export function skinOf(layer) {
    return normalizeSkin(layer && layer.skin);
}

// ---- 求值 -----------------------------------------------------------------

/**
 * 每根骨骼的「绑定矩阵」与「当前世界矩阵」。
 *
 * `bones[].id` 指向不存在 / 非骨骼对象时，槽位保留（pts 的下标不能漂），但 ok=false。
 * 返回的矩阵都是**六元组**（落盘形状），求值内部再转 {a..f}。
 */
export function boneMatrices(doc, skin, t, sol) {
    const S = skin && Array.isArray(skin.bones) ? skin : null;
    if (!S) return [];
    return S.bones.map((b) => {
        const el = b.id ? findById(doc, b.id) : null;
        const isBone = !!(el && el.kind === 'bone');
        const bind = bindTuple(b.bind);
        const now = isBone ? tupleOf(boneWorldMatrix(doc, el, t, sol)) : null;
        return { id: b.id, bind, now, ok: !!(bind && now) };
    });
}

/**
 * 线性混合蒙皮的核心：单顶点偏移（局部坐标）。
 *
 *   W = Σ_k  w_k · ( M_k(t) · B_k⁻¹ ) · P        // 世界坐标
 *   Q = worldMatrix(layer,t)⁻¹ · W               // 转回对象局部坐标
 *   off = Q - P
 *
 * 失效骨骼（rel 为 null）被跳过，**剩余权重重新归一到 1**：不归一会让整块皮肤按比例
 * 缩向对象原点（Σw<1 的仿射组合会把点拉向 0），看起来像「删了一根骨就整体缩小」。
 * 一个顶点没有任何有效权重时直接返回 null，调用方按「不受骨骼影响」处理 —— 绝不产出 NaN。
 */
function localOffsetOf(item, rels, invLayer, px, py) {
    let sx = 0;
    let sy = 0;
    let sum = 0;
    for (const e of item) {
        const rel = rels[e.b];
        if (!rel) continue;
        const q = applyMatrix(rel, { x: px, y: py });
        sx += e.w * q.x;
        sy += e.w * q.y;
        sum += e.w;
    }
    if (!(sum > EPS_W)) return null;
    const w = applyMatrix(invLayer, { x: sx / sum, y: sy / sum });
    return [w.x - px, w.y - py];
}

/**
 * 求值接缝：返回**新的 lattice**（`st.warp` 的偏移 + 蒙皮偏移，逐顶点相加）。
 *
 * @param {object} doc    文档（按 id 找骨骼、取尺寸与总时长）
 * @param {object} layer  被蒙皮的层
 * @param {object} lattice `st.warp` 规范化后的网格（可能是 createLattice(1,1)）
 * @param {number[]|object} matrix 该层的世界矩阵（六元组或 {a..f}）
 * @param {{w:number,h:number}} size 该层尺寸（像素）
 * @param {number} t      求值时刻（秒）
 */
export function applySkin(doc, layer, lattice, matrix, size, t) {
    const L = normalizeLattice(lattice) || createLattice(1, 1);
    const skin = skinOf(layer);
    if (!skin) return L;
    const inv = invertMatrix(asMatrix(matrix));
    if (!inv) return L;

    // 同一帧里 evaluator 已经调过 solveIk（缓存命中），这里拿到的是**同一个 Map**
    const mats = boneMatrices(doc, skin, t, solveIk(doc, t));
    // 每根骨的 (now · bind⁻¹)：一次算好，别在顶点循环里重算（10×10 网格 = 121 顶点）
    const rels = mats.map((m) => (m.ok ? mulMatrix(asMatrix(m.now), invertMatrix(asMatrix(m.bind))) : null));

    const W = num(size && size.w, 1);
    const H = num(size && size.h, 1);
    const cols = skin.grid.cols;
    const rows = skin.grid.rows;
    const stride = cols + 1;

    // 1) 在 skin 自己的网格上算出「偏移场」（一张和 skin 同密的伪网格）
    const offPts = [];
    for (let i = 0; i < skin.pts.length; i++) {
        const u = (i % stride) / cols;
        const v = Math.floor(i / stride) / rows;
        offPts.push(localOffsetOf(skin.pts[i], rels, inv, u * W, v * H) || [0, 0]);
    }

    // 2) 加到 st.warp 上；密度不同就按 latticeOffset 把偏移场重采样到 warp 的密度
    const same = L.cols === cols && L.rows === rows;
    const field = { cols, rows, pts: offPts };
    const pts = [];
    for (let i = 0; i < L.pts.length; i++) {
        const base = L.pts[i];
        let ox = 0;
        let oy = 0;
        if (same) {
            ox = offPts[i][0];
            oy = offPts[i][1];
        } else {
            const r = Math.floor(i / (L.cols + 1));
            const c = i - r * (L.cols + 1);
            const off = latticeOffset(field, c / L.cols, r / L.rows);
            ox = off.x;
            oy = off.y;
        }
        pts.push([base[0] + ox, base[1] + oy]);
    }
    return { cols: L.cols, rows: L.rows, pts };
}

/**
 * 点到线段的距离（骨骼在局部空间是一条从根部沿 +x 延伸 len 的线段）。
 *
 * 导出是为了「没有显式目标骨时取最近那根」：权重笔刷要按画布距离挑骨，
 * 用的必须是和自动权重同一把尺子，否则同一根骨在「自动」和「兜底」两条路上
 * 会各自算出一个距离，用户刷出来的结果就对不上刚绑定时看到的权重。
 */
export function distToSegment(px, py, ax, ay, bx, by) {
    const vx = bx - ax;
    const vy = by - ay;
    const len2 = vx * vx + vy * vy;
    if (!(len2 > EPS_W)) return Math.hypot(px - ax, py - ay);
    let k = ((px - ax) * vx + (py - ay) * vy) / len2;
    k = clamp(k, 0, 1);
    return Math.hypot(px - (ax + vx * k), py - (ay + vy * k));
}

/**
 * 自动权重：按「顶点到骨骼线段的世界距离」取最近的 2 根骨。
 *
 * 公式（写死，测试按它对拍）：`w_k = 1 / (d_k² + 1e-4)`，随后归一。
 * 逆平方衰减而不是线性：贴近骨骼的顶点应当迅速拿到接近 1 的权重，
 * 否则一根手臂的中间段会被两根骨各拉一半，弯起来像橡皮。
 * 距离为 0（顶点落在骨骼线上）时靠 1e-4 的软化项避免 Infinity。
 *
 * 顶点世界位置用**被蒙皮对象**的世界矩阵换算，骨骼线段用骨骼自己的世界矩阵换算，
 * 两边同一时刻同一套父链口径，所以量出来的距离就是画布上看到的距离。
 */
export function autoWeights(doc, layer, grid, boneIds, t) {
    const G = normalizeGrid(grid || SKIN_DEFAULTS.grid);
    const n = (G.cols + 1) * (G.rows + 1);
    const pts = [];
    for (let i = 0; i < n; i++) pts.push([]);
    if (!doc || !layer || !Array.isArray(boneIds) || boneIds.length === 0) return pts;

    const time = num(t, 0);
    const layerM = boneWorldMatrix(doc, layer, time);
    const size = elementSize(doc, layer, localTimeOf(doc, layer, time));
    const W = num(size && size.w, 1);
    const H = num(size && size.h, 1);

    // 每根骨的世界线段（根部 = 锚点，端点 = 沿 +x 一个 len）
    const segs = boneIds.map((id) => {
        const el = findById(doc, id);
        if (!el || el.kind !== 'bone') return null;
        const M = boneWorldMatrix(doc, el, time);
        const b = el.bone && typeof el.bone === 'object' ? el.bone : BONE_DEFAULTS;
        const y = num(b.y, BONE_ANCHOR.y) * num(b.width, BONE_DEFAULTS.width);
        const len = num(b.len, BONE_DEFAULTS.len);
        const a = applyMatrix(M, { x: 0, y });
        const c = applyMatrix(M, { x: len, y });
        return { ax: a.x, ay: a.y, bx: c.x, by: c.y };
    });

    const stride = G.cols + 1;
    for (let i = 0; i < n; i++) {
        const u = (i % stride) / G.cols;
        const v = Math.floor(i / stride) / G.rows;
        const P = applyMatrix(layerM, { x: u * W, y: v * H });
        const cand = [];
        for (let k = 0; k < segs.length; k++) {
            const s = segs[k];
            if (!s) continue;
            cand.push({ b: k, d: distToSegment(P.x, P.y, s.ax, s.ay, s.bx, s.by) });
        }
        if (cand.length === 0) continue;
        cand.sort((x, y2) => x.d - y2.d);
        const near = cand.slice(0, Math.min(2, cand.length));
        let sum = 0;
        const ws = near.map((x) => {
            const w = 1 / (x.d * x.d + EPS_DIST);
            sum += w;
            return w;
        });
        pts[i] = near.map((x, k) => ({ b: x.b, w: ws[k] / sum }));
    }
    return pts;
}

/**
 * 绑定：返回**新的 skin**（不修改 doc）。
 *
 * - `bones[].bind` 是**此刻**该骨骼世界矩阵的深拷贝快照。存快照而不是存时间戳/姿态名，
 *   是因为绑定姿态必须是数据：以后有人改了骨骼链的父级，已绑好的皮肤不该跟着漂。
 * - 权重按 `autoWeights` 初始化，之后用户可以自己刷（P2-C）。
 * - `boneIds` 里不是骨骼对象的 id 会被跳过（绑一个手绘对象没有意义）。
 *
 * opts: { grid, t }
 */
export function bindSkin(doc, layer, boneIds, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const time = num(o.t, 0);
    const grid = normalizeGrid(o.grid || SKIN_DEFAULTS.grid);
    const ids = Array.isArray(boneIds) ? boneIds : [];

    const bones = [];
    for (const raw of ids) {
        const id = raw != null ? String(raw) : '';
        if (!id) continue;
        const el = findById(doc, id);
        if (!el || el.kind !== 'bone') continue;
        const bind = bindTuple(tupleOf(boneWorldMatrix(doc, el, time)));
        if (!bind) continue;
        bones.push({ id, bind });
    }
    const pts = bones.length ? autoWeights(doc, layer, grid, bones.map((b) => b.id), time) : [];
    return normalizeSkin({ grid, bones, pts });
}

/* ───────────────────── 骨骼动画导出（P4 引擎互操作） ─────────────────────
 *
 * 目标：把「每根骨、每一帧的世界矩阵」导成一份引擎能直接吃的 JSON。
 * 这里只做**纯数据组装**（取哪些骨、按什么频率采样、矩阵怎么摊平），
 * 真正的世界矩阵由调用方注入的 `matrixOf(bone, t)` 提供 —— 外壳传 evaluator 的
 * `worldMatrix`（含父链时间通道与 IK 覆盖），所以导出与画布逐帧一致。
 *
 * 为什么导出不改 `.msp`：这是**附加交付物**，不是存档结构变化。动画仍全部存在
 * 关键帧里，导出只是把求值结果按帧采样出来；`.msp` 仍是 v4。
 */

export const BONES_FORMAT = 'motionstudio-bones';
export const BONES_VERSION = 1;

/** 六元组归一：数组或 `{a..f}` 都收，坏值返回 null（不猜）。 */
function tupleOfMatrix(m) {
    if (Array.isArray(m) && m.length >= 6) {
        const out = m.slice(0, 6).map((v) => Number(v));
        return out.every((v) => Number.isFinite(v)) ? out : null;
    }
    if (m && typeof m === 'object') {
        const out = ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => Number(m[k]));
        return out.every((v) => Number.isFinite(v)) ? out : null;
    }
    return null;
}

/**
 * 文档里的骨骼清单（按对象顺序；父级同时给出 id 与名字，引擎侧不用二次查表）。
 * @param {object|null} doc
 * @returns {{id:string,name:string,parentId:string,parentName:string,len:number,width:number}[]}
 */
export function boneObjectsOf(doc) {
    if (!doc || typeof doc !== 'object') return [];
    // 不 import doc-model 的 objectsOf：那是读取层工具，skin 只认文档的 canonical objects 数组
    const all = Array.isArray(doc.objects) ? doc.objects : [];
    const byId = new Map(all.map((o) => [o && o.id, o]));
    const out = [];
    for (const el of all) {
        if (!el || el.kind !== 'bone') continue;
        const parent = el.parentId ? byId.get(el.parentId) : null;
        const bone = el.bone || {};
        out.push({
            id: String(el.id),
            name: String(el.name == null ? '' : el.name),
            parentId: el.parentId == null ? '' : String(el.parentId),
            parentName: parent ? String(parent.name == null ? '' : parent.name) : '',
            len: Number(bone.len) || BONE_DEFAULTS.len,
            width: Number(bone.width) || BONE_DEFAULTS.width,
        });
    }
    return out;
}

/**
 * 组装骨骼动画导出包（纯函数，Node 可测）。
 *
 * 帧率默认取文档 fps，夹在 1..60；时间范围默认整段时长。每根骨每帧存一个六元组
 * `[a,b,c,d,e,f]`（同 Canvas 2D 的 `setTransform` 顺序，引擎侧直接可用）。
 * 某一帧拿不到矩阵时该帧 `m` 为 `null`（不编造单位矩阵 —— 那会让引擎静默画出错误姿态）。
 *
 * @param {object|null} doc
 * @param {{fps?:number, from?:number, to?:number}} [opts]
 * @param {(bone:object, t:number) => (number[]|object)} matrixOf 世界矩阵提供者
 * @returns {object|null} 导出包；doc 为空 / matrixOf 不是函数时 null
 */
export function buildBonesBundle(doc, opts, matrixOf) {
    if (!doc || typeof doc !== 'object' || typeof matrixOf !== 'function') return null;
    const bones = boneObjectsOf(doc);
    if (!bones.length) return null;
    const o = opts && typeof opts === 'object' ? opts : {};
    const docFps = Number(doc.fps);
    const fpsRaw = Number(o.fps);
    const fps = Math.max(1, Math.min(60, Math.round(Number.isFinite(fpsRaw) && fpsRaw > 0 ? fpsRaw : (Number.isFinite(docFps) && docFps > 0 ? docFps : 12))));
    const fromRaw = Number(o.from);
    const from = Number.isFinite(fromRaw) && fromRaw >= 0 ? fromRaw : 0;
    const total = docDuration(doc);
    const toRaw = Number(o.to);
    const to = Number.isFinite(toRaw) && toRaw > from ? toRaw : (total > from ? total : from + 1 / fps);
    const frames = Math.max(1, Math.round((to - from) * fps));
    const byId = new Map((Array.isArray(doc.objects) ? doc.objects : []).map((el) => [el && el.id, el]));
    const tracks = bones.map((info) => {
        const el = byId.get(info.id);
        const list = [];
        for (let i = 0; i < frames; i += 1) {
            const t = from + i / fps;
            const m = el ? tupleOfMatrix(matrixOf(el, t)) : null;
            list.push({ t: Math.round(t * 1e6) / 1e6, m: m });
        }
        return {
            id: info.id,
            name: info.name,
            parentId: info.parentId,
            parentName: info.parentName,
            len: info.len,
            width: info.width,
            frames: list,
        };
    });
    return {
        format: BONES_FORMAT,
        version: BONES_VERSION,
        app: 'motionstudio',
        width: Math.max(1, Math.round(Number(doc.width) || 1)),
        height: Math.max(1, Math.round(Number(doc.height) || 1)),
        fps: fps,
        from: from,
        to: to,
        frames: frames,
        bones: tracks,
    };
}
