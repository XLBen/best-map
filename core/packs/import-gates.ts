import { type Arrange, RELATIONS, arrangeOf, linkTable as arrangeTable } from '../content/arrange';
import { DIMENSION } from '../content/link-rules';
import { type ContentRef, type Link, type LinkTable, linkKey, linkTable, linksOf, packScope, resolveLink, stripLinks } from '../content/links';
import { ITEM_ID } from '../content/refs';
import { type ContentKind, itemId, itemName, kindOf, registryVersion } from '../content/registry';
import { type Era, MAX_DIMENSIONS, worldEra, worldEras } from '../human/era';
import type { Faction } from '../human/government';
import { type PackNode, type PackWorld, type ResourcePack, canApply, packItems, packSections } from '../packs';
import { relationOf, restoredLinks, weightBack } from './import-relation';

export { type Relation, contentKey, finalized, relationOf, restoredLinks, weightBack } from './import-relation';

// 导入时一项能不能选（第六十四轮）：用户定的规则是“不能进来的一开始就灰着并写明原因，勾什么进什么”。闭包的写入在 closure.ts，这里是：
//
//   free     能选（differs：目的地有一份同 id、内容不同的，导入后并存）
//   have     已经有了：一模一样，或者是来源去掉了几条引用后的样子，而这些目标现在也没有
//   fixable  目的地这一份是来源去掉了几条引用后的样子，而有的目标现在有了：勾上补回，不改名成 -2。
//            文化组比重写 0（跟着文化来的）、来源不是 0：勾上也算补回（勾整组才参与生成）
//   gated    少了东西（needs）：派系主要靠的变量没有；政体列的派系有一个灰；“限谁用”全部落空（字段表写 dep: 'gate'）；去不掉的引用哪里都没有
//   full     放不下：这一种满了、变量满了、有问题的地名风格
//
// 勾选算进去：勾上的项和它带来的项算目的地已有，所以同一个窗口里勾变量能解开灰的项。算法是最小不动点：灰的项不往下走，
// 从只看目的地开始走一遍，把走到的算上再走，到不再变为止（解不开的环还是灰的，比如互相限定的两项都没勾）。
//
// 怎么走（walkClosure，importPreview 也用这一个）：
//   pick    勾的项
//   child   上级带下级：用库的 arrange 和融入表（core/content/arrange.ts 的 RELATIONS），和面板上看到的结构一样。没被 off 的都带；
//           变量带全部取值和取值组。跟着来的上级不带下级
//   follow  去不掉的引用（文化的组、取值的变量、脚本写到的）。只带这一项本身。文化组：因为勾了组里的文化才跟着来的（member）
//           比重和勾的组一样（第六十六轮，组里只有勾的文化，重新生成后看得到），别的跟着来的写 0。
//           取值要的变量只加变量本身，不带别的取值。目的地没有时代时带上提供这个变量的时代
// 别的引用不带：目的地有就留着，没有就去掉这一条（closure.ts 的 finalsOf）。
// 已经有了的项不再往下走（目的地那一份有它自己的依赖），它的下级照样走。
//
// 来源的表（infoOf）、比较用的字（contentKey）、目的地和来源的关系（relationOf，后两样在 import-relation.ts）都按对象记着，勾选变了只重走勾选带到的部分，
// 灰不灰用到时才算（ImportGates.of）。这个文件不引用内置的数据。

export type ImportTarget = { t: 'world'; world: PackWorld } | { t: 'pack'; pack: ResourcePack };

export interface ImportAsk {
  source: PackNode;
  target: ImportTarget;
  // 勾的项（kind 是内容种类的 id 或 'dimension'）
  picks: readonly ContentRef[];
  // 去掉的子项（勾了上级、单独去掉这一项）。去不掉的引用写在这里时，要它的项也进不来
  off?: readonly ContentRef[];
}

export interface ImportNeed {
  kind: string;
  id: string;
  name: string;
}

// any：needs 里有一个就行（限谁用）；否则都要
type Gated = { t: 'gated'; needs: ImportNeed[]; any: boolean; reason: string };
// 走的时候记的“进不来”（灰的、放不下的）；能不能一起勾上（resolvable）是 gatesOf 加的
export type Blocked = Gated | { t: 'full'; reason: string };

