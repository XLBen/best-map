import { z } from 'zod';
import type { FeatureOverride, GeoFeature, KeptName } from './features';
import type { Worldgen } from './generate';
import type { WordPack } from './names';
import { type Mesh, buildMesh } from './mesh';
import { buildSphereMesh } from './sphere';
import { DEFAULT_PROVINCE_RULES, type ProvinceKind, type ProvinceRules } from './provinces';
import type { LakeType } from './lake-types';
import type { IslandType } from './island-types';
import type { RiverType } from './river-types';
import type { ProvinceSeam } from './seams';
import type { ScriptIssue } from './script';
import { DEFAULT_SPECIES, type Species } from './species';
import { typeIdSchema } from './type-id';

// 世界的三类数据：
//   原因（Causes）—— 用户通过命令编辑：陆海、抬升、岩性、气候微调、自定义场、省份归属，以及约束、河道引导等小对象
//   推导（Derived）—— 由流水线从原因算出：高程、气候、水文、植被、冲突
//   设置（Settings）—— 建世界时确定，决定网格；之后不可改，否则命令里的格编号失效

export const settingsSchema = z.object({
  seed: z.number().int().min(0).max(0xffffffff).default(1),
  cells: z.number().int().min(1000).max(200000).default(40000),
  aspect: z.number().min(0.5).max(4).default(2),
  latNorth: z.number().min(-90).max(90).default(72),
  latSouth: z.number().min(-90).max(90).default(-8),
  // 整个星球（从北极到南极、东西相接）。没有这一项就是一块地区
  globe: z.boolean().optional(),
  // 星球半径（km），只用于整个星球；省略时与地球相同
  radiusKm: z.number().min(1500).max(20000).optional(),
});
export type Settings = z.output<typeof settingsSchema>;

const EARTH_RADIUS_KM = 6371;

export const planetRadiusKm = (s: Settings): number => s.radiusKm ?? EARTH_RADIUS_KM;

// 星球参数的取值范围（不带默认值）
const planetFields = {
  // 轴倾角（度）：决定季节强弱与雨带摆幅
  tilt: z.number().min(0).max(60),
  // 太阳常数相对地球的倍数
  solar: z.number().min(0.6).max(1.4),
  // 1 与地球同向（低纬信风为东风），-1 反向
  rotation: z.union([z.literal(1), z.literal(-1)]),
  // 气温直减率（°C/km）
  lapse: z.number().min(0).max(12),
  // 全局水汽倍数
  humidity: z.number().min(0.1).max(4),
  // 地图外是否视为海洋（决定从图边吹进来的风带不带水汽）
  outsideOcean: z.boolean(),
  // 抬升 1.0 的山带对应的典型峰高（m）
  mountainScale: z.number().min(500).max(15000),
  // 显示为河流的最小流量（m³/s）
  riverThreshold: z.number().min(1).max(100000),
  // 植被竞争的锐度 k：大 → 赢家通吃，小 → 混交过渡
  vegSharpness: z.number().min(0.5).max(20),
  // 建好后把地图在星球上整体南北挪了多少度（正为往北）；纬度跨度不变，所以地图的大小不变
  latShift: z.number().min(-180).max(180),
  // 洋流强弱（只用于整个星球）：0 没有洋流，1 与地球相当，2 更强
  currents: z.number().min(0).max(2),
  // 山挡风：高山让风拐弯的强弱。0 风直接翻过山，1 与地球相当，2 更强
  terrainWind: z.number().min(0).max(2),
};

export const planetSchema = z.object({
  tilt: planetFields.tilt.default(23.4),
  solar: planetFields.solar.default(1),
  rotation: planetFields.rotation.default(1),
  lapse: planetFields.lapse.default(6.5),
  humidity: planetFields.humidity.default(1),
  outsideOcean: planetFields.outsideOcean.default(true),
  mountainScale: planetFields.mountainScale.default(6000),
  riverThreshold: planetFields.riverThreshold.default(150),
  vegSharpness: planetFields.vegSharpness.default(4),
  latShift: planetFields.latShift.default(0),
  currents: planetFields.currents.default(1),
  terrainWind: planetFields.terrainWind.default(1),
});
export type Planet = z.output<typeof planetSchema>;

