// 第四十轮的测试、测速共用的世界：种子 3 的一块地区或整个星球，划好省份、中世纪的人文与国家（同 tools/bench-layers.ts），
// 再生成城市、道路、地标（国家模式里约上千个城市的框先排）
import { Engine } from '../core/engine';
import { builtinPacks } from '../core/packs/builtin-tree';
import { newWorldContentCommands, packImportCommands } from '../core/packs/import';

export function r40Engine(globe: boolean, cells: number): Engine {
  const eng = globe
    ? new Engine({ seed: 3, cells, globe: true, aspect: 2, latNorth: 90, latSouth: -90, radiusKm: 6371 })
    : new Engine({ seed: 3, cells });
  eng.exec({ op: 'batch', commands: [...newWorldContentCommands(), { op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true }] });
  eng.exec({ op: 'generate_provinces', rules: { seed: 3 } });
  for (const c of packImportCommands(builtinPacks(), { packs: [['medieval']], groups: ['western', 'eastern', 'steppe'] }, eng.world)) eng.exec(c);
  eng.exec({ op: 'generate_human', packs: [['medieval']], groups: [{ id: 'western', weight: 3 }, { id: 'eastern', weight: 3 }, { id: 'steppe', weight: 1.5 }], countries: { seed: 3 } });
  eng.exec({ op: 'generate_settlements' });
  return eng;
}
