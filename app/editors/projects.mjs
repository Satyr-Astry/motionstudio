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

/** 卡片上的次级动作。顺序即渲染顺序；`danger` 的那条走 `--danger`。 */
export const CARD_ACTIONS = [
    { act: 'rename', label: '重命名', icon: 'pencil', title: '修改项目名称（双击卡片也可以）' },
    { act: 'export', label: '存为文件', icon: 'save', title: '另存为 .msp 项目文件（旧版 .json 也行）' },
    { act: 'delete', label: '删除', icon: 'trash', danger: true, title: '从项目库删除（8 秒内可撤销）' },
];

/** `…` 菜单项。`sepBefore` 之后是「不属于项目库」的那一项，用分隔线标出层级差。 */
export const MENU_ITEMS = [
    { act: 'import', label: '导入项目文件', icon: 'folder-open', title: '从 .msp 或 .json 项目文件导入到库并打开' },
    { act: 'sheet', label: '导出精灵图', icon: 'grid', title: '把整段动画排成一张精灵图（PNG + 坐标 JSON）' },
    { act: 'refresh', label: '刷新', icon: 'rotate-ccw', title: '重新读取项目库' },
    { act: 'image', label: '导入图片到当前文档', icon: 'image-plus', sepBefore: true, title: '把一张图片作为对象插入当前文档（PNG / JPG / WebP）' },
];

/** 搜索有库但无匹配时的文案：不能退回空态 CTA（那会让用户以为库是空的）。 */
export const NO_RESULT_TEXT = '没有匹配的项目';

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
    if (!q) return '共 ' + n + ' 个';
    return '匹配 ' + (Number(matched) || 0) + ' / ' + n;
}


