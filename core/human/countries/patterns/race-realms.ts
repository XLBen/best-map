import { HeapLite } from '../../../mesh';
import { type Species, biomeGroupOf } from '../../../species';
import type { Bloc } from '../../../world';
import { ALLIANCE_COLORS, largest } from '../../blocs';
import { composedDims, cultureTendency, dimensionValues, type Dimension, weightedList } from '../../era';
import { titled } from '../../government';
import { compilePrefs, prefAt } from '../../habitability';
import { cellKm2, noiseAt } from '../../space';
import { worldTerrainClasses } from '../../terrain-class';
import { NOBODY } from '../base';
import { otherCultureMul, sameCultureMul } from '../grow';
import { MEMBER_PARAMS, type PatternModule, countOf, param } from '../patterns';
import type { CountryRun } from '../state';
import { bestCell, claimRegion, releaseRegion, scatterSeeds, seedAt, shareBudget, steppeSpecies, tierNear } from './common';

// 种族王国（第七十五轮，奇幻）：王国跟着种族喜欢的地方走——精灵守着古林，矮人在山里分成几个要塞小国、结成同盟，
// 兽人在荒原上分成几个部落、结成部落联盟（帝国一类的集团），人类的王国在平原和海岸上。
// 不写死种族、生态的 id：
//   种族那一维：时代里第一个取值写了“喜欢的地方”（prefs）的维度（奇幻是种族，科幻是物种）；
//   地方的三类：古林（生态的大类是森林，biomeGroupOf）、山地（地形类别的通行难度比平地大，movement > 1：丘陵、高原、山地、山峰）、
//     荒原（同汗国：大类是荒漠，或导出的地形是草原，steppeSpecies）；一格可以同时是几类；
//   一个种族住哪一类：它“喜欢的地方”（取值的 prefs）的倍数最大到 strong 以上的才算（精灵 2、矮人 2.5、兽人 2；半身人、侏儒……1.5 不算），
//     喜欢的格里哪一类比全世界的比例多得最多（多出两成以上）就是哪一类；不算的、哪一类都不多的住平原与海岸（人类）；
//   一个文化是哪个种族：文化在这一维上的倾向里最大的那个（精灵文化组 → 精灵）。
// reserve：每个山地、荒原的种族圈几片（多少；小数是再多一片的可能，随机流 'race-realms'）：这个种族的文化住的、连成一片的格里，
//   按这一类地方的面积从大到小挑，从里面这一类地方最宜居的一格往外圈（这一类地方便宜，别处贵六倍）；在里面撒 minMembers–maxMembers 个
//   小国（个数照神圣帝国：国家总数的 memberShare，留一半给别处；每个 memberSize 个平均的国家大），这一片只有它们进（Region）；
// grow：古林的种族的国家起点挪进最近的森林、进别的文化组的森林不难，出了森林最远走 (1 − forest) × 平均的国家的边长（forest 是 1 时只占森林）；
//   平原的种族的国家进别的种族喜欢的地方（精灵住的森林、矮人住的山、兽人住的荒原）贵 1 + 2 plains 倍，平原、海岸便宜一些；
// after（第七十五轮的补充）：精灵不去、要塞和部落出不来而空着的、宜居度到 FILL_HAB 的地方，归最近的别的王国（先平原、山地、荒原的种族的普通国家，
//   最远两个平均的国家的边长；还空着的再从别的国家补，精灵只补森林），所以有主的地方不比以前少（按宜居度算）；
// relate：山地的一片结成同盟（盟主是最大的），荒原的一片结成部落联盟（帝国一类：成员各自一色、外沿一道边线；名字是盟主的地名 + 部落联盟，锁定）。
// 档案里的角色：古林王国、山中要塞同盟的成员、荒原部落联盟的成员

export const RACE_REALMS = 'race-realms';
const MIN_COUNTRIES = 6;
// 喜欢的格里某一类比全世界多出这么多才算住那一类
const LIFT = 1.2;
// 长完以后补的空地：宜居度到这么多的才补（住得下不少人的地方；荒地照旧无主）
const FILL_HAB = 0.4;

