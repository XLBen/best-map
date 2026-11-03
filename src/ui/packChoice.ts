import type { Command } from '../../core/commands';
import { itemId, kindByPackKey } from '../../core/content/registry';
import { recordedOrigin } from '../../core/content/origin';
import { type Culture, type CultureGroup, type Era, type Government, ruleEra, worldCultureGroups, worldEras } from '../../core/human';
import { type PackNode, type PackWorld, findPack, ownItems, packItems, subPacks, walkPacks } from '../../core/packs';
import { DEFAULT_LIBRARY, builtinPacks, worldPartsOf } from '../../core/packs/builtin-tree';
import { type ImportPicks, type PackRoot, packAt, packImportCommands, packImportPlan } from '../../core/packs/import';
import { type LibrarySwitchPlan, librarySwitchPlan, worldLibrary } from '../../core/packs/switch';
import type { World } from '../../core/world';
import type { LibraryEntry } from '../library';

// 选一个库（第五十二轮）：新建向导、“文化 ⋯”的生成人文与“换库、文化组…”共用。不碰界面，测试直接调。
//
// - 一个世界用一个库。用户定的：时代有自己的库，想要别的自己加进世界（奇幻世界里加意识形态和社会主义政体）。所以这里没有勾选的树：
//   内置的六个库和我的库里够完整的（isLibrary）列出来，选一个。
// - 文化组从这个库里列：小包写了权重的是默认带的，比重是 0 的收在“还有 N 个文化组（这个库默认不带）”里，勾上就参与。
//   世界里自己的、从别的库加来的组也列着，默认参与（beyondGroups）。
// - 加进世界的命令（core/packs/import.ts 的 packImportCommands，每项带 from）：
//   新建世界：库里世界的底子放在新建的那一步里（生成之前：生态、地形类别、地名风格要在生成时就有），时代、政体、选的文化组……与 generate_human 一起作为第二步。
//   已有的世界：只补世界里没有的 id，改过的留着；换了库时见 core/packs/switch.ts（旧库带来的、新库不带的移出，生成的命令带着名单）。

type Small = World['small'];
export type PackPath = readonly string[];

// ---------- 资源库 ----------

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

// 包的叫法：路径上的名字用 ▸ 连起来（“中世纪与近世 ▸ 基础”）；不在资源库里时用路径
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

// ---------- 库 ----------

// 够得上一个库：有时代，有至少一个带文化的文化组（生成人文用得起来）。
// 新建世界还要有世界的底子：基础和自然（不然地形类别、生态都是空的）
export function isLibrary(node: PackNode, newWorld = false): boolean {
  if (!hasEra(node)) return false;
  const groups = new Set(packItems<CultureGroup>(node, 'cultureGroups').filter((g) => g.weight !== 0).map((g) => g.id));
  if (!packItems<Culture>(node, 'cultures').some((c) => groups.has(c.group))) return false;
  return !newWorld || (!!findPack(node, ['base']) && !!findPack(node, ['nature']));
}

export interface LibraryOption {
  key: string;
  name: string;
  description?: string;
  builtin: boolean;
}
// 能选的库：内置的在前，再是我的、装上的里够完整的。newWorld：新建世界时的要求
export function libraryOptions(lib: readonly LibraryEntry[], newWorld = false): LibraryOption[] {
  const own = new Set(lib.filter((e) => !e.builtin).map((e) => e.key));
  return libRoots(lib)
    .filter((r) => isLibrary(r.pack, newWorld))
    .map((r) => ({ key: r.key, name: r.pack.name, ...(r.pack.description ? { description: r.pack.description } : {}), builtin: !own.has(r.key) }));
}

// 默认的库：中世纪与近世；没有时资源库里第一个够完整的
export function defaultLibrary(lib: readonly LibraryEntry[]): string | null {
  const roots = libRoots(lib);
  const hit = roots.find((r) => r.key === DEFAULT_LIBRARY && hasEra(r.pack)) ?? roots.find((r) => isLibrary(r.pack)) ?? roots.find((r) => hasEra(r.pack));
  return hit?.key ?? null;
}

