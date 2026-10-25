/**
 * MotionStudio —— 导出与项目 IO：逐帧 PNG / 精灵图 / 项目库 / .json 存档
 *
 * 所有落盘都经过 ipc.mjs（唯一接触 window.motionAPI 的地方），
 * 浏览器里没有桥时这些入口返回 null，不会抛异常。
 * 项目库只是 project-store 的一层 UI：卡片、缩略图、新建 / 打开 / 导入 / 删除。
 *
 * 依赖方向：doc-state（state / 默认画布尺寸 / applyDoc 换文档 / 面板刷新）、
 * core（cel / timebase）、paint（composite）、spritesheet、ipc、project-store、
 * registry；以及 app.mjs 的 ctx —— 只被 openProjectsPanel 在运行期读取。
 * doc-state 反向 import 本模块的 project / markDirty / notifyProjects，
 * 双方都只在函数体里解引用，循环因此安全。
 */

import {
    createDocument,
    totalSeconds,
} from '../core/cel.mjs';
import { sampleTimes } from '../core/timebase.mjs';
import { compositeFrame } from '../paint/composite.mjs';
import { editorDef } from './registry.mjs';
import * as ipc from './ipc.mjs';
import { importBuffer, pickAndImport } from './import-file.mjs';
import * as store from './project-store.mjs';
import { buildSpritesheet } from './spritesheet.mjs';
import { icon } from '../core/icons.mjs';
import { pickVideoMime, videoBitrate, videoCanvasSize, videoFps, videoFrameCount, videoSeconds } from './video-plan.mjs';
import {
    DEFAULT_W,
    DEFAULT_H,
    DEFAULT_FPS,
    DEFAULT_FRAMES,
    state,
    shell,
    el,
    clampInt,
    enrichDoc,
    applyDoc,
    setDoc,
    flash,
    updateChrome,
    markDirty,
    notifyProjects,
    onProjectsChange,
    project,
    engine,
} from './doc-state.mjs';
// 运行期注入，理由同 view-host.mjs
let CTX = null;
/** 由 app.mjs 在 boot() 里注入。 */
export function setCtx(c) {
    CTX = c;
}

/**
 * 当前项目元信息（和 doc 分开：doc 是纯内容，这里是「存档身份」）。
 * id 是项目库主键（空 = 还没保存过）；file 是最近一次存成 .json 的路径；
 * dirty 表示保存之后又有改动，顶栏会显示 `名称 •`。
 */
let saveBusy = false;

function exportFrames(name) {
    const doc = state.doc;
    if (!doc || typeof document === 'undefined') return null;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, doc.width | 0);
    cv.height = Math.max(1, doc.height | 0);
    const frames = [];
    // v6：按时间采样 —— 每段用自己的 fps 生成时间点，再按时间取画格合成。
    // 帧数组已删除，导出完全是「时间 → 图像」的映射。
    const times = sampleTimes(doc, totalSeconds(doc));
    const list = times.length ? times : [0];
    for (const s of list) {
        const t = typeof s === 'number' ? s : s && typeof s.t === 'number' ? s.t : 0;
        compositeFrame(cv, doc, t, { clear: true });
        frames.push(cv.toDataURL('image/png'));
    }
    const label = String(name == null ? 'motionstudio' : name);
    const res = ipc.exportFrames(label, frames);
    if (res == null) {
        flash('导出接口不可用（非桌面环境）');
        updateChrome();
        return null;
    }
    if (res && typeof res.then === 'function') {
        res.then(
            () => {
                flash('已导出 ' + frames.length + ' 帧');
                updateChrome();
            },
            (err) => {
                console.error('[shell] 导出失败：', err);
                flash('导出失败');
                updateChrome();
            }
        );
    } else {
        flash('已导出 ' + frames.length + ' 帧');
        updateChrome();
    }
    return res;
}

/** 导出精灵图（PNG + 每帧坐标 JSON），落盘由主进程 ms:export-sheet 负责。 */
async function exportSpritesheet(opts) {
    const o = opts || {};
    if (!state.doc || typeof document === 'undefined') return null;
    if (typeof buildSpritesheet !== 'function') {
        flash('精灵图模块未加载');
        return null;
    }
    const sheet = buildSpritesheet(state.doc, o);
    if (!sheet || !sheet.canvas) {
        flash('没有可导出的帧');
        return null;
    }
    const png = sheet.canvas.toDataURL('image/png');
    const res = await Promise.resolve(ipc.exportSheet(projectLabel(), png, sheet.json));
    if (!res) {
        flash('导出接口不可用（非桌面环境）');
        return null;
    }
    if (res.ok === false) {
        flash(res.canceled ? '已取消导出' : '导出精灵图失败');
        return null;
    }
    flash('已导出精灵图 ' + sheet.frames.length + ' 帧');
    return res;
}

/* ─────────────────────────── 项目：保存 / 打开 / 新建 ─────────────────────────── */

function pad2(n) {
    return n < 10 ? '0' + n : String(n);
}

function stamp(d) {
    const t = d || new Date();
    return (
        t.getFullYear().toString() +
        pad2(t.getMonth() + 1) +
        pad2(t.getDate()) +
        '-' +
        pad2(t.getHours()) +
        pad2(t.getMinutes())
    );
}

