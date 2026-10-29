import type { Command } from '../../core/commands';
import { itemId, kindByPackKey } from '../../core/content/registry';
import { recordedOrigin } from '../../core/content/origin';
import { type Culture, type CultureGroup, type Era, ruleEra, worldEras } from '../../core/human';
import { type PackNode, type PackPicks, type PackWorld, ownItems, packItems, packSummary, subPacks, walkPacks } from '../../core/packs';
import { DEFAULT_WORLD_PACKS, FORMS_PATH, builtinPacks } from '../../core/packs/builtin-tree';
import { type ImportPicks, type PackRoot, packAt, packImportCommands, packImportPlan } from '../../core/packs/import';
import type { World } from '../../core/world';
import type { LibraryEntry } from '../library';

// 勾选资源包（第三十轮界面）：新建向导的“内容”、生成人文与“换时代、文化组…”共用。不碰界面，测试直接调。
//
// - 资源库里的包（内置的、我的、装上的一视同仁，都从 library.value 读）按树列成勾选框；勾一个包就是整个包（小包跟着勾上、变灰）。
// - 勾选的先后就是包的先后：规则与维度取第一个带时代项的包（“规则与维度：中世纪与近世”），别的包提供政体、派系、文化、取值、
//   生态……；“设为规则”把一个勾着的时代包挪到最前面。
// - 文化组从勾选的包里列（时代包的“文化 ▸ 组”带默认的权重）：勾上一个包时它默认带的组跟着勾上，去掉时它的组跟着去掉。
// - 加进世界的命令（core/packs/import.ts 的 packImportCommands，每项带 from）：
//   新建世界：不带时代的包整个加进来，放在新建的那一步里（生成之前：生态、地形类别、地名风格要在生成时就有）；
//   时代包只带生成要用的（时代、取值、政体、派系、地标、选的文化组……），与 generate_human 一起作为第二步。
//   已有的世界：时代包同上；不带时代的包已经在用的（世界里有来自它的内容，或上次生成时勾过）只补生成后会清理掉的几种
//   （政体、派系、取值、文化），不把自己移出的基础内容又加回来；新勾的整个加进来。

type Small = World['small'];
export type PackPath = readonly string[];

// 新建向导默认勾上的时代包（没有时是资源库里第一个时代包）
export const DEFAULT_ERA_PACK = 'medieval';

// ---------- 路径、树 ----------

export const samePath = (a: PackPath, b: PackPath): boolean => a.length === b.length && a.every((x, k) => b[k] === x);
// path 在 pack 下面（或就是它）
export const underPath = (path: PackPath, pack: PackPath): boolean => pack.length <= path.length && pack.every((x, k) => path[k] === x);
export const pathKey = (p: PackPath): string => p.join('/');

// 资源库的包（内置的大包在前，再是我的、装上的；lib 里没有内置的时（测试）补上内置的）
export function libRoots(lib: readonly LibraryEntry[]): PackRoot[] {
  const builtin = lib.some((e) => e.builtin) ? lib.filter((e) => e.builtin).map((e) => ({ key: e.key, pack: e.pack as PackNode })) : builtinPacks().map((p) => ({ key: p.id, pack: p as PackNode }));
  return [...builtin, ...lib.filter((e) => !e.builtin).map((e) => ({ key: e.key, pack: e.pack as PackNode }))];
}

export const nodeAt = (lib: readonly LibraryEntry[], path: PackPath): PackNode | undefined => packAt(libRoots(lib), path);

// 树里（自己或小包里）有时代项
export function hasEra(node: PackNode): boolean {
  return firstEra(node) !== undefined;
}
function firstEra(node: PackNode): Era | undefined {
  let era: Era | undefined;
  walkPacks(node, (n) => {
    era ??= ownItems<Era>(n, 'eras')[0];
  });
  return era;
}

// 包的叫法：路径上的名字用 ▸ 连起来（“通用 ▸ 基础”）；不在资源库里时用路径
export function packLabel(lib: readonly LibraryEntry[], path: PackPath): string {
  const root = libRoots(lib).find((r) => r.key === path[0]);
  if (!root) return path.join(' ▸ ');
  const names = [root.pack.name];
  let cur: PackNode | undefined = root.pack;
  for (const id of path.slice(1)) {
    cur = cur && subPacks(cur).find((c) => c.id === id);
    names.push(cur?.name ?? id);
  }
  return names.join(' ▸ ');
}

