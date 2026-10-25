/**
 * MotionStudio —— 帮助数据（键位表 / 图例）的唯一权威源
 *
 * 为什么收在这一处：键位表是「给人看的文档」，但它必须和真正生效的按键分派
 * 保持同一份数据。以前这张表被抄了三份（时间轴 `?` 浮层、设置里的帮助分组、
 * 画板底部 hint），改一处另外两处就旧了 —— 用户看到的是「表里写了、按了没反应」。
 * 现在导出两个常量，谁要显示谁 import：
 *
 *   SHORTCUT_GROUPS  分组（文件 / 时间 / 关键帧 / 画板 / 视图）× 条目
 *   LEGEND_ITEMS     画格 vs 关键帧的图例（时间轴右侧「?」与设置共用）
 *
 * 条目形状：{ icon, name, keys, hint? }
 *   icon  app/core/icons.mjs 里的名字（拼错会被 tests/icons.test.mjs 抓住）
 *   keys  真实按键串，空串表示「没有快捷键，只有鼠标操作」
 *   hint  补充说明，可省
 *
 * 这份表也是「快捷键审计」的基准：tests/icons.test.mjs 会扫 app/shell/app.mjs 的
 * 实际按键分派，把「表里有、代码里没有」的条目列出来 —— 发现不一致就改这张表
 * 或补代码，但不许在这里写一条按不响的键。
 */

import { icon } from '../core/icons.mjs';

/** 概念说明：这部分不是键位，是「动画是怎么构成的」，保留原文。 */
export const CONCEPT_ITEMS = [
    {
        title: '动画是怎么构成的',
        rows: [
            ['画格', '某时刻起显示的那张画。时间上是离散的——到点就换图，中间没有过渡。在「画板」里画出来。'],
            ['关键帧', '位置、缩放、旋转、不透明度、网格变形。时间上连续插值，中间有过渡。拖手柄或改数值就会自动打帧。'],
            ['时间通道', '对象自己的时间。可偏移、缩放、循环，让同一个动画用不同节奏播；套到父对象上会传给整棵子树。'],
        ],
    },
];

/** 权威键位表。分组顺序 = 用户从「拿到文件」到「调视图」的操作顺序。 */
export const SHORTCUT_GROUPS = [
    {
        id: 'file',
        title: '文件',
        icon: 'save',
        items: [
            { icon: 'save', name: '保存项目', keys: 'Ctrl+S', hint: '写入当前存档' },
            { icon: 'folder-open', name: '打开项目库', keys: 'Ctrl+O', hint: '最近项目 / 新建 / 导入' },
            { icon: 'export', name: '导出帧序列', keys: 'Ctrl+Shift+E', hint: 'PNG 序列 + 帧清单' },
            { icon: 'undo', name: '撤销', keys: 'Ctrl+Z' },
            { icon: 'redo', name: '重做', keys: 'Ctrl+Shift+Z' },
        ],
    },
    {
        id: 'time',
        title: '时间',
        icon: 'timer',
        items: [
            { icon: 'play', name: '播放 / 暂停', keys: '空格' },
            { icon: 'step-back', name: '回到开头', keys: 'Home' },
            { icon: 'step-forward', name: '跳到结尾', keys: 'End' },
            { icon: 'chevron-left', name: '上一个画格', keys: 'Shift+,' },
            { icon: 'chevron-right', name: '下一个画格', keys: 'Shift+.' },
            { icon: 'chevron-right', name: '逐帧微调（1/fps）', keys: '← / →' },
            { icon: 'grid', name: '时间轴缩放（以指针为锚）', keys: 'Ctrl+滚轮' },
        ],
    },
    {
        id: 'keyframe',
        title: '关键帧',
        icon: 'diamond',
        items: [
            { icon: 'chevron-left', name: '上一个关键帧', keys: ',' },
            { icon: 'chevron-right', name: '下一个关键帧', keys: '.' },
            { icon: 'magnet', name: '临时自由拖动（忽略磁铁）', keys: 'Shift+拖' },
            { icon: 'plus', name: '在曲线上加关键帧', keys: '双击空白处' },
            { icon: 'diamond-minus', name: '删除关键帧', keys: '右键菜单 / 双击菱形' },
            { icon: 'copy', name: '复制 / 粘贴关键帧', keys: 'Ctrl+C / Ctrl+V', hint: '时间轴里选中的那些' },
        ],
    },
    {
        id: 'draw',
        title: '画板',
        icon: 'brush',
        items: [
            { icon: 'select', name: '选择工具', keys: 'V' },
            { icon: 'brush', name: '画笔', keys: 'B' },
            { icon: 'eraser', name: '橡皮', keys: 'E' },
            { icon: 'bucket', name: '填充', keys: 'G', hint: '同色连通区一次填满（容差 24）；导入的位图纹理不支持' },
            { icon: 'eyedropper', name: '取色器', keys: 'I' },
            { icon: 'eyedropper', name: '直接取色（按住拖可连续取）', keys: '右键 / Alt+左键' },
            { icon: 'move', name: '平移画布', keys: 'H' },
            { icon: 'minus', name: '笔尖变小 / 变大', keys: '[ / ]' },
            { icon: 'center', name: '适配画布', keys: '0' },
            { icon: 'magnet', name: '稳定器档位（0–5，越高越稳）', keys: '工具条右端', hint: '画板里 Ctrl+滚轮 也能调档' },
        ],
    },
    {
        id: 'view',
        title: '视图',
        icon: 'columns',
        items: [
            { icon: 'columns', name: '交换两个区域', keys: '拖区域标题' },
            { icon: 'columns', name: '调整区域比例', keys: '拖分隔条' },
            { icon: 'rotate-ccw', name: '复位比例', keys: '双击分隔条' },
            { icon: 'help', name: '快捷键一览', keys: '?' },
            { icon: 'search', name: '命令面板（所有命令，可搜）', keys: 'Ctrl+Shift+P' },
            { icon: 'chevron-down', name: '面板里换行（命令面板 / 项目库）', keys: '↑ / ↓' },
            { icon: 'trash', name: '删除选中对象', keys: 'Delete', hint: '两段式确认，Backspace 不接' },
            { icon: 'x', name: '关闭浮层 / 取消当前操作', keys: 'Esc', hint: '在画板或设置里 = 回编排' },
        ],
    },
];

