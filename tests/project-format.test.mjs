/**
 * 项目格式单测（时间模型 v6）。
 *
 * 断言的都是「时间模型」口径：文档里没有 `doc.frames` 了，对象的纹理是
 * `obj.cels = [{ at, image }]`（`at` 单位是秒，纹理一直沿用到下一个纹理），
 * 总时长由 `docDuration(doc)` 推。v4 序列化（project-store）只把位图写成 dataURL，
 * 同一张位图被多个纹理共用时只存一份（assets 的键是对象 id，第 2 张起 `id#2`）。
 *
 * 依赖 project-store 的部分走 `__setCodec` 注入替身画布 / 解码器，不碰真实 DOM。
 * 注意 project-store 正在被并行改造，所以这里用命名空间导入：少一个导出只会让相关
 * 用例失败，而不是整份文件 import 时就炸掉。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import * as store from '../app/shell/project-store.mjs';
import {
    SHEET_FORMAT, SHEET_VERSION, buildSpritesheet, sheetLayout,
} from '../app/shell/spritesheet.mjs';
import {
    celTimes, createDoc, docDuration, imageAt, makeKey, makeObject, migrateFromFrames,
} from '../app/core/doc-model.mjs';

/* ─────────────────────── 替身：位图 / 画布 / codec ─────────────────────── */

/** dataURL ↔ tag：fakeBitmap 的 `__tag` 就是它的「像素身份」 */
const dataURLOf = (tag) => `data:image/png;base64,${tag}`;
const tagOf = (url) => String(url).replace(/^data:image\/png;base64,/, '');

/** 位图尺寸登记表：解码替身按 tag 还原来得及尺寸 */
const BITMAPS = new Map();

function fakeBitmap(w, h, tag) {
    const img = { width: w, height: h, __tag: tag };
    img.getContext = () => ({
        getImageData(x, y, ww = 1, hh = 1) {
            return { data: new Uint8ClampedArray(ww * hh * 4), width: ww, height: hh };
        },
    });
    return img;
}

/**
 * 假画布：记录贴图位置与底色，`toDataURL` 回 `data:image/png;base64,<最后一次贴进来的 tag>`。
 * 只实现 composite / 编码链路真正用到的那几个 2D API。
 */
