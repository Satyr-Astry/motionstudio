/**
 * 调色板编辑器（T2）
 *
 * 一个真正可用的 HSV 取色器。信息层级只留一条主线：
 *   顶部 = 主入口（当前色块 + 十六进制，回车即生效），中间 = 取色区，底部 = 最近用色。
 * 颜色读写只走 ctx.color() / ctx.setColor(hex)，本模块不持有业务状态；
 * 唯一保留的内部状态是「上次色相」——纯灰（s≈0）时 rgbToHsv 会给出 h=0，
 * 直接用会让色环跳回红色，所以灰阶一律沿用上一次色相。
 *
 * 结构（契约 §6）：
 *   .pal
 *     .pal-top    > span.pal-chip + input.pal-hex[type=text]   ← 唯一的主入口，hex 只有这一处
 *     .pal-sv     > canvas.pal-sv-canvas + span.pal-cursor     ← 拖动改 S（横）/ V（纵）
 *     input.pal-val[type=range]                                ← 明度 0–100，渐变随色相
 *     input.pal-hue[type=range]                                ← 色相 0–359
 *     .pal-recent > span.pal-label + span.pal-recents > button.pal-dot  ← 最近 6 色
 *
 * 预设色块（原 .pal-grid 的 16 色）已删除：它和「最近用色」是同一件事的两种列表，
 * 常见色由画板内的当前色块入口负责（见计划 §4），这里只做进阶取色。
 */

/* ── 颜色换算（纯函数，导出给测试参考） ─────────────────── */

function clamp01(n) {
    if (!Number.isFinite(n)) return 0;
    return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * '#rrggbb' / '#rgb' / 'rrggbb' → { r, g, b }（0..255）；非法返回 null
 */
export function hexToRgb(hex) {
    const n = normalizeHex(hex);
    if (!n) return null;
    return {
        r: parseInt(n.slice(1, 3), 16),
        g: parseInt(n.slice(3, 5), 16),
        b: parseInt(n.slice(5, 7), 16),
    };
}

/** 0..255 的分量 → '#rrggbb' */
export function rgbToHex(r, g, b) {
    const h = (n) => {
        const v = Math.max(0, Math.min(255, Math.round(Number(n) || 0)));
        return v.toString(16).padStart(2, '0');
    };
    return '#' + h(r) + h(g) + h(b);
}

/** h 0..360（超界回绕），s/v 0..1 → { r, g, b } */
export function hsvToRgb(h, s, v) {
    const hh = ((Number(h) || 0) % 360 + 360) % 360;
    const ss = clamp01(s);
    const vv = clamp01(v);
    const c = vv * ss;
    const hp = hh / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r = 0;
    let g = 0;
    let b = 0;
    if (hp < 1) {
        r = c;
        g = x;
    } else if (hp < 2) {
        r = x;
        g = c;
    } else if (hp < 3) {
        g = c;
        b = x;
    } else if (hp < 4) {
        g = x;
        b = c;
    } else if (hp < 5) {
        r = x;
        b = c;
    } else {
        r = c;
        b = x;
    }
    const m = vv - c;
    return {
        r: Math.round((r + m) * 255),
        g: Math.round((g + m) * 255),
        b: Math.round((b + m) * 255),
    };
}

/** 0..255 分量 → { h:0..360, s:0..1, v:0..1 }；无彩时 h 固定给 0，由调用方保留旧色相 */
export function rgbToHsv(r, g, b) {
    const rr = Math.max(0, Math.min(255, Number(r) || 0)) / 255;
    const gg = Math.max(0, Math.min(255, Number(g) || 0)) / 255;
    const bb = Math.max(0, Math.min(255, Number(b) || 0)) / 255;
    const max = Math.max(rr, gg, bb);
    const min = Math.min(rr, gg, bb);
    const d = max - min;
    let h = 0;
    if (d > 1e-6) {
        if (max === rr) h = 60 * (((gg - bb) / d) % 6);
        else if (max === gg) h = 60 * ((bb - rr) / d + 2);
        else h = 60 * ((rr - gg) / d + 4);
    }
    if (h < 0) h += 360;
    return { h, s: max <= 1e-6 ? 0 : d / max, v: max };
}

/** 任意输入 → 规范化的 '#rrggbb'（小写）；非法返回 null */
function normalizeHex(raw) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(raw == null ? '' : raw).trim());
    if (!m) return null;
    let s = m[1].toLowerCase();
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    return '#' + s;
}