function defaultProjectName() {
    return '项目-' + stamp();
}

function baseName(path) {
    const s = String(path == null ? '' : path);
    const cut = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return (cut >= 0 ? s.slice(cut + 1) : s).replace(/\.(msp|json)$/i, '');
}

/** 顶栏显示的当前项目名。 */
function projectLabel() {
    return project.name || '未命名项目';
}

/** 有改动就标脏：只在 false → true 时刷一次顶栏，避免每笔都刷新。 */


function subscribeProjects(fn) {
    if (typeof fn !== 'function') return () => {};
    projectListeners.add(fn);
    return () => projectListeners.delete(fn);
}

/** 缩略图：把第 1 帧合成到全尺寸临时画布，再等比缩到 128 宽（项目库卡片用）。 */
function frameThumb(doc) {
    if (!doc || typeof document === 'undefined') return '';
    try {
        const full = document.createElement('canvas');
        full.width = Math.max(1, doc.width | 0);
        full.height = Math.max(1, doc.height | 0);
        compositeFrame(full, doc, 0, { clear: true });
        const scale = Math.min(1, 128 / Math.max(1, full.width));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(full.width * scale));
        cv.height = Math.max(1, Math.round(full.height * scale));
        const g = cv.getContext('2d');
        if (!g) return '';
        g.drawImage(full, 0, 0, full.width, full.height, 0, 0, cv.width, cv.height);
        return cv.toDataURL('image/png');
    } catch (err) {
        console.error('[shell] 生成缩略图失败：', err);
        return '';
    }
}


function currentProject() {
    return { id: project.id, name: project.name, file: project.file, dirty: project.dirty, label: projectLabel() };
}

/**
 * 保存到项目库（无对话框，立即生效）。
 * 命名规则：显式 name > 当前项目名 > 弹一次内联输入框（问一次，取消就放弃）。
 * 首次保存顺带调一次 .json 保存对话框（默认落在「文档」目录），之后 Ctrl+S 只更新库。
 */
async function saveProject(name) {
    const doc = state.doc;
    if (!doc || saveBusy) return false;
    let label = String(name == null ? project.name || '' : name).trim();
    if (!label) {
        label = await askProjectName(defaultProjectName());
        label = String(label || '').trim();
        if (!label) {
            flash('已取消保存');
            return false;
        }
    }
    saveBusy = true;
    try {
        const rec = store.makeRecord({
            id: project.id || '',
            name: label,
            doc: doc,
            thumb: frameThumb(doc),
            file: project.file || '',
        });
        const saved = await store.putProject(rec);
        project.id = (saved && saved.id) || rec.id;
        project.name = label;
        project.dirty = false;
        store.setCurrentProjectId(project.id);
        flash('已保存 ' + label);
        updateChrome();
        notifyProjects();
        if (!project.file) await writeProjectFile(project.id, { quiet: true });
        return true;
    } catch (err) {
        console.error('[shell] 保存失败：', err);
        flash('保存失败：' + ((err && err.message) || err));
        return false;
    } finally {
        saveBusy = false;
    }
}

/** 把库里的项目（或当前文档）写成一个 .json 文件；返回主进程的结果或 null。 */
async function writeProjectFile(id, opts) {
    const o = opts || {};
    let payload = null;
    if (id) {
        const rec = await store.getProject(id);
        if (rec && rec.project) payload = rec.project;
    }
    if (!payload) {
        // v2 扁平文件：format/version/elements/frames/assets 全部平铺在顶层
        if (typeof store.docToFile === 'function') {
            payload = await store.docToFile(state.doc, { name: projectLabel() });
        } else {
            payload = {
                format: store.FORMAT,
                version: store.VERSION,
                name: projectLabel(),
                savedAt: Date.now(),
                doc: store.docToJSON(state.doc),
            };
        }
    }
    let json = '';
    try {
        json = JSON.stringify(payload);
    } catch (err) {
        flash('序列化失败');
        return null;
    }
    let out = null;
    try {
        out = await Promise.resolve(ipc.saveProject(projectLabel(), json));
    } catch (err) {
        console.error('[shell] 保存文件失败：', err);
        out = null;
    }
    if (!out) {
        if (!o.quiet) flash('保存对话框不可用（非桌面环境）');
        return null;
    }
    if (out.ok === false) {
        if (!o.quiet) flash(out.canceled ? '已取消保存' : '保存文件失败');
        return null;
    }
    if (out.file) {
        project.file = out.file;
        if (id) {
            const rec = await store.getProject(id);
            if (rec) {
                rec.file = out.file;
                await store.putProject(rec);
            }
        }
        if (!o.quiet) flash('已保存文件：' + out.file);
        updateChrome();
        notifyProjects();
    }
    return out;
}

