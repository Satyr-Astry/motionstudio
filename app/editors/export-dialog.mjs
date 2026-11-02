/**
 * MotionStudio —— 导出对话框（第 32 批）
 *
 * 一个浮层收全部导出参数（缩放 / 帧率 / 时间范围 / 背景 / 导出后打开），
 * 三条通道共用：PNG 序列、精灵图、WebM。
 *
 * 键盘契约（真机验收点）：
 * - `Esc` 关闭且**不导出**；
 * - `Tab` 能走完所有控件（无 `tabindex=-1` 的陷阱）；
 * - `Enter` 等于点「导出」（在文本/数字输入框里同样成立）；
 * - 打开时焦点落在「导出」按钮上。
 *
 * 依赖方向：本文件只做 DOM 与事件，导出本身由调用方注入的 `run` 执行 ——
 * 这样它能被 node 单测（`jsdom` 之外的纯函数部分）与真机共用同一套参数校验。
 */

import {
    ENGINES,
    EXPORT_DEFAULTS,
    FORMATS,
    PRESET_IDS,
    applyPreset,
    normalizeExportOptions,
} from '../core/export-options.mjs';
import { t } from '../i18n/index.mjs';

const LS_KEY = 'ms.export';

/**
 * 透明背景导出 WebM 需要用户再确认一次（纯判定，node 可测）。
 *
 * 为什么要问：Chromium 的 `MediaRecorder`（vp9 / vp8 / webm 三种封装）**不录 alpha 通道**，
 * 透明画布录出来就是黑底；真 alpha 得换 WebCodecs（`docs/导出通道方案-2026-11-02.md` 明确列为
 * 「不做」）。所以界面只能做到「说清楚 + 让用户显式确认」，不能假装支持透明，也不能替用户默默导出。
 *
 * @param {string} background `'transparent'` / `'solid'`
 * @returns {boolean} 是否需要二次确认
 */
export function needsVideoAlphaConfirm(background) {
    return background !== 'solid';
}

/** 读记忆的导出参数：坏 JSON / 越界值一律回落默认，不抛。 */
export function readExportPrefs(storage) {
    const st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!st || typeof st.getItem !== 'function') return Object.assign({}, EXPORT_DEFAULTS);
    try {
        const raw = st.getItem(LS_KEY);
        if (!raw) return Object.assign({}, EXPORT_DEFAULTS);
        const obj = JSON.parse(raw);
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return Object.assign({}, EXPORT_DEFAULTS);
        const out = Object.assign({}, EXPORT_DEFAULTS);
        ['scale', 'fps', 'from', 'to', 'quality', 'maxTextureSize'].forEach((k) => {
            const n = Number(obj[k]);
            if (Number.isFinite(n)) out[k] = n;
        });
        if (obj.background === 'solid' || obj.background === 'transparent') out.background = obj.background;
        if (typeof obj.bgColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(obj.bgColor)) out.bgColor = obj.bgColor;
        if (typeof obj.openAfter === 'boolean') out.openAfter = obj.openAfter;
        if (typeof obj.trim === 'boolean') out.trim = obj.trim;
        if (FORMATS.includes(obj.format)) out.format = obj.format;
        if (ENGINES.includes(obj.engine)) out.engine = obj.engine;
        return out;
    } catch (err) {
        return Object.assign({}, EXPORT_DEFAULTS);
    }
}

