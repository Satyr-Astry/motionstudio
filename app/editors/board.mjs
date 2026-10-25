/**
 * 画板编辑器 —— **只编辑一张纹理（texture）**，与编排器完全分离。
 *
 * 术语：以前叫「纹理」，现在统一叫**纹理**。一个对象的每条关键帧可以绑定一张纹理；
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
 * 结构（三段分区：工具 / 画板动作 / 参数）：
 *   .bd
 *     .bd-bar
 *       .bd-seg.bd-seg-tools              ①工具段
 *         .bd-brushes(.bd-brush[data-brush] × 7)   图标 + 两字短名
 *         .bd-swatch                      当前色块（点开极小色板）
 *         button[data-act=pick]           取色器（E）
 *         button[data-act=bucket]         填充（G）—— 与取色器互斥的"点一下"模式
 *         select.bd-mirror                镜像：无 / 左右 / 上下 / 四向
 *       .bd-seg.bd-seg-acts               ②画板动作段（靠右）
 *         button[data-act=undo|redo]      撤销 / 重做（引擎 history）
 *         button[data-act=stab]           稳定器（图标 + 档位 0–5）
 *         .bd-acts(.bd-act[data-act=prev|next|new|unique|fit])
 *     .bd-params                          ③参数段（常显，零折叠）
 *       .bd-prow(.bd-lab + input[type=range] + input.bd-num) × 6
 *         大小 / 不透明 / 硬度 / 间距 / 抖动 / 流量
 *       button[data-act=reset]            恢复默认（rotate-ccw）
 *     .bd-stage > canvas.bd-canvas + canvas.bd-ovl(笔刷游标层)
 *     .bd-pal   极小色板浮层（最近 6 色 + 前景/背景交换）
 *     .bd-hint
 *
 * 参数生效链路：localStorage['ms.brush.'+id] → resolveBrush() → makeTip() / spacingPx()。
 * 任何绕过 resolveBrush 直接用 BRUSH_PRESETS 的写法都会让「笔刷设置」失效。
 */

import {
    BRUSH_PARAM_KEYS, BRUSH_PRESETS, brushById, makeTip, marchStamps, resolveBrush, spacingPx, tipDiameter,
    alphaScaleAt, migrateBrushOverrides, pointerPressure, sizeScaleAt, SPACING_VERSION,
} from '../paint/brush.mjs';
import { captureRegion, makeRegionCommand } from '../paint/patch.mjs';
import { MAX_LEVEL, clampLevel, createStabilizer } from '../paint/stabilizer.mjs';
import { floodFillRegion } from '../paint/fill.mjs';
import { icon } from '../core/icons.mjs';
import { imageAt, objectById, objectsOf } from '../core/doc-model.mjs';

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;

const LS_BRUSH = 'ms.brush.';          // + 笔刷 id → 覆写 JSON
const LS_RECENT = 'ms.brush.recent';   // 最近用过的颜色
const LS_MIRROR = 'ms.brush.mirror';   // none / x / y / both
const LS_BG = 'ms.brush.bg';           // 前景/背景交换用的「背景色」
const LS_STAB = 'ms.board.stabilizer';  // 稳定器档位 0–5（默认 0 = 直通）
const LS_BRUSH_MIGRATE = 'ms.brush.migrate';  // 间距重标定的迁移版本（= SPACING_VERSION 就不再迁）

/**
 * 笔刷 chip 的显示：图标 + 两字短名（全名与快捷键放 title）。
 * 早先是单字（像/圆/软/铅/晕/散/擦）——单字不构成词，「像」是像素还是图像、「晕」是晕染还是模糊
 * 都得点了才知道。两字是「一眼读得懂」与「26px 工具条放得下」的折中点。
 * 见 docs/画板图标与可读性计划-2026-10.md §0 与 §5 第 1–7 行。
 */
const BRUSH_SHORT = {
    pixel: '像素', round: '圆头', soft: '柔边', pencil: '铅笔', smudge: '晕染', scatter: '散点', eraser: '橡皮',
};

