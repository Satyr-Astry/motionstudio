/**
 * 选择模型（纯函数，零依赖、零 DOM —— 可以在 node 里直跑测试）
 *
 * ⚠️ 纯函数模块：**别在这里 import DOM、别碰 `document`/`window`**。
 *    时间轴与曲线的键盘注册都放在各自编辑器里（那里有 `hasDom` 守卫）；
 *    本文件被 `tests/selection.test.mjs` 与两个编辑器的纯逻辑测试直接 import，
 *    一旦出现 `document.addEventListener` 就会在 node 里炸掉整条测试链。
 *
 * 唯一入口：时间轴、曲线、叠放面板、父子面板都调这里，不许各处自己写 if(shiftKey)。
 *
 * ── 键盘语义（Blender 式）──────────────────────────────────────────────
 *   单击            只选它（清空其它），并成为主选中
 *   Shift+点        累加；点在已选中的上面则「移出」（toggle）
 *   Ctrl/Cmd+点     与 Shift+点 同效（累加/移出）
 *   Shift+Alt+点    从锚点连选（**不是**累加！这是连选区间的唯一入口，
 *                   别跟上面的 Shift+点 混 —— 两者只差一个 Alt）
 *   非左键          忽略（返回 'ignore'，调用方直接 return）
 *
 * ── 主选中（anchor）────────────────────────────────────────────────────
 *   主选中 = 最后点的那一颗。`A` 全选 / `Ctrl+I` 反选之后主选中**保持不动**；
 *   若主选中被反选掉了，调用方用 `nextAnchor()` 退到集合里「时间/顺序最早」的一个。
 *   点空白清空选择时主选中一起清。
 *
 * 这些函数不读全局、不碰 DOM，也不认识「关键帧」或「图层」——只认 id 字符串，
 * 所以时间轴的关键帧（id 由 layerId+t 合成）与对象行（id = 对象 id）共用同一套。
 */

/** 左键判定：只有左键能改选择。 */
export function isPrimaryButton(e) {
    return !e || e.button == null || e.button === 0;
}

/**
 * 一次点击的意图。
 * @param {{shiftKey?:boolean, ctrlKey?:boolean, metaKey?:boolean, button?:number}} e
 * @param {boolean} isSel 被点的这颗当前是否已在选择集里
 * @returns {'single'|'add'|'remove'|'promote'|'range'|'ignore'}
 *   single  —— 清空其它，只选它（它本来没被选）
 *   promote —— 只把主选中挪到它，选择集不变（它本来已被选）
 *   add     —— 加进选择集
 *   remove  —— 从选择集移出
 *   range   —— 从锚点连选到它（Shift+Alt）
 *   ignore  —— 不是左键，调用方什么都不做
 */
export function clickIntent(e, isSel) {
    if (!isPrimaryButton(e)) return 'ignore';
    const shift = !!(e && e.shiftKey);
    const alt = !!(e && e.altKey);
    const mod = shift || !!(e && (e.ctrlKey || e.metaKey));
    // Shift+Alt 是连选，必须先于「累加」判定 —— 否则 Alt 会被吞掉
    if (shift && alt) return 'range';
    if (mod) return isSel ? 'remove' : 'add';
    return isSel ? 'promote' : 'single';
}

/**
 * 连选：从 anchorId 到 targetId 之间的所有 id（含两端），按 ids 的现有顺序。
 * 任一端不在 ids 里（或两者相同时）退化成只含 target 的数组。
 * @param {string[]} ids 全集，顺序即显示顺序
 */
export function rangeBetween(ids, anchorId, targetId) {
    const all = Array.isArray(ids) ? ids : [];
    const t = all.indexOf(String(targetId));
    if (t < 0) return [];
    const a = all.indexOf(String(anchorId));
    if (a < 0 || a === t) return [all[t]];
    const lo = Math.min(a, t);
    const hi = Math.max(a, t);
    return all.slice(lo, hi + 1);
}

/** 反选：all 里不在 sel 的那些。保持 all 的顺序。 */
export function invertSet(all, sel) {
    const chosen = new Set((Array.isArray(sel) ? sel : []).map(String));
    return (Array.isArray(all) ? all : []).filter((id) => !chosen.has(String(id)));
}

/** toggle：有则删、无则加（保持插入顺序）。返回新数组。 */
export function toggleIn(list, id) {
    const out = (Array.isArray(list) ? list : []).slice();
    const at = out.indexOf(String(id));
    if (at >= 0) out.splice(at, 1);
    else out.push(String(id));
    return out;
}

/**
 * 主选中退位：当前 anchor 不在选择集里时，退到 sel 中最靠前的一个（「最早」）。
 * 选择集为空时返回 null。
 */
export function nextAnchor(sel) {
    const list = Array.isArray(sel) ? sel : [];
    return list.length ? String(list[0]) : null;
}

/**
 * 有序集合里把选择窗口整体平移一格（键盘左右 / 上下移动选择用）。
 * dir < 0 往序列头挪，dir > 0 往尾挪；贴边时原样返回（不越界、不循环）。
 * @returns {string[]} 新的选择集（保持与 all 同序）
 */
export function moveInSelection(all, sel, dir) {
    const ids = Array.isArray(all) ? all : [];
    const chosen = (Array.isArray(sel) ? sel : []).map(String);
    if (!ids.length || !chosen.length) return [];
    const step = dir < 0 ? -1 : 1;
    // 窗口边界撞到序列头/尾就原地不动，避免「选择被吃掉」
    const firstAt = ids.indexOf(chosen[0]);
    const lastAt = ids.indexOf(chosen[chosen.length - 1]);
    if (firstAt < 0 || lastAt < 0) return [];
    if (step < 0 && firstAt === 0) return chosen;
    if (step > 0 && lastAt === ids.length - 1) return chosen;
    return ids.slice(firstAt + step, lastAt + step + 1);
}

/**
 * 清理选择集：丢掉已经不在 all 里的 id（对象被删、关键帧被删后调用）。
 * 保持 sel 原顺序。
 */
export function pruneSelection(all, sel) {
    const live = new Set((Array.isArray(all) ? all : []).map(String));
    return (Array.isArray(sel) ? sel : []).map(String).filter((id) => live.has(id));
}
