import type { Command } from '../../core/commands';
import {
  type CountryPatch,
  type CountryStats,
  type FactionInfluence,
  type FlagSpec,
  type Government,
  allCountryStats,
  countryCodes,
  cultureById,
  eraGovernments,
  worldGovernments,
  estimateCountryCount,
  makeFlag,
  pickTitle,
  titled,
  worldEra,
} from '../../core/human';
import type { Era } from '../../core/human';
import type { LibraryEntry } from '../library';
import { addFromLibrary, itemsInPacks } from './packChoice';
import { type NameMode, nameLines } from '../../core/name-display';
import { COUNTRY_LAYOUTS, type CountryLayout, type CountryMeta, type World } from '../../core/world';

// 国家（第二十三轮）的界面逻辑：有没有国家、一格是哪国、按人口排的列表、各种命令、档案的改动、
// “分裂 ↔ 统一”（地图模式见 map/modes.ts）。不碰界面，测试直接调

type Small = World['small'];

export const NO_COUNTRIES = '先生成国家';

// 生成过国家（small.human.countryRules 在、领土数组在）
export const hasCountries = (w: Pick<World, 'small' | 'causes'>) => !!w.small?.human?.countryRules && !!w.causes?.country && !!w.small.countries;

export const countryOf = (w: Pick<World, 'small'>, id: number | null | undefined): CountryMeta | undefined => (id ? w.small.countries?.[id] : undefined);

// 编号 → 国家（按 small.countries 缓存：只改了名字、人口时也是新的对象，跟着换）
const codeCache = new WeakMap<object, (CountryMeta | null)[]>();
function codesOf(w: Pick<World, 'small'>): (CountryMeta | null)[] {
  const key = w.small.countries ?? w.small;
  let c = codeCache.get(key);
  if (!c) codeCache.set(key, (c = countryCodes(w)));
  return c;
}

// 一格是哪国：陆地（湖面也算）按领土，海按领海（derived.country）；无主为 null
export function countryAt(w: World, cell: number): number | null {
  if (cell < 0 || cell >= w.mesh.n || !hasCountries(w)) return null;
  if (w.causes.land[cell]) {
    const id = w.causes.country![cell];
    return id >= 0 && w.small.countries![id] ? id : null;
  }
  const code = w.derived.country?.[cell] ?? 0;
  return code ? (codesOf(w)[code]?.id ?? null) : null;
}

// 一国的陆地格（按领土数组缓存）
const cellsCache = new WeakMap<Int32Array, Map<number, number[]>>();
export function cellsOf(w: World, id: number): number[] {
  const c = w.causes.country;
  if (!c) return [];
  let m = cellsCache.get(c);
  if (!m) {
    m = new Map();
    for (let i = 0; i < c.length; i++) {
      if (c[i] < 0 || !w.causes.land[i]) continue;
      let l = m.get(c[i]);
      if (!l) m.set(c[i], (l = []));
      l.push(i);
    }
    cellsCache.set(c, m);
  }
  return m.get(id) ?? [];
}

// 全部国家的统计：按领土、人数、省份、各国的档案、城市缓存一份（只换了名字、颜色时照用）
let statsMemo: { key: unknown[]; stats: Map<number, CountryStats> } | null = null;
export function statsOf(w: World): Map<number, CountryStats> {
  // 城市数、首都与陪都（第二十四轮）跟着城市、自定义点、等级变
  const key = [w.causes.country, w.derived.popDensity, w.causes.province, w.small.countries, w.small.popGroups, w.small.cities, w.small.points, w.small.content];
  if (statsMemo && statsMemo.key.every((k, i) => k === key[i])) return statsMemo.stats;
  const stats = hasCountries(w) ? allCountryStats(w) : new Map<number, CountryStats>();
  statsMemo = { key, stats };
  return stats;
}

export interface CountryRow {
  meta: CountryMeta;
  stats: CountryStats | undefined;
  government: string;
  overlord?: CountryMeta;
}

// 列表：按人口从多到少（一样多时按面积、编号）
export function countryRows(w: World): CountryRow[] {
  if (!hasCountries(w)) return [];
  const stats = statsOf(w);
  const metas = w.small.countries!;
  return Object.values(metas)
    .map((m) => ({ meta: m, stats: stats.get(m.id), government: governmentName(w.small, m.government), ...(m.overlord !== undefined && metas[m.overlord] ? { overlord: metas[m.overlord] } : {}) }))
    .sort((a, b) => (b.stats?.population ?? 0) - (a.stats?.population ?? 0) || (b.stats?.areaKm2 ?? 0) - (a.stats?.areaKm2 ?? 0) || a.meta.id - b.meta.id);
}

