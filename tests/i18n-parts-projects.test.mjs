// 项目库 / 导入导出词条（P2-F）：`app/i18n/parts/projects.mjs` 这一片的自检。
//
// 钉三件事：
//   1. 两表键集合镜面，且每条都真并进了词典（分片写了但 `parts/index.mjs` 忘了注册 = 静默丢词）。
//   2. en 表不许有中文；zh-Hans 表逐条等于迁移前原文 —— 迁移不许顺手改界面文案。
//   3. 落盘值一个字符都不动：PSD 的扩展名、导出选项的默认值、项目动作的 act id。
//
// psd.mjs 的错误串同时被 `tests/psd.test.mjs` 用正则匹配，那边已经改成「从词条取期望值」；
// 这里再兜一层：键缺了 / 值被改了就红，而不是让 `t()` 静默退回键名。
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_LOCALE, keysOf, setLocale, t } from '../app/i18n/index.mjs';
import projectsPart from '../app/i18n/parts/projects.mjs';
import { PSD_FORMAT } from '../app/core/psd.mjs';
import { EXPORT_DEFAULTS, FORMATS } from '../app/core/export-options.mjs';
import { CARD_ACTIONS, MENU_ITEMS, countLabel, noResultText } from '../app/editors/projects.mjs';

const HAN = /[\u4e00-\u9fff]/;
const PREFIXES = ['projects.', 'import.', 'export.', 'psd.'];

const enTable = projectsPart.en;
const zhTable = projectsPart['zh-Hans'];

/** 在指定语言下跑一段断言，跑完必定回到缺省语言（别的用例不该被带偏）。 */
function withLocale(id, fn) {
    setLocale(id);
    try {
        fn();
    } finally {
        setLocale(DEFAULT_LOCALE);
    }
}

test('projects 分片：两表键集合镜面，且每个键都真的并进了词典', () => {
    const enKeys = Object.keys(enTable).sort();
    const zhKeys = Object.keys(zhTable).sort();
    assert.deepEqual(enKeys, zhKeys, 'en 与 zh-Hans 的键集合必须一一对应');
    // 本片 = psd 解析器（60）+ 导出对话框（27）+ 项目库面板（67）
    assert.ok(enKeys.length >= 154, '这一片至少 154 条，实际 ' + enKeys.length);

    const mergedEn = keysOf('en');
    const mergedZh = keysOf('zh-Hans');
    for (const k of enKeys) {
        assert.ok(mergedEn.includes(k), k + ' 没并进 en 词典（parts/index.mjs 注册了吗？）');
        assert.ok(mergedZh.includes(k), k + ' 没并进 zh-Hans 词典');
    }
});

test('projects 分片：键都落在本片命名空间下，且符合「区域.实体.字段」', () => {
    for (const k of Object.keys(enTable)) {
        assert.ok(PREFIXES.some((p) => k.startsWith(p)), k + ' 不在本片约定的前缀里');
        assert.match(k, /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/, k + ' 不符合键语法');
    }
});

test('en 表：没有一个中文字符，也没有空值', () => {
    for (const [k, v] of Object.entries(enTable)) {
        assert.equal(typeof v, 'string', k + ' 必须是字符串');
        assert.ok(v.trim().length > 0, k + ' 是空串');
        assert.ok(!HAN.test(v), k + ' 的英文值是「' + v + '」，en 表里不许有中文');
    }
});

