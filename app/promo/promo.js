/**
 * MotionStudio 宣传片（可直接播放，也能被录制）
 *
 * 设计约束：
 * 1. draw(ctx, t, w, h) 必须**只依赖 t**（不放 rAF、不读性能计数器）——这样才能按固定
 *    fps 逐帧录制，任何时候跳帧都不会出现「动画只在播放时对」的问题。
 * 2. 全部资源走同源相对路径（CSP 是 default-src 'self'），并且 preload() 必须把图片都 decode 完，
 *    否则录到一半会出现空图。
 * 3. 画面语言与软件 UI 一致：底色 #141518、面板 #212328、主色 #4a7dff、圆角 2/6px，
 *    不堆渐变、不用发光大字。
 */

const IMG = {
    ui: './promo/img/ui.png',
    board: './promo/img/board.png',
    kf: './promo/img/kf.png',
    scatter: './promo/img/scatter.png',
    smudge: './promo/img/smudge.png',
    warp: './promo/img/warp.png',
    bar: './promo/img/bar.png',
    pal: './promo/img/pal.png',
};

const C = {
    bg: '#141518',
    bg2: '#191a1d',
    panel: '#212328',
    panel2: '#26282d',
    line: '#33363d',
    line2: '#3d4048',
    ink: '#e6e8ec',
    dim: '#9aa1ac',
    faint: '#6b7280',
    accent: '#4a7dff',
    ok: '#3fa46a',
    warm: '#e0a15a',
};

const W = 1384;
const H = 840;

/* ───────────────────────── 缓动与工具 ───────────────────────── */

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeOut = (p) => 1 - Math.pow(1 - clamp01(p), 3);
const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);

/** 一段区间的进度：t 在 [a,b] 内返回 0..1，外面夹住。 */
const seg = (t, a, b) => clamp01((t - a) / Math.max(1e-6, b - a));

function font(size, weight) {
    return (weight ? weight + ' ' : '') + size + 'px "Microsoft YaHei", "Segoe UI", system-ui, sans-serif';
}

function roundRect(g, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + rr, y);
    g.arcTo(x + w, y, x + w, y + h, rr);
    g.arcTo(x + w, y + h, x, y + h, rr);
    g.arcTo(x, y + h, x, y, rr);
    g.arcTo(x, y, x + w, y, rr);
    g.closePath();
}

/** 带底色的说明卡片：把截图放进「窗口」里，避免直接贴图显得像截图拼贴。 */
function screenshotCard(g, img, x, y, w, h, alpha) {
    if (!img) return;
    g.save();
    g.globalAlpha = alpha;
    // 窗口
    g.fillStyle = C.panel;
    roundRect(g, x, y, w, h, 6);
    g.fill();
    g.strokeStyle = C.line2;
    g.lineWidth = 1;
    g.stroke();
    // 标题条
    g.fillStyle = C.panel2;
    roundRect(g, x, y, w, 22, 6);
    g.fill();
    g.fillStyle = C.line;
    g.fillRect(x, y + 21, w, 1);
    for (let i = 0; i < 3; i += 1) {
        g.fillStyle = [C.accent, C.warm, C.ok][i];
        g.beginPath();
        g.arc(x + 12 + i * 11, y + 11, 3, 0, Math.PI * 2);
        g.fill();
    }
    // 画面：等比放进卡片
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    const boxW = w - 16;
    const boxH = h - 22 - 12;
    const s = Math.min(boxW / iw, boxH / ih);
    const dw = iw * s;
    const dh = ih * s;
    g.imageSmoothingEnabled = true;
    g.drawImage(img, x + 8 + (boxW - dw) / 2, y + 22 + 6 + (boxH - dh) / 2, dw, dh);
    g.restore();
}

/* ───────────────────────── 画面 ───────────────────────── */

const SCENES = [
    { id: 'title', at: 0.0, dur: 3.4 },
    { id: 'timeline', at: 3.4, dur: 3.6 },
    { id: 'texture', at: 7.0, dur: 3.6 },
    { id: 'board', at: 10.6, dur: 3.6 },
    { id: 'brush', at: 14.2, dur: 3.6 },
    { id: 'tools', at: 17.8, dur: 3.4 },
    { id: 'io', at: 21.2, dur: 3.0 },
    { id: 'end', at: 24.2, dur: 3.2 },
];

const DURATION = 27.4;

