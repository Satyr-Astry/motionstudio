// 对象面板工具条的静态约束：6 个对象动作必须常显成图标按钮，不许再折进 ⋯ 菜单。
// 背景：v8 早期为了省宽度把「复制 / 上移 / 下移 / 合并 / 删除」收进菜单，
// 结果是这五个高频动作每次都要先开菜单 —— 用户反馈「操作不够直观」。
// 这些断言在 Node 里直接查源码，不需要 DOM；渲染与点击由真机脚本兜。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ICON_NAMES } from '../app/core/icons.mjs';

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const layers = read('../app/editors/layers.mjs');
const css = read('../app/styles/panels.css');
const known = new Set(ICON_NAMES);

test('对象工具条：6 个动作全部常显，顺序固定 add/dup/up/down/merge/del', () => {
    const block = layers.slice(layers.indexOf('const BAR_ACTS'), layers.indexOf('const ACTS'));
    const acts = [...block.matchAll(/\['(add|dup|up|down|merge|del)',\s*'([a-z][a-z0-9-]*)'/g)]
        .map((m) => m[1]);
    assert.deepEqual(acts, ['add', 'dup', 'up', 'down', 'merge', 'del'],
        `BAR_ACTS 应含 6 个动作且顺序固定，实际 ${acts.join(',')}`);
});

test('对象工具条：图标的键都真实存在，而且没有引用别名', () => {
    const block = layers.slice(layers.indexOf('const BAR_ACTS'), layers.indexOf('const ACTS'));
    const icons = [...block.matchAll(/\['(?:add|dup|up|down|merge|del)',\s*'([a-z][a-z0-9-]*)'/g)]
        .map((m) => m[1]);
    assert.equal(icons.length, 6, `应抽到 6 个图标名，实际 ${icons.length}`);
    for (const name of icons) assert.ok(known.has(name), `引用了 icons.mjs 里不存在的图标: ${name}`);
    assert.deepEqual(icons, ['plus', 'copy', 'chevron-up', 'chevron-down', 'merge-down', 'trash']);
});

test('对象工具条：菜单机器已拆掉，不许死灰复燃', () => {
    assert.ok(!/MENU_ACTS/.test(layers), 'layers.mjs 里不该再有 MENU_ACTS');
    assert.ok(!/lyr-menu/.test(layers), 'layers.mjs 里不该再建 .lyr-menu');
    assert.ok(!/lyr-more/.test(layers), 'layers.mjs 里不该再有 ⋯ 入口');
    assert.ok(!/\.lyr-menu/.test(css), 'panels.css 里不该再留 .lyr-menu 规则');
    assert.ok(!/\.lyr-more/.test(css), 'panels.css 里不该再留 .lyr-more 规则');
});

test('对象工具条：每个按钮都有自己的说明（title + aria-label）', () => {
    const block = layers.slice(layers.indexOf('const BAR_ACTS'), layers.indexOf('const ACTS'));
    // '[act, icon, title]' 三元组：第三项必须是非空中文说明
    const rows = [...block.matchAll(/\['(add|dup|up|down|merge|del)',\s*'[a-z][a-z0-9-]*',\s*'([^']+)'\]/g)];
    assert.equal(rows.length, 6, `6 个动作都要有 title，实际取到 ${rows.length}`);
    for (const [, act, title] of rows) {
        assert.ok(title.length >= 2, `${act} 的提示文字太短: ${title}`);
    }
});
