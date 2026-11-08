import type { Command } from '../../../core/commands';
import { eraNow, loreOf, worldEra } from '../../../core/human';
import type { HistoryEvent, RulerMeta, World } from '../../../core/world';
import { ARCHIVE_TEXT } from '../copy';

// 国家档案里的备注、统治者、家族、大事（第八十五轮）：界面点了以后发的命令（没变、不该发时 null）。
// 组件（archives/country-rulers.tsx、country-timeline.tsx、country-overview.tsx 的备注）只调这里

// 年份的写法：“-500”“前 500”“公元前 500 年”“500 年”都认；认不出时 null
export function parseYear(text: string): number | null {
  const t = text.trim().replace(/\s*年$/, '');
  const m = /^(公元前|前|-)\s*(\d+)$/.exec(t) ?? /^()(\d+)$/.exec(t);
  if (!m) return null;
  const v = Number(m[2]) * (m[1] ? -1 : 1);
  return Number.isInteger(v) && Math.abs(v) <= 100000 ? v : null;
}
// 短的写法（年表、名单里）：“前 500”“1203”
export const shortYear = (y: number): string => (y < 0 ? `前 ${-y}` : String(y));

// ---------- 备注 ----------

export function noteCommand(w: World, id: number, text: string): Command | null {
  const cur = loreOf(w.small, id).note ?? '';
  if (text === cur || (!text.trim() && !cur)) return null;
  return { op: 'set_country_note', id, note: text.trim() ? text : null };
}

// ---------- 统治者 ----------

const rulerOf = (w: World, id: number, rid: number): RulerMeta | undefined => loreOf(w.small, id).rulers.find((r) => r.id === rid);

export function rulerNameCommand(w: World, id: number, rid: number, name: string): Command | null {
  const r = rulerOf(w, id, rid);
  const n = name.trim();
  if (!r || !n || n === r.name) return null;
  return { op: 'set_ruler', id, ruler: rid, patch: { name: n } };
}

export function rulerTextCommand(w: World, id: number, rid: number, key: 'orig' | 'title' | 'note', text: string): Command | null {
  const r = rulerOf(w, id, rid);
  if (!r || text.trim() === (r[key] ?? '').trim()) return null;
  return { op: 'set_ruler', id, ruler: rid, patch: { [key]: text.trim() ? text.trim() : null } };
}

// 在位的年份：to 写空是“至今”
export function rulerYearsCommand(w: World, id: number, rid: number, from: number, to: number | null): Command | null {
  const r = rulerOf(w, id, rid);
  if (!r || (from === r.from && to === (r.to ?? null))) return null;
  if (to !== null && to < from) return null;
  return { op: 'set_ruler', id, ruler: rid, patch: { from, to } };
}

export function rulerLinkCommand(w: World, id: number, rid: number, key: 'dynasty' | 'parent', value: number | null): Command | null {
  const r = rulerOf(w, id, rid);
  if (!r || (r[key] ?? null) === value) return null;
  return { op: 'set_ruler', id, ruler: rid, patch: { [key]: value } };
}

// 排先后：往前（−1）、往后（+1）挪一位
export function moveRulerCommand(w: World, id: number, rid: number, delta: number): Command | null {
  const list = loreOf(w.small, id).rulers;
  const k = list.findIndex((r) => r.id === rid);
  const to = k + delta;
  if (k < 0 || to < 0 || to >= list.length) return null;
  return { op: 'move_ruler', id, ruler: rid, to };
}

export const removeRulerCommand = (id: number, rid: number): Command => ({ op: 'remove_ruler', id, ruler: rid });

// 名单最后加一位（新的现在的统治者）：家族、称号同上一位；上一位在位到新的这一位开始（一步，能撤销）
export function addRulerCommand(w: World, id: number): Command | null {
  const m = w.small.countries?.[id];
  if (!m) return null;
  const list = loreOf(w.small, id).rulers;
  const last = list[list.length - 1];
  const now = Math.max(eraNow(worldEra(w.small)), m.founded);
  const from = last ? (last.to ?? Math.max(last.from + 1, now)) : m.founded;
  const ruler = { name: ARCHIVE_TEXT.newRuler, from, ...(last?.title ? { title: last.title } : {}), ...(last?.dynasty !== undefined ? { dynasty: last.dynasty } : {}) };
  const add: Command = { op: 'add_ruler', id, ruler };
  if (!last || last.to !== undefined) return add;
  return { op: 'batch', label: ARCHIVE_TEXT.addRuler, commands: [{ op: 'set_ruler', id, ruler: last.id, patch: { to: from } }, add] };
}

// ---------- 家族 ----------

export const addDynastyCommand = (id: number): Command => ({ op: 'add_dynasty', id, name: ARCHIVE_TEXT.newDynasty });

export function dynastyNameCommand(w: World, id: number, did: number, name: string): Command | null {
  const d = loreOf(w.small, id).dynasties.find((x) => x.id === did);
  const n = name.trim();
  if (!d || !n || n === d.name) return null;
  return { op: 'set_dynasty', id, dynasty: did, patch: { name: n } };
}

export const removeDynastyCommand = (id: number, did: number): Command => ({ op: 'remove_dynasty', id, dynasty: did });

// ---------- 大事 ----------

// 年表最后加一件：年份是时代的现在，只属于这一国
export function addEventCommand(w: World, id: number): Command | null {
  const m = w.small.countries?.[id];
  if (!m) return null;
  return { op: 'add_event', event: { year: Math.max(eraNow(worldEra(w.small)), m.founded), title: ARCHIVE_TEXT.newEvent, countries: [id] } };
}

const eventOf = (w: World, eid: number): HistoryEvent | undefined => w.small.archive?.events[eid];

export function eventTitleCommand(w: World, eid: number, title: string): Command | null {
  const e = eventOf(w, eid);
  const t = title.trim();
  if (!e || !t || t === e.title) return null;
  return { op: 'set_event', event: eid, patch: { title: t } };
}

export function eventYearCommand(w: World, eid: number, year: number): Command | null {
  const e = eventOf(w, eid);
  return e && year !== e.year ? { op: 'set_event', event: eid, patch: { year } } : null;
}

export function eventNoteCommand(w: World, eid: number, text: string): Command | null {
  const e = eventOf(w, eid);
  const cur = e?.note ?? '';
  if (!e || text === cur || (!text.trim() && !cur)) return null;
  return { op: 'set_event', event: eid, patch: { note: text.trim() ? text : null } };
}

// 牵涉的国家：加一国、去掉一国（写它的那一国去不掉；只剩一国时也去不掉）
export function eventLinkCommand(w: World, eid: number, country: number, on: boolean): Command | null {
  const e = eventOf(w, eid);
  if (!e) return null;
  const has = e.countries.includes(country);
  if (on === has) return null;
  if (!on && (e.countries.length < 2 || e.countries[0] === country)) return null;
  return { op: 'set_event', event: eid, patch: { countries: on ? [...e.countries, country] : e.countries.filter((c) => c !== country) } };
}

export const removeEventCommand = (eid: number): Command => ({ op: 'remove_event', event: eid });
