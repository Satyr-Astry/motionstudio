/**
 * 拖动浮层：时间轴的关键帧拖动与曲线区的点拖动共用这一处实现。
 *
 * 为什么单独抽出来：同一个「拖一个东西」的手势，曲线区早就有 `.curve-tip`（t / 缓动 / h1 h2），
 * 时间轴只有 hover 才看得到的 `title`。两套待遇的结果是用户在时间轴上拖动时完全没有读数。
 *
 * 三条实现纪律（都有验收盯着）：
 * 1. **惰性挂、拖完摘**：首次 show() 才建节点进 document.body，hide() 立刻 remove()。
 *    常驻节点会在 dispose 时漏摘，验收会查 document.body 里有没有残留 `div.drag-tip`。
 * 2. **只改文本与 transform**：位置用 `transform: translate()`，不用 left/top（后者每帧触发布局）；
 *    文本先比字符串，没变就不写 DOM。
 * 3. **夹在视口内**：拖到时间轴最右/最下时读数会被裁掉半截，所以按节点实测尺寸夹一次
 *    （尺寸在文本变化时才重测，见 measure()）。
 *
 * 纯函数（formatTip / snapText / frameOf / findConflict）不碰 DOM，Node 里可直接测。
 */

const PAD = 4;

/** 吸附三态 → 文案。'frame' 吸整帧、'grid' 吸 0.1 s 网格、其余一律「自由」。 */
export function snapText(snapped) {
    if (snapped === 'frame') return '吸附:帧';
    if (snapped === 'grid') return '吸附:网格';
    return '自由';
}

/** 秒 → 帧号（0 起算）。fps 非法时返回 null，别把 NaN 印到脸上。 */
export function frameOf(t, fps) {
    const f = Number(fps);
    const time = Number(t);
    if (!Number.isFinite(f) || f <= 0 || !Number.isFinite(time)) return null;
    const n = Math.round(time * f);
    return Number.isFinite(n) ? n : null;
}

/**
 * 读数格式：`t = 1.417 s · 第 17 帧 · 线性 · 吸附:帧`，冲突时额外给 suffix。
 * 帧号 0 起算（t=0 → 第 0 帧），与 t = 1.417 s / 12 fps → 第 17 帧 的口径一致。
 */
export function formatTip(opts) {
    const o = opts || {};
    const t = Number(o.t);
    const parts = [];
    if (Number.isFinite(t) && t >= 0) {
        parts.push('t = ' + t.toFixed(3) + ' s');
        const fr = frameOf(t, o.fps);
        if (fr != null) parts.push('第 ' + fr + ' 帧');
        const total = Number(o.duration);
        if (Number.isFinite(total) && t > total + 1e-9) parts.push('超出时长');
    } else {
        parts.push('t = —');
    }
    if (o.easeText) parts.push(String(o.easeText));
    if (o.snapped !== undefined) parts.push(snapText(o.snapped));

    let suffix = '';
    if (o.conflict === 'merge') suffix = '会合并到同一时刻';
    else if (o.conflict === 'blocked') suffix = '该时刻已有关键帧';
    return { text: parts.join(' · '), suffix };
}

/**
 * 冲突判定：跟着 `moveKeys` 的真实语义走（`app/editors/timeline-keys.mjs:479` 那段）——
 * 它对每一颗 `from` 算出 `target = from + step`，**目标时刻已被别的组占着就整组跳过**（不覆盖别人的键），
 * 只有撞上「刚搬过去的那批」才会合并。
 *
 * 所以这里判的是主键那颗的目标时刻：
 * - 目标刻上有**不在拖动集合里**的键 → `blocked`（对应 moveKeys 的 skip，涉及丢数据，先说）
 * - 目标刻上有**拖动集合里另一颗的旧位** → `merge`（对应 moveKey 内部撞时间合并）
 *
 * 返回 { kind: 'none'|'blocked'|'merge', hits: [{ layerId, t }] }。
 */
