/**
 * 属性类面板的词条化（i18n P2-D：`app/i18n/parts/props.mjs` + 九个面板模块）。
 *
 * 这一片的口径是 P1 定下来的，另外多两条硬约束：
 * - 源码只传键（`t('props.x.y')` 不带第二参回退），中文原文只有词典一份；
 * - 落盘值（`kind`、效果 `type`、参数名、偏好项的键与值）一个字都不动。
 *
 * 于是断言分五组：分片自身 → 已并入运行期词典 → 调用点覆盖与源码无中文 → 代表句渲染 → 存档纯净。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import propsPart from '../app/i18n/parts/props.mjs';
import { getLocale, has, setLocale, t } from '../app/i18n/index.mjs';
import { createDoc, makeObject } from '../app/core/doc-model.mjs';
import { docToFile } from '../app/shell/project-store.mjs';

const HAN = /[\u4e00-\u9fff]/;
const EN = propsPart.en;
const ZH = propsPart['zh-Hans'];
const KEYS = Object.keys(EN).sort();

/** 本片覆盖的九个面板模块（属性面板外壳 + 各分组）。 */
const PANELS = [
    'properties.mjs',
    'prop-kit.mjs',
    'prop-info.mjs',
    'prop-doc.mjs',
    'prop-onion.mjs',
    'prop-prefs.mjs',
    'prop-textures.mjs',
    'prop-object.mjs',
    'xform.mjs',
];

async function panelSource(name) {
    return readFile(new URL('../app/editors/' + name, import.meta.url), 'utf8');
}

/** 行注释与块注释都剥掉（`//` 前面是 `:` 的不算，避免误伤 `http://`）。 */
function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** `{name}` 这类占位符的集合。 */
function holesOf(text) {
    return [...text.matchAll(/\{([a-zA-Z0-9]+)\}/g)].map((m) => m[1]).sort();
}

/* ─────────────────────────── 分片自身 ─────────────────────────── */

test('两表键集合镜面，文案非空', () => {
    assert.deepEqual(Object.keys(ZH).sort(), KEYS, 'en 与 zh-Hans 的键集合必须一致');
    assert.ok(KEYS.length > 100, '本片体量不对：' + KEYS.length);
    for (const k of KEYS) {
        assert.equal(typeof EN[k], 'string', k + ' 的英文不是字符串');
        assert.equal(typeof ZH[k], 'string', k + ' 的中文不是字符串');
        assert.ok(EN[k].trim().length > 0, k + ' 的英文是空的');
        assert.ok(ZH[k].trim().length > 0, k + ' 的中文是空的');
    }
});

test('en 表里没有汉字', () => {
    for (const k of KEYS) {
        const hit = EN[k].match(HAN);
        assert.equal(hit, null, k + ' 的英文里混进了汉字：' + EN[k]);
    }
});

test('整句成条：占位符两侧必须一致', () => {
    for (const k of KEYS) {
        assert.deepEqual(holesOf(EN[k]), holesOf(ZH[k]), k + ' 的两语言占位符不一样');
    }
});

test('键都落在本片的三个命名空间里，不重复定义别的分片', () => {
    // props.section.*（panels）、onion.mode.*（panels）、kind.*（effects）、layers.kind.*（panels）
    // 都只能引用：它们要么在别的分片，要么在基础表里。
    for (const k of KEYS) {
        assert.ok(/^(props|pref|xform)\./.test(k), '键越界了：' + k);
        assert.ok(!k.startsWith('props.section.'), 'props.section.* 属于 panels 分片：' + k);
        assert.ok(!k.startsWith('onion.mode.'), 'onion.mode.* 属于 panels 分片：' + k);
        assert.ok(!k.startsWith('kind.'), 'kind.* 属于 effects 分片：' + k);
        assert.ok(!k.startsWith('layers.'), 'layers.* 属于 panels 分片：' + k);
        assert.ok(!k.startsWith('pref.language'), 'pref.language* 属于基础表：' + k);
    }
});

test('分片已并入运行期词典，切语言取到各自那份', () => {
    const prev = getLocale();
    try {
        for (const k of KEYS) assert.ok(has(k), '运行期词典里没有：' + k);
        setLocale('zh-Hans');
        for (const k of KEYS) assert.equal(t(k), ZH[k], '中文取值不一致：' + k);
        setLocale('en');
        for (const k of KEYS) assert.equal(t(k), EN[k], '英文取值不一致：' + k);
    } finally {
        setLocale(prev);
    }
});

