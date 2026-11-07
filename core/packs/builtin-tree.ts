import '../content/kinds';
import { recordedOrigin } from '../content/origin';
import { sameContent } from '../content/refs';
import { allKinds, itemId, kindByPackKey, kindOf, useBuiltinSource } from '../content/registry';
import type { Culture, CultureGroup, Era, PopValue } from '../human/era';
import type { Faction, Government } from '../human/government';
import { DEFAULT_STYLE } from '../name-styles';
import type { PackItem, PackNode, ResourcePack } from '../packs';
import type { SmallState } from '../world';
import { BUILTIN_CLASSES, BUILTIN_ISLAND_TYPES, FANTASY_RESOURCES, GENERAL_RESOURCES } from './base';
import { BUILTIN_CULTURE_GROUPS, BUILTIN_CULTURES, BUILTIN_ERAS, BUILTIN_POP_VALUES, BUILTIN_VALUE_GROUPS, CULTURE_REGIONS, ERA_PACKS, VALUE_ERAS } from './eras';
import { FANTASY_BIOMES, FANTASY_FIELDS } from './fantasy-biomes';
import { FANTASY_FORMS } from './fantasy-forms';
import { FANTASY_LAKE_TYPES } from './fantasy-lakes';
import { FANTASY_RIVER_TYPES } from './fantasy-rivers';
import { FANTASY_NEW_RIVER_TYPES } from './fantasy-water';
import { BUILTIN_MAP_STYLES } from './map-styles';
import { BUILTIN_COUNTRY_PATTERNS, BUILTIN_COUNTRY_TIERS } from './countries';
import { BUILTIN_FACTIONS, BUILTIN_GOVERNMENTS, GOV_ERAS } from './governments';
import { BUILTIN_STYLES } from './names';
import { DEFAULT_SPECIES } from './nature';
import { BUILTIN_PLANET_FORMS } from './planet-forms';
import { REAL_LAKE_TYPES, REAL_RIVER_TYPES } from './water';
import { BUILTIN_LANDMARK_TYPES, BUILTIN_POINT_TYPES, BUILTIN_RANKS, LANDMARK_ERAS } from './settlements';

// 内置的库（第二十九轮是资源包的树；第五十一轮起每个时代是一个完整的库，“通用”拆进了各库）。
// 全部由现有的常量拼成（不复制数据）：六个库里的基础、自然、地名……是同一份对象，只在运行时多几个小包，不占打包的大小。
// 每一个内置项至少属于一个包（测试逐项查）；几个库共用的政体、派系、取值同时出现在几个包里（引用同一份）。
// 只在主线程用（资源库、向导、存进资源库前的“是不是内置原样”）：计算 Worker 只读世界里的内容，不打包这些数据。
//
//   每个内置时代一个库（id 就是时代的 id：antiquity、medieval、industrial、modern、fantasy、scifi）：
//     era               时代项（只有规则：维度、人口密度、无主地、领海、国家大小、城市化、关系、年代）与它用的国家格局（第七十三轮）
//     <维度 id>         每个维度一个小包（宗教、民族认同、意识形态、种族……）：放进这个时代的取值（文件里写的 eras），
//                       与它们用到的取值组（第四十三轮：宗教组）
//     governments       政体：时代文件的 pack 列出的（按列的先后），加上按下面的归法归到这个时代的
//     factions          派系：同上
//     resources         基础之外的资源（奇幻的秘银、魔晶……）
//     landmarks         这个时代的地标：时代自己的（神庙、城堡、太空港……；landmarks.json 写了 eras 的）和不分时代的
//                       （与基础里的是同一项），按 landmarks.json 的先后（生成后排成这个先后，放地标的先后与以前一样）
//     cultures ▸ <组>   文化组，每组一个小包：组、组里的文化（写了 except 的不带：中世纪不带殖民地的文化）、这些文化的地名风格。
//                       先是时代默认带的（pack.cultures，小包带着默认的权重 weight），四个历史库再加上别的 EU4 文化组：
//                       小包和组的比重（weight）都是 0，不参与生成，新世界不带，点名了才带（core/packs/import.ts）。
//                       奇幻、科幻只有自己的组（第四十四轮：奇幻 11 组、科幻 9 组，默认全带），不带 EU4 的文化
//     奇幻另有 biomes、rivers、lakes：奇幻的生态（带它们用到的自定义场）、河、湖；第五十七轮起新建奇幻世界时默认带上（worldPartsOf），换库照旧不带
//   世界的底子（LIBRARY_BASE_PACKS，每个库都有，新建世界时放在生成之前）：
//     base              基础：地形类别、通用资源、城市等级、不分时代的地标、点的类型、岛的种类
//     nature            自然：15 种普通生态（packs/nature.ts）
//     names ▸ zh        地名 ▸ 中文：中文·默认
//     names ▸ <地区>    别的地名风格按地区分（地区表见 STYLE_REGIONS，没列的放“其他”）
//     forms             星球形态：以前向导里写死的六种星球（packs/planet-forms.ts），奇幻的另有几种
//     styles            画风（第三十八轮）：写实、地图册（packs/map-styles.ts）
//     tiers             国家等级（第四十二轮）：五档等级（packs/countries/tiers.json；第七十七轮去掉了四种格局：各级占多少只写在时代里）
//     water             水系（第五十七轮）：七种现实的河、七种现实的湖（packs/water.ts）
//
// 没被任何时代列出的政体、派系归到最贴切的时代：先看它自己写的 eras（第一个是内置时代的），再按政体的类别（CATEGORY_ERA，
// 按类别的先后取第一个认得的），都没有时归中世纪。现在的 61 种政体、27 种派系都被时代列出了（第四十四轮），这条归法管以后加的

