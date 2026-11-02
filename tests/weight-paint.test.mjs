/**
 * 权重叠加态（P2-C 步 1）：顶点口径 + 屏幕命中 + 重绘判据 + 绘制/输入落点守卫。
 *
 * 这一步一条权重都不写，只保证「看得见、点得中、改得动会重画」三件事。
 * 其中顶点口径必须与求值器逐点一致 —— 差一个像素就是「眼睛看到 A、鼠标要点 B」，
 * 这种事故只能靠数值对拍发现，肉眼几乎查不出来。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createDoc, makeObject, patchObject, BONE_DEFAULTS } from '../app/core/doc-model.mjs';
import { createKey } from '../app/core/transform.mjs';
import { bindSkin, skinOf, normalizeSkin, SKIN_DEFAULTS, SKIN_MAX_BONES_PER_POINT } from '../app/core/skin.mjs';
import { createEvaluator } from '../app/core/evaluator.mjs';
import {
    WEIGHT_EPS, boneColorOf, brushVertices, cachedSkinVertices, mainBoneIndex,
    paintWeights, pickSkinVertex, skinVertices, weightSum,
} from '../app/core/weight-paint.mjs';
import { has } from '../app/i18n/index.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** 从源码里切出一个函数（到行首的 `}` 为止）。源码守卫用，不做语法分析。 */
function sliceFn(src, sig) {
    const at = src.indexOf(sig);
    assert.ok(at >= 0, '源码里找不到：' + sig);
    const end = src.indexOf('\n}', at);
    assert.ok(end > at, '函数没有正常结束：' + sig);
    return src.slice(at, end + 2);
}

/**
 * 一份带骨骼和蒙皮的最小文档：骨骼在最前（蒙皮要按 parentId 找它），
 * 被蒙皮对象是普通 paint 对象（没有纹理 → 尺寸回退文档尺寸，坐标可预期）。
 */
function fixture(t = 0) {
    const doc0 = createDoc({
        width: 900,
        height: 640,
        objects: [
            { id: 'bone-1', name: '骨骼 1', kind: 'bone', bone: { len: 200, width: 10, color: '#7d8fa8' } },
            { id: 'obj-1', name: '对象 1' },
        ],
    });
    const before = doc0.objects.find((o) => o.id === 'obj-1');
    const skin = bindSkin(doc0, before, ['bone-1'], { grid: SKIN_DEFAULTS.grid, t });
    const doc = patchObject(doc0, 'obj-1', (o) => Object.assign({}, o, { skin }));
    return { doc, layer: doc.objects.find((o) => o.id === 'obj-1'), before };
}

test('sameObjectPixels 比 skin —— 否则只改权重会被判「像素没变」而不重绘', () => {
    const src = read('../app/shell/doc-state.mjs');
    const body = sliceFn(src, 'function sameObjectPixels(');
    assert.ok(body.includes('a.skin === b.skin'), 'sameObjectPixels 必须比 skin 引用');
    assert.ok(
        body.indexOf('a.effects === b.effects') < body.indexOf('a.skin === b.skin'),
        'skin 的比较放在 effects 之后，与字段顺序一致',
    );
});

test('运行时：只换 skin 引用就算「像素变了」', () => {
    const src = read('../app/shell/doc-state.mjs');
    const code = sliceFn(src, 'function sameAnchor(') + '\n' + sliceFn(src, 'function sameObjectPixels(');
    const same = new Function(code + '\nreturn sameObjectPixels;')();
    const base = {
        visible: true, opacity: 1, mixMode: 'normal', kind: 'paint', time: null, parentId: null,
        onionIgnore: false, anchor: { x: 0, y: 0 }, cels: {}, transform: {}, effects: [], skin: { pts: [] },
    };
    assert.equal(same(base, base), true);
    assert.equal(same(base, Object.assign({}, base)), true, '字段全等（引用也相同）＝没变');
    assert.equal(
        same(base, Object.assign({}, base, { skin: { pts: [{ boneId: 'bone-1', w: 1 }] } })),
        false,
        '只换了 skin 也必须算「变了」，否则涂权重不会触发重绘',
    );
});

