/**
 * 画布宿主的 DOM chrome（从 editors/canvas.mjs 抽出）
 *
 * 负责挂载在宿主里的三样「界面零件」及其交互：
 *   - `.cv-hud`       适配 / 缩放
 *   - `.cv-gizmo`     叠加层画布（只建，不画 —— 绘制留在 canvas.mjs）
 *   - `.cv-objectbar` 对象浮动工具条 + `.cv-ob-menu` 效果菜单
 * 外加宿主兜底搬迁（宿主落在 display:none 容器里时搬到可见容器）。
 *
 * 只碰 DOM，不做几何/命中/拖动数学（那些在 core/gizmo.mjs）。
 */

import { handlePoints } from '../core/element.mjs';
import { objectsOf } from '../core/doc-model.mjs';
import { icon } from '../core/icons.mjs';

export function zoomText(engine) {
    const z = engine && typeof engine.zoom === 'function' ? Number(engine.zoom()) : 1;
    return Math.round((Number.isFinite(z) && z > 0 ? z : 1) * 100) + '%';
}

function mkBtn(act, label, title, html) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cv-hud-btn';
    b.dataset.act = act;
    // html 给的是图标串（已转义过），否则就是纯文字标签
    if (html) b.innerHTML = html;
    else b.textContent = label;
    if (title) {
        b.title = title;
        b.setAttribute('aria-label', title);
    }
    return b;
}

/**
 * 建好 HUD、叠加层画布、对象浮动工具条，并接上它们的交互。
 * @param {object} deps
 *   el              画布容器（HUD 挂这里）
 *   host            宿主单例（gizmo / 工具条 / 菜单挂这里）
 *   engine          引擎（可能为 null）
 *   ctx             外壳上下文
 *   gizmoClass      叠加层 canvas 的 class
 *   toScreen        屏幕坐标换算（工具条定位用）
 *   selectionInfo   当前选区信息
 *   placeCanvas     宿主搬迁函数（兜底用）
 */
