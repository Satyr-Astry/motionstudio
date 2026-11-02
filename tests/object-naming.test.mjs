// 缺省对象名：**只有一个真源**（`core/doc-model.mjs` 的 `DEFAULT_OBJECT_NAME` /
// `defaultObjectName` / `nextObjectName`）。
//
// 为什么值得单独测：这个字符串会写进用户数据（层级面板、导出、`.msp`），而它以前
// 散在五处、彼此不一致 —— 新建文档里的对象叫 `Object 1`，用命令新建的却叫「对象 2」。
// 这类不一致不报错，只会让用户觉得「这软件有点怪」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import {
    DEFAULT_OBJECT_NAME,
    createDoc,
    defaultObjectName,
    makeObject,
    nextObjectName,
} from '../app/core/doc-model.mjs';
import { addLayer } from '../app/core/cel.mjs';

test('缺省名是英文 Object 1（界面缺省语言是 en，且它写进用户数据）', () => {
    assert.equal(DEFAULT_OBJECT_NAME, 'Object 1');
    assert.equal(defaultObjectName(1), 'Object 1');
    assert.equal(defaultObjectName(7), 'Object 7');
    // 坏输入回落 1，不产生 "Object NaN"
    assert.equal(defaultObjectName(0), 'Object 1');
    assert.equal(defaultObjectName('x'), 'Object 1');
    assert.equal(defaultObjectName(2.6), 'Object 3');
});

test('nextObjectName：从「现有数量 + 1」起，跳过已被占用的编号', () => {
    const doc = createDoc({ objects: [makeObject({ name: 'Object 1' }), makeObject({ name: 'Object 2' })] });
    assert.equal(nextObjectName(doc), 'Object 3');
    const taken = createDoc({ objects: [makeObject({ name: 'Object 1' }), makeObject({ name: 'Object 3' })] });
    // 数量 2 → 从 3 起，但 3 被占用 → 4
    assert.equal(nextObjectName(taken), 'Object 4');
});

test('nextObjectName：也要避开老项目里的中文「对象 N」，避免重名', () => {
    const doc = createDoc({ objects: [makeObject({ name: '对象 2' })] });
    // 数量 1 → 从 2 起，但中文「对象 2」已占用 → 3
    assert.equal(nextObjectName(doc), 'Object 3');
});

test('createDoc 没有对象时补的那个也用同一真源', () => {
    const doc = createDoc({ objects: [] });
    assert.equal(doc.objects.length, 1);
    assert.equal(doc.objects[0].name, DEFAULT_OBJECT_NAME);
});

test('addLayer 的缺省名与命令新建走同一套编号', () => {
    const doc = createDoc({ objects: [makeObject({ name: 'Object 1' })] });
    const next = addLayer(doc, '');
    assert.equal(next.objects[0].name, 'Object 2', '新对象插在最前且按现有数量编号');
    // 显式给名字时不改写
    assert.equal(addLayer(doc, 'Hero').objects[0].name, 'Hero');
});

test('源码守卫：`Object 1` 只在 doc-model 里写死，别处一律引用真源', () => {
    const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const hits = [];
    const walk = (dir) => {
        for (const name of readdirSync(dir)) {
            const p = path.join(dir, name);
            const st = statSync(p);
            if (st.isDirectory()) { walk(p); continue; }
            if (!name.endsWith('.mjs')) continue;
            const src = readFileSync(p, 'utf8');
            if (src.includes("'Object 1'")) hits.push(path.relative(root, p).replace(/\\/g, '/'));
        }
    };
    walk(path.join(root, 'app'));
    assert.deepEqual(hits, ['app/core/doc-model.mjs'], '写死 Object 1 的地方应只有 doc-model，实际：' + hits.join(', '));
});

test('孤儿模块已删除：core/board.mjs 与 shell/object-factory.mjs 不再存在', () => {
    const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    assert.equal(existsSync(path.join(root, 'app/core/board.mjs')), false, 'core/board.mjs 应已删除');
    assert.equal(existsSync(path.join(root, 'app/shell/object-factory.mjs')), false, 'object-factory.mjs 应已删除');
    assert.equal(existsSync(path.join(root, 'tests/board.test.mjs')), false, 'board.test.mjs 应已删除');
});
