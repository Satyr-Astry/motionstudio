// 画板 / 工具表「图标化」的静态约束：引用名必须在 icons.mjs 里、按钮不再用单字符字形、
// 带字动作保留中文标签、纯图标按钮都有 aria-label。
// 这些约束在 Node 里能直接查源码，不需要 DOM —— 渲染正确性由真机截图/尺寸脚本兜。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ICON_NAMES } from '../app/core/icons.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const board = read('../app/editors/board.mjs');
const toolbar = read('../app/editors/toolbar.mjs');
const known = new Set(ICON_NAMES);

// 曾经被当成「图标」用的单字符字形。任何一个出现在按钮内容里都算回退。
const BANNED_GLYPHS = /(?:'bd-ico',\s*'|textContent\s*=\s*')([↶↷⋯⬚✎◻▣⌖✥‹›])'/g;

test('画板与工具表引用的图标名都在 icons.mjs 里', () => {
    const used = new Set();
    // toolbar.mjs: TOOL_DEFS 的 icon 字段
    for (const m of toolbar.matchAll(/icon:\s*'([a-z][a-z0-9-]*)'/g)) used.add(m[1]);
    // board.mjs: 直接调用 icon('name')
    for (const m of board.matchAll(/icon\('([a-z][a-z0-9-]*)'/g)) used.add(m[1]);
    // board.mjs: .bd-act 表里的图标列（iconName 变量，静态扫不到调用点）
    for (const m of board.matchAll(/\['(?:prev|next|new|unique|fit)',\s*'([a-z][a-z0-9-]*)'/g)) used.add(m[1]);

    assert.ok(used.size >= 10, `应至少抽到 10 个图标引用，实际 ${used.size}: ${[...used].join(',')}`);
    for (const name of used) {
        assert.ok(known.has(name), `引用了 icons.mjs 里不存在的图标: ${name}`);
    }
});

test('六件工具与五个纹理动作都不再用单字符字形当图标', () => {
    const bad = [...board.matchAll(BANNED_GLYPHS)];
    assert.equal(bad.length, 0, `board.mjs 还有符号字形当按钮内容: ${bad.map((m) => m[1]).join(',')}`);
    const badT = [...toolbar.matchAll(BANNED_GLYPHS)];
    assert.equal(badT.length, 0, `toolbar.mjs 还有符号字形当按钮内容: ${badT.map((m) => m[1]).join(',')}`);
});

test('六件工具的图标名互不相同且都是图标（不是文字）', () => {
    const defs = [...toolbar.matchAll(/\{ id: '(\w+)', icon: '([a-z][a-z0-9-]*)', name: '([^']+)', key: '(\w+)' \}/g)];
    assert.equal(defs.length, 6, '工具表应恰好 6 件');
    const icons = defs.map((d) => d[2]);
    assert.equal(new Set(icons).size, 6, `六个工具图标名重复了: ${icons.join(',')}`);
    const ids = defs.map((d) => d[1]);
    for (const want of ['select', 'brush', 'eraser', 'bucket', 'picker', 'pan']) {
        assert.ok(ids.includes(want), `工具表缺 ${want}`);
    }
});

test('带字动作保留中文标签，图标在前', () => {
    // 图标 + 中文（＋ 号由 plus 图标承担，文字只剩「纹理」）
    assert.match(board, /\['new', 'plus', '纹理'/);
    assert.match(board, /\['unique', 'sparkle', '独特化'/);
    assert.match(board, /\['fit', 'fit', '适配'/);
    // 图标在前、文字在后的拼装方式
    assert.match(board, /icon\(iconName\) \+ \(text \? `<span>/);
});

test('图标尺寸统一走 board.css 的 --icon-sm，不在 JS 里逐个传 size', () => {
    // 尺寸只能有一个来源 —— 改 CSS 一处生效，别让 icon() 的内联 data-size 把某几个按钮顶大。
    // （原先这里写「1280 宽下 .bd-bar 余量正好是 0，14→16px 就溢出」，那句是误读：
    //  `.bd-bar` 是 overflow-x:auto 的 flex，装得下时 scrollWidth 恒等于 clientWidth，
    //  「1440/1440」看不出余量。把子项宽度加总后实测 1680 下内容 901 / 容器 1440（余 539）、
    //  1280 下内容 901 / 容器 1040（余 139）—— 1280 并不缺地方，图标 14→16px 完全放得下。）
    const css = read('../app/styles/board.css');
    assert.match(css, /\.bd \.bd-ico > \.ms-icon,/);
    assert.match(css, /--icon-size: var\(--icon-sm\)/);
    const inline = [...board.matchAll(/icon\('[a-z][a-z0-9-]*',\s*\{ size: '[a-z]+' \}\)/g)];
    assert.equal(inline.length, 0, `board.mjs 还有 ${inline.length} 处给 icon() 传 size`);
});

test('纯图标按钮都带 aria-label（title 之外的第二道可访问性）', () => {
    for (const btn of ['pickBtn', 'undoBtn', 'redoBtn', 'settingsBtn', 'stabBtn']) {
        assert.match(
            board,
            new RegExp(`${btn}\\.setAttribute\\('aria-label'`),
            `${btn} 缺 aria-label`,
        );
    }
    // .bd-act 用 title 当 aria（‹ › 是纯图标，没有可读文字）
    assert.match(board, /btn\.setAttribute\('aria-label', title\)/);
});

test('工具表按钮的 title / aria-label 同时带名称与快捷键', () => {
    assert.match(toolbar, /b\.title = `\$\{t\.name\} \(\$\{t\.key\}\)`/);
    assert.match(toolbar, /b\.setAttribute\('aria-label', `\$\{t\.name\} \(\$\{t\.key\}\)`\)/);
});
