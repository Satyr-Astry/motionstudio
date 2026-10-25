/**
 * 画板编辑器 —— **只编辑一张纹理（texture）**，与编排器完全分离。
 *
 * 术语：以前叫「画格」，现在统一叫**纹理**。一个对象的每条关键帧可以绑定一张纹理；
 * 画板就是「编辑某一张纹理」的那块地：它不认识舞台、不认识对象变换、不共享相机。
 *
 * 三条硬约束（改动前先读）：
 * 1. **自带 canvas**。`div.cv-host` 是主画布（编排）编辑器的单例宿主，碰它就会把舞台画布
 *    搬走或清空；这里只 `document.createElement('canvas')`，绝不查也不动 `.cv-host`。
 * 2. **自带相机**。zoom / pan 是本模块私有的，不与 `engine.state` 共享 —— 偏移正是共享
 *    相机带来的：舞台为文档尺寸算好的 pan/zoom 被画板拿去映射指针，笔自然落在别处。
 * 3. 落笔**直接写纹理位图**，坐标只用「本画布 rect + 私有相机 + 纹理尺寸」算出来，
 *    不经过对象变换矩阵、不经过合成管线、不经过舞台相机。
 *
 * 结构（v8 高密度单行工具条）：
 *   .bd
 *     .bd-bar
 *       .bd-brushes(.bd-brush[data-brush] × 7)
 *       .bd-swatch                        当前色块（点开极小色板）
 *       .bd-field.bd-field-size           range + 数字
 *       .bd-field.bd-field-opacity        range + 数字
 *       button[data-act=pick]             取色器（E）
 *       select.bd-mirror                  镜像：无 / 左右 / 上下 / 四向
 *       button[data-act=undo|redo]        撤销 / 重做（引擎 history）
 *       button[data-act=settings]         （more-horizontal）笔刷设置
 *       .bd-acts(.bd-act[data-act=prev|next|new|unique|fit])   ← margin-left:auto 靠右
 *     .bd-stage > canvas.bd-canvas + canvas.bd-ovl(笔刷游标层)
 *     .bd-pal   极小色板浮层（最近 6 色 + 前景/背景交换）
 *     .bd-pop   笔刷设置浮层（硬度 / 间距 / 抖动 / 流量 + 恢复默认）
 *     .bd-hint
 *
 * 参数生效链路：localStorage['ms.brush.'+id] → resolveBrush() → makeTip() / spacingPx()。
 * 任何绕过 resolveBrush 直接用 BRUSH_PRESETS 的写法都会让「笔刷设置」失效。
 */

import {
    BRUSH_PARAM_KEYS, BRUSH_PRESETS, brushById, makeTip, resolveBrush, spacingPx, tipDiameter,
} from '../paint/brush.mjs';
import { captureRegion, makeRegionCommand } from '../paint/patch.mjs';
import { MAX_LEVEL, clampLevel, createStabilizer } from '../paint/stabilizer.mjs';
import { icon } from '../core/icons.mjs';
import { imageAt, objectById, objectsOf } from '../core/doc-model.mjs';

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;

const LS_BRUSH = 'ms.brush.';          // + 笔刷 id → 覆写 JSON
const LS_RECENT = 'ms.brush.recent';   // 最近用过的颜色
const LS_MIRROR = 'ms.brush.mirror';   // none / x / y / both
const LS_BG = 'ms.brush.bg';           // 前景/背景交换用的「背景色」
const LS_STAB = 'ms.board.stabilizer';  // 稳定器档位 0–5（默认 0 = 直通）

/** 笔刷 chip 上的单字缩写（7 个 chip 要挤在一行里，全名放 title）。 */
const BRUSH_SHORT = {
    pixel: '像', round: '圆', soft: '软', pencil: '铅', smudge: '晕', scatter: '散', eraser: '擦',
};

const MIRROR_MODES = [
    ['none', '镜像：无'],
    ['x', '镜像：左右'],
    ['y', '镜像：上下'],
    ['both', '镜像：四向'],
];

/**
 * 四条滑杆的界面映射：滑杆是整数，参数是小数。
 * 间距下限 2（=0.02）而不是 0：间距归零意味着落点间距为 0，一笔会卡死。
 */
const PARAM_UI = [
    { key: 'hardness', label: '硬度', min: 0, max: 100, step: 1, to: (v) => Math.round(v * 100), from: (s) => s / 100 },
    { key: 'spacing', label: '间距', min: 2, max: 200, step: 1, to: (v) => Math.round(v * 100), from: (s) => s / 100 },
    { key: 'jitter', label: '抖动', min: 0, max: 100, step: 1, to: (v) => Math.round(v * 100), from: (s) => s / 100 },
    { key: 'flow', label: '流量', min: 2, max: 100, step: 1, to: (v) => Math.round(v * 100), from: (s) => s / 100 },
];

/* ── 小工具 ── */

function mk(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
}

function clamp(n, lo, hi, fallback) {
    const v = Number(n);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(hi, Math.max(lo, v));
}

function lsGet(key) {
    try {
        return window.localStorage.getItem(key);
    } catch (err) {
        return null;
    }
}

function lsSet(key, value) {
    try {
        window.localStorage.setItem(key, String(value));
    } catch (err) {
        /* 隐私模式 / 配额满：功能照常，只是不记忆 */
    }
}

function lsDel(key) {
    try {
        window.localStorage.removeItem(key);
    } catch (err) {
        /* 同上 */
    }
}

function toHex(r, g, b) {
    const p = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return '#' + p(r) + p(g) + p(b);
}

/** 只接受能直接塞进 CSS background 的短颜色串。 */
function cssColor(v) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s || s.length > 32) return '';
    return /^#[0-9a-f]{3,8}$/i.test(s) || /^rgba?\(/i.test(s) || /^hsla?\(/i.test(s) ? s : '';
}

