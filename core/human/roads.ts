import { CommandError } from '../errors';
import { wrapDelta } from '../geo';
import { HeapLite, findCell } from '../mesh';
import { douglasPeucker } from '../rivers';
import type { RoadMeta, SettlementRules, World } from '../world';
import { RIVER } from './rules';
import { type SettleInputs, cellKm, cityAt, computeCityTable, nextSettlementId } from './settlements';
import { isMajorRank } from './settle-content';
import { distKm } from './space';
import { worldTerrainClasses } from './terrain-class';

// 道路（第二十四轮）：一串相邻的陆地格。自动的按地形类别的通行难度连城市：
//   1. 大道：每块陆地上的首都与大城市先按直线距离连成 Gabriel 图，取最小生成树，再补上绕得太远的几条（环路），
//      按短的先走，每条用 A* 在格上找代价最小的路；
//   2. 小路：别的城市按重要的先，各自找到最近的已有道路（或已经连上的城市）接上；一块陆地上还没有路时最重要的城市做起点；
//   3. 走过已有道路的那一段不再重复存：一条路只存新修的那一段，接在路网上（from / to 是两头的城市）。
// 代价：km × 两格的通行难度的平均 × (1 + 高低差 / 300) × 过河（进有河的格 × 2.2，顺着河谷走 × 0.85）× 已有道路（大道 × 0.4、小路 × 0.6）；
// 海、湖走不了

export const ROAD_KINDS = ['major', 'minor'] as const;
const MAJOR = 1;
const MINOR = 2;
const ON_MAJOR = 0.4;
const ON_MINOR = 0.6;
// 绕得太远（生成树上的路长超过直线的这么多倍）时补一条大道
const LOOP = 2.2;
// A* 的搜索范围：两头的直线距离的这么多倍再加几格（椭圆）
const CORRIDOR = 1.6;
// A* 的估计：直线 km × 最便宜的通行难度 × 这个数（比最便宜的路贵一些，找得快；结果照样固定）
const HEURISTIC = 0.55;

// 走一条边的代价（与 mesh.adj 对齐；不是干的陆地之间的为 Infinity）
export function roadCosts(S: SettleInputs): Float32Array {
  const { world, x, cls } = S;
  const { mesh } = world;
  const move = [1, ...worldTerrainClasses(world.small).map((c) => c.movement ?? 1)];
  const km = world.kmPerUnit;
  const elev = x.elevation;
  const out = new Float32Array(mesh.adj.length).fill(Infinity);
  for (let i = 0; i < mesh.n; i++) {
    if (!x.dry[i]) continue;
    const ri = (x.flags[i] & RIVER) !== 0;
    const mi = move[cls[i]] ?? 1;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (!x.dry[j]) continue;
      const rj = (x.flags[j] & RIVER) !== 0;
      let f = ((mi + (move[cls[j]] ?? 1)) / 2) * (1 + Math.abs(elev[j] - elev[i]) / 300);
      if (rj && !ri) f *= 2.2;
      else if (ri && rj) f *= 0.85;
      out[e] = mesh.dist[e] * km * f;
    }
  }
  return out;
}

// 最便宜的通行难度（A* 的估计用）
function minMove(world: World): number {
  let m = 1;
  for (const c of worldTerrainClasses(world.small)) m = Math.min(m, c.movement ?? 1);
  return m;
}

// 每格在哪条路上：1 大道、2 小路（都有时大道）、0 不在
export function roadMask(world: World, roads: Iterable<RoadMeta>): Uint8Array {
  const on = new Uint8Array(world.mesh.n);
  for (const r of roads) {
    const v = r.kind === 'major' ? MAJOR : MINOR;
    for (const c of r.cells) if (!on[c] || v < on[c]) on[c] = v;
  }
  return on;
}

const edgeKey = (a: number, b: number, n: number) => (a < b ? a * n + b : b * n + a);

