// 统一求值器（v6）：某一时刻画面状态的唯一来源。
// 纯函数 + 可选 LRU 缓存，零 DOM、零 canvas；drawEvaluated 只写调用方给的 2D 上下文。
//
// 契约要点（docs/CONTRACT-v6-时间模型.md §1.1 / §3.1）：
//   1. 内容属于「某一秒」：取图一律 imageAt(obj, t)，没有帧号这个中间量。
//   2. 时间通道只在 timegraph.applyTime 里解释，本模块只负责沿 parentId 逐级套用。
//   3. 世界矩阵 = 父链矩阵逐级相乘 · 本层矩阵(本层局部时间, 本层尺寸)。
//   4. 矩阵一律 [a, b, c, d, e, f] 六元组，语义与 Canvas 2D setTransform 一致。
//
// 依赖方向：向下只依赖 core/*；对 paint/effects.mjs 的引用仅限纯函数
// （effectAt / filterString），不碰 canvas。反向不做：composite.mjs 复用这里的
// mulMatrix，所以本模块自带的网格贴图（paintWarped）不 import composite，避免
// core ↔ paint 循环依赖。代价是约 30 行三角形贴图与 composite.drawTexCell 同构。
//
// 刻意不 import element.mjs：它对外仍是「帧号 + 尺寸」的旧签名，本模块必须只靠
// doc-model 就能在纯时间文档上独立工作。锚点矩阵在这里按同一公式重算
// （见 elementMatrixOf：T(anchor) · matrixOf(状态) · T(-anchor)），数值与 element.mjs 一致。

import { applyTime, isIdentityTime, normalizeTime } from './timegraph.mjs';
import { matrixOf, stateAt } from './transform.mjs';
import {
    celAt as celAtOf,
    docDuration,
    imageAt,
    objectById,
    objectsOf,
    stateOf,
} from './doc-model.mjs';
import { createLattice, latticeOffset, normalizeLattice } from './lattice.mjs';
// 绘制顺序的唯一真源（docs/层级与叠放-2026-10.md §4）：只用在 drawEvaluated
// 的遍历上；本模块内部的 objIndex（按 id 查对象）与它无关，别混。
import { drawOrderOf } from './draw-order.mjs';
import { effectAt, filterString } from '../paint/effects.mjs';

/** 父链最大深度，与 timegraph 的 MAX_DEPTH 对齐。 */
const MAX_DEPTH = 64;
/** sample 缓存容量。 */
const CACHE_LIMIT = 64;
/** 与 composite.drawLayer 相同的透明阈值。 */
const EPS_ALPHA = 0.001;
/** 网格细分默认值/上限，与 composite.drawLatticeImage 对齐。 */
const WARP_SEG = 6;
const WARP_SEG_MAX = 12;

/** 单位矩阵（六元组）。 */
export const IDENTITY_MATRIX = Object.freeze([1, 0, 0, 1, 0, 0]);

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d) => (isNum(v) ? v : d);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 六元组 → {a..f}。对外（画布叠加层、命中测试）必须给对象形式，
 * element.mjs 的 applyMatrix / invertMatrix 直接读 .a/.b/…，给数组会算出 NaN。
 */
export function matrixObject(m) {
    const t = matrixTuple(m);
    return { a: t[0], b: t[1], c: t[2], d: t[3], e: t[4], f: t[5] };
}

/**
 * 任意矩阵（六元组数组或 {a,b,c,d,e,f} 对象）→ 六元组；非法项用单位阵的值兜底。
 * 兼容 element.mjs 的对象形式，避免每次调用都手写转换。
 */
export function matrixTuple(m) {
    if (Array.isArray(m)) {
        const out = [0, 0, 0, 0, 0, 0];
        for (let i = 0; i < 6; i++) out[i] = num(m[i], i === 0 || i === 3 ? 1 : 0);
        return out;
    }
    if (m && typeof m === 'object') {
        return [num(m.a, 1), num(m.b, 0), num(m.c, 0), num(m.d, 1), num(m.e, 0), num(m.f, 0)];
    }
    return IDENTITY_MATRIX.slice();
}

/**
 * 2x3 矩阵相乘（m1 · m2）：先应用 m2 再应用 m1。
 * 入参可为六元组或 {a..f}，返回六元组。
 */
