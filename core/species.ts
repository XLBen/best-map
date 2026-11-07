import { z } from 'zod';
// 只在 z.lazy 里读 scriptsSchema：script.ts 经 world.ts 又引用本文件，顶层直接读会碰上“初始化之前不能访问”
import { scriptsSchema } from './script';
import { typeIdSchema } from './type-id';

{ typeIdSchema };

// 植被 / 地块类型完全由数据定义：每种类型对任意字段给出梯形耐受曲线。
// min = optLow 且 optHigh = max 时退化为硬区间，“A 能在 a、b 气候生存”这类离散规则就是这个特例。

export interface FieldInfo {
  id: string;
  label: string;
  unit: string;
  // 界面滑块的范围
  lo: number;
  hi: number;
  // 约束求解器能改变它的哪个“原因”：温度修正、降水修正、自定义场；null 表示不可修正（需要改地形或水文）
  correctable: 'temp' | 'precip' | 'custom' | null;
}

export const BUILTIN_FIELDS: FieldInfo[] = [
  { id: 'tMean', label: '年均温', unit: '°C', lo: -40, hi: 35, correctable: 'temp' },
  { id: 'tWarm', label: '暖季均温', unit: '°C', lo: -30, hi: 45, correctable: 'temp' },
  { id: 'tCold', label: '冷季均温', unit: '°C', lo: -50, hi: 30, correctable: 'temp' },
  { id: 'precip', label: '年降水', unit: 'mm', lo: 0, hi: 4000, correctable: 'precip' },
  { id: 'moisture', label: '湿润程度', unit: '', lo: 0, hi: 4, correctable: 'precip' },
  { id: 'seasonality', label: '降水季节性（正=夏雨）', unit: '', lo: -1, hi: 1, correctable: null },
  { id: 'elevation', label: '海拔', unit: 'm', lo: 0, hi: 8000, correctable: null },
  { id: 'slope', label: '坡度', unit: 'm/km', lo: 0, hi: 100, correctable: null },
  { id: 'discharge', label: '河流流量', unit: 'm³/s', lo: 0, hi: 20000, correctable: null },
  { id: 'wetness', label: '地形湿度', unit: '', lo: 0, hi: 30, correctable: null },
  { id: 'continentality', label: '离海远近', unit: '', lo: 0, hi: 1, correctable: null },
  { id: 'lat', label: '纬度（绝对值）', unit: '°', lo: 0, hi: 90, correctable: null },
];

export const toleranceSchema = z.object({
  field: z.string().min(1),
  min: z.number(),
  optLow: z.number(),
  optHigh: z.number(),
  max: z.number(),
});
export type Tolerance = z.infer<typeof toleranceSchema>;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, '颜色需为 #rrggbb');

// 花纹（第三批）：在 GPU 上按格画，平面、星球都有；拉远时淡成平均色
export const PATTERNS = ['none', 'sparkle', 'cracks', 'mottle', 'veins', 'spots', 'stripes'] as const;
export type Pattern = (typeof PATTERNS)[number];
export const PATTERN_LABEL: Record<Pattern, string> = {
  none: '无',
  sparkle: '闪光',
  cracks: '裂纹',
  mottle: '斑驳',
  veins: '脉络',
  spots: '斑点',
  stripes: '条纹',
};

// 外观：只影响画法，不影响哪里长什么（只改它不重算）
export const visualSchema = z.object({
  pattern: z.enum(PATTERNS),
  // 花纹的第二种颜色；省略时用基础色调暗
  color2: hexColor.optional(),
  // 花纹有多明显（0–1）
  amount: z.number().min(0).max(1).optional(),
  // 花纹大小（以格为单位）
  size: z.number().min(0.1).max(4).optional(),
  glow: z.number().min(0).max(1).optional(),
  glowColor: hexColor.optional(),
});
export type Visual = z.output<typeof visualSchema>;

