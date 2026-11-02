/**
 * MotionStudio —— 外壳入口：编排 / ctx / 调试门面 / 快捷键 / 启动
 *
 * 拆分后的分工（全部在 app/shell/ 下，按「谁拥有状态」划边界）：
 *   doc-state.mjs   唯一可变状态（state / engine / shell）+ 文档与播放时钟 + 面板刷新
 *   view-host.mjs   区域树、几何排布、编辑器挂载 / 销毁、分隔条拖拽
 *   commands.mjs    对象 / 关键帧 / 效果器的写命令
 *   project-io.mjs  导出（PNG / 精灵图）、项目库、.json 存档
 *   app.mjs         本文件：把上面四块拼起来 —— ctx（编辑器的外壳契约）、
 *                   window.motionStudio 调试门面、全局快捷键、DOM 骨架与启动
 *
 * 时间模型（契约 v6）：帧对象已删除，内容单位是「纹理」——`obj.cels = [{ at, image }]`，
 * at 是秒，纹理从 at 起一直生效到下一个纹理。纹理命令（addCelAt / removeCelAt /
 * clearCelAt / moveCel / celTimesOf / goPrevCel / goNextCel）全部定义在本文件，
 * 时间轴与画布只通过 ctx 调它们；落笔入口是 ctx.ensureCelImage(layerId, w, h)。
 *
 * 设计要点（契约 §9）：
 * 1. 每个工作区（animate / draw / free）拥有**独立的一棵区域树 + 一套 DOM**。
 *    所有区域都是 #ws-host 的直接绝对定位子对象；切工作区只切 display，不销毁编辑器。
 * 2. 布局几何完全由 layout.mjs 的 computeRects 求出来，外壳只写 left/top/width/height，
 *    拖分隔条期间**绝不重建 DOM**（画布引擎的 canvas 不搬家，撤销栈不清空）。
 * 3. 编辑器实例按区域缓存，同一个区域换编辑器才 destroy + 重挂；
 *    画布是本工作区的单实例，区域搬家时调用 editors/canvas.mjs 的 placeCanvas 搬宿主。
 * 4. 文档不可变：所有修改走 setDoc(updater)，由 doc-state 统一广播、重绘、刷新面板。
 *
 * 依赖方向：本文件是唯一根；view-host / project-io 反向 import 只为运行期拿 ctx，初始化期不会读到未初始化的值。

 */
import {
    celTimes,
    createDocument as createTimeDocument,
    ensureCelAt,
    hasCelAt,
    swapCelAt,
    imageAt,
    moveCel as moveCelDoc,
    addObject,
    objectById,
    objectsOf,
    patchObject,
    removeCelAt as removeCelAtDoc,
    setImageAt,
    setKeyDrawing,
    setObjectSize as setObjectSizeDoc,
    drawingsOf,
    addDrawing,
    objectSize,
    placeDrawing as placeDrawingDoc,
    makeUnique as makeUniqueDoc,
    removeDrawing as removeDrawingDoc,
    removeObject as removeObjectDoc,
    drawingIdAt,
    totalSeconds,
} from '../core/doc-model.mjs';
import { addKey, createTrack, matrixOf, setKeyState, stateAt } from '../core/transform.mjs';
import { SKIN_DEFAULTS, bindSkin, normalizeSkin, skinOf } from '../core/skin.mjs';
import { isIdentityTime } from '../core/timegraph.mjs';
import { createSurface, cloneSurface } from '../paint/surface.mjs';
import { alignOffset, clampTextureSize, contentBounds, cropRgba, placeRgba } from '../paint/trim.mjs';
import { ONION_DEFAULTS } from '../paint/onion.mjs';
import { createEvaluator } from '../core/evaluator.mjs';
import { EFFECT_DEFS, defaultEffect, normalizeEffect } from '../paint/effects.mjs';
import { TOOLS } from '../paint/engine.mjs';
import { editorIds } from './registry.mjs';
import { timeCtx } from './ctx-time.mjs';
import { buildTopbar, buildStatusbar } from './chrome.mjs';
import { createPalette } from './command-palette.mjs';
import { createShortcutsOverlay } from './shortcuts-overlay.mjs';
// 键位/图例的唯一数据源：设置里的键位表、帮助面板、`?` 浮层都读它
import { overlayGroups } from '../editors/help.mjs';
import { installLayerKeys } from '../editors/layer-keys.mjs';
import { loadLayout } from './persist.mjs';
import * as canvasEditor from '../editors/canvas.mjs';
import * as DS from './doc-state.mjs';
import { DEFAULT_OBJECT_NAME, nextObjectName } from '../core/doc-model.mjs';

import {
    buildViews,
    syncActiveTree,
    setWorkspace,
    resetLayout,
    render,
    syncCanvasToActive,
    scheduleAttachToActive, remountAll, setCtx as setViewHostCtx } from './view-host.mjs';
// 本地化：换表 + `<html lang>` 在这里收口。面板不能自己引 view-host（会与 registry 成环），
// 所以切语言经 ctx.setLocale 转一手（见 buildCtx）。
import { t, setLocale as setI18nLocale, getLocale, htmlLangOf } from '../i18n/index.mjs';
import {
    setEffectParam,
    keyEffectParam,
    clearEffectParam,
    setLayerEffects,
    writeKeyAt,
} from './commands.mjs';

import {
    exportFrames,
    exportSpritesheet,
    project,
    projectLabel,
    currentProject,
    saveProject,
    importProjectFile,
    loadProject,
    newProject,
    projectsModal,
    openProjectsPanel,
    onFileAct,
    projectApi,
    restoreLastProject,
    restoreDraft,
    installProjectSafety,
    setCtx as setProjectIoCtx } from './project-io.mjs';

// 顶层只拿 namespace。绑定推迟到 boot()：这台 Electron 上 doc-state 的求值时机
// 不稳定，顶层解构会静默拿到 undefined（表现为整个 app 白屏）。
let TOOL_KEYS, DEFAULT_W, DEFAULT_H, DEFAULT_FPS, state, shell, el, engine,
    setDoc, subscribeDoc, setTime, setPlaying, playSpeed, setPlaySpeed, scheduleRefresh, flash, hintText,
    updateChrome, setTimeClamped, stepFrames, setDuration, fpsNow, goToKey;


/* ─────────────────── 纹理命令（纯时间模型，契约 v6） ─────────────────── */

/**
 * 帧对象已彻底删除：内容的唯一单位是「纹理」——`obj.cels = [{ at, image }]`，
 * at 是秒，纹理从 at 起一直生效到下一个纹理。下面这组是外壳唯一的纹理写入口，
 * 时间轴模块只认这四个名字：addCelAt / removeCelAt / clearCelAt / moveCel。
 */

/**
 * 交换同一对象里两个纹理的时刻（纹理栈拖动重排用）。
 * 时刻本身是内容的地址，所以「重排」= 两个 at 互换，位图各自跟着自己的格走。
 */
function swapCelTimes(objId, tA, tB) {
    const doc = state.doc;
    const id = celTargetId(objId);
    if (!doc || id == null) return false;
    const next = swapCelAt(doc, id, tA, tB);
    if (next === doc) return false;
    setDoc(() => next, { label: t('shell.undo.swapCel') });
    return true;
}

/** 把对象替换进文档（容器键不变：objects 优先，兼容还带 layers 的旧 doc）。 */
function replaceObject(doc, objId, nextObj) {
    if (Array.isArray(doc.objects)) {
        return Object.assign({}, doc, { objects: doc.objects.map((o) => (o && o.id === objId ? nextObj : o)) });
    }
    if (Array.isArray(doc.layers)) {
        return Object.assign({}, doc, { layers: doc.layers.map((o) => (o && o.id === objId ? nextObj : o)) });
    }
    return doc;
}

/** 目标对象 id：显式传入 > 当前选中 > 第一个对象。 */
function celTargetId(objId) {
    const doc = state.doc;
    if (!doc) return null;
    if (objId) return String(objId);
    if (state.activeLayerId && objectById(doc, state.activeLayerId)) return state.activeLayerId;
    const first = objectsOf(doc)[0];
    return first ? first.id : null;
}

function celTimeArg(t) {
    const v = Number(t);
    if (Number.isFinite(v)) return Math.max(0, v);
    return Math.max(0, Number(state.time) || 0);
}

/** 画布尺寸的空位图（新纹理用）。 */
/** 造一张指定尺寸的空位图（对象改尺寸时用）。 */
function blankSurfaceOf(w, h) {
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w));
    cv.height = Math.max(1, Math.round(h));
    return cv;
}

/**
 * 读出一张位图的像素。canvas / OffscreenCanvas 有 `getContext`，直接读；
 * `ImageBitmap` 与 `<img>` 没有 —— 画一次到临时画布再读。
 * （alpha.4 的 `pixelAlpha` 就是因为假设有 `getContext`，导入的位图永远读成 alpha 0。）
 */
function readRgba(image) {
    if (!image) return null;
    const w = Math.floor(Number(image.width) || 0);
    const h = Math.floor(Number(image.height) || 0);
    if (!(w > 0) || !(h > 0)) return null;
    if (typeof image.getContext === 'function') {
        try {
            const g = image.getContext('2d', { willReadFrequently: true });
            if (g && typeof g.getImageData === 'function') {
                const d = g.getImageData(0, 0, w, h);
                if (d && d.data && d.data.length >= w * h * 4) return { w, h, data: d.data };
            }
        } catch (err) {
            // 落到下面的通用路径
        }
    }
    let cv = null;
    try {
        cv = createSurface(w, h);
    } catch (err) {
        return null;
    }
    const g2 = cv && cv.getContext ? cv.getContext('2d', { willReadFrequently: true }) : null;
    if (!g2) return null;
    try {
        g2.drawImage(image, 0, 0);
        const d = g2.getImageData(0, 0, w, h);
        if (d && d.data && d.data.length >= w * h * 4) return { w, h, data: d.data };
    } catch (err) {
        return null;
    }
    return null;
}

/** 把一段紧凑 RGBA 写进新画布（`createSurface` 决定用 OffscreenCanvas 还是 <canvas>）。 */
function surfaceFromRgba(w, h, data) {
    const W = Math.max(1, Math.round(Number(w)) || 1);
    const H = Math.max(1, Math.round(Number(h)) || 1);
    if (!data || data.length < W * H * 4) return null;
    let cv = null;
    try {
        cv = createSurface(W, H);
    } catch (err) {
        return null;
    }
    const g = cv && cv.getContext ? cv.getContext('2d', { willReadFrequently: true }) : null;
    if (!g) return null;
    try {
        g.putImageData(new ImageData(data, W, H), 0, 0);
        return cv;
    } catch (err) {
        return null;
    }
}