/** 从 .json 导入：读文件 → 校验 → 入库 → 打开。 */
async function importProjectFile() {
    let out = null;
    try {
        out = await Promise.resolve(ipc.loadProject());
    } catch (err) {
        console.error('[shell] 打开文件失败：', err);
        out = null;
    }
    if (!out) {
        flash('打开对话框不可用（非桌面环境）');
        return false;
    }
    if (out.ok === false) {
        flash(out.canceled ? '已取消打开' : '打开文件失败');
        return false;
    }
    let payload = out.json;
    if (typeof payload === 'string') {
        try {
            payload = JSON.parse(payload);
        } catch (err) {
            flash('文件不是合法 JSON');
            return false;
        }
    }
    if (!store.isProjectPayload(payload)) {
        flash('不是 MotionStudio 项目文件');
        return false;
    }
    // jsonToDoc 同时接受 v2 扁平文件、老信封 {doc:…} 与 v1 节点
    const doc = await store.jsonToDoc(payload);
    if (!doc) {
        flash('项目内容损坏');
        return false;
    }
    const name = String(payload.name || baseName(out.file) || '导入的项目');
    const rec = store.makeRecord({ name, doc, thumb: frameThumb(doc), file: out.file || '' });
    const saved = await store.putProject(rec);
    applyDoc(doc, { id: (saved && saved.id) || rec.id, name: rec.name, file: rec.file });
    flash('已导入 ' + rec.name);
    notifyProjects();
    return true;
}

/** 载入项目：入参可以是库里的 id、轻量记录，或完整项目对象。 */
async function loadProject(entry) {
    try {
        let source = null;
        if (typeof entry === 'string') source = await store.getProject(entry);
        else if (entry && entry.project) source = entry;
        else if (entry && entry.id) source = await store.getProject(entry.id);
        if (!source || !source.project) {
            flash('项目不存在');
            return false;
        }
        const doc = await store.jsonToDoc(source.project.doc);
        if (!doc) {
            flash('项目内容损坏');
            return false;
        }
        const ok = applyDoc(doc, { id: source.id, name: source.name, file: source.file });
        if (ok) flash('已载入 ' + (source.name || '项目'));
        return ok;
    } catch (err) {
        console.error('[shell] 载入项目失败：', err);
        flash('载入失败：' + ((err && err.message) || err));
        return false;
    }
}

/** 新建空白项目（默认沿用 900×640 / 12 fps / 12 帧）。 */
function newProject(opts) {
    const o = opts || {};
    const width = clampInt(o.width == null ? DEFAULT_W : o.width, 16, 8192);
    const height = clampInt(o.height == null ? DEFAULT_H : o.height, 16, 8192);
    const fps = Math.max(1, Math.min(120, Number(o.fps) > 0 ? Number(o.fps) : DEFAULT_FPS));
    const frames = clampInt(o.frames == null ? DEFAULT_FRAMES : o.frames, 1, 1200);
    // v6：没有帧数组，「帧数」只是「时长 = 帧数 / fps」的便捷说法
    const doc = createDocument({ width, height, fps, duration: frames / fps, layerName: o.layerName || '对象 1' });
    const ok = applyDoc(enrichDoc(doc), { id: '', name: '', file: '', dirty: false });
    if (ok) flash('已新建 ' + width + '×' + height + ' · ' + frames + ' 帧 / ' + (frames / fps).toFixed(2) + ' s');
    return ok;
}

/** 内联项目名输入框（不用 window.prompt：Electron 里它默认不可用）。 */
function askProjectName(def) {
    if (typeof document === 'undefined' || !document.body) return Promise.resolve('');
    return new Promise((resolve) => {
        const host = shell.host || document.body;
        const box = el('div', 'ms-ask');
        box.style.position = 'absolute';
        box.style.left = '50%';
        box.style.top = '76px';
        box.style.transform = 'translateX(-50%)';
        box.style.zIndex = '9999';
        box.style.display = 'flex';
        box.style.gap = '8px';
        box.style.alignItems = 'center';
        box.style.padding = '10px 12px';
        box.style.background = '#1d2027';
        box.style.border = '1px solid #3a3f4b';
        box.style.borderRadius = '8px';
        box.style.color = '#e6e8ee';
        box.style.font = '12px/1.4 system-ui, sans-serif';

        box.appendChild(el('span', 'ms-ask-label', '项目名称'));
        const input = el('input', 'ms-ask-input');
        input.type = 'text';
        input.value = String(def || '');
        input.style.minWidth = '220px';
        const ok = el('button', 'ms-ask-ok', '保存');
        ok.type = 'button';
        const cancel = el('button', 'ms-ask-cancel', '取消');
        cancel.type = 'button';
        box.appendChild(input);
        box.appendChild(ok);
        box.appendChild(cancel);

        let done = false;
        function finish(value) {
            if (done) return;
            done = true;
            window.removeEventListener('keydown', onKey, true);
            if (box.parentNode) box.parentNode.removeChild(box);
            resolve(value);
        }
        function onKey(ev) {
            if (ev.key === 'Escape') {
                ev.preventDefault();
                ev.stopPropagation();
                finish('');
            } else if (ev.key === 'Enter') {
                ev.preventDefault();
                ev.stopPropagation();
                finish(String(input.value || '').trim());
            }
        }
        ok.addEventListener('click', () => finish(String(input.value || '').trim()));
        cancel.addEventListener('click', () => finish(''));
        window.addEventListener('keydown', onKey, true);
        host.appendChild(box);
        try {
            input.focus();
            if (typeof input.select === 'function') input.select();
        } catch (err) {
            /* 拿不到焦点也不影响点击 */
        }
    });
}

