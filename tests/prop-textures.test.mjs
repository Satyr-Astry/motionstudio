/**
 * 纹理属性组的纯逻辑测试（tests/prop-textures.test.mjs）
 *
 * 只测能在 Node 里跑的部分：动作表与图标名、摘要文案、尺寸解析、删除候选、工作区回退。
 * DOM 结构（缩略图绘制、置灰、disabled/title、292px 下的换行与 scrollWidth）不在这里假装，
 * 那些在 CDP 侧量 —— 用 stub 骗过自己的断言没有意义（同 tests/projects-panel.test.mjs 的口径）。
 *
 * 断言里刻意引用 icons.mjs 的 ICON_NAMES：图标名写错时这里先红，
 * 而不是等真机上出现一个空按钮（data-icon-missing 只在控制台喊）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { drawingsOf, makeObject } from '../app/core/doc-model.mjs';
import { ICON_NAMES } from '../app/core/icons.mjs';
import {
    ACTION_HINTS,
    EMPTY_TEXTURE_KEY,
    TEXTURE_ACTIONS,
    TEXTURE_ALIGN,
    TEXTURE_SIZE_MAX,
    actionBlocked,
    deleteCandidateId,
    formatTextureTime,
    parseTextureSize,
    resizePayload,
    textureRowRef,
    textureRows,
    textureSummary,
    trimPayload,
    workspaceSwitchTarget,
} from '../app/editors/prop-textures.mjs';

/** 假位图：core 只认 width/height 与对象身份（drawingIdOf 会给它盖戳）。 */
function fakeImage(w, h, tag) {
    return { width: w, height: h, tag };
}

/** 用 cels 造对象：[[时刻, 图], ...]。 */
function objectWith(pairs) {
    return makeObject({ name: 'A', cels: pairs.map(([at, image]) => ({ at, image })) });
}

/** 造一个「库里有未使用纹理」的对象：cels 是曝光，unused 只进 drawings 库。 */
function objectWithLibrary(pairs, unused) {
    return makeObject({
        name: 'A',
        cels: pairs.map(([at, image]) => ({ at, image })),
        drawings: (unused || []).map((image) => ({ image })),
    });
}

test('TEXTURE_ACTIONS：四个动作、顺序固定（新建 / 独特化 / 删除 / 裁到内容）', () => {
    assert.deepEqual(TEXTURE_ACTIONS.map((a) => a.id), ['new', 'unique', 'delete', 'trim']);
    assert.deepEqual(
        TEXTURE_ACTIONS.map((a) => a.icon),
        ['image-plus', 'copy', 'trash', 'crop-content'],
    );
    for (const a of TEXTURE_ACTIONS) {
        assert.ok(ICON_NAMES.includes(a.icon), 'ICON_NAMES 里没有 ' + a.icon);
        // 标题现在是词条键：原文在 props 分片里，源码不再留中文（取词在渲染处）
        assert.equal(typeof a.titleKey, 'string');
        assert.ok(a.titleKey.startsWith('props.tex.action.'), a.id + ' 的词条键不对：' + a.titleKey);
    }
});

test('TEXTURE_ACTIONS：每个动作都有悬停说明（词条键），术语统一走「纹理」', () => {
    for (const a of TEXTURE_ACTIONS) {
        assert.ok(ACTION_HINTS[a.id], a.id + ' 缺 ACTION_HINTS');
        assert.ok(ACTION_HINTS[a.id].startsWith('props.tex.hint.'), a.id + ' 的说明词条键不对');
        // 「不许出现画格」这条约束现在落在词典里（见 tests/i18n-parts-props.test.mjs）
        assert.ok(!/画格/.test(a.titleKey), a.id + ' 的键里出现了「画格」');
    }
});

test('TEXTURE_ALIGN：三档，值名与 shell 的 alignOffset 一致（nw / c / se）', () => {
    assert.deepEqual(TEXTURE_ALIGN.map(([v]) => v), ['nw', 'c', 'se']);
    assert.deepEqual(TEXTURE_ALIGN.map(([, t]) => t), ['props.tex.align.nw', 'props.tex.align.c', 'props.tex.align.se']);
});

