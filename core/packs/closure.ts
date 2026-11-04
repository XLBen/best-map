import type { Command } from '../commands';
import { type ArrangeRelation, linkTable as arrangeTable, relationOf } from '../content/arrange';
import { DIMENSION } from '../content/link-rules';
import { type ContentRef, type Link, type LinkTable, linkKey, linkTable, packScope, resolveLink, stripLinks } from '../content/links';
import { ITEM_ID, stableJson } from '../content/refs';
import { type ContentKind, type Renames, enableCommand, itemId, itemName, kindOf, registryVersion } from '../content/registry';
import { type Dimension, type Era, MAX_DIMENSIONS, worldEra, worldEras } from '../human/era';
import type { Faction } from '../human/government';
import { type PackNode, type PackPicks, type PackPlan, type PackWorld, type ResourcePack, canApply, finalItem, ownItems, packItems, packSections, planPack, renamedItem, settleIds, subPacks, walkPacks } from '../packs';
import { importIntoPack } from './import';

// 导入的依赖闭包（第六十一轮）：从一个库勾几项导入本世界或我的库，算“还会带上”的项（每一项写为什么）、“已经有了”“会改名”、哪些引用要去掉。
// 引用从第四十九轮的表来（core/content/links.ts），这里不另写一份“谁引用谁”。窗口、列表上的“添加”“全部添加”都走这一个函数。
//
//   hard    默认带上。去不掉的引用（文化的组、脚本里写的）不能取消，去得掉的取消后去掉这条引用
//   auto    默认带上，可以取消：取消后去掉这条引用（限谁用就解除了限制）
//   strip   不带。目的地有目标（同 id）时留着，没有时去掉，所以政体的换说法不会拖来一堆文化组
//   member  勾了文化组时组里的文化、勾了取值组时组里的取值（这是“组里有什么”，不是依赖；依赖带来的组不带它们）
//
// 变量（维度）不是一项内容：写在目的地的时代里，取值、取值组是它的一部分，带它就一起带。世界里走 add_dimension（只算新变量），库里写进时代。
// 什么算要变量：hard、auto 的引用；派系主要靠的那一维（NEEDS）。别的 strip 引用写到的变量列在 optional，默认不勾，可以勾上。
// 目的地没有时代时带上来源里提供这个变量的时代。
//
// 依赖带来的文化组 weight 写 0，不参与生成；点名勾的组比重是 0 时去掉这个 0（用户就是要它参与，和 packImportPlan 一样）。
// 是不是同一项（已经有了）、撞名改名、引用跟着改都由 settleIds 算（第四十九轮）：比较的是导入时的样子（去掉引用、写了 weight 之后），
// 所以同样的勾选再导入一次全部“已经有了”。“已经有了”的项不再往下走（目的地那一份有它自己的依赖）。
// 目的地的安排（arrange）不动，来源的不带。

export type ImportTarget = { t: 'world'; world: PackWorld } | { t: 'pack'; pack: ResourcePack };

export interface ImportAsk {
  source: PackNode;
  target: ImportTarget;
  // 勾的项（kind 是内容种类的 id 或 'dimension'）
  picks: readonly ContentRef[];
  // 取消的依赖
  off?: readonly ContentRef[];
  // 勾上的可选的变量
  on?: readonly ContentRef[];
}

export type ImportClass = 'pick' | 'hard' | 'auto' | 'member' | 'optional';
export type ImportState = 'new' | 'have' | 'rename' | 'blocked' | 'off';

export interface ImportRow {
  kind: string;
  id: string;
  name: string;
  // “政体”“变量”
  kindLabel: string;
  cls: ImportClass;
  state: ImportState;
  // 为什么：“社会主义共和国 需要 革命左翼”，最多三句，whyMore 是还有几句
  why: string[];
  whyMore: number;
  // 在目的地叫什么（改了名的、已经有了但名字不同的）
  to?: string;
  // 不能取消：原因
  locked?: string;
  // 取消后会怎样
  offNote?: string;
  // 属于哪个变量（这个变量的取值、取值组，窗口里不单独列）
  under?: string;
  // 变量：几种取值
  count?: number;
}

export interface ImportStrip {
  from: ContentRef;
  fromName: string;
  label: string;
  target: string;
}

export interface ImportPreview {
  picks: ImportRow[];
  // 还会带上（含取消了的，state 是 off）
  bring: ImportRow[];
  // 还可以带上（默认不勾的变量）
  optional: ImportRow[];
  // 已经有了（勾的、依赖的）
  have: ImportRow[];
  // 会改名
  renamed: ImportRow[];
  // 带不了（少了去不掉的引用）
  blocked: ImportRow[];
  // 去掉的引用
  stripped: ImportStrip[];
  // 放不下：有这个时不能导入
  over: string[];
  // 要加的变量（目的地的时代里）
  dims: Dimension[];
  // 真的加几项（新的、改名的；变量算一项，它的取值不另算）
  count: number;
  // 写入用
  plan: SettledPlan;
}

