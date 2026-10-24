/**
 * Kleks Motion —— 渲染效果器（canvas 2D filter）
 *
 * 纯函数模块：只 import 纯几何/求值模块（core/transform.mjs），不碰 DOM、不读 window，
 * 可以直接在 Node 下 `node --test` 跑。
 *
 * 五类效果全部编译成 `ctx.filter` 认得的 CSS filter 函数串：
 * - `blur`    → `blur()`
 * - `glow`    → `drop-shadow(0 0 Npx color)`（偏移为 0，等于四周外发光）
 * - `shadow`  → `drop-shadow(dx dy Npx color)`
 * - `adjust`  → `brightness()` / `contrast()` / `saturate()` / `hue-rotate()`
 * - `outline` → 四个方向的 0 模糊 drop-shadow，凑出一圈描边
 *
 * 拼接规则：效果按数组顺序输出，同一效果内部的函数按参数声明顺序输出。
 * 「恒等值」一律不输出（blur 0、brightness 1、hue-rotate 0、偏移与模糊全 0 的
 * 投影等），否则每次渲染都白做一次离屏合成；全无有效输出时返回 `'none'`。
 */
import { stateAt } from '../core/transform.mjs';

/** 数值参数：范围 + 步进 + 默认值 */
function num(key, label, min, max, step, def) {
    return { key, label, min, max, step, def };
}

/** 颜色参数：只有默认值，用 `color: true` 与数值参数区分 */
function rgb(key, label, def) {
    return { key, label, def, color: true };
}

function deepFreeze(list) {
    for (const def of list) {
        for (const p of def.params) Object.freeze(p);
        Object.freeze(def.params);
        Object.freeze(def);
    }
    return Object.freeze(list);
}

export const EFFECT_DEFS = deepFreeze([
    { id: 'blur', name: '模糊', params: [num('amount', '模糊半径', 0, 40, 0.5, 4)] },
    {
        id: 'glow',
        name: '外发光',
        params: [num('amount', '发光强度', 0, 40, 1, 8), rgb('color', '颜色', '#4a7dff')],
    },
    {
        id: 'shadow',
        name: '投影',
        params: [
            num('dx', 'X 偏移', -40, 40, 1, 4),
            num('dy', 'Y 偏移', -40, 40, 1, 4),
            num('amount', '模糊半径', 0, 40, 1, 6),
            rgb('color', '颜色', 'rgba(0,0,0,0.45)'),
        ],
    },
    {
        id: 'adjust',
        name: '调整',
        params: [
            num('brightness', '亮度', 0, 2, 0.01, 1),
            num('contrast', '对比度', 0, 2, 0.01, 1),
            num('saturate', '饱和度', 0, 2, 0.01, 1),
            num('hue', '色相', -180, 180, 1, 0),
        ],
    },
    {
        id: 'outline',
        name: '描边',
        params: [num('amount', '描边宽度', 0, 20, 0.5, 2), rgb('color', '颜色', '#000000')],
    },
]);

const DEF_BY_ID = new Map(EFFECT_DEFS.map((def) => [def.id, def]));

function defOf(type) {
    return typeof type === 'string' ? DEF_BY_ID.get(type) || null : null;
}

function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
}

/** 数字转 CSS 文本：最多 3 位小数，去掉浮点尾巴（0.30000000000000004 → 0.3） */
function cssNum(v) {
    const r = Math.round(v * 1000) / 1000;
    return String(r === 0 ? 0 : r);
}

function px(v) {
    return cssNum(v) + 'px';
}

/** 是否是「不产生任何视觉变化」的值 */
function same(v, target) {
    return Math.round(v * 1000) / 1000 === target;
}

/** 取某个数值参数：字符串数字也认，非法值一律回落到默认值 */
function readNum(raw, spec, fallback) {
    let n;
    if (typeof raw === 'number') n = raw;
    else if (typeof raw === 'string' && raw.trim() !== '') n = Number(raw);
    else return fallback;
    if (!Number.isFinite(n)) return fallback;
    return clamp(n, spec.min, spec.max);
}

function readColor(raw, fallback) {
    return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : fallback;
}

/**
 * 生成某类效果的默认对象（`{ type, ...params }`）。
 * @param {string} type 效果 id
 * @returns {object|null} 未知 type 返回 null
 */
export function defaultEffect(type) {
    const def = defOf(type);
    if (!def) return null;
    const out = { type: def.id };
    for (const p of def.params) out[p.key] = p.def;
    return out;
}

/**
 * 把任意输入整理成合法效果对象：数值夹到 min/max、缺失补默认、多余键丢弃。
 * @param {object} e 原始效果（可能来自存档、UI、粘贴）
 * @returns {object|null} type 非法返回 null
 */
export function normalizeEffect(e) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
    const def = defOf(e.type);
    if (!def) return null;
    const out = { type: def.id };
    for (const p of def.params) {
        out[p.key] = p.color ? readColor(e[p.key], p.def) : readNum(e[p.key], p, p.def);
    }
    return out;
}

