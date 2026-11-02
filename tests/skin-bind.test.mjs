// 骨骼 P2-B 单测：蒙皮的「绑定层」—— 命令 / 父链硬约束 / 属性面板的蒙皮段。
//
// 为什麼一半是源码守卫：命令表与撤销栈都长在 app.mjs / doc-state.mjs 里，而这两个模块
// **在 import 期就碰 document**（引擎、持久化、撤销栈住在同一个模块），node --test 里拿不到
// 实例。所以「命令怎么建皮肤」钉死三件事：命令 id 与词条、写口必须是 setDoc + 一步撤销的
// label、四条拒绝分支；能真跑的数学与数据（绑定快照、结构共享、解绑只删 skin、落盘纯净）
// 一律真断言，不靠正则兜底。
//
// 「撤销一步回到无 skin」用结构共享证明，而不是去拨真撤销栈：命令写的是 patchObject 产出的
// **新文档**，原文档那份引用还是绑定前的样子 —— 撤销栈回退的就是它。这样测的是真正的不变量
// （不可变写入），而不是 DOM 环境里那份栈的实现细节。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createDoc, makeObject, objectsOf, patchObject } from '../app/core/doc-model.mjs';
import { createKey } from '../app/core/transform.mjs';
import { createLattice, setVertex } from '../app/core/lattice.mjs';
import { SKIN_DEFAULTS, bindSkin, boneMatrices, skinOf } from '../app/core/skin.mjs';
import { docToFile } from '../app/shell/project-store.mjs';
import { has } from '../app/i18n/index.mjs';
import commandsPart from '../app/i18n/parts/commands.mjs';
import propsPart from '../app/i18n/parts/props.mjs';
import { parentBlocked } from '../app/editors/tree.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const HAN = /[\u4e00-\u9fff]/;

const DOC = { width: 800, height: 600 };
const docOf = (objects) => createDoc({ width: DOC.width, height: DOC.height, objects });
const firstOf = (doc, id) => objectsOf(doc).find((o) => o.id === id);

/** 骨骼：默认 120×14、锚点在根部中线；t=1 时沿 +x 挪 100px（好让「绑定姿态 ≠ 当前姿态」）。 */
const boneOf = (id = 'b1') => makeObject({
    id,
    name: id,
    kind: 'bone',
    bone: { len: 120, width: 14 },
    transform: { keys: [createKey(0, {}), createKey(1, { x: 100 })] },
});

/** 被蒙皮对象：无纹理（骨骼绑定不需要位图，elementSize 会走文档尺寸兜底）。 */
const skinLayerOf = () => makeObject({ id: 's1', name: 'Skin', kind: 'paint' });

/** 一个「用户先拖过顶点」的变形网格，用来验证解绑不顺手抹掉它。 */
const warpOf = () => setVertex(createLattice(1, 1), 0, 10, -5);

const layerWithWarp = () => makeObject({
    id: 's1',
    name: 'Skin',
    kind: 'paint',
    transform: { keys: [createKey(0, { warp: warpOf() })] },
});

/** 绑定一次，返回 { doc, layer, skin }（doc 不含 skin，skin 是 bindSkin 的产物）。 */
function bindOnce() {
    const doc = docOf([boneOf(), skinLayerOf()]);
    const layer = firstOf(doc, 's1');
    const skin = bindSkin(doc, layer, ['b1'], { grid: SKIN_DEFAULTS.grid, t: 0 });
    return { doc, layer, skin };
}

/* ─────────────────────── 绑定：数据形状 ─────────────────────── */

test('绑定后 skinOf 有值：网格用 SKIN_DEFAULTS（4×4 → 25 顶点），非骨骼 id 被跳过', () => {
    const doc = docOf([boneOf(), skinLayerOf()]);
    const layer = firstOf(doc, 's1');
    const skin = bindSkin(doc, layer, ['b1', 'nope', ''], { grid: SKIN_DEFAULTS.grid, t: 0 });
    assert.ok(skin, 'bindSkin 必须返回新 skin');
    assert.deepEqual(skin.grid, { cols: 4, rows: 4 }, '缺省网格就是 SKIN_DEFAULTS');
    assert.equal(skin.bones.length, 1, '不是骨骼的 id 必须被跳过');
    assert.equal(skin.pts.length, 25, '(4+1)×(4+1) 个顶点');
    const bound = makeObject(Object.assign({}, layer, { skin }));
    assert.ok(skinOf(bound), 'skinOf 要能读回刚绑好的皮肤');
    assert.equal(skinOf(layer), null, 'bindSkin 不改传进来的 layer');
});

