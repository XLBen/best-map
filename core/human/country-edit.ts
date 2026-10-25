import { CommandError } from '../errors';
import { hashString } from '../names';
import { mixSeed, mulberry32 } from '../rng';
import type { CountryMeta, World } from '../world';
import { joinBlocsOf, mergeBlocMembers, tidyBlocs } from './blocs';
import { countryColor, countryName, ensureCountryArray, foundedYear, nameCountry, yearText } from './countries';
import { type Culture, type SubjectKind, cultureById, worldCultures, worldEra } from './era';
import { type FlagSpec, makeFlag } from './flags';
import { type Government, eraGovernments, governmentById } from './government';
import { SLOTS } from './groups';

// 改国家（第二十三轮，命令见 commands.ts）：画领土、新建、合并、拆分、改档案、删除、挪首都；改地形之后的修补；
// 每次改完的整理（tidyCountries：首都丢了换一个、指向没了的国家的外交去掉）。都只看原因，执行、重放一样

const seedOf = (world: World) => world.small.human?.countryRules?.seed ?? world.small.human?.seed ?? world.small.terrain.gen?.seed ?? world.settings.seed;

export function countryOf(world: World, id: number): CountryMeta {
  const m = world.small.countries?.[id];
  if (!m) throw new CommandError(`找不到国家 ${id}`);
  return m;
}

// 一国的格（陆地，按编号）
export function countryCells(world: World, id: number): number[] {
  const c = world.causes.country;
  const out: number[] = [];
  if (c) for (let i = 0; i < c.length; i++) if (c[i] === id) out.push(i);
  return out;
}

