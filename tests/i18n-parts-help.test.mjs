// 帮助分片（app/i18n/parts/help.mjs）与数据源（app/editors/help.mjs）之间的契约。
//
// 这组测试盯四件事：
//   1. 两表镜面：en / zh-Hans 键集合逐条相同，漏一条就是一处空白或串语言；
//   2. 双向对齐：表里不许有没人用的孤儿键，源码里不许有查不到词条的键；
//   3. 源码不留中文原文：译文只活在词典里，漏译由缺口闸与调用点校验兜住；
//   4. 文案是 getter（读时求值）而不是启动时算好的常量 —— 切语言后重读必须立刻变。
//      第 4 条是这次改造的**唯一理由**，谁图省事改回 `name: t(...)` 都必须在这里变红。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import helpPart from '../app/i18n/parts/help.mjs';
import { dictOf, keysOf, setLocale, DEFAULT_LOCALE, LOCALES } from '../app/i18n/index.mjs';
import { CONCEPT_ITEMS, SHORTCUT_GROUPS, LEGEND_ITEMS, CURVE_TIPS, overlayGroups } from '../app/editors/help.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const helpSrc = read('../app/editors/help.mjs');

/** 在指定语言下跑一段，跑完一定复位（同文件共用一个模块实例，不能留残留）。 */
function inLocale(id, fn) {
    try {
        setLocale(id);
        return fn();
    } finally {
        setLocale(DEFAULT_LOCALE);
    }
}

/**
 * 剥掉注释（保留字符串字面量原样）。
 * 只为后面那两条「裸中文」守卫服务 —— 注释保留中文是刻意的，不算漏翻。
 */
function stripComments(src) {
    let out = '';
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === '/' && src[i + 1] === '/') {
            while (i < src.length && src[i] !== '\n') i += 1;
            continue;
        }
        if (c === '/' && src[i + 1] === '*') {
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
            i += 2;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') {
            const q = c;
            out += c;
            i += 1;
            while (i < src.length) {
                if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
                out += src[i];
                if (src[i] === q) { i += 1; break; }
                i += 1;
            }
            continue;
        }
        out += c;
        i += 1;
    }
    return out;
}

// 源码里每一处 `t('help.xxx')`
// 迁移后**不再带中文原文第二参**：原文若留在源码里，`_check-i18n` 的「还剩多少条」
// 就永远降不到 0，进度指标会失效。缺词风险由「两表非空 + 缺口 0 + 合并撞键抛错」兜住。
const CALL = /t\(\s*'(help\.[a-zA-Z0-9.]+)'\s*\)/g;
const code = stripComments(helpSrc);
const calls = [...code.matchAll(CALL)].map((m) => m[1]);
const calledKeys = [...new Set(calls)].sort();

const enDict = dictOf('en');
const zhDict = dictOf('zh-Hans');
const partKeys = [...keysOf('en')].filter((k) => k.startsWith('help.'));

test('分片结构：en 与 zh-Hans 键集合逐条镜面，且只占 help.* 命名空间', () => {
    const en = Object.keys(helpPart.en);
    const zh = Object.keys(helpPart['zh-Hans']);
    assert.deepEqual(zh, en, '两份表键集合必须完全一致（顺序也一致，方便逐条对照）');
    assert.ok(en.length >= 90, `帮助分片应至少 90 条，实际 ${en.length}`);
    for (const k of en) assert.ok(k.startsWith('help.'), '帮助分片不许越界到别的命名空间：' + k);
    // 分片键全部进了运行期合并表（parts/index.mjs 真的挂上了）
    assert.deepEqual(partKeys.sort(), [...en].sort());
});

test('键语法与取值：合法命名、非空、无首尾空白', () => {
    // 键语法由 tests/i18n.test.mjs 整体把关，这里只补一条：不许出现连字符/下划线那种
    // 「会被契约正则打回」的命名，免得改词条时才发现。
    for (const k of Object.keys(helpPart.en)) {
        assert.match(k, /^help(\.[a-zA-Z0-9]+)+$/, '键名不合法：' + k);
        for (const locale of LOCALES) {
            const v = helpPart[locale][k];
            assert.equal(typeof v, 'string', `${k}（${locale}）必须是字符串`);
            assert.ok(v.length > 0, `${k}（${locale}）不该是空串`);
            assert.equal(v, v.trim(), `${k}（${locale}）首尾不许有空白`);
        }
    }
});

test('英文表里不许有中文字面量', () => {
    for (const [k, v] of Object.entries(helpPart.en)) {
        assert.doesNotMatch(v, /[\u4e00-\u9fff]/, `${k} 的英文里混进了中文：${v}`);
    }
});

test('中文表每条都是中文（纯符号/纯英文的键位不进表）', () => {
    for (const [k, v] of Object.entries(helpPart['zh-Hans'])) {
        assert.match(v, /[\u4e00-\u9fff]/, `${k} 的中文词条里没有汉字：${v}`);
    }
});

test('双向对齐：表里没有孤儿键，源码里没有查不到词条的键', () => {
    assert.deepEqual(calledKeys, [...Object.keys(helpPart.en)].sort(),
        '词条表与 help.mjs 的调用点必须一一对应（多一条是孤儿，少一条是漏译）');
    assert.equal(calledKeys.length, Object.keys(helpPart.en).length, '同一键被多处引用时不重复计数');
});

test('调用点的键在两份表里都能取到非空词条（漏译不显示键名）', () => {
    assert.ok(calls.length >= 90, '调用点太少，源码抽取正则可能失效了：' + calls.length);
    for (const k of calledKeys) {
        assert.ok(enDict[k] && enDict[k].trim(), `${k} 在 en 表里没有词条`);
        assert.ok(zhDict[k] && zhDict[k].trim(), `${k} 在 zh-Hans 表里没有词条 —— 漏译会把键名直接显示给用户`);
    }
});

