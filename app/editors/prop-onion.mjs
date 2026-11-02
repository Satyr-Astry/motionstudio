// 洋葱皮属性：启用开关 / 前方帧数 / 后方帧数 / 着色模式。
// 写入走 ctx.setDoc（原实现即如此，落盘形态是补全后的 doc.onion）。

import { makeGroup, makeRow, makeNum, makeSeg } from './prop-kit.mjs';
import { t } from '../i18n/index.mjs';

// 着色模式的显示名走词典（`onion.mode.*`）；右边的 id 才是 doc.onion.mode 的落盘值。
const ONION_MODE_IDS = ['tint', 'dim'];

export function mount(el, ctx) {
    const onionBody = makeGroup(el, t('props.onion.group'), 'onion');
    const toggleField = makeRow(onionBody, t('props.onion.enable'));
    const onionToggle = document.createElement('button');
    onionToggle.type = 'button';
    onionToggle.className = 'prop-toggle';
    onionToggle.textContent = t('props.onion.on');
    onionToggle.title = t('props.onion.toggleTitle');
    onionToggle.setAttribute('aria-label', t('props.onion.toggleAria'));
    toggleField.appendChild(onionToggle);
    const beforeInput = makeNum(onionBody, t('props.onion.before'), { min: 0, max: 8, step: 1, value: 1, key: 'onion-before' });
    const afterInput = makeNum(onionBody, t('props.onion.after'), { min: 0, max: 8, step: 1, value: 1, key: 'onion-after' });
    const modeBtns = makeSeg(onionBody, t('props.onion.mode'), ONION_MODE_IDS.map((id) => [id, t('onion.mode.' + id)]), 'tint');

    // ── 写入逻辑
    onionToggle.addEventListener('click', () => {
        const doc = ctx.doc();
        if (!doc) return;
        ctx.setDoc((d) => Object.assign({}, d, {
            onion: Object.assign({ enabled: false, before: 1, after: 1, mode: 'tint' }, d.onion, {
                enabled: !(d.onion && d.onion.enabled),
            }),
        }));
        refresh();
    });

    beforeInput.addEventListener('change', () => {
        const doc = ctx.doc();
        if (!doc) return;
        const v = Math.max(0, Math.min(8, Math.round(Number(beforeInput.value) || 0)));
        ctx.setDoc((d) => Object.assign({}, d, {
            onion: Object.assign({ enabled: false, before: 1, after: 1, mode: 'tint' }, d.onion, { before: v }),
        }));
        refresh();
    });

    afterInput.addEventListener('change', () => {
        const doc = ctx.doc();
        if (!doc) return;
        const v = Math.max(0, Math.min(8, Math.round(Number(afterInput.value) || 0)));
        ctx.setDoc((d) => Object.assign({}, d, {
            onion: Object.assign({ enabled: false, before: 1, after: 1, mode: 'tint' }, d.onion, { after: v }),
        }));
        refresh();
    });

    for (const [val, btn] of modeBtns) {
        btn.addEventListener('click', () => {
            const doc = ctx.doc();
            if (!doc) return;
            ctx.setDoc((d) => Object.assign({}, d, {
                onion: Object.assign({ enabled: false, before: 1, after: 1, mode: 'tint' }, d.onion, { mode: val }),
            }));
            refresh();
        });
    }

    function refresh() {
        const doc = ctx.doc();
        if (!doc) {
            // 原 clearValues() 里的洋葱皮部分（启用按钮文案不动，与旧版一致）
            beforeInput.value = '';
            beforeInput.disabled = true;
            afterInput.value = '';
            afterInput.disabled = true;
            onionToggle.classList.remove('is-on');
            onionToggle.disabled = true;
            for (const b of modeBtns.values()) b.classList.remove('is-on');
            return;
        }
        const onion = doc.onion || {};
        const on = !!onion.enabled;
        onionToggle.disabled = false;
        beforeInput.disabled = false;
        afterInput.disabled = false;
        onionToggle.classList.toggle('is-on', on);
        onionToggle.textContent = on ? t('props.onion.on') : t('props.onion.off');
        if (document.activeElement !== beforeInput) beforeInput.value = String(onion.before == null ? 1 : onion.before);
        if (document.activeElement !== afterInput) afterInput.value = String(onion.after == null ? 1 : onion.after);
        for (const [val, btn] of modeBtns) btn.classList.toggle('is-on', (onion.mode || 'tint') === val);
    }

    return {
        refresh,
        destroy() {
            const group = onionBody ? onionBody.parentNode : null;
            if (group && typeof group.remove === 'function') group.remove();
        },
    };
}
