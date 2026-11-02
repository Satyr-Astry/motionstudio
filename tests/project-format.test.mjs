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

/* ──────────────── 项目库记录：openedAt / 库内复制 / 整库备份包 ──────────────── */

test('makeRecord 带 openedAt（默认 = savedAt），stripRecord 透传', () => {
    const { doc } = richDoc();
    const rec = store.makeRecord({ name: '甲', doc, openedAt: 111 });
    assert.equal(rec.openedAt, 111, '调用方给的 openedAt 要原样留下（保存不是打开）');
    assert.ok(rec.savedAt > 0);
    assert.equal(store.stripRecord(rec).openedAt, 111);

    const dflt = store.makeRecord({ name: '乙', doc });
    assert.equal(dflt.openedAt, dflt.savedAt, '没给 openedAt 时退回 savedAt');
    // 老记录（alpha.44 及以前）没有这个字段：透传成 0（面板据此不显示），
    // 不能拿 savedAt 顶替 —— 那等于替用户编一个没发生过的「打开」动作
    assert.equal(store.stripRecord({ savedAt: 9 }).openedAt, 0);
});

test('库内复制：新 id / 新名字 / file 清空（防 Ctrl+S 覆盖原文件），内容原样', async () => {
    store.__resetMemory();
    const { doc } = richDoc();
    const src = store.makeRecord({ id: 'src-1', name: '甲', doc, file: 'C:/work/jia.msp', openedAt: 5 });
    await store.putProject(src);

    const copy = await store.duplicateProject('src-1', { name: '甲 副本' });
    assert.ok(copy);
    assert.notEqual(copy.id, 'src-1', '副本必须是新记录，不能覆盖原记录');
    assert.match(copy.id, /^proj-/);
    assert.equal(copy.name, '甲 副本');
    assert.equal(copy.file, '', '副本不能继承文件绑定（否则 Ctrl+S 写回原项目的 .msp）');
    assert.equal(copy.width, src.width);
    assert.equal(copy.frames, src.frames);
    assert.equal(copy.thumb, src.thumb);
    assert.equal(copy.openedAt, copy.savedAt, '复制出来的记录「打开时间」就是现在');
    assert.ok(copy.openedAt > 5);

    const full = await store.getProject(copy.id);
    assert.ok(full && full.project, '副本要带完整项目，打开才不丢内容');
    assert.equal(full.project.name, '甲 副本', '存为文件时写出来的名字也跟着改');
    assert.deepEqual(full.project.doc, src.project.doc, '文档内容一字不差');
    // 原记录不受影响
    const again = await store.getProject('src-1');
    assert.equal(again.name, '甲');
    assert.equal(again.file, 'C:/work/jia.msp');
    // 源记录不存在：返回 null，不造出半条记录
    assert.equal(await store.duplicateProject('nope', { name: 'x' }), null);
    assert.equal((await store.listProjects()).length, 2);
});

test('整库备份包：format/version/exportedAt/app + 完整项目节点（坏记录跳过）', () => {
    const { doc } = richDoc();
    const a = store.makeRecord({ id: 'b-1', name: 'A', doc, file: 'C:/a.msp' });
    const b = store.makeRecord({ id: 'b-2', name: 'B', doc });
    const bundle = store.libraryBundleOf([a, b, null, { id: 'x' }], { exportedAt: 1234 });

    assert.equal(bundle.format, store.LIBRARY_FORMAT);
    assert.equal(bundle.format, 'motionstudio-library');
    assert.equal(bundle.version, store.LIBRARY_VERSION);
    assert.equal(bundle.version, 1);
    assert.equal(bundle.app, 'motionstudio');
    assert.equal(bundle.exportedAt, 1234);
    assert.equal(bundle.projects.length, 2, '没有 project 的坏记录跳过，不毁掉整份备份');
    // 放进去的是「完整项目文件节点」：导入端能直接喂给 jsonToDoc
    assert.deepEqual(bundle.projects[0], a.project);
    assert.deepEqual(bundle.projects[1].doc, b.project.doc);
    assert.equal(bundle.projects[0].format, store.FORMAT);
    // 深拷贝：改备份包不该动到库里那份记录
    bundle.projects[0].name = '改坏了';
    assert.equal(a.project.name, 'A');
    // 空库也能出一份结构正确的包（是否允许导出空库由 io 层判）
    assert.deepEqual(store.libraryBundleOf([]).projects, []);
});

