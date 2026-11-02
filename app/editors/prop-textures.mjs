// 纹理属性组 —— 属性面板里「当前对象、当前时刻那一张纹理」的唯一入口。
//
// 契约：docs/层级与叠放-2026-10.md §5（面板分组）/ §6（纹理四件事 + 画布尺寸）。
// 位置：.prop-body[data-k="textures"]，由 properties.mjs 排在「对象」之后、「变换」之前。
//
// 边界：UI 不改文档 —— 四个动作与尺寸重设全部走 ctx（newDrawing / placeDrawing /
// makeUniqueCel / removeDrawing / resizeTexture），写操作由 ctx 的单一写者 setDoc 落地，
// 所以每条动作天生就是一条撤销。只读查询走 core/textures.mjs，本文件不认识
// cels / drawings 的内部形状。顶层 DOM-free：动作表、文案、尺寸解析都是纯函数，
// tests/prop-textures.test.mjs 直接 import 它们，不需要 DOM 桩。

import { icon } from '../core/icons.mjs';
import { drawingsOf } from '../core/doc-model.mjs';
import { textureAt, textureIndexOfTime, textureTimes } from '../core/textures.mjs';
import { activeObj, makeGroup, makeNumPair, makeRow, nowTime } from './prop-kit.mjs';
import { t } from '../i18n/index.mjs';

/**
 * 纹理画布的单边上限。与 shell 侧 `resizeTexture` 的钳制口径（app/shell/app.mjs:859
 * 的 clampTextureSize，1–4096）和 app/paint/trim.mjs:20 的 TEXTURE_MAX 一致；
 * 这里写字面量而不是 import 别人的域，改上限时三处一起改。
 */
export const TEXTURE_SIZE_MAX = 4096;

/**
 * 对齐三档：重设尺寸时旧内容落在新画布的位置。值名与 shell 的 alignOffset 一致；
 * 第二项是**词条键**，取词在渲染处（模块级的表在 import 时就求值了，不能在这里调 t）。
 */
export const TEXTURE_ALIGN = [
    ['nw', 'props.tex.align.nw'],
    ['c', 'props.tex.align.c'],
    ['se', 'props.tex.align.se'],
];

/** 没有纹理时的说明行（空态只说明下一步，不解释概念）。这里是词条键，取词在渲染处。 */
export const EMPTY_TEXTURE_KEY = 'props.tex.empty';

/**
 * 四个动作。图标名必须存在于 core/icons.mjs 的 ICON_NAMES（测试守这一点），
 * 否则真机上是一个空按钮 —— data-icon-missing 只在控制台里喊，用户看不见。
 * `titleKey` 同理是词条键。
 */
export const TEXTURE_ACTIONS = [
    { id: 'new', icon: 'image-plus', titleKey: 'props.tex.action.new' },
    { id: 'unique', icon: 'copy', titleKey: 'props.tex.action.unique' },
    { id: 'delete', icon: 'trash', titleKey: 'props.tex.action.delete' },
    { id: 'trim', icon: 'crop-content', titleKey: 'props.tex.action.trim' },
];

/** 动作的悬停说明（无纹理/无对象时会被「为什么不能点」替换掉）。值同样是词条键。 */
export const ACTION_HINTS = {
    new: 'props.tex.hint.new',
    unique: 'props.tex.hint.unique',
    delete: 'props.tex.hint.delete',
    trim: 'props.tex.hint.trim',
};

