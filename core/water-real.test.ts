import { describe, expect, it } from 'vitest';
import { digest } from './digest';
import type { Engine } from './engine';
import { lakeParts, lakeTypeSchema } from './lake-types';
import { findPack } from './packs';
import { builtinPacks, DEFAULT_LIBRARY, LIBRARY_BASE_PACKS, worldPartsOf } from './packs/builtin-tree';
import { packImportCommands } from './packs/import';
import { DEFAULT_SPECIES } from './packs/nature';
import { REAL_LAKE_TYPES, REAL_RIVER_TYPES } from './packs/water';
import { planetSettings } from './presets';
import { riverNet, riverTypeSchema } from './river-types';
import { engineFor, humanDigest, withoutWater } from './testing/fixtures';
import { LAKE_WHEN_KEYS, WHEN_RANGE, type LakeWhenKey, hasWhen } from './water-types';
import type { World } from './world';

// 第五十七轮：现实的水系。内容、每种至少出现一次且出现得合理、水不变（高程、水、生态、地名、人文逐值相同）

const LIB = builtinPacks();

// 一个新世界：commands 是世界的底子（可以先去掉水系）
function newWorld(settings: object, params: object, plain = false, lib = DEFAULT_LIBRARY): Engine {
  const eng = engineFor(settings, { bare: true });
  const parts = packImportCommands(LIB, { packs: worldPartsOf(lib), groups: [] });
  eng.exec({ op: 'batch', commands: [...(plain ? withoutWater(parts) : parts), { op: 'set_worldgen', params, reset: true }] });
  return eng;
}

// 几种种子、纬度、地形（1.2 万格）：一共 8 个世界
const LATS = [[72, 20], [60, 10], [25, -25], [-10, -60]] as const;
const KINDS = ['continents', 'continent', 'fragmented', 'archipelago'] as const;
const small = (k: number) => [{ seed: k, cells: 12000, latNorth: LATS[k % 4][0], latSouth: LATS[k % 4][1] }, { seed: k, type: KINDS[k % 4] }] as const;
const memo = new Map<number, Engine>();
const smallWorld = (k: number) => {
  let e = memo.get(k);
  if (!e) memo.set(k, (e = newWorld(...small(k))));
  return e;
};
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

interface RiverCell {
  height: number;
  slope: number;
  temp: number;
  flow: number;
  biome: string;
}
// 每种河的格（河格：lake 不算）
function riverCells(w: World): Map<string, RiverCell[]> {
  const out = new Map<string, RiverCell[]>();
  const d = w.derived;
  const { isRiver } = riverNet(w, d);
  for (let i = 0; i < w.mesh.n; i++) {
    if (!isRiver[i]) continue;
    const v = d.riverType?.[i] ?? 0;
    const id = v ? w.small.riverTypes![v - 1].id : 'plain';
    let l = out.get(id);
    if (!l) out.set(id, (l = []));
    l.push({ height: Math.max(0, d.elevation[i]), slope: d.slope[i], temp: d.tMean[i], flow: d.discharge[i], biome: d.dominant[i] >= 0 ? w.small.species[d.dominant[i]].id : '' });
  }
  return out;
}

interface LakeInfo {
  id: string;
  size: number;
  // 湖岸一圈的平均高度（湖底在类型定下来之后才修深，这里看岸）
  shore: number;
  slope: number;
  temp: number;
  flow: number;
  shores: Map<string, number>;
}
function lakes(w: World): LakeInfo[] {
  const d = w.derived;
  const parts = lakeParts(w, d);
  return parts.lakes.map((cells, k) => {
    const v = d.lakeType?.[cells[0]] ?? 0;
    let slope = 0;
    let temp = 0;
    let flow = 0;
    let shore = 0;
    let m = 0;
    const shores = new Map<string, number>();
    for (const c of cells) {
      slope += d.slope[c];
      temp += d.tMean[c];
      flow = Math.max(flow, d.discharge[c]);
      for (let e = w.mesh.off[c]; e < w.mesh.off[c + 1]; e++) {
        const j = w.mesh.adj[e];
        if (parts.of[j] === k || !w.causes.land[j]) continue;
        shore += Math.max(0, d.elevation[j]);
        m++;
        const b = d.dominant[j] >= 0 ? w.small.species[d.dominant[j]].id : '';
        shores.set(b, (shores.get(b) ?? 0) + 1);
      }
    }
    return { id: v ? w.small.lakeTypes![v - 1].id : 'plain', size: cells.length, shore: m ? shore / m : 0, slope: slope / cells.length, temp: temp / cells.length, flow, shores };
  });
}

