/**
 * MotionStudio —— 视频导出的「计划」部分（纯函数、零依赖、零 DOM）
 *
 * 录制本身要 canvas + MediaRecorder，只能在真机跑；但「录多少帧、多大码率、
 * 用哪种封装」是纯算术，抽出来之后就能在 node --test 里钉死，避免每次改都靠肉眼。
 */

/** 候选封装，优先 vp9（同码率画质最好），退 vp8，再退裸 webm。 */
export const VIDEO_MIME_LIST = Object.freeze([
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
]);

/**
 * 从候选里挑第一个「被支持」的封装。
 * @param {(mime:string)=>boolean} isSupported 一般是 MediaRecorder.isTypeSupported
 * @param {readonly string[]} [list]
 * @returns {string} 空串表示一个都不支持
 */
export function pickVideoMime(isSupported, list) {
    const pool = Array.isArray(list) && list.length ? list : VIDEO_MIME_LIST;
    if (typeof isSupported !== 'function') return '';
    for (const mime of pool) {
        try {
            if (isSupported(mime)) return mime;
        } catch (err) {
            /* 某些实现传奇怪 mime 会抛，忽略继续试 */
        }
    }
    return '';
}

/** 帧率：夹到 1..60，非法回落到文档帧率，再回落 12。 */
export function videoFps(want, docFps) {
    const a = Number(want);
    const b = Number(docFps);
    const fps = Number.isFinite(a) && a > 0 ? a : Number.isFinite(b) && b > 0 ? b : 12;
    return Math.max(1, Math.min(60, Math.round(fps)));
}

/** 秒数：夹到 0.1..600，非法回落到文档时长，再回落 1。 */
export function videoSeconds(want, docSeconds) {
    const a = Number(want);
    const b = Number(docSeconds);
    const sec = Number.isFinite(a) && a > 0 ? a : Number.isFinite(b) && b > 0 ? b : 1;
    return Math.max(0.1, Math.min(600, sec));
}

/** 总帧数（至少 1）。 */
export function videoFrameCount(seconds, fps) {
    const s = Number(seconds);
    const f = Number(fps);
    if (!Number.isFinite(s) || !Number.isFinite(f) || s <= 0 || f <= 0) return 1;
    return Math.max(1, Math.round(s * f));
}

/** 画布尺寸：取整并至少 1×1。 */
export function videoCanvasSize(width, height) {
    const w = Math.max(1, Math.round(Number(width) || 0));
    const h = Math.max(1, Math.round(Number(height) || 0));
    return { width: Number.isFinite(w) ? w : 1, height: Number.isFinite(h) ? h : 1 };
}

/**
 * 码率：按「像素 × 帧率」估一个够用的值，下限 1.2 Mbps。
 * 0.12 bit/像素/帧 ≈ 动画常见的「大面积纯色 + 少量描边」档位，再低会糊边。
 */
export function videoBitrate(width, height, fps) {
    const w = Math.max(1, Math.round(Number(width) || 1));
    const h = Math.max(1, Math.round(Number(height) || 1));
    const f = Math.max(1, Math.round(Number(fps) || 1));
    return Math.max(1200000, Math.round(w * h * f * 0.12));
}

/** 录制时间轴漂移容忍量（毫秒）：超过它说明浏览器把计时器节流了（窗口在后台）。 */
export const RECORD_DRIFT_TOLERANCE_MS = 600;

/**
 * 录制期间「要不要中止」的判定（纯函数，待修清单 A3）。
 *
 * 背景：MediaRecorder 的时间轴是**墙上时钟**，而驱动帧循环的是 `setTimeout`。
 * 窗口被最小化/完全遮挡时 Chromium 会把计时器节流到约 1 秒，循环跟不上 →
 * 录出来的视频变慢、甚至整段是静止画面。以前只能在文档里写「请保持窗口前台」，
 * 用户切走一会儿就得到一份坏文件且**不知道**。
 *
 * 这里把判据抽出来，让 recordVideo 在真出事时**主动中止并报错**：
 *   - `'hidden'`    页面已经不可见（直接判据，最快）；
 *   - `'throttled'` 墙钟比「应到第 i 帧的时刻」落后超过容忍量（间接判据：即使
 *                   visibilityState 没变，节流也可能已经发生）；
 *   - `''`          继续录。
 *
 * @param {{hidden?:boolean, driftMs?:number, toleranceMs?:number}} [state]
 * @returns {''|'hidden'|'throttled'}
 */
export function recordingAbortReason(state) {
    const s = state && typeof state === 'object' ? state : {};
    if (s.hidden === true) return 'hidden';
    const tolerance = Number(s.toleranceMs);
    const limit = Number.isFinite(tolerance) && tolerance > 0 ? tolerance : RECORD_DRIFT_TOLERANCE_MS;
    const drift = Number(s.driftMs);
    if (Number.isFinite(drift) && drift > limit) return 'throttled';
    return '';
}
