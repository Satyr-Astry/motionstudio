// 命令片（P1-B）自检：命令名 / hint / 分组 + 命令面板外壳文案。
//
// 三条底线，破一条就红：
//   1. **命令 id 是契约**。《快捷键表》《命令面板》《tests/command-palette.test.mjs》都按
//      `play.prev-cel` 这种 id 引用，集合变了就是破坏兼容 —— 本片只换文案的取值来源。
//   2. 两表镜面：en 与 zh-Hans 键集合、键顺序完全一致；en 里一个汉字都不许有；
//      zh 里每条都得是真中文；中文原文与词条化之前**逐字一致**（顺手改词也算破坏界面文案）。
//   3. 文案必须「现取」（getter）。`boot()` 先 `createPalette({ commands: buildCommands() })`
//      再 `applyLocale(...)`，建表时 `t()` 求值会把默认语言的命令名冻住，切到中文后
//      面板里还是一排英文。所以源码守卫盯死：title / hint / group 不许直接写死中文。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import commandsPart from '../app/i18n/parts/commands.mjs';
import { DEFAULT_LOCALE, keysOf, setLocale, t } from '../app/i18n/index.mjs';
import { TOOLS } from '../app/paint/engine.mjs';

const HAN = /[\u4e00-\u9fff]/;
const enTable = commandsPart.en;
const zhTable = commandsPart['zh-Hans'];

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const SRC_APP = read('../app/shell/app.mjs');
const SRC_PALETTE = read('../app/shell/command-palette.mjs');

/** 只切 `buildCommands()` 这一段：本片在 app.mjs 里只有这一处写域。 */
function sliceBuildCommands(src) {
    const start = src.indexOf('function buildCommands()');
    assert.ok(start > 0, 'app.mjs 里找不到 buildCommands()');
    const end = src.indexOf('\nfunction onKeyDown', start);
    assert.ok(end > start, 'buildCommands() 的结束边界（onKeyDown）找不到了');
    return src.slice(start, end);
}

const CMD_SRC = sliceBuildCommands(SRC_APP);

/** 命令 id → 词条键：连字符折驼峰（词典键只认字母数字与点）。 */
const keyOf = (id) => 'cmd.' + id.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

/** 源码里 `id: '…'` 的静态命令（`id: 'tool.' + tool.id` 那条动态的先滤掉）。 */
function staticIds() {
    return [...CMD_SRC.matchAll(/\bid: '([^']+)'/g)]
        .map((m) => m[1])
        .filter((id) => id !== 'tool.');
}

const TOOL_IDS = TOOLS.map((tool) => 'tool.' + tool.id);
const IDS = [...staticIds(), ...TOOL_IDS].sort();

/** 词条化之前的命令 id 清单（37 条 + 骨骼任务追加 1 条 + 蒙皮绑定 2 条）。**这是契约快照，只许追加不许改名。** */
const ID_CONTRACT = [
    'canvas.brush-bigger',
    'canvas.brush-smaller',
    'canvas.fit',
    'cel.add',
    'cel.cycle-next',
    'cel.cycle-prev',
    'cel.new',
    'cel.remove',
    'cel.unique',
    'edit.copy-keys',
    'edit.paste-keys',
    'edit.redo',
    'edit.undo',
    'file.export-clip',
    'file.export-current',
    'file.export-frames',
    'file.export-sheet',
    'file.export-video',
    'file.open',
    'file.save',
    'object.add-bone',
    'object.bind-skin',
    'object.unbind-skin',
    'play.first',
    'play.last',
    'play.next-cel',
    'play.next-key',
    'play.prev-cel',
    'play.prev-key',
    'play.toggle',
    'tool.brush',
    'tool.bucket',
    'tool.eraser',
    'tool.pan',
    'tool.picker',
    'tool.select',
    'ui.shortcuts',
    'ws.animate',
    'ws.draw',
    'ws.free',
];

