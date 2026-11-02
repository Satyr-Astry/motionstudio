/**
 * MotionStudio —— 主进程桥（唯一接触 window.motionAPI 的地方）
 *
 * 契约：web 层永远不直接写 window.motionAPI。
 * preload 没注入 / 在纯浏览器里跑时，这些函数**返回 null 而不是抛异常**，
 * 这样同一个 app.mjs 既能在 Electron 里跑，也能用 vite/node 静态托管调试。
 *
 * ⚠️ null 是「这条通道没跑起来」，不是「用户取消」：无桥、无函数、抛异常都归到 null。
 * 需要区分取消与失败的调用点用 `saveBinaryChecked()`（或自己先判 `available()`），
 * 别把 null 当取消、更别把它当成功 —— 那正是「没存下来却报已导出」的旧毛病。
 *
 * preload.js 暴露的七个通道（名字必须逐字对齐，写错了会静默返回 null）：
 *   exportFrames(name, frames)  → 'ms:export-frames' payload {name, frames}
 *   exportSheet(name, png, json) → 'ms:export-sheet' payload {name, png, json}
 *   saveProject(name, json)     → 'ms:save-project'  payload {name, json}
 *   loadProject()               → 'ms:load-project'  无 payload
 *   importFile(exts)            → 'ms:import-file'   payload {exts}
 *   saveBinary(name, bytes, …)  → 'ms:save-binary'   payload {name, bytes, ext, label}
 *   openFolder(dir)             → 'ms:open-folder'   payload 就是 dir 字符串
 *
 * 纯网页版没有 preload：`shell/bridge-web.mjs` 会调 `setBridge()` 装一份降级实现
 * （导出走下载、打开走文件选择框、openFolder 明确报错），本文件以下逻辑完全不变。
 */

// 词条表是纯数据模块（不碰 DOM、不碰 window），桥这一层可以直接引 ——
// 这里产出的是**用户会看到的一句话**，所以它必须走词条，而不是在源码里写死中文。
import { t } from '../i18n/index.mjs';

/**
 * 注入的桥：纯网页版由 `shell/bridge-web.mjs` 在模块求值时装进来，
 * 装好之后这一个文件仍是**唯一**接触桥的代码，调用方一行都不用改。
 * 桌面壳不注入，走下面的 window.motionAPI。
 *
 * @type {object|null}
 */
let injected = null;

/**
 * 装上（或卸掉）一份桥实现。
 * @param {object|null} impl 六路通道对象；传 null 等于卸掉
 * @returns {boolean} 是否装上了
 */
export function setBridge(impl) {
    injected = impl && typeof impl === 'object' ? impl : null;
    return !!injected;
}

function bridge() {
    if (injected) return injected;
    try {
        const api = globalThis.window && globalThis.window.motionAPI;
        return api && typeof api === 'object' ? api : null;
    } catch (err) {
        return null;
    }
}

/**
 * 最近一次**同步抛错**的原因。
 *
 * `call()` 吞异常是对的（桥的毛病不该炸掉 UI），但吞掉之后调用方只看到 null，
 * 就分不清「preload 没挂这一路」和「挂了但一调用就抛」—— 后者报「没响应」
 * 是在给用户一个错的原因。这里把原文留一句，供 `lastFailure()` 取。
 */
let lastError = '';

function call(name, args) {
    const api = bridge();
    if (!api) return null;
    const fn = api[name];
    if (typeof fn !== 'function') return null;
    try {
        lastError = '';
        return fn.apply(api, args);
    } catch (err) {
        lastError = (err && err.message) || String(err);
        console.warn('[ipc] ' + name + ' 调用失败：', err);
        return null;
    }
}

/** 上一个桥函数同步抛错的原因（没有就空串）。只对同一 tick 内的 null 结果有意义。 */
export function lastFailure() {
    return lastError;
}

/** 是否跑在桌面壳里（有 preload 注入的桥）。 */
export function available() {
    return !!bridge();
}

/**
 * 导出逐帧 PNG。
 * @param {string} name 工程名（无扩展名）
 * @param {string[]} frames dataURL 数组（分片时是该片的帧）
 * @param {{dir?:string, startIndex?:number, total?:number}} [opts] 第 32 批：分片与自定义目录
 * @returns {Promise<object>|object|null}
 */
export function exportFrames(name, frames, opts) {
    if (!Array.isArray(frames)) return null;
    const o = opts && typeof opts === 'object' ? opts : {};
    const resuming = Number.isFinite(o.startIndex) && o.startIndex > 0;
    if (!frames.length && !resuming) return null;
    return call('exportFrames', [String(name == null ? 'motionstudio' : name), frames, o]);
}

/**
 * 导出精灵图：主进程写「图片/MotionStudio/<名字>-sheet-<时间戳>/」下的
 * `<名字>.png` + `<名字>.json`（帧表）。
 *
 * @param {string} name 工程名（无扩展名）
 * @param {string} png 精灵图 dataURL（image/png）
 * @param {string|object} json 帧表（对象会被 stringify）
 * @param {{dir?:string}} [opts] 第 32 批：自定义根目录
 * @returns {Promise<object>|object|null} `{ok,dir,png,json}` / null
 */
export function exportSheet(name, png, json, opts) {
    if (typeof png !== 'string' || !png) return null;
    let text = json;
    if (text && typeof text === 'object') {
        try {
            text = JSON.stringify(text);
        } catch (err) {
            return null;
        }
    }
    return call('exportSheet', [
        String(name == null ? 'motionstudio' : name),
        png,
        typeof text === 'string' ? text : '',
        opts && typeof opts === 'object' ? opts : {},
    ]);
}

