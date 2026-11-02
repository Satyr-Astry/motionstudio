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
    // 这条用例断言的是「无冲突时的正常路径」：前面用例往内存库里写过带 file 的记录，
    // 不清干净会撞上 alpha.46 的「同文件绑定冲突」分支（那属于下面 ⑧ 组用例）。
    store.__resetMemory();
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

/* ─────── ⑦ P1 项目库动作：复制 / 解除绑定 / 整库备份与恢复 ─────── */

test('exportLibrary：整库打成一个备份包，走 saveBinaryChecked 落盘（真行为）', async () => {
    const { io, cel, store } = await loadProjectIo();
    store.__resetMemory();
    const doc = cel.createDocument({ width: 20, height: 10, fps: 10, layerName: 'L' });
    await store.putProject(store.makeRecord({ name: '甲', doc, file: '' }));
    await store.putProject(store.makeRecord({ name: '乙', doc, file: 'C:/work/yi.msp' }));

    const calls = [];
    const api = {
        saveBinary: (name, bytes, ext, label) => {
            calls.push({ name, bytes, ext, label });
            return Promise.resolve({ ok: true, file: 'C:/backup/library.json', size: bytes.byteLength });
        },
    };
    const out = await withBridge(api, () => io.projectApi.exportLibrary());
    assert.equal(out.ok, true);
    assert.equal(out.count, 2, '返回值要带导出条数，面板不用自己去数');
    assert.equal(out.file, 'C:/backup/library.json');

    assert.equal(calls.length, 1, '整库只该弹一次保存对话框');
    assert.equal(calls[0].name, 'motionstudio-library', '备份包用自己的一组文件名/扩展名');
    assert.equal(calls[0].ext, 'json');
    assert.ok(String(calls[0].label).length > 0, '保存对话框的类型名要有');

    const bundle = JSON.parse(new TextDecoder().decode(calls[0].bytes));
    assert.equal(bundle.format, 'motionstudio-library');
    assert.equal(bundle.version, 1);
    assert.equal(bundle.app, 'motionstudio');
    assert.equal(bundle.projects.length, 2);
    assert.equal(bundle.projects[0].format, 'motionstudio-project', 'projects 里是完整项目节点，不是轻量记录');
    assert.ok(bundle.projects[0].doc && Array.isArray(bundle.projects[0].doc.elements));
    assert.equal(bundle.projects[0].name, '甲');
    // 导出是只读动作：库里的记录一条不少、一个字段没改
    assert.equal((await store.listProjects()).length, 2);
    assert.equal((await store.getProject((await store.listProjects())[0].id)).name.length > 0, true);
});

test('exportLibrary：空库 / 取消 / 桥失败三种结局可分辨（真行为）', async () => {
    const { io, cel, store } = await loadProjectIo();
    store.__resetMemory();
    let called = 0;
    const api = { saveBinary: () => { called += 1; return Promise.resolve({ ok: true, file: 'x' }); } };

    const empty = await withBridge(api, () => io.projectApi.exportLibrary());
    assert.equal(empty.ok, false);
    assert.equal(empty.canceled, undefined, '空库不是「用户取消」');
    assert.match(empty.error, /空|没有/);
    assert.equal(called, 0, '空库连保存对话框都不该弹');

    const doc = cel.createDocument({ width: 20, height: 10, fps: 10, layerName: 'L' });
    await store.putProject(store.makeRecord({ name: '丙', doc }));

    const cancel = await withBridge({ saveBinary: () => Promise.resolve({ ok: false, canceled: true }) }, () =>
        io.projectApi.exportLibrary());
    assert.equal(cancel.ok, false);
    assert.equal(cancel.canceled, true);

    const failed = await withBridge({ saveBinary: () => Promise.resolve({ ok: false, error: '磁盘只读' }) }, () =>
        io.projectApi.exportLibrary());
    assert.equal(failed.ok, false);
    assert.equal(failed.canceled, undefined);
    assert.match(failed.error, /磁盘只读/, '失败要带出原因');
});

