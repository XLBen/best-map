import { RELATIONS, looseItems, relationOf } from '../../../core/content/arrange';
import { type ContentKind, itemId, itemName, kindOf } from '../../../core/content/registry';
import type { Era } from '../../../core/human';
import { canApply, packSections } from '../../../core/packs';
import type { Species } from '../../../core/species';
import { PLAIN_TYPE, type WaterType, perCellRule } from '../../../core/water-types';
import { type WaterKind, waterAllowed } from '../../../core/water-table';
import { arrangeFor, arrangeTitle, linkView, mergedInto } from './page-arrange';
import { type ChildSection, type InsideRow, childSections, insideRows } from './page-children';
import { CARD_ICON, type CardDef, HOME_LAYOUT, WATER_KINDS, type Inside } from './page-layout';
import { type RowMark, type SourceDiff, type WorldMark, rowMarks, worldDiff } from './page-marks';
import { type Segment, segmentsOf } from './page-segments';
import { type PageCtx, type SourceRef, WORLD_SOURCE, entryOf, itemOf, itemsOf, kindReadonly, kindTitle, rowsOf, sourceKind, sourceTitle } from './page-source';
import { type UsedBy, usedByOf } from './page-used-by';
import type { RepoRow } from './repo';

export * from './page-source';
export type { RowMark, WorldMark };

// 新的资源库面板（第五十九轮）的逻辑：看的是哪一份（本世界、内置的库、我的库）、首页有哪些卡片、怎么点进去、面包屑、
// 列表里有什么、某一项的页面有哪些段、只读与否、这一项能做什么、返回。全部在这里，组件只负责画。不碰界面，测试直接调。
//
// 切换来源后界面完全一样：所有的页面都从 SourceRef + PageCtx 算出来，本世界和库只差 itemsOf 和只读

// ---------- 路线 ----------

// 一层页面。list 可以只看一维、一组（生态与水系、取值按维度、文化按组）；hideOn：只看还不在本世界的（工具里的“从资源库添加…”）；
// loose：只看不属于这种上级的（融入之后留着卡片的地标）
export type Route =
  | { p: 'home' }
  | { p: 'list'; kind: string; dim?: string; group?: string; hideOn?: boolean; loose?: string }
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

export interface Card {
  id: string;
  title: string;
  // 卡片上的数：“18”“7 组”
  count: string;
  empty: boolean;
  // 灰色的小字：含哪几种（第六十轮，库的 arrange 决定）
  contains?: string;
  // 同一件事，一种一项（我的库里能拖出来）
  kids?: { key: string; title: string }[];
  icon?: string;
  route: Route;
}

export interface HomeSection {
  id: string;
  title: string;
  cards: Card[];
}