// 地方的三类（每格几位）
export const FOREST = 1;
export const UPLAND = 2;
export const WASTE = 4;
export type RaceKind = 'open' | 'forest' | 'upland' | 'waste';
const KIND_BIT: Record<Exclude<RaceKind, 'open'>, number> = { forest: FOREST, upland: UPLAND, waste: WASTE };

export const ROLE_FOREST = `${RACE_REALMS}:forest`;
export const ROLE_HOLD = `${RACE_REALMS}:hold`;
export const ROLE_HORDE = `${RACE_REALMS}:horde`;
// 部落联盟的名字
const HORDE_TITLE = { zh: '{name}部落联盟', orig: '{name} Horde' };

export interface RaceRealmState {
  // 种族那一维（没有时整个模块不做）
  dim: string;
  // 每个种族（取值的 id）住哪一类
  races: Map<string, RaceKind>;
  // 每个文化（ctx.cultures 的下标）的种族、住哪一类（0 平原 1 古林 2 山地 3 荒原）
  raceOf: (string | undefined)[];
  kindOf: Uint8Array;
  // 每格是哪几类地方（FOREST | UPLAND | WASTE）
  land: Uint8Array;
  // 圈的几片：regions 的下标、哪一类
  clusters: { region: number; kind: 'upland' | 'waste'; race: string }[];
}

const KIND_CODE: Record<RaceKind, number> = { open: 0, forest: 1, upland: 2, waste: 3 };

// 种族那一维：时代里第一个取值写了“喜欢的地方”的维度
export function raceDimension(small: CountryRun['world']['small'], era: CountryRun['ctx']['era']): Dimension | undefined {
  return composedDims(era).find((d) => dimensionValues(small, d.id, era.id).some((v) => v.prefs?.length));
}

// 每格是哪几类地方（干的陆地）
export function landKinds(g: Pick<CountryRun, 'n' | 'world' | 'ctx'>): Uint8Array {
  const { ctx, world } = g;
  const { x, cls } = ctx;
  const species: readonly Species[] = world.small.species;
  const forest = Uint8Array.from(species, (sp) => (biomeGroupOf(sp) === 'forest' ? 1 : 0));
  const waste = steppeSpecies(species);
  const move = [1, ...worldTerrainClasses(world.small).map((c) => c.movement ?? 1)];
  const out = new Uint8Array(g.n);
  for (let i = 0; i < g.n; i++) {
    if (!x.dry[i]) continue;
    const b = x.biome[i];
    let v = 0;
    if (b >= 0 && forest[b]) v |= FOREST;
    if (b >= 0 && waste[b]) v |= WASTE;
    if ((move[cls[i]] ?? 1) > 1) v |= UPLAND;
    out[i] = v;
  }
  return out;
}

// 连成一片的 ok 的格（按 weight 的和从大到小；of：每格是第几片）
function patches(g: CountryRun, ok: (i: number) => boolean, weight: (i: number) => number): { id: number; area: number; of: Int32Array }[] {
  const { mesh } = g.world;
  const of = new Int32Array(g.n).fill(-1);
  const out: { id: number; area: number; of: Int32Array }[] = [];
  const stack: number[] = [];
  for (let s0 = 0; s0 < g.n; s0++) {
    if (of[s0] >= 0 || !ok(s0)) continue;
    const id = out.length;
    let area = 0;
    of[s0] = id;
    stack.push(s0);
    while (stack.length) {
      const i = stack.pop()!;
      area += weight(i);
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (of[j] < 0 && ok(j)) {
          of[j] = id;
          stack.push(j);
        }
      }
    }
    out.push({ id, area, of });
  }
  return out.sort((a, b) => b.area - a.area || a.id - b.id);
}

