/**
 * MotionStudio —— 快捷键一览浮层（`?` 打开，Esc / 点背景关闭）
 *
 * 为什么单独一个模块：键位表是「给人看的文档」，但它必须和 app.mjs 里真正的
 * 按键分派保持同一份数据源，否则迟早对不上。这里只做「拿一张表 → 画出来」，
 * 不绑任何全局键（开合由外壳决定），也不 import 任何东西（方便单测只测表结构）。
 */

/** 表结构：{ groups: [{ title, items: [{ keys, title, hint }] }] } */
export function createShortcutGroups(spec) {
    const src = spec && typeof spec === 'object' ? spec : {};
    const groups = Array.isArray(src.groups) ? src.groups : [];
    return groups
        .filter((g) => g && Array.isArray(g.items) && g.items.length)
        .map((g) => ({
            title: String(g.title || '其它'),
            items: g.items
                .filter((it) => it && it.title)
                .map((it) => ({
                    keys: String(it.keys || ''),
                    title: String(it.title),
                    hint: String(it.hint || ''),
                })),
        }));
}

/** 把命令表（buildCommands 的产物）折叠成「键位 → 标题」，供浮层复用。 */
export function groupsFromCommands(commands) {
    const list = Array.isArray(commands) ? commands : [];
    const byGroup = new Map();
    for (const cmd of list) {
        if (!cmd || typeof cmd !== 'object') continue;
        const keys = String(cmd.keys || '').trim();
        if (!keys) continue;
        const group = String(cmd.group || '其它');
        if (!byGroup.has(group)) byGroup.set(group, []);
        byGroup.get(group).push({ keys, title: String(cmd.title || ''), hint: String(cmd.hint || '') });
    }
    return [...byGroup.entries()].map(([title, items]) => ({ title, items }));
}

/**
 * 造浮层。返回 { el, open, close, toggle, isOpen, setGroups, destroy }。
 * 浮层自己挂到 body，打开时记住焦点并在关闭时还原。
 */
export function createShortcutsOverlay(opts) {
    const o = opts || {};
    let groups = createShortcutGroups({ groups: o.groups });
    let lastFocus = null;

    const el = document.createElement('div');
    el.className = 'keys-overlay';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', '快捷键一览');
    el.setAttribute('aria-modal', 'true');

    const box = document.createElement('div');
    box.className = 'keys-box';

    const head = document.createElement('div');
    head.className = 'keys-head';
    const title = document.createElement('span');
    title.className = 'keys-title';
    title.textContent = '快捷键';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'keys-close';
    close.textContent = '✕';
    close.title = '关闭（Esc）';
    head.append(title, close);

    const body = document.createElement('div');
    body.className = 'keys-body';

    const foot = document.createElement('div');
    foot.className = 'keys-foot';
    foot.textContent = 'Esc 关闭 · ? 再按一次也能关';

    box.append(head, body, foot);
    el.appendChild(box);

    function render() {
        body.textContent = '';
        for (const g of groups) {
            const col = document.createElement('div');
            col.className = 'keys-group';
            const gt = document.createElement('div');
            gt.className = 'keys-group-title';
            gt.textContent = g.title;
            col.appendChild(gt);
            for (const it of g.items) {
                const row = document.createElement('div');
                row.className = 'keys-row';
                const k = document.createElement('span');
                k.className = 'keys-kbd';
                k.textContent = it.keys;
                const t = document.createElement('span');
                t.className = 'keys-label';
                t.textContent = it.title;
                row.append(k, t);
                if (it.hint) row.title = it.hint;
                col.appendChild(row);
            }
            body.appendChild(col);
        }
    }

    function open() {
        if (!el.hidden) return true;
        if (!el.parentNode && typeof document !== 'undefined' && document.body) document.body.appendChild(el);
        lastFocus = typeof document !== 'undefined' ? document.activeElement : null;
        el.hidden = false;
        el.classList.add('is-open');
        render();
        if (typeof box.focus === 'function') {
            box.tabIndex = -1;
            box.focus();
        }
        return true;
    }

    function closeIt() {
        if (el.hidden) return false;
        el.hidden = true;
        el.classList.remove('is-open');
        if (lastFocus && typeof lastFocus.focus === 'function' && document.contains(lastFocus)) {
            try {
                lastFocus.focus();
            } catch (err) {
                /* 焦点还原失败不影响功能 */
            }
        }
        lastFocus = null;
        return true;
    }

    function toggle() {
        return el.hidden ? open() : closeIt();
    }

    function setGroups(next) {
        groups = createShortcutGroups({ groups: next });
        if (!el.hidden) render();
    }

    // 点背景关闭（点 box 内部不关）
    el.addEventListener('pointerdown', (e) => {
        if (e.target === el) closeIt();
    });
    close.addEventListener('click', () => closeIt());
    // 浮层自己吃 Esc / ?，避免落到外壳的全局快捷键上
    el.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' || e.key === '?') {
            e.preventDefault();
            e.stopPropagation();
            closeIt();
        }
    });

    render();
    if (typeof document !== 'undefined' && document.body) document.body.appendChild(el);

    return {
        el,
        open,
        close: closeIt,
        toggle,
        isOpen: () => !el.hidden,
        setGroups,
        destroy() {
            if (el.parentNode) el.parentNode.removeChild(el);
        },
    };
}
