// 本地化内核：词条表、locale 归一、偏好清洗、以及「切语言必须有人重绘」这条结构约束。
//
// 两件事在这里被钉死：
//   1. 缺词条时回退的是**调用点写在代码里的原文**，不是空字符串 —— 漏翻只会显示中文原文，
//      不会出现空白按钮；
//   2. `app/i18n/` 是纯逻辑模块，不碰 DOM。它一旦 import 了 shell/view-host，就会形成
//      i18n → view-host → 编辑器 → i18n 的回环，切语言时直接死循环。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { LOCALES, DEFAULT_LOCALE, getLocale, setLocale, normalizeLocale, dictOf, t, has, keysOf, htmlLangOf } from '../app/i18n/index.mjs';
import { cleanPrefs, FALLBACK_PREFS } from '../app/core/prefs.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** 每条测试跑完都把语言放回缺省，避免相互污染（同文件共用一个模块实例）。 */
function withLocale(id, fn) {
    try {
        setLocale(id);
        return fn();
    } finally {
        setLocale(DEFAULT_LOCALE);
    }
}

test('缺省语言是英文，且所有 locale 都在白名单里', () => {
    assert.equal(DEFAULT_LOCALE, 'en');
    assert.equal(getLocale(), 'en');
    assert.deepEqual([...LOCALES], ['en', 'zh-Hans']);
});

test('t()：命中返回译文，两种语言各自正确', () => {
    assert.equal(t('app.title'), 'MotionStudio');
    withLocale('en', () => assert.equal(t('editor.timeline.title'), 'Timeline'));
    withLocale('zh-Hans', () => assert.equal(t('editor.timeline.title'), '时间轴'));
    // 切回之后必须真的回到英文（不允许残留上一份表）
    assert.equal(getLocale(), 'en');
    assert.equal(t('editor.timeline.title'), 'Timeline');
});

test('t()：缺词条时依次回退 缺省语言 → 调用点原文 → key 本身', () => {
    // 完全不存在：返回 key，而不是 'undefined' 或空串
    assert.equal(t('no.such.key'), 'no.such.key');
    // 调用点给了原文：用原文（这就是「漏翻不会变空白」的实现）
    assert.equal(t('no.such.key', '原文'), '原文');
    // 命中时第二参即使是字符串也不该覆盖译文（它是回退，不是覆盖）
    assert.equal(t('app.title', '不该出现'), 'MotionStudio');
});

test('t()：没有占位符的词条，传 vars 也不改变结果', () => {
    assert.equal(t('app.title', { n: 3 }), 'MotionStudio');
});

test('has()：只认当前语言里真实存在的字符串', () => {
    assert.equal(has('app.title'), true);
    assert.equal(has('no.such.key'), false);
    withLocale('zh-Hans', () => assert.equal(has('pref.language.row'), true));
});

test('normalizeLocale()：认常见别名，其余一律回英文', () => {
    for (const alias of ['zh', 'zh-CN', 'zh_CN', 'zh-cn', 'cn', 'chs', 'zh-Hans']) {
        assert.equal(normalizeLocale(alias), 'zh-Hans', `${alias} 应归一到 zh-Hans`);
    }
    assert.equal(normalizeLocale('en'), 'en');
    assert.equal(normalizeLocale('en-US'), 'en');
    for (const bad of ['', '   ', null, undefined, 'fr', 'ja', 42]) {
        assert.equal(normalizeLocale(bad), 'en', `${String(bad)} 应回英文`);
    }
});

test('setLocale()：返回「是否真的变了」，重复设置同一语言返回 false', () => {
    assert.equal(setLocale('en'), false); // 已经是 en
    assert.equal(setLocale('zh-CN'), true); // 归一后变成 zh-Hans
    assert.equal(getLocale(), 'zh-Hans');
    assert.equal(setLocale('zh'), false); // 归一后还是 zh-Hans
    assert.equal(setLocale('en'), true);
});

test('dictOf()：未知 id 回落到缺省语言词典，不会返回 undefined', () => {
    assert.equal(dictOf('zz'), dictOf('en'));
    assert.equal(typeof dictOf('zh-Hans'), 'object');
});

test('两份词典键集合必须镜面（漏一条就是一处空白界面）', () => {
    const en = keysOf('en');
    const zh = keysOf('zh-Hans');
    assert.deepEqual(zh, en);
    assert.ok(en.length >= 36, `词条数应至少 36 条，实际 ${en.length}`);
    // 键语法：区域.实体.字段，全小写点分层
    for (const k of en) assert.match(k, /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/);
});

test('词条里不允许出现中文字面量拼接的占位（本表是整句，不是片段）', () => {
    // 英文词典里只有「语言自称」允许是中文：切语言时用户得认得自己的语言
    const en = dictOf('en');
    for (const [k, v] of Object.entries(en)) {
        if (k.startsWith('locale.')) continue;
        assert.doesNotMatch(v, /[\u4e00-\u9fff]/, `${k} 的英文里混进了中文：${v}`);
    }
});