// 找路：A*（两点之间）与“走到最近的目标”（Dijkstra）。数组按编号复用，不每次重新分配
export class RoadSearch {
  private g: Float64Array;
  private stamp: Int32Array;
  private parent: Int32Array;
  private closed: Int32Array;
  private heap = new HeapLite(1024);
  private tag = 0;
  private hmin: number;
  constructor(
    private world: World,
    private costs: Float32Array,
    public on: Uint8Array,
  ) {
    const n = world.mesh.n;
    this.g = new Float64Array(n);
    this.stamp = new Int32Array(n);
    this.parent = new Int32Array(n);
    this.closed = new Int32Array(n);
    this.hmin = HEURISTIC * minMove(world);
  }

  private step(i: number, j: number, e: number): number {
    const c = this.costs[e];
    if (!(c < Infinity)) return Infinity;
    const a = this.on[i];
    const b = this.on[j];
    if (a && b) return c * (a === MAJOR && b === MAJOR ? ON_MAJOR : ON_MINOR);
    return c;
  }

  private path(end: number): number[] {
    const out: number[] = [];
    for (let i = end; i >= 0; i = this.parent[i]) out.push(i);
    return out.reverse();
  }

  // a 到 b 代价最小（近似）的一串格；走不到时为 null
  astar(a: number, b: number): number[] | null {
    if (a === b) return [a];
    const { world } = this;
    const { mesh } = world;
    const tag = ++this.tag;
    const D = distKm(world, a, b);
    const reach = CORRIDOR * D + 4 * cellKm(world);
    const heap = this.heap;
    heap.size = 0;
    this.g[a] = 0;
    this.stamp[a] = tag;
    this.parent[a] = -1;
    heap.push(a, this.hmin * D);
    const closed = this.closed;
    while (heap.size) {
      const i = heap.pop();
      if (closed[i] === tag) continue;
      if (i === b) return this.path(b);
      closed[i] = tag;
      const gi = this.g[i];
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (closed[j] === tag) continue;
        const c = this.step(i, j, e);
        if (!(c < Infinity)) continue;
        const ng = gi + c;
        if (this.stamp[j] === tag && ng >= this.g[j]) continue;
        const toB = distKm(world, j, b);
        if (toB + distKm(world, a, j) > reach) continue;
        this.stamp[j] = tag;
        this.g[j] = ng;
        this.parent[j] = i;
        heap.push(j, ng + this.hmin * toB);
      }
    }
    return null;
  }

  // 从 a 走到最近的 target 格（a 本身不算）；走不到时为 null
  nearest(a: number, target: (j: number) => boolean): number[] | null {
    const { mesh } = this.world;
    const tag = ++this.tag;
    const heap = this.heap;
    heap.size = 0;
    this.g[a] = 0;
    this.stamp[a] = tag;
    this.parent[a] = -1;
    heap.push(a, 0);
    while (heap.size) {
      const i = heap.pop();
      const gi = heap.lastKey;
      if (gi > this.g[i]) continue;
      if (i !== a && target(i)) return this.path(i);
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        const c = this.step(i, j, e);
        if (!(c < Infinity)) continue;
        const ng = gi + c;
        if (this.stamp[j] === tag && ng >= this.g[j]) continue;
        this.stamp[j] = tag;
        this.g[j] = ng;
        this.parent[j] = i;
        heap.push(j, ng);
      }
    }
    return null;
  }
}

// 干的陆地连成的块：每格的块号（−1 不是干的陆地）
function dryPieces(S: SettleInputs): Int32Array {
  const { world, x } = S;
  const { mesh } = world;
  const out = new Int32Array(mesh.n).fill(-1);
  let k = 0;
  const q: number[] = [];
  for (let s = 0; s < mesh.n; s++) {
    if (!x.dry[s] || out[s] >= 0) continue;
    out[s] = k;
    q.length = 0;
    q.push(s);
    for (let h = 0; h < q.length; h++) {
      const i = q[h];
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (x.dry[j] && out[j] < 0) {
          out[j] = k;
          q.push(j);
        }
      }
    }
    k++;
  }
  return out;
}

// 并查集
function find(p: Int32Array, a: number): number {
  while (p[a] !== a) {
    p[a] = p[p[a]];
    a = p[a];
  }
  return a;
}

