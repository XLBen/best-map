import { z } from 'zod';
import type { FieldDesc } from '../content/registry';
import { typeIdSchema } from '../type-id';
import type { Mesh } from '../mesh';
import { type Derived, type World, worldLatitude } from '../world';

// 按格的条件（第二十一轮）：地形类别的自动规则、资源的分布规则共用一种写法。
// 一条规则里写了的几项都满足才算（范围两端都含）；一种类别、资源有几条规则，满足任何一条就算。
// 按的是自然的推导：高度与坡度是推导里的（画的河挖出的河谷算低一些）、年均温、湿润指数、地形湿度、纬度、生态。

export const cellRuleSchema = z.object({
  // 海拔（m）
  elevMin: z.number().optional(),
  elevMax: z.number().optional(),
  // 坡度（m/km）
  slopeMin: z.number().optional(),
  slopeMax: z.number().optional(),
  // 年均温（°C）
  tempMin: z.number().optional(),
  tempMax: z.number().optional(),
  // 湿润指数（P/PET）
  moistMin: z.number().optional(),
  moistMax: z.number().optional(),
  // 地形湿度指数
  wetMin: z.number().optional(),
  wetMax: z.number().optional(),
  // 纬度（绝对值，°）
  latMin: z.number().optional(),
  latMax: z.number().optional(),
  // 生态的地形类别（生态的 terrain：forest、jungle、steppe、desert、arctic、marsh……）
  terrain: z.array(z.string().max(30)).max(32).optional(),
  // 生态的 id
  biomes: z.array(typeIdSchema).max(64).optional(),
  // 地形类别的 id（只管起伏：plains、hills、highlands、mountains、peaks 与自己加的；资源、偏好用，地形类别的规则里不能写）
  classes: z.array(typeIdSchema).max(64).optional(),
  // 挨着海（true）/ 不挨着海（false）
  coast: z.boolean().optional(),
  // 有河流过（流量够画成河）
  river: z.boolean().optional(),
  // 挨着湖
  lake: z.boolean().optional(),
});
export type CellRule = z.output<typeof cellRuleSchema>;

// 编辑器里一条规则的字段
const range = (key: string, label: string, unit: string): FieldDesc[] => [
  { key: `${key}Min`, label: `${label}下限`, type: 'number', optional: true, hint: unit },
  { key: `${key}Max`, label: `${label}上限`, type: 'number', optional: true, hint: unit },
];
export const RULE_FIELDS: readonly FieldDesc[] = [
  ...range('elev', '海拔', 'm'),
  ...range('slope', '坡度', 'm/km'),
  ...range('temp', '年均温', '°C'),
  ...range('moist', '湿润指数', 'P/PET'),
  ...range('wet', '地形湿度', ''),
  ...range('lat', '纬度', '°（绝对值）'),
  { key: 'terrain', label: '生态的地形', type: 'tags', optional: true, hint: 'forest、jungle、steppe、desert、arctic、marsh…' },
  { key: 'biomes', label: '生态', type: 'tags', optional: true, hint: '生态的 id' },
  { key: 'coast', label: '挨着海', type: 'bool', optional: true },
  { key: 'river', label: '有河', type: 'bool', optional: true },
  { key: 'lake', label: '挨着湖', type: 'bool', optional: true },
];
export const RESOURCE_RULE_FIELDS: readonly FieldDesc[] = [{ key: 'classes', label: '地形类别', type: 'tags', optional: true, hint: 'plains、hills、highlands、mountains、peaks（只管起伏；植被写“生态的地形”）' }, ...RULE_FIELDS];

// 每格的输入：一次算好，规则只查表
export interface CellInputs {
  n: number;
  // 陆地、不是湖面的格为 1（只给这些格分类别、资源）
  dry: Uint8Array;
  elevation: ArrayLike<number>;
  slope: ArrayLike<number>;
  temp: ArrayLike<number>;
  moisture: ArrayLike<number>;
  wetness: ArrayLike<number>;
  lat: Float32Array;
  // 主导的生态下标（-1 水，-2 什么都长不了）
  biome: ArrayLike<number>;
  // 位标记：1 挨着海、2 有河、4 挨着湖
  flags: Uint8Array;
}

export const COAST = 1;
export const RIVER = 2;
export const LAKE = 4;

export function cellInputs(world: World, d: Derived): CellInputs {
  const { mesh, causes } = world;
  const n = mesh.n;
  const dry = new Uint8Array(n);
  const flags = new Uint8Array(n);
  const lat = new Float32Array(n);
  const thr = world.small.planet.riverThreshold;
  inputFlags(n, mesh.off, mesh.adj, causes.land, d.lake, d.discharge, thr, absLatitudes(world), dry, flags, lat);
  return { n, dry, elevation: d.elevation, slope: d.slope, temp: d.tMean, moisture: d.moisture, wetness: d.wetness, lat, biome: d.dominant, flags };
}

