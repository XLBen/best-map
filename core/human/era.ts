import { z } from 'zod';
import { contentItems } from '../content/registry';
import { typeIdSchema } from '../type-id';
import type { SmallState } from '../world';
import { cellRuleSchema } from './rules';
import { HEX } from './terrain-class';

// 第二十二轮：时代、人口维度的取值、文化组、文化——四种内容（都放在 small.content，命令是 set_content）。
// 一个世界一个时代（small.human.era）。人口的维度：文化总是第一维（不写在时代里），时代再列别的维度（宗教、种族、民族认同、意识形态……）；
// 每一维的取值是“人口维度的取值”（popValue），按 dimension 归到某一维。文化组 → 文化两层，同组即兼容。
// 内置的一套在 core/packs/eras/（时代与取值）、core/packs/cultures/（文化组与文化）；用到世界时复制进来（generate_human 自动补上缺的）

// 宜居度的偏好（矮人喜山）：按格的条件（与地形类别的规则同一种写法，见 rules.ts）加一个倍数。
// 写了的几项都满足时宜居度乘以 factor；几条都满足时连乘。条件可以写 classes（地形类别）
export const preferenceSchema = cellRuleSchema.extend({
  factor: z.number().min(0).max(20),
});
export type Preference = z.output<typeof preferenceSchema>;
const prefs = z.array(preferenceSchema).max(16).optional();

// 带权重的一组 id：'a' 或 ['a', 3]（权重省略为 1）
export const weightedIdsSchema = z.array(z.union([typeIdSchema, z.tuple([typeIdSchema, z.number().min(0).max(1000)])])).max(64);
export type WeightedIds = z.output<typeof weightedIdsSchema>;
export const weightedList = (w: WeightedIds | undefined): [string, number][] => (w ?? []).map((x) => (typeof x === 'string' ? [x, 1] : [x[0], x[1]]));

// 时代的一维（文化不写，总是第一维）
export const dimensionSchema = z.object({
  id: typeIdSchema,
  // 维度的名字：宗教、种族、民族认同、意识形态……
  label: z.string().min(1).max(12),
  // 每个人都必须有这一维的取值（没有合适的取值时用这一维第一个取值）。省略时可以没有（“无”）
  required: z.boolean().optional(),
});
export type Dimension = z.output<typeof dimensionSchema>;

export const eraSchema = z.object({
  id: typeIdSchema,
  name: z.string().min(1).max(20),
  description: z.string().max(400).optional(),
  color: HEX.optional(),
  // 文化之外的维度（按先后；最多 3 维）
  dimensions: z.array(dimensionSchema).max(3).default([]),
  // 默认的人口密度：人 / km² 陆地（湖面不算）。默认总人口 = 它 × 陆地面积；地球大小的中世纪星球约 2.7 → 约 4 亿
  popDensity: z.number().min(0.001).max(10000),
  // 人口有多集中：每格的人口 ∝ 宜居度 ^ sparsity（1 均匀些，3 挤在最好的地方）
  sparsity: z.number().min(0.5).max(5).default(1.5),
  // 城市化率（0–1，第二十四轮放城市时用）
  urbanization: z.number().min(0).max(1).default(0.1),
  // 无主地：宜居度低于 minHabitability 的格人口乘以 nomads（0 没人住，1 照常；游牧民可以住恶劣的地方）。
  // 第二十三轮国家也按它留无主地
  unclaimed: z.object({ minHabitability: z.number().min(0).max(1), nomads: z.number().min(0).max(1) }).default({ minHabitability: 0.05, nomads: 0.3 }),
  // 海域归属（第二十三轮）：离岸多少 km 以内的海算领海；0 是海不归任何国家
  seaClaimKm: z.number().min(0).max(2000).default(0),
  // 默认选的文化组与各占多少（新建向导用）
  defaultGroups: weightedIdsSchema.optional(),
  // 只能用这些文化组（省略时不限）
  cultureGroups: z.array(typeIdSchema).max(64).optional(),
  // 以后的轮次用：政体、派系、资源（id）
  governments: z.array(typeIdSchema).max(64).optional(),
  factions: z.array(typeIdSchema).max(64).optional(),
  resources: z.array(typeIdSchema).max(128).optional(),
});
export type Era = z.output<typeof eraSchema>;