test('TEXTURE_SIZE_MAX：与 shell 裁尺寸的上限一致（4096）', () => {
    assert.equal(TEXTURE_SIZE_MAX, 4096);
});

test('textureSummary：没有对象 → 空态文案，且不带任何数字', () => {
    const s = textureSummary(null, 0);
    assert.equal(s.empty, true);
    assert.equal(s.count, 0);
    assert.equal(s.index, -1);
    assert.equal(s.key, EMPTY_TEXTURE_KEY);
    assert.deepEqual(s.vars, {});
});

test('textureSummary：对象没有纹理（空画格）→ 仍是空态', () => {
    const obj = objectWith([[0, null]]);
    const s = textureSummary(obj, 0);
    assert.equal(s.empty, true);
    assert.equal(s.count, 0);
    assert.equal(s.key, EMPTY_TEXTURE_KEY);
});

test('textureSummary：多张纹理 + 多次曝光 → 「共 N 张 · 当前第 k 张 · 曝光 M 处」', () => {
    const a = fakeImage(8, 8, 'a');
    const b = fakeImage(4, 4, 'b');
    // 0s 用 a，1s 用 a（同一张第二次曝光），2s 用 b
    const obj = objectWith([
        [0, a],
        [1, a],
        [2, b],
    ]);
    const s = textureSummary(obj, 1);
    assert.equal(s.empty, false);
    assert.equal(s.count, 2, '张数按资产去重');
    assert.equal(s.exposures, 3, '曝光次数按时刻计');
    assert.equal(s.index, 0);
    assert.equal(s.key, 'props.tex.summary.count');
    assert.deepEqual(s.vars, { count: 2, k: 1, exposures: 3 });
    // 2s 命中第二张
    assert.equal(textureSummary(obj, 2).key, 'props.tex.summary.count');
    assert.deepEqual(textureSummary(obj, 2).vars, { count: 2, k: 2, exposures: 3 });
    assert.equal(textureSummary(obj, 2).index, 1);
});

test('textureSummary：落在所有曝光之前 → 明说「当前时刻没有曝光」，不出现「第 0 张」', () => {
    const obj = objectWith([[5, fakeImage(8, 8, 'late')]]);
    const s = textureSummary(obj, 0);
    assert.equal(s.count, 1);
    assert.equal(s.index, -1, '这一刻没有命中，就不该报第几张');
    assert.equal(s.key, 'props.tex.summary.noExposure');
    assert.deepEqual(s.vars, { count: 1, exposures: 1 });
    assert.ok(!('k' in s.vars), '这一刻没有命中，词条里就不该有第几张');
    // 到 5s 就正常了
    const late = textureSummary(obj, 5);
    assert.equal(late.key, 'props.tex.summary.count');
    assert.deepEqual(late.vars, { count: 1, k: 1, exposures: 1 });
});

test('parseTextureSize：取整、认 1 与 4096，越界/空/非数字一律 null', () => {
    assert.equal(parseTextureSize(1), 1);
    assert.equal(parseTextureSize('1'), 1);
    assert.equal(parseTextureSize(4096), 4096);
    assert.equal(parseTextureSize('4096'), 4096);
    assert.equal(parseTextureSize(40.4), 40, '四舍五入到整像素');
    assert.equal(parseTextureSize(40.6), 41);
    assert.equal(parseTextureSize(0), null);
    assert.equal(parseTextureSize(4097), null);
    assert.equal(parseTextureSize(-8), null);
    assert.equal(parseTextureSize(''), null);
    assert.equal(parseTextureSize('  '), null);
    assert.equal(parseTextureSize('abc'), null);
    assert.equal(parseTextureSize(null), null);
    assert.equal(parseTextureSize(undefined), null);
    assert.equal(parseTextureSize(NaN), null);
    assert.equal(parseTextureSize(Infinity), null);
});

