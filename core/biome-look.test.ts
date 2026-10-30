import { describe, expect, it } from 'vitest';
import {
  FX_SLOTS,
  GLOW_GAIN,
  PATTERN_MEAN,
  PATTERN_MEAN3,
  blendRgb,
  cellFx,
  fxPalette,
  fxSet,
  meanTint,
  patternFade,
  patternKind,
  patternSeed,
  patternValue,
  patternValue3,
  visualLook,
} from './biome-look';
import { hexToRgb } from './export';
import { mulberry32 } from './rng';
import { PATTERNS, type Pattern, type Species, type Visual } from './species';
import { rasterizeWorld } from './subcell';
import { continents, engineFor, snapshot } from './testing/fixtures';
import { renderThumbnail } from './thumbnail';
import type { World } from './world';

// 生态的花纹与发光（第三批）：花纹的平均值、算式确定且在 [0, 1]、外观的默认值、每格的花纹与发光、
// 缩略图（拉远时）的平均色与发光，与没有外观时逐字节相同

// 平面上的采样点（花纹单位）、球面上的采样点（半径 20–400 的球面）
function planeSamples(count: number, seed: number): [number, number][] {
  const r = mulberry32(seed);
  return Array.from({ length: count }, () => [(r() - 0.5) * 4000, (r() - 0.5) * 4000]);
}
function sphereSamples(count: number, seed: number): [number, number, number][] {
  const r = mulberry32(seed);
  return Array.from({ length: count }, () => {
    const u = 2 * r() - 1;
    const th = 2 * Math.PI * r();
    const R = 20 + 380 * r();
    const s = Math.sqrt(1 - u * u);
    return [R * s * Math.cos(th), R * s * Math.sin(th), R * u];
  });
}

const DRAWN = PATTERNS.filter((p) => p !== 'none');

