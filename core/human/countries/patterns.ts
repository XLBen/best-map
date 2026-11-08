import { contentItems } from '../../content/registry';
import type { SmallState } from '../../world';
import type { Era } from '../era';
import type { CountryRun } from './state';

// 国家格局（第七十三轮）：以前写死在国家一步、集团一步、外交里的几种特例（邦联并成帝国、联邦、同盟、附庸），
// 改成一个个“格局模块”，按固定的先后挂在生成的几个地方。用不用、用多少写在时代里（era.patterns：[{pattern, amount}]），
// pattern 是资源库里的“国家格局”（countryPattern：名字、说明、模块、多少、模块的参数），模块是这里登记的代码。
//
// 钩子（都拿到这一次的 CountryRun 与这个模块的用法；模块按登记的先后调，每个钩子都调——时代没列的模块用法是它的 fallback）：
//   reserve    数完几个国家、挑普通的起点之前：圈预留的地方（g.regions、g.region）、放自己的起点（Seed.region），
//              用掉几个国家（g.rest）。神圣帝国（诸侯林立的一片）在这里；第七十四轮的城邦群、大河帝国、汗国也会在这里
//   grow       往外长之前：往 g.stepCost 里加一条代价（第七十四轮的民族主义、大河、多民族的大国）；Seed.overseas 让殖民地不被放掉
//   after      长完、整理完、建档案之前：g.owner 上合并、切开（第七十四轮的统一、民族国家、后殖民的直线国界）
//   diplomacy  建好档案以后、同盟与敌对之前：g.neighbors、g.overlord、g.metas 上定从属（附庸；第七十四轮的殖民地）
//   relate     领土补齐之后的集团一步：g.bloc 上建帝国、联邦、同盟
// 时代没列的模块照样调（用法的多少是模块的 fallback，通常是 0）。内置的四个在 0 时和第七十二轮以前一样：什么都不做，
// 但照旧从共用的随机流（'blocs'）里取数——取数的先后不变，结果才逐值不变。新的模块在 0 时应当什么都不做，也不取共用流里的数。
// 同一个模块被时代列了几次：多少加起来，参数用第一个

// 模块的一个参数（资源库里画成滑块；写在格局的项里，键就是 key）
export interface PatternParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  // 没写时
  default: number;
  hint?: string;
}

// 几个成员的两个滑块（神圣帝国、城邦群共用这两个键，范围要一样；默认各自的）
export const MEMBER_PARAMS = (min: number, max: number): PatternParam[] => [
  { key: 'minMembers', label: '最少几个', min: 2, max: 30, step: 1, default: min, hint: '不够时整片不要' },
  { key: 'maxMembers', label: '最多几个', min: 2, max: 30, step: 1, default: max, hint: '一片里最多撒几个国家' },
];

// 一个模块这一次的用法
export interface PatternUse {
  // 多少（时代写的；没写时格局自己的；没列时模块的 fallback）
  amount: number;
  // 格局写的参数（没写的不在里面，用 param 取）
  params: Readonly<Record<string, number>>;
  // 用到的格局（id，按时代列的先后）
  patterns: readonly string[];
}

export type PatternHook = 'reserve' | 'grow' | 'after' | 'diplomacy' | 'relate';

export interface PatternModule {
  id: string;
  // 下拉里的名字与说明
  name: string;
  description: string;
  // “多少”是什么意思（资源库里写在滑块旁边）
  amountHint: string;
  params?: readonly PatternParam[];
  // 时代没列这一个模块时的多少（附庸 1：国家之间照旧有附庸；别的 0）
  fallback?: number;
  // 资源库里格局页面上的一句提示（第七十五轮：这个模块做什么、在哪个时代合适）
  tip?: string;
  // 档案里“格局”那一句（第七十五轮）：角色（Seed.role → CountryMeta.role）→ 文字
  roles?: Readonly<Record<string, string>>;
  reserve?(g: CountryRun, use: PatternUse): void;
  grow?(g: CountryRun, use: PatternUse): void;
  after?(g: CountryRun, use: PatternUse): void;
  diplomacy?(g: CountryRun, use: PatternUse): void;
  relate?(g: CountryRun, use: PatternUse): void;
}

