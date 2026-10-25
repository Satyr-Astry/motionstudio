// 曲线绘制层：只碰 canvas 2d —— 背景、时间/值刻度、逐通道曲线、关键帧圆点、
// 切线柄、播放头、retime 网格、框选矩形。
//
// 这里**不写 doc、不绑事件**：所有输入都由调用方算好塞进渲染上下文 rc，
// 绘制过程只读 rc，不产生任何副作用（除了 canvas 像素本身）。
//
// 显示模型：rc.focus 是「正在编辑的那条曲线」—— 满色、粗线、带圆点、独占 Y 轴刻度；
// shown 里其余通道只是参考线（细、半透明、无圆点），具体数值靠右侧同色读数认领。
//
// 关键帧来源是 rc.focusKeys（调用方已按「通道优先」解析好）：聚焦通道若有独立轨道，
// 圆点与切线柄就来自它自己的键，跟别的曲线的关键帧时间无关。曲线本体仍走 stateAt，
// 它内部已叠加通道覆盖 —— 点到线的对应关系不许在这里另算一遍。

import { stateAt } from '../core/transform.mjs';
import { celTimes } from '../core/cel.mjs';
import { PAD_L, PAD_R, KEY_R, SAMPLES, chById, chValue, clamp, fmtVal, tToX, vToY } from './curve-geo.mjs';

/**
 * 按容器尺寸 + devicePixelRatio 定画布像素尺寸。
 * 返回 CSS 尺寸与 dpr（geo 的 x1/y1 要按 CSS 像素算）。
 */
export function resizeCanvas(cv, wrap) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(40, wrap.clientWidth);
    const h = Math.max(30, wrap.clientHeight);
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    return { w, h, dpr };
}

/**
 * 每帧开始：按 dpr 归位坐标系，铺底（清屏 + 背景色）。
 * 单独拆出来是为了让调用方保持「先铺底、再算数据、再画内容」的原始顺序。
 */
export function beginFrame(g, size) {
    const { w, h, dpr } = size;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#141518';
    g.fillRect(0, 0, w, h);
}

/** 按像素列采样出一条通道的路径（只建 path，样式由调用方给）。 */
function tracePath(g, geo, track, id) {
    const n = Math.min(SAMPLES, Math.max(24, Math.round(geo.x1 - geo.x0)));
    g.beginPath();
    for (let i = 0; i < n; i++) {
        const t = geo.t0 + ((geo.t1 - geo.t0) * i) / (n - 1);
        const v = chValue(stateAt(track, t), id);
        const x = tToX(geo, t);
        const y = vToY(geo, v, id);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
    }
}

/**
 * 渲染上下文 rc：
 *   { g, geo, layer, track, shown, focus, focusKeys, focusSolo, sel, selKeys, marquee, now, total,
 *     describeLayerTime?, objectLocalTime? }
 * focusKeys 是聚焦通道此刻的关键帧视图（独立轨道优先）；focusSolo 表示它是否已独立。
 */
