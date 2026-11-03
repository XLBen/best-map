import { z } from 'zod';
import { contentItems } from '../content/registry';
import { typeIdSchema } from '../type-id';
import type { CountryMeta, SmallState } from '../world';
import type { Era } from './era';

// 国家等级与格局（第四十二轮）：以前写死在 countries.ts 的五档（城邦、小国、中等国家、大国、帝国）与四种格局，
// 改成资源包里的两种内容：国家等级（countryTier，包里的段 countryTiers）、格局（countryLayout，段 countryLayouts），
// 内置的在每个库的“国家等级”（packs/country-tiers.json，新建世界默认带上）。都放在 small.content，命令是 set_content。
// 等级按 order 从小到大排（一样时按 id）：生成挑等级的先后、“比这一级高 / 低”都按这个先后，几档都行（加、删、改名都照常生成）。
// 以前写死的几条规则都是等级的字段：
//   - 面积倍数 area、时代没写比例时的比例 weight、与政体的 size 相配 govSize；
//   - 当附庸的倾向 vassal（以前城邦、小国 1，别的 0.5）；
//   - 能分成联邦 federation（以前大国、帝国）、联邦切出来的成员邦按面积定级 fedMember（以前 0.7 倍以上中等、0.2 倍以上小国、其余城邦）；
//   - 邦联的中心 confedCentre（以前中等）、成员的比例 confedMember（以前城邦 0.35、小国 0.65）；没写时中心取排在正中的一级、成员取最低的一级；
//   - 首都的样子 capitalIcon、capitalAlpha、capitalLabel、capitalBold（地图上画，最高的一级与以前一样）。
// 内置的五档 id 照旧（city、small、medium、large、empire），数值与以前一样：用内置的包生成的世界与第四十一轮逐值相同。
// 世界里一档都没有时按一档“一般”的国家生成（FALLBACK_TIER，不写进国家的档案）

const name = z.string().min(1).max(20);
const amount = z.number().min(0).max(1);

export const countryTierSchema = z.object({
  id: typeIdSchema,
  // 名字（“帝国级行政”）与简称（“帝国级”，列表、档案的一行里写；省略时写名字）
  name,
  short: z.string().min(1).max(10).optional(),
  description: z.string().max(200).optional(),
  // 越大越高
  order: z.number().min(-1000).max(1000),
  // 面积倍数（1 是平均的国家）
  area: z.number().min(0.001).max(1000),
  // 时代没写比例、格局按时代时这一级占多少（省略为 1）
  weight: z.number().min(0).max(100).optional(),
  // 典型的政体大小：挑等级时政体的 size 离它越近越容易挑中
  govSize: z.number().min(0.01).max(100),
  // 当附庸的倾向（乘在宗主政体的“收附庸”上；省略为 0.5）
  vassal: amount.optional(),
  // 能分成联邦（时代有联邦时，这几级里够大的国家按地区分成几个成员邦）
  federation: z.boolean().optional(),
  // 联邦切出来的成员邦：面积至少是平均的国家的几倍时算这一级（写了的几级里取够得上的最高一级）
  fedMember: z.number().min(0).max(1000).optional(),
  // 邦联（时代有邦联时一片诸侯林立的地方）：中心是这一级；成员按 confedMember 的比例挑
  confedCentre: z.boolean().optional(),
  confedMember: z.number().min(0).max(100).optional(),
  // 首都在地图上的样子：图标大小、浓淡、字号的倍数，字加粗（省略为 1、1、1、加粗）
  capitalIcon: z.number().min(0.3).max(2).optional(),
  capitalAlpha: z.number().min(0.1).max(1).optional(),
  capitalLabel: z.number().min(0.3).max(2).optional(),
  capitalBold: z.boolean().optional(),
});
export type CountryTierDef = z.output<typeof countryTierSchema>;

export const countryLayoutSchema = z.object({
  id: typeIdSchema,
  name: z.string().min(1).max(12),
  // 悬停的说明
  description: z.string().max(120).optional(),
  // 各等级（id）占多少；没写的等级为 0，世界里没有的等级不算
  weights: z.record(typeIdSchema, z.number().min(0).max(100)),
});
export type CountryLayoutDef = z.output<typeof countryLayoutSchema>;

// 格局里的“按时代”（不是内容：按时代的 tiers）
export const ERA_LAYOUT = 'era';
export const ERA_LAYOUT_NAME = '按时代';
export const ERA_LAYOUT_HINT = '各等级的国家按时代的比例';

// 世界里一档都没有时
export const FALLBACK_TIER: CountryTierDef = { id: '', name: '一般', order: 0, area: 1, govSize: 1 };

type TierSmall = Pick<Partial<SmallState>, 'content'>;

