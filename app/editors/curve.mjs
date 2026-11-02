// 曲线编辑器（Graph Editor）：把对象变换轨道的每个标量通道画成连续曲线 ——
// 时间轴（帧带）回答「这一格像素属于哪一帧」，这里回答「对象在两帧之间怎么动」。
// 数据有两个层次：共用 `layer.transform.keys`（一个关键帧携带全部通道）与
// `transform.channels[field].keys`（某通道自己的关键帧）。取数一律**通道优先**：
// 通道有独立轨道就用它自己的键，否则回退到共用键里该通道的分量。
// 分工：curve-geo.mjs=坐标/通道/值域/命中（纯函数），curve-draw.mjs=只画，本文件=DOM/状态/事件/写回。
//
// 显示模型：一次只「编辑」一条曲线。
//   focus = 当前通道：满色曲线 + 关键帧圆点 + 独占 Y 轴真实刻度
//   refs  = 叠加的参考线：细、半透明、无圆点，数值看右边缘同色读数
// 原因：通道量纲互不相同（X 是像素、A 是比例、R 是角度），多条曲线共用一套 Y 轴刻度时，
// 任何单一数字都只对其中一条成立 —— 干脆让刻度永远跟着聚焦通道走，其余只对照形状。
//
// 独立轨道的时机：第一次在某个通道上拖动/加点/删点/改缓动时，先把共用关键帧提升成它的
// 独立轨道（promoteChannel，同一时刻取值完全相等，所以画面不跳），之后只动它自己。
// 参考线是只读的 —— 替别的通道提升等于偷偷改数据。

import {
    stateAt, addKey, removeKey, setKeyEase, autoTangents as applyAutoTangents,
    channelOf, clearChannel, setChannelKey, removeChannelKey, setChannelKeyEase, TRACK_FIELDS,
} from '../core/transform.mjs';
import { EFFECT_DEFS } from '../paint/effects.mjs';
import { icon } from '../core/icons.mjs';
import { clickIntent } from '../core/selection.mjs';
import { normalizeLattice, latticeIsZero } from '../core/lattice.mjs';
import { patchLayer, layerById, celTimes, objectsOf } from '../core/cel.mjs';
import {
    PAD_L, PAD_R, PAD_T, PAD_B, EASE_LABEL, SCALAR_CHANNELS, ensureWarpChannels, warpChannels, chById,
    clamp, fmt2, fmtVal, totalSeconds, computeRange, xToT, yToV,
    hitTest as geoHitTest, pickInRect, dragKeyTo, dragHandleTo, selectionIndexes,
    channelKeysOf, writeModeOf, occupiedAt, isChannelField, dragChannelKeyTo, dragChannelHandleTo, autoTangentsChannel,
    effectChannelId, isEffectChannelId, channelMetaOf, sampleChannel,
} from './curve-geo.mjs';
import { resizeCanvas, beginFrame, paintCanvas } from './curve-draw.mjs';
// 本模块里 `t` 到处是「时刻」的局部变量（`const t = xToT(geo, x)`），所以翻译函数改名 tr。
import { t as tr } from '../i18n/index.mjs';

/**
 * `describeTime()` 用这句中文当「时间变换恒等」的哨兵（`app/core/timegraph.mjs:518`），
 * 这里只拿它做比较、不显示，所以**不走词典**：词条一换语言哨兵就对不上了。
 * 根治得让 core 导出显式的恒等判定，那不在本片写域。
 */
const IDENTITY_TIME_TEXT = '无时间变换';
// 曲线里「拖出来/打出来的时刻」也要落在整帧上，否则时间轴帧带里对不上位置
import { snapForDrag } from './timeline-geo.mjs';
import { snapOnNow } from './timeline-keys.mjs';
import { hideTip, showTip } from './drag-tip.mjs';

/**
 * `focusChannel` 的判定部分：只回答「这条通道 + 这个时刻能不能定位」，
 * 不碰 DOM、不改状态。抽出来是为了能在 node 里单测守卫——未知通道不许猜。
 *
 * @param {string} chId 通道 id（`rotate` / `scaleX` / `warp.0.x` …）
 * @param {number} t 时刻（对象局部秒）
 * @returns {{ch: string, t: number}|null} 不认识的通道或非法时刻一律 null
 */
export function focusChannelTarget(chId, t) {
    // 效果参数通道在模块级没有模型可查，只做形状校验（`fx.<id>.<param>`）
    if (!chById(chId) && !isEffectChannelId(chId)) return null;
    // `Number(null)` / `Number('')` 都是 0：不挡掉的话「没给时刻」会被静默当成 0 s，
    // 播放头莫名跳到开头，比什么都不做还难查。
    if (t === null || t === undefined || t === '') return null;
    const at = Number(t);
    if (!Number.isFinite(at)) return null;
    return { ch: chId, t: at };
}

/**
 * 折叠摘要（B2 的纯函数部分）：把「聚焦通道 + 参考线」收成一行 `已选 N 条`。
 *
 * 折叠态只影响**显示**，所以这里只做「数一遍、取一遍名字」，不读 DOM、不碰 `refs`
 * 本身（传进来的 Set/数组原样不动）—— 选择集与参考线因此和折叠相互独立。
 * 计数口径：focus 永远算第一条（就算它同时在 refs 里也只算一次），其余按 refs 去重后累加。
 * 只剩聚焦一条时不报数（「已选 1 条」没有信息量），直接把通道名当摘要。
 *
 * @param {string|null} focusId 当前聚焦通道 id
 * @param {Iterable<string>|null} refs 参考线通道 id（Set 或数组）
 * @param {(id: string) => string} nameOf 通道 id → 显示名（DOM 侧传 `metaOf(id).label`）
 * @returns {{count: number, focusName: string, refNames: string[], ids: string[], text: string}}
 *   `count` = focus + refs 的去重总数；`text` 是给 UI 直接用的那一行（`count<=1` 时就是 focusName）。
 *   `text` 会走一次词典（`curve.fold.selected`），其余字段与语言无关。
 */
export function foldSummary(focusId, refs, nameOf) {
    const labelOf = typeof nameOf === 'function' ? nameOf : (id) => String(id == null ? '' : id);
    const ids = [];
    const seen = new Set();
    const add = (id) => {
        // 只认非空字符串：通道 id 不可能是数字/对象，脏值安静跳过比把面板画崩强
        if (typeof id !== 'string' || !id || seen.has(id)) return;
        seen.add(id);
        ids.push(id);
    };
    add(focusId);
    if (refs) for (const id of refs) add(id);
    const focusName = focusId ? labelOf(focusId) : '';
    const refNames = ids.filter((id) => id !== focusId).map((id) => labelOf(id));
    const count = ids.length;
    return {
        count,
        focusName,
        refNames,
        ids,
        text: count > 1 ? tr('curve.fold.selected', { n: count }) : focusName,
    };
}

/**
 * 折叠判定（纯函数）：工具条那颗按钮点一下翻面。
 * 非真值（undefined / null / 0）一律按「当前是展开态」处理 —— 闭合变量初值就是 `false`。
 *
 * @param {boolean|undefined|null} folded 当前折叠态
 * @returns {boolean} 翻面后的折叠态
 */
export function toggleFold(folded) {
    return !folded;
}

/* ─────────────────── 效果参数 → 曲线通道（适配器） ─────────────────── */

/** 效果参数通道的配色：与曲线/时间轴的通道色同一套视觉语言（互相不撞色）。 */
export const EFFECT_CURVE_COLORS = Object.freeze(['#e0556b', '#59a86a', '#4a7dff', '#8a6ce0', '#d08a3a', '#3aa8a0', '#a0559a', '#9aa1ac']);

