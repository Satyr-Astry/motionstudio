/**
 * MotionStudio —— 文档状态、播放时钟与面板刷新（原 app.mjs 的状态内核）
 *
 * 这里是外壳**唯一**存放可变状态的地方：state（当前文档 / 时间 / 选中 / 播放位）、
 * engine（绘制引擎单例）、shell（顶栏 / 底栏 / 宿主引用）与播放用的 rAF 计时器。
 * 其它 shell 模块只 import 这些绑定，不自己存副本 —— 状态只能有一份，
 * 否则 CDP 断言、撤销栈和顶栏会各看到一份「真相」。
 *
 * v6：帧对象已删除，时间的唯一单位是**秒**。
 * - `state.time` 就是播放头；`state.frameIndex` 不再存在。
 * - 内容单位是「画格」：`obj.cels = [{ at, image }]`，画格从 at 起生效到下一个画格。
 * - 文档长度由 `doc.duration`（秒）表达，`docDuration()` 会与内容长度取大。
 *
 * 依赖方向：
 * - 向下：core（cel / transform）、paint（engine / surface / effects / onion）、
 *   chrome（工作区常量）、project-store（记忆上次项目）。
 * - 横向：只依赖 project-io 的「存档身份」三件套（project / markDirty /
 *   notifyProjects）—— setDoc 要标脏、applyDoc 要广播项目变化。
 *   于是 doc-state ↔ project-io 互相 import：双方都只在**函数体**里解引用
 *   对方的绑定，模块初始化期不读值，ESM 的活绑定因此是安全的。
 *
 * 改文档一律走 setDoc(updater)：外壳统一广播、重绘、刷新面板（契约 §9.4）。
 */

import {
    createDocument,
    wrapTime,
    docDuration,
    contentDuration,
    fpsAtTime,
    objectsOf,
    objectById,
    celTimes,
    patchObject,
} from '../core/cel.mjs';
import { createTrack } from '../core/transform.mjs';
import { cycleIds } from '../core/timegraph.mjs';
import { cleanPrefs } from '../core/prefs.mjs';
import { filterStringAt } from '../paint/effects.mjs';
import { createEngine, TOOLS } from '../paint/engine.mjs';
import { ONION_DEFAULTS } from '../paint/onion.mjs';
import { WS_IDS, WS_TABS } from './chrome.mjs';
import * as store from './project-store.mjs';
// 播放刷新分级：纯决策放在 refresh-plan.mjs（node 里可直测），这里只负责执行
import { planRefresh, celSignature } from './refresh-plan.mjs';
// 播放推进：累计秒 → 显示时刻的映射（四种方式）与速度档位，纯逻辑在 core/playback.mjs
import { playbackAt, LOOP_REVERSE, clampSpeed, formatSpeed } from '../core/playback.mjs';
// 存档身份（原先在 project-io，会和本模块形成 import 环；下沉到这里，
// project-io 改为单向从这里取）。字段含义见 project-io 顶部注释。
const project = { id: '', name: '', file: '', dirty: false };
const projectListeners = new Set();

/** 标记「保存之后又有改动」，顶栏会显示 `名称 •`。 */
function markDirty() {
    if (project.dirty) return;
    project.dirty = true;
    if (shell.topbar) shell.topbar.update();
}

/** 通知项目库面板刷新。 */
function notifyProjects() {
    for (const fn of Array.from(projectListeners)) {
        try {
            fn();
        } catch (err) {
            console.error('[shell] 项目库订阅者抛异常：', err);
        }
    }
}

/** 订阅项目库变化，返回退订函数。 */
function onProjectsChange(fn) {
    if (typeof fn !== 'function') return () => {};
    projectListeners.add(fn);
    return () => projectListeners.delete(fn);
}

/* ─────────────────────────── 常量 ─────────────────────────── */

const DEFAULT_W = 900;
const DEFAULT_H = 640;
const DEFAULT_FPS = 12;
// 新文档的默认长度（秒）。12 帧 × 1/12s = 1 秒，与旧版「12 帧」的观感一致。
const DEFAULT_FRAMES = 12;
const NOTE_MS = 1600;
const TOOL_KEYS = { v: 'select', b: 'brush', e: 'eraser', g: 'bucket', i: 'picker', h: 'pan' };
const NOTE_TEXT = { paint: '已绘制', color: '已取色', undo: '撤销', redo: '重做', cel: '新建画格' };
const FALLBACK_EDITOR = 'timeline';

/* ─────────────────────────── 状态 ─────────────────────────── */

/**
 * 唯一可变状态。window.motionStudio.state 直接暴露它本身（CDP 断言用）。
 * doc 是纯数据（doc-model 保证不可变更新），这里只持有最新引用。
 */
const state = {
    doc: null,
    time: 0,
    playing: false,
    activeLayerId: null,
    // v2：画布选中态。{ id, mode: 'transform' | 'warp', vertex? } | null
    selection: null,
    // 动画工作区禁止绘画：绘画只用于「创建对象」，在绘图工作区进行
    drawLocked: false,
    workspace: 'animate',
    views: Object.create(null),
    activeTree: null,
    engine: null,
};

const shell = { topbar: null, statusbar: null, host: null };
const docListeners = new Set();

const notice = { text: '', at: 0 };
let noteTimer = 0;
let refreshRaf = 0;
let playRaf = 0;
let playAcc = 0;
let playLast = 0;

/* ─────────────────────────── 小工具 ─────────────────────────── */

