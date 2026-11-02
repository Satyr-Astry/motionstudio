/**
 * Aseprite 帧表（`asepriteJSON`）与导出预设（`PRESETS` / `applyPreset`）
 *
 * 为什么这两件事放一个文件：它们是「导出即交付」同一批的两半 —— 预设决定
 * 导出的**形状**（格式、缩放、图集上限），Aseprite 帧表决定导出的**消费方**
 * （Aseprite / TexturePacker / Godot / Love2D / Unity 第三方导入器）。
 *
 * 最容易写错的两处：① **duration 单位**——Aseprite 用毫秒、项目内部用秒，
 * 漏了换算动画就慢 1000 倍，而且肉眼要播一遍才发现；② 预设「只是初值」，
 * 一旦写进 options 时顺手做了「锁定」，用户改任何一项都会被改回去。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { asepriteJSON, phaserJSON, sheetLayout } from '../app/shell/spritesheet.mjs';
import {
    ENGINES,
    PRESETS,
    PRESET_IDS,
    applyPreset,
    presetOf,
    normalizeExportOptions,
} from '../app/core/export-options.mjs';

/** 64×32、1 秒 12fps 的文档 → 12 个采样点。 */
function baseDoc(w = 64, h = 32, duration = 1, fps = 12) {
    return { width: w, height: h, duration, fps, objects: [] };
}

function baseSheet() {
    return sheetLayout(baseDoc(), {});
}

test('asepriteJSON：array 形式，每帧有 filename 与四组矩形', () => {
    const sheet = baseSheet();
    const json = asepriteJSON(sheet);
    assert.ok(Array.isArray(json.frames));
    assert.equal(json.frames.length, 12);
    const f = json.frames[0];
    assert.equal(f.filename, 'frame_0000');
    assert.deepEqual(Object.keys(f).sort(), [
        'duration', 'filename', 'frame', 'rotated', 'sourceSize',
        'spriteSourceSize', 'trimmed',
    ]);
    assert.equal(json.frames[1].filename, 'frame_0001');
    assert.equal(json.frames[11].filename, 'frame_0011');
});

test('asepriteJSON：duration 是毫秒（秒 × 1000），这是唯一必须换算的地方', () => {
    const sheet = baseSheet();
    // 1 秒 12fps → 每帧约 0.0833 秒
    const f = asepriteJSON(sheet).frames[0];
    assert.equal(f.duration, Math.round((1 / 12) * 1000));
    const meta = asepriteJSON(sheet).meta;
    // 总时长应约等于 1000ms（12 帧 × 83.33 取整后 = 996~1000）
    assert.ok(meta.duration >= 996 && meta.duration <= 1000, `总时长 ${meta.duration}ms 不在合理区间`);
    // 对照：自家帧表用秒
    assert.ok(sheet.frames[0].duration < 1);
});

test('asepriteJSON：duration 至少 1ms（Aseprite 把 0 当「用缺省」）', () => {
    const sheet = baseSheet();
    sheet.frames = sheet.frames.map((f) => Object.assign({}, f, { duration: 0 }));
    const f = asepriteJSON(sheet).frames[0];
    assert.equal(f.duration, 1);
});

test('asepriteJSON：frameTag 覆盖全部帧、方向 forward', () => {
    const json = asepriteJSON(baseSheet());
    assert.equal(json.meta.frameTags.length, 1);
    assert.deepEqual(json.meta.frameTags[0], {
        name: 'default',
        from: 0,
        to: 11,
        direction: 'forward',
    });
});

test('asepriteJSON：tag 参数能改名字（Aseprite 里就是一个动画标签）', () => {
    const json = asepriteJSON(baseSheet(), { tag: 'run' });
    assert.equal(json.meta.frameTags[0].name, 'run');
});

test('asepriteJSON：meta 带 image / size / frameCount / sheets，Aseprite 能认出图集', () => {
    const sheet = baseSheet();
    const json = asepriteJSON(sheet, { image: 'hero.png' });
    assert.equal(json.meta.app, 'MotionStudio');
    assert.equal(json.meta.image, 'hero.png');
    assert.equal(json.meta.format, 'RGBA8888');
    assert.deepEqual(json.meta.size, { w: sheet.width, h: sheet.height });
    assert.equal(json.meta.frameCount, 12);
    assert.equal(json.meta.sheets[0].file, 'hero.png');
    assert.equal(json.meta.layers[0].name, 'Sheet');
});

test('asepriteJSON：没裁过的帧 trimmed=false，frame 等于格位', () => {
    const sheet = baseSheet();
    const f = asepriteJSON(sheet).frames[0];
    assert.equal(f.trimmed, false);
    assert.equal(f.frame.w, sheet.cellWidth);
    assert.equal(f.frame.h, sheet.cellHeight);
    assert.deepEqual(f.spriteSourceSize, { x: 0, y: 0, w: sheet.cellWidth, h: sheet.cellHeight });
});