// 一组点的大道：Gabriel 图（先取每个点最近的 8 个当候选）→ 最小生成树 + 绕得太远的几条。返回按长短排好的边（下标对）
function backbone(world: World, cells: readonly number[]): [number, number][] {
  const m = cells.length;
  if (m < 2) return [];
  const D = (a: number, b: number) => distKm(world, cells[a], cells[b]);
  const dd: number[][] = [];
  for (let a = 0; a < m; a++) {
    dd.push([]);
    for (let b = 0; b < m; b++) dd[a].push(a === b ? 0 : b < a ? dd[b][a] : D(a, b));
  }
  const cand = new Set<number>();
  for (let a = 0; a < m; a++) {
    const near = [...Array(m).keys()].filter((b) => b !== a).sort((p, q) => dd[a][p] - dd[a][q] || p - q).slice(0, 8);
    for (const b of near) cand.add(a < b ? a * m + b : b * m + a);
  }
  const edges: [number, number, number][] = [];
  for (const key of [...cand].sort((p, q) => p - q)) {
    const a = Math.floor(key / m);
    const b = key % m;
    const ab = dd[a][b] ** 2;
    let ok = true;
    for (let c = 0; c < m && ok; c++) if (c !== a && c !== b && dd[a][c] ** 2 + dd[b][c] ** 2 < ab) ok = false;
    if (ok) edges.push([a, b, dd[a][b]]);
  }
  edges.sort((p, q) => p[2] - q[2] || p[0] - q[0] || p[1] - q[1]);
  const parent = Int32Array.from({ length: m }, (_, k) => k);
  const tree: [number, number, number][] = [];
  const rest: [number, number, number][] = [];
  for (const e of edges) {
    const ra = find(parent, e[0]);
    const rb = find(parent, e[1]);
    if (ra === rb) rest.push(e);
    else {
      parent[ra] = rb;
      tree.push(e);
    }
  }
  // 生成树上 a 到 b 的路长
  const adj: [number, number][][] = Array.from({ length: m }, () => []);
  for (const [a, b, w] of tree) {
    adj[a].push([b, w]);
    adj[b].push([a, w]);
  }
  const treeDist = (a: number, b: number) => {
    const dist = new Float64Array(m).fill(-1);
    dist[a] = 0;
    const q = [a];
    for (let h = 0; h < q.length; h++) for (const [j, w] of adj[q[h]]) if (dist[j] < 0) {
      dist[j] = dist[q[h]] + w;
      q.push(j);
    }
    return dist[b];
  };
  const extra: [number, number, number][] = [];
  for (const e of rest) {
    const t = treeDist(e[0], e[1]);
    if (t > LOOP * e[2]) {
      extra.push(e);
      adj[e[0]].push([e[1], e[2]]);
      adj[e[1]].push([e[0], e[2]]);
    }
  }
  return [...tree, ...extra].map((e) => [e[0], e[1]]);
}

interface Builder {
  world: World;
  search: RoadSearch;
  edges: Set<number>;
  roads: Record<string, RoadMeta>;
}

// 一条路的格存进去：只存还不是道路的那几段（走在已有道路上的那段不重复存），两头是城市时记下
function commit(B: Builder, path: readonly number[], kind: 'major' | 'minor', from: number | undefined, to: number | undefined) {
  const { world, search, edges } = B;
  const n = world.mesh.n;
  let start = -1;
  const flush = (a: number, b: number) => {
    const cells = path.slice(a, b + 1);
    const id = nextSettlementId(world);
    const r: RoadMeta = { id, kind, cells, auto: true };
    if (a === 0 && from !== undefined) r.from = from;
    if (b === path.length - 1 && to !== undefined) r.to = to;
    B.roads[id] = r;
  };
  for (let k = 0; k + 1 < path.length; k++) {
    const fresh = !edges.has(edgeKey(path[k], path[k + 1], n));
    if (fresh && start < 0) start = k;
    if (!fresh && start >= 0) {
      flush(start, k);
      start = -1;
    }
  }
  if (start >= 0) flush(start, path.length - 1);
  const v = kind === 'major' ? MAJOR : MINOR;
  for (let k = 0; k < path.length; k++) {
    if (k + 1 < path.length) edges.add(edgeKey(path[k], path[k + 1], n));
    const c = path[k];
    if (!search.on[c] || v < search.on[c]) search.on[c] = v;
  }
}

