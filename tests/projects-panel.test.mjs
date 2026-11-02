/**
 * 项目库面板的纯逻辑测试（tests/projects-panel.test.mjs）
 *
 * 只测能在 Node 里跑的部分：搜索过滤、计数文案、动作/菜单清单的形状与文案、
 * metaLine 的可选字段分支、条件菜单项（menuItemsFor）。
 * 不假装真机——DOM 渲染、点卡载入、菜单开合、三尺寸布局都在 CDP 侧量，
 * 那些断言写在这里只会变成「用 stub 骗自己」。
 *
 * 涉及 DOM 接线（分发、焦点、aria-live）的部分用**源码守卫**钉住：Node 里拿不到 DOM，
 * 但「面板到底有没有调 api.duplicate / 有没有 aria-live」是能读源码确认的（参照
 * tests/ik-panel.test.mjs 的写法）。
 *
 * 断言里刻意引用了 icons.mjs 的 ICON_NAMES：图标名写错时这里先红，
 * 而不是等到真机上看见一个空按钮。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    CARD_ACTIONS,
    MENU_ITEMS,
    countLabel,
    fileTail,
    filterRows,
    menuItemsFor,
    metaLine,
    noResultText,
    normRecord,
} from '../app/editors/projects.mjs';
import { ICON_NAMES } from '../app/core/icons.mjs';
import { DEFAULT_LOCALE, setLocale, t } from '../app/i18n/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PANEL_SRC = fs.readFileSync(path.join(HERE, '..', 'app', 'editors', 'projects.mjs'), 'utf8');
const PANEL_CSS = fs.readFileSync(path.join(HERE, '..', 'app', 'styles', 'projects.css'), 'utf8');

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

test('normRecord：读记录里真实存在的 frames（纹理时间点数），不是记录没有的 cels', () => {
    const row = normRecord({ id: 'p1', name: 'P', frames: 3, width: 40, height: 30, layers: 2, bytes: 1024 });
    assert.equal(row.frames, 3);
    assert.equal(row.cels, undefined, '规范化结果里不该再冒出记录没有的 cels 字段');
    // 老记录只有 cels 时也读得出来（兼容读取，不再作为写入口径）
    assert.equal(normRecord({ cels: 2 }).frames, 2);
    assert.equal(normRecord({ frames: 0, cels: 2 }).frames, 2);
    // 脏记录不炸
    assert.equal(normRecord(null).frames, 0);
    assert.equal(normRecord({ frames: '4' }).frames, 4);
});

test('normRecord：openedAt / file 是可选字段，缺了给 0 / 空串而不是 undefined', () => {
    const row = normRecord({ id: 'p2', name: 'P', openedAt: 1700000000000, file: 'C:\\work\\walk.msp' });
    assert.equal(row.openedAt, 1700000000000);
    assert.equal(row.file, 'C:\\work\\walk.msp');
    // 老记录 / 脏记录：openedAt 非数字 → 0（不显示），file 非字符串 → ''
    assert.equal(normRecord({}).openedAt, 0);
    assert.equal(normRecord({ openedAt: 'nope' }).openedAt, 0);
    assert.equal(normRecord({}).file, '');
    assert.equal(normRecord({ file: 42 }).file, '');
    assert.equal(normRecord(null).openedAt, 0);
    assert.equal(normRecord(null).file, '');
});

test('fileTail：只取路径尾巴，认 Windows 与 POSIX 两种分隔符', () => {
    assert.equal(fileTail('C:\\work\\walk.msp'), 'walk.msp');
    assert.equal(fileTail('/home/u/projects/walk.msp'), 'walk.msp');
    assert.equal(fileTail('walk.msp'), 'walk.msp');
    // 末尾带分隔符时取最后一段目录名，而不是空串
    assert.equal(fileTail('C:\\work\\motion\\'), 'motion');
    assert.equal(fileTail('   '), '');
    assert.equal(fileTail(''), '');
    assert.equal(fileTail(null), '');
    assert.equal(fileTail(undefined), '');
});

test('metaLine：有 frames 才显示「N 纹理」，缺字段时整项省略而不是恒消失', () => {
    withLocale('en', () => {
        assert.equal(metaLine(normRecord({ frames: 3, width: 40, height: 30, layers: 2 })), '3 textures · 40×30 · 2 objects');
        // 关键回归：记录里没有 cels 字段，旧判据 `if (r.cels)` 让这一项永远不显示
        assert.ok(!metaLine(normRecord({ width: 40, height: 30 })).includes('textures'));
        assert.equal(metaLine(normRecord({})), 'Empty project');
    });
    withLocale('zh-Hans', () => {
        assert.ok(metaLine(normRecord({ frames: 5 })).startsWith('5 纹理'));
    });
});

test('metaLine：openedAt 显示「最近打开」，用面板既有的 fmtTime（今天给时分）', () => {
    // 固定在一个「不是今天」的本地时刻：TZ 不同也只是同一天内的时分，故用本地构造保证确定性
    const old = new Date(2020, 0, 2, 3, 4, 0, 0).getTime();
    withLocale('en', () => {
        assert.equal(metaLine(normRecord({ openedAt: old })), 'Opened 01-02 03:04');
        // openedAt = 0（老记录没有这字段）时整项省略
        assert.equal(metaLine(normRecord({ openedAt: 0 })), 'Empty project');
    });
    withLocale('zh-Hans', () => {
        assert.equal(metaLine(normRecord({ openedAt: old })), '打开于 01-02 03:04');
    });
});

test('metaLine：file 只显示路径尾巴，完整路径不许进 meta（完整路径在卡片 title）', () => {
    withLocale('en', () => {
        assert.equal(metaLine(normRecord({ file: 'C:\\work\\walk.msp' })), 'File walk.msp');
        // 整条 meta 里不许出现目录部分：一行放不下，完整路径归卡片 title
        assert.ok(!metaLine(normRecord({ file: 'C:\\work\\walk.msp' })).includes('C:\\work'));
        assert.equal(metaLine(normRecord({ file: '' })), 'Empty project');
    });
    withLocale('zh-Hans', () => {
        assert.equal(metaLine(normRecord({ file: 'C:\\work\\walk.msp' })), '文件 walk.msp');
    });
});

test('metaLine：六项齐全时顺序固定为 纹理/尺寸/对象/体积/最近打开/文件', () => {
    const old = new Date(2020, 0, 2, 3, 4, 0, 0).getTime();
    const row = normRecord({
        frames: 3,
        width: 40,
        height: 30,
        layers: 2,
        bytes: 1024,
        openedAt: old,
        file: 'D:\\art\\hero.msp',
    });
    withLocale('en', () => {
        assert.equal(metaLine(row), '3 textures · 40×30 · 2 objects · 1 KB · Opened 01-02 03:04 · File hero.msp');
    });
    // CSS 侧承诺两行截断（否则这一行在卡片里撑破或只剩省略号）
    assert.match(PANEL_CSS, /\.prj-sub\s*\{[^}]*-webkit-line-clamp:\s*2/, '.prj-sub 必须允许两行');
});

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

test('CARD_ACTIONS：重命名 / 复制 / 另存为 / 删除，顺序钉死，删除是危险档', () => {
    assert.deepEqual(CARD_ACTIONS.map((a) => a.act), ['rename', 'duplicate', 'export', 'delete']);
    withLocale('zh-Hans', () => {
        assert.deepEqual(CARD_ACTIONS.map((a) => a.label), ['重命名', '复制', '另存为…', '删除']);
    });
    // label/title 是访问器而非普通属性：否则 setLocale() 之后卡片还挂着旧语言
    withLocale('en', () => {
        assert.deepEqual(CARD_ACTIONS.map((a) => a.label), ['Rename', 'Duplicate', 'Save as…', 'Delete']);
        assert.deepEqual(CARD_ACTIONS.map((a) => a.title), [
            'Change the project name (double-clicking the card also works)',
            'Copy this project inside the library (the copy gets its own name and id)',
            'Save this project as a .msp file and bind it to the new file (legacy .json also works)',
            'Remove from the library (undo is available for 8 seconds)',
        ]);
    });
    // 「另存为」的文案不许再含糊成「存为文件」：它是本批要显式化的交付动作
    withLocale('en', () => {
        for (const a of CARD_ACTIONS) assert.ok(!/Save to file/.test(a.label), a.act + ' 还在用旧文案');
    });
    // 卡片整块可点即载入，所以「载入」不该再作为一个按钮存在
    assert.ok(!CARD_ACTIONS.some((a) => a.act === 'open'));
    // 复制是库内动作，语义不是「写文件」：别和另存为共用标题文案
    const dup = CARD_ACTIONS.find((a) => a.act === 'duplicate');
    assert.equal(dup.icon, 'copy');
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

test('MENU_ITEMS：低频项全收进菜单，含显式「另存为」与整库备份，且「导入图片」被分隔线标为另一层级', () => {
    assert.deepEqual(MENU_ITEMS.map((a) => a.act), ['import', 'saveAs', 'exportLibrary', 'sheet', 'refresh', 'image']);
    // 「另存为」「导出整个库」都是项目文件动作，不是「不属于项目库」的那一项：分隔线只留给最后一条
    const saveAs = MENU_ITEMS.find((a) => a.act === 'saveAs');
    assert.ok(saveAs, '菜单里必须有显式的另存为入口');
    assert.ok(!saveAs.sepBefore);
    const lib = MENU_ITEMS.find((a) => a.act === 'exportLibrary');
    assert.ok(lib, '菜单里必须有「导出整个项目库」');
    assert.equal(lib.icon, 'save');
    assert.ok(!lib.sepBefore);
    // 这些项都不该再作为 head 上的平铺按钮出现
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

test('menuItemsFor：没绑定文件时就是 MENU_ITEMS 本身，不出现「解除文件绑定」', () => {
    // 同一个引用：没有文件时菜单不该多出一份拷贝（也不会有人往 MENU_ITEMS 里塞条件项）
    assert.equal(menuItemsFor(''), MENU_ITEMS);
    assert.equal(menuItemsFor('   '), MENU_ITEMS);
    assert.equal(menuItemsFor(null), MENU_ITEMS);
    assert.equal(menuItemsFor(undefined), MENU_ITEMS);
    assert.deepEqual(menuItemsFor('').map((a) => a.act), MENU_ITEMS.map((a) => a.act));
    assert.ok(!menuItemsFor('').some((a) => a.act === 'unbindFile'));
    // 基础表本身不含条件项：否则「有没有文件」这件事就藏不进判定里了
    assert.ok(!MENU_ITEMS.some((a) => a.act === 'unbindFile'));
});

test('menuItemsFor：有绑定文件时在「导出整个库」之后插入「解除文件绑定…」', () => {
    const items = menuItemsFor('C:\\work\\walk.msp');
    assert.deepEqual(items.map((a) => a.act), [
        'import',
        'saveAs',
        'exportLibrary',
        'unbindFile',
        'sheet',
        'refresh',
        'image',
    ]);
    // 不原地改基础表：菜单重建几次都不能让 MENU_ITEMS 长出一条条件项
    assert.equal(MENU_ITEMS.length, 6);
    const unbind = items.find((a) => a.act === 'unbindFile');
    assert.equal(unbind.icon, 'unlink');
    assert.ok(ICON_NAMES.includes(unbind.icon));
    withLocale('en', () => {
        assert.equal(unbind.label, 'Unbind file…');
        assert.equal(unbind.title, 'Stop writing saves back to the bound .msp file (the project stays in the library)');
    });
    withLocale('zh-Hans', () => {
        assert.equal(unbind.label, '解除文件绑定…');
    });
    // 分隔线仍然只属于「导入图片」：插入条件项不该改变层级
    assert.equal(items.filter((a) => a.sepBefore).length, 1);
    assert.equal(items.find((a) => a.act === 'image').sepBefore, true);
    // 每次调用都返回独立数组（外壳重画菜单时不会被上一次的结果污染）
    assert.notEqual(menuItemsFor('a.msp'), menuItemsFor('a.msp'));
});

test('图标名：同一个表面内不重复（卡片动作之间、菜单项之间）', () => {
    for (const [name, list] of [
        ['CARD_ACTIONS', CARD_ACTIONS],
        ['MENU_ITEMS', MENU_ITEMS],
        ['menuItemsFor(file)', menuItemsFor('C:\\work\\walk.msp')],
    ]) {
        const all = list.map((a) => a.icon);
        assert.equal(new Set(all).size, all.length, name + ' 里有两个动作撞了同一个图标');
    }
    // 跨表面允许重复：「导出整个库」（菜单）与「另存为」（卡片）都用 save —— 都是「写到磁盘」，
    // 而且从不同时出现在视野里；同表面内撞图标才是真的分不清。
});

test('分发接线（源码守卫）：复制 / 整库备份 / 解绑都真的调到了外壳，且菜单随 file 重建', () => {
    // Node 里没有 DOM，接线是否正确只能读源码确认；跑 npm run smoke 才能证明真机不白屏。
    assert.match(PANEL_SRC, /api\.duplicate\(\s*row\.id\s*\)/, '卡片「复制」必须分发 api.duplicate(row.id)');
    assert.match(PANEL_SRC, /t\('projects\.duplicate\.done'/, '复制成功要说「已复制为 {name}」');
    assert.match(PANEL_SRC, /api\.exportLibrary\(\)/, '菜单「导出整个库」必须分发 api.exportLibrary()');
    assert.match(PANEL_SRC, /t\('projects\.exportLibrary\.done'/, '整库导出成功要说「已导出 N 个项目 → file」');
    assert.match(PANEL_SRC, /api\.unbindFile\(\)/, '「解除文件绑定…」必须分发 api.unbindFile()');
    // 菜单不是 mount 时建一次：reload() 缓存 api.current().file，变了就用 menuItemsFor 重建
    assert.match(PANEL_SRC, /menuItemsFor\(currentFile\)/);
    assert.match(PANEL_SRC, /cur\.file/, 'reload() 要从 api.current() 读 file');
});

test('可见性 / 无障碍收口（源码守卫）：提示走 aria-live，删除后焦点不掉回 body，不重写撤销条', () => {
    // 结果提示必须能被读屏播报：role=status / aria-live=polite（错误档另起 role=alert）
    assert.match(PANEL_SRC, /hint\.setAttribute\('aria-live', 'polite'\)/);
    assert.match(PANEL_SRC, /aria-live/);
    // 删除会把列表整块重画：焦点要接回剩下的卡片，而不是掉回 <body>
    assert.match(PANEL_SRC, /focusAfterDelete\(index\)/);
    // 8 秒撤销条归外壳 project-io 的 holdUndoBar —— 面板侧只引用它、不许自己再实现一条
    assert.ok(!/ms-undo-bar/i.test(PANEL_SRC), '撤销条是外壳的，面板不重写');
    assert.ok(!/classList\.add\('ms-undo/i.test(PANEL_SRC));
});
