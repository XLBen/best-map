import type { Command } from '../../../core/commands';
import { type ContentKind, type ContentUsage, type UsageWorld, builtinOf, disableCommand as kindDisable, itemId, itemName, kindOf, usageOf } from '../../../core/content/registry';
import { styleProblems, worldStyleId, type NameStyle } from '../../../core/name-styles';
import { PACK_FORMAT, PACK_VERSION, type PackNode, type PackWorld, type ResourcePack, canApply, ownItems, packIdFor, packItems, packSections, planPack, sameItem, subPacks, walkPacks, findPack } from '../../../core/packs';
import { originOf } from '../../../core/packs/builtin-tree';
import type { ContentRef } from '../../../core/content/unused';
import type { LibraryEntry } from '../../library';

// 资源库（第二十八轮以前叫资源库）的逻辑：每一种内容在资源库里有哪些（内置的、资源包里的、我的，本世界里有、资源库里没有的），
// 每一项在不在本世界、添加到本世界 / 移出本世界是哪条命令（一整步，可以撤销），在用的不能移出（用在哪里、定位），
// 地名风格的“默认”，单独一项导出成文件。不碰界面，测试直接调

export type RepoSource = 'builtin' | 'mine' | 'imported' | 'world';
export type RepoFilter = 'all' | 'builtin' | 'mine' | 'imported' | 'on' | 'off';

export const REPO_FILTERS: [RepoFilter, string][] = [
  ['all', '全部'],
  ['on', '本世界'],
  ['off', '不在本世界'],
  ['builtin', '内置'],
  ['imported', '资源包'],
  ['mine', '我的'],
];

// 卡片上写的来源
export const SOURCE_LABEL: Record<RepoSource, string> = { builtin: '内置', imported: '资源包', mine: '我的', world: '本世界做的' };

// 左边的分类：列出来的几种（自定义场跟着别的自动加，不列），地名风格在最前
export function repoKinds(): ContentKind[] {
  const list = packSections();
  return [...list.filter((k) => k.id === 'nameStyle'), ...list.filter((k) => k.id !== 'nameStyle')];
}

export interface RepoStatus {
  // 在这个世界里启用着
  on: boolean;
  // 世界里那一项的 id（启用着时；同 id 不同内容时世界里的叫别的 id）
  worldId?: string;
  // 开关不能动：原因
  locked?: string;
  // 启用后叫什么（世界里已有同 id 的另一份，这一份改名加上）
  rename?: string;
  // 地名风格：是世界默认
  isDefault?: boolean;
  // 总在世界里的内置项（第二十一轮：内置的地形类别、通用资源）：没有开关，写“内置·常开”。第三十轮起没有总在的项，不再有这两个
  always?: boolean;
  // 总在的内置项在这个世界里改过（small.content 里同 id 的一份）：可以恢复
  modified?: boolean;
}

export interface RepoRow {
  kind: ContentKind;
  // 列表里唯一的键
  key: string;
  id: string;
  name: string;
  item: unknown;
  source: RepoSource;
  // 它所在的包（启用时按资源包的规则加进世界：先加用到的自定义场，同 id 不同内容的改名）；可以是资源包里的一个小包
  pack: PackNode;
  // 来自哪里（小字）
  from: string;
  // 资源库里的键（内置、我的、导入的）
  entry?: string;
  // 第二十九轮：在资源库的树里的位置 [资源库的键, 小包…]（添加到本世界时记进 small.origin）；本世界一栏里是记着的来源
  path?: string[];
  status: RepoStatus;
}

const wrap = (kind: ContentKind, items: readonly unknown[], id: string, name: string): ResourcePack => ({ format: PACK_FORMAT, version: PACK_VERSION, id, name, [kind.pack.key]: [...items] });

// 一次列表里共用的：每一种在世界里的项（列一棵树要查上千项，kind.inWorld 不必每项都算一遍）
type Ctx = Map<string, readonly unknown[]>;
function inWorldOf(kind: ContentKind, world: PackWorld, ctx?: Ctx): readonly unknown[] {
  if (!ctx) return kind.inWorld(world);
  let v = ctx.get(kind.id);
  if (!v) ctx.set(kind.id, (v = kind.inWorld(world)));
  return v;
}

