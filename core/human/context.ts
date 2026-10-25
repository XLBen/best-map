import type { Derived, HumanHearth, World } from '../world';
import type { Culture, CultureGroup, Era } from './era';
import type { CellInputs } from './rules';
import type { CountryPlan } from './countries';

// 生成人文时各步共用的东西（第二十二轮，见 generate.ts）：文化圈 → 国家（第二十三轮）→ 领土补齐 → 集团（第二十六轮）→ 人口 → 国家的移民。
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
  // 每格的偏好倍数：组的、文化的（已乘上组的）；只算干的陆地
  groupPref: Float32Array[];
  culturePref: Float32Array[];
  // 拖过的发源地（留着）；文化圈一步放好全部发源地写回这里
  hearths: HumanHearth[];
  // 文化圈：每格归哪个组、哪个文化（下标，−1 没有；海也有，按扩散的结果）
  groupOf?: Int32Array;
  cultureOf?: Int32Array;
  // 人口一步之前可以改：每格人口权重的倍数（省略为 1；第二十三轮的国家按它调）
  popScale?: Float32Array;
  // 不动的格（保留手改的）：人口一步跳过它们
  keep?: Uint8Array;
  // 人口一步的结果：每一份“生成权重”合多少人
  perWeight?: number;
  // 国家（第二十三轮）：要不要生成、怎么生成（省略时没有国家）
  countries?: CountryPlan;
  // 邦联（第二十六轮，国家一步放进来）：一片诸侯林立的地方的成员（国家的编号）与文化组；集团一步并成帝国
  confederations?: { group: string; members: number[] }[];
}

// 生成的一步：按 id 排在别的步前后
export interface HumanStage {
  id: string;
  run(ctx: GenContext): void;
}