/** 当前时刻生效的关键帧下标（最后一个 `t <= time`）；轨道为空返回 -1。 */
function activeKeyIndex(track, time) {
    const keys = track && Array.isArray(track.keys) ? track.keys : [];
    let idx = -1;
    for (let i = 0; i < keys.length; i += 1) {
        if (!keys[i]) continue;
        if (Number(keys[i].t) <= time + 1e-9) idx = i;
        else break;
    }
    return idx;
}

function blankSurface(doc) {
    const w = Math.max(1, Math.round(Number(doc && doc.width) || 1));
    const h = Math.max(1, Math.round(Number(doc && doc.height) || 1));
    try {
        return createSurface(w, h);
    } catch (err) {
        return null;
    }
}

/** 该对象在时间 t 生效的位图（画布 / 图层面板预览用，只读）。 */
function celImageOf(objId, t) {
    const doc = state.doc;
    const obj = doc ? objectById(doc, celTargetId(objId)) : null;
    if (!obj) return null;
    return imageAt(obj, t == null ? state.time : celTimeArg(t));
}

/**
 * 在时间 t 建纹理。
 * 默认**继承**前一张纹理的内容（拷一份独立位图）—— 这是动画里最常见的动作：
 * 在上一格的基础上改。要空白就在时间轴上右键「清空此纹理内容」。
 * 返回纹理落在的时间点。
 */
function fpsOfDoc() {
    const doc = state.doc;
    const f = doc && Number(doc.fps);
    return Number.isFinite(f) && f > 0 ? f : DEFAULT_FPS;
}

/**
 * 判断某个帧槽是否已被占用。
 * 不能用 hasCelAt 的 1e-6 容差：历史数据里存在 0.167 这种「非整帧对齐」的纹理，
 * 而新落点会按帧网格算成 0.166666，两者按 1e-6 算不等，就会在旁边多造一格。
 * 这里按「半个帧」判占用，视觉上同一帧就算同一格。
 */
function celSlotTaken(obj, at) {
    const fps = fpsOfDoc();
    const half = 0.5 / fps;
    return celTimes(obj).some((t) => Math.abs(t - at) < half);
}

/** 从 t 开始往后找一个「还没有纹理」的帧边界（最多找 240 帧，防死循环）。 */
function findFreeCelTime(obj, t) {
    const fps = fpsOfDoc();
    const step = 1 / fps;
    const base = Math.max(0, Math.round((Number(t) || 0) * fps) / fps);
    for (let i = 0; i < 240; i += 1) {
        const at = Math.round((base + i * step) * fps) / fps;
        if (!celSlotTaken(obj, at)) return { at, moved: i > 0 };
    }
    return { at: base, moved: false };
}

function addCelAt(objId, when) {
    const doc = state.doc;
    const id = celTargetId(objId);
    if (!doc || !id) return null;
    const at = celTimeArg(when);
    let placed = at;
    let moved = false;
    setDoc((d) => {
        const obj = objectById(d, id);
        if (!obj) return d;
        // 该时刻已经有纹理时不能静默失败（用户会觉得「加纹理没反应」）：
        // 顺延到下一个还没有纹理的帧边界，落点回报给调用方。
        const spot = findFreeCelTime(obj, at);
        moved = spot.moved;
        const res = ensureCelAt(obj, spot.at, { inherit: true });
        placed = res.cel ? res.cel.at : spot.at;
        const cur = res.cel || { at: placed, image: null };
        // 新纹理必须有可画的位图；继承来的图要拷一份，否则改一格会改坏上一格
        let image = cur.image;
        if (image) {
            try {
                image = cloneSurface(image);
            } catch (err) {
                image = blankSurface(d);
            }
        } else {
            image = blankSurface(d);
        }
        // 走真源：新图登记进纹理库，这一格的关键帧 drawing 指向它（cels 由 projectCels 重算）
        return replaceObject(d, id, setImageAt(res.obj, placed, image));
    });
    if (moved) flash(t('shell.cel.moved', { t: placed.toFixed(2) }));
    return placed;
}

/** 删掉时间 t 的纹理；对象只剩一个纹理时拒绝并提示。 */
function removeCelAt(objId, when) {
    const doc = state.doc;
    const id = celTargetId(objId);
    if (!doc || !id) return false;
    const obj = objectById(doc, id);
    if (!obj) return false;
    if (celTimes(obj).length <= 1) {
        flash(t('shell.cel.keepOne'), 'error');
        return false;
    }
    const at = celTimeArg(when);
    const nextObj = removeCelAtDoc(obj, at);
    if (!nextObj || nextObj === obj) {
        flash(t('shell.cel.noneAt'), 'error');
        return false;
    }
    setDoc((d) => replaceObject(d, id, nextObj));
    flash(t('shell.cel.removed', { t: at.toFixed(2) }));
    return true;
}

/** 把时间 t 纹理的内容清空（纹理保留，image 置 null = 这一段全透明）。 */
function clearCelAt(objId, when) {
    const doc = state.doc;
    const id = celTargetId(objId);
    if (!doc || !id) return false;
    const at = celTimeArg(when);
    let cleared = false;
    setDoc((d) => {
        const obj = objectById(d, id);
        if (!obj) return d;
        const res = ensureCelAt(obj, at, { inherit: true });
        if (!res.cel) return d;
        cleared = true;
        // 清空 = 这一格成为「空白曝光」：关键帧仍在、drawing 置 null（keyHasDrawing 为真）
        return replaceObject(d, id, setKeyDrawing(res.obj, res.cel.at, null));
    });
    if (cleared) flash(t('shell.cel.cleared'));
    return cleared;
}

/**
 * 落笔前保证「当前时间有可写纹理」，返回位图（契约 D 的唯一入口）。
 * 没有纹理就 inherit:true 建一个：继承上一格像素，但整条链路与帧无关。
 */
function celImageForPaint(layerId, w, h) {
    const doc = state.doc;
    const id = celTargetId(layerId);
    if (!doc || !id) return null;
    const obj = objectById(doc, id);
    if (!obj) return null;
    const t = state.time;
    const res = ensureCelAt(obj, t, { inherit: true });
    const cur = res.cel;
    if (cur && cur.image && !res.created) return cur.image;
    // 新纹理继承到的是上一格的位图**引用**：必须克隆，否则落笔会改坏上一格。
    // 克隆体要走 setImageAt 才会进纹理库、成为这一格的 drawing（只换 cels 镜像渲染侧读不到）。
    const image = cur && cur.image
        ? cloneSurface(cur.image)
        : createSurface(Math.max(1, Math.round(Number(w) || 1)), Math.max(1, Math.round(Number(h) || 1)));
    if (!image) return null;
    const at = cur && Number.isFinite(cur.at) ? cur.at : celTimeArg(t);
    setDoc((d) => replaceObject(d, id, setImageAt(res.obj, at, image)));
    return image;
}

/**
 * 把「当前时刻这张纹理」整张换成给定的图（一次 setDoc、一步撤销）。
 *
 * 用途：导入位图是 `ImageBitmap`（没有 `getContext`），画板上不能直接往上画。
 * 需要落笔时先在离屏画布上改好，再用这里写回关键帧上的 drawing ——
 * 与 `celImageForPaint` 的克隆体写回同一条路径（`setImageAt`），
 * 所以纹理库、渲染侧、存档三者看到的都是真源。
 *
 * @param {string} [layerId] 目标对象；不给就用当前活动对象
 * @param {*} image 画布或位图
 * @returns {boolean} 是否真的写入了
 */
function setCelImage(layerId, image) {
    const doc = state.doc;
    const id = celTargetId(layerId);
    if (!doc || !id || !image) return false;
    const obj = objectById(doc, id);
    if (!obj) return false;
    const t = state.time;
    const res = ensureCelAt(obj, t, { inherit: true });
    const at = res.cel && Number.isFinite(res.cel.at) ? res.cel.at : celTimeArg(t);
    setDoc((d) => replaceObject(d, id, setImageAt(res.obj, at, image)), { label: t('shell.cel.replaceImage') });
    return true;
}

/** 把纹理从 fromT 挪到 toT（目标时间已有纹理则覆盖）。 */
function moveCel(objId, fromT, toT) {
    const doc = state.doc;
    const id = celTargetId(objId);
    if (!doc || !id) return false;
    const obj = objectById(doc, id);
    if (!obj) return false;
    const from = Number(fromT);
    const to = Number(toT);
    if (!Number.isFinite(from) || !Number.isFinite(to)) return false;
    const nextObj = moveCelDoc(obj, from, Math.max(0, to));
    if (!nextObj || nextObj === obj) return false;
    setDoc((d) => replaceObject(d, id, nextObj));
    return true;
}

/** 该对象所有纹理的时间点（升序）。 */
function celTimesOf(objId) {
    const doc = state.doc;
    const obj = doc ? objectById(doc, celTargetId(objId)) : null;
    return obj ? celTimes(obj) : [];
}

/** 跳到当前对象的上一个纹理点；已在第一个之前则回 0。 */
function goPrevCel() {
    if (!state.doc) return;
    const times = celTimesOf(null);
    let target = 0;
    for (const at of times) {
        if (at < state.time - 1e-6) target = at;
    }
    setTime(target);
}

/** 跳到当前对象的下一个纹理点；没有下一个就跳到时间轴末尾。 */
function goNextCel() {
    if (!state.doc) return;
    const times = celTimesOf(null);
    let target = totalSeconds(state.doc);
    for (const at of times) {
        if (at > state.time + 1e-6) {
            target = at;
            break;
        }
    }
    setTime(Math.max(0, target));
}

/** 把 state.time 夹回 [0, totalSeconds]（时间模型里没有帧索引可夹）。 */
function clampTime() {
    const doc = state.doc;
    if (!doc) {
        state.time = 0;
        return;
    }
    const total = totalSeconds(doc);
    const t = Number(state.time);
    if (!Number.isFinite(t) || t < 0) state.time = 0;
    else if (total > 0 && t > total) state.time = total;
}