function hsvHex(h, s, v) {
    const { r, g, b } = hsvToRgb(h, s, v);
    return rgbToHex(r, g, b);
}

/* ── 常量 ─────────────────────────────────────────────── */

const SV_W = 200;
const SV_H = 120;
/** 最近用色上限：6 个足够覆盖一次配色，再多就和「最近」这个语义无关了 */
const RECENT_MAX = 6;

/** 最近用色：模块级共享，面板重挂后仍保留（进程内） */
const recentColors = [];

function rememberColor(hex) {
    const n = normalizeHex(hex);
    if (!n) return false;
    const at = recentColors.indexOf(n);
    if (at === 0) return false;
    if (at > 0) recentColors.splice(at, 1);
    recentColors.unshift(n);
    while (recentColors.length > RECENT_MAX) recentColors.pop();
    return true;
}

/* ── 小工具 ───────────────────────────────────────────── */

function mk(tag, cls) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    return n;
}

/* ── 挂载 ─────────────────────────────────────────────── */

/**
 * @param {HTMLElement} el 已带 `area-body ed ed-palette` 的空容器
 * @param {object} ctx 外壳上下文
 */
export function mount(el, ctx) {
    if (!el) return {};

    const engine = ctx && ctx.engine ? ctx.engine : null;

    /* 顶部：当前色块 + 十六进制 */
    const top = mk('div', 'pal-top');
    const chip = mk('span', 'pal-chip');
    chip.title = '当前颜色';
    const hexInput = document.createElement('input');
    hexInput.type = 'text';
    hexInput.className = 'pal-hex';
    hexInput.spellcheck = false;
    hexInput.maxLength = 7;
    hexInput.placeholder = '#rrggbb';
    hexInput.setAttribute('aria-label', '十六进制颜色');
    top.append(chip, hexInput);

    /* 饱和度 / 明度二维面板：竖向弹性，空间不足时压缩到 64px 而不是溢出 */
    const sv = mk('div', 'pal-sv');
    sv.style.flex = '1 1 auto';
    sv.style.minHeight = '64px';
    sv.style.height = 'auto';
    const svCanvas = document.createElement('canvas');
    svCanvas.className = 'pal-sv-canvas';
    svCanvas.width = SV_W;
    svCanvas.height = SV_H;
    // CSS 尺寸交给布局（100%），像素尺寸由 syncCanvasSize 按 clientWidth/Height 重设
    svCanvas.style.width = '100%';
    svCanvas.style.height = '100%';
    svCanvas.style.display = 'block';
    const cursor = mk('span', 'pal-cursor');
    sv.append(svCanvas, cursor);

    /* 明度：竖向弹性之后的第一条滑条。复用 .pal-hue 的盒子（CSS 里没有 .pal-val 规则），
       轨道背景由 paintValues 按当前色相写成「黑 → 纯色」渐变，滑块仍是 CSS 那个白块黑边。 */
    const val = document.createElement('input');
    val.type = 'range';
    val.className = 'pal-hue pal-val';
    val.min = '0';
    val.max = '100';
    val.step = '1';
    val.value = '0';
    val.title = '明度 0–100';
    val.setAttribute('aria-label', '明度');
    // 尺寸全交给 CSS 的 input.pal-hue（18px 换成 20px 时不该有第二处要改）；
    // 只有 UA 的 2px 外边距必须在这里清掉——否则 width:100% 会顶出内容盒，被面板裁掉右侧。
    val.style.margin = '0';

    /* 色相：固定 18px 一条，不参与伸缩 */
    const hue = document.createElement('input');
    hue.type = 'range';
    hue.className = 'pal-hue';
    hue.min = '0';
    hue.max = '359';
    hue.step = '1';
    hue.value = '0';
    hue.title = '色相 0–359';
    hue.setAttribute('aria-label', '色相');
    hue.style.margin = '0'; // 同上：清掉 UA 外边距，100% 才不会被顶出内容盒

    /* 最近用色 */
    const recentRow = mk('div', 'pal-recent');
    recentRow.style.flex = '0 0 auto';
    const recentLabel = mk('span', 'pal-label');
    recentLabel.textContent = '最近';
    const recents = mk('span', 'pal-recents');
    recents.style.flexWrap = 'wrap';
    recentRow.append(recentLabel, recents);

    const root = mk('div', 'pal');
    root.style.display = 'flex';
    root.style.flexDirection = 'column';
    root.style.height = '100%';
    root.style.boxSizing = 'border-box';
    root.style.minHeight = '0';
    root.style.overflowY = 'auto';
    root.append(top, sv, val, hue, recentRow);
    el.appendChild(root);

    /* ── 内部状态 ────────────────────────────────────── */
    const st = { h: 0, s: 0, v: 0, hex: '#000000' };

    /* ── 渲染 ────────────────────────────────────────── */

    function paintWheel() {
        const g = svCanvas.getContext('2d');
        if (!g) return;
        const w = svCanvas.width;
        const h = svCanvas.height;
        if (w < 1 || h < 1) return;
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
        g.fillStyle = hsvHex(st.h, 1, 1);
        g.fillRect(0, 0, w, h);
        // 白：左实右虚，表示饱和度
        const gw = g.createLinearGradient(0, 0, w, 0);
        gw.addColorStop(0, '#ffffff');
        gw.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gw;
        g.fillRect(0, 0, w, h);
        // 黑：上虚下实，表示明度
        const gb = g.createLinearGradient(0, 0, 0, h);
        gb.addColorStop(0, 'rgba(0,0,0,0)');
        gb.addColorStop(1, '#000000');
        g.fillStyle = gb;
        g.fillRect(0, 0, w, h);
    }

    function paintCursor() {
        cursor.style.left = (clamp01(st.s) * 100).toFixed(2) + '%';
        cursor.style.top = ((1 - clamp01(st.v)) * 100).toFixed(2) + '%';
    }

    function paintValues() {
        chip.style.background = st.hex;
        if (document.activeElement !== hexInput) hexInput.value = st.hex;
        const vv = String(Math.round(clamp01(st.v) * 100));
        if (val.value !== vv) val.value = vv;
        // 明度条：左黑 → 右「当前色相的最高明度」
        val.style.background = 'linear-gradient(to right, #000000, ' + hsvHex(st.h, st.s, 1) + ')';
        const hv = String(Math.round(st.h));
        if (hue.value !== hv) hue.value = hv;
    }

    function paintRecents() {
        recents.textContent = '';
        for (const c of recentColors) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'pal-dot';
            b.dataset.color = c;
            b.title = c;
            b.setAttribute('aria-label', c);
            b.style.background = c;
            recents.appendChild(b);
        }
    }

    /* ── 尺寸自适应 ──────────────────────────────────── */

    /** 高度低于该值就切「紧凑模式」：只留 hex 行 + SV + 色相条 */
    const TIGHT_H = 220;

    let pixelW = 0;
    let pixelH = 0;
    let tightState = null;
    let rafId = 0;

    /** 按 CSS 盒子重设画布像素尺寸，返回是否真的变了（不变就不重绘，避免回声循环） */
    function syncCanvasSize() {
        const dpr = Math.min(2, (window.devicePixelRatio || 1));
        const cw = Math.max(1, Math.round(svCanvas.clientWidth || 0));
        const ch = Math.max(1, Math.round(svCanvas.clientHeight || 0));
        const w = Math.max(1, Math.round(cw * dpr));
        const h = Math.max(1, Math.round(ch * dpr));
        if (w === pixelW && h === pixelH) return false;
        pixelW = w;
        pixelH = h;
        svCanvas.width = w;
        svCanvas.height = h;
        return true;
    }

    function applyFit() {
        const h = el.clientHeight || 0;
        const next = h > 0 && h < TIGHT_H;
        if (next !== tightState) {
            tightState = next;
            root.classList.toggle('is-tight', next);
            // 面板 CSS 还没接管 .is-tight 时也要生效，所以同时写 display
            recentRow.style.display = next ? 'none' : 'flex';
        }
        if (syncCanvasSize()) paintWheel();
    }

    function scheduleFit() {
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
            rafId = 0;
            applyFit();
            paintCursor();
        });
    }

    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleFit) : null;
    if (ro) ro.observe(el);

    function renderAll() {
        paintWheel();
        paintCursor();
        paintValues();
    }

    /* ── 颜色写入 ────────────────────────────────────── */

    function writeColor(hex) {
        const hasCtx = !!(ctx && typeof ctx.setColor === 'function');
        if (hasCtx) ctx.setColor(hex);
        // 外壳记账但没转发给引擎时补一次，保证落笔颜色就是面板上的颜色
        if (engine && typeof engine.setColor === 'function' && engine.color() !== hex) {
            const echoed = hasCtx && typeof ctx.color === 'function' ? normalizeHex(ctx.color()) : null;
            if (!hasCtx || echoed === hex) engine.setColor(hex);
        }
    }

    /**
     * 吸收一个颜色（不改写外壳状态时 syncCtx=false）。
     * 灰阶（s≈0）保留上一次色相。
     */
    function absorb(raw, syncCtx) {
        const n = normalizeHex(raw);
        if (!n) return false;
        const rgb = hexToRgb(n);
        if (!rgb) return false;
        const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
        st.hex = n;
        st.s = hsv.s;
        st.v = hsv.v;
        if (hsv.s > 0.004) st.h = hsv.h;
        if (syncCtx) writeColor(n);
        renderAll();
        return true;
    }

    /**
     * 记入最近色并**无条件重绘**。
     * 不能只依赖 rememberColor 的返回值决定是否重绘：最近色列表是模块级共享的，
     * 同一工作区里另一个调色板面板（隐藏工作区）可能已经通过引擎 'color' 事件
     * 先一步把该色记进列表，此时本面板的 rememberColor 返回 false，若不重绘就
     * 永远看不到最近色。重绘最多 12 个节点，代价可忽略。
     */
    function noteColor(hex) {
        rememberColor(hex);
        paintRecents();
    }

    /** 用户明确选色：吸收 + 写入 + 记入最近 */
    function commit(raw) {
        if (!absorb(raw, true)) return;
        noteColor(st.hex);
    }

    function readColor() {
        const a = ctx && typeof ctx.color === 'function' ? normalizeHex(ctx.color()) : null;
        if (a) return a;
        if (engine && typeof engine.color === 'function') return normalizeHex(engine.color());
        return null;
    }

    /* ── 事件：SV 面板拖动 ───────────────────────────── */

    let dragging = false;

    function svPoint(ev) {
        const r = svCanvas.getBoundingClientRect();
        const w = Math.max(1, r.width);
        const h = Math.max(1, r.height);
        return {
            s: clamp01((ev.clientX - r.left) / w),
            v: 1 - clamp01((ev.clientY - r.top) / h),
        };
    }

    function applySv(ev) {
        const p = svPoint(ev);
        st.s = p.s;
        st.v = p.v;
        st.hex = hsvHex(st.h, p.s, p.v);
        writeColor(st.hex);
        paintCursor();
        paintValues();
    }

    function onSvDown(ev) {
        if (ev.button !== 0) return;
        dragging = true;
        try {
            svCanvas.setPointerCapture(ev.pointerId);
        } catch (err) {
            /* 某些合成事件没有指针捕获，忽略 */
        }
        applySv(ev);
        ev.preventDefault();
    }

    function onSvMove(ev) {
        if (!dragging) return;
        applySv(ev);
    }

    function onSvUp(ev) {
        if (!dragging) return;
        dragging = false;
        try {
            svCanvas.releasePointerCapture(ev.pointerId);
        } catch (err) {
            /* 指针已经释放 */
        }
        noteColor(st.hex);
    }

    svCanvas.addEventListener('pointerdown', onSvDown);
    svCanvas.addEventListener('pointermove', onSvMove);
    svCanvas.addEventListener('pointerup', onSvUp);
    svCanvas.addEventListener('pointercancel', onSvUp);

    /* ── 事件：色相滑条 ──────────────────────────────── */

    function onHueInput() {
        st.h = ((Number(hue.value) || 0) % 360 + 360) % 360;
        st.hex = hsvHex(st.h, st.s, st.v);
        writeColor(st.hex);
        paintWheel();
        paintValues();
    }

    function onHueChange() {
        noteColor(st.hex);
    }

    hue.addEventListener('input', onHueInput);
    hue.addEventListener('change', onHueChange);

    /* ── 事件：明度滑条 ──────────────────────────────── */

    function onValInput() {
        st.v = clamp01((Number(val.value) || 0) / 100);
        st.hex = hsvHex(st.h, st.s, st.v);
        writeColor(st.hex);
        paintCursor();
        paintValues();
    }

    function onValChange() {
        noteColor(st.hex);
    }

    val.addEventListener('input', onValInput);
    val.addEventListener('change', onValChange);

    /* ── 事件：十六进制输入（回车生效，唯一入口） ─────── */

    /** 把输入框内容提交给引擎；非法值回滚到当前色 */
    function commitHex() {
        const n = normalizeHex(hexInput.value);
        if (!n) {
            hexInput.value = st.hex;
            return;
        }
        commit(n);
    }

    function onHexChange() {
        // 回车已经提交过一次，随后的 change 事件不再重复写（同值写入无意义）
        if (normalizeHex(hexInput.value) === st.hex) {
            hexInput.value = st.hex;
            return;
        }
        commitHex();
    }

    function onHexKey(ev) {
        if (ev.key === 'Enter') {
            commitHex(); // 不依赖 blur/change：合成事件里回车不一定带出 change
            hexInput.blur();
        } else if (ev.key === 'Escape') {
            hexInput.value = st.hex;
            hexInput.blur();
        }
    }

    hexInput.addEventListener('change', onHexChange);
    hexInput.addEventListener('keydown', onHexKey);

    /* ── 事件：最近色 ────────────────────────────────── */
    function onRecentsClick(ev) {
        const target = ev.target;
        if (!target || target.tagName !== 'BUTTON') return;
        const c = target.dataset ? target.dataset.color : null;
        if (c) commit(c);
    }
    recents.addEventListener('click', onRecentsClick);

    /* ── 外部颜色变化：引擎事件 + 取色工具兜底 ───────── */

    function syncFromEngine() {
        const c = engine && typeof engine.color === 'function' ? normalizeHex(engine.color()) : null;
        if (!c || c === st.hex) return;
        // 引擎是像素层真值，这里只吸收显示，不回写，避免来回抖动
        absorb(c, false);
        noteColor(c);
    }

    const unsubs = [];
    if (engine && typeof engine.subscribe === 'function') {
        unsubs.push(
            engine.subscribe((reason) => {
                if (reason === 'color') syncFromEngine();
            })
        );
    }

    // 取色工具是在引擎内部直接改 state.color，不发 subscribe 事件，
    // 所以再用一次全局 pointerup 兜底同步（成本可忽略）。
    function onWindowPointerUp() {
        if (dragging) return;
        syncFromEngine();
    }
    window.addEventListener('pointerup', onWindowPointerUp, true);

    /* ── 初始化 ──────────────────────────────────────── */

    const initial = readColor() || (engine && typeof engine.color === 'function' ? engine.color() : null) || '#000000';
    absorb(initial, false);
    paintRecents();
    // 首次挂载时外壳布局已就绪，直接量一次；隐藏态下会由 ResizeObserver 补
    applyFit();
    scheduleFit();

    const refresh = () => {
        const c = readColor();
        if (c && c !== st.hex) absorb(c, false);
        else renderAll();
        applyFit();
    };

    const destroy = () => {
        svCanvas.removeEventListener('pointerdown', onSvDown);
        svCanvas.removeEventListener('pointermove', onSvMove);
        svCanvas.removeEventListener('pointerup', onSvUp);
        svCanvas.removeEventListener('pointercancel', onSvUp);
        hue.removeEventListener('input', onHueInput);
        hue.removeEventListener('change', onHueChange);
        val.removeEventListener('input', onValInput);
        val.removeEventListener('change', onValChange);
        hexInput.removeEventListener('change', onHexChange);
        hexInput.removeEventListener('keydown', onHexKey);
        recents.removeEventListener('click', onRecentsClick);
        window.removeEventListener('pointerup', onWindowPointerUp, true);
        for (const off of unsubs) {
            try {
                off();
            } catch (err) {
                /* 取消订阅失败不影响卸载 */
            }
        }
        unsubs.length = 0;
        dragging = false;
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = 0;
        }
        if (ro) ro.disconnect();
    };

    return { destroy, refresh, focusFrame: refresh };
}
