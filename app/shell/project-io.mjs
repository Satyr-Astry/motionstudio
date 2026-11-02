/**
 * MotionStudio —— 导出与项目 IO：逐帧 PNG / 精灵图 / 项目库 / .json 存档
 *
 * 所有落盘都经过 ipc.mjs（唯一接触 window.motionAPI 的地方），
 * 浏览器里没有桥时这些入口返回 null，不会抛异常。
 * 项目库只是 project-store 的一层 UI：卡片、缩略图、新建 / 打开 / 导入 / 删除。
 *
 * 依赖方向：doc-state（state / 默认画布尺寸 / applyDoc 换文档 / 面板刷新）、
 * core（cel / timebase）、paint（composite）、spritesheet、ipc、project-store、
 * registry；以及 app.mjs 的 ctx —— 只被 openProjectsPanel 在运行期读取。
 * doc-state 反向 import 本模块的 project / markDirty / notifyProjects，
 * 双方都只在函数体里解引用，循环因此安全。
 */

import {
    createDocument,
    totalSeconds,
} from '../core/cel.mjs';
import { DEFAULT_OBJECT_NAME } from '../core/doc-model.mjs';
import { sampleTimes } from '../core/timebase.mjs';
import { compositeFrame } from '../paint/composite.mjs';
import { editorDef } from './registry.mjs';
import * as ipc from './ipc.mjs';
import { importBuffer, pickAndImport } from './import-file.mjs';
import { canReplaceDoc, mergeImportedDoc } from '../core/import-merge.mjs';
import {
    DRAFT_ID,
    guardDecision,
    choiceOutcome,
    deleteConfirmText,
    draftPromptText,
    isDraftRecord,
    draftName,
} from '../core/project-guard.mjs';
import * as store from './project-store.mjs';
import { asepriteJSON, buildSpritesheets, phaserJSON, sheetToDataURLAsync } from './spritesheet.mjs';
import { icon } from '../core/icons.mjs';
import { pickVideoMime, videoBitrate, videoCanvasSize, videoFps, videoFrameCount, videoSeconds } from './video-plan.mjs';
import { t } from '../i18n/index.mjs';
import {
    EXPORT_CHUNK,
    chunkPlan,
    effectiveFps,
    normalizeExportOptions,
    sampleTimesFor,
} from '../core/export-options.mjs';
import { encodeGif } from '../core/gif.mjs';
import { canEncodeApng, encodeApng } from '../core/apng.mjs';
import {
    DEFAULT_W,
    DEFAULT_H,
    DEFAULT_FPS,
    DEFAULT_FRAMES,
    state,
    shell,
    el,
    clampInt,
    enrichDoc,
    applyDoc,
    setDoc,
    flash,
    updateChrome,
    markDirty,
    notifyProjects,
    project,
    engine,
    prefSnapshot,
} from './doc-state.mjs';
// 运行期注入，理由同 view-host.mjs
let CTX = null;
/** 由 app.mjs 在 boot() 里注入。 */
export function setCtx(c) {
    CTX = c;
}

/**
 * 当前项目元信息（和 doc 分开：doc 是纯内容，这里是「存档身份」）。
 * id 是项目库主键（空 = 还没保存过）；file 是最近一次存成 .json 的路径；
 * dirty 表示保存之后又有改动，顶栏会显示 `名称 •`。
 */
let saveBusy = false;

/**
 * 最近一次成功入库的时刻（毫秒）。顶栏「上次保存 HH:MM:SS」读它，
 * 所以在保存、载入、导入、新建四处都要维护；0 表示还没进过库。
 */
let savedAtMs = 0;

/**
 * 当前项目最近一次「打开」的时刻（毫秒）。与 savedAtMs 分开维护：
 * 「最近打开」是项目库排序/卡片 meta 的口径，一次 Ctrl+S 不该把它刷新成现在
 * （那会让用户按「最近打开」找项目时，看到的顺序其实是「最近保存」）。
 * 打开 / 导入 / 恢复 / 新建四处设置（见 touchOpenedAt），保存时原样带进记录。
 */
let openedAtMs = 0;

/**
 * 当前有几个 askChoice 浮层开着。
 * 项目库浮层的 Esc 监听挂在 window 捕获期，注册得比 askChoice 早；
 * 不挡一下的话，用户在三选面板上按 Esc 会把整个项目库也一起关掉。
 */
let askDepth = 0;

/* ───────────── 动作结果的三件套：做成了 / 失败了 / 用户取消 ───────────── */

/**
 * 导出与存档的每条路都返回这个形状，而不是 null/true 混着来。
 *
 * 为什么值得统一：调用方（项目库面板、导出对话框、命令面板）拿到的若是裸
 * null，就只能猜「是取消了？是桥不在？还是失败了？」—— 猜错的两种结果都很糟：
 * 把失败当取消（用户以为是自己点的取消，其实是没存下来），
 * 或把失败当成功（弹「已导出」，磁盘上什么都没有）。
 */
function okResult(extra) {
    return Object.assign({ ok: true }, extra || {});
}

function failResult(text, extra) {
    return Object.assign({ ok: false, error: String(text || t('shell.result.failed')) }, extra || {});
}

function canceledResult(text) {
    return { ok: false, canceled: true, error: String(text || t('shell.result.canceled')) };
}

/**
 * 报一条「没做成」，并统一走错误档提示（停留更久、不被下一条普通消息顶掉）。
 * 文案规矩：先说没存下来/没导出，再说为什么，最后说补救动作。
 */
function fail(text) {
    const msg = String(text || t('shell.result.failed'));
    flash(msg, 'error');
    return failResult(msg);
}

/**
 * 逐帧 PNG 导出。
 *
 * 双语义（第 32 批）：
 * - `exportFrames('工程名')` —— 旧调用，逐字走老行为：按文档尺寸/帧率导整段、
 *   不弹对话框、落系统图片目录。`app/shell/app.mjs` 里的旧调用点还在用它。
 * - `exportFrames()` / `exportFrames(opts)` —— 新流程：先在 `opts` 上归一化，
 *   支持缩放/帧率/时间范围/背景/自定义目录/进度/取消，按 16 帧分片落盘。
 */
function exportFrames(arg) {
    if (typeof arg === 'string') return exportFramesLegacy(arg);
    const raw = arg && typeof arg === 'object' ? arg : {};
    // `__direct` 是内部标记：对话框与测试直接调分片导出，不再套一层浮层
    if (raw.__direct) return exportFramesChunked(raw);
    return exportWithDialog('frames', raw);
}

/**
 * 打开导出对话框并跑其中一条通道。
 *
 * 用动态 `import` 取 `editors/export-dialog.mjs`：那个文件会 import 本模块用不到的
 * DOM 工具，静态引入会让「浏览器直开 / node 测试」都多背一份依赖链，
 * 而对话框只有用户点导出时才需要。
 *
 * @param {'frames'|'sheet'|'video'} kind 预选通道
 * @param {object} [preset] 预填选项
 * @returns {Promise<object|null>}
 */
async function exportWithDialog(kind, preset) {
    if (typeof document === 'undefined') return null;
    let mod;
    try {
        mod = await import('../editors/export-dialog.mjs');
    } catch (err) {
        console.error('[shell] 导出对话框加载失败：', err);
        flash(t('shell.export.dialogFailed'), 'error');
        return null;
    }
    const opened = await mod.openExportDialog({
        doc: () => state.doc,
        preset: preset || {},
        storage: typeof localStorage !== 'undefined' ? localStorage : null,
        run: async (which, opts, ui) => {
            if (which === 'frames') {
                return exportFramesChunked({
                    ...opts,
                    __direct: true,
                    onProgress: (p) => ui.progress(p.written, p.total),
                    shouldCancel: ui.canceled,
                });
            }
            if (which === 'sheet') {
                if (ui && typeof ui.progress === 'function') ui.progress(0, 1);
                const r = await exportSpritesheet({ dir: opts.dir, scale: opts.scale, background: opts.background, bgColor: opts.bgColor });
                if (ui && typeof ui.progress === 'function') ui.progress(1, 1);
                if (r && r.ok) return { ok: true, message: t('shell.sheet.done'), res: r };
                return { ok: false, canceled: !!(r && r.canceled), error: (r && r.error) || t('shell.sheet.failed') };
            }
            if (which === 'gif') {
                // 量化 + LZW 是一次性的（没有分帧进度可比），进度条只报「开始 / 完成」
                if (ui && typeof ui.progress === 'function') ui.progress(0, 1);
                const r = await exportGif({
                    scale: opts.scale,
                    fps: opts.fps,
                    from: opts.from,
                    to: opts.to,
                    background: opts.background,
                    bgColor: opts.bgColor,
                    shouldCancel: ui && ui.canceled,
                });
                if (ui && typeof ui.progress === 'function') ui.progress(1, 1);
                if (r && r.ok) return { ok: true, message: r.message || t('export.gif.done', { n: r.count || 0, size: Math.round((r.size || 0) / 1024) }), res: r };
                return { ok: false, canceled: !!(r && r.canceled), error: (r && r.error) || t('export.gif.saveFailedNoReason') };
            }
            if (which === 'apng') {
                // 编码是流式 deflate，也没有分帧进度可言：同样只报「开始 / 完成」
                if (ui && typeof ui.progress === 'function') ui.progress(0, 1);
                const r = await exportApng({
                    scale: opts.scale,
                    fps: opts.fps,
                    from: opts.from,
                    to: opts.to,
                    background: opts.background,
                    bgColor: opts.bgColor,
                    shouldCancel: ui && ui.canceled,
                });
                if (ui && typeof ui.progress === 'function') ui.progress(1, 1);
                if (r && r.ok) return { ok: true, message: r.message || t('export.apng.done', { n: r.count || 0, size: Math.round((r.size || 0) / 1024) }), res: r };
                return { ok: false, canceled: !!(r && r.canceled), error: (r && r.error) || t('export.apng.saveFailedNoReason') };
            }
            // WebM：录完必须**真的存下来**。以前这里只把字节留在内存里，却回了一句
            // 「已录制 N 帧（WebM 在内存里）」当成功 —— 对话框一关字节就没了，
            // 但用户看到的是「导出完成」。现在统一走 exportVideo：它录完弹保存对话框，
            // 并把「存下来了 / 用户取消 / 没存下来」三种结局分别带回来。
            const r = await exportVideo({
                fps: opts.fps || 0,
                seconds: Math.max(0, opts.to - opts.from),
                from: opts.from,
                onProgress: (done, total) => {
                    if (ui && typeof ui.progress === 'function') ui.progress(done, total);
                },
            });
            if (!r || r.ok === false) {
                return { ok: false, canceled: !!(r && r.canceled), error: (r && r.error) || t('shell.video.recordFailed') };
            }
            if (!r.file) {
                // 回到了 ok:true 却没路径 = 没落盘。不能当成功。
                return { ok: false, error: t('shell.video.noPath') };
            }
            return {
                ok: true,
                message: t('shell.video.done', { frames: r.frames || 0, kb: Math.round((r.size || 0) / 1024), path: r.file }),
                res: r,
            };
        },
    });
    return opened;
}

/**
 * 旧行为：整段一次传给主进程，不弹框、不分片、不认选项。
 *
 * **只为兼容旧调用方保留** —— 菜单导出（`onFileAct('export')`）已经翻成
 * `exportFrames()` 走对话框，本仓内没有活跃调用点；外部脚本若还在用
 * `exportFrames('名字')` 这种字符串调用，仍然逐字走这条老路。
 * 新代码请用 `exportFrames()` / `exportFrames({...})`。
 */
function exportFramesLegacy(name) {
    const doc = state.doc;
    if (!doc || typeof document === 'undefined') return null;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, doc.width | 0);
    cv.height = Math.max(1, doc.height | 0);
    const frames = [];
    // v6：按时间采样 —— 每段用自己的 fps 生成时间点，再按时间取纹理合成。
    // 帧数组已删除，导出完全是「时间 → 图像」的映射。
    const times = sampleTimes(doc, totalSeconds(doc));
    const list = times.length ? times : [0];
    for (const s of list) {
        const t = typeof s === 'number' ? s : s && typeof s.t === 'number' ? s.t : 0;
        compositeFrame(cv, doc, t, { clear: true });
        frames.push(cv.toDataURL('image/png'));
    }
    const label = String(name == null ? 'motionstudio' : name);
    if (!ipc.available()) {
        return fail(t('shell.frames.noBridge', { n: frames.length }));
    }
    const res = ipc.exportFrames(label, frames);
    if (res == null) {
        return fail(t('shell.frames.noResponsePreload', { n: frames.length }));
    }
    // 主进程回了 ok:false 也是失败：老代码只看 null，把「写了 0 个文件」当成了导出成功
    const judge = (r) => {
        if (r == null) return fail(t('shell.frames.noResponse', { n: frames.length }));
        if (r.ok === false) {
            return fail(r.canceled ? t('shell.export.canceledNoFile') : (r.error || t('shell.export.failedNoFile')));
        }
        flash(t('shell.frames.done', { n: frames.length }));
        return okResult({ frames: frames.length, dir: r.dir });
    };
    if (res && typeof res.then === 'function') {
        return res.then(judge, (err) => {
            console.error('[shell] 导出失败：', err);
            return fail(t('shell.export.failedWithMsg', { msg: (err && err.message) || err }));
        });
    }
    return judge(res);
}

/**
 * 新流程：按导出选项逐帧合成，16 帧一片交给主进程落盘。
 *
 * 两个约束来自真机实测：
 * - **每片之间 `await` 一次宏任务**，否则整段导出在一个任务里跑完，进度条一帧都不动；
 * - **取消 = 少发后几片**，已写出的片留在磁盘上（部分结果比「什么都没有」有用）。
 */