// 新世界默认用的库（选库的界面在第五十二轮）
export const DEFAULT_LIBRARY = 'medieval';
export const BASE_PATH: readonly string[] = [DEFAULT_LIBRARY, 'base'];
// 画风的小包（第三十八轮）
export const STYLES_PATH: readonly string[] = [DEFAULT_LIBRARY, 'styles'];
// 国家等级的小包（第四十二轮）
export const TIERS_PATH: readonly string[] = [DEFAULT_LIBRARY, 'tiers'];
// 星球形态的小包
export const FORMS_PATH: readonly string[] = [DEFAULT_LIBRARY, 'forms'];
// 每个库里世界的底子（小包的 id）：把时代包整个加进世界时不带这几个（生成人文不用它们，自己移出的基础内容也不该被加回来），
// 新建世界时在生成之前单独加（worldPartsOf）
export const LIBRARY_BASE_PACKS: ReadonlySet<string> = new Set(['base', 'nature', 'names', 'forms', 'styles', 'tiers', 'water']);
// 一个库新建世界时加的小包（第三十轮起默认这几个：基础、自然、中文地名、画风、国家等级；第五十七轮加上现实的水系）
// 奇幻库另带奇幻的生态、河、湖（第五十七轮）：第五十二轮以后向导不能勾小包，不带就选不到。放在水系前面：类型的先后是前面的说了算，奇幻的河先定
// 第五十九轮：看小包在不在，不看键：奇幻库复制成我的库（键变了）以后照样带（root：这个库；省略时按内置的库找）
const EXTRA_WORLD_PARTS = ['biomes', 'rivers', 'lakes'];
export function worldPartsOf(key: string, root?: PackNode): string[][] {
  const node = root ?? builtinPacks().find((p) => p.id === key);
  const extra = EXTRA_WORLD_PARTS.filter((id) => (Array.isArray(node?.packs) ? node.packs : []).some((c) => c.id === id));
  return [[key, 'base'], [key, 'nature'], [key, 'names', 'zh'], [key, 'styles'], [key, 'tiers'], ...extra.map((id) => [key, id]), [key, 'water']];
}
export const DEFAULT_WORLD_PACKS: readonly (readonly string[])[] = [[DEFAULT_LIBRARY, 'base'], [DEFAULT_LIBRARY, 'nature'], [DEFAULT_LIBRARY, 'names', 'zh'], [DEFAULT_LIBRARY, 'styles'], [DEFAULT_LIBRARY, 'tiers'], [DEFAULT_LIBRARY, 'water']];

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
  { id: 'west-europe', name: '西欧', styles: ['west-germanic', 'en-english', 'fr-french', 'nl-dutch', 'celtic'] },
  { id: 'south-europe', name: '南欧', styles: ['es-spanish', 'it-italian', 'latin', 'greek'] },
  { id: 'north-east-europe', name: '北欧与东欧', styles: ['nordic-norse', 'baltic', 'slavic-east', 'slavic-west', 'slavic-south', 'carpathian', 'ugric', 'tatar'] },
  { id: 'east-asia', name: '东亚', styles: ['ja-kanji', 'ko-hanja', 'tibetan', 'evenki', 'kamchatkan'] },
  { id: 'west-central-asia', name: '西亚与中亚', styles: ['arabic', 'persian', 'turkic', 'caucasian'] },
  { id: 'south-asia', name: '南亚与东南亚', styles: ['indic', 'aryan-west', 'aryan-east', 'central-indian', 'dravidian', 'malay', 'thai', 'burman', 'mon-khmer'] },
  { id: 'africa', name: '非洲', styles: ['maghrebi', 'cushitic', 'sudanese', 'sahelian', 'mande', 'west-african', 'kongo', 'great-lakes', 'bantu-swahili', 'southern-african'] },
  {
    id: 'north-america',
    name: '北美',
    styles: ['eskaleut', 'na-dene', 'penutian', 'sonoran', 'apachean', 'algonquian-plains', 'algonquian-central', 'algonquian-east', 'iroquoian', 'siouan', 'caddoan', 'muskogean'],
  },
  { id: 'americas', name: '中美与南美', styles: ['nahuatl', 'aridoamerican', 'otomanguean', 'mayan', 'caribbean', 'chibchan', 'maranon', 'quechua', 'araucanian', 'matacoan', 'je', 'tupi'] },
  { id: 'oceania', name: '大洋洲', styles: ['polynesian', 'aboriginal'] },
  // 第四十四轮：奇幻的文化组、科幻的物种组一组一种
  {
    id: 'fantasy',
    name: '幻想',
    styles: ['fantasy-elf', 'fantasy-dwarf', 'fantasy-halfling', 'fantasy-gnome', 'fantasy-orc', 'fantasy-goblin', 'fantasy-draconic', 'fantasy-west', 'fantasy-north', 'fantasy-sand', 'fantasy-seafolk'],
  },
  { id: 'scifi', name: '科幻', styles: ['scifi-terran', 'scifi-spacer', 'scifi-augment', 'scifi-synthetic', 'scifi-tidal', 'scifi-lithic', 'scifi-sporal', 'scifi-chitin', 'scifi-avian'] },
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

