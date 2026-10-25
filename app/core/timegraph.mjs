// 时间图（v5）：把「时间」变成可组合、可嵌套、可微的变换。
//
// 模型：
//   全局时间 t
//     └─ 对象时间通道（offset / scale / loop / pingpong / clamp / hold，沿 parentId 嵌套）
//          └─ 局部时间 t'
//               └─ 属性轨道（贝塞尔）→ 状态
//
// 本模块是纯函数集合：零 DOM、零副作用、不改入参、任何非法输入都不抛异常。

import { drawOrderOf, normalizeDrawOrder } from './draw-order.mjs';

// 这里刻意不 import doc-model 的 objectsOf：doc-model 反过来要用本模块的
// normalizeTime / isIdentityTime，互相 import 会成环，导致整个 shell 的绑定
// 全部 uninitialized（历史上真把 app 打成白屏过）。就三行，内联。
function objectsOf(doc) {
    if (!doc) return [];
    if (Array.isArray(doc.objects)) return doc.objects;
    if (Array.isArray(doc.layers)) return doc.layers;
    return [];
}

function byId(doc, id) {
    const key = id == null ? '' : String(id);
    return objectsOf(doc).find((o) => o && String(o.id) === key) || null;
}

/** 按文档自己的字段名写回对象数组（v6 用 objects，旧文档用 layers）。 */
function withObjects(doc, list) {
    return Array.isArray(doc.objects) ? { ...doc, objects: list } : { ...doc, layers: list };
}

/** 恒等时间通道（冻结对象，避免被误改）。 */
export const TIME_IDENTITY = Object.freeze({
    offset: 0,
    scale: 1,
    mode: 'none',
    from: 0,
    to: 0,
    hold: false,
    holdAt: 0,
    ease: 'linear',
});

export const TIME_MODES = Object.freeze(['none', 'loop', 'pingpong', 'clamp']);

/** 时间重映射的缓动档位：让「时间流速」本身非线性（微分平滑的时间轴）。 */
export const TIME_EASES = Object.freeze(['linear', 'in', 'out', 'inout']);

/** 父链遍历上限，防环挂死。 */
const MAX_DEPTH = 64;
const EPS = 1e-9;