/**
 * 把对象的效果参数轨道摊平成曲线编辑器认的「通道视图」（纯函数，Node 可测）。
 *
 * 规则：
 *   - 只有**已经打过帧**的参数才出现（`fx.tracks[param].keys` 非空）——没帧的参数没有曲线可画，
 *     用户先在属性面板按 ◆ 建第一帧；
 *   - 通道 id = `fx.<效果id>.<参数名>`（同类效果可以挂多条，必须带实例 id 而不是类型）；
 *   - 颜色按「出现顺序」从 `EFFECT_CURVE_COLORS` 轮转，同一对象内不重复；
 *   - 标签 = `效果名 · 参数名`，量程取效果定义里的 `min/max`（曲线纵轴用）。
 *
 * @param {object|null} layer 文档对象
 * @param {ReadonlyArray<object>} defs `EFFECT_DEFS`
 * @param {(key: string, vars?: object) => string} tr 取词函数
 * @returns {object} 曲线轨道视图（`keys/channels/channelMeta/effectGroups`，与 transform 形状兼容）
 */
export function buildCurveModel(layer, defs, tr) {
    const base = layer && layer.transform && Array.isArray(layer.transform.keys)
        ? layer.transform
        : { keys: [] };
    const effects = Array.isArray(layer && layer.effects) ? layer.effects : [];
    if (!effects.length) return base;
    const list = Array.isArray(defs) ? defs : [];
    const say = typeof tr === 'function' ? tr : (key) => String(key);
    const channels = Object.assign({}, base.channels || {});
    const channelMeta = {};
    const effectGroups = [];
    let colorIdx = 0;
    for (const fx of effects) {
        if (!fx || !fx.id) continue;
        const def = list.find((d) => d.id === fx.type);
        if (!def) continue;
        const rows = [];
        for (const p of def.params) {
            if (p.color) continue;   // 颜色参数不是标量，画不成曲线
            const trk = fx.tracks && fx.tracks[p.key];
            const keys = trk && Array.isArray(trk.keys) ? trk.keys : [];
            if (!keys.length) continue;   // 没打过帧的参数不出现（先在属性面板建第一帧）
            const id = effectChannelId(fx.id, p.key);
            channels[id] = {
                // 形状与通道轨道一致：值摊平成 value（写回时再包回 state.x）
                keys: keys.map((k) => ({
                    t: k.t, ease: k.ease, h1: k.h1, h2: k.h2,
                    value: Number(k && k.state ? k.state.x : 0) || 0,
                })),
            };
            const color = EFFECT_CURVE_COLORS[colorIdx++ % EFFECT_CURVE_COLORS.length];
            channelMeta[id] = {
                fxId: fx.id,
                key: p.key,
                label: say(def.nameKey) + ' · ' + say(p.labelKey),
                short: say(p.labelKey),
                color: color,
                min: Number(p.min),
                max: Number(p.max),
            };
            rows.push({ id: id, label: channelMeta[id].label, short: channelMeta[id].short, color: color });
        }
        if (rows.length) {
            effectGroups.push({ title: say('curve.group.effect', { name: say(def.nameKey) }), list: rows });
        }
    }
    return Object.assign({}, base, { channels: channels, channelMeta: channelMeta, effectGroups: effectGroups });
}

/**
 * 曲线轨道视图 → 文档补丁（纯函数，Node 可测）：`transform` 只留 TRACK_FIELDS 的通道，
 * 效果参数通道写回对应 `effect.tracks[param]`（值包回 `state:{x}`）。
 *
 * 为什么必须拆：曲线里的「轨道」是读视图（效果通道被摊平成 value），
 * 直接把它当 `transform` 落盘会把效果轨道塞进变换轨道，刷新一次就全丢。
 *
 * 返回的补丁可能只含 transform（没有效果变化时），调用方据此决定 effects 是否要一起写。
 * 没有变化的参数不重建效果对象 —— 少一次无谓的结构变更，也就少一次「看起来什么都没改」的撤销。
 *
 * @param {object|null} layer 当前文档对象
 * @param {object} model `buildCurveModel` 的产物（会被 mut 改过的新对象）
 * @param {ReadonlyArray<object>} defs `EFFECT_DEFS`
 * @returns {{transform:object, effects?:object[]}}
 */
export function splitCurveModel(layer, model, defs) {
    const base = layer && layer.transform && typeof layer.transform === 'object' ? layer.transform : {};
    const transform = Object.assign({}, base, { keys: model.keys });
    const kept = {};
    for (const f of TRACK_FIELDS) if (model.channels && model.channels[f]) kept[f] = model.channels[f];
    if (Object.keys(kept).length) transform.channels = kept;
    else delete transform.channels;

    const effects = Array.isArray(layer && layer.effects) ? layer.effects : [];
    const list = Array.isArray(defs) ? defs : [];
    let effectsChanged = false;
    const nextEffects = effects.map((fx) => {
        if (!fx || !fx.id) return fx;
        const def = list.find((d) => d.id === fx.type);
        if (!def) return fx;
        let nextFx = fx;
        for (const p of def.params) {
            if (p.color) continue;
            const id = effectChannelId(fx.id, p.key);
            const ch = model.channels ? model.channels[id] : null;
            const keys = ch && Array.isArray(ch.keys) ? ch.keys : [];
            const tracks = Object.assign({}, nextFx.tracks || {});
            if (keys.length) {
                tracks[p.key] = {
                    keys: keys.map((k) => ({
                        t: k.t,
                        ease: k.ease,
                        h1: k.h1,
                        h2: k.h2,
                        state: { x: Number(k.value) || 0 },
                    })),
                };
            } else if (tracks[p.key]) {
                delete tracks[p.key];
            } else {
                continue;   // 没有变化：别为一条没动过的参数造新对象
            }
            nextFx = Object.assign({}, nextFx, { tracks: Object.keys(tracks).length ? tracks : undefined });
            if (!nextFx.tracks) delete nextFx.tracks;
            effectsChanged = true;
        }
        return nextFx;
    });
    return effectsChanged ? { transform: transform, effects: nextEffects } : { transform: transform };
}

