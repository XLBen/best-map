import { describe, expect, it } from 'vitest';

import { type WorldType } from './generate';
import { buildMesh } from './mesh';
import { terrainStats } from './stats';
import { chainIslands, combineStamps, islandStamp, landStroke, previewLand, resolveTerrain, strokeProfile } from './terrain';
import { createWorld } from './world';
import { seededEngine } from './testing/fixtures';

const fine = buildMesh(40000, 2, 1);
const coarse = buildMesh(4000, 2, 1);

function generated(type: WorldType, seed: number, mesh = fine, extra: Record<string, number> = {}) {
  const w = createWorld({ cells: mesh.n, seed: 1 }, mesh);
  w.small.terrain.gen = { seed, type, mountains: 1, rerolls: [], ...extra };
  resolveTerrain(w);
  return w;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
};

describe('生成的地形符合真实世界的分布规律', () => {
  // 第一版生成器在同样条件下：陆块 4–10 块，最大陆块占 45–94%，海岸粗糙度 4.9–6.4（均值约 5.6）
  const seeds = [1, 2, 3, 4, 5, 6];

  it('几块大陆：陆块多、最大陆块不过七成、海岸更曲折、岛的大小呈幂律', () => {
    const stats = seeds.map((s) => terrainStats(generated('continents', s)));
    expect(median(stats.map((s) => s.landmasses))).toBeGreaterThanOrEqual(30);
    expect(Math.max(...stats.map((s) => s.largestShare))).toBeLessThan(0.7);
    const rough = stats.reduce((a, s) => a + s.coastRoughness, 0) / stats.length;
    // 第十三轮修：陆地围住的小块海（6 格以内）并回陆地，少了它们的海岸，均值从约 8.45 降到约 8.35
    // 第三十二轮：大陆上的裂谷多半不再下陷成窄海（成了裂谷湖），海岸短了一些，约 7.85
    expect(rough).toBeGreaterThanOrEqual(5.6 * 1.38);
    const k = median(stats.map((s) => s.powerLawK).filter(Number.isFinite));
    expect(k).toBeGreaterThan(0.4);
    expect(k).toBeLessThan(1.2);
  });

  it('群岛之海：岛多', () => {
    const stats = seeds.map((s) => terrainStats(generated('archipelago', s)));
    expect(median(stats.map((s) => s.landmasses))).toBeGreaterThanOrEqual(60);
  });

  it('高程双峰：大陆与洋底之间的陆坡很少', () => {
    const w = generated('continents', 2);
    let shelfOrLand = 0;
    let abyss = 0;
    let slope = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      const L = w.causes.landness[i];
      if (L > -400) shelfOrLand++;
      else if (L < -3000) abyss++;
      else slope++;
    }
    expect(slope).toBeLessThan(Math.min(shelfOrLand, abyss));
  });
});

describe('可预期：滑块连续、缩略图即成品', () => {
  it('陆地比例调大时，原来的陆地一格不少', () => {
    for (const type of ['continents', 'archipelago', 'fragmented'] as WorldType[]) {
      for (const seed of [1, 2]) {
        const lo = generated(type, seed, fine, { landFraction: 0.2 });
        const hi = generated(type, seed, fine, { landFraction: 0.3 });
        for (let i = 0; i < fine.n; i++) if (lo.causes.land[i]) expect(hi.causes.land[i]).toBe(1);
      }
    }
  });

  it('“岛多少”只增减岛，不挪动大陆的海岸', () => {
    const few = generated('continents', 3, fine, { islands: 0.1 });
    const many = generated('continents', 3, fine, { islands: 0.9 });
    for (let i = 0; i < fine.n; i++) if (few.causes.land[i]) expect(many.causes.land[i]).toBe(1);
  });

  it('4000 格的缩略图与 4 万格的成品，陆海一致率 ≥ 90%', () => {
    for (const type of ['continents', 'archipelago', 'continent'] as WorldType[]) {
      const a = generated(type, 2, fine);
      const b = generated(type, 2, coarse);
      let agree = 0;
      let total = 0;
      for (let y = 0.01; y < 1; y += 0.02) {
        for (let x = 0.01; x < 2; x += 0.02) {
          total++;
          if (a.causes.land[fine.delaunay.find(x, y)] === b.causes.land[coarse.delaunay.find(x, y)]) agree++;
        }
      }
      expect(agree / total).toBeGreaterThanOrEqual(0.9);
    }
  });
});

