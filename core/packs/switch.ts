import type { Command } from '../commands';
import { dependencyClosure, linkTable, worldScope } from '../content/links';
import { originSourceId, originTarget, recordedOrigin } from '../content/origin';
import { sameItem } from '../content/refs';
import { type ContentKind, type ContentWorld, contentItems, itemId, kindByPackKey, kindOf, usageOf } from '../content/registry';
import { type ContentRef, withoutItems } from '../content/unused';
import { type Dimension, type Era, worldEra } from '../human/era';
import { styleInUse } from '../name-styles';
import { ownItems, walkPacks } from '../packs';
import type { World } from '../world';
import { worldPartsOf } from './builtin-tree';
import { GEN_KEYS, type PackRoot, packAt, packImportCommands, packImportPlan } from './import';

// 已有的世界换一个库（第五十二轮）。用户定的：一个世界用一个库；想要别的，自己加进世界。所以换库时：
//   新库要带的、世界里没有的 id 加进来（照第一次新建的两步：世界的底子、库里生成要用的）；
//   来自旧库、新库不带的移出；两个库都带的留着，来源改写到新库（不然下一次换库就认不出它来自哪里）；
//   本世界自己做的、从别的库单独加的不动，照旧参与生成。
// “来自旧库”看 small.origin 和来源里的 id（originSourceId）。“新库带”看的是一个新世界用这个库、这几个文化组会带什么，不是库的整棵树：
// 四个历史库都有全部 EU4 文化组（比重 0），每个库的“地名”下面都有全部风格，按树算的话中世纪换现代一个文化都移不掉。
// 只管生成要用的几种（GEN_KEYS）。生态、河、湖、地形类别、岛、画风、国家等级不动：它们改的是地图本身，换库不该让河变样；
// 奇幻的生态、河、湖也因此不跟着来去（第五十七轮起新建奇幻世界时带上，已有的世界换过来时不带）。
// 生成之后还会在的东西用到的不移（锁定的国家的政体和文化、自己放的城市的等级、省份的地名风格……）：见 survivors。
// 算好的名单放进生成的命令（switchLibrary），计算 Worker 只照着做，生成里不加筛选

type Small = World['small'];
const keyOf = (kind: string, id: string) => `${kind}\u0000${id}`;
// 人口、国家的格都要重新生成：查“还在用”时不看
const NO_CAUSES = { fields: {} } as unknown as World['causes'];

// 换库时会动的种类。先后：先移用到别的项的（文化在文化组之前，文化、文化组在地名风格之前）
const SWITCH_KINDS = ['government', 'faction', 'popValue', 'valueGroup', 'culture', 'cultureGroup', 'nameStyle', 'era', 'countryPattern', 'resource', 'landmarkType', 'cityRank', 'pointType'] as const;

export interface LibrarySwitchPlan {
  // 加进世界的（一步或两步，生成之前执行）
  imports: Command[];
  // 移出的、改写来源的（生成的命令带着）
  drop: ContentRef[];
  rehome: { kind: string; id: string; from: string[] }[];
  // 来自旧库、新库不带，但还在用，留下的
  kept: ContentRef[];
  // 新加进世界的有几项
  added: number;
}

const flat = (cmds: readonly Command[]): Command[] => cmds.flatMap((c) => (c.op === 'batch' ? flat(c.commands) : [c]));

// 世界现在用的库（资源库里的键）：有人文时是规则的时代的来源（第一次生成写在 genStamp 里）；没有人文时是世界的底子的来源；都没有时 undefined
export function worldLibrary(small: Pick<Small, 'human' | 'genStamp' | 'origin' | 'content'>): string | undefined {
  if (small.human) {
    const era = worldEra(small);
    return (era && recordedOrigin(small, 'era', era.id)?.[0]) ?? small.genStamp?.packs[0]?.[0];
  }
  for (const byId of Object.values(small.origin ?? {})) for (const path of Object.values(byId)) return path[0];
  return undefined;
}

