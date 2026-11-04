import type { PackNode } from '../packs';
import { BUILTIN_FIELDS } from '../species';
import { DEFAULT_KEY, DIMENSION, GOVERNMENT_DIM, KIND_LINKS, REF_PSEUDO } from './link-rules';
import { packItems } from './pack-tree';
import { ITEM_ID, type Ref, isScriptVariable, scriptRefs } from './refs';
import { type ContentKind, type ContentWorld, type FieldDesc, type FieldType, type LinkClass, type Renames, allKinds, itemId, kindOf } from './registry';

// 内容之间的引用表（第四十九轮）：一项内容引用了哪些别的内容、谁引用它、依赖的闭包、改名时怎么跟着改、缺了时怎么去掉。
// 由字段表（FieldDesc 的 ref、keyRef、script、tendencies、title）走一遍项的数据推出来，再加每种内容的补充（link-rules.ts）。
// 只管内容和内容之间；地图上用到的地方（国家、城市、画的格）在 usage.ts。纯计算，不引用内置的数据（core/packs/）。
//
// 依赖类别见 registry.ts 的 LinkClass，写在字段表的 dep 上。
// 维度不是单独的一项：引用它的 kinds 是 ['dimension']，由时代提供（provides）。改名不碰它（时代改了名，维度的 id 不变）。

type Seg = string | number;
export type LinkPath = readonly Seg[];

// 去掉一条引用之后，when 这个容器空了就把 remove 这一处也去掉（按先后往外走）
export interface LinkPrune {
  when: LinkPath;
  remove: LinkPath;
}

export interface Link {
  // 目标的种类（内容种类的 id 或 'dimension'）。几种时按先后找（称号的键：先文化，再文化组）
  kinds: readonly string[];
  // 目标的 id
  id: string;
  cls: LinkClass;
  // 字段的名字（界面写“文化组：日耳曼”）
  label: string;
  // 在这一项里的位置。key：路径的最后一段是这个键；script：路径指到源码（src）
  path: LinkPath;
  at: 'value' | 'key' | 'script' | 'implicit';
  // value 的前缀（条件里的 river:）
  prefix?: string;
  // script：名字在源码里的位置
  start?: number;
  end?: number;
  // 去掉这条引用时删哪一处（列表里的一个、键、规则的一整条）；没有时去不掉（脚本、必须有的字段）
  drop?: LinkPath;
  chain?: readonly LinkPrune[];
  // 称号的表：键都去掉时换成第一种写法（称号还在，只是不再分等级、分文化）
  collapse?: LinkPath;
}

export interface ContentRef {
  kind: string;
  id: string;
}

// ---------- 走字段表 ----------

// 脚本里的写法引用哪一种
const SCRIPT_FNS: Readonly<Record<Ref['fn'], string>> = { field: 'field', river: 'riverType', hasRiver: 'riverType', nearLake: 'lakeType', hasLake: 'lakeType', biome: 'biome' };

interface Ctx {
  path: LinkPath;
  dep: LinkClass;
  // 最近的列表项（规则的一条）：里面的条件没了时整条去掉（只留另外几项，这条规则就放宽了）
  rule: LinkPath | null;
  // 最近的可选对象：里面必须有的字段没了时整个去掉（侵占的目标）
  owner: LinkPath | null;
  chain: readonly LinkPrune[];
}

const isTitleOne = (v: unknown): boolean => {
  if (typeof v === 'string') return true;
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.zh === 'string' && Object.keys(o).every((k) => k === 'zh' || k === 'orig');
};

const asKinds = (r: string | readonly string[]): readonly string[] => (typeof r === 'string' ? [r] : r);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// 这个字段（容器）空了时去掉什么，和接下来还要看的
function emptyChain(f: FieldDesc, path: LinkPath, ctx: Ctx): readonly LinkPrune[] {
  const target = ctx.rule ?? (f.optional ? path : ctx.owner);
  return target ? [{ when: path, remove: target }, ...ctx.chain] : [];
}

type Walker = (f: FieldDesc, v: unknown, ctx: Ctx, out: Link[]) => void;
const noLinks: Walker = () => {};