interface SettledPlan {
  finals: Map<ContentKind, unknown[]>;
  ids: Map<string, string>;
  renames: Renames;
  era?: Era;
}

// 这一项靠哪个变量才有意义：写到它的 strip 类引用在导入时按 auto 算。这里只说派系（写在这里，不进计算 Worker）：
// 主要靠哪一维是来源里权重（绝对值）加起来最大的那一维，一样大时写在前面的；“与国教”没写维度时是宗教（见 link-rules.ts）。
// 自由派写了民族认同（2.2）和意识形态（6），它要的是意识形态；民族认同那两条缺了就去掉，不再多拖一个变量进来
const NEEDS: Readonly<Record<string, (item: unknown) => string[]>> = {
  faction: (item) => {
    const sum = new Map<string, number>();
    for (const d of (item as Faction).drivers ?? []) {
      const dim = d.dimension ?? (d.faith ? 'religion' : undefined);
      if (dim) sum.set(dim, (sum.get(dim) ?? 0) + Math.abs(d.weight));
    }
    let best: string | null = null;
    for (const [dim, w] of sum) if (best === null || w > sum.get(best)!) best = dim;
    return best === null ? [] : [best];
  },
};

// 取消一条依赖会怎样（窗口里写这一句）：种类 → 顶层字段。没写的是 GENERIC_OFF
const OFF_NOTES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  government: { factions: '取消后，这个政体没有这个派系', only: '取消后解除这条限制，谁都能用' },
  faction: { drivers: '取消后去掉这条来源' },
  landmarkType: { cultureGroups: '取消后不再限这一组' },
  pointType: { actsAsCity: '取消后这种点不当作城市' },
  riverType: { biomes: '取消后不再限这种生态' },
  lakeType: { biomes: '取消后不再限这种生态' },
  cultureGroup: { nameStyle: '取消后用世界默认的地名风格' },
  culture: { nameStyle: '取消后用世界默认的地名风格' },
  terrainClass: { rules: '取消后去掉这条规则' },
  resource: { rules: '取消后去掉这条规则' },
  countryLayout: { weights: '取消后这种格局里没有这一等级' },
};

// ---------- 来源的表（同一个包只算一遍） ----------

interface DimInfo {
  label: string;
  owners: string[];
  values: string[];
  groups: string[];
}
interface SourceInfo {
  version: number;
  table: LinkTable;
  dims: Map<string, DimInfo>;
  members: Map<string, { kind: string; ids: readonly string[] }>;
}

const infos = new WeakMap<object, SourceInfo>();
function infoOf(source: PackNode): SourceInfo {
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
  // 组里有什么：融入的表里写着（core/content/arrange.ts）
  const members: SourceInfo['members'] = new Map();
  for (const [parent, rel] of [['cultureGroup', relationOf('culture', 'cultureGroup')], ['valueGroup', relationOf('popValue', 'valueGroup')]] as [string, ArrangeRelation][]) {
    for (const [id, ids] of arrangeTable(rel, items).byParent) members.set(linkKey(parent, id), { kind: rel.child, ids });
  }
  const info = { version: registryVersion(), table, dims, members };
  infos.set(source, info);
  return info;
}

// ---------- 目的地 ----------

interface Dest {
  items: Map<ContentKind, readonly unknown[]>;
  byId: Map<string, Map<string, unknown>>;
  era: Era | undefined;
  // 要加到哪个时代：它有的变量
  dims: Set<string>;
  // 目的地全部时代提供的变量（别的时代写的也算找得到）
  allDims: Set<string>;
  kinds: ContentKind[];
}

export const targetEra = (t: ImportTarget): Era | undefined => (t.t === 'world' ? (worldEra(t.world.small) ?? worldEras(t.world.small)[0]) : packItems<Era>(t.pack, 'eras')[0]);

function destOf(target: ImportTarget): Dest {
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
  return { items, byId, era, dims: new Set(era?.dimensions.map((d) => d.id)), allDims: new Set(eras.flatMap((e) => e.dimensions.map((d) => d.id))), kinds };
}

// ---------- 走依赖 ----------

interface Why {
  from: ContentRef;
  fromName: string;
  link?: Link;
  text: string;
}
interface Node {
  ref: ContentRef;
  item: unknown;
  name: string;
  cls: ImportClass;
  why: Why[];
  under?: string;
}
interface DimNode {
  id: string;
  label: string;
  cls: ImportClass;
  why: Why[];
}

