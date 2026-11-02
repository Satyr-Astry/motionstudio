/**
 * MotionStudio —— 编辑器注册表
 *
 * 这里是「区域能放哪些编辑器」的唯一清单：
 * - 区域头的 select.area-type 用它渲染下拉选项；
 * - app.mjs 用 editorTitle() 写状态栏、用 editorDef() 取 mount 函数；
 * - 契约 §2/§5：编辑器模块只导出 mount(el, ctx)，由外壳负责挂载与刷新。
 *
 * 额外的导出（placeCanvas）只有画布编辑器有，用命名空间 import 取，
 * 这样即使 T2 暂时没写 placeCanvas 也不会让整个外壳 import 失败。
 */

import { mount as mountCanvas } from '../editors/canvas.mjs';
import { mount as mountBoard } from '../editors/board.mjs';
import { mount as mountToolbar } from '../editors/toolbar.mjs';
import { mount as mountLayers } from '../editors/layers.mjs';
import { mount as mountTree } from '../editors/tree.mjs';
import { mount as mountTimeline } from '../editors/timeline.mjs';
import { mount as mountCurve } from '../editors/curve.mjs';
import { mount as mountPalette } from '../editors/palette.mjs';
import { mount as mountProperties } from '../editors/properties.mjs';
import { mount as mountDoc } from '../editors/prop-doc.mjs';
import { mount as mountOnion } from '../editors/prop-onion.mjs';
import { mount as mountInfo } from '../editors/prop-info.mjs';
import { mount as mountPrefs } from '../editors/prop-prefs.mjs';
import { mount as mountHelp } from '../editors/help.mjs';
import { mount as mountProjects } from '../editors/projects.mjs';
import { t } from '../i18n/index.mjs';

/**
 * @typedef {{id:string, title:string, hint:string, mount:(el:Element, ctx:object)=>object}} EditorDef
 * @type {EditorDef[]}
 */
/**
 * 设置模式的三块面板（文档 / 洋葱皮 / 信息）原本住在属性面板里，
 * 单独挂成编辑器时它们只产出 .prop-group，没有 .prop 这层滚动容器。
 * 这里统一包一层，保证与属性面板同样的内边距与滚动行为。
 */
function withPropShell(mountFn) {
    return function mountInProp(el, ctx) {
        const shell = document.createElement('div');
        shell.className = 'prop';
        el.appendChild(shell);
        const inst = mountFn(shell, ctx);
        return {
            refresh: inst && typeof inst.refresh === 'function' ? inst.refresh : () => {},
            destroy: () => {
                if (inst && typeof inst.destroy === 'function') inst.destroy();
                shell.remove();
            },
        };
    };
}

export const EDITORS = [
    { id: 'canvas', mount: mountCanvas },
    // 画板：对象的出生地。自带 canvas 与工具条，与画布的单例宿主互不相干。
    { id: 'board', mount: mountBoard },
    { id: 'toolbar', mount: mountToolbar },
    // 层级与叠放拆成两个面板（docs/层级与叠放-2026-10.md §5）：
    // tree 只编辑 parentId（跟谁动），layers 只管 drawOrder（谁盖谁），两边各改一处数据。
    { id: 'tree', mount: mountTree },
    { id: 'layers', mount: mountLayers },
    { id: 'timeline', mount: mountTimeline },
    { id: 'curve', mount: mountCurve },
    { id: 'palette', mount: mountPalette },
    { id: 'properties', mount: mountProperties },
    // 设置模式的三块：文档 / 洋葱皮 / 信息（原先挤在属性面板里）
    { id: 'doc', mount: withPropShell(mountDoc) },
    { id: 'onion', mount: withPropShell(mountOnion) },
    { id: 'info', mount: withPropShell(mountInfo) },
    // 偏好：本机习惯（localStorage ms.prefs），不随项目走，所以独立成一块
    { id: 'prefs', mount: withPropShell(mountPrefs) },

    { id: 'help', mount: mountHelp },
    // 本地项目库：保存/打开项目的入口（数据走 shell/project-store.mjs，不是 iframe）。
    { id: 'projects', mount: mountProjects },
];

/** 缺省编辑器（layout.mjs 的 DEFAULT_EDITOR 是 timeline，这里保持同一口味）。 */
export const FALLBACK_EDITOR = 'timeline';

/** 按 id 取定义；未知 id 返回 null，绝不抛异常。 */
export function editorDef(id) {
    for (const e of EDITORS) if (e.id === id) return e;
    return null;
}

/** 全部编辑器 id，顺序与下拉一致。 */
export function editorIds() {
    return EDITORS.map((e) => e.id);
}

/** 面板标题；未知 id 原样回显，方便状态栏排查布局文件。 */
export function editorTitle(id) {
    const def = editorDef(id);
    if (!def) return String(id == null ? '' : id);
    return t('editor.' + def.id + '.title');
}

/**
 * 区域下拉用的显示名与说明：**只有词条一条路**。
 * alpha.25 起 `EDITORS` 不再带中文原文——缺词时 `t()` 返回键名本身，
 * 界面上出现 `editor.canvas.title` 这种字样就等于「这里漏了一条词条」，反而好查；
 * 结构性缺口由 `_check-i18n.mjs --strict` 的「编辑器覆盖 15/15」先兜住。
 */
export function editorLabel(def) {
    if (!def) return '';
    return t('editor.' + def.id + '.title');
}

export function editorHint(def) {
    if (!def) return '';
    return t('editor.' + def.id + '.hint');
}
