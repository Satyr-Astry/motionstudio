/**
 * 骨骼工具（工具栏 K）的纯几何：画布上从 A 拖到 B 直接建一根骨、抓住骨末梢拖长度与角度。
 *
 * 这里只做数学，不碰 DOM / 不写文档：
 * - 建骨：把画布上的两点换算成父空间的 `{x,y,rotate,len}`（正好是骨骼 transform 与 bone.len 的入参）；
 * - 拖末梢：已知骨骼当前状态与指针点，算出新的 `{rotate,len}`；
 * - 命中/叠加层：给出骨骼根/末梢的文档坐标。
 *
 * 坐标约定与渲染同源（app/editors/canvas.mjs drawBones）：骨骼局部几何是
 * (0, width/2) → (len, width/2) 的一段线，anchor 在左端中点，所以
 * 根 = state.x/y + (anchor.x, anchor.y)，且旋转绕根进行。
 */

import { BONE_ANCHOR, BONE_DEFAULTS } from './doc-model.mjs';
import { applyMatrix, elementSize, elementWorldMatrix } from './element.mjs';

const DEG = 180 / Math.PI;

/** 骨骼最短长度：与 doc-model 的 normalizeBone 下限一致（再短就没法抓末梢了）。 */
const BONE_MIN_LEN = 8;

const round2 = (v) => Math.round(v * 100) / 100;

const isPt = (p) => p && Number.isFinite(p.x) && Number.isFinite(p.y);

const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);

/** 父空间点的逆变换：给了矩阵就变换，没给就当作父空间=文档空间。 */
function intoParent(point, parentInverse) {
    if (!parentInverse) return { x: point.x, y: point.y };
    return applyMatrix(parentInverse, point);
}

/** 旋转角归一到 (-180, 180]，避免 360° 累加导致曲线/属性面板出现怪值。 */
function normalizeDeg(deg) {
    if (!Number.isFinite(deg)) return 0;
    let d = deg % 360;
    if (d > 180) d -= 360;
    if (d <= -180) d += 360;
    return round2(d);
}

/**
 * 建骨拖动：起点 `from` 与终点 `to` 是**文档坐标**，返回新骨的父空间参数。
 *
 * 骨骼的 anchor 在左端中点，所以「按下点 = 骨根」要让 x/y 回退半个宽度；
 * 长度取两点距离并夹最小 8，角度取 atan2。`parentInverse` 是父链世界矩阵的逆
 * （顶层骨骼不需要传）。
 *
 * @param {{from:{x:number,y:number}, to:{x:number,y:number}, parentInverse?:object|null, width?:number}} opts
 * @returns {{x:number, y:number, rotate:number, len:number}|null}
 */
export function boneDragGeometry(opts) {
    const o = opts || {};
    if (!isPt(o.from) || !isPt(o.to)) return null;
    const width = Math.max(2, num(o.width, BONE_DEFAULTS.width));
    const from = intoParent(o.from, o.parentInverse);
    const to = intoParent(o.to, o.parentInverse);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    return {
        x: round2(from.x - width * BONE_ANCHOR.x),
        y: round2(from.y - width * BONE_ANCHOR.y),
        rotate: normalizeDeg(Math.atan2(dy, dx) * DEG),
        len: Math.max(BONE_MIN_LEN, round2(dist)),
    };
}

/**
 * 拖末梢：在父空间里把指针点 `point`（文档坐标，调用方已用父链逆矩阵换算）
 * 变成骨骼的 `{rotate,len}`。缩放过的骨骼按 |scaleX| 折算长度，保证末梢跟手。
 *
 * @param {{state:object|undefined, width?:number, point:{x:number,y:number}}} opts
 * @returns {{rotate:number, len:number}|null}
 */
export function boneTipGeometry(opts) {
    const o = opts || {};
    if (!isPt(o.point)) return null;
    const st = o.state || {};
    const width = Math.max(2, num(o.width, BONE_DEFAULTS.width));
    const baseX = num(st.x, 0);
    const baseY = num(st.y, 0);
    // 根位置 = state + anchor*size，骨骼 anchor=(0,0.5)、size=(len,width)
    const rootX = baseX + width * BONE_ANCHOR.x;
    const rootY = baseY + width * BONE_ANCHOR.y;
    const dx = o.point.x - rootX;
    const dy = o.point.y - rootY;
    const scaleX = Math.abs(num(st.scaleX, 1)) || 1;
    const dist = Math.sqrt(dx * dx + dy * dy) / scaleX;
    return {
        rotate: normalizeDeg(Math.atan2(dy, dx) * DEG),
        len: Math.max(BONE_MIN_LEN, round2(dist)),
    };
}

/**
 * 骨骼在文档坐标里的根/末梢，供命中测试与叠加层手柄使用。
 * 与渲染完全同源：父链矩阵由调用方给（ctx.objectParentMatrix），
 * 自身矩阵走 elementWorldMatrix，锚点/尺寸走 elementSize。
 *
 * @param {object} el 骨骼对象
 * @param {number} time 文档时间
 * @param {object|null} [parentM] 父链世界矩阵（缺省视为无父/单位矩阵）
 * @returns {{root:{x:number,y:number}, tip:{x:number,y:number}, len:number, width:number}|null}
 */
export function boneWorldEnds(el, time, parentM) {
    if (!el || el.kind !== 'bone') return null;
    const size = elementSize(null, el, time);
    const len = size.w;
    const h = size.h;
    // 骨骼几何是局部 (0, width/2) → (len, width/2)；anchor=(0,0.5) 正好落在这条线上，
    // 所以两个端点直接取 y = width/2 = h * BONE_ANCHOR.y。
    const y = h * 0.5;
    const m = elementWorldMatrix(el, time, { w: len, h }, parentM || null);
    return {
        root: applyMatrix(m, { x: 0, y }),
        tip: applyMatrix(m, { x: len, y }),
        len,
        width: h,
    };
}
