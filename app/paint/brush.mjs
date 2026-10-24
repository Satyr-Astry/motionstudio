/**
 * Kleks Motion —— 笔刷定义与笔尖生成
 *
 * 全部坐标是画面像素。笔尖（tip）是一张离屏位图，按
 * `笔刷 + 直径 + 颜色 + 不透明度` 缓存，换色才重新生成。
 */

export const BRUSH_DEFAULTS = Object.freeze({
    size: 8,
    opacity: 1,
    hardness: 0.85,
    spacing: 0.14,
    jitter: 0,
    flow: 1,
});

/** 用户可覆写的参数（画板「笔刷设置」弹层的四条滑杆，顺序即界面顺序）。 */
export const BRUSH_PARAM_KEYS = Object.freeze(['hardness', 'spacing', 'jitter', 'flow']);

/**
 * 每条参数允许的闭区间。数字越界 → 钳到区间；非数字 → 回落预设（见 resolveBrush）。
 * spacing 下限不是 0：0 会让落点间距归零，落笔变成死循环。
 */
export const BRUSH_PARAM_RANGE = Object.freeze({
    hardness: Object.freeze([0, 1]),
    spacing: Object.freeze([0.01, 2]),
    jitter: Object.freeze([0, 1]),
    flow: Object.freeze([0.02, 1]),
});

/**
 * 内置笔刷。
 * - `spacing` 单位是「笔尖直径的倍数」，越小点越密、越平滑。
 * - `hardness` 0 = 全软（径向渐变到底），1 = 硬边。
 * - `pixelGrid` 让落点对齐整像素格，画像素画不会糊边。
 */
export const BRUSH_PRESETS = Object.freeze([
    { id: 'pixel', name: '像素笔', hardness: 1, spacing: 1, antialias: false, pixelGrid: true, flow: 1 },
    { id: 'round', name: '圆笔', hardness: 0.85, spacing: 0.12, antialias: true, flow: 1 },
    { id: 'soft', name: '软笔', hardness: 0.08, spacing: 0.08, antialias: true, flow: 0.32 },
    { id: 'pencil', name: '铅笔', hardness: 0.55, spacing: 0.1, antialias: true, jitter: 0.22, flow: 0.82 },
    // 晕染：把上一处的像素「拖」到当前处（Kleks 里叫 smudge / blender），
    // strength 是每次搬运的强度，带 0.25 的固色比例，否则拖久了颜色会被抹平。
    { id: 'smudge', name: '晕染', hardness: 0.5, spacing: 0.06, antialias: true, smudge: true, strength: 0.55, flow: 1 },
    // 散点：一个落点上打 count 个随机偏移的小点，画星星/粒子/毛边很好用。
    { id: 'scatter', name: '散点', hardness: 0.9, spacing: 0.05, antialias: true, scatter: { count: 7, spread: 1.1 }, flow: 0.85 },
    { id: 'eraser', name: '橡皮', hardness: 0.8, spacing: 0.12, antialias: true, erase: true, flow: 1 },
]);

export function brushById(id) {
    for (const b of BRUSH_PRESETS) {
        if (b.id === id) return b;
    }
    return BRUSH_PRESETS[1];
}

/** 预设里没写这条参数时用的兜底值。 */
function paramFallback(base, key) {
    const own = base ? Number(base[key]) : NaN;
    if (Number.isFinite(own)) return own;
    const def = Number(BRUSH_DEFAULTS[key]);
    return Number.isFinite(def) ? def : 0;
}

/**
 * 单条参数净化：
 * - 数字（或可解析的数字字符串）→ 钳到 BRUSH_PARAM_RANGE；
 * - 其余（NaN / Infinity / null / undefined / 布尔 / 对象 / 空串）→ 回落 fallback。
 */
function sanitizeParam(key, raw, fallback) {
    const n = typeof raw === 'number'
        ? raw
        : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
    if (!Number.isFinite(n)) return fallback;
    const range = BRUSH_PARAM_RANGE[key];
    return Math.min(range[1], Math.max(range[0], n));
}

/**
 * 合并「预设 + 用户覆写」，返回**新**笔刷对象。
 *
 * 纯函数：不改 BRUSH_PRESETS 里的只读常量，也不改 overrides。
 * 回落规则（与界面上四条滑杆一一对应）：
 *   hardness 0..1（默认取预设值）、spacing 0.01..2、jitter 0..1、flow 0.02..1；
 *   非数字/非有限值 → 预设值（预设缺这项就用 BRUSH_DEFAULTS），数字越界 → 钳制。
 *
 * @param {string} id 笔刷 id，未知 id 与 brushById 一致回落到「圆笔」
 * @param {object|null} overrides 覆写表，只认 BRUSH_PARAM_KEYS 里的键
 * @returns {object} `{...预设, hardness, spacing, jitter, flow}`（id / antialias / pixelGrid 等原样保留）
 */
