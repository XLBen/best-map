import { RIVER } from '../../rules';
import { cellKm2, noiseAt } from '../../space';
import { type PatternModule, countOf, param } from '../patterns';
import type { Seed } from '../state';
import { biggestTier, bestCell, freeCell, openCore, seedAt } from './common';

// 大河帝国（第七十四轮，青铜与古典）：在最大的河谷（流域里有河的、能住人的格的分量最大的那一个流域）放一个集权的大国，
// 起点在河边最宜居的地方；往外长时沿这条河、在这个流域里更便宜（grow 往 g.stepCost 加），出了流域更贵，所以国土顺着河谷。
// 起点一带（预算的两成）在挑普通起点时占着（Region.open），别国的起点不放在它旁边。
// 多少：几个（每个一个流域，从大到小；小数是再多一个的可能）。随机流 'river-empire'

export const RIVER_EMPIRE = 'river-empire';
// 国家不到几个时不放（大河帝国要占掉一大块）
const MIN_COUNTRIES = 3;

interface RiverState {
  // 每个大河帝国：起点、流域（出口那一格）
  list: { seed: Seed; basin: number }[];
}

export const riverEmpire: PatternModule = {
  id: RIVER_EMPIRE,
  name: '大河帝国',
  description: '最大的河谷里一个集权的大国，国土顺着大河长',
  amountHint: '几个（一个流域一个）；小数是再多一个的可能',
  params: [
    { key: 'size', label: '最大多大', min: 0.5, max: 20, step: 0.5, default: 6, hint: '面积预算是这个流域能住人的地方那么大，最多几个平均的国家（不超过能住人的地方的三成）' },
    { key: 'river', label: '沿河', min: 0, max: 1, step: 0.05, default: 0.75, hint: '沿着河、在流域里长得多容易；0 和别的国家一样' },
  ],

  reserve(g, use) {
    if (!(use.amount > 0) || g.total < MIN_COUNTRIES) return;
    const rand = g.stream(RIVER_EMPIRE);
    const want = countOf(use.amount, rand());
    if (!want) return;
    const { ctx, world } = g;
    const { x, hab, d } = ctx;
    const basin = d.basin;
    // 每个流域里有河、能住人的格的分量；整个流域能住人的面积
    const score = new Map<number, number>();
    const room = new Map<number, number>();
    for (let i = 0; i < g.n; i++) {
      if (!freeCell(g, i) || basin[i] < 0) continue;
      room.set(basin[i], (room.get(basin[i]) ?? 0) + cellKm2(world, i));
      if (x.flags[i] & RIVER) score.set(basin[i], (score.get(basin[i]) ?? 0) + cellKm2(world, i) * hab[i]);
    }
    const basins = [...score.keys()].sort((a, b) => score.get(b)! - score.get(a)! || a - b);
    const tier = biggestTier(g);
    const size = param(this, use, 'size');
    const st: RiverState = { list: [] };
    for (let q = 0; q < want && q < basins.length && g.rest > 1; q++) {
      const b = basins[q];
      const ns = g.mix('river-empire-center', q);
      const ok = (i: number) => freeCell(g, i) && basin[i] === b;
      const center = bestCell(g, (i) => ok(i) && (x.flags[i] & RIVER) !== 0, (i) => hab[i] * (1 + 0.35 * noiseAt(world, ns, 500, i)));
      if (center < 0) continue;
      // 预算：这个流域能住人的地方那么大（至少一个平均的国家，至多 size 个、能住人的地方的三成）
      const budget = Math.min(Math.max(room.get(b)!, g.T), size * g.T, 0.3 * g.area);
      const seed = seedAt(g, center, tier, budget, -1, rand);
      // 核心：沿河圈预算的两成（不是河的格贵三倍）
      openCore(g, RIVER_EMPIRE, seed, 0.2 * budget, ok, (j) => ((x.flags[j] & RIVER) !== 0 ? 1 : 3));
      st.list.push({ seed, basin: b });
      g.rest -= 1;
    }
    if (st.list.length) g.state.set(RIVER_EMPIRE, st);
  },

  // 沿河更便宜：河上 ×(1 − 0.75 s)，流域里 ×(1 − 0.35 s)，出了流域 ×(1 + 2 s)
  grow(g, use) {
    const st = g.state.get(RIVER_EMPIRE) as RiverState | undefined;
    if (!st) return;
    const s = param(this, use, 'river');
    if (!(s > 0)) return;
    const { x, d } = g.ctx;
    const k = g.seeds.length;
    const basinOf = new Int32Array(k).fill(-2);
    for (const r of st.list) {
      const o = g.seeds.indexOf(r.seed);
      if (o >= 0) basinOf[o] = r.basin;
    }
    const onRiver = 1 - 0.75 * s;
    const inBasin = 1 - 0.35 * s;
    const outside = 1 + 2 * s;
    const basin = d.basin;
    const flags = x.flags;
    g.stepCost.push((o, j, c) => {
      const b = basinOf[o];
      if (b === -2) return c;
      if (basin[j] !== b) return c * outside;
      return c * ((flags[j] & RIVER) !== 0 ? onRiver : inBasin);
    });
  },
};
