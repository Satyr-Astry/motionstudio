/**
 * Kleks Motion —— 区域树的矩形求解器（Blender 式区域布局的几何内核）
 *
 * 为什么不是嵌套 flex：`<iframe>` 一旦被移动父节点就会重新加载。
 * 嵌套 flex 意味着任何 split/join/swap 都要移动含 iframe 的 DOM 节点，
 * 画布会重载、撤销历史会清空。所以布局改为「宿主是 relative，每个区域是 absolute」，
 * 结构变化只改 left/top/width/height —— DOM 节点从不搬家。
 *
 * 约定与 shell/areas.mjs 一致：纯函数，不改入参，非法输入返回等价结果而非抛异常。
 */

export const SPLITTER = 6;
export const MIN_AREA = 72;
// 折叠后的区域只留标题栏（24px = .area-head 高度）。折叠不是「最小化」：
// 它的高度是写死的，不参与剩余空间分配，也不会被 MIN_AREA 抬起来。
export const COLLAPSED_AREA = 24;

/**
 * 在一根轴上把 total 分给若干子节点。
 * 语义与 areas.mjs 的 size/grow 对齐：有 size 用像素，没 size 的瓜分剩余。
 */
export function distribute(children, total) {
    const n = children.length;
    if (!n) return [];
    const pinned = children.map((c) => !!(c && c.collapsed === true));
    const raw = children.map((c, i) => {
        if (pinned[i]) return COLLAPSED_AREA;
        return c && typeof c.size === 'number' && Number.isFinite(c.size) && c.size >= 0 ? c.size : null;
    });
    const flex = [];
    let fixedSum = 0;
    raw.forEach((s, i) => (s === null ? flex.push(i) : (fixedSum += s)));

    // 折叠区吃固定高度/宽度，不参与「剩余空间」的分配与归一
    const pinnedSum = raw.reduce((acc, s, i) => acc + (pinned[i] ? s : 0), 0);
    const free = Math.max(0, total - pinnedSum);

    let out;
    if (!flex.length) out = raw.slice();
    else if (!fixedSum) out = raw.map((s, i) => (pinned[i] ? s : free / flex.length));
    else {
        const rest = Math.max(0, free - fixedSum);
        out = raw.map((s) => (s === null ? rest / flex.length : s));
    }

    // 只把「非折叠」的项归一到 free，折叠项的尺寸保持写死值
    const sum = out.reduce((acc, s, i) => acc + (pinned[i] ? 0 : s), 0);
    if (sum > 0 && Math.abs(sum - free) > 0.5) {
        out = out.map((s, i) => (pinned[i] ? s : (s / sum) * free));
    }

    // 抬升低于下限的项，从最宽裕的项里等比借
    const floor = Math.min(MIN_AREA, total / n);
    for (let pass = 0; pass < 4; pass++) {
        let deficit = 0;
        const donors = [];
        for (let i = 0; i < n; i++) {
            if (pinned[i]) continue;   // 折叠区高度写死，既不抬升也不当捐赠者
            if (out[i] < floor - 1e-6) {
                deficit += floor - out[i];
                out[i] = floor;
            } else donors.push(i);
        }
        if (deficit <= 1e-6) break;
        const above = donors.reduce((acc, i) => acc + (out[i] - floor), 0);
        if (above <= 1e-6) break;
        for (const i of donors) out[i] -= deficit * ((out[i] - floor) / above);
    }
    return out;
}

/**
 * 把区域树求成一张矩形表。
 * @returns {{areas: {id,editor,rect,path}[], splitters: {path,dir,parentPath,index,rect}[]}}
 */
export function computeRects(root, rect, acc) {
    const out = acc || { areas: [], splitters: [] };
    const frame = { x: rect.x, y: rect.y, w: Math.max(0, rect.w), h: Math.max(0, rect.h) };

    const walk = (node, r, path) => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'area') {
            out.areas.push({ id: node.id, editor: node.editor, rect: r, path, collapsed: node.collapsed === true });
            return;
        }
        if (node.type !== 'split' || !Array.isArray(node.children) || !node.children.length) return;
        const dir = node.dir === 'col' ? 'col' : 'row';
        const n = node.children.length;
        const total = dir === 'row' ? r.w : r.h;
        const avail = Math.max(0, total - SPLITTER * (n - 1));
        const sizes = distribute(node.children, avail);
        let off = dir === 'row' ? r.x : r.y;
        for (let i = 0; i < n; i++) {
            const len = sizes[i];
            const cr =
                dir === 'row'
                    ? { x: off, y: r.y, w: len, h: r.h }
                    : { x: r.x, y: off, w: r.w, h: len };
            walk(node.children[i], cr, path.concat(i));
            off += len;
            if (i < n - 1) {
                out.splitters.push({
                    path: path.concat(i),
                    parentPath: path,
                    index: i,
                    dir,
                    rect:
                        dir === 'row'
                            ? { x: off, y: r.y, w: SPLITTER, h: r.h }
                            : { x: r.x, y: off, w: r.w, h: SPLITTER },
                });
                off += SPLITTER;
            }
        }
    };

    walk(root, frame, []);
    return out;
}

/** 按路径替换节点（path 为空表示替换根）。 */
export function withNode(node, path, fn) {
    if (!path || !path.length) return fn(node);
    if (!node || node.type !== 'split' || !Array.isArray(node.children)) return node;
    const [head, ...tail] = path;
    if (head < 0 || head >= node.children.length) return node;
    const children = node.children.slice();
    children[head] = withNode(children[head], tail, fn);
    return Object.assign({}, node, { children });
}

/**
 * 拖动分隔条：把两侧兄弟钉成像素尺寸。
 * delta 为正表示往后拖（前一个变大，后一个变小）。
 */
export function resizeAcross(root, parentPath, index, delta, floor) {
    const min = floor || MIN_AREA;
    return withNode(root, parentPath, (split) => {
        if (!split || split.type !== 'split') return split;
        const children = split.children.slice();
        const a = children[index];
        const b = children[index + 1];
        if (!a || !b) return split;
        const dir = split.dir === 'col' ? 'col' : 'row';
        // 当前尺寸由实际 rect 决定，调用方把实测像素从 a.size/b.size 传进来
        const sa = typeof a.size === 'number' ? a.size : min;
        const sb = typeof b.size === 'number' ? b.size : min;
        const sum = sa + sb;
        let na = Math.max(min, Math.min(sum - min, sa + delta));
        const nb = sum - na;
        children[index] = Object.assign({}, a, { size: na, grow: false });
        children[index + 1] = Object.assign({}, b, { size: nb, grow: false });
        void dir;
        return Object.assign({}, split, { children });
    });
}

/** 把某个子树的总长度钉死：拖动开始时把整条轴上的兄弟都转成像素。 */
export function freezeAxis(root, parentPath, sizes) {
    return withNode(root, parentPath, (split) => {
        if (!split || split.type !== 'split') return split;
        const children = split.children.map((c, i) =>
            typeof sizes[i] === 'number' ? Object.assign({}, c, { size: sizes[i], grow: false }) : c
        );
        return Object.assign({}, split, { children });
    });
}