/* 项目库浮层：不改用户的区域树，直接 mount 一份 projects 编辑器进浮层。 */

/** 当前打开的浮层（同一时刻只允许一个）。 */
let projectsModal = null;

/**
 * 项目库面板本身没有随 T4 的样式表一起落盘（app/styles 里没有任何 .prj- 规则），
 * 浮层里不能只显示一堆裸文本，所以这里补一份**只作用于 .ms-modal 内部**的样式。
 * 全部走 tokens.css 的主题变量；将来 T4 若要写全局 .prj-* 样式，删掉这个函数即可。
 */
const MODAL_CSS = [
    '.ms-modal .prj-panel{display:flex;flex-direction:column;height:100%;min-height:0;font:12.5px/1.5 inherit;color:var(--ink)}',
    '.ms-modal .prj-head{display:flex;align-items:center;gap:6px;padding:8px 12px;border-bottom:1px solid var(--line)}',
    '.ms-modal .prj-title{display:none}',
    '.ms-modal .prj-empty{display:none}',
    '.ms-modal .prj-count{color:var(--ink-dim)}',
    '.ms-modal .prj-gap{flex:1 1 auto}',
    '.ms-modal .prj-btn{font:inherit;color:var(--ink);background:var(--panel-2);border:1px solid var(--line-2);border-radius:var(--r-1);padding:3px 9px;cursor:pointer}',
    '.ms-modal .prj-btn:hover{background:var(--surface)}',
    '.ms-modal .prj-btn:active{background:var(--bg-2)}',
    '.ms-modal .prj-hint{padding:4px 12px;color:var(--ink-faint);font-size:12px;border-bottom:1px solid var(--line)}',
    '.ms-modal .prj-list{flex:1 1 auto;min-height:0;overflow:auto;padding:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;align-content:start}',
    '.ms-modal .prj-card{display:grid;grid-template-columns:104px minmax(0,1fr);grid-template-areas:"thumb meta" "thumb actions";align-items:start;gap:6px 10px;padding:8px;border:1px solid var(--line-2);border-radius:var(--r-2);background:var(--panel-2);cursor:pointer}',
    '.ms-modal .prj-card:hover{border-color:var(--ink-faint)}',
    '.ms-modal .prj-card.is-current{border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}',
    '.ms-modal .prj-thumb{grid-area:thumb;width:104px;height:74px;border-radius:var(--r-1);overflow:hidden;background:var(--bg-2);display:flex;align-items:center;justify-content:center}',
    '.ms-modal .prj-thumb-img{width:100%;height:100%;object-fit:cover;display:block}',
    '.ms-modal .prj-thumb-empty{color:var(--ink-faint);font-size:11px}',
    '.ms-modal .prj-meta{grid-area:meta;min-width:0;display:flex;flex-direction:column;gap:2px}',
    '.ms-modal .prj-name-row{display:flex;align-items:center;gap:6px;min-width:0}',
    '.ms-modal .prj-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ms-modal .prj-badge{flex:0 0 auto;font-size:11px;line-height:1.6;padding:0 5px;border-radius:var(--r-1);background:rgba(74,125,255,.22);color:var(--ink)}',
    '.ms-modal .prj-sub,.ms-modal .prj-time{color:var(--ink-dim);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.ms-modal .prj-actions{grid-area:actions;display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}',
    '.ms-modal .prj-actions .prj-btn{padding:2px 7px;font-size:12px}',
    '.ms-modal .prj-rename{font:inherit;color:var(--ink);background:var(--bg-2);border:1px solid var(--accent);border-radius:var(--r-1);padding:2px 6px;width:150px;min-width:0}',
    '.ms-modal .prj-empty{padding:24px 12px;text-align:center;color:var(--ink-faint)}',
    '.ms-modal .prj-off{opacity:.5}',
    // 空库时的唯一主行动：放在列表区正中（grid 里跨满整行），而不是塞在工具栏上方当第二排按钮。
    '.ms-modal .ms-modal-cta{grid-column:1/-1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;padding:46px 16px;text-align:center}',
    '.ms-modal .ms-modal-cta-icon{display:flex;color:var(--ink-faint)}',
    '.ms-modal .ms-modal-cta-icon .ms-icon{width:var(--icon-lg);height:var(--icon-lg);stroke-width:1.4}',
    '.ms-modal .ms-modal-cta-tip{color:var(--ink-dim);font-size:13px}',
    '.ms-modal .ms-modal-cta-sub{color:var(--ink-faint);font-size:12px}',
    '.ms-modal .ms-modal-cta-btn{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:13px;padding:7px 16px;border:1px solid var(--accent);border-radius:var(--r-2);background:rgba(74,125,255,.16);color:var(--ink);cursor:pointer;transition:background-color var(--t-fast)}',
    '.ms-modal .ms-modal-cta-btn:hover{background:rgba(74,125,255,.26)}',
    '.ms-modal .ms-modal-cta-btn:active{background:rgba(74,125,255,.34)}',
].join('\n');

