// 分层闸（`_check-layers.mjs`）的护栏 + 纯函数单测。
//
// 为什么要测一个「检查脚本」：它自己也是代码。分层的价值全在「有人越界时它真的会红」，
// 所以这里既测判定逻辑（用合成边，不依赖真实文件），也真跑一次脚本确认当前工作树是干净的。
//
// 三条硬规则：
//   1. core / paint / i18n / editors 的允许层写在 RULES 里，白名单必须精确到文件
//   2. 白名单用不上时要报「多余的白名单」（否则只会越攒越多）
//   3. 真跑一次必须 exit 0 —— 它一旦红，`npm run check` 就是红的

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
    RULES,
    collectEdges,
    layerOf,
    violationsOf,
} from '../_check-layers.mjs';

const edge = (from, to) => ({ from, to });

test('层名解析：app/<layer>/x.mjs → layer；其它形状返回 null', () => {
    assert.equal(layerOf('app/core/doc-model.mjs'), 'core');
    assert.equal(layerOf('app\\paint\\brush.mjs'), 'paint');
    assert.equal(layerOf('app/i18n/parts/help.mjs'), 'i18n');
    assert.equal(layerOf('tools-split.mjs'), null);
    assert.equal(layerOf('app/index.html'), null);
});

test('越界会被判违规：core→shell / core→editors / paint→editors / i18n→core / editors→shell', () => {
    const cases = [
        ['app/core/lattice.mjs', 'app/shell/doc-state.mjs'],
        ['app/core/lattice.mjs', 'app/editors/canvas.mjs'],
        ['app/paint/brush.mjs', 'app/editors/canvas.mjs'],
        ['app/i18n/index.mjs', 'app/core/prefs.mjs'],
        ['app/editors/layers.mjs', 'app/shell/project-io.mjs'],
    ];
    for (const [from, to] of cases) {
        const r = violationsOf([edge(from, to)]);
        assert.equal(r.violations.length, 1, from + ' → ' + to + ' 应当被判违规');
        assert.ok(r.violations[0].reason.length > 0, '违规要带原因');
    }
});

test('合法的层内与向下依赖不判违规', () => {
    const ok = [
        ['app/core/evaluator.mjs', 'app/core/element.mjs'],   // core → core
        ['app/paint/engine.mjs', 'app/core/doc-model.mjs'],   // paint → core
        ['app/editors/canvas.mjs', 'app/core/element.mjs'],   // editors → core
        ['app/shell/app.mjs', 'app/editors/canvas.mjs'],      // shell → editors（装配层）
        ['app/core/timegraph.mjs', 'app/i18n/index.mjs'],     // core → i18n（叶子层，允许）
        ['app/paint/brush.mjs', 'app/i18n/index.mjs'],        // paint → i18n
    ];
    const r = violationsOf(ok.map(([f, t]) => edge(f, t)));
    assert.deepEqual(r.violations, [], '这些都不该违规：' + JSON.stringify(r.violations));
});

test('白名单只对「精确的文件对」生效，不对整个层放行', () => {
    // 白名单里有 evaluator → effects，但换一个 core 文件就不行
    const allowed = violationsOf([edge('app/core/evaluator.mjs', 'app/paint/effects.mjs')]);
    assert.deepEqual(allowed.violations, [], 'evaluator → effects 是白名单里的');
    const notAllowed = violationsOf([edge('app/core/lattice.mjs', 'app/paint/effects.mjs')]);
    assert.equal(notAllowed.violations.length, 1, '别的 core 文件 import paint 仍要红');
});

test('多余的白名单会被告警（否则白名单只会越攒越多）', () => {
    const r = violationsOf([]);
    assert.ok(r.stale.length >= 3, '三条白名单在空边集下都该被报成多余，实际 ' + r.stale.length);
    const keys = r.stale.map((s) => s.from + ' → ' + s.to);
    assert.ok(keys.includes('app/core/evaluator.mjs → app/paint/effects.mjs'));
});

test('规则表本身是冻结的，且 core 的白名单只有一条（新增要改这里）', () => {
    assert.ok(Object.isFrozen(RULES));
    assert.ok(Object.isFrozen(RULES.core));
    assert.equal(RULES.core.allow.length, 1, 'core 依赖 paint 只允许 evaluator → effects 一处');
    assert.equal(RULES.editors.allow.length, 2, 'editors 依赖 shell 只允许两条');
    assert.ok(RULES.core.layers.includes('i18n'), 'core 允许依赖 i18n（叶子层）');
});

test('真跑一次：当前工作树没有跨层违规，脚本 exit 0', () => {
    const run = spawnSync(process.execPath, ['_check-layers.mjs'], {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
    });
    assert.equal(run.status, 0, '分层闸应当 exit 0，实际 ' + run.status + '\n' + run.stdout + run.stderr);
    assert.ok(/扫描 \d+ 个模块/.test(run.stdout), '缺扫描行：' + run.stdout);
    assert.ok(run.stdout.includes('无跨层违规'), '缺结论行：' + run.stdout);
});

test('真实扫出来的边里，core 与 paint 都不 import shell / editors', () => {
    const edges = collectEdges(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    const bad = edges.filter((e) => {
        const f = layerOf(e.from);
        const t = layerOf(e.to);
        return (f === 'core' || f === 'paint') && (t === 'shell' || t === 'editors');
    });
    assert.deepEqual(bad, [], 'core/paint 出现了指向上层的 import：' + JSON.stringify(bad));
    assert.ok(edges.length > 200, '内部 import 边太少（' + edges.length + '），收集逻辑可能坏了');
});
