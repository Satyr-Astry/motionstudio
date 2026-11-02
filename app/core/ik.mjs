/**
 * IK（反向动力学）—— 骨骼第三期，**纯 core、零 DOM、可单测**。
 *
 * 设计稿：`docs/IK设计-2026-11-02.md`。这里只说实现上的三条硬规矩。
 *
 * 1. **只产出「覆盖表」，不改 doc。**
 *    `solveIk(doc, t)` 返回 `Map<骨 id, 世界矩阵>`。求值器（`evaluator.mjs`）与蒙皮
 *    （`skin.mjs`）在各自的遍历里查这张表：命中就用表的绝对矩阵，没命中才累乘。
 *    这样「骨架弯了、皮肤不弯」这类分裂在结构上不可能发生 —— 两边用的是同一张表。
 *    永远不要把解算结果写回 `transform.keys`：那会污染撤销栈、落盘和 `sameObjectPixels`，
 *    用户会看到刚打的关键帧被算法悄悄改掉。
 *
 * 2. **解算用 CCD（循环坐标下降），不做矩阵分解。**
 *    FABRIK 在位置空间迭代，解完要把位置反解成旋转，而本项目的 state 允许
 *    `skewX/skewY` 与非等比缩放，反解不成立；解析法只对两骨、无 skew 成立。
 *    CCD 直接在**世界旋转**上迭代，只用 `mulMatrix`/`applyMatrix` 与 `atan2`。
 *
 * 3. **目标点是「另一个普通对象」。**
 *    于是它天然可以打关键帧、可以被父链带动、可以复制 —— 「IK 目标动画」不需要
 *    任何新通道类型。本模块只负责从目标对象读出它此刻的世界位置。
 *
 * 约束（`ik` 字段）挂在**链尾骨骼**（effector）上：
 *   `{ targetId, chain, iterations, enabled }`，见 `normalizeIk`。
 */
import {
    anchorPoint,
    applyMatrix,
    elementMatrix,
    elementSize,
    mulMatrix,
} from './element.mjs';
import { localTimeOf } from './timegraph.mjs';

/** 参与解算的骨数上限。链更长时解算质量下降而不是发散，所以是「夹取」不是「拒绝」。 */
export const IK_MAX_CHAIN = 8;
/** 迭代上限。8 轮在 4 骨以内的链上足够收敛到 1e-3。 */
export const IK_MAX_ITERATIONS = 32;
/** 末端与目标距离小于它就提前收敛（像素）。 */
export const IK_TOLERANCE = 1e-3;
/**
 * 每个关节单轮最多转多少弧度（约 20°）。
 *
 * 不夹的话 CCD 有一个经典卡死：末端关节会「一步转到位」把整条链折回到根上
 * （两骨链追一个比链长短的目标时，b 一次转 180° 让末端正好落在 a 的关节上），
 * 此后 a 的「关节→末端」向量长度变成 0，任何旋转都不改变末端位置 —— 迭代再多也出不来。
 * 夹住步长之后折叠是渐进的，中间态里各关节都还有可用的方向，于是能正常收敛。
 */
export const IK_MAX_STEP = 0.35;
/** 防环用的父链上限，与 evaluator/skin 的 64 保持一致。 */
const MAX_DEPTH = 64;

export const IK_DEFAULTS = Object.freeze({ chain: 2, iterations: 8, enabled: true });

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clampInt = (v, lo, hi, dflt) => {
    if (!isNum(v)) return dflt;
    return Math.max(lo, Math.min(hi, Math.round(v)));
};

/**
 * 归一化 IK 约束。非法/空 → `null`（表示「没有约束」，与 `normalizeBone` 同口径）。
 * `targetId` 必须是字符串，否则整条约束作废 —— 宁可不解算，也不要对着 `undefined` 追一帧。
 */
export function normalizeIk(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const targetId = typeof v.targetId === 'string' && v.targetId ? v.targetId : '';
    if (!targetId) return null;
    return {
        targetId,
        chain: clampInt(v.chain, 1, IK_MAX_CHAIN, IK_DEFAULTS.chain),
        iterations: clampInt(v.iterations, 1, IK_MAX_ITERATIONS, IK_DEFAULTS.iterations),
        enabled: v.enabled !== false,
    };
}