// ---------- 选择 ----------

export interface PackChoice {
  // 选的库（资源库里的键）；一个能选的都没有时 null
  library: string | null;
  // 选的文化组与权重
  groups: { id: string; weight: number }[];
}

// 生成的命令里写的 packs（core 里还是路径的列表，世界文件的格式没变）
export const choicePacks = (c: Pick<PackChoice, 'library'>): string[][] => (c.library ? [[c.library]] : []);

// 规则与维度来自哪个库。资源库里找不到这个库时（删掉了）按世界里记着的来源找（small：已有的世界）
export interface RuleInfo {
  path: string[];
  name: string;
  era: Era;
}
export function libraryRule(library: string | null, lib: readonly LibraryEntry[], small?: Small | null): RuleInfo | undefined {
  if (!library) return undefined;
  const node = nodeAt(lib, [library]);
  const era = node && firstEra(node);
  if (era) return { path: [library], name: packLabel(lib, [library]), era };
  if (small && worldEras(small).length) {
    const hit = ruleEra(small, [[library]]);
    if (hit && recordedOrigin(small, 'era', hit.id)?.[0] === library) return { path: [library], name: packLabel(lib, [library]), era: hit };
  }
  return undefined;
}

// 库里的文化组（同一组只列一次）。weight：小包写的默认权重（0 是这个库默认不带的）
export interface GroupOption {
  group: CultureGroup;
  weight?: number;
  // 这一组的小包在资源库里的路径
  path: string[];
  // 组里有几个文化（这个库里的）
  cultures: number;
}
export function packGroups(library: string | null, lib: readonly LibraryEntry[]): GroupOption[] {
  const node = library ? nodeAt(lib, [library]) : undefined;
  if (!node) return [];
  const out: GroupOption[] = [];
  const cultures = packItems<Culture>(node, 'cultures');
  walkPacks(node, (n, rel) => {
    for (const g of ownItems<CultureGroup>(n, 'cultureGroups')) {
      if (out.some((x) => x.group.id === g.id)) continue;
      out.push({ group: g, ...(typeof n.weight === 'number' ? { weight: n.weight } : {}), path: [library!, ...rel], cultures: cultures.filter((c) => c.group === g.id).length });
    }
  });
  return out;
}

// 选上一个库时默认带的文化组：小包写了权重的；一个都没写权重时是库里的全部组（权重 1）。组自己的比重是 0 的不算（第五十轮：不参与生成）
export function defaultGroupsOf(node: PackNode): { id: string; weight: number }[] {
  const weighted: { id: string; weight: number }[] = [];
  const all: { id: string; weight: number }[] = [];
  walkPacks(node, (n) => {
    for (const g of ownItems<CultureGroup>(n, 'cultureGroups')) {
      if (g.weight === 0 || all.some((x) => x.id === g.id)) continue;
      all.push({ id: g.id, weight: 1 });
      if (typeof n.weight === 'number' && n.weight > 0) weighted.push({ id: g.id, weight: n.weight });
    }
  });
  return weighted.length ? weighted : all;
}

const worldOf = (small: Small): PackWorld => ({ small, causes: { fields: {} } }) as unknown as PackWorld;

// ---------- 换库 ----------

// 世界现在用的库
export { worldLibrary };

// 选的库和世界现在用的不一样时：换库的计划（新建世界、世界还没有用任何库时 null）。
// 面板每画一次都要问（拖滑块时也画），同一个世界里按库和文化组记着；世界变了就不算数
const switchMemo = { small: null as unknown, content: null as unknown, origin: null as unknown, countries: null as unknown, plans: new Map<string, LibrarySwitchPlan>() };
export function switchPlanOf(c: PackChoice, small: Small | null | undefined, lib: readonly LibraryEntry[]): LibrarySwitchPlan | null {
  if (!small || !c.library) return null;
  const from = worldLibrary(small);
  if (!from || from === c.library) return null;
  const ids = c.groups.map((g) => g.id);
  const key = JSON.stringify([from, c.library, ids]);
  const m = switchMemo;
  if (m.small !== small || m.content !== small.content || m.origin !== small.origin || m.countries !== small.countries) {
    m.small = small;
    m.content = small.content;
    m.origin = small.origin;
    m.countries = small.countries;
    m.plans.clear();
  }
  let plan = m.plans.get(key);
  if (!plan) m.plans.set(key, (plan = librarySwitchPlan(libRoots(lib), small, from, c.library, ids)));
  return plan;
}

