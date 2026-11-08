import { z } from 'zod';
import { type IslandType, ISLAND_HEIGHTS, ISLAND_LOOKS, ISLAND_SHAPES, islandTypeSchema, islandTypesOf } from '../island-types';
import { LAKE_STYLES, LAKE_STYLE_LABEL, type LakeType, lakeTypeSchema, lakeTypesOf } from '../lake-types';
import { FEATURE_INFO, type FeatureType } from '../features';
import { type NameStyle, nameStyleSchema, sampleNames, styleInUse, styleNotes, styleProblems, worldStyles } from '../name-styles';
import { type PlanetForm, planetFormSchema } from '../planet-form';
import { DEFAULT_LOOK, type MapStyle, mapStyleSchema, worldMapStyles } from '../map-style';
import { RIVER_STYLES, RIVER_STYLE_LABEL, type RiverType, riverTypeSchema, riverTypesOf } from '../river-types';
import { HEIGHT_MAX, PATTERNS, PATTERN_LABEL, type Species, elevationAsHeight, speciesSchema } from '../species';
import { type LakeWhenKey, LAKE_WHEN_KEYS, WHEN_KEYS, WHEN_RANGE } from '../water-types';
import { CommandError } from '../errors';
import { BIOME_TERRAINS } from '../export-terrain';
import { registerHumanKinds } from '../human/kinds';
import { registerProvinceKind } from './province-kind';
import { type ContentWorld, type FieldDesc, type PackContext, builtinOf, isBuiltinCopy, registerKind } from './registry';
import { registerUsage } from './usage';
import { linkIds } from './links';
import { ITEM_ID, naturalOff, templateLists } from './refs';

// 现有的内容种类登记进登记表（第二十轮）：生态、河 / 湖 / 岛的种类、星球形态、地名风格、自定义场。
// 以前的种类在世界里的放法、命令都不变（登记表只是适配），资源包文件的格式不变。
// 第二十一轮的地形类别、资源登记在 human/kinds.ts（在地名风格之后调用）。
// 登记的先后就是列表、检查的先后；用到世界的先后看 order。

const fieldName = z.string().regex(ITEM_ID, '场名只能包含字母、数字、下划线和连字符');

// ---------- 共用 ----------

// 撞 id 改名时名字带上编号（“血河 2”，最多 12 个字）
function numbered(name: string | undefined, id: string, from: string): string | undefined {
  const k = id.startsWith(`${from}-`) ? id.slice(from.length + 1) : '';
  return name && k ? `${name.slice(0, Math.max(1, 11 - k.length))} ${k}` : name;
}

// 起名模板里用到、哪里都没有的词表
function badLists(who: string, names: readonly { p: string }[] | undefined, lists: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const n of names ?? []) for (const l of templateLists(n.p)) if (!lists.has(l)) out.push(`${who}的起名模板“${n.p}”用到了不存在的词表 {${l}}`);
  return out;
}

// 河流类型、湖泊类型用到的自定义场
function fieldProblems(who: string, kind: string, item: unknown, fields: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const f of linkIds(kind, item, 'field')) {
    if (!ITEM_ID.test(f)) out.push(`${who}用到的自定义场“${f}”名字无效：只能用字母、数字、下划线和连字符`);
    else if (!fields.has(f)) out.push(`${who}用到的自定义场 ${f} 不在资源包里，用时新建一个空的`);
  }
  return out;
}

// 两个数的范围 [小, 大]（星球形态的配方）
const PAIR = (min: number, max: number, step: number): FieldDesc[] => [
  { key: 'lo', label: '小', type: 'number', min, max, step },
  { key: 'hi', label: '大', type: 'number', min, max, step },
];

const NAMES_FIELD: FieldDesc = {
  key: 'names',
  label: '起名模板',
  type: 'list',
  optional: true,
  hint: '{词表} 用地名风格的词表',
  of: [
    { key: 'p', label: '模板', type: 'text' },
    { key: 'w', label: '权重', type: 'number', optional: true, min: 0.01 },
  ],
};

