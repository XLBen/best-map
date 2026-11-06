import { computed, effect } from '@preact/signals';
import { Building2, Castle, Droplets, Leaf, Map as MapIcon, Mountain, MousePointer, ThermometerSun, Type, UsersRound } from 'lucide-preact';
import { viewAvailable } from '../layers';
import type { World } from '../../../../core/world';
import {
  type Category,
  type ViewMode,
  selectedCountry,
  selectedSettle,
  cursorHint,
  erasing,
  picking,
  measure,
  mode,
  options,
  registerToolSwitch,
  selectedFeature,
  selectedProvince,
  provinceSet,
  setOptions,
  tool,
  world,
} from '../../../state';
import { clearBarPreview } from '../../barPreview';
import { failingHighlights, featureHighlights, provinceHighlights } from '../../map/highlights';
import type { CategoryDef, ToolBehavior, ToolDef, ToolSpec } from '../types';
import type { ToolEnv, ToolHandler } from '../../tools';
import { TERRAIN_TOOLS } from './terrain';
import { CLIMATE_TOOLS } from './climate';
import { NATURE_TOOLS } from './nature';
import { WATER_TOOLS } from './water';
import { PROVINCE_TOOLS } from './provinces';
import { NAME_TOOLS } from './names';
import { CULTURE_TOOLS } from './culture';
import { COUNTRY_TOOLS } from './countries';
import { SETTLEMENT_TOOLS } from './settlements';
import { INSPECT_TOOLS } from './inspect';

// ---------- 工具 ----------
// 这里只写工具是什么（图标、名字、滑块、底部条、底图……）；做什么（create、吸管、橡皮擦、Delete）在 tools/bind.ts 接上。
// 第七十轮：每一类的工具分到同一目录下的一个文件（terrain.ts……），这里按类合起来；每一类里的先后与以前相同
const SPECS = {
  ...TERRAIN_TOOLS,
  ...CLIMATE_TOOLS,
  ...NATURE_TOOLS,
  ...WATER_TOOLS,
  ...PROVINCE_TOOLS,
  ...NAME_TOOLS,
  ...CULTURE_TOOLS,
  ...COUNTRY_TOOLS,
  ...SETTLEMENT_TOOLS,
  ...INSPECT_TOOLS,
} satisfies Record<string, ToolSpec>;

// 工具的 id：工具表里的键
export type ToolId = keyof typeof SPECS;

// 工具做什么还没接上时 create 等是空的：tools/bind.ts 登记进来（register-all.ts 引用它）
export const TOOL_DEFS = Object.fromEntries(Object.entries(SPECS).map(([id, d]) => [id, { ...d, id }])) as Record<ToolId, ToolDef>;

// 接上每个工具做什么（tools/bind.ts 调用一次；表里每个工具都要有）
export function bindTools(impl: Record<ToolId, ToolBehavior>) {
  for (const id of Object.keys(impl) as ToolId[]) Object.assign(TOOL_DEFS[id], impl[id]);
}

// ---------- 类别 ----------

// 每一类的工具按工具表里的先后
const toolsIn = (c: Category) => (Object.keys(TOOL_DEFS) as ToolId[]).filter((id) => TOOL_DEFS[id].category === c);

export const CATEGORIES: CategoryDef[] = [
  // 第二十五轮：指针（只看不改）。顶栏最左边单独一个按钮（V），没有底部条、没有“⋯”
  { id: 'inspect', icon: MousePointer, label: '指针', tools: toolsIn('inspect') },
  { id: 'terrain', icon: Mountain, label: '地形', tools: toolsIn('terrain'), extras: 'TerrainExtras' },
  { id: 'climate', icon: ThermometerSun, label: '气候', tools: toolsIn('climate') },
  { id: 'nature', icon: Leaf, label: '自然', tools: toolsIn('nature'), extras: 'NatureExtras', map: { highlights: failingHighlights } },
  { id: 'water', icon: Droplets, label: '水系', tools: toolsIn('water'), extras: 'RiverExtras', map: { markers: true } },
  {
    id: 'provinces',
    icon: MapIcon,
    label: '省份',
    tools: toolsIn('provinces'),
    extras: 'ProvinceExtras',
    // 离开省份：选中的省、多选的不要了
    onLeave: () => {
      selectedProvince.value = null;
      provinceSet.value = [];
    },
    watch: () => [selectedProvince.value, provinceSet.value],
    map: { highlights: provinceHighlights, provinces: true },
  },
  {
    id: 'names',
    icon: Type,
    label: '地名',
    tools: toolsIn('names'),
    extras: 'NamesExtras',
    // 离开地名：选中的地名不要了
    onLeave: () => (selectedFeature.value = null),
    watch: () => selectedFeature.value,
    map: { highlights: featureHighlights, labels: () => selectedFeature.value },
  },
  // 第二十二轮：文化（文化、人口笔刷，发源地）。没有人文时底部条上是“生成人文…”
  { id: 'culture', icon: UsersRound, label: '文化', tools: toolsIn('culture'), extras: 'CultureExtras' },
  // 第二十三轮：国家（选国家、领土、新建、合并、首都）。没有国家时底部条上是“生成国家…”
  { id: 'countries', icon: Castle, label: '国家', tools: toolsIn('countries'), extras: 'CountryExtras', watch: () => selectedCountry.value },
  // 第二十四轮：城市（城市、道路、地标、自定义点）。开着时任何模式里都画全部城市、地标
  { id: 'settlements', icon: Building2, label: '城市', tools: toolsIn('settlements'), extras: 'SettlementExtras', watch: () => selectedSettle.value },
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
  // 第二十七轮：换工具时吸管、橡皮擦都关上
  picking.value = false;
  erasing.value = null;
  // 底部条按钮悬停时的预览（省份的对半分开、重新划分，河的截短、延长）：按钮随着换工具消失，收不到“移开”，
  // 以前会一直画在新工具上（第十三轮修）。点下去了、等结果的那一份留着
  clearBarPreview();
  // 换工具就不再量距离
  measure.value = null;
}
registerToolSwitch(setTool);

// 地图上用的工具对象：橡皮擦开着、这个工具有这一种橡皮擦时换成它（MapView 换工具、开关橡皮擦时重建）
export function createTool(id: ToolId, env: ToolEnv): ToolHandler {
  const d = TOOL_DEFS[id];
  const e = erasing.value;
  const make = e ? d.eraser?.[e] : undefined;
  return make ? make(env) : d.create(env);
}
// 这个工具的橡皮擦有哪几种（没有时为空）
export const eraserModes = (id: ToolId): ('auto' | 'clear')[] => (['auto', 'clear'] as const).filter((k) => !!TOOL_DEFS[id].eraser?.[k]);

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

// 跟着状态变的三件事（第六十九轮：以前是模块里的 effect，现在由 main.tsx 在第一次画界面之前调用一次，先后与以前一样，
// 在 map/modes.ts 等模块里的 effect 之后）。测试里要它们时自己调用
let effectsOn = false;
export function startToolEffects() {
  if (effectsOn) return;
  effectsOn = true;
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
      // 同盟模式里删掉了最后一个集团：回到国家
      const back = viewBefore && mode.value === viewBefore.set ? viewBefore.mode : mode.value === 'bloc' ? 'country' : 'terrain';
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
}