// 资源库里的一项（格式见 patterns/index.ts 的 countryPatternSchema：基本的几项 + 各模块的参数，参数平铺在项里）
export interface CountryPattern {
  id: string;
  name: string;
  description?: string;
  module: string;
  amount: number;
  [param: string]: string | number | undefined;
}

const MODULES: PatternModule[] = [];

// 档案里的一句（第七十五轮）：国家在生成时是哪种格局里的什么角色（神圣帝国的成员、民族国家……）；不认得的角色没有
export function roleText(role: string | undefined): string | undefined {
  if (!role) return undefined;
  for (const m of MODULES) {
    const t = m.roles?.[role];
    if (t) return t;
  }
  return undefined;
}

// 登记一个模块（同一个 id 再登记一次是换掉，位置不变）。先后就是调的先后
export function registerPattern(m: PatternModule): void {
  const k = MODULES.findIndex((x) => x.id === m.id);
  if (k >= 0) MODULES[k] = m;
  else MODULES.push(m);
}

export const patternModules = (): readonly PatternModule[] => MODULES;
export const patternModule = (id: string): PatternModule | undefined => MODULES.find((m) => m.id === id);

// 一个参数的值：格局写了的，没写时模块的默认
export function param(m: PatternModule, use: PatternUse, key: string): number {
  return use.params[key] ?? m.params?.find((p) => p.key === key)?.default ?? 0;
}

// 世界里的国家格局
export const worldPatterns = (small: Pick<Partial<SmallState>, 'content'>): readonly CountryPattern[] => Object.values(contentItems<CountryPattern>(small, 'countryPattern'));
export const patternById = (small: Pick<Partial<SmallState>, 'content'>, id: string): CountryPattern | undefined => contentItems<CountryPattern>(small, 'countryPattern')[id];

// 一个格局的参数（只取它的模块认得的、写成数的）
export function patternParams(p: CountryPattern, m: PatternModule | undefined = patternModule(p.module)): Record<string, number> {
  const out: Record<string, number> = {};
  for (const q of m?.params ?? []) {
    const v = p[q.key];
    if (typeof v === 'number') out[q.key] = v;
  }
  return out;
}

// 时代的格局 → 每个模块的用法（按模块登记的先后；世界里没有的格局、不认得的模块不算）
export function patternUses(small: Pick<Partial<SmallState>, 'content'>, era: Pick<Era, 'patterns'> | undefined): Map<string, PatternUse> {
  const out = new Map<string, PatternUse>();
  for (const m of MODULES) out.set(m.id, { amount: m.fallback ?? 0, params: {}, patterns: [] });
  const listed = new Set<string>();
  for (const e of era?.patterns ?? []) {
    const p = patternById(small, e.pattern);
    const m = p && patternModule(p.module);
    if (!p || !m) continue;
    const amount = e.amount ?? p.amount;
    const cur = out.get(m.id)!;
    if (!listed.has(m.id)) {
      listed.add(m.id);
      out.set(m.id, { amount, params: patternParams(p, m), patterns: [p.id] });
    } else out.set(m.id, { amount: cur.amount + amount, params: cur.params, patterns: [...cur.patterns, p.id] });
  }
  return out;
}

// 调一个钩子（按模块的先后）
export function runPatterns(g: CountryRun, hook: PatternHook): void {
  for (const m of MODULES) {
    const f = m[hook];
    if (f) f.call(m, g, g.uses.get(m.id) ?? { amount: m.fallback ?? 0, params: {}, patterns: [] });
  }
}

// 小数的个数：整数部分 + 小数部分的可能多一个（第二十六轮的 countOf；r 总是取的，不管 v 是不是 0）
export const countOf = (v: number | undefined, r: number): number => (v ? Math.floor(v) + (r < v - Math.floor(v) ? 1 : 0) : 0);

