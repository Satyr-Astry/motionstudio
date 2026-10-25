/**
 * 导入落库的合并规则（纯函数，node 里可直跑）。
 *
 * 为什么需要它：`pickAndImport` 要把**调用时刻的文档快照**交进去（新对象排在已有对象
 * 前面，还要按快照算居中），而文件对话框是异步的。对话框是窗口模态时快照一定还有效；
 * 一旦换成非模态对话框、拖拽导入，或者导入期间发生静默回填，快照就过期了 ——
 * 直接用它整体替换会把用户这段时间的改动一起抹掉。
 *
 * 所以：快照与当前文档是同一个对象时走原来的整体替换（行为零变化）；
 * 不是同一个对象时只把**当前文档还没有的对象**并到最前面，其它字段一律用当前文档的。
 */

/**
 * 把 `next` 里「当前文档还没有的对象」并进 `cur`，保留 `cur` 的其余一切。
 * @param {object|null} cur 当前文档
 * @param {object|null} next 基于旧快照拼出来的导入结果
 * @returns {object|null} 新文档；没有新对象时原样返回 `cur`（避免制造一次空 setDoc）
 */
export function mergeImportedDoc(cur, next) {
    if (!cur || typeof cur !== 'object') return next;
    if (!next || typeof next !== 'object') return cur;
    // 文档的容器字段：新模型 objects，旧模型 layers。以当前文档为准。
    const key = Array.isArray(cur.objects) ? 'objects' : Array.isArray(cur.layers) ? 'layers' : Array.isArray(next.objects) ? 'objects' : 'layers';
    const curList = Array.isArray(cur[key]) ? cur[key] : [];
    const nextList = Array.isArray(next[key]) ? next[key] : [];
    const have = new Set();
    for (const o of curList) if (o && o.id != null) have.add(String(o.id));
    const fresh = nextList.filter((o) => o && (o.id == null || !have.has(String(o.id))));
    if (!fresh.length) return cur;
    return { ...cur, [key]: fresh.concat(curList) };
}

/**
 * 导入结果该不该整体替换当前文档。
 * 只有「快照就是当前文档」这一种情况可以整体替换 —— 那是导入前就在的路径，行为不变。
 * @param {object|null} cur 当前文档
 * @param {object|null} snapshot 调用导入时抓的快照
 */
export function canReplaceDoc(cur, snapshot) {
    return !!cur && !!snapshot && cur === snapshot;
}
