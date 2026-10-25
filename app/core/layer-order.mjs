/**
 * 层级键盘操作的纯计算（零 DOM、零文档副作用）。
 *
 * 约定来自现有模型（`app/core/doc-model.mjs`）：
 * - `doc.objects` 是**扁平数组**，下标 0 = 最上层（顺序即绘制顺序）；
 * - 父子关系靠 `parentId` 指针，根对象的 `parentId` 是 `undefined`（本模块统一归一成 `null`）；
 * - 子对象必须排在父之后且连续（L3 的「父在子前」约定）。
 *
 * 本模块只回答「目标父级 + 目标全局下标」，真正的文档变更由调用方执行：
 * 先 `setParentDoc`（改 parentId），再 `reorderObject`（改顺序），两步都在 `ctx` 里。
 * 这样键盘操作和拖拽可以共用同一条落点语义，也便于在 node 里直接测。
 */

/** 归一化父级：`undefined` 与 `''` 都当根层。 */
function normPid(pid) {
    return pid == null || pid === '' ? null : String(pid);
}

function objectsList(objects) {
    return Array.isArray(objects) ? objects.filter((o) => o && o.id != null) : [];
}

/** 同一父级下的兄弟（保持数组顺序 = 绘制顺序）。 */
export function siblingsOf(objects, parentId) {
    const pid = normPid(parentId);
    return objectsList(objects).filter((o) => normPid(o.parentId) === pid);
}

/**
 * 子树（含自身）在全局数组里的最后一个下标。
 * 子对象连续排在父之后，所以从自身往后扫到第一个「不是后代」为止。
 * 找不到 id 时返回 -1。
 */
export function subtreeEndIndex(objects, id) {
    const list = objectsList(objects);
    const start = list.findIndex((o) => o.id === id);
    if (start < 0) return -1;
    const byId = new Map(list.map((o) => [o.id, o]));
    const isDescendant = (obj) => {
        let pid = normPid(obj.parentId);
        // 手改存档可能出现环，用步数上限兜住（环由 setParent 拦，这里只防死循环）
        for (let guard = 0; pid != null && guard < 64; guard++) {
            if (pid === id) return true;
            const parent = byId.get(pid);
            if (!parent) return false;
            pid = normPid(parent.parentId);
        }
        return false;
    };
    let end = start;
    for (let i = start + 1; i < list.length; i++) {
        if (!isDescendant(list[i])) break;
        end = i;
    }
    return end;
}

/**
 * 同级上移/下移：只在兄弟之间换位，不跨父级。
 * @param {number} dir -1 = 上移（更靠上层），+1 = 下移
 * @returns {{parentId: string|null, index: number}|null} 目标（null = 不可移动）
 */
export function siblingMoveTarget(objects, id, dir) {
    const list = objectsList(objects);
    const self = list.findIndex((o) => o.id === id);
    if (self < 0) return null;
    const pid = normPid(list[self].parentId);
    const sibs = siblingsOf(list, pid);
    const k = sibs.findIndex((o) => o.id === id);
    if (k < 0) return null;
    const j = k + (dir < 0 ? -1 : 1);
    if (j < 0 || j >= sibs.length) return null;
    const target = list.findIndex((o) => o.id === sibs[j].id);
    if (target < 0) return null;
    return { parentId: pid, index: target };
}

/**
 * 降级：成为「前一个兄弟」的最后一个子对象。
 * 首兄弟没有前一个兄弟 → 不可降级（返回 null）。
 * @returns {{parentId: string, index: number}|null}
 */
export function demoteTarget(objects, id) {
    const list = objectsList(objects);
    const self = list.findIndex((o) => o.id === id);
    if (self < 0) return null;
    const pid = normPid(list[self].parentId);
    const sibs = siblingsOf(list, pid);
    const k = sibs.findIndex((o) => o.id === id);
    if (k <= 0) return null;
    const prev = sibs[k - 1];
    const end = subtreeEndIndex(list, prev.id);
    if (end < 0) return null;
    return { parentId: prev.id, index: end + 1 };
}

/**
 * 升级：成为父的兄弟，紧插在父之后（即父的第一个位置，父的其它子对象排在它后面）。
 * 已经在根层 → 不可升级（返回 null）。
 * @returns {{parentId: string|null, index: number}|null}
 */
export function promoteTarget(objects, id) {
    const list = objectsList(objects);
    const self = list.findIndex((o) => o.id === id);
    if (self < 0) return null;
    const pid = normPid(list[self].parentId);
    if (pid == null) return null;
    const parentIndex = list.findIndex((o) => o.id === pid);
    if (parentIndex < 0) return null;
    const grandPid = normPid(list[parentIndex].parentId);
    return { parentId: grandPid, index: parentIndex + 1 };
}

/**
 * 键盘方向 → 目标（接线层只认这一个入口）。
 *
 * 方向按「在树上走」的直觉定：**→ 往里（缩进成子对象），← 往外（提升为父的兄弟）**。
 * 注意这与本文件 `demoteTarget`/`promoteTarget` 的命名顺序相反 —— 那是数据侧的名字，
 * 照字面把 demote 挂到 left 上会接反（曾经接反一次，真机读数抓住）。
 */
export function layerKeyTarget(objects, id, key) {
    switch (key) {
    case 'up':
        return siblingMoveTarget(objects, id, -1);
    case 'down':
        return siblingMoveTarget(objects, id, 1);
    case 'right':
        return demoteTarget(objects, id);
    case 'left':
        return promoteTarget(objects, id);
    default:
        return null;
    }
}

/** 键盘事件 → 方向名；不是层级键时返回 null（接线层据此决定是否 preventDefault）。 */
export function layerKeyFromEvent(e) {
    if (!e || !e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
    switch (e.key) {
    case 'ArrowUp':
        return 'up';
    case 'ArrowDown':
        return 'down';
    case 'ArrowLeft':
        return 'left';
    case 'ArrowRight':
        return 'right';
    default:
        return null;
    }
}
