/**
 * 导出对话框的「记忆参数」（`readExportPrefs` / `writeExportPrefs`）
 *
 * 为什么单独测：这两个函数是导出设置的**唯一持久化路径**，而且很容易出这种错——
 * 界面上加了新控件、忘了往白名单里加字段，于是用户每次重开对话框都要重选一遍，
 * 而「重选一遍」不会有任何报错，谁也不会把它当 bug 报上来。
 *
 * 本文件里还钉住一条更隐蔽的：`trim` 与 `maxTextureSize` **界面上没有控件**
 * （只有预设会写它们），但它们必须被一起存下来，否则点了「排版」预设、
 * 重开对话框又变回裁边 + 4096。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { readExportPrefs, writeExportPrefs } from '../app/editors/export-dialog.mjs';
import { EXPORT_DEFAULTS, PRESET_IDS, applyPreset, normalizeExportOptions } from '../app/core/export-options.mjs';

/** 最小 localStorage 桩：只要 getItem / setItem。 */
function makeStore(initial) {
    const box = new Map(Object.entries(initial || {}));
    return {
        getItem: (k) => (box.has(k) ? box.get(k) : null),
        setItem: (k, v) => { box.set(k, String(v)); },
        raw: (k) => box.get(k),
    };
}

test('没存过时返回完整缺省（含新增的 format / engine / trim / maxTextureSize）', () => {
    const out = readExportPrefs(makeStore());
    assert.equal(out.format, EXPORT_DEFAULTS.format);
    assert.equal(out.engine, EXPORT_DEFAULTS.engine);
    assert.equal(out.quality, EXPORT_DEFAULTS.quality);
    assert.equal(out.trim, EXPORT_DEFAULTS.trim);
    assert.equal(out.maxTextureSize, EXPORT_DEFAULTS.maxTextureSize);
});

test('format 与 engine（含 aseprite）能存能读回', () => {
    const st = makeStore();
    writeExportPrefs({ format: 'webp', engine: 'aseprite', quality: 0.7 }, st);
    const back = readExportPrefs(st);
    assert.equal(back.format, 'webp');
    assert.equal(back.engine, 'aseprite');
    assert.equal(back.quality, 0.7);
});

test('坏 format / 坏 engine 回落默认，不把脏值带进导出', () => {
    const st = makeStore({
        'ms.export': JSON.stringify({ format: 'tiff', engine: 'godot' }),
    });
    const back = readExportPrefs(st);
    assert.equal(back.format, EXPORT_DEFAULTS.format);
    assert.equal(back.engine, EXPORT_DEFAULTS.engine);
});

test('trim 与 maxTextureSize 存得住（界面没控件，只有预设写它们）', () => {
    const st = makeStore();
    writeExportPrefs({ trim: false, maxTextureSize: 8192 }, st);
    const back = readExportPrefs(st);
    assert.equal(back.trim, false);
    assert.equal(back.maxTextureSize, 8192);
});

test('点「排版」预设 → 存 → 读回，四项都还在（这是最容易漏的那条链）', () => {
    const st = makeStore();
    const merged = applyPreset({}, 'print');
    writeExportPrefs(merged, st);
    const back = readExportPrefs(st);
    assert.equal(back.scale, 2);
    assert.equal(back.trim, false);
    assert.equal(back.maxTextureSize, 8192);
    assert.equal(back.engine, 'own');
});

test('点「网页」预设 → 存 → 读回，拿到的确实是 webp 与小图集', () => {
    const st = makeStore();
    writeExportPrefs(applyPreset({}, 'web'), st);
    const back = readExportPrefs(st);
    assert.equal(back.format, 'webp');
    assert.equal(back.maxTextureSize, 2048);
});

test('坏 JSON / 非对象 / 数组一律回落缺省，不抛', () => {
    for (const bad of ['{not json', '[]', 'null', '"str"', '42']) {
        const st = makeStore({ 'ms.export': bad });
        const out = readExportPrefs(st);
        assert.equal(out.format, EXPORT_DEFAULTS.format, `坏值 ${bad} 没回落`);
    }
});

test('没有 storage 时不抛，返回缺省', () => {
    const out = readExportPrefs({});
    assert.equal(out.format, EXPORT_DEFAULTS.format);
    assert.equal(writeExportPrefs({ format: 'png' }, {}), false);
});

test('写入只存白名单字段，不把整份 opts 倒进去', () => {
    const st = makeStore();
    writeExportPrefs({ format: 'png', secretToken: 'x', dir: '/tmp' }, st);
    const slim = JSON.parse(st.raw('ms.export'));
    assert.equal(Object.prototype.hasOwnProperty.call(slim, 'secretToken'), false);
    // dir 不在白名单里：它是每次导出时由调用方决定的目标目录
    assert.equal(Object.prototype.hasOwnProperty.call(slim, 'dir'), false);
    assert.equal(slim.format, 'png');
});

/* ── 对话框源码守卫：控件与按钮真的接上了吗 ──────────────────────────── */

const DIALOG = readFileSync(new URL('../app/editors/export-dialog.mjs', import.meta.url), 'utf8');

test('对话框里有格式 / 画质 / 引擎三个控件，且都进了 collect()', () => {
    // 这三个控件在 alpha.26 之前根本不存在：engine 永远停在 own，
    // 于是 README 里「给 Godot / Phaser 用的帧表」是空头承诺。
    assert.ok(DIALOG.includes("'exp-format'"), '缺 select.exp-format');
    assert.ok(DIALOG.includes("'exp-quality'"), '缺 input.exp-quality');
    assert.ok(DIALOG.includes("'exp-engine'"), '缺 select.exp-engine');
    const at = DIALOG.indexOf('const collect =');
    assert.ok(at > 0, '找不到 collect()');
    const collect = DIALOG.slice(at, at + 1400);
    for (const key of ['format', 'quality', 'engine', 'trim', 'maxTextureSize']) {
        assert.ok(collect.includes(key), 'collect() 没带上 ' + key);
    }
});

test('四档预设按钮存在，且预设不改入参', () => {
    for (const id of PRESET_IDS) {
        assert.ok(DIALOG.includes('applyPreset'), '对话框没有引用 applyPreset');
        break;
    }
    assert.ok(DIALOG.includes('fillPreset'), '缺 fillPreset（预设按钮的落值函数）');
    const base = normalizeExportOptions(EXPORT_DEFAULTS);
    const before = JSON.stringify(base);
    applyPreset(base, 'print');
    assert.equal(JSON.stringify(base), before, '预设不许改入参');
});

test('导出 GIF / APNG 按钮都存在，且两个启用/禁用数组都带上它们', () => {
    assert.ok(DIALOG.includes('btnGif'), '缺 btnGif');
    assert.ok(DIALOG.includes("run('gif')"), 'GIF 按钮没有跑到 gif 分支');
    assert.ok(DIALOG.includes('btnApng'), '缺 btnApng');
    assert.ok(DIALOG.includes("run('apng')"), 'APNG 按钮没有跑到 apng 分支');
    // 启用与禁用分别在 onRun 开头与结尾，两处都要带上，否则按一次之后按钮永久禁用
    const sites = DIALOG.split('[btnGo, btnSheet, btnGif, btnApng, btnVideo]').length - 1;
    assert.equal(sites, 2, '启用/禁用两处都要带上全部动作按钮，实际 ' + sites);
});