/**
 * 新文档：一个对象 + t=0 的空纹理。没有帧、没有帧计数。
 * duration 显式给 1s —— 与旧版「12 帧 × 12fps」的初始时间轴等长；
 * 时间模型里空文档的 totalSeconds 是 0，没有显式时长时间轴会没有刻度可拖。
 *
 * 注意 `name` 是**用户数据**（用户会改它、它进层级面板、进 .msp），
 * 所以这里不取词条、不跟界面语言走 —— 否则同一份文档里会混两种语言的
 * 对象名，切换界面语言还会让「新建的对象叫什么」随设置变化。用户随时可以
 * 双击改名，缺省叫什么并不重要，重要的是它**稳定**。真源在
 * `core/doc-model.mjs` 的 `DEFAULT_OBJECT_NAME`（外壳不自己再写一份）。
 */
function newTimeDocument() {
    return createTimeDocument({
        width: DEFAULT_W,
        height: DEFAULT_H,
        fps: DEFAULT_FPS,
        duration: 1,
        onion: Object.assign({}, ONION_DEFAULTS),
        objects: [{ name: DEFAULT_OBJECT_NAME, transform: createTrack(), cels: [{ at: 0, image: null }] }],
    });
}

/* ─────────────────────────── ctx（契约 §4） ─────────────────────────── */

/**
 * 求值器按 doc 身份缓存：doc 是不可变的，换引用即换求值器。
 * 菜单/面板一次渲染内多次调用不会重复建对象。
 */
let evalDoc = null;
let evalInst = null;
function evaluatorFor(doc) {
    if (!doc) return createEvaluator(null);
    if (evalDoc === doc && evalInst) return evalInst;
    evalDoc = doc;
    evalInst = createEvaluator(doc);
    return evalInst;
}

// ctx 的构造推迟到 boot()：顶层求值时 doc-state / project-io / view-host 的交叉依赖
// 可能还没求值完，简写属性读 import 绑定会直接 ReferenceError。
let ctx = null;
let palette = null;   // 命令面板（命令表在 buildCommands 里，键位 Ctrl+Shift+P）
let shortcuts = null; // 快捷键一览浮层（? 打开）

