/**
 * 拆仓工具：把「核仓 / 壳仓」的形态**生成到另一个目录**，不改动当前仓库一个字节。
 *
 * 背景与决策见 `docs/拆仓方案-2026-11-02.md`。这份脚本只做方案里的第 2–4 步的
 * **文件搬运与 package.json 生成**，git 操作（init / tag / submodule add）一律不代劳 ——
 * 那些是有副作用的操作，值得人工看一眼再敲。
 *
 * 用法：
 *   node tools-split.mjs                 # 预演：打印将要做什么，不写任何文件
 *   node tools-split.mjs --apply         # 真的写到 ../motionstudio-split/ 下
 *   node tools-split.mjs --apply --out D:\tmp\split
 *
 * 产出（两个目录）：
 *   <out>/motionstudio/         核仓：app/ tests/ docs/ 三道闸 tools-*.mjs package-lock.json
 *   <out>/motionstudio-desktop/ 壳仓：main.js preload.js tools-pack.mjs test/ package.json
 *
 * **不搬** `dist/`（构建产物，959MB，壳仓重新构建即可）、`node_modules/`（各自 install）、
 *   `lead-work-notes.md`（本机笔记，已在 .gitignore 里）。
 *
 * 为什么核仓不能把壳仓的文件也留着：核仓是「网页端」，它不该有 main.js/preload.js ——
 * 留着会让「核仓不依赖桌面壳」这条不变量变成一句空话。所以核仓只搬核的部分。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** 核仓要搬的东西（相对仓库根）。目录会递归复制，文件直接复制。 */
export const CORE_ENTRIES = [
    'app',
    'tests',
    'docs',
    'README.md',
    'README.zh-Hans.md',
    'CHANGELOG.md',
    'LICENSE',
    'package-lock.json',
    '_check-static.mjs',
    '_check-syntax.mjs',
    '_check-i18n.mjs',
    'tools-serve.mjs',
    'tools-smoke.cjs',
    '.gitignore',
];

/** 壳仓要搬的东西。 */
export const SHELL_ENTRIES = ['main.js', 'preload.js', 'tools-pack.mjs', '.gitignore'];

/**
 * 核仓的 package.json：删掉桌面相关的全部字段，保留测试/静态检查/冒烟。
 *
 * 保留 electron 的理由只有一条：`npm run smoke` 需要一个 Electron 二进制去开一个
 * 无 preload 的窗口，而它是目前唯一能抓到「四道门全绿但面板起不来」的闸门。
 */
export function corePackageJson(pkg) {
    const out = {
        name: pkg.name || 'motionstudio',
        version: pkg.version,
        private: true,
        description: pkg.description,
        license: pkg.license,
        author: pkg.author,
        homepage: pkg.homepage,
        repository: pkg.repository,
        type: pkg.type,
        scripts: {
            test: 'node --test tests/*.test.mjs',
            check: 'node _check-static.mjs && node _check-syntax.mjs && node _check-i18n.mjs',
            'check:static': 'node _check-static.mjs',
            'check:syntax': 'node _check-syntax.mjs',
            'check:i18n': 'node _check-i18n.mjs',
            'check:i18n:strict': 'node _check-i18n.mjs --strict',
            serve: 'node tools-serve.mjs',
            smoke: pkg.scripts && pkg.scripts.smoke
                ? pkg.scripts.smoke
                : 'set ELECTRON_RUN_AS_NODE=&& electron tools-smoke.cjs',
        },
        devDependencies: { electron: (pkg.devDependencies && pkg.devDependencies.electron) || '^40.10.2' },
    };
    // 只保留有定义的字段（避免把 undefined 写成 "undefined"）
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
}

/**
 * 壳仓的 package.json：main.js 的路径、打包 files、安装包配置照抄，
 * 但把所有 `app/**` 改指到 `core/app/**` —— 因为核仓会作为 submodule 挂在 `core/`：
 * 核仓自己的站点根就是它的 `app/`，挂到壳仓的 `app/` 会变成 `app/app/index.html`。
 */
export function shellPackageJson(pkg, version) {
    const build = JSON.parse(JSON.stringify((pkg && pkg.build) || {}));
    build.files = ['main.js', 'preload.js', 'package.json', 'core/app/**/*', '!core/app/promo/img/**', '!**/*.map'];
    // submodule 的 `.git` 是**文件**不是目录，copyDir 会把它当普通文件拷进安装目录
    build.files.push('!core/.git');
    build.extraMetadata = { main: 'main.js' };
    return {
        name: `${pkg && pkg.name ? pkg.name : 'motionstudio'}-desktop`,
        version: version || (pkg && pkg.version) || '0.0.0',
        private: true,
        description: `${pkg && pkg.name ? pkg.name : 'MotionStudio'} desktop shell (Electron)`,
        license: pkg && pkg.license,
        author: pkg && pkg.author,
        main: 'main.js',
        scripts: {
            start: 'electron .',
            // 壳仓没有核仓那三道闸（它们要扫 app/，在壳仓里会直接崩），能做的只有语法检查
            test: 'node --test test/*.test.mjs',
            'check:syntax': 'node --check main.js && node --check preload.js',
            dist: 'electron-builder --win nsis --publish never',
            'dist:dir': 'electron-builder --win dir --publish never',
            postinstall: 'git submodule update --init --recursive',
        },
        devDependencies: (pkg && pkg.devDependencies) || {},
        build,
    };
}

