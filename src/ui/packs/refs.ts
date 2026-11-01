import { type ContentKind, itemId, itemName, kindOf } from '../../../core/content/registry';
import { CATEGORY_NAMES } from '../../../core/human/government';
import { type PackWorld, packItems } from '../../../core/packs';
import { BUILTIN_FIELDS } from '../../../core/species';
import type { LibraryEntry } from '../../library';

// 编辑器里的引用（第四十五轮）：文化组、地名风格、维度、取值、取值组、政体、国家等级……从带搜索的下拉里选，不再手写 id。
// 能选的是本世界里的、资源库里（内置的、我的、装上的）的，同一个 id 只列一次（本世界的在前）。
// 字段表（FieldDesc）的 ref / keyRef 写着引用的是什么：内容种类的 id，或下面几种不是内容的：
//   dimension 时代里的维度（另有政体 government：倾向里政体也算一维）、govCategory 政体的类别、tolerance 生态的条件。
// 不碰界面，测试直接调

export interface RefOption {
  id: string;
  label: string;
  // 灰色的说明：文化的组、取值的维度……
  hint?: string;
  color?: string;
  // 取值的维度（倾向的表按它筛）
  dimension?: string;
}

export interface RefCtx {
  world: PackWorld | null;
  lib: readonly LibraryEntry[];
}

// 倾向里政体那一维
export const GOVERNMENT_DIM = 'government';
// 称号、派系的基础里“其余的”
export const DEFAULT_KEY = 'default';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

// 一种内容的全部项（本世界的在前，之后按资源库的先后），同一个 id 只取第一个
function kindItems(kind: ContentKind, ctx: RefCtx): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  const add = (x: unknown) => {
    const id = itemId(kind, x);
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(x);
    }
  };
  if (ctx.world) for (const x of kind.inWorld(ctx.world)) add(x);
  for (const e of ctx.lib) for (const x of packItems(e.pack, kind.pack.key)) add(x);
  return out;
}

function build(ref: string, ctx: RefCtx): RefOption[] {
  switch (ref) {
    case 'dimension': {
      const era = kindOf('era');
      const out: RefOption[] = [];
      const seen = new Set<string>();
      for (const e of era ? kindItems(era, ctx) : []) {
        for (const d of ((e as { dimensions?: unknown }).dimensions as { id?: unknown; label?: unknown }[] | undefined) ?? []) {
          const id = str(d.id);
          if (id && !seen.has(id)) {
            seen.add(id);
            out.push({ id, label: str(d.label) ?? id });
          }
        }
      }
      out.push({ id: GOVERNMENT_DIM, label: '政体' });
      return out;
    }
    case 'govCategory': {
      const gov = kindOf('government');
      const seen = new Set<string>(Object.keys(CATEGORY_NAMES));
      const extra: string[] = [];
      for (const g of gov ? kindItems(gov, ctx) : []) {
        for (const c of ((g as { category?: unknown }).category as unknown[] | undefined) ?? []) {
          const id = str(c);
          if (id && !seen.has(id)) {
            seen.add(id);
            extra.push(id);
          }
        }
      }
      return [...Object.entries(CATEGORY_NAMES).map(([id, label]) => ({ id, label })), ...extra.map((id) => ({ id, label: id }))];
    }
    case 'tolerance': {
      const out: RefOption[] = BUILTIN_FIELDS.map((f) => ({ id: f.id, label: f.label, ...(f.unit ? { hint: f.unit } : {}) }));
      for (const [kindId, prefix, noun] of [
        ['riverType', 'river', '离河'],
        ['lakeType', 'lake', '离湖'],
      ] as const) {
        const k = kindOf(kindId);
        for (const x of k ? kindItems(k, ctx) : []) out.push({ id: `${prefix}:${itemId(k!, x)}`, label: `${noun}·${itemName(k!, x)}` });
      }
      const field = kindOf('field');
      for (const x of field && ctx.world ? field.inWorld(ctx.world) : []) {
        const id = itemId(field!, x);
        out.push({ id, label: itemName(field!, x), hint: '自定义场' });
      }
      return out;
    }
  }
  const kind = kindOf(ref);
  if (!kind) return [];
  const items = kindItems(kind, ctx);
  // 文化写组、取值写维度（组的名字从同样的地方找）
  const groups = ref === 'culture' ? new Map(build('cultureGroup', ctx).map((g) => [g.id, g.label])) : null;
  const dims = ref === 'popValue' || ref === 'valueGroup' ? new Map(build('dimension', ctx).map((d) => [d.id, d.label])) : null;
  const opts = items.map((x): RefOption => {
    const o = x as Record<string, unknown>;
    const id = itemId(kind, x);
    const group = str(o.group);
    const dim = str(o.dimension);
    const hint = groups && group ? (groups.get(group) ?? group) : dims && dim ? (dims.get(dim) ?? dim) : undefined;
    return { id, label: itemName(kind, x) || id, ...(hint ? { hint } : {}), ...(str(o.color) ? { color: str(o.color) } : {}), ...(dim ? { dimension: dim } : {}) };
  });
  // 国家等级按高低排（高的在前）
  if (ref === 'countryTier') {
    const order = new Map(items.map((x) => [itemId(kind, x), Number((x as { order?: unknown }).order) || 0]));
    opts.sort((a, b) => (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0));
  }
  return opts;
}

