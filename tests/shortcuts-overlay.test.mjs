import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createShortcutGroups, groupsFromCommands } from '../app/shell/shortcuts-overlay.mjs';
import { overlayGroups, SHORTCUT_GROUPS } from '../app/editors/help.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('createShortcutGroups：按结构过滤空组、空条目，并补默认组名', () => {
    const g = createShortcutGroups({
        groups: [
            { title: '文件', items: [{ keys: 'Ctrl+S', title: '保存' }, null, { title: '' }] },
            { items: [{ keys: 'A', title: '无标题组' }] },
            { title: '空组', items: [] },
            null,
        ],
    });
    assert.equal(g.length, 2);
    assert.equal(g[0].title, '文件');
    assert.equal(g[0].items.length, 1);
    assert.equal(g[1].title, '其它');
    assert.equal(g[1].items[0].hint, '');
});

test('createShortcutGroups：非法入参返回空数组', () => {
    assert.deepEqual(createShortcutGroups(), []);
    assert.deepEqual(createShortcutGroups(null), []);
    assert.deepEqual(createShortcutGroups({ groups: 'x' }), []);
});

test('groupsFromCommands：只收带快捷键的命令，并按组归并', () => {
    const groups = groupsFromCommands([
        { title: '保存', keys: 'Ctrl+S', group: '文件', hint: '写到当前存档' },
        { title: '打开', keys: 'Ctrl+O', group: '文件' },
        { title: '播放', keys: 'Space', group: '播放' },
        { title: '没有键的命令', keys: '', group: '文件' },
        { title: '空白键命令', keys: '   ', group: '文件' },
    ]);
    assert.equal(groups.length, 2);
    assert.equal(groups[0].title, '文件');
    assert.deepEqual(groups[0].items.map((i) => i.keys), ['Ctrl+S', 'Ctrl+O']);
    assert.equal(groups[0].items[0].hint, '写到当前存档');
    assert.equal(groups[1].title, '播放');
});

test('groupsFromCommands：缺 group 归到「其它」，非数组返回空', () => {
    const groups = groupsFromCommands([{ title: '某命令', keys: 'X' }]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].title, '其它');
    assert.deepEqual(groupsFromCommands(null), []);
    assert.deepEqual(groupsFromCommands({}), []);
});

test('groupsFromCommands：忽略脏条目', () => {
    const groups = groupsFromCommands([null, 42, { keys: 'A' }, { title: 'ok', keys: 'B', group: 'G' }]);
    assert.equal(groups.length, 2, '空标题也会进组（keys 存在就算一条）');
    assert.equal(groups[1].items[0].title, 'ok');
});

test('overlayGroups：把 SHORTCUT_GROUPS 原样搬成浮层 spec', () => {
    const groups = overlayGroups();
    // 标题跟着数据源走（拆组时会变），这里只钉「浮层与数据源逐组对应」；
    // 顺序与 id 由 icons.test.mjs 的 id 序列断言负责，不重复钉中文文案。
    assert.deepEqual(groups.map((g) => g.title), SHORTCUT_GROUPS.map((g) => g.title), '浮层分组标题要与数据源一致');
    assert.equal(groups.length, SHORTCUT_GROUPS.length);
    let rows = 0;
    for (const g of groups) {
        assert.ok(g.items.length > 0, '每组至少一行：' + g.title);
        for (const it of g.items) {
            rows += 1;
            assert.ok(it.title, '条目必须有动作名');
            assert.ok(it.keys, '条目必须有键位（缺省兜「鼠标」）');
            assert.equal(it.icon, undefined, '浮层列表不吃 icon，映射时要丢掉');
        }
    }
    // 行数不硬编码成 35：以 help 表自身为准（今天加一行明天删一行都不用同步改数字），
    // 再兜一个松下界防「表被削空」。零余量断言会把正常的表维护变成假红。
    const expectedRows = SHORTCUT_GROUPS.reduce((n, g) => n + g.items.length, 0);
    assert.equal(rows, expectedRows, '浮层行数必须与 help 表逐条对应');
    assert.ok(expectedRows >= 30, '帮助表被削空了？：' + expectedRows);
    // 缺 keys / hint 的条目要有兜底，浮层才不会出现空键位列
    const soft = overlayGroups([{ title: 'G', items: [{ name: '拖拽' }] }]);
    assert.equal(soft[0].items[0].keys, '鼠标');
    assert.equal(soft[0].items[0].hint, '');
});

test('浮层只读 help.mjs 那一份：app.mjs 不再从命令表派生', () => {
    const app = read('../app/shell/app.mjs');
    assert.match(app, /import \{ overlayGroups \} from '\.\.\/editors\/help\.mjs'/, 'app.mjs 要从 help.mjs 取浮层数据');
    assert.match(app, /createShortcutsOverlay\(\{ groups: overlayGroups\(\) \}\)/, '浮层要用 overlayGroups()');
    assert.ok(!/groupsFromCommands\(/.test(app), 'app.mjs 不许再从命令表派生浮层');
    assert.ok(!/title: '全局'/.test(app), "手补的「全局」组应已并入 help 表");
});

test('help 表接住了原来手补的全局键位', () => {
    const keys = SHORTCUT_GROUPS.flatMap((g) => g.items.map((i) => i.keys));
    for (const k of ['Ctrl+Shift+P', 'Esc', '↑ / ↓', 'Shift+拖', 'Ctrl+滚轮']) {
        assert.ok(keys.includes(k), 'help 表缺键位：' + k);
    }
});
