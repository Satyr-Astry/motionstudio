/**
 * 叠放顺序（drawOrder）——「谁盖谁」的唯一真源。
 *
 * 为什么单独一个模块：层级（parentId，「跟谁动」）与叠放（drawOrder，「谁盖谁」）
 * 是两个独立事实，Spine 的骨骼树 vs Slots 绘制列表、Toon Boom 的 Node 视图 vs Timeline
 * 都是这么分的（见 docs/层级与叠放-2026-10.md §0）。以前叠放靠 `doc.objects` 的下标
 * 表达，于是「挪父对象」必然打散子树；拆开之后两件事互不代偿。
 *
 * 约定：
 *   - `drawOrder[0]` 是**最上层**（最后画的那个），渲染从数组尾往头画。
 *   - id 集合必须与 `doc.objects` 恒等；缺字段/有脏 id 时由 `normalizeDrawOrder` 修一次。
 *   - 本模块纯函数、零 DOM，可 node 直跑。
 */

/**
 * 本模块**不 import doc-model**：doc-model 反过来要用 `normalizeDrawOrder`
 * （新建/删除对象时维护叠放表），互相 import 会成环。这里只按两种已知形状取数组，
 * 与 `objectsOf` 的语义一致（`objects` 优先，老字段 `layers` 兜底）。
 */
function objectsOfLocal(doc) {
    if (!doc || typeof doc !== 'object') return [];
    if (Array.isArray(doc.objects)) return doc.objects;
    if (Array.isArray(doc.layers)) return doc.layers;
    return [];
}

/** 把任意输入规整成字符串 id。 */
function idOf(v) {
    if (v && typeof v === 'object') return v.id == null ? '' : String(v.id);
    return v == null ? '' : String(v);
}

/**
 * 让 order 与 objects 对齐：丢掉未知 id 与重复项，补齐缺失项（补在末尾）。
 *
 * 幂等：`normalizeDrawOrder(objs, normalizeDrawOrder(objs, x))` 恒等于一次的结果。
 * @param {Array} objects 对象数组（`doc.objects`）
 * @param {Array|null|undefined} order 现有顺序（可为 null / 非数组 / 含脏值）
 * @returns {string[]} 规整后的 id 数组
 */
export function normalizeDrawOrder(objects, order) {
    const list = Array.isArray(objects) ? objects.filter(Boolean) : [];
    const alive = new Set();
    for (const o of list) {
        const id = idOf(o);
        if (id) alive.add(id);
    }
    const out = [];
    const seen = new Set();
    if (Array.isArray(order)) {
        for (const raw of order) {
            const id = idOf(raw);
            if (!id || !alive.has(id) || seen.has(id)) continue;
            seen.add(id);
            out.push(id);
        }
    }
    for (const o of list) {
        const id = idOf(o);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        // 老文档没有 drawOrder 时，用 objects 现有顺序派生（等价于旧行为）
        out.push(id);
    }
    return out;
}

/** 取文档的叠放顺序；缺字段或脏时现算（不改 doc）。 */
export function drawOrderOf(doc) {
    if (!doc) return [];
    return normalizeDrawOrder(objectsOfLocal(doc), doc.drawOrder);
}

/** 某个对象在第几层（0 = 最上层）；找不到 -1。 */
export function orderIndex(doc, id) {
    const key = idOf(id);
    if (!key) return -1;
    return drawOrderOf(doc).indexOf(key);
}

/** 把 id 移到 index（越界钳住）。返回新数组，不改入参。 */
export function moveInOrder(order, id, index) {
    const list = Array.isArray(order) ? order.slice() : [];
    const key = idOf(id);
    const from = list.indexOf(key);
    if (from < 0) return list;
    const to = Math.max(0, Math.min(list.length - 1, Math.round(Number(index)) || 0));
    if (to === from) return list;
    list.splice(from, 1);
    list.splice(to, 0, key);
    return list;
}

/** 插入 id（已存在则先摘掉再插）。返回新数组。 */
export function insertInOrder(order, id, index) {
    const list = (Array.isArray(order) ? order : []).filter((x) => x !== idOf(id));
    const key = idOf(id);
    if (!key) return list;
    const at = Math.max(0, Math.min(list.length, Math.round(Number(index)) || 0));
    list.splice(at, 0, key);
    return list;
}

/** 移除 id。返回新数组。 */
export function removeFromOrder(order, id) {
    const key = idOf(id);
    return (Array.isArray(order) ? order : []).filter((x) => x !== key);
}
