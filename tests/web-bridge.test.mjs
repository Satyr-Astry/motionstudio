/**
 * 浏览器桥（`app/shell/bridge-web.mjs`）的行为测试。
 *
 * 纯 node 环境里没有 DOM，所以这里装一套最小桩：`document.createElement` 造出
 * `<a download>` 与 `<input type=file>`，`window` 只留 addEventListener/removeEventListener。
 * 目的是把「网页版导出到底做了什么」变成可断言的事实，而不是靠人去浏览器点。
 *
 * 关键断言都对着**调用方真正读的字段**：`saveProject` 必须回非空 `file`
 * （`project-io.mjs` 靠它判断文件真的落地了），`importFile` 的 `data` 必须是
 * ArrayBuffer（`import-file.mjs` 直接喂给解析器），取消必须回 `{ok:false,canceled:true}`。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as ipc from '../app/shell/ipc.mjs';
import { installWebBridge } from '../app/shell/bridge-web.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** 装一套假 DOM，返回可控的下载记录与「下一次文件选择」的应答。 */
function fakeDom() {
    const downloads = [];
    const pending = { next: null }; // { file } 或 { canceled:true }
    const listeners = new Map();

    const makeAnchor = () => ({
        style: {},
        href: '',
        download: '',
        rel: '',
        click() {
            downloads.push(this.download);
        },
        remove() {},
        addEventListener() {},
    });

    const makeInput = () => {
        const input = {
            type: '',
            accept: '',
            style: {},
            files: [],
            _change: null,
            _cancel: null,
            addEventListener(name, fn) {
                if (name === 'change') input._change = fn;
                if (name === 'cancel') input._cancel = fn;
            },
            remove() {
                input._removed = true;
            },
            click() {
                // 用户操作是异步的：让调用栈先返回，再派发 change
                setTimeout(() => {
                    const answer = pending.next;
                    pending.next = null;
                    if (!answer || answer.canceled) {
                        if (input._cancel) input._cancel();
                        return;
                    }
                    input.files = [answer.file];
                    if (input._change) input._change();
                }, 0);
            },
        };
        return input;
    };

    globalThis.window = {
        motionAPI: undefined,
        addEventListener(name, fn) {
            listeners.set(name, fn);
        },
        removeEventListener(name) {
            listeners.delete(name);
        },
    };
    globalThis.document = {
        documentElement: { lang: '' },
        body: {
            appendChild(el) {
                el._parent = 'body';
                return el;
            },
        },
        createElement(tag) {
            if (tag === 'input') return makeInput();
            return makeAnchor();
        },
    };
    URL.createObjectURL = () => 'blob:fake';
    URL.revokeObjectURL = () => {};

    const fileOf = (name, text) => ({
        name,
        size: text.length,
        text: async () => text,
        arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    });

    return { downloads, listeners, fileOf, pending };
}

test('没有桌面壳也没有注入时，available() 为 false', () => {
    ipc.setBridge(null);
    const saved = globalThis.window;
    globalThis.window = undefined;
    try {
        assert.equal(ipc.available(), false);
    } finally {
        globalThis.window = saved;
    }
});

test('桌面上已有 window.motionAPI 时 installWebBridge 不接管', () => {
    fakeDom();
    globalThis.window.motionAPI = { saveProject: () => ({ ok: true, file: 'x' }) };
    assert.equal(installWebBridge(), false);
    assert.equal(ipc.available(), true); // 走的是真 preload，不是我们
    ipc.setBridge(null);
    globalThis.window.motionAPI = undefined;
});

test('纯浏览器里装上桥，六路通道都齐', () => {
    fakeDom();
    ipc.setBridge(null);
    assert.equal(installWebBridge(), true);
    for (const name of ['exportFrames', 'exportSheet', 'saveProject', 'loadProject', 'importFile', 'saveBinary', 'openFolder']) {
        assert.equal(typeof ipc[name], 'function', name + ' 应该是个函数');
    }
    assert.equal(ipc.available(), true);
});

test('saveProject 走下载，并且回非空 file', async () => {
    const dom = fakeDom();
    ipc.setBridge(null);
    installWebBridge();
    const out = await ipc.saveProject('测试项目', '{"version":4}');
    assert.equal(out.ok, true);
    assert.equal(out.file, '测试项目.msp'); // 调用方靠这个字段判断真的落了盘
    assert.deepEqual(dom.downloads, ['测试项目.msp']);
});

test('空内容在 ipc 层就被挡下：返回 null，桥压根收不到空活', async () => {
    const dom = fakeDom();
    ipc.setBridge(null);
    installWebBridge();
    assert.equal(await ipc.saveProject('x', ''), null);
    assert.equal(await ipc.saveProject('x', null), null);
    assert.deepEqual(dom.downloads, [], '空项目不该产生下载');
});