function nowMs() {
    return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
}

function px(n) {
    const v = Number.isFinite(n) ? n : 0;
    return Math.round(v * 100) / 100 + 'px';
}

function clampInt(v, lo, hi) {
    const n = Number(v);
    if (!Number.isFinite(n)) return lo;
    return Math.max(lo, Math.min(Math.trunc(n), hi));
}

function viewList() {
    return WS_IDS.map((ws) => state.views[ws]).filter(Boolean);
}

function activeView() {
    return state.views[state.workspace] || null;
}

/** 当前作用的画格对象：活动对象 > 第一个对象。 */
function activeObject() {
    const doc = state.doc;
    if (!doc) return null;
    return objectById(doc, state.activeLayerId) || objectsOf(doc)[0] || null;
}

/* ─────────────────────────── 引擎 ─────────────────────────── */

const engine = createEngine({
    getDoc: () => state.doc,
    // v6：一切都是秒，引擎按 getTime() 找画格
    getTime: () => state.time,
    // v3：动画工作区锁画笔（绘画只用于创建对象，动画只做编排）
    canDraw: () => !state.drawLocked,
    getLayerId: () => state.activeLayerId,
    getActiveObject: () => activeObject(),
    // 引擎新建画格后要把新对象交回文档，否则这一格无处安放
    replaceObject(obj) {
        if (!obj || !obj.id) return;
        // 引擎自建画格时的回填：位图那一步已经由笔触命令覆盖，
        // 这里再压一条文档命令会让一次落笔变成两步撤销，所以是 silent（但合并进上一步的像素命令）。
        setDoc((d) => patchObject(d, obj.id, () => obj), { label: '新建画格', silent: true });
    },
    // 效果器：把对象的 effects 数组转成 canvas filter 字符串（见 paint/effects.mjs）
        isPlaying: () => state.playing,
        // 绘图工作区默认「画格画布」模式：当前画格当独立画布，笔与像素 1:1；
        // 编排区看合成结果（对象变换 / 父子 / 效果都在这一步生效）。
        isDrawingBoard: () => state.workspace === 'draw' && state.drawBoard !== false,
        filterFor(layer, t) {
        if (!layer || !layer.effects || !layer.effects.length) return 'none';
        // 参数轨道存在时按时间求值：线性 / 贝塞尔 / 保持全部复用变换求值器
        return filterStringAt(layer.effects, typeof t === 'number' ? t : state.time);
    },
    onNotify(reason) {
        if (NOTE_TEXT[reason]) flash(NOTE_TEXT[reason]);
        scheduleRefresh();
        updateChrome();
        engine.scheduleRender();
    },
});

// 引擎一建好就把 localStorage 里的偏好灌进去：撤销上限这类设置必须开机即生效，
// 而不是等用户点开「设置 → 偏好」。放在模块求值期，早于 boot 的所有订阅回调。
try {
    if (typeof window !== 'undefined' && window.localStorage) loadPrefs();
} catch {
    /* 读不到就用缺省值，不阻断模块求值 */
}
state.engine = engine;
engine.subscribe(() => {
    scheduleRefresh();
    updateChrome();
});

/* ─────────────────────────── 文档 ─────────────────────────── */

/**
 * 给 doc 补齐 doc-model 不管、但面板/渲染必须有的字段：
 * 每对象一条变换轨道、洋葱皮设置、显式 duration。
 * 载入项目文件时也走这里，保证「新建」与「打开」得到的 doc 形状一致。
 */
function enrichDoc(doc) {
    if (!doc || typeof doc !== 'object') return doc;
    const key = Array.isArray(doc.objects) ? 'objects' : 'layers';
    const list = Array.isArray(doc[key]) ? doc[key] : [];
    const next = {
        ...doc,
        [key]: list.map((l) => (l && l.transform ? l : { ...l, transform: createTrack() })),
        onion: doc.onion ? doc.onion : { ...ONION_DEFAULTS },
    };
    // duration 缺失或为 0 时，给一个可用的默认长度，否则时间轴没有刻度
    if (!(Number(next.duration) > 0)) next.duration = DEFAULT_FRAMES / (Number(next.fps) || DEFAULT_FPS);
    return next;
}

function buildDocument() {
    return enrichDoc(
        createDocument({
            width: DEFAULT_W,
            height: DEFAULT_H,
            fps: DEFAULT_FPS,
            duration: DEFAULT_FRAMES / DEFAULT_FPS,
        })
    );
}

/** 把时间夹进 [0, docDuration]，并保证活动对象 / 选中态指向真实存在的对象。 */
function clampSelection() {
    const doc = state.doc;
    if (!doc) return;
    const total = docDuration(doc);
    const t = Number(state.time);
    if (!Number.isFinite(t) || t < 0) state.time = 0;
    else if (total > 0 && t > total) state.time = total;
    if (!objectById(doc, state.activeLayerId)) {
        const first = objectsOf(doc)[0];
        state.activeLayerId = first ? first.id : null;
    }
    if (state.selection && !objectById(doc, state.selection.id)) state.selection = null;
}

/* ─────────────── 文档撤销（与位图撤销共用一个历史栈） ───────────────
 * 历史栈归引擎所有（core/history.mjs），里面原有的都是「一块矩形像素」命令。
 * 文档级改动（关键帧、对象增删、总时长、效果……）过去完全进不了撤销栈：
 * 移完关键帧按 Ctrl+Z 没反应，甚至会把上一次笔触撤掉 —— 这是 v8 修掉的硬伤。
 *
 * 做法：setDoc 是一次用户动作，就压一条「文档快照命令」。文档是结构共享的不可变
 * 对象，快照只是多存一个引用，不会复制位图，所以内存代价可以忽略。
 * 同一类连续改动（拖滑块、连续打字）靠 coalesce 键合并成一步。
 */

