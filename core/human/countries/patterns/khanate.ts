import { cellKm2, noiseAt } from '../../space';
import { NOBODY } from '../base';
import { type PatternModule, countOf, param } from '../patterns';
import type { Seed } from '../state';
import { biggestTier, bestCell, openCore, seedAt, steppeSpecies } from './common';

// 游牧汗国（第七十四轮，中世纪）：草原、荒漠上一个很大、松散的游牧国家。草原、荒漠按世界里的生态认（导出用的地形是草原，
// 或大类是荒漠，见 common.ts 的 steppeSpecies），不写死生态的 id。
// reserve：在连成一片的草原、荒漠里最大的那一片（够一个平均的国家大）挑宜居度最高的一格（草原挨着农田的边上）当起点，
//   政体偏游牧的（nomadic），起点一带的草原（预算的两成）在挑普通起点时占着；
// grow：汗国进草原、荒漠更便宜，进别的地方更贵（往 g.stepCost 加），所以国土铺在草原上。
// 多少：几个（每个一片草原，从大到小；小数是再多一个的可能）。随机流 'khanate'。国家不到 4 个、没有够大的草原时不放

export const KHANATE = 'khanate';
const MIN_COUNTRIES = 4;

interface KhanState {
  seeds: Seed[];
  steppe: Uint8Array;
}

export const khanate: PatternModule = {
  id: KHANATE,
  name: '游牧汗国',
  description: '草原、荒漠上一个很大、松散的游牧国家',
  amountHint: '几个（一片草原一个）；小数是再多一个的可能',
  tip: '像中世纪的蒙古：草原、荒漠上一个很大的游牧国家',
  roles: { 'khanate': '游牧汗国' },
  params: [
    { key: 'size', label: '多大', min: 0.5, max: 20, step: 0.5, default: 5, hint: '面积预算是几个平均的国家（不超过能住人的地方的两成）' },
    { key: 'steppe', label: '守着草原', min: 0, max: 1, step: 0.05, default: 0.7, hint: '进草原、荒漠多容易、进别处多难；0 和别的国家一样' },
  ],

  reserve(g, use) {
    if (!(use.amount > 0) || g.total < MIN_COUNTRIES) return;
    const rand = g.stream(KHANATE);
    const want = countOf(use.amount, rand());
    if (!want) return;
    const { ctx, world } = g;
    const { x, hab } = ctx;
    const { mesh } = world;
    const cultureOf = ctx.cultureOf!;
    const bySpecies = steppeSpecies(world.small.species);
    const steppe = new Uint8Array(g.n);
    for (let i = 0; i < g.n; i++) if (x.dry[i] && x.biome[i] >= 0 && bySpecies[x.biome[i]]) steppe[i] = 1;
    // 游牧的能住的地方：宜居度到时代下限的三成（游牧的政体放宽）
    const low = Math.max(NOBODY, 0.3 * g.minH);
    const open = (i: number) => steppe[i] === 1 && g.country[i] < 0 && g.region[i] < 0 && hab[i] >= low && cultureOf[i] >= 0;
    // 连成一片的草原、荒漠：从大到小
    const comp = new Int32Array(g.n).fill(-1);
    const parts: { cells: number[]; area: number }[] = [];
    const stack: number[] = [];
    for (let s0 = 0; s0 < g.n; s0++) {
      if (comp[s0] >= 0 || !open(s0)) continue;
      const cells: number[] = [];
      let area = 0;
      comp[s0] = parts.length;
      stack.push(s0);
      while (stack.length) {
        const i = stack.pop()!;
        cells.push(i);
        area += cellKm2(world, i);
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
          const j = mesh.adj[e];
          if (comp[j] < 0 && open(j)) {
            comp[j] = parts.length;
            stack.push(j);
          }
        }
      }
      parts.push({ cells, area });
    }
    const order = parts.map((_, k) => k).sort((a, b) => parts[b].area - parts[a].area || a - b);
    const tier = biggestTier(g);
    const budget = Math.min(param(this, use, 'size') * g.T, 0.2 * g.area);
    const st: KhanState = { seeds: [], steppe };
    for (let q = 0; q < want && q < order.length && g.rest > 2; q++) {
      const p = order[q];
      if (parts[p].area < g.T) break;
      const ns = g.mix('khanate-center', q);
      const center = bestCell(g, (i) => comp[i] === p && open(i) && hab[i] >= g.minH, (i) => hab[i] * (1 + 0.35 * noiseAt(world, ns, 600, i)));
      if (center < 0) continue;
      // 偏游牧的政体：(0.1 + nomadic)²
      const seed = seedAt(g, center, tier, budget, -1, rand, (gv) => (0.1 + gv.nomadic) ** 2);
      seed.role = KHANATE;
      openCore(g, KHANATE, seed, 0.2 * budget, open);
      st.seeds.push(seed);
      g.rest -= 1;
    }
    if (st.seeds.length) g.state.set(KHANATE, st);
  },

  // 草原、荒漠 ×(1 − 0.6 s)，别处 ×(1 + 3 s)
  grow(g, use) {
    const st = g.state.get(KHANATE) as KhanState | undefined;
    if (!st) return;
    const s = param(this, use, 'steppe');
    if (!(s > 0)) return;
    const on = new Uint8Array(g.seeds.length);
    for (const sd of st.seeds) {
      const o = g.seeds.indexOf(sd);
      if (o >= 0) on[o] = 1;
    }
    const steppe = st.steppe;
    const cheap = 1 - 0.6 * s;
    const dear = 1 + 3 * s;
    g.stepCost.push((o, j, c) => (on[o] ? c * (steppe[j] ? cheap : dear) : c));
  },
};