/** 「共 N 张 · 当前第 k 张 · 曝光 M 处」里的量：一次算清，DOM 侧只负责排版（key + vars，取词在渲染处）。 */
export function textureSummary(obj, t) {
    const list = obj ? textureTimes(obj) : [];
    const exposures = list.length;
    // 张数按真实资产算，不用 core 的 textureCount：后者在没有资产时回退数 cels，
    // 「一帧还没画过的空纹理」于是被数成 1 张纹理，摘要会假报（真机首跑抓到的）。
    const count = obj ? drawingsOf(obj).length : 0;
    const index = obj ? textureIndexOfTime(obj, t) : -1;
    if (!count) {
        return { count: 0, exposures, index: -1, empty: true, key: EMPTY_TEXTURE_KEY, vars: {} };
    }
    const image = textureAt(obj, t);
    if (!image) {
        // 有纹理但当前时刻没放上去：此刻确实没东西可画，别说「第 k 张」
        return {
            count,
            exposures,
            index: -1,
            empty: true,
            key: 'props.tex.summary.noExposure',
            vars: { count, exposures },
        };
    }
    // index 是 0 起；用户看到的「第 k 张」从 1 起。命中不到时按第 1 张说。
    const k = index < 0 ? 1 : index + 1;
    return {
        count,
        exposures,
        index: k - 1,
        empty: false,
        key: 'props.tex.summary.count',
        vars: { count, k, exposures },
    };
}

/** 像素尺寸归一：非数字/非正数一律按 0（缩略图与行数据用不到负数）。 */
function pixelSize(v) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 纹理抽屉的一行：把「资产 + 曝光」摊平成 DOM 直接可排的字段（DOM-free，node 直测）。
 * 顺序沿用 drawingsOf（首次曝光升序，未使用的排最后）；`current` 与摘要里的「第 k 张」
 * 同口径（textureIndexOfTime；当前时刻没有任何曝光时全 false）。
 *
 * @param {object|null} obj 对象
 * @param {number} now 当前时刻（秒）
 * @returns {{id:string,index:number,width:number,height:number,times:number[],current:boolean,unused:boolean}[]}
 */
export function textureRows(obj, now) {
    const list = obj ? drawingsOf(obj) : [];
    if (!list.length) return [];
    // 先认「这一刻到底有没有图」：空白曝光（drawing:null）或早于第一次曝光时，
    // textureIndexOfTime 仍可能给出一个曝光下标，但那张图并没有显示 → 任何行都不算当前，
    // 与摘要的 empty / noExposure 分支同口径。
    const currentIndex = obj && textureAt(obj, now) ? textureIndexOfTime(obj, now) : -1;
    return list.map((d, i) => {
        const times = Array.isArray(d.times) ? d.times.slice() : [];
        return {
            id: d.id,
            index: i + 1, // 用户看到的序号从 1 起
            width: pixelSize(d.image && d.image.width),
            height: pixelSize(d.image && d.image.height),
            times,
            current: i === currentIndex,
            unused: times.length === 0,
        };
    });
}

/** 秒 → 抽屉里的读数：两位小数（与 xform / 时间轴上的 t=0.00s 同一口径）。 */
export function formatTextureTime(seconds) {
    const v = Number(seconds);
    return Number.isFinite(v) ? v.toFixed(2) : '0.00';
}

/**
 * 一行的「引用」说明：未使用 → 未使用；只一处 → @0.00s；多处 → @0.00s · N 处。
 * 只算 key + vars，取词在渲染处（模块级常量在 import 时就求值，不能在这里调 t）。
 */
export function textureRowRef(row) {
    const times = row && Array.isArray(row.times) ? row.times : [];
    if (!times.length) return { key: 'props.tex.lib.unused', vars: {} };
    const at = formatTextureTime(times[0]);
    if (times.length === 1) return { key: 'props.tex.lib.at', vars: { t: at } };
    return { key: 'props.tex.lib.usesAt', vars: { t: at, n: times.length } };
}

/** 尺寸框单值解析：取整后必须落在 1–TEXTURE_SIZE_MAX，否则 null（调用方给中文提示）。 */
export function parseTextureSize(raw) {
    if (raw == null || raw === '') return null;
    const v = Math.round(Number(raw));
    if (!Number.isFinite(v) || v < 1 || v > TEXTURE_SIZE_MAX) return null;
    return v;
}

