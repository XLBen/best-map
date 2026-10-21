import { unzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { lakeArea } from './elevation';
import { endemicSpecies } from './endemic';
import { Engine } from './engine';
import { continents as sharedContinents } from './testing/fixtures';
import { exportPackage } from './export';
import { provinceSizes } from './provinces';
import { isRiverCell, planRiver, provinceCells } from './select';
import { DEFAULT_SPECIES, speciesRect, withRect } from './species';
import { isVegetated } from './vegetation';
import type { World } from './world';

// 第二轮迭代的编辑规则：省份可配置且稳定、地名不乱跳、画河与放湖所见即所得、
// 涂生态“涂到的就是”、岛屿特有生态、导出地名表

const continents = (cells = 12000, latNorth = 72, latSouth = 20) => sharedContinents({ cells, latNorth, latSouth });

const landCells = (w: World) => [...Array(w.mesh.n).keys()].filter((i) => isVegetated(w, w.derived, i));
const provinceSnapshot = (w: World) => {
  const out = new Map<number, string>();
  for (const id of provinceSizes(w).keys()) out.set(id, `${w.small.provinces[id]?.name}|${provinceCells(w, id).join(',')}`);
  return out;
};

describe('省份：规则可配置', () => {
  it('小 · 中 · 大：省份个数依次减少', () => {
    const eng = continents();
    const count = (size: 'small' | 'medium' | 'large') => {
      eng.exec({ op: 'generate_provinces', rules: { size, seed: 3 } });
      return Object.values(eng.world.small.provinces).filter((p) => p.land).length;
    };
    const s = count('small');
    const m = count('medium');
    const l = count('large');
    expect(s).toBeGreaterThan(m);
    expect(m).toBeGreaterThan(l);
  });

  it('无人区：打开时冰原与高山合成无人区省份，关掉就没有', () => {
    const eng = continents(12000, 85, 45);
    eng.exec({ op: 'generate_provinces', rules: { wasteland: true, seed: 3 } });
    const waste = Object.values(eng.world.small.provinces).filter((p) => p.kind === 'wasteland');
    expect(waste.length).toBeGreaterThan(0);
    eng.exec({ op: 'generate_provinces', rules: { wasteland: false, seed: 3 } });
    expect(Object.values(eng.world.small.provinces).some((p) => p.kind === 'wasteland')).toBe(false);
  });

  it('大湖单独成省', () => {
    const eng = continents();
    const w = eng.world;
    // 在内陆放一个大湖
    const inland = landCells(w).find((i) => w.derived.continentality[i] > 0.6 && w.derived.slope[i] < 5)!;
    eng.exec({ op: 'add_lake', lake: { cell: inland, radius: 120, depth: 150, perennial: true } });
    eng.exec({ op: 'generate_provinces', rules: { lakes: true, seed: 3 } });
    const lakeIds = Object.entries(w.small.provinces).filter(([, p]) => p.kind === 'lake').map(([k]) => Number(k));
    expect(lakeIds.length).toBeGreaterThan(0);
    // 湖省里全是湖面
    for (const id of lakeIds) expect(provinceCells(w, id).every((c) => w.derived.lake[c] === 1)).toBe(true);
  });

  it('近海的海域小，远洋的大', () => {
    const eng = continents();
    eng.exec({ op: 'generate_provinces', rules: { seaByDistance: true, seed: 3 } });
    const w = eng.world;
    const sizes = provinceSizes(w);
    const near: number[] = [];
    const far: number[] = [];
    for (const [id, size] of sizes) {
      const meta = w.small.provinces[id];
      if (!meta || meta.land) continue;
      const coastal = provinceCells(w, id).some((c) => {
        for (let e = w.mesh.off[c]; e < w.mesh.off[c + 1]; e++) if (w.causes.land[w.mesh.adj[e]]) return true;
        return false;
      });
      (coastal ? near : far).push(size);
    }
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    expect(far.length).toBeGreaterThan(0);
    expect(avg(far)).toBeGreaterThan(avg(near) * 1.3);
  });
});

describe('省份：自动划分也稳定', () => {
  it('重新划分一片：只动被涂到一大半的省份，别处的编号、名字、格子都不变', () => {
    const eng = continents();
    eng.exec({ op: 'generate_provinces', rules: { seed: 3 } });
    const w = eng.world;
    const target = Number(Object.entries(w.small.provinces).find(([, p]) => p.kind === 'land')![0]);
    const before = provinceSnapshot(w);
    const next = w.small.nextProvince;
    const cells = provinceCells(w, target);
    eng.exec({ op: 'regenerate_provinces', cells });
    const after = provinceSnapshot(w);
    for (const [id, snap] of before) if (id !== target) expect(after.get(id)).toBe(snap);
    expect(w.small.provinces[target]).toBeUndefined();
    // 原来的格子全部划进了新编号的省份
    const fresh = new Set(cells.map((c) => w.causes.province[c]));
    for (const id of fresh) expect(id).toBeGreaterThanOrEqual(next);
  });

  it('同样的规则划两次结果相同；“换一种划分”才变；锁定的省份不动', () => {
    const eng = continents();
    eng.exec({ op: 'generate_provinces', rules: { seed: 3 } });
    const w = eng.world;
    const first = Array.from(w.causes.province);
    eng.exec({ op: 'generate_provinces', rules: { seed: 3 } });
    expect(Array.from(w.causes.province)).toEqual(first);
    const locked = Number(Object.keys(w.small.provinces)[5]);
    const lockedCells = provinceCells(w, locked);
    const lockedName = w.small.provinces[locked].name;
    eng.exec({ op: 'set_province', id: locked, locked: true });
    eng.exec({ op: 'generate_provinces', rules: { seed: 4 } });
    expect(Array.from(w.causes.province)).not.toEqual(first);
    expect(provinceCells(w, locked)).toEqual(lockedCells);
    expect(w.small.provinces[locked].name).toBe(lockedName);
  });

  it('在一个角落画陆地，远处省份的编号与名字不变', () => {
    const eng = continents();
    eng.exec({ op: 'generate_provinces', rules: { seed: 3 } });
    const w = eng.world;
    const before = provinceSnapshot(w);
    const cells: number[] = [];
    const t: number[] = [];
    for (let i = 0; i < w.mesh.n; i++) {
      const dd = Math.hypot(w.mesh.x[i] - 0.15, w.mesh.y[i] - 0.15) / 0.08;
      if (dd <= 1) {
        cells.push(i);
        t.push(dd);
      }
    }
    eng.exec({ op: 'paint_land', cells, t, mode: 'land' });
    const after = provinceSnapshot(w);
    let farKept = 0;
    for (const [id, snap] of before) {
      const far = provinceCells(w, id).every((c) => Math.hypot(w.mesh.x[c] - 0.15, w.mesh.y[c] - 0.15) > 0.3);
      if (!far || !after.has(id)) continue;
      expect(after.get(id)).toBe(snap);
      farKept++;
    }
    expect(farKept).toBeGreaterThan(50);
  });

  it('改省份类型：陆地省份可以改成无人区，不能改成海域', () => {
    const eng = continents();
    eng.exec({ op: 'generate_provinces', rules: { seed: 3 } });
    const id = Number(Object.entries(eng.world.small.provinces).find(([, p]) => p.kind === 'land')![0]);
    eng.exec({ op: 'set_province', id, kind: 'wasteland' });
    expect(eng.world.small.provinces[id].kind).toBe('wasteland');
    expect(() => eng.exec({ op: 'set_province', id, kind: 'sea' })).toThrow();
  });
});

describe('地名不乱跳', () => {
  it('在海里放一个岛：只要没盖住这片海的锚点，海名不变', () => {
    const eng = new Engine({ cells: 12000, seed: 1, latNorth: 30, latSouth: 0 });
    eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'archipelago' }, reset: true });
    const w = eng.world;
    const seas = w.derived.features.filter((f) => f.type === 'sea' || f.type === 'ocean').sort((a, b) => b.cells.length - a.cells.length);
    let checked = 0;
    for (const sea of seas.slice(0, 3)) {
      const anchor = sea.anchor;
      // 选海里一个离锚点较远、离岸也远的地方放岛
      const spot = Array.from(sea.cells).find((c) => {
        const far = Math.hypot(w.mesh.x[c] - w.mesh.x[anchor], w.mesh.y[c] - w.mesh.y[anchor]) > 0.25;
        let open = true;
        for (let e = w.mesh.off[c]; e < w.mesh.off[c + 1]; e++) if (w.causes.land[w.mesh.adj[e]]) open = false;
        return far && open && w.derived.continentality[c] >= 0;
      });
      if (spot === undefined) continue;
      const name = sea.name;
      eng.exec({ op: 'add_island', island: { x: w.mesh.x[spot], y: w.mesh.y[spot], kind: 'volcanic', size: 'small', variant: 0 } });
      if (w.causes.land[anchor]) continue;
      const again = w.derived.features.find((f) => f.type === sea.type && f.cells.includes(anchor));
      expect(again?.name).toBe(name);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('水：画河与放湖所见即所得', () => {
  it('点源头画河：路径相邻，流到海、湖或汇入别的河；画出的河从源头起就是河', () => {
    const eng = continents();
    const w = eng.world;
    const d = w.derived;
    const thr = w.small.planet.riverThreshold;
    // 内陆较高、本来没有河的地方
    const src = landCells(w).find((i) => d.elevation[i] > 600 && d.discharge[i] < thr * 0.2 && d.continentality[i] > 0.4)!;
    const plan = planRiver(w, d, [src]);
    const path = plan.cells;
    expect(path[0]).toBe(src);
    expect(plan.reroute).toBe(false);
    for (let k = 0; k + 1 < path.length; k++) {
      const a = path[k];
      let adjacent = false;
      for (let e = w.mesh.off[a]; e < w.mesh.off[a + 1]; e++) if (w.mesh.adj[e] === path[k + 1]) adjacent = true;
      expect(adjacent).toBe(true);
    }
    // 终点：海、湖、别的河，或者从地图边上流出去；路上不经过别的河
    const end = path[path.length - 1];
    expect(plan.end).not.toBeNull();
    if (plan.end === 'river') expect(isRiverCell(w, d, end)).toBe(true);
    else expect(!w.causes.land[end] || d.lake[end] === 1 || w.mesh.boundary[end] === 1).toBe(true);
    expect(path.slice(0, -1).some((c) => isRiverCell(w, d, c))).toBe(false);
    eng.exec({ op: 'add_guide', guide: { cells: path, locked: true, spring: true } });
    for (const c of path) if (w.causes.land[c] && w.derived.lake[c] !== 1) expect(w.derived.discharge[c]).toBeGreaterThanOrEqual(thr);
  });

  it('拖出来的路线：画到的终点还在陆地上，就顺着地势流下去', () => {
    const eng = continents();
    const w = eng.world;
    const d = w.derived;
    const land = landCells(w).filter((i) => d.continentality[i] > 0.5 && !isRiverCell(w, d, i));
    const a = land[0];
    // 往旁边拖几格（都不是河）
    const drag = [a];
    let c = a;
    for (let k = 0; k < 6; k++) {
      let next = -1;
      for (let e = w.mesh.off[c]; e < w.mesh.off[c + 1]; e++) {
        const j = w.mesh.adj[e];
        if (w.causes.land[j] && d.lake[j] !== 1 && !isRiverCell(w, d, j) && !drag.includes(j)) next = j;
      }
      if (next < 0) break;
      drag.push(next);
      c = next;
    }
    const plan = planRiver(w, d, drag);
    const path = plan.cells;
    expect(path.slice(0, drag.length)).toEqual(drag);
    expect(new Set(path).size).toBe(path.length);
    expect(plan.end).not.toBeNull();
  });

  it('放湖：预览的湖面就是放完后的湖面', () => {
    const eng = continents();
    const w = eng.world;
    const cell = landCells(w).find((i) => w.derived.continentality[i] > 0.5 && w.derived.slope[i] < 8)!;
    const preview = new Set(lakeArea(w, cell, 80));
    eng.exec({ op: 'add_lake', lake: { cell, radius: 80, depth: 120, perennial: true } });
    const lake: number[] = [];
    for (let i = 0; i < w.mesh.n; i++) if (w.derived.lake[i] === 1 && preview.has(i)) lake.push(i);
    expect(lake.length / preview.size).toBeGreaterThan(0.9);
  });
});

describe('自然：涂到的就是', () => {
  it('“自然融入”涂一片：每一格要么长成了，要么被标出来并说明原因', () => {
    const eng = continents();
    const w = eng.world;
    const cells = landCells(w).filter((i) => w.derived.tMean[i] > 4 && w.derived.tMean[i] < 16).slice(0, 300);
    eng.exec({ op: 'add_constraint', constraint: { cells, species: 'temperate_forest', mode: 'constraint', ratio: 1, radius: 500 } });
    const target = w.small.species.findIndex((s) => s.id === 'temperate_forest');
    const failing = new Set(w.derived.conflicts.flatMap((c) => c.failing));
    let grown = 0;
    for (const c of cells) {
      if (!isVegetated(w, w.derived, c)) continue;
      const ok = w.derived.dominant[c] === target;
      if (ok) grown++;
      expect(ok || failing.has(c)).toBe(true);
    }
    expect(grown).toBeGreaterThan(cells.length * 0.5);
    for (const c of w.derived.conflicts) expect(c.reasons.length + c.suggestions.length).toBeGreaterThan(0);
  });

  it('岛屿特有生态：只把岛上最多的那种生态换成特有版本，别的生态和岛外都不变', () => {
    const eng = new Engine({ cells: 12000, seed: 1, latNorth: 30, latSouth: 0 });
    eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'archipelago' }, reset: true });
    const w = eng.world;
    const island = w.derived.features.filter((f) => f.type === 'island').sort((a, b) => b.cells.length - a.cells.length)[0];
    const cells = Array.from(island.cells);
    const before = w.derived.dominant.slice();
    const sp = endemicSpecies(w, cells, 'endemic_test', '测试岛')!;
    const base = w.small.species.findIndex((x) => sp.name === `测试岛${x.name || x.id}`);
    expect(base).toBeGreaterThanOrEqual(0);
    eng.exec({ op: 'add_species', species: sp });
    const s = w.small.species.findIndex((x) => x.id === 'endemic_test');
    const on = new Set(cells);
    let replaced = 0;
    let wasBase = 0;
    let otherChanged = 0;
    let other = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      const now = w.derived.dominant[i];
      if (!on.has(i)) {
        expect(now).toBe(before[i]);
        continue;
      }
      if (before[i] === base) {
        wasBase++;
        if (now === s) replaced++;
      } else if (before[i] >= 0) {
        other++;
        if (now !== before[i]) otherChanged++;
      }
    }
    expect(replaced).toBe(wasBase);
    expect(otherChanged).toBeLessThanOrEqual(Math.max(2, other * 0.05));
  });

  it('气候图上的色块与耐受曲线互通：默认生态读出来再写回，逐值不变', () => {
    for (const sp of DEFAULT_SPECIES) expect(withRect(sp, speciesRect(sp)).tolerances).toEqual(sp.tolerances);
  });
});

describe('导出', () => {
  it('文件包里有地名表 features.csv，省份汇总带类型', () => {
    const eng = continents(6000);
    eng.exec({ op: 'generate_provinces', rules: { seed: 3 } });
    const { zip } = exportPackage(eng.world, eng.toDoc(), { width: 256, height: 128, seaLevelGray: 95, maxElevation: 6000 });
    const files = unzipSync(zip);
    const rows = strFromU8(files['features.csv']).trim().split('\n');
    expect(rows[0]).toBe('type,type_name,name,custom,area_km2,x_px,y_px,lat,lon,key');
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.slice(1).every((r) => r.split(',')[2].length > 0)).toBe(true);
    expect(strFromU8(files['provinces_summary.csv']).split('\n')[0]).toContain('kind');
  });
});
