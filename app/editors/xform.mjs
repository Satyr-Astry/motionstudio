// 对象变换面板：8 个标量 + 四角变形 + 缓动 + 关键帧导航。被 properties.mjs 内嵌。
//
// 核心语义：改任何数值 = 以「当前连续时间 t = ctx.time()」为参数打关键帧（浮点秒，不吸附帧）；
// 同时间（容差 1e-6 s）已有 key 就更新它（setKeyState / setKeyEase），没有就 addKey。
// 数值框显示的永远是 stateAt(track, ctx.time()) —— 当前时间下的求值，不是某个关键帧的值。
// 视觉与尺寸全部交给 styles/panels.css 的 .xf* 规则，本文件不写内联样式。

import {
    addKey,
    createTrack,
    removeKey,
    setKeyEase,
    setKeyState,
    stateAt,
    DEFAULT_STATE,
} from '../core/transform.mjs';
import { normalizeLattice, createLattice, latticeToQuad } from '../core/lattice.mjs';
import { layerById, objectsOf } from '../core/cel.mjs';
import { icon } from '../core/icons.mjs';
import { t } from '../i18n/index.mjs';

// 关键帧时间比对容差：1e-6 s ≈ 0.001px。比 core 的 1e-9 宽松一点，
// 免得「拖到纹理切换点后再输数值」因为末位浮点误差又生成一个几乎重合的关键帧。
const T_EPS = 1e-6;

// 标量字段定义：[字段, 显示名词条, step, min, max]（词条在挂面板时现取，语言切了就重挂）
const FIELDS = [
    ['x', 'xform.field.x', 1, null, null],
    ['y', 'xform.field.y', 1, null, null],
    ['scaleX', 'xform.field.scaleX', 0.05, null, null],
    ['scaleY', 'xform.field.scaleY', 0.05, null, null],
    ['rotate', 'xform.field.rotate', 1, null, null],
    ['skewX', 'xform.field.skewX', 1, null, null],
    ['skewY', 'xform.field.skewY', 1, null, null],
    ['opacity', 'xform.field.opacity', 0.05, 0, 1],
];

const CORNERS = [
    ['tl', 'xform.corner.tl'],
    ['tr', 'xform.corner.tr'],
    ['br', 'xform.corner.br'],
    ['bl', 'xform.corner.bl'],
];

const EASES = [
    ['linear', 'xform.ease.linear'],
    ['bezier', 'xform.ease.bezier'],
    ['hold', 'xform.ease.hold'],
];

const ZERO_WARP = { tl: [0, 0], tr: [0, 0], br: [0, 0], bl: [0, 0] };

