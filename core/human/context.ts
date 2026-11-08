import type { Derived, HumanHearth, World } from '../world';
import type { Culture, CultureGroup, Era } from './era';
import type { CellInputs } from './rules';
import type { CountryPlan } from './countries';
import type { CountryRun } from './countries/state';

// 生成人文时各步共用的东西（第二十二轮，见 generate.ts）：文化圈 → 人口（第八十四轮挪到国家之前）→ 国家（第二十三轮）→ 领土补齐 → 集团（第二十六轮）
// → 首都（第八十四轮：挪到人口的重心一带、首都一带的人多一些）→ 国家的移民。
// 每一步读前面几步放进来的、再放进自己的结果

export interface GenGroup {
  group: CultureGroup;
  weight: number;
  // 组里用的文化与各占多少（文化的 weight，省略为 1）
  cultures: { culture: Culture; weight: number }[];
}

export interface GenContext {
  world: World;
  d: Derived;
  x: CellInputs;
  // 生效的地形类别（编号 = 下标 + 1）与它们的 id
  cls: Uint8Array;
  classIds: readonly string[];
  era: Era;
  seed: number;
  totalPop: number;
  groups: GenGroup[];
  // 全部用到的文化（按组的先后、组里的先后）；cultureGroup[k] 是第 k 个文化的组（groups 的下标）
  cultures: Culture[];
  cultureGroup: Int32Array;
  // 宜居度（d.habitability）
  hab: Float32Array;
  // 第八十四轮：每格的资源（按世界现在的资源列表现算）
  resource?: Uint8Array;
  // 第八十四轮：分人口用的宜居度（× 资源的倍数，见 resources.ts 的 resourceHabitability；文化圈、国家照旧按 hab）
  popHab?: Float32Array;
  // 每格的偏好倍数：组的、文化的（已乘上组的）；只算干的陆地
  groupPref: Float32Array[];
  culturePref: Float32Array[];
  // 拖过的发源地（留着）；文化圈一步放好全部发源地写回这里
  hearths: HumanHearth[];
  // 文化圈：每格归哪个组、哪个文化（下标，−1 没有；海也有，按扩散的结果）
  groupOf?: Int32Array;
  cultureOf?: Int32Array;
  // 人口一步每格的权重（第八十四轮：首都一带的人多一些那一遍按它算 perWeight，见 population.ts 的 scalePopulation）
  popWeight?: Float64Array;
  // 不动的格（保留手改的）：人口一步跳过它们
  keep?: Uint8Array;
  // 人口一步的结果：每一份“生成权重”合多少人
  perWeight?: number;
  // 国家（第二十三轮）：要不要生成、怎么生成（省略时没有国家）
  countries?: CountryPlan;
  // 这一次生成国家共用的东西（第七十三轮，国家一步放进来，集团一步接着用；第二十六轮的邦联 confederations 在它的 regions 里）
  countryRun?: CountryRun;
}

// 生成的一步：按 id 排在别的步前后
export interface HumanStage {
  id: string;
  run(ctx: GenContext): void;
}
