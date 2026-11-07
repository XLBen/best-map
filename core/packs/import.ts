import type { Command } from '../commands';
import { itemFields } from '../content/links';
import { type ContentKind, itemId, kindByPackKey } from '../content/registry';
import type { Culture, CultureGroup, Era, PopValue } from '../human/era';
import { PACK_MAX_SUBPACKS, type PackItem, type PackNode, type PackPicks, type PackPlan, type PackWorld, type ResourcePack, defaultPicks, findPack, firstOfEach, nestByKind, ownItems, packItems, packSections, pickedIds, planPack, renamedItem, settleIds, subPacks, walkPacks } from '../packs';
import { builtinPacks, DEFAULT_WORLD_PACKS, LIBRARY_BASE_PACKS } from './builtin-tree';

// 生成要用的内容从资源包加进世界（第三十轮）：时代就是资源包，生成只读世界里的内容，界面在生成之前先发这里给出的命令。
//
//   picks.packs   勾选的包（资源库里的路径：[资源库的键, 小包……]；内置的键就是库的 id，[“medieval”]、[“medieval”, “base”]），
//                 按勾选的先后。规则（时代项）取第一个带时代的包，维度也只用它的
//   picks.groups  选的文化组（省略时是勾选的包里的全部组，小包的比重是 0 的不算）
//   picks.extra   另外要加的包（路径 + 那个包里的勾选，省略为整个包）：比如单独挑的几个政体
//
// 从勾选的包里带进来：规则包的那一个时代项；各包里规则时代的维度的取值与取值组（第四十三轮）；全部的政体、派系、地标、资源、城市等级、点的类型；
// 文化只带选了的组（组、组里的文化、这些文化用的地名风格；勾选的包里没有的组在资源库里找第一个有它的小包）。
// 时代包（树里有时代项的）只带这几种：奇幻包里的生态、河湖要单独勾那几个小包（[“fantasy”, “biomes”]）；第五十一轮起库里世界的底子
// （LIBRARY_BASE_PACKS：基础、自然、地名……）也不带，新建世界时单独加（worldPartsOf）。库里比重是 0 的组的小包（别的 EU4 文化组）点名了才带，
// 点名的组加进世界时不带这个 0（用户就是要它参与）。
// 别的包（基础、自然、地名……）整个带进来（地名包里的风格都带）。星球形态不带（它在 set_worldgen 里）。同一项出现在几个包里时只带第一次出现的那一份，来源记它所在的包（planPack 的 from）。
// 世界里已有一模一样的跳过、同 id 不同内容的改名（与资源库里添加一样，见 packs.ts 的 planPack）。
// 最后把这几种的先后排成包里的先后（order_content）：整理掉、再生成时加回来的项排回原来的位置，
// 取值、政体、派系、文化的先后会影响挑哪一个，重新生成与第一次一样

// 资源库里的一个包：键（路径的第一段）与包本身。内置的大包就是 { key: pack.id, pack }
export interface PackRoot {
  key: string;
  pack: PackNode;
}

export interface ImportPicks {
  packs: readonly (readonly string[])[];
  groups?: readonly string[];
  extra?: readonly { path: readonly string[]; picks?: PackPicks }[];
  // 只补世界里没有的 id（第五十轮，已有的世界照旧的选择再生成时）：世界里有同 id 的（哪怕改过）就用世界里的，不加一份 id-2
  onlyMissing?: boolean;
}

export interface ImportPlan {
  // 要执行的命令（一个 batch；什么都不用加时为空）
  commands: Command[];
  // 规则用的时代（没有时 undefined：生成时不生成人文）
  era?: { id: string; path: string[] };
  // 带进来的文化组（选了的、勾选的包里有的）
  groups: string[];
  // 找不到的包（路径）
  missing: string[][];
  added: PackPlan['added'];
  skipped: PackPlan['skipped'];
}

