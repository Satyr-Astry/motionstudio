// 属性面板共享件：节点工厂 + 当前对象 / 时间 / 统计的取值口径。
// 拆分前这些函数都闭包在 properties.mjs 的 mount() 里，现在提到这里，
// 由外壳 properties.mjs 与 prop-object / prop-doc / prop-onion / prop-info 共用。
// 约定：工厂的第一个参数是「要挂进去的父节点」，返回被 append 的那个子节点。

import { objectsOf, objectById, celTimes } from '../core/cel.mjs';

/** 建一个 .prop-group（.prop-title + .prop-body[data-k=key]）接到 parent 上，返回 body。 */
export function makeGroup(parent, title, key) {
    const group = document.createElement('div');
    group.className = 'prop-group';
    const t = document.createElement('div');
    t.className = 'prop-title';
    t.textContent = title;
    const body = document.createElement('div');
    body.className = 'prop-body';
    body.dataset.k = key;
    group.append(t, body);
    parent.appendChild(group);
    return body;
}

export function makeRow(body, labelText) {
    const row = document.createElement('div');
    row.className = 'prop-row';
    const label = document.createElement('span');
    label.className = 'prop-label';
    label.textContent = labelText;
    const field = document.createElement('div');
    field.className = 'prop-field';
    row.append(label, field);
    body.appendChild(row);
    return field;
}

export function makeValue(body, labelText, initial) {
    const field = makeRow(body, labelText);
    const val = document.createElement('span');
    val.className = 'prop-val';
    val.textContent = initial == null ? '—' : initial;
    // panels.css 未覆盖 .prop-val，仅补等宽数字对齐
    val.style.fontVariantNumeric = 'tabular-nums';
    field.appendChild(val);
    return val;
}

export function makeNum(body, labelText, opts) {
    const o = opts || {};
    const field = makeRow(body, labelText);
    const input = document.createElement('input');
    input.className = 'prop-num';
    input.type = 'number';
    if (o.min != null) input.min = String(o.min);
    if (o.max != null) input.max = String(o.max);
    input.step = String(o.step == null ? 1 : o.step);
    input.value = o.value == null ? '0' : String(o.value);
    input.title = labelText;
    if (o.key) input.dataset.k = o.key;
    field.appendChild(input);
    return input;
}

/**
 * 一行两个数字框（「宽 × 高」这类成对的量）。
 *
 * 为什么要新工厂：makeNum 一次只建一行一个框，宽 / 高各占一行会把「对象」组撑高一倍；
 * 而 .prop-field 本身就是 flex 行，两个 input.prop-num 并排就够。
 * panels.css 把 input.prop-num 钉成 `flex: 0 0 auto; width: 68px`，两个并排会顶出面板宽度，
 * 所以这里用内联样式改成等分剩余宽度（与 makeText 用内联样式改宽度的理由相同：不动 CSS）。
 * 返回 { w, h, sep }，两个 input 都已挂进同一行。
 */
export function makeNumPair(body, labelText, opts) {
    const o = opts || {};
    const field = makeRow(body, labelText);
    const mk = (key, title) => {
        const input = document.createElement('input');
        input.className = 'prop-num';
        input.type = 'number';
        input.min = String(o.min == null ? 1 : o.min);
        input.max = String(o.max == null ? 4096 : o.max);
        input.step = String(o.step == null ? 1 : o.step);
        input.value = o.value == null ? '' : String(o.value);
        if (o.placeholder != null) input.placeholder = String(o.placeholder);
        input.title = title;
        if (key) input.dataset.k = key;
        input.style.flex = '1 1 0';
        input.style.width = '0';
        field.appendChild(input);
        return input;
    };
    const w = mk(o.key ? o.key + '-w' : null, (o.titleW || labelText) + '（宽）');
    // 中间的 × 只是个分隔符：复用 .prop-val，跟「不透明度 %」那个后缀同一套文字样式
    const sep = document.createElement('span');
    sep.className = 'prop-val';
    sep.textContent = '×';
    field.appendChild(sep);
    const h = mk(o.key ? o.key + '-h' : null, (o.titleH || labelText) + '（高）');
    return { w, h, sep };
}

/**
 * 文本输入行（对象名字这类字符串字段用）。
 *
 * panels.css 只给 `input.prop-num` 写了输入框外观（边框 / 高度 / 焦点色），没有 .prop-text。
 * 所以这里复用 prop-num 这个类拿到同一套外观，再用内联样式把宽度撑满、文本左对齐 ——
 * 数字框那套 68px + 右对齐是给数字看的，名字右对齐会很难读。这样不必动 CSS。
 */
export function makeText(body, labelText, opts) {
    const o = opts || {};
    const field = makeRow(body, labelText);
    const input = document.createElement('input');
    input.className = 'prop-num';
    input.type = 'text';
    if (o.maxLength != null) input.maxLength = o.maxLength;
    input.value = o.value == null ? '' : String(o.value);
    if (o.placeholder != null) input.placeholder = String(o.placeholder);
    input.title = labelText;
    if (o.key) input.dataset.k = o.key;
    input.style.flex = '1 1 auto';
    input.style.width = 'auto';
    input.style.textAlign = 'left';
    field.appendChild(input);
    return input;
}

export function makeSeg(body, labelText, items, current) {
    const field = makeRow(body, labelText);
    const btns = new Map();
    for (const [val, text] of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'prop-seg';
        b.dataset.val = val;
        b.textContent = text;
        b.classList.toggle('is-on', val === current);
        field.appendChild(b);
        btns.set(val, b);
    }
    return btns;
}

/** 唯一时间源：ctx.time()（连续时间，秒）。外壳没给就退回 0。 */
export function nowTime(ctx) {
    const fn = typeof ctx.time === 'function' ? ctx.time : null;
    const v = fn ? Number(fn()) : 0;
    return Number.isFinite(v) ? v : 0;
}

/** 当前对象：ctx.activeLayerId() 命中优先，否则第一个。 */
export function activeObj(ctx, doc) {
    const id = typeof ctx.activeLayerId === 'function' ? ctx.activeLayerId() : null;
    return (id && objectById(doc, id)) || objectsOf(doc)[0] || null;
}

/** 全文档画格数（所有对象的画格之和）。 */
export function totalCels(doc) {
    let n = 0;
    for (const o of objectsOf(doc)) n += celTimes(o).length;
    return n;
}

// 所有对象 transform.keys 的总条数
export function totalKeys(doc) {
    let n = 0;
    for (const layer of objectsOf(doc)) {
        const keys = layer && layer.transform && Array.isArray(layer.transform.keys) ? layer.transform.keys : null;
        if (keys) n += keys.length;
    }
    return n;
}

// 旧版还有 describeActiveTime / localTimeDesc 两个导出，只服务于已删掉的「对象时间」那一行，
// 现在全仓零引用，一并删掉：留在共享件里会让人以为对象时间还能在属性面板读。