/** 尺寸重设的 ctx payload；任一边非法返回 null。非法对齐值退回居中（与 shell 的默认一致）。 */
export function resizePayload(wRaw, hRaw, align) {
    const width = parseTextureSize(wRaw);
    const height = parseTextureSize(hRaw);
    if (width == null || height == null) return null;
    const ok = TEXTURE_ALIGN.some(([val]) => val === align);
    return { mode: 'resize', width, height, align: ok ? align : 'c' };
}

/** 裁到内容的 ctx payload（没有参数：包围盒由 shell 从像素算）。 */
export function trimPayload() {
    return { mode: 'trim' };
}

/**
 * 动作的「为什么现在点了没结果」：返回空串表示可以走正路，否则返回**词条键**（取词在调用处）。
 * 这里只判与文档结构有关的原因；尺寸命令是否接线由尺寸控件自己的 why 负责。
 * 注意：动作按钮**不置灰成不可点**（不可用动作只做视觉置灰、仍可点，让守卫路径报提示
 * —— 这是 layers.mjs:879 立下的原则，同一条规则在这里复用）。
 */
export function actionBlocked(id, state) {
    const hasObj = !!(state && state.hasObj);
    const count = (state && state.count) || 0;
    if (!hasObj) return 'props.tex.block.noObject';
    if (id === 'unique' && !count) return 'props.tex.block.unique';
    if (id === 'delete' && !count) return 'props.tex.block.delete';
    if (id === 'trim' && !count) return 'props.tex.block.trim';
    return '';
}

/**
 * 删除哪一张：未使用的最后一张 → 当前显示那张 → 最后一张。
 * 与 layers.mjs:1147-1183 的候选顺序一致，免得同一份图在面板与图层列表里删的不是同一张。
 */
export function deleteCandidateId(ids, currentId, unusedId) {
    const list = Array.isArray(ids) ? ids.filter((x) => x != null) : [];
    if (!list.length) return null;
    if (unusedId != null && list.indexOf(unusedId) >= 0) return unusedId;
    if (currentId != null && list.indexOf(currentId) >= 0) return currentId;
    return list[list.length - 1];
}

/**
 * 切工作区该找谁：ctx 上有 setWorkspace 就用它（面板被外壳注入了能力时），
 * 否则退回 window.motionStudio.setWorkspace（app.mjs:1361 expose() 铺出去的）。
 * 两条都没有时返回空串 —— 调用方给一条中文提示，绝不做「双击没反应」。
 */
export function workspaceSwitchTarget(ctx) {
    if (ctx && typeof ctx.setWorkspace === 'function') return 'ctx';
    const g = typeof globalThis !== 'undefined' ? globalThis.motionStudio : null;
    if (g && typeof g.setWorkspace === 'function') return 'motionStudio';
    return '';
}

