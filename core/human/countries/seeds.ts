import { recordedOrigin } from '../../content/origin';
import { HeapLite } from '../../mesh';
import { hashString } from '../../names';
import { mixSeed, mulberry32 } from '../../rng';
import type { World } from '../../world';
import { type Culture, type Era, cultureTendency, weightedList } from '../era';
import { type Government, govAllowed, govRestricted } from '../government';
import { COAST } from '../rules';
import { cellKm2, noiseAt } from '../space';
import type { CountryTierDef } from '../tiers';
import { pickWeighted } from './base';
import { apportion, landComponents } from './count';
import { cultureContext } from './records';
import type { CountryRun } from './state';

// 挑政体、等级与起点（第二十三轮；第二十六轮按“文化 × 陆块”分、先挑政体再挑等级）。第七十三轮从 countries.ts 搬来（原样）。
// 第八十四轮：人口在国家之前，各块按人口分国家、起点挑人多的地方

// 一国的面积预算最多占能住人的地方的几成（第二十六轮）
export const MAX_SHARE = 0.12;
// 起点所在的陆块至少几格（第二十六轮：不在一两格的小岛上立国）
const MIN_SEED_ISLAND = 6;

// 一个文化挑政体的权重：政体的 weight × 文化的倾向（文化或文化组写了 government 的倾向时，没写到的 × 0.15）。
// 第四十四轮：限谁用（only）的政体这个文化用不了时是 0（不给 0.15 的余地）。
// 第五十四轮：世界自己加的政体（自己做的、从别的库加来的）不打 0.15 的折：库里文化的倾向写的时候不知道有它，用户加进来就是要它参与
export function govWeights(world: Pick<World, 'small'>, era: Era, culture: Culture | undefined, govs: readonly Government[]): (g: Government) => number {
  const small = world.small;
  const tend = new Map(weightedList(cultureTendency(small, culture, 'government', era.id)));
  const has = [...tend.keys()].some((id) => govs.some((g) => g.id === id));
  const ctx = govs.some(govRestricted) && culture ? cultureContext(world, culture.id, era) : undefined;
  const library = recordedOrigin(small, 'era', era.id)?.[0];
  const unlisted = (g: Government) => (library !== undefined && recordedOrigin(small, 'government', g.id)?.[0] !== library ? 1 : 0.15);
  return (g) => (ctx && !govAllowed(g, ctx) ? 0 : (g.weight ?? 1) * (has ? (tend.get(g.id) ?? unlisted(g)) : 1));
}

// 按权重挑政体（第四十四轮）：权重都是 0（这个文化能用的都被限了）时在不限谁用的里按 weight 挑，再没有时在全部里挑——国家总有政体
export function pickGov(govs: readonly Government[], w: (g: Government) => number, rand: () => number): Government {
  let total = 0;
  for (const g of govs) total += Math.max(0, w(g));
  if (total > 0) return pickWeighted(govs, w, rand)!;
  const free = govs.filter((g) => !govRestricted(g));
  const list = free.length ? free : govs;
  return pickWeighted(list, (g) => g.weight ?? 1, rand)!;
}

// 政体与等级相配的程度：size 与等级的典型大小之比的对数越近越大
export const govFit = (g: Government, tier: CountryTierDef): number => {
  const r = Math.log(g.size / tier.govSize);
  return Math.exp(-(r * r) / 1.5);
};

// 离 src 不到 km 的格（按边的长度走，海、陆都走）：visit 每格一次
function within(world: World, src: number, km: number, visit: (i: number) => void, heap: HeapLite, dist: Float64Array, stamp: Int32Array, tag: number) {
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
    visit(i);
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

// 这一格与邻格的人口密度（人 / km²）
function localDensity(world: World, pop: Float32Array, i: number): number {
  const { mesh } = world;
  let p = pop[i];
  let a = cellKm2(world, i);
  for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
    const j = mesh.adj[e];
    p += pop[j];
    a += cellKm2(world, j);
  }
  return a > 0 ? p / a : 0;
}