// 生成后先后要紧的几种（见上）
const ORDERED = ['valueGroups', 'popValues', 'governments', 'factions', 'cultureGroups', 'cultures', 'landmarkTypes'];
// 时代包里带的几种（生成人文、国家、城市地标要用的，第五十一轮起还有基础之外的资源：奇幻自带；第七十三轮起还有时代用的国家格局）；时代包里别的（奇幻的生态、河湖）要单独勾那个小包
export const GEN_KEYS: ReadonlySet<string> = new Set(['eras', 'valueGroups', 'popValues', 'governments', 'factions', 'resources', 'cultureGroups', 'cultures', 'nameStyles', 'landmarkTypes', 'cityRanks', 'pointTypes', 'countryPatterns']);

const hasEra = (node: PackNode): boolean => {
  let yes = false;
  walkPacks(node, (n) => {
    if (ownItems(n, 'eras').length) yes = true;
  });
  return yes;
};

// 资源库里有这个文化组的小包：选着的库（prefer）里有就用它的（第五十二轮，比重是 0 也一样：来源记这个库）；
// 别的按资源库的先后，先找比重不是 0 的（同一组在几个库里，这些库默认带它），都是 0 时第一个
function findGroup(library: readonly (ResourcePack | PackRoot)[], id: string, prefer?: string): { node: PackNode; path: string[] } | undefined {
  let spare: { node: PackNode; path: string[] } | undefined;
  const roots = rootsOf(library);
  const chosen = roots.find((r) => r.key === prefer);
  if (chosen) {
    let hit: { node: PackNode; path: string[] } | undefined;
    walkPacks(chosen.pack, (n, rel) => {
      if (!hit && ownItems<CultureGroup>(n, 'cultureGroups').some((x) => x.id === id)) hit = { node: n, path: [chosen.key, ...rel] };
    });
    if (hit) return hit;
  }
  for (const r of roots) {
    let hit: { node: PackNode; path: string[] } | undefined;
    walkPacks(r.pack, (n, rel) => {
      if (hit) return;
      const g = ownItems<CultureGroup>(n, 'cultureGroups').find((x) => x.id === id);
      if (!g) return;
      if (n.weight !== 0 && g.weight !== 0) hit = { node: n, path: [r.key, ...rel] };
      else spare ??= { node: n, path: [r.key, ...rel] };
    });
    if (hit) return hit;
  }
  return spare;
}

const isRoot = (x: ResourcePack | PackRoot): x is PackRoot => 'pack' in x && 'key' in x && !('format' in x);
const rootsOf = (library: readonly (ResourcePack | PackRoot)[]): PackRoot[] => library.map((x) => (isRoot(x) ? x : { key: x.id, pack: x }));

// 按路径找包
export function packAt(library: readonly (ResourcePack | PackRoot)[], path: readonly string[]): PackNode | undefined {
  const root = rootsOf(library).find((r) => r.key === path[0]);
  return root && findPack(root.pack, path.slice(1));
}

const EMPTY_WORLD: PackWorld = { small: { species: [], featureNames: {}, provinces: {} } as unknown as PackWorld['small'], causes: { fields: {} } as PackWorld['causes'] };