const RANK: Record<ImportClass, number> = { pick: 4, hard: 3, member: 2, auto: 1, optional: 0 };
const keyRef = (r: ContentRef) => linkKey(r.kind, r.id);
const refName = (r: ContentRef, item: unknown): string => {
  const k = kindOf(r.kind);
  return k ? itemName(k, item) : r.id;
};

interface Walked {
  reached: Map<string, Node>;
  dims: Map<string, DimNode>;
  offRows: Map<string, Node>;
  optional: Map<string, DimNode>;
  dimsFull: Set<string>;
}

function walk(info: SourceInfo, ask: ImportAsk, dest: Dest, skip: ReadonlySet<string>): Walked {
  const { table } = info;
  const off = new Set((ask.off ?? []).map(keyRef));
  const on = new Set((ask.on ?? []).map(keyRef));
  const picked = new Set(ask.picks.map(keyRef));
  const reached = new Map<string, Node>();
  const dims = new Map<string, DimNode>();
  const offRows = new Map<string, Node>();
  const optional = new Map<string, DimNode>();
  const dimsFull = new Set<string>();
  const queue: Node[] = [];

  const addWhy = (list: Why[], w: Why | undefined) => {
    if (w && !list.some((x) => x.text === w.text)) list.push(w);
  };
  const nodeOf = (ref: ContentRef) => table.nodes.get(keyRef(ref));
  const reach = (ref: ContentRef, cls: ImportClass, why?: Why, under?: string): void => {
    const key = keyRef(ref);
    const cur = reached.get(key);
    if (cur) {
      addWhy(cur.why, why);
      if (under && !cur.under) cur.under = under;
      if (RANK[cls] > RANK[cur.cls]) {
        cur.cls = cls;
        queue.push(cur);
      }
      return;
    }
    const n = nodeOf(ref);
    if (!n || n.owners) return;
    const node: Node = { ref: { kind: ref.kind, id: ref.id }, item: n.item, name: refName(ref, n.item), cls, why: why ? [why] : [], ...(under ? { under } : {}) };
    reached.set(key, node);
    queue.push(node);
  };
  const recordOff = (ref: ContentRef, why: Why | undefined) => {
    const key = keyRef(ref);
    const cur = offRows.get(key);
    if (cur) return addWhy(cur.why, why);
    const n = nodeOf(ref);
    if (n) offRows.set(key, { ref, item: n.item, name: ref.kind === DIMENSION ? (info.dims.get(ref.id)?.label ?? ref.id) : refName(ref, n.item), cls: 'auto', why: why ? [why] : [] });
  };
  const requireDim = (id: string, cls: ImportClass, why?: Why): void => {
    const d = info.dims.get(id);
    if (!d?.values.length || dest.dims.has(id)) return;
    const key = linkKey(DIMENSION, id);
    if (off.has(key) && !picked.has(key)) return recordOff({ kind: DIMENSION, id }, why);
    const cur = dims.get(id);
    if (cur) {
      addWhy(cur.why, why);
      if (RANK[cls] > RANK[cur.cls]) cur.cls = cls;
      return;
    }
    if (dest.era && dest.dims.size + dims.size >= MAX_DIMENSIONS) {
      dimsFull.add(id);
      return;
    }
    // 目的地没有时代：带上提供它的时代
    if (!dest.era) {
      const owner = d.owners[0];
      if (!owner) return;
      const ref = { kind: 'era', id: owner };
      if (off.has(keyRef(ref)) && !picked.has(keyRef(ref))) return recordOff(ref, why && { ...why, text: `${d.label} 写在这个时代里` });
      const eraNode = nodeOf(ref);
      reach(ref, 'hard', { from: { kind: DIMENSION, id }, fromName: d.label, text: `${d.label} 写在 ${eraNode ? refName(ref, eraNode.item) : owner} 里` });
    }
    dims.set(id, { id, label: d.label, cls, why: why ? [why] : [] });
    const memberWhy = (name: string): Why => ({ from: { kind: DIMENSION, id }, fromName: d.label, text: `${name}属于 ${d.label}` });
    for (const g of d.groups) reach({ kind: 'valueGroup', id: g }, 'member', memberWhy('取值组'), id);
    for (const v of d.values) reach({ kind: 'popValue', id: v }, 'member', memberWhy('取值'), id);
  };

  for (const p of ask.picks) {
    if (p.kind === DIMENSION) requireDim(p.id, 'pick');
    else reach(p, 'pick');
  }
  for (const r of ask.on ?? []) if (r.kind === DIMENSION) requireDim(r.id, 'auto');

  while (queue.length) {
    const cur = queue.pop()!;
    const key = keyRef(cur.ref);
    // 勾了组：组里有什么一起带（组已经有了也一样，依赖带来的组不带）
    if (cur.cls === 'pick') {
      const m = info.members.get(key);
      if (m) {
        for (const id of m.ids) {
          const ref = { kind: m.kind, id };
          if (off.has(keyRef(ref)) && !picked.has(keyRef(ref))) recordOff(ref, { from: cur.ref, fromName: cur.name, text: `${cur.name} 里的` });
          else reach(ref, 'member', { from: cur.ref, fromName: cur.name, text: `${cur.name} 里的` });
        }
      }
    }
    if (skip.has(key)) continue;
    const needs = NEEDS[cur.ref.kind]?.(cur.item);
    for (const link of table.out.get(key) ?? []) {
      if (link.kinds.includes('field')) continue;
      const to = resolveLink(table, link);
      const promoted = link.cls === 'strip' && !!needs?.length && (link.kinds.includes(DIMENSION) ? needs.includes(link.id) : link.kinds.includes('popValue') && !!to && needs.includes(String((table.nodes.get(keyRef(to))?.item as { dimension?: unknown } | undefined)?.dimension)));
      const cls = promoted ? 'auto' : link.cls;
      const strong = cls === 'hard' && RANK[cur.cls] >= RANK.member;
      const childCls: ImportClass = strong ? 'hard' : 'auto';
      if (link.kinds.includes(DIMENSION)) {
        if (cur.under === link.id || dest.dims.has(link.id) || !info.dims.get(link.id)?.values.length) continue;
        const d = info.dims.get(link.id)!;
        const why: Why = { from: cur.ref, fromName: cur.name, link, text: `${cur.name} ${cls === 'strip' ? '写到' : '需要'} ${d.label}` };
        if (cls !== 'strip') requireDim(link.id, childCls, why);
        else if (on.has(linkKey(DIMENSION, link.id))) requireDim(link.id, 'auto', why);
        else {
          const o = optional.get(link.id);
          if (o) addWhy(o.why, why);
          else optional.set(link.id, { id: link.id, label: d.label, cls: 'optional', why: [why] });
        }
        continue;
      }
      if (cls === 'strip' || !to) continue;
      // 这个取值的变量取消了：不用再看它（这条来源去掉）
      if (promoted && !link.kinds.includes(DIMENSION)) {
        const dim = String((table.nodes.get(keyRef(to))?.item as { dimension?: unknown } | undefined)?.dimension);
        if (!dest.dims.has(dim) && off.has(linkKey(DIMENSION, dim)) && !picked.has(linkKey(DIMENSION, dim))) continue;
      }
      const why: Why = { from: cur.ref, fromName: cur.name, link, text: `${cur.name} 需要 ${refName(to, table.nodes.get(keyRef(to))?.item)}` };
      if (off.has(keyRef(to)) && !picked.has(keyRef(to))) recordOff(to, why);
      else reach(to, childCls, why);
    }
  }
  return { reached, dims, offRows, optional, dimsFull };
}

