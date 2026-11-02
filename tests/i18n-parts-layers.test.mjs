// 叠放与曲线词条（P2-C）：`app/i18n/parts/layers.mjs` 这一片的自检。
//
// 这一片横跨五个编辑器模块（叠放列表、曲线面板、曲线几何、曲线画布、拖拽提示），守三件事：
//   1. 两表镜面、键前缀不越界、en 表里不许出现中文 —— 撞键在 index.mjs 里会直接 throw，
//      这里额外把「前缀归属」钉死，免得这个分片悄悄吃掉别的面板的键。
//   2. **落盘值不许跟着翻译走** —— 时间通道的缓动名（`layer.time.ease`）、曲线通道 id、
//      预设 key（linear/in/out/inout/back）都是写进 .msp / 参与判等的，换语言必须一个字符不变，
//      变的只能是显示名。
//   3. 源码里不许再留中文原文 —— 唯一的例外是 `'无时间变换'`：它是 core/timegraph.mjs 的
//      `describeTime()` 返回值，被跨模块用**字符串相等**判「时间变换恒等」，翻译了就判错。
//      也就是说这 3 处是哨兵而不是文案，等 core 导出显式恒等判定之后才能删。
//
// 为什么显示名是「现取」：`setLocale` 只换表、不重建模块常量，所以 `EASE_LABEL`、
// `PLAY_MODES` 里的 label/hint 都是 getter，消费者一行不改就跟着切语言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { DEFAULT_LOCALE, keysOf, setLocale, t } from '../app/i18n/index.mjs';
import layersPart from '../app/i18n/parts/layers.mjs';
import { EASE_LABEL, SCALAR_CHANNELS } from '../app/editors/curve-geo.mjs';

const HAN = /[\u4e00-\u9fff]/;
const PREFIXES = ['layers.', 'curve.', 'dragtip.'];

const zhTable = layersPart['zh-Hans'];
const enTable = layersPart.en;

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

test('layers 分片：两表键集合镜面，且每个键都真的并进了词典', () => {
    assert.deepEqual(Object.keys(enTable).sort(), Object.keys(zhTable).sort(), 'en / zh-Hans 键集合必须镜面');
    const merged = new Set(keysOf('en'));
    for (const k of Object.keys(enTable)) {
        assert.ok(merged.has(k), '词条没并进词典：' + k);
        // t() 在缺失时会回退成 key 本身，这里顺带钉住「不是靠回退假装有词」
        assert.notEqual(t(k), k, '词条取出来还是 key 本身：' + k);
    }
});

test('layers 分片：键前缀只属于叠放 / 曲线 / 拖拽提示三块', () => {
    for (const k of Object.keys(enTable)) {
        assert.ok(
            PREFIXES.some((p) => k.startsWith(p)),
            '这个分片不该出现前缀外的键：' + k
        );
    }
});

test('layers 分片：en 表里不许有中文', () => {
    for (const [k, v] of Object.entries(enTable)) {
        assert.ok(!HAN.test(v), 'en 词条含中文：' + k + ' = ' + v);
    }
});

test('layers 分片：B2 折叠词条两边镜面，默认语言读出来是英文', () => {
    // 英文优先：默认 locale = en，`curve.fold.selected` 必须直接是可读英文句子
    for (const k of ['curve.fold.collapse', 'curve.fold.expand', 'curve.fold.rowHint', 'curve.fold.selected']) {
        assert.equal(typeof enTable[k], 'string', 'en 缺 ' + k);
        assert.equal(typeof zhTable[k], 'string', 'zh-Hans 缺 ' + k);
        assert.equal(t(k, { n: 3 }), enTable[k].replace('{n}', '3'), k + ' 在默认语言下没读出英文');
    }
    assert.equal(t('curve.fold.selected', { n: 3 }), 'Selected 3 channels');
});