/** 惰性注入上面的样式表（只插一次）。 */
function ensureModalCss() {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.getElementById('ms-modal-css')) return;
    const style = document.createElement('style');
    style.id = 'ms-modal-css';
    style.textContent = MODAL_CSS;
    document.head.appendChild(style);
}

/** 关闭浮层：面板自己 destroy → 摘 DOM → 撤监听。顺序反了会留下订阅。 */
function closeProjectsModal() {
    const m = projectsModal;
    if (!m) return false;
    projectsModal = null;
    try {
        if (m.inst && typeof m.inst.destroy === 'function') m.inst.destroy();
    } catch (err) {
        console.error('[shell] 项目库浮层销毁失败：', err);
    }
    window.removeEventListener('keydown', m.onKey, true);
    m.root.removeEventListener('click', m.onMask);
    if (m.root.parentNode) m.root.parentNode.removeChild(m.root);
    return true;
}

/**
 * 空库时在浮层里加一个显眼的新建入口；库里有内容就把入口撤掉。
 * 重复打开浮层只 refresh 时也要重新判一次，否则空库时插进去的入口会一直留着。
 */
function syncProjectsCta(m) {
    if (!m || m !== projectsModal) return;
    Promise.resolve(store.listProjects())
        .then((items) => {
            if (m !== projectsModal) return;
            const body = m.body;
            const old = typeof body.querySelector === 'function' ? body.querySelector('.ms-modal-cta') : null;
            if (items && items.length) {
                if (old && old.parentNode) old.parentNode.removeChild(old);
                return;
            }
            if (old) return;
            const cta = el('div', 'ms-modal-cta');
            const iconBox = el('div', 'ms-modal-cta-icon');
            iconBox.innerHTML = icon('folder-open');
            const tip = el('div', 'ms-modal-cta-tip', '项目库还是空的');
            const sub = el('div', 'ms-modal-cta-sub', '新建一个项目开始画；也可以把 .msp 存档或 PSD 拖进窗口导入');
            const btn = el('button', 'ms-modal-cta-btn');
            btn.type = 'button';
            btn.innerHTML = icon('plus') + '<span>新建项目</span>';
            btn.addEventListener('click', () => {
                closeProjectsModal();
                newProject();
            });
            cta.appendChild(iconBox);
            cta.appendChild(tip);
            cta.appendChild(sub);
            cta.appendChild(btn);
            // 列表区是 grid（auto-fill 卡片），CTA 在 grid 里跨满整行居中；
            // 没有列表容器时才退回面板顶部。
            const listHost = (typeof body.querySelector === 'function' && body.querySelector('.prj-list')) || null;
            if (listHost) listHost.appendChild(cta);
            else body.insertBefore(cta, body.firstChild || null);
        })
        .catch(() => {
            /* 读库失败时面板自己会给提示 */
        });
}

/**
 * 打开项目库浮层（顶栏「打开」与 Ctrl+O 都走这里）。
 * projects.mjs 本身就是普通编辑器（mount(host, ctx)），所以外壳只搭壳子、不复制列表逻辑。
 */
function openProjectsPanel() {
    if (typeof document === 'undefined' || !document.body) return false;
    if (projectsModal) {
        try {
            if (projectsModal.inst && typeof projectsModal.inst.refresh === 'function') projectsModal.inst.refresh();
        } catch (err) {
            /* 刷新失败不影响已经打开的浮层 */
        }
        syncProjectsCta(projectsModal);
        return true;
    }
    const host = shell.host || document.body;
    ensureModalCss();

    const root = el('div', 'ms-modal');
    root.style.position = 'fixed';
    root.style.inset = '0';
    root.style.zIndex = '60';
    root.style.display = 'flex';
    root.style.alignItems = 'center';
    root.style.justifyContent = 'center';
    root.style.background = 'rgba(8,9,11,.62)';

    const box = el('div', 'ms-modal-box');
    box.style.width = 'min(760px,82vw)';
    box.style.height = 'min(560px,76vh)';
    box.style.background = 'var(--panel)';
    box.style.border = '1px solid var(--line-2)';
    box.style.borderRadius = '8px';
    box.style.boxShadow = '0 24px 60px rgba(0,0,0,.5)';
    box.style.display = 'flex';
    box.style.flexDirection = 'column';
    box.style.overflow = 'hidden';

    const head = el('div', 'ms-modal-head');
    head.style.display = 'flex';
    head.style.alignItems = 'center';
    head.style.gap = '8px';
    head.style.padding = '10px 12px';
    head.style.borderBottom = '1px solid var(--line-2)';
    const title = el('strong', 'ms-modal-title', '项目库');
    title.style.flex = '1 1 auto';
    const closeBtn = el('button', 'ms-modal-close', '✕');
    closeBtn.type = 'button';
    closeBtn.title = '关闭（Esc）';
    closeBtn.style.cursor = 'pointer';
    head.appendChild(title);
    head.appendChild(closeBtn);

    const body = el('div', 'ms-modal-body');
    body.style.flex = '1 1 auto';
    body.style.minHeight = '0';
    body.style.overflow = 'auto';

    box.appendChild(head);
    box.appendChild(body);
    root.appendChild(box);
    host.appendChild(root);

    /** 点遮罩空白处关闭（点浮层内部不关）。 */
    const onMask = (ev) => {
        if (ev.target === root) closeProjectsModal();
    };
    /** Esc 关闭；正在重命名时把 Esc 让给面板（那是「取消重命名」）。 */
    const onKey = (ev) => {
        if (ev.key !== 'Escape') return;
        if (typeof root.querySelector === 'function' && root.querySelector('input.prj-rename')) return;
        ev.preventDefault();
        ev.stopPropagation();
        closeProjectsModal();
    };
    root.addEventListener('click', onMask);
    closeBtn.addEventListener('click', () => closeProjectsModal());
    window.addEventListener('keydown', onKey, true);

    // 浮层里载入 / 新建之后自动收起，省得用户再点一次关闭
    const base = CTX.project || {};
    const modalCtx = Object.create(CTX);
    modalCtx.project = Object.assign({}, base, {
        open: async (id) => {
            const out = await base.open(id);
            closeProjectsModal();
            return out;
        },
        create: async (opts) => {
            const out = await base.create(opts);
            closeProjectsModal();
            return out;
        },
    });

    const def = editorDef('projects');
    let inst = null;
    if (def && typeof def.mount === 'function') {
        try {
            inst = def.mount(body, modalCtx);
        } catch (err) {
            console.error('[shell] 项目库浮层挂载失败：', err);
        }
    }
    projectsModal = { root, box, body, inst, onMask, onKey };

    // 库为空时给一个显眼的新建入口
    syncProjectsCta(projectsModal);

    return true;
}