/** main.js 里静态服务指向的那一行需要从 `app` 改成 `core/app`。 */
export function patchMainJs(src) {
    const before = src;
    const after = src.replace(/path\.join\(__dirname,\s*['"]app['"]\)/g, "path.join(__dirname, 'core', 'app')")
        .replace(/join\(__dirname,\s*['"]app['"]\)/g, "join(__dirname, 'core', 'app')");
    return { src: after, changed: after !== before };
}

function copyEntry(from, to) {
    const st = fs.statSync(from);
    if (st.isDirectory()) {
        fs.mkdirSync(to, { recursive: true });
        for (const name of fs.readdirSync(from)) {
            if (name === 'node_modules' || name === '.git') continue;
            copyEntry(path.join(from, name), path.join(to, name));
        }
        return;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
}

/** 生成搬运计划（纯函数，便于单测）：返回 [{ from, to }]，from 为绝对路径。 */
export function splitPlan(root, out) {
    const plan = [];
    const coreDir = path.join(out, 'motionstudio');
    const shellDir = path.join(out, 'motionstudio-desktop');
    for (const entry of CORE_ENTRIES) {
        const from = path.join(root, entry);
        if (!fs.existsSync(from)) continue;
        plan.push({ role: 'core', from, to: path.join(coreDir, entry) });
    }
    for (const entry of SHELL_ENTRIES) {
        const from = path.join(root, entry);
        if (!fs.existsSync(from)) continue;
        plan.push({ role: 'shell', from, to: path.join(shellDir, entry) });
    }
    return plan;
}

/** 需要逐字改写、不能整份复制的文件。 */
export function transformPlan(root, out, pkg) {
    const shellDir = path.join(out, 'motionstudio-desktop');
    const coreDir = path.join(out, 'motionstudio');
    const list = [
        { to: path.join(coreDir, 'package.json'), json: () => corePackageJson(pkg) },
        { to: path.join(shellDir, 'package.json'), json: () => shellPackageJson(pkg, pkg.version) },
    ];
    const mainSrc = path.join(root, 'main.js');
    if (fs.existsSync(mainSrc)) {
        const r = patchMainJs(fs.readFileSync(mainSrc, 'utf8'));
        list.push({ to: path.join(shellDir, 'main.js'), text: r.src, warn: r.changed ? null : '看门狗：main.js 里没找到指向 app/ 的静态服务行，拆完请手工确认' });
    }
    return list;
}

function main(argv) {
    const apply = argv.includes('--apply');
    const outArg = argv.indexOf('--out');
    const out = path.resolve(outArg >= 0 ? argv[outArg + 1] : path.join(ROOT, '..', 'motionstudio-split'));
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

    const plan = splitPlan(ROOT, out);
    const transforms = transformPlan(ROOT, out, pkg);

    console.log('拆仓预演（不改动当前仓库）');
    console.log('  核仓 →', path.join(out, 'motionstudio'));
    console.log('  壳仓 →', path.join(out, 'motionstudio-desktop'));
    console.log('  文件：核 %d 项 / 壳 %d 项 / 另有 %d 份需要改写',
        plan.filter((p) => p.role === 'core').length,
        plan.filter((p) => p.role === 'shell').length,
        transforms.length);
    for (const p of plan) console.log('   ', p.role, path.relative(ROOT, p.from) || '.', '→', path.relative(out, p.to));
    for (const t of transforms) console.log('   改写', path.relative(out, t.to), t.warn ? '（' + t.warn + '）' : '');

    if (!apply) {
        console.log('\n这是预演。确认后加 --apply 才会真的写文件：');
        console.log('  node tools-split.mjs --apply');
        return;
    }
    if (fs.existsSync(out)) {
        console.error('\n目标目录已存在，先自己确认要不要覆盖：' + out);
        process.exitCode = 1;
        return;
    }
    for (const p of plan) copyEntry(p.from, p.to);
    for (const t of transforms) {
        fs.mkdirSync(path.dirname(t.to), { recursive: true });
        if (typeof t.text === 'string') fs.writeFileSync(t.to, t.text);
        else fs.writeFileSync(t.to, JSON.stringify(t.json(), null, 2) + '\n');
        if (t.warn) console.warn('  !', t.warn);
    }
    // 壳仓的跨仓通道测试骨架：只有壳仓能同时看见 preload/main 与核仓的 ipc.mjs
    const testDir = path.join(out, 'motionstudio-desktop', 'test');
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, 'channels.test.mjs'), [
        '// 跨仓契约：preload ↔ main ↔ 核仓 ipc.mjs 三方通道名一致。',
        '// 拆仓前这条断言住在核仓的 tests/ipc-contract.test.mjs 里（合仓形态）。',
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import { readFileSync } from 'node:fs';",
        '',
        "const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');",
        '',
        "test('preload 暴露的方法与 main 注册的通道一一对应', () => {",
        "    const pre = read('../preload.js');",
        "    const main = read('../main.js');",
        "    const preNames = [...pre.matchAll(/(\\w+):\\s*\\([^)]*\\)\\s*=>\\s*ipcRenderer\\.invoke\\('([^']+)'\\)/g)];",
        "    const mainNames = [...main.matchAll(/ipcMain\\.handle\\('([^']+)'/g)].map((m) => m[1]);",
        "    assert.ok(preNames.length >= 7, 'preload 至少 7 个方法，实际 ' + preNames.length);",
        '    assert.equal(preNames.length, mainNames.length, \'preload 与 main 的通道数量必须相等\');',
        '});',
        '',
    ].join('\n'));
    console.log('\n完成。接下来是 git 操作（脚本不代劳，见 docs/拆仓方案-2026-11-02.md §7）：');
    console.log('  1) 在两个目录里各自 git init / 首次提交');
    console.log('  2) 壳仓：git submodule add <核仓地址> core');
    console.log('  3) 核仓打 tag：git tag -split-baseline');
    console.log('  4) 壳仓跑 npm i && npm run check:syntax && npm test，再 npm run dist:dir 并 npx asar list 核对 core/app 是否进包');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    main(process.argv.slice(2));
}