test('运行时：pixelsDiffer 对「只有 skin 变」的文档返回 true（真的会重绘）', () => {
    const src = read('../app/shell/doc-state.mjs');
    const code = [
        sliceFn(src, 'function sameAnchor('),
        sliceFn(src, 'function sameObjectPixels('),
        sliceFn(src, 'function pixelsDiffer('),
    ].join('\n');
    // onionKey / objectsOf 是模块内依赖，这里注入等价的最小实现（本用例只关心对象字段）
    const differ = new Function('onionKey', 'objectsOf', code + '\nreturn pixelsDiffer;')(
        (o) => JSON.stringify(o == null ? null : o),
        (d) => (d && Array.isArray(d.objects) ? d.objects : []),
    );
    const objs = (skinRef) => [{
        visible: true, opacity: 1, mixMode: 'normal', kind: 'paint', time: null, parentId: null,
        onionIgnore: false, anchor: { x: 0, y: 0 }, cels: {}, transform: {}, effects: [], skin: skinRef,
    }];
    const a = { width: 900, height: 640, duration: 12, onion: null, objects: objs({ pts: [] }) };
    const b = Object.assign({}, a, { objects: objs({ pts: [{ boneId: 'bone-1', w: 1 }] }) });
    assert.equal(differ(a, b), true, 'skin 变了必须判「有变化」');
    assert.equal(differ(a, a), false);
});

test('顶点口径与求值器逐点一致（差 < 1e-9）', () => {
    const { doc, layer } = fixture(0);
    const verts = skinVertices(doc, layer, 0, null);
    assert.ok(verts, '带 skin 的对象必须有顶点');
    const ev = createEvaluator(doc);
    const lat = ev.lattice(layer, 0);
    for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]]) {
        const mine = verts.map(u, v);
        // 求值器的 map 返回 [x, y] 数组（transformPoint 的契约），本模块返回 {x, y}
        const theirs = lat.map(u, v);
        assert.ok(Math.abs(mine.x - theirs[0]) < 1e-9, `x@(${u},${v})：${mine.x} vs ${theirs[0]}`);
        assert.ok(Math.abs(mine.y - theirs[1]) < 1e-9, `y@(${u},${v})：${mine.y} vs ${theirs[1]}`);
    }
});

test('顶点数与参数空间：grid 4×4 → 25 点，uv 均分', () => {
    const { doc, layer } = fixture(0);
    const verts = skinVertices(doc, layer, 0, null);
    assert.equal(verts.cols, SKIN_DEFAULTS.grid.cols);
    assert.equal(verts.rows, SKIN_DEFAULTS.grid.rows);
    assert.equal(verts.pts.length, 25);
    assert.equal(verts.uvs.length, 25);
    assert.deepEqual(verts.uvs[0], { u: 0, v: 0 });
    assert.deepEqual(verts.uvs[24], { u: 1, v: 1 });
    assert.deepEqual(verts.uvs[1], { u: 0.25, v: 0 });
    // 没有 skin 的对象：不画（返回 null，调用方据此直接 return，不留下半张网格）
    const plain = createDoc({ objects: [{ id: 'obj-2', name: '对象 2' }] });
    assert.equal(skinVertices(plain, plain.objects[0], 0, null), null);
});

test('屏幕命中：阈值内取最近，同距取后者，超阈值不命中', () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0 }];
    assert.equal(pickSkinVertex(pts, { x: 2, y: 0 }, 9), 0);
    assert.equal(pickSkinVertex(pts, { x: 99, y: 0 }, 9), 2, '同距取后者（后画的压在上面）');
    assert.equal(pickSkinVertex(pts, { x: 50, y: 40 }, 9), null);
    assert.equal(pickSkinVertex([], { x: 0, y: 0 }), null);
    assert.equal(pickSkinVertex(null, { x: 0, y: 0 }), null);
});