const whenField = (keys: readonly LakeWhenKey[]): FieldDesc => ({
  key: 'when',
  label: '条件',
  type: 'json',
  optional: true,
  hint: '河按每格看，湖按整个湖；到两头是不限',
  of: keys.map((k) => ({ key: k, label: WHEN_RANGE[k].label, type: 'range' as const, optional: true, min: WHEN_RANGE[k].lo, max: WHEN_RANGE[k].hi, step: WHEN_RANGE[k].step, unit: WHEN_RANGE[k].unit })),
});
const WATER_FIELDS: readonly FieldDesc[] = [
  { key: 'id', label: 'id', type: 'text' },
  { key: 'name', label: '名字', type: 'text' },
  { key: 'color', label: '颜色', type: 'color' },
  { key: 'atlasColor', label: '另一种颜色', type: 'color', optional: true, hint: '地图册画风用；空着同颜色' },
  { key: 'natural', label: '自然生成', type: 'bool', optional: true, default: true },
  { key: 'biomes', label: '只在这些生态里', type: 'tags', optional: true, ref: 'biome', dep: 'auto' },
  whenField(WHEN_KEYS),
  {
    key: 'bank',
    label: '岸边的影响',
    type: 'json',
    optional: true,
    of: [
      { key: 'radiusKm', label: '范围', type: 'number', min: 10, max: 1000, step: 10, hint: 'km；越近越强' },
      { key: 'dT', label: '变暖变冷', type: 'number', optional: true, min: -10, max: 10, step: 0.5, hint: '°C' },
      { key: 'dP', label: '变湿变干', type: 'number', optional: true, min: -1.5, max: 1.5, step: 0.05, hint: '降水乘以 e 的这么多次方' },
    ],
  },
  NAMES_FIELD,
  { key: 'scripts', label: '脚本', type: 'script', optional: true },
];

// ---------- 生态 ----------

// 换 id：种子用原来的（省略 seedKey 时种子就是 id），改了名花纹也不变。
// 名字也跟着带上编号（“水晶丛林 2”）：世界里那份不一样的同名生态还在，列表里才分得清
function biomeWithId(sp: Species, id: string, from: string): Species {
  if (id === from) return sp;
  const k = id.startsWith(`${from}-`) ? id.slice(from.length + 1) : '';
  return { ...sp, id, ...(sp.name && k ? { name: `${sp.name} ${k}` } : {}), seedKey: sp.seedKey ?? from };
}

// 世界里能导出的生态：不是内置的原样（内置的改过也算），也不是只在这个世界的某处长的
// （从起源地扩散、只长在某个岛上、圈的范围里：格的编号换个世界没有意义）
export function exportableBiomes(world: ContentWorld): Species[] {
  return world.small.species.filter((s) => !s.dispersal && !s.range && !isBuiltinCopy('biome', s));
}

// 写明“自然生成”（没写的在世界里是开着的；包里没写的加进别的世界时是关着的），换个世界照样
const naturalOn = <T extends { natural?: boolean }>(x: T): T => ({ ...x, natural: x.natural ?? true });

// 生态多了界面挤、算得慢：超过这么多种时提醒一句（不拦）
const SPECIES_SOFT_CAP = 48;