test('绑定快照：bones[].bind 是 6 元组，且等于绑定时刻骨骼的世界矩阵', () => {
    const { doc, skin } = bindOnce();
    const at0 = boneMatrices(doc, skin, 0)[0];
    assert.equal(at0.ok, true, '骨骼存在且是骨骼 → ok');
    assert.equal(at0.bind.length, 6, 'bind 必须是六元组（落盘形状）');
    assert.deepEqual(at0.bind, at0.now, '在绑定时刻，绑定姿态 = 当前世界矩阵');
});

test('绑定快照不跟着骨骼走：t=1 时 now 变了，bind 还是绑定那一刻', () => {
    const { doc, skin } = bindOnce();
    const at0 = boneMatrices(doc, skin, 0)[0];
    const at1 = boneMatrices(doc, skin, 1)[0];
    assert.deepEqual(at1.bind, at0.bind, 'bind 是快照，不该随时间/父链变化');
    assert.notDeepEqual(at1.now, at1.bind, '骨骼动起来后当前矩阵必须变');
    assert.equal(at1.now[4], at0.now[4] + 100, '六元组的平移分量跟着 +100');
});

/* ─────────────────────── 一步撤销 / 解除绑定 ─────────────────────── */

test('一步撤销：patchObject 产出新文档，原文档仍是绑定前的样子', () => {
    const { doc, layer, skin } = bindOnce();
    const next = patchObject(doc, 's1', (o) => Object.assign({}, o, { skin }));
    assert.ok(skinOf(firstOf(next, 's1')), '新文档里有皮肤');
    assert.equal(skinOf(firstOf(doc, 's1')), null, '原文档不能被改 —— 撤销一步回退到的就是它');
    assert.equal(layer.skin, undefined, 'bindSkin 也不许把 skin 塞回传入的 layer');
});

test('解除绑定：只删 skin 一个字段，st.warp 与变换通道原样保留', () => {
    const doc0 = docOf([boneOf(), layerWithWarp()]);
    const layer = firstOf(doc0, 's1');
    const before = JSON.parse(JSON.stringify(layer.transform.keys[0].state.warp));
    const skin = bindSkin(doc0, layer, ['b1'], { grid: SKIN_DEFAULTS.grid, t: 0 });
    const bound = patchObject(doc0, 's1', (o) => Object.assign({}, o, { skin }));
    const unbound = patchObject(bound, 's1', (o) => {
        const copy = Object.assign({}, o);
        delete copy.skin;
        return copy;
    });
    const back = firstOf(unbound, 's1');
    assert.equal(skinOf(back), null, '解绑后 skinOf 必须是 null');
    assert.deepEqual(back.transform.keys[0].state.warp, before, 'warp 是用户雕的网格，解绑不能抹掉');
    assert.deepEqual(back.bone, undefined, '解绑不该在对象上留下骨骼字段');
});

/* ─────────────────────── 父链硬约束 ─────────────────────── */

test('父链拦截：带蒙皮的对象落进骨骼 → 拒绝', () => {
    const { doc, skin } = bindOnce();
    const skinned = makeObject(Object.assign({}, firstOf(doc, 's1'), { skin }));
    const withSkin = docOf([boneOf('b1'), skinned]);
    assert.equal(parentBlocked(withSkin, 's1', 'b1'), true);
});

test('父链拦截的反例：非蒙皮对象 / 目标不是骨骼 / 骨骼进骨骼 全部放行', () => {
    const { doc, skin } = bindOnce();
    const skinned = makeObject(Object.assign({}, firstOf(doc, 's1'), { skin }));
    const plain = makeObject({ id: 's2', name: 'Plain', kind: 'paint' });
    const world = docOf([boneOf('b1'), boneOf('b2'), skinned, plain]);
    assert.equal(parentBlocked(world, 's2', 'b1'), false, '非蒙皮对象挂骨骼下面 = 纯层级跟随');
    assert.equal(parentBlocked(world, 's1', 's2'), false, '目标不是骨骼');
    assert.equal(parentBlocked(world, 'b2', 'b1'), false, '骨骼的父级可以是骨骼（骨链是正常结构）');
    assert.equal(parentBlocked(world, 's1', 's1'), false, '自己拖自己没有意义（环检测归 core）');
    assert.equal(parentBlocked(null, 's1', 'b1'), false, '没有文档时不能抛');
});

