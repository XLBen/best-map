import type { Derived, World } from '../../world';
import type { Era } from '../era';
import { cellKm2 } from '../space';
import { genTiers, layoutById, tierWeights } from '../tiers';
import { COUNTRY_KM2, MAX_COUNTRIES, sizeFactor } from './base';
import type { CountryRun } from './state';

// 几个国家（第二十三轮；第二十六轮按“文化 × 陆块”分）。第七十三轮从 countries.ts 搬来（原样）

// 一个国家平均占多少 km² 能住人的陆地
export const averageCountryKm2 = (era: Pick<Era, 'countryKm2'>, fragmentation: number): number => (era.countryKm2 ?? COUNTRY_KM2) * sizeFactor(fragmentation);
// 几个新的国家：能住人的干陆地面积 ÷ 平均的国家面积（有地方时至少 1 个，最多 MAX_COUNTRIES）
export const plannedCountries = (area: number, T: number): number => Math.min(MAX_COUNTRIES, Math.max(area > 0 ? 1 : 0, Math.round(area / T)));

// 大约几个国家（界面的估计；与生成的第一步是同一个算法，各文化正好分完，起点都放得下时就是生成出来的个数）。
// keepLocked：锁定的国家的地方不算，锁定的国家另外算上
export function estimateCountryCount(world: World, d: Pick<Derived, 'habitability' | 'lake'>, era: Era, fragmentation: number, keepLocked = false): number {
  const hab = d.habitability;
  const minH = era.unclaimed.minHabitability;
  const locked = new Set(keepLocked ? Object.values(world.small.countries ?? {}).filter((m) => m.locked).map((m) => m.id) : []);
  const country = world.causes.country;
  let area = 0;
  for (let i = 0; i < world.mesh.n; i++) {
    if (!world.causes.land[i] || d.lake[i] === 1 || hab[i] < minH) continue;
    if (locked.size && country && locked.has(country[i])) continue;
    area += cellKm2(world, i);
  }
  return plannedCountries(area, averageCountryKm2(era, fragmentation)) + locked.size;
}

// 按 mass 分 total 个（最大余数法：加起来正好是 total；mass 是 0 的不分）
export function apportion(total: number, mass: Float64Array): Int32Array {
  const out = new Int32Array(mass.length);
  let sum = 0;
  for (const v of mass) sum += v;
  if (!(sum > 0) || total <= 0) return out;
  let given = 0;
  const rem: [number, number][] = [];
  for (let c = 0; c < mass.length; c++) {
    if (!(mass[c] > 0)) continue;
    const q = (total * mass[c]) / sum;
    out[c] = Math.floor(q);
    given += out[c];
    rem.push([q - out[c], c]);
  }
  rem.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let r = 0; given < total && rem.length; r = (r + 1) % rem.length, given++) out[rem[r][1]]++;
  return out;
}

// 陆块（陆地连成的一片，湖面也算）：每格是第几块（海是 −1）、每格所在的那一块有几格（海是 0）
export function landComponents(world: World): { id: Int32Array; size: Int32Array } {
  const { mesh, causes } = world;
  const n = mesh.n;
  const id = new Int32Array(n).fill(-1);
  const size = new Int32Array(n);
  const stack: number[] = [];
  const comp: number[] = [];
  let k = 0;
  for (let s = 0; s < n; s++) {
    if (!causes.land[s] || id[s] >= 0) continue;
    comp.length = 0;
    id[s] = k;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (causes.land[j] && id[j] < 0) {
          id[j] = k;
          stack.push(j);
        }
      }
    }
    for (const i of comp) size[i] = comp.length;
    k++;
  }
  return { id, size };
}

// 第一步：能住人的干陆地有多大、各文化占多少、几个国家；世界里的等级与生效的比例（第四十二轮）
export function countCountries(g: CountryRun) {
  const { ctx, world, country, minH } = g;
  const { x, hab, era } = ctx;
  const cultureOf = ctx.cultureOf!;
  const small = world.small;
  const n = g.n;
  const K = ctx.cultures.length;
  const areaC = new Float64Array(K);
  const massC = new Float64Array(K);
  let area = 0;
  for (let i = 0; i < n; i++) {
    if (!x.dry[i] || country[i] >= 0 || hab[i] < minH) continue;
    const a = cellKm2(world, i);
    area += a;
    const c = cultureOf[i];
    if (c < 0) continue;
    areaC[c] += a;
    massC[c] += a * hab[i];
  }
  const T = averageCountryKm2(era, g.plan.rules.fragmentation);
  const total = plannedCountries(area, T);
  let massSum = 0;
  for (let c = 0; c < K; c++) massSum += massC[c];
  // 世界里的等级（按 order 从小到大）与生效的比例（第四十二轮）
  const tierList = genTiers(small);
  g.tierW = tierWeights(tierList, era, layoutById(small, g.plan.rules.layout));
  g.tierList = tierList;
  g.tierIndex = new Map(tierList.map((t, k) => [t, k]));
  g.K = K;
  g.areaC = areaC;
  g.massC = massC;
  g.area = area;
  g.T = T;
  g.total = total;
  g.massSum = massSum;
  g.rest = total;
  g.isSeed = new Uint8Array(n);
  g.region = new Int32Array(n).fill(-1);
}
