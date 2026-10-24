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
    { id: 'canvas', title: '画布', hint: '绘制、缩放、平移', mount: mountCanvas },
    // 画板：对象的出生地。自带 canvas 与工具条，与画布的单例宿主互不相干。
    { id: 'board', title: '画板', hint: '只编辑当前这一张纹理（与编排分离）', mount: mountBoard },
    { id: 'toolbar', title: '工具', hint: '画笔 / 笔尖 / 撤销', mount: mountToolbar },
    { id: 'layers', title: '对象', hint: '对象列表、可见性与不透明度', mount: mountLayers },
    { id: 'timeline', title: '时间轴', hint: '帧、时长与播放', mount: mountTimeline },
    { id: 'curve', title: '曲线', hint: '对象变换的连续曲线与贝塞尔切线', mount: mountCurve },
    { id: 'palette', title: '调色', hint: '色相、明度与最近颜色', mount: mountPalette },
    { id: 'properties', title: '属性', hint: '文档、帧与变换参数', mount: mountProperties },
    // 设置模式的三块：文档 / 洋葱皮 / 信息（原先挤在属性面板里）
    { id: 'doc', title: '文档', hint: '画布尺寸、帧率与循环', mount: withPropShell(mountDoc) },
    { id: 'onion', title: '洋葱皮', hint: '前后画格的残影', mount: withPropShell(mountOnion) },
    { id: 'info', title: '信息', hint: '对象 / 画格 / 关键帧统计', mount: withPropShell(mountInfo) },
    // 偏好：本机习惯（localStorage ms.prefs），不随项目走，所以独立成一块
    { id: 'prefs', title: '偏好', hint: '自动保存、撤销步数、吸附与画布底色', mount: withPropShell(mountPrefs) },

    { id: 'help', title: '帮助', hint: '快捷键一览', mount: mountHelp },
    // 本地项目库：保存/打开项目的入口（数据走 shell/project-store.mjs，不是 iframe）。
    { id: 'projects', title: '项目库', hint: '已保存的项目：载入 / 新建 / 删除', mount: mountProjects },
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
    return def ? def.title : String(id == null ? '' : id);
}
