// 信息属性：只读统计，四行 —— 画布尺寸 / 对象数 / 纹理数 / 关键帧数。
// 这里一个可写控件都没有：时长去「时间与时长」组改，对象的时间通道在对象列表与时间图里改。
// 信息组只回答一个问题：「这个工程现在有多大」，所以不再放按钮和第二份重复统计。
import { objectsOf } from '../core/cel.mjs';
import { makeGroup, makeValue, totalCels, totalKeys } from './prop-kit.mjs';

export function mount(el, ctx) {
    const infoBody = makeGroup(el, '信息', 'info');
    const infoCanvas = makeValue(infoBody, '画布尺寸', '—');
    const infoLayers = makeValue(infoBody, '对象数', '—');
    const infoCels = makeValue(infoBody, '纹理数', '—');
    const infoKeys = makeValue(infoBody, '关键帧数', '—');
    infoKeys.classList.add('prop-kf-count'); // panels.css：强调色 + 小字号

    function refresh() {
        const doc = ctx.doc();
        if (!doc) {
            for (const n of [infoCanvas, infoLayers, infoCels, infoKeys]) n.textContent = '—';
            return;
        }
        infoCanvas.textContent = doc.width + ' × ' + doc.height;
        infoLayers.textContent = String(objectsOf(doc).length);
        // 纹理数 / 关键帧数都是全文档合计：属性面板里只此一份，不再在别的组重复
        infoCels.textContent = String(totalCels(doc));
        infoKeys.textContent = String(totalKeys(doc));
    }

    return {
        refresh,
        destroy() {
            const group = infoBody ? infoBody.parentNode : null;
            if (group && typeof group.remove === 'function') group.remove();
        },
    };
}
