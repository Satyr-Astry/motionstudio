/**
 * Kleks Motion —— 纹理尺寸的纯计算
 *
 * 「适配」（画板工具栏那个）动的是视图相机，不改像素尺寸；这里回答的是另一件事：
 * 把一张 RGBA 缓冲裁到内容、或者重排到一张新的画布上。全部是纯函数，
 * 不碰 canvas、不碰 DOM，node 里可以直接跑。
 *
 * 坐标系约定：所有 `x/y/w/h` 都是**像素**，左上角为原点，`rgba` 是行优先、
 * 每像素 4 字节（R,G,B,A）的 `Uint8ClampedArray`（或任何可按下标读的同类数组）。
 */

/**
 * 判定「这里有内容」的 alpha 下限。
 * 与 `app/paint/engine.mjs` 里取色器 `pixelHex(d, alphaMin)` 的 `alphaMin = 8` 同口径：
 * 低于它的像素算空气，肉眼也看不出来。
 */
export const TRIM_ALPHA_MIN = 8;

/** 纹理边长的上限。与文档画布、画板、属性输入框的 4096 保持一致。 */
export const TEXTURE_MAX = 4096;

function sizeOf(v, fallback) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 内容包围盒。
 *
 * @param {Uint8ClampedArray|Uint8Array} rgba 行优先 RGBA
 * @param {number} w
 * @param {number} h
 * @param {number} [minAlpha] alpha 至少多大才算内容（含等于）
 * @returns {{x:number,y:number,w:number,h:number}|null} 全透明返回 null（不给 0 尺寸盒子）
 */
export function contentBounds(rgba, w, h, minAlpha = TRIM_ALPHA_MIN) {
    const W = Math.floor(Number(w));
    const H = Math.floor(Number(h));
    if (!rgba || !(W > 0) || !(H > 0)) return null;
    if (!(rgba.length >= W * H * 4)) return null;
    const raw = Number(minAlpha);
    const thr = Number.isFinite(raw) ? Math.max(0, Math.min(255, Math.round(raw))) : TRIM_ALPHA_MIN;

    let x0 = W;
    let y0 = H;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < H; y += 1) {
        const row = y * W * 4;
        for (let x = 0; x < W; x += 1) {
            if (rgba[row + x * 4 + 3] >= thr) {
                if (x < x0) x0 = x;
                if (x > x1) x1 = x;
                if (y < y0) y0 = y;
                if (y > y1) y1 = y;
            }
        }
    }
    if (x1 < 0) return null;
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * 按包围盒裁出一块紧凑的 RGBA（长度恒为 `box.w * box.h * 4`）。
 * `box` 越界部分补透明，不抛异常。
 */
export function cropRgba(rgba, w, h, box) {
    const W = sizeOf(w, 0);
    const H = sizeOf(h, 0);
    const b = box || {};
    const bx = Math.floor(Number(b.x) || 0);
    const by = Math.floor(Number(b.y) || 0);
    const bw = Math.max(0, Math.floor(Number(b.w) || 0));
    const bh = Math.max(0, Math.floor(Number(b.h) || 0));
    const out = new Uint8ClampedArray(bw * bh * 4);
    if (!rgba || !W || !H || !bw || !bh) return out;
    for (let y = 0; y < bh; y += 1) {
        const sy = by + y;
        if (sy < 0 || sy >= H) continue;
        for (let x = 0; x < bw; x += 1) {
            const sx = bx + x;
            if (sx < 0 || sx >= W) continue;
            const si = (sy * W + sx) * 4;
            const di = (y * bw + x) * 4;
            out[di] = rgba[si];
            out[di + 1] = rgba[si + 1];
            out[di + 2] = rgba[si + 2];
            out[di + 3] = rgba[si + 3];
        }
    }
    return out;
}

/**
 * 把 `src` 放到一张 `dw × dh` 的新画布上，旧内容左上角对齐 `(ox, oy)`。
 * 落在新画布外的像素直接丢掉（不缩放、不平移回来）。
 */
export function placeRgba(src, sw, sh, dw, dh, ox, oy) {
    const SW = sizeOf(sw, 0);
    const SH = sizeOf(sh, 0);
    const DW = Math.max(0, Math.floor(Number(dw) || 0));
    const DH = Math.max(0, Math.floor(Number(dh) || 0));
    const out = new Uint8ClampedArray(DW * DH * 4);
    if (!src || !SW || !SH || !DW || !DH) return out;
    const dx0 = Math.round(Number(ox) || 0);
    const dy0 = Math.round(Number(oy) || 0);
    for (let y = 0; y < SH; y += 1) {
        const ty = y + dy0;
        if (ty < 0 || ty >= DH) continue;
        for (let x = 0; x < SW; x += 1) {
            const tx = x + dx0;
            if (tx < 0 || tx >= DW) continue;
            const si = (y * SW + x) * 4;
            const di = (ty * DW + tx) * 4;
            out[di] = src[si];
            out[di + 1] = src[si + 1];
            out[di + 2] = src[si + 2];
            out[di + 3] = src[si + 3];
        }
    }
    return out;
}

/**
 * 九宫格对齐时，旧内容放进新画布的左上角偏移。
 *
 * 新画布比旧的大 → 偏移为正（内容居中/靠边留白）；比旧的小 → 偏移为负（内容被裁掉一边）。
 * `'n'/'s'/'w'/'e'` 这种单字母只定一个轴，另一个轴居中。
 *
 * @param {'nw'|'n'|'ne'|'w'|'c'|'e'|'sw'|'s'|'se'} [align]
 * @returns {{ox:number, oy:number}}
 */
export function alignOffset(oldW, oldH, newW, newH, align) {
    const ow = sizeOf(oldW, 1);
    const oh = sizeOf(oldH, 1);
    const nw = sizeOf(newW, 1);
    const nh = sizeOf(newH, 1);
    const a = typeof align === 'string' ? align.toLowerCase() : 'c';
    let fx = 0.5;
    let fy = 0.5;
    if (a.includes('w')) fx = 0;
    else if (a.includes('e')) fx = 1;
    if (a.includes('n')) fy = 0;
    else if (a.includes('s')) fy = 1;
    const ox = Math.round((nw - ow) * fx);
    const oy = Math.round((nh - oh) * fy);
    // 归一 -0：它没有实际意义，但会污染 deepEqual 与序列化结果
    return { ox: ox === 0 ? 0 : ox, oy: oy === 0 ? 0 : oy };
}

/**
 * 校验一个新边长：必须是 1–4096 之间的数字，否则返回 null。
 * 刻意**不做夹取** —— 用户输 9999 时应该被告知超限，而不是被悄悄改成 4096。
 */
export function clampTextureSize(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    const r = Math.round(n);
    if (r < 1 || r > TEXTURE_MAX) return null;
    return r;
}
