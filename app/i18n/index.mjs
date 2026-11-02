/**
 * 运行期词条表（本地化的唯一入口）。
 *
 * 为什么是「运行期查表」而不是「构建期替换文案」：
 *   1. 本项目的铁律是**无构建步骤**（`README.md` 的 Design principles，`_check-static.mjs`
 *      直接跑源码），构建期替换会让开发时读到的源码与用户看到的界面不是同一份；
 *   2. 切换语言要能在不刷新页面的情况下生效 —— ESM 的静态 import 在加载时就绑定好，
 *      整份模块切换做不到「按 locale 换」；
 *   3. `_check-static.mjs` 只认源码，构建期产物里的文案它扫不到，等于放弃静态检查。
 *
 * 词典用 `.mjs` 静态 import 而不是 fetch JSON：两份表合计几十 KB，静态 import 是同步的，
 * 因此 `boot()` 不必变成 async，也就不存在「文案到达前先渲染一遍中文」的闪烁。
 * （将来主进程侧要用的少量文案另建一份 JSON，渲染进程不共用这条路径。）
 *
 * 键语法：`区域.实体.字段`，全小写、点分层，例如 `editor.timeline.title`。
 * 占位符：`{name}`，由 `t(key, vars)` 替换；没有对应变量时原样保留（宁可露出 `{x}`，
 * 也不悄悄吞掉调用方写错的变量名）。
 */
import en from './en.mjs';
import zhHans from './zh-Hans.mjs';
import { PARTS } from './parts/index.mjs';

/** 支持的 locale，第一项是缺省值（英文优先，见 README）。 */
export const LOCALES = Object.freeze(['en', 'zh-Hans']);

export const DEFAULT_LOCALE = 'en';

/**
 * 基础表 + 各分片合并成一张完整词典。
 *
 * 分片见 `./parts/index.mjs`：按代码归属切开，改一个面板只动一个文件。
 * 合并在模块求值时做一次（`Object.freeze` 之后是常量），所以 `t()` 的查表仍是 O(1)。
 */
function mergeParts(base, id) {
    const merged = { ...base };
    for (const part of PARTS) {
        const table = part && part[id];
        if (!table) continue;
        for (const [k, v] of Object.entries(table)) {
            // 分片之间不许抢同一个键：静默覆盖是最难查的 bug，这里宁可让它响亮
            if (Object.prototype.hasOwnProperty.call(merged, k)) {
                throw new Error(`i18n 词条重复：${k}（${id}）——分片之间或与基础表撞键了`);
            }
            merged[k] = v;
        }
    }
    return Object.freeze(merged);
}

const DICTS = Object.freeze({
    en: mergeParts(en, 'en'),
    'zh-Hans': mergeParts(zhHans, 'zh-Hans'),
});

let current = DEFAULT_LOCALE;

/** 把外部输入（偏好文件、命令行、`?lang=`）归一成一个受支持的 locale。 */
export function normalizeLocale(id) {
    const raw = String(id == null ? '' : id).trim();
    if (!raw) return DEFAULT_LOCALE;
    if (LOCALES.includes(raw)) return raw;
    // 常见的几种写法都认，避免用户手改偏好文件就掉回英文
    const low = raw.toLowerCase().replace('_', '-');
    if (low === 'zh' || low === 'zh-cn' || low === 'zh-hans' || low === 'cn' || low === 'chs') return 'zh-Hans';
    if (low.startsWith('en')) return 'en';
    return DEFAULT_LOCALE;
}

/** 当前生效的 locale。 */
export function getLocale() {
    return current;
}

/**
 * 切换语言。**只管换表，不负责重绘** —— 界面刷新由调用方决定
 * （`shell/view-host.mjs` 的 `remountAll()` 重挂各面板，`shell/app.mjs` 的 `boot()`
 * 负责启动期那一份）。把重绘留在这里会形成 i18n → view-host → 编辑器 → i18n 的回环。
 */
export function setLocale(id) {
    const next = normalizeLocale(id);
    const changed = next !== current;
    current = next;
    return changed;
}

/** 当前语言的词典（只读，供检查器与测试遍历）。 */
export function dictOf(id) {
    return DICTS[normalizeLocale(id)] || DICTS[DEFAULT_LOCALE];
}

/**
 * 取词条。
 *
 * @param {string} key 例如 `editor.timeline.title`
 * @param {object|string} [vars] 占位符变量；传字符串时等价于「这一条缺失时的回退文案」
 * @returns {string} 命中返回译文；缺失依次回退到缺省语言 → 调用点给出的回退 → key 本身
 */
export function t(key, vars) {
    const fallbackText = typeof vars === 'string' ? vars : null;
    const table = DICTS[current] || DICTS[DEFAULT_LOCALE];
    let text = table[key];
    if (text === undefined) {
        const base = DICTS[DEFAULT_LOCALE];
        text = base[key];
    }
    if (text === undefined) return fallbackText === null ? key : fallbackText;
    if (!vars || typeof vars !== 'object') return text;
    return text.replace(/\{(\w+)\}/g, (whole, name) => (
        Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole
    ));
}

/** 这条词条在当前语言里有没有（调用点据此决定是走词条还是走自带原文）。 */
export function has(key) {
    const table = DICTS[current] || DICTS[DEFAULT_LOCALE];
    return typeof table[key] === 'string';
}

/** 词条总数与键清单：`_check-i18n.mjs` 用它比对两份词典是否镜面。 */
export function keysOf(id) {
    return Object.keys(dictOf(id)).sort();
}

/** locale → `<html lang>` 的值。屏幕阅读器与断词规则读的是这个，不是我们的内部 id。 */
const HTML_LANG = Object.freeze({ en: 'en', 'zh-Hans': 'zh-CN' });

export function htmlLangOf(id) {
    return HTML_LANG[normalizeLocale(id)] || 'en';
}
