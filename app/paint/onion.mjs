/**
 * Kleks Motion —— 洋葱皮（v6 时间模型）
 *
 * 语义不再按「帧序号 ±N」，而是按**纹理切换点**：取当前时间 t 之前 / 之后各 N 个
 * 纹理时间点，把那些时刻的画面做成半透明彩色「幽灵」叠在下面。
 *   · 时间点来自 objectsOf(doc) 各对象 celTimes 的并集（override.layerId 时只看该对象）；
 *   · 「当前是第几个切换点」用 celIndexAt 定位，t 早于第一个切换点时 before 为空；
 *   · 间隔 3 秒的两个纹理与间隔 1/12 秒的两个纹理在这里没有区别 —— 只有顺序有意义。
 *
 * cel 位图可能是**不透明白底**（导入的图片），所以先剥白底再着色，
 * 否则整块画布会被染成一片红/绿。
 */

import { drawLayer } from './composite.mjs';
import { ONION_DEFAULTS, celIndexAt, celTimes, normalizeOnion, objectsOf } from '../core/cel.mjs';

export { ONION_DEFAULTS };

export function onionConfig(doc) {
    return Object.assign({}, ONION_DEFAULTS, (doc && doc.onion) || {});
}

export function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return [150, 150, 150];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 参与洋葱皮的纹理切换点（秒，升序去重）。
 * override.layerId 有值时只看该对象，否则取全文档并集。
 */
export function onionTimes(doc, override) {
    const only = override && override.layerId ? String(override.layerId) : null;
    const list = objectsOf(doc);
    const set = new Set();
    for (const obj of list) {
        if (!obj || (only && obj.id !== only)) continue;
        for (const at of celTimes(obj)) set.add(at);
    }
    return Array.from(set).sort((a, b) => a - b);
}

/** 当前时间 t 落在切换点序列的哪个下标（t 早于首个切换点 → -1）。 */
function indexOfTime(times, t) {
    if (!times.length) return -1;
    // celIndexAt 吃「对象」，这里给它一个只含时间点的轻量替身，避免重复实现二分。
    return celIndexAt({ cels: times.map((at) => ({ at, image: null })) }, t);
}

/**
 * 把**某个时刻**的可见对象画到临时画布上，再剥白底 + 着色。
 * @returns 着色后的 ImageData（供调用方叠层），或 null
 */
export function tintAt(buf, bufCtx, doc, t, cfg, dir) {
    if (!buf || !bufCtx || !doc) return null;
    const W = Math.max(1, doc.width | 0);
    const H = Math.max(1, doc.height | 0);
    if (buf.width !== W || buf.height !== H) {
        buf.width = W;
        buf.height = H;
    }
    bufCtx.setTransform(1, 0, 0, 1, 0, 0);
    bufCtx.globalAlpha = 1;
    bufCtx.globalCompositeOperation = 'source-over';
    bufCtx.clearRect(0, 0, W, H);

    let has = false;
    const list = objectsOf(doc);
    for (let i = list.length - 1; i >= 0; i--) {
        const obj = list[i];
        if (!obj || !obj.visible || obj.onionIgnore) continue;
        if (drawLayer(bufCtx, doc, obj, t, { ignoreTransform: cfg.ignoreTransform })) has = true;
    }
    if (!has) return null;

    const img = bufCtx.getImageData(0, 0, W, H);
    const px = img.data;
    const tint = cfg.mode !== 'fade';
    const rgb = dir < 0 ? hexToRgb(cfg.past) : hexToRgb(cfg.next);
    for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] < 8) continue;
        const lum = px[i] * 0.299 + px[i + 1] * 0.587 + px[i + 2] * 0.114;
        if (lum > 244) {
            px[i + 3] = 0;
            continue;
        }
        if (tint) {
            px[i] = rgb[0];
            px[i + 1] = rgb[1];
            px[i + 2] = rgb[2];
        }
        px[i + 3] = Math.min(255, Math.round((256 - lum) * 1.6));
    }
    return img;
}

/**
 * 把前后纹理的幽灵画到目标上下文（调用方负责先清屏）。
 * @param t 当前时间（秒）
 * @param scratch `{buf, ctx}` 复用缓冲，避免每次新建 canvas
 * @param override `{layerId?, before?, after?, mode?, past?, next?, opacity?, ignoreTransform?}`
 * @returns 渲染出的幽灵层数
 */
export function drawOnion(g, doc, t, scratch, override) {
    const cfg = normalizeOnion(Object.assign(onionConfig(doc), override || {}));
    if (!cfg.enabled || !g || !doc || !scratch) return 0;
    const times = onionTimes(doc, override);
    if (!times.length) return 0;

    const cur = indexOfTime(times, t);
    const items = [];
    for (let i = 1; i <= cfg.before; i++) {
        const idx = cur - i;
        if (idx >= 0) items.push({ at: times[idx], offset: -i });
    }
    for (let i = 1; i <= cfg.after; i++) {
        const idx = cur + i;
        if (idx >= 0 && idx < times.length) items.push({ at: times[idx], offset: i });
    }
    if (!items.length) return 0;

    let n = 0;
    for (const item of items) {
        const dir = item.offset < 0 ? -1 : 1;
        const img = tintAt(scratch.buf, scratch.ctx, doc, item.at, cfg, dir);
        if (!img) continue;
        const dist = Math.max(1, Math.abs(item.offset));
        scratch.ctx.putImageData(img, 0, 0);
        g.globalAlpha = Math.max(0.05, (cfg.opacity || 0.4) / dist);
        g.drawImage(scratch.buf, 0, 0);
        n++;
    }
    g.globalAlpha = 1;
    return n;
}