test('saveBinary 空字节同样在 ipc 层被挡下', async () => {
    const dom = fakeDom();
    ipc.setBridge(null);
    installWebBridge();
    assert.equal(await ipc.saveBinary('clip', new Uint8Array(0), 'webm'), null);
    assert.deepEqual(dom.downloads, []);
});

test('saveBinary 走下载，file 带扩展名、size 来自字节数', async () => {
    const dom = fakeDom();
    ipc.setBridge(null);
    installWebBridge();
    const out = await ipc.saveBinary('clip', new Uint8Array([1, 2, 3]), 'webm', 'WebM 视频');
    assert.equal(out.ok, true);
    assert.equal(out.file, 'clip.webm');
    assert.equal(out.size, 3);
    assert.deepEqual(dom.downloads, ['clip.webm']);
});

test('exportFrames 逐帧下载，序号按 startIndex/total 补零', async () => {
    const dom = fakeDom();
    ipc.setBridge(null);
    installWebBridge();
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const out = await ipc.exportFrames('demo', [png, png], { startIndex: 0, total: 3 });
    assert.equal(out.ok, true);
    assert.equal(out.count, 2);
    assert.deepEqual(dom.downloads, ['demo-0.png', 'demo-1.png']);
});

test('exportFrames 没有帧时在 ipc 层就被挡下（返回 null，不产生下载）', async () => {
    const dom = fakeDom();
    ipc.setBridge(null);
    installWebBridge();
    assert.equal(await ipc.exportFrames('demo', []), null);
    assert.deepEqual(dom.downloads, []);
});

test('exportSheet 同时下载图集与帧表', async () => {
    const dom = fakeDom();
    ipc.setBridge(null);
    installWebBridge();
    const out = await ipc.exportSheet('s', 'data:image/png;base64,iVBORw0KGgo=', '{"frames":[]}');
    assert.equal(out.ok, true);
    assert.deepEqual(dom.downloads, ['s.png', 's.json']);
});

test('loadProject 选到文件就回文本', async () => {
    const dom = fakeDom();
    ipc.setBridge(null);
    installWebBridge();
    dom.pending.next = { file: dom.fileOf('p.msp', '{"version":4}') };
    const out = await ipc.loadProject();
    assert.equal(out.ok, true);
    assert.equal(out.file, 'p.msp');
    assert.equal(out.json, '{"version":4}');
});

test('loadProject 用户取消时回 canceled，不含 error', async () => {
    const dom = fakeDom();
    ipc.setBridge(null);
    installWebBridge();
    dom.pending.next = { canceled: true };
    const out = await ipc.loadProject();
    assert.equal(out.ok, false);
    assert.equal(out.canceled, true);
    assert.equal(out.error, undefined);
});

test('importFile 交出 ArrayBuffer 与扩展名', async () => {
    const dom = fakeDom();
    ipc.setBridge(null);
    installWebBridge();
    dom.pending.next = { file: dom.fileOf('a.psd', 'PSD') };
    const out = await ipc.importFile(['psd', 'psb']);
    assert.equal(out.ok, true);
    assert.equal(out.name, 'a.psd');
    assert.equal(out.ext, 'psd');
    assert.equal(out.size, 3);
    assert.ok(out.data instanceof ArrayBuffer, 'data 必须是 ArrayBuffer');
    assert.equal(new TextDecoder().decode(out.data), 'PSD');
});

test('openFolder 明确报错，不假装成功', async () => {
    fakeDom();
    ipc.setBridge(null);
    installWebBridge();
    const out = await ipc.openFolder('/some/dir');
    assert.equal(out.ok, false);
    assert.match(out.error, /文件管理器/);
});

test('源码守卫：桥必须在 app.mjs 之前装上，且不碰 fetch(data:)', () => {
    const html = read('../app/index.html');
    const bridgeAt = html.indexOf('bridge-web.mjs');
    const appAt = html.indexOf('shell/app.mjs');
    assert.ok(bridgeAt > 0, 'index.html 要引入 bridge-web.mjs');
    assert.ok(bridgeAt < appAt, 'bridge-web 必须排在 app.mjs 之前');

    const src = read('../app/shell/bridge-web.mjs');
    // 注释里会提到 `fetch(...)` 为什么不行，所以只在**代码行**上禁
    const code = src
        .split('\n')
        .filter((line) => {
            const t = line.trim();
            return t && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('//');
        })
        .join('\n');
    assert.match(src, /import \{ setBridge \} from '\.\/ipc\.mjs'/);
    assert.match(src, /\ninstallWebBridge\(\);/);
    assert.match(src, /window\.motionAPI/);
    assert.doesNotMatch(code, /fetch\(/, 'fetch(data:) 会被 CSP 拦，不许用');
    // 取消检测必须存在，否则用户点取消会让 Promise 永远挂着
    assert.match(src, /addEventListener\('cancel'/);
});