test('源码守卫：注释之外，一个中文字面量都不许留（原文只活在词典里）', () => {
    // 比 _check-i18n.mjs 的字面量计数更严：这里要求「迁完就一条不剩」。
    // stripComments 已剥掉注释，所以剩下的中文只可能来自字符串字面量。
    const leftovers = [...code.matchAll(/'((?:[^'\\]|\\.)*)'/g)]
        .map((m) => m[1])
        .filter((s) => /[\u4e00-\u9fff]/.test(s));
    assert.deepEqual(leftovers, [], '有中文文案没走 t()：' + leftovers.join(' | '));
    // 反向：双引号 / 模板串里也不许出现中文（以前最容易漏的就是这两处）
    assert.doesNotMatch(code, /"[^"]*[\u4e00-\u9fff][^"]*"/, '双引号里还有中文文案');
    assert.doesNotMatch(code, /`[^`]*[\u4e00-\u9fff][^`]*`/, '模板串里还有中文文案');
});

test('读时求值：切语言后重读同一份数据源立刻变（不是启动时冻住）', () => {
    const pick = () => {
        const g = SHORTCUT_GROUPS.find((x) => x.id === 'canvas');
        return [g.title, g.items[0].name];
    };
    const en = inLocale('en', pick);
    const zh = inLocale('zh-Hans', pick);
    assert.notDeepEqual(zh, en, '切语言后数据源仍吐旧语言：文案被冻在模块求值那一刻了');
    assert.equal(en[0], enDict['help.shortcut.canvas.title']);
    assert.equal(zh[0], zhDict['help.shortcut.canvas.title']);
    assert.equal(en[1], enDict['help.shortcut.canvas.selectTool.name']);
    assert.equal(zh[1], zhDict['help.shortcut.canvas.selectTool.name']);
    // 复位后回到英文（不残留）
    assert.equal(SHORTCUT_GROUPS.find((x) => x.id === 'canvas').title, enDict['help.shortcut.canvas.title']);
});

test('读时求值：图例、概念、曲线提示都跟着语言走', () => {
    const snap = () => JSON.stringify({
        concept: CONCEPT_ITEMS.map((s) => [s.title, ...s.rows.map((r) => r.name + '|' + r.desc)]),
        legend: LEGEND_ITEMS.map((l) => [l.name, l.text]),
        curve: CURVE_TIPS.map((c) => [c.name, c.desc]),
    });
    const en = inLocale('en', snap);
    const zh = inLocale('zh-Hans', snap);
    assert.notEqual(zh, en, '这几处文案没跟上语言切换');
    // 英文下不该漏出中文
    assert.doesNotMatch(en, /[\u4e00-\u9fff]/);
    assert.match(zh, /纹理/);
});

test('overlayGroups()：跟随语言，并照旧丢掉 icon、键位空串兜「鼠标」', () => {
    const en = inLocale('en', () => overlayGroups());
    const zh = inLocale('zh-Hans', () => overlayGroups());
    assert.notDeepEqual(zh, en, '快捷键浮层的数据没跟上语言');

    const soft = inLocale('en', () => overlayGroups([{ title: 'G', items: [{ name: 'drag' }] }]));
    assert.equal(soft[0].items[0].keys, enDict['help.shortcut.mouseOnly'], '键位空串要兜成词条里的「鼠标」');
    assert.equal(soft[0].items[0].hint, '');

    for (const g of en) {
        assert.ok(g.title, '分组标题不能空');
        for (const it of g.items) {
            assert.ok(it.title, '条目必须有动作名');
            assert.ok(it.keys, '条目必须有键位');
            assert.equal(it.icon, undefined, '浮层列表不吃 icon');
        }
    }
});

test('数据源形状：概念段与曲线提示是 { name, desc }，mount 才能直接渲染', () => {
    assert.ok(CONCEPT_ITEMS.length > 0);
    for (const sec of CONCEPT_ITEMS) {
        assert.equal(typeof sec.title, 'string');
        assert.ok(sec.title.length > 0);
        assert.ok(Array.isArray(sec.rows) && sec.rows.length > 0);
        for (const r of sec.rows) {
            assert.equal(Array.isArray(r), false, '改成对象了：数组元素挂不上 getter');
            assert.equal(typeof r.name, 'string');
            assert.equal(typeof r.desc, 'string');
            assert.ok(r.name.length > 0 && r.desc.length > 0);
        }
    }
    for (const tip of CURVE_TIPS) {
        assert.equal(typeof tip.name, 'string');
        assert.equal(typeof tip.desc, 'string');
        assert.ok(tip.desc.length > 8, '曲线提示要讲清楚，不是标签');
    }
});

test('域计数守卫：帮助面板的四段都还在（被人删空要在这里响）', () => {
    const count = (prefix) => partKeys.filter((k) => k.startsWith(prefix)).length;
    assert.equal(count('help.concept.'), 11, '概念段：1 个标题 + 5 行 × (名 + 说明)（纹理 / 关键帧 / 时间通道 / 骨骼 / IK）');
    assert.equal(count('help.curve.'), 11, '曲线提示：1 个标题 + 5 条 × (名 + 说明)');
    assert.equal(count('help.legend.'), 4, '图例：2 条 × (名 + 说明)');
    assert.ok(count('help.shortcut.') >= 70, '键位表是主体，不该少于 70 条：' + count('help.shortcut.'));
    // 7 个分组标题都在
    for (const id of ['file', 'time', 'keyframe', 'layer', 'canvas', 'board', 'view']) {
        assert.ok(partKeys.includes(`help.shortcut.${id}.title`), '缺分组标题：' + id);
    }
});
