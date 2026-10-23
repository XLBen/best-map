import { signal } from '@preact/signals';
import type { WorldDoc } from '../core/engine';
import type { Settings } from '../core/world';
import { idbAll, idbGet, idbTx } from './idb';

// “我的地图”：存在这个浏览器里、有名字的世界（IndexedDB 的 maps、mapDocs 表，第 6 版加的）。
// maps 里是列表要用的一小条（名字、时间、地区还是星球、格数、缩略图），mapDocs 里是整个世界文件（WorldDoc，第 5 版）：
// 打开列表时不必把每个世界的全部命令都读进来。两张表总在同一个事务里写。
// 当前的世界“连着”一张地图（mapLink）时，自动保存也一起更新那一张（state.ts 的 autosave），这张地图不会落后。
// 连着的是哪一张记在自动保存里（kv 的 autosave 的 mapId），刷新后照样连着。
// 这里的函数都对一个可以换掉的 MapStore 操作：测试里用内存里的

export type MapKind = 'region' | 'planet';

export interface MapEntry {
  id: string;
  name: string;
  savedAt: number;
  kind: MapKind;
  // 一块地区：地图的宽（km）；整个星球：半径（km）
  sizeKm: number;
  cells: number;
  // 一共多少步（世界文件里的命令条数）
  steps: number;
  // 缩略图（约 240 像素宽的 JPEG data: 地址）；没截到时没有
  thumb?: string;
}

export interface MapStore {
  list(): Promise<MapEntry[]>;
  entry(id: string): Promise<MapEntry | undefined>;
  doc(id: string): Promise<WorldDoc | undefined>;
  // 一个事务里写这一条和（给了时）它的世界文件
  write(entry: MapEntry, doc?: WorldDoc): Promise<void>;
  remove(id: string): Promise<void>;
}

export const idbMapStore: MapStore = {
  list: () => idbAll<MapEntry>('maps'),
  entry: (id) => idbGet<MapEntry>('maps', id),
  doc: (id) => idbGet<WorldDoc>('mapDocs', id),
  write: (entry, doc) =>
    idbTx(doc ? ['maps', 'mapDocs'] : ['maps'], 'readwrite', (maps, docs) => {
      maps.put(entry, entry.id);
      if (doc) docs.put(doc, entry.id);
    }),
  remove: (id) =>
    idbTx(['maps', 'mapDocs'], 'readwrite', (maps, docs) => {
      maps.delete(id);
      docs.delete(id);
    }),
};

// 只在内存里的（测试用）
export function memoryMapStore(): MapStore & { entries: Map<string, MapEntry>; docs: Map<string, WorldDoc> } {
  const entries = new Map<string, MapEntry>();
  const docs = new Map<string, WorldDoc>();
  return {
    entries,
    docs,
    list: async () => [...entries.values()].map((e) => structuredClone(e)),
    entry: async (id) => (entries.has(id) ? structuredClone(entries.get(id)!) : undefined),
    doc: async (id) => (docs.has(id) ? structuredClone(docs.get(id)!) : undefined),
    write: async (entry, doc) => {
      entries.set(entry.id, structuredClone(entry));
      if (doc) docs.set(entry.id, structuredClone(doc));
    },
    remove: async (id) => {
      entries.delete(id);
      docs.delete(id);
    },
  };
}

// ---------- 名字 ----------

const DEFAULT_NAME = '新世界';
// 默认的名字取最大的一块陆地的地名
const LAND = new Set(['continent', 'island', 'archipelago']);

// 已经有了就加个数：“赤原”“赤原 2”“赤原 3”……
export function uniqueName(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  const name = base.trim() || DEFAULT_NAME;
  if (!set.has(name)) return name;
  for (let k = 2; ; k++) if (!set.has(`${name} ${k}`)) return `${name} ${k}`;
}

// 第一次保存时的默认名字：最大的一块陆地（大陆、岛、群岛）的名字，没有时“新世界”
export function defaultMapName(features: readonly { type: string; name: string; areaKm2: number }[], taken: Iterable<string>): string {
  let best: { name: string; areaKm2: number } | null = null;
  for (const f of features) if (LAND.has(f.type) && f.name.trim() && (!best || f.areaKm2 > best.areaKm2)) best = f;
  return uniqueName(best?.name ?? DEFAULT_NAME, taken);
}

// 从文件名来的名字：去掉 .json
export function nameFromFile(file: string): string {
  return file.replace(/\.json$/i, '').trim();
}

// 导出时的文件名：去掉文件名里不能用的字
export function fileNameOf(name: string): string {
  return `${name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'world'}.json`;
}

// ---------- 一张地图的概况 ----------

