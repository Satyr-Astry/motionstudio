/**
 * MotionStudio —— 项目库面板（editors/projects.mjs）
 *
 * 本地项目库的 UI，纯 DOM，不嵌 iframe：左侧列表以卡片形式展示已保存的项目
 * （缩略图、名称、画格数×尺寸、修改时间），点击卡片载入，
 * 右上角 `＋ 新建` / `导入图片` / `导入文件` / `刷新`，每张卡片上带 `重命名` / `删除` / `存为文件`。
 * 当前打开的项目卡片高亮（`.is-current`）。
 *
 * 「导入图片」走 `<input type="file" accept="image/*">` + FileReader（浏览器原生文件选择，
 * 不是主进程对话框）：选中的图片被当成一个 kind:'image' 对象插进**当前文档**的最上层，
 * 居中摆放，并从 0 秒起一直可见（画格只在 0 秒落一次）。数据转换在 shell/project-store.mjs 的 imageElementFromFile /
 * addImageElement 里，面板只负责取文件与换文档。
 *
 * 数据与动作全部来自外壳注入的 `ctx.project`（见 shell/app.mjs 的 projectApi）：
 *   list() → Promise<记录[]>  current() → {id,name}|null  open(id)  create(opts)
 *   save(name?)  rename(id,name)  remove(id)  importFile()  exportFile()  subscribe(fn) → off()
 * 面板本身不认识 IndexedDB、不认识文件对话框，换存储不影响这里。
 *
 * 本文件只写类名、不写样式文件（样式归 app/styles/*）。仅「重命名输入框所在行」这类
 * 必须在运行时才存在的对象用了极少量内联样式，保证在任何 CSS 下都可见。
 */

import { addImageElement, imageElementFromFile } from '../shell/project-store.mjs';

/** 规范化记录，容忍外壳给的不完整数据。 */
function norm(rec, i) {
    const r = rec || {};
    return {
        id: String(r.id || 'rec-' + i),
        name: String(r.name || '未命名项目'),
        savedAt: Number(r.savedAt) || 0,
        width: Number(r.width) || 0,
        height: Number(r.height) || 0,
        // v6：记录里数的是画格数。老记录只有 frames（帧数），读的时候兼容，写的时候不再写 frames。
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

function button(act, text, title) {
    const b = mk('button', 'prj-btn', text);
    b.type = 'button';
    b.dataset.act = act;
    if (title) b.title = title;
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

    const head = mk('div', 'prj-head');
    const title = mk('span', 'prj-title', '项目库');
    const count = mk('span', 'prj-count', '');
    const grow = mk('span', 'prj-gap');
    const btnNew = button('new', '＋ 新建', '用默认尺寸新建一个项目');
    const btnImage = button('image', '导入图片', '把一张图片作为对象插入当前文档（PNG / JPG / WebP）');
    const btnImport = button('import', '导入文件', '从 .msp 或 .json 项目文件导入到库并打开');
    const btnRefresh = button('refresh', '刷新', '重新读取项目库');
    const btnSheet = button('sheet', '导出精灵图', '把整段动画排成一张精灵图（PNG + 坐标 JSON）');
    head.appendChild(title);
    head.appendChild(count);
    head.appendChild(grow);
    head.appendChild(btnNew);
    head.appendChild(btnImage);
    head.appendChild(btnImport);
    head.appendChild(btnSheet);
    head.appendChild(btnRefresh);

    // 浏览器原生选图：不走主进程对话框，FileReader 读成 dataURL 后交给 project-store。
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = true;
    fileInput.className = 'prj-file';
    fileInput.style.display = 'none';

    const hint = mk('div', 'prj-hint', '');
    const list = mk('div', 'prj-list');
    const empty = mk('div', 'prj-empty', '还没有已保存的项目');

    panel.appendChild(head);
    panel.appendChild(hint);
    panel.appendChild(list);
    panel.appendChild(fileInput);

    let rows = [];
    let currentId = '';
    let busy = false;
    let importing = false;
    let hintText = '';
    let hintAt = 0;
    let renaming = null; // { id, value }
    let off = null;
    let live = true;

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
        title.textContent = '项目库（接口未就绪）';
        panel.appendChild(mk('div', 'prj-off', '外壳没有注入 ctx.project，项目库暂不可用。'));
        host.appendChild(panel);
        return { refresh() {}, destroy() {} };
    }

    function metaLine(r) {
        const parts = [];
        if (r.cels) parts.push(r.cels + ' 画格');
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
        if (r.id === currentId) item.classList.add('is-current');
        item.title = r.name + '（' + fmtTime(r.savedAt) + '）点击载入';

        const thumb = mk('div', 'prj-thumb');
        if (r.thumb) {
            const img = document.createElement('img');
            img.className = 'prj-thumb-img';
            img.src = r.thumb;
            img.alt = r.name;
            thumb.appendChild(img);
        } else {
            thumb.appendChild(mk('span', 'prj-thumb-empty', '空'));
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
        meta.appendChild(mk('div', 'prj-time', fmtTime(r.savedAt)));

        const actions = mk('div', 'prj-actions');
        if (renaming && renaming.id === r.id) {
            actions.appendChild(button('rename-ok', '确定', '确认新名称（Enter）'));
            actions.appendChild(button('rename-cancel', '取消', '放弃修改（Esc）'));
        } else {
            actions.appendChild(button('open', '载入', '载入这个项目'));
            actions.appendChild(button('rename', '重命名', '修改项目名称'));
            actions.appendChild(button('export', '存为文件', '另存为 .msp 项目文件（旧版 .json 也行）'));
            actions.appendChild(button('delete', '删除', '从项目库删除'));
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
        count.textContent = rows.length ? '共 ' + rows.length + ' 个' : '';
        list.replaceChildren();
        if (!rows.length) {
            list.appendChild(empty);
            return;
        }
        for (const r of rows) list.appendChild(card(r));
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
        if (busy) return;
        busy = true;
        panel.classList.add('is-busy');
        try {
            const ok = await fn();
            if (ok !== false && okText) say(okText);
            if (ok === false) say('操作未完成');
        } catch (err) {
            say('操作失败：' + ((err && err.message) || err));
        } finally {
            busy = false;
            panel.classList.remove('is-busy');
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
        const btn = e.target && typeof e.target.closest === 'function' ? e.target.closest('[data-act]') : null;
        if (btn) {
            e.preventDefault();
            const item = btn.closest('.prj-card');
            const id = item ? item.dataset.id : '';
            onAct(btn.dataset.act, id, item);
            return;
        }
        const picked = e.target && typeof e.target.closest === 'function' ? e.target.closest('.prj-card') : null;
        if (!picked) return;
        if (renaming) return;
        const row = findRow(picked.dataset.id);
        if (!row) return;
        run(() => api.open(row.id), '已载入 ' + row.name);
    }

    function onKey(e) {
        if (!renaming) return;
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
        if (!renaming) return;
        if (e.target && e.target.classList && e.target.classList.contains('prj-rename')) renaming.value = e.target.value;
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
