/**
 * 失败路径测试（tests/ipc-failure.test.mjs）
 *
 * 背景：这一批修的是「没做却说成功」的六处。它们的共性不是少一个 try/catch，
 * 而是**返回值里没有「没做成」这个状态**：桥不在返回 null、主进程答 ok:false、
 * 或者回了 ok:true 却没给路径 —— 界面一律弹「已导出 / 已存为文件」。
 *
 * 锁四件事：
 *   ① `ipc.saveBinaryChecked()` 把「无桥 / 空内容 / 没响应 / 抛错 / 被拒 / 用户取消」
 *      拆成可分辨的结果（真断言：注入假桥，不需要 DOM）；
 *   ② `projects.mjs` 的 `actVerdict()` 不再把 null 当成功（真断言）；
 *   ③ `project-io.mjs` 的 WebM 分支必须真的落盘，导出失败必须带补救文案（源码守卫）；
 *   ④ 未命名草稿不挂在默认关掉的 `prefs.autoSave` 后面（源码守卫）。
 *
 * 为什么一半是源码守卫：project-io.mjs / doc-state.mjs 在 import 期就碰 document，
 * Node 里根本 import 不起来。假装能跑只会写出「用 stub 骗自己」的测试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as ipc from '../app/shell/ipc.mjs';
import { actVerdict } from '../app/editors/projects.mjs';
import { setLocale, t } from '../app/i18n/index.mjs';

// 这些文案已经迁进词条表（`shell.ipc.save.*` / `projects.*`），进程默认语言是 en。
// 断言钉的是中文译文，所以先钉住语言；两表镜面与英文侧由分片测试兜。
setLocale('zh-Hans');

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/**
 * 装一架假桥跑一段：`bridge()` 每次调用都现读 `globalThis.window.motionAPI`，
 * 所以这里同步挂上、跑完拆掉，不会把状态漏给别的测试。
 */
async function withBridge(api, fn) {
    const had = Object.prototype.hasOwnProperty.call(globalThis, 'window');
    const prev = globalThis.window;
    if (api) globalThis.window = { motionAPI: api };
    else delete globalThis.window;
    try {
        return await fn();
    } finally {
        if (had) globalThis.window = prev;
        else delete globalThis.window;
    }
}

const bytes = (n = 4) => new Uint8Array(n);

/* ───────────────────── ① saveBinaryChecked：六种结局各自可分 ───────────────────── */

test('saveBinaryChecked：没有桥 → 明确说没保存通道，不说「已取消」', async () => {
    const out = await withBridge(null, () => ipc.saveBinaryChecked('a', bytes(), 'webm', 'WebM 视频'));
    assert.equal(out.ok, false);
    assert.equal(out.canceled, undefined, '桥不在不是取消');
    assert.match(out.error, /没存下来|保存通道/);
    assert.equal(ipc.available(), false);
});

test('saveBinaryChecked：空字节 → 报「没有内容可存」，不弹保存对话框', async () => {
    let called = 0;
    const out = await withBridge({ saveBinary: () => { called++; return { ok: true, file: 'x' }; } }, () =>
        ipc.saveBinaryChecked('a', bytes(0), 'webm', 'WebM 视频'));
    assert.equal(out.ok, false);
    assert.match(out.error, /没有内容/);
    assert.equal(called, 0, '空内容连主进程都不该问');
});

test('saveBinaryChecked：桥在但 preload 没挂这一路（返回 null）→ 失败，不是取消', async () => {
    const out = await withBridge({}, () => ipc.saveBinaryChecked('a', bytes(), 'webm', 'WebM 视频'));
    assert.equal(out.ok, false);
    assert.equal(out.canceled, undefined);
    assert.match(out.error, /没有响应/);
});

test('saveBinaryChecked：主进程抛错 → 带出原始消息，不吞异常', () => {
    return withBridge({ saveBinary: () => { throw new Error('EACCES: permission denied'); } }, async () => {
        const out = await ipc.saveBinaryChecked('a', bytes(), 'webm', 'WebM 视频');
        assert.equal(out.ok, false);
        assert.match(out.error, /抛错/);
        assert.match(out.error, /EACCES/);
        assert.equal(ipc.lastFailure(), 'EACCES: permission denied');
    });
});

