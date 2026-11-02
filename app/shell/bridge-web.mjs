/**
 * MotionStudio —— 浏览器桥（纯网页版没有 preload 时补上那八路通道）
 *
 * 这个文件只在**没有桌面壳**时做事：检测到 `window.motionAPI` 就直接返回，
 * 所以同一份 `app/index.html` 既能被 Electron 加载（走真实 IPC），
 * 也能被任意静态服务器当站点托管（走这里的降级实现）。
 *
 * 浏览器能做到与做不到的边界（写清楚，别让界面假装成功）：
 *   ✅ 导出 PNG 序列 / 精灵图 / WebM / 项目文件 —— 走**下载**，文件进浏览器的下载目录
 *   ✅ 打开 .msp / 导入 PSD、图片 —— 走 `<input type="file">` 的文件选择框
 *   ⚠️ 没有「选目录」「打开文件夹」：浏览器没有对应 API，`openFolder` 明确报错
 *   ⚠️ 不能**写回**一个已绑定的任意路径：`saveProjectTo` 明确回 unsupported，
 *      调用方据此说「库已保存、文件没更新」，而不是假装回写成功
 *   ⚠️ 一次导出几百张 PNG 时，浏览器会连着弹下载并把它们合并成一批；
 *      用户在地址栏右侧会看到「已拦截多个下载」的提示，那是浏览器行为，不是丢文件
 *
 * 为什么不用 File System Access API（`showSaveFilePicker`）：
 * 它必须在**用户手势**里同步调用，而我们的保存发生在几十个 await 之后
 * （合成、编码、切片都跑完了才拿字节），到那时已经不在手势上下文里，
 * 调用必抛 SecurityError。硬要接就得让每个导出入口把「先选路径」提前到按钮点击处，
 * 那是整条导出链的重构；下载方案零前提、处处可用，先用它。
 */

import { setBridge } from './ipc.mjs';

const TICK_MS = 120;
const DOWNLOAD_DIR = '浏览器下载目录';

const tick = () => new Promise((resolve) => setTimeout(resolve, TICK_MS));

/** 文件名清洗：Windows / macOS / Linux 都不接受的字符换成下划线。 */
function safeName(name, fallback) {
    const raw = String(name == null ? '' : name).trim() || fallback;
    return raw.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^\.+/, '').slice(0, 80) || fallback;
}

function mimeOf(ext) {
    const e = String(ext || '').toLowerCase();
    if (e === 'webm') return 'video/webm';
    if (e === 'png') return 'image/png';
    if (e === 'gif') return 'image/gif';
    if (e === 'json' || e === 'msp') return 'application/json';
    return 'application/octet-stream';
}

/**
 * dataURL → Blob。
 *
 * 不用 `fetch(dataUrl)`：CSP 是 `default-src 'self'`，`connect-src` 跟着回落到 'self'，
 * `fetch(data:…)` 会被拦掉。手写解码只依赖 atob，不受 CSP 约束。
 */
function dataUrlToBlob(url) {
    const text = String(url || '');
    const comma = text.indexOf(',');
    if (!text.startsWith('data:') || comma < 0) {
        return new Blob([text], { type: 'application/octet-stream' });
    }
    const head = text.slice(5, comma);
    const body = text.slice(comma + 1);
    const mime = (head.match(/^([^;,]+)/) || [])[1] || 'application/octet-stream';
    if (!/;base64/i.test(head)) {
        try {
            return new Blob([decodeURIComponent(body)], { type: mime });
        } catch (err) {
            return new Blob([body], { type: mime });
        }
    }
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
}

/** 把一个 Blob 交给浏览器下载。返回落在下载目录里的文件名。 */
function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 立刻 revoke 会让部分浏览器的下载中断，留一段时间
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    return filename;
}

/**
 * 弹文件选择框，等用户选完（或关掉）。
 *
 * 取消检测：用户点「取消」时 `change` 不会触发，Promise 会永远挂着。
 * 文件对话框关闭的瞬间窗口会重新获得焦点，所以监听一次 `focus`，
 * 留 300ms 给 `change` 先到（`settled` 保证只结算一次）。
 */
function pickFile(accept) {
    return new Promise((resolve) => {
        let input = null;
        let timer = 0;
        let settled = false;

        const finish = (value) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            window.removeEventListener('focus', onFocus);
            if (input) {
                input.remove();
                input = null;
            }
            resolve(value);
        };
        const onFocus = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => finish({ canceled: true }), 300);
        };

        try {
            input = document.createElement('input');
            input.type = 'file';
            if (accept) input.accept = accept;
            input.style.position = 'fixed';
            input.style.left = '-9999px';
            input.addEventListener('change', () => {
                const file = input && input.files && input.files[0];
                finish(file ? { file } : { canceled: true });
            });
            input.addEventListener('cancel', () => finish({ canceled: true }));
            document.body.appendChild(input);
            window.addEventListener('focus', onFocus);
            input.click();
        } catch (err) {
            finish({ canceled: true, error: (err && err.message) || String(err) });
        }
    });
}