// set_planet 的补丁：只含真的改了的项。不能用 planetSchema.partial()——
// zod 4 里带默认值的项在 partial 之后照样会补上默认值，改一项就会把其他几项全部重置
export const planetPatchSchema = z.object(planetFields).partial();

// 地块类型约束：mode = constraint 时反推原因（气候修正场），override 时直接改结果（标为例外，水文不认）
export const constraintSchema = z.object({
  id: z.string(),
  cells: z.array(z.number().int().min(0)).min(1),
  species: z.string(),
  mode: z.enum(['constraint', 'override']),
  // 至少多少比例的格必须是该类型（省份级设定用，保留内部自然变化）
  ratio: z.number().min(0.05).max(1).default(1),
  // 修正场向外衰减到 0 的距离（km）。第八轮起最小值随地图（一格半），这里只挡住不合理的值
  radius: z.number().min(1).max(5000).default(600),
  label: z.string().default(''),
  // 没涂成时用户说了“就这样”：不再提醒（收进“!”里），见 constraints.ts 的 activeConflicts
  ignored: z.boolean().optional(),
});
export type Constraint = z.output<typeof constraintSchema>;

// 画的河道折线（自定义走向）：化简后的控制点，x、y 交替存成整数（地图单位 × 1e5，见 rivers.ts 的 encodePath），
// 最多 1500 个点。整个星球上 x 沿河连续展开（起点在 [0, 2) 里，之后可以超出）
export const COURSE_MAX_POINTS = 1500;
const coursePathSchema = z
  .array(z.number().int().min(-1_000_000).max(1_000_000))
  .min(4)
  .max(COURSE_MAX_POINTS * 2)
  .refine((a) => a.length % 2 === 0, '折线的坐标要成对');

// 画的河：沿相邻格组成的路径强制汇流方向，走向固定；只挖河床：地形照自然求解，再把河道格压成从源头往下的
// 累计最小值（见 elevation.ts 的 carveBeds），周围的山不动；
// spring 表示源头有泉水，从源头起水量就够显示成河；
// flow 是河的大小：这一段一路上加进来的水，到末端合计为“河流多少”门槛的几倍（省略为 1.2，刚好看得见）。
// 地名前面灰色的类型字（第十四轮）：自己写的，比如“圣山”；不写就按地物类型
export const featureLabelSchema = z.string().trim().min(1).max(20);

export const guideSchema = z.object({
  id: z.string(),
  cells: z.array(z.number().int().min(0)).min(2),
  locked: z.boolean().default(false),
  spring: z.boolean().default(false),
  flow: z.number().min(1).max(200).optional(),
  // 自定义走向：画出来的折线，屏幕与导出照着它画；cells 是它经过的格（再加上画完之后顺地势流下去的那段）
  path: coursePathSchema.optional(),
  // 有这一项（或 nameKey）的河才是有名字的地物；'' 按文字包自动起名
  name: z.string().max(40).optional(),
  // 固定一条没改过名的自然河：沿用那条河的地名键（“river:河口格”），名字、标注颜色都照旧
  nameKey: z.string().regex(/^\w+:\d+$/).max(40).optional(),
  // 改这条河时记下的名字（第十一轮）：自动起的名字定下来，以后改走向、改大小、类型都还叫它（不算用户起的名字）。
  // 有 name（用户起的）或那条河改过的名字时那个说了算；“换一个”“恢复自动”去掉它
  autoName: z.string().max(40).optional(),
  // 自动起名的盐（“换一个”）
  salt: z.number().int().min(0).optional(),
  // 粗细倍数：只影响画法与导出
  width: z.number().min(0.3).max(4).optional(),
  // 在终点那格消失（渗进地下）：路由里那一格是出口
  end: z.literal('sink').optional(),
  // 河流类型（第三批）：id 的规则与生态相同
  type: typeIdSchema.optional(),
  // 分出去的一股（第十三轮，分流、三角洲）：cells[0] 在干流上（不是这条河的格，不改它的流向），水在那里按 share 分出去，
  // 沿这条河道流走，干流往下少这么多（流向仍是一格一个下游，只是流量按比例沿两条链加减，见 hydrology.ts）
  branch: z.object({ share: z.number().min(0.05).max(0.5) }).optional(),
  // 一条河的另一个源头（第十三轮）：这条河道汇入那条画的河（河道 id），算作它的一部分：同一个名字（地名里是同一条河）
  sourceOf: z.string().max(40).optional(),
  // 名字前面的类型字（第十四轮）：自己写的（比如“圣河”）；没有时按地物类型（“河”）
  label: featureLabelSchema.optional(),
});
export type Guide = z.output<typeof guideSchema>;