// 文化用的地名风格（自己写的，没写时组的）
const styleOfIn = (c: Culture, groups: ReadonlyMap<string, CultureGroup>): string | undefined => c.nameStyle ?? groups.get(c.group)?.nameStyle;
const groupById = new Map<string, CultureGroup>();
const groupsMap = (): ReadonlyMap<string, CultureGroup> => {
  if (!groupById.size) for (const g of BUILTIN_CULTURE_GROUPS) groupById.set(g.id, g);
  return groupById;
};
// 这些文化（与组）用的地名风格，按风格表的先后
function stylesFor(groups: readonly CultureGroup[], cultures: readonly Culture[]): unknown[] {
  const ids = new Set<string>();
  for (const g of groups) if (g.nameStyle) ids.add(g.nameStyle);
  for (const c of cultures) {
    const id = styleOfIn(c, groupsMap());
    if (id) ids.add(id);
  }
  return BUILTIN_STYLES.filter((s) => ids.has(s.id));
}

// 库里一个文化组的小包：组、组里的文化（except 里的不带）、这些文化的地名风格（第三十轮起中文·默认也带上：它不再总在世界里）。
// weight：这个时代默认带这一组时的权重。第七十七轮起各组占多少只来自世界里组的比重（生成的命令不再写权重）：
// 不是 1 时组是加了这个比重的浅拷贝（和 sparePack 的比重 0 一样，别的字段同一份；比重不算这一项的内容，见 sameIgnore），
// 新世界从这个库带来的组就带着这个时代的比重，生成的结果与以前界面按小包的权重发命令时逐值相同。文化引用同一份，不复制
function groupPack(g: CultureGroup, weight?: number, except: readonly string[] = []): PackNode {
  const cultures = BUILTIN_CULTURES.filter((c) => c.group === g.id && !except.includes(c.id));
  const styles = stylesFor([g], cultures);
  return {
    id: g.id,
    name: g.name,
    ...(weight !== undefined ? { weight } : {}),
    cultureGroups: asItems([weight !== undefined && weight !== 1 ? { ...g, weight } : g]),
    cultures: asItems(cultures),
    ...(styles.length ? { nameStyles: asItems(styles) } : {}),
  };
}

// 这个时代不默认带的 EU4 文化组（第五十一轮）：小包和组的比重都是 0，四个历史库共用一份。
// 组是加了 weight: 0 的浅拷贝（别的字段同一份）；比重 0 是库里的安排，不算这一项的内容（sameIgnore、builtinItem）
const spareNodes = new Map<string, PackNode>();
function sparePack(id: string): PackNode | undefined {
  const hit = spareNodes.get(id);
  if (hit) return hit;
  const g = groupsMap().get(id);
  if (!g) return undefined;
  const node = { ...groupPack(g, 0), cultureGroups: asItems([{ ...g, weight: 0 }]) };
  spareNodes.set(id, node);
  return node;
}