function buildCtx() {
    return {

    doc: () => state.doc,
    setDoc,
    subscribeDoc,

    /* 本地化：切语言的唯一入口。换表 + `<html lang>` + 重挂所有面板（画布除外），
       并把选择写回偏好快照；落盘由设置面板的 commit 负责（它本来就管 ms.prefs）。 */
    setLocale: (id) => {
        if (DS && typeof DS.setPrefs === 'function') DS.setPrefs({ locale: id });
        applyLocale(id, { remount: true });
        return getLocale();
    },
    locale: () => getLocale(),

    time: () => state.time,
    setTime,
    playing: () => state.playing,
    setPlaying,
    /* v10：预览播放速度（0.25×–4×，落 ms.prefs）。工具条与设置面板读的是同一份偏好。 */
    playSpeed,
    setPlaySpeed,
    /* v8：时间轴工具条与拖拽的正规入口。
       setTime 会 wrapTime 回绕（拖播放头到末尾会跳回 0），面板一律用 setTimeClamped。 */
    setTimeClamped,
    stepFrames,
    setDuration,
    fpsNow,
    goToKey,

    /* v8：时间通道的「是否恒等」——ctx-time 没提供这个读法，面板靠它决定 ⏱ 徽章亮不亮。
       其余 layerTime / setLayerTime / describeLayerTime / setLayerParent /
       moveLayerTo / moveDrawOrder 都在 shell/ctx-time.mjs 里（boot 里 Object.assign 覆盖本对象，别在这里重复实现）。
       v11 起：层级走 moveSubtree、叠放走 moveDrawOrder，setLayerParent/moveLayerTo 只作为老调用方的兼容壳保留。
       v11 也删掉了 ctx 上的 layerDepth / subtreeCount 两个零调用者包装：要读层级深度直接用
       core/timegraph.mjs 的 timeDepth，要读子树规模用 subtreeSize（两者都是公共 API 且有测试）。 */
    isLayerTimeIdentity: (id) => {
        const doc = state.doc;
        const el = doc ? objectById(doc, id) : null;
        return isIdentityTime(el ? el.time : null);
    },

    /* 蒙皮（P2-B）：命令表与属性面板的「解除绑定」按钮共用这一份实现 —— 两个入口各写一遍
       「删 skin」的删除逻辑迟早会分叉，这里只留一条写口（内部仍是 setDoc 一步撤销）。 */
    bindSkinToSelected,
    unbindSkinOfSelected,

    /* 权重叠加态（P2-C 步 1）：纯外壳态，不进文档、不进撤销、不落盘。
       读写分离：下面四个 getter 只读 state.weight，三个 setter 末尾统一重画叠加层
       （canvasEditor.syncSelectionUI 就是叠加层的重画入口，见 editors/canvas.mjs:32）。
       目标对象一律过 weightTargetLayer()，所以删对象 / 解绑 / 撤销之后读出来的就是 null，
       不需要额外的同步钩子。 */
    weightMode: () => !!state.weight.active,
    weightLayerId: () => (weightTargetLayer() ? state.weight.layerId : null),
    weightBone: () => (weightTargetLayer() ? state.weight.boneId : null),
    weightVertex: () => (weightTargetLayer() ? state.weight.vertex : null),
    // 笔刷半径是外壳态（不进文档、不落盘）：同一个工程换台机器、换个图层都不该变，
    // 但它也不是「作品内容」，所以只活在 state.weight 里，跟着会话走。
    weightRadius: () => state.weight.radius,
    setWeightMode(on) {
        if (on) {
            const layer = weightTargetLayer();
            if (!layer) {
                flash(t('props.obj.weightErrNoSkin'), 'error');
                return false;
            }
            const bones = skinOf(layer).bones;
            const boneId = bones.some((b) => b.id === state.weight.boneId)
                ? state.weight.boneId
                : (bones.length ? bones[0].id : null);
            state.weight = Object.assign({}, state.weight, { active: true, layerId: layer.id, boneId, vertex: null });
        } else {
            state.weight = Object.assign({}, state.weight, { active: false, vertex: null });
        }
        canvasEditor.syncSelectionUI();
        scheduleRefresh();
        return true;
    },
    setWeightBone(id) {
        const layer = weightTargetLayer();
        const skin = layer ? skinOf(layer) : null;
        const wanted = id == null ? '' : String(id);
        const next = skin && skin.bones.some((b) => b.id === wanted) ? wanted : null;
        state.weight = Object.assign({}, state.weight, { boneId: next });
        canvasEditor.syncSelectionUI();
        scheduleRefresh();
        return next;
    },
    setWeightVertex(index) {
        const layer = weightTargetLayer();
        const skin = layer ? skinOf(layer) : null;
        const count = skin ? (skin.grid.cols + 1) * (skin.grid.rows + 1) : 0;
        const ok = Number.isInteger(index) && index >= 0 && index < count;
        state.weight = Object.assign({}, state.weight, { vertex: ok ? index : null });
        canvasEditor.syncSelectionUI();
        scheduleRefresh();
        return ok ? index : null;
    },

    /* 权重写入的唯一落点（P2-C 步 2）。涂抹手势每帧调一次，返回**新的 doc**、不落栈：
       撤销粒度由调用方（canvas-input 的松手那一步）决定 —— 逐帧 pushCommand 会让
       一次涂抹产生几十条记录，而 coalesce 又会把两次独立拖动并成一条（DOC_GESTURE_MS
       只有 350ms），粒度随手感漂移。所以这里只管算，不管栈。 */
    writeSkinPoints(layerId, pts) {
        const doc = state.doc;
        if (!doc) return null;
        const el = layerId ? objectById(doc, layerId) : null;
        const skin = skinOf(el);
        if (!skin) return null;
        // skinOf 已经归一过一遍，这里再过一次 normalizes 的是「手势产出的 pts」：
        // 截 4 根 / 降序 / Σ=1 的收口必须发生在写入前，坏数据不该有机会进文档。
        // 注意语义：normalizeSkin 会剔除 !(w > 0) 的项，所以「刷到 0」= 该顶点上
        // 没有这一项，而不是存一个 0 —— 有意为之，别为它加特例。
        const next = normalizeSkin(Object.assign({}, skin, { pts: Array.isArray(pts) ? pts : [] }));
        if (!next) return null;
        return patchObject(doc, el.id, (o) => Object.assign({}, o, { skin: next }));
    },

    engine,
    tool: () => engine.tool(),
    setTool(id) {
        engine.setTool(id);
        updateChrome();
    },
    color: () => engine.color(),
    setColor(hex) {
        engine.setColor(hex);
        updateChrome();
    },

    undo: () => engine.undo(),
    redo: () => engine.redo(),

    activeLayerId: () => state.activeLayerId,
    setActiveLayer(id) {
        const doc = state.doc;
        if (!doc) return;
        const layer = objectById(doc, id);
        if (!layer) return;
        state.activeLayerId = id;
        state.selection = { id, mode: (state.selection && state.selection.mode) || 'transform' };
        engine.scheduleRender();
        scheduleRefresh();
    },

    /**
     * 对象多选（叠放面板与父子面板共用同一份）。**只在内存层**：
     * 不进文档、不进撤销 —— 选择是「我现在的注意力」，不是作品的一部分。
     * 每次读都跟文档对一遍，对象被删后悬空 id 自动退干净。
     */
    selectedLayers() {
        const doc = state.doc;
        if (!doc) return [];
        const raw = Array.isArray(state.layerSel) ? state.layerSel : [];
        const live = raw.filter((id) => objectById(doc, id));
        if (live.length !== raw.length) state.layerSel = live; // 自愈：不留已删对象的 id
        return live.slice();
    },
    setLayerSelection(ids) {
        const doc = state.doc;
        const want = Array.isArray(ids) ? ids.map(String) : [];
        state.layerSel = doc ? want.filter((id) => objectById(doc, id)) : [];
        // 主选中跟着走：原来的 activeLayer 不在新集合里时，落到第一个选中项
        if (state.layerSel.length && !state.layerSel.includes(String(state.activeLayerId))) {
            state.activeLayerId = state.layerSel[0];
        }
        // 选择不是文档状态，subscribeDoc 不会触发 —— 用一条事件把两个面板一起叫醒
        if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
            document.dispatchEvent(new CustomEvent('ms:layer-selection', { detail: { ids: state.layerSel.slice() } }));
        }
        scheduleRefresh();
    },

    selection: () => state.selection,
    setSelection(sel) {
        const doc = state.doc;
        if (!doc) return;
        if (!sel || !sel.id) {
            state.selection = null;
        } else {
            const layer = objectById(doc, sel.id);
            if (!layer) return;
            state.selection = {
                id: sel.id,
                mode: sel.mode === 'warp' ? 'warp' : 'transform',
                vertex: Number.isInteger(sel.vertex) ? sel.vertex : null,
            };
            state.activeLayerId = sel.id;
        }
        engine.scheduleRender();
        scheduleRefresh();
        canvasEditor.syncSelectionUI();
    },

    /**
     * 改**场景画布**尺寸（文档宽高）：只换舞台大小，对象自己的位图不动。
     * 对象越界不做裁剪（渲染本来就允许出界），用户可以自己再拖回来。
     */
    setDocSize(w, h) {
        const doc = state.doc;
        if (!doc) return false;
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));
        const nextW = clamp(w, 16, 8192);
        const nextH = clamp(h, 16, 8192);
        if (nextW === Math.round(doc.width) && nextH === Math.round(doc.height)) return false;
        setDoc((d) => Object.assign({}, d, { width: nextW, height: nextH }), { label: t('shell.undo.canvasSize') });
        if (engine && typeof engine.fitView === 'function') engine.fitView();
        flash(t('shell.doc.canvasSize', { w: nextW, h: nextH }));
        return true;
    },
    /**
     * 改对象自己的画布尺寸（位图整张拉伸，视觉不变、只改分辨率）。
     * 一次 setDoc = 一步撤销；尺寸没变时不动文档。
     */
    setObjectSize(objId, w, h) {
        const doc = state.doc;
        const id = celTargetId(objId);
        if (!doc || id == null) return null;
        const res = setObjectSizeDoc(doc, id, w, h, { makeCanvas: (cw, ch) => blankSurfaceOf(cw, ch) });
        if (!res.changed) return res.size;
        setDoc(() => res.doc, { label: t('shell.undo.objectSize') });
        return res.size;
    },


    notify(msg) {
        flash(msg);
        updateChrome();
    },
    requestRender() {
        engine.scheduleRender();
        scheduleRefresh();
    },

    /* ── 纹理（时间模型）：时间轴面板只通过这四个名字改纹理 ── */
    /**
     * 新建纹理：只往库里加一张图，**不在时间轴上占位**。
     * clone=true 时复制当前时刻那张（复制纹理），否则给一张空白（尺寸跟对象一致）。
     * 返回值是新纹理的 id；用户点库里那一行才会形成曝光。
     */
    newDrawing(objId, opts) {
        const doc = state.doc;
        if (!doc) return null;
        const id = celTargetId(objId);
        const obj = id ? objectById(doc, id) : null;
        if (!obj) return null;
        const clone = !!(opts && opts.clone);
        const size = objectSize(obj) || { w: doc.width, h: doc.height };
        const src = clone ? imageAt(obj, state.time) : null;
        const image = src ? cloneSurface(src) : createSurface(Math.max(1, Math.round(size.w)), Math.max(1, Math.round(size.h)));
        const next = addDrawing(obj, image);
        if (next === obj) return null;
        setDoc(() => replaceObject(state.doc, id, next), { label: t(clone ? 'shell.undo.dupTexture' : 'shell.undo.newTexture') });
        const lib = drawingsOf(next);
        const made = lib[lib.length - 1];
        return made ? made.id : null;
    },
    /** 在给定时刻加一次「曝光」，复用当前纹理（不新建图）——时间轴「加曝光」用。 */
    addExposure(objId, t) {
        const doc = state.doc;
        if (!doc) return null;
        const id = celTargetId(objId);
        const obj = id ? objectById(doc, id) : null;
        if (!obj) return null;
        const lib = drawingsOf(obj);
        const cur = drawingIdAt(obj, celTimeArg(t)) || (lib[0] ? lib[0].id : null);
        if (!cur) return null;
        // findFreeCelTime 返回 { at, moved }（不是一个数字），直接当秒用会算出 NaN
        const spot = findFreeCelTime(obj, celTimeArg(t));
        const at = spot && typeof spot === 'object' ? spot.at : Number(spot);
        if (!Number.isFinite(at)) return null;
        const next = placeDrawingDoc(obj, at, cur);
        if (next === obj) return null;
        setDoc(() => replaceObject(state.doc, id, next), { label: t('shell.undo.addExposure') });
        setTimeClamped(at);
        flash(t('shell.cel.exposureAdded', { t: at.toFixed(2) }));
        return at;
    },
    addCelAt,
    removeCelAt,
    clearCelAt,
    moveCel,
    swapCelTimes,
    celTimesOf,
    celImage: celImageOf,
    /* v8：纹理库 —— 纹理是可以复用/切换的「图」，时间轴上的是曝光。
       同一张纹理可以出现在多个时刻，改它所有时刻一起变；要脱钩用 makeUniqueCel。 */
    drawingsOf: (objId) => {
        const doc = state.doc;
        const id = celTargetId(objId);
        const obj = doc && id ? objectById(doc, id) : null;
        return obj ? drawingsOf(obj) : [];
    },
    currentDrawingId: (objId) => {
        const doc = state.doc;
        const id = celTargetId(objId);
        const obj = doc && id ? objectById(doc, id) : null;
        return obj ? drawingIdAt(obj, state.time) : null;
    },
    placeDrawing(objId, when, drawingId) {
        const doc = state.doc;
        const id = celTargetId(objId);
        if (!doc || id == null || !drawingId) return false;
        const at = celTimeArg(when);
        let changed = false;
        setDoc((d) => {
            const obj = objectById(d, id);
            if (!obj) return d;
            const next = placeDrawingDoc(obj, at, drawingId);
            if (next === obj) return d;
            changed = true;
            return replaceObject(d, id, next);
        }, { label: t('shell.undo.switchTexture') });
        return changed;
    },
    /** 把当前时刻的曝光独特化：拷一张新图，之后改它不影响别的时刻。 */
    makeUniqueCel(objId, when) {
        const doc = state.doc;
        const id = celTargetId(objId);
        if (!doc || id == null) return false;
        const at = celTimeArg(when);
        let changed = false;
        setDoc((d) => {
            const obj = objectById(d, id);
            if (!obj) return d;
            const next = makeUniqueDoc(obj, at, (w, h) => blankSurfaceOf(w, h));
            if (next === obj) return d;
            changed = true;
            return replaceObject(d, id, next);
        }, { label: t('shell.undo.uniqueTexture') });
        return changed;
    },
    /** 旋转/缩放的原点（归一化 0–1，相对对象自己的画布）。0.5/0.5 = 中心。 */
    setAnchor(objId, anchor, opts) {
        const doc = state.doc;
        const id = celTargetId(objId);
        if (!doc || id == null || !anchor) return false;
        const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(Number(v)) ? Number(v) : 0.5));
        const next = { x: clamp01(anchor.x), y: clamp01(anchor.y) };
        const keepPlace = !!(opts && opts.keepPlace);
        let changed = false;
        setDoc((d) => {
            const obj = objectById(d, id);
            if (!obj) return d;
            const cur = obj.anchor || { x: 0, y: 0 };
            if (Math.abs(cur.x - next.x) < 1e-6 && Math.abs(cur.y - next.y) < 1e-6) return d;
            changed = true;
            let doc2 = patchObject(d, id, (o) => Object.assign({}, o, { anchor: next }));
            if (!keepPlace) return doc2;
            // 换原点会让对象整体位移（q = a + L·(p−a) + t）。要保持画面不动，就把位移补到 x/y 上：
            //   t' = t + d − L·d，其中 d = a₀ − a₁（像素），L 是旋转/斜切/缩放的线性部分。
            const size = objectSize(obj) || { w: d.width, h: d.height };
            const st = stateAt(obj.transform, state.time) || {};
            const d0 = { x: (cur.x - next.x) * size.w, y: (cur.y - next.y) * size.h };
            const M = matrixOf(st);
            const Lx = M.a * d0.x + M.c * d0.y;
            const Ly = M.b * d0.x + M.d * d0.y;
            const dx = d0.x - Lx;
            const dy = d0.y - Ly;
            if (Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9) {
                doc2 = writeKeyAt(doc2, id, state.time, {
                    x: (Number(st.x) || 0) + dx,
                    y: (Number(st.y) || 0) + dy,
                });
            }
            return doc2;
        }, { label: t('shell.undo.anchor') });
        return changed;
    },
    removeDrawing(objId, drawingId) {
        const doc = state.doc;
        const id = celTargetId(objId);
        if (!doc || id == null || !drawingId) return false;
        let changed = false;
        setDoc((d) => {
            const obj = objectById(d, id);
            if (!obj) return d;
            const next = removeDrawingDoc(obj, drawingId);
            if (next === obj) return d;
            changed = true;
            return replaceObject(d, id, next);
        }, { label: t('shell.undo.removeTexture') });
        return changed;
    },

    /**
     * 纹理尺寸：裁到内容（`trim`）或重排到新画布（`resize`）。
     *
     * 「适配」（画板那个 0 键）动的是视图相机，不改像素尺寸；这里改的是像素本身。
     * 两条模式都要求**像素内容在世界坐标里不动**，所以图与 transform 必须在
     * 同一个 setDoc 里落地 —— 分两次写会留下「图已裁、位置还是旧」的中间态，
     * 而且撤销一次只回一半。
     *
     *   - trim：新图原点 = 旧图被裁掉的左上角，所以对象坐标要 **加** 上它（x += box.x）。
     *   - resize：内容按九宫格放进新画布，整体平移了 (ox, oy)，所以对象坐标要 **减** 回去。
     *
     * 只替换当前时刻那一张纹理；其它纹理（同一对象别的图）不动。
     *
     * @param {string|{id:string}} objId
     * @param {{mode:'trim'}|{mode:'resize',width:number,height:number,align?:string}} opts
     * @returns {boolean} 是否真的改了文档
     */
    resizeTexture(objId, opts) {
        const doc = state.doc;
        const id = celTargetId(objId);
        if (!doc || id == null) return false;
        const o = opts || {};
        const mode = o.mode === 'trim' ? 'trim' : (o.mode === 'resize' ? 'resize' : '');
        if (!mode) {
            flash(t('shell.texture.err.unknownMode'), 'error');
            updateChrome();
            return false;
        }
        const obj = objectById(doc, id);
        if (!obj) return false;
        const time = state.time;
        const src = readRgba(imageAt(obj, time));
        if (!src) {
            flash(t('shell.texture.err.noReadablePixels'), 'error');
            updateChrome();
            return false;
        }

        let next = null;
        let label = '';
        if (mode === 'trim') {
            const box = contentBounds(src.data, src.w, src.h);
            if (!box) {
                flash(t('shell.texture.err.empty'), 'error');
                updateChrome();
                return false;
            }
            if (box.x === 0 && box.y === 0 && box.w === src.w && box.h === src.h) {
                flash(t('shell.texture.err.noTrim'), 'error');
                updateChrome();
                return false;
            }
            next = {
                image: surfaceFromRgba(box.w, box.h, cropRgba(src.data, src.w, src.h, box)),
                dx: box.x,
                dy: box.y,
            };
            label = t('shell.undo.trimTexture');
        } else {
            const w = clampTextureSize(o.width);
            const h = clampTextureSize(o.height);
            if (w == null || h == null) {
                flash(t('shell.texture.err.sizeRange'), 'error');
                updateChrome();
                return false;
            }
            if (w === src.w && h === src.h) {
                flash(t('shell.texture.err.sizeSame'), 'error');
                updateChrome();
                return false;
            }
            const off = alignOffset(src.w, src.h, w, h, o.align || 'c');
            next = {
                image: surfaceFromRgba(w, h, placeRgba(src.data, src.w, src.h, w, h, off.ox, off.oy)),
                dx: -off.ox,
                dy: -off.oy,
            };
            label = t('shell.undo.resizeTexture');
        }
        if (!next || !next.image) {
            flash(t('shell.texture.err.createFailed'), 'error');
            updateChrome();
            return false;
        }

        let changed = false;
        setDoc((d) => {
            const cur = objectById(d, id);
            if (!cur) return d;
            // 纹理：只换当前时刻这一张
            let obj2 = setImageAt(cur, time, next.image);
            // 变换：把「图动了多少」补回对象坐标，画面不跳
            const track = obj2.transform || createTrack();
            const idx = activeKeyIndex(track, time);
            let track2 = track;
            if (idx >= 0) {
                const st = (track.keys[idx] && track.keys[idx].state) || {};
                track2 = setKeyState(track, idx, {
                    x: (Number(st.x) || 0) + next.dx,
                    y: (Number(st.y) || 0) + next.dy,
                });
            } else {
                // 轨道是空的（理论上不会，createTrack 保证有一帧）：补一个关键帧而不是让位移丢掉
                track2 = addKey(track, time, { x: next.dx, y: next.dy });
            }
            obj2 = Object.assign({}, obj2, { transform: track2 });
            changed = true;
            return patchObject(d, id, () => obj2);
        }, { label });

        if (changed) {
            flash(mode === 'trim'
                ? t('shell.texture.trimmed', { w: next.image.width, h: next.image.height })
                : t('shell.texture.resized', { w: next.image.width, h: next.image.height }));
            updateChrome();
        }
        return changed;
    },

    goPrevCel,
    goNextCel,
    clampTime,
    /** 引擎落笔用：保证当前时间有可写纹理（旧的 (帧下标, layerId, w, h) 签名已废） */
    ensureCelImage: celImageForPaint,
    setCelImage,

    exportFrames,
    exportSpritesheet,
    // v3：效果器
    setLayerEffects,
    setEffectParam,
    keyEffectParam,
    clearEffectParam,
    effectDefs: EFFECT_DEFS,
    makeEffect: defaultEffect,
    normalizeEffect,
    /** 时间 t 上该对象生效的位图（图层面板缩略图用）；兼容旧的 (帧下标, layerId) 参数序 */
    resolveCel: (a, b) => (typeof a === 'number' && typeof b === 'string' ? celImageOf(b, a) : celImageOf(a, b)),
        // ctx.project 在 boot 里补挂（projectApi 定义在后面）
    };
}


