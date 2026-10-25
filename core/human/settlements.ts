import { CommandError } from '../errors';
import { HeapLite } from '../mesh';
import { type GenName, hasType, styleFor, styleName } from '../name-styles';
import { hashString } from '../names';
import { mixSeed, mulberry32 } from '../rng';
import type { CityMeta, Derived, PointMeta, SettlementRules, World } from '../world';
import { type CellInputs, COAST, LAKE, RIVER, cellInputs } from './rules';
import { worldEra } from './era';
import { governmentById } from './government';
import { classAt } from './terrain-class';
import { cellKm2, noiseAt } from './space';
import { capitalRank, cityRankById, isMajorRank, pointTypeById, rankFor, worldCityRanks } from './settle-content';
import type { CityRank } from './settle-types';

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
// 一座城市管多远：格距的这么多倍
const CATCH_CELLS = 4;
// 城市的人口按管着的人口的这次方拉开
const PRIMACY = 1.15;
// 首都的人口倍数（再乘政体的城市化）
const CAPITAL_BOOST = 1.8;
// 一个世界最多几座城市
export const MAX_CITIES = 4000;

const seedOf = (world: World) => world.small.settlementRules?.seed ?? world.small.human?.seed ?? world.small.terrain.gen?.seed ?? world.settings.seed;

// 下一个编号（城市、道路、地标、自定义点共用）
export function nextSettlementId(world: World): number {
  const id = Math.max(1, world.small.nextSettlement ?? 1);
  world.small.nextSettlement = id + 1;
  return id;
}

// 生成、编辑要看的：每格的输入（干的陆地、海岸、河）与生效的地形类别
export interface SettleInputs {
  world: World;
  d: Derived;
  x: CellInputs;
  cls: Uint8Array;
}
export const settleInputs = (world: World, d: Derived): SettleInputs => ({ world, d, x: cellInputs(world, d), cls: d.terrainClass });

// 格距（km）
export const cellKm = (world: World): number => world.mesh.spacing * world.kmPerUnit;

// 这一格上的城市
export function cityAt(world: World, cell: number): CityMeta | undefined {
  for (const c of Object.values(world.small.cities ?? {})) if (c.cell === cell) return c;
  return undefined;
}

export function cityOf(world: World, id: number): CityMeta {
  const c = world.small.cities?.[id];
  if (!c) throw new CommandError(`找不到城市 ${id}`);
  return c;
}

// ---------- 现算的：等级、人口、所属、名字 ----------

export interface CityInfo {
  id: number;
  // 当作城市的自定义点（没挂在城市上的）：id 是点的编号
  point?: true;
  cell: number;
  x: number;
  y: number;
  name: string;
  orig?: string;
  // 名字是自己起的
  customName: boolean;
  rank: CityRank;
  // 等级是按比例自动定的（autoRank 是自动的那一级）
  rankAuto: boolean;
  autoRank: CityRank;
  // 所属国家（null 无主）；countryAuto：按所在格的领土
  country: number | null;
  countryAuto: boolean;
  // 首都（国家档案里的首都）；陪都（挂着“当作首都”的自定义点）
  capital: boolean;
  secondCapital: boolean;
  population: number;
  // 占本国人口的比例（无主的城市按无主地的总人口）
  share: number;
  auto: boolean;
  locked: boolean;
}

export interface CityTable {
  list: CityInfo[];
  byId: Map<number, CityInfo>;
  // 每格归哪座城市管（CityInfo 的下标，−1 没有）
  owner: Int32Array;
  // 每个国家（编号；无主为 −1）的总人口
  countryPop: Map<number, number>;
}

// 世界里有没有城市（城市、当作城市的点）
export const hasCities = (world: Pick<World, 'small'>): boolean => !!world.small.cities && Object.keys(world.small.cities).length > 0;

// 所在格的国家（−1 无主）
const territory = (world: World, cell: number): number => world.causes.country?.[cell] ?? -1;

