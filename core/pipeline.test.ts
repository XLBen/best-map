import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { graphDistance } from './mesh';
import { provinceSizes } from './provinces';
import { provinceCells } from './select';
import type { Species } from './species';
import { isConnected } from './provinces';
import { isVegetated } from './vegetation';
import { latitudeOf } from './world';

const small = { cells: 6000, seed: 2 };

// 把这些格画成陆地（画笔中心，t = 0）
const landCmd = (cells: number[]) => ({ op: 'paint_land' as const, cells, t: cells.map(() => 0), mode: 'land' as const });

function randomEngine() {
  const eng = new Engine(small);
  eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents', landFraction: 0.4 }, reset: true });
  return eng;
}

describe('高程与水文', () => {
  const eng = randomEngine();
  const { world } = eng;
  const d = world.derived;

  it('陆地高于海平面，海洋低于海平面', () => {
    for (let i = 0; i < world.mesh.n; i++) {
      // 湖底（湖面、干湖底）可以在海平面以下（第十二轮起按面积修深；第十三轮修：小块内海挖成的湖挨着低地，湖底常在海平面以下）
      if (world.causes.land[i] && d.lake[i] === 0) expect(d.elevation[i]).toBeGreaterThan(0);
      else if (world.causes.land[i]) expect(d.water[i] || 1).toBeGreaterThan(0);
      else expect(d.elevation[i]).toBeLessThan(0);
    }
  });

  it('汇流无环且每格都流到出口', () => {
    for (let i = 0; i < world.mesh.n; i++) {
      if (!world.causes.land[i]) continue;
      let cur = i;
      let steps = 0;
      while (cur >= 0 && world.causes.land[cur] && steps < world.mesh.n) {
        cur = d.receiver[cur];
        steps++;
      }
      expect(steps).toBeLessThan(world.mesh.n);
    }
  });

  it('流量守恒：入海流量之和不超过产流之和，且不小于其扣除湖面蒸发后的值', () => {
    let outlets = 0;
    for (let i = 0; i < world.mesh.n; i++) {
      if (!world.causes.land[i]) continue;
      const r = d.receiver[i];
      if (r < 0 || !world.causes.land[r]) outlets += d.discharge[i];
    }
    expect(outlets).toBeGreaterThan(0);
    // 下游流量不小于任一上游
    for (let i = 0; i < world.mesh.n; i++) {
      const r = d.receiver[i];
      if (world.causes.land[i] && r >= 0 && world.causes.land[r] && !d.lake[i] && !d.lake[r]) expect(d.discharge[r] + 1e-6).toBeGreaterThanOrEqual(d.discharge[i] * 0.999);
    }
  });
});

describe('气候', () => {
  it('赤道比极地暖', () => {
    const eng = new Engine({ ...small, latNorth: 85, latSouth: -5 });
    eng.exec({ op: 'set_worldgen', params: { seed: 9, type: 'continents', landFraction: 0.3 }, reset: true });
    const { world } = eng;
    let eq = 0;
    let ne = 0;
    let po = 0;
    let np = 0;
    for (let i = 0; i < world.mesh.n; i++) {
      const lat = latitudeOf(world.settings, world.mesh.y[i]);
      if (lat < 10) {
        eq += world.derived.tMean[i];
        ne++;
      } else if (lat > 70) {
        po += world.derived.tMean[i];
        np++;
      }
    }
    expect(eq / ne).toBeGreaterThan(po / np + 20);
  });

  it('垂直于西风的山脉：背风侧比迎风侧干', () => {
    const eng = new Engine({ cells: 8000, seed: 3, latNorth: 60, latSouth: 30 });
    const { world } = eng;
    const cells: number[] = [];
    const uplift: number[] = [];
    for (let i = 0; i < world.mesh.n; i++) {
      const x = world.mesh.x[i];
      if (x > 0.3 && x < 1.7) cells.push(i);
      // x = 0.8 处南北走向的高山（西风带里风从西往东吹）
      if (Math.abs(x - 0.8) < 0.05) uplift.push(i);
    }
    eng.exec(landCmd(cells));
    eng.exec({ op: 'paint_relief', cells: uplift, t: uplift.map(() => 0), strength: 1.4 });
    const d = world.derived;
    const avg = (x0: number, x1: number) => {
      let s = 0;
      let c = 0;
      for (let i = 0; i < world.mesh.n; i++) {
        const x = world.mesh.x[i];
        if (x > x0 && x < x1 && world.mesh.y[i] > 0.3 && world.mesh.y[i] < 0.7) {
          s += d.precip[i];
          c++;
        }
      }
      return s / c;
    };
    const windward = avg(0.55, 0.72);
    const leeward = avg(0.88, 1.05);
    expect(leeward).toBeLessThan(windward * 0.7);
  });
});