// 最大的国家（领土笔刷没选时用它）
export const largestCountry = (w: World): CountryMeta | undefined => countryRows(w)[0]?.meta;

export function governmentName(small: Small, id: string): string {
  const g = small.content?.government?.[id] as Government | undefined;
  return g?.name ?? id;
}

// 档案里能选的政体：本世界里的（时代的在前），加上世界用的包里本世界没有的（生成后没用到的清理掉了；第三十轮：选它时先从
// 资源库加进本世界，path 是它在资源库里的小包）。这个国家现在的总在
export interface GovChoice {
  gov: Government;
  path?: string[];
}
export function governmentChoices(w: World, current?: string, lib: readonly LibraryEntry[] = []): GovChoice[] {
  const era = worldEra(w.small);
  const list = eraGovernments(w.small, era);
  const rest = worldGovernments(w.small).filter((g) => !list.some((x) => x.id === g.id));
  const all: GovChoice[] = [...list, ...rest].map((gov) => ({ gov }));
  const cur = current ? (w.small.content?.government?.[current] as Government | undefined) : undefined;
  if (cur && !all.some((g) => g.gov.id === cur.id)) all.unshift({ gov: cur });
  for (const x of itemsInPacks<Government>(w.small.human?.packs ?? [], lib, 'governments')) {
    if (!all.some((g) => g.gov.id === x.item.id)) all.push({ gov: x.item, path: x.path });
  }
  return all;
}

// 换成这个政体的命令：本世界没有的先从资源库加进来（一整步）
export function governmentCommand(w: World, m: CountryMeta, g: GovChoice, lib: readonly LibraryEntry[] = []): Command | null {
  if (g.gov.id === m.government && !g.path) return null;
  if (!g.path) return patchCommand(m.id, { government: g.gov.id });
  const add = addFromLibrary(w.small, lib, 'governments', g.gov.id, g.path);
  return { op: 'batch', label: `政体换成“${g.gov.name}”`, commands: [...add.commands, patchCommand(m.id, { government: add.id })] };
}

// 换成这个政体后的国名（改过名字的不变）
export function titlePreview(w: World, m: CountryMeta, gov: Government): string {
  if (m.nameLocked) return m.name;
  return titled(m.base, pickTitle(gov.title, cultureById(w.small, m.primaryCulture))).zh;
}

// 国名在地图上怎么写（中文 / 原文 / 两者：两者时中文一行、原文一行）
export const countryLabelLines = (m: Pick<CountryMeta, 'name' | 'orig'>, nm: NameMode): string[] => nameLines(m.name, m.orig, nm);

// ---------- 命令 ----------

export const territoryCommand = (cells: number[], id: number | null): Command => ({ op: 'paint_country', cells, country: id });
export const newCountryCommand = (cells: number[]): Command => ({ op: 'new_country', cells });
export const mergeCommand = (a: number, b: number): Command => ({ op: 'merge_countries', a, b });
export const capitalCommand = (id: number, cell: number | null): Command => ({ op: 'move_capital', id, cell });
export const patchCommand = (id: number, patch: CountryPatch): Command => ({ op: 'set_country', id, patch });

// 生成、重新生成国家（“分裂 ↔ 统一”在正中时不写，用默认）。格局（第二十六轮）：按时代时不写；重新生成时与现在的不同才写
export function generateCountriesCommand(fragmentation: number, layout: CountryLayout = 'era'): Command {
  return { op: 'generate_countries', ...(fragmentation !== 0.5 ? { fragmentation } : {}), ...(layout !== 'era' ? { layout } : {}) };
}
export function regenerateCountriesCommand(w: World, fragmentation: number, keepLocked: boolean, layout: CountryLayout = layoutOf(w)): Command {
  const cur = w.small.human?.countryRules?.fragmentation ?? 0.5;
  return { op: 'regenerate_countries', ...(fragmentation !== cur ? { fragmentation } : {}), ...(layout !== layoutOf(w) ? { layout } : {}), ...(keepLocked ? {} : { keepLocked: false }) };
}

// ---------- 格局（第二十六轮） ----------

// 现在的格局（没写是按时代）
export const layoutOf = (w: Pick<World, 'small'>): CountryLayout => w.small.human?.countryRules?.layout ?? 'era';
export { COUNTRY_LAYOUTS };
// 悬停的说明
export const LAYOUT_HINTS: Record<CountryLayout, string> = {
  era: '各种大小的国家按时代的比例',
  mixed: '大国、中等国家、小国、城邦都有',
  petty: '小国、城邦为主，几乎没有大国',
  unified: '大国、帝国占了大半',
  powers: '几个大国并立，中间夹着小国',
};

// ---------- 档案的改动（都是 set_country 的 patch；没变时 null） ----------

