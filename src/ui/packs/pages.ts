import { type ContentKind, itemId, itemName, kindOf } from '../../../core/content/registry';
import type { Era } from '../../../core/human';
import { type PackWorld, canApply, packItems, packSections } from '../../../core/packs';
import type { Species } from '../../../core/species';
import { PLAIN_TYPE, type WaterType, perCellRule } from '../../../core/water-types';
import { type WaterKind, waterAllowed } from '../../../core/water-table';
import type { LibraryEntry } from '../../library';
import { CARD_ICON, type CardDef, DEFAULT_INSIDE, HOME_LAYOUT, WATER_KINDS, type Inside } from './page-layout';
import { type Segment, segmentsOf } from './page-segments';
import { type RepoRow, type TreeNode, HUMAN_KINDS, GOV_KINDS, SETTLE_KINDS, packTree, treeRows } from './repo';

// 新的资源库面板（第五十九轮）的逻辑：看的是哪一份（本世界、内置的库、我的库）、首页有哪些卡片、怎么点进去、面包屑、
// 列表里有什么、某一项的页面有哪些段、只读与否、这一项能做什么、返回。全部在这里，组件只负责画。不碰界面，测试直接调。
//
// 切换来源后界面完全一样：所有的页面都从 SourceRef + PageCtx 算出来，本世界和库只差 itemsOf 和只读

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

export type SourceKind = 'world' | 'builtin' | 'mine' | 'imported';
export function sourceKind(src: SourceRef, ctx: PageCtx): SourceKind | null {
  if (src.t === 'world') return 'world';
  const e = entryOf(src, ctx);
  if (!e) return null;
  return e.builtin ? 'builtin' : e.mine ? 'mine' : 'imported';
}

export function sourceTitle(src: SourceRef, ctx: PageCtx): string {
  return src.t === 'world' ? '本世界' : (entryOf(src, ctx)?.pack.name ?? src.key);
}

// 来源不在了（库删掉了、世界关了）：回到本世界
export const liveSource = (src: SourceRef, ctx: PageCtx): SourceRef => (src.t === 'lib' && !entryOf(src, ctx) ? WORLD_SOURCE : src);

// 只读的原因（能改时 null）
const READONLY_WHY: Record<SourceKind, string | null> = { world: null, mine: null, builtin: '内置的库只读', imported: '导入的库只读' };
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
    imported: ctx.lib.filter((e) => !e.builtin && !e.mine).map(item),
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

// ---------- 路线 ----------

// 一层页面。list 可以只看一维、一组（生态与水系、取值按维度、文化按组）；hideOn：只看还不在本世界的（工具里的“从资源库添加…”）
export type Route =
  | { p: 'home' }
  | { p: 'list'; kind: string; dim?: string; group?: string; hideOn?: boolean }
  | { p: 'item'; kind: string; id: string; seg?: string }
  | { p: 'water' }
  | { p: 'table' };

export const HOME: Route = { p: 'home' };

export const pushRoute = (stack: readonly Route[], r: Route): Route[] => [...stack, r];
// 返回：最少留着首页
export const popRoute = (stack: readonly Route[]): Route[] => (stack.length > 1 ? stack.slice(0, -1) : [HOME]);

// 换了来源、撤销了、别处删了以后，栈里哪一层还在：从第一层不在的地方截断（新建的撤销了就回到列表）
export function liveStack(stack: readonly Route[], src: SourceRef, ctx: PageCtx): Route[] {
  const out: Route[] = [];
  for (const r of stack) {
    if (r.p === 'item') {
      const kind = kindOf(r.kind);
      if (!kind || itemOf(src, kind, r.id, ctx) === undefined) break;
    } else if (r.p === 'list' && !kindOf(r.kind)) break;
    out.push(r);
  }
  return out.length ? out : [HOME];
}