const median = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1];
const shareOf = <T,>(a: readonly T[], f: (x: T) => boolean) => a.filter(f).length / a.length;
const shoreShare = (l: LakeInfo, ids: readonly string[]) => {
  let total = 0;
  let hit = 0;
  for (const [b, c] of l.shores) {
    if (!b) continue;
    total += c;
    if (ids.includes(b)) hit += c;
  }
  return total ? hit / total : 0;
};

describe('内容', () => {
  it('七种河、七种湖，用户定的名字', () => {
    expect(REAL_RIVER_TYPES.map((t) => t.name).sort()).toEqual(['冰川河', '山溪急流', '季节河', '干河床', '黑水河', '泥沙大河', '沼泽曲流'].sort());
    expect(REAL_LAKE_TYPES.map((t) => t.name).sort()).toEqual(['冰川湖', '高山湖', '盐湖', '干湖', '火山口湖', '沼泽湖', '牛轭湖'].sort());
  });

  it('只有声明式条件：不写脚本、不写起名模板、没有两岸影响；写明自然生成；格式对，条件在滑块范围里', () => {
    const ids = new Set(DEFAULT_SPECIES.map((s) => s.id));
    for (const t of [...REAL_RIVER_TYPES, ...REAL_LAKE_TYPES]) {
      expect(t.natural, t.id).toBe(true);
      expect(t.scripts, t.id).toBeUndefined();
      expect(t.names, t.id).toBeUndefined();
      expect(t.bank, t.id).toBeUndefined();
      expect(hasWhen(t) || t.biomes !== undefined, t.id).toBe(true);
      for (const b of t.biomes ?? []) expect(ids.has(b), `${t.id} ${b}`).toBe(true);
      for (const k of LAKE_WHEN_KEYS) {
        const r = (t.when as Partial<Record<LakeWhenKey, { low: number; high: number }>> | undefined)?.[k];
        if (!r) continue;
        expect(r.low, `${t.id} ${k}`).toBeGreaterThanOrEqual(WHEN_RANGE[k].lo);
        expect(r.high, `${t.id} ${k}`).toBeLessThanOrEqual(WHEN_RANGE[k].hi);
      }
    }
    for (const t of REAL_RIVER_TYPES) expect(riverTypeSchema.parse(t)).toEqual(t);
    for (const t of REAL_LAKE_TYPES) expect(lakeTypeSchema.parse(t)).toEqual(t);
    // 世界文件是 JSON：不能有无穷
    expect(JSON.parse(JSON.stringify(REAL_LAKE_TYPES))).toEqual(REAL_LAKE_TYPES);
  });

  it('颜色都不一样，也不是普通河的颜色', () => {
    const colors = [...REAL_RIVER_TYPES.map((t) => t.color), '#3468a8'];
    expect(new Set(colors).size).toBe(colors.length);
    expect(new Set(REAL_LAKE_TYPES.map((t) => t.color)).size).toBe(REAL_LAKE_TYPES.length);
  });

  it('六个库都带上，是同一份；新世界默认带上，来源记着这个库', () => {
    for (const p of LIB) {
      expect(findPack(p, ['water']), p.id).toBe(findPack(LIB[0], ['water']));
      expect(worldPartsOf(p.id)).toContainEqual([p.id, 'water']);
    }
    expect(LIBRARY_BASE_PACKS.has('water')).toBe(true);
    const w = newWorld(...small(1)).world;
    expect(w.small.riverTypes!.map((t) => t.id)).toEqual(REAL_RIVER_TYPES.map((t) => t.id));
    expect(w.small.lakeTypes!.map((t) => t.id)).toEqual(REAL_LAKE_TYPES.map((t) => t.id));
    expect(w.small.origin?.riverType?.glacier_river).toEqual([DEFAULT_LIBRARY, 'water']);
    expect(w.small.species.some((s) => s.id === 'crystal_jungle')).toBe(false);
  });
});

