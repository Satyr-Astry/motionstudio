/**
 * Kleks Motion —— 笔刷定义与笔尖生成
 *
 * 全部坐标是画面像素。笔尖（tip）是一张离屏位图，按
 * `笔刷 + 直径 + 颜色 + 不透明度` 缓存，换色才重新生成。
 *
 * 压感与间距的**纯计算**都在这里（DOM-free，可被 node 测试直接 import）：
 *   pointerPressure() → 指针压力 / sizeScaleAt() / alphaScaleAt() 三条映射；
 *   spacingPx() 的默认值按 Klecks 的「半径倍数」口径重标定（见 KLEKS_PEN_GAP_DIAMETER）。
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
 * Klecks 圆笔的落点间距：`pen-brush.ts:33 settingSpacing = 0.8489`，而它的 `size`
 * 是**半径**（`pen-brush.ts:189 arc(x, y, size, …)`）。我们 `spacing` 是**直径**倍数，
 * 所以换算系数是 0.5 —— 0.8489 × 0.5 = 0.42445，落点前进 = R × 0.8489，与它一致。
 * 旧值 0.12（= R × 0.24）比它密 3.5 倍，半透明笔画两三点就到顶（docs/合流计划-2026-10.md §B2）。
 */
export const KLEKS_PEN_SPACING = 0.8489;
export const KLEKS_PEN_GAP_DIAMETER = KLEKS_PEN_SPACING / 2;   // 0.42445（直径倍数）

/**
 * 内置笔刷。
 * - `spacing` 单位是「笔尖直径的倍数」，越小点越密、越平滑。
 * - `hardness` 0 = 全软（径向渐变到底），1 = 硬边。
 * - `pixelGrid` 让落点对齐整像素格，画像素画不会糊边。
 * - `sizePressure` 真实压感设备上笔尖直径随压力缩放。鼠标 / 无压感设备的压力恒为 1
 *   （见 pointerPressure），所以这两档开关不会改变「压感关」时的笔迹。
 *   像素笔关掉：它是整格方块，缩放会引入半格与抗锯齿糊边。
 *   晕染关掉：Klecks `smudge-brush.ts:281 settingHasSizePressure = false`，且我们的
 *   搬运缓冲区按笔尖尺寸开，缩放着色会和取样区错位。
 */
