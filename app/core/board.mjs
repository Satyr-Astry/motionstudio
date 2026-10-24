/**
 * MotionStudio —— 画板（board）：对象的「出生地」
 *
 * 设计动机（用户 m09929 / m09945）：对象不应该在主程序里被内联拼出来，而应该像
 * Kleks 那样先在一块**画板**上画，画完再「提交」成对象。这样：
 *   1. 创建对象的过程有独立的工作区（draw），不污染动画编辑器；
 *   2. 画板的尺寸、清空、重画都是画板自己的状态，与 doc 无关；
 *   3. 提交是**一次原子操作**（object-factory.createObjectFromBoard），
 *      失败不会留下半个对象。
 *
 * 本模块是纯数据：不碰 DOM、不 import 任何 shell 模块、不改入参。
 * 位图（surface）由调用方提供（HTMLCanvasElement / OffscreenCanvas 都行，
 * 只需要 width / height 两个数值字段），这样 Node 里也能测。
 */

/** 新画板默认尺寸。与文档默认画布一致，省得每次改。 */
export const BOARD_DEFAULT = Object.freeze({ width: 640, height: 480 });

/** 画板允许的尺寸范围。 */
export const BOARD_MIN = 16;
export const BOARD_MAX = 4096;

let boardSeq = 0;

function clampSize(n, fallback) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v) || v <= 0) return fallback;
    return Math.min(BOARD_MAX, Math.max(BOARD_MIN, v));
}

/**
 * 造一块空画板。
 * @param {{width?:number,height?:number,name?:string,surface?:any}} [o]
 */
export function createBoard(o) {
    const src = o && typeof o === 'object' ? o : {};
    boardSeq += 1;
    return {
        id: 'board-' + boardSeq,
        name: src.name ? String(src.name) : '画板 ' + boardSeq,
        width: clampSize(src.width, BOARD_DEFAULT.width),
        height: clampSize(src.height, BOARD_DEFAULT.height),
        surface: src.surface || null,
        dirty: false,
    };
}

/** 画板是否还没有任何内容（没位图，或位图但从未落笔）。 */
export function boardIsEmpty(board) {
    if (!board || typeof board !== 'object') return true;
    if (!board.surface) return true;
    return board.dirty !== true;
}

/** 换一张位图（尺寸以 board 为准，调用方负责位图尺寸匹配）。 */
export function setBoardSurface(board, surface) {
    if (!board || typeof board !== 'object') return board;
    return Object.assign({}, board, { surface: surface || null, dirty: !!surface });
}

/** 标记「已经画过东西」——画笔落第一笔时调用。 */
export function markBoardDirty(board) {
    if (!board || typeof board !== 'object' || board.dirty) return board;
    return Object.assign({}, board, { dirty: true });
}

/** 清空画板（保留尺寸与名字）。位图由调用方负责重绘。 */
export function clearBoard(board) {
    if (!board || typeof board !== 'object') return board;
    return Object.assign({}, board, { dirty: false });
}

/** 改尺寸。会丢掉内容（画板是草稿，不做缩放重采样）。 */
export function resizeBoard(board, width, height) {
    if (!board || typeof board !== 'object') return board;
    return Object.assign({}, board, {
        width: clampSize(width, board.width),
        height: clampSize(height, board.height),
        surface: null,
        dirty: false,
    });
}

/** 画板在 UI 上的标题，例如「画板 2 · 640×480」。 */
export function boardLabel(board) {
    if (!board || typeof board !== 'object') return '画板';
    return board.name + ' · ' + board.width + '×' + board.height;
}

/**
 * 画板 → 对象草稿。只产出 makeObject 需要的字段，不碰 doc。
 * 位图原样带过去（不拷贝）：调用的那一刻位图已经画完，之后不会再改。
 */
export function boardToObjectDraft(board, o) {
    const src = o && typeof o === 'object' ? o : {};
    if (!board || typeof board !== 'object') return null;
    return {
        name: src.name ? String(src.name) : board.name,
        image: board.surface || null,
        width: board.width,
        height: board.height,
        at: Number.isFinite(src.at) ? src.at : 0,
    };
}
