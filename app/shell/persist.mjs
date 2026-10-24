/**
 * MotionStudio —— 布局持久化（localStorage）
 *
 * 只存「布局」：三个工作区的区域树 + 当前工作区。
 * 不存文档（像素另走主进程导出），所以这里不需要异步、不需要版本迁移链。
 *
 * 版本号不一致 → loadLayout() 返回 null，调用方退回默认布局。
 * 所有函数在 localStorage 不可用（隐私模式 / Node 环境）时静默降级，不抛异常。
 */

export const LS_KEY = 'klm-layout';
// 改动默认布局必须 bump：老 localStorage 里的树不含新区域
// （v2 加了 curve；v3 编排模式去掉工具条与调色板，画板模式保留）。
export const LS_VER = 3;

function store() {
    try {
        const s = globalThis.localStorage;
        return s && typeof s.getItem === 'function' ? s : null;
    } catch (err) {
        return null;
    }
}

/**
 * 读取布局。
 * @returns {{active:string|null, trees:Object<string,object>}|null}
 */
export function loadLayout() {
    const s = store();
    if (!s) return null;
    let raw = null;
    try {
        raw = s.getItem(LS_KEY);
    } catch (err) {
        return null;
    }
    if (!raw) return null;
    let obj = null;
    try {
        obj = JSON.parse(raw);
    } catch (err) {
        return null;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    if (Number(obj.ver) !== LS_VER) return null;
    const trees = obj.trees && typeof obj.trees === 'object' && !Array.isArray(obj.trees) ? obj.trees : {};
    const active = typeof obj.active === 'string' && obj.active ? obj.active : null;
    return { active, trees };
}

/**
 * 写入布局；state 形如 { active, trees }。
 * @returns {boolean} 是否写成功
 */
export function saveLayout(state) {
    const s = store();
    if (!s) return false;
    const src = state && typeof state === 'object' ? state : {};
    const payload = {
        ver: LS_VER,
        active: typeof src.active === 'string' ? src.active : null,
        trees: src.trees && typeof src.trees === 'object' ? src.trees : {},
    };
    try {
        s.setItem(LS_KEY, JSON.stringify(payload));
        return true;
    } catch (err) {
        // 配额满 / 被禁用：布局丢失比抛异常好
        return false;
    }
}

/** 清空布局（resetLayout 用）。 */
export function clearLayout() {
    const s = store();
    if (!s) return false;
    try {
        s.removeItem(LS_KEY);
        return true;
    } catch (err) {
        return false;
    }
}