/* ─────────────────── 导入：PSD / PNG / JPEG / WebP → 当前文档 ─────────────────── */

/**
 * 把导入结果落到当前文档。
 * 为什么不复用 applyDoc：导入是「往现有项目里加对象」，不是「换一个项目」，
 * 不能重置 project.id / file，也不能清掉撤销栈。setDoc 才是既有的就地修改入口。
 */
function commitImportedDoc(next) {
    const fn = CTX && typeof CTX.setDoc === 'function' ? CTX.setDoc : setDoc;
    try {
        fn(next);
        if (CTX && typeof CTX.requestRender === 'function') CTX.requestRender();
        return true;
    } catch (err) {
        console.error('[shell] 导入落库失败：', err);
        return false;
    }
}

/** 导入成功后的一句话小结：把「尺寸不一致」这类常见坑直接说出来。 */
function importSummary(report) {
    const r = report || {};
    const doc = state.doc;
    let msg = '已导入 ' + (Number(r.imported) || 0) + ' 个对象';
    if (r.kind === 'psd') {
        if (r.psdWidth && doc && (doc.width !== r.psdWidth || doc.height !== r.psdHeight)) {
            msg += '（PSD ' + r.psdWidth + '×' + r.psdHeight + '，画布 ' + doc.width + '×' + doc.height + '）';
        }
        if (r.hidden) msg += ' · 跳过 ' + r.hidden + ' 个隐藏图层';
    }
    return msg;
}

/**
 * 导入 PSD / 位图到当前文档（顶栏「文件 → 导入」与项目库 API 共用）。
 * @param {'psd'|'image'} [scope] 收窄对话框类型；不给就是全支持
 * @returns {Promise<boolean>} 是否真的导入了对象
 */
async function importFileObjects(scope) {
    const exts = scope === 'psd' ? ['psd', 'psb'] : scope === 'image' ? ['png', 'jpg', 'jpeg', 'webp'] : null;
    let res;
    try {
        res = await pickAndImport({ doc: state.doc, exts });
    } catch (err) {
        console.error('[shell] 导入失败：', err);
        flash('导入失败：' + ((err && err.message) || err));
        return false;
    }
    if (!res || !res.ok) {
        // 用户点了取消不算错误，不打扰
        if (!(res && res.canceled)) flash((res && res.error) || '导入失败');
        return false;
    }
    if (!commitImportedDoc(res.doc)) {
        flash('导入失败：当前文档不可用');
        return false;
    }
    // 选中新导入的最上层对象：用户立刻能拖动、看属性、按 Ctrl+Z 撤回
    if (res.activeId && CTX && typeof CTX.setActiveLayer === 'function') CTX.setActiveLayer(res.activeId);
    flash(importSummary(res.report));
    markDirty();
    updateChrome();
    return true;
}

/**
 * 拖放导入：把拖进窗口的文件直接落到当前文档，不弹对话框。
 * files 是 [{ name, data }]，data 为 ArrayBuffer / Uint8Array（由外壳的 drop 监听读出来）。
 * 多个文件按拖入顺序依次叠加；全部失败时只 flash 第一条错误。
 * @returns {Promise<boolean>} 是否真的导入了对象
 */
