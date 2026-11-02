// 面板常量词条（P1-D）：`app/i18n/parts/panels.mjs` 这一片的自检。
//
// 两件事必须钉死：
//   1. 显示名换了语言就换，但**落盘值一个字符都不能动** —— `layer.kind` 的 paint/image、
//      `doc.loopMode` 的四种、`doc.onion.mode` 的 tint/dim、时间通道的 mode，这些是写进
//      .msp 的，改了就打开旧存档全是错的。
//   2. 中文原文不能被「翻译时顺手改词」。这里逐条比对词条化之前的原文，改一个词就红。
//
// 为什么显示名是「现取」（getter）而不是建表时算好：`setLocale` 只换表、不重建模块常量，
// 常量表一辈子只建一次；访问器保证消费者（curve.mjs / timeline.mjs / timeline-paint.mjs）
// 一行不改就跟着切语言。
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_LOCALE, keysOf, setLocale, t } from '../app/i18n/index.mjs';
import panelsPart from '../app/i18n/parts/panels.mjs';
import { PLAY_MODE_IDS, modeInfo } from '../app/core/playback.mjs';
import { SCALAR_CHANNELS } from '../app/editors/curve-geo.mjs';
import { keySummary } from '../app/editors/timeline-geo.mjs';

const HAN = /[\u4e00-\u9fff]/;
// P3-A 追加：工具条 / 笔刷 / 调色板 / 叠放树 / 画布 HUD 的显示名也归这一片
//（它们同样是「建表时就定型的常量」：TOOL_DEFS、BRUSH_PRESETS、HUD 按钮。）
const PREFIXES = ['layers.', 'doc.', 'curve.', 'timeline.', 'props.', 'onion.', 'playback.',
    'tool.', 'tbar.', 'brush.', 'color.', 'tree.', 'chrome.'];

const zhTable = panelsPart['zh-Hans'];
const enTable = panelsPart.en;

/** 这一片里以 `prefix` 开头的键，去掉前缀后的有序 id 列表。 */
function idsUnder(table, prefix) {
    return Object.keys(table)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
        .sort();
}

/** 在指定语言下跑一段断言，跑完必定回到缺省语言（别的用例不该被带偏）。 */
function withLocale(id, fn) {
    setLocale(id);
    try {
        fn();
    } finally {
        setLocale(DEFAULT_LOCALE);
    }
}

test('panels 分片：两表键集合镜面，且每个键都真的并进了词典', () => {
    const enKeys = Object.keys(enTable).sort();
    const zhKeys = Object.keys(zhTable).sort();
    assert.deepEqual(enKeys, zhKeys, 'en 与 zh-Hans 的键集合必须一一对应');
    assert.ok(enKeys.length >= 42, '这一片至少 42 条（7 个面板常量抽出来的），实际 ' + enKeys.length);

    // 分片写在文件里不等于词典里有：`parts/index.mjs` 忘了注册就会静默丢词。
    const mergedEn = keysOf('en');
    const mergedZh = keysOf('zh-Hans');
    for (const k of enKeys) {
        assert.ok(mergedEn.includes(k), k + ' 没并进 en 词典（parts/index.mjs 注册了吗？）');
        assert.ok(mergedZh.includes(k), k + ' 没并进 zh-Hans 词典');
    }
});

test('panels 分片：键都落在本片的面板命名空间下', () => {
    for (const k of Object.keys(enTable)) {
        assert.ok(PREFIXES.some((p) => k.startsWith(p)), k + ' 不在本片约定的前缀里');
        assert.match(k, /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/, k + ' 不符合「区域.实体.字段」的键语法');
    }
});

test('en 表：没有一个中文字符，也没有空值', () => {
    for (const [k, v] of Object.entries(enTable)) {
        assert.equal(typeof v, 'string', k + ' 必须是字符串');
        assert.ok(v.trim().length > 0, k + ' 是空串');
        assert.ok(!HAN.test(v), k + ' 的英文值是「' + v + '」，en 表里不许有中文');
    }
});

test('zh-Hans 表：显示名与词条化之前的原文逐字一致', () => {
    // 左边是硬编码时的原文，右边是词条化的键 —— 中间任何一个字被改写都算破坏界面文案。
    const ORIGINAL = {
        'layers.kind.paint': '手绘',
        'layers.kind.image': '图片',
        'layers.timeMode.none': '无',
        'layers.timeMode.loop': '循环',
        'layers.timeMode.pingpong': '往返',
        'layers.timeMode.clamp': '夹取',
        'doc.loop.cycle': '循环',
        'doc.loop.pingpong': '来回',
        'doc.loop.reverse': '反向循环',
        'doc.loop.none': '单次',
        'curve.corner.tl': '左上',
        'curve.corner.tr': '右上',
        'curve.corner.br': '右下',
        'curve.corner.bl': '左下',
        'curve.channel.x': '位置 X',
        'curve.channel.y': '位置 Y',
        'curve.channel.scaleX': '缩放 X',
        'curve.channel.scaleY': '缩放 Y',
        'curve.channel.rotate': '旋转',
        'curve.channel.skewX': '斜切 X',
        'curve.channel.skewY': '斜切 Y',
        'curve.channel.opacity': '不透明度',
        'timeline.state.x': '位移 X',
        'timeline.state.y': '位移 Y',
        'timeline.state.opacity': '不透明度',
        'props.section.object': '对象',
        'props.section.doc': '工程',
        'onion.mode.tint': '红绿着色',
        'onion.mode.dim': '淡化',
        'playback.mode.cycle.label': '循环',
        'playback.mode.pingpong.label': '来回',
        'playback.mode.reverse.label': '反向循环',
        'playback.mode.none.label': '单次',
        'playback.mode.cycle.hint': '播到末尾从头继续',
        'playback.mode.pingpong.hint': '播到末尾倒着回来，往返不停',
        'playback.mode.reverse.hint': '从末尾倒着播到开头，再回到末尾',
        'playback.mode.none.hint': '播到末尾就停',
    };
    for (const [k, v] of Object.entries(ORIGINAL)) {
        assert.equal(zhTable[k], v, k + ' 的中文原文被改动了');
    }
});

