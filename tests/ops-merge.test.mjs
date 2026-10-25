// 向下合并：合并后的像素必须与「合并前画面上看到的合成」一致。
//
// node 里没有 OffscreenCanvas / document，所以用假画布跑：
// 这里测的不是像素颜色（那要真 canvas，见真机脚本），而是**交给画布的那几件事**
// —— 采样了哪些时刻、两层各自的 CTM 与 alpha 是多少、写回了几个画格。
// 这些正是丢变换/丢不透明的根源，锁住它们比锁几个采样点像素更能防回归。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeDown } from '../app/paint/ops.mjs';
import { createDocument, objectsOf, patchObject, setImageAt, makeKey, celTimes, celAt } from '../app/core/cel.mjs';

/** 假图像：只带尺寸标识，不参与任何绘制。 */
function img(tag, w = 10, h = 10) {
    return { __tag: tag, width: w, height: h };
}

/**
 * 假画布。把调用记进 log，测试只读 log。
 * 记录项：['surface',w,h] / ['transform',a..f] / ['draw',tag,x,y,alpha]
 */
function makeRecorder() {
    const log = [];
    let seq = 0;
    function surface(w, h) {
        seq += 1;
        const id = seq;
        log.push(['surface', w, h]);
        const ctx = {
            globalAlpha: 1,
            globalCompositeOperation: 'source-over',
            filter: 'none',
            save() {},
            restore() {},
            clearRect() {},
            transform(a, b, c, d, e, f) {
                log.push(['transform', a, b, c, d, e, f]);
            },
            drawImage(image, x, y) {
                log.push(['draw', image && image.__tag, x || 0, y || 0, ctx.globalAlpha]);
            },
            beginPath() {},
            moveTo() {},
            lineTo() {},
            closePath() {},
            clip() {},
        };
        const s = { width: w, height: h, id, getContext: () => ctx };
        return s;
    }
    return { log, surface };
}

/** 两层文档：objects[0] 上层、objects[1] 下层。 */
function twoLayers(opts = {}) {
    let doc = createDocument({ width: 20, height: 20, objects: [{ name: '上' }, { name: '下' }] });
    const [up, lo] = objectsOf(doc);
    doc = patchObject(doc, lo.id, (o) => setImageAt(o, 0, img('下图')));
    doc = patchObject(doc, up.id, (o) => setImageAt(o, 0, img('上图')));
    if (opts.lowerAt) doc = patchObject(doc, lo.id, (o) => setImageAt(o, opts.lowerAt, img('下图2')));
    if (opts.upperState) {
        doc = patchObject(doc, up.id, (o) => setKeyState(o, 0, opts.upperState));
    }
    if (opts.lowerState) {
        doc = patchObject(doc, lo.id, (o) => setKeyState(o, 0, opts.lowerState));
    }
    if (opts.upperKeyAt != null) {
        doc = patchObject(doc, up.id, (o) => addKey(o, opts.upperKeyAt, opts.upperKeyState || {}));
    }
    const [up2, lo2] = objectsOf(doc);
    return { doc, upId: up2.id, loId: lo2.id };
}

function setKeyState(obj, t, patch) {
    const keys = (obj.transform.keys || []).map((k) => (
        Math.abs(k.t - t) > 1e-9 ? k : Object.assign({}, k, { state: Object.assign({}, k.state, patch) })
    ));
    return Object.assign({}, obj, { transform: Object.assign({}, obj.transform, { keys }) });
}

function addKey(obj, t, state) {
    const keys = (obj.transform.keys || []).slice();
    keys.push(makeKey(t, state));
    keys.sort((a, b) => a.t - b.t);
    return Object.assign({}, obj, { transform: Object.assign({}, obj.transform, { keys }) });
}

const transforms = (log) => log.filter((r) => r[0] === 'transform');
const draws = (log) => log.filter((r) => r[0] === 'draw');
const surfaces = (log) => log.filter((r) => r[0] === 'surface');

test('mergeDown：采样时刻 = 两边画格切换点 ∪ 上层变换关键帧', () => {
    const { doc, upId } = twoLayers({ lowerAt: 0.5, upperKeyAt: 0.3 });
    const rec = makeRecorder();
    const res = mergeDown(doc, upId, { surface: rec.surface });
    assert.equal(res.error, undefined);
    // 0（两边都有）/ 0.3（上层变换关键帧，图上仍是第一张）/ 0.5（下层换图）
    assert.equal(surfaces(rec.log).length, 3, '三个时刻各建一张合成图');
    const after = res.doc.objects[0];
    assert.deepEqual(celTimes(after).slice().sort((a, b) => a - b), [0, 0.3, 0.5]);
});

/**
 * 合成动作的「旧实现」快照：改动前 mergeDown 就是这么干的 ——
 * 按 cels 时刻在新建的面上一层一层 drawImage 到 (0,0)，不管任何变换、不设 alpha。
 * 这里原样复现一遍，用来跟新实现比交出去的指令序列，而不是比我手算的期望值：
 * 手算期望只能证明「我今天是这么想的」，快照对照能抓住「以后有人改坏了」。
 */
