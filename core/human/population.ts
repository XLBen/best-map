import { HeapLite } from '../mesh';
import { hashString } from '../names';
import { mixSeed } from '../rng';
import type { Derived, PopTuple, World } from '../world';
import type { GenContext, HumanStage } from './context';
import { type Culture, type Dimension, cultureById, cultureGroupById, dimensionValues, popValueById, weightedList, worldDimensions, worldEra } from './era';
import { GroupTable, SLOTS, type Share, clearCell, readComp, writeComp } from './groups';
import { type CompiledPrefs, compilePrefs, prefAt } from './habitability';
import { type CellInputs, cellInputs } from './rules';
import { cellKm2, nearestBy, noiseAt } from './space';
import { worldTerrainClasses } from './terrain-class';

// 人口（第二十二轮）：总人口按宜居度分到各格，每格的成分按当地的文化（文化圈的边上掺一些邻近的文化）与文化的默认倾向
// （宗教、种族……）组成，记前 4 个群体（见 groups.ts）。
//
// 人数：每格的权重 = 面积（km²）× (宜居度 × 偏好)^sparsity，宜居度低于时代的 minHabitability 时再 × nomads；
// 每个文化分到的人数 = 总人口 × 组的权重比例 × 组里文化的权重比例（某个文化的地盘里一格能住人的都没有时，它的那份分给别的文化），
// 在它的地盘里按权重分。
// 成分：每一维按文化的倾向（权重）× 取值的偏好 × e^(1.6·噪声)，再取 2.5 次方归一（噪声按地图上的位置、波长约 1200 km：
// 同一种宗教成片，不是星星点点），占比不到 4% 的去掉，每维最多留 3 种

const MIX = 0.5;
const VALUE_WAVE_KM = 1200;
const VALUE_SHARP = 2.5;
const VALUE_NOISE = 1.6;

export function ensurePopArrays(world: World) {
  const c = world.causes;
  const n = world.mesh.n;
  c.popTotal ??= new Float32Array(n);
  c.popGroup ??= new Uint16Array(n * SLOTS);
  c.popShare ??= new Uint8Array(n * SLOTS);
}

// 文化圈边上掺多少邻近的文化：每格离另一个文化的地盘多远（km，只在陆上走），掺 0.5·e^(−距离 / 格距)
function borderMix(world: World, x: CellInputs, cultureOf: Int32Array): { other: Int32Array; mix: Float32Array } {
  const { mesh } = world;
  const n = mesh.n;
  const km = world.kmPerUnit;
  const L = mesh.spacing * km;
  const limit = 4 * L;
  const other = new Int32Array(n).fill(-1);
  const dist = new Float64Array(n).fill(Infinity);
  const heap = new HeapLite(1024);
  for (let i = 0; i < n; i++) {
    const a = cultureOf[i];
    if (!x.dry[i] || a < 0) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      const b = cultureOf[j];
      if (!x.dry[j] || b < 0 || b === a) continue;
      const dd = mesh.dist[e] * km;
      if (dd < dist[i] || (dd === dist[i] && b < other[i])) {
        dist[i] = dd;
        other[i] = b;
      }
    }
    if (other[i] >= 0) heap.push(i, dist[i]);
  }
  while (heap.size) {
    const i = heap.pop();
    const di = heap.lastKey;
    if (di > dist[i]) continue;
    const label = other[i];
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (!x.dry[j] || cultureOf[j] !== cultureOf[i]) continue;
      const nd = di + mesh.dist[e] * km;
      if (nd < dist[j] && nd <= limit) {
        dist[j] = nd;
        other[j] = label;
        heap.push(j, nd);
      }
    }
  }
  const mix = new Float32Array(n);
  for (let i = 0; i < n; i++) if (other[i] >= 0) mix[i] = MIX * Math.exp(-dist[i] / L);
  return { other, mix };
}

// 一维的取值怎么分：每个文化、每一维各一份（按格算）
interface DimPlan {
  dim: Dimension;
  // 每个文化（ctx.cultures 的下标）的候选取值与权重；空的是这一维没有取值
  options: { id: string; w: number; prefs: CompiledPrefs | null; seed: number }[][];
}

