// 对象（部件）几何层：内容尺寸、变换矩阵（含锚点）、世界/局部换算、手柄位置、点击命中。
// 依赖：doc-model.mjs（按时间取纹理位图）、transform.mjs（取轨道状态 / 矩阵 / warp 四角）。
// 约定：doc 空间 = 画布像素坐标；变换在 doc 空间内进行；屏幕换算留给画布叠加层。
import { imageAt, objectById } from './doc-model.mjs';
import { stateAt, matrixOf, warpQuad } from './transform.mjs';
import { normalizeLattice, createLattice, latticeOffset, latticeInverse, latticeInverseRaw } from './lattice.mjs';
import { alphaMaskOf } from './hit-mask.mjs';

/** 八个缩放手柄，顺时针从左上开始 */
export const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** 手柄到四边形对应边的映射：pos = 两个角插值 */
const HANDLE_UV = {
    nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5],
    se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5],
};

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/** 对象在时间 time 的变换状态（缺轨道时给空状态） */
export function elementState(el, time) {
    const trk = el && el.transform ? el.transform : { keys: [] };
    return stateAt(trk, time) || {};
}

/** 对象内容矩形尺寸：优先该时间生效的纹理位图尺寸，回退文档尺寸 */
export function elementSize(doc, el, t) {
    const img = el ? imageAt(el, typeof t === 'number' && Number.isFinite(t) ? t : 0) : null;
    if (img && img.width && img.height) return { w: img.width, h: img.height };
    return { w: doc.width, h: doc.height };
}

/** 锚点在局部坐标里的像素位置 */
export function anchorPoint(el, size) {
    const a = (el && el.anchor) || { x: 0.5, y: 0.5 };
    return { x: size.w * a.x, y: size.h * a.y };
}

/** 2x3 矩阵相乘：返回 m1 · m2 */
export function mulMatrix(m1, m2) {
    return {
        a: m1.a * m2.a + m1.c * m2.b,
        b: m1.b * m2.a + m1.d * m2.b,
        c: m1.a * m2.c + m1.c * m2.d,
        d: m1.b * m2.c + m1.d * m2.d,
        e: m1.a * m2.e + m1.c * m2.f + m1.e,
        f: m1.b * m2.e + m1.d * m2.f + m1.f,
    };
}

/** 2x3 矩阵求逆；退化时返回 null */
export function invertMatrix(m) {
    const det = m.a * m.d - m.b * m.c;
    if (!isFinite(det) || Math.abs(det) < 1e-12) return null;
    const ia = m.d / det;
    const ib = -m.b / det;
    const ic = -m.c / det;
    const id = m.a / det;
    // 「|| 0」把 -0 归一成 0，避免 deepEqual 之类的严格比较出岔子
    return {
        a: ia || 0, b: ib || 0, c: ic || 0, d: id || 0,
        e: -(ia * m.e + ic * m.f) || 0,
        f: -(ib * m.e + id * m.f) || 0,
    };
}

/** 点乘矩阵 */
export function applyMatrix(m, p) {
    return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f };
}

/**
 * 对象变换矩阵（doc 空间）。
 * 旋转与缩放围绕 anchor 进行：M = T(anchor) · matrixOf(state) · T(-anchor)
 * warp 不走矩阵，由 elementQuad 处理。
 */
export function elementMatrix(el, time, size) {
    const st = elementState(el, time);
    const base = matrixOf(st) || IDENTITY;
    const a = anchorPoint(el, size);
    if (!a.x && !a.y) return base;
    return mulMatrix(
        { a: 1, b: 0, c: 0, d: 1, e: a.x, f: a.y },
        mulMatrix(base, { a: 1, b: 0, c: 0, d: 1, e: -a.x, f: -a.y }),
    );
}

/** 双线性插值四边形：uv ∈ [0,1]² → 点 */
export function quadPoint(q, u, v) {
    const w00 = (1 - u) * (1 - v);
    const w10 = u * (1 - v);
    const w11 = u * v;
    const w01 = (1 - u) * v;
    return {
        x: q.tl.x * w00 + q.tr.x * w10 + q.br.x * w11 + q.bl.x * w01,
        y: q.tl.y * w00 + q.tr.y * w10 + q.br.y * w11 + q.bl.y * w01,
    };
}

/**
 * 双线性反解：世界（局部四边形空间）点 → (u, v)。
 * 牛顿迭代 10 次，收敛不到 1e-6 就返回 null。
 */
