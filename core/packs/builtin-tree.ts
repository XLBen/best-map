import '../content/kinds';
import { recordedOrigin } from '../content/origin';
import { sameItem } from '../content/refs';
import { allKinds, itemId, kindByPackKey, kindOf, useBuiltinSource } from '../content/registry';
import type { CultureGroup, Era, PopValue } from '../human/era';
import type { Faction, Government } from '../human/government';
import { DEFAULT_STYLE } from '../name-styles';
import type { PackItem, PackNode, ResourcePack } from '../packs';
import type { SmallState } from '../world';
import { BUILTIN_CLASSES, BUILTIN_ISLAND_TYPES, FANTASY_RESOURCES, GENERAL_RESOURCES } from './base';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_CULTURES, BUILTIN_ERAS, BUILTIN_POP_VALUES, ERA_PACKS, VALUE_ERAS } from './eras';
import { FANTASY_BIOMES, FANTASY_FIELDS } from './fantasy-biomes';
import { FANTASY_FORMS } from './fantasy-forms';
import { FANTASY_LAKE_TYPES } from './fantasy-lakes';
import { FANTASY_RIVER_TYPES } from './fantasy-rivers';
import { BUILTIN_FACTIONS, BUILTIN_GOVERNMENTS, GOV_ERAS } from './governments';
import { BUILTIN_STYLES } from './names';
import { DEFAULT_SPECIES } from './nature';
import { BUILTIN_PLANET_FORMS } from './planet-forms';
import { BUILTIN_LANDMARK_TYPES, BUILTIN_POINT_TYPES, BUILTIN_RANKS, LANDMARK_ERAS } from './settlements';

// 内置资源包的树（第二十九轮；第三十轮起时代就是资源包，基础、自然、地名、星球形态也都是普通的包）。
// 资源库里的内置内容按时代、主题分大包，大包里按种类分小包，全部由现有的常量拼成（不复制数据）。
// 每一个内置项至少属于一个包（测试逐项查）；几个时代共用的政体、派系、取值同时出现在几个包里（引用同一份）。
// 只在主线程用（资源库、向导、存进资源库前的“是不是内置原样”）：计算 Worker 只读世界里的内容，不打包这些数据。
//
//   每个内置时代一个大包（时代包，id 就是时代的 id：antiquity、medieval、industrial、modern、fantasy、scifi）：
//     era               时代项（只有规则：维度、人口密度、无主地、领海、国家大小、城市化、关系、年代）
//     <维度 id>         每个维度一个小包（宗教、民族认同、意识形态、种族……）：放进这个时代的取值（文件里写的 eras）
//     governments       政体：时代文件的 pack 列出的（按列的先后），加上按下面的归法归到这个时代的
//     factions          派系：同上
//     resources         基础之外的资源（奇幻的秘银、魔晶……）
//     landmarks         这个时代的地标：时代自己的（神庙、城堡、太空港……；landmarks.json 写了 eras 的）和不分时代的
//                       （与基础里的是同一项），按 landmarks.json 的先后（生成后排成这个先后，放地标的先后与以前一样）
//     cultures ▸ <组>   时代默认带的文化组（pack.cultures，小包带着默认的权重 weight），每组一个小包：组、组里的文化、
//                       这些文化的地名风格
//     奇幻另有 biomes、rivers、lakes、forms：奇幻的生态（带它们用到的自定义场）、河、湖、星球形态
//   通用（common）：
//     base              基础：地形类别、通用资源、城市等级、不分时代的地标、点的类型、岛的种类（新建时默认勾上）
//     nature            自然：13 种普通生态（新建时默认勾上）
//     names ▸ zh        地名 ▸ 中文：中文·默认（新建时默认勾上）
//     names ▸ <地区>    别的地名风格按地区分（地区表见 STYLE_REGIONS，没列的放“其他”）
//     forms             星球形态：以前向导里写死的六种星球（packs/planet-forms.ts）
//     cultures ▸ <组>   文化：没有哪个时代默认带的文化组
//
// 没被任何时代列出的政体、派系归到最贴切的时代：先看它自己写的 eras（第一个是内置时代的），再按政体的类别（CATEGORY_ERA，
// 按类别的先后取第一个认得的），都没有时归中世纪。现在的 46 种政体、30 种派系都被时代列出了，这条归法管以后加的

