import { type ContentKind, itemId } from '../../../core/content/registry';
import { type PackWorld, canApply, packItems } from '../../../core/packs';
import type { LibraryEntry } from '../../library';
import { type ItemRow, libraryRows, worldRows } from './rows';

// 看的是哪一份、这一份里有什么（第五十九轮写在 pages.ts，第六十轮搬到这里：融入的逻辑也要用，又不能和 pages.ts 绕圈）

// ---------- 来源 ----------

// 看的是哪一份
export type SourceRef = { t: 'world' } | { t: 'lib'; key: string };
export const WORLD_SOURCE: SourceRef = { t: 'world' };

export interface PageCtx {
  world: PackWorld | null;
  lib: readonly LibraryEntry[];
}

export const sameSource = (a: SourceRef, b: SourceRef): boolean => a.t === b.t && (a.t === 'world' || a.key === (b as { key: string }).key);
export const entryOf = (src: SourceRef, ctx: PageCtx): LibraryEntry | undefined => (src.t === 'lib' ? ctx.lib.find((e) => e.key === src.key) : undefined);

// file：读进来的文件（第六十七轮，没装进资源库的临时库）
export type SourceKind = 'world' | 'builtin' | 'mine' | 'imported' | 'file';
export function sourceKind(src: SourceRef, ctx: PageCtx): SourceKind | null {
  if (src.t === 'world') return 'world';
  const e = entryOf(src, ctx);
  if (!e) return null;
  return e.builtin ? 'builtin' : e.mine ? 'mine' : e.file ? 'file' : 'imported';
}

export function sourceTitle(src: SourceRef, ctx: PageCtx): string {
  return src.t === 'world' ? '本世界' : (entryOf(src, ctx)?.pack.name ?? src.key);
}

// 标题下拉里读进来的文件写成“文件：xxx（没存到我的库）”
export const fileTitle = (e: Pick<LibraryEntry, 'file' | 'pack'>): string => `文件：${e.pack.name || e.file}（没存到我的库）`;

// 来源不在了（库删掉了、世界关了）：回到本世界
export const liveSource = (src: SourceRef, ctx: PageCtx): SourceRef => (src.t === 'lib' && !entryOf(src, ctx) ? WORLD_SOURCE : src);

// 只读的原因（能改时 null）
const READONLY_WHY: Record<SourceKind, string | null> = { world: null, mine: null, builtin: '内置的库只读', imported: '导入的库只读', file: '读进来的文件只读' };
export function readonlyWhy(src: SourceRef, ctx: PageCtx): string | null {
  const k = sourceKind(src, ctx);
  return k ? READONLY_WHY[k] : '这个库不在了';
}

// 这一种内容在这一份里能不能改：在只读的库里不能；本世界里星球形态不能（在“调整”里换）
export function kindReadonly(src: SourceRef, kind: ContentKind, ctx: PageCtx): string | null {
  const why = readonlyWhy(src, ctx);
  if (why) return why;
  if (src.t === 'world' && !canApply(kind)) return kind.pack.note ?? '不能改';
  return null;
}

// 标题的下拉：本世界 / 内置的库 / 我的库（导入的另成一段）/ + 新建一个库
export interface SourceMenuItem {
  src: SourceRef;
  name: string;
  on: boolean;
}
export interface SourceMenu {
  world: SourceMenuItem;
  builtin: SourceMenuItem[];
  mine: SourceMenuItem[];
  imported: SourceMenuItem[];
  // 读进来的文件（第六十七轮）
  files: SourceMenuItem[];
}
export function sourceMenu(cur: SourceRef, ctx: PageCtx): SourceMenu {
  const item = (e: LibraryEntry): SourceMenuItem => {
    const src: SourceRef = { t: 'lib', key: e.key };
    return { src, name: e.pack.name, on: sameSource(src, cur) };
  };
  return {
    world: { src: WORLD_SOURCE, name: '本世界', on: cur.t === 'world' },
    builtin: ctx.lib.filter((e) => e.builtin).map(item),
    mine: ctx.lib.filter((e) => !e.builtin && e.mine).map(item),
    imported: ctx.lib.filter((e) => !e.builtin && !e.mine && !e.file).map(item),
    files: ctx.lib.filter((e) => e.file).map((e) => ({ ...item(e), name: fileTitle(e) })),
  };
}

// ---------- 这一份里的内容 ----------

const NO_ITEMS: readonly unknown[] = [];
export function itemsOf(src: SourceRef, kind: ContentKind, ctx: PageCtx): readonly unknown[] {
  if (src.t === 'world') return ctx.world ? kind.inWorld(ctx.world) : NO_ITEMS;
  const e = entryOf(src, ctx);
  return e ? packItems(e.pack, kind.pack.key) : NO_ITEMS;
}

export function itemOf(src: SourceRef, kind: ContentKind, id: string, ctx: PageCtx): unknown {
  return itemsOf(src, kind, ctx).find((x) => itemId(kind, x) === id);
}

export const kindTitle = (k: ContentKind): string => (k.id === 'popValue' ? '取值' : k.id === 'landmarkType' ? '地标' : k.id === 'pointType' ? '自定义点' : k.id === 'riverType' ? '河' : k.id === 'lakeType' ? '湖' : k.id === 'islandType' ? '岛' : k.id === 'cityRank' ? '城市等级' : k.id === 'era' ? '时代' : k.label);

// 列表的来源（rows.ts：行里有状态），同一项只列一次。按世界、库记着，点进点出不重算
const rowsMemo = new WeakMap<object, Map<string, ItemRow[]>>();
const NO_WORLD = {};
export function rowsOf(src: SourceRef, kind: ContentKind, ctx: PageCtx): ItemRow[] {
  const holder = src.t === 'world' ? (ctx.world ?? NO_WORLD) : entryOf(src, ctx)?.pack;
  if (!holder) return [];
  // 库里的行要看世界（在不在本世界）
  let m = rowsMemo.get(holder);
  if (!m) rowsMemo.set(holder, (m = new Map()));
  const worldTag = src.t === 'lib' ? worldKey(ctx.world) : '';
  const key = `${kind.id}|${worldTag}`;
  let rows = m.get(key);
  if (rows) return rows;
  const e = entryOf(src, ctx);
  rows = src.t === 'world' ? (ctx.world ? worldRows(kind, ctx.world) : []) : e ? libraryRows(e, kind, ctx.world) : [];
  // 按这一份里的先后（库里是按小包走的）
  const order = new Map(itemsOf(src, kind, ctx).map((x, k) => [itemId(kind, x), k]));
  rows.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9));
  m.set(key, rows);
  return rows;
}
// 世界每变一次换一个号（库里的行要重新看在不在本世界）
const worldIds = new WeakMap<object, number>();
let worldSeq = 0;
function worldKey(w: PackWorld | null): number {
  if (!w) return 0;
  let n = worldIds.get(w);
  if (!n) worldIds.set(w, (n = ++worldSeq));
  return n;
}
