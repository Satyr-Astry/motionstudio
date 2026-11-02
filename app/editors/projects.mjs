/**
 * MotionStudio —— 项目库面板（editors/projects.mjs）
 *
 * 本地项目库的 UI，纯 DOM，不嵌 iframe：左侧列表以卡片形式展示已保存的项目
 * （缩略图、名称、纹理数×尺寸、保存时间），**点卡片任意处即载入**，
 * 卡片上只留次级动作 `重命名 / 存为文件 / 删除`（删除走危险色）。
 *
 * 顶部（`.prj-top`）只有一个主行动「新建项目」+ 搜索框 + `…` 菜单：
 * 低频项（导入项目文件 / 导出精灵图 / 刷新 / 导入图片到当前文档）全部收进菜单。
 * 为什么收：它们是四件不同层级的事——「导入图片」改的是当前文档、「导出精灵图」
 * 是导出、「刷新」对本地库基本无意义，过去五个按钮平铺在一行，视觉权重与
 * 「新建」等同，用户不知道哪个是主操作。
 *
 * 「导入图片」走 `<input type="file" accept="image/*">` + FileReader（浏览器原生文件选择，
 * 不是主进程对话框）：选中的图片被当成一个 kind:'image' 对象插进**当前文档**的最上层，
 * 居中摆放，并从 0 秒起一直可见（纹理只在 0 秒落一次）。数据转换在 shell/project-store.mjs 的 imageElementFromFile /
 * addImageElement 里，面板只负责取文件与换文档。
 *
 * 数据与动作全部来自外壳注入的 `ctx.project`（见 shell/app.mjs 的 projectApi）：
 *   list() → Promise<记录[]>  current() → {id,name}|null  open(id)  create(opts)
 *   save(name?)  rename(id,name)  remove(id)  importFile()  exportFile()  subscribe(fn) → off()
 * 面板本身不认识 IndexedDB、不认识文件对话框，换存储不影响这里。
 *
 * 「该不该保存」这类判据一律不在这里：`api.open()` 内部会走 `beforeSwitch`（project-io.mjs），
 * 文档脏时由守卫浮层决定保存/丢弃/取消。面板只负责把「点被挡住了」和「点了没反应」
 * 区分开——busy 时给文案 + `aria-busy`，守卫浮层开着时整块面板 `inert`。
 *
 * 样式归 app/styles/projects.css。本文件只写类名；仅「重命名输入框所在行」这类
 * 必须在运行时才存在的对象用了极少量内联样式，保证在任何 CSS 下都可见。
 */

import { addImageElement, imageElementFromFile } from '../shell/project-store.mjs';
import { icon } from '../core/icons.mjs';
import { t } from '../i18n/index.mjs';

// 下面两张表是模块级常量，用户看得见的字段一律写成访问器：setLocale() 只换表、
// 不重建常量，写成普通属性会把首次渲染时的语言冻在里面（docs/本地化.md §5）。
// `act` / `icon` / `danger` / `sepBefore` 是行为与样式用的，不随语言变。

/** 卡片上的次级动作。顺序即渲染顺序；`danger` 的那条走 `--danger`。 */
export const CARD_ACTIONS = [
    {
        act: 'rename',
        icon: 'pencil',
        get label() {
            return t('projects.card.rename');
        },
        get title() {
            return t('projects.card.rename.hint');
        },
    },
    {
        act: 'export',
        icon: 'save',
        get label() {
            return t('projects.card.export');
        },
        get title() {
            return t('projects.card.export.hint');
        },
    },
    {
        act: 'delete',
        icon: 'trash',
        danger: true,
        get label() {
            return t('projects.card.delete');
        },
        get title() {
            return t('projects.card.delete.hint');
        },
    },
];