export function routeLabel(r: Route, src: SourceRef, ctx: PageCtx): string {
  switch (r.p) {
    case 'home':
      return sourceTitle(src, ctx);
    case 'water':
      return '生态与水系';
    case 'table':
      return '总表';
    case 'list': {
      if (r.dim) return dimensionLabel(r.dim, src, ctx);
      const k = kindOf(r.kind);
      if (r.group) {
        const g = k && groupKind(k) ? itemOf(src, groupKind(k)!, r.group, ctx) : undefined;
        return `${g && k ? itemName(groupKind(k)!, g) : r.group}的${k?.short ?? ''}`;
      }
      return k ? kindTitle(k) : r.kind;
    }
    case 'item': {
      const k = kindOf(r.kind);
      const it = k ? itemOf(src, k, r.id, ctx) : undefined;
      return k && it !== undefined ? itemName(k, it) : r.id;
    }
  }
}

// 面包屑：每一层的名字，最后一层是现在这一页
export interface Crumb {
  label: string;
  // 点了回到第几层（现在这一层 null）
  depth: number | null;
}
export function crumbs(stack: readonly Route[], src: SourceRef, ctx: PageCtx): Crumb[] {
  return stack.map((r, k) => ({ label: routeLabel(r, src, ctx), depth: k === stack.length - 1 ? null : k }));
}
// 返回按钮上写回到哪一页（首页时没有）
export const backLabel = (stack: readonly Route[], src: SourceRef, ctx: PageCtx): string | null => (stack.length > 1 ? routeLabel(stack[stack.length - 2], src, ctx) : null);

// ---------- 首页 ----------

export const kindTitle = (k: ContentKind): string => (k.id === 'popValue' ? '取值' : k.id === 'landmarkType' ? '地标' : k.id === 'pointType' ? '自定义点' : k.id === 'riverType' ? '河' : k.id === 'lakeType' ? '湖' : k.id === 'islandType' ? '岛' : k.id === 'cityRank' ? '城市等级' : k.id === 'era' ? '时代规则' : k.label);

export interface Card {
  id: string;
  title: string;
  // 卡片上的数：“18”“7 组”
  count: string;
  empty: boolean;
  // 灰色的小字（归到它下面的：第六十轮由库的 arrange 决定）
  contains?: string;
  icon?: string;
  route: Route;
}

export interface HomeSection {
  id: string;
  title: string;
  cards: Card[];
}

export interface HomePage {
  era: { title: string; summary: string; route: Route; empty: boolean } | null;
  sections: HomeSection[];
  // 本世界还没有世界时的一句话
  noWorld: boolean;
  // 这个库新建世界时选不到：缺什么
  note: string | null;
}

// 时代规则的一句话：年份、人口密度、变量
export function eraSummary(e: Era): string {
  const parts: string[] = [];
  if (e.years) parts.push(`${e.years[0]}–${e.years[1]}`);
  parts.push(`人口密度 ${e.popDensity}`);
  const dims = e.dimensions.map((d) => d.label);
  if (dims.length) parts.push(dims.join('、'));
  return parts.join(' · ');
}

// 这一份里的维度（时代写了的，取值写到的也算）
export interface Dim {
  id: string;
  label: string;
}
export function dimensionsOf(src: SourceRef, ctx: PageCtx): Dim[] {
  const out: Dim[] = [];
  const era = kindOf('era');
  for (const e of era ? (itemsOf(src, era, ctx) as readonly Era[]) : [])
    for (const d of e.dimensions) if (!out.some((x) => x.id === d.id)) out.push({ id: d.id, label: d.label });
  const pv = kindOf('popValue');
  for (const v of pv ? (itemsOf(src, pv, ctx) as readonly { dimension: string }[]) : []) if (!out.some((x) => x.id === v.dimension)) out.push({ id: v.dimension, label: v.dimension });
  return out;
}
export const dimensionLabel = (id: string, src: SourceRef, ctx: PageCtx): string => dimensionsOf(src, ctx).find((d) => d.id === id)?.label ?? id;

