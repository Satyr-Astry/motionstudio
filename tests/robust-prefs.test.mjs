import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FALLBACK_PREFS, cleanPrefs } from '../app/core/prefs.mjs';

/*
 * 偏好清洗：ms.prefs 允许手改、也会被旧版本或第三方写坏，
 * 一个坏值进去以后面板看着正常、行为却全错。这里钉住「逐项退回缺省」。
 */

const SIZE = { width: 900, height: 640 };

test('空输入 / 非对象输入都拿到完整缺省值', () => {
    for (const raw of [null, undefined, 0, '', 'x', 42, [], true]) {
        const p = cleanPrefs(raw);
        assert.deepEqual(p, FALLBACK_PREFS, '输入 ' + JSON.stringify(raw) + ' 应退回缺省');
    }
});

test('未知键一律丢掉，不会混进快照', () => {
    const p = cleanPrefs({ undoLimit: 200, evil: 'x', __proto__: { hacked: 1 } });
    assert.deepEqual(Object.keys(p).sort(), ['autoSave', 'bg', 'objectH', 'objectW', 'snapGrid', 'undoLimit']);
    assert.equal(p.undoLimit, 200);
    assert.equal(p.evil, undefined);
});

test('范围夹取：undoLimit 上限 2000、autoSave 0..3600、snapGrid 0..10', () => {
    assert.equal(cleanPrefs({ undoLimit: 99999 }).undoLimit, 2000);
    assert.equal(cleanPrefs({ autoSave: -1 }).autoSave, 0);
    assert.equal(cleanPrefs({ autoSave: 86400 }).autoSave, 3600);
    assert.equal(cleanPrefs({ snapGrid: -3 }).snapGrid, 0);
    assert.equal(cleanPrefs({ snapGrid: 500 }).snapGrid, 10);
});

test('要求正值的字段：0 与负数退回缺省（不夹到下限 —— 1 步撤销、1×1 对象都更糟）', () => {
    assert.equal(cleanPrefs({ undoLimit: 0 }).undoLimit, FALLBACK_PREFS.undoLimit);
    assert.equal(cleanPrefs({ undoLimit: -5 }).undoLimit, FALLBACK_PREFS.undoLimit);
    assert.equal(cleanPrefs({ objectW: 0 }).objectW, FALLBACK_PREFS.objectW);
    assert.equal(cleanPrefs({ objectH: -100 }).objectH, FALLBACK_PREFS.objectH);
    assert.equal(cleanPrefs({ undoLimit: 1 }).undoLimit, 1);
});

test('对象尺寸上限 4096：1e9 被夹住，边界值 1 与 4096 都保留', () => {
    assert.equal(cleanPrefs({ objectW: 1e9 }).objectW, 4096);
    assert.equal(cleanPrefs({ objectH: 1e9 }).objectH, 4096);
    assert.equal(cleanPrefs({ objectW: 1 }).objectW, 1);
    assert.equal(cleanPrefs({ objectW: 4096 }).objectW, 4096);
});

test('非数字退回缺省（不是变成 0，也不是 NaN）', () => {
    for (const bad of ['abc', '', {}, [], NaN, Infinity]) {
        const p = cleanPrefs({ undoLimit: bad, objectW: bad, snapGrid: bad });
        assert.equal(p.undoLimit, FALLBACK_PREFS.undoLimit, 'undoLimit=' + String(bad));
        assert.equal(p.objectW, FALLBACK_PREFS.objectW, 'objectW=' + String(bad));
        assert.equal(p.snapGrid, FALLBACK_PREFS.snapGrid, 'snapGrid=' + String(bad));
    }
});

test('数字字符串按数字收（手改存档里的 "200" 是合法写法）', () => {
    assert.equal(cleanPrefs({ undoLimit: '200' }).undoLimit, 200);
    assert.equal(cleanPrefs({ objectW: '1280' }).objectW, 1280);
});

test('对象尺寸 1..4096：0 与 1e9 都被挡住', () => {
    assert.equal(cleanPrefs({ objectW: 0 }).objectW, FALLBACK_PREFS.objectW);
    assert.equal(cleanPrefs({ objectW: -100 }).objectW, FALLBACK_PREFS.objectW);
    assert.equal(cleanPrefs({ objectW: 1e9 }).objectW, 4096);
    assert.equal(cleanPrefs({ objectH: 1e9 }).objectH, 4096);
    assert.equal(cleanPrefs({ objectW: 1 }).objectW, 1);
});

test('bg 只收小写标识符，其它（含数字、对象、超长串）退回 checker', () => {
    assert.equal(cleanPrefs({ bg: 'dark' }).bg, 'dark');
    assert.equal(cleanPrefs({ bg: 'checker' }).bg, 'checker');
    for (const bad of [123, null, {}, [], 'Dark', 'a b', 'x'.repeat(40), '<script>']) {
        assert.equal(cleanPrefs({ bg: bad }).bg, FALLBACK_PREFS.bg, 'bg=' + JSON.stringify(bad));
    }
});

test('可以传自定义缺省值（外壳用它注入真实文档尺寸）', () => {
    const dflt = { ...FALLBACK_PREFS, objectW: SIZE.width, objectH: SIZE.height };
    const p = cleanPrefs({}, dflt);
    assert.equal(p.objectW, 900);
    assert.equal(p.objectH, 640);
    // 缺省值本身不做范围校验（那是调用方的事），只用于「坏值退回哪」
    assert.equal(cleanPrefs({ objectW: 'bad' }, dflt).objectW, 900);
});

test('小数会被取整的字段保持整数，snapGrid 保留小数', () => {
    assert.equal(cleanPrefs({ undoLimit: 120.7 }).undoLimit, 121);
    assert.equal(cleanPrefs({ snapGrid: 0.05 }).snapGrid, 0.05);
});

test('旧键迁移：只有 sizeW/sizeH 的偏好文件仍能读出对象尺寸', () => {
    const p = cleanPrefs({ sizeW: 640, sizeH: 480 });
    assert.equal(p.objectW, 640);
    assert.equal(p.objectH, 480);
    // 旧键坏值同样退回缺省，不会变成 0 或下限
    assert.equal(cleanPrefs({ sizeW: 'abc' }).objectW, FALLBACK_PREFS.objectW);
    assert.equal(cleanPrefs({ sizeW: 0 }).objectW, FALLBACK_PREFS.objectW);
});

test('新键优先：两套键同时存在时以 objectW/objectH 为准', () => {
    assert.equal(cleanPrefs({ objectW: 640, sizeW: 800 }).objectW, 640);
    assert.equal(cleanPrefs({ objectH: 480, sizeH: 900 }).objectH, 480);
    // 新键坏值不能挡住旧键：objectW 不是数字时退回 sizeW
    assert.equal(cleanPrefs({ objectW: '', sizeW: 640 }).objectW, 640);
    assert.equal(cleanPrefs({ objectW: null, sizeW: 640 }).objectW, 640);
});