// 自动的首都：人最多的格（一样多时编号小的）；没有人时离领土的中心最近的格
export function autoCapital(world: World, cells: readonly number[]): number | undefined {
  if (!cells.length) return undefined;
  const pop = world.causes.popTotal;
  let best = -1;
  let bp = 0;
  if (pop) for (const i of cells) if (pop[i] > bp) {
    bp = pop[i];
    best = i;
  }
  if (best >= 0) return best;
  const { mesh } = world;
  let x = 0;
  let y = 0;
  for (const i of cells) {
    x += mesh.x[i];
    y += mesh.y[i];
  }
  x /= cells.length;
  y /= cells.length;
  let bd = Infinity;
  for (const i of cells) {
    const d = (mesh.x[i] - x) ** 2 + (mesh.y[i] - y) ** 2;
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}

// 整理：首都不在领土里了换一个自动的（挪过的不再锁定）；外交里指向没了的国家、自己的去掉；同盟、敌对两边都有；集团跟着整理
export function tidyCountries(world: World) {
  const { small, causes } = world;
  const metas = small.countries;
  const c = causes.country;
  if (!metas || !c) return;
  const lost = Object.values(metas).filter((m) => m.capitalCell === undefined || c[m.capitalCell] !== m.id || !causes.land[m.capitalCell]);
  if (lost.length) {
    const cells = new Map<number, number[]>(lost.map((m) => [m.id, []]));
    for (let i = 0; i < c.length; i++) cells.get(c[i])?.push(i);
    for (const m of lost) {
      const cap = autoCapital(world, cells.get(m.id)!);
      if (cap === undefined) delete m.capitalCell;
      else m.capitalCell = cap;
      delete m.capitalLocked;
    }
  }
  const has = (id: number) => !!metas[id];
  for (const m of Object.values(metas)) {
    if (m.overlord !== undefined && (!has(m.overlord) || m.overlord === m.id)) delete m.overlord;
    // 第二十六轮：没有宗主时也没有从属的种类
    if (m.overlord === undefined) delete m.subject;
    m.allies = m.allies.filter((x) => has(x) && x !== m.id);
    m.rivals = m.rivals.filter((x) => has(x) && x !== m.id && !m.allies.includes(x));
  }
  for (const m of Object.values(metas)) {
    for (const a of m.allies) if (!metas[a].allies.includes(m.id)) metas[a].allies.push(m.id);
    for (const r of m.rivals) if (!metas[r].rivals.includes(m.id)) metas[r].rivals.push(m.id);
  }
  // 集团（第二十六轮）：去掉没了的成员、盟主不在了换一个、空的去掉
  tidyBlocs(world);
}

// 画领土：这些格（只画陆地，湖面也算）归 id，null 是无主。返回改了的格数
export function paintCountry(world: World, cells: readonly number[], id: number | null): number {
  if (id !== null) countryOf(world, id);
  const c = ensureCountryArray(world);
  const v = id ?? -1;
  let k = 0;
  for (const i of cells) {
    if (!world.causes.land[i] || c[i] === v) continue;
    c[i] = v;
    k++;
  }
  return k;
}

// 这些格里人最多的文化（按人数；没有人时世界里第一个文化）
function majorityCultureOf(world: World, cells: readonly number[]): Culture | undefined {
  const { causes, small } = world;
  const w = new Map<string, number>();
  if (causes.popTotal && causes.popGroup && causes.popShare) {
    for (const i of cells) {
      for (let k = 0; k < SLOTS; k++) {
        const g = causes.popGroup[i * SLOTS + k];
        if (!g) break;
        const t = small.popGroups?.[g];
        if (t) w.set(t.culture, (w.get(t.culture) ?? 0) + (causes.popTotal[i] * causes.popShare[i * SLOTS + k]) / 255);
      }
    }
  }
  let best: string | undefined;
  let bv = 0;
  for (const [id, v] of w) if (v > bv || (v === bv && best !== undefined && id < best)) {
    bv = v;
    best = id;
  }
  return (best && cultureById(small, best)) || worldCultures(small)[0];
}

// 时代里最常见的政体（weight 最大的，一样大时排在前面的）
function commonGovernment(world: World): Government | undefined {
  const govs = eraGovernments(world.small, worldEra(world.small));
  let best: Government | undefined;
  for (const g of govs) if (!best || (g.weight ?? 1) > (best.weight ?? 1)) best = g;
  return best;
}

export interface NewCountryOpts {
  cells?: readonly number[];
  name?: string;
  orig?: string;
  culture?: string;
  government?: string;
  color?: string;
  flag?: FlagSpec;
}

// 新建一个国家（档案按这些格与世界的时代自动生成，写了的几项照用）。返回编号
export function newCountry(world: World, opts: NewCountryOpts): number {
  const small = world.small;
  if (!small.human) throw new CommandError('还没有生成人文');
  ensureCountryArray(world);
  const cells = (opts.cells ?? []).filter((i) => world.causes.land[i]);
  const culture = opts.culture ? cultureById(small, opts.culture) : majorityCultureOf(world, cells);
  if (opts.culture && !culture) throw new CommandError(`世界里没有文化 "${opts.culture}"`);
  if (!culture) throw new CommandError('世界里没有文化');
  const gov = opts.government ? governmentById(small, opts.government) : commonGovernment(world);
  if (opts.government && !gov) throw new CommandError(`世界里没有政体 "${opts.government}"`);
  if (!gov) throw new CommandError('世界里没有政体');
  const id = Math.max(1, small.nextCountry ?? 1);
  small.nextCountry = id + 1;
  const seed = seedOf(world);
  const metas = (small.countries ??= {});
  const used = new Set(Object.values(metas).map((m) => m.color));
  const color = opts.color?.toLowerCase() ?? countryColor(culture.color, id, used);
  const meta: CountryMeta = {
    id,
    name: '',
    base: { zh: '' },
    color,
    flag: opts.flag ?? makeFlag(mixSeed(seed, hashString('flag'), id), color, { categories: gov.category, layouts: gov.layouts, emblems: gov.emblems }),
    government: gov.id,
    primaryCulture: culture.id,
    acceptedGroups: [culture.group],
    allies: [],
    rivals: [],
    ruler: { name: '' },
    founded: foundedYear(worldEra(small), mulberry32(mixSeed(seed, hashString('country:year'), id))),
    history: '',
  };
  metas[id] = meta;
  Object.assign(meta, nameCountry(world, meta, seed, new Set(Object.values(metas).map((m) => m.name))));
  if (opts.name) {
    meta.name = opts.name;
    if (opts.orig) meta.orig = opts.orig;
    else delete meta.orig;
    meta.nameLocked = true;
  }
  meta.history = `${yearText(meta.founded)}，${culture.name}建立${meta.name}。`;
  paintCountry(world, cells, id);
  const cap = autoCapital(world, cells);
  if (cap !== undefined) meta.capitalCell = cap;
  return id;
}

// 合并：b 的领土归 a，b 去掉（指向 b 的外交改指 a）
export function mergeCountries(world: World, a: number, b: number) {
  if (a === b) throw new CommandError('不能和自己合并');
  const ma = countryOf(world, a);
  const mb = countryOf(world, b);
  const c = ensureCountryArray(world);
  for (let i = 0; i < c.length; i++) if (c[i] === b) c[i] = a;
  const metas = world.small.countries!;
  delete metas[b];
  for (const m of Object.values(metas)) {
    if (m.overlord === b) m.overlord = a;
    m.allies = [...new Set(m.allies.map((x) => (x === b ? a : x)))];
    m.rivals = [...new Set(m.rivals.map((x) => (x === b ? a : x)))];
  }
  if (ma.overlord === a) delete ma.overlord;
  for (const g of mb.acceptedGroups) if (!ma.acceptedGroups.includes(g)) ma.acceptedGroups.push(g);
  // 集团里的 b 换成 a（之后 tidyCountries 整理）
  mergeBlocMembers(world, a, b);
}

// 拆分：cells（这个国家里的格）成一个新国家；不写时按离得最远的两格分成两半，没有首都的那一半成新国家。返回新国家的编号
export function splitCountry(world: World, id: number, cells?: readonly number[]): number {
  const m = countryOf(world, id);
  const own = countryCells(world, id);
  let part: number[];
  if (cells) {
    const set = new Set(own);
    part = [...new Set(cells)].filter((i) => set.has(i)).sort((a, b) => a - b);
  } else {
    if (own.length < 2) throw new CommandError('国家太小，不能拆分');
    part = halves(world, own, m.capitalCell);
  }
  if (!part.length) throw new CommandError('这些格不在这个国家里');
  if (part.length === own.length) throw new CommandError('不能把整个国家拆出去');
  const fresh = newCountry(world, { cells: part, culture: m.primaryCulture, government: m.government });
  const nm = world.small.countries![fresh];
  nm.acceptedGroups = [...m.acceptedGroups];
  if (m.tier) nm.tier = m.tier;
  // 拆出的国家跟着进原来的国家所在的集团
  joinBlocsOf(world, id, fresh);
  return fresh;
}

// 按离得最远的两格分成两半（按步数同时长），返回不含 keep 的那一半
function halves(world: World, cells: readonly number[], keep: number | undefined): number[] {
  const { mesh } = world;
  const set = new Set(cells);
  const bfs = (from: number[]) => {
    const dist = new Map<number, number>(from.map((s) => [s, 0]));
    const owner = new Map<number, number>(from.map((s, k) => [s, k]));
    let q = [...from];
    while (q.length) {
      const next: number[] = [];
      for (const i of q) {
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
          const j = mesh.adj[e];
          if (!set.has(j) || dist.has(j)) continue;
          dist.set(j, dist.get(i)! + 1);
          owner.set(j, owner.get(i)!);
          next.push(j);
        }
      }
      q = next.sort((a, b) => a - b);
    }
    return { dist, owner };
  };
  const farthest = (from: number) => {
    const { dist } = bfs([from]);
    let best = from;
    for (const c of cells) if ((dist.get(c) ?? -1) > (dist.get(best) ?? -1)) best = c;
    return best;
  };
  const a = farthest(cells[0]);
  const b = farthest(a);
  const { owner } = bfs([a, b]);
  // 走不到的（飞地）跟着离得近的一半：按编号归 a
  const side = (c: number) => owner.get(c) ?? 0;
  const keepSide = keep !== undefined && set.has(keep) ? side(keep) : 0;
  return cells.filter((c) => side(c) !== keepSide);
}

