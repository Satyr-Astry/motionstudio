/**
 * MotionStudio —— 图标表（24×24 线性图标，自绘，零依赖）
 *
 * 为什么放在 core：这里只有「名字 → SVG 片段」的纯数据与拼字符串的纯函数，
 * 不碰 document、不查样式、不读时间、不改文档 —— 和 core 的其它模块同一套纪律。
 * 好处是能在 node:test 里直接断言，不需要 DOM（tests/icons.test.mjs 就是这么做的）。
 *
 * 风格基准（Lucide / Feather 那一类 24×24 线性图标）：
 *   viewBox 固定 "0 0 24 24"，几何留 2–3 单位边距；
 *   fill="none" + stroke="currentColor" + 圆头圆角，线宽 1.6；
 *   颜色一律继承父级 color（currentColor），所以按钮的 :hover / .is-on / :disabled
 *   改文字色，图标自动跟着走，不需要为图标再写一套配色。
 *
 * 自绘而不是引第三方包：项目零第三方运行时依赖、无构建步骤、CSP 只允许 'self'，
 * 任何 CDN / 图标字体 / npm 包都进不来。这里的每条 path 都是手写的。
 */

/**
 * 线宽基数（24 viewBox 内的 user unit）。
 * 渲染出来的物理线宽由 icons.css 的 `.ms-icon { stroke-width: calc(1.3 * 24 / var(--icon-px)) }`
 * 接管 —— 三档尺寸（14/16/28）的视觉归一住在那里，不在这里。
 * 这个常量只作为 SVG presentation attribute 的 fallback：CSS 未加载、或这段 svg
 * 被挪出 .ms-icon 类时，仍然有一条合理的线而不是 0。
 */
const STROKE_WIDTH = 1.6;

/**
 * 名字 → SVG 子节点串。
 * 用整段 inner SVG（而不是单个 d 字符串）是因为眼睛、计时器这类图形需要 circle，
 * 而「模糊」这种还需要子元素自带 opacity —— 统一拼装比给每个图标打补丁干净。
 */
