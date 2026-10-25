/**
 * gizmo 纯算法（从 editors/canvas.mjs 抽出）
 *
 * 零 DOM、零 canvas 上下文：只做坐标/命中/拖动数学，可在 Node 里直接 import 测试。
 *
 * 坐标空间约定：`quad` / `point` 一律是**宿主相对的屏幕像素**
 * （= canvas.mjs 里 toScreen() 的产物，zoom / pan 已折算进去）。
 * 因为 toScreen 是「均匀缩放 + 平移」，双线性插值仿射协变，所以
 * toScreen(quadPoint(docQuad, u, v)) === quadPoint(screenQuad, u, v)，
 * 方向向量也保持不变 —— 在屏幕空间算手柄位置与在 doc 空间算完再投影等价。
 *
 * 判断「点在对象内部」需要 doc 空间的反解（worldToLocal），
 * 为保持本模块零依赖外壳，改由调用方通过 opts.inside 传入。
 */

import { normalizeLattice, createLattice } from './lattice.mjs';
import { elementWorldMatrix, elementLattice, invertMatrix, quadInverse } from './element.mjs';
import { quadPoint } from './element.mjs';

export { quadPoint };

/** 8 个缩放手柄，顺序即绘制与命中优先级（nw → w） */
export const HANDLE_NAMES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** 手柄在四边形上的归一化位置 */
export const HANDLE_UV = {
    nw: [0, 0],
    n: [0.5, 0],
    ne: [1, 0],
    e: [1, 0.5],
    se: [1, 1],
    s: [0.5, 1],
    sw: [0, 1],
    w: [0, 0.5],
};

export const HANDLE_PX = 4;      // 手柄半边长（屏幕像素）
export const HIT_PX = 9;         // 手柄命中半径（屏幕像素）
export const ROTATE_GAP = 26;    // 旋转手柄离上边的屏幕距离

/* ─────────────────────────── 基础数学 ─────────────────────────── */

/** 两点夹角（弧度，世界/屏幕同一空间即可） */
export function angleOf(center, point) {
    if (!center || !point) return 0;
    return Math.atan2(point.y - center.y, point.x - center.x);
}

/** 角度归一化到 (-180, 180] */
export function wrapDeg(deg) {
    if (!Number.isFinite(deg)) return 0;
    let r = deg % 360;
    if (r > 180) r -= 360;
    else if (r <= -180) r += 360;
    return r === 0 ? 0 : r;
}

/** 缩放下限保护：太小的比例会导致矩阵不可逆 */
export function clampScale(v) {
    if (!Number.isFinite(v)) return 1;
    const s = Math.abs(v) < 0.01 ? (v < 0 ? -0.01 : 0.01) : v;
    return Math.max(-50, Math.min(50, s));
}

/** 世界位移 → 局部位移（inv 为 null 时原样返回） */
export function localDelta(inv, dx, dy) {
    if (!inv) return { x: dx, y: dy };
    return { x: inv.a * dx + inv.c * dy, y: inv.b * dx + inv.d * dy };
}

/* ─────────────────────────── 手柄几何 ─────────────────────────── */

/**
 * 由屏幕空间四角算出 8 个手柄 + 旋转柄的屏幕坐标。
 * @param {{tl:{x,y},tr:{x,y},br:{x,y},bl:{x,y}}} quad
 * @returns {{nw,n,ne,e,se,s,sw,w,rotate,top,dir,bottom,center}}
 *          rotate 已含 ROTATE_GAP 外扩；top 是上边中点，dir 是上边朝外的单位法线
 */
export function handlePositions(quad) {
    const q = quad || {};
    const out = {};
    for (const name of HANDLE_NAMES) {
        const uv = HANDLE_UV[name];
        out[name] = { name, ...quadPoint(q, uv[0], uv[1]) };
    }
    const top = quadPoint(q, 0.5, 0);
    const bottom = quadPoint(q, 0.5, 1);
    let dx = top.x - bottom.x;
    let dy = top.y - bottom.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    out.top = top;
    out.bottom = bottom;
    out.dir = { x: dx, y: dy };
    out.rotate = { x: top.x + dx * ROTATE_GAP, y: top.y + dy * ROTATE_GAP };
    out.center = quadPoint(q, 0.5, 0.5);
    return out;
}

