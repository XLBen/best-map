import { CommandError } from '../errors';
import type { GeoFeature } from '../features';
import { hashString } from '../names';
import { mixSeed, mulberry32 } from '../rng';
import type { LandmarkMeta, SettlementRules, World } from '../world';
import { cellName, peakFeatureAt } from './cells';
import { cultureById, worldCultures, worldEra } from './era';
import { governmentById, pickTitle } from './government';
import { COAST, LAKE, RIVER } from './rules';
import { type SettleInputs, cellKm, cityTable, computeCityTable, nearestLand, nextSettlementId } from './settlements';
import type { LandmarkDetector, LandmarkPlace, LandmarkType } from './settle-types';
import { landmarkTypeById, worldLandmarkTypes } from './settle-content';
import { distKm } from './space';
import { worldTerrainClasses } from './terrain-class';

// 地标（第二十四轮）：自然的按地形找（名山、火山、瀑布、峡谷、绿洲），人造的按类型的规则放（时代、文化组、政体的类别、放在哪里、每国几个）。
// 存在 small.landmarks 的只有类型、在哪一格、自动还是自己放的、自己改过的几项；名字按类型的写法现算（{river}瀑布……）

// 自然的地标：每 5000 格陆地 count 个
const PER_LAND_CELLS = 5000;

export interface Candidate {
  cell: number;
  score: number;
}

// ---------- 自然的检测器 ----------

const featuresOf = (world: World, type: string): GeoFeature[] => world.derived.features.filter((f) => f.type === type);

function highest(world: World, cells: ArrayLike<number>): number {
  const el = world.derived.elevation;
  let best = cells[0];
  for (let k = 1; k < cells.length; k++) if (el[cells[k]] > el[best] || (el[cells[k]] === el[best] && cells[k] < best)) best = cells[k];
  return best;
}

export function detect(S: SettleInputs, detector: LandmarkDetector): Candidate[] {
  const { world, x, d } = S;
  const { mesh } = world;
  const el = d.elevation;
  const thr = world.small.planet.riverThreshold;
  const out: Candidate[] = [];
  const volcanic = (f: GeoFeature) => f.tags.includes('volcanic');
  switch (detector) {
    case 'peak': {
      // 山脉的主峰在前（地物里的山峰），再是别的山峰格
      const seen = new Set<number>();
      for (const f of featuresOf(world, 'peak')) {
        if (volcanic(f) || !x.dry[f.anchor]) continue;
        seen.add(f.anchor);
        out.push({ cell: f.anchor, score: 1e5 + el[f.anchor] });
      }
      for (let i = 0; i < mesh.n; i++) if (d.peak[i] && !seen.has(i) && x.dry[i]) out.push({ cell: i, score: el[i] });
      break;
    }
    case 'volcano': {
      const seen = new Set<number>();
      for (const f of [...featuresOf(world, 'peak'), ...featuresOf(world, 'range')]) {
        if (!volcanic(f)) continue;
        const c = f.type === 'peak' ? f.anchor : highest(world, f.cells);
        if (seen.has(c) || !x.dry[c]) continue;
        seen.add(c);
        out.push({ cell: c, score: el[c] });
      }
      break;
    }
    case 'waterfall': {
      for (let i = 0; i < mesh.n; i++) {
        if (!x.dry[i] || !(x.flags[i] & RIVER)) continue;
        const j = d.receiver[i];
        if (j < 0 || !x.dry[j]) continue;
        const drop = el[i] - el[j];
        const km = distKm(world, i, j);
        if (drop < 150 || drop / km < 1.5) continue;
        out.push({ cell: i, score: drop * Math.log10(1 + d.discharge[i] / thr) });
      }
      break;
    }
    case 'canyon': {
      for (let i = 0; i < mesh.n; i++) {
        if (!x.dry[i] || !(x.flags[i] & RIVER) || d.discharge[i] < 2 * thr) continue;
        const rims: number[] = [];
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
          const j = mesh.adj[e];
          if (x.dry[j] && !(x.flags[j] & RIVER)) rims.push(el[j]);
        }
        if (rims.length < 2) continue;
        rims.sort((a, b) => b - a);
        const rim = (rims[0] + rims[1]) / 2 - el[i];
        if (rim < 350) continue;
        out.push({ cell: i, score: rim * Math.sqrt(Math.log10(1 + d.discharge[i] / thr)) });
      }
      break;
    }
    case 'oasis': {
      const desert = worldTerrainClasses(world.small).findIndex((c) => c.id === 'desert') + 1;
      const isDesert = (i: number) => (desert > 0 && S.cls[i] === desert) || world.small.species[d.dominant[i]]?.terrain === 'desert';
      for (let i = 0; i < mesh.n; i++) {
        if (!x.dry[i] || !(x.flags[i] & (RIVER | LAKE)) || !isDesert(i)) continue;
        let k = 0;
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (isDesert(mesh.adj[e])) k++;
        if (k < 3) continue;
        out.push({ cell: i, score: (d.habitability[i] + 0.05) * k });
      }
      break;
    }
  }
  return out.sort((a, b) => b.score - a.score || a.cell - b.cell);
}