test('isLibraryPayload：只认 format + projects 数组，单项目文件与坏结构都不算', () => {
    const bundle = store.libraryBundleOf([], { exportedAt: 1 });
    assert.equal(store.isLibraryPayload(bundle), true);
    assert.equal(store.isLibraryPayload({ format: 'motionstudio-library' }), false, '没有 projects 数组');
    assert.equal(store.isLibraryPayload({ format: 'motionstudio-library', projects: {} }), false);
    assert.equal(store.isLibraryPayload({ format: 'motionstudio-project', projects: [] }), false, '换错 format');
    assert.equal(store.isLibraryPayload(null), false);
    assert.equal(store.isLibraryPayload('x'), false);
    // 单个项目文件（.msp）不能冒充备份包，反过来也一样
    const file = store.docToFile(richDoc().doc, { name: '单项目' });
    assert.equal(store.isLibraryPayload(file), false);
    assert.equal(store.isProjectPayload(file), true);
    assert.equal(store.isProjectPayload(bundle), false);
});

/* ───────────── P2 项目库：收藏置顶 / 标签 / 排序 / 库统计（alpha.46） ───────────── */

test('makeRecord 的 pinned / tags：默认 false / []，stripRecord 透传，老记录缺省', () => {
    const { doc } = richDoc();
    const rec = store.makeRecord({ name: '甲', doc });
    assert.equal(rec.pinned, false);
    assert.deepEqual(rec.tags, []);
    const stripped = store.stripRecord(rec);
    assert.equal(stripped.pinned, false);
    assert.deepEqual(stripped.tags, []);

    const pinned = store.makeRecord({ name: '乙', doc, pinned: true, tags: ['角色', '第一幕'] });
    assert.equal(pinned.pinned, true);
    assert.deepEqual(pinned.tags, ['角色', '第一幕']);
    assert.equal(store.stripRecord(pinned).pinned, true);
    assert.deepEqual(store.stripRecord(pinned).tags, ['角色', '第一幕']);

    // 老记录（alpha.45 及以前）没有这两个字段：缺省的 false / [] 不是「读坏了」
    const old = store.stripRecord({ id: 'old', name: '旧', savedAt: 1 });
    assert.equal(old.pinned, false);
    assert.deepEqual(old.tags, []);

    // 只有布尔 true 才算置顶：手改文件里的 1 / 'true' 不该把卡片顶上去
    assert.equal(store.makeRecord({ name: '丙', doc, pinned: 1 }).pinned, false);
    assert.equal(store.makeRecord({ name: '丁', doc, pinned: 'true' }).pinned, false);
    // stripRecord 对脏 pinned 同样收敛成 false（列表按 pinned 分组时不会出现「1 也算」）
    assert.equal(store.stripRecord({ pinned: 1 }).pinned, false);
    assert.equal(store.stripRecord({ pinned: true }).pinned, true);
});

test('tags 清洗：trim / 去空 / 去重 / 每个截到 24 字符 / 最多 8 个 / 丢弃非字符串', () => {
    const { doc } = richDoc();
    const messy = store.makeRecord({ name: '甲', doc, tags: ['  a  ', '', '   ', 'a', 'b', 3, null, {}, 'c'] });
    assert.deepEqual(messy.tags, ['a', 'b', 'c'], 'trim、去空、去重、非字符串一律丢掉');

    const nine = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'];
    assert.deepEqual(store.makeRecord({ name: '乙', doc, tags: nine }).tags, nine.slice(0, 8), '最多 8 个');

    const cut = store.makeRecord({ name: '丙', doc, tags: ['x'.repeat(30)] }).tags;
    assert.deepEqual(cut, ['x'.repeat(24)], '超长标签截到 24，不是整条丢掉');
    assert.equal(store.MAX_TAG_LEN, 24);
    assert.equal(store.MAX_TAGS, 8);

    // 截断后同名的两条要合并（去重放在截断之后）
    const same = store.makeRecord({ name: '丁', doc, tags: ['y'.repeat(30), 'y'.repeat(40)] }).tags;
    assert.deepEqual(same, ['y'.repeat(24)]);

    // 非数组不是它接受的形状：收敛成 []，不抛异常
    assert.deepEqual(store.makeRecord({ name: '戊', doc, tags: 'a,b' }).tags, []);
    // normalizeTags 是同一份口径（io 的 parseTags 复用），单独导出
    assert.deepEqual(store.normalizeTags([' 甲 ', '甲', '乙']), ['甲', '乙']);
    assert.deepEqual(store.stripRecord({ tags: [' 甲 ', '甲', ''] }).tags, ['甲'], '列表视图也清洗');
});