function dimPlans(world: World, era: string, cultures: readonly Culture[], dims: readonly Dimension[], biomes: readonly { id: string; terrain: string }[], classIds: readonly string[], seed: number): DimPlan[] {
  return dims.map((dim) => {
    const values = dimensionValues(world.small, dim.id, era);
    const known = new Set(values.map((v) => v.id));
    const options = cultures.map((c) => {
      let list = weightedList(c.tendencies?.[dim.id]).filter(([id, w]) => known.has(id) && w > 0);
      if (!list.length && dim.required) list = values.map((v) => [v.id, 1]);
      return list.map(([id, w]) => ({ id, w, prefs: compilePrefs(popValueById(world.small, id)?.prefs, biomes, classIds), seed: mixSeed(seed, hashString(`value:${dim.id}:${id}`)) }));
    });
    return { dim, options };
  });
}

// 一个文化在第 i 格、某一维的取值分布（已归一；没有取值时是一项 null）
function valueDist(world: World, plan: DimPlan, c: number, x: CellInputs, cls: Uint8Array, i: number, noise: Map<number, Float32Array>): { id: string | null; p: number }[] {
  const opts = plan.options[c];
  if (!opts.length) return [{ id: null, p: 1 }];
  if (opts.length === 1) return [{ id: opts[0].id, p: 1 }];
  const raw: { id: string; p: number }[] = [];
  let sum = 0;
  for (const o of opts) {
    let f = noise.get(o.seed);
    if (!f) noise.set(o.seed, (f = new Float32Array(world.mesh.n).fill(NaN)));
    let v = f[i];
    if (v !== v) v = f[i] = noiseAt(world, o.seed, VALUE_WAVE_KM, i);
    const score = Math.pow(o.w * prefAt(o.prefs, x, cls, i) * Math.exp(VALUE_NOISE * v), VALUE_SHARP);
    raw.push({ id: o.id, p: score });
    sum += score;
  }
  if (!(sum > 0)) return [{ id: opts[0].id, p: 1 }];
  const kept = raw
    .map((r) => ({ id: r.id, p: r.p / sum }))
    .filter((r) => r.p >= 0.04)
    .sort((a, b) => b.p - a.p || (a.id < b.id ? -1 : 1))
    .slice(0, 3);
  const k = kept.reduce((a, b) => a + b.p, 0);
  return kept.map((r) => ({ id: r.id, p: r.p / k }));
}

// 第 i 格里 parts（文化的下标与占比）的成分：每个文化各维取值的组合，取最多的几种
function composeCell(world: World, ctx: Pick<GenContext, 'x' | 'cls' | 'cultures'>, plans: readonly DimPlan[], parts: readonly { c: number; s: number }[], i: number, noise: Map<number, Float32Array>, table: GroupTable): Share[] {
  const out: Share[] = [];
  for (const part of parts) {
    let combos: { values: Record<string, string>; p: number }[] = [{ values: {}, p: part.s }];
    for (const plan of plans) {
      const dist = valueDist(world, plan, part.c, ctx.x, ctx.cls, i, noise);
      const next: typeof combos = [];
      for (const cb of combos) for (const v of dist) next.push({ values: v.id ? { ...cb.values, [plan.dim.id]: v.id } : cb.values, p: cb.p * v.p });
      next.sort((a, b) => b.p - a.p);
      combos = next.slice(0, 8);
    }
    for (const cb of combos) out.push({ code: table.code({ culture: ctx.cultures[part.c].id, values: cb.values }), s: cb.p });
  }
  return out;
}