function num(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function clampNum(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 任意脏输入 → 合法时间通道。永不抛异常。
 * @param {any} time
 */
export function normalizeTime(time) {
    if (!time || typeof time !== 'object') return { ...TIME_IDENTITY };
    const mode = TIME_MODES.includes(time.mode) ? time.mode : 'none';
    return {
        offset: clampNum(num(time.offset, 0), -1e6, 1e6),
        scale: clampNum(num(time.scale, 1), -100, 100),
        mode,
        from: Math.max(0, num(time.from, 0)),
        to: Math.max(0, num(time.to, 0)),
        hold: time.hold === true,
        holdAt: Math.max(0, num(time.holdAt, 0)),
        ease: TIME_EASES.includes(time.ease) ? time.ease : 'linear',
    };
}

/**
 * 是否恒等（不做任何时间变形）。
 *
 * 口径：mode === 'none' 时 from/to 是惰性字段，不参与判定 ——
 * 否则会出现「徽章亮着、悬浮说明却写『无时间变换』」的矛盾（见 describeTime）。
 */
export function isIdentityTime(time) {
    if (!time || typeof time !== 'object') return true;
    const t = normalizeTime(time);
    return (
        t.offset === 0 &&
        t.scale === 1 &&
        t.mode === 'none' &&
        t.hold === false &&
        t.holdAt === 0 &&
        t.ease === 'linear'
    );
}

/**
 * 非负取模。边界值（x 恰为 span 的整数倍，或与边界相差 < EPS）返回 x 本身，
 * 避免浮点误差把 0.5 掉成 0.4999999999。
 *
 * 注意：返回值可能等于或略超过 span —— 调用方不得假设结果恒在 [0, span)。
 * 这是「边界保留」语义的直接后果（契约 §1）。
 */
export function modSpan(x, span) {
    const s = Number(span);
    if (!(s > 0) || !Number.isFinite(s)) return 0;
    const v = Number(x);
    if (!Number.isFinite(v)) return 0;
    const r = v - Math.floor(v / s) * s;
    // 精确落在边界两侧都还原成原值，否则正常返回余数
    if (r <= EPS || s - r <= EPS) return v;
    return r;
}

/**
 * 单层时间变换：全局时间 → 局部时间。
 * @param {any} time  时间通道（脏输入也行）
 * @param {number} tGlobal
 * @param {number} totalSec  文档总时长（秒），<=0 时不做 loop 折算
 */
/** 二次缓动：u∈[0,1] → u'。只用二次，够平滑且没有求根开销。 */
function easeCurve(kind, u) {
    if (kind === 'in') return u * u;
    if (kind === 'out') return 1 - (1 - u) * (1 - u);
    if (kind === 'inout') return u < 0.5 ? 2 * u * u : 1 - 2 * (1 - u) * (1 - u);
    return u;
}

/**
 * 时间重映射：在 [from, from+span] 区间内把位置按缓动曲线压/推。
 * 只在单调模式（none / clamp）下生效 —— loop / pingpong 是周期性的，
 * 再加缓动会破坏「首尾相等」，让循环接缝处跳一下。
 */
function retime(t, raw, span) {
    if (t.ease === 'linear' || !(span > 0)) return raw;
    if (t.mode === 'loop' || t.mode === 'pingpong') return raw;
    const u = (raw - t.from) / span;
    if (!(u > 0) || !(u < 1)) return raw;
    return t.from + span * easeCurve(t.ease, u);
}

export function applyTime(time, tGlobal, totalSec) {
    const t = normalizeTime(time);
    const g = num(tGlobal, 0);
    if (t.hold) return Math.max(0, t.holdAt);
    const total = Math.max(0, num(totalSec, 0));
    if (t.scale === 0) return Math.max(0, t.holdAt);
    const span = t.to > t.from ? t.to - t.from : total;
    const raw = retime(t, (g - t.offset) * t.scale, span);
    if (t.mode === 'none') return raw;
    if (!(span > 0)) return raw;
    const rel = raw - t.from;
    if (t.mode === 'loop') return t.from + modSpan(rel, span);
    if (t.mode === 'clamp') {
        const lo = t.from;
        const hi = t.from + span;
        return raw < lo ? lo : raw > hi ? hi : raw;
    }
    if (t.mode === 'pingpong') {
        const m = modSpan(rel, span * 2);
        return t.from + (m <= span ? m : span * 2 - m);
    }
    return raw;
}

/** 取文档总时长；容错。 */
// 不 import cel.mjs 的 totalSeconds：cel → doc-model → 本模块，互相 import 会成环
// （会静默打挂整个 shell 的模块绑定）。自己扫对象纹理，语义一致。
export function docTotal(doc) {
    try {
        const declared = doc && typeof doc.duration === 'number' && doc.duration > 0 ? doc.duration : 0;
        let content = 0;
        for (const obj of objectsOf(doc)) {
            const cels = obj && Array.isArray(obj.cels) ? obj.cels : [];
            for (const cel of cels) {
                const at = cel && typeof cel.at === 'number' ? cel.at : 0;
                if (at > content) content = at;
            }
        }
        const total = Math.max(declared, content);
        return Number.isFinite(total) && total > 0 ? total : 0;
    } catch (err) {
        return 0;
    }
}

/** 对象 id → 对象。 */
export function layerById(doc, id) {
    if (!doc || id == null) return null;
    return objectsOf(doc).find((l) => l && l.id === id) || null;
}

/** 父链深度（不含自身）。遇环/超深立即停。 */
export function timeDepth(doc, layer) {
    if (!doc || !layer) return 0;
    let node = layer;
    let depth = 0;
    const seen = new Set([layer.id]);
    while (node && node.parentId != null && depth < MAX_DEPTH) {
        if (seen.has(node.parentId)) break;
        seen.add(node.parentId);
        node = layerById(doc, node.parentId);
        if (!node) break;
        depth++;
    }
    return depth;
}

/**
 * 多层时间变换：沿 parentId 链逐级 applyTime。
 * 父对象的时间通道先作用，子对象再作用。
 */
export function localTimeOf(doc, layer, tGlobal) {
    if (!doc || !layer) return num(tGlobal, 0);
    const total = docTotal(doc);
    // 先收集父链（由根到叶）
    const chain = [];
    let node = layer;
    let depth = 0;
    const seen = new Set();
    while (node && depth < MAX_DEPTH) {
        if (seen.has(node.id)) break;
        seen.add(node.id);
        chain.push(node);
        if (node.parentId == null) break;
        node = layerById(doc, node.parentId);
        depth++;
    }
    let t = num(tGlobal, 0);
    for (let i = chain.length - 1; i >= 0; i--) {
        t = applyTime(chain[i].time, t, total);
        if (!Number.isFinite(t)) return num(tGlobal, 0);
    }
    return t;
}

/**
 * 某个对象是不是 another 的后代（用于环检测）。
 *
 * fail-closed：若父链在 MAX_DEPTH 以内没走完（超深链，或中途数据损坏），
 * 保守返回 true —— 宁可拒绝一次合法设父，也不能放行一个会造环的操作（契约 §2）。
 */
export function isDescendant(doc, maybeChild, maybeAncestor) {
    if (!doc || !maybeChild || !maybeAncestor) return false;
    if (maybeChild.id === maybeAncestor.id) return false;
    let node = maybeChild;
    let depth = 0;
    const seen = new Set([maybeChild.id]);
    while (node && node.parentId != null && depth < MAX_DEPTH) {
        if (node.parentId === maybeAncestor.id) return true;
        if (seen.has(node.parentId)) return false;
        seen.add(node.parentId);
        node = layerById(doc, node.parentId);
        depth++;
    }
    // 走到这里：要么父链正常走完（node 为根或悬空 id），要么撞上 MAX_DEPTH，要么遇环。
    // 遇环已在上面的 seen 分支返回 false；撞上限则保守判真。
    if (node && node.parentId != null) return true;
    return false;
}

/**
 * 设置父对象（不可变）。成环 / 父不存在 → 返回原 doc 且 ok:false。
 * @returns {{doc: any, ok: boolean, reason: string}}
 */
export function setParent(doc, id, parentId, offsetOf) {
    if (!doc || !objectsOf(doc).length) return { doc, ok: false, reason: '没有文档' };
    const child = layerById(doc, id);
    if (!child) return { doc, ok: false, reason: '找不到该对象' };
    if (parentId == null) {
        if (child.parentId == null) return { doc, ok: true, reason: '' };
    } else {
        const parent = layerById(doc, parentId);
        if (!parent) return { doc, ok: false, reason: '父对象不存在' };
        if (parentId === id) return { doc, ok: false, reason: '不能把自己设为父对象' };
        if (isDescendant(doc, parent, child)) return { doc, ok: false, reason: '会形成父子环' };
        if (child.parentId === parentId) return { doc, ok: true, reason: '' };
    }
    const nextParentId = parentId == null ? null : parentId;
    const shifted = shiftKeysForReparent(child, nextParentId, offsetOf);
    if (!shifted.ok) return { doc, ok: false, reason: shifted.reason };
    return {
        doc: withObjects(doc, objectsOf(doc).map((l) => (l.id === id ? { ...shifted.el, parentId: nextParentId } : l))),
        ok: true,
        reason: '',
    };
}

/**
 * 换父时按「当下这一刻」算一次 x/y 位移，并把它加到**所有**关键帧上。
 *
 * 为什么不逐帧各算一次：换父之后子对象会跟随父运动，这是父子层级的定义
 * （父带关键帧时子当然跟着动）。要保的是「换父这一刻画面不跳」，同时不改变
 * 子对象自身的动画形态 —— 整体平移不改变任何两帧之间的相对关系。
 * 逐帧各算一次会把子对象自己的动画曲线也改写掉，那是另一种损坏。
 *
 * 没有 `offsetOf` 时原样返回（旧行为，给不关心几何的调用方与老测试留后路）。
 */
function shiftKeysForReparent(el, parentId, offsetOf) {
    if (typeof offsetOf !== 'function') return { ok: true, el };
    const tr = el && el.transform;
    const keys = tr && Array.isArray(tr.keys) ? tr.keys : [];
    if (!keys.length) return { ok: true, el };
    const r = offsetOf(el, parentId);
    if (!r || r.ok !== true) {
        return { ok: false, reason: (r && r.reason) || '换父时无法换算位置，已取消' };
    }
    const dx = Number(r.dx) || 0;
    const dy = Number(r.dy) || 0;
    if (!dx && !dy) return { ok: true, el };
    const next = keys.map((k) => {
        const st = k && k.state && typeof k.state === 'object' ? k.state : {};
        const x = Number(st.x) || 0;
        const y = Number(st.y) || 0;
        // 「|| 0」把 -0 归一成 0
        return { ...k, state: { ...st, x: (x + dx) || 0, y: (y + dy) || 0 } };
    });
    return { ok: true, el: { ...el, transform: { ...tr, keys: next } } };
}

/**
 * 整棵子树搬家（纯函数）：换父 + 重排，一次产出新文档 —— 对象面板三区拖拽用。
 *
 * 为什么要有它：`setParent` 与 `reorderObject` 各写一次文档，拼起来是两条撤销记录，
 * 中间态还会让子对象短暂挂在旧位置。拖父对象时那半帧很显眼。
 *
 * 不变量：①换父走 `offsetOf`（保位置，见 setParent）②子树连续且「父在子前」
 * ③`before` 插在目标之前、`after`/`into` 插在**目标整棵子树**之后、`rootEnd` 落根层末尾。
 *
 * @param {object} doc
 * @param {string} id 被移动的对象
 * @param {'before'|'after'|'into'|'rootEnd'} mode
 * @param {string|null} targetId
 * @param {(el:object, parentId:string|null) => {ok:boolean, dx?:number, dy?:number, reason?:string}} [offsetOf]
 * @returns {{ok:boolean, doc?:object, reason?:string}}
 */
export function moveSubtreeDoc(doc, id, mode, targetId, offsetOf) {
    if (!doc || !id) return { ok: false, reason: '没有可移动的对象' };
    if (mode !== 'before' && mode !== 'after' && mode !== 'into' && mode !== 'rootEnd') {
        return { ok: false, reason: '移动方式不合法' };
    }
    const el = byId(doc, id);
    if (!el) return { ok: false, reason: '找不到要移动的对象' };
    const tid = targetId == null ? null : String(targetId);
    let parentId = null;
    if (mode !== 'rootEnd') {
        if (!tid) return { ok: false, reason: '没有指定目标对象' };
        if (tid === String(id)) return { ok: false, reason: '不能把对象移动到它自己身上' };
        const target = byId(doc, tid);
        if (!target) return { ok: false, reason: '目标对象不存在' };
        if (isDescendant(doc, target, el)) {
            return { ok: false, reason: '不能把对象移动到自己的子对象里' };
        }
        parentId = mode === 'into' ? target.id : (target.parentId == null ? null : target.parentId);
    }
    // 1) 先换父（L1 的保位置换算），不传 offsetOf 时退化为只改 parentId
    const curParent = el.parentId == null ? null : el.parentId;
    let base = doc;
    if (parentId !== curParent) {
        const r = setParent(doc, id, parentId, offsetOf);
        if (!r.ok) return r;
        base = r.doc;
    }
    // 2) 再按「父先子后」的既有顺序把整棵子树搬过去
    const subIds = collectSubtree(base, id);
    const subSet = new Set(subIds);
    const moving = subIds.map((sid) => byId(base, sid)).filter(Boolean);
    if (!moving.length || String(moving[0].id) !== String(id)) {
        return { ok: false, reason: '对象结构异常，已取消' };
    }
    const rest = objectsOf(base).filter((x) => x && !subSet.has(x.id));
    let at;
    if (mode === 'rootEnd') {
        at = rest.length;
    } else {
        // 目标自己可能也带着子树：插在它整棵子树之后，别插进它和它孩子中间
        const tSet = new Set(collectSubtree(base, tid));
        let last = -1;
        rest.forEach((x, i) => { if (tSet.has(x.id)) last = i; });
        if (last < 0) return { ok: false, reason: '目标对象不在可插入的位置' };
        if (mode === 'before') {
            const ti = rest.findIndex((x) => x && String(x.id) === tid);
            if (ti < 0) return { ok: false, reason: '目标对象不在可插入的位置' };
            at = ti;
        } else {
            at = last + 1;
        }
    }
    const next = rest.slice(0, at).concat(moving, rest.slice(at));
    // 3) 叠放顺序跟着子树块一起搬（v10）：层级与叠放各管一处，但「拖到 A 的下面」这个意图
    //    在列表上表达的是**显示位置**，而列表按 drawOrder 排。只动数组不动 drawOrder，
    //    结果会是「树里插到 A 下面、叠放里留在原地」—— 用户看到的就是拖了没反应。
    const order = drawOrderOf(base).filter((oid) => !subSet.has(oid));
    let oAt = order.length;
    if (mode !== 'rootEnd' && tid) {
        const tSet = new Set(collectSubtree(base, tid));
        const first = order.findIndex((oid) => tSet.has(oid));
        if (first >= 0) {
            if (mode === 'before') {
                oAt = first;
            } else {
                let last = first;
                order.forEach((oid, i) => { if (tSet.has(oid)) last = i; });
                oAt = last + 1;
            }
        }
    }
    const nextOrder = order.slice(0, oAt).concat(subIds, order.slice(oAt));
    return {
        ok: true,
        doc: Object.assign({}, withObjects(base, next), {
            drawOrder: normalizeDrawOrder(next, nextOrder),
        }),
    };
}

/**
 * 找出「父子链上成环」的对象 id。
 *
 * 手改存档、外部工具生成的文件、或两个对象互相把对方设成父级时会出现环。
 * 渲染与求值层遇到环只能跳过（否则无限递归），于是那些对象静默消失 ——
 * 用户看到的是「对象不见了」而没有任何解释。这里把环上的 id 找出来交给 UI 提示，
 * **不改任何层级语义**，只是把「静默」变成「说一句」。
 */
export function cycleIds(doc) {
    const list = objectsOf(doc);
    const map = new Map();
    for (const o of list) if (o && o.id != null) map.set(String(o.id), o);
    const out = [];
    for (const o of list) {
        if (!o || o.id == null) continue;
        const start = String(o.id);
        const seen = new Set([start]);
        let node = o;
        let depth = 0;
        while (node && node.parentId != null && depth < MAX_DEPTH) {
            const key = String(node.parentId);
            if (seen.has(key)) {
                out.push(start);
                break;
            }
            seen.add(key);
            node = map.get(key) || null;
            depth += 1;
        }
    }
    return out;
}

/** 直接子对象（保持 layers 数组顺序）。 */
export function childrenOf(doc, parentId) {
    if (!doc) return [];
    return objectsOf(doc).filter((l) => l && l.parentId != null && l.parentId === parentId);
}
/**
 * 以 id 为根的整棵子树（含自身），广度优先，按层级顺序返回 id 数组。
 * 环引用与缺失父级都安全：每个 id 只进一次。
 * 「组时间」靠它一次性套到整棵树上，而不是逐个对象手点。
 */
export function collectSubtree(doc, id) {
    if (!doc || id == null) return [];
    const byParent = new Map();
    for (const l of objectsOf(doc)) {
        if (!l || l.id == null || l.parentId == null) continue;
        const list = byParent.get(l.parentId);
        if (list) list.push(l.id);
        else byParent.set(l.parentId, [l.id]);
    }
    // 起点不在文档里就什么都不做（否则会返回不存在的 id）
    if (!objectsOf(doc).some((l) => l && l.id === id)) return [];
    const out = [];
    const seen = new Set();
    const queue = [id];
    while (queue.length) {
        const cur = queue.shift();
        if (cur == null || seen.has(cur)) continue;
        seen.add(cur);
        out.push(cur);
        const kids = byParent.get(cur);
        if (kids) for (const k of kids) if (!seen.has(k)) queue.push(k);
    }
    return out;
}

/** 子树里的后代数量（不含自身）。面板用它决定要不要显示「套用子树」按钮。 */
export function subtreeSize(doc, id) {
    return Math.max(0, collectSubtree(doc, id).length - 1);
}

/** 根对象。 */
export function rootLayers(doc) {
    if (!doc) return [];
    return objectsOf(doc).filter((l) => l && (l.parentId == null || !layerById(doc, l.parentId)));
}

/** 删对象时把它的直接子对象提升为根（不可变）。 */
export function detachChildren(doc, id) {
    if (!doc) return doc;
    let touched = false;
    const layers = objectsOf(doc).map((l) => {
        if (l && l.parentId === id) {
            touched = true;
            return { ...l, parentId: null };
        }
        return l;
    });
    if (!touched) return doc;
    return Array.isArray(doc.objects) ? { ...doc, objects: layers } : { ...doc, layers };
}

/** 给 UI 用的一句话摘要。 */
export function describeTime(time) {
    const t = normalizeTime(time);
    if (isIdentityTime(t)) return '无时间变换';
    if (t.hold) return '冻结在 ' + t.holdAt.toFixed(2) + 's';
    if (t.scale === 0) return '冻结在 ' + t.holdAt.toFixed(2) + 's';
    const parts = [];
    if (t.offset !== 0) parts.push((t.offset > 0 ? '延后 ' : '提前 ') + Math.abs(t.offset).toFixed(2) + 's');
    if (t.scale !== 1) parts.push('×' + (Math.round(t.scale * 100) / 100));
    if (t.ease !== 'linear') {
        const easeLabel = { in: '渐快', out: '渐慢', inout: '先慢后快再慢' }[t.ease] || t.ease;
        parts.push('缓动 ' + easeLabel);
    }
    if (t.mode !== 'none') {
        const label = { loop: '循环', pingpong: '往返', clamp: '夹取' }[t.mode] || t.mode;
        const span = t.to > t.from ? t.from.toFixed(2) + '–' + t.to.toFixed(2) + 's' : '全片';
        parts.push(label + ' ' + span);
    }
    return parts.length ? parts.join(' · ') : '无时间变换';
}

/** 轨道全部关键帧时间在时间通道作用后的采样点（给曲线编辑器用）。 */
export function mapTrackTimes(doc, layer, times) {
    if (!Array.isArray(times)) return [];
    return times.map((t) => localTimeOf(doc, layer, t));
}
