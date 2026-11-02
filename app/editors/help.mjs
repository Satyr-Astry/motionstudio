/**
 * MotionStudio —— 帮助数据（键位表 / 图例）的唯一权威源
 *
 * 为什么收在这一处：键位表是「给人看的文档」，但它必须和真正生效的按键分派
 * 保持同一份数据。以前这张表被抄了三份（时间轴 `?` 浮层、设置里的帮助分组、
 * 画板底部 hint），改一处另外两处就旧了 —— 用户看到的是「表里写了、按了没反应」。
 * 现在导出两个常量，谁要显示谁 import：
 *
 *   SHORTCUT_GROUPS  分组（文件 / 时间 / 关键帧 / 画板 / 视图）× 条目
 *   LEGEND_ITEMS     纹理 vs 关键帧的图例（时间轴右侧「?」与设置共用）
 *
 * 条目形状：{ icon, name, keys, hint? }
 *   icon  app/core/icons.mjs 里的名字（拼错会被 tests/icons.test.mjs 抓住）
 *   keys  真实按键串，空串表示「没有快捷键，只有鼠标操作」
 *   hint  补充说明，可省
 *
 * 这份表也是「快捷键审计」的基准：tests/icons.test.mjs 会扫 app/shell/app.mjs 的
 * 实际按键分派，把「表里有、代码里没有」的条目列出来 —— 发现不一致就改这张表
 * 或补代码，但不许在这里写一条按不响的键。
 *
 * 文案为什么要写成 getter：本模块在启动时 import 一次就不再重求值，而切语言只换
 * 词条表、不重新加载模块（见 app/i18n/index.mjs 的 setLocale）。如果这里写成
 * `name: t('…', '原文')`，常量会被首次渲染时的语言冻住，切到另一种语言后仍然吐旧文案。
 * 用 `get name()` 让**每次读取都查一遍表**，就自然跟上了——面板重挂（remountAll）
 * 时重读一遍即得新语言，而下游（prop-prefs.mjs / timeline-paint.mjs / 快捷键浮层）
 * 直接读 `item.name` 的写法一个字都不用改，拿到的仍然是字符串。
 * 第二参一律是中文原文：漏译时界面显示母语，而不是空白或 key。
 */

import { icon } from '../core/icons.mjs';
import { t } from '../i18n/index.mjs';

/** 概念说明：这部分不是键位，是「动画是怎么构成的」。 */
export const CONCEPT_ITEMS = [
    {
        get title() { return t('help.concept.title'); },
        rows: [
            {
                get name() { return t('help.concept.texture.name'); },
                get desc() { return t('help.concept.texture.desc'); },
            },
            {
                get name() { return t('help.concept.keyframe.name'); },
                get desc() { return t('help.concept.keyframe.desc'); },
            },
            {
                get name() { return t('help.concept.timeChannel.name'); },
                get desc() { return t('help.concept.timeChannel.desc'); },
            },
            {
                get name() { return t('help.concept.bone.name'); },
                get desc() { return t('help.concept.bone.desc'); },
            },
            {
                get name() { return t('help.concept.ik.name'); },
                get desc() { return t('help.concept.ik.desc'); },
            },
        ],
    },
];

