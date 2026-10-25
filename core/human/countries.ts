import { HeapLite } from '../mesh';
import { styleById, worldStyleId } from '../name-styles';
import { hashString } from '../names';
import { BUILTIN_FACTIONS, BUILTIN_GOVERNMENTS } from '../packs/governments';
import { mixSeed, mulberry32 } from '../rng';
import type { CountryLayout, CountryMeta, CountryRules, Derived, PopTuple, World } from '../world';
import type { GenContext, HumanStage } from './context';
import { countryBase, personName } from './country-names';
import { edgeCosts } from './cultures';
import { COUNTRY_TIER_IDS, type CountryTier, type Culture, type Era, SUBJECT_KINDS, type SubjectKind, type TierWeights, cultureById, dimensionValues, weightedList } from './era';
import { makeFlag } from './flags';
import { type Government, eraGovernments, governmentById, pickTitle, titled } from './government';
import { GroupTable, SLOTS, type Share, readComp, writeComp } from './groups';
import { COAST } from './rules';
import { cellKm2, distKm, noiseAt } from './space';

// 国家（第二十三轮）：在文化圈与人口之间的一步（见 generate.ts 的 registerHumanStage）。
//   1. 几个国家：能住人的陆地面积 ÷（时代的 countryKm2 × “统一 ↔ 分裂”的倍数），按各文化能住人的面积分给文化；
//   2. 每个国家先按时代与文化的倾向挑一个政体，再在本文化的地盘里挑一个起点（宜居度高、偏海岸的政体挑海边），彼此隔开；
//   3. 各国从起点按代价同时往外长（与文化圈同一套走一条边的代价，再按政体：越过文化的边界——扩张性弱的更难，内陆——偏海岸的更难，
//      下海——紧凑的更难，越远越难——紧凑的更难；强的长得快），每格归先到的那一国。宜居度低于时代 unclaimed.minHabitability 的格
//      不进（游牧的政体按 nomadic 放宽），离起点太远的不要：这些是无主地。海只能穿过，不归国家（领海是推导，见 country-layers.ts）；
//   4. 整理：湖归湖岸上最多的那一国；不连着首都、挨着别国的小块并给邻国；
//   5. 档案：名字（文化的风格起的地名 + 政体的称号）、颜色、旗帜、统治者、建国年份、兼容的文化组、外交（附庸、同盟、敌对）、历史；
//   6. 人口一步之前：首都一带的人口多一些（ctx.popScale，按政体的城市化）；人口一步之后：扩张性强的国家在异族的地方掺进主流文化的人。
// 锁定的国家（重新生成时 keepLocked）领土、档案都不动
// 第二十六轮：每国一个等级（城邦 … 帝国，按时代的 tiers 或格局 countryRules.layout），面积预算 = 平均的国家 × 等级的倍数 ×（0.7–1.3）；
//   第 3 步分两遍：先各长到预算就停，剩下能占的地方再按快慢分给邻国。先按文化的倾向挑政体，再按政体的 size 挑相配的等级。
//   时代有 relations.confederation 时在一个文化组的一片地方撒很多城邦、小国（ctx.confederations，集团一步并成帝国）。
//   之后的两步：领土补齐（claims.ts）、帝国 / 联邦 / 同盟（blocs.ts）

// “统一 ↔ 分裂”在正中时一个国家平均占多少 km² 能住人的陆地（时代没写 countryKm2 时）
export const COUNTRY_KM2 = 1.6e6;
// 建国年份的范围（时代没写 years 时）
export const DEFAULT_YEARS: [number, number] = [500, 1000];
// 一个世界最多几个国家
export const MAX_COUNTRIES = 512;
// 宜居度低到这里的格（冰盖）谁都不占
export const NOBODY = 0.002;
// 时代的宜居度下限不超过这个时，没长到的陆地也分给最近的国家（住满）
const FILL_ALL_HAB = 0.02;

// 生成国家要的参数：generate 新长（keepLocked：锁定的留着），keep 用现有的领土（只调人口）
export interface CountryPlan {
  mode: 'generate' | 'keep';
  rules: CountryRules;
  keepLocked: boolean;
}

// “统一 ↔ 分裂”：fragmentation 0（统一）时国家平均大 8 倍，1（分裂）时小 8 倍
export const sizeFactor = (fragmentation: number): number => Math.pow(8, 1 - 2 * fragmentation);

// 政体、派系：世界里没有时从内置的复制进来（时代写了的；没写时是写了这个时代的；一个都没有时是全部内置的政体）
export function ensureGovContent(world: World, era: Era) {
  const small = world.small;
  const content = { ...(small.content ?? {}) };
  const add = (kind: string, item: { id: string }) => {
    const store = (content[kind] ?? {}) as Record<string, unknown>;
    if (store[item.id]) return;
    content[kind] = { ...store, [item.id]: structuredClone(item) };
  };
  const pickFor = <T extends { id: string; eras?: string[] }>(ids: readonly string[] | undefined, builtin: readonly T[]): T[] =>
    ids?.length ? builtin.filter((x) => ids.includes(x.id)) : builtin.filter((x) => x.eras?.includes(era.id));
  // 时代还没有自己的（世界里、内置的都没有）时，复制全部内置的
  const has = <T extends { eras?: string[] }>(store: unknown) => Object.values((store ?? {}) as Record<string, T>).some((x) => !x.eras || x.eras.includes(era.id));
  let govs = pickFor(era.governments, BUILTIN_GOVERNMENTS);
  if (!govs.length && !has(content.government)) govs = [...BUILTIN_GOVERNMENTS];
  for (const g of govs) add('government', g);
  let facs = pickFor(era.factions, BUILTIN_FACTIONS);
  if (!facs.length && !has(content.faction)) facs = [...BUILTIN_FACTIONS];
  for (const f of facs) add('faction', f);
  if (content.government !== small.content?.government || content.faction !== small.content?.faction) small.content = content;
}

export function ensureCountryArray(world: World): Int32Array {
  return (world.causes.country ??= new Int32Array(world.mesh.n).fill(-1));
}

// 去掉国家（数组留着，撤销时照旧退回）
export function clearCountries(world: World) {
  world.causes.country?.fill(-1);
  delete world.small.countries;
  delete world.small.nextCountry;
  delete world.small.blocs;
  if (world.small.human) delete world.small.human.countryRules;
}

// 国家列表（按编号）；编号 → 图层的编号（下标 + 1）
export function countryList(small: Pick<World['small'], 'countries'>): CountryMeta[] {
  return Object.values(small.countries ?? {}).sort((a, b) => a.id - b.id);
}

