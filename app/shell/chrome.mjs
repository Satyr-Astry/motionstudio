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
import { t } from '../i18n/index.mjs';

/** 三个工作区：id 与外壳共用（app.mjs 直接 import 这份清单做校验）。 */
// title 写成 getter：语言是运行时才定的（默认识别 en），模块级常量不能提前把译文烤死。
// 读 `.title` 的地方照旧，只是每次读出来的是当前语言。
export const WS_TABS = Object.freeze([
    { id: 'animate', get title() { return t('shell.ws.animate'); } },
    { id: 'draw', get title() { return t('shell.ws.draw'); } },
    { id: 'free', get title() { return t('shell.ws.free'); } },
]);

// 回调参数叫 tab 不叫 t：t 是词条函数，同名参数读起来像「拿函数当工作区」
export const WS_IDS = WS_TABS.map((tab) => tab.id);

/**
 * 文件按钮：[act, 图标名, 按钮文字（null = 纯图标）, 中文标题（带快捷键）]。
 * 图标来自 core/icons.mjs（自绘 24×24 线性图标，无第三方依赖）。
 * 文字一个都不删：图标解决「扫描成本」，文字解决「这个按钮到底是什么」，
 * 纯图标只用在「＋ / 撤销 / 重做」这种全行业已有共识的动作上。
 * 放在品牌与工作区 tab 之间：左边「文件」是项目级操作，右边才是视图级切换。
 */