async function exportFramesChunked(raw) {
    const doc = state.doc;
    if (!doc || typeof document === 'undefined') return null;
    const opts = normalizeExportOptions(raw, doc);
    if (!opts.count) {
        return fail(t('shell.frames.emptyRange'));
    }
    if (!ipc.available()) {
        return fail(t('shell.frames.noBridgeShort'));
    }
    const cv = document.createElement('canvas');
    cv.width = opts.width;
    cv.height = opts.height;
    const times = sampleTimesFor(opts);
    const plans = chunkPlan(opts.count, EXPORT_CHUNK);
    const solid = opts.background === 'solid';
    let dir = '';
    let written = 0;
    for (let c = 0; c < plans.length; c++) {
        if (typeof raw.shouldCancel === 'function' && raw.shouldCancel()) {
            finishExport({ dir, written, total: opts.count, canceled: true });
            return Object.assign(canceledResult(t('shell.export.canceledWritten', { written })), { written, total: opts.count, dir });
        }
        const plan = plans[c];
        const frames = [];
        for (let i = 0; i < plan.count; i++) {
            compositeFrame(cv, doc, times[plan.start + i], { clear: true });
            if (solid) fillBehind(cv, opts.bgColor);
            frames.push(cv.toDataURL('image/png'));
        }
        const res = await Promise.resolve(
            ipc.exportFrames(projectLabel(), frames, { dir, startIndex: plan.start, total: opts.count })
        );
        if (!res) {
            return fail(t('shell.frames.partialNoResponse', { written }));
        }
        if (res.ok === false) {
            return fail(res.canceled
                ? t('shell.export.canceledWritten', { written })
                : t('shell.export.failedWritten', { msg: res.error || t('shell.export.failed'), written }));
        }
        if (res.dir) dir = res.dir;
        written += Number(res.count) || 0;
        if (typeof raw.onProgress === 'function') {
            raw.onProgress({ written, total: opts.count, chunk: c + 1, chunks: plans.length });
        }
        // 让出一次宏任务：进度条与「取消」按钮要靠它才有机会响应
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    finishExport({ dir, written, total: opts.count, canceled: false, openAfter: opts.openAfter });
    return okResult({ dir, written, total: opts.count });
}

/** 背景色：合成完成后在底下垫一层（`destination-over` 不会盖住已画的内容）。 */
function fillBehind(cv, color) {
    const g = cv.getContext('2d');
    if (!g) return;
    g.save();
    g.globalCompositeOperation = 'destination-over';
    g.fillStyle = color;
    g.fillRect(0, 0, cv.width, cv.height);
    g.restore();
}

function finishExport(res) {
    if (res.canceled) {
        flash(t('shell.export.canceledWritten', { written: res.written }));
    } else if (!res.written) {
        // 主进程回 ok:true 但一个文件都没写：不能报「已导出 0 帧」了事
        flash(t('shell.export.zeroWritten'), 'error');
    } else {
        flash(t('shell.frames.doneTotal', { n: res.written, total: res.total }));
        // 勾了「完成后打开所在文件夹」才开；浏览器里 ipc 没桥，openFolder 自己返回 null
        if (res.openAfter && res.dir) ipc.openFolder(res.dir);
    }
    updateChrome();
    if (CTX && typeof CTX.requestRender === 'function') CTX.requestRender();
}

/**
 * 导出 GIF：**一张能直接发出去的透明动图**。
 *
 * 存在的理由（定位问题）：帧序列要打包、精灵图要写代码才能播、WebM 是实时录制且大概率
 * 掉帧 —— 这三样都不是「把它发给朋友看看」能用的东西。GIF 是唯一一个「双击就能播、
 * 贴进聊天框会动」的格式，代价是三条硬限制（都已写进 `app/core/gif.mjs` 的文件头）：
 * 透明只有 1 位、最多 256 色、比 WebM 大得多。
 *
 * 与其它三条通道共用同一套选项（缩放 / 帧率 / 时间范围 / 背景），所以「导出对话框里
 * 调好的参数」对 GIF 一样生效；`dither` 是 GIF 独有的一项。
 *
 * 全程在本地做（量化 + LZW 都是纯函数），不经过主进程的编码器 —— 主进程只负责
 * 把字节落盘（`ms:save-binary`），所以浏览器里也能用。
 */
async function exportGif(raw) {
    const o = raw || {};
    const doc = state.doc;
    if (!doc || typeof document === 'undefined') return null;
    const opts = normalizeExportOptions(o, doc);
    if (!opts.count) {
        return fail(t('export.gif.emptyRange'));
    }
    if (!ipc.available()) {
        return fail(t('export.gif.noBridge'));
    }
    const cv = document.createElement('canvas');
    cv.width = opts.width;
    cv.height = opts.height;
    const g = cv.getContext('2d');
    if (!g || typeof g.getImageData !== 'function') {
        return fail(t('export.gif.noCanvas'));
    }
    const times = sampleTimesFor(opts);
    const solid = opts.background === 'solid';
    const frames = [];
    for (let i = 0; i < opts.count; i++) {
        if (typeof o.shouldCancel === 'function' && o.shouldCancel()) {
            return canceledResult(t('export.gif.canceled'));
        }
        compositeFrame(cv, doc, times[i], { clear: true });
        if (solid) fillBehind(cv, opts.bgColor);
        frames.push(g.getImageData(0, 0, opts.width, opts.height));
    }
    // 帧率取「与帧序列同一口径」的有效帧率，别让 GIF 的播放速度和帧序列不一致
    const fps = effectiveFps(opts, doc);
    let bytes = null;
    try {
        bytes = encodeGif(frames, {
            delayMs: Math.max(2, Math.round(1000 / Math.max(1, fps))),
            dither: !!o.dither,
        });
    } catch (err) {
        // 编码器对坏输入抛 RangeError / TypeError；不能让它冒到 IPC 层（那样只会看到「没反应」）
        return fail(t('export.gif.encodeFailed', { msg: (err && err.message) || err }));
    }
    const saved = await ipc.saveBinaryChecked(projectLabel(), bytes, 'gif', t('export.gif.label'));
    if (!saved || saved.ok !== true) {
        if (saved && saved.canceled) return canceledResult(t('export.gif.canceledSave'));
        return fail(t('export.gif.saveFailed', { msg: (saved && saved.error) || t('export.gif.saveFailedNoReason') }));
    }
    flash(t('export.gif.done', { n: opts.count, size: Math.round(saved.size / 1024) }));
    return okResult({ file: saved.file, count: opts.count, size: saved.size });
}

/**
 * 导出 APNG（动画 PNG）。
 *
 * 与 GIF 的关系：同一份逐帧采样、同一套合成，区别只在编码器。APNG 是
 * **全彩 + 8 位 alpha**，所以没有 GIF 那三条限制（透明 1 位 / 256 色 / 体积大），
 * 代价是环境必须有 `CompressionStream`（Node 18+ 与所有现代浏览器都有，
 * 但 Electron 之外的旧环境不一定 —— 所以先问 `canEncodeApng()` 再动手）。
 *
 * 编码是异步的（流式 deflate），所以这个函数是 async；进度没有细分，
 * 调用方只能看到 0 → 1。
 */
async function exportApng(raw) {
    const o = raw || {};
    const doc = state.doc;
    if (!doc || typeof document === 'undefined') return null;
    const opts = normalizeExportOptions(o, doc);
    if (!opts.count) {
        return fail(t('export.apng.emptyRange'));
    }
    if (!ipc.available()) {
        return fail(t('export.apng.noBridge'));
    }
    if (!canEncodeApng()) {
        return fail(t('export.apng.noSupport'));
    }
    const cv = document.createElement('canvas');
    cv.width = opts.width;
    cv.height = opts.height;
    const g = cv.getContext('2d');
    if (!g || typeof g.getImageData !== 'function') {
        return fail(t('export.apng.noCanvas'));
    }
    const times = sampleTimesFor(opts);
    const solid = opts.background === 'solid';
    const frames = [];
    for (let i = 0; i < opts.count; i++) {
        if (typeof o.shouldCancel === 'function' && o.shouldCancel()) {
            return canceledResult(t('export.apng.canceled'));
        }
        compositeFrame(cv, doc, times[i], { clear: true });
        if (solid) fillBehind(cv, opts.bgColor);
        const img = g.getImageData(0, 0, opts.width, opts.height);
        frames.push({ width: opts.width, height: opts.height, data: img.data });
    }
    const fps = effectiveFps(opts, doc);
    let bytes = null;
    try {
        bytes = await encodeApng(frames, {
            delayMs: Math.max(1, Math.round(1000 / Math.max(1, fps))),
        });
    } catch (err) {
        // 编码器对坏输入抛 RangeError / TypeError；不能让它冒到 IPC 层（那样只会看到「没反应」）
        return fail(t('export.apng.encodeFailed', { msg: (err && err.message) || err }));
    }
    const saved = await ipc.saveBinaryChecked(projectLabel(), bytes, 'png', t('export.apng.label'));
    if (!saved || saved.ok !== true) {
        if (saved && saved.canceled) return canceledResult(t('export.apng.canceledSave'));
        return fail(t('export.apng.saveFailed', { msg: (saved && saved.error) || t('export.apng.saveFailedNoReason') }));
    }
    flash(t('export.apng.done', { n: opts.count, size: Math.round(saved.size / 1024) }));
    return okResult({ file: saved.file, count: opts.count, size: saved.size });
}

/** 导出精灵图（图片 + 帧表），落盘由主进程 ms:export-sheet 负责。 */
async function exportSpritesheet(opts) {
    const o = opts || {};
    if (!state.doc || typeof document === 'undefined') return null;
    if (typeof buildSpritesheets !== 'function') {
        return fail(t('shell.sheet.moduleMissing'));
    }

    const n = normalizeExportOptions(o, state.doc);
    const format = n.format;
    const mime = format === 'webp' ? 'image/webp' : format === 'jpeg' ? 'image/jpeg' : 'image/png';
    // JPEG 没有 alpha 通道：必须给一个具体底色，否则透明区会变黑，用户以为是渲染坏了
    const jpegFill = n.bgColor || '#000000';
    const bg = format === 'jpeg' ? jpegFill : n.background === 'color' ? n.bgColor : '';

    const built = buildSpritesheets(state.doc, {
        maxTextureSize: n.maxTextureSize,
        trim: n.trim,
        background: bg,
        times: o.times,
        step: o.step,
        columns: o.columns,
        gap: o.gap,
    });
    if (!built.ok) {
        // 预检失败要把原因说清楚（比如「单帧 5000px 超过图集上限」），不能只说「失败」
        return fail(t('shell.sheet.failedNoFiles', { reason: built.reason || t('shell.sheet.failed') }));
    }
    if (format === 'jpeg' && n.background !== 'color') {
        flash(t('shell.sheet.jpegFill', { fill: jpegFill }));
    }

    const images = [];
    for (const one of built.sheets) {
        const dataUrl = await sheetToDataURLAsync(one, mime);
        if (!dataUrl) {
            return fail(t('shell.sheet.encodeFailed', { format }));
        }
        images.push({ file: one.file, png: dataUrl });
    }

    // 帧表：自家格式永远写；engine 选 phaser / aseprite / both 时再各写一份。
    // 两种引擎帧表的分张写法完全同构（每张一份、每份只描述自己那张的帧），
    // 所以抽成一个局部函数，只有生成函数与文件名后缀不同。
    const jsons = [{ file: projectLabel() + '.json', text: JSON.stringify(built.json, null, 2) }];
    const pushEngineSheets = (makeJson, suffix) => {
        const per = built.sheets.map((one) => makeJson(Object.assign({}, one, {
            sheets: [{ file: one.file, width: one.width, height: one.height }],
        }), { image: one.file }));
        if (per.length === 1) {
            jsons.push({ file: projectLabel() + suffix + '.json', text: JSON.stringify(per[0], null, 2) });
        } else {
            per.forEach((json, i) => {
                jsons.push({
                    file: projectLabel() + suffix + '-' + (i + 1) + '.json',
                    text: JSON.stringify(json, null, 2),
                });
            });
        }
    };
    if (n.engine === 'phaser' || n.engine === 'both') pushEngineSheets(phaserJSON, '.phaser');
    if (n.engine === 'aseprite' || n.engine === 'both') pushEngineSheets(asepriteJSON, '.aseprite');

    if (!ipc.available()) {
        return fail(t('shell.sheet.noBridge'));
    }
    const res = await Promise.resolve(ipc.exportSheet(projectLabel(), images[0] && images[0].png, jsons[0].text, {
        dir: n.dir || '',
        sheets: images,
        jsons: jsons,
    }));
    if (!res) {
        return fail(t('shell.sheet.noResponse'));
    }
    if (res.ok === false) {
        return fail(res.canceled ? t('shell.sheet.canceled') : (res.error || t('shell.sheet.failed')));
    }
    const count = built.json && built.json.frames ? built.json.frames.length : 0;
    const extra = built.sheets.length > 1 ? t('shell.sheet.multi', { n: built.sheets.length }) : '';
    flash(t('shell.sheet.countDone', { n: count, extra }));
    return okResult({ count, dir: res.dir || n.dir || '', res });
}

/**
 * 导出当前帧为一张图片（菜单/命令面板用）。
 *
 * 走 `ms:save-binary`（系统保存对话框），扩展名跟着格式走。
 * @param {{format?:string, quality?:number, background?:string, bgColor?:string}} [opts]
 */
async function exportCurrentFrame(opts) {
    const o = opts || {};
    if (!state.doc || typeof document === 'undefined') return null;
    // 这里以前写的是 `typeof ipc.saveBinary !== 'function'` —— ipc 是命名空间对象，
    // 它的每个成员都是函数，这个判断恒为假，等于没判。要问的是「有没有桥」。
    if (!ipc.available()) {
        return fail(t('shell.frame.noSaveChannel'));
    }
    const n = normalizeExportOptions(o, state.doc);
    const format = n.format;
    const mime = format === 'webp' ? 'image/webp' : format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const ext = format === 'jpeg' ? 'jpg' : format;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(state.doc.width || 1));
    cv.height = Math.max(1, Math.round(state.doc.height || 1));
    const g = cv.getContext('2d');
    if (!g) {
        return fail(t('shell.frame.noContext'));
    }
    if (format === 'jpeg' || n.background === 'color') {
        g.fillStyle = format === 'jpeg' ? (n.bgColor || '#000000') : n.bgColor;
        g.fillRect(0, 0, cv.width, cv.height);
    }
    compositeFrame(cv, state.doc, state.time, { clear: format !== 'jpeg' && n.background !== 'color' });
    const dataUrl = format === 'jpeg' || format === 'webp'
        ? cv.toDataURL(mime, n.quality)
        : cv.toDataURL(mime);
    const bytes = dataUrlToBytes(dataUrl);
    if (!bytes) {
        return fail(t('shell.frame.empty'));
    }
    const saved = await ipc.saveBinaryChecked(
        projectLabel() + '-frame-' + String(Math.round(state.time * 1000)) + '.' + ext, bytes, ext, t('shell.frame.dialogLabel')
    );
    if (!saved.ok) {
        // 取消是取消，失败是失败：以前 null 一律说「已取消」，用户就以为是自己点了取消
        if (saved.canceled) {
            flash(t('shell.frame.canceled'));
            return canceledResult(t('shell.frame.canceled'));
        }
        return fail(t('shell.frame.saveFailed', { msg: saved.error }));
    }
    flash(t('shell.frame.done', { path: saved.file }));
    return okResult({ file: saved.file, size: saved.size, bytes: bytes.byteLength });
}

/** dataURL → Uint8Array（base64 解码，浏览器里用 atob）。 */
function dataUrlToBytes(dataUrl) {
    const m = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(String(dataUrl || ''));
    if (!m) return null;
    try {
        const bin = atob(m[1]);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    } catch (err) {
        return null;
    }
}