async function importDropped(files) {
    const list = Array.isArray(files) ? files.filter((f) => f && f.data) : [];
    if (!list.length) {
        flash('拖进来的文件读不出来');
        return false;
    }
    if (!state.doc) {
        flash('导入失败：当前文档不可用');
        return false;
    }
    let next = state.doc;
    let imported = 0;
    let lastId = null;
    const errors = [];
    let lastReport = null;
    for (const item of list) {
        let res;
        try {
            res = await importBuffer({ name: item.name, data: item.data }, { doc: next });
        } catch (err) {
            errors.push((err && err.message) || String(err));
            continue;
        }
        if (!res || !res.ok) {
            errors.push((res && res.error) || '导入失败');
            continue;
        }
        next = res.doc;
        imported += Number(res.report && res.report.imported) || 0;
        lastReport = res.report;
        if (res.activeId) lastId = res.activeId;
    }
    if (!imported) {
        flash(errors[0] || '导入失败');
        return false;
    }
    if (!commitImportedDoc(next)) {
        flash('导入失败：当前文档不可用');
        return false;
    }
    if (lastId && CTX && typeof CTX.setActiveLayer === 'function') CTX.setActiveLayer(lastId);
    flash(list.length > 1
        ? '拖入 ' + list.length + ' 个文件 · 共 ' + imported + ' 个对象'
        : importSummary(lastReport));
    markDirty();
    updateChrome();
    return true;
}

/** 顶栏「文件」按钮分发。 */
function onFileAct(act) {
    if (act === 'new') {
        newProject();
        return;
    }
    if (act === 'save') {
        saveProject();
        return;
    }
    if (act === 'open') {
        openProjectsPanel();
        return;
    }
    // 导入 PSD / 图片：异步落地到当前文档，失败只 flash，不抛给顶栏
    if (act === 'import') {
        importFileObjects();
        return;
    }
    if (act === 'export') {
        exportFrames(projectLabel());
        return;
    }
    if (act === 'undo') {
        engine.undo();
        return;
    }
    if (act === 'redo') {
        engine.redo();
        return;
    }
}

/* ───────────────────────── WebM 视频导出 ───────────────────────── */

/**
 * 把当前文档录成 WebM（不弹对话框、不写盘，纯内存）。导出与自检都用它。
 *
 * 做法：把 composeFrame 画到一张离屏 canvas 上，用 captureStream(0) 手动推帧，
 * 每帧之间按真实时间等待 —— MediaRecorder 的时间轴是墙上时钟，不等就会糊成一瞬。
 *
 * @param {object} [opts] { fps, seconds, onProgress(done,total) }
 * @returns {Promise<{ok:boolean, bytes?:ArrayBuffer, size?:number, mime?:string, frames?:number, fps?:number, seconds?:number, error?:string}>}
 */
export async function recordVideo(opts) {
    const o = opts || {};
    // project-io 不直接持有 ctx：它由 app.mjs 在 boot 时 setCtx 注入（见文件头 CTX）
    const doc = CTX && typeof CTX.doc === 'function' ? CTX.doc() : null;
    if (!doc) return { ok: false, error: '没有文档' };
    if (typeof MediaRecorder !== 'function') return { ok: false, error: '当前环境不支持录制（没有 MediaRecorder）' };
    if (typeof document === 'undefined' || !document.createElement) return { ok: false, error: '当前环境不支持录制（没有 DOM）' };
    const mime = pickVideoMime((m) => typeof MediaRecorder === 'function' && MediaRecorder.isTypeSupported(m));
    if (!mime) return { ok: false, error: '当前环境不支持 WebM 录制' };

    const fps = videoFps(o.fps, doc.fps);
    const total = videoSeconds(o.seconds, totalSeconds(doc));
    const frames = videoFrameCount(total, fps);
    const size = videoCanvasSize(doc.width, doc.height);
    const w = size.width;
    const h = size.height;

    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d');
    if (!g) return { ok: false, error: '拿不到 2d 上下文' };

    let stream;
    let rec;
    try {
        stream = cv.captureStream(0);
        rec = new MediaRecorder(stream, {
            mimeType: mime,
            videoBitsPerSecond: videoBitrate(w, h, fps),
        });
    } catch (err) {
        return { ok: false, error: '无法开始录制：' + ((err && err.message) || err) };
    }
    const track = stream.getVideoTracks()[0] || null;
    const chunks = [];
    rec.ondataavailable = (e) => {
        if (e && e.data && e.data.size) chunks.push(e.data);
    };
    const stopped = new Promise((resolve) => {
        rec.onstop = () => resolve();
    });
    const stepMs = Math.max(4, Math.round(1000 / fps));
    try {
        rec.start();
        for (let i = 0; i < frames; i += 1) {
            const t = i / fps;
            compositeFrame(cv, doc, t, { clear: true, time: t });
            if (track && typeof track.requestFrame === 'function') track.requestFrame();
            if (typeof o.onProgress === 'function') o.onProgress(i + 1, frames);
            // eslint-disable-next-line no-await-in-loop
            await new Promise((r) => setTimeout(r, stepMs));
        }
        // 末帧再停一拍，否则最后一帧常常没进封装
        await new Promise((r) => setTimeout(r, Math.max(120, stepMs * 2)));
    } finally {
        try {
            rec.stop();
        } catch (err) {
            /* 已经停了就算了 */
        }
        const live = stream.getTracks();
        for (const tk of live) {
            try {
                tk.stop();
            } catch (err) {
                /* 忽略 */
            }
        }
    }
    await stopped;
    const blob = new Blob(chunks, { type: mime });
    const bytes = await blob.arrayBuffer();
    if (!bytes.byteLength) return { ok: false, error: '录制结果为空（可能是窗口不可见时 Chromium 停掉了合成）' };
    return { ok: true, bytes, size: bytes.byteLength, mime, frames, fps, seconds: total };
}

