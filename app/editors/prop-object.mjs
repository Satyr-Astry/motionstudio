// 对象级属性，三组：对象（名字 / 种类 / 尺寸 / 不透明度）→ 变换（内嵌 xform.mjs 的 8 标量 /
// 四角变形 / 缓动 / 关键帧导航）→ 效果（当前活动对象的滤镜链，渲染时由外壳转成 canvas filter）。
// 组的顺序与显隐由外壳 properties.mjs 统一控制：没有选中对象时「对象」与「效果」整组隐藏。

import { effectAt, findEffectById } from '../paint/effects.mjs';
import { objectSize, setObjectSize, objectById, BONE_DEFAULTS } from '../core/doc-model.mjs';
import { patchLayer } from '../core/cel.mjs';
import { skinOf } from '../core/skin.mjs';
import { IK_DEFAULTS, IK_MAX_CHAIN, normalizeIk } from '../core/ik.mjs';
import { createSurface } from '../paint/surface.mjs';
import { createXformPanel } from './xform.mjs';
import { icon } from '../core/icons.mjs';
import { makeGroup, makeRow, makeText, makeValue, makeNum, makeNumPair, activeObj } from './prop-kit.mjs';
import { t } from '../i18n/index.mjs';

// 种类是存档值（CONTRACT-v2 §1：kind = 'paint' 手绘 / 'image' 导入图片 / 'bone' 骨骼），这里只剩
// 「值 → 词条键」，显示名在 `app/i18n/parts/effects.mjs` 的 `kind.*`。
// 认不出的 kind 直接显示原值，不吞信息。
const KIND_KEYS = { paint: 'kind.paint', image: 'kind.image', bone: 'kind.bone' };

/** 种类显示名。认不出的 kind 原样回显，空值给破折号（与旧 KIND_TEXT 兜底同口径）。 */
function kindText(kind) {
    const key = KIND_KEYS[kind];
    return key ? t(key) : kind || '—';
}

/** 藏掉内嵌 xform 里的某一行标量（按 input[data-field] 找行，找不到就当没这行）。 */
function hideField(xfEl, field) {
    if (!xfEl || typeof xfEl.querySelectorAll !== 'function') return;
    for (const row of xfEl.querySelectorAll('.xf-row')) {
        if (row.querySelector && row.querySelector('input[data-field="' + field + '"]')) {
            // 契约 v7：显隐一律用内联 display，不用 hidden 属性（.xf-row 自带 display:flex）
            row.style.display = 'none';
        }
    }
}

