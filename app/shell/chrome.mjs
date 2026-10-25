/**
 * MotionStudio —— 顶栏与状态栏（外壳自己拥有的两块 DOM）
 *
 * 结构与类名：
 *   #topbar   .top-brand / .top-file > .top-file-btn / .top-project
 *             / .top-back / .top-ws > .top-ws-tab / .top-hint
 *   #statusbar .stb-left / .stb-right
 *
 * v8 的分工（为什么顶栏变短了）：
 * - **播放控制搬进时间轴**。VS Code 的顶栏只放窗口级的东西，After Effects /
 *   Aseprite 的时间码与 transport 也都在时间轴面板里 —— 播放头属于时间轴。
 *   顶栏塞一个 transport 的后果是同一件事有两个入口、两处状态、两套禁用逻辑：
 *   按顶栏的 › 时间轴上的纹理不动，就是这个原因。
 * - 顶栏因此只剩：品牌 / 文件动作 / 项目名 / 返回 / 工作区切换 / 临时提示。
 * - `.top-hint` 平时是空的（只在 flash() 有消息时出现），不再常驻教程文案：
 *   常驻提示放在状态栏，那里才是「一直在但不抢眼」的位置。
 *
 * 这里不碰文档、不碰引擎：只通过 api 读状态、发命令，方便单独测试。
 */

import { icon, escapeAttr } from '../core/icons.mjs';

/** 三个工作区：id 与外壳共用（app.mjs 直接 import 这份清单做校验）。 */
export const WS_TABS = Object.freeze([
    { id: 'animate', title: '编排' },
    { id: 'draw', title: '画板' },
    { id: 'free', title: '设置' },
]);

export const WS_IDS = WS_TABS.map((t) => t.id);

/**
 * 文件按钮：[act, 图标名, 按钮文字（null = 纯图标）, 中文标题（带快捷键）]。
 * 图标来自 core/icons.mjs（自绘 24×24 线性图标，无第三方依赖）。
 * 文字一个都不删：图标解决「扫描成本」，文字解决「这个按钮到底是什么」，
 * 纯图标只用在「＋ / 撤销 / 重做」这种全行业已有共识的动作上。
 * 放在品牌与工作区 tab 之间：左边「文件」是项目级操作，右边才是视图级切换。
 */
const FILE_ACTIONS = [
    ['new', 'plus', null, '新建项目'],
    ['save', 'save', '保存', '保存项目（Ctrl+S）'],
    ['open', 'folder-open', '打开', '打开项目库（Ctrl+O）'],
    ['import', 'import', '导入', '导入 PSD / PNG / JPG / WebP 到当前项目'],
    ['export', 'export', '导出', '导出 PNG 序列（Ctrl+Shift+E）'],
    // 撤销/重做原本在「工具」区里，编排模式不显示工具条后它们会消失，所以上移到这里。
    ['undo', 'undo', null, '撤销（Ctrl+Z）'],
    ['redo', 'redo', null, '重做（Ctrl+Shift+Z）'],
];

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
}

function call(fn, fallback) {
    try {
        return typeof fn === 'function' ? fn() : fallback;
    } catch (err) {
        return fallback;
    }
}

function fmt(n, d) {
    const v = Number(n);
    return (Number.isFinite(v) ? v : 0).toFixed(d);
}