/** 背景：极淡的网格 + 两处色晕，定住画面重心。 */
function background(g, t) {
    g.fillStyle = C.bg;
    g.fillRect(0, 0, W, H);
    const drift = Math.sin(t * 0.35) * 26;
    const grd = g.createRadialGradient(W * 0.78 + drift, H * 0.14, 0, W * 0.78 + drift, H * 0.14, 620);
    grd.addColorStop(0, 'rgba(74,125,255,0.16)');
    grd.addColorStop(1, 'rgba(74,125,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, W, H);
    const grd2 = g.createRadialGradient(W * 0.12 - drift, H * 0.92, 0, W * 0.12 - drift, H * 0.92, 520);
    grd2.addColorStop(0, 'rgba(63,164,106,0.10)');
    grd2.addColorStop(1, 'rgba(63,164,106,0)');
    g.fillStyle = grd2;
    g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(255,255,255,0.028)';
    g.lineWidth = 1;
    for (let x = 0; x <= W; x += 46) {
        g.beginPath();
        g.moveTo(x + 0.5, 0);
        g.lineTo(x + 0.5, H);
        g.stroke();
    }
    for (let y = 0; y <= H; y += 46) {
        g.beginPath();
        g.moveTo(0, y + 0.5);
        g.lineTo(W, y + 0.5);
        g.stroke();
    }
}

/** 左上角常驻角标：让观众始终知道在看什么软件。 */
function watermark(g, t, alpha) {
    if (alpha <= 0.01) return;
    g.save();
    g.globalAlpha = alpha;
    g.fillStyle = C.panel2;
    roundRect(g, 40, 34, 118, 26, 4);
    g.fill();
    g.fillStyle = C.dim;
    g.font = font(12, '600');
    g.textBaseline = 'middle';
    g.fillText('MotionStudio', 52, 48);
    g.restore();
}

function titleScene(g, p) {
    const a = easeOut(seg(p, 0, 0.42));
    const b = easeOut(seg(p, 0.18, 0.6));
    const c = easeOut(seg(p, 0.34, 0.76));
    g.save();
    g.globalAlpha = a;
    g.fillStyle = C.accent;
    g.font = font(13, '700');
    g.textBaseline = 'alphabetic';
    g.fillText('2D ANIMATION · 本机运行 · 零依赖', 132, 300 + (1 - a) * 14);
    g.restore();

    g.save();
    g.globalAlpha = b;
    g.fillStyle = C.ink;
    g.font = font(92, '800');
    g.fillText('MotionStudio', 128, 396 + (1 - b) * 22);
    g.restore();

    g.save();
    g.globalAlpha = b * 0.9;
    g.fillStyle = C.accent;
    g.fillRect(132, 424, 96 * b, 3);
    g.restore();

    g.save();
    g.globalAlpha = c;
    g.fillStyle = C.dim;
    g.font = font(24);
    g.fillText('时间驱动的动画编辑器 —— 没有「帧」，只有秒与关键帧', 132, 478 + (1 - c) * 16);
    g.restore();

    g.save();
    g.globalAlpha = c * 0.95;
    g.font = font(17);
    const rows = [
        ['编排', '对象树 · 舞台 · 属性 · 时间轴 · 曲线'],
        ['画板', '只编辑一张纹理：自己的画布、自己的相机'],
        ['导入导出', 'PSD 图层 → 对象；WebM / 精灵图 / PNG 序列'],
    ];
    rows.forEach(([k, v], i) => {
        const y = 566 + i * 40;
        g.fillStyle = C.accent;
        g.fillRect(132, y - 12, 3, 16);
        g.fillStyle = C.ink;
        g.font = font(17, '600');
        g.fillText(k, 148, y);
        g.fillStyle = C.faint;
        g.font = font(17);
        g.fillText(v, 216, y);
    });
    g.restore();
}

function timelineScene(g, p, img) {
    const a = easeOut(seg(p, 0, 0.4));
    const cardA = easeOut(seg(p, 0.12, 0.5));
    const push = (1 - cardA) * 40;
    screenshotCard(g, img, 132 + push, 176, 1120, 630, cardA);
    g.save();
    g.globalAlpha = a;
    g.fillStyle = C.ink;
    g.font = font(38, '700');
    g.fillText('编排：一个工作区只做一件事', 132, 132 + (1 - a) * 12);
    g.fillStyle = C.faint;
    g.font = font(18);
    g.fillText('对象树 / 舞台 / 属性 / 时间轴 / 曲线 —— 播放控制就在时间轴里', 132, 162);
    g.restore();
}

function textureScene(g, p, img) {
    const a = easeOut(seg(p, 0, 0.4));
    const cardA = easeOut(seg(p, 0.1, 0.5));
    screenshotCard(g, img, 132 + (1 - cardA) * 36, 168, 760, 620, cardA);
    g.save();
    g.globalAlpha = easeOut(seg(p, 0.26, 0.66));
    const x = 946;
    g.fillStyle = C.ink;
    g.font = font(30, '700');
    g.fillText('纹理属于关键帧', x, 268);
    g.fillStyle = C.dim;
    g.font = font(17);
    const lines = [
        'key.drawing = 这张纹理的 id',
        'drawing: null = 显式空白',
        '没有该字段 = 沿用上一张',
        '',
        '同一张纹理可被多个时刻复用，',
        '时间轴上只有一条关键帧轴。',
    ];
    lines.forEach((s2, i) => g.fillText(s2, x, 310 + i * 30));
    g.restore();
    g.save();
    g.globalAlpha = a;
    g.fillStyle = C.ink;
    g.font = font(38, '700');
    g.fillText('换图，是一次关键帧操作', 132, 130);
    g.restore();
}

function boardScene(g, p, img) {
    const a = easeOut(seg(p, 0, 0.4));
    const cardA = easeOut(seg(p, 0.1, 0.5));
    screenshotCard(g, img, 132, 172, 900, 636, cardA);
    g.save();
    g.globalAlpha = easeOut(seg(p, 0.24, 0.64));
    g.fillStyle = C.ink;
    g.font = font(30, '700');
    g.fillText('画板与编排分离', 1074, 300);
    g.fillStyle = C.dim;
    g.font = font(17);
    ['画板自带画布', '自带相机', '与舞台零共享', '', '笔落在哪，', '像素就在哪'].forEach((s2, i) => {
        g.fillText(s2, 1074, 344 + i * 30);
    });
    g.restore();
    g.save();
    g.globalAlpha = a;
    g.fillStyle = C.ink;
    g.font = font(38, '700');
    g.fillText('画板只编辑一张纹理', 132, 134);
    g.restore();
}

function brushScene(g, p, imgA, imgB) {
    const a = easeOut(seg(p, 0, 0.4));
    const a1 = easeOut(seg(p, 0.1, 0.46));
    const a2 = easeOut(seg(p, 0.24, 0.6));
    screenshotCard(g, imgA, 132, 236, 556, 470, a1);
    screenshotCard(g, imgB, 712, 236, 556, 470, a2);
    g.save();
    g.globalAlpha = a;
    g.fillStyle = C.ink;
    g.font = font(36, '700');
    g.fillText('笔刷：从 Kleks 学来的手感', 132, 150);
    g.restore();
    g.save();
    g.globalAlpha = easeOut(seg(p, 0.3, 0.7));
    g.font = font(16);
    g.fillStyle = C.dim;
    g.fillText('离散点：一个落点打 7 个随机小点', 132, 740);
    g.fillText('晕染：把上一处像素拖过来，补 1/4 固色', 712, 740);
    g.fillStyle = C.faint;
    g.font = font(15);
    g.fillText('另有 像素笔 / 圆笔 / 软笔 / 铅笔 / 橡皮，硬度·间距·抖动·流量可调', 132, 772);
    g.restore();
}

function toolsScene(g, p, imgA, imgB) {
    const a = easeOut(seg(p, 0, 0.4));
    const a1 = easeOut(seg(p, 0.08, 0.42));
    const a2 = easeOut(seg(p, 0.2, 0.56));
    screenshotCard(g, imgA, 132, 210, 700, 430, a1);
    screenshotCard(g, imgB, 862, 210, 390, 430, a2);
    g.save();
    g.globalAlpha = a;
    g.fillStyle = C.ink;
    g.font = font(36, '700');
    g.fillText('工具条只有一行', 132, 146);
    g.fillStyle = C.dim;
    g.font = font(17);
    g.fillText('笔刷 · 当前色块 · 大小 · 不透明度 · 取色 · 镜像 · 撤销重做 · 笔刷参数', 132, 176);
    g.restore();
}

function iosScene(g, p) {
    const a = easeOut(seg(p, 0, 0.4));
    const items = [
        ['PSD 导入', '图层 → 对象，组 → 父子层级，混色模式映射'],
        ['WebM 导出', '整段时长按帧率录制，优先 VP9'],
        ['精灵图 / PNG 序列', '一张 PNG + 每帧坐标 JSON'],
        ['项目存档', '关键帧、纹理、纹理库一起存，可复用'],
    ];
    g.save();
    g.globalAlpha = a;
    g.fillStyle = C.ink;
    g.font = font(38, '700');
    g.fillText('进出都留得住', 132, 216);
    g.restore();
    items.forEach(([k, v], i) => {
        const ap = easeOut(seg(p, 0.12 + i * 0.08, 0.4 + i * 0.08));
        g.save();
        g.globalAlpha = ap;
        const y = 300 + i * 92;
        g.fillStyle = C.panel;
        roundRect(g, 132, y - 34, 1120, 74, 4);
        g.fill();
        g.strokeStyle = C.line;
        g.stroke();
        g.fillStyle = C.accent;
        g.fillRect(132, y - 34, 3, 74);
        g.fillStyle = C.ink;
        g.font = font(20, '600');
        g.fillText(k, 156, y + 6);
        g.fillStyle = C.faint;
        g.font = font(17);
        g.fillText(v, 400, y + 6);
        g.restore();
    });
}

function endScene(g, p) {
    const a = easeOut(seg(p, 0, 0.45));
    const b = easeOut(seg(p, 0.22, 0.7));
    g.save();
    g.globalAlpha = a;
    g.fillStyle = C.ink;
    g.font = font(64, '800');
    g.fillText('MotionStudio', 132, 380);
    g.restore();
    g.save();
    g.globalAlpha = b;
    g.fillStyle = C.accent;
    g.fillRect(134, 406, 120 * b, 3);
    g.fillStyle = C.dim;
    g.font = font(20);
    g.fillText('时间驱动 · 画板独立 · 关键帧带纹理', 134, 452);
    g.fillStyle = C.panel2;
    roundRect(g, 134, 500, 520, 44, 4);
    g.fill();
    g.fillStyle = C.ink;
    g.font = font(18, '600');
    g.fillText('github.com/Satyr-Astry/motionstudio', 154, 528);
    g.restore();
}

/* ───────────────────────── 对外 ───────────────────────── */

const cache = new Map();

export const duration = DURATION;
export const size = { w: W, h: H };

export async function preload() {
    const jobs = Object.keys(IMG).map(async (key) => {
        if (cache.has(key)) return;
        const res = await fetch(IMG[key]);
        if (!res.ok) throw new Error('加载失败 ' + IMG[key] + ' ' + res.status);
        const blob = await res.blob();
        const bmp = await createImageBitmap(blob);
        cache.set(key, bmp);
    });
    await Promise.all(jobs);
    return cache.size;
}

const img = (k) => cache.get(k) || null;

/** 只依赖 t 的确定性渲染：录制时按固定 fps 逐帧调用即可。 */
export function draw(g, t, w, h) {
    const sx = w / W;
    const sy = h / H;
    g.save();
    g.setTransform(sx, 0, 0, sy, 0, 0);
    g.clearRect(0, 0, W, H);
    background(g, t);

    // 场景淡入淡出（0.35s 交叉）
    const FADE = 0.35;
    let active = SCENES[0];
    for (const s of SCENES) if (t >= s.at) active = s;
    const p = (t - active.at) / active.dur;

    for (const s of SCENES) {
        if (s.id !== active.id) continue;
        const local = clamp01((t - s.at) / s.dur);
        const outA = 1 - seg(t, s.at + s.dur - FADE, s.at + s.dur);
        g.save();
        g.globalAlpha = outA;
        if (s.id === 'title') titleScene(g, local);
        else if (s.id === 'timeline') timelineScene(g, local, img('ui'));
        else if (s.id === 'texture') textureScene(g, local, img('kf'));
        else if (s.id === 'board') boardScene(g, local, img('board'));
        else if (s.id === 'brush') brushScene(g, local, img('scatter'), img('smudge'));
        else if (s.id === 'tools') toolsScene(g, local, img('bar'), img('pal'));
        else if (s.id === 'io') iosScene(g, local);
        else if (s.id === 'end') endScene(g, local);
        g.restore();
    }

    watermark(g, t, active.id === 'title' ? 0 : 0.9);
    // 进度条：一条 2px 的主色线，比页码更克制
    g.fillStyle = 'rgba(255,255,255,0.06)';
    g.fillRect(0, H - 3, W, 3);
    g.fillStyle = C.accent;
    g.fillRect(0, H - 3, W * clamp01(t / DURATION), 3);
    g.restore();
    return p;
}

/* ───────── 在页面里录制：canvas.captureStream(0) + MediaRecorder ───────── */

/**
 * 逐帧录制整片。必须按真实时间等待（MediaRecorder 用墙上时钟），
 * 所以 27s 的片子大约要跑 27–40s。返回 Uint8Array 与 mime。
 */
export async function record(opts) {
    const o = opts || {};
    const fps = Math.max(12, Math.min(60, Math.round(o.fps || 30)));
    const cw = o.width || W;
    const ch = o.height || H;
    const cv = document.createElement('canvas');
    cv.width = cw;
    cv.height = ch;
    // 关键：画布必须真的在文档里并且被浏览器合成，captureStream 才会持续出帧。
    // 之前用离屏 canvas + requestFrame(0)，Electron 只交付了第一帧，成片是静止画面。
    cv.style.cssText = 'position:fixed;left:0;top:0;width:480px;height:auto;opacity:0.01;pointer-events:none;z-index:-1';
    document.body.appendChild(cv);
    const g = cv.getContext('2d');
    if (!g) throw new Error('拿不到 2d 上下文');
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
        .find((m) => typeof MediaRecorder === 'function' && MediaRecorder.isTypeSupported(m));
    if (!mime) throw new Error('当前环境不支持 WebM 录制');
    const stream = cv.captureStream(fps);
    const rec = new MediaRecorder(stream, {
        mimeType: mime,
        videoBitsPerSecond: Math.max(3000000, Math.round(cw * ch * fps * 0.18)),
    });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e && e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { rec.onstop = () => r(); });
    const t0 = performance.now();
    rec.start();
    let drawn = 0;
    await new Promise((resolve) => {
        const step = () => {
            const t = (performance.now() - t0) / 1000;
            if (t >= DURATION) { resolve(); return; }
            draw(g, Math.min(DURATION, t), cw, ch);
            drawn += 1;
            requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    });
    await new Promise((r) => setTimeout(r, 280));
    rec.stop();
    await stopped;
    for (const tk of stream.getTracks()) { try { tk.stop(); } catch (err) { /* 忽略 */ } }
    if (cv.parentNode) cv.parentNode.removeChild(cv);
    const blob = new Blob(chunks, { type: mime });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { bytes, mime, fps, frames: drawn, elapsedMs: Math.round(performance.now() - t0) };
}

/* ───────── 确定性导出：WebCodecs 编码 + 自带 WebM 封装 ─────────
   为什么不用 MediaRecorder：它拿的是「实时合成流」，页面被最小化/遮挡时
   Chromium 会节流 rAF 与合帧，录出来是静止画面。WebCodecs 是逐帧喂数据，
   与窗口是否可见无关，成片严格等于 draw(t) 的输出。 */

const EBML = {
    vint(n) {
        let len = 1;
        while (n >= 2 ** (7 * len) - 1) len += 1;
        const out = new Uint8Array(len);
        let v = n;
        for (let i = len - 1; i >= 0; i -= 1) { out[i] = v & 0xff; v = Math.floor(v / 256); }
        out[0] |= 1 << (8 - len);
        return out;
    },
    id(hex) { return new Uint8Array(hex.match(/.{2}/g).map((h) => parseInt(h, 16))); },
    cat(list) {
        let n = 0;
        for (const a of list) n += a.length;
        const out = new Uint8Array(n);
        let o = 0;
        for (const a of list) { out.set(a, o); o += a.length; }
        return out;
    },
    el(hex, payload) {
        const id = EBML.id(hex);
        const size = EBML.vint(payload.length);
        return EBML.cat([id, size, payload]);
    },
    uint(n) {
        const bytes = [];
        let v = Math.max(0, Math.floor(n));
        do { bytes.unshift(v & 0xff); v = Math.floor(v / 256); } while (v > 0);
        return new Uint8Array(bytes);
    },
    str(t) { return new TextEncoder().encode(t); },
    f64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return b; },
};