const DOC_MERGE_MS = 700;
const DOC_GESTURE_MS = 350;
let docMerge = { key: null, at: 0, cmd: null };
let applyingHistory = false;

/* ─────────────── 文档改动是否需要重绘（像素相关性判定） ───────────────
 * 文档是结构共享的不可变对象：没被改过的对象还是同一个引用，改了才会是新对象。
 * 靠这一点就能判断一次 setDoc 到底值不值得重绘 —— 改名字 / 改标签 / 改 fps 这类
 * 元数据改动也会走到 commitDoc，旧实现无条件 engine.scheduleRender()，
 * 于是「只是打个字」也要付一次全量重绘（实测 900×640 一帧 9.7ms，其中棋盘 5.2ms）。
 *
 * 判定一律偏保守：只在**能证明**像素完全没变时才跳过；拿不准就当成会变。
 * 若将来有编辑器改成「就地改 doc 对象」，这里会漏判 —— 所以下面只认可逐字段相等，
 * 不做任何模糊匹配，并且 core/ 与 editors/ 目前全部走不可变更新（已逐个核对）。
 */
function onionKey(cfg) {
    if (!cfg) return '';
    try {
        return JSON.stringify(cfg);
    } catch (err) {
        return '?';
    }
}

function sameAnchor(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return a.x === b.x && a.y === b.y;
}

/** 单个对象：像素相关字段全等才算「没变」（cels / transform / effects 按引用比）。 */
function sameObjectPixels(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    return (
        a.visible === b.visible &&
        a.opacity === b.opacity &&
        a.mixMode === b.mixMode &&
        a.kind === b.kind &&
        a.time === b.time &&
        a.parentId === b.parentId &&
        a.onionIgnore === b.onionIgnore &&
        sameAnchor(a.anchor, b.anchor) &&
        a.cels === b.cels &&
        a.transform === b.transform &&
        a.effects === b.effects
    );
}

/** 整份文档：尺寸 / 时长 / 洋葱皮 / 对象序列（含顺序）都不变才算「像素没变」。 */
function pixelsDiffer(a, b) {
    if (a === b) return false;
    if (!a || !b) return true;
    if (a.width !== b.width || a.height !== b.height) return true;
    if (a.duration !== b.duration) return true;
    if (a.onion !== b.onion && onionKey(a.onion) !== onionKey(b.onion)) return true;
    const oa = objectsOf(a);
    const ob = objectsOf(b);
    if (oa.length !== ob.length) return true;
    for (let i = 0; i < oa.length; i += 1) {
        if (!sameObjectPixels(oa[i], ob[i])) return true;
    }
    return false;
}

/** 直接把文档落到状态里（不压栈）。撤销/重做回放与 setDoc 都走它。 */
/**
 * 父子链成环时说一句（只说不改）：环上的对象在渲染/求值层只能被跳过，
 * 不提示的话用户只会看到「对象不见了」。同一状态只提醒一次，环消失后重置。
 */
let cycleWarned = false;
function warnCycle(doc) {
    let bad = [];
    try {
        bad = cycleIds(doc);
    } catch (err) {
        return;
    }
    if (!bad.length) {
        cycleWarned = false;
        return;
    }
    if (cycleWarned) return;
    cycleWarned = true;
    flash('文档里有循环的父子关系（' + bad.length + ' 个对象），它们不会被绘制');
}

function commitDoc(next) {
    const prev = state.doc;
    state.doc = next;
    clampSelection();
    warnCycle(next);
    // 只有会改变画面的改动才排重绘；面板刷新照旧（名字要立刻显示出来）
    if (pixelsDiffer(prev, next)) engine.scheduleRender();
    scheduleRefresh();
    emitDoc();
    markDirty();
    return next;
}

/**
 * 唯一的文档修改入口：算新 doc → 赋值 → 重绘 + 刷新 + 广播。
 * opts.label     撤销栈里显示的动作名（缺省「编辑」）
 * opts.coalesce  合并键：同一个键在 DOC_MERGE_MS 内连续调用只记一步
 * opts.silent    true = 不进撤销栈（内部派生写回，例如引擎自建画格时的回填）
 */