test('Σw 判据：空槽与坏数据都算 0，全部骨权重相加', () => {
    assert.equal(weightSum(undefined), 0);
    assert.equal(weightSum([]), 0);
    assert.equal(weightSum([{ boneId: 'b', w: 1 }]), 1);
    assert.equal(weightSum([{ w: 0.5 }, { w: Number.NaN }, { w: 0.25 }]), 0.75);
    assert.ok(WEIGHT_EPS > 0 && WEIGHT_EPS < 1e-9, 'Σw 的判据必须是极小正数');
});

test('画布输入：权重分支排在右键早退之后，且只在叠加态激活时接管', () => {
    const src = read('../app/editors/canvas-input.mjs');
    const rightBtn = src.indexOf('if (e.button !== 0) return;');
    const branch = src.indexOf("onHandle.kind === 'weight-vertex'");
    assert.ok(rightBtn >= 0, '右键早退没了（右键涂抹的默认行为会回来）');
    assert.ok(branch > rightBtn, '权重分支必须在右键早退之后');
    assert.ok(src.includes('ctx.setWeightVertex(onHandle.vertex)'));
    assert.ok(src.includes('e.stopPropagation();'));
    assert.ok(
        src.includes('if (typeof ctx.weightMode !== \'function\' || !ctx.weightMode()) return null;'),
        '未激活时必须直接返回 null —— 否则普通点击会被权重层吃掉',
    );
});

test('画布绘制顺序：骨架 → 权重顶点 → 选框判空', () => {
    const src = read('../app/editors/canvas.mjs');
    const bones = src.indexOf('drawBones(g);');
    const weights = src.indexOf('drawSkinWeights(g);');
    const info = src.indexOf('const info = selectionInfo();');
    assert.ok(bones >= 0, '骨架绘制没了');
    assert.ok(weights > bones, '权重顶点要画在骨架之后');
    assert.ok(info > weights, '权重顶点必须在 selectionInfo() 判空之前（没选中也得能编辑权重）');
    assert.ok(src.includes('function drawSkinWeights(g)'));
    assert.equal(src.includes('latticeWireframe('), false, '网格线不许用 latticeWireframe（偏移会算两遍）');
    assert.ok(src.includes('skinVertices('), '顶点位置只能来自 skinVertices');
});

test('画笔引擎没有被改动：权重不占 TOOLS、不改 downIntent', () => {
    const src = read('../app/paint/engine.mjs');
    assert.equal(src.includes('weightMode'), false, 'engine.mjs 不该认识权重叠加态');
    assert.equal(/weight-\s*edit/.test(src), false, 'engine.mjs 不该出现权重编辑的 DOM 标记');
});

test('weight-paint.mjs 是纯 core：不碰 DOM、不引外壳/编辑器', () => {
    const src = read('../app/core/weight-paint.mjs');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/\bdocument\b|\bwindow\b/.test(code), false, 'core 不许摸 DOM');
    for (const bad of ["from '../editors/", "from '../shell/", "from '../paint/", "from './shell"]) {
        assert.equal(src.includes(bad), false, 'core 不许引 ' + bad);
    }
});

test('权重词条：两种语言都齐、en 不带汉字、运行期词典能取到', async () => {
    const keys = [
        'props.obj.weightEdit',
        'props.obj.weightEditOff',
        'props.obj.weightEditTitle',
        'props.obj.weightBone',
        'props.obj.weightBoneNone',
        'props.obj.weightErrNoSkin',
    ];
    const part = (await import('../app/i18n/parts/props.mjs')).default;
    for (const key of keys) {
        const en = part.en[key];
        const zh = part['zh-Hans'][key];
        assert.ok(typeof en === 'string' && en.length > 0, 'en 缺 ' + key);
        assert.ok(typeof zh === 'string' && zh.length > 0, 'zh 缺 ' + key);
        assert.equal(/[\u4e00-\u9fff]/.test(en), false, 'en 表不许出现汉字：' + key);
        assert.equal(has(key), true, '运行期词典取不到 ' + key);
    }
});