test('resizePayload：两条边都合法才成型；非法对齐退回居中', () => {
    assert.deepEqual(resizePayload('40', '24', 'nw'), { mode: 'resize', width: 40, height: 24, align: 'nw' });
    assert.deepEqual(resizePayload(40, 24, 'se'), { mode: 'resize', width: 40, height: 24, align: 'se' });
    assert.equal(resizePayload(40, 24, 'se').width, 40);
    // 对齐值非法 / 缺省 → 居中，别把非法值透给 shell
    assert.equal(resizePayload(40, 24, 'bottom').align, 'c');
    assert.equal(resizePayload(40, 24, undefined).align, 'c');
    // 任一边非法 → null（调用方给「尺寸必须是 1–4096 之间的数字」）
    assert.equal(resizePayload('', 24, 'c'), null);
    assert.equal(resizePayload(40, '0', 'c'), null);
    assert.equal(resizePayload(40, 5000, 'c'), null);
});

test('trimPayload：只带 mode，不带宽高（包围盒由 shell 从像素算）', () => {
    assert.deepEqual(trimPayload(), { mode: 'trim' });
    assert.equal(Object.keys(trimPayload()).length, 1);
});

test('actionBlocked：没有对象时先报对象；新建纹理永不被拦', () => {
    assert.equal(actionBlocked('new', { hasObj: false, count: 0 }), 'props.tex.block.noObject');
    assert.equal(actionBlocked('new', { hasObj: true, count: 0 }), '', '没纹理也能新建');
    assert.equal(actionBlocked('new', { hasObj: true, count: 3 }), '');
});

test('actionBlocked：无纹理时独特化/删除/裁到内容各给一条原因', () => {
    const s = { hasObj: true, count: 0 };
    assert.equal(actionBlocked('unique', s), 'props.tex.block.unique');
    assert.equal(actionBlocked('delete', s), 'props.tex.block.delete');
    assert.equal(actionBlocked('trim', s), 'props.tex.block.trim');
    // 有纹理时全部放行
    const ok = { hasObj: true, count: 2 };
    for (const id of ['new', 'unique', 'delete', 'trim']) {
        assert.equal(actionBlocked(id, ok), '', id + ' 不该被拦');
    }
});

test('deleteCandidateId：未使用的最后一张 → 当前显示那张 → 最后一张', () => {
    assert.equal(deleteCandidateId(['d1', 'd2', 'd3'], 'd1', 'd3'), 'd3', '优先删没用到的');
    assert.equal(deleteCandidateId(['d1', 'd2', 'd3'], 'd2', null), 'd2', '否则删当前显示的');
    assert.equal(deleteCandidateId(['d1', 'd2', 'd3'], null, null), 'd3', '都没有就删最后一张');
    assert.equal(deleteCandidateId(['d1'], 'd1', null), 'd1');
    // 传进来的 id 不在库里时不要凭它乱删
    assert.equal(deleteCandidateId(['d1', 'd2'], 'gone', 'alsogone'), 'd2');
    assert.equal(deleteCandidateId([], null, null), null);
    assert.equal(deleteCandidateId(null, 'd1', null), null);
    assert.equal(deleteCandidateId([null, undefined], null, null), null);
});

test('workspaceSwitchTarget：ctx 有 setWorkspace 就用它，否则退 window.motionStudio，都没有返回空串', () => {
    assert.equal(workspaceSwitchTarget({ setWorkspace() {} }), 'ctx');
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'motionStudio');
    const prev = globalThis.motionStudio;
    try {
        globalThis.motionStudio = { setWorkspace() {} };
        assert.equal(workspaceSwitchTarget({}), 'motionStudio');
        assert.equal(workspaceSwitchTarget(null), 'motionStudio');
        // ctx 存在但 setWorkspace 不是函数时也要退
        assert.equal(workspaceSwitchTarget({ setWorkspace: 'no' }), 'motionStudio');
        globalThis.motionStudio = {};
        assert.equal(workspaceSwitchTarget({}), '', '外壳没有暴露能力时要返回空串（调用方给中文提示）');
    } finally {
        if (had) globalThis.motionStudio = prev;
        else delete globalThis.motionStudio;
    }
});

