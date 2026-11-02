/**
 * 静态检查脚本本身的护栏。
 *
 * 为什么需要它：`_check-static.mjs` 是四道门里的第一道，但它自己也是代码——
 * v12 之前它只做「帧概念残留」与「import 的符号是否真的被 export」两件事，
 * `_check-static` 查不出「import 了却没用」这个缝，于是死 import 一路攒到 **43 个**
 * （11 个文件，全是「删了功能但没删 import」）。补上第三段之后，要有东西钉住
 * 「这段检查还在、还会真的跑、还会在有问题时 exit 1」，否则下一个人重构这个脚本
 * 时把它删掉，没有人会发现。
 *
 * 这里既查源码结构（第三段还在、标签还在、有 exitCode），也真跑一次脚本
 * （断言三段标题都打印、当前工作树是干净的所以 exit 0）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const ROOT = new URL('../', import.meta.url);
const SCRIPT = readFileSync(new URL('_check-static.mjs', ROOT), 'utf8');

test('静态检查脚本包含三段：帧残留 / 失效 import / 未使用 import', () => {
    for (const label of ['== 帧概念残留 ==', '== 失效 import ==', '== 未使用 import ==']) {
        assert.ok(SCRIPT.includes(label), '缺输出段：' + label);
    }
    assert.ok(SCRIPT.includes('unusedImports'), '缺未使用 import 的收集变量');
});

test('未使用 import 的判定会剥掉 import 语句再找标识符（否则永远「用到」）', () => {
    // 关键实现细节：body 必须是「删掉 import 语句之后」的源码。
    // 如果不剥，被 import 的名字在 import 行里就出现了一次，检查永远为绿。
    assert.match(SCRIPT, /const body = src\.replace\(\/import/, 'body 没有剥掉 import 语句');
    assert.ok(SCRIPT.includes('(^|[^\\\\w$.])'), '缺标识符边界正则（会误把 xxxT 当成 t）');
});

test('有问题时脚本必须以非零码退出（否则 CI 与 npm run check 看不见）', () => {
    assert.ok(
        SCRIPT.includes('process.exitCode = 1'),
        '缺少 exitCode：三段检查全打印了却永远 exit 0，闸门等于没有',
    );
    assert.match(SCRIPT, /if \(leftovers\.length \|\| badImports\.length \|\| unusedImports\.length\)/, 'exitCode 的触发条件没覆盖三段');
});

test('真跑一次：三段都打印，当前工作树干净时 exit 0', () => {
    const r = spawnSync(process.execPath, ['_check-static.mjs'], {
        cwd: new URL('../', import.meta.url),
        encoding: 'utf8',
    });
    assert.equal(r.error, undefined, '脚本没跑起来：' + (r.error && r.error.message));
    assert.ok(r.stdout.includes('== 帧概念残留 =='), '缺帧残留段');
    assert.ok(r.stdout.includes('== 失效 import =='), '缺失效 import 段');
    assert.ok(r.stdout.includes('== 未使用 import =='), '缺未使用 import 段');
    assert.equal(r.status, 0, '当前工作树应当是干净的，exit=' + r.status + '\n' + r.stdout);
    // 末行汇总必须三类都报数，否则「0 处」是哪一类看不出来
    assert.match(r.stdout.trim().split('\n').pop(), /残留 \d+ 处，坏 import \d+ 处，未使用 import \d+ 处/);
});

/**
 * `_check-syntax.mjs` 的护栏。
 *
 * 它原来只 `node --check` 扫 `app/`，而 `tools-serve.mjs`（`npm run serve` 跑的那个）
 * 与 `tools-smoke.cjs`（`npm run smoke` 跑的那个）都在仓库根，既不在 `_check-static.mjs`
 * 的扫描范围，也不在 `_check-syntax.mjs` 的——**写坏了只有真去跑的时候才知道**。
 */
const SYNTAX = readFileSync(new URL('_check-syntax.mjs', ROOT), 'utf8');

test('语法检查覆盖仓库根的工具脚本（它们不在 app/ 里，别的门都扫不到）', () => {
    for (const name of ['tools-serve.mjs', 'tools-smoke.cjs']) {
        assert.ok(SYNTAX.includes("'" + name + "'"), '语法检查没覆盖 ' + name);
    }
});

test('语法检查真跑一次：把工具脚本也算进总数', () => {
    const r = spawnSync(process.execPath, ['_check-syntax.mjs'], {
        cwd: new URL('../', import.meta.url),
        encoding: 'utf8',
    });
    assert.equal(r.error, undefined, '脚本没跑起来：' + (r.error && r.error.message));
    assert.equal(r.status, 0, '语法检查应当通过，exit=' + r.status + '\n' + r.stdout);
    const m = r.stdout.match(/(\d+) 个模块全部通过 node --check/);
    assert.ok(m, '缺汇总行：' + r.stdout);
    // 至少比 app/ 的模块数多 2（两个根工具脚本）
    const appCount = Number(m[1]) - 2;
    assert.ok(appCount >= 100, '模块总数不合理：' + m[1]);
});

/**
 * `_check-i18n.mjs` 的护栏。
 *
 * 这一条是被真事故逼出来的：alpha.25 删掉 `registry.mjs` 里 `EDITORS` 的中文字段后，
 * 检查器里那条「注册表覆盖」的抽 id 正则还要求 `title:` 同现，于是它**静默空转**：
 * 一个编辑器都没抽到，打印 0/0，退出码 0，看上去一切正常。检查器本身失明时
 * 不会有任何东西变红 —— 除非有人盯着它的输出。
 */
const I18N = readFileSync(new URL('_check-i18n.mjs', ROOT), 'utf8');

test('i18n 检查的注册表抽 id 不依赖 title 字段（否则字段一删就静默空转）', () => {
    // 只断「怎么抽的」，不断言正则字面量：抽 id 的锚点必须是 mount（EDITORS 现在的形状是
    // { id, mount }），一旦有人把锚点改回 title，真跑那条会立刻报 0/0。
    assert.ok(I18N.includes("id:\\s*'"), '抽 id 的正则不见了');
    assert.ok(I18N.includes('mount:/g'), '抽 id 应当以 mount 为锚点，而不是 title');
});

test('i18n 检查真跑一次：编辑器覆盖必须是 15/15 而不是 0/0', () => {
    const r = spawnSync(process.execPath, ['_check-i18n.mjs', '--strict'], {
        cwd: new URL('../', import.meta.url),
        encoding: 'utf8',
    });
    assert.equal(r.error, undefined, '脚本没跑起来：' + (r.error && r.error.message));
    assert.equal(r.status, 0, 'i18n 检查应当通过，exit=' + r.status + '\n' + r.stdout);
    const m = r.stdout.match(/(\d+)\/(\d+) 个编辑器都有 title \+ hint/);
    assert.ok(m, '缺编辑器覆盖行：' + r.stdout);
    assert.ok(Number(m[2]) >= 15, '编辑器总数应当 >= 15，实际 ' + m[2]);
    assert.equal(m[1], m[2], '有编辑器没覆盖到 title/hint：' + m[0]);
});