// 对周围的影响
export const effectsSchema = z.object({
  // 让周围变暖变冷（°C）、变湿变干（降水乘以 e^dP），随离它的距离平滑减弱到 radiusKm 为 0
  climate: z
    .object({
      dT: z.number().min(-10).max(10).optional(),
      dP: z.number().min(-1.5).max(1.5).optional(),
      radiusKm: z.number().min(20).max(3000),
    })
    .optional(),
  // 侵占：在目标生态适宜的地方竞争力更强，得分 ×(1 + strength × 目标里最高的适宜度)
  invade: z
    .object({
      targets: z.array(z.string().min(1)).min(1).max(48),
      strength: z.number().min(0).max(10),
    })
    .optional(),
});
export type Effects = z.output<typeof effectsSchema>;

// 地名：类型名（“晶林”）与起名模板（模板里的 {词表} 用文字包的词表，{__species} 是类型名）
export const featureSchema = z.object({
  label: z.string().min(1).max(8),
  names: z
    .array(z.object({ p: z.string().min(1).max(40), w: z.number().positive().optional() }))
    .min(1)
    .max(20)
    .optional(),
});
export type SpeciesFeature = z.output<typeof featureSchema>;

// 长在哪里：只在一个岛上（cell 所在的那块陆地）/ 只在圈的这些格里
export const rangeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('island'), cell: z.number().int().min(0) }),
  z.object({ kind: z.literal('cells'), cells: z.array(z.number().int().min(0)).min(1) }),
]);
export type SpeciesRange = z.output<typeof rangeSchema>;

// 生态的大类（第三十轮，speciesSchema 的 group）：涂出来的一片按这一类的地物识别、起名
export const BIOME_GROUPS = ['desert', 'forest', 'tundra', 'icecap', 'wetland'] as const;
export type BiomeGroup = (typeof BIOME_GROUPS)[number];

// 一种生态算进哪一大类（大片的森林、荒漠……地物，地标的“荒漠里”“森林里”，圈地名猜的类型都按它；第七十一轮起只有这一处）：
// 写了 group 就是它；没写的按导出用的地形（terrain）——自带地名设定的奇幻生态（水晶丛林、死亡森林、虫群占领区）不写 group
// （写了大类的生态自己长成的一片不另起名，见 features.ts 的 namesNaturally），靠这一条算进森林。草原、稀树草原、灌丛等都不是（''）
export function biomeGroupOf(sp: Pick<Species, 'group' | 'terrain'>): BiomeGroup | '' {
  if (sp.group) return sp.group;
  if (sp.terrain === 'desert') return 'desert';
  if (sp.terrain === 'forest' || sp.terrain === 'jungle') return 'forest';
  if (sp.terrain === 'arctic') return 'tundra';
  if (sp.terrain === 'marsh') return 'wetland';
  return '';
}

// 高度范围（第五十五轮，speciesSchema 的 height）：海拔，米，和检查器、山峰标注里写的是同一个数。
// low、high 是最适合的范围，外面各留 HEIGHT_MARGIN 的过渡；low 为 0 不限下限，high 到 HEIGHT_MAX 不限上限。
// 和气温、湿度一样是耐受曲线，乘进适宜度（见 heightTolerance），所以高度的边界和气候的边界一样是渐变的
export const HEIGHT_MAX = 9000;
export const HEIGHT_MARGIN = 300;
export const heightSchema = z
  .object({ low: z.number().min(0).max(HEIGHT_MAX), high: z.number().min(0).max(HEIGHT_MAX) })
  .refine((h) => h.low <= h.high, { message: '高度范围的下限不能高于上限' });
export type HeightRange = z.output<typeof heightSchema>;

// 生态能有的两种脚本
export const SPECIES_SCRIPT_KINDS = ['placement', 'color'] as const;

