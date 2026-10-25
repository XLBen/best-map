import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { digest, digestWorld } from '../../tools/hash';
import { type Command, CommandError } from '../commands';
import { Engine } from '../engine';
import { EXPORT_PARTS, exportPackage, exportPart, exportPartAvailable } from '../export';
import { continents, engineFor, snapshot } from '../testing/fixtures';
import type { World } from '../world';
import {
  BUILTIN_LANDMARK_TYPES,
  BUILTIN_POINT_TYPES,
  BUILTIN_RANKS,
  allCountryStats,
  cellArchive,
  cityArchive,
  cityList,
  detectLandmarks,
  dragRoadHandle,
  landmarkList,
  pointList,
  rankFor,
  roadHandles,
  roadPaths,
  settleInputs,
  traceRoad,
  worldCityRanks,
} from './index';
import { RIVER } from './rules';
import { roadCosts } from './roads';

// 第二十四轮：城市、道路、地标、自定义点、导出

const GROUPS = [
  { id: 'western', weight: 3 },
  { id: 'eastern', weight: 3 },
  { id: 'steppe', weight: 1.5 },
];
const GEN: Command = { op: 'generate_human', era: 'medieval', groups: GROUPS, countries: {}, settlements: {} };

// 有省份、人文、国家、城市、道路、地标的大陆世界（1.2 万格的地区）
const settled = (): Engine =>
  snapshot('settled', () => {
    const eng = continents({ provinces: true });
    eng.exec(GEN);
    return eng;
  });

const dry = (w: World, i: number) => w.causes.land[i] === 1 && w.derived.lake[i] !== 1;
const adjacent = (w: World, a: number, b: number) => {
  for (let e = w.mesh.off[a]; e < w.mesh.off[a + 1]; e++) if (w.mesh.adj[e] === b) return true;
  return false;
};
const settleDigest = (w: World) => ({
  cities: digest(w.small.cities ?? null),
  roads: digest(w.small.roads ?? null),
  landmarks: digest(w.small.landmarks ?? null),
  points: digest(w.small.points ?? null),
  rules: JSON.stringify(w.small.settlementRules ?? null),
});
const cityIds = (w: World) => Object.keys(w.small.cities ?? {}).map(Number);

// 金标准（第二十四轮记下）：以后提速、重构，生成的城市、道路、地标必须逐值不变；有意改了规则、内置的内容时重录
// 第二十六轮重录：国家的生成变了（等级、领土补齐、联邦），大城市的门槛 1% → 3% 并且每国有上限（大城市连大道、地标放在大城市旁）
const RECORDED = {
  region: { cities: 'd031f8e0d978e7a7', roads: '991833b51ed241ac', landmarks: '7faa1d0d6f57b110' },
  planet: { cities: 'be811de445416fea', roads: 'de67f6de2afa75a7', landmarks: '6aee251e1389a89c' },
};
const genDigest = (w: World) => ({ cities: digest(w.small.cities), roads: digest(w.small.roads), landmarks: digest(w.small.landmarks) });

