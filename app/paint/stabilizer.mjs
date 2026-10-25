/**
 * 画板笔迹稳定器（stabilizer）—— 纯函数、零 DOM，node 可直接 import。
 *
 * 算法：一阶指数平滑（低通滤波）+ 最小移动阈值。
 *
 *     yₙ = yₙ₋₁ + (xₙ - yₙ₋₁) · α
 *
 * α = 1 时输出恒等于输入（level 0，完全直通）；α 越小，笔尖跟随越慢、越"黏"。
 * 稳态匀速拖动的滞后量（以采样事件计）= (1 - α) / α。
 *
 * 档位 → 系数（与 Klecks 的 smoothing 语义对齐：它的滞后事件数 = s / (1 - s)）：
 *
 * | level | Klecks 档位 / smoothing | α    | 我们的稳态滞后 | Klecks 滞后 |
 * |-------|-------------------------|------|----------------|-------------|
 * | 0     | 0（直通）               | 1.00 | 0 事件         | 0           |
 * | 1     | 0.5 / s=0.30            | 0.60 | 0.67 事件      | 0.43        |
 * | 2     | 1.0 / s=0.60            | 0.40 | 1.50 事件      | 1.50        |
 * | 3     | 1.5 / s=0.70            | 0.25 | 3.00 事件      | 2.33        |
 * | 4     | 2.0 / s=0.84            | 0.14 | 6.14 事件      | 5.25        |
 * | 5     | 3.0 / legacy s≈0.965    | 0.07 | 13.3 事件      | 27.6        |
 *
 * 证据：`E:\dev\klecks\src\app\script\klecks\events\hybrid-line-smoothing.ts:19-52`
 * （level 0/0.5/1/1.5/2 → LineSmoothing 的 smoothing 值；3/4/5 → LegacyLineSmoothing 的
 * 1-0.035 / 1-0.0175 / 1-0.00875），以及 `line-smoothing.ts:5`
 * 「Lag on a straight line = smoothing / (1 - smoothing) events」。
 *
 * 差异（有意为之）：Klecks 是单事件多次采样的 4 级串联滤波器（`passes: 4`，
 * `addedPoints: 6`），我们是单级、按 pointermove 事件采样——因为画板落笔自带
 * 间距插值（`spacingPx()` + carry），中间点由落笔那一侧补，稳定器只负责"往哪走"。
 * 因此 level 5 的滞后比 Klecks 同级短一半多：再慢就会明显跟不上手。
 */

/** 默认档位：0 = 直通（不改变既有手感）。 */
export const DEFAULT_LEVEL = 0;

/** 最高档位。 */
export const MAX_LEVEL = 5;

/**
 * 最小移动阈值（像素，纹理坐标系）：平滑后的点与"上一个真正落笔的点"距离小于它时，
 * 这一段不落笔——亚像素抖动就不会在笔迹上留下毛刺。level 0 不启用（必须严格直通）。
 */
export const MIN_STEP = 0.75;

/** 档位 → 平滑系数 α。索引即档位。 */
export const LEVEL_ALPHA = Object.freeze([1, 0.6, 0.4, 0.25, 0.14, 0.07]);

/**
 * 把任意输入收进 0–5 的整数档位。非数字 / 越界 / NaN 都回落，不抛。
 *
 * @param {unknown} n
 * @returns {number} 0–5
 */
export function clampLevel(n) {
    const v = Number(n);
    if (!Number.isFinite(v)) return DEFAULT_LEVEL;
    const r = Math.round(v);
    if (r < 0) return 0;
    if (r > MAX_LEVEL) return MAX_LEVEL;
    return r;
}

/**
 * 档位 → α（非法档位按 clampLevel 收口后再取）。
 *
 * @param {number} level
 * @returns {number} (0, 1]
 */
export function alphaFor(level) {
    return LEVEL_ALPHA[clampLevel(level)];
}

/**
 * 创建一个稳定器实例。一次笔画一个实例（pointerdown 建、pointerup 关）。
 *
 * `push` 返回：
 * - `x, y`    ：平滑后的坐标（该落笔就用它）
 * - `moved`   ：这一步是否该落笔（false = 没跨过阈值，跳过）
 * - `target`  ：本步的原始输入坐标（松手时用它把线尾追平，别让笔画停在滞后的位置）
 *
 * @param {number} [level] 0–5
 */
export function createStabilizer(level) {
    let lv = clampLevel(level == null ? DEFAULT_LEVEL : level);
    let has = false;
    let sx = 0;
    let sy = 0;
    let ex = 0;   // 上一个真正输出的点
    let ey = 0;

    return {
        get level() {
            return lv;
        },

        /**
         * 喂一个原始采样点，拿一个该落笔的点。
         *
         * @param {number} x
         * @param {number} y
         * @returns {{ x: number, y: number, moved: boolean, target: { x: number, y: number } }}
         */
        push(x, y) {
            const target = { x, y };
            // level 0：严格直通，连阈值都不参与（输出必须逐位等于输入）
            if (lv === 0) {
                has = true;
                sx = x;
                sy = y;
                ex = x;
                ey = y;
                return { x, y, moved: true, target };
            }
            const a = LEVEL_ALPHA[lv];
            if (!has) {
                // 起笔不滞后：第一个点就是笔尖落点，否则笔画开头会被"拽"回来
                has = true;
                sx = x;
                sy = y;
                ex = x;
                ey = y;
                return { x, y, moved: true, target };
            }
            sx += (x - sx) * a;
            sy += (y - sy) * a;
            if (Math.hypot(sx - ex, sy - ey) < MIN_STEP) {
                // 没跨过阈值：不落笔，也别把 ex/ey 往前挪，否则阈值会被一点点吃掉
                return { x: ex, y: ey, moved: false, target };
            }
            ex = sx;
            ey = sy;
            return { x: sx, y: sy, moved: true, target };
        },

        /** 清掉滤波状态与阈值状态（下一次 push 当作起笔）。 */
        reset() {
            has = false;
            sx = 0;
            sy = 0;
            ex = 0;
            ey = 0;
        },

        /** 中途改档：保留当前位置，只换系数（Klecks 的 setSettings 也是这个语义）。 */
        setLevel(next) {
            lv = clampLevel(next);
            return lv;
        },
    };
}