test('saveBinaryChecked：invoke 被拒（异步抛错）也要带出原因', async () => {
    const out = await withBridge({ saveBinary: () => Promise.reject(new Error('handler 崩了')) }, () =>
        ipc.saveBinaryChecked('a', bytes(), 'webm', 'WebM 视频'));
    assert.equal(out.ok, false);
    assert.match(out.error, /抛错/);
    assert.match(out.error, /handler 崩了/);
});

test('saveBinaryChecked：用户取消 → canceled:true（唯一允许「什么都不做」的结局）', async () => {
    const out = await withBridge({ saveBinary: () => Promise.resolve({ ok: false, canceled: true }) }, () =>
        ipc.saveBinaryChecked('a', bytes(), 'webm', 'WebM 视频'));
    assert.equal(out.ok, false);
    assert.equal(out.canceled, true);
});

test('saveBinaryChecked：主进程答 ok:false → 原样带出错误文本', async () => {
    const out = await withBridge({ saveBinary: () => Promise.resolve({ ok: false, error: '磁盘只读' }) }, () =>
        ipc.saveBinaryChecked('a', bytes(), 'webm', 'WebM 视频'));
    assert.equal(out.ok, false);
    assert.equal(out.canceled, undefined);
    assert.equal(out.error, '磁盘只读');
});

test('saveBinaryChecked：回了 ok:true 却没给路径 → 报没落地，不替主进程签收', async () => {
    const out = await withBridge({ saveBinary: () => Promise.resolve({ ok: true }) }, () =>
        ipc.saveBinaryChecked('a', bytes(), 'webm', 'WebM 视频'));
    assert.equal(out.ok, false);
    assert.match(out.error, /没给路径/);
});

test('saveBinaryChecked：只有拿到 file 才算存下来了', async () => {
    const out = await withBridge({ saveBinary: () => Promise.resolve({ ok: true, file: 'C:/out/a.webm', size: 2048 }) }, () =>
        ipc.saveBinaryChecked('a', bytes(), 'webm', 'WebM 视频'));
    assert.deepEqual(out, { ok: true, file: 'C:/out/a.webm', size: 2048 });
});

test('顺手守住旧接口：saveBinary 仍然原样返回主进程结果（契约没被改）', async () => {
    const raw = { ok: false, canceled: true };
    const out = await withBridge({ saveBinary: () => Promise.resolve(raw) }, () => ipc.saveBinary('a', bytes(), 'webm', ''));
    assert.equal(out, raw, 'saveBinary 不加工结果，加工在 saveBinaryChecked 里');
});

/* ───────────────────── ② actVerdict：null 不算成功 ───────────────────── */

test('actVerdict：null / undefined 是「接口没跑起来」，不是成功', () => {
    for (const v of [null, undefined]) {
        const out = actVerdict(v);
        assert.equal(out.ok, false, String(v) + ' 不能算成功');
        assert.equal(out.canceled, false);
        // 文案由 `projects.verdict.noAnswer` 决定，英文/中文都可能；这里只钉「说得出话」
        // （键没进词典时 t() 会原样返回键名，那也是非空串 —— 缺口归 i18n 分片测试管）
        assert.equal(typeof out.error, 'string');
        assert.ok(out.error.length > 0, '失败必须带一句能读的原因');
    }
});

test('actVerdict：布尔接口照旧（true 成 / false 不成）', () => {
    assert.equal(actVerdict(true).ok, true);
    const out = actVerdict(false);
    assert.equal(out.ok, false);
    assert.equal(out.canceled, false);
});

test('actVerdict：结构化结果区分「取消」与「失败」，并保留原因', () => {
    const canceled = actVerdict({ ok: false, canceled: true });
    assert.equal(canceled.ok, false);
    assert.equal(canceled.canceled, true);

    const failed = actVerdict({ ok: false, error: 'EACCES' });
    assert.equal(failed.canceled, false);
    assert.equal(failed.error, 'EACCES');
});

