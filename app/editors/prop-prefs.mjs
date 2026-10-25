/**
 * MotionStudio —— 偏好面板（设置模式的第四块）
 *
 * 与「文档」面板的分工：文档面板改的是项目内容（写进 .json，跟着项目走）；
 * 这里改的是「这台机器上的使用习惯」，落 localStorage 的 ms.prefs：
 * 换项目不丢，也不会污染项目文件。
 *
 * 每项都尽量落到真实执行路径，落不进去的只做存储，并在界面上用一行小字
 * 说明缺什么 —— 宁可是「还没接上」，也不要一个点了没反应的假开关。
 * 生效现状（改代码时请同步这张表）：
 * - 自动保存间隔：生效。拍子在 shell/project-io.mjs 的 installProjectSafety() 里
 *   （1s 一拍、间隔读本面板写入的 autoSave），跟应用活，不跟本面板存亡；
 * - 撤销步数上限：只存储（paint/engine.mjs:79 的 createHistory(120) 写死，
 *   且没有 setHistoryLimit；这里会尽力调一次，有则生效、没有就静默）；
 * - 时间轴吸附网格：只存储（timeline-geo.mjs 的 SNAP_GRID 是常量导出，
 *   需要 timeline 侧改读 ms.prefs.snapGrid）；
 * - 新对象默认尺寸：写进 doc-state 的偏好快照（setPrefs / prefObjectSize），
 *   新建对象的调用点（editors/layers.mjs 的 'add' 分支）还没接；
 * - 画布背景：生效，--pref-cv-bg 驱动 .cv-host 底色/棋盘格（板上透明棋盘仍是引擎像素）。
 */

import { makeGroup, makeRow, makeNum, makeSeg } from './prop-kit.mjs';
// 键位表与图例的唯一数据源：设置里这份、时间轴「?」浮层、帮助面板读的是同一份常量
import { SHORTCUT_GROUPS, LEGEND_ITEMS } from './help.mjs';
import { icon } from '../core/icons.mjs';
import { engine, setPrefs } from '../shell/doc-state.mjs';

const KEY = 'ms.prefs';

/** 缺省值 = 装面板之前的实际行为，这样升级不会悄悄改掉用户的手感。 */
const DEFAULTS = {
    autoSave: 0, // 秒，0 = 关
    undoLimit: 100,
    snapGrid: 0.1,
    sizePreset: '900',
    sizeW: 900,
    sizeH: 640,
    bg: 'checker',
};

const SAVE_OPTS = [
    ['0', '关'],
    ['30', '30s'],
    ['60', '1min'],
    ['300', '5min'],
];
const UNDO_OPTS = [
    ['50', '50'],
    ['100', '100'],
    ['200', '200'],
    ['500', '500'],
];
const GRID_OPTS = [
    ['0.05', '0.05s'],
    ['0.1', '0.1s'],
    ['0.25', '0.25s'],
];
const SIZE_OPTS = [
    ['320', '320×320'],
    ['640', '640×480'],
    ['900', '900×640'],
    ['custom', '自定义'],
];
const SIZE_PRESETS = { 320: [320, 320], 640: [640, 480], 900: [900, 640] };
const BG_OPTS = [
    ['checker', '棋盘格'],
    ['dark', '纯深灰'],
    ['white', '纯白'],
];
/**
 * 视口底色：两档纯色 + 一档棋盘格，三档都是可直接喂 `background` 简写的值。
 * 画板内部的透明棋盘是引擎逐像素画的（paint/engine.mjs），CSS 盖不住，所以这里管的是画布视口。
 */
const BG_CHECKER = '#0f1114 repeating-conic-gradient(#16181d 0 25%, #101216 0 50%) 0 0 / 20px 20px';
const BG_COLORS = { checker: BG_CHECKER, dark: '#23262c', white: '#ffffff' };
/** 色板圆点只用纯色，棋盘格档用一深一浅两格色块示意。 */
const BG_SWATCH = {
    checker: 'repeating-conic-gradient(#16181d 0 25%, #101216 0 50%) 0 0 / 6px 6px',
    dark: '#23262c',
    white: '#ffffff',
};

