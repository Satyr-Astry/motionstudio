// workspace warp 快路径：零网格早退、平行四边形整格一次裁剪、草稿模式全格近似。
// 只测 paintWarped 的绘制次数与调用形态 —— 像素级正确性由 warp/lattice 那组测试兜底。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLattice } from '../app/core/lattice.mjs';
import { paintWarped } from '../app/core/evaluator.mjs';

function fakeCtx() {
    const calls = [];
    const g = {
        calls,
        clips: 0,
        draws: 0,
        restores: 0,
        filter: 'none',
        save() { calls.push('save'); },
        restore() { this.restores += 1; calls.push('restore'); },
        beginPath() { calls.push('beginPath'); },
        moveTo() {},
        lineTo() {},
        closePath() { calls.push('closePath'); },
        clip() { this.clips += 1; calls.push('clip'); },
        transform() { calls.push('transform'); },
        setTransform() { calls.push('setTransform'); },
        clearRect() {},
        drawImage(img, x, y, w, h) {
            this.draws += 1;
            calls.push(['drawImage', x, y, w, h]);
        },
    };
    return g;
}

const IMG = { width: 300, height: 200 };
const SIZE = { w: 300, h: 200 };

function latticeWith(cols, rows, vertex) {
    const lat = createLattice(cols, rows);
    lat.pts[vertex] = [10, 10];
    return lat;
}

test('零偏移网格：一张 drawImage 画完，不切格也不裁剪', () => {
    const g = fakeCtx();
    paintWarped(g, IMG, createLattice(3, 3), SIZE, 6);
    assert.equal(g.clips, 0);
    assert.equal(g.draws, 1);
    assert.deepEqual(g.calls.filter((c) => Array.isArray(c))[0], ['drawImage', 0, 0, 300, 200]);
});

test('只有局部变形：平的格子各一次裁剪，不再按 n×n 细分', () => {
    const g = fakeCtx();
    // 3×3 网格只有中心顶点偏移：贴着它的 4 个格子有 twist，其余 5 个格子是平行四边形。
    paintWarped(g, IMG, latticeWith(3, 3, 4), SIZE, 6);
    // 平坦的 5 格各 1 次 clip；4 个变形格按 2×2 细分，每子格最多 2 次 clip。
    assert.ok(g.clips >= 5, `clips ${g.clips} 应至少覆盖 5 个平坦格子`);
    assert.ok(g.clips <= 5 + 4 * 4 * 2, `clips ${g.clips} 超出预期上限`);
    assert.ok(g.draws >= 5, `draws ${g.draws} 至少每格一次`);
});

test('草稿模式：每格一次裁剪 + 一次 drawImage（不再细分）', () => {
    const g = fakeCtx();
    paintWarped(g, IMG, latticeWith(3, 3, 4), SIZE, 1, true);
    assert.equal(g.clips, 9);
    assert.equal(g.draws, 9);
});

test('整格纯平移（平行四边形）：一次裁剪 + 一次 drawImage', () => {
    const g = fakeCtx();
    // 1×1 网格四角同向平移 = 平行四边形，twist 为 0 → 整格走快路径。
    // 注意 pts 是行优先：pts[0]=(u0,v0) pts[1]=(u1,v0) pts[2]=(u0,v1) pts[3]=(u1,v1)。
    const lat = createLattice(1, 1);
    lat.pts = [[-8, -4], [8, -4], [-8, 4], [8, 4]];
    paintWarped(g, IMG, lat, SIZE, 6);
    assert.equal(g.clips, 1);
    assert.equal(g.draws, 1);
});

test('1×1 网格四角交叉偏移：twist 不为零，必须退回细分成三角形', () => {
    const g = fakeCtx();
    const lat = createLattice(1, 1);
    lat.pts = [[-8, -4], [8, -4], [8, 4], [-8, 4]];
    paintWarped(g, IMG, lat, SIZE, 6);
    assert.ok(g.clips > 1, `交叉偏移应细分，实际 clips=${g.clips}`);
    assert.equal(g.draws, g.clips);
});
