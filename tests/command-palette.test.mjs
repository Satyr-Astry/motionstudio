/**
 * 命令面板的纯函数测试（不测 DOM：仓库没装 jsdom，DOM 行为靠人工验收）。
 *
 * 覆盖：空查询保序、大小写无关、子串优先于子序列、hint / group 命中、
 * 无匹配、禁用项后置、超长查询、同分稳定排序、scoreCommand 的数值契约、
 * 入参不被修改。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { filterCommands, scoreCommand } from '../app/shell/command-palette.mjs';

/** 造一条命令：默认 title = id，便于用 id 断言顺序。 */
const cmd = (id, extra) => Object.assign({ id, title: id }, extra || {});

const ids = (list) => list.map((item) => item.id);

test('filterCommands：空查询返回全部并保持传入顺序', () => {
    const list = [
        cmd('file.save', { title: '保存项目', group: '文件' }),
        cmd('edit.undo', { title: '撤销', group: '编辑' }),
        cmd('view.zoom', { title: '放大', group: '视图' }),
        cmd('play', { title: '播放 / 暂停', group: '播放' }),
        cmd('export.png', { title: '导出 PNG', group: '导出' }),
    ];
    assert.deepEqual(ids(filterCommands(list, '')), ids(list));
    // 纯空白视同空查询，同样保序
    assert.deepEqual(ids(filterCommands(list, '   ')), ids(list));
    // 空查询返回副本，调用方排序不会污染原数组
    const all = filterCommands(list, '');
    assert.notEqual(all, list);
    all.reverse();
    assert.deepEqual(ids(list), ['file.save', 'edit.undo', 'view.zoom', 'play', 'export.png']);
});

test('filterCommands：标题匹配大小写无关', () => {
    const list = [
        cmd('a', { title: 'Save Project' }),
        cmd('b', { title: 'Export PNG' }),
    ];
    assert.deepEqual(ids(filterCommands(list, 'SAVE')), ['a']);
    assert.deepEqual(ids(filterCommands(list, 'save proj')), ['a']);
    assert.deepEqual(ids(filterCommands(list, 'ExPoRt')), ['b']);
});

test('filterCommands：连续子串排在连续子序列之前', () => {
    const subseq = cmd('subseq', { title: 'Save' }); // s…v 只能是子序列
    const substring = cmd('substring', { title: 'SVG Export' }); // 'sv' 是连续子串
    assert.deepEqual(ids(filterCommands([subseq, substring], 'sv')), ['substring', 'subseq']);
    assert.ok(
        scoreCommand(substring, 'sv') > scoreCommand(subseq, 'sv'),
        '子串分数必须高于子序列',
    );
});

test('filterCommands：hint 命中也能搜到', () => {
    const list = [
        cmd('a', { title: '打开面板', hint: 'Ctrl+Shift+P' }),
        cmd('b', { title: '导出 PNG', hint: '把当前帧写成图片' }),
    ];
    assert.deepEqual(ids(filterCommands(list, 'ctrl+shift+p')), ['a']);
    assert.deepEqual(ids(filterCommands(list, '写成图片')), ['b']);
    assert.ok(scoreCommand(list[0], 'ctrl+shift+p') > 0);
});

test('filterCommands：group 命中也能搜到（组名参与匹配）', () => {
    const list = [
        cmd('a', { title: 'PNG 序列', group: '导出' }), // 标题里没有「导出」，只有组名有
        cmd('b', { title: '撤销', group: '编辑' }),
    ];
    assert.deepEqual(ids(filterCommands(list, '导出')), ['a']);
    assert.ok(scoreCommand(list[0], '导出') > 0);
});

test('filterCommands：无匹配返回空数组', () => {
    const list = [cmd('a', { title: '保存项目' }), cmd('b', { title: '导出 PNG' })];
    assert.deepEqual(filterCommands(list, 'zzzz'), []);
    assert.deepEqual(filterCommands(list, '保存 项目 导出'), []);
    assert.deepEqual(filterCommands([], 'save'), []);
});

