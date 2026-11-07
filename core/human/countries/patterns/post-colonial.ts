import { type PatternModule, countOf, param } from '../patterns';
import { homeLands, lands, ownerArea, plainSeed, dropSeeds } from './common';

// 前殖民地国家（第七十四轮，现代）：本土（能住人的分量最大的一两块陆地）以外的大陆上，国界是殖民者在地图上画的直线：
// 长完以后，这块陆地上各国的地方按离哪国的首都最近重新分（平面上按直线距离、星球上按大圆，分出来的国界是直的），不看文化，
// 所以一国里住着好几个文化。只分本来就有主的格；预留的地方里的国家（殖民地……）、多民族的大国不动。
// 多少：几块陆地（从大到小；小数是再多一块的可能，随机流 'post-colonial'）。一块陆地上不到三国时不分

export const POST_COLONIAL = 'post-colonial';

export const postColonial: PatternModule = {
  id: POST_COLONIAL,
  name: '前殖民地国家',
  description: '本土以外的大陆上国界是直线，一国里住着好几个文化',
  amountHint: '几块陆地（从大到小）；小数是再多一块的可能',
  params: [{ key: 'homes', label: '几块本土', min: 1, max: 2, step: 1, default: 1, hint: '能住人的分量最大的一块或两块陆地是本土（第二块不到第一块的三成时只算一块），不画直线' }],

  after(g, use) {
    if (!(use.amount > 0)) return;
    const want = countOf(use.amount, g.stream(POST_COLONIAL)());
    if (!want) return;
    const { seeds, owner, world } = g;
    const L = lands(g);
    const homes = homeLands(g, param(this, use, 'homes'));
    if (!homes.length) return;
    const area = ownerArea(g);
    const k = seeds.length;
    // 各陆块上能分的国家（首都在这块陆地上）
    const on = new Map<number, number[]>();
    for (let o = 0; o < k; o++) {
      if (!plainSeed(seeds[o]) || !(area[o] > 0)) continue;
      const c = L.id[seeds[o].cell];
      if (c < 0 || homes.includes(c)) continue;
      const l = on.get(c);
      if (l) l.push(o);
      else on.set(c, [o]);
    }
    const lands_ = [...on.keys()].filter((c) => on.get(c)!.length >= 3).sort((a, b) => L.mass[b] - L.mass[a] || a - b).slice(0, want);
    if (!lands_.length) return;
    const mesh = world.mesh;
    const sphere = mesh.kind === 'sphere';
    // 离首都的远近：星球上按单位向量的点积（越大越近），平面上按距离的平方（越小越近）
    const near = (i: number, cap: number): number => {
      if (sphere) {
        const p = mesh.p;
        return -(p[3 * i] * p[3 * cap] + p[3 * i + 1] * p[3 * cap + 1] + p[3 * i + 2] * p[3 * cap + 2]);
      }
      const dx = mesh.x[i] - mesh.x[cap];
      const dy = mesh.y[i] - mesh.y[cap];
      return dx * dx + dy * dy;
    };
    const which = new Map<number, number[]>(lands_.map((c) => [c, on.get(c)!]));
    const movable = new Uint8Array(k);
    for (const l of which.values()) for (const o of l) movable[o] = 1;
    for (let i = 0; i < g.n; i++) {
      const o = owner[i];
      if (o < 0 || !movable[o]) continue;
      const list = which.get(L.id[i]);
      if (!list) continue;
      let best = o;
      let bd = Infinity;
      for (const q of list) {
        const d = near(i, seeds[q].cell);
        if (d < bd || (d === bd && q < best)) {
          bd = d;
          best = q;
        }
      }
      owner[i] = best;
    }
    g.state.set(POST_COLONIAL, lands_);
    dropSeeds(g, () => false);
  },
};