test('asepriteJSON：裁过的帧 frame 落在图集内、spriteSourceSize 记偏移', () => {
    const sheet = baseSheet();
    sheet.frames = sheet.frames.map((f, i) => (i === 3
        ? Object.assign({}, f, { sx: 5, sy: 7, sw: 20, sh: 11, trimmed: true })
        : f));
    const f = asepriteJSON(sheet).frames[3];
    const src = sheet.frames[3];
    assert.equal(f.trimmed, true);
    assert.deepEqual(f.frame, { x: src.x + 5, y: src.y + 7, w: 20, h: 11 });
    assert.deepEqual(f.spriteSourceSize, { x: 5, y: 7, w: 20, h: 11 });
    assert.deepEqual(f.sourceSize, { w: sheet.cellWidth, h: sheet.cellHeight });
});

test('asepriteJSON 对空输入返回 null，不抛（与 phaserJSON 同语义）', () => {
    assert.equal(asepriteJSON(null), null);
    assert.equal(asepriteJSON({}), null);
    assert.equal(asepriteJSON({ frames: 'nope' }), null);
});

test('asepriteJSON 与 phaserJSON 的 frame 矩形逐帧一致（同一套裁剪口径）', () => {
    const sheet = baseSheet();
    sheet.frames = sheet.frames.map((f, i) => (i === 5
        ? Object.assign({}, f, { sx: 3, sy: 4, sw: 18, sh: 9, trimmed: true })
        : f));
    const ase = asepriteJSON(sheet).frames;
    const pha = phaserJSON(sheet).frames;
    for (let i = 0; i < ase.length; i += 1) {
        const key = 'frame_' + String(i).padStart(4, '0');
        assert.deepEqual(ase[i].frame, pha[key].frame, `第 ${i} 帧的图集矩形不一致`);
        assert.deepEqual(ase[i].spriteSourceSize, pha[key].spriteSourceSize);
        assert.equal(ase[i].trimmed, pha[key].trimmed);
    }
});

test('ENGINES 白名单含 aseprite，且 both 仍在（历史存档要能读回来）', () => {
    assert.ok(ENGINES.includes('own'));
    assert.ok(ENGINES.includes('phaser'));
    assert.ok(ENGINES.includes('aseprite'));
    assert.ok(ENGINES.includes('both'));
});

test('normalizeExportOptions 认 aseprite、不认乱写的引擎名', () => {
    const doc = baseDoc();
    assert.equal(normalizeExportOptions({ engine: 'aseprite' }, doc).engine, 'aseprite');
    assert.equal(normalizeExportOptions({ engine: 'godot' }, doc).engine, 'own');
});

test('PRESETS：四档齐全、每档字段都是合法值', () => {
    assert.deepEqual(PRESET_IDS, ['engine', 'web', 'chat', 'print']);
    const doc = baseDoc();
    for (const id of PRESET_IDS) {
        const p = presetOf(id);
        assert.ok(p, `预设 ${id} 不存在`);
        // 每一档叠到缺省选项上都必须能通过归一化（不产坏值）
        const merged = normalizeExportOptions(Object.assign({}, applyPreset({}, id)), doc);
        assert.equal(merged.format, p.format, `${id} 的 format 被归一化改掉了`);
        assert.equal(merged.scale, p.scale, `${id} 的 scale 被归一化改掉了`);
        assert.ok(ENGINES.includes(p.engine), `${id} 的 engine 不合法`);
    }
});

test('PRESETS：web 用 webp 且图集更小，print 是 2 倍且不裁', () => {
    assert.equal(PRESETS.web.format, 'webp');
    assert.ok(PRESETS.web.maxTextureSize < PRESETS.engine.maxTextureSize);
    assert.equal(PRESETS.print.scale, 2);
    assert.equal(PRESETS.print.trim, false);
});

test('applyPreset：返回新对象，不改入参（预设是初值不是模式）', () => {
    const before = { format: 'jpeg', scale: 3, engine: 'own' };
    const after = applyPreset(before, 'web');
    assert.deepEqual(before, { format: 'jpeg', scale: 3, engine: 'own' }, '入参被改了');
    assert.equal(after.format, 'webp');
    assert.equal(after.scale, 1);
    assert.notEqual(after, before);
});

test('applyPreset：未知 id 返回 null 且不改入参（界面据此不显示高亮）', () => {
    const before = { format: 'png' };
    assert.equal(applyPreset(before, 'nope'), null);
    assert.equal(presetOf('nope'), null);
    assert.equal(presetOf('constructor'), null, '原型链上的名字不算预设');
    assert.deepEqual(before, { format: 'png' });
});

test('PRESETS 是冻结的（改它等于改所有人共享的常量）', () => {
    assert.throws(() => { PRESETS.web.scale = 9; }, TypeError);
    assert.equal(PRESETS.web.scale, 1);
});
