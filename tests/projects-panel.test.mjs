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
    SORT_DEFAULT,
    SORT_MODES,
    SORT_STORAGE_KEY,
    countLabel,
    fallbackSortRows,
    fileTail,
    filterByTag,
    filterRows,
    menuItemsFor,
    metaLine,
    noResultText,
    normRecord,
    normSortMode,
    readSortMode,
    sortLabelKey,
    tagOptions,
    writeSortMode,
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

// ───────────────────────── P2：排序 / 收藏 / 标签 / 库统计 ─────────────────────────

test('normRecord：pinned 归一成 Boolean，tags 只留非空字符串、去重、最多 8 个', () => {
    const row = normRecord({ id: 'p1', pinned: true, tags: [' walk ', '', 42, null, 'walk', 'hero'] });
    assert.equal(row.pinned, true);
    // 非字符串被丢掉、首尾空白被裁掉、重复的只留一个
    assert.deepEqual(row.tags, ['walk', 'hero']);
    // 老记录（P2 之前）没有这两个字段：给 false / []，渲染路径照常
    assert.equal(normRecord({}).pinned, false);
    assert.deepEqual(normRecord({}).tags, []);
    assert.equal(normRecord(null).pinned, false);
    assert.deepEqual(normRecord(null).tags, []);
    assert.equal(normRecord({ pinned: 0 }).pinned, false);
    // 与外壳 project-store 同口径：只认布尔 true（旧档里的 1 / 'true' 不算置顶）
    assert.equal(normRecord({ pinned: 1 }).pinned, false);
    assert.equal(normRecord({ pinned: 'true' }).pinned, false);
    // tags 不是数组（旧版/脏数据）→ 空数组，不抛
    assert.deepEqual(normRecord({ tags: 'hero' }).tags, []);
    assert.deepEqual(normRecord({ tags: { 0: 'hero' } }).tags, []);
    // 上限 8：第 9 个起截断
    const many = Array.from({ length: 12 }, (_, i) => 't' + i);
    assert.deepEqual(normRecord({ tags: many }).tags, many.slice(0, 8));
});

test('filterByTag：空标签原样返回同一引用，否则按 tags 包含匹配（脏记录不炸）', () => {
    const tagged = [
        { id: 'a', name: 'Alpha', tags: ['walk', 'hero'] },
        { id: 'b', name: 'Beta', tags: ['hero'] },
        { id: 'c', name: 'Gamma', tags: [] },
        { id: 'd', name: 'Delta' },
    ];
    // 与 filterRows 同口径：没筛就不产生新数组（调用方可以按引用判断）
    assert.equal(filterByTag(tagged, ''), tagged);
    assert.equal(filterByTag(tagged, '   '), tagged);
    assert.equal(filterByTag(tagged, null), tagged);
    assert.equal(filterByTag(tagged, undefined), tagged);
    assert.deepEqual(filterByTag(tagged, 'hero').map((r) => r.id), ['a', 'b']);
    assert.deepEqual(filterByTag(tagged, ' walk ').map((r) => r.id), ['a']);
    assert.deepEqual(filterByTag(tagged, 'nope'), []);
    // 脏记录（tags 缺失/非数组）不匹配但不抛
    assert.deepEqual(filterByTag(tagged, 'walk').map((r) => r.id), ['a']);
    assert.deepEqual(filterByTag([null, { id: 'x' }, { id: 'y', tags: 'walk' }], 'walk'), []);
    assert.deepEqual(filterByTag(null, 'hero'), []);
    assert.deepEqual(filterByTag(undefined, ''), []);
    // 与搜索串联（paint() 的顺序：先搜索、再标签、最后排序）
    assert.deepEqual(filterByTag(filterRows(tagged, 'alpha'), 'hero').map((r) => r.id), ['a']);
});

test('tagOptions：全库标签去重 + 按 localeCompare 有序，脏记录不炸', () => {
    const tagged = [
        { tags: ['walk', 'hero'] },
        { tags: ['hero', 'Idle'] },
        { tags: [] },
        null,
        { tags: 'walk' },
        { tags: ['  ', '', ' walk '] },
    ];
    const opts = tagOptions(tagged);
    assert.deepEqual([...opts].sort(), ['Idle', 'hero', 'walk'], '去重且一个不漏');
    // 顺序断言不写死 ICU 结果，只要求「相邻两项 localeCompare 递增」
    for (let i = 0; i + 1 < opts.length; i += 1) {
        assert.ok(opts[i].localeCompare(opts[i + 1]) <= 0, '标签选项没有按 localeCompare 排序：' + opts.join(', '));
    }
    assert.deepEqual(tagOptions(null), []);
    assert.deepEqual(tagOptions(undefined), []);
    assert.deepEqual(tagOptions([]), []);
});

