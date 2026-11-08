import { CommandError } from '../errors';
import { hashString } from '../names';
import { mixSeed, mulberry32 } from '../rng';
import type { CountryLore, CountryMeta, DynastyMeta, RulerMeta, World } from '../world';
import { loreOf, putLore } from './archive-store';
import { countryBase, personName } from './country-names';
import { DEFAULT_YEARS } from './countries/base';
import { countrySeed, rulerTitleOf, styleOf } from './countries/records';
import { type Era, cultureById } from './era';

// 统治者与家族（第八十五轮）：每国一份名单（最早的在前，最后一位是现在的统治者，以前的 ruler），统治者属于家族，可以写父母。
// 生成：人文生成的最后（国家都定了之后，generate.ts 经 archive-keep.ts）每个新的国家一份：
//   3–8 位，从建国一直到时代的“现在”（时代年份的后一头）；每位在位 8–35 年，放得下时首尾相接、按比例拉开铺满，
//   放不下时第一位是开国的，其余是最近的几位（中间隔着没列出来的年代）；1–3 个家族，按先后分成几段，每段的第一位是开创者；
//   同一家族里接着上一位的多半是上一位的孩子，不然是兄弟姐妹；有时沿用父母的名字（“二世”）。
//   名字按主流文化的地名风格起（和国名同一个来源）；最后一位的名字和以前的 ruler 相同（同一个种子）。都只用自己的随机流，别的不动。
// 编辑都是命令（commands/archive.ts）：加、改名、改年份、换家族、写父母、排先后、删；家族加、改名、删