function legacyRecord(doc) {
    const rec = makeRecorder();
    const [upper, lower] = objectsOf(doc);
    for (const at of celTimes(lower)) {
        const b = celAt(lower, at);
        const a = celAt(upper, at);
        if (!b || !b.image) continue;
        const s = rec.surface(b.image.width, b.image.height);
        const g = s.getContext('2d');
        g.clearRect(0, 0, s.width, s.height);
        g.drawImage(b.image, 0, 0);
        if (a && a.image) g.drawImage(a.image, 0, 0);
    }
    return rec.log;
}

test('mergeDown：两层都没有变换时，交出去的指令序列与旧实现逐条一致（回归护栏）', () => {
    const { doc, upId } = twoLayers();
    const legacy = legacyRecord(doc);
    const rec = makeRecorder();
    mergeDown(doc, upId, { surface: rec.surface });

    // 旧实现压根不碰 CTM，等价于恒等：新实现的每一笔变换必须都是恒等
    assert.deepEqual(transforms(rec.log).map((r) => r.slice(1)), [
        [1, 0, 0, 1, 0, 0],
        [1, 0, 0, 1, 0, 0],
    ], '无变换时新实现交的是恒等 CTM');
    // 除了这一点，建面与绘制必须和旧实现一模一样（顺序、图、落点、alpha）
    assert.deepEqual(surfaces(rec.log), surfaces(legacy), '建面次数与尺寸同旧实现');
    assert.deepEqual(draws(rec.log), draws(legacy), '落笔顺序、图、落点、alpha 全同旧实现');
    assert.deepEqual(draws(rec.log).map((r) => r[1]), ['下图', '上图'], '先下层后上层');
});

test('mergeDown：上层的平移落到合成图里，下层自己不进矩阵', () => {
    const { doc, upId } = twoLayers({ upperState: { x: 20, y: 5 } });
    const rec = makeRecorder();
    mergeDown(doc, upId, { surface: rec.surface });
    const tr = transforms(rec.log);
    assert.deepEqual(tr[0].slice(1), [1, 0, 0, 1, 0, 0], '下层画在自己的局部坐标里');
    assert.deepEqual(tr[1].slice(1), [1, 0, 0, 1, 20, 5], '上层搬到 e=x, f=y');
});

test('mergeDown：下层有变换时，上层被预先反向平移（下层 transform 不动）', () => {
    const { doc, upId } = twoLayers({ lowerState: { x: 50 } });
    const rec = makeRecorder();
    const res = mergeDown(doc, upId, { surface: rec.surface });
    const tr = transforms(rec.log);
    assert.deepEqual(tr[0].slice(1), [1, 0, 0, 1, 0, 0]);
    assert.deepEqual(tr[1].slice(1), [1, 0, 0, 1, -50, 0], 'inv(M下)·M上，上层落在下层的局部原点');
    const lower = objectsOf(res.doc)[0];
    assert.equal(lower.transform.keys[0].state.x, 50, '下层的变换原样保留');
});

test('mergeDown：上层的 state.opacity 烤进像素，下层的不烤（留给 evaluator 再乘一次）', () => {
    const { doc, upId } = twoLayers({ upperState: { opacity: 0.5 }, lowerState: { opacity: 0.3 } });
    const rec = makeRecorder();
    mergeDown(doc, upId, { surface: rec.surface });
    const d = draws(rec.log);
    assert.equal(d[0][1], '下图');
    assert.equal(d[0][4], 1, '下层的 0.3 不能在合成时乘掉，否则写回后会淡两次');
    assert.equal(d[1][1], '上图');
    assert.ok(Math.abs(d[1][4] - 0.5) < 1e-9, '上层的 0.5 必须烤进去：合并后它就没有对象可乘了');
});

test('mergeDown：最底层 / 不存在的对象都退回原文档并给出原因', () => {
    const { doc, loId } = twoLayers();
    const bottom = mergeDown(doc, loId, { surface: makeRecorder().surface });
    assert.equal(bottom.doc, doc);
    assert.equal(bottom.error, '最底层无法向下合并');
    const missing = mergeDown(doc, 'L-不存在', { surface: makeRecorder().surface });
    assert.equal(missing.doc, doc);
    assert.ok(missing.error, '不存在的对象要报错而不是静默合并');
    assert.equal(mergeDown(null, 'x'), null, '没有文档就原样返回 null');
});

test('mergeDown：上层被删除、下层恢复可见、合成结果落到下层的画格里', () => {
    const { doc, upId, loId } = twoLayers({ lowerAt: 0.5 });
    const hidden = patchObject(doc, loId, (o) => Object.assign({}, o, { visible: false }));
    const res = mergeDown(hidden, upId, { surface: makeRecorder().surface });
    const list = objectsOf(res.doc);
    assert.equal(list.length, 1);
    assert.equal(list[0].id, loId);
    assert.equal(list[0].visible, true, '合并后下层要能看见');
    assert.equal(list[0].cels.length, 2, '两个采样时刻各写回一张图');
    assert.equal(res.merged, '上');
    assert.ok(!list.some((o) => o.id === upId));
});