// 世界里有、这个库不列的文化组：自己做的、从别的库加进来的（换库时要移出的不算）。默认参与生成，勾选可以去掉
export function beyondGroups(small: Small | null | undefined, library: string | null, lib: readonly LibraryEntry[]): CultureGroup[] {
  if (!small) return [];
  const offered = new Set(packGroups(library, lib).map((o) => o.group.id));
  const node = library ? nodeAt(lib, [library]) : undefined;
  const plan = node ? switchPlanOf({ library, groups: defaultGroupsOf(node) }, small, lib) : null;
  const gone = new Set((plan?.drop ?? []).filter((r) => r.kind === 'cultureGroup').map((r) => r.id));
  return worldCultureGroups(small).filter((g) => !offered.has(g.id) && !gone.has(g.id));
}

// ---------- 加进世界的命令 ----------

// 新建世界那一步里要加的小包：库里世界的底子（自己的库里没有这些小包时不算）
export function worldContentPacks(library: string | null, lib: readonly LibraryEntry[]): string[][] {
  return library ? worldPartsOf(library).filter((x) => nodeAt(lib, x)) : [];
}

// 新建世界那一步里加的内容（生态、地形类别、地名风格……）
export function worldContentCommands(c: Pick<PackChoice, 'library'>, lib: readonly LibraryEntry[]): Command[] {
  const packs = worldContentPacks(c.library, lib);
  return packs.length ? packImportCommands(libRoots(lib), { packs, groups: [] }) : [];
}

// 生成人文之前加的内容（库里生成要用的、选的文化组）。small 为 null：新建世界；已有的世界只补世界里没有的 id
// （世界里改过的不算撞名，以前生成后会清理掉多出来的 id-2，第五十轮不清理了）
export function humanImportPicks(c: PackChoice, small: Small | null | undefined): ImportPicks {
  const groups = c.groups.map((g) => g.id);
  return { packs: choicePacks(c), groups, ...(small ? { onlyMissing: true } : {}) };
}
export function humanImportCommands(c: PackChoice, small: Small | null | undefined, lib: readonly LibraryEntry[]): Command[] {
  return packImportCommands(libRoots(lib), humanImportPicks(c, small), small ? worldOf(small) : undefined);
}

// 从资源库加一项进本世界（档案里换成本世界没有的政体……）：一整步的命令与加进来后在世界里的 id（同 id 不同内容时改了名）
export function addFromLibrary(small: Small, lib: readonly LibraryEntry[], key: string, id: string, path: PackPath): { commands: Command[]; id: string } {
  const extra: { path: readonly string[]; picks: Record<string, string[]> }[] = [{ path, picks: { [key]: [id] } }];
  // 第五十三轮：政体带上它列的、世界里没有的派系（先找同一个库的），不留下找不到的引用
  if (key === 'governments') {
    const gov = findInLibrary<Government>(lib, key, id, [path])?.item;
    for (const fid of gov?.factions ?? []) {
      if (small.content?.faction?.[fid]) continue;
      const hit = findInLibrary<unknown>(lib, 'factions', fid, [path.slice(0, 1)]);
      if (hit) extra.push({ path: hit.path, picks: { factions: [fid] } });
    }
  }
  const plan = packImportPlan(libRoots(lib), { packs: [], extra }, worldOf(small));
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

// 这几个包里的一种（同 id 只取第一个）与它们所在的小包
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
