/**
 * Kleks Motion —— 位图容器
 *
 * 一个 cel 的像素放在一张 canvas 上（浏览器里用 OffscreenCanvas 省 DOM 开销）。
 * 这里只做创建 / 克隆 / 清空，不含任何绘制逻辑。
 */

function makeCanvas(w, h) {
    if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
}

export function createSurface(w, h) {
    const W = Math.max(1, Math.round(w || 1));
    const H = Math.max(1, Math.round(h || 1));
    return makeCanvas(W, H);
}

/** 深拷贝像素（切帧时 Kleks 的旧坑：同一张画布被反复复用）。 */
export function cloneSurface(src) {
    if (!src) return null;
    const dst = createSurface(src.width, src.height);
    const g = dst.getContext('2d');
    if (g) {
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.clearRect(0, 0, dst.width, dst.height);
        g.drawImage(src, 0, 0);
    }
    return dst;
}

export function clearSurface(surface) {
    if (!surface) return false;
    const g = surface.getContext('2d');
    if (!g) return false;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, surface.width, surface.height);
    return true;
}

/** 尺寸不符就重建（改了项目尺寸后统一走这里）。 */
export function fitSurface(surface, w, h) {
    const W = Math.max(1, Math.round(w || 1));
    const H = Math.max(1, Math.round(h || 1));
    if (surface && surface.width === W && surface.height === H) return surface;
    return createSurface(W, H);
}

/** 是否整张透明（判断「这层是空的」用，比逐像素读快很多：先抽样）。 */
export function isSurfaceEmpty(surface) {
    if (!surface) return true;
    const g = surface.getContext('2d');
    if (!g) return true;
    const { width, height } = surface;
    const step = Math.max(1, Math.floor(Math.min(width, height) / 64));
    for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
            const d = g.getImageData(x, y, 1, 1).data;
            if (d[3] > 4) return false;
        }
    }
    return true;
}
