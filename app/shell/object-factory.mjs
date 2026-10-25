/**
 * MotionStudio —— 对象工厂：**创建对象的唯一入口**
 *
 * 为什么单开一个模块（用户 m09929）：原先「新建对象」散在 app.mjs 的
 * createEmptyObject / addObject / ensureCelImage 三处，各自拼 makeObject、
 * 各自补 cel，行为不一致（有的给默认尺寸、有的继承文档尺寸、有的不写 cel）。
 * 现在所有对象都从这里出生，主程序只调函数、不碰字段。
 *
 * 纯函数：吃 doc + 描述，吐 { doc, id, object }，不 import shell、不碰 DOM。
 * 失败返回 { doc: 原 doc, id: null, error }，绝不抛异常。
 */

import { addObject, ensureCelAt, objectsOf } from '../core/doc-model.mjs';
import { boardToObjectDraft, boardIsEmpty, BOARD_DEFAULT } from '../core/board.mjs';

function nextObjectName(doc) {
    const list = objectsOf(doc);
    let n = list.length + 1;
    const used = new Set(list.map((o) => (o && o.name ? String(o.name) : '')));
    while (used.has('对象 ' + n)) n += 1;
    return '对象 ' + n;
}

/** 把位图塞进对象的 0 秒纹理。没有 cel 就建一个，有就覆盖。 */
function attachImage(obj, at, image, fitImage) {
    if (!obj || !image) return obj;
    // fitImage 由调用方给（浏览器里是 canvas 缩放），core 只负责「发现尺寸不一致」
    const res = ensureCelAt(obj, at, fitImage ? { image, fitImage } : { image });
    return res && res.obj ? res.obj : obj;
}

/**
 * 从画板创建一个对象。
 * @param {object} doc
 * @param {object} board  app/core/board.mjs 的 createBoard() 产物
 * @param {{name?:string, at?:number}} [opts]
 * @returns {{doc:object, id:string|null, object:object|null, error?:string}}
 */
export function createObjectFromBoard(doc, board, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    if (!doc) return { doc, id: null, object: null, error: '没有文档' };
    if (!board) return { doc, id: null, object: null, error: '没有画板' };
    if (boardIsEmpty(board)) return { doc, id: null, object: null, error: '画板是空的' };

    const draft = boardToObjectDraft(board, { name: o.name, at: o.at });
    if (!draft) return { doc, id: null, object: null, error: '画板内容不可用' };

    let next = addObject(doc, { name: draft.name || nextObjectName(doc) });
    const created = objectsOf(next)[objectsOf(next).length - 1];
    if (!created) return { doc, id: null, object: null, error: '对象写入失败' };

    const withImage = attachImage(created, draft.at, draft.image, o.fitImage);
    next = replaceObject(next, created.id, withImage);
    return { doc: next, id: created.id, object: withImage };
}

/**
 * 造一个空对象（没有位图，等着在动画工作区里继续画或直接当变换载体）。
 * @returns {{doc:object, id:string|null, object:object|null, error?:string}}
 */
export function createEmptyObject(doc, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    if (!doc) return { doc, id: null, object: null, error: '没有文档' };
    const width = Number.isFinite(o.width) ? o.width : (doc.width || BOARD_DEFAULT.width);
    const height = Number.isFinite(o.height) ? o.height : (doc.height || BOARD_DEFAULT.height);

    const next = addObject(doc, { name: o.name || nextObjectName(doc) });
    const created = objectsOf(next)[objectsOf(next).length - 1];
    if (!created) return { doc, id: null, object: null, error: '对象写入失败' };
    // 空对象也占一个 0 秒纹理：时间轴要能看见它，落笔时 ensureCelImage 才有落点。
    const withCel = ensureCelAt(created, Number.isFinite(o.at) ? o.at : 0, {});
    const obj = withCel && withCel.obj ? withCel.obj : created;
    return { doc: replaceObject(next, created.id, obj), id: created.id, object: obj, width, height };
}

/** 不依赖 doc-model 的 patchObject（避免和它的 import 顺序纠缠）。 */
function replaceObject(doc, id, nextObj) {
    if (!doc || !id) return doc;
    if (Array.isArray(doc.objects)) {
        return Object.assign({}, doc, { objects: doc.objects.map((x) => (x && x.id === id ? nextObj : x)) });
    }
    if (Array.isArray(doc.layers)) {
        return Object.assign({}, doc, { layers: doc.layers.map((x) => (x && x.id === id ? nextObj : x)) });
    }
    return doc;
}

export { nextObjectName };