// 一项在这个世界里的状态
// builtin：登记表里的内置项（不是资源库里的包）
function statusOf(kind: ContentKind, item: unknown, pack: PackNode, world: PackWorld | null, builtin = false, ctx?: Ctx): RepoStatus {
  const id = itemId(kind, item);
  if (!world) return { on: false, locked: '先新建或打开世界' };
  const inWorld = inWorldOf(kind, world, ctx);
  if (!canApply(kind)) {
    const on = inWorld.some((x) => itemId(kind, x) === id && sameItem(x, item));
    return { on, ...(on ? { worldId: id } : {}), locked: kind.pack.note ?? '不能启用' };
  }
  const isDefault = (wid: string) => (kind.id === 'nameStyle' ? { isDefault: worldStyleId(world.small) === wid } : {});
  // 第三十轮：基础的内容（地形类别、通用资源、中文·默认……）也是普通内容，不再“总在”
  void builtin;
  // 世界里有一模一样的
  if (inWorld.some((x) => itemId(kind, x) === id && sameItem(x, item))) return { on: true, worldId: id, ...isDefault(id) };
  if (kind.id === 'nameStyle') {
    const bad = styleProblems(item as NameStyle);
    if (bad.length) return { on: false, locked: bad[0] };
  }
  // 世界里没有同 id 的：加进来时不改名，就是不在本世界（不必按资源包的规则算一遍）
  if (!inWorld.some((x) => itemId(kind, x) === id)) return { on: false };
  // 按资源包的规则：加进世界时的样子（没写“自然生成”的关掉……）与世界里的一样就是启用着
  const plan = planPack(world, pack, { [kind.pack.key]: [id], defaultStyle: null });
  const skip = plan.skipped.find((x) => x.section === kind.pack.key && x.from === id);
  if (skip) return { on: true, worldId: skip.id, ...isDefault(skip.id) };
  const add = plan.added.find((x) => x.section === kind.pack.key && x.from === id);
  return { on: false, ...(add && add.id !== id ? { rename: add.name } : {}) };
}

// 一种内容在资源库里的全部（内置在前，之后是我的、导入的，最后是世界里有、资源库里没有的）
export function repoRows(kind: ContentKind, world: PackWorld | null, lib: readonly LibraryEntry[]): RepoRow[] {
  const rows: RepoRow[] = [];
  const push = (item: unknown, source: RepoSource, pack: ResourcePack, from: string, entry?: string, own = false) => {
    const id = itemId(kind, item);
    rows.push({ kind, key: `${source}:${entry ?? ''}:${id}`, id, name: itemName(kind, item), item, source, pack, from, ...(entry ? { entry } : {}), status: statusOf(kind, item, pack, world, own) });
  };
  // 内置：内置的树里的（同一项只列一次）
  const own = builtinOf(kind.id);
  const ownPack = wrap(kind, own, `builtin-${kind.id}`, '内置');
  for (const x of own) push(x, 'builtin', ownPack, '内置', undefined, true);
  for (const e of lib.filter((x) => x.builtin)) {
    for (const x of packItems(e.pack, kind.pack.key)) {
      const id = itemId(kind, x);
      if (rows.some((r) => r.source === 'builtin' && r.id === id && sameItem(r.item, x))) continue;
      push(x, 'builtin', e.pack, e.pack.name, e.key);
    }
  }
  for (const e of lib.filter((x) => !x.builtin)) for (const x of packItems(e.pack, kind.pack.key)) push(x, e.mine ? 'mine' : 'imported', e.pack, e.pack.name, e.key);
  // 世界里有、资源库里没有的（这个世界里做的、别人的世界带来的）
  if (world) {
    const covered = new Set(rows.flatMap((r) => (r.status.on && r.status.worldId ? [r.status.worldId] : [])));
    const items = kind.inWorld(world).filter((x) => !covered.has(itemId(kind, x)));
    const pack = wrap(kind, items, `world-${kind.id}`, '这个世界');
    for (const x of items) push(x, 'world', pack, '这个世界');
  }
  return rows;
}

// 筛选：来源、在用，再按名字、id、来自哪里搜
export function filterRows(rows: readonly RepoRow[], filter: RepoFilter, query = '', entry?: string): RepoRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter(
    (r) =>
      (filter === 'all' || (filter === 'on' ? r.status.on : filter === 'off' ? !r.status.on : r.source === filter)) &&
      (!entry || r.entry === entry) &&
      (!q || r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q) || r.from.toLowerCase().includes(q)),
  );
}

