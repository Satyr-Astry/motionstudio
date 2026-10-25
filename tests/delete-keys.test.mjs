/**
 * Del 删选中关键帧 —— 归属判据与批量删除的单测（纯 Node，零 DOM）。
 *
 * 两条删除路径的判据都集中在 core 之外的 deleteTarget 里：
 *   关键帧选中 → 时间轴接管（外壳让路）
 *   没有选中   → 外壳走原来的纹理/对象两段式删除
 * 这里钉住的是「时间轴这一侧」：选中集合怎么变成一次 setDoc、删完集合怎么清、
 * 守卫（输入框 / 按钮 / Backspace）不许松动、删到最后一颗时文档仍然合法。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeys, deleteTarget } from '../app/editors/timeline-keys.mjs';
import { createDoc, addObject, makeObject, objectById } from '../app/core/doc-model.mjs';
import { createTrack, addKey, DEFAULT_STATE, stateAt } from '../app/core/transform.mjs';
import { snapFrame } from '../app/editors/timeline-geo.mjs';

/** 造一条只有 t=… 这么几颗关键帧的轨道。 */
function trackOf(...times) {
    return times.reduce((acc, t) => addKey(acc, t, DEFAULT_STATE, 'linear'), createTrack());
}

/**
 * 场景：每个 key 是「对象 id → 关键帧时刻表」。
 * deps 里的 setDoc 直接就地替换文档，这样断言读到的是真实写回结果。
 */
function makeScene(spec) {
    let doc = createDoc({ width: 200, height: 120, fps: 12 });
    for (const [id, times] of Object.entries(spec)) {
        doc = addObject(doc, makeObject({ id, name: id, transform: trackOf(...times) }));
    }
    const calls = { setDoc: 0, notify: [], paint: 0, keepTime: 0 };
    const deps = {
        notify: (m) => calls.notify.push(String(m)),
        notWired: (n) => calls.notify.push('notWired:' + n),
        has: (k) => k === 'setDoc',
        call: (k, args) => {
            if (k !== 'setDoc') return null;
            calls.setDoc += 1;
            const fn = Array.isArray(args) ? args[0] : args;
            const next = typeof fn === 'function' ? fn(doc) : fn;
            if (next) doc = next;
            return true;
        },
        docNow: () => doc,
        timeNow: () => 0,
        activeId: () => null,
        setActive: () => {},
        keepTime: () => {
            calls.keepTime += 1;
        },
        paint: () => {
            calls.paint += 1;
        },
        zoomOf: () => 1,
        menu: { open() {}, close() {} },
        rowsEl: () => null,
    };
    return { deps, calls, getDoc: () => doc, keys: createKeys(deps) };
}

const keyCount = (doc, id) => (objectById(doc, id).transform.keys || []).length;

/* ───────────── 判据 ───────────── */

test('deleteTarget：有选中归时间轴，没选中归外壳', () => {
    assert.equal(deleteTarget(0), 'shell');
    assert.equal(deleteTarget(1), 'keys');
    assert.equal(deleteTarget(3), 'keys');
    // 脏输入按「没选中」处理：宁可走历史行为，也不要凭 NaN 去删对象
    assert.equal(deleteTarget(undefined), 'shell');
    assert.equal(deleteTarget(null), 'shell');
    assert.equal(deleteTarget(NaN), 'shell');
});

/* ───────────── 删除的文档写入 ───────────── */

test('没有选中时 deleteSelection 什么都不做（外壳原逻辑不受影响）', () => {
    const s = makeScene({ a: [0, 1] });
    assert.equal(s.keys.deleteSelection(), 0);
    assert.equal(s.calls.setDoc, 0, '不该写文档');
    assert.equal(s.calls.notify.length, 0, '不该提示');
    assert.equal(keyCount(s.getDoc(), 'a'), 2);
});

test('单选删除：一次 setDoc、一条撤销、删完清空选中', () => {
    const s = makeScene({ a: [0, 1] });
    assert.equal(s.keys.selectKeys([{ layerId: 'a', t: 0 }]), 1);
    assert.equal(s.keys.deleteSelection(), 1);
    assert.equal(s.calls.setDoc, 1, '多选也必须是「一次 setDoc」＝一步撤销');
    assert.equal(keyCount(s.getDoc(), 'a'), 1);
    assert.deepEqual(s.calls.notify, ['已删除 1 个关键帧']);
    assert.equal(s.keys.selectionAll().length, 0, '删完要清空选中');
});

