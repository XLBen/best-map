import { computed, signal } from '@preact/signals';
import type { WorldDoc } from '../../core/engine';
import { docText } from '../doc-text';
import { type MapEntry, type MapStore, activeLink, mapLink, summaryOf, thumbHook } from '../maps';
import {
  VERSION_EVERY_MS,
  type VersionInfo,
  type VersionIo,
  type VersionWhy,
  addVersion,
  browserVersionIo,
  dropSeries,
  latestOf,
  makeRoom,
  mapSeries,
  moveSeries,
  overwriteKeeping,
  removeVersion,
  sortVersions,
  versionBudget,
  worldSeries,
} from '../versions';
import { currentHost, getDoc, idleWithin } from './worker-host';
import { world, worldEpoch } from './world';

// 以前的版本（第九十五轮，规则在 ../versions.ts）：现在的世界是哪一串、什么时候留一份、列表的信号。
// 不引用界面，也不引用自动保存（autosave.ts 引用这里）；回到某一份、导出、删除前的确认在 ui/maps/versions.ts

// 全部的版本（不带世界文件本身，最近留的在前）；还没读过时 null
export const versions = signal<VersionInfo[] | null>(null);

const io: { now: VersionIo } = { now: browserVersionIo };
// 测试换成内存里的；不给就回到浏览器的
export function useVersionIo(next?: VersionIo) {
  io.now = next ?? browserVersionIo;
  versions.value = null;
  lastAt.clear();
  known.clear();
  made = null;
  adopted.value = null;
  chain = Promise.resolve();
}

// ---------- 现在的世界是哪一串 ----------

// 没存进“我的地图”的世界的编号：新建、打开时起一个，记在自动保存的头里（刷新以后还是它）。
// 每个纪元（新建、打开一次）起的那一个不变（made）；接着用以前的编号时记在 adopted 里——它是信号，currentSeries 跟着变
let made: { epoch: number; id: string } | null = null;
const adopted = signal<{ epoch: number; id: string } | null>(null);
const newWorldId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
function idAt(epoch: number, kept: { epoch: number; id: string } | null): string {
  if (kept && kept.epoch === epoch) return kept.id;
  if (!made || made.epoch !== epoch) made = { epoch, id: newWorldId() };
  return made.id;
}
export function worldId(): string {
  return idAt(worldEpoch.peek(), adopted.peek());
}
// 打开的是上次的世界、回到了一个没存的世界的某一份：接着用它的编号
export function adoptWorldId(id: string | undefined) {
  if (id) adopted.value = { epoch: worldEpoch.peek(), id };
}

// 现在的世界的版本记在哪一串上：连着“我的地图”的一张就跟着那一张，不然按世界的编号。没有世界时 null
export function seriesNow(): string | null {
  if (!world.peek()) return null;
  const link = activeLink(mapLink.peek(), worldEpoch.peek());
  return link ? mapSeries(link.id) : worldSeries(worldId());
}
export const currentSeries = computed<string | null>(() => {
  if (!world.value) return null;
  const link = activeLink(mapLink.value, worldEpoch.value);
  return link ? mapSeries(link.id) : worldSeries(idAt(worldEpoch.value, adopted.value));
});

// ---------- 读、留、删 ----------

export async function refreshVersions(): Promise<VersionInfo[]> {
  try {
    versions.value = sortVersions(await io.now.list());
  } catch {
    // 存储用不了：当没有
    versions.value ??= [];
  }
  return versions.value;
}

// 合计的上限：隔一阵问一次浏览器给多少、用了多少
let budget: { at: number; bytes: number } | null = null;
async function budgetNow(): Promise<number> {
  const now = Date.now();
  if (budget && now - budget.at < 10 * 60 * 1000) return budget.bytes;
  let est: { quota?: number; usage?: number } | null = null;
  try {
    est = (await (globalThis.navigator as { storage?: { estimate?: () => Promise<{ quota?: number; usage?: number }> } } | undefined)?.storage?.estimate?.()) ?? null;
  } catch {
    est = null;
  }
  budget = { at: now, bytes: versionBudget(est) };
  return budget.bytes;
}

// 现在的世界文件的字：主线程手上的命令记录（没变的命令不重转，见 doc-text.ts）；没有时用调用方手上的那一份
// （刚打开的世界文件），再没有才问计算程序
export async function currentDocText(given?: WorldDoc): Promise<{ text: string; doc: WorldDoc } | null> {
  const doc = currentHost()?.mirror.doc() ?? given ?? (await getDoc());
  return doc ? { text: docText(doc), doc } : null;
}

// 每一串上一次留的时间（平常隔 VERSION_EVERY_MS 才留一份）
const lastAt = new Map<string, number>();
// 一次只留一份
let chain: Promise<unknown> = Promise.resolve();
const queued = <T>(run: () => Promise<T>): Promise<T> => {
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
};

export interface KeepArgs {
  series: string;
  text: string;
  steps: number;
  why: VersionWhy;
  name?: string;
  summary?: Pick<MapEntry, 'kind' | 'sizeKm' | 'cells'>;
  thumb?: string | null;
}
// 留下这一份（和那一串最新的一字不差时不留）。留成了、本来就有，返回那一份；没留成 null
export function keepText(a: KeepArgs): Promise<VersionInfo | null> {
  return queued(async () => {
    const r = await addVersion(io.now, a, { budget: await budgetNow(), current: seriesNow() });
    if (r.kind === 'failed') return null;
    lastAt.set(a.series, Math.max(lastAt.get(a.series) ?? 0, r.info.at));
    if (r.kind === 'kept') await refreshVersions();
    return r.info;
  });
}