registerKind<Species>({
  id: 'biome',
  label: '生态',
  short: '生态',
  order: 20,
  schema: speciesSchema as unknown as z.ZodType<Species>,
  inWorld: (w) => w.small.species,
  enable: (sp, w) => (w.small.species.some((x) => x.id === sp.id) ? { op: 'update_species', id: sp.id, patch: sp as unknown as Record<string, unknown> } : { op: 'add_species', species: sp }),
  disable: (id) => ({ op: 'remove_species', id }),
  blank: () => ({ id: 'my-biome', name: '新生态', color: '#88aa66', terrain: 'plains', competition: 1, tolerances: [], natural: false }),
  fields: [
    { key: 'id', label: 'id', type: 'text' },
    { key: 'name', label: '名字', type: 'text' },
    { key: 'color', label: '颜色', type: 'color' },
    // 第七十一轮：以前叫“地形类别”，和地形类别那一层（平原、丘陵……）撞名；选项写中文，存的是 id
    { key: 'terrain', label: '导出用的地形', type: 'enum', options: BIOME_TERRAINS.map((t) => ({ value: t.id, label: t.label })), hint: '导出的地形图按它着色' },
    { key: 'competition', label: '强弱', type: 'number', min: 0, max: 100, step: 0.5, hint: '都能长时强的占上风' },
    { key: 'natural', label: '自然生成', type: 'bool', optional: true, default: true },
    { key: 'habitability', label: '宜居度', type: 'number', optional: true, min: 0, max: 1, step: 0.05, hint: '0–1；空着时按气候估' },
    { key: 'movement', label: '通行难度', type: 'number', optional: true, min: 0.1, max: 20, step: 0.05, hint: '草原为 1；空着时按生态估' },
    { key: 'height', label: '高度范围', type: 'range', optional: true, min: 0, max: HEIGHT_MAX, step: 100, unit: 'm', hint: '海拔；空着时不看高度' },
    { key: 'plainRiver', label: '允许普通河', type: 'bool', optional: true },
    { key: 'plainLake', label: '允许普通湖', type: 'bool', optional: true },
    {
      key: 'waterBlock',
      label: '水系不允许时',
      type: 'enum',
      optional: true,
      hint: '断流：河在这里消失',
      options: [
        { value: 'swap', label: '换类型' },
        { value: 'stop', label: '断流' },
      ],
    },
    {
      key: 'tolerances',
      label: '更精细的条件',
      type: 'list',
      hint: '偏低到偏高最好，到两头降到 0',
      of: [
        { key: 'field', label: '条件', type: 'text', ref: 'tolerance' },
        { key: 'min', label: '最低', type: 'number' },
        { key: 'optLow', label: '偏低', type: 'number' },
        { key: 'optHigh', label: '偏高', type: 'number' },
        { key: 'max', label: '最高', type: 'number' },
      ],
    },
    {
      key: 'visual',
      label: '图案',
      type: 'json',
      optional: true,
      of: [
        { key: 'pattern', label: '花纹', type: 'enum', options: PATTERNS.map((p) => ({ value: p, label: PATTERN_LABEL[p] })) },
        { key: 'color2', label: '第二种颜色', type: 'color', optional: true },
        { key: 'amount', label: '明显', type: 'number', optional: true, min: 0, max: 1, step: 0.05 },
        { key: 'size', label: '花纹大小', type: 'number', optional: true, min: 0.1, max: 4, step: 0.1, hint: '以格为单位' },
        { key: 'glow', label: '发光', type: 'number', optional: true, min: 0, max: 1, step: 0.05 },
        { key: 'glowColor', label: '光的颜色', type: 'color', optional: true },
      ],
    },
    {
      key: 'effects',
      label: '对周围的影响',
      type: 'json',
      optional: true,
      of: [
        {
          key: 'climate',
          label: '气候',
          type: 'json',
          optional: true,
          of: [
            { key: 'radiusKm', label: '范围', type: 'number', min: 20, max: 3000, step: 10, hint: 'km' },
            { key: 'dT', label: '变暖变冷', type: 'number', optional: true, min: -10, max: 10, step: 0.5, hint: '°C' },
            { key: 'dP', label: '变湿变干', type: 'number', optional: true, min: -1.5, max: 1.5, step: 0.05 },
          ],
        },
        {
          key: 'invade',
          label: '侵占',
          type: 'json',
          optional: true,
          of: [
            { key: 'targets', label: '目标', type: 'tags', ref: 'biome' },
            { key: 'strength', label: '力度', type: 'number', min: 0, max: 10, step: 0.1 },
          ],
        },
      ],
    },
    {
      key: 'feature',
      label: '地名',
      type: 'json',
      optional: true,
      of: [{ key: 'label', label: '类型名', type: 'text', hint: '“晶林”' }, { ...NAMES_FIELD, label: '起名模板' }],
    },
    { key: 'scripts', label: '脚本', type: 'script', optional: true },
  ],
  pack: {
    key: 'biomes',
    max: 256,
    // 第七十二轮：带着海拔耐受条件的生态，换成高度范围后逐值相同时换掉（界面上海拔只在高度范围里设）
    read: (raw) => elevationAsHeight(raw),
    listed: true,
    checked: true,
    // 只长在某处的生态（从起源地扩散、只在某个岛上、圈的范围里）不勾：起源地的格编号只对做它的那个世界有效
    defaultPick: (b) => !b.dispersal && !b.range,
    withId: biomeWithId,
    finalize: (b) => naturalOff(b),
    fromWorld: exportableBiomes,
    exportItem: (s) => naturalOn(structuredClone(s)),
    problems: (biomes, ctx) => {
      const problems: string[] = [];
      if (biomes.length > SPECIES_SOFT_CAP) problems.push(`生态有 ${biomes.length} 种（超过 ${SPECIES_SOFT_CAP}）：界面会挤，计算会变慢`);
      const known = new Set([...ctx.ids('biomes'), ...builtinOf<Species>('biome').map((b) => b.id)]);
      const rivers = ctx.ids('riverTypes');
      const lakes = ctx.ids('lakeTypes');
      for (const b of biomes) {
        const who = `“${b.name || b.id}”`;
        for (const t of b.effects?.invade?.targets ?? []) if (!known.has(t)) problems.push(`${who}侵占的 ${t} 不在资源包里，也不是内置生态：世界里没有它时无效`);
        problems.push(...fieldProblems(who, 'biome', b, ctx.fields));
        for (const r of linkIds('biome', b, 'riverType')) if (!rivers.has(r)) problems.push(`${who}用到的河流类型 ${r} 不在资源包里：没有这种河时按很远算`);
        for (const r of linkIds('biome', b, 'lakeType')) if (!lakes.has(r)) problems.push(`${who}用到的湖泊类型 ${r} 不在资源包里：没有这种湖时按很远算`);
        problems.push(...badLists(who, b.feature?.names, ctx.lists));
        if (b.dispersal) problems.push(`${who}只在起源地附近长：只对原来的世界有效`);
        if (b.range) problems.push(`${who}只长在某处：只对原来的世界有效`);
      }
      return problems;
    },
  },
});

