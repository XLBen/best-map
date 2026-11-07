// 第四十轮的测试、测速共用的世界：种子 3 的一块地区或整个星球，划好省份、中世纪的人文与国家（同 tools/bench-layers.ts），
// 再生成城市、道路、地标（国家模式里约上千个城市的框先排）
import { Engine } from '../core/engine';
import { builtinPacks } from '../core/packs/builtin-tree';
import { newWorldContentCommands, packImportCommands } from '../core/packs/import';

// 中世纪包默认的前三个文化组（第四十三轮起是 EU4 的文化组；按包里列的）
// 第七十七轮起命令只写 id：各组占多少是世界里组的比重（内置的组带着库里的比重，和以前按小包的权重发命令一样）
const medievalGroups = () => ((builtinPacks().find((p) => p.id === 'medieval')?.packs ?? []).find((p) => p.id === 'cultures')?.packs ?? []).slice(0, 3).map((n) => n.id);

// 去掉世界里的河湖类型（overlay-ab、compose-ab 的 --plain）
export function dropWaterTypes(eng: Engine): void {
  for (const t of [...(eng.world.small.riverTypes ?? [])]) eng.exec({ op: 'remove_river_type', id: t.id });
  for (const t of [...(eng.world.small.lakeTypes ?? [])]) eng.exec({ op: 'remove_lake_type', id: t.id });
  eng.update();
}

export function r40Engine(globe: boolean, cells: number): Engine {
  const eng = globe
    ? new Engine({ seed: 3, cells, globe: true, aspect: 2, latNorth: 90, latSouth: -90, radiusKm: 6371 })
    : new Engine({ seed: 3, cells });
  eng.exec({ op: 'batch', commands: [...newWorldContentCommands(), { op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true }] });
  eng.exec({ op: 'generate_provinces', rules: { seed: 3 } });
  for (const c of packImportCommands(builtinPacks(), { packs: [['medieval']], groups: medievalGroups() }, eng.world)) eng.exec(c);
  eng.exec({ op: 'generate_human', packs: [['medieval']], groups: medievalGroups(), countries: { seed: 3 } });
  eng.exec({ op: 'generate_settlements' });
  return eng;
}
