import { describe, expect, it } from 'vitest';
import { type ChainSpec, chainIslands, chainStyle, combineStamps } from './terrain';
import { engineFor } from './testing/fixtures';

// 岛链的“换个排列”（第十二轮）：第 0 种照旧均匀排开，之后几种的间距、成团、个数明显不同

describe('岛链的排列', () => {
  const w = engineFor({ cells: 8000, seed: 1 }).world;
  const cellKm = w.mesh.spacing * w.kmPerUnit;
  const spec = (variant: number): ChainSpec => ({ points: [[0.3, 0.6], [1.6, 0.6]], kind: 'volcanic', size: 2.5 * cellKm, density: 1, variant });
  // 沿线（横向）排好的位置与相邻的间距
  const layout = (variant: number) => {
    const xs = chainIslands(w, spec(variant))
      .map((s) => s.x)
      .sort((a, b) => a - b);
    const gaps = xs.slice(1).map((x, k) => x - xs[k]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const cv = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length) / mean;
    return { xs, gaps, cv, count: xs.length };
  };

  it('第 0 种均匀排开（间距几乎一样）；之后几种轮着换，间距明显忽大忽小、或个数不同', () => {
    expect(chainStyle(0)).toBe('even');
    expect([1, 2, 3, 4, 5].map(chainStyle)).toEqual(['jitter', 'clusters', 'taper', 'random', 'jitter']);
    const even = layout(0);
    expect(even.cv).toBeLessThan(0.05);
    for (const v of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const l = layout(v);
      expect(l.count).toBeGreaterThan(0);
      // 间距的变化系数比均匀排开大得多，或个数不同
      expect(l.cv > 0.25 || l.count !== even.count, `第 ${v} 种`).toBe(true);
      // 与上一种不一样
      expect(l.xs).not.toEqual(layout(v - 1).xs);
    }
  });

  it('成团：有的间距只有均匀排开时的一半以下，也有比它大得多的空当', () => {
    const even = layout(0);
    const step = even.gaps[0];
    const c = layout(2);
    expect(Math.min(...c.gaps)).toBeLessThan(step * 0.6);
    expect(Math.max(...c.gaps)).toBeGreaterThan(step * 1.5);
  });

  it('由大到小：一头的岛明显比另一头大', () => {
    const islands = chainIslands(w, spec(3)).sort((a, b) => a.x - b.x);
    const first = islands[0].size;
    const last = islands[islands.length - 1].size;
    expect(Math.max(first, last) / Math.min(first, last)).toBeGreaterThan(2);
  });

  it('同一种排列结果固定', () => {
    for (const v of [0, 1, 2, 3, 4]) expect(chainIslands(w, spec(v))).toEqual(chainIslands(w, spec(v)));
  });

  it('换个排列时陆地的总量大致不变（岛的面积之和在第 0 种的 ±25% 以内）', () => {
    const area = (v: number) => chainIslands(w, spec(v)).reduce((a, s) => a + s.size * s.size, 0);
    const a0 = area(0);
    for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const r = area(v) / a0;
      expect(r, `第 ${v} 种`).toBeGreaterThan(0.75);
      expect(r, `第 ${v} 种`).toBeLessThan(1.25);
    }
  });
});

describe('岛链不并进原有的岛', () => {
  it('线穿过原有的岛：岛心不在陆地上，放出来的岛不挨着原有的陆地', () => {
    const eng = engineFor({ cells: 8000, seed: 1 });
    const w = eng.world;
    const cellKm = w.mesh.spacing * w.kmPerUnit;
    eng.exec({ op: 'add_island', island: { x: 0.95, y: 0.6, kind: 'volcanic', size: 3 * cellKm, variant: 0 } });
    const before = Uint8Array.from(eng.world.causes.land);
    expect(before.some((v) => v === 1)).toBe(true);
    for (const variant of [0, 1, 2, 3, 4, 5]) {
      const chain: ChainSpec = { points: [[0.3, 0.6], [1.6, 0.6]], kind: 'volcanic', size: 2.5 * cellKm, density: 1, variant };
      const islands = chainIslands(eng.world, chain);
      expect(islands.length).toBeGreaterThan(2);
      const st = combineStamps(eng.world, islands);
      const { off, adj } = eng.world.mesh;
      for (const i of st.footprint) {
        if (before[i]) continue;
        for (let e = off[i]; e < off[i + 1]; e++) expect(before[adj[e]], `第 ${variant} 种：格 ${i} 挨着原有的岛`).toBe(0);
      }
    }
  });
});
