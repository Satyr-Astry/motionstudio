// 文档级时间属性。属性面板里只有一组「时间与时长」：当前时间 / 总时长 / 帧率 / 循环模式。
//
// 帧率分段（多段可变渲染帧率）是技术向的高级设置，不该占属性面板的主视线，已经从属性面板移除；
// 但它不是被删掉：把任意区域切成「文档」编辑器（区域标题的下拉框）就能看到完整的「帧率分段」组。
// 属性面板通过 opts.timebase === false 关掉它，独立挂载时（opts 为空）照旧出现。
import { docDuration } from '../core/cel.mjs';
import { makeGroup, makeValue, makeNum, makeNumPair, makeSeg, nowTime } from './prop-kit.mjs';

// 顺序与 core/playback.mjs 的 PLAY_MODES 一致：工具条按钮点一下就是按这个顺序换下一种，
// 两处文案相同（「来回」不写「往返」），用户看到的词不该因面板而异。
const LOOP_VALUE = [['cycle', '循环'], ['pingpong', '来回'], ['reverse', '反向循环'], ['none', '单次']];

export function mount(el, ctx, opts) {
    const o = opts || {};
    // 缺省 = 显示（独立挂载的「文档」编辑器走这条），只有属性面板显式传 false
    const wantTimebase = o.timebase !== false;

    // ── 画布（场景尺寸）
    // 之前这里只有总时长/帧率/循环，画布宽高根本没有入口，「场景画布尺寸无法调整」就是这个坑。
    const canvasBody = makeGroup(el, '画布', 'canvas');
    const sizePair = makeNumPair(canvasBody, '尺寸', { min: 16, max: 8192, step: 1, key: 'canvas-size', placeholder: '宽' });
    const widthInput = sizePair.w;
    const heightInput = sizePair.h;
    // 与对象面板的「尺寸」同一个坑：空值时两个框只剩占位符，分不出谁宽谁高。
    // placeholder + aria-label 把方向写死（Lead 的审计里这两个框正落在 emptyFields 里）。
    heightInput.placeholder = '高';
    widthInput.setAttribute('aria-label', '文档宽度（像素）');
    heightInput.setAttribute('aria-label', '文档高度（像素）');
    const presetWrap = document.createElement('div');
    presetWrap.className = 'prop-inline prop-canvas-presets';
    for (const [label, w, h] of [['16:9', 1920, 1080], ['9:16', 1080, 1920], ['1:1', 1080, 1080], ['4:3', 1440, 1080]]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'prop-seg prop-canvas-preset';
        b.textContent = label;
        b.title = w + ' × ' + h;
        b.addEventListener('click', () => {
            if (typeof ctx.setDocSize === 'function') ctx.setDocSize(w, h);
            refresh();
        });
        presetWrap.appendChild(b);
    }
    canvasBody.appendChild(presetWrap);
    const commitCanvas = () => {
        const doc = ctx.doc();
        if (!doc) return;
        const w = Number(widthInput.value);
        const h = Number(heightInput.value);
        if (!Number.isFinite(w) || !Number.isFinite(h)) return;
        if (typeof ctx.setDocSize === 'function') ctx.setDocSize(w, h);
        refresh();
    };
    widthInput.addEventListener('change', commitCanvas);
    heightInput.addEventListener('change', commitCanvas);
    for (const elx of [widthInput, heightInput]) {
        elx.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitCanvas(); }
        });
    }

    // ── 时间与时长
    const timeBody = makeGroup(el, '时间与时长', 'time');
    const timeNow = makeValue(timeBody, '当前时间', '—');
    timeNow.classList.add('prop-time'); // panels.css：等宽数字 + 次要色
    const durationInput = makeNum(timeBody, '总时长', { min: 0.01, max: 600, step: 0.1, value: 1, key: 'duration' });
    durationInput.title = '文档总时长（秒）；下限是 max(一帧, 内容长度)，由外壳夹住';
    const fpsInput = makeNum(timeBody, '帧率', { min: 1, max: 120, step: 1, value: 12, key: 'fps' });
    const loopBtns = makeSeg(timeBody, '循环', LOOP_VALUE, 'cycle');

    // ── 帧率分段（高级，属性面板不挂）
    let tbBody = null;
    let tbNow = null;
    let tbMs = null;
    let tbCount = null;
    let tbFpsInput = null;
    let tbAtInput = null;
    let tbAddBtn = null;
    let tbDelBtn = null;
    let tbResetBtn = null;

    if (wantTimebase) {
        tbBody = makeGroup(el, '时间轴（帧率分段）', 'timebase');
        tbNow = makeValue(tbBody, '本段帧率', '—');
        tbMs = makeValue(tbBody, '本段区间', '—');
        tbCount = makeValue(tbBody, '帧率段数', '—');
        tbFpsInput = makeNum(tbBody, '改为', { min: 1, max: 120, step: 1, value: 12, key: 'tb-fps' });
        tbAtInput = makeNum(tbBody, '分段于', { min: 0, max: 9999, step: 0.1, value: 0, key: 'tb-at' });
        const tbBtn = (text, title) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'prop-seg tb-btn';
            b.textContent = text;
            b.title = title;
            return b;
        };
        const tbBtnRow = document.createElement('div');
        tbBtnRow.className = 'prop-inline tb-btnrow';
        tbAddBtn = tbBtn('＋分段', '在「分段于」的时间点插入一个新的渲染帧率');
        tbDelBtn = tbBtn('删除段', '删除当前时间所在的帧率段');
        tbResetBtn = tbBtn('统一', '恢复成全片单一帧率（= 文档帧率）');
        tbBtnRow.append(tbAddBtn, tbDelBtn, tbResetBtn);
        tbBody.appendChild(tbBtnRow);

        tbAddBtn.addEventListener('click', () => {
            const fps = Math.max(1, Math.min(120, Math.round(Number(tbFpsInput.value) || 0)));
            const at = Math.max(0, Number(tbAtInput.value) || 0);
            if (typeof ctx.addTimeSegment === 'function') ctx.addTimeSegment(at, fps);
            refresh();
        });
        tbDelBtn.addEventListener('click', () => {
            if (typeof ctx.segmentIndexAt !== 'function' || typeof ctx.removeTimeSegment !== 'function') return;
            ctx.removeTimeSegment(ctx.segmentIndexAt(ctx.time()));
            refresh();
        });
        tbResetBtn.addEventListener('click', () => {
            if (typeof ctx.resetTimebase === 'function') ctx.resetTimebase();
            refresh();
        });
        tbFpsInput.addEventListener('change', () => {
            if (typeof ctx.setTimeSegmentFps !== 'function') return;
            const segs = typeof ctx.timebase === 'function' ? ctx.timebase() : [];
            if (!segs.length) return;
            ctx.setTimeSegmentFps(ctx.segmentIndexAt(ctx.time()), Number(tbFpsInput.value));
            refresh();
        });
        tbAtInput.addEventListener('change', () => {
            if (typeof ctx.setTimeSegmentAt !== 'function') return;
            const idx = ctx.segmentIndexAt(ctx.time());
            if (idx <= 0) return;
            ctx.setTimeSegmentAt(idx, Number(tbAtInput.value));
            refresh();
        });
    }

    // ── 写入逻辑
    durationInput.addEventListener('change', () => {
        const doc = ctx.doc();
        if (!doc) return;
        const wanted = Number(durationInput.value);
        if (!(wanted > 0) || typeof ctx.setDuration !== 'function') { refresh(); return; }
        // setDuration 会夹到 [max(一帧, 内容长度), 600] 并返回规范化后的秒数，提示也由它发。
        // 这里只管用返回值回填，绝不再算一遍下限 —— 两处口径迟早会分叉。
        const applied = Number(ctx.setDuration(wanted));
        const shown = applied > 0 ? Math.round(applied * 1000) / 1000 : wanted;
        // 提交后立刻回填：用户可能输了被夹住的数（0.05 s 比一帧还短），
        // 不回填输入框就会一直显示那个并不存在的值，直到失焦
        durationInput.value = String(shown);
        refresh();
    });

    fpsInput.addEventListener('change', () => {
        const doc = ctx.doc();
        if (!doc) return;
        const v = Math.round(Number(fpsInput.value));
        if (!(v > 0)) { fpsInput.value = String(doc.fps); return; }
        ctx.setDoc((d) => Object.assign({}, d, { fps: Math.max(1, Math.min(120, v)) }));
        refresh();
    });

    for (const [val, btn] of loopBtns) {
        btn.addEventListener('click', () => {
            if (!ctx.doc()) return;
            ctx.setDoc((d) => Object.assign({}, d, { loopMode: val }));
            refresh();
        });
    }

    function refresh() {
        const doc = ctx.doc();
        if (!doc) {
            // 无文档：时间与时长整组退成空态（帧率分段保持上一次的值，与旧版一致）
            timeNow.textContent = '—';
            durationInput.value = '';
            durationInput.disabled = true;
            fpsInput.value = '';
            fpsInput.disabled = true;
            for (const b of loopBtns.values()) b.classList.remove('is-on');
            return;
        }
        timeNow.textContent = 't = ' + nowTime(ctx).toFixed(2) + ' s';
        durationInput.disabled = false;
        // 显示 docDuration（= max(duration, contentDuration)）：尺子真正铺开的长度，
        // 而不是 doc.duration 这个可能比内容还短的原始字段
        const total = docDuration(doc);
        if (document.activeElement !== durationInput) durationInput.value = String(Math.round(total * 1000) / 1000);
        fpsInput.disabled = false;
        if (document.activeElement !== fpsInput) fpsInput.value = String(doc.fps);
        for (const [val, btn] of loopBtns) btn.classList.toggle('is-on', doc.loopMode === val);

        if (!tbBody) return;
        const segs = typeof ctx.timebase === 'function' ? ctx.timebase() : [];
        const now = typeof ctx.time === 'function' ? ctx.time() : 0;
        const idx = segs.length && typeof ctx.segmentIndexAt === 'function' ? ctx.segmentIndexAt(now) : 0;
        const cur = segs[idx] || { at: 0, fps: doc.fps };
        const range = typeof ctx.segmentRange === 'function' ? ctx.segmentRange(idx) : null;
        tbNow.textContent = cur.fps + ' fps' + (segs.length > 1 ? '（第 ' + (idx + 1) + '/' + segs.length + ' 段）' : '');
        tbMs.textContent = range ? range.at.toFixed(2) + ' – ' + range.end.toFixed(2) + ' s' : '—';
        tbCount.textContent = String(segs.length);
        if (document.activeElement !== tbFpsInput) tbFpsInput.value = String(Math.round(cur.fps));
        if (document.activeElement !== tbAtInput) tbAtInput.value = cur.at.toFixed(2);
        const docNow = ctx.doc();
        if (docNow) {
            if (document.activeElement !== widthInput) widthInput.value = String(Math.round(docNow.width));
            if (document.activeElement !== heightInput) heightInput.value = String(Math.round(docNow.height));
        }
        tbDelBtn.disabled = segs.length <= 1;
        tbAtInput.disabled = idx <= 0;
    }

    return {
        refresh,
        destroy() {
            for (const body of [canvasBody, timeBody, tbBody]) {
                const group = body ? body.parentNode : null;
                if (group && typeof group.remove === 'function') group.remove();
            }
        },
    };
}
