/**
 * Kleks Motion —— 撤销栈
 *
 * 命令式，不是快照式：每个命令自带 undo / redo。
 * 图层位图动辄几十 MB，整帧快照会把内存吃光，所以命令只记录
 * 「被改动的矩形 + 改动前后像素」（见 paint/patch.mjs）。
 */

export function createHistory(limit = 120) {
    const undoStack = [];
    const redoStack = [];
    const listeners = new Set();

    const api = {
        push(cmd) {
            if (!cmd || typeof cmd.undo !== 'function' || typeof cmd.redo !== 'function') return false;
            undoStack.push(cmd);
            while (undoStack.length > limit) undoStack.shift();
            redoStack.length = 0;
            emit();
            return true;
        },
        undo() {
            const cmd = undoStack.pop();
            if (!cmd) return false;
            cmd.undo();
            redoStack.push(cmd);
            emit();
            return true;
        },
        redo() {
            const cmd = redoStack.pop();
            if (!cmd) return false;
            cmd.redo();
            undoStack.push(cmd);
            emit();
            return true;
        },
        // 偏好面板可以改撤销步数上限：limit 是闭包参数，重赋值即可
        setLimit(n) {
            const v = Math.max(1, Math.round(Number(n)) || 120);
            limit = v;
            while (undoStack.length > v) undoStack.shift();
            emit();
            return v;
        },
        getLimit: () => limit,
        canUndo: () => undoStack.length > 0,
        canRedo: () => redoStack.length > 0,
        clear() {
            undoStack.length = 0;
            redoStack.length = 0;
            emit();
        },
        size: () => undoStack.length,
        depth: () => ({ undo: undoStack.length, redo: redoStack.length }),
        labels: () => undoStack.map((c) => c.label || ''),
        subscribe(cb) {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
    };

    function emit() {
        for (const cb of Array.from(listeners)) {
            try {
                cb(api);
            } catch (err) {
                /* 单个订阅者异常不影响其它订阅者 */
            }
        }
    }

    return api;
}
