import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    EFFECT_DEFS,
    defaultEffect,
    normalizeEffect,
    filterString,
    applyEffects,
    clearEffects,
    hasEffects,
} from '../app/paint/effects.mjs';

const BLUR4 = [{ type: 'blur', amount: 4 }, { type: 'glow', amount: 8, color: '#4a7dff' }];

/* ─────────────────────────── 定义表 ─────────────────────────── */

test('EFFECT_DEFS 含五类效果，id 唯一', () => {
    const ids = EFFECT_DEFS.map((d) => d.id);
    assert.deepEqual(ids, ['blur', 'glow', 'shadow', 'adjust', 'outline']);
    assert.equal(new Set(ids).size, ids.length);
});

test('EFFECT_DEFS 每类都有 name 与 params，默认值落在范围内', () => {
    for (const def of EFFECT_DEFS) {
        assert.ok(def.name.length > 0, def.id + ' 缺 name');
        assert.ok(def.params.length > 0, def.id + ' 缺 params');
        for (const p of def.params) {
            assert.ok(p.key && p.label, def.id + ' 参数缺 key/label');
            assert.ok('def' in p, def.id + '.' + p.key + ' 缺 def');
            if (p.color) {
                assert.equal(typeof p.def, 'string');
            } else {
                assert.equal(typeof p.min, 'number');
                assert.equal(typeof p.max, 'number');
                assert.equal(typeof p.step, 'number');
                assert.ok(p.def >= p.min && p.def <= p.max, def.id + '.' + p.key + ' 默认值越界');
            }
        }
    }
});

test('EFFECT_DEFS 是冻结的（外部改不动）', () => {
    assert.ok(Object.isFrozen(EFFECT_DEFS));
    assert.ok(Object.isFrozen(EFFECT_DEFS[0]));
    assert.ok(Object.isFrozen(EFFECT_DEFS[0].params));
});

/* ─────────────────────────── defaultEffect ─────────────────────────── */

test('defaultEffect 各类默认值', () => {
    assert.deepEqual(defaultEffect('blur'), { type: 'blur', amount: 4 });
    assert.deepEqual(defaultEffect('glow'), { type: 'glow', amount: 8, color: '#4a7dff' });
    assert.deepEqual(defaultEffect('shadow'), {
        type: 'shadow',
        dx: 4,
        dy: 4,
        amount: 6,
        color: 'rgba(0,0,0,0.45)',
    });
    assert.deepEqual(defaultEffect('adjust'), {
        type: 'adjust',
        brightness: 1,
        contrast: 1,
        saturate: 1,
        hue: 0,
    });
    assert.deepEqual(defaultEffect('outline'), { type: 'outline', amount: 2, color: '#000000' });
});

test('defaultEffect 未知 / 非字符串一律 null', () => {
    assert.equal(defaultEffect('nosuch'), null);
    assert.equal(defaultEffect(''), null);
    assert.equal(defaultEffect(undefined), null);
    assert.equal(defaultEffect(null), null);
    assert.equal(defaultEffect(42), null);
});

test('defaultEffect 每次返回新对象，互不影响', () => {
    const a = defaultEffect('blur');
    const b = defaultEffect('blur');
    a.amount = 30;
    assert.equal(b.amount, 4);
});

/* ─────────────────────────── normalizeEffect ─────────────────────────── */

test('normalizeEffect 上界夹取', () => {
    assert.equal(normalizeEffect({ type: 'blur', amount: 999 }).amount, 40);
    assert.equal(normalizeEffect({ type: 'glow', amount: 999 }).amount, 40);
    assert.equal(normalizeEffect({ type: 'outline', amount: 999 }).amount, 20);
    assert.equal(normalizeEffect({ type: 'adjust', hue: 720 }).hue, 180);
    assert.equal(normalizeEffect({ type: 'adjust', brightness: 9 }).brightness, 2);
});

test('normalizeEffect 下界夹取', () => {
    assert.equal(normalizeEffect({ type: 'blur', amount: -5 }).amount, 0);
    assert.equal(normalizeEffect({ type: 'shadow', dx: -999 }).dx, -40);
    assert.equal(normalizeEffect({ type: 'shadow', dy: -999 }).dy, -40);
    assert.equal(normalizeEffect({ type: 'adjust', hue: -720 }).hue, -180);
    assert.equal(normalizeEffect({ type: 'adjust', contrast: -1 }).contrast, 0);
});

