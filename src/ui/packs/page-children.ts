import { type ArrangeRelation, childrenOf, parentsOf } from '../../../core/content/arrange';
import { type ContentKind, itemId, itemName, kindOf } from '../../../core/content/registry';
import { arrangeFor, arrangeTitle, canArrange, linkView, mergedInto, mergedRelation } from './page-arrange';
import { type PageCtx, type SourceRef, itemsOf, kindReadonly, kindTitle } from './page-source';
import { type RowMark, rowMarks } from './page-marks';
import type { RefOption } from './refs';

// 上级页面上“下面的”几段（第六十轮）：融入到这一项下面的内容，能点开改、能加、能移出。谁属于谁还是内容自己写的（core/content/arrange.ts），
// 这里算出每一行能做什么，组件只画。上级自己写着它的（政体的 factions、文化组的 nameStyle）这一段代替那个字段

type Obj = Record<string, unknown>;

export interface ChildRow {
  key: string;
  id: string;
  name: string;
  // 灰色的说明
  hint?: string;
  item: Obj;
  // ok：能移出；move：只能换上级（文化必须有组）；null：不能（why 写原因）
  out: 'ok' | 'move' | null;
  why?: string;
  // 本世界里：生成后没用到（变淡）、和来源的库不同（第六十二轮）
  mark?: RowMark;
}

export interface ChildSection {
  key: string;
  title: string;
  relation: ArrangeRelation;
  kind: ContentKind;
  rows: ChildRow[];
  // 看的这一份里这种内容不能改（内置的库）
  readonly: string | null;
  // 还能加进来的（同一份里、不在这里的）
  options: RefOption[];
  canLink: boolean;
  canNew: boolean;
  // 加的按钮写什么（组只有一个默认的地名风格，所以是“换”）
  addLabel: string;
  // 能拖出去、能拆出来（只有我的库）
  canSplit: boolean;
  note?: string;
}

const noteOf = (r: ArrangeRelation): string | undefined => (!r.link ? '在这一项自己的页面上改' : undefined);

function rowHint(rel: ArrangeRelation, parent: Obj, child: Obj, src: SourceRef, ctx: PageCtx): string | undefined {
  const others = (linkView(src, ctx).table(rel).byChild.get(String(child.id))?.length ?? 1) - 1;
  if (rel.child === 'nameStyle') {
    if (parent.nameStyle === child.id) return '组的默认';
    const cul = kindOf('culture');
    const n = cul ? (itemsOf(src, cul, ctx) as readonly Obj[]).filter((c) => c.group === parent.id && c.nameStyle === child.id).length : 0;
    return `${n} 个文化写着`;
  }
  if (rel.child === 'countryLayout') return `占 ${String((child.weights as Record<string, number>)[String(parent.id)])}`;
  if (rel.child === 'landmarkType' && others > 0) return `还在另外 ${others} ${rel.parent === 'government' ? '个政体' : '组'}`;
  return undefined;
}

function rowOut(rel: ArrangeRelation, parent: Obj, child: Obj): Pick<ChildRow, 'out' | 'why'> {
  if (rel.moveOnly) return { out: 'move', why: `换一${rel.parent === 'cultureGroup' ? '个组' : '个'}` };
  if (!rel.unlink) return { out: null, why: noteOf(rel) };
  if (rel.unlink(parent, child)) return { out: 'ok', why: rel.unlinkNote };
  return { out: null, why: rel.child === 'nameStyle' ? '是文化写的，在文化里改' : '不能移出' };
}

// kind：上级的种类，parent：上级这一项。变量没有这一段（时代规则的“变量”就是它）
export function childSections(src: SourceRef, kind: ContentKind, parent: unknown, ctx: PageCtx): ChildSection[] {
  const arrange = arrangeFor(src, ctx);
  if (!mergedInto(arrange, kind.id).length) return [];
  const view = linkView(src, ctx);
  const p = parent as Obj;
  const out: ChildSection[] = [];
  const marks = rowMarks(src, ctx);
  for (const { relation: rel, items } of childrenOf(arrange, kind.id, parent, view.items, view.table)) {
    const ck = kindOf(rel.child);
    if (!ck) continue;
    const readonly = kindReadonly(src, ck, ctx);
    const rows = (items as Obj[]).map(
      (x): ChildRow => ({
        key: `${ck.id}:${itemId(ck, x)}`,
        id: itemId(ck, x),
        name: itemName(ck, x),
        ...(rowHint(rel, p, x, src, ctx) ? { hint: rowHint(rel, p, x, src, ctx) } : {}),
        item: x,
        ...rowOut(rel, p, x),
        ...(marks ? { mark: marks(ck, itemId(ck, x), x) } : {}),
      }),
    );
    const here = new Set(rows.map((r) => r.id));
    const options: RefOption[] = rel.link
      ? (view.items(rel.child) as Obj[])
          .filter((x) => !here.has(itemId(ck, x)) && (rel.fits?.(p, x) ?? true))
          .map((x) => ({ id: itemId(ck, x), label: itemName(ck, x), ...(typeof x.color === 'string' ? { color: x.color } : {}) }))
      : [];
    const title = kindTitle(ck);
    const single = rel.child === 'nameStyle' && p.nameStyle !== undefined;
    out.push({
      key: rel.child,
      title,
      relation: rel,
      kind: ck,
      rows,
      readonly,
      options,
      canLink: !readonly && !!rel.link,
      canNew: !readonly && !!rel.link && !!ck.blank,
      addLabel: `${single ? '换' : '加'}${title}`,
      canSplit: canArrange(src, ctx),
      ...(noteOf(rel) ? { note: noteOf(rel) } : {}),
    });
  }
  return out;
}

// 一段先画多少行、够多才有搜索框（内置的库一组最多二十来个；自己的库一组可以有上千个，一下全画要两百多毫秒）
export const CHILD_SHOW = 60;
export const CHILD_SEARCH_FROM = 12;
export function shownRows(rows: readonly ChildRow[], query: string, limit: number): { rows: readonly ChildRow[]; more: number } {
  const q = query.trim().toLowerCase();
  const hits = q ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q)) : rows;
  return { rows: hits.length > limit ? hits.slice(0, limit) : hits, more: Math.max(0, hits.length - limit) };
}

// 这一项在哪几个上级下面（页面上写一句“在 X、Y”，能点过去）
export interface PartOf {
  kind: string;
  id: string;
  name: string;
}
export function partOf(src: SourceRef, kind: ContentKind, item: unknown, ctx: PageCtx): PartOf[] {
  const rel = mergedRelation(arrangeFor(src, ctx), kind.id);
  const up = rel && kindOf(rel.parent);
  if (!rel || !up) return [];
  const view = linkView(src, ctx);
  return parentsOf(rel, item, view.items, view.table(rel)).map((x) => ({ kind: up.id, id: itemId(up, x), name: itemName(up, x) }));
}

// 上级的列表最上面列着含哪几种：点进去是这种内容的全部（包括不属于任何上级的），也是拖出来、拆出来的地方
export interface InsideRow {
  key: string;
  title: string;
  count: number;
  route: { p: 'list'; kind: string };
  canSplit: boolean;
}
export function insideRows(src: SourceRef, kindId: string, ctx: PageCtx): InsideRow[] {
  const arrange = arrangeFor(src, ctx);
  const can = canArrange(src, ctx);
  return mergedInto(arrange, kindId).flatMap((r) => {
    const ck = kindOf(r.child);
    return ck ? [{ key: r.child, title: arrangeTitle(r.child), count: itemsOf(src, ck, ctx).length, route: { p: 'list' as const, kind: r.child }, canSplit: can }] : [];
  });
}
