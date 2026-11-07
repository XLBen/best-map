import { HeapLite } from '../../../mesh';
import { type Species, biomeGroupOf } from '../../../species';
import type { Government } from '../../government';
import { cellKm2 } from '../../space';
import type { CountryTierDef } from '../../tiers';
import { NOBODY } from '../base';
import { landComponents } from '../count';
import { mergeDetached } from '../cleanup';
import { govFit, govWeights, pickGov } from '../seeds';
import type { CountryRun, Seed } from '../state';

// 格局模块共用的几件事（第七十四轮）：圈一片地方、在里面撒起点、挑等级与政体、陆块与本土；长完以后在 g.owner 上合并、切开、压紧

// ---------- 圈地方（reserve 钩子） ----------

// 能圈进预留的地方的格：干的、有文化、锁定的国家没占、宜居度够、还没被别的格局圈
export const freeCell = (g: CountryRun, i: number): boolean => g.ctx.x.dry[i] === 1 && g.country[i] < 0 && g.ctx.hab[i] >= g.minH && g.region[i] < 0 && g.ctx.cultureOf![i] >= 0;

// 从 center 按距离（km × cost(j)）往外圈，ok 的格才进，圈到 target km² 停；圈到的格在 g.region 里记成 k
export function claimRegion(g: CountryRun, center: number, target: number, k: number, ok: (i: number) => boolean, cost?: (i: number) => number): { cells: number[]; got: number } {
  const { world, region } = g;
  const { mesh } = world;
  const km = world.kmPerUnit;
  const dist = new Map<number, number>();
  const heap = new HeapLite(1024);
  const cells: number[] = [];
  let got = 0;
  dist.set(center, 0);
  heap.push(center, 0);
  while (heap.size && got < target) {
    const i = heap.pop();
    const di = heap.lastKey;
    if (di > dist.get(i)! || region[i] >= 0) continue;
    region[i] = k;
    cells.push(i);
    got += cellKm2(world, i);
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (region[j] >= 0 || !ok(j)) continue;
      const nd = di + mesh.dist[e] * km * (cost ? cost(j) : 1);
      if (nd < (dist.get(j) ?? Infinity)) {
        dist.set(j, nd);
        heap.push(j, nd);
      }
    }
  }
  return { cells, got };
}

// 不要圈到的这一片
export function releaseRegion(g: CountryRun, cells: readonly number[]): void {
  for (const i of cells) g.region[i] = -1;
}

// 在一片地方（region 里是 k0 的格）里撒 count 个起点：从 first 起，一个个挑离已有的起点、离这一片的边都远（宜居度高的优先）的格。
// make 建这一个起点（第 s 个、哪一格）。第二十六轮的邦联（神圣帝国）原样搬来，城邦群也用它。
// edges false：不管离边远不远（城邦群：一条窄的海岸上几乎都是边上的格，城邦本来就在海边）
export function scatterSeeds(g: CountryRun, cells: readonly number[], k0: number, first: number, count: number, make: (s: number, cell: number) => Seed, edges = true): Seed[] {
  const { world, region, isSeed } = g;
  const { hab } = g.ctx;
  const { mesh } = world;
  const n = g.n;
  const heap = new HeapLite(1024);
  const minD = new Float64Array(n).fill(Infinity);
  const edgeD = new Float64Array(n).fill(Infinity);
  heap.size = 0;
  if (edges) {
    for (const i of cells) {
      let rim = false;
      for (let e = mesh.off[i]; e < mesh.off[i + 1] && !rim; e++) if (region[mesh.adj[e]] !== k0) rim = true;
      if (!rim) continue;
      edgeD[i] = 0;
      heap.push(i, 0);
    }
    while (heap.size) {
      const i = heap.pop();
      const di = heap.lastKey;
      if (di > edgeD[i]) continue;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (region[j] !== k0) continue;
        const nd = di + mesh.dist[e] * world.kmPerUnit;
        if (nd < edgeD[j]) {
          edgeD[j] = nd;
          heap.push(j, nd);
        }
      }
    }
  }
  const list: Seed[] = [];
  let pick = first;
  for (let s = 0; s < count && pick >= 0; s++) {
    isSeed[pick] = 1;
    list.push(make(s, pick));
    // 离起点的距离（只在这一片里走）
    heap.size = 0;
    minD[pick] = 0;
    heap.push(pick, 0);
    while (heap.size) {
      const i = heap.pop();
      const di = heap.lastKey;
      if (di > minD[i]) continue;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (region[j] !== k0) continue;
        const nd = di + mesh.dist[e] * world.kmPerUnit;
        if (nd < minD[j]) {
          minD[j] = nd;
          heap.push(j, nd);
        }
      }
    }
    pick = -1;
    let best = 0;
    for (const i of cells) {
      if (isSeed[i]) continue;
      const v = (edges ? Math.min(minD[i], 2 * edgeD[i]) : minD[i]) * Math.sqrt(Math.max(hab[i], 0.01));
      if (v > best) {
        best = v;
        pick = i;
      }
    }
  }
  return list;
}