/* ────────────────────── 拖放导入（PSD / 图片） ────────────────────── */

/**
 * 把拖进窗口的文件直接导入当前文档。渲染进程能读 File 的字节，
 * 所以这里不走主进程对话框；解析与落文档全在 project-io 的 importDropped 里。
 */
function installDropImport() {
    const readOne = (file) => new Promise((resolve) => {
        try {
            const fr = new FileReader();
            fr.onload = () => resolve({ name: file.name, data: fr.result });
            fr.onerror = () => resolve({ name: file.name, data: null });
            fr.readAsArrayBuffer(file);
        } catch (err) {
            resolve({ name: file && file.name, data: null });
        }
    });

    const hasFiles = (e) => {
        const dt = e.dataTransfer;
        if (!dt) return false;
        if (dt.types) {
            for (let i = 0; i < dt.types.length; i += 1) if (dt.types[i] === 'Files') return true;
        }
        return !!dt.files && dt.files.length > 0;
    };

    document.addEventListener('dragover', (e) => {
        if (!hasFiles(e)) return;
        if (typeof e.preventDefault === 'function') e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
        document.body.classList.add('is-dropping');
    });

    document.addEventListener('dragleave', (e) => {
        // 只有真的离开窗口才收起高亮：子元素之间的 dragleave 不算
        if (e.relatedTarget) return;
        document.body.classList.remove('is-dropping');
    });

    document.addEventListener('drop', async (e) => {
        if (!hasFiles(e)) return;
        if (typeof e.preventDefault === 'function') e.preventDefault();
        document.body.classList.remove('is-dropping');
        const files = [];
        for (const f of e.dataTransfer.files) files.push(f);
        if (!files.length) return;
        flash(t('shell.import.dropping', { n: files.length }));
        const payload = await Promise.all(files.map(readOne));
        try {
            await projectApi.importDropped(payload);
        } catch (err) {
            flash(t('shell.import.failed', { msg: (err && err.message) || err }), 'error');
        }
    });
}

/* ─────────────────────────── 快捷键 ─────────────────────────── */

/**
 * Del 的两段式删除：第一次只提示「再按一次」，3 秒内第二次才真正执行。
 * 顺序是「先删纹理，再删对象」——
 *  · 当前时刻有纹理且库里不止一张 → 删这张纹理（不动对象）；
 *  · 否则删对象（含它的全部纹理）。
 * 返回 true 表示这次按键已被吃掉（调用方不再走别的分支）。
 */
let pendingDelete = null;

/**
 * 删选中的关键帧：判据（选了哪些、删掉几颗）只活时间轴里，外壳不复制这份状态。
 * 派发 `ms:delete-keys`，由 editors/timeline-keys.mjs 的 deleteTarget 决定
 * 「接管并删除」还是「让路」；返回被接管的处数（> 0 时外壳不许碰纹理/对象）。
 */
function deleteSelectedKeysNow(e) {
    // typing 一起传过去：外壳的 isTypingTarget 检查在 onKeyDown 更靠后的位置，
    // 焦点在输入框里按 Del 也会走到这儿。让时间轴自己判断要不要让路，
    // 比在外壳复制一份「谁能接 Del」的名单更不容易走偏。
    const detail = { handled: false, count: 0, typing: isTypingTarget(e && e.target) };
    dispatchTimeEvent('ms:delete-keys', detail);
    if (!detail.handled) return 0;
    // handled 但一颗都没删掉（集合里的键已被别处改掉）也要算「已被接管」：
    // 否则 Del 会顺延到对象上 —— 用户只想删关键帧，不该把对象删了。
    return detail.count > 0 ? detail.count : 1;
}

function onDeleteKey(e) {
    // 有选中关键帧时 Del 归时间轴，外壳整段让路（不设两段式确认、不提示、不删对象/纹理）。
    // 历史缺陷：两条链路同时跑 —— 第一下删关键帧并提示「再按一次 Del 删除对象」，
    // 第二下就把对象删了，一次按键做了两件事。
    if (deleteSelectedKeysNow(e) > 0) {
        if (typeof e.preventDefault === 'function') e.preventDefault();
        updateChrome();
        return true;
    }
    const doc = state.doc;
    if (!doc) return false;
    const id = (state.selection && state.selection.id) || state.activeLayerId;
    const obj = id ? objectById(doc, id) : null;
    if (!obj) return false;
    const lib = drawingsOf(obj);
    const cur = drawingIdAt(obj, state.time);
    // 与对象面板的「删纹理」同一优先级：当前时刻有纹理就删它；
    // 没有（播放头落在两段曝光之间）就删最近一张没被用到的纹理 ——
    // 这样 Del 不会第一下就打到对象上（防误删）。
    const unused = lib.filter((d) => !d.times || !d.times.length);
    // 优先删「没被任何时刻用到」的那张：删正在显示的那张会把整段画面挖掉，
    // 用户点 Del 十次有九次是想清掉库里多出来的草稿。
    const textureId = (unused.length ? unused[unused.length - 1].id : null) || cur;
    const kind = lib.length > 1 && textureId ? 'texture' : 'object';
    const key = kind + ':' + obj.id + (kind === 'texture' ? ':' + textureId : '');
    const now = Date.now();
    if (pendingDelete && pendingDelete.key === key && now - pendingDelete.at < 3000) {
        pendingDelete = null;
        if (kind === 'texture') {
            // 必须走 ctx.removeDrawing（内部 setDoc → 广播 → 面板重绘）。
            // 直接调纯函数 removeDrawingDoc 只算出新对象、不写回文档，
            // 表现就是「提示已删除、列表不刷新」——这就是用户看到的那一幕。
            if (!ctx || typeof ctx.removeDrawing !== 'function') {
                flash(t('shell.delete.notWired'), 'error');
            } else if (ctx.removeDrawing(obj.id, textureId) === false) {
                flash(t('shell.delete.keepOne'), 'error');
            } else {
                flash(t('shell.delete.textureDone'));
            }
        } else {
            const name = obj.name || t('shell.doc.objectFallback');
            setDoc((d) => removeObjectDoc(d, obj.id), { label: t('shell.undo.deleteObject') });
            if (state.activeLayerId === obj.id && typeof ctx.setActiveLayer === 'function') ctx.setActiveLayer(null);
            flash(t('shell.delete.objectDone', { name }));
        }
        if (typeof e.preventDefault === 'function') e.preventDefault();
        updateChrome();
        return true;
    }
    pendingDelete = { key: key, at: now };
    flash(kind === 'texture'
        ? t('shell.delete.confirmTexture')
        : t('shell.delete.confirmObject', { name: obj.name || t('shell.doc.objectFallback') }));
    if (typeof e.preventDefault === 'function') e.preventDefault();
    return true;
}