// 一座城市的名字：自己起的；否则按当地的风格（city 类，没写时 province，再没有时 spot）起，种子按城市的编号与盐
export function cityName(world: World, meta: Pick<CityMeta, 'id' | 'cell' | 'name' | 'orig' | 'salt'>, extraSalt = 0): GenName & { custom: boolean } {
  if (meta.name) return { zh: meta.name, ...(meta.orig ? { orig: meta.orig } : {}), custom: true };
  const rs = styleFor(world, { cell: meta.cell });
  const type = hasType(rs.style, 'city') ? 'city' : hasType(rs.style, 'province') ? 'province' : 'spot';
  const seed = world.small.terrain.gen?.seed ?? world.settings.seed;
  const n = styleName(rs.style, type, cityTags(world, meta.cell), hashString(`${seed}:city:${meta.id}:${(meta.salt ?? 0) + extraSalt}${rs.suffix}`));
  return { ...n, custom: false };
}

function cityTags(world: World, i: number): string[] {
  const { mesh, causes, derived: d } = world;
  const tags: string[] = [];
  let coast = false;
  for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (!causes.land[mesh.adj[e]]) coast = true;
  if (coast) tags.push('coastal');
  if (d.discharge[i] >= world.small.planet.riverThreshold && d.lake[i] !== 1) tags.push('river');
  if (d.elevation[i] >= 1300 || classAt(world.small, d.terrainClass[i])?.ore) tags.push('mountain');
  if (d.tMean[i] < 0) tags.push('cold');
  return tags;
}

// 当作城市的自定义点：挂着的城市（attachedCity），没挂时这个点自己当一座城市
function cityPoints(world: World): { point: PointMeta; capital: boolean; rank?: string }[] {
  const out: { point: PointMeta; capital: boolean; rank?: string }[] = [];
  for (const p of Object.values(world.small.points ?? {})) {
    const t = pointTypeById(world.small, p.type);
    if (!t?.actsAsCity) continue;
    out.push({ point: p, capital: !!t.actsAsCity.capital, ...(t.actsAsCity.rank ? { rank: t.actsAsCity.rank } : {}) });
  }
  return out;
}

// 一座城市（或当作城市的点）的源：格、所属
interface Source {
  id: number;
  point?: true;
  cell: number;
  meta?: CityMeta;
  country: number;
}

// 城市管着的格：从每座城市同时往外按 km 走，只走同一个国家（所在格的领土）的干的陆地，最远 CATCH_CELLS 格距
function catchment(world: World, sources: readonly Source[]): Int32Array {
  const { mesh, causes, derived: d } = world;
  const n = mesh.n;
  const owner = new Int32Array(n).fill(-1);
  const dist = new Float64Array(n).fill(Infinity);
  const heap = new HeapLite(sources.length * 4);
  const limit = CATCH_CELLS * cellKm(world);
  const terr = causes.country;
  const k = world.kmPerUnit;
  sources.forEach((s, q) => {
    if (dist[s.cell] === 0) return;
    dist[s.cell] = 0;
    owner[s.cell] = q;
    heap.push(s.cell, 0);
  });
  while (heap.size) {
    const i = heap.pop();
    const di = heap.lastKey;
    if (di > dist[i]) continue;
    const o = owner[i];
    const tc = terr ? terr[sources[o].cell] : -1;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (!causes.land[j] || d.lake[j] === 1) continue;
      if (terr && terr[j] !== tc) continue;
      const nd = di + mesh.dist[e] * k;
      if (nd > limit || nd >= dist[j]) continue;
      dist[j] = nd;
      owner[j] = o;
      heap.push(j, nd);
    }
  }
  return owner;
}