// 预算按这一片的面积分（先记的是等级的倍数）
export function shareBudget(list: readonly Seed[], got: number): void {
  let wSum = 0;
  for (const sd of list) wSum += sd.budget;
  for (const sd of list) sd.budget *= got / wSum;
}

// ---------- 等级、政体、起点 ----------

// 面积倍数最大、最小的一级；与倍数 m 最近的一级（按对数）
export const biggestTier = (g: CountryRun): CountryTierDef => g.tierList.reduce((a, b) => (b.area > a.area ? b : a));
export const smallestTier = (g: CountryRun): CountryTierDef => g.tierList.reduce((a, b) => (b.area < a.area ? b : a));
export function tierNear(g: CountryRun, m: number): CountryTierDef {
  let best = g.tierList[0];
  let bd = Infinity;
  for (const t of g.tierList) {
    const d = Math.abs(Math.log(Math.max(t.area, 1e-6) / Math.max(m, 1e-6)));
    if (d < bd) {
      bd = d;
      best = t;
    }
  }
  return best;
}

// 一格上的一个起点：按这一格的文化挑政体（文化的倾向 × 与等级相配 × bias）。region：预留的地方的下标（不在为 −1）
export function seedAt(g: CountryRun, cell: number, tier: CountryTierDef, budget: number, region: number, rand: () => number, bias?: (gv: Government) => number): Seed {
  const c = g.ctx.cultureOf![cell];
  const culture = g.ctx.cultures[c];
  const w = govWeights(g.world, g.ctx.era, culture, g.govs);
  const gov = pickGov(g.govs, (gv) => w(gv) * govFit(gv, tier) * (bias ? bias(gv) : 1), rand);
  return { cell, culture: c, gov, tier, budget, region };
}

// 一片里最好的一格（score 最大的；没有时 −1）
export function bestCell(g: CountryRun, ok: (i: number) => boolean, score: (i: number) => number): number {
  let best = -1;
  let bs = -Infinity;
  for (let i = 0; i < g.n; i++) {
    if (!ok(i)) continue;
    const s = score(i);
    if (s > bs) {
      bs = s;
      best = i;
    }
  }
  return best;
}

// 只在挑普通起点时占着的一片（Region.open）：从 center 圈 core km²（ok 的格），起点不在这一片里（region −1），往外长之前放开
export function openCore(g: CountryRun, pattern: string, seed: Seed, core: number, ok: (i: number) => boolean, cost?: (i: number) => number): void {
  const k = g.regions.length;
  claimRegion(g, seed.cell, core, k, ok, cost);
  g.isSeed[seed.cell] = 1;
  g.regions.push({ pattern, group: g.ctx.cultureGroup[seed.culture], seeds: [seed], open: true });
}

// ---------- 陆块与本土 ----------

export interface Lands {
  // 每格是第几块（海 −1）
  id: Int32Array;
  // 每块能住人的分量（面积 × 宜居度）、能住人的面积（干的、宜居度够的）
  mass: Float64Array;
  area: Float64Array;
}

// 陆块与各块的分量（一次生成算一次）
export function lands(g: CountryRun): Lands {
  const had = g.state.get('lands') as Lands | undefined;
  if (had) return had;
  const { world, minH } = g;
  const { x, hab } = g.ctx;
  const { id } = landComponents(world);
  let K = 0;
  for (let i = 0; i < g.n; i++) if (id[i] >= K) K = id[i] + 1;
  const mass = new Float64Array(K);
  const area = new Float64Array(K);
  for (let i = 0; i < g.n; i++) {
    if (!x.dry[i] || hab[i] < minH) continue;
    const a = cellKm2(world, i);
    mass[id[i]] += a * hab[i];
    area[id[i]] += a;
  }
  const out = { id, mass, area };
  g.state.set('lands', out);
  return out;
}

// 本土：能住人的分量最大的 homes 块（人口跟着宜居度走，这一步还没有人口；第二块不到第一块的三成时不算）
export function homeLands(g: CountryRun, homes: number): number[] {
  const { mass } = lands(g);
  const order = [...mass.keys()].sort((a, b) => mass[b] - mass[a] || a - b);
  const out = order.slice(0, 1);
  for (let k = 1; k < Math.round(homes) && k < order.length; k++) if (mass[order[k]] >= 0.3 * mass[order[0]]) out.push(order[k]);
  return mass.length && mass[order[0]] > 0 ? out : [];
}

