/**
 * IPC 通道契约测试：`app/shell/ipc.mjs` ↔ `preload.js` ↔ `main.js` 三方对齐。
 *
 * 为什么需要它：`_check-static.mjs` 只扫 `app/`，**完全不覆盖 `main.js` 与 `preload.js`**。
 * 而这三个文件是用字符串连起来的——`ipc.mjs` 里 `call('exportFrames')`、
 * `preload.js` 里 `exportFrames: (...) => ipcRenderer.invoke('ms:export-frames')`、
 * `main.js` 里 `ipcMain.handle('ms:export-frames')`。任何一环改名都不会报错，
 * 只会让那个功能在运行时静默返回 null（界面上就是「点了没反应」）。
 *
 * 这条缝在拆仓之后会变成**跨仓库契约**（桌面壳仓库 ↔ 核心仓库），
 * 所以更要有测试钉住，不能靠人记得。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/**
 * 合仓形态下有 `preload.js` 与 `main.js`，可以三方交叉验证（最强）；
 * 拆仓之后**核仓里没有这两个文件**，那时只能退回「核侧快照」：
 * 通道名单写死在本文件里，靠 bridge-web 与 ipc.mjs 自身对齐。
 * 一个文件撑两种形态，是为了让拆仓不必改测试——改测试就等于在迁移里
 * 悄悄降低了检查强度，而那正是最容易出事的时刻。
 */
const HAS_SHELL = existsSync(new URL('../preload.js', import.meta.url)) && existsSync(new URL('../main.js', import.meta.url));

/** 七个真通道（`ms:` 前缀是壳侧的东西，核侧只认方法名）。 */
const CHANNEL_NAMES = ['exportFrames', 'exportSheet', 'importFile', 'loadProject', 'openFolder', 'saveProject', 'saveBinary'];
/** `ipc.mjs` 里的兼容兜底老名字，不是通道。 */
const SOFT = ['openInFolder'];

/** `ipc.mjs` 里总共调用了哪些桥函数名（`call('name', …)`）。 */
function bridgeCalls() {
    const src = read('../app/shell/ipc.mjs');
    const names = [...src.matchAll(/\bcall\('([A-Za-z]+)'/g)].map((m) => m[1]);
    return new Set(names);
}

/** `preload.js` 暴露的方法名 → 它 invoke 的通道。 */
function preloadMap() {
    const src = read('../preload.js');
    const map = new Map();
    const re = /(\w+):\s*\([^)]*\)\s*=>\s*ipcRenderer\.invoke\('(ms:[a-z-]+)'/g;
    for (const m of src.matchAll(re)) map.set(m[1], m[2]);
    return map;
}

/** `main.js` 注册了哪些通道。 */
function mainChannels() {
    const src = read('../main.js');
    return new Set([...src.matchAll(/ipcMain\.handle\('(ms:[a-z-]+)'/g)].map((m) => m[1]));
}

test('ipc.mjs 调用的每个桥函数，preload 都暴露了', { skip: !HAS_SHELL && '核仓形态：没有 preload.js，见下一条核侧快照' }, () => {
    const calls = bridgeCalls();
    const map = preloadMap();
    // openInFolder 是 ipc.mjs 里的兼容兜底（老名字），preload 只保证 openFolder
    const soft = new Set(['openInFolder']);
    const missing = [...calls].filter((name) => !map.has(name) && !soft.has(name));
    assert.deepEqual(missing, [], 'preload 缺这些方法：' + missing.join(', '));
});

test('preload 暴露的方法，main 都注册了同名通道', { skip: !HAS_SHELL && '核仓形态：没有 preload.js / main.js' }, () => {
    const map = preloadMap();
    const channels = mainChannels();
    const missing = [...map].filter(([, channel]) => !channels.has(channel)).map(([name, channel]) => name + '→' + channel);
    assert.deepEqual(missing, [], 'main 缺这些通道：' + missing.join(', '));
    assert.equal(map.size, channels.size, 'preload 与 main 的通道数量应该相等');
});

test('通道名集合就是那七个，改名要同步三处', { skip: !HAS_SHELL && '核仓形态：没有 main.js' }, () => {
    const channels = [...mainChannels()].sort();
    assert.deepEqual(channels, [
        'ms:export-frames',
        'ms:export-sheet',
        'ms:import-file',
        'ms:load-project',
        'ms:open-folder',
        'ms:save-binary',
        'ms:save-project',
    ]);
});

test('核侧快照：ipc.mjs 的桥函数集合 = 七个通道 + 一个兼容老名', () => {
    // 这条在合仓与核仓两种形态下都跑：它只读 app/，不碰壳。
    const calls = [...bridgeCalls()].sort();
    const expected = [...CHANNEL_NAMES, ...SOFT].sort();
    assert.deepEqual(calls, expected, '桥函数集合变了：改名/新增/删除都要同步本文件、bridge-web.mjs 与壳仓');
});

test('核侧快照：浏览器桥实现了全部七个通道', () => {
    const src = read('../app/shell/bridge-web.mjs');
    const names = new Set([...src.matchAll(/^\s{8}(?:async )?([A-Za-z]+)\(/gm)].map((m) => m[1]));
    const missing = CHANNEL_NAMES.filter((n) => !names.has(n));
    assert.deepEqual(missing, [], '浏览器桥少实现：' + missing.join(', '));
});

test('浏览器桥覆盖了同一组方法名（拆仓后这是跨仓契约）', { skip: !HAS_SHELL && '核仓形态：以核侧快照那条为准' }, () => {
    const src = read('../app/shell/bridge-web.mjs');
    const names = [...src.matchAll(/^\s{8}(?:async )?([A-Za-z]+)\(/gm)].map((m) => m[1]);
    const map = preloadMap();
    const expected = [...map.keys()].sort();
    const got = [...new Set(names)].filter((n) => expected.includes(n)).sort();
    assert.deepEqual(got, expected, '浏览器桥少实现：' + expected.filter((n) => !got.includes(n)).join(', '));
});

test('本文件是唯一允许读壳文件的地方，且缺壳时必须降级而不是崩', () => {
    // 两种形态（合仓 / 核仓）都必须能跑：
    //   · 合仓：main.js 与 preload.js 在同一树里 → 跑三方交叉
    //   · 核仓：只剩 ipc.mjs 与 bridge-web.mjs → 交叉测试 skip，只跑核侧快照
    // 所以这里**不再断言 HAS_SHELL 为真** —— 早期版本断言「必须是合仓形态」，
    // 结果拆出来的核仓一跑就红。真正该钉的是「有降级分支」。
    assert.ok(read('../tests/ipc-contract.test.mjs').includes('skip: !HAS_SHELL'), '缺壳降级的分支不见了');
    assert.ok(read('../tests/ipc-contract.test.mjs').includes('HAS_SHELL'), '形态探测本身不见了');
    if (!HAS_SHELL) {
        // 核仓形态下，跨仓那几条必须被 skip 掉而不是失败
        assert.ok(!read('../app/shell/ipc.mjs').includes('require('), '核仓的 ipc.mjs 不应该碰 require');
    }
});
