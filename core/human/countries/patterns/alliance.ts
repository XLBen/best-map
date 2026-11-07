import type { Bloc, CountryMeta } from '../../../world';
import { ALLIANCE_COLORS, neighbours } from '../../blocs';
import { cultureById } from '../../era';
import { countryList } from '../base';
import { type PatternModule, countOf } from '../patterns';

// 军事同盟（第二十六轮，在集团一步里；第七十三轮挪成格局）：挑几个最大、彼此不结盟的国家当盟主（联邦算一个），沿已有的同盟关系往外拉
// （三层以内），再拉进挨着的、与盟主同一文化组的国家（一半）；附庸跟着宗主，联邦整个进。多少：几个（小数是再多一个的可能）。
// 代码从 blocs.ts 原样搬来：个数和“拉不拉进来”都从共用的随机流 'blocs' 取（排在联邦之后；时代没列同盟时也取个数这一个数）

export const alliance: PatternModule = {
  id: 'alliance',
  name: '军事同盟',
  description: '在已有的同盟关系上聚成几个军事集团',
  amountHint: '几个；小数是再多一个的可能',

  relate(g, use) {
    const b = g.bloc!;
    const { world } = g;
    const small = world.small;
    const metas = small.countries!;
    const rand = b.rand;
    const area = b.area;
    const blocs = b.blocs;
    const inAlliance = b.inAlliance;
    const fresh = (m: CountryMeta) => !m.locked;
    const nAll = countOf(use.amount, rand());
    if (!(nAll > 0)) return;
    // 一个“单位”：联邦算一个（盟主代表），别的国家各算一个；附庸跟着宗主
    const fedOf = new Map<number, Bloc>();
    for (const bl of blocs) if (bl.kind === 'federation') for (const id of bl.members) fedOf.set(id, bl);
    const rep = (id: number) => fedOf.get(id)?.leader ?? id;
    const unitArea = (id: number) => (fedOf.has(id) ? fedOf.get(id)!.members.reduce((s, x) => s + (area.get(x) ?? 0), 0) : (area.get(id) ?? 0));
    const units = [...new Set(Object.values(metas).filter((m) => fresh(m) && m.overlord === undefined && !inAlliance.has(m.id)).map((m) => rep(m.id)))].filter((id) => metas[id] && metas[id].overlord === undefined);
    const want = Math.min(nAll, Math.floor(units.length / 3));
    units.sort((x, y) => unitArea(y) - unitArea(x) || x - y);
    const allies = (id: number) => new Set((fedOf.get(id)?.members ?? [id]).flatMap((x) => metas[x]?.allies ?? []).map(rep));
    const leaders: number[] = [];
    for (const u of units) {
      if (leaders.length >= want) break;
      if (leaders.some((l) => allies(l).has(u))) continue;
      leaders.push(u);
    }
    const team = new Map<number, number>(leaders.map((l, k) => [l, k]));
    // 沿已有的同盟关系往外（三层以内，同一层先到的盟主优先）
    let frontier = [...leaders];
    for (let hop = 0; hop < 3 && frontier.length; hop++) {
      const nextF: number[] = [];
      for (const u of frontier) {
        for (const a of [...allies(u)].sort((x, y) => x - y)) {
          if (team.has(a) || !units.includes(a)) continue;
          team.set(a, team.get(u)!);
          nextF.push(a);
        }
      }
      frontier = nextF;
    }
    // 挨着的、与盟主同一文化组的国家一半拉进来
    const nb = neighbours(world);
    const groupOf = (id: number) => cultureById(small, metas[id]?.primaryCulture ?? '')?.group;
    for (const u of units) {
      if (team.has(u)) continue;
      const near = (fedOf.get(u)?.members ?? [u]).flatMap((x) => [...(nb.get(x) ?? [])]).map(rep);
      let to = -1;
      for (const v of near) {
        const t = team.get(v);
        if (t === undefined || groupOf(leaders[t]) !== groupOf(u)) continue;
        if (to < 0 || t < to) to = t;
      }
      if (to >= 0 && rand() < 0.5) team.set(u, to);
    }
    leaders.forEach((l, k) => {
      const members: number[] = [];
      for (const [u, t] of [...team].sort((x, y) => x[0] - y[0])) if (t === k) for (const x of fedOf.get(u)?.members ?? [u]) members.push(x);
      // 附庸跟着宗主（两层）
      for (let pass = 0; pass < 2; pass++)
        for (const m of countryList(small)) if (m.overlord !== undefined && members.includes(m.overlord) && !members.includes(m.id) && fresh(m) && !inAlliance.has(m.id)) members.push(m.id);
      if (members.length < 2) return;
      const used = new Set(blocs.filter((x) => x.kind === 'alliance').map((x) => x.color));
      const bl: Bloc = {
        id: b.nid++,
        kind: 'alliance',
        name: '',
        leader: l,
        members: [l, ...members.filter((x) => x !== l)],
        color: ALLIANCE_COLORS.find((cc) => !used.has(cc)) ?? ALLIANCE_COLORS[k % ALLIANCE_COLORS.length],
      };
      b.name(bl);
      blocs.push(bl);
      for (const x of members) inAlliance.add(x);
    });
  },
};
