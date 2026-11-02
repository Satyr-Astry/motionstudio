// 曲线编辑器打出来的时刻必须落在整帧上：曲线按「秒」定位、时间轴按「帧」定位，
// 中间不吸帧的话，同一个关键帧在帧带里会落在两帧之间（看起来就是「不同步」）。
//
// 这里钉两件事：① 落点换算的语义 ② curve.mjs 的接线（双击与拖拽两条路径都过 snapFrame）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { snapFrame } from '../app/editors/timeline-geo.mjs';
// B2 通道折叠的纯函数：curve.mjs 在 Node 里可直接 import（mount 之外的模块顶层零 DOM）
import { foldSummary, toggleFold } from '../app/editors/curve.mjs';
import { t } from '../app/i18n/index.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const src = read('../app/editors/curve.mjs');
const doc = (fps) => ({ width: 100, height: 100, fps, duration: 1, objects: [] });

test('曲线落点：真机取证的两个非帧时刻会被吸到整帧', () => {
    // 改前实测：双击曲线画布 42% / 72% 处得到的 t 是这两个值（乘 12 得 4.661 / 8.802 帧）。
    // 这两个数字是缺陷的原始证据，不能改：它们必须吸成 5 帧与 9 帧。
    const d = doc(12);
    assert.ok(Math.abs(snapFrame(d, 0.3884297520661157) - 5 / 12) < 1e-12);
    assert.ok(Math.abs(snapFrame(d, 0.7334710743801653) - 9 / 12) < 1e-12);
});

test('曲线落点：任意时刻吸附后乘 fps 都是整数（时间轴按这个数定位菱形）', () => {
    const d = doc(12);
    for (let i = 0; i <= 400; i += 1) {
        const t = snapFrame(d, i / 397); // 397 与 12 互质，扫到的基本都是非帧时刻
        const frame = t * 12;
        assert.ok(Math.abs(frame - Math.round(frame)) < 1e-9, '未吸到整帧：t=' + t + ' → ' + frame);
    }
});

test('曲线落点：吸附结果不含浮点毛刺（写回文档的 t 要能直接比较）', () => {
    const d = doc(12);
    // Math.round(v*fps)/fps 的既有实现：5/12 这类值参与 JSON 往返后仍相等
    const t = snapFrame(d, 0.3884297520661157);
    assert.equal(JSON.parse(JSON.stringify({ t })).t, t);
    assert.equal(snapFrame(d, t), t, '吸附必须幂等');
});

// 判定变更记录（0.1.2-alpha.9）：曲线曾经自己写一套「无条件吸帧、Shift 吸纹理」，
// 与时间轴的「磁铁开=吸帧 / Shift=关磁铁（可落两帧之间）/ 磁铁关=自由 / Shift=吸 0.1s 网格」不一致 ——
// 同一个关键帧在两个面板拖到同一像素位置会落到不同时刻。现在两边共用
// `snapForDrag(doc, t, e, snapOn)`（`app/editors/timeline-geo.mjs`），这三条接线断言随之改口径。
test('curve.mjs 接线：双击加点也过 snapTime（与时间轴双击泳道同一套吸附）', () => {
    assert.match(src, /const t = snapTime\(xToT\(geo, x\), ev\);/, '双击落点必须过 snapTime');
    // 写回用的是吸附后的 t，不是原始的 xToT 结果；值显式取该时刻的当前求值
    // （效果参数通道的 stateAt 不含它，省略 value 会变成 0）
    assert.match(src, /const v = sampleChannel\(track, t, focus\);/, '加点必须先取当前值');
    assert.match(src, /setChannelKey\(old, focus, t, v, 'bezier'\)/, '补帧写入吸附后的 t 与当前值');
    assert.match(src, /addKey\(old, t, stateAt\(track, t\), 'bezier'\)/);
});

