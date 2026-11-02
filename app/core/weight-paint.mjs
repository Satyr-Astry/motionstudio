/**
 * 权重叠加态的几何与命中（P2-C 步 1）。纯函数、零 DOM。
 *
 * 为什么单独成模块而不塞进 canvas.mjs：这里的两件事（顶点到底在哪、点中了哪个顶点）
 * 都能在 node 里直接跑。顶点口径错了是「看得见却点不中」的经典事故，
 * 必须被单测钉住；而 canvas.mjs 在 import 期就摸 DOM，测不了。
 */

import { createLattice, latticeOffset } from './lattice.mjs';
import { applyMatrix, elementSize, elementWorldMatrix } from './element.mjs';
import { BONE_ANCHOR, BONE_DEFAULTS, objectById } from './doc-model.mjs';
import {
    SKIN_MAX_BONES_PER_POINT, applySkin, boneWorldMatrix, distToSegment, normalizeSkin, skinOf,
} from './skin.mjs';

/**
 * Σw 的判据。与 skin.mjs 里模块私有的 EPS_W 是同一个数 —— 那边没导出，
 * 这里复述一次并写死注释，改动时两处一起改。
 */
export const WEIGHT_EPS = 1e-12;

/**
 * 一个顶点上所有骨的权重和（Σw ≈ 0 说明它不受任何骨影响，是纯 warp 顶点）。
 * @param {Array<{boneId:string,w:number}>|undefined} slot
 */
export function weightSum(slot) {
    if (!Array.isArray(slot)) return 0;
    let sum = 0;
    for (const item of slot) {
        if (item && Number.isFinite(item.w)) sum += item.w;
    }
    return sum;
}

/**
 * 蒙皮网格顶点（文档坐标）+ 参数空间映射。
 *
 * 唯一正确口径：`applySkin(doc, el, createLattice(grid), M, size, t)`。
 * **不能用 elementLattice**：它只读 st.warp、看不见蒙皮偏移，画出来的顶点会停在
 * 绑定姿势，而用户看到的是被骨骼拉走之后的画面 —— 眼睛对着 A 点，鼠标却要点 B 点。
 *
 * 密度必须与 skin.grid 完全一致（applySkin 的 same 分支）：那样它直接取逐顶点偏移场，
 * 不做二次插值。换别的密度会得到「近似之后再插值」的位置。
 *
 * applySkin 返回的 pts 是**局部偏移量**（基座 createLattice 全零），不是绝对像素，
 * 所以 map 里要 `u * size.w + offset.x`。
 *
 * @returns {{cols:number, rows:number, size:{w:number,h:number}, matrix:object,
 *            pts:{x:number,y:number}[], uvs:{u:number,v:number}[],
 *            map:(u:number,v:number)=>{x:number,y:number}, sums:number[]}|null}
 *          没有 skin（或参数不全）时返回 null，调用方据此「什么都不画」。
 */
export function skinVertices(doc, el, t, parentM) {
    if (!doc || !el) return null;
    const skin = skinOf(el);
    if (!skin) return null;
    const size = elementSize(doc, el, t);
    const matrix = elementWorldMatrix(el, t, size, parentM || null);
    const base = createLattice(skin.grid.cols, skin.grid.rows);
    const field = applySkin(doc, el, base, matrix, size, t);
    const cols = field.cols;
    const rows = field.rows;
    const stride = cols + 1;
    const pts = [];
    const uvs = [];
    for (let i = 0; i < field.pts.length; i++) {
        const c = i % stride;
        const r = (i - c) / stride;
        const u = cols ? c / cols : 0;
        const v = rows ? r / rows : 0;
        const delta = field.pts[i] || [0, 0];
        uvs.push({ u, v });
        pts.push(applyMatrix(matrix, { x: u * size.w + delta[0], y: v * size.h + delta[1] }));
    }
    const map = (u, v) => {
        const delta = latticeOffset(field, u, v);
        return applyMatrix(matrix, { x: u * size.w + delta.x, y: v * size.h + delta.y });
    };
    const sums = skin.pts.map((slot) => weightSum(slot));
    return { cols, rows, size, matrix, pts, uvs, map, sums };
}

/**
 * 屏幕空间命中：返回顶点下标或 null。
 *
 * 与 core/gizmo 的 pickHandle（lattice 分支）同一条规则：距离 ≤ 阈值算命中，
 * 同距取后者（后画的压在上面，取它更符合视觉）。
 *
 * @param {{x:number,y:number}[]} screenPts 已换算到屏幕坐标的顶点
 * @param {{x:number,y:number}} point 鼠标位置（屏幕坐标）
 * @param {number} [threshold=9] 命中半径，默认与 gizmo 的 HIT_PX 一致
 */