function dimCards(src: SourceRef, ctx: PageCtx): Card[] {
  const groups = kindOf('valueGroup');
  const values = kindOf('popValue');
  if (!groups || !values) return [];
  const gs = itemsOf(src, groups, ctx) as readonly { dimension: string }[];
  const vs = itemsOf(src, values, ctx) as readonly { dimension: string }[];
  return dimensionsOf(src, ctx).map((d) => {
    const g = gs.filter((x) => x.dimension === d.id).length;
    const v = vs.filter((x) => x.dimension === d.id).length;
    return { id: `dim:${d.id}`, title: d.label, count: g ? `${g} 组` : String(v), empty: !g && !v, icon: 'dim', route: { p: 'list', kind: 'popValue', dim: d.id } };
  });
}

function cardOf(def: CardDef, src: SourceRef, ctx: PageCtx): Card[] {
  if (def === 'dims') return dimCards(src, ctx);
  if (def === 'variables') {
    const era = kindOf('era');
    const first = era ? (itemsOf(src, era, ctx) as readonly Era[])[0] : undefined;
    if (!first) return [];
    return [{ id: 'variables', title: '变量', count: String(first.dimensions.length), empty: false, icon: 'variables', route: { p: 'item', kind: 'era', id: first.id, seg: 'dims' } }];
  }
  if (def === 'water') {
    const counts = WATER_KINDS.map((id) => {
      const k = kindOf(id);
      return k ? itemsOf(src, k, ctx).length : 0;
    });
    return [{ id: 'water', title: '生态与水系', count: `${counts[0]} · ${counts[1] + counts[2]}`, empty: counts.every((n) => !n), icon: 'water', route: { p: 'water' } }];
  }
  const k = kindOf(def);
  if (!k) return [];
  const n = itemsOf(src, k, ctx).length;
  return [{ id: k.id, title: kindTitle(k), count: String(n), empty: !n, icon: CARD_ICON[k.id], route: { p: 'list', kind: k.id } }];
}

// 每种内容一张卡片。inside：归到别的卡片下面的（卡片 → 上级；第六十轮由库的 arrange 决定，这一轮都是空的）
export function homePage(src: SourceRef, ctx: PageCtx, inside: Inside = DEFAULT_INSIDE): HomePage {
  const noWorld = src.t === 'world' && !ctx.world;
  const all = HOME_LAYOUT.map((s) => ({ id: s.id, title: s.title, cards: s.cards.flatMap((d) => cardOf(d, src, ctx)) }));
  const contains = new Map<string, string[]>();
  const byId = new Map(all.flatMap((s) => s.cards.map((c) => [c.id, c] as const)));
  for (const [child, parent] of Object.entries(inside)) {
    const c = byId.get(child);
    if (c && parent && byId.has(parent)) contains.set(parent, [...(contains.get(parent) ?? []), c.title]);
  }
  const sections = all
    .map((s) => ({ ...s, cards: s.cards.filter((c) => !(inside[c.id] && byId.has(inside[c.id]!))).map((c) => (contains.has(c.id) ? { ...c, contains: `含${contains.get(c.id)!.join('、')}` } : c)) }))
    .filter((s) => s.cards.length);
  const eraKind = kindOf('era');
  const eras = eraKind && !noWorld ? (itemsOf(src, eraKind, ctx) as readonly Era[]) : [];
  const era = noWorld
    ? null
    : {
        title: kindTitle(eraKind!),
        summary: eras.length === 1 ? eraSummary(eras[0]) : eras.length ? `${eras.length} 个时代` : src.t === 'world' ? '还没有生成人文' : '没有',
        empty: !eras.length,
        route: (eras.length === 1 ? { p: 'item', kind: 'era', id: eras[0].id } : { p: 'list', kind: 'era' }) as Route,
      };
  const e = entryOf(src, ctx);
  const note = e && !eras.length ? '没有时代规则，新建世界时选不到这个库' : null;
  return { era, sections: noWorld ? [] : sections, noWorld, note };
}