const quoted = (r: RepoRow) => `${r.kind.label}“${r.name}”`;

// 启用：按资源包的规则（先加用到的自定义场；同 id 不同内容的改名加上）。一整步
export function enableRowCommand(row: RepoRow, world: PackWorld): Command {
  const plan = planPack(world, row.pack, { [row.kind.pack.key]: [row.id], defaultStyle: null }, row.path ? { path: row.path } : {});
  return { ...plan.command, label: `添加到本世界：${quoted(row)}` };
}

// 停用：世界里的那一项。停用的是世界默认的地名风格时，世界默认一起换回内置中文
export function disableRowCommand(row: RepoRow, world: PackWorld): Command {
  const id = row.status.worldId ?? row.id;
  const off = kindDisable(row.kind, id, world);
  if (row.status.isDefault) return { op: 'batch', label: `移出本世界：${quoted(row)}`, commands: [{ op: 'set_name_style', id: null }, off] };
  return off;
}

// ---------- 添加到本世界、移出本世界（第二十八轮） ----------

// 用在哪里：只看在本世界里的那一项（世界换了重算；同一个世界里按种类和 id 记着）
const usageCache = new WeakMap<object, Map<string, ContentUsage | null>>();
export function rowUsage(row: RepoRow, world: UsageWorld | null): ContentUsage | null {
  if (!world || !row.status.on || row.status.always) return null;
  const id = row.status.worldId ?? row.id;
  let m = usageCache.get(world);
  if (!m) usageCache.set(world, (m = new Map()));
  const key = `${row.kind.id}:${id}`;
  if (!m.has(key)) m.set(key, usageOf(row.kind, world, id));
  return m.get(key) ?? null;
}

// 添加到本世界：不在本世界、开关能动时
export function addCommand(row: RepoRow, world: PackWorld): Command | null {
  if (row.status.on || row.status.locked) return null;
  return enableRowCommand(row, world);
}

// 移出本世界：在本世界、开关能动、没有在用时（在用的先把用到它的地方改掉）
export function removeCommand(row: RepoRow, world: UsageWorld): Command | null {
  if (!row.status.on || row.status.locked || row.status.always) return null;
  if (rowUsage(row, world)) return null;
  const cmd = disableRowCommand(row, world);
  return cmd.op === 'batch' ? cmd : { op: 'batch', label: `移出本世界：${quoted(row)}`, commands: [cmd] };
}

// 存进资源库的样子（只有本世界做的、改过的一项：资源库里还没有这一份）。不是时 null
export function saveableItem(row: RepoRow): unknown | null {
  if (row.source !== 'world') return null;
  return row.kind.pack.exportItem ? row.kind.pack.exportItem(row.item) : structuredClone(row.item);
}

// 从资源库里删掉：只有“我的”能删
export const canDeleteFromLibrary = (row: RepoRow): boolean => row.source === 'mine' && !!row.entry;

// 单独一项导出成资源包文件：生态带上用到的自定义场；本世界里的按导出的样子
export function itemPack(row: RepoRow): ResourcePack {
  const k = row.kind;
  const item = row.source === 'world' && k.pack.exportItem ? k.pack.exportItem(row.item) : structuredClone(row.item);
  const pack: ResourcePack = { format: PACK_FORMAT, version: PACK_VERSION, id: packIdFor(`${k.id}-${row.name}`), name: row.name, [k.pack.key]: [item] };
  const fields = k.pack.fieldsOf?.(item) ?? [];
  if (fields.length) pack.fields = [...new Set(fields)];
  return pack;
}

// 恢复：总在的内置项改过时，去掉世界里改过的那一份（换回内置的）。没改过时 null
export function restoreRowCommand(row: RepoRow, world: PackWorld): Command | null {
  if (!row.status.always || !row.status.modified) return null;
  return { op: 'batch', label: `恢复${quoted(row)}`, commands: [kindDisable(row.kind, row.id, world)] };
}

