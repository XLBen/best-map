import type { Bloc } from '../../../world';
import { ALLIANCE_COLORS, largest } from '../../blocs';
import { COAST, RIVER } from '../../rules';
import { noiseAt } from '../../space';
import { MEMBER_PARAMS, type PatternModule, countOf, param } from '../patterns';
import { bestCell, claimRegion, freeCell, releaseRegion, scatterSeeds, seedAt, shareBudget, smallestTier } from './common';

// 城邦群（第七十四轮，青铜与古典）：最宜居的一段海岸或河谷里撒 8–15 个城邦级的小国，结成一个同盟。
// reserve：中心是挨着海或河、宜居度最高的一格（加一点噪声，随机流的种子 'city-league-center'）；从中心往外圈一片
//   （沿海岸、河谷走：别的格贵三倍），大约是成员个数 × 城邦级的面积；在里面像神圣帝国那样撒起点（scatterSeeds），都是城邦级。
//   这一片只有成员进（Region）。用掉的国家个数按面积算（这一片有几个平均的国家大），小世界里也放得下；
// relate：领土补齐之后成员（还有地的、不在别的同盟里的，至少两个）结成一个同盟，盟主是最大的城邦。
// 多少：几群（小数是再多一群的可能）。随机流 'city-league'、'city-league'（第几群）

export const CITY_LEAGUE = 'city-league';

export const cityLeague: PatternModule = {
  id: CITY_LEAGUE,
  name: '城邦群',
  description: '最宜居的一段海岸或河谷里很多城邦级的小国，结成一个同盟',
  amountHint: '几群；小数是再多一群的可能',
  params: [...MEMBER_PARAMS(8, 15), { key: 'room', label: '每个多大', min: 0.5, max: 4, step: 0.1, default: 1.2, hint: '每个城邦大约是城邦级面积的几倍' }],

  reserve(g, use) {
    if (!(use.amount > 0)) return;
    const rand = g.stream(CITY_LEAGUE);
    const want = countOf(use.amount, rand());
    if (!want || g.total < 2) return;
    const { ctx, world } = g;
    const { x, hab } = ctx;
    const cultureOf = ctx.cultureOf!;
    const tier = smallestTier(g);
    const minM = Math.round(param(this, use, 'minMembers'));
    const maxM = Math.max(minM, Math.round(param(this, use, 'maxMembers')));
    const room = param(this, use, 'room');
    const shore = (i: number) => (x.flags[i] & (COAST | RIVER)) !== 0;
    for (let q = 0; q < want && g.rest > 1; q++) {
      const nc = minM + Math.floor(rand() * (maxM - minM + 1));
      const ns = g.mix('city-league-center', q);
      const center = bestCell(g, (i) => freeCell(g, i) && shore(i), (i) => hab[i] * (1 + 0.35 * noiseAt(world, ns, 400, i)));
      if (center < 0) break;
      const gi = ctx.cultureGroup[cultureOf[center]];
      const k0 = g.regions.length;
      const target = nc * tier.area * g.T * room;
      const { cells, got } = claimRegion(g, center, target, k0, (i) => freeCell(g, i), (j) => (shore(j) ? 1 : 3));
      // 地方不够（一小块岛、窄的谷地）：不要这一片
      if (got < 0.5 * target || cells.length < 2 * nc) {
        releaseRegion(g, cells);
        continue;
      }
      const seeds = g.stream(CITY_LEAGUE, q);
      const list = scatterSeeds(g, cells, k0, center, nc, (_, pick) => seedAt(g, pick, tier, tier.area * (0.7 + 0.6 * seeds()), k0, seeds), false);
      shareBudget(list, got);
      g.regions.push({ pattern: CITY_LEAGUE, group: gi, seeds: list });
      g.rest = Math.max(1, g.rest - Math.max(1, Math.round(got / g.T)));
    }
  },

  // 每一群结成一个同盟（同盟的颜色按先后挑没用过的）
  relate(g) {
    const b = g.bloc!;
    const ids = g.ids;
    if (!ids) return;
    const metas = g.world.small.countries!;
    g.regions.forEach((r, q) => {
      if (r.pattern !== CITY_LEAGUE) return;
      const members = g.seeds.flatMap((s, o) => (s.region === q && metas[ids[o]] && (b.area.get(ids[o]) ?? 0) > 0 && !b.inAlliance.has(ids[o]) ? [ids[o]] : []));
      if (members.length < 2) return;
      const leader = largest(members, b.area);
      const used = new Set(b.blocs.filter((x) => x.kind === 'alliance').map((x) => x.color));
      const bl: Bloc = {
        id: b.nid++,
        kind: 'alliance',
        name: '',
        leader,
        members: [leader, ...members.filter((x) => x !== leader)],
        color: ALLIANCE_COLORS.find((cc) => !used.has(cc)) ?? ALLIANCE_COLORS[q % ALLIANCE_COLORS.length],
      };
      b.name(bl);
      b.blocs.push(bl);
      for (const id of members) b.inAlliance.add(id);
    });
  },
};