/** 规范化记录，容忍外壳给的不完整数据。 */
function norm(rec, i) {
    const r = rec || {};
    return {
        id: String(r.id || 'rec-' + i),
        name: String(r.name || '未命名项目'),
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
    return sameDay ? '今天 ' + hm : pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + hm;
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
    head.setAttribute('aria-label', '项目库操作');

    const btnNew = button('new', '新建项目', '用默认尺寸新建一个项目（当前有未保存改动时会先询问）', 'plus', 'prj-primary');

    const search = mk('label', 'prj-search');
    const searchIco = icoNode('search');
    const searchInput = mk('input', 'prj-search-input');
    searchInput.type = 'search';
    searchInput.placeholder = '搜索项目';
    searchInput.setAttribute('aria-label', '按名称搜索项目');
    if (searchIco) search.appendChild(searchIco);
    search.appendChild(searchInput);

    const count = mk('span', 'prj-count', '');
    count.setAttribute('aria-live', 'polite');
    const grow = mk('span', 'prj-gap');

    const btnMore = button('more', null, '更多操作', 'more-horizontal', 'prj-more');
    btnMore.setAttribute('aria-haspopup', 'menu');
    btnMore.setAttribute('aria-expanded', 'false');

    const menu = mk('div', 'prj-menu');
    menu.hidden = true;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '更多操作');
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
    const empty = mk('div', 'prj-empty', '还没有已保存的项目');
    const noresult = mk('div', 'prj-noresult', NO_RESULT_TEXT);

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

    function say(text) {
        hintText = String(text || '');
        hintAt = Date.now();
        hint.textContent = hintText;
        hint.classList.toggle('is-on', !!hintText);
        const timer = setTimeout(() => {
            if (!live) return;
            if (Date.now() - hintAt < HINT_MS - 20) return;
            hint.textContent = '';
            hint.classList.remove('is-on');
        }, HINT_MS);
        return timer;
    }

    if (!api) {
        panel.setAttribute('aria-label', '项目库（接口未就绪）');
        panel.appendChild(mk('div', 'prj-off', '外壳没有注入 ctx.project，项目库暂不可用。'));
        host.appendChild(panel);
        return { refresh() {}, destroy() {} };
    }

    function metaLine(r) {
        const parts = [];
        if (r.cels) parts.push(r.cels + ' 纹理');
        if (r.width && r.height) parts.push(r.width + '×' + r.height);
        // v2 起 doc.layers 语义是「对象」，展示口径跟着改（记录字段名仍叫 layers）
        if (r.layers) parts.push(r.layers + ' 对象');
        const size = fmtBytes(r.bytes);
        if (size) parts.push(size);
        return parts.join(' · ') || '空项目';
    }

    function card(r) {
        const item = mk('article', 'prj-card');
        item.dataset.id = r.id;
        item.tabIndex = 0;
        if (r.id === currentId) item.classList.add('is-current');
        if (renaming && renaming.id === r.id) item.classList.add('is-renaming');
        const when = r.savedAt ? fmtTime(r.savedAt) : '尚未保存';
        item.title = r.name + '（保存于 ' + when + '）· 点击卡片载入';
        item.setAttribute('aria-label', r.name + '，保存于 ' + when + '，点击载入');

        const thumb = mk('div', 'prj-thumb');
        if (r.thumb) {
            const img = document.createElement('img');
            img.className = 'prj-thumb-img';
            img.src = r.thumb;
            img.alt = r.name;
            thumb.appendChild(img);
        } else {
            thumb.appendChild(mk('span', 'prj-thumb-empty', '无纹理'));
        }

        const meta = mk('div', 'prj-meta');
        const nameRow = mk('div', 'prj-name-row');
        if (renaming && renaming.id === r.id) {
            const input = mk('input', 'prj-rename');
            input.type = 'text';
            input.value = renaming.value;
            input.setAttribute('aria-label', '项目名称');
            input.style.width = '100%';
            input.style.minWidth = '80px';
            nameRow.appendChild(input);
            meta.appendChild(nameRow);
            // 图标标记，paint() 之后统一 focus（见 focusRename）
        } else {
            const name = mk('div', 'prj-name', r.name);
            nameRow.appendChild(name);
            if (r.id === currentId) nameRow.appendChild(mk('span', 'prj-badge', '当前'));
            meta.appendChild(nameRow);
        }
        meta.appendChild(mk('div', 'prj-sub', metaLine(r)));
        meta.appendChild(mk('div', 'prj-time', '保存于 ' + when));

        const actions = mk('div', 'prj-actions');
        if (renaming && renaming.id === r.id) {
            actions.appendChild(button('rename-ok', '确定', '确认新名称（Enter）'));
            actions.appendChild(button('rename-cancel', '取消', '放弃修改（Esc）'));
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
            say('读取项目库失败：' + ((err && err.message) || err));
        }
    }

    /** 统一跑一个异步动作：防重入、失败提示、结束后刷新列表。 */
    async function run(fn, okText) {
        if (busy) {
            // 不许静默：点被挡掉和点了没反应是两件事，用户必须能分辨
            say('正在处理上一个操作，请稍候…');
            return;
        }
        busy = true;
        panel.classList.add('is-busy');
        panel.setAttribute('aria-busy', 'true');
        try {
            const ok = await fn();
            if (ok !== false && okText) say(okText);
            if (ok === false) say('操作未完成');
        } catch (err) {
            say('操作失败：' + ((err && err.message) || err));
        } finally {
            busy = false;
            panel.classList.remove('is-busy');
            panel.removeAttribute('aria-busy');
            if (live) await reload();
        }
    }

    function findRow(id) {
        return rows.find((r) => r.id === id) || null;
    }

    /** 导入图片：选中的图片依次插成 kind:'image' 对象（居中、每帧可见）。 */
    async function importPictures(files) {
        if (importing || !live) return;
        if (typeof ctx.doc !== 'function' || typeof ctx.setDoc !== 'function') {
            say('外壳没有提供文档接口，无法插入图片');
            return;
        }
        const list_ = imageFiles(files);
        if (!list_.length) {
            say('不是图片文件');
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
            if (ok) say('已导入 ' + ok + ' 张图片' + (fail ? '，' + fail + ' 张失败' : ''));
            else say('导入图片失败：读不出像素');
        } catch (err) {
            say('导入图片失败：' + ((err && err.message) || err));
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
        run(() => api.rename(id, next), '已重命名为 ' + next);
    }

    async function onAct(act, id, item) {
        const row = id ? findRow(id) : null;
        if (act === 'more') {
            setMenu(!menuOpen());
            return;
        }
        if (act === 'new') {
            await run(() => api.create(), '已新建项目');
            return;
        }
        if (act === 'image') {
            if (typeof fileInput.click === 'function') fileInput.click();
            else say('这个环境不支持选择文件');
            return;
        }
        if (act === 'import') {
            await run(() => api.importFile(), '已导入项目');
            return;
        }
        if (act === 'sheet') {
            // 精灵图：主进程落盘 PNG + 每帧坐标 JSON
            const fn = (ctx && ctx.exportSpritesheet) || (api && api.exportSpritesheet);
            if (fn) {
                await run(() => fn({}), '已导出精灵图');
            } else {
                say('当前版本不支持导出精灵图');
            }
            return;
        }
        if (act === 'refresh') {
            await reload();
            say('已刷新');
            return;
        }
        if (!row) return;
        if (act === 'open') {
            await run(() => api.open(row.id), '已载入 ' + row.name);
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
            await run(() => api.exportFile(row.id), '已存为文件：' + row.name);
            return;
        }
        if (act === 'delete') {
            await run(() => api.remove(row.id), '已删除 ' + row.name);
            if (currentId === row.id) currentId = '';
            return;
        }
        if (item) item.classList.add('is-on');
    }

    function onClick(e) {
        const t = e.target;
        const btn = t && typeof t.closest === 'function' ? t.closest('[data-act]') : null;
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
        if (menuOpen() && t && typeof t.closest === 'function' && !t.closest('.prj-menu') && !t.closest('.prj-more')) {
            setMenu(false);
        }
        const picked = t && typeof t.closest === 'function' ? t.closest('.prj-card') : null;
        if (!picked) return;
        if (renaming) return;
        const row = findRow(picked.dataset.id);
        if (!row) return;
        // 点卡片任意处 = 载入（A 方案：守卫只活在 project-io 的 beforeSwitch 一处）
        run(() => api.open(row.id), '已载入 ' + row.name);
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
                const t = e.target;
                if (t && t.classList && t.classList.contains('prj-card') && t.dataset.id) {
                    e.preventDefault();
                    onAct('open', t.dataset.id, t);
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