// 奇幻、科幻不带 EU4 的文化组
const FICTION_ERAS: ReadonlySet<string> = new Set(['fantasy', 'scifi']);
const EU4_GROUPS: readonly string[] = CULTURE_REGIONS.flatMap((r) => r.groups);

// 世界的底子（见文件开头）：六个库共用同一份小包，奇幻的星球形态多几种
function baseNodes(): { base: PackNode; nature: PackNode; names: PackNode; forms: PackNode; styles: PackNode; tiers: PackNode; water: PackNode } {
  const regionOf = new Map(STYLE_REGIONS.flatMap((r) => r.styles.map((s) => [s, r.id])));
  const styles = BUILTIN_STYLES.filter((s) => s.id !== DEFAULT_STYLE);
  const regions: PackNode[] = [
    { id: 'zh', name: '中文', nameStyles: asItems(BUILTIN_STYLES.filter((s) => s.id === DEFAULT_STYLE)) },
    ...STYLE_REGIONS.map((r) => ({ id: r.id, name: r.name, nameStyles: asItems(styles.filter((s) => regionOf.get(s.id) === r.id)) })).filter((r) => r.nameStyles.length),
  ];
  const other = styles.filter((s) => !regionOf.has(s.id));
  if (other.length) regions.push({ id: 'other', name: '其他', nameStyles: asItems(other) });
  return {
    base: {
      id: 'base',
      name: '基础',
      description: '地形类别、通用资源、城市等级、地标、点和岛的种类。新建世界时默认带上；没有它们时用到的那一步跳过',
      terrainClasses: asItems(BUILTIN_CLASSES),
      resources: asItems(GENERAL_RESOURCES),
      cityRanks: asItems(BUILTIN_RANKS),
      landmarkTypes: asItems(BUILTIN_LANDMARK_TYPES.filter((t) => !LANDMARK_ERAS.has(t.id))),
      pointTypes: asItems(BUILTIN_POINT_TYPES),
      islandTypes: asItems(BUILTIN_ISLAND_TYPES),
    },
    nature: { id: 'nature', name: '自然', description: `${DEFAULT_SPECIES.length} 种接近地球的生态。新建世界时默认带上`, biomes: asItems(DEFAULT_SPECIES) },
    names: { id: 'names', name: '地名', packs: regions },
    forms: { id: 'forms', name: '星球形态', description: '新建整个星球时选：像地球、一块超大陆、破碎大陆……', planetForms: asItems(BUILTIN_PLANET_FORMS) },
    styles: { id: 'styles', name: '画风', description: '地图怎么画：写实、地图册。新建世界时默认带上；在“图层 → 画风”里换', mapStyles: asItems(BUILTIN_MAP_STYLES) },
    tiers: {
      id: 'tiers',
      name: '国家等级',
      description: '国家分几级（帝国级、王国级、公国级、侯国级、城邦级行政）。新建世界时默认带上；生成国家时按它们挑大小，各级占多少写在时代里',
      countryTiers: asItems(BUILTIN_COUNTRY_TIERS),
    },
    water: {
      id: 'water',
      name: '水系',
      description: '现实的河与湖：冰川河、泥沙大河、盐湖、牛轭湖……只改河湖的种类和画出来的样子，水怎么流、地名、生态都不变。新建世界时默认带上',
      riverTypes: asItems(REAL_RIVER_TYPES),
      lakeTypes: asItems(REAL_LAKE_TYPES),
    },
  };
}

