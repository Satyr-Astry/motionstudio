/**
 * 画布宿主的 DOM chrome（从 editors/canvas.mjs 抽出）
 *
 * 负责挂载在宿主里的两样「界面零件」及其交互：
 *   - `.cv-hud`       适配 / 缩放
 *   - `.cv-gizmo`     叠加层画布（只建，不画 —— 绘制留在 canvas.mjs）
 * 外加宿主兜底搬迁（宿主落在 display:none 容器里时搬到可见容器）。
 *
 * 曾经的第三样 `.cv-objectbar`（对象浮动工具条 + 效果菜单）在 v8 就从画面上拿掉了，
 * 但代码一直留着空转，v0.5.0-alpha.18 连节点与样式一起删了 —— 画布上不该有第二套对象入口。
 *
 * 只碰 DOM，不做几何/命中/拖动数学（那些在 core/gizmo.mjs）。
 */

import { icon } from '../core/icons.mjs';
import { t } from '../i18n/index.mjs';

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
    const outBtn = mkBtn('out', '', t('chrome.zoomOut'), icon('minus'));
    const zoomBtn = mkBtn('zoom', zoomText(engine), t('chrome.zoomReset'));
    const inBtn = mkBtn('in', '', t('chrome.zoomIn'), icon('plus'));
    const fitBtn = mkBtn('fit', t('chrome.fitLabel'), t('chrome.fit'), icon('fit') + '<span>' + t('chrome.fitLabel') + '</span>');
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

    /* ── 对象浮动工具条：v8 移除，alpha.18 连带清掉残骸 ──
       选中对象后那个悬浮小框（变换 / 网格 / ＋效果 / 清效果）在 v8 就拿掉了：这些动作
       属性面板里都有（手柄直接在画布上拖、网格变形在「变换」组、效果在「效果」组），
       画布上再挂一条小框既挡视线，又和面板形成第二套入口。
       当时为了「保持对外的 return 形状不变」把节点创建出来却不挂 DOM，于是留下约 160 行
       不可达代码 —— syncObjectBar 第一句就是 hideBar(); return; ，后面全死。
       这里连节点、事件、导出一起删干净：画布不再有第二套对象入口，updateObjectBar
       这个已经空转的回调也从 canvas.mjs 摘掉了。
       顺带说明 ensureWarpGrid（切 warp 前补 2×2 网格，免得 1×1 点了没反应）只在这段死路里
       被调用过，真正的同款逻辑在 app/editors/xform.mjs:242-245，删掉不损失功能。 */

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
        const changed = engine.fitView();
        syncZoom();
        // 零变化也要说一句，否则用户会以为按钮坏了（与画板同名按钮同一处理）
        if (typeof ctx.notify === 'function') {
            ctx.notify(changed
                ? t('chrome.fitted')
                : t('chrome.alreadyFitted'));
        }
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

    return { hud, fitBtn, zoomBtn, outBtn, inBtn, gizmo, syncZoom, ensureVisibleHost, disposeHud };
}