test('normalizeEffect 缺失参数补默认值', () => {
    assert.deepEqual(normalizeEffect({ type: 'shadow' }), {
        type: 'shadow',
        dx: 4,
        dy: 4,
        amount: 6,
        color: 'rgba(0,0,0,0.45)',
    });
    assert.deepEqual(normalizeEffect({ type: 'adjust', contrast: 0 }), {
        type: 'adjust',
        brightness: 1,
        contrast: 0,
        saturate: 1,
        hue: 0,
    });
});

test('normalizeEffect 认数字字符串', () => {
    assert.equal(normalizeEffect({ type: 'blur', amount: '12.5' }).amount, 12.5);
    assert.equal(normalizeEffect({ type: 'adjust', hue: '-90' }).hue, -90);
});

test('normalizeEffect 非法数值回落默认值（NaN / Infinity / 空串 / 布尔）', () => {
    assert.equal(normalizeEffect({ type: 'blur', amount: NaN }).amount, 4);
    assert.equal(normalizeEffect({ type: 'blur', amount: Infinity }).amount, 4);
    assert.equal(normalizeEffect({ type: 'blur', amount: '' }).amount, 4);
    assert.equal(normalizeEffect({ type: 'blur', amount: true }).amount, 4);
    assert.equal(normalizeEffect({ type: 'blur', amount: {} }).amount, 4);
});

test('normalizeEffect 颜色：非法值回落默认，合法值保留并去空白', () => {
    assert.equal(normalizeEffect({ type: 'glow', amount: 8, color: '' }).color, '#4a7dff');
    assert.equal(normalizeEffect({ type: 'glow', amount: 8, color: 0 }).color, '#4a7dff');
    assert.equal(normalizeEffect({ type: 'glow', color: '  #ff0000  ' }).color, '#ff0000');
});

test('normalizeEffect type 非法返回 null', () => {
    assert.equal(normalizeEffect({ type: 'nosuch', amount: 1 }), null);
    assert.equal(normalizeEffect({ amount: 1 }), null);
    assert.equal(normalizeEffect({ type: 42 }), null);
});

test('normalizeEffect 非对象输入返回 null', () => {
    assert.equal(normalizeEffect(null), null);
    assert.equal(normalizeEffect(undefined), null);
    assert.equal(normalizeEffect('blur'), null);
    assert.equal(normalizeEffect(4), null);
    assert.equal(normalizeEffect([{ type: 'blur' }]), null);
});

test('normalizeEffect 丢弃多余键', () => {
    assert.deepEqual(normalizeEffect({ type: 'blur', amount: 4, junk: 1, name: 'x' }), {
        type: 'blur',
        amount: 4,
    });
    assert.deepEqual(normalizeEffect({ type: 'blur', amount: 999, extra: true }), {
        type: 'blur',
        amount: 40,
    });
});

/* ─────────────────────────── filterString ─────────────────────────── */

test('filterString 核心拼接：blur + glow', () => {
    assert.equal(filterString(BLUR4), 'blur(4px) drop-shadow(0 0 8px #4a7dff)');
});

test('filterString 顺序按数组顺序', () => {
    assert.equal(
        filterString([{ type: 'glow', amount: 8 }, { type: 'blur', amount: 4 }]),
        'drop-shadow(0 0 8px #4a7dff) blur(4px)'
    );
});

test('filterString 单位：px / deg / 无量纲', () => {
    assert.equal(filterString([{ type: 'blur', amount: 2.5 }]), 'blur(2.5px)');
    assert.equal(
        filterString([{ type: 'adjust', hue: 45 }]),
        'hue-rotate(45deg)'
    );
    assert.equal(filterString([{ type: 'adjust', brightness: 1.5 }]), 'brightness(1.5)');
});

test('filterString adjust 四个函数按声明顺序输出', () => {
    assert.equal(
        filterString([{ type: 'adjust', brightness: 1.5, contrast: 0.5, saturate: 2, hue: 90 }]),
        'brightness(1.5) contrast(0.5) saturate(2) hue-rotate(90deg)'
    );
});

