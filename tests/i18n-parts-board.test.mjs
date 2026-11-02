// 画板分片（app/i18n/parts/board.mjs）与编辑器（app/editors/board.mjs）之间的契约。
//
// 这组测试盯五件事：
//   1. 两表镜面：en / zh-Hans 键集合逐条相同，漏一条就是一处空白或串语言；
//   2. 双向对齐：表里不许有没人用的孤儿键，源码里不许有查不到词条的键；
//   3. 源码不留中文原文，也不留 `t('k', '中文')` 第二参 —— 迁移的进度指标就是「还剩几条」，
//      原文留在源码里这个指标永远降不到 0；
//   4. 占位符成对：`{name}` / `{key}` / `{level}` / `{n}` / `{color}` 在两种语言里必须同名同数，
//      否则某一语言会把 `{color}` 原样显示给用户；
//   5. 翻译走的是**读时求值**：常量表里存键名，不在模块顶层算成字符串，切语言才能重读。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import boardPart from '../app/i18n/parts/board.mjs';
import { dictOf, keysOf, t, setLocale, DEFAULT_LOCALE, LOCALES } from '../app/i18n/index.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const boardSrc = read('../app/editors/board.mjs');

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
 * 只为「裸中文」与「调用点抽取」两条守卫服务 —— 注释里写键名、写中文都是刻意的。
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

const code = stripComments(boardSrc);

// 源码里的每一处 `t('board.xxx')`：迁移后**不再带中文原文第二参**。
// 另外有些键不直接出现在 t() 里，而是先存进常量表再按变量查（BRUSH_SHORT_KEY /
// PARAM_UI.labelKey / MIRROR_MODES / .bd-act 动作表），所以对齐检查抽的是源码里
// 全部 `board.*` 字符串字面量，而不是只看调用括号里的。
const calls = [...code.matchAll(/t\(\s*'(board\.[a-zA-Z0-9.]+)'\s*\)/g)].map((m) => m[1]);
const literals = [...code.matchAll(/'(board\.[a-zA-Z0-9.]+)'/g)].map((m) => m[1]);
const calledKeys = [...new Set(literals)].sort();

const enDict = dictOf('en');
const zhDict = dictOf('zh-Hans');
const partKeys = keysOf('en');
const boardKeys = partKeys.filter((k) => k.startsWith('board.')).sort();

const PLACEHOLDER = /\{(\w+)\}/g;
const placeholdersOf = (s) => [...s.matchAll(PLACEHOLDER)].map((m) => m[1]).sort();

test('分片结构：en 与 zh-Hans 键集合逐条镜面，且只占 board.* 命名空间', () => {
    const en = Object.keys(boardPart.en);
    const zh = Object.keys(boardPart['zh-Hans']);
    assert.deepEqual(zh, en, '两份表键集合必须完全一致（顺序也一致，方便逐条对照）');
    assert.ok(en.length >= 80, `画板分片应至少 80 条，实际 ${en.length}`);
    for (const k of en) assert.ok(k.startsWith('board.'), '画板分片不许越界到别的命名空间：' + k);
    // 分片键全部进了运行期合并表（parts/index.mjs 真的挂上了）
    assert.deepEqual(boardKeys, [...en].sort());
});

test('键语法与取值：合法命名、非空、无首尾空白', () => {
    for (const k of Object.keys(boardPart.en)) {
        assert.match(k, /^board(\.[a-zA-Z0-9]+)+$/, '键名不合法：' + k);
        for (const locale of LOCALES) {
            const v = boardPart[locale][k];
            assert.equal(typeof v, 'string', `${k}（${locale}）必须是字符串`);
            assert.ok(v.length > 0, `${k}（${locale}）不该是空串`);
            assert.equal(v, v.trim(), `${k}（${locale}）首尾不许有空白`);
        }
    }
});

test('英文表里不许有中文字面量', () => {
    for (const [k, v] of Object.entries(boardPart.en)) {
        assert.doesNotMatch(v, /[\u4e00-\u9fff]/, `${k} 的英文里混进了中文：${v}`);
    }
});

test('中文表每条都是中文（纯符号/纯英文的键位不进表）', () => {
    for (const [k, v] of Object.entries(boardPart['zh-Hans'])) {
        assert.match(v, /[\u4e00-\u9fff]/, `${k} 的中文词条里没有汉字：${v}`);
    }
});

test('双向对齐：表里没有孤儿键，源码里没有查不到词条的键', () => {
    assert.deepEqual(calledKeys, [...Object.keys(boardPart.en)].sort(),
        '词条表与 board.mjs 的调用点必须一一对应（多一条是孤儿，少一条是漏译）');
});

test('占位符成对：两种语言的 {} 名字与个数完全一致，且替换后不残留花括号', () => {
    for (const k of Object.keys(boardPart.en)) {
        assert.deepEqual(
            placeholdersOf(boardPart['zh-Hans'][k]),
            placeholdersOf(boardPart.en[k]),
            `${k} 两种语言的占位符对不上 —— 会把 {name} 原样显示给用户`,
        );
    }
    // 带占位符的键必须真的能用 t(key, vars) 填满
    for (const k of Object.keys(boardPart.en)) {
        const names = placeholdersOf(boardPart.en[k]);
        if (!names.length) continue;
        const vars = Object.fromEntries(names.map((n, i) => [n, `V${i}`]));
        for (const locale of LOCALES) {
            const out = inLocale(locale, () => t(k, vars));
            assert.doesNotMatch(out, /[{}]/, `${k}（${locale}）占位符没被替换：${out}`);
        }
    }
});

