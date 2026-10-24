// 静态一致性检查：v6 时间模型重构后不能残留帧概念，且 import 的符号必须真的被 export。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = 'E:/dev/motionstudio';
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

// 1) 帧概念残留
const deadPatterns = [
    /\bdoc\.frames\b/,
    /\bframeIndex\b/,
    /\bframeStart\s*\(/,
    /\bframeSeconds\s*\(/,
    /\bresolveCelImage\b/,
    /\bmaterializeCel\b/,
    /\bsetCelHold\b/,
    /\bisHolding\b/,
    /\bsampleFrame\b/,
    /\bsyncCels\b/,
    /\bstateAtFrame\b/,
];
const leftovers = [];
for (const f of files) {
    const src = readFileSync(f, 'utf8');
    src.split('\n').forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith('//') || t.startsWith('*')) return;
        for (const re of deadPatterns) {
            if (re.test(line)) leftovers.push(`${rel(f)}:${i + 1}  ${t.slice(0, 110)}`);
        }
    });
}

// 2) 收集每个文件的 export 名
const exportsOf = new Map();
for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const names = new Set();
    for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
    for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) {
        for (const part of m[1].split(',')) {
            const n = part.trim().split(/\s+as\s+/).pop().trim();
            if (n) names.add(n);
        }
    }
    exportsOf.set(f, names);
}

// 3) 检查 import a from './b.mjs' 的 a 是否在 b 里 export
const badImports = [];
for (const f of files) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
        const target = join(f, '..', m[2]);
        let key = null;
        for (const k of exportsOf.keys()) if (k.replace(/\\/g, '/') === target.replace(/\\/g, '/')) key = k;
        if (!key) continue;
        const have = exportsOf.get(key);
        for (const part of m[1].split(',')) {
            const n = part.trim().split(/\s+as\s+/)[0].trim();
            if (!n) continue;
            if (!have.has(n)) badImports.push(`${rel(f)}  ←  ${n}  不存在于 ${rel(key)}`);
        }
    }
}

console.log('== 帧概念残留 ==');
console.log(leftovers.length === 0 ? '  （无）' : leftovers.map((l) => '  ' + l).join('\n'));
console.log('\n== 失效 import ==');
console.log(badImports.length === 0 ? '  （无）' : badImports.map((l) => '  ' + l).join('\n'));
console.log(`\n扫描 ${files.length} 个模块；残留 ${leftovers.length} 处，坏 import ${badImports.length} 处`);