/** 时间戳 → HH:MM:SS；拿不到有效值时返回空串（宁可整段不显示，也不显示一个假时间）。 */
function fmtClock(ms) {
    const v = Number(ms);
    if (!Number.isFinite(v) || v <= 0) return '';
    const d = new Date(v);
    const p = (n) => String(n).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/**
 * 构建顶栏。host 通常是 #topbar（可能已有其它内容，这里整体接管）。
 * @param {Element} host
 * @param {{workspace?:Function,setWorkspace?:Function,hint?:Function,file?:Function,
 *          projectName?:Function,dirty?:Function}} api
 * @returns {{update:Function, el:Element}}
 */
export function buildTopbar(host, api) {
    const a = api || {};
    if (!host) return { update() {}, el: null };
    host.textContent = '';

    const brand = el('div', 'top-brand', 'MotionStudio');

    // 文件组：新建 / 保存 / 打开 / 导入 / 导出。act 由外壳的 onFileAct 分发。
    const file = el('div', 'top-file');
    for (const [act, iconName, text, title] of FILE_ACTIONS) {
        const b = document.createElement('button');
        b.type = 'button';
        // 纯图标 → ms-icon-btn（22×22 方按钮 + 20×20 热区）；图标 + 文字 → ms-icon-label
        b.className = 'top-file-btn ' + (text ? 'ms-icon-label' : 'ms-icon-btn');
        b.innerHTML = icon(iconName) + (text ? '<span>' + escapeAttr(text) + '</span>' : '');
        b.dataset.act = act;
        b.title = title;
        b.setAttribute('aria-label', title);
        b.addEventListener('click', () => {
            if (typeof a.file === 'function') a.file(act);
        });
        file.appendChild(b);
    }

    // 当前项目名：没保存过就是「未命名项目」，保存后带文件名。
    // ── 项目区：状态图标 + 名称 + 脏点 ────────────────────────────────
    // 三段拆开是为了让「有未保存改动」能自己带 aria-label，
    // 而不是变成名字末尾一个读屏软件念不出来、视觉上也看不出含义的字符。
    const project = el('div', 'top-project', '');
    const projectIcon = el('span', 'top-project-ico', '');
    projectIcon.setAttribute('aria-hidden', 'true');   // 语义已由文字表达
    const projectText = el('span', 'top-project-text', '');
    const projectDot = el('span', 'top-project-dot', '•');
    projectDot.setAttribute('role', 'img');
    projectDot.setAttribute('aria-label', '有未保存的改动');
    projectDot.title = '有未保存的改动';
    projectDot.hidden = true;
    project.append(projectIcon, projectText, projectDot);

    // 返回编排：画板 / 设置是从编排「进去」的子视图，必须有一条显眼的回路。
    const back = el('button', 'top-back ms-icon-label');
    back.type = 'button';
    back.innerHTML = icon('arrow-left') + '<span>编排</span>';
    back.title = '回到编排工作区（Esc 也可以）';
    back.setAttribute('aria-label', back.title);
    back.addEventListener('click', () => {
        if (typeof a.setWorkspace === 'function') a.setWorkspace('animate');
    });

    const ws = el('div', 'top-ws');
    const tabs = new Map();
    for (const t of WS_TABS) {
        const b = el('button', 'top-ws-tab', t.title);
        b.type = 'button';
        b.dataset.ws = t.id;
        b.title = t.title + '工作区';
        b.addEventListener('click', () => {
            if (typeof a.setWorkspace === 'function') a.setWorkspace(t.id);
        });
        tabs.set(t.id, b);
        ws.appendChild(b);
    }

    const hint = el('div', 'top-hint', '');
    hint.classList.add('is-empty');

    host.appendChild(brand);
    host.appendChild(file);
    host.appendChild(project);
    host.appendChild(back);
    host.appendChild(ws);
    host.appendChild(hint);

    // 保存反馈的寿命：长到能看见、短到不占位。任务书上限 800ms。
    const SAVE_FLASH_MS = 800;
    let flashTimer = 0;
    let flashOn = false;
    let prevDirty = null;

    function armSaveFlash() {
        flashOn = true;
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => {
            flashOn = false;
            update();
        }, SAVE_FLASH_MS);
    }

    function projectTitle(f) {
        const bits = [];
        if (f.inLibrary) bits.push('当前项目：' + f.pname);
        else bits.push('尚未保存到项目库（Ctrl+S 命名并入库）');
        if (f.dirty) bits.push('有未保存改动');
        // 这两项要存储层提供（app.mjs 的 api 里还没有），拿不到就整段省略，
        // 不猜时间、也不猜介质 —— 缺字段时 title 依然每句为真。
        const clock = fmtClock(f.savedAt);
        if (clock) bits.push('上次保存 ' + clock);
        if (f.storeKind) bits.push('存储：' + f.storeKind);
        return bits.join(' · ');
    }

    function update() {
        const cur = call(a.workspace, WS_IDS[0]);
        for (const [id, b] of tabs) b.classList.toggle('is-on', id === cur);

        // 画板 / 设置里才需要「返回编排」；编排里它没有意义，直接隐藏。
        back.style.display = cur === 'animate' ? 'none' : '';

        const pname = String(call(a.projectName, '') || '').trim();
        const dirty = !!call(a.dirty, false);
        const inLibrary = pname.length > 0;
        // 「未命名且未入库」与「有名字但没保存」以前看起来一模一样，这里把前者说清。
        const label = inLibrary ? pname : '未命名项目（未入库）';
        const justSaved = prevDirty === true && dirty === false;
        if (justSaved) armSaveFlash();

        projectIcon.innerHTML = icon(inLibrary ? 'save' : 'folder-open', { size: 'sm' });
        projectText.textContent = (justSaved || flashOn) ? label + ' · 已保存' : label;
        projectDot.hidden = !dirty;
        project.classList.toggle('is-dirty', dirty);
        project.classList.toggle('is-just-saved', justSaved || flashOn);
        project.title = projectTitle({
            inLibrary,
            pname,
            dirty,
            savedAt: call(a.projectSavedAt, 0),
            storeKind: call(a.projectStoreKind, ''),
        });
        prevDirty = dirty;

        // 提示位只显示临时消息：没有消息时腾出空间，不再常驻一行教程。
        const h = call(a.hint, '');
        const text = h == null ? '' : String(h);
        if (hint.textContent !== text) hint.textContent = text;
        hint.classList.toggle('is-empty', !text);
    }

    update();
    return { update, el: host };
}

/**
 * 构建状态栏。
 * @param {Element} host 通常是 #statusbar
 * @param {object} [api] 预留：将来可以挂点击跳转
 * @returns {{setLeft:Function,setRight:Function,el:Element}}
 */
export function buildStatusbar(host, api) {
    void api;
    if (!host) return { setLeft() {}, setRight() {}, el: null };
    host.textContent = '';
    const left = el('span', 'stb-left', '');
    const right = el('span', 'stb-right', '');
    host.appendChild(left);
    host.appendChild(right);

    return {
        setLeft(t) {
            left.textContent = t == null ? '' : String(t);
        },
        setRight(t) {
            right.textContent = t == null ? '' : String(t);
        },
        el: host,
    };
}