export function pickSkinVertex(screenPts, point, threshold = 9) {
    if (!Array.isArray(screenPts) || !point) return null;
    const limit = Number.isFinite(threshold) ? threshold : 9;
    let best = -1;
    let bestDist = limit;
    for (let i = 0; i < screenPts.length; i++) {
        const s = screenPts[i];
        if (!s) continue;
        const dist = Math.hypot(s.x - point.x, s.y - point.y);
        if (dist <= bestDist) {
            bestDist = dist;
            best = i;
        }
    }
    return best < 0 ? null : best;
}

/* ── 权重写入（P2-C 步 2） ──────────────────────────────────────────────────
   这一节全是纯函数：给一组顶点下标与一个目标骨，返回**新的 skin**。
   涂抹手势、撤销、重绘都在 editors/canvas-input.mjs，这里只负责数学。 */

/** 判据统一用 WEIGHT_EPS —— 与 skin.mjs 的 EPS_W 同值，见文件头说明。 */
const EPS = WEIGHT_EPS;

/** 笔刷半径下限（参数空间跨度）。再小就选不中任何顶点，涂抹会像「点了没反应」。 */
export const BRUSH_MIN_RADIUS = 0.02;

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const num = (v, d) => (isNum(v) ? v : d);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * 命中项归一化：接受下标数组（`[3,4]`）或带强度的对象数组（`[{index:3,strength:0.5}]`）。
 *
 * 为什么允许两种：涂抹一次时要给每个顶点不同的衰减系数，而「整片按同一强度刷」
 * 是最常见的调用方式（面板按钮、测试）。让调用方不必为简单情形包一层对象。
 */
function normalizeHits(hits, count) {
    const out = [];
    const byIndex = new Map();
    for (const raw of Array.isArray(hits) ? hits : []) {
        const isObj = raw && typeof raw === 'object';
        const i = Math.round(num(isObj ? raw.index : raw, -1));
        if (!(i >= 0 && i < count)) continue;
        const s = isObj ? clamp01(num(raw.strength, 1)) : 1;
        const cur = byIndex.get(i);
        if (cur) {
            cur.strength = Math.max(cur.strength, s);
            continue;
        }
        const item = { index: i, strength: s };
        byIndex.set(i, item);
        out.push(item);
    }
    return out;
}

/**
 * 单顶点的补足法写入。`b` 是目标骨在 `skin.bones` 里的**下标**（落盘形状 `{b,w}` 用的就是下标）。
 *
 * 公式（与设计稿 §3 逐字对应）：
 * - 目标骨：`wNew = w + (target - w) * t`
 * - 其余骨：`w *= (1 - wNew) / max(1 - w, 1e-9)`
 *
 * 为什么不是「把这一根设成 target 再让归一化去补」：`normalizeSkin` 是按 Σ 等比缩放，
 * `{0.5,0.3,0.2}` 把 b0 设 0.8 再归一只得 0.615 —— 用户刷 0.8 却看到 0.615，
 * 而且连刷两次都到不了 0.8（每次都被别人的历史值稀释）。补足法保证「单骨权重
 * 就是用户刷的那个绝对值」，这是权重笔刷能被接受的前提。
 *
 * 还有一处与设计稿不同的细节：**先截骨数、再算缩放**。原句是「最后交给 normalizeSkin 截 4 根」，
 * 但那样会出事 —— 顶点已有 4 根骨、目标骨是第 5 根时，刚刷出来的小权重会被降序截断剔除，
 * 用户刷半天毫无反应。这里改成：其余骨先按权重降序截到 3 根、被剔除的权重按比例摊给
 * 保留项，再乘补足系数。于是「目标骨 + 最多 3 根」正好是 4 项，且 Σ 精确等于 1，
 * 截断不会反过来改变目标骨的权重。
 */