function isTypingTarget(target) {
    if (!target || !target.tagName) return false;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return !!target.isContentEditable;
}

function nudgeSize(delta) {
    const b = engine.brush();
    engine.setBrush({ size: Math.max(1, Math.min(400, Math.round(b.size) + delta)) });
    updateChrome();
}

/**
 * 把「关键帧剪贴板」这类面板内状态留在面板里：外壳只派发一个 CustomEvent，
 * 时间轴收到后自己复制/粘贴（见 editors/timeline-keys.mjs 的 onCopyEvent/onPasteEvent）。
 * 没有监听者时什么都不发生，所以不检查返回值。
 */
function dispatchTimeEvent(name, detail) {
    try {
        document.dispatchEvent(new CustomEvent(name, { detail: detail || null }));
    } catch (err) {
        /* 派发失败不该拖垮外壳 */
    }
}

/* ─────────────────────────── 命令面板（Ctrl+Shift+P） ─────────────────────────── */

/**
 * 命令表：一条命令就是「喊一句话」，真正的状态仍归各模块自己。
 * 全部包一层箭头函数 —— engine/state 是 boot 里才赋值的模块级 let，直接引用会
 * 在赋值前捕获 undefined。
 */
/**
 * 在当前时刻切换成库里相邻的那张纹理（纹理是复用的图，不是「每加一格就多一条时间」）。
 * 没有任何纹理时提示；越界时绕回另外一端。
 */
function cycleDrawing(dir) {
    const step = dir < 0 ? -1 : 1;
    const list = typeof ctx.drawingsOf === 'function' ? ctx.drawingsOf(null) : [];
    if (!list.length) {
        flash(t('shell.cel.noTexture'), 'error');
        return false;
    }
    const cur = typeof ctx.currentDrawingId === 'function' ? ctx.currentDrawingId(null) : null;
    const i = list.findIndex((d) => d.id === cur);
    const next = list[(i < 0 ? (step > 0 ? 0 : list.length - 1) : (i + step + list.length) % list.length)];
    if (!next) return false;
    const ok = ctx.placeDrawing(null, state.time, next.id);
    if (ok) flash(t('shell.cel.showing', { n: list.indexOf(next) + 1 }));
    return ok;
}

/**
 * 在选中对象的同一层新建一根骨骼。
 *
 * 为什么不走 shell/object-factory.mjs：它的 `createEmptyObject` 只造 `kind: 'paint'`
 * 的空对象，不认识 kind / parentId；骨骼的 anchor（根部中点）与 bone 缺省值都是 core 的
 * `makeObject` 按 kind 补的，工厂也不在本次改动的写域里。这里直接调 core 的 addObject
 * ——它内部就是 makeObject + normalizeDrawOrder，外壳一个字面量都不手写。
 *
 * 失败静默返回 null（没有文档时命令本来就不可达）；成功时把选中切到新骨骼，
 * 属性面板的骨骼段随即出现，落盘仍只有 kind / bone / anchor 这些标量。
 */
function addBoneObject() {
    const doc = state.doc;
    if (!doc) return null;
    const sel = state.selection && state.selection.id ? objectById(doc, state.selection.id) : null;
    // 「同层」= 与选中对象同一个父级；没选中就直接进顶层
    const parentId = sel ? (sel.parentId || null) : null;
    const next = addObject(doc, { name: nextObjectName(doc), kind: 'bone', parentId });
    const list = objectsOf(next);
    const created = list[list.length - 1];
    if (!created) return null;
    setDoc(() => next, { label: t('cmd.object.addBone') });
    ctx.setSelection({ id: created.id });
    return created.id;
}

/**
 * 蒙皮 P2-B：把「当前对象」绑到「被选中的骨骼」上。
 *
 * 选择模型（读 app.mjs 的 state 得到）：画布单选是 `state.selection.id`，多选是
 * `state.layerSel`（`ctx.selectedLayers()`），而 `setLayerSelection` / `setSelection`
 * 都保证 `activeLayerId` 落在选中里 —— 所以不存在「面板对象在多选集合之外」的第二种情形：
 * 当前对象 = `selection.id || activeLayerId`，骨骼 = 多选里除它之外的 `kind === 'bone'`。
 * 一个骨骼都没选中时**不猜**（不去绑全场景的骨）：`flash` 明确要求先选骨。
 *
 * 落盘只有一个 `skin` 字段（`bones[].bind` 是绑定时刻的世界矩阵快照），词条键与译文都不进档。
 * 写入一律走 setDoc + 一步撤销，与 addBoneObject() 同款 —— 不允许裸改 state.doc。
 */
function bindSkinToSelected() {
    const doc = state.doc;
    if (!doc) return null;
    const curId = (state.selection && state.selection.id) || state.activeLayerId || null;
    const target = curId ? objectById(doc, curId) : null;
    if (!target) {
        flash(t('props.obj.skinErrNoObject'), 'error');
        return null;
    }
    if (target.kind === 'bone') {
        flash(t('props.obj.skinErrBone'), 'error');
        return null;
    }
    // 硬约束：蒙皮对象不许把骨骼当父级 —— 皮肤已经按骨骼世界矩阵算过一遍，
    // 再挂到骨骼下面就是二次变换（画布上会看到皮肤被拉走两倍的距离）。
    const parent = target.parentId ? objectById(doc, target.parentId) : null;
    if (parent && parent.kind === 'bone') {
        flash(t('props.obj.skinErrParentBone'), 'error');
        return null;
    }
    const sel = typeof ctx.selectedLayers === 'function' ? ctx.selectedLayers() : [];
    const boneIds = sel.filter((id) => {
        if (id === target.id) return false;
        const el = objectById(doc, id);
        return !!(el && el.kind === 'bone');
    });
    if (boneIds.length === 0) {
        flash(t('props.obj.skinErrNoBones'), 'error');
        return null;
    }
    const skin = bindSkin(doc, target, boneIds, { grid: SKIN_DEFAULTS.grid, t: state.time });
    if (!skin) return null;
    const next = patchObject(doc, target.id, (o) => Object.assign({}, o, { skin }));
    setDoc(() => next, { label: t('cmd.object.bindSkin') });
    flash(t('props.obj.skinBound', { n: skin.bones.length }));
    return target.id;
}

/**
 * 解除蒙皮：只删 `skin` 一个字段，`st.warp` / 变换通道 / 绑定快照一概不动 ——
 * 变形网格是用户自己的雕刻，解除绑定不该把它一起抹掉（P2-A 的求值接缝也是「skin 叠加在 warp 上」）。
 */
function unbindSkinOfSelected(layerId) {
    const doc = state.doc;
    if (!doc) return false;
    const id = layerId || (state.selection && state.selection.id) || state.activeLayerId || null;
    const target = id ? objectById(doc, id) : null;
    if (!target) {
        flash(t('props.obj.skinErrNoObject'), 'error');
        return false;
    }
    if (!skinOf(target)) {
        flash(t('props.obj.skinErrNone'), 'error');
        return false;
    }
    const next = patchObject(doc, target.id, (o) => {
        const copy = Object.assign({}, o);
        delete copy.skin;
        return copy;
    });
    setDoc(() => next, { label: t('cmd.object.unbindSkin') });
    flash(t('props.obj.skinUnbound'));
    return true;
}

/**
 * 权重编辑的目标对象（P2-C 步 1）：必须「存在且带 skin」才算数。
 * layerId 优先——用户为了换目标骨会去点骨骼，那一刻选区是骨骼，
 * 靠选区找对象的话顶点会当场消失。读的时候现校验，悬空状态自动失效。
 */
function weightTargetLayer() {
    const doc = state.doc;
    if (!doc) return null;
    const w = state.weight;
    const id = w.layerId || (state.selection && state.selection.id) || state.activeLayerId || null;
    const layer = id ? objectById(doc, id) : null;
    return layer && skinOf(layer) ? layer : null;
}

/**
 * 命令表。`id` 是契约：快捷键表、命令面板、测试都按它引用，**一个字都不许改**；
 * 文案的取值来源换成词条表（键 = `cmd.` + id 折驼峰，见 app/i18n/parts/commands.mjs）。
 *
 * 文案字段写成 getter 而不是直接 `t(...)` 求值：`boot()` 里先 `createPalette({ commands:
 * buildCommands() })`、再 `applyLocale(...)`，直接求值会把默认语言的命令名冻在表里，
 * 切到中文后界面照样显示英文。面板每次渲染 / 打分都读一次 title/hint/group，正好现取。
 */