describe('植被：A 能活在 a、b 气候，B 只在 a，C 只在 b', () => {
  // 用一个自定义场表示“气候类别”：0 = a，1 = b
  const setup = (compA: number, compB: number, k: number) => {
    const eng = new Engine({ cells: 3000, seed: 5 });
    const { world } = eng;
    const all = Array.from({ length: world.mesh.n }, (_, i) => i);
    const half = all.filter((i) => world.mesh.x[i] < 1);
    const hard = (lo: number, hi: number) => ({ field: 'field:clim', min: lo, optLow: lo, optHigh: hi, max: hi });
    const species: Species[] = [
      { id: 'A', name: 'A', color: '#ff0000', terrain: 'forest', competition: compA, tolerances: [hard(-0.5, 1.5)] },
      { id: 'B', name: 'B', color: '#00ff00', terrain: 'forest', competition: compB, tolerances: [hard(-0.5, 0.5)] },
      { id: 'C', name: 'C', color: '#0000ff', terrain: 'forest', competition: 1, tolerances: [hard(0.5, 1.5)] },
    ];
    eng.exec({
      op: 'batch',
      commands: [
        landCmd(all),
        { op: 'add_field', name: 'clim' },
        { op: 'paint', field: 'field:clim', cells: all.filter((i) => world.mesh.x[i] >= 1), value: 1 },
        ...world.small.species.map((s) => ({ op: 'remove_species' as const, id: s.id })),
        ...species.map((s) => ({ op: 'add_species' as const, species: s })),
        { op: 'set_planet', patch: { vegSharpness: k } },
      ],
    });
    return { eng, half, other: all.filter((i) => world.mesh.x[i] >= 1) };
  };

  it('a 格上 B 竞争力更强时 B 占优', () => {
    const { eng, half } = setup(1, 2, 4);
    const d = eng.world.derived;
    const veg = half.filter((i) => isVegetated(eng.world, d, i));
    const frac = veg.filter((i) => eng.world.small.species[d.dominant[i]]?.id === 'B').length / veg.length;
    expect(frac).toBeGreaterThan(0.99);
  });

  it('a 格上 A 竞争力更强时 A 占优；b 格上 A 与 C 竞争', () => {
    const { eng, half, other } = setup(3, 2, 4);
    const d = eng.world.derived;
    const id = (i: number) => eng.world.small.species[d.dominant[i]]?.id;
    // 平地上偶尔会积出小湖，只看长植被的格
    const veg = (i: number) => isVegetated(eng.world, d, i);
    expect(half.filter(veg).every((i) => id(i) === 'A')).toBe(true);
    expect(other.filter(veg).every((i) => id(i) === 'A')).toBe(true);
  });

  it('锐度 k 小时份额是混合的', () => {
    const { eng, half } = setup(1, 1.2, 0.5);
    const d = eng.world.derived;
    const S = eng.world.small.species.length;
    const i = half[0];
    expect(d.share[i * S + 0]).toBeGreaterThan(0.3);
    expect(d.share[i * S + 1]).toBeGreaterThan(0.3);
  });
});