/* ─────────────────────── 落盘纯净 ─────────────────────── */

test('落盘纯净：skin 进 .msp，词条键与译文一个字都不进', () => {
    const { doc, layer, skin } = bindOnce();
    const bound = patchObject(doc, 's1', (o) => Object.assign({}, o, { skin }));
    const saved = docToFile(bound, { name: 'skin-bind', savedAt: 1 });
    const blob = JSON.stringify(saved);
    assert.ok(blob.includes('"skin"'), 'skin 必须落盘（P2-A 的白名单）');
    assert.ok(blob.includes('"bind"'), '绑定快照必须落盘');
    for (const bad of ['props.obj.', 'cmd.object.', 'cmd.group.', 'effect.', 'skinKey', 'labelKey', 'nameKey']) {
        assert.equal(blob.includes(bad), false, '落盘里不该出现 ' + bad);
    }
    for (const [key, value] of Object.entries(propsPart['zh-Hans'])) {
        if (!key.startsWith('props.obj.skin')) continue;
        assert.equal(blob.includes(value), false, '译文进了存档：' + key + ' = ' + value);
    }
    const savedSkin = (saved.elements || []).find((el) => el && el.id === 's1').skin;
    assert.ok(savedSkin && savedSkin.grid, '存档里那张皮肤要有网格');
    assert.deepEqual(savedSkin.grid, { cols: 4, rows: 4 }, '网格原样落盘');
    assert.equal(savedSkin.bones[0].bind.length, 6, '绑定快照落盘后仍是六元组');
});

/* ─────────────────────── 命令契约（源码守卫） ─────────────────────── */

const APP_SRC = read('../app/shell/app.mjs');
const TREE_SRC = read('../app/editors/tree.mjs');
const PANEL_SRC = read('../app/editors/prop-object.mjs');

const keyOf = (id) => 'cmd.' + id.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
const BIND_COMMANDS = ['object.bind-skin', 'object.unbind-skin'];

test('命令契约：两个 id 冻结，两表都有命令名与 hint，且已并进运行期词典', () => {
    for (const id of BIND_COMMANDS) {
        assert.ok(APP_SRC.includes(`id: '${id}'`), '命令表里少了 ' + id);
        for (const table of [commandsPart.en, commandsPart['zh-Hans']]) {
            assert.ok(table[keyOf(id)] && table[keyOf(id)].trim(), keyOf(id) + ' 缺命令名');
            assert.ok(table[keyOf(id) + '.hint'] && table[keyOf(id) + '.hint'].trim(), keyOf(id) + '.hint 缺说明');
        }
        assert.ok(has(keyOf(id)), keyOf(id) + ' 没并进运行期词典');
        assert.ok(has(keyOf(id) + '.hint'), keyOf(id) + '.hint 没并进运行期词典');
    }
});

test('绑定命令的写口：setDoc + 一步撤销的 label，所有拒绝分支都在写之前', () => {
    assert.match(APP_SRC, /setDoc\(\(\) => next, \{ label: t\('cmd\.object\.bindSkin'\) \}\)/, '绑定没走 setDoc + label');
    assert.match(APP_SRC, /setDoc\(\(\) => next, \{ label: t\('cmd\.object\.unbindSkin'\) \}\)/, '解绑没走 setDoc + label');
    assert.ok(APP_SRC.includes('SKIN_DEFAULTS.grid'), '网格必须用 core 的缺省 4×4');
    assert.ok(APP_SRC.includes("target.kind === 'bone'"), '没拦「被绑对象自己是骨骼」');
    assert.ok(APP_SRC.includes("parent.kind === 'bone'"), '没拦「父级已经是骨骼」');
    // 绑定时刻被绑对象还没有 skin，所以命令侧不能直接复用 tree 的 parentBlocked（那个判的是
    // 「已经是蒙皮对象」）：命令判「将来会违规」，拖拽判「现在就违规」，两条各守一个时刻。
    assert.match(APP_SRC, /const parent = target\.parentId \? objectById\(doc, target\.parentId\) : null;/, '没查被绑对象的父级');
    assert.match(APP_SRC, /if \(parent && parent\.kind === 'bone'\)/, '命令侧没拦「父级已经是骨骼」');
    for (const key of ['props.obj.skinErrNoObject', 'props.obj.skinErrBone', 'props.obj.skinErrParentBone', 'props.obj.skinErrNoBones']) {
        assert.ok(APP_SRC.includes(`t('${key}')`), '缺拒绝分支提示：' + key);
    }
    // 拒绝分支必须排在 setDoc 之前：用户被拒绝时撤销栈里不该多一步空操作
    const firstGuard = APP_SRC.indexOf("t('props.obj.skinErrNoObject')");
    const firstWrite = APP_SRC.indexOf("setDoc(() => next, { label: t('cmd.object.bindSkin') })");
    assert.ok(firstGuard > 0 && firstWrite > firstGuard, '拒绝分支必须在写之前');
});

