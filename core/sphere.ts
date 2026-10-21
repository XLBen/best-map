import { Delaunay } from 'd3-delaunay';
import type { SphereMesh } from './mesh';
import { mixSeed, mulberry32 } from './rng';

// 整个星球的球面网格：格均匀地铺满球面，东西相接、两极也只是普通的格。
//   撒点：斐波那契点阵 + 带种子的抖动 + 一次球面 Lloyd 松弛。只用加减乘除和开方，不用三角函数，
//         所以格的编号在任何浏览器里都一样（命令里存的是格编号）
//   三角化：从最南的点做球极投影（保圆），平面 Delaunay 之后用投影点补上凸包，就是球面 Delaunay
//   单位：显示坐标 x = 1 + 经度/180（0–2）、y = (90 − 纬度)/180；距离、边长是弧长 / π，面积是立体角 / π²，
//         所以 ×kmPerUnit（= π·R）、×kmPerUnit² 就是 km、km²，平面世界的换算代码照用

// 黄金角 π(3 − √5) 的余弦、正弦（预先算好，避免运行时的三角函数）
const COS_G = -0.73736887807831974;
const SIN_G = 0.67549029426152385;

// 单位向量处的东、南切向量。极点上取经度 0 的方向
export function tangentBasis(px: number, py: number, pz: number): [number, number, number, number, number, number] {
  const rho = Math.sqrt(px * px + py * py);
  if (rho < 1e-12) return [0, 1, 0, pz > 0 ? 1 : -1, 0, 0];
  return [-py / rho, px / rho, 0, (px * pz) / rho, (py * pz) / rho, -rho];
}

// 显示坐标 → 球面上的单位向量（x 可以超出 [0, 2)）
export function toUnit(x: number, y: number): [number, number, number] {
  const lon = Math.PI * (x - 1);
  const colat = Math.PI * Math.min(1, Math.max(0, y));
  const s = Math.sin(colat);
  return [s * Math.cos(lon), s * Math.sin(lon), Math.cos(colat)];
}

const angle = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  return Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), ax * bx + ay * by + az * bz);
};

// 单位球面三角形的面积（立体角，Van Oosterom–Strackee）
function triArea(p: Float64Array, a: number, v: Float64Array, b: number, c: number): number {
  const ax = p[3 * a];
  const ay = p[3 * a + 1];
  const az = p[3 * a + 2];
  const bx = v[3 * b];
  const by = v[3 * b + 1];
  const bz = v[3 * b + 2];
  const cx = v[3 * c];
  const cy = v[3 * c + 1];
  const cz = v[3 * c + 2];
  const det = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  const den = 1 + ax * bx + ay * by + az * bz + bx * cx + by * cy + bz * cz + cx * ax + cy * ay + cz * az;
  return 2 * Math.atan2(Math.abs(det), den);
}

function fibonacciPoints(n: number, seed: number, salt: number): Float64Array {
  const rand = mulberry32(mixSeed(seed, 0x5f3, salt));
  // 六边形格点的间距（单位球上）
  const s = Math.sqrt((4 * Math.PI) / (n * (Math.sqrt(3) / 2)));
  const p = new Float64Array(3 * n);
  let c = 1;
  let sn = 0;
  for (let k = 0; k < n; k++) {
    const z = 1 - (2 * k + 1) / n;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const x = r * c;
    const y = r * sn;
    const [ex, ey, ez, sx, sy, sz] = tangentBasis(x, y, z);
    const oe = (rand() - 0.5) * 0.7 * s;
    const os = (rand() - 0.5) * 0.7 * s * (Math.sqrt(3) / 2);
    let qx = x + oe * ex + os * sx;
    let qy = y + oe * ey + os * sy;
    let qz = z + oe * ez + os * sz;
    const l = Math.sqrt(qx * qx + qy * qy + qz * qz);
    qx /= l;
    qy /= l;
    qz /= l;
    p[3 * k] = qx;
    p[3 * k + 1] = qy;
    p[3 * k + 2] = qz;
    const nc = c * COS_G - sn * SIN_G;
    const ns = sn * COS_G + c * SIN_G;
    const m = Math.sqrt(nc * nc + ns * ns);
    c = nc / m;
    sn = ns / m;
  }
  return p;
}

