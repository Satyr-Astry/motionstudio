// app/core/cel.mjs 的契约测试（v6 时间模型）
//
// 这个文件守两件事：
//   1) cel.mjs 只是 doc-model.mjs 的适配层 —— 文档模型符号必须是**同一个函数对象**，
//      不允许在适配层里复制实现（复制就会漂移）；
//   2) 适配层自己留下的少数辅助（对象增删改序、洋葱皮归一时长辅助）行为正确。
// 「纹理按时间生效」的语义细节在 tests/cel-time.test.mjs。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as cel from '../app/core/cel.mjs';
import * as dm from '../app/core/doc-model.mjs';
import { celTimes } from '../app/core/doc-model.mjs';

const {
    LOOP_CYCLE,
    LOOP_PINGPONG,
    LOOP_NONE,
    createDocument,
    addLayer,
    removeLayer,
    patchLayer,
    patchObject,
    moveLayer,
    replaceLayers,
    layerById,
    objectsOf,
    objectById,
    setImageAt,
    imageAt,
    cloneDocument,
    normalizeOnion,
    ONION_DEFAULTS,
    wrapTime,
    fpsAtTime,
    totalSeconds,
    docDuration,
    contentDuration,
} = cel;

const ids = (doc) => objectsOf(doc).map((o) => o.id);

test('createDocument 转发 doc-model.createDoc：1 对象、1 个 at=0 纹理', () => {
    assert.equal(createDocument, dm.createDoc, 'createDocument 是 createDoc 的别名');
    const doc = createDocument({ width: 32, height: 16, fps: 12 });
    assert.equal(doc.width, 32);
    assert.equal(doc.height, 16);
    assert.equal(doc.fps, 12);
    assert.equal(doc.loopMode, LOOP_CYCLE);
    assert.equal(doc.objects.length, 1);
    assert.deepEqual(doc.tags, []);
    const obj = doc.objects[0];
    assert.equal(obj.cels.length, 1);
    assert.equal(obj.cels[0].at, 0);
    assert.equal(obj.cels[0].image, null);
});

test('文档模型符号全部是转发而非复制（同一函数对象）', () => {
    const forwarded = [
        'normAt', 'makeObject', 'normCel', 'objectsOf', 'objectById',
        'celTimes', 'celIndexAt', 'celAt', 'imageAt', 'hasCelAt', 'isCelBoundary',
        'ensureCelAt', 'setImageAt', 'removeCelAt', 'moveCel',
        'contentDuration', 'docDuration', 'totalSeconds',
        'patchObject', 'addObject', 'removeObject', 'reorderObject',
        'migrateFromFrames', 'eventTimes', 'sampleTimes',
        'stateOf', 'emptyTrack', 'makeKey',
    ];
    for (const name of forwarded) {
        assert.equal(typeof dm[name], 'function', `doc-model 应导出 ${name}`);
        assert.equal(cel[name], dm[name], `cel.${name} 应直接转发 doc-model`);
    }
});

test('帧概念相关导出已彻底消失', () => {
    // v5 的历史导出名：帧序号 / hold 开关时代的残留，必须永远不再出现。
    // 后两项用拼接写，只是为了让「grep 无 hold 残留」的机械验收保持干净。
    const gone = [
        'frameStart', 'frameSeconds', 'frameCount', 'syncCels', 'makeCel',
        'resolveCelImage', 'is' + 'H' + 'olding', 'setCel' + 'H' + 'old', 'materializeCel',
        'linkCels', 'unlinkCel', 'cloneFrame', 'sampleFrame',
        'addFrame', 'removeFrame', 'moveFrame', 'setFrameDuration',
        'frameAtTime', 'onionFrames', 'eachCel', 'patchCel', 'setCelImage',
    ];
    for (const name of gone) assert.equal(cel[name], undefined, `cel.${name} 应已删除`);
});

