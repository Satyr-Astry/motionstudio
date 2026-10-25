// 时间轴（v6：没有帧，只有时间）—— 主文件：外壳通信 / 状态机 / 事件分发 / 画格增删改 / 缩放。
//
// 拆分后的分工：
//   ./timeline-geo.mjs    纯几何 + 纯数据（零 DOM，可在 Node 里直接 import）
//   ./timeline-paint.mjs  只把 DOM 画出来（刻度尺 / 画格块 / 菱形 / 播放头 / 工具条）
//   ./timeline-keys.mjs   关键帧交互（选中 / 拖动 / 删除 / 右键缓动菜单）
//   ./timeline.mjs        本文件：mount / 事件分发 / 画格操作 / 缩放 / 生命周期
//
// 契约：docs/CONTRACT-v6-时间模型.md
//   · 内容属于「某一秒」：obj.cels = [{ at, image }]，画格开启后一直沿用到下一个画格。
//   · 时间轴上只有两种东西：画格切换点（方块）与变换关键帧（菱形）。
// 外壳只保证 mount(el, ctx) → { destroy, refresh, focusFrame }。

import { celAt, celTimes, docDuration, objectById } from '../core/doc-model.mjs';
import { setSegmentFps } from '../core/timebase.mjs';
import {
    LABEL_W, SNAP_GRID, T_EPS, ZOOM_MAX, ZOOM_MIN, ZOOM_STEP, celMarks,
    clampNum, fitZoom, fmt2, pxPerSecond, snapFrame, snapGrid, structSignature, tickStep, timeToX, xToTime,
} from './timeline-geo.mjs';
import {
    beginFpsEdit, buildRuler, buildSegments, createLegend, createView, paintPlayhead, paintRows, paintTracks,
    rebuildRows, resetRows, resetRuler, resetSegments, setEmptyChrome, syncRulerScroll, updateTools,
} from './timeline-paint.mjs';
import { createContextMenu, createKeys, snapOnNow } from './timeline-keys.mjs';

// 纯函数与常量的对外引用面保持不变（测试与旧调用方仍从 timeline.mjs 取）。
export * from './timeline-geo.mjs';

/* ─────────────────────────── 面板 ─────────────────────────── */

