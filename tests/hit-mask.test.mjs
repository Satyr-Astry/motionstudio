// alpha 掩膜（app/core/hit-mask.mjs）与 hitTest 的像素判定。
// 这些用例锁三件事：掩膜只存 alpha 原值、缓存键是图像对象本身、
// 掩膜读不出来时 hitTest 退回矩形命中。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDoc, patchObject, setImageAt, objectById } from '../app/core/doc-model.mjs';
import { hitTest } from '../app/core/element.mjs';
import { alphaMaskOf, maskStats } from '../app/core/hit-mask.mjs';

/** 可读 canvas 的轻量替身：getImageData 支持任意区域 */
function fakeImage(w, h, alphaAt) {
    return {
        width: w,
        height: h,
        getContext() {
            return {
                getImageData(x, y, ww = 1, hh = 1) {
                    const data = new Uint8ClampedArray(ww * hh * 4);
                    for (let j = 0; j < hh; j++) {
                        for (let i = 0; i < ww; i++) {
                            data[(j * ww + i) * 4 + 3] = alphaAt(x + i, y + j);
                        }
                    }
                    return { data, width: ww, height: hh };
                },
            };
        },
    };
}

/** 一像素宽的竖条：alpha 随 x 递增，用来钉阈值 */
const STAIR = (x) => [0, 1, 7, 8, 9, 255][x] ?? 255;

function makeDoc(image) {
    const base = createDoc({ width: 10, height: 8, fps: 10 });
    const id = base.objects[0].id;
    const doc = patchObject(base, id, (o) => setImageAt(o, 0, image));
    return { doc, el: objectById(doc, id) };
}

test('alphaMaskOf：从可读 canvas 取到每像素 alpha 原值', () => {
    const mask = alphaMaskOf(fakeImage(3, 2, (x, y) => x * 10 + y));
    assert.ok(mask, '应当读得出掩膜');
    assert.equal(mask.w, 3);
    assert.equal(mask.h, 2);
    assert.deepEqual([...mask.mask], [0, 10, 20, 1, 11, 21]);
});

test('alphaMaskOf：裸像素源 { width, height, data } 直接取 alpha 字节', () => {
    const data = new Uint8ClampedArray(2 * 2 * 4);
    [0, 8, 9, 255].forEach((a, i) => { data[i * 4 + 3] = a; });
    const mask = alphaMaskOf({ width: 2, height: 2, data });
    assert.deepEqual([...mask.mask], [0, 8, 9, 255]);
});

test('alphaMaskOf：同一图像对象只构建一次，之后走缓存', () => {
    const img = fakeImage(4, 4, () => 255);
    const before = maskStats();
    const first = alphaMaskOf(img);
    const second = alphaMaskOf(img);
    const after = maskStats();
    assert.equal(first, second, '第二次应返回同一个对象');
    assert.equal(after.built - before.built, 1, '只应真正构建一次');
    assert.equal(after.reused - before.reused, 1);
});

test('alphaMaskOf：裸像素源按对象缓存，不做逐字节比对', () => {
    const data = new Uint8ClampedArray(4);
    data[3] = 200;
    const source = { width: 1, height: 1, data };
    const first = alphaMaskOf(source);
    data[3] = 0; // 改动内容但对象不变：缓存不失效，这是有意的（图像对象视为不可变）
    const second = alphaMaskOf(source);
    assert.equal(first, second);
    assert.equal(second.mask[0], 200);
});

test('alphaMaskOf：有尺寸但读不出像素的源返回 null，且不重复尝试', () => {
    const bad = { width: 4, height: 4 }; // 没有 getContext，node 里也没有 OffscreenCanvas
    const before = maskStats();
    assert.equal(alphaMaskOf(bad), null);
    assert.equal(alphaMaskOf(bad), null);
    const after = maskStats();
    assert.equal(after.built, before.built, '失败的源不产生构建计数');
    assert.equal(after.reused - before.reused, 1, '第二次应命中缓存里的 null');
});

test('alphaMaskOf：没有正尺寸的源直接 null', () => {
    assert.equal(alphaMaskOf(null), null);
    assert.equal(alphaMaskOf(undefined), null);
    assert.equal(alphaMaskOf({}), null);
    assert.equal(alphaMaskOf({ width: 0, height: 8 }), null);
    assert.equal(alphaMaskOf({ width: 8, height: -1 }), null);
});