export const speciesSchema = z.object({
  id: typeIdSchema,
  name: z.string().default(''),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, '颜色需为 #rrggbb').default('#88aa66'),
  // 导出 Paradox terrain 时的类别
  terrain: z.string().default('plains'),
  competition: z.number().min(0).max(100).default(1),
  tolerances: z.array(toleranceSchema).default([]),
  // 可选扩散：只在从起源格可达的地方出现
  dispersal: z
    .object({
      origins: z.array(z.number().int().min(0)).min(1),
      // 最大扩散距离（km）
      range: z.number().min(0).default(3000),
      // 穿过不适宜格（适宜度 < 0.2）时距离代价的倍数
      gapCost: z.number().min(1).default(4),
      // 跨海时的倍数；很大时等于不能跨海
      seaCost: z.number().min(1).default(30),
    })
    .optional(),
  // ---------- 第三批：都可选、没有默认值（不写的旧数据解析结果逐字节不变） ----------
  visual: visualSchema.optional(),
  effects: effectsSchema.optional(),
  feature: featureSchema.optional(),
  // 脚本：placement 长在哪里（0–1 的系数，乘进适宜度）、color 颜色（每格的颜色，写进 derived.look）
  scripts: z.lazy(() => scriptsSchema).optional(),
  // 脚本里噪声、rand 的种子用它（省略时用 id）：资源包里的生态改了 id，花纹也不变
  seedKey: z.string().min(1).max(64).optional(),
  // ---------- 第十二轮 ----------
  // 自然生成：false 时不在地图上按条件自己出现，只长在涂了它的格里（涂的格里照样按“自然融入”算）。
  // 省略为 true（内置生态照旧）；界面里新建、复制的生态和从资源包加进来的生态（包里没写时）是 false
  natural: z.boolean().optional(),
  // 长在哪里：只在一个岛上（这一格所在的那块陆地，每次重算时重新认，岛变了跟着变）或圈的范围里。省略为到处
  range: rangeSchema.optional(),
  // ---------- 第二十二轮 ----------
  // 宜居度（0–1）：这种生态里住人有多合适。省略时按生态的地形与气候估一个（见 human/habitability.ts 的 biomeHabitability）
  habitability: z.number().min(0).max(1).optional(),
  // ---------- 第二十七轮 ----------
  // 通行难度的倍数（乘在地形类别的起伏上；平地的草原为 1）。省略时按生态估（见 human/terrain-class.ts 的 biomeMovement）
  movement: z.number().min(0.1).max(20).optional(),
  // ---------- 第三十轮 ----------
  // 大类（地物“荒漠、森林、苔原、冰盖、沼泽湿地”）：涂出来的一片按这一类的地物识别、起名。省略时按导出用的地形归大片的地区
  // （biomeGroupOf），自己的一片按“生态区”起名（见 features.ts 的 speciesFeature）
  group: z.enum(BIOME_GROUPS).optional(),
  // ---------- 第五十五轮 ----------
  // 高度范围（见 HEIGHT_MAX）。省略时不看高度（用户自己做的、旧式的生态，结果和以前逐值相同）
  height: heightSchema.optional(),
  // ---------- 第五十六轮：水系（允许表，见 water-types.ts） ----------
  // false：不允许普通河、普通湖。省略为允许（别的河湖种类在它们自己的 biomes 里）
  plainRiver: z.boolean().optional(),
  plainLake: z.boolean().optional(),
  // 河走到不允许的地方时：换类型（省略，河道和水量不变，这一段换成允许的类型）；断流（stop，河在这里消失，下游不再算这部分水）。湖没有断流，都按换类型
  waterBlock: z.enum(['swap', 'stop']).optional(),
});
export type Species = z.output<typeof speciesSchema>;
export type SpeciesInput = z.input<typeof speciesSchema>;

// 梯形：在 [optLow, optHigh] 为 1，向 min / max 线性降到 0
export function trapezoid(t: Tolerance, v: number): number {
  if (v < t.min || v > t.max) return 0;
  if (v < t.optLow) return t.optLow === t.min ? 1 : (v - t.min) / (t.optLow - t.min);
  if (v > t.optHigh) return t.optHigh === t.max ? 1 : (t.max - v) / (t.max - t.optHigh);
  return 1;
}

// 高度范围换成耐受曲线（场是 elevation，海面以下按 0）。不限的那一边放到碰不到的地方
export function heightTolerance(h: HeightRange): Tolerance {
  const noLow = h.low <= 0;
  const noHigh = h.high >= HEIGHT_MAX;
  return { field: 'elevation', min: noLow ? -1 : h.low - HEIGHT_MARGIN, optLow: noLow ? -1 : h.low, optHigh: noHigh ? 1e5 : h.high, max: noHigh ? 1e5 : h.high + HEIGHT_MARGIN };
}