test('笔刷短名：7 支笔都是两字（board-icons.test.mjs 的「不许单字」在这里查词条）', () => {
    const keys = Object.keys(boardPart['zh-Hans']).filter((k) => k.startsWith('board.brush.short.'));
    assert.equal(keys.length, 7, '七支笔的短名都要有：' + keys.join(','));
    for (const k of keys) {
        const zh = boardPart['zh-Hans'][k];
        assert.equal([...zh].length, 2, `笔刷短名「${zh}」不是两字（三字会撑破一行，单字读不懂）`);
        assert.doesNotMatch(boardPart.en[k], /[\u4e00-\u9fff]/);
        assert.ok(boardPart.en[k].length >= 2, `英文短名太短：${boardPart.en[k]}`);
    }
});

test('源码守卫：注释之外，一个中文字面量都不许留（原文只活在词典里）', () => {
    const leftovers = [...code.matchAll(/'((?:[^'\\]|\\.)*)'/g)]
        .map((m) => m[1])
        .filter((s) => /[\u4e00-\u9fff]/.test(s));
    assert.deepEqual(leftovers, [], '有中文文案没走 t()：' + leftovers.join(' | '));
    // 反向：双引号 / 模板串里也不许出现中文（以前最容易漏的就是这两处）
    assert.doesNotMatch(code, /"[^"]*[\u4e00-\u9fff][^"]*"/, '双引号里还有中文文案');
    assert.doesNotMatch(code, /`[^`]*[\u4e00-\u9fff][^`]*`/, '模板串里还有中文文案');
});

test('调用点只传键，不再传中文原文第二参（迁移进度指标才降得下去）', () => {
    const withFallback = [...code.matchAll(/t\(\s*'board\.[a-zA-Z0-9.]+'\s*,\s*'(?:[^'\\]|\\.)*'\s*\)/g)];
    assert.deepEqual(withFallback.map((m) => m[0]), [], '还有 t(key, 原文) 写法：' + withFallback.map((m) => m[0]).join(' | '));
    assert.ok(calls.length >= 40, '直接调用的键太少，抽取正则可能失效了：' + calls.length);
});

test('读时求值：常量表存键名而不是算好的译文，切语言才跟得上', () => {
    // 这三张表都被 mount() 的循环消费；如果有人在模块顶层把 t() 调用结果存进去，
    // 语言切换后就会冻在启动语言上 —— 用「表里必须还是键名」来钉死这一点。
    const mirrors = [...code.matchAll(/\['(none|x|y|both)', '(board\.mirror\.[a-z]+)'\]/g)].map((m) => m[2]);
    assert.deepEqual(mirrors, ['board.mirror.none', 'board.mirror.x', 'board.mirror.y', 'board.mirror.both'],
        'MIRROR_MODES 里存的必须是键名，不是译文');
    for (const key of mirrors) {
        const en = inLocale('en', () => t(key));
        const zh = inLocale('zh-Hans', () => t(key));
        assert.notEqual(zh, en, `${key} 切语言后没变`);
        assert.equal(en, enDict[key]);
        assert.equal(zh, zhDict[key]);
    }
    // 复位后回到英文（不残留）
    assert.equal(t('board.mirror.none'), enDict['board.mirror.none']);
});

test('漏译不会露出键名：每个调用点的键在两份表里都能取到非空词条', () => {
    assert.ok(calledKeys.length >= 80, '调用点太少，源码抽取正则可能失效了：' + calledKeys.length);
    for (const k of calledKeys) {
        assert.ok(enDict[k] && enDict[k].trim(), `${k} 在 en 表里没有词条`);
        assert.ok(zhDict[k] && zhDict[k].trim(), `${k} 在 zh-Hans 表里没有词条 —— 漏译会把键名直接显示给用户`);
    }
});

test('初始化顺序：建 DOM 时不读还没声明的私有状态（stabTitle 只在 paintChrome 里调）', () => {
    // `let stabLevel = ...` 在「私有状态」段才声明，而 stabBtn 在更早的工具条段构建。
    // 建按钮时调 stabTitle() 会读 stabLevel → TDZ 抛 ReferenceError，整个编辑器白屏。
    // 这条是给未来的自己钉的钉子：初始 title 用占位词条，真实档位由 paintChrome() 刷。
    const declAt = code.indexOf('let stabLevel');
    assert.ok(declAt > 0, '找不到 stabLevel 的声明');
    const callAt = code.indexOf('= stabTitle()');
    assert.ok(callAt > declAt, 'stabTitle() 在 stabLevel 声明之前被调用（TDZ —— 会直接白屏）');
    assert.match(code, /stabBtn\.title = t\('board\.stab\.titleOff'\);/, '初始 title 要用占位词条');
    assert.ok(boardKeys.includes('board.stab.titleOff') && boardKeys.includes('board.stab.titleOn'),
        '稳定器两个档位 title 词条都要在');
});

test('域计数守卫：画板工具栏的四段都还在（被人删空要在这里响）', () => {
    const count = (prefix) => boardKeys.filter((k) => k.startsWith(prefix)).length;
    assert.equal(count('board.brush.short.'), 7, '七支笔的短名');
    assert.equal(count('board.mirror.'), 5, '镜像：4 档 + 1 个 title');
    assert.equal(count('board.param.'), 5, '四条滑杆标签 + 恢复默认');
    assert.equal(count('board.act.'), 8, '五个动作 × (文字 + title)，‹ › 只有 title');
    assert.equal(count('board.pick.'), 8, '取色器：名称 / 两个 title / 四种失败 + 成功');
    assert.equal(count('board.bucket.'), 8, '油漆桶：名称 / 两个 title / 三种失败 + 成功 + 计数');
    assert.ok(count('board.size.') >= 9, '尺寸控件：' + count('board.size.'));
    assert.ok(boardKeys.includes('board.hint'), '底部提示行没了');
});
