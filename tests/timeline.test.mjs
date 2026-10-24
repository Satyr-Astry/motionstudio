// timeline.mjs 单测（v6 时间轴）：
// 这些断言只碰纯函数，不建 DOM —— 时间轴的全部坐标与分组逻辑都在纯函数里，
// 面板只是把它们写进 style。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createDoc, makeObject } from '../app/core/doc-model.mjs';
import {
    SEC_PX,
    CEL_SIZE,
    KF_SIZE,
    TICK_MIN_PX,
    TICK_STEPS,
    ZOOM_MIN,
    ZOOM_MAX,
    pxPerSecond,
    timeToX,
    xToTime,
    fpsOf,
    tickStep,
    tickLabel,
    rulerTicks,
    snapGrid,
    celLeft,
    kfLeft,
    celMarks,
    currentCelIndex,
    keyGroups,
    timeSegments,
    segmentIndexAtTime,
    mount,
} from '../app/editors/timeline.mjs';

const img = (tag) => ({ tag, width: 4, height: 4 });
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`);

const doc12 = createDoc({ fps: 12, duration: 3 });
const objAt = (cels) => makeObject({ name: 'O', cels });

/* ───────────────── 坐标：pxPerSecond / timeToX / xToTime ───────────────── */

test('pxPerSecond：28 * fps * zoomX，fps 缺省 12，zoom 非法退化成 1', () => {
    assert.equal(SEC_PX, 28);
    assert.equal(pxPerSecond(doc12, 1), 28 * 12);
    assert.equal(pxPerSecond(doc12, 0.5), 28 * 12 * 0.5);
    assert.equal(pxPerSecond(doc12, 4), 28 * 12 * 4);
    // 脏输入：doc 缺失 / fps 非法 / zoom 非法
    assert.equal(pxPerSecond(null, 1), 28 * 12);
    assert.equal(pxPerSecond({ fps: 0 }, 1), 28 * 12);
    assert.equal(pxPerSecond({ fps: -3 }, 1), 28 * 12);
    assert.equal(pxPerSecond(doc12, 0), 28 * 12);
    assert.equal(pxPerSecond(doc12, NaN), 28 * 12);
    assert.equal(pxPerSecond(doc12, -2), 28 * 12);
    assert.equal(fpsOf({ fps: 24 }), 24);
});

test('timeToX / xToTime：往返一致，负 x 钳到 0，非法时间给 0', () => {
    assert.equal(timeToX(doc12, 2, 1), 672);
    assert.equal(xToTime(doc12, 672, 1), 2);
    assert.equal(timeToX(doc12, 0, 1), 0);
    assert.equal(xToTime(doc12, 0, 1), 0);
    assert.equal(xToTime(doc12, -10, 1), 0);
    assert.equal(timeToX(doc12, NaN, 1), 0);
    assert.equal(xToTime(doc12, NaN, 1), 0);

    for (const zoom of [ZOOM_MIN, 0.5, 1, 1.25, 2.5, ZOOM_MAX]) {
        for (const t of [0, 0.1, 0.25, 1, 2.333333, 7.5]) {
            near(xToTime(doc12, timeToX(doc12, t, zoom), zoom), t, 1e-9);
        }
    }
    // 不同 fps 下往返依旧成立
    for (const fps of [1, 12, 24, 60, 120]) {
        const d = createDoc({ fps });
        near(xToTime(d, timeToX(d, 1.5, 1), 1), 1.5, 1e-9);
        near(pxPerSecond(d, 1), 28 * fps);
    }
});

/* ───────────────── 刻度步长 ───────────────── */

test('tickStep：候选里第一个使间距 ≥46px 的', () => {
    // fps 12 → 每秒 336px：0.1s = 33.6px 不够，0.2s = 67.2px 够
    assert.equal(tickStep(doc12, 1), 0.2);
    near(0.1 * pxPerSecond(doc12, 1), 33.6);
    assert.ok(tickStep(doc12, 1) * pxPerSecond(doc12, 1) >= TICK_MIN_PX);

    // 放大到 4× → 0.1s 已经 134.4px
    assert.equal(tickStep(doc12, ZOOM_MAX), 0.1);
    // 缩小到 0.25× → 每秒 84px，0.5s 只有 42px，要 1s
    assert.equal(tickStep(doc12, ZOOM_MIN), 1);
    // 慢帧率 + 最小缩放 → 每秒 7px，只能 10s
    assert.equal(tickStep({ fps: 1 }, ZOOM_MIN), 10);
    // 快帧率 → 0.1s 就够
    assert.equal(tickStep({ fps: 120 }, 1), 0.1);

    for (const zoom of [ZOOM_MIN, 0.5, 1, 2, ZOOM_MAX]) {
        const step = tickStep(doc12, zoom);
        assert.ok(TICK_STEPS.includes(step), `${step} 必须是候选步长`);
        assert.ok(step * pxPerSecond(doc12, zoom) >= TICK_MIN_PX);
    }
});

test('rulerTicks：主刻度间距不小于 46px，标签以 s 结尾且升序', () => {
    const ticks = rulerTicks(doc12, 1);
    assert.equal(ticks.step, 0.2);
    assert.ok(ticks.major.length >= 2);
    assert.equal(ticks.major[0].t, 0);
    assert.equal(ticks.major[0].label, '0.0s');
    for (let i = 1; i < ticks.major.length; i++) {
        const gap = ticks.major[i].x - ticks.major[i - 1].x;
        assert.ok(gap >= TICK_MIN_PX - 1e-9, `刻度间距 ${gap} < ${TICK_MIN_PX}`);
        assert.ok(ticks.major[i].t > ticks.major[i - 1].t);
    }
    for (const m of ticks.major) assert.match(m.label, /s$/);
    near(ticks.totalPx, timeToX(doc12, 3, 1));
});

test('tickLabel：步长小于 1 秒保留一位小数', () => {
    assert.equal(tickLabel(0, 0.2), '0.0s');
    assert.equal(tickLabel(1.5, 0.5), '1.5s');
    assert.equal(tickLabel(2, 1), '2s');
    assert.equal(tickLabel(10, 10), '10s');
});

/* ───────────────── 画格定位 ───────────────── */

test('currentCelIndex：定位当前时间生效的画格（画格一直沿用到下一个）', () => {
    const obj = objAt([
        { at: 0, image: img('a') },
        { at: 1, image: img('b') },
        { at: 2.5, image: null },
    ]);
    assert.equal(currentCelIndex(obj, 0), 0);
    assert.equal(currentCelIndex(obj, 0.999), 0);
    assert.equal(currentCelIndex(obj, 1), 1);
    assert.equal(currentCelIndex(obj, 2.49), 1);
    assert.equal(currentCelIndex(obj, 2.5), 2);
    assert.equal(currentCelIndex(obj, 99), 2);

    // 第一个画格之前没有生效画格
    const late = objAt([{ at: 1, image: img('x') }]);
    assert.equal(currentCelIndex(late, 0.5), -1);
    assert.equal(currentCelIndex(late, 1), 0);
    // 脏输入不抛
    assert.equal(currentCelIndex(null, 1), -1);
    assert.equal(currentCelIndex(objAt([{ at: 0 }]), NaN), 0);
});

test('celMarks / celLeft / kfLeft：方块与菱形都中心对齐时间刻度', () => {
    const obj = objAt([
        { at: 2, image: null },
        { at: 0, image: img('a') },
    ]);
    const marks = celMarks(obj);
    assert.deepEqual(marks.map((m) => m.at), [0, 2]);
    assert.deepEqual(marks.map((m) => m.empty), [false, true]);
    assert.deepEqual(celMarks(null), []);

    near(celLeft(doc12, 1, 1), timeToX(doc12, 1, 1) - CEL_SIZE / 2);
    near(kfLeft(doc12, 1, 1), timeToX(doc12, 1, 1) - 7 / 2);
    assert.equal(CEL_SIZE, 8);
});

/* ───────────────── 关键帧同刻合并 ───────────────── */

test('keyGroups：同刻多个通道合并成一个菱形，idx 指向原数组', () => {
    const keys = [
        { t: 2, ease: 'bezier' },
        { t: 0.5, ease: 'linear' },
        { t: 0.5 + 1e-9, ease: 'hold' },
        { t: 4, ease: 'linear' },
    ];
    const groups = keyGroups(keys);
    assert.equal(groups.length, 3);

    assert.equal(groups[0].t, 0.5);
    assert.deepEqual(groups[0].idx, [1, 2]);
    assert.equal(groups[1].t, 2);
    assert.deepEqual(groups[1].idx, [0]);
    assert.equal(groups[2].t, 4);
    assert.deepEqual(groups[2].idx, [3]);

    // 脏输入
    assert.deepEqual(keyGroups(null), []);
    assert.deepEqual(keyGroups([{ t: NaN }, null, { t: 1 }]), [{ t: 1, idx: [2], ease: undefined }]);
    // 完全相同时间只留一组
    const same = keyGroups([{ t: 1 }, { t: 1 }, { t: 1 }]);
    assert.equal(same.length, 1);
    assert.deepEqual(same[0].idx, [0, 1, 2]);
});

test('snapGrid：Shift 拖动吸附到 0.1s 网格', () => {
    near(snapGrid(0.23), 0.2);
    near(snapGrid(0.27), 0.3);
    near(snapGrid(1.04), 1);
    near(snapGrid(2.05, 0.5), 2);
    assert.equal(snapGrid(NaN), 0);
    assert.equal(snapGrid(0.37, 0), 0.4); // 非法网格退回 0.1
});

/* ───────────────── 段帧率条 ───────────────── */

test('timeSegments：每段按秒比例铺开，末段结束于总时长', () => {
    const doc = createDoc({
        fps: 12,
        duration: 3,
        timebase: { segments: [{ at: 0, fps: 12 }, { at: 1.5, fps: 24 }] },
    });
    const segs = timeSegments(doc, 3);
    assert.equal(segs.length, 2);
    assert.deepEqual(segs[0], { index: 0, at: 0, fps: 12, end: 1.5 });
    assert.deepEqual(segs[1], { index: 1, at: 1.5, fps: 24, end: 3 });
    // 宽度按秒比例：第二段占一半
    near(timeToX(doc, segs[0].end, 1) - timeToX(doc, segs[0].at, 1), timeToX(doc, 3, 1) / 2);

    assert.equal(segmentIndexAtTime(segs, 0), 0);
    assert.equal(segmentIndexAtTime(segs, 1.49), 0);
    assert.equal(segmentIndexAtTime(segs, 1.5), 1);
    assert.equal(segmentIndexAtTime(segs, 99), 1);

    // 没有 timebase 时给一个隐式段，双击就能改
    const plain = timeSegments(createDoc({ fps: 12, duration: 2 }), 2);
    assert.equal(plain.length, 1);
    assert.deepEqual(plain[0], { index: 0, at: 0, fps: 12, end: 2 });
});

/* ───────────────── 模块形态 ───────────────── */

test('mount 是函数；导入模块不需要 DOM', () => {
    assert.equal(typeof mount, 'function');
    // 前面所有测试都在没有任何 DOM 的情况下跑完了 —— 导入本身没有副作用。
    assert.equal(typeof globalThis.document, 'undefined');
});

/* ───────────────── 挂载冒烟：用最小 DOM 桩跑一遍 mount/paint/destroy ───────────────── */

function fakeDocument() {
    const make = (tag) => {
        const el = {
            tagName: String(tag).toUpperCase(),
            className: '',
            style: {},
            dataset: {},
            title: '',
            textContent: '',
            childNodes: [],
            parentNode: null,
            listeners: [],
            scrollLeft: 0,
            clientWidth: 900,
            clientHeight: 400,
            disabled: false,
            type: '',
            value: '',
            classList: {
                toggle(name, force) {
                    const has = el.className.split(/\s+/).includes(name);
                    const want = force === undefined ? !has : !!force;
                    if (want && !has) el.className = (el.className + ' ' + name).trim();
                    if (!want && has) el.className = el.className.split(/\s+/).filter((x) => x && x !== name).join(' ');
                },
                add(name) {
                    el.classList.toggle(name, true);
                },
                contains(name) {
                    return el.className.split(/\s+/).includes(name);
                },
            },
            appendChild(child) {
                if (child && child.parentNode && typeof child.parentNode.removeChild === 'function') {
                    child.parentNode.removeChild(child);
                }
                el.childNodes.push(child);
                if (child) child.parentNode = el;
                return child;
            },
            append(...kids) {
                for (const k of kids) el.appendChild(k);
            },
            removeChild(child) {
                el.childNodes = el.childNodes.filter((n) => n !== child);
                if (child) child.parentNode = null;
                return child;
            },
            remove() {
                if (el.parentNode) el.parentNode.removeChild(el);
            },
            addEventListener(type, fn) {
                el.listeners.push([type, fn]);
            },
            removeEventListener(type, fn) {
                el.listeners = el.listeners.filter(([t, f]) => t !== type || f !== fn);
            },
            getBoundingClientRect() {
                return { left: 0, top: 0, right: 900, bottom: 400, width: 900, height: 400 };
            },
            closest(sel) {
                const name = String(sel).replace(/^\./, '');
                let node = el;
                while (node) {
                    if (node.classList && node.classList.contains(name)) return node;
                    node = node.parentNode;
                }
                return null;
            },
            contains(node) {
                if (node === el) return true;
                return el.childNodes.some((k) => k && typeof k.contains === 'function' && k.contains(node));
            },
            focus() {},
            select() {},
            querySelectorAll(sel) {
                const name = String(sel).replace(/^\./, '');
                const out = [];
                const walk = (node) => {
                    for (const k of node.childNodes) {
                        if (k && k.classList && k.classList.contains(name)) out.push(k);
                        if (k) walk(k);
                    }
                };
                walk(el);
                return out;
            },
            querySelector(sel) {
                return el.querySelectorAll(sel)[0] || null;
            },
        };
        // textContent 赋值要清子节点（和真 DOM 一致）
        let text = '';
        Object.defineProperty(el, 'textContent', {
            get: () => text,
            set: (v) => {
                text = String(v);
                el.childNodes = [];
            },
        });
        return el;
    };

    const body = make('body');
    return { createElement: make, body, addEventListener() {}, removeEventListener() {} };
}

test('mount 能用最小 ctx 挂起来：结构、画格点、菱形、段条都对', () => {
    const doc0 = createDoc({ fps: 12, duration: 3 });
    // v8：画格挂在关键帧上 —— 0 s 有图、1 s 显式空白、2 s 只改位移（沿用上一张）
    const obj = makeObject({
        id: doc0.objects[0].id,
        cels: [{ at: 0, image: { tag: 'a', width: 4, height: 4 } }, { at: 1, image: null }],
        transform: { keys: [{ t: 2, ease: 'linear', state: {} }] },
    });
    doc0.objects[0] = obj;

    const seen = [];
    const state = { doc: doc0, t: 0.5, active: obj.id };
    const ctx = {
        doc: () => state.doc,
        time: () => state.t,
        setTime: (v) => {
            state.t = v;
        },
        activeLayerId: () => state.active,
        setActiveLayer: (id) => {
            state.active = id;
        },
        setSelection: (sel) => {
            state.sel = sel;
        },
        on: () => () => {},
        requestRender: () => {},
        notify: (m) => seen.push(m),
        setDoc: (fn) => {
            state.doc = fn(state.doc) || state.doc;
        },
    };

    const doc = fakeDocument();
    globalThis.document = doc;
    globalThis.window = { innerWidth: 1200, innerHeight: 800 };
    try {
        const host = doc.createElement('div');
        const api = mount(host, ctx);
        assert.equal(typeof api.refresh, 'function');
        assert.equal(typeof api.focusFrame, 'function');
        assert.equal(typeof api.destroy, 'function');

        // .tline 外壳：三块（tools / ruler / rows）
        assert.equal(host.childNodes.length, 1);
        const root = host.childNodes[0];
        assert.match(root.className, /\btline\b/);
        assert.equal(root.childNodes.length, 3);
        assert.match(root.childNodes[0].className, /\btline-tools\b/);
        assert.match(root.childNodes[1].className, /\btline-ruler\b/);

        const rowsEl = root.childNodes[2];
        assert.match(rowsEl.className, /\btline-rows\b/);

        // v8：画格挂在关键帧上，时间轴只画一行菱形（画格块那一行已经删掉）
        assert.equal(rowsEl.querySelectorAll('.tline-cel').length, 0, '不再有画格块');
        const kfNodes = rowsEl.querySelectorAll('.tline-kf');
        assert.equal(kfNodes.length, 3, '0（有图）/ 1（空白画格）/ 2（只改位移）');
        assert.equal(kfNodes[0].dataset.t, '0');
        assert.equal(kfNodes[1].dataset.t, '1');
        assert.equal(kfNodes[2].dataset.t, '2');
        // 0 秒的菱形中心对齐 0，但整颗要留在泳道内，所以左边界钳到 0
        assert.equal(kfNodes[0].style.left, Math.max(0, kfLeft(doc0, 0, 1)).toFixed(2) + 'px');
        assert.equal(kfNodes[1].style.left, kfLeft(doc0, 1, 1).toFixed(2) + 'px');
        assert.equal(kfNodes[0].style.width, KF_SIZE + 'px');
        // 带画格 / 显式空白 各有标记；只改位移的那条两个标记都没有
        assert.ok(kfNodes[0].classList.contains('has-drawing'), '0 s 换了画格');
        assert.ok(kfNodes[1].classList.contains('is-blank'), '1 s 是空白画格');
        assert.ok(!kfNodes[2].classList.contains('has-drawing'));
        assert.equal(kfNodes[0].dataset.layer, obj.id);

        // 段帧率条：没有 timebase 也有一段，双击可改
        const segs = root.childNodes[1].querySelectorAll('.tline-fpsseg');
        assert.equal(segs.length, 1);
        assert.equal(segs[0].textContent, '12fps');

        // 工具条按钮齐全，且都接线到了 ctx
        // v8：播放控制（⏮ ‹ ▶ › ⏭ + 时间读数）搬进了时间轴，顺序即语义：
        // 播放控制 → 画格 → 关键帧 → 缩放。改这里必须同步改 timeline-paint。
        const btns = root.childNodes[0].querySelectorAll('.tline-btn');
        assert.deepEqual(btns.map((b) => b.dataset.act), [
            'first', 'prev', 'play', 'next', 'last',
            'prevcel', 'nextcel', 'addcel', 'delcel', 'addkey', 'snap',
            'zoomout', 'zoomin',
        ]);

        // 总时长是**可输入的数字**（旧版是只读文字，「改时长不直观」就是它造成的）
        const totalField = root.childNodes[0].querySelector('.tline-total');
        assert.equal(totalField.tagName, 'INPUT');
        assert.equal(totalField.value, '3.00');
        // 当前时间读数跟着 ctx.time 走（这个 fixture 的 time 是 0.5 s）
        assert.equal(root.childNodes[0].querySelector('.tline-now').value, '0.50');

        // 反复刷新不重复建节点
        api.refresh();
        api.refresh();
        assert.equal(rowsEl.querySelectorAll('.tline-cel').length, 0);
        assert.equal(rowsEl.querySelectorAll('.tline-kf').length, 3);

        // 时间变了，播放头跟着走
        state.t = 2;
        api.refresh();
        assert.equal(root.childNodes[1].querySelector('.tline-playhead').style.left, timeToX(doc0, 2, 1).toFixed(2) + 'px');

        api.destroy();
        assert.equal(host.childNodes.length, 0, 'destroy 之后 DOM 清干净');
    } finally {
        delete globalThis.document;
        delete globalThis.window;
    }
});

test('mount 面对空 ctx 也不崩：缺失的能力只提示', () => {
    const doc = fakeDocument();
    globalThis.document = doc;
    globalThis.window = { innerWidth: 1200, innerHeight: 800 };
    try {
        const host = doc.createElement('div');
        const api = mount(host, {});
        assert.equal(typeof api.refresh, 'function');
        api.refresh();
        api.focusFrame();
        assert.equal(host.querySelectorAll('.tline-cel').length, 0);
        api.destroy();
    } finally {
        delete globalThis.document;
        delete globalThis.window;
    }
});