// ---------- 人造的：放在哪 ----------

interface PlaceCtx {
  S: SettleInputs;
  // 城市（computeCityTable 的结果，重要的在前）
  cities: ReturnType<typeof computeCityTable>['list'];
  owner: Int32Array;
  occupied: Set<number>;
}

// 一格的干的陆地邻居（没占的）
function freeNeighbours(P: PlaceCtx, cell: number): number[] {
  const { mesh } = P.S.world;
  const out: number[] = [];
  for (let e = mesh.off[cell]; e < mesh.off[cell + 1]; e++) {
    const j = mesh.adj[e];
    if (P.S.x.dry[j] && !P.occupied.has(j)) out.push(j);
  }
  return out.sort((a, b) => a - b);
}

// 城市旁边的一格（城市那一格之外；都占了时用城市那一格）
function besideCity(P: PlaceCtx, cell: number, rand: () => number, want?: (j: number) => boolean): number | undefined {
  let near = freeNeighbours(P, cell);
  if (want && near.some(want)) near = near.filter(want);
  if (near.length) return near[Math.floor(rand() * near.length)];
  return P.occupied.has(cell) ? undefined : cell;
}

// 带权重随机挑一格
function pickWeighted(cells: readonly number[], w: (i: number) => number, rand: () => number): number | undefined {
  let total = 0;
  for (const c of cells) total += Math.max(0, w(c));
  if (!(total > 0)) return undefined;
  let r = rand() * total;
  for (const c of cells) {
    r -= Math.max(0, w(c));
    if (r <= 0) return c;
  }
  return cells[cells.length - 1];
}