export type ImportGate =
  | { t: 'free'; differs?: boolean }
  | { t: 'have' }
  // restores：补回的引用写到的名字（只差比重时是空的）
  | { t: 'fixable'; restores: string[] }
  // resolvable（第六十六轮）：要的东西在这个来源里都勾得到（any 时有一个勾得到），点灰的行能把它们一起勾上。
  // choices：勾得到的那几个（any 时界面让用户选一个；不是 any 时 resolvable 就是 choices 等于 needs）
  | (Gated & { resolvable: boolean; choices: ImportNeed[] })
  | { t: 'full'; reason: string };

export interface ImportGates {
  of(ref: ContentRef): ImportGate;
  // 来源里每一项（和每个变量）：键是 linkKey(kind, id)
  all(): Map<string, ImportGate>;
}

export type ImportRole = 'pick' | 'child' | 'follow';

export const keyRef = (r: ContentRef) => linkKey(r.kind, r.id);
const refName = (r: ContentRef, item: unknown): string => {
  const k = kindOf(r.kind);
  return k ? itemName(k, item) : r.id;
};

// ---------- 来源的表（同一个包只算一遍） ----------

export interface DimInfo {
  label: string;
  owners: string[];
  values: string[];
  groups: string[];
}
interface ChildRef {
  kind: string;
  id: string;
}
export interface SourceInfo {
  version: number;
  table: LinkTable;
  dims: Map<string, DimInfo>;
  // 这一项下面有哪些（按库的 arrange）。kind 是 'dimension' 的是变量
  children: Map<string, ChildRef[]>;
  // 派系主要靠哪一维
  mainDims: Map<string, string | null>;
  // 有问题的项（地名风格）
  problems: Map<string, string | null>;
}

const infos = new WeakMap<object, SourceInfo>();
export function infoOf(source: PackNode): SourceInfo {
  const hit = infos.get(source);
  if (hit?.version === registryVersion()) return hit;
  const table = linkTable(packScope(source));
  const dims = new Map<string, DimInfo>();
  const dimOf = (id: string): DimInfo => {
    let d = dims.get(id);
    if (!d) dims.set(id, (d = { label: id, owners: [], values: [], groups: [] }));
    return d;
  };
  for (const e of packItems<Era>(source, 'eras')) {
    for (const d of e.dimensions) {
      const x = dimOf(d.id);
      if (!x.owners.length) x.label = d.label;
      x.owners.push(e.id);
    }
  }
  for (const v of packItems<{ id: string; dimension: string }>(source, 'popValues')) dimOf(v.dimension).values.push(v.id);
  for (const g of packItems<{ id: string; dimension: string }>(source, 'valueGroups')) dimOf(g.dimension).groups.push(g.id);
  const items = (id: string) => {
    const k = kindOf(id);
    return k ? packItems(source, k.pack.key) : [];
  };
  // 面板上的结构：这个库的 arrange（内置的库是预设），融入表写着怎么读
  const arrange: Arrange = arrangeOf(source as { arrange?: Arrange });
  const children: SourceInfo['children'] = new Map();
  for (const rel of RELATIONS) {
    if (arrange[rel.child] !== rel.parent) continue;
    const kind = rel.child === 'variables' ? DIMENSION : rel.child;
    for (const [parent, ids] of arrangeTable(rel, items).byParent) {
      const at = linkKey(rel.parent, parent);
      let list = children.get(at);
      if (!list) children.set(at, (list = []));
      for (const id of ids) list.push({ kind, id });
    }
  }
  const info: SourceInfo = { version: registryVersion(), table, dims, children, mainDims: new Map(), problems: new Map() };
  infos.set(source, info);
  return info;
}

// 来源库自己提供这个变量：它的时代写着、有取值（在这个库里勾得到）
const sourceHasDim = (info: SourceInfo, id: string): boolean => {
  const d = info.dims.get(id);
  return !!d && d.owners.length > 0 && d.values.length > 0;
};

// 这个派系主要靠哪一维：来源里权重（绝对值）加起来最大的那一维，一样大时写在前面的；“与国教”没写维度时是宗教（见 link-rules.ts）。
// 自由派写了民族认同（2.2）和意识形态（6），它要的是意识形态；民族认同那两条缺了就去掉。
// 只看来源库自己提供的变量（第六十五轮）：近现代库的派系写到意识形态，它的时代没有这个变量。这些写法在来源里本来就不起作用，
// 不算离不开它：目的地没有时和别的引用一样去掉这一条，目的地有时留着。否则会灰着要一个这个库里勾不到的变量
function mainDim(info: SourceInfo, key: string): string | null {
  const hit = info.mainDims.get(key);
  if (hit !== undefined) return hit;
  const sum = new Map<string, number>();
  for (const d of (info.table.nodes.get(key)?.item as Faction | undefined)?.drivers ?? []) {
    const dim = d.dimension ?? (d.faith ? 'religion' : undefined);
    if (dim && sourceHasDim(info, dim)) sum.set(dim, (sum.get(dim) ?? 0) + Math.abs(d.weight));
  }
  let best: string | null = null;
  for (const [dim, w] of sum) if (best === null || w > sum.get(best)!) best = dim;
  info.mainDims.set(key, best);
  return best;
}