// 各种族住哪一类、各文化的种族（不取随机数；导出给 speed-r79.test.ts 对照）
export function classify(g: CountryRun, strong: number): RaceRealmState | undefined {
  const { ctx, world } = g;
  const { x, cls, hab } = ctx;
  const small = world.small;
  const dim = raceDimension(small, ctx.era);
  if (!dim) return undefined;
  const land = landKinds(g);
  // 能住人的格（宜居度到时代下限的三成，同汗国）：各类的面积
  const low = Math.max(NOBODY, 0.3 * g.minH);
  const area = new Float64Array(g.n);
  let total = 0;
  const kindArea = [0, 0, 0];
  for (let i = 0; i < g.n; i++) {
    if (!x.dry[i] || hab[i] < low) continue;
    const a = cellKm2(world, i);
    area[i] = a;
    total += a;
    for (let k = 0; k < 3; k++) if (land[i] & (1 << k)) kindArea[k] += a;
  }
  // 偏爱够强的种族各自喜欢的格里各类的面积。第七十九轮：所有的格只过一遍（以前每个种族过一遍）；每个种族照旧按格的先后加，和不变。
  // races 先按取值的先后放好（后面按这个先后圈地方），算完再填上住哪一类
  const races = new Map<string, RaceKind>();
  const liking: { id: string; p: ReturnType<typeof compilePrefs>; liked: number; likedKind: number[] }[] = [];
  for (const v of dimensionValues(small, dim.id, ctx.era.id)) {
    races.set(v.id, 'open');
    const top = Math.max(0, ...(v.prefs ?? []).map((p) => p.factor));
    if (top >= strong && total > 0) liking.push({ id: v.id, p: compilePrefs(v.prefs, small.species, ctx.classIds), liked: 0, likedKind: [0, 0, 0] });
  }
  if (liking.length)
    for (let i = 0; i < g.n; i++) {
      if (!(area[i] > 0)) continue;
      for (const r of liking) {
        if (!(prefAt(r.p, x, cls, i) > 1)) continue;
        r.liked += area[i];
        for (let k = 0; k < 3; k++) if (land[i] & (1 << k)) r.likedKind[k] += area[i];
      }
    }
  for (const { id, liked, likedKind } of liking) {
    let best: RaceKind = 'open';
    let lift = LIFT;
    (['forest', 'upland', 'waste'] as const).forEach((kind, k) => {
      if (!(kindArea[k] > 0) || !(liked > 0)) return;
      const l = likedKind[k] / liked / (kindArea[k] / total);
      if (l > lift) {
        lift = l;
        best = kind;
      }
    });
    races.set(id, best);
  }
  const raceOf = ctx.cultures.map((c) => {
    let top: [string, number] | undefined;
    for (const [id, w] of weightedList(cultureTendency(small, c, dim.id, ctx.era.id))) if (races.has(id) && (!top || w > top[1])) top = [id, w];
    return top?.[0];
  });
  const kindOf = Uint8Array.from(raceOf, (r) => KIND_CODE[(r && races.get(r)) || 'open']);
  return { dim: dim.id, races, raceOf, kindOf, land, clusters: [] };
}

// 每格离最近的森林多远（km，陆上走）
function forestDistance(g: CountryRun, land: Uint8Array): Float64Array {
  const { mesh, kmPerUnit } = g.world;
  const out = new Float64Array(g.n).fill(Infinity);
  const heap = new HeapLite(1024);
  for (let i = 0; i < g.n; i++)
    if (land[i] & FOREST) {
      out[i] = 0;
      heap.push(i, 0);
    }
  const dry = g.ctx.x.dry;
  while (heap.size) {
    const i = heap.pop();
    const di = heap.lastKey;
    if (di > out[i]) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (!dry[j]) continue;
      const nd = di + mesh.dist[e] * kmPerUnit;
      if (nd < out[j]) {
        out[j] = nd;
        heap.push(j, nd);
      }
    }
  }
  return out;
}

// 空着的、能住人的格归最近的国家（after 钩子；见 raceRealms.after）：先只从平原、山地、荒原的种族的普通国家（不是精灵的、不在预留地方里的）往外补，
// 最远两个平均的国家的边长；还空着的（要塞、部落、精灵围着的）再从所有的国家补，最远一个边长，精灵只补森林。预留地方里的格只归它的成员。
// 都按 km 走空着的格。返回补了几格
export function fillLeftover(g: CountryRun, st: Pick<RaceRealmState, 'kindOf' | 'land'>): number {
  const elf = (o: number) => st.kindOf[g.seeds[o].culture] === KIND_CODE.forest && g.seeds[o].region < 0;
  const plain = (o: number) => g.seeds[o].region < 0 && !elf(o);
  const edge = Math.sqrt(g.T);
  return fillFrom(g, plain, () => true, 2 * edge) + fillFrom(g, (o) => g.seeds[o].region < 0, (o, j) => !elf(o) || (st.land[j] & FOREST) !== 0, edge);
}