// 把现在的世界留一份。用户点了什么之后留的（回去之前、换世界之前、重新载入之前）：先等排着的编辑算完——还在算的那一笔也要在里面。
// 第九十六轮：最多等几秒（idleWithin）。计算程序卡住时不一直等：留下的是已经应答的最后一步为止的样子
// opened：刚打开的那份世界文件（主线程还没有命令记录时用它，不为这个去问计算程序）
export async function keepVersion(why: VersionWhy, opened?: WorldDoc): Promise<VersionInfo | null> {
  if (why !== 'opened') await idleWithin();
  return keepNow(why, opened);
}
async function keepNow(why: VersionWhy, opened?: WorldDoc): Promise<VersionInfo | null> {
  const series = seriesNow();
  if (!series) return null;
  const epoch = worldEpoch.peek();
  const link = activeLink(mapLink.peek(), epoch);
  const got = await currentDocText(opened);
  if (!got || epoch !== worldEpoch.peek()) return null;
  let thumb: string | null = null;
  try {
    thumb = thumbHook.make?.() ?? null;
  } catch {
    thumb = null;
  }
  return keepText({ series, text: got.text, steps: got.doc.commands.length, why, ...(link ? { name: link.name } : {}), summary: summaryOf(got.doc.settings), thumb });
}

// 自动保存写成之后：这一串离上一次留的那一份够久了就留一份。不等它（不挡着自动保存）
export function versionAfterSave(): void {
  const series = seriesNow();
  if (!series) return;
  const now = Date.now();
  const last = lastAt.get(series);
  if (last !== undefined && now - last < VERSION_EVERY_MS) return;
  void (async () => {
    if (last === undefined) {
      // 这次打开页面第一次：看看存着的最新一份是什么时候的
      const at = latestOf(await refreshVersions(), series)?.at ?? -Infinity;
      if (!lastAt.has(series)) lastAt.set(series, at);
      if (Date.now() - at < VERSION_EVERY_MS) return;
    }
    // 先记上：这一份还在写的时候来的下一次自动保存不再排一份
    lastAt.set(series, Date.now());
    // 自动保存刚写成：命令记录就是存下的那一份，不等后面排着的编辑
    await keepNow('auto');
  })().catch(() => {});
}

export async function versionText(id: string): Promise<string | null> {
  try {
    return (await io.now.text(id)) ?? null;
  } catch {
    return null;
  }
}

export async function deleteVersion(id: string): Promise<void> {
  await removeVersion(io.now, id);
  await refreshVersions();
}

// 一个世界的键换了（第一次存进“我的地图”、连着的那一张删掉了）：它的版本跟着走
export async function versionsMoved(from: string, to: string): Promise<void> {
  try {
    await queued(() => moveSeries(io.now, from, to));
    const at = lastAt.get(from);
    if (at !== undefined) lastAt.set(to, Math.max(at, lastAt.get(to) ?? -Infinity));
    lastAt.delete(from);
    await refreshVersions();
  } catch {
    // 改不了：原来那一串还在，在“没存进我的地图的世界”里找得到
  }
}

// “我的地图”里删掉了一张（不是现在开着的）：它的版本一起删
export async function versionsDropped(series: string): Promise<void> {
  try {
    await queued(() => dropSeries(io.now, series));
    lastAt.delete(series);
    await refreshVersions();
  } catch {
    // 删不了：留着，列表里还能删
  }
}

// 自动保存写不进去（存储满了）：把旧的版本丢掉一半腾地方。返回丢了几份
export async function freeVersionRoom(): Promise<number> {
  try {
    const n = await queued(() => makeRoom(io.now));
    if (n) await refreshVersions();
    return n;
  } catch {
    return 0;
  }
}

// ---------- 盖掉“我的地图”里的一张 ----------

// 界面挂上（ui/maps/versions.ts）：盖掉之前留了一份时说一声
export const versionEvents: { replaced: (mapName: string) => void } = { replaced: () => {} };

// 这个页面上一次看到、写下每一张时它的保存时间：存着的不是这一次的，就是别的页面写过
const known = new Map<string, number>();
export function noteMapSeen(id: string, savedAt: number) {
  known.set(id, savedAt);
}

// 盖掉一张（自动保存跟着写、⌘S）：别的页面写过、盖掉会丢东西时，先把存着的那一份留成一个版本，说一声
export async function overwriteLinked(store: MapStore, id: string, a: { doc: WorldDoc; thumb?: string | null; now?: number }): Promise<MapEntry | null> {
  const r = await overwriteKeeping(store, io.now, id, { ...a, ...(known.has(id) ? { known: known.get(id)! } : {}), budget: await budgetNow(), current: seriesNow() });
  if (!r) {
    known.delete(id);
    return null;
  }
  known.set(id, r.entry.savedAt);
  if (r.kept) {
    void refreshVersions();
    versionEvents.replaced(r.entry.name);
  }
  return r.entry;
}
