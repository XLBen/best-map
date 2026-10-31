import { Delaunay, type Voronoi } from 'd3-delaunay';
import { mulberry32 } from './rng';

// 单元格图：Voronoi 格是编辑与计算的基本单位。
// 坐标单位：地图高 1，宽 aspect；km 换算见 world.ts 的 kmPerUnit。
// 两种网格：一块地区（平面矩形，plane）与整个星球（球面，sphere，见 sphere.ts）。
// 只按“格与邻居”计算的代码对两种网格一视同仁：球面网格给出真实的距离、边长、面积（换算成同样的单位），
// 没有地图边（boundary 全为 0）。用到平面坐标的地方按 kind 分开写，平面的写法原样不动
interface MeshBase {
  n: number;
  width: number;
  height: number;
  x: Float64Array;
  y: Float64Array;
  // 邻接表（CSR）：格 i 的邻居是 adj[off[i] .. off[i+1])
  off: Int32Array;
  adj: Int32Array;
  // 与 adj 对齐：两格中心距离、共享 Voronoi 边长、共享边两端点 (ax, ay, bx, by)
  dist: Float64Array;
  edgeLen: Float64Array;
  edgeSeg: Float32Array;
  area: Float64Array;
  // 贴地图边界的格，以及指向图内的法向（用于图外来风的水汽输入）
  boundary: Uint8Array;
  inwardX: Float32Array;
  inwardY: Float32Array;
  // Voronoi 多边形顶点（渲染用）：格 i 的顶点是 poly[polyOff[i] .. polyOff[i+1]) 的 (x, y) 对
  polyOff: Int32Array;
  poly: Float32Array;
  // Delaunay 三角形（平滑插值渲染用）
  triangles: Uint32Array;
  spacing: number;
  // 全图面积（地图单位²）：平面是 width·height，球面是 4/π
  totalArea: number;
}

export interface PlaneMesh extends MeshBase {
  kind: 'plane';
  delaunay: Delaunay<number>;
}

// 整个星球：x 是经度（0–2，x = 1 + 经度/180），y = (90 − 纬度)/180；
// dist、edgeLen 是弧长 / π，area 是立体角 / π²，所以 ×kmPerUnit（= π·R）就是 km
export interface SphereMesh extends MeshBase {
  kind: 'sphere';
  // 每格的单位向量 (x, y, z) 交错存放
  p: Float64Array;
  // 与 adj 对齐：在本格的切平面里到邻格的位移（东、南分量，地图单位；长度等于 dist）
  edx: Float64Array;
  edy: Float64Array;
  // 离北极、南极最近的格
  north: number;
  south: number;
  // 显示坐标 (x, y) 处的格，与屏幕上画出来的分区一致（见 sphere.ts）；x 可以超出 [0, 2)
  locate: (x: number, y: number, hint: number) => number;
}

export type Mesh = PlaneMesh | SphereMesh;