// 每格纬度的绝对值（Float32，与逐格按 worldLatitude 现算的相同）：只取决于网格、建世界时的纬度与挪过的度数，按网格记一份（第三十五轮提速）
const latCache = new WeakMap<Mesh, { key: string; lat: Float32Array }>();
function absLatitudes(world: World): Float32Array {
  const { mesh, settings } = world;
  const key = settings.globe ? 'globe' : `${settings.latNorth}|${settings.latSouth}|${world.small.planet.latShift}`;
  const hit = latCache.get(mesh);
  if (hit && hit.key === key) return hit.lat;
  const lat = new Float32Array(mesh.n);
  for (let i = 0; i < mesh.n; i++) lat[i] = Math.abs(worldLatitude(world, mesh.y[i]));
  latCache.set(mesh, { key, lat });
  return lat;
}

// 干的陆地、挨海 / 有河 / 挨湖的标记与纬度（第三十五轮提速：逐格的循环放在小函数里）
function inputFlags(n: number, off: Int32Array, adj: Int32Array, land: Uint8Array, lake: Uint8Array, discharge: Float32Array, thr: number, absLat: Float32Array, dry: Uint8Array, flags: Uint8Array, lat: Float32Array) {
  for (let i = 0; i < n; i++) {
    if (!land[i] || lake[i] === 1) continue;
    dry[i] = 1;
    let f = discharge[i] >= thr ? RIVER : 0;
    for (let e = off[i]; e < off[i + 1]; e++) {
      const j = adj[e];
      if (!land[j]) f |= COAST;
      else if (lake[j] === 1) f |= LAKE;
    }
    flags[i] = f;
    lat[i] = absLat[i];
  }
}

// 编译好的规则：范围换成数，生态、地形类别换成按下标查的表（null 是不限）
export interface CompiledRule {
  lo: Float64Array;
  hi: Float64Array;
  biome: Uint8Array | null;
  cls: Uint8Array | null;
  // 要有的标记、要没有的标记
  need: number;
  not: number;
}

const KEYS = ['elev', 'slope', 'temp', 'moist', 'wet', 'lat'] as const;

// biomes：世界里的生态（按下标）；classIds：世界里的地形类别（编号 = 下标 + 1），资源的规则才用
export function compileRule(rule: CellRule, biomes: readonly { id: string; terrain: string }[], classIds?: readonly string[]): CompiledRule {
  const lo = new Float64Array(KEYS.length).fill(-Infinity);
  const hi = new Float64Array(KEYS.length).fill(Infinity);
  const r = rule as Record<string, unknown>;
  KEYS.forEach((k, q) => {
    const a = r[`${k}Min`];
    const b = r[`${k}Max`];
    if (typeof a === 'number') lo[q] = a;
    if (typeof b === 'number') hi[q] = b;
  });
  let biome: Uint8Array | null = null;
  if (rule.terrain || rule.biomes) {
    biome = new Uint8Array(biomes.length);
    biomes.forEach((sp, k) => {
      biome![k] = (!rule.terrain || rule.terrain.includes(sp.terrain)) && (!rule.biomes || rule.biomes.includes(sp.id)) ? 1 : 0;
    });
  }
  let cls: Uint8Array | null = null;
  if (rule.classes && classIds) {
    if (!classIds.length) {
      // 第三十轮：世界里没有地形类别时每格都按平地（plains）算：写了平地的条件都满足，别的都不满足
      if (!rule.classes.includes('plains')) cls = new Uint8Array(1);
    } else {
      cls = new Uint8Array(classIds.length + 1);
      classIds.forEach((id, k) => (cls![k + 1] = rule.classes!.includes(id) ? 1 : 0));
    }
  }
  let need = 0;
  let not = 0;
  const flag = (v: boolean | undefined, bit: number) => {
    if (v === true) need |= bit;
    else if (v === false) not |= bit;
  };
  flag(rule.coast, COAST);
  flag(rule.river, RIVER);
  flag(rule.lake, LAKE);
  return { lo, hi, biome, cls, need, not };
}

// 第 i 格满不满足这条规则（cls：这一格的地形类别编号，资源的规则才看）
export function ruleMatches(r: CompiledRule, x: CellInputs, i: number, cls = 0): boolean {
  // 先查生态、类别、标记（多数规则在这里就不满足）
  if (r.biome) {
    const b = x.biome[i];
    if (b < 0 || !r.biome[b]) return false;
  }
  if (r.cls && !r.cls[cls]) return false;
  const f = x.flags[i];
  if ((f & r.need) !== r.need || (f & r.not) !== 0) return false;
  const { lo, hi } = r;
  const e = x.elevation[i];
  if (e < lo[0] || e > hi[0]) return false;
  const s = x.slope[i];
  if (s < lo[1] || s > hi[1]) return false;
  const t = x.temp[i];
  if (t < lo[2] || t > hi[2]) return false;
  const m = x.moisture[i];
  if (m < lo[3] || m > hi[3]) return false;
  const w = x.wetness[i];
  if (w < lo[4] || w > hi[4]) return false;
  const l = x.lat[i];
  if (l < lo[5] || l > hi[5]) return false;
  return true;
}