/**
 * 导出 WebM：录完弹保存对话框。用户取消时不提示错误。
 * @param {object} [opts] 同 recordVideo
 */
export async function exportVideo(opts) {
    // 录制依赖墙上时钟：窗口切到后台时 Chromium 会节流计时器，录出来会变慢甚至掉帧
    flash('开始录制 WebM，请保持窗口在前台…');
    const r = await recordVideo(opts);
    if (!r.ok) {
        flash(r.error || '导出视频失败');
        return r;
    }
    const saved = await ipc.saveBinary(projectLabel(), r.bytes, 'webm', 'WebM 视频');
    if (saved && saved.ok) {
        flash('已导出 WebM（' + r.frames + ' 帧 · ' + Math.round(r.size / 1024) + ' KB）');
    } else if (saved && saved.canceled) {
        flash('已取消导出视频');
    } else {
        flash('视频已录制（' + Math.round(r.size / 1024) + ' KB），但没找到保存通道');
    }
    return Object.assign({ saved: !!(saved && saved.ok) }, r);
}

/** 注入给 projects.mjs 的接口（面板不认识存储细节）。 */
const projectApi = {
    list: () => store.listProjects(),
    current: currentProject,
    open: (id) => loadProject(id),
    create: (opts) => Promise.resolve(newProject(opts)),
    save: (name) => saveProject(name),
    async rename(id, name) {
        const rec = await store.renameProject(id, name);
        if (!rec) return false;
        if (project.id === id) {
            project.name = rec.name;
            project.dirty = true;
            updateChrome();
        }
        return true;
    },
    async remove(id) {
        const ok = await store.deleteProject(id);
        if (ok && project.id === id) {
            project.id = '';
            project.file = '';
            project.dirty = true;
            store.setCurrentProjectId('');
            updateChrome();
        }
        return ok;
    },
    // 项目文件（.msp/.json）→ 项目库。projectApi.importFile 保持这个语义：
    // projects.mjs 的「导入文件」按钮按项目导入写的提示文案（第 118/385 行）。
    importFile: () => importProjectFile(),
    // 位图 / PSD → 当前文档的新对象
    importPsd: () => importFileObjects('psd'),
    importImage: () => importFileObjects('image'),
    importObjects: () => importFileObjects(),
    importDropped,
    exportFile: (id) => writeProjectFile(id, {}),
    exportSpritesheet: (opts) => exportSpritesheet(opts),
    recordVideo: (opts) => recordVideo(opts),
    exportVideo: (opts) => exportVideo(opts),
    subscribe: subscribeProjects,
    storage: () => store.storageKind(),
};

/** 启动时恢复上次打开的项目（没有就保持默认空白文档）。 */
async function restoreLastProject() {
    try {
        const id = store.currentProjectId();
        if (!id) return false;
        const rec = await store.getProject(id);
        if (!rec || !rec.project) return false;
        const doc = await store.jsonToDoc(rec.project.doc);
        if (!doc) return false;
        const ok = applyDoc(doc, { id: rec.id, name: rec.name, file: rec.file });
        if (ok) flash('已恢复项目 ' + (rec.name || ''));
        return ok;
    } catch (err) {
        console.error('[shell] 恢复项目失败：', err);
        return false;
    }
}


export {
    exportFrames,
    exportSpritesheet,
    project,
    projectLabel,
    markDirty,
    notifyProjects,
    currentProject,
    saveProject,
    importProjectFile,
    loadProject,
    newProject,
    projectsModal,
    openProjectsPanel,
    onFileAct,
    importFileObjects,
    projectApi,
    restoreLastProject,
};

/**
 * 静默自动保存：只写项目库（IndexedDB），永不碰 .json 的保存对话框。
 * 为什么不直接复用 saveProject()：它在 project.file 为空时会走 writeProjectFile，
 * 那一步会弹系统保存对话框 —— 自动保存打断用户是不可接受的。
 * 返回 true 表示真的写了一次；未命名 / 正忙 / 无文档一律返回 false。
 */
export async function autoSaveProject() {
    const doc = state.doc;
    if (!doc || saveBusy) return false;
    const name = String(project.name || '').trim();
    if (!name) return false; // 未命名项目跳过：命名要用户在行内输入框里决定
    saveBusy = true;
    try {
        const rec = store.makeRecord({
            id: project.id || '',
            name,
            doc,
            thumb: frameThumb(doc),
            file: project.file || '',
        });
        const saved = await store.putProject(rec);
        project.id = (saved && saved.id) || rec.id;
        project.dirty = false;
        store.setCurrentProjectId(project.id);
        flash('已自动保存 ' + name);
        updateChrome();
        notifyProjects();
        return true;
    } catch (err) {
        console.error('[shell] 自动保存失败：', err);
        return false;
    } finally {
        saveBusy = false;
    }
}
