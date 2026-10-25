// 时间轴的关键帧交互：加 / 选中 / 拖动改时间 / 双击删 / 复制粘贴 / 右键菜单 / 同刻多通道合并。
// 还带一个通用右键菜单工厂（纹理菜单也用同一份，保证样式与关闭行为一致）。
//
// 所有外壳调用都走主文件注入的 deps（has / call / notify），本文件不直接摸 ctx。

import { docDuration, objectById, patchObject } from '../core/doc-model.mjs';
import { addKey, moveKey, removeKey, setKeyEase, stateAt } from '../core/transform.mjs';
import {
    EASES,
    EASE_TEXT,
    SNAP_GRID,
    T_EPS,
    clampNum,
    fmt2,
    kfLeft,
    keyGroups,
    pxPerSecond,
    setTransform,
    snapFrame,
    snapGrid,
    trackOf,
} from './timeline-geo.mjs';

// Shift 吸附的网格来自偏好面板（localStorage['ms.prefs'].snapGrid）。
// 直接读 localStorage 而不是 import shell 模块：时间轴是编辑器层，不该反向依赖外壳。
function snapGridNow() {
    try {
        const raw = window.localStorage.getItem('ms.prefs');
        const v = raw ? Number(JSON.parse(raw).snapGrid) : 0;
        return v > 0 ? v : SNAP_GRID;
    } catch {
        return SNAP_GRID;
    }
}

/**
 * 磁铁开关（时间轴工具条上那个按钮）存在 localStorage['ms.timeline.snap']：
 * '0' 关闭、其它/缺失都是开启（吸到整帧，AE/Aseprite 的默认）。
 * 和 snapGridNow 一样直接读 localStorage，编辑器层不反向依赖外壳。
 */
export function snapOnNow() {
    try {
        return window.localStorage.getItem('ms.timeline.snap') !== '0';
    } catch {
        return true;
    }
}

/* ─────────────────────────── 右键菜单 ─────────────────────────── */
/** 通用浮层菜单：open(x, y, items[{ label, disabled?, run }])。 */
export function createContextMenu() {
    let menu = null;

    function close() {
        if (menu && menu.el && typeof menu.el.remove === 'function') menu.el.remove();
        menu = null;
        document.removeEventListener('pointerdown', onMenuOutside, true);
        document.removeEventListener('keydown', onMenuKey, true);
    }

    function onMenuOutside(e) {
        if (menu && menu.el && menu.el.contains && menu.el.contains(e.target)) return;
        close();
    }

    function onMenuKey(e) {
        if (e.key !== 'Escape') return;
        if (typeof e.preventDefault === 'function') e.preventDefault();
        close();
    }

    function open(x, y, items) {
        close();
        const m = document.createElement('div');
        m.className = 'tline-menu';
        m.style.position = 'fixed';
        m.style.zIndex = '9999';
        m.style.display = 'flex';
        m.style.flexDirection = 'column';
        m.style.minWidth = '132px';
        m.style.padding = '2px';
        m.style.background = 'var(--panel-2, #26282d)';
        m.style.border = '1px solid var(--line, #3a3d44)';
        m.style.borderRadius = '4px';

        for (const item of items) {
            const b = document.createElement('button');
            b.type = 'button';
            // 删除这类不可逆项用 danger 配色区分（样式在 panels.css 的 .tline-menu-item.is-danger）
            b.className = item.danger ? 'tline-menu-item is-danger' : 'tline-menu-item';
            b.textContent = item.label;
            b.style.height = '22px';
            b.style.padding = '0 8px';
            b.style.textAlign = 'left';
            if (item.disabled) b.disabled = true;
            b.addEventListener('click', () => {
                close();
                if (typeof item.run === 'function') item.run();
            });
            m.appendChild(b);
        }

        document.body.appendChild(m);
        const rect = typeof m.getBoundingClientRect === 'function' ? m.getBoundingClientRect() : { width: 132, height: 72 };
        const vw = Number(window.innerWidth) || 1200;
        const vh = Number(window.innerHeight) || 800;
        m.style.left = Math.max(2, Math.min(x, vw - rect.width - 4)) + 'px';
        m.style.top = Math.max(2, Math.min(y, vh - rect.height - 4)) + 'px';

        menu = { el: m };
        document.addEventListener('pointerdown', onMenuOutside, true);
        document.addEventListener('keydown', onMenuKey, true);
    }

    return { open, close };
}

/* ─────────────────────────── 关键帧交互 ─────────────────────────── */

/**
 * Del 键的归属判定（纯函数，两条删除路径的单测都从这里取判据）。
 *
 * 选中了关键帧 → `'keys'`：外壳必须**完全让路**（不设两段式确认、不提示、不删对象）。
 * 否则一次按键会做两件事 —— 第一下删掉关键帧同时提示「再按一次 Del 删除对象」，
 * 第二下把对象也删了（用户只是想把那颗多余的关键帧去掉）。
 * 没有选中关键帧 → `'shell'`：走原来的纹理 / 对象删除，行为与历史一致。
 *
 * @param {number} selectedCount 选中集合里的处数
 * @returns {'keys'|'shell'}
 */
