// 本地化进度尺 + 词典一致性检查。
//
// 两件事：
//   1) **报数**：`app/**/*.mjs` 里还有多少条「非注释的中文字面量」。这是 P0→P3 的进度尺，
//      每迁一批面板，这个数就该掉一批；不设阈值，永远 exit 0。
//   2) **查一致性**（`--strict` 时失败即 exit 1）：两份词典键集合必须镜面；
//      `core/prefs.mjs` 的语言白名单必须与 `app/i18n/index.mjs` 的一致；
//      注册表里每个编辑器的 id 都要有 `editor.<id>.title` 与 `.hint`。
//
// 为什么统计要排除注释：全仓中文行 7001 行里 5495 行是注释，把注释算进进度会得出
// 一个永远也降不下来的数字，等于没有尺子。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOCALES, keysOf } from './app/i18n/index.mjs';

const ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '');
const STRICT = process.argv.includes('--strict');
const files = [];

function walk(dir) {
    for (const name of readdirSync(dir)) {
        if (name.startsWith('_')) continue; // 临时脚本 / 快照不进检查
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p);
        else if (name.endsWith('.mjs')) files.push(p);
    }
}
walk(join(ROOT, 'app'));

const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');

/** 汉字与中文标点。全角逗号、引号、间隔号也算 —— 它们同样需要按语言切换。 */
const HAN = /[\u4e00-\u9fff]/;
const CJK_PUNCT = /[\u3000-\u303f\uff01-\uff60]/;

/** 三种字符串字面量。转义与换行都按 JS 的真实规则放过。 */
const STR = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;

/**
 * 去掉行内注释。只处理行首注释与「不在字符串里的 //」—— 这不是完整的词法器，
 * 但对本仓库的源码足够：中文文案几乎都在引号里，`//` 后面才是注释。
 */
function stripComment(line) {
    let quote = null;
    for (let i = 0; i < line.length; i += 1) {
        const c = line[i];
        if (quote) {
            if (c === '\\') i += 1;
            else if (c === quote) quote = null;
            continue;
        }
        if (c === '"' || c === "'" || c === '`') quote = c;
        else if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
    }
    return line;
}

const perFile = new Map();
let totalLines = 0;
let totalStrings = 0;
for (const f of files) {
    const r = rel(f);
    if (r.startsWith('app/i18n/')) continue; // 词典本身：那里的中文是译文，不是待迁文案
    const src = readFileSync(f, 'utf8');
    let lines = 0;
    let strings = 0;
    src.split('\n').forEach((raw) => {
        const trimmed = raw.trim();
        // 整行注释直接跳过：块注释的续行以 `*` 或 `/*` 开头，全仓中文行里大头是这些
        if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) return;
        const line = stripComment(raw);
        if (!HAN.test(line)) return;
        lines += 1;
        for (const m of line.matchAll(STR)) {
            const s = m[0].slice(1, -1);
            if (HAN.test(s) || CJK_PUNCT.test(s)) strings += 1;
        }
    });
    if (lines > 0) perFile.set(r, { lines, strings });
    totalLines += lines;
    totalStrings += strings;
}

const ranked = [...perFile.entries()].sort((a, b) => b[1].strings - a[1].strings);

console.log('== 本地化进度：仍未走词条表的中文（按条数） ==');
const TOP = 15;
for (const [file, n] of ranked.slice(0, TOP)) {
    console.log(`  ${String(n.strings).padStart(4)} 条 / ${String(n.lines).padStart(4)} 行  ${file}`);
}
if (ranked.length > TOP) console.log(`  …… 另有 ${ranked.length - TOP} 个文件`);

// ── 词典镜面 ────────────────────────────────────────────────
const dictSize = LOCALES.map((id) => [id, keysOf(id).length]);
const missing = [];
for (const id of LOCALES) {
    for (const other of LOCALES) {
        if (other === id) continue;
        const have = new Set(keysOf(id));
        for (const k of keysOf(other)) if (!have.has(k)) missing.push(`${other} 有、${id} 缺：${k}`);
    }
}

// ── 语言白名单对齐（prefs.mjs 刻意再写一份，这里防漂移） ──────────
const prefsSrc = readFileSync(join(ROOT, 'app/core/prefs.mjs'), 'utf8');
const prefsList = (prefsSrc.match(/const LOCALES = Object\.freeze\(\[([^\]]*)\]\)/) || [, ''])[1]
    .split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