/** 源码里以字面量出现的键（`t('cmd.tool.' + …)` 这种动态键单独算）。 */
const LITERAL_CMD_KEYS = [...new Set(
    [...CMD_SRC.matchAll(/t\('(cmd\.[A-Za-z0-9.]+)'/g)]
        .map((m) => m[1])
        .filter((key) => !key.endsWith('.')),
)].sort();

const dictKeysUnder = (table, prefix) => Object.keys(table).filter((k) => k.startsWith(prefix)).sort();

test('两表镜面：键集合、键顺序完全一致，且都并进了词典', () => {
    assert.deepEqual(Object.keys(enTable), Object.keys(zhTable), 'en 与 zh-Hans 的键集合/顺序必须一一对应');
    assert.ok(Object.keys(enTable).length >= 70, '命令片至少 70 条，实际 ' + Object.keys(enTable).length);

    const mergedEn = keysOf('en');
    const mergedZh = keysOf('zh-Hans');
    for (const key of Object.keys(enTable)) {
        assert.ok(mergedEn.includes(key), key + ' 没并进 en 词典（parts/index.mjs 注册了吗？）');
        assert.ok(mergedZh.includes(key), key + ' 没并进 zh-Hans 词典');
    }
});

test('键都落在本片的两个命名空间里，且符合键语法', () => {
    for (const key of Object.keys(enTable)) {
        assert.ok(key.startsWith('cmd.') || key.startsWith('palette.'), key + ' 不在本片约定的前缀里');
        assert.match(key, /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/, key + ' 不符合「区域.实体.字段」的键语法');
    }
});

test('en 表：没有汉字、没有空值', () => {
    for (const [key, value] of Object.entries(enTable)) {
        assert.equal(typeof value, 'string', key + ' 必须是字符串');
        assert.ok(value.trim().length > 0, key + ' 是空串');
        assert.ok(!HAN.test(value), key + ' 的英文值是「' + value + '」，en 表里不许有中文');
    }
});

test('zh-Hans 表：每条都是真中文，没有把键名当值', () => {
    for (const [key, value] of Object.entries(zhTable)) {
        assert.equal(typeof value, 'string', key + ' 必须是字符串');
        assert.ok(HAN.test(value), key + ' 的中文值是「' + value + '」，一个汉字都没有');
        assert.notEqual(value, key, key + ' 的值就是键名（等于没翻）');
    }
});

test('命令 id 集合没变：37 条契约 id，一条不许改名或消失', () => {
    assert.deepEqual(IDS, [...ID_CONTRACT].sort(), '命令 id 集合被改动了 —— id 是快捷键表/面板/测试的契约');
});

test('源码不留中文原文：命令名的 t() 只传键，译文只活在词典里', () => {
    // 原文若留在源码里当第二参，`_check-i18n` 的「还剩多少条」就永远降不到 0，
    // 进度指标会失效。缺词风险由「两表非空 + 缺口 0 + 双向对齐」兜住。
    const withText = [...CMD_SRC.matchAll(/t\('(cmd\.[A-Za-z0-9.]+)',\s*'([^']*)'\)/g)];
    assert.deepEqual(withText.map((m) => m[1]), [], '还有 t(key, \'原文\') 形态：' + withText.map((m) => m[1]).join(', '));
    // 反向：每个调用点的键都必须在两表里有非空值，否则界面会显示键名
    const called = [...CMD_SRC.matchAll(/t\('(cmd\.[A-Za-z0-9.]+)'\)/g)].map((m) => m[1]);
    assert.ok(called.length >= 30, '命令表里 t() 调用太少：' + called.length);
    for (const key of new Set(called)) {
        assert.ok(Object.hasOwn(enTable, key) && enTable[key].trim(), key + ' 在 en 表里没有词条');
        assert.ok(Object.hasOwn(zhTable, key) && zhTable[key].trim(), key + ' 在 zh-Hans 表里没有词条');
    }
});

test('词典与命令表双向对齐：不多一条、不少一条', () => {
    const expected = new Set(LITERAL_CMD_KEYS);
    for (const id of TOOL_IDS) expected.add(keyOf(id)); // `t('cmd.tool.' + tool.id)`
    const actual = dictKeysUnder(enTable, 'cmd.');
    assert.deepEqual([...expected].sort(), actual, 'cmd.* 的键与 buildCommands() 里用到的键必须一一对应');
});

test('每条命令都有名字，hint 只在源码里写了 hint 的才有', () => {
    for (const id of IDS) {
        const key = keyOf(id);
        assert.ok(Object.hasOwn(enTable, key), id + ' 缺命令名（' + key + '）');
    }
    // 空 hint（`hint: ''`）与非中文技术值（t = 0 / animate / draw / free）不进词典。
    const hintKeys = dictKeysUnder(enTable, 'cmd.').filter((k) => k.endsWith('.hint'));
    const sourceHints = LITERAL_CMD_KEYS.filter((k) => k.endsWith('.hint'));
    assert.deepEqual(sourceHints, hintKeys, 'hint 词条与源码里的 hint 必须一一对应');
});

test('分组：8 个分组 id 与词典、与源码三方一致', () => {
    const sourceGroups = [...new Set([...CMD_SRC.matchAll(/t\('cmd\.group\.([a-z]+)'/g)].map((m) => m[1]))].sort();
    assert.deepEqual(sourceGroups, ['canvas', 'cel', 'edit', 'file', 'play', 'tool', 'ui', 'workspace']);
    const dictGroups = dictKeysUnder(enTable, 'cmd.group.').map((k) => k.slice('cmd.group.'.length)).sort();
    assert.deepEqual(dictGroups, sourceGroups, '分组词条与源码用到的分组必须一一对应');
});

test('命令面板外壳：palette.* 双向对齐，{n} 占位符两表都有', () => {
    const used = [...new Set([...SRC_PALETTE.matchAll(/t\('(palette\.[A-Za-z0-9.]+)'/g)].map((m) => m[1]))].sort();
    assert.deepEqual(used, dictKeysUnder(enTable, 'palette.'), 'palette.* 的键与 command-palette.mjs 里用到的必须一一对应');
    assert.ok(used.includes('palette.foot'), '命令面板的页脚提示没接词条表');
    for (const table of [enTable, zhTable]) {
        assert.ok(table['palette.more'].includes('{n}'), 'palette.more 必须带 {n} 占位符');
    }
});

test('文案是现取的：title / hint / group 用 getter，源码里不许再直接写死中文', () => {
    assert.match(SRC_APP, /import \{[^}]*\bt\b[^}]*\} from '\.\.\/i18n\/index\.mjs'/, 'app.mjs 没引 t()');
    assert.ok(/get title\(\) \{ return t\('cmd\./.test(CMD_SRC), '命令名不是 getter（切语言后不会跟着换）');
    assert.ok(/get hint\(\) \{ return t\('cmd\./.test(CMD_SRC), 'hint 不是 getter');
    assert.ok(/get group\(\) \{ return t\('cmd\.group\./.test(CMD_SRC), 'group 不是 getter');
    assert.match(CMD_SRC, /get title\(\) \{ return t\('cmd\.tool\.' \+ tool\.id, tool\.name\); \}/, '工具命令名没走词条表');

    // 直接写死在字段上的中文字面量一律不许（空 hint 与非中文技术值不受影响）。
    for (const line of CMD_SRC.match(/^\s+(title|hint|group): '[^']*'/gm) || []) {
        assert.ok(!HAN.test(line), '命令表里还留着直接写死中文的字段：' + line.trim());
    }

    // 段内所有中文字面量都必须是 t(key, '原文') 的第二参；run() 里的 flash 文案是命令行为，
    // 不属本 task（已单独报给 lead），这里按白名单放行，多一个字都会红。
    const RUNTIME_TEXT = new Set(['工具：', '已适配视图']);
    for (const m of CMD_SRC.matchAll(/'([^'\n]*)'/g)) {
        const value = m[1];
        if (!HAN.test(value) || RUNTIME_TEXT.has(value)) continue;
        const before = CMD_SRC.slice(Math.max(0, m.index - 200), m.index);
        assert.match(before, /t\('cmd\.[A-Za-z0-9.]+', $/, '中文文案没走词条表：' + value);
    }
});

test('命令面板：外壳文案改走 t()，建面板时那一份不再是写死的中文常量', () => {
    assert.match(SRC_PALETTE, /import \{ t \} from '\.\.\/i18n\/index\.mjs'/);
    assert.ok(!/const FOOT_HINT/.test(SRC_PALETTE), 'FOOT_HINT 还在');
    assert.ok(!/const EMPTY_TEXT/.test(SRC_PALETTE), 'EMPTY_TEXT 还在');
    assert.ok(!/const UNGROUPED_LABEL/.test(SRC_PALETTE), 'UNGROUPED_LABEL 还在');
    // 面板在 applyLocale() 之前建，所以创建后 + 每次渲染前都要重新同步一次外壳文案。
    assert.ok((SRC_PALETTE.match(/syncChromeText\(\);/g) || []).length >= 2, 'syncChromeText() 没有在创建与渲染时调用');
    assert.match(SRC_PALETTE, /function render\(o = \{\}\) \{\n\s+if \(destroyed\) return;\n\s+syncChromeText\(\);/, 'render() 没有同步外壳文案');
});

test('t() 现取：切语言后命令名跟着换，键与原文都不动', () => {
    setLocale('zh-Hans');
    try {
        assert.equal(t('cmd.play.prevCel', '上一个纹理'), '上一个纹理');
        assert.equal(t('cmd.group.file', '文件'), '文件');
        assert.equal(t('palette.empty', '没有匹配的命令'), '没有匹配的命令');
    } finally {
        setLocale(DEFAULT_LOCALE);
    }
    assert.equal(t('cmd.play.prevCel', '上一个纹理'), 'Previous texture', '切回英文后命令名没跟着换');
    assert.equal(t('cmd.file.exportSheet', '导出精灵图…'), 'Export sprite sheet…');
    assert.equal(t('palette.more', { n: 3 }), '3 more…', 'palette.more 的 {n} 没替换');
});

test('t() 兜底：键不存在时返回调用点的原文，不是键名也不是空串', () => {
    assert.equal(t('cmd.play.nope', '原文兜底'), '原文兜底');
});
