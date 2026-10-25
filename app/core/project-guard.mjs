/**
 * 项目切换前的数据安全判定 —— 纯函数，零 DOM、零存储、node 里可直跑。
 *
 * 为什么要独立成一层：真正的「保存 / 载入 / 新建 / 删除」都发生在 `shell/project-io.mjs`，
 * 那里有 IndexedDB、浮层、flash，没法在测试里跑。把**判据**抽出来，测试才能钉住
 * 「什么情况下该静默保存、什么情况下必须先问用户」这套规则，而调用方只负责把结果变成界面。
 */

/** 未命名草稿在项目库里的固定键（与真实项目同库，用 `__draft` 标记区分）。 */
export const DRAFT_ID = '__draft__';

/**
 * 切换项目（载入 / 新建 / 导入文件）之前该怎么做。
 *
 * - 没改动 → 直接走；
 * - 有改动且**存过**（既有 id 又有名字）→ 先静默入库再走：保存过一次的人不该每次被弹窗打断；
 * - 有改动但没名字 → 必须问：保存需要名字，替用户编一个名字比问他更坏。
 *
 * @param {{dirty?:boolean,id?:string,name?:string}} state
 * @returns {{action:'proceed'|'save-then-proceed'|'ask', reason:string}}
 */
export function guardDecision(state) {
    const s = state && typeof state === 'object' ? state : {};
    const dirty = !!s.dirty;
    const id = String(s.id == null ? '' : s.id).trim();
    const name = String(s.name == null ? '' : s.name).trim();
    if (!dirty) return { action: 'proceed', reason: 'clean' };
    if (id && name) return { action: 'save-then-proceed', reason: 'dirty-saved' };
    if (!name) return { action: 'ask', reason: 'dirty-unnamed' };
    return { action: 'ask', reason: 'dirty-unsaved' };
}

/**
 * 三选浮层选完之后实际要做什么。
 * 取消 / 关闭 / 任何不认识的返回值一律当成「别动」，不猜用户意图。
 * @param {string|null|undefined} choice 'save' | 'discard' | 'cancel'
 * @returns {{action:'save'|'proceed'|'abort', reason:string}}
 */
export function choiceOutcome(choice) {
    if (choice === 'save') return { action: 'save', reason: 'user-save' };
    if (choice === 'discard') return { action: 'proceed', reason: 'user-discard' };
    return { action: 'abort', reason: choice === 'cancel' ? 'user-cancel' : 'no-choice' };
}

/**
 * 删除确认文案。删除当前打开的项目时要把「文档还在内存」说出来 ——
 * 用户最怕的就是「我删了它，我画的东西是不是也没了」。
 * @param {string} name
 * @param {boolean} isCurrent
 * @returns {string}
 */
export function deleteConfirmText(name, isCurrent) {
    const n = String(name == null ? '' : name).trim() || '未命名项目';
    if (isCurrent) return '删除「' + n + '」？当前文档还在内存里，不会跟着消失。';
    return '删除「' + n + '」？';
}

/** 草稿恢复浮层的一句话说明（两种按钮文案由调用方给）。 */
export function draftPromptText(savedAt) {
    const at = Number(savedAt);
    if (!Number.isFinite(at) || at <= 0) return '发现上次未保存的草稿，要恢复吗？';
    const d = new Date(at);
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return '发现上次未保存的草稿（' + hh + ':' + mi + '），要恢复吗？';
}

/**
 * 这条记录是不是草稿 —— 项目列表要把它藏起来，别让它冒充一个项目。
 * @param {object} rec
 */
export function isDraftRecord(rec) {
    if (!rec || typeof rec !== 'object') return false;
    return rec.__draft === true || rec.id === DRAFT_ID;
}

/**
 * 草稿记录的展示名：草稿本身没有名字，列表里也不该出现，但存档里得有一个可读的。
 * @param {string} name
 */
export function draftName(name) {
    const n = String(name == null ? '' : name).trim();
    return n ? n + '（草稿）' : '未命名草稿';
}
