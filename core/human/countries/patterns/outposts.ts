import { hashString } from '../../../names';
import { mixSeed } from '../../../rng';
import type { SubjectKind } from '../../era';
import { makeFlag } from '../../flags';
import { titled } from '../../government';
import { COAST } from '../../rules';
import { distKm, noiseAt } from '../../space';
import { HeapLite } from '../../../mesh';
import { pickWeighted } from '../base';
import { mergeDetached } from '../cleanup';
import { type PatternModule, countOf, param } from '../patterns';
import type { CountryRun, Seed } from '../state';
import { colonyColor } from './colonies';
import { bestCell, claimRegion, freeCell, releaseRegion, seedAt, tierNear } from './common';

// 殖民据点与公司领地（第七十五轮，科幻）：本地种族的国家之间散着一些很小的据点，归外来的公司或殖民政府管。
// 用殖民地（colonies.ts）的那一套：一个据点一片（Region：只有它进、它也不出去占能住人的地方）、Seed.overseas（隔海的也留着）、
// 宗主的浅色（colonyColor）、名字是宗主的地名 + 称号（锁定）、从属的种类（CountryMeta.subject：公司领地 company 或殖民地 colony）。
// 本族：能住人的分量最大的文化组（科幻里通常是人类）；据点放在别的文化组住的地方（本地种族之间；只有一个文化组时哪里都行），
//   挨着海的格优先，彼此隔开（不近于 √(能住人的面积 ÷ 个数) 的一半）。
// reserve：放据点（多少：几个；小数是再多一个的可能，随机流 'outposts'），每个 spot 个平均的国家大；
// grow：据点只在圈给它的那一片里长（不出去占宜居度低的荒地）；
// after：整理（“住满”的时代把没长到的陆地给最近的国家）以后，据点那一片以外的格归最近的别的国家（周围的本地国家；够不着的才留给据点），
//   所以据点不会比圈的大多少；
// diplomacy（附庸、殖民地之后）：本族里最大、不是附庸的 powers 国是宗主，每个据点按面积挑一个（随机流 'outposts:lord'），
//   company 的可能是公司领地（“X贸易公司领地”……），不然是殖民据点（殖民地：“X殖民据点”……）（随机流 'outposts:company'）

export const OUTPOSTS = 'outposts';
const MIN_COUNTRIES = 4;
// 名字（同一个宗主的按先后；都用过了写“宗主属当地”）
const COMPANY_TITLES = [
  { zh: '{name}贸易公司领地', orig: '{name} Trading Company' },
  { zh: '{name}开拓公司领地', orig: '{name} Development Company' },
  { zh: '{name}矿业公司领地', orig: '{name} Mining Company' },
  { zh: '{name}航运公司领地', orig: '{name} Shipping Company' },
];
const COLONY_TITLES = [
  { zh: '{name}殖民据点', orig: '{name} Outpost' },
  { zh: '{name}前哨站', orig: '{name} Station' },
  { zh: '{name}开拓站', orig: '{name} Settlement' },
];

interface OutpostState {
  seeds: Seed[];
  // 本族（ctx.groups 的下标）
  home: number;
}

// 能住人的分量最大的文化组
function homeGroup(g: CountryRun): number {
  const G = g.ctx.groups.length;
  const mass = new Float64Array(G);
  for (let c = 0; c < g.K; c++) mass[g.ctx.cultureGroup[c]] += g.massC[c];
  let best = -1;
  for (let gr = 0; gr < G; gr++) if (mass[gr] > 0 && (best < 0 || mass[gr] > mass[best])) best = gr;
  return best;
}

// 据点那一片以外的格归最近的别的国家：从别国的国境往外按 km 走这些格。返回挪了几格
export function trimOutposts(g: CountryRun, st: Pick<OutpostState, 'seeds'>): number {
  const { owner, region, seeds, world } = g;
  const { mesh, kmPerUnit, causes } = world;
  const mine = new Int32Array(seeds.length).fill(-1);
  for (const sd of st.seeds) {
    const o = seeds.indexOf(sd);
    if (o >= 0) mine[o] = sd.region;
  }
  // 据点占着、又不在它那一片里的格
  const extra = (i: number) => owner[i] >= 0 && mine[owner[i]] >= 0 && region[i] !== mine[owner[i]];
  const dist = new Float64Array(g.n).fill(Infinity);
  const to = new Int32Array(g.n).fill(-1);
  const heap = new HeapLite(1024);
  for (let i = 0; i < g.n; i++) {
    const o = owner[i];
    if (o < 0 || mine[o] >= 0 || !causes.land[i]) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++)
      if (extra(mesh.adj[e])) {
        dist[i] = 0;
        to[i] = o;
        heap.push(i, 0);
        break;
      }
  }
  while (heap.size) {
    const i = heap.pop();
    const di = heap.lastKey;
    if (di > dist[i]) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (!causes.land[j] || !extra(j)) continue;
      const nd = di + mesh.dist[e] * kmPerUnit;
      if (nd >= dist[j]) continue;
      dist[j] = nd;
      to[j] = to[i];
      heap.push(j, nd);
    }
  }
  let moved = 0;
  for (let i = 0; i < g.n; i++)
    if (to[i] >= 0 && extra(i)) {
      owner[i] = to[i];
      moved++;
    }
  if (moved) mergeDetached(g);
  return moved;
}

