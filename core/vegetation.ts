import { computeLook } from './biome-look';
import { ScriptSession, placementSlots, worldSeedOf } from './biome-scripts';
import { graphDistance } from './mesh';
import { planetFormIssues } from './terrain';
import { type ScriptIssue, scriptsEnabled, worldInputs } from './script';
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

// 侵占（第三批）：生态 s 在它侵占的目标适宜的地方得分 ×(1 + strength × 目标里最高的适宜度)。
// 每种生态的目标（下标，去掉自己和找不到的）与强度；没有生态侵占时为 null（走原来的算法）
export type InvadeTable = ({ targets: Int32Array; strength: number } | null)[];
export function invadeTable(species: readonly Species[]): InvadeTable | null {
  let any = false;
  const out = species.map((sp, s) => {
    const inv = sp.effects?.invade;
    if (!inv || !(inv.strength > 0)) return null;
    const targets = [...new Set(inv.targets.map((id) => species.findIndex((x) => x.id === id)))].filter((t) => t >= 0 && t !== s).sort((a, b) => a - b);
    if (!targets.length) return null;
    any = true;
    return { targets: Int32Array.from(targets), strength: inv.strength };
  });
  return any ? out : null;
}

// 生态 s 在格 i 的侵占倍数（不侵占的为 1）。suit 是 n × S 的适宜度
export function invadeBoost(table: InvadeTable, suit: ArrayLike<number>, S: number, i: number, s: number): number {
  const b = table[s];
  if (!b) return 1;
  let m = 0;
  for (let k = 0; k < b.targets.length; k++) {
    const v = suit[i * S + b.targets[k]];
    if (v > m) m = v;
  }
  return 1 + b.strength * m;
}