describe('花纹的算式', () => {
  it('PATTERN_MEAN 与 64k 个采样的平均值相差不到 0.02（平面、星球各一份）', () => {
    const plane = planeSamples(65536, 7);
    const sphere = sphereSamples(65536, 8);
    for (const p of PATTERNS) {
      const m2 = plane.reduce((a, [x, y]) => a + patternValue(p, x, y), 0) / plane.length;
      const m3 = sphere.reduce((a, [x, y, z]) => a + patternValue3(p, x, y, z), 0) / sphere.length;
      expect(Math.abs(m2 - PATTERN_MEAN[p]), `平面 ${p}`).toBeLessThan(0.02);
      expect(Math.abs(m3 - PATTERN_MEAN3[p]), `星球 ${p}`).toBeLessThan(0.02);
    }
  });

  it('同一点每次算出同样的值，都在 [0, 1]，而且真有花纹（不是一片平的）', () => {
    const plane = planeSamples(4000, 11);
    const sphere = sphereSamples(4000, 12);
    for (const p of DRAWN) {
      const a = plane.map(([x, y]) => patternValue(p, x, y));
      const b = plane.map(([x, y]) => patternValue(p, x, y));
      const a3 = sphere.map(([x, y, z]) => patternValue3(p, x, y, z));
      const b3 = sphere.map(([x, y, z]) => patternValue3(p, x, y, z));
      expect(a, p).toEqual(b);
      expect(a3, p).toEqual(b3);
      // 都在 [0, 1]；有画满的地方，也有底色
      expect(a.every((v) => v >= 0 && v <= 1) && a3.every((v) => v >= 0 && v <= 1), p).toBe(true);
      expect(Math.max(...a), p).toBeGreaterThan(0.9);
      expect(Math.min(...a), p).toBe(0);
      expect(Math.max(...a3), p).toBeGreaterThan(0.9);
      expect(Math.min(...a3), p).toBe(0);
    }
    expect(patternValue('none', 3.3, 4.4)).toBe(0);
    expect(patternValue3('none', 3.3, 4.4, 5.5)).toBe(0);
  });

  it('花纹是连着的一片（相邻的点差不多），不是逐点的杂讯', () => {
    for (const p of ['mottle', 'spots', 'stripes'] as Pattern[]) {
      let diff = 0;
      const pts = planeSamples(2000, 13);
      for (const [x, y] of pts) diff += Math.abs(patternValue(p, x, y) - patternValue(p, x + 0.01, y));
      expect(diff / pts.length, p).toBeLessThan(0.05);
    }
  });

  it('拉远时淡成平均值，放大后画全；细的花纹要放得更大', () => {
    for (const p of DRAWN) {
      expect(patternFade(p, 0.5)).toBe(0);
      expect(patternFade(p, 1000)).toBe(1);
    }
    expect(patternFade('mottle', 6)).toBe(1);
    expect(patternFade('veins', 4)).toBe(0);
    expect(patternKind('none')).toBe(0);
    expect(DRAWN.map(patternKind)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

const sp = (id: string, color: string, visual?: Visual, seedKey?: string): Species => ({ id, name: id, color, terrain: 'plains', competition: 1, tolerances: [], ...(visual ? { visual } : {}), ...(seedKey ? { seedKey } : {}) });

describe('外观的默认值与调色板', () => {
  it('第二种颜色默认是基础色调暗 40%，发光颜色默认是基础色与白色各半；没有花纹也不发光时为 null', () => {
    const v = visualLook(sp('a', '#6496c8'), { pattern: 'mottle' }, false)!;
    expect(v.color2).toEqual([100 * 0.6, 150 * 0.6, 200 * 0.6]);
    expect(v.amount).toBe(0.6);
    expect(v.size).toBe(0.5);
    expect(v.glow).toBe(0);
    expect(v.glowColor).toEqual([(100 + 255) / 2, (150 + 255) / 2, (200 + 255) / 2]);
    expect(v.mean).toBe(PATTERN_MEAN.mottle);
    expect(visualLook(sp('a', '#6496c8'), { pattern: 'mottle' }, true)!.mean).toBe(PATTERN_MEAN3.mottle);
    expect(visualLook(sp('a', '#6496c8'), { pattern: 'none' }, false)).toBeNull();
    expect(visualLook(sp('a', '#6496c8'), { pattern: 'none', glow: 0 }, false)).toBeNull();
    expect(visualLook(sp('a', '#6496c8'), undefined, false)).toBeNull();
    // 只发光
    const g = visualLook(sp('a', '#6496c8'), { pattern: 'none', glow: 0.4, glowColor: '#ff8000' }, false)!;
    expect(g.glow).toBe(0.4);
    expect(g.glowColor).toEqual([255, 128, 0]);
  });

  it('种子按 seedKey（没有时按 id）：改了 id、seedKey 不变时花纹不变', () => {
    expect(patternSeed(sp('a', '#000000', undefined, 'k'))).toBe(patternSeed(sp('b-2', '#000000', undefined, 'k')));
    expect(patternSeed(sp('a', '#000000'))).toBe(patternSeed(sp('a', '#ffffff')));
    for (const s of ['a', 'b', 'crystal_jungle']) {
      const v = patternSeed(sp(s, '#000000'));
      expect(Number.isInteger(v) && v >= 0 && v < 256).toBe(true);
    }
  });

  it('调色板：每行三个纹素（第二种颜色与明显程度、发光颜色与强度、花纹编号大小平均值种子）；覆盖的外观按 id 换上', () => {
    const species = [sp('plain', '#808080'), sp('a', '#6496c8', { pattern: 'cracks', color2: '#102030', amount: 0.9, size: 2 }), sp('b', '#000000', { pattern: 'none', glow: 0.5, glowColor: '#ff0000' })];
    const set = fxSet(species, false)!;
    expect(Array.from(set.slotOf)).toEqual([-1, 0, 1]);
    const pal = fxPalette(set);
    expect(pal.length).toBe(256 * 3 * 4);
    expect(Array.from(pal.subarray(0, 12))).toEqual(
      Array.from(new Float32Array([16 / 255, 32 / 255, 48 / 255, 0.9, (100 + 255) / 2 / 255, (150 + 255) / 2 / 255, (200 + 255) / 2 / 255, 0, patternKind('cracks'), 2, PATTERN_MEAN.cracks, patternSeed(species[1])])),
    );
    expect(Array.from(pal.subarray(12, 24))).toEqual(Array.from(new Float32Array([0, 0, 0, 0.6, 1, 0, 0, 0.5, 0, 0.5, 0, patternSeed(species[2])])));
    // 没有外观的生态：没有调色板
    expect(fxSet([sp('plain', '#808080'), sp('x', '#123456', { pattern: 'none' })], false)).toBeNull();
    // 拖滑块时的覆盖：没有外观的也能临时画上；覆盖成没有花纹就不画
    const ov = fxSet(species, false, new Map<string, Visual>([['plain', { pattern: 'spots' }], ['a', { pattern: 'none' }]]))!;
    expect(Array.from(ov.slotOf)).toEqual([0, -1, 1]);
    expect(ov.looks[0].pattern).toBe('spots');
    // 最多 FX_SLOTS 种
    const many = Array.from({ length: FX_SLOTS + 5 }, (_, k) => sp(`s${k}`, '#808080', { pattern: 'mottle' }));
    const big = fxSet(many, false)!;
    expect(big.looks.length).toBe(FX_SLOTS);
    expect(big.slotOf[FX_SLOTS]).toBe(-1);
  });

  it('cellFx：花纹取份额最大的有花纹的生态，发光是份额 × 强度之和、颜色取贡献最大的', () => {
    const species = [
      sp('p1', '#808080', { pattern: 'mottle' }),
      sp('p2', '#808080', { pattern: 'stripes', glow: 0.2 }),
      sp('g', '#808080', { pattern: 'none', glow: 1 }),
      sp('plain', '#808080'),
    ];
    const set = fxSet(species, false)!;
    const out = new Float64Array(4);
    // 一格：p1 0.2、p2 0.3、g 0.1、plain 0.4
    cellFx(set, [0.2, 0.3, 0.1, 0.4], 0, 4, out);
    expect(out[0]).toBe(set.slotOf[1]);
    expect(out[1]).toBe(0.3);
    expect(out[2]).toBeCloseTo(0.3 * 0.2 + 0.1 * 1, 12);
    expect(out[3]).toBe(set.slotOf[2]);
    // 只有没外观的生态：都没有
    cellFx(set, [0, 0, 0, 1], 0, 4, out);
    expect(Array.from(out)).toEqual([-1, 0, 0, -1]);
    // 平均色：份额、明显程度、平均值、没被盖住的部分相乘
    cellFx(set, [0.5, 0, 0, 0.5], 0, 4, out);
    const c: [number, number, number] = [100, 100, 100];
    meanTint(set, out, 0.5, c);
    const t = PATTERN_MEAN.mottle * 0.6 * 0.5 * 0.5;
    expect(c[0]).toBeCloseTo(100 + (128 * 0.6 - 100) * t, 10);
  });
});

// ---------- 缩略图 ----------

const W = 240;
const H = 120;
const small = () => continents({ cells: 5000 }).world;
// 一个世界的副本：生态换成 change 给的
const withSpecies = (w: World, change: (s: Species) => Species): World => ({ ...w, small: { ...w.small, species: w.small.species.map(change) } });
// 份额最多的生态
function mostCommon(w: World): number {
  const S = w.small.species.length;
  const sum = new Float64Array(S);
  for (let i = 0; i < w.mesh.n; i++) for (let s = 0; s < S; s++) sum[s] += w.derived.share[i * S + s];
  return sum.indexOf(Math.max(...sum));
}

describe('缩略图里的生态外观', () => {
  it('没有外观、没有颜色脚本：与以前逐字节相同（花纹那段整个跳过）', () => {
    const w = small();
    const a = renderThumbnail(w, W, H);
    // 外观是“没有花纹也不发光”的：同样跳过
    const b = renderThumbnail(withSpecies(w, (s) => ({ ...s, visual: { pattern: 'none' } })), W, H);
    expect(Array.from(b)).toEqual(Array.from(a));
  });

  it('花纹按拉远时的平均色画：份额 × 明显程度 × 平均值 混向第二种颜色（雪盖住的不画）', () => {
    const w = small();
    const s = mostCommon(w);
    const id = w.small.species[s].id;
    const S = w.small.species.length;
    const plain = renderThumbnail(w, W, H);
    const tinted = renderThumbnail(withSpecies(w, (x) => (x.id === id ? { ...x, visual: { pattern: 'mottle', color2: '#000000', amount: 1 } } : x)), W, H);
    const r = rasterizeWorld(w, W, H);
    let darker = 0;
    let off = 0;
    for (let p = 0; p < W * H; p++) {
      const c = r.cell[p];
      // 海、湖不变（第三十四轮：小湖群画成湖的颜色，也不变）
      if (!r.land[p] || w.derived.lake[c] === 1 || r.lakeDot[p]) {
        for (let k = 0; k < 4; k++) off = Math.max(off, Math.abs(tinted[p * 4 + k] - plain[p * 4 + k]));
        continue;
      }
      const snow = w.derived.tWarm[c] < 0 ? Math.min(1, -w.derived.tWarm[c] / 6) : 0;
      const cover = w.derived.lake[c] === 2 ? 0 : 1 - snow;
      // 第二种颜色是黑色：亮度乘上 1 − t（四舍五入差一点）
      const t = PATTERN_MEAN.mottle * w.derived.share[c * S + s] * cover;
      for (let k = 0; k < 3; k++) off = Math.max(off, Math.abs(tinted[p * 4 + k] - plain[p * 4 + k] * (1 - t)));
      if (t > 0.05) darker++;
    }
    expect(off).toBeLessThanOrEqual(1.01);
    expect(darker).toBeGreaterThan(100);
  });

  it('发光加在晕渲之后：亮度加上 发光颜色 × 份额 × 强度 × 0.6', () => {
    const w = small();
    const s = mostCommon(w);
    const id = w.small.species[s].id;
    const S = w.small.species.length;
    const plain = renderThumbnail(w, W, H);
    const glow = renderThumbnail(withSpecies(w, (x) => (x.id === id ? { ...x, visual: { pattern: 'none', glow: 1, glowColor: '#ffffff' } } : x)), W, H);
    const r = rasterizeWorld(w, W, H);
    let brighter = 0;
    let bad = 0;
    for (let p = 0; p < W * H; p++) {
      const c = r.cell[p];
      if (!r.land[p] || w.derived.lake[c] === 1 || r.lakeDot[p]) continue;
      const add = 255 * (Math.round(255 * w.derived.share[c * S + s]) / 255) * GLOW_GAIN;
      // 海岸线上的像素整体乘 0.72（发光也一起乘），其他像素直接加
      for (let k = 0; k < 3; k++) {
        const near = (x: number) => Math.abs(glow[p * 4 + k] - Math.min(255, plain[p * 4 + k] + x)) <= 1.01;
        if (!near(add) && !near(add * 0.72)) bad++;
      }
      if (add > 20) brighter++;
    }
    expect(bad).toBe(0);
    expect(brighter).toBeGreaterThan(100);
  });

  it('有颜色脚本算好的 d.look 时用它当植被颜色', () => {
    const w = small();
    // 所有生态同一种颜色的世界，与 look 是那个颜色混出来的世界：缩略图相同
    const same = withSpecies(w, (x) => ({ ...x, color: '#c83c28' }));
    const colors = same.small.species.map((x) => hexToRgb(x.color));
    const look = new Uint8Array(w.mesh.n * 4);
    for (let i = 0; i < w.mesh.n; i++) {
      if (!w.causes.land[i] || w.derived.lake[i] === 1) continue;
      const c = blendRgb(w.derived.share, i, colors);
      look.set([Math.round(c[0]), Math.round(c[1]), Math.round(c[2]), 255], i * 4);
    }
    const a = renderThumbnail(same, W, H);
    const b = renderThumbnail({ ...w, derived: { ...w.derived, look } }, W, H);
    let off = 0;
    for (let k = 0; k < a.length; k++) off = Math.max(off, Math.abs(a[k] - b[k]));
    expect(off).toBeLessThanOrEqual(1);
    // 而且确实与原来的颜色不同
    expect(Array.from(b)).not.toEqual(Array.from(renderThumbnail(w, W, H)));
  });

  it('整个星球：平均值用星球的那一份', () => {
    const eng = snapshot('look-globe', () => {
      const e = engineFor({ cells: 3000, seed: 1, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
      e.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents', landFraction: 0.4 }, reset: true });
      return e;
    });
    const w = eng.world;
    expect(w.mesh.kind).toBe('sphere');
    const set = fxSet(withSpecies(w, (x) => ({ ...x, visual: { pattern: 'cracks' } })).small.species, true)!;
    expect(set.looks.every((v) => v.mean === PATTERN_MEAN3.cracks)).toBe(true);
    const s = mostCommon(w);
    const id = w.small.species[s].id;
    const a = renderThumbnail(w, W, H);
    const b = renderThumbnail(withSpecies(w, (x) => (x.id === id ? { ...x, visual: { pattern: 'cracks', color2: '#000000', amount: 1 } } : x)), W, H);
    let darker = 0;
    for (let p = 0; p < W * H; p++) if (b[p * 4] < a[p * 4] - 2) darker++;
    expect(darker).toBeGreaterThan(50);
  });
});