// 算一遍城市的表（不缓存；命令里用）
export function computeCityTable(world: World): CityTable {
  const { mesh, causes, small } = world;
  const ranks = worldCityRanks(small);
  const capR = capitalRank(ranks);
  const metas = Object.values(small.cities ?? {}).sort((a, b) => a.id - b.id);
  const pts = cityPoints(world);
  const attached = new Map<number, { capital: boolean; rank?: string }>();
  const sources: Source[] = metas.map((m) => ({ id: m.id, cell: m.cell, meta: m, country: m.country ?? territory(world, m.cell) }));
  const taken = new Set(metas.map((m) => m.cell));
  for (const p of pts) {
    const host = p.point.attachedCity !== undefined ? small.cities?.[p.point.attachedCity] : undefined;
    if (host) {
      const a = attached.get(host.id) ?? { capital: false };
      attached.set(host.id, { capital: a.capital || p.capital, ...(p.rank ? { rank: p.rank } : a.rank ? { rank: a.rank } : {}) });
    } else if (!taken.has(p.point.cell)) {
      taken.add(p.point.cell);
      sources.push({ id: p.point.id, point: true, cell: p.point.cell, country: territory(world, p.point.cell) });
    }
  }
  const owner = catchment(world, sources);
  const pop = causes.popTotal;
  const catchPop = new Float64Array(sources.length);
  const countryPop = new Map<number, number>();
  for (let i = 0; i < mesh.n; i++) {
    const p = pop?.[i] ?? 0;
    if (!(p > 0)) continue;
    const t = territory(world, i);
    countryPop.set(t, (countryPop.get(t) ?? 0) + p);
    if (owner[i] >= 0) catchPop[owner[i]] += p;
  }
  // 首都：国家档案里的首都格（城市的所属是这个国家时）
  const capitalCells = new Map<number, number>();
  for (const c of Object.values(small.countries ?? {})) if (c.capitalCell !== undefined) capitalCells.set(c.id, c.capitalCell);
  const isCapital = (s: Source) => s.country >= 0 && capitalCells.get(s.country) === s.cell;
  const u = Math.min(1, Math.max(0, worldEra(small)?.urbanization ?? 0.1));
  // 每个国家（按城市所在格的领土）里按大小分城市人口
  const weight = new Float64Array(sources.length);
  const group = new Map<number, number[]>();
  sources.forEach((s, q) => {
    const t = territory(world, s.cell);
    let w = Math.pow(catchPop[q], PRIMACY);
    if (isCapital(s) || (!s.point && attached.get(s.id)?.capital)) {
      const gov = s.country >= 0 ? governmentById(small, small.countries?.[s.country]?.government ?? '') : undefined;
      w *= CAPITAL_BOOST * Math.sqrt(Math.max(0.2, gov?.urbanization ?? 1));
    }
    weight[q] = w;
    let g = group.get(t);
    if (!g) group.set(t, (g = []));
    g.push(q);
  });
  const cityPop = new Float64Array(sources.length);
  for (const qs of group.values()) {
    let covered = 0;
    let sw = 0;
    for (const q of qs) {
      covered += catchPop[q];
      sw += weight[q];
    }
    const urban = u * covered;
    for (const q of qs) cityPop[q] = sw > 0 ? Math.min(0.95 * catchPop[q], (urban * weight[q]) / sw) : 0;
  }
  // 等级按比例、人数定的（不是首都、陪都，点没指定等级）：perCountry 的上限只管这些
  const byShare = new Uint8Array(sources.length);
  const list: CityInfo[] = sources.map((s, q) => {
    const meta = s.meta;
    const cap = isCapital(s);
    const at = !s.point ? attached.get(s.id) : undefined;
    const pt = s.point ? pts.find((p) => p.point.id === s.id) : undefined;
    const second = !cap && (!!at?.capital || !!pt?.capital);
    const total = countryPop.get(territory(world, s.cell)) ?? 0;
    const share = total > 0 ? cityPop[q] / total : 0;
    const pointRank = (at?.rank ?? pt?.rank) ? cityRankById(small, (at?.rank ?? pt?.rank)!) : undefined;
    const autoRank = cap ? capR : (pointRank ?? (second ? capR : rankFor(ranks, share, cityPop[q])));
    if (!cap && !pointRank && !second) byShare[q] = 1;
    const own = meta?.rank ? cityRankById(small, meta.rank) : undefined;
    const name = meta ? cityName(world, meta) : { zh: small.points![s.id].name, custom: true };
    return {
      id: s.id,
      ...(s.point ? { point: true as const } : {}),
      cell: s.cell,
      x: small.points?.[s.id] && s.point ? (small.points[s.id].x ?? mesh.x[s.cell]) : mesh.x[s.cell],
      y: small.points?.[s.id] && s.point ? (small.points[s.id].y ?? mesh.y[s.cell]) : mesh.y[s.cell],
      name: name.zh,
      ...(name.orig ? { orig: name.orig } : {}),
      customName: name.custom,
      rank: own ?? autoRank,
      rankAuto: !own,
      autoRank,
      country: s.country >= 0 && small.countries?.[s.country] ? s.country : null,
      countryAuto: meta?.country === undefined,
      capital: cap,
      secondCapital: second,
      population: cityPop[q],
      share,
      auto: !!meta?.auto,
      locked: !!meta?.locked,
    };
  });
  // 第二十六轮：写了 perCountry 的等级（大城市）每国最多“城市数 × perCountry”座，按人口取前几座，别的降到够得上的下一级
  const limited = ranks.filter((r) => r.perCountry !== undefined && !r.capital).sort((a, b) => b.level - a.level);
  if (limited.length) {
    for (const qs of group.values()) {
      const banned = new Set<string>();
      for (const r of limited) {
        banned.add(r.id);
        const max = Math.floor(qs.length * r.perCountry! + 1e-9);
        const hit = qs.filter((q) => byShare[q] && list[q].autoRank === r).sort((a, b) => list[b].population - list[a].population || list[a].id - list[b].id);
        if (hit.length <= max) continue;
        const rest = ranks.filter((x) => !banned.has(x.id));
        for (const q of hit.slice(max)) {
          const c = list[q];
          const nr = rankFor(rest.length ? rest : ranks, c.share, c.population);
          c.autoRank = nr;
          if (c.rankAuto) c.rank = nr;
        }
      }
    }
  }
  // 重名的（自动起的）换一个：重要的先占
  const order = list.map((_, q) => q).sort((a, b) => cmpInfo(list[a], list[b]));
  const used = new Set<string>();
  for (const q of order) {
    const c = list[q];
    if (c.customName || c.point) {
      used.add(c.name);
      continue;
    }
    let k = 0;
    while (used.has(c.name) && k < 6) {
      k++;
      const meta = small.cities![c.id];
      const n = cityName(world, meta, 1000 * k);
      c.name = n.zh;
      if (n.orig) c.orig = n.orig;
      else delete c.orig;
    }
    used.add(c.name);
  }
  const sorted = order.map((q) => list[q]);
  // owner 换成排好之后的下标
  const remap = new Int32Array(sources.length);
  order.forEach((q, k) => (remap[q] = k));
  for (let i = 0; i < owner.length; i++) if (owner[i] >= 0) owner[i] = remap[owner[i]];
  return { list: sorted, byId: new Map(sorted.filter((c) => !c.point).map((c) => [c.id, c])), owner, countryPop };
}