function fakeCanvas(w, h) {
    const state = { fillStyle: '#000000', globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none' };
    const cv = {
        width: w,
        height: h,
        __tag: 'blank',
        __drawn: [],
        __fills: [],
        __state: state,
        getContext() { return ctx; },
        toDataURL() { return dataURLOf(cv.__tag); },
    };
    const ctx = {
        setTransform() {}, save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, transform() {},
        beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, clip() {}, rect() {},
        clearRect() {},
        fillRect(x, y, ww, hh) { cv.__fills.push({ style: state.fillStyle, x, y, w: ww, h: hh }); },
        drawImage(img, x = 0, y = 0) {
            const tag = img && img.__tag ? img.__tag : null;
            cv.__drawn.push({ tag, x, y });
            if (tag) cv.__tag = tag;
        },
        getImageData(x, y, ww = 1, hh = 1) {
            return { data: new Uint8ClampedArray(ww * hh * 4), width: ww, height: hh };
        },
    };
    for (const key of ['fillStyle', 'globalAlpha', 'globalCompositeOperation', 'filter']) {
        Object.defineProperty(ctx, key, {
            get() { return state[key]; },
            set(v) { state[key] = v; },
        });
    }
    return cv;
}

/** 注入 codec：编码走假画布，解码按 tag 还原位图，空白位图也是假画布 */
function useCodec() {
    store.__setCodec({
        canvas: (w, h) => fakeCanvas(w, h),
        surface: (w, h) => fakeCanvas(w, h),
        decode: async (url) => {
            const tag = tagOf(url);
            const size = BITMAPS.get(tag) || { w: 1, h: 1 };
            return fakeBitmap(size.w, size.h, tag);
        },
    });
}

// 整份文件都在替身 codec 下跑（Node 里没有 document / OffscreenCanvas）
useCodec();
test.after(() => { store.__resetCodec(); });

/** 纹理时间点统一收敛到 1e-6：帧累加得来的秒会有 0.30000000000000004 这类尾巴 */
const timesOf = (obj) => celTimes(obj).map((t) => Math.round(t * 1e6) / 1e6);
const near = (actual, expected) => Math.abs(Number(actual) - Number(expected)) < 1e-9;

/* ─────────────────────────── 造文档 ─────────────────────────── */

/** 40x30、fps 10：唯一对象在 0/1/2 秒各有一个纹理，三格共用同一张位图 A */
function richDoc() {
    BITMAPS.set('A', { w: 40, h: 30 });
    const a = fakeBitmap(40, 30, 'A');
    const obj = makeObject({
        id: 'img-1',
        name: '图片元素',
        kind: 'image',
        anchor: { x: 0.5, y: 0.5 },
        opacity: 0.8,
        mixMode: 'multiply',
        transform: { keys: [makeKey(0, {}), makeKey(0.5, { x: 100, y: 40 }, 'bezier', [0.1, 0.2], [0.8, 0.9])] },
        cels: [{ at: 0, image: a }, { at: 1, image: a }, { at: 2, image: a }],
    });
    const doc = createDoc({ width: 40, height: 30, fps: 10, objects: [obj] });
    return { doc, elementId: 'img-1', bitmap: a };
}

/** 40x30、fps 10、时长 0.5 秒的采样素材（sampleTimes → 0/0.1/0.2/0.3/0.4） */
function spriteDoc() {
    BITMAPS.set('S', { w: 40, h: 30 });
    const img = fakeBitmap(40, 30, 'S');
    const obj = makeObject({ id: 's1', kind: 'image', cels: [{ at: 0, image: img }] });
    return createDoc({ width: 40, height: 30, fps: 10, duration: 0.5, objects: [obj] });
}

function countOf(haystack, needle) {
    return String(haystack).split(needle).length - 1;
}

/* ─────────────────────── v4 序列化（doc-model → JSON） ─────────────────────── */

test('v4 序列化：没有 frames 键，纹理是 {at,image}，at 是秒', () => {
    const { doc, elementId } = richDoc();
    const node = store.docToJSON(doc);
    assert.ok(node);
    assert.equal('frames' in node, false);
    assert.equal('layers' in node, false);
    assert.equal(node.version, undefined, 'docToJSON 只管文档节点，版本号在信封上');

    const el = node.elements[0];
    assert.equal(el.id, elementId);
    assert.equal(el.kind, 'image');
    assert.equal(el.opacity, 0.8);
    assert.equal(el.mixMode, 'multiply');
    assert.deepEqual(el.anchor, { x: 0.5, y: 0.5 });
    // v8：纹理挂在关键帧上，所以写盘时「带纹理的关键帧」与「纯位移关键帧」在同一个 keys 数组里；
    // cels 是投影（供旧版读取），时间点与带纹理的关键帧一致。
    assert.deepEqual(el.transform.keys.map((k) => k.t), [0, 0.5, 1, 2], '关键帧时间是秒');
    assert.deepEqual(el.cels.map((c) => c.at), [0, 1, 2]);
    assert.deepEqual(el.cels[0].image, { ref: elementId, w: 40, h: 30 });
    assert.equal(node.duration, 2);
});

test('v4 序列化：duration 取 docDuration（显式时长或内容末端）', () => {
    const declared = createDoc({
        width: 40,
        height: 30,
        fps: 10,
        duration: 5,
        objects: [makeObject({ id: 'x', cels: [{ at: 1, image: null }] })],
    });
    assert.equal(store.docToJSON(declared).duration, 5);

    const derived = createDoc({
        width: 40,
        height: 30,
        fps: 10,
        objects: [makeObject({ id: 'y', cels: [{ at: 0, image: null }, { at: 1.25, image: null }] })],
    });
    assert.equal(docDuration(derived), 1.25);
    assert.equal(store.docToJSON(derived).duration, 1.25);
});

test('assets 去重：同一张位图被 3 个纹理共用，只编码一次', () => {
    const { doc, elementId } = richDoc();
    const node = store.docToJSON(doc);
    assert.deepEqual(Object.keys(node.assets), [elementId]);
    assert.equal(node.assets[elementId], dataURLOf('A'));
    assert.equal(countOf(JSON.stringify(node), dataURLOf('A')), 1, 'dataURL 只出现一次');
    assert.deepEqual(node.elements[0].cels.map((c) => c.image.ref), [elementId, elementId, elementId]);
});

test('assets 去重：第 2 张不同的图才用 id#2', () => {
    BITMAPS.set('A', { w: 40, h: 30 });
    BITMAPS.set('B', { w: 40, h: 30 });
    const a = fakeBitmap(40, 30, 'A');
    const b = fakeBitmap(40, 30, 'B');
    const doc = createDoc({
        width: 40,
        height: 30,
        fps: 10,
        objects: [makeObject({ id: 'p1', kind: 'image', cels: [{ at: 0, image: a }, { at: 1, image: b }, { at: 2, image: a }] })],
    });
    const node = store.docToJSON(doc);
    assert.deepEqual(Object.keys(node.assets), ['p1', 'p1#2']);
    assert.equal(node.assets['p1'], dataURLOf('A'));
    assert.equal(node.assets['p1#2'], dataURLOf('B'));
    assert.deepEqual(node.elements[0].cels.map((c) => c.image.ref), ['p1', 'p1#2', 'p1']);
});

test('空纹理：image 写 null，不产生 assets、不内联位图', () => {
    const doc = createDoc({ width: 64, height: 48, fps: 8 });
    const node = store.docToJSON(doc);
    assert.deepEqual(node.elements[0].cels, [{ at: 0, image: null }]);
    assert.deepEqual(node.assets, {});
    assert.equal(countOf(JSON.stringify(node), 'data:image'), 0);
});

/* ─────────────────────── 文件信封 ─────────────────────── */

test('docToFile：信封带 format/version，节点里没有 frames', () => {
    useCodec();
    const { doc } = richDoc();
    const file = store.docToFile(doc, { name: '测试项目', savedAt: 123 });
    assert.equal(file.format, store.FORMAT);
    assert.equal(file.version, 4);
    assert.equal(file.name, '测试项目');
    assert.equal(file.savedAt, 123);
    assert.equal('frames' in file, false);
    assert.equal(file.elements.length, 1);
    assert.equal(file.elements[0].cels.length, 3);
    // 扁平文件本身就是文档节点；带 doc 的信封才需要剥壳
    assert.equal(store.projectNode(file), file);
    assert.equal(store.isProjectPayload(file), true);
    assert.equal(store.isProjectPayload({ format: 'other-app', elements: [{}] }), false);
    assert.equal(store.projectNode({ format: 'other-app' }), null);
});

/* ─────────────────────── 旧帧模型迁移 ─────────────────────── */

test('migrateFromFrames：hold 的旧帧不重复建纹理，只给「有图变化」的时间点建格', () => {
    const a = fakeBitmap(40, 30, 'A');
    const b = fakeBitmap(40, 30, 'B');
    const legacy = {
        width: 40,
        height: 30,
        fps: 10,
        layers: [{ id: 'L1', name: '旧图层' }],
        frames: [
            { cels: { L1: { image: a } } },
            { cels: { L1: { hold: true } } },
            { cels: { L1: { hold: true } } },
            { cels: { L1: { image: b } } },
            { cels: { L1: { image: null, hold: false } } },
        ],
    };
    const doc = migrateFromFrames(legacy);
    const obj = doc.objects[0];
    assert.equal('frames' in doc, false);
    assert.equal(obj.id, 'L1');
    assert.deepEqual(timesOf(obj), [0, 0.3, 0.4], '5 帧只留下 3 个时间点');
    assert.equal(imageAt(obj, 0), a, '位图不复制，仍是同一个对象');
    assert.equal(imageAt(obj, 0.35), b, 'hold 段沿用上一张图');
    assert.equal(imageAt(obj, 0.4), null, '显式断开继承留空纹理');
    assert.ok(near(docDuration(doc), 0.5));
});

test('v3 帧节点 → jsonToDoc：相邻帧同一张位图只建一条纹理', async () => {
    useCodec();
    BITMAPS.set('A', { w: 40, h: 30 });
    BITMAPS.set('B', { w: 40, h: 30 });
    const imgA = { dataUrl: dataURLOf('A'), w: 40, h: 30 };
    const imgB = { dataUrl: dataURLOf('B'), w: 40, h: 30 };
    const legacy = {
        format: store.FORMAT,
        version: 3,
        width: 40,
        height: 30,
        fps: 10,
        elements: [{ id: 'L1', name: '旧图层' }],
        frames: [
            { duration: 1, cels: { L1: { image: imgA } } },
            { duration: 1, cels: { L1: { image: Object.assign({}, imgA) } } },
            { duration: 1, cels: { L1: { image: imgB } } },
        ],
    };
    const doc = await store.jsonToDoc(legacy);
    assert.ok(doc);
    assert.equal('frames' in doc, false);
    const obj = doc.objects[0];
    assert.deepEqual(timesOf(obj), [0, 0.2], '第 2 帧内容没变，不建纹理');
    assert.equal(imageAt(obj, 0).__tag, 'A');
    assert.equal(imageAt(obj, 0.1).__tag, 'A', '第 2 帧沿用第 1 格');
    assert.equal(imageAt(obj, 0.25).__tag, 'B');
    assert.ok(near(docDuration(doc), 0.3));
});

test('v4 往返：docToFile → jsonToDoc，纹理时间点与位图逐点还原', async () => {
    useCodec();
    const { doc, elementId } = richDoc();
    const back = await store.jsonToDoc(store.docToFile(doc, { name: '往返' }));
    assert.ok(back);
    assert.equal(back.width, 40);
    assert.equal(back.height, 30);
    assert.equal(back.fps, 10);
    assert.equal('frames' in back, false);
    const obj = back.objects[0];
    assert.equal(obj.id, elementId);
    // v8：纹理是关键帧属性（key.drawing），所以纹理时间点就是「带纹理的关键帧」，
    // 纯位移关键帧（0.5）不产生纹理切换点。
    assert.deepEqual(celTimes(obj), [0, 1, 2]);
    assert.deepEqual(celTimes(obj).map((x) => imageAt(obj, x).__tag), ['A', 'A', 'A']);
    assert.deepEqual(obj.transform.keys.map((k) => k.t), [0, 0.5, 1, 2]);
    assert.deepEqual(
        obj.transform.keys.filter((k) => Object.prototype.hasOwnProperty.call(k, 'drawing')).map((k) => k.t),
        [0, 1, 2]
    );
    assert.equal(docDuration(back), 2);
});

/* ─────────────────────── 精灵图（采样时间点） ─────────────────────── */

test('精灵图：采样点来自 sampleTimes，每格带 t 与 duration', () => {
    const doc = spriteDoc();
    const layout = sheetLayout(doc, { columns: 2 });
    assert.deepEqual(layout.times, [0, 0.1, 0.2, 0.3, 0.4]);
    assert.equal(layout.columns, 2);
    assert.equal(layout.rows, 3);
    assert.equal(layout.width, 80);
    assert.equal(layout.height, 90);
    assert.equal(layout.sampleRate, 10);
    assert.equal(layout.duration, 0.5);
    assert.deepEqual(layout.frames[0], { index: 0, x: 0, y: 0, w: 40, h: 30, t: 0, duration: 0.1 });
    assert.deepEqual(layout.frames[3], { index: 3, x: 40, y: 30, w: 40, h: 30, t: 0.3, duration: 0.1 });
    assert.deepEqual(layout.frames[4], { index: 4, x: 0, y: 60, w: 40, h: 30, t: 0.4, duration: 0.1 });
});

test('精灵图：times 优先；最后一格的 duration 用 step 兜底', () => {
    const doc = spriteDoc();
    const layout = sheetLayout(doc, { times: [0, 0.25, 0.4] });
    assert.deepEqual(layout.times, [0, 0.25, 0.4]);
    assert.deepEqual(layout.frames.map((f) => f.duration), [0.25, 0.15, 0.15]);

    const stepwise = sheetLayout(doc, { step: 0.25 });
    assert.deepEqual(stepwise.times, [0, 0.25]);
    assert.deepEqual(stepwise.frames.map((f) => f.duration), [0.25, 0.25]);
    assert.equal(stepwise.sampleRate, 4);
});

test('精灵图：没有采样点时不产出整图', () => {
    const doc = spriteDoc();
    assert.deepEqual(sheetLayout(doc, { times: [] }).frames, []);
    assert.equal(buildSpritesheet(doc, { times: [], createCanvas: fakeCanvas }), null);
    assert.equal(buildSpritesheet(doc, { createCanvas: () => null }), null);
});

test('精灵图：每格按自己的采样时间合成，帧表用 t 字段', () => {
    useCodec();
    const doc = spriteDoc();
    const sheet = buildSpritesheet(doc, { columns: 2, createCanvas: (w, h) => fakeCanvas(w, h) });
    assert.ok(sheet);
    assert.equal(sheet.canvas.width, 80);
    assert.equal(sheet.canvas.height, 90);
    assert.deepEqual(sheet.canvas.__drawn.map((d) => [d.x, d.y]), [[0, 0], [40, 0], [0, 30], [40, 30], [0, 60]]);

    const json = sheet.json;
    assert.equal(json.format, SHEET_FORMAT);
    assert.equal(json.version, SHEET_VERSION);
    assert.equal(json.sampleRate, 10);
    assert.equal(json.duration, 0.5);
    assert.equal(json.frames.length, 5);
    assert.equal('time' in json.frames[0], false);
    // v0.14 起帧表多了 trim 矩形字段（不是随手加的）：`x/y/w/h` 仍是**格在图集里的位置**，
    // `sx/sy/sw/sh` 是**内容在原帧坐标系里**的矩形，`trimmed` 标这一格是否真裁过。
    // 这里注入的假画布读不到像素 → 不裁，四个字段就是「等价旧帧表」的默认值。
    assert.deepEqual(json.frames[3], {
        index: 3, x: 40, y: 30, w: 40, h: 30, t: 0.3, duration: 0.1,
        sx: 0, sy: 0, sw: 40, sh: 30, trimmed: false,
    });
    // 分张清单也要在：单张时就是一项，与磁盘文件一一对应
    assert.deepEqual(json.sheets, [{ file: 'sheet-1.png', width: 80, height: 90 }]);
    assert.equal(sheet.times.length, 5);
});

test('精灵图：background 铺底一次，底色不覆盖合成内容', () => {
    useCodec();
    const doc = spriteDoc();
    const sheet = buildSpritesheet(doc, { columns: 5, background: '#ffffff', createCanvas: (w, h) => fakeCanvas(w, h) });
    assert.ok(sheet);
    assert.equal(sheet.canvas.__fills.length, 1);
    assert.deepEqual(sheet.canvas.__fills[0], { style: '#ffffff', x: 0, y: 0, w: 200, h: 30 });
    assert.equal(sheet.canvas.__state.fillStyle, '#000000', '铺完底把 fillStyle 还原');
});

/* ─────────────────────── 导入图片 → 挂进文档 ─────────────────────── */

test('导入图片：t=0 建一个纹理，序列化后只有一条 asset', async () => {
    useCodec();
    BITMAPS.set('P', { w: 20, h: 10 });
    const doc = createDoc({ width: 100, height: 80, fps: 10 });
    const imported = await store.imageElementFromFile({ name: 'p.png', dataUrl: dataURLOf('P') });
    assert.ok(imported);
    assert.equal(imported.width, 20);
    assert.equal(imported.height, 10);

    const added = store.addImageElement(doc, imported);
    assert.equal(added.celCount, 1);
    const obj = added.doc.objects[0];
    assert.equal(obj.id, added.element.id);
    assert.deepEqual(celTimes(obj), [0]);
    assert.equal(obj.cels[0].image.__tag, 'P');
    assert.equal(imageAt(obj, 3).__tag, 'P', '纹理从 at 起一直有效');

    const node = store.docToJSON(added.doc);
    assert.equal(node.elements.length, 2);
    assert.deepEqual(Object.keys(node.assets), [obj.id]);
    assert.equal(node.elements[0].cels.length, 1);
    assert.equal(node.elements[0].cels[0].at, 0);
    assert.equal(node.elements[0].cels[0].image.ref, obj.id);
});