// 删除：领土成无主地，外交里去掉它
export function removeCountry(world: World, id: number) {
  countryOf(world, id);
  const c = world.causes.country!;
  for (let i = 0; i < c.length; i++) if (c[i] === id) c[i] = -1;
  delete world.small.countries![id];
}

// 挪首都（要在这个国家的陆地上）；null 恢复自动
export function moveCapital(world: World, id: number, cell: number | null) {
  const m = countryOf(world, id);
  if (cell === null) {
    delete m.capitalLocked;
    m.capitalCell = autoCapital(world, countryCells(world, id));
    if (m.capitalCell === undefined) delete m.capitalCell;
    return;
  }
  if (world.causes.country?.[cell] !== id) throw new CommandError('首都要在这个国家的领土上');
  m.capitalCell = cell;
  m.capitalLocked = true;
}

// 改档案（set_country 的 patch 已经按格式检查过）
export interface CountryPatch {
  name?: string;
  orig?: string;
  color?: string;
  flag?: FlagSpec | null;
  government?: string;
  primaryCulture?: string;
  acceptedGroups?: string[];
  factions?: Record<string, number> | null;
  overlord?: number | null;
  // 从属的种类（第二十六轮）：null 是恢复默认（附庸）；要有宗主
  subject?: SubjectKind | null;
  allies?: number[];
  rivals?: number[];
  ruler?: { name: string; orig?: string; title?: string };
  founded?: number;
  history?: string;
  locked?: boolean;
}