// 重要的在前：等级、人口、编号
export const cmpInfo = (a: CityInfo, b: CityInfo): number => b.rank.level - a.rank.level || b.population - a.population || a.id - b.id;

// 按世界缓存的城市表（界面、导出用）：城市、点、国家的首都与政体、人口、领土、内容都没变时照用上一份
const tableMemo = new WeakMap<object, { key: unknown[]; sig: string; table: CityTable }>();
export function cityTable(world: World): CityTable {
  const { small, causes, derived: d } = world;
  const key: unknown[] = [causes.popTotal, d.popDensity, causes.country, d.country, d.popCulture, small.content, small.provinces, small.nameStyle];
  const sig = JSON.stringify([small.cities, small.points, Object.values(small.countries ?? {}).map((c) => [c.id, c.capitalCell, c.government]), small.human?.era]);
  const m = tableMemo.get(world.mesh);
  if (m && m.sig === sig && m.key.every((v, k) => v === key[k])) return m.table;
  const table = computeCityTable(world);
  tableMemo.set(world.mesh, { key, sig, table });
  return table;
}

// 给界面的城市列表（重要的在前）
export const cityList = (world: World): CityInfo[] => cityTable(world).list;

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
  placeCities(S, { rules, keep: (c) => !fresh && (!c.auto || !!c.locked) });
  return Object.keys(S.world.small.cities ?? {}).length;
}

// ---------- 编辑 ----------

const isLand = (world: World, cell: number) => world.causes.land[cell] === 1;

export interface CityInput {
  name?: string;
  orig?: string;
  rank?: string;
}

export function addCity(world: World, cell: number, opts: CityInput = {}): number {
  if (!isLand(world, cell)) throw new CommandError('城市要在陆地上');
  if (cityAt(world, cell)) throw new CommandError('这一格已经有城市');
  if (opts.rank && !cityRankById(world.small, opts.rank)) throw new CommandError(`没有城市等级“${opts.rank}”`);
  const id = nextSettlementId(world);
  const c: CityMeta = { id, cell };
  if (opts.name?.trim()) {
    c.name = opts.name.trim();
    if (opts.orig?.trim()) c.orig = opts.orig.trim();
  }
  if (opts.rank) c.rank = opts.rank;
  (world.small.cities ??= {})[id] = c;
  return id;
}

