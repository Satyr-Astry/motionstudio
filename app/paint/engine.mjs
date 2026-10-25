/**
 * Kleks Motion —— 绘图引擎
 *
 * 自研，不依赖任何外部编辑器：显示画布、笔画落笔、油漆桶、取色、平移缩放、
 * 洋葱皮合成、撤销栈都在这里。文档结构（doc / cel / 图层变换）由 core/ 定义，
 * 引擎只负责「怎么把像素画上去、怎么把结果画出来」。
 *
 * 坐标约定：
 *   - 文档坐标 = 画面像素（0..doc.width / 0..doc.height）
 *   - 显示坐标 = 文档坐标 × zoom + pan
 *
 * 时间约定（v6）：一切都是秒。`getTime()` 给出播放头时间，落笔落在
 * 「该时间的纹理」——已有就复用，没有就建一个（默认继承上一张图）。
 */

import { createHistory } from '../core/history.mjs';
import { ensureCelAt, imageAt, objectById, objectsOf } from '../core/doc-model.mjs';
import { compositeFrame } from './composite.mjs';
import { createEvaluator, drawEvaluated } from '../core/evaluator.mjs';
import { createSurface } from './surface.mjs';
import { captureRegion, restoreRegion, makeRegionCommand, cropFromFull } from './patch.mjs';
import { makeTip, brushById, tipDiameter, spacingPx, BRUSH_DEFAULTS } from './brush.mjs';
import { point, spacingPoints, bounds, snapPixel, pressureCurve } from './stroke.mjs';
import { drawOnion } from './onion.mjs';

export const TOOLS = Object.freeze([
    { id: 'select', name: '选择', key: 'V' },
    { id: 'brush', name: '画笔', key: 'B' },
    { id: 'eraser', name: '橡皮', key: 'E' },
    { id: 'bucket', name: '填充', key: 'G' },
    { id: 'picker', name: '取色', key: 'I' },
    { id: 'pan', name: '平移', key: 'H' },
]);

/* ────────────────────── 取色：纯逻辑（不碰 DOM，可单测） ────────────────────── */

/**
 * 把 `getImageData(…, 1, 1).data` 变成 `'#rrggbb'`。
 * alpha 低于阈值（默认 8）视为**取不到**：透明像素在这里没有「颜色」可言，
 * 硬取出来会是 `#000000`，等于把画布背景当成黑色 —— 这是取色器最常见的错觉。
 */
export function pixelHex(d, alphaMin) {
    const lo = Number.isFinite(alphaMin) ? alphaMin : 8;
    if (!d || d.length < 4) return null;
    if (!(Number(d[3]) >= lo)) return null;
    const hx = (n) => {
        const v = Number(n);
        const c = Number.isFinite(v) ? Math.max(0, Math.min(255, Math.round(v))) : 0;
        return c.toString(16).padStart(2, '0');
    };
    return '#' + hx(d[0]) + hx(d[1]) + hx(d[2]);
}

/**
 * 指针按下时这一下要干什么 —— 引擎里唯一的「按键 → 动作」判据。
 *
 * 右键 = **取色**（对齐 Klecks 的 eyedropper：`tempTriggers = ['mouse-right','alt']`），
 * 且优先级最高：即使当前是「平移」工具、或正按着空格，右键也只取色不平移。
 * 左键仍走原来的工具语义，所以绘制路径一字未动。
 */
export function downIntent(button, tool, space, alt) {
    if (button === 2) return 'pick';
    // Alt + 左键 = 临时取色（Photoshop 与 Klecks 的通行约定：eyedropper 的
    // `tempTriggers` 里就有 'alt'）。空格与平移工具优先 —— 免得「按住空格拖画布」
    // 时顺手按了 Alt 就变成取色。
    if (alt && button === 0 && !space && tool !== 'pan') return 'pick';
    if (button === 1 || space || tool === 'pan') return 'pan';
    if (tool === 'select') return 'select';
    if (tool === 'picker') return 'pick';
    if (tool === 'bucket') return 'bucket';
    return 'stroke';
}

function fitCanvas(cv, w, h) {
    const W = Math.max(1, Math.round(w));
    const H = Math.max(1, Math.round(h));
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    return cv;
}

