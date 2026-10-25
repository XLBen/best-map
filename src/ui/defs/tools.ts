import { computed, effect } from '@preact/signals';
import {
  Brush,
  CloudRain,
  Dices,
  Droplet,
  Droplets,
  Eraser,
  Gem,
  Hammer,
  LandPlot,
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
  Users,
  UsersRound,
  Waypoints,
  Flag,
  Languages,
  Castle,
  MousePointerClick,
  SquarePlus,
  Star,
} from 'lucide-preact';
import { islandSizeRangeKm, roundKm, sizeText } from '../../../core/terrain';
import { islandTypeById, liveIslandKind } from '../../../core/island-types';
import { viewAvailable } from './layers';
import { ChainFragSlider, ChainTypePick, IslandTypePick, TerrainExtras } from '../panels/islandTypes';
import type { World } from '../../../core/world';
import { worldDimensions } from '../../../core/human';
import {
  type Category,
  type ViewMode,
  brushRange,
  selectedCountry,
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
  terrainClassTool,
  resourceTool,
  pickClass,
  pickResource,
} from '../tools';
import { ClassPick, ResourcePick } from '../panels/human';
import { CultureExtras, CulturePick, FactorSlider, HearthBar, NoHumanChip, PopTuplePick, ValuePick } from '../panels/culture';
import { cultureTool, hearthTool, pickCulture, pickPop, popTool } from '../tools/culture';
import { capitalTool, countryMergeTool, countrySelectTool, newCountryTool, pickTerritory, territoryTool } from '../tools/countries';
import { CountryExtras, NEW_COUNTRY_SHAPES, NoCountryChip, SelectedCountryChip, TerritoryPick } from '../panels/countries';
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
    { value: 'natural', label: '自然融入', hint: '调整冷暖干湿，让它长出来' },
    { value: 'force', label: '强制', hint: '只改涂到的格，气候和河流不变' },
  ],
};