// 生成 / 重新生成道路：fresh 时全部换掉，否则画的、改过的（没有 auto 的）留着。返回道路的条数
export function generateRoads(S: SettleInputs, _rules: SettlementRules, fresh: boolean): number {
  const { world, x } = S;
  const { small } = world;
  const roads: Record<string, RoadMeta> = {};
  if (!fresh) for (const [k, r] of Object.entries(small.roads ?? {})) if (!r.auto) roads[k] = r;
  small.roads = roads;
  const table = computeCityTable(world);
  const cities = table.list.filter((c) => x.dry[c.cell]);
  if (!cities.length) return Object.keys(roads).length;
  const n = world.mesh.n;
  const search = new RoadSearch(world, roadCosts(S), roadMask(world, Object.values(roads)));
  const edges = new Set<number>();
  for (const r of Object.values(roads)) for (let k = 0; k + 1 < r.cells.length; k++) edges.add(edgeKey(r.cells[k], r.cells[k + 1], n));
  const B: Builder = { world, search, edges, roads };
  const piece = dryPieces(S);
  const cityId = (c: (typeof cities)[number]) => (c.point ? undefined : c.id);
  // 每块陆地的城市（重要的在前：cities 已经排好）
  const byPiece = new Map<number, typeof cities>();
  for (const c of cities) {
    const p = piece[c.cell];
    let l = byPiece.get(p);
    if (!l) byPiece.set(p, (l = []));
    l.push(c);
  }
  const net = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (search.on[i]) net[i] = 1;
  for (const p of [...byPiece.keys()].sort((a, b) => a - b)) {
    const list = byPiece.get(p)!;
    const major = list.filter((c) => isMajorRank(c.rank));
    const links = backbone(
      world,
      major.map((c) => c.cell),
    );
    // 短的先走（后走的可以沿着已有的道路）
    for (const [a, b] of links) {
      const path = search.astar(major[a].cell, major[b].cell);
      if (path) commit(B, path, 'major', cityId(major[a]), cityId(major[b]));
    }
    for (const c of major) if (search.on[c.cell]) net[c.cell] = 1;
    for (let i = 0; i < n; i++) if (search.on[i]) net[i] = 1;
    // 这块陆地上还没有路：最重要的城市做起点
    if (!list.some((c) => net[c.cell])) net[list[0].cell] = 1;
    for (const c of list) {
      if (net[c.cell]) continue;
      const path = search.nearest(c.cell, (j) => net[j] === 1);
      if (!path) {
        net[c.cell] = 1;
        continue;
      }
      const end = path[path.length - 1];
      const hit = cityAt(world, end);
      commit(B, path, 'minor', cityId(c), hit?.id);
      for (const i of path) net[i] = 1;
    }
  }
  return Object.keys(roads).length;
}

// ---------- 给界面的 ----------

export interface RoadPath {
  id: number;
  kind: string;
  auto: boolean;
  from?: number;
  to?: number;
  name?: string;
  // 格心连成的折线（地图坐标；星球上沿路连续展开，x 可能超出 [0, 2)）
  points: [number, number][];
  km: number;
}

export function roadPoints(world: World, cells: readonly number[]): [number, number][] {
  const { mesh } = world;
  const sphere = mesh.kind === 'sphere';
  const pts: [number, number][] = [];
  for (const c of cells) {
    const prev = pts.length ? pts[pts.length - 1][0] : mesh.x[c];
    pts.push([sphere ? prev + wrapDelta(mesh.x[c] - prev) : mesh.x[c], mesh.y[c]]);
  }
  return pts;
}

export function roadKm(world: World, cells: readonly number[]): number {
  let s = 0;
  for (let k = 0; k + 1 < cells.length; k++) s += distKm(world, cells[k], cells[k + 1]);
  return s;
}