export const COMMON_PACK_ID = 'common';
export const BASE_PATH: readonly string[] = [COMMON_PACK_ID, 'base'];
// 新建世界默认勾上的包（第三十轮）：基础、自然、中文地名（新建向导另外默认勾上一个时代包）
export const DEFAULT_WORLD_PACKS: readonly (readonly string[])[] = [BASE_PATH, [COMMON_PACK_ID, 'nature'], [COMMON_PACK_ID, 'names', 'zh']];
// 星球形态的小包
export const FORMS_PATH: readonly string[] = [COMMON_PACK_ID, 'forms'];

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

// 地名风格按地区分（id → 地区）；没列的放“其他”。中文·默认单独一个小包（zh），在最前
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

// 这个时代这一维的取值：维度相同、文件里没写时代或写了这个时代
export function eraValues(era: Pick<Era, 'id'>, dimension: string): PopValue[] {
  return BUILTIN_POP_VALUES.filter((v) => {
    const eras = VALUE_ERAS.get(v.id);
    return v.dimension === dimension && (!eras || eras.includes(era.id));
  });
}

// 没被任何时代列出的归到哪个时代
function homeEra(x: { id: string; category?: readonly string[] }): string {
  const ids = new Set(BUILTIN_ERAS.map((e) => e.id));
  const own = GOV_ERAS.get(x.id)?.find((e) => ids.has(e));
  if (own) return own;
  for (const c of x.category ?? []) if (CATEGORY_ERA[c] && ids.has(CATEGORY_ERA[c])) return CATEGORY_ERA[c];
  return FALLBACK_ERA;
}

// 每个时代的政体（或派系）：时代列的按列的先后（与第二十九轮生成时用的先后一样），再加上归到这个时代的
function eraSets<T extends { id: string; category?: readonly string[] }>(builtin: readonly T[], key: 'governments' | 'factions'): Map<string, T[]> {
  const byId = new Map(builtin.map((x) => [x.id, x]));
  const out = new Map(BUILTIN_ERAS.map((e) => [e.id, (ERA_PACKS.get(e.id)?.[key] ?? []).map((id) => byId.get(id)).filter((x): x is T => !!x)]));
  const seen = new Set([...out.values()].flat().map((x) => x.id));
  for (const x of builtin) {
    if (seen.has(x.id)) continue;
    const home = homeEra(x);
    out.set(home, [...(out.get(home) ?? []), x]);
  }
  return out;
}

// 一个文化组的小包：组、组里的文化、这些文化的地名风格（第三十轮起中文·默认也带上：它不再总在世界里）。
// weight：时代默认带这一组时的权重（新建向导默认的权重）
function groupPack(g: CultureGroup, weight?: number): PackNode {
  const cultures = BUILTIN_CULTURES.filter((c) => c.group === g.id);
  const styleIds = new Set(cultures.map((c) => c.nameStyle));
  const styles = BUILTIN_STYLES.filter((s) => styleIds.has(s.id));
  return {
    id: g.id,
    name: g.name,
    ...(weight !== undefined ? { weight } : {}),
    cultureGroups: asItems([g]),
    cultures: asItems(cultures),
    ...(styles.length ? { nameStyles: asItems(styles) } : {}),
  };
}