test('importFile：识别整库备份包并逐条入库，不切换当前文档（真行为）', async () => {
    const { io, ds, cel, store } = await loadProjectIo();
    store.__resetMemory();
    const doc = cel.createDocument({ width: 20, height: 10, fps: 10, layerName: 'L' });
    const a = store.makeRecord({ name: 'P1', doc });
    const b = store.makeRecord({ name: 'P2', doc });
    const bundle = store.libraryBundleOf([a, b]);
    // 混进一条坏档：整体导入必须「好的一条不少、坏的一条不炸」
    bundle.projects.push({ format: store.FORMAT, version: 4, name: '坏档', doc: {} });

    freshDoc(cel, ds);
    ds.project.dirty = false; // 切换守门直接放行（这条测试不测守门）
    const before = ds.state.doc;
    const api = { loadProject: () => Promise.resolve({ ok: true, file: 'C:/backup/library.json', json: bundle }) };

    const ok = await withBridge(api, () => io.projectApi.importFile());
    assert.equal(ok, true);
    assert.equal(ds.state.doc, before, '恢复备份只入库，不切换当前文档（可能正画到一半）');

    const rows = await store.listProjects();
    assert.equal(rows.length, 2, '两条好档都进来了，坏档没有拖垮整份备份');
    assert.deepEqual(rows.map((r) => r.name).sort(), ['P1', 'P2']);
    assert.equal(rows.every((r) => r.file === ''), true, '从备份恢复的项目不绑定文件');
    // 提示文案被「错误不被普通消息顶掉」的规矩挡着（前面用例留下的错误提示还在寿命里），
    // 所以这里只断行为；「已导入 N 个（失败 M 个）」这句由下面的源码守卫 + i18n 测试钉住。
});

test('unbindFile：没有绑定文件时直接说「无需解除」，不弹确认框（真行为）', async () => {
    const { io, ds, cel } = await loadProjectIo();
    freshDoc(cel, ds);
    // 假桥里没有 addEventListener：真弹出 askChoice 会在这里炸掉，反向证明没弹
    const out = await withBridge({}, () => io.projectApi.unbindFile());
    assert.equal(out.ok, false);
    assert.equal(out.canceled, undefined, '没绑定文件不是「用户取消」');
    assert.match(out.error, /没有绑定|无需解除/);
});

