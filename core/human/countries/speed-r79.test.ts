import { afterAll, describe, expect, it, vi } from 'vitest';
import { HeapLite } from '../../mesh';
import { BUILTIN_ERAS, ERA_PACKS } from '../../packs/eras';
import { continents, humanExec } from '../../testing/fixtures';
import { edgeCosts } from '../cultures';
import { cultureTendency, dimensionValues, weightedList } from '../era';
import { compilePrefs, prefAt } from '../habitability';
import { COAST } from '../rules';
import { cellKm2 } from '../space';
import { NOBODY } from './base';
import { FREE_MUL, otherCultureMul, sameCultureMul } from './grow';
import { type RaceKind, type RaceRealmState, classify, landKinds, raceDimension } from './patterns/race-realms';
import type { CountryRun } from './state';

// 第七十九轮的提速，新旧逐位相同（每个时代生成国家、换一个种子重新生成国家）：
//   grow.ts：格局加的代价在长之前合成一个函数，没有时走不带它的那一份 stepTo；
//   race-realms.ts 的 classify：所有的格只过一遍（以前每个种族一遍）。
// 拿 vi.mock 换掉 growOwners：先按下面的旧写法（第七十八轮 8facf5e 的原样拷贝，不要改它）长一遍、记下结果，再按现在的长，逐位比
// （第八十四轮：现在的去掉过大河、翻分水岭的倍数 g.cross 比，比完带上它再长一遍）；
// 有种族那一维时（奇幻、科幻）classify 也新旧各算一遍比

type Seen = { era: string; hooks: number; same: boolean; race?: boolean };
const seen: Seen[] = [];
const bytes = (a: ArrayBufferView) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
const sameArr = (a: ArrayBufferView, b: ArrayBufferView) => a.constructor === b.constructor && bytes(a).equals(bytes(b));

vi.mock('./grow', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./grow')>();
  return {
    ...orig,
    growOwners: (g: CountryRun) => {
      oldGrowOwners(g);
      const old = { owner: g.owner, dist: g.dist, edge: g.edge, thr: g.thr, home: g.home, primGroup: g.primGroup };
      // 第八十四轮：过大河、翻分水岭的倍数（g.cross）是后加的，旧的写法没有：去掉它比，再带上它长出真正的结果
      const cross = g.cross;
      g.cross = undefined;
      orig.growOwners(g);
      const same = (Object.keys(old) as (keyof typeof old)[]).every((k) => sameArr(old[k], g[k]));
      g.cross = cross;
      orig.growOwners(g);
      let race: boolean | undefined;
      if (raceDimension(g.world.small, g.ctx.era)) {
        const a = oldClassify(g, 1.8)!;
        const b = classify(g, 1.8)!;
        race = JSON.stringify([...a.races]) === JSON.stringify([...b.races]) && JSON.stringify(a.raceOf) === JSON.stringify(b.raceOf) && sameArr(a.kindOf, b.kindOf) && sameArr(a.land, b.land) && a.dim === b.dim;
      }
      seen.push({ era: g.ctx.era.id, hooks: g.stepCost.length, same, race });
    },
  };
});

const MAX_FREE = 0.16;
const LOW_HAB_WEIGHT = 0.5;