export function setCountry(world: World, id: number, p: CountryPatch): string[] {
  const small = world.small;
  const m = countryOf(world, id);
  const metas = small.countries!;
  const what: string[] = [];
  const seed = seedOf(world);
  if (p.government !== undefined) {
    if (!governmentById(small, p.government)) throw new CommandError(`世界里没有政体 "${p.government}"`);
    m.government = p.government;
    what.push('政体');
  }
  if (p.primaryCulture !== undefined) {
    const c = cultureById(small, p.primaryCulture);
    if (!c) throw new CommandError(`世界里没有文化 "${p.primaryCulture}"`);
    m.primaryCulture = c.id;
    if (!m.acceptedGroups.includes(c.group)) m.acceptedGroups = [c.group, ...m.acceptedGroups];
    what.push('主流文化');
    // 没改过名字：按新文化的风格重起地名
    if (!m.nameLocked) {
      const taken = new Set(Object.values(metas).filter((x) => x.id !== id).map((x) => x.name));
      const n = nameCountry(world, m, seed, taken);
      m.base = n.base;
    }
  }
  if ((p.government !== undefined || p.primaryCulture !== undefined) && !m.nameLocked) {
    const n = countryName(m.base, governmentById(small, m.government), cultureById(small, m.primaryCulture));
    m.name = n.zh;
    if (n.orig) m.orig = n.orig;
    else delete m.orig;
  }
  if (p.name !== undefined) {
    if (p.name.trim()) {
      m.name = p.name.trim();
      const o = p.orig?.trim();
      if (o) m.orig = o;
      else delete m.orig;
      m.nameLocked = true;
      what.push('改名');
    } else {
      // 空的名字：恢复自动
      delete m.nameLocked;
      const n = countryName(m.base, governmentById(small, m.government), cultureById(small, m.primaryCulture));
      m.name = n.zh;
      if (n.orig) m.orig = n.orig;
      else delete m.orig;
      what.push('名字恢复自动');
    }
  }
  if (p.color !== undefined) {
    m.color = p.color.toLowerCase();
    what.push('换颜色');
  }
  if (p.flag !== undefined) {
    const gov = governmentById(small, m.government);
    m.flag = p.flag ?? makeFlag(mixSeed(seed, hashString('flag'), id), m.color, { categories: gov?.category, layouts: gov?.layouts, emblems: gov?.emblems });
    what.push(p.flag ? '旗帜' : '旗帜恢复自动');
  }
  if (p.acceptedGroups !== undefined) {
    const c = cultureById(small, m.primaryCulture);
    m.acceptedGroups = [...new Set([...(c ? [c.group] : []), ...p.acceptedGroups])];
    what.push('兼容文化组');
  }
  if (p.factions !== undefined) {
    if (p.factions === null) delete m.factions;
    else m.factions = { ...p.factions };
    what.push(p.factions ? '派系' : '派系恢复自动');
  }
  if (p.overlord !== undefined) {
    if (p.overlord === null) delete m.overlord;
    else {
      countryOf(world, p.overlord);
      // 不能绕成圈
      for (let at: number | undefined = p.overlord, k = 0; at !== undefined && k < 600; at = metas[at]?.overlord, k++) {
        if (at === id) throw new CommandError('宗主不能是自己或自己的附庸');
      }
      m.overlord = p.overlord;
    }
    what.push(p.overlord === null ? '不再是附庸' : '宗主');
  }
  if (p.overlord === null) delete m.subject;
  if (p.subject !== undefined) {
    if (p.subject === null) delete m.subject;
    else {
      if (m.overlord === undefined) throw new CommandError('先选宗主');
      m.subject = p.subject;
    }
    what.push('从属');
  }
  const relink = (key: 'allies' | 'rivals', list: number[]) => {
    for (const x of list) if (x === id) throw new CommandError('不能和自己结盟或敌对');
    for (const x of list) countryOf(world, x);
    const next = [...new Set(list)];
    for (const old of m[key]) if (!next.includes(old)) metas[old][key] = metas[old][key].filter((y) => y !== id);
    for (const x of next) if (!metas[x][key].includes(id)) metas[x][key].push(id);
    m[key] = next;
    // 同盟与敌对不同时有
    const other = key === 'allies' ? 'rivals' : 'allies';
    for (const x of next) {
      m[other] = m[other].filter((y) => y !== x);
      metas[x][other] = metas[x][other].filter((y) => y !== id);
    }
  };
  if (p.allies !== undefined) {
    relink('allies', p.allies);
    what.push('同盟');
  }
  if (p.rivals !== undefined) {
    relink('rivals', p.rivals);
    what.push('敌对');
  }
  if (p.ruler !== undefined) {
    m.ruler = { name: p.ruler.name, ...(p.ruler.orig ? { orig: p.ruler.orig } : {}), ...(p.ruler.title ? { title: p.ruler.title } : {}) };
    what.push('统治者');
  }
  if (p.founded !== undefined) {
    m.founded = p.founded;
    what.push('建国年份');
  }
  if (p.history !== undefined) {
    m.history = p.history;
    what.push('历史');
  }
  if (p.locked !== undefined) {
    if (p.locked) m.locked = true;
    else delete m.locked;
    what.push(p.locked ? '锁定' : '解锁');
  }
  return what;
}