export function deleteTarget(selectedCount) {
    return Number(selectedCount) > 0 ? 'keys' : 'shell';
}

/**
 * 通道关键帧节点的点击参数。
 *
 * `dataset.ch` 是空格分隔的字段名（`rotate` / `scaleX` …），因为同一个时刻的多条
 * 通道关键帧在图上是**一颗**菱形（`timeline-paint.mjs` 的 `channelKeyTimes` 合并的）。
 * 点它只能切到其中一条，所以约定「切第一个」并把总数带出去，让提示文案说清楚。
 *
 * 抽成纯函数是为了能单测「点这一颗会切到哪条通道」，不必造 DOM。
 *
 * @param {{dataset?: {ch?: string}}} node
 * @returns {{ch: string, count: number}} 没有标识时 `{ ch: '', count: 0 }`
 */
export function channelClickOf(node) {
    const raw = node && node.dataset && node.dataset.ch ? String(node.dataset.ch) : '';
    const fields = raw.split(' ').filter(Boolean);
    return { ch: fields.length ? fields[0] : '', count: fields.length };
}

/**
 * deps：{ notify, has, call, notWired, docNow, timeNow, setActive, keepTime, paint, zoomOf, menu, rowsEl }
 * rowsEl() 只在框选与整组预览时用（要量菱形节点的矩形、要拿滚动量）。
 * 关键帧的选择集合只活在本模块里，主文件通过 selection() / selectionAll() 取。
 */