/**
 * 命中测试：返回 { kind:'scale'|'rotate'|'move'|'lattice', name, vertex } 或 null。
 * 全部按屏幕像素距离判断，手柄大小不随缩放变化。
 * @param {object} quad 屏幕空间四角
 * @param {{x:number,y:number}} point 屏幕坐标
 * @param {{mode?:'transform'|'warp', lattice?:object, threshold?:number, inside?:boolean|Function}} opts
 *        lattice: { cols, rows, map(u,v)->[x,y]|{x,y} } 或 { cols, rows, points[] }（屏幕空间顶点）
 *        inside : 点是否落在对象内部（布尔或谓词）。**缺省按四边形双线性反解自动判定**；
 *                 外壳传自己的谓词（worldToLocal）以便 >1×1 网格时更精确。
 */
export function pickHandle(quad, point, opts) {
    const o = opts || {};
    const threshold = Number.isFinite(o.threshold) ? o.threshold : HIT_PX;
    const pos = handlePositions(quad);
    // 顶点候选必须比 warp 块活得久：命中顶点后仍要继续判整体手柄，最后由 best 兜底
    let best = null;
    let bestD = threshold;

    // 网格模式：先命中所有顶点（同距离取最后一个，与旧实现一致）
    if (o.mode === 'warp' && o.lattice) {
        const { cols, rows } = o.lattice;
        const map = latticeMapper(o.lattice);
        for (let r = 0; r <= rows; r++) {
            for (let c = 0; c <= cols; c++) {
                const s = map(c / cols, r / rows);
                const d = Math.hypot(s.x - point.x, s.y - point.y);
                if (d <= bestD) {
                    bestD = d;
                    best = { kind: 'lattice', name: 'v' + (r * (cols + 1) + c), vertex: r * (cols + 1) + c };
                }
            }
        }
    }

    // 缩放手柄与旋转柄在两种模式下都可用 —— 网格变形不该牺牲整体缩放。
    // 关键：warp 顶点命中后**不能短路**，否则网格模式下 8 个缩放手柄 + 旋转柄全体失活
    //（这是曾经修过、又在重构中回退掉的 bug）。规则改成「谁更近听谁的，同距时顶点优先」。
    for (const name of HANDLE_NAMES) {
        const h = pos[name];
        const d = Math.hypot(h.x - point.x, h.y - point.y);
        if (d <= threshold && (!best || d < bestD - 0.5)) return { kind: 'scale', name };
    }
    {
        const dr = Math.hypot(pos.rotate.x - point.x, pos.rotate.y - point.y);
        if (dr <= threshold && (!best || dr < bestD - 0.5)) return { kind: 'rotate', name: 'rotate' };
    }
    if (best) return best;

    const inside = isInsideQuad(quad, point, o.inside);
    if (!inside) return null;
    return { kind: 'move', name: 'move' };
}

/**
 * 旋转原点（锚点十字）的命中判定。
 *
 * 单独成函数是为了让「锚点优先于 8 个缩放手柄」这条规则可测：
 * 锚点默认落在对象左上角 (0,0)，与 nw 手柄重合，若交给 pickHandle 一并判，
 * 同距时手柄先返回，用户就永远拖不到锚点（只会把对象缩小/翻转）。
 *
 * @param {{x:number,y:number}|{0:number,1:number}|null} anchorScreen 锚点屏幕坐标
 *        （对象 `{x,y}` 形式；历史上这里误传过 `[x,y]` 数组风格的取值，那会得到 NaN）
 * @param {{x:number,y:number}} point 指针屏幕坐标
 * @param {number} [threshold] 命中半径，默认 HIT_PX
 * @returns {{kind:'anchor', name:'anchor'}|null}
 */
export function pickAnchor(anchorScreen, point, threshold) {
    if (!anchorScreen || !point) return null;
    const ax = anchorScreen.x;
    const ay = anchorScreen.y;
    if (!Number.isFinite(ax) || !Number.isFinite(ay)) return null;
    const th = Number.isFinite(threshold) ? threshold : HIT_PX;
    return Math.hypot(ax - point.x, ay - point.y) <= th ? { kind: 'anchor', name: 'anchor' } : null;
}

