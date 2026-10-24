/**
 * MotionStudio —— 命令面板（VS Code 风格，Ctrl+Shift+P）
 *
 * 职责：一块浮在整窗之上的搜索框 + 命令列表，**只管展示与选择**。
 * 执行交给外部（opts.run）或命令自身的 run()；全局快捷键也不在这里绑，
 * 由外壳在 onKeyDown 里调 toggle() —— 免得面板和画布 / 时间轴抢键。
 *
 * 导出只有三样（纯函数部分不碰 DOM，可以在 node 里直接测）：
 *   createPalette(opts)          → { el, open, close, toggle, isOpen, setCommands, refresh, destroy }
 *   filterCommands(commands, q)  → 排好序的命令数组（不截断、不改入参）
 *   scoreCommand(cmd, q)         → 整数分数，0 表示未命中
 *
 * opts = { commands, run(cmd), onQuery?(q) }
 *   commands  每项 { id, title, hint, keys, group, run(), enabled }
 *   run       统一执行入口；给了就优先于 cmd.run()，便于外壳统一收口（历史 / flash / 日志）
 *   onQuery   查询旁路回调，只由输入事件触发（打开时不补发）
 *
 * 排序（scoreCommand，整数分，越高越前；取 title / group / hint 三段里的最高分）：
 *   命中带    连续子串 10000 / 连续子序列 0        —— 子串永远压过子序列
 *   字段权重  title 3000 / group 900 / hint 600    —— 标题永远压过组名与 hint
 *   位置加成  60 − min(命中起点, 60)               —— 越靠前越好
 *   紧凑加成  30 − min(富余字符, 30)               —— 子序列按跨度 1/2 折算
 *   禁用扣分  enabled === false 时 −1              —— 只压同分位，不跨命中带
 *   同分按原始下标稳定排序（不依赖 Array#sort 的稳定性实现）。
 *
 * DOM 契约（palette.css 依赖这些类名，别改名）：
 *   div.cmd-overlay > div.cmd-box > input.cmd-input + div.cmd-list + div.cmd-foot
 *   div.cmd-list 内：div.cmd-group[data-group] / div.cmd-item[data-id][data-active]
 *                    辅助行 div.cmd-more（截断提示）、div.cmd-empty（无匹配提示）
 *
 * 焦点 / 拦截边界：只在自己的输入框和列表里处理 Esc / Enter / ↑ / ↓ / Tab；
 * 关闭时把焦点还给打开前的 activeElement。overlay 的内联样式只给 position / inset，
 * 布局与配色全部在 palette.css。
 */

/** 列表最多渲染多少行（超出截断并提示）。 */
const MAX_ROWS = 200;
/** 命中字段权重：标题 > 组名 > hint。 */
const FIELD_WEIGHT = { title: 3000, group: 900, hint: 600 };
/** 命中带：连续子串与连续子序列之间留出足够大的鸿沟，永远不可跨越。 */
const KIND_BAND = { substring: 10000, subsequence: 0 };
const POS_SPAN = 60;
const TIGHT_SPAN = 30;
const DISABLED_PENALTY = 1;
const FOOT_HINT = '↑↓ 选择 · Enter 执行 · Esc 关闭';
const EMPTY_TEXT = '没有匹配的命令';
const UNGROUPED_LABEL = '其他';

/** 实例序号（给 item 生成唯一 id，供 aria-activedescendant 使用）。 */
let instanceSeq = 0;
/** 打开的实例计数：多个面板同时开时，body.cmd-open 不被先关的那个摘掉。 */
let bodyOpenCount = 0;

function textOf(value) {
    return value == null ? '' : String(value);
}

function lowerOf(value) {
    return textOf(value).toLowerCase();
}

function report(err) {
    if (typeof console !== 'undefined' && console && typeof console.error === 'function') {
        console.error('[command-palette]', err);
    }
}

/** 连续子串命中：返回起点与跨度，未命中返回 null。 */
function findSubstring(hay, needle) {
    const at = hay.indexOf(needle);
    return at < 0 ? null : { start: at, span: needle.length };
}

/** 连续子序列命中：单趟扫描，返回首个字符起点与跨度。 */
function findSubsequence(hay, needle) {
    let k = 0;
    let start = -1;
    let span = 0;
    for (let i = 0; i < hay.length && k < needle.length; i += 1) {
        if (hay[i] !== needle[k]) continue;
        if (k === 0) start = i;
        k += 1;
        if (k === needle.length) span = i - start + 1;
    }
    return k === needle.length ? { start, span } : null;
}

