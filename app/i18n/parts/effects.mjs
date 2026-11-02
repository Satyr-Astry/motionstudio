/**
 * 效果与类型名的词条（`app/paint/effects.mjs` 的五类效果 + `app/editors/prop-object.mjs` 的效果区）。
 *
 * 键按「定义 → 参数 → 界面」三层分：
 *   `effect.<type>.name`            一类效果的显示名（type 即存档里的 type）
 *   `effect.<type>.param.<paramKey>` 该参数滑杆的标签（paramKey 即存档里同名的标量字段）
 *   `effect.ui.*`                   效果区的界面文案（空态、加/删按钮、打帧提示）
 *   `kind.<kind>`                   对象种类的显示名（kind 是存档值 'paint' / 'image' / 'bone'）
 *
 * 键由 `paint/effects.mjs` 的 freezeDef 从 id + 参数名派生，不在这里反推 —— 派生保证
 * 「键里写的是什么，存档里存的就是什么」，改 type 或参数名时两边不会悄悄错开。
 *
 * 这里只放**显示名**。`type`、参数名、`kind` 都是原样写进 .msp 的落盘值，一个字符都不动；
 * 效果定义表里也不再留任何中文（译文只有这一份），所以 `t()` 在效果区**没有第二参回退**——
 * 键是否在两种语言里都齐，由 `tests/i18n-parts-effects.test.mjs` 逐条断言，比运行期回退更早失败。
 *
 * 注：叠放面板另有一份 `layers.kind.*`（同义的 'paint' / 'image'）。两处键分属不同分片的
 * 写域，语义重复但不会撞键；要合并成一处时得同时动两个面板，别只删一边。
 */
export default {
    en: {
        // 效果：五类的显示名（值仍是 type）
        'effect.adjust.name': 'Adjust',
        'effect.blur.name': 'Blur',
        'effect.glow.name': 'Glow',
        'effect.outline.name': 'Outline',
        'effect.shadow.name': 'Drop shadow',

        // 效果：参数滑杆的标签（值仍是同名标量字段）
        'effect.adjust.param.brightness': 'Brightness',
        'effect.adjust.param.contrast': 'Contrast',
        'effect.adjust.param.hue': 'Hue',
        'effect.adjust.param.saturate': 'Saturation',
        'effect.blur.param.amount': 'Radius',
        'effect.glow.param.amount': 'Intensity',
        'effect.glow.param.color': 'Color',
        'effect.outline.param.amount': 'Width',
        'effect.outline.param.color': 'Color',
        'effect.shadow.param.amount': 'Radius',
        'effect.shadow.param.color': 'Color',
        'effect.shadow.param.dx': 'Offset X',
        'effect.shadow.param.dy': 'Offset Y',

        // 效果区界面文案
        'effect.ui.add': 'Add {name} to the selected object',
        'effect.ui.clearHint': 'This parameter already has keys — click to clear them (the current value is kept)',
        'effect.ui.clearLabel': 'Clear the keys on this parameter',
        'effect.ui.empty': 'No effects on this object yet',
        'effect.ui.keyHint': 'Key this parameter at the current time; after that each drag edits that key',
        'effect.ui.keyLabel': 'Key this parameter',
        'effect.ui.noObject': 'No object to edit',
        'effect.ui.remove': 'Remove {name}',

        // 对象种类（值仍是 kind）
        'kind.bone': 'Bone',
        'kind.image': 'Image',
        'kind.paint': 'Paint',
    },
    'zh-Hans': {
        'effect.adjust.name': '调整',
        'effect.blur.name': '模糊',
        'effect.glow.name': '外发光',
        'effect.outline.name': '描边',
        'effect.shadow.name': '投影',

        'effect.adjust.param.brightness': '亮度',
        'effect.adjust.param.contrast': '对比度',
        'effect.adjust.param.hue': '色相',
        'effect.adjust.param.saturate': '饱和度',
        'effect.blur.param.amount': '模糊半径',
        'effect.glow.param.amount': '发光强度',
        'effect.glow.param.color': '颜色',
        'effect.outline.param.amount': '描边宽度',
        'effect.outline.param.color': '颜色',
        'effect.shadow.param.amount': '模糊半径',
        'effect.shadow.param.color': '颜色',
        'effect.shadow.param.dx': 'X 偏移',
        'effect.shadow.param.dy': 'Y 偏移',

        'effect.ui.add': '给当前对象加一个{name}',
        'effect.ui.clearHint': '这个参数已有关键帧 —— 点击清除（保留当前值）',
        'effect.ui.clearLabel': '清除该参数的关键帧',
        'effect.ui.empty': '该对象还没有效果',
        'effect.ui.keyHint': '在当前时间给这个参数打关键帧；之后拖滑杆就是逐帧改',
        'effect.ui.keyLabel': '在该参数上打关键帧',
        'effect.ui.noObject': '没有可编辑的对象',
        'effect.ui.remove': '移除{name}',

        'kind.bone': '骨骼',
        'kind.image': '图片',
        'kind.paint': '手绘',
    },
};