test('SORT_MODES / sortLabelKey：四档顺序钉死，键名能 t() 出人话，脏值落回缺省档', () => {
    assert.deepEqual(SORT_MODES.map((m) => m.mode), ['saved', 'opened', 'name', 'size']);
    assert.deepEqual(SORT_MODES.map((m) => m.labelKey), [
        'projects.sort.saved',
        'projects.sort.opened',
        'projects.sort.name',
        'projects.sort.size',
    ]);
    assert.equal(SORT_DEFAULT, 'saved');
    assert.equal(SORT_STORAGE_KEY, 'ms.projects.sort', 'localStorage 键是跨版本契约，不许改名');
    assert.equal(normSortMode('name'), 'name');
    assert.equal(normSortMode('nope'), 'saved');
    assert.equal(normSortMode(null), 'saved');
    assert.equal(normSortMode(undefined), 'saved');
    assert.equal(sortLabelKey('size'), 'projects.sort.size');
    assert.equal(sortLabelKey('bogus'), 'projects.sort.saved');
    // 四个键在两语言里都真有词（不是把键名显示给用户）
    withLocale('en', () => {
        assert.deepEqual(SORT_MODES.map((m) => t(m.labelKey)), ['Last saved', 'Last opened', 'Name', 'Size']);
        assert.equal(t(sortLabelKey('size')), 'Size');
    });
    withLocale('zh-Hans', () => {
        assert.deepEqual(SORT_MODES.map((m) => t(m.labelKey)), ['最近保存', '最近打开', '名称', '大小']);
        assert.equal(t(sortLabelKey('bogus')), '最近保存');
    });
});

test('fallbackSortRows：pinned 永远最前，其余按档位；不改入参、脏值不炸', () => {
    const list = [
        { id: 'a', name: 'Beta', savedAt: 100, openedAt: 500, bytes: 10 },
        { id: 'b', name: 'Alpha', savedAt: 300, openedAt: 100, bytes: 30, pinned: true },
        { id: 'c', name: 'Gamma', savedAt: 200, openedAt: 900, bytes: 20 },
    ];
    const ids = (arr) => arr.map((r) => r.id);
    assert.deepEqual(ids(fallbackSortRows(list, 'saved')), ['b', 'c', 'a'], '置顶在前，再按 savedAt 降序');
    assert.deepEqual(ids(fallbackSortRows(list, 'opened')), ['b', 'c', 'a'], '置顶在前，再按 openedAt 降序');
    assert.deepEqual(ids(fallbackSortRows(list, 'size')), ['b', 'c', 'a'], '置顶在前，再按 bytes 降序');
    assert.deepEqual(ids(fallbackSortRows(list, 'name')), ['b', 'a', 'c'], '置顶在前，其余按名字');
    assert.deepEqual(ids(fallbackSortRows(list, 'bogus')), ['b', 'c', 'a'], '未知档位落回 saved');
    // 返回新数组、入参顺序不变（paint 之后 rows 还要给 totals/其他分支用）
    assert.notEqual(fallbackSortRows(list, 'saved'), list);
    assert.deepEqual(ids(list), ['a', 'b', 'c']);
    assert.deepEqual(fallbackSortRows(null, 'saved'), []);
    assert.deepEqual(fallbackSortRows(undefined, 'name'), []);
    // 脏记录（缺字段）按 0 / 空串处理，不抛
    assert.deepEqual(ids(fallbackSortRows([{ id: 'x' }, { id: 'y', pinned: true }], 'size')), ['y', 'x']);
});

test('排序偏好读写：localStorage 抛错/不可用时退回缺省档，不白屏', () => {
    // 直接替换全局 localStorage 模拟隐私模式（getItem/setItem 都抛）
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'localStorage');
    const orig = had ? globalThis.localStorage : undefined;
    try {
        globalThis.localStorage = {
            getItem() {
                throw new Error('denied');
            },
            setItem() {
                throw new Error('denied');
            },
        };
        assert.equal(readSortMode(), SORT_DEFAULT, '读失败必须落回缺省档');
        assert.equal(writeSortMode('size'), false, '写失败返回 false，不抛');
        // 没有 localStorage 的环境（Node / 沙箱）同样要能读
        globalThis.localStorage = null;
        assert.equal(readSortMode(), SORT_DEFAULT);
        assert.equal(writeSortMode('name'), false);
    } finally {
        if (had) globalThis.localStorage = orig;
        else delete globalThis.localStorage;
    }
});