/** 存记忆的导出参数：只存白名单字段。 */
export function writeExportPrefs(prefs, storage) {
    const st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!st || typeof st.setItem !== 'function') return false;
    const p = prefs || {};
    const slim = {
        scale: Number(p.scale) || 1,
        fps: Number.isFinite(Number(p.fps)) ? Number(p.fps) : 0,
        from: Number(p.from) || 0,
        to: Number(p.to) || 0,
        background: p.background === 'solid' ? 'solid' : 'transparent',
        bgColor: typeof p.bgColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.bgColor) ? p.bgColor : EXPORT_DEFAULTS.bgColor,
        openAfter: p.openAfter !== false,
        format: FORMATS.includes(p.format) ? p.format : EXPORT_DEFAULTS.format,
        quality: Number.isFinite(Number(p.quality)) ? Number(p.quality) : EXPORT_DEFAULTS.quality,
        engine: ENGINES.includes(p.engine) ? p.engine : EXPORT_DEFAULTS.engine,
        // 这两项界面上没有控件（预设会写它们），但**必须存** ——
        // 不存的话用户点了「排版」预设、重开对话框又变回裁剪 + 4096。
        trim: p.trim !== false,
        maxTextureSize: Number.isFinite(Number(p.maxTextureSize)) ? Number(p.maxTextureSize) : EXPORT_DEFAULTS.maxTextureSize,
    };
    try {
        st.setItem(LS_KEY, JSON.stringify(slim));
        return true;
    } catch (err) {
        return false;
    }
}

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
}

function fmtTime(t) {
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) return '0.00';
    return n.toFixed(2);
}

/**
 * 打开导出对话框。
 *
 * @param {object} deps
 * @param {() => object} deps.doc 取当前文档（用于范围上界与默认值）
 * @param {(kind:string, opts:object, ui:object) => Promise<object>} deps.run 执行导出
 *        `kind` 是 `'frames'` / `'sheet'` / `'video'`；`ui` 提供 `progress(done,total)` 与 `canceled()`。
 * @param {() => string} [deps.projectName]
 * @returns {Promise<{kind:string, opts:object, res:object}|null>} 取消/关闭返回 null
 */