// 编辑时从哪一份开始：总在的内置项编辑的是世界里的那一份（改过的）
export function editStart(row: RepoRow, world: PackWorld | null): unknown {
  if (!row.status.always || !world) return row.item;
  return row.kind.inWorld(world).find((x) => itemId(row.kind, x) === row.id) ?? row.item;
}

// 开关：现在开着就停用，关着就启用。不能动时 null
export function toggleCommand(row: RepoRow, world: PackWorld): Command | null {
  if (row.status.locked) return null;
  return row.status.on ? disableRowCommand(row, world) : enableRowCommand(row, world);
}

// 地名风格设为世界默认：没启用的一起启用（一整步）。已经是默认时 null
export function defaultStyleCommand(row: RepoRow, world: PackWorld): Command | null {
  if (row.kind.id !== 'nameStyle' || row.status.isDefault) return null;
  if (row.status.on) {
    const id = row.status.worldId ?? row.id;
    return { op: 'set_name_style', id };
  }
  if (row.status.locked) return null;
  const plan = planPack(world, row.pack, { nameStyles: [row.id], defaultStyle: row.id }, row.path ? { path: row.path } : {});
  return { ...plan.command, label: `地名风格改为“${row.name}”` };
}

// 左边分类旁的数：这个世界里启用了几项
export function enabledCount(kind: ContentKind, world: PackWorld | null): number {
  return world ? kind.inWorld(world).length : 0;
}

// ---------- 分组（第二十二轮） ----------

// 列表分成几段：人口维度的取值按维度（宗教、种族……），文化按文化组；别的种类一段（label 为 null）。
// names.dims：维度 id → 名字（内置的时代与世界里的时代写了的）；names.groups：文化组 id → 名字
export function repoSections(
  kind: ContentKind,
  rows: readonly RepoRow[],
  names: { dims: ReadonlyMap<string, string>; groups: ReadonlyMap<string, string> },
): { label: string | null; rows: RepoRow[] }[] {
  const key = kind.id === 'popValue' ? 'dimension' : kind.id === 'culture' ? 'group' : null;
  if (!key) return [{ label: null, rows: [...rows] }];
  const labels = key === 'dimension' ? names.dims : names.groups;
  const out = new Map<string, RepoRow[]>();
  for (const r of rows) {
    const k = String((r.item as Record<string, unknown>)[key] ?? '');
    if (!out.has(k)) out.set(k, []);
    out.get(k)!.push(r);
  }
  return [...out.entries()].map(([k, list]) => ({ label: labels.get(k) ?? (k || '其他'), rows: list }));
}

// 人文的四种：资源库里有“生成人文…”的入口
export const HUMAN_KINDS: ReadonlySet<string> = new Set(['era', 'popValue', 'cultureGroup', 'culture']);
// 第二十三轮的两种（政体、派系）：资源库里有“生成国家…”的入口
export const GOV_KINDS: ReadonlySet<string> = new Set(['government', 'faction']);
// 第二十四轮的三种（城市等级、地标类型、点的类型）：资源库里有“生成城市… / 重新生成…”的入口
export const SETTLE_KINDS: ReadonlySet<string> = new Set(['cityRank', 'landmarkType', 'pointType']);

// ---------- 两棵树（第二十九轮）：左边本世界按来源的包分组，右边资源库按包 ----------

// 树的一个节点：一个资源包或其中的小包（本世界一栏里是来源的包；没有来源的归“离群”）
export interface TreeNode {
  // 列表里唯一的键
  key: string;
  name: string;
  description?: string;
  // 完整的路径：[资源库的键, 小包…]（本世界一栏是来源；离群的是 []）
  path: string[];
  // 资源库一栏：资源库里的键、这一层的包（整包添加用）
  entry?: string;
  node?: PackNode;
  // 本世界一栏的“离群”：本世界自己做的、来源不在资源库里的
  loose?: boolean;
  children: TreeNode[];
  // 直接在这一层的项
  rows: RepoRow[];
  // 整棵子树里的项数、其中在本世界的
  count: number;
  on: number;
}

export interface PackTree {
  world: TreeNode[];
  library: TreeNode[];
}

export const LOOSE_NAME = '离群';

const samePath = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, k) => x === b[k]);
const sourceOf = (e: LibraryEntry): RepoSource => (e.builtin ? 'builtin' : e.mine ? 'mine' : 'imported');

