import { describe, expect, it } from 'vitest';
import { packItems } from '../packs';
import { type Species, biomeGroupOf } from '../species';
import { BIOME_ID } from './biome-ids';
import { builtinPacks } from './builtin-tree';
import { FANTASY_BIOMES } from './fantasy-biomes';
import { GENERAL_RESOURCES } from './base';
import { DEFAULT_SPECIES, builtinBiomesIn } from './nature';
import { REAL_LAKE_TYPES, REAL_RIVER_TYPES } from './water';

// 第七十一轮：一种生态算哪一大类只在 species.ts 的 biomeGroupOf 写一处（以前地标、圈地名各按导出用的地形 terrain 认），
// 手写的 id 表改成 biome-ids.ts 与 builtinBiomesIn。这里拿每个内置库里的每一种生态，把以前的认法（照原样抄在下面）和现在的逐个对照

const LIBS = builtinPacks();
const allBiomes = (): Species[] => {
  const seen = new Map<string, Species>();
  for (const lib of LIBS) for (const sp of packItems<Species>(lib, 'biomes')) seen.set(`${lib.id}/${sp.id}`, sp);
  return [...seen.values()];
};

describe('生态的大类、点名的 id：内置的和以前逐个相同（第七十一轮）', () => {
  it('每个库都有自然包的生态，奇幻库另有奇幻的', () => {
    for (const lib of LIBS) expect(packItems<Species>(lib, 'biomes').length, lib.id).toBeGreaterThanOrEqual(DEFAULT_SPECIES.length);
    expect(allBiomes().some((sp) => sp.id === 'crystal_jungle')).toBe(true);
  });

  it('地标（荒漠里、森林里、绿洲）和圈地名的猜测：按大类认和以前按导出用的地形认相同', () => {
    for (const sp of allBiomes()) {
      expect(biomeGroupOf(sp) === 'desert', sp.id).toBe(sp.terrain === 'desert');
      expect(biomeGroupOf(sp) === 'forest', sp.id).toBe(sp.terrain === 'forest' || sp.terrain === 'jungle');
    }
  });

  it('没写大类的内置生态只有奇幻的五种和三种草原、灌丛；奇幻的三种森林按导出用的地形算进森林', () => {
    const none = allBiomes().filter((sp) => !sp.group).map((sp) => sp.id);
    expect([...new Set(none)].sort()).toEqual(['alpine_meadow', 'bloody_land', 'crystal_jungle', 'dead_forest', 'holy_land', 'savanna', 'shrubland', 'steppe', 'swarm_zone']);
    expect(['crystal_jungle', 'dead_forest', 'swarm_zone'].map((id) => biomeGroupOf(FANTASY_BIOMES.find((b) => b.id === id)!))).toEqual(['forest', 'forest', 'forest']);
  });

  it('手写的 id 表：和以前写的字符串相同', () => {
    // 以前 fantasy-biomes.ts 的 FORESTS
    expect(builtinBiomesIn('forest')).toEqual(['taiga', 'temperate_forest', 'subtropical_forest', 'dry_forest', 'monsoon_forest', 'rainforest']);
    // id 表就是自然包的先后
    expect(Object.values(BIOME_ID)).toEqual(DEFAULT_SPECIES.map((s) => s.id));
    // 虫群侵占的
    expect(FANTASY_BIOMES.find((b) => b.id === 'swarm_zone')!.effects!.invade!.targets).toEqual(['taiga', 'temperate_forest', 'subtropical_forest', 'dry_forest', 'monsoon_forest', 'rainforest', 'crystal_jungle']);
    // 水系（以前 water.ts 写的）
    expect(Object.fromEntries([...REAL_RIVER_TYPES, ...REAL_LAKE_TYPES].filter((t) => t.biomes).map((t) => [t.id, t.biomes]))).toEqual({
      dry_bed: ['desert'],
      seasonal_river: ['desert', 'savanna', 'shrubland'],
      swamp_meander: ['wetland'],
      blackwater_river: ['rainforest', 'monsoon_forest'],
      dry_lake: ['desert', 'savanna', 'shrubland', 'steppe'],
      salt_lake: ['desert', 'steppe', 'shrubland'],
      swamp_lake: ['wetland', 'rainforest', 'monsoon_forest', 'subtropical_forest', 'temperate_forest'],
    });
    // 资源的规则（以前 base.ts 写的）
    const biomeRules = Object.fromEntries(GENERAL_RESOURCES.filter((r) => r.rules.some((x) => x.biomes)).map((r) => [r.id, r.rules.flatMap((x) => (x.biomes ? [x.biomes] : []))]));
    expect(biomeRules).toEqual({ livestock: [['tundra']], wood: [['shrubland']], fur: [['tundra', 'alpine_tundra']] });
  });
});