export function buildMesh(cells: number, aspect: number, seed: number): PlaneMesh {
  const width = aspect;
  const height = 1;
  const rand = mulberry32(seed);
  // 抖动的六边形格点，再做一次 Lloyd 松弛：格子大小均匀而形状不规则
  const s = Math.sqrt((width * height) / (cells * (Math.sqrt(3) / 2)));
  const dy = (s * Math.sqrt(3)) / 2;
  const pts: number[] = [];
  for (let row = 0, y = dy / 2; y < height; row++, y += dy) {
    for (let x = row % 2 ? s : s / 2; x < width; x += s) {
      const px = x + (rand() - 0.5) * 0.7 * s;
      const py = y + (rand() - 0.5) * 0.7 * dy;
      pts.push(Math.min(width - 1e-6, Math.max(1e-6, px)), Math.min(height - 1e-6, Math.max(1e-6, py)));
    }
  }
  let coords = Float64Array.from(pts);
  let delaunay = new Delaunay(coords);
  const n = coords.length / 2;
  let cell = clipCells(delaunay.voronoi([0, 0, width, height]), n);
  const relaxed = new Float64Array(coords.length);
  for (let i = 0; i < n; i++) {
    const k0 = cell.off[i];
    const k1 = cell.off[i + 1];
    const [cx, cy] = k1 > k0 ? centroid(cell.xy, k0, k1) : [coords[2 * i], coords[2 * i + 1]];
    relaxed[2 * i] = cx;
    relaxed[2 * i + 1] = cy;
  }
  coords = relaxed;
  delaunay = new Delaunay(coords);
  cell = clipCells(delaunay.voronoi([0, 0, width, height]), n);

  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = coords[2 * i];
    y[i] = coords[2 * i + 1];
  }

  const { raw, rawOff, off: polyOff, xy } = cell;
  const area = new Float64Array(n);
  const boundary = new Uint8Array(n);
  const inwardX = new Float32Array(n);
  const inwardY = new Float32Array(n);
  const eps = 1e-9;
  for (let i = 0; i < n; i++) {
    const k0 = polyOff[i];
    const k1 = polyOff[i + 1];
    if (k1 > k0) {
      for (let k = k0; k < k1; k++) {
        if (xy[2 * k] < eps) inwardX[i] = 1;
        if (xy[2 * k] > width - eps) inwardX[i] = -1;
        if (xy[2 * k + 1] < eps) inwardY[i] = 1;
        if (xy[2 * k + 1] > height - eps) inwardY[i] = -1;
      }
      area[i] = Math.abs(shoelace(xy, k0, k1));
    }
    if (inwardX[i] || inwardY[i]) boundary[i] = 1;
  }
  const poly = new Float32Array(xy);

  // 邻接：Voronoi 邻居（同 voronoi.neighbors：Delaunay 邻居里裁剪后仍有公共边的），共享边由两多边形的公共顶点求出
  const hullIndex = new Int32Array(n).fill(-1);
  for (let k = 0; k < delaunay.hull.length; k++) hullIndex[delaunay.hull[k]] = k;
  const cand: number[] = [];
  const nb: number[] = [];
  const off = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    if (rawOff[i + 1] > rawOff[i]) {
      delaunayNeighbors(delaunay, hullIndex, i, cand);
      for (const j of cand) {
        if (sharesEdge(raw, rawOff[i], rawOff[i + 1], rawOff[j], rawOff[j + 1])) nb.push(j);
      }
    }
    off[i + 1] = nb.length;
  }
  const adj = Int32Array.from(nb);
  const dist = new Float64Array(off[n]);
  const edgeLen = new Float64Array(off[n]);
  const edgeSeg = new Float32Array(off[n] * 4);
  // 公共顶点按坐标取整到 1e-8 比较
  const rx = new Float64Array(xy.length / 2);
  const ry = new Float64Array(xy.length / 2);
  for (let k = 0; k < rx.length; k++) {
    rx[k] = round8(xy[2 * k]);
    ry[k] = round8(xy[2 * k + 1]);
  }
  for (let i = 0; i < n; i++) {
    const k0 = polyOff[i];
    const k1 = polyOff[i + 1];
    for (let e = off[i]; e < off[i + 1]; e++) {
      const j = adj[e];
      dist[e] = Math.hypot(x[i] - x[j], y[i] - y[j]);
      // 按 j 的顶点顺序取前两个也是 i 顶点的点
      let shared = 0;
      let ax = 0;
      let ay = 0;
      let bx = 0;
      let by = 0;
      for (let k = polyOff[j]; k < polyOff[j + 1] && shared < 2; k++) {
        let h = k0;
        while (h < k1 && !(rx[h] === rx[k] && ry[h] === ry[k])) h++;
        if (h === k1) continue;
        if (shared++ === 0) {
          ax = xy[2 * k];
          ay = xy[2 * k + 1];
        } else {
          bx = xy[2 * k];
          by = xy[2 * k + 1];
        }
      }
      if (shared === 2) {
        edgeLen[e] = Math.hypot(ax - bx, ay - by);
        edgeSeg[e * 4] = ax;
        edgeSeg[e * 4 + 1] = ay;
        edgeSeg[e * 4 + 2] = bx;
        edgeSeg[e * 4 + 3] = by;
      } else {
        // 退化情况（数值误差导致公共顶点没对上）：用两格中心的中垂线段近似
        const mx = (x[i] + x[j]) / 2;
        const my = (y[i] + y[j]) / 2;
        const half = dist[e] * 0.3;
        const nx = -(y[j] - y[i]) / dist[e];
        const ny = (x[j] - x[i]) / dist[e];
        edgeLen[e] = half * 2;
        edgeSeg.set([mx - nx * half, my - ny * half, mx + nx * half, my + ny * half], e * 4);
      }
    }
  }

  let total = 0;
  for (let e = 0; e < dist.length; e++) total += dist[e];
  return {
    kind: 'plane',
    n,
    width,
    height,
    x,
    y,
    off,
    adj,
    dist,
    edgeLen,
    edgeSeg,
    area,
    boundary,
    inwardX,
    inwardY,
    polyOff,
    poly,
    triangles: delaunay.triangles,
    spacing: total / dist.length,
    totalArea: width * height,
    delaunay,
  };
}