// 生成要用的内容加进世界的计划（见文件开头）。world 省略时按一个空的世界算（新建世界）
export function packImportPlan(library: readonly (ResourcePack | PackRoot)[], picks: ImportPicks, world: PackWorld = EMPTY_WORLD): ImportPlan {
  const chosen: { path: string[]; node: PackNode; picks?: PackPicks; main: boolean }[] = [];
  const missing: string[][] = [];
  const wanted: { path: readonly string[]; picks?: PackPicks }[] = [...picks.packs.map((path) => ({ path })), ...(picks.extra ?? [])];
  wanted.forEach((p, k) => {
    const node = packAt(library, p.path);
    if (node) chosen.push({ path: [...p.path], node, main: k < picks.packs.length, ...(p.picks ? { picks: p.picks } : {}) });
    else missing.push([...p.path]);
  });
  // 规则：勾选的包里第一个带时代项的
  let era: ImportPlan['era'];
  for (const c of chosen.filter((x) => x.main)) {
    walkPacks(c.node, (n, rel) => {
      const e = ownItems<Era>(n, 'eras')[0];
      if (!era && e) era = { id: e.id, path: [...c.path, ...rel] };
    });
    if (era) break;
  }
  const ruleEra = era && (packAt(library, era.path) ? ownItems<Era>(packAt(library, era.path)!, 'eras').find((e) => e.id === era!.id) : undefined);
  const dims = new Set((ruleEra?.dimensions ?? []).map((d) => d.id));
  const named = picks.groups;
  const wantGroup = (id: string) => !named || named.includes(id);

  // 各段的项（同一个 id 只取第一次出现的）与它们的来源
  const items = new Map<string, PackItem[]>();
  const origin = new Map<string, string[]>();
  const seen = new Set<string>();
  const add = (key: string, x: unknown, path: string[]) => {
    const kind = kindByPackKey(key);
    const id = kind ? itemId(kind, x) : String(x);
    const at = `${key}\u0000${id}`;
    if (seen.has(at)) return;
    seen.add(at);
    origin.set(at, path);
    let l = items.get(key);
    if (!l) items.set(key, (l = []));
    l.push(x as PackItem);
  };
  const groups: string[] = [];
  const collect = (node: PackNode, base: string[], picks?: PackPicks) => {
    const own = (key: string, id: string) => {
      const ids = picks?.[key];
      return !picks || (Array.isArray(ids) && ids.includes(id));
    };
    // 时代包（树里有时代项）只带生成要用的几种；生态、河湖……要单独勾它们的小包
    const eraPack = hasEra(node);
    walkPacks(node, (n, rel) => {
      // 下面的小包：库里世界的底子不带；比重是 0 的组点名了才带（下面按 findGroup 找，和以前“勾选的包里没有的组”同一条路）
      if (rel.length && ((eraPack && LIBRARY_BASE_PACKS.has(rel[0])) || n.weight === 0)) return;
      const path = [...base, ...rel];
      // 文化组的小包：选了的组才带（组、组里的文化、它们用的地名风格）
      const nodeGroups = ownItems<CultureGroup>(n, 'cultureGroups');
      const cultures = ownItems<Culture>(n, 'cultures').filter((x) => wantGroup(x.group));
      // 文化没写风格时用文化组的（第四十三轮）
      const groupStyle = new Map(nodeGroups.map((g) => [g.id, g.nameStyle]));
      const styleUsed = new Set([...cultures.map((x) => x.nameStyle ?? groupStyle.get(x.group)), ...nodeGroups.filter((g) => wantGroup(g.id)).map((g) => g.nameStyle)]);
      const culturePack = nodeGroups.length > 0 || ownItems(n, 'cultures').length > 0;
      for (const [key, v] of Object.entries(n)) {
        if (!Array.isArray(v) || key === 'packs' || (eraPack && !GEN_KEYS.has(key))) continue;
        for (const x of v) {
          if (key === 'fields') {
            if (own(key, String(x))) add(key, x, path);
            continue;
          }
          const kind = kindByPackKey(key);
          if (!kind || !own(key, itemId(kind, x))) continue;
          if (key === 'planetForms') continue;
          if (key === 'eras' && !(era && era.id === (x as Era).id && era.path.join('/') === path.join('/'))) continue;
          if ((key === 'popValues' || key === 'valueGroups') && !dims.has((x as PopValue).dimension)) continue;
          if (key === 'cultureGroups') {
            const g = x as CultureGroup;
            if (!wantGroup(g.id)) continue;
            if (!groups.includes(g.id)) groups.push(g.id);
            // 点名了比重是 0 的组：用户就是要它参与
            if (g.weight === 0 && named) {
              const { weight: _, ...rest } = g;
              add(key, rest, path);
              continue;
            }
          }
          if (key === 'cultures' && !wantGroup((x as Culture).group)) continue;
          if (key === 'nameStyles' && culturePack && !styleUsed.has((x as { id: string }).id)) continue;
          add(key, x, path);
        }
      }
    });
  };
  for (const c of chosen) collect(c.node, c.path, c.picks);
  // 选了、勾选的包里却没有的文化组：在资源库里找（“还有 N 个文化组”里挑的）
  for (const g of picks.groups ?? []) {
    if (groups.includes(g)) continue;
    const at = findGroup(library, g, picks.packs[0]?.[0]);
    if (at) collect(at.node, at.path);
  }

  if (!items.size) return { commands: [], era, groups, missing, added: [], skipped: [] };

  // 合成一个包交给 planPack（每项的来源按它原来所在的包）
  const merged: PackNode = { id: 'import', name: '生成要用的内容' };
  const all: PackPicks = { defaultStyle: null };
  for (const [key, list] of items) {
    const kind = kindByPackKey(key);
    const have = picks.onlyMissing && kind ? new Set(kind.inWorld(world).map((x) => itemId(kind, x))) : null;
    const wantedHere = have ? list.filter((x) => !have.has(itemId(kind!, x))) : list;
    merged[key] = wantedHere;
    if (kind && key !== 'fields') all[key] = wantedHere.map((x) => itemId(kind, x));
  }
  const plan = planPack(world, merged, all, { origin: (key, id) => origin.get(`${key}\u0000${id}`), label: '添加生成要用的内容' });
  const cmds = [...plan.command.commands];
  // 先后排成包里的（改了名的按世界里的 id）
  const renamed = new Map(plan.added.map((a) => [`${a.section}\u0000${a.from}`, a.id]));
  const skippedTo = new Map(plan.skipped.map((a) => [`${a.section}\u0000${a.from}`, a.id]));
  for (const key of ORDERED) {
    const list = items.get(key);
    const kind = kindByPackKey(key);
    if (!list || !kind || list.length < 2) continue;
    const ids = list.map((x) => {
      const id = itemId(kind, x);
      return renamed.get(`${key}\u0000${id}`) ?? skippedTo.get(`${key}\u0000${id}`) ?? id;
    });
    cmds.push({ op: 'order_content', kind: kind.id, ids });
  }
  // 改了名的时代、文化组按世界里的 id 说（第四十九轮）；对应的来源路径不变
  const inWorld = (key: string, id: string) => renamed.get(`${key}\u0000${id}`) ?? skippedTo.get(`${key}\u0000${id}`) ?? id;
  return {
    commands: cmds.length ? [{ ...plan.command, commands: cmds }] : [],
    era: era && { ...era, id: inWorld('eras', era.id) },
    groups: groups.map((g) => inWorld('cultureGroups', g)),
    missing,
    added: plan.added,
    skipped: plan.skipped,
  };
}