test('htmlLangOf()：`<html lang>` 跟语言走，屏幕阅读器读的是它', () => {
    assert.equal(htmlLangOf('en'), 'en');
    assert.equal(htmlLangOf('zh-Hans'), 'zh-CN');
    assert.equal(htmlLangOf('zh-CN'), 'zh-CN');
    assert.equal(htmlLangOf('zz'), 'en');
});

test('cleanPrefs()：locale 走白名单归一，坏值回英文而不是把界面卡死', () => {
    assert.equal(cleanPrefs({ locale: 'zh-CN' }).locale, 'zh-Hans');
    assert.equal(cleanPrefs({ locale: 'zh-Hans' }).locale, 'zh-Hans');
    assert.equal(cleanPrefs({ locale: 'en' }).locale, 'en');
    assert.equal(cleanPrefs({ locale: 'klingon' }).locale, 'en');
    assert.equal(cleanPrefs({ locale: 42 }).locale, 'en');
    // 盘上没有这一项：用传进来的缺省，而不是硬写 en
    assert.equal(cleanPrefs({}, { ...FALLBACK_PREFS, locale: 'zh-Hans' }).locale, 'zh-Hans');
});

test('源码守卫：i18n 是纯逻辑模块，不碰 DOM 也不反向依赖外壳', () => {
    const src = read('../app/i18n/index.mjs');
    // 不碰 DOM：node 里能直接 import 它跑测试，就是靠这条
    assert.doesNotMatch(src, /\bdocument\./);
    assert.doesNotMatch(src, /\bwindow\./);
    // 不反向依赖外壳/编辑器（否则切语言时 i18n → view-host → 编辑器 → i18n 成环）
    for (const bad of ["from '../shell/", "from '../editors/", "from '../paint/'"]) {
        assert.ok(!src.includes(bad), `i18n/index.mjs 不该引 ${bad}`);
    }
    assert.ok(src.includes("import en from './en.mjs'"));
    assert.ok(src.includes("import zhHans from './zh-Hans.mjs'"));
});

test('源码守卫：切语言必须有人重挂面板（只换表不重绘＝界面上还是旧语言）', () => {
    const viewHost = read('../app/shell/view-host.mjs');
    assert.ok(viewHost.includes('export function remountAll'), 'view-host 要有 remountAll');
    // 画布不重挂：引擎宿主与视口都在里面，重挂会丢正在画的笔
    assert.ok(viewHost.includes('canvasInst'), 'remountAll 要跳过画布实例');

    const app = read('../app/shell/app.mjs');
    assert.ok(app.includes('function applyLocale'), 'app.mjs 要有 applyLocale');
    assert.ok(app.includes("document.documentElement.lang = htmlLangOf("), '要同步 <html lang>');
    assert.ok(app.includes('applyLocale(pref0 && pref0.locale'), '启动期要在 buildViews 之前应用语言');
    assert.ok(app.includes('setLocale:'), 'ctx 上要暴露 setLocale 给设置面板');
});

test('源码守卫：设置面板的语言段接的是 ctx.setLocale，不是自己重挂', () => {
    const prefs = read('../app/editors/prop-prefs.mjs');
    assert.ok(prefs.includes("typeof ctx.setLocale === 'function'"));
    // 面板不能自己 import view-host：它只经 ctx 转手，否则与 registry 成环
    assert.ok(!prefs.includes("from '../shell/view-host.mjs'"));
});

test('语言自称不翻译：`locale.*` 在两份表里取值必须相同', () => {
    // 一个只会英文的人切进中文界面时，仍得认出「简体中文」这四个字才切得回来。
    // 所以语言选项用**各自语言的自称**，且不随界面语言变化。
    // 注意断言方式：自称现在住在基础表的 `locale.*` 里，正确性体现为「两表取值相同」，
    // 而不是「源码里写着某个中文字面量」—— 后者会拦住词条化（硬规则：源码不留中文原文）。
    const en = dictOf('en');
    const zh = dictOf('zh-Hans');
    const selfKeys = keysOf('en').filter((k) => k.startsWith('locale.'));
    assert.ok(selfKeys.length >= LOCALES.length, '每个 locale 都要有自称词条');
    for (const key of selfKeys) {
        assert.equal(en[key], zh[key], `${key} 两份表必须一样（自称不翻译）`);
    }
    for (const id of LOCALES) {
        const key = 'locale.' + (id === 'zh-Hans' ? 'zhHans' : id);
        assert.equal(typeof en[key], 'string', `缺 ${key}`);
        assert.notEqual(en[key], key, `${key} 不能退回键名`);
    }
});
