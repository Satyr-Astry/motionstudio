// 时间轴 / 时间求值词条（P2-E）：`app/i18n/parts/timeline.mjs` 这一片的自检。
//
// 钉死四件事：
//   1. 两表镜面、键语法、en 无反中文 —— 与其它 i18n 分片同一套规矩。
//   2. 中文原文逐字不变：词条化的目的是把文案搬走，不是顺手改词。
//   3. `describeTime()` 的每个片段都是一整句（含单位、含连接词），不是「状态词 + 单位后缀」
//      两张词条拼起来的 —— 语序不同的语言里拼出来会读不通。
//   4. 落盘值（缓动 id、时间通道 mode）一个字符都不许动。
//
// 另外守一条迁移完整性：四个 timeline*.mjs 里不该再有任何中文字面量；`core/timegraph.mjs`
// 里剩下的中文只允许是 `{ ok:false, reason }` 的诊断文案（那是 API 返回值，被别的测试逐字断言，
// 不在本片范围内 —— 已在报告里单独提给 lead）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEFAULT_LOCALE, keysOf, setLocale, t } from '../app/i18n/index.mjs';
import timelinePart from '../app/i18n/parts/timeline.mjs';
import { TIME_EASES, TIME_MODES, describeTime } from '../app/core/timegraph.mjs';
import { EASE_IDS, easeText, keySummary } from '../app/editors/timeline-geo.mjs';

const HAN = /[\u4e00-\u9fff]/;
const PREFIXES = ['time.', 'timeline.'];
const KEY_SYNTAX = /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/;

const zhTable = timelinePart['zh-Hans'];
const enTable = timelinePart.en;

/** 这一片里以 `prefix` 开头的键，去掉前缀后的有序 id 列表。 */
function idsUnder(table, prefix) {
    return Object.keys(table)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length))
        .sort();
}

/** 在指定语言下跑一段断言，跑完必定回到缺省语言。 */
function withLocale(id, fn) {
    setLocale(id);
    try {
        return fn();
    } finally {
        setLocale(DEFAULT_LOCALE);
    }
}