export const lakeSchema = z.object({
  id: z.string(),
  cell: z.number().int().min(0),
  // 半径（km）就按给的算，最小半格（只淹放湖的那一格，见 elevation.ts 的 lakeRadiusUnits）
  radius: z.number().min(0.1).max(2000).default(150),
  depth: z.number().min(5).max(2000).default(120),
  // 不受蒸发影响，始终蓄满（泉水、魔法湖）
  perennial: z.boolean().default(true),
  // 第九轮：湖泊类型（'plain' 是“普通的湖”，见 lake-types.ts）。这个湖所在的那一片湖面都按它。
  // 名字不在这里：与自然的湖一样是地名（rename_feature、reroll_feature，键是“lake:锚点格”），只有一处说了算
  type: typeIdSchema.optional(),
});
export type LakeSpec = z.output<typeof lakeSchema>;

// 用户自己圈的地名区块（地区、平原、山地……）与点状地名（spot）。区块之间、和自动识别的地物可以重叠
export const REGION_KINDS = ['region', 'plain', 'highland', 'forest', 'desert', 'sea', 'spot'] as const;
export type RegionKind = (typeof REGION_KINDS)[number];
export const regionSchema = z.object({
  id: z.string(),
  // 空字符串：按文字包自动起名
  name: z.string().max(40).default(''),
  kind: z.enum(REGION_KINDS),
  cells: z.array(z.number().int().min(0)).min(1),
  // 点状地名的位置（地图单位）
  at: z.tuple([z.number(), z.number()]).optional(),
  // 自动起名的盐（“换一个”）
  salt: z.number().int().min(0).default(0),
  // 类型按圈里现在的地形自动判断（kind 只是圈的时候判断的结果）；没有这一项为固定的类型
  auto: z.literal(true).optional(),
  // 名字前面的类型字（第十四轮，点状地名的“地点”）：自己写的；没有时按类型
  label: featureLabelSchema.optional(),
});
export type RegionSpec = z.output<typeof regionSchema>;

export interface ProvinceMeta {
  name: string;
  locked: boolean;
  // 陆地省份还是海域省份；格的陆海变了就要从省份里移出
  land: boolean;
  // 陆地 / 无人区 / 湖 / 海域
  kind: ProvinceKind;
  // 用户自己选的颜色（#rrggbb，第十二轮）：地图上的省份着色用它；没有时陆地省按编号配色，海省不着色。
  // 导出的 provinces.bmp 照旧按编号（provinceColor），颜色一一对应
  color?: string;
}

export interface Causes {
  // 用户对地形的编辑（增量），叠加在生成器结果上；撤销与重放都只记这些
  landDelta: Float32Array;
  upliftDelta: Float32Array;
  erodDelta: Float32Array;
  // 由生成器结果 + 增量组合出的最终值（resolveTerrain 计算，见 terrain.ts）
  landness: Float32Array;
  land: Uint8Array;
  uplift: Float32Array;
  erod: Float32Array;
  tempOffset: Float32Array;
  // 降水的对数修正：0 不变，ln 2 为加倍
  moistOffset: Float32Array;
  fields: Record<string, Float32Array>;
  province: Int32Array;
  // 放的岛是哪一种（第十四轮，见 island-types.ts）：0 不是放的岛，否则是种类的编号。放岛、画岛链时写在新长出的陆地
  // （环礁还有潟湖的海格）上；画陆地 / 海、恢复原样画到的地方清掉。颜色、潟湖、小礁归海省都按它
  islandType: Uint8Array;
  // 岛的脚本定下的高度（第十五轮，见 island-scripts.ts）：米，FREE_HEIGHT 是没定（照常按地形算）。
  // 陆地格上定了的，高程算完（挖完放的湖）之后直接换成它（见 elevation.ts 的 finishElevation）。
  // 只在第一次放带“岛的样子”脚本的岛时才有（撤销到那之前时去掉）；画陆地 / 海、恢复原样画到的地方清掉。堆山、压低不改它
  islandHeight?: Float32Array;
}