export function mount(el, ctx) {
    const c = ctx && typeof ctx === 'object' ? ctx : {};
    const notify = (msg) => (typeof c.notify === 'function' ? c.notify(String(msg)) : undefined);
    const docNow = () => (typeof c.doc === 'function' ? c.doc() : null);
    const timeNow = () => {
        const v = Number(typeof c.time === 'function' ? c.time() : 0);
        return Number.isFinite(v) ? v : 0;
    };
    const activeId = () => (typeof c.activeLayerId === 'function' ? c.activeLayerId() : null);
    const engine = c.engine || null;

    /* ── 目标对象与纹理 ── */

    /** 画板要编辑的对象：活动对象 → 第一个对象。画板只认对象，不认舞台选择。 */
    function targetObject() {
        const doc = docNow();
        if (!doc) return null;
        const id = activeId();
        const byId = id == null ? null : objectById(doc, id);
        if (byId) return byId;
        const list = objectsOf(doc);
        return list.length ? list[0] : null;
    }

    /** 当前纹理（位图）。没有就返回 null —— 画板不自己造，交给「纹理」（plus 图标那个按钮）。 */
    function texture() {
        const obj = targetObject();
        if (!obj) return null;
        const img = imageAt(obj, timeNow());
        return img && typeof img.getContext === 'function' ? img : null;
    }

    /* ── 笔刷参数（预设 + localStorage 覆写） ── */

    const overrideCache = new Map();
    let brushCache = null;
    let brushCacheKey = '';

    /** 读某个笔刷的覆写表：只认 BRUSH_PARAM_KEYS，坏 JSON 当作没存过。 */
    function overridesFor(id) {
        const hit = overrideCache.get(id);
        if (hit) return hit;
        const out = {};
        const raw = lsGet(LS_BRUSH + id);
        if (raw) {
            let parsed = null;
            try {
                parsed = JSON.parse(raw);
            } catch (err) {
                parsed = null;
            }
            if (parsed && typeof parsed === 'object') {
                for (const key of BRUSH_PARAM_KEYS) {
                    if (Object.prototype.hasOwnProperty.call(parsed, key)) out[key] = parsed[key];
                }
            }
        }
        overrideCache.set(id, out);
        return out;
    }

    function saveOverrides(id, next) {
        const clean = {};
        for (const key of BRUSH_PARAM_KEYS) {
            if (next[key] !== undefined) clean[key] = next[key];
        }
        overrideCache.set(id, clean);
        brushCacheKey = '';
        lsSet(LS_BRUSH + id, JSON.stringify(clean));
    }

    /** 当前生效的笔刷（预设 + 覆写合并后的新对象；不改预设常量）。 */
    function activeBrush() {
        const ov = overridesFor(brushId);
        let key = brushId;
        for (const k of BRUSH_PARAM_KEYS) key += '|' + (ov[k] === undefined ? '' : String(ov[k]));
        if (!brushCache || key !== brushCacheKey) {
            brushCache = resolveBrush(brushId, ov);
            brushCacheKey = key;
        }
        return brushCache;
    }

    /* ── 私有相机（与舞台无关） ── */

    const cam = { zoom: 1, panX: 0, panY: 0 };
    let fittedFor = '';

    function fit() {
        userCam = false;
        const img = texture();
        const r = canvas.getBoundingClientRect();
        const vw = Math.max(32, r.width || canvas.clientWidth || 640);
        const vh = Math.max(32, r.height || canvas.clientHeight || 480);
        const w = img ? img.width : 640;
        const h = img ? img.height : 480;
        const z = Math.min((vw - 24) / w, (vh - 24) / h);
        cam.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
        cam.panX = Math.round((vw - w * cam.zoom) / 2);
        cam.panY = Math.round((vh - h * cam.zoom) / 2);
        draw();
    }

    /** 画布尺寸或纹理换了 → 重新适配一次（适配过就不再打扰）。 */
    function ensureFit() {
        const img = texture();
        const key = (img ? img.width + 'x' + img.height : 'none') + '@' + Math.round(canvas.clientWidth) + 'x' + Math.round(canvas.clientHeight);
        if (key === fittedFor) return;
        fittedFor = key;
        fit();
    }

    /* ── DOM：工具条 ── */

    const root = mk('div', 'bd');

    const bar = mk('div', 'bd-bar');

    const brushes = mk('div', 'bd-brushes');
    const brushBtns = new Map();
    BRUSH_PRESETS.forEach((b, i) => {
        const btn = mk('button', 'bd-brush', BRUSH_SHORT[b.id] || b.name.slice(0, 1));
        btn.type = 'button';
        btn.dataset.brush = b.id;
        btn.title = b.name + '（快捷键 ' + (i + 1) + '）';
        brushes.appendChild(btn);
        brushBtns.set(b.id, btn);
    });

    // 当前色块：点开极小色板
    const swatch = mk('button', 'bd-swatch');
    swatch.type = 'button';
    swatch.title = '当前颜色（点击打开色板）';

    // 大小：range + 数字
    const sizeField = mk('label', 'bd-field bd-field-size');
    sizeField.title = '笔尖大小（像素，[ / ] 调整）';
    sizeField.appendChild(mk('span', 'bd-lab', '大小'));
    const sizeRange = mk('input');
    sizeRange.type = 'range';
    sizeRange.min = '1';
    sizeRange.max = '200';
    sizeRange.step = '1';
    sizeRange.value = '12';
    // 视觉上靠左侧的 .bd-lab 说明用途，但读屏和 UX 审计只看 input 自身属性 → 单独给一份
    sizeRange.setAttribute('aria-label', '笔尖大小（像素）');
    const sizeNum = mk('input', 'bd-num');
    sizeNum.type = 'number';
    sizeNum.min = '1';
    sizeNum.max = '200';
    sizeNum.step = '1';
    sizeNum.value = '12';
    sizeNum.title = '笔尖大小（像素）';
    sizeField.append(sizeRange, sizeNum);

    // 不透明度：range + 数字（百分比）
    const opacityField = mk('label', 'bd-field bd-field-opacity');
    opacityField.title = '笔刷不透明度（%）';
    opacityField.appendChild(mk('span', 'bd-lab', '不透明'));
    const opacityRange = mk('input');
    opacityRange.type = 'range';
    opacityRange.min = '5';
    opacityRange.max = '100';
    opacityRange.step = '1';
    opacityRange.value = '100';
    opacityRange.setAttribute('aria-label', '笔刷不透明度（%）');
    const opacityNum = mk('input', 'bd-num');
    opacityNum.type = 'number';
    opacityNum.min = '5';
    opacityNum.max = '100';
    opacityNum.step = '1';
    opacityNum.value = '100';
    opacityNum.title = '笔刷不透明度（%）';
    opacityField.append(opacityRange, opacityNum);

    const pickBtn = mk('button', 'bd-ico');
    pickBtn.type = 'button';
    pickBtn.dataset.act = 'pick';
    pickBtn.innerHTML = icon('eyedropper');
    pickBtn.setAttribute('aria-label', '取色器');
    pickBtn.title = '取色器：点画布取一个像素（E）· 画布上右键随时取色';

    const mirrorSel = mk('select', 'bd-select bd-mirror');
    mirrorSel.title = '镜像绘制（纯前端，不改数据）';
    for (const [value, label] of MIRROR_MODES) {
        const opt = mk('option', null, label.replace('镜像：', ''));
        opt.value = value;
        mirrorSel.appendChild(opt);
    }

    const undoBtn = mk('button', 'bd-ico');
    undoBtn.type = 'button';
    undoBtn.dataset.act = 'undo';
    undoBtn.innerHTML = icon('undo');
    undoBtn.setAttribute('aria-label', '撤销');
    undoBtn.title = '撤销（引擎 history）';

    const redoBtn = mk('button', 'bd-ico');
    redoBtn.type = 'button';
    redoBtn.dataset.act = 'redo';
    redoBtn.innerHTML = icon('redo');
    redoBtn.setAttribute('aria-label', '重做');
    redoBtn.title = '重做（引擎 history）';

    const settingsBtn = mk('button', 'bd-ico');
    settingsBtn.type = 'button';
    settingsBtn.dataset.act = 'settings';
    settingsBtn.innerHTML = icon('more-horizontal');
    settingsBtn.setAttribute('aria-label', '笔刷设置');
    settingsBtn.title = '笔刷设置：硬度 / 间距 / 抖动 / 流量';

    // 稳定器：图标 + 档位数字（0–5）。纯图标按钮，文字只作 a11y，图形靠 icon()。
    const stabBtn = mk('button', 'bd-ico bd-stab');
    stabBtn.type = 'button';
    stabBtn.dataset.act = 'stab';
    stabBtn.setAttribute('aria-label', '笔迹稳定器档位');
    stabBtn.title = '笔迹稳定器（点击切换 0–5 档，Ctrl+滚轮 也能调）';
    stabBtn.innerHTML = icon('adjust') + '<span class="bd-stab-n">0</span>';

    const acts = mk('div', 'bd-acts');
    // 五个纹理动作：‹ › 是纯图标（翻页箭头，文字放不下也没必要），后三个保留中文并加前置图标。
    // "＋纹理" 的全角加号由 plus 图标承担，文字只剩「纹理」，避免出现「＋ ＋纹理」。
    for (const [act, iconName, text, title] of [
        ['prev', 'chevron-left', '', '上一张纹理'],
        ['next', 'chevron-right', '', '下一张纹理'],
        ['new', 'plus', '纹理', '新建一张空白纹理并绑定到当前时刻'],
        ['unique', 'sparkle', '独特化', '把当前纹理拷一份，之后改它不影响别处'],
        ['fit', 'fit', '适配', '缩放到刚好放下这张纹理（0 键）'],
    ]) {
        const btn = mk('button', 'bd-act');
        btn.type = 'button';
        btn.dataset.act = act;
        btn.innerHTML = icon(iconName) + (text ? `<span>${text}</span>` : '');
        btn.title = title;
        btn.setAttribute('aria-label', title);
        acts.appendChild(btn);
    }

    bar.append(
        brushes, swatch, sizeField, opacityField,
        pickBtn, mirrorSel, undoBtn, redoBtn, settingsBtn, stabBtn, acts,
    );

    /* ── DOM：画布 + 游标层 ── */

    const stage = mk('div', 'bd-stage');
    const canvas = document.createElement('canvas');
    canvas.className = 'bd-canvas';
    // 调试/自检用：把私有相机挂到 canvas 上（只读句柄，业务代码不读它）
    canvas.__bdCam = cam;
    const overlay = document.createElement('canvas');
    overlay.className = 'bd-ovl';
    stage.append(canvas, overlay);

    /* ── DOM：色板浮层 ── */

    const pal = mk('div', 'bd-pal');
    pal.hidden = true;
    const palGrid = mk('div', 'bd-pal-grid');
    const palSwap = mk('button', 'bd-pal-swap', '⇄');
    palSwap.type = 'button';
    palSwap.dataset.act = 'swap';
    palSwap.title = '前景 / 背景交换';
    pal.append(mk('div', 'bd-pop-title', '最近颜色'), palGrid, palSwap);

    /* ── DOM：笔刷设置浮层 ── */

    const pop = mk('div', 'bd-pop');
    pop.hidden = true;
    const popTitle = mk('div', 'bd-pop-title', '笔刷设置');
    pop.appendChild(popTitle);

    const paramRows = [];
    for (const ui of PARAM_UI) {
        const row = mk('label', 'bd-set-row');
        row.appendChild(mk('span', 'bd-set-lab', ui.label));
        const range = mk('input');
        range.type = 'range';
        range.min = String(ui.min);
        range.max = String(ui.max);
        range.step = String(ui.step);
        range.dataset.param = ui.key;
        const num = mk('span', 'bd-set-num', '0');
        row.append(range, num);
        pop.appendChild(row);
        paramRows.push({ ...ui, range, num });

        range.addEventListener('input', () => {
            const value = Number(range.value);
            const next = Object.assign({}, overridesFor(brushId));
            next[ui.key] = ui.from(Number.isFinite(value) ? value : ui.to(Number(activeBrush()[ui.key])));
            saveOverrides(brushId, next);
            tipSig = '';
            num.textContent = String(Math.round(ui.from(Number(range.value)) * 100));
            scheduleCursor();
        });
    }
    const resetBtn = mk('button', 'bd-set-reset', '恢复默认');
    resetBtn.type = 'button';
    resetBtn.dataset.act = 'reset';
    resetBtn.title = '清除这个笔刷的记忆参数';
    pop.appendChild(resetBtn);

    const hint = mk('div', 'bd-hint', '左键画 · 右键/Alt 取色 · E 取色器 · [ ] 笔尖 · 1–7 笔刷 · 滚轮缩放 · 空格/中键平移 · 0 适配');

    root.append(bar, stage, pal, pop, hint);
    el.appendChild(root);
    root.addEventListener('contextmenu', (e) => e.preventDefault());

    /* ── 私有状态 ── */

    let brushId = 'round';
    let size = 12;
    let opacity = 1;
    let color = cssColor(typeof c.color === 'function' ? c.color() : '') || '#000000';
    let bgColor = cssColor(lsGet(LS_BG) || '') || '#ffffff';
    let recent = [];
    let mirror = 'none';
    let pickMode = false;
    let rightPick = false;  // 右键按住取色中（左键绘制路径完全不受影响）
    let pickDownHex = '';   // 右键按下时取到的颜色，松手时用来判断要不要再播报一次
    let spaceDown = false;
    let panning = null;
    let stroke = null;
    let tip = null;
    let tipSig = '';
    let smudgeBuf = null;
    let userCam = false;   // 用户自己缩放过/平移过就不再自动适配（只有「适配」或换纹理才重置）
    let hover = null;      // 指针在画布上的位置（CSS px），null = 不在里面
    let cursorRaf = 0;
    let stabLevel = clampLevel(lsGet(LS_STAB));  // 稳定器档位（非法值由 clampLevel 收口）
    let stab = null;       // 本次笔画的稳定器（pointerdown 建、pointerup 关）
    let stabTail = null;   // 本步的原始输入点：松手时用它把线尾追平到笔尖处

    /* ── 颜色 ── */

    function readRecent() {
        const raw = lsGet(LS_RECENT);
        if (!raw) return [];
        let list = null;
        try {
            list = JSON.parse(raw);
        } catch (err) {
            list = null;
        }
        if (!Array.isArray(list)) return [];
        return list.map(cssColor).filter((v) => !!v).slice(0, 6);
    }

    function paintRecent() {
        palGrid.replaceChildren();
        for (const hex of recent) {
            const cell = mk('button', 'bd-pal-cell');
            cell.type = 'button';
            cell.dataset.color = hex;
            cell.title = hex;
            cell.style.background = hex;
            palGrid.appendChild(cell);
        }
        if (!recent.length) palGrid.appendChild(mk('span', 'bd-pal-empty', '还没有用过颜色'));
        // 补足 6 格：格子数固定，弹层宽度才不会跟着「用过的颜色」跳来跳去
        for (let i = recent.length; i < 6; i += 1) palGrid.appendChild(mk('span', 'bd-pal-cell is-empty'));
    }

    function pushRecent(hex) {
        const v = cssColor(hex);
        if (!v) return;
        recent = [v].concat(recent.filter((x) => x !== v)).slice(0, 6);
        lsSet(LS_RECENT, JSON.stringify(recent));
        paintRecent();
    }

    /** 唯一改色入口：本地状态 + 引擎状态一起走 ctx.setColor()。 */
    function applyColor(hex, remember) {
        const v = cssColor(hex);
        if (!v) return;
        color = v;
        if (typeof c.setColor === 'function') c.setColor(v);
        if (remember !== false) pushRecent(v);
        paintChrome();
    }

    function swapColors() {
        const fg = color;
        color = bgColor;
        bgColor = fg;
        lsSet(LS_BG, bgColor);
        if (typeof c.setColor === 'function') c.setColor(color);
        paintChrome();
        notify('已交换前景 / 背景色');
    }

    /* ── 渲染 ── */

    function sizeCanvas(cv, w, h, dpr) {
        const bw = Math.max(1, Math.round(w * dpr));
        const bh = Math.max(1, Math.round(h * dpr));
        if (cv.width !== bw || cv.height !== bh) {
            cv.width = bw;
            cv.height = bh;
        }
    }

    function draw() {
        if (!canvas.isConnected && canvas.parentNode == null) return;
        // 布局可能比首次适配晚一拍（面板刚挂上时 clientWidth 还是 0），
        // 每帧比一次适配键，尺寸变了就重新适配；用户手动缩放过就不打扰。
        if (!userCam) ensureFit();
        const r = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(r.width));
        const h = Math.max(1, Math.round(r.height));
        sizeCanvas(canvas, w, h, dpr);
        sizeCanvas(overlay, w, h, dpr);
        const g = canvas.getContext('2d');
        if (!g) return;
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, canvas.width, canvas.height);
        g.setTransform(dpr, 0, 0, dpr, 0, 0);

        // 纹理区外：比舞台深一档，一眼区分「纸」与「桌面」
        g.fillStyle = '#111215';
        g.fillRect(0, 0, w, h);

        const img = texture();
        if (!img) {
            g.fillStyle = '#6b7280';
            g.font = '12px system-ui, sans-serif';
            g.textAlign = 'center';
            g.fillText('这个时刻还没有纹理：点「纹理」新建一张', w / 2, h / 2);
            drawCursor(dpr);
            return;
        }
        const dw = img.width * cam.zoom;
        const dh = img.height * cam.zoom;
        const cell = Math.max(4, Math.round(8 * cam.zoom));
        g.save();
        g.beginPath();
        g.rect(cam.panX, cam.panY, dw, dh);
        g.clip();
        for (let y = 0; y < Math.ceil(dh / cell); y += 1) {
            for (let x = 0; x < Math.ceil(dw / cell); x += 1) {
                g.fillStyle = (x + y) % 2 ? '#2c2f35' : '#35383f';
                g.fillRect(cam.panX + x * cell, cam.panY + y * cell, cell, cell);
            }
        }
        g.restore();
        g.imageSmoothingEnabled = cam.zoom < 1;
        g.drawImage(img, cam.panX, cam.panY, dw, dh);
        g.strokeStyle = 'rgba(255,255,255,0.22)';
        g.lineWidth = 1;
        g.strokeRect(cam.panX + 0.5, cam.panY + 0.5, Math.max(1, dw - 1), Math.max(1, dh - 1));
        drawCursor(dpr);
    }

    /* ── 笔刷游标（独立 overlay 层，绝不重绘整张纹理） ── */

    /** 圆半径 = 笔尖直径 / 2 × 私有相机 zoom（随缩放变化）。 */
    function cursorRadius() {
        return Math.max(1.5, (tipDiameter(activeBrush(), size) / 2) * cam.zoom);
    }

    function drawCursor(dprIn) {
        const ov = overlay.getContext('2d');
        if (!ov) return;
        const dpr = dprIn || window.devicePixelRatio || 1;
        ov.setTransform(1, 0, 0, 1, 0, 0);
        ov.clearRect(0, 0, overlay.width, overlay.height);
        if (!hover) return;
        const rad = cursorRadius();
        ov.setTransform(dpr, 0, 0, dpr, 0, 0);
        ov.lineWidth = 1;
        ov.beginPath();
        ov.arc(hover.x, hover.y, rad, 0, Math.PI * 2);
        ov.strokeStyle = 'rgba(0,0,0,0.62)';
        ov.stroke();
        if (rad > 2.4) {
            ov.beginPath();
            ov.arc(hover.x, hover.y, rad - 0.7, 0, Math.PI * 2);
            ov.strokeStyle = 'rgba(255,255,255,0.92)';
            ov.stroke();
        } else {
            ov.beginPath();
            ov.arc(hover.x, hover.y, rad, 0, Math.PI * 2);
            ov.strokeStyle = 'rgba(255,255,255,0.92)';
            ov.stroke();
        }
        if (pickMode || rightPick) {
            ov.beginPath();
            ov.moveTo(hover.x - rad - 3, hover.y);
            ov.lineTo(hover.x - Math.max(1, rad - 1), hover.y);
            ov.moveTo(hover.x + Math.max(1, rad - 1), hover.y);
            ov.lineTo(hover.x + rad + 3, hover.y);
            ov.moveTo(hover.x, hover.y - rad - 3);
            ov.lineTo(hover.x, hover.y - Math.max(1, rad - 1));
            ov.moveTo(hover.x, hover.y + Math.max(1, rad - 1));
            ov.lineTo(hover.x, hover.y + rad + 3);
            ov.strokeStyle = 'rgba(0,0,0,0.55)';
            ov.stroke();
            ov.strokeStyle = 'rgba(255,255,255,0.92)';
            ov.lineWidth = 1;
            ov.stroke();
        }
    }

    /** 指针移动只重画 overlay（一帧一次），不碰纹理与主画布。 */
    function scheduleCursor() {
        if (cursorRaf) return;
        cursorRaf = window.requestAnimationFrame(() => {
            cursorRaf = 0;
            drawCursor();
        });
    }

    /* ── 坐标：只用「本画布 rect + 私有相机」 ── */

    function toTexture(e) {
        const r = canvas.getBoundingClientRect();
        return {
            x: (e.clientX - r.left - cam.panX) / cam.zoom,
            y: (e.clientY - r.top - cam.panY) / cam.zoom,
        };
    }

    /* ── 落笔 ── */

    function currentTip() {
        const b = activeBrush();
        const sig = [
            brushId, size, color, Math.round(opacity * 100),
            b.hardness, b.spacing, b.jitter, b.flow,
        ].join('|');
        if (sig !== tipSig || !tip) {
            tipSig = sig;
            tip = makeTip(b, size, color, opacity);
        }
        return tip;
    }

    /** 每笔落点的透明度：不透明度 × 流量。 */
    function paintAlpha() {
        return clamp(opacity * activeBrush().flow, 0.02, 1, opacity);
    }

    /** 以纹理宽/高一半为轴镜像出落点（纯前端效果，数据不变）。 */
    function mirrorCenters(img, x, y) {
        const out = [{ x, y }];
        if (mirror === 'none' || !img) return out;
        const mx = img.width - x;
        const my = img.height - y;
        const add = (px, py) => {
            for (const p of out) {
                if (Math.abs(p.x - px) < 0.01 && Math.abs(p.y - py) < 0.01) return;
            }
            out.push({ x: px, y: py });
        };
        if (mirror === 'x' || mirror === 'both') add(mx, y);
        if (mirror === 'y' || mirror === 'both') add(x, my);
        if (mirror === 'both') add(mx, my);
        return out;
    }

    function stamp(g, img, x, y, alpha) {
        const b = activeBrush();
        const t = currentTip();
        if (!t) return;
        const half = t.width / 2;
        const centers = mirrorCenters(img, x, y);
        const jitter = clamp(b.jitter, 0, 1, 0) * half;
        g.save();
        g.globalCompositeOperation = b.erase ? 'destination-out' : 'source-over';
        if (b.scatter) {
            const n = Math.max(1, Math.round(b.scatter.count));
            const rad = half * Math.max(0, b.scatter.spread);
            const dots = [];
            for (let i = 0; i < n; i += 1) {
                const a = Math.random() * Math.PI * 2;
                const rr = Math.sqrt(Math.random()) * rad;
                dots.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr });
            }
            g.globalAlpha = clamp(alpha / Math.sqrt(n), 0.02, 1, 0.02);
            for (const center of centers) {
                for (const d of dots) g.drawImage(t, center.x + d.x - half, center.y + d.y - half);
            }
        } else if (b.smudge && stroke && stroke.last) {
            const d = Math.max(1, Math.round(t.width));
            if (!smudgeBuf) smudgeBuf = document.createElement('canvas');
            smudgeBuf.width = d;
            smudgeBuf.height = d;
            const bg = smudgeBuf.getContext('2d');
            bg.clearRect(0, 0, d, d);
            bg.globalCompositeOperation = 'source-over';
            bg.drawImage(img, stroke.last.x - half, stroke.last.y - half, d, d, 0, 0, d, d);
            bg.globalCompositeOperation = 'destination-in';
            bg.drawImage(t, 0, 0);
            g.globalAlpha = clamp(alpha * (b.strength == null ? 0.55 : b.strength), 0.02, 1, 0.02);
            for (const center of centers) g.drawImage(smudgeBuf, center.x - half, center.y - half);
            g.globalAlpha = clamp(alpha * 0.25, 0.02, 1, 0.02);
            for (const center of centers) g.drawImage(t, center.x - half, center.y - half);
        } else {
            g.globalAlpha = clamp(alpha, 0.02, 1, 0.02);
            for (const center of centers) {
                const jx = jitter ? (Math.random() * 2 - 1) * jitter : 0;
                const jy = jitter ? (Math.random() * 2 - 1) * jitter : 0;
                g.drawImage(t, center.x + jx - half, center.y + jy - half);
            }
        }
        g.restore();
    }

    function beginStroke(e) {
        const img = texture();
        if (!img) {
            notify('这个时刻还没有纹理：点「纹理」新建一张');
            return null;
        }
        const g = img.getContext('2d');
        if (!g) return null;
        g.setTransform(1, 0, 0, 1, 0, 0);
        const before = captureRegion(img, { x: 0, y: 0, w: img.width, h: img.height });
        const p = toTexture(e);
        // 稳定器只在落笔采样这一侧：它决定"往哪落"，不碰文档、不进撤销栈。
        stab = createStabilizer(stabLevel);
        stabTail = { x: p.x, y: p.y };
        const head = stab.push(p.x, p.y);   // 起笔不滞后：首点就是笔尖位置
        const s = {
            img,
            g,
            last: { x: head.x, y: head.y },
            gap: spacingPx(activeBrush(), size),
            carry: 0,
            before,
            points: [{ x: head.x, y: head.y }],
            moved: false,
        };
        stroke = s;
        stamp(g, img, head.x, head.y, paintAlpha());
        draw();
        return s;
    }

    function extendStroke(e) {
        const s = stroke;
        if (!s) return;
        const raw = toTexture(e);
        const r = stab
            ? stab.push(raw.x, raw.y)
            : { x: raw.x, y: raw.y, moved: true, target: { x: raw.x, y: raw.y } };
        stabTail = { x: r.target.x, y: r.target.y };
        if (!r.moved) return;   // 没跨过最小移动阈值（亚像素抖动）：这一步不落笔
        const p = { x: r.x, y: r.y };
        const prev = s.points[s.points.length - 1];
        const dx = p.x - prev.x;
        const dy = p.y - prev.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 0.01) return;
        const step = Math.max(0.5, s.gap);
        let travelled = s.carry;
        while (travelled + step <= dist) {
            travelled += step;
            const k = travelled / dist;
            const x = prev.x + dx * k;
            const y = prev.y + dy * k;
            stamp(s.g, s.img, x, y, paintAlpha());
            s.last = { x, y };
            s.points.push({ x, y });
            s.moved = true;
        }
        s.carry = Math.max(0, travelled - dist);
        draw();
    }

    function endStroke() {
        const s = stroke;
        const tail = stabTail;
        stroke = null;
        if (stab) {
            stab.reset();
            stab = null;
        }
        stabTail = null;
        if (!s) return;
        // 松手追平：平滑点天然滞后于笔尖，线尾必须落在真正的笔尖处（Klecks 的 finishOnUp）
        if (s.moved && tail && Math.hypot(tail.x - s.last.x, tail.y - s.last.y) >= 0.5) {
            stamp(s.g, s.img, tail.x, tail.y, paintAlpha());
            s.points.push({ x: tail.x, y: tail.y });
            s.last = { x: tail.x, y: tail.y };
        }
        if (s.moved) {
            const after = captureRegion(s.img, { x: 0, y: 0, w: s.img.width, h: s.img.height });
            if (engine && typeof engine.pushCommand === 'function') {
                engine.pushCommand(makeRegionCommand(s.img, s.before, after, '画一笔（纹理）'));
            }
            notify('已写入纹理');
        }
        draw();
        if (typeof c.requestRender === 'function') c.requestRender();
    }

    /* ── 取色器 ── */

    function setPickMode(on) {
        pickMode = !!(on == null ? !pickMode : on);
        paintChrome();
        scheduleCursor();
    }

    /**
     * 从当前纹理位图读一个像素 → ctx.setColor('#rrggbb') → 自动回画笔。
     * `silent` 用于按住拖取：拖动过程中不刷提示行，只在松手时播报最终色。
     */
    function sampleAt(e, opts) {
        const silent = !!(opts && opts.silent);
        const remember = !(opts && opts.remember === false);
        const img = texture();
        if (!img) {
            if (!silent) notify('这个时刻还没有纹理，没得取色');
            return false;
        }
        const p = toTexture(e);
        const x = Math.floor(p.x);
        const y = Math.floor(p.y);
        if (x < 0 || y < 0 || x >= img.width || y >= img.height) {
            if (!silent) notify('点在纹理外面了，没取到色');
            return false;
        }
        let d;
        try {
            const g = img.getContext('2d');
            if (!g) return false;
            d = g.getImageData(x, y, 1, 1).data;
        } catch (err) {
            // 纹理可能刚好被撤销 / 换成了 detached 画布：这次没取到，别让它炸掉整个 pointerdown
            if (!silent) notify('这张纹理现在读不了，没取到色');
            return false;
        }
        if (d[3] < 8) {
            if (!silent) notify('这个像素是透明的，没取到色');
            return false;
        }
        applyColor(toHex(d[0], d[1], d[2]), remember);
        setPickMode(false);
        if (!silent) notify('取色 ' + color);
        return true;
    }

    /**
     * 右键取色：按下取一次，按住拖动连续取，松开结束。
     * 不复用 pickMode —— 右键是**临时**取色，取完颜色就回原来的笔，和 Klecks 的
     * eyedropper（`tempTriggers = ['mouse-right','alt']`）一致；工具状态一次都不改。
     */
    function beginRightPick(e) {
        rightPick = true;
        const ok = sampleAt(e, { silent: true });
        pickDownHex = ok ? color : '';
        if (ok) notify('取色 ' + color);
        else sampleAt(e); // 让 sampleAt 自己解释为什么没取到
        scheduleCursor();
        if (!ok) {
            rightPick = false;
            return false;
        }
        // 拖动中只改当前色、不重复往「最近颜色」里塞同一个色
        const move = (ev) => sampleAt(ev, { silent: true, remember: false });
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            rightPick = false;
            if (color !== pickDownHex) notify('取色 ' + color);
            scheduleCursor();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
        return true;
    }

    /* ── 尺寸 / 不透明度 / 笔刷 / 镜像 ── */

    function setSize(v) {
        const n = Math.round(clamp(v, 1, 200, size));
        if (n === size) return;
        size = n;
        paintChrome();
        scheduleCursor();
    }

    function setOpacityPct(v) {
        const n = clamp(v, 5, 100, Math.round(opacity * 100));
        opacity = Math.max(0.05, Math.min(1, n / 100));
        paintChrome();
    }

    function selectBrush(id) {
        const b = brushById(id);
        brushId = b.id;
        tipSig = '';
        tip = null;
        if (pop.hidden === false) syncParams();
        paintChrome();
        scheduleCursor();
    }

    function setMirror(mode) {
        mirror = MIRROR_MODES.some((m) => m[0] === mode) ? mode : 'none';
        mirrorSel.value = mirror;
        lsSet(LS_MIRROR, mirror);
    }

    /* ── 浮层 ── */

    function placePop(box, anchor) {
        const rr = root.getBoundingClientRect();
        const ar = anchor.getBoundingClientRect();
        box.hidden = false;
        const w = box.offsetWidth || 180;
        let left = ar.left - rr.left;
        left = Math.max(6, Math.min(left, Math.max(6, rr.width - w - 6)));
        box.style.left = Math.round(left) + 'px';
        box.style.top = Math.round(ar.bottom - rr.top + 2) + 'px';
    }

    function openPal() {
        closePop();
        paintRecent();
        placePop(pal, swatch);
    }

    function closePal() {
        pal.hidden = true;
    }

    function openPop() {
        closePal();
        syncParams();
        placePop(pop, settingsBtn);
    }

    function closePop() {
        pop.hidden = true;
    }

    function syncParams() {
        const b = activeBrush();
        for (const row of paramRows) {
            const v = Number(b[row.key]);
            row.range.value = String(row.to(Number.isFinite(v) ? v : 0));
            row.num.textContent = String(Math.round((Number.isFinite(v) ? v : 0) * 100));
        }
        popTitle.textContent = brushById(brushId).name + ' · 参数';
    }

    function resetParams() {
        overrideCache.delete(brushId);
        brushCacheKey = '';
        tipSig = '';
        lsDel(LS_BRUSH + brushId);
        syncParams();
        scheduleCursor();
        notify('已恢复「' + brushById(brushId).name + '」默认参数');
    }

    /* ── 工具条：统一点击委托（bar / pal / pop 都在 root 里） ── */

    function afterDocChange() {
        fittedFor = '';
        ensureFit();
        draw();
    }

    root.addEventListener('click', (e) => {
        const t = e.target && e.target.closest ? e.target : null;
        if (!t) return;

        const chip = t.closest('.bd-brush');
        if (chip) {
            selectBrush(chip.dataset.brush);
            return;
        }

        const cell = t.closest('.bd-pal-cell');
        if (cell) {
            applyColor(cell.dataset.color);
            closePal();
            return;
        }

        if (t.closest('.bd-swatch')) {
            if (pal.hidden) openPal();
            else closePal();
            return;
        }

        const a = t.closest('[data-act]');
        if (!a) return;
        switch (a.dataset.act) {
            case 'pick':
                setPickMode();
                return;
            case 'settings':
                if (pop.hidden) openPop();
                else closePop();
                return;
            case 'swap':
                swapColors();
                return;
            case 'reset':
                resetParams();
                return;
            case 'undo':
                if (typeof c.undo === 'function') c.undo();
                draw();
                if (typeof c.requestRender === 'function') c.requestRender();
                return;
            case 'redo':
                if (typeof c.redo === 'function') c.redo();
                draw();
                if (typeof c.requestRender === 'function') c.requestRender();
                return;
            case 'fit':
                fit();
                return;
            case 'prev':
                if (typeof c.goPrevCel === 'function') c.goPrevCel();
                afterDocChange();
                return;
            case 'next':
                if (typeof c.goNextCel === 'function') c.goNextCel();
                afterDocChange();
                return;
            case 'new': {
                const made = typeof c.newDrawing === 'function' ? c.newDrawing(null) : null;
                // newDrawing 只把图画进「画格库」，**不在时间轴上占位**（画格 ≠ 曝光）。
                // 不落位就等于「点纹理没反应」，所以这里补一次 placeDrawing，把它放到当前时刻。
                const obj = targetObject();
                const placed = made && obj && typeof c.placeDrawing === 'function'
                    ? c.placeDrawing(obj.id, timeNow(), made)
                    : false;
                if (!made) notify('新建纹理失败');
                else if (placed) notify('已新建纹理并绑定到当前时刻');
                else notify('已新建纹理（进了画格库，这个时刻还没放上去）');
                afterDocChange();
                return;
            }
            case 'unique': {
                const ok = typeof c.makeUniqueCel === 'function' ? c.makeUniqueCel(null, timeNow()) : null;
                if (ok === false) notify('当前时刻没有可独特化的纹理');
                afterDocChange();
                return;
            }
            default:
                return;
        }
    });

    sizeRange.addEventListener('input', () => setSize(sizeRange.value));
    sizeNum.addEventListener('input', () => {
        if (sizeNum.value === '') return;
        setSize(sizeNum.value);
    });
    sizeNum.addEventListener('change', () => {
        sizeNum.value = String(size);
    });
    opacityRange.addEventListener('input', () => setOpacityPct(opacityRange.value));
    opacityNum.addEventListener('input', () => {
        if (opacityNum.value === '') return;
        setOpacityPct(opacityNum.value);
    });
    opacityNum.addEventListener('change', () => {
        opacityNum.value = String(Math.round(opacity * 100));
    });
    mirrorSel.addEventListener('change', () => setMirror(mirrorSel.value));

    /**
     * 改稳定器档位：写 localStorage（刷新后还在）、同步给进行中的笔画、刷工具条。
     * 稳定器只影响"往哪落笔"，不进 setDoc，也不进撤销栈。
     */
    function setStabLevel(next) {
        stabLevel = clampLevel(next);
        lsSet(LS_STAB, stabLevel);
        if (stab) stab.setLevel(stabLevel);
        paintChrome();
        notify(stabLevel === 0 ? '笔迹稳定器：关（0）' : '笔迹稳定器：' + stabLevel + ' 档');
    }
    stabBtn.addEventListener('click', () => setStabLevel((stabLevel + 1) % (MAX_LEVEL + 1)));

    // 点浮层外面收回（capture 阶段先关，再让按钮自己的 click 决定开/关）
    const onOutsideDown = (e) => {
        const t = e.target && e.target.closest ? e.target : null;
        if (!t) return;
        if (pal.hidden === false && !t.closest('.bd-pal') && !t.closest('.bd-swatch')) closePal();
        if (pop.hidden === false && !t.closest('.bd-pop') && !t.closest('[data-act="settings"]')) closePop();
    };
    window.addEventListener('pointerdown', onOutsideDown, true);

    /* ── 输入：画布 ── */

    const onPanMove = (e) => {
        if (!panning) return;
        cam.panX = panning.panX + (e.clientX - panning.x);
        cam.panY = panning.panY + (e.clientY - panning.y);
        draw();
    };
    const onPanUp = () => {
        panning = null;
    };

    const trackHover = (e) => {
        const r = canvas.getBoundingClientRect();
        hover = { x: e.clientX - r.left, y: e.clientY - r.top };
        scheduleCursor();
    };

    canvas.addEventListener('pointerenter', trackHover);
    canvas.addEventListener('pointermove', trackHover);
    canvas.addEventListener('pointerleave', () => {
        hover = null;
        scheduleCursor();
    });

    canvas.addEventListener('pointerdown', (e) => {
        if (typeof canvas.setPointerCapture === 'function') {
            try {
                canvas.setPointerCapture(e.pointerId);
            } catch (err) {
                /* 合成事件下会抛，忽略 */
            }
        }
        if (e.button === 2 || (e.altKey && e.button === 0)) {
            // 右键 / Alt+左键 = 取色（优先于空格平移：这两个手势只取色，不动相机、不落笔）
            e.preventDefault();   // 右键别被当作拖拽起点；弹出菜单由 root 的 contextmenu 统一抑制
            beginRightPick(e);
            return;
        }
        if (e.button === 1 || spaceDown) {
            userCam = true;
            panning = { x: e.clientX, y: e.clientY, panX: cam.panX, panY: cam.panY };
            return;
        }
        if (e.button !== 0) return;
        if (pickMode) {
            sampleAt(e);
            return;
        }
        if (!beginStroke(e)) return;
        const move = (ev) => extendStroke(ev);
        const up = () => {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            endStroke();
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    });

    canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (e.ctrlKey) {
            // Ctrl+滚轮 = 调稳定器档位（滚轮本身已经是缩放，所以用这个组合，避免抢缩放）
            // 不循环：到 0 / 最大档就停住。滚轮回绕会在「想减档」时跳到最强档，太反直觉。
            setStabLevel(stabLevel + (e.deltaY < 0 ? 1 : -1));
            return;
        }
        const r = canvas.getBoundingClientRect();
        const ax = e.clientX - r.left;
        const ay = e.clientY - r.top;
        const before = { x: (ax - cam.panX) / cam.zoom, y: (ay - cam.panY) / cam.zoom };
        userCam = true;
        cam.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
        cam.panX = ax - before.x * cam.zoom;
        cam.panY = ay - before.y * cam.zoom;
        draw();
    }, { passive: false });

    /* ── 输入：键盘 ── */

    const typingTarget = (t) => {
        if (!t || !t.tagName) return false;
        if (t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return true;
        return t.tagName === 'INPUT' && (t.type === 'text' || t.type === 'number' || t.type === 'search');
    };

    /** 工作区切走后画板只是 display:none，编辑器仍挂着 —— 那时绝不抢全局快捷键。 */
    const boardLive = () => canvas.isConnected && canvas.getBoundingClientRect().width > 0;

    const onKeyDown = (e) => {
        if (!boardLive()) return;
        if (e.code === 'Space') spaceDown = true;
        if (e.ctrlKey || e.altKey || e.metaKey) return;
        if (typingTarget(e.target)) return;
        // 外壳也在 window 上处理 [ ] 0 空格 与工具字母：画板在捕获阶段先吃，
        // 否则一次按键会同时动两处（尺寸被 nudge 两次、空格既播放又平移）。
        let used = true;
        if (e.key === '0') fit();
        else if (e.key === '[') setSize(size >= 20 ? size - 4 : size - 1);
        else if (e.key === ']') setSize(size >= 20 ? size + 4 : size + 1);
        else if (e.key === 'e' || e.key === 'E') setPickMode();
        else if (/^[1-7]$/.test(e.key)) {
            const b = BRUSH_PRESETS[Number(e.key) - 1];
            if (b) selectBrush(b.id);
        } else if (e.code === 'Space') {
            // 空格 = 按住平移，落点看 pointerdown
        } else {
            used = false;
        }
        if (used) {
            e.preventDefault();
            e.stopPropagation();
        }
    };
    const onKeyUp = (e) => {
        if (e.code === 'Space') spaceDown = false;
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('pointermove', onPanMove);
    window.addEventListener('pointerup', onPanUp);

    /* ── 工具条刷新 ── */

    function paintChrome() {
        for (const [id, btn] of brushBtns) btn.classList.toggle('is-on', id === brushId);
        swatch.style.background = color;
        swatch.title = '当前颜色 ' + color + '（点击打开色板）';
        sizeRange.value = String(Math.round(size));
        if (sizeNum.value !== String(Math.round(size))) sizeNum.value = String(Math.round(size));
        opacityRange.value = String(Math.round(opacity * 100));
        const pct = String(Math.round(opacity * 100));
        if (opacityNum.value !== pct) opacityNum.value = pct;
        const stabNum = stabBtn.querySelector('.bd-stab-n');
        if (stabNum && stabNum.textContent !== String(stabLevel)) stabNum.textContent = String(stabLevel);
        stabBtn.classList.toggle('is-on', stabLevel > 0);
        stabBtn.title = '笔迹稳定器：' + (stabLevel === 0 ? '关（0）' : stabLevel + ' 档')
            + '（点击切换 0–5 档，Ctrl+滚轮 也能调）';
        pickBtn.classList.toggle('is-on', pickMode);
        pickBtn.setAttribute('aria-pressed', pickMode ? 'true' : 'false');
        pickBtn.title = pickMode
            ? '取色器已开：点画布取色（E 取消）· 右键 / Alt+左键也可临时取色'
            : '取色器：点画布取一个像素（E）· 画布上右键或 Alt+左键随时取色';
        mirrorSel.value = mirror;
        if (engine && typeof engine.canUndo === 'function') undoBtn.disabled = !engine.canUndo();
        if (engine && typeof engine.canRedo === 'function') redoBtn.disabled = !engine.canRedo();
    }

    /* ── 生命周期 ── */

    recent = readRecent();
    mirror = lsGet(LS_MIRROR) || 'none';
    setMirror(mirror);
    paintRecent();
    drawCursor();

    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
        fittedFor = '';
        ensureFit();
        draw();
    }) : null;
    if (ro) ro.observe(stage);

    paintChrome();
    ensureFit();
    draw();

    let alive = true;
    const tick = () => {
        if (!alive) return;
        ensureFit();
        window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);

    return {
        refresh() {
            // 外部（色板 / 属性面板）也可能改颜色：以引擎状态为准
            if (typeof c.color === 'function') {
                const v = cssColor(c.color());
                if (v && v !== color) color = v;
            }
            ensureFit();
            paintChrome();
            draw();
        },
        focusFrame() {
            ensureFit();
        },
        destroy() {
            alive = false;
            if (ro) ro.disconnect();
            if (cursorRaf) window.cancelAnimationFrame(cursorRaf);
            window.removeEventListener('keydown', onKeyDown, { capture: true });
            window.removeEventListener('keyup', onKeyUp);
            window.removeEventListener('pointermove', onPanMove);
            window.removeEventListener('pointerup', onPanUp);
            window.removeEventListener('pointerdown', onOutsideDown, true);
            if (root.parentNode) root.parentNode.removeChild(root);
        },
    };
}
