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

import { EXPORT_DEFAULTS, normalizeExportOptions } from '../core/export-options.mjs';

const LS_KEY = 'ms.export';

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
        ['scale', 'fps', 'from', 'to'].forEach((k) => {
            const n = Number(obj[k]);
            if (Number.isFinite(n)) out[k] = n;
        });
        if (obj.background === 'solid' || obj.background === 'transparent') out.background = obj.background;
        if (typeof obj.bgColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(obj.bgColor)) out.bgColor = obj.bgColor;
        if (typeof obj.openAfter === 'boolean') out.openAfter = obj.openAfter;
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

        const root = el('div', 'exp-modal');
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-label', '导出');
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

        const title = el('div', 'exp-title', '导出');
        Object.assign(title.style, { fontWeight: '600', marginBottom: '10px' });
        box.appendChild(title);

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
        row('缩放', scale);

        const fps = el('input', 'exp-fps');
        fps.type = 'number';
        fps.min = '0';
        fps.max = '120';
        fps.step = '1';
        fps.value = String(prefs.fps || 0);
        fps.title = '0 = 跟随文档帧率';
        Object.assign(fps.style, fieldStyle);
        row('帧率', fps);

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
        to.title = '0 = 到片尾';
        Object.assign(to.style, fieldStyle);

        const range = el('div', 'exp-range');
        Object.assign(range.style, { display: 'flex', alignItems: 'center', gap: '6px', flex: '1 1 auto' });
        range.appendChild(from);
        range.appendChild(el('span', 'exp-dash', '–'));
        range.appendChild(to);
        row('时间', range);

        const bg = el('select', 'exp-bg');
        Object.assign(bg.style, fieldStyle);
        [
            ['transparent', '透明'],
            ['solid', '纯色'],
        ].forEach(([v, t]) => {
            const o = document.createElement('option');
            o.value = v;
            o.textContent = t;
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
        row('背景', bgWrap);

        const open = el('input', 'exp-open');
        open.type = 'checkbox';
        open.checked = prefs.openAfter !== false;
        const openWrap = el('label', 'exp-openwrap');
        Object.assign(openWrap.style, { display: 'flex', alignItems: 'center', gap: '6px', flex: '1 1 auto' });
        openWrap.appendChild(open);
        openWrap.appendChild(el('span', null, '完成后打开所在文件夹'));
        row('选项', openWrap);

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
        const btnCancel = el('button', 'exp-cancel', '取消');
        btnCancel.type = 'button';
        const btnSheet = el('button', 'exp-sheet', '导出精灵图');
        btnSheet.type = 'button';
        const btnVideo = el('button', 'exp-video', '导出 WebM');
        btnVideo.type = 'button';
        const btnGo = el('button', 'exp-go', '导出');
        btnGo.type = 'button';
        [btnCancel, btnSheet, btnVideo, btnGo].forEach((b) => {
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

        const collect = () => ({
            scale: Number(scale.value),
            fps: Number(fps.value),
            from: Number(from.value),
            to: Number(to.value),
            background: bg.value === 'solid' ? 'solid' : 'transparent',
            bgColor: color.value,
            openAfter: !!open.checked,
            dir: '',
        });

        const progress = (done, total) => {
            const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((done / total) * 100))) : 0;
            bar.hidden = false;
            bar.setAttribute('aria-valuenow', String(pct));
            barFill.style.width = pct + '%';
            hint.textContent = '已处理 ' + done + ' / ' + total;
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
                hint.textContent = '正在取消…';
                return;
            }
            close(null);
        };

        const run = async (which) => {
            if (busy) return;
            const opts = normalizeExportOptions(collect(), doc);
            if (which === 'frames' && !opts.count) {
                hint.textContent = '时间范围为空，没有可导出的帧';
                return;
            }
            busy = true;
            canceled = false;
            bar.hidden = which === 'sheet';
            barFill.style.width = '0%';
            [btnGo, btnSheet, btnVideo].forEach((b) => {
                b.disabled = true;
            });
            btnCancel.textContent = '取消导出';
            hint.textContent = '正在导出…';
            let res = null;
            try {
                res = await d.run(which, opts, { progress, canceled: () => canceled });
            } catch (err) {
                res = { ok: false, error: (err && err.message) || String(err) };
            }
            busy = false;
            if (settled) return;
            if (res && res.canceled) {
                hint.textContent = res.written != null ? '已取消（已写出 ' + res.written + ' 帧）' : '已取消';
            } else if (res && res.ok !== false) {
                hint.textContent = res.message || '导出完成';
            } else {
                hint.textContent = (res && res.error) || '导出失败';
            }
            [btnGo, btnSheet, btnVideo].forEach((b) => {
                b.disabled = false;
            });
            btnCancel.textContent = '关闭';
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
                const t = ev.target;
                const tag = t && t.tagName ? t.tagName : '';
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
            run('video');
        });
        btnCancel.addEventListener('click', cancel);
        bg.addEventListener('change', () => {
            color.disabled = bg.value !== 'solid';
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