function finish(n: TreeNode): TreeNode {
  for (const c of n.children) finish(c);
  n.count = n.rows.length + n.children.reduce((a, c) => a + c.count, 0);
  n.on = n.rows.filter((r) => r.status.on).length + n.children.reduce((a, c) => a + c.on, 0);
  return n;
}

// 资源库里的一层（没有这几种的项时 null）
function libraryNode(e: LibraryEntry, node: PackNode, rel: string[], kinds: readonly ContentKind[], world: PackWorld | null, ctx: Ctx): TreeNode | null {
  const path = [e.key, ...rel];
  // 第三十轮：“通用 ▸ 基础”也是普通的包，能整包添加、移出没用到的（第二十九轮它只显示）
  const rows: RepoRow[] = [];
  for (const k of kinds) {
    for (const x of ownItems(node, k.pack.key)) {
      const id = itemId(k, x);
      rows.push({ kind: k, key: `l:${path.join('/')}:${k.id}:${id}`, id, name: itemName(k, x), item: x, source: sourceOf(e), pack: node, from: e.pack.name, entry: e.key, path, status: statusOf(k, x, node, world, false, ctx) });
    }
  }
  const children = subPacks(node)
    .map((c) => libraryNode(e, c, [...rel, c.id], kinds, world, ctx))
    .filter((c): c is TreeNode => c !== null);
  if (!rows.length && !children.length) return null;
  const desc = typeof node.description === 'string' ? node.description : undefined;
  return { key: `l:${path.join('/')}`, name: node.name, ...(desc ? { description: desc } : {}), path, entry: e.key, node, children, rows, count: 0, on: 0 };
}

// 本世界里的一项（都在本世界；星球形态不能移出。第三十轮起基础的内容也能移出）
function worldStatus(kind: ContentKind, item: unknown, world: PackWorld): RepoStatus {
  const id = itemId(kind, item);
  const def = kind.id === 'nameStyle' ? { isDefault: worldStyleId(world.small) === id } : {};
  if (!canApply(kind)) return { on: true, worldId: id, locked: kind.pack.note ?? '不能移出' };
  return { on: true, worldId: id, ...def };
}

// 本世界一栏的树：按来源的包分组（大包 ▸ 小包），先后照资源库；离群的放最后
function worldTree(world: PackWorld, lib: readonly LibraryEntry[], kinds: readonly ContentKind[]): TreeNode[] {
  const entryAt = new Map(lib.map((e, k) => [e.key, k]));
  // 每个资源库里的包里各小包的先后
  const order = new Map<string, Map<string, number>>();
  const orderIn = (e: LibraryEntry) => {
    let m = order.get(e.key);
    if (!m) {
      m = new Map();
      const mm = m;
      walkPacks(e.pack, (_n, p) => mm.set(p.join('/'), mm.size));
      order.set(e.key, m);
    }
    return m;
  };
  const tops = new Map<string, TreeNode>();
  const loose: TreeNode = { key: 'w:', name: LOOSE_NAME, path: [], loose: true, children: [], rows: [], count: 0, on: 0 };
  const nodeAt = (path: readonly string[]): TreeNode => {
    let top = tops.get(path[0]);
    const e = lib.find((x) => x.key === path[0]);
    if (!top) {
      top = { key: `w:${path[0]}`, name: e?.pack.name ?? path[0], path: [path[0]], ...(e ? { entry: e.key } : {}), children: [], rows: [], count: 0, on: 0 };
      tops.set(path[0], top);
    }
    let cur = top;
    for (let d = 1; d < path.length; d++) {
      const sub = path.slice(0, d + 1);
      let next = cur.children.find((c) => samePath(c.path, sub));
      if (!next) {
        const name = (e && findPack(e.pack, sub.slice(1))?.name) || sub[d];
        next = { key: `w:${sub.join('/')}`, name, path: sub, children: [], rows: [], count: 0, on: 0 };
        cur.children.push(next);
      }
      cur = next;
    }
    return cur;
  };
  for (const k of kinds) {
    for (const x of k.inWorld(world)) {
      const id = itemId(k, x);
      const origin = originOf(world.small, k.id, id, x);
      const row: RepoRow = {
        kind: k,
        key: `w:${k.id}:${id}`,
        id,
        name: itemName(k, x),
        item: x,
        source: 'world',
        pack: wrap(k, [x], `world-${k.id}`, '这个世界'),
        from: '',
        ...(origin ? { path: origin } : {}),
        status: worldStatus(k, x, world),
      };
      (origin?.length ? nodeAt(origin) : loose).rows.push(row);
    }
  }
  const sortKids = (n: TreeNode, e: LibraryEntry | undefined) => {
    if (e) {
      const m = orderIn(e);
      const at = (c: TreeNode) => m.get(c.path.slice(1).join('/')) ?? Infinity;
      n.children.sort((a, b) => at(a) - at(b));
    }
    for (const c of n.children) sortKids(c, e);
  };
  const list = [...tops.values()].sort((a, b) => (entryAt.get(a.path[0]) ?? Infinity) - (entryAt.get(b.path[0]) ?? Infinity));
  for (const t of list) sortKids(t, lib.find((x) => x.key === t.path[0]));
  if (loose.rows.length) list.push(loose);
  return list.map(finish);
}

