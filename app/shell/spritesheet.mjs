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
// 导入链路已经在用的包围盒扫描 —— trim 复用同一份实现，不另写一套。
// 它只吃 RGBA 缓冲、不碰 DOM，所以 shell 层直接引没问题。
import { alphaBounds } from './import-file.mjs';

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
    // 格尺寸缺省用文档尺寸；trim 时调用方会传「所有帧内容盒的最大宽高」，
    // 这样图集能真的变小（否则只把内容挪到格左上角、总字节数几乎不变）。
    const cellWidth = intIn(o.cellWidth, intIn(doc && doc.width, 1));
    const cellHeight = intIn(o.cellHeight, intIn(doc && doc.height, 1));
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
        // 分张清单：与磁盘上的文件一一对应（单张时就是一项）。
        // 消费方要按它逐个加载 —— 分张之后「一张图集」变成了「一组图集」。
        sheets: (sheet.sheets && sheet.sheets.length
            ? sheet.sheets
            : [{ file: 'sheet-1.png', width: sheet.width, height: sheet.height }]
        ).map((s) => ({ file: s.file, width: s.width, height: s.height })),
        frames: (sheet.frames || []).map((f) => ({
            index: f.index,
            x: f.x,
            y: f.y,
            w: f.w,
            h: f.h,
            t: round4(f.t),
            duration: round4(f.duration),
            // 内容在原帧坐标系里的位置（缺省 = 整格没裁，等价旧帧表）。
            // 约定：`sx/sy` 是内容相对**原始帧左上角**的偏移、`sw/sh` 是内容尺寸；
            // `x/y/w/h` 始终是「格在图集里的位置」。两套坐标不混。
            sx: f.sx == null ? 0 : f.sx,
            sy: f.sy == null ? 0 : f.sy,
            sw: f.sw == null ? f.w : f.sw,
            sh: f.sh == null ? f.h : f.sh,
            trimmed: !!f.trimmed,
        })),
    };
}

/**
 * 把单张布局切成多张图集，每张边长不超过 `maxTextureSize`。
 *
 * 为什么需要它：200 帧 1024² 的单张图集是 20480×20480，早超了 Chromium 的纹理上限，
 * `toDataURL` 直接返回空白 —— **必须预检，不能等失败再报「没有可导出的帧」**。
 *
 * 切法是「先算每张能放几行几列，再按帧顺序连续切」：同一张里的帧在时间上连续，
 * 消费方按 `sheets[]` 顺序播就是对的。
 *
 * 有一种情况分张救不了：**单帧本身就比上限还大** —— 那是「上限太小或缩放没调」，
 * 明确报错，绝不静默产出一张超限图让消费方崩。
 *
 * @param {object} layout `sheetLayout()` 的返回值
 * @param {number} maxTextureSize 单张边长上限（像素）
 * @returns {{ok:boolean, reason:string, sheets:Array<object>}}
 */