export function createKeys(deps) {
    let kfDrag = null;
    let selKeys = []; // Array<{ layerId, t }>：选中集合，末位是主键（右键菜单、复制、单选读数都用它）
    let selAnchor = null; // { layerId, t }：Shift 区间选择的锚点
    /**
     * 刚点过的那颗「通道关键帧」：{ layerId, t, ch }。
     *
     * 它**不进选中集合**（选择集合代表 track.keys，通道键不在里面，进去了 Del 会
     * 删错东西），但也不能当作没点过——用户点完紧接着按 Del，如果落到「删对象」上，
     * 一个想查看曲线的人会丢掉整个对象。所以这里记一个「软焦点」：下一次 Del 由时间轴
     * 接管，什么都不删，只提示去曲线区编辑；任何别的点击都会把它清掉。
     */
    let channelClick = null;
    let marquee = null; // 框选进行中的状态；松手即清空
    let clip = null; // 复制过的关键帧组：{ from, t, keys: [{ state, ease }] }

    /* ── 选择集合：多选后每个「动一下就是一条撤销记录」的操作都必须先收敛成集合，
       否则一次框选删除会写 N 次文档。 ── */

    /** 主键：集合末位。空集合返回 null —— 旧调用点拿它当「选中的那颗」用。 */
    function primary() {
        return selKeys.length ? selKeys[selKeys.length - 1] : null;
    }

    function isSelected(layerId, t) {
        return selKeys.some((k) => k.layerId === layerId && Math.abs(k.t - t) <= T_EPS);
    }

    /** 单选：任何一次普通点击都从「只有它」重新开始，锚点也跟过去。 */
    function setSingle(layerId, t) {
        selKeys = [{ layerId, t }];
        selAnchor = { layerId, t };
    }

    /** 把已选中的那颗提升为主键，而不是缩成单选：整组一起拖是常见的下一步动作。 */
    function promote(layerId, t) {
        selKeys = selKeys
            .filter((k) => !(k.layerId === layerId && Math.abs(k.t - t) <= T_EPS))
            .concat([{ layerId, t }]);
        selAnchor = { layerId, t };
    }

    function toggleAt(layerId, t) {
        if (isSelected(layerId, t)) selKeys = selKeys.filter((k) => !(k.layerId === layerId && Math.abs(k.t - t) <= T_EPS));
        else selKeys = selKeys.concat([{ layerId, t }]);
        selAnchor = { layerId, t };
    }

    /** 清空：没有选中就别重绘，paint 会打断用户正在输入的框。 */
    function clearSelection() {
        channelClick = null;
        if (!selKeys.length && selAnchor === null) return;
        selKeys = [];
        selAnchor = null;
        deps.paint();
    }

    /** Shift+单击：锚点到本键之间（同对象内按时间顺序）的同刻组全选上。 */
    function selectRange(layerId, t) {
        const doc = deps.docNow();
        const obj = doc ? objectById(doc, layerId) : null;
        const anchor = selAnchor && selAnchor.layerId === layerId ? selAnchor.t : null;
        if (!obj || anchor === null) {
            setSingle(layerId, t);
            return;
        }
        const lo = Math.min(anchor, t) - T_EPS;
        const hi = Math.max(anchor, t) + T_EPS;
        // 用同刻组的时间而不是原始键时间：多通道同刻只画一颗菱形，
        // 选到键却看不到菱形被选中，用户会以为漏选。
        const times = keyGroups(trackOf(obj).keys)
            .map((g) => g.t)
            .filter((x) => x >= lo && x <= hi);
        selKeys = times.length ? times.map((x) => ({ layerId, t: x })) : [{ layerId, t }];
        selAnchor = { layerId, t };
    }

    /** 集合签名：用来判断「框选扫过的命中集合有没有变」，变了才重绘。 */
    function keysSig(list) {
        return list
            .map((k) => k.layerId + '@' + k.t.toFixed(6))
            .sort()
            .join('|');
    }

    /**
     * 批量写文档：一次操作只调一次 setDoc。
     * apply(obj, times) 返回 { obj, hit, merged }；多层用 patchObject 逐层刷新同一个 doc。
     * 这样「框选删除 12 颗」在撤销栈里也只有一步。
     */
    function writeMany(pairs, apply) {
        const result = { hit: 0, merged: 0 };
        if (!pairs || !pairs.length) return result;
        if (!deps.has('setDoc')) {
            deps.notWired('setDoc');
            return result;
        }
        const byLayer = new Map();
        for (const p of pairs) {
            if (!p || !p.layerId || !Number.isFinite(p.t)) continue;
            if (!byLayer.has(p.layerId)) byLayer.set(p.layerId, []);
            byLayer.get(p.layerId).push(p.t);
        }
        if (!byLayer.size) return result;
        deps.call('setDoc', [
            (d) => {
                let out = d;
                for (const [layerId, times] of byLayer) {
                    out = patchObject(out, layerId, (o) => {
                        const r = apply(o, times);
                        if (!r || !r.obj || r.obj === o) return o;
                        result.hit += r.hit || 0;
                        result.merged += r.merged || 0;
                        return r.obj;
                    });
                }
                return out;
            },
        ]);
        return result;
    }

    /* ── 关键帧文档写入（与 v5 行为一致：同刻只留一个） ── */

    /**
     * 在时间 t 给该对象打一个变换关键帧，值取 stateAt(track, t)。
     * 取「当前求值」而不是界面控件值：打点前后画面完全一样，不会跳。
     * 返回 1 = 新增；0 = 该时刻已有关键帧（只选中，不重复打）。
     */
    function addKeyAt(layerId, t) {
        const doc = deps.docNow();
        const raw = Number(t);
        if (!doc || !layerId || !Number.isFinite(raw)) return 0;
        if (!deps.has('setDoc')) {
            deps.notWired('setDoc');
            return 0;
        }
        const at = clampNum(raw, 0, docDuration(doc));
        const keep = deps.timeNow();
        let added = 0;
        let existed = false;
        deps.call('setDoc', [
            (d) =>
                patchObject(d, layerId, (o) => {
                    const track = trackOf(o);
                    // 同一时刻只留一颗菱形：已经有就只选中它
                    if (keyGroups(track.keys).some((g) => Math.abs(g.t - at) <= T_EPS)) {
                        existed = true;
                        return o;
                    }
                    const next = addKey(track, at, stateAt(track, at), 'linear');
                    added = next.keys.length - track.keys.length;
                    return setTransform(o, next);
                }),
        ]);
        deps.keepTime(keep);
        if (added > 0 || existed) setSingle(layerId, at);
        if (existed) deps.notify('该时刻已有关键帧（已选中）');
        else if (added > 0) deps.notify('在 ' + fmt2(at) + ' s 打上关键帧');
        deps.paint();
        return added;
    }

    /** 复制时间 t 处的关键帧组（多通道一起走），粘贴时整组还原。 */
    function copyKeyAt(layerId, t) {
        const doc = deps.docNow();
        const obj = doc ? objectById(doc, layerId) : null;
        if (!obj) return 0;
        const track = trackOf(obj);
        const g = keyGroups(track.keys).find((x) => Math.abs(x.t - t) <= T_EPS);
        if (!g) {
            deps.notify('这里没有关键帧可复制');
            return 0;
        }
        // addKey 内部会 normState 深拷贝（含 warp），所以这里浅拷贝够用
        clip = {
            from: layerId,
            t: g.t,
            keys: g.idx.map((i) => ({ state: { ...track.keys[i].state }, ease: track.keys[i].ease })),
        };
        deps.notify('已复制 ' + fmt2(g.t) + ' s 的关键帧（' + clip.keys.length + ' 个通道）');
        return clip.keys.length;
    }

    /** 把复制下来的关键帧整组写到时间 t；落在已有键上视为覆盖。 */
    function pasteKeyAt(layerId, t) {
        const doc = deps.docNow();
        const raw = Number(t);
        if (!doc || !layerId || !Number.isFinite(raw)) return 0;
        if (!clip || !clip.keys.length) {
            deps.notify('先在一个关键帧上右键「复制关键帧」');
            return 0;
        }
        if (!deps.has('setDoc')) {
            deps.notWired('setDoc');
            return 0;
        }
        const at = clampNum(raw, 0, docDuration(doc));
        const keep = deps.timeNow();
        let written = 0;
        deps.call('setDoc', [
            (d) =>
                patchObject(d, layerId, (o) => {
                    let track = trackOf(o);
                    const g = keyGroups(track.keys).find((x) => Math.abs(x.t - at) <= T_EPS);
                    if (g) {
                        // 倒序删，避免删一个就顶掉后面下标
                        for (const i of g.idx.slice().sort((a, b) => b - a)) track = removeKey(track, i);
                    }
                    for (const k of clip.keys) track = addKey(track, at, k.state, k.ease);
                    written = track.keys.filter((k) => Math.abs(k.t - at) <= T_EPS).length;
                    return setTransform(o, track);
                }),
        ]);
        deps.keepTime(keep);
        if (written > 0) setSingle(layerId, at);
        deps.notify('已在 ' + fmt2(at) + ' s 粘贴关键帧');
        deps.paint();
        return written;
    }

    /**
     * 整组搬时间：集合里每一组都加上同一个 dt，一次 setDoc 提交。
     * 搬运顺序按方向排：dt>0 先搬右边的，dt<0 先搬左边的，
     * 否则搬到一半的中间态可能压在还没搬的键上，白白触发「撞键合并」。
     */
    function moveKeys(pairs, dt) {
        const step = Number(dt);
        if (!pairs || !pairs.length || !Number.isFinite(step) || Math.abs(step) <= T_EPS) {
            return { moved: 0, merged: 0, skipped: 0 };
        }
        const r = writeMany(pairs, (o, times) => {
            let next = trackOf(o);
            const before = next.keys.length;
            let moved = 0;
            let skipped = 0;
            const order = times.slice().sort((a, b) => (step > 0 ? b - a : a - b));
            for (const from of order) {
                // 同刻多个通道合成一个菱形：拖动时整组一起搬。
                // moveKey 会重排数组，所以每搬一个都要重新取组，不能用旧索引。
                // 目标时刻已经被「别的」同刻组占着就整组跳过：覆盖别人的键等于丢数据，
                // 而且用户从画面上看不出来——所以显式跳过并回报数量。
                const target = from + step;
                const blocked = keyGroups(next.keys).some(
                    (x) => Math.abs(x.t - target) <= T_EPS && Math.abs(x.t - from) > T_EPS
                );
                if (blocked) {
                    skipped += 1;
                    continue;
                }
                let guard = 0;
                let g = keyGroups(next.keys).find((x) => Math.abs(x.t - from) <= T_EPS);
                while (g && guard < 16) {
                    next = moveKey(next, g.idx[g.idx.length - 1], target);
                    guard += 1;
                    g = keyGroups(next.keys).find((x) => Math.abs(x.t - from) <= T_EPS);
                }
                if (guard) moved += 1;
            }
            if (!moved) return { obj: o, hit: 0, skip: skipped };
            // moveKey 撞时间时以被拖动的那颗为准，组数变少就说明有合并
            return {
                obj: setTransform(o, next),
                hit: moved,
                merged: next.keys.length < before ? 1 : 0,
                skip: skipped,
            };
        });
        // writeMany 的计数叫 hit；这里换成「搬了几组」，调用方读的是 moved
        return { moved: r.hit, merged: r.merged, skipped: r.skip || 0 };
    }

    /** 删除这些时刻的关键帧（同刻组整组删），一次 setDoc。返回删掉的组数。 */
    function deleteKeys(pairs) {
        const keep = deps.timeNow();
        const r = writeMany(pairs, (o, times) => {
            let next = trackOf(o);
            let hit = 0;
            // 从晚到早删：removeKey 会把后面的下标顶前一位，倒序才不会漏删
            for (const t of times.slice().sort((a, b) => b - a)) {
                const g = keyGroups(next.keys).find((x) => Math.abs(x.t - t) <= T_EPS);
                if (!g) continue;
                for (const i of g.idx.slice().sort((a, b) => b - a)) next = removeKey(next, i);
                hit += 1;
            }
            return { obj: hit ? setTransform(o, next) : o, hit };
        });
        deps.keepTime(keep);
        return r.hit;
    }

    function deleteKeyAt(layerId, t) {
        const removed = deleteKeys([{ layerId, t }]);
        // 拼错的那颗已经从文档里没了，集合里留着也没意义
        if (removed) selKeys = selKeys.filter((k) => !(k.layerId === layerId && Math.abs(k.t - t) <= T_EPS));
        if (removed) deps.notify('已删除关键帧 t = ' + fmt2(t) + ' s');
        return removed;
    }

    /** 删除当前选中集合（Delete 键 / 右键菜单）；一次 setDoc、一步撤销。 */
    function deleteSelection() {
        channelClick = null;
        const pairs = selKeys.slice();
        if (!pairs.length) return 0;
        const removed = deleteKeys(pairs);
        selKeys = [];
        selAnchor = null;
        // 集合里留着已不存在的时间（别处改过文档）时别静默失败，否则用户以为按键没生效
        if (!removed) deps.notify('选中的关键帧已不在文档里，可能已被别处改动');
        else deps.notify('已删除 ' + removed + ' 个关键帧');
        deps.paint();
        return removed;
    }

    /**
     * 批量设置选中集合（外部同步 / 单测用）。传空数组等于清空。
     * 内部所有选择路径最后都落到 selKeys + selAnchor 两个变量上，公开一个入口
     * 是为了让「选了哪些、删了哪些」能被单测钉住，而不必去造 pointer 事件。
     */
    function selectKeys(pairs) {
        channelClick = null;
        const list = Array.isArray(pairs)
            ? pairs.filter((p) => p && p.layerId && Number.isFinite(Number(p.t)))
            : [];
        selKeys = list.map((p) => ({ layerId: String(p.layerId), t: Number(p.t) }));
        selAnchor = selKeys.length ? { layerId: selKeys[selKeys.length - 1].layerId, t: selKeys[selKeys.length - 1].t } : null;
        return selKeys.length;
    }

    /**
     * 外壳按 Del 时先问一句「这批归你吗」：派发 `ms:delete-keys`，由本模块
     * 按 deleteTarget 的判据决定「删掉并接管」还是「什么都不做、让外壳走原逻辑」。
     * 这样外壳不需要复制一份「选了什么」的状态（判据只有一处：selKeys）。
     */
    function onDeleteKeysEvent(e) {
        const detail = e && e.detail;
        if (!detail || typeof detail !== 'object') return;
        // 焦点在输入框 / 按钮上时让路：外壳把 typing 判定一起送过来了。
        // 这一道不能省 —— 外壳的 isTypingTarget 检查排在 onKeyDown 靠后，
        // 没有它就能隔着「对象名字」输入框按 Del 删掉屏幕上看不见的关键帧。
        if (detail.typing) {
            detail.count = 0;
            detail.handled = false;
            return;
        }
        const asked = selKeys.length;
        if (!asked) {
            // 刚点过通道键：通道键不在 track.keys 里，删不动它；如果这时候让路，
            // Del 就会落到「删纹理 / 删对象」上——一个只想看曲线的人会丢掉整个对象。
            // 所以接管这一刻但什么都不删，把人指到曲线区。
            if (channelClick) {
                deps.notify('通道关键帧不在这里删 · ' + channelClick.ch + ' · 到曲线区编辑');
                channelClick = null;
                detail.count = 0;
                detail.handled = true;
                return;
            }
            detail.count = 0;
            detail.handled = false;
            return;
        }
        const removed = deleteSelection();
        detail.count = removed;
        // 归属按「问的时候有没有选中」定，不按删成功的数量：
        // 选中的键已被别处改掉时删不出东西，但 Del 仍不该落到对象上。
        detail.handled = deleteTarget(asked) === 'keys';
    }

    /** 对集合批量改缓动，一次 setDoc。返回命中的组数。 */
    function applyEaseKeys(pairs, ease) {
        const keep = deps.timeNow();
        const r = writeMany(pairs, (o, times) => {
            let next = trackOf(o);
            let hit = 0;
            for (const t of times) {
                const g = keyGroups(next.keys).find((x) => Math.abs(x.t - t) <= T_EPS);
                if (!g) continue;
                // setKeyEase 保持数组长度与顺序，组内下标在循环里仍然有效
                for (const i of g.idx) next = setKeyEase(next, i, ease);
                hit += 1;
            }
            return { obj: hit ? setTransform(o, next) : o, hit };
        });
        deps.keepTime(keep);
        return r.hit;
    }

    function applyEaseAt(layerId, t, ease) {
        const hit = applyEaseKeys([{ layerId, t }], ease);
        if (hit) deps.notify('关键帧缓动：' + (EASE_TEXT[ease] || ease));
        return hit;
    }

    function applyEaseSelection(ease) {
        const pairs = selKeys.slice();
        if (!pairs.length) return 0;
        const hit = applyEaseKeys(pairs, ease);
        if (hit) {
            deps.notify(
                (hit > 1 ? hit + ' 处关键帧缓动：' : '关键帧缓动：') + (EASE_TEXT[ease] || ease)
            );
        } else {
            deps.notify('选中的关键帧已不在文档里，可能已被别处改动');
        }
        deps.paint();
        return hit;
    }

    /* ── 关键帧拖动（v8：拖拽只预览，松手才写文档 → 一步撤销） ──
       旧行为每 pointermove 就 setDoc 一次，拖 200 像素会塞 200 条撤销记录，
       按 Ctrl+Z 要按到手抽筋。现在拖动只挪那颗菱形，落点在 pointerup 提交。 */

    function detachKfDrag() {
        document.removeEventListener('pointermove', onKfMove);
        document.removeEventListener('pointerup', onKfUp);
        document.removeEventListener('pointercancel', onKfUp);
    }

    /** 选中集合对应的菱形节点：整组预览时一起挪，但仍然只挪 DOM。 */
    function selectedNodes() {
        const host = typeof deps.rowsEl === 'function' ? deps.rowsEl() : null;
        const out = [];
        if (!host || typeof host.querySelectorAll !== 'function') return out;
        for (const n of host.querySelectorAll('.tline-kf') || []) {
            if (!n || !n.dataset) continue;
            // 通道独立轨道的键不在 track.keys 里，批量删/改缓动够不着它，别混进集合
            if (n.classList && n.classList.contains('is-ch')) continue;
            const lt = Number(n.dataset.t);
            if (!Number.isFinite(lt)) continue;
            if (isSelected(n.dataset.layer, lt)) out.push({ node: n, t0: lt });
        }
        return out;
    }

    function kfDown(e, node) {
        const doc = deps.docNow();
        if (!doc) return;
        if (e.button !== undefined && e.button !== 0) return;
        const t = Number(node.dataset.t);
        const layerId = node.dataset.layer;
        if (!Number.isFinite(t) || !layerId) return;
        // 通道独立轨道的键：选中它也删不掉、改不了缓动（不在 track.keys 里），
        // 选中了却什么都不能做比不选更让人困惑，所以不参与选择、不参与拖动。
        // 但「点了完全没反应」同样让人困惑：派一个事件，让曲线把焦点切到这颗键
        // 对应的通道并跳到该刻（见 editors/curve.mjs 的 onChannelKeyClick）。
        if (node.classList && node.classList.contains('is-ch')) {
            if (typeof e.preventDefault === 'function') e.preventDefault();
            if (typeof e.stopPropagation === 'function') e.stopPropagation();
            const ch = channelClickOf(node);
            channelClick = { layerId, t, ch: ch.ch };
            const detail = { layerId, t, ch: ch.ch, count: ch.count };
            // 没有监听者时什么都不发生（与 ms:copy-keys 同一约定）
            if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
                document.dispatchEvent(new CustomEvent('ms:channel-key-click', { detail }));
            }
            return;
        }
        channelClick = null;
        if (typeof e.preventDefault === 'function') e.preventDefault();
        if (typeof e.stopPropagation === 'function') e.stopPropagation();

        deps.menu.close();

        if (e.ctrlKey || e.metaKey) toggleAt(layerId, t);
        else if (e.shiftKey) selectRange(layerId, t);
        else if (isSelected(layerId, t)) promote(layerId, t);
        else setSingle(layerId, t);

        deps.setActive(layerId);
        if (!selKeys.length) {
            deps.paint(); // Ctrl+单击把自己的选中项减光了：没有可拖的东西
            return;
        }

        kfDrag = {
            layerId,
            t,
            t0: t,
            dt: 0,
            x0: e.clientX,
            pps: pxPerSecond(doc, deps.zoomOf()),
            keep: deps.timeNow(),
            moved: false,
            node,
            // 快照：拖动过程中集合可能被别处改（重绘/外部刷新），而「松手提交哪些」必须是按下时那一批
            sel: selKeys.map((k) => ({ layerId: k.layerId, t: k.t })),
            nodes: selectedNodes(),
        };
        if (node.classList) node.classList.add('is-drag');
        document.addEventListener('pointermove', onKfMove);
        document.addEventListener('pointerup', onKfUp);
        document.addEventListener('pointercancel', onKfUp);
        deps.paint();
    }

    function onKfMove(e) {
        if (!kfDrag) return;
        const doc = deps.docNow();
        if (!doc) return;
        const total = docDuration(doc);
        const pps = kfDrag.pps > 0 ? kfDrag.pps : pxPerSecond(doc, deps.zoomOf());
        let t = clampNum(kfDrag.t0 + (e.clientX - kfDrag.x0) / pps, 0, total);
        // 吸附规则（与工具条磁铁一致）：开着且没按 Shift → 吸整帧；关着且按 Shift → 吸 0.1 s 网格
        const magnet = e.shiftKey ? (snapOnNow() ? 'off' : 'grid') : (snapOnNow() ? 'frame' : 'off');
        if (magnet === 'frame') t = clampNum(snapFrame(doc, t), 0, total);
        else if (magnet === 'grid') t = clampNum(snapGrid(t, snapGridNow()), 0, total);
        if (Math.abs(e.clientX - kfDrag.x0) > 0.5) kfDrag.moved = true;

        // 整组共用同一个位移量，所以夹的是位移量：任何一颗都不该被推出 [0, 总时长]。
        // 夹位移而不是逐颗夹时间，才不会把同一时刻的通道组扯散。
        let dt = t - kfDrag.t0;
        const ts = kfDrag.sel.map((k) => k.t);
        const lo = Math.min(0, -Math.min(...ts));
        const hi = Math.max(0, total - Math.max(...ts));
        dt = clampNum(dt, lo, hi);
        if (Math.abs(dt - kfDrag.dt) < 1e-9) return;
        kfDrag.dt = dt;

        // 只挪 DOM，不碰文档（文档留到 onKfUp 一次写完）
        for (const it of kfDrag.nodes) {
            const n = it.node;
            if (!n || !n.style) continue;
            const nt = it.t0 + dt;
            n.style.left = kfLeft(doc, nt, deps.zoomOf()).toFixed(2) + 'px';
            n.dataset.preview = fmt2(nt);
            n.title = '关键帧 ' + fmt2(nt) + ' s · 松手后生效';
        }
    }

    function onKfUp() {
        detachKfDrag();
        const d = kfDrag;
        kfDrag = null;
        if (!d) return;
        if (d.node && d.node.classList) d.node.classList.toggle('is-drag', false);
        const dt = Number(d.dt) || 0;
        if (d.moved && Math.abs(dt) > T_EPS) {
            const r = moveKeys(d.sel, dt);
            if (r.merged) deps.notify('两个关键帧落到同一时间，保留被拖动的那个');
            if (r.moved) {
                // 集合跟着走：刚搬过的那批仍然选着，方便接着微调或删除
                selKeys = d.sel.map((k) => ({ layerId: k.layerId, t: k.t + dt }));
                selAnchor = { layerId: d.layerId, t: d.t0 + dt };
                deps.notify(
                    r.moved > 1
                        ? '已移动 ' + r.moved + ' 处关键帧'
                        : '关键帧移到 t = ' + (d.t0 + dt).toFixed(3) + ' s'
                );
            }
        }
        deps.keepTime(d.keep);
        deps.paint();
    }

    /* ── 框选 ──
       空白的 pointerdown 起一次「可能的框选」：不拖就是点空白 → 顺带清空选择
       （旧版不清，用户去别处点一下再按 Delete，会删掉自己没在看着的远处关键帧）；
       拖出矩形才进选择流程。全程只画 DOM 矩形，不写文档 → 不产生撤销记录。 */

    function detachMarquee() {
        document.removeEventListener('pointermove', onMarqueeMove);
        document.removeEventListener('pointerup', onMarqueeUp);
        document.removeEventListener('pointercancel', onMarqueeUp);
    }

    /** 矩形按需创建：行区每次结构重建都会清掉非常驻子节点，所以不能提前挂在里面。 */
    function makeMarqueeEl(host) {
        const el = document.createElement('div');
        el.className = 'tline-marquee';
        el.style.position = 'absolute';
        el.style.pointerEvents = 'none';
        el.style.zIndex = '3';
        // 几何必须内联（位置每帧都变）；配色走 CSS 变量，主线改风格不用碰这里的代码
        el.style.border = '1px solid var(--tline-marquee-line, rgba(74, 125, 255, 0.9))';
        el.style.background = 'var(--tline-marquee-fill, rgba(74, 125, 255, 0.14))';
        el.style.display = 'none';
        host.appendChild(el);
        return el;
    }

    /** 矩形内的关键帧：用 DOM 矩形求交，和用户眼睛看到的范围一致（缩放/滚动都自然跟上）。 */
    function marqueeHits(host, box) {
        const out = [];
        if (!host || typeof host.querySelectorAll !== 'function') return out;
        for (const n of host.querySelectorAll('.tline-kf') || []) {
            if (!n || !n.dataset) continue;
            if (n.classList && n.classList.contains('is-ch')) continue;
            const lt = Number(n.dataset.t);
            const lid = n.dataset.layer;
            if (!Number.isFinite(lt) || !lid) continue;
            const r = typeof n.getBoundingClientRect === 'function' ? n.getBoundingClientRect() : null;
            if (!r) continue;
            // 相交即命中（不要求整颗在框里）：菱形旋转后外接盒偏小，留 2px 容差补手感
            if (r.right < box.left - 2 || r.left > box.right + 2) continue;
            if (r.bottom < box.top - 2 || r.top > box.bottom + 2) continue;
            if (!out.some((k) => k.layerId === lid && Math.abs(k.t - lt) <= T_EPS)) out.push({ layerId: lid, t: lt });
        }
        return out;
    }

    function onMarqueeMove(e) {
        if (!marquee) return;
        const dx = e.clientX - marquee.x0;
        const dy = e.clientY - marquee.y0;
        // 3px 以内算点击不算框选：手抖的人不该因此改掉选择
        if (!marquee.moved) {
            if (Math.abs(dx) < 3 && Math.abs(dy) < 3) return;
            marquee.moved = true;
        }
        const host = marquee.host;
        if (!host) return;
        const rect = marquee.rect;
        const x1 = Math.min(marquee.x0, e.clientX);
        const y1 = Math.min(marquee.y0, e.clientY);
        const w = Math.abs(dx);
        const h = Math.abs(dy);
        const el = marquee.el || (marquee.el = makeMarqueeEl(host));
        // 行区是滚动容器：矩形挂在它的内容坐标系里，所以要加回滚动量
        const sx = Number(host.scrollLeft) || 0;
        const sy = Number(host.scrollTop) || 0;
        el.style.left = (x1 - rect.left + sx).toFixed(1) + 'px';
        el.style.top = (y1 - rect.top + sy).toFixed(1) + 'px';
        el.style.width = w.toFixed(1) + 'px';
        el.style.height = h.toFixed(1) + 'px';
        el.style.display = 'block';

        const hits = marqueeHits(host, { left: x1, right: x1 + w, top: y1, bottom: y1 + h });
        const next = marquee.base.length ? marquee.base.concat(hits) : hits;
        const dedup = next.filter((k, i) => next.findIndex((x) => x.layerId === k.layerId && Math.abs(x.t - k.t) <= T_EPS) === i);
        if (keysSig(dedup) === keysSig(selKeys)) return; // 集合没变就别重绘
        selKeys = dedup;
        deps.paint();
    }

    function onMarqueeUp() {
        const m = marquee;
        marquee = null;
        detachMarquee();
        if (!m) return;
        if (m.el && m.el.parentNode && typeof m.el.parentNode.removeChild === 'function') m.el.parentNode.removeChild(m.el);
        if (!m.moved) return;
        deps.notify(selKeys.length ? '已框选 ' + selKeys.length + ' 个关键帧' : '框选范围内没有关键帧');
        deps.paint();
    }

    /**
     * 空白处按下：进入「可能是框选」的状态。
     * timeline.mjs 在泳道空白与行区底部都会调它 —— 那块地方除了框选没有别的用途。
     */
    function marqueeDown(e) {
        if (e.button !== undefined && e.button !== 0) return;
        const host = typeof deps.rowsEl === 'function' ? deps.rowsEl() : null;
        if (!host) return;
        detachMarquee();
        const rect = typeof host.getBoundingClientRect === 'function' ? host.getBoundingClientRect() : { left: 0, top: 0 };
        marquee = {
            host,
            rect: { left: Number(rect.left) || 0, top: Number(rect.top) || 0 },
            x0: e.clientX,
            y0: e.clientY,
            moved: false,
            el: null,
            // Shift 框选是「追加」，所以要先记住起点集合；不按 Shift 就从空集重新数
            base: e.shiftKey ? selKeys.slice() : [],
        };
        if (!e.shiftKey && selKeys.length) {
            selKeys = [];
            selAnchor = null;
            deps.paint();
        }
        document.addEventListener('pointermove', onMarqueeMove);
        document.addEventListener('pointerup', onMarqueeUp);
        document.addEventListener('pointercancel', onMarqueeUp);
    }

    /* ── 右键菜单 ── */

    /** 关键帧上右键：保留三档缓动，补上复制 / 粘贴 / 删除（删除原本只有双击与 Delete 键）。 */
    function contextMenu(x, y, layerId, t) {
        // 右键落在选中集合里 → 菜单对整个集合生效；落在别处 → 先把选择改成这一颗
        if (isSelected(layerId, t)) promote(layerId, t);
        else setSingle(layerId, t);
        const many = selKeys.length > 1;
        const items = EASES.map(([ease, text]) => ({ label: text, run: () => applyEaseSelection(ease) }));
        items.push({ label: '复制关键帧', run: () => copyKeyAt(layerId, t) });
        items.push({ label: '粘贴到此处', disabled: !clip, run: () => pasteKeyAt(layerId, t) });
        items.push({
            label: many ? '删除选中的 ' + selKeys.length + ' 个关键帧' : '删除关键帧',
            danger: true,
            run: () => deleteSelection(),
        });
        deps.menu.open(x, y, items);
        deps.paint(); // 让 .is-sel 立刻亮起来，不然右键后看不出选中了哪颗
    }

    /**
     * 泳道空白处右键：这是「在时间轴上直接新增关键帧」的第二个入口。
     * 「在此加纹理」顺带当了纹理的教学入口 —— 纹理的语义就是「从这一刻起换图」。
     */
    function laneMenu(x, y, layerId, t) {
        // 在空白处开菜单等于「换个位置操作」，旧选择跟着作废，否则 Delete 还会删远处那批
        selKeys = [];
        selAnchor = null;
        const addCel =
            typeof deps.addCel === 'function' ? deps.addCel : () => deps.notWired('addCelAt');
        deps.menu.open(x, y, [
            { label: '在此打关键帧', run: () => addKeyAt(layerId, t) },
            { label: '粘贴关键帧到此处', disabled: !clip, run: () => pasteKeyAt(layerId, t) },
            { label: '在此加纹理（从此刻起换图）', run: () => addCel(layerId, t) },
        ]);
    }

    /* ── 外壳派发的复制 / 粘贴（Ctrl+C / Ctrl+V）──
       没选中关键帧时 onCopyEvent 直接返回：让浏览器照常复制文本，
       否则用户在别处选字按 Ctrl+C 会被时间轴吞掉。 */

    function onCopyEvent() {
        const one = primary();
        if (!one) return;
        copyKeyAt(one.layerId, one.t);
    }

    function onPasteEvent(e) {
        if (!clip) {
            deps.notify('先复制一个关键帧（Ctrl+C）');
            return;
        }
        const detail = e && e.detail ? e.detail : null;
        const layerId = (detail && detail.layerId) || deps.activeId();
        if (!layerId) {
            deps.notify('先选一个对象');
            return;
        }
        const t = detail && Number.isFinite(Number(detail.t)) ? Number(detail.t) : deps.timeNow();
        pasteKeyAt(layerId, t);
    }

    return {
        kfDown,
        marqueeDown,
        addKeyAt,
        copyKeyAt,
        pasteKeyAt,
        deleteKeyAt,
        deleteSelection,
        selectKeys,
        applyEaseAt,
        applyEaseSelection,
        clearSelection,
        contextMenu,
        laneMenu,
        onDeleteKeysEvent,
        onCopyEvent,
        onPasteEvent,
        // 旧读数：只给「选中的那一颗」（集合末位），老调用点语义不变
        selection: () => primary(),
        getSelKey: () => primary(),
        // 新读数：整个集合（paint 用它区分主键与跟随键）
        selectionAll: () => selKeys.map((k) => ({ layerId: k.layerId, t: k.t })),
        destroy() {
            detachKfDrag();
            detachMarquee();
            if (marquee && marquee.el && marquee.el.parentNode && typeof marquee.el.parentNode.removeChild === 'function') {
                marquee.el.parentNode.removeChild(marquee.el);
            }
            marquee = null;
            kfDrag = null;
            selKeys = [];
            selAnchor = null;
            clip = null;
        },
    };
}
