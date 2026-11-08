import { HeapLite } from '../mesh';
import type { CityMeta, Derived, SettlementRules, World } from '../world';
import { type CellInputs, COAST, LAKE, RIVER, cellInputs } from './rules';
import { worldEra } from './era';
import { cellKm2, noiseAt } from './space';
import { isMajorRank, worldCityRanks } from './settle-content';
import { nextSettlementId, cellKm, territory } from './city-table';
export { nextSettlementId, cellKm, cityAt, cityOf, hasCities, cityName, computeCityTable, cmpInfo, cityTable, cityList } from './city-table';
export type { CityInfo, CityTable } from './city-table';
export { addCity, removeCity, moveCityCell, setCity, nearestLand, repairCities, tidyCities, clearCities } from './city-edit';
export type { CityInput, CityPatch } from './city-edit';
export { popText, cityArchive, countryCities } from './city-archive';
export type { CityArchive } from './city-archive';

// 城市（第二十四轮）：按人口放、一格最多一座，数量按时代的城市化率，等级按占本国人口的比例（首都是星）。
// 存在 small.cities 的只有“在哪一格、自动还是自己放的”与自己改过的几项；名字、等级、所属、人口、是不是首都都按世界现算
// （cityTable），所以改了人口、国界、地名风格之后城市跟着变，自己定过的不变。
// 人口：每座城市管着离它最近的那些格（同一个国家里，按 km，最远约四格距），城市的人口 = 这些格的人口 × 时代的城市化率，
// 再按大小拉开（大的更大，首都按政体的城市化更大）；占本国人口的比例 = 城市的人口 ÷ 这个国家的总人口

// 每格平均几座城市：城市化率 0.1 时约 1/30 格能住人的陆地，随 √城市化率
const CITY_RATE = 1 / 30;
// 无主地上的城市少一半
const UNCLAIMED_RATE = 0.5;
// 城市之间至少隔开 √(面积 / 个数) 的这么多倍（挑不出来时放宽）
const SPACING = 0.6;
// 一个世界最多几座城市
export const MAX_CITIES = 4000;

// 生成、编辑要看的：每格的输入（干的陆地、海岸、河）与生效的地形类别
export interface SettleInputs {
  world: World;
  d: Derived;
  x: CellInputs;
  cls: Uint8Array;
}
export const settleInputs = (world: World, d: Derived): SettleInputs => ({ world, d, x: cellInputs(world, d), cls: d.terrainClass });

// ---------- 生成 ----------

export interface CityPlan {
  rules: SettlementRules;
  // 留着的城市（重新生成时：锁定的、自己放的）
  keep: (c: CityMeta) => boolean;
}

// 离 src 不到 km 的格（按边长，海陆都走），每格一次 visit(i, 距离)
function within(world: World, src: number, km: number, visit: (i: number, dist: number) => void, heap: HeapLite, dist: Float64Array, stamp: Int32Array, tag: number) {
  const { mesh } = world;
  const k = world.kmPerUnit;
  heap.size = 0;
  dist[src] = 0;
  stamp[src] = tag;
  heap.push(src, 0);
  while (heap.size) {
    const i = heap.pop();
    const di = heap.lastKey;
    if (di > dist[i]) continue;
    visit(i, di);
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      const nd = di + mesh.dist[e] * k;
      if (nd > km) continue;
      if (stamp[j] !== tag || nd < dist[j]) {
        stamp[j] = tag;
        dist[j] = nd;
        heap.push(j, nd);
      }
    }
  }
}