export function mount(el, ctx) {
    // ── 对象：这一组回答「这是什么对象」，下面两组回答「它怎么动、加了什么滤镜」
    const objBody = makeGroup(el, t('props.obj.group'), 'object');
    const nameInput = makeText(objBody, t('props.obj.name'), { key: 'obj-name', maxLength: 60, placeholder: t('props.obj.namePlaceholder') });
    const kindVal = makeValue(objBody, t('props.obj.kind'), '—');
    // 尺寸 = 对象自己的画布，宽 / 高并排两个可编辑框。
    // 旧版这里是 makeValue 的只读文本：能看见「900 × 640」却改不了，正是「不能自定义对象尺寸」的根因。
    const sizePair = makeNumPair(objBody, t('props.obj.size'), { min: 1, max: 4096, step: 1, key: 'obj-size', placeholder: t('props.obj.sizeWidth') });
    const sizeW = sizePair.w;
    const sizeH = sizePair.h;
    // 两个光秃秃的数字框看不出哪个是宽、哪个是高 —— 没有位图的对象还会被清空成占位符，
    // 连「—」都读不出方向。用 placeholder 把方向写死（有值时靠标题与中间的 × 区分），
    // 再补 aria-label 让读屏也能读出「宽 / 高」。
    // 不在框外加「宽」「高」小标签：.prop-val 有自己的固定宽度，两个前缀会把
    // 两个输入框从 92px 挤到 35px，那是拿可读性换可读性。
    sizeH.placeholder = t('props.obj.sizeHeight');
    sizeW.setAttribute('aria-label', t('props.obj.sizeWidthAria'));
    sizeH.setAttribute('aria-label', t('props.obj.sizeHeightAria'));
    const opacityInput = makeNum(objBody, t('props.obj.opacity'), { min: 0, max: 100, step: 1, value: 100, key: 'obj-opacity' });
    opacityInput.title = t('props.obj.opacityTitle');
    // 补一个单位后缀：光秃秃的 0–100 会被读成像素
    const opacityUnit = document.createElement('span');
    opacityUnit.className = 'prop-val';
    opacityUnit.textContent = '%';
    opacityInput.parentNode.appendChild(opacityUnit);

    // 显示 / 隐藏：与对象列表里的眼睛按钮同一个 visible 字段。
    // 以前只能去对象面板点眼睛，属性面板里看不见这个开关 —— 用户在同一个对象上要来回切两个面板。
    const visRow = makeRow(objBody, t('props.obj.show'));
    const visInput = document.createElement('input');
    visInput.type = 'checkbox';
    visInput.className = 'prop-check';
    visInput.title = t('props.obj.visTitle');
    visRow.appendChild(visInput);
    const visText = document.createElement('span');
    visText.className = 'prop-val';
    visText.textContent = t('props.obj.visible');
    visRow.appendChild(visText);
    visInput.addEventListener('change', () => {
        const layer = activeObj(ctx, ctx.doc());
        if (!layer) return;
        const next = !!visInput.checked;
        visText.textContent = next ? t('props.obj.visible') : t('props.obj.hidden');
        ctx.setDoc((d) => Object.assign({}, d, {
            objects: (d.objects || []).map((o) => (o && o.id === layer.id ? Object.assign({}, o, { visible: next }) : o)),
        }), { label: next ? t('props.obj.showObject') : t('props.obj.hideObject') });
    });

    // 旋转 / 缩放的原点（anchor）：归一化百分比，相对对象自己的画布。
    // 这是「绕哪里转」的唯一入口 —— 之前只有默认值，用户没法改。
    const anchorPair = makeNumPair(objBody, t('props.obj.anchorPair'), { min: 0, max: 100, step: 1, key: 'obj-anchor', placeholder: '50' });
    const anchorX = anchorPair.w;
    const anchorY = anchorPair.h;
    anchorX.title = t('props.obj.anchor.titleX');
    anchorY.title = t('props.obj.anchor.titleY');
    const anchorCenter = document.createElement('button');
    anchorCenter.type = 'button';
    anchorCenter.className = 'prop-seg prop-anchor-center ms-icon-label';
    anchorCenter.innerHTML = icon('center') + '<span>' + t('props.obj.anchor.center') + '</span>';
    anchorCenter.title = t('props.obj.anchorTitle');
    anchorCenter.setAttribute('aria-label', anchorCenter.title);
    anchorCenter.addEventListener('click', () => {
        const layer = activeObj(ctx, ctx.doc());
        if (!layer) return;
        ctx.setAnchor(layer.id, { x: 0.5, y: 0.5 });
        refresh();
    });
    anchorCenter.style.marginLeft = '4px';
    // 一次性插进字段行末尾（w × h [居中]）
    if (anchorPair && anchorPair.w && anchorPair.w.parentNode) anchorPair.w.parentNode.appendChild(anchorCenter);
    // 两个输入框：change 提交、Enter 也提交（Electron 里没有 prompt，交互一律就地）
    const commitAnchor = () => {
        const layer = activeObj(ctx, ctx.doc());
        if (!layer) return;
        const read = (el, fallback) => {
            const v = Number(el.value);
            return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) / 100 : fallback;
        };
        const cur = layer.anchor || { x: 0, y: 0 };
        const next = { x: read(anchorX, cur.x), y: read(anchorY, cur.y) };
        if (Math.abs(next.x - cur.x) < 1e-6 && Math.abs(next.y - cur.y) < 1e-6) return;
        if (typeof ctx.setAnchor === 'function') ctx.setAnchor(layer.id, next);
        refresh();
    };
    anchorX.addEventListener('change', commitAnchor);
    anchorY.addEventListener('change', commitAnchor);
    for (const el of [anchorX, anchorY]) {
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitAnchor(); }
        });
    }

    // ── 父对象 / 脱离父级（L5：属性面板承认父子关系。只加这两行，不改 ORDER 顺序）
    //    「父对象」是可点的链接：点一下把选中跳到父对象（ctx.setSelection）。
    //    「脱离父级」走 ctx.setLayerParent(id, null)：它内部已经做环检测并 flash 失败原因，
    //    所以这里返回 false 就什么都不做 —— 不允许先改 UI 再回滚。
    const parentField = makeRow(objBody, t('props.obj.parent'));
    const parentLink = document.createElement('button');
    parentLink.type = 'button';
    parentLink.className = 'prop-link';
    parentLink.textContent = t('props.obj.noParent');
    parentLink.addEventListener('click', () => {
        const layer = activeObj(ctx, ctx.doc());
        if (!layer || !layer.parentId) return;
        ctx.setSelection({ id: layer.parentId });
    });
    parentField.appendChild(parentLink);

    const detachField = makeRow(objBody, t('props.obj.parentGroup'));
    const detachBtn = document.createElement('button');
    detachBtn.type = 'button';
    detachBtn.className = 'prop-seg ms-icon-label';
    detachBtn.innerHTML = icon('unlink') + '<span>' + t('props.obj.detach') + '</span>';
    // 稳定标识：它和「居中」共用 .prop-seg.ms-icon-label，靠类名定位会抓错（真实踩过）
    detachBtn.setAttribute('data-act', 'detach');
    detachBtn.addEventListener('click', () => {
        const layer = activeObj(ctx, ctx.doc());
        if (!layer || !layer.parentId) return;
        if (!ctx.setLayerParent(layer.id, null)) return;   // 失败原因由 ctx 提示，UI 保持原状
        refresh();
    });
    detachField.appendChild(detachBtn);

    // ── 骨骼（只有 kind === 'bone' 的对象才出现这一段：长度 / 粗细 / 颜色）
    //    骨骼没有纹理，它在画布上的样子完全由这三个字段决定，所以必须能就地调；
    //    非骨骼对象整组隐藏（内联 display，与外壳 properties.mjs 的显隐口径一致）。
    const boneBody = makeGroup(el, t('props.obj.groupBone'), 'bone');
    const boneLen = makeNum(boneBody, t('props.obj.boneLen'), { min: 8, max: 4096, step: 1, value: BONE_DEFAULTS.len, key: 'bone-len' });
    const boneWidth = makeNum(boneBody, t('props.obj.boneWidth'), { min: 2, max: 256, step: 1, value: BONE_DEFAULTS.width, key: 'bone-width' });
    // 颜色行没有现成工厂：照抄 makeParamRow 里那个 <input type="color"> 的写法，
    // 复用 .prop-num 拿到与数字框一致的外观（panels.css 没有单独的 .prop-color）。
    const boneColorField = makeRow(boneBody, t('props.obj.boneColor'));
    const boneColor = document.createElement('input');
    boneColor.type = 'color';
    boneColor.className = 'prop-num';
    boneColor.value = BONE_DEFAULTS.color;
    boneColor.dataset.k = 'bone-color';
    boneColor.style.flex = '1 1 auto';
    boneColor.style.width = 'auto';
    boneColorField.appendChild(boneColor);

    // ── 蒙皮段（骨骼 P2-B）：只在带 skin 的对象上出现。
    //    写口只有 app.mjs 那一份（命令表与这里共用 ctx.unbindSkinOfSelected）：面板只读摘要
    //    + 一个解绑按钮。权重编辑是 P2-C，这里故意不给第二个可写字段 —— 摘要读 skinOf，
    //    core 会顺手把坏数据洗成 null，面板与求值器看的是同一份判断。
    const skinBody = makeGroup(el, t('props.obj.groupSkin'), 'skin');
    const skinSummary = makeValue(skinBody, '', '—');
    skinSummary.dataset.k = 'skin-summary';
    const skinOffField = makeRow(skinBody, '');
    const skinOffBtn = document.createElement('button');
    skinOffBtn.type = 'button';
    skinOffBtn.className = 'prop-seg';
    skinOffBtn.dataset.k = 'skin-unbind';
    skinOffBtn.textContent = t('props.obj.skinUnbind');
    skinOffBtn.title = t('props.obj.skinUnbindTitle');
    skinOffBtn.setAttribute('aria-label', skinOffBtn.title);
    skinOffBtn.addEventListener('click', () => {
        const layer = activeLayer(ctx.doc());
        if (!layer) return;
        if (typeof ctx.unbindSkinOfSelected === 'function') ctx.unbindSkinOfSelected(layer.id);
    });
    skinOffField.appendChild(skinOffBtn);

    // ── 权重编辑（P2-C 步 1）：只切「叠加态」的开关，一个权重都不写（写入是步 2）。
    //    两个控件的真值都在 ctx 的外壳态里，面板不存自己的副本 —— 否则撤销 / 换对象 / 解绑
    //    之后面板与画布会各说各话。状态一律由 paintSkin 回填。
    const weightField = makeRow(skinBody, '');
    const weightBtn = document.createElement('button');
    weightBtn.type = 'button';
    weightBtn.className = 'prop-seg';
    weightBtn.dataset.k = 'weight-edit';
    weightBtn.textContent = t('props.obj.weightEdit');
    weightBtn.title = t('props.obj.weightEditTitle');
    weightBtn.setAttribute('aria-label', weightBtn.title);
    weightBtn.setAttribute('aria-pressed', 'false');
    weightBtn.addEventListener('click', () => {
        if (typeof ctx.setWeightMode !== 'function') return;
        if (typeof ctx.weightMode === 'function' && ctx.weightMode()) {
            ctx.setWeightMode(false);
            return;
        }
        // 先回到选择工具：蒙皮顶点是靠命中判定点的，画笔工具下点击会先被引擎吃掉
        if (typeof ctx.setTool === 'function') ctx.setTool('select');
        ctx.setWeightMode(true);
    });
    weightField.appendChild(weightBtn);

    // 目标骨：只列这个蒙皮对象真正绑定的骨骼，没有就明说没有 —— 不给「猜一根」的余地
    const weightBoneField = makeRow(skinBody, t('props.obj.weightBone'));
    const weightBoneSel = document.createElement('select');
    weightBoneSel.className = 'prop-num';
    weightBoneSel.dataset.k = 'weight-bone';
    weightBoneSel.style.flex = '1 1 auto';
    weightBoneSel.addEventListener('change', () => {
        if (typeof ctx.setWeightBone === 'function') ctx.setWeightBone(weightBoneSel.value || null);
    });
    weightBoneField.appendChild(weightBoneSel);

    /** 读一个骨骼数字框：取整并夹进区间；空串 / 非数字返回 null（调用方回滚显示）。 */
    function boneValue(input, min, max) {
        const raw = Number(String(input.value == null ? '' : input.value).trim());
        if (!Number.isFinite(raw)) return null;
        return Math.max(min, Math.min(max, Math.round(raw)));
    }

    /**
     * 骨骼三行共用的写口：只改 `el.bone`，不碰变换通道。
     *
     * 走 patchActive（ctx.setDoc + patchLayer），与对象名字 / 不透明度同一条路径 ——
     * 一次改动就是撤销栈里的一步，不因为它是「新字段」就多出第二种写法。
     * core 侧还有一层 normalizeBone 兜底（夹取 + 颜色白名单），这里夹一遍只是为了让
     * 输入框立刻显示合法值，不把「被拒绝的输入」留在界面上。
     */
    function commitBone(patch) {
        const doc = ctx.doc();
        const layer = doc ? activeLayer(doc) : null;
        if (!layer || layer.kind !== 'bone') return;
        const cur = layer.bone && typeof layer.bone === 'object' ? layer.bone : BONE_DEFAULTS;
        const base = {
            len: Number.isFinite(cur.len) ? cur.len : BONE_DEFAULTS.len,
            width: Number.isFinite(cur.width) ? cur.width : BONE_DEFAULTS.width,
            color: typeof cur.color === 'string' ? cur.color : BONE_DEFAULTS.color,
        };
        const next = Object.assign(base, patch);
        if (next.len === base.len && next.width === base.width && next.color === base.color) return;
        patchActive({ bone: next });
        refresh();
    }

    for (const [input, field, min, max, fallback] of [
        [boneLen, 'len', 8, 4096, BONE_DEFAULTS.len],
        [boneWidth, 'width', 2, 256, BONE_DEFAULTS.width],
    ]) {
        input.addEventListener('change', () => {
            const v = boneValue(input, min, max);
            if (v == null) { input.value = String(fallback); return; }
            commitBone({ [field]: v });
        });
        // number 框只在失焦 / 回车时发 change：回车显式补一次（与尺寸行同一范式）
        input.addEventListener('keydown', (ev) => {
            if (ev.key !== 'Enter') return;
            ev.preventDefault();
            const v = boneValue(input, min, max);
            if (v != null) commitBone({ [field]: v });
        });
    }
    boneColor.addEventListener('change', () => {
        // 统一小写：core 的 normalizeBone 也这么做，避免 #ABC / #abc 在存档里变成两个值
        commitBone({ color: String(boneColor.value || BONE_DEFAULTS.color).toLowerCase() });
    });

    // ── IK 约束（骨骼 P3）：只有骨骼出现。
    //    约束挂在**链尾骨骼**上，目标点选「另一个普通对象」—— 于是目标可以用已有的
    //    变换通道打关键帧，「动画 IK 目标」不需要任何新的动画 UI。
    //    解算结果只进渲染矩阵、不回写关键帧（见 docs/IK设计-2026-11-02.md），
    //    所以面板显示的关键帧值可能与画布上的姿态不同，这是设计，不是 bug。
    const ikBody = makeGroup(el, t('props.obj.groupIk'), 'ik');
    const ikOnField = makeRow(ikBody, t('props.obj.ikEnabled'));
    const ikOn = document.createElement('input');
    ikOn.type = 'checkbox';
    ikOn.dataset.k = 'ik-enabled';
    ikOn.style.margin = '0';
    ikOnField.appendChild(ikOn);

    const ikTargetField = makeRow(ikBody, t('props.obj.ikTarget'));
    const ikTarget = document.createElement('select');
    ikTarget.className = 'prop-num';
    ikTarget.dataset.k = 'ik-target';
    ikTarget.style.flex = '1 1 auto';
    ikTarget.style.width = 'auto';
    ikTargetField.appendChild(ikTarget);

    const ikChain = makeNum(ikBody, t('props.obj.ikChain'), {
        min: 1, max: IK_MAX_CHAIN, step: 1, value: IK_DEFAULTS.chain, key: 'ik-chain',
    });

    /** 当前对象的 IK 约束（已归一；没有就是 null）。 */
    function ikOf(layer) {
        return layer ? normalizeIk(layer.ik) : null;
    }

    /**
     * IK 三行共用的写口：只改 `el.ik`，走 patchActive（一次改动一步撤销）。
     *
     * 没有目标时写 `null` 而不是留一条空对象：`normalizeIk` 对 null 返回 null，
     * 存档白名单因此也不会写这一项 —— 「没有目标 = 没有约束」在数据里是一条明确事实，
     * 不是一个 `targetId: ''` 的空壳。
     */
    function commitIk(patch) {
        const doc = ctx.doc();
        const layer = doc ? activeLayer(doc) : null;
        if (!layer || layer.kind !== 'bone') return;
        const cur = ikOf(layer);
        const base = {
            targetId: cur ? cur.targetId : '',
            chain: cur ? cur.chain : IK_DEFAULTS.chain,
            iterations: cur ? cur.iterations : IK_DEFAULTS.iterations,
            enabled: cur ? cur.enabled : IK_DEFAULTS.enabled,
        };
        const next = Object.assign(base, patch);
        if (cur && next.targetId === base.targetId && next.chain === base.chain
            && next.iterations === base.iterations && next.enabled === base.enabled) return;
        patchActive({ ik: next.targetId ? next : null });
        refresh();
    }

    ikOn.addEventListener('change', () => commitIk({ enabled: !!ikOn.checked }));
    ikTarget.addEventListener('change', () => commitIk({ targetId: String(ikTarget.value || '') }));
    for (const ev of ['change', 'keydown']) {
        ikChain.addEventListener(ev, (e) => {
            if (ev === 'keydown' && (!e || e.key !== 'Enter')) return;
            if (ev === 'keydown') e.preventDefault();
            const v = boneValue(ikChain, 1, IK_MAX_CHAIN);
            if (v == null) { ikChain.value = String(IK_DEFAULTS.chain); return; }
            commitIk({ chain: v });
        });
    }

    // ── 变换（xform 内嵌）
    const xformBody = makeGroup(el, t('props.obj.groupXform'), 'xform');
    const xform = createXformPanel(ctx);
    xformBody.appendChild(xform.el);
    // 去重：不透明度只在上面「对象」组出现一次。xform 那行写的是「变换关键帧的 opacity 通道」，
    // 和对象级 layer.opacity 不是同一个量，但同名同排版摆在同一面板里就是第三个入口。
    // 不动 xform.mjs，只把它这一行藏起来；要动画 opacity 去曲线编辑器（那里有同名通道）。
    hideField(xform.el, 'opacity');

    // ── 效果（当前活动对象的滤镜链；渲染时由外壳转成 canvas filter）
    const fxBody = makeGroup(el, t('props.obj.groupFx'), 'effects');
    const fxList = document.createElement('div');
    fxList.className = 'fx-list';
    const fxEmpty = document.createElement('div');
    fxEmpty.className = 'fx-empty';
    fxEmpty.textContent = t('effect.ui.empty');
    const fxAdd = document.createElement('div');
    fxAdd.className = 'fx-add';
    fxBody.append(fxEmpty, fxList, fxAdd);

    const EFFECT_DEFS = ctx.effectDefs || [];

    for (const def of EFFECT_DEFS) {
        const b = document.createElement('button');
        b.type = 'button';
        // 「＋名字」的加号换成了效果自身的图标：模糊/外发光/投影/调整/描边各一个，
        // 五个胶囊一眼能分出种类；「这是添加动作」由 title 与 hover 色说清。
        b.className = 'ms-icon-label';
        b.innerHTML = icon(def.id, { size: 'sm' }) + '<span>' + t(def.nameKey) + '</span>';
        b.title = t('effect.ui.add', { name: t(def.nameKey) });
        b.setAttribute('aria-label', b.title);
        b.addEventListener('click', () => {
            const doc = ctx.doc();
            const layer = doc ? activeLayer(doc) : null;
            if (!layer || typeof ctx.setLayerEffects !== 'function') return;
            const effects = (layer.effects || []).concat([ctx.makeEffect(def.id)]);
            ctx.setLayerEffects(layer.id, effects);
        });
        fxAdd.appendChild(b);
    }

    // 取对象逻辑与 activeObj 一致（活动对象命中优先）
    function activeLayer(doc) {
        return activeObj(ctx, doc);
    }

    // ── 对象组写入：名字与不透明度都是对象级静态字段，走 patchLayer，不碰关键帧通道
    function patchActive(patch) {
        const doc = ctx.doc();
        if (!doc || typeof ctx.setDoc !== 'function') return false;
        const layer = activeLayer(doc);
        if (!layer) return false;
        ctx.setDoc((d) => patchLayer(d, layer.id, patch));
        return true;
    }

    /** 尺寸行的说明：对象自己的画布 ≠ 文档尺寸；改它等于把位图整张拉伸。 */
    function sizeTitle(doc) {
        const dt = doc && doc.width > 0 && doc.height > 0 ? t('props.obj.sizeDoc', { w: doc.width, h: doc.height }) : '';
        return t('props.obj.sizeHint', { doc: dt });
    }

    /** 读一个尺寸框：夹成 1..4096 的整数；空串 / 非数字返回 null（调用方回滚显示）。 */
    function sideValue(raw) {
        const txt = String(raw == null ? '' : raw).trim();
        if (!txt) return null;
        const n = Number(txt);
        if (!Number.isFinite(n)) return null;
        return Math.max(1, Math.min(4096, Math.round(n)));
    }

    /**
     * 提交一次尺寸改动（change / Enter）。
     *
     * 优先走外壳的 ctx.setObjectSize：它封装了「把每个纹理的位图整张拉伸 + 一次 setDoc」。
     * 该入口若没挂到这个 ctx 上（本文件禁止改外壳），就退到同一套做法的就地版本：
     * 调同一条 doc-model 纯函数，再交给 ctx.setDoc —— 两条路在撤销栈里都只记一步。
     * 不自己调 render：setDoc 内部的 commitDoc 已经 scheduleRender + 广播刷新面板，
     * 再画一遍就是白烧一帧。
     */
    function commitSize() {
        const doc = ctx.doc();
        const layer = doc ? activeLayer(doc) : null;
        if (!layer) return;
        const cur = objectSize(layer);
        if (!cur) return; // 没有位图的对象不给改（此时两个框本来就是 disabled）
        const w = sideValue(sizeW.value);
        const h = sideValue(sizeH.value);
        if (w == null || h == null) {
            // 清空 / 非法输入：回滚成文档里的真实值，绝不把 NaN 写进尺寸
            sizeW.value = String(cur.w);
            sizeH.value = String(cur.h);
            return;
        }
        if (w === cur.w && h === cur.h) return;
        let applied = false;
        if (typeof ctx.setObjectSize === 'function') applied = !!ctx.setObjectSize(layer.id, w, h);
        if (!applied && typeof ctx.setDoc === 'function') {
            ctx.setDoc(
                (d) => {
                    const res = setObjectSize(d, layer.id, w, h, { makeCanvas: (cw, ch) => createSurface(cw, ch) });
                    return res.changed ? res.doc : d;
                },
                // 显式合并键：宽和高连改算同一步撤销；用专属键而不是缺省的 *auto，
                // 免得多步操作在 350ms 窗口里和别人的同类命令并成一条
                { label: t('props.obj.resizeUndo'), coalesce: 'obj-size:' + layer.id }
            );
        }
    }

    for (const input of [sizeW, sizeH]) {
        // number 框只在失焦 / 回车时发 change，正好对上「提交」语义：打字过程中不写文档
        input.addEventListener('change', commitSize);
        input.addEventListener('keydown', (ev) => {
            // 部分环境里回车不一定触发 change（值没被标脏），显式补一次；
            // 不 blur：回车后接着改另一维是常态，焦点留在框里
            if (ev.key === 'Enter') {
                ev.preventDefault();
                commitSize();
            }
        });
    }

    nameInput.addEventListener('change', () => {
        const doc = ctx.doc();
        const layer = doc ? activeLayer(doc) : null;
        if (!layer) return;
        // 连续空白折成一个空格：对象列表是单行省略号，多空格会把名字挤成一段空白
        const name = String(nameInput.value == null ? '' : nameInput.value).replace(/\s+/g, ' ').trim().slice(0, 60);
        // 空名字会让对象列表整行变成空白，回滚到原值，不把空串写进文档
        if (!name) { nameInput.value = layer.name || ''; return; }
        if (name === layer.name) return;
        patchActive({ name });
        refresh();
    });

    opacityInput.addEventListener('change', () => {
        const doc = ctx.doc();
        const layer = doc ? activeLayer(doc) : null;
        if (!layer) return;
        const base = layer.opacity == null ? 1 : layer.opacity;
        const raw = Number(opacityInput.value);
        if (!Number.isFinite(raw)) { opacityInput.value = String(Math.round(base * 100)); return; }
        patchActive({ opacity: Math.max(0, Math.min(100, raw)) / 100 });
        refresh();
    });

    /** 对象组：名字 / 种类 / 尺寸 / 不透明度 */
    function paintObject(doc) {
        const layer = doc ? activeLayer(doc) : null;
        nameInput.disabled = !layer;
        opacityInput.disabled = !layer;
        visInput.disabled = !layer;
        anchorX.disabled = !layer;
        anchorY.disabled = !layer;
        anchorCenter.disabled = !layer;
        // 没有位图的对象没有「自己的画布」：两个尺寸框禁用，清空值以露出「—」占位符
        const osz = layer ? objectSize(layer) : null;
        sizeW.disabled = !osz;
        sizeH.disabled = !osz;
        if (!layer) {
            nameInput.value = '';
            kindVal.textContent = '—';
            sizeW.value = '';
            sizeH.value = '';
            opacityInput.value = '';
            visInput.checked = false;
            visText.textContent = t('props.obj.visible');
            anchorX.value = '';
            anchorY.value = '';
            // 没有对象时父子行也回到「顶层 + 禁用」，否则会留着上一个对象的父对象名
            parentLink.disabled = true;
            parentLink.textContent = t('props.obj.noParent');
            detachBtn.disabled = true;
            return;
        }
        // 显示开关：与对象列表的眼睛按钮同源，这里只做镜像
        visInput.checked = layer.visible !== false;
        visText.textContent = layer.visible === false ? t('props.obj.hidden') : t('props.obj.visible');
        // 原点：文档里是 0–1，面板里显示成百分比整数
        const anchor = layer.anchor || { x: 0, y: 0 };
        if (document.activeElement !== anchorX) anchorX.value = String(Math.round(anchor.x * 100));
        if (document.activeElement !== anchorY) anchorY.value = String(Math.round(anchor.y * 100));

        // 正在编辑的输入框不回写，否则会把用户打到一半的字弹回原值（与 xform 同一焦点保护范式）
        if (document.activeElement !== nameInput) nameInput.value = layer.name == null ? '' : String(layer.name);
        kindVal.textContent = kindText(layer.kind);
        // 尺寸取自对象自己的「纸」（第一个有图的纹理）与文档尺寸无关；标题把这层区别讲清楚
        const title = sizeTitle(doc);
        // title 前缀保留「宽 / 高」的区分，后半句解释对象画布与文档尺寸的关系
        sizeW.title = t('props.obj.sizeTitleW', { hint: title });
        sizeH.title = t('props.obj.sizeTitleH', { hint: title });
        if (osz) {
            // 同一个焦点保护：正在改宽的时候，别被 doc 广播把高也顺手改了（反之亦然）
            if (document.activeElement !== sizeW) sizeW.value = String(osz.w);
            if (document.activeElement !== sizeH) sizeH.value = String(osz.h);
        } else {
            // disabled 的框收不到焦点，直接清空让占位符「—」顶上来
            sizeW.value = '';
            sizeH.value = '';
        }
        if (document.activeElement !== opacityInput) {
            opacityInput.value = String(Math.round((layer.opacity == null ? 1 : layer.opacity) * 100));
        }

        // 父子关系（L5）：父对象行可点击跳到父对象；顶层时禁用并说明。
        // 悬停说明写清「跟随什么」，因为这五个继承项在界面上没有其它地方会讲。
        const parent = layer.parentId ? objectById(doc, layer.parentId) : null;
        const parentName = parent ? (parent.name || parent.id) : '';
        parentLink.disabled = !parent;
        parentLink.textContent = parent ? parentName : t('props.obj.noParent');
        parentLink.title = parent
            ? t('props.obj.parentLink', { name: parentName })
            : t('props.obj.parentLinkTop');
        parentLink.setAttribute('aria-label', parentLink.title);
        detachBtn.disabled = !parent;
        detachBtn.title = parent
            ? t('props.obj.detachTitle')
            : t('props.obj.detachTitleTop');
        detachBtn.setAttribute('aria-label', detachBtn.title);
    }

    /** IK 组：只有骨骼出现；目标下拉列出「除自己以外」的对象（目标可以是任意对象）。 */
    function paintIk(doc) {
        const layer = doc ? activeLayer(doc) : null;
        const isBone = !!(layer && layer.kind === 'bone');
        const group = ikBody ? ikBody.parentNode : null;
        if (group) group.style.display = isBone ? '' : 'none';
        if (!isBone) return;
        const ik = ikOf(layer);
        ikOn.checked = !!(ik && ik.enabled);
        if (document.activeElement !== ikChain) ikChain.value = String(ik ? ik.chain : IK_DEFAULTS.chain);

        // 目标下拉：每次重建（对象可能增删改名），但只在内容真的变了时替换，
        // 否则用户展开下拉的瞬间会被重建打断。
        const list = [{ id: '', name: t('props.obj.ikNone') }]
            .concat((doc.objects || [])
                .filter((o) => o && o.id !== layer.id)
                .map((o) => ({ id: o.id, name: o.name || o.id })));
        const sig = list.map((o) => o.id + ':' + o.name).join('|');
        if (ikTarget.dataset.sig !== sig) {
            ikTarget.dataset.sig = sig;
            ikTarget.textContent = '';
            for (const o of list) {
                const opt = document.createElement('option');
                opt.value = o.id;
                opt.textContent = o.name;
                ikTarget.appendChild(opt);
            }
        }
        ikTarget.value = ik ? ik.targetId : '';
        // 没有目标就不可能解算：链长框灰掉比留一个能点但无效的输入框更诚实
        ikChain.disabled = !(ik && ik.targetId);
    }

    /** 骨骼组：只有 kind === 'bone' 的对象出现；取值时不覆盖正在编辑的输入框。 */
    function paintBone(doc) {
        const layer = doc ? activeLayer(doc) : null;
        const raw = layer && layer.kind === 'bone' ? layer.bone : null;
        const bone = layer && layer.kind === 'bone'
            ? (raw && typeof raw === 'object' ? raw : BONE_DEFAULTS)
            : null;
        // 组的显隐：doc 里没有对象 / 不是骨骼 → 整组收起，不留一行空壳
        const group = boneBody ? boneBody.parentNode : null;
        if (group) group.style.display = bone ? '' : 'none';
        if (!bone) return;
        const len = Number.isFinite(bone.len) ? bone.len : BONE_DEFAULTS.len;
        const width = Number.isFinite(bone.width) ? bone.width : BONE_DEFAULTS.width;
        const color = typeof bone.color === 'string' ? bone.color : BONE_DEFAULTS.color;
        if (document.activeElement !== boneLen) boneLen.value = String(len);
        if (document.activeElement !== boneWidth) boneWidth.value = String(width);
        if (document.activeElement !== boneColor) boneColor.value = color;
    }

    /** 蒙皮段：摘要「已绑 N 根骨 · 网格 4×4」；没有 skin 就整组收起（不留一行空壳）。 */
    function paintSkin(doc) {
        const layer = doc ? activeLayer(doc) : null;
        const skin = layer ? skinOf(layer) : null;
        const group = skinBody ? skinBody.parentNode : null;
        if (group) group.style.display = skin ? '' : 'none';
        const weightOn = typeof ctx.weightMode === 'function' ? !!ctx.weightMode() : false;
        weightBtn.textContent = t(weightOn ? 'props.obj.weightEditOff' : 'props.obj.weightEdit');
        weightBtn.setAttribute('aria-pressed', weightOn ? 'true' : 'false');
        if (!skin) {
            weightBoneSel.textContent = '';
            weightBoneSel.dataset.sig = '';
            // skin 没了就当退出权重态：残留的 active 会让画布去找一个不存在的对象
            if (weightOn && typeof ctx.setWeightMode === 'function') ctx.setWeightMode(false);
            return;
        }
        skinSummary.textContent = t('props.obj.skinSummary', {
            n: skin.bones.length,
            cols: skin.grid.cols,
            rows: skin.grid.rows,
        });
        // 目标骨下拉：选项 = 该 skin 绑定的骨骼（显示对象名，缺名字退回 id）。
        // 只在「选项集合或当前值」变了才重建，避免每次刷新都把用户正在展开的下拉收起来。
        const boneId = typeof ctx.weightBone === 'function' ? ctx.weightBone() : null;
        const opts = skin.bones.map((b) => {
            const bone = objectById(doc, b.id);
            return { id: b.id, label: (bone && bone.name) || b.id };
        });
        if (!opts.length) opts.push({ id: '', label: t('props.obj.weightBoneNone') });
        const sig = opts.map((o) => o.id + ':' + o.label).join('|') + '#' + (boneId || '');
        if (weightBoneSel.dataset.sig !== sig) {
            weightBoneSel.dataset.sig = sig;
            weightBoneSel.textContent = '';
            for (const o of opts) {
                const opt = document.createElement('option');
                opt.value = o.id;
                opt.textContent = o.label;
                weightBoneSel.appendChild(opt);
            }
            weightBoneSel.value = boneId || opts[0].id;
        }
    }

    let fxSig = '';

    function fxSignature(layer, effects) {
        // 签名只认「归属对象 + 效果身份序列」：轨道的有无**不再**进签名。
        // 一是自动打帧会让第一次拖动就建轨，签名一变就重建 DOM，正在拖的滑杆节点被换掉会中断拖动；
        // 二是有没有轨道下面有专门的就地同步分支（has-track / is-on），不需要靠重建刷新。
        // 身份用 `fx-<n>` id 而不是 type 序列：同类型两条效果互换位置时，靠 type 序列分不出来。
        // id 在载入 / 写入时就位，拖滑杆不会改它，所以不会中途跳变重建。
        return layer.id + '|' + effects.map((e) => (e && e.id) || e.type).join(',');
    }

    /** 该效果的某个参数当前是否有轨道 —— 每次都读文档，不能用构建时的快照 */
    function hasTrackOf(fx, key) {
        const trk = fx && fx.tracks ? fx.tracks[key] : null;
        return !!(trk && Array.isArray(trk.keys) && trk.keys.length);
    }

    function makeParamRow(def, param, value, onInput, hooks) {
        const row = document.createElement('div');
        row.className = 'fx-param';
        const lab = document.createElement('label');
        lab.textContent = t(param.labelKey);
        let input;
        let num = null;
        if (param.color) {
            input = document.createElement('input');
            input.type = 'color';
            input.value = typeof value === 'string' ? value : param.def;
        } else {
            input = document.createElement('input');
            input.type = 'range';
            input.min = String(param.min);
            input.max = String(param.max);
            input.step = String(param.step);
            input.value = String(value == null ? param.def : value);
            num = document.createElement('span');
            num.className = 'fx-num';
            num.textContent = String(Number(input.value));
        }
        input.dataset.fxKey = param.key;
        input.classList.toggle('has-track', !!(hooks && hooks.hasTrack));
        input.addEventListener('input', () => {
            const v = param.color ? input.value : Number(input.value);
            if (num) num.textContent = String(v);
            onInput(v);
        });
        row.append(lab, input);
        if (num) {
            row.appendChild(num);
            // ◆ = 该参数的关键帧开关：建帧 / 已有轨道时删轨（把当前值烘成静态）
            const keyBtn = document.createElement('button');
            keyBtn.type = 'button';
            keyBtn.className = 'fx-key';
            keyBtn.innerHTML = icon('diamond', { size: 'sm' });
            keyBtn.classList.toggle('is-on', !!(hooks && hooks.hasTrack));
            keyBtn.title = hooks && hooks.hasTrack
                ? t('effect.ui.clearHint')
                : t('effect.ui.keyHint');
            keyBtn.setAttribute('aria-label', hooks && hooks.hasTrack ? t('effect.ui.clearLabel') : t('effect.ui.keyLabel'));
            keyBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                if (hooks && hooks.onKey) hooks.onKey();
            });
            row.appendChild(keyBtn);
        }
        return row;
    }

    function paintFx(doc) {
        const layer = doc ? activeLayer(doc) : null;
        if (!layer || typeof ctx.setLayerEffects !== 'function') {
            fxList.textContent = '';
            fxSig = '';
            fxEmpty.hidden = false;
            fxEmpty.textContent = t('effect.ui.noObject');
            return;
        }
        const effects = Array.isArray(layer.effects) ? layer.effects : [];
        const sig = fxSignature(layer, effects);
        if (sig !== fxSig) {
            // 只有「效果种类/数量/归属对象」变了才重建 DOM —— 拖滑杆时不能重建，否则焦点丢失
            fxSig = sig;
            fxList.textContent = '';
            effects.forEach((fx) => {
                const def = EFFECT_DEFS.find((d) => d.id === fx.type);
                if (!def) return;
                const item = document.createElement('div');
                item.className = 'fx-item';
                item.dataset.fxId = String(fx.id || '');
                const head = document.createElement('div');
                head.className = 'fx-head';
                const nm = document.createElement('span');
                nm.className = 'fx-name';
                nm.textContent = t(def.nameKey);
                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'fx-del';
                del.innerHTML = icon('x', { size: 'sm' });
                del.title = t('effect.ui.remove', { name: t(def.nameKey) });
                del.setAttribute('aria-label', del.title);
                del.addEventListener('click', () => {
                    const cur = activeLayer(ctx.doc());
                    if (!cur) return;
                    // 按 id 删：闭包里的 idx 属于构建 DOM 时那份文档，重绘前可能已经对不上
                    const list = (cur.effects || []).filter((e) => !e || e.id !== fx.id);
                    ctx.setLayerEffects(cur.id, list);
                });
                head.append(nm, del);
                item.appendChild(head);
                for (const param of def.params) {
                    const hasTrack = hasTrackOf(fx, param.key);
                    const shown = hasTrack ? effectAt(fx, ctx.time())[param.key] : fx[param.key];
                    item.appendChild(
                        makeParamRow(def, param, shown, (v) => {
                            const cur = activeLayer(ctx.doc());
                            if (!cur) return;
                            const live = findEffectById(cur.effects || [], fx.id);
                            if (!live) return;
                            if (!param.color && typeof ctx.setEffectParam === 'function') {
                                // 与变换面板同一语义：拖数值 = 在当前时间打帧。
                                // 不打帧就只会改「全时间轴」的静态值，用户永远得不到 0 → 20px 的过渡。
                                if (!hasTrackOf(live, param.key) && typeof ctx.keyEffectParam === 'function') {
                                    ctx.keyEffectParam(cur.id, fx.id, param.key);
                                }
                                ctx.setEffectParam(cur.id, fx.id, param.key, v);
                                return;
                            }
                            // 颜色没有标量可插值（setEffectParam 只收数字），整条回写
                            const list = (cur.effects || []).map((e) =>
                                e && e.id === fx.id ? Object.assign({}, e, { [param.key]: v }) : e
                            );
                            ctx.setLayerEffects(cur.id, list);
                        }, {
                            hasTrack,
                            onKey: () => {
                                const cur = activeLayer(ctx.doc());
                                if (!cur) return;
                                const live = findEffectById(cur.effects || [], fx.id);
                                if (!live) return;
                                // 必须现查：同一效果里第二个之后的参数打帧不会重建 DOM，
                                // 闭包里那份 hasTrack 会一直停在 false，◆ 就再也清不掉轨道了
                                if (hasTrackOf(live, param.key)) {
                                    if (typeof ctx.clearEffectParam === 'function') ctx.clearEffectParam(cur.id, fx.id, param.key);
                                } else if (typeof ctx.keyEffectParam === 'function') {
                                    ctx.keyEffectParam(cur.id, fx.id, param.key);
                                }
                            },
                        })
                    );
                }
                fxList.appendChild(item);
            });
        } else {
            // 结构没变：只把外部改动同步进滑杆（正在编辑的控件不动）
            effects.forEach((fx) => {
                const def = EFFECT_DEFS.find((d) => d.id === fx.type);
                if (!def) return;
                // 按 id 找节点，不依赖「子节点顺序 === 数组顺序」
                const item = fxList.querySelector('[data-fx-id="' + fx.id + '"]');
                if (!item) return;
                for (const param of def.params) {
                    const input = item.querySelector('[data-fx-key="' + param.key + '"]');
                    if (!input) continue;
                    // 有轨道时显示该时间点的求值结果（拖播放头，滑杆读数跟着走）
                    const hasTrack = hasTrackOf(fx, param.key);
                    const src = hasTrack ? effectAt(fx, ctx.time()) : fx;
                    // ◆ 的状态先同步：拖动中滑杆自己就是 activeElement，若整行 skip，
                    // 刚打出来的帧在按钮上要等到失焦才看得出来
                    const keyBtn = input.parentElement && input.parentElement.querySelector('.fx-key');
                    if (keyBtn) {
                        keyBtn.classList.toggle('is-on', hasTrack);
                        // 不打帧就不会重建 DOM，标题也得在这里跟着换，否则提示和状态相反
                        keyBtn.title = hasTrack
                            ? t('effect.ui.clearHint')
                            : t('effect.ui.keyHint');
                    }
                    // 正在拖的控件不回写，否则会把用户拖到一半的值弹回去
                    if (input.classList) input.classList.toggle('has-track', hasTrack);
                    if (input === document.activeElement) continue;
                    const want = param.color
                        ? (typeof src[param.key] === 'string' ? src[param.key] : param.def)
                        : String(src[param.key] == null ? param.def : src[param.key]);
                    if (input.value !== want) input.value = want;
                    const num = input.parentElement && input.parentElement.querySelector('.fx-num');
                    if (num && !param.color) num.textContent = String(Number(want));
                }
            });
        }
        fxEmpty.hidden = effects.length > 0;
        fxEmpty.textContent = t('effect.ui.empty');
    }

    /** 重绘本模块五组；doc 为空时 paintObject(null) / paintFx(null) / paintBone(null) / paintSkin(null) 各自清空。 */
    function refresh() {
        const doc = ctx.doc();
        paintObject(doc);
        paintBone(doc);
        paintIk(doc);
        paintSkin(doc);
        paintFx(doc);
        if (xform && typeof xform.refresh === 'function') xform.refresh();
    }

    return {
        refresh,
        destroy() {
            for (const body of [objBody, xformBody, fxBody, boneBody, ikBody, skinBody]) {
                const group = body ? body.parentNode : null;
                if (group && typeof group.remove === 'function') group.remove();
            }
        },
    };
}
