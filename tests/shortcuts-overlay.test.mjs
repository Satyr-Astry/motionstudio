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

// ── task-28：顶栏保存态 + 文件组补录 ──────────────────────────────────────
test('顶栏保存态：未入库文案、脏点语义、保存反馈都在', () => {
    const chrome = read('../app/shell/chrome.mjs');
    // 未入库与「已命名但未保存」以前视觉上一样，现在必须分开说
    assert.ok(chrome.includes('未命名项目（未入库）'), '未入库要显式写出来');
    assert.match(chrome, /aria-label', '有未保存的改动'\)/, '脏点必须带 aria-label');
    // 反馈上限 800ms（任务书要求），且靠 dirty 的 true→false 跳变触发
    assert.match(chrome, /const SAVE_FLASH_MS = 800;/, '保存反馈时长必须 ≤800ms');
    assert.match(chrome, /prevDirty === true && dirty === false/, '反馈只能由「从脏变干净」触发');
    // 图标：在库用 save、未入库用 folder-open，14px 走 sm 档
    assert.match(chrome, /icon\(inLibrary \? 'save' : 'folder-open', \{ size: 'sm' \}\)/,
        '项目区图标要跟着入库状态换');
    assert.match(chrome, /projectIcon\.setAttribute\('aria-hidden', 'true'\)/, '图标是装饰，文字已表达语义');
    // 时间与介质的「可选段」：拿不到就不显示，绝不编
    assert.match(chrome, /if \(!Number\.isFinite\(v\) \|\| v <= 0\) return '';/, '拿不到时间戳要返回空串');
    assert.match(chrome, /if \(clock\) bits\.push/, '没有时间就不写时间');
    assert.match(chrome, /if \(f\.storeKind\) bits\.push/, '没有介质就不写介质');
});

test('顶栏保存态：样式钉子（脏点隐藏 / 已保存用 --ok / flex 布局）', () => {
    const css = read('../app/styles/shell.css');
    // [hidden] 的 display:none 来自 UA 样式表，会被 .top-project-dot 的 display 盖掉 ——
    // 这条以前真的漏了：没脏的时候那个 • 照样可见。留着钉子防复发。
    assert.match(css, /\.top-project-dot\[hidden\] \{\s*display: none;/, '必须显式收掉 [hidden] 的显示');
    assert.match(css, /\.top-project\.is-just-saved[\s\S]{0,80}color: var\(--ok\)/, '保存反馈落 --ok');
    assert.match(css, /\.top-project \{[^}]*display: inline-flex/, '项目区是三段横排');
    assert.match(css, /\.top-project-text \{[^}]*text-overflow: ellipsis/,
        '省略号只能落在名字上，图标与脏点不能被裁');
});

test('文件组：保存/打开写明「项目库」，并有一条不是快捷键的行为说明', () => {
    const file = SHORTCUT_GROUPS.find((g) => g.id === 'file');
    assert.ok(file, '缺少「文件」组');
    const byName = (re) => file.items.find((i) => re.test(i.name));
    const save = byName(/保存到项目库/);
    assert.ok(save, 'Ctrl+S 的语义是入库，名字里要写「项目库」');
    assert.ok(byName(/打开项目库/), 'Ctrl+O 要写「项目库」');
    // Ctrl+S 的 hint 要说清「不是存成文件」—— 首版就是这点被误解
    assert.match(save.hint || '', /不弹文件对话框|项目记录/, 'Ctrl+S 的 hint 要排除「存成文件」的误解');
    // 行为说明：键位列写「自动」，免得被当成又一个组合键
    const auto = file.items.find((i) => i.keys === '自动');
    assert.ok(auto, '缺「载入前自动保存」这条行为说明');
    assert.match(auto.hint || '', /未命名/, '行为说明要讲清未命名时会先问');
    const keys = file.items.map((i) => i.keys);
    assert.equal(new Set(keys).size, keys.length, '文件组键位重复');
});