/**
 * 画格 vs 关键帧的图例。
 * mark 是时间轴上那两种形状的字形占位（方块 / 菱形），kind 决定配色（.is-cel / .is-kf）。
 */
export const LEGEND_ITEMS = [
    {
        kind: 'cel',
        mark: '■',
        icon: 'timer',
        name: '画格',
        text: '从这一秒起换成这张图，直到下一个画格；格与格之间不插值。',
    },
    {
        kind: 'kf',
        mark: '◆',
        icon: 'diamond',
        name: '关键帧',
        text: '位移 / 缩放 / 旋转 / 不透明度在这里连续插值，与相邻关键帧平滑过渡。',
    },
];

/** 曲线区怎么用（纯操作说明，不涉及键位） */
export const CURVE_TIPS = [
    ['点关键帧', '选中它，出现切线柄。Shift 点可多选，空白处拖出框选。'],
    ['拖圆点', '上下改数值、左右改时间。按住 Shift 吸附画格切换点。'],
    ['拖手柄', '改缓动曲线——决定加速还是减速。'],
    ['双击空白', '在该时刻加一个关键帧。'],
    ['右键', '线性 / 贝塞尔 / 保持 / 删除关键帧。'],
];

/**
 * 把 SHORTCUT_GROUPS 映射成快捷键浮层（`app/shell/shortcuts-overlay.mjs`）吃的 spec：
 * `{ groups: [{ title, items: [{ keys, title, hint }] }] }`。
 *
 * 浮层是「键位 + 动作名」的紧凑列表（不带图标），所以这里丢掉 icon、把 name 换成 title。
 * 数据仍然只有 SHORTCUT_GROUPS 一份 —— `?` 浮层、设置里的键位行、帮助面板三处逐条对得上。
 */
export function overlayGroups(groups = SHORTCUT_GROUPS) {
    return groups.map((g) => ({
        title: g.title,
        items: g.items.map((it) => ({
            keys: it.keys || '鼠标',
            title: it.name,
            hint: it.hint || '',
        })),
    }));
}

/* ─────────────────────────── 渲染 ─────────────────────────── */

function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
}

/**
 * 一行「(可选图标) + kbd + 说明」，沿用既有的 .hlp-item / .hlp-key / .hlp-desc 结构。
 * 图标只在键位表里出现：概念段没有动作可对应，硬塞一个反而像噪声。
 */
function row(iconName, keyText, descText) {
    const item = el('div', 'hlp-item');
    if (iconName) {
        const ic = el('span', 'hlp-ico');
        ic.innerHTML = icon(iconName, { size: 'sm' });
        item.appendChild(ic);
    }
    item.append(el('kbd', 'hlp-key', keyText), el('span', 'hlp-desc', descText));
    return item;
}

export function mount(el_, ctx) {
    const root = el('div', 'hlp');

    for (const sec of CONCEPT_ITEMS) {
        root.appendChild(el('div', 'hlp-title', sec.title));
        const list = el('div', 'hlp-list');
        for (const [name, desc] of sec.rows) list.appendChild(row(null, name, desc));
        root.appendChild(list);
    }

    // 键位表：与设置工作区的「偏好 → 文件/时间/…」同源同形（图标 + 动作名 + 键位）
    for (const group of SHORTCUT_GROUPS) {
        root.appendChild(el('div', 'hlp-title', group.title));
        const list = el('div', 'hlp-list');
        for (const item of group.items) {
            const r = row(item.icon, item.keys || '鼠标', item.name);
            if (item.hint) r.title = item.hint;
            list.appendChild(r);
        }
        root.appendChild(list);
    }

    root.appendChild(el('div', 'hlp-title', '曲线区怎么用'));
    const tips = el('div', 'hlp-list');
    for (const [name, desc] of CURVE_TIPS) tips.appendChild(row(null, name, desc));
    root.appendChild(tips);

    el_.appendChild(root);

    return {
        refresh() {},
        destroy() {
            root.remove();
        },
    };
}