// 名字：'' 恢复自动；原文跟着名字
export function namePatch(m: CountryMeta, name: string, orig: string): CountryPatch | null {
  const n = name.trim();
  const o = orig.trim();
  if (!n) return m.nameLocked ? { name: '' } : null;
  if (n === m.name && o === (m.orig ?? '')) return null;
  return { name: n, ...(o ? { orig: o } : {}) };
}

// 统治者：名字不能空
export function rulerPatch(m: CountryMeta, name: string, orig: string, title: string): CountryPatch | null {
  const r = { name: name.trim(), orig: orig.trim(), title: title.trim() };
  if (!r.name) return null;
  if (r.name === m.ruler.name && r.orig === (m.ruler.orig ?? '') && r.title === (m.ruler.title ?? '')) return null;
  return { ruler: { name: r.name, ...(r.orig ? { orig: r.orig } : {}), ...(r.title ? { title: r.title } : {}) } };
}

export function foundedPatch(m: CountryMeta, text: string): CountryPatch | null {
  const t = text.trim().replace(/^公元前\s*/, '-').replace(/\s*年$/, '');
  const v = Number(t);
  if (!t || !Number.isInteger(v) || v < -100000 || v > 100000 || v === m.founded) return null;
  return { founded: v };
}

export const historyPatch = (m: CountryMeta, text: string): CountryPatch | null => (text === m.history ? null : { history: text });

// 年份：-500 写成“公元前 500 年”
export const yearText = (y: number) => (y < 0 ? `公元前 ${-y} 年` : `${y} 年`);

// 换一面旗：同一个政体偏好的样式与纹章，种子换一个
export function rerollFlag(w: World, m: CountryMeta, seed: number): FlagSpec {
  const g = w.small.content?.government?.[m.government] as Government | undefined;
  return makeFlag(seed >>> 0, m.color, { categories: g?.category, layouts: g?.layouts, emblems: g?.emblems });
}

// 改旗上的一种颜色（k = 底色在前的第几种；-1 是纹章的颜色）
export function flagColorPatch(flag: FlagSpec, k: number, color: string): FlagSpec {
  if (k < 0) return { ...flag, emblemColor: color };
  const colors = [...flag.colors];
  colors[k] = color;
  return { ...flag, colors };
}

// 派系：改一个的影响力，别的按比例让出或补上（加起来总是 1，三位小数）
export function factionPatch(list: readonly FactionInfluence[], id: string, value: number): Record<string, number> {
  const v = Math.max(0, Math.min(1, value));
  const rest = list.filter((f) => f.id !== id);
  const restSum = rest.reduce((a, f) => a + f.influence, 0);
  const out: Record<string, number> = {};
  for (const f of list) {
    if (f.id === id) out[f.id] = v;
    else out[f.id] = restSum > 0 ? (f.influence / restSum) * (1 - v) : rest.length ? (1 - v) / rest.length : 0;
  }
  for (const k of Object.keys(out)) out[k] = Math.round(out[k] * 1000) / 1000;
  return out;
}

// 外交：加上、去掉一国
export const withId = (list: readonly number[], id: number) => (list.includes(id) ? [...list] : [...list, id]);
export const withoutId = (list: readonly number[], id: number) => list.filter((x) => x !== id);

// 附庸（宗主是它的）
export const vassalsOf = (w: Pick<World, 'small'>, id: number): CountryMeta[] => Object.values(w.small.countries ?? {}).filter((m) => m.overlord === id);

// ---------- 分裂 ↔ 统一 ----------

// 滑块：左边分裂（fragmentation 1），右边统一（0）
export const fragPos = (f: number) => 1 - f;
export const fragAt = (p: number) => Math.round((1 - Math.max(0, Math.min(1, p))) * 20) / 20;
export function fragText(f: number): string {
  if (f >= 0.8) return '很分裂';
  if (f >= 0.6) return '分裂';
  if (f > 0.4) return '适中';
  if (f > 0.2) return '统一';
  return '很统一';
}

// 滑块悬停的说明：时代会生成联邦（第二十六轮）时说一句，估计里没有联邦切出来的成员邦
export const fragTitle = (era: Pick<Era, 'relations'> | undefined): string => `往左小国多，往右大国少${(era?.relations?.federation ?? 0) > 0 ? '；联邦的成员邦另算' : ''}`;

// 大约几个国家（第二十六轮：核心的 estimateCountryCount，与生成的第一步同一个算法；锁定的国家的地方不算、另外算上；
// 联邦切出来的成员邦不算在里面，所以写“约”）
export function estimateCountries(w: World, f: number, keepLocked = false): number | null {
  const era = worldEra(w.small);
  if (!era || !w.derived.habitability) return null;
  return estimateCountryCount(w, w.derived, era, f, keepLocked);
}