/** 把当前帧编码成 PNG Blob（剪贴板用；失败返回 null）。 */
async function currentFrameBlob() {
    if (!state.doc || typeof document === 'undefined') return null;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(state.doc.width || 1));
    cv.height = Math.max(1, Math.round(state.doc.height || 1));
    const g = cv.getContext('2d');
    if (!g) return null;
    compositeFrame(cv, state.doc, state.time, { clear: true });
    if (typeof cv.toBlob === 'function') {
        return await new Promise((resolve) => {
            try {
                cv.toBlob((blob) => resolve(blob || null), 'image/png');
            } catch (err) {
                resolve(null);
            }
        });
    }
    try {
        return await cv.convertToBlob({ type: 'image/png' });
    } catch (err) {
        return null;
    }
}

/**
 * 复制当前帧到剪贴板（菜单/命令面板用）。
 *
 * 三条降级路径**文案必须不同** —— 用户看到的提示要能告诉他该修什么：
 * 1. 浏览器没有 `ClipboardItem` → 「浏览器不支持写剪贴板，已改为导出文件」
 * 2. `clipboard.write` 抛 NotAllowed（窗口没焦点 / 没授权）→ 「窗口没有焦点，已改为导出文件」
 * 3. `write` 超时（系统剪贴板被别的进程占着）→ 「剪贴板写入超时，已改为导出文件」
 * 三者最后都落到「导出当前帧到文件」，不会让用户白点一下。
 */
async function copyFrameToClipboard(opts) {
    const fallback = async (msg) => {
        // 顺序有讲究：`exportCurrentFrame` 自己会 flash（失败走错误档、停留更久），
        // 所以这里只在**成功**或**用户取消**时补一句「为什么改走文件」；
        // 真失败时那句补救建议已经在顶栏上了，再叠一句只会把原因盖掉。
        const out = await exportCurrentFrame(opts);
        if (out && out.ok) flash(t('shell.clip.savedAsFile', { msg }));
        else if (out && out.canceled) flash(t('shell.clip.exportCanceled', { msg }));
        return out;
    };
    if (typeof document === 'undefined' || !state.doc) return null;
    if (typeof window === 'undefined' || typeof ClipboardItem !== 'function' || !navigator.clipboard || typeof navigator.clipboard.write !== 'function') {
        return await fallback(t('shell.clip.noWrite'));
    }
    const blob = await currentFrameBlob();
    if (!blob) return await fallback(t('shell.clip.emptyFrame'));
    try {
        const job = navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), 3000));
        const result = await Promise.race([job.then(() => 'ok'), timeout]);
        if (result === 'timeout') return await fallback(t('shell.clip.timeout'));
    } catch (err) {
        const name = err && err.name ? String(err.name) : '';
        if (name === 'NotAllowedError' || name === 'SecurityError') {
            return await fallback(t('shell.clip.noFocus'));
        }
        return await fallback(t('shell.clip.writeFailed'));
    }
    flash(t('shell.clip.copied'));
    return true;
}

/* ─────────────────────────── 项目：保存 / 打开 / 新建 ─────────────────────────── */

function pad2(n) {
    return n < 10 ? '0' + n : String(n);
}

function stamp(d) {
    const t = d || new Date();
    return (
        t.getFullYear().toString() +
        pad2(t.getMonth() + 1) +
        pad2(t.getDate()) +
        '-' +
        pad2(t.getHours()) +
        pad2(t.getMinutes())
    );
}

function defaultProjectName() {
    return t('shell.project.defaultName', { stamp: stamp() });
}

function baseName(path) {
    const s = String(path == null ? '' : path);
    const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return (cut >= 0 ? s.slice(cut + 1) : s).replace(/\.(msp|json)$/i, '');
}

/** 顶栏显示的当前项目名。 */
function projectLabel() {
    return project.name || t('shell.project.untitled');
}

/** 有改动就标脏：只在 false → true 时刷一次顶栏，避免每笔都刷新。 */


function subscribeProjects(fn) {
    if (typeof fn !== 'function') return () => {};
    projectListeners.add(fn);
    return () => projectListeners.delete(fn);
}

/** 缩略图：把第 1 帧合成到全尺寸临时画布，再等比缩到 128 宽（项目库卡片用）。 */
function frameThumb(doc) {
    if (!doc || typeof document === 'undefined') return '';
    try {
        const full = document.createElement('canvas');
        full.width = Math.max(1, doc.width | 0);
        full.height = Math.max(1, doc.height | 0);
        compositeFrame(full, doc, 0, { clear: true });
        const scale = Math.min(1, 128 / Math.max(1, full.width));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(full.width * scale));
        cv.height = Math.max(1, Math.round(full.height * scale));
        const g = cv.getContext('2d');
        if (!g) return '';
        g.drawImage(full, 0, 0, full.width, full.height, 0, 0, cv.width, cv.height);
        return cv.toDataURL('image/png');
    } catch (err) {
        console.error('[shell] 生成缩略图失败：', err);
        return '';
    }
}


function currentProject() {
    return {
        id: project.id,
        name: project.name,
        file: project.file,
        dirty: project.dirty,
        label: projectLabel(),
        savedAt: savedAtMs,
        openedAt: openedAtMs,
        storeKind: store.storageKind(),
    };
}

/**
 * 把「最近打开时间」写回库记录（打开 / 导入 / 恢复三条路各调一次）。
 *
 * 只改 `openedAt`：`savedAt` 是「存档内容是什么时候的」，打开一次文件内容没变，
 * 把它刷新成现在会让顶栏与卡片都谎报「刚刚保存过」。记录不存在（未命名文档、
 * 已被删的项目）时安静返回 0，调用方自行退回内存里的值。
 *
 * @param {string} id 库记录 id
 * @returns {Promise<number>} 写入的时间戳；没写成返回 0
 */
async function touchOpenedAt(id) {
    if (!id) return 0;
    try {
        const rec = await store.getProject(id);
        if (!rec) return 0;
        const now = Date.now();
        rec.openedAt = now;
        const saved = await store.putProject(rec);
        return saved ? now : 0;
    } catch (err) {
        // 只影响列表排序与卡片 meta，不影响内容；日志留英文，不新增待迁文案
        console.error('[shell] failed to record openedAt:', err);
        return 0;
    }
}

/**
 * 把整库记录逐条读完整（`listProjects` 给的是轻量视图，备份要的是完整 project 节点）。
 * 单条读失败只跳过那一条：一份备份少一个项目，也比整份导不出来强。
 *
 * @returns {Promise<object[]>} 完整记录数组
 */
async function fullLibraryRecords() {
    let rows = [];
    try {
        rows = await store.listProjects();
    } catch (err) {
        rows = [];
    }
    const records = [];
    for (const row of rows) {
        try {
            const rec = await store.getProject(row && row.id);
            if (rec && rec.project) records.push(rec);
        } catch (err) {
            /* 这一条读不出来：跳过，别拖垮整份备份 */
        }
    }
    return records;
}

/**
 * 当前文档 → .msp 文件 payload（**唯一**的「当前文档序列化」实现）。
 *
 * 「存为文件 / 另存为」与 Ctrl+S 的「回写已绑定文件」必须写出一模一样的字节：
 * 两份手写的序列化迟早会漂，而这两条路径的差异恰恰最难被发现 ——
 * 一个落文件、一个入库，事后互相对不上就是「文件还是旧的」。
 *
 * @param {string} [name] 项目名；不给就用顶栏那个名字
 * @returns {Promise<object>} v2 扁平文件（format/version/elements/assets 平铺在顶层）
 */
async function projectFilePayload(name) {
    const label = String(name == null || name === '' ? projectLabel() : name);
    // v2 扁平文件：format/version/elements/frames/assets 全部平铺在顶层
    if (typeof store.docToFile === 'function') return store.docToFile(state.doc, { name: label });
    return {
        format: store.FORMAT,
        version: store.VERSION,
        name: label,
        savedAt: Date.now(),
        doc: store.docToJSON(state.doc),
    };
}

/**
 * 保存结果 → 一句提示（纯函数，Node 里可直接测）。
 *
 * 三种结局必须**可分辨**：库和文件都更新了 / 只进了库 / 库更新了但文件还是旧的。
 * 最后一种正是最容易让人丢工作成果的一种 —— 界面说「已保存」，磁盘上的交付物却是旧的。
 *
 * @param {{label?:string,file?:string,back?:{ok?:boolean,unsupported?:boolean,error?:string}}} r
 * @returns {{text:string,level:'info'|'error'}}
 */
export function saveFlash(r) {
    const res = r || {};
    const label = String(res.label == null ? '' : res.label);
    const file = String(res.file == null ? '' : res.file);
    const back = res.back && typeof res.back === 'object' ? res.back : {};
    if (!file) return { text: t('shell.save.doneLibrary', { label: label }), level: 'info' };
    if (back.ok) return { text: t('shell.save.doneWithFile', { label: label, file: file }), level: 'info' };
    if (back.unsupported) return { text: t('shell.save.writeBackUnsupported', { label: label }), level: 'error' };
    const msg = String(back.error || t('shell.saveFile.failedBase'));
    return { text: t('shell.save.writeBackFailed', { label: label, msg: msg }), level: 'error' };
}

/**
 * 把当前文档写回**已绑定**的 .msp（无对话框）。
 *
 * 只在 `project.file` 非空时调用：路径来自「打开 / 另存为」，不再弹保存框。
 * 失败必须把原因带回来 —— 库写成功之后，这一句是用户判断「磁盘上那份交付物
 * 是不是最新的」的唯一依据；静默或谎报成功都等于让他带着旧文件离开。
 *
 * @param {string} label 项目名（写进文件内容，不是路径）
 * @param {string} file 已绑定的绝对路径
 * @returns {Promise<{ok:true,file:string}|{ok:false,unsupported?:true,error?:string}>}
 */
async function writeBackProjectFile(label, file) {
    let json = '';
    try {
        json = JSON.stringify(await projectFilePayload(label));
    } catch (err) {
        return { ok: false, error: t('shell.saveFile.serializeFailed') };
    }
    if (!ipc.available()) return { ok: false, unsupported: true };
    let out = null;
    try {
        out = await Promise.resolve(ipc.saveProjectTo(file, json));
    } catch (err) {
        return { ok: false, error: (err && err.message) || String(err) };
    }
    if (!out) return { ok: false, error: t('shell.saveFile.noResponse') };
    if (out.ok === false) {
        if (out.unsupported) return { ok: false, unsupported: true };
        return { ok: false, error: String(out.error || t('shell.saveFile.failedBase')) };
    }
    if (!out.file) {
        // 回了成功却没给路径：与「存为文件」同一条判据，不替桥签收
        return { ok: false, error: t('shell.saveFile.noPath') };
    }
    return { ok: true, file: String(out.file) };
}

/**
 * 保存成功之后留一条版本快照（alpha.47）。
 *
 * 为什么单独包一层：历史是**附属**功能 —— 库已经写成功了，历史没写上只是少了
 * 「回到上一版」的能力，不能因此把保存结果改判成失败（用户会重按 Ctrl+S，
 * 而内容其实已经在库里）。所以这里只 console.error，不 flash、不抛。
 *
 * @param {{id:string,name?:string,savedAt?:number,project:object}} rec 完整库记录
 */
async function pushVersionQuietly(rec) {
    try {
        await store.pushVersion(rec);
    } catch (err) {
        // 日志留英文，不新增待迁文案
        console.error('[shell] failed to record a project version:', err);
    }
}

/**
 * 保存到项目库（无对话框，立即生效）。
 * 命名规则：显式 name > 当前项目名 > 弹一次内联输入框（问一次，取消就放弃）。
 * 两者并存：项目库 = 草稿箱，`.msp` 文件 = 正式交付 —— 所以入库成功后，**若已绑定文件
 * 就顺手回写**（Ctrl+S 的语义：写库 + 回写）；没绑定文件时就只入库，提示里说明用「另存为」。
 */
async function saveProject(name) {
    const doc = state.doc;
    if (!doc || saveBusy) return false;
    let label = String(name == null ? project.name || '' : name).trim();
    if (!label) {
        label = await askProjectName(defaultProjectName());
        label = String(label || '').trim();
        if (!label) {
            flash(t('shell.save.canceled'));
            return false;
        }
    }
    saveBusy = true;
    try {
        const rec = store.makeRecord({
            id: project.id || '',
            name: label,
            doc: doc,
            thumb: frameThumb(doc),
            file: project.file || '',
            // 保存不改「最近打开」：沿用打开时记下的值（没有就交给 makeRecord 退回 savedAt）
            openedAt: openedAtMs > 0 ? openedAtMs : undefined,
        });
        const saved = await store.putProject(rec);
        savedAtMs = (saved && saved.savedAt) || Date.now();
        project.id = (saved && saved.id) || rec.id;
        project.name = label;
        project.dirty = false;
        store.setCurrentProjectId(project.id);
        // 版本历史（alpha.47）：库里写成功之后留一条快照。失败只记日志 ——
        // 「历史没存上」是附属功能坏了，不能把一次真的保存判成失败。
        await pushVersionQuietly({ id: project.id, name: label, savedAt: savedAtMs, project: rec.project });
        // 两者并存：库是草稿箱、.msp 是交付物。绑定过文件就必须同时回写，
        // 否则「已保存」只对了一半，磁盘上那份还是旧内容（交接文档 §3.3 bug 2）。
        const file = String(project.file || '');
        const back = file ? await writeBackProjectFile(label, file) : { ok: true };
        const out = saveFlash({ label: label, file: file, back: back });
        flash(out.text, out.level);
        updateChrome();
        notifyProjects();
        return true;
    } catch (err) {
        console.error('[shell] 保存失败：', err);
        flash(t('shell.save.failed', { msg: (err && err.message) || err }), 'error');
        return false;
    } finally {
        saveBusy = false;
    }
}

/**
 * 把库里的项目（或当前文档）写成一个 .json/.msp 文件。
 *
 * @returns {Promise<{ok:true,file:string}|{ok:false,canceled?:true,error?:string}>}
 *   「写没写成」必须由返回值说清：老版本 ok:true 但 file 为空时什么都不说，
 *   界面上「存为文件」看起来成功了，磁盘上却没有东西。
 */