function webmFromChunks(chunks, width, height, fps, durationMs) {
    const header = EBML.el('1a45dfa3', EBML.cat([
        EBML.el('4286', EBML.uint(1)),
        EBML.el('42f7', EBML.uint(1)),
        EBML.el('42f2', EBML.uint(4)),
        EBML.el('42f3', EBML.uint(8)),
        EBML.el('4282', EBML.str('webm')),
        EBML.el('4287', EBML.uint(4)),
        EBML.el('4285', EBML.uint(2)),
    ]));
    const info = EBML.el('1549a966', EBML.cat([
        EBML.el('2ad7b1', EBML.uint(1000000)),
        EBML.el('4d80', EBML.str('MotionStudio Promo')),
        EBML.el('5741', EBML.str('promo.js')),
        EBML.el('4489', EBML.f64(durationMs)),
    ]));
    const tracks = EBML.el('1654ae6b', EBML.el('ae', EBML.cat([
        EBML.el('d7', EBML.uint(1)),
        EBML.el('73c5', EBML.uint(1)),
        EBML.el('83', EBML.uint(1)),
        EBML.el('9c', EBML.uint(0)),
        EBML.el('86', EBML.str('V_VP9')),
        EBML.el('23e383', EBML.uint(Math.round(1e9 / fps))),
        EBML.el('e0', EBML.cat([
            EBML.el('b0', EBML.uint(width)),
            EBML.el('ba', EBML.uint(height)),
        ])),
    ])));
    // 每 2 秒一个 Cluster；SimpleBlock 的相对时间戳是 int16（毫秒）
    const clusters = [];
    let cur = null;
    let curStart = 0;
    for (const c of chunks) {
        const ms = c.timestamp / 1000;
        if (!cur || ms - curStart > 2000) {
            if (cur) clusters.push(EBML.el('1f43b675', EBML.cat([EBML.el('e7', EBML.uint(curStart)), ...cur])));
            cur = [];
            curStart = ms;
        }
        const rel = Math.max(-32768, Math.min(32767, Math.round(ms - curStart)));
        const head = new Uint8Array(4);
        head[0] = 0x81;                       // track number 1
        head[1] = (rel >> 8) & 0xff;
        head[2] = rel & 0xff;
        head[3] = c.type === 'key' ? 0x80 : 0x00;
        cur.push(EBML.el('a3', EBML.cat([head, c.data])));
    }
    if (cur && cur.length) clusters.push(EBML.el('1f43b675', EBML.cat([EBML.el('e7', EBML.uint(curStart)), ...cur])));
    const segment = EBML.el('18538067', EBML.cat([info, tracks, ...clusters]));
    return EBML.cat([header, segment]);
}