function populate(ctx: GenContext) {
  const { world, x, hab, era, cultures, cultureOf, keep } = ctx;
  if (!cultureOf) throw new Error('人口要在文化圈之后算');
  ensurePopArrays(world);
  const causes = world.causes;
  const n = world.mesh.n;
  const k = era.sparsity;
  const { minHabitability: minH, nomads } = era.unclaimed;
  // 每格的权重
  const W = new Float64Array(n);
  const sumBy = new Float64Array(cultures.length);
  let keptPop = 0;
  for (let i = 0; i < n; i++) {
    if (keep?.[i]) {
      keptPop += causes.popTotal![i];
      continue;
    }
    clearCell(causes, i);
    const c = cultureOf[i];
    if (!x.dry[i] || c < 0) continue;
    const e = Math.min(1.5, hab[i] * ctx.culturePref[c][i]);
    if (e < 1e-3) continue;
    let w = cellKm2(world, i) * Math.pow(e, k);
    if (hab[i] < minH) w *= nomads;
    if (ctx.popScale) w *= ctx.popScale[i];
    if (!(w > 0)) continue;
    W[i] = w;
    sumBy[c] += w;
  }
  // 每个文化分到的人数
  const gsum = ctx.groups.reduce((a, g) => a + g.weight, 0) || 1;
  const want = new Float64Array(cultures.length);
  let base = 0;
  for (const g of ctx.groups) {
    const csum = g.cultures.reduce((a, c) => a + c.weight, 0) || 1;
    g.cultures.forEach((c, q) => (want[base + q] = ((g.weight / gsum) * c.weight) / csum));
    base += g.cultures.length;
  }
  let live = 0;
  for (let c = 0; c < cultures.length; c++) if (sumBy[c] > 0) live += want[c];
  const total = Math.max(0, ctx.totalPop - keptPop);
  const perW = new Float64Array(cultures.length);
  for (let c = 0; c < cultures.length; c++) if (sumBy[c] > 0 && live > 0) perW[c] = (total * want[c]) / live / sumBy[c];
  // 成分
  const { other, mix } = borderMix(world, x, cultureOf);
  const plans = dimPlans(
    world,
    era.id,
    cultures,
    era.dimensions,
    world.small.species,
    ctx.classIds,
    ctx.seed,
  );
  const table = new GroupTable(world.small);
  const noise = new Map<number, Float32Array>();
  let sumW = 0;
  let sumP = 0;
  for (let i = 0; i < n; i++) {
    if (!W[i]) continue;
    const c = cultureOf[i];
    const pop = W[i] * perW[c];
    if (!(pop > 0)) continue;
    causes.popTotal![i] = pop;
    sumW += W[i];
    sumP += pop;
    const m = other[i] >= 0 ? mix[i] : 0;
    const parts = m > 0 ? [{ c, s: 1 - m }, { c: other[i], s: m }] : [{ c, s: 1 }];
    writeComp(causes, i, composeCell(world, ctx, plans, parts, i, noise, table));
  }
  table.commit();
  ctx.perWeight = sumW > 0 ? sumP / sumW : 0;
}

export const populationStage: HumanStage = { id: 'population', run: populate };

// ---------- 修补：改地形之后（见 engine.ts 的 fixPopulation） ----------

// 修补的结果：这些格的新人数、群体、占比（每格 4 个），记进命令（重放照用）
export interface PopFix {
  cells: number[];
  total: number[];
  groups: number[];
  shares: number[];
}

// 一个文化（含它的组）的偏好
function culturePrefs(world: World, id: string, classIds: readonly string[]): CompiledPrefs | null {
  const c = cultureById(world.small, id);
  if (!c) return null;
  const g = cultureGroupById(world.small, c.group);
  return compilePrefs([...(g?.prefs ?? []), ...(c.prefs ?? [])], world.small.species, classIds);
}

