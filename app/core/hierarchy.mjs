/**
 * 层级（父子）—— 「跟谁动」的唯一真源是 `object.parentId`。
 *
 * 与叠放（`drawOrder.mjs`，「谁盖谁」）分开：改层级不动叠放、改叠放不动层级。
 * 环检测/子树收集的规范实现在 `timegraph.mjs`，展示序与脏数据修复在这里。
 * 纯函数、零 DOM。
 */

import { parentChainOf as chainOf } from './doc-model.mjs';
import { collectSubtree as collectOf, isDescendant as descendantOf } from './timegraph.mjs';

/** 对象列表（不 import doc-model 的 objectsOf，避免与它的反向依赖纠缠）。 */
function listOf(doc) {
    if (!doc || typeof doc !== 'object') return [];
    if (Array.isArray(doc.objects)) return doc.objects.filter(Boolean);
    if (Array.isArray(doc.layers)) return doc.layers.filter(Boolean);
    return [];
}

function idOf(v) {
    if (v && typeof v === 'object') return v.id == null ? '' : String(v.id);
    return v == null ? '' : String(v);
}

/** 沿父链往上（含自己，自己在前）。规范实现在 `doc-model.parentChainOf`。 */
export function parentChainOf(doc, obj) {
    return chainOf(doc, obj);
}

/** 整棵子树（含自己），规范实现 `timegraph.collectSubtree`。 */
export function collectSubtree(doc, id) {
    return collectOf(doc, id);
}

/**
 * maybeChild 是否是 maybeAncestor 的后代。
 *
 * 规范实现 `timegraph.isDescendant` 吃的是**对象**（内部读 `.id`），这里额外允许传 id ——
 * 面板与拖拽手里常常只有 id，多包一层比让调用方自己 `objectById` 更省事。
 * 找不到对象一律 false（不猜）。
 */
export function isDescendant(doc, maybeChild, maybeAncestor) {
    const byId = (v) => {
        if (v && typeof v === 'object') return v;
        const key = v == null ? '' : String(v);
        if (!key) return null;
        return listOf(doc).find((o) => idOf(o) === key) || null;
    };
    const child = byId(maybeChild);
    const ancestor = byId(maybeAncestor);
    if (!child || !ancestor) return false;
    return descendantOf(doc, child, ancestor);
}

/**
 * 树形展示序：先根（按 `drawOrder` 定同级先后），再其子树，深度优先。
 *
 * 为什么要 drawOrder 参与：同级之间没有「兄弟序号」字段，用叠放顺序当同级先后，
 * 用户在「对象」面板看到的上下关系与画布上的前后关系一致，不会两套排序打架。
 * @returns {Array<{ id: string, obj: object, depth: number, parentId: string|null }>}
 */
export function treeOrder(doc) {
    const list = listOf(doc);
    const byId = new Map();
    for (const o of list) byId.set(idOf(o), o);
    const order = Array.isArray(doc && doc.drawOrder) && doc.drawOrder.length
        ? doc.drawOrder.map(idOf)
        : list.map(idOf);
    const rank = new Map();
    order.forEach((id, i) => rank.set(id, i));
    const rankOf = (id) => (rank.has(id) ? rank.get(id) : Number.MAX_SAFE_INTEGER);

    const kids = new Map();
    for (const o of list) {
        const pid = o && o.parentId != null && byId.has(idOf(o.parentId)) ? idOf(o.parentId) : '';
        if (!kids.has(pid)) kids.set(pid, []);
        kids.get(pid).push(o);
    }
    for (const arr of kids.values()) {
        arr.sort((a, b) => rankOf(idOf(a)) - rankOf(idOf(b)));
    }

    const out = [];
    const seen = new Set();
    const walk = (pid, depth) => {
        for (const o of kids.get(pid) || []) {
            const id = idOf(o);
            if (seen.has(id)) continue;
            seen.add(id);
            out.push({ id, obj: o, depth, parentId: pid || null });
            walk(id, depth + 1);
        }
    };
    walk('', 0);
    // 环/孤儿的兜底：扫一遍没被走到的，按叠放顺序补到末尾（深度 0）
    for (const o of list) {
        const id = idOf(o);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, obj: o, depth: 0, parentId: null });
    }
    return out;
}

/**
 * 修脏：父指向不存在的 id、自指、或父链成环 → 该对象升为根。
 * 等幂、单向、不改入参。返回新数组（没有脏数据时返回原数组引用）。
 */
export function normalizeParents(objects) {
    const src = Array.isArray(objects) ? objects : [];
    // 全是有效元素时复用入参数组（否则 `filter` 每次都会造新数组，
    // 调用方就没法用引用相等判断「这次有没有改动」）。
    const list = src.every(Boolean) ? src : src.filter(Boolean);
    const byId = new Map();
    for (const o of list) byId.set(idOf(o), o);

    const isBad = (o) => {
        const pid = o && o.parentId != null ? idOf(o.parentId) : '';
        if (!pid) return false;
        if (pid === idOf(o)) return true;          // 自指
        if (!byId.has(pid)) return true;           // 父不存在（被删掉/存档写坏）
        // 沿父链上溯：遇到自己就说明成环
        const seen = new Set([idOf(o)]);
        let cur = byId.get(pid);
        while (cur) {
            const cid = idOf(cur);
            if (seen.has(cid)) return true;
            seen.add(cid);
            const up = cur.parentId != null ? idOf(cur.parentId) : '';
            cur = up ? byId.get(up) : null;
        }
        return false;
    };

    let changed = false;
    const out = list.map((o) => {
        if (!isBad(o)) return o;
        changed = true;
        return Object.assign({}, o, { parentId: undefined });
    });
    return changed ? out : list;
}