// 长在哪里的脚本的系数（第三批）：脚本没关掉、有生态带这种脚本时，对每个长植被的格运行，
// 写进 d.placeF（n × P，P 为带脚本的生态个数，见 placementSlots；不长植被的格为 1）。
// 脚本出错时这一段按没有脚本处理（系数 1），说明记进 issues。没有这种脚本时 placeF 为 undefined
function computePlacement(world: World, d: Derived, issues: ScriptIssue[], session: () => ScriptSession): { slot: Int32Array; P: number; placeF: Float32Array } | null {
  const species = world.small.species;
  const { slot, P } = scriptsEnabled() ? placementSlots(species) : { slot: null, P: 0 };
  if (!slot || P === 0) {
    // 赋 undefined 而不是 delete（对象的形状不变）；从来没有脚本的世界里根本没有这个键
    if (d.placeF !== undefined) d.placeF = undefined;
    return null;
  }
  const n = world.mesh.n;
  const placeF = d.placeF?.length === n * P ? d.placeF : new Float32Array(n * P);
  placeF.fill(1);
  const mask = new Uint8Array(n);
  const list: number[] = [];
  for (let i = 0; i < n; i++) {
    if (isVegetated(world, d, i)) {
      mask[i] = 1;
      list.push(i);
    }
  }
  const cells = Int32Array.from(list);
  const inputs = worldInputs(world, d);
  const seed = worldSeedOf(world);
  species.forEach((sp, s) => {
    const p = slot[s];
    if (p < 0) return;
    const r = session().run('placement', sp, sp.scripts!.placement!.src, inputs, cells, mask, seed);
    if (!r.ok) {
      issues.push(r.issue);
      return;
    }
    for (let j = 0; j < cells.length; j++) {
      const i = cells[j];
      placeF[i * P + p] = r.out[i];
    }
  });
  d.placeF = placeF;
  return { slot, P, placeF };
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
  // 脚本出的问题（不挡操作：出错的脚本这一次按没有脚本处理）。星球形态的脚本的问题（地形那一步记下的）排在最前
  const issues: ScriptIssue[] = planetFormIssues(world, d.scriptIssues);
  // 长在哪里、颜色两种脚本共用一次运行（各输入与上次的差别只算一次，最后一起记下）；用到脚本时才开
  const run: { session?: ScriptSession } = {};
  const sessionOf = () => (run.session ??= new ScriptSession(world));
  const place = computePlacement(world, d, issues, sessionOf);

  for (let s = 0; s < S; s++) {
    const sp = species[s];
    const getterList = sp.tolerances.map((t) => getters.get(t.field)!);
    // 长在哪里的脚本：适宜度再乘上它的系数（没有脚本的生态 p 为 −1，与原来逐值相同）
    const p = place ? place.slot[s] : -1;
    for (let i = 0; i < n; i++) {
      let v = 0;
      if (isVegetated(world, d, i)) {
        v = 1;
        for (let k = 0; k < sp.tolerances.length && v > 0; k++) v *= trapezoid(sp.tolerances[k], getterList[k](i));
        if (p >= 0 && v > 0) v *= place!.placeF[i * place!.P + p];
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
  // 侵占：所有适宜度都算好之后，按目标的适宜度提高得分（不回头影响适宜度，没有反馈）。没有生态侵占时走原来的算法
  const invade = invadeTable(species);
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
    if (!invade) {
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
    } else {
      for (let s = 0; s < S; s++) {
        const score = d.suit[i * S + s] * species[s].competition * d.reach[i * S + s] * invadeBoost(invade, d.suit, S, i, s);
        const w = score > 0 ? Math.pow(score, k) : 0;
        d.share[i * S + s] = w;
        total += w;
        if (score > bestScore) {
          bestScore = score;
          best = s;
        }
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

  // 颜色脚本（第三批）：按最后的份额算每格的颜色，写进 d.look（没有颜色脚本时为 undefined）
  computeLook(world, d, issues, sessionOf);
  run.session?.finish();
  // 没有问题时为 undefined（与 placeF 一样只在曾经有过时才赋值：从来没有脚本的世界里没有这个键）
  if (issues.length) d.scriptIssues = issues;
  else if (d.scriptIssues !== undefined) d.scriptIssues = undefined;
}

export interface CellExplanation {
  species: string;
  name: string;
  // 适宜度（已经乘上了长在哪里的脚本的系数）
  suitability: number;
  competition: number;
  reachable: boolean;
  score: number;
  share: number;
  // 每条耐受曲线的取值与因子，便于看出谁卡住了
  factors: { field: string; value: number; factor: number; range: [number, number, number, number] }[];
  // 长在哪里的脚本在这一格的系数：引擎算好存着的，与适宜度里乘上的是同一个数（这种生态没有脚本时没有这一项）
  placement?: number;
  // 侵占的倍数（这种生态不侵占别的生态时没有这一项）
  boost?: number;
}

export function explainCell(world: World, d: Derived, i: number): CellExplanation[] {
  const species = world.small.species;
  const S = species.length;
  const n = world.mesh.n;
  // 只读引擎存着的结果：主线程不运行脚本
  const { slot, P } = placementSlots(species);
  const placeF = P > 0 && d.placeF?.length === n * P ? d.placeF : null;
  const invade = invadeTable(species);
  return species
    .map((sp, s) => {
      const factors = sp.tolerances.map((t) => {
        const value = fieldGetter(world, d, t.field)(i);
        return { field: t.field, value, factor: trapezoid(t, value), range: [t.min, t.optLow, t.optHigh, t.max] as [number, number, number, number] };
      });
      const suit = d.suit[i * S + s] ?? 0;
      const reachable = (d.reach[i * S + s] ?? 1) === 1;
      const boost = invade?.[s] ? invadeBoost(invade, d.suit, S, i, s) : undefined;
      const out: CellExplanation = {
        species: sp.id,
        name: sp.name || sp.id,
        suitability: suit,
        competition: sp.competition,
        reachable,
        score: suit * sp.competition * (reachable ? 1 : 0) * (boost ?? 1),
        share: d.share[i * S + s] ?? 0,
        factors,
      };
      if (placeF && slot[s] >= 0) out.placement = placeF[i * P + slot[s]];
      if (boost !== undefined) out.boost = boost;
      return out;
    })
    .sort((a, b) => b.score - a.score);
}