function paintSlot(slot, b, target, t) {
    const src = Array.isArray(slot) ? slot : [];
    let w = 0;
    const others = [];
    for (const e of src) {
        if (!e || !isNum(e.w)) continue;
        const bi = Math.round(num(e.b, -1));
        if (bi < 0) continue;
        if (bi === b) w += e.w;
        else others.push({ b: bi, w: e.w });
    }
    const k = clamp01(t);
    const wNew = clamp01(w + (clamp01(target) - w) * k);
    // Σ=1 时 (1 - w) 就是其余骨的总权重；这里的 max 只为挡住 w≈1 时的除零
    const oldRest = Math.max(1 - w, 1e-9);
    const scale = wNew >= 1 - EPS ? 0 : (1 - wNew) / oldRest;

    // 其余骨：先截到 3 根（把被剔除的权重按比例摊给保留项），这样补足法与 4 骨上限不冲突
    others.sort((x, y) => y.w - x.w);
    const keep = others.slice(0, Math.max(0, SKIN_MAX_BONES_PER_POINT - 1));
    let keepSum = 0;
    let otherSum = 0;
    for (const e of keep) keepSum += e.w;
    for (const e of others) otherSum += e.w;
    const spread = keepSum > EPS ? otherSum / keepSum : 0;

    const out = [];
    const wRest = 1 - wNew;
    if (wRest > EPS) {
        for (const e of keep) {
            const ww = e.w * spread * scale;
            if (ww > EPS) out.push({ b: e.b, w: ww });
        }
    }
    if (wNew > EPS) out.push({ b, w: wNew });

    let sum = 0;
    for (const e of out) sum += e.w;
    if (!(sum > EPS)) return [];
    // 归一只是抹掉浮点尾差（Σ 构造上已经是 1），所以不会把目标骨拉离 wNew
    return out.map((e) => ({ b: e.b, w: e.w / sum }));
}

/**
 * 刷权重：返回**新的 skin**，不修改入参。
 *
 * @param {object} skin 任意 skin（内部先过 normalizeSkin，未归一的输入也能算）
 * @param {Array<number|{index:number,strength:number}>} hits 受影响的顶点
 * @param {number} boneIndex 目标骨下标（`pts[].b` 同口径）
 * @param {number} [target=1] 该骨的目标权重：1 = 刷到满，0 = 刷掉
 * @param {number} [strength=1] 整体强度（0..1）；命中项自带的 strength 会与它相乘
 *
 * 每次都会先过 `normalizeSkin`，所以返回的 `grid` / `bones` / 各顶点数组都是**新对象**，
 * 不要指望拿它们和入参比引用（涂抹时也不该比：`sameObjectPixels` 比的是 `skin` 引用，
 * 换新对象正是触发重绘的信号）。未命中的顶点只保证**内容**一个数都不变。
 */
export function paintWeights(skin, hits, boneIndex, target = 1, strength = 1) {
    const S = normalizeSkin(skin);
    if (!S) return null;
    const b = Math.round(num(boneIndex, -1));
    if (!(b >= 0 && b < S.bones.length)) return S;
    const list = normalizeHits(hits, S.pts.length);
    if (list.length === 0) return S;
    const tgt = clamp01(num(target, 1));
    const g = clamp01(num(strength, 1));
    const pts = S.pts.slice();
    for (const hit of list) {
        pts[hit.index] = paintSlot(pts[hit.index], b, tgt, g * hit.strength);
    }
    return { grid: S.grid, bones: S.bones, pts };
}

/**
 * 顶点的主骨（权重最大的那根）下标；空权重 / Σw≈0 返回 -1。
 * 画布按主骨颜色着色时用，颜色本身见 `boneColorOf`。
 */
export function mainBoneIndex(slot) {
    if (!Array.isArray(slot)) return -1;
    let best = -1;
    let bestW = EPS;
    for (const e of slot) {
        if (!e || !isNum(e.w)) continue;
        const bi = Math.round(num(e.b, -1));
        if (bi < 0) continue;
        if (e.w > bestW) {
            bestW = e.w;
            best = bi;
        }
    }
    return best;
}

/** 骨骼在画布上的颜色：骨骼自己的 `bone.color`，缺省 `BONE_DEFAULTS.color`。 */
export function boneColorOf(doc, skin, index) {
    const slot = skin && Array.isArray(skin.bones) ? skin.bones[index] : null;
    const el = doc && slot && slot.id ? objectById(doc, slot.id) : null;
    const c = el && el.bone && typeof el.bone.color === 'string' ? el.bone.color : null;
    return c || BONE_DEFAULTS.color;
}

/**
 * 离某个世界坐标点最近的骨骼下标（没有可用骨骼返回 -1）。
 *
 * 与 `autoWeights` 用同一把尺子：骨骼线段 = 世界矩阵下的 (0, anchorY·width) → (len, 同上)，
 * 距离交给 `distToSegment`。两边口径一致，用户手动刷出来的结果才能和刚绑定时的自动权重接得上。
 */
