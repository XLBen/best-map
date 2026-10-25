import { CommandError } from '../errors';
import { HeapLite } from '../mesh';
import { hashString } from '../names';
import { mixSeed, mulberry32 } from '../rng';
import type { Bloc, BlocKind, CountryMeta, World } from '../world';
import type { GenContext, HumanStage } from './context';
import { averageCountryKm2, countryColor, countryList, countryPopScale, nameCountry, yearText } from './countries';
import { type Era, cultureById, worldEra } from './era';
import { makeFlag } from './flags';
import { type TitleOne, governmentById, titled } from './government';
import { cellKm2, distKm } from './space';

// 国家之间的集团（第二十六轮）：帝国（邦联并成的）、联邦、军事同盟，存在 small.blocs；附庸照旧是 CountryMeta.overlord（加了 subject）。
// 生成（领土补齐之后、人口之前，只在重新长国家时）按时代的 relations：
//   帝国：国家一步撒下的邦联（ctx.confederations），皇帝国是最大的成员；名字 = 皇帝国的地名 + 帝国的称号；
//   联邦：挑几个大国（政体是联邦制的更容易），从首都起按离得最远挑几个起点、按距离分成 4–12 个成员邦（有省份时整省归一邦）；
//     原来的国家是首府所在的成员，别的是新国家；成员邦的名字 = 地名 + 成员的称号（锁定名字），在国家模式里画成联邦的一种颜色；
//   军事同盟：挑几个最大、彼此不结盟的国家当盟主，沿已有的同盟关系往外拉（三层以内），再拉进挨着的、同一文化组的国家（一半）；
//     附庸跟着宗主、联邦整个进；名字 = 盟主的地名 + 同盟的称号。
// 一个国家最多在一个帝国或联邦里、一个同盟里（tidyBlocs 保证）。命令是 set_bloc（新建、改、删）

export const BLOC_KINDS: readonly BlocKind[] = ['empire', 'federation', 'alliance'];
export const BLOC_NAMES: Record<BlocKind, string> = { empire: '帝国', federation: '联邦', alliance: '同盟' };
// 时代没写称号时
const DEFAULT_TITLES: Record<BlocKind | 'member', TitleOne> = {
  empire: { zh: '帝国', orig: '{name} Empire' },
  federation: { zh: '联邦', orig: 'Federation of {name}' },
  alliance: { zh: '同盟', orig: '{name} Alliance' },
  member: { zh: '邦', orig: 'State of {name}' },
};
// 同盟的颜色（按先后）
export const ALLIANCE_COLORS = ['#c0392b', '#2e6fbf', '#2f9e44', '#8e44ad', '#d68910', '#16a085', '#7f8c8d', '#d35400'];

// 帝国、联邦算一类，同盟一类：一个国家每一类最多在一个集团里
const classOf = (k: BlocKind) => (k === 'alliance' ? 1 : 0);

// ---------- 查 ----------

export const blocList = (small: Pick<World['small'], 'blocs'>): readonly Bloc[] => small.blocs ?? [];
export const blocById = (small: Pick<World['small'], 'blocs'>, id: number): Bloc | undefined => small.blocs?.find((b) => b.id === id);
// 新建时的编号
export const nextBlocId = (small: Pick<World['small'], 'blocs'>): number => Math.max(0, ...blocList(small).map((b) => b.id)) + 1;
// 一个国家所在的集团（帝国或联邦在前）
export const blocsOf = (world: Pick<World, 'small'>, id: number): Bloc[] =>
  blocList(world.small)
    .filter((b) => b.members.includes(id))
    .sort((a, b) => classOf(a.kind) - classOf(b.kind) || a.id - b.id);
// 一个国家所在的某种（几种之一）集团；省略时是第一个
export function blocOf(world: Pick<World, 'small'>, id: number, kind?: BlocKind | readonly BlocKind[]): Bloc | undefined {
  const kinds = kind === undefined ? BLOC_KINDS : typeof kind === 'string' ? [kind] : kind;
  return blocsOf(world, id).find((b) => kinds.includes(b.kind));
}