// 把一个包里的内容导入另一个包（第四十九轮，第六十一轮的导入窗口用；“存进我的库”换同 id 的内容用 packs.ts 的 addToPack）：
// 和用到世界一样——一模一样的跳过（同一项只差 sameIgnore 的也算），同 id 不同内容的改名为 id-2，引用跟着改（引用表）。
// 不做加进世界的最后一步（“自然生成”还是包里写的样子）。按种类分小包放；一段满了的不放（列在 full 里）。原来的两个包都不动
export function importIntoPack(target: ResourcePack, source: PackNode, picks: PackPicks = defaultPicks(source)): { pack: ResourcePack; added: PackPlan['added']; skipped: PackPlan['skipped']; full: string[] } {
  const kinds = packSections();
  const picked = new Map(kinds.map((k) => [k, firstOfEach(k, packItems(source, k.pack.key), pickedIds(picks, k.pack.key))]));
  const there = new Map(kinds.map((k) => [k, packItems(target, k.pack.key)]));
  const { assigned, renames } = settleIds(kinds, picked, there, renamedItem);
  // 包是不改动的数据：只换走到的几层，别的和原来的包共用
  const out = nestByKind(target);
  const packs = [...subPacks(out)];
  // 文化组放进“文化”下面自己的小包（新世界才带得上，比重 0 的小包点名了才带）；文化跟着它的组；取值、取值组放进同一维的小包
  const inside = (id: string, node: PackNode) => subPacks(node).findIndex((c) => c.id === id);
  const put = (k: ContentKind, item: unknown) => {
    const key = k.pack.key;
    const cultures = packs.findIndex((n) => n.id === 'cultures');
    const up = cultures >= 0 ? packs[cultures] : null;
    if (up && k.id === 'cultureGroup') {
      const g = item as CultureGroup;
      if (inside(g.id, up) < 0 && subPacks(up).length < PACK_MAX_SUBPACKS) {
        packs[cultures] = { ...up, packs: [...subPacks(up), { id: g.id, name: String(g.name ?? g.id).slice(0, 60), weight: g.weight === 0 ? 0 : 1, cultureGroups: [item] }] };
        return;
      }
    }
    if (up && k.id === 'culture') {
      const at = subPacks(up).findIndex((c) => ownItems<CultureGroup>(c, 'cultureGroups').some((g) => g.id === (item as Culture).group));
      if (at >= 0) {
        const kids = [...subPacks(up)];
        kids[at] = { ...kids[at], cultures: [...ownItems(kids[at], 'cultures'), item] };
        packs[cultures] = { ...up, packs: kids };
        return;
      }
    }
    let at = -1;
    if (k.id === 'popValue' || k.id === 'valueGroup') {
      const dim = (item as PopValue).dimension;
      at = packs.findIndex((n) => n.id === dim || ownItems<PopValue>(n, key).some((v) => v.dimension === dim));
      if (at < 0 && dim && packs.length < PACK_MAX_SUBPACKS) at = packs.push({ id: dim, name: dim }) - 1;
    }
    if (at < 0) at = packs.findIndex((n) => n.id === key);
    if (at < 0) at = packs.push({ id: key, name: k.label }) - 1;
    packs[at] = { ...packs[at], [key]: [...ownItems(packs[at], key), item] };
  };
  const added: PackPlan['added'] = [];
  const skipped: PackPlan['skipped'] = [];
  const full: string[] = [];
  const fields = new Set<string>();
  const nameOf = (k: (typeof kinds)[number], x: unknown) => {
    const n = k.nameOf ? k.nameOf(x) : (x as { name?: unknown }).name;
    return typeof n === 'string' ? n : '';
  };
  for (const k of kinds) {
    const a = assigned.get(k)!;
    const key = k.pack.key;
    for (const x of picked.get(k)!) {
      const from = itemId(k, x);
      const id = a.ids.get(from)!;
      if (a.skip.has(from)) {
        skipped.push({ section: key, from, id, name: nameOf(k, x) || from });
        continue;
      }
      if (there.get(k)!.length + added.filter((y) => y.section === key).length >= k.pack.max) {
        full.push(`${k.label}“${nameOf(k, x) || from}”`);
        continue;
      }
      const item = structuredClone(renamedItem(k, x, id, renames));
      put(k, item);
      added.push({ section: key, from, id, name: nameOf(k, item) || id });
      for (const f of itemFields(k, item)) fields.add(f);
    }
  }
  // 用到的自定义场放在生态的小包里（没有生态时放在第一个小包）
  const have = new Set(packItems<string>(out, 'fields'));
  const newFields = [...fields].filter((f) => !have.has(f));
  if (newFields.length) {
    let at = packs.findIndex((n) => n.id === 'biomes');
    if (at < 0) at = 0;
    packs[at] = { ...packs[at], fields: [...ownItems<string>(packs[at], 'fields'), ...newFields] };
  }
  if (packs.length) out.packs = packs;
  return { pack: out, added, skipped, full };
}

// 同上，只要命令
export function packImportCommands(library: readonly (ResourcePack | PackRoot)[], picks: ImportPicks, world?: PackWorld): Command[] {
  return packImportPlan(library, picks, world).commands;
}

// 新世界要加的内容（默认的库里的基础、自然、中文地名……；packs 省略为它们）：新建的那一步里放在 set_worldgen 之前
export function newWorldContentCommands(library: readonly (ResourcePack | PackRoot)[] = builtinPacks(), packs: readonly (readonly string[])[] = DEFAULT_WORLD_PACKS): Command[] {
  return packImportCommands(library, { packs });
}