// 改地形之后（applyTerrain 里，只看原因）：变成海的格不再归哪国；新长出的陆地按步数从挨着的陆地往外，归最近的那一格的国家
// （挨着的是无主地就还是无主；四周全是海的新岛无主）。别处、手改的不动
export function repairCountries(world: World, landBefore: Uint8Array): boolean {
  const c = world.causes.country;
  if (!c || !world.small.countries) return false;
  const { mesh, causes } = world;
  const land = causes.land;
  const n = mesh.n;
  let changed = false;
  const gained = new Uint8Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    if (landBefore[i] === land[i]) continue;
    if (!land[i]) {
      if (c[i] !== -1) changed = true;
      c[i] = -1;
    } else {
      gained[i] = 1;
      any = true;
      c[i] = -1;
    }
  }
  if (any) {
    // 从挨着新陆地的旧陆地按步数往外（只走新陆地）
    let frontier: number[] = [];
    const seen = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!land[i] || gained[i]) continue;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        if (gained[mesh.adj[e]]) {
          frontier.push(i);
          seen[i] = 1;
          break;
        }
      }
    }
    while (frontier.length) {
      const next: number[] = [];
      for (const i of frontier) {
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
          const j = mesh.adj[e];
          if (!gained[j] || seen[j]) continue;
          seen[j] = 1;
          c[j] = c[i];
          if (c[j] !== -1) changed = true;
          next.push(j);
        }
      }
      frontier = next.sort((a, b) => a - b);
    }
  }
  if (changed) tidyCountries(world);
  return changed;
}
