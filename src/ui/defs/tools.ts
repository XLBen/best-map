import { computed, effect } from '@preact/signals';
import {
  Brush,
  CloudRain,
  Dices,
  Droplet,
  Droplets,
  Eraser,
  LassoSelect,
  Leaf,
  Map as MapIcon,
  MapPinPlus,
  Merge,
  Mountain,
  MountainSnow,
  Move,
  Paintbrush,
  PenLine,
  RefreshCw,
  Scissors,
  MousePointer2,
  Sparkles,
  Spline,
  Thermometer,
  ThermometerSun,
  TreePalm,
  Trash2,
  Type,
  Waypoints,
} from 'lucide-preact';
import { CHAIN_KINDS, ISLAND_KINDS, ISLAND_KIND_INFO, islandSizeRangeKm, roundKm } from '../../../core/terrain';
import type { World } from '../../../core/world';
import {
  type Category,
  type ToolId,
  brushRange,
  cursorHint,
  lakeRange,
  measure,
  mode,
  options,
  reachRange,
  selectedProvince,
  selectedLake,
  selectedRiver,
  setOptions,
  tool,
  world,
} from '../../state';
import {
  CLIMATE_MAX,
  FIELD_MAX,
  RELIEF_MAX,
  biomeTool,
  chainTool,
  climateEffect,
  climateEraseTool,
  climateKind,
  climateTool,
  eraseTool,
  fieldTool,
  fmtFlow,
  growTool,
  islandTool,
  lakeTool,
  landTool,
  provinceBrushTool,
  provinceCutTool,
  provinceMergeTool,
  provinceRegenTool,
  provinceSelectTool,
  regionTool,
  reliefTool,
  renameTool,
  restoreTool,
  rangePick,
  rangeTool,
  rerollChain,
  rerollTool,
  riverSizeName,
  snapRadiusKm,
  spotTool,
} from '../tools';
import { riverTool, unwaterTool } from '../riverCourse';
import {
  BiomeChip,
  IgnoredChip,
  RangeBar,
  NamesBar,
  NamesExtras,
  NatureExtras,
  ProvinceBar,
  ProvinceColorToggle,
  ProvinceExtras,
  RiverBar,
  RiverExtras,
  NewRiverTypePick,
  LakeBar,
  NewLakeTypePick,
  UnmetChip,
} from './extras';
import type { CategoryDef, SliderDef, ToolDef } from './types';

// ---------- 滑块 ----------

const fmtKm = (v: number) => String(roundKm(v));

const BRUSH: SliderDef = {
  key: 'brushKm',
  label: '半径',
  range: brushRange,
  scale: 'log',
  snap: (v) => roundKm(v),
  format: (v) => `${fmtKm(v)} km`,
};

const brushAs = (label: string): SliderDef => ({ ...BRUSH, label });

// 岛的最小值随种类（珊瑚岛大一些）；小礁只占一格，不用调大小。
// 滑块停在别的种类的大小上时（比如从火山岛换成珊瑚岛），写出的是补到这一种最小值后的大小，与放出来的一样
const ISLAND: SliderDef = {
  key: 'islandKm',
  label: '直径',
  range: (w) => islandSizeRangeKm(w, options.value.islandKind),
  scale: 'log',
  snap: snapRadiusKm,
  format: (v, w) => `${fmtKm(Math.max(islandSizeRangeKm(w, options.value.islandKind)[0], v) * 2)} km`,
  enabled: () => options.value.islandKind !== 'reef',
};

// 岛链自己的大小：放岛时选了小礁、调了大小都不影响岛链
const CHAIN_SIZE: SliderDef = {
  key: 'chainKm',
  label: '直径',
  range: (w) => islandSizeRangeKm(w, options.value.chainKind),
  scale: 'log',
  snap: snapRadiusKm,
  format: (v, w) => `${fmtKm(Math.max(islandSizeRangeKm(w, options.value.chainKind)[0], v) * 2)} km`,
};

