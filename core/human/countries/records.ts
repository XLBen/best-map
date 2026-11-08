import { styleById, worldStyleId } from '../../name-styles';
import { hashString } from '../../names';
import { mixSeed, mulberry32 } from '../../rng';
import type { CountryMeta, PopTuple, World } from '../../world';
import { countryBase } from '../country-names';
import { type Culture, type Era, type SubjectKind, cultureById, cultureTendency, dimensionValues, popValueById, styleOfCulture, weightedList, worldEra } from '../era';
import { makeFlag } from '../flags';
import { type Government, type TitleContext, govAllowed, govRestricted, govTitles, governmentById, titled } from '../government';
import { cellKm2 } from '../space';
import { worldTiers } from '../tiers';
import { DEFAULT_YEARS } from './base';
import { diplomacy } from './diplomacy';
import { govFit, govWeights, pickGov } from './seeds';
import type { CountryRun } from './state';

// 国家的档案（第二十三轮）：颜色、名字、称号、建国年份、历史；生成的最后一步（writeRecords）把长好的领土写进原因、建档案、外交。
// 第七十三轮从 countries.ts 搬来（原样），countries.ts 照旧导出

// ---------- 颜色 ----------

export function hexToHsl(hex: string): [number, number, number] {
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

// 文化的地名风格（不在世界里时用世界默认）；统治者、家族的名字也用它（第八十五轮，rulers.ts）
export function styleOf(world: World, culture: Culture | undefined) {
  const small = world.small;
  const id = styleOfCulture(small, culture);
  return (id && styleById(small, id)) || styleById(small, worldStyleId(small))!;
}

// 挑称号时看的（第四十三轮）：国家的等级、主流文化与文化组、主流文化最典型的取值（宗教……）与它们的组。
// era 省略时按世界的时代（生成时世界的时代还没换上，按生成的时代）
export function titleContext(world: Pick<World, 'small'>, meta: Pick<CountryMeta, 'tier' | 'primaryCulture'>, era: Era | undefined = worldEra(world.small)): TitleContext {
  return { ...(meta.tier ? { tier: meta.tier } : {}), tiers: worldTiers(world.small), ...cultureContext(world, meta.primaryCulture, era) };
}

// 一个主流文化的：文化、文化组、最典型的取值与它们的组（称号的换说法、政体限谁用都看它；第四十四轮从 titleContext 分出来）
export function cultureContext(world: Pick<World, 'small'>, culture: string, era: Era | undefined = worldEra(world.small)): Omit<TitleContext, 'tier' | 'tiers'> {
  const small = world.small;
  const c = cultureById(small, culture);
  const values = era ? Object.values(typical(world, era, culture).values) : [];
  const valueGroups = values.flatMap((v) => popValueById(small, v)?.group ?? []);
  return { ...(c ? { culture: c.id, group: c.group } : {}), values, valueGroups };
}

// 国名：地名 + 称号（按等级、主流文化、宗教换说法，见 government.ts 的 govTitles）
export function countryName(base: { zh: string; orig?: string }, government: Government | undefined, ctx: TitleContext): { zh: string; orig?: string } {
  return titled(base, govTitles(government, ctx).title);
}

// 统治者的称号（等级变了时重算：联邦的首府那一邦，第四十三轮）
export function rulerTitleOf(world: Pick<World, 'small'>, meta: Pick<CountryMeta, 'government' | 'primaryCulture' | 'tier'>, era?: Era): string | undefined {
  return govTitles(governmentById(world.small, meta.government), titleContext(world, meta, era ?? worldEra(world.small))).ruler?.zh;
}

// 一国的名字用的种子（统治者的名字也从它派生，见 rulers.ts）
export const countrySeed = (seed: number, id: number): number => mixSeed(seed, hashString('country'), id);

// 名字（taken 里的国名避开）。第八十五轮：统治者不在这里起（rulers.ts 的 generateLore，最后一位还是以前的那个名字）
export function nameCountry(world: World, meta: Pick<CountryMeta, 'id' | 'government' | 'primaryCulture' | 'tier'>, seed: number, taken: Set<string>, era?: Era): Pick<CountryMeta, 'name' | 'orig' | 'base'> {
  const small = world.small;
  const culture = cultureById(small, meta.primaryCulture);
  const gov = governmentById(small, meta.government);
  const style = styleOf(world, culture);
  const base = countryBase(style, countrySeed(seed, meta.id), taken);
  const titles = govTitles(gov, titleContext(world, meta, era ?? worldEra(small)));
  const name = titled(base, titles.title);
  return {
    name: name.zh,
    ...(name.orig ? { orig: name.orig } : {}),
    base: base.orig ? { zh: base.zh, orig: base.orig } : { zh: base.zh },
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
export const SUBJECT_NAMES: Record<SubjectKind, string> = { vassal: '附庸', protectorate: '保护国', dominion: '自治领', tributary: '朝贡国', colony: '殖民地', company: '公司领地' };
// 从属的一句（档案、列表用；第七十四轮）：殖民地写“殖民地 · 宗主国 X”，别的写“附庸 · 宗主 X”（第七十五轮的公司领地写“公司领地 · 宗主 X”）
export function subjectText(kind: SubjectKind | undefined, lord: string): string {
  return kind === 'colony' ? `殖民地 · 宗主国 ${lord}` : `${SUBJECT_NAMES[kind ?? 'vassal']} · 宗主 ${lord}`;
}
function subjectLine(kind: SubjectKind | undefined, lord: string): string {
  if (kind === 'protectorate') return `后来受${lord}保护。`;
  if (kind === 'dominion') return `后来成为${lord}的自治领。`;
  if (kind === 'tributary') return `向${lord}称臣纳贡。`;
  if (kind === 'colony') return `后来成为${lord}的殖民地。`;
  if (kind === 'company') return `后来成为${lord}的公司领地。`;
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

// 一个文化最典型的群体（生成时用：世界的时代还没换上，按 ctx 的时代）
export function typical(world: Pick<World, 'small'>, era: Era, culture: string): PopTuple {
  const c = cultureById(world.small, culture);
  const values: Record<string, string> = {};
  for (const dim of era.dimensions) {
    const list = dimensionValues(world.small, dim.id, era.id);
    const known = new Set(list.map((v) => v.id));
    let best: [string, number] | null = null;
    for (const [id, w] of weightedList(cultureTendency(world.small, c, dim.id, era.id))) if (known.has(id) && (!best || w > best[1])) best = [id, w];
    if (best) values[dim.id] = best[0];
    else if (dim.required && list[0]) values[dim.id] = list[0].id;
  }
  return { culture, values };
}

// ---------- 生成的最后一步：写进原因、建档案、外交、历史 ----------

export function writeRecords(g: CountryRun) {
  const { ctx, world, seeds, owner, country, seed, govs, K } = g;
  const { x, hab, era } = ctx;
  const cultureOf = ctx.cultureOf!;
  const small = world.small;
  const n = g.n;
  const k = seeds.length;
  const ids = seeds.map(() => g.next++);
  // 锁定的国家的格不改（第八十四轮：长完以后的格局——种族王国补空地——把整理时还原成 −1 的锁定的格当成了空地）
  for (let i = 0; i < n; i++) if (owner[i] >= 0 && country[i] < 0) country[i] = ids[owner[i]];
  small.nextCountry = g.next;
  const used = new Set(g.kept.map((m) => m.color));
  const taken = new Set(g.kept.map((m) => m.name));
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
    const gr = ctx.cultureGroup[c];
    groupMass[o].set(gr, (groupMass[o].get(gr) ?? 0) + m);
    cultureMass[o].set(c, (cultureMass[o].get(c) ?? 0) + m);
  }
  // 第四十四轮：长完以后再查一遍政体限谁用（按主流文化与它最典型的取值）：用不了的按主流文化的倾向 × 与等级相配换一个
  if (govs.some(govRestricted)) {
    for (let o = 0; o < k; o++) {
      const s = seeds[o];
      const culture = ctx.cultures[s.culture];
      if (govAllowed(s.gov, cultureContext(world, culture.id, era))) continue;
      const w = govWeights(world, era, culture, govs);
      s.gov = pickGov(govs, (gv) => w(gv) * govFit(gv, s.tier), mulberry32(mixSeed(seed, hashString('country:regov'), o)));
    }
  }
  const yearRand = mulberry32(mixSeed(seed, hashString('country:year')));
  const metas: CountryMeta[] = seeds.map((s, o) => {
    const culture = ctx.cultures[s.culture];
    const id = ids[o];
    const gm = groupMass[o];
    let sum = 0;
    for (const v of gm.values()) sum += v;
    const accepted = [ctx.groups[g.primGroup[o]].group.id];
    for (const [gr, v] of [...gm].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
      const gid = ctx.groups[gr].group.id;
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
      founded: foundedYear(era, yearRand),
      history: '',
      ...(s.tier.id ? { tier: s.tier.id } : {}),
      // 第七十五轮：格局里的角色（没有时不写，以前的档案逐值不变）
      ...(s.role ? { role: s.role } : {}),
    };
    Object.assign(meta, nameCountry(world, meta, seed, taken, era));
    return meta;
  });
  for (const m of metas) small.countries![m.id] = m;
  g.ids = ids;
  g.metas = metas;
  g.areaOf = areaOf;

  // ---- 外交 ----
  diplomacy(g);
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