// 一个包旁边的灰字：时代包写“时代”，别的写里面有什么（最多两种）
export function packHint(node: PackNode): string {
  if (hasEra(node)) return '时代';
  const parts = packSummary(node).split(' · ');
  return parts.length > 2 ? `${parts.slice(0, 2).join(' · ')}…` : parts.join(' · ');
}

// ---------- 勾选 ----------

export interface PackChoice {
  // 勾选的包（资源库里的路径，按勾选的先后）
  packs: string[][];
  // 选的文化组与权重
  groups: { id: string; weight: number }[];
}

// 一个包的勾选状态：on 自己勾着；covered 上一层勾着（整个包都在）；partial 下面有勾着的小包；off 没勾
export type PackState = 'on' | 'covered' | 'partial' | 'off';
export function packState(packs: readonly PackPath[], path: PackPath): PackState {
  if (packs.some((p) => samePath(p, path))) return 'on';
  if (packs.some((p) => p.length < path.length && underPath(path, p))) return 'covered';
  if (packs.some((p) => p.length > path.length && underPath(p, path))) return 'partial';
  return 'off';
}

// 规则与维度来自哪个包：勾选的包里第一个带时代项的（era 是资源库里那个包的第一个时代项）。
// 资源库里找不到这个包时（删掉了）按世界里记着的来源找（small：已有的世界）
export interface RuleInfo {
  path: string[];
  name: string;
  era: Era;
}
export function rulePack(packs: readonly PackPath[], lib: readonly LibraryEntry[], small?: Small | null): RuleInfo | undefined {
  for (const p of packs) {
    const node = nodeAt(lib, p);
    const era = node && firstEra(node);
    if (era) return { path: [...p], name: packLabel(lib, p), era };
  }
  if (small && worldEras(small).length) {
    const era = ruleEra(small, packs);
    const p = era && packs.find((x) => underPath(recordedOrigin(small, 'era', era.id) ?? [], x));
    if (era && p) return { path: [...p], name: packLabel(lib, p), era };
  }
  return undefined;
}

// 勾选的包里的文化组（按包的先后、包里的先后；同一组只列一次）。weight：小包写的默认权重；pack：勾着的那个包的叫法
export interface GroupOption {
  group: CultureGroup;
  weight?: number;
  // 这一组的小包在资源库里的路径
  path: string[];
  // 勾着的包（列表按它分段）
  pack: string[];
  // 组里有几个文化（这个包里的）
  cultures: number;
}
export function packGroups(packs: readonly PackPath[], lib: readonly LibraryEntry[]): GroupOption[] {
  const out: GroupOption[] = [];
  for (const p of packs) {
    const node = nodeAt(lib, p);
    if (!node) continue;
    const cultures = packItems<Culture>(node, 'cultures');
    walkPacks(node, (n, rel) => {
      for (const g of ownItems<CultureGroup>(n, 'cultureGroups')) {
        if (out.some((x) => x.group.id === g.id)) continue;
        out.push({ group: g, ...(typeof n.weight === 'number' ? { weight: n.weight } : {}), path: [...p, ...rel], pack: [...p], cultures: cultures.filter((c) => c.group === g.id).length });
      }
    });
  }
  return out;
}

// 勾上一个包时跟着勾上的文化组：小包写了权重的（时代包默认带的）；一个都没写权重时是包里的全部组（权重 1）
export function defaultGroupsOf(node: PackNode): { id: string; weight: number }[] {
  const weighted: { id: string; weight: number }[] = [];
  const all: { id: string; weight: number }[] = [];
  walkPacks(node, (n) => {
    for (const g of ownItems<CultureGroup>(n, 'cultureGroups')) {
      if (all.some((x) => x.id === g.id)) continue;
      all.push({ id: g.id, weight: 1 });
      if (typeof n.weight === 'number' && n.weight > 0) weighted.push({ id: g.id, weight: n.weight });
    }
  });
  return weighted.length ? weighted : all;
}

