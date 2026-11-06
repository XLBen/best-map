import type { Command } from '../../../core/commands';
import { type ContentKind, type ContentUsage, type UsageWorld, disableCommand as kindDisable, itemId, itemName, usageOf } from '../../../core/content/registry';
import { recordedOrigin } from '../../../core/content/origin';
import { itemFields } from '../../../core/content/links';
import { worldMapStyleId } from '../../../core/map-style';
import { type NameStyle, styleProblems, worldStyleId } from '../../../core/name-styles';
import { PACK_FORMAT, PACK_VERSION, type PackNode, type PackWorld, type ResourcePack, canApply, ownItems, packIdFor, planPack, sameItem, subPacks } from '../../../core/packs';
import { builtinItem, isBuiltinSame, originOf } from '../../../core/packs/builtin-tree';
import type { LibraryEntry } from '../../library';

// 资源库面板列表里的一行（第六十三轮从旧面板的 repo.ts 留下来的）：这一项在这一份里、在这个世界里是什么状态，
// 移出本世界、设为默认是哪条命令，用在哪里，单独导出的样子。添加到本世界走 core/packs/closure.ts 的闭包（pick-add.ts）。不碰界面，测试直接调

// 有自己的详细编辑器的几种：生态的图表、河湖岛的脚本检查（世界里的一项有“详细编辑”）
export const DEDICATED: ReadonlySet<string> = new Set(['biome', 'riverType', 'lakeType', 'islandType']);

export interface RowStatus {
  // 在这个世界里
  on: boolean;
  // 世界里那一项的 id（同 id 不同内容时世界里的叫别的 id）
  worldId?: string;
  // 动不了：原因
  locked?: string;
  // 世界默认的地名风格、世界在用的画风
  isDefault?: boolean;
  // 库里的一行：世界里同 id 的一份是这一项改过的（不是“添加后叫 X 2”）
  modified?: boolean;
}

export interface ItemRow {
  kind: ContentKind;
  // 列表里唯一的键
  key: string;
  id: string;
  name: string;
  item: unknown;
  // 'world'：世界里的；'lib'：库里的
  source: 'world' | 'lib';
  // 在库的树里的位置 [库的键, 小包…]；世界里是记着的来源，没有来源的是这个世界自己做的
  path?: string[];
  // 所在的小包（库里的一行）
  pack?: PackNode;
  status: RowStatus;
}

// 世界默认的地名风格、世界在用的画风
function defaultMark(kind: ContentKind, world: PackWorld, id: string): Pick<RowStatus, 'isDefault'> {
  if (kind.id === 'nameStyle') return { isDefault: worldStyleId(world.small) === id };
  if (kind.id === 'mapStyle') return { isDefault: worldMapStyleId(world.small) === id };
  return {};
}

// 世界里的这一项是改过的内置项：来源记的是内置的库、内置的树里有同 id 的一项、内容不同。
// 只看整项换掉的种类（生态的命令按字段改，不在里面）
function builtinChanged(kind: ContentKind, there: unknown, world: PackWorld): boolean {
  if (!(canApply(kind) && (kind.store === 'content' || kind.id === 'riverType' || kind.id === 'lakeType' || kind.id === 'islandType'))) return false;
  const id = itemId(kind, there);
  const rec = recordedOrigin(world.small, kind.id, id);
  const b = builtinItem(kind.id, id);
  return !!rec && !!b && b.paths.some((p) => p[0] === rec[0]) && !isBuiltinSame(kind.id, there);
}

// 库里的一项在这个世界里的状态。inWorld：这一种在世界里的全部。builtin：看的是内置的库
function libStatus(kind: ContentKind, item: unknown, node: PackNode, world: PackWorld | null, inWorld: readonly unknown[], builtin: boolean): RowStatus {
  const id = itemId(kind, item);
  if (!world) return { on: false, locked: '先新建或打开世界' };
  if (!canApply(kind)) {
    const on = inWorld.some((x) => itemId(kind, x) === id && sameItem(x, item));
    return { on, ...(on ? { worldId: id } : {}), locked: kind.pack.note ?? '不能启用' };
  }
  const here = (wid: string): RowStatus => ({ on: true, worldId: wid, ...defaultMark(kind, world, wid) });
  if (inWorld.some((x) => itemId(kind, x) === id && sameItem(x, item))) return here(id);
  if (kind.id === 'nameStyle') {
    const bad = styleProblems(item as NameStyle);
    if (bad.length) return { on: false, locked: bad[0] };
  }
  const same = inWorld.find((x) => itemId(kind, x) === id);
  if (same === undefined) return { on: false };
  if (builtin && builtinChanged(kind, same, world)) return { ...here(id), modified: true };
  // 加进世界时的样子（没写“自然生成”的关掉……）与世界里的一样就是在本世界
  const plan = planPack(world, node, { [kind.pack.key]: [id], defaultStyle: null });
  const skip = plan.skipped.find((x) => x.section === kind.pack.key && x.from === id);
  return skip ? here(skip.id) : { on: false };
}