// d3-delaunay 内部的单格裁剪：cellPolygon 与 neighbors 都由它算出，同一格每次结果相同，所以每格只裁一次
interface Clipper {
  _clip(i: number): number[] | null;
}

// 每格的裁剪结果，首尾相接放进 Float64Array（不留下几万个小数组，垃圾回收省事得多）：
// 原样的裁剪结果是 raw[rawOff[i] .. rawOff[i+1])（判邻居用，没有时为空）；
// 多边形顶点与 cellPolygon 相同（不含闭合点），是 xy[2·off[i] .. 2·off[i+1])
function clipCells(voronoi: Voronoi<number>, n: number): { raw: Float64Array; rawOff: Int32Array; off: Int32Array; xy: Float64Array } {
  const clipper = voronoi as unknown as Clipper;
  let raw = new Float64Array(n * 16);
  let xy = new Float64Array(n * 16);
  const rawOff = new Int32Array(n + 1);
  const off = new Int32Array(n + 1);
  let r = 0;
  let q = 0;
  for (let i = 0; i < n; i++) {
    const c = clipper._clip(i);
    if (c !== null && c.length) {
      if (r + c.length > raw.length) raw = grow(raw, r + c.length);
      if (q + c.length > xy.length) xy = grow(xy, q + c.length);
      for (let k = 0; k < c.length; k++) raw[r++] = c[k];
      // 同 renderCell：去掉末尾与起点重合的点，跳过与前一点相同的点
      xy[q++] = c[0];
      xy[q++] = c[1];
      let m = c.length;
      while (c[0] === c[m - 2] && c[1] === c[m - 1] && m > 1) m -= 2;
      for (let k = 2; k < m; k += 2) {
        if (c[k] !== c[k - 2] || c[k + 1] !== c[k - 1]) {
          xy[q++] = c[k];
          xy[q++] = c[k + 1];
        }
      }
    }
    rawOff[i + 1] = r;
    off[i + 1] = q / 2;
  }
  return { raw, rawOff, off, xy: xy.slice(0, q) };
}

// 容量不够时加倍（一般用不到：每格平均不到 8 个顶点）
function grow(a: Float64Array, need: number): Float64Array<ArrayBuffer> {
  const b = new Float64Array(Math.max(need, a.length * 2));
  b.set(a);
  return b;
}

