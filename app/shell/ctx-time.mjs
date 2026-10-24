/**
 * MotionStudio —— 外壳 ctx 的「时间」分组
 *
 * 从 app.mjs 整组搬出来的原因：app.mjs 的 ctx 是一个 328 行的对象字面量，
 * 里面混着时间通道、父子层级、时间基（VFR）、网格 warp 四件事，
 * 与「画格」「效果器」「项目」混排在同一个字面量里，改动风险高、读起来也要跳。
 *
 * 这一组**只依赖六个注入项**：
 *   getDoc()      当前文档（不可变对象，每次修改换新引用）
 *   setDoc(fn)    唯一写入口
 *   flash(msg)    顶栏提示
 *   now()         当前全局时间（秒）
 *   activeId()    当前选中对象 id
 *   evaluatorFor(doc)  求值器（带缓存，按 doc 引用失效）
 *
 * 所有方法都不抛异常：文档为空、id 不存在、参数非法一律安全返回。
 */

import {
    collectSubtree,
    describeTime,
    localTimeOf,
    normalizeTime,
    setParent as setParentDoc,
    subtreeSize,
    timeDepth,
} from '../core/timegraph.mjs';
import { objectById, objectsOf, patchObject, reorderObject } from '../core/doc-model.mjs';
import {
    addSegment as addTimeSegment,
    fpsAt as fpsAtTime,
    hasTimebase,
    normalizeSegments as normSegments,
    removeSegment as removeTimeSegment,
    resetTimebase as resetTimebaseDoc,
    sampleTimes,
    segmentIndexAt,
    segmentRange,
    setSegmentAt as setTimeSegmentAt,
    setSegmentFps as setTimeSegmentFps,
} from '../core/timebase.mjs';
import { elementLattice, elementQuad, hitTest } from '../core/element.mjs';
import { latticeIsZero, resizeLattice } from '../core/lattice.mjs';
import { matrixObject } from '../core/evaluator.mjs';
import { totalSeconds } from '../core/doc-model.mjs';