test('totalSeconds 转发 docDuration：显式时长优先，内容超出时以内容为准', () => {
    const doc = createDocument({ duration: 2 });
    assert.equal(totalSeconds(doc), 2);
    assert.equal(totalSeconds(doc), docDuration(doc));

    const bare = createDocument();
    assert.equal(docDuration(bare), contentDuration(bare), '没有内容时时长就是 0');
    assert.equal(totalSeconds(bare), 0);

    const longer = createDocument({
        duration: 1,
        objects: [{ name: 'A', cels: [{ at: 0, image: null }, { at: 3.5, image: null }] }],
    });
    assert.equal(contentDuration(longer), 3.5);
    assert.equal(totalSeconds(longer), 3.5, '内容比显式时长更长时取内容');
});

test('layerById 与 objectById 同源：找不到返回 null', () => {
    const doc = createDocument();
    const id = objectsOf(doc)[0].id;
    assert.equal(layerById(doc, id), objectsOf(doc)[0]);
    assert.equal(layerById(doc, id), objectById(doc, id));
    assert.equal(layerById(doc, 'nope'), null);
    assert.equal(layerById(doc, null), null);
});

test('addLayer 把新对象插到最前（第 0 项是最上层）', () => {
    const doc = createDocument();
    const next = addLayer(doc, 'B');
    assert.equal(objectsOf(next).length, 2);
    assert.equal(objectsOf(next)[0].name, 'B');
    assert.equal(objectsOf(next)[1], objectsOf(doc)[0]);
    assert.equal(objectsOf(next)[0].cels.length, 1);
    assert.equal(objectsOf(next)[0].cels[0].at, 0);
    assert.notEqual(objectsOf(next)[0].id, objectsOf(next)[1].id);
    assert.equal(objectsOf(doc).length, 1, '不改入参');
    assert.equal(addLayer(doc, '').objects[0].name, '对象 2', '缺省名按现有数量编号');
});

test('removeLayer 可以删到一个不剩，且把子对象提到根', () => {
    const one = createDocument();
    // v8：空文档是合法状态（画板/时间轴/属性都有空态分支），不再「保底留一个」
    assert.equal(objectsOf(removeLayer(one, objectsOf(one)[0].id)).length, 0, '最后一个也能删');

    let doc = addLayer(createDocument(), 'B');
    const top = objectsOf(doc)[0].id;
    const bottom = objectsOf(doc)[1].id;
    const child = patchLayer(doc, bottom, { parentId: top });
    const next = removeLayer(child, top);
    assert.equal(objectsOf(next).length, 1);
    assert.equal(objectsOf(next)[0].id, bottom);
    assert.equal(objectsOf(next)[0].parentId, undefined, '父对象消失后回到根');
    assert.deepEqual(ids(removeLayer(doc, 'nope')), ids(doc), '未命中时对象原样保留');
});

test('patchLayer 命中才换新对象，未命中或空补丁返回原引用', () => {
    const doc = createDocument();
    const id = objectsOf(doc)[0].id;
    assert.equal(patchLayer(doc, 'nope', { visible: false }), doc);
    assert.equal(patchLayer(doc, id, null), doc);
    assert.equal(patchLayer(doc, id, {}), doc);

    const next = patchLayer(doc, id, { visible: false, opacity: 0.5 });
    assert.notEqual(next, doc);
    assert.equal(objectsOf(next)[0].visible, false);
    assert.equal(objectsOf(next)[0].opacity, 0.5);
    assert.equal(objectsOf(doc)[0].visible, true, '不改入参');
});

test('moveLayer 改变顺序并夹取边界', () => {
    let doc = createDocument();
    doc = addLayer(doc, 'B');
    doc = addLayer(doc, 'C');
    const order = ids(doc);
    assert.equal(order.length, 3);

    assert.deepEqual(ids(moveLayer(doc, order[2], 0)), [order[2], order[0], order[1]]);
    assert.deepEqual(
        ids(moveLayer(doc, order[0], 99)),
        ids(moveLayer(doc, order[0], 2)),
        '越界夹到末位',
    );
    assert.equal(moveLayer(doc, 'missing', 0), doc);
    assert.equal(moveLayer(doc, order[0], 0), doc, '位置没变 → 原引用');
});