test('alphaMaskOf：没有 getContext 的源走 drawImage 重画（ImageBitmap 路径）', () => {
    const saved = globalThis.OffscreenCanvas;
    const drawn = [];
    class FakeOffscreen {
        constructor(w, h) {
            this.width = w;
            this.height = h;
        }
        getContext() {
            const self = this;
            return {
                clearRect() {},
                drawImage(src) { drawn.push(src); self.drawn = src; },
                getImageData(x, y, w, h) {
                    const data = new Uint8ClampedArray(w * h * 4);
                    for (let j = 0; j < h; j++) {
                        for (let i = 0; i < w; i++) {
                            data[(j * w + i) * 4 + 3] = self.drawn ? self.drawn.alphaAt(i, j) : 0;
                        }
                    }
                    return { data, width: w, height: h };
                },
            };
        }
    }
    globalThis.OffscreenCanvas = FakeOffscreen;
    try {
        // 这个对象只有尺寸和一张「内容描述」，像 ImageBitmap 一样没有 getContext
        const bitmapLike = { width: 2, height: 2, alphaAt: (x, y) => (x === 1 ? 200 : 40) };
        const mask = alphaMaskOf(bitmapLike);
        assert.equal(drawn.length, 1, '应当 drawImage 一次');
        assert.equal(drawn[0], bitmapLike);
        assert.deepEqual([...mask.mask], [40, 200, 40, 200]);
    } finally {
        if (saved === undefined) delete globalThis.OffscreenCanvas;
        else globalThis.OffscreenCanvas = saved;
    }
});

test('hitTest：alpha 必须严格大于阈值（8 透明、9 起命中）', () => {
    const { doc } = makeDoc(fakeImage(10, 8, (x) => STAIR(x)));
    const at = (x) => hitTest(doc, 0, x + 0.5, 4.5);
    assert.equal(at(0), null, 'alpha 0 不命中');
    assert.equal(at(1), null, 'alpha 1 不命中');
    assert.equal(at(2), null, 'alpha 7 不命中');
    assert.equal(at(3), null, 'alpha 8 不命中（阈值是严格大于）');
    assert.equal(at(4).alpha, 9, 'alpha 9 命中');
    assert.equal(at(5).alpha, 255, 'alpha 255 命中');
});

test('hitTest：阈值提高后同一像素变成不命中', () => {
    const { doc } = makeDoc(fakeImage(10, 8, (x) => STAIR(x)));
    assert.equal(hitTest(doc, 0, 4.5, 4.5, { threshold: 9 }), null, '9 不大于 9');
    assert.equal(hitTest(doc, 0, 5.5, 4.5, { threshold: 250 }).alpha, 255);
});

test('hitTest：导入位图（ImageBitmap 形态）能命中 —— 掩膜重画后取像素', () => {
    const saved = globalThis.OffscreenCanvas;
    class FakeOffscreen {
        constructor(w, h) {
            this.width = w;
            this.height = h;
        }
        getContext() {
            const self = this;
            return {
                clearRect() {},
                drawImage(src) { self.drawn = src; },
                getImageData(x, y, w, h) {
                    const data = new Uint8ClampedArray(w * h * 4);
                    for (let j = 0; j < h; j++) {
                        for (let i = 0; i < w; i++) {
                            data[(j * w + i) * 4 + 3] = self.drawn ? self.drawn.alphaAt(i, j) : 0;
                        }
                    }
                    return { data, width: w, height: h };
                },
            };
        }
    }
    globalThis.OffscreenCanvas = FakeOffscreen;
    try {
        // 左半边不透明、右半边全透明，且没有 getContext（模拟 ImageBitmap）
        const bitmapLike = { width: 10, height: 8, alphaAt: (x) => (x < 5 ? 255 : 0) };
        const { doc } = makeDoc(bitmapLike);
        assert.equal(hitTest(doc, 0, 2.5, 4.5).alpha, 255, '不透明区应命中');
        assert.equal(hitTest(doc, 0, 7.5, 4.5), null, '透明区不命中');
    } finally {
        if (saved === undefined) delete globalThis.OffscreenCanvas;
        else globalThis.OffscreenCanvas = saved;
    }
});

test('hitTest：有图像但掩膜读不出来时退回矩形命中（有意的降级）', () => {
    // 只有尺寸、既没有 getContext 也没有 OffscreenCanvas —— 真实浏览器里
    // 几乎不会出现，但在无 DOM 环境或画布被污染时会走到。
    const { doc } = makeDoc({ width: 10, height: 8 });
    const hit = hitTest(doc, 0, 5.5, 4.5);
    assert.ok(hit, '不该因为读不到像素就选不中');
    assert.equal(hit.alpha, 255, '降级时按不透明上报');
    assert.equal(hitTest(doc, 0, -1, 4.5), null, '矩形外仍然不命中');
    assert.equal(hitTest(doc, 0, 10.5, 4.5), null, '矩形外仍然不命中');
});

test('hitTest：没有图像的对象不命中（空纹理不能被矩形命中）', () => {
    const base = createDoc({ width: 10, height: 8, fps: 10 });
    assert.equal(hitTest(base, 0, 5, 4), null);
});
