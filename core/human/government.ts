import { z } from 'zod';
import { contentItems } from '../content/registry';
import { typeIdSchema } from '../type-id';
import type { SmallState } from '../world';
import type { Culture, Era } from './era';
import { HEX } from './terrain-class';

// 第二十三轮：政体与派系——两种内容（都放在 small.content，命令是 set_content）。
// 政体只是“生成的倾向 + 说明”：国土多大、扩张性（吞进多少不兼容的少数群体）、偏不偏海岸、城市化、紧凑、收不收附庸、能不能占恶劣的地方，
// 外加国家的称号（王国、共和国……，可以按文化、文化组换说法）。不带游戏里的数值。
// 派系由时代定义，影响力按国家的人口构成与政体的类别大致算出（见 country-layers.ts 的 countryFactions）

// 称号的一种写法：只写中文（“王国”），或中文加原文的写法（{name} 换成国名的原文：“Kingdom of {name}”）。
// 中文里写了 {name} 时换成国名（“大{name}朝”），没写时接在国名后面
const titleOne = z.union([
  z.string().min(1).max(16),
  z
    .object({ zh: z.string().min(1).max(16), orig: z.string().max(60).optional() })
    .strict(),
]);
export type TitleOne = z.output<typeof titleOne>;
// 称号：一种写法，或按文化换说法（键：文化 id、文化组 id、default；先看文化，再看文化组，最后 default）
export const titleSchema = z.union([titleOne, z.record(typeIdSchema, titleOne)]);
export type Title = z.output<typeof titleSchema>;

const unit = z.number().min(0).max(1);
const tag = z.string().min(1).max(16);

export const governmentSchema = z.object({
  id: typeIdSchema,
  name: z.string().min(1).max(20),
  // 类别（几个标签）：monarchy 君主制、republic 共和制、theocracy 神权、tribal 部落、federation 联邦、empire 帝国……；派系按它给基础的影响力
  category: z.array(tag).min(1).max(8),
  description: z.string().max(400).optional(),
  color: HEX.optional(),
  // 国家的称号与统治者的称号
  title: titleSchema,
  rulerTitle: titleSchema.optional(),
  // 只在这些时代里有（省略时不限）
  eras: z.array(typeIdSchema).max(16).optional(),
  // 被选中的多少（省略为 1）：时代里的政体按它挑
  weight: z.number().min(0).max(100).optional(),
  // ---- 生成的倾向 ----
  // 国土的相对大小（1 是平均；帝国 3、城邦 0.15）
  size: z.number().min(0.05).max(10).default(1),
  // 扩张性：越过文化的边界吞进不兼容的少数群体的多少（0 只占本族的地方，1 不在乎）
  expansion: unit.default(0.3),
  // 偏海岸：越大越贴着海岸长（商业共和国 0.9）
  coastal: unit.default(0),
  // 城市化：首都一带的人口多多少（1 是平常；第二十四轮放城市也用）
  urbanization: z.number().min(0).max(5).default(1),
  // 紧凑：越大越不跨海、越往外越难长
  cohesion: unit.default(0.5),
  // 收附庸的可能（大国旁边的小国成为它的附庸）
  vassals: unit.default(0.2),
  // 游牧：能占宜居度低于时代下限的地方（1 时下限不起作用）
  nomadic: unit.default(0),
  // 旗帜偏好的纹章、样式（flags.ts 的 FLAG_EMBLEMS、FLAG_LAYOUTS；省略时按类别）
  emblems: z.array(typeIdSchema).max(16).optional(),
  layouts: z.array(typeIdSchema).max(16).optional(),
});
export type Government = z.output<typeof governmentSchema>;

// 派系的一个来源：这一部分人（几项都满足的）占国家人口的比例 × weight 加到影响力上
export const factionDriverSchema = z
  .object({
    // 某一维取某个值的人（religion = sun-faith）
    dimension: typeIdSchema.optional(),
    value: typeIdSchema.optional(),
    culture: typeIdSchema.optional(),
    cultureGroup: typeIdSchema.optional(),
    // 主流文化的人 / 不在兼容文化组里的人（少数群体）
    primary: z.boolean().optional(),
    minority: z.boolean().optional(),
    // 住在海边的人
    coastal: z.boolean().optional(),
    weight: z.number().min(-10).max(10),
  })
  .strict();