/** 父链（自身在最后、根在最前）。带 `seen` 防环。 */
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
        const pid = node.parentId;
        node = (doc && Array.isArray(doc.objects) ? doc.objects : []).find((o) => o && o.id === pid) || null;
    }
    return chain;
}

/** 元素的世界矩阵（未解算的运动学姿态）。每级用自己的局部时间与尺寸。 */
function worldOf(doc, el, t) {
    const chain = chainOf(doc, el);
    let m = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    for (let i = chain.length - 1; i >= 0; i--) {
        const node = chain[i];
        const lt = localTimeOf(doc, node, t);
        m = mulMatrix(m, elementMatrix(node, lt, elementSize(doc, node, lt)));
    }
    return m;
}

/** 骨骼的尺寸（`elementSize` 对 bone 返回 `{w:len,h:width}`）。 */
function boneSize(doc, el, t) {
    const lt = localTimeOf(doc, el, t);
    return elementSize(doc, el, lt);
}

/** 关节（骨骼根部中心）在局部坐标里的位置。 */
function pivotLocal(doc, el, t) {
    return anchorPoint(el, boneSize(doc, el, t));
}

/** 骨骼末端在局部坐标里的位置（根部在 anchor，末端在另一头）。 */
function tipLocal(doc, el, t) {
    const size = boneSize(doc, el, t);
    const a = anchorPoint(el, size);
    // 骨头的 anchor 是 (0, 0.5)，即根部；末端在 x 方向走完整个 len
    return { x: size.w - a.x, y: size.h / 2 };
}

/** 平移矩阵 */
function translate(p) {
    return { a: 1, b: 0, c: 0, d: 1, e: p.x, f: p.y };
}

/** 旋转矩阵（弧度） */
function rotate(rad) {
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    return { a: c, b: s, c: -s, d: c, e: 0, f: 0 };
}

/** 把角度归一化到 (-π, π]，避免绕远路 */
function wrapAngle(rad) {
    let a = rad;
    while (a > Math.PI) a -= Math.PI * 2;
    while (a <= -Math.PI) a += Math.PI * 2;
    return a;
}

/** 世界矩阵是否逐项有限（防 NaN 扩散到整帧） */
function finiteMatrix(m) {
    return !!m && isNum(m.a) && isNum(m.b) && isNum(m.c) && isNum(m.d) && isNum(m.e) && isNum(m.f);
}

/**
 * 收集本帧要解算的链。
 * 每条：`{ tipId, bones: [根 … 尾] }`（`bones` 全为 `kind === 'bone'`）。
 * 只收「有合法 ik 且 targetId 能解析且 enabled」的骨骼；目标落在链内/自身的一律跳过。
 */
export function ikChains(doc) {
    const objs = doc && Array.isArray(doc.objects) ? doc.objects : [];
    const byId = new Map();
    for (const o of objs) if (o && o.id != null) byId.set(o.id, o);

    const out = [];
    for (const el of objs) {
        if (!el || el.kind !== 'bone') continue;
        const ik = normalizeIk(el.ik);
        if (!ik || !ik.enabled) continue;
        const target = byId.get(ik.targetId);
        if (!target) continue;

        // 从 effector 上溯 chain 级；遇到非骨就停（链只能由骨组成）
        const bones = [];
        let node = el;
        const seen = new Set();
        while (node && node.kind === 'bone' && bones.length < ik.chain && bones.length < MAX_DEPTH) {
            if (node.id != null) {
                if (seen.has(node.id)) break;
                seen.add(node.id);
            }
            bones.unshift(node);
            if (node.parentId == null) break;
            const parent = byId.get(node.parentId);
            if (!parent || parent.kind !== 'bone') break;
            node = parent;
        }
        if (!bones.length) continue;

        // 目标不能在自己或自己的祖先链上：否则每帧目标被自己推着跑，表现为抖动/发散
        const ids = new Set(bones.map((b) => b.id));
        if (ids.has(ik.targetId)) continue;

        out.push({ tipId: el.id, targetId: ik.targetId, iterations: ik.iterations, bones });
    }
    return out;
}

