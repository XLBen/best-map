import { allKinds, itemId, kindOf } from '../content/registry';
import { sameItem } from '../content/refs';
import { setOrigin } from '../content/origin';
import type { CultureGroup, Era, PopValue } from '../human/era';
import type { Faction, Government } from '../human/government';
import { FANTASY_RESOURCES, GENERAL_RESOURCES } from '../human/resources';
import { BUILTIN_CLASSES } from '../human/terrain-class';
import { BUILTIN_ISLAND_TYPES } from '../island-types';
import { DEFAULT_STYLE } from '../name-styles';
import type { PackItem, PackNode, ResourcePack } from '../packs';
import { DEFAULT_SPECIES } from '../species';
import type { SmallState } from '../world';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_CULTURES, BUILTIN_ERAS, BUILTIN_POP_VALUES } from './eras';
import { BUILTIN_FACTIONS, BUILTIN_GOVERNMENTS } from './governments';
import { BUILTIN_STYLES } from './names';
import { BUILTIN_LANDMARK_TYPES, BUILTIN_POINT_TYPES, BUILTIN_RANKS } from './settlements';

// 内置资源包的树（第二十九轮）：资源库里的内置内容按时代、主题分大包，大包里按种类分小包，全部由现有的常量拼成（不复制数据）。
// 每一个内置项至少属于一个包（测试逐项查）；几个时代共用的政体、派系、取值同时出现在几个包里（引用同一份）。
//
//   每个内置时代一个大包（id 就是时代的 id：antiquity、medieval、industrial、modern、fantasy、scifi）：
//     era               时代本身
//     <维度 id>         每个维度一个小包（宗教、民族认同、意识形态、种族……）：这个时代这一维的全部取值（与生成人文时带进来的一样）
//     governments       政体：时代列出的全部（没列的时代是写了这个时代的），加上按下面的归法归到这个时代的
//     factions          派系：同上
//     resources         这个时代列出的、不是通用的资源（奇幻的秘银、魔晶……）
//     cultures ▸ <组>   时代默认带的文化组（defaultGroups），每组一个小包：组、组里的文化、这些文化的地名风格
//     奇幻另有 biomes、rivers、lakes、forms：奇幻的生态（带它们用到的自定义场）、河、湖、星球形态（fantasy.ts 的那几样）
//   通用（common）：
//     base              基础（总在）：地形类别、通用资源、城市等级、地标、点的类型、中文·默认。只显示，世界里总有，不能移出
//                       （内置的岛也总在，但它们的 id 不能写进资源包，只在 builtinItems 里列在这里）
//     nature            自然：13 种普通生态
//     names ▸ <地区>    地名：内置的地名风格按地区分（地区表见 STYLE_REGIONS，没列的放“其他”）
//     cultures ▸ <组>   文化：没有哪个时代默认带的文化组
//
// 没被任何时代列出的政体、派系归到最贴切的时代：先看它自己写的 eras（第一个是内置时代的），再按政体的类别（CATEGORY_ERA，
// 按类别的先后取第一个认得的），都没有时归中世纪。现在的 46 种政体、30 种派系都被时代列出了，这条归法管以后加的

// 这个文件是树的主干（不含奇幻大包里的生态、河、湖、星球形态）：计算 Worker 里生成人文、记来源、报“拿掉的项”只用到这些，
// 不引用 packs.ts 和奇幻的数据，引擎打包成 data: 地址才不超长（见 tools/isolated-engine.ts）。完整的树在 builtin-tree.ts，
// 它在这棵树上补上奇幻的那几个小包，各项的路径与这里的一样（测试逐项对）

export const COMMON_PACK_ID = 'common';
export const BASE_PATH: readonly string[] = [COMMON_PACK_ID, 'base'];

// 没被时代列出的政体按类别归到哪个时代
const CATEGORY_ERA: Record<string, string> = {
  tribal: 'antiquity',
  nomadic: 'antiquity',
  theocracy: 'medieval',
  monarchy: 'medieval',
  empire: 'medieval',
  oligarchy: 'medieval',
  republic: 'medieval',
  democracy: 'industrial',
  federation: 'industrial',
  communist: 'modern',
  fascist: 'modern',
  dictatorship: 'modern',
  magocracy: 'fantasy',
  corporate: 'scifi',
};
const FALLBACK_ERA = 'medieval';