// 一个写着 ref 的值（一个字）。drop、chain 由调用方定
function refValue(f: FieldDesc, id: string, ctx: Ctx, path: LinkPath, drop: LinkPath | undefined, chain: readonly LinkPrune[], out: Link[]): void {
  const ref = f.ref;
  if (!ref || ref === 'govCategory') return;
  const base = { cls: ctx.dep, label: f.label, path, at: 'value' as const, ...(drop ? { drop, chain } : {}) };
  if (ref === 'tolerance') {
    for (const [prefix, kind] of [
      ['river:', 'riverType'],
      ['lake:', 'lakeType'],
      ['field:', 'field'],
    ] as const) {
      if (id.startsWith(prefix)) {
        out.push({ ...base, kinds: [kind], id: id.slice(prefix.length), prefix });
        return;
      }
    }
    if (!BUILTIN_FIELDS.some((b) => b.id === id)) out.push({ ...base, kinds: ['tolerance'], id });
    return;
  }
  out.push({ ...base, kinds: [ref], id });
}

// 表的键
function refKeys(f: FieldDesc, m: Record<string, unknown>, ctx: Ctx, chain: readonly LinkPrune[], collapse: boolean, out: Link[]): void {
  if (!f.keyRef) return;
  for (const k of Object.keys(m)) {
    if (k === DEFAULT_KEY) continue;
    const path = [...ctx.path, k];
    out.push({ kinds: asKinds(f.keyRef), id: k, cls: ctx.dep, label: f.label, path, at: 'key', drop: path, chain: collapse ? [] : chain, ...(collapse ? { collapse: ctx.path } : {}) });
  }
}

// 倾向：维度 → 取值（政体那一维的取值是政体）
function tendencyLinks(f: FieldDesc, v: Record<string, unknown>, ctx: Ctx, out: Link[]): void {
  const chain = emptyChain(f, ctx.path, ctx);
  for (const [dim, list] of Object.entries(v)) {
    const dimPath = [...ctx.path, dim];
    if (dim !== GOVERNMENT_DIM) out.push({ kinds: [DIMENSION], id: dim, cls: ctx.dep, label: f.label, path: dimPath, at: 'key', drop: dimPath, chain });
    if (!Array.isArray(list)) continue;
    const inner = [{ when: dimPath, remove: dimPath }, ...chain];
    list.forEach((x, k) => {
      const pair = Array.isArray(x);
      const id = pair ? x[0] : x;
      if (typeof id === 'string') out.push({ kinds: [dim === GOVERNMENT_DIM ? 'government' : 'popValue'], id, cls: ctx.dep, label: f.label, path: pair ? [...dimPath, k, 0] : [...dimPath, k], at: 'value', drop: [...dimPath, k], chain: inner });
    });
  }
}