test('filterCommands：enabled=false 仍可搜到，但排在同等命中之后', () => {
    const off = { id: 'off', title: '导出 PNG', enabled: false };
    const on = { id: 'on', title: '导出 PNG', enabled: true };
    // 传入顺序故意把禁用的放前面：排序必须把它压到后面
    const out = filterCommands([off, on], '导出');
    assert.deepEqual(ids(out), ['on', 'off']);
    assert.equal(out.length, 2, '禁用的命令不能被过滤掉');
    assert.equal(scoreCommand(off, '导出'), scoreCommand(on, '导出') - 1);
    // 缺省 enabled 视作 true
    assert.equal(scoreCommand({ id: 'x', title: '导出 PNG' }, '导出'), scoreCommand(on, '导出'));
});

test('filterCommands：超长查询不崩、不误命中', () => {
    const list = [cmd('a', { title: '保存项目' }), cmd('b', { title: '导出 PNG' })];
    assert.deepEqual(filterCommands(list, 'x'.repeat(50000)), []);
    assert.deepEqual(filterCommands(list, '啊'.repeat(10000)), []);
    // 超长但等长的自我匹配仍然算命中，且耗时是线性的
    const longTitle = 'a'.repeat(5000);
    const hit = filterCommands([cmd('long', { title: longTitle })], longTitle);
    assert.deepEqual(ids(hit), ['long']);
});

test('filterCommands：同分时保持传入原顺序', () => {
    const list = [
        cmd('a', { title: '保存文件' }),
        cmd('b', { title: '保存' }), // 越短越紧凑，分数更高，插到最前
        cmd('c', { title: '保存文件' }),
        cmd('d', { title: '保存文件' }),
    ];
    const out = filterCommands(list, '保存');
    assert.deepEqual(ids(out), ['b', 'a', 'c', 'd']);
    // a / c / d 三条同分，相对次序不动
    assert.equal(scoreCommand(list[0], '保存'), scoreCommand(list[2], '保存'));
    assert.equal(scoreCommand(list[2], '保存'), scoreCommand(list[3], '保存'));
});

test('scoreCommand：数值契约（空查询 / 未命中 / 非法入参 / 字段权重）', () => {
    assert.equal(scoreCommand({ id: 'a', title: '保存' }, ''), 0, '空查询不参与排名');
    assert.equal(scoreCommand({ id: 'a', title: '保存' }, '   '), 0);
    assert.equal(scoreCommand({ id: 'a', title: '保存' }, 'zz'), 0, '未命中返回 0');
    assert.equal(scoreCommand(null, 'a'), 0);
    assert.equal(scoreCommand(undefined, 'a'), 0);
    assert.equal(scoreCommand('not-an-object', 'a'), 0);

    const inTitle = scoreCommand({ id: 'a', title: '保存' }, '保存');
    const inGroup = scoreCommand({ id: 'b', title: 'x', group: '保存' }, '保存');
    const inHint = scoreCommand({ id: 'c', title: 'x', hint: '保存' }, '保存');
    assert.ok(inTitle > inGroup && inGroup > inHint, '标题 > 组名 > hint');
    assert.ok(inTitle > 0 && inGroup > 0 && inHint > 0);

    // 分数恒为整数，方便给 UI 之外的地方做确定性断言
    for (const value of [inTitle, inGroup, inHint]) assert.ok(Number.isInteger(value));
    // 字段里的匹配位置越靠前分数越高
    assert.ok(
        scoreCommand({ id: 'p', title: '保存项目' }, '保存')
        > scoreCommand({ id: 'q', title: '项目保存' }, '保存'),
    );
});

test('filterCommands：过滤非对象条目且不修改入参', () => {
    const list = [
        cmd('b', { title: 'Abc' }),
        null,
        cmd('a', { title: 'abc' }),
        undefined,
        { id: 'c', title: 'abd' },
    ];
    const before = ids(list.filter(Boolean));
    const out = filterCommands(list, 'abc');
    assert.deepEqual(ids(out), ['b', 'a']); // 都是子串命中且同分，按传入顺序（b 在前）
    assert.deepEqual(ids(list.filter(Boolean)), before, '入参顺序与内容不得被改写');

    assert.deepEqual(filterCommands(null, 'abc'), []);
    assert.deepEqual(filterCommands(undefined, ''), []);
    assert.deepEqual(ids(filterCommands(list, '')), before, '空查询也丢掉非对象条目');
});