function buildCommands() {
    const toolCmd = (tool) => ({
        id: 'tool.' + tool.id,
        keys: tool.key,
        run: () => {
            engine.setTool(tool.id);
            flash(t('shell.tool.picked', { name: tool.name }));
            updateChrome();
        },
        get title() { return t('cmd.tool.' + tool.id, tool.name); },
        get hint() { return t('cmd.group.tool'); },
        get group() { return t('cmd.group.tool'); },
    });
    return [
        // 文件
        {
            id: 'file.save', keys: 'Ctrl+S', run: () => saveProject(),
            get title() { return t('cmd.file.save'); },
            get hint() { return t('cmd.file.save.hint'); },
            get group() { return t('cmd.group.file'); },
        },
        {
            id: 'file.open', keys: 'Ctrl+O', run: () => openProjectsPanel(),
            get title() { return t('cmd.file.open'); },
            get hint() { return t('cmd.file.open.hint'); },
            get group() { return t('cmd.group.file'); },
        },
        {
            id: 'file.export-frames', keys: 'Ctrl+Shift+E', run: () => exportFrames(),
            get title() { return t('cmd.file.exportFrames'); },
            get hint() { return t('cmd.file.exportFrames.hint'); },
            get group() { return t('cmd.group.file'); },
        },
        {
            id: 'file.export-current', keys: '', run: () => projectApi.exportCurrentFrame(),
            get title() { return t('cmd.file.exportCurrent'); },
            get hint() { return t('cmd.file.exportCurrent.hint'); },
            get group() { return t('cmd.group.file'); },
        },
        {
            id: 'file.export-clip', keys: '', run: () => projectApi.copyFrameToClipboard(),
            get title() { return t('cmd.file.exportClip'); },
            get hint() { return t('cmd.file.exportClip.hint'); },
            get group() { return t('cmd.group.file'); },
        },
        {
            id: 'file.export-sheet', keys: '', run: () => exportSpritesheet(),
            get title() { return t('cmd.file.exportSheet'); },
            get hint() { return t('cmd.file.exportSheet.hint'); },
            get group() { return t('cmd.group.file'); },
        },
        {
            id: 'file.export-video', keys: '', run: () => projectApi.exportVideo(),
            get title() { return t('cmd.file.exportVideo'); },
            get hint() { return t('cmd.file.exportVideo.hint'); },
            get group() { return t('cmd.group.file'); },
        },
        // 编辑
        {
            id: 'edit.undo', keys: 'Ctrl+Z', hint: '', run: () => engine.undo(),
            get title() { return t('cmd.edit.undo'); },
            get group() { return t('cmd.group.edit'); },
        },
        {
            id: 'edit.redo', keys: 'Ctrl+Shift+Z', hint: '', run: () => engine.redo(),
            get title() { return t('cmd.edit.redo'); },
            get group() { return t('cmd.group.edit'); },
        },
        {
            id: 'edit.copy-keys', keys: 'Ctrl+C', run: () => dispatchTimeEvent('ms:copy-keys'),
            get title() { return t('cmd.edit.copyKeys'); },
            get hint() { return t('cmd.edit.copyKeys.hint'); },
            get group() { return t('cmd.group.edit'); },
        },
        {
            id: 'edit.paste-keys', keys: 'Ctrl+V', run: () => dispatchTimeEvent('ms:paste-keys'),
            get title() { return t('cmd.edit.pasteKeys'); },
            get hint() { return t('cmd.edit.pasteKeys.hint'); },
            get group() { return t('cmd.group.edit'); },
        },
        // 播放与定位
        {
            id: 'play.toggle', keys: 'Space', run: () => setPlaying(!state.playing),
            get title() { return t('cmd.play.toggle'); },
            get hint() { return t('cmd.play.toggle.hint'); },
            get group() { return t('cmd.group.play'); },
        },
        {
            id: 'play.first', keys: 'Home', hint: 't = 0', run: () => setTimeClamped(0),
            get title() { return t('cmd.play.first'); },
            get group() { return t('cmd.group.play'); },
        },
        {
            id: 'play.last', keys: 'End', run: () => setTimeClamped(totalSeconds(state.doc)),
            get title() { return t('cmd.play.last'); },
            get hint() { return t('cmd.play.last.hint'); },
            get group() { return t('cmd.group.play'); },
        },
        {
            id: 'play.prev-cel', keys: 'Shift+,', hint: '', run: () => goPrevCel(),
            get title() { return t('cmd.play.prevCel'); },
            get group() { return t('cmd.group.play'); },
        },
        {
            id: 'play.next-cel', keys: 'Shift+.', hint: '', run: () => goNextCel(),
            get title() { return t('cmd.play.nextCel'); },
            get group() { return t('cmd.group.play'); },
        },
        {
            id: 'play.prev-key', keys: ',', run: () => goToKey(-1),
            get title() { return t('cmd.play.prevKey'); },
            get hint() { return t('cmd.play.prevKey.hint'); },
            get group() { return t('cmd.group.play'); },
        },
        {
            id: 'play.next-key', keys: '.', run: () => goToKey(1),
            get title() { return t('cmd.play.nextKey'); },
            get hint() { return t('cmd.play.nextKey.hint'); },
            get group() { return t('cmd.group.play'); },
        },
        // 纹理
        {
            id: 'cel.new', keys: '', run: () => ctx.newDrawing(null),
            get title() { return t('cmd.cel.new'); },
            get hint() { return t('cmd.cel.new.hint'); },
            get group() { return t('cmd.group.cel'); },
        },
        {
            id: 'cel.add', keys: '', run: () => ctx.addExposure(null, null),
            get title() { return t('cmd.cel.add'); },
            get hint() { return t('cmd.cel.add.hint'); },
            get group() { return t('cmd.group.cel'); },
        },
        {
            id: 'cel.remove', keys: '', run: () => removeCelAt(null, null),
            get title() { return t('cmd.cel.remove'); },
            get hint() { return t('cmd.cel.remove.hint'); },
            get group() { return t('cmd.group.cel'); },
        },
        {
            id: 'cel.cycle-prev', keys: '', run: () => cycleDrawing(-1),
            get title() { return t('cmd.cel.cyclePrev'); },
            get hint() { return t('cmd.cel.cyclePrev.hint'); },
            get group() { return t('cmd.group.cel'); },
        },
        {
            id: 'cel.cycle-next', keys: '', run: () => cycleDrawing(1),
            get title() { return t('cmd.cel.cycleNext'); },
            get hint() { return t('cmd.cel.cycleNext.hint'); },
            get group() { return t('cmd.group.cel'); },
        },
        {
            id: 'cel.unique', keys: '', run: () => ctx.makeUniqueCel && ctx.makeUniqueCel(null, state.time),
            get title() { return t('cmd.cel.unique'); },
            get hint() { return t('cmd.cel.unique.hint'); },
            get group() { return t('cmd.group.cel'); },
        },
        // 对象
        {
            id: 'object.add-bone', keys: '', run: () => addBoneObject(),
            get title() { return t('cmd.object.addBone'); },
            get hint() { return t('cmd.object.addBone.hint'); },
            get group() { return t('cmd.group.edit'); },
        },
        {
            id: 'object.bind-skin', keys: '', run: () => bindSkinToSelected(),
            get title() { return t('cmd.object.bindSkin'); },
            get hint() { return t('cmd.object.bindSkin.hint'); },
            get group() { return t('cmd.group.edit'); },
        },
        {
            id: 'object.unbind-skin', keys: '', run: () => unbindSkinOfSelected(),
            get title() { return t('cmd.object.unbindSkin'); },
            get hint() { return t('cmd.object.unbindSkin.hint'); },
            get group() { return t('cmd.group.edit'); },
        },
        // 画布
        {
            id: 'canvas.fit', keys: '0', run: () => { engine.fitView(); flash(t('shell.view.fitted')); updateChrome(); },
            get title() { return t('cmd.canvas.fit'); },
            get hint() { return t('cmd.canvas.fit.hint'); },
            get group() { return t('cmd.group.canvas'); },
        },
        {
            id: 'canvas.brush-smaller', keys: '[', run: () => nudgeSize(-4),
            get title() { return t('cmd.canvas.brushSmaller'); },
            get hint() { return t('cmd.canvas.brushSmaller.hint'); },
            get group() { return t('cmd.group.canvas'); },
        },
        {
            id: 'canvas.brush-bigger', keys: ']', run: () => nudgeSize(4),
            get title() { return t('cmd.canvas.brushBigger'); },
            get hint() { return t('cmd.canvas.brushBigger.hint'); },
            get group() { return t('cmd.group.canvas'); },
        },
        // 工作区
        {
            id: 'ws.animate', keys: '', hint: 'animate', run: () => setWorkspace('animate'),
            get title() { return t('cmd.ws.animate'); },
            get group() { return t('cmd.group.workspace'); },
        },
        {
            id: 'ws.draw', keys: '', hint: 'draw', run: () => setWorkspace('draw'),
            get title() { return t('cmd.ws.draw'); },
            get group() { return t('cmd.group.workspace'); },
        },
        {
            id: 'ws.free', keys: '', hint: 'free', run: () => setWorkspace('free'),
            get title() { return t('cmd.ws.free'); },
            get group() { return t('cmd.group.workspace'); },
        },
        // 界面
        {
            id: 'ui.shortcuts', keys: '?', run: () => { if (shortcuts) shortcuts.open(); },
            get title() { return t('cmd.ui.shortcuts'); },
            get hint() { return t('cmd.ui.shortcuts.hint'); },
            get group() { return t('cmd.group.ui'); },
        },
        // 工具
        ...TOOLS.map(toolCmd),
    ];
}

function onKeyDown(e) {
    // 项目库浮层打开时，全局快捷键让位：Esc 由浮层自己处理，别顺手切工具/播动画
    if (projectsModal) return;
    // 命令面板先于 isTypingTarget：焦点在面板输入框里时也要能 Esc / Ctrl+Shift+P 收起
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'p' || e.key === 'P')) {
        e.preventDefault();
        if (palette) palette.toggle();
        return;
    }
    if (palette && palette.isOpen()) return;
    if (shortcuts && shortcuts.isOpen()) return;
    // 只有 Del（Delete）能删东西，并且两段式确认。Backspace 不接：
    // 它在很多键盘上就挨着编辑键（有的还印着「删除」），误触代价太大。
    if (e.key === 'Delete') {
        // 焦点在输入框里时 Del 是「删这个字」，不许碰文档。这一道以前排在
        // isTypingTarget 之后执行，于是属性面板里改对象名字按 Del 会先弹
        // 「再按一次 Del 删除对象」——提示先出现，用户根本没打算删对象。
        if (isTypingTarget(e.target)) return;
        if (onDeleteKey(e)) return;
    }
    // ? 打开快捷键一览（Shift+/ 在多数布局上就是 ?）
    if (!(e.ctrlKey || e.metaKey) && (e.key === '?' || (e.shiftKey && e.key === '/'))) {
        e.preventDefault();
        if (shortcuts) shortcuts.toggle();
        return;
    }
    const target = e.target;
    if (isTypingTarget(target)) {
        if (e.key === 'Escape' && typeof target.blur === 'function') target.blur();
        return;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    if (mod && (key === 'z' || key === 'Z')) {
        e.preventDefault();
        if (e.shiftKey) engine.redo();
        else engine.undo();
        return;
    }
    if (mod && (key === 'y' || key === 'Y')) {
        e.preventDefault();
        engine.redo();
        return;
    }
    if (mod && !e.altKey) {
        const k = String(key).toLowerCase();
        if (k === 's' && !e.shiftKey) {
            e.preventDefault();
            saveProject();
            return;
        }
        if (k === 'o' && !e.shiftKey) {
            e.preventDefault();
            openProjectsPanel();
            return;
        }
        if (k === 'e' && e.shiftKey) {
            e.preventDefault();
            exportFrames(projectLabel());
            return;
        }
        // 关键帧复制/粘贴由时间轴模块自己维护剪贴板：外壳只派发事件，
        // 免得「选中了什么」这类状态散落在两个模块里。
        if ((k === 'c' || k === 'v') && !e.shiftKey) {
            dispatchTimeEvent(k === 'c' ? 'ms:copy-keys' : 'ms:paste-keys');
            return;
        }
        return;
    }
    if (e.altKey) return;

    if (key === ' ') {
        e.preventDefault();
        setPlaying(!state.playing);
        return;
    }
    // 契约 v5：`,` `.` 是「上一个 / 下一个关键帧」。纹理切换挪到 Shift+, / Shift+.
    if (key === ',' || key === '<') {
        e.preventDefault();
        if (e.shiftKey) goPrevCel();
        else goToKey(-1);
        return;
    }
    if (key === '.' || key === '>') {
        e.preventDefault();
        if (e.shiftKey) goNextCel();
        else goToKey(1);
        return;
    }
    if (key === 'Home') {
        e.preventDefault();
        setTimeClamped(0);
        return;
    }
    if (key === 'End') {
        e.preventDefault();
        setTimeClamped(totalSeconds(state.doc));
        return;
    }
    // 逐帧（1/fps）用方向键：比 `,` `.` 的按纹理跳更适合修帧率与对位
    if (key === 'ArrowLeft' && !e.shiftKey) {
        e.preventDefault();
        stepFrames(-1);
        return;
    }
    if (key === 'ArrowRight' && !e.shiftKey) {
        e.preventDefault();
        stepFrames(1);
        return;
    }
    if (key === 'Escape') {
        // 画板 / 设置里没有「选中」概念，Esc 就是回到编排
        if (state.workspace !== 'animate') {
            e.preventDefault();
            setWorkspace('animate');
        }
        return;
    }
    if (key === '[') {
        e.preventDefault();
        nudgeSize(-4);
        return;
    }
    if (key === ']') {
        e.preventDefault();
        nudgeSize(4);
        return;
    }
    if (key === '0') {
        e.preventDefault();
        engine.fitView();
        flash(t('shell.view.fitted'));
        updateChrome();
        return;
    }
    const toolId = TOOL_KEYS[String(key).toLowerCase()];
    if (toolId) {
        engine.setTool(toolId);
        const tool = TOOLS.find((x) => x.id === toolId);
        flash(tool ? tool.name : toolId);
        updateChrome();
    }
}

