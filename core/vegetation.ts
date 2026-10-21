import { graphDistance } from './mesh';
import { worldLatitude, type Derived, type World } from './world';
import { type Species, trapezoid } from './species';

// 植被：每种类型的适宜度 = 各耐受曲线之积；得分 = 适宜度 × 竞争力 × 可达；
// 份额 ∝ 得分^k（k 为锐度），主导类型 = 份额最大者。
// 在一个格上 A、B 都能活时谁赢由竞争力和 k 决定，结果对用户透明（见 explainCell）。

export type FieldGetter = (i: number) => number;

export function fieldGetter(world: World, d: Derived, field: string): FieldGetter {
  if (field.startsWith('field:')) {
    const name = field.slice(6);
    const arr = world.causes.fields[name];
    const corr = d.corrF[name];
    if (!arr) return () => 0;
    return corr ? (i) => arr[i] + corr[i] : (i) => arr[i];
  }
  switch (field) {
    case 'tMean':
      return (i) => d.tMean[i];
    case 'tWarm':
      return (i) => d.tWarm[i];
    case 'tCold':
      return (i) => d.tCold[i];
    case 'precip':
      return (i) => d.precip[i];
    case 'moisture':
      return (i) => d.moisture[i];
    case 'seasonality':
      return (i) => d.seasonality[i];
    case 'elevation':
      return (i) => Math.max(0, d.elevation[i]);
    case 'slope':
      return (i) => d.slope[i];
    case 'discharge':
      return (i) => d.discharge[i];
    case 'wetness':
      return (i) => d.wetness[i];
    case 'continentality':
      return (i) => d.continentality[i];
    case 'lat':
      return (i) => Math.abs(worldLatitude(world, world.mesh.y[i]));
    default:
      return () => 0;
  }
}

export function suitability(sp: Species, get: (field: string) => number): number {
  let s = 1;
  for (const t of sp.tolerances) {
    s *= trapezoid(t, get(t.field));
    if (s === 0) break;
  }
  return s;
}

export function isVegetated(world: World, d: Derived, i: number): boolean {
  return world.causes.land[i] === 1 && d.lake[i] !== 1;
}

export function computeVegetation(world: World, d: Derived) {
  const { mesh, small } = world;
  const n = mesh.n;
  const species = small.species;
  const S = species.length;
  if (d.share.length !== n * S) {
    d.share = new Float32Array(n * S);
    d.suit = new Float32Array(n * S);
    d.reach = new Uint8Array(n * S);
  }
  const getters = new Map<string, FieldGetter>();
  for (const sp of species) for (const t of sp.tolerances) if (!getters.has(t.field)) getters.set(t.field, fieldGetter(world, d, t.field));

  for (let s = 0; s < S; s++) {
    const sp = species[s];
    const getterList = sp.tolerances.map((t) => getters.get(t.field)!);
    for (let i = 0; i < n; i++) {
      let v = 0;
      if (isVegetated(world, d, i)) {
        v = 1;
        for (let k = 0; k < sp.tolerances.length && v > 0; k++) v *= trapezoid(sp.tolerances[k], getterList[k](i));
      }
      d.suit[i * S + s] = v;
      d.reach[i * S + s] = 1;
    }
    if (sp.dispersal) {
      const disp = sp.dispersal;
      const limit = disp.range / world.kmPerUnit;
      const origins = disp.origins.filter((c) => c < n);
      const dist = graphDistance(mesh, origins, limit, (_i, j, e) => {
        const water = !isVegetated(world, d, j);
        const poor = d.suit[j * S + s] < 0.2;
        return mesh.dist[e] * (water ? disp.seaCost : poor ? disp.gapCost : 1);
      });
      for (let i = 0; i < n; i++) d.reach[i * S + s] = dist[i] <= limit ? 1 : 0;
    }
  }

  const k = small.planet.vegSharpness;
  d.overridden.fill(0);
  for (let i = 0; i < n; i++) {
    if (!isVegetated(world, d, i)) {
      d.dominant[i] = -1;
      for (let s = 0; s < S; s++) d.share[i * S + s] = 0;
      continue;
    }
    let total = 0;
    let best = -2;
    let bestScore = 0;
    for (let s = 0; s < S; s++) {
      const score = d.suit[i * S + s] * species[s].competition * d.reach[i * S + s];
      const w = score > 0 ? Math.pow(score, k) : 0;
      d.share[i * S + s] = w;
      total += w;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    if (total > 0) for (let s = 0; s < S; s++) d.share[i * S + s] /= total;
    d.dominant[i] = best;
  }

  // 硬覆盖：直接改结果，标为例外
  for (const c of small.constraints) {
    if (c.mode !== 'override') continue;
    const s = species.findIndex((sp) => sp.id === c.species);
    if (s < 0) continue;
    for (const i of c.cells) {
      if (i >= n || !isVegetated(world, d, i)) continue;
      for (let t = 0; t < S; t++) d.share[i * S + t] = t === s ? 1 : 0;
      d.dominant[i] = s;
      d.overridden[i] = 1;
    }
  }
}

export interface CellExplanation {
  species: string;
  name: string;
  suitability: number;
  competition: number;
  reachable: boolean;
  score: number;
  share: number;
  // 每条耐受曲线的取值与因子，便于看出谁卡住了
  factors: { field: string; value: number; factor: number; range: [number, number, number, number] }[];
}

export function explainCell(world: World, d: Derived, i: number): CellExplanation[] {
  const S = world.small.species.length;
  return world.small.species
    .map((sp, s) => {
      const factors = sp.tolerances.map((t) => {
        const value = fieldGetter(world, d, t.field)(i);
        return { field: t.field, value, factor: trapezoid(t, value), range: [t.min, t.optLow, t.optHigh, t.max] as [number, number, number, number] };
      });
      const suit = d.suit[i * S + s] ?? 0;
      const reachable = (d.reach[i * S + s] ?? 1) === 1;
      return {
        species: sp.id,
        name: sp.name || sp.id,
        suitability: suit,
        competition: sp.competition,
        reachable,
        score: suit * sp.competition * (reachable ? 1 : 0),
        share: d.share[i * S + s] ?? 0,
        factors,
      };
    })
    .sort((a, b) => b.score - a.score);
}
