// 无壳冒烟：把 app/ 当静态站点跑一遍，确认**所有编辑器都能挂起来**。
//
// 为什么需要它：`npm test` 只 import 纯逻辑模块，`app/shell/*` 与 `app/editors/*`
// 一个都没被 Node 加载过。这个项目历史上已经出现过四次「测试全绿 + 静态检查干净
// + 页面白屏/面板起不来」（同一函数 export 两次、import 写重、文件写一半、i18n 的
// `t` 被别名后在调用点仍写 `t(...)`）。`check:syntax` 只拦语法，拦不住运行时绑定错。
//
// 用法：`npm run smoke`（需要先 `npm install`，用本项目的 electron 跑）。
// 它自己起静态服务器（不用 main.js），窗口**不挂 preload、不开 nodeIntegration**
// —— 也就是「浏览器模式」，顺带验证 Web 入口成立。
const { app, BrowserWindow } = require('electron');
const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { extname, join, normalize } = require('node:path');

// 被当成 node 跑时（最常见原因：环境里设了 ELECTRON_RUN_AS_NODE=1），
// `require('electron')` 只拿到路径字符串，后面会以「reading 'commandLine'」的
// TypeError 崩掉 —— 那行堆栈完全看不出真正的原因，所以先自己说清楚。
if (!app || typeof app.commandLine === 'undefined') {
    console.error('SMOKE FAIL 没跑在 Electron 里。请用 `npm run smoke`；'
        + '如果环境里设了 ELECTRON_RUN_AS_NODE=1，先清掉它。');
    process.exit(1);
}

const ROOT = normalize(join(__dirname, 'app')).replace(/\\/g, '/');
// 端口可覆盖：核仓与壳仓同时跑、或桌面版 `npm start` 正占着 43117 时，
// 固定端口会偶发 EADDRINUSE（chk 报告里已实测撞过一次）。
// 设 MS_SMOKE_PORT=0 则交给系统分配，回读实际端口。
const PORT = process.env.MS_SMOKE_PORT === undefined ? 43812 : Number(process.env.MS_SMOKE_PORT);
let actualPort = PORT;
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
};

function serve() {
    return new Promise((resolve, reject) => {
        const server = createServer(async (req, res) => {
            const url = decodeURIComponent((req.url || '/').split('?')[0]);
            const file = normalize(join(ROOT, url === '/' ? 'index.html' : url)).replace(/\\/g, '/');
            if (!file.startsWith(ROOT)) {
                res.writeHead(403).end('forbidden');
                return;
            }
            try {
                const body = await readFile(file);
                res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
                res.end(body);
            } catch {
                res.writeHead(404).end('not found');
            }
        });
        server.on('error', reject);
        server.listen(PORT, '127.0.0.1', () => {
            actualPort = server.address().port;
            resolve(server);
        });
    });
}

// 等页面把一帧画完：两帧 rAF 之外再给 120ms，覆盖 rAF 兜底与 60ms 刷新档。
const settle = `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))))`;

const EDITOR_PROBE = `(async () => {
    const out = { tried: [], failed: [], ok: 0 };
    const sel = document.querySelector('#ws-host select');
    if (!sel) { out.failed.push('找不到编辑器选择框：view-host 没起来'); return out; }
    const ids = [...sel.options].map((o) => o.value).filter(Boolean);
    for (const id of ids) {
        // 当前已挂载的那个不用切：它本来就在页面上，挂载失败早就在 errors 里了。
        // 但它要计入 ok —— 否则读数会随「首屏默认编辑器」漂移（15 或 14），
        // 想拿它做回归对比就不可靠了。
        if (sel.value === id) { out.ok += 1; continue; }
        out.tried.push(id);
        const before = window.__smokeErrors ? window.__smokeErrors.length : 0;
        sel.value = id;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await ${settle};
        const after = window.__smokeErrors ? window.__smokeErrors.length : 0;
        if (after > before) out.failed.push(id + ': ' + window.__smokeErrors[after - 1]);
        else out.ok += 1;
    }
    return out;
})()`;

