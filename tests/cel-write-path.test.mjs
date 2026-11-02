// 纹理写路径（app/paint/engine.mjs 的落笔、app/shell/app.mjs 的新增/清空/落笔入口）。
// 背景：cels 只是「关键帧上的 drawing」的投影镜像，真源是 transform.keys[].drawing。
// 锁三件事：
//   ① ensureCelAt(inherit) 会把上一格的 drawing 复用给新关键帧 —— 这就是调用方必须克隆的原因；
//   ② 克隆之后必须走 setImageAt（进库 + 设 key.drawing），只改 cels 镜像渲染侧读不到；
//   ③ 三条写路径不得再手拼 cels 镜像（源码守卫，防回退）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    makeObject, ensureCelAt, imageAt, setImageAt, setKeyDrawing, keyHasDrawing, drawingsOf, celTimes,
} from '../app/core/doc-model.mjs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/** 假位图：doc-model 只认 width/height 与对象身份，Node 里不需要真 canvas。 */
const surf = (tag, w = 8, h = 8) => ({ width: w, height: h, tag });

const freshObj = () => makeObject({ name: '对象 1' });

test('ensureCelAt(inherit) 复用上一格的 drawing：这就是调用方必须克隆的原因', () => {
    const A = surf('A');
    const obj = setImageAt(freshObj(), 0, A);
    const res = ensureCelAt(obj, 2, { inherit: true });

    assert.equal(res.created, true);
    assert.equal(res.cel.image, A, '新关键帧拿到的是上一格那张位图本体');
    const keys = res.obj.transform.keys;
    assert.equal(keys.length, 2);
    assert.equal(keys[1].drawing, keys[0].drawing, '两条关键帧共用同一个 drawing id');
    assert.equal(drawingsOf(res.obj).length, 1, '纹理库里只有一张图');
});

test('克隆后走 setImageAt：两个时刻各有一张图，上一格不被改坏', () => {
    const base = setImageAt(freshObj(), 0, surf('A'));
    const res = ensureCelAt(base, 2, { inherit: true });
    const copy = surf('A-copy'); // 浏览器里是 cloneSurface(上一格)
    const next = setImageAt(res.obj, res.cel.at, copy);

    const keys = next.transform.keys;
    assert.equal(keys.length, 2);
    assert.notEqual(keys[1].drawing, keys[0].drawing, '新关键帧必须是自己的 drawing');
    assert.equal(imageAt(next, 0).tag, 'A', '0s 还是原来那张');
    assert.equal(imageAt(next, 2).tag, 'A-copy', '2s 是新拷的那张');
    assert.equal(drawingsOf(next).length, 2);
});

test('清空纹理走 setKeyDrawing(null)：这一格成为空白曝光，不是删掉关键帧', () => {
    const obj = setImageAt(freshObj(), 0, surf('A'));
    const blank = setKeyDrawing(obj, 2, null);

    assert.equal(imageAt(blank, 2), null);
    assert.deepEqual(celTimes(blank), [0, 2], '2s 仍占着一格');
    assert.equal(keyHasDrawing(blank.transform.keys[1]), true, 'drawing:null 仍算带纹理属性');
});

test('落笔入口必须克隆再走真源（engine.mjs 源码守卫）', () => {
    const engine = read('../app/paint/engine.mjs');
    assert.match(engine, /if \(res\.created\) \{/);
    assert.match(engine, /cloneSurface\(image\)/);
    assert.match(engine, /setImageAt\(nextObj, res\.cel\.at, image\)/);
    assert.doesNotMatch(engine, /cel\.image = createSurface/, '旧写法：直接改 cel.image，不进纹理库');
});

test('外壳的三条纹理写路径不再手拼 cels 镜像（app.mjs 源码守卫）', () => {
    const shell = read('../app/shell/app.mjs');
    assert.doesNotMatch(shell, /\{ cels: cels \}/);
    assert.doesNotMatch(shell, /res\.obj, \{ cels: cels \}/);
    assert.match(shell, /setImageAt\(res\.obj, placed, image\)/, 'addCelAt 走真源');
    assert.match(shell, /setKeyDrawing\(res\.obj, res\.cel\.at, null\)/, 'clearCelAt 走真源');
    assert.match(shell, /setImageAt\(res\.obj, at, image\)/, 'celImageForPaint 走真源');
});