test('多选批量：一次 setDoc 删掉多处', () => {
    const s = makeScene({ a: [0, 1, 2] });
    s.keys.selectKeys([
        { layerId: 'a', t: 0 },
        { layerId: 'a', t: 2 },
    ]);
    assert.equal(s.keys.deleteSelection(), 2);
    assert.equal(s.calls.setDoc, 1);
    assert.equal(keyCount(s.getDoc(), 'a'), 1);
    assert.deepEqual(s.calls.notify, ['已删除 2 个关键帧']);
});

test('多选跨对象：各删各的，不互相误删', () => {
    const s = makeScene({ a: [0, 1], b: [0.5, 1.5] });
    s.keys.selectKeys([
        { layerId: 'a', t: 0 },
        { layerId: 'b', t: 0.5 },
    ]);
    assert.equal(s.keys.deleteSelection(), 2);
    assert.equal(s.calls.setDoc, 1);
    assert.equal(keyCount(s.getDoc(), 'a'), 1);
    // 对象进文档时会给轨道补一颗 t=0 的起点关键帧（文档不变量），所以 b 实际是 [0, 0.5, 1.5]；
    // 删掉 0.5 之后剩 [0, 1.5] —— 这是对的，不是漏删。
    assert.equal(keyCount(s.getDoc(), 'b'), 2);
    assert.deepEqual(
        objectById(s.getDoc(), 'a').transform.keys.map((k) => k.t),
        [1],
    );
    assert.deepEqual(
        objectById(s.getDoc(), 'b').transform.keys.map((k) => k.t),
        [0, 1.5],
    );
});

test('删到最后一颗：文档仍合法（轨道允许为空，求值退回默认态）', () => {
    const s = makeScene({ a: [0] });
    s.keys.selectKeys([{ layerId: 'a', t: 0 }]);
    assert.equal(s.keys.deleteSelection(), 1);
    assert.equal(keyCount(s.getDoc(), 'a'), 0, '允许删空：空轨道是合法文档状态');
    const st = stateAt(objectById(s.getDoc(), 'a').transform, 0.5);
    assert.equal(typeof st, 'object');
    assert.equal(Number.isFinite(st.opacity), true, '空轨道求值不能出 NaN');
    assert.equal(objectById(s.getDoc(), 'a') !== null, true, '对象本身不能被带走');
});

/* ───────────── 守卫：不许松动 ───────────── */

function keyEvent(over) {
    const e = {
        key: 'Delete',
        target: { tagName: 'BODY' },
        prevented: 0,
        preventDefault() {
            e.prevented += 1;
        },
        ...over,
    };
    return e;
}

test('守卫：外壳报 typing（输入框 / 下拉 / 按钮 / contentEditable 上按 Del）时让路，一颗都不删', () => {
    // 外壳用 isTypingTarget 算出 typing 再传进来；时间轴自己不认标签名，
    // 但必须无条件信这一位：隔着输入框删掉看不见的键是最糟的一类误删。
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'DIV']) {
        const s = makeScene({ a: [0, 1] });
        s.keys.selectKeys([{ layerId: 'a', t: 0 }]);
        const detail = { handled: false, count: 0, typing: true, target: tagName };
        s.keys.onDeleteKeysEvent({ detail });
        assert.equal(keyCount(s.getDoc(), 'a'), 2, tagName + ' 上的 Del 不该删关键帧');
        assert.equal(s.calls.setDoc, 0);
        assert.equal(detail.handled, false, '让路时外壳必须拿到 handled=false，才会走原来的纹理/对象删除');
    }
});

test('守卫：typing 缺省时照常接管（别把「没说」当成「在输入框里」）', () => {
    const s = makeScene({ a: [0, 1] });
    s.keys.selectKeys([{ layerId: 'a', t: 0 }]);
    const detail = { handled: false, count: 0 };
    s.keys.onDeleteKeysEvent({ detail });
    assert.equal(keyCount(s.getDoc(), 'a'), 1);
    assert.equal(detail.handled, true);
});

test('守卫：contentEditable 也走 typing 让路（与上面同一入口）', () => {
    const s = makeScene({ a: [0, 1] });
    s.keys.selectKeys([{ layerId: 'a', t: 0 }]);
    const detail = { handled: false, count: 0, typing: true };
    s.keys.onDeleteKeysEvent({ detail });
    assert.equal(keyCount(s.getDoc(), 'a'), 2, 'contentEditable 里按 Del 是删字');
});

/* ───────────── 外壳问「这批归你吗」── ms:delete-keys ───────────── */