// ---------- 导入时的样子 ----------

function destHas(dest: Dest, kind: string, id: string): boolean {
  return !!dest.byId.get(kind)?.has(id);
}

// 比较用的字（同 sameContent，按对象记着）：包和世界里的项都是不改动的数据，勾选每变一次都要比，一个库的地名风格就有约 1 MB
const contentKeys = new WeakMap<object, string>();
function contentKey(k: ContentKind, x: unknown): string {
  let s = contentKeys.get(x as object);
  if (s === undefined) {
    const skip = k.pack.sameIgnore;
    s = stableJson(skip?.length ? Object.fromEntries(Object.entries(x as object).filter(([key]) => !skip.includes(key))) : x);
    contentKeys.set(x as object, s);
  }
  return s;
}

// 去掉引用后的样子（去掉的一样时给同一个对象，比较时不用再算一遍）
const stripMemo = new WeakMap<object, { sig: string; out: unknown }>();
function strippedItem(kind: string, item: unknown, gone: readonly Link[], pick: (l: Link) => boolean): unknown {
  const sig = gone.map((l) => JSON.stringify(l.path)).join();
  const hit = stripMemo.get(item as object);
  if (hit?.sig === sig) return hit.out;
  const out = stripLinks(kind, item, pick);
  stripMemo.set(item as object, { sig, out });
  return out;
}

// 加进世界的最后一步之后的样子（同一项给同一个对象）
const finalMemo = new WeakMap<object, unknown>();
function finalized(k: ContentKind, x: unknown): unknown {
  if (!k.pack.finalize) return x;
  let f = finalMemo.get(x as object);
  if (f === undefined) finalMemo.set(x as object, (f = k.pack.finalize(x)));
  return f;
}

