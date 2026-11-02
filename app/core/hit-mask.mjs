/**
 * 图像 alpha 掩膜：把任意可绘制源读成一张「每像素 alpha」的字节表。
 *
 * 命中测试要判断某个像素透不透明，但画布上的图像来源是混合的：
 * 手绘纹理是可读 canvas（`getContext` 直接取），导入的 PNG/PSD 图层是
 * `ImageBitmap`（没有 `getContext`）。`element.mjs` 里的 `pixelAlpha` 只认得
 * 前者，而 `ImageBitmap` 上取像素会抛错并被吞成 0 —— 于是导入的位图在画布上
 * 永远点不中。
 *
 * 这里统一成一条路径：能 `getContext` 的直接读，读不了的先画进一张临时画布
 * 再读。结果按「图像对象本身」缓存在 WeakMap 里 —— 不能用对象 id 做键，
 * id 在撤销/重做与纹理切换之间会复用，缓存会串味。
 *
 * 掩膜只存 alpha 原值，不存二值结果：阈值是调用方的语义（`hitTest` 的
 * `opts.threshold`），把阈值烧进缓存等于把它锁死在键上。
 *
 * 纯函数模块，不引入依赖；在没有 `OffscreenCanvas` 也没有 DOM 的环境里
 * 只能读裸像素与可读 canvas，其余源返回 `null` 由调用方降级。
 */

/** 以图像对象为键的掩膜缓存；值可能是 `null`（该源读不出来，不再重试） */
const CACHE = new WeakMap();

/** 构建次数与复用次数，供测试钉住缓存行为 */
let built = 0;
let reused = 0;

/**
 * 调试/测试用：看掩膜被真正构建了几次、又从缓存复用了多少次。
 * @returns {{built:number, reused:number}}
 */
export function maskStats() {
    return { built, reused };
}

/**
 * 取正整数的宽高；缺失、非数值、非正一律 null。
 * @param {*} source
 * @returns {{w:number, h:number}|null}
 */
function intSize(source) {
    if (!source || (typeof source !== 'object' && typeof source !== 'function')) return null;
    const w = Math.floor(Number(source.width));
    const h = Math.floor(Number(source.height));
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return { w, h };
}

/**
 * 裸像素源：`{ width, height, data }`，`data` 是 RGBA 字节序列。
 * @param {*} source
 * @param {number} w
 * @param {number} h
 * @returns {ArrayLike<number>|null}
 */
function rawBytes(source, w, h) {
    const data = source.data;
    if (!data || typeof data.length !== 'number') return null;
    if (data.length < w * h * 4) return null;
    return data;
}

/**
 * 拿到一个可读像素的 2D 上下文（canvas / OffscreenCanvas / 测试替身都走这里）。
 * @param {*} source
 * @returns {CanvasRenderingContext2D|null}
 */
function readable(source) {
    if (!source || typeof source.getContext !== 'function') return null;
    try {
        const ctx = source.getContext('2d', { willReadFrequently: true });
        return ctx && typeof ctx.getImageData === 'function' ? ctx : null;
    } catch (e) {
        return null;
    }
}

/**
 * 造一张临时画布，用来把不可读的源画出来再取像素。
 * @param {number} w
 * @param {number} h
 * @returns {OffscreenCanvas|HTMLCanvasElement|null}
 */
function scratch(w, h) {
    try {
        if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
    } catch (e) {
        // 落到 DOM 方案
    }
    try {
        if (typeof document !== 'undefined' && document && typeof document.createElement === 'function') {
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            return canvas;
        }
    } catch (e) {
        // 两种都没有，交给调用方降级
    }
    return null;
}

/**
 * 读出整图的 RGBA 字节。
 * @param {*} source
 * @param {number} w
 * @param {number} h
 * @returns {Uint8ClampedArray|null}
 */
function readPixels(source, w, h) {
    const ctx = readable(source);
    if (ctx) {
        try {
            const image = ctx.getImageData(0, 0, w, h);
            if (image && image.data && image.data.length >= w * h * 4) return image.data;
        } catch (e) {
            // 画布被污染或尺寸不符：继续尝试重画
        }
    }
    const target = scratch(w, h);
    if (!target) return null;
    try {
        const tctx = target.getContext('2d', { willReadFrequently: true });
        if (!tctx) return null;
        tctx.clearRect(0, 0, w, h);
        tctx.drawImage(source, 0, 0);
        const image = tctx.getImageData(0, 0, w, h);
        return image && image.data && image.data.length >= w * h * 4 ? image.data : null;
    } catch (e) {
        return null;
    }
}

