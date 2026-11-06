import type { Command } from '../commands';
import type { ArrangeRelation } from '../content/arrange';
import { DIMENSION } from '../content/link-rules';
import { type ContentRef, type Link, itemFields, linkKey, resolveLink, stripLinks } from '../content/links';
import { type ContentKind, type Renames, enableCommand, itemId, kindOf } from '../content/registry';
import { type Dimension, type Era, MAX_DIMENSIONS, type PopValue } from '../human/era';
import { type PackNode, type PackPicks, type PackPlan, type ResourcePack, finalItem, ownItems, packItems, packSections, planPack, renamedItem, settleIds, subPacks, walkPacks } from '../packs';
import { importIntoPack } from './import';
import { type ImportAsk, type ImportGates, type ImportNode, type ImportRole, type WalkCtx, type Walked, destOf, dimThere, gatesOf, infoOf, keyRef, linkNeedName, linkThere, needText, relationOf, restoredLinks, softLacks, walkClosure, walkCtx, weightBack } from './import-gates';

export { contentKey, importGates, targetEra } from './import-gates';
export type { ImportAsk, ImportGate, ImportGates, ImportNeed, ImportRole, ImportTarget } from './import-gates';

// 导入的闭包（第六十一轮，第六十四轮重写）：从一个库勾几项导入本世界或我的库，勾什么进什么。能不能选、走到哪些在 import-gates.ts，这里算写入：
//
//   哪些引用留着：目标在目的地或这次带来的；别的去掉这一条（stripCount 是条数），内容照常导入
//   灰的、放不下的：从结果里拿掉，写进 dropped（带原因），不挡别的项。清单里的都真的写入，count = rows.length
//   改名：是不是同一项、撞名改名、引用跟着改都由 settleIds 算（第四十九轮），比较的是导入时的样子（去掉引用、写了 weight 之后），
//         所以同样的勾选再导入一次什么都不加
//   补回：目的地的一项是来源去掉了几条引用后的样子，而目标现在有了（先导入天主教，后导入基督教组）：写回去，不改名。世界里 enableCommand，库里 replaced
//
// 变量（维度）不是一项内容：写在目的地的时代里。世界里走 add_dimension（只算新变量），库里写进时代。目的地没有时代时带上来源里提供这个变量的时代。
// 跟着来的文化组 weight 写 0，不参与生成；点名勾的组比重是 0 时去掉这个 0（用户就是要它参与，和 packImportPlan 一样）。
// 第六十六轮：因为勾了组里的文化才跟着来的组（member）和勾的组一样：组里只有勾的文化，重新生成后它在地图上。
// 目的地的安排（arrange）不动，来源的不带。

export type ImportRowState = 'new' | 'rename' | 'fix';

export interface ImportRow {
  kind: string;
  id: string;
  name: string;
  // “政体”“变量”
  kindLabel: string;
  role: ImportRole;
  // new 新加；rename 目的地有同 id、内容不同，导入后叫 to；fix 补回目的地这一份的引用
  state: ImportRowState;
  // 为什么来：“封建君主制 里的”“直隶人 要它”（勾的是空的）
  because: string[];
  to?: string;
  // 属于哪个变量（这个变量的取值、取值组，清单里收成一行）
  under?: string;
  // 变量：这次带来几种取值
  count?: number;
  // 树形：排在这一行下面的（政体 ▸ 派系、变量 ▸ 取值）
  children: ImportRow[];
}

export interface ImportStrip {
  from: ContentRef;
  fromName: string;
  label: string;
  target: string;
}

export interface ImportDropped {
  kind: string;
  id: string;
  name: string;
  kindLabel: string;
  reason: string;
}

export interface ImportPreview {
  // 清单：树的第一层（变量在前，再按种类）
  list: ImportRow[];
  // 清单展开成一列（和 list、children 是同样的对象）
  rows: ImportRow[];
  // 真的写几项：写入的内容（新的、改名的、补回的）+ 新的自定义场 + 加到时代里的变量。等于 rows.length
  count: number;
  // 自动去掉的引用
  stripCount: number;
  stripped: ImportStrip[];
  // 勾了但进不来的：灰的、放不下的（原因写着）
  dropped: ImportDropped[];
  // 要加的变量（目的地的时代里）
  dims: Dimension[];
  // 每一项能不能选（按现在的勾选）
  gates: ImportGates;
  // 写入用
  plan: SettledPlan;
}