async function writeProjectFile(id, opts) {
    const o = opts || {};
    // quiet 只压「提示」，不压结果：静默调用方仍要能从返回值分辨成功与失败
    const report = (text) => (o.quiet ? failResult(text) : fail(text));
    let payload = null;
    if (id) {
        const rec = await store.getProject(id);
        if (rec && rec.project) payload = rec.project;
    }
    if (!payload) payload = await projectFilePayload();
    let json = '';
    try {
        json = JSON.stringify(payload);
    } catch (err) {
        return report(t('shell.saveFile.serializeFailed'));
    }
    if (!ipc.available()) {
        return report(t('shell.saveFile.noBridge'));
    }
    let out = null;
    try {
        out = await Promise.resolve(ipc.saveProject(projectLabel(), json));
    } catch (err) {
        console.error('[shell] 保存文件失败：', err);
        return report(t('shell.saveFile.threw', { msg: (err && err.message) || err }));
    }
    if (!out) {
        return report(t('shell.saveFile.noResponse'));
    }
    if (out.ok === false) {
        if (out.canceled) return o.quiet ? canceledResult(t('shell.saveFile.canceled')) : Object.assign(canceledResult(t('shell.saveFile.canceled')), {});
        return report(t('shell.saveFile.failed', { msg: out.error || t('shell.saveFile.failedBase') }));
    }
    if (!out.file) {
        // 回了成功却不给路径：主进程那一步一定没走完。宁可报失败，也不替它签收。
        return report(t('shell.saveFile.noPath'));
    }
    // 「另存为」在给文件定归属：**只有写的就是当前打开的项目**时才能改当前绑定。
    // 给别的卡片写文件时动 project.file 会出大事 —— 当前项目会被静默绑到别人的文件上，
    // 下一次 Ctrl+S 的回写就把当前内容覆盖进去（真丢数据的路径，本批必须堵住）。
    const sameProject = id ? String(id) === String(project.id || '') : true;
    // 库记录里的「绑定文件」跟着改：id 是卡片那条；没给 id 时是当前文档另存为。
    // 只改 file 字段，库里的内容仍是草稿内容 —— 下一次 Ctrl+S 才写内容。
    const targetId = id || (sameProject ? project.id || '' : '');
    /**
     * 同文件绑定冲突（alpha.46）：写之前这个路径可能已经绑在**另一条**库记录上。
     * 文件此刻已经写出去了，所以这里问的不是「要不要写」，而是「这个文件归谁」：
     * - 转移：把别人的 `file` 清空，本记录正常绑定（当前项目自己绑的也一并清内存）；
     * - 取消：**不回滚写盘**（文件已经写出来了，删掉它才是真的丢用户数据），
     *   保持原绑定不变，但要明确告诉用户「文件已写出、绑定没转」。
     */
    const owners = await fileOwners(out.file, targetId);
    if (owners.length) {
        const names = owners.map((row) => row.name || t('shell.project.untitled')).join(', ');
        const choice = await askChoice(
            t('shell.bindConflict.title'),
            [
                { label: t('shell.bindConflict.move'), value: 'move' },
                { label: t('shell.ask.cancel'), value: 'cancel' },
            ],
            t('shell.bindConflict.detail', { file: out.file, name: names })
        );
        if (choice !== 'move') {
            // 写盘已经发生、且不回滚：保住文件，只保住原绑定。错误档是为了不被
            // 下一条普通提示（画一笔、取个色）顶掉 —— 用户需要看见这次归属没变。
            flash(t('shell.bindConflict.keepOld', { file: out.file, name: names }), 'error');
            updateChrome();
            notifyProjects();
            return okResult({ file: out.file });
        }
        const moved = await takeOverFileBinding(targetId, out.file);
        if (moved.length) flash(t('shell.bindConflict.moved', { file: out.file, name: moved.join(', ') }));
        // 冲突记录一条都没清成（读库失败等）：至少别让「已保存」这件事消失
        else if (!o.quiet) flash(t('shell.saveFile.done', { path: out.file }));
    }
    if (sameProject) project.file = out.file;
    if (targetId) {
        const rec = await store.getProject(targetId);
        if (rec) {
            rec.file = out.file;
            await store.putProject(rec);
        }
    }
    if (!o.quiet && !owners.length) flash(t('shell.saveFile.done', { path: out.file }));
    updateChrome();
    notifyProjects();
    return okResult({ file: out.file });
}

/**
 * 导入整库备份包：逐条 `jsonToDoc` 校验后入库，**不切换当前文档**。
 *
 * 这是「恢复备份」，不是「打开一个项目」：用户可能正画到一半，导备份只是为了把
 * 换机器 / 清缓存之后的项目找回来。所以这里既不 applyDoc，也不清撤销栈。
 * 统计成功与失败数并如实报出来：部分损坏时用户必须知道恢复了几个、坏了几个，
 * 一句笼统的「已导入」会把失败的几条盖过去。
 *
 * @param {object} payload `isLibraryPayload` 认过的备份包
 * @returns {Promise<boolean>} 至少导入一条为 true
 */
async function importLibraryBundle(payload) {
    const items = Array.isArray(payload && payload.projects) ? payload.projects : [];
    let ok = 0;
    let failed = 0;
    for (const node of items) {
        try {
            const doc = await store.jsonToDoc(node);
            if (!doc) {
                failed += 1;
                continue;
            }
            const name = String((node && node.name) || (node && node.doc && node.doc.name) || t('shell.importFile.fallbackName'));
            const rec = store.makeRecord({ name, doc, thumb: frameThumb(doc), file: '' });
            const saved = await store.putProject(rec);
            if (saved) ok += 1;
            else failed += 1;
        } catch (err) {
            failed += 1;
        }
    }
    if (!ok) {
        flash(t('shell.importLibrary.none', { failed }), 'error');
        return false;
    }
    flash(t('shell.importLibrary.done', { n: ok, failed }));
    notifyProjects();
    return true;
}

/** 从 .json 导入：读文件 → 校验 → 入库 → 打开。 */
async function importProjectFile() {
    // 先问后选文件：让用户选完文件再告诉他「当前文档有改动」是浪费他的时间
    if (!(await beforeSwitch(t('shell.switch.import')))) return false;
    let out = null;
    try {
        out = await Promise.resolve(ipc.loadProject());
    } catch (err) {
        console.error('[shell] 打开文件失败：', err);
        out = null;
    }
    if (!out) {
        flash(t('shell.openDialog.noBridge'), 'error');
        return false;
    }
    if (out.ok === false) {
        if (out.canceled) flash(t('shell.openDialog.canceled'));
        else flash(out.error ? t('shell.openDialog.failedReason', { msg: out.error }) : t('shell.openDialog.failed'), 'error');
        return false;
    }
    let payload = out.json;
    if (typeof payload === 'string') {
        try {
            payload = JSON.parse(payload);
        } catch (err) {
            flash(t('shell.importFile.badJson'), 'error');
            return false;
        }
    }
    // 整库备份包（exportLibrary 写出的那种）先认：它跟单项目文件同为 .json，
    // 落到 isProjectPayload 只会得到 false —— 用户看到「不是项目文件」，
    // 而手里那 20 个项目一条都没回来。
    if (store.isLibraryPayload(payload)) return importLibraryBundle(payload);
    if (!store.isProjectPayload(payload)) {
        flash(t('shell.importFile.notProject'), 'error');
        return false;
    }
    // jsonToDoc 同时接受 v2 扁平文件、老信封 {doc:…} 与 v1 节点
    const doc = await store.jsonToDoc(payload);
    if (!doc) {
        flash(t('shell.importFile.corrupt'), 'error');
        return false;
    }
    const name = String(payload.name || baseName(out.file) || t('shell.importFile.fallbackName'));
    const rec = store.makeRecord({ name, doc, thumb: frameThumb(doc), file: out.file || '' });
    const saved = await store.putProject(rec);
    savedAtMs = (saved && saved.savedAt) || Date.now();
    const importedId = (saved && saved.id) || rec.id;
    applyDoc(doc, { id: importedId, name: rec.name, file: rec.file });
    openedAtMs = (await touchOpenedAt(importedId)) || Date.now();
    // 同一个 .msp 可能已经被另一条记录绑着：导入后这条记录就是「最后一次打开它」的，
    // 绑定静默转过来（不弹框 —— 用户点的是「导入」，不是在选「绑定归谁」）。
    const taken = await takeOverFileBinding(importedId, rec.file || '');
    if (taken.length) {
        flash(t('shell.bind.takenOnImport', { name: rec.name, file: rec.file || '', other: taken.join(', ') }));
    } else {
        flash(t('shell.importFile.done', { name: rec.name }));
    }
    notifyProjects();
    return true;
}

/** 载入项目：入参可以是库里的 id、轻量记录，或完整项目对象。 */
async function loadProject(entry) {
    try {
        let source = null;
        if (typeof entry === 'string') source = await store.getProject(entry);
        else if (entry && entry.project) source = entry;
        else if (entry && entry.id) source = await store.getProject(entry.id);
        if (!source || !source.project) {
            flash(t('shell.load.missing'), 'error');
            return false;
        }
        // 载入会整份换掉当前文档：有未保存改动时先处理，别静默丢掉
        if (!(await beforeSwitch(t('shell.switch.load')))) return false;
        const doc = await store.jsonToDoc(source.project.doc);
        if (!doc) {
            flash(t('shell.load.corrupt'), 'error');
            return false;
        }
        const ok = applyDoc(doc, { id: source.id, name: source.name, file: source.file });
        if (ok) {
            savedAtMs = Number(source.savedAt) || 0;
            // 「最近打开」写回库：列表按它排序时，打开过的项目就该排在前面
            openedAtMs = (await touchOpenedAt(source.id)) || Number(source.openedAt) || 0;
            // 同一个 .msp 被两条记录绑着时，最后打开它的这条拿走绑定（静默、不弹框）：
            // 用户刚亲眼打开的是这份内容，让另一条继续持有绑定，下次在那边 Ctrl+S 就会覆盖它
            const taken = await takeOverFileBinding(source.id, source.file);
            if (taken.length) {
                flash(t('shell.bind.takenOnLoad', { name: source.name, file: source.file, other: taken.join(', ') }));
            } else {
                flash(t('shell.load.done', { name: source.name || t('shell.project.fallbackName') }));
            }
        }
        return ok;
    } catch (err) {
        console.error('[shell] 载入项目失败：', err);
        flash(t('shell.load.failed', { msg: (err && err.message) || err }), 'error');
        return false;
    }
}

/** 新建空白项目（默认沿用 900×640 / 12 fps / 12 帧）。 */
async function newProject(opts) {
    const o = opts || {};
    if (!(await beforeSwitch(t('shell.switch.new')))) return false;
    const width = clampInt(o.width == null ? DEFAULT_W : o.width, 16, 8192);
    const height = clampInt(o.height == null ? DEFAULT_H : o.height, 16, 8192);
    const fps = Math.max(1, Math.min(120, Number(o.fps) > 0 ? Number(o.fps) : DEFAULT_FPS));
    const frames = clampInt(o.frames == null ? DEFAULT_FRAMES : o.frames, 1, 1200);
    // v6：没有帧数组，「帧数」只是「时长 = 帧数 / fps」的便捷说法
    // layerName 是**用户数据**（写进文档、进层级面板、落 .msp），不取词条 —— 见
    // core/doc-model.mjs 的 DEFAULT_OBJECT_NAME：跟界面语言走会让同一份文档混两种语言的对象名。
    const doc = createDocument({ width, height, fps, duration: frames / fps, layerName: o.layerName || DEFAULT_OBJECT_NAME });
    const ok = applyDoc(enrichDoc(doc), { id: '', name: '', file: '', dirty: false });
    if (ok) savedAtMs = 0;
    // 新文档还没有库记录：openedAt 先记在内存里，第一次入库时由 makeRecord 带进记录
    if (ok) openedAtMs = Date.now();
    if (ok) flash(t('shell.newProject.done', { w: width, h: height, frames, sec: (frames / fps).toFixed(2) }));
    return ok;
}

/**
 * 内联单行输入框（不用 window.prompt：Electron 里它默认不可用）。
 *
 * `askProjectName` 与 `editTags` 共用这一套 `.ms-ask` 外观，只有标签不同。
 * 返回值刻意区分「确认」与「取消」：
 * - Esc / 取消按钮 / 没有 DOM → `null`（调用方据此回 `canceled:true`）；
 * - 确认 → `trim` 后的字符串（**可能是空串**，表示把内容清空，不是取消）。
 * 旧版 askProjectName 两种都回 `''`，所以「清空标签」会被当成取消 —— 那正是这次
 * 抽成通用函数的原因。
 *
 * `askDepth` 与 askChoice 共用：项目库浮层的 Esc 监听挂在 window 捕获期，
 * 不挡一下的话，在输入框里按 Esc 会把整个项目库一起关掉。
 *
 * @param {string} def 预填值
 * @param {string} label 输入框前面的说明（已取好词条）
 * @returns {Promise<string|null>}
 */
function askInlineText(def, label) {
    if (
        typeof document === 'undefined' ||
        !document.body ||
        typeof window === 'undefined' ||
        !window ||
        typeof window.addEventListener !== 'function'
    ) {
        return Promise.resolve(null);
    }
    return new Promise((resolve) => {
        const host = shell.host || document.body;
        askDepth += 1;
        const box = el('div', 'ms-ask');
        box.style.position = 'absolute';
        box.style.left = '50%';
        box.style.top = '76px';
        box.style.transform = 'translateX(-50%)';
        box.style.zIndex = '9999';
        box.style.display = 'flex';
        box.style.gap = '8px';
        box.style.alignItems = 'center';
        box.style.padding = '10px 12px';
        box.style.background = '#1d2027';
        box.style.border = '1px solid #3a3f4b';
        box.style.borderRadius = '8px';
        box.style.color = '#e6e8ee';
        box.style.font = '12px/1.4 system-ui, sans-serif';

        box.appendChild(el('span', 'ms-ask-label', String(label || '')));
        const input = el('input', 'ms-ask-input');
        input.type = 'text';
        input.value = String(def || '');
        input.style.minWidth = '220px';
        const ok = el('button', 'ms-ask-ok', t('shell.ask.save'));
        ok.type = 'button';
        const cancel = el('button', 'ms-ask-cancel', t('shell.ask.cancel'));
        cancel.type = 'button';
        box.appendChild(input);
        box.appendChild(ok);
        box.appendChild(cancel);

        let done = false;
        function finish(value) {
            if (done) return;
            done = true;
            askDepth = Math.max(0, askDepth - 1);
            window.removeEventListener('keydown', onKey, true);
            if (box.parentNode) box.parentNode.removeChild(box);
            resolve(value);
        }
        function onKey(ev) {
            if (ev.key === 'Escape') {
                ev.preventDefault();
                ev.stopPropagation();
                finish(null);
            } else if (ev.key === 'Enter') {
                ev.preventDefault();
                ev.stopPropagation();
                finish(String(input.value || '').trim());
            }
        }
        ok.addEventListener('click', () => finish(String(input.value || '').trim()));
        cancel.addEventListener('click', () => finish(null));
        window.addEventListener('keydown', onKey, true);
        host.appendChild(box);
        try {
            input.focus();
            if (typeof input.select === 'function') input.select();
        } catch (err) {
            /* 拿不到焦点也不影响点击 */
        }
    });
}

/** 内联项目名输入框（取消与空输入都回 `''`，调用方按「没给名字」处理）。 */
function askProjectName(def) {
    return askInlineText(def, t('shell.ask.name')).then((v) => String(v == null ? '' : v));
}