// 格 i 的 Delaunay 邻居放进 out，顺序与 delaunay.neighbors(i) 相同（照抄它，只是不用生成器，快得多）：
// 绕 i 的半边转一圈，凸包上的格再补上凸包的下一点。hullIndex 是各点在凸包里的位置（不在为 −1）
function delaunayNeighbors(delaunay: Delaunay<number>, hullIndex: Int32Array, i: number, out: number[]): void {
  out.length = 0;
  // 所有点共线的退化情况仍交给 d3
  if ((delaunay as unknown as { collinear?: Int32Array }).collinear) {
    for (const j of delaunay.neighbors(i)) out.push(j);
    return;
  }
  const { inedges, hull, halfedges, triangles } = delaunay;
  const e0 = inedges[i];
  if (e0 === -1) return; // 重合的点
  let e = e0;
  let p0 = -1;
  do {
    out.push((p0 = triangles[e]));
    e = e % 3 === 2 ? e - 2 : e + 1;
    if (triangles[e] !== i) return; // 坏的三角剖分
    e = halfedges[e];
    if (e === -1) {
      const p = hull[(hullIndex[i] + 1) % hull.length];
      if (p !== p0) out.push(p);
      return;
    }
  } while (e !== e0);
}

// 同 voronoi.neighbors 的公共边判定：i 的某条边正好是 j 的一条反向边（两格的裁剪结果是 c[a0..a1)、c[b0..b1)）
function sharesEdge(c: Float64Array, a0: number, a1: number, b0: number, b1: number): boolean {
  const li = a1 - a0;
  const lj = b1 - b0;
  for (let ai = 0; ai < li; ai += 2) {
    for (let aj = 0; aj < lj; aj += 2) {
      if (
        c[a0 + ai] === c[b0 + aj] &&
        c[a0 + ai + 1] === c[b0 + aj + 1] &&
        c[a0 + ((ai + 2) % li)] === c[b0 + ((aj + lj - 2) % lj)] &&
        c[a0 + ((ai + 3) % li)] === c[b0 + ((aj + lj - 1) % lj)]
      )
        return true;
    }
  }
  return false;
}

// 坐标取整到 1e-8 后用 === 比较，与原先的字符串键 `${Math.round(v * 1e8)}` 判等完全一致
// （-0 与 0 相等；NaN 的字符串彼此相等，所以换成取整得不到的 0.5）
function round8(v: number): number {
  const r = Math.round(v * 1e8);
  return r === r ? r : 0.5;
}

// 顶点 xy[2·k0 .. 2·k1) 围成的多边形的有向面积
function shoelace(xy: Float64Array, k0: number, k1: number): number {
  let a = 0;
  const m = k1 - k0;
  for (let k = 0; k < m; k++) {
    const j = (k + 1) % m;
    a += xy[2 * (k0 + k)] * xy[2 * (k0 + j) + 1] - xy[2 * (k0 + j)] * xy[2 * (k0 + k) + 1];
  }
  return a / 2;
}

function centroid(xy: Float64Array, k0: number, k1: number): [number, number] {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let k = k0; k < k1; k++) {
    const k2 = k + 1 < k1 ? k + 1 : k0;
    const x0 = xy[2 * k];
    const y0 = xy[2 * k + 1];
    const x1 = xy[2 * k2];
    const y1 = xy[2 * k2 + 1];
    const c = x0 * y1 - x1 * y0;
    a += c;
    cx += (x0 + x1) * c;
    cy += (y0 + y1) * c;
  }
  if (Math.abs(a) < 1e-14) return [xy[2 * k0], xy[2 * k0 + 1]];
  return [cx / (3 * a), cy / (3 * a)];
}

// 地图上一点所在的格；hint 为上一次结果时连续查询很快。
// 平面：最近的格；球面：与屏幕上画出来的分区一致（x 可以超出 [0, 2)，会绕回来）
export function findCell(mesh: Mesh, px: number, py: number, hint = 0): number {
  return mesh.kind === 'plane' ? mesh.delaunay.find(px, py, hint) : mesh.locate(px, py, hint);
}