export function nearestBone(doc, skin, world, t) {
    if (!doc || !skin || !world || !Array.isArray(skin.bones)) return -1;
    const time = num(t, 0);
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < skin.bones.length; i++) {
        const slot = skin.bones[i];
        const el = slot && slot.id ? objectById(doc, slot.id) : null;
        if (!el || el.kind !== 'bone') continue;
        const M = boneWorldMatrix(doc, el, time);
        const bone = el.bone && typeof el.bone === 'object' ? el.bone : {};
        const width = num(bone.width, BONE_DEFAULTS.width);
        const len = num(bone.len, BONE_DEFAULTS.len);
        const y = BONE_ANCHOR.y * width;
        const a = applyMatrix(M, { x: 0, y });
        const c = applyMatrix(M, { x: len, y });
        const d = distToSegment(world.x, world.y, a.x, a.y, c.x, c.y);
        if (d < bestD) {
            bestD = d;
            best = i;
        }
    }
    return best;
}

/**
 * 笔刷范围内的顶点 + 每点的衰减强度。
 *
 * 半径用**参数空间**跨度（`state.weight.radius` 就是这种口径，缺省 0.25 = 半个网格的跨度）。
 * 为什么不用像素：对象有自己的旋转与网格形变，参数空间里量出来的圆投到屏幕上才是
 * 用户看到的影响区（与 `previewSoftDrag` 画圈用同一套口径，圈与实效严格重合）。
 *
 * 强度 `max(0, 1 - dist)` 与 `core/warp-drag.mjs` 的软拖同形 —— 不复用 `warpAllocation`：
 * 它返回的是「位移怎么摊」的格点系数，语义不是「权重多少」。
 *
 * @param {{uvs:{u:number,v:number}[]}} verts skinVertices 的结果
 * @param {number|{u:number,v:number}} center 圆心：顶点下标（取该顶点的 uv）或直接给 uv。
 *   两种都收是因为**指针拖到两个顶点之间**时圆心必须跟着指针连续走，
 *   只认顶点下标的话圈会一格一格地跳，强度也随之跳变。
 * @param {number} [radius=0.25] 参数空间半径，夹到 [BRUSH_MIN_RADIUS, 1]
 */
export function brushVertices(verts, center, radius = 0.25) {
    if (!verts || !Array.isArray(verts.uvs)) return [];
    let cu = 0;
    let cv = 0;
    if (center && typeof center === 'object') {
        cu = num(center.u, 0);
        cv = num(center.v, 0);
    } else {
        const c = Math.round(num(center, -1));
        if (!(c >= 0 && c < verts.uvs.length)) return [];
        cu = verts.uvs[c].u;
        cv = verts.uvs[c].v;
    }
    const r = Math.min(1, Math.max(BRUSH_MIN_RADIUS, num(radius, 0.25)));
    const out = [];
    for (let i = 0; i < verts.uvs.length; i++) {
        const uv = verts.uvs[i];
        const dist = Math.hypot((uv.u - cu) / r, (uv.v - cv) / r);
        const s = 1 - dist;
        if (s > 0) out.push({ index: i, strength: s });
    }
    return out;
}

/**
 * `skinVertices` 的同帧缓存（单槽）。
 *
 * 涂抹时一帧里至少三次要这套顶点（画布绘制、指针命中、本帧的涂抹范围），
 * 而 `skinVertices` 每次都要跑一遍 `applySkin`（逐顶点做矩阵乘法）。缓存的键取
 * 「对象引用 + 它身上的 skin 引用 + 时间 + 父链矩阵的六个分量」：
 * - 文档结构共享，没改过时 `el` / `el.skin` 的引用一律不变，引用比较就够；
 * - 父链矩阵是每次现算的新对象，不能比引用，只能比数值（六个数拼串比一次乘法便宜得多）。
 */
let vertsCache = { el: null, skinRef: null, t: NaN, m6: '', value: null };

const matrixKey = (m) => (m ? [m.a, m.b, m.c, m.d, m.e, m.f].join(',') : '');

export function cachedSkinVertices(doc, el, t, parentM) {
    if (!el || typeof el !== 'object') return null;
    const m6 = matrixKey(parentM);
    const c = vertsCache;
    if (c.value && c.el === el && c.skinRef === el.skin && c.t === t && c.m6 === m6) return c.value;
    const value = skinVertices(doc, el, t, parentM);
    vertsCache = { el, skinRef: el.skin, t, m6, value };
    return value;
}

