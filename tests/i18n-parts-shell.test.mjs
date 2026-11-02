// 外壳与通知片（P2-A）自检：`app/shell/**` 的界面文案全部走 `shell.*` 词条。
//
// 三条底线，破一条就红：
//   1. **落盘值一个字符都不改**。这一片碰的 `.msp` 字段、localStorage 键、IPC 通道名
//      都是契约：迁文案只能换「给人看的那一段」，通道名与文件字段挪进词典就完蛋了。
//   2. 两表镜面：en 与 zh-Hans 的键集合、键顺序一致；en 里没有汉字；zh 里每条都是真中文；
//      两表的 `{占位符}` 必须同名 —— 少一个占位符，切到那门语言就会丢掉具体数值。
//   3. 源码不留中文原文。`t('shell.x.y')` 只传键；原文留在源码里当第二参，
//      `_check-i18n` 的「还剩多少条」就永远降不到 0，进度指标会失效。
//      例外只有开发日志（`console.*`）—— 那是给看终端的人排障用的，不面向用户。
//
// 剩下的中文字面量按文件钉死数字：多一条就说明又绕开了词典，少一条说明有人顺手删了日志。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import shellPart from '../app/i18n/parts/shell.mjs';
import { DEFAULT_LOCALE, keysOf, setLocale, t } from '../app/i18n/index.mjs';

const HAN = /[\u4e00-\u9fff]/;
// `_check-i18n.mjs` 的中文标点也算文案：全角括号、冒号、省略号都会进统计
const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff01-\uff60]/;

const enTable = shellPart.en;
const zhTable = shellPart['zh-Hans'];

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** 本片写域：`app/shell/` 里所有要迁的文件。 */
const FILES = {
    'ipc.mjs': read('../app/shell/ipc.mjs'),
    'import-file.mjs': read('../app/shell/import-file.mjs'),
    'ctx-time.mjs': read('../app/shell/ctx-time.mjs'),
    'view-host.mjs': read('../app/shell/view-host.mjs'),
    'doc-state.mjs': read('../app/shell/doc-state.mjs'),
    'chrome.mjs': read('../app/shell/chrome.mjs'),
    'app.mjs': read('../app/shell/app.mjs'),
    'project-io.mjs': read('../app/shell/project-io.mjs'),
};

/**
 * 允许留在源码里的中文：只剩开发日志。
 * 判据与 `_check-i18n.mjs` 对齐（跳过整行注释、行内 `//` 之后，只看字符串字面量），
 * 额外放行同一行 `console.*` 之前的字面量 —— 那是日志内容，不进界面。
 */
function literalsLeft(src, includeConsole) {
    const out = [];
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const trimmed = raw.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
        const cut = raw.indexOf('//');
        const line = cut >= 0 ? raw.slice(0, cut) : raw;
        for (const m of line.matchAll(/'([^'\n]*)'|"([^"\n]*)"|`([^`\n]*)`/g)) {
            const value = m[1] ?? m[2] ?? m[3];
            if (!value || !CJK.test(value)) continue;
            if (!includeConsole && line.slice(0, m.index).includes('console.')) continue;
            out.push((i + 1) + ': ' + value);
        }
    }
    return out;
}

/** 词条表里 `{name}` 这类占位符的集合。 */
const placeholders = (s) => new Set([...String(s).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]));

/** 源码里出现过的 `shell.*` 键（含 ``NOTE_TEXT`` 那种以字面量存表、稍后现取的点）。 */
function usedKeys() {
    const used = new Set();
    for (const src of Object.values(FILES)) {
        for (const m of src.matchAll(/'(shell\.[A-Za-z0-9.]+)'/g)) used.add(m[1]);
    }
    return used;
}

test('两表镜面：键集合、键顺序完全一致，且都并进了词典', () => {
    assert.deepEqual(Object.keys(enTable), Object.keys(zhTable), 'en 与 zh-Hans 的键集合/顺序必须一一对应');
    assert.ok(Object.keys(enTable).length >= 260, '外壳片词条至少 260 条，实际 ' + Object.keys(enTable).length);

    const mergedEn = keysOf('en');
    const mergedZh = keysOf('zh-Hans');
    for (const key of Object.keys(enTable)) {
        assert.ok(mergedEn.includes(key), key + ' 没并进 en 词典（parts/index.mjs 注册了吗？）');
        assert.ok(mergedZh.includes(key), key + ' 没并进 zh-Hans 词典');
    }
});