export function splitSheetLayout(layout, maxTextureSize) {
    const failed = (reason) => ({ ok: false, reason: reason, sheets: [] });
    if (!layout || !Array.isArray(layout.frames) || !layout.frames.length) {
        return failed('没有可导出的帧');
    }
    const max = Math.max(1, Math.round(Number(maxTextureSize) || 4096));
    const cw = Math.max(1, layout.cellWidth || 1);
    const ch = Math.max(1, layout.cellHeight || 1);
    const gap = Math.max(0, layout.gap || 0);

    if (cw > max || ch > max) {
        return failed('单帧 ' + Math.max(cw, ch) + 'px 超过图集上限 ' + max + 'px，请调大上限或缩小缩放');
    }

    // 不超限：原样返回一张（兼容旧行为，帧数组都不重排）。
    if (layout.width <= max && layout.height <= max) {
        return {
            ok: true,
            reason: '',
            sheets: [{
                file: 'sheet-1.png',
                width: layout.width,
                height: layout.height,
                columns: layout.columns,
                rows: layout.rows,
                frames: layout.frames.slice(),
            }],
        };
    }

    const maxCols = Math.max(1, Math.floor((max + gap) / (cw + gap)));
    const maxRows = Math.max(1, Math.floor((max + gap) / (ch + gap)));
    const perSheet = maxCols * maxRows;
    const total = layout.frames.length;
    const sheets = [];
    for (let start = 0; start < total; start += perSheet) {
        const slice = layout.frames.slice(start, start + perSheet);
        const columns = Math.min(maxCols, slice.length);
        const rows = Math.max(1, Math.ceil(slice.length / columns));
        const width = Math.max(1, columns * cw + gap * Math.max(0, columns - 1));
        const height = Math.max(1, rows * ch + gap * Math.max(0, rows - 1));
        const frames = slice.map((f, i) => Object.assign({}, f, {
            // 帧自己带全局 index，位置按「张内行列」重算
            x: (i % columns) * (cw + gap),
            y: Math.floor(i / columns) * (ch + gap),
            w: cw,
            h: ch,
        }));
        sheets.push({
            file: 'sheet-' + (sheets.length + 1) + '.png',
            width: width,
            height: height,
            columns: columns,
            rows: rows,
            frames: frames,
        });
    }
    return { ok: true, reason: '', sheets: sheets };
}

/**
 * Phaser 3 **JSON Hash** 的帧表。
 *
 * 为什么是 Hash 不是 Array：Hash 的键就是帧名，动画定义里直接写
 * `frames: generateFrameNames('frame_', 0, 7, '', 4)` 就能用，是 Phaser 社区最常用的一种。
 *
 * 关键映射（写反就是「贴图位置全歪」）：
 * - `frame.{x,y,w,h}` = **内容在图集里**的矩形（格位 + trim 偏移）
 * - `spriteSourceSize.{x,y,w,h}` = 内容在**原始帧**里的矩形（即 `sx/sy/sw/sh`）
 * - `sourceSize.{w,h}` = 原始帧尺寸（未裁之前的格大小）
 * - `trimmed` = 这一格是否真的裁过
 *
 * @param {object} sheet `buildSpritesheet` / `buildSpritesheets` 的产物
 * @param {{image?:string}} [opts]
 * @returns {object|null}
 */