// ---------- 河流类型、湖泊类型 ----------

// 撞 id 改名时：种子用原来的（匹配的河、湖不变），名字带上编号
function waterTypeWithId<T extends RiverType | LakeType>(t: T, id: string, from: string): T {
  if (id === from) return t;
  return { ...t, id, name: numbered(t.name, id, from), seedKey: t.seedKey ?? from };
}

const waterProblems =
  (what: string, kind: string) =>
  (items: readonly (RiverType | LakeType)[], ctx: PackContext): string[] =>
    items.flatMap((t) => {
      const who = `${what}“${t.name || t.id}”`;
      return [...fieldProblems(who, kind, t, ctx.fields), ...badLists(who, t.names, ctx.lists)];
    });

registerKind<RiverType>({
  id: 'riverType',
  label: '河的种类',
  short: '河流',
  order: 10,
  schema: riverTypeSchema as unknown as z.ZodType<RiverType>,
  inWorld: (w) => riverTypesOf(w.small),
  enable: (type) => ({ op: 'set_river_type', type }),
  disable: (id) => ({ op: 'remove_river_type', id }),
  blank: () => ({ id: 'my-river', name: '新的河', color: '#2a7fbf', natural: false }),
  fields: [...WATER_FIELDS, { key: 'width', label: '粗细', type: 'number', optional: true, min: 0.3, max: 3, step: 0.1 }, { key: 'style', label: '画法', type: 'enum', optional: true, options: RIVER_STYLES.map((s) => ({ value: s, label: RIVER_STYLE_LABEL[s] })) }],
  pack: {
    key: 'riverTypes',
    max: 64,
    listed: true,
    checked: true,
    withId: waterTypeWithId,
    finalize: naturalOff,
    // 世界里的河流类型全部能导出（与内置的一模一样的也带上：从世界存成文件时带着它用的河）
    fromWorld: (w) => riverTypesOf(w.small).map((t) => structuredClone(t)),
    exportItem: (t) => naturalOn(structuredClone(t)),
    problems: waterProblems('河流类型', 'riverType'),
  },
});

registerKind<LakeType>({
  id: 'lakeType',
  label: '湖的种类',
  short: '湖泊',
  order: 11,
  schema: lakeTypeSchema as unknown as z.ZodType<LakeType>,
  inWorld: (w) => lakeTypesOf(w.small),
  enable: (type) => ({ op: 'set_lake_type', type }),
  disable: (id) => ({ op: 'remove_lake_type', id }),
  blank: () => ({ id: 'my-lake', name: '新的湖', color: '#2a7fbf', natural: false }),
  // 湖的条件另有大小（第五十七轮）
  fields: [...WATER_FIELDS.map((f) => (f.key === 'when' ? whenField(LAKE_WHEN_KEYS) : f)), { key: 'style', label: '画法', type: 'enum', optional: true, options: LAKE_STYLES.map((s) => ({ value: s, label: LAKE_STYLE_LABEL[s] })) }],
  pack: {
    key: 'lakeTypes',
    max: 64,
    listed: true,
    checked: true,
    withId: waterTypeWithId,
    finalize: naturalOff,
    fromWorld: (w) => lakeTypesOf(w.small).map((t) => structuredClone(t)),
    exportItem: (t) => naturalOn(structuredClone(t)),
    problems: waterProblems('湖泊类型', 'lakeType'),
  },
});

// ---------- 岛的种类 ----------