/** 笔刷 chip 的图标名（icon-system 交付；名字缺失时 icon() 自己回退默认图标，不会炸）。 */
const BRUSH_ICON = {
    pixel: 'brush-pixel',
    round: 'brush-round',
    soft: 'brush-soft',
    pencil: 'pencil',
    smudge: 'brush-smudge',
    scatter: 'brush-scatter',
    eraser: 'eraser',
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

    /**
     * 填充用的纹理入口：把「没有纹理」和「纹理是导入位图」分成两种结局。
     *
     * 共享的 texture() 只返回 canvas 或 null，会把这两种情况混成一句"还没有纹理"——
     * 前者是用户操作前提没满足（该点「纹理」新建），后者是能力边界（导入的 PNG/PSD
     * 图层是 ImageBitmap，没有 getContext，本就改不了）。混着说，用户会以为是自己少做了什么。
     *
     * @returns {{ kind: 'ok'|'none'|'bitmap', img: HTMLCanvasElement|null }}
     */
    function textureForFill() {
        const obj = targetObject();
        if (!obj) return { kind: 'none', img: null };
        const raw = imageAt(obj, timeNow());
        if (!raw || typeof raw.getContext !== 'function') {
            return { kind: raw ? 'bitmap' : 'none', img: null };
        }
        return { kind: 'ok', img: raw };
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

    /**
     * 一次性迁移：间距重标定（0.12 → 0.42445 等）之后，旧默认值已经写进 localStorage 的
     * 覆写表里，会让用户「一打开就还是老手感」。这里把**恰好等于旧默认值**的那一条删掉，
     * 让新默认生效；用户自己拖过的值原样保留。版本号写进 `ms.brush.migrate`，只迁一次。
     */
    function migrateSpacingPrefs() {
        const done = lsGet(LS_BRUSH_MIGRATE);
        if (done === String(SPACING_VERSION)) return;
        for (const preset of BRUSH_PRESETS) {
            const key = LS_BRUSH + preset.id;
            const raw = lsGet(key);
            if (!raw) continue;
            let parsed = null;
            try {
                parsed = JSON.parse(raw);
            } catch (err) {
                parsed = null;
            }
            const next = migrateBrushOverrides(parsed, preset.id);
            if (!next) continue;
            if (Object.keys(next).length) lsSet(key, JSON.stringify(next));
            else lsDel(key);
            overrideCache.delete(preset.id);
        }
        lsSet(LS_BRUSH_MIGRATE, String(SPACING_VERSION));
    }

    migrateSpacingPrefs();

    /* ── 私有相机（与舞台无关） ── */

    const cam = { zoom: 1, panX: 0, panY: 0 };
    let fittedFor = '';

    /**
     * 把整张纹理缩放到刚好可见。**只动视图相机，不动像素**。
     * silent 用于启动/换图后的自动适配（每次都弹提示会很吵）；
     * 用户主动点「适配」时会区分「本来就在适配位」和「刚适配过」，
     * 否则零变化会让人以为按钮坏了（见 docs/修复列表-v8.md §1s）。
     */
    function fit(opts) {
        const silent = !!(opts && opts.silent);
        userCam = false;
        const img = texture();
        const r = canvas.getBoundingClientRect();
        const vw = Math.max(32, r.width || canvas.clientWidth || 640);
        const vh = Math.max(32, r.height || canvas.clientHeight || 480);
        const w = img ? img.width : 640;
        const h = img ? img.height : 480;
        const z = Math.min((vw - 24) / w, (vh - 24) / h);
        const same = Math.abs(cam.zoom - Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z))) < 1e-6
            && Math.abs(cam.panX - Math.round((vw - w * Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z))) / 2)) <= 1
            && Math.abs(cam.panY - Math.round((vh - h * Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z))) / 2)) <= 1;
        cam.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
        cam.panX = Math.round((vw - w * cam.zoom) / 2);
        cam.panY = Math.round((vh - h * cam.zoom) / 2);
        draw();
        if (silent) return;
        notify(same
            ? '视图已经在适配位置：整张纹理都可见。要去掉四周的透明区，用「裁到内容」'
            : '已适配视图：整张纹理铺满可视区（不动像素）');
    }

    /** 画布尺寸或纹理换了 → 重新适配一次（适配过就不再打扰）。 */
    function ensureFit() {
        const img = texture();
        const key = (img ? img.width + 'x' + img.height : 'none') + '@' + Math.round(canvas.clientWidth) + 'x' + Math.round(canvas.clientHeight);
        if (key === fittedFor) return;
        fittedFor = key;
        fit({ silent: true });
    }

    /* ── DOM：工具条 ── */

    const root = mk('div', 'bd');

    const bar = mk('div', 'bd-bar');

    const brushes = mk('div', 'bd-brushes');
    const brushBtns = new Map();
    BRUSH_PRESETS.forEach((b, i) => {
        const btn = mk('button', 'bd-brush');
        btn.type = 'button';
        btn.dataset.brush = b.id;
        btn.innerHTML = icon(BRUSH_ICON[b.id] || 'circle')
            + '<span>' + (BRUSH_SHORT[b.id] || b.name.slice(0, 2)) + '</span>';
        btn.title = b.name + '（快捷键 ' + (i + 1) + '）';
        btn.setAttribute('aria-label', b.name + '（快捷键 ' + (i + 1) + '）');
        brushes.appendChild(btn);
        brushBtns.set(b.id, btn);
    });

    // 当前色块：点开极小色板
    const swatch = mk('button', 'bd-swatch');
    swatch.type = 'button';
    swatch.title = '当前颜色（点击打开色板）';

    // 大小：名称 + 滑杆 + 可手输数值（三段式，名称永不隐藏）
    const sizeField = mk('label', 'bd-prow bd-prow-size');
    sizeField.title = '笔尖大小（像素，[ / ] 调整）';
    sizeField.appendChild(mk('span', 'bd-lab bd-plab', '大小'));
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

    // 不透明度：名称 + 滑杆 + 数字（百分比）
    const opacityField = mk('label', 'bd-prow bd-prow-opacity');
    opacityField.title = '笔刷不透明度（%）';
    opacityField.appendChild(mk('span', 'bd-lab bd-plab', '不透明'));
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

    // 油漆桶：与取色器同为「点一下生效」的模式工具（不是按住才生效的临时工具）。
    const bucketBtn = mk('button', 'bd-ico');
    bucketBtn.type = 'button';
    bucketBtn.dataset.act = 'bucket';
    bucketBtn.innerHTML = icon('bucket');
    bucketBtn.setAttribute('aria-label', '填充');
    bucketBtn.title = '填充：点画布把同色连通区一次填满（G）';

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

    // 稳定器：图标 + 档位数字（0–5）。数字是读数，必须留（C 类，不许纯图标化）。
    const stabBtn = mk('button', 'bd-ico bd-stab');
    stabBtn.type = 'button';
    stabBtn.dataset.act = 'stab';
    stabBtn.setAttribute('aria-label', '笔迹稳定器档位');
    stabBtn.title = '笔迹稳定器（点击切换 0–5 档，Ctrl+滚轮 也能调）';
    stabBtn.innerHTML = icon('stabilizer') + '<span class="bd-stab-n">0</span>';

    const acts = mk('div', 'bd-acts');
    // 五个纹理动作：‹ › 是纯图标（翻页箭头，文字放不下也没必要），后三个保留中文并加前置图标。
    // "＋纹理" 的全角加号由 plus 图标承担，文字只剩「纹理」，避免出现「＋ ＋纹理」。
    for (const [act, iconName, text, title] of [
        ['prev', 'chevron-left', '', '上一张纹理'],
        ['next', 'chevron-right', '', '下一张纹理'],
        // 动作名带 -tex 后缀：顶栏「新建项目」也叫 new，跨面板的 [data-act="new"]
        // 查询会命中错的那个（W20 的端到端脚本就踩过），一个面板内不必让路，跨面板必须唯一。
        ['new-tex', 'plus', '纹理', '新建一张空白纹理并绑定到当前时刻'],
        ['unique', 'sparkle', '独特化', '把当前纹理拷一份，之后改它不影响别处'],
        ['fit', 'fit', '适配', '把整张纹理缩放到刚好可见（只动视图，不改像素）· 0 键'],
    ]) {
        const btn = mk('button', 'bd-act');
        btn.type = 'button';
        btn.dataset.act = act;
        btn.innerHTML = icon(iconName) + (text ? `<span>${text}</span>` : '');
        btn.title = title;
        btn.setAttribute('aria-label', title);
        acts.appendChild(btn);
    }

    /* ── 纹理尺寸控件（动作段尾部）：裁到内容 / 宽×高 / 应用 / 对齐 ──
       用户原话「擦除冗余部分后点适配，无法把透明通道裁到合适尺寸，也不能扩大画布」。
       「适配」是视图相机（fit()，0 键），不是裁剪 —— 尺寸能力原先整个缺失，所以补的是
       入口不是语义。真正的像素搬运在 shell 侧 `ctx.resizeTexture(objId, {...})`（W19 的
       task-29），这里只做入口与守卫：命令没接线时一律禁用并在 title 里写明，
       绝不出现「点了没反应」——那正是这轮投诉的同类问题。 */
    const sizeCtl = mk('div', 'bd-size-ctl');

    const cropBtn = mk('button', 'bd-ico');
    cropBtn.type = 'button';
    cropBtn.dataset.act = 'crop';
    cropBtn.innerHTML = icon('crop-content');

    const sizeW = mk('input', 'bd-size-w');
    sizeW.type = 'number';
    sizeW.min = '1';
    sizeW.max = '8192';
    sizeW.step = '1';
    sizeW.setAttribute('aria-label', '纹理宽度（像素）');

    const sizeX = mk('span', 'bd-size-x', '×');

    const sizeH = mk('input', 'bd-size-h');
    sizeH.type = 'number';
    sizeH.min = '1';
    sizeH.max = '8192';
    sizeH.step = '1';
    sizeH.setAttribute('aria-label', '纹理高度（像素）');

    const applySizeBtn = mk('button', 'bd-ico');
    applySizeBtn.type = 'button';
    applySizeBtn.dataset.act = 'resize';
    applySizeBtn.innerHTML = icon('canvas-resize');

    // 对齐：显式三档，不用 Shift/Alt 这种隐藏修饰键切语义（keepPlace 那轮已经否掉这套）
    const alignSel = mk('select', 'bd-align');
    for (const [value, text] of [['nw', '左上'], ['c', '居中'], ['se', '右下']]) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = text;
        alignSel.appendChild(opt);
    }
    alignSel.value = 'c';

    sizeCtl.append(cropBtn, sizeW, sizeX, sizeH, applySizeBtn, alignSel);

    /* 三段分区（计划 §4）：①工具 ②画板动作 —— 两段同处 .bd-bar，靠 1px --line 竖线分隔；
       ③参数在下一行 .bd-params。分组而不是靠 gap 猜，是这次重排的主线之一。 */
    const segTools = mk('div', 'bd-seg bd-seg-tools');
    segTools.append(brushes, swatch, pickBtn, bucketBtn, mirrorSel);

    const segActs = mk('div', 'bd-seg bd-seg-acts');
    segActs.append(undoBtn, redoBtn, stabBtn, acts, sizeCtl);

    bar.append(segTools, segActs);

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

    /* ── DOM：参数行（常显，零折叠）──
       原先硬度/间距/抖动/流量藏在 .bd-pop 里：不点开就不知道有这四个参数，点开还挡画布。
       现在 6 项平铺，每项同构三段式：名称 + 滑杆 + 可手输数值。名称常显，不随窗口宽度消失。 */

    const params = mk('div', 'bd-params');
    // 顺序即优先级：大小 / 不透明 在最常调，硬软类参数在后（与 Klecks 笔刷面板同一顺序）
    params.append(sizeField, opacityField);

    const paramRows = [];
    const applyParam = (entry, intValue) => {
        const raw = Number(intValue);
        const v = Math.min(entry.max, Math.max(entry.min, Math.round(Number.isFinite(raw) ? raw : entry.min)));
        entry.range.value = String(v);
        entry.num.value = String(v);
        const next = Object.assign({}, overridesFor(brushId));
        next[entry.key] = entry.from(v);
        saveOverrides(brushId, next);
        tipSig = '';
        scheduleCursor();
    };

    for (const ui of PARAM_UI) {
        const row = mk('label', 'bd-prow');
        row.title = ui.label;
        row.appendChild(mk('span', 'bd-lab bd-plab', ui.label));
        const range = mk('input');
        range.type = 'range';
        range.min = String(ui.min);
        range.max = String(ui.max);
        range.step = String(ui.step);
        range.dataset.param = ui.key;
        range.setAttribute('aria-label', ui.label);
        const num = mk('input', 'bd-num');
        num.type = 'number';
        num.min = String(ui.min);
        num.max = String(ui.max);
        num.step = String(ui.step);
        num.value = String(ui.min);
        num.title = ui.label;
        row.append(range, num);
        params.appendChild(row);

        const entry = { ...ui, range, num };
        paramRows.push(entry);
        range.addEventListener('input', () => applyParam(entry, Number(range.value)));
        num.addEventListener('change', () => applyParam(entry, Number(num.value)));
    }

    // 「恢复默认」并进最后一项（流量）的行尾：它单独吃一整行会让 1000×620 的画布跌破 360px 红线。
    const resetBtn = mk('button', 'bd-ico bd-params-reset');
    resetBtn.type = 'button';
    resetBtn.dataset.act = 'reset';
    resetBtn.innerHTML = icon('rotate-ccw');
    resetBtn.setAttribute('aria-label', '恢复这支笔的默认参数');
    resetBtn.title = '恢复默认：清除这支笔的记忆参数';
    (params.lastElementChild || params).appendChild(resetBtn);

    const hint = mk('div', 'bd-hint', '左键画 · 右键/Alt 取色 · E 取色器 · G 填充 · [ ] 笔尖 · 1–7 笔刷 · 滚轮缩放 · 空格/中键平移 · 0 适配');

    root.append(bar, params, stage, pal, hint);
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
    // 桶是**模式**（选中后左键点即填），与取色器互斥；两者都不要和右键那条临时取色路径共用状态。
    let bucketMode = false;
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
        if (pickMode || rightPick || bucketMode) {
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

    /**
     * 落一个笔尖。
     *
     * `pressure` 是 0..1 的指针压力（鼠标 / 无压感设备恒为 1，见 brush.mjs:pointerPressure）。
     * 只有开了 `sizePressure` 的笔刷会按压力缩直径；`k === 1` 时**走原来的 3 参 drawImage**
     * （不缩放、不重采样），保证「压感关」的笔迹与改动前逐像素一致。
     * 抖动、散点散布半径、镜像偏移都按缩放后的半宽算，压感笔的纹理才等比缩小。
     */
    function stamp(g, img, x, y, alpha, pressure) {
        const b = activeBrush();
        const t = currentTip();
        if (!t) return;
        const k = sizeScaleAt(b, pressure);
        const half = t.width / 2;
        const hw = half * k;                       // 本次落点的半宽（压感缩放后）
        const w = t.width * k;
        const a0 = alpha * alphaScaleAt(b, pressure);
        const centers = mirrorCenters(img, x, y);
        const jitter = clamp(b.jitter, 0, 1, 0) * hw;
        /** 画一个笔尖位图；k === 1 走快路径（与原实现完全同一句）。 */
        const put = (src, cx, cy) => {
            if (k === 1) g.drawImage(src, cx - half, cy - half);
            else g.drawImage(src, cx - hw, cy - hw, w, w);
        };
        g.save();
        g.globalCompositeOperation = b.erase ? 'destination-out' : 'source-over';
        if (k !== 1) g.imageSmoothingEnabled = true;   // 缩小重采样需要平滑，否则边缘有锯齿
        if (b.scatter) {
            const n = Math.max(1, Math.round(b.scatter.count));
            const rad = hw * Math.max(0, b.scatter.spread);
            const dots = [];
            for (let i = 0; i < n; i += 1) {
                const a = Math.random() * Math.PI * 2;
                const rr = Math.sqrt(Math.random()) * rad;
                dots.push({ x: Math.cos(a) * rr, y: Math.sin(a) * rr });
            }
            g.globalAlpha = clamp(a0 / Math.sqrt(n), 0.02, 1, 0.02);
            for (const center of centers) {
                for (const d of dots) put(t, center.x + d.x, center.y + d.y);
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
            g.globalAlpha = clamp(a0 * (b.strength == null ? 0.55 : b.strength), 0.02, 1, 0.02);
            for (const center of centers) put(smudgeBuf, center.x, center.y);
            g.globalAlpha = clamp(a0 * 0.25, 0.02, 1, 0.02);
            for (const center of centers) put(t, center.x, center.y);
        } else {
            g.globalAlpha = clamp(a0, 0.02, 1, 0.02);
            for (const center of centers) {
                const jx = jitter ? (Math.random() * 2 - 1) * jitter : 0;
                const jy = jitter ? (Math.random() * 2 - 1) * jitter : 0;
                put(t, center.x + jx, center.y + jy);
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
        const pr = pointerPressure(e);      // 鼠标 / 无压感设备恒 1 → 下面 k=1，笔迹不变
        const s = {
            img,
            g,
            last: { x: head.x, y: head.y },
            gap: spacingPx(activeBrush(), size),
            carry: 0,
            before,
            points: [{ x: head.x, y: head.y }],
            moved: false,
            pp: pr,                          // 上一个落点的压力（段内插值的起点）
        };
        stroke = s;
        stamp(g, img, head.x, head.y, paintAlpha(), pr);
        draw();
        return s;
    }

    /**
     * 从一个落点走到目标点，沿途按间距（跟着压感缩放）补落点。
     * 落点算子在 `brush.mjs` 的 `marchStamps`（纯函数、有测试），这里只管画。
     */
    function walkTo(s, tx, ty, pr) {
        const prev = s.points[s.points.length - 1];
        if (Math.hypot(tx - prev.x, ty - prev.y) < 0.01) return;   // 亚像素抖动：不落笔
        const r = marchStamps(prev, { x: tx, y: ty }, {
            brush: activeBrush(),
            gap: s.gap,
            carry: s.carry,
            pressureFrom: Number.isFinite(s.pp) ? s.pp : 1,
            pressureTo: pr,
        });
        s.carry = r.carry;
        s.pp = pr;
        for (const st of r.stamps) {
            stamp(s.g, s.img, st.x, st.y, paintAlpha(), st.p);
            s.last = { x: st.x, y: st.y };
            s.points.push({ x: st.x, y: st.y });
            s.moved = true;
        }
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
        walkTo(s, r.x, r.y, pointerPressure(e));
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
        // 松手追平：平滑点天然滞后于笔尖，线尾必须落在真正的笔尖处（Klecks 的 finishOnUp）。
        // 沿途也要按间距补点 —— 稳定器档位越高滞后越远，只落一个点会把尾巴断成一截空白。
        if (s.moved && tail && Math.hypot(tail.x - s.last.x, tail.y - s.last.y) >= 0.5) {
            walkTo(s, tail.x, tail.y, Number.isFinite(s.pp) ? s.pp : 1);
            if (Math.hypot(tail.x - s.last.x, tail.y - s.last.y) >= 0.5) {
                stamp(s.g, s.img, tail.x, tail.y, paintAlpha(), s.pp);
                s.points.push({ x: tail.x, y: tail.y });
                s.last = { x: tail.x, y: tail.y };
            }
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

    /* ── 油漆桶 ── */

    /** 桶与取色器互斥：两个都是"左键点一下"的模式，同时开着会让一次点击有两种解释。 */
    function setBucketMode(on) {
        bucketMode = !!(on == null ? !bucketMode : on);
        if (bucketMode) pickMode = false;
        paintChrome();
        scheduleCursor();
    }

    /**
     * 把当前纹理的同色连通区一次填满。
     *
     * 时序安全的关键：第 1 步拿到 img 之后，2–5 全在同一个同步块里 —— 没有 await、没有 rAF、
     * 没有再调一次 texture()/timeNow()。setDoc 触发的重渲染只能在 pointerdown 返回后跑，
     * 所以不存在「算出 A 的填充、写进 B」的调度窗口。撤销命令绑的是 img 这个引用（与落笔
     * 同一套 makeRegionCommand），事后切纹理/换纹理/删对象都不会写错图。
     *
     * @param {PointerEvent} e
     * @returns {boolean} 是否真的填了（false 时一定没产生撤销命令）
     */
    function fillAt(e) {
        const { kind, img } = textureForFill();
        if (kind === 'none') {
            notify('这个时刻还没有纹理：点「纹理」新建一张');
            return false;
        }
        if (kind === 'bitmap') {
            // 导入位图是 ImageBitmap，没有 getContext —— 不许偷偷画到临时画布上再丢回去
            notify('这张纹理是导入位图，暂不支持填充');
            return false;
        }
        const g = img.getContext('2d', { willReadFrequently: true });
        if (!g) return false;
        const W = img.width;
        const H = img.height;
        const p = toTexture(e);
        const x = Math.floor(p.x);
        const y = Math.floor(p.y);

        const before = captureRegion(img, { x: 0, y: 0, w: W, h: H });
        let frame;
        try {
            g.setTransform(1, 0, 0, 1, 0, 0);
            frame = g.getImageData(0, 0, W, H);
        } catch (err) {
            // 纹理可能刚好被撤销/换成 detached 画布：这一次填不了，别让它炸掉整个 pointerdown
            notify('这张纹理现在读不了，没法填充');
            return false;
        }
        const res = floodFillRegion(frame.data, W, H, x, y, color);
        if (!res.changed) {
            if (x < 0 || y < 0 || x >= W || y >= H) notify('点在纹理外面了，没法填充');
            else notify('这块已经是当前色，不用再填');
            return false;
        }
        g.putImageData(frame, 0, 0);
        const after = captureRegion(img, { x: 0, y: 0, w: W, h: H });
        if (engine && typeof engine.pushCommand === 'function' && before && after) {
            engine.pushCommand(makeRegionCommand(img, before, after, '填充（纹理）'));
        }
        draw();
        if (typeof c.requestRender === 'function') c.requestRender();
        notify('填充 ' + res.painted + ' 个像素');
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
        syncParams();
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
        paintRecent();
        placePop(pal, swatch);
    }

    function closePal() {
        pal.hidden = true;
    }

    /* 参数常显之后不再有「笔刷设置浮层」：openPop/closePop 随 .bd-pop 一起删掉，
       syncParams 改为无条件同步（参数值任何时候都和当前笔刷一致）。 */

    function syncParams() {
        const b = activeBrush();
        for (const row of paramRows) {
            const v = Number(b[row.key]);
            row.range.value = String(row.to(Number.isFinite(v) ? v : 0));
            row.num.value = String(Math.round((Number.isFinite(v) ? v : 0) * 100));
        }
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
        // 纹理可能换了（新建 / 翻页 / 独特化 / 重设尺寸）—— 尺寸控件必须跟着刷新，
        // 否则按钮停留在上一张纹理的可用性上，就是「点了没反应」的另一种形态。
        syncSizeCtl();
    }

    /* ── 纹理尺寸：守卫 + 执行 ──
       命令契约（W19 task-29）：`ctx.resizeTexture(objId, { mode:'trim' })` 或
       `{ mode:'resize', width, height, align }`（align: 'nw'|'c'|'se'），返回 boolean。
       返回 false 时对方已经 notify 过原因，这里不重复弹 —— 只负责不要出现「点了没反应」。 */

    const SIZE_LIMIT = 8192;

    function sizeCmdReady() {
        return typeof c.resizeTexture === 'function';
    }

    function runSize(payload) {
        if (!sizeCmdReady()) return false;
        const id = activeId();
        if (id == null) return false;
        if (c.resizeTexture(id, payload) !== true) return false;
        // 尺寸变了 → 相机要重新适配一次（旧 zoom 是按旧尺寸算的），并重绘
        afterDocChange();
        syncSizeCtl();
        return true;
    }

    function applySizeFromInputs() {
        const w = Math.round(Number(sizeW.value));
        const h = Math.round(Number(sizeH.value));
        if (!Number.isFinite(w) || !Number.isFinite(h)) return false;
        if (w < 1 || h < 1 || w > SIZE_LIMIT || h > SIZE_LIMIT) return false;
        return runSize({ mode: 'resize', width: w, height: h, align: alignSel.value || 'c' });
    }

    /** 把两个按钮的可点性与 title 拉到真实状态：命令缺失 / 没有纹理都是明确原因，不装死。 */
    function syncSizeCtl() {
        const img = texture();
        const ready = sizeCmdReady();
        const why = !ready
            ? '尺寸命令尚未接线（W19 task-29 落地后可用）'
            : !img
                ? '当前时刻还没有纹理：先点「纹理」新建一张'
                : '';
        const cropTitle = why || '把纹理裁到内容包围盒（去掉四周透明）';
        cropBtn.disabled = !!why;
        cropBtn.title = cropTitle;
        cropBtn.setAttribute('aria-label', cropTitle);
        const applyTitle = why || '按当前尺寸重设纹理画布';
        applySizeBtn.disabled = !!why;
        applySizeBtn.title = applyTitle;
        applySizeBtn.setAttribute('aria-label', applyTitle);
        alignSel.disabled = !ready;
        alignSel.title = ready
            ? '重设尺寸时旧内容放在新画布的位置'
            : '尺寸命令尚未接线（W19 task-29 落地后可用）';
        alignSel.setAttribute('aria-label', alignSel.title);
        sizeW.disabled = !!why;
        sizeH.disabled = !!why;
        // 正在输入的框不抢值 —— 否则打到一半就被写回旧尺寸
        if (document.activeElement !== sizeW) sizeW.value = img ? String(img.width) : '';
        if (document.activeElement !== sizeH) sizeH.value = img ? String(img.height) : '';
    }

    /* 尺寸输入框里回车 = 应用（不必先把焦点挪到按钮上）。
       绑在 root 而不是 window：只在画板内部生效，不往全局键盘上加东西。 */
    root.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        if (e.target !== sizeW && e.target !== sizeH) return;
        e.preventDefault();
        applySizeFromInputs();
    });

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
            case 'bucket':
                setBucketMode();
                return;
            case 'settings':
                // 参数已常显，这个入口不再需要（保留 case 只为吃掉旧 DOM 里可能残留的按钮）
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
                syncSizeCtl();
                if (typeof c.requestRender === 'function') c.requestRender();
                return;
            case 'redo':
                if (typeof c.redo === 'function') c.redo();
                draw();
                syncSizeCtl();
                if (typeof c.requestRender === 'function') c.requestRender();
                return;
            case 'fit':
                fit();
                return;
            case 'crop':
                runSize({ mode: 'trim' });
                return;
            case 'resize':
                applySizeFromInputs();
                return;
            case 'prev':
                if (typeof c.goPrevCel === 'function') c.goPrevCel();
                afterDocChange();
                return;
            case 'next':
                if (typeof c.goNextCel === 'function') c.goNextCel();
                afterDocChange();
                return;
            case 'new-tex': {
                const made = typeof c.newDrawing === 'function' ? c.newDrawing(null) : null;
                // newDrawing 只把图画进「纹理库」，**不在时间轴上占位**（纹理 ≠ 曝光）。
                // 不落位就等于「点纹理没反应」，所以这里补一次 placeDrawing，把它放到当前时刻。
                const obj = targetObject();
                const placed = made && obj && typeof c.placeDrawing === 'function'
                    ? c.placeDrawing(obj.id, timeNow(), made)
                    : false;
                if (!made) notify('新建纹理失败');
                else if (placed) notify('已新建纹理并绑定到当前时刻');
                else notify('已新建纹理（进了纹理库，这个时刻还没放上去）');
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
        if (bucketMode) {
            fillAt(e);
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
        else if (e.key === 'g' || e.key === 'G') setBucketMode();
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
        bucketBtn.classList.toggle('is-on', bucketMode);
        bucketBtn.setAttribute('aria-pressed', bucketMode ? 'true' : 'false');
        bucketBtn.title = bucketMode
            ? '填充已开：点画布填满同色连通区（G 取消）'
            : '填充：点画布把同色连通区一次填满（G）';
        mirrorSel.value = mirror;
        if (engine && typeof engine.canUndo === 'function') undoBtn.disabled = !engine.canUndo();
        if (engine && typeof engine.canRedo === 'function') redoBtn.disabled = !engine.canRedo();
        syncSizeCtl();
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