const localeMismatch = prefsList.length === LOCALES.length && prefsList.every((v, i) => v === LOCALES[i])
    ? []
    : [`core/prefs.mjs = [${prefsList.join(', ')}]  ≠  app/i18n/index.mjs = [${LOCALES.join(', ')}]`];

// ── 注册表覆盖 ──────────────────────────────────────────────
//
// alpha.25 起 `EDITORS` 只剩 `{ id, mount }`（中文原文已删，见 registry.mjs 的注释），
// 所以这里按 `id:` 抽，不再依赖 `title:` 字段——先前那版正则要求 `title:` 同现，
// 字段一删就静默空转成 0/0，检查形同不存在。
const regSrc = readFileSync(join(ROOT, 'app/shell/registry.mjs'), 'utf8');
const editorIds = [...regSrc.matchAll(/\{\s*id:\s*'([a-z][a-z-]*)',\s*mount:/g)].map((m) => m[1]);
const uncovered = [];
for (const id of editorIds) {
    for (const field of ['title', 'hint']) {
        const key = `editor.${id}.${field}`;
        for (const loc of LOCALES) {
            if (!keysOf(loc).includes(key)) uncovered.push(`${loc} 缺 ${key}`);
        }
    }
}

// ── t 被局部标识符遮蔽（这一批踩了两次的真雷） ────────────────
//
// `t` 是 i18n 的唯一入口，只有一两个字母长，很容易被局部变量抢占：`const t = e.target`
// 之后 `t('board.x')` 会把 DOM 节点当函数调，直接 TypeError；`const t = normalizeTime(x)`
// 之后则把时间数字当年翻译结果。两种都在运行时才炸，静态检查能提前看见。
//
// 只在**真的 import 了 t 的文件**里查，且只报两种形态：① `const t = <对象来源>`（DOM 节点、
// 查表、数组 find —— 之后把 t 当函数调必 TypeError）；② `function f(t)` 形参。
// `const t = Number(state.time)` 这种时间语义在本项目极常见，不报：那种作用域里若真的调了
// `t()` 也会当场炸（t 是数字不是对象），属「一跑就发现」，不值一条静态告警。
const shadowed = [];
const IMPORTS_T = /import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*'[^']*i18n[^']*'/;
const OBJECTISH = /(?:e\.target|\.target\b|querySelector|closest\(|\.get\(|\.find\(|createElement)/;
const DECL_T = /(?:^|[^.\w$])(?:const|let|var)\s+t\s*=([^;]*)/;
for (const f of files) {
    const r = rel(f);
    if (r.startsWith('app/i18n/')) continue;
    const src = readFileSync(f, 'utf8');
    if (!IMPORTS_T.test(src)) continue;
    src.split('\n').forEach((raw, i) => {
        const line = stripComment(raw);
        const m = line.match(DECL_T);
        if (m && OBJECTISH.test(m[1])) shadowed.push(`${r}:${i + 1}  ${line.trim()}`);
    });
}

console.log('\n== 词典 ==');
console.log('  ' + dictSize.map(([id, n]) => `${id} ${n} 条`).join(' / '));
console.log(missing.length === 0 ? '  键集合镜面：OK' : '  ' + missing.join('\n  '));

console.log('\n== 语言白名单 ==');
console.log(localeMismatch.length === 0
    ? `  core/prefs.mjs 与 app/i18n/index.mjs 一致：[${LOCALES.join(', ')}]`
    : '  ' + localeMismatch.join('\n  '));

console.log('\n== 编辑器覆盖 ==');
console.log(uncovered.length === 0
    ? `  ${editorIds.length}/${editorIds.length} 个编辑器都有 title + hint`
    : '  ' + uncovered.join('\n  '));

console.log('\n== t 被局部标识符遮蔽 ==');
console.log(shadowed.length === 0
    ? '  （无）import 了 t 的文件里没有同名局部声明或形参'
    : '  ' + shadowed.join('\n  '));

const problems = missing.length + localeMismatch.length + uncovered.length;
console.log(`\n扫描 ${files.length} 个模块；中文文案 ${totalStrings} 条（${totalLines} 行，${perFile.size} 个文件），词典缺口 ${problems} 处，t 遮蔽 ${shadowed.length} 处`);

if (STRICT && problems > 0) process.exit(1);