/* 棋盘底的图案缓存（按「上下文 → 格宽|dpr」失效）。
 * 旧实现每帧双重循环逐格 fillStyle + fillRect：900×640 视口在 79% 缩放下
 * 每帧 10115 次 fillRect、实测 5.6ms，占单帧 25.4ms 的 22%，纯属浪费。
 * 2×2 格刚好构成一个无缝平铺周期，做成 CanvasPattern 后每帧只剩一次 fillRect。 */
const checkerCache = new WeakMap();

/**
 * 按文档对象复用求值器：doc 是不可变的，内容一变就是新对象，
 * 所以用「引用相等」判断要不要重建 —— 播放同一段时只建一次。
 */
let evCacheDoc = null;
let evCache = null;

function evaluatorFor(doc) {
    if (!doc) return null;
    if (doc === evCacheDoc && evCache) return evCache;
    try {
        evCache = createEvaluator(doc, { cache: true });
        evCacheDoc = doc;
    } catch (e) {
        evCache = null;
        evCacheDoc = null;
    }
    return evCache;
}

/** 晕染用的离屏缓冲（每个引擎实例一份，按笔尖尺寸复用）。 */
let smudgeBuf = null;

export function createEngine(opts) {
    const o = opts || {};
    const getDoc = o.getDoc || (() => null);
    // 播放头时间（秒）：外壳注入，引擎不再关心「第几格」
    const getTime = o.getTime || (() => 0);
    // v3：动画工作区里禁止落笔（绘画只用于在绘图工作区创建对象）
    const canDraw = o.canDraw || (() => true);
    const getLayerId = o.getLayerId || (() => null);
    // 当前活动对象（选中/正在编辑的那个）；拿不到时退回 getLayerId 在文档里查
    const getActiveObject = typeof o.getActiveObject === 'function' ? o.getActiveObject : () => null;
    // v8：纹理画布模式 —— 绘图工作区把「当前纹理」当一张独立画布来画。
    // 关掉合成（不套对象变换/父子矩阵/效果），指针坐标与位图像素 1:1，
    // 这样对象有偏移也不会出现「笔落在别处」。返回 true 即启用。
    const isDrawingBoard = typeof o.isDrawingBoard === 'function' ? o.isDrawingBoard : () => false;
    /** 纹理画布模式下的目标位图（没有就返回 null，渲染退回合成路径）。 */
    /** 纹理画布模式下要处理的那个对象：活动对象 → 指定 id → 文档里第一个对象。 */
    function boardObject() {
        const doc = getDoc();
        if (!doc) return null;
        const act = getActiveObject();
        if (act && typeof act === 'object') return act;
        const lid = getLayerId();
        if (lid != null) {
            const byId = objectById(doc, lid);
            if (byId) return byId;
        }
        const list = objectsOf(doc);
        return list.length ? list[0] : null;
    }

    function boardImage() {
        if (!isDrawingBoard()) return null;
        const obj = boardObject();
        if (!obj) return null;
        const img = imageAt(obj, getTime());
        return img && typeof img.getContext === 'function' ? img : null;
    }
    // 新建纹理后把新对象写回文档：外壳注入 replaceObject(obj)，返回新文档与否都行
    const replaceObject = typeof o.replaceObject === 'function' ? o.replaceObject : null;
    // 效果器：外壳注入，返回 canvas filter 字符串（如 'blur(4px) drop-shadow(0 0 8px #4a7dff)'）
    const filterFor = typeof o.filterFor === 'function' ? o.filterFor : null;
    const onNotify = o.onNotify || (() => {});
    // 播放期降采样：洋葱皮与效果滤镜都很贵，播放时先跳掉，暂停后补一帧精确画面。
    const isPlaying = typeof o.isPlaying === 'function' ? o.isPlaying : () => false;

    const history = createHistory(120);

    const state = {
        tool: 'brush',
        brushId: 'round',
        size: BRUSH_DEFAULTS.size,
        opacity: 1,
        color: '#000000',
        zoom: 1,
        panX: 0,
        panY: 0,
        space: false,
        hover: null,
        // 播放期一共跳过了多少次洋葱皮/滤镜（调试与回归用，无业务逻辑）
        playSkips: 0,
    };

    let host = null;
    let view = null;
    let compose = null;
    let scratch = { buf: createSurface(2, 2), ctx: null };
    let raf = 0;
    let timer = 0;
    let stroke = null;
    let panning = null;
    let pickDrag = false;  // 右键按住拖取色（不改工具，松开即回原工具）
    let ro = null;

    if (scratch.buf) scratch.ctx = scratch.buf.getContext('2d');

    const warned = new Set();
    function warnOnce(key, msg) {
        if (warned.has(key)) return;
        warned.add(key);
        console.warn('[engine] ' + msg);
    }

    /* ────────────────────────── 视图 ────────────────────────── */

    function docSize() {
        const board = boardImage();
        if (board) return { w: Math.max(1, board.width | 0 || 1), h: Math.max(1, board.height | 0 || 1) };
        const d = getDoc();
        return { w: Math.max(1, (d && d.width) | 0 || 1), h: Math.max(1, (d && d.height) | 0 || 1) };
    }

    function fitView() {
        if (!view) return false;
        const { w, h } = docSize();
        const r = view.getBoundingClientRect();
        const vw = Math.max(32, r.width || host.clientWidth || w);
        const vh = Math.max(32, r.height || host.clientHeight || h);
        const z = Math.min((vw - 24) / w, (vh - 24) / h);
        const nz = Math.max(0.05, Math.min(8, z));
        const nx = Math.round((vw - w * nz) / 2);
        const ny = Math.round((vh - h * nz) / 2);
        // 返回「这次是否真的改变了视图」：调用方要靠它区分「适配过」和「本来就在适配位」，
        // 否则零变化会让人以为按钮坏了（与 board.mjs fit() 同一处理，见台账 §1s）。
        const changed = Math.abs(nz - state.zoom) > 1e-6
            || Math.abs(nx - state.panX) > 1 || Math.abs(ny - state.panY) > 1;
        state.zoom = nz;
        state.panX = nx;
        state.panY = ny;
        scheduleRender();
        return changed;
    }

    function setZoom(z, cx, cy) {
        const { w, h } = docSize();
        const r = view ? view.getBoundingClientRect() : { width: w, height: h };
        const ax = cx == null ? r.width / 2 : cx;
        const ay = cy == null ? r.height / 2 : cy;
        const before = { x: (ax - state.panX) / state.zoom, y: (ay - state.panY) / state.zoom };
        state.zoom = Math.max(0.05, Math.min(16, z));
        state.panX = ax - before.x * state.zoom;
        state.panY = ay - before.y * state.zoom;
        scheduleRender();
    }

    function zoomBy(k, cx, cy) {
        setZoom(state.zoom * k, cx, cy);
    }

    /* ────────────────────────── 渲染 ────────────────────────── */

    function scheduleRender() {
        if (raf) return;
        // rAF 在窗口不可见 / 最小化 / 后台标签时会被暂停，编辑类操作必须仍能出图，
        // 所以再挂一个短定时器兜底：谁先到谁渲染，另一个自动让位（raf 标志互斥）。
        if (!timer) {
            timer = setTimeout(() => {
                timer = 0;
                if (raf) {
                    cancelAnimationFrame(raf);
                    raf = 0;
                }
                render();
            }, 60);
        }
        raf = requestAnimationFrame(() => {
            raf = 0;
            if (timer) {
                clearTimeout(timer);
                timer = 0;
            }
            render();
        });
    }

    function render() {
        const doc = getDoc();
        if (!doc || !view) return;
        const t = getTime();
        const { w: W, h: H } = docSize();
        if (!compose) compose = createSurface(W, H);
        fitCanvas(compose, W, H);
        const cg = compose.getContext('2d');
        if (!cg) return;
        cg.setTransform(1, 0, 0, 1, 0, 0);
        cg.globalAlpha = 1;
        cg.globalCompositeOperation = 'source-over';
        cg.clearRect(0, 0, W, H);

        const playing = !stroke && isPlaying();
        if (playing) state.playSkips += 1;
        const board = !stroke ? boardImage() : null;
        if (board && (board.width !== state.boardW || board.height !== state.boardH)) {
            state.boardW = board.width;
            state.boardH = board.height;
            fitView();
        }
        if (board) {
            // 纹理画布：把这张纹理原样（1:1）画进合成缓冲，落笔与所见完全对得上
            cg.drawImage(board, 0, 0, W, H);
        } else if (!stroke && !playing) {
            drawOnion(cg, doc, t, scratch);
            cg.globalAlpha = 1;
        }
        // v6：整帧合成走统一求值器 —— 只有这条路径同时应用
        // 对象时间通道（offset / scale / loop / hold）与父子层级变换。
        // 注意：drawEvaluated 返回「这帧是否画了东西」，画空也是正确结果，
        // 绝不能因此回退到旧路径 —— 旧路径不认局部时间，会把内容又画回来。
        if (!board) {
            const ev = evaluatorFor(doc);
            // 播放时不给滤镜：canvas filter 逐层重算是播放掉帧的最大头
            const ff = playing ? null : filterFor;
            if (ev) {
                drawEvaluated(cg, ev, t, { clear: false, filterFor: ff });
            } else {
                compositeFrame(cg, doc, t, { clear: false, time: t, filterFor: ff });
            }
        }

        const r = view.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        fitCanvas(view, Math.max(1, r.width) * dpr, Math.max(1, r.height) * dpr);
        const vg = view.getContext('2d');
        if (!vg) return;
        vg.setTransform(1, 0, 0, 1, 0, 0);
        vg.clearRect(0, 0, view.width, view.height);
        vg.setTransform(dpr, 0, 0, dpr, 0, 0);
        vg.imageSmoothingEnabled = state.zoom < 1;
        const dw = W * state.zoom;
        const dh = H * state.zoom;

        // 棋盘底，让透明区域一眼可辨
        drawChecker(vg, state.panX, state.panY, dw, dh, Math.max(4, Math.round(8 * state.zoom)), dpr);
        vg.drawImage(compose, state.panX, state.panY, dw, dh);
        vg.setTransform(1, 0, 0, 1, 0, 0);
        vg.strokeStyle = 'rgba(255,255,255,0.22)';
        vg.lineWidth = 1;
        vg.strokeRect(state.panX * dpr + 0.5, state.panY * dpr + 0.5, dw * dpr, dh * dpr);
    }

    /**
     * 造（或取用缓存的）棋盘图案。返回 null 表示这条路不可用，调用方退回逐格画。
     *
     * 图案是「2×2 格」的位图，格宽按设备像素造（c*dpr），再用 pattern.setTransform
     * 折回 CSS 像素 —— 否则 ctx 上已有的 dpr 缩放会把图案再放大一次，hi-dpi 屏上
     * 格子会变成两倍大，那就成了画面走样而不是优化。
     */
    function checkerPattern(g, c, dpr) {
        const key = c + '|' + dpr;
        const hit = checkerCache.get(g);
        if (hit && hit.key === key) return hit.pat;
        if (typeof DOMMatrix !== 'function') return null;
        let pat = null;
        try {
            const unit = Math.max(2, Math.round(c * dpr));
            const surf = createSurface(unit * 2, unit * 2);
            const sg = surf.getContext('2d');
            if (sg) {
                sg.fillStyle = '#35383f';
                sg.fillRect(0, 0, unit * 2, unit * 2);
                sg.fillStyle = '#2c2f35';
                sg.fillRect(unit, 0, unit, unit);
                sg.fillRect(0, unit, unit, unit);
                pat = g.createPattern(surf, 'repeat');
                if (pat && typeof pat.setTransform === 'function') {
                    pat.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, 0, 0]));
                } else {
                    pat = null;
                }
            }
        } catch (e) {
            pat = null;
        }
        if (pat) checkerCache.set(g, { key, pat });
        return pat;
    }

    function drawChecker(g, x, y, w, h, cell, dpr) {
        if (w <= 0 || h <= 0) return;
        const c = Math.max(3, Math.min(16, cell));
        const s = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
        const pat = checkerPattern(g, c, s);
        if (pat) {
            // 铺满与旧实现完全相同的矩形，因此不必再 clip
            g.save();
            g.fillStyle = pat;
            g.fillRect(x, y, w, h);
            g.restore();
            return;
        }
        // 兜底：图案不可用（老运行时 / 造图案抛错）时保持逐格画，行为与原来一致
        g.save();
        g.beginPath();
        g.rect(x, y, w, h);
        g.clip();
        g.translate(x, y);
        const cols = Math.ceil(w / c);
        const rows = Math.ceil(h / c);
        for (let j = 0; j < rows; j++) {
            for (let i = 0; i < cols; i++) {
                g.fillStyle = (i + j) % 2 ? '#2c2f35' : '#35383f';
                g.fillRect(i * c, j * c, c, c);
            }
        }
        g.restore();
    }

    /* ────────────────────────── 坐标 ────────────────────────── */

    function toDoc(e) {
        const r = view.getBoundingClientRect();
        return {
            x: (e.clientX - r.left - state.panX) / state.zoom,
            y: (e.clientY - r.top - state.panY) / state.zoom,
        };
    }

    function pressureOf(e) {
        const p = typeof e.pressure === 'number' && e.pressure > 0 && e.pressure !== 0.5 ? e.pressure : 1;
        return pressureCurve(p, 0);
    }

    /* ────────────────────────── 落笔 ────────────────────────── */

    /**
     * 当前可写位图：取 getTime() 处的纹理（没有就新建，默认继承上一张图）。
     * 返回 { cel, image }；拿不到活动对象时返回 null（落笔/填充自然变成空操作）。
     */
    function activeCel() {
        const doc = getDoc();
        if (!doc) return null;
        const t = getTime();

        let obj = getActiveObject();
        if (!obj || typeof obj !== 'object') {
            const lid = getLayerId();
            obj = lid == null ? null : objectById(doc, lid);
        }
        // 兜底：一个都没选中时用第一个对象（绘图区必须有明确目标，否则笔会落到别处）
        if (!obj || typeof obj !== 'object') {
            const list = objectsOf(doc);
            obj = list.length ? list[0] : null;
        }
        if (!obj || typeof obj !== 'object') {
            warnOnce('no-target', '拿不到活动对象，落笔跳过（外壳需注入 getActiveObject 或 getLayerId）');
            return null;
        }

        const { obj: nextObj, cel } = ensureCelAt(obj, t, { inherit: true });
        if (!cel) return null;

        const { w, h } = docSize();
        if (!cel.image) cel.image = createSurface(w, h);
        else if (cel.image.width !== w || cel.image.height !== h) fitCanvas(cel.image, w, h);

        if (nextObj !== obj) {
            // 新建了纹理：把新对象交回外壳写进文档，否则这一格无处安放
            if (replaceObject) {
                replaceObject(nextObj);
                onNotify('cel');
            } else {
                warnOnce('no-commit', '新建纹理无法回写文档：外壳需注入 replaceObject(obj)');
            }
        }
        return { cel, image: cel.image };
    }

    function brushDef() {
        const base = brushById(state.tool === 'eraser' ? 'eraser' : state.brushId);
        return base;
    }

    function startStroke(e) {
        const target = activeCel();
        if (!target) return false;
        const b = brushDef();
        const g = target.image.getContext('2d');
        if (!g) return false;
        const p = toDoc(e);
        const pt = b.pixelGrid ? snapPixel(p, 1) : p;
        stroke = {
            image: target.image,
            ctx: g,
            brush: b,
            tip: makeTip(b, state.size, state.color, state.opacity),
            size: tipDiameter(b, state.size),
            gap: spacingPx(b, state.size),
            erase: !!b.erase,
            baseAlpha: Math.max(0.02, Math.min(1, state.opacity)),
            points: [point(pt.x, pt.y, pressureOf(e))],
            carry: 0,
            full: null,
            dirty: null,
            moved: false,
        };
        // 先抓整层：改动区要抬笔后才知道，整层只在内存里活到那一刻
        try {
            const d = docSize();
            stroke.full = g.getImageData(0, 0, d.w, d.h);
        } catch (err) {
            stroke.full = null;
        }
        stroke.last = { x: pt.x, y: pt.y };
        stampAt(pt.x, pt.y, pressureOf(e));
        stroke.last = { x: pt.x, y: pt.y };
        scheduleRender();
        return true;
    }

    /** 晕染用的离屏小画布（与笔尖同尺寸），每个笔尖尺寸复用一个。 */
    function smudgeScratch(w, h) {
        if (!smudgeBuf || smudgeBuf.width !== w || smudgeBuf.height !== h) {
            smudgeBuf = createSurface(Math.max(1, w), Math.max(1, h));
        }
        const g = smudgeBuf.getContext('2d');
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
        g.clearRect(0, 0, smudgeBuf.width, smudgeBuf.height);
        return { canvas: smudgeBuf, ctx: g };
    }

    function stampAt(x, y, pressure) {
        if (!stroke) return;
        const g = stroke.ctx;
        const brush = stroke.brush;
        const half = stroke.tip.width / 2;
        const p = brush.pixelGrid ? 1 : Math.max(0.15, pressure == null ? 1 : pressure);
        const alpha = Math.max(0.02, Math.min(1, stroke.baseAlpha * (brush.flow == null ? 1 : brush.flow) * p));
        g.save();
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';

        if (brush.scatter) {
            // 散点：一个落点打 count 个随机偏移的小点（半径按 spread 倍算），
            // 每个点的不透明度按 1/sqrt(count) 分摊，堆起来不会突然变实。
            const { count, spread } = brush.scatter;
            const n = Math.max(1, Math.round(count));
            const rad = half * Math.max(0, spread);
            g.globalAlpha = Math.max(0.02, Math.min(1, alpha / Math.sqrt(n)));
            for (let i = 0; i < n; i += 1) {
                const a = Math.random() * Math.PI * 2;
                const r = Math.sqrt(Math.random()) * rad;
                g.drawImage(stroke.tip, x + Math.cos(a) * r - half, y + Math.sin(a) * r - half);
            }
            g.restore();
            return;
        }

        if (brush.smudge && stroke.last) {
            // 晕染：把「上一处」的像素按笔尖形状搬到当前处，再补一点原色固色。
            const d = stroke.tip.width;
            const { canvas: buf, ctx: bg } = smudgeScratch(d, d);
            bg.drawImage(stroke.image, stroke.last.x - half, stroke.last.y - half, d, d, 0, 0, d, d);
            bg.globalCompositeOperation = 'destination-in';
            bg.drawImage(stroke.tip, 0, 0);
            bg.globalCompositeOperation = 'source-over';
            g.globalAlpha = Math.max(0.02, Math.min(1, alpha * (brush.strength == null ? 0.55 : brush.strength)));
            g.drawImage(buf, x - half, y - half);
            // 固色：搬走之后原地会越拖越淡，补 1/4 强度的笔尖
            g.globalAlpha = Math.max(0.02, Math.min(1, alpha * 0.25));
            g.drawImage(stroke.tip, x - half, y - half);
            g.restore();
            return;
        }

        g.globalAlpha = alpha;
        if (brush.pixelGrid) {
            g.drawImage(stroke.tip, Math.round(x - half), Math.round(y - half));
        } else {
            g.drawImage(stroke.tip, x - half, y - half);
        }
        g.restore();
    }

    function extendStroke(e) {
        if (!stroke) return;
        const p = toDoc(e);
        const pr = pressureOf(e);
        const prev = stroke.points[stroke.points.length - 1];
        const nextRaw = stroke.brush.pixelGrid ? snapPixel(p, 1) : p;
        if (stroke.brush.pixelGrid && Math.abs(nextRaw.x - prev.x) < 0.5 && Math.abs(nextRaw.y - prev.y) < 0.5) return;
        const { points, carry } = spacingPoints(prev, point(nextRaw.x, nextRaw.y, pr), stroke.gap, stroke.carry);
        stroke.carry = carry;
        for (const sp of points) {
            stampAt(sp.x, sp.y, sp.p);
            stroke.last = { x: sp.x, y: sp.y };
            stroke.points.push(point(sp.x, sp.y, sp.p));
            stroke.moved = true;
        }
        scheduleRender();
    }

    function endStroke() {
        if (!stroke) return;
        const s = stroke;
        stroke = null;
        if (!s.moved && !s.brush.pixelGrid) {
            // 单击也留一个点
            stampAt(s.points[0].x, s.points[0].y, s.points[0].p);
        }
        const r = bounds(s.points, s.size / 2 + 2);
        if (r && r.w > 0 && r.h > 0) {
            const before = s.full ? cropFromFull(s.full, r) : null;
            const after = captureRegion(s.image, r);
            if (before && after) {
                history.push(makeRegionCommand(s.image, before, after, s.erase ? '擦除' : '绘制'));
            }
        }
        s.full = null;
        onNotify('paint');
        scheduleRender();
    }

    /* ────────────────────────── 工具 ────────────────────────── */

    function floodFill(x, y, hex, tolerance) {
        const target = activeCel();
        if (!target) return false;
        const { image } = target;
        const { w: W, h: H } = docSize();
        const g = image.getContext('2d');
        if (!g) return false;
        const sx = Math.floor(x);
        const sy = Math.floor(y);
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) return false;

        const before = captureRegion(image, { x: 0, y: 0, w: W, h: H });
        const img = g.getImageData(0, 0, W, H);
        const data = img.data;
        const idx = (xx, yy) => (yy * W + xx) * 4;
        const start = idx(sx, sy);
        const target0 = [data[start], data[start + 1], data[start + 2], data[start + 3]];
        const rgb = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
        const nc = rgb
            ? [parseInt(rgb[1].slice(0, 2), 16), parseInt(rgb[1].slice(2, 4), 16), parseInt(rgb[1].slice(4, 6), 16), 255]
            : [0, 0, 0, 255];
        if (target0[0] === nc[0] && target0[1] === nc[1] && target0[2] === nc[2] && target0[3] === nc[3]) return false;

        const tol = tolerance == null ? 24 : tolerance;
        const stack = [sx, sy];
        const seen = new Uint8Array(W * H);
        let painted = 0;
        const match = (i) => {
            if (data[i + 3] === 0 && target0[3] === 0) return true;
            return (
                Math.abs(data[i] - target0[0]) <= tol &&
                Math.abs(data[i + 1] - target0[1]) <= tol &&
                Math.abs(data[i + 2] - target0[2]) <= tol &&
                Math.abs(data[i + 3] - target0[3]) <= tol
            );
        };
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
            painted++;
            stack.push(cx + 1, cy, cx - 1, cy, cx, cy + 1, cx, cy - 1);
        }
        if (!painted) return false;
        g.putImageData(img, 0, 0);
        const after = captureRegion(image, { x: 0, y: 0, w: W, h: H });
        if (before && after) history.push(makeRegionCommand(image, before, after, '填充'));
        onNotify('paint');
        scheduleRender();
        return true;
    }

    function pickColor(x, y) {
        if (!compose) return null;
        const g = compose.getContext('2d');
        if (!g) return null;
        const { w: W, h: H } = docSize();
        const sx = Math.floor(x);
        const sy = Math.floor(y);
        if (sx < 0 || sy < 0 || sx >= W || sy >= H) return null;
        return pixelHex(g.getImageData(sx, sy, 1, 1).data);
    }

    /** 取色并同步界面：颜色真的变了才通知，免得拖动取色时把状态栏刷成跑马灯。 */
    function pickAt(e) {
        const p = toDoc(e);
        const c = pickColor(p.x, p.y);
        if (!c) return false;
        if (c !== state.color) {
            state.color = c;
            onNotify('color');
        }
        return true;
    }

    /* ────────────────────────── 事件 ────────────────────────── */

    function onDown(e) {
        if (!view) return;
        const what = downIntent(e.button, state.tool, state.space, e.altKey);
        if (what === 'pan') {
            panStart(e);
            return;
        }
        if (what === 'pick') {
            // 右键 / 取色工具：只读操作，不受 canDraw 限制（播放中也能取色）。
            // 右键取色不改 state.tool，按住还能连续取样 —— 松开就是原来的工具。
            if (e.button === 2 || e.altKey) {
                pickDrag = true;
                try {
                    view.setPointerCapture(e.pointerId);
                } catch (err) {
                    /* 合成事件 / 无捕获指针时忽略 */
                }
            }
            pickAt(e);
            return;
        }
        if (what === 'select') {
            // 选择工具不落笔：选中框 / 手柄 / 拖动对象全部交给画布叠加层（editors/canvas.mjs）
            return;
        }
        if (!canDraw()) {
            state.tool = 'select';
            onNotify('tool');
            return;
        }
        if (what === 'bucket') {
            const b = toDoc(e);
            floodFill(b.x, b.y, state.color);
            return;
        }
        view.setPointerCapture(e.pointerId);
        startStroke(e);
    }

    function onMove(e) {
        const p = toDoc(e);
        state.hover = p;
        if (pickDrag) {
            pickAt(e);
            return;
        }
        if (panning) {
            state.panX = panning.px + (e.clientX - panning.x);
            state.panY = panning.py + (e.clientY - panning.y);
            scheduleRender();
            return;
        }
        if (stroke) {
            extendStroke(e);
            return;
        }
    }

    function onUp(e) {
        if (pickDrag) {
            pickDrag = false;
            try {
                view.releasePointerCapture(e.pointerId);
            } catch (err) {
                /* 指针已经没了：无需释放 */
            }
            return;
        }
        if (panning) {
            panning = null;
            return;
        }
        if (stroke) {
            try {
                view.releasePointerCapture(e.pointerId);
            } catch (err) {
                /* 某些指针类型没有捕获，忽略 */
            }
            endStroke();
        }
    }

    function panStart(e) {
        panning = { x: e.clientX, y: e.clientY, px: state.panX, py: state.panY };
        view.setPointerCapture(e.pointerId);
    }

    function onWheel(e) {
        if (!e.ctrlKey && !e.metaKey) {
            state.panX -= e.deltaX;
            state.panY -= e.deltaY;
            scheduleRender();
            e.preventDefault();
            return;
        }
        const r = view.getBoundingClientRect();
        zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX - r.left, e.clientY - r.top);
        e.preventDefault();
    }

    function onKey(e) {
        if (e.code === 'Space') state.space = e.type === 'keydown';
    }

    /* ────────────────────────── 生命周期 ────────────────────────── */

    function attach(el) {
        host = el;
        host.classList.add('kl-engine');
        view = document.createElement('canvas');
        view.className = 'kl-view';
        host.appendChild(view);
        view.addEventListener('pointerdown', onDown);
        view.addEventListener('pointermove', onMove);
        view.addEventListener('pointerup', onUp);
        view.addEventListener('pointercancel', onUp);
        view.addEventListener('wheel', onWheel, { passive: false });
        view.addEventListener('contextmenu', (e) => e.preventDefault());
        window.addEventListener('keydown', onKey);
        window.addEventListener('keyup', onKey);
        ro = new ResizeObserver(() => {
            fitView();
            scheduleRender();
        });
        ro.observe(host);
        requestAnimationFrame(() => fitView());
        return view;
    }

    function detach() {
        if (ro) ro.disconnect();
        ro = null;
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('keyup', onKey);
        if (view && view.parentNode) view.parentNode.removeChild(view);
        view = null;
        host = null;
    }

    /* 轻量订阅：工具/笔刷/颜色/撤销栈变化时通知界面同步 */
    const listeners = new Set();
    function emit(reason) {
        for (const fn of Array.from(listeners)) {
            try {
                fn(reason);
            } catch (err) {
                /* 单个订阅者出错不应打断绘图 */
            }
        }
    }

    const api = {
        attach,
        detach,
        subscribe(fn) {
            listeners.add(fn);
            return () => listeners.delete(fn);
        },
        render,
        scheduleRender,
        fitView,
        zoomBy,
        setZoom,
        zoom: () => state.zoom,
        view: () => view,
        state,
        // 偏好面板改撤销步数时调它（history.setLimit 会顺手裁掉超出的旧命令）
        setHistoryLimit(n) { return typeof history.setLimit === 'function' ? history.setLimit(n) : 0; },
        getHistoryLimit() { return typeof history.getLimit === 'function' ? history.getLimit() : 0; },
        history,
        tool: () => state.tool,
        setTool(id) {
            state.tool = id;
            scheduleRender();
            emit('tool');
        },
        brush: () => ({ id: state.brushId, size: state.size, opacity: state.opacity, color: state.color }),
        setBrush(patch) {
            if (!patch) return;
            if (patch.id) state.brushId = patch.id;
            if (Number.isFinite(patch.size)) state.size = Math.max(1, Math.min(400, patch.size));
            if (Number.isFinite(patch.opacity)) state.opacity = Math.max(0, Math.min(1, patch.opacity));
            if (patch.color) state.color = patch.color;
            emit('brush');
        },
        color: () => state.color,
        setColor(c) {
            if (c) state.color = c;
            emit('color');
        },
        undo() {
            const ok = history.undo();
            if (ok) onNotify('undo');
            scheduleRender();
            emit('undo');
            return ok;
        },
        redo() {
            const ok = history.redo();
            if (ok) onNotify('redo');
            scheduleRender();
            emit('redo');
            return ok;
        },
        /* v8：文档级改动（关键帧、对象、纹理、时长……）也要进同一个撤销栈。
           引擎是唯一持有 history 的地方，外壳通过这两个口子把文档命令塞进来，
           这样「画一笔 → 挪关键帧 → Ctrl+Z」的撤销顺序才和用户操作顺序一致。 */
        pushCommand(cmd) {
            const ok = history.push(cmd);
            if (ok) emit('history');
            return ok;
        },
        canUndo: () => history.canUndo(),
        canRedo: () => history.canRedo(),
        historyDepth: () => history.depth(),
        historyLabels: () => history.labels(),
        clearHistory() {
            history.clear();
            emit('undo');
        },
        fill: floodFill,
        pick: pickColor,
        isDrawing: () => !!stroke,
        /* v8：纹理画布 —— 绘图工作区把当前纹理当独立画布（1:1 呈现、1:1 落笔）。 */
        boardImage: () => boardImage(),
        isDrawingBoard: () => !!boardImage(),
    };

    return api;
}