// 每种字段怎么走。新的字段类型不写这里 tsc 就不过（测试另外查实际用到的类型）
export const FIELD_WALKERS: Readonly<Record<FieldType, Walker>> = {
  longtext: noLinks,
  number: noLinks,
  range: noLinks,
  bool: noLinks,
  color: noLinks,
  enum: noLinks,
  // 几种称号的写法：只有字
  titleList: noLinks,
  text: (f, v, ctx, out) => {
    if (typeof v !== 'string') return;
    const drop = ctx.rule ?? (f.optional ? ctx.path : (ctx.owner ?? undefined));
    refValue(f, v, ctx, ctx.path, drop, ctx.chain, out);
  },
  tags: (f, v, ctx, out) => {
    if (!Array.isArray(v)) return;
    const chain = emptyChain(f, ctx.path, ctx);
    v.forEach((x, k) => {
      if (typeof x === 'string') refValue(f, x, ctx, [...ctx.path, k], [...ctx.path, k], chain, out);
    });
  },
  weighted: (f, v, ctx, out) => {
    if (!Array.isArray(v)) return;
    const chain = emptyChain(f, ctx.path, ctx);
    v.forEach((x, k) => {
      const pair = Array.isArray(x);
      const id = pair ? x[0] : x;
      if (typeof id === 'string') refValue(f, id, ctx, pair ? [...ctx.path, k, 0] : [...ctx.path, k], [...ctx.path, k], chain, out);
    });
  },
  list: (f, v, ctx, out) => {
    if (!Array.isArray(v) || !f.of) return;
    const chain = emptyChain(f, ctx.path, ctx);
    v.forEach((x, k) => {
      const path = [...ctx.path, k];
      walkFields(f.of!, x, { path, dep: ctx.dep, rule: path, owner: null, chain }, out);
    });
  },
  map: (f, v, ctx, out) => {
    if (!isObject(v)) return;
    const chain = emptyChain(f, ctx.path, ctx);
    refKeys(f, v, ctx, chain, false, out);
    for (const [k, x] of Object.entries(v)) {
      const path = [...ctx.path, k];
      const inner: Ctx = { path, dep: ctx.dep, rule: path, owner: null, chain };
      if (f.of) walkFields(f.of, x, inner, out);
      else if (f.value) walkField(f.value, x, inner, out);
    }
  },
  json: (f, v, ctx, out) => {
    if (!f.of) return;
    walkFields(f.of, v, { ...ctx, owner: f.optional ? ctx.path : ctx.owner, chain: emptyChain(f, ctx.path, ctx) }, out);
  },
  tuple: (f, v, ctx, out) => {
    if (!Array.isArray(v) || !f.items) return;
    f.items.forEach((it, k) => walkField({ ...it, key: String(k) }, v[k], { ...ctx, path: [...ctx.path, k] }, out));
  },
  tuples: (f, v, ctx, out) => {
    if (!Array.isArray(v) || !f.items) return;
    const chain = emptyChain(f, ctx.path, ctx);
    v.forEach((row, r) => {
      if (Array.isArray(row)) f.items!.forEach((it, k) => walkField({ ...it, key: String(k) }, row[k], { path: [...ctx.path, r, k], dep: ctx.dep, rule: [...ctx.path, r], owner: null, chain }, out));
    });
  },
  title: (f, v, ctx, out) => {
    if (isObject(v) && !isTitleOne(v)) refKeys(f, v, ctx, [], true, out);
  },
  tendencies: (f, v, ctx, out) => {
    if (!isObject(v)) return;
    if (!f.byEra) {
      tendencyLinks(f, v, ctx, out);
      return;
    }
    const chain = emptyChain(f, ctx.path, ctx);
    for (const [era, t] of Object.entries(v)) {
      const path = [...ctx.path, era];
      out.push({ kinds: ['era'], id: era, cls: ctx.dep, label: f.label, path, at: 'key', drop: path, chain });
      if (isObject(t)) tendencyLinks({ ...f, optional: true }, t, { path, dep: ctx.dep, rule: null, owner: null, chain }, out);
    }
  },
  script: (f, v, ctx, out) => {
    if (!isObject(v)) return;
    for (const [name, s] of Object.entries(v)) {
      const src = (s as { src?: unknown } | null | undefined)?.src;
      if (typeof src !== 'string') continue;
      for (const r of scriptRefs(src)) {
        if (r.fn === 'field' && isScriptVariable(r.name)) continue;
        out.push({ kinds: [SCRIPT_FNS[r.fn]], id: r.name, cls: ctx.dep, label: f.label, path: [...ctx.path, name, 'src'], at: 'script', start: r.start, end: r.end });
      }
    }
  },
};

function walkField(f: FieldDesc, v: unknown, ctx: Ctx, out: Link[]): void {
  if (v === undefined || v === null) return;
  FIELD_WALKERS[f.type](f, v, f.dep ? { ...ctx, dep: f.dep } : ctx, out);
}

function walkFields(fields: readonly FieldDesc[], item: unknown, ctx: Ctx, out: Link[]): void {
  if (!isObject(item)) return;
  for (const f of refFields(fields)) walkField(f, item[f.key], { ...ctx, path: [...ctx.path, f.key] }, out);
}