test('layers 分片：中文原文逐字未变（翻译时顺手改词就红）', () => {
    // 抽样钉死：动作标题、拖拽拒绝原因、时间通道浮层、行尾提示、通知、曲线提示。
    // 期望值就是词条化之前 layers.mjs / curve.mjs 里的原话。
    const expected = {
        'layers.act.add': '新建对象',
        'layers.act.dup': '复制对象',
        'layers.act.up': '上移一层',
        'layers.act.down': '下移一层',
        'layers.act.merge': '向下合并（结果会落到下层对象的坐标系）',
        'layers.act.del': '删除对象',
        'layers.drop.self': '不能拖到自身',
        'layers.empty': '还没有对象。点上方 ＋ 新建，或用「导入」放一张图进来。',
        'layers.tp.mode': '模式',
        'layers.tp.ease': '缓动',
        'layers.tp.offset': '偏移 s',
        'layers.tp.scale': '倍率 ×',
        'layers.timeEase.linear': '匀速',
        'layers.timeEase.in': '渐快',
        'layers.timeEase.out': '渐慢',
        'layers.timeEase.inout': '缓入缓出',
        'curve.ease.linear': '线性',
        'curve.ease.bezier': '贝塞尔',
        'curve.ease.hold': '保持',
        'curve.group.transform': '变换',
        'curve.group.warp': '网格顶点',
        'curve.canvas.solo': '独立',
        'curve.canvas.sameTime': '同刻',
        'curve.menu.deleteKey': '删除关键帧',
        // B2 通道折叠（0.6.1）：新增词条的原文一并钉死，改一个字就红
        'curve.fold.collapse': '把通道列表收成「已选 N 条」',
        'curve.fold.expand': '展开完整通道列表',
        'curve.fold.rowHint': '已选通道 · 点击展开完整列表',
        'curve.fold.selected': '已选 {n} 条通道',
        'dragtip.snap.frame': '吸附:帧',
        'dragtip.snap.grid': '吸附:网格',
        'dragtip.snap.free': '自由',
    };
    for (const [k, wanted] of Object.entries(expected)) {
        const got = zhTable[k];
        assert.equal(got, wanted, k + ' 的原文被改了（期望 ' + wanted + '，实际 ' + got + '）');
    }
});

test('layers 分片：带占位符的词条两边占位符集合一致', () => {
    const PH = /\{(\w+)\}/g;
    const slots = (s) => (s.match(PH) || []).sort().join(',');
    for (const k of Object.keys(enTable)) {
        assert.equal(slots(enTable[k]), slots(zhTable[k]), k + ' 的 {占位符} 两边不一致');
    }
});

// ── 落盘值：换语言也不许动一个字符 ───────────────────────────────

test('落盘值：时间通道缓动名仍是 linear / in / out / inout', () => {
    // 这四个是 `layer.time.ease` 的值，也是这一片里唯一能推断出 id 的全部来源。
    assert.deepEqual(idsUnder(zhTable, 'layers.timeEase.'), ['in', 'inout', 'linear', 'out']);
    // 换语言只换显示名
    withLocale('zh-Hans', () => {
        assert.equal(t('layers.timeEase.inout'), '缓入缓出');
    });
    assert.notEqual(t('layers.timeEase.inout'), '缓入缓出');
});

test('落盘值：曲线缓动名仍是 linear / bezier / hold，显示名随语言变', () => {
    assert.deepEqual(Object.keys(EASE_LABEL).sort(), ['bezier', 'hold', 'linear']);
    withLocale('zh-Hans', () => {
        assert.equal(EASE_LABEL.linear, '线性');
        assert.equal(EASE_LABEL.bezier, '贝塞尔');
        assert.equal(EASE_LABEL.hold, '保持');
    });
    withLocale('en', () => {
        assert.equal(EASE_LABEL.linear, 'Linear');
        assert.equal(EASE_LABEL.bezier, 'Bezier');
        assert.equal(EASE_LABEL.hold, 'Hold');
        assert.deepEqual(Object.keys(EASE_LABEL).sort(), ['bezier', 'hold', 'linear'], '切语言不许增删键');
    });
});

test('落盘值：曲线通道 id 与顺序不随词条化改变', () => {
    // 曲线通道 id 是 `track.channels` 的键名（写进 .msp），顺序决定面板行序。
    assert.deepEqual(
        SCALAR_CHANNELS.map((c) => c.id),
        ['x', 'y', 'scaleX', 'scaleY', 'rotate', 'skewX', 'skewY', 'opacity']
    );
    // 显示名是 getter：换语言立刻变，但 id/short/color 不动
    const x = SCALAR_CHANNELS[0];
    assert.equal(x.short, 'X');
    assert.equal(x.color, '#e0556b');
    withLocale('zh-Hans', () => {
        assert.equal(SCALAR_CHANNELS[0].label, '位置 X');
    });
    assert.notEqual(SCALAR_CHANNELS[0].label, '位置 X');
});