// 道路连成的图：每个城市从它的格能走到哪些城市的格
function reachable(w: World, from: number): Set<number> {
  const adj = new Map<number, number[]>();
  for (const r of Object.values(w.small.roads ?? {})) {
    for (let k = 0; k + 1 < r.cells.length; k++) {
      const a = r.cells[k];
      const b = r.cells[k + 1];
      (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
      (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
    }
  }
  const seen = new Set([from]);
  const q = [from];
  for (let h = 0; h < q.length; h++) for (const j of adj.get(q[h]) ?? []) if (!seen.has(j)) {
    seen.add(j);
    q.push(j);
  }
  return seen;
}

// 干的陆地连成的块
function pieces(w: World): Int32Array {
  const out = new Int32Array(w.mesh.n).fill(-1);
  let k = 0;
  for (let s = 0; s < w.mesh.n; s++) {
    if (!dry(w, s) || out[s] >= 0) continue;
    out[s] = k;
    const q = [s];
    for (let h = 0; h < q.length; h++) for (let e = w.mesh.off[q[h]]; e < w.mesh.off[q[h] + 1]; e++) {
      const j = w.mesh.adj[e];
      if (dry(w, j) && out[j] < 0) {
        out[j] = k;
        q.push(j);
      }
    }
    k++;
  }
  return out;
}

describe('内置的内容', () => {
  it('城市等级四种总在；地标类型、点的类型合格、不重复', () => {
    expect(BUILTIN_RANKS.map((r) => [r.id, r.icon])).toEqual([
      ['capital', 'star'],
      ['big', 'double-ring'],
      ['medium', 'circle'],
      ['small', 'dot'],
    ]);
    const w = continents().world;
    expect(worldCityRanks(w.small)).toBe(BUILTIN_RANKS);
    for (const list of [BUILTIN_LANDMARK_TYPES, BUILTIN_POINT_TYPES]) expect(new Set(list.map((x) => x.id)).size).toBe(list.length);
    for (const t of BUILTIN_LANDMARK_TYPES) {
      if (t.category === 'natural') expect(t.detector, t.id).toBeTruthy();
      expect(t.name.length).toBeLessThanOrEqual(20);
    }
    expect(BUILTIN_POINT_TYPES.some((t) => t.actsAsCity?.capital)).toBe(true);
    // 等级按比例：够得上的里最重要的
    expect(rankFor(BUILTIN_RANKS, 0.05, 1e6).id).toBe('big');
    expect(rankFor(BUILTIN_RANKS, 0.005, 1e4).id).toBe('medium');
    expect(rankFor(BUILTIN_RANKS, 0.0001, 10).id).toBe('small');
  });

  it('改一种等级的门槛：城市的等级跟着变，不重算推导；停用换回内置的', () => {
    const eng = settled();
    const w = eng.world;
    const before = cityList(w).filter((c) => c.rank.id === 'big').length;
    const derived = w.derived;
    // 第二十六轮：每国的上限也去掉（perCountry 1）
    eng.exec({ op: 'set_content', kind: 'cityRank', id: 'big', item: { ...BUILTIN_RANKS[1], minShare: 0, perCountry: 1 } });
    expect(w.derived).toBe(derived);
    const after = cityList(w).filter((c) => c.rank.id === 'big').length;
    expect(after).toBeGreaterThan(before);
    for (const c of cityList(w)) if (!c.capital && !c.secondCapital && c.rankAuto) expect(c.rank.id).toBe('big');
    eng.exec({ op: 'set_content', kind: 'cityRank', id: 'big', item: null });
    expect(cityList(w).filter((c) => c.rank.id === 'big').length).toBe(before);
  });
});

describe('城市', () => {
  it('一格最多一座、都在干的陆地上；每个国家的首都格上有城市，是星；等级按占本国人口的比例', () => {
    const w = settled().world;
    const list = cityList(w);
    expect(list.length).toBeGreaterThan(40);
    expect(new Set(list.map((c) => c.cell)).size).toBe(list.length);
    for (const c of list) expect(dry(w, c.cell)).toBe(true);
    for (const m of Object.values(w.small.countries!)) {
      const c = list.find((x) => x.cell === m.capitalCell);
      expect(c, m.name).toBeTruthy();
      expect(c!.capital).toBe(true);
      expect(c!.rank.icon).toBe('star');
    }
    const ranks = worldCityRanks(w.small);
    for (const c of list) {
      if (c.capital) continue;
      const want = rankFor(ranks, c.share, c.population).id;
      // 第二十六轮：大城市每国有上限，超出的降一级
      if (want === 'big' && c.rank.id !== 'big') expect(c.rank.id).toBe(rankFor(ranks.filter((r) => r.id !== 'big'), c.share, c.population).id);
      else expect(c.rank.id).toBe(want);
      expect(c.population).toBeGreaterThan(0);
      expect(c.share).toBeLessThan(0.2);
    }
    // 几种等级都有；大的比小的少（第二十六轮：大城市要占本国人口的 3%，中世纪城市化率低，大城市很少，见下面的“每国的上限”）
    const n = (id: string) => list.filter((c) => c.rank.id === id).length;
    expect(n('medium')).toBeGreaterThan(0);
    expect(n('small')).toBeGreaterThan(0);
    expect(n('big')).toBeLessThan(n('medium') + n('small'));
    // 城市的人口加起来约是城市化率 × 总人口（管着的格之外的不算）
    let total = 0;
    for (let i = 0; i < w.mesh.n; i++) total += w.causes.popTotal![i];
    const urban = list.reduce((s, c) => s + c.population, 0);
    expect(urban / total).toBeGreaterThan(0.04);
    expect(urban / total).toBeLessThanOrEqual(0.1 + 1e-6);
    // 重要的在前
    for (let k = 1; k < list.length; k++) expect(list[k - 1].rank.level).toBeGreaterThanOrEqual(list[k].rank.level);
    // 名字不重
    const auto = list.filter((c) => !c.customName).map((c) => c.name);
    expect(new Set(auto).size).toBeGreaterThan(auto.length * 0.97);
  });

  it('城市化率高的时代城市多', () => {
    const count = (era: string) => {
      const eng = continents({ provinces: true });
      eng.exec({ op: 'generate_human', era, groups: [{ id: 'western', weight: 3 }, { id: 'eastern', weight: 3 }], countries: {}, settlements: { roads: false, landmarks: false } });
      return cityIds(eng.world).length;
    };
    const ancient = count('antiquity');
    const medieval = count('medieval');
    const modern = count('modern');
    expect(medieval).toBeGreaterThan(ancient);
    expect(modern).toBeGreaterThan(1.8 * medieval);
  });

  it('同样的参数同样的结果；重放、检查点一致；撤销后与没生成过一样', () => {
    const a = settled();
    const b = continents({ provinces: true });
    b.exec(GEN);
    expect(settleDigest(b.world)).toEqual(settleDigest(a.world));
    const doc = a.toDoc();
    expect(settleDigest(Engine.fromDoc(doc, a.world.mesh).world)).toEqual(settleDigest(a.world));
    const cp = structuredClone(a.toCheckpoint());
    expect(settleDigest(Engine.fromCheckpoint(cp, doc, a.world.mesh)!.world)).toEqual(settleDigest(a.world));
    const plain = continents({ provinces: true });
    const before = digestWorld(plain.world);
    plain.exec(GEN);
    plain.undo();
    expect(plain.world.small.cities).toBeUndefined();
    expect(plain.world.small.roads).toBeUndefined();
    expect(digestWorld(plain.world)).toEqual(before);
    expect(genDigest(a.world)).toEqual(RECORDED.region);
  });

  it('没写 settlements 时没有城市与道路（第二十三轮的世界不变）；换种子换一个样子', () => {
    const a = continents({ provinces: true });
    a.exec({ op: 'generate_human', era: 'medieval', groups: GROUPS, countries: {} });
    for (const k of ['cities', 'roads', 'landmarks', 'points', 'settlementRules', 'nextSettlement'] as const) expect(a.world.small[k]).toBeUndefined();
    const eng = settled();
    eng.exec({ op: 'regenerate_settlements', seed: 99 });
    expect(digest(eng.world.small.cities)).not.toEqual(digest(settled().world.small.cities));
    // 再不带 settlements 生成人文：城市、道路去掉
    eng.exec({ op: 'generate_human', era: 'medieval', groups: GROUPS, countries: {} });
    expect(eng.world.small.cities).toBeUndefined();
    expect(eng.world.small.roads).toBeUndefined();
  });

  it('整个星球上也一样', () => {
    const eng = engineFor({ seed: 3, cells: 6000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    eng.exec(GEN);
    const w = eng.world;
    expect(cityIds(w).length).toBeGreaterThan(10);
    const again = Engine.fromDoc(eng.toDoc(), w.mesh);
    expect(settleDigest(again.world)).toEqual(settleDigest(w));
    for (const r of roadPaths(w)) for (let k = 1; k < r.points.length; k++) expect(Math.abs(r.points[k][0] - r.points[k - 1][0])).toBeLessThan(0.5);
    expect(genDigest(w)).toEqual(RECORDED.planet);
  });

  it('加、删、挪、改城市；挪首都城市时首都跟着挪；档案', () => {
    const eng = settled();
    const w = eng.world;
    const taken = new Set(cityList(w).map((c) => c.cell));
    const cell = [...Array(w.mesh.n).keys()].find((i) => dry(w, i) && !taken.has(i) && w.causes.popTotal![i] > 0)!;
    const sea = [...Array(w.mesh.n).keys()].find((i) => !w.causes.land[i])!;
    expect(() => eng.exec({ op: 'add_city', cell: sea })).toThrow(CommandError);
    expect(() => eng.exec({ op: 'add_city', cell: [...taken][0] })).toThrow(CommandError);
    expect(eng.exec({ op: 'add_city', cell, name: '新城' })).toBe('新建城市“新城”');
    const id = Math.max(...cityIds(w));
    expect(w.small.cities![id].auto).toBeUndefined();
    const info = cityList(w).find((c) => c.id === id)!;
    expect(info.name).toBe('新城');
    expect(info.customName).toBe(true);
    eng.exec({ op: 'set_city', id, patch: { rank: 'big', description: '一座新城。', locked: true } });
    const a = cityArchive(w, id)!;
    expect(a.rank.id).toBe('big');
    expect(a.rankAuto).toBe(false);
    expect(a.description).toBe('一座新城。');
    expect(a.locked).toBe(true);
    eng.exec({ op: 'set_city', id, patch: { name: '', rank: null } });
    const b = cityArchive(w, id)!;
    expect(b.customName).toBe(false);
    expect(b.rankAuto).toBe(true);
    const name = b.name;
    eng.exec({ op: 'set_city', id, patch: { reroll: true } });
    expect(cityArchive(w, id)!.name).not.toBe(name);
    // 自动的档案：建城年份、简介、文化
    const cap = cityList(w).find((c) => c.capital)!;
    const ca = cityArchive(w, cap.id)!;
    expect(ca.founded).toBe(w.small.countries![cap.country!].founded);
    expect(ca.description).toContain('首都');
    expect(ca.cultures.length).toBeGreaterThan(0);
    expect(ca.cultures.reduce((s, x) => s + x.share, 0)).toBeLessThanOrEqual(1 + 1e-6);
    // 挪首都那座城市：首都跟着挪（同一个国家里）
    const m = w.small.countries![cap.country!];
    const to = [...Array(w.mesh.n).keys()].find((i) => dry(w, i) && w.causes.country![i] === m.id && !cityList(w).some((c) => c.cell === i) && adjacent(w, i, cap.cell))!;
    eng.exec({ op: 'move_city', id: cap.id, cell: to });
    expect(m.capitalCell).toBe(to);
    expect(m.capitalLocked).toBe(true);
    expect(cityList(w).find((c) => c.id === cap.id)!.capital).toBe(true);
    // 连着它的道路重走：一头在新的格上
    for (const r of Object.values(w.small.roads!)) {
      if (r.from === cap.id) expect(r.cells[0]).toBe(to);
      if (r.to === cap.id) expect(r.cells[r.cells.length - 1]).toBe(to);
    }
    // 格的档案里有城市
    expect(cellArchive(w, to).city?.id).toBe(cap.id);
    // 删除：连着它的自动道路一起删；首都格上补一座自动的城市
    eng.exec({ op: 'remove_city', id: cap.id });
    expect(w.small.cities![cap.id]).toBeUndefined();
    for (const r of Object.values(w.small.roads!)) expect(r.from === cap.id || r.to === cap.id).toBe(false);
    expect(cityList(w).find((c) => c.cell === to)?.capital).toBe(true);
    // 撤销回去
    for (let k = 0; k < 6; k++) eng.undo();
    expect(settleDigest(w)).toEqual(settleDigest(settled().world));
  });

  it('重新生成：锁定的、自己放的留着，画的道路留着', () => {
    const eng = settled();
    const w = eng.world;
    const some = cityList(w).find((c) => !c.capital)!;
    eng.exec({ op: 'set_city', id: some.id, patch: { locked: true } });
    const taken = new Set(cityList(w).map((c) => c.cell));
    const cell = [...Array(w.mesh.n).keys()].find((i) => dry(w, i) && !taken.has(i))!;
    eng.exec({ op: 'add_city', cell });
    const mine = Math.max(...cityIds(w));
    const a = [...Array(w.mesh.n).keys()].find((i) => dry(w, i) && [...w.mesh.adj.subarray(w.mesh.off[i], w.mesh.off[i + 1])].filter((j) => dry(w, j)).length >= 3)!;
    const b = [...w.mesh.adj.subarray(w.mesh.off[a], w.mesh.off[a + 1])].find((j) => dry(w, j))!;
    eng.exec({ op: 'add_road', cells: [a, b], kind: 'major' });
    const road = Math.max(...Object.keys(w.small.roads!).map(Number));
    eng.exec({ op: 'regenerate_settlements', seed: 7 });
    expect(w.small.cities![some.id]?.cell).toBe(some.cell);
    expect(w.small.cities![mine]?.cell).toBe(cell);
    expect(w.small.roads![road]?.cells).toEqual([a, b]);
    // 重新生成人文：自动的跟着换，锁定的留着
    eng.exec({ op: 'regenerate_human', seed: 11 });
    expect(w.small.cities![some.id]?.cell).toBe(some.cell);
    expect(w.small.roads![road]).toBeTruthy();
    eng.exec({ op: 'generate_cities' });
    expect(w.small.cities![some.id]).toBeUndefined();
  });

  it('改地形以后：变成海的格上的城市删掉，锁定的挪到最近的陆地，道路断开；重放一致', () => {
    const eng = settled();
    const w = eng.world;
    const coastal = cityList(w).filter((c) => !c.capital && [...w.mesh.adj.subarray(w.mesh.off[c.cell], w.mesh.off[c.cell + 1])].some((j) => !w.causes.land[j]));
    const [c1, c2] = coastal;
    eng.exec({ op: 'set_city', id: c2.id, patch: { locked: true } });
    const disc = (c: number) => [...Array(w.mesh.n).keys()].filter((i) => Math.hypot(w.mesh.x[i] - w.mesh.x[c], w.mesh.y[i] - w.mesh.y[c]) < w.mesh.spacing * 2.2);
    const cells = [...new Set([...disc(c1.cell), ...disc(c2.cell)])];
    eng.exec({ op: 'paint_land', cells, t: cells.map(() => 0), mode: 'sea' });
    expect(w.causes.land[c1.cell]).toBe(0);
    expect(w.small.cities![c1.id]).toBeUndefined();
    expect(w.causes.land[c2.cell]).toBe(0);
    for (const r of Object.values(w.small.roads ?? {})) for (const c of r.cells) expect(w.causes.land[c]).toBe(1);
    const moved = w.small.cities![c2.id];
    expect(moved).toBeTruthy();
    expect(w.causes.land[moved.cell]).toBe(1);
    const doc = eng.toDoc();
    expect(settleDigest(Engine.fromDoc(doc, w.mesh).world)).toEqual(settleDigest(w));
  });
});

describe('道路', () => {
  it('每块陆地上的城市都连得上；只走陆地、前后相邻；大道连首都与大城市', () => {
    const w = settled().world;
    const roads = Object.values(w.small.roads!);
    expect(roads.length).toBeGreaterThan(20);
    expect(roads.some((r) => r.kind === 'major')).toBe(true);
    for (const r of roads) {
      expect(r.cells.length).toBeGreaterThanOrEqual(2);
      for (let k = 0; k < r.cells.length; k++) {
        expect(dry(w, r.cells[k])).toBe(true);
        if (k) expect(adjacent(w, r.cells[k - 1], r.cells[k])).toBe(true);
      }
    }
    const piece = pieces(w);
    const list = cityList(w);
    const byPiece = new Map<number, number[]>();
    for (const c of list) (byPiece.get(piece[c.cell]) ?? byPiece.set(piece[c.cell], []).get(piece[c.cell])!).push(c.cell);
    for (const cells of byPiece.values()) {
      const reach = reachable(w, cells[0]);
      for (const c of cells) expect(reach.has(c)).toBe(true);
    }
    // 大道的两头是首都、大城市
    const majorCity = new Set(list.filter((c) => c.capital || c.rank.level >= 3).map((c) => c.id));
    for (const r of roads) if (r.kind === 'major' && r.from !== undefined) expect(majorCity.has(r.from)).toBe(true);
    // 同一条边不存两次
    const edges = new Set<string>();
    for (const r of roads) for (let k = 0; k + 1 < r.cells.length; k++) {
      const key = [r.cells[k], r.cells[k + 1]].sort((p, q) => p - q).join(':');
      expect(edges.has(key)).toBe(false);
      edges.add(key);
    }
  });

  it('按地形的代价找路：比直线走过去便宜，绕开难走的地方', () => {
    const w = settled().world;
    const S = settleInputs(w, w.derived);
    const costs = roadCosts(S);
    const edgeCost = (a: number, b: number) => {
      for (let e = w.mesh.off[a]; e < w.mesh.off[a + 1]; e++) if (w.mesh.adj[e] === b) return costs[e];
      return Infinity;
    };
    const cost = (cells: readonly number[]) => cells.slice(1).reduce((s, c, k) => s + edgeCost(cells[k], c), 0);
    let checked = 0;
    for (const r of Object.values(w.small.roads!)) {
      if (r.kind !== 'major' || r.cells.length < 6) continue;
      const a = r.cells[0];
      const b = r.cells[r.cells.length - 1];
      const t = traceRoad(w, [
        [w.mesh.x[a], w.mesh.y[a]],
        [w.mesh.x[b], w.mesh.y[b]],
      ]);
      if (!('cells' in t) || t.cells.some((c) => !dry(w, c))) continue;
      expect(cost(r.cells)).toBeLessThanOrEqual(cost(t.cells) * 1.15);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    // 山地贵：走一格山地比走一格平原贵
    const move = (id: string) => worldClassMove(w, id);
    expect(move('mountains')).toBeGreaterThan(move('plains'));
    // 海走不了
    for (let i = 0; i < w.mesh.n; i++) {
      if (dry(w, i)) continue;
      for (let e = w.mesh.off[i]; e < w.mesh.off[i + 1]; e++) expect(costs[e]).toBe(Infinity);
    }
  });

  it('画、改走向、删除、改种类；控制点', () => {
    const eng = settled();
    const w = eng.world;
    const list = cityList(w);
    const piece = pieces(w);
    const [p, q] = list.filter((c) => piece[c.cell] === piece[list[0].cell]).slice(-2);
    const t = traceRoad(w, [
      [w.mesh.x[p.cell], w.mesh.y[p.cell]],
      [w.mesh.x[q.cell], w.mesh.y[q.cell]],
    ]);
    if (!('cells' in t)) return;
    if (t.cells.some((c) => !w.causes.land[c])) return;
    expect(() => eng.exec({ op: 'add_road', cells: [t.cells[0], t.cells[t.cells.length - 1]] })).toThrow(CommandError);
    expect(eng.exec({ op: 'add_road', cells: t.cells, kind: 'major' })).toMatch(/^画道路 · 约 \d+ km$/);
    const id = Math.max(...Object.keys(w.small.roads!).map(Number));
    const r = w.small.roads![id];
    expect(r.auto).toBeUndefined();
    expect(r.from).toBe(p.id);
    expect(r.to).toBe(q.id);
    const handles = roadHandles(w, r);
    expect(handles[0]).toBe(0);
    expect(handles[handles.length - 1]).toBe(r.cells.length - 1);
    if (handles.length >= 3) {
      const j = 1;
      const c = r.cells[handles[j]];
      const nb = [...w.mesh.adj.subarray(w.mesh.off[c], w.mesh.off[c + 1])].find((x) => dry(w, x) && !r.cells.includes(x));
      if (nb !== undefined) {
        const res = dragRoadHandle(settleInputs(w, w.derived), r, handles, j, [w.mesh.x[nb], w.mesh.y[nb]]);
        if ('cells' in res) {
          eng.exec({ op: 'edit_road', id, cells: res.cells });
          expect(w.small.roads![id].cells).toContain(nb);
          expect(w.small.roads![id].cells[0]).toBe(r.cells[0]);
        }
      }
    }
    // 换一段
    const auto = Object.values(w.small.roads!).find((x) => x.auto && x.cells.length >= 4)!;
    const mid = auto.cells.slice(1, 3);
    eng.exec({ op: 'edit_road', id: auto.id, cells: mid, from: 1, to: 2 });
    expect(w.small.roads![auto.id].auto).toBeUndefined();
    eng.exec({ op: 'set_road', id: auto.id, patch: { kind: 'minor', name: '古道' } });
    expect(w.small.roads![auto.id].kind).toBe('minor');
    expect(roadPaths(w).find((x) => x.id === auto.id)!.name).toBe('古道');
    eng.exec({ op: 'remove_road', id: auto.id });
    expect(w.small.roads![auto.id]).toBeUndefined();
    expect(() => eng.exec({ op: 'remove_road', id: auto.id })).toThrow(CommandError);
  });
});

// 地形类别的通行难度
function worldClassMove(w: World, id: string): number {
  const c = (w.small.content?.terrainClass as Record<string, { movement?: number }> | undefined)?.[id];
  return c?.movement ?? ({ mountains: 2.5, plains: 1 } as Record<string, number>)[id];
}

describe('地标', () => {
  it('自然的、人造的都有；不在城市的格上、不重格；名字按写法', () => {
    const w = settled().world;
    const list = landmarkList(w);
    expect(list.some((l) => l.category === 'natural')).toBe(true);
    expect(list.some((l) => l.category === 'manmade')).toBe(true);
    const cities = new Set(cityList(w).map((c) => c.cell));
    expect(new Set(list.map((l) => l.cell)).size).toBe(list.length);
    for (const l of list) {
      expect(cities.has(l.cell)).toBe(false);
      expect(w.causes.land[l.cell]).toBe(1);
      expect(l.name.length).toBeGreaterThan(0);
    }
    const falls = list.filter((l) => l.type === 'waterfall');
    for (const f of falls) expect(f.name.endsWith('瀑布')).toBe(true);
    const peaks = list.filter((l) => l.type === 'famous-peak');
    expect(peaks.length).toBeGreaterThan(0);
    for (const p of peaks) expect(p.elevation).toBeGreaterThan(1000);
    // 只在中世纪有的类型、别的时代的没有
    expect(list.some((l) => l.type === 'spaceport' || l.type === 'university')).toBe(false);
  });

  it('检测器：瀑布在落差大的河段、峡谷在切得深的河、绿洲在荒漠里的水边', () => {
    const w = continents().world;
    const S = settleInputs(w, w.derived);
    const n = w.mesh.n;
    const el = new Float32Array(n).fill(200);
    const flags = new Uint8Array(n);
    const dryAll = new Uint8Array(n).fill(1);
    const receiver = new Int32Array(n).fill(-1);
    const discharge = new Float32Array(n);
    // 一条河：从 a 流到 b（落差 800 m），b 两边高 1200 m
    const a = Math.floor(n / 2);
    const b = w.mesh.adj[w.mesh.off[a]];
    flags[a] = RIVER;
    flags[b] = RIVER;
    receiver[a] = b;
    el[a] = 1000;
    el[b] = 200;
    discharge[a] = discharge[b] = 5000;
    for (let e = w.mesh.off[b]; e < w.mesh.off[b + 1]; e++) if (w.mesh.adj[e] !== a) el[w.mesh.adj[e]] = 1400;
    const fake = { ...S, x: { ...S.x, dry: dryAll, flags, elevation: el }, d: { ...S.d, elevation: el, receiver, discharge } };
    const falls = detectLandmarks(fake, 'waterfall');
    expect(falls[0]?.cell).toBe(a);
    const canyon = detectLandmarks(fake, 'canyon');
    expect(canyon[0]?.cell).toBe(b);
    // 绿洲：荒漠中间一格有河
    const desert = 12;
    const cls = new Uint8Array(n).fill(desert);
    const sp = w.small.species.findIndex((s) => s.terrain === 'desert');
    const dom = new Int16Array(n).fill(sp);
    const oasis = detectLandmarks({ ...fake, cls, d: { ...fake.d, dominant: dom as unknown as typeof S.d.dominant } }, 'oasis');
    expect(oasis.map((o) => o.cell)).toEqual(expect.arrayContaining([a, b]));
  });

  it('加、挪、改、删；重新生成时自己放的留着；变成海的删掉', () => {
    const eng = settled();
    const w = eng.world;
    const used = new Set([...cityList(w).map((c) => c.cell), ...landmarkList(w).map((l) => l.cell)]);
    const free = (i: number) => dry(w, i) && !used.has(i);
    const cell = [...Array(w.mesh.n).keys()].find((i) => free(i) && [...w.mesh.adj.subarray(w.mesh.off[i], w.mesh.off[i + 1])].some(free))!;
    expect(() => eng.exec({ op: 'add_landmark', type: 'nope', cell })).toThrow(CommandError);
    eng.exec({ op: 'add_landmark', type: 'temple', cell, name: '白塔寺' });
    const id = Math.max(...Object.keys(w.small.landmarks!).map(Number));
    expect(landmarkList(w).find((l) => l.id === id)!.name).toBe('白塔寺');
    expect(cellArchive(w, cell).landmarks?.[0].id).toBe(id);
    const to = [...w.mesh.adj.subarray(w.mesh.off[cell], w.mesh.off[cell + 1])].find(free)!;
    eng.exec({ op: 'move_landmark', id, cell: to });
    eng.exec({ op: 'set_landmark', id, patch: { type: 'castle', name: '', description: '古老的城堡。' } });
    const info = landmarkList(w).find((l) => l.id === id)!;
    expect(info.typeName).toBe('城堡');
    expect(info.customName).toBe(false);
    expect(info.description).toBe('古老的城堡。');
    eng.exec({ op: 'generate_landmarks' });
    expect(w.small.landmarks![id]).toBeTruthy();
    eng.exec({ op: 'generate_landmarks', keepManual: false });
    expect(w.small.landmarks![id]).toBeUndefined();
    const l = landmarkList(w)[0];
    eng.exec({ op: 'remove_landmark', id: l.id });
    expect(w.small.landmarks![l.id]).toBeUndefined();
  });

  it('没有人文也能生成自然的地标', () => {
    const eng = continents();
    eng.exec({ op: 'generate_landmarks' });
    const list = landmarkList(eng.world);
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((l) => l.category === 'natural')).toBe(true);
    expect(eng.world.small.cities).toBeUndefined();
  });
});

describe('自定义点', () => {
  it('陪都：挂在城市上，档案里也算首都；没挂时自己当一座城市；改、挪、删', () => {
    const eng = settled();
    const w = eng.world;
    const big = cityList(w).find((c) => !c.capital && c.country !== null)!;
    eng.exec({ op: 'add_point', type: 'second-capital', cell: big.cell });
    const pid = Math.max(...Object.keys(w.small.points!).map(Number));
    expect(w.small.points![pid].attachedCity).toBe(big.id);
    expect(w.small.points![pid].name).toBe('陪都');
    const c = cityList(w).find((x) => x.id === big.id)!;
    expect(c.secondCapital).toBe(true);
    expect(c.rank.id).toBe('capital');
    const st = allCountryStats(w).get(big.country!)!;
    expect(st.capitals[0]).toBe(cityList(w).find((x) => x.capital && x.country === big.country)!.id);
    expect(st.capitals).toContain(big.id);
    expect(st.cities).toBe(cityList(w).filter((x) => x.country === big.country).length);
    expect(cityArchive(w, big.id)!.description).toContain('陪都');
    // 挪到没有城市的格：自己当一座城市
    const used = new Set(cityList(w).map((x) => x.cell));
    const free = [...Array(w.mesh.n).keys()].find((i) => dry(w, i) && !used.has(i) && w.causes.country![i] === big.country)!;
    eng.exec({ op: 'move_point', id: pid, cell: free, x: w.mesh.x[free] + 0.001, y: w.mesh.y[free] });
    expect(w.small.points![pid].attachedCity).toBeUndefined();
    const own = cityList(w).find((x) => x.point && x.id === pid)!;
    expect(own.secondCapital).toBe(true);
    expect(own.x).toBeCloseTo(w.mesh.x[free] + 0.001, 9);
    eng.exec({ op: 'set_point', id: pid, patch: { type: 'marker', name: '营地甲', note: '备注' } });
    expect(cityList(w).some((x) => x.point)).toBe(false);
    const info = pointList(w).find((p) => p.id === pid)!;
    expect(info).toMatchObject({ name: '营地甲', note: '备注', actsAsCity: false });
    expect(cellArchive(w, free).points?.[0].name).toBe('营地甲');
    eng.exec({ op: 'remove_point', id: pid });
    expect(w.small.points![pid]).toBeUndefined();
    expect(() => eng.exec({ op: 'add_point', type: 'nope', cell: free })).toThrow(CommandError);
  });
});

describe('导出', () => {
  it('整合包多了城市、道路、地标、点的表、道路图与档案全文；分开导出的与包里的一样', () => {
    const eng = settled();
    const w = eng.world;
    eng.exec({ op: 'add_point', type: 'fortress', cell: cityList(w)[0].cell, name: '北关' });
    const opts = { width: 256, height: 128, seaLevelGray: 95, maxElevation: 6000 };
    const pkg = exportPackage(w, eng.toDoc(), opts);
    expect(pkg.files).toEqual(expect.arrayContaining(['cities.csv', 'roads.csv', 'roads.geojson', 'roads.bmp', 'landmarks.csv', 'points.csv', 'archive.md', 'archive.json']));
    const files = unzipSync(pkg.zip);
    const cities = strFromU8(files['cities.csv']).trim().split('\n');
    expect(cities[0]).toBe('id,name,orig,rank,capital,country,country_name,population,share,cell,lat,lon,province,founded,auto');
    expect(cities.length).toBe(1 + cityIds(w).length);
    const geo = JSON.parse(strFromU8(files['roads.geojson']));
    expect(geo.features.length).toBe(Object.keys(w.small.roads!).length);
    expect(geo.features[0].geometry.coordinates.length).toBeGreaterThan(1);
    const md = strFromU8(files['archive.md']);
    expect(md).toContain('## 国家');
    expect(md).toContain('## 城市');
    expect(md).toContain('## 地标');
    expect(md).toContain('北关');
    for (const m of Object.values(w.small.countries!)) expect(md).toContain(m.name);
    const json = JSON.parse(strFromU8(files['archive.json']));
    expect(json.cities.length).toBe(cityIds(w).length);
    expect(json.countries.length).toBe(Object.keys(w.small.countries!).length);
    expect(strFromU8(files['README.txt'])).toContain('archive.md');
    // 分开导出
    for (const part of EXPORT_PARTS) {
      expect(exportPartAvailable(w, part.id)).toBe(true);
      const got = exportPart(w, part.id, { width: 256, height: 128 });
      expect(Object.keys(got)).toEqual([...part.files]);
      for (const f of part.files) if (!f.endsWith('.bmp') && f !== 'features.csv') expect(strFromU8(got[f])).toBe(strFromU8(files[f]));
    }
  });

  it('没有城市、道路、地标、点的世界：包里的文件与以前一样', () => {
    const eng = continents({ provinces: true });
    eng.exec({ op: 'generate_human', era: 'medieval', groups: GROUPS, countries: {} });
    const opts = { width: 256, height: 128, seaLevelGray: 95, maxElevation: 6000 };
    const pkg = exportPackage(eng.world, eng.toDoc(), opts);
    for (const f of ['cities.csv', 'roads.csv', 'roads.geojson', 'roads.bmp', 'landmarks.csv', 'points.csv', 'archive.md', 'archive.json']) expect(pkg.files).not.toContain(f);
    expect(strFromU8(unzipSync(pkg.zip)['README.txt'])).not.toContain('archive.md');
    expect(exportPartAvailable(eng.world, 'cities')).toBe(false);
    expect(exportPartAvailable(eng.world, 'archive-md')).toBe(true);
  });
});
