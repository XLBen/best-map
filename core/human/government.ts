import { z } from 'zod';
import { contentItems } from '../content/registry';
import { typeIdSchema } from '../type-id';
import type { SmallState } from '../world';
import type { Culture } from './era';
import { HEX } from './terrain-class';

// 第二十三轮：政体与派系——两种内容（都放在 small.content，命令是 set_content）。
// 政体只是“生成的倾向 + 说明”：国土多大、扩张性（吞进多少不兼容的少数群体）、偏不偏海岸、城市化、紧凑、收不收附庸、能不能占恶劣的地方，
// 外加国家的称号（王国、共和国……，可以按文化、文化组换说法）。不带游戏里的数值。
// 派系由时代定义，影响力按国家的人口构成与政体的类别大致算出（见 country-layers.ts 的 countryFactions）

// 称号的一种写法：只写中文（“王国”），或中文加原文的写法（{name} 换成国名的原文：“Kingdom of {name}”）。
// 中文里写了 {name} 时换成国名（“大{name}朝”），没写时接在国名后面
export const titleOne = z.union([
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

// 按等级的称号（第四十三轮，仿 EU4 的 government_names）：一种写法（各等级都用它），或“等级 id → 写法”的表
// （default 是表里没写到的等级；default 也没写时用表里离这一级最近的一级，见 tierTitle）
export const tierTitlesSchema = titleSchema;
const ids = z.array(typeIdSchema).max(64).optional();
// 换说法的一条：几项都写了时都要满足（文化、文化组、取值、取值组各自是“其中之一”）；按先后，第一条满足、又写了这一样的那条起作用
export const nameRuleSchema = z
  .object({
    cultures: ids,
    cultureGroups: ids,
    // 国家的主流文化最典型的取值（宗教……）：取值 id、取值组 id
    values: ids,
    valueGroups: ids,
    titles: tierTitlesSchema.optional(),
    rulers: tierTitlesSchema.optional(),
  })
  .strict();
export type NameRule = z.output<typeof nameRuleSchema>;

export const governmentSchema = z.object({
  id: typeIdSchema,
  name: z.string().min(1).max(20),
  // 类别（几个标签）：monarchy 君主制、republic 共和制、theocracy 神权、tribal 部落、federation 联邦、empire 帝国……；派系按它给基础的影响力
  category: z.array(tag).min(1).max(8),
  description: z.string().max(400).optional(),
  color: HEX.optional(),
  // 国家的称号与统治者的称号（第四十三轮起按国家的等级）：默认的写法，与按文化组、宗教……换说法的几条（names）
  titles: tierTitlesSchema,
  rulers: tierTitlesSchema.optional(),
  names: z.array(nameRuleSchema).max(48).optional(),
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
    // 第四十三轮：与国教（主流文化最典型的取值，维度是 dimension，省略为 religion）的关系——same 信国教的、
    // heretic 同组不同派（异端）、heathen 不同组（异教）
    faith: z.enum(['same', 'heretic', 'heathen']).optional(),
    weight: z.number().min(-10).max(10),
  })
  .strict();
export type FactionDriver = z.output<typeof factionDriverSchema>;

export const factionSchema = z.object({
  id: typeIdSchema,
  name: z.string().min(1).max(20),
  color: HEX,
  description: z.string().max(400).optional(),
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
// 没有这一种时给同一个空数组（第四十轮）
const EMPTY: readonly never[] = [];
function listOf<T>(small: GovSmall, kind: string): readonly T[] {
  const own = small.content?.[kind];
  if (!own) return EMPTY;
  let l = listCache.get(own) as T[] | undefined;
  if (!l) listCache.set(own, (l = Object.values(own) as T[]));
  return l;
}

export const worldGovernments = (small: GovSmall): readonly Government[] => listOf<Government>(small, 'government');
export const worldFactions = (small: GovSmall): readonly Faction[] => listOf<Faction>(small, 'faction');
export const governmentById = (small: GovSmall, id: string): Government | undefined => contentItems<Government>(small, 'government')[id];
export const factionById = (small: GovSmall, id: string): Faction | undefined => contentItems<Faction>(small, 'faction')[id];

// 这个时代能用的政体、派系（第三十轮）：世界里的全部（按加进世界的先后）。时代包的“政体”“派系”小包由界面加进世界，
// 不再按时代项里的列表、政体自己写的时代筛
export const eraGovernments = (small: GovSmall, _era?: unknown): Government[] => [...worldGovernments(small)];
export const eraFactions = (small: GovSmall, _era?: unknown): Faction[] => [...worldFactions(small)];

// 称号按文化取一种写法：文化 id → 文化组 id → default → 第一个（地标的名字、时代的帝国与同盟的称号用；政体的称号见 govTitles）
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

// ---------- 政体的称号（第四十三轮） ----------

// 挑称号时看的：国家的等级（id 与世界里各等级的先后，没有等级时 undefined）、主流文化与文化组、主流文化最典型的取值与它们的组
export interface TitleContext {
  tier?: string;
  // 世界里的等级（按先后）：只要 id 与 order
  tiers: readonly { id: string; order: number }[];
  culture?: string;
  group?: string;
  values: readonly string[];
  valueGroups: readonly string[];
}

const oneTitle = (x: TitleOne): { zh: string; orig?: string } => (typeof x === 'string' ? { zh: x } : x);

// 一张按等级的称号表里这一级的写法：一种写法时就是它；表里有这一级 → default；都没有时 undefined
function exactTitle(t: Title, tier: string | undefined): TitleOne | undefined {
  if (typeof t === 'string' || 'zh' in t) return t as TitleOne;
  const rec = t as Record<string, TitleOne>;
  return (tier !== undefined ? rec[tier] : undefined) ?? rec.default;
}

// 按等级的称号表取一种写法（只看这一张表）：一种写法时就是它；表里有这一级 → default → 世界里离这一级最近的一级
// （一样近时取低的）→ 表里排在正中的一项。国家没有等级时按世界里排在正中的一级
export function tierTitle(t: Title | undefined, tier: string | undefined, tiers: TitleContext['tiers']): { zh: string; orig?: string } | undefined {
  if (t === undefined) return undefined;
  const at = tier ?? tiers[Math.floor(tiers.length / 2)]?.id;
  const hit = exactTitle(t, at);
  if (hit !== undefined) return oneTitle(hit);
  const rec = t as Record<string, TitleOne>;
  const me = tiers.find((x) => x.id === at);
  if (me) {
    let best: { order: number; d: number; v: TitleOne } | undefined;
    for (const x of tiers) {
      const v = rec[x.id];
      if (v === undefined) continue;
      const d = Math.abs(x.order - me.order);
      if (!best || d < best.d || (d === best.d && x.order < best.order)) best = { order: x.order, d, v };
    }
    if (best) return oneTitle(best.v);
  }
  const vals = Object.values(rec);
  return vals.length ? oneTitle(vals[Math.floor((vals.length - 1) / 2)]) : undefined;
}

// 一条换说法满不满足
function ruleMatches(r: NameRule, c: TitleContext): boolean {
  const any = (list: readonly string[] | undefined, have: readonly (string | undefined)[]) => !list?.length || have.some((h) => h !== undefined && list.includes(h));
  return any(r.cultures, [c.culture]) && any(r.cultureGroups, [c.group]) && any(r.values, c.values) && any(r.valueGroups, c.valueGroups);
}

// 一样（国家称号或统治者称号）：满足的几条换说法（按先后）里第一条写了这一级（或 default、或只写一种）的；
// 都没写这一级时用政体默认的（按 tierTitle：没写这一级时取最近的一级）
function pickFor(rules: readonly NameRule[], key: 'titles' | 'rulers', base: Title | undefined, c: TitleContext): { zh: string; orig?: string } | undefined {
  const at = c.tier ?? c.tiers[Math.floor(c.tiers.length / 2)]?.id;
  for (const r of rules) {
    const t = r[key];
    if (t === undefined) continue;
    const hit = exactTitle(t, at);
    if (hit !== undefined) return oneTitle(hit);
  }
  return tierTitle(base, c.tier, c.tiers);
}

// 政体给这个国家的称号与统治者的称号（仿 EU4 的 government_names）：按国家的等级，先看满足的换说法，再看政体默认的
export function govTitles(g: Pick<Government, 'titles' | 'rulers' | 'names'> | undefined, c: TitleContext): { title?: { zh: string; orig?: string }; ruler?: { zh: string; orig?: string } } {
  if (!g) return {};
  const rules = (g.names ?? []).filter((r) => ruleMatches(r, c));
  const title = pickFor(rules, 'titles', g.titles, c);
  const ruler = pickFor(rules, 'rulers', g.rulers, c);
  return { ...(title ? { title } : {}), ...(ruler ? { ruler } : {}) };
}