const LAKE: SliderDef = {
  key: 'lakeKm',
  label: '直径',
  range: lakeRange,
  scale: 'log',
  snap: snapRadiusKm,
  format: (v) => `${fmtKm(v * 2)} km`,
};

// 自然融入：周围多远跟着平滑过渡（“强制”时用不上，不显示）
const REACH: SliderDef = {
  key: 'reachKm',
  label: '过渡',
  range: reachRange,
  scale: 'log',
  snap: (v) => roundKm(v),
  format: (v) => `${fmtKm(v)} km`,
  enabled: () => options.value.biomeMode === 'natural',
};

const RIVER: SliderDef = {
  key: 'riverFlow',
  label: '大小',
  range: () => [1, 80],
  scale: 'log',
  snap: (v) => (v < 10 ? Math.round(v * 10) / 10 : Math.round(v)),
  format: (v, w) => `${riverSizeName(v)} ${fmtFlow(v * w.small.planet.riverThreshold)} m³/s`,
};

const percent = (v: number, base: number) => `${Math.round((v / base) * 100)}%`;

// 冷暖、干湿的力度：数值写成会升降多少度、雨水多少
const CLIMATE_AMOUNT = (group: 'temp' | 'moist'): SliderDef => ({
  key: 'climateAmount',
  label: '力度',
  range: () => [0.25, CLIMATE_MAX],
  scale: 'log',
  snap: (v) => Math.round(v * 20) / 20,
  format: (v) => climateEffect(climateKind(group), v).short,
});

// ---------- 底部条上常用的几项 ----------

const islandKinds = { kind: 'choice' as const, key: 'islandKind' as const, options: ISLAND_KINDS.map((k) => ({ value: k, label: ISLAND_KIND_INFO[k].name, hint: ISLAND_KIND_INFO[k].hint })) };
const chainKinds = { kind: 'choice' as const, key: 'chainKind' as const, options: CHAIN_KINDS.map((k) => ({ value: k, label: ISLAND_KIND_INFO[k].name, hint: ISLAND_KIND_INFO[k].hint })) };
const biomeModes = {
  kind: 'choice' as const,
  key: 'biomeMode' as const,
  options: [
    { value: 'natural', label: '自然融入', hint: '系统调整这里的冷暖干湿，让它真的长出来，周围平滑过渡' },
    { value: 'force', label: '强制', hint: '只改涂到的格，气候和河流不变' },
  ],
};

// 画河：顺地势还是自定义走向；自定义走向时画到陆地上之后接着流还是消失
const riverModes = {
  kind: 'choice' as const,
  key: 'riverMode' as const,
  label: '走向',
  options: [
    { value: 'flow', label: '顺地势', hint: '新画的河：点一下或拖一下，河顺着地势流（改已有的河总是照着画的线走）' },
    { value: 'course', label: '自定义走向', hint: '新画的河：按住画出河道，河完全照着走' },
  ],
};
const riverEnds = {
  kind: 'choice' as const,
  key: 'riverEnd' as const,
  options: [
    { value: 'flow', label: '画完接着流', hint: '画的线停在陆地上时（新画的河、从河上改道、接长），顺着地势流到海、湖或别的河' },
    { value: 'sink', label: '画完就消失', hint: '画的线停在陆地上时（新画的河、从河上改道、接长），河在那里渗进地下' },
  ],
};

const pickSpecies = (w: World, cell: number) => {
  const s = w.derived.dominant[cell];
  const sp = s >= 0 ? w.small.species[s] : null;
  if (!sp) return null;
  setOptions({ biome: sp.id });
  return sp.name;
};

// ---------- 工具 ----------

