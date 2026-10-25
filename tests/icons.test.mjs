// app/core/icons.mjs 的契约测试 + 「使用点名字都真的存在」的静态闸门。
//
// 守四件事：
//   1) icon() 的形状不变：24×24 viewBox、currentColor、aria 三态、缺失回退；
//   2) 转义与原型链：label 里的 <>&"' 必须被转义；toString / __proto__ 这类名字
//      不能被当成「有图标」（空白按钮最常见的成因就是 hasOwnProperty 写漏）；
//   3) 静态闸门：chrome / layers / xform / prop-object 四个使用点里出现的所有图标名
//      都必须在图标表里 —— 拼错一个字母就会得到「看不见的按钮」，而 DOM 里一片正常；
//   4) 表驱动间接引用：效果胶囊用 icon(def.id)，所以 effects.mjs 的每个 id 也得是图标名。
//
// 为什么用正则扫源码而不是渲染 DOM：本项目零依赖、测试跑在 node 里没有 document，
// 而图标名是**编译期就能确定**的字符串字面量，静态扫描比启动 jsdom 更直接也更严格。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    DEFAULT_ICON,
    ICON_NAMES,
    escapeAttr,
    hasIcon,
    icon,
    icons,
} from '../app/core/icons.mjs';
// 帮助表是「唯一权威数据源」，这里直接 import 断言它的形状与图标名
import { LEGEND_ITEMS, SHORTCUT_GROUPS } from '../app/editors/help.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// 四个使用点 + 一个间接来源
const USERS = {
    chrome: '../app/shell/chrome.mjs',
    layers: '../app/editors/layers.mjs',
    xform: '../app/editors/xform.mjs',
    propObject: '../app/editors/prop-object.mjs',
};

/**
 * 从一段源码里挖出所有「这里是图标名」的候选串：
 *   a) icon( … ) 括号内的字符串字面量 —— 覆盖 icon('eye') 与 icon(open ? 'a' : 'b')；
 *   b) 表驱动行 ['act', 'icon-name', …] 的第二个元素 —— 覆盖 icon(iconName) 的实参来源。
 * options 里的 'sm' / 'lg' 是尺寸档不是图标名，剔除。
 */