// 生态与水系这一层：生态、河、湖、总表
export interface WaterHub {
  cards: Card[];
}
export function waterHub(src: SourceRef, ctx: PageCtx): WaterHub {
  const cards = WATER_KINDS.flatMap((id) => cardOf(id, src, ctx));
  const lists = waterLists(src, ctx);
  cards.push({ id: 'table', title: '总表', count: `${lists.species.length} × ${lists.riverTypes.length + lists.lakeTypes.length + 2}`, empty: !lists.species.length, icon: 'table', route: { p: 'table' } });
  return { cards };
}

// ---------- 列表 ----------

export interface ListRow {
  key: string;
  kind: ContentKind;
  id: string;
  name: string;
  // 灰色的说明：组里有几个文化、政体有几个派系……
  hint?: string;
  item: unknown;
  row: RepoRow;
}

export interface ListSection {
  // 没有标题的一段是 null；link：标题点了去这一组自己的页面
  label: string | null;
  link?: Route;
  rows: ListRow[];
}

export interface ListPage {
  title: string;
  kind: ContentKind;
  sections: ListSection[];
  total: number;
  readonly: string | null;
  // 能新建
  canNew: boolean;
  // 能拖动换先后（我的库、没有筛选时）
  canMove: boolean;
  // 灰色的一句：这一种是干什么的、在本世界里什么时候生效
  note: string | null;
  empty: string;
  // 新建时默认填的：只看一维、一组时
  defaults: Record<string, unknown>;
  // 也能在这一页新建取值组（取值的页面）
  alsoNew?: string;
}