/** 注入依赖，返回可直接展开进 ctx 的一组方法。 */
export function timeCtx(deps) {
    const { getDoc, setDoc, flash, now, activeId, evaluatorFor, writeKeyAt } = deps;
    return {
    /* ── 对象时间通道与父子层级（契约 v5 §1–§2） ──────────── */

    /** 读对象的时间通道（已归一化，恒有全部字段）。 */
    layerTime(id) {
        const doc = getDoc();
        if (!doc) return null;
        const obj = objectById(doc, id);
        return obj ? normalizeTime(obj.time) : null;
    },
    /** 改时间通道；patch 里只出现的字段生效，其余保持。 */
    setLayerTime(id, patch) {
        const doc = getDoc();
        if (!doc) return;
        if (!objectById(doc, id)) return;
        if (!patch || typeof patch !== 'object') return;
        setDoc((d) => patchObject(d, id, (o) => {
            const cur = normalizeTime(o.time);
            const next = normalizeTime(Object.assign({}, cur, patch));
            return Object.assign({}, o, { time: next });
        }));
        flash('时间通道 ' + describeTime(patch));
    },
    /** 清掉时间通道回到恒等。 */
    resetLayerTime(id) {
        const doc = getDoc();
        if (!doc) return;
        if (!objectById(doc, id)) return;
        setDoc((d) => patchObject(d, id, (o) => Object.assign({}, o, { time: undefined })));
        flash('时间通道已重置');
    },
    /** 把时间通道一次性套到整棵子树（含自身）。返回受影响的对象数。 */
    setSubtreeTime(id, patch) {
        const doc = getDoc();
        if (!doc || !patch || typeof patch !== 'object') return 0;
        const ids = collectSubtree(doc, id);
        if (ids.length === 0) return 0;
        setDoc((d) => {
            let next = d;
            for (const oid of ids) {
                next = patchObject(next, oid, (o) => {
                    const cur = normalizeTime(o.time);
                    return Object.assign({}, o, { time: normalizeTime(Object.assign({}, cur, patch)) });
                });
            }
            return next;
        });
        flash('时间通道 ' + describeTime(patch) + ' · ' + ids.length + ' 个对象');
        return ids.length;
    },
    /** 重置整棵子树的时间通道。 */
    resetSubtreeTime(id) {
        const doc = getDoc();
        if (!doc) return 0;
        const ids = collectSubtree(doc, id);
        if (ids.length === 0) return 0;
        setDoc((d) => {
            let next = d;
            for (const oid of ids) next = patchObject(next, oid, (o) => Object.assign({}, o, { time: undefined }));
            return next;
        });
        flash('子树时间通道已重置 · ' + ids.length + ' 个对象');
        return ids.length;
    },
    /** 子树后代数量（不含自身）。 */
    subtreeCount(id) {
        const doc = getDoc();
        return doc ? subtreeSize(doc, id) : 0;
    },
    /** 一句话描述时间通道（对象面板徽章的 title 与只读摘要用）。 */
    describeLayerTime(id) {
        const doc = getDoc();
        if (!doc) return '无时间变换';
        const obj = objectById(doc, id);
        return obj ? describeTime(obj.time) : '无时间变换';
    },
    /** 层级深度（0 = 根）。 */
    layerDepth(id) {
        const doc = getDoc();
        if (!doc) return 0;
        const obj = objectById(doc, id);
        return obj ? timeDepth(doc, obj) : 0;
    },
    /** 设父对象（自动做环检测，失败返回 false 并提示原因）。 */
    setLayerParent(id, parentId) {
        const doc = getDoc();
        if (!doc) return false;
        const res = setParentDoc(doc, id, parentId == null ? null : parentId);
        if (!res || !res.ok) {
            if (res && res.reason) flash(res.reason);
            return false;
        }
        setDoc(() => res.doc);
        return true;
    },
    /** 把对象移到指定下标（对象列表顺序 = 绘制顺序，0 在最上层）。 */
    /** target 既接受下标，也接受对象 id —— 对象面板拖拽时手里只有 id。 */
    moveLayerTo(id, target) {
        const doc = getDoc();
        if (!doc) return false;
        const list = objectsOf(doc);
        const from = list.findIndex((o) => o && o.id === id);
        if (from < 0) return false;
        const raw = typeof target === 'string' ? list.findIndex((o) => o && o.id === target) : Math.round(Number(target));
        if (!Number.isFinite(raw) || raw < 0) return false;
        const idx = Math.max(0, Math.min(list.length - 1, raw));
        if (idx === from) return false;
        setDoc((d) => reorderObject(d, id, idx), { label: '调整对象顺序' });
        return true;
    },
    /** 全局时间 → 该对象的局部时间（曲线编辑器按对象时间显示用）。 */
    objectLocalTime(id, t) {
        const doc = getDoc();
        if (!doc) return Number(t) || 0;
        const obj = objectById(doc, id);
        if (!obj) return Number(t) || 0;
        return localTimeOf(doc, obj, typeof t === 'number' ? t : now());
    },

    /**
     * 祖先链矩阵（不含自身）。画布叠加层与拖动换算都必须用它，
     * 否则父对象旋转/缩放后选框与拖动方向会和实际画面错位。
     */
    objectParentMatrix(id, t) {
        const doc = getDoc();
        if (!doc) return null;
        const obj = objectById(doc, id);
        if (!obj) return null;
        const ev = evaluatorFor(doc);
        // evaluator 对外是六元组，element.mjs 的矩阵工具只认 {a..f}
        return matrixObject(ev.parentMatrix(obj, typeof t === 'number' ? t : now()));
    },

    /** 画布点击命中（doc 坐标，由画布叠加层换算后传入） */
    hitTestAt(x, y) {
        const doc = getDoc();
        if (!doc) return null;
        const ev = evaluatorFor(doc);
        return hitTest(doc, now(), x, y, { parentMatrix: (el, t) => matrixObject(ev.parentMatrix(el, t)) });
    },
    /** 选中对象的四角与手柄（画布叠加层用） */
    selectionQuad() {
        const doc = getDoc();
        const sel = state.selection;
        if (!doc || !sel) return null;
        const el = objectById(doc, sel.id);
        if (!el) return null;
        return elementQuad(doc, el, now(), matrixObject(evaluatorFor(doc).parentMatrix(el, now())));
    },
    /** 对象的网格 warp（当前时间插值后的结果） */
    latticeOf(layerId) {
        const doc = getDoc();
        if (!doc) return null;
        const el = objectById(doc, layerId || activeId());
        if (!el) return null;
        const info = elementLattice(doc, el, now());
        return { cols: info.lattice.cols, rows: info.lattice.rows, pts: info.lattice.pts, size: info.size };
    },
    // ── 时间基（v4）：时间轴是主轴，帧只是 cel 存储单位
    timebase() {
        const doc = getDoc();
        return doc ? normSegments(doc) : [];
    },
    timebaseActive() {
        return getDoc() ? hasTimebase(getDoc()) : false;
    },
    fpsAt(t) {
        return getDoc() ? fpsAtTime(getDoc(), typeof t === 'number' ? t : now()) : (getDoc() || {}).fps;
    },
    segmentIndexAt(t) {
        return getDoc() ? segmentIndexAt(getDoc(), typeof t === 'number' ? t : now()) : 0;
    },
    segmentRange(index) {
        const doc = getDoc();
        return doc ? segmentRange(doc, index, totalSeconds(doc)) : null;
    },
    /** 在某时间点加一段帧率（落在已有段时间点上则只改 fps） */
    addTimeSegment(at, fps) {
        const doc = getDoc();
        if (!doc) return;
        const t = Math.max(0, Number(at) || 0);
        setDoc((d) => addTimeSegment(d, t, fps));
        flash('时间轴帧率 ' + Math.round(Number(fps) || doc.fps) + ' fps @ ' + t.toFixed(2) + 's');
    },
    removeTimeSegment(index) {
        const doc = getDoc();
        if (!doc) return;
        if (normSegments(doc).length <= 1) {
            flash('至少要保留一段帧率');
            return;
        }
        setDoc((d) => removeTimeSegment(d, index));
        flash('已删除帧率段');
    },
    setTimeSegmentFps(index, fps) {
        if (!getDoc()) return;
        setDoc((d) => setTimeSegmentFps(d, index, fps));
    },
    setTimeSegmentAt(index, at) {
        if (!getDoc()) return;
        setDoc((d) => setTimeSegmentAt(d, index, at));
    },
    resetTimebase() {
        if (!getDoc()) return;
        setDoc((d) => resetTimebaseDoc(d));
        flash('帧率已恢复为全片 ' + getDoc().fps + ' fps');
    },
    /** 导出 / 预览用的采样时间点（按段帧率） */
    sampleTimes() {
        const doc = getDoc();
        return doc ? sampleTimes(doc, totalSeconds(doc)) : [];
    },
    /** 改网格密度：保留四角与已有形状，中间顶点重采样 */
    setLatticeDiv(cols, rows, layerId) {
        const doc = getDoc();
        if (!doc) return;
        const el = objectById(doc, layerId || activeId());
        if (!el) return;
        const info = elementLattice(doc, el, now());
        const next = resizeLattice(info.lattice, cols, rows);
        // 2×2 以上的网格即使顶点全零也要保留结构，否则「改成 2×2」这一步会被当成空 warp 丢掉
        const keep = next.cols > 1 || next.rows > 1 || !latticeIsZero(next);
        setDoc(writeKeyAt(getDoc(), el.id, now(), { warp: keep ? next : null }));
        flash('网格 ' + next.cols + '×' + next.rows);
    },
    /** 清掉该对象在当前时间的全部 warp 偏移 */
    resetLattice(layerId) {
        const doc = getDoc();
        if (!doc) return;
        const el = objectById(doc, layerId || activeId());
        if (!el) return;
        setDoc(writeKeyAt(getDoc(), el.id, now(), { warp: null }));
        flash('已重置网格');
    }
    };
}