export function mount(el, ctx) {
    const c = ctx && typeof ctx === 'object' ? ctx : {};

    /* ── 外壳通信安全层：缺方法只提示，不让面板崩 ── */

    const notify = (msg) => {
        if (typeof c.notify !== 'function') return;
        try {
            c.notify(String(msg));
        } catch (err) {
            /* 外壳自己的提示炸了也不能拖垮面板 */
        }
    };
    const notWired = (name) => notify((name ? name + '：' : '') + '该操作尚未接线');
    const has = (name) => typeof c[name] === 'function';
    const peek = (name) => {
        if (!has(name)) return undefined;
        try {
            return c[name]();
        } catch (err) {
            return undefined;
        }
    };
    /** 调一个外壳方法；缺失 → 提示；异常 → 提示；都不抛。 */
    const call = (name, args) => {
        if (!has(name)) {
            notWired(name);
            return undefined;
        }
        try {
            return c[name].apply(c, Array.isArray(args) ? args : []);
        } catch (err) {
            notify(name + ' 失败：' + ((err && err.message) || err));
            return undefined;
        }
    };

    const docNow = () => (has('doc') ? peek('doc') : null);
    const timeNow = () => {
        const v = Number(peek('time'));
        return Number.isFinite(v) ? v : 0;
    };
    const activeId = () => (has('activeLayerId') ? peek('activeLayerId') : null);
    const setActive = (id) => {
        if (has('setActiveLayer')) call('setActiveLayer', [id]);
    };
    const setTime = (t) => {
        if (!has('setTime')) return;
        const v = Number(t);
        call('setTime', [Number.isFinite(v) ? Math.max(0, v) : 0]);
    };
    /** 面板改完 doc 后把连续时间还回去（外壳可能顺手夹了时间）。 */
    const keepTime = (t) => {
        const v = Number(t);
        if (!Number.isFinite(v)) return;
        if (Math.abs(timeNow() - v) > 1e-6) setTime(v);
    };
    const isPlaying = () => !!peek('playing');

    /* ── v8：时间写入只有这五个出口 ──
       面板里所有「播放头相关」的写入都走这里，别直接调 ctx.setTime：
       外壳的 setTime 会走 wrapTime 回绕，拖到末尾会跳回 0（这正是旧版擦洗回卷的原因）。 */

    /** 播放头：夹在 [0, 时长] 内，永不回绕。 */
    function seek(t) {
        const v = Number(t);
        if (has('setTimeClamped')) {
            call('setTimeClamped', [Number.isFinite(v) ? Math.max(0, v) : 0]);
            return;
        }
        if (has('setTime')) call('setTime', [Number.isFinite(v) ? Math.max(0, v) : 0]);
        else notWired('setTimeClamped');
    }

    /** 逐帧（1/fps）：外壳先把时间折成整帧再加减，避免浮点把播放头卡在帧间。 */
    function stepBy(n) {
        if (has('stepFrames')) {
            call('stepFrames', [Number(n) || 0]);
            return;
        }
        const doc = docNow();
        const fps = doc && Number(doc.fps) > 0 ? Number(doc.fps) : 12;
        seek(Math.round(timeNow() * fps + (Number(n) || 0)) / fps);
    }

    function seekFirst() {
        seek(0);
    }

    function seekLast() {
        const doc = docNow();
        if (!doc) return;
        seek(docDuration(doc));
    }

    /** 总时长的唯一出口：外壳负责「不低于内容长度」的下限与中文提示。 */
    function applyDuration(sec) {
        const v = Number(sec);
        if (!has('setDuration')) {
            notWired('setDuration');
            return false;
        }
        if (!Number.isFinite(v) || v <= 0) {
            notify('总时长要大于 0 秒');
            return false;
        }
        call('setDuration', [v]);
        return true;
    }

    /** 输入框里的「1.5」/「1,5」/「1.5s」都读成数字；读不出来返回 null。 */
    function readNum(text) {
        const raw = String(text == null ? '' : text).replace(',', '.').replace(/[^0-9.+-]/g, '');
        const v = Number(raw);
        return raw !== '' && Number.isFinite(v) ? v : null;
    }

    /* ── DOM 骨架与协作模块 ── */

    const view = createView(el);
    const menu = createContextMenu();
    // 图例按钮进工具条（不是 .tline 的第 4 个孩子：骨架结构被测试钉死）
    const legend = createLegend();
    view.tools.appendChild(legend.el);

    /* ── 模块内状态（都不进文档） ── */

    let zoomX = 1;
    // 磁铁（吸附到整帧）跟着 localStorage 走，切面板/重启后保持用户选择
    let snapOn = snapOnNow();
    let structSig = null;
    let rulerSig = '';
    let scrub = null;
    let durDrag = null;
    // 空白泳道按下会先把播放头挪到指针处（点一下就到那儿，顺手）；
    // 但一旦真的拖出框选矩形，就得把播放头还原 —— 否则框选顺手改掉当前时刻，
    // 用户会以为「选完了时间也变了」。这里只做这一件事。
    let laneSeek = null; // 拖总时长手柄期间的预览状态 { t, keep }

    const keys = createKeys({
        notify,
        notWired,
        has,
        call,
        docNow,
        timeNow,
        activeId,
        setActive,
        keepTime,
        paint,
        zoomOf: () => zoomX,
        menu,
        addCel: (layerId, t) => celOp('addCelAt', layerId, t),
        // 框选要知道「在哪个滚动容器里量矩形」，关键帧模块自己不碰 view
        rowsEl: () => view.rows,
    });

    /* ── 主绘制 ── */

    function paint() {
        const doc = docNow();
        if (!doc) {
            structSig = null;
            rulerSig = '';
            resetRows(view);
            resetRuler(view);
            resetSegments(view);
            menu.close();
            setEmptyChrome(view, zoomX);
            return;
        }

        const now = timeNow();
        const total = docDuration(doc);
        const totalPx = Math.max(1, timeToX(doc, total, zoomX));

        // 读数由 updateTools 统一写（这里再写一次会互相覆盖，输入框还会被清掉光标）
        view.zoomEl.textContent = zoomX.toFixed(1) + '×';

        const sig = structSignature(doc);
        if (sig !== structSig) {
            rebuildRows(view, doc);
            structSig = sig;
        }

        const rs = zoomX + '|' + total.toFixed(6) + '|' + tickStep(doc, zoomX);
        if (rs !== rulerSig) {
            buildRuler(view, doc, zoomX);
            rulerSig = rs;
        }

        const frame = {
            doc,
            now,
            total,
            totalPx,
            zoomX,
            snapOn,
            active: activeId(),
            playing: isPlaying(),
            selKey: keys.selection(), // 主键：老读数，.is-ch 通道键仍按它判断
            selKeys: keys.selectionAll(), // 整个集合：多选高亮用
        };
        paintRows(view, frame);
        paintTracks(view, frame);
        paintPlayhead(view, frame);
        buildSegments(view, frame, editFps);
        updateTools(view, frame);
        syncRulerScroll(view);
    }

    /** 段帧率条双击 → 内联输入框（编辑器 UI 在 paint 模块，写文档在这里）。 */
    function editFps(node) {
        beginFpsEdit(node, { commit: commitSegmentFps, repaint: paint });
    }

    function commitSegmentFps(index, fps) {
        const done = () => notify('第 ' + (index + 1) + ' 段帧率改成 ' + Math.round(fps) + ' fps');
        if (has('setSegmentFps')) {
            call('setSegmentFps', [index, fps]);
            done();
            return;
        }
        if (has('setTimeSegmentFps')) {
            call('setTimeSegmentFps', [index, fps]);
            done();
            return;
        }
        if (has('setDoc')) {
            call('setDoc', [(d) => setSegmentFps(d, index, fps)]);
            done();
            return;
        }
        notWired('setSegmentFps');
    }

    /* ── 画格操作（统一走外壳方法，缺失只提示） ── */

    function celOp(name, objId, t) {
        if (!has(name)) {
            notWired(name);
            return;
        }
        call(name, [objId, t]);
    }

    /* ── 刻度尺擦洗 ── */

    function detachScrub() {
        document.removeEventListener('pointermove', onScrubMove);
        document.removeEventListener('pointerup', onScrubUp);
        document.removeEventListener('pointercancel', onScrubUp);
    }

    /** 刻度尺上的像素 → 时间：内容层被平移了 (LABEL_W - scrollLeft)。 */
    function rulerXToTime(clientX) {
        const doc = docNow();
        if (!doc) return 0;
        const rect = typeof view.ruler.getBoundingClientRect === 'function' ? view.ruler.getBoundingClientRect() : { left: 0 };
        const s = Number(view.rows.scrollLeft) || 0;
        return xToTime(doc, clientX - rect.left - LABEL_W + s, zoomX);
    }

    function scrubTo(e) {
        if (!scrub) return;
        const doc = docNow();
        if (!doc) return;
        // 拖播放头必须「夹」到 [0, 总长]：setTime 走 wrapTime，拖到末尾会回绕成 0，
        // 这是「拖到右边突然跳回开头」的根因（契约 v8 起面板一律用 setTimeClamped）。
        seek(rulerXToTime(e.clientX));
    }

    function onScrubMove(e) {
        if (!scrub) return;
        scrubTo(e);
    }

    function onScrubUp() {
        detachScrub();
        scrub = null;
        paint();
    }

    /* ── 总时长手柄（刻度尺右端的方块）──
       拖动期间只预览：移动手柄、写读数，不碰文档；
       松手才提交一次 setDuration —— 否则每像素一个撤销步，撤销栈会被填满。 */

    function detachDurDrag() {
        document.removeEventListener('pointermove', onDurMove);
        document.removeEventListener('pointerup', onDurUp);
        document.removeEventListener('pointercancel', onDurUp);
    }

    function detachLaneSeek() {
        document.removeEventListener('pointermove', onLaneSeekMove);
        document.removeEventListener('pointerup', onLaneSeekUp);
        document.removeEventListener('pointercancel', onLaneSeekUp);
    }

    /** 拖出框选（超过 3px）就撤销按下时的跳转，让框选不动播放头。 */
    function onLaneSeekMove(e) {
        if (!laneSeek || laneSeek.restored) return;
        if (Math.abs(e.clientX - laneSeek.x0) <= 3) return;
        laneSeek.restored = true;
        if (has('setTimeClamped')) call('setTimeClamped', [laneSeek.before]);
        else setTime(laneSeek.before);
    }

    function onLaneSeekUp() {
        detachLaneSeek();
        laneSeek = null;
    }

    function onDurDown(e) {
        const doc = docNow();
        if (!doc) return;
        if (typeof e.preventDefault === 'function') e.preventDefault();
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
        // 用相对位移而不是「指针绝对位置换算时间」：手柄可能被钉在右缘（末端在视野外），
        // 绝对换算会在按下的第一像素就把时长跳到视口里的某个值。
        durDrag = { t: docDuration(doc), t0: docDuration(doc), x0: e.clientX, keep: timeNow(), moved: false };
        document.addEventListener('pointermove', onDurMove);
        document.addEventListener('pointerup', onDurUp);
        document.addEventListener('pointercancel', onDurUp);
    }

    function onDurMove(e) {
        if (!durDrag) return;
        const doc = docNow();
        if (!doc) return;
        const minT = 1 / (Number(doc.fps) || 12);
        const pps = Math.max(1e-6, pxPerSecond(doc, zoomX));
        const moved = Math.abs(e.clientX - durDrag.x0) > 0;
        const t = Math.max(minT, snapFor(doc, Math.max(minT, durDrag.t0 + (e.clientX - durDrag.x0) / pps), e));
        durDrag.t = t;
        if (moved) durDrag.moved = true;
        const node = view.durHandle;
        if (node && node.classList.contains('is-edge')) {
            // 贴边态：手柄不动，只更新读数，松手后由 paint 重新定位
        } else if (node) {
            node.style.left = timeToX(doc, t, zoomX).toFixed(2) + 'px';
        }
        if (view.totalEl && document.activeElement !== view.totalEl) view.totalEl.value = t.toFixed(2);
    }

    function onDurUp() {
        detachDurDrag();
        detachLaneSeek();
        laneSeek = null;
        const d = durDrag;
        durDrag = null;
        if (!d) return;
        applyDuration(d.t);
        keepTime(d.keep);
        paint();
    }

    /* ── 工具条 ── */

    function setZoom(next) {
        const z = clampNum(Number(next) || zoomX, ZOOM_MIN, ZOOM_MAX);
        if (Math.abs(z - zoomX) < 1e-9) return;
        zoomX = z;
        rulerSig = '';
        paint();
    }

    /**
     * 磁铁规则（工具条上的「磁铁」+ Shift 临时反转）：
     * 开着时拖动吸到整帧、按住 Shift 变自由；关着时自由、按住 Shift 吸 0.1 s 网格。
     * 关键帧那边（timeline-keys）用同一套规则 + 同一个 localStorage 键。
     */
    function magnetOf(e) {
        const shift = !!(e && e.shiftKey);
        return shift ? (snapOn ? 'off' : 'grid') : (snapOn ? 'frame' : 'off');
    }

    /** 把一次拖动算出来的时刻过一遍磁铁。 */
    function snapFor(doc, t, e) {
        const m = magnetOf(e);
        if (m === 'frame') return snapFrame(doc, t);
        if (m === 'grid') return snapGrid(t, SNAP_GRID);
        return t;
    }

    function toggleSnap() {
        snapOn = !snapOn;
        try {
            window.localStorage.setItem('ms.timeline.snap', snapOn ? '1' : '0');
        } catch {
            /* 隐私模式下写不进 localStorage：开关只在本会话有效 */
        }
        notify(snapOn ? '磁铁：吸附到整帧' : '磁铁：关闭（按住 Shift 吸 0.1 s 网格）');
        paint();
    }

    /** Ctrl+滚轮：以指针所在的时刻为锚点缩放（缩放前后那一刻停在原地）。 */
    function onWheelZoom(e) {
        if (!(e.ctrlKey || e.metaKey)) return;
        const doc = docNow();
        if (!doc) return;
        if (typeof e.preventDefault === 'function') e.preventDefault();
        const box = view.rows;
        if (!box || typeof box.getBoundingClientRect !== 'function') return;
        const before = zoomX;
        setZoom(zoomX * (e.deltaY > 0 ? 1 / ZOOM_STEP : ZOOM_STEP));
        if (Math.abs(zoomX - before) < 1e-9) return;
        const r = box.getBoundingClientRect();
        const localX = e.clientX - r.left - LABEL_W + (Number(box.scrollLeft) || 0);
        if (localX < 0) return; // 指针压左侧对象名列：没有时刻可锚
        const tAt = xToTime(doc, localX, before);
        const after = timeToX(doc, tAt, zoomX);
        box.scrollLeft = Math.max(0, after - (e.clientX - r.left - LABEL_W));
        syncRulerScroll(view);
    }

    /**
     * 双击刻度尺 = 适应全长：把整段时长装进可视宽度（左缘回到 t=0）。
     * 与 `Ctrl+滚轮`（锚在指针那一刻）互补：那个是「我要看这一刻附近」，这个是「我要看全貌」。
     * 右侧留 24px 与 `buildRuler` 的 contentW 一致，免得末端刻度贴着边。
     */
    function fitAll() {
        const doc = docNow();
        if (!doc) return;
        const box = view.rows;
        if (!box || typeof box.getBoundingClientRect !== 'function') return;
        const avail = (Number(box.clientWidth) || 0) - LABEL_W - 24;
        const z = fitZoom(doc, avail);
        if (z == null) {
            notify('时长或视口宽度为 0，没法适应全长');
            return;
        }
        setZoom(z);
        box.scrollLeft = 0;
        syncRulerScroll(view);
        notify('适应全长：' + zoomX.toFixed(2) + '×');
    }

    /* ── 播放头移动：定义在文件头部的 seek / stepBy / seekFirst / seekLast ── */

    function goCel(dir) {
        const doc = docNow();
        if (!doc) return;
        const name = dir < 0 ? 'prevCel' : 'nextCel';
        if (has(name)) {
            call(name, []);
            return;
        }
        // 本地兜底：在活动对象的画格点之间跳
        const obj = objectById(doc, activeId());
        if (!obj) {
            notify('先选一个对象');
            return;
        }
        const times = celTimes(obj);
        const now = timeNow();
        if (dir < 0) {
            const back = times.filter((t) => t < now - T_EPS).pop();
            setTime(back == null ? 0 : back);
        } else {
            const fwd = times.find((t) => t > now + T_EPS);
            if (fwd == null) {
                notify('已经是最后一个画格');
                return;
            }
            setTime(fwd);
        }
    }

    function deleteCelNow() {
        const doc = docNow();
        if (!doc) return;
        const obj = objectById(doc, activeId());
        if (!obj) {
            notify('先选一个对象');
            return;
        }
        if (celMarks(obj).length <= 1) {
            notify('每个对象至少保留一个画格');
            return;
        }
        const cel = celAt(obj, timeNow());
        if (!cel) {
            notify('该时间没有生效的画格');
            return;
        }
        celOp('removeCelAt', obj.id, cel.at);
    }

    /** 工具条 ◆：在当前时间给活动对象打一个变换关键帧（值取当前求值，画面不跳）。 */
    function addKeyNow() {
        const doc = docNow();
        if (!doc) return;
        const obj = objectById(doc, activeId());
        if (!obj) {
            notify('先选一个对象');
            return;
        }
        keys.addKeyAt(obj.id, timeNow());
    }

    /* ── 时间读数：当前时间可输入跳转、总时长可直接改 ──
       旧版「总时长」只是一段只读文字，要改时长得绕去属性面板改分段帧率，
       这就是用户说的「总时长调整不直观」。现在它长在播放控制旁边，还能拖刻度尺右端。 */

    let skipBlur = null; // 回车已经提交过，别让紧随其后的 blur 再提交一次

    function readSeconds(node) {
        return readNum(node.value);
    }

    function commitNowField() {
        const t = readSeconds(view.nowEl);
        if (t == null) {
            paint();
            return;
        }
        seek(t);
        paint();
    }

    function commitTotalField() {
        const t = readSeconds(view.totalEl);
        if (t == null) {
            paint();
            return;
        }
        applyDuration(t);
        paint();
    }

    function bindField(node, commit) {
        if (!node || typeof node.addEventListener !== 'function') return;
        node.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                skipBlur = node;
                commit();
                if (typeof node.blur === 'function') node.blur();
            } else if (e.key === 'Escape') {
                skipBlur = node;
                if (typeof node.blur === 'function') node.blur();
                paint();
            }
        });
        node.addEventListener('blur', () => {
            if (skipBlur === node) {
                skipBlur = null;
                return;
            }
            commit();
        });
    }

    bindField(view.nowEl, commitNowField);
    bindField(view.totalEl, commitTotalField);

    view.tools.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('.tline-btn') : null;
        if (!btn || btn.disabled) return;
        const act = btn.dataset.act;
        if (act === 'play') {
            if (!has('setPlaying')) {
                notWired('setPlaying');
                return;
            }
            call('setPlaying', [!isPlaying()]);
        } else if (act === 'first') {
            seekFirst();
        } else if (act === 'prev') {
            stepBy(-1);
        } else if (act === 'next') {
            stepBy(1);
        } else if (act === 'last') {
            seekLast();
        } else if (act === 'prevcel') {
            goCel(-1);
        } else if (act === 'nextcel') {
            goCel(1);
        } else if (act === 'addcel') {
            // 加的是「曝光」：把当前画格在下一个空帧再曝光一次，不新建图
            if (!has('addExposure')) {
                notWired('addExposure');
            } else if (!activeId()) {
                notify('先选一个对象');
            } else {
                call('addExposure', [activeId(), timeNow()]);
            }
            return;
        } else if (act === 'delcel') {
            deleteCelNow();
        } else if (act === 'addkey') {
            addKeyNow();
        } else if (act === 'snap') {
            toggleSnap();
            return; // toggleSnap 自己会 paint（这里再画一次会让按钮闪）
        } else if (act === 'zoomout') {
            setZoom(zoomX / ZOOM_STEP);
        } else if (act === 'zoomin') {
            setZoom(zoomX * ZOOM_STEP);
        }
        paint();
    });

    /* ── 刻度尺 ── */

    view.ruler.title = '拖动 = 擦洗时间 · 双击 = 适应全长（整段时长装进视口）';

    // 双击适应全长。段条与时长手柄自己处理双击（改帧率 / 不做），先让它们优先。
    view.ruler.addEventListener('dblclick', (e) => {
        const target = e.target;
        if (target && target.closest && (target.closest('.tline-fpsseg') || target.closest('.tline-durhandle'))) return;
        if (e.preventDefault) e.preventDefault();
        fitAll();
    });

    view.ruler.addEventListener('pointerdown', (e) => {
        const doc = docNow();
        if (!doc) return;
        const target = e.target;
        if (target && target.closest && target.closest('.tline-fpsseg')) return; // 段条自己处理双击
        if (target && target.closest && target.closest('.tline-durhandle')) {
            onDurDown(e);
            return;
        }
        if (e.button !== undefined && e.button !== 0) return;
        if (typeof e.preventDefault === 'function') e.preventDefault();
        scrub = { rectLeft: 0 };
        scrubTo(e);
        document.addEventListener('pointermove', onScrubMove);
        document.addEventListener('pointerup', onScrubUp);
        document.addEventListener('pointercancel', onScrubUp);
    });

    /* ── 行区：画格点 / 菱形 / 空白 / 名称 ── */

    view.rows.addEventListener('pointerdown', (e) => {
        const doc = docNow();
        if (!doc) return;
        const target = e.target;
        if (!target || !target.closest) return;

        const kf = target.closest('.tline-kf');
        if (kf) {
            keys.kfDown(e, kf);
            return;
        }
        if (target.closest('.tline-label')) return; // 点名字只切对象，由 click 处理

        const lane = target.closest('.tline-lane');
        if (!lane) {
            // 所有泳道下面的空白也是空白：允许从那儿起框选，别让它变成点了没反应的死区
            if (target === view.rows && (e.button === undefined || e.button === 0)) keys.marqueeDown(e);
            return;
        }
        if (e.button !== undefined && e.button !== 0) return;
        const rect = typeof lane.getBoundingClientRect === 'function' ? lane.getBoundingClientRect() : { left: 0 };
        const before = timeNow();
        setTime(xToTime(doc, e.clientX - rect.left, zoomX));
        if (lane.dataset.layer) setActive(lane.dataset.layer);
        detachLaneSeek();
        laneSeek = { before: before, x0: e.clientX, restored: false };
        document.addEventListener('pointermove', onLaneSeekMove);
        document.addEventListener('pointerup', onLaneSeekUp);
        document.addEventListener('pointercancel', onLaneSeekUp);
        // 空白按下：不拖就是「点空白 → 清空选择」，拖出矩形才是框选
        keys.marqueeDown(e);
        paint();
    });

    view.rows.addEventListener('dblclick', (e) => {
        const target = e.target;
        if (!target || !target.closest) return;
        const kf = target.closest('.tline-kf');
        if (kf) {
            if (typeof e.preventDefault === 'function') e.preventDefault();
            const t = Number(kf.dataset.t);
            if (Number.isFinite(t) && kf.dataset.layer) keys.deleteKeyAt(kf.dataset.layer, t);
            return;
        }

        // 空白泳道双击 = 在这一刻给该对象打一个变换关键帧。
        // 这里必须排除画格块与菱形（上面两个分支已经吃掉），否则会误加关键帧。
        const lane = target.closest('.tline-lane');
        if (!lane || !lane.dataset || !lane.dataset.layer) return;
        if (typeof e.preventDefault === 'function') e.preventDefault();
        const doc = docNow();
        if (!doc) return;
        const rect = typeof lane.getBoundingClientRect === 'function' ? lane.getBoundingClientRect() : { left: 0 };
        keys.addKeyAt(lane.dataset.layer, xToTime(doc, e.clientX - rect.left, zoomX));
    });

    view.rows.addEventListener('contextmenu', (e) => {
        const target = e.target;
        if (!target || !target.closest) return;
        const kf = target.closest('.tline-kf');
        if (kf) {
            if (typeof e.preventDefault === 'function') e.preventDefault();
            const t = Number(kf.dataset.t);
            const layerId = kf.dataset.layer;
            if (!Number.isFinite(t) || !layerId) return;
            keys.contextMenu(e.clientX, e.clientY, layerId, t);
            return;
        }

        // 空白泳道右键：原本这里什么都不弹，而时间轴上又没有任何「加关键帧」的入口
        const lane = target.closest('.tline-lane');
        if (!lane || !lane.dataset || !lane.dataset.layer) return;
        if (typeof e.preventDefault === 'function') e.preventDefault();
        const doc = docNow();
        if (!doc) return;
        const rect = typeof lane.getBoundingClientRect === 'function' ? lane.getBoundingClientRect() : { left: 0 };
        const t = xToTime(doc, e.clientX - rect.left, zoomX);
        setActive(lane.dataset.layer);
        setTime(t); // 菜单里的「此处」必须就是用户点的位置，播放头跟着挪过去
        keys.laneMenu(e.clientX, e.clientY, lane.dataset.layer, t);
        paint();
    });

    view.rows.addEventListener('click', (e) => {
        const target = e.target;
        if (!target || !target.closest) return;
        const label = target.closest('.tline-label');
        if (!label) return;
        const row = label.parentNode;
        const id = row && row.dataset ? row.dataset.layer : null;
        if (!id) return;
        // 换了对象，旧的关键帧选择就不该还在：它只对上一个对象有意义
        keys.clearSelection();
        setActive(id);
        if (has('setSelection')) call('setSelection', [{ id }]);
        paint();
    });

    view.rows.addEventListener('scroll', () => syncRulerScroll(view));

    // Ctrl+滚轮缩放：行区与刻度尺都吃（刻度尺上滚轮没有别的用途，不缩放就只能平移）
    view.rows.addEventListener('wheel', onWheelZoom, { passive: false });
    view.ruler.addEventListener('wheel', onWheelZoom, { passive: false });

    /* ── 图例：点开两行说明（画格是开关式换图，关键帧是连续插值） ── */

    legend.el.addEventListener('click', (e) => {
        if (typeof e.stopPropagation === 'function') e.stopPropagation();
        legend.toggle();
    });

    /* ── 事件：Delete / Backspace 删除选中关键帧 ── */

    document.addEventListener('keydown', keys.onDeleteKey);

    /* ── 事件：点到时间轴外面就清空关键帧选择 ──
       选择只活在本面板，但 Delete 是全局快捷键；不主动清，用户去画布或图层面板
       点一下再按 Delete，删掉的是他根本没在看着的那些关键帧。 */

    function onOutsideDown(e) {
        const t = e.target;
        if (!t || typeof t.closest !== 'function') return;
        if (t.closest('.tline')) return; // 面板内部自己管选择
        if (t.closest('.tline-menu')) return; // 右键菜单弹在 body 上
        if (t.closest('.tline-legend-card')) return; // 图例浮层同理
        keys.clearSelection();
    }

    document.addEventListener('pointerdown', onOutsideDown, true);

    /* ── 事件：外壳派发的关键帧复制 / 粘贴（Ctrl+C / Ctrl+V）──
       剪贴板与「选中了哪颗菱形」都只活在本面板，外壳不该知道这些细节，
       所以顶层的快捷键只派发 CustomEvent，这里接住。 */
    document.addEventListener('ms:copy-keys', keys.onCopyEvent);
    document.addEventListener('ms:paste-keys', keys.onPasteEvent);

    /* ── 订阅外壳事件：优先 ctx.on，退回 ctx.subscribeDoc ── */

    const offs = [];
    const subscribe = (kind, fn) => {
        if (!has('on')) return false;
        try {
            const off = c.on(kind, fn);
            if (typeof off === 'function') offs.push(off);
            return true;
        } catch (err) {
            return false;
        }
    };
    const wiredDoc = subscribe('doc', paint);
    subscribe('time', paint);
    subscribe('selection', paint);
    subscribe('tool', paint);
    if (!wiredDoc && has('subscribeDoc')) {
        try {
            const off = c.subscribeDoc(paint);
            if (typeof off === 'function') offs.push(off);
        } catch (err) {
            /* 订阅不上也不影响手动刷新 */
        }
    }

    /* ── 对外 API ── */

    /** 把播放头滚进可视区（对象名列宽 = LABEL_W）。 */
    function focusFrame() {
        const doc = docNow();
        if (!doc) return;
        const viewW = Number(view.rows.clientWidth) || 0;
        if (!viewW) return;
        const x = timeToX(doc, timeNow(), zoomX);
        const contentLeft = LABEL_W + x;
        const visibleL = Number(view.rows.scrollLeft) || 0;
        const visibleR = visibleL + viewW;
        if (contentLeft < visibleL + LABEL_W) view.rows.scrollLeft = Math.max(0, contentLeft - LABEL_W);
        else if (contentLeft > visibleR - 8) view.rows.scrollLeft = contentLeft - viewW + 24;
        syncRulerScroll(view);
    }

    paint();

    return {
        refresh: paint,
        focusFrame,
        destroy() {
            document.removeEventListener('keydown', keys.onDeleteKey);
            document.removeEventListener('pointerdown', onOutsideDown, true);
            document.removeEventListener('ms:copy-keys', keys.onCopyEvent);
            document.removeEventListener('ms:paste-keys', keys.onPasteEvent);
            for (const off of offs) {
                try {
                    off();
                } catch (err) {
                    /* 退订失败不该挡住销毁 */
                }
            }
            offs.length = 0;
                keys.destroy();
            detachScrub();
            detachDurDrag();
                scrub = null;
            durDrag = null;
            menu.close();
            legend.close();
            view.rowRefs = [];
            view.segRefs = [];
            if (typeof view.root.remove === 'function') view.root.remove();
        },
    };
}
