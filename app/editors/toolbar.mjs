/**
 * 工具条编辑器（T2）
 *
 * 只做「显示 + 派发」：状态一律从 ctx / engine 现读，改动一律写回
 * ctx.setTool / engine.setBrush，本模块不缓存任何业务状态。
 *
 * 结构（契约 §6）：
 *   .tbar
 *     .tbar-tools   > button.tbar-tool[data-tool][data-on 用 is-on]
 *     .tbar-sep
 *     .tbar-brushes > button.tbar-brush[data-brush]
 *     .tbar-sep
 *     .tbar-field   > span.tbar-lbl + input.tbar-size + output.tbar-size-val
 *     .tbar-field   > span.tbar-lbl + input.tbar-alpha + output.tbar-alpha-val
 *     .tbar-sep
 *     .tbar-history > button.tbar-btn[data-act=undo|redo]
 */

import { BRUSH_PRESETS } from '../paint/brush.mjs';

const TOOL_DEFS = Object.freeze([
    { id: 'select', icon: '⬚', name: '选择', key: 'V' },
    { id: 'brush', icon: '✎', name: '画笔', key: 'B' },
    { id: 'eraser', icon: '◻', name: '橡皮', key: 'E' },
    { id: 'bucket', icon: '▣', name: '填充', key: 'G' },
    { id: 'picker', icon: '⌖', name: '取色', key: 'I' },
    { id: 'pan', icon: '✥', name: '平移', key: 'H' },
]);

const BRUSH_DEFS = Object.freeze([
    { id: 'round', fallback: '圆头' },
    { id: 'soft', fallback: '柔边' },
    { id: 'pencil', fallback: '铅笔' },
    { id: 'pixel', fallback: '像素' },
]);

const SIZE_MIN = 1;
const SIZE_MAX = 120;
const ALPHA_MIN = 5;
const ALPHA_MAX = 100;

function presetName(id, fallback) {
    for (const p of BRUSH_PRESETS) {
        if (p.id === id) return p.name || fallback;
    }
    return fallback;
}

function clampSize(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return SIZE_MIN;
    return Math.max(SIZE_MIN, Math.min(SIZE_MAX, n));
}

function clampAlpha(v) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return ALPHA_MAX;
    return Math.max(ALPHA_MIN, Math.min(ALPHA_MAX, n));
}

function mk(tag, cls) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
}

function sep() {
    const s = mk('div', 'tbar-sep');
    return s;
}

function field(labelText, inputCls, outCls, min, max) {
    const wrap = mk('div', 'tbar-field');
    const lbl = mk('span', 'tbar-lbl');
    lbl.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'range';
    input.className = inputCls;
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    const out = document.createElement('output');
    out.className = outCls;
    wrap.append(lbl, input, out);
    return { wrap, input, out };
}

/**
 * @param {HTMLElement} el 已带 `area-body ed ed-toolbar` 的空容器
 * @param {object} ctx 外壳上下文
 */
