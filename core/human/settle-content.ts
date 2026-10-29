import { contentItems } from '../content/registry';
import type { SmallState } from '../world';
import type { CityRank, LandmarkType, PointType } from './settle-types';

// 世界里的城市等级、地标类型、自定义点的类型（第二十四轮）：small.content 里的，按加进世界的先后。
// 第三十轮起内置的也是普通内容（“通用 ▸ 基础”，时代自己的地标在时代包里），新建时默认加进来；
// 没有城市等级时不放城市、道路，没有地标类型时不放地标

// ---------- 世界里的 ----------

type SettleSmall = Pick<Partial<SmallState>, 'content'>;

const EMPTY: readonly never[] = [];
const lists = new WeakMap<object, unknown[]>();
function listOf<T>(small: SettleSmall, kind: string): readonly T[] {
  const own = small.content?.[kind] as Record<string, T> | undefined;
  if (!own) return EMPTY;
  let list = lists.get(own) as T[] | undefined;
  if (!list) lists.set(own, (list = Object.values(own)));
  return list;
}

export const worldCityRanks = (small: SettleSmall): readonly CityRank[] => listOf(small, 'cityRank');
export const worldLandmarkTypes = (small: SettleSmall): readonly LandmarkType[] => listOf(small, 'landmarkType');
export const worldPointTypes = (small: SettleSmall): readonly PointType[] => listOf(small, 'pointType');
export const cityRankById = (small: SettleSmall, id: string): CityRank | undefined => contentItems<CityRank>(small, 'cityRank')[id];
export const landmarkTypeById = (small: SettleSmall, id: string): LandmarkType | undefined => contentItems<LandmarkType>(small, 'landmarkType')[id];
export const pointTypeById = (small: SettleSmall, id: string): PointType | undefined => contentItems<PointType>(small, 'pointType')[id];
export const ownSettleItems = <T>(small: SettleSmall, kind: string): Record<string, T> => contentItems<T>(small, kind);

// 世界里一个城市等级都没有时（第三十轮：不再生成城市；已有的、自己放的城市按这一级显示）
export const PLAIN_RANK: CityRank = { id: 'city', name: '城市', icon: 'circle', level: 1, minShare: 0, label: 1 };

// 首都用的一级（写了 capital 的里 level 最大的；没有时 level 最大的；一级都没有时 PLAIN_RANK）
export function capitalRank(ranks: readonly CityRank[]): CityRank {
  let best: CityRank | undefined;
  for (const r of ranks) if (r.capital && (!best || r.level > best.level)) best = r;
  if (best) return best;
  for (const r of ranks) if (!best || r.level > best.level) best = r;
  return best ?? PLAIN_RANK;
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
  return best ?? low ?? ranks[0] ?? PLAIN_RANK;
}

// 这一级连大道吗
export const isMajorRank = (r: CityRank): boolean => r.major ?? (!!r.capital || r.level >= 3);