test('绑定不改传入对象：structural sharing（一步撤销的前提）', () => {
    const { doc, layer, before } = fixture(0);
    assert.ok(skinOf(layer), '绑定后皮肤要在');
    assert.equal(skinOf(before), null, 'bindSkin 不许就地改原对象');
    const bones = skinOf(layer).bones;
    assert.equal(bones.length, 1);
    assert.equal(bones[0].id, 'bone-1');
    assert.equal(bones[0].bind.length, 6, 'bind 必须是 6 元组的世界矩阵快照');
    assert.ok(doc.objects.length === 2);
});

/* ═══════════════════ P2-C 步 2：刷权重 ═══════════════════
   写入数学全在 core/weight-paint 的 paintWeights，这里把它的三条前提钉死：
   单骨权重是绝对值（补足法）、Σw 恒等于 1、刷到 0 就是删掉那一项。 */

/** 手造蒙皮：逐顶点 `[{b,w}]`，`b` 是 bones 的下标。 */
function handmade(weights, bones = [{ id: 'bone-1', bind: [1, 0, 0, 1, 0, 0] }], grid = { cols: 1, rows: 1 }) {
    return { grid, bones, pts: weights };
}

const wOf = (slot, b) => {
    for (const it of slot || []) if (it && it.b === b) return it.w;
    return 0;
};
const sumOf = (slot) => (slot || []).reduce((a, it) => a + (it && Number.isFinite(it.w) ? it.w : 0), 0);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('补足法：把 b0 刷到 1（strength 1）后该顶点只剩 b0', () => {
    const skin = handmade([[
        { b: 0, w: 0.5 }, { b: 1, w: 0.3 }, { b: 2, w: 0.2 },
    ]], [{ id: 'b1', bind: [1, 0, 0, 1, 0, 0] }, { id: 'b2', bind: [1, 0, 0, 1, 0, 0] }, { id: 'b3', bind: [1, 0, 0, 1, 0, 0] }]);
    const out = paintWeights(skin, [0], 0, 1, 1);
    assert.equal(out.pts[0].length, 1, '目标骨吃满之后不该再留别的骨');
    assert.equal(out.pts[0][0].b, 0);
    assert.ok(near(out.pts[0][0].w, 1), `w 应为 1，实际 ${out.pts[0][0].w}`);
});

test('补足法：strength 0.5 连刷单调递增并收敛到 1（不会卡在 0.615）', () => {
    // 反例来自设计稿 §3：把 b0 直接设成 0.8 再让 normalize 归一，只得 0.615
    let skin = handmade([[
        { b: 0, w: 0.5 }, { b: 1, w: 0.3 }, { b: 2, w: 0.2 },
    ]], [{ id: 'b1', bind: [1, 0, 0, 1, 0, 0] }, { id: 'b2', bind: [1, 0, 0, 1, 0, 0] }, { id: 'b3', bind: [1, 0, 0, 1, 0, 0] }]);
    let prev = 0.5;
    for (let i = 0; i < 20; i++) {
        skin = paintWeights(skin, [0], 0, 1, 0.5);
        const w = wOf(skin.pts[0], 0);
        assert.ok(w > prev - 1e-12, `第 ${i} 刷应单调不减：${prev} → ${w}`);
        prev = w;
    }
    assert.ok(near(prev, 1, 1e-6), `连刷 20 次应收敛到 1，实际 ${prev}`);
});

test('补足法：非目标骨的总和恒等于 1 − wNew', () => {
    const skin = handmade([[
        { b: 0, w: 0.4 }, { b: 1, w: 0.35 }, { b: 2, w: 0.25 },
    ]], [{ id: 'b1', bind: [1, 0, 0, 1, 0, 0] }, { id: 'b2', bind: [1, 0, 0, 1, 0, 0] }, { id: 'b3', bind: [1, 0, 0, 1, 0, 0] }]);
    for (const strength of [0.25, 0.5, 1]) {
        const out = paintWeights(skin, [0], 0, 1, strength);
        const wNew = wOf(out.pts[0], 0);
        let rest = 0;
        for (const it of out.pts[0]) if (it.b !== 0) rest += it.w;
        assert.ok(near(rest, 1 - wNew), `strength ${strength}：其余骨 ${rest} ≠ ${1 - wNew}`);
        assert.ok(near(sumOf(out.pts[0]), 1), 'Σw 必须等于 1');
    }
});