/**
 * 取一张图像的 alpha 掩膜。
 *
 * 返回的 `mask[i]` 是**包围盒内**第 `i` 个像素的 alpha 原值（0~255），行优先。
 * 阈值比较留给调用方，这里只负责把像素读出来。
 *
 * **只存包围盒（C2）**：一张 900×640 的图原本常驻 576KB 的 alpha 字节；而真实素材
 * 的内容往往只占中间一小块，其余全透明。所以构建时顺手求出非透明像素的包围盒，
 * 只把 `[x0, y0, bw, bh]` 这一块存进缓存 —— 典型角色贴图能省一个数量级，命中语义完全不变
 * （包围盒外的像素 alpha 一律 0，由 `maskAlphaAt` 回答）。
 * 全透明的图存成 `bw=bh=0` 的空掩膜（仍然非 null：它表示「读得出来，但处处透明」，
 * 不能让它走 `hitTest` 的「读不出来 → 矩形命中」降级）。
 *
 * @param {*} source canvas / OffscreenCanvas / ImageBitmap / `{width,height,data}` / 任意可绘制源
 * @returns {{w:number,h:number,x0:number,y0:number,bw:number,bh:number,mask:Uint8Array}|null}
 *   `w/h` 是**原图**尺寸（调用方按它夹取坐标），`mask` 只覆盖 `[x0,x0+bw)×[y0,y0+bh)`
 */
export function alphaMaskOf(source) {
    const size = intSize(source);
    const key = size ? source : null;
    if (key && CACHE.has(key)) {
        reused += 1;
        return CACHE.get(key);
    }

    let record = null;
    if (size) {
        const bytes = rawBytes(source, size.w, size.h) || readPixels(source, size.w, size.h);
        if (bytes) {
            record = buildCropped(size.w, size.h, bytes);
            built += 1;
        }
    }

    // 失败也缓存：坏源不必每帧重试一次 drawImage。
    if (key) CACHE.set(key, record);
    return record;
}

/**
 * 从整图 RGBA 字节里求非零 alpha 的包围盒，并只拷出那一块。
 *
 * 单趟扫描求边界，第二趟只分配 `bw*bh`（而不是 `w*h`）并拷 alpha。全透明时
 * 返回空的 `mask` 且 `bw=bh=0`。
 *
 * @param {number} w
 * @param {number} h
 * @param {ArrayLike<number>} bytes RGBA，长度 ≥ w*h*4
 * @returns {{w:number,h:number,x0:number,y0:number,bw:number,bh:number,mask:Uint8Array}}
 */
export function buildCropped(w, h, bytes) {
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < h; y += 1) {
        const row = y * w;
        for (let x = 0; x < w; x += 1) {
            if (bytes[(row + x) * 4 + 3] === 0) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
    }
    if (maxX < minX || maxY < minY) {
        return { w, h, x0: 0, y0: 0, bw: 0, bh: 0, mask: new Uint8Array(0) };
    }
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const mask = new Uint8Array(bw * bh);
    for (let y = 0; y < bh; y += 1) {
        const srcRow = (minY + y) * w + minX;
        const dstRow = y * bw;
        for (let x = 0; x < bw; x += 1) mask[dstRow + x] = bytes[(srcRow + x) * 4 + 3];
    }
    return { w, h, x0: minX, y0: minY, bw, bh, mask };
}

/**
 * 掩膜里 `(x, y)` 那个像素的 alpha 原值（包围盒外一律 0）。
 *
 * 为什么要有这个函数：掩膜现在是**裁剪过**的，`mask[y * w + x]` 的下标会错位。
 * 所有读掩膜的地方都必须走这里；直接按下标取是 C2 之后最容易复发的错。
 *
 * @param {object|null} record `alphaMaskOf` 的返回值
 * @param {number} x 原图像素坐标
 * @param {number} y 原图像素坐标
 * @returns {number} 0~255；越界或坏记录返回 0
 */
export function maskAlphaAt(record, x, y) {
    if (!record || !record.bw || !record.bh) return 0;
    const bx = Math.floor(Number(x)) - record.x0;
    const by = Math.floor(Number(y)) - record.y0;
    if (!(bx >= 0 && by >= 0 && bx < record.bw && by < record.bh)) return 0;
    return record.mask[by * record.bw + bx];
}