// 字段（和下面的字段）有没有引用（按字段表缓存：名字、颜色这些每次不用看）
const hasLinks = (f: FieldDesc): boolean => (!!f.ref && f.ref !== 'govCategory') || !!f.keyRef || f.type === 'script' || f.type === 'tendencies' || !!f.of?.some(hasLinks) || !!f.items?.some(hasLinks) || (!!f.value && hasLinks(f.value));
const refFieldCache = new WeakMap<readonly FieldDesc[], readonly FieldDesc[]>();
function refFields(fields: readonly FieldDesc[]): readonly FieldDesc[] {
  let c = refFieldCache.get(fields);
  if (!c) refFieldCache.set(fields, (c = fields.filter(hasLinks)));
  return c;
}

const TOP: Ctx = { path: [], dep: 'hard', rule: null, owner: null, chain: [] };
const kindArg = (kind: ContentKind | string): ContentKind | undefined => (typeof kind === 'string' ? kindOf(kind) : kind);

// 一项内容里的全部引用，按字段的先后。不看它们指到的东西在不在
export function linksOf(kind: ContentKind | string, item: unknown): Link[] {
  const k = kindArg(kind);
  if (!k) return [];
  const out: Link[] = [];
  walkFields(k.fields, item, TOP, out);
  const rules = KIND_LINKS[k.id];
  if (rules?.extra && isObject(item)) out.push(...rules.extra(item));
  return out;
}

// 这一项引用的某一种内容的 id（去重，按先后）
export function linkIds(kind: ContentKind | string, item: unknown, target: string): string[] {
  return [...new Set(linksOf(kind, item).filter((l) => l.kinds.includes(target)).map((l) => l.id))];
}

// 这一项用到的自定义场（只算合规的名字：别的名字世界里不会有这个场，加也加不了，脚本照“出错”处理）。加进世界时要先有
export const itemFields = (kind: ContentKind | string, item: unknown): string[] => linkIds(kind, item, 'field').filter((f) => ITEM_ID.test(f));

// ---------- 改名 ----------

// 一个改名表里有没有真的改名的（没有时不用走字段表：世界里全是一样的项时最常见）
const renamesAny = new WeakMap<Renames, boolean>();
function anyRename(r: Renames): boolean {
  let v = renamesAny.get(r);
  if (v === undefined) {
    v = Object.values(r).some((m) => m && [...m].some(([a, b]) => a !== b));
    renamesAny.set(r, v);
  }
  return v;
}

function renamedTo(l: Link, r: Renames): string | undefined {
  for (const kind of l.kinds) {
    const key = kindOf(kind)?.pack.key;
    const to = key ? r[key]?.get(l.id) : undefined;
    if (to !== undefined) return to;
  }
  return undefined;
}

function getAt(root: unknown, path: LinkPath): unknown {
  let cur = root;
  for (const s of path) cur = (cur as Record<Seg, unknown> | undefined)?.[s];
  return cur;
}

function setAt(root: unknown, path: LinkPath, v: unknown): void {
  (getAt(root, path.slice(0, -1)) as Record<Seg, unknown>)[path[path.length - 1]] = v;
}

// 一项里的引用按改名表换成新的 id（不改它自己的 id）：值、表的键（键的先后不变）、条件的前缀后面、脚本的字面量都换。
// 什么都没改时给回原来的对象；改了时给副本，原来的不动。only：只换这一类的（比较“是不是同一项”时用，见 packs.ts）
export function renameLinks<T>(kind: ContentKind | string, item: T, renames: Renames, only?: LinkClass): T {
  if (!anyRename(renames)) return item;
  return rewriteLinks(kind, item, (link) => (only && link.cls !== only ? undefined : renamedTo(link, renames)));
}

// 引用的目标全部抹掉的样子：两项只差引用指到哪里时一样（撞过名的项再导入时先按它猜改过的名字，见 packs.ts 的 settleIds）
export function linksBlanked<T>(kind: ContentKind | string, item: T): T {
  let n = 0;
  return rewriteLinks(kind, item, () => `#${n++}`);
}

