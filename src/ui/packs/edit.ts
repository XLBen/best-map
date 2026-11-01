import type { Command } from '../../../core/commands';
import { ORIGIN_OPS } from '../../../core/content/origin';
import { type ContentKind, enableCommand, itemId, itemName } from '../../../core/content/registry';
import { type PackWorld, canApply, sameItem } from '../../../core/packs';
import { builtinOrigin } from '../../../core/packs/builtin-tree';
import { type Obj, freeId, isObj } from './fields';
import { type RepoRow, addCommand, builtinOriginal, canDeleteFromLibrary } from './repo';
import type { RepoEdit } from './store';

// 资源库右栏的编辑（第四十五轮）：选中一项就在右栏摊开它的字段，改了以后“用到本世界”“存进资源库”。
// 改内置的一项不再另起 id、名字带编号：用到本世界的就是同一个 id、同一个名字，本世界里写“改过”，能“恢复内置”。
// 左栏双击改名、拖动换先后（只限我的资源）。不碰界面，测试直接调

// 有自己编辑器的几种（编辑的是世界里的那一项）
export const DEDICATED: ReadonlySet<string> = new Set(['biome', 'riverType', 'lakeType', 'islandType']);

// 能在资源库里编辑：有字段表，不是星球形态（在“调整 → 星球形态”里改），不是有自己编辑器的
export const editable = (kind: ContentKind): boolean => !DEDICATED.has(kind.id) && kind.id !== 'planetForm' && kind.fields.length > 0;

// 世界里的那一项
export const worldItem = (kind: ContentKind, world: PackWorld | null, id: string): unknown => (world ? kind.inWorld(world).find((x) => itemId(kind, x) === id) : undefined);

// 选中一项时的编辑：在本世界的改世界里的那一份；不在的从资源库里那一份改起，用到本世界时记上它来自哪个包。
// 不能编辑的种类 null
export function startEdit(row: RepoRow, world: PackWorld | null): RepoEdit | null {
  if (!editable(row.kind)) return null;
  const wid = row.status.on ? (row.status.worldId ?? row.id) : undefined;
  const src = (wid !== undefined && worldItem(row.kind, world, wid)) || row.item;
  const item = structuredClone(src) as Obj;
  return { item, base: structuredClone(item) as Obj, how: 'edit', kind: row.kind.id, row: row.key, ...(wid !== undefined ? { worldId: wid } : {}), ...(wid === undefined && row.path ? { from: [...row.path] } : {}) };
}

// 改过（与开始时不一样）
export const isDirty = (edit: RepoEdit): boolean => !edit.base || !sameItem(edit.item, edit.base);

// “用到本世界”的命令：
// - 本世界里的：整项换掉（来源不变）；
// - 不在本世界、没改过的：照“添加”（按资源包的规则：先加用到的自定义场，撞 id 的改名）；
// - 不在本世界、改过的：同一个 id 加进来，记上来自哪个包（内置的就成了“改过”）；本世界里已有同 id 的另一份时另起 id。
export function applyEdit(edit: RepoEdit, kind: ContentKind, world: PackWorld, row?: RepoRow): Command | null {
  if (!canApply(kind)) return null;
  if (row && !row.status.on && !isDirty(edit) && edit.worldId === undefined) return addCommand(row, world);
  let item: Obj = edit.item;
  const name = itemName(kind, item);
  if (edit.worldId === undefined) {
    const id = itemId(kind, item);
    const there = worldItem(kind, world, id);
    if (there !== undefined && !sameItem(there, item) && !(edit.from && builtinOriginal(kind, there, world))) {
      const taken = new Set(kind.inWorld(world).map((x) => itemId(kind, x)));
      item = { ...item, id: freeId(id, taken) };
    }
  }
  let cmd = enableCommand(kind, item, world);
  const from = edit.from ?? (edit.how === 'edit' && edit.worldId === undefined ? builtinOrigin(kind.id, itemId(kind, item)) : undefined);
  if (from && ORIGIN_OPS.has(cmd.op) && edit.worldId === undefined) cmd = { ...cmd, from } as Command;
  const label = edit.worldId !== undefined ? `改${kind.label}“${name}”` : `添加到本世界：${kind.label}“${name}”`;
  return { op: 'batch', label, commands: [cmd] };
}

// 恢复内置：本世界里改过的内置项换回内置的原样（来源照旧是内置的树）。不是改过的内置项时 null
export function restoreCommand(kind: ContentKind, id: string, world: PackWorld): Command | null {
  const there = worldItem(kind, world, id);
  if (there === undefined) return null;
  const orig = builtinOriginal(kind, there, world);
  if (orig === null) return null;
  let cmd = enableCommand(kind, structuredClone(orig), world);
  const from = builtinOrigin(kind.id, id);
  if (from && ORIGIN_OPS.has(cmd.op)) cmd = { ...cmd, from } as Command;
  return { op: 'batch', label: `恢复内置：${kind.label}“${itemName(kind, orig)}”`, commands: [cmd] };
}

// ---------- 改名（双击） ----------

// 能改名的：本世界里的（能用到世界的种类）、我的资源里的；要有名字这个字段
export function canRename(row: RepoRow): boolean {
  if (!isObj(row.item) || typeof row.item.name !== 'string') return false;
  if (row.source === 'world') return canApply(row.kind) && !row.status.locked;
  return canDeleteFromLibrary(row);
}

// 改了名字的一项；名字不合格式（空的、太长）时说为什么
export function renamed(kind: ContentKind, item: unknown, name: string): { ok: true; item: Obj } | { ok: false; error: string } {
  const next = { ...(item as Obj), name: name.trim() };
  if (!next.name) return { ok: false, error: '名字不能空着' };
  const r = kind.schema.safeParse(next);
  if (!r.success) return { ok: false, error: r.error.issues.find((i) => i.path[0] === 'name')?.message ?? r.error.issues[0]?.message ?? '名字不合格式' };
  return { ok: true, item: next };
}

// 本世界里的一项改名的命令（一步，可以撤销）
export function renameCommand(row: RepoRow, name: string, world: PackWorld): { ok: true; cmd: Command } | { ok: false; error: string } {
  const id = row.status.worldId ?? row.id;
  const r = renamed(row.kind, worldItem(row.kind, world, id) ?? row.item, name);
  if (!r.ok) return r;
  return { ok: true, cmd: { op: 'batch', label: `改名为“${r.item.name as string}”`, commands: [enableCommand(row.kind, r.item, world)] } };
}

// ---------- 换先后（拖动） ----------

// 能拖动的：我的资源里的项（在同一个小包、同一种里换先后）。本世界里的先后是编号，换了人文的数据就乱了，不能拖
export const canReorder = (row: RepoRow): boolean => canDeleteFromLibrary(row) && !!row.path;

// 拖到同一个小包、同一种的另一项上
export const sameShelf = (a: RepoRow, b: RepoRow): boolean => a !== b && a.kind === b.kind && a.entry === b.entry && (a.path ?? []).join('/') === (b.path ?? []).join('/');

// 一段里把 from 挪到 to 的位置（按 id；找不到时不变）
export function reorderById(kind: ContentKind, list: readonly unknown[], from: string, to: string): unknown[] {
  const a = list.findIndex((x) => itemId(kind, x) === from);
  const b = list.findIndex((x) => itemId(kind, x) === to);
  if (a < 0 || b < 0 || a === b) return [...list];
  const out = [...list];
  const [x] = out.splice(a, 1);
  out.splice(b, 0, x);
  return out;
}
