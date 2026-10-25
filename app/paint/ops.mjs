/**
 * Kleks Motion —— 对象级文档操作（位图相关）
 *
 * core/cel.mjs 管结构与时间，这里管「像素怎么搬」：复制对象、向下合并。
 * 全部是纯函数式：返回新 doc，不改入参。
 * v6：纹理由 at（秒）定位，没有帧序号 —— 合并时按两边切换点的并集逐一烘焙。
 */

import { celAt, celTimes, objectsOf, makeObject, patchObject, patchLayer, setImageAt } from '../core/cel.mjs';
import { createSurface, cloneSurface } from './surface.mjs';
import { createEvaluator, drawEvaluated } from '../core/evaluator.mjs';
import { elementMatrix, elementSize, invertMatrix, mulMatrix } from '../core/element.mjs';
import { drawOrderOf, normalizeDrawOrder } from '../core/draw-order.mjs';
import { collectSubtree } from '../core/timegraph.mjs';

function newId(doc, base) {
    let n = 1;
    const used = new Set(objectsOf(doc).map((l) => l && l.id));
    while (used.has(base + n)) n++;
    return base + n;
}

/** 只留一层的临时文档：让 evaluator 单独求值这一层，别的层不参与这次合成。 */
function singleLayerDoc(doc, layer) {
    return Object.assign({}, doc, { objects: [layer] });
}

/** 一个对象的变换关键帧时刻。 */
function keyTimesOf(obj) {
    const keys = obj && obj.transform && Array.isArray(obj.transform.keys) ? obj.transform.keys : [];
    const out = [];
    for (const k of keys) if (k && Number.isFinite(k.t)) out.push(k.t);
    return out;
}

/**
 * 合并要逐一烘焙的时刻：两边纹理切换点 ∪ 上层的变换关键帧。
 *
 * 下层的变换关键帧**不进**这个集合：下层是画在自己的局部坐标里的，它的变换在写回之后
 * 由 evaluator 照常施加上去，采样时刻与它无关。上层的变换则必须采样 —— 上层对象在合并后
 * 就没了，它的位置/旋转/不透明度只能在这一步烤进像素。
 */
function sampleTimes(upper, lower) {
    const set = new Set();
    for (const t of celTimes(upper)) set.add(t);
    for (const t of celTimes(lower)) set.add(t);
    for (const t of keyTimesOf(upper)) set.add(t);
    if (!set.size) set.add(0);
    return Array.from(set).sort((a, b) => a - b);
}

/**
 * 把 doc 空间搬到下层局部坐标：inv(M下)。
 *
 * 这里**只补下层那一段**。上层自己的矩阵（平移/旋转/缩放/锚点）由 evaluator 的
 * `rec.matrix` 提供，`baseMatrix` 是叠在它外面的（`mulMatrix(o.baseMatrix, rec.matrix)`）；
 * 若这里传 `inv(M下)·M上`，上层的位移就会被算两次。
 */
function lowerInverse(doc, lower, t) {
    return invertMatrix(elementMatrix(lower, t, elementSize(doc, lower, t)));
}

/**
 * 在 layerId 之上复制**整棵子树**（内容与所有纹理位图都深拷贝，at 原样保留）。
 *
 * v10：以前只复制一个对象，复制「父对象」会得到一个没有孩子的空壳。现在按
 * `docs/层级与叠放-2026-10.md` §3 的一致性规则走：子树内部重新映射 parentId，
 * 子树外的父引用原样保留，克隆块插在源对象**当前层之上**（drawOrder 同位）。
 */
