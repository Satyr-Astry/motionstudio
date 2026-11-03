// 曲线画布尺寸：每帧调用时必须零写入（写 canvas.width 会重建后备位图，
// 无条件赋值等于每帧重建一次纹理 —— 主线程与 GPU 都白烧）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { resizeCanvas } from '../app/editors/curve-draw.mjs';

// resizeCanvas 只读 window.devicePixelRatio；Node 里补一个最小 window。
globalThis.window = { devicePixelRatio: 1 };

function fakeCanvas(w, h) {
    return { width: w, height: h, style: { width: w + 'px', height: h + 'px' } };
}

function countWrites(cv) {
    const writes = [];
    let width = cv.width;
    let height = cv.height;
    let cssW = cv.style.width;
    let cssH = cv.style.height;
    Object.defineProperty(cv, 'width', {
        get: () => width,
        set: (v) => { writes.push('width'); width = v; },
    });
    Object.defineProperty(cv, 'height', {
        get: () => height,
        set: (v) => { writes.push('height'); height = v; },
    });
    Object.defineProperty(cv.style, 'width', {
        get: () => cssW,
        set: (v) => { writes.push('style.width'); cssW = v; },
    });
    Object.defineProperty(cv.style, 'height', {
        get: () => cssH,
        set: (v) => { writes.push('style.height'); cssH = v; },
    });
    return writes;
}

const wrap = (w, h) => ({ clientWidth: w, clientHeight: h });

test('尺寸没变时：resizeCanvas 不写 canvas 尺寸与 style', () => {
    const cv = fakeCanvas(640, 240);
    const writes = countWrites(cv);
    const size = resizeCanvas(cv, wrap(640, 240));
    assert.deepEqual(writes, []);
    assert.deepEqual(size, { w: 640, h: 240, dpr: 1 });
});

test('尺寸变了才写：宽高与 CSS 同步更新', () => {
    const cv = fakeCanvas(640, 240);
    const writes = countWrites(cv);
    resizeCanvas(cv, wrap(800, 300));
    assert.deepEqual(writes, ['width', 'height', 'style.width', 'style.height']);
});

test('dpr 变化也算尺寸变化（像素尺寸不同 CSS 相同）', () => {
    const cv = fakeCanvas(640, 240);
    const writes = countWrites(cv);
    const old = globalThis.window;
    globalThis.window = { devicePixelRatio: 2 };
    try {
        const size = resizeCanvas(cv, wrap(640, 240));
        assert.deepEqual(writes, ['width', 'height']); // CSS 尺寸没变，不写 style
        assert.equal(size.dpr, 2);
        assert.equal(cv.width, 1280);
        assert.equal(cv.height, 480);
    } finally {
        globalThis.window = old;
    }
});