// 删除城市：连着它的自动道路一起删，挂着它的点不再挂着
export function removeCity(world: World, id: number) {
  cityOf(world, id);
  delete world.small.cities![id];
  for (const [k, r] of Object.entries(world.small.roads ?? {})) {
    if (r.auto && (r.from === id || r.to === id)) delete world.small.roads![k];
    else {
      if (r.from === id) delete r.from;
      if (r.to === id) delete r.to;
    }
  }
  for (const p of Object.values(world.small.points ?? {})) if (p.attachedCity === id) delete p.attachedCity;
}

// 挪城市：是首都时首都跟着挪（新的格在同一个国家里；锁定首都）。连着它的道路由 roads.ts 的 rerouteCity 重走
export function moveCityCell(world: World, id: number, cell: number) {
  const c = cityOf(world, id);
  if (!isLand(world, cell)) throw new CommandError('城市要在陆地上');
  const other = cityAt(world, cell);
  if (other && other.id !== id) throw new CommandError('这一格已经有城市');
  const country = c.country ?? territory(world, c.cell);
  const m = country >= 0 ? world.small.countries?.[country] : undefined;
  if (m && m.capitalCell === c.cell && territory(world, cell) === country) {
    m.capitalCell = cell;
    m.capitalLocked = true;
  }
  c.cell = cell;
}

export interface CityPatch {
  name?: string;
  orig?: string;
  reroll?: true;
  rank?: string | null;
  country?: number | null;
  founded?: number | null;
  description?: string | null;
  notes?: string | null;
  locked?: boolean;
}

export function setCity(world: World, id: number, p: CityPatch): string[] {
  const c = cityOf(world, id);
  const what: string[] = [];
  if (p.name !== undefined) {
    const v = p.name.trim();
    if (v) {
      c.name = v;
      const o = p.orig?.trim();
      if (o) c.orig = o;
      else delete c.orig;
      what.push('改名');
    } else {
      delete c.name;
      delete c.orig;
      what.push('名字恢复自动');
    }
  }
  if (p.reroll) {
    delete c.name;
    delete c.orig;
    c.salt = (c.salt ?? 0) + 1;
    what.push('换一个名字');
  }
  if (p.rank !== undefined) {
    if (p.rank === null) delete c.rank;
    else {
      if (!cityRankById(world.small, p.rank)) throw new CommandError(`没有城市等级“${p.rank}”`);
      c.rank = p.rank;
    }
    what.push(p.rank === null ? '等级恢复自动' : '等级');
  }
  if (p.country !== undefined) {
    if (p.country === null) delete c.country;
    else {
      if (!world.small.countries?.[p.country]) throw new CommandError(`找不到国家 ${p.country}`);
      c.country = p.country;
    }
    what.push(p.country === null ? '所属恢复自动' : '所属');
  }
  const text = (key: 'description' | 'notes', v: string | null | undefined, label: string) => {
    if (v === undefined) return;
    if (v === null || !v.trim()) delete c[key];
    else c[key] = v;
    what.push(label);
  };
  text('description', p.description, '简介');
  text('notes', p.notes, '备注');
  if (p.founded !== undefined) {
    if (p.founded === null) delete c.founded;
    else c.founded = p.founded;
    what.push('建城年份');
  }
  if (p.locked !== undefined) {
    if (p.locked) c.locked = true;
    else delete c.locked;
    what.push(p.locked ? '锁定' : '解锁');
  }
  // 自己改过的自动城市在重新生成时也留着
  if (what.length && c.auto && (p.name !== undefined || p.rank !== undefined || p.country !== undefined)) delete c.auto;
  return what;
}

// ---------- 改地形之后、每步之后 ----------

// 离 cell 最近的陆地格（按步数；cell 本身是陆地就是它），occupied 里的跳过。没有时为 −1
export function nearestLand(world: World, cell: number, occupied?: Set<number>): number {
  const { mesh, causes } = world;
  if (causes.land[cell] && !occupied?.has(cell)) return cell;
  const seen = new Uint8Array(mesh.n);
  seen[cell] = 1;
  let q = [cell];
  while (q.length) {
    const next: number[] = [];
    for (const i of q) {
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (seen[j]) continue;
        seen[j] = 1;
        if (causes.land[j] && !occupied?.has(j)) return j;
        next.push(j);
      }
    }
    q = next.sort((a, b) => a - b);
  }
  return -1;
}