// 分给各文化在各陆块上的地方（按能住人的面积，正好分完）、挑等级与政体、起点；最后接上预留的地方里的起点（reserve 钩子放的）。
// 第二十六轮：按“文化 × 陆块”分（不按文化），大的岛、别的大陆上住着人的地方也有自己的国家，不靠隔海的国家去占
export function placeSeeds(g: CountryRun) {
  const { ctx, world, country, minH, govs, region, isSeed, seeds, seed, K, T, area, tierList, tierW, tierIndex } = g;
  const { x, hab } = ctx;
  const cultureOf = ctx.cultureOf!;
  const { mesh } = world;
  const n = g.n;
  const pop = world.causes.popTotal;
  const { id: compOf, size: islandSize } = landComponents(world);
  g.compOf = compOf;
  const unitOf = new Map<number, number>();
  const unitCulture: number[] = [];
  const unitComp: number[] = [];
  const massList: number[] = [];
  const areaList: number[] = [];
  for (let i = 0; i < n; i++) {
    const c = cultureOf[i];
    if (c < 0 || !x.dry[i] || country[i] >= 0 || hab[i] < minH || region[i] >= 0) continue;
    const key = compOf[i] * K + c;
    let u = unitOf.get(key);
    if (u === undefined) {
      unitOf.set(key, (u = unitCulture.length));
      unitCulture.push(c);
      unitComp.push(compOf[i]);
      massList.push(0);
      areaList.push(0);
    }
    const a = cellKm2(world, i);
    // 第八十四轮：按人口分国家（人口一步在国家之前）；还没有人口时（测试里换掉了那一步）按宜居的面积
    massList[u] += pop ? pop[i] : a * hab[i];
    areaList[u] += a;
  }
  // 起点不放在太小的岛上（别处都没有地方时才放）
  const U = unitCulture.length;
  const massU = Float64Array.from(massList);
  const cellsU: number[][] = unitCulture.map(() => []);
  for (let i = 0; i < n; i++) {
    const c = cultureOf[i];
    if (c < 0 || !x.dry[i] || country[i] >= 0 || hab[i] < minH || region[i] >= 0) continue;
    cellsU[unitOf.get(compOf[i] * K + c)!].push(i);
  }
  const tiny = (u: number) => islandSize[cellsU[u][0]] < MIN_SEED_ISLAND;
  if (unitCulture.some((_, u) => !tiny(u))) for (let u = 0; u < U; u++) if (tiny(u)) massU[u] = 0;
  const counts = apportion(g.rest, massU);
  // 预留的地方以外、连成一片的能住人的地方有多大（起点不放在被那一片围住的小角落里）
  const roomOf = new Float64Array(n);
  if (g.regions.length) {
    const open = (i: number) => x.dry[i] === 1 && country[i] < 0 && hab[i] >= minH && region[i] < 0;
    const seenR = new Uint8Array(n);
    const st: number[] = [];
    const part: number[] = [];
    for (let s0 = 0; s0 < n; s0++) {
      if (seenR[s0] || !open(s0)) continue;
      part.length = 0;
      let a = 0;
      seenR[s0] = 1;
      st.push(s0);
      while (st.length) {
        const i = st.pop()!;
        part.push(i);
        a += cellKm2(world, i);
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
          const j = mesh.adj[e];
          if (!seenR[j] && open(j)) {
            seenR[j] = 1;
            st.push(j);
          }
        }
      }
      for (const i of part) roomOf[i] = a;
    }
  } else roomOf.fill(Infinity);
  const blocked = new Uint8Array(n);
  const heap = new HeapLite(1024);
  const wdist = new Float64Array(n);
  const stamp = new Int32Array(n).fill(-1);
  // 先按文化的倾向挑政体，再挑等级（时代或格局的比例 × 与政体的大小相配）；面积预算 = 平均的国家 × 等级的倍数 ÷ 实际挑出的平均倍数
  const slotsOf: { tier: CountryTierDef; gov: Government; budget: number }[][] = [];
  let mSum = 0;
  let mCount = 0;
  for (let u = 0; u < U; u++) {
    const list: { tier: CountryTierDef; gov: Government; budget: number }[] = (slotsOf[u] = []);
    if (!counts[u]) continue;
    const culture = ctx.cultures[unitCulture[u]];
    const rand = mulberry32(mixSeed(seed, hashString(`country:${culture.id}`), unitComp[u]));
    const w = govWeights(ctx.world, ctx.era, culture, govs);
    for (let k = 0; k < counts[u]; k++) {
      const gov = pickGov(govs, w, rand);
      const tier = pickWeighted(tierList, (t) => tierW[tierIndex.get(t)!] * govFit(gov, t), rand)!;
      list.push({ tier, gov, budget: tier.area * (0.7 + 0.6 * rand()) });
      mSum += tier.area;
      mCount++;
    }
  }
  const meanM = mCount ? mSum / mCount : 1;
  const compArea = new Map<number, number>();
  for (let u = 0; u < U; u++) compArea.set(unitComp[u], (compArea.get(unitComp[u]) ?? 0) + areaList[u]);
  for (let u = 0; u < U; u++) {
    if (!counts[u]) continue;
    const c = unitCulture[u];
    const culture = ctx.cultures[c];
    const slots = slotsOf[u];
    // 一国的预算不超过所有能住人的地方的 MAX_SHARE（国家少的世界里帝国不吞掉大半），也不超过这一块陆地上能住人的地方
    for (const s of slots) s.budget = Math.min(s.budget * (T / meanM), MAX_SHARE * area, compArea.get(unitComp[u])!);
    // 大的先挑地方
    slots.sort((a, b) => b.budget - a.budget || (a.gov.id < b.gov.id ? -1 : 1));
    const cands = cellsU[u];
    const ns = mixSeed(seed, hashString(`country-seed:${culture.id}`));
    const jitter = Float32Array.from(cands, (i) => 1 + 0.35 * noiseAt(world, ns, 500, i));
    // 第八十四轮：起点挑人多的地方（这一格与邻格的人口密度开方：住得密的谷地、海岸；没有人口时按宜居度）
    const base = pop ? Float32Array.from(cands, (i) => Math.sqrt(localDensity(world, pop, i))) : Float32Array.from(cands, (i) => hab[i]);
    for (const slot of slots) {
      const gov = slot.gov;
      const score = (q: number) => {
        const i = cands[q];
        const coast = (x.flags[i] & COAST) !== 0;
        return base[q] * jitter[q] * (coast ? 1 + 2 * gov.coastal : 1 - 0.6 * gov.coastal);
      };
      let best = -1;
      let bs = -Infinity;
      for (let pass = 0; pass < 2 && best < 0; pass++) {
        for (let q = 0; q < cands.length; q++) {
          const i = cands[q];
          if (isSeed[i] || (pass === 0 && (blocked[i] || roomOf[i] < 0.5 * slot.budget))) continue;
          const s = score(q);
          if (s > bs) {
            bs = s;
            best = i;
          }
        }
      }
      if (best < 0) break;
      isSeed[best] = 1;
      seeds.push({ cell: best, culture: c, gov, tier: slot.tier, budget: slot.budget, region: -1 });
      // 起点彼此隔开：间距按面积预算的平方根（不超过这个文化在这一块陆地上的地盘）
      const gap = 0.6 * Math.sqrt(Math.min(slot.budget, areaList[u]));
      within(world, best, gap, (i) => (blocked[i] = 1), heap, wdist, stamp, seeds.length);
    }
  }
  for (const r of g.regions) seeds.push(...r.seeds);
}