test('源码守卫：整库备份走 saveBinaryChecked，导入端先认备份包再认单项目', () => {
    const io = read('../app/shell/project-io.mjs');
    assert.match(io, /store\.libraryBundleOf\(records\)/, '备份包必须由 store 的纯函数组装');
    assert.match(io, /ipc\.saveBinaryChecked\(\s*'motionstudio-library'/, '整库备份走可分辨的保存通道');
    assert.match(io, /new TextEncoder\(\)\.encode\(json\)/, '备份内容按 UTF-8 字节交给主进程');
    assert.match(io, /if \(saved\.canceled\) \{/, '取消是取消');

    const body = io.slice(io.indexOf('async function importProjectFile'), io.indexOf('async function loadProject'));
    assert.match(body, /store\.isLibraryPayload\(payload\)/, '导入端必须先认备份包');
    assert.match(
        body,
        /if \(store\.isLibraryPayload\(payload\)\) return importLibraryBundle\(payload\);[\s\S]*if \(!store\.isProjectPayload\(payload\)\)/,
        '备份包分支必须在「单个项目」校验之前，否则用户看到「不是项目文件」，一条也回不来'
    );
    assert.match(body, /return importLibraryBundle\(payload\)/, '备份包走逐条入库，不打开当前文档');
    assert.match(
        io,
        /flash\(t\('shell\.importLibrary\.done', \{ n: ok, failed \}\)\)/,
        '成功的和失败的条数都要报出来，不能只报「已导入」'
    );
});

test('源码守卫：projectApi 暴露三个新动作，openedAt 在打开/导入/恢复/新建处写回', () => {
    const io = read('../app/shell/project-io.mjs');
    assert.match(io, /duplicate: \(id\) => duplicateProject\(id\)/);
    assert.match(io, /unbindFile: \(\) => unbindFile\(\)/);
    assert.match(io, /exportLibrary: \(\) => exportLibrary\(\)/);

    // 解除绑定：必须二次确认；取消不是失败；库记录的绑定也要清
    const unbind = io.slice(io.indexOf('async function unbindFile'), io.indexOf('async function exportLibrary'));
    assert.match(unbind, /askChoice\(/);
    assert.match(unbind, /if \(choice !== 'unbind'\) return \{ ok: false, canceled: true \}/);
    assert.match(unbind, /rec\.file = ''/, '库记录的绑定也要清掉，否则下次打开又回来');
    assert.match(unbind, /flash\(t\('shell\.unbind\.done'\)\)/);
    assert.match(unbind, /if \(!file\) return \{ ok: false, error: t\('shell\.unbind\.none'\) \}/);

    // 复制：名字按语言拼（词条），store 不做文案
    const dup = io.slice(io.indexOf('async function duplicateProject'), io.indexOf('async function unbindFile'));
    assert.match(dup, /t\('shell\.project\.copyOf'/, '副本名字要走词条（英文「copy」/中文「副本」）');
    assert.match(dup, /store\.duplicateProject\(id, \{ name \}\)/);

    // openedAt：只写 openedAt、不碰 savedAt；打开 / 导入 / 恢复三条路都要落库
    const touch = io.slice(io.indexOf('async function touchOpenedAt'), io.indexOf('async function projectFilePayload'));
    assert.match(touch, /rec\.openedAt = now;/);
    assert.doesNotMatch(touch, /savedAt/, '写回「最近打开」不能改 savedAt（那会让卡片谎报刚保存过）');
    const calls = io.match(/await touchOpenedAt\(/g) || [];
    assert.ok(calls.length >= 3, '打开 / 导入 / 恢复三条路都要写回，实际 ' + calls.length);
    assert.match(io, /openedAt: openedAtMs/, 'current() 要把 openedAt 给面板（卡片 meta 用）');
    assert.match(io, /openedAt: openedAtMs > 0 \? openedAtMs : undefined/, '保存时沿用打开时刻，不刷新它');
});

/* ─────── ⑧ P2 项目库：置顶 / 标签 / 排序统计 / 同文件绑定冲突 ─────── */

test('parseTags：逗号 / 中文逗号 / 顿号 / 分号都是分隔符，清洗规则与 store 同一份', async () => {
    const { io } = await loadProjectIo();
    assert.deepEqual(io.parseTags('a,b，c、d;e；f'), ['a', 'b', 'c', 'd', 'e', 'f']);
    // 空白、空段、重复都在清洗里消化；中文标点混排也认
    assert.deepEqual(io.parseTags('  a ,, b ，,、 c ；; a '), ['a', 'b', 'c']);
    assert.deepEqual(io.parseTags('  ,，、;;  '), [], '全是分隔符 = 清空标签');
    assert.deepEqual(io.parseTags(''), []);
    assert.deepEqual(io.parseTags(null), []);
    assert.deepEqual(io.parseTags(undefined), []);
    // 上限与 store 一致：9 条只留 8、每条截到 24
    assert.equal(io.parseTags('t1,t2,t3,t4,t5,t6,t7,t8,t9').length, 8);
    assert.deepEqual(io.parseTags('x'.repeat(30)), ['x'.repeat(24)], '超长标签截到 24');
});

test('projectApi.sortRows / totals：面板同步调用，直接落到 store 纯函数', async () => {
    const { io } = await loadProjectIo();
    const rows = [
        { id: 'a', name: 'B', savedAt: 100, openedAt: 50, bytes: 10, pinned: false },
        { id: 'b', name: 'A', savedAt: 300, openedAt: 20, bytes: 5, pinned: true },
    ];
    const sorted = io.projectApi.sortRows(rows, 'saved');
    assert.deepEqual(sorted.map((r) => r.id), ['b', 'a'], '置顶永远最前');
    assert.deepEqual(io.projectApi.totals(rows), { count: 2, bytes: 15 });
    // 同步返回（面板在 paint() 里直接拿结果，不 await）
    assert.equal(typeof io.projectApi.sortRows(rows, 'name').then, 'undefined');
});

test('setPinned：改的是库记录里的 pinned；记录不存在回 ok:false 而不是抛（真行为）', async () => {
    const { io, cel, store } = await loadProjectIo();
    store.__resetMemory();
    const doc = cel.createDocument({ width: 20, height: 10, fps: 10, layerName: 'L' });
    await store.putProject(store.makeRecord({ id: 'pin-1', name: '甲', doc }));

    await withBridge({}, async () => {
        const on = await io.projectApi.setPinned('pin-1', true);
        assert.equal(on.ok, true);
        assert.equal(on.pinned, true);
        assert.equal((await store.getProject('pin-1')).pinned, true, '置顶要写进库记录');
        // 列表视图也要带出来：面板靠 list() 渲染星标
        const row = (await store.listProjects()).find((r) => r.id === 'pin-1');
        assert.equal(row.pinned, true);

        const off = await io.projectApi.setPinned('pin-1', false);
        assert.equal(off.ok, true);
        assert.equal(off.pinned, false);
        assert.equal((await store.getProject('pin-1')).pinned, false);

        const missing = await io.projectApi.setPinned('nope', true);
        assert.equal(missing.ok, false);
        assert.ok(String(missing.error).length > 0, '失败必须带一句能读的原因');
    });
});

test('editTags：记录不存在是失败、对话框取消是 canceled（真行为）', async () => {
    const { io, cel, store } = await loadProjectIo();
    store.__resetMemory();
    const doc = cel.createDocument({ width: 20, height: 10, fps: 10, layerName: 'L' });
    await store.putProject(store.makeRecord({ id: 'tags-1', name: '甲', doc, tags: ['旧'] }));

    // node 里没有可用的 window（stubDom 只给了 document）：内联对话框起不来 → 视作取消。
    // 关键断言是「取消」与「清空标签」可分辨 —— 取消不能把已有标签清掉。
    const canceled = await withBridge(null, () => io.projectApi.editTags('tags-1'));
    assert.equal(canceled.ok, false);
    assert.equal(canceled.canceled, true);
    assert.deepEqual((await store.getProject('tags-1')).tags, ['旧'], '取消不改记录');

    const missing = await withBridge(null, () => io.projectApi.editTags('nope'));
    assert.equal(missing.ok, false);
    assert.equal(missing.canceled, undefined, '记录不存在不是「用户取消」');
    assert.ok(String(missing.error).length > 0);
});

/* ─── 真实 DOM 替身：让 askChoice 真的「弹出来」并被点掉（node 里没有 DOM） ─── */

/** 够用的元素替身：style / children / click 监听 / querySelector('button')。 */
function fakeEl(tag) {
    const node = {
        tagName: String(tag || '').toUpperCase(),
        style: {},
        children: [],
        className: '',
        textContent: '',
        parentNode: null,
        appendChild(child) {
            child.parentNode = node;
            node.children.push(child);
            return child;
        },
        removeChild(child) {
            const i = node.children.indexOf(child);
            if (i >= 0) node.children.splice(i, 1);
            child.parentNode = null;
            return child;
        },
        addEventListener(type, fn) {
            if (!node.__on) node.__on = {};
            node.__on[type] = fn;
        },
        removeEventListener() {},
        querySelector(sel) {
            if (sel !== 'button') return null;
            const walk = (n) => {
                for (const c of n.children) {
                    if (c.tagName === 'BUTTON') return c;
                    const hit = walk(c);
                    if (hit) return hit;
                }
                return null;
            };
            return walk(node);
        },
        focus() {},
        select() {},
    };
    return node;
}

/** 临时换一套可点掉的 DOM + window（带 motionAPI 假桥），跑完原样恢复。 */
async function withAskDom(api, fn) {
    const prevDoc = globalThis.document;
    const prevWin = globalThis.window;
    const body = fakeEl('body');
    globalThis.document = {
        documentElement: { lang: '' },
        body,
        createElement: fakeEl,
        addEventListener() {},
        removeEventListener() {},
        querySelector: () => null,
    };
    globalThis.window = { motionAPI: api, addEventListener() {}, removeEventListener() {} };
    try {
        return await fn(body);
    } finally {
        globalThis.document = prevDoc;
        if (prevWin === undefined) delete globalThis.window;
        else globalThis.window = prevWin;
    }
}

/** 点掉 askChoice 浮层里 value 对应的按钮（askChoice 给按钮的 class 是 `ms-ask-<value>`）。 */
function clickAsk(body, value) {
    const box = body.children[0];
    const btn = box && box.children.find((c) => c.className === 'ms-ask-' + value);
    assert.ok(btn, '没找到浮层按钮：' + value);
    btn.__on.click();
}

/**
 * 造「同一文件被两条记录绑着」的现场：
 * - `dup-b` 是本次另存为的目标（当前打开的项目，原本不绑文件）；
 * - `dup-c` 是已经绑着 `shared` 的另一条记录。
 */
async function sharedFileScene(cel, ds, store, shared) {
    store.__resetMemory();
    const doc = cel.createDocument({ width: 20, height: 10, fps: 10, layerName: 'L' });
    await store.putProject(store.makeRecord({ id: 'dup-b', name: 'B', doc, file: '' }));
    await store.putProject(store.makeRecord({ id: 'dup-c', name: 'C', doc, file: shared }));
    freshDoc(cel, ds);
    ds.project.id = 'dup-b';
    ds.project.name = 'B';
}

test('writeProjectFile 同文件冲突：取消 = 文件已写出但绑定不转移（真实点按钮）', async () => {
    const { io, ds, cel, store } = await loadProjectIo();
    const shared = 'C:/work/shared.msp';
    await sharedFileScene(cel, ds, store, shared);
    const api = { saveProject: () => ({ ok: true, file: shared }) };

    await withAskDom(api, async (body) => {
        const pending = io.projectApi.exportFile('dup-b');
        // 等 askChoice 把浮层挂上（写盘 + 读库几步 await）
        await new Promise((r) => setTimeout(r, 20));
        clickAsk(body, 'cancel');
        const out = await pending;
        assert.equal(out.ok, true, '取消转移不是保存失败：文件确实写出来了');
        assert.equal(out.file, shared);
        assert.equal(ds.project.file, '', '取消后当前项目仍不绑定这个文件');
        assert.equal((await store.getProject('dup-b')).file, '', '目标记录也不绑定');
        assert.equal((await store.getProject('dup-c')).file, shared, '原绑定保持原样（文件没有被删/回滚）');
    });
});

test('writeProjectFile 同文件冲突：选「转移给当前项目」清掉别人的绑定（真实点按钮）', async () => {
    const { io, ds, cel, store } = await loadProjectIo();
    const shared = 'C:/work/shared.msp';
    await sharedFileScene(cel, ds, store, shared);
    const api = { saveProject: () => ({ ok: true, file: shared }) };

    await withAskDom(api, async (body) => {
        const pending = io.projectApi.exportFile('dup-b');
        await new Promise((r) => setTimeout(r, 20));
        clickAsk(body, 'move');
        const out = await pending;
        assert.equal(out.ok, true);
        assert.equal(out.file, shared);
        assert.equal(ds.project.file, shared, '当前项目接管绑定（否则下次 Ctrl+S 写回旧文件）');
        assert.equal((await store.getProject('dup-b')).file, shared, '目标记录绑定到新文件');
        assert.equal((await store.getProject('dup-c')).file, '', '原记录不再绑定，避免两个项目抢同一个交付物');
    });
});

test('editTags：确认后按分隔符清洗写库，空输入 = 清空标签（真实点按钮）', async () => {
    const { io, cel, store } = await loadProjectIo();
    store.__resetMemory();
    const doc = cel.createDocument({ width: 20, height: 10, fps: 10, layerName: 'L' });
    await store.putProject(store.makeRecord({ id: 'tags-2', name: '甲', doc, tags: ['旧'] }));

    await withAskDom({}, async (body) => {
        const pending = io.projectApi.editTags('tags-2');
        await new Promise((r) => setTimeout(r, 10));
        const input = body.children[0].children.find((c) => c.className === 'ms-ask-input');
        assert.equal(input.value, '旧', '弹框要预填当前标签');
        input.value = ' 角色 , BOSS，角色 ; 头目 ';
        clickAsk(body, 'ok');
        const out = await pending;
        assert.equal(out.ok, true);
        assert.deepEqual(out.tags, ['角色', 'BOSS', '头目'], '四种分隔符 + 去重 + trim');
        assert.deepEqual((await store.getProject('tags-2')).tags, ['角色', 'BOSS', '头目']);

        // 空输入点确认 = 清空标签（不是取消）—— 与「取消」必须可分辨
        const pending2 = io.projectApi.editTags('tags-2');
        await new Promise((r) => setTimeout(r, 10));
        const input2 = body.children[0].children.find((c) => c.className === 'ms-ask-input');
        input2.value = '';
        clickAsk(body, 'ok');
        const out2 = await pending2;
        assert.equal(out2.ok, true);
        assert.deepEqual(out2.tags, []);
        assert.deepEqual((await store.getProject('tags-2')).tags, [], '清空标签要真的清掉');
    });
});

test('源码守卫：editTags 走 store.updateProjectMeta + 内联输入框 + 词条', () => {
    const io = read('../app/shell/project-io.mjs');
    const body = io.slice(io.indexOf('async function editTags'), io.indexOf('/* ─────────────────── 未命名草稿'));
    assert.match(body, /store\.updateProjectMeta\(id, \{ tags: tags \}\)/, '标签写库只能走白名单入口');
    assert.match(body, /parseTags\(text\)/, '输入文本统一走 parseTags');
    assert.match(body, /askInlineText\(current\.join\(', '\), t\('shell\.tags\.ask'\)\)/, '预填当前标签，复用外壳内联对话框');
    assert.match(body, /return \{ ok: false, canceled: true \}/, '取消要能被调用方识别');
    assert.match(body, /flash\(t\('shell\.tags\.done'/, '成功要有反馈');
    assert.match(body, /notifyProjects\(\)/, '写完要通知面板刷新');
    assert.match(body, /okResult\(\{ tags/, '成功把清洗后的标签还给面板');
    // 「清空标签」与「取消」必须可区分：askInlineText 取消回 null，确认回字符串（可为空）
    assert.match(io, /function askInlineText\(def, label\)/);
    assert.match(io, /askProjectName\(def\) \{[\s\S]{0,120}askInlineText\(def, t\('shell\.ask\.name'\)\)/, '项目名输入框也复用同一套');
    assert.match(io, /finish\(null\)/, 'Esc / 取消按钮回 null');
});

test('源码守卫：setPinned 走白名单入口、成功后通知面板', () => {
    const io = read('../app/shell/project-io.mjs');
    const body = io.slice(io.indexOf('async function setPinned'), io.indexOf('async function editTags'));
    assert.match(body, /store\.updateProjectMeta\(id, \{ pinned: want \}\)/);
    assert.match(body, /notifyProjects\(\)/);
    assert.match(body, /okResult\(\{ pinned:/);
    assert.match(body, /return fail\(t\('shell\.pin\.failed'\)\)/, '记录不存在 / 写失败要有 error');
});

test('源码守卫：writeProjectFile 的同文件绑定冲突有「转移 / 取消」两路，取消不回滚写盘', () => {
    const io = read('../app/shell/project-io.mjs');
    const body = io.slice(io.indexOf('async function writeProjectFile'), io.indexOf('async function importLibraryBundle'));

    // 写成功、绑定之前先找占用者（排除本次目标）
    assert.match(body, /const targetId = id \|\| /, '先算出这次要绑定到哪条记录');
    assert.match(body, / await fileOwners\(out\.file, targetId\)/, '用 listProjects 找 file 相同的其它记录');

    // 有冲突 → askChoice 两路：转移给当前项目 / 取消
    assert.match(body, /askChoice\(\s*t\('shell\.bindConflict\.title'\)/);
    assert.match(body, /\{ label: t\('shell\.bindConflict\.move'\), value: 'move' \}/, '缺「转移给当前项目」');
    assert.match(body, /t\('shell\.ask\.cancel'\), value: 'cancel'/, '缺取消');
    assert.match(body, /if \(choice !== 'move'\) \{/, '非转移一律按取消处理（Esc 也算取消）');

    // 取消：文件已经写出 → 不回滚、不重写、不算失败，只警告绑定没转
    assert.equal((body.match(/ipc\.saveProject\(/g) || []).length, 1, '取消分支不许再写一次盘');
    assert.doesNotMatch(body, /unlink|rmSync|deleteProject/, '取消不能删掉刚写出的文件');
    const warning = body.indexOf("t('shell.bindConflict.keepOld'");
    assert.ok(warning > 0, '取消要明确说「文件已写出、绑定未转移」');
    assert.match(
        body,
        /flash\(t\('shell\.bindConflict\.keepOld'[\s\S]{0,160}'error'\)/,
        '用错误档，别被下一条普通提示顶掉'
    );
    const cancelTail = body.slice(warning);
    assert.match(cancelTail, /return okResult\(\{ file: out\.file \}\)/, '取消也要正常返回（文件确实写出来了）');
    assert.ok(body.indexOf('if (sameProject) project.file = out.file') > warning, '取消路径必须早于绑定赋值');

    // 转移：清掉别的记录的 file，再给本记录绑定
    assert.match(body, /const moved = await takeOverFileBinding\(targetId, out\.file\)/);
    assert.match(body, /flash\(t\('shell\.bindConflict\.moved'/);

    // 辅助函数：只清绑定、不碰磁盘；清的是「当前项目」记录时内存绑定一起清
    const helpers = io.slice(io.indexOf('async function fileOwners'), io.indexOf('async function setPinned'));
    assert.match(helpers, /store\.listProjects\(\)/);
    assert.match(helpers, /row\.file === path/);
    assert.match(helpers, /rec\.file = ''/);
    assert.match(helpers, /if \(project\.id === id\) project\.file = ''/, '冲突方是当前项目时顶栏绑定也要清');

    // 无冲突时行为不变：不弹框，仍然「已保存文件」
    assert.match(body, /if \(!o\.quiet && !owners\.length\) flash\(t\('shell\.saveFile\.done'/);
});

test('源码守卫：load / import 打开已被别的记录绑定的文件时静默转移绑定', () => {
    const io = read('../app/shell/project-io.mjs');

    const load = io.slice(io.indexOf('async function loadProject'), io.indexOf('async function newProject'));
    assert.match(load, /await takeOverFileBinding\(source\.id, source\.file\)/, '打开路径要静默转移');
    assert.match(load, /t\('shell\.bind\.takenOnLoad'/);
    assert.doesNotMatch(load, /askChoice/, '打开路径不弹框');

    const imp = io.slice(io.indexOf('async function importProjectFile'), io.indexOf('async function loadProject'));
    assert.match(imp, /await takeOverFileBinding\(importedId, rec\.file/, '导入路径要静默转移');
    assert.match(imp, /t\('shell\.bind\.takenOnImport'/);
    assert.doesNotMatch(imp, /askChoice/, '导入路径不弹框');

    // 两条路径都复用同一个 takeOverFileBinding（清其它记录 + 返回被清掉的名字）
    const take = io.slice(io.indexOf('async function takeOverFileBinding'), io.indexOf('async function setPinned'));
    assert.match(take, /fileOwners\(file, id\)/);
    assert.match(take, /clearFileBinding\(row\.id\)/);
});