// 勾上、去掉一个包。勾上：排在最后（下面勾着的小包并进来），它默认带的文化组跟着勾上；
// 去掉：它（与下面的小包）不再勾着，只由它提供的文化组跟着去掉
export function togglePack<T extends PackChoice>(c: T, path: PackPath, on: boolean, lib: readonly LibraryEntry[]): T {
  if (on) {
    if (packState(c.packs, path) === 'on' || packState(c.packs, path) === 'covered') return c;
    const packs = [...c.packs.filter((p) => !underPath(p, path)), [...path]];
    const node = nodeAt(lib, path);
    const add = (node ? defaultGroupsOf(node) : []).filter((g) => !c.groups.some((x) => x.id === g.id));
    return { ...c, packs, groups: [...c.groups, ...add] };
  }
  const packs = c.packs.filter((p) => !underPath(p, path));
  const before = new Set(packGroups(c.packs.filter((p) => underPath(p, path)), lib).map((g) => g.group.id));
  const still = new Set(packGroups(packs, lib).map((g) => g.group.id));
  return { ...c, packs, groups: c.groups.filter((g) => !before.has(g.id) || still.has(g.id)) };
}

// 把一个勾着的时代包挪到最前面：规则与维度改用它的
export function makeRule<T extends PackChoice>(c: T, path: PackPath): T {
  const k = c.packs.findIndex((p) => samePath(p, path));
  if (k <= 0) return c;
  return { ...c, packs: [c.packs[k], ...c.packs.filter((_, j) => j !== k)] };
}

// 新建向导默认勾上的：基础、自然、中文地名、星球形态、中世纪与近世（资源库里有的）
export function defaultPacks(lib: readonly LibraryEntry[]): string[][] {
  const roots = libRoots(lib);
  const era = roots.find((r) => r.key === DEFAULT_ERA_PACK && hasEra(r.pack)) ?? roots.find((r) => hasEra(r.pack));
  return [...DEFAULT_WORLD_PACKS, FORMS_PATH, ...(era ? [[era.key]] : [])].filter((p) => nodeAt(lib, p)).map((p) => [...p]);
}

// 已有的世界里在用的包：上次生成时勾过的，或者世界里有来自它的内容（新建时加进来的基础、自然、中文地名……）
export function inUse(small: Small, path: PackPath): boolean {
  if (small.human?.packs.some((p) => samePath(p, path))) return true;
  for (const byId of Object.values(small.origin ?? {})) for (const rec of Object.values(byId)) if (underPath(rec, path)) return true;
  return false;
}

// 已有的世界第一次生成人文时默认勾上的：默认的几个包里在用的，加上默认的时代包（星球形态与生成人文无关，不勾）
export function worldDefaultPacks(small: Small, lib: readonly LibraryEntry[]): string[][] {
  const all = defaultPacks(lib);
  return all.filter((p) => {
    const node = nodeAt(lib, p);
    return (node && hasEra(node)) || inUse(small, p);
  });
}

// ---------- 加进世界的命令 ----------

// 生成之后会清理掉的几种（core/human/prune.ts）：已经在用的包再生成时只补这几种
const PRUNED = ['popValues', 'governments', 'factions', 'cultureGroups', 'cultures', 'nameStyles'];
function prunedPicks(node: PackNode): PackPicks {
  const picks: PackPicks = {};
  for (const key of PRUNED) {
    const kind = kindByPackKey(key);
    if (kind) picks[key] = packItems(node, key).map((x) => itemId(kind, x));
  }
  return picks;
}

const worldOf = (small: Small): PackWorld => ({ small, causes: { fields: {} } }) as unknown as PackWorld;

// 勾选的包分成带时代的与不带的（各按勾选的先后）
export function splitPacks(packs: readonly PackPath[], lib: readonly LibraryEntry[]): { era: string[][]; other: string[][] } {
  const era: string[][] = [];
  const other: string[][] = [];
  for (const p of packs) {
    const node = nodeAt(lib, p);
    (node && hasEra(node) ? era : other).push([...p]);
  }
  return { era, other };
}