// 一个库里的一种：按小包走（同一项只列一次，第一个小包的），每一行写在不在本世界
export function libraryRows(e: LibraryEntry, kind: ContentKind, world: PackWorld | null): ItemRow[] {
  const inWorld = world ? kind.inWorld(world) : [];
  const out: ItemRow[] = [];
  const seen = new Set<string>();
  const walk = (node: PackNode, rel: readonly string[]) => {
    const path = [e.key, ...rel];
    for (const x of ownItems(node, kind.pack.key)) {
      const id = itemId(kind, x);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ kind, key: `l:${path.join('/')}:${kind.id}:${id}`, id, name: itemName(kind, x), item: x, source: 'lib', path, pack: node, status: libStatus(kind, x, node, world, inWorld, e.builtin) });
    }
    for (const c of subPacks(node)) walk(c, [...rel, c.id]);
  };
  walk(e.pack, []);
  return out;
}

// 世界里的一种：都在本世界（星球形态不能移出）
export function worldRows(kind: ContentKind, world: PackWorld): ItemRow[] {
  return kind.inWorld(world).map((x) => {
    const id = itemId(kind, x);
    const origin = originOf(world.small, kind.id, id, x);
    const status: RowStatus = canApply(kind) ? { on: true, worldId: id, ...defaultMark(kind, world, id) } : { on: true, worldId: id, locked: kind.pack.note ?? '不能移出' };
    return { kind, key: `w:${kind.id}:${id}`, id, name: itemName(kind, x), item: x, source: 'world', ...(origin ? { path: origin } : {}), status };
  });
}

// ---------- 用在哪里、移出 ----------

const quoted = (r: ItemRow) => `${r.kind.label}“${r.name}”`;

// 用在哪里：只看在本世界里的那一项（世界换了重算；同一个世界里按种类和 id 记着）
const usageCache = new WeakMap<object, Map<string, ContentUsage | null>>();
export function rowUsage(row: ItemRow, world: UsageWorld | null): ContentUsage | null {
  if (!world || !row.status.on) return null;
  const id = row.status.worldId ?? row.id;
  let m = usageCache.get(world);
  if (!m) usageCache.set(world, (m = new Map()));
  const key = `${row.kind.id}:${id}`;
  if (!m.has(key)) m.set(key, usageOf(row.kind, world, id));
  return m.get(key) ?? null;
}

// 移出本世界：一步。动不了、不在本世界、在用的（先把用到它的地方改掉）时 null。
// 移出世界默认的地名风格时默认一起换回内置中文，移出在用的画风时一起不选（按剩下的第一种画）
export function removeCommand(row: ItemRow, world: UsageWorld): Command | null {
  if (!row.status.on || row.status.locked || rowUsage(row, world)) return null;
  const off = kindDisable(row.kind, row.status.worldId ?? row.id, world);
  const unset: Command[] = !row.status.isDefault ? [] : [row.kind.id === 'mapStyle' ? { op: 'set_map_style', id: null } : { op: 'set_name_style', id: null }];
  return { op: 'batch', label: `移出本世界：${quoted(row)}`, commands: [...unset, off] };
}

// 地名风格设为世界默认：不在本世界的一起加进来（一步）。已经是默认时 null
export function defaultStyleCommand(row: ItemRow, world: PackWorld): Command | null {
  if (row.kind.id !== 'nameStyle' || row.status.isDefault) return null;
  if (row.status.on) return { op: 'set_name_style', id: row.status.worldId ?? row.id };
  if (row.status.locked || !row.pack) return null;
  const plan = planPack(world, row.pack, { nameStyles: [row.id], defaultStyle: row.id }, row.path ? { path: row.path } : {});
  return { ...plan.command, label: `地名风格改为“${row.name}”` };
}

// ---------- 存、导出 ----------

// 存进资源库的样子（只有世界里的一项）。不是时 null
export function saveableItem(row: ItemRow): unknown | null {
  if (row.source !== 'world') return null;
  return row.kind.pack.exportItem ? row.kind.pack.exportItem(row.item) : structuredClone(row.item);
}

// 单独一项导出成资源包文件：生态带上用到的自定义场；世界里的按导出的样子
export function itemPack(row: ItemRow): ResourcePack {
  const k = row.kind;
  const item = row.source === 'world' && k.pack.exportItem ? k.pack.exportItem(row.item) : structuredClone(row.item);
  const pack: ResourcePack = { format: PACK_FORMAT, version: PACK_VERSION, id: packIdFor(`${k.id}-${row.name}`), name: row.name, [k.pack.key]: [item] };
  const fields = itemFields(k, item);
  if (fields.length) pack.fields = [...new Set(fields)];
  return pack;
}