function setDoc(updater, opts) {
    const prev = state.doc;
    let next;
    try {
        next = typeof updater === 'function' ? updater(prev) : updater;
    } catch (err) {
        console.error('[shell] setDoc 的 updater 抛异常：', err);
        // 以前这里只进控制台：用户看到的是「点了没反应」，而控制台没人看。
        // 文档保持不变（下面 return prev），但必须让人知道这次操作没生效。
        flash('这次修改没有生效（内部出错），文档保持原样');
        return prev;
    }
    if (!next || typeof next !== 'object' || next === prev) return prev;
    // doc-model 只造像素，不造变换轨道：面板新建 / 复制对象走的是 setDoc，
    // 这里统一补齐，属性面板与渲染才不会拿到 undefined 的 transform。
    const key = Array.isArray(next.objects) ? 'objects' : Array.isArray(next.layers) ? 'layers' : null;
    if (key && next[key].some((l) => l && !l.transform)) {
        next = { ...next, [key]: next[key].map((l) => (l && !l.transform ? { ...l, transform: createTrack() } : l)) };
    }
    commitDoc(next);

    const opt = opts && typeof opts === 'object' ? opts : null;
    if (applyingHistory || (opt && opt.silent)) return next;
    if (!engine || typeof engine.pushCommand !== 'function') return next;

    const label = (opt && opt.label) || '编辑';
    // 显式 coalesce 时用较宽的时间窗；没写时按「手势」合并：
    // 拖滑块 / 连续打字的 setDoc 会在几十毫秒内连发，350ms 内合并成一步，
    // 否则一次拖动就能把撤销栈灌满（旧实现完全没进栈，所以没人发现这个问题）。
    const explicit = opt && opt.coalesce ? String(opt.coalesce) : null;
    const mergeKey = explicit ? 'k:' + explicit : '*auto';
    const mergeMs = explicit ? DOC_MERGE_MS : DOC_GESTURE_MS;
    const now = Date.now();
    if (docMerge.cmd && docMerge.key === mergeKey && now - docMerge.at < mergeMs) {
        // 同一串连续动作：只把「重做」推到最新，撤销仍然回到这一串之前
        docMerge.cmd.redo = () => { applyingHistory = true; try { commitDoc(next); } finally { applyingHistory = false; } };
        docMerge.at = now;
        return next;
    }
    const cmd = {
        label,
        undo: () => { applyingHistory = true; try { commitDoc(prev); } finally { applyingHistory = false; } },
        redo: () => { applyingHistory = true; try { commitDoc(next); } finally { applyingHistory = false; } },
    };
    engine.pushCommand(cmd);
    docMerge = { key: mergeKey, at: now, cmd };
    return next;
}

function emitDoc() {
    const doc = state.doc;
    for (const fn of Array.from(docListeners)) {
        try {
            fn(doc);
        } catch (err) {
            console.error('[shell] 文档订阅者抛异常：', err);
        }
    }
}

function subscribeDoc(fn) {
    if (typeof fn !== 'function') return () => {};
    docListeners.add(fn);
    return () => docListeners.delete(fn);
}

/* ─────────────────────────── 时间 / 画格 ─────────────────────────── */

/** 当前文档里画格切换点的秒数组（活动对象优先，没有就用第一个对象）。 */
function currentCelTimes() {
    const obj = activeObject();
    return obj ? celTimes(obj) : [];
}

/** 播放头落在第几个画格区间（-1 表示第一个画格之前）。 */
function celIndexOf(t) {
    const times = currentCelTimes();
    const v = Number(t);
    let idx = -1;
    for (let i = 0; i < times.length; i++) {
        if (times[i] <= (Number.isFinite(v) ? v : 0) + 1e-9) idx = i;
    }
    return idx;
}

/**
 * 跳到第 i 个画格边界。
 * 帧数组已经不存在，所以这里只是「按画格切换点跳时间」的便捷函数；
 * 时间本身可以停在任意浮点秒（关键帧不吸附画格）。
 */
function goToCel(i) {
    const doc = state.doc;
    if (!doc) return state.time;
    const times = currentCelTimes();
    if (!times.length) return state.time;
    const idx = clampInt(i, 0, times.length - 1);
    setTime(times[idx]);
    return state.time;
}

function stepFrame(delta) {
    const doc = state.doc;
    if (!doc) return state.time;
    const times = currentCelTimes();
    if (!times.length) return state.time;
    const here = celIndexOf(state.time);
    const next = Math.max(0, Math.min(times.length - 1, (here < 0 ? 0 : here) + (Number(delta) || 0)));
    return goToCel(next);
}

function setTime(t) {
    const doc = state.doc;
    if (!doc) return;
    const total = docDuration(doc);
    const v = Number(t);
    if (!Number.isFinite(v)) return;
    if (!(total > 0)) {
        state.time = 0;
        updateChrome();
        return;
    }
    const wrapped = wrapTime(doc, v);
    state.time = wrapped == null ? (v < 0 ? 0 : total) : wrapped;
    engine.scheduleRender();
    scheduleRefresh({ timeOnly: true });
    updateChrome();
}

/** 总时长输入的上限（秒）：只防手滑输入天文数字，不参与任何算法。 */
const DURATION_MAX = 600;

/** 当前时刻的帧率：分段帧率优先，取不到就用 doc.fps。逐帧步进与帧号显示都按它。 */
function fpsNow() {
    const doc = state.doc;
    if (!doc) return DEFAULT_FPS;
    const f = Number(fpsAtTime(doc, state.time));
    return f > 0 && Number.isFinite(f) ? f : Number(doc.fps) > 0 ? Number(doc.fps) : DEFAULT_FPS;
}

/**
 * 把播放头钉到 [0, total]，**不回绕**。
 *
 * 拖动刻度尺、逐帧步进、改完总时长之后都用它：这些操作里「时间跳回开头」
 * 是纯粹的惊吓。回绕只该发生在播放推进（playLoop 走 wrapTime）。
 */
function setTimeClamped(t) {
    const doc = state.doc;
    if (!doc) return state.time;
    const total = docDuration(doc);
    const v = Number(t);
    if (!Number.isFinite(v)) return state.time;
    state.time = total > 0 ? Math.max(0, Math.min(total, v)) : 0;
    engine.scheduleRender();
    scheduleRefresh({ timeOnly: true });
    updateChrome();
    return state.time;
}

