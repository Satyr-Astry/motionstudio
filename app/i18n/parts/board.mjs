/**
 * 画板的词条（纹理像素编辑器）。
 *
 * 键前缀 `board.*`。注意这里的「画板」是**编辑当前对象当前时刻那张纹理**的像素编辑器，
 * 不是 `app/core/board.mjs` 那套「画板草图提交成对象」（那套没有生产入口，见
 * `docs/修复列表-v8.md` §1aa 第 195 条）。
 *
 * 范围：`app/editors/board.mjs`。
 *
 * 约定：
 * - **整句成条**。凡是运行时往里塞值的句子（`取色 #ff0000`、`填充 32 个像素`）一律写成
 *   带 `{占位符}` 的整句，不拆成「前缀 / 后缀」两条再拼 —— 词的顺序因语言而异，
 *   拼出来的句子在英语里必然错位。
 * - 不落盘。这里只有界面文案：工具 id、`data-*` 属性、`kind` 值一个都没进来。
 */
export default {
    en: {
        // ── 笔刷短名（工具条 chip 的可见文字，两字/一眼读得懂） ──
        'board.brush.short.pixel': 'Pixel',
        'board.brush.short.round': 'Round',
        'board.brush.short.soft': 'Soft',
        'board.brush.short.pencil': 'Pencil',
        'board.brush.short.smudge': 'Smudge',
        'board.brush.short.scatter': 'Scatter',
        'board.brush.short.eraser': 'Eraser',
        /** 笔刷 chip 的 title：全名 + 快捷键。`{name}` 来自 brush.mjs 的预设表。 */
        'board.brush.title': '{name} (shortcut {key})',

        // ── 镜像（下拉框只要短名，长解释在 title 里） ──
        'board.mirror.none': 'None',
        'board.mirror.x': 'Left-right',
        'board.mirror.y': 'Up-down',
        'board.mirror.both': 'Both',
        'board.mirror.title': 'Mirror drawing (front-end only, no data change)',

        // ── 四条滑杆的名称（PARAM_UI 的 label 列） ──
        'board.param.hardness': 'Hardness',
        'board.param.spacing': 'Spacing',
        'board.param.jitter': 'Jitter',
        'board.param.flow': 'Flow',
        'board.param.reset': 'Restored the default parameters of "{name}"',

        // ── 大小 / 不透明（常显的两项） ──
        'board.size.short': 'Size',
        'board.size.label': 'Brush size (px)',
        'board.size.fieldTitle': 'Brush size (px, [ / ] to adjust)',
        'board.size.widthLabel': 'Texture width (px)',
        'board.size.heightLabel': 'Texture height (px)',
        'board.size.cropTitle': 'Trim the texture to its content bounds (drop the transparent border)',
        'board.size.applyTitle': 'Resize the texture canvas to the current dimensions',
        'board.size.alignTitle': 'Where the old content sits on the new canvas when resizing',
        'board.size.notWired': 'The resize command is not wired up yet (available once W19 task-29 lands)',
        'board.size.noTexture': 'No texture at this moment: click "Texture" to create one first',
        'board.opacity.short': 'Opacity',
        'board.opacity.title': 'Brush opacity (%)',

        // ── 当前色块 ──
        'board.swatch.title': 'Current colour (click to open the palette)',
        'board.swatch.titleColor': 'Current colour {color} (click to open the palette)',

        // ── 取色器 ──
        'board.pick.name': 'Eyedropper',
        'board.pick.title': 'Eyedropper: click the canvas to sample one pixel (E) · right-click on the canvas to sample at any time',
        'board.pick.titleOn': 'Eyedropper on: click the canvas to sample (E to cancel) · right-click / Alt+click also samples temporarily',
        'board.pick.noTexture': 'No texture at this moment, nothing to sample',
        'board.pick.outside': 'Clicked outside the texture, nothing sampled',
        'board.pick.unreadable': 'This texture cannot be read right now, nothing sampled',
        'board.pick.transparent': 'That pixel is transparent, nothing sampled',
        'board.pick.ok': 'Sampled {color}',

        // ── 油漆桶 ──
        'board.bucket.name': 'Fill',
        'board.bucket.title': 'Fill: click the canvas to flood the connected area of the same colour (G)',
        'board.bucket.titleOn': 'Fill on: click the canvas to flood the connected area (G to cancel)',
        'board.bucket.imported': 'This build cannot convert imported bitmaps for filling — update the app',
        'board.bucket.unreadable': 'This texture cannot be read right now, so it cannot be filled',
        'board.bucket.outside': 'Clicked outside the texture, nothing filled',
        'board.bucket.filled': 'That area is already the current colour',
        'board.bucket.done': 'Filled {n} pixels',

        // ── 撤销 / 重做 / 稳定器 ──
        'board.undo.name': 'Undo',
        'board.undo.title': 'Undo (engine history)',
        'board.redo.name': 'Redo',
        'board.redo.title': 'Redo (engine history)',
        'board.stab.name': 'Stroke stabiliser level',
        'board.stab.titleOff': 'Stroke stabiliser: off (0) (click to cycle 0-5, Ctrl+wheel also works)',
        'board.stab.titleOn': 'Stroke stabiliser: level {level} (click to cycle 0-5, Ctrl+wheel also works)',
        'board.stab.notifyOff': 'Stroke stabiliser: off (0)',
        'board.stab.notifyOn': 'Stroke stabiliser: level {level}',

        // ── 画板动作（‹ › 纯图标，后三个带字） ──
        'board.act.prev': 'Previous texture',
        'board.act.next': 'Next texture',
        'board.act.newTex.label': 'Texture',
        'board.act.newTex.title': 'Create a blank texture and bind it to this moment',
        'board.act.unique.label': 'Make unique',
        'board.act.unique.title': 'Copy this texture so that editing it no longer affects other places',
        'board.act.fit.label': 'Fit',
        'board.act.fit.title': 'Scale the whole texture so it is just visible (view only, no pixels change) · key 0',

        // ── 对齐三档 ──
        'board.align.nw': 'Top left',
        'board.align.c': 'Centre',
        'board.align.se': 'Bottom right',

        // ── 色板浮层 ──
        'board.pal.recent': 'Recent colours',
        'board.pal.empty': 'No colours used yet',
        'board.pal.swap': 'Swap foreground / background',
        'board.pal.swapped': 'Swapped foreground / background',

        // ── 恢复默认 ──
        'board.reset.name': 'Reset this brush to its default parameters',
        'board.reset.title': 'Reset: clear the remembered parameters of this brush',

        // ── 底部提示行 ──
        'board.hint': 'Left-drag to paint · Right-click/Alt to sample · E eyedropper · G fill · [ ] size · 1-7 brushes · wheel zooms · Space/middle-drag pans · 0 fits',

        // ── 画布空态 ──
        'board.empty.noTexture': 'No texture at this moment: click "Texture" to create one',

        // ── 通知（notify） ──
        'board.stroke.written': 'Written into the texture',
        'board.fit.already': 'The view is already fitted: the whole texture is visible. To drop the transparent border, use "Trim to content"',
        'board.fit.done': 'View fitted: the texture now fills the viewport (no pixels changed)',
        'board.new.failed': 'Could not create the texture',
        'board.new.placed': 'Created a texture and bound it to this moment',
        'board.new.only': 'Created a texture (it is in the texture library, not placed at this moment)',
        'board.unique.none': 'No texture to make unique at this moment',

        // ── 撤销栈里的命令名（用户看到的那一行） ──
        'board.cmd.stroke': 'Paint a stroke (texture)',
        'board.cmd.fill': 'Fill (texture)',
    },
    'zh-Hans': {
        'board.brush.short.pixel': '像素',
        'board.brush.short.round': '圆头',
        'board.brush.short.soft': '柔边',
        'board.brush.short.pencil': '铅笔',
        'board.brush.short.smudge': '晕染',
        'board.brush.short.scatter': '散点',
        'board.brush.short.eraser': '橡皮',
        'board.brush.title': '{name}（快捷键 {key}）',

        'board.mirror.none': '无',
        'board.mirror.x': '左右',
        'board.mirror.y': '上下',
        'board.mirror.both': '四向',
        'board.mirror.title': '镜像绘制（纯前端，不改数据）',

        'board.param.hardness': '硬度',
        'board.param.spacing': '间距',
        'board.param.jitter': '抖动',
        'board.param.flow': '流量',
        'board.param.reset': '已恢复「{name}」默认参数',

        'board.size.short': '大小',
        'board.size.label': '笔尖大小（像素）',
        'board.size.fieldTitle': '笔尖大小（像素，[ / ] 调整）',
        'board.size.widthLabel': '纹理宽度（像素）',
        'board.size.heightLabel': '纹理高度（像素）',
        'board.size.cropTitle': '把纹理裁到内容包围盒（去掉四周透明）',
        'board.size.applyTitle': '按当前尺寸重设纹理画布',
        'board.size.alignTitle': '重设尺寸时旧内容放在新画布的位置',
        'board.size.notWired': '尺寸命令尚未接线（W19 task-29 落地后可用）',
        'board.size.noTexture': '当前时刻还没有纹理：先点「纹理」新建一张',
        'board.opacity.short': '不透明',
        'board.opacity.title': '笔刷不透明度（%）',

        'board.swatch.title': '当前颜色（点击打开色板）',
        'board.swatch.titleColor': '当前颜色 {color}（点击打开色板）',

        'board.pick.name': '取色器',
        'board.pick.title': '取色器：点画布取一个像素（E）· 画布上右键随时取色',
        'board.pick.titleOn': '取色器已开：点画布取色（E 取消）· 右键 / Alt+左键也可临时取色',
        'board.pick.noTexture': '这个时刻还没有纹理，没得取色',
        'board.pick.outside': '点在纹理外面了，没取到色',
        'board.pick.unreadable': '这张纹理现在读不了，没取到色',
        'board.pick.transparent': '这个像素是透明的，没取到色',
        'board.pick.ok': '取色 {color}',

        'board.bucket.name': '填充',
        'board.bucket.title': '填充：点画布把同色连通区一次填满（G）',
        'board.bucket.titleOn': '填充已开：点画布填满同色连通区（G 取消）',
        'board.bucket.imported': '这个版本还不能在导入位图上填充，请更新应用',
        'board.bucket.unreadable': '这张纹理现在读不了，没法填充',
        'board.bucket.outside': '点在纹理外面了，没法填充',
        'board.bucket.filled': '这块已经是当前色，不用再填',
        'board.bucket.done': '填充 {n} 个像素',

        'board.undo.name': '撤销',
        'board.undo.title': '撤销（引擎 history）',
        'board.redo.name': '重做',
        'board.redo.title': '重做（引擎 history）',
        'board.stab.name': '笔迹稳定器档位',
        'board.stab.titleOff': '笔迹稳定器：关（0）（点击切换 0–5 档，Ctrl+滚轮 也能调）',
        'board.stab.titleOn': '笔迹稳定器：{level} 档（点击切换 0–5 档，Ctrl+滚轮 也能调）',
        'board.stab.notifyOff': '笔迹稳定器：关（0）',
        'board.stab.notifyOn': '笔迹稳定器：{level} 档',

        'board.act.prev': '上一张纹理',
        'board.act.next': '下一张纹理',
        'board.act.newTex.label': '纹理',
        'board.act.newTex.title': '新建一张空白纹理并绑定到当前时刻',
        'board.act.unique.label': '独特化',
        'board.act.unique.title': '把当前纹理拷一份，之后改它不影响别处',
        'board.act.fit.label': '适配',
        'board.act.fit.title': '把整张纹理缩放到刚好可见（只动视图，不改像素）· 0 键',

        'board.align.nw': '左上',
        'board.align.c': '居中',
        'board.align.se': '右下',

        'board.pal.recent': '最近颜色',
        'board.pal.empty': '还没有用过颜色',
        'board.pal.swap': '前景 / 背景交换',
        'board.pal.swapped': '已交换前景 / 背景色',

        'board.reset.name': '恢复这支笔的默认参数',
        'board.reset.title': '恢复默认：清除这支笔的记忆参数',

        'board.hint': '左键画 · 右键/Alt 取色 · E 取色器 · G 填充 · [ ] 笔尖 · 1–7 笔刷 · 滚轮缩放 · 空格/中键平移 · 0 适配',

        'board.empty.noTexture': '这个时刻还没有纹理：点「纹理」新建一张',

        'board.stroke.written': '已写入纹理',
        'board.fit.already': '视图已经在适配位置：整张纹理都可见。要去掉四周的透明区，用「裁到内容」',
        'board.fit.done': '已适配视图：整张纹理铺满可视区（不动像素）',
        'board.new.failed': '新建纹理失败',
        'board.new.placed': '已新建纹理并绑定到当前时刻',
        'board.new.only': '已新建纹理（进了纹理库，这个时刻还没放上去）',
        'board.unique.none': '当前时刻没有可独特化的纹理',

        'board.cmd.stroke': '画一笔（纹理）',
        'board.cmd.fill': '填充（纹理）',
    },
};