/** `…` 菜单项。`sepBefore` 之后是「不属于项目库」的那一项，用分隔线标出层级差。 */
export const MENU_ITEMS = [
    {
        act: 'import',
        icon: 'folder-open',
        get label() {
            return t('projects.menu.import');
        },
        get title() {
            return t('projects.menu.import.hint');
        },
    },
    {
        act: 'sheet',
        icon: 'grid',
        get label() {
            return t('projects.menu.sheet');
        },
        get title() {
            return t('projects.menu.sheet.hint');
        },
    },
    {
        act: 'refresh',
        icon: 'rotate-ccw',
        get label() {
            return t('projects.menu.refresh');
        },
        get title() {
            return t('projects.menu.refresh.hint');
        },
    },
    {
        act: 'image',
        icon: 'image-plus',
        sepBefore: true,
        get label() {
            return t('projects.menu.image');
        },
        get title() {
            return t('projects.menu.image.hint');
        },
    },
];

/**
 * 搜索有库但无匹配时的文案：不能退回空态 CTA（那会让用户以为库是空的）。
 *
 * 写成函数而不是模块级字符串 —— `setLocale()` 不重建模块常量，字符串会把
 * 首次渲染的语言冻住，切到中文后仍然是英文这一句。
 */
export function noResultText() {
    return t('projects.noResult');
}

/** 搜索过滤：按名字子串匹配，忽略大小写与首尾空白。纯函数，Node 可直接测。 */
export function filterRows(rows, query) {
    const list = Array.isArray(rows) ? rows : [];
    const q = String(query == null ? '' : query).trim().toLowerCase();
    if (!q) return list;
    return list.filter((r) => String((r && r.name) || '').toLowerCase().includes(q));
}

/** 统计口径：有查询时给「匹配 N / M」，没查询时给「共 M 个」。纯函数。 */
export function countLabel(total, matched, query) {
    const n = Number(total) || 0;
    if (!n) return '';
    const q = String(query == null ? '' : query).trim();
    if (!q) return t('projects.count.all', { n });
    return t('projects.count.matched', { matched: Number(matched) || 0, n });
}

/**
 * 把外壳接口的返回值归一成「真成了 / 用户取消 / 没成」。
 *
 * 三种来源都要吃得下：
 * - boolean —— open/create/rename/remove 这些老接口回 true|false；
 * - `{ok:true,…}` / `{ok:false,canceled?,error?}` —— exportFile / exportSpritesheet 这类
 *   要说明「写去了哪、为什么没写成」的接口；
 * - `null` / `undefined` —— **接口没跑起来**（桥不在、面板拿不到注入）。
 *
 * 为什么不能继续用 `ok !== false`：这条判据把 null 当成功。桥不在、主进程没响应时
 * 界面照样弹「已存为文件」，磁盘上却什么都没有 —— 这就是「没做却说成功」。
 * 纯函数，Node 可直接测。
 *
 * @returns {{ok:boolean, canceled:boolean, error:string, out:*}}
 */
export function actVerdict(out) {
    const bare = { ok: false, canceled: false, error: '', out: out };
    if (out === true) return Object.assign(bare, { ok: true });
    if (out === false) return Object.assign(bare, { error: t('projects.verdict.incomplete') });
    if (out == null) return Object.assign(bare, { error: t('projects.verdict.noAnswer') });
    if (typeof out === 'object') {
        if (out.ok === false) {
            const canceled = !!out.canceled;
            const why = String(out.error || '');
            return Object.assign(bare, {
                canceled: canceled,
                error: canceled
                    ? (why || t('projects.verdict.canceled'))
                    : (why || t('projects.verdict.incomplete')),
            });
        }
        // ok:true，或没写 ok 字段但确实回了对象：按成功处理，错误留空
        return Object.assign(bare, { ok: true });
    }
    // 其它标量（'done' / 1 / …）：有返回就当成了，但不当成「有凭据」
    return Object.assign(bare, { ok: true });
}