// 改了陆海之后：变成水面（海、湖）的格去掉人口；以前是水面、现在是干的陆地、还没有人的格，按宜居度补上人口，
// 成分照最近的有人的格。wasWater：这一步之前的水面。别处的人数不动（宜居度变了也不动，要整体重来时重新生成）
export function populationFix(world: World, d: Derived, wasWater: Uint8Array): PopFix | null {
  const { causes, small } = world;
  const h = small.human;
  const era = worldEra(small);
  if (!h || !era || !causes.popTotal) return null;
  const x = cellInputs(world, d);
  const n = world.mesh.n;
  const pop = causes.popTotal;
  const lost: number[] = [];
  const gained: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!x.dry[i]) {
      if (pop[i] > 0 || causes.popGroup![i * SLOTS]) lost.push(i);
    } else if (wasWater[i] && !(pop[i] > 0)) gained.push(i);
  }
  if (!lost.length && !gained.length) return null;
  const fix: PopFix = { cells: [], total: [], groups: [], shares: [] };
  const put = (i: number, total: number, comp: { g: number[]; s: number[] }) => {
    fix.cells.push(i);
    fix.total.push(total);
    fix.groups.push(...comp.g);
    fix.shares.push(...comp.s);
  };
  const empty = { g: [0, 0, 0, 0], s: [0, 0, 0, 0] };
  const lostSet = new Set(lost);
  if (gained.length) {
    const classIds = worldTerrainClasses(small).map((c) => c.id);
    // 每格最近的有人的干的陆地格
    const near = nearestBy(world.mesh, (i) => x.dry[i] === 1 && pop[i] > 0 && !lostSet.has(i), (i) => i, -1);
    const prefs = new Map<string, CompiledPrefs | null>();
    const k = era.sparsity;
    for (const i of gained) {
      const src = near[i];
      if (src < 0) continue;
      const g = Array.from(causes.popGroup!.subarray(src * SLOTS, src * SLOTS + SLOTS));
      const s = Array.from(causes.popShare!.subarray(src * SLOTS, src * SLOTS + SLOTS));
      const culture = small.popGroups?.[g[0]]?.culture;
      let p = 1;
      if (culture) {
        if (!prefs.has(culture)) prefs.set(culture, culturePrefs(world, culture, classIds));
        p = prefAt(prefs.get(culture)!, x, d.terrainClass, i);
      }
      const e = Math.min(1.5, d.habitability[i] * p);
      if (e < 1e-3) continue;
      let w = cellKm2(world, i) * Math.pow(e, k);
      if (d.habitability[i] < era.unclaimed.minHabitability) w *= era.unclaimed.nomads;
      const total = Math.fround(w * h.perWeight);
      if (!(total > 0)) continue;
      put(i, total, { g, s });
    }
  }
  for (const i of lost) put(i, 0, empty);
  if (!fix.cells.length) return null;
  // 按格的编号排（命令里的样子固定）
  const order = fix.cells.map((_, q) => q).sort((a, b) => fix.cells[a] - fix.cells[b]);
  return {
    cells: order.map((q) => fix.cells[q]),
    total: order.map((q) => fix.total[q]),
    groups: order.flatMap((q) => fix.groups.slice(q * SLOTS, q * SLOTS + SLOTS)),
    shares: order.flatMap((q) => fix.shares.slice(q * SLOTS, q * SLOTS + SLOTS)),
  };
}

// 照修补的结果改（执行、重放都走这里）
export function applyPopFix(world: World, fix: PopFix) {
  if (!world.causes.popTotal) return;
  const c = world.causes;
  fix.cells.forEach((i, q) => {
    c.popTotal![i] = fix.total[q];
    for (let k = 0; k < SLOTS; k++) {
      c.popGroup![i * SLOTS + k] = fix.groups[q * SLOTS + k];
      c.popShare![i * SLOTS + k] = fix.shares[q * SLOTS + k];
    }
  });
}

// ---------- 笔刷（见 commands.ts 的 paint_pop、paint_culture、set_cell_pop） ----------

export type PopBrush =
  | { mode: 'share'; group: PopTuple; amount: number }
  | { mode: 'count'; factor: number }
  // 第二十七轮：这里没有人（橡皮擦的“清空”）
  | { mode: 'clear' }
  | { mode: 'value'; dimension: string; value: string; amount: number }
  | { mode: 'culture'; culture: string; amount: number; typical?: boolean };

// 一个文化最典型的群体：每一维取倾向里权重最大的取值（一样大时排在前面的）
export function typicalTuple(world: Pick<World, 'small'>, culture: string): PopTuple {
  const c = cultureById(world.small, culture);
  const values: Record<string, string> = {};
  for (const dim of worldDimensions(world.small)) {
    const known = new Set(dimensionValues(world.small, dim.id).map((v) => v.id));
    let best: [string, number] | null = null;
    for (const [id, w] of weightedList(c?.tendencies?.[dim.id])) if (known.has(id) && (!best || w > best[1])) best = [id, w];
    const first = dimensionValues(world.small, dim.id)[0];
    if (best) values[dim.id] = best[0];
    else if (dim.required && first) values[dim.id] = first.id;
  }
  return { culture, values };
}