export function mount(el, ctx) {
    const root = document.createElement('div');
    root.className = 'curve';

    /* ── 工具条：一行装完 —— 通道入口 + 缓动图标 + 一句状态 ── */
    const bar = document.createElement('div');
    bar.className = 'curve-bar';

    // 通道不再常驻 chip：动不动 17 个以上（3×3 网格就有 32 个顶点通道），
    // 一行塞不下只能裁掉，用户看到的是半截按钮。收进弹出面板后既完整又不占高度。
    const chBtn = document.createElement('button');
    chBtn.type = 'button';
    chBtn.className = 'curve-ch-btn';
    const chLabel = document.createElement('span');
    chLabel.className = 'curve-ch-label';
    chBtn.appendChild(chLabel);
    // 「已独立」角标：这条通道有了自己的轨道就不再跟随共用关键帧。少了这个标记，
    // 用户拖动时会以为「别的曲线没反应」是 bug。
    const chSolo = document.createElement('span');
    chSolo.className = 'curve-solo';
    chSolo.textContent = '⤴';
    chBtn.appendChild(chSolo);
    bar.appendChild(chBtn);

    /* ── 折叠按钮（B2）：把通道面板从整张列表收成一行「已选 N 条」。
     * 图标复用现成的 chevron：展开时朝上（点击收起）、折叠时朝下（点击展开）；
     * 语义只走 title / aria-label / aria-expanded，不额外造图标。 */
    const foldBtn = document.createElement('button');
    foldBtn.type = 'button';
    foldBtn.className = 'curve-fold-btn ms-icon-btn';
    foldBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        folded = toggleFold(folded);
        // 面板本来收着时点折叠看不到任何变化（列表没展开）—— 顺手把面板打开，
        // 「整张列表 ↔ 摘要行」的切换才是当场可见的；再点一次就换回来。
        if (pop.hidden) openPop();
        paint();
    });
    bar.appendChild(foldBtn);

    /* ── 缓动预设：选中关键帧后一键换线型（比拖柄快得多）。图标化，语义留在 title 里 ── */
    // 关键字与第三个元素是**落盘的缓动名**，不许动；显示名（按钮里的短语 + title 全句）
    // 一律走词典 `curve.preset.*`。
    const PRESETS = [
        ['linear', 'curve-line', 'linear', null],
        ['in', 'curve-in', 'bezier', [[0.42, 0], [1, 1]]],
        ['out', 'curve-out', 'bezier', [[0, 0], [0.58, 1]]],
        ['inout', 'curve-both', 'bezier', [[0.42, 0], [0.58, 1]]],
        ['back', 'curve-overshoot', 'bezier', [[0.34, 1.56], [0.64, 1]]],
    ];
    const presets = document.createElement('div');
    presets.className = 'curve-presets';
    for (const [key, iconName, ease, hs] of PRESETS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'curve-preset ms-icon-label';
        b.dataset.preset = key;
        b.innerHTML = icon(iconName, { size: 'sm' }) + '<span>' + tr('curve.preset.' + key + '.glyph') + '</span>';
        const name = tr('curve.preset.' + key + '.label');
        b.title = ease === 'linear'
            ? tr('curve.preset.hint.linear', { name })
            : tr('curve.preset.hint.bezier', { name });
        b.addEventListener('click', (ev) => {
            ev.stopPropagation();
            applyPreset(ease, hs);
        });
        presets.appendChild(b);
    }
    // v5：自动切线 —— 按相邻关键帧的斜率生成平滑曲线（Catmull-Rom 风格）
    const autoBtn = document.createElement('button');
    autoBtn.type = 'button';
    autoBtn.className = 'curve-preset is-auto ms-icon-label';
    autoBtn.innerHTML = icon('curve-auto', { size: 'sm' }) + '<span>' + tr('curve.preset.auto.glyph') + '</span>';
    autoBtn.title = tr('curve.preset.auto.hint');
    autoBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        applyAuto();
    });
    presets.appendChild(autoBtn);
    bar.appendChild(presets);

    const hint = document.createElement('span');
    hint.className = 'curve-hint';
    bar.appendChild(hint);

    /* ── 通道面板（浮层）：点一行切曲线，Shift+点一行叠参考线 ── */
    const pop = document.createElement('div');
    pop.className = 'curve-pop';
    pop.hidden = true;

    /* 通道行列表与折叠摘要行**互斥**：折叠只切 visible，不重建行 ——
     * 行上的 is-focus / is-ref 由 syncPopRows 维护，重建会连滚动位置一起丢掉。 */
    const chList = document.createElement('div');
    chList.className = 'curve-ch-list';
    const foldRow = document.createElement('button');
    foldRow.type = 'button';
    foldRow.className = 'curve-fold';
    foldRow.hidden = true;
    const foldDot = document.createElement('span');
    foldDot.className = 'curve-fold-dot';
    const foldName = document.createElement('span');
    foldName.className = 'curve-fold-name';
    const foldCount = document.createElement('span');
    foldCount.className = 'curve-fold-count';
    foldRow.append(foldDot, foldName, foldCount);
    foldRow.addEventListener('click', (ev) => {
        ev.stopPropagation();
        // 摘要行本身就是第二个「展开」入口（与工具条那颗按钮等价），
        // 折叠态下用户点摘要就能回到完整列表，不必先找按钮。
        folded = false;
        paint();
    });
    pop.append(chList, foldRow);

    const wrap = document.createElement('div');
    wrap.className = 'curve-plot-wrap';

    const cv = document.createElement('canvas');
    cv.className = 'curve-plot';
    wrap.appendChild(cv);

    // 读数浮层改为与时间轴共用 editors/drag-tip.mjs（常驻 document.body，视口内夹取），
    // 这里不再自带 .curve-tip 节点。

    root.append(bar, pop, wrap);
    el.appendChild(root);

    /* ── 模块内状态 ── */
    let focus = 'x';          // 正在编辑的通道（Y 轴刻度与圆点只跟它走）
    const refs = new Set();   // 叠加成参考线的通道
    let vView = 1;            // 纵向缩放（滚轮 + Shift）
    let timeSpan = 0;         // 0 = 自动铺满总时长
    let timeOffset = 0;       // 横轴窗口起点（秒）。中键拖动可以平移，滚轮只改窗口宽度
    let selKeys = [];         // 多选：[{ layerId, chId, index, part }]
    let sel = null;           // primary（最后点中的那个），切线柄与提示条只跟它走
    /**
     * 通道面板是否折叠成「已选 N 条」。
     * 这是 **mount 闭包变量**：`refresh()` 只重画、不重建面板，所以跨 refresh 保持；
     * remount（切语言、换工作区槽位）会新建实例 —— 按面板其它瞬态（弹层开合、视口）
     * 的惯例重置成展开。它只是一个显示位，不参与选择集 / refs / 绘制的任何判等。
     */
    let folded = false;

    /** 同一个曲线点（通道 + 下标 + 部位）。选择集与命中测试共用同一判等，避免两处口径漂移。 */
    const sameKey = (a, b) => !!a && !!b && a.layerId === b.layerId && a.chId === b.chId
        && a.index === b.index && a.part === b.part;

    /** 这个点现在是否已在选择集里（clickIntent 需要它来区分累加与移出）。 */
    function isSelKey(hit) {
        return !!hit && selKeys.some((s) => sameKey(s, hit));
    }

    /** 统一的选择入口：additive 为真时切换该点，否则独占。 */
    function setSel(hit, additive) {
        if (!hit) { selKeys = []; sel = null; return; }
        if (additive) {
            const at = selKeys.findIndex((s) => sameKey(s, hit));
            if (at >= 0) { selKeys.splice(at, 1); sel = selKeys[selKeys.length - 1] || null; return; }
        } else {
            selKeys = [];
        }
        selKeys.push(hit);
        sel = hit;
    }

    let drag = null;
    // 框选：无命中点时按下拖动拉一个矩形，把落在里面的关键帧一次选中
    let marquee = null;   // { x0, y0, x1, y1, additive, moved }
    let menu = null;
    let lastSig = '';

    /* ── 显示集 ── */
    /** 要画的通道：聚焦通道排第一（computeRange 拿第一个当 Y 轴刻度）。 */
    function shownNow() {
        const s = new Set();
        if (metaOf(focus)) s.add(focus);
        for (const id of refs) if (id !== focus && metaOf(id)) s.add(id);
        return s;
    }

    /** 命中/框选只认聚焦通道：参考线是给人看的，不承载编辑。 */
    const focusOnly = () => new Set(metaOf(focus) ? [focus] : []);

    function setFocus(id) {
        if (!metaOf(id) || id === focus) return;
        focus = id;
        refs.delete(id);
        // 选择属于「某个通道上的某个点」，换通道就清空：否则切线柄会画在看不见的曲线上
        setSel(null);
        syncPopRows();
        paint();
    }

    /**
     * 时间轴上点了一颗通道关键帧（外壳/时间轴派发的 `ms:channel-key-click`）：
     * 把焦点切到那条通道、播放头挪到该刻。未知通道不猜，直接返回 false。
     *
     * 通道键不在 `track.keys` 里，时间轴那边不参与选择也不参与拖动，
     * 所以「点了没反应」是这里之前唯一的结局——用户点它就是想看那条曲线。
     */
    function focusChannel(layerId, chId, t) {
        const tgt = focusChannelTarget(chId, t);
        if (!tgt) return false;
        // 曲线画的是「选中对象」的轨道：点的是别的对象的键，先把它选上，
        // 否则焦点切了、播放头也动了，画面还是那条曲线（看起来仍然像没反应）。
        if (layerId && typeof ctx.setSelection === 'function') {
            const cur = typeof ctx.selection === 'function' ? ctx.selection() : null;
            if (!cur || cur.id !== layerId) ctx.setSelection({ id: layerId });
        }
        setFocus(tgt.ch); // 已经在焦点上时它提前返回，下面补一次 paint
        if (typeof ctx.setTime === 'function') ctx.setTime(tgt.t);
        paint();
        return true;
    }

    function onChannelKeyClick(e) {
        const d = e && e.detail ? e.detail : null;
        if (!d || !el.isConnected) return;
        // 三个工作区各有一个曲线实例：只让当前可见的那个响应，
        // 否则隐藏面板会跟着把播放头抢过去。
        if (typeof wrap.clientWidth === 'number' && wrap.clientWidth <= 0) return;
        if (!focusChannel(d.layerId, d.ch, d.t)) return;
        const ch = metaOf(d.ch);
        const name = ch ? ch.short : tr('curve.channelFallback');
        let msg = tr('curve.notify.located', { name, t: fmt2(d.t) });
        if (Number(d.count) > 1) msg += tr('curve.notify.locatedMulti', { n: d.count, name });
        notify(msg);
    }

    function toggleRef(id) {
        if (!metaOf(id) || id === focus) return;
        if (refs.has(id)) refs.delete(id);
        else refs.add(id);
        syncPopRows();
        paint();
    }

    /* ── 通道面板 ── */
    let popVals = new Map();

    function buildPop() {
        chList.textContent = '';
        popVals = new Map();
        const group = (title, list) => {
            if (!list.length) return;
            const h = document.createElement('div');
            h.className = 'curve-ch-group';
            h.textContent = title;
            chList.appendChild(h);
            for (const ch of list) chList.appendChild(chRow(ch));
        };
        group(tr('curve.group.transform'), SCALAR_CHANNELS);
        group(tr('curve.group.warp'), warpChannels());
        // 效果参数通道：每个效果一组（只有已打过帧的参数才会出现在模型里）
        const model = trackOf(activeLayer(docOf()));
        for (const g of model.effectGroups || []) group(g.title, g.list);
        syncPopRows();
        syncPopValues(model);
        syncFold();
    }

    function chRow(ch) {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'curve-ch-row';
        row.dataset.ch = ch.id;
        row.style.setProperty('--ch', ch.color);
        const name = document.createElement('span');
        name.className = 'curve-ch-name';
        name.textContent = ch.label;
        const solo = document.createElement('span');
        solo.className = 'curve-solo';
        solo.textContent = '⤴';
        const val = document.createElement('span');
        val.className = 'curve-ch-val';
        row.append(name, solo, val);
        popVals.set(ch.id, val);
        row.title = tr('curve.row.hint');
        row.addEventListener('click', (ev) => {
            ev.stopPropagation();
            if (ev.shiftKey) toggleRef(ch.id);
            else {
                setFocus(ch.id);
                closePop();
            }
        });
        return row;
    }

    function syncPopRows(track) {
        const trk = track || trackOf(activeLayer(docOf()));
        for (const row of pop.querySelectorAll('.curve-ch-row')) {
            const id = row.dataset.ch;
            const solo = isSolo(trk, id);
            row.classList.toggle('is-focus', id === focus);
            row.classList.toggle('is-ref', id !== focus && refs.has(id));
            row.classList.toggle('is-solo', solo);
            row.title = id === focus
                ? (solo ? tr('curve.row.focusSolo') : tr('curve.row.focus'))
                : (solo ? tr('curve.row.refSolo') : tr('curve.row.hint'));
        }
    }

    /** 面板里每行右侧的当前值：通道一多，光看名字对不上哪条线。 */
    function syncPopValues(track) {
        for (const [id, node] of popVals) node.textContent = fmtVal(id, sampleChannel(track, nowTime(), id));
    }

    function openPop() {
        buildPop();
        pop.hidden = false;
        chBtn.classList.add('is-on');
    }

    function closePop() {
        pop.hidden = true;
        chBtn.classList.remove('is-on');
    }

    chBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (pop.hidden) openPop();
        else closePop();
    });

    // 点别处收起面板。用捕获阶段：画布上的 pointerdown 会立刻改选中，面板得先让路
    const onDocDown = (ev) => {
        if (pop.hidden) return;
        if (pop.contains(ev.target) || chBtn.contains(ev.target) || foldBtn.contains(ev.target)) return;
        closePop();
    };
    document.addEventListener('pointerdown', onDocDown, true);
    // 时间轴上那颗「通道关键帧」菱形点不动的时候，用户唯一的指望就是这里
    document.addEventListener('ms:channel-key-click', onChannelKeyClick);

    /* ── 取数 ── */
    const notify = (m) => {
        if (typeof ctx.notify === 'function') ctx.notify(m);
    };
    const docOf = () => (typeof ctx.doc === 'function' ? ctx.doc() : null);
    /**
     * 曲线横轴的零点与坐标全部是**对象局部时间**。
     * 关键帧的 t 本来就是局部时间（transform 用 ltime 求值），
     * 所以播放头也必须换算到局部时间，否则对象一旦加了时间通道，
     * 播放头与关键帧就用两套坐标，看起来完全对不上。
     */
    const localNow = (doc, layer) => {
        const g = typeof ctx.time === 'function' ? Number(ctx.time()) : 0;
        const t = Number.isFinite(g) ? g : 0;
        if (!layer || typeof ctx.objectLocalTime !== 'function') return t;
        const lt = ctx.objectLocalTime(layer.id, t);
        return Number.isFinite(lt) ? lt : t;
    };
    const nowTime = () => {
        const v = typeof ctx.time === 'function' ? Number(ctx.time()) : 0;
        return Number.isFinite(v) ? v : 0;
    };

    function activeLayer(doc) {
        const list = objectsOf(doc);
        if (!list.length) return null;
        const sel1 = typeof ctx.selection === 'function' ? ctx.selection() : null;
        const wanted = (sel1 && sel1.id) || (typeof ctx.activeLayerId === 'function' ? ctx.activeLayerId() : null);
        return list.find((l) => l.id === wanted) || list[0];
    }

    /**
     * 曲线编辑用的「轨道视图」：变换轨道的 keys/channels + **效果参数通道**（适配器）。
     *
     * 效果参数轨道住在 `layer.effects[].tracks[param]`，与通道轨道同形状（值在 `state.x`）。
     * 这里把它们摊平成曲线认的通道格式，并挂上 `channelMeta`（标签/颜色/量程）。
     * 只有**已有轨道**的参数才出现在曲线上 —— 没打过帧的参数没有曲线可画，
     * 用户先在属性面板按 ◆ 建第一帧，通道随后出现在这里。
     *
     * 写回由 `writeTrack` 拆回 `transform` + `effects`（一次 setDoc = 一步撤销）。
     */
    let lastModel = { keys: [] };
    /** 上次见到的效果轨道签名（见 `effectSigOf`）：变了就重算通道面板与焦点。 */
    let lastFxSig = '';

    function trackOf(layer) {
        const model = buildCurveModel(layer, EFFECT_DEFS, tr);
        lastModel = model;
        return model;
    }

    /** 效果轨道签名：效果增删 / 某参数建或删轨道时，通道面板与焦点要跟着重算。 */
    function effectSigOf(layer) {
        const effects = Array.isArray(layer && layer.effects) ? layer.effects : [];
        return effects
            .map((fx) => {
                if (!fx || !fx.id) return '';
                const t = fx.tracks || {};
                return fx.id + ':' + Object.keys(t).map((k) => k + '#' + ((t[k] && t[k].keys) || []).length).join('+');
            })
            .join('|');
    }

    /** 通道元信息（变换/网格查固定表，效果参数查当前模型的 channelMeta）。 */
    function metaOf(id) {
        return channelMetaOf(lastModel, id);
    }

    /** 当前活动对象的曲线轨道视图（供各处读 meta/写回）。 */
    function modelNow() {
        return trackOf(activeLayer(docOf()));
    }

    /** 该通道是否已有独立轨道（= 不再跟随共用关键帧）。 */
    function isSolo(track, chId) {
        return isChannelField(chId) && !!channelOf(track, chId);
    }

    /* ── 视口几何 ── */
    let geo = { x0: PAD_L, x1: 100, y0: PAD_T, y1: 100, t0: 0, t1: 1, vMin: -1, vMax: 1 };

    function paint() {
        const doc = docOf();
        const size = resizeCanvas(cv, wrap);
        const g = cv.getContext('2d');
        if (!g) return;
        beginFrame(g, size);

        const layer = activeLayer(doc);
        const track = trackOf(layer);

        // 效果轨道变了（增/删效果、首次给参数打帧、清掉最后一条帧）→ 通道列表要重算；
        // 焦点/参考线若指向已经不存在的效果通道，必须摘掉（否则画的是幽灵、写入会落空）。
        const fxSig = effectSigOf(layer);
        if (fxSig !== lastFxSig) {
            lastFxSig = fxSig;
            for (const id of [...refs]) if (!metaOf(id)) refs.delete(id);
            if (!metaOf(focus)) focus = 'x';
            if (!pop.hidden) buildPop();
        }

        // 网格维度跟着当前对象走：2×2 就有 9 个顶点通道，通道面板也要重建
        const curLat = normalizeLattice(stateAt(track, nowTime()).warp);
        const dimsChanged = ensureWarpChannels(curLat ? curLat.cols : 1, curLat ? curLat.rows : 1);
        if (dimsChanged) {
            // 网格缩回去后旧顶点通道不存在了：焦点与参考线都得摘掉，否则画的是幽灵
            for (const id of [...refs]) if (!metaOf(id)) refs.delete(id);
            if (!metaOf(focus)) focus = 'x';
            if (!pop.hidden) buildPop();
        }

        const shown = shownNow();
        geo = {
            x0: PAD_L, x1: Math.max(PAD_L + 40, size.w - PAD_R),
            y0: PAD_T, y1: Math.max(PAD_T + 24, size.h - PAD_B),
            t0: (() => {
                const total = totalSeconds(doc);
                const span = timeSpan > 0 ? timeSpan : total;
                // 窗口不许越界：起点夹在 [0, total - span]
                const maxOff = Math.max(0, total - span);
                timeOffset = Math.max(0, Math.min(maxOff, timeOffset));
                return timeOffset;
            })(),
            t1: (() => {
                const total = totalSeconds(doc);
                const span = timeSpan > 0 ? timeSpan : total;
                const maxOff = Math.max(0, total - span);
                timeOffset = Math.max(0, Math.min(maxOff, timeOffset));
                return timeOffset + span;
            })(),
            // 拖动期间冻结值域：否则被拖的点自己参与 min/max，整条曲线会随手指重新缩放
            ...computeRange(track, shown, vView, drag ? drag.frozen : null, { width: doc.width, height: doc.height }),
        };

        paintCanvas({
            g, geo, layer, track, shown, focus,
            // 聚焦通道的关键帧视图与「是否已独立」：圆点、切线柄、同刻线都跟着它走
            focusKeys: channelKeysOf(track, focus),
            focusSolo: isSolo(track, focus),
            sel, selKeys, marquee,
            now: localNow(doc, layer), total: totalSeconds(doc),
            describeLayerTime: ctx.describeLayerTime, objectLocalTime: ctx.objectLocalTime,
        });

        syncBar(track, layer);
    }

    /** 工具条只放最短信息，完整说明进 title。 */
    function syncBar(track, layer) {
        const ch = metaOf(focus);
        const keys = channelKeysOf(track, focus);
        const solo = isSolo(track, focus);
        chLabel.textContent = ch ? ch.short : '—';
        chBtn.style.setProperty('--ch', ch ? ch.color : 'var(--accent)');
        chBtn.classList.toggle('is-solo', solo);
        chBtn.title = (ch ? ch.label : tr('curve.channelFallback')) +
            (solo ? tr('curve.bar.solo') : '') +
            tr('curve.bar.open');
        // 折叠/摘要是纯显示态：每帧都跟着 focus/refs 重新取一次文案（切语言也靠 remount）
        syncFold();

        if (!layer) {
            hint.textContent = tr('curve.bar.noObject');
            hint.title = '';
            return;
        }
        const easeName = keys.length > 1 ? EASE_LABEL[keys[Math.min(sel ? sel.index : 0, keys.length - 1)].ease] : '—';
        // 对象一旦有非恒等时间通道，横轴就是「它自己的时间」，必须标出来
        const td = typeof ctx.describeLayerTime === 'function' ? ctx.describeLayerTime(layer.id) : IDENTITY_TIME_TEXT;
        const timeTag = td && td !== IDENTITY_TIME_TEXT ? tr('curve.bar.objectTime') : '';
        const refTag = refs.size ? tr('curve.bar.refs', { n: refs.size }) : '';
        hint.textContent = tr('curve.bar.summary', { n: keys.length, ease: easeName }) +
            (solo ? tr('curve.bar.summarySolo') : '') + refTag + timeTag;
        hint.title =
            (td && td !== IDENTITY_TIME_TEXT ? tr('curve.bar.titleObjectTime', { desc: td }) + '\n' : '') +
            tr('curve.bar.titleHelp') + '\n' +
            (solo ? tr('curve.bar.titleSolo') : tr('curve.bar.titleFollow'));
        if (!pop.hidden) {
            syncPopRows(track);
            syncPopValues(track);
        }
    }

    /* ── 折叠 chrome（B2）：整张列表 ↔ 「已选 N 条」摘要行 ──
     * 折叠只切显示，**不碰** focus / refs / 选择集 / 绘制区：绘制区一直只画 focus + refs，
     * 所以折叠不会让曲线消失、不会丢参考线、也不会清掉选中的关键帧点。 */
    let foldChrome = null;   // 上次同步过的折叠态：拖动时 paint 每帧都来，别每帧重塞一遍 SVG
    function syncFold() {
        if (foldChrome !== folded) {
            foldChrome = folded;
            const label = folded ? tr('curve.fold.expand') : tr('curve.fold.collapse');
            foldBtn.innerHTML = icon(folded ? 'chevron-down' : 'chevron-up');
            foldBtn.classList.toggle('is-folded', folded);
            // aria-expanded 跟着「列表现在是否可见」走：展开 = true，折叠 = false
            foldBtn.setAttribute('aria-expanded', folded ? 'false' : 'true');
            foldBtn.title = label;
            foldBtn.setAttribute('aria-label', label);
            chList.hidden = folded;
            foldRow.hidden = !folded;
        }
        if (!folded) return;
        const ch = metaOf(focus);
        const sum = foldSummary(focus, refs, (id) => {
            const c = metaOf(id);
            return c ? c.label : tr('curve.channelFallback');
        });
        foldRow.style.setProperty('--ch', ch ? ch.color : 'var(--accent)');
        // 只剩聚焦一条时摘要行就是通道名本身；多条时报「已选 N 条」+ 聚焦通道名
        foldName.textContent = sum.count ? sum.focusName : tr('curve.channelFallback');
        foldCount.textContent = sum.count > 1 ? sum.text : '';
        foldRow.title = tr('curve.fold.rowHint');
    }

    /* ── 命中 ── */
    function localPoint(ev) {
        const r = cv.getBoundingClientRect();
        return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    }

    function keysNow() {
        const doc = docOf();
        const layer = activeLayer(doc);
        const track = trackOf(layer);
        // keys = 聚焦通道的关键帧视图（独立轨道优先），命中与索引都按它算
        return { doc, layer, track, keys: channelKeysOf(track, focus) };
    }

    function hitTest(px, py) {
        const { layer, track } = keysNow();
        if (!layer) return null;
        return geoHitTest(geo, track, layer.id, sel, focusOnly(), px, py);
    }

    /* ── 写入 ── */
    /** 缓动预设：作用于当前选中的关键帧（没选中就提示） */
    function applyPreset(ease, hs) {
        const doc = ctx.doc();
        if (!doc) return;
        const layer = layerById(doc, sel ? sel.layerId : (typeof ctx.activeLayer === 'function' ? ctx.activeLayer() : null));
        if (!layer) return;
        // 批量：同一对象上所有被选中的关键帧一起改缓动
        const idxs = selectionIndexes(selKeys, layer.id);
        if (!idxs.length) {
            hint.textContent = tr('curve.hint.selectFirst');
            return;
        }
        // 批量：同一对象上所有被选中的点一起改缓动。走哪套 API 由 writeModeOf 决定 ——
        // 已经是独立轨道才改通道键，否则改共用关键帧（别因为「点了缓动按钮」就把字段独立掉）
        const chId = sel ? sel.chId : focus;
        writeTrack(layer.id, (trk) => {
            const chMode = writeModeOf(trk, chId) === 'channel';
            return idxs.reduce((acc, i) => {
                if (!chMode) return hs ? setKeyEase(acc, i, ease, hs[0], hs[1]) : setKeyEase(acc, i, ease);
                return setChannelKeyEase(acc, chId, i, ease, hs ? hs[0] : undefined, hs ? hs[1] : undefined);
            }, trk);
        });
        const easeName = EASE_LABEL[ease] || EASE_LABEL.bezier;
        hint.textContent = tr('curve.hint.easeApplied', { ease: easeName }) +
            (idxs.length > 1 ? tr('curve.hint.easeMulti', { n: idxs.length }) : '');
    }

    /**
     * v5 自动切线：按相邻关键帧的斜率摆平该 key 的 h1/h2。
     * 没有手动拖过的 key 就能一键变「顺」，再按一次仍走自动（幂等）。
     */
    function applyAuto() {
        const doc = ctx.doc();
        if (!doc) return;
        const layer = layerById(doc, sel ? sel.layerId : (typeof ctx.activeLayer === 'function' ? ctx.activeLayer() : null));
        if (!layer) return;
        const idxs = selectionIndexes(selKeys, layer.id);
        if (!idxs.length) {
            hint.textContent = tr('curve.hint.selectFirst');
            return;
        }
        // 批量：逐个算切线（每次都基于最新轨道，避免后一个用到过期的邻居值）
        const chId = sel ? sel.chId : focus;
        let done = 0;
        for (const i of idxs) {
            const cur = layerById(docOf(), layer.id);
            // 必须用**适配器**轨道：效果参数通道只存在于适配器里（原始 transform 上没有）
            const trk = trackOf(cur);
            if (writeModeOf(trk, chId) === 'channel') {
                // 已是独立轨道：切线只按这条通道自己的键算
                const tg = autoTangentsChannel(trk, chId, i);
                if (!tg) continue;
                writeTrack(layer.id, (t2) => setChannelKeyEase(t2, chId, i, 'bezier', tg.h1, tg.h2));
            } else {
                const tg = applyAutoTangents(trk, i);
                if (!tg) continue;
                writeTrack(layer.id, (t2) => setKeyEase(t2, i, 'bezier', tg.h1, tg.h2));
            }
            done += 1;
        }
        hint.textContent = tr('curve.hint.autoApplied', { n: done });
    }

    /** 拆适配器 → 文档补丁（纯函数在模块级 `splitCurveModel`，这里只接 EFFECT_DEFS）。 */
    function splitModel(layer, model) {
        return splitCurveModel(layer, model, EFFECT_DEFS);
    }

    function writeTrack(layerId, mut) {
        const doc = docOf();
        if (!doc) return;
        const layer = layerById(doc, layerId);
        if (!layer) return;
        const trk = trackOf(layer);
        const next = mut(trk, layer);
        if (!next || next === trk) return;
        const patch = splitModel(layer, next);
        const patched = patchLayer(doc, layerId, patch);
        if (patched === doc) return;
        if (typeof ctx.setDoc === 'function') ctx.setDoc(patched);
        if (typeof ctx.requestRender === 'function') ctx.requestRender();
    }

    /**
     * 曲线里的吸附必须与时间轴**同一套判据**（`magnetOf` + `snapForDrag`）：
     * 磁铁开 = 吸整帧、Shift = 关磁铁（可落在两帧之间）；磁铁关 = 自由、Shift = 吸 0.1s 网格。
     *
     * 以前这里自己写「无条件吸帧、Shift 吸纹理」，于是同一个关键帧在两个面板里
     * 拖到同一像素位置会落到不同时刻 —— 那才是「时间轴和曲线不同步」的真身。
     */
    function snapTime(t, ev) {
        const doc = docOf();
        if (!doc) return t;
        return snapForDrag(doc, t, ev, snapOnNow());
    }

    /* ── 指针交互 ── */
    cv.addEventListener('pointerdown', (ev) => {
        if (ev.button === 2) return;
        const { x, y } = localPoint(ev);
        const hit = hitTest(x, y);
        if (!hit) {
            // 空白处按下先起框；没拖动就松手 = 点空白（移播放头 + 清选中）
            // 框选追加：Shift 或 Ctrl/Cmd 拖都是「加进来」而不是「换成这批」（与时间轴一致）
            const additive = !!(ev.shiftKey || ev.ctrlKey || ev.metaKey);
            marquee = { x0: x, y0: y, x1: x, y1: y, additive, moved: false };
            // 新起一次框选：不是叠加模式就先把旧选择清掉（否则框了个空的反而留着上一次的点）
            if (!additive) setSel(null);
            try {
                cv.setPointerCapture(ev.pointerId);
            } catch (err) {
                /* 合成事件里 pointerId 可能无效 */
            }
            paint();
            return;
        }
        ev.preventDefault();
        // 与时间轴同一套语义（core/selection.mjs 的 clickIntent）：
        //   单击=只选它 / Shift 或 Ctrl+点=累加，再点移出 / Shift+Alt+点=连选
        // 曲线的「连选」没有线性顺序（一个通道一条曲线，跨通道怎么连没有公认答案），
        // 所以 range 在这里退化成独占 —— 时间轴那边的连选是真连选，别把两边当同一件事。
        const intent = clickIntent({
            shiftKey: ev.shiftKey, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, altKey: ev.altKey, button: ev.button,
        }, isSelKey(hit));
        if (intent === 'ignore') return;
        if (intent === 'add' || intent === 'remove') setSel(hit, true);
        else if (intent === 'promote') sel = hit; // 已在集合里：只挪主选中，不动集合
        else setSel(hit, false);
        const { layer, keys } = keysNow();
        // 拖动期间的值域 = 按下这一刻屏幕上的值域（drag.frozen 交给 computeRange 复用）
        const frozen = { vMin: geo.vMin, vMax: geo.vMax, ranges: geo.ranges };
        if (hit.part === 'key') {
            drag = {
                kind: 'key', layerId: layer.id, index: hit.index, chId: hit.chId,
                t0: keys[hit.index].t, x0: x, y0: y, v0: keys[hit.index].value,
                // warp 通道的 patch 要拼完整 warp 对象；base 必须定格在拖动开始那一刻，
                // 否则每次 move 拿实时 state 当 base 会把别的角一起改写（独立轨道没有 state，置 null）
                baseState: keys[hit.index].state,
                frozen,
            };
        } else {
            const k0 = keys[hit.index];
            const k1 = keys[hit.index + 1];
            drag = {
                kind: hit.part, layerId: layer.id, index: hit.index, chId: hit.chId, x0: x, y0: y,
                h: hit.part === 'h1' ? k0.h1.slice() : k0.h2.slice(),
                span: { t0: k0.t, t1: k1.t, v0: k0.value, v1: k1.value },
                frozen,
            };
        }
        // 合成事件（测试脚本）里 pointerId 可能无效，捕获失败不该中断交互
        try {
            cv.setPointerCapture(ev.pointerId);
        } catch (err) {
            /* ignore */
        }
        paint();
    });

    cv.addEventListener('pointermove', (ev) => {
        // 松手丢了 pointerup（capture 失效 / 合成事件）时不至于永远卡在拖拽态：
        // 鼠标键已抬起的 pointermove 一律视为拖拽结束
        if (drag && ev.buttons === 0) drag = null;
        if (marquee && ev.buttons === 0) marquee = null;
        const { x, y } = localPoint(ev);
        if (marquee) {
            marquee.x1 = x;
            marquee.y1 = y;
            if (Math.abs(x - marquee.x0) > 3 || Math.abs(y - marquee.y0) > 3) marquee.moved = true;
            cv.style.cursor = 'crosshair';
            paint();
            return;
        }
        if (!drag) {
            const hit = hitTest(x, y);
            cv.style.cursor = hit ? 'grab' : 'crosshair';
            if (hit) {
                const { keys } = keysNow();
                const k = keys[hit.index];
                // 读数浮层与时间轴共用一份实现（editors/drag-tip.mjs），不再自带 .curve-tip
                showTip({
                    x: ev.clientX + 14,
                    y: ev.clientY + 18,
                    text: 't = ' + fmt2(k.t) + ' s · ' + EASE_LABEL[k.ease] + (k.ease === 'bezier' ? ' · h1[' + fmt2(k.h1[0]) + ', ' + fmt2(k.h1[1]) + '] h2[' + fmt2(k.h2[0]) + ', ' + fmt2(k.h2[1]) + ']' : ''),
                });
            } else {
                hideTip();
            }
            return;
        }
        cv.style.cursor = 'grabbing';
        if (drag.kind === 'key') {
            const t = snapTime(xToT(geo, x), ev);
            const v = yToV(geo, y, drag.chId);
            // 目标时刻已经有别的关键帧：在**写之前**就挡掉（与时间轴同一条规矩）。
            // 早先的做法是在 updater 里 return 原轨道，那会白白记一条撤销、还报「关键帧已更新」。
            const cur = keysNow().track;
            if (cur && occupiedAt(cur, drag.chId, t, drag.index)) {
                if (!drag.blockedNotified) {
                    drag.blockedNotified = true;
                    notify(tr('curve.notify.occupied'));
                }
                return;
            }
            writeTrack(drag.layerId, (trk) => {
                // 只有该字段**已经**是独立轨道时才写通道轨；否则挪的就是时间轴上那颗共用菱形
                // （整组一起搬，两个视图永远看同一套时刻）。绝不因为「拖了一下」就顺手提升。
                const r = writeModeOf(trk, drag.chId) === 'channel'
                    ? dragChannelKeyTo(trk, drag.chId, drag.index, t, v)
                    : dragKeyTo(trk, drag.index, t, drag.chId, v, drag.baseState);
                if (r.index >= 0) {
                    drag.index = r.index;
                    sel = { layerId: drag.layerId, chId: drag.chId, index: r.index, part: 'key' };
                }
                return r.track;
            });
        } else {
            const t = xToT(geo, x);
            const v = yToV(geo, y, drag.chId);
            writeTrack(drag.layerId, (trk) => {
                // 手柄同理：共用键的手柄改的是共用键自己的缓动，不该把字段提升成独立轨道
                return writeModeOf(trk, drag.chId) === 'channel'
                    ? dragChannelHandleTo(trk, drag.chId, drag.index, drag.kind, drag.h, drag.span, t, v)
                    : dragHandleTo(trk, drag.index, drag.kind, drag.h, drag.span, t, v);
            });
        }
        paint();
    });

    /** 把矩形里的关键帧收进选择集：当前对象 × 聚焦通道 × 每个 key。 */
    function commitMarquee() {
        const m = marquee;
        marquee = null;
        if (!m) return;
        const { layer, track } = keysNow();
        if (!layer) {
            paint();
            return;
        }
        if (!m.moved) {
            // 没拖动 = 点空白：移播放头并清空选择
            if (typeof ctx.setTime === 'function') ctx.setTime(xToT(geo, m.x0));
            setSel(null);
            paint();
            return;
        }
        const x0 = Math.min(m.x0, m.x1);
        const x1 = Math.max(m.x0, m.x1);
        const y0 = Math.min(m.y0, m.y1);
        const y1 = Math.max(m.y0, m.y1);
        const picked = pickInRect(geo, track, layer.id, focusOnly(), x0, x1, y0, y1);
        if (!m.additive) selKeys = [];
        for (const hit of picked) {
            const dup = selKeys.some((s) => s.layerId === hit.layerId && s.chId === hit.chId && s.index === hit.index && s.part === hit.part);
            if (!dup && selKeys.length < 2000) selKeys.push(hit);
        }
        sel = selKeys[selKeys.length - 1] || null;
        if (picked.length) notify(tr('curve.marquee.picked', { n: picked.length }));
        paint();
    }

    function endDrag(ev) {
        if (marquee) {
            commitMarquee();
            try {
                if (ev && cv.hasPointerCapture && cv.hasPointerCapture(ev.pointerId)) cv.releasePointerCapture(ev.pointerId);
            } catch (err) {
                /* ignore */
            }
            return;
        }
        if (!drag) return;
        drag = null;
        cv.style.cursor = 'crosshair';
        try {
            if (ev && cv.hasPointerCapture && cv.hasPointerCapture(ev.pointerId)) cv.releasePointerCapture(ev.pointerId);
        } catch (err) {
            /* ignore */
        }
        notify(tr('curve.notify.keyUpdated'));
        paint();
    }
    cv.addEventListener('pointerup', endDrag);
    cv.addEventListener('pointercancel', endDrag);
    // capture 丢事件时（切窗口 / 合成事件）window 兜底，避免拖拽态永久卡住
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    /* ── 双击空白：在该时间加关键帧 ── */
    cv.addEventListener('dblclick', (ev) => {
        const { x } = localPoint(ev);
        const hit = hitTest(x, localPoint(ev).y);
        if (hit) return;
        const { doc, layer, track } = keysNow();
        if (!doc || !layer) return;
        // 双击落点同样过磁铁：曲线里新建的关键帧就是时间轴里的那一帧
        const t = snapTime(xToT(geo, x), ev);
        // 没独立就用共用关键帧加点（＝时间轴双击泳道做的同一件事）；已独立才写通道轨
        if (writeModeOf(track, focus) === 'channel') {
            // 取该时刻的**当前求值**显式传入：效果参数通道的 stateAt 不含它的值，
            // 省略 value 会被 core 当成 0，加点就让曲线跳一下。
            const v = sampleChannel(track, t, focus);
            writeTrack(layer.id, (old) => setChannelKey(old, focus, t, v, 'bezier'));
        } else {
            writeTrack(layer.id, (old) => addKey(old, t, stateAt(track, t), 'bezier'));
        }
        if (typeof ctx.setTime === 'function') ctx.setTime(t);
        const after = layerById(docOf(), layer.id);
        const solo = isSolo(trackOf(after), focus);
        const chFocused = metaOf(focus);
        let msg = tr('curve.notify.keyAdded', { t: fmt2(t) });
        if (solo && chFocused) msg += tr('curve.notify.keyAddedSolo', { name: chFocused.short });
        notify(msg);
        paint();
    });

    /* ── 右键：缓动 + 删除 + 回到共用 ── */
    cv.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        closeMenu();
        const { x, y } = localPoint(ev);
        const hit = hitTest(x, y);
        const { layer, track, keys } = keysNow();
        if (!layer) return;
        const solo = isSolo(track, focus);
        // 空白处也允许弹菜单：通道一旦独立，「回到共用」就必须随手可得，
        // 否则用户只能靠删光关键帧来撤销（而删掉最后一个通道键时 core 会静默回到共用）
        if (!hit && !solo) return;
        if (hit) {
            const same = (s) => s.layerId === hit.layerId && s.chId === hit.chId && s.index === hit.index && s.part === hit.part;
            if (!selKeys.some(same)) setSel(hit, false);
            else sel = hit;
            paint();
        }
        const m = document.createElement('div');
        m.className = 'curve-menu';
        if (hit) {
            for (const ease of ['linear', 'bezier', 'hold']) {
                const b = document.createElement('button');
                b.type = 'button';
                b.textContent = EASE_LABEL[ease];
                if (keys[hit.index] && keys[hit.index].ease === ease) b.classList.add('is-on');
                b.addEventListener('click', () => {
                    const chId = hit.chId;
                    writeTrack(layer.id, (trk) => (writeModeOf(trk, chId) === 'channel'
                        ? setChannelKeyEase(trk, chId, hit.index, ease)
                        : setKeyEase(trk, hit.index, ease)));
                    notify(tr('curve.notify.easeChanged', { ease: EASE_LABEL[ease] }));
                    closeMenu();
                    paint();
                });
                m.appendChild(b);
            }
            const del = document.createElement('button');
            del.type = 'button';
            del.className = 'is-danger';
            del.textContent = tr('curve.menu.deleteKey');
            del.addEventListener('click', () => {
                // 右键的删除也走批量：点中的点若在选区里，就删整个选区
                const same = (s) => s.layerId === hit.layerId && s.chId === hit.chId && s.index === hit.index && s.part === hit.part;
                const idxs = selKeys.some(same) ? selectionIndexes(selKeys, layer.id) : [hit.index];
                closeMenu();
                removeKeysOn(layer.id, hit.chId, idxs);
            });
            m.appendChild(del);
        }
        // 效果参数通道本来就是「独立轨道」，没有「回到共用」这回事（清轨＝删掉该参数的全部帧）
        if (solo && !isEffectChannelId(focus)) m.appendChild(soloItem(layer.id, focus));
        m.style.left = Math.round(x) + 'px';
        m.style.top = Math.round(y) + 'px';
        wrap.appendChild(m);
        menu = m;
    });

    /** 批量删点：已有独立轨道就走它自己的键，否则删的是共用关键帧（＝时间轴上那颗菱形）。 */
    function removeKeysOn(layerId, chId, idxs) {
        const list = idxs.slice().sort((a, b) => b - a);
        if (!list.length) return;
        writeTrack(layerId, (trk) => {
            if (writeModeOf(trk, chId) === 'channel') {
                return list.reduce((acc, i) => removeChannelKey(acc, chId, i), trk);
            }
            return list.reduce((acc, i) => removeKey(acc, i), trk);
        });
        setSel(null);
        notify(tr('curve.notify.keysDeleted', { n: list.length }));
    }

    /** 菜单项「回到共用」：删掉该通道的独立轨道。 */
    function soloItem(layerId, chId) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'is-solo-back';
        b.textContent = tr('curve.menu.backToShared');
        b.title = tr('curve.menu.backToSharedHint');
        b.addEventListener('click', () => {
            closeMenu();
            backToShared(layerId, chId);
        });
        return b;
    }

    function backToShared(layerId, chId) {
        const layer = layerById(docOf(), layerId);
        if (!layer || !isSolo(trackOf(layer), chId)) return;
        writeTrack(layerId, (trk) => clearChannel(trk, chId));
        // 选择集里的索引属于刚被删掉的通道轨道，必须一起作废
        setSel(null);
        const ch = metaOf(chId);
        notify(tr('curve.notify.backToShared', { name: ch ? ch.label : chId }));
        paint();
    }

    function closeMenu() {
        if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
        menu = null;
    }

    /* ── 横轴平移：中键（或 Alt+左键）拖动 = 移动时间窗口 ── */
    let pan = null;
    cv.addEventListener('pointerdown', (ev) => {
        if (ev.button !== 1 && !(ev.altKey && ev.button === 0)) return;
        ev.preventDefault();
        ev.stopPropagation();
        const total = totalSeconds(docOf());
        const span = geo ? geo.t1 - geo.t0 : total;
        pan = { x: ev.clientX, t0: geo ? geo.t0 : 0, span: span, total: total, width: Math.max(1, cv.clientWidth) };
        try { cv.setPointerCapture(ev.pointerId); } catch (err) { /* 忽略 */ }
    });
    window.addEventListener('pointermove', (ev) => {
        if (!pan) return;
        const perPx = pan.span / Math.max(1, pan.width - PAD_L - PAD_R);
        const maxOff = Math.max(0, pan.total - pan.span);
        // 往右拖 = 看更早的时间
        timeSpan = pan.span;
        timeOffset = Math.max(0, Math.min(maxOff, pan.t0 - (ev.clientX - pan.x) * perPx));
        paint();
    });
    window.addEventListener('pointerup', () => { pan = null; });

    /* ── 滚轮：横向缩放时间 / Shift 纵向缩放值域 ── */
    cv.addEventListener(
        'wheel',
        (ev) => {
            ev.preventDefault();
            const doc = docOf();
            const total = totalSeconds(doc);
            if (ev.shiftKey) {
                vView = clamp(vView * (ev.deltaY > 0 ? 1.15 : 1 / 1.15), 0.05, 20);
            } else if (ev.ctrlKey || ev.metaKey) {
                timeSpan = clamp((timeSpan > 0 ? timeSpan : total) * (ev.deltaY > 0 ? 1.2 : 1 / 1.2), 0.05, total);
            } else {
                const t0 = geo.t1 - geo.t0;
                timeSpan = clamp(t0 * (ev.deltaY > 0 ? 1.2 : 1 / 1.2), 0.05, total);
            }
            paint();
        },
        { passive: false }
    );

    /* ── 键盘 ── */
    function onKey(ev) {
        if (root.offsetParent === null) return;
        const tag = ev.target && ev.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        // Ctrl+A：把聚焦通道上所有关键帧一次选中（配合批量缓动 / 批量删除）
        if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'a' || ev.key === 'A')) {
            const { layer, keys } = keysNow();
            if (!layer || !keys.length) return;
            ev.preventDefault();
            const ch = metaOf(focus);
            if (!ch) return;
            selKeys = [];
            for (let i = 0; i < keys.length; i += 1) selKeys.push({ layerId: layer.id, chId: ch.id, index: i, part: 'key' });
            sel = selKeys[selKeys.length - 1] || null;
            // 报数只由时间轴负责（同屏时两边都响应 Ctrl+A，各报一条会盖成两条）
            paint();
            return;
        }
        if (ev.key === 'Delete' && selKeys.length) {
            ev.preventDefault();
            const { layer } = keysNow();
            if (!layer) return;
            // 选区只可能落在聚焦通道上（参考线只读），所以统一交给 removeKeysOn 按通道分派
            const chId = sel ? sel.chId : focus;
            const idxs = selectionIndexes(selKeys, layer.id);
            if (!idxs.length) return;
            removeKeysOn(layer.id, chId, idxs);
            paint();
            return;
        }
        // Alt+A：取消全部（与上面的 Ctrl+A 全选成对，Blender 同款）
        if (ev.altKey && !ev.ctrlKey && !ev.metaKey && (ev.key === 'a' || ev.key === 'A')) {
            ev.preventDefault();
            setSel(null);
            paint();
            return;
        }
        // Ctrl+I：反选 —— 聚焦通道上「还没被选中」的关键帧全部选上
        if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'i' || ev.key === 'I')) {
            const { layer, keys } = keysNow();
            const ch = metaOf(focus);
            if (!layer || !ch || !keys.length) return;
            ev.preventDefault();
            const next = [];
            for (let i = 0; i < keys.length; i += 1) {
                const hit = { layerId: layer.id, chId: ch.id, index: i, part: 'key' };
                if (!isSelKey(hit)) next.push(hit);
            }
            selKeys = next;
            sel = next[next.length - 1] || null;
            // 同上：选择集照改，报数交给时间轴（它读的是全片关键帧，文案统一用「颗」）
            paint();
            return;
        }
        if (ev.key === 'Escape') {
            setSel(null);
            closeMenu();
            closePop();
            paint();
        }
    }
    document.addEventListener('keydown', onKey);

    /* ── 订阅 ── */
    let unsub = null;
    if (typeof ctx.subscribeDoc === 'function') {
        unsub = ctx.subscribeDoc(() => {
            const doc = docOf();
            const layer = activeLayer(doc);
            const sig = (layer ? layer.id : 'none') + '|' + celTimes(layer).length + '|' + focus + '|' + [...refs].join(',');
            if (sig !== lastSig) {
                lastSig = sig;
                setSel(null);
            }
            paint();
        });
    }

    /**
     * 对象一旦有了非零 warp，就在通道按钮上挂个点。
     * 通道收进弹出面板后，没有这个提示用户不会知道网格顶点也有曲线可看。
     */
    function autoRevealWarp() {
        const { layer } = keysNow();
        let has = false;
        for (const k of trackOf(layer).keys || []) {
            const lat = normalizeLattice(k.state && k.state.warp);
            if (!lat) continue;
            if (!latticeIsZero(lat) || lat.cols > 1 || lat.rows > 1) {
                has = true;
                break;
            }
        }
        chBtn.classList.toggle('has-warp', has);
    }

    const ro = new ResizeObserver(() => paint());
    ro.observe(wrap);

    autoRevealWarp();
    paint();

    return {
        destroy() {
            document.removeEventListener('keydown', onKey);
            document.removeEventListener('pointerdown', onDocDown, true);
            document.removeEventListener('ms:channel-key-click', onChannelKeyClick);
            ro.disconnect();
            if (typeof unsub === 'function') unsub();
            closeMenu();
            closePop();
        },
        refresh() {
            autoRevealWarp();
            paint();
        },
        focusFrame() {
            paint();
        },
        // 时间轴点通道关键帧时外壳/时间轴派 ms:channel-key-click，本模块自己接住；
        // 这个导出给测试与将来的「从别处定位某通道」用。
        focusChannel,
    };
}