const withWeight = (n: Node, item: unknown): unknown => {
  if (n.ref.kind !== 'cultureGroup') return item;
  const g = item as { weight?: number };
  if (n.cls !== 'pick') return g.weight === 0 ? item : { ...g, weight: 0 };
  if (g.weight !== 0) return item;
  const { weight: _, ...rest } = g;
  return rest;
};

interface Finals {
  items: Map<string, unknown>;
  blocked: Map<string, string>;
  stripped: ImportStrip[];
  avail: (link: Pick<Link, 'kinds' | 'id'>) => boolean;
}

function finalsOf(w: Walked, dest: Dest, skip: ReadonlySet<string>, table: LinkTable): Finals {
  const blocked = new Map<string, string>();
  const provided = new Set<string>();
  for (const n of w.reached.values()) if (n.ref.kind === 'era') for (const d of (n.item as Era).dimensions) provided.add(d.id);
  const avail = (link: Pick<Link, 'kinds' | 'id'>): boolean => {
    for (const kind of link.kinds) {
      if (kind === 'field' && ITEM_ID.test(link.id)) return true;
      if (kind === DIMENSION) {
        if (dest.allDims.has(link.id) || w.dims.has(link.id) || provided.has(link.id)) return true;
        continue;
      }
      const key = linkKey(kind, link.id);
      if ((w.reached.has(key) && !blocked.has(key)) || destHas(dest, kind, link.id)) return true;
    }
    return false;
  };
  // 去不掉的引用找不到目标：这一项带不了；写到它的再看一遍
  for (let changed = true; changed; ) {
    changed = false;
    for (const key of w.reached.keys()) {
      if (blocked.has(key) || skip.has(key)) continue;
      const bad = (table.out.get(key) ?? []).find((l) => !l.drop && !avail(l));
      if (bad) {
        blocked.set(key, `少了${bad.label}“${bad.id}”`);
        changed = true;
      }
    }
  }
  const items = new Map<string, unknown>();
  const stripped: ImportStrip[] = [];
  for (const [key, n] of w.reached) {
    if (blocked.has(key) || skip.has(key)) continue;
    const links = table.out.get(key) ?? [];
    const gone = links.filter((l) => l.drop && !avail(l));
    // 去掉的一处说一次（派系的一条来源写了变量和取值，是一处）：写具体的那个（取值，不是变量）
    const told = new Map<string, Link>();
    for (const l of gone) {
      const at = JSON.stringify(l.drop);
      if (!told.has(at) || l.kinds.includes(DIMENSION) === false) told.set(at, l);
    }
    for (const l of told.values()) {
      const to = resolveLink(table, l);
      const name = !to ? l.id : to.kind === DIMENSION ? l.id : refName(to, table.nodes.get(keyRef(to))?.item);
      stripped.push({ from: n.ref, fromName: n.name, label: fieldLabel(n.ref.kind, l), target: name });
    }
    items.set(key, withWeight(n, gone.length ? strippedItem(n.ref.kind, n.item, gone, (l) => !avail(l)) : n.item));
  }
  return { items, blocked, stripped, avail };
}

// 引用所在的那个顶层字段
const topField = (kind: string, link: Link) => kindOf(kind)?.fields.find((f) => f.key === link.path[0]);
const fieldLabel = (kind: string, link: Link): string => topField(kind, link)?.label ?? link.label;

// ---------- 闭包 ----------

const GENERIC_OFF = '取消后去掉这条引用';

function rowOf(n: Pick<Node, 'ref' | 'name' | 'cls' | 'why' | 'under'>, state: ImportState, to: string | undefined, skipLock: boolean): ImportRow {
  const k = kindOf(n.ref.kind);
  const firsts = n.why.slice(0, 3).map((w) => w.text);
  // 取消后会怎样：引用它的字段写的（一样的只写一句）
  const notes = [...new Set(n.why.flatMap((w) => (w.link && w.from.kind !== DIMENSION ? [OFF_NOTES[w.from.kind]?.[String(w.link.path[0])] ?? (w.link.drop ? GENERIC_OFF : '')] : [])).filter(Boolean))];
  const lockedBy = skipLock ? undefined : n.why.find((w) => w.link && !w.link.drop);
  return {
    kind: n.ref.kind,
    id: n.ref.id,
    name: n.name,
    kindLabel: k?.label ?? '变量',
    cls: n.cls,
    state,
    why: firsts,
    whyMore: Math.max(0, n.why.length - firsts.length),
    ...(to && to !== n.ref.id ? { to } : {}),
    ...(lockedBy ? { locked: `少了它“${lockedBy.fromName}”用不了` } : {}),
    ...(notes.length ? { offNote: notes[0] } : n.cls === 'member' ? { offNote: '取消后不带这一项' } : {}),
    ...(n.under ? { under: n.under } : {}),
  };
}