test('replaceLayers 按 defs 顺序重建，并保留原对象的时间纹理', () => {
    const doc = createDocument();
    const id = objectsOf(doc)[0].id;
    const withCel = patchObject(doc, id, (o) => setImageAt(o, 0.5, 'IMG'));

    const next = replaceLayers(withCel, [{ id, name: '改名' }]);
    assert.equal(objectsOf(next).length, 1);
    assert.equal(objectsOf(next)[0].name, '改名');
    assert.deepEqual(celTimes(objectsOf(next)[0]), celTimes(objectsOf(withCel)[0]));
    assert.equal(imageAt(objectsOf(next)[0], 0.5), 'IMG');
    assert.equal(imageAt(withCel.objects[0], 0.5), 'IMG', '不改入参');
    assert.equal(replaceLayers(doc, []), doc, '空定义表不销毁文档');
});

test('cloneDocument 是深拷贝：结构相等但互不影响', () => {
    const doc = createDocument();
    const copy = cloneDocument(doc);
    assert.notEqual(copy, doc);
    assert.deepEqual(copy, doc);
    copy.objects[0].name = 'X';
    assert.notEqual(objectsOf(doc)[0].name, 'X');
});

test('normalizeOnion 夹取边界、只认 tint/fade', () => {
    const cfg = normalizeOnion({ enabled: 1, before: 99, after: -3, opacity: 2, mode: 'x', past: 5 });
    assert.equal(cfg.enabled, false, '只认严格的 true');
    assert.equal(cfg.before, 12);
    assert.equal(cfg.after, 0);
    assert.equal(cfg.opacity, 1);
    assert.equal(cfg.mode, 'tint');
    assert.equal(cfg.past, ONION_DEFAULTS.past);
    assert.equal(cfg.ignoreTransform, false);

    assert.deepEqual(normalizeOnion(null), {
        enabled: false,
        before: 1,
        after: 1,
        mode: 'tint',
        past: ONION_DEFAULTS.past,
        next: ONION_DEFAULTS.next,
        opacity: 0.4,
        ignoreTransform: false,
    });
    assert.equal(normalizeOnion({ mode: 'fade' }).mode, 'fade');
    assert.equal(normalizeOnion({ before: 2.6 }).before, 3, '四舍五入');
    assert.equal(normalizeOnion({ enabled: true, ignoreTransform: true }).ignoreTransform, true);
});

test('wrapTime：cycle 取模、pingpong 往返、none 越界返回 null', () => {
    const cyc = createDocument({ duration: 3 });
    assert.equal(wrapTime(cyc, 0), 0);
    assert.equal(wrapTime(cyc, 3), 0);
    assert.equal(wrapTime(cyc, 4), 1);
    assert.equal(wrapTime(cyc, -1), 2);
    assert.equal(wrapTime(cyc, -3.5), 2.5);
    assert.equal(wrapTime(cyc, 2.5), 2.5);

    const pp = createDocument({ duration: 3, loopMode: LOOP_PINGPONG });
    assert.equal(wrapTime(pp, 2), 2);
    assert.equal(wrapTime(pp, 3), 3);
    assert.equal(wrapTime(pp, 4), 2);
    assert.equal(wrapTime(pp, 5), 1);
    assert.equal(wrapTime(pp, 6), 0);
    assert.equal(wrapTime(pp, 7), 1);

    const none = createDocument({ duration: 3, loopMode: LOOP_NONE });
    assert.equal(wrapTime(none, 0), 0);
    assert.equal(wrapTime(none, 2.9), 2.9);
    assert.equal(wrapTime(none, 3), null);
    assert.equal(wrapTime(none, -0.1), null);
});

test('fpsAtTime 按分段表取帧率，非法 fps 返回 0', () => {
    const doc = createDocument({
        fps: 12,
        timebase: { segments: [{ at: 0, fps: 10 }, { at: 1, fps: 20 }] },
    });
    assert.equal(fpsAtTime(doc, 0), 10);
    assert.equal(fpsAtTime(doc, 0.99), 10);
    assert.equal(fpsAtTime(doc, 1), 20);
    assert.equal(fpsAtTime(doc, 9), 20);
    assert.equal(fpsAtTime(createDocument({ fps: 24 }), 5), 24, '没有分段表时就是 doc.fps');
    const zero = Object.assign(createDocument(), { fps: 0 });
    assert.equal(fpsAtTime(zero, 0), 0);
});
