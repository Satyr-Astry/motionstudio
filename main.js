// MotionStudio 主进程：只做三件事 —— 起本地静态服务、开窗口、提供文件导出与项目读写。
// 渲染进程完全跑在 http://127.0.0.1:<port>/ 上，这样 ES module、localStorage、同源策略都正常。
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const http = require('http');
const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, 'app');
const INDEX = path.join(APP_DIR, 'index.html');
const PREFERRED_PORT = 43117;

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
};

let win = null;
let port = 0;

function log(...args) {
    console.log('[ms]', ...args);
}

/** 把 URL 路径解析成 APP_DIR 内的绝对路径，越界一律返回 null。 */
function resolveFile(urlPath) {
    const clean = decodeURIComponent(urlPath.split('?')[0]);
    const rel = clean === '/' ? 'index.html' : clean.replace(/^\/+/, '');
    const abs = path.resolve(APP_DIR, rel);
    if (abs !== APP_DIR && !abs.startsWith(APP_DIR + path.sep)) return null;
    return abs;
}

function serve(req, res) {
    const abs = resolveFile(req.url || '/');
    if (!abs) {
        res.writeHead(403).end('forbidden');
        return;
    }
    fs.readFile(abs, (err, buf) => {
        if (err) {
            res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404 ' + req.url);
            return;
        }
        const ext = path.extname(abs).toLowerCase();
        res.writeHead(200, {
            'content-type': MIME[ext] || 'application/octet-stream',
            'cache-control': 'no-store',
        });
        res.end(buf);
    });
}

function startServer() {
    return new Promise((resolve, reject) => {
        const server = http.createServer(serve);
        server.once('error', (err) => {
            if (err && err.code === 'EADDRINUSE') {
                // 首选端口被占用时退回随机端口
                const alt = http.createServer(serve);
                alt.listen(0, '127.0.0.1', () => resolve(alt));
            } else {
                reject(err);
            }
        });
        server.listen(PREFERRED_PORT, '127.0.0.1', () => resolve(server));
    });
}

function sanitize(name) {
    return String(name || '动画').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || '动画';
}

function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return (
        d.getFullYear() +
        p(d.getMonth() + 1) +
        p(d.getDate()) +
        '-' +
        p(d.getHours()) +
        p(d.getMinutes()) +
        p(d.getSeconds())
    );
}

/**
 * 导入对话框的 filters。
 * 分组顺序即默认选中项（PSD 在最前：动画工程里一次导一整个 PSD 是最常见路径），
 * 最后再来一条「全部可导入文件」，用户就不用为了混合选择先切分组。
 */
const IMPORT_EXTS = ['psd', 'psb', 'png', 'jpg', 'jpeg', 'webp'];

function importFilters(exts) {
    // 渲染侧可以传一组扩展名来把对话框收窄（例如「只导入 PSD」）
    const list = Array.isArray(exts)
        ? exts
              .map((e) => String(e || '').toLowerCase().replace(/^\./, ''))
              .filter((e) => /^[a-z0-9]{2,5}$/.test(e))
        : [];
    if (list.length) {
        return [
            { name: '可导入文件', extensions: list },
            { name: '全部文件', extensions: ['*'] },
        ];
    }
    return [
        { name: 'Photoshop 文档', extensions: ['psd', 'psb'] },
        { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] },
        { name: '全部可导入文件', extensions: IMPORT_EXTS },
    ];
}

/** 逐帧 PNG 导出：写入「图片/MotionStudio/<名字>-<时间戳>/frame_0001.png…」 */
function exportFrames(payload) {
    const name = sanitize(payload && payload.name);
    const frames = (payload && payload.frames) || [];
    if (!frames.length) return { ok: false, error: '没有可导出的帧' };
    const dir = path.join(app.getPath('pictures'), 'MotionStudio', name + '-' + stamp());
    fs.mkdirSync(dir, { recursive: true });
    let count = 0;
    frames.forEach((dataUrl, i) => {
        const m = /^data:image\/png;base64,(.+)$/.exec(String(dataUrl || ''));
        if (!m) return;
        const file = path.join(dir, 'frame_' + String(i + 1).padStart(4, '0') + '.png');
        fs.writeFileSync(file, Buffer.from(m[1], 'base64'));
        count++;
    });
    log('[export]', dir, count);
    return { ok: count > 0, dir, count };
}