// ---------- 颜色 ----------

function hexToHsl(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  const r = ((v >> 16) & 255) / 255;
  const g = ((v >> 8) & 255) / 255;
  const b = (v & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const dd = max - min;
  const s = l > 0.5 ? dd / (2 - max - min) : dd / (max + min);
  const h = max === r ? (g - b) / dd + (g < b ? 6 : 0) : max === g ? (b - r) / dd + 2 : (r - g) / dd + 4;
  return [h * 60, s, l];
}
export function hslToHex(h: number, s: number, l: number): string {
  const hh = ((h % 360) + 360) % 360;
  const k = (n: number) => (n + hh / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// 国家的颜色：主流文化的颜色上按编号挪一挪色相、深浅（同一个文化的几个国家分得开）；已用的颜色避开
export function countryColor(base: string, k: number, used: Set<string>): string {
  const [h, s, l] = hexToHsl(base);
  for (let t = 0; t < 24; t++) {
    const q = k + t * 7;
    const hue = h + (((q * 47) % 61) - 30);
    const sat = Math.min(0.85, Math.max(0.3, s + (((q * 13) % 21) - 10) / 100));
    const lit = Math.min(0.7, Math.max(0.3, l + (((q * 29) % 25) - 12) / 100));
    const c = hslToHex(hue, sat, lit);
    if (!used.has(c)) {
      used.add(c);
      return c;
    }
  }
  return base.toLowerCase();
}

// ---------- 档案的几项（生成与新建国家共用） ----------

// 文化的地名风格（不在世界里时用世界默认）
function styleOf(world: World, culture: Culture | undefined) {
  const small = world.small;
  return (culture && styleById(small, culture.nameStyle)) || styleById(small, worldStyleId(small))!;
}

// 国名：地名 + 称号（按主流文化换说法）
export function countryName(base: { zh: string; orig?: string }, government: Government | undefined, culture: Culture | undefined): { zh: string; orig?: string } {
  return titled(base, pickTitle(government?.title, culture));
}

// 名字、统治者（taken 里的国名避开）
export function nameCountry(world: World, meta: Pick<CountryMeta, 'id' | 'government' | 'primaryCulture'>, seed: number, taken: Set<string>): Pick<CountryMeta, 'name' | 'orig' | 'base' | 'ruler'> {
  const small = world.small;
  const culture = cultureById(small, meta.primaryCulture);
  const gov = governmentById(small, meta.government);
  const style = styleOf(world, culture);
  const s = mixSeed(seed, hashString('country'), meta.id);
  const base = countryBase(style, s, taken);
  const name = countryName(base, gov, culture);
  const person = personName(style, mixSeed(s, 0x7e1));
  const title = pickTitle(gov?.rulerTitle, culture)?.zh;
  return {
    name: name.zh,
    ...(name.orig ? { orig: name.orig } : {}),
    base: base.orig ? { zh: base.zh, orig: base.orig } : { zh: base.zh },
    ruler: { name: person.zh, ...(person.orig ? { orig: person.orig } : {}), ...(title ? { title } : {}) },
  };
}

// 建国年份：时代的年份范围里，偏向近一些的
export function foundedYear(era: Pick<Era, 'years'> | undefined, rand: () => number): number {
  const [a, b] = era?.years ?? DEFAULT_YEARS;
  return Math.round(Math.max(a, b) - Math.pow(rand(), 1.6) * Math.abs(b - a));
}

// 年份的写法：公元前写“前 1500 年”
export const yearText = (y: number): string => (y < 0 ? `前 ${-y} 年` : `${y} 年`);

// 从属的种类的中文名与历史里的一句（第二十六轮）
export const SUBJECT_NAMES: Record<SubjectKind, string> = { vassal: '附庸', protectorate: '保护国', dominion: '自治领', tributary: '朝贡国' };
function subjectLine(kind: SubjectKind | undefined, lord: string): string {
  if (kind === 'protectorate') return `后来受${lord}保护。`;
  if (kind === 'dominion') return `后来成为${lord}的自治领。`;
  if (kind === 'tributary') return `向${lord}称臣纳贡。`;
  return `后来成为${lord}的附庸。`;
}

// 历史（快照，克制的几句）：哪一年谁建立的、附庸、扩张、结盟与不和
export function historyText(world: World, meta: CountryMeta, extra: { minorities?: string[] } = {}): string {
  const small = world.small;
  const culture = cultureById(small, meta.primaryCulture);
  const gov = governmentById(small, meta.government);
  const name = (id: number) => small.countries?.[id]?.name;
  const parts = [`${yearText(meta.founded)}，${culture?.name ?? meta.primaryCulture}建立${meta.name}。`];
  if (meta.overlord !== undefined && name(meta.overlord)) parts.push(subjectLine(meta.subject, name(meta.overlord)!));
  else if ((gov?.expansion ?? 0) >= 0.6 && extra.minorities?.length) parts.push(`此后向外扩张，境内也住着${extra.minorities.slice(0, 3).join('、')}。`);
  else if ((gov?.coastal ?? 0) >= 0.6) parts.push('靠海上的贸易立国。');
  const allies = meta.allies.map(name).filter(Boolean);
  const rivals = meta.rivals.map(name).filter(Boolean);
  if (allies.length) parts.push(`与${allies.join('、')}结盟。`);
  if (rivals.length) parts.push(`与${rivals.join('、')}不和。`);
  return parts.join('');
}

// ---------- 生成 ----------

// 带权重随机挑一个
function pickWeighted<T>(items: readonly T[], w: (x: T) => number, rand: () => number): T | undefined {
  let total = 0;
  for (const x of items) total += Math.max(0, w(x));
  if (!(total > 0)) return items[0];
  let r = rand() * total;
  for (const x of items) {
    r -= Math.max(0, w(x));
    if (r <= 0) return x;
  }
  return items[items.length - 1];
}

// 一个文化挑政体的权重：政体的 weight × 文化的倾向（文化写了 tendencies.government 时，没写到的 × 0.15）
function govWeights(culture: Culture | undefined, govs: readonly Government[]): (g: Government) => number {
  const tend = new Map(weightedList(culture?.tendencies?.government));
  const has = [...tend.keys()].some((id) => govs.some((g) => g.id === id));
  return (g) => (g.weight ?? 1) * (has ? (tend.get(g.id) ?? 0.15) : 1);
}

// 离 src 不到 km 的格（按边的长度走，海、陆都走）：visit 每格一次
function within(world: World, src: number, km: number, visit: (i: number) => void, heap: HeapLite, dist: Float64Array, stamp: Int32Array, tag: number) {
  const { mesh } = world;
  const k = world.kmPerUnit;
  heap.size = 0;
  dist[src] = 0;
  stamp[src] = tag;
  heap.push(src, 0);
  while (heap.size) {
    const i = heap.pop();
    const di = heap.lastKey;
    if (di > dist[i]) continue;
    visit(i);
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      const nd = di + mesh.dist[e] * k;
      if (nd > km) continue;
      if (stamp[j] !== tag || nd < dist[j]) {
        stamp[j] = tag;
        dist[j] = nd;
        heap.push(j, nd);
      }
    }
  }
}

// ---------- 等级与格局（第二十六轮） ----------

// 各等级的面积倍数（1 是平均的国家）
export const COUNTRY_TIERS: Record<CountryTier, number> = { city: 0.12, small: 0.4, medium: 1, large: 3, empire: 9 };
export const TIER_NAMES: Record<CountryTier, string> = { city: '城邦', small: '小国', medium: '中等国家', large: '大国', empire: '帝国' };
// 等级的典型政体大小：挑等级时政体的 size 离它越近越容易挑中
const TIER_GOV_SIZE: Record<CountryTier, number> = { city: 0.15, small: 0.45, medium: 1, large: 2, empire: 3 };
// 时代没写 tiers 时各等级占多少
export const DEFAULT_TIERS: TierWeights = { city: 0.6, small: 2, medium: 3, large: 1.5, empire: 0.4 };
// 格局：换掉时代的比例（era 按时代）
export const LAYOUT_TIERS: Record<Exclude<CountryLayout, 'era'>, TierWeights> = {
  mixed: { city: 2, small: 3, medium: 2, large: 1.5, empire: 0.6 },
  petty: { city: 3, small: 4, medium: 1.5, large: 0.2, empire: 0 },
  unified: { city: 0.3, small: 0.7, medium: 1, large: 2, empire: 1.5 },
  powers: { city: 0.5, small: 2, medium: 0.4, large: 2.5, empire: 0.6 },
};
export const LAYOUT_NAMES: Record<CountryLayout, string> = { era: '按时代', mixed: '混合', petty: '诸侯林立', unified: '大一统', powers: '列强并立' };

// 生效的等级比例：格局写了（不是 era）时按格局，否则按时代（时代没写、或全是 0 时按 DEFAULT_TIERS）
export function tierWeights(era: Pick<Era, 'tiers'> | undefined, layout: CountryLayout | undefined): TierWeights {
  if (layout && layout !== 'era') return LAYOUT_TIERS[layout];
  const t = era?.tiers;
  return t && COUNTRY_TIER_IDS.some((id) => (t[id] ?? 0) > 0) ? t : DEFAULT_TIERS;
}

// 一个国家平均占多少 km² 能住人的陆地
export const averageCountryKm2 = (era: Pick<Era, 'countryKm2'>, fragmentation: number): number => (era.countryKm2 ?? COUNTRY_KM2) * sizeFactor(fragmentation);
// 几个新的国家：能住人的干陆地面积 ÷ 平均的国家面积（有地方时至少 1 个，最多 MAX_COUNTRIES）
export const plannedCountries = (area: number, T: number): number => Math.min(MAX_COUNTRIES, Math.max(area > 0 ? 1 : 0, Math.round(area / T)));

// 大约几个国家（界面的估计；与生成的第一步是同一个算法，各文化正好分完，起点都放得下时就是生成出来的个数）。
// keepLocked：锁定的国家的地方不算，锁定的国家另外算上
export function estimateCountryCount(world: World, d: Pick<Derived, 'habitability' | 'lake'>, era: Era, fragmentation: number, keepLocked = false): number {
  const hab = d.habitability;
  const minH = era.unclaimed.minHabitability;
  const locked = new Set(keepLocked ? Object.values(world.small.countries ?? {}).filter((m) => m.locked).map((m) => m.id) : []);
  const country = world.causes.country;
  let area = 0;
  for (let i = 0; i < world.mesh.n; i++) {
    if (!world.causes.land[i] || d.lake[i] === 1 || hab[i] < minH) continue;
    if (locked.size && country && locked.has(country[i])) continue;
    area += cellKm2(world, i);
  }
  return plannedCountries(area, averageCountryKm2(era, fragmentation)) + locked.size;
}

// 按 mass 分 total 个（最大余数法：加起来正好是 total；mass 是 0 的不分）
function apportion(total: number, mass: Float64Array): Int32Array {
  const out = new Int32Array(mass.length);
  let sum = 0;
  for (const v of mass) sum += v;
  if (!(sum > 0) || total <= 0) return out;
  let given = 0;
  const rem: [number, number][] = [];
  for (let c = 0; c < mass.length; c++) {
    if (!(mass[c] > 0)) continue;
    const q = (total * mass[c]) / sum;
    out[c] = Math.floor(q);
    given += out[c];
    rem.push([q - out[c], c]);
  }
  rem.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let r = 0; given < total && rem.length; r = (r + 1) % rem.length, given++) out[rem[r][1]]++;
  return out;
}

// 起点所在的陆块至少几格（第二十六轮：不在一两格的小岛上立国）
const MIN_SEED_ISLAND = 6;

// 每格所在的陆块（陆地连成的一片，湖面也算）有几格；海是 0
export function landComponentSizes(world: World): Int32Array {
  const { mesh, causes } = world;
  const n = mesh.n;
  const out = new Int32Array(n);
  const stack: number[] = [];
  const comp: number[] = [];
  for (let s = 0; s < n; s++) {
    if (!causes.land[s] || out[s]) continue;
    comp.length = 0;
    out[s] = -1;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (causes.land[j] && !out[j]) {
          out[j] = -1;
          stack.push(j);
        }
      }
    }
    for (const i of comp) out[i] = comp.length;
  }
  return out;
}