export function mount(el, ctx) {
    if (!el) return {};

    const engine = ctx && ctx.engine ? ctx.engine : null;

    const root = mk('div', 'tbar');

    /* ── 工具组 ── */
    const toolBox = mk('div', 'tbar-tools');
    const toolBtns = new Map();
    for (const t of TOOL_DEFS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tbar-tool';
        b.dataset.tool = t.id;
        b.title = `${t.name} (${t.key})`;
        b.setAttribute('aria-label', `${t.name} (${t.key})`);
        b.textContent = t.icon;
        toolBox.appendChild(b);
        toolBtns.set(t.id, b);
    }

    /* ── 笔刷组 ── */
    const brushBox = mk('div', 'tbar-brushes');
    const brushBtns = new Map();
    for (const d of BRUSH_DEFS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tbar-brush';
        b.dataset.brush = d.id;
        const label = presetName(d.id, d.fallback);
        b.title = label;
        b.textContent = label;
        brushBox.appendChild(b);
        brushBtns.set(d.id, b);
    }

    /* ── 滑块组 ── */
    const sizeF = field('笔尖', 'tbar-size', 'tbar-size-val', SIZE_MIN, SIZE_MAX);
    const alphaF = field('不透明', 'tbar-alpha', 'tbar-alpha-val', ALPHA_MIN, ALPHA_MAX);

    /* ── 撤销 / 重做 ── */
    const histBox = mk('div', 'tbar-history');
    const undoBtn = document.createElement('button');
    undoBtn.type = 'button';
    undoBtn.className = 'tbar-btn';
    undoBtn.dataset.act = 'undo';
    undoBtn.title = '撤销 (Ctrl+Z)';
    undoBtn.textContent = '↶';
    const redoBtn = document.createElement('button');
    redoBtn.type = 'button';
    redoBtn.className = 'tbar-btn';
    redoBtn.dataset.act = 'redo';
    redoBtn.title = '重做 (Ctrl+Shift+Z)';
    redoBtn.textContent = '↷';
    histBox.append(undoBtn, redoBtn);

    root.append(toolBox, sep(), brushBox, sep(), sizeF.wrap, alphaF.wrap, sep(), histBox);
    el.appendChild(root);

    /* ── 读写封装 ────────────────────────────────────────── */

    /** 工具状态：优先外壳，外壳没给才回落引擎 */
    function toolNow() {
        const t = ctx && typeof ctx.tool === 'function' ? ctx.tool() : null;
        if (t) return t;
        if (engine && typeof engine.tool === 'function') return engine.tool();
        return 'brush';
    }

    function setTool(id) {
        const hasCtx = !!(ctx && typeof ctx.setTool === 'function');
        if (hasCtx) ctx.setTool(id);
        // 外壳记了账却没转发给引擎时补一次，保证画布真的换工具
        const echoed = hasCtx && typeof ctx.tool === 'function' ? ctx.tool() : null;
        if (engine && typeof engine.setTool === 'function' && engine.tool() !== id) {
            if (!hasCtx || echoed === id) engine.setTool(id);
        }
    }

    /** 笔刷状态：一律读引擎（唯一持有笔尖参数的地方） */
    function brushNow() {
        if (engine && typeof engine.brush === 'function') {
            const b = engine.brush();
            if (b) return b;
        }
        return { id: 'round', size: 8, opacity: 1, color: '#000000' };
    }

    function setBrush(patch) {
        if (engine && typeof engine.setBrush === 'function') engine.setBrush(patch);
    }

    /* ── 同步 ────────────────────────────────────────────── */

    function syncHistory() {
        const h = engine && engine.history ? engine.history : null;
        undoBtn.disabled = !(h && typeof h.canUndo === 'function' && h.canUndo());
        redoBtn.disabled = !(h && typeof h.canRedo === 'function' && h.canRedo());
    }

    function sync() {
        const t = toolNow();
        for (const [id, btn] of toolBtns) btn.classList.toggle('is-on', id === t);

        const b = brushNow();
        for (const [id, btn] of brushBtns) btn.classList.toggle('is-on', id === b.id);

        const size = clampSize(b.size);
        sizeF.input.value = String(size);
        sizeF.out.textContent = String(size);

        const alpha = clampAlpha((b.opacity == null ? 1 : b.opacity) * 100);
        alphaF.input.value = String(alpha);
        alphaF.out.textContent = alpha + '%';

        syncHistory();
    }

    /* ── 事件 ───────────────────────────────────────────── */

    function onToolClick(ev) {
        const id = ev.currentTarget.dataset.tool;
        if (!id) return;
        setTool(id);
        sync();
    }
    for (const btn of toolBtns.values()) btn.addEventListener('click', onToolClick);

    function onBrushClick(ev) {
        const id = ev.currentTarget.dataset.brush;
        if (!id) return;
        setBrush({ id });
        sync();
    }
    for (const btn of brushBtns.values()) btn.addEventListener('click', onBrushClick);

    function onSizeInput() {
        const v = clampSize(sizeF.input.value);
        sizeF.out.textContent = String(v);
        setBrush({ size: v });
    }
    function onAlphaInput() {
        const v = clampAlpha(alphaF.input.value);
        alphaF.out.textContent = v + '%';
        setBrush({ opacity: v / 100 });
    }
    sizeF.input.addEventListener('input', onSizeInput);
    alphaF.input.addEventListener('input', onAlphaInput);

    function onUndo() {
        if (ctx && typeof ctx.undo === 'function') ctx.undo();
        else if (engine && typeof engine.undo === 'function') engine.undo();
        sync();
    }
    function onRedo() {
        if (ctx && typeof ctx.redo === 'function') ctx.redo();
        else if (engine && typeof engine.redo === 'function') engine.redo();
        sync();
    }
    undoBtn.addEventListener('click', onUndo);
    redoBtn.addEventListener('click', onRedo);

    /* ── 订阅：工具 / 笔刷 / 撤销栈变了就整体同步一次 ────── */
    const unsubs = [];
    if (engine && typeof engine.subscribe === 'function') {
        unsubs.push(engine.subscribe(() => sync()));
    }
    if (engine && engine.history && typeof engine.history.subscribe === 'function') {
        unsubs.push(engine.history.subscribe(() => syncHistory()));
    }

    sync();

    const refresh = () => sync();

    const destroy = () => {
        for (const btn of toolBtns.values()) btn.removeEventListener('click', onToolClick);
        for (const btn of brushBtns.values()) btn.removeEventListener('click', onBrushClick);
        sizeF.input.removeEventListener('input', onSizeInput);
        alphaF.input.removeEventListener('input', onAlphaInput);
        undoBtn.removeEventListener('click', onUndo);
        redoBtn.removeEventListener('click', onRedo);
        for (const off of unsubs) {
            try {
                off();
            } catch (err) {
                /* 取消订阅失败不影响卸载 */
            }
        }
        unsubs.length = 0;
    };

    return { destroy, refresh, focusFrame: refresh };
}