/**
 * 逐帧步进 n 帧（n 可为负），按当前段帧率。
 * 先把播放头折算成帧号再折回秒：直接累加 1/fps 会浮点漂移，几帧之后
 * 播放头就卡在「介于两帧之间」的位置，逐帧检查动画时看着像掉了半帧。
 */
function stepFrames(n) {
    const doc = state.doc;
    if (!doc) return state.time;
    const total = docDuration(doc);
    if (!(total > 0)) return state.time;
    const f = fpsNow();
    const frame = Math.round(state.time * f) + Math.trunc(Number(n) || 0);
    return setTimeClamped(frame / f);
}

/**
 * 改「总时长」（doc.duration，秒）—— 就是时间轴上那根尺子本身。
 *
 * 下限取 max(一帧, 内容长度)：`docDuration()` 是 `max(duration, contentDuration)`，
 * 让 duration 低于内容长度只会得到一个「填了也白填」的数字，所以夹住并明确提示。
 */
function setDuration(sec) {
    const doc = state.doc;
    if (!doc) return 0;
    const fps = Number(doc.fps) > 0 ? Number(doc.fps) : DEFAULT_FPS;
    const content = contentDuration(doc);
    const min = Math.max(1 / fps, content);
    const wanted = Number(sec);
    if (!Number.isFinite(wanted)) return docDuration(doc);
    const next = Math.max(min, Math.min(DURATION_MAX, Math.round(wanted * 1000) / 1000));
    if (Math.abs(next - (Number(doc.duration) || 0)) > 1e-9) setDoc((d) => ({ ...d, duration: next }));
    if (wanted < min - 1e-9) {
        flash('总时长最短 ' + next.toFixed(2) + ' s' + (content > 0 ? '（内容到 ' + content.toFixed(2) + ' s）' : ''));
    }
    setTimeClamped(state.time);
    return next;
}

/** 活动对象的关键帧时刻（升序）。跳上下关键帧与「共几个键」都用它。 */
function activeKeyTimes() {
    const obj = activeObject();
    const keys = obj && obj.transform && Array.isArray(obj.transform.keys) ? obj.transform.keys : [];
    return keys
        .map((k) => (k ? Number(k.t) : NaN))
        .filter((t) => Number.isFinite(t))
        .sort((a, b) => a - b);
}

/**
 * 跳到上（dir<0）/ 下（dir>0）一个关键帧。
 * 契约 v5 把 `,` `.` 定义成「跳上下关键帧」，实现却接到了画格上；
 * 这里补上真正的关键帧跳转，到头了要提示，不能静默不动。
 */
function goToKey(dir) {
    const times = activeKeyTimes();
    if (!times.length) {
        flash('当前对象还没有关键帧');
        return state.time;
    }
    const now = state.time;
    const eps = 1e-6;
    let target = null;
    if (Number(dir) < 0) {
        for (let i = times.length - 1; i >= 0; i--) {
            if (times[i] < now - eps) {
                target = times[i];
                break;
            }
        }
        if (target == null) flash('已经是第一个关键帧');
    } else {
        for (const t of times) {
            if (t > now + eps) {
                target = t;
                break;
            }
        }
        if (target == null) flash('已经是最后一个关键帧');
    }
    return target == null ? state.time : setTimeClamped(target);
}

function setPlaying(v) {
    const want = !!v;
    if (want && !state.doc) return;
    if (state.playing === want) {
        updateChrome();
        return;
    }
    state.playing = want;
    if (want) {
        // 累计量是「从 . 起往前走了多少秒」，而 reverse 的显示时刻是 total - 累计量。
        // 不换算的话，从 0 起播会立刻显示成末尾（用户看到的就是「一按播放跳到结尾」）。
        const total = state.doc ? docDuration(state.doc) : 0;
        const reverse = state.doc && state.doc.loopMode === LOOP_REVERSE;
        playAcc = reverse && total > 0 ? Math.max(0, total - state.time) : state.time;
        playLast = 0;
        if (!playRaf) playRaf = requestAnimationFrame(playLoop);
    } else if (playRaf) {
        cancelAnimationFrame(playRaf);
        playRaf = 0;
        playLast = 0;
    }
    // 停下必须补一次全量：播放期间走的是时间档，只刷「跟时间走」的面板，
    // 其余面板停在开始播放那一刻的内容上。往末尾播到底（LOOP_NONE）也走这里 ——
    // 那一支自己排过一次时间档，这次调用会把 full 标记合并进同一次刷新。
    if (!want) scheduleRefresh();
    updateChrome();
}

/**
 * 播放循环：累计秒 → 显示时刻。
 *
 * 累计量 `playAcc` 只往前长（暂停就停住），怎么折回时间轴由 `playbackAt` 决定：
 * cycle / pingpong / reverse / none 四种全在 `core/playback.mjs` 里，本函数只管
 * 「乘速度、推进、必要时停」——判定放纯函数里才能在 node 里测。
 */
