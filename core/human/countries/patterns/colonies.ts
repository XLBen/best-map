import { hashString } from '../../../names';
import { mixSeed } from '../../../rng';
import type { CountryMeta } from '../../../world';
import type { GenContext } from '../../context';
import { composedDims, dimensionValues } from '../../era';
import { makeFlag } from '../../flags';
import { titled } from '../../government';
import { GroupTable, readComp, writeComp } from '../../groups';
import { COAST } from '../../rules';
import { noiseAt } from '../../space';
import { pickWeighted } from '../base';
import { type PatternModule, countOf, param } from '../patterns';
import { hexToHsl, hslToHex } from '../records';
import type { Seed } from '../state';
import { bestCell, claimRegion, freeCell, homeLands, lands, releaseRegion, seedAt, tierNear } from './common';

// 殖民地（第七十四轮，只在近现代）：本土（能住人的分量最大的一两块陆地，见 common.ts 的 homeLands）上最大的几国是列强，
// 别的大陆上划出几大块殖民地，归列强管（CountryMeta.subject = 'colony'，overlord 是列强）。
// reserve：在本土以外、够大的陆块上（按还没被圈的能住人的面积挑，随机流 'colonies'）从海边最宜居的一格往里圈一大块
//   （size 个平均的国家；一块陆地最多被圈 landShare 成），一块一个国家（Region：只有它进，它也不出去占能住人的地方），起点记 Seed.overseas。
//   当地的文化不变（起点按当地的文化挑政体）；
// diplomacy：附庸定完以后，本土上最大、不是附庸的 powers 国是列强，每块殖民地按列强的面积挑一个（随机流 'colonies:lord'）；
//   名字 = 列强的地名 + 殖民地的称号（殖民地、属地……，同一个列强的按先后；锁定名字，换政体不改），颜色是列强的浅色；
// 人口之后（stage.ts 的 mixCountries 调 settleColonies）：殖民地里有“新土认同”的那一维时，主流的人里 settler 成掺进新土认同。
// 同盟模式里殖民地跟着宗主（blocs.ts 的 blocMapColors）。多少：几块（小数是再多一块的可能）

export const COLONIES = 'colonies';
const MIN_COUNTRIES = 4;
// 殖民地的称号（同一个列强的按先后；都用过了写“列强属当地”）
const TITLES = [
  { zh: '殖民地', orig: '{name} Colony' },
  { zh: '属地', orig: '{name} Territory' },
  { zh: '总督区', orig: '{name} Governorate' },
  { zh: '海外领', orig: 'Overseas {name}' },
];
// 新土认同（取值的 id）
export const SETTLER = 'settler';

interface ColonyState {
  seeds: Seed[];
  homes: number[];
}

