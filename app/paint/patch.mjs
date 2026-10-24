/**
 * Kleks Motion —— 矩形补丁（撤销用的最小像素单元）
 *
 * 一笔画完才知道改了哪块，所以流程是：
 *   capture(rect) → 落笔 → commit(rect, before) 得到可撤销命令
 * 命令只保存那块矩形的像素，不复制整层。
 */

export function clampRect(rect, w, h) {
    const x = Math.max(0, Math.floor(rect.x));
    const y = Math.max(0, Math.floor(rect.y));
    const x1 = Math.min(w, Math.ceil(rect.x + rect.w));
    const y1 = Math.min(h, Math.ceil(rect.y + rect.h));
    return { x, y, w: Math.max(0, x1 - x), h: Math.max(0, y1 - y) };
}

/** 读一块矩形像素；矩形无效返回 null。 */
export function captureRegion(surface, rect) {
    if (!surface) return null;
    const r = clampRect(rect, surface.width, surface.height);
    if (r.w <= 0 || r.h <= 0) return null;
    const g = surface.getContext('2d');
    if (!g) return null;
    return { rect: r, data: g.getImageData(r.x, r.y, r.w, r.h) };
}

/** 把一块像素原样写回（覆盖，不混合）。 */
export function restoreRegion(surface, rect, data) {
    if (!surface || !data) return false;
    const g = surface.getContext('2d');
    if (!g) return false;
    g.save();
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'copy';
    g.putImageData(data, rect.x, rect.y);
    g.restore();
    return true;
}

/** 从整层 ImageData 里裁出一块区域（落笔先抓整层、抬笔只留改动区）。 */
export function cropFromFull(full, rect) {
    if (!full) return null;
    const r = clampRect(rect, full.width, full.height);
    if (r.w <= 0 || r.h <= 0) return null;
    const out = new ImageData(r.w, r.h);
    const rowBytes = r.w * 4;
    for (let y = 0; y < r.h; y++) {
        const srcStart = ((r.y + y) * full.width + r.x) * 4;
        out.data.set(full.data.subarray(srcStart, srcStart + rowBytes), y * rowBytes);
    }
    return { rect: r, data: out };
}

/**
 * 生成一条可撤销命令。
 * @param surface 被改的位图
 * @param before captureRegion 的结果（改动前）
 * @param after  改动后的同区域像素（不传就现读）
 */
export function makeRegionCommand(surface, before, after, label) {
    if (!surface || !before) return null;
    const rect = before.rect;
    const afterData = after || captureRegion(surface, rect);
    if (!afterData) return null;
    return {
        label: label || '绘制',
        undo() {
            restoreRegion(surface, rect, before.data);
        },
        redo() {
            restoreRegion(surface, rect, afterData.data);
        },
    };
}