export interface HomePage {
  era: { title: string; summary: string; route: Route; empty: boolean; contains?: string; kids?: { key: string; title: string }[] } | null;
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
  for (const id of ['popValue', 'valueGroup']) {
    const k = kindOf(id);
    for (const v of k ? (itemsOf(src, k, ctx) as readonly { dimension: string }[]) : []) if (!out.some((x) => x.id === v.dimension)) out.push({ id: v.dimension, label: v.dimension });
  }
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

// 每种内容一张卡片。inside：卡片 → 上级（第六十轮：这一份的 arrange）。融入的不单独列，上级写“含……”；
// 地标不属于任何组的还留一张卡片（只列那些）。取值融入取值组时，每一维的卡片就是这一维的取值组，首页不再单独列取值组。
// 上级不在这一份里（测试、写错的文件）时不藏，免得找不到
const homeOrder = (key: string) => {
  const k = RELATIONS.findIndex((r) => r.child === key);
  return k < 0 ? RELATIONS.length : k;
};
export function homePage(src: SourceRef, ctx: PageCtx, inside: Inside = arrangeFor(src, ctx)): HomePage {
  const noWorld = src.t === 'world' && !ctx.world;
  const all = HOME_LAYOUT.map((s) => ({ id: s.id, title: s.title, cards: s.cards.flatMap((d) => cardOf(d, src, ctx)) }));
  const byId = new Map(all.flatMap((s) => s.cards.map((c) => [c.id, c] as const)));
  const eraKind = kindOf('era');
  const eras = eraKind && !noWorld ? (itemsOf(src, eraKind, ctx) as readonly Era[]) : [];
  const kids = new Map<string, { key: string; title: string }[]>();
  const addKid = (card: string, key: string) => kids.set(card, [...(kids.get(card) ?? []), { key, title: arrangeTitle(key) }]);
  const hidden = new Set<string>();
  const swapped = new Map<string, Card>();
  const dimIds = [...byId.keys()].filter((id) => id.startsWith('dim:'));
  for (const [child, parent] of Object.entries(inside).sort((a, b) => homeOrder(a[0]) - homeOrder(b[0]))) {
    if (!parent) continue;
    if (child === 'variables' && parent === 'era') {
      if (eras.length) {
        hidden.add(child);
        addKid('era', child);
      }
    } else if (child === 'popValue' && parent === 'valueGroup') {
      if (dimIds.length) {
        hidden.add(parent);
        for (const id of dimIds) addKid(id, child);
      }
    } else if (byId.has(child) && byId.has(parent)) {
      addKid(parent, child);
      const rel = relationOf(child, parent);
      if (rel?.looseCard) {
        const view = linkView(src, ctx);
        const n = looseItems(rel, view.items, view.table(rel)).length;
        if (n) swapped.set(child, { ...byId.get(child)!, count: String(n), route: { p: 'list', kind: child, loose: parent } });
        else hidden.add(child);
      } else hidden.add(child);
    }
  }
  const says = (id: string) => {
    const list = kids.get(id);
    return list ? { contains: `含${list.map((k) => k.title).join('、')}`, kids: list } : {};
  };
  const sections = all
    .map((s) => ({ ...s, cards: s.cards.filter((c) => !hidden.has(c.id)).map((c) => ({ ...(swapped.get(c.id) ?? c), ...says(c.id) })) }))
    .filter((s) => s.cards.length);
  const era = noWorld
    ? null
    : {
        title: kindTitle(eraKind!),
        summary: eras.length === 1 ? eraSummary(eras[0]) : eras.length ? `${eras.length} 个时代` : src.t === 'world' ? '还没有生成人文' : '没有',
        empty: !eras.length,
        route: (eras.length === 1 ? { p: 'item', kind: 'era', id: eras[0].id } : { p: 'list', kind: 'era' }) as Route,
        ...says('era'),
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
  // 本世界里：生成后没用到（变淡）、和来源的库不同（第六十二轮）
  mark?: RowMark;
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
  // 含哪几种（融入到这种内容下面的，第六十轮）
  inside: InsideRow[];
  // 够多才有搜索框（融入的项也算）
  searchable: boolean;
}

export const SEARCH_FROM = 12;

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
  if (k.id === 'countryTier') {
    const rel = relationOf('countryLayout', 'countryTier')!;
    const t = linkView(src, ctx).table(rel);
    return (r) => `${t.byParent.get(r.id)?.length ?? 0} 个格局`;
  }
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
  if (r.loose) {
    const rel = relationOf(r.kind, r.loose);
    if (rel) {
      const view = linkView(src, ctx);
      const loose = new Set(looseItems(rel, view.items, view.table(rel)).map((x) => itemId(kind, x)));
      rows = rows.filter((x) => loose.has(x.id));
    }
  }
  const q = query.trim().toLowerCase();
  const matches = (x: RepoRow) => x.name.toLowerCase().includes(q) || x.id.toLowerCase().includes(q);
  if (q) rows = rows.filter(matches);
  const hint = hintFor(kind, src, ctx);
  const whole = !r.dim && !r.group && !r.hideOn && !r.loose;
  // 融入的项：搜索时一样找得到；不属于任何上级的在最后一段
  const sections = [...sectionsOf(kind, rows, src, ctx, r, hint), ...(whole ? (q ? insideHits(kind.id, src, ctx, matches) : looseSections(kind, src, ctx)) : [])];
  const inside = whole ? insideRows(src, kind.id, ctx) : [];
  const marks = rowMarks(src, ctx);
  if (marks) for (const sec of sections) sec.rows = sec.rows.map((x) => ({ ...x, mark: marks(x.kind, x.id, x.item) }));
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
    inside,
    searchable: rows.length + inside.reduce((n, x) => n + x.count, 0) > SEARCH_FROM,
  };
}