export function openExportDialog(deps) {
    const d = deps && typeof deps === 'object' ? deps : {};
    if (typeof document === 'undefined' || !document.body) return Promise.resolve(null);
    const doc = typeof d.doc === 'function' ? d.doc() : null;
    if (!doc) return Promise.resolve(null);
    const host = d.host && d.host.appendChild ? d.host : document.body;
    // 记忆值打底、preset 覆盖：preset 来自调用方（例如「导出这一段的帧」按钮带着时间范围进来）
    const prefs = Object.assign(readExportPrefs(d.storage), d.preset && typeof d.preset === 'object' ? d.preset : {});

    return new Promise((resolve) => {
        let settled = false;
        let kind = 'frames';
        let busy = false;
        let canceled = false;
        // 透明背景 + WebM 的二次确认态：第一次点「导出 WebM」只提醒，第二次才真导出。
        // 用户改任何导出设置都重置（见 resetVideoConfirm 的调用点），避免「改完背景还按旧确认走」。
        let videoConfirm = false;

        const root = el('div', 'exp-modal');
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-label', t('export.dialog.aria'));
        Object.assign(root.style, {
            position: 'fixed',
            inset: '0',
            zIndex: '70',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'rgba(0,0,0,0.45)',
        });

        const box = el('div', 'exp-box');
        Object.assign(box.style, {
            width: '360px',
            maxWidth: '92vw',
            background: '#1d2027',
            border: '1px solid #3a3f4b',
            borderRadius: '6px',
            padding: '14px 16px',
            font: '12px/1.5 system-ui, sans-serif',
            color: '#d8dbe2',
            boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
        });
        root.appendChild(box);

        const title = el('div', 'exp-title', t('export.dialog.title'));
        Object.assign(title.style, { fontWeight: '600', marginBottom: '10px' });
        box.appendChild(title);

        // 预设：一行四个按钮，作用只是「把下面几项填一遍」。
        // 不记录「当前是哪个预设」——用户之后改任何一项都不会被改回去（见 export-options.mjs 的说明）。
        // fillPreset 在控件都建好之后才赋值，这里先用空函数占位（点击发生在之后，闭包拿到的是最终值）。
        let fillPreset = () => {};
        const presetWrap = el('div', 'exp-presets');
        Object.assign(presetWrap.style, { display: 'flex', gap: '6px', margin: '0 0 10px', flexWrap: 'wrap' });
        PRESET_IDS.forEach((id) => {
            const b = el('button', 'exp-preset-' + id, t('export.preset.' + id));
            b.type = 'button';
            b.title = t('export.preset.' + id + '.hint');
            Object.assign(b.style, {
                background: '#242932',
                color: '#cfd4de',
                border: '1px solid #3f4551',
                borderRadius: '4px',
                padding: '3px 10px',
                font: '12px/1.4 system-ui, sans-serif',
                cursor: 'pointer',
            });
            b.addEventListener('click', () => fillPreset(id));
            presetWrap.appendChild(b);
        });
        presetWrap.appendChild(el('span', 'exp-preset-note', t('export.preset.note')));
        box.appendChild(presetWrap);

        const row = (label, node) => {
            const r = el('label', 'exp-row');
            Object.assign(r.style, { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0' });
            const s = el('span', 'exp-label', label);
            Object.assign(s.style, { width: '64px', flex: '0 0 auto', color: '#9aa1ad' });
            r.appendChild(s);
            r.appendChild(node);
            box.appendChild(r);
            return r;
        };

        const fieldStyle = {
            flex: '1 1 auto',
            minWidth: '0',
            background: '#14171c',
            color: '#d8dbe2',
            border: '1px solid #3a3f4b',
            borderRadius: '4px',
            padding: '3px 6px',
            font: '12px/1.4 system-ui, sans-serif',
        };

        const scale = el('input', 'exp-scale');
        scale.type = 'number';
        scale.min = '0.05';
        scale.max = '4';
        scale.step = '0.05';
        scale.value = String(prefs.scale || 1);
        Object.assign(scale.style, fieldStyle);
        row(t('export.field.scale'), scale);

        const fps = el('input', 'exp-fps');
        fps.type = 'number';
        fps.min = '0';
        fps.max = '120';
        fps.step = '1';
        fps.value = String(prefs.fps || 0);
        fps.title = t('export.field.fps.hint');
        Object.assign(fps.style, fieldStyle);
        row(t('export.field.fps'), fps);

        const from = el('input', 'exp-from');
        from.type = 'number';
        from.min = '0';
        from.step = '0.01';
        from.value = fmtTime(prefs.from);
        Object.assign(from.style, fieldStyle);

        const to = el('input', 'exp-to');
        to.type = 'number';
        to.min = '0';
        to.step = '0.01';
        to.value = fmtTime(prefs.to);
        to.title = t('export.field.range.to.hint');
        Object.assign(to.style, fieldStyle);

        const range = el('div', 'exp-range');
        Object.assign(range.style, { display: 'flex', alignItems: 'center', gap: '6px', flex: '1 1 auto' });
        range.appendChild(from);
        range.appendChild(el('span', 'exp-dash', '–'));
        range.appendChild(to);
        row(t('export.field.range'), range);

        const bg = el('select', 'exp-bg');
        Object.assign(bg.style, fieldStyle);
        [
            ['transparent', t('export.background.transparent')],
            ['solid', t('export.background.solid')],
        ].forEach(([value, label]) => {
            const o = document.createElement('option');
            o.value = value;
            o.textContent = label;
            bg.appendChild(o);
        });
        bg.value = prefs.background || 'transparent';

        const color = el('input', 'exp-bgcolor');
        color.type = 'color';
        color.value = prefs.bgColor || EXPORT_DEFAULTS.bgColor;
        Object.assign(color.style, { width: '32px', height: '22px', padding: '0', border: '1px solid #3a3f4b', background: '#14171c' });
        color.disabled = bg.value !== 'solid';

        const bgWrap = el('div', 'exp-bgwrap');
        Object.assign(bgWrap.style, { display: 'flex', alignItems: 'center', gap: '6px', flex: '1 1 auto' });
        bgWrap.appendChild(bg);
        bgWrap.appendChild(color);
        row(t('export.field.background'), bgWrap);

        // 透明背景 + WebM = 黑底：这条限制常驻在背景行下面，而不是等用户导出完才发现。
        // 背景切到 solid 时收起来（那时提示不成立，留着只会噪音）。
        const alphaNote = el('div', 'exp-alpha-note', t('export.video.alphaNote'));
        Object.assign(alphaNote.style, {
            color: '#c8a24a',
            margin: '-2px 0 6px 72px',
            font: '11px/1.4 system-ui, sans-serif',
        });
        alphaNote.hidden = bg.value === 'solid';
        box.appendChild(alphaNote);

        const fmt = el('select', 'exp-format');
        Object.assign(fmt.style, fieldStyle);
        FORMATS.forEach((f) => {
            const o = document.createElement('option');
            o.value = f;
            o.textContent = t('export.format.' + f);
            fmt.appendChild(o);
        });
        fmt.value = FORMATS.includes(prefs.format) ? prefs.format : EXPORT_DEFAULTS.format;
        row(t('export.field.format'), fmt);

        const quality = el('input', 'exp-quality');
        quality.type = 'number';
        quality.min = '0.1';
        quality.max = '1';
        quality.step = '0.01';
        quality.value = String(Number.isFinite(Number(prefs.quality)) ? Number(prefs.quality) : EXPORT_DEFAULTS.quality);
        Object.assign(quality.style, fieldStyle);
        row(t('export.field.quality'), quality);

        // 帧表：own / phaser / aseprite / both。
        // 这一项以前**界面上根本没有**——`engine` 永远停在默认的 `own`，
        // 于是「给 Godot / Phaser 用的帧表」这句功能说明一直是空头承诺。
        const eng = el('select', 'exp-engine');
        Object.assign(eng.style, fieldStyle);
        ENGINES.forEach((id) => {
            const o = document.createElement('option');
            o.value = id;
            o.textContent = t('export.engine.' + id);
            o.title = t('export.engine.' + id + '.hint');
            eng.appendChild(o);
        });
        eng.value = ENGINES.includes(prefs.engine) ? prefs.engine : EXPORT_DEFAULTS.engine;
        row(t('export.field.engine'), eng);

        // 界面上没有控件的两项（只有预设会写它们）：图集上限、是否裁边。
        // 必须跟着选项一起存，否则点了「排版」预设、重开对话框又变回 4096 + 裁边。
        const extra = {
            trim: prefs.trim !== false,
            maxTextureSize: Number(prefs.maxTextureSize) || EXPORT_DEFAULTS.maxTextureSize,
        };

        const syncQuality = () => {
            const needs = fmt.value === 'jpeg' || fmt.value === 'webp';
            quality.disabled = !needs;
            quality.title = needs ? t('export.field.quality.hint') : t('export.field.quality.na');
        };
        fmt.addEventListener('change', syncQuality);
        syncQuality();

        // 预设只填字段：改完之后用户再动任何一项都不会被改回去。
        fillPreset = (id) => {
            const merged = applyPreset({
                scale: Number(scale.value),
                format: fmt.value,
                quality: Number(quality.value),
                engine: eng.value,
                trim: extra.trim,
                maxTextureSize: extra.maxTextureSize,
            }, id);
            if (!merged) return;
            scale.value = String(merged.scale);
            fmt.value = merged.format;
            quality.value = String(merged.quality);
            eng.value = merged.engine;
            extra.trim = merged.trim !== false;
            extra.maxTextureSize = Number(merged.maxTextureSize) || EXPORT_DEFAULTS.maxTextureSize;
            syncQuality();
            resetVideoConfirm();
        };

        const open = el('input', 'exp-open');
        open.type = 'checkbox';
        open.checked = prefs.openAfter !== false;
        const openWrap = el('label', 'exp-openwrap');
        Object.assign(openWrap.style, { display: 'flex', alignItems: 'center', gap: '6px', flex: '1 1 auto' });
        openWrap.appendChild(open);
        openWrap.appendChild(el('span', null, t('export.openAfter')));
        row(t('export.field.options'), openWrap);

        const hint = el('div', 'exp-hint');
        Object.assign(hint.style, { minHeight: '16px', color: '#8f96a3', marginTop: '8px' });
        box.appendChild(hint);

        const bar = el('div', 'exp-progress');
        bar.setAttribute('role', 'progressbar');
        bar.setAttribute('aria-valuemin', '0');
        bar.setAttribute('aria-valuemax', '100');
        bar.setAttribute('aria-valuenow', '0');
        const barFill = el('i', 'exp-progress-fill');
        bar.appendChild(barFill);
        bar.hidden = true;
        box.appendChild(bar);

        const actions = el('div', 'exp-actions');
        Object.assign(actions.style, { display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '12px' });
        const btnCancel = el('button', 'exp-cancel', t('export.action.cancel'));
        btnCancel.type = 'button';
        const btnSheet = el('button', 'exp-sheet', t('export.action.sheet'));
        btnSheet.type = 'button';
        const btnVideo = el('button', 'exp-video', t('export.action.video'));
        btnVideo.type = 'button';
        const btnGif = el('button', 'exp-gif', t('export.action.gif'));
        btnGif.type = 'button';
        btnGif.title = t('export.action.gif.hint');
        const btnApng = el('button', 'exp-apng', t('export.action.apng'));
        btnApng.type = 'button';
        btnApng.title = t('export.action.apng.hint');
        const btnGo = el('button', 'exp-go', t('export.action.export'));
        btnGo.type = 'button';
        [btnCancel, btnSheet, btnGif, btnApng, btnVideo, btnGo].forEach((b) => {
            Object.assign(b.style, {
                background: '#2a2f38',
                color: '#d8dbe2',
                border: '1px solid #3f4551',
                borderRadius: '4px',
                padding: '4px 12px',
                font: '12px/1.4 system-ui, sans-serif',
                cursor: 'pointer',
            });
            actions.appendChild(b);
        });
        Object.assign(btnGo.style, { background: '#3a6df0', borderColor: '#3a6df0', color: '#fff' });
        box.appendChild(actions);

        /**
         * 把「仍然导出 WebM」的确认态收回成初始按钮文案。
         *
         * 声明成函数而不是 const：`fillPreset` 在按钮创建之前就定义了（点击时才执行），
         * 它要在结尾调用这里，闭包在调用那一刻解析，顺序不敏感。
         */
        function resetVideoConfirm() {
            if (!videoConfirm) return;
            videoConfirm = false;
            btnVideo.textContent = t('export.action.video');
            btnVideo.setAttribute('aria-label', t('export.action.video'));
            // 警告句也是这次确认的一部分：参数一改就收回，别让旧警告留在 hint 里误导下一次
            if (hint.textContent === t('export.video.alphaWarn')) hint.textContent = '';
        }

        const collect = () => ({
            scale: Number(scale.value),
            fps: Number(fps.value),
            from: Number(from.value),
            to: Number(to.value),
            background: bg.value === 'solid' ? 'solid' : 'transparent',
            bgColor: color.value,
            openAfter: !!open.checked,
            format: fmt.value,
            quality: Number(quality.value),
            engine: eng.value,
            trim: extra.trim,
            maxTextureSize: extra.maxTextureSize,
            dir: '',
        });

        const progress = (done, total) => {
            const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;
            bar.hidden = false;
            bar.setAttribute('aria-valuenow', String(pct));
            barFill.style.width = pct + '%';
            hint.textContent = t('export.progress', { done, total });
        };

        const close = (payload) => {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey, true);
            if (root.parentNode) root.parentNode.removeChild(root);
            if (typeof d.onClose === 'function') d.onClose();
            resolve(payload);
        };

        const cancel = () => {
            if (busy) {
                canceled = true;
                hint.textContent = t('export.cancel.pending');
                return;
            }
            close(null);
        };

        const run = async (which) => {
            if (busy) return;
            resetVideoConfirm();
            const opts = normalizeExportOptions(collect(), doc);
            if (which === 'frames' && !opts.count) {
                hint.textContent = t('export.emptyRange');
                return;
            }
            busy = true;
            canceled = false;
            bar.hidden = which === 'sheet';
            barFill.style.width = '0%';
            [btnGo, btnSheet, btnGif, btnApng, btnVideo].forEach((b) => {
                b.disabled = true;
            });
            btnCancel.textContent = t('export.action.cancelExport');
            hint.textContent = t('export.running');
            let res = null;
            try {
                res = await d.run(which, opts, { progress, canceled: () => canceled });
            } catch (err) {
                res = { ok: false, error: (err && err.message) || String(err) };
            }
            busy = false;
            if (settled) return;
            if (res && res.canceled) {
                hint.textContent = res.written != null
                    ? t('export.canceledWith', { written: res.written })
                    : t('export.canceled');
            } else if (res && res.ok !== false) {
                hint.textContent = res.message || t('export.done');
            } else {
                hint.textContent = (res && res.error) || t('export.failed');
            }
            [btnGo, btnSheet, btnGif, btnApng, btnVideo].forEach((b) => {
                b.disabled = false;
            });
            btnCancel.textContent = t('export.action.close');
            if (res && res.ok !== false && !res.canceled) {
                writeExportPrefs(opts, d.storage);
                close({ kind: which, opts, res });
            }
        };

        function onKey(ev) {
            if (!ev) return;
            if (ev.key === 'Escape' || ev.key === 'Esc') {
                ev.preventDefault();
                ev.stopPropagation();
                cancel();
                return;
            }
            if (ev.key === 'Enter' && !busy) {
                // 局部变量不能叫 t：那是 i18n 的查表函数，遮蔽掉会让本文件后面的文案全部取不到。
                const target = ev.target;
                const tag = target && target.tagName ? target.tagName : '';
                // 文本/数字输入框里的 Enter 也当作「导出」；下拉框留给它自己
                if (tag !== 'SELECT') {
                    ev.preventDefault();
                    ev.stopPropagation();
                    run(kind);
                }
            }
        }

        btnGo.addEventListener('click', () => {
            kind = 'frames';
            run('frames');
        });
        btnSheet.addEventListener('click', () => {
            kind = 'sheet';
            run('sheet');
        });
        btnVideo.addEventListener('click', () => {
            kind = 'video';
            const bgValue = bg.value === 'solid' ? 'solid' : 'transparent';
            // 透明背景 + WebM：第一次点击只把限制说清（按钮改成「仍然导出 WebM」），
            // 第二次点击才真的开始录制 —— 不阻塞用户，也不替用户默默导出黑底视频。
            if (needsVideoAlphaConfirm(bgValue) && !videoConfirm) {
                videoConfirm = true;
                hint.textContent = t('export.video.alphaWarn');
                btnVideo.textContent = t('export.action.videoAnyway');
                btnVideo.setAttribute('aria-label', t('export.action.videoAnyway'));
                return;
            }
            run('video');
        });
        btnGif.addEventListener('click', () => {
            kind = 'gif';
            run('gif');
        });
        btnApng.addEventListener('click', () => {
            kind = 'apng';
            run('apng');
        });
        btnCancel.addEventListener('click', cancel);
        bg.addEventListener('change', () => {
            color.disabled = bg.value !== 'solid';
            alphaNote.hidden = bg.value === 'solid';
            resetVideoConfirm();
        });
        // 任何导出设置变化都收回「仍然导出 WebM」的确认态：确认是对**当时那组参数**的确认
        [scale, fps, from, to, fmt, quality, eng, bg].forEach((node) => {
            node.addEventListener('change', resetVideoConfirm);
            node.addEventListener('input', resetVideoConfirm);
        });
        // 点遮罩空白处关闭（点浮层内部不关）
        root.addEventListener('pointerdown', (ev) => {
            if (ev.target === root) cancel();
        });
        // 捕获期：比外壳的全局快捷键先拿到 Esc/Enter
        document.addEventListener('keydown', onKey, true);

        host.appendChild(root);
        // 焦点初始落在「导出」上（真机验收点）
        setTimeout(() => {
            try {
                btnGo.focus();
            } catch (err) {
                /* 元素已移除就算了 */
            }
        }, 0);
    });
}