const defs: ToolDef[] = [
  {
    id: 'land',
    category: 'terrain',
    icon: Brush,
    name: '画陆地 / 海',
    short: '陆海',
    how: '按住涂，或选“圈一片”圈出一块；按住 Shift 反过来',
    size: { ...BRUSH, enabled: () => options.value.landShape === 'brush' },
    bar: () => [
      {
        kind: 'choice',
        key: 'landMode',
        options: [
          { value: 'land', label: '画陆地' },
          { value: 'sea', label: '画海' },
        ],
      },
      {
        kind: 'choice',
        key: 'landShape',
        options: [
          { value: 'brush', label: '画笔', hint: '按住拖动，画笔下变成陆地（海）' },
          { value: 'lasso', label: '圈一片', hint: '按住画一个圈，松手后圈里变成陆地（海）' },
        ],
      },
    ],
    create: () => landTool(),
  },
  {
    id: 'island',
    category: 'terrain',
    icon: TreePalm,
    name: '放岛',
    short: '放岛',
    how: '点一下放岛，按住往外拖直接拖出大小',
    size: ISLAND,
    // 小礁只有一种样子，不用“换个形状”
    bar: () => [
      islandKinds,
      ...(options.value.islandKind === 'reef'
        ? []
        : [{ kind: 'action' as const, icon: Dices, label: '换个形状', title: '快捷键 R', run: () => setOptions({ islandVariant: options.value.islandVariant + 1 }) }]),
    ],
    reroll: () => setOptions({ islandVariant: options.value.islandVariant + 1 }),
    create: () => islandTool(),
  },
  {
    id: 'chain',
    category: 'terrain',
    icon: Waypoints,
    name: '画岛链',
    short: '岛链',
    how: '拖一条线，沿线长出一串大小不一的岛',
    size: CHAIN_SIZE,
    amount: {
      key: 'chainDensity',
      label: '疏密',
      range: () => [0.4, 2.5],
      scale: 'log',
      snap: (v) => Math.round(v * 20) / 20,
      // 写出岛与岛之间大约隔多远（与 chainIslands 的间距同一个算法：岛的半径 × 2.6 ÷ 疏密）
      format: (v) => `${v < 0.75 ? '稀疏' : v < 1.35 ? '正常' : '密集'} ${percent(v, 1)} · 间距约 ${fmtKm((2.6 * options.value.islandKm) / v)} km`,
    },
    // 换个排列：上一条岛链还是最后一步时重新排它（只算一次，历史里只留一步），否则换下一条的排列
    bar: () => [chainKinds, { kind: 'action', icon: Dices, label: '换个排列', title: '重新排上一条岛链（快捷键 R）', run: () => void rerollChain() }],
    reroll: () => void rerollChain(),
    create: () => chainTool(),
  },
  {
    id: 'relief',
    category: 'terrain',
    icon: MountainSnow,
    name: '堆山 / 压低',
    short: '堆山',
    how: '按住拖动让地势升高或降低',
    size: BRUSH,
    amount: { key: 'reliefAmount', label: '力度', range: () => [0.15, RELIEF_MAX], scale: 'log', snap: (v) => Math.round(v * 100) / 100, format: (v) => percent(v, 0.7) },
    bar: () => [
      {
        kind: 'choice',
        key: 'reliefMode',
        options: [
          { value: 'up', label: '堆山' },
          { value: 'down', label: '压低' },
        ],
      },
    ],
    create: () => reliefTool(),
  },
  {
    id: 'reroll',
    category: 'terrain',
    icon: Dices,
    name: '重画这一片',
    short: '重画',
    how: '停一下先看重画后的样子；点一下，圈里的地形重新随机，圈外不变',
    size: brushAs('半径'),
    create: () => rerollTool(),
  },
  {
    id: 'biome',
    category: 'nature',
    icon: Paintbrush,
    name: '涂生态',
    short: '涂生态',
    how: '在陆地上涂；Alt+点吸取那里的生态',
    size: BRUSH,
    amount: REACH,
    bar: () => [{ kind: 'custom', render: BiomeChip }, biomeModes, { kind: 'custom', render: UnmetChip }, { kind: 'custom', render: IgnoredChip }],
    pick: pickSpecies,
    create: () => biomeTool(),
  },
  {
    id: 'grow',
    category: 'nature',
    icon: Move,
    name: '拖动扩张',
    short: '扩张',
    how: '按住一片生态往外拖，拖得越远长得越多',
    size: brushAs('起点'),
    amount: REACH,
    bar: () => [biomeModes, { kind: 'custom', render: UnmetChip }, { kind: 'custom', render: IgnoredChip }],
    create: () => growTool(),
  },
  {
    id: 'restore',
    category: 'terrain',
    icon: Eraser,
    name: '恢复原样',
    short: '恢复',
    how: '按住涂：画过的陆地、海、山和放的岛（斜线标出的格）退回生成时的样子；不管“重画这一片”（虚线圈，用历史撤销）',
    size: BRUSH,
    create: () => restoreTool(),
  },
  {
    id: 'temp',
    category: 'climate',
    icon: Thermometer,
    name: '冷暖',
    short: '冷暖',
    how: '按住涂：让一片地方变冷或变暖（冰原、雪山、热带）；按住 Shift 反过来',
    size: BRUSH,
    amount: CLIMATE_AMOUNT('temp'),
    bar: () => [
      {
        kind: 'choice',
        key: 'tempMode',
        options: [
          { value: 'cold', label: '更冷' },
          { value: 'warm', label: '更暖' },
        ],
      },
    ],
    create: () => climateTool('temp'),
  },
  {
    id: 'moist',
    category: 'climate',
    icon: CloudRain,
    name: '干湿',
    short: '干湿',
    how: '按住涂：让一片地方雨水变多或变少；按住 Shift 反过来',
    size: BRUSH,
    amount: CLIMATE_AMOUNT('moist'),
    bar: () => [
      {
        kind: 'choice',
        key: 'moistMode',
        options: [
          { value: 'wet', label: '更湿' },
          { value: 'dry', label: '更干' },
        ],
      },
    ],
    create: () => climateTool('moist'),
  },
  {
    id: 'unclimate',
    category: 'climate',
    icon: Eraser,
    name: '擦掉冷暖干湿',
    short: '擦掉',
    how: '按住涂：把改过的冷暖干湿（斜线标出的格）恢复原样；不管自定义场和生态对周围的影响',
    size: BRUSH,
    create: () => climateEraseTool(),
  },
  {
    // 第十二轮：给生态选“长在哪里”（从生态编辑器的“选岛”“圈一下”进来，不在工具列表里）
    id: 'range',
    category: 'nature',
    icon: LassoSelect,
    name: '选生态的范围',
    short: '选范围',
    how: '点一个岛，或按住圈一片：这种生态只长在那里',
    hidden: () => true,
    bar: () => [{ kind: 'custom', render: RangeBar }],
    create: () => rangeTool(),
  },
  {
    id: 'erase',
    category: 'nature',
    icon: Eraser,
    name: '擦除',
    short: '擦除',
    how: '按住涂：擦掉涂过的生态（斜线标出的格），恢复自然；只长在某个岛上的生态在生态抽屉的“长在哪里”里改',
    size: BRUSH,
    create: () => eraseTool(),
  },
  {
    id: 'field',
    category: 'climate',
    icon: Sparkles,
    name: '涂自定义场',
    short: '场',
    how: '让“魔力”这类自定义的量变大或变小',
    size: BRUSH,
    amount: { key: 'fieldAmount', label: '力度', range: () => [0.05, FIELD_MAX], scale: 'log', snap: (v) => Math.round(v * 100) / 100, format: (v) => `±${v.toFixed(2)}` },
    hidden: (w) => !Object.keys(w.causes.fields).length,
    bar: (w) => [
      { kind: 'choice', key: 'field', options: Object.keys(w.causes.fields).map((f) => ({ value: f, label: f })) },
      {
        kind: 'choice',
        key: 'fieldMode',
        options: [
          { value: 'add', label: '增加' },
          { value: 'sub', label: '减少' },
        ],
      },
    ],
    create: () => fieldTool(),
  },
  {
    id: 'river',
    category: 'water',
    icon: Spline,
    name: '画河',
    short: '画河',
    how: '从河上起笔是改这条河，从别处起笔是画新的河 · 点一条河选中它，拖它的控制点改走向',
    // 选中一条河时，底部条换成那条河的设置（新河的大小先收起来）
    size: { ...RIVER, enabled: () => !selectedRiver.value },
    bar: () =>
      selectedRiver.value
        ? [{ kind: 'custom', render: RiverBar }]
        : [riverModes, riverEnds, { kind: 'custom', render: NewRiverTypePick }],
    create: (env) => riverTool(env.zoom),
  },
  {
    id: 'lake',
    category: 'water',
    icon: Droplet,
    name: '放湖',
    short: '放湖',
    how: '点一下放湖，按住往外拖直接拖出大小 · 点一个湖选中它',
    // 选中一个湖时，底部条换成这个湖的设置（新湖的大小先收起来）
    size: { ...LAKE, enabled: () => !selectedLake.value },
    bar: () => (selectedLake.value ? [{ kind: 'custom', render: LakeBar }] : [{ kind: 'custom', render: NewLakeTypePick }]),
    create: () => lakeTool(),
  },
  {
    id: 'unwater',
    category: 'water',
    icon: Trash2,
    name: '删除河湖',
    short: '删河湖',
    how: '删掉画过的河或湖；停一下会标出真正会变干的河段',
    create: (env) => unwaterTool(env.zoom),
  },
  {
    id: 'pselect',
    category: 'provinces',
    icon: MousePointer2,
    name: '选省份',
    short: '选省',
    how: '点一个省，在下面改名、改类型',
    bar: () => [{ kind: 'custom', render: ProvinceColorToggle }, { kind: 'custom', render: ProvinceBar }],
    create: () => provinceSelectTool(),
  },
  {
    id: 'pbrush',
    category: 'provinces',
    icon: Paintbrush,
    name: '省份画笔',
    short: '涂省',
    how: '把格子涂进选中的省；Alt+点吸取一个省',
    size: BRUSH,
    bar: () => [{ kind: 'custom', render: ProvinceColorToggle }, { kind: 'custom', render: ProvinceBar }],
    pick: (w, cell) => {
      const id = w.causes.province[cell];
      if (id < 0 || !w.small.provinces[id]) return null;
      selectedProvince.value = id;
      return w.small.provinces[id].name;
    },
    create: () => provinceBrushTool(),
  },
  {
    id: 'pcut',
    category: 'provinces',
    icon: Scissors,
    name: '剪刀',
    short: '剪刀',
    how: '画一条线把省切开',
    bar: () => [{ kind: 'custom', render: ProvinceColorToggle }, { kind: 'custom', render: ProvinceBar }],
    create: (env) => provinceCutTool(env.zoom),
  },
  {
    id: 'pmerge',
    category: 'provinces',
    icon: Merge,
    name: '合并',
    short: '合并',
    how: '先点一个省，再点要并进来的省',
    bar: () => [{ kind: 'custom', render: ProvinceColorToggle }, { kind: 'custom', render: ProvinceBar }],
    create: () => provinceMergeTool(),
  },
  {
    id: 'pregen',
    category: 'provinces',
    icon: RefreshCw,
    name: '重新划分',
    short: '重划',
    how: '涂一片，里面的省重新自动划分；停一下先看新的省界',
    size: BRUSH,
    bar: () => [{ kind: 'custom', render: ProvinceColorToggle }],
    create: () => provinceRegenTool(),
  },
  {
    id: 'rename',
    category: 'names',
    icon: PenLine,
    name: '改名',
    short: '改名',
    how: '点地图上的名字',
    bar: () => [{ kind: 'custom', render: NamesBar }],
    create: (env) => renameTool(env.hitLabel),
  },
  {
    id: 'area',
    category: 'names',
    icon: LassoSelect,
    name: '圈一块起名',
    short: '圈地名',
    how: '按住画一个圈，圈里成为一个地区、平原、山地……',
    bar: () => [{ kind: 'custom', render: NamesBar }],
    create: (env) => regionTool(env.hitLabel),
  },
  {
    id: 'spot',
    category: 'names',
    icon: MapPinPlus,
    name: '放一个地名',
    short: '放地名',
    how: '点一下放一个地名，比如城镇、渡口、海角',
    bar: () => [{ kind: 'custom', render: NamesBar }],
    create: (env) => spotTool(env.hitLabel, env.zoom),
  },
];