/* ─────────────── 纹理抽屉：行数据（textureRows / textureRowRef） ───────────────
 * 行列表是这次修复的核心：摘要说「当前第 k 张」，用户要能点第 1 张或第 5 张。
 * 这里只测 DOM-free 的数据层；「点行 → ctx.placeDrawing」「两步删除」用下面的源码守卫钉。 */

test('textureRows：没有对象 / 没有纹理 → 空数组（空列表不渲染，空态交给摘要词条）', () => {
    assert.deepEqual(textureRows(null, 0), []);
    assert.deepEqual(textureRows(undefined, 0), []);
    // 只有一张空画格（image null）不是纹理
    assert.deepEqual(textureRows(objectWith([[0, null]]), 0), []);
});

test('textureRows：一行一张纹理，序号 1 起；尺寸 / times / 未使用都来自 drawingsOf', () => {
    const a = fakeImage(8, 8, 'a');
    const b = fakeImage(4, 6, 'b');
    const spare = fakeImage(16, 12, 'spare');
    const obj = objectWithLibrary(
        [
            [0, a],
            [1, a],
            [2, b],
        ],
        [spare],
    );

    const rows = textureRows(obj, 1);
    // 顺序沿用 drawingsOf：首次曝光升序，未使用的排最后
    assert.deepEqual(rows.map((r) => r.id), drawingsOf(obj).map((d) => d.id));
    assert.deepEqual(
        rows.map((r) => [r.index, r.width, r.height, r.times, r.current, r.unused]),
        [
            [1, 8, 8, [0, 1], true, false],
            [2, 4, 6, [2], false, false],
            [3, 16, 12, [], false, true],
        ],
    );
    // 行数据只带 DOM 要用的字段，不把位图对象塞进来
    assert.deepEqual(Object.keys(rows[0]).sort(), [
        'current',
        'height',
        'id',
        'index',
        'times',
        'unused',
        'width',
    ]);
});

test('textureRows：current 跟着时间走；同一张多处曝光时仍算「它就是当前这张」', () => {
    const a = fakeImage(8, 8, 'a');
    const b = fakeImage(4, 4, 'b');
    const obj = objectWithLibrary(
        [
            [0, a],
            [1, a],
            [2, b],
        ],
        [fakeImage(2, 2, 'spare')],
    );
    assert.deepEqual(textureRows(obj, 0).map((r) => r.current), [true, false, false]);
    assert.deepEqual(textureRows(obj, 1).map((r) => r.current), [true, false, false], '第二次曝光还是 a');
    assert.deepEqual(textureRows(obj, 1.5).map((r) => r.current), [true, false, false], '沿用上一张');
    assert.deepEqual(textureRows(obj, 2).map((r) => r.current), [false, true, false]);
    // 早于所有曝光：这一刻没有生效的纹理，任何行都不算当前（与摘要的 noExposure 同口径）
    assert.deepEqual(textureRows(obj, -1).map((r) => r.current), [false, false, false]);
});

test('textureRows：空白曝光（drawing:null）那一刻没有图，不把某一行标成当前', () => {
    const a = fakeImage(8, 8, 'a');
    // 0s 有图、1s 是一次空白曝光（key.drawing = null）
    const obj = objectWith([
        [0, a],
        [1, null],
    ]);
    assert.deepEqual(textureRows(obj, 0).map((r) => r.current), [true]);
    assert.deepEqual(textureRows(obj, 1).map((r) => r.current), [false], '空白曝光不显示任何纹理');
});

test('formatTextureTime：两位小数；非法值退回 0.00', () => {
    assert.equal(formatTextureTime(0), '0.00');
    assert.equal(formatTextureTime(1.5), '1.50');
    assert.equal(formatTextureTime(2), '2.00');
    assert.equal(formatTextureTime('3'), '3.00');
    assert.equal(formatTextureTime(NaN), '0.00');
    assert.equal(formatTextureTime(undefined), '0.00');
});