// 有问题的项：加进世界时命令不会接受（地名风格的检查）
function problemOf(info: SourceInfo, key: string, kind: ContentKind, item: unknown): string | null {
  if (kind.id !== 'nameStyle' || !kind.check) return null;
  const hit = info.problems.get(key);
  if (hit !== undefined) return hit;
  let out: string | null = null;
  try {
    kind.check(item, undefined as never);
  } catch (e) {
    out = (e as Error).message;
  }
  info.problems.set(key, out);
  return out;
}

// ---------- 目的地 ----------

export interface Dest {
  world: boolean;
  items: Map<ContentKind, readonly unknown[]>;
  byId: Map<string, Map<string, unknown>>;
  kindsById: Map<string, ContentKind>;
  era: Era | undefined;
  // 要加到哪个时代：它有的变量
  dims: Set<string>;
  // 目的地全部时代提供的变量（别的时代写的也算找得到）
  allDims: Set<string>;
  kinds: ContentKind[];
  // 这一种最多几项
  cap(k: ContentKind): number;
}

export const targetEra = (t: ImportTarget): Era | undefined => (t.t === 'world' ? (worldEra(t.world.small) ?? worldEras(t.world.small)[0]) : packItems<Era>(t.pack, 'eras')[0]);

export function destOf(target: ImportTarget): Dest {
  const kinds = target.t === 'world' ? packSections().filter(canApply).sort((a, b) => a.order - b.order) : packSections();
  const items = new Map<ContentKind, readonly unknown[]>();
  const byId = new Map<string, Map<string, unknown>>();
  for (const k of kinds) {
    const list = target.t === 'world' ? k.inWorld(target.world) : packItems(target.pack, k.pack.key);
    items.set(k, list);
    byId.set(k.id, new Map(list.map((x) => [itemId(k, x), x])));
  }
  const era = targetEra(target);
  const eras = (target.t === 'world' ? worldEras(target.world.small) : packItems<Era>(target.pack, 'eras')) as readonly Era[];
  return {
    world: target.t === 'world',
    items,
    byId,
    kindsById: new Map(kinds.map((k) => [k.id, k])),
    era,
    dims: new Set(era?.dimensions.map((d) => d.id)),
    allDims: new Set(eras.flatMap((e) => e.dimensions.map((d) => d.id))),
    kinds,
    cap: (k) => (target.t === 'world' ? (k.maxInWorld ?? k.pack.max) : k.pack.max),
  };
}

export const destHas = (dest: Dest, kind: string, id: string): boolean => !!dest.byId.get(kind)?.has(id);

// ---------- 走 ----------

export interface ImportNode {
  ref: ContentRef;
  item: unknown;
  name: string;
  role: ImportRole;
  // “封建君主制 里的”“直隶人 要它”
  because: string[];
  // 清单里排在谁下面（linkKey）
  parent?: string;
  // 属于哪个变量（这个变量的取值、取值组）
  under?: string;
  // 文化组：因为勾了组里的文化（勾的、子项，写在 culture.group）才跟着来的。比重和勾的组一样（closure.ts 的 withWeight）
  member?: boolean;
}
export interface DimNode {
  id: string;
  label: string;
  role: ImportRole;
  because: string[];
  parent?: string;
  // 带全部取值
  all: boolean;
}
export interface Rejected {
  ref: ContentRef;
  name: string;
  role: ImportRole;
  gate: Blocked;
}
export interface Walked {
  reached: Map<string, ImportNode>;
  dims: Map<string, DimNode>;
  dimsFull: Set<string>;
  // 带来的时代提供的变量
  provided: Set<string>;
  // 走到了但进不来的（灰的、放不下的）
  rejected: Map<string, Rejected>;
  // 已经有了的：不往下走
  have: Set<string>;
}

