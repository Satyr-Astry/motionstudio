/**
 * 纹理（旧称「纹理」）的只读访问面 —— 让 UI 不必知道 `cels`/`drawings` 的内部形状。
 *
 * 术语（docs/术语.md）：用户可见的一律叫「纹理」；数据里 `object.cels` 是
 * 「这张纹理在哪些时刻曝光」的投影，`object.drawings` 是纹理资产表。
 * 这里**只读**：写操作仍走 ctx（`resizeTexture`/`addDrawing`/`setImageAt`/`placeDrawing`）。
 */

import { celTimes, celAt, imageAt, drawingsOf } from './doc-model.mjs';

/** 这个对象有几张纹理（按资产去重，不是按曝光次数）。
 *  v10：不再回退数 `obj.cels.length` —— 「一个还没画的空画格」不是一张纹理，
 *  回退会让「N 纹」角标把空对象写成「1 纹」。 */
export function textureCount(obj) {
    if (!obj) return 0;
    return drawingsOf(obj).length;
}

/** 所有曝光时刻（升序、去重）。 */
export function textureTimes(obj) {
    if (!obj) return [];
    return celTimes(obj);
}

/** 某一时刻生效的那张纹理（返回图像对象或 null）。 */
export function textureAt(obj, t) {
    if (!obj) return null;
    return imageAt(obj, t);
}

/** 某一时刻命中的 cel 记录（{ at, image } 或 null）。 */
export function exposureAt(obj, t) {
    if (!obj) return null;
    return celAt(obj, t);
}

/** 某一时刻生效的是第几张（0 起）；没有纹理时 -1。 */
export function textureIndexOfTime(obj, t) {
    const list = textureTimes(obj);
    if (!list.length) return -1;
    let hit = -1;
    const tt = Number.isFinite(t) ? t : 0;
    for (let i = 0; i < list.length; i++) {
        if (list[i] <= tt + 1e-9) hit = i;
        else break;
    }
    // 先按曝光时刻定位，再换算成「第几张资产」
    const img = textureAt(obj, t);
    const drawings = drawingsOf(obj);
    if (img && drawings.length) {
        const key = img && img.__drawingId != null ? String(img.__drawingId) : null;
        const byKey = key ? drawings.findIndex((d) => String(d.id) === key) : -1;
        if (byKey >= 0) return byKey;
        const byRef = drawings.findIndex((d) => d && d.image === img);
        if (byRef >= 0) return byRef;
    }
    return hit;
}