registerKind<IslandType>({
  id: 'islandType',
  label: '岛的种类',
  short: '岛',
  order: 12,
  schema: islandTypeSchema as unknown as z.ZodType<IslandType>,
  inWorld: (w) => islandTypesOf(w.small),
  enable: (type) => ({ op: 'set_island_type', type }),
  disable: (id) => ({ op: 'remove_island_type', id }),
  blank: () => islandTypeSchema.parse({ id: 'my-island', name: '新的岛' }) as IslandType,
  fields: [
    { key: 'id', label: 'id', type: 'text' },
    { key: 'name', label: '名字', type: 'text' },
    { key: 'shape', label: '形状', type: 'enum', options: ISLAND_SHAPES.map((s) => ({ value: s, label: s })) },
    { key: 'height', label: '高低', type: 'enum', options: ISLAND_HEIGHTS.map((s) => ({ value: s, label: s })) },
    { key: 'color', label: '颜色', type: 'text', optional: true, hint: `#rrggbb、${ISLAND_LOOKS.join('、')}` },
    { key: 'rock', label: '岩石', type: 'number', optional: true },
    { key: 'province', label: '归哪种省', type: 'enum', options: [{ value: 'land', label: '陆地' }, { value: 'sea', label: '海省' }] },
    NAMES_FIELD,
  ],
  pack: {
    key: 'islandTypes',
    max: 64,
    listed: true,
    checked: true,
    withId: (t, id, from) => (id === from ? t : { ...t, id, name: numbered(t.name, id, from) ?? t.name }),
    // 第三十轮起内置的五种也在 small.islandTypes 里：与内置的一模一样的不导出
    fromWorld: (w) => islandTypesOf(w.small).filter((t) => !isBuiltinCopy('islandType', t)).map((t) => structuredClone(t)),
    exportItem: (t) => structuredClone(t),
    problems: (items, ctx) => items.flatMap((t) => badLists(`岛的种类“${t.name || t.id}”`, t.names, ctx.lists)),
  },
});

// ---------- 星球形态 ----------

// 用到世界不经过资源包的“用到这个世界”（命令是 set_worldgen 的 params.form：在 调整 → 星球形态 里换，或新建世界时选），
// 所以没有 enable。从世界导出时带上世界在用的那一个
registerKind<PlanetForm>({
  id: 'planetForm',
  label: '星球形态',
  short: '星球',
  order: 40,
  schema: planetFormSchema as unknown as z.ZodType<PlanetForm>,
  // 只有生态、场的小世界（测试、旧的调用方）没有 terrain
  inWorld: (w) => {
    const form = w.small.terrain?.gen?.form;
    return form ? [form] : [];
  },
  fields: [
    { key: 'id', label: 'id', type: 'text' },
    { key: 'name', label: '名字', type: 'text' },
    { key: 'hint', label: '说明', type: 'text', optional: true },
    { key: 'base', label: '从哪种星球改起', type: 'text' },
    {
      key: 'profile',
      label: '配方',
      type: 'json',
      optional: true,
      of: [
        { key: 'landFraction', label: '陆地多少', type: 'number', optional: true, min: 0, max: 0.85, step: 0.01 },
        { key: 'islands', label: '岛多少', type: 'number', optional: true, min: 0, max: 1, step: 0.05 },
        { key: 'plates', label: '板块数', type: 'tuple', optional: true, items: PAIR(2, 40, 1) },
        { key: 'blocks', label: '大陆块数', type: 'tuple', optional: true, items: PAIR(0, 60, 1) },
        { key: 'radius', label: '大陆块大小', type: 'tuple', optional: true, items: PAIR(0.02, 0.6, 0.01) },
        { key: 'main', label: '主大陆大小', type: 'tuple', optional: true, items: PAIR(0.05, 0.9, 0.01) },
        { key: 'attach', label: '贴在主块边上', type: 'bool', optional: true },
        { key: 'rise', label: '内陆抬升', type: 'number', optional: true, min: 0, max: 4000, step: 10 },
        { key: 'relief', label: '地表起伏', type: 'number', optional: true, min: 0, max: 2000, step: 10 },
        { key: 'hotspots', label: '热点数', type: 'tuple', optional: true, items: PAIR(0, 30, 1) },
        { key: 'seamounts', label: '海山数', type: 'number', optional: true, min: 0, max: 1000, step: 1 },
        { key: 'ring', label: '排成一圈', type: 'bool', optional: true },
      ],
    },
    {
      key: 'tuning',
      label: '微调',
      type: 'json',
      optional: true,
      of: [
        { key: 'beltWidth', label: '山带宽窄', type: 'number', optional: true, min: 0.3, max: 3, step: 0.05 },
        { key: 'ridge', label: '洋中脊', type: 'number', optional: true, min: 0, max: 3, step: 0.05 },
        { key: 'trench', label: '海沟', type: 'number', optional: true, min: 0, max: 3, step: 0.05 },
        { key: 'rift', label: '裂谷', type: 'number', optional: true, min: 0, max: 3, step: 0.05 },
        { key: 'hills', label: '丘陵', type: 'number', optional: true, min: 0, max: 3, step: 0.05 },
      ],
    },
    { key: 'scripts', label: '脚本', type: 'script', optional: true },
  ],
  pack: {
    key: 'planetForms',
    max: 32,
    listed: true,
    checked: false,
    note: '在“调整 → 星球形态”里换，或新建时选',
    fromWorld: (w) => {
      const form = w.small.terrain?.gen?.form;
      return form ? [form] : [];
    },
    exportItem: (f) => structuredClone(f),
  },
});