test('属性面板：蒙皮段只有摘要 + 解除绑定，且走 shell 的同一份解除实现', () => {
    assert.ok(PANEL_SRC.includes("makeGroup(el, t('props.obj.groupSkin'), 'skin')"), '蒙皮组没建');
    assert.ok(PANEL_SRC.includes("t('props.obj.skinSummary'"), '摘要没走词条');
    assert.ok(PANEL_SRC.includes("'skin-summary'") && PANEL_SRC.includes("'skin-unbind'"), '摘要/按钮缺 data-k 标记');
    assert.ok(PANEL_SRC.includes('ctx.unbindSkinOfSelected'), '按钮没走 shell 的同一份解除实现');
    assert.ok(PANEL_SRC.includes('function paintSkin(doc)'), '缺 paintSkin');
    assert.ok(PANEL_SRC.includes("group.style.display = skin ? '' : 'none'"), '没有皮肤时应收起整组');
    // 允许中间插入别的组（P3 的 paintIk 就插在两者之间）
    assert.match(PANEL_SRC, /paintBone\(doc\);[\s\S]{0,200}?paintSkin\(doc\);/, 'refresh() 里没有 paintSkin');
    assert.match(PANEL_SRC, /for \(const body of \[[^\]]*skinBody\]/, 'destroy 没清蒙皮组');
});

test('父链拦截落在 tree.mjs 的两条改父路径上（dragover 标红 + drop 早退）', () => {
    assert.ok(TREE_SRC.includes('export function parentBlocked(doc, movedId, targetId)'), '缺导出的纯判定');
    const calls = [...TREE_SRC.matchAll(/parentBlocked\(ctx\.doc\(\), /g)];
    // 只有两处：dragover 里给 drop-invalid（不让光标先给出「能落」的假信号）与 drop 里写文档之前早退。
    // 曾经还有第三处在 setParentOf 的「老接口降级」里，但那条路径调的 ctx.setParent 在 ctx 上
    // 从来不存在（真正叫 setLayerParent），分支永远 return —— 已随本批删除，所以这里要的是 2。
    assert.equal(calls.length, 2, 'parentBlocked 的调用点应为 2 处，实际 ' + calls.length);
    assert.ok(TREE_SRC.includes("row.classList.add('drop-invalid')"), '非法落点没有标红');
    assert.ok(TREE_SRC.includes("notify(t('props.obj.skinErrParentBone'))"), '被拒时没有提示');
    assert.ok(!TREE_SRC.includes('setParentOf'), 'setParentOf 是死降级（ctx.setParent 不存在），不该再出现');
});

/* ─────────────────────── 词条 ─────────────────────── */

test('蒙皮段的词条两表齐全：en 无汉字、zh 是真中文、占位符两边一致', () => {
    const keys = Object.keys(propsPart.en).filter((k) => k.startsWith('props.obj.skin'));
    assert.ok(keys.length >= 10, '蒙皮段词条太少：' + keys.length);
    assert.deepEqual(keys, Object.keys(propsPart['zh-Hans']).filter((k) => k.startsWith('props.obj.skin')), '两表镜面');
    for (const key of keys) {
        const en = propsPart.en[key];
        const zh = propsPart['zh-Hans'][key];
        assert.ok(en.trim() && zh.trim(), key + ' 有空值');
        assert.equal(HAN.test(en), false, key + ' 的英文里有汉字');
        assert.ok(HAN.test(zh), key + ' 的中文里没有汉字');
        const holes = (s) => [...s.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]).sort();
        assert.deepEqual(holes(en), holes(zh), key + ' 两侧占位符不一致');
    }
    // 面板与命令在运行期取的就是这些键
    for (const key of ['props.obj.groupSkin', 'props.obj.skinSummary', 'props.obj.skinUnbind', 'props.obj.skinUnbindTitle', 'props.obj.skinUnbound']) {
        assert.ok(has(key), key + ' 没并进运行期词典');
    }
});