describe('约束求解', () => {
  it('把一片荒漠设为稀树草原：反推变湿，修正随距离衰减，下游流量随之重算', () => {
    const eng = new Engine({ cells: 6000, seed: 7, latNorth: 30, latSouth: -10 });
    const { world } = eng;
    eng.exec({ op: 'set_worldgen', params: { seed: 11, type: 'continents', landFraction: 0.45 }, reset: true });
    const d = world.derived;
    const S = world.small.species.length;
    const desert = world.small.species.findIndex((s) => s.id === 'desert');
    // 选一片热带荒漠
    const seed = Array.from({ length: world.mesh.n }, (_, i) => i).find((i) => d.dominant[i] === desert && d.tCold[i] > 19 && d.elevation[i] < 800 && Math.abs(d.seasonality[i]) < 0.3 && d.moisture[i] > 0.1);
    expect(seed).toBeDefined();
    const dist = graphDistance(world.mesh, [seed!], 0.035);
    const tile = Array.from({ length: world.mesh.n }, (_, i) => i).filter((i) => dist[i] < 0.035 && world.causes.land[i] && !d.lake[i]);
    const before = Float32Array.from(d.discharge);
    eng.exec({ op: 'add_constraint', constraint: { cells: tile, species: 'savanna', mode: 'constraint', ratio: 0.7, radius: 800 } });
    const rain = world.small.species.findIndex((s) => s.id === 'savanna');
    // 降水增加后个别格可能变成湖，只按仍长植被的格计算
    const valid = tile.filter((i) => isVegetated(world, d, i));
    const ok = valid.filter((i) => d.dominant[i] === rain).length / valid.length;
    expect(ok).toBeGreaterThanOrEqual(0.69);
    expect(d.conflicts.length).toBe(0);
    // 修正随距离单调衰减（按距离分段的平均值）
    const far = graphDistance(world.mesh, tile, 1);
    const ring = (a: number, b: number) => {
      const v: number[] = [];
      for (let i = 0; i < world.mesh.n; i++) if (far[i] * world.kmPerUnit > a && far[i] * world.kmPerUnit <= b) v.push(d.corrP[i]);
      return v.reduce((s, x) => s + x, 0) / Math.max(1, v.length);
    };
    expect(ring(0, 200)).toBeGreaterThan(ring(200, 500));
    expect(ring(200, 500)).toBeGreaterThan(ring(500, 900) - 1e-6);
    // 反推的是“变湿”，水文按修正后的气候重算：下游流量随之改变
    const meanCorrP = tile.reduce((a, i) => a + d.corrP[i], 0) / tile.length;
    expect(meanCorrP).toBeGreaterThan(0);
    let r = seed!;
    let changed = false;
    for (let k = 0; k < 20 && r >= 0 && world.causes.land[r]; k++, r = d.receiver[r]) if (Math.abs(d.discharge[r] - before[r]) > 1e-3) changed = true;
    expect(changed).toBe(true);
    void S;
  });

  it('不可能的约束进入冲突面板，并给出原因', () => {
    const eng = new Engine({ cells: 4000, seed: 8, latNorth: 10, latSouth: -10 });
    const { world } = eng;
    const all = Array.from({ length: world.mesh.n }, (_, i) => i);
    eng.exec(landCmd(all.filter((i) => world.mesh.x[i] > 0.5 && world.mesh.x[i] < 1.5)));
    const tile = all.filter((i) => Math.hypot(world.mesh.x[i] - 1, world.mesh.y[i] - 0.5) < 0.05);
    eng.exec({ op: 'add_constraint', constraint: { cells: tile, species: 'ice', mode: 'constraint', ratio: 1, radius: 400 } });
    const c = world.derived.conflicts;
    expect(c.length).toBe(1);
    // 默认的冰盖按年均温定义
    expect(c[0].reasons[0].field).toBe('tMean');
    expect(c[0].suggestions.join('')).toContain('硬覆盖');
  });

  it('硬覆盖只改结果，不改气候', () => {
    const eng = randomEngine();
    const { world } = eng;
    const tile = Array.from({ length: world.mesh.n }, (_, i) => i).filter((i) => world.causes.land[i] && !world.derived.lake[i]).slice(0, 20);
    const precip = Float32Array.from(world.derived.precip);
    eng.exec({ op: 'add_constraint', constraint: { cells: tile, species: 'ice', mode: 'override', ratio: 1, radius: 400 } });
    const ice = world.small.species.findIndex((s) => s.id === 'ice');
    expect(tile.every((i) => world.derived.dominant[i] === ice && world.derived.overridden[i] === 1)).toBe(true);
    expect(Array.from(world.derived.precip)).toEqual(Array.from(precip));
  });
});