/** 单个字段的得分：子串带 > 子序列带，带内再加位置与紧凑加成。 */
function fieldScore(hay, needle, field) {
    // 字段比查询还短不可能命中（子串与子序列都一样），直接短路省掉整趟扫描
    if (!hay || hay.length < needle.length) return 0;
    const qLen = needle.length;
    const weight = FIELD_WEIGHT[field];
    const sub = findSubstring(hay, needle);
    if (sub) {
        const pos = POS_SPAN - Math.min(sub.start, POS_SPAN);
        const tight = TIGHT_SPAN - Math.min(hay.length - qLen, TIGHT_SPAN);
        return KIND_BAND.substring + weight + pos + tight;
    }
    const seq = findSubsequence(hay, needle);
    if (!seq) return 0;
    const pos = POS_SPAN - Math.min(seq.start, POS_SPAN);
    const tight = TIGHT_SPAN - Math.min(Math.floor(seq.span / 2), TIGHT_SPAN);
    return KIND_BAND.subsequence + weight + pos + tight;
}

/**
 * 纯函数：给一条命令打分。title / group / hint 三段取最高分，
 * 空查询返回 0（空查询由 filterCommands 直接保序返回全部，不参与排名）。
 */
export function scoreCommand(cmd, query) {
    if (!cmd || typeof cmd !== 'object') return 0;
    const needle = lowerOf(query).trim();
    if (!needle) return 0;
    let best = fieldScore(lowerOf(cmd.title), needle, 'title');
    const group = fieldScore(lowerOf(cmd.group), needle, 'group');
    if (group > best) best = group;
    const hint = fieldScore(lowerOf(cmd.hint), needle, 'hint');
    if (hint > best) best = hint;
    if (best <= 0) return 0;
    return cmd.enabled === false ? best - DISABLED_PENALTY : best;
}

/**
 * 纯函数：过滤 + 排序。
 * 空查询（含纯空白）返回全部并保持传入顺序；有查询时按分数降序、同分保序。
 * 不截断（200 行上限是渲染层的事）、不改入参、不写回命令对象。
 */
export function filterCommands(commands, query) {
    const list = Array.isArray(commands)
        ? commands.filter((cmd) => cmd && typeof cmd === 'object')
        : [];
    const needle = lowerOf(query).trim();
    if (!needle) return list;
    const ranked = [];
    for (let i = 0; i < list.length; i += 1) {
        const score = scoreCommand(list[i], needle);
        if (score > 0) ranked.push({ cmd: list[i], score, at: i });
    }
    // 显式带原始下标做次键，不指望引擎的排序稳定性
    ranked.sort((a, b) => (b.score - a.score) || (a.at - b.at));
    return ranked.map((hit) => hit.cmd);
}

function make(tag, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
}

/**
 * 建一块命令面板。返回的 el 是未挂载的 `.cmd-overlay`：
 * 主线可以自己 appendChild，也可以在 open() 时由本模块挂到 body（destroy 会摘掉）。
 */