// 全部道路的折线（大道在前）
export function roadPaths(world: World): RoadPath[] {
  return Object.values(world.small.roads ?? {})
    .sort((a, b) => (a.kind === 'major' ? 0 : 1) - (b.kind === 'major' ? 0 : 1) || a.id - b.id)
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      auto: !!r.auto,
      ...(r.from !== undefined ? { from: r.from } : {}),
      ...(r.to !== undefined ? { to: r.to } : {}),
      ...(r.name ? { name: r.name } : {}),
      points: roadPoints(world, r.cells),
      km: roadKm(world, r.cells),
    }));
}

// 折线平滑（Chaikin，两端不动），画的时候用
export function smoothRoad(pts: readonly [number, number][], rounds = 2): [number, number][] {
  let p = pts.slice();
  for (let r = 0; r < rounds && p.length > 2; r++) {
    const out: [number, number][] = [p[0]];
    for (let k = 0; k + 1 < p.length; k++) {
      const [ax, ay] = p[k];
      const [bx, by] = p[k + 1];
      out.push([0.75 * ax + 0.25 * bx, 0.75 * ay + 0.25 * by], [0.25 * ax + 0.75 * bx, 0.25 * ay + 0.75 * by]);
    }
    out.push(p[p.length - 1]);
    p = out;
  }
  return p;
}

// ---------- 编辑 ----------

// 检查一串格能不能当道路：至少两格、都在陆地上、前后相邻
export function checkRoadCells(world: World, cells: readonly number[]) {
  const { mesh, causes } = world;
  if (cells.length < 2) throw new CommandError('道路至少要有两格');
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k];
    if (c >= mesh.n) throw new CommandError(`格编号 ${c} 超出范围（共 ${mesh.n} 格）`);
    if (!causes.land[c]) throw new CommandError('道路不能走海');
    if (k === 0) continue;
    const p = cells[k - 1];
    let ok = false;
    for (let e = mesh.off[p]; e < mesh.off[p + 1] && !ok; e++) if (mesh.adj[e] === c) ok = true;
    if (!ok) throw new CommandError('道路的格要前后相邻');
  }
}

// 两头是城市时记下
function linkEnds(world: World, r: RoadMeta) {
  const a = cityAt(world, r.cells[0]);
  const b = cityAt(world, r.cells[r.cells.length - 1]);
  if (a) r.from = a.id;
  else delete r.from;
  if (b) r.to = b.id;
  else delete r.to;
}

export function addRoad(world: World, cells: number[], kind: string, name?: string): number {
  checkRoadCells(world, cells);
  const id = nextSettlementId(world);
  const r: RoadMeta = { id, kind, cells: [...cells] };
  if (name?.trim()) r.name = name.trim();
  linkEnds(world, r);
  (world.small.roads ??= {})[id] = r;
  return id;
}

export function roadOf(world: World, id: number): RoadMeta {
  const r = world.small.roads?.[id];
  if (!r) throw new CommandError(`找不到道路 ${id}`);
  return r;
}

// 换掉一段：cells[from..to]（含两头）换成 mid；from、to 省略时整条换掉
export function spliceRoad(cells: readonly number[], mid: readonly number[], from?: number, to?: number): number[] {
  if (from === undefined || to === undefined) return [...mid];
  const a = Math.max(0, Math.min(from, to));
  const b = Math.min(cells.length - 1, Math.max(from, to));
  const m = from <= to ? mid : [...mid].reverse();
  return [...cells.slice(0, a), ...m, ...cells.slice(b + 1)];
}

// 改走向（自己改过的道路重新生成时留着）
export function editRoad(world: World, id: number, mid: number[], from?: number, to?: number) {
  const r = roadOf(world, id);
  const cells = spliceRoad(r.cells, mid, from, to);
  // 换的那一段与两边接不上时报错（checkRoadCells）；首尾重复的格去掉
  const clean = cells.filter((c, k) => k === 0 || c !== cells[k - 1]);
  checkRoadCells(world, clean);
  r.cells = clean;
  delete r.auto;
  linkEnds(world, r);
}

