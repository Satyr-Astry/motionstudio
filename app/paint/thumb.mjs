/** Kleks Motion —— 缩略图（图层面板 / 时间轴共用） */

import { imageAt } from '../core/cel.mjs';

export function thumbFrom(image, w, h, bg) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, w | 0);
    c.height = Math.max(1, h | 0);
    const g = c.getContext('2d');
    if (!g) return c;
    if (bg) {
        g.fillStyle = bg;
        g.fillRect(0, 0, c.width, c.height);
    }
    if (image && image.width && image.height) {
        const s = Math.min(c.width / image.width, c.height / image.height);
        const dw = image.width * s;
        const dh = image.height * s;
        g.imageSmoothingEnabled = s < 1;
        g.drawImage(image, (c.width - dw) / 2, (c.height - dh) / 2, dw, dh);
    }
    return c;
}

/** 时间 t 上该对象的缩略图：先按时间取位图，再交给 thumbFrom。 */
export function thumbAt(obj, t, w, h, bg) {
    return thumbFrom(imageAt(obj, t), w, h, bg);
}

/** 一次性算好「这张图里是否有像素」，避免面板里逐点 getImageData。 */
export function hasAnyInk(image) {
    if (!image) return false;
    const g = image.getContext('2d');
    if (!g) return false;
    const { width, height } = image;
    const step = Math.max(1, Math.floor(Math.min(width, height) / 48));
    const data = g.getImageData(0, 0, width, height).data;
    for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
            if (data[(y * width + x) * 4 + 3] > 8) return true;
        }
    }
    return false;
}