// 一个新世界用这个库、这几个文化组会带什么：种类 + id → 来源的路径、那一项
function broughtBy(library: readonly PackRoot[], to: string, groups: readonly string[]): Map<string, { path: string[]; item: unknown }> {
  const parts = worldPartsOf(to).filter((p) => packAt(library, p));
  const out = new Map<string, { path: string[]; item: unknown }>();
  const cmds = [...packImportCommands(library, { packs: parts, groups: [] }), ...packImportCommands(library, { packs: [[to]], groups })];
  for (const c of flat(cmds)) {
    const target = originTarget(c);
    const from = (c as { from?: string[] }).from;
    if (!target || !from) continue;
    const at = keyOf(target.kind, target.id);
    if (!out.has(at)) out.set(at, { path: from, item: (c as { item?: unknown }).item });
  }
  return out;
}

// 生成之后还会在的：锁定的国家、发源地（在新选的组里的），自己放的和锁定的城市、地标，自定义点；人口和自动的都会换掉
function survivors(small: Small, groups: readonly string[]): Small {
  const h = small.human;
  const chosen = new Set(groups);
  const keepAuto = <T extends { auto?: boolean; locked?: boolean }>(all: Record<string, T> | undefined) => (all ? Object.fromEntries(Object.entries(all).filter(([, x]) => !x.auto || x.locked)) : undefined);
  const { popGroups: _, ...rest } = small;
  return {
    ...rest,
    ...(h ? { human: { ...h, era: '', groups: [...groups], hearths: h.hearths.filter((x) => x.locked && chosen.has(x.group)) } } : {}),
    countries: Object.fromEntries(Object.entries(small.countries ?? {}).filter(([, c]) => c.locked)),
    cities: keepAuto(small.cities),
    landmarks: keepAuto(small.landmarks),
  } as Small;
}

// 旧库里这一项（比较世界里的有没有改过）
function itemIn(library: readonly PackRoot[], rootKey: string, kind: ContentKind, id: string): unknown {
  const root = library.find((r) => r.key === rootKey);
  if (!root) return undefined;
  let hit: unknown;
  walkPacks(root.pack, (n) => {
    hit ??= ownItems<unknown>(n, kind.pack.key).find((x) => itemId(kind, x) === id);
  });
  return hit;
}

// 世界自己加的、新库的时代没有的维度（要带到新时代）
function carriedDims(library: readonly PackRoot[], small: Small, era: { id: string; path: string[] } | undefined): readonly Dimension[] {
  const added = worldEra(small)?.dimensions.filter((d) => d.added) ?? [];
  if (!added.length || !era) return [];
  const node = packAt(library, era.path);
  const own = [...(node ? ownItems<Era>(node, 'eras').find((e) => e.id === era.id)?.dimensions ?? [] : []), ...(contentItems<Era>(small, 'era')[era.id]?.dimensions ?? [])];
  return added.filter((d) => !own.some((x) => x.id === d.id));
}

