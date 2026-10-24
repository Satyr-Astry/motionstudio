/**
 * MotionStudio —— 命令层：对象与关键帧的写操作
 *
 * 每个导出都是「一次用户动作」，内部统一走 setDoc(updater) 产生新文档，
 * 再由 doc-state 广播出去。这里**不做 DOM**，也不记历史 ——
 * 历史由 paint/engine 的 history 在 setDoc 之后统一收口（契约 §9.4）。
 *
 * v6：帧操作（加帧 / 删帧 / 移帧 / 链接 / 继承 / 帧时长）整体删除。
 * 画格（cel）是按秒索引的开关事件，增删画格走 app.mjs 的
 * addCelAt / removeCelAt / clearCelAt / moveCel —— 它们需要精确的秒坐标，
 * 而这里只剩「对象属性」与「关键帧」两类与时间轴长度无关的写入。
 *
 * 依赖方向：doc-state（state / setDoc / flash / updateChrome）、
 * core（cel / transform）、paint（engine）。不依赖 view-host / project-io。
 */

import { layerById, objectsOf, patchLayer } from '../core/cel.mjs';
import { createTrack, addKey, setKeyState, stateAt } from '../core/transform.mjs';
import { state, engine, setDoc, scheduleRefresh, flash, updateChrome } from './doc-state.mjs';

/** 目标对象 id：显式传入 > 当前活动对象 > 第一个对象。 */
function targetId(layerId) {
    if (layerId) return layerId;
    if (state.activeLayerId && layerById(state.doc, state.activeLayerId)) return state.activeLayerId;
    const first = objectsOf(state.doc)[0];
    return first ? first.id : null;
}

/** 就地改写一个效果对象（无变化返回 false），统一走 patchLayer 保持不可变。 */
function patchEffect(layerId, fxIndex, mutate) {
    const doc = state.doc;
    if (!doc) return false;
    const lid = targetId(layerId);
    const layer = lid ? layerById(doc, lid) : null;
    if (!layer || !Array.isArray(layer.effects) || !layer.effects[fxIndex]) return false;
    const fx = Object.assign({}, layer.effects[fxIndex]);
    if (fx.tracks) fx.tracks = Object.assign({}, fx.tracks);
    if (mutate(fx) === false) return false;
    const list = layer.effects.slice();
    list[fxIndex] = fx;
    const next = patchLayer(doc, lid, { effects: list });
    if (next === doc) return false;
    setDoc(next);
    engine.scheduleRender();
    scheduleRefresh();
    return true;
}

/**
 * 改效果参数：该参数有关键帧轨道时在当前时间打帧，否则改静态值。
 * 这就是「效果器强度能随关键帧和线型 / 贝塞尔变化」。
 */
function setEffectParam(layerId, fxIndex, key, value) {
    const v = Number(value);
    if (!Number.isFinite(v)) return;
    patchEffect(layerId, fxIndex, (fx) => {
        const cur = fx.tracks && fx.tracks[key];
        if (cur && Array.isArray(cur.keys) && cur.keys.length) {
            const t = state.time;
            let trk = cur;
            if (!trk.keys.some((k) => Math.abs(k.t - t) < 1e-6)) trk = addKey(trk, t, stateAt(trk, t), 'bezier');
            const i = trk.keys.findIndex((k) => Math.abs(k.t - t) < 1e-6);
            fx.tracks = Object.assign({}, fx.tracks, { [key]: setKeyState(trk, i, { x: v }) });
        } else {
            fx[key] = v;
        }
    });
}

/** ◆ 按钮：给该参数在当前时间建 / 补一个关键帧（已有轨道就用曲线上的值打帧）。 */
function keyEffectParam(layerId, fxIndex, key) {
    patchEffect(layerId, fxIndex, (fx) => {
        const t = state.time;
        const cur = fx.tracks && fx.tracks[key];
        if (cur && Array.isArray(cur.keys) && cur.keys.length) {
            let trk = cur;
            if (!trk.keys.some((k) => Math.abs(k.t - t) < 1e-6)) trk = addKey(trk, t, stateAt(trk, t), 'bezier');
            const i = trk.keys.findIndex((k) => Math.abs(k.t - t) < 1e-6);
            fx.tracks = Object.assign({}, fx.tracks, { [key]: setKeyState(trk, i, { x: Number(fx[key]) || 0 }) });
        } else {
            const trk = addKey(createTrack(), t, { x: Number(fx[key]) || 0 }, 'bezier');
            fx.tracks = Object.assign({}, fx.tracks || {}, { [key]: trk });
        }
    });
    flash('效果关键帧');
}

/** 清掉该参数的全部关键帧，把曲线当前值烘成静态值。 */
function clearEffectParam(layerId, fxIndex, key) {
    patchEffect(layerId, fxIndex, (fx) => {
        const cur = fx.tracks && fx.tracks[key];
        if (!cur || !Array.isArray(cur.keys) || !cur.keys.length) return false;
        fx[key] = Number(stateAt(cur, state.time).x) || 0;
        const tracks = Object.assign({}, fx.tracks);
        delete tracks[key];
        fx.tracks = Object.keys(tracks).length ? tracks : undefined;
        if (!fx.tracks) delete fx.tracks;
    });
    flash('效果关键帧已清除');
}

function setLayerEffects(layerId, effects) {
    const doc = state.doc;
    if (!doc) return null;
    const lid = targetId(layerId);
    if (!lid) return doc;
    const next = patchLayer(doc, lid, { effects: Array.isArray(effects) ? effects : [] });
    if (next === doc) return doc;
    setDoc(next);
    engine.scheduleRender();
    return next;
}

/**
 * 在指定时间写一个关键帧（没有就在该时刻插入），返回新 doc。
 * 这是网格 warp / 变换面板 / 画布手柄的**唯一写入口** —— 改任何数值 = 在当前时间打帧。
 */
function writeKeyAt(doc, layerId, t, patch) {
    const obj = layerById(doc, layerId);
    if (!obj) return doc;
    const time = Number.isFinite(Number(t)) ? Number(t) : state.time;
    const track = obj.transform || createTrack();
    const eps = 1e-6;
    let idx = track.keys.findIndex((k) => Math.abs(k.t - time) < eps);
    let next = track;
    if (idx < 0) {
        next = addKey(track, time, stateAt(track, time), 'linear');
        idx = next.keys.findIndex((k) => Math.abs(k.t - time) < eps);
    }
    if (idx < 0) return doc;
    next = setKeyState(next, idx, patch);
    return patchLayer(doc, layerId, { transform: next });
}

export {
    targetId,
    patchEffect,
    setEffectParam,
    keyEffectParam,
    clearEffectParam,
    setLayerEffects,
    writeKeyAt,
};
