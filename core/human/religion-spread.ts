import { hashString } from '../names';
import { mixSeed } from '../rng';
import type { GenContext } from './context';
import { genEdgeCosts } from './cultures';
import { HeapLite } from '../mesh';
import { registerGenCache, viewKey } from './gen-cache';
import { cellKm2, distKm } from './space';

// 宗教的发源地与传播（第八十四轮）：以前每格的宗教只按文化的倾向 × 偏好 × 1200 km 的噪声，同一个文化里哪种宗教多是噪声说了算。
// 现在“宗教”这一维（SPREAD_DIMS）的每个取值先挑 1–3 个发源地（在信它最深的那几个文化的发源地上），从发源地按文化圈同一套走一条边的代价
// 同时往外传（同 space.ts 的 compete；海上只走挨着陆地的那一圈），走进一格的快慢 × 这一格的文化对它的倾向（倾向是 0 的文化不进），每格归先到的那一种；
// 两种的交界处掺一些另一种（population.ts 的 borderMix：0.5·e^(−离交界的距离 / 格距)，最远 4 格）。取值的分数里噪声那一项换成：
//   传到这里的那一种 1，交界的另一种 EDGE_FLOOR + (1 − EDGE_FLOOR) × 2 × 掺的比例，别的 EDGE_FLOOR（再取 2.5 次方，占比不到 4% 的去掉，最多 3 种，同以前）。
// 没传到的格（这一格的文化对哪一种都没有倾向、被海隔开）照以前按噪声

// 按发源地传播的维度（别的维度照旧按噪声）
export const SPREAD_DIMS: readonly string[] = ['religion'];
// 没传到这里的宗教的分数
const EDGE_FLOOR = 0.3;

export interface ValueSpread {
  // 每个文化（ctx.cultures 的下标）的候选（DimPlan.options 的下标）→ 取值的编号（values 的下标）
  index: Int32Array[];
  values: string[];
  // 每格传到的取值、交界的另一种（−1 没有）、掺的比例
  winner: Int32Array;
  other: Int32Array;
  mix: Float32Array;
}

// 上一次的结果（重新生成国家时文化圈、宜居度、地形都没变，宗教传播的结果也一样：照用）。键按内容比（gen-cache.ts 的 viewKey）
let last: { key: string; mesh: unknown; out: ValueSpread | null } | null = null;
registerGenCache(() => (last = null));

export function spreadValues(ctx: GenContext, options: readonly { id: string; w: number }[][], dimId: string, border: (owner: Int32Array) => { other: Int32Array; mix: Float32Array }): ValueSpread | null {
  const { world, x } = ctx;
  const cultureOf = ctx.cultureOf!;
  const key = JSON.stringify([
    dimId,
    ctx.seed,
    world.kmPerUnit,
    options.map((l) => l.map((o) => [o.id, o.w])),
    ctx.hearths.map((h) => [h.cell, h.culture ?? '']),
    ctx.cultures.map((c) => c.id),
    viewKey(ctx.hab),
    viewKey(x.dry),
    viewKey(cultureOf),
    viewKey(genEdgeCosts(ctx)),
  ]);
  if (last && last.mesh === world.mesh && last.key === key) return last.out;
  const out = spreadFresh(ctx, options, dimId, border);
  last = { key, mesh: world.mesh, out };
  return out;
}

