/**
 * 效果与类型名的词条化（i18n P1-C：`app/i18n/parts/effects.mjs` + `app/paint/effects.mjs`）。
 *
 * 这一片与其他面板不同：被词条化的是**一张被 Object.freeze 冻住的常量表**，而且它的
 * `type` / 参数名本身就是落盘值（参数级轨道直接挂在 `layer.effects[i].tracks[参数名]`）。
 * 所以这里的断言集中在四件事：
 *
 * 1. 定义表里只留键、不留中文 —— 译文只有词典一份（切语言时不改冻住的常量）；
 * 2. 键由 id + 参数名**派生**，且两种语言都查得到（漏翻在测试里先炸，不靠运行期回退）；
 * 3. 冻结没有为了本地化被拆掉（外部仍然改不动）；
 * 4. .msp 里只有 `type` + 标量 + `id` + `tracks`：键与译文一个字都不许进存档。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import effectsPart from '../app/i18n/parts/effects.mjs';
import { EFFECT_DEFS, defaultEffect } from '../app/paint/effects.mjs';
import { keysOf, dictOf, getLocale, setLocale, t } from '../app/i18n/index.mjs';
import { createDoc, makeObject } from '../app/core/doc-model.mjs';
import { docToFile } from '../app/shell/project-store.mjs';

const HAN = /[\u4e00-\u9fff]/;
const EN = effectsPart.en;
const ZH = effectsPart['zh-Hans'];

/** 定义表里出现的所有词条键（5 个显示名 + 13 个参数标签）。 */
function defKeys() {
    const out = [];
    for (const def of EFFECT_DEFS) {
        out.push(def.nameKey);
        for (const p of def.params) out.push(p.labelKey);
    }
    return out;
}

/* ─────────────────────────── 分片本身 ─────────────────────────── */

test('effects 分片：两种语言的键集合镜面，且没有空文案', () => {
    assert.deepEqual(Object.keys(ZH).sort(), Object.keys(EN).sort());
    for (const [k, v] of Object.entries(EN)) assert.equal(typeof v, 'string', k + ' 应是字符串');
    for (const [k, v] of Object.entries(EN)) assert.ok(v.length > 0, k + '（en）空文案');
    for (const [k, v] of Object.entries(ZH)) assert.ok(v.length > 0, k + '（zh-Hans）空文案');
});

test('effects 分片：en 表里没有汉字（漏翻会显示成另一种语言）', () => {
    for (const [k, v] of Object.entries(EN)) assert.ok(!HAN.test(v), k + ' 的英文里混进了汉字：' + v);
});

test('effects 分片已注册进运行期词典（不是只有文件躺着）', () => {
    const dictKeys = new Set(keysOf('en'));
    for (const k of [...defKeys(), 'kind.paint', 'kind.image', ...Object.keys(EN)]) {
        assert.ok(dictKeys.has(k), k + ' 没有合并进运行期词典');
    }
    assert.deepEqual(keysOf('en'), keysOf('zh-Hans'), '两份词典必须镜面');
});

/* ─────────────────────────── 定义表 ─────────────────────────── */

test('EFFECT_DEFS：键由 id / 参数名派生，两种语言都查得到', () => {
    for (const def of EFFECT_DEFS) {
        assert.equal(def.nameKey, 'effect.' + def.id + '.name');
        for (const [lang, table] of [['en', EN], ['zh-Hans', ZH]]) {
            const name = table[def.nameKey];
            assert.equal(typeof name, 'string', def.id + ' 在 ' + lang + ' 里缺显示名');
            assert.ok(name.length > 0, def.id + ' 在 ' + lang + ' 里显示名为空');
        }
        for (const p of def.params) {
            assert.equal(p.labelKey, 'effect.' + def.id + '.param.' + p.key);
            for (const [lang, table] of [['en', EN], ['zh-Hans', ZH]]) {
                assert.equal(typeof table[p.labelKey], 'string', def.id + '.' + p.key + ' 在 ' + lang + ' 里缺标签');
            }
        }
    }
});

