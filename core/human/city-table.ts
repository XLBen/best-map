// 城市现算的几项（第八十三轮从 core/human/settlements.ts 原样搬出）：等级、人口、所属、名字；一格的城市、新编号
import type { World, CityMeta, PointMeta } from '../world';
import { CommandError } from '../errors';
import type { CityRank } from './settle-types';
import { type GenName, styleFor, hasType, styleName } from '../name-styles';
import { hashString } from '../names';
import { classAt } from './terrain-class';
import { pointTypeById, worldCityRanks, capitalRank, cityRankById, rankFor } from './settle-content';
import { HeapLite } from '../mesh';
import { worldEra } from './era';
import { governmentById } from './government';
import { arraysToken } from '../world-token';
import { isPortCell } from './ports';

// 一座城市管多远：格距的这么多倍
const CATCH_CELLS = 4;
// 城市的人口按管着的人口的这次方拉开
const PRIMACY = 1.15;
// 首都的人口倍数（再乘政体的城市化）
const CAPITAL_BOOST = 1.8;

export const seedOf = (world: World) => world.small.settlementRules?.seed ?? world.small.human?.seed ?? world.small.terrain.gen?.seed ?? world.settings.seed;

// 下一个编号（城市、道路、地标、自定义点共用）
export function nextSettlementId(world: World): number {
  const id = Math.max(1, world.small.nextSettlement ?? 1);
  world.small.nextSettlement = id + 1;
  return id;
}

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
  // 港口（第八十四轮：在避风的海岸上，见 ports.ts 的 isPortCell）
  port: boolean;
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
export const territory = (world: World, cell: number): number => world.causes.country?.[cell] ?? -1;

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
      port: isPortCell(world, s.cell),
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

// 按世界缓存的城市表（界面、导出用）：城市、点、国家的首都与政体、人口、领土、内容都没变时照用上一份。
// 第八十轮：主线程上没变的数组沿用同一个对象（以前每份快照都是新的副本，键里的数组每次都变）：数组按“这一批”（arraysToken：
// 陆海、湖、流量、高程、气温、地形类别……城市的管辖、名字读的都在里面），另加名字读的河流门槛（planet）、种子（terrain）、时代（human）
const tableMemo = new WeakMap<object, { key: unknown[]; sig: string; table: CityTable }>();
export function cityTable(world: World): CityTable {
  const { small, causes, derived: d } = world;
  const key: unknown[] = [causes.popTotal, d.popDensity, causes.country, d.country, d.popCulture, small.content, small.provinces, small.nameStyle, arraysToken(world), small.planet, small.terrain, small.human, world.kmPerUnit];
  const sig = JSON.stringify([small.cities, small.points, Object.values(small.countries ?? {}).map((c) => [c.id, c.capitalCell, c.government]), small.human?.era]);
  const m = tableMemo.get(world.mesh);
  if (m && m.sig === sig && m.key.every((v, k) => v === key[k])) return m.table;
  const table = computeCityTable(world);
  tableMemo.set(world.mesh, { key, sig, table });
  return table;
}

// 给界面的城市列表（重要的在前）
export const cityList = (world: World): CityInfo[] => cityTable(world).list;
