import { z } from 'zod';
import { type IslandType, ISLAND_HEIGHTS, ISLAND_LOOKS, ISLAND_SHAPES, islandTypeSchema, islandTypesOf } from '../island-types';
import { type LakeType, lakeTypeSchema, lakeTypesOf } from '../lake-types';
import { FEATURE_INFO, type FeatureType } from '../features';
import { DEFAULT_STYLE, type NameStyle, nameStyleSchema, sampleNames, styleInUse, styleNotes, styleProblems, worldStyles } from '../name-styles';
import { DEFAULT_PACK } from '../names';
import { BUILTIN_STYLES } from '../packs/names';
import { type PlanetForm, planetFormSchema } from '../planet-form';
import { RIVER_STYLES, type RiverType, riverTypeSchema, riverTypesOf } from '../river-types';
import { DEFAULT_SPECIES, type Species, speciesSchema } from '../species';
import { CommandError } from '../errors';
import { type ContentWorld, type FieldDesc, type PackContext, type Renames, registerKind } from './registry';
import { ITEM_ID, biomeFields, biomeLakes, biomeRivers, fieldRefs, naturalOff, rewriteRiverRefs, sameItem, stableJson, templateLists } from './refs';

// 现有的内容种类登记进登记表（第二十轮）：生态、河 / 湖 / 岛的种类、星球形态、地名风格、自定义场。
// 以前的种类在世界里的放法、命令都不变（登记表只是适配），资源包文件的格式不变。
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
function fieldProblems(who: string, item: Parameters<typeof fieldRefs>[0], fields: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const f of fieldRefs(item)) {
    if (!ITEM_ID.test(f)) out.push(`${who}用到的自定义场“${f}”名字无效：只能用字母、数字、下划线和连字符`);
    else if (!fields.has(f)) out.push(`${who}用到的自定义场 ${f} 不在资源包里，用时新建一个空的`);
  }
  return out;
}

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

const WATER_FIELDS: readonly FieldDesc[] = [
  { key: 'id', label: 'id', type: 'text' },
  { key: 'name', label: '名字', type: 'text' },
  { key: 'color', label: '颜色', type: 'color' },
  { key: 'atlasColor', label: '地图集颜色', type: 'color', optional: true },
  { key: 'natural', label: '自然生成', type: 'bool', optional: true },
  { key: 'biomes', label: '只在这些生态里', type: 'tags', optional: true },
  {
    key: 'bank',
    label: '岸边的影响',
    type: 'json',
    optional: true,
  },
  NAMES_FIELD,
  { key: 'scripts', label: '脚本', type: 'script', optional: true },
];

// ---------- 生态 ----------

