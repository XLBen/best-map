import { contentItems } from '../content/registry';
import { BUILTIN_LANDMARK_TYPES, BUILTIN_POINT_TYPES, BUILTIN_RANKS } from '../packs/settlements';
import type { SmallState } from '../world';
import type { CityRank, LandmarkType, PointType } from './settle-types';

// 世界里的城市等级、地标类型、自定义点的类型（第二十四轮）：内置的总在，small.content 里同 id 的换掉内置的、别的 id 排在后面

// ---------- 世界里的 ----------

type SettleSmall = Pick<Partial<SmallState>, 'content'>;

// 内置的总在：同 id 的换成世界里的那一份，别的 id 排在后面（按启用的先后）
const lists = new WeakMap<object, unknown[]>();
function merged<T extends { id: string }>(small: SettleSmall, kind: string, builtin: readonly T[]): readonly T[] {
  const own = small.content?.[kind] as Record<string, T> | undefined;
  if (!own) return builtin;
  let list = lists.get(own) as T[] | undefined;
  if (!list) {
    const ids = new Set(builtin.map((b) => b.id));
    list = builtin.map((b) => own[b.id] ?? b);
    for (const [id, x] of Object.entries(own)) if (!ids.has(id)) list.push(x);
    lists.set(own, list);
  }
  return list;
}

export const worldCityRanks = (small: SettleSmall): readonly CityRank[] => merged(small, 'cityRank', BUILTIN_RANKS);
export const worldLandmarkTypes = (small: SettleSmall): readonly LandmarkType[] => merged(small, 'landmarkType', BUILTIN_LANDMARK_TYPES);
export const worldPointTypes = (small: SettleSmall): readonly PointType[] => merged(small, 'pointType', BUILTIN_POINT_TYPES);
export const cityRankById = (small: SettleSmall, id: string): CityRank | undefined => worldCityRanks(small).find((r) => r.id === id);
export const landmarkTypeById = (small: SettleSmall, id: string): LandmarkType | undefined => worldLandmarkTypes(small).find((t) => t.id === id);
export const pointTypeById = (small: SettleSmall, id: string): PointType | undefined => worldPointTypes(small).find((t) => t.id === id);
export const isBuiltinRank = (id: string) => BUILTIN_RANKS.some((r) => r.id === id);
export const isBuiltinLandmarkType = (id: string) => BUILTIN_LANDMARK_TYPES.some((r) => r.id === id);
export const isBuiltinPointType = (id: string) => BUILTIN_POINT_TYPES.some((r) => r.id === id);
// 世界里改过、加的（不含原样的内置项）
export const ownSettleItems = <T>(small: SettleSmall, kind: string): Record<string, T> => contentItems<T>(small, kind);

// 首都用的一级（写了 capital 的里 level 最大的；没有时 level 最大的）
export function capitalRank(ranks: readonly CityRank[]): CityRank {
  let best: CityRank | undefined;
  for (const r of ranks) if (r.capital && (!best || r.level > best.level)) best = r;
  if (best) return best;
  for (const r of ranks) if (!best || r.level > best.level) best = r;
  return best!;
}

// 不是首都的城市按比例、人数定的一级：够得上的里 level 最大的；都够不上时 level 最小的
export function rankFor(ranks: readonly CityRank[], share: number, pop: number): CityRank {
  let best: CityRank | undefined;
  let low: CityRank | undefined;
  for (const r of ranks) {
    if (r.capital) continue;
    if (!low || r.level < low.level) low = r;
    if (share + 1e-12 >= r.minShare && pop >= (r.minPop ?? 0) && (!best || r.level > best.level)) best = r;
  }
  return best ?? low ?? ranks[0];
}

// 这一级连大道吗
export const isMajorRank = (r: CityRank): boolean => r.major ?? (!!r.capital || r.level >= 3);