interface SettledPlan {
  finals: Map<ContentKind, unknown[]>;
  ids: Map<string, string>;
  renames: Renames;
  // 补回的：目的地同 id 的一项换成这个样子
  fixes: { kind: ContentKind; id: string; item: unknown }[];
  era?: Era;
}

const DIM_LABEL = '变量';
const FULL_DIMS = `一个时代最多 ${MAX_DIMENSIONS} 个变量`;

// ---------- 导入时的样子 ----------

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

// 比重：勾的组、勾的文化带来的组用来源的值（是 0 时去掉这个 0）；别的跟着来的写 0
const joins = (n: ImportNode): boolean => n.role === 'pick' || !!n.member;
const withWeight = (n: ImportNode, item: unknown): unknown => {
  if (n.ref.kind !== 'cultureGroup') return item;
  const g = item as { weight?: number };
  if (!joins(n)) return g.weight === 0 ? item : { ...g, weight: 0 };
  if (g.weight !== 0) return item;
  const { weight: _, ...rest } = g;
  return rest;
};

// 引用所在的那个顶层字段
const fieldLabel = (kind: string, link: Link): string => kindOf(kind)?.fields.find((f) => f.key === link.path[0])?.label ?? link.label;

interface Finals {
  items: Map<string, unknown>;
  // 走到了但写不了：原因
  blocked: Map<string, string>;
  stripped: ImportStrip[];
  fixes: Map<string, unknown>;
}

function finalsOf(c: WalkCtx, w: Walked): Finals {
  const { info, dest } = c;
  const { table } = info;
  const blocked = new Map<string, string>();
  const avail = (l: Pick<Link, 'kinds' | 'id'>) => linkThere(c, w, l, blocked);
  const has = { dim: (id: string) => dimThere(c, w, id), link: (l: Link) => avail(l) };
  const settled = (key: string) => w.have.has(key) || c.skip.has(key);
  // 写的时候又少了东西（目标放不下、被去掉）：这一项也写不了；写到它的再看一遍
  for (let changed = true; changed; ) {
    changed = false;
    for (const [key, n] of w.reached) {
      if (blocked.has(key) || settled(key)) continue;
      const bad = (table.out.get(key) ?? []).find((l) => !l.drop && !avail(l));
      if (bad) {
        blocked.set(key, bad.kinds.includes(DIMENSION) && w.dimsFull.has(bad.id) ? (c.over.get(linkKey(DIMENSION, bad.id)) ?? FULL_DIMS) : `需要${linkNeedName(info, bad)}`);
        changed = true;
        continue;
      }
      const lacks = softLacks(c, key, n.ref.kind, n.item, has);
      if (lacks) {
        blocked.set(key, needText(lacks));
        changed = true;
      }
    }
  }
  const items = new Map<string, unknown>();
  const stripped: ImportStrip[] = [];
  const fixes = new Map<string, unknown>();
  const strip = (key: string, n: ImportNode): unknown => {
    const gone = (table.out.get(key) ?? []).filter((l) => l.drop && !avail(l));
    // 去掉的一处说一次（派系的一条来源写了变量和取值，是一处）：写具体的那个（取值，不是变量）
    const told = new Map<string, Link>();
    for (const l of gone) {
      const at = JSON.stringify(l.drop);
      if (!told.has(at) || l.kinds.includes(DIMENSION) === false) told.set(at, l);
    }
    for (const l of told.values()) {
      const to = resolveLink(table, l);
      const name = !to ? l.id : to.kind === DIMENSION ? l.id : linkNeedName(info, l);
      stripped.push({ from: n.ref, fromName: n.name, label: fieldLabel(n.ref.kind, l), target: name });
    }
    return gone.length ? strippedItem(n.ref.kind, n.item, gone, (l) => !avail(l)) : n.item;
  };
  for (const [key, n] of w.reached) {
    if (blocked.has(key)) continue;
    if (!settled(key)) {
      items.set(key, withWeight(n, strip(key, n)));
      continue;
    }
    // 目的地这一份少了引用，目标现在有了：勾的、下级补回（跟着来的只是要它在）。
    // 比重是 0 的组：勾上它、勾组里的文化时比重回来（跟着文化来的只回比重，第六十六轮）
    if (!w.have.has(key) || (n.role === 'follow' && !n.member)) continue;
    const k = dest.kindsById.get(n.ref.kind)!;
    const there = dest.byId.get(n.ref.kind)!.get(n.ref.id);
    const rel = relationOf(k, n.item, there, dest.world);
    const back = joins(n) && weightBack(k, n.item, there);
    if (!back && (n.role === 'follow' || !restoredLinks(k, n.item, there, rel, avail).length)) continue;
    const next = withWeight(n, strip(key, n)) as Record<string, unknown>;
    if (back) {
      fixes.set(key, next);
      continue;
    }
    // 不比的键（比重）留目的地的
    const out = { ...next };
    for (const skip of k.pack.sameIgnore ?? []) {
      const v = (there as Record<string, unknown>)[skip];
      if (v === undefined) delete out[skip];
      else out[skip] = v;
    }
    fixes.set(key, out);
  }
  return { items, blocked, stripped, fixes };
}