/** 精灵图导出：写入「图片/MotionStudio/<名字>-sheet-<时间戳>/」下的 png + 帧表 json */
function exportSheet(payload) {
    const name = sanitize(payload && payload.name);
    const m = /^data:image\/png;base64,(.+)$/.exec(String((payload && payload.png) || ''));
    if (!m) return { ok: false, error: '精灵图不是 PNG dataURL' };
    const dir = path.join(app.getPath('pictures'), 'MotionStudio', name + '-sheet-' + stamp());
    fs.mkdirSync(dir, { recursive: true });
    const png = path.join(dir, name + '.png');
    fs.writeFileSync(png, Buffer.from(m[1], 'base64'));
    let jsonFile = '';
    const text = payload && payload.json;
    if (typeof text === 'string' && text) {
        jsonFile = path.join(dir, name + '.json');
        fs.writeFileSync(jsonFile, text, 'utf8');
    }
    log('[sheet]', dir);
    return { ok: true, dir: dir, png: png, json: jsonFile };
}

function createWindow() {
    win = new BrowserWindow({
        width: 1400,
        height: 880,
        minWidth: 1000,
        minHeight: 620,
        backgroundColor: '#141518',
        title: 'MotionStudio',
        show: false,
        autoHideMenuBar: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            spellcheck: false,
        },
    });
    win.once('ready-to-show', () => win.show());
    win.loadURL('http://127.0.0.1:' + port + '/index.html');
    win.webContents.on('did-fail-load', (_e, code, desc, url) => log('load failed', code, desc, url));
    // 开发用快捷键：F5/Ctrl+R 重载，F12 开发者工具
    win.webContents.on('before-input-event', (evt, input) => {
        if (input.type !== 'keyDown') return;
        if (input.key === 'F5' || (input.control && input.key.toLowerCase() === 'r')) {
            win.webContents.reload();
            evt.preventDefault();
        } else if (input.key === 'F12') {
            win.webContents.toggleDevTools();
            evt.preventDefault();
        }
    });
    // 应用自己的 Ctrl+滚轮用途：画板调稳定器档位、时间轴以指针为锚缩放。
    // 把浏览器级缩放锁死（含触控板捏合），保证这两种手势不会被 Chromium 抢走、把整个界面放大。
    // 实测边界（ms-view/verify-zoom-real.mjs，Win32 SendInput 真实 Ctrl+滚轮）：
    //   本机 Electron 40 上即便没有这两行，Ctrl+滚轮也不缩放页面（负对照 pageZoomed=false）。
    //   所以这是「把策略写死」的防御性约束，不是已复现缺陷的修复；捏合手势无法用该手段验证。
    win.webContents.setVisualZoomLevelLimits(1, 1);
    win.webContents.on('zoom-changed', (evt) => evt.preventDefault());
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:/i.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
}

