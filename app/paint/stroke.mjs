/**
 * Kleks Motion —— 笔画采样（纯函数，无 DOM 依赖，可直接单测）
 *
 * 指针事件给的是稀疏点，落笔前要按笔尖直径插值成密集点，
 * 否则快速划过会出现一串断续的圆点。这里的函数只做数学，不碰画布。
 */

/** 一点：{x, y, p}（p = 压感 0..1，缺省 1）。 */
export function point(x, y, p) {
    return { x: Number(x) || 0, y: Number(y) || 0, p: Number.isFinite(p) ? clamp01(p) : 1 };
}

export function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function dist(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return Math.sqrt(dx * dx + dy * dy);
}

/**
 * 在 a→b 之间按固定间距插入落点（不含 a，含 b 时的最后一个点由调用方决定）。
 * 返回 `{ points, carry }`：carry 是上一段剩下的距离，保证跨事件间距连续。
 */
export function spacingPoints(a, b, spacing, carry = 0) {
    const gap = Math.max(0.2, Number(spacing) || 1);
    const total = dist(a, b);
    const pts = [];
    if (total <= 1e-9) return { points: pts, carry: carry };
    // carry = 距离下一个落点还差多少；从负值起步，让跨事件的间距连续
    let travelled = -carry;
    while (travelled + gap <= total) {
        travelled += gap;
        const u = travelled / total;
        pts.push({
            x: a.x + (b.x - a.x) * u,
            y: a.y + (b.y - a.y) * u,
            p: (a.p == null ? 1 : a.p) + ((b.p == null ? 1 : b.p) - (a.p == null ? 1 : a.p)) * u,
        });
    }
    const rest = total - Math.max(0, travelled);
    return { points: pts, carry: Math.max(0, gap - rest) };
}

/** 一次居中滑动平均，amount 0 = 不动，1 = 完全取邻点均值。 */
export function smoothPoints(points, amount = 0.35) {
    const k = clamp01(amount);
    if (k <= 0 || points.length < 3) return points.map((p) => ({ x: p.x, y: p.y, p: p.p }));
    const out = points.map((p) => ({ x: p.x, y: p.y, p: p.p }));
    for (let i = 1; i < points.length - 1; i++) {
        out[i].x = points[i].x * (1 - k) + ((points[i - 1].x + points[i + 1].x) / 2) * k;
        out[i].y = points[i].y * (1 - k) + ((points[i - 1].y + points[i + 1].y) / 2) * k;
    }
    return out;
}

/** 压感曲线：bias > 0 更「轻」，< 0 更「重」，0 保持线性。 */
export function pressureCurve(p, bias = 0) {
    const v = clamp01(p);
    if (Math.abs(bias) < 1e-6) return v;
    const gamma = Math.pow(2, bias);
    return Math.pow(v, gamma);
}

/** 笔画总长度（像素），用于「短笔画不上压感」这类判断。 */
export function strokeLength(points) {
    let sum = 0;
    for (let i = 1; i < points.length; i++) sum += dist(points[i - 1], points[i]);
    return sum;
}

/** 点集包围盒（整数像素，含 1px 余量）；空集返回 null。 */
export function bounds(points, pad = 1) {
    if (!points.length) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const p of points) {
        if (p.x < x0) x0 = p.x;
        if (p.y < y0) y0 = p.y;
        if (p.x > x1) x1 = p.x;
        if (p.y > y1) y1 = p.y;
    }
    return {
        x: Math.floor(x0 - pad),
        y: Math.floor(y0 - pad),
        w: Math.ceil(x1 - x0 + pad * 2) + 1,
        h: Math.ceil(y1 - y0 + pad * 2) + 1,
    };
}

/** 像素笔对齐：落点吸附到整格中心。 */
export function snapPixel(p, size = 1) {
    const s = Math.max(1, Math.round(size));
    const half = s / 2;
    return {
        x: Math.floor(p.x / s) * s + half,
        y: Math.floor(p.y / s) * s + half,
        p: p.p == null ? 1 : p.p,
    };
}
