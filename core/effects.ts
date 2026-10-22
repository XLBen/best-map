import { graphDistance } from './mesh';
import { bankRadiusKm, riverBank, riverTypesOf } from './river-types';
import type { Derived, World } from './world';

// 生态、河对周围的影响（第三批）：神圣之地让周围变暖，死亡森林让周围变干，熔岩河两岸又热又干……
//
// 在第一遍植被之后按那一遍的结果算一次：源头是主导生态为 s 的格（生态的“对周围的影响”）、第 k 种河的格（河的“两岸的影响”）。
// 每种源头一次格图距离，影响 = 量 ×(1 − smoothstep(0, R, 距离))，各种加起来，只加在陆地上，总量截到 ±15 °C、±2.5。
// 然后求解（自然融入）和最后一遍都在加了影响的气候上算：求解器能把影响算进去补回来，也不多跑一整遍
// （没有自然融入的涂色时多跑一遍，固定一遍）。没有这种影响的世界里没有 effT、effP 这两个键，算法逐值照旧

export const MAX_EFF_T = 15;
export const MAX_EFF_P = 2.5;

// 一种影响的源头
interface Source {
  kind: 'species' | 'river';
  id: string;
  name: string;
  radiusKm: number;
  dT: number;
  dP: number;
}

// 世界里有哪些影响（量为 0 的不算）
export function effectSources(world: World): Source[] {
  const out: Source[] = [];
  for (const sp of world.small.species) {
    const c = sp.effects?.climate;
    if (!c || (!c.dT && !c.dP)) continue;
    out.push({ kind: 'species', id: sp.id, name: sp.name || sp.id, radiusKm: c.radiusKm, dT: c.dT ?? 0, dP: c.dP ?? 0 });
  }
  for (const t of riverTypesOf(world.small)) {
    const b = t.bank;
    if (!b || (!b.dT && !b.dP)) continue;
    out.push({ kind: 'river', id: t.id, name: t.name, radiusKm: bankRadiusKm(world, t), dT: b.dT ?? 0, dP: b.dP ?? 0 });
  }
  return out;
}

const smooth01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

// 每种影响在各格的强弱（0–1，源头上为 1）；这种源头一格都没有时为 null
function falloff(world: World, d: Derived, s: Source): ArrayLike<number> | null {
  if (s.kind === 'river') return riverBank(world, d, s.id) ?? null;
  const k = world.small.species.findIndex((sp) => sp.id === s.id);
  const seeds: number[] = [];
  for (let i = 0; i < world.mesh.n; i++) if (d.dominant[i] === k) seeds.push(i);
  if (!seeds.length) return null;
  const R = s.radiusKm / world.kmPerUnit;
  const dist = graphDistance(world.mesh, seeds, R);
  const out = new Float32Array(world.mesh.n);
  for (let i = 0; i < out.length; i++) out[i] = dist[i] <= R ? 1 - smooth01(dist[i] / R) : 0;
  return out;
}

// 按 d 现在的主导生态、河的类型算影响，写进 d.effT、d.effP 并返回。没有任何影响（没有这种生态、河，
// 或者它们一格都没有）时两项都是 undefined、返回 null：不多算那一遍
export function computeEffects(world: World, d: Derived): { t: Float32Array; p: Float32Array } | null {
  const sources = effectSources(world);
  const n = world.mesh.n;
  const none = () => {
    if (d.effT !== undefined) d.effT = undefined;
    if (d.effP !== undefined) d.effP = undefined;
    return null;
  };
  if (!sources.length) return none();
  const sumT = new Float64Array(n);
  const sumP = new Float64Array(n);
  const land = world.causes.land;
  let any = false;
  for (const s of sources) {
    const f = falloff(world, d, s);
    if (!f) continue;
    for (let i = 0; i < n; i++) {
      const v = f[i];
      if (!v || !land[i]) continue;
      sumT[i] += s.dT * v;
      sumP[i] += s.dP * v;
      any = true;
    }
  }
  if (!any) return none();
  const t = d.effT?.length === n ? d.effT : new Float32Array(n);
  const p = d.effP?.length === n ? d.effP : new Float32Array(n);
  for (let i = 0; i < n; i++) {
    t[i] = Math.max(-MAX_EFF_T, Math.min(MAX_EFF_T, sumT[i]));
    p[i] = Math.max(-MAX_EFF_P, Math.min(MAX_EFF_P, sumP[i]));
  }
  d.effT = t;
  d.effP = p;
  return { t, p };
}

// 检查器用：这一格受了哪些影响（按现在的主导生态、河的类型认源头，与引擎算时的第一遍可能差一两格），影响大的在前
export function effectsAt(world: World, d: Derived, cell: number): { name: string; dT: number; dP: number }[] {
  const out: { name: string; dT: number; dP: number; w: number }[] = [];
  if (!world.causes.land[cell]) return [];
  const { mesh } = world;
  for (const s of effectSources(world)) {
    let v = 0;
    if (s.kind === 'river') v = riverBank(world, d, s.id)?.[cell] ?? 0;
    else {
      const k = world.small.species.findIndex((sp) => sp.id === s.id);
      const R = s.radiusKm / world.kmPerUnit;
      // 从这一格往外找最近的源头（只找到 R 为止）
      const dist = graphDistance(mesh, [cell], R);
      let best = Infinity;
      for (let i = 0; i < mesh.n; i++) if (dist[i] < best && d.dominant[i] === k) best = dist[i];
      if (best <= R) v = 1 - smooth01(best / R);
    }
    if (v > 0.01) out.push({ name: s.name, dT: s.dT * v, dP: s.dP * v, w: Math.abs(s.dT * v) / 5 + Math.abs(s.dP * v) / 0.5 });
  }
  return out.sort((a, b) => b.w - a.w).map(({ name, dT, dP }) => ({ name, dT, dP }));
}
