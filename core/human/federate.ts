import { HeapLite } from '../mesh';
import { hashString } from '../names';
import { mixSeed } from '../rng';
import type { Bloc, CountryMeta } from '../world';
import { baseOf, one, titleFor, titleRand } from './blocs';
import type { GenContext } from './context';
import { averageCountryKm2 } from './countries/count';
import { countryColor, nameCountry, rulerTitleOf, yearText } from './countries/records';
import { cultureById } from './era';
import { makeFlag } from './flags';
import { governmentById, titled } from './government';
import { cellKm2, distKm } from './space';
import { fedMemberTier, genTiers } from './tiers';

// 把一个国家切成联邦的几个成员邦（第二十六轮）。第七十三轮从 blocs.ts 原样搬来：联邦的格局（countries/patterns/federation.ts）调它

// 把国家 m 分成 parts 个成员邦：首都起按离得最远挑起点，按距离分；有省份时整省归格数最多的那一邦。返回编号是 id 的联邦
export function federate(ctx: GenContext, m: CountryMeta, parts: number, seed: number, id: number): Bloc | null {
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
  const T = averageCountryKm2(era);
  // 成员邦的等级按面积（第四十二轮：等级的 fedMember，内置的是 0.7 倍以上公国级、0.2 倍以上侯国级、其余城邦级）
  const tiers = genTiers(small);
  const tierOf = (a: number): string | undefined => fedMemberTier(tiers, a, T).id || undefined;
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
  const t0 = tierOf(fedArea(live[0].cs));
  if (t0) m.tier = t0;
  else delete m.tier;
  // 等级变了：统治者的称号跟着（第四十三轮，称号按等级）
  const rt = rulerTitleOf(world, m, era);
  if (rt) m.ruler = { ...m.ruler, title: rt };
  else if (m.ruler.title) m.ruler = { name: m.ruler.name, ...(m.ruler.orig ? { orig: m.ruler.orig } : {}) };
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
    if (meta.tier === undefined) delete meta.tier;
    Object.assign(meta, nameCountry(world, meta, seed, taken, era));
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