/** 规范化记录，容忍外壳给的不完整数据。 */
function norm(rec, i) {
    const r = rec || {};
    return {
        id: String(r.id || 'rec-' + i),
        name: String(r.name || t('projects.untitled')),
        savedAt: Number(r.savedAt) || 0,
        width: Number(r.width) || 0,
        height: Number(r.height) || 0,
        // v6：记录里数的是纹理数。老记录只有 frames（帧数），读的时候兼容，写的时候不再写 frames。
        cels: Number(r.cels) || Number(r.frames) || 0,
        layers: Number(r.layers) || 0,
        thumb: typeof r.thumb === 'string' ? r.thumb : '',
        bytes: Number(r.bytes) || 0,
    };
}

function pad2(n) {
    return n < 10 ? '0' + n : String(n);
}

/** 修改时间：今天只显示时分，其它显示月-日 时:分。 */
function fmtTime(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    if (!Number.isFinite(d.getTime())) return '—';
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return sameDay ? t('projects.time.today', { hm }) : pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + hm;
}

function fmtBytes(n) {
    if (!n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
}

function mk(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = String(text);
    return node;
}

/**
 * 图标节点：`icon()` 返回的是 SVG **字符串**（见 core/icons.mjs:190 的 `@returns {string}`），
 * 不能直接 appendChild。这里用 <template> 转成真节点，并让 `.prj-ico` 落在 <svg> 自己身上
 * （不套多余的 wrapper —— wrapper 会多一层盒子，图标基线与按钮文字对不齐）。
 * 尺寸交给 styles/projects.css 的 `--icon-size`，`className` 由 icon() 自己拼。
 */
function icoNode(name, opts) {
    const tpl = document.createElement('template');
    tpl.innerHTML = icon(name, Object.assign({ className: 'prj-ico' }, opts || {})).trim();
    const node = tpl.content.firstChild;
    return node && node.nodeType === 1 ? node : null;
}

function button(act, text, title, iconName, extraClass) {
    const b = mk('button', 'prj-btn' + (extraClass ? ' ' + extraClass : ''), null);
    b.type = 'button';
    b.dataset.act = act;
    if (iconName) {
        const i = icoNode(iconName);
        if (i) b.appendChild(i);
    }
    if (text) b.appendChild(mk('span', 'prj-t', text));
    if (title) b.title = title;
    // 纯图标按钮（`…`）没有文字节点，读屏只能靠 aria-label，所以显式写一条
    b.setAttribute('aria-label', text || title || act);
    return b;
}

/** 轻提示：面板内部的灰色一行，不抢状态栏。 */
const HINT_MS = 2400;

/**
 * 失败提示停留时长。
 *
 * 失败文案里带「为什么 + 怎么补救」，2400ms 不够读完；同时失败不能被下一条
 * 普通提示立刻顶掉（见 `say` 的去重规则），否则用户只看到一个结果、看不到原因。
 */
const HINT_ERROR_MS = 7000;

/** FileReader → dataURL（失败给空串，调用方统一按「读不到」处理）。 */
function readAsDataURL(file) {
    return new Promise((resolve) => {
        try {
            const reader = new FileReader();
            reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
            reader.onerror = () => resolve('');
            reader.readAsDataURL(file);
        } catch (err) {
            resolve('');
        }
    });
}

/** 只挑图片文件，其余静默丢弃（accept 只是提示，拖进来的不一定守规矩）。 */
function imageFiles(list) {
    const out = [];
    for (const f of Array.from(list || [])) {
        if (!f) continue;
        const type = String(f.type || '');
        const name = String(f.name || '');
        if (type.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp)$/i.test(name)) out.push(f);
    }
    return out;
}

