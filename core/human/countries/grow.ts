import { HeapLite } from '../../mesh';
import { genEdgeCosts } from '../cultures';
import { registerGenCache, viewKey } from '../gen-cache';
import type { Government } from '../government';
import { COAST, RIVER } from '../rules';
import { cellKm2 } from '../space';
import { NOBODY } from './base';
import type { CountryRun } from './state';

// 各国从起点往外长（第二十三轮；第二十六轮分两遍）。第七十三轮从 countries.ts 搬来（原样），
// 多了两处给格局用的：预留的地方（g.region，第七十二轮以前只有邦联）、grow 钩子加的代价（g.stepCost，没有时不走）

// 第二遍最多长到预算的几倍（第二十六轮）
export const FREE_MUL = 4;
// 第二遍长到的总量最多占能住人的地方的几成
const MAX_FREE = 0.16;
// 能住人的地方以外的干陆地（荒漠、山、苔原）算进预算的比例
const LOW_HAB_WEIGHT = 0.5;

// 越过文化的边界的代价倍数（扩张性弱的更难）：进同一文化组的别的文化、进别的文化组。第七十四轮的多民族大国按它们的比放宽
export const sameCultureMul = (gv: Pick<Government, 'expansion'>): number => 1 + 0.6 * (1 - gv.expansion);
export const otherCultureMul = (gv: Pick<Government, 'expansion'>): number => 1 + 2.5 * (1 - gv.expansion);

// 第八十四轮：国界顺着大河、山脊走——往外长时走一条边再乘的倍数（与 mesh.adj 对齐，1 是不加）：
//   过大河：从流量 ≥ MAJOR_RIVER × 画河的门槛的河格走到岸上（不是河的格），1 + 2.5 × min(1, 0.4 + 0.3 · lg(流量 ÷ 门槛 ÷ MAJOR_RIVER))，
//     先到河边的一国占着河，对岸归另一国；顺着河走（河格到河格）不加；
//   翻分水岭：两格在不同的流域、两边都高过 RIDGE_FROM m 时 1 + 2 × min(1, (较低的一边 − RIDGE_FROM) ÷ 1200)。
// 常数写在这里（不进时代包）
const MAJOR_RIVER = 2;
// 不按山河长的格局里的国家（Seed.role；按模块里的常数写，不引用它们，免得绕成圈）：大河帝国顺着河、集权帝国与多民族帝国跨过山河、
// 汗国在草原上游荡、种族王国按森林 / 山地 / 荒原圈地
const FREE_ROLES = ['river-empire', 'central-empire', 'multiethnic', 'khanate'];
const freeRole = (role: string | undefined) => !!role && (FREE_ROLES.includes(role) || role.startsWith('race-realms:'));
const RIDGE_FROM = 300;
// 上一次的结果（重新生成国家时河、流域、高程都没变：照用；键按内容比，见 gen-cache.ts）
let lastCross: { mesh: unknown; key: string; out: Float32Array } | null = null;
registerGenCache(() => (lastCross = null));
export function crossingCosts(g: Pick<CountryRun, 'ctx' | 'world'>): Float32Array {
  const { ctx, world } = g;
  const { x, d } = ctx;
  const key = [world.small.planet.riverThreshold, viewKey(x.dry), viewKey(x.flags), viewKey(d.elevation), viewKey(d.basin), viewKey(d.discharge)].join('|');
  if (lastCross && lastCross.mesh === world.mesh && lastCross.key === key) return lastCross.out;
  const out = crossingFresh(g);
  lastCross = { mesh: world.mesh, key, out };
  return out;
}

function crossingFresh(g: Pick<CountryRun, 'ctx' | 'world'>): Float32Array {
  const { ctx, world } = g;
  const { x, d } = ctx;
  const { mesh } = world;
  const thr = world.small.planet.riverThreshold;
  const big = MAJOR_RIVER * thr;
  const out = new Float32Array(mesh.adj.length).fill(1);
  const elev = x.elevation;
  const basin = d.basin;
  const q = d.discharge;
  for (let i = 0; i < mesh.n; i++) {
    if (!x.dry[i]) continue;
    const river = (x.flags[i] & RIVER) !== 0 && q[i] >= big ? 1 + 4 * Math.min(1, 0.35 + 0.35 * Math.log10(q[i] / big)) : 1;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (!x.dry[j]) continue;
      let m = 1;
      if (river > 1 && !(x.flags[j] & RIVER)) m = river;

      if (basin[i] !== basin[j]) {
        const low = Math.min(elev[i], elev[j]);
        if (low > RIDGE_FROM) m *= 1 + 5 * Math.min(1, (low - RIDGE_FROM) / 1200);
      }
      out[e] = m;
    }
  }
  return out;
}

function withCrossing(edge: Float32Array, cross: Float32Array): Float32Array {
  const out = new Float32Array(edge.length);
  for (let e = 0; e < edge.length; e++) out[e] = edge[e] * cross[e];
  return out;
}