/**
 * 通用二/三选浮层（复用 askProjectName 那套 .ms-ask 写法与外观，不另造一套弹窗）。
 * **危险选项不吃 Enter**：删除那类动作必须点到按钮上才算数，键盘一路 Enter 不该删掉项目。
 * @param {string} title
 * @param {Array<{label:string, value:string, danger?:boolean}>} options
 * @param {string} [detail] 第二行灰色说明（可空）
 * @returns {Promise<string|null>} 选中的 value；Esc / 关闭 / 无选项 → null
 */
function askChoice(title, options, detail) {
    if (typeof document === 'undefined' || !document.body) return Promise.resolve(null);
    const opts = Array.isArray(options) ? options.filter((o) => o && o.value) : [];
    if (!opts.length) return Promise.resolve(null);
    return new Promise((resolve) => {
        const host = shell.host || document.body;
        askDepth += 1;
        const box = el('div', 'ms-ask');
        box.style.position = 'absolute';
        box.style.left = '50%';
        box.style.top = '76px';
        box.style.transform = 'translateX(-50%)';
        box.style.zIndex = '9999';
        box.style.display = 'flex';
        box.style.gap = '8px';
        box.style.alignItems = 'center';
        box.style.padding = '10px 12px';
        box.style.background = '#1d2027';
        box.style.border = '1px solid #3a3f4b';
        box.style.borderRadius = '8px';
        box.style.color = '#e6e8ee';
        box.style.font = '12px/1.4 system-ui, sans-serif';

        box.appendChild(el('span', 'ms-ask-label', String(title || '')));
        if (detail) {
            const hint = el('span', 'ms-ask-detail', String(detail));
            hint.style.color = '#9aa3b2';
            box.appendChild(hint);
        }

        let done = false;
        function finish(value) {
            if (done) return;
            done = true;
            askDepth = Math.max(0, askDepth - 1);
            window.removeEventListener('keydown', onKey, true);
            if (box.parentNode) box.parentNode.removeChild(box);
            resolve(value);
        }
        function onKey(ev) {
            if (ev.key === 'Escape') {
                ev.preventDefault();
                ev.stopPropagation();
                finish(null);
            } else if (ev.key === 'Enter') {
                const safe = opts.find((o) => !o.danger);
                if (!safe) return;
                ev.preventDefault();
                ev.stopPropagation();
                finish(safe.value);
            }
        }
        for (const o of opts) {
            const b = el('button', 'ms-ask-' + o.value, String(o.label || o.value));
            b.type = 'button';
            if (o.danger) {
                b.style.borderColor = '#8a3a3a';
                b.style.color = '#ffb4b4';
            }
            b.addEventListener('click', () => finish(o.value));
            box.appendChild(b);
        }
        window.addEventListener('keydown', onKey, true);
        host.appendChild(box);
        const first = box.querySelector('button');
        if (first && typeof first.focus === 'function') {
            try {
                first.focus();
            } catch (err) {
                /* 拿不到焦点也不影响点击 */
            }
        }
    });
}

/**
 * 切换项目前的守门：没改动直接过；存过的先静默入库；未命名的先问一句。
 * @param {string} what 目标动作（「载入」「新建」「导入」），只用于提示文案
 * @returns {Promise<boolean>} true = 可以继续
 */
async function beforeSwitch(what) {
    const d = guardDecision({ dirty: project.dirty, id: project.id, name: project.name });
    if (d.action === 'proceed') return true;
    if (d.action === 'save-then-proceed') {
        const ok = await saveProject(project.name);
        if (!ok) flash(t('shell.switch.saveFailed', { what: what || t('shell.switch.action') }), 'error');
        return ok;
    }
    /**
     * 三选浮层开着时把项目库本体设为 inert：浮层只有中间一小块，
     * 不禁用的话用户还能点到库里的其它卡片，问「要不要保存」的同时又发一次载入。
     */
    const modalRoot = projectsModal && projectsModal.root;
    if (modalRoot) modalRoot.inert = true;
    let choice = null;
    try {
        choice = await askChoice(
            t('shell.guard.title'),
            [
                { label: t('shell.guard.save'), value: 'save' },
                { label: t('shell.guard.discard'), value: 'discard' },
                { label: t('shell.ask.cancel'), value: 'cancel' },
            ],
            t('shell.guard.detail', { what: what || t('shell.switch.continue') })
        );
    } finally {
        if (modalRoot) modalRoot.inert = false;
    }
    const out = choiceOutcome(choice);
    if (out.action === 'abort') return false;
    if (out.action === 'save') return await saveProject();
    return true;
}

/* 最近一次删除的暂存（8 秒内可撤销；不落存档、不加字段，纯内存）。 */
let pendingUndo = null;

function clearUndoBar() {
    const p = pendingUndo;
    pendingUndo = null;
    if (!p) return;
    if (p.timer) clearTimeout(p.timer);
    if (p.bar && p.bar.parentNode) p.bar.parentNode.removeChild(p.bar);
}

/** 删除后在项目库浮层底部挂一条「撤销删除」，8 秒后自己消失。 */
function holdUndoBar(rec) {
    if (!rec) return;
    clearUndoBar();
    const bar = el('div', 'ms-undo-bar');
    bar.style.display = 'flex';
    bar.style.alignItems = 'center';
    bar.style.gap = '10px';
    bar.style.padding = '8px 12px';
    bar.style.borderTop = '1px solid var(--line-2)';
    bar.style.background = 'var(--panel-2)';
    bar.style.font = '12px/1.4 system-ui, sans-serif';
    const text = el('span', 'ms-undo-text', t('shell.undoBar.deleted', { name: rec.name || t('shell.project.untitled') }));
    text.style.color = 'var(--ink-dim)';
    const btn = el('button', 'ms-undo-btn', t('shell.undoBar.undoDeleted'));
    btn.type = 'button';
    btn.style.border = '1px solid var(--accent)';
    btn.style.borderRadius = 'var(--r-1)';
    btn.style.background = 'transparent';
    btn.style.color = 'var(--ink)';
    btn.style.padding = '2px 9px';
    btn.style.cursor = 'pointer';
    bar.appendChild(text);
    bar.appendChild(btn);

    const timer = setTimeout(() => {
        clearUndoBar();
    }, 8000);
    pendingUndo = { rec, timer, bar };

    btn.addEventListener('click', async () => {
        const p = pendingUndo;
        if (!p || p.rec !== rec) return;
        clearUndoBar();
        await store.putProject(rec);
        // 撤销的正是「当前打开」那条时，把库身份接回去（文档一直在内存里，没动过）
        if (project.id === '' && !project.name) {
            project.id = rec.id;
            project.file = rec.file || '';
            project.name = rec.name || '';
            store.setCurrentProjectId(rec.id);
        }
        flash(t('shell.undoBar.restored', { name: rec.name || t('shell.project.untitled') }));
        updateChrome();
        notifyProjects();
    });

    // 浮层开着时贴在它的底部；浮层没开（或挂不上）就浮到窗口底部，
    // 否则撤销条会掉进普通文档流里，被顶栏盖住、点不到
    const box = projectsModal && projectsModal.box;
    if (box) {
        box.appendChild(bar);
    } else {
        bar.style.position = 'fixed';
        bar.style.left = '50%';
        bar.style.bottom = '18px';
        bar.style.transform = 'translateX(-50%)';
        bar.style.zIndex = '9999';
        bar.style.borderRadius = 'var(--r-2)';
        (shell.host || document.body).appendChild(bar);
    }
}

/**
 * 删除项目：先确认，再删，8 秒内可撤销。
 * 不动存档格式（不引入 deletedAt）—— 撤销靠内存里暂存整条记录。
 * @param {string} id
 * @returns {Promise<boolean>}
 */
async function removeProjectWithGuard(id) {
    let rec = null;
    try {
        rec = await store.getProject(id);
    } catch (err) {
        rec = null;
    }
    if (!rec) {
        flash(t('shell.remove.missing'), 'error');
        return false;
    }
    const isCurrent = project.id === id;
    const choice = await askChoice(deleteConfirmText(rec.name, isCurrent), [
        { label: t('shell.ask.delete'), value: 'delete', danger: true },
        { label: t('shell.ask.cancel'), value: 'cancel' },
    ]);
    if (choice !== 'delete') return false;
    const ok = await store.deleteProject(id);
    if (!ok) {
        flash(t('shell.remove.failed'), 'error');
        return false;
    }
    if (isCurrent) {
        // 删掉的是当前打开的项目：文档还在内存里，但已经没有库身份 —— 顶栏得跟着回到「未命名」
        project.id = '';
        project.file = '';
        project.name = '';
        openedAtMs = 0;
        store.setCurrentProjectId('');
        updateChrome();
        flash(t('shell.remove.outOfLibrary'));
    } else {
        flash(t('shell.undoBar.deleted', { name: rec.name || t('shell.project.untitled') }));
    }
    notifyProjects();
    holdUndoBar(rec);
    return true;
}

/* ────────── 项目库 P1 动作：库内复制 / 解除文件绑定 / 整库备份 ────────── */

/**
 * 库内复制（「另存为副本」）：只在库里多一条记录，**不动当前文档**。
 *
 * 为什么值得有：想从一份存档分叉出去（改个配色另存一版），以前只能
 * 「存为文件 → 再导回来」，每一步都在碰磁盘对话框。副本不继承文件绑定
 * （见 `store.duplicateProject`），所以它不会偷偷覆盖原项目的 .msp。
 *
 * @param {string} id 要复制的库记录 id
 * @returns {Promise<{ok:true,id:string,name:string}|{ok:false,error:string}>}
 */
async function duplicateProject(id) {
    let src = null;
    try {
        src = await store.getProject(id);
    } catch (err) {
        src = null;
    }
    if (!src) return fail(t('shell.duplicate.missing'));
    // 「副本」这类字眼按语言拼：store 只管数据，不管界面文案
    const name = t('shell.project.copyOf', { name: src.name || t('shell.project.untitled') });
    let rec = null;
    try {
        rec = await store.duplicateProject(id, { name });
    } catch (err) {
        rec = null;
    }
    if (!rec) return fail(t('shell.duplicate.failed'));
    flash(t('shell.duplicate.done', { name: rec.name }));
    notifyProjects();
    return okResult({ id: rec.id, name: rec.name });
}

/**
 * 解除当前项目与 .msp 文件的绑定（**不删文件**）。
 *
 * 为什么必须有显式入口：alpha.44 起绑定了文件就「Ctrl+S 连文件一起回写」，
 * 但没有任何地方能撤掉这个绑定 —— 打开过一次的文件会把之后每一次保存都写回它。
 * 用户想改成「只在库里当草稿」时，以前只能「另存为」到别的路径绕开。
 * 二次确认里写清「文件本身不删」，避免把「解除绑定」误读成「删文件」。
 *
 * @returns {Promise<{ok:true}|{ok:false,canceled?:true,error?:string}>}
 */
async function unbindFile() {
    const file = String(project.file || '');
    if (!file) return { ok: false, error: t('shell.unbind.none') };
    const choice = await askChoice(
        t('shell.unbind.title'),
        [
            { label: t('shell.unbind.confirm'), value: 'unbind', danger: true },
            { label: t('shell.ask.cancel'), value: 'cancel' },
        ],
        t('shell.unbind.detail', { file: file })
    );
    if (choice !== 'unbind') return { ok: false, canceled: true };
    project.file = '';
    // 库里那条记录也清掉绑定：否则下次「打开」这个项目，绑定又跟着记录回来了
    if (project.id) {
        try {
            const rec = await store.getProject(project.id);
            if (rec) {
                rec.file = '';
                await store.putProject(rec);
            }
        } catch (err) {
            // 库记录没清掉不影响本次动作：顶栏绑定已解除，下一次保存会写回库里
            console.error('[shell] failed to clear the bound file on the record:', err);
        }
    }
    updateChrome();
    notifyProjects();
    flash(t('shell.unbind.done'));
    return okResult();
}

/**
 * 导出整个项目库为一份 JSON 备份（走与视频/精灵图同一条 `saveBinaryChecked` 通道）。
 *
 * 为什么需要：库在本机浏览器 profile 的 IndexedDB 里，**清站点数据 = 全丢**；
 * 以前唯一的出路是逐个项目「存为文件」，几十个项目就要点几十次。
 * 备份包能被「导入文件」原样吃回来（`importProjectFile` 先认 `isLibraryPayload`）。
 *
 * @returns {Promise<{ok:true,file:string,count:number}|{ok:false,canceled?:true,error?:string}>}
 */
async function exportLibrary() {
    const records = await fullLibraryRecords();
    if (!records.length) return fail(t('shell.libraryExport.empty'));
    const bundle = store.libraryBundleOf(records);
    let json = '';
    try {
        json = JSON.stringify(bundle);
    } catch (err) {
        return fail(t('shell.libraryExport.serializeFailed'));
    }
    const saved = await ipc.saveBinaryChecked(
        'motionstudio-library',
        new TextEncoder().encode(json),
        'json',
        t('shell.libraryExport.dialogLabel')
    );
    if (!saved.ok) {
        if (saved.canceled) {
            flash(t('shell.libraryExport.canceled'));
            return canceledResult(t('shell.libraryExport.canceledShort'));
        }
        return fail(t('shell.libraryExport.failed', { msg: saved.error }));
    }
    flash(t('shell.libraryExport.done', { n: records.length, path: saved.file }));
    return okResult({ file: saved.file, count: records.length });
}

/* ────────── 项目库 P2 动作：置顶 / 标签 / 同文件绑定冲突（alpha.46） ────────── */

/**
 * 标签输入文本 → 标签数组（具名导出、纯函数，Node 里可直测）。
 *
 * 分隔符：逗号 `,`、中文逗号 U+FF0C、顿号 U+3001、分号 `;` / 中文分号 U+FF1B。
 * 用码点写而不是直接贴全角标点：本仓的 i18n 检查器把中文标点当「待迁文案」，
 * 正则字面量里的全角字符虽不该算，但能少一类需要解释的例外就少一类。
 * 清洗规则（去空 / 去重 / 8×24）**不在这里重写**，交给 `store.normalizeTags`：
 * 面板侧、库侧、输入侧只能有一份口径，否则「输入进去的标签」和「存下来的标签」会不一样。
 *
 * @param {unknown} text
 * @returns {string[]}
 */
export function parseTags(text) {
    const raw = String(text == null ? '' : text);
    if (!raw) return [];
    return store.normalizeTags(raw.split(/[\uFF0C,\u3001\uFF1B;]+/));
}

/**
 * 找「已经绑定到这个文件」的其它库记录（不含本次目标）。
 *
 * 用 `listProjects` 而不是 `getProject` 逐条读：列表视图里有 `file`，一条查询就够；
 * 库很小（几十条），不值得为它开一个索引。读库失败按「没有冲突」处理 ——
 * 冲突提示是锦上添花，不能因为它把一次已经成功的写盘判成失败。
 *
 * @param {string} file 绝对路径
 * @param {string} [exceptId] 本次要绑定的记录 id（当前文档还没入库时可空）
 * @returns {Promise<object[]>} 其它占用者的轻量记录
 */