// 世界里的等级，按 order 从小到大（一样时按 id）。没有时空数组。按 small.content.countryTier 的对象缓存
const sorted = new WeakMap<object, readonly CountryTierDef[]>();
const EMPTY: readonly never[] = [];
export function worldTiers(small: TierSmall): readonly CountryTierDef[] {
  const own = small.content?.countryTier;
  if (!own) return EMPTY;
  let l = sorted.get(own);
  if (!l) {
    l = (Object.values(own) as CountryTierDef[]).sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    sorted.set(own, l);
  }
  return l;
}
// 生成用：没有时一档“一般”
export const genTiers = (small: TierSmall): readonly CountryTierDef[] => {
  const l = worldTiers(small);
  return l.length ? l : [FALLBACK_TIER];
};
export const tierById = (small: TierSmall, id: string | undefined): CountryTierDef | undefined => (id ? contentItems<CountryTierDef>(small, 'countryTier')[id] : undefined);
// 一个国家的等级（自己建的、等级不在世界里时 undefined）
export const tierOfCountry = (small: TierSmall, m: Pick<CountryMeta, 'tier'>): CountryTierDef | undefined => tierById(small, m.tier);
export const tierShort = (t: Pick<CountryTierDef, 'name' | 'short'>): string => t.short ?? t.name;

// 世界里的格局（按加进世界的先后）
const layoutCache = new WeakMap<object, readonly CountryLayoutDef[]>();
export function worldLayouts(small: TierSmall): readonly CountryLayoutDef[] {
  const own = small.content?.countryLayout;
  if (!own) return EMPTY;
  let l = layoutCache.get(own);
  if (!l) layoutCache.set(own, (l = Object.values(own) as CountryLayoutDef[]));
  return l;
}
export const layoutById = (small: TierSmall, id: string | undefined): CountryLayoutDef | undefined => (id && id !== ERA_LAYOUT ? contentItems<CountryLayoutDef>(small, 'countryLayout')[id] : undefined);

// 生效的等级比例（按 tiers 的先后一个一个数）：格局写了（不是 era、世界里有）时按格局，否则按时代的 tiers，
// 时代没写（或世界里的等级全是 0）时按各等级的 weight。没写到的等级为 0；全是 0 时往下一种退
export function tierWeights(tiers: readonly CountryTierDef[], era: Pick<Era, 'tiers'> | undefined, layout: CountryLayoutDef | undefined): number[] {
  const from = (w: Readonly<Record<string, number>> | undefined) => (w ? tiers.map((t) => w[t.id] ?? 0) : null);
  const any = (l: number[] | null): l is number[] => !!l && l.some((v) => v > 0);
  const byLayout = from(layout?.weights);
  if (any(byLayout)) return byLayout;
  const byEra = from(era?.tiers);
  if (any(byEra)) return byEra;
  return tiers.map((t) => t.weight ?? 1);
}

// 当附庸的倾向
export const vassalOf = (t: CountryTierDef): number => t.vassal ?? 0.5;

// 邦联的中心：写了 confedCentre 的第一级（按先后），没有时排在正中的一级
export function confedCentre(tiers: readonly CountryTierDef[]): CountryTierDef {
  return tiers.find((t) => t.confedCentre) ?? tiers[Math.floor(tiers.length / 2)];
}
// 邦联的成员：按 confedMember 的比例（按先后）；一级都没写时最低的一级
export function confedMembers(tiers: readonly CountryTierDef[]): { list: readonly CountryTierDef[]; weight: (t: CountryTierDef) => number } {
  const has = tiers.filter((t) => (t.confedMember ?? 0) > 0);
  return has.length ? { list: has, weight: (t) => t.confedMember ?? 0 } : { list: [tiers[0]], weight: () => 1 };
}

// 联邦切出来的成员邦的等级：面积 a、平均的国家 T。写了 fedMember 的几级里够得上的最高一级；都够不上时其中最低的一级；
// 一级都没写时最低的一级
export function fedMemberTier(tiers: readonly CountryTierDef[], a: number, T: number): CountryTierDef {
  let lowest: CountryTierDef | undefined;
  for (let k = tiers.length - 1; k >= 0; k--) {
    const t = tiers[k];
    if (t.fedMember === undefined) continue;
    if (a >= t.fedMember * T) return t;
    lowest = t;
  }
  return lowest ?? tiers[0];
}

// 首都在地图上的样子（第四十二轮）：等级是世界里最高的一级、没有等级（自己建的）、等级不在世界里时与以前一样（全是 1、加粗）；
// 别的等级按它写的
export interface CapitalLook {
  icon: number;
  alpha: number;
  label: number;
  bold: boolean;
}
export const FULL_CAPITAL: CapitalLook = { icon: 1, alpha: 1, label: 1, bold: true };
export function capitalLook(small: TierSmall, tierId: string | undefined): CapitalLook {
  const t = tierById(small, tierId);
  if (!t) return FULL_CAPITAL;
  const l = worldTiers(small);
  if (l[l.length - 1] === t) return FULL_CAPITAL;
  const icon = t.capitalIcon ?? 1;
  const alpha = t.capitalAlpha ?? 1;
  const label = t.capitalLabel ?? 1;
  const bold = t.capitalBold ?? true;
  return icon === 1 && alpha === 1 && label === 1 && bold ? FULL_CAPITAL : { icon, alpha, label, bold };
}
