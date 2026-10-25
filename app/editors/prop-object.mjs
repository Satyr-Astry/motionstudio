// 对象级属性，三组：对象（名字 / 种类 / 尺寸 / 不透明度）→ 变换（内嵌 xform.mjs 的 8 标量 /
// 四角变形 / 缓动 / 关键帧导航）→ 效果（当前活动对象的滤镜链，渲染时由外壳转成 canvas filter）。
// 组的顺序与显隐由外壳 properties.mjs 统一控制：没有选中对象时「对象」与「效果」整组隐藏。

import { effectAt } from '../paint/effects.mjs';
import { objectSize, setObjectSize } from '../core/doc-model.mjs';
import { patchLayer } from '../core/cel.mjs';
import { createSurface } from '../paint/surface.mjs';
import { createXformPanel } from './xform.mjs';
import { icon } from '../core/icons.mjs';
import { makeGroup, makeRow, makeText, makeValue, makeNum, makeNumPair, activeObj } from './prop-kit.mjs';

// 种类文案与 layers.mjs 的 KIND_TEXT 对齐（那边是模块私有常量、不导出，这里复制一份，
// 免得为两个汉字引入一条跨编辑器的依赖）。认不出的 kind 直接显示原值，不吞信息。
const KIND_TEXT = { paint: '手绘', image: '图片' };

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
    const objBody = makeGroup(el, '对象', 'object');
    const nameInput = makeText(objBody, '名字', { key: 'obj-name', maxLength: 60, placeholder: '对象名' });
    const kindVal = makeValue(objBody, '种类', '—');
    // 尺寸 = 对象自己的画布，宽 / 高并排两个可编辑框。
    // 旧版这里是 makeValue 的只读文本：能看见「900 × 640」却改不了，正是「不能自定义对象尺寸」的根因。
    const sizePair = makeNumPair(objBody, '尺寸', { min: 1, max: 4096, step: 1, key: 'obj-size', placeholder: '宽' });
    const sizeW = sizePair.w;
    const sizeH = sizePair.h;
    // 两个光秃秃的数字框看不出哪个是宽、哪个是高 —— 没有位图的对象还会被清空成占位符，
    // 连「—」都读不出方向。用 placeholder 把方向写死（有值时靠标题与中间的 × 区分），
    // 再补 aria-label 让读屏也能读出「宽 / 高」。
    // 不在框外加「宽」「高」小标签：.prop-val 有自己的固定宽度，两个前缀会把
    // 两个输入框从 92px 挤到 35px，那是拿可读性换可读性。
    sizeH.placeholder = '高';
    sizeW.setAttribute('aria-label', '对象宽度（像素）');
    sizeH.setAttribute('aria-label', '对象高度（像素）');
    const opacityInput = makeNum(objBody, '不透明度', { min: 0, max: 100, step: 1, value: 100, key: 'obj-opacity' });
    opacityInput.title = '对象不透明度 0–100，与对象列表里的滑块是同一个值';
    // 补一个单位后缀：光秃秃的 0–100 会被读成像素
    const opacityUnit = document.createElement('span');
    opacityUnit.className = 'prop-val';
    opacityUnit.textContent = '%';
    opacityInput.parentNode.appendChild(opacityUnit);

    // 显示 / 隐藏：与对象列表里的眼睛按钮同一个 visible 字段。
    // 以前只能去对象面板点眼睛，属性面板里看不见这个开关 —— 用户在同一个对象上要来回切两个面板。
    const visRow = makeRow(objBody, '显示');
    const visInput = document.createElement('input');
    visInput.type = 'checkbox';
    visInput.className = 'prop-check';
    visInput.title = '取消勾选 = 隐藏这个对象（含它的子对象与纹理）';
    visRow.appendChild(visInput);
    const visText = document.createElement('span');
    visText.className = 'prop-val';
    visText.textContent = '可见';
    visRow.appendChild(visText);
    visInput.addEventListener('change', () => {
        const layer = activeObj(ctx, ctx.doc());
        if (!layer) return;
        const next = !!visInput.checked;
        visText.textContent = next ? '可见' : '隐藏';
        ctx.setDoc((d) => Object.assign({}, d, {
            objects: (d.objects || []).map((o) => (o && o.id === layer.id ? Object.assign({}, o, { visible: next }) : o)),
        }), { label: next ? '显示对象' : '隐藏对象' });
    });

    // 旋转 / 缩放的原点（anchor）：归一化百分比，相对对象自己的画布。
    // 这是「绕哪里转」的唯一入口 —— 之前只有默认值，用户没法改。
    const anchorPair = makeNumPair(objBody, '原点 %', { min: 0, max: 100, step: 1, key: 'obj-anchor', placeholder: '50' });
    const anchorX = anchorPair.w;
    const anchorY = anchorPair.h;
    anchorX.title = '旋转/缩放原点的 X（0 = 左边缘，50 = 水平中心，100 = 右边缘）';
    anchorY.title = '旋转/缩放原点的 Y（0 = 上边缘，50 = 垂直中心，100 = 下边缘）';
    const anchorCenter = document.createElement('button');
    anchorCenter.type = 'button';
    anchorCenter.className = 'prop-seg prop-anchor-center ms-icon-label';
    anchorCenter.innerHTML = icon('center') + '<span>居中</span>';
    anchorCenter.title = '把原点放到对象中心（50% / 50%）';
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

    // ── 变换（xform 内嵌）
    const xformBody = makeGroup(el, '变换', 'xform');
    const xform = createXformPanel(ctx);
    xformBody.appendChild(xform.el);
    // 去重：不透明度只在上面「对象」组出现一次。xform 那行写的是「变换关键帧的 opacity 通道」，
    // 和对象级 layer.opacity 不是同一个量，但同名同排版摆在同一面板里就是第三个入口。
    // 不动 xform.mjs，只把它这一行藏起来；要动画 opacity 去曲线编辑器（那里有同名通道）。
    hideField(xform.el, 'opacity');

    // ── 效果（当前活动对象的滤镜链；渲染时由外壳转成 canvas filter）
    const fxBody = makeGroup(el, '效果', 'effects');
    const fxList = document.createElement('div');
    fxList.className = 'fx-list';
    const fxEmpty = document.createElement('div');
    fxEmpty.className = 'fx-empty';
    fxEmpty.textContent = '该对象还没有效果';
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
        b.innerHTML = icon(def.id, { size: 'sm' }) + '<span>' + def.name + '</span>';
        b.title = '给当前对象加一个' + def.name;
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
        const dt = doc && doc.width > 0 && doc.height > 0 ? '（当前文档 ' + doc.width + ' × ' + doc.height + '）' : '';
        return '对象自己的画布尺寸，和文档尺寸' + dt + '无关；改动会把该对象所有画格的位图整张拉伸到新尺寸';
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
     * 优先走外壳的 ctx.setObjectSize：它封装了「把每个画格的位图整张拉伸 + 一次 setDoc」。
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
                { label: '改对象尺寸', coalesce: 'obj-size:' + layer.id }
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
            visText.textContent = '可见';
            anchorX.value = '';
            anchorY.value = '';
            return;
        }
        // 显示开关：与对象列表的眼睛按钮同源，这里只做镜像
        visInput.checked = layer.visible !== false;
        visText.textContent = layer.visible === false ? '隐藏' : '可见';
        // 原点：文档里是 0–1，面板里显示成百分比整数
        const anchor = layer.anchor || { x: 0, y: 0 };
        if (document.activeElement !== anchorX) anchorX.value = String(Math.round(anchor.x * 100));
        if (document.activeElement !== anchorY) anchorY.value = String(Math.round(anchor.y * 100));

        // 正在编辑的输入框不回写，否则会把用户打到一半的字弹回原值（与 xform 同一焦点保护范式）
        if (document.activeElement !== nameInput) nameInput.value = layer.name == null ? '' : String(layer.name);
        kindVal.textContent = KIND_TEXT[layer.kind] || layer.kind || '—';
        // 尺寸取自对象自己的「纸」（第一个有图的画格）与文档尺寸无关；标题把这层区别讲清楚
        const title = sizeTitle(doc);
        // title 前缀保留「宽 / 高」的区分，后半句解释对象画布与文档尺寸的关系
        sizeW.title = '宽 · ' + title;
        sizeH.title = '高 · ' + title;
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
    }

    let fxSig = '';

    function fxSignature(layer, effects) {
        // 签名只认「归属对象 + 效果种类序列」：轨道的有无**不再**进签名。
        // 一是自动打帧会让第一次拖动就建轨，签名一变就重建 DOM，正在拖的滑杆节点被换掉会中断拖动；
        // 二是有没有轨道下面有专门的就地同步分支（has-track / is-on），不需要靠重建刷新。
        return layer.id + '|' + effects.map((e) => e.type).join(',');
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
        lab.textContent = param.label;
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
                ? '这个参数已有关键帧 —— 点击清除（保留当前值）'
                : '在当前时间给这个参数打关键帧；之后拖滑杆就是逐帧改';
            keyBtn.setAttribute('aria-label', hooks && hooks.hasTrack ? '清除该参数的关键帧' : '在该参数上打关键帧');
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
            fxEmpty.textContent = '没有可编辑的对象';
            return;
        }
        const effects = Array.isArray(layer.effects) ? layer.effects : [];
        const sig = fxSignature(layer, effects);
        if (sig !== fxSig) {
            // 只有「效果种类/数量/归属对象」变了才重建 DOM —— 拖滑杆时不能重建，否则焦点丢失
            fxSig = sig;
            fxList.textContent = '';
            effects.forEach((fx, idx) => {
                const def = EFFECT_DEFS.find((d) => d.id === fx.type);
                if (!def) return;
                const item = document.createElement('div');
                item.className = 'fx-item';
                item.dataset.fxIndex = String(idx);
                const head = document.createElement('div');
                head.className = 'fx-head';
                const nm = document.createElement('span');
                nm.className = 'fx-name';
                nm.textContent = def.name;
                const del = document.createElement('button');
                del.type = 'button';
                del.className = 'fx-del';
                del.innerHTML = icon('x', { size: 'sm' });
                del.title = '移除' + def.name;
                del.setAttribute('aria-label', del.title);
                del.addEventListener('click', () => {
                    const cur = activeLayer(ctx.doc());
                    if (!cur) return;
                    const list = (cur.effects || []).slice();
                    list.splice(idx, 1);
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
                            const live = (cur.effects || [])[idx];
                            if (!live) return;
                            if (!param.color && typeof ctx.setEffectParam === 'function') {
                                // 与变换面板同一语义：拖数值 = 在当前时间打帧。
                                // 不打帧就只会改「全时间轴」的静态值，用户永远得不到 0 → 20px 的过渡。
                                if (!hasTrackOf(live, param.key) && typeof ctx.keyEffectParam === 'function') {
                                    ctx.keyEffectParam(cur.id, idx, param.key);
                                }
                                ctx.setEffectParam(cur.id, idx, param.key, v);
                                return;
                            }
                            // 颜色没有标量可插值（setEffectParam 只收数字），整条回写
                            const list = (cur.effects || []).map((e, i) =>
                                i === idx ? Object.assign({}, e, { [param.key]: v }) : e
                            );
                            ctx.setLayerEffects(cur.id, list);
                        }, {
                            hasTrack,
                            onKey: () => {
                                const cur = activeLayer(ctx.doc());
                                if (!cur) return;
                                const live = (cur.effects || [])[idx];
                                if (!live) return;
                                // 必须现查：同一效果里第二个之后的参数打帧不会重建 DOM，
                                // 闭包里那份 hasTrack 会一直停在 false，◆ 就再也清不掉轨道了
                                if (hasTrackOf(live, param.key)) {
                                    if (typeof ctx.clearEffectParam === 'function') ctx.clearEffectParam(cur.id, idx, param.key);
                                } else if (typeof ctx.keyEffectParam === 'function') {
                                    ctx.keyEffectParam(cur.id, idx, param.key);
                                }
                            },
                        })
                    );
                }
                fxList.appendChild(item);
            });
        } else {
            // 结构没变：只把外部改动同步进滑杆（正在编辑的控件不动）
            effects.forEach((fx, idx) => {
                const def = EFFECT_DEFS.find((d) => d.id === fx.type);
                if (!def) return;
                const item = fxList.children[idx];
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
                            ? '这个参数已有关键帧 —— 点击清除（保留当前值）'
                            : '在当前时间给这个参数打关键帧；之后拖滑杆就是逐帧改';
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
        fxEmpty.textContent = '该对象还没有效果';
    }

    /** 重绘本模块三组；doc 为空时 paintObject(null) / paintFx(null) 各自清空。 */
    function refresh() {
        const doc = ctx.doc();
        paintObject(doc);
        paintFx(doc);
        if (xform && typeof xform.refresh === 'function') xform.refresh();
    }

    return {
        refresh,
        destroy() {
            for (const body of [objBody, xformBody, fxBody]) {
                const group = body ? body.parentNode : null;
                if (group && typeof group.remove === 'function') group.remove();
            }
        },
    };
}