test('filterString 恒等值不输出：adjust 全默认 → none', () => {
    assert.equal(filterString([{ type: 'adjust' }]), 'none');
    assert.equal(filterString([defaultEffect('adjust')]), 'none');
});

test('filterString 恒等值不输出：blur 0 / glow 0 / outline 0 → none', () => {
    assert.equal(filterString([{ type: 'blur', amount: 0 }]), 'none');
    assert.equal(filterString([{ type: 'glow', amount: 0 }]), 'none');
    assert.equal(filterString([{ type: 'outline', amount: 0 }]), 'none');
});

test('filterString 只跳过恒等部分，其余照常输出', () => {
    assert.equal(
        filterString([
            { type: 'blur', amount: 0 },
            { type: 'adjust', brightness: 1, contrast: 1, saturate: 1, hue: 30 },
        ]),
        'hue-rotate(30deg)'
    );
});

test('filterString shadow：偏移与模糊全 0 才剔除', () => {
    assert.equal(filterString([{ type: 'shadow', dx: 0, dy: 0, amount: 0 }]), 'none');
    assert.equal(
        filterString([{ type: 'shadow', dx: 0, dy: 0, amount: 6, color: '#123456' }]),
        'drop-shadow(0px 0px 6px #123456)'
    );
});

test('filterString shadow：负数偏移带负号', () => {
    assert.equal(
        filterString([{ type: 'shadow', dx: -4, dy: -4, amount: 6, color: '#000' }]),
        'drop-shadow(-4px -4px 6px #000)'
    );
    assert.equal(
        filterString([{ type: 'shadow', dx: -0.5, dy: 8, amount: 0, color: 'red' }]),
        'drop-shadow(-0.5px 8px 0px red)'
    );
});

test('filterString outline：四个方向各一次 drop-shadow', () => {
    assert.equal(
        filterString([{ type: 'outline', amount: 2, color: '#000000' }]),
        'drop-shadow(2px 0 0 #000000) drop-shadow(-2px 0 0 #000000) ' +
            'drop-shadow(0 2px 0 #000000) drop-shadow(0 -2px 0 #000000)'
    );
});

test('filterString 数值格式：最多三位小数、去掉浮点尾巴', () => {
    assert.equal(filterString([{ type: 'blur', amount: 4.4444 }]), 'blur(4.444px)');
    assert.equal(
        filterString([{ type: 'adjust', brightness: 0.1 + 0.2 }]),
        'brightness(0.3)'
    );
    assert.equal(filterString([{ type: 'blur', amount: 40 }]), 'blur(40px)');
});

test('filterString 空数组 / 非数组 → none', () => {
    assert.equal(filterString([]), 'none');
    assert.equal(filterString(null), 'none');
    assert.equal(filterString(undefined), 'none');
    assert.equal(filterString('blur'), 'none');
    assert.equal(filterString({ type: 'blur' }), 'none');
});

test('filterString 全非法 → none', () => {
    assert.equal(filterString([null, undefined, 42, 'x', {}, { type: 'nosuch' }]), 'none');
});

test('filterString 混合非法与合法：只留合法项', () => {
    assert.equal(
        filterString([null, { type: 'blur', amount: 4 }, { type: 'nosuch' }, { type: 'outline', amount: 1 }]),
        'blur(4px) drop-shadow(1px 0 0 #000000) drop-shadow(-1px 0 0 #000000) ' +
            'drop-shadow(0 1px 0 #000000) drop-shadow(0 -1px 0 #000000)'
    );
});

test('filterString 越界值先夹取再输出', () => {
    assert.equal(filterString([{ type: 'blur', amount: 999 }]), 'blur(40px)');
    assert.equal(filterString([{ type: 'adjust', hue: 999 }]), 'hue-rotate(180deg)');
});

/* ─────────────────────────── applyEffects / clearEffects ─────────────────────────── */

test('applyEffects 成功：写入 filter 并返回 true', () => {
    const g = { filter: '' };
    assert.equal(applyEffects(g, BLUR4), true);
    assert.equal(g.filter, 'blur(4px) drop-shadow(0 0 8px #4a7dff)');
});

test('applyEffects 空效果：写成 none，仍返回 true', () => {
    const g = { filter: 'blur(4px)' };
    assert.equal(applyEffects(g, []), true);
    assert.equal(g.filter, 'none');
});