// from 换到 to 的计划。groups：新选的文化组（默认的、勾上的、世界里自己的）。世界里的项没有来源的、来源是别的库的都不动
export function librarySwitchPlan(library: readonly PackRoot[], small: Small, from: string | undefined, to: string, groups: readonly string[]): LibrarySwitchPlan {
  const world = { small, causes: NO_CAUSES } as ContentWorld & NonNullable<Parameters<typeof packImportPlan>[2]>;
  const brought = broughtBy(library, to, groups);
  const candidates: ContentRef[] = [];
  const rehome: LibrarySwitchPlan['rehome'] = [];
  const replace: Command[] = [];
  const second = packImportPlan(library, { packs: [[to]], groups, onlyMissing: true }, world);
  const carried = carriedDims(library, small, second.era);
  for (const kindId of SWITCH_KINDS) {
    const k = kindOf(kindId)!;
    for (const x of k.inWorld(world)) {
      const id = itemId(k, x);
      if ((kindId === 'popValue' || kindId === 'valueGroup') && carried.some((d) => d.id === (x as { dimension: string }).dimension)) continue;
      const rec = recordedOrigin(small, kindId, id);
      if (!rec || rec[0] !== from) continue;
      const src = originSourceId(small, kindId, id);
      const hit = brought.get(keyOf(kindId, src));
      if (!hit) {
        candidates.push({ kind: kindId, id });
        continue;
      }
      if (rec.join('/') !== hit.path.join('/')) rehome.push({ kind: kindId, id, from: hit.path });
      // 两个库的同一项内容不同（我的库改过），世界里的又和旧库一样：换成新库的。世界里改过的不动。
      // 第七十七轮：逐字比（文化组的比重也比）：各组占多少是组的比重，同一组在两个库里比重不同时换成新库的（以前界面按新库小包的权重发命令）
      if (from !== to && id === src && hit.item !== undefined && !sameItem(x, hit.item)) {
        const was = itemIn(library, from!, k, src);
        if (was !== undefined && sameItem(x, was)) replace.push({ op: 'set_content', kind: kindId, id, item: hit.item as Record<string, unknown>, from: hit.path });
      }
    }
  }
  // 世界的底子（生态、地形类别、画风……）不移不加，来源也改写到新库：世界现在用哪个库，来源上看得出来
  for (const [kind, byId] of Object.entries(small.origin ?? {})) {
    if ((SWITCH_KINDS as readonly string[]).includes(kind)) continue;
    for (const [id, rec] of Object.entries(byId)) {
      const hit = rec[0] === from ? brought.get(keyOf(kind, originSourceId(small, kind, id))) : undefined;
      if (hit && rec.join('/') !== hit.path.join('/')) rehome.push({ kind, id, from: hit.path });
    }
  }
  // 留下的：别的项 hard 引用着的，生成之后还用着的
  const inDrop = new Set(candidates.map((c) => keyOf(c.kind, c.id)));
  const table = linkTable(worldScope(world));
  const others = [...table.nodes.values()].filter((r) => !inDrop.has(keyOf(r.kind, r.id)));
  const held = new Set(dependencyClosure(table, others).hard.map((r) => keyOf(r.kind, r.id)));
  let view = survivors(small, groups);
  const drop: ContentRef[] = [];
  const kept: ContentRef[] = [];
  for (const kindId of SWITCH_KINDS) {
    const k = kindOf(kindId)!;
    const gone: ContentRef[] = [];
    for (const ref of candidates) {
      if (ref.kind !== kindId) continue;
      const used = held.has(keyOf(kindId, ref.id)) || usageOf(k, { small: view, causes: NO_CAUSES }, ref.id) || (kindId === 'nameStyle' && styleInUse(view, ref.id));
      (used ? kept : gone).push(ref);
    }
    drop.push(...gone);
    view = withoutItems(view, kindId, gone);
  }
  // 留下的项自己 hard 引用的也留下
  const needed = new Set(dependencyClosure(table, kept).hard.map((r) => keyOf(r.kind, r.id)));
  const finalDrop = drop.filter((r) => !needed.has(keyOf(r.kind, r.id)));
  const finalKept = [...kept, ...drop.filter((r) => needed.has(keyOf(r.kind, r.id)))];
  // 加进来：和新世界一样分两步（世界的底子里只要这几种），地标的先后才和新世界一样
  const parts = worldPartsOf(to).filter((p) => packAt(library, p));
  const picksFor = (path: readonly string[]) => {
    const node = packAt(library, path)!;
    const out: Record<string, string[]> = {};
    walkPacks(node, (n) => {
      for (const key of GEN_KEYS) {
        const kind = kindByPackKey(key);
        const items = ownItems<unknown>(n, key);
        if (kind && items.length) out[key] = [...(out[key] ?? []), ...items.map((x) => itemId(kind, x))];
      }
    });
    return out;
  };
  const first = packImportPlan(library, { packs: [], extra: parts.map((path) => ({ path, picks: picksFor(path) })), onlyMissing: true }, world);
  // 先后也和新世界一样（比如地名风格：两个库都带的留在原来的位置，新世界里是新库的先后）
  const ordered = new Set(flat(second.commands).flatMap((c) => (c.op === 'order_content' ? [c.kind] : [])));
  const order: Command[] = SWITCH_KINDS.filter((kind) => !ordered.has(kind)).flatMap((kind): Command[] => {
    const ids = [...brought.keys()].filter((at) => at.startsWith(keyOf(kind, ''))).map((at) => at.slice(kind.length + 1));
    return ids.length > 1 ? [{ op: 'order_content', kind, ids }] : [];
  });
  return {
    imports: [...first.commands, ...second.commands, ...replace, ...order, ...carried.map((d): Command => ({ op: 'add_dimension', dimension: { id: d.id, label: d.label }, era: second.era!.id }))],
    drop: finalDrop,
    rehome,
    kept: finalKept,
    added: new Set([...first.added, ...second.added].map((a) => keyOf(a.section, a.id))).size,
  };
}