// 广度优先的图距离（步数），用于“扩 N 圈”等
export function ringDistance(mesh: Mesh, seeds: Iterable<number>, maxSteps: number, allow?: (i: number) => boolean): Int32Array {
  const d = new Int32Array(mesh.n).fill(-1);
  const queue: number[] = [];
  for (const s of seeds) {
    if (d[s] < 0) {
      d[s] = 0;
      queue.push(s);
    }
  }
  for (let h = 0; h < queue.length; h++) {
    const i = queue[h];
    if (d[i] >= maxSteps) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (d[j] >= 0 || (allow && !allow(j))) continue;
      d[j] = d[i] + 1;
      queue.push(j);
    }
  }
  return d;
}

// 多源 Dijkstra 的欧氏图距离（地图单位）
export function graphDistance(mesh: Mesh, seeds: Iterable<number>, limit = Infinity, cost?: (i: number, j: number, e: number) => number): Float64Array {
  return graphDistanceOwner(mesh, seeds, limit, cost).dist;
}

// 同上，并记录每格最近的种子（owner 为种子格编号，不可达为 -1）。
// 堆是类型化数组的（见 HeapLite），弹出、入堆的顺序与原来 JS 数组写的堆完全相同，所以距离、owner（含距离相同时归谁）逐值不变
export function graphDistanceOwner(
  mesh: Mesh,
  seeds: Iterable<number>,
  limit = Infinity,
  cost?: (i: number, j: number, e: number) => number,
): { dist: Float64Array; owner: Int32Array } {
  const d = new Float64Array(mesh.n).fill(Infinity);
  const owner = new Int32Array(mesh.n).fill(-1);
  const heap = new HeapLite(mesh.n);
  for (const s of seeds) {
    d[s] = 0;
    owner[s] = s;
    heap.push(s, 0);
  }
  const off = mesh.off;
  const adj = mesh.adj;
  const md = mesh.dist;
  if (!cost) {
    // 没有代价函数（最常见：海岸距离、河的距离……）：边长直接取，内层不调用函数
    while (heap.size) {
      const i = heap.pop();
      const di = heap.lastKey;
      if (di > d[i] || di > limit) continue;
      const oi = owner[i];
      for (let e = off[i], end = off[i + 1]; e < end; e++) {
        const c = md[e];
        if (!(c < Infinity)) continue;
        const j = adj[e];
        const nd = di + c;
        if (nd < d[j] && nd <= limit) {
          d[j] = nd;
          owner[j] = oi;
          heap.push(j, nd);
        }
      }
    }
    return { dist: d, owner };
  }
  while (heap.size) {
    const i = heap.pop();
    const di = heap.lastKey;
    if (di > d[i] || di > limit) continue;
    for (let e = off[i]; e < off[i + 1]; e++) {
      const j = adj[e];
      const c = cost(i, j, e);
      if (!(c < Infinity)) continue;
      const nd = di + c;
      if (nd < d[j] && nd <= limit) {
        d[j] = nd;
        owner[j] = owner[i];
        heap.push(j, nd);
      }
    }
  }
  return { dist: d, owner };
}

// 第三十五轮（提速）：两种常用的代价函数写成专门的函数（以前每次传一个新的闭包：graphDistanceOwner 里调用它的地方
// 见过各式各样的闭包，编译器内联不了，每条边都是一次函数调用）。与传对应的闭包时逐值相同：同样的堆、同样的入堆、出堆先后，
// 边长照样取 mesh.dist（r35-speed 测试）
// 只走同一类的格：边 i→j 在 cls[i] === cls[j] 时长 mesh.dist[e]，否则不通（陆上的海岸距离：cls 是陆海）
export function graphDistanceSame(mesh: Mesh, seeds: ArrayLike<number>, limit: number, cls: Uint8Array): Float64Array {
  const d = new Float64Array(mesh.n).fill(Infinity);
  const heap = new HeapLite(mesh.n);
  for (let k = 0; k < seeds.length; k++) {
    const s = seeds[k];
    d[s] = 0;
    heap.push(s, 0);
  }
  dijkstraSame(mesh.off, mesh.adj, mesh.dist, cls, limit, d, heap);
  return d;
}

