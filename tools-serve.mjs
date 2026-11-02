// 把 `app/` 当站点根起一个静态服务器 —— 零依赖、只读，用来：
//   1. 浏览器里直接开 http://127.0.0.1:43117/ 就是完整应用（不需要 Electron 壳）；
//   2. 拆仓之后核仓自己就能起服务，不依赖桌面壳仓库；
//   3. 想把 `app/` 部署到任意静态托管时，这份 MIME 与越界处理就是参考实现。
//
// 用法：node tools-serve.mjs [端口]      （默认 43117，与桌面壳 `main.js` 里的端口一致）
//
// 与 `main.js` 的差：这里**不做** `ms:*` 那七个通道（浏览器里由 `app/shell/bridge-web.mjs` 接管），
// 也不开窗口、不碰 Electron。它就是个 http 服务器。
import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'app');
const PORT = Number(process.argv[2] || process.env.MS_PORT || 43117);

// 与 main.js 同一张表：`.mjs` 必须是 text/javascript，否则浏览器按 MIME 拒绝执行模块
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webm': 'video/webm',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
};

/** 把 URL 路径解析成 app/ 里的真实文件；越界一律 null（不给 ../ 一点点机会）。 */
function resolveFile(urlPath) {
    let path = decodeURIComponent((urlPath || '/').split('?')[0]);
    if (path.endsWith('/')) path += 'index.html';
    if (path === '/') path = '/index.html';
    const target = resolve(join(ROOT, normalize(path).replace(/^([/\\])+/, '')));
    if (target !== ROOT && !target.startsWith(ROOT + sep)) return null;
    try {
        const st = statSync(target);
        if (st.isDirectory()) return resolveFile(path + '/');
        return { file: target, size: st.size };
    } catch {
        return null;
    }
}

const server = createServer((req, res) => {
    const hit = resolveFile(req.url);
    if (!hit) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('404 ' + (req.url || ''));
        return;
    }
    const type = MIME[extname(hit.file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
        'content-type': type,
        'content-length': hit.size,
        'cache-control': 'no-store',
    });
    createReadStream(hit.file).pipe(res);
});

server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        console.error('端口 ' + PORT + ' 已被占用（桌面壳可能在跑）。换个端口：node tools-serve.mjs 43118');
        process.exit(1);
    }
    throw err;
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('MotionStudio（网页形态）→ http://127.0.0.1:' + PORT + '/');
    console.log('站点根：' + ROOT);
    console.log('Ctrl+C 结束。数据存在浏览器里（IndexedDB），与桌面版不共享。');
});
