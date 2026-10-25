// 预览播放的「速度」与「方式」——纯逻辑，零 DOM，可在 node 里直跑。
//
// 为什么单独一个模块：播放推进原本只有一句 `playAcc += dt` 加 `wrapTime()`，
// 想加「来回 / 反向循环 / 变速」时，方向与累计量的关系会散进 rAF 回调里，
// 很难测也很难读。这里把它收成 `playbackAt(acc, total, mode)`：给一个
// 单调增长的累计秒数，返回此刻应该显示的时间点。
//
// 术语：
//   acc   —— 累计播放时间（一直往前长，暂停就停住），单位秒
//   total —— 文档总时长
// 四种方式的映射：
//   cycle    循环：acc 折叠进 [0,total)
//   pingpong 来回：三角波，到末尾折回来（不需要额外记方向位）
//   reverse  反向循环：从末尾往开头走，到 0 再回到末尾（同样是一条折叠曲线）
//   once     单次：acc ≥ total 就停在末尾，并报告 done
import { LOOP_CYCLE, LOOP_PINGPONG, LOOP_NONE } from './cel.mjs';

export const LOOP_REVERSE = 'reverse';

/** 播放方式表：id 与 `doc.loopMode` 同值，icon 供时间轴按钮用。 */
export const PLAY_MODES = [
    { id: LOOP_CYCLE, label: '循环', icon: 'loop', hint: '播到末尾从头继续' },
    { id: LOOP_PINGPONG, label: '来回', icon: 'pingpong', hint: '播到末尾倒着回来，往返不停' },
    { id: LOOP_REVERSE, label: '反向循环', icon: 'loop-reverse', hint: '从末尾倒着播到开头，再回到末尾' },
    { id: LOOP_NONE, label: '单次', icon: 'play-once', hint: '播到末尾就停' },
];

export const PLAY_MODE_IDS = PLAY_MODES.map((m) => m.id);

/** 速度档位：预览要看节奏，2× 以上主要是快速过一遍，所以档位不必连续。 */
export const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4];
export const DEFAULT_SPEED = 1;
const SPEED_MIN = 0.25;
const SPEED_MAX = 4;

export function isPlayMode(id) {
    return PLAY_MODE_IDS.indexOf(id) >= 0;
}

/** 非法/越界的速度一律夹回 [0.25, 4]，NaN 退回 1。 */
export function clampSpeed(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_SPEED;
    return Math.max(SPEED_MIN, Math.min(SPEED_MAX, n));
}

/**
 * 换档：在 `SPEEDS` 里找最接近的当前档，再前后挪一格。
 * 不在表里的自定义速度（比如用户手改了 localStorage）也能就近落进表里。
 */
export function nextSpeed(cur, dir = 1) {
    const v = clampSpeed(cur);
    let i = 0;
    let best = Infinity;
    for (let k = 0; k < SPEEDS.length; k++) {
        const d = Math.abs(SPEEDS[k] - v);
        if (d < best) {
            best = d;
            i = k;
        }
    }
    const step = Number(dir) < 0 ? -1 : 1;
    const n = SPEEDS.length;
    return SPEEDS[((i + step) % n + n) % n];
}

/** 读数：1 → `1×`、0.5 → `0.5×`、1.5 → `1.5×`（不写 1.0×）。 */
export function formatSpeed(v) {
    const n = clampSpeed(v);
    const s = (Math.round(n * 100) / 100).toString();
    return s + '×';
}

/** 当前方式的名与图标；未知值按「循环」处理（旧存档只有 cycle/pingpong/none）。 */
export function modeInfo(id) {
    for (const m of PLAY_MODES) if (m.id === id) return m;
    return PLAY_MODES[0];
}

/**
 * 把单调增长的累计秒数映射成此刻的显示时间。
 * 返回 `{ t, done }`：`done` 只在 once 播到底时为 true。
 *
 * 边界都用 `>=` 判断并显式夹到 [0, total]：累计量是浮点累加，
 * 用 `t % total` 收尾会让恰好落在末尾的时间点变成 0（旧 wrapTime 的注释里记过这个坑）。
 */
export function playbackAt(acc, total, mode) {
    const span = Number(total);
    const a = Number(acc);
    if (!(span > 0) || !Number.isFinite(a)) return { t: 0, done: false };
    if (a <= 0) return { t: mode === LOOP_REVERSE ? span : 0, done: false };

    if (mode === LOOP_NONE) {
        if (a >= span) return { t: span, done: true };
        return { t: a, done: false };
    }

    if (mode === LOOP_PINGPONG) {
        const period = span * 2;
        const p = a % period;
        return { t: p <= span ? p : period - p, done: false };
    }

    if (mode === LOOP_REVERSE) {
        // 从末尾往开头走：acc=0 在末尾，acc=total 回到末尾（走完一圈）
        let m = a % span;
        if (m < 0) m += span;
        return { t: m === 0 ? span : span - m, done: false };
    }

    // cycle
    let m = a % span;
    if (m < 0) m += span;
    return { t: m, done: false };
}
