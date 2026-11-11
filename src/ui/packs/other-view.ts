import type { ArrangeRelation } from '../../../core/content/arrange';
import type { ContentRef } from '../../../core/content/links';
import { itemId, kindOf } from '../../../core/content/registry';
import { packItems } from '../../../core/packs';
import { type ImportGate, type ImportOnto, importGates, importPreview } from '../../../core/packs/closure';
import { type PageCtx, type SourceRef, entryOf, itemsOf, listPage } from './pages';
import { defaultFrom } from './pick-other';
import type { RowLook } from './pick-look';
import { destTarget, picksOf } from './pick-store';
import { type PickView, kindPickable, lookOf, pickView } from './pick-view';

// 从别的库加（第六十八轮）：列表、上级页面上的按钮在资源库面板右栏打开一个能多选的窗口（LibOther.tsx）。
//   来自    别的库（不含目的地自己；读进来的文件也列），每个写“可加 N”“已勾 M”
//   列表    那个库里这一种的全部项，按那个库自己列表的分段（pages.ts 的 listPage）；每行的状态用 pick-look.ts 的 rowLook（pick-view.ts 的 lookOf），
//           已有的写“本世界已有”，灰的列出来写原因；上级页面打开的，放不到这个上级下面的灰着写“放不到“X”下面”
//   勾选    照旧按库记（pick-store.ts），换“来自”的库勾的还在；添加只加当前这个库的（LibBasket.tsx）。上级页面打开的，勾的这一种都放到上级下面（同一个 batch）
// 都是算出来的，组件只画

// 上级页面打开的：放到哪个上级下面
export interface OntoParent {
  relation: ArrangeRelation;
  parent: string;
  // 上级的名字（标题、灰字写它）
  title: string;
}

// 右栏开着的“从别的库加”：哪一种（变量的取值页上是这个变量的取值）
export interface OtherOpen {
  kind: string;
  dim?: string;
  // 这一种在左栏叫什么（“宗教”“派系”）
  label: string;
  onto?: OntoParent;
}

const sameOnto = (a?: OntoParent, b?: OntoParent): boolean => (!a && !b) || (!!a && !!b && a.parent === b.parent && a.relation.parent === b.relation.parent && a.relation.child === b.relation.child);
export const sameOther = (a: OtherOpen | null | undefined, b: OtherOpen): boolean => !!a && a.kind === b.kind && a.dim === b.dim && sameOnto(a.onto, b.onto);

// ---------- 来自哪个库 ----------

export interface OtherLib {
  key: string;
  name: string;
  // 这一种里有几项、能加几项（没有、不灰）
  total: number;
  can: number;
  // 这个库勾了几项（全部种类：添加时一起加）
  picked: number;
}

const canTake = (g: ImportGate): boolean => g.t === 'free' || g.t === 'fixable';

// 这个库里这一种的项（变量的取值页上只算这个变量的）
function kindItems(pack: Parameters<typeof packItems>[0], o: Pick<OtherOpen, 'kind' | 'dim'>): unknown[] {
  const k = kindOf(o.kind);
  if (!k) return [];
  const all = packItems(pack, k.pack.key);
  return o.dim ? all.filter((x) => (x as { dimension?: string }).dimension === o.dim) : all;
}

const destOf = (target: SourceRef) => (target.t === 'world' ? ('world' as const) : { lib: target.key });

// 别的库：目的地自己不列，这一种一项都没有的不列（勾了东西的照列：添加时要看到）
export function otherLibs(o: Pick<OtherOpen, 'kind' | 'dim'>, target: SourceRef, ctx: PageCtx): OtherLib[] {
  const k = kindOf(o.kind);
  const to = destTarget(destOf(target), ctx);
  if (!k || !to) return [];
  const out: OtherLib[] = [];
  for (const e of ctx.lib) {
    if (target.t === 'lib' && e.key === target.key) continue;
    const items = kindItems(e.pack, o);
    const picked = picksOf(e.key).picks.length;
    if (!items.length && !picked) continue;
    const gates = importGates(e.pack, to);
    const can = items.filter((x) => canTake(gates.of({ kind: o.kind, id: itemId(k, x) }))).length;
    out.push({ key: e.key, name: e.file ? `文件：${e.pack.name || e.file}` : e.pack.name, total: items.length, can, picked });
  }
  return out;
}

// 打开时看哪个库：上次用的（pick-other.ts 的 defaultFrom）；它没有这种内容时第一个有的
export function pickFrom(libs: readonly OtherLib[], target: SourceRef, ctx: PageCtx): string | null {
  const d = defaultFrom(target, ctx);
  const has = libs.filter((l) => l.total > 0);
  return (has.find((l) => l.key === d) ?? has[0] ?? libs[0])?.key ?? null;
}

// ---------- 列表 ----------