/* ─────────────────────────── 启动 ─────────────────────────── */

function ensureDom() {
    const body = document.body;
    let top = document.getElementById('topbar');
    if (!top) {
        top = el('div');
        top.id = 'topbar';
        body.appendChild(top);
    }
    let host = document.getElementById('ws-host');
    if (!host) {
        host = el('div');
        host.id = 'ws-host';
        body.insertBefore(host, top.nextSibling);
    }
    let stb = document.getElementById('statusbar');
    if (!stb) {
        stb = el('div');
        stb.id = 'statusbar';
        body.appendChild(stb);
    }
    return { top, host, stb };
}

function expose() {
    // ctx 里已经有的键直接铺开，只补「ctx 没有、但外部脚本要用」的那些
    window.motionStudio = Object.assign({}, ctx, {
        state,
        engine,
        palette,
        setWorkspace,
        render,
        resetLayout,
        editorIds,
        tree: () => state.activeTree,
        addCelAt,
        removeCelAt,
        clearCelAt,
        moveCel,
        celTimesOf,
        celImage: celImageOf,
        goPrevCel,
        goNextCel,
        ensureCelImage: celImageForPaint,
        setCelImage,
        exportFrames,
        exportSpritesheet,
        exportVideo: (opts) => projectApi.exportVideo(opts),
        recordVideo: (opts) => projectApi.recordVideo(opts),
        setLayerEffects,
        setEffectParam,
        keyEffectParam,
        clearEffectParam,
        effectDefs: EFFECT_DEFS,
        makeEffect: defaultEffect,
        normalizeEffect,
        // 兼容旧的 (帧下标, layerId) 参数序
        resolveCel: (a, b) => (typeof a === 'number' && typeof b === 'string' ? celImageOf(b, a) : celImageOf(a, b)),
        saveProject,
        loadProject,
        newProject,
        currentProject,
        importProjectFile,
        openProjectsPanel,
        project: projectApi,
        // 顶栏「上次保存 HH:MM:SS · 存储：indexeddb」读这两个。
        // 数据源是 project-io 的入库时刻与真实存储介质，取不到就退回 0 / ''（顶栏会整段省略）
        projectSavedAt: () => Number(currentProject().savedAt) || 0,
        projectStoreKind: () => String(currentProject().storeKind || ''),
        ctx,
    });
}

/**
 * 让某个 locale 真正生效：换词条表 + 同步 `<html lang>`（屏幕阅读器与断词规则读的是它）
 * + 可选地重挂面板。
 *
 * 为什么重挂：面板在自己 `mount()` 里把静态文案写进 DOM，`refresh()` 只刷数据不刷文案。
 * `remountAll()` 会跳过画布实例（引擎宿主与视口都在里面，重挂会丢正在画的笔）。
 */
function applyLocale(id, opts) {
    const changed = setI18nLocale(id);
    if (typeof document !== 'undefined' && document.documentElement) {
        document.documentElement.lang = htmlLangOf(id);
    }
    if (changed && opts && opts.remount) {
        remountAll();
        // 快捷键浮层不归 remountAll 管（它挂在 body 上、不是工作区里的面板），
        // 而它的文案是 boot 时按当时语言渲染进 DOM 的；换语言得重新喂一份数据源。
        if (shortcuts && typeof shortcuts.setGroups === 'function') {
            shortcuts.setGroups(overlayGroups());
        }
    }
    return changed;
}

function boot() {
    ({
        TOOL_KEYS, DEFAULT_W, DEFAULT_H, DEFAULT_FPS, state, shell, el, engine,
        setDoc, subscribeDoc, setTime, setPlaying, playSpeed, setPlaySpeed, scheduleRefresh, flash, hintText,
        updateChrome, setTimeClamped, stepFrames, setDuration, fpsNow, goToKey,
    } = DS);
    // 先造 ctx：此时所有模块都已求值完毕，import 绑定一定可用
    ctx = buildCtx();
    // 命令面板：模块自己挂 body、自己管焦点，外壳只给命令表并按键
    palette = createPalette({ commands: buildCommands() });
    // 快捷键浮层与设置/帮助同源：键位与描述只在 help.mjs 的 SHORTCUT_GROUPS 里维护一份。
    // 命令表（buildCommands）只管「命令 → 键位」，不再往浮层里灌文案。
    shortcuts = createShortcutsOverlay({ groups: overlayGroups() });
    // 偏好要在 boot 里显式落一次：引擎刚建好，撤销上限得跟着 localStorage 走，
    // 不能指望用户点开「设置 → 偏好」才生效。loadPrefs 内部也会调 setPrefs，
    // 这里再调一次 setHistoryLimit 是为了绕开 boot 早期的订阅回调时序。
    const pref0 = DS.loadPrefs();
    if (engine && typeof engine.setHistoryLimit === 'function' && pref0) {
        engine.setHistoryLimit(pref0.undoLimit);
    }
    // 语言要在 buildViews 之前生效：否则第一帧会按缺省语言渲染一遍、再被重挂刷掉（闪一下）。
    applyLocale(pref0 && pref0.locale ? pref0.locale : 'en');
    ctx.project = projectApi;
    Object.assign(ctx, timeCtx({
        getDoc: () => state.doc,
        setDoc,
        flash,
        now: () => state.time,
        activeId: () => state.activeLayerId,
        evaluatorFor,
        writeKeyAt,
    }));
    setViewHostCtx(ctx);
    setProjectIoCtx(ctx);

    const dom = ensureDom();
    shell.host = dom.host;
    shell.topbar = buildTopbar(dom.top, {
        workspace: () => state.workspace,
        setWorkspace,
        hint: hintText,
        file: onFileAct,
        projectName: () => project.name,
        dirty: () => project.dirty,
        // 顶栏「上次保存 HH:MM:SS · 存储：indexeddb」的数据源（chrome.mjs 里已经写好取到就用的分支）
        projectSavedAt: () => Number(currentProject().savedAt) || 0,
        projectStoreKind: () => String(currentProject().storeKind || ''),
        // 已绑定的 .msp 路径：顶栏显示它、保存按钮的 title 据此说清「写库 + 回写」还是「仅入库」
        projectFile: () => String(currentProject().file || ''),
    });
    shell.statusbar = buildStatusbar(dom.stb, {});

    // 没有任何 CSS 时也保证绝对定位以 #ws-host 为参照
    try {
        if (getComputedStyle(shell.host).position === 'static') shell.host.style.position = 'relative';
    } catch (err) {
        shell.host.style.position = 'relative';
    }

    state.doc = newTimeDocument();
    state.time = 0;
    state.activeLayerId = objectsOf(state.doc)[0] ? objectsOf(state.doc)[0].id : null;

    buildViews(loadLayout());
    // 冷启动也套用工作区规则（动画工作区：锁画笔 + 默认选择工具）。
    // 必须在 buildViews 之后：setWorkspace 首行是 `if (!state.views[id]) return;`
    setWorkspace(state.workspace);
    syncActiveTree();
    render();
    window.addEventListener('keydown', onKeyDown);
    // 对象层级：Alt+↑/↓ 同级上下移、Alt+→ 缩进、Alt+← 提升（一次 setDoc、一条撤销）。
    // 方向翻译与目标计算都在 core/layer-order.mjs，写入走 ctx.moveSubtree。
    installLayerKeys(ctx);
    installDropImport();
    window.addEventListener('resize', () => render());
    expose();
    flash(t('shell.status.ready'));
    updateChrome();
    scheduleRefresh();
    syncCanvasToActive();
    // 编辑器模块可能在 mount 之后异步 attach，下一帧再收回一次
    scheduleAttachToActive();
    // 关窗口保护要在任何「可能丢掉改动」的操作之前装好
    installProjectSafety();
    // 上次打开过项目就恢复它（读库是异步的，不阻塞首屏）；
    // 没有项目时才问要不要恢复未命名草稿 —— 两者同时恢复会互相覆盖。
    Promise.resolve(restoreLastProject()).then((ok) => {
        if (!ok) restoreDraft();
    });
}

boot();


/* 编辑器契约：view-host 挂编辑器、project-io 开项目面板，都从这里取 ctx。 */
export { ctx };