export function createXformPanel(ctx) {
    // 本文件里 `t` 常被当作「时间」（`const t = nowTime()`），那些作用域里词条函数改用 tr。
    const tr = t;
    const root = document.createElement('div');
    root.className = 'xf';

    const notify = (msg) => {
        if (typeof ctx.notify === 'function') ctx.notify(msg);
    };

    /** 唯一时间源：ctx.time()（秒）；拿不到或不合法就退化成 0。 */
    function nowTime() {
        const fn = typeof ctx.time === 'function' ? ctx.time : null;
        const v = fn ? Number(fn()) : 0;
        return Number.isFinite(v) ? v : 0;
    }

    /**
     * 写完 doc 把连续时间还回去：setDoc 之后外壳可能重算播放头。
     * 不补这一下，在 t=0.37s 打的关键帧可能被显示成别的时间，下一次改数值又多出一个关键帧。
     */
    function restoreTime(t) {
        if (typeof ctx.setTime !== 'function') return;
        if (Math.abs(nowTime() - t) > 1e-6) ctx.setTime(t);
    }

    // ── 头部：对象选择 + 关键帧计数 + 当前时间
    const head = document.createElement('div');
    head.className = 'xf-head';
    const layerSel = document.createElement('select');
    layerSel.className = 'xf-layer';
    layerSel.title = t('xform.head.pick');
    const keysEl = document.createElement('span');
    keysEl.className = 'xf-keys';
    keysEl.textContent = '—';
    head.append(layerSel, keysEl);

    // ── 8 个标量
    const grid = document.createElement('div');
    grid.className = 'xf-grid';
    const fieldInput = new Map();
    for (const [key, labelKey, step, min, max] of FIELDS) {
        const label = t(labelKey);
        const row = document.createElement('div');
        row.className = 'xf-row';
        const lb = document.createElement('span');
        lb.className = 'xf-label';
        lb.textContent = label;
        const input = document.createElement('input');
        input.className = 'xf-num';
        input.type = 'number';
        input.step = String(step);
        if (min != null) input.min = String(min);
        if (max != null) input.max = String(max);
        input.dataset.field = key;
        input.title = label;
        row.append(lb, input);
        grid.appendChild(row);
        fieldInput.set(key, input);
        input.addEventListener('change', () => {
            const v = Number(input.value);
            if (!Number.isFinite(v)) {
                refresh();
                return;
            }
            writeField(key, v);
        });
    }

    // ── 网格变形
    const warpBtn = document.createElement('button');
    warpBtn.type = 'button';
    warpBtn.className = 'xf-warp-btn ms-icon-label';
    warpBtn.innerHTML = icon('grid') + '<span>' + t('xform.warp.button') + '</span>';
    warpBtn.title = t('xform.warp.title');
    warpBtn.setAttribute('aria-label', t('xform.warp.button'));
    warpBtn.setAttribute('aria-pressed', 'false');

    // 密度：1×1 就是四角，2×2 起是真正的网格
    const divRow = document.createElement('div');
    divRow.className = 'xf-warp-div';
    divRow.hidden = true;
    const divLabel = document.createElement('span');
    divLabel.className = 'xf-label';
    divLabel.textContent = t('xform.warp.density');
    divRow.appendChild(divLabel);
    const divBtns = new Map();   // 'cols:rows' → button
    for (const [c, r, label] of [
        [1, 1, '1×1'], [2, 2, '2×2'], [3, 3, '3×3'], [4, 4, '4×4'],
        [5, 5, '5×5'], [6, 6, '6×6'], [8, 8, '8×8'],
    ]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'xf-div-btn';
        b.textContent = label;
        b.dataset.cols = String(c);
        b.dataset.rows = String(r);
        b.title = t('xform.warp.densityTitle', { cols: c, rows: r, n: (c + 1) * (r + 1) });
        b.addEventListener('click', () => {
            if (typeof ctx.setLatticeDiv === 'function') ctx.setLatticeDiv(c, r);
            refresh();
        });
        divRow.appendChild(b);
        divBtns.set(c + ':' + r, b);
    }
    // 自定义行列：非方阵也能用（比如 4×2 做横向弯曲）
    const divCustom = document.createElement('div');
    divCustom.className = 'xf-warp-custom';
    const mkNum = (val, title) => {
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.className = 'xf-num xf-div-num';
        inp.min = '1';
        inp.max = '12';
        inp.step = '1';
        inp.value = String(val);
        inp.title = title;
        return inp;
    };
    const colsIn = mkNum(2, t('xform.warp.cols'));
    const rowsIn = mkNum(2, t('xform.warp.rows'));
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'xf-div-btn is-apply';
    applyBtn.textContent = t('xform.warp.apply');
    applyBtn.title = t('xform.warp.applyTitle');
    applyBtn.addEventListener('click', () => {
        const clampDiv = (v) => Math.max(1, Math.min(12, Math.round(Number(v) || 1)));
        const c = clampDiv(colsIn.value);
        const r = clampDiv(rowsIn.value);
        colsIn.value = String(c);
        rowsIn.value = String(r);
        if (typeof ctx.setLatticeDiv === 'function') ctx.setLatticeDiv(c, r);
        refresh();
    });
    const timesSign = document.createElement('span');
    timesSign.className = 'xf-label';
    timesSign.textContent = '×';
    divCustom.append(colsIn, timesSign, rowsIn, applyBtn);
    divRow.appendChild(divCustom);
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'xf-div-btn is-reset';
    resetBtn.textContent = t('xform.reset');
    resetBtn.title = t('xform.warp.resetTitle');
    resetBtn.addEventListener('click', () => {
        if (typeof ctx.resetLattice === 'function') ctx.resetLattice();
        refresh();
    });
    divRow.appendChild(resetBtn);

    const corners = document.createElement('div');
    corners.className = 'xf-corners';
    corners.hidden = true;
    const cornerInput = new Map(); // 'tl:x' → input
    for (const [ck, nameKey] of CORNERS) {
        const cname = t(nameKey);
        for (const axis of ['x', 'y']) {
            const row = document.createElement('div');
            row.className = 'xf-corner';
            const lb = document.createElement('span');
            lb.className = 'xf-label';
            lb.textContent = t('xform.corner.label', { corner: cname, axis: axis.toUpperCase() });
            const input = document.createElement('input');
            input.className = 'xf-num';
            input.type = 'number';
            input.step = '1';
            input.dataset.corner = ck;
            input.dataset.axis = axis;
            input.title = t('xform.corner.title', { corner: cname, axis: axis.toUpperCase() });
            row.append(lb, input);
            corners.appendChild(row);
            cornerInput.set(ck + ':' + axis, input);
            input.addEventListener('change', () => {
                const v = Number(input.value);
                if (!Number.isFinite(v)) {
                    refresh();
                    return;
                }
                writeCorner(ck, axis, v);
            });
        }
    }

    warpBtn.addEventListener('click', () => {
        const open = corners.hidden;
        corners.hidden = !open;
        divRow.hidden = !open;
        warpBtn.classList.toggle('is-on', open);
        warpBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
        // 进网格模式 = 要在画布上拖顶点 → 顺手切选中模式。
        // 顺序与画布那边一致：先把网格落进文档，再切 selection（切模式会立刻重画叠加层）。
        // 1×1 网格没有内部线也没有内部顶点，不补齐的话用户只看到原来的选框，以为按钮没反应。
        const sel = typeof ctx.selection === 'function' ? ctx.selection() : null;
        if (open && sel && sel.id && typeof ctx.latticeOf === 'function' && typeof ctx.setLatticeDiv === 'function') {
            const lat = ctx.latticeOf(sel.id);
            const coarse = !lat || !Number.isFinite(lat.cols) || !Number.isFinite(lat.rows) || (lat.cols < 2 && lat.rows < 2);
            if (coarse) ctx.setLatticeDiv(2, 2, sel.id);
        }
        if (sel && typeof ctx.setSelection === 'function') {
            ctx.setSelection({ id: sel.id, mode: open ? 'warp' : 'transform' });
        }
        refresh();
    });

    // ── 缓动
    const seg = document.createElement('div');
    seg.className = 'xf-seg';
    const easeBtn = new Map();
    for (const [ease, labelKey] of EASES) {
        const label = t(labelKey);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'xf-segbtn';
        b.dataset.ease = ease;
        b.textContent = label;
        b.title = t('xform.ease.title', { name: label });
        b.addEventListener('click', () => writeEase(ease));
        seg.appendChild(b);
        easeBtn.set(ease, b);
    }

    // ── 动作
    // 上一个 / 下一个关键帧原本是 ◀ ▶ 字符（部分系统字体缺字形会渲染成空白，
    // timeline-paint.mjs:122 已经踩过这个坑），换成自绘 chevron 后就只是纯图标，
    // 语义靠 title + aria-label 说清；删/重置留文字，图标只做前缀。
    const actions = document.createElement('div');
    actions.className = 'xf-actions';
    const actBtn = new Map();
    // 表里第四格是**词条键**而不是标题原文：文案只活在词典里，这里只留键（与 FIELDS/CORNERS/EASES 同形）。
    for (const [act, iconName, labelKey, titleKey] of [
        ['prev', 'chevron-left', null, 'xform.action.prev'],
        ['next', 'chevron-right', null, 'xform.action.next'],
        ['del', 'diamond-minus', 'xform.action.del', 'xform.action.delTitle'],
        ['reset', 'rotate-ccw', 'xform.reset', 'xform.action.resetTitle'],
    ]) {
        const label = labelKey ? t(labelKey) : null;
        const title = t(titleKey);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'xf-btn ' + (label ? 'ms-icon-label' : 'ms-icon-btn');
        b.dataset.act = act;
        b.innerHTML = icon(iconName) + (label ? '<span>' + label + '</span>' : '');
        b.title = title;
        b.setAttribute('aria-label', title);
        b.addEventListener('click', () => runAction(act));
        actions.appendChild(b);
        actBtn.set(act, b);
    }

    root.append(head, grid, warpBtn, divRow, corners, seg, actions);

    // ── 工具函数

    function currentLayer(doc) {
        const id = typeof ctx.activeLayerId === 'function' ? ctx.activeLayerId() : null;
        const layer = id ? layerById(doc, id) : null;
        return layer || objectsOf(doc)[0] || null;
    }

    function trackOf(layer) {
        return layer && layer.transform && Array.isArray(layer.transform.keys)
            ? layer.transform
            : createTrack();
    }

    function keyIndexAt(track, t) {
        const keys = track && track.keys ? track.keys : [];
        for (let i = 0; i < keys.length; i++) {
            if (Math.abs(keys[i].t - t) < T_EPS) return i;
        }
        return -1;
    }

    function replaceTransform(doc, layerId, track) {
        const objects = objectsOf(doc).map((l) => (l.id === layerId ? Object.assign({}, l, { transform: track }) : l));
        // 保持文档原有的对象字段名（v6 是 objects；旧文件里可能仍是 layers）
        return Array.isArray(doc.objects)
            ? Object.assign({}, doc, { objects: objects })
            : Object.assign({}, doc, { layers: objects });
    }

    // 以当前连续时间为准写入关键帧：同时间有 key 就更新，否则新建
    function writeKey(patch, ease) {
        const doc = ctx.doc();
        if (!doc) return;
        const layer = currentLayer(doc);
        if (!layer) {
            notify(tr('xform.err.noObject'));
            return;
        }
        const t = nowTime();
        ctx.setDoc((d) => {
            const target = layerById(d, layer.id);
            if (!target) return d;
            const track = trackOf(target);
            const idx = keyIndexAt(track, t);
            let next;
            if (idx >= 0) {
                next = patch ? setKeyState(track, idx, patch) : track;
                if (ease) next = setKeyEase(next, idx, ease);
            } else {
                const state = Object.assign({}, stateAt(track, t), patch || {});
                next = addKey(track, t, state, ease || 'linear');
            }
            return replaceTransform(d, target.id, next);
        });
        restoreTime(t);
        if (typeof ctx.requestRender === 'function') ctx.requestRender();
        refresh();
    }

    function writeField(field, value) {
        const patch = {};
        patch[field] = field === 'opacity' ? Math.max(0, Math.min(1, value)) : value;
        writeKey(patch, null);
    }

    function writeCorner(ck, axis, value) {
        const doc = ctx.doc();
        if (!doc) return;
        const layer = currentLayer(doc);
        if (!layer) return;
        const t = nowTime();
        const base = stateAt(trackOf(layer), t);
        // 四角输入写的是网格的四个角顶点（1×1 时就是 tl/tr/bl/br 这四点）
        const lat = normalizeLattice(base.warp) || createLattice(1, 1);
        const idx = cornerIndex(lat, ck);
        const pts = lat.pts.map((p) => [p[0], p[1]]);
        if (pts[idx]) pts[idx][axis === 'x' ? 0 : 1] = value;
        writeKey({ warp: { cols: lat.cols, rows: lat.rows, pts } }, null);
    }

    /** 角名 → 顶点索引（网格尺寸无关） */
    function cornerIndex(lat, ck) {
        const stride = lat.cols + 1;
        if (ck === 'tl') return 0;
        if (ck === 'tr') return lat.cols;
        if (ck === 'bl') return lat.rows * stride;
        return lat.rows * stride + lat.cols;
    }

    function writeEase(ease) {
        writeKey(null, ease);
    }

    // 关键帧时间现在是任意浮点秒，直接用 setTime 落到那一刻（纹理与播放头由外壳按时间派生）
    function jumpToTime(t) {
        if (typeof ctx.setTime === 'function') ctx.setTime(t);
    }

    function runAction(act) {
        const doc = ctx.doc();
        if (!doc) return;
        const layer = currentLayer(doc);
        if (!layer) return;
        const track = trackOf(layer);
        const t = nowTime();
        const idx = keyIndexAt(track, t);

        if (act === 'del') {
            if (idx < 0) {
                notify(tr('xform.err.noKey'));
                return;
            }
            ctx.setDoc((d) => {
                const target = layerById(d, layer.id);
                if (!target) return d;
                const trk = trackOf(target);
                const i = keyIndexAt(trk, t);
                if (i < 0) return d;
                return replaceTransform(d, target.id, removeKey(trk, i));
            });
            restoreTime(t);
            if (typeof ctx.requestRender === 'function') ctx.requestRender();
            refresh();
            return;
        }

        if (act === 'reset') {
            ctx.setDoc((d) => {
                const target = layerById(d, layer.id);
                if (!target) return d;
                const trk = trackOf(target);
                const i = keyIndexAt(trk, t);
                const ease = i >= 0 ? trk.keys[i].ease : 'linear';
                const next = addKey(trk, t, Object.assign({}, DEFAULT_STATE), ease);
                return replaceTransform(d, target.id, next);
            });
            restoreTime(t);
            notify(tr('xform.ok.reset'));
            if (typeof ctx.requestRender === 'function') ctx.requestRender();
            refresh();
            return;
        }

        if (act === 'prev' || act === 'next') {
            const keys = track.keys;
            if (!keys.length) {
                notify(tr('xform.err.layerNoKeys'));
                return;
            }
            let target = null;
            if (idx >= 0) {
                target = act === 'prev' ? keys[idx - 1] : keys[idx + 1];
            } else if (act === 'prev') {
                for (let i = keys.length - 1; i >= 0; i--) {
                    if (keys[i].t < t - T_EPS) {
                        target = keys[i];
                        break;
                    }
                }
            } else {
                for (let i = 0; i < keys.length; i++) {
                    if (keys[i].t > t + T_EPS) {
                        target = keys[i];
                        break;
                    }
                }
            }
            if (!target) {
                notify(act === 'prev' ? tr('xform.err.firstKey') : tr('xform.err.lastKey'));
                return;
            }
            jumpToTime(target.t);
            refresh();
        }
    }

    // ── 视图刷新

    function fmtNum(v) {
        const n = Number(v);
        if (!Number.isFinite(n)) return '0';
        const r = Math.round(n * 1000) / 1000;
        return String(r);
    }

    function syncLayerOptions(doc, layer) {
        const sig = objectsOf(doc).map((l) => l.id).join(',');
        if (layerSel.dataset.sig !== sig) {
            layerSel.dataset.sig = sig;
            layerSel.textContent = '';
            for (const l of objectsOf(doc)) {
                const opt = document.createElement('option');
                opt.value = l.id;
                opt.textContent = l.name;
                layerSel.appendChild(opt);
            }
        } else {
            // 名字可能改过
            objectsOf(doc).forEach((l, i) => {
                const opt = layerSel.options[i];
                if (opt && opt.textContent !== l.name) opt.textContent = l.name;
            });
        }
        if (layer && layerSel.value !== layer.id) layerSel.value = layer.id;
        layerSel.disabled = objectsOf(doc).length === 0;
    }

    function refresh() {
        const doc = ctx.doc();
        if (!doc) {
            keysEl.textContent = '—';
            layerSel.textContent = '';
            layerSel.dataset.sig = '';
            layerSel.disabled = true;
            for (const input of fieldInput.values()) {
                input.value = '';
                input.disabled = true;
            }
            for (const input of cornerInput.values()) {
                input.value = '';
                input.disabled = true;
            }
            for (const b of easeBtn.values()) b.classList.remove('is-on');
            for (const b of actBtn.values()) b.disabled = true;
            return;
        }

        const layer = currentLayer(doc);
        syncLayerOptions(doc, layer);
        for (const input of fieldInput.values()) input.disabled = false;
        for (const input of cornerInput.values()) input.disabled = false;
        for (const b of actBtn.values()) b.disabled = false;

        if (!layer) {
            keysEl.textContent = tr('xform.keys.none');
            return;
        }

        // 当前连续时间（秒）：所有显示值都是这一刻的求值
        const t = nowTime();
        const track = trackOf(layer);
        const state = stateAt(track, t);
        const idx = keyIndexAt(track, t);
        const keyCount = track.keys.length;

        // 计数单位统一用「颗」（与时间轴/曲线的报数一致）；「一个关键帧」这类语词不动
        keysEl.textContent = tr('xform.keys.count', { n: keyCount, t: t.toFixed(2) });

        for (const [key] of FIELDS) {
            const input = fieldInput.get(key);
            if (document.activeElement === input) continue;
            input.value = fmtNum(state[key]);
        }

        const lat = normalizeLattice(state.warp);
        const warp = lat ? latticeToQuad(lat) : ZERO_WARP;
        for (const [ck] of CORNERS) {
            for (const axis of ['x', 'y']) {
                const input = cornerInput.get(ck + ':' + axis);
                if (!input || document.activeElement === input) continue;
                const pt = warp[ck] || [0, 0];
                input.value = fmtNum(axis === 'x' ? pt[0] : pt[1]);
            }
        }
        // 密度按钮高亮当前网格
        const cols = lat ? lat.cols : 1;
        const rows = lat ? lat.rows : 1;
        for (const [key, btn] of divBtns) btn.classList.toggle('is-on', key === cols + ':' + rows);
        warpBtn.classList.toggle('is-on', !corners.hidden);
        warpBtn.setAttribute('aria-pressed', corners.hidden ? 'false' : 'true');

        const ease = idx >= 0 ? track.keys[idx].ease : null;
        for (const [val, btn] of easeBtn) btn.classList.toggle('is-on', ease === val);

        actBtn.get('prev').disabled = keyCount === 0;
        actBtn.get('next').disabled = keyCount === 0;
        actBtn.get('del').disabled = idx < 0;
    }

    layerSel.addEventListener('change', () => {
        const id = layerSel.value;
        if (id) ctx.setActiveLayer(id);
        refresh();
    });

    // 面板被点击时补一次同步：当前对象可能刚刚在别处被切换（非 doc 变更）。
    // 下拉框自己会触发 change，跳过它以免覆盖用户的选择。
    root.addEventListener('pointerdown', (e) => {
        const t = e.target;
        if (t && t.closest && t.closest('.xf-layer')) return;
        if (ctx.doc()) refresh();
    }, true);

    refresh();

    return { el: root, refresh: refresh };
}