export function resolveBrush(id, overrides) {
    const base = brushById(id);
    const src = overrides && typeof overrides === 'object' ? overrides : null;
    const out = { ...base };
    for (const key of BRUSH_PARAM_KEYS) {
        const fallback = paramFallback(base, key);
        out[key] = sanitizeParam(key, src ? src[key] : undefined, fallback);
    }
    return out;
}

/** 笔尖的实际像素直径：至少 1px，像素笔取整。 */
export function tipDiameter(brush, size) {
    const s = Number(size);
    const v = Number.isFinite(s) && s > 0 ? s : BRUSH_DEFAULTS.size;
    return brush && brush.pixelGrid ? Math.max(1, Math.round(v)) : Math.max(1, v);
}

/** 相邻落点间距（像素）；像素笔恒为 1 格，避免同格重复叠色变深。 */
export function spacingPx(brush, size) {
    const d = tipDiameter(brush, size);
    const k = brush && Number.isFinite(brush.spacing) ? brush.spacing : BRUSH_DEFAULTS.spacing;
    return brush && brush.pixelGrid ? Math.max(1, Math.round(d * k)) : Math.max(0.5, d * k);
}

/**
 * 笔尖缓存键：颜色/直径/硬度/边缘任一变化都要重建。
 * 硬度必须入键 —— 用户改「硬度」但 id 不变时，旧键会把缓存里的软笔尖原样还回来。
 */
export function tipKey(brush, size, color, opacity) {
    const d = Math.round(tipDiameter(brush, size) * 4) / 4;
    const h = brush && Number.isFinite(brush.hardness)
        ? Math.round(Math.min(1, Math.max(0, brush.hardness)) * 100)
        : 'n';
    const edge = brush ? (brush.pixelGrid ? 'px' : (brush.antialias === false ? 'aa0' : 'aa1')) : 'aa1';
    return [brush ? brush.id : 'round', d, color || '#000', Math.round((opacity == null ? 1 : opacity) * 100), h, edge].join('|');
}

const tipCache = new Map();
const TIP_CACHE_MAX = 24;

export function clearTipCache() {
    tipCache.clear();
}

function makeCanvas(w, h) {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
}

/**
 * 生成笔尖位图（居中、直径 = tipDiameter）。
 * 软笔用径向渐变，硬笔用实心圆，像素笔用整格方块。
 */
export function makeTip(brush, size, color, opacity) {
    const key = tipKey(brush, size, color, opacity);
    const hit = tipCache.get(key);
    if (hit) return hit;

    const d = tipDiameter(brush, size);
    const px = Math.max(1, Math.ceil(d) + 2);
    const cv = makeCanvas(px, px);
    const g = cv.getContext('2d');
    const c = color || '#000000';
    const alpha = opacity == null ? 1 : Math.max(0, Math.min(1, opacity));
    g.globalAlpha = alpha;

    if (brush && brush.pixelGrid) {
        const w = Math.max(1, Math.round(d));
        const off = Math.floor((px - w) / 2);
        g.fillStyle = c;
        g.fillRect(off, off, w, w);
    } else {
        const r = d / 2;
        g.translate(px / 2, px / 2);
        if (!brush || brush.hardness >= 0.999 || !brush.antialias) {
            g.fillStyle = c;
            g.beginPath();
            g.arc(0, 0, r, 0, Math.PI * 2);
            g.fill();
        } else {
            const h = Math.max(0, Math.min(1, brush.hardness));
            const grd = g.createRadialGradient(0, 0, 0, 0, 0, r);
            grd.addColorStop(0, c);
            grd.addColorStop(Math.max(0.001, h * 0.95), c);
            grd.addColorStop(1, 'rgba(0,0,0,0)');
            g.fillStyle = grd;
            g.beginPath();
            g.arc(0, 0, r, 0, Math.PI * 2);
            g.fill();
        }
    }

    if (tipCache.size >= TIP_CACHE_MAX) {
        const first = tipCache.keys().next();
        if (!first.done) tipCache.delete(first.value);
    }
    tipCache.set(key, cv);
    return cv;
}
