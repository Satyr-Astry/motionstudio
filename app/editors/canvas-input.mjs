/**
 * 画布指针交互（从 editors/canvas.mjs 抽出）
 *
 * 三件事：命中判定（把屏幕坐标喂给 core/gizmo.pickHandle）、
 * 拖动生命周期（rAF 节流 + 撤销记录 + toast）、指针入口 onDown。
 * 真正的命中/拖动数学在 core/gizmo.mjs，关键帧写入由外部传入的 writeKey 负责。
 */

import { layerById } from '../core/cel.mjs';
import {
    elementLattice, handlePoints, elementWorldMatrix, elementSize, elementState,
    applyMatrix, localUv, anchorPoint, invertMatrix,
} from '../core/element.mjs';
import { HIT_PX, pickHandle, pickAnchor, anchorUvFromMatrix, dragPatch } from '../core/gizmo.mjs';

/**
 * @param {object} deps
 *   host           宿主单例（监听与指针捕获）
 *   ctx            外壳上下文
 *   engine         引擎（只为读当前工具名）
 *   toDocPoint     指针事件 → doc 坐标
 *   toScreen       doc 坐标 → 宿主相对屏幕像素
 *   toScreenQuad   四角投影
 *   selectionInfo  当前选区信息
 *   writeKey       关键帧写入
 * @returns {{ onDown:Function, dispose:Function }}
 */