export function quadInverse(q, p) {
    let u = 0.5;
    let v = 0.5;
    for (let i = 0; i < 10; i++) {
        const cur = quadPoint(q, u, v);
        const dx = cur.x - p.x;
        const dy = cur.y - p.y;
        if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return { u, v };
        // 偏导
        const dux = (q.tr.x - q.tl.x) * (1 - v) + (q.br.x - q.bl.x) * v;
        const duy = (q.tr.y - q.tl.y) * (1 - v) + (q.br.y - q.bl.y) * v;
        const dvx = (q.bl.x - q.tl.x) * (1 - u) + (q.br.x - q.tr.x) * u;
        const dvy = (q.bl.y - q.tl.y) * (1 - u) + (q.br.y - q.tr.y) * u;
        const det = dux * dvy - duy * dvx;
        if (!isFinite(det) || Math.abs(det) < 1e-12) return null;
        u -= (dx * dvy - dy * dvx) / det;
        v -= (dux * dy - duy * dx) / det;
        if (u < -0.5 || u > 1.5 || v < -0.5 || v > 1.5) return null;
    }
    const cur = quadPoint(q, u, v);
    if (Math.abs(cur.x - p.x) > 1e-3 || Math.abs(cur.y - p.y) > 1e-3) return null;
    return { u, v };
}

/**
 * 对象在 doc 空间的四角（顺序 tl, tr, br, bl）。
 * 网格 warp >1×1 时给出外框四角；逐格轮廓见 elementLattice。
 */
export function elementQuad(doc, el, time, parentM) {
    const info = elementLattice(doc, el, time, parentM);
    const L = info.lattice;
    const at = (u, v) => {
        const p = info.map(u, v);
        return { x: p[0], y: p[1] };
    };
    return {
        tl: at(0, 0),
        tr: at(1, 0),
        br: at(1, 1),
        bl: at(0, 1),
        size: info.size,
        matrix: info.matrix,
        lattice: L,
    };
}

/**
 * 本层矩阵叠加父链矩阵（parentM 为 null 时等价于 elementMatrix）。
 * 画布叠加层必须用世界矩阵，否则父对象旋转后选框与拖动方向都会错位。
 */
export function elementWorldMatrix(el, time, size, parentM) {
    const own = elementMatrix(el, time, size);
    return parentM ? mulMatrix(parentM, own) : own;
}

/** 祖先链矩阵（不含自身，自根向下累乘）；父链有环或超深时截断，不抛错。 */
function chainMatrix(doc, el, time, sizeOf) {
    const chain = [];
    let cur = el && el.parentId != null ? objectById(doc, el.parentId) : null;
    let guard = 0;
    while (cur && guard < 64) {
        chain.push(cur);
        cur = cur.parentId != null ? objectById(doc, cur.parentId) : null;
        guard++;
    }
    let M = null;
    for (let i = chain.length - 1; i >= 0; i--) {
        const p = chain[i];
        const size = sizeOf ? sizeOf(p, time) : elementSize(doc, p, time);
        M = elementWorldMatrix(p, time, size, M);
    }
    return M;
}

/**
 * 换父级时为了让对象「在世界里不动」所需的 x/y 增量（纯矩阵推导）。
 *
 * 推导：设 E 为元素自身矩阵（`elementMatrix`，已含锚点），W 为世界矩阵。
 * 换父只允许改 x/y，所以新旧两个 E 的**线性部分必须相同**、只有平移变。
 * 于是 `E_new = inverse(W_新父) * W_旧`、`E_old = inverse(W_旧父) * W_旧`，
 * 增量就是两者平移之差 —— 不需要反解锚点，也天然支持父级带旋转/缩放/斜切
 * （斜切导致父矩阵不可逆时才拒绝，见下）。
 *
 * `x/y` 对 `E.e/E.f` 是一比一的（平移增量不随锚点变化），所以直接加到 x/y 上即可。
 *
 * @param {object} doc 文档
 * @param {object} el 要换父的对象（用**旧** parentId 取祖先链）
 * @param {string|null} parentId 新父 id
 * @param {number} time 时刻（父级可能带关键帧，必须按该时刻算）
 * @param {(el: object, time: number) => {w:number,h:number}} [sizeOf] 尺寸取法，缺省走 `elementSize`
 * @returns {{ok: boolean, dx: number, dy: number, reason: string}}
 */