export const TOOL_DEFS = Object.fromEntries(defs.map((d) => [d.id, d])) as Record<ToolId, ToolDef>;

// ---------- 类别 ----------

export const CATEGORIES: CategoryDef[] = [
  { id: 'terrain', icon: Mountain, label: '地形', tools: ['land', 'island', 'chain', 'relief', 'reroll', 'restore'] },
  { id: 'climate', icon: ThermometerSun, label: '气候', tools: ['temp', 'moist', 'unclimate', 'field'] },
  { id: 'nature', icon: Leaf, label: '自然', tools: ['biome', 'grow', 'erase', 'range'], extras: NatureExtras },
  { id: 'water', icon: Droplets, label: '水系', tools: ['river', 'lake', 'unwater'], extras: RiverExtras },
  { id: 'provinces', icon: MapIcon, label: '省份', tools: ['pselect', 'pbrush', 'pcut', 'pmerge', 'pregen'], extras: ProvinceExtras },
  { id: 'names', icon: Type, label: '地名', tools: ['rename', 'area', 'spot'], extras: NamesExtras },
];

export const CATEGORY_DEFS = Object.fromEntries(CATEGORIES.map((c) => [c.id, c])) as Record<Category, CategoryDef>;

// 当前工具属于哪一类
export const category = computed<Category>(() => TOOL_DEFS[tool.value].category);