export function mulMatrix(m1, m2) {
    const A = matrixTuple(m1);
    const B = matrixTuple(m2);
    return [
        A[0] * B[0] + A[2] * B[1],
        A[1] * B[0] + A[3] * B[1],
        A[0] * B[2] + A[2] * B[3],
        A[1] * B[2] + A[3] * B[3],
        A[0] * B[4] + A[2] * B[5] + A[4],
        A[1] * B[4] + A[3] * B[5] + A[5],
    ];
}

/** 点经矩阵映射：p → [x, y]。 */
export function transformPoint(m, x, y) {
    const M = matrixTuple(m);
    return [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
}

/** 归一化时间：任何非有限值都归 0（求值器对外只认有限秒）。 */
function timeOf(t) {
    const n = typeof t === 'number' ? t : Number(t);
    return Number.isFinite(n) ? n : 0;
}

/**
 * 创建求值器。
 * @param {object|null} doc 文档（v6：doc.objects[i].cels = [{at, image}]）
 * @param {{cache?: boolean}} [opts]
 */
export function createEvaluator(doc, opts = {}) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const useCache = o.cache !== false;

    let current = doc && typeof doc === 'object' ? doc : null;
    /** @type {Map<number, object>} Map 保序即 LRU 顺序（最旧在队首） */
    const cache = new Map();

    // ---- 时间 -------------------------------------------------------------

    /** 文档总时长（秒）。契约：没有帧数组来间接表达它，一律 docDuration。 */
    function total() {
        return current ? docDuration(current) : 0;
    }

    // doc 每次变更都是新对象引用，因此用引用比对做缓存键最省事：
    // 不需要外壳记得调 invalidate()，也不会读到过期索引。
    let indexDoc = null;
    let indexMap = null;

    /** id → object 的惰性索引；doc 引用一变就重建。 */
    function objIndex() {
        if (indexMap && indexDoc === current) return indexMap;
        const m = new Map();
        // objectsOf 兼容旧文档的 layers 字段，不能直接读 current.objects
        const list = objectsOf(current);
        for (let i = 0; i < list.length; i++) {
            const o = list[i];
            if (o && o.id != null) m.set(o.id, o);
        }
        indexDoc = current;
        indexMap = m;
        return m;
    }

    /** 对象或对象 id 都能吃：外壳多数地方手里只有 id。 */
    function layerOf(x) {
        if (x && typeof x === 'object') return x;
        if (x == null) return null;
        return objIndex().get(x) || null;
    }

    /** 父链由根到叶逐级套用时间通道；恒等通道走快路径。 */
    function localTime(layer, t) {
        const tt = timeOf(t);
        // 对外同时接受对象与 id：传入 id 时先解析，否则会静默返回全局时间，
        // 让调用方以为「时间通道没生效」。
        const el = layer && typeof layer === 'object' ? layer : layerOf(layer);
        if (!el || typeof el !== 'object') return tt;
        const d = current;
        if (!d) return tt;
        if (el.parentId == null && isIdentityTime(normalizeTime(el.time))) return tt;

        const chain = [];
        const seen = new Set();
        let node = el;
        while (node && typeof node === 'object' && chain.length < MAX_DEPTH) {
            if (node.id != null) {
                if (seen.has(node.id)) break; // 环：就地停止，保留已收集的链
                seen.add(node.id);
            }
            chain.push(node);
            if (node.parentId == null) break;
            const parent = objIndex().get(node.parentId);
            if (!parent || typeof parent !== 'object') break;
            node = parent;
        }

        const span = total();
        let out = tt;
        for (let i = chain.length - 1; i >= 0; i--) {
            out = applyTime(chain[i].time, out, span);
            if (!isNum(out)) return tt;
        }
        return out;
    }

    // ---- 取值小工具 -------------------------------------------------------

    /** 某对象在某局部时间的变换状态；兼容旧文档的 track 字段。 */
    function trackState(el, ltime) {
        if (!el || typeof el !== 'object') return stateAt(null, ltime);
        if (!el.transform && el.track) return stateAt(el.track, ltime);
        return stateOf(el, ltime);
    }

    /**
     * 本层矩阵（doc 空间）：旋转/缩放围绕 anchor 进行。
     * M = T(anchor) · matrixOf(状态) · T(-anchor)，与 element.elementMatrix 同构。
     */
    function elementMatrixOf(el, ltime, size) {
        const base = matrixOf(trackState(el, ltime)) || { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
        const an = el && el.anchor && typeof el.anchor === 'object' ? el.anchor : { x: 0.5, y: 0.5 };
        const ax = num(an.x, 0) * num(size && size.w, 0);
        const ay = num(an.y, 0) * num(size && size.h, 0);
        if (!ax && !ay) return base;
        return mulMatrix(
            { a: 1, b: 0, c: 0, d: 1, e: ax, f: ay },
            mulMatrix(base, { a: 1, b: 0, c: 0, d: 1, e: -ax, f: -ay }),
        );
    }

    /** 该时刻生效位图的尺寸；取不到退回文档尺寸，绝不抛。 */
    function sizeOf(layer, t) {
        const d = current;
        const fallback = { w: num(d && d.width, 0), h: num(d && d.height, 0) };
        if (!layer || typeof layer !== 'object') return fallback;
        let img = null;
        try {
            img = imageAt(layer, timeOf(t));
        } catch (e) {
            img = null;
        }
        const w = num(img && img.width, 0);
        const h = num(img && img.height, 0);
        return w > 0 && h > 0 ? { w, h } : fallback;
    }

    /** 该时刻生效的纹理记录（{at, image}），没有则 null。 */
    function celOf(layer, t) {
        const el = layerOf(layer);
        if (!el || typeof el !== 'object') return null;
        try {
            return celAtOf(el, localTime(el, t)) || null;
        } catch (e) {
            return null;
        }
    }

    /** 该时刻生效的位图。layer 可以是对象也可以是 id。 */
    function imageOf(layer, t) {
        const el = layerOf(layer);
        if (!el || typeof el !== 'object') return null;
        try {
            return imageAt(el, localTime(el, t)) || null;
        } catch (e) {
            return null;
        }
    }

    // ---- 世界矩阵 ---------------------------------------------------------

    /** 自对象向根收集父链（最多 64 层，遇环即停）。chain[0] 是自身。 */
    function chainOf(layer) {
        const chain = [];
        if (!layer || typeof layer !== 'object') return chain;
        const d = current;
        const seen = new Set();
        let node = layer;
        while (node && typeof node === 'object' && chain.length < MAX_DEPTH) {
            if (node.id != null) {
                if (seen.has(node.id)) break; // 环：就地停止，保留已收集的链
                seen.add(node.id);
            }
            chain.push(node);
            if (!d || node.parentId == null) break;
            const parent = objIndex().get(node.parentId);
            if (!parent || typeof parent !== 'object') break;
            node = parent;
        }
        return chain;
    }

    /** 从链尾（根）向链首（自身）累乘，每级用该级自己的局部时间与尺寸。 */
    /** 链上任何一层隐藏 → 不画（与 doc-model.effectiveVisible 同语义，这里复用已有 chain）。 */
    function inheritedVisible(chain) {
        for (const el of chain) if (el && el.visible === false) return false;
        return true;
    }

    /** 链上不透明度连乘（含自身）。 */
    function inheritedOpacity(chain) {
        let a = 1;
        for (const el of chain) {
            const v = Number(el && el.opacity);
            a *= Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
        }
        return Math.max(0, Math.min(1, a));
    }

    function matrixOfChain(chain, t) {
        let m = IDENTITY_MATRIX.slice();
        for (let i = chain.length - 1; i >= 0; i--) {
            const el = chain[i];
            m = mulMatrix(m, elementMatrixOf(el, localTime(el, t), sizeOf(el, t)));
        }
        return m;
    }

    /**
     * 世界矩阵：父链（最多 64 层，遇环即停）自根向叶逐级相乘。
     * 每一级都用该级自己的局部时间与尺寸，因此父级时间通道会自然缩放子级。
     * 对外是 [a,b,c,d,e,f] 六元组（见 tests/evaluator.test.mjs）；
     * 需要 {a..f} 对象的地方用 matrixObject() 转一次。
     */
    function worldMatrix(layer, t) {
        return matrixOfChain(chainOf(layer), t);
    }

    /** 祖先链矩阵（不含自身，六元组）：叠加层用它换算世界↔局部，保持与渲染一致。 */
    function parentMatrix(layer, t) {
        if (!layer || typeof layer !== 'object') return IDENTITY_MATRIX.slice();
        const chain = chainOf(layer);
        if (chain.length <= 1) return IDENTITY_MATRIX.slice();
        return matrixOfChain(chain.slice(1), t);
    }

    // ---- 效果器 -----------------------------------------------------------

    function effectsAt(layer, ltime) {
        const list = layer && Array.isArray(layer.effects) ? layer.effects : null;
        if (!list || list.length === 0) return [];
        const out = new Array(list.length);
        for (let i = 0; i < list.length; i++) {
            const e = list[i];
            out[i] = e && e.tracks ? effectAt(e, ltime) : e;
        }
        return out;
    }

    // ---- 单层求值 ---------------------------------------------------------

    function evalLayer(layer, tt) {
        const ltime = localTime(layer, tt);
        const st = trackState(layer, ltime);
        const size = sizeOf(layer, tt);
        const matrix = worldMatrix(layer, tt);
        const lattice = normalizeLattice(st.warp) || createLattice(1, 1);

        // map 已含世界矩阵：局部 (u, v) → 文档坐标。
        const map = (u, v) => {
            const off = latticeOffset(lattice, u, v);
            return transformPoint(matrix, u * size.w + off.x, v * size.h + off.y);
        };

        return {
            layer,
            ltime,
            state: st,
            effects: effectsAt(layer, ltime),
            matrix,
            lattice: { lattice, size, matrix, map },
            // quad 的角是 [x, y] 数组（契约见 tests/evaluator.test.mjs）；
            // element.mjs 的 elementQuad 走另一条路，返回 {x,y} 对象。
            quad: { tl: map(0, 0), tr: map(1, 0), br: map(1, 1), bl: map(0, 1) },
            // 纹理按**对象局部时间**取：时间通道（offset / scale / loop / hold）
            // 必须能驱动内容，否则它只是一个不影响画面的装饰。
            image: imageAt(layer, ltime),
            cel: celAtOf(layer, ltime),
        };
    }

    // ---- 公开方法 ---------------------------------------------------------

    function state(layer, t) {
        const el = layerOf(layer);
        return trackState(el, localTime(el, t));
    }

    function effects(layer, t) {
        const el = layerOf(layer);
        return effectsAt(el, localTime(el, t));
    }

    function matrix(layer, t) {
        return worldMatrix(layerOf(layer), timeOf(t));
    }

    function lattice(layer, t) {
        return evalLayer(layerOf(layer), timeOf(t)).lattice;
    }

    function quad(layer, t) {
        return evalLayer(layerOf(layer), timeOf(t)).quad;
    }

    /**
     * 同一 t 的求值结果（数值全等；返回对象视为只读）。
     * 缓存键 Math.round(t*1e6)，容量 64，命中即刷新 LRU 顺序。
     * 每条层记录带自己的 celAt（该对象当前生效纹理的 at）；文档级没有
     * 「唯一的当前纹理」这回事，所以顶层不给这个字段。
     */
    function sample(t) {
        const tt = timeOf(t);
        const key = Math.round(tt * 1e6);
        if (useCache) {
            const hit = cache.get(key);
            if (hit) {
                cache.delete(key);
                cache.set(key, hit);
                return hit;
            }
        }

        const list = objectsOf(current);
        const record = { t: tt, total: total(), layers: [] };

        for (let i = 0; i < list.length; i++) {
            const layer = list[i];
            if (!layer || typeof layer !== 'object') continue;
            const e = evalLayer(layer, tt);
            const cel = e.cel;
            const baseAlpha = clamp01(num(layer.opacity, 1) * num(cel && cel.opacity, 1));
            record.layers.push({
                layer,
                ltime: e.ltime,
                state: e.state,
                effects: e.effects,
                matrix: e.matrix,
                lattice: e.lattice,
                quad: e.quad,
                image: e.image,
                celAt: cel ? cel.at : null,
                baseAlpha,
                // 可见性沿 parentId 上溯：组隐藏 → 子树不画（与 doc-model.effectiveVisible 同语义）
                visible: inheritedVisible(chainOf(layer)),
                opacity: clamp01(baseAlpha * num(e.state && e.state.opacity, 1)),
            });
        }

        if (useCache) {
            cache.set(key, record);
            if (cache.size > CACHE_LIMIT) {
                const oldest = cache.keys().next();
                if (!oldest.done) cache.delete(oldest.value);
            }
        }
        return record;
    }

    function invalidate() {
        cache.clear();
    }

    return {
        get doc() {
            return current;
        },
        set doc(next) {
            current = next && typeof next === 'object' ? next : null;
            cache.clear();
        },
        total,
        localTime,
        state,
        effects,
        matrix,
        parentMatrix,
        lattice,
        quad,
        imageOf,
        celAt: celOf,
        sample,
        invalidate,
    };
}

// ---- 绘制 ---------------------------------------------------------------

/** 效果器颜色串：显式 filterFor 优先，其次是已按局部时间求值的层内效果。 */
function filterOf(opts, layer, rec, t) {
    if (typeof opts.filterFor === 'function') {
        const fs = opts.filterFor(layer, t);
        return fs || 'none';
    }
    const list = rec.effects;
    if (Array.isArray(list) && list.length > 0) return filterString(list);
    return null;
}

/**
 * 用求值结果画某个时刻（替代 composite 里散装的 drawLayer 逻辑）。
 * 只读 ev.sample(t) 的数据，不再自行求值。
 * @returns {boolean} 是否真的画了东西
 */
export function drawEvaluated(ctx, ev, t, opts = {}) {
    if (!ctx || typeof ctx.save !== 'function') return false;
    if (!ev || typeof ev.sample !== 'function') return false;
    const o = opts && typeof opts === 'object' ? opts : {};
    if (!ev.doc) return false;

    let record;
    try {
        record = ev.sample(t);
    } catch (e) {
        return false;
    }
    if (!record || !Array.isArray(record.layers)) return false;

    const tt = timeOf(t);
    let painted = false;
    // 叠放顺序的唯一真源：`drawOrder[0]` 最上，绘制必须倒序（从数组尾往头画）。
    // record.layers 是按 objects 顺序求值出来的，这里只借它按 id 取记录，不依赖其顺序。
    const order = drawOrderOf(ev.doc);
    const byId = new Map();
    for (let i = 0; i < record.layers.length; i++) {
        const rec = record.layers[i];
        if (rec && rec.layer && rec.layer.id != null) byId.set(String(rec.layer.id), rec);
    }
    for (let i = order.length - 1; i >= 0; i--) {
        const rec = byId.get(order[i]);
        if (!rec) continue;
        if (!o.force && !rec.visible) continue;
        if (o.onlyVisible !== false && !rec.visible) continue;
        if (o.skipLayerId != null && rec.layer.id === o.skipLayerId) continue;
        if (drawOne(ctx, rec, tt, o)) painted = true;
    }
    return painted;
}

function drawOne(g, rec, t, o) {
    const layer = rec.layer;
    const img = rec.image;
    if (!img) return false;

    // 与 composite.drawLayer 同源的 alpha：层 × cel × 状态不透明度。
    const base = rec.baseAlpha == null ? clamp01(num(layer.opacity, 1)) : rec.baseAlpha;
    const alpha = clamp01(o.ignoreTransform ? base : base * num(rec.state && rec.state.opacity, 1));
    if (!(alpha > EPS_ALPHA)) return false;

    let m = rec.matrix;
    if (o.ignoreTransform) m = IDENTITY_MATRIX;
    else if (o.baseMatrix) m = mulMatrix(o.baseMatrix, m);
    if (!Array.isArray(m)) m = matrixTuple(m);

    const warp = !o.ignoreTransform && rec.state && rec.state.warp ? rec.lattice : null;
    const fs = filterOf(o, layer, rec, t);

    g.save();
    try {
        g.globalAlpha = num(g.globalAlpha, 1) * alpha;
        if (layer.mixMode) g.globalCompositeOperation = layer.mixMode;
        if (fs != null && 'filter' in g) g.filter = fs;
        g.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
        if (warp && warp.lattice) paintWarped(g, img, warp.lattice, warp.size, o.warpSeg);
        else g.drawImage(img, 0, 0);
    } finally {
        g.restore();
    }
    return true;
}

/** 源三角 → 目标三角的仿射六元组；退化三角返回 null。 */
function triAffineTuple(s0, s1, s2, d0, d1, d2) {
    const det = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s2[0] - s0[0]) * (s1[1] - s0[1]);
    if (!isNum(det) || Math.abs(det) < 1e-12) return null;
    const a = ((d1[0] - d0[0]) * (s2[1] - s0[1]) - (d2[0] - d0[0]) * (s1[1] - s0[1])) / det;
    const c = ((d2[0] - d0[0]) * (s1[0] - s0[0]) - (d1[0] - d0[0]) * (s2[0] - s0[0])) / det;
    const b = ((d1[1] - d0[1]) * (s2[1] - s0[1]) - (d2[1] - d0[1]) * (s1[1] - s0[1])) / det;
    const dd = ((d2[1] - d0[1]) * (s1[0] - s0[0]) - (d1[1] - d0[1]) * (s2[0] - s0[0])) / det;
    const e = d0[0] - a * s0[0] - c * s0[1];
    const f = d0[1] - b * s0[0] - dd * s0[1];
    return [a, b, c, dd, e, f];
}

