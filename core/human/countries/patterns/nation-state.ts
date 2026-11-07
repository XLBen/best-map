import { cellKm2 } from '../../space';
import { type PatternModule, param } from '../patterns';
import { addSeed, mergeOwners, ownerArea, ownerNeighbours, plainSeed, seedAt, tierNear } from './common';

// 民族国家（第七十四轮，现代）：长完以后每个文化组按可能三选一（随机流 'nation-state'，按文化组）：
//   统一（unify）：这一组挨在一起的国家并成一国（一片一国，最大的那一国留下；并成的超过 maxSize 个平均的国家时那一片照旧）；
//   按文化分开（split）：这一组的地方按文化重新分——每个文化一国（已有的、以它为主流的最大那一国；没有时在它最宜居的地方新立一国，
//     它的地方不到半个平均的国家时不立），别的同组国家并掉；组外的人住的地方留给原来的国家（原来的并掉了的归它主流文化的那一国）；
//   照旧：剩下的。
// 预留的地方里的国家（诸侯、城邦、殖民地）、多民族的大国不动。多少：乘在两个比例上（1 照参数，0 都照旧）

export const NATION_STATE = 'nation-state';

export interface NationStateLog {
  unified: number[];
  split: number[];
}

export const nationState: PatternModule = {
  id: NATION_STATE,
  name: '民族国家',
  description: '有的文化组并成一国，有的按文化分成一族一国，别的照旧',
  amountHint: '乘在“并成一国”“一族一国”两个比例上；1 照参数，0 都照旧',
  params: [
    { key: 'unify', label: '并成一国', min: 0, max: 1, step: 0.05, default: 0.3, hint: '一个文化组并成一国的可能' },
    { key: 'split', label: '一族一国', min: 0, max: 1, step: 0.05, default: 0.35, hint: '一个文化组按文化分成一族一国的可能' },
    { key: 'maxSize', label: '并成的国最大', min: 1, max: 40, step: 1, default: 12, hint: '并成的一国最多几个平均的国家大；更大的一片照旧' },
  ],

  after(g, use) {
    if (!(use.amount > 0)) return;
    const pu = Math.min(1, param(this, use, 'unify') * use.amount);
    const ps = Math.min(1 - pu, param(this, use, 'split') * use.amount);
    const maxSize = param(this, use, 'maxSize');
    if (!(pu > 0 || ps > 0)) return;
    const { ctx, world, seeds, owner } = g;
    const { x, hab } = ctx;
    const cultureOf = ctx.cultureOf!;
    const G = ctx.groups.length;
    const log: NationStateLog = { unified: [], split: [] };
    g.state.set(NATION_STATE, log);
    // 每个文化组的去向（每组一个数，先后不随别的组变）
    const fate = new Int8Array(G);
    for (let gr = 0; gr < G; gr++) {
      const r = g.stream(NATION_STATE, gr)();
      fate[gr] = r < pu ? 1 : r < pu + ps ? 2 : 0;
    }
    const k0 = seeds.length;
    const area = ownerArea(g);
    const ok = (o: number) => plainSeed(seeds[o]) && area[o] > 0;
    const into = Int32Array.from({ length: k0 }, (_, o) => o);

    // ---- 按文化分开 ----
    const splitG = [...Array(G).keys()].filter((gr) => fate[gr] === 2);
    if (splitG.length) {
      const inSplit = new Uint8Array(G);
      for (const gr of splitG) inSplit[gr] = 1;
      // 每个文化在这几组的国家里的地方（干的）、最宜居的一格
      const K = ctx.cultures.length;
      const mass = new Float64Array(K);
      const best = new Int32Array(K).fill(-1);
      for (let i = 0; i < g.n; i++) {
        const o = owner[i];
        const c = cultureOf[i];
        if (o < 0 || o >= k0 || c < 0 || !x.dry[i] || !ok(o) || !inSplit[g.primGroup[o]] || ctx.cultureGroup[c] !== g.primGroup[o]) continue;
        mass[c] += cellKm2(world, i);
        if (best[c] < 0 || hab[i] > hab[best[c]]) best[c] = i;
      }
      // 每个文化一国：以它为主流的最大那一国；没有时新立
      const stateOf = new Int32Array(K).fill(-1);
      for (let o = 0; o < k0; o++) {
        if (!ok(o) || !inSplit[g.primGroup[o]]) continue;
        const c = seeds[o].culture;
        if (stateOf[c] < 0 || area[o] > area[stateOf[c]]) stateOf[c] = o;
      }
      const rand = g.stream(NATION_STATE + ':new');
      for (let c = 0; c < K; c++) {
        if (stateOf[c] >= 0 || best[c] < 0 || !inSplit[ctx.cultureGroup[c]] || mass[c] < 0.5 * g.T) continue;
        const cell = best[c];
        const tier = tierNear(g, mass[c] / g.T);
        stateOf[c] = addSeed(g, seedAt(g, cell, tier, mass[c], -1, rand));
      }
      for (const gr of splitG) {
        const has = [...Array(K).keys()].filter((c) => ctx.cultureGroup[c] === gr && stateOf[c] >= 0);
        if (has.length >= 2) log.split.push(gr);
      }
      // 重新分：组里的文化归它的那一国；别的格留给原来的国家，原来的并掉了时归它主流文化的那一国
      const kept = (o: number) => stateOf[seeds[o].culture] === o;
      for (let i = 0; i < g.n; i++) {
        const o = owner[i];
        if (o < 0 || o >= k0 || !ok(o) || !inSplit[g.primGroup[o]]) continue;
        const c = cultureOf[i];
        const to = c >= 0 && ctx.cultureGroup[c] === g.primGroup[o] && stateOf[c] >= 0 ? stateOf[c] : kept(o) ? o : stateOf[seeds[o].culture];
        if (to >= 0) owner[i] = to;
      }
      // 原来的国家没留下的（它的文化归了别的国）：并给它主流文化的那一国（起点那一格也归过去了）
      for (let o = 0; o < k0; o++) if (ok(o) && inSplit[g.primGroup[o]] && !kept(o) && stateOf[seeds[o].culture] >= 0) into[o] = stateOf[seeds[o].culture];
    }

    // ---- 并成一国：这一组挨在一起的一片并给最大的那一国 ----
    const uniteG = [...Array(G).keys()].filter((gr) => fate[gr] === 1);
    if (uniteG.length) {
      const near = ownerNeighbours(g);
      const seen = new Uint8Array(k0);
      for (const gr of uniteG) {
        let any = false;
        for (let s0 = 0; s0 < k0; s0++) {
          if (seen[s0] || !ok(s0) || g.primGroup[s0] !== gr) continue;
          const part = [s0];
          seen[s0] = 1;
          for (let t = 0; t < part.length; t++)
            for (const v of near[part[t]]) {
              if (v >= k0 || seen[v] || !ok(v) || g.primGroup[v] !== gr) continue;
              seen[v] = 1;
              part.push(v);
            }
          let sum = 0;
          for (const o of part) sum += area[o];
          if (part.length < 2 || sum > maxSize * g.T) continue;
          const lead = part.reduce((a, b) => (area[b] > area[a] ? b : a));
          for (const o of part) if (o !== lead) into[o] = lead;
          any = true;
        }
        if (any) log.unified.push(gr);
      }
    }
    const full = new Int32Array(g.seeds.length);
    for (let o = 0; o < full.length; o++) full[o] = o < k0 ? into[o] : o;
    mergeOwners(g, full);
  },
};