// causes.islandHeight 里“没定高度”的值（不用 NaN：撤销记录按 !== 比较数组，NaN 每次都算改了）
export const FREE_HEIGHT = -Infinity;

export interface TerrainState {
  // 生成参数；null 为空白海洋
  gen: Worldgen | null;
  // 海岸破碎度：平滑 0.35，自然 1，破碎 1.8
  coastRoughness: number;
}

export interface SmallState {
  terrain: TerrainState;
  // 自定义文字包；null 用内置的中文包
  wordPack: WordPack | null;
  // 地理要素的手工命名与重抽：键为“类型:锚点格”
  featureNames: Record<string, FeatureOverride>;
  // 留着的名字（第九轮）：键为“类型:锚点格”。编辑之后锚点挪了、名字被新地物抢了的地物照旧叫原来的名字，
  // 由引擎在那一步记进命令（见 features.ts 的 carryNames）。第一次留名字之前没有这一项
  keptNames?: Record<string, KeptName>;
  planet: Planet;
  species: Species[];
  constraints: Constraint[];
  guides: Guide[];
  lakes: LakeSpec[];
  regions: RegionSpec[];
  provinces: Record<number, ProvinceMeta>;
  nextProvince: number;
  nextId: number;
  // 省份自动划分的规则；陆海变化后的修补也按它的目标大小
  provinceRules: ProvinceRules;
  // 剪刀切省时画的线（见 seams.ts）：第一次切之前没有这一项
  provinceSeams?: ProvinceSeam[];
  // 河流类型（第三批，见 river-types.ts）：第一次新建之前没有这一项（不在 defaultSmall 里）
  riverTypes?: RiverType[];
  // 湖泊类型（第九轮，见 lake-types.ts）：第一次新建之前没有这一项
  lakeTypes?: LakeType[];
  // 自然的湖选的类型：这一格所在的那片湖就是这一种（这一格不再是湖时不起作用）。后面的说了算
  lakeTyping?: { cell: number; type: string }[];
  // 自己的岛的种类（第十四轮，见 island-types.ts）：第一次新建之前没有这一项
  islandTypes?: IslandType[];
}

export interface Conflict {
  constraintId: string;
  species: string;
  // 实际满足的比例与要求的比例
  satisfied: number;
  required: number;
  failing: number[];
  // 限制因素：字段、当前典型值、需要的区间
  reasons: { field: string; value: number; need: [number, number] }[];
  // 在修正上限内能做到的最接近类型
  nearest: string | null;
  suggestions: string[];
}

