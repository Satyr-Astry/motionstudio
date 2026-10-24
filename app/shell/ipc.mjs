/**
 * MotionStudio —— 主进程桥（唯一接触 window.motionAPI 的地方）
 *
 * 契约：web 层永远不直接写 window.motionAPI。
 * preload 没注入 / 在纯浏览器里跑时，这些函数**返回 null 而不是抛异常**，
 * 这样同一个 app.mjs 既能在 Electron 里跑，也能用 vite/node 静态托管调试。
 *
 * preload.js 暴露的六个通道（名字必须逐字对齐，写错了会静默返回 null）：
 *   exportFrames(name, frames)  → 'ms:export-frames' payload {name, frames}
 *   exportSheet(name, png, json) → 'ms:export-sheet' payload {name, png, json}
 *   saveProject(name, json)     → 'ms:save-project'  payload {name, json}
 *   loadProject()               → 'ms:load-project'  无 payload
 *   importFile(exts)            → 'ms:import-file'   payload {exts}
 *   openFolder(dir)             → 'ms:open-folder'   payload 就是 dir 字符串
 */

function bridge() {
    try {
        const api = globalThis.window && globalThis.window.motionAPI;
        return api && typeof api === 'object' ? api : null;
    } catch (err) {
        return null;
    }
}

function call(name, args) {
    const api = bridge();
    if (!api) return null;
    const fn = api[name];
    if (typeof fn !== 'function') return null;
    try {
        return fn.apply(api, args);
    } catch (err) {
        console.warn('[ipc] ' + name + ' 调用失败：', err);
        return null;
    }
}

/** 是否跑在桌面壳里（有 preload 注入的桥）。 */
export function available() {
    return !!bridge();
}

/**
 * 导出逐帧 PNG。
 * @param {string} name 工程名（无扩展名）
 * @param {string[]} frames dataURL 数组
 * @returns {Promise<object>|object|null}
 */
export function exportFrames(name, frames) {
    if (!Array.isArray(frames) || !frames.length) return null;
    return call('exportFrames', [String(name == null ? 'motionstudio' : name), frames]);
}

/**
 * 导出精灵图：主进程写「图片/MotionStudio/<名字>-sheet-<时间戳>/」下的
 * `<名字>.png` + `<名字>.json`（帧表）。
 *
 * @param {string} name 工程名（无扩展名）
 * @param {string} png 精灵图 dataURL（image/png）
 * @param {string|object} json 帧表（对象会被 stringify）
 * @returns {Promise<object>|object|null} `{ok,dir,png,json}` / null
 */
export function exportSheet(name, png, json) {
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

/** 读取项目 JSON（主进程弹打开对话框）；返回 `{ok,file,json}` 或 null。 */
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
