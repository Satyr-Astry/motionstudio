/**
 * 对象层级键盘接线（L4）。
 *
 * Alt+↑ / Alt+↓：在同级里上移 / 下移
 * Alt+→：缩进成「上一个兄弟」的子对象
 * Alt+←：提升为父级的兄弟（紧跟父之后）
 *
 * 两条纪律：
 * 1. 「移到哪」一律由 `app/core/layer-order.mjs` 的纯函数算，这里不重算几何；
 * 2. 「怎么写」一律走 `ctx.moveSubtree` —— 一次 setDoc、一条撤销、整棵子树一起搬，
 *    换父时由它负责保持世界位置（见 timegraph.mjs 的 reparentOffset）。
 *    所以这里不需要、也不允许再调 setLayerParent / moveLayerTo（那会变成两条撤销）。
 *
 * 键盘到方向的翻译同样在 core 里（layerKeyFromEvent），本文件只做「粘合」：
 * 判焦点、取选中、查 doc、交给 ctx、必要时吃掉按键。
 */
import { layerKeyFromEvent, layerKeyTarget } from '../core/layer-order.mjs';

/** 输入态：这些地方按方向键是在改文字，不是在排层级。 */
export function isTypingTarget(el) {
    if (!el || typeof el !== 'object') return false;
    const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return el.isContentEditable === true;
}

/**
 * 方向键 → `ctx.moveSubtree` 的参数。
 *
 * @param {Array} objects 文档对象数组（顺序即层序）
 * @param {string} id 被移动的对象
 * @param {'up'|'down'|'left'|'right'} key
 * @returns {{mode: 'before'|'after'|'into', targetId: string}|null} null = 这一侧到底了
 */
export function resolveMove(objects, id, key) {
    const list = Array.isArray(objects) ? objects : [];
    if (!id || !list.length) return null;
    const self = list.find((o) => o && o.id === id);
    if (!self) return null;
    const target = layerKeyTarget(list, id, key);
    if (!target) return null;
    if (key === 'up' || key === 'down') {
        // siblingMoveTarget 给的是「目标兄弟」在平铺数组里的下标
        const node = list[target.index];
        if (!node || node.id === id) return null;
        return { mode: key === 'up' ? 'before' : 'after', targetId: node.id };
    }
    if (key === 'right') {
        // 往里：demoteTarget 的 parentId 就是「上一个兄弟」的 id
        if (!target.parentId) return null;
        return { mode: 'into', targetId: target.parentId };
    }
    // 往外（left）：提升到父级同层、紧跟父之后。moveSubtreeDoc 的 after 是「插在目标整棵子树之后」，
    // 以父为目标正好落在「父 →（父的子孙）… → 自己」，在父这一层上就是紧接父之后。
    const parentId = typeof self.parentId === 'string' && self.parentId ? self.parentId : null;
    if (!parentId) return null;
    return { mode: 'after', targetId: parentId };
}

/**
 * 挂上键盘监听。
 *
 * @param {object} ctx 外壳上下文（需要 `moveSubtree`；`selection()` / `activeLayerId()` / `doc()` 用来定位选中对象）
 * @param {{target?: EventTarget}} [options] 便于在测试里换掉事件源
 * @returns {() => void} 卸载
 */
export function installLayerKeys(ctx, options) {
    if (!ctx || typeof ctx.moveSubtree !== 'function') return () => {};
    const target = (options && options.target) || (typeof window === 'object' ? window : null);
    if (!target || typeof target.addEventListener !== 'function') return () => {};
    let seq = 0;

    const onKey = (e) => {
        if (!e || e.defaultPrevented) return;
        if (e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (isTypingTarget(e.target)) return;
        const key = layerKeyFromEvent(e);
        if (!key) return;
        const sel = typeof ctx.selection === 'function' ? ctx.selection() : null;
        const id = (sel && sel.id) || (typeof ctx.activeLayerId === 'function' ? ctx.activeLayerId() : null);
        if (!id) return;
        const doc = typeof ctx.doc === 'function' ? ctx.doc() : null;
        const objects = doc ? (Array.isArray(doc.objects) ? doc.objects : doc.layers) : null;
        if (!Array.isArray(objects)) return;
        // 钥匙认领了这个按键就吃掉它：Alt+← 在别的宿主里是「后退」，到边界时也不该触发导航
        e.preventDefault();
        const move = resolveMove(objects, id, key);
        if (!move) return;
        // 每次按键一个撤销步：默认的「手势合并」会把 350ms 内的连续几次移动并成一步，
        // 那样按三下 Alt+↑ 再 Ctrl+Z 会一次退三步。传一个每次不同的合并键即可关掉合并。
        seq += 1;
        ctx.moveSubtree(id, Object.assign({ coalesce: 'layer-keys-' + seq }, move));
    };

    target.addEventListener('keydown', onKey);
    return () => target.removeEventListener('keydown', onKey);
}