/** 权威键位表。分组顺序 = 用户从「拿到文件」到「调视图」的操作顺序。 */
export const SHORTCUT_GROUPS = [
    {
        id: 'file',
        get title() { return t('help.shortcut.file.title'); },
        icon: 'save',
        items: [
            // 这两条刻意写全「项目库」三个字：Ctrl+S 在这里是入库，
            // 不是 Photoshop 那种「存成文件」—— 首版就是这点被误解。
            {
                icon: 'save',
                keys: 'Ctrl+S',
                get name() { return t('help.shortcut.file.saveToLibrary.name'); },
                get hint() { return t('help.shortcut.file.saveToLibrary.hint'); },
            },
            {
                icon: 'folder-open',
                keys: 'Ctrl+O',
                get name() { return t('help.shortcut.file.openLibrary.name'); },
                get hint() { return t('help.shortcut.file.openLibrary.hint'); },
            },
            // 行为说明（不是快捷键）：键位列写「自动」，免得被当成又一个组合键。
            {
                icon: 'save',
                get keys() { return t('help.shortcut.file.autoSaveOnLoad.keys'); },
                get name() { return t('help.shortcut.file.autoSaveOnLoad.name'); },
                get hint() { return t('help.shortcut.file.autoSaveOnLoad.hint'); },
            },
            {
                icon: 'export',
                keys: 'Ctrl+Shift+E',
                get name() { return t('help.shortcut.file.exportFrames.name'); },
                get hint() { return t('help.shortcut.file.exportFrames.hint'); },
            },
            { icon: 'undo', keys: 'Ctrl+Z', get name() { return t('help.shortcut.file.undo.name'); } },
            { icon: 'redo', keys: 'Ctrl+Shift+Z', get name() { return t('help.shortcut.file.redo.name'); } },
        ],
    },
    {
        id: 'time',
        get title() { return t('help.shortcut.time.title'); },
        icon: 'timer',
        items: [
            {
                icon: 'play',
                get keys() { return t('help.shortcut.time.togglePlay.keys'); },
                get name() { return t('help.shortcut.time.togglePlay.name'); },
            },
            { icon: 'step-back', keys: 'Home', get name() { return t('help.shortcut.time.goStart.name'); } },
            { icon: 'step-forward', keys: 'End', get name() { return t('help.shortcut.time.goEnd.name'); } },
            { icon: 'chevron-left', keys: 'Shift+,', get name() { return t('help.shortcut.time.prevTexture.name'); } },
            { icon: 'chevron-right', keys: 'Shift+.', get name() { return t('help.shortcut.time.nextTexture.name'); } },
            { icon: 'chevron-right', keys: '← / →', get name() { return t('help.shortcut.time.nudgeFrame.name'); } },
            {
                icon: 'grid',
                get keys() { return t('help.shortcut.time.zoomTimeline.keys'); },
                get name() { return t('help.shortcut.time.zoomTimeline.name'); },
            },
            {
                icon: 'grid',
                get keys() { return t('help.shortcut.time.scrollTimeline.keys'); },
                get name() { return t('help.shortcut.time.scrollTimeline.name'); },
            },
        ],
    },
    {
        id: 'keyframe',
        get title() { return t('help.shortcut.keyframe.title'); },
        icon: 'diamond',
        items: [
            { icon: 'chevron-left', keys: ',', get name() { return t('help.shortcut.keyframe.prevKey.name'); } },
            { icon: 'chevron-right', keys: '.', get name() { return t('help.shortcut.keyframe.nextKey.name'); } },
            {
                icon: 'magnet',
                get keys() { return t('help.shortcut.keyframe.freeDrag.keys'); },
                get name() { return t('help.shortcut.keyframe.freeDrag.name'); },
            },
            {
                icon: 'plus',
                get keys() { return t('help.shortcut.keyframe.addOnCurve.keys'); },
                get name() { return t('help.shortcut.keyframe.addOnCurve.name'); },
            },
            {
                icon: 'diamond-minus',
                get keys() { return t('help.shortcut.keyframe.deleteKey.keys'); },
                get name() { return t('help.shortcut.keyframe.deleteKey.name'); },
            },
            {
                icon: 'copy',
                keys: 'Ctrl+C / Ctrl+V',
                get name() { return t('help.shortcut.keyframe.copyPaste.name'); },
                get hint() { return t('help.shortcut.keyframe.copyPaste.hint'); },
            },
        ],
    },
    // L4 层级键：作用对象是「对象面板的层级结构」，语境与画布工具键、时间轴键都不同，
    // 所以单独成组 —— 上轮「E 键同时写着橡皮和取色器」的教训：不同语境挤进一组就会自相矛盾。
    //
    // 计算侧已落地：app/core/layer-order.mjs 的 layerKeyFromEvent / layerKeyTarget
    // （纯函数，tests/layers-keys.test.mjs 覆盖：兄弟换位、升级/降级目标、首兄弟/根对象不动作）。
    // 接线侧（app.mjs 的 installLayerKeys 用 resolveMove → ctx.moveSubtree：一次 setDoc、一条撤销；
    // 叠放顺序那一路是 ctx.moveDrawOrder，与这里的方向键无关）
    // 由 Lead 在图层线合并时完成；接线前这两个键位不生效。
    {
        id: 'layer',
        get title() { return t('help.shortcut.layer.title'); },
        icon: 'rows',
        items: [
            {
                icon: 'rows',
                keys: 'Alt+↑ / Alt+↓',
                get name() { return t('help.shortcut.layer.siblingMove.name'); },
                get hint() { return t('help.shortcut.layer.siblingMove.hint'); },
            },
            {
                icon: 'chevron-right',
                keys: 'Alt+← / Alt+→',
                get name() { return t('help.shortcut.layer.promoteDemote.name'); },
                get hint() { return t('help.shortcut.layer.promoteDemote.hint'); },
            },
        ],
    },
    // 下面两组是**两个不同的键位语境**，不能合并：
    //   编排画布 = app.mjs 的全局 keydown（`[`/`]` 1078-1087、`0` 1088-1094、工具键 1095-1101）
    //              → TOOL_KEYS（shell/doc-state.mjs:80）→ engine.setTool，工具名来自 paint/engine.mjs:27-32 的 TOOLS；
    //   画板工作区 = board.mjs 自己的捕获阶段 keydown（1320-1345），画板在捕获阶段先吃掉同名的键。
    // 冲突实例：E 在编排是橡皮（engine.mjs:29），在画板是取色器（board.mjs:1331）。
    // 以前两组挤在一组，表里就同时写着「橡皮 E」和「E 取色器」，自相矛盾。
    {
        id: 'canvas',
        get title() { return t('help.shortcut.canvas.title'); },
        icon: 'center',
        items: [
            { icon: 'select', keys: 'V', get name() { return t('help.shortcut.canvas.selectTool.name'); } },
            { icon: 'brush', keys: 'B', get name() { return t('help.shortcut.canvas.brush.name'); } },
            { icon: 'eraser', keys: 'E', get name() { return t('help.shortcut.canvas.eraser.name'); } },
            { icon: 'bucket', keys: 'G', get name() { return t('help.shortcut.canvas.fill.name'); } },
            { icon: 'eyedropper', keys: 'I', get name() { return t('help.shortcut.canvas.eyedropper.name'); } },
            { icon: 'move', keys: 'H', get name() { return t('help.shortcut.canvas.pan.name'); } },
            { icon: 'minus', keys: '[ / ]', get name() { return t('help.shortcut.canvas.tipSize.name'); } },
            { icon: 'fit', keys: '0', get name() { return t('help.shortcut.canvas.fitView.name'); } },
        ],
    },
    {
        id: 'board',
        get title() { return t('help.shortcut.board.title'); },
        icon: 'brush',
        items: [
            {
                icon: 'brush',
                keys: '1 – 7',
                get name() { return t('help.shortcut.board.brushPreset.name'); },
                get hint() { return t('help.shortcut.board.brushPreset.hint'); },
            },
            {
                icon: 'eyedropper',
                keys: 'E',
                get name() { return t('help.shortcut.board.sampleColor.name'); },
            },
            {
                icon: 'eyedropper',
                get keys() { return t('help.shortcut.board.pickColor.keys'); },
                get name() { return t('help.shortcut.board.pickColor.name'); },
            },
            {
                icon: 'bucket',
                keys: 'G',
                get name() { return t('help.shortcut.board.fill.name'); },
                get hint() { return t('help.shortcut.board.fill.hint'); },
            },
            {
                icon: 'move',
                get keys() { return t('help.shortcut.board.panHold.keys'); },
                get name() { return t('help.shortcut.board.panHold.name'); },
            },
            { icon: 'minus', keys: '[ / ]', get name() { return t('help.shortcut.board.tipSize.name'); } },
            { icon: 'fit', keys: '0', get name() { return t('help.shortcut.board.fitCanvas.name'); } },
            {
                icon: 'magnet',
                get keys() { return t('help.shortcut.board.stabilizer.keys'); },
                get name() { return t('help.shortcut.board.stabilizer.name'); },
                get hint() { return t('help.shortcut.board.stabilizer.hint'); },
            },
        ],
    },
    {
        id: 'view',
        get title() { return t('help.shortcut.view.title'); },
        icon: 'columns',
        items: [
            {
                icon: 'columns',
                get keys() { return t('help.shortcut.view.swapAreas.keys'); },
                get name() { return t('help.shortcut.view.swapAreas.name'); },
            },
            {
                icon: 'columns',
                get keys() { return t('help.shortcut.view.resizeAreas.keys'); },
                get name() { return t('help.shortcut.view.resizeAreas.name'); },
            },
            {
                icon: 'rotate-ccw',
                get keys() { return t('help.shortcut.view.resetRatio.keys'); },
                get name() { return t('help.shortcut.view.resetRatio.name'); },
            },
            { icon: 'help', keys: '?', get name() { return t('help.shortcut.view.shortcutList.name'); } },
            {
                icon: 'search',
                keys: 'Ctrl+Shift+P',
                get name() { return t('help.shortcut.view.commandPalette.name'); },
            },
            {
                icon: 'chevron-down',
                keys: '↑ / ↓',
                get name() { return t('help.shortcut.view.moveInList.name'); },
            },
            {
                icon: 'trash',
                keys: 'Delete',
                get name() { return t('help.shortcut.view.deleteObject.name'); },
                get hint() { return t('help.shortcut.view.deleteObject.hint'); },
            },
            {
                icon: 'x',
                keys: 'Esc',
                get name() { return t('help.shortcut.view.closeOverlay.name'); },
                get hint() { return t('help.shortcut.view.closeOverlay.hint'); },
            },
        ],
    },
];