// ---------- 地名风格（第二十轮，见 name-styles.ts） ----------

// 旧的文字包（textPacks 里的、单独的文字包文件）：补上 kind，id 不合规时换成合规的
function readStyle(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const o = raw as Record<string, unknown>;
  const out: Record<string, unknown> = o.kind === undefined ? { ...o, kind: 'template' } : { ...o };
  if (typeof out.id === 'string' && !ITEM_ID.test(out.id)) out.id = out.id.replace(/[^\w-]+/g, '-').replace(/^-+|-+$/g, '') || 'style';
  return out;
}

// 编辑器里的随机示例：省份在前，之后按地物的先后，每类 4 个（有原文的写在后面）。风格有问题时不起
const SAMPLE_ORDER = ['province', ...Object.keys(FEATURE_INFO)];
function styleSamples(style: NameStyle, seed: number): { label: string; lines: string[] }[] {
  if (styleProblems(style).length) return [];
  const rank = (t: string) => (SAMPLE_ORDER.includes(t) ? SAMPLE_ORDER.indexOf(t) : SAMPLE_ORDER.length);
  const types = Object.keys(style.types).sort((a, b) => rank(a) - rank(b));
  return types.slice(0, 12).map((type) => ({
    label: type === 'province' ? '省份' : (FEATURE_INFO[type as FeatureType]?.label ?? type),
    lines: sampleNames(style, type, 4, seed).map((n) => (n.orig ? `${n.zh}　${n.orig}` : n.zh)),
  }));
}

const PHONETIC = { key: 'kind', is: 'phonetic' } as const;
const TEMPLATE = { key: 'kind', is: 'template' } as const;
const PATTERN_FIELDS: readonly FieldDesc[] = [
  { key: 'p', label: '写法', type: 'text' },
  { key: 'w', label: '权重', type: 'number', optional: true, min: 0.01 },
];
const PHONETIC_PATTERN_FIELDS: readonly FieldDesc[] = [
  { key: 'p', label: '外文写法', type: 'text', hint: '{root} 是词根，{表名} 换成词' },
  { key: 'zh', label: '中文', type: 'text', optional: true, hint: '{name} 是音译；空着整个音译' },
  { key: 'w', label: '权重', type: 'number', optional: true, min: 0.01 },
];