/** 六元组版三角形贴图（等价于 composite.drawTexCell，直接合成到当前 CTM）。 */
function paintQuadCell(g, img, src, dst) {
    // 与 composite.drawTexCell 相同的对角线切分（[0,1,3] + [1,2,3]），
    // 否则非平面四边形的填充会与旧路径差一条像素。
    const tris = [[0, 1, 3], [1, 2, 3]];
    for (let k = 0; k < tris.length; k++) {
        const i0 = tris[k][0];
        const i1 = tris[k][1];
        const i2 = tris[k][2];
        const m = triAffineTuple(src[i0], src[i1], src[i2], dst[i0], dst[i1], dst[i2]);
        if (!m) continue;
        g.save();
        try {
            g.beginPath();
            g.moveTo(dst[i0][0], dst[i0][1]);
            g.lineTo(dst[i1][0], dst[i1][1]);
            g.lineTo(dst[i2][0], dst[i2][1]);
            g.closePath();
            g.clip();
            g.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
            g.drawImage(img, 0, 0);
        } finally {
            g.restore();
        }
    }
}

/**
 * 在**局部矩形空间**里画（世界矩阵由调用方通过 CTM 叠加），细分方式与
 * composite.drawLatticeImage 一致：每个格 cell 再切 seg×seg 小片、两三角形。
 */