test('键都落在 shell. 前缀里，且符合键语法', () => {
    for (const key of Object.keys(enTable)) {
        assert.ok(key.startsWith('shell.'), key + ' 不在本片的 shell.* 前缀里');
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

test('占位符两表同名：切语言不许丢数值', () => {
    for (const key of Object.keys(enTable)) {
        const a = [...placeholders(enTable[key])].sort();
        const b = [...placeholders(zhTable[key])].sort();
        assert.deepEqual(b, a, key + ' 的占位符两表不一致（en: ' + a.join(',') + ' / zh: ' + b.join(',') + '）');
    }
});

test('源码里用到的每个 shell.* 键都在两表里有非空值，且没有多出来的死词条', () => {
    const used = usedKeys();
    assert.ok(used.size >= 260, '源码里只找到 ' + used.size + ' 个 shell.* 键，迁移没做完？');
    for (const key of used) {
        assert.ok(Object.hasOwn(enTable, key), key + ' 在 en 表里没有词条（界面会直接显示键名）');
        assert.ok(enTable[key].trim(), key + ' 的 en 词条是空的');
        assert.ok(Object.hasOwn(zhTable, key), key + ' 在 zh-Hans 表里没有词条');
        assert.ok(zhTable[key].trim(), key + ' 的 zh 词条是空的');
    }
    const unused = Object.keys(enTable).filter((key) => !used.has(key));
    assert.deepEqual(unused, [], '这些词条没人用（改过文案后忘了删旧键？）：' + unused.join(', '));
});

test('源码不留中文原文：t() 只传键，译文只活在词典里', () => {
    for (const [name, src] of Object.entries(FILES)) {
        const withText = [...src.matchAll(/t\('(shell\.[A-Za-z0-9.]+)',\s*'([^']*)'\)/g)];
        assert.deepEqual(withText.map((m) => m[1]), [], name + ' 还有 t(key, 原文) 形态');
    }
});

test('八个文件都引了 t()，没人绕过词典直接写中文', () => {
    for (const [name, src] of Object.entries(FILES)) {
        assert.match(src, /import \{[^}]*\bt\b[^}]*\} from '\.\.\/i18n\/index\.mjs'/, name + ' 没引词条函数');
    }
    // 按文件钉死剩余条数：面向用户的文案一条都不许剩，只有 console 开发日志例外。
    // 两个数字一起看才有意义 —— 只钉总数，等于允许「删掉一条日志换一条界面文案」。
    const consoleOnly = {
        'ipc.mjs': 1,
        'import-file.mjs': 0,
        'ctx-time.mjs': 0,
        'view-host.mjs': 7,
        'doc-state.mjs': 6,
        'chrome.mjs': 0,
        'app.mjs': 0,
        'project-io.mjs': 13,
    };
    for (const [name, src] of Object.entries(FILES)) {
        const uiLeft = literalsLeft(src, false);
        assert.equal(uiLeft.length, 0, name + ' 还有 ' + uiLeft.length + ' 条界面中文没走词典：\n  ' + uiLeft.join('\n  '));
        const all = literalsLeft(src, true);
        assert.equal(all.length, consoleOnly[name], name + ' 剩下的中文条数变了（只允许 console 日志）：\n  ' + all.join('\n  '));
    }
});

test('落盘契约没被翻译动过：IPC 通道名一个一个都还是原样', () => {
    const src = FILES['ipc.mjs'];
    const channels = [...new Set([...src.matchAll(/call\('([A-Za-z]+)'/g)].map((m) => m[1]))].sort();
    assert.deepEqual(channels, [
        'exportFrames',
        'exportSheet',
        'importFile',
        'loadProject',
        'openFolder',
        'openInFolder',
        'saveBinary',
        'saveProject',
    ], 'IPC 通道名是 preload/main.js 的契约，一个都不许跟着文案动');
    // 通道名不许过词条：`call(t('…'), …)` 这种写法等于把契约交给语言设置
    assert.doesNotMatch(src, /call\(\s*t\(/, '通道名被塞进了词条');
});

test('未命名项目 / 自动保存这类落盘文案只换取值来源，键名没动', () => {
    const src = FILES['project-io.mjs'];
    // store 的字段名与草稿 id 是存进 IndexedDB 的，翻译会读不出旧数据
    assert.match(src, /__draft/, '草稿标记被改了');
    assert.match(src, /makeRecord\(\{/, '项目库记录结构被改了');
    assert.doesNotMatch(src, /t\('__draft/, '草稿标记被弄进词典了');
});

test('t() 现取：切语言后外壳文案跟着换，切回英文也回得去', () => {
    setLocale('zh-Hans');
    try {
        assert.equal(t('shell.status.ready'), '就绪');
        assert.equal(t('shell.draft.saved'), '已保存草稿（未命名项目，Ctrl+S 入库）');
        assert.equal(t('shell.topbar.untitled'), '未命名项目（未入库）');
        assert.equal(t('shell.video.done', { frames: 3, kb: 4, path: 'C:/out/a.webm' }), '已导出 WebM（3 帧 · 4 KB）：C:/out/a.webm');
    } finally {
        setLocale(DEFAULT_LOCALE);
    }
    assert.equal(t('shell.status.ready'), 'Ready', '切回英文后没跟着换');
    assert.equal(t('shell.saveFile.noPath').includes('no path'), true);
});

test('词条带占位符时缺变量不炸：原样留着，好让写错的地方一眼看得出来', () => {
    assert.equal(t('shell.status.ready', { extra: 'x' }), 'Ready');
    assert.match(t('shell.video.done', { frames: 2 }), /\{kb\}|\{path\}/, '缺的占位符应原样保留');
});

test('t() 兜底：键不存在时返回调用点的原文，不是键名也不是空串', () => {
    assert.equal(t('shell.nope.nope', '原文兜底'), '原文兜底');
});
