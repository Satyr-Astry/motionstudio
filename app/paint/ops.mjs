/**
 * Kleks Motion —— 对象级文档操作（位图相关）
 *
 * core/cel.mjs 管结构与时间，这里管「像素怎么搬」：复制对象、向下合并。
 * 全部是纯函数式：返回新 doc，不改入参。
 * v6：画格由 at（秒）定位，没有帧序号 —— 合并时按两边切换点的并集逐一烘焙。
 */

import { celAt, objectsOf, makeObject, patchObject, patchLayer, setImageAt } from '../core/cel.mjs';
import { createSurface, cloneSurface } from './surface.mjs';

function newId(doc, base) {
    let n = 1;
    const used = new Set(objectsOf(doc).map((l) => l && l.id));
    while (used.has(base + n)) n++;
    return base + n;
}

/** 两个对象画格切换点的并集（升序去重）：合并要覆盖任一边发生变化的所有时刻。 */
function unionTimes(a, b) {
    const set = new Set();
    for (const obj of [a, b]) {
        for (const c of (obj && obj.cels) || []) {
            if (c && Number.isFinite(c.at)) set.add(c.at);
        }
    }
    return Array.from(set).sort((x, y) => x - y);
}

/** 在 layerId 之上复制一层（内容与所有画格位图都深拷贝，at 原样保留）。 */
export function duplicateLayer(doc, layerId) {
    if (!doc) return doc;
    const list = objectsOf(doc);
    const i = list.findIndex((l) => l && l.id === layerId);
    if (i < 0) return doc;
    const src = list[i];
    const cels = (Array.isArray(src.cels) ? src.cels : []).map((c) => ({
        at: c.at,
        image: c.image ? cloneSurface(c.image) : null,
    }));
    const layer = makeObject(Object.assign({}, src, {
        id: newId(doc, 'L'),
        name: (src.name || '对象') + ' 副本',
        cels,
        transform: src.transform ? JSON.parse(JSON.stringify(src.transform)) : src.transform,
    }));
    const objects = list.slice();
    objects.splice(i, 0, layer);
    return Object.assign({}, doc, { objects });
}

/**
 * 向下合并：把 layerId 的像素叠到它下面一层，然后删掉上层。
 * `doc.objects[0]` 是最上层，所以「下面一层」是 index + 1。
 */
export function mergeDown(doc, layerId, opts) {
    if (!doc) return doc;
    const list = objectsOf(doc);
    const i = list.findIndex((l) => l && l.id === layerId);
    if (i < 0 || i + 1 >= list.length) return { doc, error: '最底层无法向下合并' };
    const upper = list[i];
    const lower = list[i + 1];
    const W = Math.max(1, doc.width | 0);
    const H = Math.max(1, doc.height | 0);
    let next = doc;
    for (const at of unionTimes(upper, lower)) {
        const a = celAt(upper, at);
        const b = celAt(lower, at);
        const hasA = a && a.image && a.image.width;
        const hasB = b && b.image && b.image.width;
        if (!hasA && !hasB) continue;
        const out = createSurface(
            hasB ? b.image.width : W,
            hasB ? b.image.height : H,
        );
        const g = out.getContext('2d');
        if (!g) continue;
        g.clearRect(0, 0, out.width, out.height);
        if (hasB) {
            g.globalAlpha = 1;
            g.drawImage(b.image, 0, 0);
        }
        if (hasA) {
            g.globalAlpha = Math.max(0, Math.min(1, a.opacity == null ? 1 : a.opacity));
            g.drawImage(a.image, 0, 0);
        }
        g.globalAlpha = 1;
        // 上层此刻没有像素、下层也没有精确画格 → 合成结果与延用图一致，不必固化。
        if (!hasA && !b) continue;
        next = patchObject(next, lower.id, (o) => setImageAt(o, at, out));
    }
    const objects = objectsOf(next).filter((l) => l && l.id !== upper.id);
    next = Object.assign({}, next, { objects });
    if (opts && opts.opacityCombine !== false) {
        /* 合并后不透明度取下层原值，避免两次相乘变淡 */
    }
    return { doc: patchLayer(next, lower.id, { visible: true }), merged: upper.name };
}