export const icons = Object.freeze({
    // ── 文件动作（顶栏） ──
    plus: '<path d="M12 5.5v13M5.5 12h13"/>',
    save: '<path d="M5 4.2h10.4L19.8 8.6V19a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5.2a1 1 0 0 1 1-1z"/><path d="M8.4 4.2v4.4h6.2"/><path d="M8 20v-5.6h8V20"/>',
    'folder-open': '<path d="M4.2 19.4V6.2a1 1 0 0 1 1-1h3.9l2 2h6.7a1 1 0 0 1 1 1v1.6"/><path d="M3.4 19.6 5.9 11.4h14.9l-2.5 8.2z"/>',
    'import': '<path d="M4.2 15.4v3.2a1 1 0 0 0 1 1h13.6a1 1 0 0 0 1-1v-3.2"/><path d="M12 4.2v9.4"/><path d="M8.4 10 12 13.6l3.6-3.6"/>',
    'export': '<path d="M4.2 15.4v3.2a1 1 0 0 0 1 1h13.6a1 1 0 0 0 1-1v-3.2"/><path d="M12 13.6V4.2"/><path d="M8.4 7.8 12 4.2l3.6 3.6"/>',
    undo: '<path d="M8.6 14.4 4 9.8l4.6-4.6"/><path d="M4.4 9.8h9.8a5.8 5.8 0 0 1 0 11.6h-2.6"/>',
    redo: '<path d="M15.4 14.4 20 9.8l-4.6-4.6"/><path d="M19.6 9.8H9.8a5.8 5.8 0 0 0 0 11.6h2.6"/>',
    'arrow-left': '<path d="M19.4 12H4.6"/><path d="M10.4 5.8 4.2 12l6.2 6.2"/>',

    // ── 方向与列表 ──
    'chevron-down': '<path d="M6.2 9.4 12 15.2l5.8-5.8"/>',
    'chevron-right': '<path d="M9.4 6.2 15.2 12l-5.8 5.8"/>',
    'chevron-left': '<path d="M14.6 6.2 8.8 12l5.8 5.8"/>',
    'more-horizontal':
        '<circle cx="5.6" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none"/><circle cx="18.4" cy="12" r="1.35" fill="currentColor" stroke="none"/>',
    eye: '<path d="M2.6 12S6.2 5.6 12 5.6 21.4 12 21.4 12 17.8 18.4 12 18.4 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="2.9"/>',
    'eye-off':
        '<path d="M2.6 12S6.2 5.6 12 5.6c1 0 1.9.2 2.7.5"/><path d="M17.6 7.1c2.4 1.5 3.8 4.9 3.8 4.9s-3.6 6.4-9.4 6.4c-1.3 0-2.5-.3-3.5-.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="M3.2 3.2 20.8 20.8"/>',

    // ── 对象操作 ──
    copy: '<path d="M9.2 8.8h9.6a1 1 0 0 1 1 1v9.6a1 1 0 0 1-1 1H9.2a1 1 0 0 1-1-1V9.8a1 1 0 0 1 1-1z"/><path d="M15.8 5.6V4.2a1 1 0 0 0-1-1H5.2a1 1 0 0 0-1 1v9.6a1 1 0 0 0 1 1h1.4"/>',
    trash: '<path d="M4.4 6.6h15.2"/><path d="M9.6 6.6V4.8a1 1 0 0 1 1-1h2.8a1 1 0 0 1 1 1v1.8"/><path d="M6.8 6.6 7.7 19.4a1.4 1.4 0 0 0 1.4 1.3h5.8a1.4 1.4 0 0 0 1.4-1.3l.9-12.8"/><path d="M10.4 10.4v6.2M13.6 10.4v6.2"/>',
    timer: '<circle cx="12" cy="13.4" r="7.2"/><path d="M12 13.4V9.6"/><path d="M9.6 3h4.8"/><path d="M12 3v3.2"/>',
    x: '<path d="M6.4 6.4 17.6 17.6M17.6 6.4 6.4 17.6"/>',

    // ── 变换 / 关键帧 ──
    diamond: '<path d="M12 3.2 20.8 12 12 20.8 3.2 12z"/>',
    'diamond-minus': '<path d="M12 3.2 20.8 12 12 20.8 3.2 12z"/><path d="M8.6 12h6.8"/>',
    center: '<path d="M12 3.2v3.4M12 17.4v3.4M3.2 12h3.4M17.4 12h3.4"/><circle cx="12" cy="12" r="3.4"/>',
    'step-back': '<path d="M18.2 6.4 9.6 12l8.6 5.6"/><path d="M5.6 5.4v13.2"/>',
    'step-forward': '<path d="M5.8 6.4 14.4 12l-8.6 5.6"/><path d="M18.4 5.4v13.2"/>',
    'rotate-ccw': '<path d="M20 12a8 8 0 1 1-2.4-5.7"/><path d="M20.4 4.4v4.6h-4.6"/>',
    grid: '<path d="M4.2 4.2h15.6v15.6H4.2z"/><path d="M4.2 9.4h15.6M4.2 14.6h15.6M9.4 4.2v15.6M14.6 4.2v15.6"/>',

    // ── 画板工具（设置里的键位表用；board.mjs 的工具条将来可直接复用） ──
    // 名字必须和 W2 的工具条一致：画笔=brush、填充=bucket、取色=eyedropper、平移=move。
    // 这里不留 pen/fill/picker/hand 这类同义别名 —— 同一动作两个图标名，
    // 设置里的「图标 + 动作名 + 键位」就会和工具条对不上（P2 #23 审计出来的）。
    eraser:
        '<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l4.3 4.3a1 1 0 0 1 0 1.4L11 21z"/><path d="M22 21H7"/>',

    // ── 播放与步进（时间轴工具条） ──
    play: '<path d="M8.8 5.2v13.6L19.4 12z"/>',
    pause: '<path d="M9.4 5.4v13.2M14.6 5.4v13.2"/>',
    magnet: '<path d="M6.4 4.6v7.2a5.6 5.6 0 0 0 11.2 0V4.6"/><path d="M6.4 8.4h3.2M14.4 8.4h3.2"/><path d="M6.4 4.6h3.2M14.4 4.6h3.2"/>',
    minus: '<path d="M5.6 12h12.8"/>',

    // ── 区域布局（区域头 ▤ ▥） ──
    rows: '<rect x="4.2" y="4.2" width="15.6" height="15.6" rx="1.4"/><path d="M4.2 12h15.6"/>',
    columns: '<rect x="4.2" y="4.2" width="15.6" height="15.6" rx="1.4"/><path d="M12 4.2v15.6"/>',

    // ── 缓动预设（曲线面板）：图形就是曲线段的样子，所以六个别名各自不同 ──
    'curve-line': '<path d="M4.4 17.6 19.6 6.4"/>',
    'curve-in': '<path d="M4.4 17.6c7.4 0 9.2-2.6 9.2-11.2"/>',
    'curve-out': '<path d="M19.6 6.4c-7.4 0-9.2 2.6-9.2 11.2"/>',
    'curve-both': '<path d="M4.4 17.6c8.8 0 6.4-11.2 15.2-11.2"/>',
    'curve-overshoot': '<path d="M4.4 16.8c5.6-1.6 1.4-9.6 6.4-9.6 3.8 0 4.2 5.8 8.8 8.4"/>',
    'curve-auto': '<path d="M4.2 16.2c2.6-6 5.6-6 8 0s5.4 6 8 0"/>',

    // ── 效果（效果胶囊与效果条共用） ──
    blur: '<circle cx="12" cy="12" r="2.4"/><circle cx="12" cy="12" r="5.4" opacity=".5"/><circle cx="12" cy="12" r="8.6" opacity=".24"/>',
    glow: '<circle cx="12" cy="12" r="3.6"/><path d="M12 2.8v2.2M12 19v2.2M2.8 12h2.2M19 12h2.2M5.6 5.6 7.2 7.2M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6"/>',
    shadow: '<path d="M13.4 5.8h4.8a1 1 0 0 1 1 1v4.8"/><path d="M5.2 9h9.6a1 1 0 0 1 1 1v8.2a1 1 0 0 1-1 1H5.2a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z"/>',
    adjust: '<path d="M3.6 7.2h4.2M13 7.2h7.4M3.6 16.8h7.4M16.2 16.8h4.2"/><circle cx="10.2" cy="7.2" r="2"/><circle cx="13.8" cy="16.8" r="2"/>',
    outline: '<path d="M4.8 8.6V5.8a1 1 0 0 1 1-1h2.8M15.4 4.8h2.8a1 1 0 0 1 1 1v2.8M19.2 15.4v2.8a1 1 0 0 1-1 1h-2.8M8.6 19.2H5.8a1 1 0 0 1-1-1v-2.8"/><path d="M8.8 8.8h6.4v6.4H8.8z"/>',

    // ── 工具与纹理动作（画板工具条 .bd-* / 工具表 .tbar-*） ──
    // 这一组是「工具」而不是「命令」：都不带文字下标，靠形状 + title/aria 区分。
    // eraser 不重复登记：上方「画板工具」组已有同名键，对象字面量里同名键后者覆盖前者，
    // 两处各写一份只会让人以为改了一处就生效（踩过一次）。
    select: '<rect x="4.4" y="4.4" width="15.2" height="15.2" rx="1.2" stroke-dasharray="3.4 2.4"/>',
    brush: '<path d="M16.4 3.9a2.4 2.4 0 0 1 3.4 3.4l-8.1 8.1-3.9 1.1 1.1-3.9z"/><path d="M13.6 6.7 16.8 9.9"/>',
    bucket: '<path d="m19 11-8-8-8.6 8.6a2 2 0 0 0 0 2.8l5.2 5.2c.8.8 2 .8 2.8 0z"/><path d="m5 2 5 5"/><path d="M2.4 13.4h14.6"/><path d="M21.4 18.6a1.9 1.9 0 1 1-3.8 0c0-1.5 1.6-2.3 1.9-3.8.3 1.5 1.9 2.3 1.9 3.8z"/>',
    // 滴管：45° 斜置（Photoshop / Aseprite / Lucide 的通行剪影）——胶头用圆角方块，管身两条平行边，
    // 管尖收成一个三角。竖直画法在 14px 下会被读成图钉/钥匙（真机对照见 ms-view/shots/icon-lab.png）。
    eyedropper: '<path d="m2 22 1.1-1.1h3.1l8.6-8.6"/><path d="M3.2 20.8v-3.2l8.6-8.6"/><path d="m15.1 6.4 2.9-2.9a2.15 2.15 0 0 1 3 3l-2.9 2.9"/><path d="M14.3 7.2 17.7 10.6l-2.4 2.4a2.1 2.1 0 0 1-3 0l-1.8-1.8a2.1 2.1 0 0 1 0-3z"/>',
    move: '<path d="M12 3.6v16.8M3.6 12h16.8"/><path d="M9.6 6.2 12 3.6l2.4 2.6M9.6 17.8l2.4 2.6 2.4-2.6M6.2 9.6 3.6 12l2.6 2.4M17.8 9.6 20.4 12l-2.6 2.4"/>',
    fit: '<path d="M9.2 4.4H5.6a1.2 1.2 0 0 0-1.2 1.2v3.6"/><path d="M14.8 4.4h3.6a1.2 1.2 0 0 1 1.2 1.2v3.6"/><path d="M19.6 14.8v3.6a1.2 1.2 0 0 1-1.2 1.2h-3.6"/><path d="M4.4 14.8v3.6a1.2 1.2 0 0 0 1.2 1.2h3.6"/>',
    sparkle: '<path d="M11.4 3.9l1.8 4.6 4.6 1.8-4.6 1.8-1.8 4.6-1.8-4.6L5 10.3l4.6-1.8z"/><path d="M17.9 14.2l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z"/>',

    // ── 笔刷家族（画板工具条的七支笔；第七支「橡皮」复用上面的 eraser） ──
    // 这一组最容易在 14px 下糊，所以每枚都用「一个可指认的轮廓 + 一条方向线」的构成：
    // round 是斜杆 + 圆头，soft 是同心双圈，smudge 是三段椭圆拖尾，scatter 是散点，
    // pixel 是方格，pencil 是削尖笔身。对照截图见 ms-view/shots/icon-lab2-14.png。
    'brush-round': '<path d="M12.6 11.4 19.6 4.4a2.3 2.3 0 0 1 3.2 3.2l-7 7"/><circle cx="9.2" cy="14.8" r="3.6"/>',
    // 柔边的虚线边：dasharray 的缺口必须撑到 14px 下还看得见（3.2 缺口 ≈ 1.9px），
    // 否则缩小后虚线糊成实线，与 'brush-round' 的实心圆几乎一样。
    'brush-soft': '<circle cx="9.4" cy="14.6" r="5" stroke-dasharray="3.4 3.2"/><circle cx="9.4" cy="14.6" r="2.2"/><path d="M12.9 11.3 19.4 4.8a2.2 2.2 0 0 1 3.1 3.1l-6.5 6.5"/>',
    pencil: '<path d="M16.1 3.9a1.9 1.9 0 0 1 2.7 0l1.3 1.3a1.9 1.9 0 0 1 0 2.7l-8.4 8.4-4.9 1.1 1.1-4.9z"/><path d="M14.7 5.3 18.7 9.3"/>',
    'brush-pixel': '<path d="M4.2 4.2h5.2v5.2H4.2zM10.6 4.2h5.2v5.2h-5.2zM4.2 10.6h5.2v5.2H4.2z"/><rect x="15.6" y="15.6" width="4.4" height="4.4" fill="currentColor" stroke="none"/>',
    // 晕染：三条由粗到细、由实到虚的竖条。14px 下靠「宽窄差 + 透明度差」两条线索同时读，
    // 只靠透明度会因为 1px 抗锯齿而糊成三条一样粗的平行线。
    'brush-smudge': '<ellipse cx="6.4" cy="12" rx="3" ry="5.8"/><ellipse cx="12.6" cy="12" rx="2.1" ry="4.3" opacity=".58"/><ellipse cx="18.6" cy="12" rx="1.6" ry="2.9" opacity=".32"/>',
    'brush-scatter': '<circle cx="6.6" cy="7.4" r="1.65" fill="currentColor" stroke="none"/><circle cx="13.4" cy="5.2" r="1.05" fill="currentColor" stroke="none"/><circle cx="18.3" cy="9.5" r="1.5" fill="currentColor" stroke="none"/><circle cx="9.1" cy="13.1" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.7" cy="14.7" r="1.8" fill="currentColor" stroke="none"/><circle cx="6.3" cy="18.1" r="1.05" fill="currentColor" stroke="none"/><circle cx="18.7" cy="18.3" r="1.3" fill="currentColor" stroke="none"/>',

    // ── 镜像 / 参数 / 稳定器 / 图片（变换工具栏与画板浮层） ──
    // 镜像三枚靠「虚线轴的方向」区分：h 竖轴、v 横轴、both 十字 + 中心点。
    'flip-h': '<path d="M12 3.2v17.6" stroke-dasharray="2.6 2.6"/><path d="M8.4 8.2 4.2 12l4.2 3.8"/><path d="M15.6 8.2 19.8 12l-4.2 3.8"/>',
    'flip-v': '<path d="M3.2 12h17.6" stroke-dasharray="2.6 2.6"/><path d="M8.2 8.4 12 4.2l3.8 4.2"/><path d="M8.2 15.6 12 19.8l3.8-4.2"/>',
    'flip-both': '<circle cx="12" cy="12" r="2.2"/><path d="M9.4 6.8 12 4.2l2.6 2.6M9.4 17.2 12 19.8l2.6-2.6M6.8 9.4 4.2 12l2.6 2.6M17.2 9.4 19.8 12l-2.6 2.6"/>',
    // 与既有 adjust 的差别：adjust 是「两段断开的线 + 两个把手」，sliders 是「三条满宽线 + 三个错位把手」。
    // 14px 下靠「线是否贯通」区分，这条边界比图形数量更稳。
    sliders: '<path d="M3.4 6.4h18.2M3.4 12h18.2M3.4 17.6h18.2"/><circle cx="15.6" cy="6.4" r="2.1"/><circle cx="8.4" cy="12" r="2.1"/><circle cx="17" cy="17.6" r="2.1"/>',
    stabilizer: '<path d="M3.6 9.4l2.2-3.2 2.4 4.6 2.2-5.4 2.4 5 2.2-3.6 2 4.4"/><path d="M3.6 17.8h16.8"/>',
    'image-plus': '<path d="M4.2 5.4h13.2a1 1 0 0 1 1 1v6.6"/><path d="M4.2 5.4a1 1 0 0 0-1 1v11.2a1 1 0 0 0 1 1h8.2"/><path d="M4.4 16.4 8.6 12.2l3.2 3.2"/><circle cx="14.1" cy="9.1" r="1.35"/><path d="M18.3 15.2v5.6M15.5 18h5.6"/>',

    // ── 兜底：icon() 收到不存在的名字时用它，绝不返回空串（空串 = 空白按钮） ──
    help: '<circle cx="12" cy="12" r="8.4"/><path d="M9.6 9.5a2.5 2.5 0 1 1 3.7 2.2c-.8.5-1.3 1.1-1.3 2v.4"/><circle cx="12" cy="17.1" r=".95" fill="currentColor" stroke="none"/>',
    // 命令面板（Ctrl+Shift+P）：放大镜，Lucide 的 search 同一构成
    search: '<circle cx="11" cy="11" r="6.4"/><path d="M15.8 15.8 20.4 20.4"/>',
});