// 一条条换目标：to 给出新的 id，undefined 是不换
function rewriteLinks<T>(kind: ContentKind | string, item: T, toOf: (link: Link) => string | undefined): T {
  const todo: { link: Link; to: string }[] = [];
  for (const link of linksOf(kind, item)) {
    const to = toOf(link);
    if (to !== undefined && to !== link.id) todo.push({ link, to });
  }
  if (!todo.length) return item;
  const out = structuredClone(item);
  // 同一张表的键一次换完（a → a-2 与 a-2 → a-2-2 同时发生也对），同一段源码从后往前换（位置不变）
  const maps = new Map<string, { path: LinkPath; to: Map<string, string> }>();
  const scripts = new Map<string, { path: LinkPath; edits: { start: number; end: number; to: string }[] }>();
  for (const { link, to } of todo) {
    if (link.at === 'value') setAt(out, link.path, `${link.prefix ?? ''}${to}`);
    else if (link.at === 'key') {
      const path = link.path.slice(0, -1);
      const at = JSON.stringify(path);
      if (!maps.has(at)) maps.set(at, { path, to: new Map() });
      maps.get(at)!.to.set(link.id, to);
    } else if (link.at === 'script') {
      const at = JSON.stringify(link.path);
      if (!scripts.has(at)) scripts.set(at, { path: link.path, edits: [] });
      scripts.get(at)!.edits.push({ start: link.start!, end: link.end!, to });
    }
  }
  // 里面的表先换（外面的键换了，里面的路径就对不上了）
  for (const { path, to } of [...maps.values()].sort((a, b) => b.path.length - a.path.length)) {
    const m = getAt(out, path) as Record<string, unknown>;
    const entries = Object.entries(m);
    for (const [k] of entries) delete m[k];
    for (const [k, v] of entries) m[to.get(k) ?? k] = v;
  }
  for (const { path, edits } of scripts.values()) {
    let src = getAt(out, path) as string;
    for (const e of edits.sort((a, b) => b.start - a.start)) src = src.slice(0, e.start) + e.to + src.slice(e.end);
    setAt(out, path, src);
  }
  return out;
}

// ---------- 去掉引用 ----------

const GONE = Symbol('gone');

function removeAt(root: unknown, path: LinkPath): void {
  const parent = getAt(root, path.slice(0, -1));
  const last = path[path.length - 1];
  if (Array.isArray(parent)) parent[last as number] = GONE;
  else if (parent) delete (parent as Record<Seg, unknown>)[last];
}

const isEmptied = (v: unknown): boolean => (Array.isArray(v) ? v.every((x) => x === GONE) : isObject(v) && !Object.keys(v).length);

function compact(v: unknown): unknown {
  if (Array.isArray(v)) return v.filter((x) => x !== GONE).map(compact);
  if (isObject(v)) for (const k of Object.keys(v)) v[k] = compact(v[k]);
  return v;
}

// 去掉选中的引用（第六十一轮导入时用：目标缺了的）。列表里的去掉一个；规则里的条件没了时整条规则去掉
// （只留另外几项规则就放宽了）；可选的字段空了去掉这个字段；称号的表键都没了时换成第一种写法。
// 脚本、必须有的字段（文化的组）去不掉，留着。什么都没去掉时给回原来的对象；改了时给副本
export function stripLinks<T>(kind: ContentKind | string, item: T, pick: (link: Link) => boolean): T {
  const links = linksOf(kind, item).filter((l) => l.drop && pick(l));
  if (!links.length) return item;
  const out = structuredClone(item);
  const first = new Map<string, unknown>();
  for (const l of links) {
    if (!l.collapse) continue;
    const at = JSON.stringify(l.collapse);
    if (!first.has(at)) first.set(at, Object.values(getAt(out, l.collapse) as object)[0]);
  }
  for (const l of links) removeAt(out, l.drop!);
  for (const l of links) {
    for (const { when, remove } of l.chain ?? []) {
      const c = getAt(out, when);
      if (c !== undefined && !isEmptied(c)) break;
      if (c !== undefined) removeAt(out, remove);
    }
    if (l.collapse && isEmptied(getAt(out, l.collapse))) setAt(out, l.collapse, first.get(JSON.stringify(l.collapse)));
  }
  return compact(out) as T;
}

// ---------- 一个世界或一个包里的表 ----------