function fillFrom(g: CountryRun, use: (o: number) => boolean, may: (o: number, j: number) => boolean, cap: number): number {
  const { owner, seeds, region, world } = g;
  const { mesh, kmPerUnit } = world;
  const { x, hab } = g.ctx;
  const cultureOf = g.ctx.cultureOf!;
  const src = Uint8Array.from(seeds, (_, o) => (use(o) ? 1 : 0));
  const low = Math.max(g.minH, FILL_HAB);
  const free = (i: number) => owner[i] === -1 && g.country[i] < 0 && x.dry[i] === 1 && hab[i] >= low && cultureOf[i] >= 0;
  // 预留的地方里的格只归它的成员
  const fits = (o: number, j: number) => (region[j] < 0 || region[j] === seeds[o].region) && may(o, j);
  const dist = new Float64Array(g.n).fill(Infinity);
  const to = new Int32Array(g.n).fill(-1);
  const heap = new HeapLite(1024);
  for (let i = 0; i < g.n; i++) {
    const o = owner[i];
    if (o < 0 || !src[o]) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++)
      if (free(mesh.adj[e]) && fits(o, mesh.adj[e])) {
        dist[i] = 0;
        to[i] = o;
        heap.push(i, 0);
        break;
      }
  }
  while (heap.size) {
    const i = heap.pop();
    const di = heap.lastKey;
    if (di > dist[i]) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (!free(j) || !fits(to[i], j)) continue;
      const nd = di + mesh.dist[e] * kmPerUnit;
      if (nd > cap || nd >= dist[j]) continue;
      dist[j] = nd;
      to[j] = to[i];
      heap.push(j, nd);
    }
  }
  let filled = 0;
  for (let i = 0; i < g.n; i++)
    if (owner[i] === -1 && to[i] >= 0) {
      owner[i] = to[i];
      filled++;
    }
  return filled;
}

// 古林的种族的起点不在森林里时挪到同一个文化里最近的森林（按步数；找不到不挪）
function intoForest(g: CountryRun, from: number, culture: number, land: Uint8Array, move: (cell: number) => void): void {
  if (land[from] & FOREST) return;
  const { mesh } = g.world;
  const cultureOf = g.ctx.cultureOf!;
  const { hab } = g.ctx;
  const seen = new Set<number>([from]);
  let front = [from];
  while (front.length && seen.size < 4096) {
    const next: number[] = [];
    for (const i of front) {
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (seen.has(j) || !g.ctx.x.dry[j] || cultureOf[j] !== culture || g.country[j] >= 0 || g.region[j] >= 0) continue;
        seen.add(j);
        if (land[j] & FOREST && hab[j] >= g.minH && !g.isSeed[j]) {
          g.isSeed[from] = 0;
          g.isSeed[j] = 1;
          move(j);
          return;
        }
        next.push(j);
      }
    }
    front = next;
  }
}

