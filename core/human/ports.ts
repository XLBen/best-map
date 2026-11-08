import { HeapLite } from '../mesh';
import type { RoadMeta, World } from '../world';

// 港口与海路（第八十四轮）。
// 港口：城市在挨着海的格上（海不结冰：那一格海的年均温不低于 ICE_SEA），并且海岸是避风的——两圈以内的格里水面不到 SHELTER，
// 或者是河口（这一格有河）。港口是按位置现算的（城市表的 port），不存。
// 海路：从全部港口同时在水面上（海、湖，不走结冰的海）往外走（按 km），每格记最近的港口；两个港口的地盘挨着的地方就是它们之间最短的一条海路
// （两边各自走回港口）。先连陆块（同一块陆地上的港口当作已经连着，按短的先连，没有更短的办法到那块陆地时才连：轮渡、过海峡），
// 再把大的港口（首都与大城市）连成一棵树（沿海的商路）。一条海路最长 MAX_LANE_KM。存成道路（kind 'sea'，格是“港口、水面……、港口”）

// 结冰的海：年均温低于这个（°C）
const ICE_SEA = -6;
// 两圈以内水面的比例不到这个算避风
const SHELTER = 0.6;
// 一条海路最长（km）
export const MAX_LANE_KM = 1500;

const isWater = (world: World, i: number) => !world.causes.land[i] || world.derived.lake[i] === 1;
const openWater = (world: World, i: number) => isWater(world, i) && world.derived.tMean[i] >= ICE_SEA;

// 这一格能不能做港口
export function isPortCell(world: World, cell: number): boolean {
  const { mesh, causes, derived: d } = world;
  if (!causes.land[cell] || d.lake[cell] === 1) return false;
  let sea = false;
  for (let e = mesh.off[cell]; e < mesh.off[cell + 1]; e++) {
    const j = mesh.adj[e];
    if (!causes.land[j] && d.tMean[j] >= ICE_SEA) sea = true;
  }
  if (!sea) return false;
  if (d.discharge[cell] >= world.small.planet.riverThreshold) return true;
  // 两圈以内的格（不含自己）里水面的比例
  const seen = ringBuf;
  let len = 0;
  seen[len++] = cell;
  let water = 0;
  for (let e = mesh.off[cell]; e < mesh.off[cell + 1]; e++) seen[len++] = mesh.adj[e];
  const first = len;
  for (let q = 1; q < first; q++) if (isWater(world, seen[q])) water++;
  for (let q = 1; q < first; q++) {
    const i = seen[q];
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      let dup = false;
      for (let r = 0; r < len && !dup; r++) if (seen[r] === j) dup = true;
      if (dup || len >= seen.length) continue;
      seen[len++] = j;
      if (isWater(world, j)) water++;
    }
  }
  const all = len - 1;
  return all > 0 && water / all < SHELTER;
}
const ringBuf = new Int32Array(256);

// 并查集
function find(p: Int32Array, a: number): number {
  while (p[a] !== a) {
    p[a] = p[p[a]];
    a = p[a];
  }
  return a;
}

export interface Port {
  // 城市的编号、格、重要不重要（首都与大城市）
  id: number;
  cell: number;
  major: boolean;
}

// 海路：返回新的几条（还没编号），按连的先后
export function seaLanes(world: World, ports: readonly Port[], piece: Int32Array): Omit<RoadMeta, 'id'>[] {
  const { mesh } = world;
  const n = mesh.n;
  const P = ports.length;
  if (P < 2) return [];
  const km = world.kmPerUnit;
  const reach = MAX_LANE_KM / 2;
  const dist = new Float64Array(n).fill(Infinity);
  const label = new Int32Array(n).fill(-1);
  const parent = new Int32Array(n).fill(-1);
  const heap = new HeapLite(1024);
  // 起点：港口旁边的水面（parent 是港口的格）
  ports.forEach((p, k) => {
    const i = p.cell;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (!openWater(world, j)) continue;
      const dd = mesh.dist[e] * km;
      if (dd < dist[j] || (dd === dist[j] && k < label[j])) {
        dist[j] = dd;
        label[j] = k;
        parent[j] = i;
        heap.push(j, dd);
      }
    }
  });
  while (heap.size) {
    const i = heap.pop();
    const di = heap.lastKey;
    if (di > dist[i]) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (!openWater(world, j)) continue;
      const nd = di + mesh.dist[e] * km;
      if (nd > reach || nd >= dist[j]) continue;
      dist[j] = nd;
      label[j] = label[i];
      parent[j] = i;
      heap.push(j, nd);
    }
  }
  // 两个港口的地盘挨着的地方：最短的那一处
  const best = new Map<number, { cost: number; i: number; j: number }>();
  for (let i = 0; i < n; i++) {
    const a = label[i];
    if (a < 0) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      const b = label[j];
      if (b <= a) continue;
      const cost = dist[i] + mesh.dist[e] * km + dist[j];
      if (cost > MAX_LANE_KM) continue;
      const key = a * P + b;
      const old = best.get(key);
      if (!old || cost < old.cost) best.set(key, { cost, i, j });
    }
  }
  const pairs = [...best.entries()].map(([key, v]) => ({ a: Math.floor(key / P), b: key % P, ...v })).sort((p, q) => p.cost - q.cost || p.a - q.a || p.b - q.b);
  const back = (i: number): number[] => {
    const out: number[] = [];
    for (let c = i; c >= 0; c = parent[c]) {
      out.push(c);
      if (!isWater(world, c)) break;
    }
    return out;
  };
  const lanes: Omit<RoadMeta, 'id'>[] = [];
  const done = new Set<number>();
  const lane = (p: (typeof pairs)[number]) => {
    const key = p.a * P + p.b;
    if (done.has(key)) return;
    done.add(key);
    const cells = [...back(p.i).reverse(), ...back(p.j)];
    lanes.push({ kind: 'sea', cells, auto: true, from: ports[p.a].id, to: ports[p.b].id });
  };
  // 1. 连陆块：同一块陆地上的港口先并在一起
  const uf = Int32Array.from({ length: P }, (_, k) => k);
  const firstOf = new Map<number, number>();
  ports.forEach((p, k) => {
    const f = firstOf.get(piece[p.cell]);
    if (f === undefined) firstOf.set(piece[p.cell], k);
    else uf[k] = f;
  });
  for (const p of pairs) {
    const ra = find(uf, p.a);
    const rb = find(uf, p.b);
    if (ra === rb) continue;
    uf[ra] = rb;
    lane(p);
  }
  // 2. 大的港口连成一棵树（沿海的商路）
  const uf2 = Int32Array.from({ length: P }, (_, k) => k);
  for (const p of pairs) {
    if (!ports[p.a].major || !ports[p.b].major) continue;
    const ra = find(uf2, p.a);
    const rb = find(uf2, p.b);
    if (ra === rb) continue;
    uf2[ra] = rb;
    lane(p);
  }
  return lanes;
}

// 一条海路还能不能用（改了陆海之后）：两头是陆地、中间都是水面
export function laneIntact(world: World, cells: readonly number[]): boolean {
  if (cells.length < 2) return false;
  const last = cells.length - 1;
  for (let k = 0; k <= last; k++) {
    const w = isWater(world, cells[k]);
    if ((k === 0 || k === last) === w) return false;
  }
  return true;
}