function build(): ResourcePack[] {
  const govs = eraSets<Government>(BUILTIN_GOVERNMENTS, 'governments');
  const facs = eraSets<Faction>(BUILTIN_FACTIONS, 'factions');
  const defaultGroups = new Set<string>();
  const top = (id: string, name: string, description: string, packs: PackNode[]): ResourcePack => ({ format: 'map2-pack', version: 1, id, name, author: 'map_2', description, packs });

  const eraPacks = BUILTIN_ERAS.map((era) => {
    const def = ERA_PACKS.get(era.id);
    const packs: PackNode[] = [{ id: 'era', name: '时代', eras: asItems([era]) }];
    for (const d of era.dimensions) {
      const values = eraValues(era, d.id);
      if (values.length) packs.push({ id: d.id, name: d.label, popValues: asItems(values) });
    }
    const g = govs.get(era.id) ?? [];
    if (g.length) packs.push({ id: 'governments', name: '政体', governments: asItems(g) });
    const f = facs.get(era.id) ?? [];
    if (f.length) packs.push({ id: 'factions', name: '派系', factions: asItems(f) });
    const res = FANTASY_RESOURCES.filter((r) => def?.resources?.includes(r.id));
    if (res.length) packs.push({ id: 'resources', name: '资源', resources: asItems(res) });
    const marks = BUILTIN_LANDMARK_TYPES.filter((t) => !LANDMARK_ERAS.has(t.id) || LANDMARK_ERAS.get(t.id)!.includes(era.id));
    if (marks.length) packs.push({ id: 'landmarks', name: '地标', landmarkTypes: asItems(marks) });
    const groups = (def?.cultures ?? []).flatMap(([id, w]) => {
      const x = BUILTIN_CULTURE_GROUPS.find((y) => y.id === id);
      return x ? [groupPack(x, w)] : [];
    });
    for (const x of groups) defaultGroups.add(x.id);
    if (groups.length) packs.push({ id: 'cultures', name: '文化', packs: groups });
    if (era.id === 'fantasy') {
      packs.push(
        { id: 'biomes', name: '奇幻生态', fields: [...FANTASY_FIELDS], biomes: asItems(FANTASY_BIOMES) },
        { id: 'rivers', name: '奇幻的河', riverTypes: asItems(FANTASY_RIVER_TYPES) },
        { id: 'lakes', name: '奇幻的湖', lakeTypes: asItems(FANTASY_LAKE_TYPES) },
        { id: 'forms', name: '星球形态', planetForms: asItems(FANTASY_FORMS) },
      );
    }
    return top(era.id, era.name, era.description ?? `${era.name}的时代、取值、政体、派系与文化`, packs);
  });

  const regionOf = new Map(STYLE_REGIONS.flatMap((r) => r.styles.map((s) => [s, r.id])));
  const styles = BUILTIN_STYLES.filter((s) => s.id !== DEFAULT_STYLE);
  const regions: PackNode[] = [
    { id: 'zh', name: '中文', nameStyles: asItems(BUILTIN_STYLES.filter((s) => s.id === DEFAULT_STYLE)) },
    ...STYLE_REGIONS.map((r) => ({ id: r.id, name: r.name, nameStyles: asItems(styles.filter((s) => regionOf.get(s.id) === r.id)) })).filter((r) => r.nameStyles.length),
  ];
  const other = styles.filter((s) => !regionOf.has(s.id));
  if (other.length) regions.push({ id: 'other', name: '其他', nameStyles: asItems(other) });
  const restGroups = BUILTIN_CULTURE_GROUPS.filter((g) => !defaultGroups.has(g.id));
  const common = top(COMMON_PACK_ID, '通用', '基础内容、普通的生态、各地的地名风格、星球形态，和没有哪个时代默认带的文化组', [
    {
      id: 'base',
      name: '基础',
      description: '地形类别、通用资源、城市等级、地标、点和岛的种类。新建世界时默认勾上；没有它们时用到的那一步跳过',
      terrainClasses: asItems(BUILTIN_CLASSES),
      resources: asItems(GENERAL_RESOURCES),
      cityRanks: asItems(BUILTIN_RANKS),
      landmarkTypes: asItems(BUILTIN_LANDMARK_TYPES.filter((t) => !LANDMARK_ERAS.has(t.id))),
      pointTypes: asItems(BUILTIN_POINT_TYPES),
      islandTypes: asItems(BUILTIN_ISLAND_TYPES),
    },
    { id: 'nature', name: '自然', description: '13 种接近地球的生态。新建世界时默认勾上', biomes: asItems(DEFAULT_SPECIES) },
    { id: 'names', name: '地名', packs: regions },
    { id: 'forms', name: '星球形态', description: '新建整个星球时选：像地球、一块超大陆、破碎大陆……', planetForms: asItems(BUILTIN_PLANET_FORMS) },
    ...(restGroups.length ? [{ id: 'cultures', name: '文化', packs: restGroups.map((g) => groupPack(g)) }] : []),
  ]);
  return [...eraPacks, common];
}