test('EFFECT_DEFS 里没有中文、也没有回退文案字段（译文只有词典一份）', () => {
    // 中文若留在定义里，既会被 _check-i18n 记一条「仍未走词条表」，也会让「同一对象随语言变两份数据」
    // 变得可能 —— 这正是 Object.freeze 想避免的。显示名一律现查词典。
    assert.ok(!HAN.test(JSON.stringify(EFFECT_DEFS)), '定义表里还有中文：' + JSON.stringify(EFFECT_DEFS).match(HAN));
    for (const def of EFFECT_DEFS) {
        assert.ok(!Object.prototype.hasOwnProperty.call(def, 'name'), def.id + ' 不该再带 name');
        for (const p of def.params) {
            assert.ok(!Object.prototype.hasOwnProperty.call(p, 'label'), def.id + '.' + p.key + ' 不该再带 label');
        }
    }
});

test('EFFECT_DEFS 的数据结构没被词条化改动（type / 参数名 / 默认值 / 范围）', () => {
    for (const def of EFFECT_DEFS) {
        assert.equal(typeof def.id, 'string', 'id 就是落盘的 type，不能变');
        assert.ok(def.params.length > 0, def.id + ' 缺 params');
        for (const p of def.params) {
            assert.equal(typeof p.key, 'string', def.id + ' 的参数名就是落盘的字段名');
            assert.ok('def' in p, def.id + '.' + p.key + ' 缺默认值');
            if (p.color) {
                assert.equal(typeof p.def, 'string');
            } else {
                assert.equal(typeof p.min, 'number');
                assert.equal(typeof p.max, 'number');
                assert.equal(typeof p.step, 'number');
                assert.ok(p.def >= p.min && p.def <= p.max, def.id + '.' + p.key + ' 默认值越界');
            }
        }
        // 效果实例仍是扁平的 { type, ...参数 }（存档同构），没有因为加键而多包一层 params
        const fx = defaultEffect(def.id);
        assert.equal(fx.type, def.id);
        assert.equal(Object.prototype.hasOwnProperty.call(fx, 'params'), false, def.id + ' 的实例不该多出 params 层');
        for (const p of def.params) assert.equal(fx[p.key], p.def, def.id + '.' + p.key + ' 的默认值该落在实例上');
    }
});

test('EFFECT_DEFS 仍然冻结（本地化没有拆掉 freeze）', () => {
    assert.ok(Object.isFrozen(EFFECT_DEFS));
    for (const def of EFFECT_DEFS) {
        assert.ok(Object.isFrozen(def), def.id + ' 应冻结');
        assert.ok(Object.isFrozen(def.params), def.id + '.params 应冻结');
        for (const p of def.params) assert.ok(Object.isFrozen(p), def.id + '.' + p.key + ' 应冻结');
    }
    // 严格模式下写冻结对象会抛；不抛就说明 freeze 形同虚设
    assert.throws(() => { EFFECT_DEFS[0].nameKey = 'effect.other.name'; }, TypeError);
    assert.throws(() => { EFFECT_DEFS[0].params[0].labelKey = 'effect.other.param.x'; }, TypeError);
});

/* ─────────────────────────── 显示与切语言 ─────────────────────────── */

test('t()：切语言后同一条键给出各自语言的效果名与标签', () => {
    const prev = getLocale();
    try {
        setLocale('zh-Hans');
        assert.equal(t('effect.blur.name'), '模糊');
        assert.equal(t('effect.blur.param.amount'), '模糊半径');
        assert.equal(t('effect.adjust.param.hue'), '色相');
        assert.equal(t('kind.paint'), '手绘');
        setLocale('en');
        assert.equal(t('effect.blur.name'), 'Blur');
        assert.equal(t('effect.blur.param.amount'), 'Radius');
        assert.equal(t('effect.adjust.param.hue'), 'Hue');
        assert.equal(t('kind.image'), 'Image');
        // 切回来之后每个键都还查得到（缺条目会回退成键名本身）
        for (const k of defKeys()) assert.notEqual(t(k), k, k + ' 查不到译文，回退成了键名');
    } finally {
        setLocale(prev);
    }
});

