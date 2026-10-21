import { Delaunay } from 'd3-delaunay';
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
  let voronoi = delaunay.voronoi([0, 0, width, height]);
  const n = coords.length / 2;
  const relaxed = new Float64Array(coords.length);
  for (let i = 0; i < n; i++) {
    const poly = voronoi.cellPolygon(i);
    const [cx, cy] = poly ? centroid(poly) : [coords[2 * i], coords[2 * i + 1]];
    relaxed[2 * i] = cx;
    relaxed[2 * i + 1] = cy;
  }
  coords = relaxed;
  delaunay = new Delaunay(coords);
  voronoi = delaunay.voronoi([0, 0, width, height]);

  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = coords[2 * i];
    y[i] = coords[2 * i + 1];
  }

  const polys: Float64Array[] = [];
  const area = new Float64Array(n);
  const boundary = new Uint8Array(n);
  const inwardX = new Float32Array(n);
  const inwardY = new Float32Array(n);
  const eps = 1e-9;
  let polyLen = 0;
  for (let i = 0; i < n; i++) {
    const p = voronoi.cellPolygon(i);
    const flat = new Float64Array(p ? (p.length - 1) * 2 : 0);
    if (p) {
      for (let k = 0; k < p.length - 1; k++) {
        flat[2 * k] = p[k][0];
        flat[2 * k + 1] = p[k][1];
        if (p[k][0] < eps) inwardX[i] = 1;
        if (p[k][0] > width - eps) inwardX[i] = -1;
        if (p[k][1] < eps) inwardY[i] = 1;
        if (p[k][1] > height - eps) inwardY[i] = -1;
      }
      area[i] = Math.abs(shoelace(flat));
    }
    if (inwardX[i] || inwardY[i]) boundary[i] = 1;
    polys.push(flat);
    polyLen += flat.length;
  }
  const polyOff = new Int32Array(n + 1);
  const poly = new Float32Array(polyLen);
  for (let i = 0, o = 0; i < n; i++) {
    polyOff[i] = o / 2;
    poly.set(polys[i], o);
    o += polys[i].length;
  }
  polyOff[n] = polyLen / 2;

  // 邻接：Voronoi 邻居，共享边由两多边形的公共顶点求出
  const key = (px: number, py: number) => `${Math.round(px * 1e8)},${Math.round(py * 1e8)}`;
  const lists: number[][] = [];
  for (let i = 0; i < n; i++) lists.push([...voronoi.neighbors(i)]);
  const off = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) off[i + 1] = off[i] + lists[i].length;
  const adj = new Int32Array(off[n]);
  const dist = new Float64Array(off[n]);
  const edgeLen = new Float64Array(off[n]);
  const edgeSeg = new Float32Array(off[n] * 4);
  for (let i = 0; i < n; i++) {
    const pi = polys[i];
    const verts = new Map<string, number>();
    for (let k = 0; k < pi.length / 2; k++) verts.set(key(pi[2 * k], pi[2 * k + 1]), k);
    lists[i].forEach((j, t) => {
      const e = off[i] + t;
      adj[e] = j;
      dist[e] = Math.hypot(x[i] - x[j], y[i] - y[j]);
      const pj = polys[j];
      const shared: number[] = [];
      for (let k = 0; k < pj.length / 2 && shared.length < 4; k++) {
        if (verts.has(key(pj[2 * k], pj[2 * k + 1]))) shared.push(pj[2 * k], pj[2 * k + 1]);
      }
      if (shared.length === 4) {
        edgeLen[e] = Math.hypot(shared[0] - shared[2], shared[1] - shared[3]);
        edgeSeg.set(shared, e * 4);
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
    });
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

function shoelace(flat: Float64Array): number {
  let a = 0;
  const m = flat.length / 2;
  for (let k = 0; k < m; k++) {
    const j = (k + 1) % m;
    a += flat[2 * k] * flat[2 * j + 1] - flat[2 * j] * flat[2 * k + 1];
  }
  return a / 2;
}

function centroid(p: ArrayLike<[number, number]> & { length: number }): [number, number] {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < p.length - 1; k++) {
    const [x0, y0] = p[k];
    const [x1, y1] = p[k + 1];
    const c = x0 * y1 - x1 * y0;
    a += c;
    cx += (x0 + x1) * c;
    cy += (y0 + y1) * c;
  }
  if (Math.abs(a) < 1e-14) return [p[0][0], p[0][1]];
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

// 同上，并记录每格最近的种子（owner 为种子格编号，不可达为 -1）
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
  while (heap.size) {
    const [i, di] = heap.pop();
    if (di > d[i] || di > limit) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      const c = cost ? cost(i, j, e) : mesh.dist[e];
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

// 轻量堆（允许重复入堆，弹出时跳过过期项）
class HeapLite {
  private items: number[] = [];
  private keys: number[] = [];
  constructor(_cap: number) {}
  get size() {
    return this.items.length;
  }
  push(item: number, key: number) {
    const items = this.items;
    const keys = this.keys;
    let i = items.length;
    items.push(item);
    keys.push(key);
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
  pop(): [number, number] {
    const items = this.items;
    const keys = this.keys;
    const top: [number, number] = [items[0], keys[0]];
    const lastI = items.pop()!;
    const lastK = keys.pop()!;
    const n = items.length;
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
