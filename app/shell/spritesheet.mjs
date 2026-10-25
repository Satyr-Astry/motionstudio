/**
 * MotionStudio —— 精灵图（spritesheet）导出
 *
 * 契约 v6：文档里没有帧对象了，只有「对象 + 纹理」（`obj.cels = [{at, image}]`）和
 * `docDuration(doc)` 给的总时长。所以这里不再按帧号取时间，而是按**采样时间点**合成：
 * 每格用自己的秒数 t 走同一条渲染路径（paint/composite.mjs 的 compositeEvaluated），
 * 屏幕上看到的某一时刻与大图里的某一格必然一致。
 *
 * 采样点来源（优先级从高到低）：
 *   1. `o.times`：调用方明确给出（导出序列 / 自定义节奏）；
 *   2. `o.time`：老的单点预览用法，等价 `times: [t]`；
 *   3. `sampleTimes(doc, step)`：等间隔网格，`step` 缺省 `1 / (doc.fps || 12)`。
 *
 * 为什么单独一个模块：app/shell/app.mjs 负责接线（ctx / window.motionStudio），
 * 这里只做纯计算 + 合成，不依赖外壳状态，也不写文件 —— 落盘由 ipc.mjs 的
 * exportSheet 通道交给主进程（png 与 json 各一份）。
 *
 * 帧表 JSON（契约 v6 §7）：对外仍叫 `frames`（引擎侧不用改），但每项的时间字段是秒：
 *   { format:'motionstudio-spritesheet', version:1,
 *     width, height, columns, rows, cellWidth, cellHeight, gap,
 *     sampleRate, duration,
 *     frames:[{ index, x, y, w, h, t, duration }] }
 *   sampleRate = 每秒采样数（1 / step），duration = 文档总时长（秒）。
 */

import { compositeEvaluated } from '../paint/composite.mjs';
import { createEvaluator } from '../core/evaluator.mjs';
import { docDuration, sampleTimes } from '../core/doc-model.mjs';

export const SHEET_FORMAT = 'motionstudio-spritesheet';
export const SHEET_VERSION = 1;

/** 生产环境的画布工厂：优先 document（有 toDataURL），退 OffscreenCanvas。 */
function defaultCanvas(w, h) {
    try {
        if (typeof document !== 'undefined' && document && typeof document.createElement === 'function') {
            const cv = document.createElement('canvas');
            cv.width = w;
            cv.height = h;
            return cv;
        }
    } catch (err) {
        /* 继续试下一个 */
    }
    try {
        if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(w, h);
    } catch (err) {
        /* 没有画布环境 */
    }
    return null;
}

function intIn(v, fallback) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function round4(n) {
    const x = Number(n);
    return Number.isFinite(x) ? Math.round(x * 10000) / 10000 : 0;
}

function round6(n) {
    const x = Number(n);
    return Number.isFinite(x) ? Math.round(x * 1000000) / 1000000 : 0;
}

/**
 * 采样步长（秒）：`o.step` 优先；显式 `times` 时用最后一个间隔（保住调用方自己的节奏）；
 * 否则 `1 / doc.fps`（缺省 12fps）。只用于「最后一格的 duration」与 sampleRate。
 */
function stepOf(doc, o, times) {
    const n = Number(o.step);
    if (Number.isFinite(n) && n > 0) return n;
    if (Array.isArray(o.times) && times.length >= 2) {
        const gap = times[times.length - 1] - times[times.length - 2];
        if (gap > 0) return gap;
    }
    const fps = Number(doc && doc.fps);
    return 1 / (Number.isFinite(fps) && fps > 0 ? fps : 12);
}

/**
 * 采样时间点（秒，升序去重）。
 *
 * @param {object} doc
 * @param {{times?:number[], time?:number, step?:number}} [opts]
 * @returns {number[]} 空数组表示「没有任何可导出的时刻」（整图为空）
 */
export function sheetTimes(doc, opts) {
    const o = opts || {};
    if (Array.isArray(o.times)) {
        const seen = new Set();
        for (const raw of o.times) {
            const t = Number(raw);
            if (!Number.isFinite(t) || t < 0) continue;
            seen.add(round6(t));
        }
        return Array.from(seen).sort((a, b) => a - b);
    }
    const single = Number(o.time);
    if (Number.isFinite(single) && single >= 0) return [round6(single)];
    return sampleTimes(doc, stepOf(doc, o, []));
}

/**
 * 纯计算：帧表与整图尺寸（不建画布，单测/预览都能用）。
 *
 * @param {object} doc
 * @param {{columns?:number, gap?:number, times?:number[], step?:number, time?:number}} [opts]
 *   columns 缺省 = 采样点数（单行横排）；超过会被夹回采样点数，最小 1。
 * @returns {{width:number,height:number,columns:number,rows:number,
 *            cellWidth:number,cellHeight:number,gap:number,step:number,
 *            sampleRate:number,duration:number,times:number[],
 *            frames:Array<{index:number,x:number,y:number,w:number,h:number,t:number,duration:number}>}}
 */