function oldGrowOwners(g: CountryRun) {
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
  const edge = edgeCosts(ctx);
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
  // 格局加的代价（第七十三轮；第七十四轮的民族主义、大河帝国、汗国、多民族的大国加）
  const extra = g.stepCost;
  const nExtra = extra.length;
  // 第几遍：1 是第一遍（长到预算），FREE_MUL 是第二遍
  let limit = 1;
  // o 从 i（距离 di）走边 e 到 j 的距离（进不去时为 Infinity）
  const stepTo = (o: number, di: number, e: number, j: number): number => {
    let c = edge[e];
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
        if (nExtra) for (let q = 0; q < nExtra; q++) c = extra[q](o, j, c);
      }
    } else c *= seaMul[o];
    return di + (c / spd[o]) * (1 + (coh[o] * di) / (2 * Rp[o]));
  };
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
  for (let o = 0; o < k; o++) {
    budget[o] = Math.min(budget[o], (MAX_FREE * area) / FREE_MUL);
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
  g.edge = edge;
  g.thr = thr;
  g.home = home;
  g.primGroup = primGroup;
}
function oldClassify(g: CountryRun, strong: number): RaceRealmState | undefined {
  const { ctx, world } = g;
  const { x, cls, hab } = ctx;
  const small = world.small;
  const dim = raceDimension(small, ctx.era);
  if (!dim) return undefined;
  const land = landKinds(g);
  // 能住人的格（宜居度到时代下限的三成，同汗国）：各类的面积
  const low = Math.max(NOBODY, 0.3 * g.minH);
  const area = new Float64Array(g.n);
  let total = 0;
  const kindArea = [0, 0, 0];
  for (let i = 0; i < g.n; i++) {
    if (!x.dry[i] || hab[i] < low) continue;
    const a = cellKm2(world, i);
    area[i] = a;
    total += a;
    for (let k = 0; k < 3; k++) if (land[i] & (1 << k)) kindArea[k] += a;
  }
  const races = new Map<string, RaceKind>();
  for (const v of dimensionValues(small, dim.id, ctx.era.id)) {
    const top = Math.max(0, ...(v.prefs ?? []).map((p) => p.factor));
    if (!(top >= strong) || !(total > 0)) {
      races.set(v.id, 'open');
      continue;
    }
    const p = compilePrefs(v.prefs, small.species, ctx.classIds);
    let liked = 0;
    const likedKind = [0, 0, 0];
    for (let i = 0; i < g.n; i++) {
      if (!(area[i] > 0) || !(prefAt(p, x, cls, i) > 1)) continue;
      liked += area[i];
      for (let k = 0; k < 3; k++) if (land[i] & (1 << k)) likedKind[k] += area[i];
    }
    let best: RaceKind = 'open';
    let lift = LIFT;
    (['forest', 'upland', 'waste'] as const).forEach((kind, k) => {
      if (!(kindArea[k] > 0) || !(liked > 0)) return;
      const l = likedKind[k] / liked / (kindArea[k] / total);
      if (l > lift) {
        lift = l;
        best = kind;
      }
    });
    races.set(v.id, best);
  }
  const raceOf = ctx.cultures.map((c) => {
    let top: [string, number] | undefined;
    for (const [id, w] of weightedList(cultureTendency(small, c, dim.id, ctx.era.id))) if (races.has(id) && (!top || w > top[1])) top = [id, w];
    return top?.[0];
  });
  const kindOf = Uint8Array.from(raceOf, (r) => KIND_CODE[(r && races.get(r)) || 'open']);
  return { dim: dim.id, races, raceOf, kindOf, land, clusters: [] };
}

const KIND_CODE: Record<RaceKind, number> = { open: 0, forest: 1, upland: 2, waste: 3 };
const LIFT = 1.2;

describe('第七十九轮：国家往外长、种族住哪一类，新旧逐位相同', () => {
  afterAll(() => void (seen.length = 0));
  for (const era of BUILTIN_ERAS.map((e) => e.id)) {
    it(`${era}：生成、换种子重新生成`, () => {
      const from = seen.length;
      const e = continents();
      humanExec(e, { op: 'generate_human', packs: [[era]], groups: ERA_PACKS.get(era)!.cultures.map(([id, weight]) => ({ id, weight })), countries: {} });
      humanExec(e, { op: 'regenerate_countries', seed: 9 });
      const mine = seen.slice(from);
      expect(mine.length).toBe(2);
      for (const s of mine) {
        expect(s.era).toBe(era);
        expect(s.same).toBe(true);
        if (s.race !== undefined) expect(s.race).toBe(true);
      }
      // 奇幻、科幻有种族那一维
      if (era === 'fantasy' || era === 'scifi') expect(mine.every((s) => s.race === true)).toBe(true);
    });
  }
  it('时代不用格局时（没有格局的代价，走不带它的那一份）', () => {
    const from = seen.length;
    const e = continents();
    humanExec(e, { op: 'generate_human', packs: [['medieval']], groups: ERA_PACKS.get('medieval')!.cultures.map(([id, weight]) => ({ id, weight })), countries: {} }, { patterns: [], nationalism: 0 });
    const mine = seen.slice(from);
    expect(mine.map((s) => [s.hooks, s.same])).toEqual([[0, true]]);
  });
  it('走过了没有格局代价、一条、几条的情形', () => {
    const hooks = seen.map((s) => s.hooks);
    expect(hooks).toContain(0);
    expect(hooks.some((h) => h === 1)).toBe(true);
    expect(hooks.some((h) => h >= 2)).toBe(true);
  });
});