// 地名风格按地区分（id → 地区）；没列的放“其他”
const STYLE_REGIONS: readonly { id: string; name: string; styles: readonly string[] }[] = [
  { id: 'west-europe', name: '西欧', styles: ['west-germanic', 'en-english', 'fr-french', 'nl-dutch'] },
  { id: 'south-europe', name: '南欧', styles: ['es-spanish', 'it-italian', 'latin', 'greek'] },
  { id: 'north-east-europe', name: '北欧与东欧', styles: ['nordic-norse', 'slavic-east'] },
  { id: 'east-asia', name: '东亚', styles: ['ja-kanji', 'ko-hanja'] },
  { id: 'west-central-asia', name: '西亚与中亚', styles: ['arabic', 'persian', 'turkic'] },
  { id: 'south-asia', name: '南亚与东南亚', styles: ['indic', 'malay', 'thai'] },
  { id: 'africa', name: '非洲', styles: ['bantu-swahili'] },
  { id: 'americas', name: '美洲', styles: ['nahuatl', 'quechua'] },
  { id: 'oceania', name: '大洋洲', styles: ['polynesian'] },
  { id: 'fantasy', name: '幻想', styles: ['fantasy-elf', 'fantasy-dwarf', 'fantasy-orc', 'fantasy-seafolk'] },
];

const asItems = (list: readonly unknown[]): PackItem[] => list as PackItem[];

// 这个时代这一维的取值（与 ensureHumanContent 带进来的一样：维度相同、没写时代或写了这个时代）
export function eraValues(era: Pick<Era, 'id'>, dimension: string): PopValue[] {
  return BUILTIN_POP_VALUES.filter((v) => v.dimension === dimension && (!v.eras || v.eras.includes(era.id)));
}

// 时代用的内置政体、派系：时代列了的按列的；没列的是写了这个时代的（与 ensureGovContent 一样）
function listed<T extends { id: string; eras?: string[] }>(ids: readonly string[] | undefined, builtin: readonly T[], era: string): T[] {
  return ids?.length ? builtin.filter((x) => ids.includes(x.id)) : builtin.filter((x) => x.eras?.includes(era));
}

// 没被任何时代列出的归到哪个时代
function homeEra(x: { eras?: string[]; category?: readonly string[] }): string {
  const ids = new Set(BUILTIN_ERAS.map((e) => e.id));
  const own = x.eras?.find((e) => ids.has(e));
  if (own) return own;
  for (const c of x.category ?? []) if (CATEGORY_ERA[c] && ids.has(CATEGORY_ERA[c])) return CATEGORY_ERA[c];
  return FALLBACK_ERA;
}

function eraSets<T extends { id: string; eras?: string[]; category?: readonly string[] }>(builtin: readonly T[], key: 'governments' | 'factions'): Map<string, T[]> {
  const out = new Map(BUILTIN_ERAS.map((e) => [e.id, listed(e[key], builtin, e.id)]));
  const seen = new Set([...out.values()].flat().map((x) => x.id));
  for (const x of builtin) {
    if (seen.has(x.id)) continue;
    const home = homeEra(x);
    out.set(home, [...(out.get(home) ?? []), x]);
  }
  return out;
}

// 一个文化组的小包：组、组里的文化、这些文化的地名风格（中文·默认总在，不放）
function groupPack(g: CultureGroup): PackNode {
  const cultures = BUILTIN_CULTURES.filter((c) => c.group === g.id);
  const styleIds = new Set(cultures.map((c) => c.nameStyle));
  const styles = BUILTIN_STYLES.filter((s) => styleIds.has(s.id) && s.id !== DEFAULT_STYLE);
  return { id: g.id, name: g.name, cultureGroups: asItems([g]), cultures: asItems(cultures), ...(styles.length ? { nameStyles: asItems(styles) } : {}) };
}