/* ─────────────────────────── 调用点 ─────────────────────────── */

test('九个面板里的字面量键都查得到（调用点覆盖）', async () => {
    // `_check-i18n.mjs` 只查两表镜面与编辑器标题，不查 t() 的调用点；这一条是唯一兜底。
    // 键既可能写在 t(…) 里，也可能写在模块级的表里（xform 的 FIELDS、textures 的 ACTIONS），
    // 所以按「形如键的字符串字面量」扫，而不是只扫 t( 的第一个参数。
    let total = 0;
    for (const name of PANELS) {
        const src = await panelSource(name);
        const used = new Set([...src.matchAll(/['"]([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+)['"]/g)].map((m) => m[1]));
        for (const k of used) {
            if (!/^(props|pref|xform)\./.test(k)) continue;
            total += 1;
            assert.ok(has(k), name + ' 用了词典里没有的键：' + k);
        }
    }
    assert.ok(total >= 100, '没扫到多少调用点，正则过期了？total=' + total);
});

test('源码不留中文原文：九个面板的注释以外没有汉字', async () => {
    for (const name of PANELS) {
        const src = stripComments(await panelSource(name));
        const hit = src.match(HAN);
        assert.equal(hit, null, name + ' 还留着中文原文：' + (hit ? src.slice(Math.max(0, hit.index - 60), hit.index + 40) : ''));
    }
});

test('t() 调用不带中文第二参（回退原文一律不进源码）', async () => {
    for (const name of PANELS) {
        const src = await panelSource(name);
        const bad = [...src.matchAll(/\b(?:t|tr)\('([^']+)',\s*'([^']*)'/g)].filter((m) => HAN.test(m[2]));
        assert.equal(bad.length, 0, name + ' 里有带回退原文的调用：' + (bad[0] ? bad[0][0] : ''));
    }
});

/* ─────────────────────────── 渲染 ─────────────────────────── */

test('整句成条：拼接句渲染出来与迁移前逐字一致', () => {
    const prev = getLocale();
    try {
        setLocale('zh-Hans');
        assert.equal(t('props.tex.summary.count', { count: 2, k: 1, exposures: 3 }), '共 2 张 · 当前第 1 张 · 曝光 3 处');
        assert.equal(t('props.tex.summary.noExposure', { count: 1, exposures: 1 }), '共 1 张 · 曝光 1 处 · 当前时刻没有曝光');
        assert.equal(t('props.kit.wide', { label: '尺寸' }), '尺寸（宽）');
        assert.equal(t('props.kit.segTitle', { label: '间隔', option: '30s' }), '间隔：30s');
        assert.equal(t('props.doc.timebase.segIndex', { i: 1, n: 2 }), '（第 1/2 段）');
        assert.equal(t('xform.warp.densityTitle', { cols: 4, rows: 2, n: 15 }), '4×2 网格（15 个顶点）');
        assert.equal(t('xform.corner.title', { corner: '左上', axis: 'X' }), '左上角 X 偏移（像素）');
        // 前导空格是排版用的：数字后面紧接空格，再跟单位
        assert.equal(t('xform.keys.count', { n: 3, t: '0.50' }), '3 颗关键帧 · 当前 t=0.50s');
    } finally {
        setLocale(prev);
    }
});

test('title 与 aria-label 共用的那句是整条词条（五个并列名词都在里面）', () => {
    const prev = getLocale();
    try {
        setLocale('zh-Hans');
        assert.equal(
            t('props.obj.parentLink', { name: '组 A' }),
            '跳到父对象「组 A」：该对象跟随父对象的时间通道、不透明度、显示、混合模式与变换',
        );
        setLocale('en');
        assert.equal(
            t('props.obj.parentLink', { name: 'Group A' }),
            'Jump to the parent "Group A": this object follows the parent timing, opacity, visibility, blend mode and transform',
        );
        // 变量名写错时原样保留占位符，不悄悄吞掉（与 i18n 模块的约定一致；取的是当前语言的文案）
        assert.equal(t('props.obj.parentLink', { nm: 'x' }), EN['props.obj.parentLink']);
    } finally {
        setLocale(prev);
    }
});

test('术语统一：纹理区的中文不出现「画格」', () => {
    for (const k of KEYS) {
        if (!k.startsWith('props.tex.')) continue;
        assert.ok(!/画格/.test(ZH[k]), k + ' 用了「画格」：' + ZH[k]);
    }
});

test('纹理抽屉：新增条目两表齐全（列表 / 当前 / 未使用 / 两步删除 / 行数据）', () => {
    const added = [
        'props.tex.lib',
        'props.tex.lib.at',
        'props.tex.lib.confirm',
        'props.tex.lib.confirmTitle',
        'props.tex.lib.current',
        'props.tex.lib.delete',
        'props.tex.lib.deleteTitle',
        'props.tex.lib.hide',
        'props.tex.lib.rowAria',
        'props.tex.lib.rowCurrentAria',
        'props.tex.lib.show',
        'props.tex.lib.timesTitle',
        'props.tex.lib.toggleTitle',
        'props.tex.lib.unused',
        'props.tex.lib.unusedTitle',
        'props.tex.lib.usesAt',
        'props.tex.say.deleted',
        'props.tex.say.deletedFail',
        'props.tex.say.placed',
        'props.tex.say.placedFail',
    ];
    for (const k of added) {
        assert.ok(has(k), '运行期词典里没有抽屉词条：' + k);
        assert.equal(typeof EN[k], 'string');
        assert.equal(typeof ZH[k], 'string');
        assert.ok(EN[k].trim().length > 0 && ZH[k].trim().length > 0, k + ' 的两表文案不能为空');
    }
});

test('纹理抽屉：行引用与行 aria 按整句取词，占位符都填得上', () => {
    const prev = getLocale();
    try {
        setLocale('zh-Hans');
        // 未使用 / 单处 / 多处：与 textureRowRef 的三条分支一一对应
        assert.equal(t('props.tex.lib.unused'), '未使用');
        assert.equal(t('props.tex.lib.at', { t: '0.00' }), '@0.00s');
        assert.equal(t('props.tex.lib.usesAt', { t: '0.00', n: 2 }), '@0.00s · 2 处');
        assert.equal(
            t('props.tex.lib.rowAria', { index: 2, size: '40 × 40' }),
            '第 2 张纹理（40 × 40）。点一下放到当前时刻',
        );
        assert.equal(t('props.tex.lib.confirm'), '确认？');
        assert.equal(t('props.tex.lib.show'), '展开列表');
        setLocale('en');
        assert.equal(t('props.tex.lib.unused'), 'Unused');
        assert.equal(t('props.tex.lib.usesAt', { t: '1.50', n: 3 }), '@1.50s · 3 uses');
        assert.equal(
            t('props.tex.lib.rowCurrentAria', { index: 1, size: '8 × 8' }),
            'Texture #1 (8 × 8) is showing at the current time',
        );
        assert.equal(t('props.tex.lib.hide'), 'Hide list');
        // 两句都必须是整条词条：占位符全被替换，界面不会残留 {x}
        for (const text of [t('props.tex.lib.timesTitle', { times: '0.00s, 1.50s' }), t('props.tex.lib.toggleTitle')]) {
            assert.ok(!/\{\w+\}/.test(text), '词条里还有没替换的占位符：' + text);
        }
    } finally {
        setLocale(prev);
    }
});

/* ─────────────────────────── 存档纯净性 ─────────────────────────── */

test('偏好项的落盘值（第一列）一个字都没动', async () => {
    const src = await panelSource('prop-prefs.mjs');
    const values = new Set([...src.matchAll(/\[\s*'([^']+)'\s*,/g)].map((m) => m[1]));
    for (const v of ['0', '30', '60', '300', '50', '100', '200', '500', '0.05', '0.1', '0.25', '320', '640', '900', 'custom', 'checker', 'dark', 'white', 'en', 'zh-Hans']) {
        assert.ok(values.has(v), '偏好项落盘值不见了：' + v);
    }
});

test('.msp 里 kind 仍是 paint/image，译文与键一个字都不进档', () => {
    const doc = createDoc({
        width: 8,
        height: 8,
        fps: 10,
        objects: [makeObject({ id: 'obj-1', name: 'obj' })],
    });
    const saved = docToFile(doc, { name: 'props', savedAt: 1 });
    const el = saved.elements[0];

    assert.equal(el.kind, 'paint', 'kind 是落盘值，必须原样保留');
    const blob = JSON.stringify(saved);
    for (const k of KEYS) {
        assert.ok(!blob.includes(k), '词条键进了存档：' + k);
    }
    for (const label of Object.values(EN)) {
        if (label.length < 6) continue; // 太短的英文（W / H / Apply）会撞上路径与字段名，不参与
        assert.ok(!blob.includes(label), '英文译文进了存档：' + label);
    }
    assert.ok(!HAN.test(blob), '存档里出现了中文译文：' + (blob.match(HAN) || []));
});