/**
 * 解算所有 IK 链，返回「骨骼 id → 世界矩阵」覆盖表。
 *
 * **单槽缓存**：`evaluator` 与 `skin` 在同一帧会各调用一次，没有缓存就会算两遍；
 * 更糟的是两次结果若有细微差异，骨架与皮肤会错位。缓存键是「doc 引用 + 时间」，
 * 而 doc 是不可变更新（每次 setDoc 都出新对象），所以引用相等即可安全命中。
 */
let cacheDoc = null;
let cacheT = NaN;
let cacheVal = null;

export function solveIk(doc, t) {
    if (!doc || !Array.isArray(doc.objects)) return new Map();
    const time = isNum(t) ? t : 0;
    if (cacheVal && cacheDoc === doc && cacheT === time) return cacheVal;

    const out = new Map();
    for (const chain of ikChains(doc)) {
        // 当前世界矩阵（先按关键帧姿态算一遍，作为 CCD 的起点）
        const M = new Map();
        for (const b of chain.bones) M.set(b.id, worldOf(doc, b, time));

        const tip = chain.bones[chain.bones.length - 1];
        const targetEl = (doc.objects || []).find((o) => o && o.id === chain.targetId);
        if (!targetEl) continue;
        const targetM = worldOf(doc, targetEl, time);
        const target = applyMatrix(targetM, anchorPoint(targetEl, elementSize(doc, targetEl, localTimeOf(doc, targetEl, time))));

        const joints = chain.bones.map((b) => ({ el: b, pivot: pivotLocal(doc, b, time) }));
        const tipPoint = tipLocal(doc, tip, time);

        for (let iter = 0; iter < chain.iterations; iter++) {
            for (let i = joints.length - 1; i >= 0; i--) {
                const { el, pivot } = joints[i];
                const mi = M.get(el.id);
                if (!finiteMatrix(mi)) break;
                const P = applyMatrix(mi, pivot);
                const E = applyMatrix(M.get(tip.id), tipPoint);
                const va = { x: E.x - P.x, y: E.y - P.y };
                const vb = { x: target.x - P.x, y: target.y - P.y };
                // 目标与关节重合 → 任何方向都算「到位」，这一轮跳过（避免 atan2(0,0)）
                if (Math.hypot(vb.x, vb.y) < 1e-9) continue;
                // CCD 的退化点：末端正好落在关节上时「关节→末端」没有方向。
                // 不处理的话整条链会卡死在「末端贴着根」的姿态（两骨链转过 180° 之后就是这样），
                // 外层再迭代也只会一直 `continue`。这时改用骨骼自己的 +x 轴当参考方向。
                let a0x = va.x;
                let a0y = va.y;
                if (Math.hypot(a0x, a0y) < 1e-9) {
                    a0x = mi.a;
                    a0y = mi.b;
                    const n = Math.hypot(a0x, a0y);
                    if (n < 1e-12) continue;
                    a0x /= n;
                    a0y /= n;
                }
                const raw = wrapAngle(Math.atan2(vb.y, vb.x) - Math.atan2(a0y, a0x));
                if (Math.abs(raw) < 1e-9) continue;
                const delta = Math.max(-IK_MAX_STEP, Math.min(IK_MAX_STEP, raw));
                // 世界空间绕 P 旋转：D = T(P) · R(delta) · T(-P)，左乘到 i 及其后代
                const D = mulMatrix(mulMatrix(translate(P), rotate(delta)), translate({ x: -P.x, y: -P.y }));
                for (let j = i; j < joints.length; j++) {
                    const id = joints[j].el.id;
                    const next = mulMatrix(D, M.get(id));
                    M.set(id, next);
                }
            }
            const E = applyMatrix(M.get(tip.id), tipPoint);
            if (Math.hypot(E.x - target.x, E.y - target.y) <= IK_TOLERANCE) break;
        }

        for (const [id, m] of M) {
            if (finiteMatrix(m)) out.set(id, m);
        }
    }

    cacheDoc = doc;
    cacheT = time;
    cacheVal = out;
    return out;
}

/** 清缓存（测试与热重载用；正常运行不需要）。 */
export function resetIkCache() {
    cacheDoc = null;
    cacheT = NaN;
    cacheVal = null;
}
