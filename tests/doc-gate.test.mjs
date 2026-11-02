// 文档闸（`_check-docs.mjs`）的护栏 + 纯函数单测。
//
// 为什么值得测：它守的是「手填的基线数字」。这些数字**填错不会红**，只会让下一个人
// 读到过期基线（这个项目里已经发生过多次）。所以这里既测比较逻辑（合成输入），
// 也真跑一次确认当前仓库是自洽的。

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import {
    ROOT_TOOLS,
    countAppModules,
    countLedgerBatches,
    countTestFiles,
    docProblems,
    firstChangelogVersion,
    readBaselines,
} from '../_check-docs.mjs';

const BASE = {
    version: '0.5.0-alpha.39',
    changelogVersion: '0.5.0-alpha.39',
    ledgerBatches: 53,
    docIndexBatches: 53,
    modules: 106,
    testFiles: 118,
    syntaxTotal: 111,
    readme: {
        enModules: 106, zhModules: 106,
        enTests: 118, zhTests: 118,
        enSyntax: [111, 111], zhSyntax: 111,
        zhBatches: 53,
    },
};

test('全对齐时没有问题', () => {
    assert.deepEqual(docProblems(BASE), []);
});

test('版本不一致会被抓到（CHANGELOG 首条 vs package.json）', () => {
    const bad = { ...BASE, changelogVersion: '0.5.0-alpha.38' };
    const p = docProblems(bad);
    assert.equal(p.length, 1);
    assert.match(p[0], /CHANGELOG/);
});

test('模块数 / 测试文件数 / 语法数任何一处漂了都会被抓到', () => {
    for (const key of ['enModules', 'zhModules', 'enTests', 'zhTests']) {
        const readme = { ...BASE.readme, [key]: 999 };
        const p = docProblems({ ...BASE, readme });
        assert.equal(p.length, 1, key + ' 漂了应当被抓到');
    }
    const syntaxBad = docProblems({ ...BASE, readme: { ...BASE.readme, enSyntax: [110, 110] } });
    assert.equal(syntaxBad.length, 1);
    assert.match(syntaxBad[0], /语法检查/);
});

test('账本批次与 docs/README 不一致会被抓到', () => {
    const p = docProblems({ ...BASE, docIndexBatches: 52 });
    assert.equal(p.length, 1);
    assert.match(p[0], /批次/);
});

test('CHANGELOG 版本抽取只认第一条 `## v…`', () => {
    const text = '## v0.5.0-alpha.39 — 2026-11-02 · x\n\n## v0.5.0-alpha.38 — 旧\n';
    assert.equal(firstChangelogVersion(text), '0.5.0-alpha.39');
    assert.equal(firstChangelogVersion('没有标题'), '');
});

test('两版 README 的读数字段能被抽出来（正则和文案一起改时才不会静默失效）', () => {
    const en = 'Current baseline: **1 tests / 1 pass** across 7 test files; static check scans 9 modules with 0 leftovers; syntax check 11/11 (9 app/ modules + 2 root tool scripts);';
    const zh = '当前基线：**1 tests**（7 个测试文件）；静态检查扫描 9 个模块；语法检查 11/11（9 个 app/ 模块 + 2 个根工具脚本）；主账本 53 个批次的逐条记录';
    const b = readBaselines(en, zh);
    assert.equal(b.enModules, 9);
    assert.equal(b.zhModules, 9);
    assert.equal(b.enTests, 7);
    assert.equal(b.zhTests, 7);
    assert.deepEqual(b.enSyntax, [11, 11]);
    assert.equal(b.zhSyntax, 11);
    assert.equal(b.zhBatches, 53);
});

test('账本批次计数只数 `## 1xx.` 节（不数 P0/P1 状态表里的小节）', () => {
    const text = '## 1a. x\n## 1b. y\n## 1ba. z\n## 2. P1 状态表\n## 1ac. w\n';
    assert.equal(countLedgerBatches(text), 4);
});

test('真实仓库：模块数 / 测试文件数与文件系统一致，且文档闸 exit 0', () => {
    const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    assert.ok(countAppModules(root) > 90, 'app 模块数太少：' + countAppModules(root));
    assert.ok(countTestFiles(root) > 100, '测试文件数太少：' + countTestFiles(root));
    const run = spawnSync(process.execPath, ['_check-docs.mjs'], {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
    });
    assert.equal(run.status, 0, '文档闸应当 exit 0：\n' + run.stdout + run.stderr);
    assert.ok(run.stdout.includes('六处手填数字与代码一致'), '缺结论行：' + run.stdout);
});

test('ROOT_TOOLS 清单与语法门保持同一份（别只在一处加脚本）', () => {
    assert.ok(ROOT_TOOLS.includes('tools-serve.mjs'));
    assert.ok(ROOT_TOOLS.includes('tools-smoke.cjs'));
    assert.ok(ROOT_TOOLS.length >= 5, '根工具至少 5 个，实际 ' + ROOT_TOOLS.length);
});