function build(): ResourcePack[] {
  const govs = eraSets<Government>(BUILTIN_GOVERNMENTS, 'governments');
  const facs = eraSets<Faction>(BUILTIN_FACTIONS, 'factions');
  const top = (id: string, name: string, description: string, packs: PackNode[]): ResourcePack => ({ format: 'map2-pack', version: 1, id, name, author: 'map_2', description, packs });
  const shared = baseNodes();

  return BUILTIN_ERAS.map((era) => {
    const def = ERA_PACKS.get(era.id);
    // 第七十三轮：时代用的国家格局和时代放在一起（按时代列的先后）
    const pats = (era.patterns ?? []).flatMap((e) => BUILTIN_COUNTRY_PATTERNS.filter((p) => p.id === e.pattern));
    const packs: PackNode[] = [{ id: 'era', name: '时代', eras: asItems([era]), ...(pats.length ? { countryPatterns: asItems(pats) } : {}) }];
    for (const d of era.dimensions) {
      const values = eraValues(era, d.id);
      // 第四十三轮：取值用到的取值组（宗教组）一起放在这一维的小包里
      const vg = BUILTIN_VALUE_GROUPS.filter((g) => g.dimension === d.id && values.some((v) => v.group === g.id));
      if (values.length) packs.push({ id: d.id, name: d.label, ...(vg.length ? { valueGroups: asItems(vg) } : {}), popValues: asItems(values) });
    }
    const g = govs.get(era.id) ?? [];
    if (g.length) packs.push({ id: 'governments', name: '政体', governments: asItems(g) });
    const f = facs.get(era.id) ?? [];
    if (f.length) packs.push({ id: 'factions', name: '派系', factions: asItems(f) });
    const res = FANTASY_RESOURCES.filter((r) => def?.resources?.includes(r.id));
    if (res.length) packs.push({ id: 'resources', name: '资源', resources: asItems(res) });
    const marks = BUILTIN_LANDMARK_TYPES.filter((t) => !LANDMARK_ERAS.has(t.id) || LANDMARK_ERAS.get(t.id)!.includes(era.id));
    if (marks.length) packs.push({ id: 'landmarks', name: '地标', landmarkTypes: asItems(marks) });
    const listed = def?.cultures ?? [];
    const groups = listed.flatMap(([id, w, opt]) => {
      const x = groupsMap().get(id);
      return x ? [groupPack(x, w, opt?.except)] : [];
    });
    if (!FICTION_ERAS.has(era.id)) for (const id of EU4_GROUPS) if (!listed.some(([x]) => x === id)) groups.push(sparePack(id)!);
    if (groups.length) packs.push({ id: 'cultures', name: '文化', ...(FICTION_ERAS.has(era.id) ? {} : { description: '这个时代默认带的文化组，和别的 EU4 文化组（比重是 0，不参与生成，点名了才加进世界）' }), packs: groups });
    if (era.id === 'fantasy') {
      packs.push(
        { id: 'biomes', name: '奇幻生态', fields: [...FANTASY_FIELDS], biomes: asItems(FANTASY_BIOMES) },
        { id: 'rivers', name: '奇幻的河', riverTypes: asItems([...FANTASY_NEW_RIVER_TYPES, ...FANTASY_RIVER_TYPES]) },
        { id: 'lakes', name: '奇幻的湖', lakeTypes: asItems(FANTASY_LAKE_TYPES) },
      );
    }
    const forms = era.id === 'fantasy' ? { ...shared.forms, planetForms: asItems([...BUILTIN_PLANET_FORMS, ...FANTASY_FORMS]) } : shared.forms;
    packs.push(shared.base, shared.nature, shared.names, forms, shared.styles, shared.tiers, shared.water);
    return top(era.id, era.name, era.description ?? `${era.name}的时代、取值、政体、派系与文化`, packs);
  });
}

let tree: ResourcePack[] | null = null;

// 内置的库（按时代的先后）
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
function fullIndex(): Map<string, BuiltinItem> {
  if (index) return index;
  index = indexTree(builtinPacks());
  // 比重 0 是库里的安排（第五十一轮）：内置的原样是没写比重的那一份，不管树里先碰到的是哪个库的
  for (const g of BUILTIN_CULTURE_GROUPS) {
    const hit = index.get(`cultureGroup\u0000${g.id}`);
    if (hit) hit.item = g;
  }
  return index;
}

// 内置的树里的每一项和它在哪几个包里
export function builtinItems(): readonly BuiltinItem[] {
  return [...fullIndex().values()];
}

// 一项在内置的树里（没有时 undefined）
export const builtinItem = (kind: string, id: string): BuiltinItem | undefined => fullIndex().get(`${kind}\u0000${id}`);

// 内置的一项在树里的位置：prefer 是优先的库（省略时是默认的库）；不在树里时 undefined
export function builtinOrigin(kind: string, id: string, prefer: string = DEFAULT_LIBRARY): string[] | undefined {
  const b = builtinItem(kind, id);
  if (!b) return undefined;
  return [...(b.paths.find((p) => p[0] === prefer) ?? b.paths[0])];
}

// 一项与内置的一模一样（用到世界时“自然生成”关掉的奇幻生态、河、湖也算：与加进世界时的样子比）
export function isBuiltinSame(kind: string, item: unknown): boolean {
  const k = kindOf(kind);
  if (!k) return false;
  const b = builtinItem(kind, itemId(k, item));
  if (!b) return false;
  if (sameContent(k, b.item, item)) return true;
  const fin = k.pack.finalize?.(b.item);
  return fin !== undefined && sameContent(k, fin, item);
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
