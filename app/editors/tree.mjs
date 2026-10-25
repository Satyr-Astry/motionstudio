// 父子树面板（编辑器 id: tree）：只编辑 parentId（跟谁动），不表达叠放顺序。
// 契约：docs/层级与叠放-2026-10.md §5 —— 这里没有行间插入线，拖到行上 = 成为子对象，
// 拖到空白 = 脱父。叠放顺序在 layers.mjs（扁平列表，改 drawOrder），两个面板各改一处数据。

import { treeOrder, isDescendantId } from './layers.mjs';
import { objectsOf } from '../core/cel.mjs';
import { icon } from '../core/icons.mjs';

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

let dragId = null;   // 正在拖的对象 id

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

    function select(id) {
        if (typeof ctx.setSelection === 'function') ctx.setSelection({ id });
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

        row.addEventListener('click', () => select(layer.id));

        // ── 拖拽：只改 parentId。没有行间落点，落点上就是「当它的子对象」
        row.addEventListener('dragstart', (e) => {
            dragId = layer.id;
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
                try { e.dataTransfer.setData('text/plain', layer.id); } catch (err) { /* 老浏览器忽略 */ }
            }
        });
        row.addEventListener('dragend', () => {
            dragId = null;
            list.querySelectorAll('.is-drop').forEach((n) => n.classList.remove('is-drop'));
        });
        row.addEventListener('dragover', (e) => {
            if (!dragId || dragId === layer.id) return;
            const all = objects();
            if (isDescendantId(all, layer.id, dragId)) return;   // 不能拖进自己的子孙
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
            row.classList.add('is-drop');
        });
        row.addEventListener('dragleave', () => row.classList.remove('is-drop'));
        row.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            row.classList.remove('is-drop');
            const from = dragId;
            dragId = null;
            if (!from || from === layer.id) return;
            setParentOf(from, layer.id);
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

    // 拖到面板空白 = 脱父（顶层）。行上的 drop 已经 stopPropagation，不会走到这里
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
        setParentOf(from, null);
    });

    paint();

    // 文档一变就重画（叠放/父子/增删都会走到这里）
    const off = typeof ctx.subscribeDoc === 'function' ? ctx.subscribeDoc(() => paint()) : () => {};

    el.appendChild(root);
    return {
        refresh: paint,
        destroy: () => {
            off();
            root.remove();
        },
    };
}
