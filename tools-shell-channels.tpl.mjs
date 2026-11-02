// 跨仓契约：preload ↔ main 的通道名必须一一对应，且核仓的 ipc.mjs 与它一致。
//
// 拆仓前这条断言住在核仓的 tests/ipc-contract.test.mjs 里（合仓形态，三方交叉）。
// 拆仓后壳仓只能自己守 preload ↔ main；核仓那一侧由核仓自己的快照测试守。
// 只有壳仓能同时看见三者 —— 所以在壳仓里多守一条「核仓声明的通道也在 main 里注册」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const invokeRe = /ipcRenderer\.invoke\(\s*'([^']+)'/g;
const handleRe = /ipcMain\.handle\(\s*'([^']+)'/g;
const calledRe = /call\(\s*'([^']+)'/g;

const pre = read('../preload.js');
const main = read('../main.js');
const preChannels = [...pre.matchAll(invokeRe)].map((m) => m[1]).sort();
const mainChannels = [...main.matchAll(handleRe)].map((m) => m[1]).sort();

test('preload 暴露的通道与 main 注册的通道一一对应', () => {
    assert.ok(preChannels.length >= 7, 'preload 至少 7 个通道，实际 ' + preChannels.length);
    assert.deepEqual(preChannels, mainChannels, 'preload 与 main 的通道集合必须完全一致');
});

test('通道名都以 ms: 开头（主进程命名空间）', () => {
    for (const c of preChannels) assert.ok(c.startsWith('ms:'), '通道名应带 ms: 前缀：' + c);
});

test('核仓 ipc.mjs 调用的方法名，preload 都暴露了（submodule 挂 core/）', () => {
    const coreIpc = new URL('../core/app/shell/ipc.mjs', import.meta.url);
    if (!existsSync(coreIpc)) {
        // 还没 git submodule update --init 时不该红
        return;
    }
    const src = read('../core/app/shell/ipc.mjs');
    const calls = [...src.matchAll(calledRe)].map((m) => m[1]);
    // 暴露的方法名：exposeInMainWorld 对象里的 `方法: ` 行（4 空格缩进）
    const methods = [...pre.matchAll(/^\s{4}(\w+):\s/gm)].map((m) => m[1]);
    // openInFolder 是 ipc.mjs 自己保留的老名字兜底（只在旧 preload 上有），不算缺
    const LEGACY = new Set(['openInFolder']);
    for (const name of calls) {
        if (LEGACY.has(name)) continue;
        assert.ok(methods.includes(name), '核仓要调用 ' + name + '，但壳仓 preload 没有暴露它');
    }
});
