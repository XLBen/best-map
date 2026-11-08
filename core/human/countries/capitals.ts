import type { World } from '../../world';
import type { GenContext, HumanStage } from '../context';
import { scalePopulation } from '../population';
import { resourceEffects } from '../resources';
import { COAST, LAKE, RIVER } from '../rules';
import { cellKm2 } from '../space';
import { countryPopScale } from './stage';

// 首都（第八十四轮）：人口在国家之前就分好了，国家长完（领土补齐、集团、联邦切开以后）把每个新长的国家的首都挪到人口的重心一带
// 最好的城址上：分数 = 这一格的人 × 城址（河 × 1.6、海岸 × 1.3、湖 × 1.15、资源的 cityBonus）× e^(−(离人口重心的距离 ÷ 0.6 R)²)，
// R = √(国土面积 / π)。锁定的、留下的国家不动（重新生成人文、不换国家时也不动）。
// 然后首都一带的人多一些（countryPopScale：1 + 1.2 × 城市化 × e^(−距离 / R')），每个文化的总人数不变（population.ts 的 scalePopulation）

// 离重心多远还算“一带”：国家半径的这么多倍（高斯的宽）
const CENTER_SIGMA = 0.6;
// 城址：靠河、靠海、靠湖
const SITE_RIVER = 1.6;
const SITE_COAST = 1.3;
const SITE_LAKE = 1.15;

// 一格的城址倍数：有河、挨海、挨湖、资源的 cityBonus（flags 是 rules.ts 的 COAST、RIVER、LAKE）
export function capitalSite(flags: number, resource: number, city: Float64Array): number {
  return (flags & RIVER ? SITE_RIVER : 1) * (flags & COAST ? SITE_COAST : 1) * (flags & LAKE ? SITE_LAKE : 1) * (resource < city.length ? city[resource] : 1);
}

// 一国（cells：它的干的陆地）的首都：人口的重心一带最好的城址；一个人都没有时 undefined。
// flagsOf：格的 COAST / RIVER / LAKE 标记（生成时是 cellInputs 的 flags，编辑时现算）；res：每格的资源（生成时是现算的，见 liveResources）
export function bestCapital(world: World, cells: readonly number[], flagsOf: (i: number) => number, res: Uint8Array = world.derived.resource): number | undefined {
  const { mesh, causes } = world;
  const pop = causes.popTotal;
  if (!pop || !cells.length) return undefined;
  const sphere = mesh.kind === 'sphere';
  let w = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  let a = 0;
  for (const i of cells) {
    a += cellKm2(world, i);
    const p = pop[i];
    if (!(p > 0)) continue;
    w += p;
    if (sphere) {
      cx += p * mesh.p[3 * i];
      cy += p * mesh.p[3 * i + 1];
      cz += p * mesh.p[3 * i + 2];
    } else {
      cx += p * mesh.x[i];
      cy += p * mesh.y[i];
    }
  }
  if (!(w > 0)) return undefined;
  cx /= w;
  cy /= w;
  cz /= w;
  if (sphere) {
    const L = Math.hypot(cx, cy, cz) || 1;
    cx /= L;
    cy /= L;
    cz /= L;
  }
  const km = world.kmPerUnit;
  const s2 = (CENTER_SIGMA * Math.sqrt(a / Math.PI)) ** 2;
  const city = resourceEffects(world.small).city;
  let best = -1;
  let bs = 0;
  for (const i of cells) {
    const p = pop[i];
    if (!(p > 0)) continue;
    let dd: number;
    if (sphere) {
      const dot = cx * mesh.p[3 * i] + cy * mesh.p[3 * i + 1] + cz * mesh.p[3 * i + 2];
      dd = (Math.acos(Math.max(-1, Math.min(1, dot))) * km) / Math.PI;
    } else dd = Math.hypot(mesh.x[i] - cx, mesh.y[i] - cy) * km;
    const sc = p * capitalSite(flagsOf(i), res[i], city) * Math.exp(-(dd * dd) / s2);
    if (sc > bs || (sc === bs && best >= 0 && i < best)) {
      bs = sc;
      best = i;
    }
  }
  return best >= 0 ? best : undefined;
}