export type FactionDriver = z.output<typeof factionDriverSchema>;

export const factionSchema = z.object({
  id: typeIdSchema,
  name: z.string().min(1).max(20),
  color: HEX,
  description: z.string().max(400).optional(),
  eras: z.array(typeIdSchema).max(16).optional(),
  // 基础的影响力：政体的类别 → 多少（几个类别都有时取平均；一个都没有时用 default，再没有为 0）
  base: z.record(tag, z.number().min(0).max(10)),
  drivers: z.array(factionDriverSchema).max(16).optional(),
});
export type Faction = z.output<typeof factionSchema>;

// 类别的中文名（界面、档案用；不认识的照写）
export const CATEGORY_NAMES: Record<string, string> = {
  monarchy: '君主制',
  republic: '共和制',
  theocracy: '神权',
  tribal: '部落',
  federation: '联邦',
  empire: '帝国',
  oligarchy: '寡头',
  nomadic: '游牧',
  dictatorship: '独裁',
  democracy: '民主',
  communist: '共产主义',
  fascist: '法西斯',
  corporate: '公司',
  magocracy: '法师统治',
};
export const categoryName = (c: string): string => CATEGORY_NAMES[c] ?? c;

// ---------- 世界里的 ----------

type GovSmall = Pick<Partial<SmallState>, 'content' | 'human'>;

const listCache = new WeakMap<object, unknown[]>();
function listOf<T>(small: GovSmall, kind: string): readonly T[] {
  const own = small.content?.[kind];
  if (!own) return [];
  let l = listCache.get(own) as T[] | undefined;
  if (!l) listCache.set(own, (l = Object.values(own) as T[]));
  return l;
}

export const worldGovernments = (small: GovSmall): readonly Government[] => listOf<Government>(small, 'government');
export const worldFactions = (small: GovSmall): readonly Faction[] => listOf<Faction>(small, 'faction');
export const governmentById = (small: GovSmall, id: string): Government | undefined => contentItems<Government>(small, 'government')[id];
export const factionById = (small: GovSmall, id: string): Faction | undefined => contentItems<Faction>(small, 'faction')[id];

// 这个时代能用的政体、派系：时代写了的（世界里有的）；没写时是世界里写了这个时代或不限时代的
export function eraGovernments(small: GovSmall, era: Pick<Era, 'id' | 'governments'> | undefined): Government[] {
  const all = worldGovernments(small);
  if (era?.governments?.length) return era.governments.map((id) => governmentById(small, id)).filter((g): g is Government => !!g);
  return all.filter((g) => !g.eras || !era || g.eras.includes(era.id));
}
export function eraFactions(small: GovSmall, era: Pick<Era, 'id' | 'factions'> | undefined): Faction[] {
  const all = worldFactions(small);
  if (era?.factions?.length) return era.factions.map((id) => factionById(small, id)).filter((f): f is Faction => !!f);
  return all.filter((f) => !f.eras || !era || f.eras.includes(era.id));
}

// 称号按文化取一种写法：文化 id → 文化组 id → default → 第一个
export function pickTitle(t: Title | undefined, culture: Pick<Culture, 'id' | 'group'> | undefined): { zh: string; orig?: string } | undefined {
  if (t === undefined) return undefined;
  const one = (x: TitleOne) => (typeof x === 'string' ? { zh: x } : x);
  if (typeof t === 'string' || 'zh' in t) return one(t as TitleOne);
  const rec = t as Record<string, TitleOne>;
  const hit = (culture && (rec[culture.id] ?? rec[culture.group])) ?? rec.default ?? Object.values(rec)[0];
  return hit === undefined ? undefined : one(hit);
}

// 国名 = 地名 + 称号（称号的中文里写了 {name} 时换进去）；原文按称号的原文写法，没有时就是地名的原文
export function titled(base: { zh: string; orig?: string }, title: { zh: string; orig?: string } | undefined): { zh: string; orig?: string } {
  if (!title) return { ...base };
  const zh = title.zh.includes('{name}') ? title.zh.replace('{name}', base.zh) : base.zh + title.zh;
  const orig = base.orig ? (title.orig ? title.orig.replace('{name}', base.orig) : base.orig) : undefined;
  return orig ? { zh, orig } : { zh };
}