// 搜索时融入的项也列出来，灰字写在哪个上级下面
function insideHits(parentKind: string, src: SourceRef, ctx: PageCtx, matches: (x: RepoRow) => boolean): ListSection[] {
  const up = kindOf(parentKind);
  if (!up) return [];
  const view = linkView(src, ctx);
  const names = new Map(view.items(parentKind).map((x) => [itemId(up, x), itemName(up, x)]));
  return mergedInto(arrangeFor(src, ctx), parentKind).flatMap((rel) => {
    const ck = kindOf(rel.child);
    if (!ck) return [];
    const rows = rowsOf(src, ck, ctx).filter(matches);
    const t = view.table(rel);
    const hint = (x: RepoRow) => {
      const ps = (t.byChild.get(x.id) ?? []).flatMap((p) => (names.has(p) ? [names.get(p)!] : []));
      return ps.length ? `在${ps.slice(0, 2).join('、')}${ps.length > 2 ? ` 等 ${ps.length} 个` : ''}` : undefined;
    };
    return rows.length ? [{ label: arrangeTitle(rel.child), rows: rows.map((x) => listRow(x, hint(x))) }] : [];
  });
}

// 融入的内容里不属于任何上级的（地标有自己的卡片）
function looseSections(parent: ContentKind, src: SourceRef, ctx: PageCtx): ListSection[] {
  const view = linkView(src, ctx);
  return mergedInto(arrangeFor(src, ctx), parent.id).flatMap((rel) => {
    const ck = kindOf(rel.child);
    if (!ck || rel.looseCard) return [];
    const loose = new Set(looseItems(rel, view.items, view.table(rel)).map((x) => itemId(ck, x)));
    if (!loose.size) return [];
    return [{ label: `不属于${kindTitle(parent)}的${arrangeTitle(rel.child)}`, rows: rowsOf(src, ck, ctx).filter((x) => loose.has(x.id)).map((x) => listRow(x)) }];
  });
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
  void ctx;
  return src.t === 'world' && !canApply(kind) ? (kind.pack.note ?? null) : null;
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
  // 这一项下面的（没融入时是一行链接：文化组的文化、取值组的取值）
  related: RelatedLink[];
  // 融入到这一项下面的（第六十轮）：在这一页上直接改
  children: ChildSection[];
  // 底部的“谁用到它”：引用它的内容、融入在哪几个上级下面、地图上用到的地方（第六十二轮）
  usedBy: UsedBy;
  // 本世界里：和来源的库比
  diff: SourceDiff;
  // 来源的库叫什么
  diffLib: string | null;
}

export function itemPage(src: SourceRef, r: Extract<Route, { p: 'item' }>, ctx: PageCtx): ItemPage | null {
  const kind = kindOf(r.kind);
  if (!kind) return null;
  const item = itemOf(src, kind, r.id, ctx);
  if (item === undefined) return null;
  const readonly = kindReadonly(src, kind, ctx);
  const k = sourceKind(src, ctx);
  const diff = worldDiff(src, kind, r.id, item, ctx);
  return {
    kind,
    id: r.id,
    name: itemName(kind, item),
    item,
    readonly,
    canCopyLibrary: k === 'builtin' || k === 'imported',
    segments: segmentsHere(kind, src, ctx),
    related: relatedOf(kind, r.id, src, ctx),
    children: childSections(src, kind, item, ctx),
    usedBy: usedByOf(src, kind, r.id, item, ctx),
    diff,
    diffLib: diff.t === 'none' ? null : (ctx.lib.find((e) => e.key === diff.lib)?.pack.name ?? diff.lib),
  };
}