/**
 * 纹理 vs 关键帧的图例。
 * 两行都用菱形：v8 之后时间轴上只有菱形（.tline-kf），纹理的差别是菱形里多一个
 * 实心小方块（.has-drawing），空白纹理是空心小方块（.is-blank）。所以字形不再拿方块
 * 冒充一种形状——那会让人去泳道上找根本不存在的方块；区分交给配色（kind）与说明文字。
 * kind 决定配色（.is-cel / .is-kf），值是测试钉死的契约，不许改。
 */
export const LEGEND_ITEMS = [
    {
        kind: 'cel',
        mark: '◆',
        icon: 'timer',
        get name() { return t('help.legend.cel.name'); },
        get text() { return t('help.legend.cel.text'); },
    },
    {
        kind: 'kf',
        mark: '◆',
        icon: 'diamond',
        get name() { return t('help.legend.kf.name'); },
        get text() { return t('help.legend.kf.text'); },
    },
];

/** 曲线区怎么用（纯操作说明，不涉及键位） */
export const CURVE_TIPS = [
    {
        get name() { return t('help.curve.pickKey.name'); },
        get desc() { return t('help.curve.pickKey.desc'); },
    },
    {
        get name() { return t('help.curve.dragDot.name'); },
        get desc() { return t('help.curve.dragDot.desc'); },
    },
    {
        get name() { return t('help.curve.dragHandle.name'); },
        get desc() { return t('help.curve.dragHandle.desc'); },
    },
    {
        get name() { return t('help.curve.doubleClickBlank.name'); },
        get desc() { return t('help.curve.doubleClickBlank.desc'); },
    },
    {
        get name() { return t('help.curve.rightClick.name'); },
        get desc() { return t('help.curve.rightClick.desc'); },
    },
];