/**
 * 保存项目 JSON（主进程会弹保存对话框，默认落在「文档」目录）。
 *
 * 两种调用形式都支持：
 *   saveProject(name, json)   ← 推荐：preload 的签名是 (name, json)
 *   saveProject(json)         ← 兼容：只给内容，工程名默认 motionstudio
 *
 * @param {string|object} name 工程名，或第二个参数省略时的 JSON
 * @param {string|object} [json] JSON 字符串或可序列化对象
 * @returns {Promise<object>|object|null} `{ok:true,file}` / `{ok:false,canceled:true}` / null
 */
export function saveProject(name, json) {
    let label = 'motionstudio';
    let payload = json;
    if (payload === undefined) {
        payload = name;
    } else if (name != null && String(name).trim()) {
        label = String(name).trim();
    }
    if (payload && typeof payload === 'object') {
        try {
            payload = JSON.stringify(payload);
        } catch (err) {
            return null;
        }
    }
    if (typeof payload !== 'string' || !payload) return null;
    // preload 的 saveProject 是 (name, json)：少传 name 会让主进程把内容写丢。
    return call('saveProject', [label, payload]);
}

/**
 * 保存一段二进制（WebM 视频等）。bytes 传 ArrayBuffer / Uint8Array / TypedArray 视图都可以。
 * 主进程会弹保存对话框；没有桌面壳时返回 null（纯浏览器调试不会炸）。
 *
 * @param {string} name 工程名（无扩展名，主进程会做文件名清洗）
 * @param {ArrayBuffer|Uint8Array} bytes 字节
 * @param {string} [ext] 扩展名（webm / gif …）
 * @param {string} [label] 对话框里显示的类型名
 * @returns {Promise<object>|null} `{ok,file,size}` / `{ok:false,canceled}` / null
 */
export function saveBinary(name, bytes, ext, label) {
    if (!bytes) return null;
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!view.byteLength) return null;
    return call('saveBinary', [
        String(name == null ? 'motionstudio' : name),
        view,
        String(ext || 'bin'),
        String(label || ''),
    ]);
}

/**
 * 保存字节流，并把「没桥 / 没内容 / 没响应 / 被拒绝 / 用户取消」拆成**可分辨**的结果。
 *
 * 为什么不用 `if (!saveBinary(...))`：`call()` 在无桥、无函数、抛异常三种情况下
 * 一律返回 null，把 null 当成「用户取消」正是「没存下来却说已取消」的来源；
 * 反过来把它当成成功就是「字节丢了还报已导出」。两种骗法都从这里堵死：
 * 只有拿到 `{ok:true, file}` 才算存下来了，其余一律带 error 文本回去。
 *
 * @param {string} name 工程名（无扩展名）
 * @param {ArrayBuffer|Uint8Array} bytes 字节
 * @param {string} [ext] 扩展名
 * @param {string} [label] 对话框里显示的类型名
 * @returns {Promise<{ok:true,file:string,size:number}|{ok:false,canceled?:true,error?:string}>}
 */
export async function saveBinaryChecked(name, bytes, ext, label) {
    if (!available()) {
        return { ok: false, error: t('shell.ipc.save.noBridge') };
    }
    const len = bytes && bytes instanceof Uint8Array ? bytes.byteLength : bytes && bytes.byteLength;
    if (!len) return { ok: false, error: t('shell.ipc.save.empty') };
    let res = null;
    try {
        res = await Promise.resolve(saveBinary(name, bytes, ext, label));
    } catch (err) {
        return { ok: false, error: t('shell.ipc.save.threw', { msg: (err && err.message) || err }) };
    }
    if (res == null) {
        const why = lastFailure();
        if (why) return { ok: false, error: t('shell.ipc.save.threw', { msg: why }) };
        return { ok: false, error: t('shell.ipc.save.noResponse') };
    }
    if (res.ok === false) {
        if (res.canceled) return { ok: false, canceled: true };
        return { ok: false, error: String(res.error || t('shell.ipc.save.failed')) };
    }
    // 回了成功却没给路径：主进程那边一定有一步没走到，别替它签收
    if (!res.file) return { ok: false, error: t('shell.ipc.save.noPath') };
    return { ok: true, file: String(res.file), size: Number(res.size) || 0 };
}

/** 读取项目 JSON（主进程弹打开对话框）；返回 `{ok,file,json}` 或 null。 */
export function loadProject() {
    return call('loadProject', []);
}

/**
 * 导入 PSD / 图片：主进程弹打开对话框并读成字节。
 *
 * 为什么返回二进制而不是 base64：PSD 动辄几十 MB，base64 要多背 33% 体积
 * 和两次字符串拷贝。IPC 的结构化克隆能直接搬 ArrayBuffer。
 *
 * @param {string[]} [exts] 收窄对话框的扩展名（如 ['psd','psb']）；不传就给全部分组
 * @returns {Promise<object>|null} `{ok,path,name,ext,size,data}` / `{ok:false,canceled}` / null
 */
export function importFile(exts) {
    const list = Array.isArray(exts) ? exts.filter((e) => typeof e === 'string' && e.trim()) : null;
    return call('importFile', [list && list.length ? list : null]);
}

/**
 * 在系统文件管理器里打开目录。
 * preload 暴露的名字是 openFolder（不是 openInFolder），这里带上兜底，
 * 免得 preload 改了名字之后整条链路静默失效。
 */
export function openFolder(dir) {
    const path = String(dir == null ? '' : dir);
    if (!path) return null;
    const api = bridge();
    if (api && typeof api.openFolder === 'function') return call('openFolder', [path]);
    if (api && typeof api.openInFolder === 'function') return call('openInFolder', [path]);
    return null;
}

/** 兼容旧名字：早先的调用点写的是 openInFolder。 */
export function openInFolder(dir) {
    return openFolder(dir);
}