export interface RoadPatch {
  kind?: string;
  name?: string | null;
  note?: string | null;
}
export function setRoad(world: World, id: number, p: RoadPatch): string[] {
  const r = roadOf(world, id);
  const what: string[] = [];
  if (p.kind !== undefined) {
    r.kind = p.kind;
    what.push(p.kind === 'major' ? '大道' : p.kind === 'minor' ? '小路' : '种类');
  }
  if (p.name !== undefined) {
    if (p.name?.trim()) r.name = p.name.trim();
    else delete r.name;
    what.push(p.name ? '改名' : '名字');
  }
  if (p.note !== undefined) {
    if (p.note?.trim()) r.note = p.note;
    else delete r.note;
    what.push('备注');
  }
  if (what.length) delete r.auto;
  return what;
}

// 城市挪了之后：连着它的道路重走（从新的格到另一头）；走不到的删掉
export function rerouteCity(S: SettleInputs, cityId: number) {
  const { world } = S;
  const city = world.small.cities?.[cityId];
  const roads = world.small.roads;
  if (!city || !roads) return;
  const linked = Object.values(roads).filter((r) => r.from === cityId || r.to === cityId);
  if (!linked.length) return;
  const others = Object.values(roads).filter((r) => !linked.includes(r));
  const search = new RoadSearch(world, roadCosts(S), roadMask(world, others));
  for (const r of linked.sort((a, b) => a.id - b.id)) {
    const atStart = r.from === cityId;
    const end = atStart ? r.cells[r.cells.length - 1] : r.cells[0];
    const path = end === city.cell ? null : search.astar(city.cell, end);
    if (!path || path.length < 2) {
      delete roads[r.id];
      continue;
    }
    r.cells = atStart ? path : path.reverse();
  }
}

// 改了陆海之后（只看原因）：道路上变成海的格断开，断开后不到两格的那段去掉
export function repairRoads(world: World): boolean {
  const roads = world.small.roads;
  if (!roads) return false;
  const land = world.causes.land;
  let changed = false;
  for (const r of Object.values(roads).sort((a, b) => a.id - b.id)) {
    if (r.cells.every((c) => land[c])) continue;
    changed = true;
    const runs: number[][] = [];
    let cur: number[] = [];
    for (const c of r.cells) {
      if (land[c]) cur.push(c);
      else {
        if (cur.length) runs.push(cur);
        cur = [];
      }
    }
    if (cur.length) runs.push(cur);
    const keep = runs.filter((x) => x.length >= 2);
    delete roads[r.id];
    keep.forEach((cells, k) => {
      const id = k === 0 ? r.id : nextSettlementId(world);
      const nr: RoadMeta = { ...r, id, cells };
      delete nr.from;
      delete nr.to;
      if (cells[0] === r.cells[0] && r.from !== undefined) nr.from = r.from;
      if (cells[cells.length - 1] === r.cells[r.cells.length - 1] && r.to !== undefined) nr.to = r.to;
      roads[id] = nr;
    });
  }
  return changed;
}

// 画的一笔 → 一串相邻的格（沿着画的线走；两格之间接不上时按步数补齐）。走到海里时 blocked
export function traceRoad(world: World, pts: readonly (readonly [number, number])[]): { cells: number[] } | { blocked: string } {
  const { mesh, causes } = world;
  if (!pts.length) return { blocked: '没有画' };
  const step = mesh.spacing * 0.25;
  const cells: number[] = [];
  let hint = 0;
  const push = (c: number) => {
    if (cells.length && cells[cells.length - 1] === c) return;
    if (cells.length) {
      const p = cells[cells.length - 1];
      let adj = false;
      for (let e = mesh.off[p]; e < mesh.off[p + 1] && !adj; e++) if (mesh.adj[e] === c) adj = true;
      if (!adj) {
        const gap = stepPath(world, p, c);
        for (const g of gap.slice(1, -1)) cells.push(g);
      }
    }
    cells.push(c);
  };
  for (let k = 0; k < pts.length; k++) {
    const [ax, ay] = pts[k];
    if (k === 0) {
      hint = findCell(mesh, ax, ay, hint);
      push(hint);
      continue;
    }
    const [px, py] = pts[k - 1];
    const len = Math.hypot(ax - px, ay - py);
    const s = Math.max(1, Math.ceil(len / step));
    for (let q = 1; q <= s; q++) {
      hint = findCell(mesh, px + ((ax - px) * q) / s, py + ((ay - py) * q) / s, hint);
      push(hint);
    }
  }
  // 来回的（画回头）去掉：同一格第二次出现时剪掉中间的圈
  const out: number[] = [];
  const at = new Map<number, number>();
  for (const c of cells) {
    const k = at.get(c);
    if (k !== undefined) {
      for (const x of out.splice(k + 1)) at.delete(x);
      continue;
    }
    at.set(c, out.length);
    out.push(c);
  }
  if (out.some((c) => !causes.land[c])) return { blocked: '道路不能走海' };
  if (out.length < 2) return { blocked: '太短' };
  return { cells: out };
}