// 球面 Delaunay：三角形顶点按从外面看逆时针排列
function sphericalDelaunay(p: Float64Array, n: number): Uint32Array {
  let p0 = 0;
  for (let i = 1; i < n; i++) if (p[3 * i + 2] < p[3 * p0 + 2]) p0 = i;
  const ox = p[3 * p0];
  const oy = p[3 * p0 + 1];
  const oz = p[3 * p0 + 2];
  // 与 p0 垂直的两个方向
  let ux = 1;
  let uy = 0;
  let uz = 0;
  if (Math.abs(ox) > 0.9) {
    ux = 0;
    uy = 1;
  }
  const d0 = ux * ox + uy * oy + uz * oz;
  ux -= d0 * ox;
  uy -= d0 * oy;
  uz -= d0 * oz;
  const lu = Math.sqrt(ux * ux + uy * uy + uz * uz);
  ux /= lu;
  uy /= lu;
  uz /= lu;
  const vx = oy * uz - oz * uy;
  const vy = oz * ux - ox * uz;
  const vz = ox * uy - oy * ux;
  const coords = new Float64Array(2 * (n - 1));
  const back = new Int32Array(n - 1);
  for (let i = 0, k = 0; i < n; i++) {
    if (i === p0) continue;
    const qx = p[3 * i];
    const qy = p[3 * i + 1];
    const qz = p[3 * i + 2];
    const d = 1 - (qx * ox + qy * oy + qz * oz);
    coords[2 * k] = (qx * ux + qy * uy + qz * uz) / d;
    coords[2 * k + 1] = (qx * vx + qy * vy + qz * vz) / d;
    back[k] = i;
    k++;
  }
  const del = new Delaunay(coords);
  const hull = del.hull;
  const tris = new Uint32Array(del.triangles.length + 3 * hull.length);
  for (let t = 0; t < del.triangles.length; t++) tris[t] = back[del.triangles[t]];
  for (let k = 0, o = del.triangles.length; k < hull.length; k++, o += 3) {
    tris[o] = back[hull[k]];
    tris[o + 1] = back[hull[(k + 1) % hull.length]];
    tris[o + 2] = p0;
  }
  // 统一方向：a·(b×c) > 0
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t];
    const b = tris[t + 1];
    const c = tris[t + 2];
    const det =
      p[3 * a] * (p[3 * b + 1] * p[3 * c + 2] - p[3 * b + 2] * p[3 * c + 1]) -
      p[3 * a + 1] * (p[3 * b] * p[3 * c + 2] - p[3 * b + 2] * p[3 * c]) +
      p[3 * a + 2] * (p[3 * b] * p[3 * c + 1] - p[3 * b + 1] * p[3 * c]);
    if (det < 0) {
      tris[t + 1] = c;
      tris[t + 2] = b;
    }
  }
  return tris;
}

// 每格的邻居按逆时针（从外面看）排成一圈：adj[off[i] + k] 是第 k 个邻居，
// ringTri 是夹在第 k 个与第 k+1 个邻居之间的三角形。从编号最小的邻居开始，结果与引擎无关
function rings(tris: Uint32Array, n: number): { off: Int32Array; adj: Int32Array; ringTri: Int32Array } {
  const deg = new Int32Array(n);
  for (let t = 0; t < tris.length; t++) deg[tris[t]]++;
  const off = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) off[i + 1] = off[i] + deg[i];
  const from = new Int32Array(off[n]);
  const to = new Int32Array(off[n]);
  const tri = new Int32Array(off[n]);
  const fill = off.slice(0, n);
  const push = (v: number, a: number, b: number, t: number) => {
    const k = fill[v]++;
    from[k] = a;
    to[k] = b;
    tri[k] = t;
  };
  for (let t = 0; t < tris.length / 3; t++) {
    const a = tris[3 * t];
    const b = tris[3 * t + 1];
    const c = tris[3 * t + 2];
    push(a, b, c, t);
    push(b, c, a, t);
    push(c, a, b, t);
  }
  const adj = new Int32Array(off[n]);
  const ringTri = new Int32Array(off[n]);
  for (let v = 0; v < n; v++) {
    const a = off[v];
    const b = off[v + 1];
    let cur = a;
    for (let k = a + 1; k < b; k++) if (from[k] < from[cur]) cur = k;
    for (let k = a; k < b; k++) {
      adj[k] = from[cur];
      ringTri[k] = tri[cur];
      const want = to[cur];
      let next = -1;
      for (let m = a; m < b; m++) {
        if (from[m] === want) {
          next = m;
          break;
        }
      }
      if (next < 0 && k < b - 1) throw new Error('球面网格：邻居没有围成一圈');
      cur = next;
    }
  }
  return { off, adj, ringTri };
}