export const BRUSH_PRESETS = Object.freeze([
    { id: 'pixel', name: '像素笔', hardness: 1, spacing: 1, antialias: false, pixelGrid: true, flow: 1, sizePressure: false },
    // 圆笔 = Klecks pen 的几何量级（间距比旧值稀 3.54 倍）
    { id: 'round', name: '圆笔', hardness: 0.85, spacing: KLEKS_PEN_GAP_DIAMETER, antialias: true, flow: 1, sizePressure: true },
    // 软笔：同样对齐 Klecks，但它是渐变尖（hardness 0.08）+ 低流量，笔画浓淡靠叠加次数。
    // 实测中段振荡 9%（size 20 / 不透明 100：中段 alpha 91–100，无可见珠串），未到需要收紧的程度；
    // 代价是中段浓度从旧间距下的 234 降到 ~100（密度 5.31 倍 → 1 倍，单笔更淡），要浓就多叠几遍。
    { id: 'soft', name: '软笔', hardness: 0.08, spacing: KLEKS_PEN_GAP_DIAMETER, antialias: true, flow: 0.32, sizePressure: true },
    { id: 'pencil', name: '铅笔', hardness: 0.55, spacing: KLEKS_PEN_GAP_DIAMETER, antialias: true, jitter: 0.22, flow: 0.82, sizePressure: true },
    // 晕染：把上一处的像素「拖」到当前处（Kleks 里叫 smudge / blender），
    // strength 是每次搬运的强度，带 0.25 的固色比例，否则拖久了颜色会被抹平。
    // 间距 0.1（= R × 0.2）：Klecks 自由笔画是 R × 0.0682，但那是逐像素 lerp + dither；
    // 我们的位图搬运式 smudge **越密越糊**（docs 笔刷计划 :199），所以取 Klecks 线工具
    // 口径（0.2045R）与橡皮口径（0.2R）的量级，把每像素搬运次数从 ~8 次降到 ~5 次。
    { id: 'smudge', name: '晕染', hardness: 0.5, spacing: 0.1, antialias: true, smudge: true, strength: 0.55, flow: 1, sizePressure: false },
    // 散点：一个落点上打 count 个随机偏移的小点，画星星/粒子/毛边很好用。
    // 每个落点自带 7 点 × 1.1R 的散布，间距按圆笔口径即可铺匀（旧值 0.05 让同一点被反复覆盖）。
    { id: 'scatter', name: '散点', hardness: 0.9, spacing: KLEKS_PEN_GAP_DIAMETER, antialias: true, scatter: { count: 7, spread: 1.1 }, flow: 0.85, sizePressure: true },
    // 橡皮：Klecks `eraser-brush.ts:17/:93` 的 bdist = max(0.5, 1-opacity) × R × 0.4，
    // 不透明度 1 时 = R × 0.2 = 直径 × 0.1。
    { id: 'eraser', name: '橡皮', hardness: 0.8, spacing: 0.1, antialias: true, erase: true, flow: 1, sizePressure: true },
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

/* ── 压感（三条映射；鼠标 / 无压感设备一律等于 1，笔迹不变） ── */

/** 压感能把笔尖直径压到的最小比例（Klecks 用 `Math.max(0.1, …)` 同一个数）。 */
export const PRESSURE_MIN = 0.1;

/**
 * 指针压力 → 0..1。口径与 `engine.mjs` 的 `pressureOf()` 完全一致（那边已经接好，不要另立一套）：
 * - 鼠标（`pointerType === 'mouse'`）恒 1；
 * - `pressure === 0.5` 是「这台设备不支持压感」的规范值，回 1；
 * - 非数字 / ≤0 / 非有限 → 1（`pointermove` 抬起时会给 0，不能当成「压到最轻」）；
 * - 其余夹到 1。
 * 这样「压感关」与改动前逐像素一致：`sizeScaleAt()` 得 1，落笔走原来的 `drawImage`。
 */
export function pointerPressure(e) {
    if (!e || typeof e !== 'object') return 1;
    if (e.pointerType === 'mouse') return 1;
    const p = e.pressure;
    if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0 || p === 0.5) return 1;
    return p >= 1 ? 1 : p;
}

/** 压力夹到 0..1；非数字当 1（= 无压感）。 */
function clampPressure(pressure) {
    if (typeof pressure !== 'number' || !Number.isFinite(pressure)) return 1;
    return Math.min(1, Math.max(0, pressure));
}

/**
 * 压感 → **直径倍数**。
 * 开关没开（`sizePressure !== true`）或压力为 1 → 恒返回 1（调用方据此走不缩放的快路径）。
 * 开了就按 Klecks `pen-brush.ts:231-233` 的 `max(0.1, pressure × size)` 线性缩放。
 */
export function sizeScaleAt(brush, pressure) {
    if (!brush || brush.sizePressure !== true) return 1;
    const p = clampPressure(pressure);
    if (p >= 1) return 1;
    return Math.max(PRESSURE_MIN, p);
}

/**
 * 压感 → 落点透明度倍数。Klecks 的 `hasOpacityPressure` 是独立开关，圆笔默认关
 * （`pen-brush.ts:29`）、橡皮也关（`eraser-brush.ts:20`）—— 压感只改粗细、不改浓淡。
 * 打开时按 `pen-brush.ts:120-122` 的 `p × p` 走。
 */
export function alphaScaleAt(brush, pressure) {
    if (!brush || brush.opacityPressure !== true) return 1;
    const p = clampPressure(pressure);
    if (p >= 1) return 1;
    return Math.max(PRESSURE_MIN, p) ** 2;
}

/* ── 间距重标定的一次性迁移 ── */

/**
 * 旧版（v1）7 支笔的 spacing 默认值 —— **冻结**，只给迁移用，别再当默认值。
 * 用户从没动过滑杆、只是被写进过 localStorage 的值，靠这张表认出来。
 */
export const LEGACY_SPACING = Object.freeze({
    pixel: 1,
    round: 0.12,
    soft: 0.08,
    pencil: 0.1,
    smudge: 0.06,
    scatter: 0.05,
    eraser: 0.12,
});

/** 间距重标定版本号；`localStorage['ms.brush.migrate']` 记住它，只迁一次。 */
export const SPACING_VERSION = 2;

/**
 * 一次性迁移：把「恰好等于旧默认值的 spacing 覆写」删掉，让新默认生效。
 * 用户自己调过的值（≠ 旧默认）原样保留；默认值没变的笔（像素/晕染旧值表里也有，但
 * 只有默认真的变了才删）不动。
 *
 * 纯函数，不改入参：需要改写时返回新的覆写表（可能为空对象 `{}`），无需改写返回 `null`。
 *
 * @param {unknown} parsed localStorage 里解析出来的覆写表
 * @param {string} id 笔刷 id（未知 id 不迁移）
 * @returns {object|null}
 */
export function migrateBrushOverrides(parsed, id) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    let preset = null;
    for (const b of BRUSH_PRESETS) {
        if (b.id === id) {
            preset = b;
            break;
        }
    }
    if (!preset) return null;
    const out = {};
    for (const key of BRUSH_PARAM_KEYS) {
        if (Object.prototype.hasOwnProperty.call(parsed, key)) out[key] = parsed[key];
    }
    if (!Object.prototype.hasOwnProperty.call(out, 'spacing')) return null;
    const legacy = LEGACY_SPACING[id];
    if (!Number.isFinite(legacy)) return null;
    if (Number(out.spacing) !== legacy) return null;   // 用户自己调过：保留
    if (preset.spacing === legacy) return null;        // 默认没变：不用迁
    delete out.spacing;
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
 * 沿直线「行军」出这一段的落点。
 *
 * 步长 = 间距 × 当前压力对应的直径倍数 —— 压到 20% 时针尖只有 0.2 倍直径，间距若还按
 * 满直径算，细笔画会碎成一串断点。Klecks 是同一口径：`pen-brush.ts:235`
 * `linearLine.add(x, y, size * settingSpacing)` 里的 size 就是缩放后的尺寸。
 *
 * 纯函数、不碰画布：`board.mjs` 与 `engine.mjs` 只负责把返回的落点画出来，测试可以直接读。
 *
 * @param {{x:number,y:number}} from 上一个落点
 * @param {{x:number,y:number}} to 这一段的目标点
 * @param {{brush:object,gap:number,carry?:number,pressureFrom?:number,pressureTo?:number}} opts
 * @returns {{stamps:Array<{x:number,y:number,p:number}>, carry:number}}
 */
export function marchStamps(from, to, opts) {
    const o = opts || {};
    const gap = Math.max(0, Number(o.gap) || 0);
    const carry = Math.max(0, Number(o.carry) || 0);
    const p0 = clampPressure(o.pressureFrom == null ? 1 : o.pressureFrom);
    const p1 = clampPressure(o.pressureTo == null ? p0 : o.pressureTo);
    const out = [];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dist = Math.hypot(dx, dy);
    if (!(dist >= 0.01)) return { stamps: out, carry };   // 亚像素抖动：不落笔、不动 carry
    let travelled = carry;
    for (;;) {
        const t = Math.min(1, travelled / dist);
        const step = Math.max(0.5, gap * sizeScaleAt(o.brush, p0 + (p1 - p0) * t));
        if (travelled + step > dist) break;
        travelled += step;
        const k = Math.min(1, travelled / dist);
        out.push({ x: from.x + dx * k, y: from.y + dy * k, p: p0 + (p1 - p0) * k });
    }
    return { stamps: out, carry: Math.max(0, travelled - dist) };
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
