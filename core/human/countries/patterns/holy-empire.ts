import { HeapLite } from '../../../mesh';
import type { Bloc } from '../../../world';
import { largest } from '../../blocs';
import { cellKm2, noiseAt } from '../../space';
import { confedCentre, confedMembers } from '../../tiers';
import { pickWeighted } from '../base';
import { MEMBER_PARAMS, type PatternModule, param } from '../patterns';
import { govFit, govWeights, pickGov } from '../seeds';
import { scatterSeeds, shareBudget } from './common';

// 神圣帝国（第二十六轮的邦联，第七十三轮挪成格局）：一个文化组的一片地方撒很多城邦、小国，长的时候只有它们进那一片；
// 领土补齐之后并成一个帝国（皇帝国是最大的成员）。多少：几片（小数部分是再多一片的可能）。
// 代码从 countries.ts（reserve）、blocs.ts（relate）原样搬来，随机流的名字不变：'country:confederation'、'confederation-center'、'confederation'。
// 第七十四轮：诸侯的个数是参数（最少、最多、占国家的几成；默认 6、14、0.3 和以前一样），撒起点的那一段挪到 common.ts 的 scatterSeeds（城邦群也用）

export const HOLY_EMPIRE = 'holy-empire';

export const holyEmpire: PatternModule = {
  id: HOLY_EMPIRE,
  name: '神圣帝国',
  description: '一个文化组的一片地方诸侯林立：撒很多城邦、小国，并成一个帝国（皇帝的那一国是最大的成员）',
  amountHint: '几片；小数是再多一片的可能',
  tip: '像中世纪的神圣罗马帝国：一片地方诸侯林立，名义上是一个帝国',
  roles: { 'holy-empire': '神圣帝国的成员' },
  params: [...MEMBER_PARAMS(6, 14), { key: 'memberShare', label: '占国家的几成', min: 0, max: 1, step: 0.05, default: 0.3, hint: '诸侯约占国家总数的几成' }],

  // 圈出那一片、放诸侯的起点；占用总个数里的几个
  reserve(g, use) {
    const { ctx, world, country, minH, govs, region, K, T, area, total, massC, areaC, massSum, tierList } = g;
    const { x, hab } = ctx;
    const cultureOf = ctx.cultureOf!;
    const { mesh } = world;
    const n = g.n;
    const confRand = g.stream('country:confederation');
    const want = use.amount;
    const nConf = Math.floor(want) + (confRand() < want - Math.floor(want) ? 1 : 0);
    if (!(nConf > 0 && total >= 10)) return;
    const G = ctx.groups.length;
    const massG = new Float64Array(G);
    const areaG = new Float64Array(G);
    for (let c = 0; c < K; c++) {
      massG[ctx.cultureGroup[c]] += massC[c];
      areaG[ctx.cultureGroup[c]] += areaC[c];
    }
    const usedG = new Set<number>();
    const centreTier = confedCentre(tierList);
    const members = confedMembers(tierList);
    const heap = new HeapLite(1024);
    const dist = new Float64Array(n);
    const minM = param(this, use, 'minMembers');
    const maxM = param(this, use, 'maxMembers');
    const share = param(this, use, 'memberShare');
    for (let q = 0; q < nConf; q++) {
      // 6–14 个成员（国家总数的三成；剩下的至少一半给别的地方；不到 5 个时不撒）。第七十四轮起几个是参数，默认的和以前一样
      const nc = Math.min(maxM, Math.max(minM, Math.round(total * share)), g.rest - Math.ceil(total / 2));
      if (nc < 5) break;
      const choices = [...Array(G).keys()].filter((gr) => !usedG.has(gr) && massG[gr] >= 0.1 * massSum);
      if (!choices.length) break;
      const gi = pickWeighted(choices, (v) => massG[v], confRand)!;
      usedG.add(gi);
      const inGroup = (i: number) => x.dry[i] === 1 && country[i] < 0 && hab[i] >= minH && cultureOf[i] >= 0 && ctx.cultureGroup[cultureOf[i]] === gi && region[i] < 0;
      // 中心：这一组里宜居度最高的格（加一点噪声）
      const ns = g.mix('confederation-center', q);
      let center = -1;
      let cs = -Infinity;
      for (let i = 0; i < n; i++) {
        if (!inGroup(i)) continue;
        const s = hab[i] * (1 + 0.35 * noiseAt(world, ns, 500, i));
        if (s > cs) {
          cs = s;
          center = i;
        }
      }
      if (center < 0) continue;
      // 从中心往外（按 km）长到一个大国那么大：3 个平均国家、成员多时每国 0.4 个（不超过这一组的一半、所有能住人的地方的五分之一）
      const target = Math.min(Math.max(3, 0.4 * nc) * T, 0.5 * areaG[gi], 0.2 * area);
      const cells: number[] = [];
      let got = 0;
      dist.fill(Infinity);
      heap.size = 0;
      dist[center] = 0;
      heap.push(center, 0);
      while (heap.size && got < target) {
        const i = heap.pop();
        const di = heap.lastKey;
        if (di > dist[i] || region[i] >= 0) continue;
        region[i] = g.regions.length;
        cells.push(i);
        got += cellKm2(world, i);
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
          const j = mesh.adj[e];
          if (!inGroup(j)) continue;
          const nd = di + mesh.dist[e] * world.kmPerUnit;
          if (nd < dist[j]) {
            dist[j] = nd;
            heap.push(j, nd);
          }
        }
      }
      // 地方不够（文化组太零碎）：不要这一片
      if (got < 0.5 * target) {
        for (const i of cells) region[i] = -1;
        continue;
      }
      // 起点：一个个挑离已有的起点、离这一片的边都远（宜居度高的优先）的格（不都挤在边上，各自分得开）
      const k0 = g.regions.length;
      const rand = g.stream('confederation', q);
      const list = scatterSeeds(g, cells, k0, center, nc, (s, pick) => {
        const c = cultureOf[pick];
        const culture = ctx.cultures[c];
        // 中心是邦联的中心那一级（皇帝的本领，内置的是公国级），别的按成员的比例（内置的是城邦级、侯国级）；预算先记倍数，挑完按这一片的面积分
        const tier = s === 0 ? centreTier : pickWeighted(members.list, members.weight, rand)!;
        const w = govWeights(ctx.world, ctx.era, culture, govs);
        const gov = pickGov(govs, (gg) => w(gg) * govFit(gg, tier), rand);
        return { cell: pick, culture: c, gov, tier, budget: tier.area * (0.7 + 0.6 * rand()), region: k0, role: HOLY_EMPIRE };
      });
      shareBudget(list, got);
      g.regions.push({ pattern: HOLY_EMPIRE, group: gi, seeds: list });
      g.rest -= list.length;
    }
  },

  // 帝国：每一片的成员（国家一步建了档案的；领土补齐之后还有地的、不在别的帝国或联邦里的，至少两个）
  relate(g) {
    const b = g.bloc!;
    const ids = g.ids;
    if (!ids) return;
    const metas = g.world.small.countries!;
    const confs = g.regions
      .map((r, q) => ({ r, members: g.seeds.flatMap((s, o) => (s.region === q ? [ids[o]] : [])) }))
      .filter((cf) => cf.r.pattern === HOLY_EMPIRE && cf.members.length >= 2);
    for (const cf of confs) {
      const members = cf.members.filter((id) => metas[id] && (b.area.get(id) ?? 0) > 0 && !b.inUnion.has(id));
      if (members.length < 2) continue;
      const leader = largest(members, b.area);
      const bl: Bloc = { id: b.nid++, kind: 'empire', name: '', leader, members: [leader, ...members.filter((x) => x !== leader)], color: metas[leader].color };
      b.name(bl);
      b.blocs.push(bl);
      for (const id of members) b.inUnion.add(id);
    }
  },
};