function dijkstraSame(off: Int32Array, adj: Int32Array, md: Float64Array, cls: Uint8Array, limit: number, d: Float64Array, heap: HeapLite) {
  while (heap.size) {
    const i = heap.pop();
    const di = heap.lastKey;
    if (di > d[i] || di > limit) continue;
    const ci = cls[i];
    for (let e = off[i]; e < off[i + 1]; e++) {
      const j = adj[e];
      if (cls[j] !== ci) continue;
      const c = md[e];
      if (!(c < Infinity)) continue;
      const nd = di + c;
      if (nd < d[j] && nd <= limit) {
        d[j] = nd;
        heap.push(j, nd);
      }
    }
  }
}

// 不进 block 的格：边 i→j 在 block[j] 为 0 时长 mesh.dist[e]，否则不通（离挡流陆地的海上距离）
export function graphDistanceAvoid(mesh: Mesh, seeds: ArrayLike<number>, limit: number, block: Uint8Array): Float64Array {
  const d = new Float64Array(mesh.n).fill(Infinity);
  const heap = new HeapLite(mesh.n);
  for (let k = 0; k < seeds.length; k++) {
    const s = seeds[k];
    d[s] = 0;
    heap.push(s, 0);
  }
  dijkstraAvoid(mesh.off, mesh.adj, mesh.dist, block, limit, d, heap);
  return d;
}

function dijkstraAvoid(off: Int32Array, adj: Int32Array, md: Float64Array, block: Uint8Array, limit: number, d: Float64Array, heap: HeapLite) {
  while (heap.size) {
    const i = heap.pop();
    const di = heap.lastKey;
    if (di > d[i] || di > limit) continue;
    for (let e = off[i]; e < off[i + 1]; e++) {
      const j = adj[e];
      if (block[j]) continue;
      const c = md[e];
      if (!(c < Infinity)) continue;
      const nd = di + c;
      if (nd < d[j] && nd <= limit) {
        d[j] = nd;
        heap.push(j, nd);
      }
    }
  }
}

// graphDistance(mesh, 种子)（没有代价函数、没有上限）在种子从 oldSeeds 换成 newSeeds 后的结果，从旧的结果 oldDist
// 改起（第九轮 A2）：只重算受影响的那一片。与从头算逐值相同——边长都为正时，“每格 = 0（种子）或邻格 + 边长里最小的”
// 这组方程（按同样的浮点加法）只有一组解，Dijkstra 算出的就是它；这里先把去掉的种子与沿最短路靠它们的格（旧值
// 恰好等于某个靠它们的邻格 + 边长的格，宁多勿少）作废，再从新种子、作废区四周的旧值出发做只减不增的 Dijkstra，
// 得到的也是这组解。有不为正的边时返回 null（照旧从头算）
const positiveEdges = new WeakMap<Mesh, boolean>();
export function updateDistance(mesh: Mesh, oldSeeds: Uint8Array, oldDist: Float64Array, newSeeds: Uint8Array): Float64Array | null {
  const { off, adj } = mesh;
  const md = mesh.dist;
  let ok = positiveEdges.get(mesh);
  if (ok === undefined) {
    ok = true;
    for (let e = 0; e < md.length && ok; e++) if (!(md[e] > 1e-9)) ok = false;
    positiveEdges.set(mesh, ok);
  }
  if (!ok) return null;
  const n = mesh.n;
  const d = Float64Array.from(oldDist);
  const bad = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;
  for (let i = 0; i < n; i++) {
    if (oldSeeds[i] && !newSeeds[i]) {
      bad[i] = 1;
      stack[sp++] = i;
    }
  }
  while (sp > 0) {
    const i = stack[--sp];
    const di = oldDist[i];
    for (let e = off[i], end = off[i + 1]; e < end; e++) {
      const j = adj[e];
      if (bad[j] || newSeeds[j]) continue;
      if (di + md[e] === oldDist[j]) {
        bad[j] = 1;
        stack[sp++] = j;
      }
    }
  }
  const heap = new HeapLite(1024);
  for (let i = 0; i < n; i++) {
    if (newSeeds[i]) {
      if (d[i] !== 0) {
        d[i] = 0;
        heap.push(i, 0);
      }
      continue;
    }
    if (!bad[i]) continue;
    d[i] = Infinity;
  }
  for (let i = 0; i < n; i++) {
    if (!bad[i] || newSeeds[i]) continue;
    let best = Infinity;
    for (let e = off[i], end = off[i + 1]; e < end; e++) {
      const j = adj[e];
      if (bad[j] && !newSeeds[j]) continue;
      const nd = d[j] + md[e];
      if (nd < best) best = nd;
    }
    if (best < Infinity) {
      d[i] = best;
      heap.push(i, best);
    }
  }
  while (heap.size) {
    const i = heap.pop();
    const di = heap.lastKey;
    if (di > d[i]) continue;
    for (let e = off[i], end = off[i + 1]; e < end; e++) {
      const j = adj[e];
      const nd = di + md[e];
      if (nd < d[j]) {
        d[j] = nd;
        heap.push(j, nd);
      }
    }
  }
  return d;
}