/** 全部可用名字（测试与调试用；顺序即上表声明顺序）。 */
export const ICON_NAMES = Object.freeze(Object.keys(icons));

/** 未知名字的回退图标。 */
export const DEFAULT_ICON = 'help';

const ESCAPES = Object.freeze({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
});

/** 转义一段文本，安全放进 HTML 属性值或元素文本。 */
export function escapeAttr(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

/** 这个名字有对应图形吗（不是「拼错的近似名」）。 */
export function hasIcon(name) {
    return typeof name === 'string' && Object.prototype.hasOwnProperty.call(icons, name);
}

/** 尺寸参数 → 附加属性：'sm' / 'lg' 走 tokens 的 --icon-sm / --icon-lg，数字走内联覆盖。 */
function sizeAttrs(size) {
    if (size === 'sm' || size === 'lg') return ' data-size="' + size + '"';
    const n = Number(size);
    if (!Number.isFinite(n) || n <= 0) return '';
    const px = Math.round(Math.min(96, Math.max(6, n)) * 100) / 100;
    // --icon-px 必须和 --icon-size 一起给：只给尺寸时 CSS 会按默认 16 算 stroke，
    // 同一个图标换个尺寸就变粗/变细（这正是三档线宽不一致的成因）。
    return ' style="--icon-size:' + px + 'px;--icon-px:' + px + '"';
}

/**
 * 生成一段图标 HTML。
 *
 * @param {string} name 图标名（见 icons）；不认识的名字回退到 DEFAULT_ICON 并打 data-icon-missing
 * @param {{size?:number|'sm'|'lg', className?:string, label?:string, strokeWidth?:number}} [opts]
 *   size      数字（px）或 'sm' / 'lg'；缺省用 CSS 的 var(--icon)
 *   className 追加类名（拼在 ms-icon 后面）
 *   label     可读中文名。给了 → role="img" + aria-label + <title>；
 *             不给 → aria-hidden="true"（宿主按钮自己带 aria-label 时的正确做法，避免读屏念两遍）
 * @returns {string} `<svg …></svg>`
 */
export function icon(name, opts) {
    const o = opts || {};
    const key = hasIcon(name) ? name : DEFAULT_ICON;
    const cls = 'ms-icon' + (o.className ? ' ' + String(o.className) : '');
    const sw = Number(o.strokeWidth);
    const strokeWidth = Number.isFinite(sw) && sw > 0 ? Math.min(4, sw) : STROKE_WIDTH;
    const label = o.label == null ? '' : String(o.label).trim();
    const a11y = label
        ? ' role="img" aria-label="' + escapeAttr(label) + '"'
        : ' aria-hidden="true" focusable="false"';
    const title = label ? '<title>' + escapeAttr(label) + '</title>' : '';
    // 拼错的名字必须留下痕迹：按钮看起来有图（不是空白），但 DOM 里能查出是哪个名字没兑现
    const missing = key === name ? '' : ' data-icon-missing="' + escapeAttr(String(name)) + '"';
    return (
        '<svg class="' + escapeAttr(cls) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
        ' stroke-width="' + strokeWidth + '" stroke-linecap="round" stroke-linejoin="round"' +
        sizeAttrs(o.size) + ' data-ms-icon="' + escapeAttr(key) + '"' + missing + a11y + '>' +
        title + icons[key] + '</svg>'
    );
}
