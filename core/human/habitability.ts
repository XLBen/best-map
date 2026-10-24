import { DEFAULT_SPECIES, type Species, speciesRect } from '../species';
import type { Derived, World } from '../world';
import type { Preference } from './era';
import { COAST, type CellInputs, type CompiledRule, LAKE, RIVER, compileRule, ruleMatches } from './rules';
import type { TerrainClass } from './terrain-class';

// 宜居度（第二十二轮）：每格 0–1，人口按它分。推导出来的（自然改了就重算），只看干的陆地，水面为 0。
//   宜居度 = 生态的宜居分 × 冷 × 水与海岸 × 地势 × 地形类别的倍数，最后截到 [0, 1]
// - 生态的宜居分：生态写了 habitability 就用它；内置的生态按 BIOME_HABITABILITY；别的按生态的地形与最适合的气温估
// - 冷：年均温 0 °C 以下渐渐变少，−15 °C 以下只剩一成
// - 水：有河（流量够画成河）时先至少有 0.45（荒漠里的大河两岸也能住人），再 ×1.35–1.8（河越大越多）；挨着海 ×1.3，挨着湖 ×1.2
// - 地势：海拔 1500 m 以上渐渐变少，5000 m 以上只剩 5%；坡度 ×1 / (1 + 坡度 / 30)
// - 地形类别：类别写了 habitability 就用它，内置的按 CLASS_HABITABILITY
// 各个人口群体自己的偏好（矮人喜山）在这之上再乘（见 preferenceFactors）

// 内置生态的宜居分
export const BIOME_HABITABILITY: Readonly<Record<string, number>> = {
  ice: 0.01,
  tundra: 0.12,
  taiga: 0.35,
  temperate_forest: 0.8,
  steppe: 0.65,
  shrubland: 0.75,
  subtropical_forest: 0.8,
  savanna: 0.6,
  dry_forest: 0.6,
  monsoon_forest: 0.75,
  rainforest: 0.35,
  wetland: 0.3,
  desert: 0.06,
};

// 别的生态按地形估
const TERRAIN_HABITABILITY: Readonly<Record<string, number>> = {
  plains: 0.8,
  steppe: 0.6,
  savanna: 0.55,
  forest: 0.6,
  hills: 0.6,
  jungle: 0.4,
  marsh: 0.3,
  desert: 0.07,
  arctic: 0.08,
  mountains: 0.3,
};

// 内置的地形类别的倍数
export const CLASS_HABITABILITY: Readonly<Record<string, number>> = {
  plains: 1,
  grasslands: 1,
  steppe: 0.85,
  hills: 0.85,
  highlands: 0.75,
  mountains: 0.45,
  peaks: 0.08,
  forest: 0.85,
  woods: 0.95,
  jungle: 0.7,
  marsh: 0.6,
  desert: 0.7,
  tundra: 0.8,
  glacier: 0.1,
};

const DEFAULT_TERRAIN = new Map(DEFAULT_SPECIES.map((sp) => [sp.id, sp.terrain]));

// 一种生态的宜居分（0–1）
export function biomeHabitability(sp: Species): number {
  if (sp.habitability !== undefined) return sp.habitability;
  const builtin = BIOME_HABITABILITY[sp.id];
  if (builtin !== undefined && DEFAULT_TERRAIN.get(sp.id) === sp.terrain) return builtin;
  let v = TERRAIN_HABITABILITY[sp.terrain] ?? 0.5;
  const r = speciesRect(sp);
  const t = (Math.max(r.t0, -30) + Math.min(r.t1, 35)) / 2;
  if (t < -12) v *= 0.2;
  else if (t < 0) v *= 0.6;
  return v;
}

// 一种地形类别的倍数
export const classHabitability = (c: TerrainClass | undefined): number => (c ? (c.habitability ?? CLASS_HABITABILITY[c.id] ?? 1) : 1);

// 按什么算的（数组 → 标识）：只画了别的人文（人口、资源）时照用上一份
const memo = new WeakMap<Float32Array, { cls: Uint8Array; key: string }>();

// cls：生效的地形类别（编号 = 下标 + 1）
export function computeHabitability(world: World, d: Derived, x: CellInputs, cls: Uint8Array, classes: readonly TerrainClass[], natural: boolean): Float32Array {
  const species = world.small.species;
  const key = `${JSON.stringify(species.map((sp) => [sp.id, sp.terrain, sp.habitability ?? null]))}|${JSON.stringify(classes.map((c) => c.habitability ?? null))}|${world.small.planet.riverThreshold}`;
  const prev = natural ? undefined : memo.get(d.habitability);
  if (prev && prev.cls === cls && prev.key === key && d.habitability.length === x.n) return d.habitability;
  const bio = species.map(biomeHabitability);
  const cf = [1, ...classes.map(classHabitability)];
  const thr = world.small.planet.riverThreshold;
  const out = new Float32Array(x.n);
  for (let i = 0; i < x.n; i++) {
    if (!x.dry[i]) continue;
    const b = x.biome[i];
    let h = b >= 0 ? bio[b] : 0;
    const t = x.temp[i];
    const cold = t >= 0 ? 1 : Math.max(0.1, 1 + t / 15);
    h *= cold;
    const f = x.flags[i];
    if (f & RIVER) {
      h = Math.max(h, 0.45 * cold);
      const q = d.discharge[i] / thr;
      h *= 1.35 + 0.15 * Math.min(3, Math.log10(Math.max(1, q)));
    }
    if (f & COAST) h *= 1.3;
    if (f & LAKE) h *= 1.2;
    const e = x.elevation[i];
    if (e > 1500) h *= e >= 5000 ? 0.05 : 1 - (0.95 * (e - 1500)) / 3500;
    h /= 1 + x.slope[i] / 30;
    h *= cf[cls[i]] ?? 1;
    out[i] = h > 1 ? 1 : h;
  }
  memo.set(out, { cls, key });
  return out;
}

// ---------- 偏好 ----------

export interface CompiledPrefs {
  rules: CompiledRule[];
  factors: number[];
}

// 偏好编译成按格查的规则（classIds：世界里地形类别的 id，编号 = 下标 + 1）
export function compilePrefs(list: readonly Preference[] | undefined, biomes: readonly { id: string; terrain: string }[], classIds: readonly string[]): CompiledPrefs | null {
  if (!list?.length) return null;
  return { rules: list.map((p) => compileRule(p, biomes, classIds)), factors: list.map((p) => p.factor) };
}

// 第 i 格的偏好倍数（满足的几条连乘；没有偏好为 1）
export function prefAt(p: CompiledPrefs | null, x: CellInputs, cls: Uint8Array, i: number): number {
  if (!p) return 1;
  let f = 1;
  for (let k = 0; k < p.rules.length; k++) if (ruleMatches(p.rules[k], x, i, cls[i])) f *= p.factors[k];
  return f;
}

// 每格的偏好倍数（只算干的陆地，别的为 0）
export function preferenceFactors(p: CompiledPrefs | null, x: CellInputs, cls: Uint8Array): Float32Array {
  const out = new Float32Array(x.n);
  for (let i = 0; i < x.n; i++) if (x.dry[i]) out[i] = prefAt(p, x, cls, i);
  return out;
}
