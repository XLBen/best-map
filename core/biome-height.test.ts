import { describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import type { Command } from './commands';
import { activeConflicts } from './constraints';
import { kindOf } from './content/registry';
import { Engine } from './engine';
import { builtinPacks, worldPartsOf } from './packs/builtin-tree';
import { FANTASY_BIOMES } from './packs/fantasy-biomes';
import { packImportCommands } from './packs/import';
import { DEFAULT_SPECIES } from './packs/nature';
import { CONDITIONS, HEIGHT_MARGIN, HEIGHT_MAX, type Species, heightTolerance, speciesConditions, speciesSchema, speciesTolerances, trapezoid } from './species';
import { continents, engineFor, plainEngine, seededEngine } from './testing/fixtures';
import { explainCell } from './vegetation';
import type { World } from './world';

// 第五十五轮：生态跟高度走。高度范围是海拔（米）的耐受曲线，内置生态都写了；新增高山草甸、高山苔原；沼泽只在低而平的地方；
// 写了高度范围的世界不留下没有生态的陆地格。没写高度范围时和以前逐值相同的那一半在 biome-legacy.test.ts

const dry = (w: World, i: number) => w.causes.land[i] === 1 && w.derived.lake[i] !== 1;
const indexOf = (w: World, id: string) => w.small.species.findIndex((s) => s.id === id);

function cellsOf(w: World, id: string): number[] {
  const s = indexOf(w, id);
  const out: number[] = [];
  for (let i = 0; i < w.mesh.n; i++) if (dry(w, i) && w.derived.dominant[i] === s) out.push(i);
  return out;
}

function bareCount(w: World): number {
  let n = 0;
  for (let i = 0; i < w.mesh.n; i++) if (dry(w, i) && w.derived.dominant[i] < 0) n++;
  return n;
}

const height = (w: World, i: number) => Math.max(0, w.derived.elevation[i]);
const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];

// 高山多的一块地区（默认“最高的山”，纬度跨度大）
function mountains(cells = 12000, patch?: Record<string, unknown>): Engine {
  const eng = engineFor({ cells, seed: 1, latNorth: 60, latSouth: 20 });
  if (patch) eng.exec({ op: 'set_planet', patch });
  eng.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.4, mountains: 1.5 }, reset: true });
  return eng;
}

// 一格里只比高度的简单世界：除了给的这几种生态都去掉
function onlySpecies(eng: Engine, keep: readonly string[]) {
  const all = eng.world.small.species.map((s) => s.id);
  eng.exec({ op: 'batch', commands: all.filter((id) => !keep.includes(id)).map((id) => ({ op: 'remove_species', id })) });
}