let tree: ResourcePack[] | null = null;

// 内置的大包（按时代的先后，通用在最后）
export function builtinPacks(): readonly ResourcePack[] {
  return (tree ??= build());
}

// 走一遍树（同 packs.ts 的 walkPacks；这里不引用 packs.ts 的值）
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

// 一棵树里的每一项和它在哪几个包里
export function indexTree(trees: readonly ResourcePack[]): Map<string, BuiltinItem> {
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
  for (const t of trees) {
    walk(t, (n, path) => {
      for (const k of allKinds()) {
        const list = n[k.pack.key];
        if (Array.isArray(list)) for (const x of list) add(k.id, k.pack.key, x, [t.id, ...path]);
      }
    });
  }
  return map;
}

let index: Map<string, BuiltinItem> | null = null;
const fullIndex = () => (index ??= indexTree(builtinPacks()));

// 内置的树里的每一项和它在哪几个包里
export function builtinItems(): readonly BuiltinItem[] {
  return [...fullIndex().values()];
}

// 一项在内置的树里（没有时 undefined）
export const builtinItem = (kind: string, id: string): BuiltinItem | undefined => fullIndex().get(`${kind}\u0000${id}`);

// 内置的一项在树里的位置：prefer 是优先的大包；不在树里时 undefined
export function builtinOrigin(kind: string, id: string, prefer?: string): string[] | undefined {
  const b = builtinItem(kind, id);
  if (!b) return undefined;
  return [...((prefer && b.paths.find((p) => p[0] === prefer)) || b.paths[0])];
}

// 一项与内置的一模一样（用到世界时“自然生成”关掉的奇幻生态、河、湖也算：与加进世界时的样子比）
export function isBuiltinSame(kind: string, item: unknown): boolean {
  const k = kindOf(kind);
  if (!k) return false;
  const b = builtinItem(kind, itemId(k, item));
  if (!b) return false;
  if (sameItem(b.item, item)) return true;
  const fin = k.pack.finalize?.(b.item, { biomes: new Map(), riverTypes: new Map(), lakeTypes: new Map() });
  return fin !== undefined && sameItem(fin, item);
}

// 世界里一项的来源：记着的；没记、但与内置的一模一样时按内置的树；都没有时 undefined（离群）
export function originOf(small: Pick<SmallState, 'origin'>, kind: string, id: string, item?: unknown): string[] | undefined {
  const rec = recordedOrigin(small, kind, id);
  if (rec) return [...rec];
  if (item !== undefined && !isBuiltinSame(kind, item)) return undefined;
  return builtinOrigin(kind, id);
}

// 资源包的段名 → 种类 id（界面按段名走树时用）
export const kindOfKey = (key: string): string | undefined => kindByPackKey(key)?.id;

// 内置的树接上登记表（content/registry.ts 的 builtinOf、isBuiltinCopy：资源库列内置的项、导出时去掉内置原样的）。
// 只在主线程：这个文件载入时接上，计算 Worker 不引用它
const byKind = new Map<string, unknown[]>();
useBuiltinSource({
  items: (kind) => {
    let l = byKind.get(kind);
    if (!l) byKind.set(kind, (l = builtinItems().filter((b) => b.kind === kind).map((b) => b.item)));
    return l;
  },
  same: isBuiltinSame,
});
