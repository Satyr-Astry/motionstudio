// 属性面板外壳（契约 v7）。七组固定顺序，按两段排：
//   段一「对象」：对象 → 纹理 → 变换 → 效果（有选中对象才出现）；段二「工程」：时间与时长 → 洋葱皮 → 信息
// 纹理组也依附「当前对象、当前时刻那张图」，所以排进段一（不是段二的全局参数），
// 位置固定为「对象」之后、「变换」之前；它不进 OBJECT_KEYS —— 那 2 个组的显隐由外壳自己
// 逐个关，纹理跟着段一走就够了。
// 组由各模块自建，外壳只做四件事：分段、排顺序、管显隐、转发 refresh。段样式全内联——panels.css 没有
// .prop-section 的规则，而本文件不许改 CSS；「时间轴帧率分段」已搬到独立挂载的「文档」编辑器。
import { mount as mountObject } from './prop-object.mjs';
import { mount as mountDoc } from './prop-doc.mjs';
import { mount as mountOnion } from './prop-onion.mjs';
import { mount as mountInfo } from './prop-info.mjs';
import { mount as mountTextures } from './prop-textures.mjs';

/** 固定的分组顺序，按 .prop-body[data-k] 认组（标题文案可以改，顺序靠这个锁死）。 */
const ORDER = ['object', 'textures', 'xform', 'effects', 'time', 'onion', 'info'];
/** 无选中对象时隐藏的组：对象元信息与效果链都只属于「某一个对象」。 */
const OBJECT_KEYS = ['object', 'effects'];

/** 两段：段一依附当前对象，段二全是全局参数。段标题与组标题同高（--h-bar），靠字号/描边分层级。 */
const SECTIONS = [
    { key: 'object', title: '对象', keys: ['object', 'textures', 'xform', 'effects'] },
    { key: 'doc', title: '工程', keys: ['time', 'onion', 'info'] },
];
const SEC_BOX = 'display:flex;flex-direction:column;flex:0 0 auto;';
const SEC_SPLIT = 'border-top:1px solid var(--line-2);'; // 段间分隔线画在段二上边
const SEC_TITLE =
    'display:flex;align-items:center;height:var(--h-bar);padding:0 8px;background:transparent;' +
    'border-bottom:1px solid var(--line-2);color:var(--ink-faint, #6b7280);font-size:10px;' +
    'font-weight:600;letter-spacing:1.2px;white-space:nowrap;';

/** 建段容器（标题行 + 之后塞进去的 .prop-group）。 */
function makeSection(sec, split) {
    const box = document.createElement('div');
    box.className = 'prop-section';
    box.dataset.sec = sec.key;
    box.style.cssText = split ? SEC_BOX + SEC_SPLIT : SEC_BOX;
    const head = document.createElement('div');
    head.className = 'prop-section-title';
    head.textContent = sec.title;
    head.style.cssText = SEC_TITLE;
    box.appendChild(head);
    return box;
}

/** 取某一组的 .prop-group 外壳（找不到返回 null）。 */
function groupOf(root, key) {
    const body = root.querySelector('.prop-body[data-k="' + key + '"]');
    return body && body.closest ? body.closest('.prop-group') : null;
}

export function mount(el, ctx) {
    const root = document.createElement('div');
    root.className = 'prop';
    el.appendChild(root);

    // 挂载顺序决定初始顺序，下面的 ORDER 循环只是把它锁死（幂等：重复执行不会改变结果）
    const objectPanel = mountObject(root, ctx);
    const texturesPanel = mountTextures(root, ctx);
    const docPanel = mountDoc(root, ctx, { timebase: false }); // 帧率分段不进属性面板
    const onionPanel = mountOnion(root, ctx);
    const infoPanel = mountInfo(root, ctx);

    const emptyHint = document.createElement('div');
    emptyHint.className = 'prop-empty';
    emptyHint.textContent = '等待文档…';
    emptyHint.style.cssText = 'padding:12px;color:var(--ink-faint, #6b7280);';
    emptyHint.hidden = true;
    root.appendChild(emptyHint);

    // 分段 + 排序一次算清：每组先认自己属于哪一段，段内先后 = ORDER 里的先后
    const boxes = SECTIONS.map((sec, i) => makeSection(sec, i > 0));
    const boxOf = new Map();
    SECTIONS.forEach((sec, i) => sec.keys.forEach((k) => boxOf.set(k, i))); // key → 段下标
    const groups = new Map();
    for (const key of ORDER) {
        const g = groupOf(root, key);
        if (!g) continue;
        groups.set(key, g);
        boxes[boxOf.has(key) ? boxOf.get(key) : boxes.length - 1].appendChild(g);
        g.classList.toggle('is-object', OBJECT_KEYS.indexOf(key) >= 0);
    }
    // 两段整体/依次插到最前：模块多建的组（不在 ORDER 里）自然落到段后
    const frag = document.createDocumentFragment();
    for (const box of boxes) {
        // 空段（模块一个组都没建出来）不占位，避免只剩一行标题的空壳
        if (box.children.length > 1) frag.appendChild(box);
    }
    root.insertBefore(frag, root.firstChild);
    const objectGroups = OBJECT_KEYS.map((k) => groups.get(k)).filter(Boolean);

    function paint() {
        const doc = ctx.doc();
        // 段一（对象/变换/效果）只在有选中对象时出现，避免「全局设置」与「某个对象的设置」搅在一起。
        // 选中态有两个来源：ctx.selection() 与 ctx.activeLayerId()，任一有 id 就显示段一。
        const selNow = typeof ctx.selection === 'function' ? ctx.selection() : null;
        const activeNow = typeof ctx.activeLayerId === 'function' ? ctx.activeLayerId() : null;
        const hasSel = !!((selNow && selNow.id) || activeNow);
        // 用内联 display 而不是 hidden：.prop-section / .prop-group 都自带 display，hidden 会被压掉
        boxes[0].style.display = hasSel ? '' : 'none';
        for (const box of objectGroups) box.style.display = hasSel ? '' : 'none';
        emptyHint.hidden = !!doc;
        // 各组的「无文档」分支都在自己模块里，这里只转发；refresh 不碰 scrollTop，滚动位置始终保留
        docPanel.refresh();
        onionPanel.refresh();
        infoPanel.refresh();
        texturesPanel.refresh();
        objectPanel.refresh();
    }

    const off = typeof ctx.subscribeDoc === 'function' ? ctx.subscribeDoc(() => paint()) : () => {};
    paint();
    // 挂载后回到顶部：滚动容器是 .prop 本体（CSS height:100% + overflow-y:auto），外壳容器也归零
    root.scrollTop = 0;
    el.scrollTop = 0;

    return {
        refresh: paint,
        destroy() {
            off();
            for (const p of [objectPanel, texturesPanel, docPanel, onionPanel, infoPanel]) {
                if (p && typeof p.destroy === 'function') p.destroy();
            }
            root.remove();
        },
    };
}