export function paintCanvas(rc) {
    const { g, geo, layer, track, shown, focus, focusKeys, focusSolo, sel, selKeys, marquee, now } = rc;
    drawGrid(g, rc);
    const keys = focusKeys || [];

    // 参考线先画：细、半透明，只提供形状对照，不抢聚焦曲线的注意力
    for (const id of shown) {
        if (id === focus) continue;
        const ch = chById(id);
        if (!ch) continue;
        g.save();
        g.globalAlpha = 0.3;
        g.strokeStyle = ch.color;
        g.lineWidth = 1;
        tracePath(g, geo, track, id);
        g.stroke();
        g.restore();
    }

    // 聚焦曲线：与渲染、播放同一个求值器（stateAt），像素级对得上画布
    const fch = focus ? chById(focus) : null;
    if (fch && shown.has(focus)) {
        g.strokeStyle = fch.color;
        g.lineWidth = 1.9;
        tracePath(g, geo, track, focus);
        g.stroke();
    }

    // 关键帧圆点只画聚焦通道：参考线上没有可拖的点，避免「以为在拖 A 其实拖到了 B」
    if (fch && shown.has(focus)) {
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            const x = tToX(geo, k.t);
            const y = vToY(geo, k.value, focus);
            const isSel = selKeys.some((s) => s.chId === focus && s.index === i && s.part === 'key');
            g.beginPath();
            g.arc(x, y, isSel ? KEY_R + 1.5 : KEY_R, 0, Math.PI * 2);
            g.fillStyle = k.ease === 'hold' ? '#8b8f98' : fch.color;
            g.fill();
            g.lineWidth = 1;
            g.strokeStyle = isSel ? '#fff' : 'rgba(0,0,0,.55)';
            g.stroke();
        }
    }

    // 「同刻」线：共用关键帧模型下一个关键帧同时属于所有通道，拖它的时间会带着所有曲线一起改 ——
    // 把这一列标出来，用户才不会以为是别的曲线在跟着动。通道独立之后这条线只剩「选中的点在这一列」
    // 的含义，所以文案要跟着换，否则会误导用户以为别的曲线也被拖动了。
    const selKey = sel && keys[sel.index];
    if (selKey) {
        const x = Math.round(tToX(geo, selKey.t)) + 0.5;
        g.save();
        g.strokeStyle = 'rgba(255,255,255,.2)';
        g.lineWidth = 1;
        g.setLineDash([2, 3]);
        g.beginPath();
        g.moveTo(x, geo.y0);
        g.lineTo(x, geo.y1);
        g.stroke();
        g.setLineDash([]);
        g.fillStyle = 'rgba(200,205,215,.5)';
        g.font = '8px system-ui, sans-serif';
        g.fillText(focusSolo ? '独立' : '同刻', x + 3, geo.y1 - 3);
        g.restore();
    }

    // 选中段的贝塞尔切线柄
    if (sel && keys.length > 1) {
        const i = sel.index;
        const k0 = keys[i];
        const k1 = keys[i + 1];
        if (k0 && k1) {
            const v0 = k0.value;
            const v1 = k1.value;
            const handle = (hx, hy) => {
                const t = k0.t + (k1.t - k0.t) * hx;
                const v = v0 + (v1 - v0) * hy;
                // 注意：这里必须用 sel.chId。曾长期写成未定义的 `chId`，
                // 导致「选中任何非末尾关键帧」时 paint 在画完曲线后抛 ReferenceError，
                // 播放头 / 空态文案 / hint 全被跳过，右键菜单也因此永远弹不出来。
                return { t, v, x: tToX(geo, t), y: vToY(geo, v, sel.chId) };
            };
            const a = handle(k0.h1[0], k0.h1[1]);
            const b = handle(k0.h2[0], k0.h2[1]);
            const p0 = { x: tToX(geo, k0.t), y: vToY(geo, v0, sel.chId) };
            const p1 = { x: tToX(geo, k1.t), y: vToY(geo, v1, sel.chId) };
            g.strokeStyle = 'rgba(255,255,255,.35)';
            g.lineWidth = 1;
            g.beginPath();
            g.moveTo(p0.x, p0.y);
            g.lineTo(a.x, a.y);
            g.moveTo(p1.x, p1.y);
            g.lineTo(b.x, b.y);
            g.stroke();
            for (const [pt, part] of [[a, 'h1'], [b, 'h2']]) {
                const on = sel.part === part;
                g.beginPath();
                g.arc(pt.x, pt.y, on ? 5 : 3.6, 0, Math.PI * 2);
                g.fillStyle = on ? '#fff' : '#c9ced8';
                g.fill();
                g.strokeStyle = 'rgba(0,0,0,.6)';
                g.stroke();
            }
        }
    }

    // 播放头：用**对象局部时间**，与关键帧同一套坐标
    const px = tToX(geo, clamp(now, geo.t0, geo.t1));
    g.strokeStyle = '#4a7dff';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(px + 0.5, geo.y0);
    g.lineTo(px + 0.5, geo.y1);
    g.stroke();

    // 右栏读数：Y 轴刻度只服务聚焦通道，其余曲线在自己的量纲里活着，
    // 所以每条线在右边缘标一个同色当前值 —— 否则参考线只有形状没有数字。
    drawReadouts(g, rc);

    if (!layer || !keys.length) {
        g.fillStyle = 'rgba(230,232,236,.45)';
        g.font = '12px system-ui, sans-serif';
        g.fillText(layer ? '这个对象还没有关键帧 —— 在属性面板改任意数值即可打第一个' : '没有可编辑的对象', PAD_L + 8, geo.y0 + 18);
    }
    return true;
}

/** 右边缘的「色 + 当前值」：now 时刻各显示通道的读数。 */
function drawReadouts(g, rc) {
    const { geo, track, shown, focus, now } = rc;
    const st = stateAt(track, now);
    const x = geo.x1 + PAD_R - 2;
    const rows = [];
    for (const id of shown) {
        const ch = chById(id);
        if (!ch) continue;
        const v = chValue(st, id);
        rows.push({ ch, id, v, y: clamp(vToY(geo, v, id), geo.y0 + 5, geo.y1 - 3) });
    }
    // 两条曲线当前值都贴近底边时读数会叠成一团，按 y 排好后强行拉开一行
    const sorted = rows.slice().sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i += 1) {
        if (sorted[i].y - sorted[i - 1].y < 10) sorted[i].y = sorted[i - 1].y + 10;
    }
    const over = rows.length ? sorted[sorted.length - 1].y - (geo.y1 - 3) : 0;
    if (over > 0) for (const r of rows) r.y -= over;   // 整列越过底边就一起上移
    g.save();
    g.font = '9px system-ui, sans-serif';
    g.textAlign = 'right';
    for (const r of rows) {
        g.globalAlpha = r.id === focus ? 1 : 0.55;
        g.fillStyle = r.ch.color;
        g.fillText(fmtVal(r.id, r.v), x, r.y + 3);
    }
    g.restore();
}

