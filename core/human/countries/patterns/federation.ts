import type { CountryMeta } from '../../../world';
import { federate } from '../../federate';
import { governmentById } from '../../government';
import { worldTiers } from '../../tiers';
import { averageCountryKm2 } from '../count';
import { type PatternModule, countOf } from '../patterns';

// 联邦（第二十六轮，在集团一步里；第七十三轮挪成格局）：挑几个大国（能分成联邦的等级、够 48 格；越大越容易，联邦制的政体 × 4），
// 从首都起按离得最远挑几个起点、按距离分成 4–12 个成员邦（有省份时整省归一邦，见 federate.ts）。多少：几个（小数是再多一个的可能）。
// 代码从 blocs.ts 原样搬来：个数从共用的随机流 'blocs' 取（时代没列联邦时也取这一个数），切的种子是 'federation'

export const federation: PatternModule = {
  id: 'federation',
  name: '联邦',
  description: '几个大国按地区分成 4–12 个成员邦，在国家模式里画成一种颜色',
  amountHint: '几个；小数是再多一个的可能',

  relate(g, use) {
    const b = g.bloc!;
    const { ctx, world } = g;
    const small = world.small;
    const metas = small.countries!;
    const rand = b.rand;
    const area = b.area;
    const fresh = (m: CountryMeta) => !m.locked;
    const nFed = countOf(use.amount, rand());
    if (!(nFed > 0)) return;
    const T = averageCountryKm2(ctx.era, g.plan.rules.fragmentation);
    const cells = new Map<number, number>();
    const c = world.causes.country!;
    for (let i = 0; i < c.length; i++) if (c[i] >= 0) cells.set(c[i], (cells.get(c[i]) ?? 0) + 1);
    // 能分成联邦的等级（第四十二轮：等级的 federation，内置的是王国级、帝国级）
    const fedTiers = new Set(worldTiers(small).flatMap((t) => (t.federation ? [t.id] : [])));
    const cands = Object.values(metas).filter((m) => fresh(m) && !b.inUnion.has(m.id) && m.overlord === undefined && m.tier !== undefined && fedTiers.has(m.tier) && (cells.get(m.id) ?? 0) >= 48);
    for (let q = 0; q < nFed && cands.length; q++) {
      // 越大越容易（面积的平方），联邦制的政体 × 4
      const w = (m: CountryMeta) => (area.get(m.id) ?? 0) ** 2 * (governmentById(small, m.government)?.category.includes('federation') ? 4 : 1);
      let total = 0;
      for (const m of cands) total += w(m);
      let r = rand() * total;
      let k = 0;
      for (; k < cands.length - 1; k++) {
        r -= w(cands[k]);
        if (r <= 0) break;
      }
      const m = cands.splice(k, 1)[0];
      const parts = Math.min(12, Math.floor((cells.get(m.id) ?? 0) / 8), Math.max(4, Math.round((area.get(m.id) ?? 0) / (0.35 * T))));
      if (parts < 4) continue;
      const bl = federate(ctx, m, parts, g.mix('federation', m.id), b.nid);
      if (!bl) continue;
      b.nid++;
      b.blocs.push(bl);
      for (const id of bl.members) b.inUnion.add(id);
      b.split = true;
    }
  },
};