/** 逐帧编码 + 封装，返回 { bytes, mime, fps, frames, elapsedMs }。 */
export async function encodeWebM(opts) {
    const o = opts || {};
    if (typeof VideoEncoder !== 'function') throw new Error('当前环境没有 WebCodecs（VideoEncoder）');
    const fps = Math.max(12, Math.min(60, Math.round(o.fps || 30)));
    const cw = o.width || W;
    const ch = o.height || H;
    const cv = document.createElement('canvas');
    cv.width = cw;
    cv.height = ch;
    const g = cv.getContext('2d');
    if (!g) throw new Error('拿不到 2d 上下文');
    const out = [];
    const enc = new VideoEncoder({
        output: (chunk) => {
            const buf = new Uint8Array(chunk.byteLength);
            chunk.copyTo(buf);
            out.push({ data: buf, timestamp: chunk.timestamp, type: chunk.type });
        },
        error: (e) => { throw e; },
    });
    enc.configure({
        codec: 'vp09.00.10.08',
        width: cw,
        height: ch,
        bitrate: Math.max(2500000, Math.round(cw * ch * fps * 0.12)),
        framerate: fps,
        latencyMode: 'quality',
    });
    const t0 = performance.now();
    const total = Math.round(DURATION * fps);
    for (let i = 0; i < total; i += 1) {
        draw(g, i / fps, cw, ch);
        const frame = new VideoFrame(cv, { timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps) });
        enc.encode(frame, { keyFrame: i % (fps * 2) === 0 });
        frame.close();
        if (i % 24 === 0) {
            // 让编码器有机会出队，避免内存堆积
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, 0));
        }
    }
    await enc.flush();
    enc.close();
    out.sort((a, b) => a.timestamp - b.timestamp);
    const bytes = webmFromChunks(out, cw, ch, fps, Math.round(DURATION * 1000));
    return { bytes, mime: 'video/webm;codecs=vp9', fps, frames: out.length, elapsedMs: Math.round(performance.now() - t0) };
}