test('actVerdict：ok:true 才算成，且把原始返回值带出去（好让调用方查 file/count）', () => {
    const out = actVerdict({ ok: true, file: 'C:/out/a.msp' });
    assert.equal(out.ok, true);
    assert.equal(out.out.file, 'C:/out/a.msp');
});

/* ───────────────────── ③ WebM 分支必须落盘（源码守卫） ───────────────────── */

test('导出对话框的 WebM 分支不再把「字节在内存里」当成功', () => {
    const io = read('../app/shell/project-io.mjs');
    // 只查代码形态：注释里会引用旧文案说明为什么淘汰，那不算违规
    assert.doesNotMatch(io, /message: '已录制/, '旧写法：录完就回一句成功，字节随函数返回丢掉');
    assert.match(io, /const r = await exportVideo\(\{/, '对话框的 video 分支必须走 exportVideo');
    assert.match(io, /if \(!r\.file\) \{/, 'ok:true 但没路径时不能当成功');
});

test('exportVideo 录完必须落盘，失败与取消分开报', () => {
    const io = read('../app/shell/project-io.mjs');
    const body = io.slice(io.indexOf('export async function exportVideo'));
    assert.match(body, /ipc\.saveBinaryChecked\(projectLabel\(\), r\.bytes, 'webm'/, '录完的字节必须交给保存通道');
    assert.match(body, /if \(saved\.canceled\) \{/, '取消是取消');
    // 文案已迁进词条表：守卫盯「用了哪条键」，意思由译文断言兜
    assert.match(body, /return fail\(t\('shell\.video\.saveFailed'/, '失败要说没存下来');
    assert.ok(t('shell.video.saveFailed', { msg: 'X' }).includes('没存下来'), '译文要点明「录好了但没存下来」');
    assert.doesNotMatch(body, /saved && saved\.ok/, '旧写法：saved 为空时静默当失败已经不够，要显式判 ok');
});

test('导出当前帧不再用恒为假的 typeof 判据，也不把「桥不在」当取消', () => {
    const io = read('../app/shell/project-io.mjs');
    assert.doesNotMatch(io, /if \(!ipc \|\| typeof ipc\.saveBinary !== 'function'\)/, 'ipc 是命名空间，这个判断恒为假');
    assert.doesNotMatch(io, /flash\('已取消'\)/, '旧写法：桥不在时说「已取消」，用户以为是自己点的');
    const body = io.slice(io.indexOf('async function exportCurrentFrame'));
    assert.match(body, /if \(!ipc\.available\(\)\)/, '先问有没有桥');
    assert.match(body, /ipc\.saveBinaryChecked\(/, '保存走可分辨的通道');
    assert.match(body, /if \(saved\.canceled\)/, '取消单独分支');
});

test('写项目文件：ok:true 但没给路径时必须报错，不能静默', () => {
    const io = read('../app/shell/project-io.mjs');
    const body = io.slice(io.indexOf('async function writeProjectFile'));
    assert.match(body, /if \(!out\.file\) \{/);
    assert.match(body, /t\('shell\.saveFile\.noPath'\)/, '「回了成功但没给路径」必须有自己的词条');
    assert.ok(t('shell.saveFile.noPath').includes('没落地'), '译文要说清文件没落地');
    assert.match(body, /if \(!ipc\.available\(\)\)/, '无桥要明说，不要等主进程回 null');
});

/* ───────────────────── ④ 未命名草稿不跟 autoSave 偏好（源码守卫） ───────────────────── */

test('未命名文档的草稿节奏独立于 prefs.autoSave（默认 0 = 关）', () => {
    const io = read('../app/shell/project-io.mjs');
    assert.match(io, /const DRAFT_SEC = \d+;/);
    assert.match(io, /const sec = project\.name \? \(Number\(prefSnapshot\(\)\.autoSave\) \|\| 0\) : DRAFT_SEC;/);
    const tick = io.slice(io.indexOf('function autoSaveTick'), io.indexOf('function onBeforeUnload'));
    assert.doesNotMatch(tick, /if \(!sec \|\| !dirty \|\| !autoDirtyAt\) return;/, '旧写法：autoSave=0 时草稿路径永远跑不到');
});

test('草稿内容没变就不重写（否则闲置时每 3 秒重写整份文档 + 缩略图）', () => {
    const io = read('../app/shell/project-io.mjs');
    const sig = io.slice(io.indexOf('function draftSignature'), io.indexOf('async function saveDraft'));
    assert.match(sig, /store\.docToFile\(doc, \{ savedAt: 0 \}\)/, '签名不能带 savedAt，否则每次都不同');
    const body = io.slice(io.indexOf('export async function autoSaveProject'));
    assert.match(body, /const sig = draftSignature\(doc\);/);
    assert.match(body, /if \(sig === draftSig\) return true;/);
    assert.match(body, /draftSig = sig;/);
});

test('自动保存失败必须说出来（以前只 console.error）', () => {
    const io = read('../app/shell/project-io.mjs');
    const body = io.slice(io.indexOf('export async function autoSaveProject'));
    assert.match(body, /catch \(err\) \{[\s\S]*t\('shell\.autosave\.failed'/, '自动保存失败必须 flash 出来');
    assert.ok(t('shell.autosave.failed', { msg: 'X' }).includes('Ctrl+S'), '补救动作（Ctrl+S）要写在译文里');
});

/* ───────────────────── ⑤ 面板判据 + 顶栏提示（源码守卫） ───────────────────── */

test('项目库面板不再用 ok !== false 判成功', () => {
    const projs = read('../app/editors/projects.mjs');
    // 只查代码形态：actVerdict 的注释里会引用这条旧判据说明为什么淘汰，那不算违规
    assert.doesNotMatch(projs, /if \(ok !== false && okText\)/);
    assert.doesNotMatch(projs, /if \(ok === false\) say\('操作未完成'\)/);
    assert.match(projs, /verdict = actVerdict\(await fn\(\)\)/);
    assert.match(projs, /v\.ok && v\.out && v\.out\.file/, '「存为文件」要拿到路径才算成');
    assert.match(projs, /Number\(v\.out && v\.out\.count\)/, '帧数从返回值里取，不是凭「没报错」猜');
    assert.match(projs, /if \(n > 0\)/, '0 帧也算失败，不能说「已导出精灵图」');
    assert.doesNotMatch(projs, /await run\(\(\) => fn\(\{\}\), t\('projects\.sheet\.done/, '成功文案不能先于帧数检查说出');
});

test('错误提示停留更久且不被下一条普通提示顶掉', () => {
    const ds = read('../app/shell/doc-state.mjs');
    assert.match(ds, /const NOTE_ERROR_MS = \d+;/);
    assert.match(ds, /notice\.kind === 'error' && noteAlive\(\)/, '错误提示不能被普通提示覆盖');
    assert.match(ds, /opts === 'error'/, "flash(msg, 'error') 要能识别");

    const chrome = read('../app/shell/chrome.mjs');
    assert.match(chrome, /hint\.title = text/, '顶栏被省略号截断时，悬停要能读到全句');
});

/* ─────── ⑥ Ctrl+S 的「两者并存」：写库 + 回写已绑定文件（真行为 + 源码守卫） ─────── */

/**
 * `project-io.mjs` / `doc-state.mjs` 在 import 期就碰 document，所以装一套最小 DOM 桩
 * 再动态 import。这套桩只够模块求值 + 一次保存（画布拿不到 2D 上下文，缩略图会退回空串）。
 */
function stubDom() {
    const fakeNode = () => ({
        width: 0,
        height: 0,
        style: {},
        getContext: () => null,
        toDataURL: () => '',
        appendChild() {},
        addEventListener() {},
        removeAttribute() {},
        setAttribute() {},
        classList: { add() {}, remove() {}, toggle() {} },
    });
    globalThis.document = {
        documentElement: { lang: '' },
        body: { appendChild() {}, removeChild() {} },
        addEventListener() {},
        removeEventListener() {},
        createElement: fakeNode,
        querySelector: () => null,
    };
}

async function loadProjectIo() {
    stubDom();
    const [io, ds, cel, store] = await Promise.all([
        import('../app/shell/project-io.mjs'),
        import('../app/shell/doc-state.mjs'),
        import('../app/core/cel.mjs'),
        import('../app/shell/project-store.mjs'),
    ]);
    return { io, ds, cel, store };
}

/** 每个用例从一个干净的文档 + 未绑定文件的状态开始。 */
function freshDoc(cel, ds) {
    ds.state.doc = cel.createDocument({ width: 20, height: 10, fps: 10, layerName: 'L' });
    ds.project.id = '';
    ds.project.name = '';
    ds.project.file = '';
    ds.project.dirty = true;
}

test('saveProject：绑定了文件就回写该文件，没绑定就只入库（真行为断言）', async () => {
    const { io, ds, cel } = await loadProjectIo();
    freshDoc(cel, ds);
    const writes = [];
    const api = {
        // 「另存为」对话框这一路不该被 Ctrl+S 碰到
        saveProject: () => {
            throw new Error('Ctrl+S 不应该弹保存对话框');
        },
        saveProjectTo: (file, json) => {
            writes.push({ file, json });
            return { ok: true, file };
        },
    };
    await withBridge(api, async () => {
        assert.equal(await io.saveProject('ProjA'), true);
        assert.equal(writes.length, 0, '没绑定文件时不该回写：Ctrl+S 此时只入库');
        assert.equal(ds.project.file, '', '没有文件时不该凭空造出一个绑定');

        ds.project.file = 'C:/work/a.msp';
        assert.equal(await io.saveProject('ProjA'), true);
        assert.equal(writes.length, 1, '绑定文件后 Ctrl+S 必须回写，否则磁盘上还是旧内容');
        assert.equal(writes[0].file, 'C:/work/a.msp');
        const payload = JSON.parse(writes[0].json);
        assert.equal(payload.format, 'motionstudio-project', '回写的必须是完整项目文件，不是裸 doc');
        assert.equal(payload.name, 'ProjA');
        assert.ok(Array.isArray(payload.elements), '扁平文件顶层要有 elements');
        assert.equal(payload.version, 4);
    });
});

test('saveProject：回写失败必须说「库已保存、文件未更新」，不许静默', async () => {
    const { io, ds, cel } = await loadProjectIo();
    freshDoc(cel, ds);
    ds.project.file = 'C:/work/b.msp';
    const api = {
        saveProjectTo: () => ({ ok: false, error: 'EACCES: permission denied' }),
    };
    await withBridge(api, async () => {
        // 库确实写成功了：返回值仍是 true（内容有底，切项目/关窗口不会丢）
        assert.equal(await io.saveProject('ProjB'), true);
        const msg = ds.hintText();
        assert.match(msg, /项目库/, '必须说明内容已进库');
        assert.match(msg, /未更新/, '必须说明文件没更新');
        assert.match(msg, /EACCES/, '必须带出原因，不能只说「失败」');
    });
});

test('saveFlash：三种结局的文案与档位必须可分辨（纯函数）', async () => {
    const { io } = await loadProjectIo();
    const libraryOnly = io.saveFlash({ label: '甲', file: '' });
    assert.equal(libraryOnly.level, 'info');
    assert.match(libraryOnly.text, /项目库/);
    assert.match(libraryOnly.text, /另存为/, '只入库时要指出「另存为」这条出路');

    const both = io.saveFlash({ label: '甲', file: 'C:/work/a.msp', back: { ok: true } });
    assert.equal(both.level, 'info');
    assert.match(both.text, /回写/);
    assert.match(both.text, /a\.msp/);

    const failed = io.saveFlash({ label: '甲', file: 'C:/work/a.msp', back: { ok: false, error: 'EACCES' } });
    assert.equal(failed.level, 'error', '回写失败走错误档（停留更久、不被普通提示顶掉）');
    assert.match(failed.text, /项目库/);
    assert.match(failed.text, /未更新/);
    assert.match(failed.text, /EACCES/);

    const unsupported = io.saveFlash({ label: '甲', file: 'C:/work/a.msp', back: { ok: false, unsupported: true } });
    assert.equal(unsupported.level, 'error');
    assert.match(unsupported.text, /另存为/, '没有回写能力时要给出补救动作');

    // 三种结局两两不同：用户必须能区分「都更新了 / 只进了库 / 文件还是旧的」
    assert.equal(new Set([libraryOnly.text, both.text, failed.text, unsupported.text]).size, 4);
});

test('另存为给别的项目写文件时，不把当前项目绑到那个文件上（防 Ctrl+S 覆盖错文件）', async () => {
    const { io, ds, cel, store } = await loadProjectIo();
    freshDoc(cel, ds);
    ds.project.name = '当前项目';
    ds.project.file = 'C:/work/current.msp';
    const recB = store.makeRecord({ id: 'proj-b', name: 'B', doc: ds.state.doc, file: '' });
    await store.putProject(recB);

    const api = { saveProject: () => ({ ok: true, file: 'C:/work/b.msp' }) };
    await withBridge(api, async () => {
        const out = await io.projectApi.exportFile('proj-b');
        assert.equal(out.ok, true);
        assert.equal(ds.project.file, 'C:/work/current.msp', '别的卡片另存为不能改当前项目的绑定');
        const back = await store.getProject('proj-b');
        assert.equal(back.file, 'C:/work/b.msp', '被另存为的那条记录要记住新路径');

        // 当前文档自己另存为：绑定要跟着换到新路径（否则顶栏与下一次 Ctrl+S 指着旧文件）
        const api2 = { saveProject: () => ({ ok: true, file: 'C:/work/new.msp' }) };
        await withBridge(api2, async () => {
            const out2 = await io.projectApi.exportFile();
            assert.equal(out2.ok, true);
            assert.equal(ds.project.file, 'C:/work/new.msp', '当前文档另存为后绑定要更新');
        });
    });
});

test('源码守卫：saveProject 的回写分支与自动保存的回写路都在', () => {
    const io = read('../app/shell/project-io.mjs');
    const body = io.slice(io.indexOf('async function saveProject('), io.indexOf('async function writeProjectFile'));
    assert.match(body, /const file = String\(project\.file \|\| ''\);/, '回写目标必须取 project.file');
    assert.match(body, /if \(file\) return|const back = file \? await writeBackProjectFile/, '只有绑定了文件才回写');
    assert.match(body, /writeBackProjectFile\(label, file\)/, '回写走无对话框通道');
    assert.match(body, /saveFlash\(\{ label: label, file: file, back: back \}\)/, '三种结局的提示统一由 saveFlash 决定');
    assert.match(body, /flash\(out\.text, out\.level\)/, '提示要带档位（error 会长留）');
    // 回写用的必须是和「另存为」同一份序列化
    const wb = io.slice(io.indexOf('async function writeBackProjectFile'), io.indexOf('async function saveProject('));
    assert.match(wb, /JSON\.stringify\(await projectFilePayload\(label\)\)/, '回写必须复用 projectFilePayload');
    assert.match(wb, /ipc\.saveProjectTo\(file, json\)/, '回写走 ms:save-project-to 通道，不重弹对话框');
    assert.match(wb, /if \(!out\.file\)/, '回了成功却没给路径时不能签收');
    const auto = io.slice(io.indexOf('export async function autoSaveProject'));
    assert.match(auto, /writeBackProjectFile\(name, file\)/, '自动保存也要回写绑定文件（否则库有底、文件还是旧的）');
    assert.match(auto, /if \(file && !back\.ok\) flash\(saveFlash\(/, '自动保存回写失败必须用错误档说出来');
});

test('源码守卫：预加载与主进程都接上了无对话框的回写通道', () => {
    const ipcSrc = read('../app/shell/ipc.mjs');
    assert.match(ipcSrc, /call\('saveProjectTo', \[target, payload\]\)/, 'ipc 包装没接通道');
    assert.match(ipcSrc, /八个通道/, '通道数注释要与实际一致');
    const preload = read('../preload.js');
    assert.match(preload, /saveProjectTo: \(file, json\) => ipcRenderer\.invoke\('ms:save-project-to'/, 'preload 没暴露 saveProjectTo');
    const main = read('../main.js');
    assert.match(main, /ipcMain\.handle\('ms:save-project-to'/, 'main 没注册通道');
    assert.match(main, /path\.isAbsolute\(file\)/, '主进程要拒绝相对路径（写到哪里不可预期）');
    assert.match(main, /fs\.writeFileSync\(file, json, 'utf8'\)/, '主进程要真的写盘');
});
