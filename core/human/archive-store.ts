import type { ArchiveState, CountryLore, HistoryEvent, SmallState, World } from '../world';

// 国家的档案（第八十五轮）：small.archive 里的统治者、家族、备注、大事。
// 不可变的：每次改都换成新的对象（改到的那一国、那一件是新的，别的照旧是原来的对象）。small-copy.ts 按引用共用它，
// 所以别的命令每步不用序列化它，撤销记录里也只留一个引用；发给主线程时没换就不发（content-post.ts）。
// 这里只有读、换、整理；生成在 rulers.ts、events.ts，重新生成时留什么在 archive-keep.ts

export const EMPTY_LORE: CountryLore = Object.freeze({ rulers: [], dynasties: [] }) as CountryLore;

export const loreOf = (small: Pick<SmallState, 'archive'>, id: number): CountryLore => small.archive?.countries[id] ?? EMPTY_LORE;

// 现在的统治者（名单的最后一位）
export const currentRuler = (small: Pick<SmallState, 'archive'>, id: number) => {
  const list = loreOf(small, id).rulers;
  return list.length ? list[list.length - 1] : undefined;
};

const emptyArchive = (): ArchiveState => ({ countries: {}, events: {}, nextEvent: 1 });

// 换掉一国的档案（null 是去掉）
export function putLore(world: Pick<World, 'small'>, id: number, lore: CountryLore | null) {
  const a = world.small.archive ?? emptyArchive();
  const countries = { ...a.countries };
  if (lore) countries[id] = lore;
  else delete countries[id];
  world.small.archive = { ...a, countries };
}

// 换掉一件大事（null 是去掉）
export function putEvent(world: Pick<World, 'small'>, id: number, ev: HistoryEvent | null) {
  const a = world.small.archive ?? emptyArchive();
  const events = { ...a.events };
  if (ev) events[id] = ev;
  else delete events[id];
  world.small.archive = { ...a, events, nextEvent: Math.max(a.nextEvent, id + 1) };
}

// 新的一件大事的编号
export const nextEventId = (small: Pick<SmallState, 'archive'>): number => small.archive?.nextEvent ?? 1;

// 一国的大事（按年份、编号）
export function eventsOf(small: Pick<SmallState, 'archive'>, id: number): HistoryEvent[] {
  const out: HistoryEvent[] = [];
  for (const e of Object.values(small.archive?.events ?? {})) if (e.countries.includes(id)) out.push(e);
  return out.sort((a, b) => a.year - b.year || a.id - b.id);
}

// 整理（每次改国家之后，tidyCountries 里）：没了的国家的档案去掉；大事里去掉没了的国家，一国都不剩的去掉。
// map：国家换了编号（合并：b → a）。什么都没变时不换对象
export function tidyArchive(world: Pick<World, 'small'>, map?: ReadonlyMap<number, number>) {
  const a = world.small.archive;
  if (!a) return;
  const metas = world.small.countries ?? {};
  let countries = a.countries;
  for (const id of Object.keys(a.countries)) {
    if (metas[id]) continue;
    if (countries === a.countries) countries = { ...a.countries };
    delete countries[id];
  }
  let events = a.events;
  for (const [id, e] of Object.entries(a.events)) {
    const mapped = map ? e.countries.map((c) => map.get(c) ?? c) : e.countries;
    const list = [...new Set(mapped)].filter((c) => !!metas[c]);
    if (list.length === e.countries.length && list.every((c, k) => c === e.countries[k])) continue;
    if (events === a.events) events = { ...a.events };
    if (list.length) events[id] = { ...e, countries: list };
    else delete events[id];
  }
  if (countries === a.countries && events === a.events) return;
  world.small.archive = { ...a, countries, events };
}