test('applyEffects 写入抛错：返回 false、不冒泡、尽力回退 none', () => {
    const boom = {
        _v: 'seed',
        get filter() {
            return this._v;
        },
        set filter(v) {
            throw new Error('boom');
        },
    };
    assert.doesNotThrow(() => applyEffects(boom, [{ type: 'blur', amount: 4 }]));
    assert.equal(applyEffects(boom, [{ type: 'blur', amount: 4 }]), false);
    assert.equal(boom._v, 'seed');
});

test('applyEffects 首次成功、回退也失败时仍返回 false', () => {
    let calls = 0;
    const once = {
        filter: '',
        get setter() {
            return null;
        },
    };
    Object.defineProperty(once, 'filter', {
        get() {
            return 'x';
        },
        set() {
            calls += 1;
            if (calls === 1) throw new Error('第一次就炸');
            throw new Error('回退也炸');
        },
    });
    assert.equal(applyEffects(once, [{ type: 'blur', amount: 4 }]), false);
    assert.equal(calls, 2);
});

test('applyEffects 传入空上下文返回 false', () => {
    assert.equal(applyEffects(null, BLUR4), false);
    assert.equal(applyEffects(undefined, BLUR4), false);
});

test('clearEffects 把 filter 置回 none', () => {
    const g = { filter: 'blur(4px)' };
    clearEffects(g);
    assert.equal(g.filter, 'none');
    clearEffects(null);
    assert.doesNotThrow(() => clearEffects(undefined));
});

test('applyEffects + clearEffects 往返', () => {
    const g = { filter: 'none' };
    applyEffects(g, [{ type: 'outline', amount: 3 }]);
    assert.notEqual(g.filter, 'none');
    clearEffects(g);
    assert.equal(g.filter, 'none');
});

/* ─────────────────────────── hasEffects ─────────────────────────── */

test('hasEffects：有效效果 true', () => {
    assert.equal(hasEffects(BLUR4), true);
    assert.equal(hasEffects([{ type: 'adjust', hue: 10 }]), true);
    assert.equal(hasEffects([{ type: 'shadow', dx: 0, dy: 0, amount: 6 }]), true);
});

test('hasEffects：空 / 非数组 / 恒等值 / 非法项都 false', () => {
    assert.equal(hasEffects([]), false);
    assert.equal(hasEffects(null), false);
    assert.equal(hasEffects(undefined), false);
    assert.equal(hasEffects([{ type: 'adjust' }]), false);
    assert.equal(hasEffects([{ type: 'blur', amount: 0 }]), false);
    assert.equal(hasEffects([{ type: 'nosuch' }, null]), false);
});

test('hasEffects 与 filterString 结论一致', () => {
    const cases = [
        [],
        [{ type: 'blur', amount: 4 }],
        [{ type: 'adjust' }],
        [{ type: 'outline', amount: 0 }],
        [{ type: 'shadow', dx: 1, dy: 1, amount: 1 }],
    ];
    for (const c of cases) {
        assert.equal(hasEffects(c), filterString(c) !== 'none', JSON.stringify(c));
    }
});

/* ─────────────────────────── 端到端 ─────────────────────────── */

test('默认效果全量：除 adjust 外都能产出 filter 串', () => {
    for (const def of EFFECT_DEFS) {
        const e = defaultEffect(def.id);
        const s = filterString([e]);
        if (def.id === 'adjust') assert.equal(s, 'none');
        else assert.ok(s !== 'none' && s.length > 0, def.id + ' 默认值产不出 filter');
        assert.equal(applyEffects({ filter: '' }, [e]), true);
    }
});

test('五个默认效果叠加后是一串可用的 filter', () => {
    const all = EFFECT_DEFS.map((d) => defaultEffect(d.id));
    const s = filterString(all);
    assert.equal(
        s,
        'blur(4px) drop-shadow(0 0 8px #4a7dff) drop-shadow(4px 4px 6px rgba(0,0,0,0.45)) ' +
            'drop-shadow(2px 0 0 #000000) drop-shadow(-2px 0 0 #000000) ' +
            'drop-shadow(0 2px 0 #000000) drop-shadow(0 -2px 0 #000000)'
    );
    assert.equal(hasEffects(all), true);
});
