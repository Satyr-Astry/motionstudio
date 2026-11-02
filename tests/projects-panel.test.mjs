/**
 * 项目库面板的纯逻辑测试（tests/projects-panel.test.mjs）
 *
 * 只测能在 Node 里跑的部分：搜索过滤、计数文案、动作/菜单清单的形状与文案。
 * 不假装真机——DOM 渲染、点卡载入、菜单开合、三尺寸布局都在 CDP 侧量，
 * 那些断言写在这里只会变成「用 stub 骗自己」。
 *
 * 断言里刻意引用了 icons.mjs 的 ICON_NAMES：图标名写错时这里先红，
 * 而不是等到真机上看见一个空按钮。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CARD_ACTIONS, MENU_ITEMS, countLabel, filterRows, noResultText } from '../app/editors/projects.mjs';
import { ICON_NAMES } from '../app/core/icons.mjs';
import { DEFAULT_LOCALE, setLocale, t } from '../app/i18n/index.mjs';

/**
 * 在指定语言下跑一段断言，结束后一定切回缺省语言。
 *
 * 面板文案迁进词条后，期望值不能再写死中文：缺省语言是 en，中文只在 zh-Hans 下成立。
 * 用 try/finally 回切是为了不在用例之间留下语言状态——否则「谁先跑」会改变结果。
 */
function withLocale(id, fn) {
    setLocale(id);
    try {
        fn();
    } finally {
        setLocale(DEFAULT_LOCALE);
    }
}

const rows = [
    { id: 'a', name: '项目A' },
    { id: 'b', name: '项目B 草稿' },
    { id: 'c', name: 'Hero Walk' },
];

test('filterRows：空查询原样返回，且是同一个数组引用', () => {
    assert.equal(filterRows(rows, ''), rows);
    assert.equal(filterRows(rows, '   '), rows);
    assert.equal(filterRows(rows, null), rows);
    assert.equal(filterRows(rows, undefined), rows);
});

test('filterRows：按名字子串匹配，忽略大小写与首尾空白', () => {
    assert.deepEqual(filterRows(rows, '项目a').map((r) => r.id), ['a']);
    assert.deepEqual(filterRows(rows, '  项目  ').map((r) => r.id), ['a', 'b']);
    assert.deepEqual(filterRows(rows, 'hero').map((r) => r.id), ['c']);
    assert.deepEqual(filterRows(rows, 'WALK').map((r) => r.id), ['c']);
});

test('filterRows：没有匹配时返回空数组，不返回 null/undefined', () => {
    const out = filterRows(rows, '不存在的项目');
    assert.ok(Array.isArray(out));
    assert.equal(out.length, 0);
    // 无匹配文案是固定字符串，不能被上层悄悄改成空态 CTA 的那句
    withLocale('zh-Hans', () => {
        assert.equal(noResultText(), '没有匹配的项目');
    });
    withLocale('en', () => {
        assert.equal(noResultText(), 'No matching projects');
        // 两条文案必须不是同一句：否则「库里真没有项目」和「搜不到」又混了
        assert.notEqual(noResultText(), t('projects.empty'));
    });
});

test('filterRows：容忍脏记录（null / 缺 name / 非数组入参）', () => {
    const dirty = [null, { id: 'x' }, { id: 'y', name: null }, { id: 'z', name: '真名' }];
    assert.deepEqual(filterRows(dirty, '真').map((r) => r && r.id), ['z']);
    assert.deepEqual(filterRows(null, '任意'), []);
    assert.deepEqual(filterRows(undefined, ''), []);
    // name 为 null 的记录在空查询时也要保留（不能因为过滤把它丢掉）
    assert.equal(filterRows(dirty, '').length, 4);
});

test('countLabel：空库不出文案，有库给总数，有查询给「匹配 N / M」', () => {
    assert.equal(countLabel(0, 0, ''), '');
    withLocale('zh-Hans', () => {
        assert.equal(countLabel(3, 3, ''), '共 3 个');
        assert.equal(countLabel(3, 1, '项目a'), '匹配 1 / 3');
        // 有查询但一条都没匹配：仍然显示 0 / M，而不是空字符串
        assert.equal(countLabel(3, 0, 'zzz'), '匹配 0 / 3');
        assert.equal(countLabel(2, 2, '  '), '共 2 个');
    });
    // 换语言后同一个调用要跟着换表：词条是调用时取的，不是模块加载时烘死的
    withLocale('en', () => {
        assert.equal(countLabel(3, 3, ''), 'All 3 projects');
        assert.equal(countLabel(3, 1, '项目a'), 'Matched 1 / 3');
    });
});

test('CARD_ACTIONS：只剩重命名 / 存为文件 / 删除，删除是危险档', () => {
    assert.deepEqual(CARD_ACTIONS.map((a) => a.act), ['rename', 'export', 'delete']);
    withLocale('zh-Hans', () => {
        assert.deepEqual(CARD_ACTIONS.map((a) => a.label), ['重命名', '存为文件', '删除']);
    });
    // label/title 是访问器而非普通属性：否则 setLocale() 之后卡片还挂着旧语言
    withLocale('en', () => {
        assert.deepEqual(CARD_ACTIONS.map((a) => a.label), ['Rename', 'Save to file', 'Delete']);
        assert.deepEqual(CARD_ACTIONS.map((a) => a.title), [
            'Change the project name (double-clicking the card also works)',
            'Save as a .msp project file (legacy .json also works)',
            'Remove from the library (undo is available for 8 seconds)',
        ]);
    });
    // 卡片整块可点即载入，所以「载入」不该再作为一个按钮存在
    assert.ok(!CARD_ACTIONS.some((a) => a.act === 'open'));
    const del = CARD_ACTIONS.find((a) => a.act === 'delete');
    assert.equal(del.danger, true);
    assert.equal(CARD_ACTIONS.filter((a) => a.danger).length, 1);
});

test('CARD_ACTIONS：每条都有 title 与合法图标名', () => {
    for (const a of CARD_ACTIONS) {
        assert.ok(a.title && a.title.length > 0, a.act + ' 缺 title');
        assert.ok(ICON_NAMES.includes(a.icon), a.act + ' 的图标 ' + a.icon + ' 不存在');
    }
});

test('MENU_ITEMS：低频项全收进菜单，且「导入图片」被分隔线标为另一层级', () => {
    assert.deepEqual(MENU_ITEMS.map((a) => a.act), ['import', 'sheet', 'refresh', 'image']);
    // 这四项都不该再作为 head 上的平铺按钮出现
    assert.ok(!MENU_ITEMS.some((a) => a.act === 'new'));
    const img = MENU_ITEMS.find((a) => a.act === 'image');
    assert.equal(img.sepBefore, true);
    // 只有最后一项带分隔线（它不属于项目库，属于当前文档编辑）
    assert.equal(MENU_ITEMS.filter((a) => a.sepBefore).length, 1);
    for (const a of MENU_ITEMS) {
        assert.ok(a.title && a.title.length > 0, a.act + ' 缺 title');
        assert.ok(ICON_NAMES.includes(a.icon), a.act + ' 的图标 ' + a.icon + ' 不存在');
    }
});

test('图标名不重复：菜单与卡片动作不会撞同一个图标', () => {
    const all = [...MENU_ITEMS, ...CARD_ACTIONS].map((a) => a.icon);
    assert.equal(new Set(all).size, all.length);
});