function drawGrid(g, rc) {
    const { geo, layer, marquee } = rc;
    const { x0, x1, y0, y1 } = geo;
    g.strokeStyle = 'rgba(255,255,255,.06)';
    g.lineWidth = 1;

    // 时间刻度：按可用宽度选步长
    const span = geo.t1 - geo.t0 || 1;
    const pxPerSec = (x1 - x0) / span;
    const candidates = [0.1, 0.2, 0.5, 1, 2, 5];
    let step = candidates.find((s) => s * pxPerSec >= 46) || 5;
    for (let t = Math.ceil(geo.t0 / step) * step; t <= geo.t1 + 1e-9; t += step) {
        const x = Math.round(tToX(geo, t)) + 0.5;
        g.beginPath();
        g.moveTo(x, y0);
        g.lineTo(x, y1);
        g.stroke();
        g.fillStyle = 'rgba(154,161,172,.75)';
        g.font = '9px system-ui, sans-serif';
        g.fillText(step < 1 ? t.toFixed(1) + 's' : t.toFixed(0) + 's', x + 3, y1 + 11);
    }

    // 纹理切换点：该对象每个 cel 的 at 秒（淡色虚线，方便把关键帧对到纹理上）
    const celMarks = celTimes(layer);
    if (celMarks.length) {
        g.save();
        g.strokeStyle = 'rgba(255,255,255,.05)';
        g.setLineDash([2, 3]);
        for (const at of celMarks) {
            const x = Math.round(tToX(geo, at)) + 0.5;
            if (x < x0 || x > x1) continue;
            g.beginPath();
            g.moveTo(x, y0);
            g.lineTo(x, y1);
            g.stroke();
        }
        g.restore();
    }

    // 时间网格：把全局秒按时间通道映射到横轴，非恒等时能直观看到流速被揉过
    // 注意：layer / total 都由调用方算好传进来，绘制层不再自己去取 doc
    const gLayer = rc.layer;
    const gTotal = rc.total;
    if (typeof rc.objectLocalTime === 'function' && gLayer && gTotal > 0 && !isIdentityTimeOf(rc, gLayer)) {
        g.save();
        g.strokeStyle = 'rgba(140,200,255,.16)';
        g.lineWidth = 1;
        const step = gTotal > 4 ? 1 : gTotal > 1.5 ? 0.5 : 0.1;
        for (let gt = 0; gt <= gTotal + 1e-9; gt += step) {
            const lt = rc.objectLocalTime(gLayer.id, gt);
            if (!Number.isFinite(lt)) continue;
            const gx = Math.round(tToX(geo, lt)) + 0.5;
            if (gx < x0 || gx > x1) continue;
            g.beginPath();
            g.moveTo(gx, y0);
            g.lineTo(gx, y1);
            g.stroke();
        }
        g.restore();
    }

    // 值刻度
    //
    // 只有聚焦通道一套真实数值：每条曲线各用自己的值域画（像素 / 角度 / 比例互不相干），
    // 所以刻度不再在「百分比」和「真实值」之间切换 —— 永远标聚焦通道的真值，
    // 其余曲线的数值由右边缘的同色读数负责。
    const fch = rc.focus ? chById(rc.focus) : null;
    g.strokeStyle = 'rgba(255,255,255,.06)';
    for (let i = 0; i <= 4; i++) {
        const frac = i / 4;
        const v = geo.vMin + (geo.vMax - geo.vMin) * frac;
        const y = Math.round(vToY(geo, v)) + 0.5;
        g.beginPath();
        g.moveTo(x0, y);
        g.lineTo(x1, y);
        g.stroke();
        g.fillStyle = 'rgba(154,161,172,.7)';
        g.font = '9px system-ui, sans-serif';
        g.fillText(fch ? fmtVal(fch.id, v) : v.toFixed(2), 4, y + 3);
    }

    // 零线
    if (geo.vMin < 0 && geo.vMax > 0) {
        const y = Math.round(vToY(geo, 0)) + 0.5;
        g.strokeStyle = 'rgba(255,255,255,.16)';
        g.beginPath();
        g.moveTo(x0, y);
        g.lineTo(x1, y);
        g.stroke();
    }

    // 框选矩形：虚线 + 极淡填充，和关键帧的实心圆点区分开
    if (marquee && marquee.moved) {
        const mx = Math.min(marquee.x0, marquee.x1);
        const my = Math.min(marquee.y0, marquee.y1);
        const mw = Math.abs(marquee.x1 - marquee.x0);
        const mh = Math.abs(marquee.y1 - marquee.y0);
        g.save();
        g.fillStyle = 'rgba(74,125,255,.12)';
        g.fillRect(mx, my, mw, mh);
        g.strokeStyle = 'rgba(74,125,255,.75)';
        g.lineWidth = 1;
        g.setLineDash([3, 3]);
        g.strokeRect(Math.round(mx) + 0.5, Math.round(my) + 0.5, Math.round(mw), Math.round(mh));
        g.restore();
    }
}

/** 当前对象的时间通道是否恒等（没有就跳过时间网格）。 */
function isIdentityTimeOf(rc, layer) {
    if (typeof rc.describeLayerTime === 'function') {
        return rc.describeLayerTime(layer.id) === '无时间变换';
    }
    return true;
}
