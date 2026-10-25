/**
 * 「图动了多少 → 对象坐标补回多少」的语义测试。
 *
 * `resizeTexture` 本身在 `app/shell/app.mjs` 里（要碰 canvas，node 里跑不起来），
 * 但它真正容易写错的地方是**坐标系**：trim 之后对象坐标要加、resize 之后要减，
 * 写反了就是「一点裁剪画面就跳」。这里用纯函数把两条模式各自的补偿量算一遍，
 * 断言「同一个像素在世界坐标里没动」—— 真机再验一遍同一条性质。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { alignOffset, contentBounds, cropRgba, placeRgba } from '../app/paint/trim.mjs';

function makeRgba(w, h, alphaAt) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
            const i = (y * w + x) * 4;
            out[i] = 10 + x;
            out[i + 1] = 20 + y;
            out[i + 2] = 30;
            out[i + 3] = alphaAt ? alphaAt(x, y) : 255;
        }
    }
    return out;
}

function px(rgba, w, x, y) {
    const i = (y * w + x) * 4;
    return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
}

/** 对象没有旋转缩放时：图像内 (px,py) 的世界坐标。 */
function worldOf(objX, objY, pxX, pxY) {
    return { x: objX + pxX, y: objY + pxY };
}

test('trim：对象坐标 += box.x/box.y 之后，像素内容的世界坐标不变', () => {
    // 旧图 10×8，内容在 (2,3) 起的 4×2 区域
    const OLD_W = 10;
    const OLD_H = 8;
    const img = makeRgba(OLD_W, OLD_H, (x, y) => (x >= 2 && x <= 5 && y >= 3 && y <= 4 ? 255 : 0));
    const obj = { x: 100, y: 50 };

    const box = contentBounds(img, OLD_W, OLD_H);
    assert.deepEqual(box, { x: 2, y: 3, w: 4, h: 2 });

    const cut = cropRgba(img, OLD_W, OLD_H, box);
    const nextObj = { x: obj.x + box.x, y: obj.y + box.y };
    assert.deepEqual(nextObj, { x: 102, y: 53 }, '补偿量就是被裁掉的左上角');

    // 内容左上角那个像素：旧图里是世界 (102,53)，新图里也必须是 (102,53)
    const before = worldOf(obj.x, obj.y, box.x, box.y);
    const after = worldOf(nextObj.x, nextObj.y, 0, 0);
    assert.deepEqual(after, before);
    // 而且像素值本身没变
    assert.deepEqual(px(cut, box.w, 0, 0), px(img, OLD_W, box.x, box.y));
    // 最右下角同理
    assert.deepEqual(
        worldOf(nextObj.x, nextObj.y, box.w - 1, box.h - 1),
        worldOf(obj.x, obj.y, box.x + box.w - 1, box.y + box.h - 1),
    );
});

test('trim：裁完再算一次包围盒，四周不该还有空白（真的裁紧了）', () => {
    const img = makeRgba(12, 9, (x, y) => (x >= 3 && x <= 7 && y >= 1 && y <= 6 ? 200 : 0));
    const box = contentBounds(img, 12, 9);
    const cut = cropRgba(img, 12, 9, box);
    const again = contentBounds(cut, box.w, box.h);
    assert.deepEqual(again, { x: 0, y: 0, w: box.w, h: box.h });
});

test('resize 居中：对象坐标 -= ox/oy 之后，像素内容的世界坐标不变', () => {
    // 裁过之后的状态：4×2 的图，对象在 (102,53)
    const OLD_W = 4;
    const OLD_H = 2;
    const img = makeRgba(OLD_W, OLD_H);
    const obj = { x: 102, y: 53 };

    const NEW_W = 10;
    const NEW_H = 8;
    const off = alignOffset(OLD_W, OLD_H, NEW_W, NEW_H, 'c');
    assert.deepEqual(off, { ox: 3, oy: 3 });

    const placed = placeRgba(img, OLD_W, OLD_H, NEW_W, NEW_H, off.ox, off.oy);
    const nextObj = { x: obj.x - off.ox, y: obj.y - off.oy };
    assert.deepEqual(nextObj, { x: 99, y: 50 });

    // 旧图左上角像素 → 新图里挪到了 (3,3)
    assert.deepEqual(
        worldOf(nextObj.x, nextObj.y, off.ox, off.oy),
        worldOf(obj.x, obj.y, 0, 0),
    );
    assert.deepEqual(px(placed, NEW_W, off.ox, off.oy), px(img, OLD_W, 0, 0));
    // 留白处是透明的
    assert.equal(px(placed, NEW_W, 0, 0)[3], 0);
});

test('resize 九宫格：每一档的补偿量都能让内容世界坐标不变', () => {
    const OLD_W = 6;
    const OLD_H = 4;
    const NEW_W = 14;
    const NEW_H = 10;
    const img = makeRgba(OLD_W, OLD_H);
    const obj = { x: 40, y: 30 };
    for (const align of ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se']) {
        const off = alignOffset(OLD_W, OLD_H, NEW_W, NEW_H, align);
        const placed = placeRgba(img, OLD_W, OLD_H, NEW_W, NEW_H, off.ox, off.oy);
        const nextObj = { x: obj.x - off.ox, y: obj.y - off.oy };
        assert.deepEqual(
            worldOf(nextObj.x, nextObj.y, off.ox, off.oy),
            worldOf(obj.x, obj.y, 0, 0),
            align + '：补偿后旧图左上角的世界坐标应不变',
        );
        // 内容确实落在新图里那一格
        assert.deepEqual(px(placed, NEW_W, off.ox, off.oy), px(img, OLD_W, 0, 0), align);
        // 落位点之外离得最远的角落必须是空的（能抓到「偏移写反」）
        const outside = align === 'se' ? { x: 0, y: 0 } : { x: NEW_W - 1, y: NEW_H - 1 };
        if (align !== 'se' && align !== 'nw') {
            assert.equal(px(placed, NEW_W, outside.x, outside.y)[3], 0, align + '：对侧角落应是留白');
        }
    }
});

test('resize 缩小：负偏移把内容挪到画布外的那部分裁掉，剩下的世界坐标仍不变', () => {
    const OLD_W = 10;
    const OLD_H = 10;
    const NEW_W = 6;
    const NEW_H = 6;
    const img = makeRgba(OLD_W, OLD_H);
    const obj = { x: 200, y: 100 };
    const off = alignOffset(OLD_W, OLD_H, NEW_W, NEW_H, 'c');
    assert.deepEqual(off, { ox: -2, oy: -2 });

    const placed = placeRgba(img, OLD_W, OLD_H, NEW_W, NEW_H, off.ox, off.oy);
    const nextObj = { x: obj.x - off.ox, y: obj.y - off.oy };
    assert.deepEqual(nextObj, { x: 202, y: 102 });

    // 旧图 (2,2) 这一像素，世界里位置不变
    assert.deepEqual(px(placed, NEW_W, 0, 0), px(img, OLD_W, 2, 2));
    assert.deepEqual(
        worldOf(nextObj.x, nextObj.y, 0, 0),
        worldOf(obj.x, obj.y, 2, 2),
    );
    // 旧图 (0,0) 已经在画布外，不该出现在新图任何位置
    for (let y = 0; y < NEW_H; y += 1) {
        for (let x = 0; x < NEW_W; x += 1) {
            assert.notDeepEqual(px(placed, NEW_W, x, y), px(img, OLD_W, 0, 0));
        }
    }
});
