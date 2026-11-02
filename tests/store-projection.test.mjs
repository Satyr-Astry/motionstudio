/**
 * project-store 序列化口径单测（v8：纹理真源 = 关键帧上的 `drawing` + 纹理库）。
 *
 * 为什么单独有这样的文件：`obj.cels` 只是 `makeObject` / `syncLibrary` 里 `projectCels`
 * 现算出来的**镜像**，而时间轴拖动 / 删除关键帧走的是 `editors/timeline-geo.mjs` 的
 * `setTransform` 浅替换 —— 它换个 transform 引用就返回，不会重算镜像。序列化要是照抄
 * `obj.cels`，存档往返就会把纹理写在移动前的位置，甚至把用户已经删掉的纹理又写回来
 * （界面上看不出任何异常，只有关掉再打开才发现）。
 *
 * 这里全部用**真实编辑器的写路径**造出「镜像过期」的对象（不手工拼假结构），再走
 * `docToFile → jsonToDoc` 往返断言结果。位图 / 画布走 `__setCodec` 替身，Node 里不碰 DOM。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as store from '../app/shell/project-store.mjs';
import { celTimes, createDoc, imageAt, makeKey, makeObject, objectsOf } from '../app/core/doc-model.mjs';
import { moveKey, removeKey } from '../app/core/transform.mjs';
import { setTransform } from '../app/editors/timeline-geo.mjs';

/* ─────────────────────── 替身 codec（位图 / 画布 / 解码） ─────────────────────── */

const dataURLOf = (tag) => `data:image/png;base64,${tag}`;
const tagOf = (url) => String(url).replace(/^data:image\/png;base64,/, '');

/** tag → 尺寸登记表：解码替身按 tag 还原尺寸 */
const SIZES = new Map();
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-9;

/** 假位图：`__tag` 就是它的「像素身份」，往返之后靠它认图 */
function fakeBitmap(w, h, tag) {
    return {
        width: w,
        height: h,
        __tag: tag,
        getContext: () => ({ getImageData: (x, y, ww = 1, hh = 1) => ({ data: new Uint8ClampedArray(ww * hh * 4), width: ww, height: hh }) }),
    };
}

/** 假画布：`drawImage` 把 tag 记到自身上，`toDataURL` 回成 dataURL */
function fakeCanvas(w, h) {
    const cv = {
        width: w,
        height: h,
        __tag: 'blank',
        getContext() { return ctx; },
        toDataURL() { return dataURLOf(cv.__tag); },
    };
    const ctx = {
        setTransform() {},
        clearRect() {},
        drawImage(img) { if (img && img.__tag) cv.__tag = img.__tag; },
    };
    return cv;
}

store.__setCodec({
    canvas: (w, h) => fakeCanvas(w, h),
    surface: (w, h) => fakeCanvas(w, h),
    decode: async (url) => {
        const tag = tagOf(url);
        const size = SIZES.get(tag) || { w: 1, h: 1 };
        return fakeBitmap(size.w, size.h, tag);
    },
});
test.after(() => { store.__resetCodec(); });

/* ─────────────────────────── 造文档 ─────────────────────────── */

/** 8×8 位图；同一个 tag 复用同一份尺寸登记（A / B 是两张不同的图） */
function bitmap(tag) {
    SIZES.set(tag, { w: 8, h: 8 });
    return fakeBitmap(8, 8, tag);
}

/**
 * 0 秒纹理 A、2 秒纹理 B 的文档。
 * 走 makeObject 的正规入口，所以 `transform.keys` 上带 `drawing`（真源），
 * `obj.cels` 是它当时的投影（镜像）。
 */
function twoTextureDoc() {
    const obj = makeObject({
        id: 'obj-1',
        name: '对象 1',
        transform: { keys: [makeKey(0, {})] },
        cels: [{ at: 0, image: bitmap('A') }, { at: 2, image: bitmap('B') }],
    });
    return createDoc({ width: 8, height: 8, fps: 10, objects: [obj] });
}

/** 只把对象换掉，保持文档其余字段（等价于 setDoc 里 patchObject 的做法） */
function withObject(doc, obj) {
    return Object.assign({}, doc, { objects: [obj] });
}

/** 该对象上「带纹理的关键帧」的时刻（真源口径，不看 cels） */
function textureKeyTimes(obj) {
    return obj.transform.keys.filter((k) => k.drawing != null).map((k) => k.t);
}

/* ─────────────────────── 核心：移动关键帧 ─────────────────────── */

test('序列化按真源重算：关键帧被拖到新时刻，存档写新时刻而不是过期的 cels 镜像', async () => {
    const doc = twoTextureDoc();
    const obj = objectsOf(doc)[0];
    // 真实写路径：时间轴把 t=2 的纹理关键帧拖到 t=3（timeline-keys.mjs → setTransform 浅替换）
    const idx = obj.transform.keys.findIndex((k) => near(k.t, 2));
    const moved = withObject(doc, setTransform(obj, moveKey(obj.transform, idx, 3)));

    const truth = objectsOf(moved)[0];
    assert.deepEqual(truth.cels.map((c) => c.at), [0, 2], '镜像停在拖动之前的时刻（这就是缝隙的输入）');
    assert.deepEqual(textureKeyTimes(truth), [0, 3], '真源已经搬到 3 秒');
    assert.equal(imageAt(truth, 2).__tag, 'A', '运行时：2 秒处还是上一张 A');
    assert.equal(imageAt(truth, 3).__tag, 'B', '运行时：3 秒起换成 B');

    const file = store.docToFile(moved, { name: '拖关键帧', savedAt: 1 });
    assert.equal(file.version, store.VERSION, '格式版本号跟着常量走');
    assert.equal(file.version, 4, '格式仍然是 v4，本次只改「读哪个真源」');
    assert.deepEqual(file.elements[0].cels.map((c) => c.at), [0, 3], '落盘口径必须是关键帧真源');

    const back = await store.jsonToDoc(file);
    const rt = objectsOf(back)[0];
    assert.deepEqual(celTimes(rt), [0, 3]);
    assert.deepEqual(rt.cels.map((c) => c.at), [0, 3], 'cels 读回来是重算出来的正确投影');
    assert.equal(imageAt(rt, 2).__tag, 'A', '2 秒处不能被过期镜像带回 B');
    assert.equal(imageAt(rt, 3).__tag, 'B', '3 秒处的纹理不能在存档里丢');
});