async function fileOwners(file, exceptId) {
    const path = String(file || '');
    if (!path) return [];
    let rows = [];
    try {
        rows = await store.listProjects();
    } catch (err) {
        rows = [];
    }
    return (Array.isArray(rows) ? rows : []).filter(
        (row) => row && String(row.id) !== String(exceptId || '') && row.file === path
    );
}

/**
 * 把一条记录的 `file` 清空（只清绑定，不碰磁盘文件）。
 *
 * 若清空的正是「当前打开的项目」，内存里的 `project.file` 也要一起清：
 * 否则顶栏还指着那个文件，下一次 Ctrl+S 又会把当前内容写回一个已经被别的项目接管的路径。
 *
 * @param {string} id
 * @returns {Promise<boolean>} 真的清掉了一条返回 true
 */
async function clearFileBinding(id) {
    try {
        const rec = await store.getProject(id);
        if (!rec || !rec.file) return false;
        rec.file = '';
        await store.putProject(rec);
        if (project.id === id) project.file = '';
        return true;
    } catch (err) {
        // 只影响「谁拥有这个文件」的显示，不影响内容；日志留英文，不新增待迁文案
        console.error('[shell] failed to clear a file binding:', err);
        return false;
    }
}

/**
 * 把文件的绑定从别的记录转给 `id`（打开 / 导入路径用；静默、不弹框）。
 *
 * 同一个 `.msp` 被两条记录绑着时，「最后打开这条文件的那次」拥有它 —— 用户刚亲眼
 * 打开的就是这一份内容，让另一条记录继续持有绑定，下次在那边按 Ctrl+S 就会覆盖它。
 * @returns {Promise<string[]>} 被清掉绑定的项目名（没有冲突时空数组）
 */
async function takeOverFileBinding(id, file) {
    const owners = await fileOwners(file, id);
    const names = [];
    for (const row of owners) {
        // eslint-disable-next-line no-await-in-loop
        const cleared = await clearFileBinding(row.id);
        if (cleared) names.push(row.name || t('shell.project.untitled'));
    }
    return names;
}

/**
 * 收藏 / 取消收藏（置顶）。卡片右上角星标调用。
 *
 * 只改 `pinned` 一个字段（走 `store.updateProjectMeta` 白名单），内容与保存时间都不动：
 * 置顶是「我看得见」，不是「我改过」。
 * @param {string} id
 * @param {boolean} pinned
 * @returns {Promise<{ok:true,pinned:boolean}|{ok:false,error:string}>}
 */
async function setPinned(id, pinned) {
    const want = pinned === true;
    let saved = null;
    try {
        saved = await store.updateProjectMeta(id, { pinned: want });
    } catch (err) {
        saved = null;
    }
    if (!saved) return fail(t('shell.pin.failed'));
    flash(t(saved.pinned ? 'shell.pin.on' : 'shell.pin.off', { name: saved.name || t('shell.project.untitled') }));
    notifyProjects();
    return okResult({ pinned: saved.pinned === true });
}

/**
 * 编辑标签：弹内联输入框（逗号分隔、预填当前标签），确认后清洗并写库。
 *
 * 取消与「清空标签」必须能区分：取消返回 `canceled:true`，确认但输入为空则把标签清成 []。
 * @param {string} id
 * @returns {Promise<{ok:true,tags:string[]}|{ok:false,canceled?:true,error?:string}>}
 */
async function editTags(id) {
    let rec = null;
    try {
        rec = id ? await store.getProject(id) : null;
    } catch (err) {
        rec = null;
    }
    if (!rec) return fail(t('shell.tags.missing'));
    const current = store.normalizeTags(rec.tags);
    const text = await askInlineText(current.join(', '), t('shell.tags.ask'));
    if (text == null) return { ok: false, canceled: true };
    const tags = parseTags(text);
    let saved = null;
    try {
        saved = await store.updateProjectMeta(id, { tags: tags });
    } catch (err) {
        saved = null;
    }
    if (!saved) return fail(t('shell.tags.failed'));
    flash(t('shell.tags.done', { name: rec.name || t('shell.project.untitled'), n: tags.length }));
    notifyProjects();
    return okResult({ tags: saved.tags });
}

/* ────────── 项目库 P2 收尾：版本历史（alpha.47） ────────── */

/**
 * 快照时刻 → 列表里的一小段文字。
 *
 * 不走 i18n 的 fmtTime：外壳这一层没有面板的 `projects.time.today` 这类词条，
 * 而「今天 HH:MM / MM-DD HH:MM」全是数字与固定分隔，跨语言不需要翻译。
 * 时间格式故意用本地时区的月-日而不是 ISO 的 UTC：用户看的是自己钟表上的时间。
 */
function historyWhen(ts) {
    const ms = Number(ts);
    if (!Number.isFinite(ms) || ms <= 0) return '—';
    const d = new Date(ms);
    if (!Number.isFinite(d.getTime())) return '—';
    const p2 = (n) => (n < 10 ? '0' + n : String(n));
    const hm = p2(d.getHours()) + ':' + p2(d.getMinutes());
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    return sameDay ? hm : p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + hm;
}

/** 快照体积 → 人话（与面板的 fmtBytes 同口径，B / KB / MB）。 */
function historySize(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
}

/**
 * 「历史…」动作：列出最近 MAX_VERSIONS 条快照，选中并确认后恢复。
 *
 * 两级 askChoice（选哪一条 → 确认恢复）而不是一路点下去：恢复会整份换掉当前文档，
 * 必须给一次「我选的是这一条」的复核机会。取消是正常结局（`canceled:true`），
 * 面板侧 `run()` 只会说一句「已取消」，不报错。
 *
 * @param {string} projectId 库记录 id
 * @returns {Promise<{ok:true,count?:number,restored?:boolean,current?:boolean}
 *   | {ok:false,canceled?:true,error?:string}>}
 */
export async function openHistory(projectId) {
    const id = String(projectId == null ? '' : projectId);
    if (!id) return fail(t('shell.history.projectMissing'));
    let rows = [];
    try {
        rows = await store.listVersions(id);
    } catch (err) {
        rows = [];
    }
    if (!rows.length) {
        flash(t('shell.history.empty'));
        return okResult({ count: 0, restored: false });
    }
    const shown = rows.slice(0, store.MAX_VERSIONS);
    const options = shown.map((row) => ({
        label: t('shell.history.item', { time: historyWhen(row.at), size: historySize(row.bytes) }),
        value: String(row.id),
    }));
    options.push({ label: t('shell.ask.cancel'), value: 'cancel' });
    const picked = await askChoice(t('shell.history.title'), options, t('shell.history.detail'));
    if (!picked || picked === 'cancel') return { ok: false, canceled: true };
    const target = shown.find((row) => String(row.id) === String(picked));
    if (!target) return { ok: false, canceled: true };
    const confirmed = await askChoice(
        t('shell.history.confirmTitle'),
        [
            { label: t('shell.history.confirm'), value: 'restore' },
            { label: t('shell.ask.cancel'), value: 'cancel' },
        ],
        t('shell.history.confirmDetail', { time: historyWhen(target.at) })
    );
    if (confirmed !== 'restore') return { ok: false, canceled: true };
    return restoreVersion(id, picked);
}

/**
 * 恢复到指定快照（恢复本身可逆）。
 *
 * 顺序是刻意的：
 * 1. **先 push 当前状态** —— 当前项目取内存里的最新文档（可能还有未保存改动），
 *    别的项目取库里那条记录。恢复后用户还能从历史里选回「恢复前」那一版；
 * 2. 再把快照反序列化、换文档（只有恢复的是当前打开的项目才换，别的项目不动当前文档）；
 * 3. 最后把库里那条记录的内容也换成快照 —— 否则下次打开看到的还是恢复前的旧内容。
 *
 * 历史是附属功能：第 1 步失败只记日志，不挡住恢复本身（恢复仍然可用，只是少一层撤回）。
 *
 * @param {string} projectId
 * @param {string} vid 快照 id
 * @returns {Promise<{ok:true,restored:true,current:boolean,id:string}
 *   | {ok:false,canceled?:true,error:string}>}
 */
export async function restoreVersion(projectId, vid) {
    const id = String(projectId == null ? '' : projectId);
    const versionId = String(vid == null ? '' : vid);
    if (!id) return fail(t('shell.history.projectMissing'));
    if (!versionId) return fail(t('shell.history.versionMissing'));
    let version = null;
    try {
        version = await store.getVersion(versionId);
    } catch (err) {
        version = null;
    }
    if (!version || !version.project) return fail(t('shell.history.versionMissing'));
    let rec = null;
    try {
        rec = await store.getProject(id);
    } catch (err) {
        rec = null;
    }
    if (!rec) return fail(t('shell.history.projectMissing'));

    const isCurrent = String(project.id || '') === id;
    if (isCurrent) {
        // 当前项目：内存里的文档才是最真的一份（可能有还没入库的改动），先把它存成历史
        try {
            const current = store.makeRecord({
                id: id,
                name: project.name || version.name || '',
                doc: state.doc,
                file: project.file || '',
                openedAt: openedAtMs > 0 ? openedAtMs : undefined,
            });
            await pushVersionQuietly({ id: id, name: current.name, savedAt: current.savedAt, project: current.project });
        } catch (err) {
            console.error('[shell] failed to snapshot the current state before restoring:', err);
        }
    } else if (rec.project) {
        // 别的项目：恢复前那份内容同样要留一条，否则「恢复一下」就把库里的旧内容抹掉了
        await pushVersionQuietly({ id: id, name: rec.name, savedAt: rec.savedAt, project: rec.project });
    }

    const payload = version.project && version.project.doc ? version.project.doc : version.project;
    let doc = null;
    try {
        doc = await store.jsonToDoc(payload);
    } catch (err) {
        doc = null;
    }
    if (!doc) return fail(t('shell.history.corrupt'));

    if (isCurrent) {
        // 当前项目：整份换文档（撤销栈清空、脏位归零由 applyDoc 负责）
        if (!applyDoc(doc, { id: id, name: project.name, file: project.file })) {
            return fail(t('shell.history.corrupt'));
        }
        // 顶栏「上次保存」跟着快照走：恢复后的内容确实是那一版保存时的内容
        savedAtMs = Number(version.savedAt) || savedAtMs;
    }

    rec.project = version.project;
    rec.savedAt = Number(version.savedAt) || rec.savedAt;
    // 记录里的派生展示字段（尺寸 / 对象数 / 纹理时间点数 / 体积）跟着快照重算：
    // 它们是卡片 meta 的来源，不重算就会出现「恢复成 40×30，卡片还写着 64×64」。
    const restoredDoc = version.project && version.project.doc;
    if (restoredDoc && typeof restoredDoc === 'object') {
        const w = Number(restoredDoc.width);
        const h = Number(restoredDoc.height);
        if (Number.isFinite(w) && w > 0) rec.width = w;
        if (Number.isFinite(h) && h > 0) rec.height = h;
        const elements = Array.isArray(restoredDoc.elements) ? restoredDoc.elements : [];
        rec.layers = elements.length;
        const times = new Set();
        for (const el of elements) {
            const cels = el && Array.isArray(el.cels) ? el.cels : [];
            for (const cel of cels) {
                const at = Number(cel && cel.at);
                if (Number.isFinite(at)) times.add(at);
            }
        }
        rec.frames = times.size;
    }
    try {
        rec.bytes = JSON.stringify(version.project).length;
    } catch (err) {
        // 体积只是展示值：算不出来就沿用旧值，别让恢复因为一次统计失败而失败
    }
    const saved = await store.putProject(rec);
    if (!saved) return fail(t('shell.history.failed', { msg: t('shell.history.projectMissing') }));

    updateChrome();
    notifyProjects();
    const displayName = rec.name || t('shell.project.untitled');
    flash(
        isCurrent
            ? t('shell.history.restoredCurrent', { name: displayName, time: historyWhen(version.at) })
            : t('shell.history.restoredOther', { name: displayName, time: historyWhen(version.at) })
    );
    return okResult({ restored: true, current: isCurrent, id: rec.id });
}

/* ─────────────────── 未命名草稿 & 关窗口保护 ─────────────────── */

let safetyInstalled = false;

/**
 * 装「关窗口保护」。挂在这个模块而不是 app.mjs：判断要用 project.dirty 与 saveProject，
 * 两者都是本模块私有状态；app.mjs 只负责在启动钩子里调一次，避免 import 即副作用。
 */
export function installProjectSafety() {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return false;
    if (!safetyInstalled) {
        safetyInstalled = true;
        window.addEventListener('beforeunload', onBeforeUnload);
    }
    installAutoSaveTick();
    return true;
}

/* ─────────────────── 自动保存拍子（跟应用活，不跟面板活） ─────────────────── */

const AUTO_TICK_MS = 1000;
/**
 * 未命名文档的草稿节奏（秒）。
 *
 * 为什么不跟 `prefs.autoSave` 走：那个偏好默认是 0（关）。草稿不是「入项目库」，
 * 是刷新/崩溃之后唯一的找回路径 —— 挂在一个默认关掉的开关后面，等于没有保护
 * （Web 里刷新一下，整份未命名文档就没了）。所以草稿有自己的固定节奏，
 * 有名字的文档才听用户的「自动保存间隔」。
 */
const DRAFT_SEC = 3;
let autoTimer = 0;
let autoDirtyAt = 0;
let autoWasDirty = false;
let draftNoticed = false; // 草稿只在「这一轮变脏」说一次，别每 3 秒刷一遍顶栏
/**
 * 上一份草稿的内容签名。
 *
 * 为什么需要：命名项目存完会 `dirty = false`，草稿路径不会（文档确实还没进库），
 * 于是「已保存但没人动」的文档会一直脏着 —— 没有这道签名，拍子会每 3 秒重写一次
 * 完整文档 + 缩略图，闲置时白烧 CPU 和磁盘。签名一样就当作「草稿已是当前内容」。
 */
let draftSig = '';

/**
 * 1s 一拍的自动保存。
 *
 * 这个拍子以前挂在「设置」面板里（`prop-prefs.mjs`）：面板随工作区切换被销毁，
 * 定时器跟着 `clearInterval` —— 于是切到「编排」或「画板」之后自动保存悄悄停了，
 * 只有切回「设置」才恢复。挪到 shell：跟应用活，跟工作区无关。
 *
 * 间隔与开关仍读 `prefs.autoSave`（`prefSnapshot()`，单一来源），
 * **已命名项目静默入库、未命名写草稿共用这一个拍子**，不各开一个定时器。
 */
function installAutoSaveTick() {
    if (autoTimer || typeof setInterval !== 'function') return;
    autoTimer = setInterval(autoSaveTick, AUTO_TICK_MS);
    // node 里跑测试时别让这个拍子把进程吊住；浏览器没有 unref，判断存在再用
    if (autoTimer && typeof autoTimer.unref === 'function') autoTimer.unref();
}