export function duplicateLayer(doc, layerId) {
    if (!doc) return doc;
    const list = objectsOf(doc);
    const i = list.findIndex((l) => l && l.id === layerId);
    if (i < 0) return doc;
    const ids = collectSubtree(doc, layerId).filter((id) => list.some((l) => l && l.id === id));
    if (!ids.length) return doc;
    const used = new Set(list.map((l) => l && l.id));
    const map = new Map();
    for (const id of ids) {
        let n = 1;
        while (used.has('L' + n)) n += 1;
        const nid = 'L' + n;
        used.add(nid);
        map.set(String(id), nid);
    }
    const clones = ids.map((id) => {
        const src = list.find((l) => l && l.id === id);
        const pid = src.parentId == null ? undefined
            : (map.has(String(src.parentId)) ? map.get(String(src.parentId)) : src.parentId);
        return makeObject(Object.assign({}, src, {
            id: map.get(String(id)),
            name: (src.name || '对象') + ' 副本',
            parentId: pid,
            cels: (Array.isArray(src.cels) ? src.cels : []).map((c) => ({
                at: c.at,
                image: c.image ? cloneSurface(c.image) : null,
            })),
            transform: src.transform ? JSON.parse(JSON.stringify(src.transform)) : src.transform,
        }));
    });
    const objects = list.slice();
    objects.splice(i, 0, ...clones);
    const order = drawOrderOf(doc);
    const at = Math.max(0, order.indexOf(String(layerId)));
    const drawOrder = normalizeDrawOrder(
        objects,
        order.slice(0, at).concat(clones.map((c) => c.id), order.slice(at)),
    );
    return Object.assign({}, doc, { objects, drawOrder });
}

/**
 * 向下合并：把 layerId 的像素叠到它下面一层，然后删掉上层。
 * `doc.objects[0]` 是最上层，所以「下面一层」是 index + 1。
 *
 * 合成不自己画：两层各交给 evaluator 单层求值（`drawEvaluated`），
 * 于是 alpha 三层相乘、mixMode、filter、anchor、warp 全部与画面上的合成同源。
 * 唯一自己决定的是两件事：**采样哪些时刻**、**上层摆在下层局部坐标的哪里**。
 *
 * 语义边界：写回的图是「下层局部坐标」里的合成结果，所以下层自己的变换会在合并后
 * 整体作用到这张图上（上层像素被一起搬走）。同尺寸同位置的两层不受影响。
 */
export function mergeDown(doc, layerId, opts) {
    if (!doc) return doc;
    const o = opts && typeof opts === 'object' ? opts : {};
    // 测试可以在 node 里注入一个假的画布工厂（node 没有 OffscreenCanvas / document）
    const makeSurface = typeof o.surface === 'function' ? o.surface : createSurface;
    const list = objectsOf(doc);
    const i = list.findIndex((l) => l && l.id === layerId);
    if (i < 0 || i + 1 >= list.length) return { doc, error: '最底层无法向下合并' };
    const upper = list[i];
    const lower = list[i + 1];
    const W = Math.max(1, doc.width | 0);
    const H = Math.max(1, doc.height | 0);
    const upEv = createEvaluator(singleLayerDoc(doc, upper));
    const loEv = createEvaluator(singleLayerDoc(doc, lower));
    let next = doc;
    for (const at of sampleTimes(upper, lower)) {
        const a = celAt(upper, at);
        const b = celAt(lower, at);
        const hasA = a && a.image && a.image.width;
        const hasB = b && b.image && b.image.width;
        if (!hasA && !hasB) continue;
        const out = makeSurface(
            hasB ? b.image.width : W,
            hasB ? b.image.height : H,
        );
        const g = out.getContext('2d');
        if (!g) continue;
        g.clearRect(0, 0, out.width, out.height);
        // 下层：画在它自己的局部坐标里，alpha 只算到「层 × 纹理」这一级 ——
        // 它的 state.opacity 会在写回之后由 evaluator 再乘一次，这里乘就会淡两次。
        if (hasB) drawEvaluated(g, loEv, at, { ignoreTransform: true, force: true, onlyVisible: false });
        // 上层：搬到下层局部坐标后按完整语义合成（含 state.opacity）。
        if (hasA) {
            const base = lowerInverse(doc, lower, at);
            if (base) drawEvaluated(g, upEv, at, { baseMatrix: base, force: true, onlyVisible: false });
        }
        g.globalAlpha = 1;
        // 上层此刻没有像素、下层也没有精确纹理 → 合成结果与延用图一致，不必固化。
        if (!hasA && !b) continue;
        next = patchObject(next, lower.id, (layer) => setImageAt(layer, at, out));
    }
    const objects = objectsOf(next).filter((l) => l && l.id !== upper.id);
    // v10：叠放表要跟着摘掉上层；下层的层号保持不动（合并结果落在下层身上）。
    const drawOrder = normalizeDrawOrder(objects, drawOrderOf(next));
    next = Object.assign({}, next, { objects, drawOrder });
    return { doc: patchLayer(next, lower.id, { visible: true }), merged: upper.name };
}