export function phaserJSON(sheet, opts) {
    if (!sheet || !Array.isArray(sheet.frames)) return null;
    const o = opts || {};
    const cellWidth = Math.max(1, sheet.cellWidth || 1);
    const cellHeight = Math.max(1, sheet.cellHeight || 1);
    const image = o.image || 'sheet-1.png';
    const frames = {};
    for (const f of sheet.frames) {
        const sx = f.sx == null ? 0 : f.sx;
        const sy = f.sy == null ? 0 : f.sy;
        const sw = f.sw == null ? f.w : f.sw;
        const sh = f.sh == null ? f.h : f.sh;
        frames['frame_' + String(f.index).padStart(4, '0')] = {
            frame: { x: f.x + sx, y: f.y + sy, w: sw, h: sh },
            rotated: false,
            trimmed: sw < cellWidth || sh < cellHeight,
            spriteSourceSize: { x: sx, y: sy, w: sw, h: sh },
            sourceSize: { w: cellWidth, h: cellHeight },
        };
    }
    const total = (sheet.frames || []).reduce((n, f) => n + (Number(f.duration) || 0), 0);
    return {
        frames: frames,
        meta: {
            app: 'MotionStudio',
            version: SHEET_VERSION,
            image: image,
            format: 'RGBA8888',
            size: { w: sheet.width, h: sheet.height },
            scale: '1',
            // 非 Phaser 标准键（Phaser 忽略未知键）：分张清单，单张时就是一项
            sheets: (sheet.sheets && sheet.sheets.length
                ? sheet.sheets.map((s) => ({ file: s.file, width: s.width, height: s.height }))
                : [{ file: image, width: sheet.width, height: sheet.height }]),
            frameCount: (sheet.frames || []).length,
            duration: round4(total),
        },
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
    const res = buildSpritesheets(doc, o);
    if (!res.ok || !res.sheets.length) return null;
    const first = res.sheets[0];
    // 旧接口的 json 只描述这一张（单张时与以前逐字相同；分张时与这张 canvas 一致）
    first.json = sheetJSON(first);
    return first;
}

/**
 * 单格裁到内容包围盒（纯函数）。
 *
 * `sx/sy` 是内容相对**原始帧左上角**的偏移，`sw/sh` 是内容尺寸 —— 与帧表里的约定一致。
 * 全透明格（没有内容）不裁：保留整格并标 `trimmed:false`，否则消费方会拿到 0×0 的帧。
 *
 * @param {Uint8ClampedArray|ArrayLike<number>} pixels RGBA，长度至少 w*h*4
 * @param {number} w 格宽
 * @param {number} h 格高
 * @returns {{sx:number, sy:number, sw:number, sh:number, trimmed:boolean}}
 */
export function trimCellBox(pixels, w, h) {
    const whole = { sx: 0, sy: 0, sw: Math.max(1, w | 0), sh: Math.max(1, h | 0), trimmed: false };
    if (!pixels || !pixels.length) return whole;
    const box = alphaBounds(pixels, w, h);
    if (!box) return whole;
    if (box.x === 0 && box.y === 0 && box.w === w && box.h === h) return whole;
    return { sx: box.x, sy: box.y, sw: box.w, sh: box.h, trimmed: true };
}

/**
 * 合成多张精灵图（分张 + 可选 trim）。
 *
 * 与 `buildSpritesheet` 的关系：后者是「只要一张」的旧接口，内部现在就调它、取第一张 ——
 * 这样旧调用方的行为一个字没变，而大动画不会再把一张 20000px 的图怼给 `toDataURL`。
 *
 * 每格都先合成到同一张「格画布」上，再按 trim 结果贴到图集：
 * - 不裁（或全透明）：整格贴到 `(x, y)`；
 * - 裁：只把内容矩形贴到 `(x, y)`，并让 `sx/sy/sw/sh` 记下内容在原帧里的位置。
 *
 * @param {object} doc
 * @param {{maxTextureSize?:number, trim?:boolean, background?:string, createCanvas?:Function,
 *          readCellAlpha?:Function, columns?:number, gap?:number, times?:number[], step?:number}} [opts]
 * @returns {{ok:boolean, reason:string, sheets:Array<object>, json:object|null}}
 */
export function buildSpritesheets(doc, opts) {
    const o = opts || {};
    const trimOn = o.trim !== false;
    const create = typeof o.createCanvas === 'function' ? o.createCanvas : defaultCanvas;
    const times = sheetTimes(doc, o);
    if (!times.length) return { ok: false, reason: '没有可导出的帧', sheets: [], json: null };

    const baseW = intIn(doc && doc.width, 1);
    const baseH = intIn(doc && doc.height, 1);
    const cell = create(baseW, baseH);
    const cellCtx = cell && typeof cell.getContext === 'function' ? cell.getContext('2d') : null;
    if (!cell || !cellCtx) return { ok: false, reason: '没有可用的画布环境', sheets: [], json: null };

    // 与画布 / 序列导出走同一条求值路径（含时间通道与父链世界矩阵）。
    // 不复用求值器缓存：精灵图是一次性批处理，缓存只会白占内存。
    const ev = createEvaluator(doc, { cache: false });
    const reader = typeof o.readCellAlpha === 'function'
        ? o.readCellAlpha
        : typeof cellCtx.getImageData === 'function'
            ? () => cellCtx.getImageData(0, 0, baseW, baseH).data
            : null;

    /** 合成第 t 帧到格画布并求内容盒；读不到像素就当作「不裁」。 */
    const boxAt = (t) => {
        const whole = { sx: 0, sy: 0, sw: baseW, sh: baseH, trimmed: false };
        if (!trimOn) return whole;
        try {
            compositeEvaluated(cell, ev, t, { clear: true });
            const pixels = reader ? reader(cell, baseW, baseH) : null;
            if (!pixels) return whole;
            return trimCellBox(pixels, baseW, baseH);
        } catch (err) {
            // 读不到像素就退回「不裁」——宁可图集大一点，也不能让整次导出失败
            return whole;
        }
    };

    const boxes = times.map(boxAt);
    // 格尺寸收缩到「所有帧内容盒的最大宽高」——这是 trim 真正省体积的地方：
    // 只把内容挪到格左上角而格还是文档尺寸，图集总字节数几乎不变（实测 35589 vs 35598）。
    const cellW = trimOn ? Math.max(1, Math.max.apply(null, boxes.map((b) => b.sw))) : baseW;
    const cellH = trimOn ? Math.max(1, Math.max.apply(null, boxes.map((b) => b.sh))) : baseH;

    const layout = sheetLayout(doc, Object.assign({}, o, { cellWidth: cellW, cellHeight: cellH }));
    const maxSize = Math.max(1, Math.round(Number(o.maxTextureSize) || 4096));
    const split = splitSheetLayout(layout, maxSize);
    if (!split.ok) return { ok: false, reason: split.reason, sheets: [], json: null };

    const sheets = split.sheets.map((plan) => {
        const canvas = create(plan.width, plan.height);
        const g = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
        if (!canvas || !g) return null;

        try {
            g.setTransform(1, 0, 0, 1, 0, 0);
        } catch (err) {
            /* 替身画布可能没有这个 API */
        }
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
        if (typeof g.clearRect === 'function') g.clearRect(0, 0, plan.width, plan.height);
        if (typeof o.background === 'string' && o.background && typeof g.fillRect === 'function') {
            g.fillStyle = o.background;
            g.fillRect(0, 0, plan.width, plan.height);
            g.fillStyle = '#000000';
        }

        const frames = plan.frames.map((item) => {
            const box = boxes[item.index] || { sx: 0, sy: 0, sw: baseW, sh: baseH, trimmed: false };
            try {
                compositeEvaluated(cell, ev, item.t, { clear: true });
                if (box.trimmed) {
                    // 只把内容矩形贴到格左上角；内容在原帧里的位置由 sx/sy 记录
                    g.drawImage(cell, box.sx, box.sy, box.sw, box.sh, item.x, item.y, box.sw, box.sh);
                } else {
                    g.drawImage(cell, item.x, item.y);
                }
            } catch (err) {
                /* 单格贴失败不该毁掉整张图 */
            }
            return Object.assign({}, item, {
                sx: box.sx, sy: box.sy, sw: box.sw, sh: box.sh, trimmed: box.trimmed,
            });
        });

        const one = {
            canvas: canvas,
            width: plan.width,
            height: plan.height,
            columns: plan.columns,
            rows: plan.rows,
            cellWidth: layout.cellWidth,
            cellHeight: layout.cellHeight,
            gap: layout.gap,
            sampleRate: layout.sampleRate,
            duration: layout.duration,
            times: layout.times,
            frames: frames,
            file: plan.file,
        };
        one.phaser = phaserJSON(one, { image: plan.file });
        return one;
    });

    if (sheets.some((s) => !s)) return { ok: false, reason: '没有可用的画布环境', sheets: [], json: null };

    // 顶层 json：自家格式（含 sheets[]），帧表里的格尺寸就是收缩后的实际格
    const top = {
        width: sheets[0].width,
        height: sheets[0].height,
        columns: sheets[0].columns,
        rows: sheets[0].rows,
        cellWidth: layout.cellWidth,
        cellHeight: layout.cellHeight,
        gap: layout.gap,
        sampleRate: layout.sampleRate,
        duration: layout.duration,
        sheets: sheets.map((s) => ({ file: s.file, width: s.width, height: s.height })),
        frames: sheets.reduce((acc, s) => acc.concat(s.frames), []),
    };
    top.json = sheetJSON(top);
    return { ok: true, reason: '', sheets: sheets, json: top.json };
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