// 按步数的最短路（两格之间补齐用；只走陆地，走不通时走哪里都行）
function stepPath(world: World, a: number, b: number): number[] {
  const { mesh, causes } = world;
  for (const landOnly of [true, false]) {
    const prev = new Map<number, number>([[a, -1]]);
    let q = [a];
    while (q.length && !prev.has(b)) {
      const next: number[] = [];
      for (const i of q) {
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
          const j = mesh.adj[e];
          if (prev.has(j) || (landOnly && !causes.land[j] && j !== b)) continue;
          prev.set(j, i);
          next.push(j);
        }
      }
      if (next.length > 4096) break;
      q = next;
    }
    if (prev.has(b)) {
      const out: number[] = [];
      for (let i = b; i >= 0; i = prev.get(i)!) out.push(i);
      return out.reverse();
    }
  }
  return [a, b];
}

// 两格之间按地形找一条路（画路时“顺着地形”用；已有的道路算便宜）。走不到时为 null
export function routeRoad(S: SettleInputs, a: number, b: number): number[] | null {
  const search = new RoadSearch(S.world, roadCosts(S), roadMask(S.world, Object.values(S.world.small.roads ?? {})));
  return search.astar(a, b);
}

// 控制点：格心折线化简（Douglas–Peucker，tol 省略为 0.6 格距）后留下的点在 cells 里的下标（含两头）
export function roadHandles(world: World, road: Pick<RoadMeta, 'cells'>, tol = world.mesh.spacing * 0.6): number[] {
  const pts = roadPoints(world, road.cells);
  const tagged = pts.map((p, k) => [p[0], p[1], k] as [number, number, number]);
  const kept = douglasPeucker(
    tagged.map((p) => [p[0], p[1]] as [number, number]),
    tol,
  );
  const out: number[] = [];
  let k = 0;
  for (const [x, y] of kept) {
    while (k < tagged.length && (tagged[k][0] !== x || tagged[k][1] !== y)) k++;
    if (k < tagged.length) out.push(k++);
  }
  return out;
}

// 拖一个控制点到 to（地图坐标）：它两边的两段（到前后的控制点）重走——route 时按地形找路，否则按直线；返回新的整条格
export function dragRoadHandle(S: SettleInputs, road: Pick<RoadMeta, 'cells'>, handles: readonly number[], j: number, to: readonly [number, number], route = true): { cells: number[] } | { blocked: string } {
  const { world } = S;
  const { mesh, causes } = world;
  const c = findCell(mesh, to[0], to[1], road.cells[handles[j]]);
  if (!causes.land[c]) return { blocked: '道路不能走海' };
  const a = j > 0 ? handles[j - 1] : handles[j];
  const b = j + 1 < handles.length ? handles[j + 1] : handles[j];
  const leg = (p: number, q: number): number[] | null => {
    if (p === q) return [p];
    if (route) return routeRoad(S, p, q);
    const t = traceRoad(world, [
      [mesh.x[p], mesh.y[p]],
      [mesh.x[q], mesh.y[q]],
    ]);
    return 'cells' in t ? t.cells : null;
  };
  const first = leg(road.cells[a], c);
  const second = leg(c, road.cells[b]);
  if (!first || !second) return { blocked: '走不通' };
  const mid = [...first, ...second.slice(1)];
  const cells = [...road.cells.slice(0, a), ...mid, ...road.cells.slice(b + 1)];
  const clean = cells.filter((x, k) => k === 0 || x !== cells[k - 1]);
  return clean.length >= 2 ? { cells: clean } : { blocked: '太短' };
}