export function reparentOffset(doc, el, parentId, time, sizeOf) {
    if (!doc || !el) return { ok: false, dx: 0, dy: 0, reason: '没有对象' };
    const t = Number(time);
    if (!Number.isFinite(t)) return { ok: false, dx: 0, dy: 0, reason: '时刻无效' };
    const size = sizeOf ? sizeOf(el, t) : elementSize(doc, el, t);
    if (!size || !(Number(size.w) > 0) || !(Number(size.h) > 0)) {
        return { ok: false, dx: 0, dy: 0, reason: '对象尺寸无效' };
    }
    const newParent = parentId == null ? null : objectById(doc, parentId);
    if (parentId != null && !newParent) return { ok: false, dx: 0, dy: 0, reason: '父对象不存在' };
    const oldParentM = chainMatrix(doc, el, t, sizeOf);
    const W_old = elementWorldMatrix(el, t, size, oldParentM);
    const newParentM = newParent ? chainMatrix(doc, newParent, t, sizeOf) : null;
    const newParentSize = newParent
        ? (sizeOf ? sizeOf(newParent, t) : elementSize(doc, newParent, t))
        : null;
    const W_newParent = newParent ? elementWorldMatrix(newParent, t, newParentSize, newParentM) : IDENTITY;
    const invNew = invertMatrix(W_newParent);
    if (!invNew) {
        return { ok: false, dx: 0, dy: 0, reason: '新父级的变换无法求逆（斜切或零缩放），换父会让画面跳位，已取消' };
    }
    const invOld = oldParentM ? invertMatrix(oldParentM) : null;
    if (oldParentM && !invOld) {
        return { ok: false, dx: 0, dy: 0, reason: '原父级的变换无法求逆，换父会让画面跳位，已取消' };
    }
    /**
     * 只改 x/y 时能保住的是「锚点在世界上不动」，不能连姿态一起保 ——
     * 父级带旋转/缩放时，子对象的姿态必然随父改变（这是父子层级的定义）。
     * 所以解的是：让 E 的**线性部分不变**、平移取到某个值，使
     *   newParent * E_new * anchor === oldWorld * anchor
     * 记 k = E_linear * anchor（线性部分不随 x/y 变），则
     *   (x', y') = inverse(newParent) * (oldWorld * anchor) - k
     */
    const anchor = anchorPoint(el, size);
    const E_old = oldParentM ? mulMatrix(invOld, W_old) : W_old;
    const k = {
        x: E_old.a * anchor.x + E_old.c * anchor.y,
        y: E_old.b * anchor.x + E_old.d * anchor.y,
    };
    const q = applyMatrix(invNew, applyMatrix(W_old, anchor));
    const xNew = q.x - k.x;
    const yNew = q.y - k.y;
    const cur = stateAt(el.transform, t) || {};
    const xOld = Number(cur.x) || 0;
    const yOld = Number(cur.y) || 0;
    const dx = xNew - xOld;
    const dy = yNew - yOld;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
        return { ok: false, dx: 0, dy: 0, reason: '换父时位置换算失败' };
    }
    // 「|| 0」把 -0 归一成 0，避免 deepEqual / 序列化出岔子
    return { ok: true, dx: dx || 0, dy: dy || 0, reason: '' };
}

/**
 * 网格 warp 的完整描述：网格本身、基准尺寸、锚点矩阵，以及局部 uv → doc 空间的映射。
 * 渲染（composite）与叠加层（canvas）都用这里的 map，保证画出来的网格和像素变形一致。
 * parentM 为祖先链矩阵（不含自身），供父子层级下保持一致。
 */
export function elementLattice(doc, el, t, parentM) {
    const size = elementSize(doc, el, t);
    const st = elementState(el, t);
    const M = elementWorldMatrix(el, t, size, parentM);
    const L = normalizeLattice(st.warp) || createLattice(1, 1);
    const map = (u, v) => {
        const o = latticeOffset(L, u, v);
        const p = applyMatrix(M, { x: u * size.w + o.x, y: v * size.h + o.y });
        return [p.x, p.y];
    };
    return { lattice: L, size, matrix: M, map };
}

/** doc 空间点 → 对象局部 uv（考虑网格 warp）；不可逆或不在网格内时返回 null */
export function worldToLocal(doc, el, time, p, parentM) {
    const info = elementLattice(doc, el, time, parentM);
    const inv = invertMatrix(info.matrix);
    if (!inv) return null;
    const local = applyMatrix(inv, p);
    const uv = latticeInverse(info.lattice, info.size.w, info.size.h, local);
    return uv ? { u: uv[0], v: uv[1] } : null;
}

/** 局部坐标 → doc 空间（考虑 warp） */
export function localToWorld(doc, el, time, p, parentM) {
    const info = elementLattice(doc, el, time, parentM);
    const u = info.size.w ? p.x / info.size.w : 0;
    const v = info.size.h ? p.y / info.size.h : 0;
    const out = info.map(u, v);
    return { x: out[0], y: out[1] };
}