test('curve.mjs 接线：本地 snapTime 委托给 timeline-geo 的 snapForDrag', () => {
    const body = src.slice(src.indexOf('function snapTime(t, ev)'), src.indexOf('/* ── 指针交互 ──'));
    assert.match(body, /snapForDrag\(doc, t, ev, snapOnNow\(\)\)/, '必须走共用的吸附判据');
    assert.ok(!/geoSnapTime/.test(src), '旧的「Shift 吸纹理」口径要彻底消失，别再留第二条吸附语义');
});

test('curve.mjs 接线：拖拽关键帧仍走 snapTime（不能绕过吸附直接写 xToT）', () => {
    assert.match(src, /const t = snapTime\(xToT\(geo, x\), ev\);/, '拖拽分支必须过 snapTime');
});

test('curve.mjs 接线：吸附与磁铁都从 timeline-geo 导入，不重复实现', () => {
    assert.match(src, /import \{ snapForDrag \} from '\.\/timeline-geo\.mjs';/);
    assert.ok(!/function snapFrame/.test(src), '不许在 curve.mjs 里另写一份吸帧实现');
    assert.ok(!/function magnetOf/.test(src), '磁铁判据也只许有一份');
});

// ── B2：曲线通道折叠成「已选 N 条」 ─────────────────────────────
//
// 折叠是**纯显示态**：数一遍 focus + refs、取一遍名字，不改选择集、不动 refs。
// 所以 0 / 1 / 多通道由 `foldSummary` 单测钉死，DOM 接线只用源码守卫钉住「别顺手改数据」。

const nameOf = (id) => id.toUpperCase();

test('折叠摘要：0 条是空摘要，只剩聚焦 1 条时摘要就是通道名', () => {
    const none = foldSummary(null, [], nameOf);
    assert.equal(none.count, 0);
    assert.equal(none.focusName, '');
    assert.deepEqual(none.refNames, []);
    assert.deepEqual(none.ids, []);
    assert.equal(none.text, '', '没有通道就没有可报的数');

    const one = foldSummary('x', [], nameOf);
    assert.equal(one.count, 1);
    assert.equal(one.focusName, 'X');
    assert.deepEqual(one.refNames, []);
    assert.equal(one.text, 'X', '「已选 1 条」没有信息量，直接显示通道名');
});

test('折叠摘要：多通道报「已选 N 条」，英文优先（默认 locale = en）', () => {
    const sum = foldSummary('x', ['y', 'rotate'], nameOf);
    assert.equal(sum.count, 3);
    assert.equal(sum.focusName, 'X');
    assert.deepEqual(sum.refNames, ['Y', 'ROTATE']);
    assert.equal(sum.text, t('curve.fold.selected', { n: 3 }));
    assert.equal(sum.text, 'Selected 3 channels');
});

test('折叠摘要：refs 去重、focus 不重复计数，脏值安静跳过', () => {
    const dup = foldSummary('x', ['y', 'y', 'rotate'], nameOf);
    assert.equal(dup.count, 3, '同一个参考通道只算一条');
    assert.deepEqual(dup.refNames, ['Y', 'ROTATE']);

    // focus 同时出现在 refs 里（比如 Shift+点漏了早退）：它算焦点，不算参考线
    const overlap = foldSummary('x', new Set(['x', 'y']), nameOf);
    assert.equal(overlap.count, 2);
    assert.deepEqual(overlap.refNames, ['Y'], 'focus 不算参考线');

    const junk = foldSummary('x', [null, '', 42, 'y'], nameOf);
    assert.equal(junk.count, 2, '非字符串 / 空 id 不参与计数');
    assert.deepEqual(junk.refNames, ['Y']);
});

test('折叠摘要：只读 —— 不修改传入的 refs 集合（折叠与参考线相互独立）', () => {
    const refs = new Set(['y']);
    const sum = foldSummary('x', refs, nameOf);
    assert.equal(sum.count, 2);
    assert.deepEqual([...refs], ['y'], '折叠摘要不许增删参考线');
    // 同一组输入再算一次结果不变（纯函数）
    assert.deepEqual(foldSummary('x', refs, nameOf), sum);
});