/** 单类效果 → CSS filter 函数数组（恒等值返回空数组） */
function emit(e) {
    switch (e.type) {
        case 'blur':
            return same(e.amount, 0) ? [] : ['blur(' + px(e.amount) + ')'];
        case 'glow':
            return same(e.amount, 0) ? [] : ['drop-shadow(0 0 ' + px(e.amount) + ' ' + e.color + ')'];
        case 'shadow':
            if (same(e.dx, 0) && same(e.dy, 0) && same(e.amount, 0)) return [];
            return [
                'drop-shadow(' + px(e.dx) + ' ' + px(e.dy) + ' ' + px(e.amount) + ' ' + e.color + ')',
            ];
        case 'adjust': {
            const out = [];
            if (!same(e.brightness, 1)) out.push('brightness(' + cssNum(e.brightness) + ')');
            if (!same(e.contrast, 1)) out.push('contrast(' + cssNum(e.contrast) + ')');
            if (!same(e.saturate, 1)) out.push('saturate(' + cssNum(e.saturate) + ')');
            if (!same(e.hue, 0)) out.push('hue-rotate(' + cssNum(e.hue) + 'deg)');
            return out;
        }
        case 'outline': {
            if (same(e.amount, 0)) return [];
            const w = e.amount;
            // 四个方向各投影一次、模糊半径 0，拼成一圈实心边
            return [
                'drop-shadow(' + px(w) + ' 0 0 ' + e.color + ')',
                'drop-shadow(' + px(-w) + ' 0 0 ' + e.color + ')',
                'drop-shadow(0 ' + px(w) + ' 0 ' + e.color + ')',
                'drop-shadow(0 ' + px(-w) + ' 0 ' + e.color + ')',
            ];
        }
        default:
            return [];
    }
}

/**
 * 效果数组 → `ctx.filter` 字符串。
 * @param {object[]} effects 效果数组（顺序即输出顺序）
 * @returns {string} 无有效效果时返回 `'none'`
 */
export function filterString(effects) {
    if (!Array.isArray(effects) || effects.length === 0) return 'none';
    const parts = [];
    for (const raw of effects) {
        const e = normalizeEffect(raw);
        if (!e) continue;
        const chunk = emit(e);
        for (const f of chunk) parts.push(f);
    }
    return parts.length ? parts.join(' ') : 'none';
}

/**
 * 把效果写进 2D 上下文。
 * @param {object} g canvas 2D 上下文（或任何带可写 `filter` 的假对象）
 * @param {object[]} effects 效果数组
 * @returns {boolean} 写入成功 true；抛错时回退到 `'none'` 并返回 false
 */
export function applyEffects(g, effects) {
    if (!g || typeof g !== 'object') return false;
    try {
        g.filter = filterString(effects);
        return true;
    } catch (err) {
        try {
            g.filter = 'none';
        } catch (err2) {
            /* 上下文拒绝写入，连回退都做不到：保持原样 */
        }
        return false;
    }
}

/** 清掉效果（等幂，失败也不抛） */
export function clearEffects(g) {
    if (!g || typeof g !== 'object') return;
    try {
        g.filter = 'none';
    } catch (err) {
        /* 上下文拒绝写入 */
    }
}

/**
 * 这组效果会不会真的产生视觉变化。
 * 恒等值（blur 0 / brightness 1 / hue 0 …）和非法项都算「没有效果」，
 * 便于渲染前决定要不要走带 filter 的离屏路径。
 * @param {object[]} effects 效果数组
 * @returns {boolean}
 */
export function hasEffects(effects) {
    return filterString(effects) !== 'none';
}

/**
 * 参数级关键帧：一个效果的某个数值参数可以带一条轨道。
 * 轨道复用元素变换的 `createTrack()` 结构（值存在 `state.x` 里），
 * 因此线性 / 贝塞尔 / 保持三种插值和切线柄全部与变换共用同一求值器。
 *
 * @param {object} e     单个效果
 * @param {number} time  秒
 * @returns {object}     时间求值后的效果副本（无轨道时返回原对象）
 */
export function effectAt(e, time) {
    if (!e || typeof e !== 'object' || !e.tracks) return e;
    const def = defOf(e.type);
    let out = null;
    for (const key of Object.keys(e.tracks)) {
        const track = e.tracks[key];
        if (!track || !Array.isArray(track.keys) || !track.keys.length) continue;
        const spec = def ? def.params.find((p) => p.key === key) : null;
        // 颜色参数没有可插值的标量：数值轨道写进去只会得到非法颜色，直接跳过
        if (spec && spec.color) continue;
        const st = stateAt(track, time || 0);
        if (st && typeof st.x === 'number' && Number.isFinite(st.x)) {
            if (!out) out = Object.assign({}, e);
            // 贝塞尔过冲 / 手改存档都会让求值越过 min..max：夹住，否则会拼出 blur(-6px) 这类
            // 非法 CSS，浏览器对整串 filter 一个函数都不认，效果就整个消失
            out[key] = spec ? clamp(st.x, spec.min, spec.max) : st.x;
        }
    }
    return out || e;
}

/**
 * 与 filterString 相同，但先按时间对每个效果做参数求值。
 * 这是渲染期效果器唯一的入口（engine 的 filterFor 注入它）。
 *
 * 求值结果同样过 normalizeEffect：轨道只覆盖「有轨道的键」，其余键可能是缺省或
 * 非法值（存档里少的 color、坏数据），不归一就会输出 drop-shadow(0 0 8px undefined)，
 * 而 CSS 只要有一个函数非法就丢弃整串 filter —— 轨道路径必须和静态路径同语义。
 */
export function filterStringAt(effects, time) {
    if (!Array.isArray(effects) || !effects.length) return 'none';
    const parts = [];
    for (const raw of effects) {
        const e = normalizeEffect(effectAt(raw, time || 0));
        if (!e) continue;
        const list = emit(e);
        for (const s of list) parts.push(s);
    }
    return parts.length ? parts.join(' ') : 'none';
}

/** 某个效果是否有任何参数轨道 */
export function hasTracks(e) {
    if (!e || !e.tracks) return false;
    for (const key of Object.keys(e.tracks)) {
        const track = e.tracks[key];
        if (track && Array.isArray(track.keys) && track.keys.length) return true;
    }
    return false;
}