export function mount(host, ctx) {
    const api = ctx && ctx.project;
    const panel = mk('div', 'prj-panel');

    // ── head：一个主行动 + 搜索 + `…` 菜单 ──────────────────────────────
    const head = mk('div', 'prj-top');
    head.setAttribute('role', 'toolbar');
    head.setAttribute('aria-label', t('projects.head.aria'));

    const btnNew = button('new', t('projects.new'), t('projects.new.hint'), 'plus', 'prj-primary');

    const search = mk('label', 'prj-search');
    const searchIco = icoNode('search');
    const searchInput = mk('input', 'prj-search-input');
    searchInput.type = 'search';
    searchInput.placeholder = t('projects.search.placeholder');
    searchInput.setAttribute('aria-label', t('projects.search.aria'));
    if (searchIco) search.appendChild(searchIco);
    search.appendChild(searchInput);

    const count = mk('span', 'prj-count', '');
    count.setAttribute('aria-live', 'polite');
    const grow = mk('span', 'prj-gap');

    const btnMore = button('more', null, t('projects.more'), 'more-horizontal', 'prj-more');
    btnMore.setAttribute('aria-haspopup', 'menu');
    btnMore.setAttribute('aria-expanded', 'false');

    const menu = mk('div', 'prj-menu');
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', t('projects.more'));
    for (const it of MENU_ITEMS) {
        if (it.sepBefore) menu.appendChild(mk('div', 'prj-mi-sep'));
        const mi = mk('button', 'prj-mi', null);
        mi.type = 'button';
        mi.dataset.act = it.act;
        mi.setAttribute('role', 'menuitem');
        mi.setAttribute('aria-label', it.label);
        mi.title = it.title || it.label;
        const icon2 = icoNode(it.icon);
        if (icon2) mi.appendChild(icon2);
        mi.appendChild(mk('span', 'prj-t', it.label));
        menu.appendChild(mi);
    }

    head.appendChild(btnNew);
    head.appendChild(search);
    head.appendChild(count);
    head.appendChild(grow);
    head.appendChild(btnMore);
    head.appendChild(menu);

    // 浏览器原生选图：不走主进程对话框，FileReader 读成 dataURL 后交给 project-store。
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = true;
    fileInput.className = 'prj-file';
    fileInput.style.display = 'none';

    const hint = mk('div', 'prj-hint', '');
    hint.setAttribute('role', 'status');
    hint.setAttribute('aria-live', 'polite');
    const list = mk('div', 'prj-grid');
    const empty = mk('div', 'prj-empty', t('projects.empty'));
    const noresult = mk('div', 'prj-noresult', noResultText());

    panel.appendChild(head);
    panel.appendChild(hint);
    panel.appendChild(list);
    panel.appendChild(fileInput);

    let rows = [];
    let query = '';
    let currentId = '';
    let busy = false;
    let importing = false;
    let hintText = '';
    let hintAt = 0;
    let hintKind = ''; // '' | 'info' | 'error'：只有错误提示享受「不被顶掉」的特权
    let renaming = null; // { id, value }
    let off = null;
    let live = true;

    /** `…` 菜单开合：aria-expanded 与 hidden 必须同步，否则读屏与视觉会各说各话。 */
    function setMenu(open) {
        const on = !!open;
        menu.hidden = !on;
        btnMore.setAttribute('aria-expanded', on ? 'true' : 'false');
        if (on) {
            const first = menu.querySelector('.prj-mi');
            if (first && typeof first.focus === 'function') first.focus();
        }
    }

    function menuOpen() {
        return !menu.hidden;
    }

    /**
     * 面板内的轻提示。
     *
     * @param {string} text
     * @param {'info'|'error'} [kind] error 停留更久，且不会被紧随其后的普通提示顶掉
     */
    function say(text, kind) {
        const level = kind === 'error' ? 'error' : 'info';
        // 失败原因不能被「已刷新」这类普通提示盖掉：面板里只有一个 hint 位，
        // 盖掉就等于用户看不到为什么没成。
        if (level !== 'error' && hintKind === 'error' && Date.now() - hintAt < HINT_ERROR_MS - 20) return undefined;
        const ms = level === 'error' ? HINT_ERROR_MS : HINT_MS;
        hintText = String(text || '');
        hintAt = Date.now();
        hintKind = level;
        hint.textContent = hintText;
        hint.setAttribute('role', level === 'error' ? 'alert' : 'status');
        hint.classList.toggle('is-on', !!hintText);
        hint.classList.toggle('is-error', level === 'error');
        const timer = setTimeout(() => {
            if (!live) return;
            if (Date.now() - hintAt < ms - 20) return;
            hint.textContent = '';
            hintKind = '';
            hint.classList.remove('is-on');
            hint.classList.remove('is-error');
        }, ms);
        return timer;
    }

    if (!api) {
        panel.setAttribute('aria-label', t('projects.offline.aria'));
        panel.appendChild(mk('div', 'prj-off', t('projects.offline.text')));
        host.appendChild(panel);
        return { refresh() {}, destroy() {} };
    }

    function metaLine(r) {
        const parts = [];
        if (r.cels) parts.push(t('projects.meta.cels', { n: r.cels }));
        if (r.width && r.height) parts.push(r.width + '×' + r.height);
        // v2 起 doc.layers 语义是「对象」，展示口径跟着改（记录字段名仍叫 layers）
        if (r.layers) parts.push(t('projects.meta.layers', { n: r.layers }));
        const size = fmtBytes(r.bytes);
        if (size) parts.push(size);
        return parts.join(' · ') || t('projects.meta.empty');
    }

    function card(r) {
        const item = mk('article', 'prj-card');
        item.dataset.id = r.id;
        item.tabIndex = 0;
        if (r.id === currentId) item.classList.add('is-current');
        if (renaming && renaming.id === r.id) item.classList.add('is-renaming');
        const when = r.savedAt ? fmtTime(r.savedAt) : t('projects.card.unsaved');
        item.title = t('projects.card.title', { name: r.name, when: when });
        item.setAttribute('aria-label', t('projects.card.aria', { name: r.name, when: when }));

        const thumb = mk('div', 'prj-thumb');
        if (r.thumb) {
            const img = document.createElement('img');
            img.className = 'prj-thumb-img';
            img.src = r.thumb;
            img.alt = r.name;
            thumb.appendChild(img);
        } else {
            thumb.appendChild(mk('span', 'prj-thumb-empty', t('projects.thumb.empty')));
        }

        const meta = mk('div', 'prj-meta');
        const nameRow = mk('div', 'prj-name-row');
        if (renaming && renaming.id === r.id) {
            const input = mk('input', 'prj-rename');
            input.type = 'text';
            input.value = renaming.value;
            input.setAttribute('aria-label', t('projects.rename.aria'));
            input.style.width = '100%';
            input.style.minWidth = '80px';
            nameRow.appendChild(input);
            meta.appendChild(nameRow);
            // 图标标记，paint() 之后统一 focus（见 focusRename）
        } else {
            const name = mk('div', 'prj-name', r.name);
            nameRow.appendChild(name);
            if (r.id === currentId) nameRow.appendChild(mk('span', 'prj-badge', t('projects.card.badge')));
            meta.appendChild(nameRow);
        }
        meta.appendChild(mk('div', 'prj-sub', metaLine(r)));
        meta.appendChild(mk('div', 'prj-time', t('projects.card.time', { when: when })));

        const actions = mk('div', 'prj-actions');
        if (renaming && renaming.id === r.id) {
            actions.appendChild(button('rename-ok', t('projects.rename.ok'), t('projects.rename.ok.hint')));
            actions.appendChild(button('rename-cancel', t('projects.rename.cancel'), t('projects.rename.cancel.hint')));
        } else {
            for (const a of CARD_ACTIONS) {
                actions.appendChild(button(a.act, a.label, a.title, a.icon, a.danger ? 'prj-del' : ''));
            }
        }

        item.appendChild(thumb);
        item.appendChild(meta);
        item.appendChild(actions);
        return item;
    }

    function focusRename() {
        const input = list.querySelector('input.prj-rename');
        if (!input) return;
        input.focus();
        if (typeof input.select === 'function') input.select();
    }

    function paint() {
        const shown = filterRows(rows, query);
        count.textContent = countLabel(rows.length, shown.length, query);
        list.replaceChildren();
        if (!rows.length) {
            list.appendChild(empty);
            return;
        }
        // 有库但没匹配：给「没有匹配的项目」，不能退回空态 CTA（那会让用户以为库是空的）
        if (!shown.length) {
            list.appendChild(noresult);
            return;
        }
        for (const r of shown) list.appendChild(card(r));
        if (renaming) focusRename();
    }

    async function reload() {
        if (!live) return;
        try {
            const [items, cur] = await Promise.all([api.list(), Promise.resolve(api.current && api.current())]);
            if (!live) return;
            rows = (items || []).map(norm);
            currentId = cur && cur.id ? String(cur.id) : '';
            paint();
        } catch (err) {
            say(t('projects.err.read', { msg: (err && err.message) || err }));
        }
    }

    /**
     * 统一跑一个异步动作：防重入、按结果说话、结束后刷新列表。
     *
     * 判据用 `actVerdict`，不再用 `ok !== false` —— 后者把「接口没跑起来」（null）
     * 当成功，于是「存为文件」「导出精灵图」在桥不在时也会弹「已…」。
     *
     * @param {() => (boolean|object|null|Promise<any>)} fn
     * @param {string} [okText] 成功文案；不给就不说话（调用方自己按返回值补）
     * @returns {Promise<{ok:boolean,canceled:boolean,error:string,out:*}>}
     */
    async function run(fn, okText) {
        const idle = { ok: false, canceled: false, error: t('projects.busy'), out: null };
        if (busy) {
            // 不许静默：点被挡掉和点了没反应是两件事，用户必须能分辨
            say(idle.error);
            return idle;
        }
        busy = true;
        panel.classList.add('is-busy');
        panel.setAttribute('aria-busy', 'true');
        let verdict = idle;
        try {
            verdict = actVerdict(await fn());
            if (verdict.ok) {
                if (okText) say(okText);
            } else if (verdict.canceled) {
                say(verdict.error || t('projects.verdict.canceled'));
            } else {
                say(verdict.error || t('projects.verdict.incomplete'), 'error');
            }
        } catch (err) {
            const msg = (err && err.message) || err;
            // 把抛出去的原因也放进返回值：调用方拿到的不该只是「没成」
            verdict = actVerdict({ ok: false, error: t('projects.err.action', { msg: msg }) });
            say(verdict.error, 'error');
        } finally {
            busy = false;
            panel.classList.remove('is-busy');
            panel.removeAttribute('aria-busy');
            if (live) await reload();
        }
        return verdict;
    }

    function findRow(id) {
        return rows.find((r) => r.id === id) || null;
    }

    /** 导入图片：选中的图片依次插成 kind:'image' 对象（居中、每帧可见）。 */
    async function importPictures(files) {
        if (importing || !live) return;
        if (typeof ctx.doc !== 'function' || typeof ctx.setDoc !== 'function') {
            say(t('projects.import.noDocApi'));
            return;
        }
        const list_ = imageFiles(files);
        if (!list_.length) {
            say(t('projects.import.notImage'));
            return;
        }
        importing = true;
        panel.classList.add('is-busy');
        let ok = 0;
        let fail = 0;
        let lastId = '';
        try {
            for (const file of list_) {
                const dataUrl = await readAsDataURL(file);
                if (!dataUrl) {
                    fail++;
                    continue;
                }
                const spec = await imageElementFromFile({ name: file && file.name, dataUrl: dataUrl });
                if (!spec) {
                    fail++;
                    continue;
                }
                const doc = ctx.doc();
                const made = doc ? addImageElement(doc, spec) : null;
                if (!made) {
                    fail++;
                    continue;
                }
                ctx.setDoc(() => made.doc);
                lastId = made.element.id;
                ok++;
            }
            if (lastId && typeof ctx.setActiveLayer === 'function') {
                try {
                    ctx.setActiveLayer(lastId);
                } catch (err) {
                    /* 外壳接口细节差异，不影响已经插进去的对象 */
                }
            }
            // 「成功 N 张 + 失败 M 张」是一句话里的两个数，不拼句：两条整句各自带走自己的数
            if (ok) say(fail ? t('projects.import.doneSome', { ok: ok, fail: fail }) : t('projects.import.done', { ok: ok }));
            else say(t('projects.import.noPixels'));
        } catch (err) {
            say(t('projects.import.failed', { msg: (err && err.message) || err }));
        } finally {
            importing = false;
            panel.classList.remove('is-busy');
        }
    }

    function onFileChange() {
        // files 是活引用，先拷出来再清空 input（否则同名文件选第二次不触发 change）
        const picked = Array.from(fileInput.files || []);
        fileInput.value = '';
        importPictures(picked);
    }

    function commitRename() {
        if (!renaming) return;
        const next = String(renaming.value || '').trim();
        const id = renaming.id;
        const old = findRow(id);
        renaming = null;
        if (!next || (old && next === old.name)) {
            paint();
            return;
        }
        run(() => api.rename(id, next), t('projects.rename.done', { name: next }));
    }

    async function onAct(act, id, item) {
        const row = id ? findRow(id) : null;
        if (act === 'more') {
            setMenu(!menuOpen());
            return;
        }
        if (act === 'new') {
            await run(() => api.create(), t('projects.create.done'));
            return;
        }
        if (act === 'image') {
            if (typeof fileInput.click === 'function') fileInput.click();
            else say(t('projects.importFile.noPicker'));
            return;
        }
        if (act === 'import') {
            await run(() => api.importFile(), t('projects.importFile.done'));
            return;
        }
        if (act === 'sheet') {
            // 精灵图：主进程落盘 PNG + 每帧坐标 JSON
            const fn = (ctx && ctx.exportSpritesheet) || (api && api.exportSpritesheet);
            if (!fn) {
                say(t('projects.sheet.missing'), 'error');
                return;
            }
            // 不传 okText：成功文案要带帧数和目录，那是返回值里才有的东西
            const v = await run(() => fn({}));
            if (!v.ok) return; // 失败/取消的原因 run 已经说过一遍，别叠话
            const n = Number(v.out && v.out.count) || 0;
            const dir = (v.out && v.out.dir) || '';
            if (n > 0) say(dir ? t('projects.sheet.doneDir', { n: n, dir: dir }) : t('projects.sheet.done', { n: n }));
            else say(t('projects.sheet.empty'), 'error');
            return;
        }
        if (act === 'refresh') {
            await reload();
            say(t('projects.msg.refreshed'));
            return;
        }
        if (!row) return;
        if (act === 'open') {
            await run(() => api.open(row.id), t('projects.open.done', { name: row.name }));
            return;
        }
        if (act === 'rename') {
            renaming = { id: row.id, value: row.name };
            paint();
            return;
        }
        if (act === 'rename-ok') {
            commitRename();
            return;
        }
        if (act === 'rename-cancel') {
            renaming = null;
            paint();
            return;
        }
        if (act === 'export') {
            // 「存为文件」必须拿到路径才算成：外壳回成功却没给路径时不能弹「已存为文件」
            const v = await run(() => api.exportFile(row.id));
            if (v.ok && v.out && v.out.file) say(t('projects.save.done', { file: v.out.file }));
            else if (v.ok) say(t('projects.save.noPath'), 'error');
            return;
        }
        if (act === 'delete') {
            await run(() => api.remove(row.id), t('projects.remove.done', { name: row.name }));
            if (currentId === row.id) currentId = '';
            return;
        }
        if (item) item.classList.add('is-on');
    }

    function onClick(e) {
        // 变量名不叫 `t`：那会遮蔽 i18n 的 `t()`，同函数里后加的文案就取不到词条
        const target = e.target;
        const btn = target && typeof target.closest === 'function' ? target.closest('[data-act]') : null;
        if (btn) {
            e.preventDefault();
            const item = btn.closest('.prj-card');
            const id = item ? item.dataset.id : '';
            // `more` 自己负责开合，其余动作执行前先收起菜单
            if (btn.dataset.act !== 'more') setMenu(false);
            onAct(btn.dataset.act, id, item);
            return;
        }
        // 点到菜单与 `…` 之外就收起（菜单没有全屏遮罩，靠这一条收口）
        if (menuOpen() && target && typeof target.closest === 'function' && !target.closest('.prj-menu') && !target.closest('.prj-more')) {
            setMenu(false);
        }
        const picked = target && typeof target.closest === 'function' ? target.closest('.prj-card') : null;
        if (!picked) return;
        if (renaming) return;
        const row = findRow(picked.dataset.id);
        if (!row) return;
        // 点卡片任意处 = 载入（A 方案：守卫只活在 project-io 的 beforeSwitch 一处）
        run(() => api.open(row.id), t('projects.open.done', { name: row.name }));
    }

    function onKey(e) {
        // 菜单开着时 Esc 只收菜单，不再冒泡去关掉整个浮层
        if (e.key === 'Escape' && menuOpen()) {
            e.preventDefault();
            e.stopPropagation();
            setMenu(false);
            if (typeof btnMore.focus === 'function') btnMore.focus();
            return;
        }
        if (!renaming) {
            // 卡片可聚焦：Enter/空格等同于点卡片（键盘也能载入）
            if (e.key === 'Enter' || e.key === ' ') {
                const target = e.target;
                if (target && target.classList && target.classList.contains('prj-card') && target.dataset.id) {
                    e.preventDefault();
                    onAct('open', target.dataset.id, target);
                }
            }
            return;
        }
        if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            commitRename();
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            renaming = null;
            paint();
        }
    }

    function onInput(e) {
        const t = e.target;
        if (t && t.classList && t.classList.contains('prj-search-input')) {
            query = String(t.value || '');
            paint();
            return;
        }
        if (!renaming) return;
        if (t && t.classList && t.classList.contains('prj-rename')) renaming.value = t.value;
    }

    function onDoubleClick(e) {
        const picked = e.target && typeof e.target.closest === 'function' ? e.target.closest('.prj-card') : null;
        if (!picked || renaming) return;
        const row = findRow(picked.dataset.id);
        if (!row) return;
        renaming = { id: row.id, value: row.name };
        paint();
    }

    panel.addEventListener('click', onClick);
    panel.addEventListener('keydown', onKey);
    panel.addEventListener('input', onInput);
    panel.addEventListener('dblclick', onDoubleClick);
    fileInput.addEventListener('change', onFileChange);

    host.appendChild(panel);
    if (typeof api.subscribe === 'function') {
        try {
            off = api.subscribe(() => {
                if (live) reload();
            });
        } catch (err) {
            off = null;
        }
    }
    reload();

    return {
        /** 外壳在结构变化/切工作区后会调；重进面板时重新读库。 */
        refresh() {
            if (!live) return;
            reload();
        },
        focusFrame() {
            /* 项目库与帧无关 */
        },
        destroy() {
            live = false;
            panel.removeEventListener('click', onClick);
            panel.removeEventListener('keydown', onKey);
            panel.removeEventListener('input', onInput);
            panel.removeEventListener('dblclick', onDoubleClick);
            fileInput.removeEventListener('change', onFileChange);
            if (typeof off === 'function') {
                try {
                    off();
                } catch (err) {
                    /* 忽略 */
                }
                off = null;
            }
            if (panel.parentNode) panel.parentNode.removeChild(panel);
        },
    };
}