// 改一格的成分：share 这个群体的占比升高 a（其余按比例让出）；value 每个群体里 a 的人这一维换成 value；
// culture 每个群体里 a 的人换成这个文化（typical：换成这个文化最典型的群体）。返回改了没有。
// 第二十七轮：a 为负是往外推（share、value）：这一群体、有这个取值的人里 |a| 换成别的（见 pushAway）
function recompose(world: World, table: GroupTable, i: number, b: Exclude<PopBrush, { mode: 'count' | 'clear' }>, a: number): boolean {
  const c = world.causes;
  const comp = readComp(c, i);
  if (!comp.length || !(c.popTotal![i] > 0) || a === 0 || (a < 0 && b.mode === 'culture')) return false;
  const out: Share[] = [];
  if (a < 0) {
    const pushed = pushAway(world, table, comp, b as Extract<PopBrush, { mode: 'share' | 'value' }>, -a);
    if (!pushed) return false;
    out.push(...pushed);
  } else if (b.mode === 'share') {
    const target = table.code(b.group);
    for (const x of comp) out.push({ code: x.code, s: x.s * (1 - a) });
    out.push({ code: target, s: a });
  } else {
    const typical = b.mode === 'culture' && b.typical ? table.code(typicalTuple(world, b.culture)) : 0;
    for (const x of comp) {
      const t = x.code ? table.get(x.code) : undefined;
      if (!t) {
        out.push(x);
        continue;
      }
      let to: number;
      if (b.mode === 'value') to = t.values[b.dimension] === b.value ? x.code : table.code({ culture: t.culture, values: { ...t.values, [b.dimension]: b.value } });
      else to = typical || (t.culture === b.culture ? x.code : table.code({ culture: b.culture, values: t.values }));
      if (to === x.code) out.push(x);
      else out.push({ code: x.code, s: x.s * (1 - a) }, { code: to, s: x.s * a });
    }
  }
  const g0 = Array.from(c.popGroup!.subarray(i * SLOTS, i * SLOTS + SLOTS));
  const s0 = Array.from(c.popShare!.subarray(i * SLOTS, i * SLOTS + SLOTS));
  writeComp(c, i, out);
  for (let k = 0; k < SLOTS; k++) if (c.popGroup![i * SLOTS + k] !== g0[k] || c.popShare![i * SLOTS + k] !== s0[k]) return true;
  return false;
}

// 往外推（第二十七轮）：share 这个群体的人里 a 让给别的群体（按它们的占比分；只有这一个群体时推不动）；
// value 有这个取值的人里 a 换成这一格里最常见的别的取值（没有时：这一维可以不写就去掉，否则换成这一维的第一个别的取值）。
// 推不动时返回 null
function pushAway(world: World, table: GroupTable, comp: readonly Share[], b: Extract<PopBrush, { mode: 'share' | 'value' }>, a: number): Share[] | null {
  if (b.mode === 'share') {
    const target = table.find(b.group);
    const mine = comp.find((x) => x.code === target);
    const rest = comp.filter((x) => x.code !== target);
    const others = rest.reduce((sum, x) => sum + x.s, 0);
    if (target === undefined || !mine || !(others > 0)) return null;
    const moved = mine.s * a;
    return [{ code: mine.code, s: mine.s - moved }, ...rest.map((x) => ({ code: x.code, s: x.s + (moved * x.s) / others }))];
  }
  const dim = worldDimensions(world.small).find((d) => d.id === b.dimension);
  if (!dim) return null;
  const tuple = (x: Share) => (x.code ? table.get(x.code) : undefined);
  // 这一格里别的取值各占多少
  const tally = new Map<string, number>();
  for (const x of comp) {
    const v = tuple(x)?.values[b.dimension];
    if (v && v !== b.value) tally.set(v, (tally.get(v) ?? 0) + x.s);
  }
  let to: string | null = [...tally].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1))[0]?.[0] ?? null;
  if (!to && dim.required) to = dimensionValues(world.small, dim.id).find((v) => v.id !== b.value)?.id ?? null;
  if (!to && dim.required) return null;
  const out: Share[] = [];
  let moved = false;
  for (const x of comp) {
    const t = tuple(x);
    if (!t || t.values[b.dimension] !== b.value) {
      out.push(x);
      continue;
    }
    const values = { ...t.values };
    if (to) values[b.dimension] = to;
    else delete values[b.dimension];
    out.push({ code: x.code, s: x.s * (1 - a) }, { code: table.code({ culture: t.culture, values }), s: x.s * a });
    moved = true;
  }
  return moved ? out : null;
}

