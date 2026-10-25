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

import { makeObject } from '../app/core/doc-model.mjs';
import { ICON_NAMES } from '../app/core/icons.mjs';
import {
    ACTION_HINTS,
    EMPTY_TEXTURE_TEXT,
    TEXTURE_ACTIONS,
    TEXTURE_ALIGN,
    TEXTURE_SIZE_MAX,
    actionBlocked,
    deleteCandidateId,
    parseTextureSize,
    resizePayload,
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

test('TEXTURE_ACTIONS：四个动作、顺序固定（新建 / 独特化 / 删除 / 裁到内容）', () => {
    assert.deepEqual(TEXTURE_ACTIONS.map((a) => a.id), ['new', 'unique', 'delete', 'trim']);
    assert.deepEqual(
        TEXTURE_ACTIONS.map((a) => a.icon),
        ['image-plus', 'copy', 'trash', 'crop-content'],
    );
    for (const a of TEXTURE_ACTIONS) {
        assert.ok(ICON_NAMES.includes(a.icon), 'ICON_NAMES 里没有 ' + a.icon);
        assert.equal(typeof a.title, 'string');
        assert.ok(a.title.length >= 2, a.id + ' 的标题太短');
    }
});

test('TEXTURE_ACTIONS：每个动作都有悬停说明，且没有画格字样（术语是「纹理」）', () => {
    for (const a of TEXTURE_ACTIONS) {
        assert.ok(ACTION_HINTS[a.id], a.id + ' 缺 ACTION_HINTS');
        assert.ok(!/画格|画格库/.test(ACTION_HINTS[a.id]), a.id + ' 的说明里出现了「画格」');
        assert.ok(!/画格/.test(a.title), a.id + ' 的标题里出现了「画格」');
    }
});

test('TEXTURE_ALIGN：三档，值名与 shell 的 alignOffset 一致（nw / c / se）', () => {
    assert.deepEqual(TEXTURE_ALIGN.map(([v]) => v), ['nw', 'c', 'se']);
    assert.deepEqual(TEXTURE_ALIGN.map(([, t]) => t), ['左上', '居中', '右下']);
});

test('TEXTURE_SIZE_MAX：与 shell 裁尺寸的上限一致（4096）', () => {
    assert.equal(TEXTURE_SIZE_MAX, 4096);
});

test('textureSummary：没有对象 → 空态文案，且不带任何数字', () => {
    const s = textureSummary(null, 0);
    assert.equal(s.empty, true);
    assert.equal(s.count, 0);
    assert.equal(s.index, -1);
    assert.equal(s.text, EMPTY_TEXTURE_TEXT);
});

test('textureSummary：对象没有纹理（空画格）→ 仍是空态', () => {
    const obj = objectWith([[0, null]]);
    const s = textureSummary(obj, 0);
    assert.equal(s.empty, true);
    assert.equal(s.count, 0);
    assert.equal(s.text, EMPTY_TEXTURE_TEXT);
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
    assert.equal(s.text, '共 2 张 · 当前第 1 张 · 曝光 3 处');
    // 2s 命中第二张
    assert.equal(textureSummary(obj, 2).text, '共 2 张 · 当前第 2 张 · 曝光 3 处');
    assert.equal(textureSummary(obj, 2).index, 1);
});

test('textureSummary：落在所有曝光之前 → 明说「当前时刻没有曝光」，不出现「第 0 张」', () => {
    const obj = objectWith([[5, fakeImage(8, 8, 'late')]]);
    const s = textureSummary(obj, 0);
    assert.equal(s.count, 1);
    assert.equal(s.index, -1, '这一刻没有命中，就不该报第几张');
    assert.equal(s.text, '共 1 张 · 曝光 1 处 · 当前时刻没有曝光');
    assert.ok(!/第 0 张/.test(s.text), s.text);
    // 到 5s 就正常了
    assert.equal(textureSummary(obj, 5).text, '共 1 张 · 当前第 1 张 · 曝光 1 处');
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
    assert.equal(actionBlocked('new', { hasObj: false, count: 0 }), '还没有可编辑的对象');
    assert.equal(actionBlocked('new', { hasObj: true, count: 0 }), '', '没纹理也能新建');
    assert.equal(actionBlocked('new', { hasObj: true, count: 3 }), '');
});

test('actionBlocked：无纹理时独特化/删除/裁到内容各给一条原因', () => {
    const s = { hasObj: true, count: 0 };
    assert.equal(actionBlocked('unique', s), '当前时刻没有可独特化的纹理');
    assert.equal(actionBlocked('delete', s), '至少要保留一张纹理');
    assert.equal(actionBlocked('trim', s), '当前时刻还没有纹理：先点「新建纹理」新建一张');
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