export interface OtherRow {
  key: string;
  ref: ContentRef;
  name: string;
  color?: string;
  // 灰色的说明：组里有几个文化、政体有几个派系（同左栏的列表）
  hint?: string;
  item: unknown;
  // 勾的样子；不能勾（没有地方加）时 null
  look: RowLook | null;
}

export interface OtherSection {
  label: string | null;
  rows: OtherRow[];
}

// 上级：在目的地里（上级页面就是这一份的）
function parentOf(onto: OntoParent, target: SourceRef, ctx: PageCtx): Record<string, unknown> | undefined {
  const up = kindOf(onto.relation.parent);
  return up ? (itemsOf(target, up, ctx).find((x) => itemId(up, x) === onto.parent) as Record<string, unknown> | undefined) : undefined;
}

// 这一项放不放得下这个上级（取值要同一维这类）
export function fitsUnder(onto: OntoParent | undefined, target: SourceRef, ctx: PageCtx): (item: unknown) => boolean {
  const fits = onto?.relation.fits;
  if (!onto || !fits) return () => true;
  const parent = parentOf(onto, target, ctx);
  return (item) => !parent || fits(parent, item as Record<string, unknown>);
}

// 一行的样子：rowLook 之上加两处——已有的写“本世界已有”，上级放不下的灰着写原因（勾着的照样能取消）
export function otherLook(v: PickView, r: ContentRef, fits: boolean, onto?: OntoParent): RowLook {
  const look = lookOf(v, r);
  if (look.mark === 'have') return look;
  if (!fits && onto) return { mark: 'grey', picked: look.picked, note: `放不到“${onto.title}”下面`, resolvable: false };
  return look;
}

// 那个库里这一种的项，按它自己列表的分段；q：搜索
export function otherSections(from: string, o: OtherOpen, target: SourceRef, ctx: PageCtx, q = ''): OtherSection[] {
  const src: SourceRef = { t: 'lib', key: from };
  if (!entryOf(src, ctx)) return [];
  const p = listPage(src, { p: 'list', kind: o.kind, ...(o.dim ? { dim: o.dim } : {}) }, ctx, q);
  if (!p) return [];
  const v = pickView(src, ctx);
  const pick = v && kindPickable(v, o.kind) ? v : null;
  const fits = fitsUnder(o.onto, target, ctx);
  const out: OtherSection[] = [];
  for (const s of p.sections) {
    const rows: OtherRow[] = s.rows
      .filter((r) => r.kind.id === o.kind)
      .map((r) => {
        const ref = { kind: o.kind, id: r.id };
        const c = (r.item as { color?: unknown }).color;
        return {
          key: r.key,
          ref,
          name: r.name,
          ...(typeof c === 'string' && c.startsWith('#') ? { color: c } : {}),
          ...(r.hint ? { hint: r.hint } : {}),
          item: r.item,
          look: pick ? otherLook(pick, ref, fits(r.item), o.onto) : null,
        };
      });
    if (rows.length) out.push({ label: s.label, rows });
  }
  return out;
}

// ---------- 点名字展开的一小段 ----------

export interface OtherDetail {
  // 这一项的说明
  text: string | null;
  // 勾它会一起加的（只勾它时的清单，除了它自己）：“意识形态（变量）”
  along: string[];
}

export function otherDetail(v: PickView, row: Pick<OtherRow, 'ref' | 'item'>): OtherDetail {
  const d = (row.item as { description?: unknown }).description;
  const text = typeof d === 'string' && d.trim() ? d.trim() : null;
  const p = importPreview({ source: v.ask.source, target: v.ask.target, picks: [row.ref] });
  const along = p.rows.filter((r) => !(r.kind === row.ref.kind && r.id === row.ref.id)).map((r) => `${r.name}（${r.kindLabel}）`);
  return { text, along };
}

// ---------- 添加 ----------

// 上级页面打开的：这个库勾的这一种里放得下这个上级的，添加时都链到上级下面（同一个 batch）。没有时 undefined
export function ontoOf(v: PickView, o: OtherOpen, target: SourceRef, ctx: PageCtx): ImportOnto | undefined {
  if (!o.onto) return undefined;
  const fits = fitsUnder(o.onto, target, ctx);
  const k = kindOf(o.onto.relation.child);
  const items = k ? new Map(packItems(v.ask.source, k.pack.key).map((x) => [itemId(k, x), x])) : new Map<string, unknown>();
  const children = v.preview.rows.filter((r) => r.kind === o.onto!.relation.child && r.role === 'pick' && fits(items.get(r.id))).map((r) => ({ kind: r.kind, id: r.id }));
  return children.length ? { relation: o.onto.relation, parent: o.onto.parent, children } : undefined;
}

// 按钮出不出：别的库里有这一种
export const hasOther = (o: Pick<OtherOpen, 'kind' | 'dim'>, target: SourceRef, ctx: PageCtx): boolean =>
  ctx.lib.some((e) => !(target.t === 'lib' && e.key === target.key) && kindItems(e.pack, o).length > 0);