// 画一笔人口：cells 与 t（画笔的权重 0–1，省略为 1）。只画干的陆地。返回改了的格数。
// count：人数 × factor^t；没有人的格在 factor > 1 时按最近的有人的格的成分补上一些人（世界的平均密度 × 宜居度 × (factor − 1)）
export function paintPop(world: World, d: Derived, cells: readonly number[], t: readonly number[] | undefined, b: PopBrush): number {
  ensurePopArrays(world);
  const c = world.causes;
  const n = world.mesh.n;
  const manual = (c.popManual ??= new Uint8Array(n));
  const table = new GroupTable(world.small);
  let changed = 0;
  let near: Int32Array | null = null;
  const pop = c.popTotal!;
  cells.forEach((i, q) => {
    if (!world.causes.land[i] || d.lake[i] === 1) return;
    const w = t ? t[q] : 1;
    if (!(w > 0)) return;
    if (b.mode === 'clear') {
      if (!(pop[i] > 0)) return;
      clearCell(c, i);
      manual[i] = 1;
      changed++;
      return;
    }
    if (b.mode === 'count') {
      const before = pop[i];
      if (before > 0) pop[i] = Math.fround(before * Math.pow(b.factor, w));
      else if (b.factor > 1) {
        near ??= nearestBy(world.mesh, (j) => pop[j] > 0 && world.causes.land[j] === 1, (j) => j, -1);
        const src = near[i];
        const h = world.small.human;
        if (src < 0 || !h) return;
        const landKm2 = landArea(world, d);
        const mean = landKm2 > 0 ? h.totalPop / landKm2 : 0;
        const add = mean * cellKm2(world, i) * Math.max(0.05, d.habitability[i]) * (Math.pow(b.factor, w) - 1);
        if (!(add > 0)) return;
        pop[i] = Math.fround(add);
        c.popGroup!.set(c.popGroup!.subarray(src * SLOTS, src * SLOTS + SLOTS), i * SLOTS);
        c.popShare!.set(c.popShare!.subarray(src * SLOTS, src * SLOTS + SLOTS), i * SLOTS);
      }
      if (pop[i] < 0.5) clearCell(c, i);
      if (pop[i] !== before) {
        manual[i] = 1;
        changed++;
      }
      return;
    }
    if (recompose(world, table, i, b, Math.max(-1, Math.min(1, b.amount * w)))) {
      manual[i] = 1;
      changed++;
    }
  });
  table.commit();
  return changed;
}

function landArea(world: World, d: Derived): number {
  let a = 0;
  for (let i = 0; i < world.mesh.n; i++) if (world.causes.land[i] && d.lake[i] !== 1) a += cellKm2(world, i);
  return a;
}

// 档案里改一格：总人数、各群体的占比（0–1，加起来不到 1 的是“其他”；超过 1 时按比例缩）。返回改了没有
export function setCellPop(world: World, cell: number, total: number | undefined, groups: readonly (PopTuple & { share: number })[] | undefined): boolean {
  ensurePopArrays(world);
  const c = world.causes;
  const manual = (c.popManual ??= new Uint8Array(world.mesh.n));
  const g0 = Array.from(c.popGroup!.subarray(cell * SLOTS, cell * SLOTS + SLOTS));
  const s0 = Array.from(c.popShare!.subarray(cell * SLOTS, cell * SLOTS + SLOTS));
  const t0 = c.popTotal![cell];
  if (total !== undefined) c.popTotal![cell] = Math.fround(total);
  if (groups) {
    const table = new GroupTable(world.small);
    const sum = groups.reduce((a, g) => a + g.share, 0);
    const comp: Share[] = groups.map((g) => ({ code: table.code({ culture: g.culture, values: g.values }), s: g.share }));
    if (sum < 1) comp.push({ code: 0, s: 1 - sum });
    writeComp(c, cell, comp);
    table.commit();
  }
  if (!(c.popTotal![cell] > 0)) clearCell(c, cell);
  let changed = c.popTotal![cell] !== t0;
  for (let k = 0; k < SLOTS; k++) if (c.popGroup![cell * SLOTS + k] !== g0[k] || c.popShare![cell * SLOTS + k] !== s0[k]) changed = true;
  if (changed) manual[cell] = 1;
  return changed;
}

// 总人口按比例改（每格 × 同一个倍数）
export function scalePop(world: World, total: number): boolean {
  const h = world.small.human;
  const pop = world.causes.popTotal;
  if (!h || !pop) return false;
  let sum = 0;
  for (let i = 0; i < pop.length; i++) sum += pop[i];
  if (!(sum > 0)) return false;
  const f = total / sum;
  for (let i = 0; i < pop.length; i++) if (pop[i] > 0) pop[i] = Math.fround(pop[i] * f);
  h.totalPop = total;
  h.perWeight *= f;
  return f !== 1;
}