// 三角形的外心（单位向量，在三角形外侧）
function circumcenters(p: Float64Array, tris: Uint32Array): Float64Array {
  const m = tris.length / 3;
  const v = new Float64Array(3 * m);
  for (let t = 0; t < m; t++) {
    const a = tris[3 * t];
    const b = tris[3 * t + 1];
    const c = tris[3 * t + 2];
    const bx = p[3 * b] - p[3 * a];
    const by = p[3 * b + 1] - p[3 * a + 1];
    const bz = p[3 * b + 2] - p[3 * a + 2];
    const cx = p[3 * c] - p[3 * a];
    const cy = p[3 * c + 1] - p[3 * a + 1];
    const cz = p[3 * c + 2] - p[3 * a + 2];
    let x = by * cz - bz * cy;
    let y = bz * cx - bx * cz;
    let z = bx * cy - by * cx;
    const l = Math.sqrt(x * x + y * y + z * z);
    x /= l;
    y /= l;
    z /= l;
    v[3 * t] = x;
    v[3 * t + 1] = y;
    v[3 * t + 2] = z;
  }
  return v;
}

// 一次球面 Lloyd：每个点移到它的 Voronoi 多边形的（面积加权）重心
function relax(p: Float64Array, n: number, tris: Uint32Array): Float64Array {
  const { off, ringTri } = rings(tris, n);
  const v = circumcenters(p, tris);
  const out = new Float64Array(3 * n);
  for (let i = 0; i < n; i++) {
    const px = p[3 * i];
    const py = p[3 * i + 1];
    const pz = p[3 * i + 2];
    let sx = 0;
    let sy = 0;
    let sz = 0;
    const a = off[i];
    const b = off[i + 1];
    for (let k = a; k < b; k++) {
      const t0 = ringTri[k];
      const t1 = ringTri[k + 1 < b ? k + 1 : a];
      const ax = v[3 * t0] - px;
      const ay = v[3 * t0 + 1] - py;
      const az = v[3 * t0 + 2] - pz;
      const bx = v[3 * t1] - px;
      const by = v[3 * t1 + 1] - py;
      const bz = v[3 * t1 + 2] - pz;
      const cx = ay * bz - az * by;
      const cy = az * bx - ax * bz;
      const cz = ax * by - ay * bx;
      const area = Math.sqrt(cx * cx + cy * cy + cz * cz);
      sx += area * (3 * px + ax + bx);
      sy += area * (3 * py + ay + by);
      sz += area * (3 * pz + az + bz);
    }
    const l = Math.sqrt(sx * sx + sy * sy + sz * sz);
    out[3 * i] = sx / l;
    out[3 * i + 1] = sy / l;
    out[3 * i + 2] = sz / l;
  }
  return out;
}