test('P2 接线（源码守卫）：排序 / 星标 / 标签 / 库统计真的接到了外壳与 localStorage', () => {
    // 排序：paint() 走 api.sortRows，外壳不可用时本地兜底；偏好落 ms.projects.sort
    assert.match(PANEL_SRC, /api\.sortRows\(/, '展示顺序必须调 api.sortRows');
    assert.match(PANEL_SRC, /fallbackSortRows\(/, 'api 不可用时必须退回本地排序');
    assert.match(PANEL_SRC, /localStorage\.getItem\(SORT_STORAGE_KEY\)/);
    assert.match(PANEL_SRC, /localStorage\.setItem\(SORT_STORAGE_KEY/);
    // 读写各自包在 try/catch 里（隐私模式 / 禁用存储时 getItem 直接抛）
    assert.match(PANEL_SRC, /function readSortMode\(\)\s*\{\s*try\s*\{/, '读偏好必须 try/catch');
    assert.match(PANEL_SRC, /function writeSortMode\(mode\)\s*\{\s*try\s*\{/, '写偏好必须 try/catch');
    // 星标：图标 star + aria-pressed + 目标状态显式传参
    assert.match(PANEL_SRC, /icoNode\('star'\)/);
    assert.match(PANEL_SRC, /setAttribute\('aria-pressed'/);
    assert.match(PANEL_SRC, /classList\.add\('is-pinned'\)/);
    assert.match(PANEL_SRC, /dataset\.act = 'pin'/);
    assert.match(PANEL_SRC, /api\.setPinned\(\s*row\.id\s*,\s*want\s*\)/, '星标必须调 api.setPinned(row.id, 目标状态)');
    // 标签：chips / +N / 末尾 + / 点 chip = 筛选 / 顶部筛选条
    assert.match(PANEL_SRC, /'prj-tag'/);
    assert.match(PANEL_SRC, /'prj-tag-add'/);
    assert.match(PANEL_SRC, /'prj-tag-more'/);
    assert.match(PANEL_SRC, /api\.editTags\(\s*row\.id\s*\)/);
    assert.match(PANEL_SRC, /setTagFilter\(/, '点标签 chip 必须走 setTagFilter');
    assert.match(PANEL_SRC, /'prj-sort-select'/);
    assert.match(PANEL_SRC, /'prj-tag-select'/);
    assert.match(PANEL_SRC, /'prj-tag-filter'/);
    assert.match(PANEL_SRC, /tagOptions\(rows\)/);
    // 库统计：计数行追加 api.totals(rows).bytes，走现有 fmtBytes
    assert.match(PANEL_SRC, /api\.totals\(rows\)/);
    assert.match(PANEL_SRC, /t\('projects\.count\.size', \{ size: fmtBytes\(/);
    // 筛选顺序：先 filterRows 再 filterByTag（paint 的展示链）
    assert.match(PANEL_SRC, /const searched = filterRows\(rows, query\);/);
    assert.match(PANEL_SRC, /const tagged = filterByTag\(searched, tagFilter\);/);
    assert.match(PANEL_SRC, /sortRowsFor\(tagged, sortMode\)/);
});

test('P2 样式（源码守卫）：星标填实、chips、置顶态、两个下拉、258px 卡片不撑破', () => {
    assert.match(PANEL_CSS, /\.prj-pin\.is-on svg\s*\{\s*fill:\s*currentColor/, '置顶后星标要填实');
    assert.match(PANEL_CSS, /\.prj-tag\b/);
    assert.match(PANEL_CSS, /\.prj-tag-add\b/);
    assert.match(PANEL_CSS, /\.prj-tag-filter\[hidden\]\s*\{\s*display:\s*none/, '[hidden] 必须显式 display:none');
    assert.match(PANEL_CSS, /\.prj-card\.is-pinned/);
    assert.match(PANEL_CSS, /\.prj-sort-select/);
    assert.match(PANEL_CSS, /\.prj-tag-select/);
    // 卡片网格宽度是 P1 定下的（258px）：本批只往卡片内部加东西，不许改列宽
    assert.match(PANEL_CSS, /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(258px,\s*1fr\)\)/);
});