function placeIn(P: PlaceCtx, place: LandmarkPlace, cells: readonly number[], country: number | null, rand: () => number): number | undefined {
  const { world, x, d, cls } = P.S;
  const { mesh, causes, small } = world;
  const free = cells.filter((i) => !P.occupied.has(i));
  if (!free.length) return undefined;
  const mine = P.cities.filter((c) => !c.point && (country === null || c.country === country));
  const classIds = worldTerrainClasses(small).map((c) => c.id);
  const clsIs = (i: number, ids: string[]) => ids.includes(classIds[cls[i] - 1] ?? '');
  switch (place) {
    case 'capital': {
      const cap = mine.find((c) => c.capital) ?? mine[0];
      return cap ? besideCity(P, cap.cell, rand) : undefined;
    }
    case 'big-city': {
      const big = mine.filter((c) => !c.capital && c.rank.level >= 3);
      const c = big[0] ?? mine.find((q) => !q.capital) ?? mine[0];
      return c ? besideCity(P, c.cell, rand) : undefined;
    }
    case 'city': {
      const c = mine[Math.floor(rand() * mine.length)];
      return c ? besideCity(P, c.cell, rand) : undefined;
    }
    case 'coast': {
      const coastal = (i: number) => (x.flags[i] & COAST) !== 0;
      for (const c of mine) {
        let near = false;
        for (let e = mesh.off[c.cell]; e < mesh.off[c.cell + 1]; e++) if (coastal(mesh.adj[e]) || coastal(c.cell)) near = true;
        if (near) return besideCity(P, c.cell, rand, coastal);
      }
      return pickWeighted(free.filter(coastal), (i) => (causes.popTotal?.[i] ?? 0) + 1, rand);
    }
    case 'mountain': {
      const high = free.filter((i) => d.elevation[i] >= 1100 || clsIs(i, ['hills', 'mountains', 'peaks', 'highlands']));
      const top = high.sort((a, b) => d.elevation[b] - d.elevation[a] || a - b).slice(0, 24);
      return pickWeighted(top, (i) => d.elevation[i] ** 2, rand);
    }
    case 'river': {
      const valley = free
        .filter((i) => x.flags[i] & RIVER)
        .map((i) => {
          let rim = 0;
          for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) rim = Math.max(rim, d.elevation[mesh.adj[e]] - d.elevation[i]);
          return { i, s: rim * Math.log10(1 + d.discharge[i]) };
        })
        .sort((a, b) => b.s - a.s || a.i - b.i)
        .slice(0, 12);
      return pickWeighted(
        valley.map((v) => v.i),
        (i) => valley.find((v) => v.i === i)!.s + 1,
        rand,
      );
    }
    case 'desert':
      return pickWeighted(free.filter((i) => clsIs(i, ['desert']) || small.species[d.dominant[i]]?.terrain === 'desert'), () => 1, rand);
    case 'forest':
      return pickWeighted(free.filter((i) => clsIs(i, ['forest', 'woods', 'jungle'])), () => 1, rand);
    case 'border': {
      const terr = causes.country;
      if (!terr || country === null) return undefined;
      const nomad = (id: number) => {
        const g = governmentById(small, small.countries?.[id]?.government ?? '');
        return (g?.nomadic ?? 0) >= 0.5 || !!g?.category.some((c) => c === 'nomadic' || c === 'tribal');
      };
      const w = new Map<number, number>();
      for (const i of free) {
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
          const j = mesh.adj[e];
          if (!causes.land[j] || terr[j] < 0 || terr[j] === country) continue;
          w.set(i, Math.max(w.get(i) ?? 0, nomad(terr[j]) ? 5 : 1));
        }
      }
      return pickWeighted([...w.keys()].sort((a, b) => a - b), (i) => w.get(i)!, rand);
    }
    case 'wild':
      return pickWeighted(free.filter((i) => P.owner[i] < 0), (i) => d.habitability[i] + 0.02, rand);
    case 'any':
      return pickWeighted(free, () => 1, rand);
  }
  return undefined;
}

// ---------- 生成 ----------