// 工具列表里显示的工具：隐藏的工具正在用时照样显示
export function toolsOf(c: Category, w: World | null): ToolId[] {
  return CATEGORY_DEFS[c].tools.filter((id) => id === tool.value || !w || !TOOL_DEFS[id].hidden?.(w));
}

// 每一类记住上次用的工具：换回来时还是原样。底图只在“图层”里换，换工具、换类别都不动它
const lastTool: Partial<Record<Category, ToolId>> = {};

export function setTool(id: ToolId) {
  const from = category.value;
  // 离开画河：选中的河不要了
  if (tool.value === 'river' && id !== 'river') selectedRiver.value = null;
  // 离开放湖：选中的湖不要了
  if (tool.value === 'lake' && id !== 'lake') selectedLake.value = null;
  // 离开选生态的范围：不选了
  if (tool.value === 'range' && id !== 'range') rangePick.value = null;
  if (from !== TOOL_DEFS[id].category) lastTool[from] = tool.value;
  tool.value = id;
  cursorHint.value = null;
  // 换工具就不再量距离
  measure.value = null;
}

export function setCategory(c: Category) {
  if (c === category.value) return;
  const w = world.value;
  const remembered = lastTool[c];
  setTool(remembered && toolsOf(c, w).includes(remembered) ? remembered : CATEGORY_DEFS[c].tools[0]);
}

// 选一种生态来涂：现在的工具用不上生态时，换到“涂生态”
export function paintWith(speciesId: string) {
  setOptions({ biome: speciesId });
  if (tool.value !== 'biome') setTool('biome');
}

// 新世界：回到地形、画陆地
export function resetTools() {
  for (const k of Object.keys(lastTool)) delete lastTool[k as Category];
  tool.value = 'land';
  mode.value = 'terrain';
}

// 涂自定义场：自定义场被删掉了就换一个，都删了就回到冷暖
effect(() => {
  const w = world.value;
  if (!w || tool.value !== 'field') return;
  const names = Object.keys(w.causes.fields);
  if (!names.length) setTool('temp');
  else if (!options.value.field || !w.causes.fields[options.value.field]) setOptions({ field: names[0] });
});