export const raceRealms: PatternModule = {
  id: RACE_REALMS,
  name: '种族王国',
  description: '王国跟着种族喜欢的地方走：古林里的种族守着森林，山里的种族分成几个要塞小国结成同盟，荒原上的种族分成几个部落结成部落联盟，别的种族的王国在平原和海岸上',
  amountHint: '山里、荒原上的种族各圈几片；小数是再多一片的可能',
  tip: '奇幻：精灵守着古林，矮人在山里结盟，兽人在荒原上结成部落联盟，人类的王国在平原和海岸上',
  roles: { [ROLE_FOREST]: '古林王国', [ROLE_HOLD]: '山中要塞同盟的成员', [ROLE_HORDE]: '荒原部落联盟的成员' },
  params: [
    ...MEMBER_PARAMS(3, 6),
    { key: 'memberShare', label: '占国家的几成', min: 0, max: 1, step: 0.05, default: 0.15, hint: '小国约占国家总数的几成' },
    { key: 'memberSize', label: '每国多大', min: 0.1, max: 3, step: 0.05, default: 0.25, hint: '要塞、部落每个是几个平均的国家大' },
    { key: 'forest', label: '守着古林', min: 0, max: 1, step: 0.05, default: 0.6, hint: '1 只占森林；0 不管' },
    { key: 'plains', label: '守着平原', min: 0, max: 1, step: 0.05, default: 0.5, hint: '越大越守着平原；0 不管' },
    { key: 'strong', label: '偏爱多强才算', min: 1, max: 5, step: 0.1, default: 1.8, hint: '偏爱到这么强才按它立国' },
  ],

  reserve(g, use) {
    if (!(use.amount > 0) || g.total < MIN_COUNTRIES) return;
    const st = classify(g, param(this, use, 'strong'));
    if (!st) return;
    g.state.set(RACE_REALMS, st);
    const rand = g.stream(RACE_REALMS);
    const { ctx, world, total } = g;
    const { x, hab } = ctx;
    const cultureOf = ctx.cultureOf!;
    const minM = Math.round(param(this, use, 'minMembers'));
    const maxM = Math.max(minM, Math.round(param(this, use, 'maxMembers')));
    const share = param(this, use, 'memberShare');
    const size = param(this, use, 'memberSize');
    const tier = tierNear(g, size);
    const races = [...st.races].filter(([, k]) => k === 'upland' || k === 'waste');
    races.forEach(([race, kind], ri) => {
      const want = countOf(use.amount, rand());
      const bit = KIND_BIT[kind as 'upland' | 'waste'];
      // 荒原上的种族放宽到时代下限的三成（同汗国）
      const low = kind === 'waste' ? Math.max(NOBODY, 0.3 * g.minH) : g.minH;
      // 这个种族的文化住的格（圈的时候这一类地方便宜，别处贵六倍：圈出来是一片山、一片荒原）
      const ok = (i: number) => x.dry[i] === 1 && g.country[i] < 0 && g.region[i] < 0 && hab[i] >= low && cultureOf[i] >= 0 && st.raceOf[cultureOf[i]] === race;
      const cost = (j: number) => ((st.land[j] & bit) !== 0 ? 1 : 6);
      // 连成一片的、这个种族的格：按这一类地方的面积从大到小
      const parts = patches(g, ok, (i) => ((st.land[i] & bit) !== 0 ? cellKm2(world, i) : 0));
      for (let q = 0; q < want && q < parts.length; q++) {
        const nc = Math.min(maxM, Math.max(minM, Math.round(total * share)), g.rest - Math.ceil(total / 2));
        if (nc < 2) return;
        const target = nc * size * g.T;
        const part = parts[q];
        if (part.area < 0.5 * target) return;
        const ns = g.mix('race-realms-center', ri, q);
        const center = bestCell(g, (i) => part.of[i] === part.id && ok(i) && (st.land[i] & bit) !== 0 && hab[i] >= g.minH, (i) => hab[i] * (1 + 0.35 * noiseAt(world, ns, 500, i)));
        if (center < 0) continue;
        const k0 = g.regions.length;
        const { cells, got } = claimRegion(g, center, target, k0, ok, cost);
        if (got < 0.5 * target || cells.length < 2 * nc) {
          releaseRegion(g, cells);
          continue;
        }
        const r = g.stream(RACE_REALMS, ri, q);
        const role = kind === 'upland' ? ROLE_HOLD : ROLE_HORDE;
        const list = scatterSeeds(g, cells, k0, center, nc, (_, pick) => ({ ...seedAt(g, pick, tier, tier.area * (0.7 + 0.6 * r()), k0, r), role }), false);
        shareBudget(list, got);
        g.regions.push({ pattern: RACE_REALMS, group: ctx.cultureGroup[cultureOf[center]], seeds: list });
        st.clusters.push({ region: k0, kind: kind as 'upland' | 'waste', race });
        g.rest -= list.length;
      }
    });
  },

  // 古林的种族进森林便宜、出森林贵；平原的种族进森林、山地、荒原贵，平原、海岸便宜（预留的地方里的不管）
  grow(g, use) {
    const st = g.state.get(RACE_REALMS) as RaceRealmState | undefined;
    if (!st) return;
    const f = param(this, use, 'forest');
    const p = param(this, use, 'plains');
    const k = g.seeds.length;
    // 每国：1 古林，2 平原
    const how = new Uint8Array(k);
    // 古林的种族进别的文化组的森林：越过文化组的倍数换成同组的（森林是它们的，不管住的是谁）
    const ease = new Float64Array(k).fill(1);
    const group = new Int32Array(k);
    for (let o = 0; o < k; o++) {
      const s = g.seeds[o];
      if (s.region >= 0) continue;
      const kind = st.kindOf[s.culture];
      if (kind === KIND_CODE.forest) {
        s.role = ROLE_FOREST;
        if (f > 0) {
          how[o] = 1;
          ease[o] = sameCultureMul(s.gov) / otherCultureMul(s.gov);
          group[o] = g.ctx.cultureGroup[s.culture];
          intoForest(g, s.cell, s.culture, st.land, (c) => (s.cell = c));
        }
      } else if (kind === KIND_CODE.open && p > 0) how[o] = 2;
    }
    if (!how.some((v) => v > 0)) return;
    const land = st.land;
    const cultureOf = g.ctx.cultureOf!;
    const cultureGroup = g.ctx.cultureGroup;
    const inF = 1 - 0.6 * f;
    const outF = 1 + 2 * f;
    // 出了森林最远走多远（km）：(1 − forest) × 平均的国家的边长；1 只占森林
    const reach = (1 - f) * Math.sqrt(g.T);
    const away = how.includes(1) ? forestDistance(g, land) : undefined;
    // 平原上的种族：别的种族喜欢的地方（精灵住的森林、矮人住的山地、兽人住的荒原）贵，平原、海岸便宜一些，别的照旧
    const theirs = 1 + 2 * p;
    const open = 1 - 0.4 * p;
    const bitOf = [0, FOREST, UPLAND, WASTE];
    const kindOf = st.kindOf;
    g.stepCost.push((o, j, c) => {
      const h = how[o];
      if (h === 1) {
        if (!(land[j] & FOREST)) return away![j] > reach ? Infinity : c * outF;
        const cj = cultureOf[j];
        return cj >= 0 && cultureGroup[cj] !== group[o] ? c * inF * ease[o] : c * inF;
      }
      if (h === 2) {
        if (!land[j]) return c * open;
        const cj = cultureOf[j];
        return cj >= 0 && land[j] & bitOf[kindOf[cj]] ? c * theirs : c;
      }
      return c;
    });
  },

  // 长完以后：空着的、住得下不少人的地方归最近的别的王国（fillLeftover）。不取随机数
  after(g) {
    const st = g.state.get(RACE_REALMS) as RaceRealmState | undefined;
    if (!st) return;
    fillLeftover(g, st);
  },

  // 山地的一片结成同盟，荒原的一片结成部落联盟（帝国一类）
  relate(g) {
    const st = g.state.get(RACE_REALMS) as RaceRealmState | undefined;
    const b = g.bloc!;
    const ids = g.ids;
    if (!st?.clusters.length || !ids) return;
    const metas = g.world.small.countries!;
    for (const cl of st.clusters) {
      const taken = cl.kind === 'upland' ? b.inAlliance : b.inUnion;
      const members = g.seeds.flatMap((s, o) => (s.region === cl.region && metas[ids[o]] && (b.area.get(ids[o]) ?? 0) > 0 && !taken.has(ids[o]) ? [ids[o]] : []));
      if (members.length < 2) continue;
      const leader = largest(members, b.area);
      const ordered = [leader, ...members.filter((x) => x !== leader)];
      if (cl.kind === 'upland') {
        const used = new Set(b.blocs.filter((x) => x.kind === 'alliance').map((x) => x.color));
        const bl: Bloc = { id: b.nid++, kind: 'alliance', name: '', leader, members: ordered, color: ALLIANCE_COLORS.find((cc) => !used.has(cc)) ?? ALLIANCE_COLORS[cl.region % ALLIANCE_COLORS.length] };
        b.name(bl);
        b.blocs.push(bl);
      } else {
        const m = metas[leader];
        const nm = titled(m.base?.zh ? m.base : { zh: m.name }, HORDE_TITLE);
        const bl: Bloc = { id: b.nid++, kind: 'empire', name: nm.zh, ...(nm.orig ? { orig: nm.orig } : {}), nameLocked: true, leader, members: ordered, color: m.color };
        b.blocs.push(bl);
      }
      for (const id of members) taken.add(id);
    }
  },
};