function playLoop(ts) {
    if (!state.playing) {
        playRaf = 0;
        return;
    }
    playRaf = requestAnimationFrame(playLoop);
    const doc = state.doc;
    if (!doc) {
        setPlaying(false);
        return;
    }
    const total = docDuration(doc);
    if (!(total > 0)) {
        setPlaying(false);
        return;
    }
    if (!playLast) playLast = ts;
    const dt = Math.max(0, Math.min(0.25, (ts - playLast) / 1000));
    playLast = ts;
    const speed = clampSpeed(prefSnap.playSpeed);
    playAcc += dt * speed;

    const step = playbackAt(playAcc, total, doc.loopMode);
    if (step.done) {
        // 单次播到底：停在末尾（累计量也钉到末尾，再点播放从头开始）
        playAcc = total;
        state.time = total;
        engine.scheduleRender();
        scheduleRefresh({ timeOnly: true });
        updateChrome();
        setPlaying(false);
        return;
    }
    const wrapped = step.t;
    if (Math.abs(wrapped - state.time) > 1e-6) {
        state.time = wrapped;
        engine.scheduleRender();
        scheduleRefresh({ timeOnly: true });
    }
    updateChrome();
}

/* ─────────────────────────── 面板刷新 / 状态栏 ─────────────────────────── */

let wantFullRefresh = false;
let refreshTimer = 0;
// 上一次刷新时的「当前生效画格」签名：变了才说明缩略图/画格行需要重画
let lastCelSig = '';
// 上一次排刷新的时刻：用来识别「rAF 被吞掉」的悬挂句柄（见 scheduleRefresh）
let refreshAskedAt = 0;
const REFRESH_FALLBACK_MS = 60;

/** 真正执行一次刷新，并把两条排队路径（rAF / 兜底定时器）互斥清空。 */
function runRefresh() {
    if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = 0;
    }
    if (refreshRaf) {
        cancelAnimationFrame(refreshRaf);
        refreshRaf = 0;
    }
    refreshAskedAt = 0;
    const full = wantFullRefresh;
    wantFullRefresh = false;
    refreshPanels(false, full);
}

/**
 * 合并刷新：一帧内多次请求只刷一次。
 *
 * 分级依据是「这次变化影响多大」：
 *   · 文档变了（setDoc / 撤销 / 换项目）→ 当前工作区的面板全刷；
 *   · 只有时间变了（播放 / 拖播放头 / 逐帧）→ 同样只刷当前工作区，且不带脏标记。
 * 播放时后一种每秒发生 fps 次，每次都遍历三个工作区、十几个面板的话掉帧是必然的
 * （旧实现就是这么干的），所以这里必须分级。
 *
 * 为什么要额外挂一个 60ms 兜底定时器（与 paint/engine.mjs 的 scheduleRender 同一个理由）：
 * rAF 在窗口隐藏 / 最小化 / 被完全遮挡时根本不回调。此时只靠 rAF 排队的面板刷新会永久停摆
 * —— 实测隐藏态下先排过一次 rAF 之后，refreshStats.calls 三秒内恒为 0，句柄永远挂着，
 * 后面的每次 scheduleRefresh 都直接 return，面板就再也不刷新了。定时器兜底让刷新一定落地。
 * 超过 REFRESH_STALE_MS 还没跑的句柄视为被吞掉，重新排（否则停摆依旧）。
 */
const REFRESH_STALE_MS = 80;

function scheduleRefresh(opts) {
    if (!(opts && opts.timeOnly === true)) wantFullRefresh = true;
    const t = nowMs();
    const pending = refreshRaf || refreshTimer;
    // 已有一帧在排，且没超时 → 合并成一次
    if (pending && refreshAskedAt && t - refreshAskedAt < REFRESH_STALE_MS) return;
    if (pending) {
        // 排了超过一帧还没跑：说明 rAF 被窗口状态吞了，扔掉旧句柄重排
        if (refreshRaf) {
            cancelAnimationFrame(refreshRaf);
            refreshRaf = 0;
        }
        if (refreshTimer) {
            clearTimeout(refreshTimer);
            refreshTimer = 0;
        }
    }
    refreshAskedAt = t;
    refreshTimer = setTimeout(runRefresh, REFRESH_FALLBACK_MS);
    refreshRaf = requestAnimationFrame(runRefresh);
}

/**
 * 刷新面板。full=true 表示「文档变了」级别，false 表示「只有时间变了」。
 *
 * 两个级别都只刷**当前工作区**：另外两个工作区的面板在 display:none 里，画了也看不见，
 * 却照样要重画 canvas、读回像素、重排时间轴 —— 实测全量刷 14 个面板 4.64ms、
 * 只刷当前工作区 5 个 2.54ms，一半是白花的（文档一变就发生一次）。
 * 隐藏工作区不会因此留旧态：切过去时 setWorkspace 会再排一次刷新，那时它已是当前工作区。
 */
function refreshPanels(withFocus, full) {
    const all = full !== false;
    const active = state.workspace;
    // 画格签名：只有跨过画格边界时，缩略图/画格行才需要重画（见 refresh-plan.mjs）。
    const sig = celSignature(objectsOf(state.doc), state.time);
    const celChanged = sig !== lastCelSig;
    lastCelSig = sig;
    // 轻量计数：播放掉帧排查用（window.motionStudio.state.refreshStats）。
    // 只记次数，不参与任何逻辑分支。
    state.refreshStats = state.refreshStats || { calls: 0, panels: 0, fullCalls: 0, hidden: 0, skipped: 0 };
    state.refreshStats.calls++;
    if (all) state.refreshStats.fullCalls++;
    // 先把当前工作区的面板摊平：分级要按「有一共有哪些编辑器」来算，
    // 而不是边遍历边判断，否则同一编辑器的多个实例会被算错。
    const slots = [];
    for (const view of viewList()) {
        if (view.ws !== active) {
            // 隐藏工作区整片跳过；记个数方便回归时确认「确实跳过了」
            if (all) state.refreshStats.hidden = (state.refreshStats.hidden || 0) + 1;
            continue;
        }
        for (const slot of view.map.values()) {
            if (slot && slot.inst) slots.push(slot);
        }
    }
    const plan = planRefresh(slots.map((s) => s.editor), { full: all, celChanged });
    // 同一个编辑器可能在一个工作区里开了多个实例（分屏），按次数发名额
    const quota = new Map();
    for (const id of plan.run) quota.set(id, (quota.get(id) || 0) + 1);
    for (const slot of slots) {
        const left = quota.get(slot.editor) || 0;
        if (left <= 0) {
            state.refreshStats.skipped = (state.refreshStats.skipped || 0) + 1;
            continue;
        }
        quota.set(slot.editor, left - 1);
        const inst = slot.inst;
        state.refreshStats.panels++;
        try {
            if (typeof inst.refresh === 'function') inst.refresh();
            if (withFocus && typeof inst.focusFrame === 'function') inst.focusFrame();
        } catch (err) {
            console.error('[shell] 面板刷新失败：' + slot.editor, err);
        }
    }
    updateChrome();
}