// 生成 / 重新生成地标：fresh 时全部换掉，否则自己放的、锁定的留着。返回地标的个数
export function generateLandmarks(S: SettleInputs, rules: SettlementRules, fresh: boolean): number {
  const { world, x } = S;
  const { mesh, small } = world;
  const kept: Record<string, LandmarkMeta> = {};
  if (!fresh) for (const [k, l] of Object.entries(small.landmarks ?? {})) if (!l.auto || l.locked) kept[k] = l;
  small.landmarks = kept;
  const table = computeCityTable(world);
  const occupied = new Set<number>([...Object.values(kept).map((l) => l.cell), ...table.list.map((c) => c.cell)]);
  const P: PlaceCtx = { S, cities: table.list, owner: table.owner, occupied };
  const dry: number[] = [];
  let km2 = 0;
  for (let i = 0; i < mesh.n; i++) if (x.dry[i]) {
    dry.push(i);
    km2 += mesh.area[i] * world.kmPerUnit * world.kmPerUnit;
  }
  if (!dry.length) return Object.keys(kept).length;
  const seed = rules.seed >>> 0;
  const add = (type: LandmarkType, cell: number) => {
    const id = nextSettlementId(world);
    small.landmarks![id] = { id, type: type.id, cell, auto: true };
    occupied.add(cell);
  };
  const scaled = (count: number) => Math.round((count * dry.length) / PER_LAND_CELLS);
  const era = worldEra(small)?.id;
  for (const type of worldLandmarkTypes(small)) {
    if (type.manual || type.count <= 0) continue;
    if (type.category === 'natural') {
      if (!type.detector) continue;
      const cands = detect(S, type.detector).filter((c) => !occupied.has(c.cell));
      const want = Math.max(cands.length ? 1 : 0, scaled(type.count));
      const gap = Math.max(2 * cellKm(world), 0.5 * Math.sqrt(km2 / Math.max(1, want)));
      const chosen: number[] = [];
      for (const c of cands) {
        if (chosen.length >= want) break;
        if (occupied.has(c.cell) || chosen.some((q) => distKm(world, q, c.cell) < gap)) continue;
        chosen.push(c.cell);
        add(type, c.cell);
      }
      continue;
    }
    // 人造的由时代、文化定：没有人文时不放
    if (!small.human || (type.eras?.length && (!era || !type.eras.includes(era)))) continue;
    if (type.per === 'world') {
      const rand = mulberry32(mixSeed(seed, hashString(`landmark:${type.id}`), 0));
      const want = Math.max(type.count > 0 ? 1 : 0, scaled(type.count));
      for (let k = 0; k < want; k++) {
        if (rand() > type.chance) continue;
        const c = placeIn(P, type.place, dry, null, rand);
        if (c !== undefined) add(type, c);
      }
      continue;
    }
    const terr = world.causes.country;
    for (const m of Object.values(small.countries ?? {}).sort((a, b) => a.id - b.id)) {
      const culture = cultureById(small, m.primaryCulture);
      if (type.cultureGroups?.length && (!culture || !type.cultureGroups.includes(culture.group))) continue;
      const gov = governmentById(small, m.government);
      if (type.governments?.length && !gov?.category.some((c) => type.governments!.includes(c))) continue;
      const rand = mulberry32(mixSeed(seed, hashString(`landmark:${type.id}`), m.id));
      const whole = Math.floor(type.count);
      const k = whole + (rand() < type.count - whole ? 1 : 0);
      const cells = terr ? dry.filter((i) => terr[i] === m.id) : [];
      for (let q = 0; q < k; q++) {
        if (rand() > type.chance) continue;
        const c = placeIn(P, type.place, cells, m.id, rand);
        if (c !== undefined) add(type, c);
      }
    }
  }
  return Object.keys(small.landmarks).length;
}

// ---------- 名字 ----------

type Name = { zh: string; orig?: string };

function featureAt(world: World, type: string, cell: number, near = false): GeoFeature | undefined {
  const fs = featuresOf(world, type);
  const hit = fs.find((f) => f.cells.includes(cell));
  if (hit || !near) return hit;
  const { mesh } = world;
  for (let e = mesh.off[cell]; e < mesh.off[cell + 1]; e++) {
    const f = fs.find((g) => g.cells.includes(mesh.adj[e]));
    if (f) return f;
  }
  return undefined;
}

const fname = (f: GeoFeature | undefined): Name | undefined => (f && f.name ? { zh: f.name, ...(f.orig ? { orig: f.orig } : {}) } : undefined);