// 树的主干（builtin-tree.ts 的 builtinPacks 在它上面补上奇幻的小包）
export function buildBaseTree(): ResourcePack[] {
  const govs = eraSets<Government>(BUILTIN_GOVERNMENTS, 'governments');
  const facs = eraSets<Faction>(BUILTIN_FACTIONS, 'factions');
  const defaultGroups = new Set<string>();
  const top = (id: string, name: string, description: string, packs: PackNode[]): ResourcePack => ({ format: 'map2-pack', version: 1, id, name, author: 'map_2', description, packs });

  const eraPacks = BUILTIN_ERAS.map((era) => {
    const packs: PackNode[] = [{ id: 'era', name: '时代', eras: asItems([era]) }];
    for (const d of era.dimensions) {
      const values = eraValues(era, d.id);
      if (values.length) packs.push({ id: d.id, name: d.label, popValues: asItems(values) });
    }
    const g = govs.get(era.id) ?? [];
    if (g.length) packs.push({ id: 'governments', name: '政体', governments: asItems(g) });
    const f = facs.get(era.id) ?? [];
    if (f.length) packs.push({ id: 'factions', name: '派系', factions: asItems(f) });
    const res = FANTASY_RESOURCES.filter((r) => era.resources?.includes(r.id));
    if (res.length) packs.push({ id: 'resources', name: '资源', resources: asItems(res) });
    const groups = (era.defaultGroups ?? []).map(([id]) => BUILTIN_CULTURE_GROUPS.find((x) => x.id === id)).filter((x): x is CultureGroup => !!x);
    for (const x of groups) defaultGroups.add(x.id);
    if (groups.length) packs.push({ id: 'cultures', name: '文化', packs: groups.map(groupPack) });
    return top(era.id, era.name, era.description ?? `${era.name}的时代、取值、政体、派系与文化`, packs);
  });

  const regionOf = new Map(STYLE_REGIONS.flatMap((r) => r.styles.map((s) => [s, r.id])));
  const styles = BUILTIN_STYLES.filter((s) => s.id !== DEFAULT_STYLE);
  const regions: PackNode[] = STYLE_REGIONS.map((r) => ({ id: r.id, name: r.name, nameStyles: asItems(styles.filter((s) => regionOf.get(s.id) === r.id)) })).filter((r) => (r.nameStyles as unknown[]).length);
  const other = styles.filter((s) => !regionOf.has(s.id));
  if (other.length) regions.push({ id: 'other', name: '其他', nameStyles: asItems(other) });
  const restGroups = BUILTIN_CULTURE_GROUPS.filter((g) => !defaultGroups.has(g.id));
  const zh = BUILTIN_STYLES.filter((s) => s.id === DEFAULT_STYLE);
  const common = top(COMMON_PACK_ID, '通用', '总在世界里的基础内容、普通的生态、各地的地名风格，和没有哪个时代默认带的文化组', [
    {
      id: 'base',
      name: '基础（总在）',
      description: '世界里总有这些，不用添加，也不能移出',
      terrainClasses: asItems(BUILTIN_CLASSES),
      resources: asItems(GENERAL_RESOURCES),
      cityRanks: asItems(BUILTIN_RANKS),
      landmarkTypes: asItems(BUILTIN_LANDMARK_TYPES),
      pointTypes: asItems(BUILTIN_POINT_TYPES),
      nameStyles: asItems(zh),
    },
    { id: 'nature', name: '自然', biomes: asItems(DEFAULT_SPECIES) },
    { id: 'names', name: '地名', packs: regions },
    ...(restGroups.length ? [{ id: 'cultures', name: '文化', packs: restGroups.map(groupPack) }] : []),
  ]);
  return [...eraPacks, common];
}

// 走一遍树（同 packs.ts 的 walkPacks、ownItems；这里不引用 packs.ts）
function walk(node: PackNode, fn: (n: PackNode, path: string[]) => void, path: string[] = []): void {
  fn(node, path);
  for (const c of Array.isArray(node.packs) ? node.packs : []) walk(c, fn, [...path, c.id]);
}

export interface BuiltinItem {
  // 内容种类的 id（'government'）、资源包里的段名（'governments'）
  kind: string;
  key: string;
  id: string;
  item: unknown;
  // 在哪几个包里（完整的路径：[大包, 小包, ……]），按树的先后
  paths: string[][];
}

