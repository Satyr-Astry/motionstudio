// i18n P3-A：工具名 / 笔名 / 调色板 / 叠放树 / 画布 HUD 的词条化自检。
//
// 这一片最容易踩的三件事，逐条钉死：
//   1. **落盘值一个字都不能动**：工具的 `id`（select/brush/…）、笔刷的 `id`（pixel/round/…）
//      是按钮 dataset、localStorage 键（`ms.brush.<id>`）与 .msp 之外的状态键，改了就丢用户设置；
//      词条只换用户看到的那个词。
//   2. **读时求值**：`BRUSH_PRESETS` 在模块加载时就建好了，语言却可以中途切换 ——
//      所以预设的 `name` 必须是 getter，不能是一串算好的字符串（否则切语言后按钮挂旧词）。
//   3. **源码不留中文原文**：`t()` 只传键，译文只活在词典里。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEFAULT_LOCALE, has, keysOf, setLocale, t } from '../app/i18n/index.mjs';
import panelsPart from '../app/i18n/parts/panels.mjs';
import { BRUSH_PRESETS, brushById } from '../app/paint/brush.mjs';

const HAN = /[\u4e00-\u9fff]/;
const NAMESPACES = ['tool.', 'tbar.', 'brush.', 'color.', 'tree.', 'chrome.'];

const zhTable = panelsPart['zh-Hans'];
const enTable = panelsPart.en;

/** 本片新加的键（按命名空间过滤，别的 track 的键不归这里管）。 */
function mine(table) {
    return Object.keys(table).filter((k) => NAMESPACES.some((p) => k.startsWith(p))).sort();
}

const EN_KEYS = mine(enTable);
const ZH_KEYS = mine(zhTable);

const FILES = {
    'toolbar.mjs': readFileSync(new URL('../app/editors/toolbar.mjs', import.meta.url), 'utf8'),
    'brush.mjs': readFileSync(new URL('../app/paint/brush.mjs', import.meta.url), 'utf8'),
    'palette.mjs': readFileSync(new URL('../app/editors/palette.mjs', import.meta.url), 'utf8'),
    'tree.mjs': readFileSync(new URL('../app/editors/tree.mjs', import.meta.url), 'utf8'),
    'canvas-chrome.mjs': readFileSync(new URL('../app/editors/canvas-chrome.mjs', import.meta.url), 'utf8'),
};

/** 去掉注释后的源码（块注释 + 行注释，含行尾注释）；注释里的中文是允许的。 */
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/\r$/, '').replace(/\/\/[^\r\n]*$/, ''))
        .join('\n');
}

/** 在指定语言下跑断言，结束后回到缺省语言（不污染别的用例）。 */
function withLocale(id, fn) {
    setLocale(id);
    try {
        fn();
    } finally {
        setLocale(DEFAULT_LOCALE);
    }
}

test('两表镜面：en 与 zh-Hans 的键集合完全一致，且都有值', () => {
    assert.deepEqual(EN_KEYS, ZH_KEYS, 'en 与 zh-Hans 的键集合必须一一对应');
    assert.ok(EN_KEYS.length >= 45, '本片至少 45 条，实际 ' + EN_KEYS.length);
    for (const k of EN_KEYS) {
        assert.ok(String(enTable[k]).trim().length > 0, k + ' 的 en 值是空串');
        assert.ok(String(zhTable[k]).trim().length > 0, k + ' 的 zh-Hans 值是空串');
    }
});

test('en 表不含汉字；zh-Hans 每条都是真中文', () => {
    // 纯格式条目：值里只有占位符与标点，本来就该双语同形（`选择 (V)` 的括号与空格是原文一部分，
    // 拆成「{name}（{key}）」反而改动了界面文案）。只豁免这一条，别的键必须真有汉字。
    const FORMAT_ONLY = new Set(['tool.label']);
    for (const k of EN_KEYS) {
        assert.ok(!HAN.test(enTable[k]), k + ' 的英文值是「' + enTable[k] + '」，en 表里不许有中文');
        if (FORMAT_ONLY.has(k)) continue;
        assert.ok(HAN.test(zhTable[k]), k + ' 的中文值是「' + zhTable[k] + '」，一个汉字都没有');
    }
});