// 人口维度的取值：某一种宗教、种族、民族认同、意识形态……
export const popValueSchema = z.object({
  id: typeIdSchema,
  // 属于哪一维（时代的 dimensions 里的 id）
  dimension: typeIdSchema,
  name: z.string().min(1).max(20),
  color: HEX,
  description: z.string().max(400).optional(),
  // 只在这些时代里有（省略时不限）
  eras: z.array(typeIdSchema).max(16).optional(),
  // 有这一取值的人在哪里更多：宜居度的偏好（矮人 × 山地）。只影响一格里的成分，不影响总人数
  prefs,
});
export type PopValue = z.output<typeof popValueSchema>;

export const cultureGroupSchema = z.object({
  id: typeIdSchema,
  name: z.string().min(1).max(20),
  color: HEX,
  description: z.string().max(400).optional(),
  // 喜欢的地理：发源地按它挑，扩张时偏向这些地方，人口也更多住在这里
  prefs,
  // 只在这些时代里有（省略时不限）
  eras: z.array(typeIdSchema).max(16).optional(),
});
export type CultureGroup = z.output<typeof cultureGroupSchema>;

export const cultureSchema = z.object({
  id: typeIdSchema,
  // 文化组的 id
  group: typeIdSchema,
  name: z.string().min(1).max(20),
  color: HEX,
  // 地名风格的 id（core/packs/names/ 里的，或世界里启用的）
  nameStyle: typeIdSchema,
  description: z.string().max(400).optional(),
  // 在组里占多少（省略为 1）
  weight: z.number().min(0).max(1000).optional(),
  // 默认倾向：每一维（维度 id）更可能是哪些取值：['a', 3]、'b'（权重 1）
  tendencies: z.record(typeIdSchema, weightedIdsSchema).optional(),
  // 自己喜欢的地理（与文化组的连乘）
  prefs,
});
export type Culture = z.output<typeof cultureSchema>;

// ---------- 世界里的 ----------

type HumanSmall = Pick<Partial<SmallState>, 'content' | 'human'>;

// 世界里启用的（按启用的先后；编号 = 下标 + 1，0 是没有）。同一个对象的列表缓存着：small.content 每次改都是新对象
const listCache = new WeakMap<object, unknown[]>();
function listOf<T>(small: HumanSmall, kind: string): readonly T[] {
  const own = small.content?.[kind];
  if (!own) return [];
  let l = listCache.get(own) as T[] | undefined;
  if (!l) listCache.set(own, (l = Object.values(own) as T[]));
  return l;
}

export const worldEras = (small: HumanSmall): readonly Era[] => listOf<Era>(small, 'era');
export const worldCultureGroups = (small: HumanSmall): readonly CultureGroup[] => listOf<CultureGroup>(small, 'cultureGroup');
export const worldCultures = (small: HumanSmall): readonly Culture[] => listOf<Culture>(small, 'culture');
export const worldPopValues = (small: HumanSmall): readonly PopValue[] => listOf<PopValue>(small, 'popValue');

// 世界的时代（small.human.era；没有人文、或那个时代停用了时为 undefined）
export function worldEra(small: HumanSmall): Era | undefined {
  const id = small.human?.era;
  return id ? contentItems<Era>(small, 'era')[id] : undefined;
}

// 世界的时代的维度（文化之外的；没有时代时为空）
export const worldDimensions = (small: HumanSmall): readonly Dimension[] => worldEra(small)?.dimensions ?? [];

// 一维的取值（世界里启用的、属于这一维、不限时代或包括世界的时代）；编号 = 下标 + 1。eraId 省略时是世界的时代
const dimCache = new WeakMap<object, Map<string, PopValue[]>>();
export function dimensionValues(small: HumanSmall, dim: string, eraId?: string): readonly PopValue[] {
  const all = worldPopValues(small);
  const era = eraId ?? small.human?.era;
  let m = dimCache.get(all);
  if (!m) dimCache.set(all, (m = new Map()));
  const key = `${dim}|${era ?? ''}`;
  let l = m.get(key);
  if (!l) m.set(key, (l = all.filter((v) => v.dimension === dim && (!v.eras || !era || v.eras.includes(era)))));
  return l;
}

export const cultureById = (small: HumanSmall, id: string): Culture | undefined => contentItems<Culture>(small, 'culture')[id];
export const cultureGroupById = (small: HumanSmall, id: string): CultureGroup | undefined => contentItems<CultureGroup>(small, 'cultureGroup')[id];
export const popValueById = (small: HumanSmall, id: string): PopValue | undefined => contentItems<PopValue>(small, 'popValue')[id];
