/**
 * 分层闸：`app/` 内部的依赖方向。
 *
 * 为什么需要它：这个仓库的分层写在契约里（core / paint / editors / shell / i18n），
 * 但**没有任何机器检查**。分层腐化不会红、不会崩，只会让「core 是纯逻辑、能被单测」
 * 这条前提一天天失效 —— 等到有人发现 `core/` 里 `import` 了 DOM，已经晚了。
 *
 * 规则（当前实测：违规 0 处）：
 *   core    → core
 *   paint   → core, paint
 *   i18n    → i18n
 *   editors → core, paint, editors, i18n（另有两条白名单，见 ALLOWED）
 *   shell   → 任意（装配层，天然要认识所有东西）
 *
 * 白名单也是被检查的：如果某条白名单已经用不上（对应 import 不存在了），
 * 脚本会报「多余的白名单」并 exit 1 —— 否则白名单只会越攒越多，最后没人知道它还挡着什么。
 *
 * 用法：`node _check-layers.mjs`。有问题 exit 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * 允许的「导入方 → 被导入层」集合。值里装的是例外文件（精确到文件相对仓库根的路径）。
 *
 * `i18n` 是叶子层（它只 import 自己的词条表），所以 core / paint 允许依赖它 ——
 * 本地化 P2/P3 之后，`timegraph.describeTime`、`psd` 的错误串、`brush` 的笔名都在词条表里。
 * 硬要 core 不碰 i18n，只能把文案重新写死回 core 里，那是倒退。
 *
 * 反过来 `core` 依赖 `paint` 不正常，只有一处白名单（见 core.allow）。
 */
export const RULES = Object.freeze({
    core: Object.freeze({
        layers: ['core', 'i18n'],
        allow: [
            // 纯滤镜函数（effectAt / filterString）在 paint 里，反过来 import 会成环；
            // 代价是 core 里有一份 30 行的三角形贴图实现，见 evaluator.mjs 顶部注释。
            ['app/core/evaluator.mjs', 'app/paint/effects.mjs'],
        ],
    }),
    paint: Object.freeze({ layers: ['core', 'paint', 'i18n'], allow: [] }),
    i18n: Object.freeze({ layers: ['i18n'], allow: [] }),
    editors: Object.freeze({
        layers: ['core', 'paint', 'editors', 'i18n'],
        allow: [
            // 项目库面板要直接调存档层的列表接口（不是写路径，只读）
            ['app/editors/projects.mjs', 'app/shell/project-store.mjs'],
            // 偏好面板要读写 doc-state 的偏好（这是外壳的唯一偏好入口）
            ['app/editors/prop-prefs.mjs', 'app/shell/doc-state.mjs'],
        ],
    }),
    shell: Object.freeze({ layers: ['core', 'paint', 'editors', 'shell', 'i18n'], allow: [] }),
});

const rel = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');

/** `app/core/x.mjs` → `core`；拿不到层名返回 null。 */
export function layerOf(relPath) {
    const parts = rel(relPath).split('/');
    if (parts[0] !== 'app' || parts.length < 3) return null;
    return parts[1];
}

/**
 * 纯函数：给一组「已解析」的边，返回违规列表与多余白名单。
 * `edges` 的每一项形如 { from: 'app/core/a.mjs', to: 'app/shell/b.mjs' }。
 */
export function violationsOf(edges) {
    const out = [];
    const usedAllow = new Set();
    for (const edge of edges) {
        const fromLayer = layerOf(edge.from);
        const toLayer = layerOf(edge.to);
        if (!fromLayer || !toLayer) continue;
        const rule = RULES[fromLayer];
        if (!rule) continue;
        const pair = [rel(edge.from), rel(edge.to)];
        const allowed = rule.allow.some(([f, t]) => f === pair[0] && t === pair[1]);
        if (allowed) {
            usedAllow.add(pair[0] + ' → ' + pair[1]);
            continue;
        }
        if (rule.layers.includes(toLayer)) continue;
        out.push({
            from: pair[0],
            to: pair[1],
            reason: `${fromLayer} 只允许 import ${rule.layers.join(' / ')}，不能 import ${toLayer}`,
        });
    }
    const stale = [];
    for (const layer of Object.keys(RULES)) {
        for (const [f, t] of RULES[layer].allow) {
            const key = f + ' → ' + t;
            if (!usedAllow.has(key)) stale.push({ from: f, to: t, reason: '白名单已用不上（那条 import 不在了），删掉它' });
        }
    }
    return { violations: out, stale };
}

/** 收集 app 下所有 .mjs 的 import 边（只收相对路径，裸说明符一律不管）。 */
export function collectEdges(root = ROOT, dir = 'app') {
    const edges = [];
    const walk = (abs) => {
        for (const name of fs.readdirSync(abs)) {
            const p = path.join(abs, name);
            const st = fs.statSync(p);
            if (st.isDirectory()) { walk(p); continue; }
            if (!name.endsWith('.mjs')) continue;
            if (name.startsWith('_')) continue;
            const src = fs.readFileSync(p, 'utf8');
            const re = /^import[\s\S]*?from\s+'(\.[^']+)'/gm;
            let m = re.exec(src);
            while (m) {
                const target = path.resolve(path.dirname(p), m[1]);
                edges.push({ from: rel(path.relative(root, p)), to: rel(path.relative(root, target)) });
                m = re.exec(src);
            }
        }
    };
    walk(path.join(root, dir));
    return edges;
}

function main() {
    const edges = collectEdges();
    const { violations, stale } = violationsOf(edges);
    const modules = new Set(edges.map((e) => e.from)).size;
    console.log('== 跨层 import ==');
    console.log(`扫描 ${modules} 个模块（${edges.length} 条内部 import）`);
    for (const v of violations) console.log(`  ${v.from}  →  ${v.to}   ${v.reason}`);
    for (const s of stale) console.log(`  [白名单] ${s.from} → ${s.to}   ${s.reason}`);
    if (!violations.length && !stale.length) console.log('  无跨层违规');
    if (violations.length || stale.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    main();
}