// 一棵树里的每一项和它在哪几个包里（内置的岛只在这里列，路径是“通用 ▸ 基础”）
export function indexTree(tree: readonly ResourcePack[]): Map<string, BuiltinItem> {
  const map = new Map<string, BuiltinItem>();
  const add = (kind: string, key: string, item: unknown, path: string[]) => {
    const k = kindOf(kind);
    const id = k ? itemId(k, item) : String((item as { id?: unknown }).id);
    const at = `${kind}\u0000${id}`;
    const hit = map.get(at);
    if (hit) {
      if (!hit.paths.some((p) => p.join('/') === path.join('/'))) hit.paths.push(path);
    } else map.set(at, { kind, key, id, item, paths: [path] });
  };
  for (const t of tree) {
    walk(t, (n, path) => {
      for (const k of allKinds()) {
        const list = n[k.pack.key];
        if (Array.isArray(list)) for (const x of list) add(k.id, k.pack.key, x, [t.id, ...path]);
      }
    });
  }
  for (const t of BUILTIN_ISLAND_TYPES) add('islandType', 'islandTypes', t, [...BASE_PATH]);
  return map;
}

let baseIndex: Map<string, BuiltinItem> | null = null;
const baseItem = (kind: string, id: string) => (baseIndex ??= indexTree(buildBaseTree())).get(`${kind}\u0000${id}`);

// 完整的树（builtin-tree.ts）载入后换成它的查法：界面里奇幻的生态、河、湖、星球形态也认得
let fullItem: ((kind: string, id: string) => BuiltinItem | undefined) | null = null;
export function useFullTree(lookup: (kind: string, id: string) => BuiltinItem | undefined): void {
  fullItem = lookup;
}

// 一项在内置的树里（完整的树载入了用它，否则用主干）
export const builtinItem = (kind: string, id: string): BuiltinItem | undefined => (fullItem ?? baseItem)(kind, id);

// 内置的一项在树里的位置：prefer 是优先的大包（生成人文时按世界的时代）；不在树里时 undefined
export function builtinOrigin(kind: string, id: string, prefer?: string): string[] | undefined {
  const b = builtinItem(kind, id);
  if (!b) return undefined;
  return [...((prefer && b.paths.find((p) => p[0] === prefer)) || b.paths[0])];
}

// 一项与内置的一模一样（用到世界时“自然生成”关掉的奇幻生态、河、湖也算：与加进世界时的样子比）。
// 计算 Worker 里只有主干：奇幻大包里的生态、河、湖、星球形态在那里算“不是内置原样”（界面存进资源库之前用完整的树再看一遍）
export function isBuiltinSame(kind: string, item: unknown): boolean {
  const k = kindOf(kind);
  if (!k) return false;
  const b = builtinItem(kind, itemId(k, item));
  if (!b) return false;
  if (sameItem(b.item, item)) return true;
  const fin = k.pack.finalize?.(b.item, { biomes: new Map(), riverTypes: new Map(), lakeTypes: new Map() });
  return fin !== undefined && sameItem(fin, item);
}

// 内置项在世界里的先后按内置的先后（第二十九轮）：生成后清理掉、下次生成又复制回来的项排回原来的位置，
// 重新生成与第一次生成看到的列表一样（取值、政体的先后会影响挑哪一个）。自己做的项留在原来的位置，只在内置项占的位置之间重排
export function builtinOrder<T>(store: Record<string, T>, builtin: readonly { id: string }[]): Record<string, T> {
  const rank = new Map(builtin.map((b, k) => [b.id, k]));
  const keys = Object.keys(store);
  const slots = keys.filter((k) => rank.has(k)).sort((a, b) => rank.get(a)! - rank.get(b)!);
  let at = 0;
  const order = keys.map((k) => (rank.has(k) ? slots[at++] : k));
  if (order.every((k, i) => k === keys[i])) return store;
  return Object.fromEntries(order.map((k) => [k, store[k]]));
}

// 从内置的复制进来的项记下来源（生成人文、国家时；内置的树里的位置，优先 prefer 这个大包）
export function recordBuiltinOrigins(small: Pick<SmallState, 'origin'>, brought: readonly (readonly [string, string])[], prefer: string): void {
  for (const [kind, id] of brought) {
    const path = builtinOrigin(kind, id, prefer);
    if (path) setOrigin(small, kind, id, path);
  }
}

