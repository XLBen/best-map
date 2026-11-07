import { CommandError } from '../errors';
import { hashString } from '../names';
import { mixSeed, mulberry32 } from '../rng';
import type { Bloc, BlocKind, CountryMeta, World } from '../world';
import { countryList } from './countries/base';
import { type Era, worldEra } from './era';
import { type TitleOne, titled } from './government';
import { cellKm2 } from './space';

// 国家之间的集团（第二十六轮）：帝国（邦联并成的）、联邦、军事同盟，存在 small.blocs；附庸照旧是 CountryMeta.overlord（加了 subject）。
// 生成（领土补齐之后、人口之前，只在重新长国家时；第七十三轮起是时代的国家格局，见 countries/relate.ts 与 countries/patterns/）：
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
export const classOf = (k: BlocKind) => (k === 'alliance' ? 1 : 0);

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

// 每个国家在 kinds 的集团里算哪一个（kinds 里先列的种类优先）。第七十四轮：自己不在这些集团里的殖民地跟着宗主（一层层往上找）
export function memberBlocs(small: Pick<World['small'], 'blocs' | 'countries'>, kinds: readonly BlocKind[]): Map<number, Bloc> {
  const pick = new Map<number, Bloc>();
  for (const kind of kinds) for (const b of blocList(small)) if (b.kind === kind) for (const m of b.members) if (!pick.has(m)) pick.set(m, b);
  const metas = small.countries ?? {};
  for (const m of Object.values(metas)) {
    if (m.subject !== 'colony' || pick.has(m.id)) continue;
    let top: CountryMeta | undefined = m;
    for (let d = 0; top && top.overlord !== undefined && d < 8; d++) {
      top = metas[top.overlord];
      const b = top && pick.get(top.id);
      if (b) {
        pick.set(m.id, b);
        break;
      }
    }
  }
  return pick;
}

// 国家的编号（countryList 的下标 + 1，同 derived.country）→ 它所在集团的颜色（kinds 里先列的种类优先；不在集团里为 null）。
// “同盟”模式用：一个集团一种颜色，不在集团里的界面画成灰色
export function blocMapColors(world: Pick<World, 'small'>, kinds: readonly BlocKind[] = ['alliance', 'empire', 'federation']): ([number, number, number] | null)[] {
  const pick = memberBlocs(world.small, kinds);
  return [null, ...countryList(world.small).map((m) => (pick.has(m.id) ? rgb(pick.get(m.id)!.color) : null))];
}

// 每格所在的集团的编号（kinds 里的种类；陆地按领土，海按 derived.country 的领海与碎岛；殖民地跟着宗主），不在集团里为 −1。
// 片区名（regionLabels）、帝国的外沿用
export function blocCells(world: World, kinds: readonly BlocKind[] = BLOC_KINDS): Int32Array {
  const { mesh, causes, derived } = world;
  const out = new Int32Array(mesh.n).fill(-1);
  const c = causes.country;
  if (!c || !world.small.blocs?.length) return out;
  const of = new Map([...memberBlocs(world.small, kinds)].map(([m, b]) => [m, b.id]));
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

export function titleFor(era: Pick<Era, 'relations'> | undefined, kind: BlocKind | 'member', r: number): TitleOne {
  const list = era?.relations?.titles?.[kind];
  return list?.length ? list[Math.floor(r * list.length) % list.length] : DEFAULT_TITLES[kind];
}
export const one = (t: TitleOne) => (typeof t === 'string' ? { zh: t } : t);

// 称号按集团的编号挑（生成时、之后自动换名字时挑的是同一个）
export const titleRand = (id: number) => mulberry32(mixSeed(hashString('bloc-title'), id))();
export const baseOf = (m: CountryMeta | undefined) => (m?.base?.zh ? m.base : { zh: m?.name ?? '' });

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

export const blocAreas = (world: World): Map<number, number> => {
  const out = new Map<number, number>();
  const c = world.causes.country;
  if (!c) return out;
  for (let i = 0; i < c.length; i++) if (c[i] >= 0 && world.causes.land[i]) out.set(c[i], (out.get(c[i]) ?? 0) + cellKm2(world, i));
  return out;
};
export const largest = (ids: readonly number[], area: Map<number, number>): number => {
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
      leader = largest(members, (area ??= blocAreas(world)));
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
    const leader = patch.leader ?? largest(members, blocAreas(world));
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
    b.leader = largest(b.members, blocAreas(world));
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

// 国家的邻国（陆上接壤）
export function neighbours(world: World): Map<number, Set<number>> {
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
