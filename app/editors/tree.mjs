// 父子树面板（编辑器 id: tree）：编辑 parentId（跟谁动），行序按 drawOrder 展示。
// 契约：docs/层级与叠放-2026-10.md §5 —— 拖拽三区（上缘 before / 中间 into / 下缘 after），
// 全走 ctx.moveSubtree（一次 setDoc、一条撤销）；拖到空白 = 脱父并排到最底（rootEnd）。
// 叠放顺序的真源是 doc.drawOrder：layers 面板直接拖它；这里的行序也按它排，所以三区拖拽
// 会连带把子树块在 drawOrder 里一起搬（core/timegraph.moveSubtreeDoc），否则「拖了没反应」。

import { treeOrder, isDescendant } from '../core/hierarchy.mjs';
import { treeZone } from '../core/layer-order.mjs';
import { objectsOf } from '../core/cel.mjs';
import { icon } from '../core/icons.mjs';
import { clickIntent, rangeBetween } from '../core/selection.mjs';
import { skinOf } from '../core/skin.mjs';
import { t } from '../i18n/index.mjs';

const INDENT = 12;                       // 每级缩进（契约 §5：12px/级）
const MAX_DEPTH = 64;                    // 与 core/timegraph 的 MAX_DEPTH 同值，防脏数据成环
const STORE_KEY = 'ms.tree.collapsed';   // 折叠态只影响面板显示，不进文档

let collapsed = new Set();
try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    if (Array.isArray(raw)) collapsed = new Set(raw.filter((x) => typeof x === 'string'));
} catch (err) {
    collapsed = new Set();
}
function saveCollapsed() {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify([...collapsed]));
    } catch (err) {
        /* 存不进去只影响下次启动的展开状态，不该打断交互 */
    }
}

let dragId = null;     // 正在拖的对象 id
let dropWhere = null;   // 当前悬停的落点：before / into / after

const objById = (doc, id) => (doc && Array.isArray(doc.objects) ? doc.objects.find((o) => o && o.id === id) || null : null);

/**
 * 父链硬约束：**带蒙皮的对象不许把骨骼当父级**。
 *
 * 为什么是这条规则：皮肤求值已经把骨骼的世界矩阵算进顶点偏移（skin.mjs 的
 * `now · bind⁻¹`），父级再挂到骨骼上就是同一份变换算两遍 —— 画布上会看到皮肤按两倍
 * 距离漂走，而且帧一变就抖。骨骼自己的父级可以是骨骼（骨链是正常结构），
 * 非蒙皮对象挂到骨骼下面也没问题（纯层级跟随，没有第二份变换）。
 *
 * 为什么落在 tree.mjs：面板里改父只有一个入口 —— 行内拖拽（`drop` 处理里，三区落点全走
 * `ctx.moveSubtree`）。原先还有一条「老接口降级」分支去调 `ctx.setParent`，但 ctx 上从来
 * 没有这个方法（真正叫 `setLayerParent`），分支永远 return，是假的兜底；本批把它删了。
 * 而 ctx-time.mjs 的 setLayerParent / moveSubtree 是别人刚清干净的地盘，不在本批范围。
 * 判定放在 core 之外是刻意的：core 只认「结构与矩阵」，不认「谁被蒙皮了」这种编辑期约定。
 */
export function parentBlocked(doc, movedId, targetId) {
    if (!doc || !movedId || !targetId || movedId === targetId) return false;
    const target = objById(doc, targetId);
    if (!target || target.kind !== 'bone') return false;
    const moved = objById(doc, movedId);
    return !!(moved && skinOf(moved));
}