// “只长在高山上”（第七十二轮起是高度范围旁边的一个按钮）：把高度范围的下限设到这里，和以前的命名条件 mountain 的最适下限一样
export const ALPINE_LOW = 1500;

// 读进来的生态带着海拔的耐受条件（第七十二轮：界面上海拔只在高度范围里设）。换成高度范围后算出来逐值相同时换掉，
// 否则原样留着（core/species-height.test.ts 查着）。逐值相同要三条都成立：
//   - 没写高度范围（写了时高度范围是另一条曲线，换掉就少了一条）；
//   - 海拔的这一条是最后一条，也是唯一的一条（speciesTolerances 把高度范围排在最后：乘的先后不变）；
//   - 这一条和高度范围换成的曲线（heightTolerance）四个数一样。
// 命名条件 mountain（1000 / 1500 / 9000 / 9000）不满足最后一条：高度范围的过渡只有 HEIGHT_MARGIN，下限是 1200，不是 1000
export function elevationAsHeight<T>(sp: T): T {
  if (!sp || typeof sp !== 'object') return sp;
  const o = sp as { tolerances?: unknown; height?: unknown };
  if (o.height !== undefined || !Array.isArray(o.tolerances)) return sp;
  const tols = o.tolerances as Tolerance[];
  const k = tols.findIndex((t) => t && typeof t === 'object' && t.field === 'elevation');
  if (k < 0 || k !== tols.length - 1) return sp;
  const t = tols[k];
  if (![t.min, t.optLow, t.optHigh, t.max].every((v) => typeof v === 'number' && Number.isFinite(v))) return sp;
  const h = { low: t.optLow <= 0 ? 0 : t.optLow, high: t.optHigh >= HEIGHT_MAX ? HEIGHT_MAX : t.optHigh };
  if (h.low > h.high) return sp;
  const same = heightTolerance(h);
  if (same.min !== t.min || same.optLow !== t.optLow || same.optHigh !== t.optHigh || same.max !== t.max) return sp;
  return { ...sp, tolerances: tols.slice(0, k), height: h };
}

// 海拔的耐受条件（读进来、换不成高度范围的；界面上写一行，不能改）
export const elevationTolerances = (sp: Pick<Species, 'tolerances'>): Tolerance[] => sp.tolerances.filter((t) => t.field === 'elevation');

// 算适宜度时用的全部耐受曲线：写着的，加上高度范围（排在最后）。没写高度范围时就是 sp.tolerances 这个数组
export function speciesTolerances(sp: Pick<Species, 'tolerances' | 'height'>): readonly Tolerance[] {
  return sp.height ? [...sp.tolerances, heightTolerance(sp.height)] : sp.tolerances;
}

// ---------- 简化编辑：气候图上的矩形 + 命名条件 ----------
// 矩形的横轴是年均温（°C），纵轴是湿润程度（降水 / 潜在蒸散）。矩形是“最适合”的范围，
// 外面自动留一圈过渡（气温 ±3 °C，湿润程度 ×/÷ 1.4），所以相邻的生态之间是渐变的。

export const T_RANGE: [number, number] = [-40, 40];
export const M_RANGE: [number, number] = [0, 50];
const T_MARGIN = 3;
const M_MARGIN = 1.4;

export interface Rect {
  t0: number;
  t1: number;
  m0: number;
  m1: number;
}

// 超出图范围的边按“不限”读回（取图的边界值），与 rectTolerances 的判断一致
export function speciesRect(sp: Species): Rect {
  const t = sp.tolerances.find((x) => x.field === 'tMean');
  const m = sp.tolerances.find((x) => x.field === 'moisture');
  return {
    t0: Math.max(T_RANGE[0], t?.optLow ?? T_RANGE[0]),
    t1: Math.min(T_RANGE[1], t?.optHigh ?? T_RANGE[1]),
    m0: Math.max(M_RANGE[0], m?.optLow ?? M_RANGE[0]),
    m1: Math.min(M_RANGE[1], m?.optHigh ?? M_RANGE[1]),
  };
}