/** 浏览器版八路通道。返回形状与主进程 IPC 逐字对齐（见 shell/ipc.mjs 头注释）。 */
function createWebBridge() {
    return {
        /** 逐帧 PNG → 连续下载。返回 `{ok,dir,count}`，调用方只读 dir/count。 */
        async exportFrames(name, frames, opts) {
            const list = Array.isArray(frames) ? frames : [];
            if (!list.length) return { ok: false, error: '没有可导出的帧' };
            const o = opts && typeof opts === 'object' ? opts : {};
            const start = Number.isFinite(o.startIndex) && o.startIndex > 0 ? o.startIndex : 0;
            const total = Number.isFinite(o.total) && o.total > 0 ? o.total : start + list.length;
            const width = String(Math.max(1, total)).length;
            const base = safeName(name, 'motionstudio');
            for (let i = 0; i < list.length; i++) {
                const index = String(start + i).padStart(width, '0');
                download(dataUrlToBlob(list[i]), base + '-' + index + '.png');
                if (i < list.length - 1) await tick();
            }
            return { ok: true, dir: DOWNLOAD_DIR, count: list.length };
        },

        /** 精灵图 PNG + 帧表 JSON → 下载（多张图集时带 -1/-2 后缀）。 */
        async exportSheet(name, png, json, opts) {
            const o = opts && typeof opts === 'object' ? opts : {};
            const base = safeName(name, 'motionstudio');
            const sheets = Array.isArray(o.sheets) && o.sheets.length ? o.sheets : [{ png }];
            const jsonList = Array.isArray(o.jsons) && o.jsons.length ? o.jsons : [{ text: json }];
            let written = 0;
            for (let i = 0; i < sheets.length; i++) {
                const suffix = sheets.length > 1 ? '-' + (i + 1) : '';
                const sheet = sheets[i] || {};
                const pngData = sheet.png || (i === 0 ? png : '');
                if (pngData) {
                    download(dataUrlToBlob(pngData), base + suffix + '.png');
                    written++;
                    await tick();
                }
                const text = (jsonList[i] && jsonList[i].text) || (i === 0 ? json : '');
                if (text) {
                    const body = typeof text === 'string' ? text : JSON.stringify(text);
                    download(new Blob([body], { type: 'application/json' }), base + suffix + '.json');
                    written++;
                    await tick();
                }
            }
            if (!written) return { ok: false, error: '没有可写出的图集（图与帧表都是空的）' };
            return { ok: true, dir: DOWNLOAD_DIR, count: written };
        },

        /** 项目 JSON → 下载成 .msp（`file` 必须非空：调用方靠它判断真的落了盘）。 */
        async saveProject(name, json) {
            const text = typeof json === 'string' ? json : JSON.stringify(json);
            if (typeof text !== 'string' || !text) return { ok: false, error: '项目内容是空的，没写出文件' };
            const file = safeName(name, 'motionstudio') + '.msp';
            download(new Blob([text], { type: 'application/json' }), file);
            return { ok: true, file };
        },

        /**
         * 写回已绑定路径：浏览器做不到，**诚实回 unsupported**。
         *
         * 为什么不是 null：null 在 ipc 层是「这条通道没跑起来」（无桥 / 无函数），
         * 调用方没法分辨「环境不支持」与「preload 漏了这一路」。这里给结构化结果，
         * 调用方就能说清「库已保存、文件没更新，请用另存为下载」。
         */
        async saveProjectTo() {
            return {
                ok: false,
                unsupported: true,
                error: 'the browser cannot overwrite an arbitrary path',
            };
        },

        /** 任意字节（WebM / GIF …）→ 下载。 */
        async saveBinary(name, bytes, ext, label) {
            if (!bytes) return { ok: false, error: '没有内容可存（字节是空的）' };
            const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: mimeOf(ext) });
            if (!blob.size) return { ok: false, error: '没有内容可存（字节是空的）' };
            const file = safeName(name, 'motionstudio') + '.' + (ext || 'bin');
            download(blob, file);
            return { ok: true, file, size: blob.size };
        },

        /** 选一个 .msp/.json 读成文本。 */
        async loadProject() {
            const picked = await pickFile('.msp,.json,application/json');
            if (picked.error) return { ok: false, error: '打不开文件选择框：' + picked.error };
            if (picked.canceled) return { ok: false, canceled: true };
            const file = picked.file;
            try {
                return { ok: true, file: file.name, json: await file.text() };
            } catch (err) {
                return { ok: false, error: '读不了这个文件：' + ((err && err.message) || err) };
            }
        },

        /** 选 PSD / 图片读成字节。`data` 必须是 ArrayBuffer（调用方直接喂给解析器）。 */
        async importFile(exts) {
            const list = Array.isArray(exts) ? exts.filter((e) => typeof e === 'string' && e.trim()) : [];
            const accept = list.length
                ? list.map((e) => '.' + String(e).replace(/^\./, '')).join(',')
                : '.psd,.psb,.png,.jpg,.jpeg,.webp,.gif';
            const picked = await pickFile(accept);
            if (picked.error) return { ok: false, error: '打不开文件选择框：' + picked.error };
            if (picked.canceled) return { ok: false, canceled: true };
            const file = picked.file;
            try {
                const data = await file.arrayBuffer();
                const dot = file.name.lastIndexOf('.');
                const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : '';
                return { ok: true, path: file.name, name: file.name, ext, size: file.size, data };
            } catch (err) {
                return { ok: false, error: '读不了这个文件：' + ((err && err.message) || err) };
            }
        },

        /** 浏览器没有文件管理器。明确报错，让调用方 flash 出原因，而不是静默什么都不发生。 */
        async openFolder() {
            return { ok: false, error: '浏览器里没有文件管理器；文件已交给下载，请在下载记录里找' };
        },
    };
}

/**
 * 装上浏览器桥。已经有 `window.motionAPI`（桌面壳）时什么都不做。
 *
 * @returns {boolean} 是否装了
 */
export function installWebBridge() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return false;
    try {
        const existing = window.motionAPI && typeof window.motionAPI === 'object' ? window.motionAPI : null;
        if (existing) return false;
        return setBridge(createWebBridge());
    } catch (err) {
        console.warn('[bridge-web] 安装失败（按桌面壳缺失处理）：', err);
        return false;
    }
}

// index.html 在 app.mjs 之前引入本文件，模块求值时就把桥挂好，
// 于是 app.mjs 的 boot() 一进来 ipc.available() 就是 true。
installWebBridge();