// 两棵树：kind 是种类的 id（省略或 'all' 时是全部种类）。资源库一栏：内置的、我的、装上的，各是一棵树（共用的项在几个包里都列）
export function packTree(world: PackWorld | null, lib: readonly LibraryEntry[], kind?: string): PackTree {
  const k = kind && kind !== 'all' ? kindOf(kind) : undefined;
  const kinds = k ? [k] : repoKinds();
  const ctx: Ctx = new Map();
  const library = lib.map((e) => libraryNode(e, e.pack, [], kinds, world, ctx)).filter((n): n is TreeNode => n !== null).map(finish);
  return { world: world ? worldTree(world, lib, kinds) : [], library };
}

// 整棵子树里的项（按先后）
export function treeRows(n: TreeNode): RepoRow[] {
  return [...n.rows, ...n.children.flatMap(treeRows)];
}

// 搜索：名字、id 里有这几个字的项，和它们所在的包（包的名字对上时整个包都留着）
export function filterTree(nodes: readonly TreeNode[], query: string, hideOn = false): TreeNode[] {
  const q = query.trim().toLowerCase();
  if (!q && !hideOn) return [...nodes];
  const keep = (r: RepoRow) => !(hideOn && r.status.on) && (!q || r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q));
  const walk = (n: TreeNode): TreeNode | null => {
    const whole = !!q && n.name.toLowerCase().includes(q);
    const rows = n.rows.filter((r) => (whole && !(hideOn && r.status.on)) || keep(r));
    const children = n.children.map(walk).filter((c): c is TreeNode => c !== null);
    if (!rows.length && !children.length) return null;
    return finish({ ...n, rows, children });
  };
  return nodes.map(walk).filter((n): n is TreeNode => n !== null);
}

// 整包添加到本世界（资源库一栏的一个包或小包，只加列着的、还不在本世界的）：一整步，记上来源。没有能加的时 null
export function packAddCommand(n: TreeNode, world: PackWorld): Command | null {
  if (!n.node) return null;
  const picks: Record<string, string[]> = {};
  for (const r of treeRows(n)) {
    if (r.status.on || r.status.locked) continue;
    const key = r.kind.pack.key;
    (picks[key] ??= []).includes(r.id) || picks[key].push(r.id);
  }
  if (!Object.keys(picks).length) return null;
  const plan = planPack(world, n.node, { ...picks, defaultStyle: null }, { path: n.path });
  if (!plan.command.commands.length) return null;
  return { ...plan.command, label: `添加到本世界：“${n.name}”` };
}

// 整理时能移出的几种（tidy_content 逐项用“移出”的那条命令：放在 small.content 的，和生态、河湖的种类）
const TIDY_OPS = new Set(['biome', 'riverType', 'lakeType']);

// 本世界一栏的一个包“移出没用到的”：子树里能移出的项（在不在用、移出后地图变不变由 planTidy 判断）
export function packRemoveRefs(n: TreeNode): ContentRef[] {
  return treeRows(n)
    .filter((r) => r.status.on && !r.status.locked && !r.status.always && !r.status.isDefault && (r.kind.store === 'content' || TIDY_OPS.has(r.kind.id)))
    .map((r) => ({ kind: r.kind.id, id: r.status.worldId ?? r.id }));
}
