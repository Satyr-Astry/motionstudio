// 对象（部件）几何层：内容尺寸、变换矩阵（含锚点）、世界/局部换算、手柄位置、点击命中。
// 依赖：doc-model.mjs（按时间取画格位图）、transform.mjs（取轨道状态 / 矩阵 / warp 四角）。
// 约定：doc 空间 = 画布像素坐标；变换在 doc 空间内进行；屏幕换算留给画布叠加层。
import { imageAt } from './doc-model.mjs';
import { stateAt, matrixOf, warpQuad } from './transform.mjs';
import { normalizeLattice, createLattice, latticeOffset, latticeInverse } from './lattice.mjs';

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

/** 对象内容矩形尺寸：优先该时间生效的画格位图尺寸，回退文档尺寸 */
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

/**
 * 画布点击命中测试。
 * opts: { threshold = 8, skip = [id...] }
 * 返回 { id, local, alpha } 或 null。layers[0] 是最上层，从上层往下找。
 */
export function hitTest(doc, time, x, y, opts) {
    const o = opts || {};
    const list = doc.objects || doc.layers || [];
    const threshold = o.threshold == null ? 8 : o.threshold;
    const skip = o.skip && o.skip.length ? new Set(o.skip) : null;
    const p = { x, y };
    for (let i = 0; i < list.length; i++) {
        const el = list[i];
        if (!el.visible || el.locked || el.onClickIgnore) continue;
        if (skip && skip.has(el.id)) continue;
        // 父子层级：命中必须走世界矩阵，否则父对象旋转后点不中
        const pm = typeof o.parentMatrix === 'function' ? o.parentMatrix(el, time) : null;
        const uv = worldToLocal(doc, el, time, p, pm);
        if (!uv) continue;
        if (uv.u < 0 || uv.u > 1 || uv.v < 0 || uv.v > 1) continue;
        const size = elementSize(doc, el, time);
        const lx = Math.floor(uv.u * size.w);
        const ly = Math.floor(uv.v * size.h);
        const alpha = pixelAlpha(imageAt(el, time), lx, ly);
        if (alpha > threshold) return { id: el.id, local: { x: lx, y: ly }, alpha };
    }
    return null;
}

/** 对象是否在 doc 内可见（用于选中框提示） */
export function isElementVisible(el) {
    return !!(el && el.visible && !el.locked);
}