function autoSaveTick() {
    const now = Date.now();
    const dirty = !!(project && project.dirty);
    if (dirty && !autoWasDirty) autoDirtyAt = now; // 由净转脏：从这一下开始算间隔
    if (!dirty) autoDirtyAt = 0;
    autoWasDirty = dirty;
    if (!dirty || !autoDirtyAt) {
        draftNoticed = false;
        return;
    }
    // 有名字：听用户的「自动保存间隔」（0 = 关，用户明确不要静默入库）
    // 没名字：走固定草稿节奏，草稿是刷新之后唯一的底
    const sec = project.name ? (Number(prefSnapshot().autoSave) || 0) : DRAFT_SEC;
    if (!sec) return;
    if (now - autoDirtyAt < sec * 1000) return;
    autoDirtyAt = now; // 先记账再存：保存期间的每一拍都不会重入
    void autoSaveProject();
}

function onBeforeUnload(ev) {
    const d = guardDecision({ dirty: project.dirty, id: project.id, name: project.name });
    if (d.action === 'proceed') return;
    if (d.action === 'save-then-proceed') {
        // 存过的：顺手再存一次然后放行 —— 每次关窗口都弹原生提示太吵，而且库里有底稿
        autoSaveProject();
        return;
    }
    // 未命名：必须问。浏览器原生对话框是唯一能真正拦住关闭的东西
    if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    if (ev) {
        try {
            ev.returnValue = t('shell.unload.confirm');
        } catch (err) {
            /* 有的实现里 returnValue 只读，preventDefault 已经够 */
        }
    }
    return t('shell.unload.confirm');
}

/**
 * 草稿内容签名：`savedAt` 固定成 0，只比内容不比「什么时候写的」，否则每次都不同。
 * 序列化不了就返回一个每次都不一样的东西 —— 让 putProject 去抛、让 catch 去报，
 * 别在这儿把错误悄悄变成「没变化，所以不写」。
 */
function draftSignature(doc) {
    try {
        return JSON.stringify(store.docToFile(doc, { savedAt: 0 }));
    } catch (err) {
        return '!' + Date.now();
    }
}

/** 未命名文档的自动保存：落一条草稿记录（列表里不显示），崩溃/误关之后能找回。 */
async function saveDraft(doc) {
    const rec = store.makeRecord({
        id: DRAFT_ID,
        name: draftName(''),
        doc,
        thumb: frameThumb(doc),
        file: '',
    });
    rec.__draft = true;
    await store.putProject(rec);
    return rec;
}

/** 启动时问一句「要不要恢复上次的草稿」。已经有正式项目时不打扰。 */
export async function restoreDraft() {
    if (project.id) return false;
    let rec = null;
    try {
        rec = await store.getProject(DRAFT_ID);
    } catch (err) {
        rec = null;
    }
    if (!rec || !rec.project || !isDraftRecord(rec)) return false;
    const choice = await askChoice(draftPromptText(rec.savedAt), [
        { label: t('shell.draft.restore'), value: 'restore' },
        { label: t('shell.draft.skip'), value: 'skip' },
    ]);
    if (choice !== 'restore') {
        await store.deleteProject(DRAFT_ID);
        draftSig = ''; // 草稿行了删了，签名不能还留着，否则下次会以为「已经写过」
        return false;
    }
    let doc = null;
    try {
        doc = await store.jsonToDoc(rec.project.doc);
    } catch (err) {
        doc = null;
    }
    await store.deleteProject(DRAFT_ID);
    draftSig = ''; // 同上：草稿记录没了，签名随之作废
    if (!doc) {
        flash(t('shell.draft.corrupt'), 'error');
        return false;
    }
    const ok = applyDoc(doc, { id: '', name: '', file: '', dirty: true });
    if (ok) openedAtMs = 0; // 草稿没有库记录，别让上一个项目的「最近打开」跟过来
    if (ok) flash(t('shell.draft.restored'));
    return ok;
}

/* 项目库浮层：不改用户的区域树，直接 mount 一份 projects 编辑器进浮层。 */
let projectsModal = null;

/** 关闭浮层：面板自己 destroy → 摘 DOM → 撤监听。顺序反了会留下订阅。 */
function closeProjectsModal() {
    const m = projectsModal;
    if (!m) return false;
    projectsModal = null;
    try {
        if (m.inst && typeof m.inst.destroy === 'function') m.inst.destroy();
    } catch (err) {
        console.error('[shell] 项目库浮层销毁失败：', err);
    }
    window.removeEventListener('keydown', m.onKey, true);
    m.root.removeEventListener('click', m.onMask);
    if (m.root.parentNode) m.root.parentNode.removeChild(m.root);
    return true;
}

/**
 * 空库时在浮层里加一个显眼的新建入口；库里有内容就把入口撤掉。
 * 重复打开浮层只 refresh 时也要重新判一次，否则空库时插进去的入口会一直留着。
 */
function syncProjectsCta(m) {
    if (!m || m !== projectsModal) return;
    Promise.resolve(store.listProjects())
        .then((items) => {
            if (m !== projectsModal) return;
            const body = m.body;
            const old = typeof body.querySelector === 'function' ? body.querySelector('.ms-modal-cta') : null;
            if (items && items.length) {
                if (old && old.parentNode) old.parentNode.removeChild(old);
                return;
            }
            if (old) return;
            const cta = el('div', 'ms-modal-cta');
            const iconBox = el('div', 'ms-modal-cta-icon');
            iconBox.innerHTML = icon('folder-open', { size: 'lg' });
            const tip = el('div', 'ms-modal-cta-tip', t('shell.library.empty'));
            const sub = el('div', 'ms-modal-cta-sub', t('shell.library.emptyHint'));
            const btn = el('button', 'ms-modal-cta-btn');
            btn.type = 'button';
            btn.innerHTML = icon('plus') + '<span>' + t('shell.library.newProject') + '</span>';
            btn.addEventListener('click', () => {
                // 先建后关：新建被取消（未保存改动的三选里点了取消）时浮层该留着
                void (async () => {
                    const ok = await newProject();
                    if (ok) closeProjectsModal();
                })();
            });
            cta.appendChild(iconBox);
            cta.appendChild(tip);
            cta.appendChild(sub);
            cta.appendChild(btn);
            // 列表区是 grid（auto-fill 卡片），CTA 在 grid 里跨满整行居中；
            // 没有列表容器时才退回面板顶部。
            const listHost = (typeof body.querySelector === 'function' && body.querySelector('.prj-list')) || null;
            if (listHost) listHost.appendChild(cta);
            else body.insertBefore(cta, body.firstChild || null);
        })
        .catch(() => {
            /* 读库失败时面板自己会给提示 */
        });
}

/**
 * 打开项目库浮层（顶栏「打开」与 Ctrl+O 都走这里）。
 * projects.mjs 本身就是普通编辑器（mount(host, ctx)），所以外壳只搭壳子、不复制列表逻辑。
 */
function openProjectsPanel() {
    if (typeof document === 'undefined' || !document.body) return false;
    if (projectsModal) {
        try {
            if (projectsModal.inst && typeof projectsModal.inst.refresh === 'function') projectsModal.inst.refresh();
        } catch (err) {
            /* 刷新失败不影响已经打开的浮层 */
        }
        syncProjectsCta(projectsModal);
        return true;
    }
    const host = shell.host || document.body;

    const root = el('div', 'ms-modal');
    root.style.position = 'fixed';
    root.style.inset = '0';
    root.style.zIndex = '60';
    root.style.display = 'flex';
    root.style.alignItems = 'center';
    root.style.justifyContent = 'center';
    root.style.background = 'rgba(8,9,11,.62)';

    const box = el('div', 'ms-modal-box');
    box.style.width = 'min(760px,82vw)';
    box.style.height = 'min(560px,76vh)';
    box.style.background = 'var(--panel)';
    box.style.border = '1px solid var(--line-2)';
    box.style.borderRadius = '8px';
    box.style.boxShadow = '0 24px 60px rgba(0,0,0,.5)';
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.overflow = 'hidden';

    const head = el('div', 'ms-modal-head');
    head.style.display = 'flex';
    head.style.alignItems = 'center';
    head.style.gap = '8px';
    head.style.padding = '10px 12px';
    head.style.borderBottom = '1px solid var(--line-2)';
    const title = el('strong', 'ms-modal-title', t('shell.library.title'));
    title.style.flex = '1 1 auto';
    const closeBtn = el('button', 'ms-modal-close', '✕');
    closeBtn.type = 'button';
    closeBtn.title = t('shell.library.close');
    closeBtn.style.cursor = 'pointer';
    head.appendChild(title);
    head.appendChild(closeBtn);

    const body = el('div', 'ms-modal-body');
    body.style.flex = '1 1 auto';
    body.style.minHeight = '0';
    body.style.overflow = 'auto';

    box.appendChild(head);
    box.appendChild(body);
    root.appendChild(box);
    host.appendChild(root);

    /** 点遮罩空白处关闭（点浮层内部不关）。 */
    const onMask = (ev) => {
        if (ev.target === root) closeProjectsModal();
    };
    /** Esc 关闭；正在重命名时把 Esc 让给面板（那是「取消重命名」）。 */
    const onKey = (ev) => {
        if (ev.key !== 'Escape') return;
        // 三选面板开着时 Esc 属于它（取消那次切换），不该顺手把整个项目库也关掉
        if (askDepth > 0) return;
        if (typeof root.querySelector === 'function' && root.querySelector('input.prj-rename')) return;
        // 卡片上「…」菜单开着时 Esc 属于它（关菜单）：实测原先会把整个库一起关掉
        if (typeof root.querySelector === 'function' && root.querySelector('.prj-menu:not([hidden])')) return;
        ev.preventDefault();
        ev.stopPropagation();
        closeProjectsModal();
    };
    root.addEventListener('click', onMask);
    closeBtn.addEventListener('click', () => closeProjectsModal());
    window.addEventListener('keydown', onKey, true);

    // 浮层里载入 / 新建之后自动收起，省得用户再点一次关闭
    const base = CTX.project || {};
    const modalCtx = Object.create(CTX);
    modalCtx.project = Object.assign({}, base, {
        open: async (id) => {
            const out = await base.open(id);
            // 只有真的载入了才收浮层：三选里点「取消」时库要留在原地，
            // 否则用户看到的是「库没了、改动还在、我到底取消了什么」
            if (out) closeProjectsModal();
            return out;
        },
        create: async (opts) => {
            const out = await base.create(opts);
            closeProjectsModal();
            return out;
        },
    });

    const def = editorDef('projects');
    let inst = null;
    if (def && typeof def.mount === 'function') {
        try {
            inst = def.mount(body, modalCtx);
        } catch (err) {
            console.error('[shell] 项目库浮层挂载失败：', err);
        }
    }
    projectsModal = { root, box, body, inst, onMask, onKey };

    // 库为空时给一个显眼的新建入口
    syncProjectsCta(projectsModal);

    return true;
}

/* ─────────────────── 导入：PSD / PNG / JPEG / WebP → 当前文档 ─────────────────── */

/**
 * 把导入结果落到当前文档。
 * 为什么不复用 applyDoc：导入是「往现有项目里加对象」，不是「换一个项目」，
 * 不能重置 project.id / file，也不能清掉撤销栈。setDoc 才是既有的就地修改入口。
 */
function commitImportedDoc(next, before) {
    const fn = CTX && typeof CTX.setDoc === 'function' ? CTX.setDoc : setDoc;
    try {
        if (canReplaceDoc(state.doc, before)) {
            // 快照就是当前文档（导入期间没人动过）：保持原来那条整体替换，行为零变化
            fn(next);
        } else {
            // 快照已过期（对话框期间换了项目 / 文档被改过）：只把新对象并进去，
            // 不拿旧快照覆盖用户这段时间的改动
            fn((cur) => mergeImportedDoc(cur, next));
        }
        if (CTX && typeof CTX.requestRender === 'function') CTX.requestRender();
        return true;
    } catch (err) {
        console.error('[shell] 导入落库失败：', err);
        return false;
    }
}

/** 导入成功后的一句话小结：把「尺寸不一致」这类常见坑直接说出来。 */
function importSummary(report) {
    const r = report || {};
    const doc = state.doc;
    let msg = t('shell.importResult.objects', { n: Number(r.imported) || 0 });
    if (r.kind === 'psd') {
        if (r.psdWidth && doc && (doc.width !== r.psdWidth || doc.height !== r.psdHeight)) {
            msg += t('shell.importResult.psd', { w: r.psdWidth, h: r.psdHeight, cw: doc.width, ch: doc.height });
        }
        if (r.hidden) msg += t('shell.importResult.hidden', { n: r.hidden });
    }
    // 位图：超大图会跳过自动裁边（IMAGE_TRIM_MAX_PIXELS）。这件事以前完全静默，
    // 用户只会看到「导入后四周空白特别多」，不知道为什么。
    if (r.kind === 'image' && r.trimSkipped === 'big') {
        msg += t('shell.importResult.trimBig', { w: r.width, h: r.height });
    }
    return msg;
}

/**
 * 导入 PSD / 位图到当前文档（顶栏「文件 → 导入」与项目库 API 共用）。
 * @param {'psd'|'image'} [scope] 收窄对话框类型；不给就是全支持
 * @returns {Promise<boolean>} 是否真的导入了对象
 */
async function importFileObjects(scope) {
    const exts = scope === 'psd' ? ['psd', 'psb'] : scope === 'image' ? ['png', 'jpg', 'jpeg', 'webp'] : null;
    // 抓一次快照：既给 pickAndImport 算居中/插入位置，也用来判断落库时文档有没有被换掉
    const before = state.doc;
    let res;
    try {
        res = await pickAndImport({ doc: before, exts });
    } catch (err) {
        console.error('[shell] 导入失败：', err);
        flash(t('shell.import.failedNoChange', { msg: (err && err.message) || err }), 'error');
        return false;
    }
    if (!res || !res.ok) {
        // 用户点了取消不算错误，不打扰
        if (!(res && res.canceled)) flash(t('shell.import.failedNoChange', { msg: (res && res.error) || t('shell.import.failed') }), 'error');
        return false;
    }
    if (!commitImportedDoc(res.doc, before)) {
        flash(t('shell.import.noDoc'), 'error');
        return false;
    }
    // 选中新导入的最上层对象：用户立刻能拖动、看属性、按 Ctrl+Z 撤回
    if (res.activeId && CTX && typeof CTX.setActiveLayer === 'function') CTX.setActiveLayer(res.activeId);
    flash(importSummary(res.report));
    markDirty();
    updateChrome();
    return true;
}

/**
 * 拖放导入：把拖进窗口的文件直接落到当前文档，不弹对话框。
 * files 是 [{ name, data }]，data 为 ArrayBuffer / Uint8Array（由外壳的 drop 监听读出来）。
 * 多个文件按拖入顺序依次叠加；全部失败时只 flash 第一条错误。
 * @returns {Promise<boolean>} 是否真的导入了对象
 */
