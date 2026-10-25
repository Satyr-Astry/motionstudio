import test from 'node:test';
import assert from 'node:assert/strict';

import * as store from '../app/shell/project-store.mjs';
import { DRAFT_ID, isDraftRecord } from '../app/core/project-guard.mjs';

/*
 * 这一组只测「存储层的数据安全语义」—— node 里没有 IndexedDB / localStorage，
 * project-store 会自动落到内存兜底（storageKind() === 'memory'），正是我们要测的那条路径。
 */

function rec(id, name, savedAt) {
    return {
        id,
        name,
        savedAt: savedAt || 1000,
        width: 900,
        height: 640,
        frames: 1,
        layers: 1,
        thumb: '',
        file: '',
        project: { format: 'motionstudio-project', version: 4, name, doc: {} },
        bytes: 10,
    };
}

test('node 环境走内存兜底（这组测试的前提）', () => {
    store.__resetMemory();
    assert.equal(store.storageKind(), 'memory');
});

test('未命名草稿与真实项目同库，但列表里只出现项目', async () => {
    store.__resetMemory();
    await store.putProject(rec('p-1', '项目A', 2000));
    const draft = rec(DRAFT_ID, '未命名草稿', 3000);
    draft.__draft = true;
    await store.putProject(draft);

    const list = await store.listProjects();
    assert.deepEqual(list.map((r) => r.id), ['p-1']);
    // 草稿本身还在库里，只是不冒充一个项目
    assert.equal((await store.getProject(DRAFT_ID)).id, DRAFT_ID);
});

test('只靠固定键、没有 __draft 标记的老草稿也不会漏进列表', async () => {
    store.__resetMemory();
    await store.putProject(rec(DRAFT_ID, '草稿', 5000));
    assert.deepEqual(await store.listProjects(), []);
});

test('删除 → 记录真的没了；撤销（原样回写）→ 条目与 savedAt 都回来', async () => {
    store.__resetMemory();
    const original = rec('p-2', '项目B', 4321);
    await store.putProject(original);
    const before = (await store.listProjects())[0];
    assert.equal(before.savedAt, 4321);

    assert.equal(await store.deleteProject('p-2'), true);
    assert.equal(await store.getProject('p-2'), null);
    assert.deepEqual(await store.listProjects(), []);

    // 撤销 = 把整条记录再 put 回去（不新建记录、不改 savedAt）
    await store.putProject(original);
    const after = (await store.listProjects())[0];
    assert.equal(after.id, 'p-2');
    assert.equal(after.savedAt, 4321, '撤销不该让「上次保存时间」变新');
    assert.equal(after.name, '项目B');
});

test('删除不存在的 id / 空 id 不抛', async () => {
    store.__resetMemory();
    assert.equal(await store.deleteProject(''), false);
    assert.equal(await store.deleteProject(null), false);
    // 删一个不存在的 id 是幂等的（存储层无害地返回 true），重点是不抛、库不脏
    await store.deleteProject('nope');
    assert.deepEqual(await store.listProjects(), []);
});

test('重命名不改变 savedAt（名字不是内容）', async () => {
    store.__resetMemory();
    await store.putProject(rec('p-3', '旧名', 777));
    const renamed = await store.renameProject('p-3', '新名');
    assert.equal(renamed.name, '新名');
    assert.equal(renamed.savedAt, 777);
    const row = (await store.listProjects())[0];
    assert.equal(row.name, '新名');
    assert.equal(row.savedAt, 777);
});

test('重命名空名字不会把项目名抹掉（退回原名）', async () => {
    store.__resetMemory();
    await store.putProject(rec('p-4', '原名', 100));
    const out = await store.renameProject('p-4', '   ');
    assert.equal(out.name, '原名');
});

test('列表按 savedAt 倒序，草稿插在中间也不影响顺序', async () => {
    store.__resetMemory();
    await store.putProject(rec('p-a', 'A', 100));
    const draft = rec(DRAFT_ID, '草稿', 300);
    draft.__draft = true;
    await store.putProject(draft);
    await store.putProject(rec('p-b', 'B', 200));
    const list = await store.listProjects();
    assert.deepEqual(list.map((r) => r.id), ['p-b', 'p-a']);
});

test('isDraftRecord 与存储层的过滤口径一致', async () => {
    store.__resetMemory();
    const draft = rec(DRAFT_ID, '草稿', 100);
    draft.__draft = true;
    await store.putProject(draft);
    const raw = await store.getProject(DRAFT_ID);
    assert.equal(isDraftRecord(raw), true);
    assert.deepEqual(await store.listProjects(), []);
});
