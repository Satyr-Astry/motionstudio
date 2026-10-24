import test from 'node:test';
import assert from 'node:assert/strict';
import { createShortcutGroups, groupsFromCommands } from '../app/shell/shortcuts-overlay.mjs';

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
