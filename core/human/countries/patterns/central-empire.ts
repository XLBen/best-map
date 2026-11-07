import { pickWeighted } from '../base';
import { cellKm2, noiseAt } from '../../space';
import { type PatternModule, countOf, param } from '../patterns';
import type { Seed } from '../state';
import { biggestTier, bestCell, freeCell, openCore, seedAt } from './common';

// 集权帝国（第七十四轮，中世纪）：一个文化组的腹地里一个很大的国家，没有成员国（不是神圣帝国那样诸侯林立，也不切成联邦）。
// reserve 在能住人的分量大的文化组（不到最大那一组一半的不挑，按分量挑，随机流 'central-empire'）最宜居的一格放起点，起点一带（预算的两成）在挑普通起点时占着；
// grow 把预算提到至少比别的国家大两成五、每一步的代价少 pace 成，所以它是最大的国家。政体偏紧凑的（cohesion）。
// 多少：几个（小数是再多一个的可能）。国家不到 4 个时不放

export const CENTRAL_EMPIRE = 'central-empire';
const MIN_COUNTRIES = 4;

export const centralEmpire: PatternModule = {
  id: CENTRAL_EMPIRE,
  name: '集权帝国',
  description: '一个文化组的腹地里一个很大的集权国家，没有成员国，是最大的国家',
  amountHint: '几个；小数是再多一个的可能',
  params: [
    { key: 'size', label: '多大', min: 0.5, max: 20, step: 0.5, default: 6, hint: '面积预算是几个平均的国家（不超过能住人的地方的三成；至少比别的国家大两成五）' },
    { key: 'pace', label: '长得快', min: 0, max: 1, step: 0.05, default: 0.4, hint: '往外长时每一步的代价少几成（集权的大国推进得快）' },
  ],

  reserve(g, use) {
    if (!(use.amount > 0) || g.total < MIN_COUNTRIES) return;
    const rand = g.stream(CENTRAL_EMPIRE);
    const want = countOf(use.amount, rand());
    if (!want) return;
    const { ctx, world } = g;
    const { hab } = ctx;
    const cultureOf = ctx.cultureOf!;
    const G = ctx.groups.length;
    const tier = biggestTier(g);
    const budget = Math.min(param(this, use, 'size') * g.T, 0.3 * g.area);
    const used = new Set<number>();
    const list: Seed[] = [];
    for (let q = 0; q < want && g.rest > 2; q++) {
      // 还没被圈的、能住人的分量
      const massG = new Float64Array(G);
      for (let i = 0; i < g.n; i++) if (freeCell(g, i)) massG[ctx.cultureGroup[cultureOf[i]]] += cellKm2(world, i) * hab[i];
      let top = 0;
      for (let gr = 0; gr < G; gr++) if (!used.has(gr)) top = Math.max(top, massG[gr]);
      // 分量够大的几组（不到最大那一组的一半的不挑）
      const choices = [...Array(G).keys()].filter((gr) => !used.has(gr) && massG[gr] > 0 && massG[gr] >= 0.5 * top);
      if (!choices.length) break;
      const gi = pickWeighted(choices, (v) => massG[v], rand)!;
      used.add(gi);
      const ns = g.mix('central-empire-center', q);
      const ok = (i: number) => freeCell(g, i) && ctx.cultureGroup[cultureOf[i]] === gi;
      const center = bestCell(g, ok, (i) => hab[i] * (1 + 0.35 * noiseAt(world, ns, 800, i)));
      if (center < 0) continue;
      const seed = seedAt(g, center, tier, budget, -1, rand, (gv) => 0.25 + gv.cohesion);
      openCore(g, CENTRAL_EMPIRE, seed, 0.2 * budget, ok);
      list.push(seed);
      g.rest -= 1;
    }
    if (list.length) g.state.set(CENTRAL_EMPIRE, list);
  },

  // 预算至少比别的国家（不算别的集权帝国）大两成五；往外长时每一步的代价 ×(1 − pace)
  grow(g, use) {
    const list = g.state.get(CENTRAL_EMPIRE) as Seed[] | undefined;
    if (!list) return;
    let top = 0;
    for (const s of g.seeds) if (!list.includes(s)) top = Math.max(top, s.budget);
    for (const s of list) s.budget = Math.min(Math.max(s.budget, 1.25 * top), 0.35 * g.area);
    const pace = 1 - param(this, use, 'pace');
    if (pace === 1) return;
    const on = new Uint8Array(g.seeds.length);
    for (const s of list) on[g.seeds.indexOf(s)] = 1;
    g.stepCost.push((o, _j, c) => (on[o] ? c * pace : c));
  },
};