export function sheetLayout(doc, opts) {
    const o = opts || {};
    const times = sheetTimes(doc, o);
    const count = times.length;
    const cellWidth = intIn(doc && doc.width, 1);
    const cellHeight = intIn(doc && doc.height, 1);
    const gap = Math.max(0, Math.round(Number(o.gap) || 0));
    const columns = Math.min(Math.max(1, intIn(o.columns, count || 1)), Math.max(1, count || 1));
    const rows = Math.max(1, Math.ceil(count / columns));
    const width = Math.max(1, columns * cellWidth + gap * Math.max(0, columns - 1));
    const height = Math.max(1, rows * cellHeight + gap * Math.max(0, rows - 1));
    const step = stepOf(doc, o, times);
    const frames = times.map((t, i) => {
        // 该格「演多久」= 到下一个采样点的间隔；最后一格用 step 兜底
        const next = i + 1 < count ? times[i + 1] : t + step;
        return {
            index: i,
            x: (i % columns) * (cellWidth + gap),
            y: Math.floor(i / columns) * (cellHeight + gap),
            w: cellWidth,
            h: cellHeight,
            t: round4(t),
            duration: round4(next - t) || round4(step),
        };
    });
    return {
        width: width,
        height: height,
        columns: columns,
        rows: rows,
        cellWidth: cellWidth,
        cellHeight: cellHeight,
        gap: gap,
        step: round6(step),
        sampleRate: round4(1 / step),
        duration: round4(docDuration(doc)),
        times: times,
        frames: frames,
    };
}

/** 帧表 JSON（`frames` 键保留给引擎，时间字段是秒的 `t`，顶层补 sampleRate / duration）。 */
export function sheetJSON(sheet) {
    if (!sheet) return null;
    return {
        format: SHEET_FORMAT,
        version: SHEET_VERSION,
        width: sheet.width,
        height: sheet.height,
        columns: sheet.columns,
        rows: sheet.rows,
        cellWidth: sheet.cellWidth,
        cellHeight: sheet.cellHeight,
        gap: sheet.gap,
        sampleRate: round4(sheet.sampleRate),
        duration: round4(sheet.duration),
        frames: (sheet.frames || []).map((f) => ({
            index: f.index,
            x: f.x,
            y: f.y,
            w: f.w,
            h: f.h,
            t: round4(f.t),
            duration: round4(f.duration),
        })),
    };
}

/**
 * 合成精灵图。
 *
 * @param {object} doc
 * @param {{columns?:number, gap?:number, times?:number[], step?:number, time?:number,
 *          background?:string, createCanvas?:(w:number,h:number)=>any}} [opts]
 *   times 优先（没有就 sampleTimes(doc, step)）；每格按自己的采样时间 t 合成。
 *   background 给了就先铺一层纯色（PNG 是透明底，需要白底时用）。
 *   createCanvas 供单测注入；生产缺省走 document / OffscreenCanvas。
 * @returns {{canvas:any,width:number,height:number,columns:number,rows:number,
 *            cellWidth:number,cellHeight:number,gap:number,sampleRate:number,
 *            duration:number,times:number[],frames:Array<object>,json:object}|null}
 */
export function buildSpritesheet(doc, opts) {
    const o = opts || {};
    const layout = sheetLayout(doc, o);
    if (!layout.frames.length) return null;
    const create = typeof o.createCanvas === 'function' ? o.createCanvas : defaultCanvas;
    const canvas = create(layout.width, layout.height);
    if (!canvas) return null;
    const g = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
    if (!g) return null;

    // 整图先清底：合成函数会把 target 尺寸改写为文档尺寸，所以每格单独一张画布，最后贴过来。
    try {
        g.setTransform(1, 0, 0, 1, 0, 0);
    } catch (err) {
        /* 替身画布可能没有这个 API */
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    if (typeof g.clearRect === 'function') g.clearRect(0, 0, layout.width, layout.height);
    if (typeof o.background === 'string' && o.background && typeof g.fillRect === 'function') {
        g.fillStyle = o.background;
        g.fillRect(0, 0, layout.width, layout.height);
        g.fillStyle = '#000000';
    }

    const cell = create(layout.cellWidth, layout.cellHeight);
    const cellCtx = cell && typeof cell.getContext === 'function' ? cell.getContext('2d') : null;
    if (!cell || !cellCtx) return null;

    // 与画布 / 序列导出走同一条求值路径（含时间通道与父链世界矩阵）。
    // 不复用求值器缓存：精灵图是一次性批处理，缓存只会白占内存。
    const ev = createEvaluator(doc, { cache: false });

    for (const item of layout.frames) {
        // 第 3 个参数就是秒；纹理沿用规则由求值器与 doc-model 负责
        compositeEvaluated(cell, ev, item.t, { clear: true });
        try {
            g.drawImage(cell, item.x, item.y);
        } catch (err) {
            /* 单格贴失败不该毁掉整张图 */
        }
    }

    const sheet = {
        canvas: canvas,
        width: layout.width,
        height: layout.height,
        columns: layout.columns,
        rows: layout.rows,
        cellWidth: layout.cellWidth,
        cellHeight: layout.cellHeight,
        gap: layout.gap,
        sampleRate: layout.sampleRate,
        duration: layout.duration,
        times: layout.times,
        frames: layout.frames,
    };
    sheet.json = sheetJSON(sheet);
    return sheet;
}

/** 大图 → dataURL（同步；OffscreenCanvas 没有 toDataURL 时返回 null，请用下面的异步版）。 */
export function sheetToDataURL(sheet, type) {
    const cv = sheet && sheet.canvas;
    if (!cv || typeof cv.toDataURL !== 'function') return null;
    try {
        return cv.toDataURL(type || 'image/png');
    } catch (err) {
        return null;
    }
}

/**
 * 大图 → dataURL（异步兜底）：document canvas 直接 toDataURL；
 * OffscreenCanvas 只能 convertToBlob，再用 FileReader 转回来。
 */
export async function sheetToDataURLAsync(sheet, type) {
    const mime = type || 'image/png';
    const sync = sheetToDataURL(sheet, mime);
    if (sync) return sync;
    const cv = sheet && sheet.canvas;
    if (!cv || typeof cv.convertToBlob !== 'function') return null;
    try {
        const blob = await cv.convertToBlob({ type: mime });
        if (!blob) return null;
        if (typeof FileReader !== 'function') return null;
        return await new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
        });
    } catch (err) {
        return null;
    }
}