// 政体与等级相配的程度：size 与等级的典型大小之比的对数越近越大
const govFit = (g: Government, tier: CountryTier): number => {
  const r = Math.log(g.size / TIER_GOV_SIZE[tier]);
  return Math.exp(-(r * r) / 1.5);
};

const TIER_LIST = [...COUNTRY_TIER_IDS];
const SUBJECT_LIST = [...SUBJECT_KINDS];

interface Seed {
  cell: number;
  // ctx.cultures 的下标
  culture: number;
  gov: Government;
  tier: CountryTier;
  // 面积预算（km² 能住人的干陆地）：长到这么大就先停下
  budget: number;
  // 邦联的下标（不在邦联里为 −1）
  confed: number;
}

function growCountries(ctx: GenContext, plan: CountryPlan) {
  const { world, x, hab, era, d } = ctx;
  const cultureOf = ctx.cultureOf!;
  const { mesh, causes, small } = world;
  const n = mesh.n;
  const country = ensureCountryArray(world);
  const old = small.countries ?? {};
  const kept = plan.keepLocked ? Object.values(old).filter((m) => m.locked) : [];
  const keptIds = new Set(kept.map((m) => m.id));
  for (let i = 0; i < n; i++) if (!causes.land[i] || !keptIds.has(country[i])) country[i] = -1;
  small.countries = Object.fromEntries(kept.map((m) => [m.id, m]));
  // 集团（第二十六轮）：只留锁定的成员（blocs.ts 再整理）
  if (small.blocs) {
    small.blocs = small.blocs.map((b) => ({ ...b, members: b.members.filter((id) => keptIds.has(id)) })).filter((b) => b.members.length);
    if (!small.blocs.length) delete small.blocs;
  }
  // 不留锁定的（整个换掉）时编号从 1 起
  let next = kept.length ? Math.max(1, small.nextCountry ?? 1) : 1;
  const seed = plan.rules.seed >>> 0;
  const minH = era.unclaimed.minHabitability;
  const govs = eraGovernments(small, era);
  if (!govs.length) {
    small.nextCountry = next;
    return;
  }

  // ---- 几个国家 ----
  const K = ctx.cultures.length;
  const areaC = new Float64Array(K);
  const massC = new Float64Array(K);
  let area = 0;
  for (let i = 0; i < n; i++) {
    if (!x.dry[i] || country[i] >= 0 || hab[i] < minH) continue;
    const a = cellKm2(world, i);
    area += a;
    const c = cultureOf[i];
    if (c < 0) continue;
    areaC[c] += a;
    massC[c] += a * hab[i];
  }
  const T = averageCountryKm2(era, plan.rules.fragmentation);
  const total = plannedCountries(area, T);
  let massSum = 0;
  for (let c = 0; c < K; c++) massSum += massC[c];
  const tiers = tierWeights(era, plan.rules.layout);
  const isSeed = new Uint8Array(n);
  const seeds: Seed[] = [];

  // ---- 邦联：一个文化组的一片地方撒很多城邦、小国（blocs.ts 再并成帝国）；占用总个数里的几个 ----
  const region = new Int32Array(n).fill(-1);
  const confeds: { group: number; seeds: Seed[] }[] = [];
  let rest = total;
  const confRand = mulberry32(mixSeed(seed, hashString('country:confederation')));
  const want = era.relations?.confederation ?? 0;
  const nConf = Math.floor(want) + (confRand() < want - Math.floor(want) ? 1 : 0);
  if (nConf > 0 && total >= 10) {
    const G = ctx.groups.length;
    const massG = new Float64Array(G);
    for (let c = 0; c < K; c++) massG[ctx.cultureGroup[c]] += massC[c];
    const usedG = new Set<number>();
    const heap = new HeapLite(1024);
    const dist = new Float64Array(n);
    for (let q = 0; q < nConf; q++) {
      const nc = Math.min(12, Math.max(5, Math.round(total * 0.2)));
      // 剩下的至少一半给别的地方
      if (rest - nc < Math.ceil(total / 2)) break;
      const choices = [...Array(G).keys()].filter((g) => !usedG.has(g) && massG[g] >= 0.1 * massSum);
      if (!choices.length) break;
      const g = pickWeighted(choices, (v) => massG[v], confRand)!;
      usedG.add(g);
      const inGroup = (i: number) => x.dry[i] === 1 && country[i] < 0 && hab[i] >= minH && cultureOf[i] >= 0 && ctx.cultureGroup[cultureOf[i]] === g && region[i] < 0;
      // 中心：这一组里宜居度最高的格（加一点噪声）
      const ns = mixSeed(seed, hashString('confederation-center'), q);
      let center = -1;
      let cs = -Infinity;
      for (let i = 0; i < n; i++) {
        if (!inGroup(i)) continue;
        const s = hab[i] * (1 + 0.35 * noiseAt(world, ns, 500, i));
        if (s > cs) {
          cs = s;
          center = i;
        }
      }
      if (center < 0) continue;
      // 从中心往外（按 km）长到 nc × 0.3 个平均国家那么大
      const target = nc * 0.3 * T;
      const cells: number[] = [];
      let got = 0;
      dist.fill(Infinity);
      heap.size = 0;
      dist[center] = 0;
      heap.push(center, 0);
      while (heap.size && got < target) {
        const i = heap.pop();
        const di = heap.lastKey;
        if (di > dist[i] || region[i] >= 0) continue;
        region[i] = confeds.length;
        cells.push(i);
        got += cellKm2(world, i);
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
          const j = mesh.adj[e];
          if (!inGroup(j)) continue;
          const nd = di + mesh.dist[e] * world.kmPerUnit;
          if (nd < dist[j]) {
            dist[j] = nd;
            heap.push(j, nd);
          }
        }
      }
      // 地方不够（文化组太零碎）：不要这一片
      if (got < 0.5 * target) {
        for (const i of cells) region[i] = -1;
        continue;
      }
      // 起点：一个个挑离已有的起点最远（宜居度高的优先）的格
      const minD = new Float64Array(n).fill(Infinity);
      const list: Seed[] = [];
      const rand = mulberry32(mixSeed(seed, hashString('confederation'), q));
      const k0 = confeds.length;
      let pick = center;
      for (let s = 0; s < nc && pick >= 0; s++) {
        isSeed[pick] = 1;
        const c = cultureOf[pick];
        const culture = ctx.cultures[c];
        const tier: CountryTier = rand() < 0.35 ? 'city' : 'small';
        const w = govWeights(culture, govs);
        const gov = pickWeighted(govs, (gg) => w(gg) * govFit(gg, tier), rand)!;
        list.push({ cell: pick, culture: c, gov, tier, budget: T * COUNTRY_TIERS[tier] * (0.7 + 0.6 * rand()), confed: k0 });
        // 离起点的距离（只在这一片里走）
        heap.size = 0;
        minD[pick] = 0;
        heap.push(pick, 0);
        while (heap.size) {
          const i = heap.pop();
          const di = heap.lastKey;
          if (di > minD[i]) continue;
          for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
            const j = mesh.adj[e];
            if (region[j] !== k0) continue;
            const nd = di + mesh.dist[e] * world.kmPerUnit;
            if (nd < minD[j]) {
              minD[j] = nd;
              heap.push(j, nd);
            }
          }
        }
        pick = -1;
        let best = 0;
        for (const i of cells) {
          if (isSeed[i]) continue;
          const v = minD[i] * Math.sqrt(Math.max(hab[i], 0.01));
          if (v > best) {
            best = v;
            pick = i;
          }
        }
      }
      confeds.push({ group: g, seeds: list });
      rest -= list.length;
    }
  }

  // ---- 分给各文化（按能住人的面积，正好分完）、挑等级与政体、起点 ----
  const counts = apportion(rest, massC);
  // 起点不放在太小的岛上（别处都没有地方时才放）
  const islandSize = landComponentSizes(world);
  const blocked = new Uint8Array(n);
  const heap = new HeapLite(1024);
  const wdist = new Float64Array(n);
  const stamp = new Int32Array(n).fill(-1);
  // 先按文化的倾向挑政体，再挑等级（时代或格局的比例 × 与政体的大小相配）；面积预算 = 平均的国家 × 等级的倍数 ÷ 实际挑出的平均倍数
  const slotsOf: { tier: CountryTier; gov: Government; budget: number }[][] = [];
  let mSum = 0;
  let mCount = 0;
  for (let c = 0; c < K; c++) {
    const list: { tier: CountryTier; gov: Government; budget: number }[] = (slotsOf[c] = []);
    if (!counts[c]) continue;
    const culture = ctx.cultures[c];
    const rand = mulberry32(mixSeed(seed, hashString(`country:${culture.id}`)));
    const w = govWeights(culture, govs);
    for (let k = 0; k < counts[c]; k++) {
      const gov = pickWeighted(govs, w, rand)!;
      const tier = pickWeighted(TIER_LIST, (t) => (tiers[t] ?? 0) * govFit(gov, t), rand)!;
      list.push({ tier, gov, budget: COUNTRY_TIERS[tier] * (0.7 + 0.6 * rand()) });
      mSum += COUNTRY_TIERS[tier];
      mCount++;
    }
  }
  const meanM = mCount ? mSum / mCount : 1;
  for (let c = 0; c < K; c++) {
    if (!counts[c]) continue;
    const culture = ctx.cultures[c];
    const slots = slotsOf[c];
    for (const s of slots) s.budget *= T / meanM;
    // 大的先挑地方
    slots.sort((a, b) => b.budget - a.budget || (a.gov.id < b.gov.id ? -1 : 1));
    let cands: number[] = [];
    for (let i = 0; i < n; i++) if (cultureOf[i] === c && x.dry[i] && country[i] < 0 && hab[i] >= minH && region[i] < 0) cands.push(i);
    // 整个文化都在邦联的那片里：也在那里挑
    if (!cands.length) for (let i = 0; i < n; i++) if (cultureOf[i] === c && x.dry[i] && country[i] < 0 && hab[i] >= minH) cands.push(i);
    if (cands.some((i) => islandSize[i] >= MIN_SEED_ISLAND)) cands = cands.filter((i) => islandSize[i] >= MIN_SEED_ISLAND);
    if (!cands.length) continue;
    const ns = mixSeed(seed, hashString(`country-seed:${culture.id}`));
    const jitter = Float32Array.from(cands, (i) => 1 + 0.35 * noiseAt(world, ns, 500, i));
    for (const slot of slots) {
      const gov = slot.gov;
      const score = (q: number) => {
        const i = cands[q];
        const coast = (x.flags[i] & COAST) !== 0;
        return hab[i] * jitter[q] * (coast ? 1 + 2 * gov.coastal : 1 - 0.6 * gov.coastal);
      };
      let best = -1;
      let bs = -Infinity;
      for (let pass = 0; pass < 2 && best < 0; pass++) {
        for (let q = 0; q < cands.length; q++) {
          const i = cands[q];
          if (isSeed[i] || (pass === 0 && blocked[i])) continue;
          const s = score(q);
          if (s > bs) {
            bs = s;
            best = i;
          }
        }
      }
      if (best < 0) break;
      isSeed[best] = 1;
      seeds.push({ cell: best, culture: c, gov, tier: slot.tier, budget: slot.budget, confed: -1 });
      // 起点彼此隔开：间距按面积预算的平方根（不超过这个文化的地盘）
      const gap = 0.6 * Math.sqrt(Math.min(slot.budget, areaC[c]));
      within(world, best, gap, (i) => (blocked[i] = 1), heap, wdist, stamp, seeds.length);
    }
  }
  for (const cf of confeds) seeds.push(...cf.seeds);
  const k = seeds.length;
  if (!k) {
    small.nextCountry = next;
    return;
  }

  // ---- 往外长 ----
  const rand = mulberry32(mixSeed(seed, hashString('country:grow')));
  const speed = new Float64Array(k);
  const R = new Float64Array(k);
  const cap = new Float64Array(k);
  const thr = new Float64Array(k);
  const sameMul = new Float64Array(k);
  const otherMul = new Float64Array(k);
  const coastMul = new Float64Array(k);
  const seaMul = new Float64Array(k);
  const coh = new Float64Array(k);
  const prim = new Int32Array(k);
  const primGroup = new Int32Array(k);
  const budget = new Float64Array(k);
  seeds.forEach((s, o) => {
    const g = s.gov;
    // 第二十六轮：快慢、范围按面积预算（等级），倾向仍按政体
    speed[o] = Math.sqrt(s.budget / T) * (0.85 + 0.3 * rand());
    R[o] = Math.sqrt(s.budget / Math.PI);
    cap[o] = 20 * R[o];
    thr[o] = Math.max(NOBODY, minH * (1 - g.nomadic));
    sameMul[o] = 1 + 0.6 * (1 - g.expansion);
    otherMul[o] = 1 + 2.5 * (1 - g.expansion);
    coastMul[o] = 1 + 3 * g.coastal;
    seaMul[o] = 1 + 3 * g.cohesion;
    coh[o] = g.cohesion;
    prim[o] = s.culture;
    primGroup[o] = ctx.cultureGroup[s.culture];
    budget[o] = s.budget;
  });
  const edge = edgeCosts(ctx);
  const owner = new Int32Array(n).fill(-1);
  const dist = new Float64Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  // 锁定的国家的格不进
  for (let i = 0; i < n; i++) if (country[i] >= 0) owner[i] = -2;
  const grow = new HeapLite(n);
  seeds.forEach((s, o) => {
    owner[s.cell] = o;
    dist[s.cell] = 0;
    grow.push(s.cell, 0);
  });
  const { off, adj } = mesh;
  const land = causes.land;
  const lake = d.lake;
  // o 从 i（距离 di）走边 e 到 j 的距离（进不去时为 Infinity）
  const stepTo = (o: number, di: number, e: number, j: number): number => {
    let c = edge[e];
    if (land[j]) {
      if (lake[j] !== 1) {
        if (hab[j] < thr[o]) return Infinity;
        const cj = cultureOf[j];
        if (cj >= 0 && cj !== prim[o]) c *= ctx.cultureGroup[cj] === primGroup[o] ? sameMul[o] : otherMul[o];
        if (!(x.flags[j] & COAST)) c *= coastMul[o];
      }
    } else c *= seaMul[o];
    return di + (c / speed[o]) * (1 + (coh[o] * di) / (2 * R[o]));
  };
  const claimed = new Float64Array(k);
  const full = new Uint8Array(k);
  // 第一遍：每国长到面积预算就停（还没定下的格让给挨着的、没长够的国家）；第二遍：剩下能占的地方大家接着长（快的多占）
  const run = (budgeted: boolean) => {
    while (grow.size) {
      const i = grow.pop();
      const di = grow.lastKey;
      // 过时的（让出去的格的距离变了）跳过
      if (di !== dist[i] || owner[i] < 0) continue;
      const o = owner[i];
      if (!done[i]) {
        if (budgeted && full[o]) {
          let best = -1;
          let bd = Infinity;
          for (let e = off[i]; e < off[i + 1]; e++) {
            const j = adj[e];
            const q = owner[j];
            if (!done[j] || q < 0 || full[q]) continue;
            for (let f = off[j]; f < off[j + 1]; f++) {
              if (adj[f] !== i) continue;
              const nd = stepTo(q, dist[j], f, i);
              if (nd <= cap[q] && (nd < bd || (nd === bd && q < best))) {
                bd = nd;
                best = q;
              }
              break;
            }
          }
          owner[i] = best;
          dist[i] = bd;
          if (best >= 0) grow.push(i, bd);
          continue;
        }
        done[i] = 1;
        if (budgeted && x.dry[i] && hab[i] >= minH) {
          claimed[o] += cellKm2(world, i);
          if (claimed[o] >= budget[o]) full[o] = 1;
        }
      }
      for (let e = off[i], end = off[i + 1]; e < end; e++) {
        const j = adj[e];
        if (owner[j] === -2 || done[j]) continue;
        const nd = stepTo(o, di, e, j);
        if (nd > cap[o] || nd >= dist[j]) continue;
        dist[j] = nd;
        owner[j] = o;
        grow.push(j, nd);
      }
    }
  };
  run(true);
  for (let i = 0; i < n; i++) if (done[i] && owner[i] >= 0) grow.push(i, dist[i]);
  run(false);
  // 时代要“住满”（宜居度下限很低，如现代）：上面没长到的陆地归最近的国家（只走陆地，不限远近与宜居度）
  if (minH <= FILL_ALL_HAB) {
    const fill = new HeapLite(n);
    for (let i = 0; i < n; i++) if (owner[i] >= 0 && land[i]) fill.push(i, dist[i]);
    while (fill.size) {
      const i = fill.pop();
      const di = fill.lastKey;
      if (di > dist[i]) continue;
      for (let e = off[i], end = off[i + 1]; e < end; e++) {
        const j = adj[e];
        if (!land[j] || owner[j] !== -1) continue;
        const nd = di + edge[e];
        dist[j] = nd;
        owner[j] = owner[i];
        fill.push(j, nd);
      }
    }
  }
  // 海不归国家；锁定的国家的格还原
  for (let i = 0; i < n; i++) if (!land[i] || owner[i] === -2) owner[i] = -1;

  // ---- 湖：归湖岸上最多的那一国 ----
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (seen[s] || !land[s] || lake[s] !== 1) continue;
    const comp: number[] = [];
    const shore = new Map<number, number>();
    seen[s] = 1;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      for (let e = off[i]; e < off[i + 1]; e++) {
        const j = adj[e];
        if (!land[j]) continue;
        if (lake[j] === 1) {
          if (!seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        } else if (owner[j] >= 0) shore.set(owner[j], (shore.get(owner[j]) ?? 0) + 1);
      }
    }
    let best = -1;
    let bc = 0;
    for (const [key, v] of shore) if (v > bc || (v === bc && key < best)) {
      bc = v;
      best = key;
    }
    for (const i of comp) {
      if (country[i] >= 0) continue;
      owner[i] = best >= 0 ? best : -1;
    }
  }

  // ---- 不连着首都、挨着别国的小块并给邻国 ----
  const sizeOf = new Int32Array(k);
  for (let i = 0; i < n; i++) if (owner[i] >= 0) sizeOf[owner[i]]++;
  const comp = new Int32Array(n).fill(-1);
  let cid = 0;
  for (let s = 0; s < n; s++) {
    const o = owner[s];
    if (o < 0 || comp[s] >= 0) continue;
    const cells: number[] = [];
    let hasSeed = false;
    const border = new Map<number, number>();
    comp[s] = cid;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      cells.push(i);
      if (i === seeds[o].cell) hasSeed = true;
      for (let e = off[i]; e < off[i + 1]; e++) {
        const j = adj[e];
        if (!land[j]) continue;
        if (owner[j] === o) {
          if (comp[j] < 0) {
            comp[j] = cid;
            stack.push(j);
          }
        } else if (owner[j] >= 0) border.set(owner[j], (border.get(owner[j]) ?? 0) + 1);
      }
    }
    cid++;
    if (hasSeed || cells.length >= Math.max(3, 0.2 * sizeOf[o]) || !border.size) continue;
    let best = -1;
    let bc = 0;
    for (const [q, v] of border) if (v > bc || (v === bc && q < best)) {
      bc = v;
      best = q;
    }
    // 邻国按自己的宜居度下限占不了的格成无主地
    for (const i of cells) owner[i] = !x.dry[i] || hab[i] >= thr[best] ? best : -1;
    sizeOf[o] -= cells.length;
    sizeOf[best] += cells.length;
  }

  // ---- 写进原因、建档案 ----
  const ids = seeds.map(() => next++);
  for (let i = 0; i < n; i++) if (owner[i] >= 0) country[i] = ids[owner[i]];
  small.nextCountry = next;
  const used = new Set(kept.map((m) => m.color));
  const taken = new Set(kept.map((m) => m.name));
  const perCulture = new Int32Array(K);
  // 每国各文化组能住人的面积（兼容的文化组：主流的组 + 占三成以上的组）
  const groupMass = seeds.map(() => new Map<number, number>());
  const cultureMass = seeds.map(() => new Map<number, number>());
  const areaOf = new Float64Array(k);
  for (let i = 0; i < n; i++) {
    const o = owner[i];
    if (o < 0 || !x.dry[i]) continue;
    const a = cellKm2(world, i);
    areaOf[o] += a;
    const c = cultureOf[i];
    if (c < 0) continue;
    const m = a * Math.max(hab[i], 0.01);
    const g = ctx.cultureGroup[c];
    groupMass[o].set(g, (groupMass[o].get(g) ?? 0) + m);
    cultureMass[o].set(c, (cultureMass[o].get(c) ?? 0) + m);
  }
  const yearRand = mulberry32(mixSeed(seed, hashString('country:year')));
  const metas: CountryMeta[] = seeds.map((s, o) => {
    const culture = ctx.cultures[s.culture];
    const id = ids[o];
    const gm = groupMass[o];
    let sum = 0;
    for (const v of gm.values()) sum += v;
    const accepted = [ctx.groups[primGroup[o]].group.id];
    for (const [g, v] of [...gm].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
      const gid = ctx.groups[g].group.id;
      if (!accepted.includes(gid) && sum > 0 && v / sum >= 0.3) accepted.push(gid);
    }
    const color = countryColor(culture.color, perCulture[s.culture]++, used);
    const meta: CountryMeta = {
      id,
      name: '',
      base: { zh: '' },
      color,
      flag: makeFlag(mixSeed(seed, hashString('flag'), id), color, { categories: s.gov.category, layouts: s.gov.layouts, emblems: s.gov.emblems }),
      capitalCell: s.cell,
      government: s.gov.id,
      primaryCulture: culture.id,
      acceptedGroups: accepted,
      allies: [],
      rivals: [],
      ruler: { name: '' },
      founded: foundedYear(era, yearRand),
      history: '',
      tier: s.tier,
    };
    Object.assign(meta, nameCountry(world, meta, seed, taken));
    return meta;
  });
  for (const m of metas) small.countries[m.id] = m;
  // 邦联的成员（blocs.ts 并成帝国）
  ctx.confederations = confeds
    .map((cf, q) => ({ group: ctx.groups[cf.group].group.id, members: seeds.flatMap((s, o) => (s.confed === q ? [ids[o]] : [])) }))
    .filter((cf) => cf.members.length >= 2);

  // ---- 外交 ----
  diplomacy(ctx, seeds, metas, owner, areaOf, seed);
  for (let o = 0; o < k; o++) {
    const m = metas[o];
    // 境内的异族（不在兼容的文化组里、占一成以上的文化）
    let sum = 0;
    for (const v of cultureMass[o].values()) sum += v;
    const minorities = [...cultureMass[o]]
      .filter(([c, v]) => sum > 0 && v / sum >= 0.1 && !m.acceptedGroups.includes(ctx.groups[ctx.cultureGroup[c]].group.id))
      .sort((a, b) => b[1] - a[1])
      .map(([c]) => ctx.cultures[c].name);
    m.history = historyText(world, m, { minorities });
  }
}