export interface WalkCtx {
  info: SourceInfo;
  dest: Dest;
  off: Set<string>;
  picked: Set<string>;
  // 上一遍走到的（算灰不灰时算目的地已有）
  prev: Walked | null;
  // 灰不灰（这一遍）
  memo: Map<string, Blocked | null>;
  // 放不下的（closure.ts 按上限挑出来；键是 linkKey，变量也在）：原因
  over: Map<string, string>;
  // 另外认出来的“已经有了”（settleIds 认出的撞过名的）
  skip: ReadonlySet<string>;
}

export function walkCtx(ask: ImportAsk, info: SourceInfo, dest: Dest): WalkCtx {
  return { info, dest, off: new Set((ask.off ?? []).map(keyRef)), picked: new Set(ask.picks.map(keyRef)), prev: null, memo: new Map(), over: new Map(), skip: new Set() };
}

const isOff = (c: WalkCtx, key: string) => c.off.has(key) && !c.picked.has(key);

// 这条引用的目标有没有：目的地有，或者走到了。自定义场跟着内容自动加（名字合规就算有）
export function linkThere(c: Pick<WalkCtx, 'dest'>, w: Walked | null, link: Pick<Link, 'kinds' | 'id'>, blocked?: ReadonlyMap<string, string>): boolean {
  for (const kind of link.kinds) {
    if (kind === 'field' && ITEM_ID.test(link.id)) return true;
    if (kind === DIMENSION) {
      if (c.dest.allDims.has(link.id) || w?.dims.has(link.id) || w?.provided.has(link.id)) return true;
      continue;
    }
    const key = linkKey(kind, link.id);
    if ((w?.reached.has(key) && !blocked?.has(key)) || destHas(c.dest, kind, link.id)) return true;
  }
  return false;
}

// 派系主要靠的变量算不算有：要加到的那个时代有、这次会加。没有时代时带来的时代提供的也算
export const dimThere = (c: Pick<WalkCtx, 'dest'>, w: Walked | null, id: string): boolean => c.dest.dims.has(id) || !!w?.dims.has(id) || (!c.dest.era && !!w?.provided.has(id));

export interface Lacks {
  needs: ImportNeed[];
  any: boolean;
}

export const needText = ({ needs, any }: Lacks): string => {
  const names = [...new Set(needs.map((n) => n.name))];
  if (any) return `需要${names.slice(0, 3).join('或')}${names.length > 3 ? ' 等' : ''}`;
  return `需要${names.join('、')}`;
};
const gatedOf = (l: Lacks): Gated => ({ t: 'gated', needs: l.needs, any: l.any, reason: needText(l) });

// 派系主要靠的变量都是来源提供的（mainDim），都有名字。没有名字时不写 id：界面上不出现
const dimNeed = (info: SourceInfo, id: string): ImportNeed => ({ kind: DIMENSION, id, name: info.dims.get(id)?.label ?? '这个库没有的变量' });
function linkNeed(info: SourceInfo, l: Pick<Link, 'kinds' | 'id'>): ImportNeed {
  const to = resolveLink(info.table, l);
  if (to?.kind === DIMENSION) return dimNeed(info, to.id);
  return { kind: to?.kind ?? l.kinds[0], id: l.id, name: to ? refName(to, info.table.nodes.get(keyRef(to))?.item) : l.id };
}

export const linkNeedName = (info: SourceInfo, l: Pick<Link, 'kinds' | 'id'>): string => linkNeed(info, l).name;

// 灰的规则里和目的地、勾选有关的部分：派系的变量、政体的派系、“限谁用”。去不掉的引用另算（strongLacks）。
// 算写入（closure.ts 的 finalsOf）时也用这一个：写入时放不下了的目标可能让“限谁用”全部落空
export function softLacks(c: Pick<WalkCtx, 'info' | 'dest'>, key: string, kind: string, item: unknown, has: { dim(id: string): boolean; link(l: Link): boolean }): Lacks | null {
  const { info, dest } = c;
  if (kind === 'faction') {
    const d = mainDim(info, key);
    if (d && !has.dim(d)) return { needs: [dimNeed(info, d)], any: false };
  }
  if (kind === 'government') {
    // 列的派系有一个灰，整个政体灰。目的地有同 id 的派系时政体写到那一份，不看来源这一份
    const needs: ImportNeed[] = [];
    for (const f of (item as { factions?: string[] }).factions ?? []) {
      if (destHas(dest, 'faction', f)) continue;
      const d = mainDim(info, linkKey('faction', f));
      if (d && !has.dim(d)) needs.push(dimNeed(info, d));
    }
    if (needs.length) return { needs, any: false };
  }
  // 限谁用：去掉没有的目标后一条不剩才灰
  const links = info.table.out.get(key) ?? linksOf(kind, item);
  const lost = links.filter((l) => l.cls === 'gate' && !has.link(l));
  if (lost.length) {
    for (const field of new Set(lost.map((l) => String(l.path[0])))) {
      const out = stripLinks(kind, item, (l) => l.cls === 'gate' && l.path[0] === field && !has.link(l)) as Record<string, unknown>;
      const v = out[field];
      if (v === undefined || (Array.isArray(v) && !v.length)) return { needs: lost.filter((l) => l.path[0] === field).map((l) => linkNeed(info, l)), any: true };
    }
  }
  return null;
}