test('每顶点最多 4 根骨：已有 5 根骨时刷目标骨仍不超上限、含目标骨、降序', () => {
    const bones = [0, 1, 2, 3, 4].map((i) => ({ id: 'b' + i, bind: [1, 0, 0, 1, 0, 0] }));
    const slot = [0, 1, 2, 3, 4].map((b) => ({ b, w: 0.2 }));
    const out = paintWeights(handmade([slot], bones), [0], 0, 1, 1);
    assert.ok(out.pts[0].length <= SKIN_MAX_BONES_PER_POINT, `实际 ${out.pts[0].length} 项`);
    assert.ok(wOf(out.pts[0], 0) > 0, '目标骨必须留下 —— 否则用户刷半天没反应');
    assert.ok(near(sumOf(out.pts[0]), 1), 'Σw 必须等于 1');
    for (let i = 1; i < out.pts[0].length; i++) {
        assert.ok(out.pts[0][i - 1].w >= out.pts[0][i].w - 1e-12, '权重必须降序（画布取主骨靠它）');
    }
});

test('刷到 0：目标骨那一项被删掉，其余骨补满（不是存一个 0）', () => {
    const skin = handmade([[
        { b: 0, w: 0.5 }, { b: 1, w: 0.5 },
    ]], [{ id: 'b1', bind: [1, 0, 0, 1, 0, 0] }, { id: 'b2', bind: [1, 0, 0, 1, 0, 0] }]);
    const out = paintWeights(skin, [0], 0, 0, 1);
    assert.equal(wOf(out.pts[0], 0), 0, '刷到 0 之后不该再出现 b0');
    assert.equal(out.pts[0].length, 1);
    assert.ok(near(out.pts[0][0].w, 1), '剩下的骨应吃满');
    for (const it of normalizeSkin(out).pts[0]) assert.ok(it.w > 0, '落盘项一律 w > 0');
});

test('空槽顶点被刷后变成单骨满权重（Σw≈0 不是特例）', () => {
    const skin = handmade([[]], [{ id: 'bone-1', bind: [1, 0, 0, 1, 0, 0] }]);
    const out = paintWeights(skin, [0], 0, 1, 1);
    assert.equal(out.pts[0].length, 1);
    assert.ok(near(out.pts[0][0].w, 1));
});

test('paintWeights 不改入参，未命中的顶点内容一个数都不变', () => {
    const grid = { cols: 1, rows: 1 };
    const bones = [{ id: 'b1', bind: [1, 0, 0, 1, 0, 0] }, { id: 'b2', bind: [1, 0, 0, 1, 0, 0] }];
    const untouched = [{ b: 1, w: 1 }];
    const skin = { grid, bones, pts: [[{ b: 0, w: 0.5 }, { b: 1, w: 0.5 }], untouched] };
    const snapshot = JSON.stringify(skin);
    const out = paintWeights(skin, [0], 0, 1, 1);
    assert.equal(JSON.stringify(skin), snapshot, '入参必须一个字节都不变');
    assert.notEqual(out, skin, '必须返回新对象（skin 换引用才会触发重绘）');
    assert.deepEqual(out.grid, grid);
    assert.deepEqual(out.bones, bones);
    assert.deepEqual(out.pts[1], untouched, '未命中的顶点内容必须原样');
    assert.notDeepEqual(out.pts[0], skin.pts[0], '命中的顶点必须换掉');
});