export interface Derived {
  elevation: Float32Array;
  slope: Float32Array;
  // 气候：北半球夏季（s）与冬季（w）
  tS: Float32Array;
  tW: Float32Array;
  pS: Float32Array;
  pW: Float32Array;
  windSX: Float32Array;
  windSY: Float32Array;
  windWX: Float32Array;
  windWY: Float32Array;
  tMean: Float32Array;
  tWarm: Float32Array;
  tCold: Float32Array;
  precip: Float32Array;
  pet: Float32Array;
  moisture: Float32Array;
  seasonality: Float32Array;
  continentality: Float32Array;
  // 约束求解得到的修正场
  corrT: Float32Array;
  corrP: Float32Array;
  // 自定义场的修正
  corrF: Record<string, Float32Array>;
  // 水文
  water: Float32Array;
  // 1 = 湖面，2 = 内流盆地中干涸的部分（干盐湖）
  lake: Uint8Array;
  receiver: Int32Array;
  discharge: Float32Array;
  drainArea: Float32Array;
  wetness: Float32Array;
  basin: Int32Array;
  // 植被：n × S 的份额与适宜度
  share: Float32Array;
  suit: Float32Array;
  reach: Uint8Array;
  // 主导类型下标；-1 为水体，-2 为什么都长不了
  dominant: Int16Array;
  // 被硬覆盖的格
  overridden: Uint8Array;
  conflicts: Conflict[];
  // 地理要素（大陆、岛、海、河、山脉……）与名字
  features: GeoFeature[];
  // 洋流（整个星球）：全年平均的表层海流（东、南分量，约 0–4），海面温度的偏离（°C；陆地上是海洋带来的增温）。
  // 一块地区的世界里全为 0
  currentX: Float32Array;
  currentY: Float32Array;
  sstAnom: Float32Array;
  // ---------- 第三批：只在用到时才有（从来没用过脚本的世界里没有这些键；用过又去掉了的为 undefined） ----------
  // 长在哪里的脚本的系数：n × P，P 是带这种脚本的生态个数（按生态的顺序，见 biome-scripts.ts 的 placementSlots）
  placeF?: Float32Array;
  // 颜色脚本算出的每格植被颜色（n × 4：r、g、b，a 为 255；水上为 0），见 biome-look.ts 的 computeLook
  look?: Uint8Array;
  // 这一次推导里出错的脚本（按没有脚本处理了；星球形态的布局、地形脚本排在最前）；普通的 JSON，不是类型数组
  scriptIssues?: ScriptIssue[];
  // 每格是哪一种河（0 普通的河或不是河，k + 1 是 small.riverTypes 的第 k 种），见 river-types.ts 的 typeRivers。
  // 只在世界里有河流类型时才有
  riverType?: Uint8Array;
  // 每格是哪一种湖（0 普通的湖或不是湖，k + 1 是 small.lakeTypes 的第 k 种；湖面与干涸的湖底都算），见 lake-types.ts 的 typeLakes。
  // 只在世界里有湖泊类型时才有
  lakeType?: Uint8Array;
  // 生态、河对周围的影响（第一遍植被之后按它算，见 effects.ts）：每格变暖变冷多少（°C）、降水的对数修正。
  // 只在有生态带“对周围的影响”、或有河流类型带“两岸的影响”时才有
  effT?: Float32Array;
  effP?: Float32Array;
}

export interface World {
  settings: Settings;
  mesh: Mesh;
  kmPerUnit: number;
  causes: Causes;
  small: SmallState;
  derived: Derived;
}

// 一个地图单位合多少 km：一块地区按纬度跨度（地图高 1）；整个星球的地图高 1 是半圈经线（π·R）
export function kmPerUnit(s: Settings): number {
  if (s.globe) return Math.PI * planetRadiusKm(s);
  return Math.abs(s.latNorth - s.latSouth) * 111.2;
}

export function latitudeOf(s: Settings, y: number): number {
  return s.latNorth + (s.latSouth - s.latNorth) * y;
}

// 世界里一点的实际纬度：建世界时的纬度加上之后挪动的度数（整个星球不能挪）
export function worldLatitude(world: World, y: number): number {
  if (world.settings.globe) return Math.max(-90, Math.min(90, 90 - 180 * y));
  return Math.max(-90, Math.min(90, latitudeOf(world.settings, y) + world.small.planet.latShift));
}

// 整个星球上一点的经度（−180 到 180，东经为正）；x 可以超出 [0, 2)
export function longitudeOf(x: number): number {
  const w = x - 2 * Math.floor(x / 2);
  return 180 * (w - 1);
}

// 按设置建网格：整个星球是球面网格（与半径无关，三种大小共用），一块地区是平面网格
export function buildMeshFor(s: Settings): Mesh {
  return s.globe ? buildSphereMesh(s.cells, s.seed) : buildMesh(s.cells, s.aspect, s.seed);
}

// 网格缓存的键：同一个键的设置建出同一个网格
export function meshKey(s: Settings): string {
  return s.globe ? `globe:${s.cells}:${s.seed}` : `${s.cells}:${s.aspect}:${s.seed}`;
}

function emptyCauses(n: number): Causes {
  return {
    landDelta: new Float32Array(n),
    upliftDelta: new Float32Array(n),
    erodDelta: new Float32Array(n),
    landness: new Float32Array(n).fill(-3000),
    land: new Uint8Array(n),
    uplift: new Float32Array(n),
    erod: new Float32Array(n).fill(1),
    tempOffset: new Float32Array(n),
    moistOffset: new Float32Array(n),
    fields: {},
    province: new Int32Array(n).fill(-1),
    islandType: new Uint8Array(n),
  };
}

