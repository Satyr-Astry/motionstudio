/**
 * 偏好（localStorage 的 `ms.prefs`）清洗规则。
 *
 * 纯函数、零依赖 —— 放 core 是为了能在 node 里直跑测试；真正的读写与落盘在
 * `shell/doc-state.mjs`（那边才知道引擎、窗口和缺省文档尺寸）。
 *
 * 为什么必须清洗：这份 JSON 允许手改、也会被旧版本/第三方工具写坏。一个
 * `undoLimit: "abc"` 或 `objectW: 1e9` 进去以后，面板看着正常、实际行为全错，
 * 而且用户完全不知道是偏好文件的问题。
 */

/** 兜底值。shell 层会传自己的（文档尺寸依赖窗口常量），这里只保证单独调用也安全。 */
export const FALLBACK_PREFS = Object.freeze({
    autoSave: 0,
    undoLimit: 100,
    snapGrid: 0.1,
    objectW: 900,
    objectH: 640,
    bg: 'checker',
});

/**
 * 把任意来源的偏好过一遍白名单 + 类型/范围校验，坏值**逐项**退回缺省。
 * 只认下面列出的键：手改残留、旧版本字段、第三方写入的多余字段一律丢掉。
 *
 * @param {unknown} raw 来自 JSON.parse 的任意值
 * @param {object} [defaults] 缺省快照（shell 传入含真实文档尺寸的那份）
 * @returns {{autoSave:number, undoLimit:number, snapGrid:number, objectW:number, objectH:number, bg:string}}
 */
export function cleanPrefs(raw, defaults) {
    const dflt = defaults && typeof defaults === 'object' ? defaults : FALLBACK_PREFS;
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    // 只认「数字」和「非空数字字符串」：`Number('')`/`Number([])`/`Number(null)` 都是 0，
    // 直接 Number() 会把空值悄悄变成 0 这种合法值，反而看不出偏好文件坏了。
    const numLike = (v) => (typeof v === 'number' ? true : typeof v === 'string' ? v.trim() !== '' : false);
    const num = (v, lo, hi, fallback) => {
        if (!numLike(v)) return fallback;
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
    };
    const int = (v, lo, hi, fallback) => Math.round(num(v, lo, hi, fallback));
    // 「必须有正值」的字段（撤销步数、对象默认尺寸）：0 和负数当**坏值**退回缺省，
    // 而不是夹到下限 —— 夹出「1 步撤销」「1×1 的对象」比退回缺省更糟。
    const posInt = (v, hi, fallback) => {
        if (!numLike(v)) return fallback;
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return fallback;
        return Math.min(hi, Math.round(n));
    };
    // 旧版本偏好面板只写 sizeW/sizeH（它自己那套键名），外壳读的却是 objectW/objectH ——
    // 于是「面板里改了对象默认尺寸」当次生效、重启后悄悄回到缺省。读取时优先新键、
    // 兜底旧键，存量设置就不会在升级后归零。
    const wSrc = numLike(src.objectW) ? src.objectW : src.sizeW;
    const hSrc = numLike(src.objectH) ? src.objectH : src.sizeH;
    return {
        autoSave: int(src.autoSave, 0, 3600, dflt.autoSave),
        undoLimit: posInt(src.undoLimit, 2000, dflt.undoLimit),
        snapGrid: num(src.snapGrid, 0, 10, dflt.snapGrid),
        objectW: posInt(wSrc, 4096, dflt.objectW),
        objectH: posInt(hSrc, 4096, dflt.objectH),
        // 只放行「小写字母开头 + 小写字母/连字符」的标识符：值会进 class 与分支判断，
        // 不接受任意字符串（更不接受数字/对象）。
        bg: typeof src.bg === 'string' && /^[a-z][a-z-]{0,15}$/.test(src.bg) ? src.bg : dflt.bg,
    };
}