registerKind<NameStyle>({
  id: 'nameStyle',
  label: '地名风格',
  short: '地名风格',
  order: 30,
  store: 'content',
  maxInWorld: 128,
  schema: nameStyleSchema as unknown as z.ZodType<NameStyle>,
  // 第三十轮起中文·默认也是普通内容（每个库的“地名 ▸ 中文”）
  inWorld: (w) => Object.values(worldStyles(w.small)),
  // 改的是世界默认、或者有地物、省份在用的风格时重新起名
  dirty: (before, after, w) => {
    const id = (after ?? before)!.id;
    return styleInUse(w.small, id) ? 'names' : 'none';
  },
  check: (style) => {
    const problems = styleProblems(style);
    if (problems.length) throw new CommandError(`地名风格有问题：${problems.slice(0, 3).join('；')}`);
  },
  blank: () => ({ id: 'my-style', name: '新风格', kind: 'template', lists: { a: ['青', '白'] }, types: { island: { patterns: [{ p: '{a}岛' }] } } }),
  notes: (style) => styleNotes(style),
  samples: styleSamples,
  fields: [
    { key: 'id', label: 'id', type: 'text' },
    { key: 'name', label: '名字', type: 'text' },
    { key: 'description', label: '说明', type: 'longtext', optional: true },
    {
      key: 'kind',
      label: '写法',
      type: 'enum',
      options: [
        { value: 'template', label: '模板' },
        { value: 'phonetic', label: '音译' },
      ],
    },
    // 模板式
    { key: 'lists', label: '词表', type: 'map', when: TEMPLATE, value: { key: '', label: '词', type: 'tags' } },
    {
      key: 'types',
      label: '各类地物',
      type: 'map',
      when: TEMPLATE,
      of: [
        { key: 'patterns', label: '模板', type: 'list', of: PATTERN_FIELDS },
        { key: 'byTag', label: '按情境', type: 'map', optional: true, value: { key: '', label: '模板', type: 'list', of: PATTERN_FIELDS } },
      ],
    },
    { key: 'readings', label: '读音表', type: 'map', optional: true, when: TEMPLATE, value: { key: '', label: '原文', type: 'text' }, hint: '汉字 → 原文，读得出整个名字时才有原文' },
    // 音译式
    {
      key: 'syllables',
      label: '音节',
      type: 'json',
      when: PHONETIC,
      of: [
        { key: 'onsets', label: '声母', type: 'weighted' },
        { key: 'nuclei', label: '韵核', type: 'weighted' },
        { key: 'codas', label: '韵尾', type: 'weighted' },
        { key: 'first', label: '开头的声母', type: 'weighted', optional: true },
        { key: 'last', label: '结尾的韵尾', type: 'weighted', optional: true },
      ],
    },
    {
      key: 'length',
      label: '音节数',
      type: 'tuples',
      when: PHONETIC,
      items: [
        { key: 'n', label: '音节数', type: 'number', min: 1, max: 6, step: 1 },
        { key: 'w', label: '权重', type: 'number', min: 0.01, step: 0.1 },
      ],
    },
    { key: 'lists', label: '词缀', type: 'map', optional: true, when: PHONETIC, value: { key: '', label: '词', type: 'weighted' } },
    { key: 'forbid', label: '不许的写法', type: 'tags', optional: true, when: PHONETIC, hint: '^ 开头，$ 结尾' },
    {
      key: 'types',
      label: '各类地物',
      type: 'map',
      when: PHONETIC,
      of: [
        { key: 'patterns', label: '写法', type: 'list', of: PHONETIC_PATTERN_FIELDS },
        { key: 'byTag', label: '按情境', type: 'map', optional: true, value: { key: '', label: '写法', type: 'list', of: PHONETIC_PATTERN_FIELDS } },
      ],
    },
    { key: 'translit', label: '音译表', type: 'map', when: PHONETIC, value: { key: '', label: '汉字', type: 'text' }, hint: '罗马字 → 汉字，取最长的一段' },
    { key: 'vowels', label: '元音字母', type: 'text', optional: true, when: PHONETIC },
    { key: 'fallback', label: '没有的字母写成', type: 'text', optional: true, when: PHONETIC },
  ],
  pack: {
    key: 'nameStyles',
    // 以前的文字包就是模板式的地名风格
    aliases: ['textPacks'],
    // 第四十三轮：内置的有 76 种（EU4 的每个文化组一种）
    max: 128,
    listed: true,
    checked: true,
    read: readStyle,
    withId: (s, id, from) => (id === from ? s : { ...s, id, name: `${s.name} ${id.slice(from.length + 1) || id}` }),
    fromWorld: (w) => Object.values(worldStyles(w.small)).filter((s) => !isBuiltinCopy('nameStyle', s)).map((s) => structuredClone(s)),
    exportItem: (s) => structuredClone(s),
    problems: (items) => items.flatMap((s) => [...styleProblems(s), ...styleNotes(s)].map((p) => `地名风格“${s.name}”：${p}`)),
  },
});

// ---------- 地形类别、资源（第二十一轮，见 human/kinds.ts） ----------

registerHumanKinds();

// ---------- 画风（第三十八轮，见 map-style.ts） ----------

const TIERS = { key: 'sea', is: 'tiers' } as const;
const TINTED = { key: 'landShade', is: 'tinted' } as const;
const STYLE_HINT = '#rrggbb、rgb()、rgba()';
const withDefaults = (fields: FieldDesc[]): FieldDesc[] => fields.map((f) => (f.key in DEFAULT_LOOK ? { ...f, default: DEFAULT_LOOK[f.key as keyof typeof DEFAULT_LOOK] } : f));