function namesInSource(src) {
    const found = new Set();

    for (const m of src.matchAll(/\bicon\(([^()]*)\)/g)) {
        for (const lit of m[1].matchAll(/'([a-z][a-z0-9-]*)'/g)) {
            if (lit[1] === 'sm' || lit[1] === 'lg') continue;
            found.add(lit[1]);
        }
    }

    // 表驱动：['act', 'icon-name', …]，第二个位置且是 kebab/单词形态
    for (const m of src.matchAll(/\[\s*'[a-z][a-z0-9-]*'\s*,\s*'([a-z][a-z0-9-]*)'\s*,/g)) {
        found.add(m[1]);
    }

    return found;
}

test('icon() 输出 24×24 线性 SVG 骨架', () => {
    const svg = icon('save');
    assert.match(svg, /^<svg /, '必须以 <svg 开头（可整段塞进 innerHTML）');
    assert.ok(svg.includes('viewBox="0 0 24 24"'), 'viewBox 必须是 0 0 24 24');
    assert.ok(svg.includes('fill="none"'), '线性图标不填充');
    assert.ok(svg.includes('stroke="currentColor"'), '颜色必须继承文字色');
    assert.ok(svg.includes('stroke-linecap="round"'));
    assert.ok(svg.includes('data-ms-icon="save"'), 'DOM 里要能看出是哪个图标');
    assert.ok(svg.endsWith('</svg>'));
    assert.ok(!svg.includes('<script'), '图标表不许出现脚本');
});

test('每个图标都是合法的片段（无重复 id、无外链、非空）', () => {
    for (const name of ICON_NAMES) {
        const inner = icons[name];
        assert.equal(typeof inner, 'string', name + ' 应是字符串片段');
        assert.ok(inner.length > 12, name + ' 太短，像是空图形');
        assert.ok(inner.startsWith('<'), name + ' 应以标签开头');
        assert.ok(!inner.includes('</svg>'), name + ' 不该自带 svg 结束标签');
        assert.ok(!inner.includes('id="'), name + ' 不许带 id：同页多个图标会撞 id');
        assert.ok(!/https?:|<image|xlink/.test(inner), name + ' 不许引用外部资源');
        assert.ok(!/\son[a-z]+\s*=/.test(inner), name + ' 不许带事件属性');

        const svg = icon(name);
        assert.ok(svg.includes('viewBox="0 0 24 24"'), name + ' 的 viewBox 不对');
        assert.ok(svg.includes('stroke="currentColor"'), name + ' 的描边色不对');
        assert.ok(svg.includes('data-ms-icon="' + name + '"'));
    }
    assert.ok(ICON_NAMES.length >= 20, '图标表至少要覆盖顶栏 + 对象面板 + 变换面板的用量');
});

test('未知名字安全回退：绝不返回空串', () => {
    const svg = icon('no-such-icon');
    assert.ok(svg.includes('data-ms-icon="' + DEFAULT_ICON + '"'), '回退到 DEFAULT_ICON');
    assert.ok(svg.includes('data-icon-missing="no-such-icon"'), '拼错的名字要留痕，方便 DOM 里抓');
    assert.ok(svg.includes('viewBox="0 0 24 24"'));
    assert.ok(svg.length > 80, '回退也必须是一张能看见的图');

    for (const bad of ['', null, undefined, 0, 42, {}, [], 'SAVE', 'Save', 'save ']) {
        const out = icon(bad);
        assert.ok(out.includes('data-ms-icon="' + DEFAULT_ICON + '"'), '坏名字 ' + String(bad) + ' 应回退');
        assert.ok(out.includes('viewBox="0 0 24 24"'));
    }
});

test('hasIcon 只认自家键，不被原型链穿透', () => {
    assert.equal(hasIcon('save'), true);
    assert.equal(hasIcon('eye-off'), true);
    for (const bad of ['', 'save ', 'S ave', 'SAVE', 'help2', null, undefined, 1, {}, [], true]) {
        assert.equal(hasIcon(bad), false, '不应把 ' + String(bad) + ' 当成图标名');
    }
    // 这几个是 Object.prototype 上的名字：写成 name in icons 就会误判
    for (const proto of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
        assert.equal(hasIcon(proto), false, proto + ' 不能被当成图标');
        assert.ok(icon(proto).includes('data-icon-missing="' + proto + '"'));
    }
    assert.equal(Object.isFrozen(icons), true, '图标表要冻结，防止运行期被改');
    assert.equal(Object.isFrozen(ICON_NAMES), true);
});

test('label 走转义，属性与文本都不许漏', () => {
    const nasty = '<b>&"\'</b>';
    const svg = icon('help', { label: nasty });
    assert.ok(svg.includes('role="img"'), '给了 label 就是有语义的图');
    assert.ok(svg.includes('&lt;b&gt;'), '< 必须转义');
    assert.ok(svg.includes('&amp;'), '& 必须转义');
    assert.ok(svg.includes('&quot;'), '" 必须转义（属性值里）');
    assert.ok(svg.includes('&#39;'), "' 必须转义");
    assert.ok(!svg.includes('<b>'), '原始标签不许进 DOM');
    assert.ok(svg.includes('<title>'), '要给出可读标题');
    assert.ok(svg.includes('aria-label="'), '读屏要念得出来');
    assert.ok(!svg.includes('aria-hidden'), '不允许同时出现两种无障碍语义');

    // 不给 label：图标是纯装饰，读屏跳过（宿主按钮自己有 aria-label）
    const plain = icon('save');
    assert.ok(plain.includes('aria-hidden="true"'));
    assert.ok(!plain.includes('role="img"'));
    assert.ok(!plain.includes('<title>'), '没 label 就不该有 title，否则会跟按钮 title 抢');
});

test('className 与尺寸参数只影响外壳，不污染图标名', () => {
    assert.ok(icon('save', { className: 'extra' }).includes('class="ms-icon extra"'));
    assert.ok(icon('save', { size: 20 }).includes('--icon-size:20px'));
    assert.ok(icon('save', { size: 'sm' }).includes('data-size="sm"'));
    assert.ok(icon('save', { size: 'lg' }).includes('data-size="lg"'));
    // 非法尺寸一律不写内联样式，交给 CSS 的 var(--icon)
    for (const bad of [0, -3, 'wide', null, undefined, NaN, {}]) {
        assert.ok(!icon('save', { size: bad }).includes('--icon-size'), '非法尺寸不该写内联样式');
    }
    // 线宽可覆盖，但要有上限，避免 4px 以上把 24×24 的图形糊死
    assert.ok(icon('save', { strokeWidth: 2 }).includes('stroke-width="2"'));
    assert.ok(icon('save', { strokeWidth: 99 }).includes('stroke-width="4"'));
    assert.ok(!icon('save', { strokeWidth: 'thick' }).includes('stroke-width="NaN"'));
    // 转义函数本身
    assert.equal(escapeAttr('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
    assert.equal(escapeAttr(null), '');
});

test('使用点里出现的每个图标名都真的存在（防拼错成空白按钮）', () => {
    for (const [who, rel] of Object.entries(USERS)) {
        const names = namesInSource(read(rel));
        assert.ok(names.size > 0, who + ' 里没扫到任何图标名，正则或写法变了');
        for (const name of names) {
            assert.ok(hasIcon(name), who + ' 引用了不存在的图标：' + name);
        }
    }
});

test('四个使用点确实都调用了 icon()（防止哪天被改回文字而测试静默通过）', () => {
    for (const [who, rel] of Object.entries(USERS)) {
        const src = read(rel);
        assert.match(src, /\bicon\(/, who + ' 没有调用 icon()');
        assert.match(src, /from '\.\.\/core\/icons\.mjs'/, who + ' 没有从 core/icons.mjs 引入');
    }
    // 顶栏三处纯图标按钮必须有 aria-label + title，否则只剩一个没名字的图形
    const chrome = read(USERS.chrome);
    assert.match(chrome, /setAttribute\('aria-label', title\)/, '顶栏按钮要带 aria-label');
});

test('效果胶囊间接引用：effects.mjs 的每个 id 都得是图标名', () => {
    const src = read('../app/paint/effects.mjs');
    // effects.mjs 里既有单行 { id: 'blur', … } 也有多行的 id: 'glow',，两种都要扫到
    const ids = [...src.matchAll(/\bid: '([a-z][a-z0-9-]*)'/g)].map((m) => m[1]);
    assert.ok(ids.length >= 5, 'effects.mjs 的效果种类至少要扫到 5 个，实际 ' + ids.length);
    for (const id of ids) {
        assert.ok(hasIcon(id), '效果「' + id + '」没有对应图标，胶囊会变成空图');
    }
});

test('xform 的四个动作 = 图标 + 文字，不是拿图标换掉文字', () => {
    const src = read(USERS.xform);
    // 表形状：['act', '图标名', 文字或 null, '标题'] —— null 表示这一格只是纯图标按钮
    const rows = [...src.matchAll(/\[\s*'(prev|next|del|reset)'\s*,\s*'([a-z][a-z0-9-]*)'\s*,\s*(null|'([^']*)')\s*,\s*'([^']+)'\s*\]/g)];
    assert.equal(rows.length, 4, '四个动作的 (act, 图标, 文字, 标题) 四元组要齐，实际 ' + rows.length);
    for (const [, act, iconName, raw, text, title] of rows) {
        assert.ok(hasIcon(iconName), act + ' 的图标不存在：' + iconName);
        assert.ok(title.length > 0, act + ' 没有 title：纯图标按钮就彻底没名字了');
        if (act === 'del' || act === 'reset') {
            assert.ok(raw !== 'null' && text.length > 0, act + ' 丢了文字：这两格有位置放字，必须保留');
        } else {
            assert.equal(raw, 'null', act + ' 是 22px 方格，塞字会撑破 '.replace(' 25', ''));
        }
    }
});

test('样式层不许把文字裁成省略号（W3 回归：删关键帧被截成「删…」）', () => {
    const css = read('../app/styles/icons.css');
    const label = css.slice(css.indexOf('button.ms-icon-label > span'));
    const block = label.slice(0, label.indexOf('}'));
    assert.ok(!block.includes('text-overflow'), '.ms-icon-label 的文字槽不许省略');
    assert.ok(!block.includes('overflow: hidden'), '.ms-icon-label 的文字槽不许裁剪');
    // 变换面板那几个「图标 + 文字」按钮同理
    const xf = css.slice(css.indexOf('.xf-btn.ms-icon-label,'));
    const xfBlock = xf.slice(0, xf.indexOf('}'));
    assert.ok(xfBlock.includes('overflow: visible'), 'xf 按钮要允许溢出，不许裁字');
    assert.ok(!xfBlock.includes('ellipsis'));
});

test('样式与入口：icons.css 被引入，且尺寸可被局部覆盖', () => {
    const html = read('../app/index.html');
    assert.ok(html.includes('./styles/icons.css'), 'index.html 要引入 icons.css');
    assert.ok(
        html.indexOf('styles/icons.css') > html.indexOf('styles/palette.css'),
        'icons.css 必须排在最后，才有资格用双类选择器盖住宿主规则'
    );

    const css = read('../app/styles/icons.css');
    assert.ok(css.includes('width: var(--icon-size, var(--icon))'), '图标宽度要可局部覆盖');
    assert.ok(css.includes('height: var(--icon-size, var(--icon))'));
    assert.match(css, /button\.ms-icon-btn\s*\{[^}]*width: var\(--h-btn\)/, '纯图标按钮盒宽 = 22px');
    // 不重定义布局令牌：--h-* / --r-* 属于 tokens.css
    assert.ok(!/--h-(top|head|bar|btn|field|row)\s*:/.test(css), 'icons.css 不许重定义高度令牌');
    assert.ok(!/--r-(\d|pop|pill)\s*:/.test(css), 'icons.css 不许重定义圆角令牌');
});

// ── 阶段二（task-4 A 段）───────────────────────────────────────────────
// 这几处的图标名都是「写在表里的字符串」：拼错了页面不会有任何报错，
// 只会出现一个空白按钮。所以每个使用点都要反向验证一遍。

test('阶段二使用点：时间轴 / 曲线 / 区域头的图标名都真实存在', () => {
    const tl = read('../app/editors/timeline-paint.mjs');
    const tlSpec = [...tl.matchAll(/icon:\s*'([a-z-]+)'/g)].map((m) => m[1]);
    const tlCall = [...tl.matchAll(/\bicon\('([a-z-]+)'/g)].map((m) => m[1]);
    // 13（v8 走带 5 + 画格 5 + 关键帧/磁铁/缩放等） + 2（v10 预览播放的速度与方式）
    assert.equal(tlSpec.length, 15, '时间轴工具条一共 15 个按钮，实际登记 ' + tlSpec.length);
    for (const name of tlSpec.concat(tlCall)) {
        assert.ok(hasIcon(name), '时间轴用了不存在的图标：' + name);
    }

    const curve = read('../app/editors/curve.mjs');
    // 只认 PRESETS 那 5 行（缩进 8 空格、后接中文短名）；同文件里还有
    // `for (const ease of ['linear', 'bezier', 'hold'])`，别把它误算成第 6 条。
    const curveNames = [...curve.matchAll(/^ {8}\['(?:linear|in|out|inout|back)', '([a-z-]+)'/gm)].map((m) => m[1]);
    assert.equal(curveNames.length, 5, '曲线预设应有 5 个图标化按钮，实际 ' + curveNames.length);
    const curveCall = [...curve.matchAll(/\bicon\('([a-z-]+)'/g)].map((m) => m[1]);
    for (const name of curveNames.concat(curveCall)) {
        assert.ok(hasIcon(name), '曲线面板用了不存在的图标：' + name);
    }

    const vh = read('../app/shell/view-host.mjs');
    const areaNames = [...vh.matchAll(/\['(?:split-h|split-v|close)',\s*'([a-z-]+)'/g)].map((m) => m[1]);
    assert.equal(areaNames.length, 3, '区域头三个按钮都要有图标，实际 ' + areaNames.length);
    for (const name of areaNames) assert.ok(hasIcon(name), '区域头用了不存在的图标：' + name);
});

test('阶段二：命令面板每个条目都有图标（精确表 + 前缀兜底）', () => {
    const src = read('../app/shell/command-palette.mjs');
    const exactBlock = src.slice(src.indexOf('const CMD_ICONS'), src.indexOf('const CMD_ICON_PREFIX'));
    const exact = [...exactBlock.matchAll(/':\s*'([a-z-]+)'/g)].map((m) => m[1]);
    assert.ok(exact.length >= 25, '命令图标表太薄：只有 ' + exact.length + ' 条');
    for (const name of exact) assert.ok(hasIcon(name), '命令面板用了不存在的图标：' + name);

    const prefixBlock = src.slice(src.indexOf('const CMD_ICON_PREFIX'), src.indexOf('function iconOf'));
    const prefixes = [...prefixBlock.matchAll(/:\s*'([a-z-]+)'/g)].map((m) => m[1]);
    assert.ok(prefixes.length >= 8, '前缀兜底表缺项：' + prefixes.length);
    for (const name of prefixes) assert.ok(hasIcon(name), '前缀兜底用了不存在的图标：' + name);

    // 表里没有的 id 也必须画得出图标，否则命令面板会出现空白行
    assert.match(src, /CMD_ICON_PREFIX\[id\.split\('\.'\)\[0\]\] \|\| 'help'/, 'iconOf 必须有兜底');
});

test('阶段二：纯图标按钮在源码层面都补了 aria-label', () => {
    const tl = read('../app/editors/timeline-paint.mjs');
    assert.match(tl, /spec\.text \? 'ms-icon-label' : 'ms-icon-btn'/, 'mkBtn 要按有无文字选装配类');
    assert.match(tl, /setAttribute\('aria-label', spec\.title\)/, 'mkBtn 必须补 aria-label');
    assert.match(tl, /icon\(playing \? 'pause' : 'play'\)/, '播放按钮的图标要跟着状态切');

    const curve = read('../app/editors/curve.mjs');
    assert.ok(curve.includes('curve-preset ms-icon-label'), '曲线预设走「图标 + 文字」');

    const vh = read('../app/shell/view-host.mjs');
    assert.match(vh, /b\.innerHTML = icon\(iconName\)/, '区域头要真的把图标塞进按钮');
    assert.match(vh, /b\.setAttribute\('aria-label', title\)/, '区域头必须补 aria-label');

    const cmd = read('../app/shell/command-palette.mjs');
    assert.match(cmd, /glyph\.innerHTML = icon\(iconOf\(cmd\)/, '命令条目要渲染图标');
    assert.match(cmd, /node\.append\(glyph, title, hint, keys\)/, '图标必须在标题之前');
});

test('段帧率条：字号回到 10 档，窄段阈值与字号匹配', () => {
    const tl = read('../app/editors/timeline-paint.mjs');
    assert.ok(!/fontSize = '8px'/.test(tl), '8px 不在 10/11/12/13 的字号阶梯上');
    assert.ok(!/font-size:8px/.test(tl), '内联输入框也不许 8px');
    assert.ok(tl.includes("node.style.fontSize = '10px'"), '段条字号应为 10px');
    // 10px 下「12fps」约 40px；阈值比它大，才不会出现「12ps」这种残字
    assert.match(tl, /const narrow = \(x1 - x0\) < 42;/, '窄段阈值必须 ≥ 40px');
});

test('帮助表：分组顺序固定，键位与图例的图标名都真实存在', () => {
    // 钉分组 id 而不是中文标题：标题是会改的文案（「画板」拆成「编排画布 / 画板工作区」），
    // id 是契约。canvas 与 board 必须分开 —— E 键在两个语境语义不同（橡皮 vs 取色器）。
    // layer 是 L4 的层级键（Alt+↑↓/←→），作用对象是对象面板的层级，自成一类语境。
    assert.deepEqual(
        SHORTCUT_GROUPS.map((g) => g.id),
        ['file', 'time', 'keyframe', 'layer', 'canvas', 'board', 'view'],
        '分组顺序必须是 file / time / keyframe / layer / canvas / board / view'
    );
    let rows = 0;
    for (const g of SHORTCUT_GROUPS) {
        assert.ok(hasIcon(g.icon), '分组图标不存在：' + g.id + ' → ' + g.icon);
        assert.ok(g.items.length > 0, '分组不能为空：' + g.id);
        for (const item of g.items) {
            rows += 1;
            assert.ok(hasIcon(item.icon), g.id + ' 的条目用了不存在的图标：' + item.name + ' → ' + item.icon);
            assert.ok(String(item.name).trim().length > 0, g.id + ' 里有空动作名');
        }
    }
    assert.ok(rows >= 28, '键位表太薄，只有 ' + rows + ' 行');
    for (const item of LEGEND_ITEMS) {
        assert.ok(hasIcon(item.icon), '图例用了不存在的图标：' + item.icon);
        assert.ok(item.kind === 'cel' || item.kind === 'kf', '图例 kind 只能是 cel / kf，收到 ' + item.kind);
        assert.ok(item.text.length > 8, '图例说明太短：' + item.name);
    }
});

test('图例同源：时间轴浮层与设置都只读 help.mjs 那一份', () => {
    const tl = read('../app/editors/timeline-paint.mjs');
    assert.ok(tl.includes("from './help.mjs'"), '图例文案必须 import 自 help.mjs');
    assert.ok(!/const\s+LEGEND_ROWS\s*=/.test(tl), '时间轴不许再定义本地图例表（会和设置里的那份漂移）');
    assert.match(tl, /for \(const item of LEGEND_ITEMS\)/, '浮层必须遍历 LEGEND_ITEMS');

    const prefs = read('../app/editors/prop-prefs.mjs');
    assert.match(prefs, /SHORTCUT_GROUPS/, '设置必须 import 同一份键位表');
    assert.match(prefs, /LEGEND_ITEMS/, '设置必须 import 同一份图例');
    assert.ok(!/const\s+SHORTCUT_GROUPS\s*=/.test(prefs), '设置不许自己抄一份键位表');
});

test('段条高度 12：给 10px 字留上下各 1px 呼吸', () => {
    const geo = read('../app/editors/timeline-geo.mjs');
    assert.match(geo, /export const FPS_H = 12;/, 'FPS_H 必须是 12');
});

test('曲线预设：图标 + 单字，title 用全称', () => {
    const curve = read('../app/editors/curve.mjs');
    for (const word of ['线性', '进入', '退出', '双向', '回弹']) {
        assert.ok(curve.includes("'" + word + "'"), '曲线预设缺全称：' + word);
    }
    assert.ok(curve.includes('自由：'), '「自」按钮的 title 要以「自由」开头');
    // 六个按钮仍是单字（Lead 拍板：不加宽到两字，保住 38px 的排版红利）
    for (const glyph of ["'线'", "'入'", "'出'", "'双'", "'冲'"]) {
        assert.ok(curve.includes(glyph), '曲线按钮要保留单字：' + glyph);
    }
    assert.ok(curve.includes('<span>自</span>'), '「自」按钮是 innerHTML 拼的，文字必须在 span 里');
});

test('关键帧菱形有兜底 title（paint 之前也不能空悬停）', () => {
    const tl = read('../app/editors/timeline-paint.mjs');
    assert.match(tl, /b\.title = '关键帧：变换在这里有一条关键帧/, 'makeKfNode 必须给兜底 title');
    assert.match(tl, /setAttribute\('aria-label', '关键帧'\)/, 'makeKfNode 必须给 aria-label');
});

test('帮助表：同一组内不许出现两条相同的键位', () => {
    // 拆组的意义就在这条：编排（app.mjs 全局 keydown）与画板（board.mjs 捕获阶段 keydown）
    // 是两个语境，同名键语义可以不同；但**同一组内**重复 = 表自己打架。
    for (const g of SHORTCUT_GROUPS) {
        const seen = new Map();
        for (const it of g.items) {
            const k = String(it.keys || '').trim();
            assert.ok(k, g.id + ' 组里有条目缺键位：' + it.name);
            assert.ok(
                !seen.has(k),
                g.id + ' 组里键位重复：' + k + '（' + seen.get(k) + ' 与 ' + it.name + '）'
            );
            seen.set(k, it.name);
        }
    }
});

test('E 键的语义分裂：编排是橡皮，画板是取色器', () => {
    // W2 交付时指出的既有缺陷。两个语境各自成立（编排跟 Photoshop 惯例、画板跟 Klecks 的 eyedropper），
    // 错的是以前把它们写在同一条「画板」组里。这条测试钉住「拆开且各自正确」。
    const canvas = SHORTCUT_GROUPS.find((g) => g.id === 'canvas');
    const board = SHORTCUT_GROUPS.find((g) => g.id === 'board');
    assert.ok(canvas, '缺少「编排画布」组');
    assert.ok(board, '缺少「画板工作区」组');
    assert.equal(canvas.items.find((i) => i.keys === 'E').name, '橡皮', '编排画布的 E 必须是橡皮');
    assert.match(board.items.find((i) => i.keys === 'E').name, /取色器/, '画板工作区的 E 必须是取色器');
    // 共性键可以两组都有（同一行为、两处可用），但必须是不同语境各自的一行
    for (const shared of ['[ / ]', '0']) {
        assert.ok(canvas.items.some((i) => i.keys === shared), '编排缺共性键：' + shared);
        assert.ok(board.items.some((i) => i.keys === shared), '画板缺共性键：' + shared);
    }
});

// ── task-24：12 枚新图标 + 三档 stroke 视觉归一 ──────────────────────────
const NEW_ICONS = ['brush-round', 'brush-soft', 'pencil', 'brush-pixel', 'brush-smudge', 'brush-scatter',
                    'flip-h', 'flip-v', 'flip-both', 'sliders', 'stabilizer', 'image-plus'];

test('task-24：12 枚新图标都在表里，总数锁死 68', () => {
    for (const name of NEW_ICONS) {
        assert.ok(hasIcon(name), '缺少新图标：' + name);
        const svg = icon(name);
        assert.ok(svg.includes('viewBox="0 0 24 24"'), name + ' 的 viewBox 不是 24×24');
        assert.ok(svg.includes('stroke="currentColor"'), name + ' 没有继承文字色');
    }
    // 52 旧 + 12 新 + 2（v8 第十六批：对象栈工具条的 chevron-up / merge-down）
    // + 2（v8 第二十批：画板纹理尺寸控件的 crop-content / canvas-resize）
    // + 5（v10 第二十一批：预览播放的 loop / pingpong / loop-reverse / play-once / gauge）。
    // 数量锁死是为了防「悄悄加一枚又删一枚」的净零漂移。
    assert.equal(ICON_NAMES.length, 74, '图标表应为 52 旧 + 12 新 + 2 对象栈 + 2 尺寸控件 + 1 unlink + 5 播放 = 74，实际 ' + ICON_NAMES.length);
    for (const name of ['loop', 'pingpong', 'loop-reverse', 'play-once', 'gauge']) {
        assert.ok(hasIcon(name), '预览播放控件要用：' + name);
    }
    // 对象栈工具条（v8 第十六批）的两枚：删掉会静默变成空白按钮
    for (const name of ['chevron-up', 'merge-down']) {
        assert.ok(hasIcon(name), '对象栈工具条要用：' + name);
    }
    // 画板纹理尺寸控件（task-30）追加的两枚，只追加不改既有键
    for (const name of ['crop-content', 'canvas-resize']) {
        assert.ok(hasIcon(name), '画板尺寸控件要用：' + name);
        const svg = icon(name);
        assert.ok(svg.includes('viewBox="0 0 24 24"'), name + ' 的 viewBox 不是 24×24');
        assert.ok(svg.includes('stroke="currentColor"'), name + ' 没有继承文字色');
    }
    // 第七支笔复用既有键，不许再新建一个橡皮语义
    assert.ok(hasIcon('eraser'), 'eraser 必须还在（第七支笔用它，不新建）');
});

test('task-24：图标表里不许留同义别名', () => {
    // 一个动作一个名字。这几个最容易复发（画板工具条与工具面板容易各叫一套）。
    for (const alias of ['pen', 'fill', 'picker', 'hand']) {
        assert.ok(!hasIcon(alias), '别名「' + alias + '」不该出现在表里，应复用工具条那套名字');
    }
    // 'brush'（画板工具条那支画笔）与 'brush-*'（六支笔刷预设）是两个层级，不算别名
    assert.ok(hasIcon('brush'), '工具条的 brush 必须还在');
    assert.ok(hasIcon('brush-round'), '笔刷预设的 brush-round 必须还在');
});

test('task-24：三档 stroke 必须由尺寸算出，不许回退成常数', () => {
    const css = read('../app/styles/icons.css');
    assert.match(css, /stroke-width: calc\(1\.3 \* 24 \/ var\(--icon-px\)\)/,
        'stroke 必须写成尺寸的函数（1.3 × 24 / --icon-px），否则三档粗细各不相同');
    for (const px of ['14', '16', '28']) {
        assert.match(css, new RegExp('--icon-px: ' + px + ';'),
            '缺少 --icon-px: ' + px + '（要与 tokens.css 的 --icon-sm/--icon/--icon-lg 对应）');
    }
    // 主规则里一旦出现写死的 stroke-width 数字，那一档就会独立跑偏
    const block = /\.ms-icon \{[^}]*\}/.exec(css);
    assert.ok(block, '找不到 .ms-icon 主规则');
    assert.ok(!/stroke-width: *[0-9.]+;/.test(block[0]),
        '.ms-icon 主规则里不许写死 stroke-width 常数（会让某一档粗细跑偏）');
});