test('textureRowRef：未使用 / 单处 @t / 多处 @t · N 处（只给 key+var，取词在渲染处）', () => {
    assert.deepEqual(textureRowRef({ times: [] }), { key: 'props.tex.lib.unused', vars: {} });
    assert.deepEqual(textureRowRef({ times: [0] }), { key: 'props.tex.lib.at', vars: { t: '0.00' } });
    assert.deepEqual(textureRowRef({ times: [1.5, 2] }), {
        key: 'props.tex.lib.usesAt',
        vars: { t: '1.50', n: 2 },
    });
    // 没有 times 字段的行也按「未使用」处理，不抛
    assert.deepEqual(textureRowRef({}), { key: 'props.tex.lib.unused', vars: {} });
    assert.deepEqual(textureRowRef(null), { key: 'props.tex.lib.unused', vars: {} });
});

/* ─────────────── 纹理抽屉：源码守卫（DOM 部分 node 测不了，钉接线） ─────────────── */

const PANEL_SRC = readFileSync(new URL('../app/editors/prop-textures.mjs', import.meta.url), 'utf8');
const CSS_SRC = readFileSync(new URL('../app/styles/textures.css', import.meta.url), 'utf8');

test('抽屉已经接在 refresh 上，且展开态是闭包状态（refresh 不重建/不重置）', () => {
    assert.ok(PANEL_SRC.includes('syncDrawer(obj, textureRows(obj, now))'), 'refresh 没接抽屉');
    assert.ok(PANEL_SRC.includes('let openDrawer = false'), '展开态不是闭包变量，refresh 之间保不住');
    assert.ok(PANEL_SRC.includes('openDrawer = !openDrawer'), '缺展开/收起切换');
    // 抽屉 DOM 只建一次，refresh 只换内容（重建列表必须发生在 syncDrawer 里）
    assert.ok(PANEL_SRC.includes('drawer.textContent = '), '重建列表没清空旧行');
});

test('点行 = ctx.placeDrawing（一步撤销）；当前那张不重复写文档', () => {
    assert.ok(PANEL_SRC.includes('ctx.placeDrawing(obj.id, nowTime(ctx), row.id)'), '点行没走 placeDrawing');
    assert.ok(PANEL_SRC.includes('if (row.current) return'), '点当前行会写一条无变化的撤销');
    assert.ok(PANEL_SRC.includes('props.tex.say.placedFail'), '放置失败没有提示');
});

test('行内删除是两步确认 + ctx.removeDrawing，不许一次误删', () => {
    assert.ok(PANEL_SRC.includes('ctx.removeDrawing(obj.id, row.id)'), '行内删除没走 removeDrawing');
    assert.ok(PANEL_SRC.includes('if (pendingDelete !== row.id)'), '删除没有二次确认');
    assert.ok(PANEL_SRC.includes('armDelete(row.id)'), '缺第一次点击的确认态');
    assert.ok(PANEL_SRC.includes("classList.toggle('is-armed'"), '确认态没有视觉状态');
    assert.ok(PANEL_SRC.includes('clearTimeout(confirmTimer)'), '确认态超时/销毁没清理计时器');
    assert.ok(PANEL_SRC.includes('props.tex.say.deletedFail'), '删除失败没有提示');
});

test('样式：抽屉限高滚动，当前行高亮，隐藏态压过 .prop-row 的 display', () => {
    assert.ok(CSS_SRC.includes('.ptx-drawer'), '缺抽屉样式');
    assert.ok(/\.ptx-drawer\s*\{[^}]*max-height:[^;]*;/.test(CSS_SRC), '抽屉没有限高');
    assert.ok(/\.ptx-drawer\s*\{[^}]*overflow-y:\s*auto/.test(CSS_SRC), '抽屉没有滚动');
    assert.ok(CSS_SRC.includes('.ptx-row.is-current'), '当前行没有高亮样式');
    assert.ok(CSS_SRC.includes('.ptx-row-thumb'), '缺行缩略图样式');
    assert.ok(CSS_SRC.includes('.ptx-lib-row[hidden]'), '「库」行 hidden 会被 .prop-row 的 display 压掉');
});