// 改了陆海之后（applyTerrain 里，只看原因）：变成海的格上的城市删掉（锁定的挪到最近的陆地）
export function repairCities(world: World): boolean {
  const cities = world.small.cities;
  if (!cities) return false;
  let changed = false;
  const occupied = new Set(Object.values(cities).map((c) => c.cell));
  for (const c of Object.values(cities).sort((a, b) => a.id - b.id)) {
    if (world.causes.land[c.cell]) continue;
    changed = true;
    occupied.delete(c.cell);
    const to = c.locked ? nearestLand(world, c.cell, occupied) : -1;
    if (to >= 0) {
      c.cell = to;
      occupied.add(to);
    } else removeCity(world, c.id);
  }
  return changed;
}

// 每步之后的整理（有城市时）：每个国家的首都格上都有一座城市（没有时补一座自动的），挂着、连着没了的城市的去掉
export function tidyCities(world: World) {
  const { small, causes } = world;
  if (!small.cities) return;
  const at = new Set(Object.values(small.cities).map((c) => c.cell));
  for (const m of Object.values(small.countries ?? {}).sort((a, b) => a.id - b.id)) {
    const cap = m.capitalCell;
    if (cap === undefined || !causes.land[cap] || at.has(cap)) continue;
    const id = nextSettlementId(world);
    small.cities[id] = { id, cell: cap, auto: true };
    at.add(cap);
  }
  for (const p of Object.values(small.points ?? {})) if (p.attachedCity !== undefined && !small.cities[p.attachedCity]) delete p.attachedCity;
  for (const r of Object.values(small.roads ?? {})) {
    if (r.from !== undefined && !small.cities[r.from]) delete r.from;
    if (r.to !== undefined && !small.cities[r.to]) delete r.to;
  }
}

// 去掉城市（与道路：道路连着城市）
export function clearCities(world: World) {
  delete world.small.cities;
  delete world.small.roads;
  for (const p of Object.values(world.small.points ?? {})) delete p.attachedCity;
}

// ---------- 档案 ----------

export interface CityArchive extends CityInfo {
  rankName: string;
  countryName?: string;
  // 管着的格里的人口构成（文化，按人数从多到少）
  cultures: { id: string; name: string; color: string; share: number }[];
  founded: number;
  foundedAuto: boolean;
  description: string;
  descriptionAuto: boolean;
  notes?: string;
  elevation: number;
  terrainClass?: string;
  coastal: boolean;
  river: boolean;
  province: number;
  provinceName?: string;
  // 连着的道路
  roads: number;
}

// 建城年份：首都是建国那年，别的在建国年份与时代的“现在”之间（按编号定）；无主的城市按时代的年份范围
function autoFounded(world: World, c: CityInfo): number {
  const era = worldEra(world.small);
  const [lo, hi] = era?.years ?? [500, 1000];
  const m = c.country !== null ? world.small.countries?.[c.country] : undefined;
  const start = m?.founded ?? Math.min(lo, hi);
  if (c.capital && m) return m.founded;
  const rand = mulberry32(mixSeed(seedOf(world), hashString('city:year'), c.id));
  const end = Math.max(lo, hi);
  return Math.round(start - 200 * rand() + Math.pow(rand(), 1.4) * Math.max(0, end - start));
}

export function popText(n: number): string {
  if (n >= 1e8) return `${(n / 1e8).toFixed(1)} 亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1)} 万`;
  return `${Math.round(n)}`;
}

// 简介（自动的）：“X 是 Y 的首都，位于 Z 河畔，人口约 N。”
function autoDescription(c: CityInfo, a: Pick<CityArchive, 'coastal' | 'river' | 'rankName' | 'countryName'>): string {
  const where = a.coastal && a.river ? '位于河口' : a.coastal ? '位于海边' : a.river ? '位于河畔' : '';
  const role = c.capital ? `${a.countryName ?? ''}的首都` : c.secondCapital ? `${a.countryName ?? ''}的陪都` : a.countryName ? `${a.countryName}的${a.rankName}` : `一座${a.rankName}`;
  const parts = [`${c.name}是${role}`];
  if (where) parts.push(where);
  if (c.population > 0) parts.push(`人口约 ${popText(c.population)}`);
  return `${parts.join('，')}。`;
}