function flash(msg) {
    notice.text = String(msg == null ? '' : msg);
    notice.at = nowMs();
    updateChrome();
    // 消息过期后把顶栏提示还原成工具信息
    if (noteTimer) clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
        noteTimer = 0;
        updateChrome();
    }, NOTE_MS + 40);
}

/**
 * 顶栏提示位：只在 flash() 有新鲜消息时显示，平时留空（v8）。
 *
 * 常驻教程文案已经删掉了 —— 它挤在顶栏右侧、每次 updateChrome 都被重写一遍，
 * 却没人会看第二遍。画笔参数与工具名改在状态栏里显示（见 brushText）。
 */
function hintText() {
    if (notice.text && nowMs() - notice.at < NOTE_MS) return notice.text;
    return '';
}

/** 画笔状态一句话（只在画板工作区显示，编排时不画画就别占地方）。 */
function brushText() {
    const b = engine.brush();
    const tool = TOOLS.find((t) => t.id === engine.tool());
    return (
        (tool ? tool.name : String(engine.tool())) +
        ' ' + Math.round(b.size) + 'px' +
        ' · ' + Math.round(b.opacity * 100) + '%'
    );
}

function updateChrome() {
    if (shell.topbar) shell.topbar.update();
    if (!shell.statusbar) return;
    const doc = state.doc;
    if (!doc) {
        shell.statusbar.setLeft('就绪');
        shell.statusbar.setRight('');
        return;
    }
    const total = docDuration(doc);
    const objs = objectsOf(doc);
    const obj = objectById(doc, state.activeLayerId);
    const sel = state.selection ? objectById(doc, state.selection.id) : null;
    // 帧号按当前段帧率折算：分段帧率下「现在是第几帧」才有意义
    const fps = fpsNow();
    const frame = Math.round(state.time * fps);
    const frames = Math.max(1, Math.round(total * fps));
    shell.statusbar.setLeft(
        doc.width + '×' + doc.height + ' · ' + objs.length + ' 对象 · ' + Math.round(fps) + ' fps' +
        (state.workspace === 'draw' ? ' · ' + brushText() : '')
    );
    // 右侧永远是常驻信息，临时消息走顶栏 hint，避免把时间盖掉。
    // 开头带一个分隔号：状态栏是左右两段拼一行，少了它就成了「12 fpst 2.50 s」。
    shell.statusbar.setRight(
        '· t ' + state.time.toFixed(2) + ' s · 帧 ' + frame + '/' + frames +
        ' · ' + (sel ? '已选 ' + sel.name : obj ? obj.name : '无对象') +
        ' · ' + workspaceTitle()
    );
}

function workspaceTitle() {
    const t = WS_TABS.find((x) => x.id === state.workspace);
    return t ? t.title : String(state.workspace);
}

function onTransport(act) {
    const doc = state.doc;
    if (!doc) return;
    if (act === 'first') setTime(0);
    else if (act === 'prev') stepFrame(-1);
    else if (act === 'next') stepFrame(1);
    else if (act === 'last') setTime(docDuration(doc));
    else if (act === 'play') setPlaying(!state.playing);
}

/**
 * 换文档的唯一入口（新建 / 打开 / 导入都走这里）。
 * 顺序很重要：先停播放，再换 doc，最后重置选中与视图，避免 rAF 拿到半新半旧的 doc。
 */
function applyDoc(doc, meta) {
    if (!doc || !objectsOf(doc).length) {
        flash('项目数据不可用');
        return false;
    }
    if (state.playing) {
        state.playing = false;
        if (playRaf) {
            cancelAnimationFrame(playRaf);
            playRaf = 0;
        }
    }
    // 换文档（新建 / 打开 / 导入）意味着撤销栈里那些命令指向的旧文档已经不在屏幕上了，
    // 留着只会让 Ctrl+Z 把人瞬间拽回上一个项目，所以整栈清空。
    if (engine && typeof engine.clearHistory === 'function') engine.clearHistory();
    docMerge = { key: null, at: 0, cmd: null };
    state.doc = enrichDoc(doc);
    state.time = 0;
    const first = objectsOf(state.doc)[0];
    state.activeLayerId = first ? first.id : null;
    state.selection = null;
    const m = meta || {};
    project.id = m.id || '';
    project.name = m.name || '';
    project.file = m.file || '';
    project.dirty = !!m.dirty;
    store.setCurrentProjectId(project.id);
    // 撤销栈属于上一份文档：不清的话 Ctrl+Z 会把旧项目拉回来
    try {
        if (engine.history && typeof engine.history.clear === 'function') engine.history.clear();
    } catch (err) {
        console.error('[shell] 清空历史失败：', err);
    }
    clampSelection();
    engine.scheduleRender();
    try {
        engine.fitView();
    } catch (err) {
        console.error('[shell] fitView 失败：', err);
    }
    scheduleRefresh();
    updateChrome();
    notifyProjects();
    return true;
}