export function mount(el, ctx) {
    // i18n 的 t 容易被局部量（时间 / 事件对象）遮蔽；挂载内部统一走 tr，写时间的地方叫 when/now。
    const tr = t;
    const body = makeGroup(el, tr('props.tex.group'), 'textures');
    const has = (name) => typeof ctx[name] === 'function';
    const say = (msg) => {
        if (typeof ctx.notify === 'function') ctx.notify(msg);
    };

    /* ① 缩略图：40×40，双击进画板。canvas 的 CSS 尺寸由 textures.css 钉死，
       内部分辨率跟 CSS 同尺寸 —— 它是缩略图，不需要 hidpi 重建。 */
    const thumbField = makeRow(body, tr('props.tex.thumb'));
    const thumb = document.createElement('canvas');
    thumb.className = 'ptx-thumb';
    thumb.width = 40;
    thumb.height = 40;
    thumb.title = tr('props.tex.thumbTitle');
    thumbField.appendChild(thumb);

    /* ② 一张 / 第几张 / 几处曝光 —— 三件事在同一行里说清，不拆成三行数值。 */
    const countField = makeRow(body, tr('props.tex.count'));
    const summary = document.createElement('span');
    summary.className = 'ptx-summary';
    summary.textContent = '—';
    countField.appendChild(summary);

    /* ②b 纹理抽屉：摘要只说「第几张」，这里给出「点哪张」。
       行数据由 textureRows 算（DOM-free，test 直测），展开态只活在这个闭包里 ——
       refresh() 只换内容，不重建这个结构，所以开合状态在刷新之间保持。 */
    const libField = makeRow(body, tr('props.tex.lib'));
    const libRow = libField.parentNode;
    libRow.classList.add('ptx-lib-row');
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'prop-seg ptx-toggle';
    toggleBtn.dataset.k = 'ptx-lib-toggle';
    libField.appendChild(toggleBtn);

    const drawer = document.createElement('div');
    drawer.className = 'ptx-drawer';
    drawer.dataset.k = 'ptx-drawer';
    drawer.hidden = true;
    // 此刻后面几行还没 append，挂在「库」行之后就是抽屉的位置
    body.appendChild(drawer);

    let openDrawer = false;
    let drawerSig = '';
    let pendingDelete = null; // 已点过一次删除、等待二次确认的纹理 id
    let confirmTimer = 0; // 确认态 4 秒后自动收回
    const deleteBtns = new Map(); // 纹理 id → 行内删除按钮

    /* ③ 四个动作。图标按钮沿用 .ms-icon-btn 的房子样式，title/aria-label 一律带中文全称。 */
    const actField = makeRow(body, tr('props.tex.actions'));
    const actBtns = new Map();
    for (const act of TEXTURE_ACTIONS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'ms-icon-btn ptx-act';
        b.dataset.act = act.id;
        b.innerHTML = icon(act.icon, { label: tr(act.titleKey) });
        b.title = tr('props.tex.actionTitle', { action: tr(act.titleKey), hint: tr(ACTION_HINTS[act.id]) });
        b.setAttribute('aria-label', tr(act.titleKey));
        actField.appendChild(b);
        actBtns.set(act.id, b);
    }

    /* ④ 画布尺寸两个数字框（1–4096）。宽度用 prop-kit 的等分写法，68px 两个并排会顶出面板。 */
    const sizePair = makeNumPair(body, tr('props.tex.size'), { min: 1, max: TEXTURE_SIZE_MAX, step: 1, key: 'ptx-size' });
    const sizeW = sizePair.w;
    const sizeH = sizePair.h;
    // 审计抓「空值且无 placeholder/aria-label 的输入框」；这两个框天然可能为空（无纹理时）
    sizeW.setAttribute('aria-label', tr('props.tex.widthAria'));
    sizeH.setAttribute('aria-label', tr('props.tex.heightAria'));

    /* ⑤ 尺寸重设 + 对齐三档同一行：44px 标签 + 「应用」按钮 + 三个分段在 292px 面板里放得下
       （行标签叫「重设」、按钮叫「应用」—— v11 前两处都叫「重设」，一行动词重复读着别扭）
       （.prop-row 自带 flex-wrap，真挤了也是换行，不会横向溢出）。 */
    const applyField = makeRow(body, tr('props.tex.resize'));
    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'prop-seg ptx-apply';
    applyBtn.textContent = tr('props.tex.apply');
    applyBtn.title = tr('props.tex.applyTitle');
    applyBtn.setAttribute('aria-label', applyBtn.title);
    applyField.appendChild(applyBtn);
    let align = 'c';
    let syncedSig = '';
    const alignBtns = new Map();
    for (const [val, key] of TEXTURE_ALIGN) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'prop-seg ptx-align';
        b.dataset.val = val;
        b.textContent = tr(key);
        b.title = tr('props.tex.alignTitle', { align: tr(key) });
        b.setAttribute('aria-label', b.title);
        applyField.appendChild(b);
        alignBtns.set(val, b);
    }

    /* ── 取值 ── */

    function targetObj() {
        const doc = typeof ctx.doc === 'function' ? ctx.doc() : null;
        return doc ? activeObj(ctx, doc) : null;
    }

    function currentImage() {
        const obj = targetObj();
        if (!obj) return null;
        const img = textureAt(obj, nowTime(ctx));
        return img && typeof img.getContext === 'function' ? img : null;
    }

    /* ── 渲染 ── */

    /* 等比缩放画进一个小 canvas（大缩略图与抽屉行缩略图共用）。 */
    function fitCanvas(canvas, img) {
        const g = canvas.getContext('2d');
        if (g) g.clearRect(0, 0, canvas.width, canvas.height);
        if (!g || !img || !img.width || !img.height) return;
        const s = Math.min(canvas.width / img.width, canvas.height / img.height);
        const w = Math.max(1, Math.round(img.width * s));
        const h = Math.max(1, Math.round(img.height * s));
        g.imageSmoothingEnabled = true;
        if ('imageSmoothingQuality' in g) g.imageSmoothingQuality = 'high';
        g.drawImage(img, Math.round((canvas.width - w) / 2), Math.round((canvas.height - h) / 2), w, h);
    }

    function paintThumb(img) {
        thumb.classList.toggle('is-empty', !img);
        fitCanvas(thumb, img);
    }

    /* ── 纹理抽屉 ── */

    /** 行数据签名：只有「库里有什么 / 当前是哪张」变了才重建 DOM（播放时每帧 refresh 不该重建列表）。 */
    function rowsSig(rows) {
        return rows
            .map((r) => [r.id, r.index, r.width, r.height, r.times.join(','), r.current ? 1 : 0].join(':'))
            .join('|');
    }

    /** 把「待确认删除」收回初始态（换行/收起/超时/删除完成后都走这里）。 */
    function resetDeleteConfirm() {
        const armed = pendingDelete != null || confirmTimer !== 0;
        pendingDelete = null;
        if (confirmTimer) {
            clearTimeout(confirmTimer);
            confirmTimer = 0;
        }
        // 本来就没有确认态时直接返回：刷新每秒会跑很多次，不必重写一遍按钮内容
        if (!armed) return;
        for (const [, b] of deleteBtns) {
            b.classList.remove('is-armed');
            b.innerHTML = icon('trash', { label: tr('props.tex.lib.delete') });
            b.title = tr('props.tex.lib.deleteTitle');
            b.setAttribute('aria-label', tr('props.tex.lib.deleteTitle'));
        }
    }

    /** 行内删除的第一下：按钮变成「确认？」并在 4 秒后自己收回 —— 不许一次误删。 */
    function armDelete(id) {
        pendingDelete = id;
        if (confirmTimer) clearTimeout(confirmTimer);
        const confirmText = tr('props.tex.lib.confirm');
        const confirmTitle = tr('props.tex.lib.confirmTitle');
        const deleteTitle = tr('props.tex.lib.deleteTitle');
        for (const [key, b] of deleteBtns) {
            const armed = key === id;
            b.classList.toggle('is-armed', armed);
            if (armed) b.textContent = confirmText;
            else b.innerHTML = icon('trash', { label: tr('props.tex.lib.delete') });
            b.title = armed ? confirmTitle : deleteTitle;
            b.setAttribute('aria-label', armed ? confirmTitle : deleteTitle);
        }
        confirmTimer = setTimeout(() => {
            confirmTimer = 0;
            resetDeleteConfirm();
        }, 4000);
    }

    /** 点行 = 把这个时刻换成这张纹理（ctx.placeDrawing，一次 setDoc = 一条撤销）。 */
    function placeRow(row) {
        if (row.current) return; // 已经是这一刻生效的那张：不写一条「没变化」的撤销
        const obj = targetObj();
        if (!obj || !has('placeDrawing')) {
            say(tr('props.tex.say.placedFail'));
            return;
        }
        if (ctx.placeDrawing(obj.id, nowTime(ctx), row.id) !== true) {
            say(tr('props.tex.say.placedFail'));
            return;
        }
        say(tr('props.tex.say.placed'));
        refresh();
    }

    /** 行内删除：第一次只上确认态，第二次才真的走 ctx.removeDrawing。 */
    function deleteRow(row) {
        if (pendingDelete !== row.id) {
            armDelete(row.id);
            return;
        }
        resetDeleteConfirm();
        const obj = targetObj();
        if (!obj || !has('removeDrawing')) {
            say(tr('props.tex.say.deletedFail'));
            return;
        }
        if (ctx.removeDrawing(obj.id, row.id) !== true) {
            say(tr('props.tex.say.deletedFail'));
            return;
        }
        say(tr('props.tex.say.deleted'));
        refresh();
    }

    /** 32×32 行缩略图（棋盘格由 textures.css 垫在 canvas 底下）。 */
    function makeRowThumb(image) {
        const cv = document.createElement('canvas');
        cv.className = 'ptx-row-thumb';
        cv.width = 32;
        cv.height = 32;
        cv.setAttribute('aria-hidden', 'true');
        fitCanvas(cv, image);
        return cv;
    }

    /** 重建抽屉列表：一行 = [放置按钮（缩略图/序号/尺寸/引用/当前徽标）][行内删除]。 */
    function rebuildDrawer(obj, rows) {
        drawer.textContent = '';
        deleteBtns.clear();
        resetDeleteConfirm();
        const images = new Map();
        for (const d of obj ? drawingsOf(obj) : []) images.set(d.id, d.image);
        for (const row of rows) {
            const item = document.createElement('div');
            item.className = 'ptx-row';
            item.dataset.id = row.id;
            item.classList.toggle('is-current', row.current);
            item.classList.toggle('is-unused', row.unused);

            const main = document.createElement('button');
            main.type = 'button';
            main.className = 'ptx-row-main';
            main.dataset.k = 'ptx-row';
            if (row.current) main.setAttribute('aria-current', 'true');
            const sizeText = row.width + ' × ' + row.height;
            const aria = tr(row.current ? 'props.tex.lib.rowCurrentAria' : 'props.tex.lib.rowAria', {
                index: row.index,
                size: sizeText,
            });
            main.title = aria;
            main.setAttribute('aria-label', aria);

            const idxEl = document.createElement('span');
            idxEl.className = 'ptx-row-idx';
            idxEl.textContent = String(row.index);

            const sizeEl = document.createElement('span');
            sizeEl.className = 'ptx-row-size';
            sizeEl.textContent = sizeText;

            // 引用信息：未使用 / @时刻 / @时刻 · N 处；完整时刻表挂在 title 里
            const ref = textureRowRef(row);
            const refEl = document.createElement('span');
            refEl.className = 'ptx-row-ref';
            refEl.textContent = tr(ref.key, ref.vars);
            refEl.title = row.unused
                ? tr('props.tex.lib.unusedTitle')
                : tr('props.tex.lib.timesTitle', {
                    times: row.times.map((s) => formatTextureTime(s) + 's').join(', '),
                });

            main.append(makeRowThumb(images.get(row.id)), idxEl, sizeEl, refEl);
            if (row.current) {
                const badge = document.createElement('span');
                badge.className = 'ptx-row-badge';
                badge.textContent = tr('props.tex.lib.current');
                main.appendChild(badge);
            }
            main.addEventListener('click', () => placeRow(row));

            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'ptx-row-del';
            del.dataset.k = 'ptx-row-del';
            del.innerHTML = icon('trash', { label: tr('props.tex.lib.delete') });
            del.title = tr('props.tex.lib.deleteTitle');
            del.setAttribute('aria-label', tr('props.tex.lib.deleteTitle'));
            del.addEventListener('click', () => deleteRow(row));
            deleteBtns.set(row.id, del);

            item.append(main, del);
            drawer.appendChild(item);
        }
    }

    /** 抽屉与摘要行同步：无纹理时整块隐藏（空态由摘要那条词条负责说明），不显示空列表。 */
    function syncDrawer(obj, rows) {
        const hasRows = rows.length > 0;
        libRow.hidden = !hasRows;
        if (!hasRows) {
            drawer.hidden = true;
            drawer.textContent = '';
            deleteBtns.clear();
            drawerSig = '';
            resetDeleteConfirm();
            return;
        }
        toggleBtn.textContent = openDrawer ? tr('props.tex.lib.hide') : tr('props.tex.lib.show');
        toggleBtn.title = tr('props.tex.lib.toggleTitle');
        toggleBtn.setAttribute('aria-label', tr('props.tex.lib.toggleTitle'));
        toggleBtn.setAttribute('aria-expanded', openDrawer ? 'true' : 'false');
        drawer.hidden = !openDrawer;
        if (!openDrawer) {
            drawerSig = '';
            resetDeleteConfirm();
            return;
        }
        const sig = rowsSig(rows);
        if (sig === drawerSig) return;
        drawerSig = sig;
        rebuildDrawer(obj, rows);
    }

    function syncActions(sum) {
        const state = { hasObj: !!targetObj(), count: sum.count };
        for (const [id, b] of actBtns) {
            const blocked = actionBlocked(id, state);
            // 只做视觉置灰，不 disabled：点下去仍会走守卫并报中文原因（layers.mjs:879 的原则）
            b.classList.toggle('is-off', !!blocked);
            const full = TEXTURE_ACTIONS.find((a) => a.id === id);
            b.title = blocked
                ? tr(blocked)
                : full
                    ? tr('props.tex.actionTitle', { action: tr(full.titleKey), hint: tr(ACTION_HINTS[id]) })
                    : id;
            b.setAttribute('aria-label', blocked ? tr(blocked) : full ? tr(full.titleKey) : id);
        }
    }

    function syncSize(img) {
        const ready = has('resizeTexture');
        const why = !ready
            ? tr('props.tex.block.notWired')
            : !img
                ? tr('props.tex.block.trim')
                : '';
        const applyTitle = why || tr('props.tex.applyTitle');
        applyBtn.disabled = !!why;
        applyBtn.title = applyTitle;
        applyBtn.setAttribute('aria-label', applyTitle);
        for (const [val, b] of alignBtns) {
            const lblKey = (TEXTURE_ALIGN.find(([k]) => k === val) || [val, val])[1];
            const title = ready
                ? tr('props.tex.alignTitle', { align: tr(lblKey) })
                : tr('props.tex.block.notWired');
            b.disabled = !ready;
            b.title = title;
            b.setAttribute('aria-label', title);
            b.classList.toggle('is-on', val === align);
        }
        sizeW.disabled = !!why;
        sizeH.disabled = !!why;
        // 只在「纹理尺寸真的换了」时写回输入框：否则点「对齐」再点「重设」时，
        // 已经打好的宽高会被 refresh 冲掉，用户看到的是「尺寸没有变化」。
        const sig = img ? img.width + 'x' + img.height : '';
        if (sig !== syncedSig) {
            syncedSig = sig;
            sizeW.value = img ? String(img.width) : '';
            sizeH.value = img ? String(img.height) : '';
        }
    }

    function refresh() {
        const obj = targetObj();
        const now = nowTime(ctx);
        const img = currentImage();
        const sum = textureSummary(obj, now);
        paintThumb(img);
        summary.textContent = obj ? tr(sum.key, sum.vars) : '—';
        summary.title = obj ? tr(sum.key, sum.vars) : tr('props.tex.noObject');
        syncActions(sum);
        syncSize(img);
        // 抽屉的行数据与摘要同一个时间口径；无对象/无纹理时 syncDrawer 会把整块藏起来
        syncDrawer(obj, textureRows(obj, now));
    }

    /* ── 动作 ── */

    function runNew(obj, when) {
        if (!has('newDrawing')) {
            say(tr('props.tex.say.newNotWired'));
            return false;
        }
        const made = ctx.newDrawing(obj.id);
        if (!made) {
            say(tr('props.tex.say.fail'));
            return false;
        }
        const placed = has('placeDrawing') && ctx.placeDrawing(obj.id, when, made) === true;
        say(placed ? tr('props.tex.say.created') : tr('props.tex.say.createdLib'));
        return true;
    }

    function runUnique(obj, when) {
        if (!has('makeUniqueCel')) {
            say(tr('props.tex.say.uniqueNotWired'));
            return false;
        }
        if (ctx.makeUniqueCel(obj.id, when) !== true) {
            say(tr('props.tex.block.unique'));
            return false;
        }
        return true;
    }

    function runDelete(obj, when) {
        const ids = has('drawingsOf') ? ctx.drawingsOf(obj.id).map((d) => d && d.id) : [];
        const cur = has('currentDrawingId') ? ctx.currentDrawingId(obj.id) : null;
        const id = deleteCandidateId(ids, cur, null);
        if (!id) {
            say(tr('props.tex.block.delete'));
            return false;
        }
        if (!has('removeDrawing') || ctx.removeDrawing(obj.id, id) !== true) {
            say(tr('props.tex.block.delete'));
            return false;
        }
        return true;
    }

    function runTrim(obj) {
        if (!has('resizeTexture')) {
            say(tr('props.tex.block.notWired'));
            return false;
        }
        // 成功/失败文案由 shell 的 resizeTexture 自己 flash（'已裁到内容：W × H' 等），这里不重复
        return ctx.resizeTexture(obj.id, trimPayload()) === true;
    }

    function runSize(obj, payload) {
        if (!has('resizeTexture')) {
            say(tr('props.tex.block.notWired'));
            return false;
        }
        return ctx.resizeTexture(obj.id, payload) === true;
    }

    function applySizeFromInputs() {
        const payload = resizePayload(sizeW.value, sizeH.value, align);
        if (!payload) {
            say(tr('props.tex.say.sizeInvalid'));
            return false;
        }
        const obj = targetObj();
        if (!obj) {
            say(tr('props.tex.block.noObject'));
            return false;
        }
        return runSize(obj, payload);
    }

    /* ── 绑定 ── */

    thumb.addEventListener('dblclick', () => {
        const obj = targetObj();
        // 先认对象再切工作区：画板挂载时按 activeLayerId 找目标，顺序反了就画到别的对象上
        if (obj && has('setActiveLayer')) ctx.setActiveLayer(obj.id);
        const via = workspaceSwitchTarget(ctx);
        if (via === 'ctx') ctx.setWorkspace('draw');
        else if (via === 'motionStudio') globalThis.motionStudio.setWorkspace('draw');
        else say(tr('props.tex.say.noWorkspace'));
    });

    for (const [id, b] of actBtns) {
        b.addEventListener('click', () => {
            const obj = targetObj();
            const now = nowTime(ctx);
            const sum = textureSummary(obj, now);
            const blocked = actionBlocked(id, { hasObj: !!obj, count: sum.count });
            if (blocked) {
                say(tr(blocked));
                return;
            }
            if (id === 'new') runNew(obj, now);
            else if (id === 'unique') runUnique(obj, now);
            else if (id === 'delete') runDelete(obj, now);
            else if (id === 'trim') runTrim(obj);
        });
    }

    // 展开/收起：状态留在闭包里，refresh() 只换内容；收起时顺手把「待确认删除」收回
    toggleBtn.addEventListener('click', () => {
        openDrawer = !openDrawer;
        refresh();
    });

    applyBtn.addEventListener('click', () => applySizeFromInputs());
    for (const [val, b] of alignBtns) {
        b.addEventListener('click', () => {
            align = val;
            refresh();
        });
    }
    // 尺寸框里回车 = 应用；绑在组上而不是 window，键位不外溢
    body.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        if (e.target !== sizeW && e.target !== sizeH) return;
        e.preventDefault();
        applySizeFromInputs();
    });

    refresh();

    return {
        refresh,
        destroy() {
            // 确认态的超时计时器不清理的话，面板重挂后还会回调一次已摘掉的按钮
            if (confirmTimer) {
                clearTimeout(confirmTimer);
                confirmTimer = 0;
            }
            const group = body ? body.parentNode : null;
            if (group && typeof group.remove === 'function') group.remove();
        },
    };
}