/** 网格是否等于「没有任何变形」（1×1 且四个顶点偏移都是 0） */
function isFlatLattice(L) {
    if (!L) return true;
    if (L.cols !== 1 || L.rows !== 1) return false;
    const pts = L.pts;
    if (!Array.isArray(pts) || pts.length !== 4) return false;
    for (const q of pts) {
        const x = Array.isArray(q) ? q[0] : q && q.x;
        const y = Array.isArray(q) ? q[1] : q && q.y;
        if (Math.abs(x || 0) > 1e-6 || Math.abs(y || 0) > 1e-6) return false;
    }
    return true;
}

/**
 * doc 点 → 对象局部坐标，**不夹取**。
 *
 * 和 worldToLocal 的区别：这里把「边界上」与「边界外」分开返回（uv 可能是 -0.01 或 1.02），
 * 由调用方按自己的容差判定。`tolerance` 是**局部像素**的越界放宽量（默认 0 = 严格）。
 *
 * 无变形时直接走一次逆矩阵，完全不碰 lattice 反解；
 * 有变形时才调 latticeInverseRaw，并把像素容差换算成每格归一化容差
 * （否则同样的 2px 容差在 1×1 网格上是 2px、在 4×4 网格上只有 0.5px）。
 *
 * @returns {{u:number,v:number,x:number,y:number}|null} x/y 是局部像素（可能略微越界）
 */
export function localUv(doc, el, time, p, parentM, tolerance) {
    const tol = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : 0;
    const info = elementLattice(doc, el, time, parentM);
    const w = info.size.w;
    const h = info.size.h;
    if (!(w > 0) || !(h > 0)) return null;
    const inv = invertMatrix(info.matrix);
    if (!inv) return null;
    const local = applyMatrix(inv, p);
    if (!Number.isFinite(local.x) || !Number.isFinite(local.y)) return null;
    if (isFlatLattice(info.lattice)) {
        return { u: local.x / w, v: local.y / h, x: local.x, y: local.y };
    }
    const L = info.lattice;
    const cellW = w / L.cols;
    const cellH = h / L.rows;
    // 1e-6 是给浮点误差留的保底，远小于 1px，不会让边界外的点混进来
    const edgeX = Math.max(tol / cellW, 1e-6);
    const edgeY = Math.max(tol / cellH, 1e-6);
    const raw = latticeInverseRaw(L, w, h, local, { pad: Math.max(2, tol), edgeX, edgeY });
    if (!raw) return null;
    return { u: raw[0], v: raw[1], x: raw[0] * w, y: raw[1] * h };
}

/**
 * 手柄位置（doc 空间）。
 * 返回 { handles: [{name, x, y}], rotate: {x, y, dir:{x, y}}, center: {x, y} }
 * rotate 的偏移由调用方按屏幕像素 / zoom 施加，dir 是上边中点朝外的单位法线。
 */
export function handlePoints(doc, el, time, parentM) {
    const quad = elementQuad(doc, el, time, parentM);
    const handles = HANDLES.map((name) => {
        const uv = HANDLE_UV[name];
        const p = quadPoint(quad, uv[0], uv[1]);
        return { name, x: p.x, y: p.y };
    });
    const top = quadPoint(quad, 0.5, 0);
    const bottom = quadPoint(quad, 0.5, 1);
    let dx = top.x - bottom.x;
    let dy = top.y - bottom.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const center = quadPoint(quad, 0.5, 0.5);
    return { handles, rotate: { x: top.x, y: top.y, dir: { x: dx, y: dy } }, center, quad };
}

/** 读单个像素 alpha（兼容 canvas 与 OffscreenCanvas） */
export function pixelAlpha(img, x, y) {
    if (!img) return 0;
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return 0;
    try {
        const g = img.getContext('2d', { willReadFrequently: true });
        if (!g) return 0;
        return g.getImageData(x, y, 1, 1).data[3] || 0;
    } catch (e) {
        return 0;
    }
}