export function createInput(deps) {
    const { host, ctx, engine, toDocPoint, toScreen, toScreenQuad, selectionInfo, writeKey } = deps;
    const toScreenArr = (a) => toScreen({ x: a[0], y: a[1] });

    /* ── 命中检测 ── */

    /**
     * 返回 { kind:'scale'|'rotate'|'move'|'lattice', name, vertex } 或 null。
     * 屏幕距离判断，手柄大小不随缩放变化。
     */
    function hitAt(p, allowMove) {
        const info = selectionInfo();
        if (!info) return null;
        const { doc, el, sel, time, parentM } = info;
        const mode = sel.mode === 'warp' ? 'warp' : 'transform';
        const opts = { mode, threshold: HIT_PX };
        if (mode === 'warp') {
            // 网格模式：顶点也参与命中（core 里遍历全部顶点）
            const lat = elementLattice(doc, el, time, parentM);
            opts.lattice = {
                cols: lat.lattice.cols,
                rows: lat.lattice.rows,
                map: (u, v) => toScreenArr(lat.map(u, v)),
            };
        }
        // 旋转原点（锚点十字）：半径 HIT_PX 内直接命中。它常落在选框里面，
        // 必须排在泛型手柄之前，否则永远拖不到。
        // 注意 applyMatrix 返回的是 {x,y} 对象（不是 [x,y] 数组），这里必须用 toScreen 而不是 toScreenArr——
        // 传错会让坐标变成 NaN，命中判定恒为 false，锚点于是永远拖不动、只能命中同位置的 nw 手柄。
        const size0 = elementSize(doc, el, time);
        const aScr = toScreen(applyMatrix(elementWorldMatrix(el, time, size0, parentM), anchorPoint(el, size0)));
        const onAnchor = pickAnchor(aScr, { x: p.sx, y: p.sy }, HIT_PX);
        if (onAnchor) return onAnchor;
        // 内部 → 移动：需要 doc 空间反解，放进 core 的 inside 谓词里做。
        // 用 localUv（不夹取）而不是 worldToLocal：后者会把越界点夹成 0 / 1，
        // 于是「对象左边外 1-2px」也算在内部，点空白处反而能选中对象。
        opts.inside = allowMove
            ? () => {
                const loc = localUv(doc, el, time, { x: p.x, y: p.y }, parentM, 0);
                if (!loc) return false;
                const s = elementSize(doc, el, time);
                return loc.x >= 0 && loc.x <= s.w && loc.y >= 0 && loc.y <= s.h;
            }
            : false;
        return pickHandle(toScreenQuad(handlePoints(doc, el, time, parentM).quad), { x: p.sx, y: p.sy }, opts);
    }

    /* ── 拖动状态 ── */

    let drag = null;
    let dragRaf = 0;
    let pendingPointer = null;
    /** 拖锚点期间的预览态：{ elId, u, v }。只画十字，不动文档。 */
    let preview = null;
    let dragCanceled = false;

    function startDrag(e, onHandle) {
        const info = selectionInfo();
        if (!info) return;
        const { doc, el, time, parentM } = info;
        const size = elementSize(doc, el, time);
        drag = {
            pick: onHandle,
            elId: el.id,
            mode: info.sel.mode === 'warp' ? 'warp' : 'transform',
            before: doc,
            p0: toDocPoint(e),
            start: elementState(el, time),
            anchorWorld: applyMatrix(elementWorldMatrix(el, time, size, parentM), anchorPoint(el, size)),
            quad: handlePoints(doc, el, time, parentM).quad,
            size,
            parentM,
        };
        preview = null;
        dragCanceled = false;
        try {
            host.setPointerCapture(e.pointerId);
        } catch (err) {
            /* 某些指针类型不支持捕获 */
        }
        window.addEventListener('pointermove', onDragMove, true);
        window.addEventListener('pointerup', onDragEnd, true);
        window.addEventListener('pointercancel', onDragEnd, true);
        window.addEventListener('keydown', onDragKeyDown, true);
    }

    /** 拖动中按 Esc = 放弃这次拖动（锚点回到按下前的样子，不写文档） */
    function onDragKeyDown(e) {
        if (e.key !== 'Escape' && e.key !== 'Esc') return;
        if (!drag) return;
        dragCanceled = true;
        onDragEnd();
    }

    function onDragMove(e) {
        if (drag && e.buttons === 0) drag = null;   // capture 失效时鼠标其实已经抬起
        if (!drag) return;
        pendingPointer = e;
        if (dragRaf) return;
        dragRaf = requestAnimationFrame(() => {
            dragRaf = 0;
            const ev = pendingPointer;
            pendingPointer = null;
            if (!drag || !ev) return;
            applyDrag(ev);
        });
    }

    /**
     * 网格拖动的「补起点帧」策略：只在对象还没有两个关键帧、且当前时刻不在 0 附近时动手。
     * 补出来的帧是空 patch（值等于当时的状态），所以画面不会跳，只是让后面那一帧成为插值终点。
     */
    function ensureWarpBaseKey(elId) {
        const t = ctx.time();
        if (!(t > 1e-6)) return false;
        const doc = ctx.doc();
        if (!doc) return false;
        const el = layerById(doc, elId);
        if (!el) return false;
        const keys = el.transform && Array.isArray(el.transform.keys) ? el.transform.keys : [];
        if (keys.length >= 2) return false;
        const next = writeKey(doc, elId, 0, {});
        if (next !== doc) ctx.setDoc(next);
        return next !== doc;
    }

    /** 拖动数学整体在 core/gizmo.dragPatch：世界位移 → 父链局部 → 关键帧补丁 */
    function applyDrag(e) {
        const doc = ctx.doc();
        if (!doc) return;
        const el = layerById(doc, drag.elId);
        if (!el) return;
        const t = ctx.time();
        // 拖锚点：把指针位置反解成对象本地 uv。**拖动中只记预览**（见 previewAnchor），
        // 松手时才 setAnchor 落一次文档——每帧写文档会把一次拖动拆成多条撤销记录，
        // 而且 keepPlace 的补偿每帧都算一遍，中途按 Esc 也退不回去。
        if (drag.pick && drag.pick.kind === 'anchor') {
            // 故意不用 worldToLocal：它带 1e-3 的严格容差、超出网格就返回 null，
            // 而锚点默认就在对象角上——起步时指针正好压在边界（v≈0），
            // 用它会出现「拖了半天不动、走远才跟手」。这里直接用世界矩阵的逆投影，
            // 算出基准尺寸下的 uv 再夹到 [0,1]，语义与 anchorPoint 的 size*a 完全对齐。
            const inv = invertMatrix(elementWorldMatrix(el, t, drag.size, drag.parentM));
            const uv = anchorUvFromMatrix(inv, drag.size, toDocPoint(e));
            if (!uv) return;
            preview = { elId: el.id, u: uv.u, v: uv.v };
            if (typeof ctx.requestRender === 'function') ctx.requestRender();
            return;
        }
        const patch = dragPatch({
            pick: drag.pick,
            doc,
            el,
            time: t,
            parentM: drag.parentM,
            start: drag.start,
            p0: drag.p0,
            p: toDocPoint(e),
            size: drag.size,
            anchorWorld: drag.anchorWorld,
        });
        const next = writeKey(doc, drag.elId, t, patch);
        if (next !== ctx.doc()) ctx.setDoc(next);
    }

    function onDragEnd() {
        window.removeEventListener('pointermove', onDragMove, true);
        window.removeEventListener('pointerup', onDragEnd, true);
        window.removeEventListener('pointercancel', onDragEnd, true);
        window.removeEventListener('keydown', onDragKeyDown, true);
        if (dragRaf) {
            cancelAnimationFrame(dragRaf);
            dragRaf = 0;
        }
        if (!drag) {
            pendingPointer = null;
            return;
        }
        // 快速拖动（或一帧内完成）时最后一次 pointermove 可能还挂在节流里，
        // 必须在收尾前补一次，否则这次拖动等于没发生
        if (pendingPointer) {
            const ev = pendingPointer;
            pendingPointer = null;
            applyDrag(ev);
        }
        const before = drag.before;
        const pv = preview;
        const elId = drag.elId;
        drag = null;
        preview = null;

        /* 拖锚点：整段拖动只在松手时写一次文档。Esc 取消就什么都不写。
           撤销记录由 ctx.setAnchor 内部那次 setDoc 生成（label「改旋转原点」），
           这里不再 push 第二条，否则一次拖动要按两下撤销才退得回去。 */
        if (pv) {
            if (dragCanceled) {
                dragCanceled = false;
                if (typeof ctx.requestRender === 'function') ctx.requestRender();
                if (ctx.notify) ctx.notify('已取消');
                return;
            }
            if (typeof ctx.setAnchor === 'function') {
                ctx.setAnchor(elId, { x: pv.u, y: pv.v }, { keepPlace: true });
                if (ctx.notify) ctx.notify('已移动旋转原点');
            }
            return;
        }
        dragCanceled = false;

        const after = ctx.doc();
        if (before && after && before !== after) {
            // 一次拖动 = 一条撤销记录
            ctx.engine.history.push({
                label: '变换',
                undo: () => ctx.setDoc(before),
                redo: () => ctx.setDoc(after),
            });
        }
        if (ctx.notify) ctx.notify('已更新关键帧');
    }

    /** 叠加层画「预览十字」用：拖动中返回 { u, v, elId }，其余时候 null */
    function previewAnchor() {
        return preview ? { elId: preview.elId, u: preview.u, v: preview.v } : null;
    }

    /* ── 指针入口（宿主捕获阶段，抢在引擎之前） ── */

    function onDown(e) {
        if (e.button !== 0) return;
        const doc = ctx.doc ? ctx.doc() : null;
        if (!doc) return;
        const p = toDocPoint(e);
        const r = host.getBoundingClientRect();
        const probe = { x: p.x, y: p.y, sx: e.clientX - r.left, sy: e.clientY - r.top };
        const tool = ctx.tool ? ctx.tool() : engine && engine.tool ? engine.tool() : 'brush';
        const isSelect = tool === 'select';

        // 手柄在任何工具下都能抓
        const onHandle = hitAt(probe, isSelect);
        if (onHandle) {
            e.preventDefault();
            e.stopPropagation();
            // 抓网格顶点时把该顶点记为当前选中顶点（曲线编辑器据此只显示它的 x/y）
            if (onHandle.kind === 'lattice') {
                const info = selectionInfo();
                if (info) {
                    ctx.setSelection({ id: info.el.id, mode: 'warp', vertex: onHandle.vertex });
                    // 让「在某一时刻拉网格」自动成为一段动画：对象只有 1 个关键帧时，
                    // 先在 0 秒补一个起点帧，否则整条时间线上只有那一刻有形状，
                    // 用户就会觉得「网格变形不会在动画里渐变」。
                    ensureWarpBaseKey(info.el.id);
                }
            }
            startDrag(e, onHandle);
            return;
        }
        if (!isSelect) return;   // 画笔等工具：放行给引擎

        // 选择工具：命中对象就选中并开始移动，点空白清选中
        const hit = ctx.hitTestAt ? ctx.hitTestAt(p.x, p.y) : null;
        if (hit) {
            // 保留「网格模式」：点同一个对象时不要把手动切过去的 warp 洗回 transform，
            // 否则用户点完「网格」再点一下就永远抓不到顶点（外壳的 setSelection 缺 mode 时默认 transform）。
            const prev = typeof ctx.selection === 'function' ? ctx.selection() : null;
            const keepMode = prev && prev.id === hit.id && prev.mode === 'warp' ? 'warp' : 'transform';
            ctx.setSelection({ id: hit.id, mode: keepMode, vertex: keepMode === 'warp' ? prev.vertex : null });
            startDrag(e, { kind: 'move', name: 'move' });
        } else {
            ctx.setSelection(null);
        }
        e.preventDefault();
        e.stopPropagation();
    }

    /** 拆掉拖动期间挂在 window 上的临时监听 */
    function dispose() {
        window.removeEventListener('pointermove', onDragMove, true);
        window.removeEventListener('pointerup', onDragEnd, true);
        window.removeEventListener('pointercancel', onDragEnd, true);
        window.removeEventListener('keydown', onDragKeyDown, true);
        if (dragRaf) cancelAnimationFrame(dragRaf);
        dragRaf = 0;
        pendingPointer = null;
        drag = null;
        preview = null;
        dragCanceled = false;
    }

    return { onDown, dispose, previewAnchor };
}
