import { type Species, speciesRect } from '../species';
import type { Derived, World } from '../world';
import type { Preference } from './era';
import { COAST, type CellInputs, type CompiledRule, LAKE, RIVER, compileRule, ruleMatches } from './rules';
import type { TerrainClass } from './terrain-class';

// 宜居度（第二十二轮）：每格 0–1，人口按它分。推导出来的（自然改了就重算），只看干的陆地，水面为 0。
//   宜居度 = 生态的宜居分 × 冷 × 水与海岸 × 地势 × 地形类别的倍数，最后截到 [0, 1]
// - 生态的宜居分：生态写了 habitability 就用它（第三十轮起内置的生态都写了，与以前的 BIOME_HABITABILITY 表逐个相同）；没写的按生态的地形与最适合的气温估
// - 冷：年均温 0 °C 以下渐渐变少，−15 °C 以下只剩一成
// - 水：有河（流量够画成河）时先至少有 0.27–0.45（荒漠里的大河两岸也能住人；生态分越低越少），再 ×1.35–1.8（河越大越多）；挨着海 ×1.3，挨着湖 ×1.2
// - 地势：海拔 1500 m 以上渐渐变少，5000 m 以上只剩 5%；坡度 ×1 / (1 + 坡度 / 30)
// - 地形类别（只管起伏）：类别写了 habitability 就用它（内置的都写了，与以前的 CLASS_HABITABILITY 相同），没写的为 1
// 各个人口群体自己的偏好（矮人喜山）在这之上再乘（见 preferenceFactors）

// 别的生态按地形估
const TERRAIN_HABITABILITY: Readonly<Record<string, number>> = {
  plains: 0.8,
  steppe: 0.55,
  savanna: 0.52,
  forest: 0.54,
  hills: 0.57,
  jungle: 0.28,
  marsh: 0.18,
  desert: 0.05,
  arctic: 0.065,
  mountains: 0.3,
};

// 一种生态的宜居分（0–1）
export function biomeHabitability(sp: Species): number {
  if (sp.habitability !== undefined) return sp.habitability;
  let v = TERRAIN_HABITABILITY[sp.terrain] ?? 0.5;
  const r = speciesRect(sp);
  const t = (Math.max(r.t0, -30) + Math.min(r.t1, 35)) / 2;
  if (t < -12) v *= 0.2;
  else if (t < 0) v *= 0.6;
  return v;
}

// 一种地形类别的倍数
export const classHabitability = (c: TerrainClass | undefined): number => c?.habitability ?? 1;

// 按什么算的（数组 → 标识）：只画了别的人文（人口、资源）时照用上一份
const memo = new WeakMap<Float32Array, { cls: Uint8Array; key: string }>();

// cls：生效的地形类别（编号 = 下标 + 1）
export function computeHabitability(world: World, d: Derived, x: CellInputs, cls: Uint8Array, classes: readonly TerrainClass[], natural: boolean): Float32Array {
  const species = world.small.species;
  const key = `${JSON.stringify(species.map((sp) => [sp.id, sp.terrain, sp.habitability ?? null]))}|${JSON.stringify(classes.map((c) => c.habitability ?? null))}|${world.small.planet.riverThreshold}`;
  const prev = natural ? undefined : memo.get(d.habitability);
  if (prev && prev.cls === cls && prev.key === key && d.habitability.length === x.n) return d.habitability;
  const bio = species.map(biomeHabitability);
  const riverFloor = bio.map((v) => 0.6 + 0.4 * Math.min(1, v / 0.6));
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
      // 河边至少有的那一份按植被打折（第二十七轮：以前由植被的地形类别乘上去）：生态分 0.6 以上为 0.45，越低越少，最少六成
      h = Math.max(h, 0.45 * cold * (b >= 0 ? riverFloor[b] : 1));
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