test('zh-Hans 表：文案与词条化之前的原文逐字一致', () => {
    // 左边是硬编码时的原文，右边是词条化的键 —— 中间任何一个字被改写都算破坏界面文案。
    const ORIGINAL = {
        'export.action.cancel': '取消',
        'export.action.cancelExport': '取消导出',
        'export.action.close': '关闭',
        'export.action.export': '导出',
        'export.action.gif': '导出 GIF',
        'export.action.gif.hint': '一张带透明的动图，直接发出去就能播',
        'export.action.apng': '导出 APNG',
        'export.action.apng.hint': '全彩动图，带真正的 8 位透明通道（需要较新的浏览器或桌面版）',
        'export.action.sheet': '导出精灵图',
        'export.action.video': '导出 WebM',
        'export.background.solid': '纯色',
        'export.background.transparent': '透明',
        'export.cancel.pending': '正在取消…',
        'export.canceled': '已取消',
        'export.canceledWith': '已取消（已写出 {written} 帧）',
        'export.dialog.aria': '导出',
        'export.dialog.title': '导出',
        'export.done': '导出完成',
        'export.emptyRange': '时间范围为空，没有可导出的帧',
        'export.engine.aseprite': 'Aseprite 帧标签',
        'export.engine.aseprite.hint': 'Aseprite 能吃；读 Aseprite 数据的一并可用：TexturePacker、Godot、Love2D、Unity 导入器',
        'export.engine.both': '三种都要',
        'export.engine.both.hint': '自有格式、Phaser、Aseprite 各出一份',
        'export.engine.own': 'MotionStudio 自有格式',
        'export.engine.own.hint': '只有本程序读得懂，信息最全',
        'export.engine.phaser': 'Phaser 3 JSON Hash',
        'export.engine.phaser.hint': '直接喂 Phaser 3 的 this.load.atlas()',
        'export.failed': '导出失败',
        'export.field.background': '背景',
        'export.field.engine': '帧表',
        'export.field.format': '图片格式',
        'export.field.fps': '帧率',
        'export.field.fps.hint': '0 = 跟随文档帧率',
        'export.field.options': '选项',
        'export.field.quality': '质量',
        'export.field.quality.hint': '仅 JPEG 与 WebP 有效',
        'export.field.quality.na': '无损格式，质量不适用',
        'export.field.range': '时间',
        'export.field.range.to.hint': '0 = 到片尾',
        'export.field.scale': '缩放',
        'export.format.jpeg': 'JPEG（不支持透明）',
        'export.format.png': 'PNG（无损，支持透明）',
        'export.format.webp': 'WebP（更小）',
        'export.gif.canceled': '已取消导出 GIF',
        'export.gif.canceledSave': '已取消，GIF 没有写出',
        'export.gif.done': '已写出 GIF：{n} 帧，{size} KB',
        'export.gif.emptyRange': '时间范围为空，没有可导出的帧',
        'export.gif.encodeFailed': 'GIF 编码失败：{msg}',
        'export.gif.label': 'GIF 动画',
        'export.gif.noBridge': '这个环境没有保存通道 —— GIF 需要桌面版或网页桥',
        'export.gif.noCanvas': '读不到画布像素，GIF 导出需要 2D 画布',
        'export.gif.saveFailed': 'GIF 编好了但没存下来：{msg}',
        'export.gif.saveFailedNoReason': '没有给出原因',
        'export.apng.canceled': '已取消导出 APNG',
        'export.apng.canceledSave': '已取消，APNG 没有写出',
        'export.apng.done': '已写出 APNG：{n} 帧，{size} KB',
        'export.apng.emptyRange': '时间范围为空，没有可导出的帧',
        'export.apng.encodeFailed': 'APNG 编码失败：{msg}',
        'export.apng.label': 'APNG 动画',
        'export.apng.noBridge': '这个环境没有保存通道 —— APNG 需要桌面版或网页桥',
        'export.apng.noCanvas': '读不到画布像素，APNG 导出需要 2D 画布',
        'export.apng.noSupport': '这个环境不能生成 APNG（没有 CompressionStream）—— 请改用 GIF 或 WebM',
        'export.apng.saveFailed': 'APNG 编好了但没存下来：{msg}',
        'export.apng.saveFailedNoReason': '没有给出原因',
        'export.openAfter': '完成后打开所在文件夹',
        'export.preset.chat': '发出去',
        'export.preset.chat.hint': '一张别太大的 PNG —— 聊天软件对 WebP 支持参差',
        'export.preset.engine': '引擎里用',
        'export.preset.engine.hint': '1 倍无损 PNG，三种帧表都出',
        'export.preset.note': '预设只是把下面几项填一遍，填完不会被锁住。',
        'export.preset.print': '排版用',
        'export.preset.print.hint': '2 倍分辨率、不裁边、图集上限放到最大',
        'export.preset.web': '网页用',
        'export.preset.web.hint': '1 倍 WebP，图集小一些省流量',
        'export.progress': '已处理 {done} / {total}',
        'export.running': '正在导出…',
        'psd.err.badColorMode': '不支持的色彩模式：{colorMode}（只支持 3=RGB、1=灰度）',
        'psd.err.badDepth': '不支持的位深：{depth} 位/通道（只支持 8 位）',
        'psd.err.badInput': 'PSD 解析失败：入参必须是 ArrayBuffer 或 Uint8Array',
        'psd.err.badLayerCount': 'PSD 数据异常：图层数为 {count}',
        'psd.err.badSignature': '不是 PSD 文件：签名为 "{signature}"，应为 "8BPS"',
        'psd.err.badSize': '文档尺寸非法：{width} × {height}',
        'psd.err.badVersion': '不支持的版本号：{version}（只支持 1=PSD、2=PSB）',
        'psd.err.layerCountMismatch': 'PSD 数据越界：声明 {count} 个图层，图层信息段却只有 {left} 字节',
        'psd.err.layerTooLarge': '图层「{name}」尺寸过大：{width} × {height}',
        'psd.err.outOfRange': 'PSD 数据越界：读取「{what}」需要 {n} 字节，仅剩 {left} 字节',
        'psd.field.blockKey': '附加块标识',
        'psd.field.blockLen': '附加块长度',
        'psd.field.blockPad': '附加块对齐',
        'psd.field.blockSignature': '附加块签名',
        'psd.field.blendKey': '混合模式码',
        'psd.field.blendRanges': '混合范围',
        'psd.field.blendRangesLen': '混合范围长度',
        'psd.field.blendSignature': '混合模式签名',
        'psd.field.channelCount': '图层通道数',
        'psd.field.channelDataLen': '通道数据长度',
        'psd.field.channelId': '通道 id',
        'psd.field.channels': '通道数',
        'psd.field.clipping': '剪切标记',
        'psd.field.colorMode': '色彩模式',
        'psd.field.colorModeData': '色彩模式数据',
        'psd.field.colorModeDataLen': '色彩模式数据长度',
        'psd.field.compression': '通道压缩方式',
        'psd.field.depth': '位深',
        'psd.field.dividerType': '分组类型',
        'psd.field.extraBlock': '附加块 {key}',
        'psd.field.extraDataLen': '图层附加数据长度',
        'psd.field.fill': '填充字节',
        'psd.field.flags': '图层标志',
        'psd.field.height': '文档高度',
        'psd.field.imageResources': '图像资源',
        'psd.field.imageResourcesLen': '图像资源长度',
        'psd.field.layerChannelData': '图层通道数据',
        'psd.field.layerCount': '图层数',
        'psd.field.layerInfo': '图层信息',
        'psd.field.layerInfoLen': '图层信息长度',
        'psd.field.layerMask': '图层与蒙版段',
        'psd.field.layerMaskLen': '图层与蒙版段长度',
        'psd.field.maskData': '图层蒙版数据',
        'psd.field.maskDataLen': '图层蒙版数据长度',
        'psd.field.name': '图层名',
        'psd.field.nameLen': '图层名字节数',
        'psd.field.namePad': '图层名对齐填充',
        'psd.field.opacity': '不透明度',
        'psd.field.rectBottom': '图层矩形 bottom',
        'psd.field.rectLeft': '图层矩形 left',
        'psd.field.rectRight': '图层矩形 right',
        'psd.field.rectTop': '图层矩形 top',
        'psd.field.reserved': '预留字段',
        'psd.field.rleRowData': 'RLE 行数据',
        'psd.field.rleRowLen': 'RLE 行字节数',
        'psd.field.signature': '文件签名',
        'psd.field.unicodeName': 'Unicode 图层名',
        'psd.field.unicodeNameLen': 'Unicode 图层名字符数',
        'psd.field.version': '版本号',
        'psd.field.width': '文档宽度',
        'psd.format.name': 'Photoshop 文档',
        'projects.busy': '正在处理上一个操作，请稍候…',
        'projects.card.aria': '{name}，保存于 {when}，点击载入',
        'projects.card.badge': '当前',
        'projects.card.delete': '删除',
        'projects.card.delete.hint': '从项目库删除（8 秒内可撤销）',
        'projects.card.export': '存为文件',
        'projects.card.export.hint': '另存为 .msp 项目文件（旧版 .json 也行）',
        'projects.card.rename': '重命名',
        'projects.card.rename.hint': '修改项目名称（双击卡片也可以）',
        'projects.card.time': '保存于 {when}',
        'projects.card.title': '{name}（保存于 {when}）· 点击卡片载入',
        'projects.card.unsaved': '尚未保存',
        'projects.count.all': '共 {n} 个',
        'projects.count.matched': '匹配 {matched} / {n}',
        'projects.create.done': '已新建项目',
        'projects.empty': '还没有已保存的项目',
        'projects.err.action': '操作失败：{msg}',
        'projects.err.read': '读取项目库失败：{msg}',
        'projects.head.aria': '项目库操作',
        'projects.import.done': '已导入 {ok} 张图片',
        'projects.import.doneSome': '已导入 {ok} 张图片，{fail} 张失败',
        'projects.import.failed': '导入图片失败：{msg}',
        'projects.import.noDocApi': '外壳没有提供文档接口，无法插入图片',
        'projects.import.noPixels': '导入图片失败：读不出像素',
        'projects.import.notImage': '不是图片文件',
        'projects.importFile.done': '已导入项目',
        'projects.importFile.noPicker': '这个环境不支持选择文件',
        'projects.menu.image': '导入图片到当前文档',
        'projects.menu.image.hint': '把一张图片作为对象插入当前文档（PNG / JPG / WebP）',
        'projects.menu.import': '导入项目文件',
        'projects.menu.import.hint': '从 .msp 或 .json 项目文件导入到库并打开',
        'projects.menu.refresh': '刷新',
        'projects.menu.refresh.hint': '重新读取项目库',
        'projects.menu.sheet': '导出精灵图',
        'projects.menu.sheet.hint': '把整段动画排成一张精灵图（PNG + 坐标 JSON）',
        'projects.meta.cels': '{n} 纹理',
        'projects.meta.empty': '空项目',
        'projects.meta.layers': '{n} 对象',
        'projects.more': '更多操作',
        'projects.msg.refreshed': '已刷新',
        'projects.new': '新建项目',
        'projects.new.hint': '用默认尺寸新建一个项目（当前有未保存改动时会先询问）',
        'projects.noResult': '没有匹配的项目',
        'projects.offline.aria': '项目库（接口未就绪）',
        'projects.offline.text': '外壳没有注入 ctx.project，项目库暂不可用。',
        'projects.open.done': '已载入 {name}',
        'projects.remove.done': '已删除 {name}',
        'projects.rename.aria': '项目名称',
        'projects.rename.cancel': '取消',
        'projects.rename.cancel.hint': '放弃修改（Esc）',
        'projects.rename.done': '已重命名为 {name}',
        'projects.rename.ok': '确定',
        'projects.rename.ok.hint': '确认新名称（Enter）',
        'projects.save.done': '已存为文件：{file}',
        'projects.save.noPath': '保存接口说成功了，但没给文件路径 —— 文件可能没落地，请重试',
        'projects.search.aria': '按名称搜索项目',
        'projects.search.placeholder': '搜索项目',
        'projects.sheet.done': '已导出精灵图 {n} 帧',
        'projects.sheet.doneDir': '已导出精灵图 {n} 帧：{dir}',
        'projects.sheet.empty': '导出接口回了成功，但帧表是空的（0 帧）—— 检查时间范围与帧率',
        'projects.sheet.missing': '这个版本没有接导出精灵图（外壳没注入 exportSpritesheet）',
        'projects.thumb.empty': '无纹理',
        'projects.time.today': '今天 {hm}',
        'projects.untitled': '未命名项目',
        'projects.verdict.canceled': '已取消',
        'projects.verdict.incomplete': '操作未完成',
        'projects.verdict.noAnswer': '外壳没有回应（这一步没跑起来）',
    };
    // 逐条覆盖全表：漏一条就少一道锁，键数变了这里先红
    assert.deepEqual(Object.keys(ORIGINAL).sort(), Object.keys(zhTable).sort(), '原文表必须覆盖分片里的每一个键');
    for (const [k, v] of Object.entries(ORIGINAL)) {
        assert.equal(zhTable[k], v, k + ' 的中文原文被改动了');
    }
});