// 列表的来源：repo.ts 的树（行里有状态、添加和移出的命令），同一项只列一次。按世界、库记着，点进点出不重算
const rowsMemo = new WeakMap<object, Map<string, RepoRow[]>>();
const NO_WORLD = {};
export function rowsOf(src: SourceRef, kind: ContentKind, ctx: PageCtx): RepoRow[] {
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
  const tree = packTree(ctx.world, e ? [e] : [], kind.id);
  const nodes: TreeNode[] = src.t === 'world' ? tree.world : tree.library;
  const seen = new Set<string>();
  rows = nodes.flatMap(treeRows).filter((r) => !seen.has(r.id) && !!seen.add(r.id));
  // 按这一份里的先后（树是按小包走的，世界里的顺序是 inWorld 的）
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

const countBy = (items: readonly unknown[], key: string): Map<string, number> => {
  const m = new Map<string, number>();
  for (const x of items) {
    const v = (x as Record<string, unknown>)[key];
    if (typeof v === 'string') m.set(v, (m.get(v) ?? 0) + 1);
  }
  return m;
};

// 文化、取值的上级（分段、点过去）
export const groupKind = (k: ContentKind): ContentKind | undefined => (k.id === 'culture' ? kindOf('cultureGroup') : k.id === 'popValue' ? kindOf('valueGroup') : undefined);

function hintFor(k: ContentKind, src: SourceRef, ctx: PageCtx): (r: RepoRow) => string | undefined {
  if (k.id === 'cultureGroup') {
    const cul = kindOf('culture');
    const n = countBy(cul ? itemsOf(src, cul, ctx) : [], 'group');
    return (r) => `${n.get(r.id) ?? 0} 个文化`;
  }
  if (k.id === 'government') return (r) => {
    const f = (r.item as { factions?: readonly string[] }).factions;
    return f?.length ? `${f.length} 个派系` : undefined;
  };
  if (k.id === 'riverType' || k.id === 'lakeType') return (r) => {
    const t = r.item as WaterType;
    return t.natural === false ? '不自然生成' : t.scripts?.match ? '规则' : undefined;
  };
  return () => undefined;
}

const listRow = (r: RepoRow, hint?: string): ListRow => ({ key: r.key, kind: r.kind, id: r.id, name: r.name, ...(hint ? { hint } : {}), item: r.item, row: r });

// 新建要从哪个样子开始（世界里生态、河湖、岛也可以：kinds.ts 都写了 blank）
export const canNewOf = (kind: ContentKind): boolean => !!kind.blank;

export function listPage(src: SourceRef, r: Extract<Route, { p: 'list' }>, ctx: PageCtx, query = ''): ListPage | null {
  const kind = kindOf(r.kind);
  if (!kind) return null;
  const readonly = kindReadonly(src, kind, ctx);
  let rows = rowsOf(src, kind, ctx);
  if (r.dim) rows = rows.filter((x) => (x.item as { dimension?: string }).dimension === r.dim);
  if (r.group) rows = rows.filter((x) => (x.item as { group?: string }).group === r.group);
  if (r.hideOn) rows = rows.filter((x) => !x.status.on);
  const q = query.trim().toLowerCase();
  if (q) rows = rows.filter((x) => x.name.toLowerCase().includes(q) || x.id.toLowerCase().includes(q));
  const hint = hintFor(kind, src, ctx);
  const sections = sectionsOf(kind, rows, src, ctx, r, hint);
  const empty = q ? '没有找到' : r.hideOn ? '都在本世界了' : `没有${kindTitle(kind)}`;
  const defaults: Record<string, unknown> = { ...(r.dim ? { dimension: r.dim } : {}), ...(r.group ? { group: r.group } : {}) };
  return {
    title: routeLabel(r, src, ctx),
    kind,
    sections,
    total: rows.length,
    readonly,
    canNew: !readonly && canNewOf(kind),
    canMove: sourceKind(src, ctx) === 'mine' && !q && !r.hideOn,
    note: listNote(kind, src, ctx),
    empty,
    defaults,
    ...(r.dim && !readonly ? { alsoNew: 'valueGroup' } : {}),
  };
}

function sectionsOf(kind: ContentKind, rows: readonly RepoRow[], src: SourceRef, ctx: PageCtx, r: Extract<Route, { p: 'list' }>, hint: (r: RepoRow) => string | undefined): ListSection[] {
  const up = groupKind(kind);
  // 文化按文化组、取值按取值组分段，段的标题点了去那一组的页面
  if (up && !r.group) {
    const names = new Map(itemsOf(src, up, ctx).map((g) => [itemId(up, g), itemName(up, g)]));
    const by = new Map<string, RepoRow[]>();
    for (const x of rows) {
      const g = String((x.item as { group?: unknown }).group ?? '');
      if (!by.has(g)) by.set(g, []);
      by.get(g)!.push(x);
    }
    // 取值的页面把没有取值的组也列着（才看得到、点得进去）
    if (kind.id === 'popValue' && r.dim) for (const g of itemsOf(src, up, ctx) as readonly { id: string; dimension: string }[]) if (g.dimension === r.dim && !by.has(g.id)) by.set(g.id, []);
    return [...by.entries()].map(([g, list]) => ({ label: names.get(g) ?? (g || '没有分组'), ...(names.has(g) ? { link: { p: 'item', kind: up.id, id: g } as Route } : {}), rows: list.map((x) => listRow(x, hint(x))) }));
  }
  // 文化组：比重是 0 的（这个库默认不带）放后面一段
  if (kind.id === 'cultureGroup' && src.t === 'lib') {
    const on = rows.filter((x) => (x.item as { weight?: number }).weight !== 0);
    const off = rows.filter((x) => (x.item as { weight?: number }).weight === 0);
    if (off.length) return [{ label: on.length ? '这个库默认带的' : null, rows: on.map((x) => listRow(x, hint(x))) }, { label: '这个库默认不带的', rows: off.map((x) => listRow(x, hint(x))) }].filter((s) => s.rows.length);
  }
  return rows.length ? [{ label: null, rows: rows.map((x) => listRow(x, hint(x))) }] : [];
}

// 灰色的一句
export function listNote(kind: ContentKind, src: SourceRef, ctx: PageCtx): string | null {
  if (src.t === 'world' && !canApply(kind)) return kind.pack.note ?? null;
  return (src.t === 'world' && regenNote(kind, ctx.world)) || null;
}

// 改了内容后要重新生成才用到（重新生成的按钮在第六十二轮）
export function regenNote(kind: ContentKind, world: PackWorld | null): string | null {
  if (!world) return null;
  if (HUMAN_KINDS.has(kind.id) && world.small.human) return '改了之后重新生成才用到';
  if (GOV_KINDS.has(kind.id) && world.small.human?.countryRules) return '改了之后重新生成才用到';
  if (SETTLE_KINDS.has(kind.id) && world.small.settlementRules) return '改了之后重新生成才放到地图上';
  return null;
}

// ---------- 一项的页面 ----------

export type { Segment } from './page-segments';

export interface RelatedLink {
  label: string;
  count: number;
  route: Route;
}

export interface ItemPage {
  kind: ContentKind;
  id: string;
  name: string;
  item: unknown;
  readonly: string | null;
  // 只读时能不能复制成我的库
  canCopyLibrary: boolean;
  segments: Segment[];
  // 这一项下面的（文化组的文化、取值组的取值）
  related: RelatedLink[];
  note: string | null;
}

export function itemPage(src: SourceRef, r: Extract<Route, { p: 'item' }>, ctx: PageCtx): ItemPage | null {
  const kind = kindOf(r.kind);
  if (!kind) return null;
  const item = itemOf(src, kind, r.id, ctx);
  if (item === undefined) return null;
  const readonly = kindReadonly(src, kind, ctx);
  const k = sourceKind(src, ctx);
  return {
    kind,
    id: r.id,
    name: itemName(kind, item),
    item,
    readonly,
    canCopyLibrary: k === 'builtin' || k === 'imported',
    segments: segmentsOf(kind),
    related: relatedOf(kind, r.id, src, ctx),
    note: src.t === 'world' ? regenNote(kind, ctx.world) : null,
  };
}

function relatedOf(kind: ContentKind, id: string, src: SourceRef, ctx: PageCtx): RelatedLink[] {
  const link = (child: string, label: string): RelatedLink[] => {
    const c = kindOf(child);
    if (!c) return [];
    const n = (itemsOf(src, c, ctx) as readonly { group?: string }[]).filter((x) => x.group === id).length;
    return [{ label, count: n, route: { p: 'list', kind: child, group: id } }];
  };
  if (kind.id === 'cultureGroup') return link('culture', '组里的文化');
  if (kind.id === 'valueGroup') return link('popValue', '组里的取值');
  return [];
}

// 这一项能做什么（组件照这个画按钮，点了走 page-actions.ts）。why：不能做的原因（写在悬停里）
export type ItemActionId = 'copyLibrary' | 'addToWorld' | 'removeFromWorld' | 'deleteItem' | 'restore' | 'setDefault' | 'locate' | 'dedicated' | 'saveToMine' | 'exportItem' | 'copyItem';
export interface ItemAction {
  id: ItemActionId;
  disabled?: string;
}

// row：这一项在这一份里的状态
export function itemActions(src: SourceRef, row: RepoRow | undefined, ctx: PageCtx, can: { remove: boolean; usage: string | null; restore: boolean; setDefault: boolean; hasCells: boolean; saveable: boolean; dedicated: boolean; newable: boolean }): ItemAction[] {
  const out: ItemAction[] = [];
  const k = sourceKind(src, ctx);
  if (!row) return out;
  if (k === 'builtin' || k === 'imported') out.push({ id: 'copyLibrary' });
  if (src.t === 'lib' && ctx.world) out.push(row.status.on ? { id: 'addToWorld', disabled: '已在本世界' } : row.status.locked ? { id: 'addToWorld', disabled: row.status.locked } : { id: 'addToWorld' });
  if (can.setDefault) out.push({ id: 'setDefault' });
  if (can.hasCells) out.push({ id: 'locate' });
  if (src.t === 'world') {
    if (can.restore) out.push({ id: 'restore' });
    if (can.dedicated) out.push({ id: 'dedicated' });
    if (can.saveable) out.push({ id: 'saveToMine' });
    if (!row.status.locked) out.push(can.remove ? { id: 'removeFromWorld' } : { id: 'removeFromWorld', disabled: can.usage ?? '不能移出' });
  }
  out.push({ id: 'exportItem' });
  if (k === 'mine') out.push({ id: 'copyItem' }, { id: 'deleteItem' });
  if (k === 'world' && can.newable && !row.status.locked) out.push({ id: 'copyItem' });
  return out;
}

// ---------- 引用点过去 ----------

// 一个引用点过去到哪一页（这一份里没有它、不是一项内容时 null）。ref 是字段表写的 ref / keyRef
export function refRoute(ref: string | readonly string[], id: string, src: SourceRef, ctx: PageCtx): Route | null {
  if (typeof ref !== 'string') {
    for (const r of ref) {
      const hit = refRoute(r, id, src, ctx);
      if (hit) return hit;
    }
    return null;
  }
  if (!id) return null;
  if (ref === 'dimension') {
    const era = kindOf('era');
    const owner = era ? (itemsOf(src, era, ctx) as readonly Era[]).find((e) => e.dimensions.some((d) => d.id === id)) : undefined;
    return owner ? { p: 'item', kind: 'era', id: owner.id, seg: 'dims' } : null;
  }
  if (ref === 'tolerance') {
    const k = id.indexOf(':');
    if (k < 0) return null;
    const prefix = id.slice(0, k);
    const kindId = prefix === 'river' ? 'riverType' : prefix === 'lake' ? 'lakeType' : null;
    return kindId ? refRoute(kindId, id.slice(k + 1), src, ctx) : null;
  }
  const kind = kindOf(ref);
  if (!kind) return null;
  return itemOf(src, kind, id, ctx) === undefined ? null : { p: 'item', kind: ref, id };
}

// ---------- 总表 ----------

// 总表的数据（世界里是 small，库里是这个库的）。生态、河、湖都从这一份来：改一格和生态页、河湖页走同一个函数（core/water-table.ts）
export interface WaterLists {
  species: readonly Species[];
  riverTypes: readonly WaterType[];
  lakeTypes: readonly WaterType[];
}
export function waterLists(src: SourceRef, ctx: PageCtx): WaterLists {
  const of = <T,>(id: string) => {
    const k = kindOf(id);
    return (k ? itemsOf(src, k, ctx) : []) as readonly T[];
  };
  return { species: of<Species>('biome'), riverTypes: of<WaterType>('riverType'), lakeTypes: of<WaterType>('lakeType') };
}

export interface TableRow {
  kind: WaterKind;
  // 'plain' 是普通河、普通湖
  id: string;
  name: string;
  type: WaterType | null;
  // 写了规则（脚本）：规则说是的河湖里才看这张表
  script: boolean;
  // 不自然生成：勾了也不会自己出现（只影响画的、选了它的）
  manual: boolean;
  cells: boolean[];
  route: Route | null;
}
export interface WaterTable {
  biomes: { id: string; name: string; color: string; route: Route }[];
  rows: TableRow[];
  // 河湖的分界（第几行开始是湖）
  lakesFrom: number;
  anyScript: boolean;
}

export function waterTable(src: SourceRef, ctx: PageCtx): WaterTable {
  const lists = waterLists(src, ctx);
  const row = (kind: WaterKind, t: WaterType | null, plainName: string): TableRow => {
    const id = t ? t.id : PLAIN_TYPE;
    return {
      kind,
      id,
      name: t ? t.name || t.id : plainName,
      type: t,
      script: !!t?.scripts?.match?.src,
      manual: t?.natural === false,
      cells: lists.species.map((sp) => waterAllowed(lists, sp, kind, id)),
      route: t ? { p: 'item', kind: kind === 'river' ? 'riverType' : 'lakeType', id: t.id } : null,
    };
  };
  const rivers = [row('river', null, '普通河'), ...lists.riverTypes.map((t) => row('river', t, ''))];
  const lakes = [row('lake', null, '普通湖'), ...lists.lakeTypes.map((t) => row('lake', t, ''))];
  const rows = [...rivers, ...lakes];
  return {
    biomes: lists.species.map((s) => ({ id: s.id, name: s.name || s.id, color: s.color, route: { p: 'item', kind: 'biome', id: s.id } })),
    rows,
    lakesFrom: rivers.length,
    anyScript: rows.some((r) => r.script),
  };
}

// 河湖页上一句话：现在这种水按什么出现在地图上。写在脚本里的（奇幻的六种河）：表上每一格都勾着，取消一格之后是“规则说是的里面按每格看”
export function waterRuleNote(kind: WaterKind, t: WaterType): string {
  const noun = kind === 'river' ? '河' : '湖';
  if (t.natural === false) return `只用在${kind === 'river' ? '画的河和选了它的河' : '放的湖和选了它的湖'}上`;
  const script = !!t.scripts?.match?.src;
  if (!script && !perCellRule(t)) return '没有条件：选生态、写条件或规则';
  if (!script) return `符合条件的${kind === 'river' ? '河段' : '湖'}是这一种`;
  return perCellRule(t) ? `规则说是的${noun}里，符合条件的是这一种` : `规则说是的${noun}是这一种；取消一格后，规则说是的${noun}里按这里的勾看`;
}

// ---------- 打开：别处点进来 ----------

// 工具里的“从资源库添加…”、缺内容的提示、“城市 ⋯”：打开哪一份的哪一页。
// 在世界里看的（没写 off）开本世界；“从资源库添加”开世界用的库（没有时默认的库），只列还不在本世界的
export interface OpenRequest {
  kind?: string;
  // 只看不在本世界的
  off?: boolean;
  // 资源库里的键
  entry?: string;
}
export function openTarget(req: OpenRequest, ctx: PageCtx, worldLib: string | undefined, fallback: string): { source: SourceRef; stack: Route[] } {
  const source: SourceRef = req.entry && ctx.lib.some((e) => e.key === req.entry) ? { t: 'lib', key: req.entry } : req.off ? { t: 'lib', key: worldLib && ctx.lib.some((e) => e.key === worldLib) ? worldLib : fallback } : WORLD_SOURCE;
  const stack: Route[] = [HOME];
  if (req.kind && kindOf(req.kind)) stack.push({ p: 'list', kind: req.kind, ...(req.off && source.t === 'lib' ? { hideOn: true } : {}) });
  return { source, stack };
}

// ---------- ⌘Z 撤销哪一边 ----------

// 面板开着、看的是我的库、最后点的是面板里：撤销这个库；别的都是世界。内置的库上点了面板不撤销世界，免得看不见的东西变了
export type UndoTarget = 'world' | 'library' | 'none';
export function undoTarget(src: SourceRef | null, ctx: PageCtx, inPanel: boolean): UndoTarget {
  if (!src || !inPanel || src.t === 'world') return 'world';
  return sourceKind(src, ctx) === 'mine' ? 'library' : 'none';
}

// ---------- 覆盖 ----------

// 首页到得了的种类（测试：每种列出来的内容都有卡片）
export function reachableKinds(): string[] {
  const out = new Set<string>();
  for (const s of HOME_LAYOUT) for (const d of s.cards) if (d !== 'water' && d !== 'dims' && d !== 'variables') out.add(d);
  for (const id of WATER_KINDS) out.add(id);
  out.add('era');
  out.add('popValue');
  out.add('valueGroup');
  return [...out];
}
export const listedKinds = (): string[] => packSections().map((k) => k.id);

// 新的一项的 id 不撞这一份里的
export function takenIn(src: SourceRef, kind: ContentKind, ctx: PageCtx): Set<string> {
  const out = new Set(itemsOf(src, kind, ctx).map((x) => itemId(kind, x)));
  for (const r of rowsOf(src, kind, ctx)) out.add(r.id);
  return out;
}