export const colonies: PatternModule = {
  id: COLONIES,
  name: '殖民地',
  description: '本土以外的大陆上划出几大块殖民地，归本土上最大的几国（列强）管；当地的文化不变',
  amountHint: '几块；小数是再多一块的可能',
  tip: '近现代：列强在别的大陆上划出大块殖民地，地图上用宗主的浅色',
  params: [
    { key: 'size', label: '多大', min: 0.5, max: 20, step: 0.5, default: 2.5, hint: '一块殖民地是几个平均的国家大' },
    { key: 'landShare', label: '最多占几成', min: 0.1, max: 1, step: 0.05, default: 0.7, hint: '一块陆地最多被划成殖民地的几成' },
    { key: 'powers', label: '几个列强', min: 1, max: 8, step: 1, default: 3, hint: '本土上最大的几国分殖民地' },
    { key: 'homes', label: '几块本土', min: 1, max: 2, step: 1, default: 1, hint: '能住人的分量最大的一块或两块陆地是本土（第二块不到第一块的三成时只算一块）' },
    { key: 'settlers', label: '移民几成', min: 0, max: 1, step: 0.05, default: 0.3, hint: '殖民地里主流的人有几成换成“新土认同”（时代有这一维时）' },
  ],

  reserve(g, use) {
    if (!(use.amount > 0) || g.total < MIN_COUNTRIES) return;
    const rand = g.stream(COLONIES);
    const want = countOf(use.amount, rand());
    if (!want) return;
    const { ctx, world } = g;
    const { x, hab } = ctx;
    const L = lands(g);
    const homes = homeLands(g, param(this, use, 'homes'));
    if (!homes.length) return;
    const target = param(this, use, 'size') * g.T;
    const share = param(this, use, 'landShare');
    const taken = new Float64Array(L.area.length);
    const st: ColonyState = { seeds: [], homes };
    for (let q = 0; q < want && g.rest > 2; q++) {
      const room = (c: number) => Math.min(share * L.area[c] - taken[c], L.area[c] - taken[c]);
      const choices = [...L.area.keys()].filter((c) => !homes.includes(c) && room(c) >= 0.6 * target);
      if (!choices.length) break;
      const comp = pickWeighted(choices, room, rand)!;
      const ns = g.mix('colonies-center', q);
      const ok = (i: number) => freeCell(g, i) && L.id[i] === comp;
      const center = bestCell(g, (i) => ok(i) && (x.flags[i] & COAST) !== 0, (i) => hab[i] * (1 + 0.35 * noiseAt(world, ns, 500, i)));
      if (center < 0) continue;
      const k0 = g.regions.length;
      const { cells, got } = claimRegion(g, center, Math.min(target, room(comp)), k0, ok);
      if (got < 0.4 * target) {
        releaseRegion(g, cells);
        taken[comp] = L.area[comp];
        continue;
      }
      taken[comp] += got;
      const seed = seedAt(g, center, tierNear(g, got / g.T), got, k0, rand);
      seed.overseas = true;
      g.isSeed[center] = 1;
      g.regions.push({ pattern: COLONIES, group: ctx.cultureGroup[seed.culture], seeds: [seed] });
      st.seeds.push(seed);
      g.rest -= 1;
    }
    if (st.seeds.length) g.state.set(COLONIES, st);
  },

  // 附庸定完以后：列强、宗主、名字、颜色
  diplomacy(g, use) {
    const st = g.state.get(COLONIES) as ColonyState | undefined;
    if (!st) return;
    const { seeds } = g;
    const metas = g.metas!;
    const areaOf = g.areaOf!;
    const overlord = g.overlord!;
    const L = lands(g);
    const want = Math.max(1, Math.round(param(this, use, 'powers')));
    const powers = seeds
      .map((_, o) => o)
      .filter((o) => seeds[o].region < 0 && overlord[o] < 0 && st.homes.includes(L.id[seeds[o].cell]) && areaOf[o] > 0)
      .sort((a, b) => areaOf[b] - areaOf[a] || a - b)
      .slice(0, want);
    if (!powers.length) return;
    const names = new Set(metas.map((m) => m.name));
    const colors = new Set(metas.map((m) => m.color));
    const count = new Map<number, number>();
    st.seeds.forEach((sd, q) => {
      const c = seeds.indexOf(sd);
      if (c < 0 || !(areaOf[c] > 0)) return;
      const lord = pickWeighted(powers, (o) => areaOf[o], g.stream('colonies:lord', q))!;
      overlord[c] = lord;
      const m = metas[c];
      const p = metas[lord];
      m.overlord = p.id;
      m.subject = 'colony';
      const t = count.get(lord) ?? 0;
      count.set(lord, t + 1);
      names.delete(m.name);
      const base = p.base?.zh ? p.base : { zh: p.name };
      let name = t < TITLES.length ? titled(base, TITLES[t]) : undefined;
      if (!name || names.has(name.zh)) name = { zh: `${base.zh}属${m.base.zh}` };
      m.name = name.zh;
      if (name.orig) m.orig = name.orig;
      else delete m.orig;
      names.add(m.name);
      colors.delete(m.color);
      m.color = colonyColor(p.color, t, colors);
      m.flag = makeFlag(mixSeed(g.seed, hashString('flag'), m.id), m.color, { categories: sd.gov.category, layouts: sd.gov.layouts, emblems: sd.gov.emblems });
      // 名字不随政体自动改（同联邦的成员邦）
      m.nameLocked = true;
    });
  },
};

// 殖民地的颜色：宗主的颜色变浅（往白挪），同一个宗主的几块色相挪一挪；已用的避开
export function colonyColor(lord: string, k: number, used: Set<string>): string {
  const [h, s, l] = hexToHsl(lord);
  for (let t = 0; t < 24; t++) {
    const q = k + t;
    const c = hslToHex(h + (((q * 23) % 25) - 12), Math.max(0.2, s * 0.85), Math.min(0.88, l + 0.2 + 0.04 * (q % 3)));
    if (!used.has(c)) {
      used.add(c);
      return c;
    }
  }
  return lord.toLowerCase();
}

// 人口之后：殖民地里主流的人有 settlers 成换成“新土认同”（时代的维度里有 settler 这个取值时；手改过的格不动）。
// 殖民地按档案认（subject 是 colony），重新生成人文、不换国家时也一样。返回改没改
export function settleColonies(ctx: GenContext, table: GroupTable, settlers: number): boolean {
  const { world, keep, era } = ctx;
  const { small, causes } = world;
  const country = causes.country;
  if (!country || !small.countries || !causes.popTotal || !(settlers > 0)) return false;
  const colonyIds = new Set(Object.values(small.countries).flatMap((m: CountryMeta) => (m.subject === 'colony' && m.overlord !== undefined ? [m.id] : [])));
  if (!colonyIds.size) return false;
  const dim = composedDims(era).find((d) => dimensionValues(small, d.id, era.id).some((v) => v.id === SETTLER));
  if (!dim) return false;
  let changed = false;
  for (let i = 0; i < country.length; i++) {
    if (!colonyIds.has(country[i]) || keep?.[i] || !(causes.popTotal[i] > 0)) continue;
    const comp = readComp(causes, i);
    const first = comp[0];
    const t = first && table.get(first.code);
    if (!t || t.values[dim.id] === SETTLER) continue;
    const code = table.code({ culture: t.culture, values: { ...t.values, [dim.id]: SETTLER } });
    writeComp(causes, i, [{ code: first.code, s: first.s * (1 - settlers) }, ...comp.slice(1), { code, s: first.s * settlers }]);
    changed = true;
  }
  return changed;
}