// 名字里的一个词：{city} {country} {river} {range} {peak} {lake} {place} {culture}
function token(world: World, key: string, cell: number): Name {
  const place = (): Name => {
    const n = cellName(world, cell);
    return { zh: n.zh, ...(n.orig ? { orig: n.orig } : {}) };
  };
  switch (key) {
    case 'peak': {
      const f = peakFeatureAt(world, cell);
      return (f && !world.small.cells?.[cell]?.name ? fname(f) : undefined) ?? place();
    }
    case 'river':
      return fname(featureAt(world, 'river', cell, true)) ?? place();
    case 'range':
      return fname(featureAt(world, 'range', cell, true)) ?? place();
    case 'lake':
      return fname(featureAt(world, 'lake', cell, true)) ?? place();
    case 'city': {
      let best: Name | undefined;
      let bd = Infinity;
      for (const c of cityTable(world).list) {
        const dd = distKm(world, c.cell, cell);
        if (dd < bd) {
          bd = dd;
          best = { zh: c.name, ...(c.orig ? { orig: c.orig } : {}) };
        }
      }
      return best ?? place();
    }
    case 'country': {
      const id = world.causes.country?.[cell] ?? -1;
      const m = id >= 0 ? world.small.countries?.[id] : undefined;
      return m ? { ...m.base } : place();
    }
    case 'culture': {
      const k = world.derived.popCulture?.[cell] ?? 0;
      const c = k ? worldCultures(world.small)[k - 1] : undefined;
      return c ? { zh: c.name } : place();
    }
    default:
      return place();
  }
}

const TOKEN = /\{(\w+)\}/g;

// 按写法起名（写法里的词换成当地的名字；原文：写法有原文、用到的词都有原文时才有）
function fill(world: World, pattern: { zh: string; orig?: string }, cell: number): Name {
  const cache = new Map<string, Name>();
  const get = (k: string) => {
    let v = cache.get(k);
    if (!v) cache.set(k, (v = token(world, k, cell)));
    return v;
  };
  const zh = pattern.zh.replace(TOKEN, (_, k: string) => get(k).zh);
  let orig: string | undefined;
  const keys = [...pattern.zh.matchAll(TOKEN)].map((m) => m[1]);
  const only = pattern.zh.match(/^\{(\w+)\}$/);
  if (pattern.orig) {
    const ok = [...pattern.orig.matchAll(TOKEN)].every((m) => get(m[1]).orig);
    if (ok) orig = pattern.orig.replace(TOKEN, (_, k: string) => get(k).orig!);
  } else if (only && keys.length === 1) orig = get(only[1]).orig;
  return orig ? { zh, orig } : { zh };
}

// 当地的文化（定称号的说法）：这一格人口里占多数的文化，没有时这一格所属国家的主流文化
function localCulture(world: World, cell: number) {
  const k = world.derived.popCulture?.[cell] ?? 0;
  if (k) return worldCultures(world.small)[k - 1];
  const id = world.causes.country?.[cell] ?? -1;
  const m = id >= 0 ? world.small.countries?.[id] : undefined;
  return m ? cultureById(world.small, m.primaryCulture) : undefined;
}

export function landmarkName(world: World, l: LandmarkMeta): Name & { custom: boolean } {
  if (l.name) return { zh: l.name, ...(l.orig ? { orig: l.orig } : {}), custom: true };
  const type = landmarkTypeById(world.small, l.type);
  const pattern = pickTitle(type?.label, localCulture(world, l.cell)) ?? { zh: type?.name ?? l.type };
  const n = fill(world, pattern, l.cell);
  return { ...n, custom: false };
}

// ---------- 给界面的 ----------

export interface LandmarkInfo {
  id: number;
  type: string;
  typeName: string;
  category: 'natural' | 'manmade';
  icon: string;
  color?: string;
  cell: number;
  x: number;
  y: number;
  name: string;
  orig?: string;
  customName: boolean;
  description?: string;
  auto: boolean;
  locked: boolean;
  country: number | null;
  elevation: number;
}