test('t()：效果区的占位符句子按变量拼，不是拼中文片段', () => {
    const prev = getLocale();
    try {
        setLocale('zh-Hans');
        assert.equal(t('effect.ui.add', { name: t('effect.blur.name') }), '给当前对象加一个模糊');
        assert.equal(t('effect.ui.remove', { name: t('effect.shadow.name') }), '移除投影');
        setLocale('en');
        assert.equal(t('effect.ui.add', { name: t('effect.blur.name') }), 'Add Blur to the selected object');
        // 变量名写错时原样保留占位符，不悄悄吞掉（与 i18n 模块的约定一致）
        assert.equal(t('effect.ui.add', { nm: 'Blur' }), 'Add {name} to the selected object');
    } finally {
        setLocale(prev);
    }
});

test('prop-object 里写死的 effect / kind 键都在词典里（调用点覆盖）', async () => {
    // 渲染处的键是变量（def.nameKey / param.labelKey），静态扫不到；但界面文案是字面量，
    // 扫一遍能挡住「改了键名忘了改分片」这类手误。
    // 这里只管本分片的前缀：prop-object 的属性类文案（props.obj.*）属于 props 分片，
    // 由 tests/i18n-parts-props.test.mjs 的调用点覆盖断言兜底。
    const { readFile } = await import('node:fs/promises');
    const src = await readFile(new URL('../app/editors/prop-object.mjs', import.meta.url), 'utf8');
    const used = [...new Set([...src.matchAll(/\bt\('([^']+)'/g)].map((m) => m[1]))]
        .filter((k) => k.startsWith('effect.') || k.startsWith('kind.'));
    assert.ok(used.length > 0, '没扫到 t(...) 调用点，正则过期了？');
    for (const k of used) {
        assert.ok(EN[k] !== undefined, 'prop-object.mjs 用了词典里没有的键：' + k);
        assert.ok(ZH[k] !== undefined, 'prop-object.mjs 用的键缺中文：' + k);
    }
});

/* ─────────────────────────── 存档纯净性 ─────────────────────────── */

test('.msp 的效果数组只有 type + 标量 + id + tracks，译文与键一个字都不进档', () => {
    const effects = EFFECT_DEFS.map((def) => Object.assign(defaultEffect(def.id), { id: 'fx-' + def.id }));
    const doc = createDoc({
        width: 8,
        height: 8,
        fps: 10,
        objects: [makeObject({ id: 'obj-1', name: '对象 1', effects })],
    });
    const saved = docToFile(doc, { name: '效果', savedAt: 1 });
    const json = saved.elements[0].effects;

    assert.equal(json.length, EFFECT_DEFS.length, '五类效果都该落盘');
    const allowed = new Set(['type', 'id', 'tracks']);
    for (const def of EFFECT_DEFS) {
        for (const p of def.params) allowed.add(p.key);
    }

    const blob = JSON.stringify(json);
    for (const fx of json) {
        assert.ok(typeof fx.type === 'string' && fx.type.length > 0, 'type 必须落盘（渲染靠它）');
        for (const k of Object.keys(fx)) {
            assert.ok(allowed.has(k), '存档里冒出了非数据字段：' + k);
        }
    }
    // 词条键与译文都不许出现在存档里 —— 换语言不能改变文件
    assert.ok(!blob.includes('nameKey'), 'nameKey 进了存档');
    assert.ok(!blob.includes('labelKey'), 'labelKey 进了存档');
    assert.ok(!blob.includes('effect.'), '词条键进了存档');
    assert.ok(!HAN.test(blob), '存档里出现了中文：' + (blob.match(HAN) || []));
    for (const label of Object.values(EN)) {
        assert.ok(!blob.includes(label), '英文译文进了存档：' + label);
    }
    for (const label of Object.values(ZH)) {
        assert.ok(!blob.includes(label), '中文译文进了存档：' + label);
    }
    // 反面校准：这条测试本身得能看到东西
    assert.ok(Object.keys(dictOf('zh-Hans')).length > 0);
});
