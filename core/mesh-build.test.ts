import { Delaunay } from 'd3-delaunay';
import { describe, expect, it } from 'vitest';
import { type PlaneMesh, buildMesh } from './mesh';
import { mulberry32 } from './rng';

// 平面网格提速（每格只裁剪一次、Delaunay 邻居不用生成器、公共顶点用数值比较）后，与原来的写法逐字节一致。
// 下面的 buildMeshOld 是原来 buildMesh 的原样拷贝，不要改它

describe('平面网格与原来的写法逐字节一致', () => {
  const cases: [number, number, number][] = [
    [300, 1, 1],
    [1000, 1.5, 3],
    [2500, 2, 7],
    [1800, 0.6, 2],
    [4000, 2, 1],
    // 退化情况：没有点、一个点、两个点、三点共线
    [1, 0.05, 1],
    [1, 1, 1],
    [2, 1, 1],
    [3, 0.1, 1],
  ];
  it.each(cases)('%i 格、宽高比 %d、种子 %i', (cells, aspect, seed) => {
    const a = buildMeshOld(cells, aspect, seed);
    const b = buildMesh(cells, aspect, seed);
    for (const k of ['n', 'width', 'height', 'spacing', 'totalArea'] as const) expect(Object.is(b[k], a[k]), k).toBe(true);
    const arrays = ['x', 'y', 'off', 'adj', 'dist', 'edgeLen', 'edgeSeg', 'area', 'boundary', 'inwardX', 'inwardY', 'polyOff', 'poly', 'triangles'] as const;
    for (const k of arrays) {
      expect(b[k].constructor, k).toBe(a[k].constructor);
      expect(sameBytes(b[k], a[k]), k).toBe(true);
    }
    expect(sameBytes(b.delaunay.points as Float64Array, a.delaunay.points as Float64Array)).toBe(true);
    expect(sameBytes(b.delaunay.halfedges, a.delaunay.halfedges)).toBe(true);
  });
});

function sameBytes(p: ArrayBufferView, q: ArrayBufferView): boolean {
  if (p.byteLength !== q.byteLength) return false;
  const u = new Uint8Array(p.buffer, p.byteOffset, p.byteLength);
  const v = new Uint8Array(q.buffer, q.byteOffset, q.byteLength);
  for (let k = 0; k < u.length; k++) if (u[k] !== v[k]) return false;
  return true;
}

// —— 以下是原来的 buildMesh（提速前），原样保留作对照 ——

function buildMeshOld(cells: number, aspect: number, seed: number): PlaneMesh {
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