describe('每种都出现，出现得合理', () => {
  it('每种河至少在一个世界里；1.2 万格的世界和整个星球都有全部七种（小星球的坡度不够，没有山溪）', () => {
    const seen = new Set<string>();
    for (const k of SEEDS) for (const id of riverCells(smallWorld(k).world).keys()) seen.add(id);
    for (const t of REAL_RIVER_TYPES) expect(seen.has(t.id), t.id).toBe(true);
    const globe = new Set(riverCells(newWorld({ ...planetSettings('earth'), seed: 3 }, { seed: 3, type: 'continents' }).world).keys());
    for (const t of REAL_RIVER_TYPES) expect(globe.has(t.id), `星球 ${t.id}`).toBe(true);
    // 普通的河还是常见的
    expect(globe.has('plain')).toBe(true);
  }, 120000);

  it('每种湖至少在一个世界里', () => {
    const seen = new Set<string>();
    for (const k of SEEDS) for (const l of lakes(smallWorld(k).world)) seen.add(l.id);
    for (const t of REAL_LAKE_TYPES) expect(seen.has(t.id), t.id).toBe(true);
  }, 120000);

  it('河：每种都在该在的地方（并进相邻段的几格除外，所以看多数或中位数）', () => {
    const all = new Map<string, RiverCell[]>();
    for (const k of SEEDS) for (const [id, cells] of riverCells(smallWorld(k).world)) all.set(id, [...(all.get(id) ?? []), ...cells]);
    const of = (id: string) => all.get(id)!;
    // 冰川河：冷的高处
    expect(shareOf(of('glacier_river'), (c) => c.temp <= 0 && c.height >= 800)).toBeGreaterThan(0.8);
    // 山溪急流：陡，水不大
    expect(shareOf(of('mountain_torrent'), (c) => c.slope >= 6 && c.flow <= 1500)).toBeGreaterThan(0.8);
    // 泥沙大河：流量大、平
    expect(median(of('silt_river').map((c) => c.flow))).toBeGreaterThan(2000);
    expect(median(of('silt_river').map((c) => c.slope))).toBeLessThan(3);
    // 干河床：荒漠，水少
    expect(shareOf(of('dry_bed'), (c) => c.biome === 'desert')).toBeGreaterThan(0.7);
    expect(median(of('dry_bed').map((c) => c.flow))).toBeLessThan(400);
    // 季节河：干的、有旱季的地方
    expect(shareOf(of('seasonal_river'), (c) => ['desert', 'savanna', 'shrubland'].includes(c.biome))).toBeGreaterThan(0.8);
    // 沼泽曲流：沼泽里的平地
    expect(shareOf(of('swamp_meander'), (c) => c.biome === 'wetland' && c.slope <= 1.5)).toBeGreaterThan(0.8);
    // 黑水河：热带森林里的慢水
    expect(shareOf(of('blackwater_river'), (c) => ['rainforest', 'monsoon_forest'].includes(c.biome))).toBeGreaterThan(0.8);
    expect(median(of('blackwater_river').map((c) => c.temp))).toBeGreaterThan(18);
  }, 120000);

  it('湖：每种都在该在的地方（按整个湖，条件逐条成立；高度看湖岸）', () => {
    const all = SEEDS.flatMap((k) => lakes(smallWorld(k).world));
    const of = (id: string) => all.filter((l) => l.id === id);
    for (const l of of('glacial_lake')) expect(l.temp).toBeLessThanOrEqual(-3);
    for (const l of of('crater_lake')) {
      expect(l.size).toBeLessThanOrEqual(4);
      expect(l.slope).toBeGreaterThanOrEqual(5);
      expect(l.shore).toBeGreaterThan(150);
    }
    for (const l of of('alpine_lake')) expect(l.shore).toBeGreaterThan(500);
    for (const l of of('dry_lake')) {
      expect(l.flow).toBeLessThanOrEqual(150);
      expect(l.temp).toBeGreaterThanOrEqual(5);
      expect(shoreShare(l, ['desert', 'savanna', 'shrubland', 'steppe'])).toBeGreaterThanOrEqual(0.5);
    }
    for (const l of of('salt_lake')) {
      expect(l.flow).toBeLessThanOrEqual(400);
      expect(shoreShare(l, ['desert', 'steppe', 'shrubland'])).toBeGreaterThanOrEqual(0.5);
    }
    for (const l of of('swamp_lake')) {
      expect(l.slope).toBeLessThanOrEqual(1);
      expect(l.shore).toBeLessThan(400);
      expect(shoreShare(l, ['wetland', 'rainforest', 'monsoon_forest', 'subtropical_forest', 'temperate_forest'])).toBeGreaterThanOrEqual(0.5);
    }
    // 牛轭湖：平地大河边的小湖
    for (const l of of('oxbow_lake')) {
      expect(l.size).toBeLessThanOrEqual(5);
      expect(l.flow).toBeGreaterThanOrEqual(1000);
      expect(l.slope).toBeLessThanOrEqual(1);
    }
  }, 120000);
});