// 附庸、同盟、敌对（只在新长出来的国家之间）：邻国（陆上接壤，或隔着一格海）
function diplomacy(ctx: GenContext, seeds: Seed[], metas: CountryMeta[], owner: Int32Array, areaOf: Float64Array, seed: number) {
  const { world, era } = ctx;
  const { mesh, causes } = world;
  const k = seeds.length;
  const pairs = new Map<number, number>();
  const add = (a: number, b: number, w: number) => {
    if (a === b || a < 0 || b < 0) return;
    const key = a < b ? a * k + b : b * k + a;
    pairs.set(key, (pairs.get(key) ?? 0) + w);
  };
  for (let i = 0; i < mesh.n; i++) {
    if (causes.land[i]) {
      const a = owner[i];
      if (a < 0) continue;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (j > i && causes.land[j]) add(a, owner[j], 1);
      }
    } else {
      const near: number[] = [];
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const o = owner[mesh.adj[e]];
        if (causes.land[mesh.adj[e]] && o >= 0 && !near.includes(o)) near.push(o);
      }
      for (let p = 0; p < near.length; p++) for (let q = p + 1; q < near.length; q++) add(near[p], near[q], 0.5);
    }
  }
  const neighbors: number[][] = seeds.map(() => []);
  const keys = [...pairs.keys()].sort((a, b) => a - b);
  for (const key of keys) {
    const a = Math.floor(key / k);
    const b = key % k;
    neighbors[a].push(b);
    neighbors[b].push(a);
  }
  const group = (o: number) => ctx.cultureGroup[seeds[o].culture];
  // 附庸：从小到大看，旁边大三倍以上的国家按它的 vassals 收下；最多两层（第二十六轮：附庸也可以有自己的附庸）。
  // 邦联的成员不当别国的附庸（它们是帝国的诸侯）。从属的种类按时代的 relations.subjects 挑
  const overlord = new Int32Array(k).fill(-1);
  // 下面有几层附庸
  const below = new Int32Array(k);
  const above = (o: number) => {
    let dd = 0;
    for (let a = overlord[o]; a >= 0; a = overlord[a]) dd++;
    return dd;
  };
  const subjects = era.relations?.subjects;
  const kinds = subjects ? SUBJECT_LIST.filter((s) => (subjects[s] ?? 0) > 0) : [];
  const order = seeds.map((_, o) => o).sort((a, b) => areaOf[a] - areaOf[b] || a - b);
  for (const v of order) {
    if (below[v] >= 2 || seeds[v].confed >= 0) continue;
    let best = -1;
    for (const u of neighbors[v]) {
      if (areaOf[u] < 3 * areaOf[v] || below[v] + 1 + above(u) > 2) continue;
      if (best < 0 || areaOf[u] > areaOf[best] || (areaOf[u] === areaOf[best] && u < best)) best = u;
    }
    if (best < 0) continue;
    const rr = mulberry32(mixSeed(seed, hashString('vassal'), v));
    const small = seeds[v].tier === 'city' || seeds[v].tier === 'small';
    const p = seeds[best].gov.vassals * (group(best) === group(v) ? 1 : 0.5) * (small ? 1 : 0.5) * (below[v] > 0 || above(best) > 0 ? 0.5 : 1);
    if (rr() >= p) continue;
    overlord[v] = best;
    for (let a = best, dd = below[v] + 1; a >= 0; a = overlord[a], dd++) below[a] = Math.max(below[a], dd);
    metas[v].overlord = metas[best].id;
    if (kinds.length) metas[v].subject = pickWeighted(kinds, (s) => subjects![s] ?? 0, rr)!;
  }
  // 同盟、敌对：亲近（同一个文化 2、同一个组 1、兼容 0.5、别的 −1，同一类政体再 + 0.5）
  for (const key of keys) {
    const a = Math.floor(key / k);
    const b = key % k;
    if (overlord[a] === b || overlord[b] === a) continue;
    const ma = metas[a];
    const mb = metas[b];
    let aff = seeds[a].culture === seeds[b].culture ? 2 : group(a) === group(b) ? 1 : ma.acceptedGroups.some((g) => mb.acceptedGroups.includes(g)) ? 0.5 : -1;
    if (seeds[a].gov.category.some((c) => seeds[b].gov.category.includes(c))) aff += 0.5;
    const r = mulberry32(mixSeed(seed, hashString('diplomacy'), a, b))();
    if (aff >= 1 && r < 0.3 && ma.allies.length < 3 && mb.allies.length < 3) {
      ma.allies.push(mb.id);
      mb.allies.push(ma.id);
    } else if (aff <= 0 && r < 0.35 && ma.rivals.length < 2 && mb.rivals.length < 2) {
      ma.rivals.push(mb.id);
      mb.rivals.push(ma.id);
    }
  }
}