export function findConflict(opts) {
    const o = opts || {};
    const eps = Number.isFinite(Number(o.eps)) ? Number(o.eps) : 1e-6;
    const layerId = o.layerId;
    const fromT = Number(o.fromT);
    const dt = Number(o.dt);
    const keys = Array.isArray(o.keys) ? o.keys : [];
    const sel = Array.isArray(o.sel) ? o.sel : [];
    const target = fromT + dt;
    if (!Number.isFinite(target)) return { kind: 'none', hits: [] };

    const same = (a, b) => Math.abs(Number(a) - Number(b)) <= eps;
    const selTimes = sel.filter((k) => k.layerId === layerId).map((k) => Number(k.t));

    const outside = keys.filter(
        (k) => k.layerId === layerId && !selTimes.some((t) => same(t, k.t)) && same(k.t, target)
    );
    if (outside.length) return { kind: 'blocked', hits: outside };

    const inner = sel.filter(
        (k) => k.layerId === layerId && !same(k.t, fromT) && same(k.t, target)
    );
    if (inner.length) return { kind: 'merge', hits: inner };

    return { kind: 'none', hits: [] };
}

/* ── 以下是 DOM 部分：只有 show/hide 会碰到 document，模块顶层不碰 ── */

let node = null;        // 当前挂着的浮层节点（惰性创建）
let textEl = null;
let suffixEl = null;
let queued = null;      // 一帧之内只应用最后一次
let rafId = 0;
let rafBusy = false;
let size = { w: 0, h: 0 };      // 缓存尺寸，只在文本变化时重测
let lastText = '\u0000';
let lastSuffix = '\u0000';

function canDom() {
    return typeof document !== 'undefined' && !!document.body;
}

function ensureNode() {
    if (node) return node;
    if (!canDom()) return null;
    node = document.createElement('div');
    node.className = 'drag-tip';
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    textEl = document.createElement('span');
    textEl.className = 'drag-tip-text';
    suffixEl = document.createElement('span');
    suffixEl.className = 'drag-tip-suffix';
    node.append(textEl, suffixEl);
    document.body.appendChild(node);
    lastText = '\u0000';
    lastSuffix = '\u0000';
    size = { w: 0, h: 0 };
    return node;
}

/** 文本变了才测尺寸：getBoundingClientRect 会强制一次布局，别每帧都调。 */
function measure() {
    if (!node) return;
    const r = typeof node.getBoundingClientRect === 'function' ? node.getBoundingClientRect() : null;
    if (r && r.width > 0) size = { w: r.width, h: r.height };
}

function clampPos(x, y) {
    const vw = typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 0;
    const vh = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 0;
    const maxX = vw > 0 ? vw - size.w - PAD : Number.POSITIVE_INFINITY;
    const maxY = vh > 0 ? vh - size.h - PAD : Number.POSITIVE_INFINITY;
    return {
        x: Math.max(PAD, Math.min(Number(x) || 0, maxX)),
        y: Math.max(PAD, Math.min(Number(y) || 0, maxY)),
    };
}

function apply(p) {
    if (!ensureNode()) return;
    const fmt = formatTip(p);
    const text = String(p.text != null ? p.text : fmt.text);
    const suffix = String(p.suffix != null ? p.suffix : fmt.suffix);
    let changed = false;
    if (text !== lastText) {
        textEl.textContent = text;
        lastText = text;
        changed = true;
    }
    if (suffix !== lastSuffix) {
        suffixEl.textContent = suffix;
        lastSuffix = suffix;
        changed = true;
    }
    if (changed) measure();
    const { x, y } = clampPos(p.x, p.y);
    node.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
    node.hidden = false;
}

/**
 * 显示/更新浮层。opts = { x, y, t, fps, duration, snap, easeText, conflict, text, suffix }。
 * 给了 text/suffix 就直接用（曲线区要把 h1/h2 塞进来）；否则按 formatTip 拼。
 * 同一帧内多次调用只应用最后一次（pointermove 会一帧来好几次）。
 */
export function showTip(opts) {
    const p = opts || {};
    if (!canDom()) return;
    queued = p;
    if (rafBusy) return;
    rafBusy = true;
    const run = () => {
        rafBusy = false;
        const next = queued;
        queued = null;
        if (next) apply(next);
    };
    if (typeof requestAnimationFrame === 'function') {
        rafId = requestAnimationFrame(run);
    } else {
        run();
    }
}

/** 摘掉浮层：拖完、取消、dispose 都走这里，document.body 不留残留节点。 */
export function hideTip() {
    queued = null;
    if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    rafId = 0;
    rafBusy = false;
    if (node && typeof node.remove === 'function') node.remove();
    node = null;
    textEl = null;
    suffixEl = null;
    size = { w: 0, h: 0 };
    lastText = '\u0000';
    lastSuffix = '\u0000';
}

/** 只给测试与验收用：现在有没有挂着的浮层。 */
export function tipMounted() {
    return !!node;
}
