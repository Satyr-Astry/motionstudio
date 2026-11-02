/**
 * 命令面板（Ctrl+Shift+P）与命令名的词条。
 *
 * 键：`cmd.<命令 id>` —— 命令 id 就是 `app.mjs` 里 `buildCommands()` 的 id，
 * 已经稳定且被图标表 / 快捷键表 / 测试引用，所以键直接复用它，不另起一套编号。
 * **id 带连字符时折成驼峰**：词典键只认字母数字与点（`tests/i18n.test.mjs` 的键守卫），
 * 例如 `play.prev-cel` → `cmd.play.prevCel`、`file.export-frames` → `cmd.file.exportFrames`。
 * 映射由 `tests/i18n-parts-commands.test.mjs` 双向核对：id 增删或键改名都会红。
 *
 * 辅助键：
 *   `cmd.<命令 id>.hint`  命令的补充说明（第二行灰字）
 *   `cmd.group.<分组 id>`  分组标题（文件 / 编辑 / 播放 / 纹理 / 画布 / 工作区 / 界面 / 工具）
 *   `palette.*`           面板自身的文案（占位符 / 页脚 / 空态 / aria）
 *
 * 注意 `palette.*` 指**命令面板**（`app/shell/command-palette.mjs`），
 * 不是调色板那个编辑面板（它的键走 `editor.palette.*`）。
 *
 * 原文（中文）留在调用点作 `t(key, '原文')` 的第二参：漏翻时界面显示中文，不是空白或键名。
 */