const DIM_OFF = '取消后不加这个变量，写到它的来源、倾向去掉';
const dimRow = (d: DimNode, info: SourceInfo, state: ImportState): ImportRow => {
  const r = rowOf({ ref: { kind: DIMENSION, id: d.id }, name: d.label, cls: d.cls, why: d.why }, state, undefined, d.cls !== 'hard');
  return { ...r, offNote: d.cls === 'optional' ? '勾上后世界多一个变量，这些引用留着；不勾时去掉' : DIM_OFF, count: info.dims.get(d.id)?.values.length ?? 0 };
};

export function importPreview(ask: ImportAsk): ImportPreview {
  const info = infoOf(ask.source);
  const dest = destOf(ask.target);
  const kindsById = new Map(dest.kinds.map((k) => [k.id, k]));
  const finalOf = ask.target.t === 'world' ? finalItem : (k: ContentKind, x: unknown, id: string, r: Renames, only?: Parameters<typeof renamedItem>[4]) => renamedItem(k, x, id, r, only);
  // 只看能放进目的地的种类（世界里星球形态不走这里）
  const usable = (r: ContentRef) => r.kind === DIMENSION || kindsById.has(r.kind);
  const filtered: ImportAsk = { ...ask, picks: ask.picks.filter(usable) };
  const skip = new Set<string>();
  const skipFinal = new Map<string, unknown>();
  let w!: Walked;
  let finals!: Finals;
  let settled!: ReturnType<typeof settleIds>;
  let picked!: Map<ContentKind, unknown[]>;
  // 认出“已经有了”的项后不再往下走，引用可能因此少一些，再算一遍。skip 只增不减，几遍就停
  for (let round = 0; round < 8; round++) {
    w = walk(info, filtered, dest, skip);
    for (const key of w.reached.keys()) if (!kindsById.has(key.split('\u0000')[0])) w.reached.delete(key);
    finals = finalsOf(w, dest, skip, info.table);
    // 目的地有同 id、一模一样的（原样的，或导入时的样子）：已经有了。从库建的世界里的文化写着别的时代的倾向，来源那份也写着，这种不算不同
    let same = false;
    for (const [key, n] of w.reached) {
      if (finals.blocked.has(key) || skip.has(key)) continue;
      const there = dest.byId.get(n.ref.kind)?.get(n.ref.id);
      if (there === undefined) continue;
      const k = kindsById.get(n.ref.kind)!;
      const have = contentKey(k, there);
      if (have === contentKey(k, ask.target.t === 'world' ? finalized(k, n.item) : n.item) || have === contentKey(k, ask.target.t === 'world' ? finalized(k, finals.items.get(key)) : finals.items.get(key))) {
        skip.add(key);
        same = true;
      }
    }
    if (same) {
      round--;
      continue;
    }
    picked = new Map(dest.kinds.map((k) => [k, [] as unknown[]]));
    for (const [key, n] of w.reached) {
      if (finals.blocked.has(key) || skip.has(key)) continue;
      picked.get(kindsById.get(n.ref.kind)!)!.push(finals.items.get(key));
    }
    // 已经有了的一直留着：写到它们的引用要按目的地的 id 改；它们自己什么也不加
    for (const [key, x] of skipFinal) picked.get(kindsById.get(key.split('\u0000')[0])!)!.push(x);
    settled = settleIds(dest.kinds, picked, dest.items, finalOf);
    let grew = false;
    for (const [k, a] of settled.assigned) {
      for (const id of a.skip) {
        const key = linkKey(k.id, id);
        if (skip.has(key)) continue;
        skip.add(key);
        skipFinal.set(key, finals.items.get(key));
        grew = true;
      }
    }
    if (!grew) break;
  }

  const ids = new Map<string, string>();
  for (const [k, a] of settled.assigned) for (const [from, to] of a.ids) ids.set(linkKey(k.id, from), to);
  for (const key of skip) if (!ids.has(key)) ids.set(key, key.split('\u0000')[1]);

  const rows: ImportRow[] = [];
  for (const [key, n] of w.reached) {
    const blocked = finals.blocked.get(key);
    const state: ImportState = blocked ? 'blocked' : skip.has(key) ? 'have' : ids.get(key) !== n.ref.id ? 'rename' : 'new';
    const lockSkip = n.cls === 'auto' || n.cls === 'member';
    const row = rowOf(n, state, ids.get(key), lockSkip);
    rows.push(blocked ? { ...row, why: [blocked, ...row.why] } : row);
  }
  const dimRows = [...w.dims.values()].map((d) => dimRow(d, info, 'new'));
  const offRows = [...w.offRows.values()].map((n): ImportRow => (n.ref.kind === DIMENSION ? dimRow({ id: n.ref.id, label: n.name, cls: 'auto', why: n.why }, info, 'off') : rowOf(n, 'off', undefined, true)));
  const optional = [...w.optional.values()].filter((d) => !w.dims.has(d.id) && !finals.avail({ kinds: [DIMENSION], id: d.id })).map((d) => dimRow(d, info, 'off'));

  const isPick = (r: ImportRow) => r.cls === 'pick';
  // 变量在前，再按种类；取消了也留在原来的位置，能勾回来
  const kindAt = new Map(dest.kinds.map((k, i) => [k.id, i]));
  const rank = (r: ImportRow) => (r.kind === DIMENSION ? -1 : (kindAt.get(r.kind) ?? 1e9));
  const bring = [...dimRows.filter((r) => !isPick(r)), ...rows.filter((r) => !isPick(r) && !r.under && (r.state === 'new' || r.state === 'rename')), ...offRows].sort((a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const eraDims: Dimension[] = dest.era ? [...w.dims.values()].filter((d) => !dest.dims.has(d.id)).map((d) => ({ id: d.id, label: d.label, required: true, added: true })) : [];

  // 放不下
  const over: string[] = [];
  for (const k of dest.kinds) {
    const a = settled.assigned.get(k);
    const adding = a ? a.ids.size - a.skip.size : 0;
    if (!adding) continue;
    const cap = ask.target.t === 'world' ? (k.maxInWorld ?? k.pack.max) : k.pack.max;
    if (dest.items.get(k)!.length + adding > cap) over.push(`${k.label}最多 ${cap} 个`);
  }
  for (const id of w.dimsFull) over.push(`一个时代最多 ${MAX_DIMENSIONS} 个变量，加不了“${info.dims.get(id)?.label ?? id}”`);
  const count = rows.filter((r) => !r.under && (r.state === 'new' || r.state === 'rename')).length + w.dims.size;
  return {
    picks: [...dimRows.filter(isPick), ...rows.filter(isPick)],
    bring,
    optional,
    have: rows.filter((r) => r.state === 'have'),
    renamed: rows.filter((r) => r.state === 'rename'),
    // 只说要紧的：依赖带来的项带不了时，写到它的引用去掉（在 stripped 里）
    blocked: rows.filter((r) => r.state === 'blocked' && (r.cls === 'pick' || r.cls === 'hard')),
    stripped: finals.stripped,
    over,
    dims: eraDims,
    count,
    plan: { finals: picked, ids, renames: settled.renames, ...(dest.era ? { era: dest.era } : {}) },
  };
}

// ---------- 写入 ----------

// 合成一个包：导入时的样子（已经有了的也在：写到它们的引用要按目的地的 id 改）
function mergedPack(preview: ImportPreview): { pack: PackNode; picks: PackPicks } {
  const pack: PackNode = { id: 'import', name: '导入' };
  const picks: PackPicks = { defaultStyle: null };
  for (const [k, list] of preview.plan.finals) {
    if (!list.length) continue;
    pack[k.pack.key] = list;
    picks[k.pack.key] = list.map((x) => itemId(k, x));
  }
  return { pack, picks };
}

// 一项来自来源的哪个小包
function originIndex(source: PackNode, root: readonly string[]): (key: string, id: string) => string[] {
  const at = new Map<string, string[]>();
  walkPacks(source, (n, rel) => {
    for (const [key, v] of Object.entries(n)) {
      if (key === 'packs' || !Array.isArray(v)) continue;
      const k = packSections().find((x) => x.pack.key === key);
      for (const x of v) {
        const id = k ? itemId(k, x) : String(x);
        const m = linkKey(key, id);
        if (!at.has(m)) at.set(m, [...root, ...rel]);
      }
    }
  });
  return (key, id) => at.get(linkKey(key, id)) ?? [...root];
}

// 导入时顺手放到一个上级下面（上级页面“加”的下拉选了别的库里的一项）：同一步
export interface ImportOnto {
  relation: ArrangeRelation;
  parent: string;
  child: ContentRef;
}

function ontoEdit(onto: ImportOnto, preview: ImportPreview, itemsIn: (k: ContentKind) => readonly unknown[]): { kind: ContentKind; item: Record<string, unknown> } | null {
  const up = kindOf(onto.relation.parent);
  const ck = kindOf(onto.child.kind);
  if (!up || !ck || !onto.relation.link) return null;
  const parent = itemsIn(up).find((x) => itemId(up, x) === onto.parent) as Record<string, unknown> | undefined;
  const toId = preview.plan.ids.get(keyRef(onto.child));
  const child = toId ? (itemsIn(ck).find((x) => itemId(ck, x) === toId) as Record<string, unknown> | undefined) : undefined;
  if (!parent || !child) return null;
  const edit = onto.relation.link(parent, child);
  return { kind: edit.side === 'parent' ? up : ck, item: edit.next };
}

export interface WorldImport {
  command: Extract<Command, { op: 'batch' }> | null;
  added: PackPlan['added'];
  skipped: PackPlan['skipped'];
  preview: ImportPreview;
}

const LABEL_NAMES = 1;
function importLabel(p: ImportPreview): string {
  const first = p.picks[0];
  if (!first) return `导入 ${p.count} 项`;
  const head = p.picks.slice(0, LABEL_NAMES).map((r) => `${r.kindLabel}“${r.name}”`).join('、');
  return p.count > 1 ? `导入${head}等 ${p.count} 项` : `导入${head}`;
}

// 导入本世界的命令：一个 batch，一次撤销全撤。先加各项，再加变量（add_dimension 要取值已经在世界里）。什么都不用加、放不下时 command 是 null。
// path：来源在资源库里的路径（记进世界的来源）
export function importCommand(ask: ImportAsk, opts: { path?: readonly string[]; onto?: ImportOnto } = {}): WorldImport {
  if (ask.target.t !== 'world') throw new Error('importCommand 只给世界用');
  const world = ask.target.world;
  const preview = importPreview(ask);
  if (preview.over.length) return { command: null, added: [], skipped: [], preview };
  const { pack, picks } = mergedPack(preview);
  const origin = originIndex(ask.source, opts.path ?? [ask.source.id]);
  const plan = planPack(world, pack, picks, { origin, label: importLabel(preview) });
  const commands: Command[] = [...plan.command.commands];
  const era = preview.plan.era;
  if (era) for (const d of preview.dims) commands.push({ op: 'add_dimension', dimension: { id: d.id, label: d.label.slice(0, 12) }, era: era.id });
  if (opts.onto) {
    // 上级、下级都是世界里已经有、或这一步刚加的
    const after = new Map<ContentKind, unknown[]>();
    const itemsIn = (k: ContentKind): readonly unknown[] => {
      let l = after.get(k);
      if (!l) {
        const id = (x: unknown) => itemId(k, x);
        const fresh = (preview.plan.finals.get(k) ?? []).flatMap((x) => {
          const to = preview.plan.ids.get(linkKey(k.id, id(x)));
          return to && !k.inWorld(world).some((y) => id(y) === to) ? [finalItem(k, x, to, preview.plan.renames)] : [];
        });
        after.set(k, (l = [...k.inWorld(world), ...fresh]));
      }
      return l;
    };
    const e = ontoEdit(opts.onto, preview, itemsIn);
    if (e) commands.push(enableCommand(e.kind, e.item, world));
  }
  return { command: commands.length ? { ...plan.command, commands } : null, added: plan.added, skipped: plan.skipped, preview };
}

// 换掉树里同 id 的一项（别的层共用）
function replaced(node: PackNode, k: ContentKind, id: string, item: unknown): PackNode {
  let out = node;
  const list = ownItems(node, k.pack.key);
  if (list.some((x) => itemId(k, x) === id)) out = { ...out, [k.pack.key]: list.map((x) => (itemId(k, x) === id ? item : x)) };
  const kids = subPacks(node);
  if (kids.length) {
    const next = kids.map((c) => replaced(c, k, id, item));
    if (next.some((c, i) => c !== kids[i])) out = { ...out, packs: next };
  }
  return out;
}

export interface PackImport {
  pack: ResourcePack;
  added: PackPlan['added'];
  skipped: PackPlan['skipped'];
  preview: ImportPreview;
}

// 导入我的库：返回新的包（原来的不动）。没有什么要加时给回原来的。目的地的安排不动，来源的不带（importIntoPack）
export function importToPack(ask: ImportAsk, opts: { onto?: ImportOnto } = {}): PackImport {
  if (ask.target.t !== 'pack') throw new Error('importToPack 只给库用');
  const target = ask.target.pack;
  const preview = importPreview(ask);
  if (preview.over.length || (!preview.count && !opts.onto)) return { pack: target, added: [], skipped: [], preview };
  const { pack: merged, picks } = mergedPack(preview);
  const r = importIntoPack(target, merged, picks);
  let pack = r.pack;
  const era = preview.plan.era;
  const eraKind = kindOf('era');
  if (era && eraKind && preview.dims.length) pack = replaced(pack, eraKind, era.id, { ...era, dimensions: [...era.dimensions, ...preview.dims] }) as ResourcePack;
  if (opts.onto) {
    const e = ontoEdit(opts.onto, preview, (k) => packItems(pack, k.pack.key));
    if (e) pack = replaced(pack, e.kind, itemId(e.kind, e.item), e.item) as ResourcePack;
  }
  return { pack, added: r.added, skipped: r.skipped, preview };
}
