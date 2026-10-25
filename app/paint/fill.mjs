/**
 * 画板油漆桶（洪水填充）—— 纯函数、零 DOM，node 可直接 import。
 *
 * 只做一件事：给一块 RGBA 像素数组，从 (sx, sy) 起把「颜色相近且连通」的区域刷成目标色。
 * 不碰 canvas、不碰文档、不碰撤销栈 —— 取 ImageData、putImageData、pushCommand 都由调用方负责。
 * 这样切纹理/换纹理的时序问题全部留在调用方那一个同步块里（board.mjs 的 doFill）。
 *
 * 语义与既有实现对齐（`app/paint/engine.mjs:598-657` 的 floodFill）：
 *
 * 1. 四邻域（不取对角 —— 对角会让细线边界"漏"过去，与主流绘图软件一致）。
 * 2. 容差默认 24：逐通道比 |data[i+k] - target[k]| <= tol，四通道都比（含 alpha）。
 * 3. **双方 alpha 都是 0 时直接算匹配**：全透明像素的 RGB 是垃圾值（可能是上一次绘制留下的
 *    残色），拿它做容差比较会让"透明区域"被切成很多互不连通的碎片，填一次只填一小块。
 * 4. 填完的像素 alpha 一律写 255（填色是实心的，不保留原来的半透明）。
 * 5. 起点越界、起点已经是目标色、区域为空 —— 都返回 changed: false，调用方据此不产生撤销命令。
 *
 * 与 engine 版的差异（有意为之）：
 * - 不在这里取 ImageData / 不建撤销命令（engine 版是闭包函数，依赖 activeCel()/docSize()/history，
 *   画板用的是自己的私有相机与纹理，没有那套上下文）。
 * - 返回 { changed, painted }：painted 是实际改写的像素数，给单测和耗时归因用。
 * - 参数非法（尺寸非正整数、data 长度不够）→ 静默返回 changed: false，不抛：这函数在 pointerdown
 *   的同步路径上，抛出去会让整个画板手势卡死，而"填不了"本来就是合法结局。
 */

/** 默认容差（每通道绝对值上限）。 */
export const DEFAULT_TOLERANCE = 24;

/** 目标色解析失败时的回落色（与 engine.mjs:615-618 一致：坏 hex 当黑色）。 */
const FALLBACK_HEX = '#000000';

const EMPTY = Object.freeze({ changed: false, painted: 0 });

/**
 * 解析 `#rrggbb` / `rrggbb`（大小写、无 # 都接受），失败回落黑色。
 *
 * @param {unknown} hex
 * @returns {[number, number, number, number]} [r, g, b, 255]
 */
export function parseHex(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex == null ? '' : hex).trim());
    const src = m ? m[1] : FALLBACK_HEX.slice(1);
    return [
        parseInt(src.slice(0, 2), 16),
        parseInt(src.slice(2, 4), 16),
        parseInt(src.slice(4, 6), 16),
        255,
    ];
}

/**
 * 洪水填充一块 RGBA 像素数据（原地改写 data）。
 *
 * @param {Uint8ClampedArray|Uint8Array|number[]} data 长度必须 >= w*h*4，RGBA 顺序
 * @param {number} w 宽（像素）
 * @param {number} h 高（像素）
 * @param {number} sx 起点 x（可带小数，向下取整）
 * @param {number} sy 起点 y（可带小数，向下取整）
 * @param {string} hex 目标色 `#rrggbb`
 * @param {number} [tolerance] 每通道容差，默认 {@link DEFAULT_TOLERANCE}
 * @returns {{ changed: boolean, painted: number }} painted = 实际改写的像素数
 */
export function floodFillRegion(data, w, h, sx, sy, hex, tolerance) {
    const W = Math.floor(Number(w));
    const H = Math.floor(Number(h));
    if (!data || !Number.isFinite(W) || !Number.isFinite(H) || W <= 0 || H <= 0) return EMPTY;
    if (data.length < W * H * 4) return EMPTY;

    const px = Math.floor(Number(sx));
    const py = Math.floor(Number(sy));
    if (!Number.isFinite(px) || !Number.isFinite(py)) return EMPTY;
    if (px < 0 || py < 0 || px >= W || py >= H) return EMPTY;

    const tolRaw = Number(tolerance);
    const tol = tolerance == null || !Number.isFinite(tolRaw) || tolRaw < 0 ? DEFAULT_TOLERANCE : tolRaw;

    const nc = parseHex(hex);
    const start = (py * W + px) * 4;
    const t0 = data[start];
    const t1 = data[start + 1];
    const t2 = data[start + 2];
    const t3 = data[start + 3];

    // 起点已经是目标色：什么都不用做（也不该产生一条空的撤销命令）
    if (t0 === nc[0] && t1 === nc[1] && t2 === nc[2] && t3 === nc[3]) return EMPTY;

    const bothClear = t3 === 0;
    const match = (i) => {
        const a = data[i + 3];
        if (bothClear && a === 0) return true;
        return (
            Math.abs(data[i] - t0) <= tol &&
            Math.abs(data[i + 1] - t1) <= tol &&
            Math.abs(data[i + 2] - t2) <= tol &&
            Math.abs(a - t3) <= tol
        );
    };

    const seen = new Uint8Array(W * H);
    const stack = [px, py];
    let painted = 0;
    while (stack.length) {
        const cy = stack.pop();
        const cx = stack.pop();
        if (cx < 0 || cy < 0 || cx >= W || cy >= H) continue;
        const flat = cy * W + cx;
        if (seen[flat]) continue;
        seen[flat] = 1;
        const i = flat * 4;
        if (!match(i)) continue;
        data[i] = nc[0];
        data[i + 1] = nc[1];
        data[i + 2] = nc[2];
        data[i + 3] = 255;
        painted += 1;
        stack.push(cx + 1, cy, cx - 1, cy, cx, cy + 1, cx, cy - 1);
    }

    if (!painted) return EMPTY;
    return { changed: true, painted };
}