// 去不掉的引用：目的地有、来源里有（跟着带，它自己也不能灰）才行
function strongLacks(c: WalkCtx, key: string): Lacks | null {
  const { info, dest } = c;
  for (const l of info.table.out.get(key) ?? []) {
    if (l.drop || l.kinds.includes('field')) continue;
    if (l.kinds.includes(DIMENSION)) {
      // 目的地的时代写着，或者这次带来的时代写着
      if (dest.allDims.has(l.id) || c.prev?.provided.has(l.id)) continue;
      const d = info.dims.get(l.id);
      if (!d || (!dest.era && !d.owners.length)) return { needs: [dest.era ? dimNeed(info, l.id) : { kind: 'era', id: l.id, name: '时代' }], any: false };
      if (isOff(c, linkKey(DIMENSION, l.id))) return { needs: [dimNeed(info, l.id)], any: false };
      continue;
    }
    if (l.kinds.some((k) => destHas(dest, k, l.id))) continue;
    const to = resolveLink(info.table, l);
    if (!to || isOff(c, keyRef(to)) || !dest.kindsById.has(to.kind)) return { needs: [linkNeed(info, l)], any: false };
    const sub = rejectOf(c, keyRef(to));
    if (sub?.t === 'gated') return { needs: sub.needs, any: sub.any };
  }
  return null;
}

// 这一项灰不灰、有没有问题（不看放不下多少）。已经有了的不灰
export function rejectOf(c: WalkCtx, key: string): Blocked | null {
  const hit = c.memo.get(key);
  if (hit !== undefined) return hit;
  c.memo.set(key, null); // 脚本可能互相写到：走到自己算不灰
  const out = computeReject(c, key);
  c.memo.set(key, out);
  return out;
}

function computeReject(c: WalkCtx, key: string): Blocked | null {
  const { info, dest, prev } = c;
  const n = info.table.nodes.get(key);
  if (!n || n.owners) return null;
  const k = dest.kindsById.get(n.kind);
  if (!k) return { t: 'gated', needs: [], any: false, reason: dest.world ? '这一种不能用到世界' : '这一种放不进这个库' };
  const there = dest.byId.get(n.kind)?.get(n.id);
  if (there !== undefined && relationOf(k, n.item, there, dest.world).t !== 'differs') return null;
  const over = c.over.get(key);
  if (over) return { t: 'full', reason: over };
  const problem = problemOf(info, key, k, n.item);
  if (problem) return { t: 'full', reason: problem };
  const has = { dim: (id: string) => dimThere(c, prev, id), link: (l: Link) => linkThere(c, prev, l) };
  const lacks = softLacks(c, key, n.kind, n.item, has) ?? strongLacks(c, key);
  return lacks ? gatedOf(lacks) : null;
}

const RANK: Record<ImportRole, number> = { pick: 3, child: 2, follow: 1 };