// 每座城市管着的格里各文化的人数（一遍算完，按城市表缓存；“其他”不算）
const culturesMemo = new WeakMap<CityTable, Map<string, number>[]>();
function tableCultures(world: World, t: CityTable): Map<string, number>[] {
  let out = culturesMemo.get(t);
  if (out) return out;
  const { causes, small, mesh } = world;
  out = t.list.map(() => new Map<string, number>());
  if (causes.popTotal && causes.popGroup && causes.popShare) {
    for (let i = 0; i < mesh.n; i++) {
      const k = t.owner[i];
      if (k < 0) continue;
      const p = causes.popTotal[i];
      const m = out[k];
      for (let s = 0; s < 4; s++) {
        const g = causes.popGroup[i * 4 + s];
        if (!g) break;
        const tu = small.popGroups?.[g];
        if (tu) m.set(tu.culture, (m.get(tu.culture) ?? 0) + (p * causes.popShare[i * 4 + s]) / 255);
      }
    }
  }
  culturesMemo.set(t, out);
  return out;
}

// t：城市表（一次写很多座城市的档案时先算好传进来）
const indexMemo = new WeakMap<CityTable, Map<number, number>>();
export function cityArchive(world: World, id: number, t: CityTable = cityTable(world)): CityArchive | undefined {
  let idx = indexMemo.get(t);
  if (!idx) indexMemo.set(t, (idx = new Map(t.list.map((c, q) => [c, q] as const).filter(([c]) => !c.point).map(([c, q]) => [c.id, q]))));
  const k = idx.get(id) ?? -1;
  if (k < 0) return undefined;
  const c = t.list[k];
  const { small, causes, derived: d, mesh } = world;
  const meta = small.cities![id];
  // 管着的格里的文化
  const cult = tableCultures(world, t)[k];
  let all = 0;
  for (const v of cult.values()) all += v;
  const cultures = [...cult]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 6)
    .map(([cid, people]) => {
      const cu = (small.content?.culture as Record<string, { name: string; color: string }> | undefined)?.[cid];
      return { id: cid, name: cu?.name ?? cid, color: cu?.color ?? '#999999', share: all > 0 ? people / all : 0 };
    });
  let coastal = false;
  for (let e = mesh.off[c.cell]; e < mesh.off[c.cell + 1]; e++) if (!causes.land[mesh.adj[e]]) coastal = true;
  const river = d.discharge[c.cell] >= small.planet.riverThreshold && d.lake[c.cell] !== 1;
  const m = c.country !== null ? small.countries?.[c.country] : undefined;
  const pid = causes.province[c.cell];
  const base = {
    rankName: c.rank.name,
    ...(m ? { countryName: m.name } : {}),
    coastal,
    river,
  };
  let roads = 0;
  for (const r of Object.values(small.roads ?? {})) if (r.from === id || r.to === id || r.cells[0] === c.cell || r.cells[r.cells.length - 1] === c.cell) roads++;
  return {
    ...c,
    ...base,
    cultures,
    founded: meta.founded ?? autoFounded(world, c),
    foundedAuto: meta.founded === undefined,
    description: meta.description ?? autoDescription(c, base),
    descriptionAuto: meta.description === undefined,
    ...(meta.notes ? { notes: meta.notes } : {}),
    elevation: Math.round(d.elevation[c.cell]),
    ...(classAt(small, d.terrainClass[c.cell]) ? { terrainClass: classAt(small, d.terrainClass[c.cell])!.name } : {}),
    province: pid,
    ...(pid >= 0 && small.provinces[pid] ? { provinceName: small.provinces[pid].name } : {}),
    roads,
  };
}

// 每个国家的城市数与首都（首都、陪都的城市编号；首都在前）
export function countryCities(world: World): Map<number, { cities: number; capitals: number[] }> {
  const out = new Map<number, { cities: number; capitals: number[] }>();
  if (!world.small.cities && !world.small.points) return out;
  for (const c of cityTable(world).list) {
    if (c.country === null) continue;
    let e = out.get(c.country);
    if (!e) out.set(c.country, (e = { cities: 0, capitals: [] }));
    e.cities++;
    if (c.capital) e.capitals.unshift(c.id);
    else if (c.secondCapital) e.capitals.push(c.id);
  }
  return out;
}

export { isMajorRank };