describe('可预期：画笔与放岛所见即所得', () => {
  it('画陆地：画笔中心 70% 一定变陆地，画笔外一格不变', () => {
    const w = generated('ocean', 1, fine);
    const cx = 1;
    const cy = 0.5;
    const R = 0.06;
    const cells: number[] = [];
    const t: number[] = [];
    for (let i = 0; i < fine.n; i++) {
      const d = Math.hypot(fine.x[i] - cx, fine.y[i] - cy) / R;
      if (d <= 1) {
        cells.push(i);
        t.push(d);
      }
    }
    const before = w.causes.land.slice();
    const stroke = landStroke(w, cells, t, 'land');
    const preview = previewLand(w, stroke.cells, stroke.delta);
    stroke.cells.forEach((i, k) => (w.causes.landDelta[i] += stroke.delta[k]));
    resolveTerrain(w);
    const inStroke = new Set(cells);
    cells.forEach((i, k) => {
      if (t[k] <= 0.7) expect(w.causes.land[i]).toBe(1);
    });
    for (let i = 0; i < fine.n; i++) if (!inStroke.has(i)) expect(w.causes.land[i]).toBe(before[i]);
    // 预览的新增陆地 = 实际新增陆地
    const gained: number[] = [];
    for (let i = 0; i < fine.n; i++) if (w.causes.land[i] && !before[i]) gained.push(i);
    expect(new Set(preview.gained)).toEqual(new Set(gained));
    expect(strokeProfile(0.5, 1)).toBeGreaterThan(0);
  });

  it('在同一个位置、同一选项放岛，得到同一个岛；轮廓预览就是放完后的陆地', () => {
    const w = generated('ocean', 1, fine);
    const spec = { x: 0.8, y: 0.4, kind: 'continental' as const, size: 440, variant: 0 };
    const a = islandStamp(w, spec);
    const b = islandStamp(w, spec);
    expect(a).toEqual(b);
    expect(a.footprint.length).toBeGreaterThan(5);
    a.cells.forEach((i, k) => {
      w.causes.landDelta[i] += a.landDelta[k];
      w.causes.upliftDelta[i] += a.upliftDelta[k];
    });
    resolveTerrain(w);
    const land: number[] = [];
    for (let i = 0; i < fine.n; i++) if (w.causes.land[i]) land.push(i);
    expect(new Set(land)).toEqual(new Set(a.footprint));
    // 换个形状就不一样
    const c = islandStamp(generated('ocean', 1, fine), { ...spec, variant: 1 });
    expect(c.footprint).not.toEqual(a.footprint);
  });

  it('岛链：沿线排开、大小不一', () => {
    const w = generated('ocean', 1, fine);
    const islands = chainIslands(w, { points: [[0.3, 0.3], [1.2, 0.5], [1.7, 0.8]], kind: 'continental', size: 440, density: 1, variant: 0 });
    expect(islands.length).toBeGreaterThan(5);
    expect(new Set(islands.map((s) => s.size)).size).toBeGreaterThan(1);
    const r = combineStamps(w, islands);
    expect(r.footprint.length).toBeGreaterThan(islands.length * 3);
  });
});

describe('可预期：编辑只影响局部', () => {
  it('在一块大陆上画陆地，不相连的其他大陆上高程逐值不变', () => {
    const eng = seededEngine({ cells: 20000, seed: 1 });
    eng.exec({ op: 'set_worldgen', params: { seed: 2, type: 'continents' }, reset: true });
    const w = eng.world;
    const n = w.mesh.n;
    // 陆块编号
    const comp = new Int32Array(n).fill(-1);
    let id = 0;
    for (let i = 0; i < n; i++) {
      if (!w.causes.land[i] || comp[i] >= 0) continue;
      const q = [i];
      comp[i] = id;
      for (let h = 0; h < q.length; h++) {
        for (let e = w.mesh.off[q[h]]; e < w.mesh.off[q[h] + 1]; e++) {
          const j = w.mesh.adj[e];
          if (w.causes.land[j] && comp[j] < 0) {
            comp[j] = id;
            q.push(j);
          }
        }
      }
      id++;
    }
    // 在最大陆块的一个内陆格附近画一笔
    const sizes = new Map<number, number>();
    for (let i = 0; i < n; i++) if (comp[i] >= 0) sizes.set(comp[i], (sizes.get(comp[i]) ?? 0) + 1);
    const biggest = [...sizes].sort((a, b) => b[1] - a[1])[0][0];
    const center = [...Array(n).keys()].find((i) => comp[i] === biggest && w.causes.landness[i] > 300)!;
    const cells: number[] = [];
    const t: number[] = [];
    const R = 0.05;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(w.mesh.x[i] - w.mesh.x[center], w.mesh.y[i] - w.mesh.y[center]) / R;
      if (d <= 1) {
        cells.push(i);
        t.push(d);
      }
    }
    const before = Float32Array.from(w.derived.elevation);
    eng.exec({ op: 'paint_relief', cells, t, strength: 0.8 });
    let changedElsewhere = 0;
    for (let i = 0; i < n; i++) if (comp[i] >= 0 && comp[i] !== biggest && w.derived.elevation[i] !== before[i]) changedElsewhere++;
    expect(changedElsewhere).toBe(0);
  });

  it('地形编辑撤销后逐值复原', () => {
    const eng = seededEngine({ cells: 8000, seed: 1 });
    eng.exec({ op: 'set_worldgen', params: { seed: 5, type: 'archipelago' }, reset: true });
    const w = eng.world;
    const land = w.causes.land.slice();
    const elev = Float32Array.from(w.derived.elevation);
    eng.exec({ op: 'add_island', island: { x: 1.1, y: 0.55, kind: 'continental', size: 2000, variant: 0 } });
    eng.exec({ op: 'add_island_chain', chain: { points: [[0.2, 0.2], [0.6, 0.3]], kind: 'continental', size: 450, density: 1, variant: 0 } });
    eng.undo();
    eng.undo();
    expect(Array.from(w.causes.land)).toEqual(Array.from(land));
    expect(Array.from(w.derived.elevation)).toEqual(Array.from(elev));
  });

  it('滑块：只调参数时保留手工编辑', () => {
    const eng = seededEngine({ cells: 8000, seed: 1 });
    eng.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents' }, reset: true });
    eng.exec({ op: 'add_island', island: { x: 1.0, y: 0.5, kind: 'continental', size: 1000, variant: 0 } });
    const delta = Float32Array.from(eng.world.causes.landDelta);
    eng.exec({ op: 'set_worldgen', params: { ...eng.world.small.terrain.gen!, landFraction: 0.4 } });
    expect(Array.from(eng.world.causes.landDelta)).toEqual(Array.from(delta));
  });
});