test('落盘值不许改：layer.kind 只有 paint / image', () => {
    assert.deepEqual(idsUnder(zhTable, 'layers.kind.'), ['image', 'paint']);
    assert.deepEqual(idsUnder(enTable, 'layers.kind.'), ['image', 'paint']);
});

test('落盘值不许改：doc.loopMode 只有 cycle / pingpong / reverse / none', () => {
    const ids = idsUnder(zhTable, 'doc.loop.');
    assert.deepEqual(ids, ['cycle', 'none', 'pingpong', 'reverse']);
    // 面板上的四个按钮就是这四种播放方式，顺序也与播放表一致（点一下换下一种）。
    assert.deepEqual([...PLAY_MODE_IDS].sort(), ids);
});

test('落盘值不许改：onion.mode 面板仍只提供 tint / dim', () => {
    // 只钉「面板给用户的两个选项没被词条化顺手改掉」，不代表这两个值都对得上核心层：
    // app/core/cel.mjs:159 的 normalizeOnion 只认 'fade'，'dim' 会被归一成 'tint'（既有分裂，
    // 不在本 task 范围，已单独报给 lead）。
    assert.deepEqual(idsUnder(zhTable, 'onion.mode.'), ['dim', 'tint']);
});

test('落盘值不许改：时间通道的 mode 只有 none / loop / pingpong / clamp', () => {
    assert.deepEqual(idsUnder(zhTable, 'layers.timeMode.'), ['clamp', 'loop', 'none', 'pingpong']);
});

test('曲线通道与时间轴通道都用同一批 id（id 是落盘通道名）', () => {
    const ids = SCALAR_CHANNELS.map((c) => c.id).sort();
    assert.deepEqual(ids, ['opacity', 'rotate', 'scaleX', 'scaleY', 'skewX', 'skewY', 'x', 'y']);
    // 三条清单（变换通道表 / 曲线显示名 / 时间轴摘要显示名）必须一一对应，否则会漏词。
    assert.deepEqual(idsUnder(zhTable, 'curve.channel.'), ids);
    assert.deepEqual(idsUnder(zhTable, 'timeline.state.'), ids);
});

test('props.section.* 只有两段，键与 panels 的段 key 同名', () => {
    assert.deepEqual(idsUnder(zhTable, 'props.section.'), ['doc', 'object']);
});

test('playback.mode.* 每个 id 都有 label + hint，且不多不少', () => {
    const expect = [];
    for (const id of PLAY_MODE_IDS) {
        expect.push(id + '.hint', id + '.label');
    }
    expect.sort();
    assert.deepEqual(idsUnder(enTable, 'playback.mode.'), expect);
    assert.deepEqual(idsUnder(zhTable, 'playback.mode.'), expect);
});

test('显示名是现取的：切语言后 label 变，id 不变', () => {
    withLocale('zh-Hans', () => {
        assert.equal(SCALAR_CHANNELS[0].label, '位置 X');
        assert.equal(modeInfo('pingpong').label, '来回');
        assert.equal(modeInfo('none').hint, '播到末尾就停');
    });
    withLocale('en', () => {
        assert.equal(SCALAR_CHANNELS[0].label, 'Position X');
        assert.equal(modeInfo('pingpong').label, 'Ping-pong');
        assert.equal(modeInfo('pingpong').id, 'pingpong', 'id 是落盘值，不随语言变');
    });
});

test('keySummary：读数按当前语言拼，切回英文不再出现中文', () => {
    withLocale('zh-Hans', () => {
        const s = keySummary({ x: 10 });
        assert.ok(s.includes('位移 X=10'), '中文读数不对：' + s);
    });
    withLocale('en', () => {
        const s = keySummary({ x: 10 });
        assert.ok(s.includes('Move X=10'), '英文读数不对：' + s);
        // 单位与数字之外不该再漏中文（这条会在漏迁一个词时立刻红）
        assert.ok(!HAN.test(s), '英文读数里还有中文：' + s);
    });
});

test('t() 不带兜底时，面板用到的每个键都真能在两表里取到', () => {
    // 面板源码里一律写 `t(key)` 不给第二参：漏一条词条就会把键名直接显示给用户。
    // 这里把本片的键逐条过一遍，zh / en 都要有非空值（值等于键名本身就说明缺词）。
    const keys = Object.keys(enTable);
    withLocale('zh-Hans', () => {
        for (const k of keys) assert.notEqual(t(k), k, k + ' 在 zh-Hans 里缺词（t() 退回了键名）');
    });
    withLocale('en', () => {
        for (const k of keys) assert.notEqual(t(k), k, k + ' 在 en 里缺词（t() 退回了键名）');
    });
});