test('落盘值：曲线预设有五个 key，auto 是第六条（glyph + label 成对）', () => {
    assert.deepEqual(
        idsUnder(zhTable, 'curve.preset.').filter((k) => k.endsWith('.label')).map((k) => k.slice(0, -6)),
        ['back', 'in', 'inout', 'linear', 'out']
    );
    for (const key of ['back', 'in', 'inout', 'linear', 'out']) {
        assert.ok(zhTable['curve.preset.' + key + '.glyph'], key + ' 缺单字');
        assert.equal(zhTable['curve.preset.' + key + '.glyph'].length, 1, key + ' 的单字必须真的是一个字');
    }
    assert.equal(zhTable['curve.preset.auto.glyph'], '自');
});

// ── 源码守卫：中文原文必须已经搬走 ───────────────────────────

/** 复刻 _check-i18n.mjs 的口径：跳整行注释、剥行内 `//`，再取字符串字面量。 */
function hanLiterals(src) {
    const STR = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
    const out = [];
    for (const raw of src.split('\n')) {
        const trimmed = raw.trim();
        if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) continue;
        const line = raw.replace(/\/\/.*$/, '');
        for (const m of line.match(STR) || []) {
            if (HAN.test(m)) out.push(m);
        }
    }
    return out;
}

test('源码守卫：五个面板文件里只剩「无时间变换」这一条哨兵中文', () => {
    // 它是 core/timegraph.mjs 的 describeTime() 返回值，被跨模块用字符串相等判恒等，
    // 翻译了就判错 —— 所以它必须**留在源码里**，也必须是唯一留下的中文。
    const FILES = [
        '../app/editors/layers.mjs',
        '../app/editors/curve.mjs',
        '../app/editors/curve-geo.mjs',
        '../app/editors/curve-draw.mjs',
        '../app/editors/drag-tip.mjs',
    ];
    const left = [];
    for (const rel of FILES) {
        const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
        for (const lit of hanLiterals(src)) left.push(rel + ' → ' + lit);
    }
    const unexpected = left.filter((s) => !s.endsWith("→ '无时间变换'"));
    assert.deepEqual(unexpected, [], '这些中文原文还没搬进词条表');
    assert.equal(left.length, 3, '哨兵应恰好三处（curve / curve-draw / layers 各一），实际 ' + left.length);
});

// 这五个文件把 i18n 的 `t` 导入了，但 layers.mjs 是**别名成 `tr`** 的（因为
// `syncRows(doc, active, sel, t)` 的形参 `t` 是「时刻」）。于是同一份代码里两种写法
// 长得几乎一样，写错一个字母就是 ReferenceError：编译期看不出、`_check-syntax` 看不出、
// `npm test` 也看不出（没人加载 DOM），只有真的把面板挂起来才炸 —— 已经炸过一次
// （`layers.mjs` 工具条的 `t(titleKey)`，整个叠放面板起不来）。
// 所以这里按「每个文件到底 import 的是哪个名字」分别钉住调用点。
test('源码守卫：i18n 的 t 被别名成 tr 时，调用点不许再写 t(', () => {
    const ALIASED = {
        '../app/editors/layers.mjs': 'tr',
    };
    for (const [rel, alias] of Object.entries(ALIASED)) {
        const src = readFileSync(new URL(rel, import.meta.url), 'utf8');
        // 该文件确实把 i18n 的 t 别名成了 alias
        assert.match(
            src,
            new RegExp("import\\s*\\{\\s*t\\s+as\\s+" + alias + "\\s*\\}\\s*from\\s*'\\.\\./i18n/index\\.mjs'"),
            rel + ' 的 i18n 导入应当仍是 `t as ' + alias + '`'
        );
        // 全文不许出现裸的 t(...) 调用：既没有那个绑定，也不会被任何形参接住
        const bare = src.split('\n')
            .map((line, i) => ({ line: line, no: i + 1 }))
            .filter((x) => !/^\s*(\/\/|\*|\/\*)/.test(x.line))
            .filter((x) => /(^|[^\w.$])t\(/.test(x.line));
        assert.deepEqual(
            bare.map((x) => rel + ':' + x.no + ' → ' + x.line.trim()),
            [],
            rel + ' 里出现了裸的 t( 调用，但该文件没有名为 t 的绑定（i18n 的 t 叫 ' + alias + '）'
        );
        // 正向：别名确实在被用来取词
        assert.ok(
            new RegExp('(^|[^\\w.$])' + alias + '\\(\\s*\'[a-z]').test(src),
            rel + ' 里没有用 ' + alias + '() 取过词，别名是否已经失效？'
        );
    }
});