export function summaryOf(settings: Settings): Pick<MapEntry, 'kind' | 'sizeKm' | 'cells'> {
  if (settings.globe) return { kind: 'planet', sizeKm: Math.round(settings.radiusKm ?? 6371), cells: settings.cells };
  const tall = Math.abs(settings.latNorth - settings.latSouth) * 111.2;
  return { kind: 'region', sizeKm: Math.round(tall * settings.aspect), cells: settings.cells };
}

// “一块地区 · 约 4400 km 宽 · 4 万格”
export function describeMap(e: Pick<MapEntry, 'kind' | 'sizeKm' | 'cells'>): string {
  const km = e.sizeKm >= 1000 ? Math.round(e.sizeKm / 100) * 100 : Math.round(e.sizeKm);
  const cells = e.cells >= 10000 ? `${Math.round(e.cells / 1000) / 10} 万格` : `${e.cells} 格`;
  return e.kind === 'planet' ? `整个星球 · 半径 ${km} km · ${cells}` : `一块地区 · 约 ${km} km 宽 · ${cells}`;
}

// ---------- 存、改名、删 ----------

let idSeq = 0;
function newMapId(now = Date.now()): string {
  const rnd = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `m${now.toString(36)}-${(idSeq++).toString(36)}-${rnd}`;
}

// 新的一张（名字和别的重了就加个数）
export async function createMap(store: MapStore, a: { name: string; doc: WorldDoc; thumb?: string | null; now?: number }): Promise<MapEntry> {
  const now = a.now ?? Date.now();
  const taken = (await store.list()).map((e) => e.name);
  const entry: MapEntry = { id: newMapId(now), name: uniqueName(a.name, taken), savedAt: now, ...summaryOf(a.doc.settings), steps: a.doc.commands.length };
  if (a.thumb) entry.thumb = a.thumb;
  await store.write(entry, a.doc);
  return entry;
}

// 盖掉一张（名字照旧；没给缩略图时缩略图照旧）。那一张已经不在了时返回 null
export async function overwriteMap(store: MapStore, id: string, a: { doc: WorldDoc; thumb?: string | null; now?: number }): Promise<MapEntry | null> {
  const old = await store.entry(id);
  if (!old) return null;
  const entry: MapEntry = { ...old, savedAt: a.now ?? Date.now(), ...summaryOf(a.doc.settings), steps: a.doc.commands.length };
  if (a.thumb) entry.thumb = a.thumb;
  await store.write(entry, a.doc);
  return entry;
}

// 改名（和别的重了就加个数；空的不改）。那一张已经不在了时返回 null
export async function renameMap(store: MapStore, id: string, name: string): Promise<MapEntry | null> {
  const list = await store.list();
  const old = list.find((e) => e.id === id);
  if (!old) return null;
  if (!name.trim()) return old;
  const entry = { ...old, name: uniqueName(name, list.filter((e) => e.id !== id).map((e) => e.name)) };
  await store.write(entry);
  return entry;
}

export function deleteMap(store: MapStore, id: string): Promise<void> {
  return store.remove(id);
}

// 列表：最近保存的在前
export async function listMaps(store: MapStore): Promise<MapEntry[]> {
  return (await store.list()).sort((a, b) => b.savedAt - a.savedAt);
}

// ---------- 当前的世界连着哪一张 ----------

// 连着的地图：epoch 是连上时世界的纪元（state.ts 的 worldEpoch）。新建、打开了别的世界纪元就变了，
// 这时它自动不算数（还在路上的自动保存也不会把新的世界写进这一张）
export interface MapLink {
  id: string;
  name: string;
  epoch: number;
}
export const mapLink = signal<MapLink | null>(null);
// 连着的那一张最后一次写进去时世界的状态（state.ts 的 worldState）：与现在的不同就是“有改动没保存”
export const mapSavedState = signal<number>(-1);
// 打开世界文件时记下文件名，第一次保存时当默认名字（同样按纪元）
export const fileHint = signal<{ name: string; epoch: number } | null>(null);

export function activeLink(link: MapLink | null, epoch: number): MapLink | null {
  return link && link.epoch === epoch ? link : null;
}

// 新建、打开别的世界之前要不要先问“先保存吗”：没连着地图、而且生成之后还改过
// （生成的那几步之外还有做了的步：新建向导生成的世界开头是两步）
export const GEN_STEPS = 2;
export function needsSaveQuestion(linked: boolean, doneSteps: number): boolean {
  return !linked && doneSteps > GEN_STEPS;
}

// 缩略图：主线程的界面挂上（截地图画面）；自动保存时每隔几分钟也换一张
export const thumbHook: { make: (() => string | null) | null } = { make: null };
export const THUMB_EVERY_MS = 3 * 60 * 1000;

// 存储满了
export function isQuotaError(e: unknown): boolean {
  const n = (e as { name?: unknown } | null)?.name;
  return n === 'QuotaExceededError' || n === 'NS_ERROR_DOM_QUOTA_REACHED';
}
