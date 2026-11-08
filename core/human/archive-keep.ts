import type { ArchiveState, CountryLore, CountryMeta, HistoryEvent, World } from '../world';
import type { Era } from './era';
import { generateEvents } from './events';
import { generateLore, loreMemo } from './rulers';

// 生成、重新生成国家时档案里留什么（第八十五轮）。重新长国家（generateHuman 的 countryMode 是 generate：生成人文、生成国家、
// 重新生成国家、重新生成人文和国家）的最后一步：
//   - 锁定、留下来的国家（同一个档案对象）：备注、统治者、家族、大事都不动；
//   - 别的国家是新生成的：统治者、家族按 rulers.ts 生成，结盟、开战、从属按 events.ts 生成；
//     同一个编号在重新生成之前就有（按编号留下来的国家）时，它的备注留着；它的统治者、家族自己改过（edited）时整份留着，不用生成的；
//   - 大事：自己写的、改过的（没有 auto）留着，去掉已经没有的国家，一国都不剩的去掉；生成的只留两头都是锁定的国家的，其余重新生成。
// 只重新生成人文（国家的领土不动，countryMode 是 keep）时国家的档案一个都不动。生成之前没有档案时，就只是生成。

export interface ArchiveBefore {
  archive?: ArchiveState;
  metas: Record<string, CountryMeta>;
}

export const archiveBefore = (world: World): ArchiveBefore => ({ ...(world.small.archive ? { archive: world.small.archive } : {}), metas: { ...(world.small.countries ?? {}) } });

export function writeArchive(world: World, before: ArchiveBefore, seed: number, era: Era | undefined) {
  const small = world.small;
  const metas = small.countries;
  if (!metas || !Object.keys(metas).length) {
    delete small.archive;
    return;
  }
  const old = before.archive;
  const kept = new Set<number>();
  for (const m of Object.values(metas)) if (before.metas[m.id] === m) kept.add(m.id);
  const countries: Record<string, CountryLore> = {};
  const fresh: CountryMeta[] = [];
  const memo = loreMemo();
  for (const m of Object.values(metas).sort((a, b) => a.id - b.id)) {
    const was = old?.countries[m.id];
    if (kept.has(m.id)) {
      if (was) countries[m.id] = was;
      continue;
    }
    fresh.push(m);
    const gen = generateLore(world, m, seed, era, memo);
    const lore: CountryLore = was?.edited ? { rulers: was.rulers, dynasties: was.dynasties, edited: true } : gen;
    if (was?.note !== undefined && before.metas[m.id]) lore.note = was.note;
    countries[m.id] = lore;
  }
  const events: Record<string, HistoryEvent> = {};
  let next = old?.nextEvent ?? 1;
  for (const e of Object.values(old?.events ?? {}).sort((a, b) => a.id - b.id)) {
    if (e.auto) {
      if (e.countries.every((c) => kept.has(c))) events[e.id] = e;
      continue;
    }
    const list = e.countries.filter((c) => !!metas[c]);
    if (!list.length) continue;
    events[e.id] = list.length === e.countries.length ? e : { ...e, countries: list };
  }
  for (const e of generateEvents(world, fresh, seed, era)) {
    events[next] = { id: next, ...e };
    next++;
  }
  small.archive = { countries, events, nextEvent: next };
}