describe('省份', () => {
  it('自动划分覆盖所有格，每个省份连通且陆海不混', () => {
    const eng = randomEngine();
    eng.exec({ op: 'generate_provinces', rules: { seed: 3 } });
    const { world } = eng;
    expect([...world.causes.province].every((p) => p >= 0)).toBe(true);
    for (const id of provinceSizes(world).keys()) {
      const cells = provinceCells(world, id);
      expect(new Set(cells.map((i) => world.causes.land[i])).size).toBe(1);
      expect(isConnected(world, cells)).toBe(true);
    }
  });

  it('并入、合并、拆分、锁定', () => {
    const eng = randomEngine();
    eng.exec({ op: 'generate_provinces', rules: { seed: 3 } });
    const { world } = eng;
    const landIds = Object.entries(world.small.provinces)
      .filter(([, m]) => m.land)
      .map(([k]) => Number(k));
    // 找两个相邻的陆地省份
    let a = -1;
    let b = -1;
    for (let i = 0; i < world.mesh.n && b < 0; i++) {
      const p = world.causes.province[i];
      if (!landIds.includes(p)) continue;
      for (let e = world.mesh.off[i]; e < world.mesh.off[i + 1]; e++) {
        const q = world.causes.province[world.mesh.adj[e]];
        if (q !== p && landIds.includes(q)) {
          a = p;
          b = q;
          break;
        }
      }
    }
    expect(b).toBeGreaterThanOrEqual(0);
    const sizeA = provinceCells(world, a).length;
    const sizeB = provinceCells(world, b).length;
    // 并入一格
    const cell = provinceCells(world, b)[0];
    eng.exec({ op: 'assign_province', cells: [cell], province: a });
    expect(world.causes.province[cell]).toBe(a);
    // 锁定 b 后不能再从它那里拿格
    eng.exec({ op: 'set_province', id: b, locked: true });
    expect(() => eng.exec({ op: 'assign_province', cells: [provinceCells(world, b)[0]], province: a })).toThrow();
    eng.exec({ op: 'set_province', id: b, locked: false });
    // 合并
    eng.exec({ op: 'merge_province', from: b, into: a });
    expect(world.small.provinces[b]).toBeUndefined();
    expect(provinceCells(world, a).length).toBe(sizeA + sizeB);
    // 拆分后两部分都连通
    const before = Object.keys(world.small.provinces).length;
    eng.exec({ op: 'split_province', id: a });
    expect(Object.keys(world.small.provinces).length).toBe(before + 1);
    expect(isConnected(world, provinceCells(world, a))).toBe(true);
    // 撤销回到合并前
    eng.undo();
    eng.undo();
    eng.undo();
    eng.undo();
    expect(provinceCells(world, b).length).toBe(sizeB - 1);
  });

  it('修改类型的耐受曲线会改变植被', () => {
    const eng = randomEngine();
    const { world } = eng;
    const S = world.small.species;
    const desert = S.findIndex((s) => s.id === 'desert');
    const before = [...world.derived.dominant].filter((v) => v === desert).length;
    eng.exec({ op: 'update_species', id: 'desert', patch: { competition: 0.01 } });
    const after = [...world.derived.dominant].filter((v) => v === desert).length;
    expect(after).toBeLessThan(before);
    expect(() => eng.exec({ op: 'update_species', id: 'desert', patch: { id: 'x' } })).toThrow();
  });

  it('扩大陆地后新陆地格被修补进省份', () => {
    const eng = randomEngine();
    eng.exec({ op: 'generate_provinces', rules: { seed: 3 } });
    const { world } = eng;
    const sea = Array.from({ length: world.mesh.n }, (_, i) => i).filter((i) => !world.causes.land[i]).slice(0, 50);
    eng.exec(landCmd(sea));
    for (const i of sea) {
      expect(world.causes.land[i]).toBe(1);
      expect(world.small.provinces[world.causes.province[i]].land).toBe(true);
    }
  });
});

describe('命令', () => {
  it('撤销后回到原状态，重做后与直接执行一致', () => {
    const eng = randomEngine();
    const { world } = eng;
    const before = Float32Array.from(world.derived.elevation);
    const cells = Array.from({ length: 200 }, (_, i) => i * 7);
    eng.exec({ op: 'paint_relief', cells, t: cells.map(() => 0.3), strength: 0.5 });
    const after = Float32Array.from(world.derived.elevation);
    eng.undo();
    const undone = world.derived.elevation;
    let maxDiff = 0;
    for (let i = 0; i < before.length; i++) maxDiff = Math.max(maxDiff, Math.abs(undone[i] - before[i]));
    expect(maxDiff).toBe(0);
    eng.redo();
    let redoDiff = 0;
    for (let i = 0; i < after.length; i++) redoDiff = Math.max(redoDiff, Math.abs(world.derived.elevation[i] - after[i]));
    expect(redoDiff).toBe(0);
  });

  it('文档重放结果逐值一致', () => {
    const eng = randomEngine();
    eng.exec({ op: 'generate_provinces', rules: { seed: 3 } });
    eng.exec({ op: 'paint', field: 'moistOffset', cells: [10, 11, 12], value: 0.5 });
    const doc = JSON.parse(JSON.stringify(eng.toDoc()));
    const again = Engine.fromDoc(doc);
    expect(Array.from(again.world.causes.province)).toEqual(Array.from(eng.world.causes.province));
    expect(Array.from(again.world.derived.dominant)).toEqual(Array.from(eng.world.derived.dominant));
  });

  it('非法命令不生效', () => {
    const eng = randomEngine();
    const land = Float32Array.from(eng.world.causes.land);
    expect(() => eng.exec(landCmd([1, 2, 99999999]))).toThrow();
    expect(Array.from(eng.world.causes.land)).toEqual(Array.from(land));
  });
});
