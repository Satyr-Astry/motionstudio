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
const topbar = read('../app/shell/chrome.mjs');
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
    for (const m of board.matchAll(/\['(?:prev|next|new-tex|unique|fit)',\s*'([a-z][a-z0-9-]*)'/g)) used.add(m[1]);

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
    assert.match(board, /\['new-tex', 'plus', '纹理'/);
    assert.match(board, /\['unique', 'sparkle', '独特化'/);
    assert.match(board, /\['fit', 'fit', '适配'/);
    // 图标在前、文字在后的拼装方式
    assert.match(board, /icon\(iconName\) \+ \(text \? `<span>/);
});

test('动作名跨面板唯一：顶栏「新建项目」与画板「＋纹理」不许同名', () => {
    // 事故：两者都叫 data-act="new"，跨面板的 [data-act="new"] 查询会命中顶栏那个，
    // 于是「点纹理」的自动化脚本实际新建了一个空项目、画板毫无反应。
    // 单个面板内不必让路，跨面板必须唯一，所以这里把两张表的动作名抽出来求交集。
    const boardActs = new Set(
        [...board.matchAll(/\['([a-z][a-z0-9-]*)', '[a-z][a-z0-9-]*', '[^']*'/g)].map((m) => m[1]),
    );
    const topActs = new Set(
        [...topbar.matchAll(/\['([a-z][a-z0-9-]*)', '[a-z][a-z0-9-]*', (?:null|'[^']*'), '[^']*'\]/g)].map((m) => m[1]),
    );
    assert.ok(boardActs.size >= 5, `画板动作表解析失败，只抽到 ${boardActs.size} 个`);
    assert.ok(topActs.size >= 5, `顶栏动作表解析失败，只抽到 ${topActs.size} 个`);
    const both = [...boardActs].filter((a) => topActs.has(a));
    assert.deepEqual(both, [], `动作名跨面板重复（跨面板选择器会取错按钮）: ${both.join(', ')}`);
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

test('参数段是网格、标签固定 44px 宽 —— 六项左边缘才能落在同一竖线', () => {
    const css = read('../app/styles/board.css');
    const params = css.match(/\.bd \.bd-params\s*\{([^}]*)\}/);
    assert.ok(params, '找不到 .bd-params 规则');
    assert.match(params[1], /display:\s*grid/, '参数段必须是 grid；flex run-on 会让标签与滑杆轮流占行');
    assert.match(params[1], /minmax\(360px,\s*1fr\)/, '列数交给 minmax(360px, 1fr) 自己算，不写死断点');

    const lab = css.match(/\.bd \.bd-prow > \.bd-lab\s*\{([^}]*)\}/);
    assert.ok(lab, '找不到 .bd-lab 规则');
    const body = lab[1];
    // 固定宽是本轮验收的机器判据：`flex:0 0 auto` 会让宽度随字长变，六项左边缘就跑偏
    assert.match(body, /flex:\s*0 0 44px/, '.bd-lab 必须 flex:0 0 44px，不能是 flex:0 0 auto');
    assert.match(body, /width:\s*44px/, '.bd-lab 要显式 width: 44px');
    assert.match(body, /text-align:\s*right/, '.bd-lab 要右对齐');
    assert.ok(!/display:\s*none/.test(body), '.bd-lab 里出现了 display:none');

    const range = css.match(/\.bd \.bd-prow input\[type="range"\]\s*\{([^}]*)\}/);
    assert.match(range[1], /min-width:\s*60px/, '滑杆最小 60px，否则数值框会把杆压没');
    const num = css.match(/\.bd \.bd-prow input\[type="number"\]\s*\{([^}]*)\}/);
    assert.match(num[1], /flex:\s*0 0 44px/, '数值框固定 44px，六项的数值右边缘才会齐');

    // 恢复默认并进最后一格的行尾；跨整行会让参数段多顶一行，1000×620 的画布直接破 360 红线
    const reset = css.match(/\.bd \.bd-params-reset\s*\{([^}]*)\}/);
    assert.ok(reset, '找不到 .bd-params-reset 规则');
    assert.ok(!/grid-column/.test(reset[1]), '.bd-params-reset 不许跨整行（会多出一行参数高度）');
    assert.match(reset[1], /width:\s*22px/, '恢复默认按钮固定 22px，和行里的图标按钮同档');
});

test('纯图标按钮都带 aria-label（title 之外的第二道可访问性）', () => {
    for (const btn of ['pickBtn', 'bucketBtn', 'undoBtn', 'redoBtn', 'stabBtn', 'resetBtn']) {
        assert.match(
            board,
            new RegExp(`${btn}\\.setAttribute\\('aria-label'`),
            `${btn} 缺 aria-label`,
        );
    }
    // .bd-act 用 title 当 aria（‹ › 是纯图标，没有可读文字）
    assert.match(board, /btn\.setAttribute\('aria-label', title\)/);
    // 笔刷 chip 是「图标 + 两字短名」，窄屏收成纯图标时全靠这条 aria
    assert.match(board, /btn\.setAttribute\('aria-label', b\.name \+ '（快捷键 '/);
});

test('笔刷 chip 用两字短名 + 图标，不再用单字', () => {
    // 单字（像/圆/软/铅/晕/散/擦）不构成词，7 支笔等于没有名字 —— 见计划 §0。
    const block = board.match(/const BRUSH_SHORT = \{([\s\S]*?)\};/);
    assert.ok(block, 'board.mjs 里找不到 BRUSH_SHORT');
    const names = [...block[1].matchAll(/:\s*'([^']+)'/g)].map((m) => m[1]);
    assert.equal(names.length, 7, `BRUSH_SHORT 应有 7 支笔，实际 ${names.length}`);
    for (const n of names) {
        assert.equal([...n].length, 2, `笔刷短名「${n}」不是两字（三字会撑破一行，单字读不懂）`);
    }
    // 每支笔都必须配一枚图标名，并且都在 icons.mjs 里（缺了 icon() 会静默回退默认图标）
    const icons = board.match(/const BRUSH_ICON = \{([\s\S]*?)\};/);
    assert.ok(icons, 'board.mjs 里找不到 BRUSH_ICON');
    const iconNames = [...icons[1].matchAll(/:\s*'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]);
    assert.equal(iconNames.length, 7, `BRUSH_ICON 应有 7 条，实际 ${iconNames.length}`);
    for (const name of iconNames) {
        assert.ok(known.has(name), `笔刷图标 ${name} 不在 icons.mjs 里`);
    }
});

test('参数常显：六条滑杆都在主界面，不藏在浮层里', () => {
    // 大小 / 不透明 走 .bd-prow，硬度/间距/抖动/流量走 PARAM_UI —— 共 6 条
    assert.match(board, /params\.append\(sizeField, opacityField\)/);
    assert.match(board, /for \(const ui of PARAM_UI\)/);
    assert.match(board, /params\.appendChild\(row\)/);
    // 笔刷设置浮层已下线
    assert.ok(!/const pop = mk\('div', 'bd-pop'\)/.test(board), 'board.mjs 里还留着 .bd-pop 浮层');
    assert.ok(!/function (openPop|closePop)\(/.test(board), 'board.mjs 里还留着 openPop/closePop');
});

test('窄窗口不靠 display:none 藏字（这是「文字不显示完全」的真凶）', () => {
    const css = read('../app/styles/board.css');
    // 只查作用于 .bd-act>span / .bd-lab 的 display:none —— 别处（浮层 [hidden]）允许有
    assert.ok(
        !/\.bd \.bd-act > span\s*\{[^}]*display:\s*none/.test(css),
        'board.css 又把 .bd-act > span 藏起来了',
    );
    assert.ok(
        !/\.bd \.bd-(field|prow) > \.bd-lab\s*\{[^}]*display:\s*none/.test(css),
        'board.css 又把 .bd-lab 藏起来了',
    );
    // 换行是允许的降级手段：.bd-bar 必须能折行，宽度不够时不许横向滚动
    assert.match(css, /\.bd \.bd-bar \{[^}]*flex-wrap: wrap/);
    assert.match(css, /\.bd \.bd-bar \{[^}]*height: auto/);
});

test('工具表按钮的 title / aria-label 同时带名称与快捷键', () => {
    assert.match(toolbar, /b\.title = `\$\{t\.name\} \(\$\{t\.key\}\)`/);
    assert.match(toolbar, /b\.setAttribute\('aria-label', `\$\{t\.name\} \(\$\{t\.key\}\)`\)/);
});

// ── task-30：纹理尺寸控件（裁到内容 / 宽×高 / 应用 / 对齐） ──────────────────

test('纹理尺寸控件引用的两枚图标都在 icons.mjs 里，且只追加不改既有键', () => {
    for (const name of ['crop-content', 'canvas-resize']) {
        assert.ok(known.has(name), `画板尺寸控件引用了不存在的图标: ${name}`);
        assert.match(board, new RegExp(`icon\\('${name}'\\)`), `board.mjs 没有用 icon('${name}')`);
    }
    // 这两枚只允许以「追加」的形式存在：不许给旧键起别名（如 fit2 / resize）
    for (const alias of ['fit2', 'crop', 'resize', 'trim']) {
        assert.ok(!known.has(alias), `不要用别名 ${alias} 代替已追加的图标键`);
    }
});

test('尺寸控件两个按钮都有 title + aria-label，且命令未接线时禁用并写明原因', () => {
    // 纯图标按钮必须同时写 title 与 aria-label（与既有 .bd-ico 同规矩）
    assert.match(board, /cropBtn\.title = cropTitle/, '裁到内容按钮的 title 没走统一变量');
    assert.match(board, /cropBtn\.setAttribute\('aria-label', cropTitle\)/);
    assert.match(board, /applySizeBtn\.title = applyTitle/, '应用按钮的 title 没走统一变量');
    assert.match(board, /applySizeBtn\.setAttribute\('aria-label', applyTitle\)/);
    // 「点了没反应」是本轮投诉的同类问题：命令缺失时必须禁用 + title 说明
    assert.match(board, /cropBtn\.disabled = !!why/);
    assert.match(board, /applySizeBtn\.disabled = !!why/);
    assert.match(board, /尺寸命令尚未接线/, '命令缺失时没有写明原因');
    assert.match(board, /typeof c\.resizeTexture === 'function'/, '守卫没有检测命令是否接线');
});

test('尺寸输入不许在 input 事件里直接改文档：只有应用按钮 / 回车才执行', () => {
    // 只允许 keydown Enter 与 data-act=resize 两条路径触发 runSize
    assert.match(board, /function applySizeFromInputs\(\)/);
    assert.match(board, /if \(e\.key !== 'Enter'\) return;/);
    assert.match(board, /case 'resize':\s*\n\s*applySizeFromInputs\(\);/, "click 分派里没有 case 'resize'");
    assert.match(board, /case 'crop':\s*\n\s*runSize\(\{ mode: 'trim' \}\);/, "click 分派里没有 case 'crop'");
    // 不许出现对 sizeW/sizeH 的 input 事件监听（那会在打字过程中就改文档）
    assert.ok(!/size[WH]\.addEventListener\('input'/.test(board), '尺寸框上挂了 input 监听——会在打字中途改文档');
    // 不许用隐藏修饰键切语义（Alt/Shift 那套已在 keepPlace 上被否掉）：
    // 对齐必须是显式三档，而不是「按住某键 = 另一种对齐」
    assert.match(board, /\['nw', '左上'\], \['c', '居中'\], \['se', '右下'\]/, '对齐三档没有显式列出');
    assert.ok(!/alignSel\.dataset|alignKeyDown/.test(board), '对齐不该藏在键盘修饰里');
});