function walkOnce(c: WalkCtx, picks: readonly ContentRef[]): Walked {
  const { info, dest } = c;
  const { table } = info;
  const w: Walked = { reached: new Map(), dims: new Map(), dimsFull: new Set(), provided: new Set(), rejected: new Map(), have: new Set() };
  const queue: ImportNode[] = [];

  const reach = (ref: ContentRef, role: ImportRole, because?: string, parent?: string, under?: string, member?: boolean): void => {
    const key = keyRef(ref);
    const cur = w.reached.get(key);
    if (cur) {
      if (because && !cur.because.includes(because)) cur.because.push(because);
      if (under && !cur.under) cur.under = under;
      if (member) cur.member = true;
      if (RANK[role] > RANK[cur.role]) {
        cur.role = role;
        if (parent) cur.parent = parent;
        queue.push(cur);
      }
      return;
    }
    const n = table.nodes.get(key);
    if (!n || n.owners) {
      if (role === 'pick') w.rejected.set(key, { ref, name: ref.id, role, gate: { t: 'gated', needs: [], any: false, reason: '来源里没有这一项' } });
      return;
    }
    const name = refName(ref, n.item);
    const gate = rejectOf(c, key);
    if (gate) {
      const old = w.rejected.get(key);
      if (!old || RANK[role] > RANK[old.role]) w.rejected.set(key, { ref, name, role, gate });
      return;
    }
    const node: ImportNode = { ref: { kind: ref.kind, id: ref.id }, item: n.item, name, role, because: because ? [because] : [], ...(parent ? { parent } : {}), ...(under ? { under } : {}), ...(member ? { member } : {}) };
    w.reached.set(key, node);
    queue.push(node);
    if (ref.kind === 'era') for (const d of (n.item as Era).dimensions) w.provided.add(d.id);
  };

  const members = (id: string, d: DimInfo) => {
    const because = `${d.label} 里的`;
    const key = linkKey(DIMENSION, id);
    for (const g of d.groups) if (!isOff(c, linkKey('valueGroup', g))) reach({ kind: 'valueGroup', id: g }, 'child', because, key, id);
    for (const v of d.values) if (!isOff(c, linkKey('popValue', v))) reach({ kind: 'popValue', id: v }, 'child', because, key, id);
  };

  // 勾变量带全部取值和组（all）；取值要变量时只加变量（only）
  const requireDim = (id: string, role: ImportRole, mode: 'all' | 'only', because?: string, parent?: string): void => {
    const d = info.dims.get(id);
    const key = linkKey(DIMENSION, id);
    if (!d?.values.length) {
      if (role === 'pick' && !dest.dims.has(id)) w.rejected.set(key, { ref: { kind: DIMENSION, id }, name: d?.label ?? id, role, gate: { t: 'gated', needs: [], any: false, reason: d ? '这个变量没有取值' : '来源里没有这个变量' } });
      return;
    }
    if (dest.dims.has(id) || isOff(c, key)) return;
    if (c.over.has(key)) {
      w.dimsFull.add(id);
      return;
    }
    const cur = w.dims.get(id);
    if (cur) {
      if (because && !cur.because.includes(because)) cur.because.push(because);
      if (RANK[role] > RANK[cur.role]) cur.role = role;
      if (mode === 'all' && !cur.all) {
        cur.all = true;
        members(id, d);
      }
      return;
    }
    if (dest.era && dest.dims.size + w.dims.size >= MAX_DIMENSIONS) {
      w.dimsFull.add(id);
      return;
    }
    // 目的地没有时代：带上提供它的时代
    if (!dest.era) {
      const owner = d.owners[0];
      if (!owner) return;
      const ref = { kind: 'era', id: owner };
      if (isOff(c, keyRef(ref))) return;
      reach(ref, 'follow', `${d.label} 写在这个时代里`);
      if (!w.reached.has(keyRef(ref))) return;
    }
    w.dims.set(id, { id, label: d.label, role, because: because ? [because] : [], ...(parent ? { parent } : {}), all: mode === 'all' });
    if (mode === 'all') members(id, d);
  };

  for (const p of picks) {
    if (p.kind === DIMENSION) requireDim(p.id, 'pick', 'all');
    else reach(p, 'pick');
  }

  while (queue.length) {
    const cur = queue.pop()!;
    const key = keyRef(cur.ref);
    // 下级：勾的和子项才带（已经有了也一样），跟着来的不带
    if (cur.role !== 'follow') {
      for (const ch of info.children.get(key) ?? []) {
        const because = `${cur.name} 里的`;
        if (ch.kind === DIMENSION) requireDim(ch.id, 'child', 'all', because, key);
        else if (!isOff(c, linkKey(ch.kind, ch.id))) reach({ kind: ch.kind, id: ch.id }, 'child', because, key);
      }
    }
    if (c.skip.has(key)) continue;
    const k = dest.kindsById.get(cur.ref.kind);
    const there = dest.byId.get(cur.ref.kind)?.get(cur.ref.id);
    if (k && there !== undefined && relationOf(k, cur.item, there, dest.world).t !== 'differs') {
      w.have.add(key);
      continue;
    }
    // 去不掉的引用跟着带（这一项本身）
    for (const link of table.out.get(key) ?? []) {
      if (link.drop || link.kinds.includes('field')) continue;
      const because = `${cur.name} 要它`;
      if (link.kinds.includes(DIMENSION)) {
        requireDim(link.id, 'follow', 'only', because);
        continue;
      }
      const to = resolveLink(table, link);
      // 勾的文化（和子项）带来的组：组里只有勾的文化，比重照勾的组写（第六十六轮）
      const member = to?.kind === 'cultureGroup' && cur.ref.kind === 'culture' && cur.role !== 'follow' && link.path[0] === 'group';
      if (to && !isOff(c, keyRef(to))) reach(to, 'follow', because, undefined, undefined, member);
    }
  }
  return w;
}