export function createPalette(opts = {}) {
    const options = opts && typeof opts === 'object' ? opts : {};
    const runExternal = typeof options.run === 'function' ? options.run : null;
    const onQuery = typeof options.onQuery === 'function' ? options.onQuery : null;

    let source = Array.isArray(options.commands) ? options.commands.slice() : [];
    let opened = false;
    let destroyed = false;
    let active = -1;
    /** @type {{ cmd: object, node: HTMLElement }[]} 当前渲染出来的行，顺序即列表顺序 */
    let entries = [];
    /** 打开前的焦点，关闭时还原 */
    let restoreFocus = null;

    instanceSeq += 1;
    const uid = `cmd-palette-${instanceSeq}`;
    const listId = `${uid}-list`;

    const overlay = make('div', 'cmd-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', '命令面板');
    overlay.setAttribute('aria-modal', 'true');
    overlay.hidden = true;
    // 这四行内联是「全屏遮挡」的兜底：CSS 没加载时也不至于只遮住一个角落。
    // 其余几何 / 配色一律交给 palette.css。
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';

    const box = make('div', 'cmd-box');

    const input = make('input', 'cmd-input');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-label', '搜索命令');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', listId);
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');
    input.setAttribute('placeholder', '输入命令名称…');

    const list = make('div', 'cmd-list');
    list.id = listId;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', '命令列表');

    const foot = make('div', 'cmd-foot');
    foot.textContent = FOOT_HINT;

    box.append(input, list, foot);
    overlay.appendChild(box);

    /* ── 监听器登记表：destroy 时逐条摘掉，绝不留下野监听 ───────────────── */

    const bindings = [];

    function on(target, type, handler, extra) {
        target.addEventListener(type, handler, extra);
        bindings.push([target, type, handler, extra]);
    }

    function unbindAll() {
        while (bindings.length) {
            const [target, type, handler, extra] = bindings.pop();
            target.removeEventListener(type, handler, extra);
        }
    }

    /* ── 高亮 ─────────────────────────────────────────────────────────── */

    function markItem(node, onState) {
        node.dataset.active = onState ? 'true' : 'false';
        node.setAttribute('aria-selected', onState ? 'true' : 'false');
    }

    function scrollTo(node) {
        try {
            if (node && typeof node.scrollIntoView === 'function') {
                node.scrollIntoView({ block: 'nearest' });
            }
        } catch (err) {
            // 老 Chromium 的 scrollIntoView 不认对象参数，定位失败不影响功能
        }
    }

    function setActive(index, o = {}) {
        if (!entries.length) {
            active = -1;
            input.removeAttribute('aria-activedescendant');
            return;
        }
        let next = Math.trunc(Number(index));
        if (!Number.isFinite(next)) next = 0;
        next = Math.max(0, Math.min(entries.length - 1, next));
        const previous = entries[active];
        active = next;
        if (previous && previous !== entries[next]) markItem(previous.node, false);
        const current = entries[next];
        markItem(current.node, true);
        input.setAttribute('aria-activedescendant', current.node.id);
        if (o.scroll) scrollTo(current.node);
    }

    function moveBy(delta) {
        if (!entries.length) return;
        setActive(active + delta, { scroll: true });
    }

    function itemIndexOf(target) {
        if (!target || typeof target.closest !== 'function') return -1;
        const node = target.closest('.cmd-item');
        if (!node) return -1;
        for (let i = 0; i < entries.length; i += 1) {
            if (entries[i].node === node) return i;
        }
        return -1;
    }

    /* ── 渲染 ─────────────────────────────────────────────────────────── */

    function groupOf(cmd) {
        return textOf(cmd.group);
    }

    function buildItem(cmd, index) {
        const node = make('div', 'cmd-item');
        node.id = `${uid}-opt-${index + 1}`;
        node.setAttribute('data-id', textOf(cmd.id));
        node.setAttribute('role', 'option');
        markItem(node, false);
        if (cmd.enabled === false) node.setAttribute('data-disabled', 'true');

        // 三个 span 恒定存在（空的由 CSS 的 :empty 收掉），避免结构随数据抖动
        const title = make('span', 'cmd-title');
        title.textContent = textOf(cmd.title);
        const hint = make('span', 'cmd-hint');
        hint.textContent = textOf(cmd.hint);
        const keys = make('span', 'cmd-keys');
        keys.textContent = textOf(cmd.keys);
        node.append(title, hint, keys);

        list.appendChild(node);
        return { cmd, node };
    }

    function render(o = {}) {
        if (destroyed) return;
        const keep = active;
        active = -1;
        entries = [];
        while (list.firstChild) list.removeChild(list.firstChild);
        input.removeAttribute('aria-activedescendant');

        const query = input.value;
        const matched = filterCommands(source, query);
        const grouping = textOf(query).trim() === '';

        if (!matched.length) {
            const empty = make('div', 'cmd-empty');
            empty.textContent = EMPTY_TEXT;
            list.appendChild(empty);
            return;
        }

        const visible = matched.slice(0, MAX_ROWS);
        let currentGroup = null;
        for (let i = 0; i < visible.length; i += 1) {
            const cmd = visible[i];
            if (grouping) {
                const group = groupOf(cmd);
                if (group !== currentGroup) {
                    currentGroup = group;
                    const head = make('div', 'cmd-group');
                    head.setAttribute('data-group', group);
                    head.textContent = group || UNGROUPED_LABEL;
                    list.appendChild(head);
                }
            }
            entries.push(buildItem(cmd, entries.length));
        }

        if (matched.length > visible.length) {
            const more = make('div', 'cmd-more');
            more.textContent = `还有 ${matched.length - visible.length} 项…`;
            list.appendChild(more);
        }

        if (o.resetActive) list.scrollTop = 0;
        setActive(o.resetActive ? 0 : keep < 0 ? 0 : keep, { scroll: true });
    }

    /* ── 执行 ─────────────────────────────────────────────────────────── */

    function dispatch(cmd) {
        try {
            if (runExternal) runExternal(cmd);
            else if (typeof cmd.run === 'function') cmd.run();
        } catch (err) {
            // 单条命令抛错不该把面板留在半关闭状态，也不该拖垮外壳
            report(err);
        }
    }

    function activate(index) {
        const entry = entries[index];
        if (!entry) return;
        // 禁用的命令只展示、不执行（Enter 落在它身上时什么都不发生，面板保持打开）
        if (entry.cmd.enabled === false) return;
        closePanel();
        dispatch(entry.cmd);
    }

    /* ── 开合 ─────────────────────────────────────────────────────────── */

    function restore() {
        const target = restoreFocus;
        restoreFocus = null;
        if (!target || target === document.body) return;
        try {
            if (target.isConnected !== false && typeof target.focus === 'function') target.focus();
        } catch (err) {
            // 打开前的宿主已经被销毁，放弃还原
        }
    }

    function openPanel() {
        if (destroyed || opened) return;
        opened = true;
        restoreFocus = document.activeElement;
        // 主线可以提前挂到 body；没挂的话 open 自己挂，保证 el 一定在文档里
        if (!overlay.parentNode) document.body.appendChild(overlay);
        overlay.hidden = false;
        bodyOpenCount += 1;
        document.body.classList.add('cmd-open');
        input.setAttribute('aria-expanded', 'true');
        render({ resetActive: true });
        input.focus();
        try {
            input.setSelectionRange(0, input.value.length);
        } catch (err) {
            // 非文本输入框才会抛，这里兜一下
        }
    }

    function closePanel() {
        if (destroyed || !opened) return;
        opened = false;
        overlay.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        bodyOpenCount = Math.max(0, bodyOpenCount - 1);
        if (bodyOpenCount === 0) document.body.classList.remove('cmd-open');
        restore();
    }

    /* ── 事件 ─────────────────────────────────────────────────────────── */

    function onKeyDown(e) {
        // 输入法组字中：Enter / Esc 属于候选词，别抢
        if (e.isComposing) return;
        const key = e.key;
        if (key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            closePanel();
            return;
        }
        if (key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            activate(active);
            return;
        }
        if (key === 'ArrowDown' || key === 'ArrowUp') {
            e.preventDefault();
            e.stopPropagation();
            moveBy(key === 'ArrowDown' ? 1 : -1);
            return;
        }
        if (key === 'Tab') {
            // Tab 在面板内改为移动高亮，不把焦点丢给背后的画布
            e.preventDefault();
            e.stopPropagation();
            moveBy(e.shiftKey ? -1 : 1);
        }
    }

    function onInput() {
        if (onQuery) {
            try {
                onQuery(input.value);
            } catch (err) {
                report(err);
            }
        }
        render({ resetActive: true });
    }

    function onHover(e) {
        const index = itemIndexOf(e.target);
        if (index >= 0 && index !== active) setActive(index);
    }

    function onClick(e) {
        const index = itemIndexOf(e.target);
        if (index < 0) return;
        setActive(index);
        activate(index);
    }

    // 行上按下鼠标时别让输入框失焦：否则点一下组标题，键盘导航就断了。
    // 这是自己 DOM 内的默认行为，不拦任何按键，也不影响别处的监听者。
    function onListMouseDown(e) {
        if (itemIndexOf(e.target) >= 0) e.preventDefault();
    }

    function onOverlayMouseDown(e) {
        if (e.target === overlay) {
            e.preventDefault();
            closePanel();
        }
    }

    on(overlay, 'keydown', onKeyDown);
    on(overlay, 'mousedown', onOverlayMouseDown);
    on(input, 'input', onInput);
    on(list, 'mousemove', onHover);
    on(list, 'mousedown', onListMouseDown);
    on(list, 'click', onClick);

    return {
        el: overlay,
        open: openPanel,
        close: closePanel,
        toggle: () => (opened ? closePanel() : openPanel()),
        isOpen: () => opened,
        setCommands(next) {
            if (destroyed) return;
            source = Array.isArray(next) ? next.slice() : [];
            if (opened) render({ resetActive: false });
        },
        refresh() {
            if (destroyed || !opened) return;
            render({ resetActive: false });
        },
        destroy() {
            if (destroyed) return;
            closePanel();
            destroyed = true;
            unbindAll();
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            entries = [];
            source = [];
            restoreFocus = null;
        },
    };
}