registerKind<MapStyle>({
  id: 'mapStyle',
  label: '画风',
  short: '画风',
  order: 45,
  store: 'content',
  maxInWorld: 32,
  schema: mapStyleSchema as unknown as z.ZodType<MapStyle>,
  inWorld: (w) => Object.values(worldMapStyles(w.small)),
  // 只是画法：改了、加了、停用了都不重算（地图按世界选的画风重画）
  dirty: () => 'none',
  blank: () => mapStyleSchema.parse({ id: 'my-map-style', name: '新画风' }),
  // 换了“海”“山影”以后新露出来的几项从默认的画法（写实）补上
  fields: withDefaults([
    { key: 'id', label: 'id', type: 'text' },
    { key: 'name', label: '名字', type: 'text' },
    { key: 'description', label: '说明', type: 'longtext', optional: true },
    { key: 'landTint', label: '陆地底色', type: 'color', hint: STYLE_HINT },
    { key: 'landTintAmount', label: '底色的比例', type: 'number', min: 0, max: 1, step: 0.05, hint: '0 不混底色' },
    {
      key: 'landShade',
      label: '山影',
      type: 'enum',
      options: [
        { value: 'plain', label: '平常' },
        { value: 'tinted', label: '着色' },
      ],
      hint: '着色：暗处、亮处各乘一种颜色',
    },
    { key: 'shadeDark', label: '山影的暗色', type: 'color', when: TINTED },
    { key: 'shadeLight', label: '山影的亮色', type: 'color', when: TINTED, hint: 'rgb 里可写到 510，亮处更亮' },
    {
      key: 'sea',
      label: '海',
      type: 'enum',
      options: [
        { value: 'shade', label: '明暗' },
        { value: 'tiers', label: '按水深分层' },
      ],
      hint: '海面是数据（海水温度）时都按明暗画',
    },
    { key: 'seaShade', label: '海的明暗', type: 'number', min: 0, max: 1, step: 0.01, hint: '海底的坡画出多少明暗（0 平的）' },
    { key: 'tier1', label: '第一层（浅海）', type: 'color', when: TIERS },
    { key: 'depth2', label: '第二层从多深起（m）', type: 'number', min: 1, max: 20000, step: 10, when: TIERS },
    { key: 'tier2', label: '第二层', type: 'color', when: TIERS },
    { key: 'depth3', label: '第三层从多深起（m）', type: 'number', min: 1, max: 20000, step: 10, when: TIERS },
    { key: 'tier3', label: '第三层', type: 'color', when: TIERS },
    { key: 'depth4', label: '第四层从多深起（m）', type: 'number', min: 1, max: 20000, step: 10, when: TIERS },
    { key: 'tier4', label: '第四层（深海）', type: 'color', when: TIERS },
    { key: 'isobath', label: '等深线', type: 'color', when: TIERS },
    { key: 'isobathAmount', label: '等深线的浓淡', type: 'number', min: 0, max: 1, step: 0.05, when: TIERS },
    { key: 'tierShade', label: '分层的海的明暗', type: 'number', min: 0, max: 1, step: 0.01, when: TIERS },
    { key: 'glow', label: '生态发光', type: 'number', min: 0, max: 2, step: 0.05 },
    { key: 'coastLine', label: '海岸线', type: 'color' },
    { key: 'coastAmount', label: '海岸线的浓淡', type: 'number', min: 0, max: 1, step: 0.05 },
    { key: 'provinceLine', label: '省界', type: 'color' },
    { key: 'countryLine', label: '国界', type: 'color' },
    { key: 'river', label: '河', type: 'color', hint: STYLE_HINT },
    { key: 'riverBank', label: '河岸', type: 'color' },
    { key: 'road', label: '大道（道路工具里）', type: 'color' },
    { key: 'roadMinor', label: '小路（道路工具里）', type: 'color' },
    { key: 'quietRoad', label: '大道', type: 'color' },
    { key: 'quietRoadMinor', label: '小路', type: 'color' },
    { key: 'countryLabel', label: '国名', type: 'color' },
    {
      key: 'typeColors',
      label: '河湖的种类用',
      type: 'enum',
      options: [
        { value: 'color', label: '颜色' },
        { value: 'atlasColor', label: '另一种颜色' },
      ],
    },
  ]),
  pack: {
    key: 'mapStyles',
    max: 32,
    listed: true,
    checked: true,
    withId: (s, id, from) => (id === from ? s : { ...s, id, name: `${s.name} ${id.slice(from.length + 1) || id}`.slice(0, 24) }),
    fromWorld: (w) => Object.values(worldMapStyles(w.small)).filter((s) => !isBuiltinCopy('mapStyle', s)).map((s) => structuredClone(s)),
    exportItem: (s) => structuredClone(s),
  },
});

// ---------- 省份划分（第七十八轮，见 province-kind.ts） ----------

registerProvinceKind();

// ---------- 自定义场 ----------

// 生态、河湖类型用到的场在用到世界时自动先加（不勾选、不列在“生态 5 · 河流 4”里）
registerKind<string>({
  id: 'field',
  label: '自定义场',
  short: '场',
  order: 0,
  schema: fieldName,
  idOf: (s) => s,
  nameOf: (s) => s,
  inWorld: (w) => Object.keys(w.causes.fields),
  enable: (name) => ({ op: 'add_field', name }),
  disable: (name) => ({ op: 'remove_field', name }),
  fields: [{ key: '', label: '名字', type: 'text' }],
  pack: { key: 'fields', max: 64, listed: false, checked: true },
});

// ---------- 用在哪里（第二十八轮，见 usage.ts）：全部登记完之后挂上 ----------

registerUsage();