app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    const server = await startServer();
    port = server.address().port;
    log('serving', APP_DIR, 'on', port);

    ipcMain.handle('ms:export-frames', (_e, payload) => {
        try {
            return exportFrames(payload);
        } catch (err) {
            log('export failed', err && err.message);
            return { ok: false, error: String(err && err.message) };
        }
    });

    ipcMain.handle('ms:export-sheet', (_e, payload) => {
        try {
            return exportSheet(payload);
        } catch (err) {
            log('sheet failed', err && err.message);
            return { ok: false, error: String(err && err.message) };
        }
    });

    ipcMain.handle('ms:save-project', async (_e, payload) => {
        // v2 起项目文件用 .msp；旧的 .json 仍然可选（下游读入两种都认）。
        const name = sanitize(payload && payload.name) + '.msp';
        const picked = await dialog.showSaveDialog(win, {
            title: '保存项目',
            defaultPath: path.join(app.getPath('documents'), name),
            filters: [
                { name: 'MotionStudio 项目', extensions: ['msp'] },
                { name: 'MotionStudio 项目（旧版 JSON）', extensions: ['json'] },
            ],
        });
        if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
        fs.writeFileSync(picked.filePath, String((payload && payload.json) || '{}'), 'utf8');
        return { ok: true, file: picked.filePath };
    });

    // 二进制导出（WebM 视频等）：对话框选路径后直接把字节写盘。
    // 不把字节塞进 JSON、也不走 base64 —— 视频动辄几 MB，结构化克隆直接搬 ArrayBuffer。
    ipcMain.handle('ms:save-binary', async (_e, payload) => {
        try {
            const name = sanitize(payload && payload.name) || 'export';
            const ext = String((payload && payload.ext) || 'bin').replace(/[^a-z0-9]/gi, '') || 'bin';
            const label = String((payload && payload.label) || ext.toUpperCase()).slice(0, 24);
            const bytes = payload && payload.bytes;
            const buf = bytes instanceof Uint8Array ? Buffer.from(bytes) : Buffer.from(bytes || []);
            if (!buf.length) return { ok: false, error: '没有可写入的数据' };
            const picked = await dialog.showSaveDialog(win, {
                title: '导出 ' + label,
                defaultPath: path.join(app.getPath('videos'), name + '.' + ext),
                filters: [{ name: label, extensions: [ext] }],
            });
            if (picked.canceled || !picked.filePath) return { ok: false, canceled: true };
            fs.writeFileSync(picked.filePath, buf);
            return { ok: true, file: picked.filePath, size: buf.length };
        } catch (err) {
            log('save-binary failed', err && err.message);
            return { ok: false, error: String(err && err.message) };
        }
    });

    ipcMain.handle('ms:load-project', async () => {
        const picked = await dialog.showOpenDialog(win, {
            title: '打开项目',
            properties: ['openFile'],
            filters: [
                { name: 'MotionStudio 项目', extensions: ['msp', 'json'] },
                { name: '旧版项目 JSON', extensions: ['json'] },
            ],
        });
        if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
        const file = picked.filePaths[0];
        return { ok: true, file, json: fs.readFileSync(file, 'utf8') };
    });

    // 导入 PSD / 位图：只负责「选文件 + 读字节」，解码与映射全在渲染进程
    // （psd.mjs 是纯 JS，不需要在主进程再跑一遍；也让渲染侧能单测）。
    ipcMain.handle('ms:import-file', async (_e, payload) => {
        try {
            const picked = await dialog.showOpenDialog(win, {
                title: '导入 PSD / 图片',
                properties: ['openFile'],
                filters: importFilters(payload && payload.exts),
            });
            if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };
            const file = picked.filePaths[0];
            const buf = fs.readFileSync(file);
            // 切片到独立的 ArrayBuffer：readFileSync 的 Buffer 来自 Node 的共享池，
            // 直接把 buf.buffer 发过去会把整个 8KB 池（甚至更多）一起搬进渲染进程。
            const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
            log('import', file, buf.length);
            return {
                ok: true,
                path: file,
                name: path.basename(file),
                ext: path.extname(file).toLowerCase().replace(/^\./, ''),
                size: buf.length,
                data,
            };
        } catch (err) {
            log('import failed', err && err.message);
            return { ok: false, error: String(err && err.message) };
        }
    });

    ipcMain.handle('ms:open-folder', (_e, dir) => {
        if (typeof dir === 'string' && dir && fs.existsSync(dir)) shell.openPath(dir);
        return { ok: true };
    });

    createWindow();
});

app.on('window-all-closed', () => app.quit());
app.on('activate', () => {
    if (!win) createWindow();
});
