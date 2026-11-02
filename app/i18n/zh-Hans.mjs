/**
 * 简体中文词条。
 *
 * 与 `en.mjs` 是**一对一**的镜面：键集合必须完全一致，`_check-i18n.mjs` 会报差异。
 * 缺条目时 `t()` 会回退到调用点写在代码里的原文（`t(key, fallback)`），所以漏翻
 * 不会变成空白界面 —— 但它仍然是一条未完成的活，检查器会挡住。
 */
export default {
    'app.title': 'MotionStudio',

    'locale.en': 'English',
    'locale.zhHans': '简体中文',

    'pref.language': '语言',
    'pref.language.row': '界面语言',
    'pref.language.hint': '立即生效，不影响项目数据。',

    'editor.canvas.title': '画布',
    'editor.canvas.hint': '绘制、缩放、平移',

    'editor.board.title': '画板',
    'editor.board.hint': '只编辑当前这一张纹理（与编排分离）',

    'editor.toolbar.title': '工具',
    'editor.toolbar.hint': '画笔 / 笔尖 / 撤销',

    'editor.tree.title': '父子',
    'editor.tree.hint': '父子关系（跟谁动）',

    'editor.layers.title': '叠放',
    'editor.layers.hint': '叠放顺序（谁盖谁）',

    'editor.timeline.title': '时间轴',
    'editor.timeline.hint': '关键帧、时长与播放',

    'editor.curve.title': '曲线',
    'editor.curve.hint': '对象变换的连续曲线与贝塞尔切线',

    'editor.palette.title': '调色',
    'editor.palette.hint': '色相、明度与最近颜色',

    'editor.properties.title': '属性',
    'editor.properties.hint': '文档、纹理与变换参数',

    'editor.doc.title': '文档',
    'editor.doc.hint': '画布尺寸、帧率与循环',

    'editor.onion.title': '洋葱皮',
    'editor.onion.hint': '前后纹理的残影',

    'editor.info.title': '信息',
    'editor.info.hint': '对象 / 纹理 / 关键帧统计',

    'editor.prefs.title': '偏好',
    'editor.prefs.hint': '自动保存、撤销步数、吸附与画布底色',

    'editor.help.title': '帮助',
    'editor.help.hint': '快捷键一览',

    'editor.projects.title': '项目库',
    'editor.projects.hint': '已保存的项目：载入 / 新建 / 删除',
};
