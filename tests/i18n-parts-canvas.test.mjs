// `canvas` 分片（画布指针交互的提示与撤销标签）。
//
// 这一片很小，但守两条容易回潮的东西：
//   1. 两表镜面、英文表里没有汉字（否则英文界面会看到中文 toast）
//   2. `canvas-input.mjs` 里**不许再有中文字符串字面量** —— 它是唯一一个
//      「用户能手触到、却最容易漏迁」的文件（提示都是一次性的 notify）

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import canvasPart from '../app/i18n/parts/canvas.mjs';
import { keysOf, setLocale, t } from '../app/i18n/index.mjs';

const SRC = readFileSync(new URL('../app/editors/canvas-input.mjs', import.meta.url), 'utf8');
const en = canvasPart.en;
const zh = canvasPart['zh-Hans'];

test('两表键集合镜面，且都以 canvas. 开头', () => {
    assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
    for (const k of Object.keys(en)) assert.match(k, /^canvas\./, '键必须以 canvas. 开头：' + k);
    assert.ok(Object.keys(en).length >= 8, '这一片至少 8 条，实际 ' + Object.keys(en).length);
});

test('英文表没有汉字，中文表每一条都非空', () => {
    for (const [k, v] of Object.entries(en)) {
        assert.ok(v && !/[\u4e00-\u9fff]/.test(v), '英文表不该有汉字：' + k + ' = ' + v);
    }
    for (const [k, v] of Object.entries(zh)) assert.ok(v && v.length > 0, '中文表不许有空值：' + k);
});

test('这一片的键真的并进了运行期词典', () => {
    const merged = keysOf('en');
    for (const k of Object.keys(en)) assert.ok(merged.includes(k), k + ' 没并进词典（parts/index 注册了吗？）');
});

test('canvas-input.mjs 里没有中文字符串字面量了', () => {
    // 只看「引号里带中文」的行；注释里的中文是正常的
    const bad = SRC.split('\n').filter((line) => {
        const code = line.replace(/^\s*\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, '');
        return /'[^']*[\u4e00-\u9fff][^']*'/.test(code) || /"[^"]*[\u4e00-\u9fff][^"]*"/.test(code);
    });
    assert.deepEqual(bad, [], '还有硬编码中文：\n' + bad.join('\n'));
});

test('源码里出现的 canvas.* 键，词典里都有（防手写键名打错）', () => {
    const used = [...SRC.matchAll(/tr\('(canvas\.[a-zA-Z.]+)'/g)].map((m) => m[1]);
    assert.ok(used.length >= 8, '调用点太少：' + used.length + '（是不是漏迁了？）');
    for (const k of used) assert.ok(en[k], '源码用了 ' + k + '，但词典里没有');
});

test('切换语言后提示跟着变（词条不是写死的）', () => {
    const prev = setLocale('en');
    try {
        assert.ok(!/[\u4e00-\u9fff]/.test(t('canvas.anchor.done')), '英文下不该出现汉字');
        setLocale('zh-Hans');
        assert.match(t('canvas.anchor.done'), /[\u4e00-\u9fff]/, '中文下应当有汉字');
    } finally {
        setLocale(prev || 'en');
    }
});