/** `{name}` 这类占位符集合 —— 两表必须一致，否则一种语言会漏出花括号。 */
function placeholdersOf(text) {
    return [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

/** 行内注释剥掉（与 _check-i18n.mjs 同款），免得注释里的中文被当成字面量。 */
function stripComment(line) {
    let quote = null;
    for (let i = 0; i < line.length; i += 1) {
        const c = line[i];
        if (quote) {
            if (c === '\\') i += 1;
            else if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') quote = c;
        else if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
    }
    return line;
}

/** 源码里所有字符串字面量，附带行号。 */
function stringLiterals(file) {
    const out = [];
    const lines = readFileSync(new URL(file, import.meta.url), 'utf8').split('\n');
    lines.forEach((raw, i) => {
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) return;
        const line = stripComment(raw);
        for (const m of line.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) {
            out.push({ text: m[1] ?? m[2] ?? m[3], line: i + 1, source: line.trim() });
        }
    });
    return out;
}

const TIMELINE_FILES = [
    '../app/editors/timeline.mjs',
    '../app/editors/timeline-geo.mjs',
    '../app/editors/timeline-paint.mjs',
    '../app/editors/timeline-keys.mjs',
];

test('timeline 分片：两表键集合镜面，且每个键都真的并进了词典', () => {
    const enKeys = Object.keys(enTable).sort();
    const zhKeys = Object.keys(zhTable).sort();
    assert.deepEqual(enKeys, zhKeys, 'en 与 zh-Hans 的键集合必须一一对应');
    assert.ok(enKeys.length >= 90, '这一片至少 90 条，实际 ' + enKeys.length);
    assert.deepEqual(Object.keys(enTable), Object.keys(zhTable), '两表的键序也必须一致（同一份表的镜像）');

    const mergedEn = keysOf('en');
    const mergedZh = keysOf('zh-Hans');
    for (const k of enKeys) {
        assert.ok(mergedEn.includes(k), k + ' 没并进 en 词典（parts/index.mjs 注册了吗？）');
        assert.ok(mergedZh.includes(k), k + ' 没并进 zh-Hans 词典');
    }
});

test('timeline 分片：键都落在 time./timeline. 命名空间下，语法合法', () => {
    for (const k of Object.keys(enTable)) {
        assert.ok(PREFIXES.some((p) => k.startsWith(p)), k + ' 不在本片约定的前缀里');
        assert.match(k, KEY_SYNTAX, k + ' 不符合「区域.实体.字段」的键语法（不许连字符）');
    }
});

test('两表的值：en 无中文、无空值；zh 每条是中文；占位符两表一致', () => {
    for (const [k, v] of Object.entries(enTable)) {
        assert.equal(typeof v, 'string', k + ' 必须是字符串');
        assert.ok(v.trim().length > 0, k + ' 是空串');
        assert.ok(!HAN.test(v), k + ' 的英文值是「' + v + '」，en 表里不许有中文');
    }
    for (const [k, v] of Object.entries(zhTable)) {
        assert.equal(typeof v, 'string', k + ' 必须是字符串');
        assert.ok(v.trim().length > 0, k + ' 是空串');
        // 纯符号条目（×{factor}）两表同形，不强制含汉字；其余都必须是中文原文。
        if (k === 'time.speed') continue;
        assert.ok(HAN.test(v), k + ' 的中文值是「' + v + '」，没有汉字说明漏翻了');
        assert.notEqual(v, enTable[k], k + ' 的两种语言值相同，多半是漏翻');
    }
    for (const k of Object.keys(enTable)) {
        assert.deepEqual(placeholdersOf(enTable[k]), placeholdersOf(zhTable[k]), k + ' 的占位符两表不一致');
    }
});

test('zh-Hans：中文原文与词条化之前逐字一致', () => {
    // 左边是硬编码时的原文，右边是词条化后的键 —— 改一个词就算破坏界面文案。
    const ORIGINAL = {
        'time.none': '无时间变换',
        'time.frozen': '冻结在 {sec}s',
        'time.delay': '延后 {sec}s',
        'time.advance': '提前 {sec}s',
        'time.speed': '×{factor}',
        'time.ease.in': '缓动 渐快',
        'time.ease.out': '缓动 渐慢',
        'time.ease.inout': '缓动 先慢后快再慢',
        'time.loop.whole': '循环 全片',
        'time.pingpong.whole': '往返 全片',
        'time.clamp.whole': '夹取 全片',
        'timeline.ease.linear': '线性',
        'timeline.ease.bezier': '贝塞尔',
        'timeline.ease.hold': '保持',
        'timeline.summary.same': '与默认值相同',
        'timeline.notWired': '该操作尚未接线',
        'timeline.notWired.named': '{name}：该操作尚未接线',
        'timeline.callFailed': '{name} 失败：{error}',
        'timeline.duration.positive': '总时长要大于 0 秒',
        'timeline.segmentFps': '第 {index} 段帧率改成 {fps} fps',
        'timeline.snap.on': '磁铁：吸附到整帧',
        'timeline.needLayer': '先选一个对象',
        'timeline.cel.keepOne': '每个对象至少保留一个纹理',
        'timeline.cel.noneAtTime': '该时间没有生效的纹理',
        'timeline.loopMode.set': '播放方式：{label}',
        'timeline.ruler.title': '拖动 = 擦洗时间 · 双击 = 适应全长（整段时长装进视口）',
        'timeline.btn.first': '回到开头（Home）',
        'timeline.btn.prev': '上一帧（←）',
        'timeline.btn.play': '播放 / 暂停（空格）',
        'timeline.btn.next': '下一帧（→）',
        'timeline.btn.last': '跳到结尾（End）',
        'timeline.btn.addcel.text': '再曝光',
        'timeline.btn.delcel.text': '删曝光',
        'timeline.btn.snap.text': '磁铁',
        'timeline.now.title': '当前时间（秒）· 回车跳到该时间',
        'timeline.badge.title': '时间通道：{text}（在对象列表点 ⏱ 可改）',
        'timeline.objectFallback': '对象',
        'timeline.kf.aria': '关键帧',
        'timeline.del.single': '已删除关键帧 t = {t} s',
        'timeline.del.count': '已删除 {n} 颗关键帧',
        'timeline.marquee.done': '已框选 {n} 个关键帧',
        'timeline.marquee.empty': '框选范围内没有关键帧',
        'timeline.menu.copy': '复制关键帧',
        'timeline.menu.pasteKey': '粘贴关键帧到此处',
        'timeline.menu.addTex': '在此加纹理（从此刻起换图）',
        'timeline.copy.first': '先复制一个关键帧（Ctrl+C）',
        'timeline.ease.set': '关键帧缓动：{ease}',
        'timeline.ease.setMany': '{n} 处关键帧缓动：{ease}',
    };
    for (const [k, v] of Object.entries(ORIGINAL)) {
        assert.equal(zhTable[k], v, k + ' 的中文原文被改动了');
    }
});

test('落盘值不许改：缓动 id 仍然只有 linear / bezier / hold', () => {
    assert.deepEqual([...EASE_IDS], ['linear', 'bezier', 'hold']);
    assert.ok(Object.isFrozen(EASE_IDS), 'EASE_IDS 必须冻结，防止被就地改写');
    // timeline.ease.* 里还有 set / setMany 两条动作文案，不算落盘 id。
    const ids = idsUnder(zhTable, 'timeline.ease.').filter((x) => x !== 'set' && x !== 'setMany');
    assert.deepEqual(ids, [...EASE_IDS].sort(), '词条 id 必须与落盘 id 一一对应');
    assert.deepEqual(idsUnder(enTable, 'timeline.ease.').filter((x) => x !== 'set' && x !== 'setMany'), ids);
});

test('落盘值不许改：时间通道 mode 仍然只有 none / loop / pingpong / clamp', () => {
    assert.deepEqual([...TIME_MODES], ['none', 'loop', 'pingpong', 'clamp']);
    assert.deepEqual([...TIME_EASES], ['linear', 'in', 'out', 'inout']);
    // none 是恒等，没有文案；其余三种各有「带区间」「全片」两条。
    for (const m of TIME_MODES.filter((x) => x !== 'none')) {
        assert.ok(zhTable['time.' + m + '.range'], 'time.' + m + '.range 缺词');
        assert.ok(zhTable['time.' + m + '.whole'], 'time.' + m + '.whole 缺词');
    }
});

test('describeTime：每个片段是一整句词条，不是「状态词 + 后缀」拼的', () => {
    withLocale('zh-Hans', () => {
        assert.equal(describeTime(undefined), t('time.none'));
        assert.equal(describeTime({ hold: true, holdAt: 1.25 }), t('time.frozen', { sec: '1.25' }));
        assert.equal(describeTime({ scale: 0, holdAt: 2 }), t('time.frozen', { sec: '2.00' }));
        assert.equal(describeTime({ offset: 1.5 }), t('time.delay', { sec: '1.50' }));
        assert.equal(describeTime({ offset: -0.5 }), t('time.advance', { sec: '0.50' }));
        assert.equal(describeTime({ scale: 2 }), t('time.speed', { factor: 2 }));
        for (const ease of TIME_EASES.filter((e) => e !== 'linear')) {
            assert.equal(describeTime({ ease }), t('time.ease.' + ease), ease + ' 的缓动文案不是整句词条');
        }
        for (const m of TIME_MODES.filter((x) => x !== 'none')) {
            assert.equal(
                describeTime({ mode: m, from: 1, to: 3 }),
                t('time.' + m + '.range', { from: '1.00', to: '3.00' }),
                m + ' 的区间文案不是整句词条',
            );
            assert.equal(describeTime({ mode: m }), t('time.' + m + '.whole'), m + ' 的全片文案不是整句词条');
        }
    });
});

test('describeTime：多项用 · 连接，语序由各语言自己决定', () => {
    withLocale('zh-Hans', () => {
        const combo = describeTime({ offset: 1, scale: 2, mode: 'loop', from: 0, to: 1 });
        assert.equal(
            combo,
            [t('time.delay', { sec: '1.00' }), t('time.speed', { factor: 2 }), t('time.loop.range', { from: '0.00', to: '1.00' })].join(' · '),
        );
        assert.ok(combo.includes('延后 1.00s'), combo);
        assert.equal(combo.split(' · ').length, 3);
    });
});

test('describeTime：切语言立刻换文案，英文里不再漏中文', () => {
    const shape = { offset: 1, scale: 2, ease: 'out', mode: 'pingpong', from: 0, to: 2 };
    const zh = withLocale('zh-Hans', () => describeTime(shape));
    const en = withLocale('en', () => describeTime(shape));
    assert.ok(HAN.test(zh), '中文界面下应有中文：' + zh);
    assert.ok(!HAN.test(en), '英文界面下不许再有中文：' + en);
    assert.notEqual(zh, en);
    // 数字与单位不许被翻译污染
    for (const s of [zh, en]) {
        assert.ok(s.includes('1.00') && s.includes('2.00'), s);
        assert.equal(s.split(' · ').length, 4, '四段：延后 / 速度 / 缓动 / 模式 —— ' + s);
    }
});

test('easeText：显示名现取，未知 id 原样返回，null 变空串', () => {
    withLocale('zh-Hans', () => {
        assert.equal(easeText('linear'), '线性');
        assert.equal(easeText('bezier'), '贝塞尔');
        assert.equal(easeText('hold'), '保持');
    });
    withLocale('en', () => {
        assert.equal(easeText('linear'), 'Linear');
        assert.equal(easeText('hold'), 'Hold');
    });
    assert.equal(easeText('weird'), 'weird');
    assert.equal(easeText(null), '');
    assert.equal(easeText(undefined), '');
});

test('keySummary：兜底文案也走词条，切回英文不再出现中文', () => {
    withLocale('zh-Hans', () => assert.equal(keySummary({}), '与默认值相同'));
    withLocale('en', () => {
        const s = keySummary({});
        assert.equal(s, 'Same as default');
        assert.ok(!HAN.test(s));
    });
});

test('词典与源码双向对齐：源码里没有用不到的键，词典里没有取不到的词', () => {
    // 动态拼出来的六个键（time.<mode>.range/.whole）不在源码字面量里，由 TIME_MODES 推导补上。
    const derived = new Set();
    for (const m of TIME_MODES.filter((x) => x !== 'none')) {
        derived.add('time.' + m + '.range');
        derived.add('time.' + m + '.whole');
    }
    const used = new Set(derived);
    const files = [...TIMELINE_FILES, '../app/core/timegraph.mjs'];
    const declared = new Set(Object.keys(enTable));
    for (const file of files) {
        for (const { text } of stringLiterals(file)) {
            // timeline.state.* 是 panels 分片的键，这里只是引用它的前缀，不算本片词条。
            if (!text || !/^(time|timeline)\.[A-Za-z0-9.]+$/.test(text)) continue;
            if (text.startsWith('timeline.state.')) continue;
            // `loop:'time.loop'` + '.range' 这类拼前缀的中间量不算完整键。
            if (!declared.has(text) && [...declared].some((k) => k.startsWith(text + '.'))) continue;
            used.add(text);
        }
    }
    for (const k of declared) assert.ok(used.has(k), k + ' 是没人用的词条（改文案时漏删了？）');
    for (const k of used) assert.ok(declared.has(k), k + ' 在源码里用了，但词典里没有（会直接显示键名）');
});

test('迁移完整性：四个 timeline*.mjs 里没有中文字面量', () => {
    for (const file of TIMELINE_FILES) {
        for (const { text, line, source } of stringLiterals(file)) {
            assert.ok(!HAN.test(text || ''), file + ':' + line + ' 还留着中文「' + text + '」 → ' + source);
        }
    }
});

test('core/timegraph.mjs 剩下的中文只能是 { ok:false, reason } 诊断文案', () => {
    const left = [];
    for (const { text, line, source } of stringLiterals('../app/core/timegraph.mjs')) {
        if (HAN.test(text || '')) left.push({ text, line, source });
    }
    for (const { text, line, source } of left) {
        assert.match(source, /reason:/, 'timegraph.mjs:' + line + ' 的中文「' + text + '」不在 reason 里 → ' + source);
    }
    assert.ok(left.length > 0, 'reason 文案应仍在（它们被写域外的测试逐字断言，本片未迁移）');
});

test('t() 不带兜底时，本片每个键都真能在两表里取到', () => {
    const keys = Object.keys(enTable);
    withLocale('zh-Hans', () => {
        for (const k of keys) assert.notEqual(t(k), k, k + ' 在 zh-Hans 里缺词');
    });
    withLocale('en', () => {
        for (const k of keys) assert.notEqual(t(k), k, k + ' 在 en 里缺词');
    });
});