// ---------- 生态 ----------

// 草原、荒漠的生态（导出用的地形是草原，或大类是荒漠；按世界里的生态，不写死 id）
export function steppeSpecies(species: readonly Pick<Species, 'group' | 'terrain'>[]): Uint8Array {
  return Uint8Array.from(species, (sp) => (biomeGroupOf(sp) === 'desert' || sp.terrain === 'steppe' ? 1 : 0));
}

// ---------- 长完以后（after 钩子）：g.owner 上的合并、切开 ----------

// 各国的干陆地面积（km²）
export function ownerArea(g: CountryRun): Float64Array {
  const out = new Float64Array(g.seeds.length);
  const { owner, world } = g;
  const dry = g.ctx.x.dry;
  for (let i = 0; i < g.n; i++) if (owner[i] >= 0 && dry[i]) out[owner[i]] += cellKm2(world, i);
  return out;
}

// 陆上挨着的国家（seeds 的下标，从小到大）
export function ownerNeighbours(g: CountryRun): number[][] {
  const { owner, world } = g;
  const { mesh, causes } = world;
  const sets = g.seeds.map(() => new Set<number>());
  for (let i = 0; i < g.n; i++) {
    const a = owner[i];
    if (a < 0 || !causes.land[i]) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const b = owner[mesh.adj[e]];
      if (b >= 0 && b !== a && causes.land[mesh.adj[e]]) sets[a].add(b);
    }
  }
  return sets.map((s) => [...s].sort((a, b) => a - b));
}

// 长完以后加一个起点（切出来的国家）：各国的宜居度下限、陆块、主流文化组跟着加。返回它的下标
export function addSeed(g: CountryRun, s: Seed): number {
  const o = g.seeds.length;
  g.seeds.push(s);
  const grow = <T extends Float64Array | Int32Array>(a: T, v: number): T => {
    const b = new (a.constructor as new (n: number) => T)(o + 1);
    b.set(a);
    b[o] = v;
    return b;
  };
  g.thr = grow(g.thr, Math.max(NOBODY, g.minH * (1 - s.gov.nomadic)));
  g.home = grow(g.home, g.compOf[s.cell]);
  g.primGroup = grow(g.primGroup, g.ctx.cultureGroup[s.culture]);
  return o;
}

// 并国：into[o] 是 o 并进的那一国（自己时不动；可以一串：a → b → c）。格归过去、并掉的起点去掉（下标压紧），再整理一遍飞地
export function mergeOwners(g: CountryRun, into: Int32Array): number {
  const k = g.seeds.length;
  const root = (o: number) => {
    let r = o;
    for (let t = 0; t < k && into[r] !== r; t++) r = into[r];
    return r;
  };
  const to = Int32Array.from({ length: k }, (_, o) => root(o));
  let merged = 0;
  for (let o = 0; o < k; o++) if (to[o] !== o) merged++;
  if (!merged) return 0;
  const { owner } = g;
  for (let i = 0; i < g.n; i++) if (owner[i] >= 0) owner[i] = to[owner[i]];
  dropSeeds(g, (o) => to[o] !== o);
  return merged;
}

// 去掉一些起点（没有格了的、并掉的）：owner、seeds、各国的宜居度下限、陆块、主流文化组一起压紧，再整理一遍飞地
export function dropSeeds(g: CountryRun, dead: (o: number) => boolean): void {
  const k = g.seeds.length;
  const map = new Int32Array(k).fill(-1);
  let m = 0;
  for (let o = 0; o < k; o++) if (!dead(o)) map[o] = m++;
  if (m === k) {
    mergeDetached(g);
    return;
  }
  const { owner } = g;
  for (let i = 0; i < g.n; i++) if (owner[i] >= 0) owner[i] = map[owner[i]];
  const keep = (o: number) => map[o] >= 0;
  g.seeds = g.seeds.filter((_, o) => keep(o));
  g.thr = g.thr.filter((_, o) => keep(o));
  g.home = g.home.filter((_, o) => keep(o));
  g.primGroup = g.primGroup.filter((_, o) => keep(o));
  mergeDetached(g);
}

// 能拿来合并、切开的国家：不在预留的地方里（神圣帝国的诸侯、城邦群、殖民地），不是多民族的大国
export const plainSeed = (s: Seed): boolean => s.region < 0 && !s.multiethnic;