test('hits 两种写法等价：下标数组 / 带 strength 的对象数组（重复取较大值）', () => {
    const bones = [{ id: 'b1', bind: [1, 0, 0, 1, 0, 0] }, { id: 'b2', bind: [1, 0, 0, 1, 0, 0] }];
    const skin = handmade([
        [{ b: 0, w: 0.5 }, { b: 1, w: 0.5 }],
        [{ b: 0, w: 0.5 }, { b: 1, w: 0.5 }],
    ], bones);
    const a = paintWeights(skin, [0, 1], 0, 1, 1);
    const b = paintWeights(skin, [{ index: 0, strength: 1 }, { index: 1, strength: 1 }], 0, 1, 1);
    assert.equal(JSON.stringify(a.pts), JSON.stringify(b.pts));
    const dup = paintWeights(skin, [{ index: 0, strength: 0.2 }, { index: 0, strength: 0.8 }], 0, 1, 1);
    const single = paintWeights(skin, [{ index: 0, strength: 0.8 }], 0, 1, 1);
    assert.ok(near(wOf(dup.pts[0], 0), wOf(single.pts[0], 0)), '重复下标取较大强度，不是相加');
});

/** 4×4 网格的 uvs（行优先），与 skin.grid 的顶点序号一一对应 */
const gridUvs = (cols, rows) => {
    const out = [];
    for (let r = 0; r <= rows; r++) {
        for (let c = 0; c <= cols; c++) out.push({ u: c / cols, v: r / rows });
    }
    return out;
};

test('brushVertices：半径内按距离衰减，半径外一个都不碰', () => {
    const uvs = gridUvs(4, 4);
    const hits = brushVertices({ uvs }, { u: 0.5, v: 0.5 }, 0.25);
    assert.ok(hits.length > 0, '圆心处至少有一个顶点');
    for (const hit of hits) {
        const uv = uvs[hit.index];
        const dist = Math.hypot((uv.u - 0.5) / 0.25, (uv.v - 0.5) / 0.25);
        assert.ok(dist < 1 - 1e-12, '半径外的顶点不该入选');
        assert.ok(near(hit.strength, 1 - dist, 1e-12), '强度 = 1 − 归一化距离');
    }
    // 半径收到下限时只剩圆心那颗顶点
    const centered = uvs.findIndex((uv) => near(uv.u, 0.5) && near(uv.v, 0.5));
    assert.deepEqual(brushVertices({ uvs }, { u: 0.5, v: 0.5 }, 0.02).map((h) => h.index), [centered]);
});

test('brushVertices：圆心收顶点下标与收 uv 等价', () => {
    const uvs = gridUvs(2, 2);
    const byIndex = brushVertices({ uvs }, 4, 0.3);
    const uv = uvs[4];
    assert.deepEqual(byIndex, brushVertices({ uvs }, { u: uv.u, v: uv.v }, 0.3));
});

test('brushVertices + paintWeights：涂抹只改半径内的顶点', () => {
    const uvs = gridUvs(2, 2);
    const bones = [{ id: 'b1', bind: [1, 0, 0, 1, 0, 0] }, { id: 'b2', bind: [1, 0, 0, 1, 0, 0] }];
    const all = uvs.map(() => [{ b: 1, w: 1 }]);
    const skin = { grid: { cols: 2, rows: 2 }, bones, pts: all };
    const hits = brushVertices({ uvs }, { u: 0, v: 0 }, 0.2);
    const out = paintWeights(skin, hits, 0, 1, 1);
    const touched = new Set(hits.map((h) => h.index));
    assert.ok(touched.size > 0);
    for (let i = 0; i < out.pts.length; i++) {
        if (touched.has(i)) continue;
        assert.deepEqual(out.pts[i], all[i], `第 ${i} 个顶点在半径外，不该被改写`);
        assert.equal(wOf(out.pts[i], 0), 0, '半径外不该出现目标骨');
    }
});