export function buildSphereMesh(cells: number, seed: number): SphereMesh {
  const n = Math.max(12, Math.round(cells));
  let p: Float64Array | null = null;
  let tris: Uint32Array | null = null;
  // 退化（理论上几乎不会发生）时换一组抖动重来，结果仍然确定
  for (let salt = 0; salt < 4 && !tris; salt++) {
    const p0 = fibonacciPoints(n, seed, salt);
    const t0 = sphericalDelaunay(p0, n);
    if (t0.length / 3 !== 2 * n - 4) continue;
    const p1 = relax(p0, n, t0);
    const t1 = sphericalDelaunay(p1, n);
    if (t1.length / 3 !== 2 * n - 4) continue;
    p = p1;
    tris = t1;
  }
  if (!p || !tris) throw new Error('球面网格三角化失败');
  const { off, adj, ringTri } = rings(tris, n);
  const v = circumcenters(p, tris);

  const x = new Float64Array(n);
  const y = new Float64Array(n);
  let north = 0;
  let south = 0;
  for (let i = 0; i < n; i++) {
    const px = p[3 * i];
    const py = p[3 * i + 1];
    const pz = p[3 * i + 2];
    let xi = 1 + Math.atan2(py, px) / Math.PI;
    if (xi >= 2) xi -= 2;
    x[i] = xi;
    y[i] = Math.atan2(Math.sqrt(px * px + py * py), pz) / Math.PI;
    if (pz > p[3 * north + 2]) north = i;
    if (pz < p[3 * south + 2]) south = i;
  }

  const E = adj.length;
  const dist = new Float64Array(E);
  const edgeLen = new Float64Array(E);
  const edx = new Float64Array(E);
  const edy = new Float64Array(E);
  const area = new Float64Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const px = p[3 * i];
    const py = p[3 * i + 1];
    const pz = p[3 * i + 2];
    const [ex, ey, ez, sx, sy, sz] = tangentBasis(px, py, pz);
    const a = off[i];
    const b = off[i + 1];
    let ar = 0;
    for (let k = a; k < b; k++) {
      const j = adj[k];
      const qx = p[3 * j];
      const qy = p[3 * j + 1];
      const qz = p[3 * j + 2];
      const d = angle(px, py, pz, qx, qy, qz) / Math.PI;
      dist[k] = d;
      total += d;
      // 第 k 个邻居两侧的三角形：第 k−1 个与第 k 个
      const tPrev = ringTri[k > a ? k - 1 : b - 1];
      const tCur = ringTri[k];
      edgeLen[k] = angle(v[3 * tPrev], v[3 * tPrev + 1], v[3 * tPrev + 2], v[3 * tCur], v[3 * tCur + 1], v[3 * tCur + 2]) / Math.PI;
      // 切平面里的方向（等距方位投影：长度等于弧长）
      const dot = px * qx + py * qy + pz * qz;
      const wx = qx - dot * px;
      const wy = qy - dot * py;
      const wz = qz - dot * pz;
      const wl = Math.sqrt(wx * wx + wy * wy + wz * wz);
      edx[k] = wl > 0 ? (d * (wx * ex + wy * ey + wz * ez)) / wl : 0;
      edy[k] = wl > 0 ? (d * (wx * sx + wy * sy + wz * sz)) / wl : 0;
      ar += triArea(p, i, v, tCur, ringTri[k + 1 < b ? k + 1 : a]);
    }
    area[i] = ar / (Math.PI * Math.PI);
  }

  const mesh: SphereMesh = {
    kind: 'sphere',
    n,
    width: 2,
    height: 1,
    x,
    y,
    off,
    adj,
    dist,
    edgeLen,
    edgeSeg: new Float32Array(0),
    area,
    boundary: new Uint8Array(n),
    inwardX: new Float32Array(n),
    inwardY: new Float32Array(n),
    polyOff: new Int32Array(n + 1),
    poly: new Float32Array(0),
    triangles: tris,
    spacing: total / E,
    totalArea: 4 / Math.PI,
    p,
    edx,
    edy,
    north,
    south,
    locate: () => 0,
  };
  mesh.locate = (px, py, hint) => {
    const view = viewOf(mesh);
    const xw = px - 2 * Math.floor(px / 2);
    return view.cellOf[view.delaunay.find(xw, Math.min(1, Math.max(0, py)), hint >= 0 && hint < view.cellOf.length ? hint : 0)];
  };
  return mesh;
}

// ---------- 显示用的三角网 ----------

// 平铺图上的三角网：所有格的中心，加上接缝附近的格在 x ± 2 处的副本、y = 0 与 y = 1 两行极点“影子点”
// （分别对应最北、最南的格）。屏幕上一点属于哪一格，就是这张网里离它最近的点所对应的格——
// GPU 画出来的分区、导出的位图、鼠标下的格都按这一条，所以三者一致。
// 前 n 个点就是格本身，所以格编号可以直接当查找的起点
export interface SphereView {
  x: Float64Array;
  y: Float64Array;
  cellOf: Int32Array;
  delaunay: Delaunay<number>;
  // 画的时候用的三角形（重心 x 在 [0, 2) 里的那些；再画 x ± 2 的副本就铺满屏幕）
  triangles: Uint32Array;
  // 渲染 id 层用的 Voronoi 多边形（裁到 [0, 2] × [0, 1]），懒得算
  polygons(): { off: Int32Array; xy: Float32Array; cell: Int32Array };
}

const views = new WeakMap<SphereMesh, SphereView>();