export const outposts: PatternModule = {
  id: OUTPOSTS,
  name: '殖民据点',
  description: '本地种族的国家之间散着一些很小的据点，归外来的公司或殖民政府管',
  amountHint: '几个；小数是再多一个的可能',
  tip: '科幻：本地国家之间散着公司领地和殖民据点，地图上用宗主的浅色',
  roles: { [OUTPOSTS]: '殖民据点' },
  params: [
    { key: 'spot', label: '每个多大', min: 0.05, max: 2, step: 0.05, default: 0.2, hint: '一个据点是几个平均的国家大' },
    { key: 'powers', label: '几个宗主', min: 1, max: 8, step: 1, default: 3, hint: '本族最大的几国分据点' },
    { key: 'company', label: '公司的几成', min: 0, max: 1, step: 0.05, default: 0.6, hint: '据点几成是公司领地' },
  ],

  reserve(g, use) {
    if (!(use.amount > 0) || g.total < MIN_COUNTRIES) return;
    const rand = g.stream(OUTPOSTS);
    const want = countOf(use.amount, rand());
    if (!want) return;
    const { ctx, world } = g;
    const { x, hab } = ctx;
    const cultureOf = ctx.cultureOf!;
    const home = homeGroup(g);
    if (home < 0) return;
    // 本地种族的地方（只有一个文化组时哪里都行）
    const natives = ctx.groups.length > 1;
    const ok = (i: number) => freeCell(g, i) && (!natives || ctx.cultureGroup[cultureOf[i]] !== home);
    const target = param(this, use, 'spot') * g.T;
    const gap = 0.5 * Math.sqrt(g.area / want);
    const st: OutpostState = { seeds: [], home };
    const centers: number[] = [];
    for (let q = 0; q < want && g.rest > 2; q++) {
      const ns = g.mix('outposts-center', q);
      const far = (i: number) => centers.every((c) => distKm(world, c, i) >= gap);
      const center = bestCell(g, (i) => ok(i) && far(i), (i) => hab[i] * ((x.flags[i] & COAST) !== 0 ? 1.5 : 1) * (1 + 0.35 * noiseAt(world, ns, 400, i)));
      if (center < 0) break;
      centers.push(center);
      const k0 = g.regions.length;
      const { cells, got } = claimRegion(g, center, target, k0, ok);
      if (got < 0.3 * target) {
        releaseRegion(g, cells);
        continue;
      }
      const seed = seedAt(g, center, tierNear(g, got / g.T), got, k0, rand);
      seed.overseas = true;
      seed.role = OUTPOSTS;
      g.isSeed[center] = 1;
      g.regions.push({ pattern: OUTPOSTS, group: ctx.cultureGroup[seed.culture], seeds: [seed] });
      st.seeds.push(seed);
      g.rest -= 1;
    }
    if (st.seeds.length) g.state.set(OUTPOSTS, st);
  },

  // 据点只在自己的那一片里长
  grow(g) {
    const st = g.state.get(OUTPOSTS) as OutpostState | undefined;
    if (!st) return;
    const mine = new Int32Array(g.seeds.length).fill(-1);
    for (const sd of st.seeds) {
      const o = g.seeds.indexOf(sd);
      if (o >= 0) mine[o] = sd.region;
    }
    const region = g.region;
    g.stepCost.push((o, j, c) => (mine[o] >= 0 && region[j] !== mine[o] ? Infinity : c));
  },

  // 据点那一片以外的格（住满、并进来的小块）归最近的别的国家
  after(g) {
    const st = g.state.get(OUTPOSTS) as OutpostState | undefined;
    if (st) trimOutposts(g, st);
  },

  // 附庸、殖民地定完以后：宗主、公司还是殖民政府、名字、颜色
  diplomacy(g, use) {
    const st = g.state.get(OUTPOSTS) as OutpostState | undefined;
    if (!st) return;
    const { seeds } = g;
    const metas = g.metas!;
    const areaOf = g.areaOf!;
    const overlord = g.overlord!;
    const want = Math.max(1, Math.round(param(this, use, 'powers')));
    const lords = seeds
      .map((_, o) => o)
      .filter((o) => seeds[o].region < 0 && overlord[o] < 0 && g.primGroup[o] === st.home && areaOf[o] > 0)
      .sort((a, b) => areaOf[b] - areaOf[a] || a - b)
      .slice(0, want);
    if (!lords.length) return;
    const pc = param(this, use, 'company');
    const names = new Set(metas.map((m) => m.name));
    const colors = new Set(metas.map((m) => m.color));
    const count = new Map<string, number>();
    st.seeds.forEach((sd, q) => {
      const c = seeds.indexOf(sd);
      if (c < 0 || !(areaOf[c] > 0)) return;
      const lord = pickWeighted(lords, (o) => areaOf[o], g.stream('outposts:lord', q))!;
      const kind: SubjectKind = g.stream('outposts:company', q)() < pc ? 'company' : 'colony';
      overlord[c] = lord;
      const m = metas[c];
      const p = metas[lord];
      m.overlord = p.id;
      m.subject = kind;
      const key = `${lord}:${kind}`;
      const t = count.get(key) ?? 0;
      count.set(key, t + 1);
      const titles = kind === 'company' ? COMPANY_TITLES : COLONY_TITLES;
      names.delete(m.name);
      const base = p.base?.zh ? p.base : { zh: p.name };
      let name = t < titles.length ? titled(base, titles[t]) : undefined;
      if (!name || names.has(name.zh)) name = { zh: `${base.zh}属${m.base.zh}` };
      m.name = name.zh;
      if (name.orig) m.orig = name.orig;
      else delete m.orig;
      names.add(m.name);
      colors.delete(m.color);
      m.color = colonyColor(p.color, q, colors);
      m.flag = makeFlag(mixSeed(g.seed, hashString('flag'), m.id), m.color, { categories: sd.gov.category, layouts: sd.gov.layouts, emblems: sd.gov.emblems });
      m.nameLocked = true;
    });
  },
};