test('占位符两侧同名：切语言不许丢数值', () => {
    const placeholders = (s) => [...String(s).matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1]).sort();
    for (const k of EN_KEYS) {
        assert.deepEqual(placeholders(zhTable[k]), placeholders(enTable[k]),
            k + ' 的占位符两表不一致（en: ' + placeholders(enTable[k]).join(',') + '）');
    }
});

test('分片已并进运行期词典，且这些键在两种语言下都取得到', () => {
    const mergedZh = keysOf('zh-Hans');
    for (const k of EN_KEYS) {
        assert.ok(mergedZh.includes(k), k + ' 没并进运行期词典（parts/index.mjs 注册了吗？）');
        assert.ok(has(k), k + ' 在词典里取不到');
        withLocale('zh-Hans', () => assert.notEqual(t(k), k, k + ' 在 zh-Hans 里缺词'));
        withLocale('en', () => assert.notEqual(t(k), k, k + ' 在 en 里缺词'));
    }
});

test('五个文件里引用的本片键都在词典里，且词典里没有死条目', () => {
    // 双向对账：只查「用的键有没有词条」会放过「加了词条没人用」；只查后者又会漏掉漏词。
    // 键既可能出现在 t('…') 里，也可能挂在常量表的 nameKey / labelKey 上，所以一律按引号串扫。
    const used = new Set();
    for (const src of Object.values(FILES)) {
        for (const m of src.matchAll(/['"]((?:tool|tbar|brush|color|tree|chrome)\.[A-Za-z0-9.]+)['"]/g)) {
            used.add(m[1]);
        }
    }
    for (const k of used) assert.ok(has(k), '源码里用了词典里没有的键：' + k);
    const unused = EN_KEYS.filter((k) => !used.has(k));
    assert.deepEqual(unused, [], '这些词条没人引用（加了键却没接到界面上？）：' + unused.join(', '));
});

test('源码注释以外没有中文字面量（t() 只传键）', () => {
    for (const [name, src] of Object.entries(FILES)) {
        const left = stripComments(src)
            .split('\n')
            .filter((line) => HAN.test(line));
        assert.deepEqual(left, [], name + ' 还有界面中文没走词典：\n  ' + left.join('\n  '));
    }
});

test('没有 t(key, 中文) 这种带兜底的写法，也没有遮蔽 t 的局部变量', () => {
    for (const [name, src] of Object.entries(FILES)) {
        assert.ok(!/\bt\('[^']+',\s*'[^']*[\u4e00-\u9fff]/.test(src), name + ' 还留着 t(key, 原文) 形态');
        assert.ok(!/(?:const|let|var)\s+t\s*=/.test(src), name + ' 里有局部变量 t，会把词条函数遮死');
        assert.ok(!/for\s*\(\s*const\s+t\s+of/.test(src), name + ' 的循环变量叫 t，会把词条函数遮死');
    }
});

test('落盘值不许改：工具 id 与笔刷 id 都还是原样', () => {
    const toolbar = FILES['toolbar.mjs'];
    for (const id of ['select', 'brush', 'eraser', 'bucket', 'picker', 'pan']) {
        assert.ok(toolbar.includes("id: '" + id + "'"), '工具 id ' + id + ' 被改掉了');
    }
    const ids = BRUSH_PRESETS.map((b) => b.id).sort();
    assert.deepEqual(ids, ['eraser', 'pencil', 'pixel', 'round', 'scatter', 'smudge', 'soft'],
        '笔刷 id 是 localStorage 键（ms.brush.<id>），一个都不许动');
});

test('笔刷名是读时求值的 getter：切语言后 name 跟着变，id 不变', () => {
    // 模块顶层存成字符串的话，这里第二条断言就会红 —— 这正是本片最容易犯的错。
    assert.match(FILES['brush.mjs'], /get name\(\)\s*\{/, 'BRUSH_PRESETS 的 name 必须是 getter');
    withLocale('zh-Hans', () => {
        assert.equal(brushById('round').name, '圆笔');
        assert.equal(brushById('pixel').name, '像素笔');
    });
    withLocale('en', () => {
        assert.equal(brushById('round').name, 'Round brush');
        assert.equal(brushById('pixel').name, 'Pixel brush');
        assert.equal(brushById('round').id, 'round', 'id 是落盘值，不随语言变');
    });
});

test('工具名与快捷键拼成整句：中文逐字等于词条化之前的原文', () => {
    withLocale('zh-Hans', () => {
        assert.equal(t('tool.label', { name: t('tool.select.name'), key: 'V' }), '选择 (V)');
        assert.equal(t('tool.label', { name: t('tool.eraser.name'), key: 'E' }), '橡皮 (E)');
        assert.equal(t('tbar.undo'), '撤销 (Ctrl+Z)');
        assert.equal(t('tbar.redo'), '重做 (Ctrl+Shift+Z)');
        assert.equal(t('tbar.size'), '笔尖');
        assert.equal(t('tbar.opacity'), '不透明');
    });
    withLocale('en', () => {
        assert.equal(t('tool.label', { name: t('tool.brush.name'), key: 'B' }), 'Brush (B)');
    });
});

test('叠放树的句子按当前语言拼，数字走占位符', () => {
    withLocale('zh-Hans', () => {
        assert.equal(t('tree.kids', { n: 3 }), '含 3 个子对象（拖动这一行会整棵子树一起移动）');
        assert.equal(t('tree.row.top', { name: '组 A' }), '组 A · 顶层');
        assert.equal(t('tree.row.withChain', { name: '组 A', chain: 'A › B' }), '组 A · 父链 A › B');
    });
    withLocale('en', () => {
        assert.equal(t('tree.kids', { n: 3 }), 'Contains 3 child objects (dragging this row moves the whole subtree)');
        assert.ok(!HAN.test(t('tree.row.withChain', { name: 'Group A', chain: 'A' })), '英文行读里还有中文');
    });
});

test('调色板与 HUD 的读数文案：双语都有值且数值不被吃掉', () => {
    withLocale('zh-Hans', () => {
        assert.equal(t('color.valueTitle'), '明度 0–100');
        assert.equal(t('color.hueTitle'), '色相 0–359');
        assert.equal(t('chrome.fitLabel'), '适配');
    });
    withLocale('en', () => {
        assert.equal(t('chrome.zoomReset'), 'Click to go back to 100%');
        assert.ok(t('chrome.fit').includes('0'), '适配按钮的 tooltip 丢了快捷键数字');
    });
});

test('落盘契约：笔刷名与词条键都不进文档', async () => {
    // 笔刷名只活在 UI；文档里连 name 字段都没有它的位置。这里对整份文档做一次粗筛。
    const { createDoc, makeObject } = await import('../app/core/doc-model.mjs');
    const { docToFile } = await import('../app/shell/project-store.mjs');
    const doc = createDoc({ width: 64, height: 64, fps: 12, duration: 1 });
    const obj = makeObject({ id: 'obj-1', name: '对象 1' });
    const saved = docToFile({ ...doc, objects: [obj] }, { name: '笔刷', savedAt: 1 });
    const blob = JSON.stringify(saved);
    for (const key of EN_KEYS) assert.ok(!blob.includes(key), '词条键 ' + key + ' 进了存档');
    for (const k of EN_KEYS) {
        assert.ok(!blob.includes(zhTable[k]), '译文「' + zhTable[k] + '」进了存档');
    }
    assert.ok(!blob.includes('brush.'), '笔刷相关的键不该出现在存档里');
});