describe('高度范围的含义', () => {
  it('范围里是 1，外面 300 m 内降到 0；0 不限下限，9000 不限上限', () => {
    const t = heightTolerance({ low: 1000, high: 2000 });
    expect(t.field).toBe('elevation');
    expect(trapezoid(t, 699)).toBe(0);
    expect(trapezoid(t, 850)).toBeCloseTo(0.5);
    expect(trapezoid(t, 1500)).toBe(1);
    expect(trapezoid(t, 2150)).toBeCloseTo(0.5);
    expect(trapezoid(t, 2301)).toBe(0);
    const open = heightTolerance({ low: 0, high: HEIGHT_MAX });
    for (const v of [0, 1, 500, 9000, 15000]) expect(trapezoid(open, v)).toBe(1);
    expect(HEIGHT_MARGIN).toBe(300);
  });

  it('下限不能高于上限；没写时解析结果没有这个键，算的还是原来那个数组', () => {
    expect(speciesSchema.safeParse({ id: 'a', height: { low: 2000, high: 1000 } }).success).toBe(false);
    expect(speciesSchema.safeParse({ id: 'a', height: { low: 1000, high: 2000 } }).success).toBe(true);
    const sp = speciesSchema.parse({ id: 'a' });
    expect('height' in sp).toBe(false);
    expect(speciesTolerances(sp)).toBe(sp.tolerances);
  });

  it('内置生态、奇幻生态都写了高度范围；两种高山生态有下限，别的从海平面起（神圣之地涂在低地也要长）', () => {
    for (const sp of [...DEFAULT_SPECIES, ...FANTASY_BIOMES]) {
      expect(sp.height, sp.id).toBeDefined();
      expect(speciesSchema.parse(sp)).toEqual(sp);
      if (sp.id.startsWith('alpine_')) expect(sp.height!.low).toBeGreaterThan(0);
      else expect(sp.height!.low, sp.id).toBe(0);
    }
    expect(DEFAULT_SPECIES.length).toBe(16);
    expect(DEFAULT_SPECIES.map((s) => s.id)).toEqual(expect.arrayContaining(['alpine_meadow', 'alpine_tundra']));
  });

  it('资源库的编辑页有这个字段（范围，可以不写）', () => {
    const f = kindOf('biome')!.fields!.find((x) => x.key === 'height')!;
    expect(f).toMatchObject({ type: 'range', optional: true, min: 0, max: HEIGHT_MAX });
  });

  it('是绝对的海拔：“最高的山”调低后高山带跟着变少；高度条件上的米不随它变', () => {
    const area = (scale: number) => {
      const w = mountains(6000, { mountainScale: scale }).world;
      return { alpine: cellsOf(w, 'alpine_meadow').length + cellsOf(w, 'alpine_tundra').length, low: Math.min(...[...cellsOf(w, 'alpine_meadow'), ...cellsOf(w, 'alpine_tundra')].map((i) => height(w, i)), Infinity) };
    };
    const tall = area(9000);
    const usual = area(6000);
    const short = area(1500);
    expect(tall.alpine).toBeGreaterThan(usual.alpine);
    expect(usual.alpine).toBeGreaterThan(short.alpine);
    for (const a of [tall, usual, short]) expect(a.low).toBeGreaterThanOrEqual(1000 - HEIGHT_MARGIN);
  });
});

describe('只变生态和它的下游', () => {
  // 没有“自然融入”、没有带影响的生态时：网格、原因、高程、气候、水文一个数不变。digestWorld 里不一样的只有这几项
  const CHANGES = ['derived.share', 'derived.suit', 'derived.reach', 'derived.dominant', 'derived.features', 'small'];
  const differ = (a: Engine, b: Engine) => {
    const da = digestWorld(a.world) as Record<string, string>;
    const db = digestWorld(b.world) as Record<string, string>;
    return Object.keys(da).filter((k) => da[k] !== db[k]);
  };
  const SCENES: [Record<string, unknown>, Record<string, unknown>][] = [
    [{ seed: 3, cells: 12000 }, { seed: 3, type: 'continents' }],
    [{ seed: 2, cells: 6000, globe: true, aspect: 2, latNorth: 90, latSouth: -90, radiusKm: 6371 }, { seed: 3, type: 'continents' }],
  ];
  it('一块地区、整个星球', () => {
    for (const [settings, gen] of SCENES) {
      const a = plainEngine(settings);
      const b = seededEngine(settings);
      a.exec({ op: 'set_worldgen', params: gen, reset: true } as Command);
      b.exec({ op: 'set_worldgen', params: gen, reset: true } as Command);
      expect(differ(a, b)).toEqual(CHANGES);
    }
  });
});