test('mainBoneIndex / boneColorOf：主骨取最大权重，颜色优先用骨骼自己的', () => {
    const doc = createDoc({
        width: 900,
        height: 640,
        objects: [
            makeObject({
                id: 'b1', name: 'B1', kind: 'bone',
                bone: { len: 120, width: 14, color: '#ff0000' },
                transform: { keys: [createKey(0, {})] },
            }),
            makeObject({ id: 'b2', name: 'B2', kind: 'bone', transform: { keys: [createKey(0, {})] } }),
        ],
    });
    const skin = { grid: { cols: 1, rows: 1 }, bones: [{ id: 'b1', bind: [1, 0, 0, 1, 0, 0] }, { id: 'b2', bind: [1, 0, 0, 1, 0, 0] }], pts: [] };
    assert.equal(mainBoneIndex([{ b: 0, w: 0.2 }, { b: 1, w: 0.8 }]), 1);
    assert.equal(mainBoneIndex([]), -1, '空槽没有主骨');
    assert.equal(mainBoneIndex([{ b: 0, w: WEIGHT_EPS / 2 }]), -1, '权重全为 0 也不算有主骨');
    assert.equal(boneColorOf(doc, skin, 0), '#ff0000', '骨骼自己的颜色优先');
    assert.equal(boneColorOf(doc, skin, 1), BONE_DEFAULTS.color, '没设颜色就用缺省');
});

test('cachedSkinVertices：同帧复用同一份，换时间后重算', () => {
    const doc = createDoc({
        width: 900,
        height: 640,
        objects: [
            makeObject({
                id: 'b1', name: 'B1', kind: 'bone', bone: { len: 120, width: 14 },
                transform: { keys: [createKey(0, {}), createKey(1, { x: 40, y: 0 })] },
            }),
            makeObject({
                id: 's1', name: 'S',
                skin: {
                    grid: { cols: 1, rows: 1 },
                    bones: [{ id: 'b1', bind: [1, 0, 0, 1, 0, 0] }],
                    pts: [[{ b: 0, w: 1 }], [{ b: 0, w: 1 }], [{ b: 0, w: 1 }], [{ b: 0, w: 1 }]],
                },
            }),
        ],
    });
    const el = doc.objects.find((o) => o.id === 's1');
    const a = cachedSkinVertices(doc, el, 1, null);
    assert.ok(a && a.pts.length === 4);
    assert.equal(cachedSkinVertices(doc, el, 1, null), a, '同对象同帧同矩阵必须命中缓存');
    assert.notEqual(cachedSkinVertices(doc, el, 0, null), a, '换了时间必须重算');
    assert.notEqual(skinVertices(doc, el, 1, null), a, '纯函数路径不受缓存影响');
});

test('源码守卫（步 2）：松手记一条命令、拖动中静默、Esc 回滚', () => {
    const src = read('../app/editors/canvas-input.mjs');
    const cut = (from, to) => {
        const at = src.indexOf(from);
        assert.ok(at >= 0, '源码里找不到：' + from);
        const end = src.indexOf(to, at);
        assert.ok(end > at, '切不出这一段：' + from);
        return src.slice(at, end);
    };
    const body = cut('function onDragEnd()', 'function previewAnchor()');
    assert.ok(body.includes("pickKind === 'weight-paint'"), '松手必须认出权重手势');
    assert.ok(body.includes('pushCommand'), '松手必须记进撤销栈');
    assert.ok(body.includes('history.push'), 'pushCommand 缺失时的回落路径也要在');
    assert.ok(/canceled[\s\S]*setDoc\(before,\s*\{\s*silent:\s*true\s*\}\)/.test(body), 'Esc 必须静默回滚');
    const draw = cut('function applyWeightStroke(', 'let hover = null;');
    assert.ok(/silent:\s*true/.test(draw), '逐帧写入必须 silent —— 否则一刷几十条撤销');
    assert.equal(/coalesce\s*:/.test(draw), false, '不许配 coalesce：DOC_GESTURE_MS 会把两次拖动并成一条');
    // 右键取色 / 空格平移 / 滚轮缩放一路都不许被权重层吃掉
    const down = cut('function onDown(e)', 'function dispose()');
    assert.ok(down.indexOf('e.button !== 0') < down.indexOf("kind === 'weight-vertex'"), '右键早退必须在前');
});
