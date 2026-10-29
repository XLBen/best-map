import { worldEras } from '../human/era';
import { worldFactions, worldGovernments } from '../human/government';
import { worldResources } from '../human/resources';
import { worldCityRanks, worldLandmarkTypes } from '../human/settle-content';
import { worldTerrainClasses } from '../human/terrain-class';
import { worldStyles } from '../name-styles';
import type { SmallState } from '../world';

// 缺了什么（第三十轮）：基础、自然、地名、时代都是普通的资源包，世界里可能没有。缺了不报错，用到它的那一步跳过：
//   没有生态         → 植被为空（按没有植被画）
//   没有地形类别     → 类别层为空，通行难度、宜居度按平地算，资源规则里的类别按平地算（见 rules.ts 的 compileRule）
//   没有资源         → 没有资源层
//   没有岛的种类     → 放的岛都是普通的岛
//   没有地名风格     → 不起名（地物、省份没有名字，界面照常）
//   没有时代         → 不生成人文；没有文化 → 不生成人口
//   没有政体         → 不生成国家；没有派系 → 国家没有派系的影响力
//   没有城市等级     → 不放城市、道路；没有地标类型 → 不放地标
// 生成的命令（新世界、生成人文 / 国家 / 城市道路地标）把这里的说明放进结果（applyCommand 的 skipped，Worker 的 exec 回复），
// 界面显示一次

export type MissingScope = 'world' | 'human' | 'countries' | 'settlements';

type MissingSmall = Pick<SmallState, 'species' | 'islandTypes'> & Pick<Partial<SmallState>, 'content'>;

export function missingNotes(small: MissingSmall, scopes: readonly MissingScope[]): string[] {
  const out: string[] = [];
  const has = (s: MissingScope) => scopes.includes(s);
  if (has('world')) {
    if (!small.species.length) out.push('没有生态：植被为空');
    if (!worldTerrainClasses(small).length) out.push('没有地形类别：类别层为空，通行、宜居按平地算');
    if (!worldResources(small).length) out.push('没有资源：没有资源层');
    if (!small.islandTypes?.length) out.push('没有岛的种类：放的岛都是普通的岛');
    if (!Object.keys(worldStyles(small)).length) out.push('没有地名风格：不起名');
  }
  if (has('human') && !worldEras(small).length) out.push('没有时代：没有生成人文');
  if (has('countries')) {
    if (!worldGovernments(small).length) out.push('没有政体：没有生成国家');
    else if (!worldFactions(small).length) out.push('没有派系：国家没有派系');
  }
  if (has('settlements')) {
    if (!worldCityRanks(small).length) out.push('没有城市等级：没有放城市和道路');
    if (!worldLandmarkTypes(small).length) out.push('没有地标类型：没有放地标');
  }
  return out;
}