export const MAX_RULERS = 200;
export const MAX_DYNASTIES = 60;
const ORD = ['', '', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

// 时代的“现在”（年份范围的后一头）
export const eraNow = (era: Pick<Era, 'years'> | undefined): number => Math.max(...(era?.years ?? DEFAULT_YEARS));

// 第几世：同一个名字的第二位起写“二世”（原文写 II）
function regnal(base: { zh: string; orig?: string }, k: number): { zh: string; orig?: string } {
  if (k < 2) return base;
  return { zh: `${base.zh}${ORD[k] ?? k}世`, ...(base.orig ? { orig: `${base.orig} ${ROMAN[k] ?? k}` } : {}) };
}

// 一国生成的统治者与家族。seed 是国家的种子（countryRules.seed），era 是生成用的时代
export function generateLore(world: World, m: CountryMeta, seed: number, era: Era | undefined): CountryLore {
  const small = world.small;
  const style = styleOf(world, cultureById(small, m.primaryCulture));
  const s = countrySeed(seed, m.id);
  const rand = mulberry32(mixSeed(seed, hashString('rulers'), m.id));
  const title = rulerTitleOf(world, m, era);
  const now = Math.max(eraNow(era), m.founded);
  const span = now - m.founded;
  const k = Math.max(3, Math.min(8, Math.round(2 + span / 40 + rand() * 2)));
  // 每位在位多少年（最后一位还在位：只算到现在）
  const len = Array.from({ length: k }, () => 8 + rand() * 27);
  const total = len.reduce((a, b) => a + b, 0);
  const from: number[] = [];
  const to: number[] = [];
  if (total >= span) {
    let at = 0;
    for (let i = 0; i < k; i++) {
      from.push(m.founded + Math.round((span * at) / total));
      at += len[i];
      to.push(m.founded + Math.round((span * at) / total));
    }
  } else {
    // 开国的一位，加上最近的几位
    from.push(m.founded);
    to.push(m.founded + Math.round(len[0]));
    let at = now - len[k - 1] * (0.2 + 0.6 * rand());
    const recent: [number, number][] = [[Math.round(at), now]];
    for (let i = k - 2; i >= 1; i--) {
      const end = at;
      at -= len[i];
      recent.unshift([Math.round(at), Math.round(end)]);
    }
    for (const [a, b] of recent) {
      from.push(Math.max(a, to[0]));
      to.push(Math.max(b, to[0]));
    }
  }
  // 家族：1–3 个，按先后分段（换家族的位置不重复）
  const d = k <= 3 ? 1 + (rand() < 0.35 ? 1 : 0) : 1 + Math.floor(rand() * 3);
  const cuts = new Set<number>();
  for (let t = 0; cuts.size < d - 1 && t < 32; t++) cuts.add(1 + Math.floor(rand() * (k - 1)));
  const dynasties: DynastyMeta[] = [];
  const taken = new Set<string>();
  const newDynasty = (founder: number) => {
    const j = dynasties.length + 1;
    const base = countryBase(style, mixSeed(s, 0xd1a, j), taken);
    taken.add(base.zh);
    dynasties.push({ id: j, name: `${base.zh}家`, ...(base.orig ? { orig: base.orig } : {}), founder });
  };
  const rulers: RulerMeta[] = [];
  const uses = new Map<string, number>();
  for (let i = 0; i < k; i++) {
    const id = i + 1;
    if (i === 0 || cuts.has(i)) newDynasty(id);
    const dyn = dynasties[dynasties.length - 1].id;
    const prev = rulers[i - 1];
    // 接着上一位、同一个家族：多半是孩子，不然和上一位同一个父母
    const linked = prev && prev.dynasty === dyn && to[i - 1] === from[i];
    const parent = linked ? (prev.parent !== undefined && rand() < 0.25 ? prev.parent : prev.id) : undefined;
    // 最后一位的名字同以前的 ruler（同一个种子）；别的按位置派生。有父母时两成沿用父母的名字
    const fresh = personName(style, i === k - 1 ? mixSeed(s, 0x7e1) : mixSeed(s, 0x7e1, k - 1 - i));
    const p = parent !== undefined ? rulers[parent - 1] : undefined;
    const base = i < k - 1 && p && rand() < 0.2 ? { zh: p.name.replace(/[二三四五六七八九十]+世$/, ''), ...(p.orig ? { orig: p.orig.replace(/ [IVX]+$/, '') } : {}) } : fresh;
    const n = (uses.get(base.zh) ?? 0) + 1;
    uses.set(base.zh, n);
    const name = regnal(base, n);
    rulers.push({
      id,
      name: name.zh || '无名',
      ...(name.orig ? { orig: name.orig } : {}),
      ...(title ? { title } : {}),
      from: from[i],
      ...(i < k - 1 ? { to: to[i] } : {}),
      dynasty: dyn,
      ...(parent !== undefined ? { parent } : {}),
    });
  }
  return { rulers, dynasties };
}

// ---------- 编辑（commands/archive.ts 调；都换成新的对象） ----------

export interface RulerInput {
  name: string;
  orig?: string;
  title?: string;
  from: number;
  to?: number;
  dynasty?: number;
  parent?: number;
  note?: string;
}
export interface RulerPatch {
  name?: string;
  orig?: string | null;
  title?: string | null;
  from?: number;
  to?: number | null;
  dynasty?: number | null;
  parent?: number | null;
  note?: string | null;
}

function countryOf(world: World, id: number): CountryMeta {
  const m = world.small.countries?.[id];
  if (!m) throw new CommandError(`找不到国家 ${id}`);
  return m;
}

const rulerName = (r: RulerMeta) => `${r.title ?? ''}${r.name}`;

// 一位统治者的几项（检查家族、父母在这一国里；父母不能是自己或自己的后代）
function apply(lore: CountryLore, r: RulerMeta, p: RulerPatch): RulerMeta {
  const out: RulerMeta = { ...r };
  const text = (k: 'orig' | 'title' | 'note', v: string | null | undefined) => {
    if (v === undefined) return;
    const t = v?.trim();
    if (t) out[k] = t;
    else delete out[k];
  };
  if (p.name !== undefined) {
    const n = p.name.trim();
    if (!n) throw new CommandError('名字不能空');
    out.name = n;
  }
  text('orig', p.orig);
  text('title', p.title);
  text('note', p.note);
  if (p.from !== undefined) out.from = p.from;
  if (p.to === null) delete out.to;
  else if (p.to !== undefined) out.to = p.to;
  if (out.to !== undefined && out.to < out.from) throw new CommandError('在位的结束不能早于开始');
  if (p.dynasty === null) delete out.dynasty;
  else if (p.dynasty !== undefined) {
    if (!lore.dynasties.some((x) => x.id === p.dynasty)) throw new CommandError(`这一国没有家族 ${p.dynasty}`);
    out.dynasty = p.dynasty;
  }
  if (p.parent === null) delete out.parent;
  else if (p.parent !== undefined) {
    const byId = new Map(lore.rulers.map((x) => [x.id, x]));
    if (!byId.has(p.parent)) throw new CommandError(`这一国没有统治者 ${p.parent}`);
    for (let at: number | undefined = p.parent, n = 0; at !== undefined && n <= byId.size; at = byId.get(at)?.parent, n++) {
      if (at === r.id) throw new CommandError('父母不能是自己或自己的后代');
    }
    out.parent = p.parent;
  }
  return out;
}

const edited = (lore: CountryLore, rulers: RulerMeta[], dynasties = lore.dynasties): CountryLore => ({ ...lore, rulers, dynasties, edited: true });

// 加一位（at 省略时加在最后，是新的现在的统治者）。返回编号
export function addRuler(world: World, id: number, input: RulerInput, at?: number): { ruler: RulerMeta; summary: string } {
  countryOf(world, id);
  const lore = loreOf(world.small, id);
  if (lore.rulers.length >= MAX_RULERS) throw new CommandError(`一国最多 ${MAX_RULERS} 位统治者`);
  const rid = Math.max(0, ...lore.rulers.map((r) => r.id)) + 1;
  const r = apply(lore, { id: rid, name: '', from: input.from }, { ...input, orig: input.orig ?? null, title: input.title ?? null, note: input.note ?? null, to: input.to ?? null, dynasty: input.dynasty ?? null, parent: input.parent ?? null });
  const list = [...lore.rulers];
  list.splice(at === undefined ? list.length : Math.max(0, Math.min(list.length, at)), 0, r);
  putLore(world, id, edited(lore, list));
  return { ruler: r, summary: `加统治者“${rulerName(r)}”` };
}

export function setRuler(world: World, id: number, rid: number, p: RulerPatch): string {
  countryOf(world, id);
  const lore = loreOf(world.small, id);
  const k = lore.rulers.findIndex((r) => r.id === rid);
  if (k < 0) throw new CommandError(`这一国没有统治者 ${rid}`);
  const r = apply(lore, lore.rulers[k], p);
  const list = [...lore.rulers];
  list[k] = r;
  putLore(world, id, edited(lore, list));
  const what = p.name !== undefined ? `改名为“${r.name}”` : p.from !== undefined || p.to !== undefined ? '在位年份' : p.dynasty !== undefined ? '家族' : p.parent !== undefined ? '父母' : p.note !== undefined ? '备注' : '修改';
  return `统治者“${rulerName(lore.rulers[k])}” · ${what}`;
}

// 删一位：孩子的父母改成它的父母，开创的家族不再有开创者
export function removeRuler(world: World, id: number, rid: number): string {
  countryOf(world, id);
  const lore = loreOf(world.small, id);
  const r = lore.rulers.find((x) => x.id === rid);
  if (!r) throw new CommandError(`这一国没有统治者 ${rid}`);
  const list = lore.rulers
    .filter((x) => x.id !== rid)
    .map((x) => {
      if (x.parent !== rid) return x;
      const { parent: _p, ...rest } = x;
      return r.parent !== undefined ? { ...rest, parent: r.parent } : rest;
    });
  const dynasties = lore.dynasties.map((dd) => {
    if (dd.founder !== rid) return dd;
    const { founder: _f, ...rest } = dd;
    return rest;
  });
  putLore(world, id, edited(lore, list, dynasties));
  return `删除统治者“${rulerName(r)}”`;
}

// 排先后：挪到第 to 位（0 起）
export function moveRuler(world: World, id: number, rid: number, to: number): string {
  countryOf(world, id);
  const lore = loreOf(world.small, id);
  const k = lore.rulers.findIndex((r) => r.id === rid);
  if (k < 0) throw new CommandError(`这一国没有统治者 ${rid}`);
  const list = [...lore.rulers];
  const [r] = list.splice(k, 1);
  list.splice(Math.max(0, Math.min(list.length, to)), 0, r);
  putLore(world, id, edited(lore, list));
  return `统治者“${rulerName(r)}” · 排到第 ${list.indexOf(r) + 1} 位`;
}

export function addDynasty(world: World, id: number, input: { name: string; orig?: string; founder?: number }): { dynasty: DynastyMeta; summary: string } {
  countryOf(world, id);
  const lore = loreOf(world.small, id);
  if (lore.dynasties.length >= MAX_DYNASTIES) throw new CommandError(`一国最多 ${MAX_DYNASTIES} 个家族`);
  const name = input.name.trim();
  if (!name) throw new CommandError('名字不能空');
  if (input.founder !== undefined && !lore.rulers.some((r) => r.id === input.founder)) throw new CommandError(`这一国没有统治者 ${input.founder}`);
  const dd: DynastyMeta = { id: Math.max(0, ...lore.dynasties.map((x) => x.id)) + 1, name, ...(input.orig?.trim() ? { orig: input.orig.trim() } : {}), ...(input.founder !== undefined ? { founder: input.founder } : {}) };
  putLore(world, id, edited(lore, lore.rulers, [...lore.dynasties, dd]));
  return { dynasty: dd, summary: `加家族“${name}”` };
}

export function setDynasty(world: World, id: number, did: number, p: { name?: string; orig?: string | null; founder?: number | null }): string {
  countryOf(world, id);
  const lore = loreOf(world.small, id);
  const k = lore.dynasties.findIndex((x) => x.id === did);
  if (k < 0) throw new CommandError(`这一国没有家族 ${did}`);
  const dd: DynastyMeta = { ...lore.dynasties[k] };
  if (p.name !== undefined) {
    const n = p.name.trim();
    if (!n) throw new CommandError('名字不能空');
    dd.name = n;
  }
  if (p.orig !== undefined) {
    const o = p.orig?.trim();
    if (o) dd.orig = o;
    else delete dd.orig;
  }
  if (p.founder === null) delete dd.founder;
  else if (p.founder !== undefined) {
    if (!lore.rulers.some((r) => r.id === p.founder)) throw new CommandError(`这一国没有统治者 ${p.founder}`);
    dd.founder = p.founder;
  }
  const list = [...lore.dynasties];
  list[k] = dd;
  putLore(world, id, edited(lore, lore.rulers, list));
  return `家族“${lore.dynasties[k].name}” · ${p.name !== undefined ? `改名为“${dd.name}”` : p.founder !== undefined ? '开创者' : '修改'}`;
}

// 删一个家族：里面的统治者不再属于哪个家族
export function removeDynasty(world: World, id: number, did: number): string {
  countryOf(world, id);
  const lore = loreOf(world.small, id);
  const dd = lore.dynasties.find((x) => x.id === did);
  if (!dd) throw new CommandError(`这一国没有家族 ${did}`);
  const rulers = lore.rulers.map((r) => {
    if (r.dynasty !== did) return r;
    const { dynasty: _d, ...rest } = r;
    return rest;
  });
  putLore(world, id, edited(lore, rulers, lore.dynasties.filter((x) => x.id !== did)));
  return `删除家族“${dd.name}”`;
}

// 备注（第八十五轮的第一样）：空着是删除
export function setCountryNote(world: World, id: number, note: string | null): string {
  countryOf(world, id);
  const lore = loreOf(world.small, id);
  const t = note?.trim();
  const next: CountryLore = { ...lore };
  if (t) next.note = note!;
  else delete next.note;
  putLore(world, id, next);
  return t ? '写备注' : '删除备注';
}

// ---------- 读（档案、导出） ----------

// 按家族列（家族按第一次出现的先后，没有家族的最后），家族里按名单的先后，depth 是在家族里往上几代（父母也在这一家族里）
export interface RulerRow {
  ruler: RulerMeta;
  index: number;
  depth: number;
}
export interface DynastyGroup {
  dynasty?: DynastyMeta;
  rows: RulerRow[];
}
export function rulersByDynasty(lore: CountryLore): DynastyGroup[] {
  const byId = new Map(lore.rulers.map((r) => [r.id, r]));
  const groups = new Map<number, DynastyGroup>();
  const order: number[] = [];
  const known = new Map(lore.dynasties.map((dd) => [dd.id, dd]));
  lore.rulers.forEach((r, index) => {
    const key = r.dynasty !== undefined && known.has(r.dynasty) ? r.dynasty : 0;
    if (!groups.has(key)) {
      groups.set(key, { ...(key ? { dynasty: known.get(key) } : {}), rows: [] });
      order.push(key);
    }
    let depth = 0;
    for (let at = r.parent, n = 0; at !== undefined && n < 8; n++) {
      const p = byId.get(at);
      if (!p || p.dynasty !== r.dynasty) break;
      depth++;
      at = p.parent;
    }
    groups.get(key)!.rows.push({ ruler: r, index, depth: Math.min(depth, 4) });
  });
  // 还没有人的家族也列出来（刚加的）
  for (const dd of lore.dynasties) {
    if (!groups.has(dd.id)) {
      groups.set(dd.id, { dynasty: dd, rows: [] });
      order.push(dd.id);
    }
  }
  const sorted = order.filter((k) => k !== 0);
  if (groups.has(0)) sorted.push(0);
  return sorted.map((k) => groups.get(k)!);
}

// 在位的年份写成“1203–1240”“1240 至今”
export const reignText = (r: Pick<RulerMeta, 'from' | 'to'>, year: (y: number) => string = String): string => (r.to === undefined ? `${year(r.from)} 至今` : `${year(r.from)}–${year(r.to)}`);