// ---------- 闭包 ----------

const rowOf = (n: ImportNode, state: ImportRowState, to: string | undefined): ImportRow => ({
  kind: n.ref.kind,
  id: n.ref.id,
  name: n.name,
  kindLabel: kindOf(n.ref.kind)?.label ?? DIM_LABEL,
  role: n.role,
  state,
  because: n.role === 'pick' ? [] : n.because,
  ...(to && to !== n.ref.id ? { to } : {}),
  ...(n.under ? { under: n.under } : {}),
  children: [],
});

export function importPreview(ask: ImportAsk): ImportPreview {
  const info = infoOf(ask.source);
  const dest = destOf(ask.target);
  const c = walkCtx(ask, info, dest);
  const finalOf = ask.target.t === 'world' ? finalItem : (k: ContentKind, x: unknown, id: string, r: Renames, only?: Parameters<typeof renamedItem>[4]) => renamedItem(k, x, id, r, only);
  const skip = new Set<string>();
  c.skip = skip;
  const skipFinal = new Map<string, unknown>();
  let w!: Walked;
  let finals!: Finals;
  let settled!: ReturnType<typeof settleIds>;
  let picked!: Map<ContentKind, unknown[]>;
  // 认出“已经有了”、放不下的项后引用可能因此少一些，再算一遍。skip、over 只增不减，几遍就停
  for (;;) {
    w = walkClosure(c, ask.picks);
    finals = finalsOf(c, w);
    picked = new Map(dest.kinds.map((k) => [k, [] as unknown[]]));
    const keysOf = new Map<ContentKind, string[]>();
    for (const [key, x] of finals.items) {
      const k = dest.kindsById.get(key.split('\u0000')[0])!;
      picked.get(k)!.push(x);
      if (!keysOf.has(k)) keysOf.set(k, []);
      keysOf.get(k)!.push(key);
    }
    // 已经有了的一直留着：写到它们的引用要按目的地的 id 改；它们自己什么也不加
    for (const [key, x] of skipFinal) picked.get(dest.kindsById.get(key.split('\u0000')[0])!)!.push(x);
    settled = settleIds(dest.kinds, picked, dest.items, finalOf);
    let again = false;
    for (const [k, a] of settled.assigned) {
      for (const id of a.skip) {
        const key = linkKey(k.id, id);
        if (skip.has(key)) continue;
        skip.add(key);
        skipFinal.set(key, finals.items.get(key));
        again = true;
      }
    }
    if (again) continue;
    // 放不下：先走到的（勾的）留着，多出来的跳过
    for (const [k, keys] of keysOf) {
      const room = dest.cap(k) - dest.items.get(k)!.length;
      for (const key of keys.slice(Math.max(0, room))) {
        c.over.set(key, `${k.label}最多 ${dest.cap(k)} 个`);
        again = true;
      }
    }
    if (again) continue;
    // 取值都放不下的变量不加（世界里没有取值的变量加不上）
    if (dest.era) {
      const valueKind = kindOf('popValue');
      const there = valueKind ? (dest.items.get(valueKind) ?? []) : [];
      for (const d of w.dims.values()) {
        const has = there.some((v) => (v as PopValue).dimension === d.id) || [...w.reached].some(([key, n]) => n.ref.kind === 'popValue' && (n.item as PopValue).dimension === d.id && !finals.blocked.has(key));
        if (!has) {
          c.over.set(linkKey(DIMENSION, d.id), `“${d.label}”的取值都放不下`);
          again = true;
        }
      }
    }
    if (!again) break;
  }

  const ids = new Map<string, string>();
  for (const [k, a] of settled.assigned) for (const [from, to] of a.ids) ids.set(linkKey(k.id, from), to);
  for (const key of [...skip, ...w.have]) if (!ids.has(key) && !finals.blocked.has(key)) ids.set(key, key.split('\u0000')[1]);

  // 清单
  const rows: ImportRow[] = [];
  const byKey = new Map<string, ImportRow>();
  const parents = new Map<ImportRow, string | undefined>();
  const addRow = (key: string, row: ImportRow, parent: string | undefined) => {
    rows.push(row);
    byKey.set(key, row);
    parents.set(row, parent);
  };
  if (dest.era) {
    for (const d of w.dims.values()) {
      const values = [...w.reached.values()].filter((n) => n.ref.kind === 'popValue' && (n.item as PopValue).dimension === d.id && !finals.blocked.has(keyRef(n.ref)) && finals.items.has(keyRef(n.ref))).length;
      addRow(linkKey(DIMENSION, d.id), { kind: DIMENSION, id: d.id, name: d.label, kindLabel: DIM_LABEL, role: d.role, state: 'new', because: d.role === 'pick' ? [] : d.because, count: values, children: [] }, d.parent);
    }
  }
  for (const [key, n] of w.reached) {
    if (finals.blocked.has(key)) continue;
    if (finals.fixes.has(key)) {
      addRow(key, rowOf(n, 'fix', undefined), n.parent);
      continue;
    }
    if (skip.has(key) || w.have.has(key)) continue;
    const to = ids.get(key);
    addRow(key, rowOf(n, to !== n.ref.id ? 'rename' : 'new', to), n.parent);
  }
  // 用到的、目的地还没有的自定义场（跟着内容自动加）
  const fieldsHere = new Set(ask.target.t === 'world' ? Object.keys(ask.target.world.causes.fields) : packItems<string>(ask.target.pack, 'fields'));
  for (const [key, x] of finals.items) {
    if (skip.has(key)) continue;
    const n = w.reached.get(key)!;
    for (const f of itemFields(n.ref.kind, x)) {
      const at = linkKey('field', f);
      if (fieldsHere.has(f) || byKey.has(at)) continue;
      addRow(at, { kind: 'field', id: f, name: f, kindLabel: kindOf('field')?.label ?? '自定义场', role: 'follow', state: 'new', because: [`${n.name} 要它`], children: [] }, undefined);
    }
  }
  // 变量在前，再按种类，同一种按走到的先后
  const kindAt = new Map(dest.kinds.map((k, i) => [k.id, i]));
  const rank = (r: ImportRow) => (r.kind === DIMENSION ? -1 : (kindAt.get(r.kind) ?? -0.5));
  const list: ImportRow[] = [];
  for (const row of rows) {
    const up = parents.get(row);
    const parent = up ? byKey.get(up) : undefined;
    if (parent) parent.children.push(row);
    else list.push(row);
  }
  list.sort((a, b) => rank(a) - rank(b));

  // 勾了但进不来的
  const dropped: ImportDropped[] = [];
  const drop = (kind: string, id: string, name: string, reason: string) => {
    if (!dropped.some((x) => x.kind === kind && x.id === id)) dropped.push({ kind, id, name, kindLabel: kindOf(kind)?.label ?? DIM_LABEL, reason });
  };
  for (const r of w.rejected.values()) if (r.role !== 'follow') drop(r.ref.kind, r.ref.id, r.name, r.gate.reason);
  for (const [key, reason] of finals.blocked) {
    const n = w.reached.get(key)!;
    if (n.role !== 'follow') drop(n.ref.kind, n.ref.id, n.name, reason);
  }
  for (const id of w.dimsFull) drop(DIMENSION, id, info.dims.get(id)?.label ?? id, c.over.get(linkKey(DIMENSION, id)) ?? FULL_DIMS);

  const fixes: SettledPlan['fixes'] = [];
  for (const [key, item] of finals.fixes) {
    const n = w.reached.get(key)!;
    const k = dest.kindsById.get(n.ref.kind)!;
    fixes.push({ kind: k, id: n.ref.id, item: finalOf(k, item, n.ref.id, settled.renames) });
  }
  const eraDims: Dimension[] = dest.era ? [...w.dims.values()].map((d) => ({ id: d.id, label: d.label, required: true, added: true })) : [];
  return {
    list,
    rows,
    count: rows.length,
    stripCount: finals.stripped.length,
    stripped: finals.stripped,
    dropped,
    dims: eraDims,
    gates: gatesOf(c, w, ask.source),
    plan: { finals: picked, ids, renames: settled.renames, fixes, ...(dest.era ? { era: dest.era } : {}) },
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

// 导入时顺手放到一个上级下面（上级页面“从别的库加”，第六十八轮起可以一次几项）：同一步
export interface ImportOnto {
  relation: ArrangeRelation;
  parent: string;
  children: readonly ContentRef[];
}

// 逐个链上；同一项改了几次（派系写在政体上）按上一次改过的接着改，最后每项给一条
function ontoEdits(onto: ImportOnto, preview: ImportPreview, itemsIn: (k: ContentKind) => readonly unknown[]): { kind: ContentKind; item: Record<string, unknown> }[] {
  const up = kindOf(onto.relation.parent);
  if (!up || !onto.relation.link) return [];
  const edited = new Map<string, { kind: ContentKind; item: Record<string, unknown> }>();
  const find = (k: ContentKind, id: string) => edited.get(linkKey(k.id, id))?.item ?? (itemsIn(k).find((x) => itemId(k, x) === id) as Record<string, unknown> | undefined);
  for (const c of onto.children) {
    const ck = kindOf(c.kind);
    const toId = ck && preview.plan.ids.get(keyRef(c));
    const parent = find(up, onto.parent);
    const child = ck && toId ? find(ck, toId) : undefined;
    if (!ck || !parent || !child) continue;
    const edit = onto.relation.link(parent, child);
    const kind = edit.side === 'parent' ? up : ck;
    edited.set(linkKey(kind.id, itemId(kind, edit.next)), { kind, item: edit.next });
  }
  return [...edited.values()];
}

export interface WorldImport {
  command: Extract<Command, { op: 'batch' }> | null;
  added: PackPlan['added'];
  skipped: PackPlan['skipped'];
  preview: ImportPreview;
}

// 撤销条上的一句：“添加“社会主义共和国”等 19 项”（第六十六轮起叫“添加”，“导入”只留给读文件）
// lead：用户点的那一项（第六十七轮：点社会主义共和国时写它，不写为它一起勾上的意识形态）；不在清单里时照旧写第一个勾的
export function importLabel(p: Pick<ImportPreview, 'rows' | 'count'>, lead?: { kind: string; id: string }): string {
  const first = (lead && p.rows.find((r) => r.kind === lead.kind && r.id === lead.id)) || p.rows.find((r) => r.role === 'pick') || p.rows[0];
  if (!first) return `添加 ${p.count} 项`;
  // 只写名字：种类的名字（“人口维度的取值”）是给编辑表单看的
  const head = `“${first.name}”`;
  return p.count > 1 ? `添加${head}等 ${p.count} 项` : `添加${head}`;
}

// 导入本世界的命令：一个 batch，一次撤销全撤。先加各项，再补回，再加变量（add_dimension 要取值已经在世界里）。什么都不用写时 command 是 null。
// path：来源在资源库里的路径（记进世界的来源）
export function importCommand(ask: ImportAsk, opts: { path?: readonly string[]; onto?: ImportOnto; lead?: { kind: string; id: string } } = {}): WorldImport {
  if (ask.target.t !== 'world') throw new Error('importCommand 只给世界用');
  const world = ask.target.world;
  const preview = importPreview(ask);
  const { pack, picks } = mergedPack(preview);
  const origin = originIndex(ask.source, opts.path ?? [ask.source.id]);
  const plan = planPack(world, pack, picks, { origin, label: importLabel(preview, opts.lead) });
  const commands: Command[] = [...plan.command.commands];
  for (const f of preview.plan.fixes) commands.push(enableCommand(f.kind, f.item, world));
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
    for (const e of ontoEdits(opts.onto, preview, itemsIn)) commands.push(enableCommand(e.kind, e.item, world));
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
  if (!preview.count && !opts.onto) return { pack: target, added: [], skipped: [], preview };
  const { pack: merged, picks } = mergedPack(preview);
  const r = importIntoPack(target, merged, picks);
  let pack = r.pack;
  for (const f of preview.plan.fixes) pack = replaced(pack, f.kind, f.id, structuredClone(f.item)) as ResourcePack;
  const era = preview.plan.era;
  const eraKind = kindOf('era');
  if (era && eraKind && preview.dims.length) pack = replaced(pack, eraKind, era.id, { ...era, dimensions: [...era.dimensions, ...preview.dims] }) as ResourcePack;
  if (opts.onto) {
    for (const e of ontoEdits(opts.onto, preview, (k) => packItems(pack, k.pack.key))) pack = replaced(pack, e.kind, itemId(e.kind, e.item), e.item) as ResourcePack;
  }
  return { pack, added: r.added, skipped: r.skipped, preview };
}