const rgb = (hex: string): [number, number, number] => {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

// 国家的编号（countryList 的下标 + 1，同 derived.country）→ 它所在集团的颜色（kinds 里先列的种类优先；不在集团里为 null）。
// “同盟”模式用：一个集团一种颜色，不在集团里的界面画成灰色
export function blocMapColors(world: Pick<World, 'small'>, kinds: readonly BlocKind[] = ['alliance', 'empire', 'federation']): ([number, number, number] | null)[] {
  const pick = new Map<number, Bloc>();
  for (const kind of kinds) for (const b of blocList(world.small)) if (b.kind === kind) for (const m of b.members) if (!pick.has(m)) pick.set(m, b);
  return [null, ...countryList(world.small).map((m) => (pick.has(m.id) ? rgb(pick.get(m.id)!.color) : null))];
}

// 每格所在的集团的编号（kinds 里的种类；陆地按领土，海按 derived.country 的领海与碎岛），不在集团里为 −1。
// 片区名（regionLabels）、帝国的外沿用
export function blocCells(world: World, kinds: readonly BlocKind[] = BLOC_KINDS): Int32Array {
  const { mesh, causes, derived } = world;
  const out = new Int32Array(mesh.n).fill(-1);
  const c = causes.country;
  if (!c || !world.small.blocs?.length) return out;
  const of = new Map<number, number>();
  for (const kind of kinds) for (const b of blocList(world.small)) if (b.kind === kind) for (const m of b.members) if (!of.has(m)) of.set(m, b.id);
  const list = countryList(world.small);
  const code = derived.country;
  for (let i = 0; i < mesh.n; i++) {
    const id = causes.land[i] ? c[i] : code?.[i] ? list[code[i] - 1]?.id : undefined;
    const b = id !== undefined && id >= 0 ? of.get(id) : undefined;
    if (b !== undefined) out[i] = b;
  }
  return out;
}

// 帝国的外沿（同 countryGroups 的布局：每格两个值，第二个总是 0）：帝国里的格是集团的编号，别的陆地是 0，不在集团里的海是 −1。
// 分组不同的相邻两格之间画帝国的边线（成员之间不画）。kinds 省略为帝国
export function blocBorderGroups(world: World, kinds: readonly BlocKind[] = ['empire']): Float32Array {
  const cells = blocCells(world, kinds);
  const out = new Float32Array(world.mesh.n * 2);
  for (let i = 0; i < cells.length; i++) out[2 * i] = cells[i] >= 0 ? cells[i] : world.causes.land[i] ? 0 : -1;
  return out;
}

// 联邦的成员邦 → 联邦的颜色（国家模式里联邦整片一种颜色）
export function federationColorOf(small: Pick<World['small'], 'blocs'>): Map<number, string> {
  const out = new Map<number, string>();
  for (const b of blocList(small)) if (b.kind === 'federation') for (const m of b.members) if (!out.has(m)) out.set(m, b.color);
  return out;
}

// ---------- 名字 ----------

function titleFor(era: Pick<Era, 'relations'> | undefined, kind: BlocKind | 'member', r: number): TitleOne {
  const list = era?.relations?.titles?.[kind];
  return list?.length ? list[Math.floor(r * list.length) % list.length] : DEFAULT_TITLES[kind];
}
const one = (t: TitleOne) => (typeof t === 'string' ? { zh: t } : t);

// 称号按集团的编号挑（生成时、之后自动换名字时挑的是同一个）
const titleRand = (id: number) => mulberry32(mixSeed(hashString('bloc-title'), id))();
const baseOf = (m: CountryMeta | undefined) => (m?.base?.zh ? m.base : { zh: m?.name ?? '' });

// 自动的名字：盟主的地名 + 时代的称号（按集团的编号挑一个）。era 省略为世界的时代。
// 盟主的地名已经写在别的集团的名字里时（联邦的首府又是同盟的盟主：坦洛克联邦、坦洛克同盟），换成成员里下一个没用过的地名；
// 都用过时照用盟主的。others：别的集团（省略为世界里的；生成时是这一次的）
export function autoBlocName(
  world: Pick<World, 'small'>,
  b: Pick<Bloc, 'id' | 'kind' | 'leader'> & { members?: readonly number[] },
  era: Pick<Era, 'relations'> | undefined = worldEra(world.small),
  others: readonly Bloc[] = blocList(world.small),
): { zh: string; orig?: string } {
  const metas = world.small.countries ?? {};
  const taken = (zh: string) => !!zh && others.some((o) => o.id !== b.id && o.name.includes(zh));
  const pick = [b.leader, ...(b.members ?? []).filter((x) => x !== b.leader)].find((id) => metas[id] && !taken(baseOf(metas[id]).zh)) ?? b.leader;
  return titled(baseOf(metas[pick]), one(titleFor(era, b.kind, titleRand(b.id))));
}

// ---------- 整理 ----------

const areaOf = (world: World): Map<number, number> => {
  const out = new Map<number, number>();
  const c = world.causes.country;
  if (!c) return out;
  for (let i = 0; i < c.length; i++) if (c[i] >= 0 && world.causes.land[i]) out.set(c[i], (out.get(c[i]) ?? 0) + cellKm2(world, i));
  return out;
};
const largest = (ids: readonly number[], area: Map<number, number>): number => {
  let best = ids[0];
  for (const id of ids) if ((area.get(id) ?? 0) > (area.get(best) ?? 0) || ((area.get(id) ?? 0) === (area.get(best) ?? 0) && id < best)) best = id;
  return best;
};

// 成员只留在的国家（去重）；一个国家每一类只在一个集团里（编号小的留着它）；盟主不在了换成最大的成员（没改过名字时跟着换名字）；
// 没有成员的去掉
export function tidyBlocs(world: World) {
  const small = world.small;
  if (!small.blocs) return;
  const metas = small.countries ?? {};
  const taken = [new Set<number>(), new Set<number>()];
  let area: Map<number, number> | undefined;
  const out: Bloc[] = [];
  for (const b of [...small.blocs].sort((a, b) => a.id - b.id)) {
    const used = taken[classOf(b.kind)];
    const members = [...new Set(b.members)].filter((id) => metas[id] && !used.has(id));
    if (!members.length) continue;
    for (const id of members) used.add(id);
    let changed = members.length !== b.members.length || members.some((x, k) => x !== b.members[k]);
    let leader = b.leader;
    if (!members.includes(leader)) {
      leader = largest(members, (area ??= areaOf(world)));
      changed = true;
    }
    if (!changed) {
      out.push(b);
      continue;
    }
    const nb: Bloc = { ...b, members, leader };
    if (leader !== b.leader && !b.nameLocked) {
      const nm = autoBlocName(world, nb);
      nb.name = nm.zh;
      if (nm.orig) nb.orig = nm.orig;
      else delete nb.orig;
    }
    out.push(nb);
  }
  // 原来的先后不变
  const order = new Map(small.blocs.map((b, k) => [b.id, k]));
  out.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  if (out.length) small.blocs = out;
  else delete small.blocs;
}

// 合并国家（b 并进 a）：集团里的 b 换成 a（盟主是 b 时换成 a，没改过名字时跟着换名字）
export function mergeBlocMembers(world: World, a: number, b: number) {
  for (const bl of world.small.blocs ?? []) {
    if (!bl.members.includes(b)) continue;
    bl.members = [...new Set(bl.members.map((x) => (x === b ? a : x)))];
    if (bl.leader !== b) continue;
    bl.leader = a;
    if (bl.nameLocked) continue;
    const nm = autoBlocName(world, bl);
    bl.name = nm.zh;
    if (nm.orig) bl.orig = nm.orig;
    else delete bl.orig;
  }
}

// 拆分出的国家跟着原来的国家进它所在的集团
export function joinBlocsOf(world: World, from: number, id: number) {
  for (const bl of world.small.blocs ?? []) if (bl.members.includes(from) && !bl.members.includes(id)) bl.members.push(id);
}

// ---------- 命令 ----------

export interface BlocPatch {
  kind?: BlocKind;
  // '' 是恢复自动；orig 跟着 name
  name?: string;
  orig?: string;
  leader?: number;
  members?: number[];
  color?: string;
}

// 新建（id 省略，patch 要写 kind 与 members）、改（id + patch）、删（id + null）。返回集团的编号与改了什么
export function setBloc(world: World, id: number | undefined, patch: BlocPatch | null): { id: number; what: string[] } {
  const small = world.small;
  const metas = small.countries;
  if (!metas) throw new CommandError('还没有国家');
  const check = (list: readonly number[]) => {
    for (const x of list) if (!metas[x]) throw new CommandError(`找不到国家 ${x}`);
  };
  if (id === undefined) {
    if (!patch) throw new CommandError('新建集团要写种类与成员');
    if (!patch.kind) throw new CommandError('新建集团要写种类');
    const members = [...new Set([...(patch.members ?? []), ...(patch.leader !== undefined ? [patch.leader] : [])])];
    if (!members.length) throw new CommandError('集团至少要有一个成员');
    check(members);
    const nid = nextBlocId(small);
    const leader = patch.leader ?? largest(members, areaOf(world));
    const used = new Set(blocList(small).map((b) => b.color));
    const color =
      patch.color?.toLowerCase() ?? (patch.kind === 'alliance' ? (ALLIANCE_COLORS.find((c) => !used.has(c)) ?? ALLIANCE_COLORS[nid % ALLIANCE_COLORS.length]) : metas[leader].color);
    const b: Bloc = { id: nid, kind: patch.kind, name: '', leader, members: [leader, ...members.filter((x) => x !== leader)], color };
    named(world, b, patch);
    (small.blocs ??= []).push(b);
    claimMembers(world, b);
    tidyBlocs(world);
    return { id: nid, what: [`新建${BLOC_NAMES[b.kind]}`] };
  }
  const b = blocById(small, id);
  if (!b) throw new CommandError(`找不到集团 ${id}`);
  if (patch === null) {
    small.blocs = small.blocs!.filter((x) => x.id !== id);
    if (!small.blocs.length) delete small.blocs;
    return { id, what: ['删除'] };
  }
  const what: string[] = [];
  if (patch.kind !== undefined && patch.kind !== b.kind) {
    b.kind = patch.kind;
    what.push('种类');
  }
  if (patch.members !== undefined) {
    check(patch.members);
    if (!patch.members.length) throw new CommandError('集团至少要有一个成员');
    b.members = [...new Set(patch.members)];
    what.push('成员');
  }
  let renamed = false;
  if (patch.leader !== undefined) {
    check([patch.leader]);
    if (!b.members.includes(patch.leader)) b.members = [patch.leader, ...b.members];
    renamed = b.leader !== patch.leader;
    b.leader = patch.leader;
    what.push('盟主');
  } else if (!b.members.includes(b.leader)) {
    b.leader = largest(b.members, areaOf(world));
    renamed = true;
  }
  if (patch.name !== undefined) {
    named(world, b, patch);
    what.push(patch.name.trim() ? '改名' : '名字恢复自动');
  } else if (renamed && !b.nameLocked) named(world, b, {});
  if (patch.color !== undefined) {
    b.color = patch.color.toLowerCase();
    what.push('换颜色');
  }
  claimMembers(world, b);
  tidyBlocs(world);
  return { id, what };
}

// 写名字：写了的照用（锁定），空的或没写时自动
function named(world: World, b: Bloc, patch: Pick<BlocPatch, 'name' | 'orig'>) {
  const name = patch.name?.trim();
  if (name) {
    b.name = name;
    const o = patch.orig?.trim();
    if (o) b.orig = o;
    else delete b.orig;
    b.nameLocked = true;
    return;
  }
  delete b.nameLocked;
  const nm = autoBlocName(world, b);
  b.name = nm.zh;
  if (nm.orig) b.orig = nm.orig;
  else delete b.orig;
}

// 成员从同一类的别的集团里退出（加入这一个）
function claimMembers(world: World, b: Bloc) {
  const k = classOf(b.kind);
  for (const o of world.small.blocs ?? []) {
    if (o === b || classOf(o.kind) !== k) continue;
    o.members = o.members.filter((x) => !b.members.includes(x));
  }
}

// ---------- 生成 ----------

// 小数的个数：整数部分 + 小数部分的可能多一个
const countOf = (v: number | undefined, r: number) => (v ? Math.floor(v) + (r < v - Math.floor(v) ? 1 : 0) : 0);

function makeBlocs(ctx: GenContext) {
  const plan = ctx.countries;
  if (!plan || plan.mode !== 'generate') return;
  const { world, era } = ctx;
  const small = world.small;
  const metas = small.countries;
  if (!metas || !world.causes.country) return;
  const seed = plan.rules.seed >>> 0;
  const rel = era.relations;
  const rand = mulberry32(mixSeed(seed, hashString('blocs')));
  const area = areaOf(world);
  const blocs: Bloc[] = [...(small.blocs ?? [])];
  let nid = Math.max(0, ...blocs.map((b) => b.id)) + 1;
  const inUnion = new Set<number>(blocs.filter((b) => classOf(b.kind) === 0).flatMap((b) => b.members));
  const inAlliance = new Set<number>(blocs.filter((b) => b.kind === 'alliance').flatMap((b) => b.members));
  const fresh = (m: CountryMeta) => !m.locked;
  // 生成时世界的时代还没换上：按这一次的时代起名
  const name = (b: Bloc) => {
    const nm = autoBlocName(world, b, era, blocs);
    b.name = nm.zh;
    if (nm.orig) b.orig = nm.orig;
  };

  // ---- 帝国：邦联的成员 ----
  for (const cf of ctx.confederations ?? []) {
    const members = cf.members.filter((id) => metas[id] && (area.get(id) ?? 0) > 0 && !inUnion.has(id));
    if (members.length < 2) continue;
    const leader = largest(members, area);
    const b: Bloc = { id: nid++, kind: 'empire', name: '', leader, members: [leader, ...members.filter((x) => x !== leader)], color: metas[leader].color };
    name(b);
    blocs.push(b);
    for (const id of members) inUnion.add(id);
  }

  // ---- 联邦：大国按地区分成几个成员邦 ----
  let split = false;
  const nFed = countOf(rel?.federation, rand());
  if (nFed > 0) {
    const T = averageCountryKm2(era, plan.rules.fragmentation);
    const cells = new Map<number, number>();
    const c = world.causes.country;
    for (let i = 0; i < c.length; i++) if (c[i] >= 0) cells.set(c[i], (cells.get(c[i]) ?? 0) + 1);
    const cands = Object.values(metas).filter((m) => fresh(m) && !inUnion.has(m.id) && m.overlord === undefined && (m.tier === 'large' || m.tier === 'empire') && (cells.get(m.id) ?? 0) >= 48);
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
      const b = federate(ctx, m, parts, mixSeed(seed, hashString('federation'), m.id), nid);
      if (!b) continue;
      nid++;
      blocs.push(b);
      for (const id of b.members) inUnion.add(id);
      split = true;
    }
  }

  // ---- 军事同盟 ----
  const nAll = countOf(rel?.alliances, rand());
  if (nAll > 0) {
    // 一个“单位”：联邦算一个（盟主代表），别的国家各算一个；附庸跟着宗主
    const fedOf = new Map<number, Bloc>();
    for (const b of blocs) if (b.kind === 'federation') for (const id of b.members) fedOf.set(id, b);
    const rep = (id: number) => fedOf.get(id)?.leader ?? id;
    const unitArea = (id: number) => (fedOf.has(id) ? fedOf.get(id)!.members.reduce((s, x) => s + (area.get(x) ?? 0), 0) : (area.get(id) ?? 0));
    const units = [...new Set(Object.values(metas).filter((m) => fresh(m) && m.overlord === undefined && !inAlliance.has(m.id)).map((m) => rep(m.id)))].filter((id) => metas[id] && metas[id].overlord === undefined);
    const want = Math.min(nAll, Math.floor(units.length / 3));
    units.sort((a, b) => unitArea(b) - unitArea(a) || a - b);
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
      for (const [u, t] of [...team].sort((a, b) => a[0] - b[0])) if (t === k) for (const x of fedOf.get(u)?.members ?? [u]) members.push(x);
      // 附庸跟着宗主（两层）
      for (let pass = 0; pass < 2; pass++)
        for (const m of countryList(small)) if (m.overlord !== undefined && members.includes(m.overlord) && !members.includes(m.id) && fresh(m) && !inAlliance.has(m.id)) members.push(m.id);
      if (members.length < 2) return;
      const used = new Set(blocs.filter((b) => b.kind === 'alliance').map((b) => b.color));
      const b: Bloc = {
        id: nid++,
        kind: 'alliance',
        name: '',
        leader: l,
        members: [l, ...members.filter((x) => x !== l)],
        color: ALLIANCE_COLORS.find((cc) => !used.has(cc)) ?? ALLIANCE_COLORS[k % ALLIANCE_COLORS.length],
      };
      name(b);
      blocs.push(b);
      for (const x of members) inAlliance.add(x);
    });
  }

  if (blocs.length) small.blocs = blocs;
  else delete small.blocs;
  tidyBlocs(world);
  if (split) ctx.popScale = countryPopScale(ctx);
}