test('占位符在两表里用同一套名字（否则切语言就丢变量）', () => {
    const names = (s) => (s.match(/\{[a-zA-Z]+\}/g) || []).sort();
    for (const k of Object.keys(zhTable)) {
        assert.deepEqual(names(enTable[k]), names(zhTable[k]), k + ' 的占位符两表不一致');
    }
});

test('落盘值不许改：PSD 只认 .psd / .psb，格式名跟着语言变', () => {
    assert.deepEqual(PSD_FORMAT.ext, ['.psd', '.psb'], '扩展名是落盘值');
    withLocale('zh-Hans', () => {
        assert.equal(PSD_FORMAT.name, 'Photoshop 文档');
    });
    withLocale('en', () => {
        assert.equal(PSD_FORMAT.name, 'Photoshop document');
        // 换语言只该换名字，扩展名一个字符都不动
        assert.deepEqual(PSD_FORMAT.ext, ['.psd', '.psb']);
    });
});

test('落盘值不许改：导出选项的默认值与格式 id 没被词条化顺手改掉', () => {
    assert.deepEqual([...FORMATS], ['png', 'webp', 'jpeg']);
    assert.equal(EXPORT_DEFAULTS.format, 'png');
    assert.equal(typeof EXPORT_DEFAULTS.scale, 'number');
    assert.equal(typeof EXPORT_DEFAULTS.fps, 'number');
});