// 上级自己写着它的字段（政体的“有哪些派系”、文化组的“地名风格”）融入后由“下面的”这一段代替，不列两遍；空了的段不要
function segmentsHere(kind: ContentKind, src: SourceRef, ctx: PageCtx): Segment[] {
  const segs = segmentsOf(kind);
  const gone = mergedInto(arrangeFor(src, ctx), kind.id).flatMap((r) => r.parentField ?? []);
  if (!gone.length) return segs;
  return segs.map((s) => ({ ...s, fields: s.fields.filter((f) => !gone.includes(f.key)) })).filter((s) => s.fields.length || s.custom);
}

function relatedOf(kind: ContentKind, id: string, src: SourceRef, ctx: PageCtx): RelatedLink[] {
  const link = (child: string, label: string): RelatedLink[] => {
    const c = kindOf(child);
    if (!c || arrangeFor(src, ctx)[child] === kind.id) return [];
    const n = (itemsOf(src, c, ctx) as readonly { group?: string }[]).filter((x) => x.group === id).length;
    return [{ label, count: n, route: { p: 'list', kind: child, group: id } }];
  };
  if (kind.id === 'cultureGroup') return link('culture', '组里的文化');
  if (kind.id === 'valueGroup') return link('popValue', '组里的取值');
  return [];
}

// 时代规则的变量：每一维有几个取值，点过去（世界里不直接改这张表，见 PageChildren.tsx 的 WorldVariables）
export function eraVariables(src: SourceRef, era: Era, ctx: PageCtx): { id: string; label: string; count: number; route: Route }[] {
  const pv = kindOf('popValue');
  const n = countBy(pv ? itemsOf(src, pv, ctx) : [], 'dimension');
  return era.dimensions.map((d) => ({ id: d.id, label: d.label, count: n.get(d.id) ?? 0, route: { p: 'list', kind: 'popValue', dim: d.id } }));
}

// 这一项能做什么（组件照这个画按钮，点了走 page-actions.ts）。why：不能做的原因（写在悬停里）
export type ItemActionId = 'copyLibrary' | 'addToWorld' | 'removeFromWorld' | 'deleteItem' | 'useSource' | 'saveBack' | 'setDefault' | 'locate' | 'dedicated' | 'saveToMine' | 'exportItem' | 'copyItem';
export interface ItemAction {
  id: ItemActionId;
  disabled?: string;
}

// row：这一项在这一份里的状态
export function itemActions(src: SourceRef, row: RepoRow | undefined, ctx: PageCtx, can: { remove: boolean; usage: string | null; changed: boolean; setDefault: boolean; hasCells: boolean; saveable: boolean; dedicated: boolean; newable: boolean }): ItemAction[] {
  const out: ItemAction[] = [];
  const k = sourceKind(src, ctx);
  if (!row) return out;
  if (k === 'builtin' || k === 'imported') out.push({ id: 'copyLibrary' });
  if (src.t === 'lib' && ctx.world) out.push(row.status.on ? { id: 'addToWorld', disabled: '已在本世界' } : row.status.locked ? { id: 'addToWorld', disabled: row.status.locked } : { id: 'addToWorld' });
  if (can.setDefault) out.push({ id: 'setDefault' });
  if (can.hasCells) out.push({ id: 'locate' });
  if (src.t === 'world') {
    // 和来源的库不同：换成库里的，或者存回库里（第六十二轮）
    if (can.changed) out.push({ id: 'useSource' }, { id: 'saveBack' });
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

