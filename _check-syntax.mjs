#!/usr/bin/env node
/**
 * 语法检查：对 app/ 下每个 .mjs 跑 `node --check`。
 *
 * 为什么需要它：`_check-static.mjs` 只验 import 路径与概念残留，**不做语法解析**；
 * 而 `node --test` 只 import 了纯逻辑模块，DOM 那几个（app.mjs / layers.mjs / board.mjs…）
 * 从没被 node 加载过。于是"测试全绿 + 静态检查干净 + 页面白屏"发生过两次：
 *   1) project-io.mjs 里同一个函数被 `export function` 和 `export { }` 各导出一次；
 *   2) ctx-time.mjs 的 import 列表里同一个标识符写了两遍；
 *   3) layers.mjs 写到一半（文件被截断）时浏览器报 "Unexpected end of input"。
 * 这三种 node --check 都能在几百毫秒内抓到，而浏览器只会给你一片白屏。
 *
 * 用法：node _check-syntax.mjs
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TARGETS = ['app'];

function walk(dir, out) {
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (name.endsWith('.mjs')) out.push(full);
    }
    return out;
}

const files = TARGETS.flatMap((t) => walk(join(ROOT, t), []));
const failures = [];

for (const file of files) {
    try {
        execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
        const msg = String(err.stderr || err.message || '')
            .split('\n')
            .filter((l) => l.trim() && !l.startsWith('    at '))
            .slice(0, 3)
            .join(' | ');
        failures.push({ file: relative(ROOT, file), msg });
    }
}

if (failures.length === 0) {
    console.log(`== 语法检查 ==\n  ${files.length} 个模块全部通过 node --check\n`);
    process.exit(0);
}

console.log(`== 语法检查失败（${failures.length} / ${files.length}）==`);
for (const f of failures) console.log(`  ${f.file}\n    ${f.msg}`);
process.exit(1);
