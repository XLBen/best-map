import { describe, expect, it } from 'vitest';
import { lakeTypeSchema } from './lake-types';
import { findPack, ownItems } from './packs';
import { builtinPacks, worldPartsOf } from './packs/builtin-tree';
import { FANTASY_BIOMES } from './packs/fantasy-biomes';
import { FANTASY_LAKE_TYPES } from './packs/fantasy-lakes';
import { FANTASY_RIVER_TYPES } from './packs/fantasy-rivers';
import { FANTASY_NEW_RIVER_TYPES } from './packs/fantasy-water';
import { packImportCommands } from './packs/import';
import { REAL_LAKE_TYPES, REAL_RIVER_TYPES } from './packs/water';
import { planetSettings } from './presets';
import { riverNet, riverTypeSchema } from './river-types';
import { engineFor } from './testing/fixtures';
import { waterPlan } from './water-types';
import { digest } from './digest';
import { Engine } from './engine';
import { vegetationStats } from './vegetation';

// 第五十七轮：奇幻库默认带上奇幻的生态、河、湖（第五十二轮以后向导不能勾小包，不带就选不到）。
// 目标：新建一个奇幻世界，地图上自然能看到几种奇幻的河

const LIB = builtinPacks();
const FANTASY = LIB.find((p) => p.id === 'fantasy')!;

function newWorld(settings: object, params: object, lib = 'fantasy'): Engine {
  const eng = engineFor(settings, { bare: true });
  eng.exec({ op: 'batch', commands: [...packImportCommands(LIB, { packs: worldPartsOf(lib), groups: [] }), { op: 'set_worldgen', params, reset: true }] });
  return eng;
}

const NEW_IDS = FANTASY_NEW_RIVER_TYPES.map((t) => t.id);
// 每种河配的生态、比例下限（和脚本里写的一样）
const HOME: Record<string, [string, number]> = {
  ley_river: ['crystal_jungle', 0.2],
  starlight_river: ['holy_land', 0.15],
  holy_spring: ['holy_land', 0.2],
  venom_river: ['dead_forest', 0.2],
  lac_river: ['swarm_zone', 0.2],
  bone_river: ['bloody_land', 0.2],
};

