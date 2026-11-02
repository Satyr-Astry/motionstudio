// 拆仓工具（`tools-split.mjs`）的纯函数单测。
//
// 这个脚本只**生成**两个仓库的形态，不碰 git、不改当前仓库。所以能测的就是三件事：
//   1. 核仓的 package.json 不许残留任何桌面字段（残留 = 「核仓不依赖壳」变成空话）
//   2. 壳仓的打包 files 必须指向 `core/app/**`（挂载点是 core/ 而不是 app/，方案 §2）
//   3. `main.js` 的静态服务路径确实被改写（没改写就是拆完白屏）
//
// 文件搬运本身不测（它只是 fs.copyFile），但 `splitPlan` 的成员关系可以测：
// 核仓里不该有 main.js/preload.js，壳仓里不该有 app/tests。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    CORE_ENTRIES,
    SHELL_ENTRIES,
    corePackageJson,
    patchMainJs,
    shellPackageJson,
    splitPlan,
} from '../tools-split.mjs';

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('核仓 package.json：没有 main / build / dist 脚本，只留 electron 一个依赖', () => {
    const core = corePackageJson(PKG);
    assert.equal(core.main, undefined, '核仓不该有 main 字段（没有 Electron 入口）');
    assert.equal(core.build, undefined, '核仓不该有 electron-builder 配置');
    assert.equal(core.scripts.dist, undefined, '核仓不该有打包脚本');
    assert.equal(core.scripts.start, undefined, '核仓不该有 electron . 启动脚本');
    assert.deepEqual(Object.keys(core.devDependencies), ['electron'], '核仓 devDependencies 只留 electron（smoke 需要）');
    // 该留的一个都不能少
    for (const s of ['test', 'check', 'check:static', 'check:syntax', 'check:i18n', 'serve', 'smoke']) {
        assert.ok(core.scripts[s], '核仓缺脚本 ' + s);
    }
    assert.equal(core.version, PKG.version, '版本号必须跟仓库一致');
});

test('壳仓 package.json：main 指 main.js，打包 files 指向 core/app/** 且排除 submodule 的 .git', () => {
    const shell = shellPackageJson(PKG, '1.2.3');
    assert.equal(shell.main, 'main.js');
    assert.equal(shell.version, '1.2.3');
    assert.ok(shell.build, '壳仓必须有 electron-builder 配置');
    assert.ok(shell.build.files.includes('core/app/**/*'), 'files 必须指向 core/app/**（挂载点是 core/）');
    assert.ok(shell.build.files.includes('main.js') && shell.build.files.includes('preload.js'));
    assert.ok(shell.build.files.includes('!core/.git'), '必须排除 submodule 的 .git（它是文件，会被 copyDir 拷进安装目录）');
    assert.equal(shell.build.extraMetadata.main, 'main.js');
    assert.equal(shell.build.appId, PKG.build.appId, 'appId 不许改（改了老用户升级会变两个应用）');
    assert.equal(shell.build.nsis.shortcutName, PKG.build.nsis.shortcutName);
    assert.ok(shell.scripts.dist && shell.scripts.start, '壳仓必须能 start 与 dist');
    assert.ok(/submodule update/.test(shell.scripts.postinstall), 'postinstall 要拉 submodule');
    assert.deepEqual(shell.devDependencies, PKG.devDependencies, '壳仓需要 electron + electron-builder');
});

test('main.js 的静态服务路径被改写为 core/app', () => {
    const src = "serve(path.join(__dirname, 'app'), 43117);";
    const r = patchMainJs(src);
    assert.ok(r.changed, '应当检测到改写');
    assert.ok(r.src.includes("path.join(__dirname, 'core', 'app')"), '实际：' + r.src);
    // 没有目标行的文件不该被改坏
    const other = patchMainJs('const x = 1;');
    assert.equal(other.changed, false, '找不到目标行时必须原样返回，好让调用方给出警告');
    assert.equal(other.src, 'const x = 1;');
});

test('清单：核仓不含桌面壳文件，壳仓不含核仓源码', () => {
    for (const forbidden of ['main.js', 'preload.js', 'tools-pack.mjs']) {
        assert.ok(!CORE_ENTRIES.includes(forbidden), '核仓清单不该有 ' + forbidden);
    }
    for (const forbidden of ['app', 'tests', 'docs', '_check-static.mjs']) {
        assert.ok(!SHELL_ENTRIES.includes(forbidden), '壳仓清单不该有 ' + forbidden);
    }
    // 核仓必须有这三道闸与冒烟脚本（拆完还能自检）
    for (const need of ['_check-static.mjs', '_check-syntax.mjs', '_check-i18n.mjs', 'tools-smoke.cjs', 'tools-serve.mjs']) {
        assert.ok(CORE_ENTRIES.includes(need), '核仓缺 ' + need);
    }
    assert.ok(CORE_ENTRIES.includes('package-lock.json'), '核仓必须带 package-lock.json（否则 npm ci 直接 EUSAGE）');
});

test('splitPlan：按清单产出搬运项，且目标目录分成两个仓', () => {
    const plan = splitPlan(process.cwd(), 'D:/tmp/split-test');
    assert.ok(plan.length > 0);
    const core = plan.filter((p) => p.role === 'core');
    const shell = plan.filter((p) => p.role === 'shell');
    assert.ok(core.length >= 10, '核仓条目太少：' + core.length);
    assert.ok(shell.length >= 3, '壳仓条目太少：' + shell.length);
    for (const p of core) assert.ok(p.to.startsWith('D:\\tmp\\split-test\\motionstudio') || p.to.startsWith('D:/tmp/split-test/motionstudio'), '核仓目标路径不对：' + p.to);
    for (const p of shell) assert.ok(/motionstudio-desktop/.test(p.to), '壳仓目标路径不对：' + p.to);
});
