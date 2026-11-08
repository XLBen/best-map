import { CommandError } from '../errors';
import { hashString } from '../names';
import { mixSeed, mulberry32 } from '../rng';
import type { CountryMeta, HistoryEvent, RulerMeta, World } from '../world';
import { eventsOf, loreOf, nextEventId, putEvent } from './archive-store';
import { SUBJECT_NAMES } from './countries/records';
import { type Era } from './era';
import { eraNow } from './rulers';

// 国家的大事（第八十五轮）：年份、标题、备注、牵涉的几国。一件存一份（small.archive.events），牵涉的每一国的年表里都有它。
// 生成的来自以前历史里的几句：结盟、不和（开战）、成为附庸（从属）；建国、统治者即位不存，年表里按建国年份、统治者的名单现列
// （改了年份、名单就跟着变）。生成的大事带 auto；自己加的、改过的没有，重新生成时留着（archive-keep.ts）

export const MAX_EVENTS = 4096;
export const EVENT_TITLE_MAX = 80;

// 两国之间的一件：年份在两国都建了国以后到时代的现在之间（按两国的编号取随机数，与先后无关）
function pairYear(seed: number, kind: string, a: CountryMeta, b: CountryMeta, now: number): number {
  const lo = Math.max(a.founded, b.founded);
  const hi = Math.max(lo, now);
  const r = mulberry32(mixSeed(seed, hashString(`event:${kind}`), Math.min(a.id, b.id), Math.max(a.id, b.id)))();
  return Math.round(lo + r * (hi - lo));
}

// 生成的大事：fresh 里的国家（这一次新生成的）的结盟、开战、从属。两国都是新的只记一次；另一国是留着的（锁定的）也记
export function generateEvents(world: World, fresh: readonly CountryMeta[], seed: number, era: Era | undefined): Omit<HistoryEvent, 'id'>[] {
  const metas = world.small.countries ?? {};
  const isNew = new Set(fresh.map((m) => m.id));
  const now = eraNow(era);
  const out: Omit<HistoryEvent, 'id'>[] = [];
  const pairOk = (m: CountryMeta, x: number) => !!metas[x] && x !== m.id && (!isNew.has(x) || m.id < x);
  for (const m of [...fresh].sort((a, b) => a.id - b.id)) {
    if (m.overlord !== undefined && metas[m.overlord]) {
      const lord = metas[m.overlord];
      out.push({ year: pairYear(seed, 'subject', m, lord, now), title: `${m.name}成为${lord.name}的${SUBJECT_NAMES[m.subject ?? 'vassal']}`, countries: [m.id, lord.id], auto: true });
    }
    for (const x of [...m.allies].sort((a, b) => a - b)) if (pairOk(m, x)) out.push({ year: pairYear(seed, 'ally', m, metas[x], now), title: `${m.name}与${metas[x].name}结盟`, countries: [m.id, x], auto: true });
    for (const x of [...m.rivals].sort((a, b) => a - b)) if (pairOk(m, x)) out.push({ year: pairYear(seed, 'war', m, metas[x], now), title: `${m.name}与${metas[x].name}开战`, countries: [m.id, x], auto: true });
  }
  return out;
}

// ---------- 编辑 ----------

export interface EventInput {
  year: number;
  title: string;
  note?: string;
  countries: number[];
}
export interface EventPatch {
  year?: number;
  title?: string;
  note?: string | null;
  countries?: number[];
}

function checkCountries(world: World, list: readonly number[]): number[] {
  const out = [...new Set(list)];
  if (!out.length) throw new CommandError('大事至少属于一国');
  for (const c of out) if (!world.small.countries?.[c]) throw new CommandError(`找不到国家 ${c}`);
  return out;
}

export function addEvent(world: World, input: EventInput): { event: HistoryEvent; summary: string } {
  if (Object.keys(world.small.archive?.events ?? {}).length >= MAX_EVENTS) throw new CommandError(`最多 ${MAX_EVENTS} 件大事`);
  const title = input.title.trim();
  if (!title) throw new CommandError('标题不能空');
  const id = nextEventId(world.small);
  const ev: HistoryEvent = { id, year: input.year, title, ...(input.note?.trim() ? { note: input.note } : {}), countries: checkCountries(world, input.countries) };
  putEvent(world, id, ev);
  return { event: ev, summary: `加大事“${title}”` };
}

export function setEvent(world: World, id: number, p: EventPatch): string {
  const old = world.small.archive?.events[id];
  if (!old) throw new CommandError(`找不到大事 ${id}`);
  // 改过的不再是生成的（重新生成时留着）
  const { auto: _a, ...ev } = old;
  if (p.year !== undefined) ev.year = p.year;
  if (p.title !== undefined) {
    const t = p.title.trim();
    if (!t) throw new CommandError('标题不能空');
    ev.title = t;
  }
  if (p.note !== undefined) {
    if (p.note?.trim()) ev.note = p.note;
    else delete ev.note;
  }
  if (p.countries !== undefined) ev.countries = checkCountries(world, p.countries);
  putEvent(world, id, ev);
  const what = p.title !== undefined ? `改为“${ev.title}”` : p.year !== undefined ? '年份' : p.note !== undefined ? '备注' : p.countries !== undefined ? '牵涉的国家' : '修改';
  return `大事“${old.title}” · ${what}`;
}

export function removeEvent(world: World, id: number): string {
  const old = world.small.archive?.events[id];
  if (!old) throw new CommandError(`找不到大事 ${id}`);
  putEvent(world, id, null);
  return `删除大事“${old.title}”`;
}

// ---------- 年表（档案的历史页、导出） ----------

export type TimelineRow =
  | { kind: 'founded'; key: string; year: number; title: string }
  | { kind: 'accession'; key: string; year: number; title: string; ruler: RulerMeta }
  | { kind: 'event'; key: string; year: number; title: string; event: HistoryEvent; others: number[] };

// 一国的年表：建国、每位统治者即位（按名单）、大事，按年份排（同一年：建国、即位、大事）
export function countryTimeline(world: Pick<World, 'small'>, id: number): TimelineRow[] {
  const m = world.small.countries?.[id];
  if (!m) return [];
  const rows: TimelineRow[] = [{ kind: 'founded', key: 'founded', year: m.founded, title: '建国' }];
  for (const r of loreOf(world.small, id).rulers) rows.push({ kind: 'accession', key: `ruler:${r.id}`, year: r.from, title: `${r.title ?? ''}${r.name}即位`, ruler: r });
  for (const e of eventsOf(world.small, id)) rows.push({ kind: 'event', key: `event:${e.id}`, year: e.year, title: e.title, event: e, others: e.countries.filter((c) => c !== id) });
  const rank = { founded: 0, accession: 1, event: 2 } as const;
  // 稳定排序：同一年同一种按原来的先后（名单的先后、大事的编号）
  return rows.map((r, k) => ({ r, k })).sort((a, b) => a.r.year - b.r.year || rank[a.r.kind] - rank[b.r.kind] || a.k - b.k).map((x) => x.r);
}