// 国家的邻国（陆上接壤）
function neighbours(world: World): Map<number, Set<number>> {
  const { mesh, causes } = world;
  const c = causes.country!;
  const out = new Map<number, Set<number>>();
  for (let i = 0; i < mesh.n; i++) {
    if (!causes.land[i] || c[i] < 0) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (j <= i || !causes.land[j] || c[j] < 0 || c[j] === c[i]) continue;
      if (!out.has(c[i])) out.set(c[i], new Set());
      if (!out.has(c[j])) out.set(c[j], new Set());
      out.get(c[i])!.add(c[j]);
      out.get(c[j])!.add(c[i]);
    }
  }
  return out;
}

// 把国家 m 分成 parts 个成员邦：首都起按离得最远挑起点，按距离分；有省份时整省归格数最多的那一邦。返回编号是 id 的联邦
function federate(ctx: GenContext, m: CountryMeta, parts: number, seed: number, id: number): Bloc | null {
  const { world, era } = ctx;
  const { mesh, causes, small } = world;
  const c = causes.country!;
  const n = mesh.n;
  const own: number[] = [];
  for (let i = 0; i < n; i++) if (c[i] === m.id) own.push(i);
  const dry = (i: number) => causes.land[i] === 1 && ctx.d.lake[i] !== 1;
  const capital = m.capitalCell !== undefined && c[m.capitalCell] === m.id ? m.capitalCell : own.find(dry);
  if (capital === undefined) return null;
  // 起点都在最大的一块领土上（首都在别的岛上时也是）；别的块（飞地、岛）之后归离得最近的起点
  const piece = new Int32Array(n).fill(-1);
  let mainPiece = -1;
  let mainSize = 0;
  {
    let k = 0;
    const stack: number[] = [];
    for (const s0 of own) {
      if (piece[s0] >= 0) continue;
      let size = 0;
      piece[s0] = k;
      stack.push(s0);
      while (stack.length) {
        const i = stack.pop()!;
        size++;
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
          const j = mesh.adj[e];
          if (c[j] === m.id && piece[j] < 0) {
            piece[j] = k;
            stack.push(j);
          }
        }
      }
      if (size > mainSize) {
        mainSize = size;
        mainPiece = k;
      }
      k++;
    }
  }
  const start = piece[capital] === mainPiece ? capital : own.find((i) => piece[i] === mainPiece && dry(i));
  if (start === undefined) return null;
  const km = world.kmPerUnit;
  const heap = new HeapLite(1024);
  // 离起点们最近的距离、归哪一个起点
  const dist = new Float64Array(n).fill(Infinity);
  const part = new Int32Array(n).fill(-1);
  const grow = (s: number, k: number) => {
    dist[s] = 0;
    part[s] = k;
    heap.size = 0;
    heap.push(s, 0);
    while (heap.size) {
      const i = heap.pop();
      const di = heap.lastKey;
      if (di > dist[i]) continue;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (c[j] !== m.id) continue;
        const nd = di + mesh.dist[e] * km;
        if (nd < dist[j]) {
          dist[j] = nd;
          part[j] = k;
          heap.push(j, nd);
        }
      }
    }
  };
  const starts = [start];
  grow(start, 0);
  for (let k = 1; k < parts; k++) {
    let best = -1;
    let bd = 0;
    for (const i of own) if (dry(i) && dist[i] !== Infinity && dist[i] > bd) {
      bd = dist[i];
      best = i;
    }
    if (best < 0) break;
    starts.push(best);
    grow(best, k);
  }
  if (starts.length < 4) return null;
  // 走不到的（飞地、岛）：整块归离它最近的起点
  const pieceTo = new Map<number, number>();
  for (const i of own) {
    if (part[i] >= 0) continue;
    let k = pieceTo.get(piece[i]);
    if (k === undefined) {
      let bd = Infinity;
      k = 0;
      starts.forEach((s0, q) => {
        const dd = distKm(world, s0, i);
        if (dd < bd) {
          bd = dd;
          k = q;
        }
      });
      pieceTo.set(piece[i], k);
    }
    part[i] = k;
  }
  // 有省份时整省归格数最多的那一邦
  const prov = causes.province;
  if (prov && Object.keys(small.provinces).length) {
    const votes = new Map<number, Map<number, number>>();
    for (const i of own) {
      const p = prov[i];
      if (p < 0) continue;
      let v = votes.get(p);
      if (!v) votes.set(p, (v = new Map()));
      v.set(part[i], (v.get(part[i]) ?? 0) + 1);
    }
    const win = new Map<number, number>();
    for (const [p, v] of votes) {
      let best = -1;
      let bc = 0;
      for (const [k, cnt] of v) if (cnt > bc || (cnt === bc && k < best)) {
        bc = cnt;
        best = k;
      }
      win.set(p, best);
    }
    for (const i of own) if (prov[i] >= 0) part[i] = win.get(prov[i])!;
  }
  // 每一邦的格；首都所在的一邦是首府（原来的国家）
  const cellsOf = starts.map(() => [] as number[]);
  for (const i of own) cellsOf[part[i]].push(i);
  {
    const k0 = part[capital];
    if (k0 !== 0) {
      // 首都那一格所在的一邦当首府（换一下下标）
      [cellsOf[0], cellsOf[k0]] = [cellsOf[k0], cellsOf[0]];
      [starts[0], starts[k0]] = [starts[k0], starts[0]];
    }
  }
  const live = cellsOf.map((cs, k) => ({ cs, k })).filter((x) => x.k === 0 || x.cs.some(dry));
  if (live.length < 4) return null;
  const memberTitle = one(titleFor(era, 'member', titleRand(id)));
  const fedName = titled(baseOf(m), one(titleFor(era, 'federation', titleRand(id))));
  const metas = small.countries!;
  const used = new Set(Object.values(metas).map((x) => x.color));
  const taken = new Set(Object.values(metas).map((x) => x.name));
  const gov = governmentById(small, m.government);
  const culture = cultureById(small, m.primaryCulture);
  const fedArea = (cs: number[]) => cs.reduce((s, i) => s + (dry(i) ? cellKm2(world, i) : 0), 0);
  const T = averageCountryKm2(era, ctx.countries!.rules.fragmentation);
  const tierOf = (a: number) => (a >= 0.7 * T ? 'medium' : a >= 0.2 * T ? 'small' : 'city') as CountryMeta['tier'];
  const members: number[] = [m.id];
  // 首府那一邦是原来的国家：换成成员的称号
  const rename = (x: CountryMeta) => {
    const nm = titled(baseOf(x), memberTitle);
    x.name = nm.zh;
    if (nm.orig) x.orig = nm.orig;
    else delete x.orig;
    x.nameLocked = true;
  };
  rename(m);
  m.tier = tierOf(fedArea(live[0].cs));
  m.history = `${yearText(m.founded)}，${culture?.name ?? m.primaryCulture}建立${fedName.zh}，${m.name}是联邦的首府所在。`;
  for (const { cs, k } of live) {
    if (k === 0) continue;
    const id = Math.max(1, small.nextCountry ?? 1);
    small.nextCountry = id + 1;
    const color = countryColor(m.color, id, used);
    const meta: CountryMeta = {
      id,
      name: '',
      base: { zh: '' },
      color,
      flag: makeFlag(mixSeed(seed, hashString('flag'), id), color, { categories: gov?.category, layouts: gov?.layouts, emblems: gov?.emblems }),
      capitalCell: dry(starts[k]) && part[starts[k]] === part[cs[0]] ? starts[k] : cs.find(dry),
      government: m.government,
      primaryCulture: m.primaryCulture,
      acceptedGroups: [...m.acceptedGroups],
      allies: [],
      rivals: [],
      ruler: { name: '' },
      founded: m.founded,
      history: '',
      tier: tierOf(fedArea(cs)),
    };
    if (meta.capitalCell === undefined) delete meta.capitalCell;
    Object.assign(meta, nameCountry(world, meta, seed, taken));
    taken.add(meta.name);
    rename(meta);
    meta.history = `${yearText(meta.founded)}，与${m.name}等一起组成${fedName.zh}。`;
    metas[id] = meta;
    for (const i of cs) c[i] = id;
    members.push(id);
  }
  // 不再写首都的格时（被切到别的邦）重新挑：tidyCountries 会做；这里保证首府那一邦的首都还在
  if (m.capitalCell !== undefined && c[m.capitalCell] !== m.id) delete m.capitalCell;
  return { id, kind: 'federation', name: fedName.zh, ...(fedName.orig ? { orig: fedName.orig } : {}), leader: m.id, members, color: m.color };
}

export const blocsStage: HumanStage = { id: 'blocs', run: makeBlocs };
