import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as store from '../app/shell/project-store.mjs';

/*
 * 读入侧的文档形状：v1–v3 老存档的 fps 缺省、以及画布尺寸上限。
 * 这里全部走 jsonToDoc（真实的读入入口），不放宽它的对外形状。
 */

// 没有 preload 桥时 project-store 用 codec 解码位图；这些样本不带图，给个最小的假解码器即可。
store.__setCodec({
    decode: async () => ({ width: 8, height: 8 }),
    surface: () => ({ w: 8, h: 8 }),
    canvas: () => ({ getContext: () => null }),
});

/** v1–v3 帧模型样本（`version <= 3` 才走 migrateFromFrames）。 */
function legacy(extra) {
    return {
        version: 3,
        width: 640,
        height: 480,
        elements: [{ id: 'a', name: 'a', frames: [] }],
        frames: [{ duration: 1 }],
        ...extra,
    };
}

/** v4 时间模型样本（扁平 doc 包在信封里，与真实 .msp 同形）。 */
function v4(patch) {
    return {
        format: 'motionstudio-project',
        version: 4,
        doc: {
            width: 900,
            height: 640,
            fps: 12,
            loopMode: 'cycle',
            duration: 3,
            tags: [],
            elements: [
                {
                    id: 'a',
                    name: 'a',
                    parentId: '',
                    visible: true,
                    transform: { keys: [{ t: 0, ease: 'linear', state: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotate: 0 } }] },
                    cels: [],
                },
            ],
            ...patch,
        },
    };
}

test('v1–v3 缺 fps 的老存档按 12 fps 打开（不是 1）', async () => {
    const d = await store.jsonToDoc(legacy());
    assert.ok(d, '样本应当能被读入');
    assert.equal(d.fps, 12);
});

test('v1–v3 的 fps: 0 也回到 12（0 不是合法帧率）', async () => {
    assert.equal((await store.jsonToDoc(legacy({ fps: 0 }))).fps, 12);
});

test('v1–v3 的 fps: 24 保持 24', async () => {
    assert.equal((await store.jsonToDoc(legacy({ fps: 24 }))).fps, 24);
});

test('v1–v3 的 fps: 999 被夹到 120（上限不是 1）', async () => {
    assert.equal((await store.jsonToDoc(legacy({ fps: 999 }))).fps, 120);
});

test('clampNum 的语义：非有限数返回下限 —— 所以本层别再写 `clampNum(...) || 兜底`', async () => {
    // 这条是给未来的注释：clampNum(undefined, 1, 120) 返回 1（不是 NaN），
    // 于是 `clampNum(old.fps, 1, 120) || 12` 里的 `|| 12` 永远拿不到。
    // 用可观测行为钉住：缺 fps 得到 12 而不是 1。
    for (const bad of [undefined, null, '', 'abc', NaN, -Infinity]) {
        const d = await store.jsonToDoc(legacy({ fps: bad }));
        assert.equal(d.fps, 12, 'fps=' + String(bad) + ' 应回到 12');
    }
});

test('v4 真实形状：fps / duration / 尺寸都不被改动', async () => {
    const d = await store.jsonToDoc(v4());
    assert.ok(d);
    assert.equal(d.fps, 12);
    assert.equal(d.duration, 3);
    assert.equal(d.width, 900);
    assert.equal(d.height, 640);
    assert.equal(d.loopMode, 'cycle');
    assert.equal(d.objects.length, 1);
});

test('画布尺寸：超过上限被夹到 4096，不再能开 10 万', async () => {
    const d = await store.jsonToDoc(v4({ width: 100000, height: 100000 }));
    assert.equal(d.width, 4096);
    assert.equal(d.height, 4096);
});

test('画布尺寸：下限保持 1（历史里 1×1 的文件仍能打开）', async () => {
    const d = await store.jsonToDoc(v4({ width: 1, height: 1 }));
    assert.equal(d.width, 1);
    assert.equal(d.height, 1);
});

test('画布尺寸：正常值与缺省值不受影响', async () => {
    assert.equal((await store.jsonToDoc(v4({ width: 1280, height: 720 }))).width, 1280);
    // 缺省走 FALLBACK 900×640
    const noSize = v4();
    delete noSize.doc.width;
    delete noSize.doc.height;
    const d = await store.jsonToDoc(noSize);
    assert.equal(d.width, 900);
    assert.equal(d.height, 640);
});