function hasVal(opts, v) {
    const s = String(v);
    for (const [val] of opts) if (val === s) return true;
    return false;
}

function clampRound(v, lo, hi, dflt) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
}

/** 读盘 + 逐项校验：手改过 / 旧版本残留的键一律退回缺省，不让面板被脏数据带崩。 */
function readPrefs() {
    let raw = null;
    try {
        raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    } catch (err) {
        raw = null; // JSON 坏了就整份重来，偏好丢了比面板抛异常好
    }
    const o = raw && typeof raw === 'object' ? raw : {};
    const sizePreset = hasVal(SIZE_OPTS, o.sizePreset) ? String(o.sizePreset) : DEFAULTS.sizePreset;
    return {
        autoSave: hasVal(SAVE_OPTS, o.autoSave) ? Number(o.autoSave) : DEFAULTS.autoSave,
        undoLimit: hasVal(UNDO_OPTS, o.undoLimit) ? Number(o.undoLimit) : DEFAULTS.undoLimit,
        snapGrid: hasVal(GRID_OPTS, o.snapGrid) ? Number(o.snapGrid) : DEFAULTS.snapGrid,
        sizePreset,
        // 优先新键（外壳偏好快照的键名），兜底旧版本只写过的 sizeW/sizeH，
        // 老用户的设置不会在升级后归零。
        sizeW: clampRound(o.objectW != null ? o.objectW : o.sizeW, 16, 4096, DEFAULTS.sizeW),
        sizeH: clampRound(o.objectH != null ? o.objectH : o.sizeH, 16, 4096, DEFAULTS.sizeH),
        bg: hasVal(BG_OPTS, o.bg) ? String(o.bg) : DEFAULTS.bg,
    };
}

/**
 * 一行「图标 + 动作名 + 键位」。
 * 动作名走 text node、只有图标走 icon() 的 innerHTML —— 名字里出现 < 或 & 也不会破结构。
 */
function makeHelpRow(item) {
    const row = document.createElement('div');
    row.className = 'prop-row pref-help-row';
    if (item.hint) row.title = item.hint;
    const name = document.createElement('span');
    name.className = 'pref-help-name';
    name.innerHTML = icon(item.icon, { size: 'sm' });
    name.appendChild(document.createTextNode(item.name));
    const keys = document.createElement('kbd');
    keys.className = 'pref-help-keys';
    keys.textContent = item.keys && String(item.keys).trim() ? item.keys : '鼠标';
    row.append(name, keys);
    return row;
}

/** 图例一行：形状标记 + 名字 + 「离散 / 插值」。文案与时间轴「?」浮层同源。 */
function makeLegendRow(item) {
    const row = document.createElement('div');
    row.className = 'prop-row pref-help-row';
    row.title = item.text;
    const name = document.createElement('span');
    name.className = 'pref-help-name';
    const mark = document.createElement('span');
    mark.className = 'pref-help-mark is-' + item.kind;
    mark.textContent = item.mark;
    name.append(mark, document.createTextNode(item.name));
    const keys = document.createElement('kbd');
    keys.className = 'pref-help-keys';
    keys.textContent = item.kind === 'cel' ? '离散' : '插值';
    row.append(name, keys);
    return row;
}

