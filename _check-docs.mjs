/**
 * 文档闸：让「手填的基线数字」不能再悄悄漂。
 *
 * 为什么需要它：这个仓库的账本/README 每批都要手填一组数字（版本号、批次数、模块数、
 * 测试文件数、语法检查数）。**填错不会红**，只会让下一个人读到过期基线 —— 这类欠账
 * 在这个项目里已经发生过多次（`待修与优化清单` 曾长期写着 741 tests）。
 *
 * 这里只用**静态可数**的东西，不跑测试（跑测试要几秒，会把 `npm run check` 拖慢）：
 *   1. `package.json` 的 version == `CHANGELOG.md` 第一条 `## v…` 的版本
 *   2. `docs/README.md` 的「N 个批次」 == 主账本里 `## 1xx.` 的节数
 *   3. 两版 README 的「模块数」 == `app/` 下真实 `.mjs` 文件数（与 `_check-static` 同口径：跳过 `_` 开头）
 *   4. 两版 README 的「测试文件数」 == `tests/*.test.mjs` 个数
 *   5. 两版 README 的「语法检查 N/N」 == `app/` 模块数 + 根工具脚本数（与 `_check-syntax` 同口径）
 *
 * 用法：`node _check-docs.mjs`。有问题 exit 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** 与 `_check-syntax.mjs` 的 ROOT_TOOLS 保持同一份清单（那边改了这里也要改）。 */
export const ROOT_TOOLS = ['tools-serve.mjs', 'tools-smoke.cjs', 'tools-split.mjs', 'tools-shell-channels.tpl.mjs', '_check-layers.mjs', '_check-docs.mjs'];

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** `app/` 下真正会被静态闸扫描的模块（跳过 `_` 开头的临时脚本）。 */
export function countAppModules(root = ROOT) {
    let n = 0;
    const walk = (abs) => {
        for (const name of fs.readdirSync(abs)) {
            const p = path.join(abs, name);
            const st = fs.statSync(p);
            if (st.isDirectory()) { walk(p); continue; }
            if (!name.endsWith('.mjs')) continue;
            if (name.startsWith('_')) continue;
            n += 1;
        }
    };
    walk(path.join(root, 'app'));
    return n;
}

/** `tests/` 下被 `npm test` 跑到的文件数。 */
export function countTestFiles(root = ROOT) {
    return fs.readdirSync(path.join(root, 'tests')).filter((n) => n.endsWith('.test.mjs')).length;
}

/** 主账本里的批次节数（`## 1a.` / `## 1ba.` 这类）。 */
export function countLedgerBatches(text) {
    return (text.match(/^## 1[a-z]{1,2}\. /gm) || []).length;
}

/** CHANGELOG 第一条 `## v…` 的版本号。 */
export function firstChangelogVersion(text) {
    const m = text.match(/^## v([0-9][^\s—]*)/m);
    return m ? m[1] : '';
}

/** 两版 README 里「模块数 / 测试文件数 / 语法检查数」的读数字段（找不到返回 null）。 */
export function readBaselines(en, zh) {
    const enModules = en.match(/scans (\d+) modules/);
    const zhModules = zh.match(/扫描 (\d+) 个模块/);
    const enTests = en.match(/across (\d+) test files/);
    const zhTests = zh.match(/（(\d+) 个测试文件）/);
    const enSyntax = en.match(/syntax check (\d+)\/(\d+)/);
    const zhSyntax = zh.match(/语法检查 (\d+)\/(\d+)/);
    const zhBatches = zh.match(/(\d+) 个批次/);
    return {
        enModules: enModules ? Number(enModules[1]) : null,
        zhModules: zhModules ? Number(zhModules[1]) : null,
        enTests: enTests ? Number(enTests[1]) : null,
        zhTests: zhTests ? Number(zhTests[1]) : null,
        enSyntax: enSyntax ? [Number(enSyntax[1]), Number(enSyntax[2])] : null,
        zhSyntax: zhSyntax ? Number(zhSyntax[1]) : null,
        zhBatches: zhBatches ? Number(zhBatches[1]) : null,
    };
}

/** 纯比较：返回问题列表（空数组 = 全对齐）。 */
export function docProblems(input) {
    const out = [];
    const { version, changelogVersion, ledgerBatches, docIndexBatches, modules, testFiles, syntaxTotal, readme } = input;
    if (changelogVersion !== version) {
        out.push(`CHANGELOG 首条版本是 ${changelogVersion || '(无)'}，package.json 是 ${version}`);
    }
    if (docIndexBatches != null && docIndexBatches !== ledgerBatches) {
        out.push(`docs/README 写「${docIndexBatches} 个批次」，主账本实际 ${ledgerBatches} 节`);
    }
    for (const [label, value] of [['README.md', readme.enModules], ['README.zh-Hans.md', readme.zhModules]]) {
        if (value != null && value !== modules) out.push(`${label} 写 ${value} 个模块，实际 ${modules}`);
    }
    for (const [label, value] of [['README.md', readme.enTests], ['README.zh-Hans.md', readme.zhTests]]) {
        if (value != null && value !== testFiles) out.push(`${label} 写 ${value} 个测试文件，实际 ${testFiles}`);
    }
    for (const [label, value] of [['README.md', readme.enSyntax], ['README.zh-Hans.md', readme.zhSyntax == null ? null : [readme.zhSyntax, readme.zhSyntax]]]) {
        if (!value) continue;
        if (value[0] !== syntaxTotal || value[1] !== syntaxTotal) {
            out.push(`${label} 写语法检查 ${value[0]}/${value[1]}，实际 ${syntaxTotal}/${syntaxTotal}`);
        }
    }
    return out;
}

function main() {
    const pkg = JSON.parse(read('package.json'));
    const changelog = read('CHANGELOG.md');
    const ledger = read('docs/修复列表-v8.md');
    const docIndex = read('docs/README.md');
    const en = read('README.md');
    const zh = read('README.zh-Hans.md');
    const modules = countAppModules();
    const testFiles = countTestFiles();
    const ledgerBatches = countLedgerBatches(ledger);
    const idx = docIndex.match(/(\d+) 个批次的逐条记录/);
    const problems = docProblems({
        version: pkg.version,
        changelogVersion: firstChangelogVersion(changelog),
        ledgerBatches,
        docIndexBatches: idx ? Number(idx[1]) : null,
        modules,
        testFiles,
        syntaxTotal: modules + ROOT_TOOLS.length,
        readme: readBaselines(en, zh),
    });
    console.log('== 文档基线 ==');
    console.log(`版本 ${pkg.version} · 模块 ${modules} · 测试文件 ${testFiles} · 主账本 ${ledgerBatches} 节 · 语法 ${modules + ROOT_TOOLS.length}`);
    for (const p of problems) console.log('  ✗', p);
    if (!problems.length) console.log('  六处手填数字与代码一致');
    else process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    main();
}