// 引用的那一项本身（文化的组：表里写“沿用文化组”的那几维）。本世界的优先；没有时 undefined
export function refItem(kindId: string, id: string, ctx: RefCtx): Record<string, unknown> | undefined {
  const kind = kindOf(kindId);
  if (!kind) return undefined;
  const hit = (list: readonly unknown[]) => list.find((x) => itemId(kind, x) === id) as Record<string, unknown> | undefined;
  if (ctx.world) {
    const w = hit(kind.inWorld(ctx.world));
    if (w) return w;
  }
  for (const e of ctx.lib) {
    const x = hit(packItems(e.pack, kind.pack.key));
    if (x) return x;
  }
  return undefined;
}

// 世界、资源库换了才重算（一次打开编辑器里有十几个下拉，查同一种）
const cache = new WeakMap<object, WeakMap<object, Map<string, RefOption[]>>>();
const NO_WORLD = {};
export function refOptions(ref: string, ctx: RefCtx): RefOption[] {
  let byWorld = cache.get(ctx.lib);
  if (!byWorld) cache.set(ctx.lib, (byWorld = new WeakMap()));
  const wk = ctx.world?.small ?? NO_WORLD;
  let m = byWorld.get(wk);
  if (!m) byWorld.set(wk, (m = new Map()));
  let v = m.get(ref);
  if (!v) m.set(ref, (v = build(ref, ctx)));
  return v;
}

// 几种合在一起（称号的键：文化或文化组）
export function refOptionsOf(ref: string | readonly string[], ctx: RefCtx): RefOption[] {
  if (typeof ref === 'string') return refOptions(ref, ctx);
  const seen = new Set<string>();
  const out: RefOption[] = [];
  for (const r of ref) {
    const label = kindOf(r)?.label;
    for (const o of refOptions(r, ctx)) {
      if (seen.has(o.id)) continue;
      seen.add(o.id);
      out.push(label && !o.hint ? { ...o, hint: label } : o);
    }
  }
  return out;
}

// 搜索：名字、id、说明里有这几个字的；开头就对上的排前面。最多 limit 个
export function searchRefs(opts: readonly RefOption[], query: string, limit = 80): { list: RefOption[]; more: number } {
  const q = query.trim().toLowerCase();
  if (!q) return { list: opts.slice(0, limit), more: Math.max(0, opts.length - limit) };
  const head: RefOption[] = [];
  const rest: RefOption[] = [];
  for (const o of opts) {
    const label = o.label.toLowerCase();
    const id = o.id.toLowerCase();
    if (label.startsWith(q) || id.startsWith(q)) head.push(o);
    else if (label.includes(q) || id.includes(q) || (o.hint?.toLowerCase().includes(q) ?? false)) rest.push(o);
  }
  const all = [...head, ...rest];
  return { list: all.slice(0, limit), more: Math.max(0, all.length - limit) };
}

// 一个 id 怎么写：选项里有时写名字，没有时照写 id
export function refLabel(opts: readonly RefOption[], id: string): string {
  if (id === DEFAULT_KEY) return '其余';
  return opts.find((o) => o.id === id)?.label ?? id;
}