export function viewOf(mesh: SphereMesh): SphereView {
  const hit = views.get(mesh);
  if (hit) return hit;
  const { n, spacing } = mesh;
  const xs: number[] = [];
  const ys: number[] = [];
  const cells: number[] = [];
  for (let i = 0; i < n; i++) {
    xs.push(mesh.x[i]);
    ys.push(mesh.y[i]);
    cells.push(i);
  }
  for (let i = 0; i < n; i++) {
    // 高纬度的格在图上很宽，离接缝更远也要复制
    const g = Math.min(1, (4 * spacing) / Math.max(Math.sin(Math.PI * mesh.y[i]), 1e-3));
    if (mesh.x[i] < g) {
      xs.push(mesh.x[i] + 2);
      ys.push(mesh.y[i]);
      cells.push(i);
    }
    if (mesh.x[i] > 2 - g) {
      xs.push(mesh.x[i] - 2);
      ys.push(mesh.y[i]);
      cells.push(i);
    }
  }
  const step = 2 * spacing;
  const count = Math.ceil(4 / step);
  for (let k = 0; k <= count; k++) {
    const x = -1 + (4 * k) / count;
    xs.push(x, x);
    ys.push(0, 1);
    cells.push(mesh.north, mesh.south);
  }
  const m = xs.length;
  const coords = new Float64Array(2 * m);
  for (let k = 0; k < m; k++) {
    coords[2 * k] = xs[k];
    coords[2 * k + 1] = ys[k];
  }
  const delaunay = new Delaunay(coords);
  const vx = Float64Array.from(xs);
  const vy = Float64Array.from(ys);
  const cellOf = Int32Array.from(cells);
  const all = delaunay.triangles;
  const keep: number[] = [];
  for (let t = 0; t < all.length; t += 3) {
    const cx = (vx[all[t]] + vx[all[t + 1]] + vx[all[t + 2]]) / 3;
    if (cx >= 0 && cx < 2) keep.push(all[t], all[t + 1], all[t + 2]);
  }
  let polys: { off: Int32Array; xy: Float32Array; cell: Int32Array } | null = null;
  const view: SphereView = {
    x: vx,
    y: vy,
    cellOf,
    delaunay,
    triangles: Uint32Array.from(keep),
    polygons() {
      if (polys) return polys;
      const voronoi = delaunay.voronoi([0, 0, 2, 1]);
      const offs: number[] = [0];
      const xy: number[] = [];
      const cell: number[] = [];
      for (let k = 0; k < m; k++) {
        const poly = voronoi.cellPolygon(k);
        if (!poly) continue;
        for (let q = 0; q < poly.length - 1; q++) xy.push(poly[q][0], poly[q][1]);
        offs.push(xy.length / 2);
        cell.push(cellOf[k]);
      }
      polys = { off: Int32Array.from(offs), xy: Float32Array.from(xy), cell: Int32Array.from(cell) };
      return polys;
    },
  };
  views.set(mesh, view);
  return view;
}

// ---------- 球面上真正最近的格 ----------

const buckets = new WeakMap<SphereMesh, Int32Array>();
const ROWS = 90;
const COLS = 180;

function greedy(mesh: SphereMesh, start: number, qx: number, qy: number, qz: number): number {
  const p = mesh.p;
  let c = start;
  let best = p[3 * c] * qx + p[3 * c + 1] * qy + p[3 * c + 2] * qz;
  for (;;) {
    let next = -1;
    let nd = best;
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
      const j = mesh.adj[e];
      const d = p[3 * j] * qx + p[3 * j + 1] * qy + p[3 * j + 2] * qz;
      if (d > nd || (d === nd && next >= 0 && j < next)) {
        nd = d;
        next = j;
      }
    }
    if (next < 0) return c;
    best = nd;
    c = next;
  }
}

// 2° 经纬格的起点：从上一个格的结果出发贪心走到这个格的中心
function bucketsOf(mesh: SphereMesh): Int32Array {
  let b = buckets.get(mesh);
  if (b) return b;
  b = new Int32Array(ROWS * COLS);
  let c = mesh.north;
  for (let r = 0; r < ROWS; r++) {
    for (let k = 0; k < COLS; k++) {
      const [qx, qy, qz] = toUnit(((k + 0.5) / COLS) * 2, (r + 0.5) / ROWS);
      c = greedy(mesh, c, qx, qy, qz);
      b[r * COLS + k] = c;
    }
  }
  buckets.set(mesh, b);
  return b;
}

// 球面上离显示坐标 (x, y) 最近的格（沿 Delaunay 图贪心走，结果是精确的）。用于物理意义上的查询
export function nearestCell(mesh: SphereMesh, x: number, y: number, hint = -1): number {
  const [qx, qy, qz] = toUnit(x, y);
  let start = hint;
  if (start < 0 || start >= mesh.n || mesh.p[3 * start] * qx + mesh.p[3 * start + 1] * qy + mesh.p[3 * start + 2] * qz < Math.cos(8 * mesh.spacing * Math.PI)) {
    const xw = x - 2 * Math.floor(x / 2);
    const r = Math.min(ROWS - 1, Math.max(0, Math.floor(Math.min(1, Math.max(0, y)) * ROWS)));
    const k = Math.min(COLS - 1, Math.floor((xw / 2) * COLS));
    start = bucketsOf(mesh)[r * COLS + k];
  }
  return greedy(mesh, start, qx, qy, qz);
}