// 新长的国家的首都挪到人口的重心一带（和逐国调 bestCapital 是同一个式子、同样的先后，只是所有的国家一起过两遍格）
export function placeCapitals(ctx: GenContext) {
  const { world, x } = ctx;
  const { mesh, causes, small } = world;
  const country = causes.country;
  const pop = causes.popTotal;
  const metas = small.countries;
  if (!country || !pop || !metas) return;
  const keptIds = new Set((ctx.countryRun?.kept ?? []).map((m) => m.id));
  const list = Object.values(metas).filter((m) => !m.locked && !m.capitalLocked && !keptIds.has(m.id));
  if (!list.length) return;
  let maxId = 0;
  for (const m of list) maxId = Math.max(maxId, m.id);
  const slot = new Int32Array(maxId + 1).fill(-1);
  list.forEach((m, k) => (slot[m.id] = k));
  const K = list.length;
  const W = new Float64Array(K);
  const CX = new Float64Array(K);
  const CY = new Float64Array(K);
  const CZ = new Float64Array(K);
  const A = new Float64Array(K);
  const n = mesh.n;
  const sphere = mesh.kind === 'sphere';
  const P = sphere ? (mesh as unknown as { p: Float64Array }).p : new Float64Array(0);
  const MX = mesh.x;
  const MY = mesh.y;
  for (let i = 0; i < n; i++) {
    const c = country[i];
    if (c < 0 || c > maxId || !x.dry[i]) continue;
    const k = slot[c];
    if (k < 0) continue;
    A[k] += cellKm2(world, i);
    const p = pop[i];
    if (!(p > 0)) continue;
    W[k] += p;
    if (sphere) {
      CX[k] += p * P[3 * i];
      CY[k] += p * P[3 * i + 1];
      CZ[k] += p * P[3 * i + 2];
    } else {
      CX[k] += p * MX[i];
      CY[k] += p * MY[i];
    }
  }
  const S2 = new Float64Array(K);
  for (let k = 0; k < K; k++) {
    if (!(W[k] > 0)) continue;
    CX[k] /= W[k];
    CY[k] /= W[k];
    CZ[k] /= W[k];
    if (sphere) {
      const L = Math.hypot(CX[k], CY[k], CZ[k]) || 1;
      CX[k] /= L;
      CY[k] /= L;
      CZ[k] /= L;
    }
    S2[k] = (CENTER_SIGMA * Math.sqrt(A[k] / Math.PI)) ** 2;
  }
  const km = world.kmPerUnit;
  const city = resourceEffects(small).city;
  const res = ctx.resource ?? ctx.d.resource;
  const best = new Int32Array(K).fill(-1);
  const bs = new Float64Array(K);
  for (let i = 0; i < n; i++) {
    const c: number = country[i];
    if (c < 0 || c > maxId || !x.dry[i]) continue;
    const k = slot[c];
    const p = pop[i];
    if (k < 0 || !(W[k] > 0) || !(p > 0)) continue;
    let dd: number;
    if (sphere) {
      const dot = CX[k] * P[3 * i] + CY[k] * P[3 * i + 1] + CZ[k] * P[3 * i + 2];
      dd = (Math.acos(Math.max(-1, Math.min(1, dot))) * km) / Math.PI;
    } else dd = Math.hypot(MX[i] - CX[k], MY[i] - CY[k]) * km;
    const sc = p * capitalSite(x.flags[i], res[i], city) * Math.exp(-(dd * dd) / S2[k]);
    if (sc > bs[k] || (sc === bs[k] && best[k] >= 0 && i < best[k])) {
      bs[k] = sc;
      best[k] = i;
    }
  }
  list.forEach((m, k) => {
    if (best[k] >= 0) m.capitalCell = best[k];
  });
}

function capitals(ctx: GenContext) {
  if (!ctx.countries) return;
  if (ctx.countries.mode === 'generate') placeCapitals(ctx);
  const scale = countryPopScale(ctx);
  if (scale) scalePopulation(ctx, scale);
}

export const capitalsStage: HumanStage = { id: 'capitals', run: capitals };