export function paintWarped(g, img, lat, size, seg) {
    if (!g || !img) return;
    const L = normalizeLattice(lat) || createLattice(1, 1);
    const iw = num(img.width, 0);
    const ih = num(img.height, 0);
    if (!(iw > 0) || !(ih > 0)) return;
    const w = num(size && size.w, iw);
    const h = num(size && size.h, ih);
    if (!(w > 0) || !(h > 0)) return;

    const n = Math.max(1, Math.min(WARP_SEG_MAX, Math.trunc(num(seg, WARP_SEG)) || 1));
    const point = (u, v) => {
        const off = latticeOffset(L, u, v);
        return [u * w + off.x, v * h + off.y];
    };
    for (let r = 0; r < L.rows; r++) {
        for (let c = 0; c < L.cols; c++) {
            for (let j = 0; j < n; j++) {
                for (let i = 0; i < n; i++) {
                    const u0 = (c + i / n) / L.cols;
                    const u1 = (c + (i + 1) / n) / L.cols;
                    const v0 = (r + j / n) / L.rows;
                    const v1 = (r + (j + 1) / n) / L.rows;
                    const src = [
                        [u0 * iw, v0 * ih],
                        [u1 * iw, v0 * ih],
                        [u1 * iw, v1 * ih],
                        [u0 * iw, v1 * ih],
                    ];
                    const dst = [point(u0, v0), point(u1, v0), point(u1, v1), point(u0, v1)];
                    paintQuadCell(g, img, src, dst);
                }
            }
        }
    }
}