export function buildChrome(deps) {
    const { el, host, engine, ctx, gizmoClass, toScreen, selectionInfo, placeCanvas } = deps;

    /* ── HUD ── */

    const hud = document.createElement('div');
    hud.className = 'cv-hud';
    // 缩放控件组：− 百分比 ＋ 适配。百分比本身是「回到 100%」的按钮，
    // 这里排成一段连续的控制带，比原来两个孤立按钮更好认（AE / Krita 的通行做法）。
    const outBtn = mkBtn('out', '', '缩小一级（Ctrl+滚轮向下）', icon('minus'));
    const zoomBtn = mkBtn('zoom', zoomText(engine), '点按回到 100%');
    const inBtn = mkBtn('in', '', '放大一级（Ctrl+滚轮向上）', icon('plus'));
    const fitBtn = mkBtn('fit', '适配', '缩放到刚好铺满视图（0）', icon('fit') + '<span>适配</span>');
    hud.appendChild(outBtn);
    hud.appendChild(zoomBtn);
    hud.appendChild(inBtn);
    hud.appendChild(fitBtn);
    el.appendChild(hud);

    /* ── 叠加层画布（pointer-events:none，只负责显示） ── */

    const gizmo = document.createElement('canvas');
    gizmo.className = gizmoClass;
    gizmo.style.position = 'absolute';
    gizmo.style.inset = '0';
    gizmo.style.width = '100%';
    gizmo.style.height = '100%';
    gizmo.style.pointerEvents = 'none';
    gizmo.style.zIndex = '3';
    host.appendChild(gizmo);

    /* ── 对象浮动工具条：v8 已移除 ──
       选中对象后那个悬浮小框（变换/网格/＋效果/清效果）拿掉了：
       这些动作在属性面板里都有（手柄直接在画布上拖、网格变形在「变换」组、效果在「效果」组），
       画布上再挂一条小框既挡视线，又和面板形成第二套入口。
       下面这些节点仍然创建但不挂进 DOM，只为保持对外的 return 形状不变。 */

    const obar = document.createElement('div');
    obar.className = 'cv-objectbar';
    obar.hidden = true;
    const obName = document.createElement('span');
    obName.className = 'cv-ob-name';
    obar.appendChild(obName);
    const obBtns = {};
    const mkOb = (key, label, title) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'cv-ob-btn';
        b.dataset.act = key;
        b.textContent = label;
        b.title = title;
        obar.appendChild(b);
        obBtns[key] = b;
        return b;
    };
    mkOb('transform', '变换', '拖动四周手柄缩放，拖动上方圆点旋转');
    mkOb('warp', '网格', '拖动网格顶点做局部变形');
    mkOb('fx', '＋效果', '给这个对象加一个渲染效果（模糊 / 外发光 / 投影 / 调整 / 描边）');
    mkOb('fxclear', '清效果', '移除这个对象的全部效果');

    const fxMenu = document.createElement('div');
    fxMenu.className = 'cv-ob-menu';
    fxMenu.hidden = true;
    // 注意：这里故意不 appendChild(obar / fxMenu) —— 见上面的说明。

    /* ── 工具条位置与状态：贴着选区上边，超出画布就夹回来 ── */

    const hideBar = () => {
        if (!obar.hidden) obar.hidden = true;
        if (!fxMenu.hidden) fxMenu.hidden = true;
    };

    function syncObjectBar(info, quad) {
        // v8：浮动小框已移除，这里直接收起并返回（node 仍在，但不进 DOM）
        hideBar();
        return;
        // 画格画布模式（绘图工作区）里画的是这张画格本身：变换/网格/效果都是编排语汇，
        // 显示出来只会挡视线，也会让用户误以为在画布上点选对象能改什么。
        if (engine && typeof engine.isDrawingBoard === "function" && engine.isDrawingBoard()) {
            hideBar();
            return;
        }
        if (!info || !quad) {
            hideBar();
            return;
        }
        const tl = toScreen(quad.tl);
        const tr = toScreen(quad.tr);
        const midX = (tl.x + tr.x) / 2;
        const topY = Math.min(tl.y, tr.y);
        obar.hidden = false;
        const w = obar.offsetWidth || 250;
        const hw = host.clientWidth || 800;
        const left = Math.round(Math.max(4, Math.min(hw - w - 4, midX - w / 2)));
        obar.style.left = left + 'px';
        obar.style.top = Math.round(Math.max(4, topY - 30)) + 'px';

        obName.textContent = info.el.name || '对象';
        const n = Array.isArray(info.el.effects) ? info.el.effects.length : 0;
        obBtns.fx.textContent = n ? '＋效果 ' + n : '＋效果';
        obBtns.transform.classList.toggle('is-on', info.sel.mode !== 'warp');
        obBtns.warp.classList.toggle('is-on', info.sel.mode === 'warp');
        obBtns.fxclear.disabled = n === 0;
    }

    /** 独立于 gizmo 绘制：任何时序下都保证工具条与选区一致 */
    function updateObjectBar() {
        const info = selectionInfo();
        if (!info) {
            hideBar();
            return;
        }
        const hp = handlePoints(info.doc, info.el, info.time, info.parentM);
        syncObjectBar(info, hp.quad);
    }

    /* ── 工具条交互 ── */

    const currentSel = () => (typeof ctx.selection === 'function' ? ctx.selection() : null);
    const currentEl = () => {
        const s = currentSel();
        const d = typeof ctx.doc === 'function' ? ctx.doc() : null;
        if (!s || !s.id || !d) return null;
        // v6 起文档容器叫 d.objects（objectsOf 同时兼容旧的 d.layers）。
        // 这里曾经写死 Array.isArray(d.layers)，于是在新文档上恒为 null：
        // 菜单能弹出、点菜单项却在 currentEl() 上直接 return —— 用户看到的就是「效果加不上」。
        return objectsOf(d).find((l) => l && l.id === s.id) || null;
    };
    /* 「网格」要真的能拖：1×1 网格没有内部线也没有内部顶点，点进去只剩原来的选框，
       用户以为按钮没反应。所以切 warp 之前先确保有一张能看的网格：
       2×2 —— resizeLattice 会保留已有的四角偏移（双线性重采样等价），形状不跳。 */
    const ensureWarpGrid = () => {
        const s = currentSel();
        if (!s || !s.id) return;
        if (typeof ctx.latticeOf !== 'function' || typeof ctx.setLatticeDiv !== 'function') return;
        const lat = ctx.latticeOf(s.id);
        const coarse = !lat || !Number.isFinite(lat.cols) || !Number.isFinite(lat.rows)
            || (lat.cols < 2 && lat.rows < 2);
        if (coarse) ctx.setLatticeDiv(2, 2, s.id);   // 内部会 flash「网格 2×2」，用户能看到反馈
    };
    const setMode = (mode) => {
        const s = currentSel();
        if (s && typeof ctx.setSelection === 'function') ctx.setSelection({ id: s.id, mode });
    };
    obBtns.transform.addEventListener('click', (ev) => {
        ev.stopPropagation();
        setMode('transform');
    });
    obBtns.warp.addEventListener('click', (ev) => {
        ev.stopPropagation();
        // 顺序不能反：setSelection 会马上重画叠加层，网格必须先落在文档里
        ensureWarpGrid();
        setMode('warp');
    });
    obBtns.fxclear.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const el2 = currentEl();
        if (el2 && typeof ctx.setLayerEffects === 'function') ctx.setLayerEffects(el2.id, []);
    });
    obBtns.fx.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!fxMenu.hidden) {
            fxMenu.hidden = true;
            return;
        }
        const defs = Array.isArray(ctx.effectDefs) ? ctx.effectDefs : [];
        fxMenu.textContent = '';
        for (const d of defs) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'cv-ob-mi';
            b.textContent = d.name || d.label || d.id || d.type;
            b.addEventListener('click', (e2) => {
                e2.stopPropagation();
                fxMenu.hidden = true;
                const el2 = currentEl();
                if (!el2 || typeof ctx.setLayerEffects !== 'function') return;
                const cur = Array.isArray(el2.effects) ? el2.effects.slice() : [];
                const eff = typeof ctx.makeEffect === 'function' ? ctx.makeEffect(d.id || d.type) : { type: d.id || d.type };
                ctx.setLayerEffects(el2.id, cur.concat([eff]));
            });
            fxMenu.appendChild(b);
        }
        const r = obar.getBoundingClientRect();
        const hr = host.getBoundingClientRect();
        fxMenu.style.left = Math.round(r.left - hr.left) + 'px';
        fxMenu.style.top = Math.round(r.bottom - hr.top + 4) + 'px';
        fxMenu.hidden = false;
    });
    // 点画布别处就收起菜单（捕获阶段，先于落笔）
    host.addEventListener('pointerdown', () => {
        if (!fxMenu.hidden) fxMenu.hidden = true;
    }, true);

    /* ── 宿主兜底搬迁 ──
       宿主可能落在一个 display:none 的工作区里（外壳切工作区、恢复布局、
       重新挂载的时序都可能把单例宿主留在隐藏容器）。宿主尺寸为 0 时引擎会把自己
       压成 1×1，画布看起来就是「一片空白」。
       这里只做一件事：宿主不可见时，搬到任一个可见的画布容器。 */

    function ensureVisibleHost() {
        if (!host.isConnected) return;
        const r = host.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) return;
        const bodies = document.querySelectorAll('.area-body.ed-canvas');
        for (const b of bodies) {
            if (b === host.parentElement) continue;
            const br = b.getBoundingClientRect();
            if (br.width > 0 && br.height > 0) {
                placeCanvas(b);
                requestAnimationFrame(() => {
                    try {
                        if (engine && typeof engine.fitView === 'function') engine.fitView();
                        if (engine && typeof engine.render === 'function') engine.render();
                    } catch (err) {
                        /* 忽略 */
                    }
                });
                return;
            }
        }
    }

    /* ── HUD 接线 ── */

    const docReady = () => (typeof ctx.doc === 'function' ? !!ctx.doc() : true);
    const syncZoom = () => {
        zoomBtn.textContent = zoomText(engine);
    };

    const onFit = () => {
        if (!docReady() || !engine || typeof engine.fitView !== 'function') return;
        engine.fitView();
        syncZoom();
    };
    const onZoom = () => {
        if (!docReady() || !engine || typeof engine.setZoom !== 'function') return;
        engine.setZoom(1);
        syncZoom();
    };
    // 视角围绕视图中心缩放（zoomBy 的 cx/cy 省略即为中心，见 paint/engine.mjs:187）
    const zoomStep = (k) => {
        if (!docReady() || !engine || typeof engine.zoomBy !== 'function') return;
        engine.zoomBy(k);
        syncZoom();
    };
    const onOut = () => zoomStep(1 / 1.25);
    const onIn = () => zoomStep(1.25);
    const onWheel = () => syncZoom();
    const onWinResize = () => syncZoom();

    fitBtn.addEventListener('click', onFit);
    zoomBtn.addEventListener('click', onZoom);
    outBtn.addEventListener('click', onOut);
    inBtn.addEventListener('click', onIn);
    host.addEventListener('wheel', onWheel, { passive: true });
    window.addEventListener('resize', onWinResize);

    let ro = null;
    if (typeof ResizeObserver === 'function') {
        ro = new ResizeObserver(() => {
            syncZoom();
            requestAnimationFrame(syncZoom);
        });
        ro.observe(el);
    }
    let polls = 6;
    const pollZoom = () => {
        syncZoom();
        if (--polls > 0) requestAnimationFrame(pollZoom);
    };
    if (engine) requestAnimationFrame(pollZoom);

    const disposeHud = () => {
        fitBtn.removeEventListener('click', onFit);
        zoomBtn.removeEventListener('click', onZoom);
        outBtn.removeEventListener('click', onOut);
        inBtn.removeEventListener('click', onIn);
        host.removeEventListener('wheel', onWheel);
        window.removeEventListener('resize', onWinResize);
        if (ro) ro.disconnect();
        ro = null;
        polls = 0;
    };

    return { hud, fitBtn, zoomBtn, outBtn, inBtn, gizmo, obar, fxMenu, syncZoom, updateObjectBar, hideBar, ensureVisibleHost, disposeHud };
}