export function emptyDerived(n: number, speciesCount: number): Derived {
  const f = () => new Float32Array(n);
  return {
    elevation: f(),
    slope: f(),
    tS: f(),
    tW: f(),
    pS: f(),
    pW: f(),
    windSX: f(),
    windSY: f(),
    windWX: f(),
    windWY: f(),
    tMean: f(),
    tWarm: f(),
    tCold: f(),
    precip: f(),
    pet: f(),
    moisture: f(),
    seasonality: f(),
    continentality: f(),
    corrT: f(),
    corrP: f(),
    corrF: {},
    water: f(),
    lake: new Uint8Array(n),
    receiver: new Int32Array(n).fill(-1),
    discharge: f(),
    drainArea: f(),
    wetness: f(),
    basin: new Int32Array(n),
    share: new Float32Array(n * speciesCount),
    suit: new Float32Array(n * speciesCount),
    reach: new Uint8Array(n * speciesCount),
    dominant: new Int16Array(n).fill(-1),
    overridden: new Uint8Array(n),
    conflicts: [],
    features: [],
    currentX: f(),
    currentY: f(),
    sstAnom: f(),
  };
}

function defaultSmall(): SmallState {
  return {
    terrain: { gen: null, coastRoughness: 1 },
    wordPack: null,
    featureNames: {},
    planet: planetSchema.parse({}),
    species: structuredClone(DEFAULT_SPECIES),
    constraints: [],
    guides: [],
    lakes: [],
    regions: [],
    provinces: {},
    nextProvince: 0,
    nextId: 1,
    provinceRules: { ...DEFAULT_PROVINCE_RULES },
  };
}

export function createWorld(input: Partial<Settings> = {}, mesh?: Mesh): World {
  const settings = settingsSchema.parse(input);
  // 整个星球的地图固定是 2:1、从北纬 90° 到南纬 90°
  if (settings.globe && (settings.aspect !== 2 || settings.latNorth !== 90 || settings.latSouth !== -90)) {
    throw new Error('整个星球的设置必须是宽高 2:1、纬度从 90 到 −90');
  }
  const m = mesh ?? buildMeshFor(settings);
  const small = defaultSmall();
  return {
    settings,
    mesh: m,
    kmPerUnit: kmPerUnit(settings),
    causes: emptyCauses(m.n),
    small,
    derived: emptyDerived(m.n, small.species.length),
  };
}

// 地图上显示的省份颜色：自己选的颜色，否则按编号（provinceColor）
export function provinceDisplayColor(world: World, id: number): [number, number, number] {
  const c = world.small.provinces[id]?.color;
  if (c) {
    const v = parseInt(c.slice(1), 16);
    return [v >> 16, (v >> 8) & 255, v & 255];
  }
  return provinceColor(id);
}

// 海上的省份改成“自己选颜色”时先给的颜色（"#rrggbb"）：按编号取色相，但跳过海的蓝绿到蓝紫（150°–270°），
// 饱和度、明度取中间一段，在写实与地图册的海上都一眼看得出来。同一个编号总是同一个颜色
export const SEA_HUES: readonly [number, number] = [150, 270];
export function seaProvinceDefaultColor(id: number): string {
  const c = Math.imul(id + 1, 0x9e3779b1) >>> 0;
  const span = 360 - (SEA_HUES[1] - SEA_HUES[0]);
  const h = (SEA_HUES[1] + 5 + (c % (span - 10))) % 360;
  const s = 0.6 + ((c >>> 12) % 16) / 100;
  const l = 0.45 + ((c >>> 20) % 11) / 100;
  // HSL → RGB
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// 每个省份一个互不相同的 RGB：乘以奇数在 2^24 上是双射
export function provinceColor(id: number): [number, number, number] {
  const c = Math.imul(id + 1, 0x9e3779b1) & 0xffffff;
  return [c >> 16, (c >> 8) & 255, c & 255];
}