export default {
    en: {
        // ── 命令名 ──────────────────────────────────────────────
        'cmd.file.save': 'Save project',
        'cmd.file.open': 'Open project library',
        'cmd.file.exportFrames': 'Export frame sequence…',
        'cmd.file.exportCurrent': 'Export current frame…',
        'cmd.file.exportClip': 'Copy current frame to clipboard',
        'cmd.file.exportSheet': 'Export sprite sheet…',
        'cmd.file.exportVideo': 'Export WebM video',
        'cmd.file.exportBones': 'Export bone animation JSON',
        'cmd.file.exportBones.hint': 'Every bone, every frame: world matrices (incl. parent-chain time and IK) as one JSON an engine can play; does not change the .msp format',

        'cmd.edit.undo': 'Undo',
        'cmd.edit.redo': 'Redo',
        'cmd.edit.copyKeys': 'Copy keyframes',
        'cmd.edit.pasteKeys': 'Paste keyframes',

        'cmd.play.toggle': 'Play / Pause',
        'cmd.play.first': 'Jump to start',
        'cmd.play.last': 'Jump to end',
        'cmd.play.prevCel': 'Previous texture',
        'cmd.play.nextCel': 'Next texture',
        'cmd.play.prevKey': 'Previous keyframe',
        'cmd.play.nextKey': 'Next keyframe',

        'cmd.cel.new': 'New texture (library only)',
        'cmd.cel.add': 'Add exposure',
        'cmd.cel.remove': 'Delete texture',
        'cmd.cel.cyclePrev': 'Switch texture: previous',
        'cmd.cel.cycleNext': 'Switch texture: next',
        'cmd.cel.unique': 'Make texture unique',

        // 对象
        'cmd.object.addBone': 'Add bone',
        'cmd.object.boneFromObject': 'Create bone from selected object',
        'cmd.object.boneFromObject.hint': "Creates a bone in the same layer, matched to the selected object's position, rotation, scale and width (one undo step)",
        'cmd.object.bindSkin': 'Bind to selected bones',
        'cmd.object.unbindSkin': 'Unbind skin',

        'cmd.canvas.fit': 'Fit view',
        'cmd.canvas.brushSmaller': 'Smaller brush',
        'cmd.canvas.brushBigger': 'Bigger brush',

        'cmd.ws.animate': 'Switch to Animate',
        'cmd.ws.draw': 'Switch to Draw',
        'cmd.ws.free': 'Switch to Settings',

        'cmd.ui.shortcuts': 'Keyboard shortcuts',

        'cmd.tool.select': 'Select',
        'cmd.tool.brush': 'Brush',
        'cmd.tool.eraser': 'Eraser',
        'cmd.tool.bucket': 'Fill',
        'cmd.tool.picker': 'Colour picker',
        'cmd.tool.pan': 'Pan',

        // ── 命令说明（hint） ─────────────────────────────────────
        'cmd.file.save.hint': 'Write to the current save',
        'cmd.file.open.hint': 'Recent projects / New / Import',
        'cmd.file.exportFrames.hint': 'PNG sequence + frame manifest (range, scale, format)',
        'cmd.file.exportCurrent.hint': 'A single PNG at the current time',
        'cmd.file.exportClip.hint': 'Paste straight into a chat or drawing app',
        'cmd.file.exportSheet.hint': 'Atlas PNG + per-frame coordinate JSON (cap, trim, engine format)',
        'cmd.file.exportVideo.hint': 'Records the whole duration at the current frame rate',

        'cmd.edit.copyKeys.hint': 'The ones selected in the timeline',
        'cmd.edit.pasteKeys.hint': 'Paste at the current time',

        'cmd.play.toggle.hint': 'Timeline playhead',
        'cmd.play.last.hint': 'End of the document',
        'cmd.play.prevKey.hint': 'Current object',
        'cmd.play.nextKey.hint': 'Current object',

        'cmd.cel.new.hint': 'Makes a new image without taking any timeline space; light it up in the library to place it',
        'cmd.cel.add.hint': 'Exposes the current texture again at the playhead (no new image)',
        'cmd.cel.remove.hint': 'Texture at the playhead',
        'cmd.cel.cyclePrev.hint': 'Puts the previous library texture at the current time (reused, adds no time)',
        'cmd.cel.cycleNext.hint': 'Puts the next library texture at the current time (reused, adds no time)',
        'cmd.cel.unique.hint': 'Detaches the texture at the current time into its own image',

        'cmd.object.addBone.hint': 'Creates a bone object in the same layer as the selection; drag it on the canvas after switching to the bone tool',
        'cmd.object.bindSkin.hint': 'Binds the current object to the selected bones (4×4 grid, automatic weights) in one undo step',
        'cmd.object.unbindSkin.hint': 'Removes the skin from the current object; the bones are kept',

        'cmd.canvas.fit.hint': 'Fill the viewport with the canvas',
        'cmd.canvas.brushSmaller.hint': '−4px each time',
        'cmd.canvas.brushBigger.hint': '+4px each time',

        'cmd.ui.shortcuts.hint': 'Lists every key',

        // ── 分组标题 ────────────────────────────────────────────
        'cmd.group.file': 'File',
        'cmd.group.edit': 'Edit',
        'cmd.group.play': 'Playback',
        'cmd.group.cel': 'Texture',
        'cmd.group.canvas': 'Canvas',
        'cmd.group.workspace': 'Workspace',
        'cmd.group.ui': 'Interface',
        'cmd.group.tool': 'Tools',

        // ── 命令面板本身 ────────────────────────────────────────
        'palette.aria.panel': 'Command palette',
        'palette.aria.input': 'Search commands',
        'palette.aria.list': 'Command list',
        'palette.placeholder': 'Type a command name…',
        'palette.foot': '↑↓ navigate · Enter run · Esc close',
        'palette.empty': 'No matching commands',
        'palette.ungrouped': 'Other',
        'palette.more': '{n} more…',
    },
    'zh-Hans': {
        // ── 命令名 ──────────────────────────────────────────────
        'cmd.file.save': '保存项目',
        'cmd.file.open': '打开项目库',
        'cmd.file.exportFrames': '导出帧序列…',
        'cmd.file.exportCurrent': '导出当前帧…',
        'cmd.file.exportClip': '复制当前帧到剪贴板',
        'cmd.file.exportSheet': '导出精灵图…',
        'cmd.file.exportVideo': '导出 WebM 视频',
        'cmd.file.exportBones': '导出骨骼动画 JSON',
        'cmd.file.exportBones.hint': '每根骨每帧的世界矩阵（含父链时间与 IK 解算）打包成一个引擎能播的 JSON；不改 .msp 格式',

        'cmd.edit.undo': '撤销',
        'cmd.edit.redo': '重做',
        'cmd.edit.copyKeys': '复制关键帧',
        'cmd.edit.pasteKeys': '粘贴关键帧',

        'cmd.play.toggle': '播放 / 暂停',
        'cmd.play.first': '回到开头',
        'cmd.play.last': '跳到结尾',
        'cmd.play.prevCel': '上一个纹理',
        'cmd.play.nextCel': '下一个纹理',
        'cmd.play.prevKey': '上一个关键帧',
        'cmd.play.nextKey': '下一个关键帧',

        'cmd.cel.new': '新建纹理（只进库）',
        'cmd.cel.add': '加曝光',
        'cmd.cel.remove': '删纹理',
        'cmd.cel.cyclePrev': '切换纹理：上一张',
        'cmd.cel.cycleNext': '切换纹理：下一张',
        'cmd.cel.unique': '纹理独特化',

        // 对象
        'cmd.object.addBone': '新建骨骼',
        'cmd.object.boneFromObject': '从选中对象建骨骼',
        'cmd.object.boneFromObject.hint': '在选中对象同层建一根骨骼，位置/旋转/缩放与对象对齐、长度等于对象宽度（一步撤销）',
        'cmd.object.bindSkin': '绑定到选中骨骼',
        'cmd.object.unbindSkin': '解除蒙皮绑定',

        'cmd.canvas.fit': '适配视图',
        'cmd.canvas.brushSmaller': '笔刷变小',
        'cmd.canvas.brushBigger': '笔刷变大',

        'cmd.ws.animate': '切到编排',
        'cmd.ws.draw': '切到画板',
        'cmd.ws.free': '切到设置',

        'cmd.ui.shortcuts': '快捷键一览',

        'cmd.tool.select': '选择',
        'cmd.tool.brush': '画笔',
        'cmd.tool.eraser': '橡皮',
        'cmd.tool.bucket': '填充',
        'cmd.tool.picker': '取色',
        'cmd.tool.pan': '平移',

        // ── 命令说明（hint） ─────────────────────────────────────
        'cmd.file.save.hint': '写入当前存档',
        'cmd.file.open.hint': '最近项目 / 新建 / 导入',
        'cmd.file.exportFrames.hint': 'PNG 序列 + 帧清单（可设范围/缩放/格式）',
        'cmd.file.exportCurrent.hint': '当前时刻的一张 PNG',
        'cmd.file.exportClip.hint': '直接粘贴到聊天或绘图软件',
        'cmd.file.exportSheet.hint': '图集 PNG + 每帧坐标 JSON（可设上限/裁剪/引擎格式）',
        'cmd.file.exportVideo.hint': '按当前帧率录制整段时长',

        'cmd.edit.copyKeys.hint': '时间轴里选中的那些',
        'cmd.edit.pasteKeys.hint': '粘到当前时间',

        'cmd.play.toggle.hint': '时间轴走带',
        'cmd.play.last.hint': '文档末端',
        'cmd.play.prevKey.hint': '当前对象',
        'cmd.play.nextKey.hint': '当前对象',

        'cmd.cel.new.hint': '生成一张新图，不占时间轴；点亮库里那一行才放到时间轴',
        'cmd.cel.add.hint': '在播放头处再曝光一次当前纹理（不新建图）',
        'cmd.cel.remove.hint': '播放头所在纹理',
        'cmd.cel.cyclePrev.hint': '把库里上一张纹理放到当前时刻（复用，不加时间）',
        'cmd.cel.cycleNext.hint': '把库里下一张纹理放到当前时刻（复用，不加时间）',
        'cmd.cel.unique.hint': '当前时刻的纹理脱钩成独立一张',

        'cmd.object.addBone.hint': '在选中对象同层新建一根骨骼；切到骨骼工具后可在画布上拖动',
        'cmd.object.bindSkin.hint': '把当前对象绑到选中的骨骼上（4×4 网格、自动权重），一步撤销',
        'cmd.object.unbindSkin.hint': '去掉当前对象的蒙皮；骨骼会保留',

        'cmd.canvas.fit.hint': '画布撑满可视区',
        'cmd.canvas.brushSmaller.hint': '每次 −4px',
        'cmd.canvas.brushBigger.hint': '每次 +4px',

        'cmd.ui.shortcuts.hint': '列出所有按键',

        // ── 分组标题 ────────────────────────────────────────────
        'cmd.group.file': '文件',
        'cmd.group.edit': '编辑',
        'cmd.group.play': '播放',
        'cmd.group.cel': '纹理',
        'cmd.group.canvas': '画布',
        'cmd.group.workspace': '工作区',
        'cmd.group.ui': '界面',
        'cmd.group.tool': '工具',

        // ── 命令面板本身 ────────────────────────────────────────
        'palette.aria.panel': '命令面板',
        'palette.aria.input': '搜索命令',
        'palette.aria.list': '命令列表',
        'palette.placeholder': '输入命令名称…',
        'palette.foot': '↑↓ 选择 · Enter 执行 · Esc 关闭',
        'palette.empty': '没有匹配的命令',
        'palette.ungrouped': '其他',
        'palette.more': '还有 {n} 项…',
    },
};