// 放城市：留着的不动，每个国家（无主地也算一份）按城市化率与人口定个数，首都先放在首都格上，
// 别的按“人口 × 靠河 × 靠海 × 一点噪声”从高到低挑、彼此隔开。返回新放的城市个数
export function placeCities(S: SettleInputs, plan: CityPlan): number {
  const { world, x } = S;
  const { mesh, causes, small } = world;
  const n = mesh.n;
  const pop = causes.popTotal;
  const all = small.cities ?? {};
  const kept: Record<string, CityMeta> = {};
  for (const [k, c] of Object.entries(all)) if (plan.keep(c)) kept[k] = c;
  small.cities = kept;
  if (!pop) return 0;
  const seed = plan.rules.seed >>> 0;
  const u = Math.min(1, Math.max(0, worldEra(small)?.urbanization ?? 0.1));
  const rate = CITY_RATE * Math.sqrt(u / 0.1);
  // 每个国家能住人的格数、人口、面积
  interface Acc {
    cells: number[];
    pop: number;
    km2: number;
  }
  const acc = new Map<number, Acc>();
  let peopled = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    if (!x.dry[i] || !(pop[i] > 0)) continue;
    const t = territory(world, i);
    let a = acc.get(t);
    if (!a) acc.set(t, (a = { cells: [], pop: 0, km2: 0 }));
    a.cells.push(i);
    a.pop += pop[i];
    a.km2 += cellKm2(world, i);
    peopled++;
    total += pop[i];
  }
  const keys = [...acc.keys()].sort((a, b) => (a < 0 ? 1 : b < 0 ? -1 : a - b));
  // 个数：一半按格数、一半按人口，至少一座（有人的国家）
  const want = new Map<number, number>();
  for (const t of keys) {
    const a = acc.get(t)!;
    const r = rate * (t < 0 ? UNCLAIMED_RATE : 1);
    const raw = r * (0.5 * a.cells.length + 0.5 * peopled * (total > 0 ? a.pop / total : 0));
    want.set(t, Math.max(t >= 0 ? 1 : 0, Math.round(raw)));
  }
  // 留着的算进各国的个数
  const have = new Map<number, number>();
  for (const c of Object.values(kept)) have.set(territory(world, c.cell), (have.get(territory(world, c.cell)) ?? 0) + 1);
  // 离最近的城市多远（km）：放一座更新一片
  const near = new Float64Array(n).fill(Infinity);
  const heap = new HeapLite(256);
  const dist = new Float64Array(n);
  const stamp = new Int32Array(n);
  let tag = 0;
  const ckm = cellKm(world);
  const spacingOf = (t: number) => {
    const a = acc.get(t);
    const k = Math.max(1, want.get(t) ?? 1);
    return Math.max(1.6 * ckm, SPACING * Math.sqrt((a?.km2 ?? 0) / k));
  };
  const mark = (cell: number, km: number) => {
    tag++;
    within(world, cell, km, (i, dd) => {
      if (dd < near[i]) near[i] = dd;
    }, heap, dist, stamp, tag);
  };
  const occupied = new Set<number>();
  for (const c of Object.values(kept)) {
    occupied.add(c.cell);
    mark(c.cell, 2 * spacingOf(territory(world, c.cell)));
  }
  let added = 0;
  const add = (cell: number) => {
    const id = nextSettlementId(world);
    small.cities![id] = { id, cell, auto: true };
    occupied.add(cell);
    have.set(territory(world, cell), (have.get(territory(world, cell)) ?? 0) + 1);
    added++;
  };
  // 首都
  for (const c of Object.values(small.countries ?? {}).sort((a, b) => a.id - b.id)) {
    const cap = c.capitalCell;
    if (cap === undefined || !causes.land[cap] || occupied.has(cap) || added + Object.keys(kept).length >= MAX_CITIES) continue;
    add(cap);
    mark(cap, 2 * spacingOf(territory(world, cap)));
  }
  // 别的：按分数从高到低
  const score = (i: number) => {
    const f = x.flags[i];
    return pop[i] * (f & RIVER ? 1.6 : 1) * (f & COAST ? 1.4 : 1) * (f & LAKE ? 1.2 : 1) * Math.exp(0.25 * noiseAt(world, seed ^ 0x51c1, 300, i));
  };
  for (const t of keys) {
    const a = acc.get(t)!;
    const target = want.get(t)!;
    if ((have.get(t) ?? 0) >= target) continue;
    const sc = new Float64Array(n);
    for (const i of a.cells) sc[i] = score(i);
    const cands = [...a.cells].sort((p, q) => sc[q] - sc[p] || p - q);
    let gap = spacingOf(t);
    for (let pass = 0; pass < 4 && (have.get(t) ?? 0) < target; pass++) {
      for (const i of cands) {
        if ((have.get(t) ?? 0) >= target || Object.keys(small.cities!).length >= MAX_CITIES) break;
        if (occupied.has(i) || near[i] < gap) continue;
        add(i);
        mark(i, 2 * gap);
      }
      gap *= 0.7;
      if (gap < 1.6 * ckm) gap = 0.99 * ckm;
    }
  }
  return added;
}

// 生成 / 重新生成城市（命令、生成人文的一步共用）：fresh 时全部换掉，否则锁定的、自己放的留着
export function generateCities(S: SettleInputs, rules: SettlementRules, fresh: boolean): number {
  // 第三十轮：世界里没有城市等级时不放城市（自动的去掉，自己放的留着；见 content/missing.ts）
  if (!worldCityRanks(S.world.small).length) {
    const cities = S.world.small.cities;
    if (cities) for (const c of Object.values(cities)) if (c.auto && (fresh || !c.locked)) delete cities[c.id];
    if (cities && !Object.keys(cities).length) delete S.world.small.cities;
    return Object.keys(S.world.small.cities ?? {}).length;
  }
  placeCities(S, { rules, keep: (c) => !fresh && (!c.auto || !!c.locked) });
  return Object.keys(S.world.small.cities ?? {}).length;
}

export { isMajorRank };