// 生态里的引用跟着改名：侵占的目标、脚本里的 river('x')、耐受条件里的 river:x、lake:x
export function rewriteBiome(sp: Species, renames: Renames): Species {
  let out = sp;
  if (sp.tolerances.some((t) => t.field.startsWith('river:') && (renames.riverTypes.get(t.field.slice(6)) ?? t.field.slice(6)) !== t.field.slice(6))) {
    out = { ...out, tolerances: sp.tolerances.map((t) => (t.field.startsWith('river:') ? { ...t, field: `river:${renames.riverTypes.get(t.field.slice(6)) ?? t.field.slice(6)}` } : t)) };
  }
  const lakes = renames.lakeTypes ?? new Map<string, string>();
  if (sp.tolerances.some((t) => t.field.startsWith('lake:') && (lakes.get(t.field.slice(5)) ?? t.field.slice(5)) !== t.field.slice(5))) {
    out = { ...out, tolerances: out.tolerances.map((t) => (t.field.startsWith('lake:') ? { ...t, field: `lake:${lakes.get(t.field.slice(5)) ?? t.field.slice(5)}` } : t)) };
  }
  const inv = sp.effects?.invade;
  if (inv && inv.targets.some((t) => (renames.biomes.get(t) ?? t) !== t)) {
    out = { ...out, effects: { ...out.effects, invade: { ...inv, targets: inv.targets.map((t) => renames.biomes.get(t) ?? t) } } };
  }
  if (sp.scripts && (renames.riverTypes.size || lakes.size)) {
    const scripts = Object.fromEntries(Object.entries(sp.scripts).map(([k, s]) => [k, s && { ...s, src: rewriteRiverRefs(s.src, renames.riverTypes, lakes) }]));
    if (stableJson(scripts) !== stableJson(sp.scripts)) out = { ...out, scripts };
  }
  return out;
}

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
  const builtin = new Map(DEFAULT_SPECIES.map((s) => [s.id, s]));
  return world.small.species.filter((s) => !s.dispersal && !s.range && !(builtin.has(s.id) && sameItem(builtin.get(s.id), s)));
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
  builtin: () => DEFAULT_SPECIES,
  enable: (sp, w) => (w.small.species.some((x) => x.id === sp.id) ? { op: 'update_species', id: sp.id, patch: sp as unknown as Record<string, unknown> } : { op: 'add_species', species: sp }),
  disable: (id) => ({ op: 'remove_species', id }),
  fields: [
    { key: 'id', label: 'id', type: 'text' },
    { key: 'name', label: '名字', type: 'text' },
    { key: 'color', label: '颜色', type: 'color' },
    { key: 'terrain', label: '地形类别', type: 'text', hint: '导出的地形图按它着色' },
    { key: 'competition', label: '竞争力', type: 'number', min: 0, max: 100, step: 0.5 },
    { key: 'natural', label: '自然生成', type: 'bool', optional: true },
    { key: 'tolerances', label: '耐受条件', type: 'json' },
    { key: 'visual', label: '样子', type: 'json', optional: true },
    { key: 'effects', label: '对周围的影响', type: 'json', optional: true },
    { key: 'feature', label: '地名设定', type: 'json', optional: true },
    { key: 'scripts', label: '脚本', type: 'script', optional: true },
  ],
  pack: {
    key: 'biomes',
    max: 256,
    listed: true,
    checked: true,
    // 只长在某处的生态（从起源地扩散、只在某个岛上、圈的范围里）不勾：起源地的格编号只对做它的那个世界有效
    defaultPick: (b) => !b.dispersal && !b.range,
    withId: biomeWithId,
    rewrite: rewriteBiome,
    finalize: (b) => naturalOff(b),
    fieldsOf: biomeFields,
    fromWorld: exportableBiomes,
    exportItem: (s) => naturalOn(structuredClone(s)),
    problems: (biomes, ctx) => {
      const problems: string[] = [];
      if (biomes.length > SPECIES_SOFT_CAP) problems.push(`生态有 ${biomes.length} 种（超过 ${SPECIES_SOFT_CAP}）：界面会挤，计算会变慢`);
      const known = new Set([...ctx.ids('biomes'), ...DEFAULT_SPECIES.map((b) => b.id)]);
      const rivers = ctx.ids('riverTypes');
      const lakes = ctx.ids('lakeTypes');
      for (const b of biomes) {
        const who = `“${b.name || b.id}”`;
        for (const t of b.effects?.invade?.targets ?? []) if (!known.has(t)) problems.push(`${who}侵占的 ${t} 不在资源包里，也不是内置生态：世界里没有它时无效`);
        problems.push(...fieldProblems(who, b, ctx.fields));
        for (const r of biomeRivers(b)) if (!rivers.has(r)) problems.push(`${who}用到的河流类型 ${r} 不在资源包里：没有这种河时按很远算`);
        for (const r of biomeLakes(b)) if (!lakes.has(r)) problems.push(`${who}用到的湖泊类型 ${r} 不在资源包里：没有这种湖时按很远算`);
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

// 加进世界前：“只在这些生态里”按改了名的生态，没写“自然生成”的关掉
function waterFinalize<T extends RiverType | LakeType>(t: T, r: Renames): T {
  return naturalOff(t.biomes ? { ...t, biomes: t.biomes.map((b) => r.biomes.get(b) ?? b) } : t);
}

const waterProblems =
  (what: string) =>
  (items: readonly (RiverType | LakeType)[], ctx: PackContext): string[] =>
    items.flatMap((t) => {
      const who = `${what}“${t.name || t.id}”`;
      return [...fieldProblems(who, t, ctx.fields), ...badLists(who, t.names, ctx.lists)];
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
  fields: [...WATER_FIELDS, { key: 'width', label: '粗细', type: 'number', optional: true, min: 0.3, max: 3, step: 0.1 }, { key: 'style', label: '画法', type: 'enum', optional: true, options: RIVER_STYLES.map((s) => ({ value: s, label: s })) }],
  pack: {
    key: 'riverTypes',
    max: 64,
    listed: true,
    checked: true,
    withId: waterTypeWithId,
    finalize: waterFinalize,
    fieldsOf: (t) => fieldRefs(t).filter((f) => ITEM_ID.test(f)),
    // 世界里的河流类型都是用户加的（没有内置的），全部能导出
    fromWorld: (w) => riverTypesOf(w.small).map((t) => structuredClone(t)),
    exportItem: (t) => naturalOn(structuredClone(t)),
    problems: waterProblems('河流类型'),
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
  fields: WATER_FIELDS,
  pack: {
    key: 'lakeTypes',
    max: 64,
    listed: true,
    checked: true,
    withId: waterTypeWithId,
    finalize: waterFinalize,
    fieldsOf: (t) => fieldRefs(t).filter((f) => ITEM_ID.test(f)),
    fromWorld: (w) => lakeTypesOf(w.small).map((t) => structuredClone(t)),
    exportItem: (t) => naturalOn(structuredClone(t)),
    problems: waterProblems('湖泊类型'),
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
  fields: [
    { key: 'id', label: 'id', type: 'text' },
    { key: 'name', label: '名字', type: 'text' },
    { key: 'shape', label: '形状', type: 'enum', options: ISLAND_SHAPES.map((s) => ({ value: s, label: s })) },
    { key: 'height', label: '高低', type: 'enum', options: ISLAND_HEIGHTS.map((s) => ({ value: s, label: s })) },
    { key: 'color', label: '颜色', type: 'text', optional: true, hint: `#rrggbb 或 ${ISLAND_LOOKS.join('、')}` },
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
    // 内置的几种不在 small.islandTypes 里：世界里的都是用户加的，全部能导出
    fromWorld: (w) => islandTypesOf(w.small).map((t) => structuredClone(t)),
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
    { key: 'profile', label: '配方', type: 'json', optional: true },
    { key: 'tuning', label: '微调', type: 'json', optional: true },
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

// 内置中文风格（small.wordPack 换过时是它）按地名风格的样子
export function zhDefaultStyle(small: Pick<ContentWorld['small'], 'wordPack'>): NameStyle {
  return { ...(small.wordPack ?? DEFAULT_PACK), id: DEFAULT_STYLE, kind: 'template' };
}

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
  { key: 'p', label: '原文', type: 'text', hint: '{root} 是词根，{表名} 换成词表里的一项' },
  { key: 'zh', label: '中文', type: 'text', optional: true, hint: '{name} 是整个原文的音译；省略时整个音译' },
  { key: 'w', label: '权重', type: 'number', optional: true, min: 0.01 },
];

registerKind<NameStyle>({
  id: 'nameStyle',
  label: '地名风格',
  short: '地名风格',
  order: 30,
  store: 'content',
  maxInWorld: 64,
  schema: nameStyleSchema as unknown as z.ZodType<NameStyle>,
  // 内置中文总在世界里（放在 small.wordPack，见 name-styles.ts 的 styleById）
  inWorld: (w) => [zhDefaultStyle(w.small), ...Object.values(worldStyles(w.small))],
  builtin: () => BUILTIN_STYLES,
  // 改的是世界默认、或者有地物、省份在用的风格时重新起名
  dirty: (before, after, w) => {
    const id = (after ?? before)!.id;
    return styleInUse(w.small, id) ? 'names' : 'none';
  },
  check: (style) => {
    if (style.id === DEFAULT_STYLE) throw new CommandError('内置中文不能换掉，复制一份改');
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
    { key: 'length', label: '音节数', type: 'json', when: PHONETIC, hint: '[音节数, 权重] 的列表' },
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
    max: 64,
    listed: true,
    checked: true,
    read: readStyle,
    withId: (s, id, from) => (id === from ? s : { ...s, id, name: `${s.name} ${id.slice(from.length + 1) || id}` }),
    fromWorld: (w) => Object.values(worldStyles(w.small)).map((s) => structuredClone(s)),
    exportItem: (s) => structuredClone(s),
    problems: (items) => items.flatMap((s) => [...styleProblems(s), ...styleNotes(s)].map((p) => `地名风格“${s.name}”：${p}`)),
  },
});

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