// 最小不动点：灰的项不走，走到的算上再走一遍。勾选变了从头走，只走勾选带到的部分
export function walkClosure(c: WalkCtx, picks: readonly ContentRef[]): Walked {
  c.prev = null;
  c.memo.clear();
  let w = walkOnce(c, picks);
  for (let round = 0; round < 16 && w.rejected.size; round++) {
    c.prev = w;
    c.memo.clear();
    const next = walkOnce(c, picks);
    const stable = next.reached.size === w.reached.size && next.dims.size === w.dims.size;
    w = next;
    if (stable) break;
  }
  c.prev = w;
  c.memo.clear();
  return w;
}

// ---------- 能不能选 ----------

const FULL_DIMS = `一个时代最多 ${MAX_DIMENSIONS} 个变量`;
type Raw = Exclude<ImportGate, { t: 'gated' }> | Gated;
const fullText = (k: ContentKind, cap: number) => `${k.label}最多 ${cap} 个`;

// 走完之后每一项的状态。c.prev 是走到的（walkClosure 留着）
export function gatesOf(c: WalkCtx, w: Walked, source: PackNode): ImportGates {
  const { info, dest } = c;
  const memo = new Map<string, ImportGate>();
  const has = (l: Pick<Link, 'kinds' | 'id'>) => linkThere(c, w, l);

  // 每一种新加多少：走到的、目的地没有同一项的
  let overflow: { over: Set<string>; room: Map<string, number> } | null = null;
  const room = () => {
    if (overflow) return overflow;
    const used = new Map<string, number>();
    const over = new Set<string>();
    for (const [key, n] of w.reached) {
      const k = dest.kindsById.get(n.ref.kind);
      if (!k) continue;
      const there = dest.byId.get(n.ref.kind)?.get(n.ref.id);
      if (there !== undefined && relationOf(k, n.item, there, dest.world).t !== 'differs') continue;
      const u = (used.get(k.id) ?? 0) + 1;
      used.set(k.id, u);
      if (dest.items.get(k)!.length + u > dest.cap(k)) over.add(key);
    }
    const left = new Map(dest.kinds.map((k) => [k.id, dest.cap(k) - dest.items.get(k)!.length - (used.get(k.id) ?? 0)]));
    return (overflow = { over, room: left });
  };
  const dimFull = (id: string): boolean => !dest.dims.has(id) && !w.dims.has(id) && (c.over.has(linkKey(DIMENSION, id)) || (!!dest.era && dest.dims.size + w.dims.size >= MAX_DIMENSIONS));

  const compute = (ref: ContentRef): Raw => {
    if (ref.kind === DIMENSION) {
      const d = info.dims.get(ref.id);
      if (dest.dims.has(ref.id)) return { t: 'have' };
      if (!d) return { t: 'gated', needs: [], any: false, reason: '来源里没有这个变量' };
      if (!d.values.length) return { t: 'gated', needs: [], any: false, reason: '这个变量没有取值' };
      if (w.dims.has(ref.id)) return { t: 'free' };
      if (dimFull(ref.id)) return { t: 'full', reason: FULL_DIMS };
      if (!dest.era && !d.owners.length) return { t: 'gated', needs: [{ kind: 'era', id: ref.id, name: '时代' }], any: false, reason: '需要时代' };
      return { t: 'free' };
    }
    const key = keyRef(ref);
    const n = info.table.nodes.get(key);
    if (!n || n.owners) return { t: 'gated', needs: [], any: false, reason: '来源里没有这一项' };
    const k = dest.kindsById.get(n.kind);
    if (!k) return { t: 'gated', needs: [], any: false, reason: dest.world ? '这一种不能用到世界' : '这一种放不进这个库' };
    const there = dest.byId.get(n.kind)?.get(n.id);
    const rel = there !== undefined ? relationOf(k, n.item, there, dest.world) : null;
    if (rel && rel.t !== 'differs') {
      const restores = restoredLinks(k, n.item, there, rel, has).map((l) => linkNeed(info, l).name);
      return restores.length || weightBack(k, n.item, there) ? { t: 'fixable', restores: [...new Set(restores)] } : { t: 'have' };
    }
    const gate = rejectOf(c, key);
    if (gate) return gate;
    // 放不下
    const r = room();
    if (r.over.has(key) || (!w.reached.has(key) && r.room.get(k.id)! <= 0)) return { t: 'full', reason: fullText(k, dest.cap(k)) };
    if (!w.reached.has(key)) {
      for (const l of info.table.out.get(key) ?? []) {
        if (l.drop || l.kinds.includes('field')) continue;
        if (l.kinds.includes(DIMENSION)) {
          if (dimFull(l.id)) return { t: 'full', reason: FULL_DIMS };
          continue;
        }
        const to = resolveLink(info.table, l);
        const tk = to && dest.kindsById.get(to.kind);
        if (to && tk && !destHas(dest, to.kind, to.id) && !w.reached.has(keyRef(to)) && r.room.get(tk.id)! <= 0) return { t: 'full', reason: fullText(tk, dest.cap(tk)) };
      }
    } else if (n.kind === 'popValue' || n.kind === 'valueGroup') {
      const dim = String((n.item as { dimension?: unknown }).dimension);
      if (dimFull(dim) && !dest.allDims.has(dim) && !w.provided.has(dim)) return { t: 'full', reason: FULL_DIMS };
    }
    return there !== undefined ? { t: 'free', differs: true } : { t: 'free' };
  };

  // 点灰的行能不能把要的一起勾上（第六十六轮）：要的东西在这个来源里勾得到。变量要有取值（目的地没有时代时还要来源的时代写着它）、
  // 放得下；内容要在来源里、能用到目的地，它自己能选（它也灰着时看它要的勾不勾得到）。“需要时代”（目的地和来源都没有时代写它）勾不到
  const resolving = new Set<string>();
  const needOk = (n: ImportNeed): boolean => {
    if (n.kind === DIMENSION) {
      const d = info.dims.get(n.id);
      return !!d && d.values.length > 0 && (!!dest.era || d.owners.length > 0) && !dimFull(n.id);
    }
    const key = linkKey(n.kind, n.id);
    const node = info.table.nodes.get(key);
    if (!node || node.owners || !dest.kindsById.has(n.kind) || resolving.has(key)) return false;
    resolving.add(key);
    try {
      const g = of(n);
      return g.t === 'free' || g.t === 'fixable' || (g.t === 'gated' && g.resolvable);
    } finally {
      resolving.delete(key);
    }
  };
  const decorate = (g: Raw): ImportGate => {
    if (g.t !== 'gated') return g;
    const seen = new Set<string>();
    const choices = g.needs.filter((n) => {
      const key = linkKey(n.kind, n.id);
      if (seen.has(key)) return false;
      seen.add(key);
      return needOk(n);
    });
    const resolvable = g.needs.length > 0 && (g.any ? choices.length > 0 : choices.length === seen.size);
    return { ...g, resolvable, choices };
  };

  const of = (ref: ContentRef): ImportGate => {
    const key = keyRef(ref);
    let g = memo.get(key);
    if (!g) memo.set(key, (g = decorate(compute(ref))));
    return g;
  };

  return {
    of,
    all: () => {
      const out = new Map<string, ImportGate>();
      for (const id of info.dims.keys()) out.set(linkKey(DIMENSION, id), of({ kind: DIMENSION, id }));
      for (const k of packSections()) {
        for (const x of packItems(source, k.pack.key)) {
          const id = itemId(k, x);
          out.set(linkKey(k.id, id), of({ kind: k.id, id }));
        }
      }
      return out;
    },
  };
}

// 每一项能不能选。picks：现在勾着的（勾上的算目的地已有）；off：去掉的子项
export function importGates(source: PackNode, target: ImportTarget, picks: readonly ContentRef[] = [], off: readonly ContentRef[] = []): ImportGates {
  const ask: ImportAsk = { source, target, picks, off };
  const c = walkCtx(ask, infoOf(source), destOf(target));
  return gatesOf(c, walkClosure(c, picks), source);
}
