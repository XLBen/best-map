import { DIMENSION } from '../content/link-rules';
import { type Link, linksOf, renameLinks, stripLinks } from '../content/links';
import { originSourceId, recordedOrigin } from '../content/origin';
import { ITEM_ID, stableJson } from '../content/refs';
import { type ContentKind, type ContentWorld, type Renames, itemName, kindOf, itemId } from '../content/registry';
import { type Dimension, type Era, worldEras } from '../human/era';
import { type PackNode, canApply, finalItem, packItems } from '../packs';
import { contentKey } from './closure';

// 世界里的一项和它来源的库里那一项一样不一样（第六十二轮）。世界里的内容是独立的一份，改库不影响世界；不一样的项带标记，
// 可以“用库里的版本”（usedSourceItem）或“存回我的库”（savedBackItem）。纯函数，不引用内置的数据：库由调用方给。
//
//   none     没有来源、来源的库不在了、库里已经没有这一项：不标，也不报错
//   same     一样
//   trimmed  只差导入时去掉的引用（这个世界没有的目标）：不算改过，不标，页面上写一句。规则和导入（closure.ts 的 finalsOf）一样
//   changed  不一样：世界改过，或者库后来改了
//
// 和来源的库比，不和内置表比。比的是“这一项加进这个世界时该有的样子”（finalItem：改名、引用跟着改、自然生成关掉），所以撞过名的项不算不同。
// 不比 pack.sameIgnore（文化组的 weight：同一项在不同的库里权重不同）。
// 时代不比“有哪些变量”：世界的变量只能走“加变量”（第五十四轮），世界加的和库后来加的、删的都不算不同，两边都有的变量才比（不看 added）。
// 所以“用库里的版本”留着世界的变量表，世界的人口不会对不上。
//
// contentKey 按对象记比较用的字：包和世界里的项都是不改动的数据，这里也不改。

export interface DiffLib {
  key: string;
  pack: PackNode;
}

export type SourceDiff =
  | { t: 'none' }
  | { t: 'same'; lib: string }
  // gone：去掉的引用写到的名字（id）
  | { t: 'trimmed'; lib: string; gone: string[] }
  // fields：哪几个字段不同（字段表里的名字）
  | { t: 'changed'; lib: string; sourceId: string; source: unknown; fields: string[] };

const NONE: SourceDiff = { t: 'none' };
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// ---------- 库里的一项 ----------

const libIndex = new WeakMap<object, Map<string, Map<string, unknown>>>();
function sourceItem(pack: PackNode, kind: ContentKind, id: string): unknown {
  let byKind = libIndex.get(pack);
  if (!byKind) libIndex.set(pack, (byKind = new Map()));
  let byId = byKind.get(kind.id);
  if (!byId) {
    byId = new Map();
    for (const x of packItems(pack, kind.pack.key)) {
      const i = itemId(kind, x);
      if (!byId.has(i)) byId.set(i, x);
    }
    byKind.set(kind.id, byId);
  }
  return byId.get(id);
}

// ---------- 这个世界的表（一个世界算一遍） ----------

interface DiffCtx {
  world: ContentWorld;
  // 库里的 id → 世界里的 id（small.originId 记着撞名改过的）。没有改名时 null
  renames: Renames | null;
  back: Renames | null;
  ids: Map<string, Set<string>>;
  dims: Set<string>;
  // 加进世界时该有的样子（同一项给同一个对象，比较用的字才记得住）
  expected: Map<unknown, unknown>;
}

const contexts = new WeakMap<object, DiffCtx>();
function contextOf(world: ContentWorld): DiffCtx {
  let c = contexts.get(world);
  if (c) return c;
  const to = new Map<string, Map<string, string>>();
  const from = new Map<string, Map<string, string>>();
  for (const [kindId, of] of Object.entries(world.small.originId ?? {})) {
    const k = kindOf(kindId);
    if (!k) continue;
    for (const [worldId, srcId] of Object.entries(of)) {
      if (!to.has(k.pack.key)) to.set(k.pack.key, new Map());
      if (!from.has(k.pack.key)) from.set(k.pack.key, new Map());
      to.get(k.pack.key)!.set(srcId, worldId);
      from.get(k.pack.key)!.set(worldId, srcId);
    }
  }
  const asRenames = (m: Map<string, Map<string, string>>): Renames | null => (m.size ? ({ biomes: new Map(), riverTypes: new Map(), ...Object.fromEntries(m) } as Renames) : null);
  c = { world, renames: asRenames(to), back: asRenames(from), ids: new Map(), dims: new Set(worldEras(world.small).flatMap((e) => e.dimensions.map((d) => d.id))), expected: new Map() };
  contexts.set(world, c);
  return c;
}

const NO_RENAMES: Renames = { biomes: new Map(), riverTypes: new Map() };

