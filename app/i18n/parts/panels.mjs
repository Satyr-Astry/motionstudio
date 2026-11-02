/**
 * 各属性面板的词条（叠放 / 文档 / 曲线 / 时间轴 / 属性 / 洋葱皮 / 预览播放）。
 *
 * 键按面板分域：`layers.*`、`doc.*`、`curve.*`、`timeline.*`、`props.*`、`onion.*`、`playback.*`。
 * 这一片是「单一数据源」类常量（`KIND_TEXT`、`LOOP_VALUE`、`STATE_LABELS`、`SECTIONS` 等），
 * 它们本来就集中在一处，抽词时不必碰面板逻辑。
 *
 * 这里只放**显示名**。`kind`、`doc.loopMode`、`doc.onion.mode`、时间通道的 `mode` 都是原样
 * 写进 .msp 的落盘值，一个字符都不动 —— 换语言只换用户看到的词，不换存档（由
 * `tests/i18n-parts-panels.test.mjs` 断言钉住）。
 */
export default {
    en: {
        // 叠放：对象种类的显示名（值仍是 'paint' / 'image'）
        'layers.kind.image': 'Image',
        'layers.kind.paint': 'Paint',

        // 叠放：时间通道浮层的模式显示名（值仍是 none / loop / pingpong / clamp）
        'layers.timeMode.clamp': 'Clamp',
        'layers.timeMode.loop': 'Loop',
        'layers.timeMode.none': 'Off',
        'layers.timeMode.pingpong': 'Ping-pong',

        // 文档：循环方式（值与 doc.loopMode 同值）
        'doc.loop.cycle': 'Loop',
        'doc.loop.none': 'Once',
        'doc.loop.pingpong': 'Ping-pong',
        'doc.loop.reverse': 'Reverse loop',

        // 曲线：网格四角（值仍是 tl / tr / br / bl）
        'curve.corner.bl': 'Bottom left',
        'curve.corner.br': 'Bottom right',
        'curve.corner.tl': 'Top left',
        'curve.corner.tr': 'Top right',

        // 曲线：标量通道的显示名（值与 transform 的通道名一致）
        'curve.channel.opacity': 'Opacity',
        'curve.channel.rotate': 'Rotate',
        'curve.channel.scaleX': 'Scale X',
        'curve.channel.scaleY': 'Scale Y',
        'curve.channel.skewX': 'Skew X',
        'curve.channel.skewY': 'Skew Y',
        'curve.channel.x': 'Position X',
        'curve.channel.y': 'Position Y',

        // 时间轴：关键帧摘要里的通道显示名
        'timeline.state.opacity': 'Opacity',
        'timeline.state.rotate': 'Rotate',
        'timeline.state.scaleX': 'Scale X',
        'timeline.state.scaleY': 'Scale Y',
        'timeline.state.skewX': 'Skew X',
        'timeline.state.skewY': 'Skew Y',
        'timeline.state.x': 'Move X',
        'timeline.state.y': 'Move Y',

        // 属性：两段的段标题（段 key 仍是 object / doc）
        'props.section.doc': 'Document',
        'props.section.object': 'Object',

        // 洋葱皮：着色模式（值是 doc.onion.mode）
        'onion.mode.dim': 'Dim',
        'onion.mode.tint': 'Tint',

        // 预览播放：四种方式的显示名与一句话说明（值是 doc.loopMode）
        'playback.mode.cycle.hint': 'Plays to the end, then continues from the start',
        'playback.mode.cycle.label': 'Loop',
        'playback.mode.none.hint': 'Stops at the end',
        'playback.mode.none.label': 'Once',
        'playback.mode.pingpong.hint': 'Runs to the end and comes back, back and forth',
        'playback.mode.pingpong.label': 'Ping-pong',
        'playback.mode.reverse.hint': 'Plays backwards from the end to the start, then jumps back',
        'playback.mode.reverse.label': 'Reverse loop',

        // 工具条：七件工具的显示名（`id` 才是落盘值）
        'tool.bone.name': 'Bone',
        'tool.bucket.name': 'Fill',
        'tool.brush.name': 'Brush',
        'tool.eraser.name': 'Eraser',
        // 图标按钮的可读名：拼成「名称 (快捷键)」，与词条化之前的原文一致
        'tool.label': '{name} ({key})',
        'tool.pan.name': 'Pan',
        'tool.picker.name': 'Eyedropper',
        'tool.select.name': 'Select',

        // 工具条：笔刷短名、滑杆标签、撤销 / 重做
        'tbar.brush.pencil': 'Pencil',
        'tbar.brush.pixel': 'Pixel',
        'tbar.brush.round': 'Round',
        'tbar.brush.soft': 'Soft',
        'tbar.opacity': 'Opacity',
        'tbar.redo': 'Redo (Ctrl+Shift+Z)',
        'tbar.size': 'Tip',
        'tbar.undo': 'Undo (Ctrl+Z)',

        // 笔刷预设的全名（`name` 是读时求值的 getter，落盘只用 `id`）
        'brush.eraser.name': 'Eraser',
        'brush.pencil.name': 'Pencil',
        'brush.pixel.name': 'Pixel brush',
        'brush.round.name': 'Round brush',
        'brush.scatter.name': 'Scatter',
        'brush.smudge.name': 'Smudge',
        'brush.soft.name': 'Soft brush',

        // 调色板：色块 / 十六进制 / 两支滑杆 / 最近色
        'color.current': 'Current colour',
        'color.hex': 'Hex colour',
        'color.hue': 'Hue',
        'color.hueTitle': 'Hue 0–359',
        'color.recent': 'Recent',
        'color.value': 'Brightness',
        'color.valueTitle': 'Brightness 0–100',

        // 叠放树：空态 / 折叠箭头 / 子对象计数 / 行 tooltip / 三条拖拽提示
        'tree.caret.collapse': 'Collapse this branch (Alt+click: collapse ancestors too)',
        'tree.caret.expand': 'Expand this branch (Alt+click: collapse ancestors too)',
        'tree.empty': 'No objects yet',
        'tree.kids': 'Contains {n} child objects (dragging this row moves the whole subtree)',
        'tree.moveFailed': 'Move failed',
        'tree.moveOne': 'Only one object can change parent at a time',
        'tree.moveUnsupported': 'This build cannot re-parent by dragging',
        'tree.row.top': '{name} · top level',
        'tree.row.withChain': '{name} · parent chain {chain}',

        // 画布 HUD：缩放四键 + 适配结果提示
        'chrome.alreadyFitted': 'The view is already fitted: the whole canvas is visible',
        'chrome.boneTool': 'Bone tool (K) — click to switch back to Select',
        'chrome.fit': 'Zoom to fit the whole view (0)',
        'chrome.fitLabel': 'Fit',
        'chrome.fitted': 'View fitted: the whole canvas fills the visible area',
        'chrome.zoomIn': 'Zoom in one step (Ctrl+wheel up)',
        'chrome.zoomOut': 'Zoom out one step (Ctrl+wheel down)',
        'chrome.zoomReset': 'Click to go back to 100%',
    },
    'zh-Hans': {
        'layers.kind.image': '图片',
        'layers.kind.paint': '手绘',

        'layers.timeMode.clamp': '夹取',
        'layers.timeMode.loop': '循环',
        'layers.timeMode.none': '无',
        'layers.timeMode.pingpong': '往返',

        'doc.loop.cycle': '循环',
        'doc.loop.none': '单次',
        'doc.loop.pingpong': '来回',
        'doc.loop.reverse': '反向循环',

        'curve.corner.bl': '左下',
        'curve.corner.br': '右下',
        'curve.corner.tl': '左上',
        'curve.corner.tr': '右上',

        'curve.channel.opacity': '不透明度',
        'curve.channel.rotate': '旋转',
        'curve.channel.scaleX': '缩放 X',
        'curve.channel.scaleY': '缩放 Y',
        'curve.channel.skewX': '斜切 X',
        'curve.channel.skewY': '斜切 Y',
        'curve.channel.x': '位置 X',
        'curve.channel.y': '位置 Y',

        'timeline.state.opacity': '不透明度',
        'timeline.state.rotate': '旋转',
        'timeline.state.scaleX': '缩放 X',
        'timeline.state.scaleY': '缩放 Y',
        'timeline.state.skewX': '斜切 X',
        'timeline.state.skewY': '斜切 Y',
        'timeline.state.x': '位移 X',
        'timeline.state.y': '位移 Y',

        'props.section.doc': '工程',
        'props.section.object': '对象',

        'onion.mode.dim': '淡化',
        'onion.mode.tint': '红绿着色',

        'playback.mode.cycle.hint': '播到末尾从头继续',
        'playback.mode.cycle.label': '循环',
        'playback.mode.none.hint': '播到末尾就停',
        'playback.mode.none.label': '单次',
        'playback.mode.pingpong.hint': '播到末尾倒着回来，往返不停',
        'playback.mode.pingpong.label': '来回',
        'playback.mode.reverse.hint': '从末尾倒着播到开头，再回到末尾',
        'playback.mode.reverse.label': '反向循环',

        'tool.bone.name': '骨骼',
        'tool.bucket.name': '填充',
        'tool.brush.name': '画笔',
        'tool.eraser.name': '橡皮',
        'tool.label': '{name} ({key})',
        'tool.pan.name': '平移',
        'tool.picker.name': '取色',
        'tool.select.name': '选择',

        'tbar.brush.pencil': '铅笔',
        'tbar.brush.pixel': '像素',
        'tbar.brush.round': '圆头',
        'tbar.brush.soft': '柔边',
        'tbar.opacity': '不透明',
        'tbar.redo': '重做 (Ctrl+Shift+Z)',
        'tbar.size': '笔尖',
        'tbar.undo': '撤销 (Ctrl+Z)',

        'brush.eraser.name': '橡皮',
        'brush.pencil.name': '铅笔',
        'brush.pixel.name': '像素笔',
        'brush.round.name': '圆笔',
        'brush.scatter.name': '散点',
        'brush.smudge.name': '晕染',
        'brush.soft.name': '软笔',

        'color.current': '当前颜色',
        'color.hex': '十六进制颜色',
        'color.hue': '色相',
        'color.hueTitle': '色相 0–359',
        'color.recent': '最近',
        'color.value': '明度',
        'color.valueTitle': '明度 0–100',

        'tree.caret.collapse': '收起这一支（Alt+点：连祖先一起合上）',
        'tree.caret.expand': '展开这一支（Alt+点：连祖先一起合上）',
        'tree.empty': '还没有对象',
        'tree.kids': '含 {n} 个子对象（拖动这一行会整棵子树一起移动）',
        'tree.moveFailed': '移动失败',
        'tree.moveOne': '父子关系一次只能改一个对象',
        'tree.moveUnsupported': '这个版本不支持拖动改父级',
        'tree.row.top': '{name} · 顶层',
        'tree.row.withChain': '{name} · 父链 {chain}',

        'chrome.alreadyFitted': '视图已经在适配位置：整幅画布都可见',
        'chrome.boneTool': '骨骼工具（K）—— 再点一下回到选择工具',
        'chrome.fit': '缩放到刚好铺满视图（0）',
        'chrome.fitLabel': '适配',
        'chrome.fitted': '已适配视图：整幅画布铺满可视区',
        'chrome.zoomIn': '放大一级（Ctrl+滚轮向上）',
        'chrome.zoomOut': '缩小一级（Ctrl+滚轮向下）',
        'chrome.zoomReset': '点按回到 100%',
    },
};
