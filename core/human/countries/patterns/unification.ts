import { pickWeighted } from '../base';
import { type PatternModule, countOf, param } from '../patterns';
import { mergeOwners, ownerArea, ownerNeighbours, plainSeed } from './common';

// 民族统一（第七十四轮，近现代）：长完以后，一个分成好几国的文化组里最大的那一国把挨着的、同一文化组的国家一个个并进来
// （像德意志、意大利的统一）。挑哪个文化组按“能并的国家有几个”（至少三国）挑；从统一者往外，每个挨着的同组国家按 joinChance 的可能并进来，
// 并进来的再往外拉，最多 most 国。预留的地方里的国家（诸侯、城邦、殖民地）、多民族的大国不并、也不当统一者；
// 这时还没有附庸（附庸在建档案以后才定），所以并的都是独立的国家。多少：几次（每次一个文化组；小数是再多一次的可能）。
// 随机流 'unification'、'unification'（第几次）

export const UNIFICATION = 'unification';

export const unification: PatternModule = {
  id: UNIFICATION,
  name: '民族统一',
  description: '一个分成好几国的文化组里，最大的那一国把挨着的同组国家并成一国',
  amountHint: '几次（一次一个文化组）；小数是再多一次的可能',
  params: [
    { key: 'joinChance', label: '并进来的可能', min: 0, max: 1, step: 0.05, default: 0.75, hint: '挨着的同组国家各自被并进来的可能' },
    { key: 'most', label: '最多几国', min: 2, max: 20, step: 1, default: 8, hint: '一次最多几国并成一国（算上统一者）' },
  ],

  after(g, use) {
    if (!(use.amount > 0)) return;
    const rand = g.stream(UNIFICATION);
    const want = countOf(use.amount, rand());
    if (!want) return;
    const { seeds } = g;
    const k = seeds.length;
    if (k < 3) return;
    const share = param(this, use, 'joinChance');
    const most = Math.max(2, Math.round(param(this, use, 'most')));
    const area = ownerArea(g);
    const near = ownerNeighbours(g);
    const ok = (o: number) => plainSeed(seeds[o]) && area[o] > 0;
    const into = Int32Array.from({ length: k }, (_, o) => o);
    const done = new Uint8Array(k);
    const usedG = new Set<number>();
    let merged = 0;
    for (let q = 0; q < want; q++) {
      // 每个文化组能并的国家
      const byGroup = new Map<number, number[]>();
      for (let o = 0; o < k; o++) {
        if (!ok(o) || done[o]) continue;
        const gr = g.primGroup[o];
        if (usedG.has(gr)) continue;
        const l = byGroup.get(gr);
        if (l) l.push(o);
        else byGroup.set(gr, [o]);
      }
      const choices = [...byGroup.keys()].filter((gr) => byGroup.get(gr)!.length >= 3).sort((a, b) => a - b);
      if (!choices.length) break;
      const gr = pickWeighted(choices, (v) => byGroup.get(v)!.length - 2, rand)!;
      usedG.add(gr);
      const list = byGroup.get(gr)!;
      const leader = list.reduce((a, b) => (area[b] > area[a] ? b : a));
      const r = g.stream(UNIFICATION, q);
      const members = [leader];
      done[leader] = 1;
      let frontier = [leader];
      while (frontier.length && members.length < most) {
        const next: number[] = [];
        for (const u of frontier) {
          for (const v of near[u]) {
            if (done[v] || !ok(v) || g.primGroup[v] !== gr || members.length >= most) continue;
            done[v] = 1;
            if (!(r() < share)) continue;
            members.push(v);
            into[v] = leader;
            next.push(v);
          }
        }
        frontier = next;
      }
      merged += members.length - 1;
    }
    if (merged) mergeOwners(g, into);
    g.state.set(UNIFICATION, merged);
  },
};
