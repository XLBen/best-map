import { type ContentRef, type LinkTable, linkTable, packScope, referrersOf, worldScope } from '../../../core/content/links';
import { type ContentKind, type UsageWorld, itemName, kindOf, usageOf } from '../../../core/content/registry';
import type { PackNode } from '../../../core/packs';
import { classCode } from '../../../core/human/terrain-class';
import { resourceCode } from '../../../core/human/resources';
import { lakeTypesOf } from '../../../core/lake-types';
import { riverTypesOf } from '../../../core/river-types';
import type { World } from '../../../core/world';
import { type PartOf, partOf } from './page-children';
import { type PageCtx, type SourceRef, entryOf, itemOf, kindTitle } from './page-source';

// 编辑页底部的“谁用到它”（第六十二轮）：引用它的内容（引用表 core/content/links.ts，能点过去）、它融入在哪几个上级下面（第六十轮的“在 X、Y”合进来）、
// 地图上用到的地方。不做关系图，不做缺引用标红。表按世界、库记着：一个 700 多项的世界建一次约 6 ms，点开一项不用再算

export interface UsedByRow {
  kind: string;
  id: string;
  name: string;
}
export interface UsedByGroup {
  kind: string;
  title: string;
  rows: UsedByRow[];
}
export interface UsedBy {
  // 融入在哪几个上级下面（上级自己写着它的也算在 groups 里，这里不重复）
  parents: PartOf[];
  groups: UsedByGroup[];
  // 地图上用到的地方：“3 个国家的政体”“长在 1200 格”
  places: string | null;
  // 收起时写的一句
  brief: string;
  empty: boolean;
}

const NO_HOLDER = {};
const tables = new WeakMap<object, LinkTable>();
function tableOf(src: SourceRef, ctx: PageCtx): LinkTable {
  const holder: object = src.t === 'world' ? (ctx.world ?? NO_HOLDER) : (entryOf(src, ctx)?.pack ?? NO_HOLDER);
  let t = tables.get(holder);
  if (!t) {
    t = src.t === 'world' ? (ctx.world ? linkTable(worldScope(ctx.world)) : linkTable({ items: () => [] })) : linkTable(holder === NO_HOLDER ? { items: () => [] } : packScope(holder as PackNode));
    tables.set(holder, t);
  }
  return t;
}

// 引用它的内容，按种类（表里的先后）
export function referrerGroups(table: LinkTable, ref: ContentRef, nameOf: (r: ContentRef) => string): UsedByGroup[] {
  const by = new Map<string, Map<string, UsedByRow>>();
  for (const { from } of referrersOf(table, ref)) {
    if (from.kind === ref.kind && from.id === ref.id) continue;
    let m = by.get(from.kind);
    if (!m) by.set(from.kind, (m = new Map()));
    if (!m.has(from.id)) m.set(from.id, { kind: from.kind, id: from.id, name: nameOf(from) });
  }
  return [...by.entries()].map(([kind, m]) => {
    const k = kindOf(kind);
    return { kind, title: k ? kindTitle(k) : kind, rows: [...m.values()] };
  });
}

// 推导里这个数有几格
function countOf(arr: ArrayLike<number> | undefined, v: number): number {
  if (!arr) return 0;
  let n = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] === v) n++;
  return n;
}
// 推导里的编号（0 是没有）
const countCode = (arr: ArrayLike<number> | undefined, code: number): number => (code > 0 ? countOf(arr, code) : 0);

// 地图上用到的地方。放在 small.content 的种类看 usage.ts（引擎查的同一份）；生态、河、湖、地形类别、资源是按规则长出来的，看推导
export function mapPlaces(kind: ContentKind, id: string, world: UsageWorld): string | null {
  const w = world as Partial<World> & UsageWorld;
  const d = w.derived;
  const parts: string[] = [];
  const cells = (n: number, text: string) => {
    if (n > 0) parts.push(`${text} ${n.toLocaleString('en-US')} 格`);
  };
  const small = w.small;
  if (d) {
    if (kind.id === 'biome') {
      const k = small.species.findIndex((s) => s.id === id);
      if (k >= 0) cells(countOf(d.dominant, k), '长在');
    }
    if (kind.id === 'riverType') cells(countCode(d.riverType, riverTypesOf(small).findIndex((t) => t.id === id) + 1), '河道');
    if (kind.id === 'lakeType') cells(countCode(d.lakeType, lakeTypesOf(small).findIndex((t) => t.id === id) + 1), '湖');
    if (kind.id === 'terrainClass') cells(countCode(d.terrainClass, classCode(small, id)), '占');
    if (kind.id === 'resource') cells(countCode(d.resource, resourceCode(small, id)), '占');
  }
  if (kind.id === 'countryTier') {
    const n = Object.values(small.countries ?? {}).filter((c) => c.tier === id).length;
    if (n) parts.push(`${n} 个国家`);
  }
  const u = usageOf(kind, world, id);
  if (u) parts.push(u.label);
  return parts.length ? parts.join('、') : null;
}

export function usedByOf(src: SourceRef, kind: ContentKind, id: string, item: unknown, ctx: PageCtx): UsedBy {
  const table = tableOf(src, ctx);
  const nameOf = (r: ContentRef): string => {
    const k = kindOf(r.kind);
    const x = k ? itemOf(src, k, r.id, ctx) : undefined;
    return k && x !== undefined ? itemName(k, x) : r.id;
  };
  const groups = referrerGroups(table, { kind: kind.id, id }, nameOf);
  const listed = new Set(groups.flatMap((g) => g.rows.map((r) => `${r.kind}\u0000${r.id}`)));
  const parents = partOf(src, kind, item, ctx).filter((p) => !listed.has(`${p.kind}\u0000${p.id}`));
  const places = src.t === 'world' && ctx.world ? mapPlaces(kind, id, ctx.world) : null;
  const says = [...parents.slice(0, 1).map((p) => `在 ${p.name}`), ...groups.slice(0, 3).map((g) => `${g.title} ${g.rows.length}`), ...(places ? [places] : [])];
  return { parents, groups, places, brief: says.length ? says.join(' · ') : '没有', empty: !parents.length && !groups.length && !places };
}