export function mount(el, ctx) {
    const root = document.createElement('div');
    root.className = 'tree';

    const list = document.createElement('div');
    list.className = 'tree-list';
    root.appendChild(list);

    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = t('tree.empty');
    root.appendChild(empty);

    const activeId = () => (typeof ctx.activeLayerId === 'function' ? ctx.activeLayerId() : null);
    const notify = (msg) => { if (typeof ctx.notify === 'function') ctx.notify(msg); };

    /** 清掉所有落点标记（行内三态 + 空白态）。dragover 每帧都来，改 class 比重建便宜。 */
    function clearDropMarks() {
        list.querySelectorAll('.is-drop, .drop-before, .drop-after, .drop-invalid').forEach((n) => {
            n.classList.remove('is-drop', 'drop-before', 'drop-after', 'drop-invalid');
        });
        dropWhere = null;
        list.classList.remove('is-drop-blank');
    }

    /** 折叠：任一祖先被折叠，这一行就不画。返回 null 表示可见。 */
    function hiddenByCollapse(layer, byId) {
        let pid = layer.parentId;
        let guard = 0;
        while (pid && guard++ < MAX_DEPTH) {
            if (collapsed.has(pid)) return true;
            const par = byId.get(pid);
            pid = par ? par.parentId : null;
        }
        return false;
    }

    /** 父链提示：给 title 用，让「它属于谁」在不展开时也读得到。 */
    function chainText(layer, byId) {
        const names = [];
        let pid = layer.parentId;
        let guard = 0;
        while (pid && guard++ < MAX_DEPTH) {
            const par = byId.get(pid);
            if (!par) break;
            names.unshift(par.name || par.id);
            pid = par.parentId;
        }
        return names.length ? names.join(' › ') : '';
    }

    /** 当前多选集合（内存层，与叠放面板共用）。没有该接口时退化成空数组。 */
    function selIds() {
        if (typeof ctx.selectedLayers !== 'function') return [];
        const v = ctx.selectedLayers();
        return Array.isArray(v) ? v.map(String) : [];
    }

    /** 连选锚点：最后一次「单击」落下的一行；Shift+Alt 范围选择从这里量起。 */
    let anchorId = null;
    /** 这次拖拽是不是多选块：父子关系一次只能改一个对象，多选只提示、不动数据。 */
    let dragMulti = false;

    /** 行选择：单击独占、Shift/Ctrl 累加或移出、Shift+Alt 从锚点连选。 */
    function select(id, ev) {
        // 连选区间按**显示行序**算：rangeBetween 的约定就是「顺序即显示顺序」，
        // 而这份显示序是 treeOrder（DFS + 同级按 drawOrder），不是 objects 数组序
        const order = treeOrder(ctx.doc() || {}).map((r) => r.obj.id);
        const sels = selIds();
        const intent = clickIntent(ev, sels.includes(id));
        if (intent === 'ignore') return;
        let next = sels;
        if (intent === 'single' || intent === 'promote') next = [id];
        else if (intent === 'add') next = sels.concat([id]);
        else if (intent === 'remove') next = sels.filter((x) => x !== id);
        else if (intent === 'range') next = rangeBetween(order, anchorId || id, id);
        if (intent === 'single' || intent === 'promote' || intent === 'range') anchorId = id;
        if (typeof ctx.setLayerSelection === 'function') ctx.setLayerSelection(next);
        if (typeof ctx.setSelection === 'function') ctx.setSelection({ id });
        // 主键写在 setLayerSelection 之后，免得被它回退到集合首位
        if (typeof ctx.setActiveLayer === 'function') ctx.setActiveLayer(id);
    }

    function makeRow(layer, depth, kidCount, byId) {
        const row = document.createElement('div');
        row.className = 'tree-row';
        row.dataset.id = layer.id;
        row.draggable = true;
        row.style.paddingLeft = 6 + Math.min(MAX_DEPTH, Math.max(0, depth)) * INDENT + 'px';
        if (layer.id === activeId()) row.classList.add('is-active');
        if (selIds().includes(layer.id)) row.classList.add('is-sel');

        // 折叠箭头：只有「有子对象」的行才有，点它只切显示，不改文档
        if (kidCount > 0) {
            const caret = document.createElement('button');
            caret.type = 'button';
            caret.className = 'tree-caret ms-icon-btn';
            const isCollapsed = collapsed.has(layer.id);
            caret.innerHTML = icon(isCollapsed ? 'chevron-right' : 'chevron-down');
            caret.title = isCollapsed ? t('tree.caret.expand') : t('tree.caret.collapse');
            caret.setAttribute('aria-label', caret.title);
            caret.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
            caret.addEventListener('click', (e) => {
                e.stopPropagation();
                // Alt+点箭头：把祖先链一起合上 —— 从深树里一次收干净
                if (e.altKey) {
                    let pid = layer.parentId;
                    let guard = 0;
                    while (pid && guard++ < MAX_DEPTH) {
                        collapsed.add(pid);
                        const par = byId.get(pid);
                        pid = par ? par.parentId : null;
                    }
                }
                if (collapsed.has(layer.id)) collapsed.delete(layer.id);
                else collapsed.add(layer.id);
                saveCollapsed();
                paint();
            });
            row.appendChild(caret);
        } else {
            const pad = document.createElement('span');
            pad.className = 'tree-caret-pad';
            row.appendChild(pad);
        }

        const name = document.createElement('span');
        name.className = 'tree-name';
        name.textContent = layer.name || layer.id;
        row.appendChild(name);

        // 「N 个子对象」：只在这里显示（叠放列表不需要，那边是扁平序）
        if (kidCount > 0) {
            const pill = document.createElement('span');
            pill.className = 'tree-kids';
            pill.textContent = String(kidCount);
            pill.title = t('tree.kids', { n: kidCount });
            pill.setAttribute('aria-label', pill.title);
            row.appendChild(pill);
        }

        const chain = chainText(layer, byId);
        const rowName = layer.name || layer.id;
        row.title = chain ? t('tree.row.withChain', { name: rowName, chain }) : t('tree.row.top', { name: rowName });

        row.addEventListener('click', (e) => select(layer.id, e));

        // ── 拖拽：三区落点（Blender Outliner 手感）
        // 上缘 25% = 插到它上面（成为同一父级的兄弟）、下缘 25% = 插到下面、中间 50% = 成为它的子对象。
        // 落点非法时（拖进自己的子孙、拖到自身）只标红不拦事件 —— 指针不动，用户能自己看出来。
        row.addEventListener('dragstart', (e) => {
            dragId = layer.id;
            const sels = selIds();
            dragMulti = sels.length > 1 && sels.includes(layer.id);
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
                try { e.dataTransfer.setData('text/plain', layer.id); } catch (err) { /* 老浏览器忽略 */ }
            }
        });
        row.addEventListener('dragend', () => {
            dragId = null;
            clearDropMarks();
        });
        row.addEventListener('dragover', (e) => {
            if (!dragId || dragId === layer.id) return;
            // 任何落点都不能进自己的子树（before/after 也一样：整棵子树搬到自己里面没有意义）
            // core 的 isDescendant 对「自身」返回 false —— 上面已先返回，这里只管真后代
            if (isDescendant(ctx.doc(), layer.id, dragId)) {
                clearDropMarks();
                row.classList.add('drop-invalid');
                return;
            }
            const r = row.getBoundingClientRect();
            const ratio = r.height > 0 ? (e.clientY - r.top) / r.height : 0.5;
            const where = treeZone(ratio);
            // 蒙皮对象落到骨骼上 = 非法落点：与「拖进自己子孙」同一套反馈
            // （只标红、不 preventDefault，指针不动用户也能看出这一下放不进去）
            if (where === 'into' && parentBlocked(ctx.doc(), dragId, layer.id)) {
                clearDropMarks();
                row.classList.add('drop-invalid');
                return;
            }
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
            clearDropMarks();   // 先清（它会把 dropWhere 归零），再记本帧落点
            dropWhere = where;
            row.classList.add(where === 'into' ? 'is-drop' : (where === 'before' ? 'drop-before' : 'drop-after'));
        });
        row.addEventListener('dragleave', (e) => {
            const to = e.relatedTarget;
            if (to && row.contains(to)) return;
            clearDropMarks();
        });
        row.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const from = dragId;
            const where = dropWhere || 'into';
            const multi = dragMulti;
            dragId = null;
            dragMulti = false;
            dropWhere = null;
            clearDropMarks();
            if (!from || from === layer.id) return;
            // 父子关系一次只能改一个对象：多选块拖进树里只提示，绝不拿其中一行去改结构
            if (multi) {
                notify(t('tree.moveOne'));
                return;
            }
            // 蒙皮对象拖进骨骼下面：拦在写文档之前（parentBlocked 的规则见模块顶部注释）
            if (where === 'into' && parentBlocked(ctx.doc(), from, layer.id)) {
                notify(t('props.obj.skinErrParentBone'));
                return;
            }
            if (typeof ctx.moveSubtree === 'function') {
                if (ctx.moveSubtree(from, { mode: where, targetId: layer.id }) === false) notify(t('tree.moveFailed'));
            } else {
                // 没有 moveSubtree 就什么都做不了：以前这里降级到 ctx.setParent，但那个方法
                // 在 ctx 上从来不存在（真正叫 setLayerParent），分支永远 return，是个假的兜底。
                notify(t('tree.moveUnsupported'));
            }
            paint();
        });
        return row;
    }

    function paint() {
        const doc = ctx.doc();
        const all = objectsOf(doc);
        const byId = new Map(all.map((o) => [o.id, o]));
        const kids = new Map();   // parentId → 子对象数
        for (const o of all) {
            if (!o.parentId || !byId.has(o.parentId)) continue;
            kids.set(o.parentId, (kids.get(o.parentId) || 0) + 1);
        }

        // 列表是整体重建的（与 layers.mjs 同策略）：对象量级在几十，重建比 diff 省事也少 bug
        const frag = document.createDocumentFragment();
        // 行序唯一来源：core/hierarchy.treeOrder —— 深度优先，同级按 drawOrder（叠放真源）
        const rows = treeOrder(doc);
        let shown = 0;
        for (const { obj: layer, depth } of rows) {
            if (hiddenByCollapse(layer, byId)) continue;
            frag.appendChild(makeRow(layer, depth, kids.get(layer.id) || 0, byId));
            shown++;
        }
        list.textContent = '';
        list.appendChild(frag);

        const hasAny = all.length > 0;
        empty.hidden = hasAny;
        list.hidden = !hasAny;
        root.classList.toggle('is-empty', !hasAny);
        return shown;
    }

    // 拖到面板空白 = 脱父并排到最底层（Blender 里把行拖到空白处就是这个意思）
    list.addEventListener('dragover', (e) => {
        if (!dragId) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        list.classList.add('is-drop-blank');
    });
    list.addEventListener('dragleave', (e) => {
        if (e.target === list) list.classList.remove('is-drop-blank');
    });
    list.addEventListener('drop', (e) => {
        e.preventDefault();
        list.classList.remove('is-drop-blank');
        const from = dragId;
        dragId = null;
        if (!from) return;
        // 同上：没有 moveSubtree 就静默不动（原先降级到一个永远 return 的假兜底）
        if (typeof ctx.moveSubtree === 'function') ctx.moveSubtree(from, { mode: 'rootEnd', targetId: null });
        paint();
    });

    paint();

    // 文档一变就重画（叠放/父子/增删都会走到这里）
    const off = typeof ctx.subscribeDoc === 'function' ? ctx.subscribeDoc(() => paint()) : () => {};

    // 多选集合是内存层（不进文档、不进撤销）：集合一变就重画一遍点亮态
    const onSelChange = () => paint();
    if (typeof document !== 'undefined') document.addEventListener('ms:layer-selection', onSelChange);

    el.appendChild(root);
    return {
        refresh: paint,
        destroy: () => {
            off();
            if (typeof document !== 'undefined') document.removeEventListener('ms:layer-selection', onSelChange);
            root.remove();
        },
    };
}