// 画河：顺地势还是自定义走向；画的线停在陆地上时“流下去”还是“停在这”（第十四轮改成短的叫法，细的说法在悬停的提示里）
const riverModes = {
  kind: 'choice' as const,
  key: 'riverMode' as const,
  label: '走向',
  options: [
    { value: 'flow', label: '顺地势', hint: '点击源头，河顺地势流' },
    { value: 'course', label: '自定义走向', hint: '按住画出河道，河照着走' },
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
    how: '按住涂陆地或海；Shift 反过来',
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
          { value: 'brush', label: '画笔', hint: '按住拖动涂' },
          { value: 'lasso', label: '圈一片', hint: '圈住的地方变成陆地或海' },
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
    how: '点击放岛，往外拖定直径',
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
    how: '拖一条线，沿线长出一串岛',
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
    how: '按住涂，抬高或压低地势',
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
    how: '按住涂，把陆地打碎',
    size: BRUSH,
    amount: { key: 'fragAmount', label: '力度', range: () => [0.1, 1], scale: 'linear', snap: (v) => Math.round(v * 20) / 20, format: (v) => percent(v, 1) },
    bar: () => [
      {
        kind: 'choice',
        key: 'fragMode',
        options: [
          { value: 'blocks', label: '裂成碎块', hint: '裂成碎块，中间是海峡' },
          { value: 'coast', label: '只打碎海岸', hint: '内陆不动，外面撒碎岛' },
        ],
      },
    ],
    create: () => fragmentTool(),
  },
  reroll: {
    category: 'terrain',
    icon: Dices,
    name: '重画',
    short: '重画',
    how: '点击，圈里的地形重新随机',
    size: BRUSH,
    create: () => rerollTool(),
  },
  biome: {
    category: 'nature',
    icon: Paintbrush,
    name: '涂生态',
    short: '涂生态',
    how: '在陆地上涂；Alt+点击吸取生态',
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
    how: '按住生态往外拖，越远长得越多',
    size: BRUSH,
    amount: REACH,
    bar: () => [biomeModes, { kind: 'custom', render: UnmetChip }],
    create: () => growTool(),
  },
  restore: {
    category: 'terrain',
    icon: Eraser,
    name: '恢复',
    short: '恢复',
    how: '按住涂，地形回到生成时的样子',
    size: BRUSH,
    create: () => restoreTool(),
  },
  terrainClass: {
    // 第二十一轮：画地形类别（只改类别，不动高度）
    category: 'terrain',
    icon: LandPlot,
    name: '地形类别',
    short: '类别',
    how: '按住涂，改地形类别；Alt+点击吸取',
    size: BRUSH,
    bar: () => [{ kind: 'custom', render: ClassPick }],
    pick: pickClass,
    view: 'terrainClass',
    create: () => terrainClassTool(),
  },
  temp: {
    category: 'climate',
    icon: Thermometer,
    name: '冷暖',
    short: '冷暖',
    how: '按住涂，变冷或变暖；Shift 反过来',
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
    how: '按住涂，变湿或变干；Shift 反过来',
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
    name: '擦除冷暖干湿',
    short: '擦除',
    how: '按住涂，擦除改过的冷暖干湿',
    size: BRUSH,
    create: () => climateEraseTool(),
  },
  erase: {
    category: 'nature',
    icon: Eraser,
    name: '擦除生态',
    short: '擦除',
    how: '按住涂，擦除涂过的生态',
    size: BRUSH,
    create: () => eraseTool(),
  },
  range: {
    // 第十二轮：给生态选“长在哪里”（从生态编辑器的“选岛”“圈一下”进来，不在工具列表里）
    category: 'nature',
    icon: LassoSelect,
    name: '选生态的范围',
    short: '选范围',
    how: '点岛或圈一片，生态只长在那里',
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
  resource: {
    // 第二十一轮：画资源
    category: 'nature',
    icon: Gem,
    name: '资源',
    short: '资源',
    how: '按住涂，改资源；Alt+点击吸取',
    size: BRUSH,
    bar: () => [{ kind: 'custom', render: ResourcePick }],
    pick: pickResource,
    view: 'resource',
    create: () => resourceTool(),
  },
  field: {
    category: 'climate',
    icon: Sparkles,
    name: '涂自定义场',
    short: '场',
    how: '按住涂，增减自定义场',
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
    how: '从河上起笔改河，别处起笔画新河',
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
    how: '点击放湖，往外拖定直径',
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
    how: '点击删除画的河或湖',
    cursor: 'pointer',
    create: (env) => unwaterTool(env.zoom),
  },
  pselect: {
    category: 'provinces',
    icon: MousePointer2,
    name: '选省份',
    short: '选择',
    how: '点击选中省份',
    bar: () => [{ kind: 'custom', render: ProvinceColorToggle }, { kind: 'custom', render: ProvinceBar }],
    cursor: 'pointer',
    create: () => provinceSelectTool(),
  },
  pbrush: {
    category: 'provinces',
    icon: Paintbrush,
    name: '省份画笔',
    short: '画笔',
    how: '涂进选中的省份；Alt+点击吸取',
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
    how: '画线切开省份',
    bar: () => [{ kind: 'custom', render: ProvinceColorToggle }, { kind: 'custom', render: ProvinceBar }],
    create: (env) => provinceCutTool(env.zoom),
  },
  pmerge: {
    category: 'provinces',
    icon: Merge,
    name: '合并',
    short: '合并',
    how: '先点省份，再点要并入的',
    bar: () => [{ kind: 'custom', render: ProvinceColorToggle }, { kind: 'custom', render: ProvinceBar }],
    cursor: 'pointer',
    create: () => provinceMergeTool(),
  },
  pregen: {
    category: 'provinces',
    icon: RefreshCw,
    name: '重新划分',
    short: '重划',
    how: '涂一片，重新划分里面的省份',
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
    name: '圈地名',
    short: '圈地名',
    how: '按住画圈，给圈里起名',
    bar: () => [{ kind: 'custom', render: NamesBar }],
    create: (env) => regionTool(env.hitLabel),
  },
  spot: {
    category: 'names',
    icon: MapPinPlus,
    name: '放地名',
    short: '放地名',
    how: '点击放地名，如城镇、渡口',
    bar: () => [{ kind: 'custom', render: NamesBar }],
    create: (env) => spotTool(env.hitLabel, env.zoom),
  },
  culture: {
    // 第二十二轮：文化笔刷
    category: 'culture',
    icon: Languages,
    name: '文化',
    short: '文化',
    how: '按住涂，这里的人换成这种文化；Alt+点击吸取',
    size: BRUSH,
    amount: { key: 'cultureAmount', label: '力度', range: () => [0.05, 1], scale: 'linear', snap: (v) => Math.round(v * 20) / 20, format: (v) => percent(v, 1) },
    bar: () => [
      { kind: 'custom', render: NoHumanChip },
      { kind: 'custom', render: CulturePick },
      {
        kind: 'choice',
        key: 'cultureMode',
        options: [
          { value: 'keep', label: '只换文化', hint: '宗教等别的维度不变' },
          { value: 'typical', label: '连同倾向', hint: '换成这个文化最常见的一群人' },
        ],
      },
    ],
    pick: pickCulture,
    view: 'culture',
    create: () => cultureTool(),
  },
  pop: {
    // 人口笔刷：改成分、改人数、改一个维度
    category: 'culture',
    icon: Users,
    name: '人口',
    short: '人口',
    how: '按住涂，改这里的人口；Alt+点击吸取',
    size: BRUSH,
    amount: {
      key: 'popAmount',
      label: '力度',
      range: () => [0.05, 1],
      scale: 'linear',
      snap: (v) => Math.round(v * 20) / 20,
      format: (v) => percent(v, 1),
      enabled: () => options.value.popMode !== 'count',
    },
    bar: () => [
      { kind: 'custom', render: NoHumanChip },
      {
        kind: 'choice',
        key: 'popMode',
        options: [
          { value: 'share', label: '改成分', hint: '这群人的占比升高，人数不变' },
          { value: 'count', label: '改人数', hint: '人数乘以倍数；Shift 减少' },
          { value: 'value', label: '改一个维度', hint: '改宗、传教：只改这一维' },
        ],
      },
      { kind: 'custom', render: PopTuplePick },
      { kind: 'custom', render: ValuePick },
      { kind: 'custom', render: FactorSlider },
    ],
    pick: pickPop,
    // 底图跟着模式：改成分看文化，改人数看人口密度，改一个维度看那一维
    view: () => (options.value.popMode === 'share' ? 'culture' : options.value.popMode === 'count' ? 'popDensity' : `dim:${options.value.popDim || (world.value ? (worldDimensions(world.value.small)[0]?.id ?? '') : '')}`),
    create: () => popTool(),
  },
  hearth: {
    // 发源地：拖动，人文重新生成
    category: 'culture',
    icon: Flag,
    name: '发源地',
    short: '发源地',
    how: '拖动发源地，人文重新生成',
    bar: () => [{ kind: 'custom', render: NoHumanChip }, { kind: 'custom', render: HearthBar }],
    view: 'cultureGroup',
    create: (env) => hearthTool(env.zoom),
  },
  // ---------- 第二十三轮：国家 ----------
  cselect: {
    category: 'countries',
    icon: MousePointerClick,
    name: '选国家',
    short: '选择',
    how: '点击国家，打开档案',
    bar: () => [{ kind: 'custom', render: NoCountryChip }, { kind: 'custom', render: SelectedCountryChip }],
    cursor: 'pointer',
    view: 'country',
    create: (env) => countrySelectTool(env.zoom),
  },
  territory: {
    category: 'countries',
    icon: Paintbrush,
    name: '领土',
    short: '领土',
    how: '按住涂，改成这一国的领土；Alt+点击吸取',
    size: BRUSH,
    bar: () => [{ kind: 'custom', render: NoCountryChip }, { kind: 'custom', render: TerritoryPick }],
    pick: pickTerritory,
    view: 'country',
    create: (env) => territoryTool(env.zoom),
  },
  newCountry: {
    category: 'countries',
    icon: SquarePlus,
    name: '新建国家',
    short: '新国家',
    how: '点一个省份或圈一片，成为新国家',
    bar: () => [{ kind: 'custom', render: NoCountryChip }, NEW_COUNTRY_SHAPES],
    view: 'country',
    create: (env) => newCountryTool(env.zoom),
  },
  cmerge: {
    category: 'countries',
    icon: Merge,
    name: '合并国家',
    short: '合并',
    how: '先点一国，再点要并进来的',
    bar: () => [{ kind: 'custom', render: NoCountryChip }, { kind: 'custom', render: SelectedCountryChip }],
    cursor: 'pointer',
    view: 'country',
    create: (env) => countryMergeTool(env.zoom),
  },
  capital: {
    category: 'countries',
    icon: Star,
    name: '首都',
    short: '首都',
    how: '点击选中国家的领土，首都挪到那里；Shift+点击恢复自动',
    bar: () => [{ kind: 'custom', render: NoCountryChip }, { kind: 'custom', render: SelectedCountryChip }],
    cursor: 'pointer',
    view: 'country',
    create: (env) => capitalTool(env.zoom),
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
  // 第二十二轮：文化（文化、人口笔刷，发源地）。没有人文时底部条上是“生成人文…”
  { id: 'culture', icon: UsersRound, label: '文化', tools: toolsIn('culture'), extras: CultureExtras },
  // 第二十三轮：国家（选国家、领土、新建、合并、首都）。没有国家时底部条上是“生成国家…”
  { id: 'countries', icon: Castle, label: '国家', tools: toolsIn('countries'), extras: CountryExtras, watch: () => selectedCountry.value },
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

// 每一类记住上次用的工具：换回来时还是原样。底图只在“图层”里换，换工具、换类别都不动它——
// 只有声明了 view 的工具（地形类别、资源）开着时换成它的那一层，离开时换回去
const lastTool: Partial<Record<Category, ToolId>> = {};
// 换成工具的那一层之前的底图（set：换成了哪一层）。离开时底图还是那一层才换回去（这期间在图层里换过就不动）
let viewBefore: { mode: ViewMode; set: ViewMode } | null = null;
// 工具的那一层（世界里没有这一层时没有：没有人文的世界不换底图）
const viewOf = (id: ToolId): ViewMode | undefined => {
  const raw = TOOL_DEFS[id].view;
  const v = typeof raw === 'function' ? raw() : raw;
  const w = world.value;
  return v && (!w || viewAvailable(w, v)) ? v : undefined;
};
function switchView(to: ToolId) {
  const v = viewOf(to);
  if (v) {
    if (!viewBefore) viewBefore = { mode: mode.value, set: v };
    else if (mode.value === viewBefore.set) viewBefore.set = v;
    else viewBefore = { mode: mode.value, set: v };
    mode.value = v;
  } else if (viewBefore) {
    if (mode.value === viewBefore.set) mode.value = viewBefore.mode;
    viewBefore = null;
  }
}

// 换工具（所有换工具都走这里：面板里、工具里经 state.ts 的 switchTool）：离开的工具、离开的类别声明的东西清掉
export function setTool(id: ToolId) {
  const fromTool = tool.value;
  const from = category.value;
  if (fromTool !== id) TOOL_DEFS[fromTool].onLeave?.();
  if (from !== TOOL_DEFS[id].category) {
    CATEGORY_DEFS[from].onLeave?.();
    lastTool[from] = fromTool;
  }
  if (fromTool !== id) switchView(id);
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
  viewBefore = null;
  for (const k of Object.keys(lastTool)) delete lastTool[k as Category];
  mode.value = 'terrain';
}

// 底图跟着工具的选项变（人口笔刷换了模式）：底图还是工具换上的那一层时跟着换
effect(() => {
  const id = tool.value;
  void options.value;
  if (typeof TOOL_DEFS[id].view !== 'function' || !viewBefore) return;
  const v = viewOf(id);
  if (!v || v === viewBefore.set) return;
  if (mode.peek() === viewBefore.set) mode.value = v;
  viewBefore.set = v;
});

// 世界里没有这一层了（删除了人文、换了时代、打开了别的世界）：底图回到地貌
// 开着人文的工具时生成了人文：换上工具的那一层
effect(() => {
  const w = world.value;
  if (!w) return;
  if (!viewAvailable(w, mode.value)) {
    // 是工具换上的那一层：回到换之前的底图，人文又有了时再换上
    const back = viewBefore && mode.value === viewBefore.set ? viewBefore.mode : 'terrain';
    viewBefore = null;
    mode.value = viewAvailable(w, back) ? back : 'terrain';
  }
  const id = tool.peek();
  if (!viewBefore && TOOL_DEFS[id].view && viewOf(id)) switchView(id);
});

// 涂自定义场：自定义场被删掉了就换一个，都删了就回到冷暖
effect(() => {
  const w = world.value;
  if (!w || tool.value !== 'field') return;
  const names = Object.keys(w.causes.fields);
  if (!names.length) setTool('temp');
  else if (!options.value.field || !w.causes.fields[options.value.field]) setOptions({ field: names[0] });
});