// 除了 riverType、lakeType，地物只差类型的标签
const WATER_ONLY = new Set(['riverType', 'lakeType']);
function derivedDigests(w: World): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(w.derived)) if (ArrayBuffer.isView(v) && !WATER_ONLY.has(k)) out[k] = digest(v);
  return out;
}
const untagged = (w: World) => w.derived.features.map((f) => ({ ...f, cells: digest(Int32Array.from(f.cells)), tags: f.tags.filter((t) => !t.startsWith('rtype:') && !t.startsWith('ltype:')) }));

describe('水不变：带着这些类型和不带时除了类型逐值相同', () => {
  const groups = ['germanic', 'levantine', 'chinese'];
  const SCENES: [string, object, object][] = [
    ['地区', { seed: 2, cells: 12000, latNorth: 25, latSouth: -25 }, { seed: 2, type: 'fragmented' }],
    ['地区（冷）', { seed: 1, cells: 12000, latNorth: 72, latSouth: 20 }, { seed: 5, type: 'continents', landFraction: 0.4 }],
    ['星球', { ...planetSettings('earth', 12000), seed: 7 }, { seed: 7, type: 'continents' }],
  ];
  for (const [name, settings, params] of SCENES) {
    it(`${name}：高程、流向、汇水、径流、生态、地名；文化、国家、城市`, () => {
      const a = newWorld(settings, params);
      const b = newWorld(settings, params, true);
      expect(a.world.derived.riverType?.some((v) => v > 0)).toBe(true);
      expect(b.world.derived.riverType).toBeUndefined();
      expect(b.world.derived.lakeType).toBeUndefined();
      expect(derivedDigests(a.world)).toEqual(derivedDigests(b.world));
      expect(untagged(a.world)).toEqual(untagged(b.world));
      expect(a.world.derived.scriptIssues).toEqual(b.world.derived.scriptIssues);
      for (const e of [a, b]) {
        e.exec({ op: 'generate_provinces', rules: { seed: 5 } });
        for (const c of packImportCommands(LIB, { packs: [['medieval']], groups }, e.world)) e.exec(c);
        e.exec({ op: 'generate_human', packs: [['medieval']], groups, countries: {}, settlements: {} });
      }
      expect(humanDigest(a.world)).toEqual(humanDigest(b.world));
      expect(derivedDigests(a.world)).toEqual(derivedDigests(b.world));
      expect(untagged(a.world)).toEqual(untagged(b.world));
    }, 120000);
  }

  it('改一笔之后也一样，撤销回到原样', () => {
    const [settings, params] = small(2);
    const a = newWorld(settings, params);
    const b = newWorld(settings, params, true);
    const before = digest(a.world.derived.riverType!);
    const lake = digest(a.world.derived.lakeType!);
    const land: number[] = [];
    for (let i = 0; i < a.world.mesh.n && land.length < 300; i++) if (a.world.causes.land[i]) land.push(i);
    for (const e of [a, b]) e.exec({ op: 'paint', field: 'tempOffset', cells: land, values: land.map(() => -8), mode: 'add' });
    expect(digest(a.world.derived.riverType!)).not.toBe(before);
    expect(derivedDigests(a.world)).toEqual(derivedDigests(b.world));
    a.undo();
    expect(digest(a.world.derived.riverType!)).toBe(before);
    expect(digest(a.world.derived.lakeType!)).toBe(lake);
  }, 120000);
});