function idsOf(c: DiffCtx, kindId: string): Set<string> {
  let s = c.ids.get(kindId);
  if (!s) {
    const k = kindOf(kindId);
    s = new Set(k ? k.inWorld(c.world).map((x) => itemId(k, x)) : []);
    c.ids.set(kindId, s);
  }
  return s;
}

// 这条引用的目标世界里有没有（和导入时的 avail 一样：自定义场跟着内容自动加，算有）
function available(c: DiffCtx, link: Pick<Link, 'kinds' | 'id'>): boolean {
  for (const kind of link.kinds) {
    if (kind === 'field' && ITEM_ID.test(link.id)) return true;
    if (kind === DIMENSION) {
      if (c.dims.has(link.id)) return true;
      continue;
    }
    const key = kindOf(kind)?.pack.key;
    const to = (key && c.renames?.[key]?.get(link.id)) || link.id;
    if (idsOf(c, kind).has(to)) return true;
  }
  return false;
}

function expectedOf(c: DiffCtx, kind: ContentKind, src: unknown, id: string): unknown {
  let e = c.expected.get(src);
  if (e === undefined) c.expected.set(src, (e = finalItem(kind, src, id, c.renames ?? NO_RENAMES)));
  return e;
}

// ---------- 比 ----------

const bareDim = (d: Dimension): unknown => {
  const { added: _, ...rest } = d;
  return rest;
};

// 时代：两边都有的变量才比
function eraKeys(kind: ContentKind, a: Era, b: Era): [string, string] {
  const inB = new Map(b.dimensions.map((d) => [d.id, d]));
  const inA = new Set(a.dimensions.map((d) => d.id));
  const shared = (e: Era, others: (id: string) => boolean) => e.dimensions.filter((d) => others(d.id)).map(bareDim);
  const skip = kind.pack.sameIgnore ?? [];
  const body = (e: Era, dims: unknown[]) => stableJson({ ...Object.fromEntries(Object.entries(e).filter(([k]) => !skip.includes(k))), dimensions: dims });
  return [body(a, shared(a, (id) => inB.has(id))), body(b, shared(b, (id) => inA.has(id)))];
}

function sameAs(kind: ContentKind, item: unknown, other: unknown): boolean {
  if (kind.id === 'era') {
    const [a, b] = eraKeys(kind, item as Era, other as Era);
    return a === b;
  }
  return contentKey(kind, item) === contentKey(kind, other);
}

// 哪几个字段不同（写在页面上：“不同：名字、颜色”）
function changedFields(kind: ContentKind, item: unknown, other: unknown): string[] {
  const a = item as Record<string, unknown>;
  const b = other as Record<string, unknown>;
  const skip = new Set([...(kind.pack.sameIgnore ?? []), ...(kind.id === 'era' ? ['dimensions'] : [])]);
  const out: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (skip.has(key) || stableJson(a[key]) === stableJson(b[key])) continue;
    out.push(kind.fields.find((f) => f.key === key)?.label ?? key);
  }
  if (kind.id === 'era') {
    const onlyDims = (e: Era) => ({ id: '', dimensions: e.dimensions }) as Era;
    const [x, y] = eraKeys(kind, onlyDims(item as Era), onlyDims(other as Era));
    if (x !== y) out.push(kind.fields.find((f) => f.key === 'dimensions')?.label ?? '变量');
  }
  return out;
}

// 世界里的这一项和来源比。libs：资源库里的全部库
export function sourceDiff(kind: ContentKind, id: string, item: unknown, world: ContentWorld, libs: readonly DiffLib[]): SourceDiff {
  if (!canApply(kind) || !isObject(item)) return NONE;
  const rec = recordedOrigin(world.small, kind.id, id);
  const lib = rec && libs.find((e) => e.key === rec[0]);
  if (!lib) return NONE;
  const sourceId = originSourceId(world.small, kind.id, id);
  const src = sourceItem(lib.pack, kind, sourceId);
  if (src === undefined) return NONE;
  const c = contextOf(world);
  const plain = expectedOf(c, kind, src, id);
  if (sameAs(kind, item, plain)) return { t: 'same', lib: lib.key };
  const missing = (l: Link) => !available(c, l);
  const gone = linksOf(kind, src).filter((l) => l.drop && missing(l));
  if (gone.length && sameAs(kind, item, finalItem(kind, stripLinks(kind, src, missing), id, c.renames ?? NO_RENAMES))) return { t: 'trimmed', lib: lib.key, gone: [...new Set(gone.map((l) => l.id))] };
  return { t: 'changed', lib: lib.key, sourceId, source: src, fields: changedFields(kind, item, plain) };
}

// 世界里一种内容的每一项：id → 和来源的差别
export function sourceDiffs(kind: ContentKind, world: ContentWorld, libs: readonly DiffLib[]): Map<string, SourceDiff> {
  const out = new Map<string, SourceDiff>();
  for (const x of kind.inWorld(world)) {
    const id = itemId(kind, x);
    out.set(id, sourceDiff(kind, id, x, world, libs));
  }
  return out;
}