// 现有的领土（重新生成人文、不换国家时）：只把不是陆地的格清掉
function keepCountries(ctx: GenContext) {
  const { world } = ctx;
  const country = ensureCountryArray(world);
  for (let i = 0; i < country.length; i++) if (!world.causes.land[i]) country[i] = -1;
}

// 首都一带的人口多一些：1 + 1.2 × 城市化 × e^(−距离 / R)，R = max(两格的距离, 0.15 × √国土面积)
export function countryPopScale(ctx: Pick<GenContext, 'world' | 'x'>): Float32Array | undefined {
  const { world, x } = ctx;
  const { small, causes } = world;
  const country = causes.country;
  if (!country || !small.countries) return undefined;
  const n = world.mesh.n;
  const area = new Map<number, number>();
  for (let i = 0; i < n; i++) if (country[i] >= 0 && x.dry[i]) area.set(country[i], (area.get(country[i]) ?? 0) + cellKm2(world, i));
  const spacing = world.mesh.spacing * world.kmPerUnit;
  const info = new Map<number, { cap: number; R: number; A: number }>();
  for (const m of Object.values(small.countries)) {
    if (m.capitalCell === undefined || country[m.capitalCell] !== m.id) continue;
    const g = governmentById(small, m.government);
    info.set(m.id, { cap: m.capitalCell, R: Math.max(2 * spacing, 0.15 * Math.sqrt(area.get(m.id) ?? 0)), A: 1.2 * (g?.urbanization ?? 1) });
  }
  const scale = new Float32Array(n).fill(1);
  for (let i = 0; i < n; i++) {
    const c = country[i];
    if (c < 0 || !x.dry[i]) continue;
    const f = info.get(c);
    if (!f) continue;
    const dd = distKm(world, f.cap, i);
    if (dd < 6 * f.R) scale[i] = 1 + f.A * Math.exp(-dd / f.R);
  }
  return scale;
}