/* ─────────────────────── 核心：删除关键帧 ─────────────────────── */

test('序列化按真源重算：删掉纹理关键帧后，存档不会把它复活', async () => {
    const doc = twoTextureDoc();
    const obj = objectsOf(doc)[0];
    const idx = obj.transform.keys.findIndex((k) => near(k.t, 2));
    const deleted = withObject(doc, setTransform(obj, removeKey(obj.transform, idx)));

    const truth = objectsOf(deleted)[0];
    assert.deepEqual(truth.cels.map((c) => c.at), [0, 2], '镜像里还留着已经删掉的那一格');
    assert.deepEqual(textureKeyTimes(truth), [0], '真源只剩 0 秒这一颗');
    assert.equal(imageAt(truth, 2).__tag, 'A', '运行时：2 秒起是 A（B 已删）');

    const file = store.docToFile(deleted, { name: '删纹理', savedAt: 2 });
    assert.deepEqual(file.elements[0].cels.map((c) => c.at), [0], '已删除的时刻不能出现在存档里');
    // 库不跟着收缩：B 还留在纹理库里（用户可以再切回来），只是不再被曝光
    assert.equal((file.elements[0].drawings || []).length, 2, '纹理库仍保留两张图');

    const back = await store.jsonToDoc(file);
    const rt = objectsOf(back)[0];
    assert.deepEqual(celTimes(rt), [0]);
    assert.equal(imageAt(rt, 2).__tag, 'A', '2 秒处不能冒出已经删除的 B');
});

/* ─────────────────────── 镜像整体不可信 ─────────────────────── */

test('镜像被清空（cels: []）也不影响落盘：纹理按关键帧全部写出且共用位图只存一份', async () => {
    const doc = twoTextureDoc();
    const obj = objectsOf(doc)[0];
    // 任何绕过 syncLibrary 的写路径都可能让镜像变成空数组
    const stale = withObject(doc, Object.assign({}, obj, { cels: [] }));
    assert.deepEqual(objectsOf(stale)[0].cels, [], '镜像被清空');

    const file = store.docToFile(stale, { name: '空镜像', savedAt: 3 });
    const el = file.elements[0];
    assert.deepEqual(el.cels.map((c) => c.at), [0, 2], '关键帧上的纹理一个都不能少');
    assert.deepEqual(el.cels.map((c) => c.image.ref), ['obj-1', 'obj-1#2']);
    assert.deepEqual(Object.keys(file.assets).sort(), ['obj-1', 'obj-1#2']);
    assert.equal(JSON.stringify(file).split(dataURLOf('A')).length - 1, 1, '同一张图只编码一次');

    const back = await store.jsonToDoc(file);
    const rt = objectsOf(back)[0];
    assert.equal(imageAt(rt, 0).__tag, 'A');
    assert.equal(imageAt(rt, 2).__tag, 'B');
});

/* ─────────────────────── 向后兼容：老档 ─────────────────────── */

test('老档（没有 drawings、纹理只写在 cels 里）读入后仍能正确落盘与再读入', async () => {
    // 模拟一份 v4 早期的文件：对象只有 cels，没有 drawings，关键帧上也没有 drawing
    const legacy = {
        format: store.FORMAT,
        version: 4,
        name: '老档',
        savedAt: 1,
        width: 8,
        height: 8,
        fps: 10,
        duration: 3,
        loopMode: 'cycle',
        drawOrder: ['obj-1'],
        assets: { 'obj-1': dataURLOf('A'), 'obj-1#2': dataURLOf('B') },
        elements: [{
            id: 'obj-1',
            name: '对象 1',
            visible: true,
            locked: false,
            opacity: 1,
            mixMode: 'source-over',
            kind: 'paint',
            anchor: { x: 0.5, y: 0.5 },
            transform: { keys: [{ t: 0, state: {}, ease: 'linear' }] },
            cels: [
                { at: 0, image: { ref: 'obj-1', w: 8, h: 8 } },
                { at: 2, image: { ref: 'obj-1#2', w: 8, h: 8 } },
            ],
        }],
        tags: [],
    };

    const first = await store.jsonToDoc(legacy);
    assert.ok(first, '老档要能读进来');
    const o1 = objectsOf(first)[0];
    assert.deepEqual(textureKeyTimes(o1), [0, 2], '读入时 cels 已搬成关键帧上的 drawing');

    const file = store.docToFile(first, { name: '老档', savedAt: 2 });
    assert.equal(file.version, 4);
    assert.deepEqual(file.elements[0].cels.map((c) => c.at), [0, 2], '再落盘不能丢纹理');

    const second = await store.jsonToDoc(file);
    const o2 = objectsOf(second)[0];
    assert.deepEqual(celTimes(o2), [0, 2]);
    assert.equal(imageAt(o2, 0).__tag, 'A');
    assert.equal(imageAt(o2, 2).__tag, 'B');
});