// 新建世界那一步里加的内容：不带时代的包整个加进来（生态、地形类别、地名风格……）。
// human：要生成人文时只带选了的文化组（不选的组的文化不加进来）
export function worldContentCommands(c: PackChoice, lib: readonly LibraryEntry[], human = true): Command[] {
  const { other } = splitPacks(c.packs, lib);
  if (!other.length) return [];
  const offered = new Set(packGroups(other, lib).map((g) => g.group.id));
  const groups = c.groups.map((g) => g.id).filter((id) => offered.has(id));
  return packImportCommands(libRoots(lib), { packs: other, ...(human ? { groups } : {}) });
}

// 生成人文之前加的内容（时代包里生成要用的、选的文化组）。small 为 null：新建世界（不带时代的包已经在第一步里加了）；
// 已有的世界见文件开头
export function humanImportPicks(c: PackChoice, small: Small | null | undefined, lib: readonly LibraryEntry[]): ImportPicks {
  const { era, other } = splitPacks(c.packs, lib);
  const ids = c.groups.map((g) => g.id);
  if (!small) {
    const offered = new Set(packGroups(other, lib).map((g) => g.group.id));
    return { packs: era, groups: ids.filter((id) => !offered.has(id)) };
  }
  const extra = other.flatMap((p) => {
    const node = nodeAt(lib, p);
    if (!node) return [];
    return [inUse(small, p) ? { path: p, picks: prunedPicks(node) } : { path: p }];
  });
  return { packs: era, groups: ids, ...(extra.length ? { extra } : {}) };
}
export function humanImportCommands(c: PackChoice, small: Small | null | undefined, lib: readonly LibraryEntry[]): Command[] {
  return packImportCommands(libRoots(lib), humanImportPicks(c, small, lib), small ? worldOf(small) : undefined);
}

// 从资源库加一项进本世界（档案里换成本世界没有的政体……）：一整步的命令与加进来后在世界里的 id（同 id 不同内容时改了名）
export function addFromLibrary(small: Small, lib: readonly LibraryEntry[], key: string, id: string, path: PackPath): { commands: Command[]; id: string } {
  const plan = packImportPlan(libRoots(lib), { packs: [], extra: [{ path, picks: { [key]: [id] } }] }, worldOf(small));
  const hit = [...plan.added, ...plan.skipped].find((a) => a.section === key && a.from === id);
  return { commands: plan.commands, id: hit?.id ?? id };
}

// 资源库里一项所在的小包：先找 packs（世界用的包）里的，再找整个资源库（按资源库的先后）
export function findInLibrary<T>(lib: readonly LibraryEntry[], key: string, id: string, packs: readonly PackPath[] = []): { item: T; path: string[] } | undefined {
  const kind = kindByPackKey(key);
  const idOf = (x: unknown) => (kind ? itemId(kind, x) : (x as { id?: string }).id);
  const search = (node: PackNode, base: readonly string[]): { item: T; path: string[] } | undefined => {
    let hit: { item: T; path: string[] } | undefined;
    walkPacks(node, (n, rel) => {
      if (hit) return;
      const x = ownItems<T>(n, key).find((y) => idOf(y) === id);
      if (x) hit = { item: x, path: [...base, ...rel] };
    });
    return hit;
  };
  for (const p of packs) {
    const node = nodeAt(lib, p);
    const hit = node && search(node, p);
    if (hit) return hit;
  }
  for (const r of libRoots(lib)) {
    const hit = search(r.pack, [r.key]);
    if (hit) return hit;
  }
  return undefined;
}

// 勾选的包里的一种（同 id 只取第一个）与它们所在的小包
export function itemsInPacks<T>(packs: readonly PackPath[], lib: readonly LibraryEntry[], key: string): { item: T; path: string[] }[] {
  const kind = kindByPackKey(key);
  const out: { item: T; path: string[] }[] = [];
  const seen = new Set<string>();
  for (const p of packs) {
    const node = nodeAt(lib, p);
    if (!node) continue;
    walkPacks(node, (n, rel) => {
      for (const x of ownItems<T>(n, key)) {
        const id = kind ? itemId(kind, x) : String((x as { id?: string }).id);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ item: x, path: [...p, ...rel] });
      }
    });
  }
  return out;
}