function placeCountries(ctx: GenContext) {
  const plan = ctx.countries;
  if (!plan) return;
  ensureGovContent(ctx.world, ctx.era);
  if (plan.mode === 'generate') growCountries(ctx, plan);
  else keepCountries(ctx);
  ctx.popScale = countryPopScale(ctx);
}

// 一个文化最典型的群体（生成时用：世界的时代还没换上，按 ctx 的时代）
function typical(world: World, era: Era, culture: string): PopTuple {
  const c = cultureById(world.small, culture);
  const values: Record<string, string> = {};
  for (const dim of era.dimensions) {
    const list = dimensionValues(world.small, dim.id, era.id);
    const known = new Set(list.map((v) => v.id));
    let best: [string, number] | null = null;
    for (const [id, w] of weightedList(c?.tendencies?.[dim.id])) if (known.has(id) && (!best || w > best[1])) best = [id, w];
    if (best) values[dim.id] = best[0];
    else if (dim.required && list[0]) values[dim.id] = list[0].id;
  }
  return { culture, values };
}

// 人口之后：扩张性强的国家在异族的地方（占多数的文化组不兼容）掺进 0.35 × 扩张性 的主流文化的人（官吏、移民）
function mixCountries(ctx: GenContext) {
  const { world, keep, era } = ctx;
  const { small, causes } = world;
  const country = causes.country;
  if (!ctx.countries || !country || !small.countries || !causes.popTotal) return;
  const table = new GroupTable(small);
  const plan = new Map<number, { a: number; accepted: Set<string>; code: number }>();
  for (const m of Object.values(small.countries)) {
    const g = governmentById(small, m.government);
    const a = 0.35 * (g?.expansion ?? 0);
    if (a <= 0.02) continue;
    plan.set(m.id, { a, accepted: new Set(m.acceptedGroups), code: table.code(typical(world, era, m.primaryCulture)) });
  }
  if (!plan.size) return;
  const groupOfCode = (code: number) => {
    const t = table.get(code);
    return t ? cultureById(small, t.culture)?.group : undefined;
  };
  for (let i = 0; i < country.length; i++) {
    const p = plan.get(country[i]);
    if (!p || keep?.[i] || !(causes.popTotal[i] > 0)) continue;
    const first = causes.popGroup![i * SLOTS];
    const g = first ? groupOfCode(first) : undefined;
    if (!g || p.accepted.has(g)) continue;
    const comp = readComp(causes, i);
    const out: Share[] = comp.map((x) => ({ code: x.code, s: x.s * (1 - p.a) }));
    out.push({ code: p.code, s: p.a });
    writeComp(causes, i, out);
  }
  table.commit();
}

export const countriesStage: HumanStage = { id: 'countries', run: placeCountries };
export const countryMixStage: HumanStage = { id: 'country-mix', run: mixCountries };