// 轻量堆（允许重复入堆，弹出时跳过过期项）。类型化数组，按需加倍；比较、移动的写法与原来 JS 数组的版本一模一样
// （优先级相同的元素出堆的先后也相同）。pop 返回元素，它的优先级放在 lastKey（不分配元组）
export class HeapLite {
  private items: Int32Array;
  private keys: Float64Array;
  size = 0;
  lastKey = 0;
  constructor(cap: number) {
    const c = Math.max(16, cap);
    this.items = new Int32Array(c);
    this.keys = new Float64Array(c);
  }
  push(item: number, key: number) {
    if (this.size === this.items.length) {
      const items = new Int32Array(this.items.length * 2);
      items.set(this.items);
      const keys = new Float64Array(this.keys.length * 2);
      keys.set(this.keys);
      this.items = items;
      this.keys = keys;
    }
    const items = this.items;
    const keys = this.keys;
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (keys[p] <= key) break;
      items[i] = items[p];
      keys[i] = keys[p];
      i = p;
    }
    items[i] = item;
    keys[i] = key;
  }
  pop(): number {
    const items = this.items;
    const keys = this.keys;
    const top = items[0];
    this.lastKey = keys[0];
    const n = --this.size;
    const lastI = items[n];
    const lastK = keys[n];
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && keys[r] < keys[l] ? r : l;
        if (keys[c] >= lastK) break;
        items[i] = items[c];
        keys[i] = keys[c];
        i = c;
      }
      items[i] = lastI;
      keys[i] = lastK;
    }
    return top;
  }
}

// 用相邻格的最小二乘求标量场在格 i 处的梯度（每地图单位）。球面上是（东、南）分量
export function gradient(mesh: Mesh, f: ArrayLike<number>, i: number): [number, number] {
  if (mesh.kind === 'sphere') return gradientSphere(mesh, f, i);
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let bx = 0;
  let by = 0;
  for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
    const j = mesh.adj[e];
    const dx = mesh.x[j] - mesh.x[i];
    const dy = mesh.y[j] - mesh.y[i];
    const w = 1 / (dx * dx + dy * dy);
    const df = f[j] - f[i];
    sxx += w * dx * dx;
    sxy += w * dx * dy;
    syy += w * dy * dy;
    bx += w * dx * df;
    by += w * dy * df;
  }
  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) < 1e-30) return [0, 0];
  return [(syy * bx - sxy * by) / det, (sxx * by - sxy * bx) / det];
}