const rectTolerances = (r: Rect): Tolerance[] => [
  { field: 'tMean', min: r.t0 <= T_RANGE[0] ? T_RANGE[0] - 30 : r.t0 - T_MARGIN, optLow: r.t0 <= T_RANGE[0] ? T_RANGE[0] - 30 : r.t0, optHigh: r.t1 >= T_RANGE[1] ? T_RANGE[1] + 30 : r.t1, max: r.t1 >= T_RANGE[1] ? T_RANGE[1] + 30 : r.t1 + T_MARGIN },
  { field: 'moisture', min: r.m0 <= M_RANGE[0] ? 0 : r.m0 / M_MARGIN, optLow: r.m0, optHigh: r.m1 >= M_RANGE[1] ? 1000 : r.m1, max: r.m1 >= M_RANGE[1] ? 1000 : r.m1 * M_MARGIN },
];

export function withRect(sp: Species, r: Rect): Species {
  const others = sp.tolerances.filter((x) => x.field !== 'tMean' && x.field !== 'moisture');
  return { ...sp, tolerances: [...rectTolerances(r), ...others] };
}

// 命名条件：勾选即可，不用理解字段
export const CONDITIONS = {
  coast: { label: '只长在海边', tol: (): Tolerance => ({ field: 'continentality', min: 0, optLow: 0, optHigh: 0.2, max: 0.4 }) },
  river: { label: '只长在河边、湖边', tol: (): Tolerance => ({ field: 'wetness', min: 19, optLow: 20.5, optHigh: 60, max: 60 }) },
  mountain: { label: '只长在高山上', tol: (): Tolerance => ({ field: 'elevation', min: 1000, optLow: 1500, optHigh: 9000, max: 9000 }) },
  flat: { label: '只长在平地上', tol: (): Tolerance => ({ field: 'slope', min: 0, optLow: 0, optHigh: 2, max: 5 }) },
  summerRain: { label: '雨季在夏天', tol: (): Tolerance => ({ field: 'seasonality', min: 0.1, optLow: 0.35, optHigh: 1, max: 1 }) },
  winterRain: { label: '雨季在冬天', tol: (): Tolerance => ({ field: 'seasonality', min: -1, optLow: -1, optHigh: -0.3, max: -0.1 }) },
  wetland: { label: '低洼积水处', tol: (): Tolerance => ({ field: 'wetness', min: 21, optLow: 22.5, optHigh: 60, max: 60 }) },
} as const;
export type ConditionId = keyof typeof CONDITIONS;

const sameTol = (a: Tolerance, b: Tolerance) => a.field === b.field && a.min === b.min && a.optLow === b.optLow && a.optHigh === b.optHigh && a.max === b.max;

export function speciesConditions(sp: Species): Set<ConditionId> {
  const out = new Set<ConditionId>();
  for (const [id, c] of Object.entries(CONDITIONS) as [ConditionId, (typeof CONDITIONS)[ConditionId]][]) {
    if (sp.tolerances.some((t) => sameTol(t, c.tol()))) out.add(id);
  }
  return out;
}

export function withCondition(sp: Species, id: ConditionId, on: boolean): Species {
  const t = CONDITIONS[id].tol();
  // 夏雨与冬雨互斥
  let tols = sp.tolerances.filter((x) => !sameTol(x, t));
  if (on && (id === 'summerRain' || id === 'winterRain')) tols = tols.filter((x) => !sameTol(x, CONDITIONS[id === 'summerRain' ? 'winterRain' : 'summerRain'].tol()));
  return { ...sp, tolerances: on ? [...tols, t] : tols };
}

// 不属于矩形和命名条件的其他耐受曲线（高级）
export function advancedTolerances(sp: Species): Tolerance[] {
  const conds = Object.values(CONDITIONS).map((c) => c.tol());
  return sp.tolerances.filter((t) => t.field !== 'tMean' && t.field !== 'moisture' && !conds.some((c) => sameTol(t, c)));
}