async function importDropped(files) {
    const list = Array.isArray(files) ? files.filter((f) => f && f.data) : [];
    if (!list.length) {
        flash(t('shell.import.unreadable'), 'error');
        return false;
    }
    if (!state.doc) {
        flash(t('shell.import.noDoc'), 'error');
        return false;
    }
    let next = state.doc;
    let imported = 0;
    let lastId = null;
    const errors = [];
    let lastReport = null;
    for (const item of list) {
        let res;
        try {
            res = await importBuffer({ name: item.name, data: item.data }, { doc: next });
        } catch (err) {
            errors.push((err && err.message) || String(err));
            continue;
        }
        if (!res || !res.ok) {
            errors.push((res && res.error) || t('shell.import.failed'));
            continue;
        }
        next = res.doc;
        imported += Number(res.report && res.report.imported) || 0;
        lastReport = res.report;
        if (res.activeId) lastId = res.activeId;
    }
    if (!imported) {
        flash(errors[0] || t('shell.import.failed'), 'error');
        return false;
    }
    if (!commitImportedDoc(next)) {
        flash(t('shell.import.noDoc'), 'error');
        return false;
    }
    if (lastId && CTX && typeof CTX.setActiveLayer === 'function') CTX.setActiveLayer(lastId);
    flash(list.length > 1
        ? t('shell.import.dropped', { files: list.length, n: imported })
        : importSummary(lastReport));
    markDirty();
    updateChrome();
    return true;
}

/** 顶栏「文件」按钮分发。 */
function onFileAct(act) {
    if (act === 'new') {
        void newProject();
        return;
    }
    if (act === 'save') {
        void saveProject();
        return;
    }
    if (act === 'open') {
        openProjectsPanel();
        return;
    }
    // 导入 PSD / 图片：异步落地到当前文档，失败只 flash，不抛给顶栏
    if (act === 'import') {
        importFileObjects();
        return;
    }
    if (act === 'export') {
        // 菜单导出：先问选项（帧率 / 范围 / 缩放 / 背景 / 目录），不再静默导整段
        exportFrames();
        return;
    }
    if (act === 'undo') {
        engine.undo();
        return;
    }
    if (act === 'redo') {
        engine.redo();
        return;
    }
}

/* ───────────────────────── WebM 视频导出 ───────────────────────── */

/**
 * 把当前文档录成 WebM（不弹对话框、不写盘，纯内存）。导出与自检都用它。
 *
 * 做法：把 composeFrame 画到一张离屏 canvas 上，用 captureStream(0) 手动推帧，
 * 每帧之间按真实时间等待 —— MediaRecorder 的时间轴是墙上时钟，不等就会糊成一瞬。
 *
 * @param {object} [opts] { fps, seconds, onProgress(done,total) }
 * @returns {Promise<{ok:boolean, bytes?:ArrayBuffer, size?:number, mime?:string, frames?:number, fps?:number, seconds?:number, error?:string}>}
 */
export async function recordVideo(opts) {
    const o = opts || {};
    // project-io 不直接持有 ctx：它由 app.mjs 在 boot 时 setCtx 注入（见文件头 CTX）
    const doc = CTX && typeof CTX.doc === 'function' ? CTX.doc() : null;
    if (!doc) return { ok: false, error: t('shell.video.err.noDoc') };
    if (typeof MediaRecorder !== 'function') return { ok: false, error: t('shell.video.err.noRecorder') };
    if (typeof document === 'undefined' || !document.createElement) return { ok: false, error: t('shell.video.err.noDom') };
    const mime = pickVideoMime((m) => typeof MediaRecorder === 'function' && MediaRecorder.isTypeSupported(m));
    if (!mime) return { ok: false, error: t('shell.video.err.noMime') };

    const fps = videoFps(o.fps, doc.fps);
    const total = videoSeconds(o.seconds, totalSeconds(doc));
    const frames = videoFrameCount(total, fps);
    const size = videoCanvasSize(doc.width, doc.height);
    const w = size.width;
    const h = size.height;

    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d');
    if (!g) return { ok: false, error: t('shell.video.err.noContext') };

    let stream;
    let rec;
    try {
        stream = cv.captureStream(0);
        rec = new MediaRecorder(stream, {
            mimeType: mime,
            videoBitsPerSecond: videoBitrate(w, h, fps),
        });
    } catch (err) {
        return { ok: false, error: t('shell.video.err.startFailed', { msg: (err && err.message) || err }) };
    }
    const track = stream.getVideoTracks()[0] || null;
    const chunks = [];
    rec.ondataavailable = (e) => {
        if (e && e.data && e.data.size) chunks.push(e.data);
    };
    const stopped = new Promise((resolve) => {
        rec.onstop = () => resolve();
    });
    const stepMs = Math.max(4, Math.round(1000 / fps));
    // 第 32 批：`o.from` 让录制的起点跟着导出对话框的时间范围走（老调用不传，等价于 0）
    const fromSec = Math.max(0, Number(o.from) || 0);
    try {
        rec.start();
        for (let i = 0; i < frames; i += 1) {
            const t = fromSec + i / fps;
            compositeFrame(cv, doc, t, { clear: true, time: t });
            if (track && typeof track.requestFrame === 'function') track.requestFrame();
            if (typeof o.onProgress === 'function') o.onProgress(i + 1, frames);
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, stepMs));
        }
        // 末帧再停一拍，否则最后一帧常常没进封装
        await new Promise((r) => setTimeout(r, Math.max(120, stepMs * 2)));
    } finally {
        try {
            rec.stop();
        } catch (err) {
            /* 已经停了就算了 */
        }
        const live = stream.getTracks();
        for (const tk of live) {
            try {
                tk.stop();
            } catch (err) {
                /* 忽略 */
            }
        }
    }
    await stopped;
    const blob = new Blob(chunks, { type: mime });
    const bytes = await blob.arrayBuffer();
    if (!bytes.byteLength) return { ok: false, error: t('shell.video.err.empty') };
    return { ok: true, bytes, size: bytes.byteLength, mime, frames, fps, seconds: total };
}

/**
 * 导出 WebM：录完**必须**落盘。
 *
 * @returns {Promise<{ok:true,saved:true,file:string,size:number,frames:number,fps:number,seconds:number}
 *   | {ok:false,canceled?:true,error?:string}>}
 *   ok:true 代表「磁盘上真的有一个 WebM」，不是「内存里录了一段」。
 */
export async function exportVideo(opts) {
    // 录制依赖墙上时钟：窗口切到后台时 Chromium 会节流计时器，录出来会变慢甚至掉帧
    flash(t('shell.video.recording'));
    const r = await recordVideo(opts);
    if (!r.ok) {
        return fail(r.error || t('shell.video.failed'));
    }
    // 录制结果只在内存里：没有保存这一下，字节随函数返回就没了 —— 以前这里报「成功」，
    // 用户去找文件却发现什么都没有。落盘失败就是失败。
    const saved = await ipc.saveBinaryChecked(projectLabel(), r.bytes, 'webm', t('shell.video.dialogLabel'));
    if (!saved.ok) {
        if (saved.canceled) {
            flash(t('shell.video.saveCanceled', { n: r.frames }));
            return canceledResult(t('shell.video.saveCanceledShort'));
        }
        return fail(t('shell.video.saveFailed', { msg: saved.error }));
    }
    flash(t('shell.video.done', { frames: r.frames, kb: Math.round(saved.size / 1024), path: saved.file }));
    return okResult({
        saved: true,
        file: saved.file,
        size: saved.size,
        bytes: null,
        frames: r.frames,
        fps: r.fps,
        seconds: r.seconds,
    });
}

/** 注入给 projects.mjs 的接口（面板不认识存储细节）。 */
const projectApi = {
    list: () => store.listProjects(),
    current: currentProject,
    open: (id) => loadProject(id),
    create: (opts) => newProject(opts),
    save: (name) => saveProject(name),
    async rename(id, name) {
        const rec = await store.renameProject(id, name);
        if (!rec) return false;
        if (project.id === id) {
            project.name = rec.name;
            // 改名字不是改内容：不置脏、不触发自动保存、顶栏不该多出一个 •
            updateChrome();
        }
        return true;
    },
    // 删除有确认、8 秒内可撤销：全在 removeProjectWithGuard 里，面板只负责调
    remove: (id) => removeProjectWithGuard(id),
    // 库内复制（副本不继承文件绑定）：面板「复制」直接调
    duplicate: (id) => duplicateProject(id),
    // 解除当前项目的文件绑定（带二次确认，文件本身不删）
    unbindFile: () => unbindFile(),
    // 整库备份：库 → 一份 JSON；导入端 importFile 同时认这个备份包
    exportLibrary: () => exportLibrary(),
    // P2：收藏置顶 / 标签 / 排序 / 库统计（面板同步调 sortRows / totals，不 await）
    setPinned: (id, pinned) => setPinned(id, pinned),
    editTags: (id) => editTags(id),
    // P2 收尾：版本历史（列出最近 10 条快照，选中并确认后恢复；恢复前先存当前）
    history: (id) => openHistory(id),
    sortRows: (rows, mode) => store.sortProjects(rows, mode),
    totals: (rows) => store.libraryTotals(rows),
    // 项目文件（.msp/.json）→ 项目库。projectApi.importFile 保持这个语义：
    // projects.mjs 的「导入文件」按钮按项目导入写的提示文案（第 118/385 行）。
    importFile: () => importProjectFile(),
    // 位图 / PSD → 当前文档的新对象
    importPsd: () => importFileObjects('psd'),
    importImage: () => importFileObjects('image'),
    importObjects: () => importFileObjects(),
    importDropped,
    exportFile: (id) => writeProjectFile(id, {}),
    /**
     * 逐帧 PNG 导出。
     * - `exportFrames()` —— 弹导出对话框（第 32 批的新流程）；
     * - `exportFrames('工程名')` —— 旧调用，直接导整段，不弹框。
     */
    exportFrames: (arg) => exportFrames(arg),
    /** 只要有对话框的地方都走这个：`exportWithDialog('frames'|'sheet'|'video', preset)`。 */
    exportWithDialog,
    exportSpritesheet: (opts) => exportSpritesheet(opts),
    /** 导出当前帧为一张图片（走系统保存对话框）。菜单/命令面板挂这个。 */
    exportCurrentFrame: (opts) => exportCurrentFrame(opts),
    /**
     * 复制当前帧到剪贴板。三条降级路径（无 ClipboardItem / 无焦点 / 超时）
     * 都会自动改走「导出当前帧到文件」，提示文案各自不同。
     */
    copyFrameToClipboard: (opts) => copyFrameToClipboard(opts),
    recordVideo: (opts) => recordVideo(opts),
    exportVideo: (opts) => exportVideo(opts),
    subscribe: subscribeProjects,
    storage: () => store.storageKind(),
};

/** 启动时恢复上次打开的项目（没有就保持默认空白文档）。 */
async function restoreLastProject() {
    try {
        const id = store.currentProjectId();
        if (!id) return false;
        const rec = await store.getProject(id);
        if (!rec || !rec.project) return false;
        const doc = await store.jsonToDoc(rec.project.doc);
        if (!doc) return false;
        const ok = applyDoc(doc, { id: rec.id, name: rec.name, file: rec.file });
        if (ok) {
            savedAtMs = Number(rec.savedAt) || 0;
            openedAtMs = (await touchOpenedAt(rec.id)) || Number(rec.openedAt) || 0;
            flash(t('shell.restore.done', { name: rec.name || '' }));
        }
        return ok;
    } catch (err) {
        console.error('[shell] 恢复项目失败：', err);
        return false;
    }
}


export {
    exportFrames,
    exportGif,
    exportApng,
    exportSpritesheet,
    project,
    projectLabel,
    markDirty,
    notifyProjects,
    currentProject,
    saveProject,
    importProjectFile,
    loadProject,
    newProject,
    duplicateProject,
    unbindFile,
    exportLibrary,
    projectsModal,
    openProjectsPanel,
    onFileAct,
    importFileObjects,
    projectApi,
    restoreLastProject,
};

/**
 * 静默自动保存：只写项目库（IndexedDB），永不碰 .json 的保存对话框。
 * 为什么不直接复用 saveProject()：它会弹项目名输入框 —— 自动保存打断用户是不可接受的。
 * 未命名的文档也有去处：写一条草稿记录（列表里不显示），崩溃/误关之后能找回。
 * 返回 true 表示真的写了一次；正忙 / 无文档返回 false。
 */
export async function autoSaveProject() {
    const doc = state.doc;
    if (!doc || saveBusy) return false;
    const name = String(project.name || '').trim();
    saveBusy = true;
    try {
        if (!name) {
            // 命名要用户决定，但内容不能就这么悬在内存里
            const sig = draftSignature(doc);
            if (sig === draftSig) return true; // 内容没变：磁盘上那份草稿就是当前内容
            await saveDraft(doc);
            draftSig = sig;
            // 草稿每几秒写一次：只在变脏后第一次说，否则顶栏会被同一句话占满
            if (!draftNoticed) {
                draftNoticed = true;
                flash(t('shell.draft.saved'));
            }
            return true;
        }
        const rec = store.makeRecord({
            id: project.id || '',
            name,
            doc,
            thumb: frameThumb(doc),
            file: project.file || '',
            // 自动保存也不该刷新「最近打开」
            openedAt: openedAtMs > 0 ? openedAtMs : undefined,
        });
        const saved = await store.putProject(rec);
        project.id = (saved && saved.id) || rec.id;
        savedAtMs = (saved && saved.savedAt) || Date.now();
        project.dirty = false;
        store.setCurrentProjectId(project.id);
        // 自动保存也要留历史：否则用户只按自动保存时，「回到上一版」永远是空的。
        // 内容没变时 pushVersion 内部按指纹去重，不会每拍刷一条。
        await pushVersionQuietly({ id: project.id, name, savedAt: savedAtMs, project: rec.project });
        // 自动保存也是一次「保存」：绑定了文件就一起回写，否则库里有底、磁盘上是旧的，
        // 用户关掉窗口后打开 .msp 会少掉最后一次自动保存的内容（与 §3.3 bug 2 同一种骗法）。
        // 成功时沿用「已自动保存」那句（每 N 秒刷一条长句太吵），失败必须用错误档说出来。
        const file = String(project.file || '');
        const back = file ? await writeBackProjectFile(name, file) : { ok: true };
        if (file && !back.ok) flash(saveFlash({ label: name, file: file, back: back }).text, 'error');
        else flash(t('shell.autosave.done', { name }));
        updateChrome();
        notifyProjects();
        return true;
    } catch (err) {
        // 以前这里只 console.error：用户以为在自动保存，实际上一次都没成 —— 必须说出来
        console.error('[shell] 自动保存失败：', err);
        flash(t('shell.autosave.failed', { msg: (err && err.message) || err }), 'error');
        return false;
    } finally {
        saveBusy = false;
    }
}