// 查哪些项：一个世界，或一个（几个）包
export interface LinkScope {
  items(kind: ContentKind): readonly unknown[];
}
export const worldScope = (w: ContentWorld): LinkScope => ({ items: (k) => k.inWorld(w) });
export const packScope = (...packs: readonly PackNode[]): LinkScope => ({
  items: (k) => {
    if (packs.length === 1) return packItems(packs[0], k.pack.key);
    const seen = new Set<string>();
    return packs.flatMap((p) => packItems(p, k.pack.key)).filter((x) => {
      const id = itemId(k, x);
      return !seen.has(id) && !!seen.add(id);
    });
  },
});

const keyOf = (kind: string, id: string) => `${kind}\u0000${id}`;
export const linkKey = keyOf;

export interface LinkFrom {
  from: ContentRef;
  link: Link;
}

export interface LinkTable {
  // 全部的项（维度也算一项，item 是空的，owners 是提供它的时代）
  nodes: Map<string, ContentRef & { item?: unknown; owners?: string[] }>;
  out: Map<string, Link[]>;
  into: Map<string, LinkFrom[]>;
}

// 这条引用指到哪一项（kinds 按先后找）；找不到时 null
export function resolveLink(table: Pick<LinkTable, 'nodes'>, link: Pick<Link, 'kinds' | 'id'>): ContentRef | null {
  for (const kind of link.kinds) {
    const n = table.nodes.get(keyOf(kind, link.id));
    if (n) return { kind: n.kind, id: n.id };
  }
  return null;
}

export function linkTable(scope: LinkScope, kinds: readonly ContentKind[] = allKinds()): LinkTable {
  const nodes: LinkTable['nodes'] = new Map();
  const out: LinkTable['out'] = new Map();
  const into: LinkTable['into'] = new Map();
  for (const k of kinds) {
    for (const item of scope.items(k)) {
      const id = itemId(k, item);
      if (nodes.has(keyOf(k.id, id))) continue;
      nodes.set(keyOf(k.id, id), { kind: k.id, id, item });
      for (const p of KIND_LINKS[k.id]?.provides?.(item) ?? []) {
        const at = keyOf(p.kind, p.id);
        const n = nodes.get(at);
        if (n) n.owners!.push(id);
        else nodes.set(at, { kind: p.kind, id: p.id, owners: [id] });
      }
    }
  }
  for (const n of [...nodes.values()]) {
    if (n.owners) continue;
    const links = linksOf(n.kind, n.item);
    out.set(keyOf(n.kind, n.id), links);
    for (const link of links) {
      const to = resolveLink({ nodes }, link);
      if (!to) continue;
      const at = keyOf(to.kind, to.id);
      if (!into.has(at)) into.set(at, []);
      into.get(at)!.push({ from: { kind: n.kind, id: n.id }, link });
    }
  }
  return { nodes, out, into };
}

// 这一项引用了什么（target 为 null 的是找不到的）
export function referencesOf(table: LinkTable, ref: ContentRef): { link: Link; target: ContentRef | null }[] {
  return (table.out.get(keyOf(ref.kind, ref.id)) ?? []).map((link) => ({ link, target: resolveLink(table, link) }));
}

// 谁引用这一项
export const referrersOf = (table: LinkTable, ref: ContentRef): readonly LinkFrom[] => table.into.get(keyOf(ref.kind, ref.id)) ?? [];

// 表里全部找不到目标的引用
export function danglingLinks(table: LinkTable): LinkFrom[] {
  const bad: LinkFrom[] = [];
  for (const n of table.nodes.values()) {
    if (n.owners) continue;
    for (const link of table.out.get(keyOf(n.kind, n.id)) ?? []) if (!resolveLink(table, link)) bad.push({ from: { kind: n.kind, id: n.id }, link });
  }
  return bad;
}

export interface LinkClosure {
  // 顺着 hard 走到的
  hard: ContentRef[];
  // 走到要经过 auto、gate 的
  auto: ContentRef[];
  // 上面这些项 strip 类引用的、这张表里有的（不跟着带：目的地没有时去掉这条引用）
  strip: ContentRef[];
  // 上面这些项里找不到目标的引用
  missing: LinkFrom[];
}