export {
    DEFAULT_W,
    DEFAULT_H,
    DEFAULT_FPS,
    DEFAULT_FRAMES,
    TOOL_KEYS,
    FALLBACK_EDITOR,
    state,
    shell,
    el,
    px,
    clampInt,
    viewList,
    activeView,
    activeObject,
    engine,
    enrichDoc,
    buildDocument,
    clampSelection,
    applyDoc,
    setDoc,
    subscribeDoc,
    currentCelTimes,
    celIndexOf,
    goToCel,
    goToCel as setFrame,
    stepFrame,
    setTime,
    setTimeClamped,
    stepFrames,
    setDuration,
    fpsNow,
    activeKeyTimes,
    goToKey,
    setPlaying,
    scheduleRefresh,
    flash,
    hintText,
    updateChrome,
    onTransport,
    project,
    markDirty,
    notifyProjects,
    onProjectsChange,
};

/* ─────────────────── 本机偏好（localStorage ms.prefs）的只读镜像 ─────────────────── */

/**
 * 偏好面板把 ms.prefs 归一化后写进这里，其它模块同步读。
 * 为什么不直接 import 面板模块：那会让每个消费方都依赖设置模式的面板，
 * 还要在 doc-state ↔ project-io ↔ registry 的循环里再补一条边。
 */
/** 偏好的缺省值与取值范围。范围来自面板的选项表（`editors/prop-prefs.mjs` 的 SAVE/UNDO/GRID/BG 选项），
 *  但不 import 面板模块 —— 那会绕出循环依赖；这里只按范围校验，手改的合法新值也能用。
 *  清洗逻辑本身在 `core/prefs.mjs`（纯函数，node 里可直跑测试）。 */
const PREF_DEFAULTS = Object.freeze({
    autoSave: 0,
    undoLimit: 100,
    snapGrid: 0.1,
    objectW: DEFAULT_W,
    objectH: DEFAULT_H,
    bg: 'checker',
    playSpeed: 1,
});

let prefSnap = Object.freeze(cleanPrefs(null, PREF_DEFAULTS));

/** 应用一份偏好快照（只合并已知键并逐项校验），返回生效后的完整快照。 */
export function setPrefs(next) {
    if (next && typeof next === 'object') {
        // 合并完再过 cleanPrefs：坏值退回缺省，未知键根本进不来
        prefSnap = Object.freeze(cleanPrefs(Object.assign({}, prefSnap, next), PREF_DEFAULTS));
    }
    // 撤销步数真正落到引擎：只存不生效等于假开关
    if (engine && typeof engine.setHistoryLimit === 'function') engine.setHistoryLimit(prefSnap.undoLimit);
    return prefSnap;
}

/** 预览播放速度（1 为原速）。读的是偏好快照，所以设置面板与工具条看到的是同一个值。 */
export function playSpeed() {
    return clampSpeed(prefSnap.playSpeed);
}

/**
 * 改预览播放速度并落盘。
 *
 * 落盘用「读-改-写」而不是整份覆盖：`ms.prefs` 里还有设置面板的键，
 * 工具条这一侧只该动自己那一项（否则在设置里改过、再来这里点一下速度就被打回缺省）。
 * 这里是播放速度的唯一写入点，面板与工具条都调它。
 */
export function setPlaySpeed(v) {
    const speed = clampSpeed(v);
    setPrefs({ playSpeed: speed });
    try {
        const KEY = 'ms.prefs';
        const raw = window.localStorage.getItem(KEY);
        const cur = raw ? JSON.parse(raw) : {};
        const next = cur && typeof cur === 'object' && !Array.isArray(cur) ? cur : {};
        next.playSpeed = speed;
        window.localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
        /* 无痕模式 / 坏 JSON：本次会话内仍然生效 */
    }
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('ms:prefs', { detail: prefSnap }));
    }
    flash('播放速度 ' + formatSpeed(speed));
    return speed;
}

/**
 * 开机时从 localStorage 读一次偏好并应用。
 * 不放在面板里：偏好是「全局生效的设置」，不该等用户点开设置模式才生效。
 */
export function loadPrefs() {
    try {
        const raw = window.localStorage.getItem('ms.prefs');
        if (raw) setPrefs(JSON.parse(raw));
    } catch {
        /* 坏 JSON 就用缺省值，不阻断启动 */
    }
    return prefSnap;
}

/** 当前生效的偏好（冻结对象，读不坏）。 */
export function prefSnapshot() {
    return prefSnap;
}

/** 新建对象应该拿到的位图尺寸：偏好优先，取不到就退回文档尺寸。 */
export function prefObjectSize() {
    const w = Math.round(Number(prefSnap.objectW));
    const h = Math.round(Number(prefSnap.objectH));
    return {
        w: Number.isFinite(w) && w > 0 ? w : DEFAULT_W,
        h: Number.isFinite(h) && h > 0 ? h : DEFAULT_H,
    };
}