const LOCALE_PROBE = `(async () => {
    const out = { switched: [], failed: [] };
    // 语言开关在「偏好」面板里：先把某个槽切到 prefs，再点语言按钮。
    const sel = document.querySelector('#ws-host select');
    if (!sel) { out.failed.push('找不到编辑器选择框'); return out; }
    const prefs = [...sel.options].map((o) => o.value).find((v) => /prefs/i.test(v));
    if (!prefs) { out.failed.push('registry 里没有 prefs 编辑器'); return out; }
    sel.value = prefs;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await ${settle};
    for (const label of ['简体中文', 'English']) {
        const b = [...document.querySelectorAll('button')].find((x) => x.textContent && x.textContent.trim() === label);
        if (!b) { out.failed.push('找不到语言按钮 ' + label); continue; }
        b.click();
        await ${settle};
        out.switched.push(label + ' -> ' + document.documentElement.lang);
    }
    return out;
})()`;

app.commandLine.appendSwitch('disable-gpu');
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
    const server = await serve().catch((err) => {
        console.error('SMOKE FAIL 起不来静态服务器：' + err.message);
        app.exit(1);
    });
    if (!server) return;

    const errors = [];
    const win = new BrowserWindow({
        show: false,
        width: 1280,
        height: 800,
        webPreferences: { contextIsolation: true, nodeIntegration: false },
    });

    win.webContents.on('console-message', (event) => {
        // 新版 Electron 给的是事件对象；老版是 (event, level, message)。
        const level = typeof event.level === 'number' ? event.level : event.level;
        const message = event.message || '';
        if (level === 'error' || level === 3 || level === 2) errors.push('console: ' + message);
    });
    win.webContents.on('render-process-gone', (_e, d) => errors.push('render-gone: ' + d.reason));
    win.webContents.on('did-fail-load', (_e, code, desc, url) => errors.push('did-fail-load: ' + code + ' ' + desc + ' ' + url));

    const url = 'http://127.0.0.1:' + actualPort + '/index.html';
    try {
        await win.loadURL(url);
    } catch (err) {
        errors.push('loadURL: ' + err.message);
    }
    await new Promise((r) => setTimeout(r, 2500));

    const base = await win.webContents.executeJavaScript(`(() => ({
        hasMotionAPI: typeof window.motionAPI,
        bridge: typeof (window.__msWebBridge || null),
        htmlLang: document.documentElement.lang,
        topbarButtons: document.querySelectorAll('#topbar button').length,
        canvases: document.querySelectorAll('canvas').length,
        selects: document.querySelectorAll('select').length,
        status: (document.querySelector('#statusbar') || {}).textContent || '',
        firstEditor: (document.querySelector('select option') || {}).textContent || '',
    }))()`);

    // 让页面自己记错误，才能在逐个挂载时判断「这一步有没有炸」
    await win.webContents.executeJavaScript(`(() => {
        window.__smokeErrors = [];
        const orig = console.error;
        console.error = function (...a) {
            window.__smokeErrors.push(a.map(String).join(' '));
            return orig.apply(console, a);
        };
    })()`);

    const editors = await win.webContents.executeJavaScript(EDITOR_PROBE);
    const locale = await win.webContents.executeJavaScript(LOCALE_PROBE);

    // 页面内记到的错误也并进来（挂载时的 ReferenceError 走 console.error）
    const pageErrors = await win.webContents.executeJavaScript('window.__smokeErrors || []');

    const problems = errors.concat(pageErrors.map((m) => 'page: ' + m)).concat(editors.failed).concat(locale.failed);
    const lines = [
        'PROBE ' + JSON.stringify(base),
        'EDITORS tried=' + editors.tried.length + ' ok=' + editors.ok + ' failed=' + JSON.stringify(editors.failed),
        'LOCALE ' + JSON.stringify(locale.switched),
        'PROBLEMS ' + JSON.stringify(problems),
    ];
    console.log(lines.join('\n'));

    const bad = problems.length > 0
        || base.hasMotionAPI !== 'undefined'
        || base.canvases < 1
        || base.topbarButtons < 5
        || !base.status.trim();
    console.log(bad ? 'SMOKE FAIL' : 'SMOKE OK');
    server.close();
    app.exit(bad ? 1 : 0);
});