function spreadFresh(ctx: GenContext, options: readonly { id: string; w: number }[][], dimId: string, border: (owner: Int32Array) => { other: Int32Array; mix: Float32Array }): ValueSpread | null {
  const { world, x, hab, seed } = ctx;
  const cultureOf = ctx.cultureOf!;
  const { mesh } = world;
  const n = mesh.n;
  const values: string[] = [];
  const idOf = new Map<string, number>();
  for (const list of options) for (const o of list) if (!idOf.has(o.id)) idOf.set(o.id, values.push(o.id) - 1);
  const V = values.length;
  if (V < 2) return null;
  // 每个文化对每种取值的倾向（÷ 这个文化最大的那个）
  const K = options.length;
  const tend = new Float32Array(K * V);
  const index = options.map((list, c) => {
    let top = 0;
    for (const o of list) top = Math.max(top, o.w);
    return Int32Array.from(list, (o) => {
      const v = idOf.get(o.id)!;
      if (top > 0) tend[c * V + v] = o.w / top;
      return v;
    });
  });
  // 每种取值的分量（宜居的面积 × 倾向）与能去的面积：先按文化加起来
  const massC = new Float64Array(K);
  const areaC = new Float64Array(K);
  for (let i = 0; i < n; i++) {
    const c = cultureOf[i];
    if (!x.dry[i] || c < 0) continue;
    const a = cellKm2(world, i);
    massC[c] += a * hab[i];
    areaC[c] += a;
  }
  const mass = new Float64Array(V);
  const room = new Float64Array(V);
  for (let c = 0; c < K; c++)
    for (let v = 0; v < V; v++) {
      const t = tend[c * V + v];
      if (!(t > 0)) continue;
      mass[v] += massC[c] * t;
      room[v] += areaC[c];
    }
  let maxMass = 0;
  for (let v = 0; v < V; v++) maxMass = Math.max(maxMass, mass[v]);
  if (!(maxMass > 0)) return null;
  // 发源地：分量大的取值多几个（1–3），在信它的文化的发源地里挑，彼此隔开
  const seeds: { cell: number; owner: number }[] = [];
  const order = [...values.keys()].sort((a, b) => mass[b] - mass[a] || (values[a] < values[b] ? -1 : 1));
  const taken: number[] = [];
  // 候选：各文化的发源地（文化圈一步放好的，ctx.hearths 里写了 culture 的）。宗教从文化的中心传开
  const cultureIdx = new Map(ctx.cultures.map((c, k) => [c.id, k]));
  const cand: { cell: number; c: number }[] = [];
  for (const h of ctx.hearths) {
    const c = h.culture === undefined ? undefined : cultureIdx.get(h.culture);
    if (c !== undefined && x.dry[h.cell]) cand.push({ cell: h.cell, c });
  }
  for (const v of order) {
    if (!(mass[v] > 0)) continue;
    const count = 1 + Math.floor((2 * mass[v]) / maxMass + 1e-9);
    const s = mixSeed(seed, hashString(`hearth:${dimId}:${values[v]}`));
    // 分数：倾向² × √(这个文化宜居的面积) × 一点抖动（按格的哈希）
    const scored = cand
      .map(({ cell, c }) => {
        const t = tend[c * V + v];
        return { cell, sc: t > 0 ? t * t * Math.sqrt(massC[c]) * (0.8 + 0.4 * (mixSeed(s, cell) / 4294967296)) : 0 };
      })
      .filter((q) => q.sc > 0)
      .sort((a, b) => b.sc - a.sc || a.cell - b.cell);
    const own: number[] = [];
    let gap = 0.5 * Math.sqrt(room[v] / count);
    for (let pass = 0; pass < 4 && own.length < count; pass++, gap *= 0.6) {
      for (const { cell } of scored) {
        if (own.length >= count) break;
        // 同一种的几个发源地之间隔开 gap；别的宗教的发源地隔开半个 gap
        if (own.includes(cell) || taken.includes(cell) || own.some((p) => distKm(world, p, cell) < gap) || taken.some((p) => distKm(world, p, cell) < 0.5 * gap)) continue;
        own.push(cell);
      }
    }
    // 别的宗教都占了的文化中心：照样从那里传（同一格先到的是分量大的）
    if (!own.length && scored.length) own.push(scored[0].cell);
    for (const cell of own) {
      seeds.push({ cell, owner: v });
      taken.push(cell);
    }
  }
  if (!seeds.length) return null;
  // 传播：走一条边的代价 ÷（快慢 × 这一格的文化对它的倾向）；每格归先到的那一种（同 space.ts 的 compete，倾向直接按文化查）
  const speed = Float64Array.from(mass, (mm) => 0.8 + 0.4 * Math.sqrt(mm / maxMass));
  const edge = genEdgeCosts(ctx);
  const owner = new Int32Array(n).fill(-1);
  const best = new Float64Array(n).fill(Infinity);
  const heap = new HeapLite(n);
  for (const sd of seeds) {
    if (best[sd.cell] === 0) continue;
    best[sd.cell] = 0;
    owner[sd.cell] = sd.owner;
    heap.push(sd.cell, 0);
  }
  const { off, adj } = mesh;
  // 挨着干的陆地的水面
  const shore = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (x.dry[i]) continue;
    for (let e = off[i]; e < off[i + 1]; e++)
      if (x.dry[adj[e]]) {
        shore[i] = 1;
        break;
      }
  }
  while (heap.size) {
    const i = heap.pop();
    const di = heap.lastKey;
    if (di > best[i]) continue;
    const o = owner[i];
    const sp = speed[o];
    for (let e = off[i], end = off[i + 1]; e < end; e++) {
      const j = adj[e];
      const c = edge[e];
      if (!(c < Infinity)) continue;
      // 海上只走挨着陆地的那一圈（近海、海峡；远洋上的岛照用噪声）
      if (!x.dry[j] && !shore[j]) continue;
      const cj = cultureOf[j];
      const t = cj >= 0 ? tend[cj * V + o] : x.dry[j] ? 0 : 0.5;
      const nd = di + c / (sp * t);
      if (nd < best[j]) {
        best[j] = nd;
        owner[j] = o;
        heap.push(j, nd);
      }
    }
  }
  // 交界：离另一种的地盘多远（同 population.ts 的 borderMix）
  const { other, mix } = border(owner);
  return { index, values, winner: owner, other, mix };
}

// 第 i 格、第 c 个文化：传到的那一种、交界的另一种是第几个候选（−1 不是候选）与交界那一种的倍数；
// 传到这里的那一种不是这个文化的候选（发源地在别的文化里）或没传到时 null：照用噪声
export function spreadSlots(s: ValueSpread, c: number, i: number): { win: number; other: number; mix: number } | null {
  const w = s.winner[i];
  if (w < 0) return null;
  const idx = s.index[c];
  const o = s.other[i];
  let win = -1;
  let other = -1;
  for (let q = 0; q < idx.length; q++) {
    if (idx[q] === w) win = q;
    else if (idx[q] === o) other = q;
  }
  if (win < 0) return null;
  slot.win = win;
  slot.other = other;
  slot.mix = EDGE_FLOOR + (1 - EDGE_FLOOR) * 2 * s.mix[i];
  return slot;
}
const slot = { win: -1, other: -1, mix: 0 };
// 没传到这里、也不是交界的那一种的倍数
export const SPREAD_FLOOR = EDGE_FLOOR;
