import type { Command } from '../../../core/commands';
import { type ContentKind, disableCommand as kindDisable, itemId, itemName } from '../../../core/content/registry';
import { DEFAULT_STYLE, styleProblems, worldStyleId, type NameStyle } from '../../../core/name-styles';
import { PACK_FORMAT, PACK_VERSION, type PackWorld, type ResourcePack, canApply, packItems, packSections, planPack, sameItem } from '../../../core/packs';
import type { LibraryEntry } from '../../library';

// 仓库（世界 → 仓库）的逻辑：每一种内容在仓库里有哪些（内置的、我的、导入的，世界里有、仓库里没有的），
// 每一项在这个世界里启用了没有、开关是哪条命令（一整步，可以撤销），地名风格的“默认”。不碰界面，测试直接调

export type RepoSource = 'builtin' | 'mine' | 'imported' | 'world';
export type RepoFilter = 'all' | 'builtin' | 'mine' | 'imported' | 'on';

export const REPO_FILTERS: [RepoFilter, string][] = [
  ['all', '全部'],
  ['builtin', '内置'],
  ['mine', '我的'],
  ['imported', '导入的'],
  ['on', '在用'],
];

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
  // 总在世界里的内置项（第二十一轮：内置的地形类别、通用资源）：没有开关，写“内置·常开”
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
  // 它所在的包（启用时按资源包的规则加进世界：先加用到的自定义场，同 id 不同内容的改名）
  pack: ResourcePack;
  // 来自哪里（小字）
  from: string;
  // 资源库里的键（内置、我的、导入的）
  entry?: string;
  status: RepoStatus;
}

const wrap = (kind: ContentKind, items: readonly unknown[], id: string, name: string): ResourcePack => ({ format: PACK_FORMAT, version: PACK_VERSION, id, name, [kind.pack.key]: [...items] });

const isZh = (kind: ContentKind, id: string) => kind.id === 'nameStyle' && id === DEFAULT_STYLE;

// 一项在这个世界里的状态
// builtin：登记表里的内置项（不是资源库里的包）
function statusOf(kind: ContentKind, item: unknown, pack: ResourcePack, world: PackWorld | null, builtin = false): RepoStatus {
  const id = itemId(kind, item);
  if (!world) return { on: false, locked: '先新建或打开世界' };
  const inWorld = kind.inWorld(world);
  if (!canApply(kind)) {
    const on = inWorld.some((x) => itemId(kind, x) === id && sameItem(x, item));
    return { on, ...(on ? { worldId: id } : {}), locked: kind.pack.note ?? '不能启用' };
  }
  const isDefault = (wid: string) => (kind.id === 'nameStyle' ? { isDefault: worldStyleId(world.small) === wid } : {});
  if (isZh(kind, id)) return { on: true, worldId: DEFAULT_STYLE, locked: '内置中文总在', ...isDefault(DEFAULT_STYLE) };
  // 总在世界里的内置项（第二十一轮：内置的地形类别、通用资源）：开关不能动；世界里那一份改过时写“已修改”
  const always = kind.alwaysOn?.(id);
  if (always && builtin) {
    const cur = inWorld.find((x) => itemId(kind, x) === id);
    return { on: true, worldId: id, locked: always, always: true, ...(cur && !sameItem(cur, item) ? { modified: true } : {}) };
  }
  if (always && inWorld.some((x) => itemId(kind, x) === id && sameItem(x, item))) return { on: true, worldId: id, locked: always };
  // 世界里有一模一样的（内置的生态本来就在世界里）
  if (inWorld.some((x) => itemId(kind, x) === id && sameItem(x, item))) return { on: true, worldId: id, ...isDefault(id) };
  if (kind.id === 'nameStyle') {
    const bad = styleProblems(item as NameStyle);
    if (bad.length) return { on: false, locked: bad[0] };
  }
  // 按资源包的规则：加进世界时的样子（没写“自然生成”的关掉……）与世界里的一样就是启用着
  const plan = planPack(world, pack, { [kind.pack.key]: [id], defaultStyle: null });
  const skip = plan.skipped.find((x) => x.section === kind.pack.key && x.from === id);
  if (skip) return { on: true, worldId: skip.id, ...isDefault(skip.id) };
  const add = plan.added.find((x) => x.section === kind.pack.key && x.from === id);
  return { on: false, ...(add && add.id !== id ? { rename: add.name } : {}) };
}

// 一种内容在仓库里的全部（内置在前，之后是我的、导入的，最后是世界里有、仓库里没有的）
export function repoRows(kind: ContentKind, world: PackWorld | null, lib: readonly LibraryEntry[]): RepoRow[] {
  const rows: RepoRow[] = [];
  const push = (item: unknown, source: RepoSource, pack: ResourcePack, from: string, entry?: string, own = false) => {
    const id = itemId(kind, item);
    rows.push({ kind, key: `${source}:${entry ?? ''}:${id}`, id, name: itemName(kind, item), item, source, pack, from, ...(entry ? { entry } : {}), status: statusOf(kind, item, pack, world, own) });
  };
  // 内置：登记表里的、内置示例包里的（同一项只列一次）
  const own = kind.builtin?.() ?? [];
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
  // 世界里有、仓库里没有的（这个世界里做的、别人的世界带来的）
  if (world) {
    const covered = new Set(rows.flatMap((r) => (r.status.on && r.status.worldId ? [r.status.worldId] : [])));
    const items = kind.inWorld(world).filter((x) => !covered.has(itemId(kind, x)) && !isZh(kind, itemId(kind, x)));
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
      (filter === 'all' || (filter === 'on' ? r.status.on : r.source === filter)) &&
      (!entry || r.entry === entry) &&
      (!q || r.name.toLowerCase().includes(q) || r.id.toLowerCase().includes(q) || r.from.toLowerCase().includes(q)),
  );
}

const quoted = (r: RepoRow) => `${r.kind.label}“${r.name}”`;

// 启用：按资源包的规则（先加用到的自定义场；同 id 不同内容的改名加上）。一整步
export function enableRowCommand(row: RepoRow, world: PackWorld): Command {
  const plan = planPack(world, row.pack, { [row.kind.pack.key]: [row.id], defaultStyle: null });
  return { ...plan.command, label: `启用${quoted(row)}` };
}

// 停用：世界里的那一项。停用的是世界默认的地名风格时，世界默认一起换回内置中文
export function disableRowCommand(row: RepoRow, world: PackWorld): Command {
  const id = row.status.worldId ?? row.id;
  const off = kindDisable(row.kind, id, world);
  if (row.status.isDefault) return { op: 'batch', label: `停用${quoted(row)}`, commands: [{ op: 'set_name_style', id: null }, off] };
  return off;
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
    return { op: 'set_name_style', id: id === DEFAULT_STYLE ? null : id };
  }
  if (row.status.locked) return null;
  const plan = planPack(world, row.pack, { nameStyles: [row.id], defaultStyle: row.id });
  return { ...plan.command, label: `地名风格改为“${row.name}”` };
}

// 左边分类旁的数：这个世界里启用了几项
export function enabledCount(kind: ContentKind, world: PackWorld | null): number {
  return world ? kind.inWorld(world).length : 0;
}