// ---------- 用库里的版本 ----------

// 不比的键（比重）留世界的
function keepIgnored(kind: ContentKind, next: Record<string, unknown>, from: Record<string, unknown>): Record<string, unknown> {
  const skip = kind.pack.sameIgnore;
  if (!skip?.length) return next;
  const out = { ...next };
  for (const key of skip) {
    if (from[key] === undefined) delete out[key];
    else out[key] = from[key];
  }
  return out;
}

// 世界里这一项换成库里的版本之后的样子（不一样时才有）。世界没有的目标：只有 strip 类时原样（新世界也这样，本来就允许缺）；
// 有 hard、auto 类的时全部去掉，不留下找不到的，和导入时一样（只有这两种样子，换完之后才认得出是 same 或 trimmed）。比重留世界的；
// 时代留世界的变量表（added、世界加的、库里没有的都在），两边都有的变量按库里的写法
export function usedSourceItem(kind: ContentKind, id: string, item: unknown, world: ContentWorld, libs: readonly DiffLib[]): Record<string, unknown> | null {
  const d = sourceDiff(kind, id, item, world, libs);
  if (d.t !== 'changed') return null;
  const c = contextOf(world);
  const missing = (l: Link) => !available(c, l);
  const cut = linksOf(kind, d.source).some((l) => l.drop && l.cls !== 'strip' && missing(l));
  const next = finalItem(kind, cut ? stripLinks(kind, d.source, missing) : d.source, id, c.renames ?? NO_RENAMES) as Record<string, unknown>;
  const out = keepIgnored(kind, next, item as Record<string, unknown>);
  if (kind.id !== 'era') return out;
  const lib = new Map((d.source as Era).dimensions.map((x) => [x.id, x]));
  const dimensions = (item as Era).dimensions.map((x) => {
    const there = lib.get(x.id);
    if (!there) return x;
    const { added: _, ...rest } = there;
    return x.added ? { ...rest, added: true } : rest;
  });
  return { ...out, dimensions };
}

// ---------- 存回我的库 ----------

export interface SavedBack {
  lib: string;
  id: string;
  item: Record<string, unknown>;
  // 写到的、这个库里没有的（存进去之后在这个库里找不到）
  missing: string[];
}

// 世界里这一项写回来源的库时的样子（不一样时才有）：id、引用换回库里的，比重留库的；时代的变量表留库的（世界加的变量不进库：它的取值不在库里），
// 两边都有的变量按世界的写法。加进世界时才关掉的“自然生成”不写回去
export function savedBackItem(kind: ContentKind, id: string, item: unknown, world: ContentWorld, libs: readonly DiffLib[]): SavedBack | null {
  const d = sourceDiff(kind, id, item, world, libs);
  if (d.t !== 'changed') return null;
  const c = contextOf(world);
  const src = d.source as Record<string, unknown>;
  let next = (c.back ? renameLinks(kind, item, c.back) : item) as Record<string, unknown>;
  if (d.sourceId !== id) {
    // 改名时跟着带上的编号不写回去
    const named = finalItem(kind, src, id, c.renames ?? NO_RENAMES) as Record<string, unknown>;
    next = { ...next, id: d.sourceId, ...(next.name === named.name && src.name !== undefined ? { name: src.name } : {}) };
  }
  next = keepIgnored(kind, next, src);
  const fin = kind.pack.finalize?.(src) as Record<string, unknown> | undefined;
  if (fin && fin !== src) {
    next = { ...next };
    for (const key of Object.keys(fin)) if (src[key] === undefined && next[key] === fin[key]) delete next[key];
  }
  if (kind.id === 'era') {
    const here = new Map((item as Era).dimensions.map((x) => [x.id, x]));
    next = {
      ...next,
      dimensions: (src as unknown as Era).dimensions.map((x) => {
        const w = here.get(x.id);
        if (!w) return x;
        const { added: _, ...rest } = w;
        return x.added ? { ...rest, added: true } : rest;
      }),
    };
  }
  const pack = libs.find((e) => e.key === d.lib)!.pack;
  const missing = new Set<string>();
  for (const l of linksOf(kind, next)) {
    if (!l.drop || l.kinds.includes(DIMENSION) || l.kinds.includes('field')) continue;
    const found = l.kinds.some((kid) => {
      const k = kindOf(kid);
      return !k || sourceItem(pack, k, l.id) !== undefined;
    });
    if (found) continue;
    const k = kindOf(l.kinds[0]);
    const there = k?.inWorld(world).find((x) => itemId(k, x) === l.id);
    missing.add(there !== undefined && k ? itemName(k, there) : l.id);
  }
  return { lib: d.lib, id: d.sourceId, item: next, missing: [...missing] };
}