// 梯度的最小二乘里只取决于网格的部分（第三十一轮按网格缓存）：每条邻接项的 w·dx、w·dy，每格的 sxx、sxy、syy 与 det。
// 累加的先后、每一步的运算与 gradient 里的完全相同（w·dx·df 就是 (w·dx)·df），所以 gradientAt / gradientField 与它逐值相同
export interface GradGeo {
  wdx: Float64Array;
  wdy: Float64Array;
  sxx: Float64Array;
  sxy: Float64Array;
  syy: Float64Array;
  det: Float64Array;
}
const gradCache = new WeakMap<Mesh, GradGeo>();
export function gradGeo(mesh: Mesh): GradGeo {
  let g = gradCache.get(mesh);
  if (g) return g;
  const n = mesh.n;
  const E = mesh.adj.length;
  const wdx = new Float64Array(E);
  const wdy = new Float64Array(E);
  const sxx = new Float64Array(n);
  const sxy = new Float64Array(n);
  const syy = new Float64Array(n);
  const det = new Float64Array(n);
  const sphere = mesh.kind === 'sphere' ? mesh : null;
  for (let i = 0; i < n; i++) {
    let xx = 0;
    let xy = 0;
    let yy = 0;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      let dx: number;
      let dy: number;
      if (sphere) {
        dx = sphere.edx[e];
        dy = sphere.edy[e];
      } else {
        const j = mesh.adj[e];
        dx = mesh.x[j] - mesh.x[i];
        dy = mesh.y[j] - mesh.y[i];
      }
      const w = 1 / (dx * dx + dy * dy);
      wdx[e] = w * dx;
      wdy[e] = w * dy;
      xx += w * dx * dx;
      xy += w * dx * dy;
      yy += w * dy * dy;
    }
    sxx[i] = xx;
    sxy[i] = xy;
    syy[i] = yy;
    det[i] = xx * yy - xy * xy;
  }
  g = { wdx, wdy, sxx, sxy, syy, det };
  gradCache.set(mesh, g);
  return g;
}

// 同 gradient（逐值相同），不分配数组：结果写进 out[0]、out[1]
export function gradientAt(mesh: Mesh, g: GradGeo, f: ArrayLike<number>, i: number, out: Float64Array) {
  const { off, adj } = mesh;
  const { wdx, wdy } = g;
  const fi = f[i];
  let bx = 0;
  let by = 0;
  for (let e = off[i], end = off[i + 1]; e < end; e++) {
    const df = f[adj[e]] - fi;
    bx += wdx[e] * df;
    by += wdy[e] * df;
  }
  const det = g.det[i];
  if (Math.abs(det) < 1e-30) {
    out[0] = 0;
    out[1] = 0;
    return;
  }
  const sxx = g.sxx[i];
  const sxy = g.sxy[i];
  const syy = g.syy[i];
  out[0] = (syy * bx - sxy * by) / det;
  out[1] = (sxx * by - sxy * bx) / det;
}

// 每格的梯度（同 gradient，逐值相同）写进 gx、gy
export function gradientField(mesh: Mesh, f: ArrayLike<number>, gx: Float64Array, gy: Float64Array) {
  const g = gradGeo(mesh);
  const out = new Float64Array(2);
  for (let i = 0; i < mesh.n; i++) {
    gradientAt(mesh, g, f, i, out);
    gx[i] = out[0];
    gy[i] = out[1];
  }
}

// 球面上的梯度：同样的最小二乘，邻格位移取本格切平面里的（东、南）分量
function gradientSphere(mesh: SphereMesh, f: ArrayLike<number>, i: number): [number, number] {
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let bx = 0;
  let by = 0;
  for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
    const dx = mesh.edx[e];
    const dy = mesh.edy[e];
    const w = 1 / (dx * dx + dy * dy);
    const df = f[mesh.adj[e]] - f[i];
    sxx += w * dx * dx;
    sxy += w * dx * dy;
    syy += w * dy * dy;
    bx += w * dx * df;
    by += w * dy * df;
  }
  const det = sxx * syy - sxy * sxy;
  if (Math.abs(det) < 1e-30) return [0, 0];
  return [(syy * bx - sxy * by) / det, (sxx * by - sxy * bx) / det];
}