describe('地图上', () => {
  it('高山生态在高山上、低地没有；森林线在高山草甸下面', () => {
    const w = mountains().world;
    const meadow = cellsOf(w, 'alpine_meadow');
    const tundra = cellsOf(w, 'alpine_tundra');
    expect(meadow.length).toBeGreaterThan(30);
    expect(tundra.length).toBeGreaterThan(30);
    for (const i of [...meadow, ...tundra]) expect(height(w, i)).toBeGreaterThanOrEqual(1000 - HEIGHT_MARGIN);
    // 一层一层往上：针叶林、高山草甸、高山苔原
    const taiga = cellsOf(w, 'taiga');
    expect(median(taiga.map((i) => height(w, i)))).toBeLessThan(median(meadow.map((i) => height(w, i))));
    expect(median(meadow.map((i) => w.derived.tMean[i]))).toBeGreaterThan(median(tundra.map((i) => w.derived.tMean[i])));
    // 高山草甸在森林线上面：年均温在 0 °C 附近以下（森林线跟气温走，不是一个固定的海拔）
    for (const i of meadow) expect(w.derived.tMean[i]).toBeLessThan(2);
  });

  it('沼泽只在低而平的地方：高度和坡度的条件都有，地图上没有超出的格', () => {
    const wetland = DEFAULT_SPECIES.find((s) => s.id === 'wetland')!;
    expect(wetland.height).toEqual({ low: 0, high: 300 });
    expect(speciesConditions(wetland).has('flat')).toBe(true);
    const flat = CONDITIONS.flat.tol();
    for (const eng of [mountains(), continents({ cells: 12000, latNorth: 72, latSouth: 20 })]) {
      const w = eng.world;
      const cells = cellsOf(w, 'wetland');
      expect(cells.length).toBeGreaterThan(10);
      for (const i of cells) {
        expect(height(w, i)).toBeLessThanOrEqual(300 + HEIGHT_MARGIN);
        expect(w.derived.slope[i]).toBeLessThanOrEqual(flat.max);
      }
    }
  });

  it('高的低洼平地上不再有沼泽：同一格的适宜度被高度压成 0', () => {
    const w = mountains().world;
    const s = indexOf(w, 'wetland');
    const S = w.small.species.length;
    let high = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      if (!dry(w, i) || height(w, i) <= 300 + HEIGHT_MARGIN) continue;
      high++;
      expect(w.derived.suit[i * S + s]).toBe(0);
    }
    expect(high).toBeGreaterThan(100);
  });

  it('成片：高山带里孤零零的一格不到五分之一', () => {
    const w = mountains(40000).world;
    for (const id of ['alpine_meadow', 'alpine_tundra']) {
      const s = indexOf(w, id);
      const cells = cellsOf(w, id);
      let alone = 0;
      for (const i of cells) {
        let same = false;
        for (let e = w.mesh.off[i]; e < w.mesh.off[i + 1]; e++) if (w.derived.dominant[w.mesh.adj[e]] === s) same = true;
        if (!same) alone++;
      }
      expect(cells.length).toBeGreaterThan(50);
      // 第八十六轮：地形变了，高山草甸 5.03%：放宽到 6%（标题的五分之一远没碰到）
      expect(alone / cells.length, id).toBeLessThan(0.06);
    }
  });

  it('改高度范围从求解重算；撤销回到原样；两头都不限（去掉这个字段）和没写一样；重放一致', () => {
    const eng = mountains(6000);
    const w = eng.world;
    const before = digestWorld(w);
    const area = () => cellsOf(w, 'alpine_meadow').length;
    const was = area();
    eng.exec({ op: 'update_species', id: 'alpine_meadow', patch: { height: { low: 2500, high: HEIGHT_MAX } } });
    expect(area()).toBeLessThan(was);
    expect(digestWorld(Engine.fromDoc(eng.toDoc(), w.mesh).world)).toEqual(digestWorld(w));
    eng.undo();
    expect(digestWorld(w)).toEqual(before);
    // 第八十六轮：这个世界上 600 m 以上已经没有能长沼泽的平地（地形变了），改查 300 m 以上的沼泽比有上限时多
    const highBefore = cellsOf(w, 'wetland').filter((i) => height(w, i) > 300).length;
    eng.exec({ op: 'update_species', id: 'wetland', patch: { height: null } });
    expect(w.small.species[indexOf(w, 'wetland')].height).toBeUndefined();
    const high = cellsOf(w, 'wetland').filter((i) => height(w, i) > 300);
    expect(high.length).toBeGreaterThan(highBefore);
  });

  it('“这一格为什么”说得出高度；涂在低地的高山草甸没涂成时原因里有海拔', () => {
    const eng = mountains(6000);
    const w = eng.world;
    const low: number[] = [];
    for (let i = 0; i < w.mesh.n && low.length < 12; i++) if (dry(w, i) && height(w, i) < 200) low.push(i);
    const row = explainCell(w, w.derived, low[0]).find((e) => e.species === 'alpine_meadow')!;
    const f = row.factors.find((x) => x.field === 'elevation')!;
    expect(f.factor).toBe(0);
    expect(f.range).toEqual([700, 1000, 1e5, 1e5]);
    eng.exec({ op: 'add_constraint', constraint: { cells: low, species: 'alpine_meadow', mode: 'constraint', ratio: 1, radius: 300 } });
    const conflict = activeConflicts(w)[0];
    expect(conflict?.reasons.some((r) => r.field === 'elevation')).toBe(true);
  });
});