test('updateProjectMeta：只改白名单字段，其它键忽略；记录不存在返回 null', async () => {
    store.__resetMemory();
    const { doc } = richDoc();
    await store.putProject(
        store.makeRecord({ id: 'meta-1', name: '原名', doc, file: 'C:/a.msp', pinned: false, tags: ['旧'] })
    );
    const before = await store.getProject('meta-1');

    const out = await store.updateProjectMeta('meta-1', {
        pinned: true,
        tags: [' 新 ', '新', '二'],
        name: 'patch 里改名', // 白名单外：忽略
        file: 'C:/hack.msp', // 白名单外：忽略
        project: { hacked: true },
        bytes: 999,
    });
    assert.equal(out.pinned, true);
    assert.deepEqual(out.tags, ['新', '二']);
    assert.equal(out.name, '原名', '改名走 renameProject，不能从 patch 里改');
    assert.equal(out.file, 'C:/a.msp', '绑定归属走 writeProjectFile，不能从 patch 里改');
    assert.equal(out.bytes, before.bytes, 'bytes 由记录自己算，patch 不能改');

    const full = await store.getProject('meta-1');
    assert.equal(full.name, '原名');
    assert.equal(full.file, 'C:/a.msp');
    assert.equal(full.pinned, true);
    assert.deepEqual(full.tags, ['新', '二']);
    assert.ok(full.project && full.project.doc, '白名单更新不能把项目内容冲掉');

    // 只给一个字段时，另一个保持原样
    const only = await store.updateProjectMeta('meta-1', { pinned: false });
    assert.equal(only.pinned, false);
    assert.deepEqual(only.tags, ['新', '二']);

    // 全是白名单外的键：返回当前视图、不改记录（空 patch 不产生写库）
    const untouched = await store.updateProjectMeta('meta-1', { name: '又改' });
    assert.equal(untouched.name, '原名');
    assert.equal(untouched.pinned, false);

    assert.equal(await store.updateProjectMeta('nope', { pinned: true }), null);
    assert.equal(await store.updateProjectMeta('', { pinned: true }), null);
    assert.equal(await store.updateProjectMeta(null, { pinned: true }), null);
});

test('sortProjects：pinned 永远最前，四种模式组内排序，同值稳定，不改入参', () => {
    const rows = [
        { id: 'a', name: 'B', savedAt: 100, openedAt: 50, bytes: 10, pinned: false },
        { id: 'b', name: 'A', savedAt: 300, openedAt: 20, bytes: 5, pinned: true },
        { id: 'c', name: 'C', savedAt: 100, openedAt: 90, bytes: 30, pinned: false },
        { id: 'd', name: 'D', savedAt: 100, openedAt: 90, bytes: 30, pinned: false },
        { id: 'e', name: 'E', savedAt: 200, openedAt: 10, bytes: 7, pinned: true },
    ];
    const ids = (list) => list.map((r) => r.id).join('');

    // saved / opened：时间倒序；pinned 组内也按同一模式排（b 300/20 → e 200/10）
    assert.equal(ids(store.sortProjects(rows, 'saved')), 'beacd');
    assert.equal(ids(store.sortProjects(rows, 'opened')), 'becda');
    // name：localeCompare；pinned 组内 A(E?) —— b=A、e=E 排前面，其余 B/C/D 按名字
    assert.equal(ids(store.sortProjects(rows, 'name')), 'beacd');
    // size：bytes 倒序；pinned 组内 e(7) 在 b(5) 前
    assert.equal(ids(store.sortProjects(rows, 'size')), 'ebcda');
    // 无效模式退回 saved（localStorage 里的旧值不该让列表变成随机顺序）
    assert.equal(ids(store.sortProjects(rows, 'bogus')), 'beacd');
    assert.equal(ids(store.sortProjects(rows, undefined)), 'beacd');

    // 同值稳定：c/d 的 savedAt、openedAt、bytes 全相同，c 在入参里更靠前
    assert.ok(ids(store.sortProjects(rows, 'saved')).includes('cd'), '同值时保持入参顺序');
    assert.ok(ids(store.sortProjects(rows, 'size')).includes('cd'));
    // 不修改入参（顺序与 pinned 原样）
    assert.equal(ids(rows), 'abcde');
    assert.notEqual(store.sortProjects(rows, 'saved'), rows, '返回的是新数组');
    assert.equal(store.sortProjects(rows, 'saved')[0], rows[1], '元素仍是原记录引用（面板不用重建卡片）');

    // 坏数据不炸：缺字段按 0、null 行保持原位置（稳定）、非数组返回 []
    const messy = store.sortProjects([{ id: 'x' }, null, { id: 'y', savedAt: 5, pinned: true }], 'saved');
    assert.equal(messy.map((r) => (r ? r.id : 'null')).join(','), 'y,x,null');
    assert.deepEqual(store.sortProjects(null), []);
    assert.deepEqual(store.sortProjects(undefined), []);
});

test('libraryTotals：count 只数记录，bytes 求和且坏数据按 0', () => {
    assert.deepEqual(store.libraryTotals([]), { count: 0, bytes: 0 });
    assert.deepEqual(store.libraryTotals(null), { count: 0, bytes: 0 });
    assert.deepEqual(store.libraryTotals({ length: 3 }), { count: 0, bytes: 0 }, '不是数组就当空库');

    const rows = [{ bytes: 10 }, { bytes: '20' }, { bytes: -5 }, { bytes: 'x' }, null, 5, 'bad'];
    assert.deepEqual(store.libraryTotals(rows), { count: 4, bytes: 30 }, '非对象行不进 count，坏 bytes 按 0');
});