test('折叠判定：点一下翻面，非真值按当前展开处理', () => {
    assert.equal(toggleFold(false), true);
    assert.equal(toggleFold(true), false);
    assert.equal(toggleFold(undefined), true);
    assert.equal(toggleFold(null), true);
});

test('curve.mjs 接线：折叠只切显示，不碰选择集 / refs / 绘制区', () => {
    const body = src.slice(src.indexOf('/* ── 折叠 chrome'), src.indexOf('/* ── 命中 ── */'));
    assert.ok(body.length > 0, '找不到折叠 chrome 段');
    assert.ok(!/setSel\(/.test(body), '折叠不许清选择集');
    assert.ok(!/refs\.(?:add|delete|clear)/.test(body), '折叠不许增删参考线');
    assert.ok(!/paintCanvas|writeTrack/.test(body), '折叠不许另写绘制 / 写盘路径');
    // 图标只复用现有 chevron，语义走 aria
    assert.match(src, /icon\(folded \? 'chevron-down' : 'chevron-up'\)/);
    assert.match(src, /setAttribute\('aria-expanded'/);
    assert.match(src, /'curve\.fold\.collapse'/);
    assert.match(src, /'curve\.fold\.expand'/);
    // 列表与摘要行互斥，且两边都显式收回 [hidden]
    assert.match(src, /chList\.hidden = folded/);
    assert.match(src, /foldRow\.hidden = !folded/);
    // 折叠态是 mount 闭包变量：refresh() 里不许重置（重挂才重置）
    const refresh = src.slice(src.indexOf('refresh() {'), src.indexOf('refresh() {') + 120);
    assert.ok(!/folded\s*=/.test(refresh), 'refresh() 不许重置折叠态（跨 refresh 要保持）');
    assert.match(src, /let folded = false;/, '折叠态必须是 mount 闭包变量');
});

/* ─────────── B1：通道配色（时间轴独立通道键与曲线共用一张色表） ─────────── */

test('channelColorOf：8 条标量通道各有稳定颜色，未知通道退回中性色', async () => {
    const { channelColorOf, SCALAR_CHANNELS, CHANNEL_COLOR_FALLBACK } = await import('../app/editors/curve-geo.mjs');
    const seen = new Set();
    for (const ch of SCALAR_CHANNELS) {
        const color = channelColorOf(ch.id);
        assert.match(color, /^#[0-9a-f]{6}$/i, ch.id + ' 的颜色应是 6 位 hex');
        assert.equal(color, ch.color, ch.id + ' 必须返回色表里的颜色（时间轴与曲线同色）');
        assert.ok(!seen.has(color.toLowerCase()), '两条通道不许同色：' + ch.id);
        seen.add(color.toLowerCase());
    }
    // 未知 / 脏输入不抛，退回中性色（时间轴遇到新通道也不会画出透明键）
    assert.equal(channelColorOf('nope'), CHANNEL_COLOR_FALLBACK);
    assert.equal(channelColorOf(''), CHANNEL_COLOR_FALLBACK);
    assert.equal(channelColorOf(null), CHANNEL_COLOR_FALLBACK);
    assert.equal(channelColorOf(42), CHANNEL_COLOR_FALLBACK);
});

test('时间轴独立通道键按通道上色 + 图例解释空心菱形（接线守卫）', async () => {
    const { LEGEND_ITEMS } = await import('../app/editors/help.mjs');
    const paint = read('../app/editors/timeline-paint.mjs');
    // 色来自同一张表，不许在时间轴里另写一份色值（0.8.0 起同时取效果通道条目与时刻）
    assert.match(paint, /import \{ channelColorOf, effectChannelEntries, effectKeyTimes \} from '\.\/curve-geo\.mjs'/);
    assert.match(paint, /node\.style\.setProperty\('--ch', chColor\)/, '通道键必须把 --ch 设成通道色');
    assert.match(paint, /channelColorOf\(p\.fields\[0\]\)/, '多通道合并的键按第一个通道上色');
    // 图例里有一条「通道键」，否则用户不知道空心菱形是什么
    const ch = LEGEND_ITEMS.find((it) => it.kind === 'ch');
    assert.ok(ch, '图例缺「通道键」条目');
    assert.equal(ch.mark, '◇');
    assert.match(ch.name, /channel/i);
});

/* ─────────── 效果参数通道：接入曲线（新问题：effect 变化进不了曲线） ─────────── */

import { buildCurveModel, splitCurveModel } from '../app/editors/curve.mjs';
import { EFFECT_DEFS } from '../app/paint/effects.mjs';

const FX_TR = (key, vars) => (vars && vars.name ? key + ':' + vars.name : key);

function fxLayer() {
    return {
        id: 'L1',
        transform: {
            keys: [{ t: 0, state: { x: 0 }, ease: 'linear', h1: [0.3, 0], h2: [0.7, 1] }],
            channels: { rotate: { keys: [{ t: 0.5, value: 30, ease: 'linear', h1: [0.3, 0], h2: [0.7, 1] }] } },
        },
        effects: [
            {
                id: 'fx-1',
                type: 'blur',
                amount: 3,
                tracks: {
                    amount: {
                        keys: [
                            { t: 0, ease: 'linear', h1: [0.3, 0], h2: [0.7, 1], state: { x: 2 } },
                            { t: 1, ease: 'bezier', h1: [0.1, 0.2], h2: [0.8, 0.9], state: { x: 8 } },
                        ],
                    },
                },
            },
            // 第二条效果没有轨道：不该出现在曲线里
            { id: 'fx-2', type: 'glow', amount: 4, color: '#ffffff' },
        ],
    };
}

test('buildCurveModel：只把「已打过帧」的效果参数接成通道，同类多实例不撞车', () => {
    const layer = fxLayer();
    const model = buildCurveModel(layer, EFFECT_DEFS, FX_TR);
    assert.deepEqual(Object.keys(model.channels), ['rotate', 'fx.fx-1.amount'], '共用通道 + 唯一有轨道的效果参数');
    assert.equal(model.channels['fx.fx-1.amount'].keys.length, 2);
    assert.deepEqual(model.channels['fx.fx-1.amount'].keys.map((k) => k.value), [2, 8], '值从 state.x 摊平成 value');
    assert.equal(model.effectGroups.length, 1);
    assert.deepEqual(model.effectGroups[0].list.map((c) => c.id), ['fx.fx-1.amount']);
    assert.match(model.effectGroups[0].title, /effect\.blur\.name/);
    assert.match(model.channelMeta['fx.fx-1.amount'].label, /effect\.blur\.param\.amount/);
    assert.equal(model.channelMeta['fx.fx-1.amount'].min, 0);
    assert.equal(model.channelMeta['fx.fx-1.amount'].max, 40);
});

test('buildCurveModel：没有效果 / 空对象时原样返回 transform（不伪造通道）', () => {
    const plain = { id: 'L2', transform: { keys: [{ t: 0, state: {} }] } };
    assert.equal(buildCurveModel(plain, EFFECT_DEFS, FX_TR).channels, undefined, '没有效果就不加通道层');
    const empty = buildCurveModel(null, EFFECT_DEFS, FX_TR);
    assert.deepEqual(empty, { keys: [] });
});

test('splitCurveModel：效果通道写回 effect.tracks（state.x），别的效果对象不被重建', () => {
    const layer = fxLayer();
    const model = buildCurveModel(layer, EFFECT_DEFS, FX_TR);
    const next = Object.assign({}, model, { channels: Object.assign({}, model.channels) });
    next.channels['fx.fx-1.amount'] = {
        keys: [
            { t: 0, ease: 'linear', h1: [0.3, 0], h2: [0.7, 1], value: 2 },
            { t: 1.5, ease: 'hold', h1: [0.3, 0], h2: [0.7, 1], value: 12 },
        ],
    };
    const patch = splitCurveModel(layer, next, EFFECT_DEFS);
    assert.ok(patch.effects, '效果轨道变了就必须带 effects 补丁');
    assert.deepEqual(patch.effects[0].tracks.amount.keys.map((k) => [k.t, k.state.x]), [[0, 2], [1.5, 12]]);
    assert.equal(patch.effects[0].tracks.amount.keys[1].ease, 'hold', '缓动跟着通道键走');
    assert.equal(patch.effects[1], layer.effects[1], '没动过的效果不重建对象（少一次无谓撤销）');
    // transform 侧只保留 TRACK_FIELDS 的通道：效果通道绝不能漏进 transform.channels
    assert.deepEqual(Object.keys(patch.transform.channels), ['rotate']);
    assert.equal(patch.transform.keys, next.keys);
});

test('splitCurveModel：清空某效果参数的通道 = 删掉它的轨道（与属性面板「清除关键帧」同义）', () => {
    const layer = fxLayer();
    const model = buildCurveModel(layer, EFFECT_DEFS, FX_TR);
    const next = Object.assign({}, model, { channels: Object.assign({}, model.channels, { 'fx.fx-1.amount': { keys: [] } }) });
    const patch = splitCurveModel(layer, next, EFFECT_DEFS);
    assert.equal(patch.effects[0].tracks, undefined, '参数轨道应被删掉');
    assert.equal(patch.effects[0].id, 'fx-1', '效果本身还在（只是回到静态参数）');
});

test('curve.mjs 接线：效果通道走适配器（读在 buildCurveModel、写在 splitCurveModel）', () => {
    const src = read('../app/editors/curve.mjs');
    assert.match(src, /function trackOf\(layer\) \{\s*const model = buildCurveModel\(layer, EFFECT_DEFS, tr\);/);
    assert.match(src, /return splitCurveModel\(layer, model, EFFECT_DEFS\);/);
    // 通道面板要按效果分组重建（效果轨道变化时）
    assert.match(src, /for \(const g of model\.effectGroups \|\| \[\]\) group\(g\.title, g\.list\)/);
    assert.match(src, /function effectSigOf\(layer\)/);
    // 效果参数没有「回到共用」：菜单项对效果通道隐藏
    assert.match(src, /if \(solo && !isEffectChannelId\(focus\)\) m\.appendChild\(soloItem/);
});

/* ─────────── 时间轴效果键：与曲线同源（entries / keyTimes / merge） ─────────── */

test('effectChannelEntries：顺序与颜色和 buildCurveModel 完全一致（两边同色同序）', async () => {
    const { effectChannelEntries } = await import('../app/editors/curve-geo.mjs');
    const layer = fxLayer();
    // 再加一条有轨道的参数，验证「顺序即颜色」
    layer.effects[0].tracks.brightness = undefined;
    layer.effects.push({
        id: 'fx-3',
        type: 'adjust',
        tracks: {
            brightness: { keys: [{ t: 0.25, ease: 'linear', h1: [0.3, 0], h2: [0.7, 1], state: { x: 1.2 } }] },
            hue: { keys: [{ t: 0.75, ease: 'linear', h1: [0.3, 0], h2: [0.7, 1], state: { x: 45 } }] },
        },
    });
    const entries = effectChannelEntries(layer.effects, EFFECT_DEFS);
    const model = buildCurveModel(layer, EFFECT_DEFS, FX_TR);
    assert.deepEqual(entries.map((e) => e.id), ['fx.fx-1.amount', 'fx.fx-3.brightness', 'fx.fx-3.hue']);
    for (const e of entries) {
        assert.equal(model.channelMeta[e.id].color, e.color, e.id + ' 曲线与时间轴必须同色');
        assert.deepEqual(model.channels[e.id].keys.map((k) => k.value), e.keys.map((k) => k.value), '值同源');
    }
    // 同一效果的两个参数共享一个分组
    assert.equal(model.effectGroups.length, 2);
    assert.deepEqual(model.effectGroups[1].list.map((c) => c.id), ['fx.fx-3.brightness', 'fx.fx-3.hue']);
});

test('effectKeyTimes：同刻多参数合并成一条，按时间升序；没轨道的参数不出现', async () => {
    const { effectKeyTimes } = await import('../app/editors/curve-geo.mjs');
    const layer = fxLayer();
    layer.effects[0].tracks.amount.keys.push({ t: 0.5, ease: 'linear', h1: [0.3, 0], h2: [0.7, 1], state: { x: 5 } });
    layer.effects[0].tracks.dx = { keys: [{ t: 0.5, ease: 'linear', h1: [0.3, 0], h2: [0.7, 1], state: { x: 3 } }] };
    // blur 没有 dx 参数：上面那条是脏数据，应被无视（只认 def.params）
    layer.effects.push({ id: 'fx-4', type: 'glow', tracks: { amount: { keys: [{ t: 2, ease: 'linear', h1: [0.3, 0], h2: [0.7, 1], state: { x: 1 } }] } } });
    const points = effectKeyTimes(layer.effects, EFFECT_DEFS);
    assert.deepEqual(points.map((p) => p.t), [0, 0.5, 1, 2], '按时间升序、同刻一条');
    const at05 = points.find((p) => p.t === 0.5);
    assert.deepEqual(at05.fields, ['fx.fx-1.amount'], '脏字段被忽略，只剩真正参数');
    assert.deepEqual(effectKeyTimes([], EFFECT_DEFS), []);
    assert.deepEqual(effectKeyTimes(null, EFFECT_DEFS), []);
});

test('mergeChannelPoints：两组时刻按 1e-6 对齐合并、字段去重、升序', async () => {
    const { mergeChannelPoints } = await import('../app/editors/timeline-paint.mjs');
    const a = [{ t: 0, fields: ['rotate'] }, { t: 1, fields: ['x'] }];
    const b = [{ t: 0.0000001, fields: ['fx.fx-1.amount'] }, { t: 2, fields: ['fx.fx-2.amount'] }];
    const out = mergeChannelPoints(a, b);
    assert.deepEqual(out.map((p) => p.t), [0, 1, 2]);
    assert.deepEqual(out[0].fields, ['rotate', 'fx.fx-1.amount'], '同刻合并（按 1e-6 对齐）');
    // 重复字段不重复出现
    const dup = mergeChannelPoints([{ t: 0, fields: ['x'] }], [{ t: 0, fields: ['x', 'y'] }]);
    assert.deepEqual(dup[0].fields, ['x', 'y']);
    assert.deepEqual(mergeChannelPoints([], []), []);
    assert.deepEqual(mergeChannelPoints(null, undefined), []);
});

test('时间轴接线：效果键来自 curve-geo（同源）并合并进通道键渲染', () => {
    const src = read('../app/editors/timeline-paint.mjs');
    assert.match(src, /effectChannelEntries\(obj\.effects, EFFECT_DEFS\)/);
    assert.match(src, /effectKeyTimes\(obj\.effects, EFFECT_DEFS\)/);
    assert.match(src, /mergeChannelPoints\(\s*channelKeyTimes\(trackOf\(obj\), keys\)/, '变换通道键与效果键必须合并渲染');
    assert.match(src, /fxColor\.get\(p\.fields\[0\]\) \|\| channelColorOf\(p\.fields\[0\]\)/, '效果键按同源色表上色');
    assert.match(src, /fxLabel\.get\(id\) \|\| id/, 'tooltip 用可读名而不是 fx.* id');
});