test('onDeleteKeysEvent：有选中就接管并删除', () => {
    const s = makeScene({ a: [0, 1] });
    s.keys.selectKeys([{ layerId: 'a', t: 0 }]);
    const detail = { handled: false, count: 0 };
    s.keys.onDeleteKeysEvent({ detail });
    assert.equal(detail.handled, true, '外壳必须整段让路');
    assert.equal(detail.count, 1);
    assert.equal(keyCount(s.getDoc(), 'a'), 1);
});

test('onDeleteKeysEvent：没选中就让路，外壳照原逻辑删对象/纹理', () => {
    const s = makeScene({ a: [0, 1] });
    const detail = { handled: false, count: 0 };
    s.keys.onDeleteKeysEvent({ detail });
    assert.equal(detail.handled, false);
    assert.equal(detail.count, 0);
    assert.equal(s.calls.setDoc, 0);
    assert.equal(keyCount(s.getDoc(), 'a'), 2);
});

test('onDeleteKeysEvent：选中的键已被别处改掉时仍算「已接管」（Del 不能顺延到对象上）', () => {
    const s = makeScene({ a: [0, 1] });
    // 选了 a@0，但先把这颗从文档里抹掉（模拟别处改动），再按 Del
    s.keys.selectKeys([{ layerId: 'a', t: 0 }]);
    s.deps.call('setDoc', [
        (d) => ({
            ...d,
            objects: d.objects.map((o) => (o.id === 'a' ? { ...o, transform: { ...o.transform, keys: [] } } : o)),
        }),
    ]);
    const detail = { handled: false, count: 0 };
    s.keys.onDeleteKeysEvent({ detail });
    assert.equal(detail.count, 0, '删不出东西');
    assert.equal(detail.handled, true, '但仍属于时间轴：不能让外壳去删对象');
});

test('selectKeys 过滤脏输入，并成为新的选择锚点', () => {
    const s = makeScene({ a: [0, 1] });
    assert.equal(s.keys.selectKeys([{ layerId: 'a', t: 1 }, { layerId: '', t: 0 }, { layerId: 'a', t: 'x' }, null]), 1);
    assert.deepEqual(s.keys.selectionAll(), [{ layerId: 'a', t: 1 }]);
    assert.equal(s.keys.selectKeys([]), 0);
    assert.deepEqual(s.keys.selectionAll(), []);
});

test('onDeleteKeysEvent：外壳报 typing 时让路（焦点在输入框里不许删远处选中的键）', () => {
    const s = makeScene({ a: [0, 1] });
    s.keys.selectKeys([{ layerId: 'a', t: 0 }]);
    const detail = { handled: false, count: 0, typing: true };
    s.keys.onDeleteKeysEvent({ detail });
    assert.equal(detail.handled, false, '输入框里按 Del 是删字，不该删关键帧');
    assert.equal(detail.count, 0);
    assert.equal(s.calls.setDoc, 0);
    assert.equal(keyCount(s.getDoc(), 'a'), 2);
    // 同一个集合，非 typing 时照删 —— 证明上面的让路只由 typing 这一项决定
    const ok = { handled: false, count: 0, typing: false };
    s.keys.onDeleteKeysEvent({ detail: ok });
    assert.equal(ok.handled, true);
    assert.equal(keyCount(s.getDoc(), 'a'), 1);
});

/* ───────────── 打关键帧要落在整数帧（与拖动同一套磁铁）───────────── */

test('snapFrame：双击泳道的像素坐标换算出的 6.4643 帧要吸到整数帧', () => {
    const doc = createDoc({ width: 200, height: 120, fps: 12 });
    // 真机读数（1680×1000、zoom 1×、双击泳道第二个刻度附近）：
    // xToTime 给出 0.5386904761904762 s = 6.4643 帧，落在两条帧线之间。
    const raw = 0.5386904761904762;
    const got = snapFrame(doc, raw);
    const frame = got * 12;
    assert.ok(Math.abs(frame - Math.round(frame)) < 1e-9, '吸附后必须整帧，实际 ' + frame);
    assert.notEqual(got, raw, '确实动了，不是原样返回');
    // 同一套函数对「已经整帧」的值是恒等的，别把好的输入也挪走
    assert.equal(snapFrame(doc, 0.5), 0.5);
    // 打关键帧按钮走的是 timeNow()（播放头），播放头非整帧时也一样要吸
    const fromPlayhead = snapFrame(doc, 1.0416666666666667);
    assert.ok(Math.abs(fromPlayhead * 12 - Math.round(fromPlayhead * 12)) < 1e-9);
});