export function landmarkList(world: World): LandmarkInfo[] {
  const { mesh, small, causes, derived: d } = world;
  return Object.values(small.landmarks ?? {})
    .sort((a, b) => a.id - b.id)
    .map((l) => {
      const t = landmarkTypeById(small, l.type);
      const n = landmarkName(world, l);
      const c = causes.country?.[l.cell] ?? -1;
      const desc = l.description ?? t?.description;
      return {
        id: l.id,
        type: l.type,
        typeName: t?.name ?? l.type,
        category: t?.category ?? 'manmade',
        icon: t?.icon ?? 'pin',
        ...(t?.color ? { color: t.color } : {}),
        cell: l.cell,
        x: mesh.x[l.cell],
        y: mesh.y[l.cell],
        name: n.zh,
        ...(n.orig ? { orig: n.orig } : {}),
        customName: n.custom,
        ...(desc ? { description: desc } : {}),
        auto: !!l.auto,
        locked: !!l.locked,
        country: c >= 0 && small.countries?.[c] ? c : null,
        elevation: Math.round(d.elevation[l.cell]),
      };
    });
}

export const landmarkArchive = (world: World, id: number): LandmarkInfo | undefined => landmarkList(world).find((l) => l.id === id);

// ---------- 编辑 ----------

export function landmarkOf(world: World, id: number): LandmarkMeta {
  const l = world.small.landmarks?.[id];
  if (!l) throw new CommandError(`找不到地标 ${id}`);
  return l;
}

export function addLandmark(world: World, type: string, cell: number, opts: { name?: string; orig?: string; description?: string } = {}): number {
  if (!landmarkTypeById(world.small, type)) throw new CommandError(`没有地标类型“${type}”`);
  if (!world.causes.land[cell]) throw new CommandError('地标要在陆地上');
  const id = nextSettlementId(world);
  const l: LandmarkMeta = { id, type, cell };
  if (opts.name?.trim()) {
    l.name = opts.name.trim();
    if (opts.orig?.trim()) l.orig = opts.orig.trim();
  }
  if (opts.description?.trim()) l.description = opts.description;
  (world.small.landmarks ??= {})[id] = l;
  return id;
}

export function moveLandmark(world: World, id: number, cell: number) {
  const l = landmarkOf(world, id);
  if (!world.causes.land[cell]) throw new CommandError('地标要在陆地上');
  l.cell = cell;
  delete l.auto;
}

export interface LandmarkPatch {
  type?: string;
  name?: string;
  orig?: string;
  description?: string | null;
  locked?: boolean;
}

export function setLandmark(world: World, id: number, p: LandmarkPatch): string[] {
  const l = landmarkOf(world, id);
  const what: string[] = [];
  if (p.type !== undefined) {
    if (!landmarkTypeById(world.small, p.type)) throw new CommandError(`没有地标类型“${p.type}”`);
    l.type = p.type;
    what.push('类型');
  }
  if (p.name !== undefined) {
    if (p.name.trim()) {
      l.name = p.name.trim();
      if (p.orig?.trim()) l.orig = p.orig.trim();
      else delete l.orig;
      what.push('改名');
    } else {
      delete l.name;
      delete l.orig;
      what.push('名字恢复自动');
    }
  }
  if (p.description !== undefined) {
    if (p.description?.trim()) l.description = p.description;
    else delete l.description;
    what.push('简介');
  }
  if (p.locked !== undefined) {
    if (p.locked) l.locked = true;
    else delete l.locked;
    what.push(p.locked ? '锁定' : '解锁');
  }
  if (what.length && (p.type !== undefined || p.name !== undefined)) delete l.auto;
  return what;
}

// 改了陆海之后：变成海的格上的地标删掉（锁定的挪到最近的陆地）
export function repairLandmarks(world: World): boolean {
  const ls = world.small.landmarks;
  if (!ls) return false;
  let changed = false;
  for (const l of Object.values(ls).sort((a, b) => a.id - b.id)) {
    if (world.causes.land[l.cell]) continue;
    changed = true;
    const to = l.locked ? nearestLand(world, l.cell) : -1;
    if (to >= 0) l.cell = to;
    else delete ls[l.id];
  }
  return changed;
}