describe('奇幻库默认带上奇幻的生态、河、湖', () => {
  it('六种新河，用户定的名字；格式对', () => {
    expect(FANTASY_NEW_RIVER_TYPES.map((t) => t.name).sort()).toEqual(['灵脉河', '星辉河', '毒液河', '圣泉河', '枯骨河', '虫胶河'].sort());
    for (const t of FANTASY_NEW_RIVER_TYPES) {
      expect(riverTypeSchema.parse(t)).toEqual(t);
      expect(t.natural).toBe(true);
      // 不改气候
      expect(t.bank).toBeUndefined();
      expect(t.names?.length).toBeGreaterThan(0);
      expect(HOME[t.id]).toBeDefined();
    }
    expect(new Set(NEW_IDS).size).toBe(6);
  });

  it('奇幻的湖还是原来四种，内容不变', () => {
    expect(ownItems(findPack(FANTASY, ['lakes'])!, 'lakeTypes')).toBe(FANTASY_LAKE_TYPES);
    expect(FANTASY_LAKE_TYPES.map((t) => t.name)).toEqual(['血池', '晶湖', '冥湖', '熔岩湖']);
    for (const t of FANTASY_LAKE_TYPES) expect(lakeTypeSchema.parse(t)).toEqual(t);
  });

  it('新世界：奇幻的生态都自然生成；奇幻的河在现实的河前面（前面的说了算）；别的库不带', () => {
    const parts = worldPartsOf('fantasy').map((p) => p.slice(1).join('/'));
    expect(parts).toEqual(['base', 'nature', 'names/zh', 'styles', 'tiers', 'biomes', 'rivers', 'lakes', 'water']);
    for (const id of ['antiquity', 'medieval', 'industrial', 'modern', 'scifi']) expect(worldPartsOf(id).map((p) => p[1]), id).toEqual(['base', 'nature', 'names', 'styles', 'tiers', 'water']);
    const w = newWorld({ seed: 3, cells: 6000 }, { seed: 3, type: 'continents' }).world;
    for (const b of FANTASY_BIOMES) expect(w.small.species.find((s) => s.id === b.id)?.natural, b.id).toBe(true);
    expect(w.small.riverTypes!.map((t) => t.id)).toEqual([...NEW_IDS, ...FANTASY_RIVER_TYPES.map((t) => t.id), ...REAL_RIVER_TYPES.map((t) => t.id)]);
    expect(w.small.lakeTypes!.map((t) => t.id)).toEqual([...FANTASY_LAKE_TYPES.map((t) => t.id), ...REAL_LAKE_TYPES.map((t) => t.id)]);
    // 冥河、冥湖还是只能自己选
    expect(w.small.riverTypes!.find((t) => t.id === 'styx')?.natural).toBe(false);
    expect(w.small.lakeTypes!.find((t) => t.id === 'styx_lake')?.natural).toBe(false);
    expect(w.small.origin?.riverType?.ley_river).toEqual(['fantasy', 'rivers']);
    expect(w.small.origin?.riverType?.glacier_river).toEqual(['fantasy', 'water']);
    // 奇幻生态读河岸：要先多算一遍不计水体类型的植被
    expect(waterPlan(w.small)).toEqual({ biomes: true, baseFirst: true, stops: false, reuseFirstBase: true });
  });

  it('每种新河至少在一个世界里出现；一个奇幻世界里总能看到好几种奇幻的河；流经的格里配的生态够多', () => {
    const LATS = [[72, 20], [60, 10], [25, -25], [-10, -60]] as const;
    const KINDS = ['continents', 'continent', 'fragmented', 'archipelago'] as const;
    const seen = new Map<string, number>();
    let judged = 0;
    let good = 0;
    const scenes: [object, object][] = [];
    for (let k = 1; k <= 8; k++) scenes.push([{ seed: k, cells: 12000, latNorth: LATS[k % 4][0], latSouth: LATS[k % 4][1] }, { seed: k, type: KINDS[k % 4] }]);
    scenes.push([{ seed: 3, cells: 40000 }, { seed: 3, type: 'continents' }]);
    scenes.push([{ ...planetSettings('earth', 12000), seed: 5 }, { seed: 5, type: 'continents' }]);
    for (const [settings, params] of scenes) {
      const eng = newWorld(settings, params);
      const w = eng.world;
      const d = w.derived;
      const types = w.small.riverTypes!;
      const stems = riverNet(w, d).stems;
      const kinds = new Set<string>();
      for (const cells of stems) {
        const v = d.riverType![cells[0]];
        if (!v) continue;
        const id = types[v - 1].id;
        if (!NEW_IDS.includes(id)) continue;
        // 整条河一种：源头是这一种、不是别的河流进来的（短段合并、汇入的段不看）
        if (cells.some((c) => d.riverType![c] !== v)) continue;
        const [biome, low] = HOME[id];
        const b = w.small.species.findIndex((s) => s.id === biome);
        let inside = 0;
        for (const c of cells) if (d.dominant[c] === b) inside++;
        // 脚本看的是第一遍不计水体类型的植被；最后的植被可以差一点（血腥之地、水晶丛林读河岸，别的生态受影响变了气候），所以看多数
        if (biome !== 'bloody_land' && biome !== 'crystal_jungle') {
          judged++;
          if (inside / cells.length >= low - 0.15) good++;
        }
        kinds.add(id);
        seen.set(id, (seen.get(id) ?? 0) + cells.length);
      }
      expect(kinds.size, JSON.stringify(settings)).toBeGreaterThanOrEqual(1);
    }
    for (const id of NEW_IDS) expect(seen.get(id) ?? 0, id).toBeGreaterThan(0);
    expect(good / judged).toBeGreaterThan(0.8);
  }, 180000);

  it('第二遍的类型读第一遍不计水体类型的生态：一笔只多算一遍；现实库一遍都不多算；用了断流的世界每遍照旧算', () => {
    const count = (eng: Engine) => {
      const cells: number[] = [];
      for (let i = 0; i < eng.world.mesh.n && cells.length < 100; i += 5) if (eng.world.causes.land[i]) cells.push(i);
      vegetationStats.base = 0;
      eng.exec({ op: 'paint', field: 'tempOffset', cells, values: cells.map(() => -1), mode: 'add' });
      return vegetationStats.base;
    };
    const settings = { seed: 3, cells: 6000 };
    const params = { seed: 3, type: 'continents' };
    const fantasy = newWorld(settings, params);
    expect(count(fantasy)).toBe(1);
    expect(count(newWorld(settings, params, 'medieval'))).toBe(0);
    fantasy.exec({ op: 'update_species', id: 'desert', patch: { plainRiver: false, waterBlock: 'stop' } });
    expect(waterPlan(fantasy.world.small).reuseFirstBase).toBe(false);
    expect(count(fantasy)).toBeGreaterThanOrEqual(2);
    // 重放一样
    const again = newWorld(settings, params);
    expect(digest(again.world.derived.riverType!)).toBe(digest(Engine.fromDoc(again.toDoc(), again.world.mesh).world.derived.riverType!));
  }, 60000);

  it('默认的地区（种子 3）上看得到至少三种奇幻的河（含原来的）', () => {
    const w = newWorld({ seed: 3, cells: 40000 }, { seed: 3, type: 'continents' }).world;
    const fantasy = new Set([...NEW_IDS, ...FANTASY_RIVER_TYPES.map((t) => t.id)]);
    const seen = new Set<string>();
    w.derived.riverType!.forEach((v) => {
      if (v && fantasy.has(w.small.riverTypes![v - 1].id)) seen.add(w.small.riverTypes![v - 1].id);
    });
    expect(seen.size).toBeGreaterThanOrEqual(3);
  }, 60000);
});