/**
 * 指针 doc 坐标 → 锚点归一化 uv（拖锚点用）。
 *
 * 刻意不复用 core/element.worldToLocal：那条路径带 1e-3 的严格容差、且经过网格反解，
 * 锚点默认落在对象角上，起步时指针正好压在边界（v≈0），用它会出现
 * 「拖了半天不动、走远了才跟手」。这里直接在世界矩阵的逆空间里除基准尺寸，
 * 与 anchorPoint(el, size) 的 `size * a` 严格互逆，越界统一夹到 [0,1]。
 *
 * @param {{a,b,c,d,e,f}|null} inv 世界矩阵的逆
 * @param {{w:number,h:number}} size 对象基准尺寸
 * @param {{x:number,y:number}} p doc 空间点
 * @returns {{u:number,v:number}|null} 矩阵不可逆或尺寸退化时 null
 */
export function anchorUvFromMatrix(inv, size, p) {
    if (!inv || !size || !p) return null;
    const w = size.w;
    const h = size.h;
    if (!(w > 0) || !(h > 0)) return null;
    const x = inv.a * p.x + inv.c * p.y + inv.e;
    const y = inv.b * p.x + inv.d * p.y + inv.f;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return {
        u: Math.max(0, Math.min(1, x / w)),
        v: Math.max(0, Math.min(1, y / h)),
    };
}

/**
 * 内部判定：调用方给了布尔/谓词就照用，否则按四边形双线性反解算（缺省行为）。
 */
function isInsideQuad(quad, point, hint) {
    if (typeof hint === 'function') return !!hint(point);
    if (typeof hint === 'boolean') return hint;
    const uv = quadInverse(quad, point);
    return !!(uv && uv.u >= 0 && uv.u <= 1 && uv.v >= 0 && uv.v <= 1);
}

/** 网格顶点映射：既支持 map(u,v) 回调，也支持现成的屏幕空间顶点数组 */
function latticeMapper(lat) {
    if (typeof lat.map === 'function') {
        return (u, v) => {
            const p = lat.map(u, v);
            return Array.isArray(p) ? { x: p[0], y: p[1] } : { x: p.x, y: p.y };
        };
    }
    const pts = Array.isArray(lat.points) ? lat.points : [];
    const { cols, rows } = lat;
    return (u, v) => {
        const p = pts[Math.round(v * rows) * (cols + 1) + Math.round(u * cols)];
        if (!p) return { x: 0, y: 0 };
        return Array.isArray(p) ? { x: p[0], y: p[1] } : { x: p.x, y: p.y };
    };
}

/* ─────────────────────────── 变换应用 ─────────────────────────── */

/**
 * 按手柄名与比例算出新的缩放。只返回被这个手柄驱动的轴。
 * n / s 只驱动 y，e / w 只驱动 x，四角两轴都驱动。
 * @param {{scaleX:number,scaleY:number}} state
 * @param {string} handleName
 * @param {number|null} ratioX null = 这一轴退化，跳过
 * @param {number|null} ratioY
 */
export function applyScale(state, handleName, ratioX, ratioY) {
    const s = state || {};
    const name = typeof handleName === 'string' ? handleName : '';
    const useX = name !== 'n' && name !== 's';
    const useY = name !== 'e' && name !== 'w';
    const sx = Number.isFinite(s.scaleX) ? s.scaleX : 1;
    const sy = Number.isFinite(s.scaleY) ? s.scaleY : 1;
    const out = {};
    if (useX && Number.isFinite(ratioX)) out.scaleX = clampScale(sx * ratioX);
    if (useY && Number.isFinite(ratioY)) out.scaleY = clampScale(sy * ratioY);
    return out;
}

/**
 * 旋转：叠加角度增量并归一化到 (-180, 180]。
 * 注意：拖动路径（dragPatch 的 rotate 分支）刻意**不**用这个折叠版，
 * 为的是让关键帧里的 rotate 与重构前逐位一致（属性面板直接显示它）。
 * @param {{rotate:number}} state
 * @param {number} angleDelta 角度（不是弧度）
 */