export function growOwners(g: CountryRun) {
  const { ctx, world, seeds, country, minH, region, T, area } = g;
  const { x, hab, d } = ctx;
  const cultureOf = ctx.cultureOf!;
  const { mesh, causes } = world;
  const n = g.n;
  const k = seeds.length;
  const rand = g.stream('country:grow');
  const speed = new Float64Array(k);
  // 这一遍用的快慢（第二遍拉平）
  const spd = new Float64Array(k);
  const R = new Float64Array(k);
  // 这一遍用的范围（第二遍小国也走得远一些）
  const Rp = new Float64Array(k);
  const cap = new Float64Array(k);
  const thr = new Float64Array(k);
  const sameMul = new Float64Array(k);
  const otherMul = new Float64Array(k);
  const coastMul = new Float64Array(k);
  const seaMul = new Float64Array(k);
  const coh = new Float64Array(k);
  const prim = new Int32Array(k);
  const primGroup = new Int32Array(k);
  const budget = new Float64Array(k);
  // 起点所在的陆块、所在的预留地方（−1：不在）
  const home = new Int32Array(k);
  const conf = new Int32Array(k);
  const comps = g.compOf;
  seeds.forEach((s, o) => {
    const gv = s.gov;
    // 第二十六轮：快慢、范围按面积预算（等级），倾向仍按政体
    speed[o] = spd[o] = Math.sqrt(s.budget / T) * (0.85 + 0.3 * rand());
    R[o] = Rp[o] = Math.sqrt(s.budget / Math.PI);
    cap[o] = 20 * R[o];
    thr[o] = Math.max(NOBODY, minH * (1 - gv.nomadic));
    sameMul[o] = sameCultureMul(gv);
    otherMul[o] = otherCultureMul(gv);
    coastMul[o] = 1 + 3 * gv.coastal;
    // 下海：紧凑的、不靠海的更难，游牧的几乎不下海
    seaMul[o] = (1 + 2 * gv.cohesion) * (1 + 2 * (1 - gv.coastal)) * (1 + 6 * gv.nomadic);
    coh[o] = gv.cohesion;
    prim[o] = s.culture;
    primGroup[o] = ctx.cultureGroup[s.culture];
    budget[o] = s.budget;
    home[o] = comps[s.cell];
    conf[o] = s.region;
  });
  const base = genEdgeCosts(ctx);
  // 第八十四轮：过大河、翻分水岭贵一些（g.cross，见 crossingCosts）；格局里不按山河长的国家不加（FREE_ROLES）
  const crossed = g.cross ? withCrossing(base, g.cross) : base;
  const plainEdge = new Uint8Array(k);
  seeds.forEach((s, o) => (plainEdge[o] = freeRole(s.role) ? 1 : 0));
  const owner = new Int32Array(n).fill(-1);
  const dist = new Float64Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  // 锁定的国家的格不进
  for (let i = 0; i < n; i++) if (country[i] >= 0) owner[i] = -2;
  const grow = new HeapLite(n);
  seeds.forEach((s, o) => {
    owner[s.cell] = o;
    dist[s.cell] = 0;
    grow.push(s.cell, 0);
  });
  const { off, adj } = mesh;
  const land = causes.land;
  const lake = d.lake;
  // 格局加的代价（第七十三轮；第七十四轮的民族主义、大河帝国、汗国、多民族的大国加）。
  // 第七十九轮：长之前合成一个函数（一条时就是它，几条时按先后一条接一条，和以前逐条调一样）；没有时走下面不带它的 stepTo（同第七十二轮以前）
  const extra = g.stepCost;
  const hook: ((o: number, j: number, c: number) => number) | null =
    extra.length === 0
      ? null
      : extra.length === 1
        ? extra[0]
        : (o, j, c) => {
            for (let q = 0; q < extra.length; q++) c = extra[q](o, j, c);
            return c;
          };
  // 第几遍：1 是第一遍（长到预算），FREE_MUL 是第二遍
  let limit = 1;
  // o 从 i（距离 di）走边 e 到 j 的距离（进不去时为 Infinity）。两份只差格局的代价那一行
  const plainStep = (o: number, di: number, e: number, j: number): number => {
    let c = plainEdge[o] ? base[e] : crossed[e];
    if (land[j]) {
      if (lake[j] !== 1) {
        if (comps[j] === home[o]) {
          if (hab[j] < thr[o]) {
            if (limit === 1) return Infinity;
            c *= hab[j] < NOBODY ? 6 : 3;
          }
        } else if (hab[j] < Math.max(thr[o], minH)) return Infinity;
        const r = region[j];
        if (r >= 0 ? r !== conf[o] : conf[o] >= 0 && hab[j] >= minH) return Infinity;
        const cj = cultureOf[j];
        if (cj >= 0 && cj !== prim[o]) c *= ctx.cultureGroup[cj] === primGroup[o] ? sameMul[o] : otherMul[o];
        if (!(x.flags[j] & COAST)) c *= coastMul[o];
      }
    } else c *= seaMul[o];
    return di + (c / spd[o]) * (1 + (coh[o] * di) / (2 * Rp[o]));
  };
  const hookStep = (o: number, di: number, e: number, j: number): number => {
    let c = plainEdge[o] ? base[e] : crossed[e];
    if (land[j]) {
      if (lake[j] !== 1) {
        // 游牧的放宽只在起点所在的陆块上：别的陆块按时代的下限（不去没人住的岛）。
        // 第二遍在本陆块上可以翻过宜居度低的地方（山、荒漠代价三倍，冰川六倍；长完放掉）：山那边没人占的谷地也有主
        if (comps[j] === home[o]) {
          if (hab[j] < thr[o]) {
            if (limit === 1) return Infinity;
            c *= hab[j] < NOBODY ? 6 : 3;
          }
        } else if (hab[j] < Math.max(thr[o], minH)) return Infinity;
        // 预留的地方（邦联……）只有成员进；成员不出那一片（能住人的地方）
        const r = region[j];
        if (r >= 0 ? r !== conf[o] : conf[o] >= 0 && hab[j] >= minH) return Infinity;
        const cj = cultureOf[j];
        if (cj >= 0 && cj !== prim[o]) c *= ctx.cultureGroup[cj] === primGroup[o] ? sameMul[o] : otherMul[o];
        if (!(x.flags[j] & COAST)) c *= coastMul[o];
        c = hook!(o, j, c);
      }
    } else c *= seaMul[o];
    return di + (c / spd[o]) * (1 + (coh[o] * di) / (2 * Rp[o]));
  };
  const stepTo = hook ? hookStep : plainStep;
  const claimed = new Float64Array(k);
  const full = new Uint8Array(k);
  // 第一遍：每国长到面积预算就停（还没定下的格让给挨着的、没长满的国家）；
  // 第二遍：剩下能占的地方接着长，最多到预算的 FREE_MUL 倍，快慢拉平（剩下的归近的，不是大国多占）；再剩下的是无主地
  const run = () => {
    while (grow.size) {
      const i = grow.pop();
      const di = grow.lastKey;
      // 过时的（让出去的格的距离变了）跳过
      if (di !== dist[i] || owner[i] < 0) continue;
      const o = owner[i];
      if (!done[i]) {
        if (full[o]) {
          let best = -1;
          let bd = Infinity;
          for (let e = off[i]; e < off[i + 1]; e++) {
            const j = adj[e];
            const q = owner[j];
            if (!done[j] || q < 0 || full[q]) continue;
            for (let f = off[j]; f < off[j + 1]; f++) {
              if (adj[f] !== i) continue;
              const nd = stepTo(q, dist[j], f, i);
              if (nd <= cap[q] && (nd < bd || (nd === bd && q < best))) {
                bd = nd;
                best = q;
              }
              break;
            }
          }
          owner[i] = best;
          dist[i] = bd;
          if (best >= 0) grow.push(i, bd);
          continue;
        }
        done[i] = 1;
        // 预算里能住人的干陆地算全，别的干陆地（荒漠、山、苔原）算 LOW_HAB_WEIGHT
        if (x.dry[i]) {
          claimed[o] += cellKm2(world, i) * (hab[i] >= minH ? 1 : LOW_HAB_WEIGHT);
          if (claimed[o] >= limit * budget[o]) full[o] = 1;
        }
      }
      for (let e = off[i], end = off[i + 1]; e < end; e++) {
        const j = adj[e];
        if (owner[j] === -2 || done[j]) continue;
        const nd = stepTo(o, di, e, j);
        if (nd > cap[o] || nd >= dist[j]) continue;
        dist[j] = nd;
        owner[j] = o;
        grow.push(j, nd);
      }
    }
  };
  run();
  limit = FREE_MUL;
  // 第八十四轮：国家很少时（时代的国家大小比这块陆地大）一国最多能占的放宽到 1 ÷ 国家数，几国加起来盖得满
  const maxFree = Math.max(MAX_FREE, 1 / Math.max(1, g.total));
  for (let o = 0; o < k; o++) {
    budget[o] = Math.min(budget[o], (maxFree * area) / FREE_MUL);
    full[o] = claimed[o] >= limit * budget[o] ? 1 : 0;
    spd[o] = Math.pow(speed[o], 0.25);
    Rp[o] = Math.max(R[o], Math.sqrt(T / Math.PI));
    cap[o] = 20 * Rp[o];
  }
  for (let i = 0; i < n; i++) if (done[i] && owner[i] >= 0) grow.push(i, dist[i]);
  run();
  // 第二遍翻过的地方（宜居度低于本国下限的山、荒漠、冰川）放掉：国家照旧只占自己住得下的地方，贴着国境的那一圈由领土补齐补上
  for (let i = 0; i < n; i++) if (owner[i] >= 0 && x.dry[i] && hab[i] < thr[owner[i]]) owner[i] = -1;
  g.owner = owner;
  g.dist = dist;
  g.edge = base;
  g.thr = thr;
  g.home = home;
  g.primGroup = primGroup;
}