// 第 3/4 项是词条键：文字与 title 在 buildTopbar 里按当前语言解析（切语言时能重写）
const FILE_ACTIONS = [
    ['new', 'plus', null, 'shell.file.newTitle'],
    ['save', 'save', 'shell.file.saveLabel', 'shell.file.saveTitle'],
    ['open', 'folder-open', 'shell.file.openLabel', 'shell.file.openTitle'],
    ['import', 'import', 'shell.file.importLabel', 'shell.file.importTitle'],
    ['export', 'export', 'shell.file.exportLabel', 'shell.file.exportTitle'],
    // 撤销/重做原本在「工具」区里，编排模式不显示工具条后它们会消失，所以上移到这里。
    ['undo', 'undo', null, 'shell.file.undoTitle'],
    ['redo', 'redo', null, 'shell.file.redoTitle'],
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
    const fileButtons = [];
    for (const [act, iconName, textKey, titleKey] of FILE_ACTIONS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.act = act;
        b.addEventListener('click', () => {
            if (typeof a.file === 'function') a.file(act);
        });
        fileButtons.push({ b: b, iconName: iconName, textKey: textKey, titleKey: titleKey, text: null, title: null });
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
    projectDot.hidden = true;
    project.append(projectIcon, projectText, projectDot);

    // 返回编排：画板 / 设置是从编排「进去」的子视图，必须有一条显眼的回路。
    const back = el('button', 'top-back ms-icon-label');
    back.type = 'button';
    back.innerHTML = icon('arrow-left') + '<span></span>';
    const backText = back.querySelector('span');
    back.addEventListener('click', () => {
        if (typeof a.setWorkspace === 'function') a.setWorkspace('animate');
    });

    const ws = el('div', 'top-ws');
    const tabs = new Map();
    for (const tab of WS_TABS) {
        const b = el('button', 'top-ws-tab', '');
        b.type = 'button';
        b.dataset.ws = tab.id;
        b.addEventListener('click', () => {
            if (typeof a.setWorkspace === 'function') a.setWorkspace(tab.id);
        });
        tabs.set(tab.id, b);
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
        if (f.inLibrary) bits.push(t('shell.topbar.currentProject', { name: f.pname }));
        else bits.push(t('shell.topbar.notInLibrary'));
        if (f.dirty) bits.push(t('shell.topbar.dirtyShort'));
        // 这两项要存储层提供（app.mjs 的 api 里还没有），拿不到就整段省略，
        // 不猜时间、也不猜介质 —— 缺字段时 title 依然每句为真。
        const clock = fmtClock(f.savedAt);
        if (clock) bits.push(t('shell.topbar.savedAt', { time: clock }));
        if (f.storeKind) bits.push(t('shell.topbar.storeKind', { kind: f.storeKind }));
        return bits.join(' · ');
    }

    /**
     * 静态文案（按钮文字 / title / tab 名 / 脏点标签）按当前语言重写。
     * 为什么不在 build 时写死：切语言只重挂工作区面板，顶栏是 boot 建的一次性 DOM，
     * 不重写就会出现「面板英文、顶栏中文」。赋值前都比一遍，避免每次 flash 都动 DOM。
     */
    function syncLabels() {
        for (const f of fileButtons) {
            const text = f.textKey ? t(f.textKey) : null;
            const title = t(f.titleKey);
            if (f.text !== text) {
                f.text = text;
                f.b.className = 'top-file-btn ' + (text ? 'ms-icon-label' : 'ms-icon-btn');
                f.b.innerHTML = icon(f.iconName) + (text ? '<span>' + escapeAttr(text) + '</span>' : '');
            }
            if (f.title !== title) {
                f.title = title;
                f.b.title = title;
                f.b.setAttribute('aria-label', title);
            }
        }
        const backLabel = t('shell.topbar.backLabel');
        if (backText.textContent !== backLabel) backText.textContent = backLabel;
        const backTitle = t('shell.topbar.backTitle');
        if (back.title !== backTitle) {
            back.title = backTitle;
            back.setAttribute('aria-label', backTitle);
        }
        for (const tab of WS_TABS) {
            const b = tabs.get(tab.id);
            if (!b) continue;
            const name = tab.title;
            if (b.textContent !== name) b.textContent = name;
            const tabTitle = t('shell.topbar.tabTitle', { title: name });
            if (b.title !== tabTitle) b.title = tabTitle;
        }
        const dirtyLabel = t('shell.topbar.dirty');
        if (projectDot.title !== dirtyLabel) {
            projectDot.title = dirtyLabel;
            projectDot.setAttribute('aria-label', dirtyLabel);
        }
    }

    function update() {
        syncLabels();
        const cur = call(a.workspace, WS_IDS[0]);
        for (const [id, b] of tabs) b.classList.toggle('is-on', id === cur);

        // 画板 / 设置里才需要「返回编排」；编排里它没有意义，直接隐藏。
        back.style.display = cur === 'animate' ? 'none' : '';

        const pname = String(call(a.projectName, '') || '').trim();
        const dirty = !!call(a.dirty, false);
        const inLibrary = pname.length > 0;
        // 「未命名且未入库」与「有名字但没保存」以前看起来一模一样，这里把前者说清。
        const label = inLibrary ? pname : t('shell.topbar.untitled');
        const justSaved = prevDirty === true && dirty === false;
        if (justSaved) armSaveFlash();

        projectIcon.innerHTML = icon(inLibrary ? 'save' : 'folder-open', { size: 'sm' });
        projectText.textContent = (justSaved || flashOn) ? t('shell.topbar.justSaved', { label: label }) : label;
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
        // 单行 + ellipsis（见 styles/shell.css 的 .top-hint）：错误消息里有补救动作，
        // 被截掉就等于没说。整句挂在 title 上，悬停可读、不动既有布局。
        if (text) hint.title = text;
        else hint.removeAttribute('title');
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
    // 多选读数：复用 .stb-right 的样式（不新增 CSS），只在选中多于 1 个对象时出现。
    // 走事件而不是读 ctx —— 选择集合是各面板的内部状态，状态栏只订阅结果、不持有它。
    const selCount = el('span', 'stb-right stb-sel', '');
    // 关键帧读数：同一族的 ms:key-selection，由 timeline-keys.mjs 广播
    const keySel = el('span', 'stb-right stb-keysel', '');
    host.appendChild(left);
    host.appendChild(keySel);
    host.appendChild(selCount);
    host.appendChild(right);

    const onSel = (e) => {
        const ids = e && e.detail && Array.isArray(e.detail.ids) ? e.detail.ids : [];
        selCount.textContent = ids.length > 1 ? t('shell.status.selObjects', { n: ids.length }) : '';
    };
    if (typeof document !== 'undefined') document.addEventListener('ms:layer-selection', onSel);

    const onKeySel = (e) => {
        const d = (e && e.detail) || {};
        const n = Number(d.count) || 0;
        // 局部量叫 pt 不叫 t：t 是词条函数
        const pt = Number(d.primaryT);
        keySel.textContent = n > 1
            ? t('shell.status.selKeys', { n: n, t: Number.isFinite(pt) ? pt.toFixed(2) : '—' })
            : '';
    };
    if (typeof document !== 'undefined') document.addEventListener('ms:key-selection', onKeySel);

    return {
        setLeft(t) {
            left.textContent = t == null ? '' : String(t);
        },
        setRight(t) {
            right.textContent = t == null ? '' : String(t);
        },
        el: host,
        destroy() {
            if (typeof document !== 'undefined') {
                document.removeEventListener('ms:layer-selection', onSel);
                document.removeEventListener('ms:key-selection', onKeySel);
            }
        },
    };
}