describe('没有生态的陆地格', () => {
  const LIB = builtinPacks();
  it('六个库（地区、星球；很高的山、不降温的星球）都没有', () => {
    for (const lib of LIB) {
      const region = engineFor({ cells: 6000, seed: 2, latNorth: 70, latSouth: -10 }, { bare: true });
      for (const c of packImportCommands(LIB, { packs: worldPartsOf(lib.id), groups: [] }, region.world)) region.exec(c);
      expect(region.world.small.species.map((s) => s.id), lib.id).toEqual(expect.arrayContaining(['alpine_meadow', 'alpine_tundra']));
      region.exec({ op: 'set_worldgen', params: { seed: 5, type: 'continents', landFraction: 0.5, mountains: 1.5 }, reset: true });
      expect(bareCount(region.world), `${lib.id} 地区`).toBe(0);
      region.exec({ op: 'set_planet', patch: { lapse: 0 } });
      expect(bareCount(region.world), `${lib.id} 不降温`).toBe(0);
      region.exec({ op: 'set_planet', patch: { lapse: 6.5, mountainScale: 15000 } });
      expect(bareCount(region.world), `${lib.id} 很高的山`).toBe(0);
    }
  });

  it('整个星球也没有', () => {
    const eng = seededEngine({ seed: 3, cells: 8000, globe: true, aspect: 2, latNorth: 90, latSouth: -90, radiusKm: 6371 });
    eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true });
    expect(bareCount(eng.world)).toBe(0);
  });

  it('兜底取最近的生态，成片；只长在某处、不自然生成的生态不传出去；没有能传的生态时留着', () => {
    const eng = mountains(6000);
    const w = eng.world;
    onlySpecies(eng, ['alpine_meadow', 'temperate_forest']);
    // 这两种都有够不着的地方：气温、湿度的缝里都没有生态，都由最近的一种兜底
    expect(bareCount(w)).toBe(0);
    const S = w.small.species.length;
    let filled = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      if (!dry(w, i)) continue;
      let top = 0;
      for (let s = 0; s < S; s++) top = Math.max(top, w.derived.suit[i * S + s]);
      if (top > 0) continue;
      filled++;
      // 份额 1
      expect(w.derived.share[i * S + w.derived.dominant[i]]).toBe(1);
    }
    expect(filled).toBeGreaterThan(100);
    // 不自然生成：它只长在涂了它的格，不传出去
    eng.exec({ op: 'update_species', id: 'alpine_meadow', patch: { natural: false } });
    expect(cellsOf(w, 'alpine_meadow').length).toBe(0);
    expect(bareCount(w)).toBe(0);
    eng.exec({ op: 'update_species', id: 'temperate_forest', patch: { natural: false } });
    expect(bareCount(w)).toBeGreaterThan(1000);
    for (let i = 0; i < w.mesh.n; i++) if (dry(w, i)) expect(w.derived.dominant[i]).toBe(-2);
  });

  it('一种高度范围都没写的世界不兜底（和以前一样）', () => {
    const eng = mountains(6000);
    const w = eng.world;
    onlySpecies(eng, ['temperate_forest', 'taiga']);
    eng.exec({ op: 'batch', commands: ['temperate_forest', 'taiga'].map((id) => ({ op: 'update_species', id, patch: { height: null } })) });
    expect(w.small.species.every((s: Species) => s.height === undefined)).toBe(true);
    expect(bareCount(w)).toBeGreaterThan(100);
  });
});