export function applyRotate(state, angleDelta) {
    const base = state && Number.isFinite(state.rotate) ? state.rotate : 0;
    return wrapDeg(base + (Number.isFinite(angleDelta) ? angleDelta : 0));
}

/* ─────────────────────────── 拖动算法 ─────────────────────────── */

/**
 * 一次拖动产生的关键帧补丁（四个分支：move / rotate / scale / lattice）。
 * @param {object} input
 *   pick  命中结果（pickHandle 的返回值）
 *   doc   文档
 *   el    被拖对象
 *   time  对象局部时间
 *   parentM 父链矩阵（可能为 null）
 *   start 拖动开始时的对象状态（elementState）
 *   p0    按下点（doc 空间）
 *   p     当前点（doc 空间）
 *   size  对象尺寸
 *   anchorWorld 锚点世界坐标
 * @returns {object} 交给 writeKey 的 patch
 */
export function dragPatch(input) {
    const { pick, doc, el, time, parentM, start, p0, p, size, anchorWorld } = input;
    const patch = {};
    const kind = pick && pick.kind;

    if (kind === 'move') {
        // 世界位移 → 父链局部位移：父对象旋转后，往右拖应该是「沿父轴走」，
        // 而不是在世界坐标里横着飘。没有父链时逆矩阵为 null，走原路径。
        const inv = parentM ? invertMatrix(parentM) : null;
        const l = localDelta(inv, p.x - p0.x, p.y - p0.y);
        patch.x = start.x + l.x;
        patch.y = start.y + l.y;
    } else if (kind === 'rotate') {
        // atan2 已经是世界角，父级旋转在差值里自动抵消（父固定时 Δ世界 = Δ局部）
        const delta = ((angleOf(anchorWorld, p) - angleOf(anchorWorld, p0)) * 180) / Math.PI;
        // 刻意不做 ±180 折叠：属性面板直接显示这个数，折一下就把「转过去 210°」
        // 变成「-150°」，与重构前的关键帧内容不一致。要折叠版用 applyRotate(start, delta)。
        patch.rotate = start.rotate + delta;
    } else if (kind === 'scale') {
        // 沿对象局部 x / y 轴投影，按「锚点为中心」缩放
        const m = elementWorldMatrix(el, time, size, parentM);
        const ax = { x: m.a, y: m.b };                    // 局部 x 轴方向
        const ay = { x: m.c, y: m.d };                    // 局部 y 轴方向
        const d0 = { x: p0.x - anchorWorld.x, y: p0.y - anchorWorld.y };
        const d1 = { x: p.x - anchorWorld.x, y: p.y - anchorWorld.y };
        const a0 = d0.x * ax.x + d0.y * ax.y;
        const a1 = d1.x * ax.x + d1.y * ax.y;
        const b0 = d0.x * ay.x + d0.y * ay.y;
        const b1 = d1.x * ay.x + d1.y * ay.y;
        Object.assign(patch, applyScale(
            start,
            pick.name,
            Math.abs(a0) > 1e-6 ? a1 / a0 : null,
            Math.abs(b0) > 1e-6 ? b1 / b0 : null,
        ));
    } else if (kind === 'lattice') {
        // 顶点偏移存在对象局部空间：把世界位移用逆矩阵的线性部分换算
        const inv = invertMatrix(elementWorldMatrix(el, time, size, parentM));
        if (inv) {
            const l = localDelta(inv, p.x - p0.x, p.y - p0.y);
            const cur = elementLattice(doc, el, time, parentM);
            const base = normalizeLattice(start.warp) || createLattice(cur.lattice.cols, cur.lattice.rows);
            const pts = base.pts.map((pt) => [pt[0], pt[1]]);
            const i = pick.vertex;
            if (pts[i]) {
                pts[i][0] += l.x;
                pts[i][1] += l.y;
            }
            patch.warp = { cols: base.cols, rows: base.rows, pts };
        }
    }
    return patch;
}