export function mount(el, ctx) {
    const prefs = readPrefs();
    const groups = [];

    /* ─────────────────── 自动保存 ─────────────────── */

    const saveBody = makeGroup(el, '自动保存', 'pref-save');
    groups.push(saveBody);
    const saveBtns = makeSeg(saveBody, '间隔', SAVE_OPTS, String(prefs.autoSave));
    addNote(saveBody, '未命名的项目不自动保存（绝不弹名字或路径对话框）。');

    /* ─────────────────── 撤销 ─────────────────── */

    const undoBody = makeGroup(el, '撤销', 'pref-undo');
    groups.push(undoBody);
    const undoBtns = makeSeg(undoBody, '步数上限', UNDO_OPTS, String(prefs.undoLimit));
    addNote(undoBody, '引擎当前固定 120 步，值已存盘；接上 setHistoryLimit 后即生效。');

    /* ─────────────────── 编辑 ─────────────────── */

    const editBody = makeGroup(el, '编辑', 'pref-edit');
    groups.push(editBody);
    const gridBtns = makeSeg(editBody, '吸附网格', GRID_OPTS, String(prefs.snapGrid));
    addNote(editBody, '时间轴拖动时的吸附步长，timeline 侧读 ms.prefs.snapGrid 后生效。');

    const sizeBtns = makeSeg(editBody, '新对象尺寸', SIZE_OPTS, prefs.sizePreset);
    const wInput = makeNum(editBody, '自定义宽', { min: 16, max: 4096, step: 1, value: prefs.sizeW, key: 'pref-w' });
    const hInput = makeNum(editBody, '自定义高', { min: 16, max: 4096, step: 1, value: prefs.sizeH, key: 'pref-h' });
    addNote(editBody, '新建对象的位图尺寸，等对象创建处读 prefObjectSize() 后生效。');

    /* ─────────────────── 外观 ─────────────────── */

    const lookBody = makeGroup(el, '外观', 'pref-look');
    groups.push(lookBody);
    const bgBtns = makeSeg(lookBody, '画布背景', BG_OPTS, prefs.bg);
    // 色板只是给选中的那格上个色，真正的底色由 --pref-cv-bg 驱动 .cv-host
    for (const [val, btn] of bgBtns) {
        if (!BG_SWATCH[val]) continue;
        btn.classList.add('pref-swatch');
        btn.style.setProperty('--pref-swatch', BG_SWATCH[val]);
    }
    addNote(lookBody, '三档都改画布视口底色；画板内部的透明棋盘由引擎绘制，改它要动 paint/engine.mjs。');

    /* ─────────────────── 快捷键 / 图例（唯一权威表） ─────────────────── */

    for (const group of SHORTCUT_GROUPS) {
        const body = makeGroup(el, group.title, 'help-' + group.id);
        groups.push(body);
        for (const item of group.items) body.appendChild(makeHelpRow(item));
    }

    const legendBody = makeGroup(el, '图例', 'help-legend');
    groups.push(legendBody);
    for (const item of LEGEND_ITEMS) legendBody.appendChild(makeLegendRow(item));
    addNote(
        legendBody,
        '画格是离散的（到点换图），关键帧是插值的（中间有过渡）。这张表与时间轴「?」浮层读同一份数据（editors/help.mjs），改一处即两处同步。'
    );

    /* ─────────────────── 写入 ─────────────────── */

    function addNote(body, text) {
        const row = makeRow(body, '');
        row.classList.add('pref-note');
        row.textContent = text;
        return row;
    }

    /** 存盘 + 立刻应用：localStorage 失败也不能让界面与内存状态脱节。 */
    function commit() {
        try {
            // 同时写一份外壳键名（objectW/objectH）：启动时 doc-state 的 loadPrefs 从
            // 这个 key 读的正是那对键，只存 sizeW/sizeH 会让「重启后新对象尺寸悄悄回缺省」。
            localStorage.setItem(KEY, JSON.stringify(Object.assign({}, prefs, {
                objectW: prefs.sizeW,
                objectH: prefs.sizeH,
            })));
        } catch (err) {
            /* 无痕模式 / 配额满：本次会话内仍然生效 */
        }
        applyPrefs();
        paintControls();
    }

    saveBtns.forEach((btn, val) => {
        btn.addEventListener('click', () => {
            prefs.autoSave = Number(val);
            commit();
        });
    });
    undoBtns.forEach((btn, val) => {
        btn.addEventListener('click', () => {
            prefs.undoLimit = Number(val);
            commit();
        });
    });
    gridBtns.forEach((btn, val) => {
        btn.addEventListener('click', () => {
            prefs.snapGrid = Number(val);
            commit();
        });
    });
    bgBtns.forEach((btn, val) => {
        btn.addEventListener('click', () => {
            prefs.bg = val;
            commit();
        });
    });
    sizeBtns.forEach((btn, val) => {
        btn.addEventListener('click', () => {
            prefs.sizePreset = val;
            const preset = SIZE_PRESETS[val];
            // 选预设就把两个数字框同步成预设值，免得下次切回自定义拿到旧数
            if (preset) {
                prefs.sizeW = preset[0];
                prefs.sizeH = preset[1];
            }
            commit();
        });
    });

    const readSize = (input, key) => {
        const v = clampRound(input.value, 16, 4096, prefs[key]);
        prefs[key] = v;
        // 选自定义时不再有预设可依附，切过去让数字框自己说话
        prefs.sizePreset = 'custom';
        commit();
    };
    wInput.addEventListener('change', () => readSize(wInput, 'sizeW'));
    hInput.addEventListener('change', () => readSize(hInput, 'sizeH'));

    /* ─────────────────── 应用 ─────────────────── */

    function applyPrefs() {
        if (typeof document !== 'undefined' && document.body) {
            const body = document.body;
            const color = BG_COLORS[prefs.bg];
            // 三档都有值（纯色或棋盘格图片），统一走 CSS 变量，样式表里不写死任何颜色
            body.classList.toggle('pref-bg', !!color);
            if (color) body.style.setProperty('--pref-cv-bg', color);
            else body.style.removeProperty('--pref-cv-bg');
            body.style.setProperty('--pref-obj-w', prefs.sizeW + 'px');
            body.style.setProperty('--pref-obj-h', prefs.sizeH + 'px');
        }
        const snap = setPrefs({
            autoSave: prefs.autoSave,
            undoLimit: prefs.undoLimit,
            snapGrid: prefs.snapGrid,
            objectW: prefs.sizeW,
            objectH: prefs.sizeH,
            bg: prefs.bg,
        });
        // 引擎若将来提供这个口子，改一次就立刻生效；没有则保持静默（不弹错）
        if (engine && typeof engine.setHistoryLimit === 'function') {
            try {
                engine.setHistoryLimit(prefs.undoLimit);
            } catch (err) {
                /* 旧引擎没有该方法 */
            }
        }
        // 广播给 timeline / 画布等模块：它们不该为一份偏好去 import 面板模块
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
            window.dispatchEvent(new CustomEvent('ms:prefs', { detail: snap }));
        }
    }

    /** 控件跟随状态：手正在输入的数字框不覆盖。 */
    function paintControls() {
        for (const [val, btn] of saveBtns) btn.classList.toggle('is-on', String(prefs.autoSave) === val);
        for (const [val, btn] of undoBtns) btn.classList.toggle('is-on', String(prefs.undoLimit) === val);
        for (const [val, btn] of gridBtns) btn.classList.toggle('is-on', String(prefs.snapGrid) === val);
        for (const [val, btn] of bgBtns) btn.classList.toggle('is-on', prefs.bg === val);
        for (const [val, btn] of sizeBtns) btn.classList.toggle('is-on', prefs.sizePreset === val);
        const custom = prefs.sizePreset === 'custom';
        wInput.disabled = !custom;
        hInput.disabled = !custom;
        if (document.activeElement !== wInput) wInput.value = String(prefs.sizeW);
        if (document.activeElement !== hInput) hInput.value = String(prefs.sizeH);
    }

    applyPrefs();
    paintControls();
    return {
        refresh: paintControls,
        destroy() {
            for (const body of groups) {
                const group = body ? body.parentNode : null;
                if (group && typeof group.remove === 'function') group.remove();
            }
            groups.length = 0;
        },
    };
}
