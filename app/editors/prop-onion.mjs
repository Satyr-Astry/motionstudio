// 洋葱皮属性：启用开关 / 前方帧数 / 后方帧数 / 着色模式。
// 写入走 ctx.setDoc（原实现即如此，落盘形态是补全后的 doc.onion）。

import { makeGroup, makeRow, makeNum, makeSeg } from './prop-kit.mjs';

const ONION_MODE = [
    ['tint', '红绿着色'],
    ['dim', '淡化'],
];

export function mount(el, ctx) {
    const onionBody = makeGroup(el, '洋葱皮', 'onion');
    const toggleField = makeRow(onionBody, '启用');
    const onionToggle = document.createElement('button');
    onionToggle.type = 'button';
    onionToggle.className = 'prop-toggle';
    onionToggle.textContent = '开';
    onionToggle.title = '洋葱皮：开 / 关';
    onionToggle.setAttribute('aria-label', '洋葱皮开关');
    toggleField.appendChild(onionToggle);
    const beforeInput = makeNum(onionBody, '前方帧数', { min: 0, max: 8, step: 1, value: 1, key: 'onion-before' });
    const afterInput = makeNum(onionBody, '后方帧数', { min: 0, max: 8, step: 1, value: 1, key: 'onion-after' });
    const modeBtns = makeSeg(onionBody, '着色', ONION_MODE, 'tint');

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
        onionToggle.textContent = on ? '开' : '关';
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
