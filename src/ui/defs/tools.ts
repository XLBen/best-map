import { computed, effect } from '@preact/signals';
import {
  Brush,
  CloudRain,
  Dices,
  Droplet,
  Droplets,
  Eraser,
  Hammer,
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
import { islandSizeRangeKm, roundKm, sizeText } from '../../../core/terrain';
import { islandTypeById, liveIslandKind } from '../../../core/island-types';
import { ChainFragSlider, ChainTypePick, IslandTypePick, TerrainExtras } from '../panels/islandTypes';
import type { World } from '../../../core/world';
import {
  type Category,
  brushRange,
  cursorHint,
  lakeRange,
  measure,
  mode,
  options,
  reachRange,
  registerToolSwitch,
  selectedFeature,
  selectedProvince,
  selectedLake,
  selectedRiver,
  setOptions,
  tool,
  world,
} from '../../state';
import { lakeSizeDraft } from '../lakeInfo';
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
  fragmentTool,
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
  rerollTool,
  riverSizeName,
  snapRadiusKm,
  spotTool,
} from '../tools';
import { clearBarPreview } from '../barPreview';
import { RIVER_END_HINTS, riverTool, unwaterTool } from '../riverCourse';
import {
  BiomeChip,
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
import { failingHighlights, featureHighlights, provinceHighlights, selectedRiverFocus } from '../map/highlights';
import type { CategoryDef, SliderDef, ToolDef, ToolSpec } from './types';

// ---------- 滑块 ----------

const fmtKm = (v: number) => String(roundKm(v));

// 画笔、岛、岛链的大小都写直径（第十三轮统一）；最小都是一格，写“一格 ≈ N km”（滑块存的是半径）
const BRUSH: SliderDef = {
  key: 'brushKm',
  label: '直径',
  range: brushRange,
  scale: 'log',
  snap: snapRadiusKm,
  format: (v, w) => sizeText(w, v),
};

const brushAs = (label: string): SliderDef => ({ ...BRUSH, label });

// 岛的大小写成直径：碎岛（第十八轮）可以比一格小，直接写多少 km；别的岛不到半格写“一格 ≈ N km”
const islandSizeText = (w: World, kind: string, v: number) => {
  const r = Math.max(islandSizeRangeKm(w, kind)[0], v);
  return islandTypeById(w.small, liveIslandKind(w, kind))?.shape === 'frag' ? `${fmtKm(r * 2)} km` : sizeText(w, r);
};

// 各种岛的最小值相同（一格，碎岛更小）；一格的岛（小礁）不用调大小
const ISLAND: SliderDef = {
  key: 'islandKm',
  label: '直径',
  range: (w) => islandSizeRangeKm(w, options.value.islandKind),
  scale: 'log',
  snap: snapRadiusKm,
  format: (v, w) => islandSizeText(w, options.value.islandKind, v),
  enabled: (w) => islandTypeById(w.small, liveIslandKind(w, options.value.islandKind))?.shape !== 'cell',
};

// 岛链自己的大小：放岛时选了小礁、调了大小都不影响岛链
const CHAIN_SIZE: SliderDef = {
  key: 'chainKm',
  label: '直径',
  range: (w) => islandSizeRangeKm(w, options.value.chainKind),
  scale: 'log',
  snap: snapRadiusKm,
  format: (v, w) => islandSizeText(w, options.value.chainKind, v),
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

// 冷暖、干湿的力度（各有各的）：数值写成会升降多少度、雨水多少
const CLIMATE_AMOUNT = (group: 'temp' | 'moist'): SliderDef => ({
  key: group === 'temp' ? 'tempAmount' : 'moistAmount',
  label: '力度',
  range: () => [0.25, CLIMATE_MAX],
  scale: 'log',
  snap: (v) => Math.round(v * 20) / 20,
  format: (v) => climateEffect(climateKind(group, options.value), v).short,
});

// ---------- 底部条上常用的几项 ----------

const biomeModes = {
  kind: 'choice' as const,
  key: 'biomeMode' as const,
  options: [
    { value: 'natural', label: '自然融入', hint: '系统调整这里的冷暖干湿，让它真的长出来，周围平滑过渡' },
    { value: 'force', label: '强制', hint: '只改涂到的格，气候和河流不变' },
  ],
};

// 画河：顺地势还是自定义走向；画的线停在陆地上时“流下去”还是“停在这”（第十四轮改成短的叫法，细的说法在悬停的提示里）
const riverModes = {
  kind: 'choice' as const,
  key: 'riverMode' as const,
  label: '走向',
  options: [
    { value: 'flow', label: '顺地势', hint: '新画的河：点一下或拖一下，河顺着地势流（改已有的河总是照着画的线走）' },
    { value: 'course', label: '自定义走向', hint: '新画的河：按住画出河道，河完全照着走' },
  ],
};
export const riverEnds = {
  kind: 'choice' as const,
  key: 'riverEnd' as const,
  label: '终点',
  options: [
    { value: 'flow', label: '流下去', hint: RIVER_END_HINTS.flow },
    { value: 'sink', label: '停在这', hint: RIVER_END_HINTS.sink },
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

const SPECS = {
  land: {
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
  island: {
    category: 'terrain',
    icon: TreePalm,
    name: '放岛',
    short: '放岛',
    how: '点一下放岛，按住往外拖直接拖出大小',
    size: ISLAND,
    // 每放一个岛自动换一个形状（只用鼠标，没有“换个形状”按钮）
    bar: () => [{ kind: 'custom', render: IslandTypePick }],
    create: () => islandTool(),
  },
  chain: {
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
      // 用岛链自己的大小（第十二轮修正：以前误用了放岛的大小）
      format: (v, w) => `${v < 0.75 ? '稀疏' : v < 1.35 ? '正常' : '密集'} ${percent(v, 1)} · 间距约 ${fmtKm((2.6 * Math.max(islandSizeRangeKm(w, options.value.chainKind)[0], options.value.chainKm)) / v)} km`,
    },
    // 每画一条岛链自动换一种排列（只用鼠标，没有“换个排列”按钮）。碎岛的比例（第十八轮）在种类旁边
    bar: () => [{ kind: 'custom', render: ChainTypePick }, { kind: 'custom', render: ChainFragSlider }],
    create: () => chainTool(),
  },
  relief: {
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
  fragment: {
    // 第十八轮：打碎
    category: 'terrain',
    icon: Hammer,
    name: '打碎',
    short: '打碎',
    how: '按住涂，把地形打碎；停一下先看结果',
    size: BRUSH,
    amount: { key: 'fragAmount', label: '力度', range: () => [0.1, 1], scale: 'linear', snap: (v) => Math.round(v * 20) / 20, format: (v) => percent(v, 1) },
    bar: () => [
      {
        kind: 'choice',
        key: 'fragMode',
        options: [
          { value: 'blocks', label: '裂成碎块', hint: '陆地裂开成一块块，块与块之间是海峡；力度越大块越小、海峡越宽' },
          { value: 'coast', label: '只打碎海岸', hint: '内陆不动，海岸一两格以内支离破碎，外面撒一圈碎岛' },
        ],
      },
    ],
    create: () => fragmentTool(),
  },
  reroll: {
    category: 'terrain',
    icon: Dices,
    name: '重画这一片',
    short: '重画',
    how: '停一下先看重画后的样子；点一下，圈里的地形重新随机，圈外不变',
    size: brushAs('直径'),
    create: () => rerollTool(),
  },
  biome: {
    category: 'nature',
    icon: Paintbrush,
    name: '涂生态',
    short: '涂生态',
    how: '在陆地上涂；Alt+点吸取那里的生态',
    size: BRUSH,
    amount: REACH,
    bar: () => [{ kind: 'custom', render: BiomeChip }, biomeModes, { kind: 'custom', render: UnmetChip }],
    pick: pickSpecies,
    create: () => biomeTool(),
  },
  grow: {
    category: 'nature',
    icon: Move,
    name: '拖动扩张',
    short: '扩张',
    how: '按住一片生态往外拖，拖得越远长得越多',
    size: brushAs('起点'),
    amount: REACH,
    bar: () => [biomeModes, { kind: 'custom', render: UnmetChip }],
    create: () => growTool(),
  },
  restore: {
    category: 'terrain',
    icon: Eraser,
    name: '恢复原样',
    short: '恢复',
    how: '按住涂：画过的陆地、海、山和放的岛（斜线标出的格）退回生成时的样子；不管“重画这一片”（虚线圈，用历史撤销）',
    size: BRUSH,
    create: () => restoreTool(),
  },
  temp: {
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
  moist: {
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
  unclimate: {
    category: 'climate',
    icon: Eraser,
    name: '擦掉冷暖干湿',
    short: '擦掉',
    how: '按住涂：把改过的冷暖干湿（斜线标出的格）恢复原样；不管自定义场和生态对周围的影响',
    size: BRUSH,
    create: () => climateEraseTool(),
  },
  erase: {
    category: 'nature',
    icon: Eraser,
    name: '擦除',
    short: '擦除',
    how: '按住涂：擦掉涂过的生态（斜线标出的格），恢复自然；只长在某个岛上的生态在生态抽屉的“长在哪里”里改',
    size: BRUSH,
    create: () => eraseTool(),
  },
  range: {
    // 第十二轮：给生态选“长在哪里”（从生态编辑器的“选岛”“圈一下”进来，不在工具列表里）
    category: 'nature',
    icon: LassoSelect,
    name: '选生态的范围',
    short: '选范围',
    how: '点一个岛，或按住圈一片：这种生态只长在那里',
    hidden: () => true,
    bar: () => [{ kind: 'custom', render: RangeBar }],
    cursor: 'pointer',
    // 离开选生态的范围：不选了
    onLeave(): void {
      rangePick.value = null;
    },
    // 写明类型：它读的状态的类型里有 ToolId（由这张表推出来），不写会绕成一个圈
    watch: (): unknown => rangePick.value,
    create: () => rangeTool(),
  },
  field: {
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
  river: {
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
    // 离开画河：选中的河不要了
    onLeave(): void {
      selectedRiver.value = null;
    },
    watch: (): unknown => selectedRiver.value,
    focus: selectedRiverFocus,
    create: (env) => riverTool(env.zoom),
  },
  lake: {
    category: 'water',
    icon: Droplet,
    name: '放湖',
    short: '放湖',
    how: '点一下放湖，按住往外拖直接拖出大小 · 点一个湖选中它',
    // 选中一个湖时，底部条换成这个湖的设置（新湖的大小先收起来）
    size: { ...LAKE, enabled: () => !selectedLake.value },
    bar: () => (selectedLake.value ? [{ kind: 'custom', render: LakeBar }] : [{ kind: 'custom', render: NewLakeTypePick }]),
    // 离开放湖：选中的湖不要了
    onLeave(): void {
      selectedLake.value = null;
    },
    watch: (): unknown => [selectedLake.value, lakeSizeDraft.value],
    create: () => lakeTool(),
  },
  unwater: {
    category: 'water',
    icon: Trash2,
    name: '删除河湖',
    short: '删河湖',
    how: '删掉画过的河或湖；停一下会标出真正会变干的河段',
    cursor: 'pointer',
    create: (env) => unwaterTool(env.zoom),
  },
  pselect: {
    category: 'provinces',
    icon: MousePointer2,
    name: '选省份',
    short: '选省',
    how: '点一个省，在下面改名、改类型',
    bar: () => [{ kind: 'custom', render: ProvinceColorToggle }, { kind: 'custom', render: ProvinceBar }],
    cursor: 'pointer',
    create: () => provinceSelectTool(),
  },
  pbrush: {
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
  pcut: {
    category: 'provinces',
    icon: Scissors,
    name: '剪刀',
    short: '剪刀',
    how: '画一条线把省切开',
    bar: () => [{ kind: 'custom', render: ProvinceColorToggle }, { kind: 'custom', render: ProvinceBar }],
    create: (env) => provinceCutTool(env.zoom),
  },
  pmerge: {
    category: 'provinces',
    icon: Merge,
    name: '合并',
    short: '合并',
    how: '先点一个省，再点要并进来的省',
    bar: () => [{ kind: 'custom', render: ProvinceColorToggle }, { kind: 'custom', render: ProvinceBar }],
    cursor: 'pointer',
    create: () => provinceMergeTool(),
  },
  pregen: {
    category: 'provinces',
    icon: RefreshCw,
    name: '重新划分',
    short: '重划',
    how: '涂一片，里面的省重新自动划分；停一下先看新的省界',
    size: BRUSH,
    bar: () => [{ kind: 'custom', render: ProvinceColorToggle }],
    create: () => provinceRegenTool(),
  },
  rename: {
    category: 'names',
    icon: PenLine,
    name: '改名',
    short: '改名',
    how: '点地图上的名字',
    bar: () => [{ kind: 'custom', render: NamesBar }],
    cursor: 'pointer',
    create: (env) => renameTool(env.hitLabel),
  },
  area: {
    category: 'names',
    icon: LassoSelect,
    name: '圈一块起名',
    short: '圈地名',
    how: '按住画一个圈，圈里成为一个地区、平原、山地……',
    bar: () => [{ kind: 'custom', render: NamesBar }],
    create: (env) => regionTool(env.hitLabel),
  },
  spot: {
    category: 'names',
    icon: MapPinPlus,
    name: '放一个地名',
    short: '放地名',
    how: '点一下放一个地名，比如城镇、渡口、海角',
    bar: () => [{ kind: 'custom', render: NamesBar }],
    create: (env) => spotTool(env.hitLabel, env.zoom),

  },
} satisfies Record<string, ToolSpec>;

// 工具的 id：工具表里的键
export type ToolId = keyof typeof SPECS;

export const TOOL_DEFS = Object.fromEntries(Object.entries(SPECS).map(([id, d]) => [id, { ...d, id }])) as Record<ToolId, ToolDef>;

// ---------- 类别 ----------

// 每一类的工具按工具表里的先后
const toolsIn = (c: Category) => (Object.keys(TOOL_DEFS) as ToolId[]).filter((id) => TOOL_DEFS[id].category === c);

export const CATEGORIES: CategoryDef[] = [
  { id: 'terrain', icon: Mountain, label: '地形', tools: toolsIn('terrain'), extras: TerrainExtras },
  { id: 'climate', icon: ThermometerSun, label: '气候', tools: toolsIn('climate') },
  { id: 'nature', icon: Leaf, label: '自然', tools: toolsIn('nature'), extras: NatureExtras, map: { highlights: failingHighlights } },
  { id: 'water', icon: Droplets, label: '水系', tools: toolsIn('water'), extras: RiverExtras, map: { markers: true } },
  {
    id: 'provinces',
    icon: MapIcon,
    label: '省份',
    tools: toolsIn('provinces'),
    extras: ProvinceExtras,
    // 离开省份：选中的省不要了
    onLeave: () => (selectedProvince.value = null),
    watch: () => selectedProvince.value,
    map: { highlights: provinceHighlights, provinces: true },
  },
  {
    id: 'names',
    icon: Type,
    label: '地名',
    tools: toolsIn('names'),
    extras: NamesExtras,
    // 离开地名：选中的地名不要了
    onLeave: () => (selectedFeature.value = null),
    watch: () => selectedFeature.value,
    map: { highlights: featureHighlights, labels: () => selectedFeature.value },
  },
];

export const CATEGORY_DEFS = Object.fromEntries(CATEGORIES.map((c) => [c.id, c])) as Record<Category, CategoryDef>;

// 当前工具属于哪一类
export const category = computed<Category>(() => TOOL_DEFS[tool.value].category);

// 工具列表里显示的工具：隐藏的工具正在用时照样显示
export function toolsOf(c: Category, w: World | null): ToolId[] {
  return CATEGORY_DEFS[c].tools.filter((id) => id === tool.value || !w || !TOOL_DEFS[id].hidden?.(w));
}

// 地图跟着重画的状态：所有工具、类别声明的（不管开着的是哪个）
export function watchTools() {
  for (const d of Object.values(TOOL_DEFS)) d.watch?.();
  for (const c of CATEGORIES) c.watch?.();
}

// 每一类记住上次用的工具：换回来时还是原样。底图只在“图层”里换，换工具、换类别都不动它
const lastTool: Partial<Record<Category, ToolId>> = {};

// 换工具（所有换工具都走这里：面板里、工具里经 state.ts 的 switchTool）：离开的工具、离开的类别声明的东西清掉
export function setTool(id: ToolId) {
  const fromTool = tool.value;
  const from = category.value;
  if (fromTool !== id) TOOL_DEFS[fromTool].onLeave?.();
  if (from !== TOOL_DEFS[id].category) {
    CATEGORY_DEFS[from].onLeave?.();
    lastTool[from] = fromTool;
  }
  tool.value = id;
  cursorHint.value = null;
  // 底部条按钮悬停时的预览（省份的对半分开、重新划分，河的截短、延长）：按钮随着换工具消失，收不到“移开”，
  // 以前会一直画在新工具上（第十三轮修）。点下去了、等结果的那一份留着
  clearBarPreview();
  // 换工具就不再量距离
  measure.value = null;
}
registerToolSwitch(setTool);

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

// 新世界：回到地形、画陆地，各类不再记着上次用的工具
export function resetTools() {
  setTool('land');
  for (const k of Object.keys(lastTool)) delete lastTool[k as Category];
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
