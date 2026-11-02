// 骨骼 P3 步 3：IK 面板（`app/editors/prop-object.mjs` 的那三行）。
//
// 面板是 DOM 代码，node 里没有 document，所以这里分两半：
//   · 源码守卫：控件、写口、刷新与销毁三处接线都在（少一处就是「改了不生效」或内存泄漏）
//   · 行为：写口必须把「没有目标」变成 `ik: null`，而不是留一个 targetId 空壳
//
// 真正的视觉验收在 `npm run smoke` 与手测（见 docs/IK设计-2026-11-02.md §6）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { IK_DEFAULTS, IK_MAX_CHAIN, normalizeIk } from '../app/core/ik.mjs';

const SRC = readFileSync(new URL('../app/editors/prop-object.mjs', import.meta.url), 'utf8');
const PROPS = readFileSync(new URL('../app/i18n/parts/props.mjs', import.meta.url), 'utf8');

test('面板三行都在：启用开关 / 目标下拉 / 链长', () => {
    assert.ok(SRC.includes("makeGroup(el, t('props.obj.groupIk'), 'ik')"), '缺 IK 分组');
    assert.ok(SRC.includes("'ik-enabled'"), '缺启用开关');
    assert.ok(SRC.includes("'ik-target'"), '缺目标下拉');
    assert.ok(SRC.includes("'ik-chain'"), '缺链长输入');
});

test('三行都接在写口上：改任何一项都会落到 patchActive', () => {
    assert.ok(SRC.includes('function commitIk('), '缺 commitIk');
    assert.ok(SRC.includes('patchActive({ ik: next.targetId ? next : null })'),
        '写口必须走 patchActive，且没有目标时写 null');
    // 三个控件的监听器都要调到 commitIk
    // 定义 1 处 + 三个控件各 1 处 = 4；少一处就是某个控件没接上写口
    const listeners = SRC.split('commitIk(').length - 1;
    assert.ok(listeners >= 4, 'commitIk 的调用点太少（定义 1 + 三个控件），实际 ' + listeners);
});

test('刷新与销毁都带上 IK 组（漏了销毁就是每次重挂残留一个分组）', () => {
    assert.ok(SRC.includes('paintIk(doc);'), 'refresh 里没调 paintIk');
    assert.ok(/for \(const body of \[[^\]]*ikBody/.test(SRC), 'destroy 的 body 列表里没有 ikBody');
});

test('链长输入夹在 1..IK_MAX_CHAIN，且只读 core 的常量', () => {
    assert.ok(SRC.includes('IK_MAX_CHAIN'), '没引用 IK_MAX_CHAIN');
    assert.ok(SRC.includes('IK_DEFAULTS.chain'), '没引用 IK_DEFAULTS.chain');
    assert.ok(SRC.includes('normalizeIk'), '没引用 normalizeIk');
    assert.ok(IK_MAX_CHAIN >= 2, '链长上限至少 2（一根骨的 IK 没有意义）');
});

test('没有目标时不给「能点但无效」的输入：链长与肘部朝向一起禁用', () => {
    assert.ok(SRC.includes('const on = !!(ik && ik.targetId)'), '缺「有没有目标」的判定');
    assert.ok(SRC.includes('ikChain.disabled = !on'), '链长框必须按「有没有目标」禁用');
    assert.ok(SRC.includes('ikBend.disabled = !on'), '肘部朝向也必须一起禁用');
});

test('肘部朝向下拉：三个选项都来自 IK_BENDS，写口与回填都接上', () => {
    assert.ok(SRC.includes("IK_BENDS"), '没引用 IK_BENDS（选项表必须来自 core）');
    assert.ok(SRC.includes("'ik-bend'"), '缺 data-k 标记');
    assert.ok(SRC.includes("t('props.obj.ikBend.' + id)"), '选项文案没走词条');
    assert.ok(SRC.includes("commitIk({ bend: String(ikBend.value || 'auto') })"), '没有写口');
    assert.ok(SRC.includes('ikBend.value = ik ? ik.bend : IK_DEFAULTS.bend'), '没有回填');
    assert.ok(SRC.includes('next.bend === base.bend'), '变更判定漏了 bend（会每次都写一遍文档）');
});

test('目标下拉列出除自己以外的对象，并有「（无）」选项', () => {
    assert.ok(SRC.includes("'props.obj.ikNone'"), '缺「（无）」选项词条');
    assert.ok(SRC.includes('o.id !== layer.id'), '下拉不能列出骨骼自己（会变成自引用）');
    assert.ok(SRC.includes('ikTarget.dataset.sig'), '下拉重建要用签名去抖，否则展开瞬间会被打断');
});

test('词条：IK 五项中英齐全，且英文表没有汉字', () => {
    for (const key of ['props.obj.groupIk', 'props.obj.ikEnabled', 'props.obj.ikTarget', 'props.obj.ikChain', 'props.obj.ikNone']) {
        assert.ok(PROPS.includes("'" + key + "'"), '缺词条 ' + key);
    }
    // 只看「词条行」（'key': 'value'），注释里的中文不算
    const enBlock = PROPS.slice(0, PROPS.indexOf("'zh-Hans'"));
    const bad = enBlock.split('\n').filter((line) => /^\s*'[^']+':\s*'.*[\u4e00-\u9fff]/.test(line));
    assert.deepEqual(bad, [], '英文表的词条值里不该出现汉字');
});

test('行为：没有目标的约束归一为 null（不留 targetId 空壳）', () => {
    assert.equal(normalizeIk({ targetId: '' }), null);
    assert.equal(normalizeIk({ chain: 2 }), null);
    const on = normalizeIk({ targetId: 'obj-2', chain: 3, enabled: false });
    assert.deepEqual(on, { targetId: 'obj-2', chain: 3, iterations: IK_DEFAULTS.iterations, enabled: false, bend: 'auto' });
});