/** 把像素索引夹进 [lo, hi]（lo > hi 时返回 lo） */
function clampIdx(v, lo, hi) {
    if (hi < lo) return lo;
    return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 画布点击命中测试。
 *
 * opts: {
 *   threshold = 8,            像素 alpha 阈值
 *   skip = [id...],           跳过的对象
 *   parentMatrix,             父级矩阵取值函数
 *   tolerance = 0,            几何越界容差，单位**对象局部像素**。0 = 严格按边界，
 *                             边界外 0.001px 也不算命中。要按屏幕像素放宽，调用方传
 *                             `screenPx / zoom`（画布缩放不是 1 时）。
 * }
 *
 * 返回 { id, local, alpha } 或 null。layers[0] 是最上层，从上层往下找。
 *
 * 历史行为提醒：本函数此前用 worldToLocal + `uv ∈ [0,1]` 判定，而 worldToLocal 会把
 * 越界点夹回 [0,1]、且自身带 2px 的包围盒容差 —— 结果是「上/左边界外 1px 能选中，
 * 右/下边界本身却选不中」。改为 localUv（不夹取）+ 显式容差后四方向一致。
 *
 * alpha 取自 `alphaMaskOf`（`hit-mask.mjs`）：canvas 直接读，`ImageBitmap` 这类
 * 没有 getContext 的源会被重画进临时画布再读 —— 此前直接调 pixelAlpha，导入的
 * PNG/PSD 图层取像素抛错被吞成 0，导致它们在画布上永远点不中。掩膜读不出来时
 * **退回矩形命中**（见下方注释），这是有意的降级。
 */
export function hitTest(doc, time, x, y, opts) {
    const o = opts || {};
    const list = doc.objects || doc.layers || [];
    const threshold = o.threshold == null ? 8 : o.threshold;
    const tol = Number.isFinite(o.tolerance) && o.tolerance > 0 ? o.tolerance : 0;
    const skip = o.skip && o.skip.length ? new Set(o.skip) : null;
    const p = { x, y };
    for (let i = 0; i < list.length; i++) {
        const el = list[i];
        if (!el.visible || el.locked || el.onClickIgnore) continue;
        if (skip && skip.has(el.id)) continue;
        // 父子层级：命中必须走世界矩阵，否则父对象旋转后点不中
        const pm = typeof o.parentMatrix === 'function' ? o.parentMatrix(el, time) : null;
        const loc = localUv(doc, el, time, p, pm, tol);
        if (!loc) continue;
        const size = elementSize(doc, el, time);
        const w = size.w;
        const h = size.h;
        if (!(w > 0) || !(h > 0)) continue;
        // 1e-6 的浮点余量：旋转后世界 → 局部的往返误差在 1e-16 量级，
        // 少了它，容差恰好等于 tolerance 的点会随机变成「越界 4e-16 像素」而被挡掉。
        const eps = 1e-6;
        if (loc.x < -tol - eps || loc.x > w + tol + eps) continue;
        if (loc.y < -tol - eps || loc.y > h + tol + eps) continue;
        // 夹进像素范围：uv 恰为 1 时 floor 得到 width（越界），
        // 于是「贴着右边/下边的最后一列像素」永远点不中，那是个历史缺陷。
        const lx = clampIdx(Math.floor(loc.x), 0, w - 1);
        const ly = clampIdx(Math.floor(loc.y), 0, h - 1);
        const image = imageAt(el, time);
        // 没有图像（空纹理 / 纯矢量对象）：不命中。这一条不能并进下面的降级，
        // 否则一个还没画任何东西的空对象会整块矩形都能点中。
        if (!image) continue;
        // 图像尺寸为 0 同样视为「没有内容」：elementSize 此时会回退到 doc 尺寸，
        // 若不挡住，下面读不到像素的降级会让这个空对象占住整个画布。
        if (!(Number(image.width) > 0) || !(Number(image.height) > 0)) continue;
        const mask = alphaMaskOf(image);
        if (!mask) {
            // 有图像但掩膜读不出来（没有 2D 上下文、drawImage/getImageData 抛错）：
            // 退回矩形命中。这是有意的降级 —— 点不中对象在用户眼里是功能破损，
            // 而多选中一次透明区只需要再点一下空白；反过来则无路可走。
            return { id: el.id, local: { x: lx, y: ly }, alpha: 255 };
        }
        // 掩膜尺寸未必等于对象基准尺寸（图像换过、对象被拉伸过），按掩膜夹取索引，
        // 否则 lx 超过掩膜宽度会读到下一行的像素。
        const mx = clampIdx(lx, 0, mask.w - 1);
        const my = clampIdx(ly, 0, mask.h - 1);
        const alpha = mask.mask[my * mask.w + mx];
        if (alpha > threshold) return { id: el.id, local: { x: lx, y: ly }, alpha };
    }
    return null;
}

/** 对象是否在 doc 内可见（用于选中框提示） */
export function isElementVisible(el) {
    return !!(el && el.visible && !el.locked);
}
