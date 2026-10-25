/**
 * MotionStudio —— 播放刷新分级（纯决策）
 *
 * 播放时外壳每秒会排 30 次左右的刷新（`doc-state.mjs` 的 `scheduleRefresh`）。
 * 每次都要问一个问题：**这一轮该刷哪些面板**。把它抽到这里，是为了能在 node 里
 * 直接测这些判断，而不必去 mock DOM 与整个外壳。
 *
 * 分级只有两档（与 `refreshPanels(withFocus, full)` 的 `full` 对应）：
 *   · full  —— 文档变了（setDoc / 撤销 / 换项目 / 切工作区 / 播放停下之后的补刷）。全刷。
 *   · time  —— 只有时间在走（播放、拖播放头、逐帧）。只刷「跟时间走」的面板。
 *
 * 判据是**这个编辑器读不读 `ctx.time()`**，逐个模块取证（见 docs/播放刷新-2026-10.md §2）：
 *   · canvas  —— 舞台合成走 imageAt(obj, time)；叠加层 handlePoints 也吃 info.time
 *   · board   —— 画板编辑的纹理 = imageAt(obj, time)，切纹理就换图
 *   · timeline—— 播放头位置、当前帧高亮、读数
 *   · curve   —— 播放头竖线、当前值的圆点
 *   · properties —— 变换/效果的数值框显示的是 stateAt(track, time)
 * 其余编辑器（调色 / 工具 / 帮助 / 项目库 / 文档 / 洋葱皮 / 信息 / 偏好）只跟文档或
 * 本机偏好有关，播放期间一动不动；它们的内容靠「停下时补一次全量」兜底。
 *
 * layers 是特例：它的缩略图是「当前生效纹理」的图，**只随纹理切换变**，
 * 不随纹理内部的连续时间变。40 个对象时它是播放期间最贵的一项
 * （实测 1.98ms/次、每秒 30 次 ≈ 60ms），按纹理粒度刷能砍掉大半而肉眼无差。
 */

import { celTimes } from '../core/cel.mjs';

/** 显示内容直接由 state.time 求值 —— 时间档必须刷。 */
export const TIME_DRIVEN_EDITORS = new Set(['canvas', 'board', 'timeline', 'curve', 'properties']);

/** 只按「纹理切换」变化 —— 时间档里仅当纹理变了才刷。 */
export const CEL_GRANULAR_EDITORS = new Set(['layers']);

/**
 * 一轮刷新的决策。
 *
 * @param {string[]} editors 当前工作区里的编辑器 id（顺序无关，重复无意义）
 * @param {{full?: boolean, celChanged?: boolean}} [opts]
 *        full:false 表示时间档；celChanged 表示「当前生效纹理变了」
 * @returns {{run: string[], skip: string[]}} run 是要刷的，skip 是这轮放过的
 */
export function planRefresh(editors, opts) {
    const o = opts || {};
    const full = o.full !== false;
    const celChanged = o.celChanged === true;
    const run = [];
    const skip = [];
    const list = Array.isArray(editors) ? editors : [];
    for (const raw of list) {
        // 编辑器 id 一定是字符串；数字/对象说明调用方给错了，静默转字符串只会刷错面板
        if (typeof raw !== 'string' || !raw) continue;
        const id = raw;
        if (full || TIME_DRIVEN_EDITORS.has(id) || (celChanged && CEL_GRANULAR_EDITORS.has(id))) {
            run.push(id);
        } else {
            skip.push(id);
        }
    }
    return { run, skip };
}

/**
 * 「当前生效纹理」的签名：变了就说明缩略图/纹理行需要重画。
 *
 * 逐对象各自算所在的纹理下标 —— 不同对象的纹理表可以不同（长度、分段帧率都独立），
 * 只盯活动对象会在「别的对象换了纹理」时漏刷新。
 *
 * @param {Array} objects 文档对象列表
 * @param {number} time 当前时间（秒）
 * @returns {string} 稳定签名（不可解析，只用于比较）
 */
export function celSignature(objects, time) {
    const list = Array.isArray(objects) ? objects : [];
    const t = Number(time);
    const at = Number.isFinite(t) ? t : 0;
    let out = String(list.length);
    for (const obj of list) {
        const times = celTimes(obj);
        let idx = -1;
        for (let i = 0; i < times.length; i++) {
            if (times[i] <= at + 1e-9) idx = i;
            else break;
        }
        out += ',' + idx;
    }
    return out;
}