/**
 * 把 SHORTCUT_GROUPS 映射成快捷键浮层（`app/shell/shortcuts-overlay.mjs`）吃的 spec：
 * `{ groups: [{ title, items: [{ keys, title, hint }] }] }`。
 *
 * 浮层是「键位 + 动作名」的紧凑列表（不带图标），所以这里丢掉 icon、把 name 换成 title。
 * 数据仍然只有 SHORTCUT_GROUPS 一份 —— `?` 浮层、设置里的键位行、帮助面板三处逐条对得上。
 * 键位空串的条目统一显示「鼠标」：那几行本来就只有鼠标操作，留空会让人以为漏了快捷键。
 */
export function overlayGroups(groups = SHORTCUT_GROUPS) {
    return groups.map((g) => ({
        title: g.title,
        items: g.items.map((it) => ({
            keys: it.keys || t('help.shortcut.mouseOnly'),
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
        for (const r of sec.rows) list.appendChild(row(null, r.name, r.desc));
        root.appendChild(list);
    }

    // 键位表：与设置工作区的「偏好 → 文件/时间/…」同源同形（图标 + 动作名 + 键位）
    for (const group of SHORTCUT_GROUPS) {
        root.appendChild(el('div', 'hlp-title', group.title));
        const list = el('div', 'hlp-list');
        for (const item of group.items) {
            const r = row(item.icon, item.keys || t('help.shortcut.mouseOnly'), item.name);
            if (item.hint) r.title = item.hint;
            list.appendChild(r);
        }
        root.appendChild(list);
    }

    root.appendChild(el('div', 'hlp-title', t('help.curve.title')));
    const tips = el('div', 'hlp-list');
    for (const tip of CURVE_TIPS) tips.appendChild(row(null, tip.name, tip.desc));
    root.appendChild(tips);

    el_.appendChild(root);

    return {
        refresh() {},
        destroy() {
            root.remove();
        },
    };
}