test('落盘值不许改：卡片动作与菜单项的 act id 不随语言变', () => {
    assert.deepEqual(CARD_ACTIONS.map((a) => a.act), ['rename', 'export', 'delete']);
    assert.deepEqual(MENU_ITEMS.map((a) => a.act), ['import', 'sheet', 'refresh', 'image']);
    withLocale('zh-Hans', () => {
        assert.deepEqual(CARD_ACTIONS.map((a) => a.act), ['rename', 'export', 'delete']);
        assert.equal(MENU_ITEMS.filter((a) => a.act === 'image')[0].sepBefore, true);
    });
});

test('面板文案是现取的：切语言后 label / 提示跟着变', () => {
    withLocale('zh-Hans', () => {
        assert.deepEqual(CARD_ACTIONS.map((a) => a.label), ['重命名', '存为文件', '删除']);
        assert.equal(noResultText(), '没有匹配的项目');
        assert.equal(countLabel(4, 1, 'x'), '匹配 1 / 4');
    });
    withLocale('en', () => {
        assert.deepEqual(CARD_ACTIONS.map((a) => a.label), ['Rename', 'Save to file', 'Delete']);
        assert.equal(noResultText(), 'No matching projects');
        assert.equal(countLabel(4, 1, 'x'), 'Matched 1 / 4');
        assert.ok(!HAN.test(countLabel(4, 1, 'x')), '英文计数里还有中文');
    });
});

test('t() 不带兜底时，本片用到的每个键都真能在两表里取到', () => {
    // 源码里一律写 `t(key)` 不给第二参：漏一条词条就会把键名直接显示给用户。
    const keys = Object.keys(enTable);
    withLocale('zh-Hans', () => {
        for (const k of keys) assert.notEqual(t(k), k, k + ' 在 zh-Hans 里缺词（t() 退回了键名）');
    });
    withLocale('en', () => {
        for (const k of keys) assert.notEqual(t(k), k, k + ' 在 en 里缺词（t() 退回了键名）');
    });
});