// 依赖的闭包：seeds 这几项写到的全部（不含 seeds 自己）。一项有两条路时算在 hard 里。导入不走这里（core/packs/import-gates.ts），这里只是查引用表。
// 不反着走：文化组不带它的文化（那是“组里有什么”，第六十轮的 childrenOf），维度不带时代（只给 owners，加变量见第五十四轮）
export function dependencyClosure(table: LinkTable, seeds: readonly ContentRef[]): LinkClosure {
  const inSeeds = new Set(seeds.map((s) => keyOf(s.kind, s.id)));
  const reached = new Map<string, ContentRef>();
  const walk = (starts: readonly ContentRef[], classes: readonly LinkClass[]): ContentRef[] => {
    const found: ContentRef[] = [];
    const stack = [...starts].reverse();
    while (stack.length) {
      const cur = stack.pop()!;
      for (const link of table.out.get(keyOf(cur.kind, cur.id)) ?? []) {
        if (!classes.includes(link.cls)) continue;
        const to = resolveLink(table, link);
        if (!to) continue;
        const at = keyOf(to.kind, to.id);
        if (inSeeds.has(at) || reached.has(at)) continue;
        reached.set(at, to);
        found.push(to);
        stack.push(to);
      }
    }
    return found;
  };
  const hard = walk(seeds, ['hard']);
  const auto = walk([...seeds, ...hard], ['hard', 'auto', 'gate']);
  const all = [...seeds, ...hard, ...auto];
  const strip: ContentRef[] = [];
  const missing: LinkFrom[] = [];
  const told = new Set<string>();
  for (const from of all) {
    for (const link of table.out.get(keyOf(from.kind, from.id)) ?? []) {
      const to = resolveLink(table, link);
      if (!to) {
        missing.push({ from, link });
        continue;
      }
      const at = keyOf(to.kind, to.id);
      if (link.cls !== 'strip' || inSeeds.has(at) || reached.has(at) || told.has(at)) continue;
      told.add(at);
      strip.push(to);
    }
  }
  return { hard, auto, strip, missing };
}

// ---------- 引用表管到了没有 ----------

// 登记的种类、字段表里引用表没管到的地方（测试查：以后加一种内容、一种字段、一种 ref 时不能悄悄漏掉）
export function linkProblems(kinds: readonly ContentKind[] = allKinds()): string[] {
  const problems: string[] = [];
  const ids = new Set(kinds.map((k) => k.id));
  const known = (r: string) => ids.has(r) || REF_PSEUDO.has(r);
  const see = (who: string, fields: readonly FieldDesc[], top = false) => {
    for (const f of fields) {
      const at = `${who}.${f.key}`;
      // 导入时按最外层的字段看“一条不剩”（core/packs/import-gates.ts）：写在里面或写在单个值上看不出落空
      if (f.dep === 'gate' && (!top || (f.type !== 'list' && f.type !== 'tags'))) problems.push(`${at}：dep: 'gate' 只能写在最外层的列表字段上`);
      if (!(f.type in FIELD_WALKERS)) problems.push(`${at}：引用表不认识字段类型 ${f.type}`);
      if (f.ref && !known(f.ref)) problems.push(`${at}：引用表不认识 ref ${f.ref}`);
      if (f.ref && !['text', 'tags', 'weighted'].includes(f.type)) problems.push(`${at}：${f.type} 字段上的 ref 走不到`);
      if (f.keyRef) {
        for (const r of asKinds(f.keyRef)) if (!known(r)) problems.push(`${at}：引用表不认识 keyRef ${r}`);
        if (f.type !== 'map' && f.type !== 'title') problems.push(`${at}：${f.type} 字段上的 keyRef 走不到`);
      }
      if (f.of) see(at, f.of);
      if (f.items) see(at, f.items);
      if (f.value) see(at, [f.value]);
    }
  };
  for (const k of kinds) {
    if (!KIND_LINKS[k.id]) problems.push(`${k.id}：还没有写进 link-rules.ts 的 KIND_LINKS`);
    see(k.id, k.fields, true);
  }
  return problems;
}
