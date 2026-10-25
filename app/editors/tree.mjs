// 父子树面板（编辑器 id: tree）：只编辑 parentId（跟谁动），不表达叠放顺序。
// 契约：docs/层级与叠放-2026-10.md §5 —— 拖拽三区（上缘 before / 中间 into / 下缘 after），
// 全走 ctx.moveSubtree（一次 setDoc、一条撤销）；拖到空白 = 脱父并排到最底（rootEnd）。
// 叠放顺序在 layers.mjs（扁平列表，改 drawOrder），两个面板各改一处数据，互不代偿。

import { treeOrder, isDescendantId } from './layers.mjs';
import { treeZone } from '../core/layer-order.mjs';
import { objectsOf } from '../core/cel.mjs';
import { icon } from '../core/icons.mjs';
import { clickIntent, rangeBetween } from '../core/selection.mjs';

const INDENT = 12;                       // 每级缩进（契约 §5：12px/级）
const MAX_DEPTH = 64;                    // 与 layers.mjs 的 MAX_TREE_DEPTH 同值，防脏数据成环
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

export function mount(el, ctx) {
    const root = document.createElement('div');
    root.className = 'tree';

    const list = document.createElement('div');
    list.className = 'tree-list';
    root.appendChild(list);

    const empty = document.createElement('div');
    empty.className = 'tree-empty';
    empty.textContent = '还没有对象';
    root.appendChild(empty);

    const objects = () => objectsOf(ctx.doc());
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
        const all = objectsOf(ctx.doc() || {});
        const order = all.map((l) => l.id);
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

    function setParentOf(id, parentId) {
        if (typeof ctx.setParent !== 'function') return;
        if (!ctx.setParent(id, parentId)) notify('移动失败');
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
            caret.title = isCollapsed ? '展开这一支（Alt+点：连祖先一起合上）' : '收起这一支（Alt+点：连祖先一起合上）';
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
            pill.title = '含 ' + kidCount + ' 个子对象（拖动这一行会整棵子树一起移动）';
            pill.setAttribute('aria-label', pill.title);
            row.appendChild(pill);
        }

        const chain = chainText(layer, byId);
        row.title = (layer.name || layer.id) + (chain ? ' · 父链 ' + chain : ' · 顶层');

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
            const all = objects();
            // 任何落点都不能进自己的子树（before/after 也一样：整棵子树搬到自己里面没有意义）
            if (isDescendantId(all, layer.id, dragId)) {
                clearDropMarks();
                row.classList.add('drop-invalid');
                return;
            }
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
            const r = row.getBoundingClientRect();
            const ratio = r.height > 0 ? (e.clientY - r.top) / r.height : 0.5;
            const where = treeZone(ratio);
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
                notify('父子关系一次只能改一个对象');
                return;
            }
            if (typeof ctx.moveSubtree === 'function') {
                if (ctx.moveSubtree(from, { mode: where, targetId: layer.id }) === false) notify('移动失败');
            } else if (where === 'into') {
                setParentOf(from, layer.id);   // 老接口降级：只有「成为子对象」这一种
            } else {
                notify('这个版本不支持插入到行间');
            }
            paint();
        });
        return row;
    }

    function paint() {
        const all = objects();
        const byId = new Map(all.map((o) => [o.id, o]));
        const kids = new Map();   // parentId → 子对象数
        for (const o of all) {
            if (!o.parentId || !byId.has(o.parentId)) continue;
            kids.set(o.parentId, (kids.get(o.parentId) || 0) + 1);
        }

        // 列表是整体重建的（与 layers.mjs 同策略）：对象量级在几十，重建比 diff 省事也少 bug
        const frag = document.createDocumentFragment();
        const rows = treeOrder(all);
        let shown = 0;
        for (const { layer, depth } of rows) {
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
        if (typeof ctx.moveSubtree === 'function') ctx.moveSubtree(from, { mode: 'rootEnd', targetId: null });
        else setParentOf(from, null);
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
