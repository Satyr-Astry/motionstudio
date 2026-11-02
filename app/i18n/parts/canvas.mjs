/**
 * 画布指针交互的词条（`app/editors/canvas-input.mjs`）。
 *
 * 这一片放的是**画布上直接操作对象**时冒出来的提示与撤销标签：网格软拖、锚点拖动、
 * 一次整体变换。它们不是哪个面板的文案，所以单独一片，不要塞进 `props` / `shell`。
 *
 * 为什么撤销标签也要走词条：撤销栈里的 `label` 会显示在顶栏的撤销提示里，
 * 那是用户能看到的文字，不是内部标识。
 */
export default {
    en: {
        'canvas.lattice.label': 'Lattice deform',
        'canvas.lattice.moved': 'Lattice deform: {n} vertices affected',
        'canvas.lattice.done': 'Mesh deformed',
        'canvas.lattice.noChange': 'This drag did not change the mesh',
        'canvas.canceled': 'Canceled',
        'canvas.anchor.done': 'Rotation origin moved',
        'canvas.transform.label': 'Transform',
        'canvas.transform.done': 'Keyframe updated',
    },
    'zh-Hans': {
        'canvas.lattice.label': '格点变形',
        'canvas.lattice.moved': '格点变形：影响 {n} 个顶点',
        'canvas.lattice.done': '已变形网格',
        'canvas.lattice.noChange': '这次拖动没有改变网格',
        'canvas.canceled': '已取消',
        'canvas.anchor.done': '已移动旋转原点',
        'canvas.transform.label': '变换',
        'canvas.transform.done': '已更新关键帧',
    },
};
