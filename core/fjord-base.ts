// 峡湾的参数、谷网的类型与共用的小工具（第八十三轮从 core/fjords.ts 原样搬出）：星形的三角形、候选的谷段、画法的场（着色器里同一个算式）
import type { Mesh } from './mesh';
import { mixSeed } from './rng';
import { viewOf } from './sphere';

export const FJ = {
  // 谷网覆盖峡湾权重（往外推 GROW_RINGS 圈，每圈 × GROW）超过 ZONE 的格
  ZONE: 0.02,
  GROW_RINGS: 2,
  GROW: 0.8,
  // 每格的点数、离格心的距离（格，R0 + R1 × 随机）
  NPC: 4,
  R0: 0.3,
  R1: 0.16,
  // 两点相连的最长距离（LINK 格与 LINK_KM 取小：格大时谷不走一步一大段的直线）、连线离两头的格心至少多远（格）
  LINK: 0.9,
  LINK_KM: 62,
  CENTER_GAP: 0.2,
  // 谷底高度的噪声：频率（每格）、幅度（地壳高度每格的变化 × V_NOISE + V_NOISE0 m）
  V_FREQ: 0.6,
  V_NOISE: 0.9,
  V_NOISE0: 60,
  // 汇水（点数）至少 ACC_MIN 才算谷；汇水面积 ACC1_KM2 时长度、宽度的汇水因子（√(面积 / ACC1_KM2)）满
  ACC_MIN: 2,
  ACC1_KM2: 20000,
  // 直接流进海里的谷汇水面积不到 ACC_MOUTH_KM2 的不淹（一个个小缺口；峡湾是大谷）
  ACC_MOUTH_KM2: 8000,
  // 入海口的预算（km）：LEN_KM × 权重 × 地点的倍数（LEN_M0 + 2 × LEN_M1 × 噪声，噪声频率 LEN_FREQ 每格，夹在 M_MIN 到 M_MAX）
  // × 汇水因子，最多 LEN_CAP_KM（地球上最长的峡湾斯科斯比松约 350 km）。都按 km：与格多大无关
  LEN_KM: 450,
  LEN_M0: 0.85,
  LEN_M1: 0.75,
  LEN_FREQ: 0.25,
  M_MIN: 0.35,
  M_MAX: 1.2,
  LEN_CAP_KM: 350,
  // 支湾：一个峡湾最多 MAX_ARMS 条（离入海口近的先）；汇水面积至少 ACC_SIDE_KM2、与主湾的夹角至少 ARM_ANGLE 度；
  // 长度不过汇合处主湾剩下的 ARM_FRAC 倍，再 × (SIDE0 + SIDE1 × 随机)
  MAX_ARMS: 3,
  ACC_SIDE_KM2: 8000,
  ARM_ANGLE: 35,
  ARM_FRAC: 0.55,
  SIDE0: 0.4,
  SIDE1: 0.5,
  // 往上游的方向与地壳高度往上的方向夹角超过 DIR_MAX 度的段不淹（峡湾往内陆走，不顺着海岸走）；坡缓到每 km 不到 DIR_FLAT_KM m 时不管
  DIR_MAX: 60,
  DIR_FLAT_KM: 0.2,
  // 离入海口 COAST_KM 以外，离海不到 COAST_K × 从入海口走过的长度的点不淹
  COAST_KM: 60,
  COAST_K: 0.6,
  // 半宽（km）：HW_KM × (HW_A + (1 − HW_A) × 汇水因子)；离头 TAPER_KM 以内收窄到 TAPER_MIN；
  // 越往外越宽：× (WIDEN0 + WIDEN1 × min(1, 预算 / WIDEN_KM))；海里的点 × SEA_W
  HW_KM: 3.4,
  HW_A: 0.5,
  TAPER_KM: 60,
  TAPER_MIN: 0.65,
  WIDEN0: 0.75,
  WIDEN1: 0.6,
  WIDEN_KM: 250,
  SEA_W: 1.4,
  // 入海口往海里延长 MOUTH 格
  MOUTH: 0.4,
  // 沿主谷平滑几遍
  SMOOTH: 1,
  // 预算在一段中间用完时，头上的半径是下游那头的 HEAD 倍（圆头）
  HEAD: 0.6,
  // 谷网按块建（重新生成一片时只重建碰到的块）：块约 TILE_KM 见方（星球按单位球上的立方格子）；谷不过块的边
  TILE_KM: 900,
  // 有表的格：谷网一带往外 RANK_RINGS 圈（两极附近 RANK_RINGS_POLAR 圈）
  RANK_RINGS: 4,
  RANK_RINGS_POLAR: 8,
  // 岸弯弯曲曲：中线按海岸细节的噪声 nd 往一侧挪 LAT × 半径，半径 × (1 + WOB × (2|nd| − WOB_C))
  LAT: 1.6,
  WOB: 0.35,
  WOB_C: 0.6,
  // 带子以外 EDGE 格海岸场就涨到 SMAX（比任何一点的海岸场都大，带子以外一点都不改）
  SMAX: 4000,
  EDGE: 0.01,
  // 预算用到中间时只淹到那里：剩下不到 STUB_MIN 的不画
  STUB_MIN: 0.05,
  // 每格的表里最多几段（着色器的循环上限）
  MAX_LIST: 256,
  // 画的水深（只是画法）：入海口那一格的水深（至少 DEPTH_MIN m）× DEPTH_K，最深 DEPTH_MAX m
  DEPTH_MIN: 60,
  DEPTH_K: 1.6,
  DEPTH_MAX: 900,
};

// 一块的谷网（只取决于这一块与邻格的生成器分量、网格、种子）
export interface TileNet {
  key: number;
  n: number;
  pos: Float64Array;
  mid: Float64Array;
  owner: Int32Array;
  // 下游的点（块里的编号，−1：出口）
  recv: Int32Array;
  order: Int32Array;
  // 到下游的点的长度（km）
  len: Float32Array;
  // 入海口的预算（km；直接流进海里时）、海里的预算（km）、支湾的上限（km，不是支湾时 −1）、半宽（格）
  lc: Float32Array;
  lsea: Float32Array;
  lcs: Float32Array;
  hw: Float32Array;
  // 主支（下游的点的主支是自己）、往上游的方向没跑偏
  isMain: Uint8Array;
  dirOk: Uint8Array;
  // 每段碰得到的格（用到时才算，按块留着）
  cands: (Int32Array | null)[];
}

// 谷网（只取决于网格、种子、生成器的分量与新建时的纬度）：各块拼起来
export interface FjordNet {
  tiles: TileNet[];
  // 点数（含不在谷里的）
  n: number;
  pos: Float64Array;
  mid: Float64Array;
  owner: Int32Array;
  recv: Int32Array;
  // 谷里的点，从下游到上游（各块依次）
  order: Int32Array;
  len: Float32Array;
  lc: Float32Array;
  lsea: Float32Array;
  lcs: Float32Array;
  hw: Float32Array;
  isMain: Uint8Array;
  dirOk: Uint8Array;
  // 每个点在哪一块、块里的编号（算碰得到的格时写回那一块）
  nodeTile: Int32Array;
  nodeLocal: Int32Array;
  cands: (Int32Array | null)[];
  // 每格的表号（−1 没有）、有表的格数
  rank: Int32Array;
  nRank: number;
  // 每格离谷网一带几圈（有表的格 0 到 RANK_RINGS_POLAR，−1 没有表）：重画一片时只在一带变了的格附近重算
  ring: Int8Array;
  // 谷里的点所在的格（陆海只看这些格）
  watch: Int32Array;
  // 往外推了两圈的峡湾权重（谷网的一带）
  wz: Float32Array;
  // 一格的距离单位（平面：格距；星球：π × 格距 弧度）、一格多少 km
  spDist: number;
  kmCell: number;
  sph: boolean;
  mesh: Mesh;
}

export const sm01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// 0–1 的哈希
export function hash01(seed: number, a: number, b: number, c: number): number {
  return mixSeed(seed, a, b, c) / 4294967296;
}

// 每格的星形半径（格）：到 Delaunay 邻格最远的距离 × 1.15（两极附近 × 2：显示的三角网在经纬度上画，像素离格心远一些）
const starCache = new WeakMap<Mesh, Float32Array>();
function starRadius(mesh: Mesh): Float32Array {
  let r = starCache.get(mesh);
  if (r) return r;
  r = new Float32Array(mesh.n);
  const sph = mesh.kind === 'sphere';
  for (let i = 0; i < mesh.n; i++) {
    let m = 0;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (mesh.dist[e] > m) m = mesh.dist[e];
    let k = 1.15;
    if (sph && Math.abs((mesh as Extract<Mesh, { kind: 'sphere' }>).p[3 * i + 2]) > 0.97) k = 2.2;
    r[i] = (m / mesh.spacing) * k;
  }
  starCache.set(mesh, r);
  return r;
}

// 每格的星形（以它为角的三角形，画面上画的那些）：每个三角形的重心与外接的半径（格；星球上两极附近 × 2）。
// 段离某个三角形的重心不到 半径 + rInf 时，这一格的表要收它（比星形半径的圆小一半）
interface Stars {
  off: Int32Array;
  tri: Int32Array;
  cen: Float64Array;
  rad: Float32Array;
  // 每个画面三角形的最后一个顶点的格（着色器的 flat 取它的表）
  prov: Int32Array;
  // 每个画面三角形的三个角（格）、第一个角的位置（3t）
  corner: Int32Array;
  offT: Int32Array;
  // 整个星球：Delaunay 的每个三角形（含接缝外的影子三角形）对应的画面三角形的最后一个顶点的格
  provDel: Int32Array | null;
}
const starsCache = new WeakMap<Mesh, Stars>();
function starTris(mesh: Mesh): Stars {
  let st = starsCache.get(mesh);
  if (st) return st;
  const sph = mesh.kind === 'sphere';
  const spDist = sph ? Math.PI * mesh.spacing : mesh.spacing;
  let corners: Int32Array;
  if (mesh.kind === 'sphere') {
    const view = viewOf(mesh);
    corners = new Int32Array(view.triangles.length);
    for (let k = 0; k < corners.length; k++) corners[k] = view.cellOf[view.triangles[k]];
  } else corners = Int32Array.from(mesh.triangles);
  const T = corners.length / 3;
  const cen = new Float64Array(3 * T);
  const rad = new Float32Array(T);
  const count = new Int32Array(mesh.n + 1);
  for (let t = 0; t < T; t++) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let k = 0; k < 3; k++) {
      cellPos(mesh, corners[3 * t + k], P3, 0);
      cx += P3[0] / 3;
      cy += P3[1] / 3;
      cz += P3[2] / 3;
    }
    let r = 0;
    let polar = false;
    for (let k = 0; k < 3; k++) {
      const c = corners[3 * t + k];
      cellPos(mesh, c, P3, 0);
      r = Math.max(r, Math.hypot(P3[0] - cx, P3[1] - cy, P3[2] - cz));
      if (sph && Math.abs(P3[2]) > 0.97) polar = true;
      // 同一格在一个三角形里出现两次（两极的影子点）只记一次
      if ((k === 1 && c === corners[3 * t]) || (k === 2 && (c === corners[3 * t] || c === corners[3 * t + 1]))) continue;
      count[c + 1]++;
    }
    cen[3 * t] = cx;
    cen[3 * t + 1] = cy;
    cen[3 * t + 2] = cz;
    rad[t] = ((r * (sph ? 1.15 : 1.02)) / spDist) * (polar ? 2.2 : 1);
  }
  for (let i = 0; i < mesh.n; i++) count[i + 1] += count[i];
  const off = count.slice();
  const fill = count.slice(0, mesh.n);
  const tri = new Int32Array(off[mesh.n]);
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const c = corners[3 * t + k];
      if ((k === 1 && c === corners[3 * t]) || (k === 2 && (c === corners[3 * t] || c === corners[3 * t + 1]))) continue;
      tri[fill[c]++] = t;
    }
  }
  const prov = new Int32Array(T);
  for (let t = 0; t < T; t++) prov[t] = corners[3 * t + 2];
  let provDel: Int32Array | null = null;
  if (mesh.kind === 'sphere') {
    // 接缝外的影子三角形与画面上的那个三角形是同几格（平移 2）：按三格（排好序）对上
    const view = viewOf(mesh);
    const all = view.delaunay.triangles;
    const byKey = new Map<number, number>();
    const n = mesh.n;
    for (let t = 0; t < T; t++) byKey.set(triKey(corners[3 * t], corners[3 * t + 1], corners[3 * t + 2], n), prov[t]);
    provDel = new Int32Array(all.length / 3);
    for (let t = 0; t < provDel.length; t++) {
      const a = view.cellOf[all[3 * t]];
      const b = view.cellOf[all[3 * t + 1]];
      const c = view.cellOf[all[3 * t + 2]];
      provDel[t] = byKey.get(triKey(a, b, c, n)) ?? c;
    }
  }
  const offT = new Int32Array(T);
  for (let t = 0; t < T; t++) offT[t] = 3 * t;
  st = { off, tri, cen, rad, prov, provDel, corner: corners, offT };
  starsCache.set(mesh, st);
  return st;
}

// 三格（排好序）的键：(lo · n + mid) · n + hi（n³ 远小于 2⁵³）
function triKey(a: number, b: number, c: number, n: number): number {
  const lo = Math.min(a, b, c);
  const hi = Math.max(a, b, c);
  return (lo * n + (a + b + c - lo - hi)) * n + hi;
}

// 整个星球：Delaunay 的每个三角形对应的“最后一个顶点的格”（subcell.ts 的 locateSphere 用）
export function sphereProvDel(mesh: Mesh): Int32Array | null {
  return mesh.kind === 'sphere' ? starTris(mesh).provDel : null;
}

// CPU 找到的三角形（Delaunay 的编号 t；平面世界里就是画面三角形）对应的“最后一个顶点的格”：着色器在这个三角形里用它的表
export function provOfTri(mesh: Mesh, t: number): number {
  if (mesh.kind === 'sphere') return starTris(mesh).provDel![t];
  return mesh.triangles[3 * t + 2];
}

// 在格 c、r 之间的边上的点：以这条边为边的一个画面三角形的最后一个顶点的格（两边的三角形的表都含碰得到这一点的段）。没有时 c
export function provOnEdge(mesh: Mesh, c: number, r: number): number {
  const st = starTris(mesh);
  for (let k = st.off[c]; k < st.off[c + 1]; k++) {
    const t = st.tri[k];
    for (let q = st.offT[t]; q < st.offT[t] + 3; q++) if (st.corner[q] === r) return st.prov[t];
  }
  return c;
}

// 格心的位置（与点同一个坐标）
export function cellPos(mesh: Mesh, i: number, out: Float64Array, o: number): void {
  if (mesh.kind === 'sphere') {
    out[o] = mesh.p[3 * i];
    out[o + 1] = mesh.p[3 * i + 1];
    out[o + 2] = mesh.p[3 * i + 2];
  } else {
    out[o] = mesh.x[i];
    out[o + 1] = mesh.y[i];
    out[o + 2] = 0;
  }
}

// 点 p 到线段 a–b 的距离（同一个坐标，三维）
export function segDist(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const wx = px - ax;
  const wy = py - ay;
  const wz = pz - az;
  const uu = ux * ux + uy * uy + uz * uz;
  let t = uu > 0 ? (wx * ux + wy * uy + wz * uz) / uu : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = wx - t * ux;
  const dy = wy - t * uy;
  const dz = wz - t * uz;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export const P3 = new Float64Array(6);

// 建块、找碰得到的格时共用的缓冲（按网格）：local 是格在这一块里的编号（−1 不在，用完还原）
interface Scratch {
  local: Int32Array;
  mark: Int32Array;
  stamp: Int32Array;
  pstamp: Int32Array;
  tick: number;
}
const scratchCache = new WeakMap<Mesh, Scratch>();
export function scratchOf(mesh: Mesh): Scratch {
  let s = scratchCache.get(mesh);
  if (!s) {
    s = { local: new Int32Array(mesh.n).fill(-1), mark: new Int32Array(mesh.n).fill(-1), stamp: new Int32Array(mesh.n), pstamp: new Int32Array(mesh.n), tick: 0 };
    scratchCache.set(mesh, s);
  }
  return s;
}

// 段 u → recv[u] 碰得到的格（画面三角形的最后一个顶点的格；只按网格与谷网的几何，用到时才算，写回那一块，块重用时照用）
export function candOf(net: FjordNet, u: number): Int32Array {
  const have = net.cands[u];
  if (have) return have;
  const { mesh } = net;
  const v = net.recv[u];
  const sc = scratchOf(mesh);
  const out: number[] = [];
  const rInf = Math.max(net.hw[u], net.hw[v]) * FJ.SEA_W * FJ_REACH + FJ.EDGE;
  const ext = Math.min((FJ.MOUTH * net.kmCell) / Math.max(net.len[u], 1e-6), 4);
  sc.tick++;
  candidates(starTris(mesh), mesh, starRadius(mesh), net.pos, net.mid, u, v, net.owner[u], net.owner[v], rInf, net.spDist, ext, net.sph, sc.stamp, sc.pstamp, sc.tick, queueBuf, out);
  const c = Int32Array.from(out);
  net.cands[u] = c;
  net.tiles[net.nodeTile[u]].cands[net.nodeLocal[u]] = c;
  return c;
}
const queueBuf: number[] = [];

// 段 u–v 碰得到的格：从两头所在的格往外找，离段不到（星形半径 + rInf）的格（rank 先记 0 表示有表）
// ext：下游那头往外延长这一段的几倍（入海口，见 writeEntry）
// 格 c 的星形里离段（u → 中点 → v）不到 半径 + rInf 的三角形：它们的“最后一个顶点的格”收这一段（每段每格只收一次）
function nearStar(stars: Stars, c: number, ux: number, uy: number, uz: number, mx: number, my: number, mz: number, vx: number, vy: number, vz: number, rInf: number, spDist: number, tick: number, pstamp: Int32Array, out: number[]): void {
  const { off, tri, cen, rad, prov } = stars;
  for (let k = off[c]; k < off[c + 1]; k++) {
    const t = tri[k];
    const p = prov[t];
    if (pstamp[p] === tick) continue;
    const px = cen[3 * t];
    const py = cen[3 * t + 1];
    const pz = cen[3 * t + 2];
    const d = Math.min(segDist(px, py, pz, ux, uy, uz, mx, my, mz), segDist(px, py, pz, mx, my, mz, vx, vy, vz)) / spDist;
    if (d > rad[t] + rInf) continue;
    pstamp[p] = tick;
    out.push(p);
  }
}

function candidates(stars: Stars, mesh: Mesh, star: Float32Array, pos: Float64Array, mid: Float64Array, u: number, v: number, ou: number, ov: number, rInf: number, spDist: number, ext: number, sph: boolean, stamp: Int32Array, pstamp: Int32Array, tick: number, queue: number[], out: number[]): void {
  queue.length = 0;
  queue.push(ou);
  stamp[ou] = tick;
  if (stamp[ov] !== tick) {
    stamp[ov] = tick;
    queue.push(ov);
  }
  const ux = pos[3 * u];
  const uy = pos[3 * u + 1];
  const uz = pos[3 * u + 2];
  extend(pos, u, v, ext, sph, P3, 3);
  const vx = P3[3];
  const vy = P3[4];
  const vz = P3[5];
  const mx = mid[3 * u];
  const my = mid[3 * u + 1];
  const mz = mid[3 * u + 2];
  for (let h = 0; h < queue.length; h++) {
    const c = queue[h];
    cellPos(mesh, c, P3, 0);
    const d = Math.min(segDist(P3[0], P3[1], P3[2], ux, uy, uz, mx, my, mz), segDist(P3[0], P3[1], P3[2], mx, my, mz, vx, vy, vz)) / spDist;
    if (d <= star[c] + rInf) nearStar(stars, c, ux, uy, uz, mx, my, mz, vx, vy, vz, rInf, spDist, tick, pstamp, out);
    if (d > star[c] + rInf + 1) continue;
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
      const j = mesh.adj[e];
      if (stamp[j] === tick) continue;
      stamp[j] = tick;
      queue.push(j);
    }
  }
}

// v 往 u 的反方向延长 ext 倍的 u–v（星球上放回球面），写进 out[o..o+2]
export function extend(pos: Float64Array, u: number, v: number, ext: number, sph: boolean, out: Float64Array, o: number): void {
  let x = pos[3 * v] + ext * (pos[3 * v] - pos[3 * u]);
  let y = pos[3 * v + 1] + ext * (pos[3 * v + 1] - pos[3 * u + 1]);
  let z = pos[3 * v + 2] + ext * (pos[3 * v + 2] - pos[3 * u + 2]);
  if (sph) {
    const l = Math.sqrt(x * x + y * y + z * z);
    x /= l;
    y /= l;
    z /= l;
  }
  out[o] = x;
  out[o + 1] = y;
  out[o + 2] = z;
}

// ---------- 画法（着色器里同一个算式：src/render/renderer.ts 的 FJORD_GLSL） ----------

// 一段带子在 p 处的海岸场：(d − r') · kw，r' = r(沿段插值) × wst × (1 + WOB × nd)；kw = SMAX / (EDGE × 一格的距离)
// 中线按 nd 往一侧挪 LAT × r（弯弯曲曲），宽窄按 2|nd| − WOB_C 变（WOB）；(nx, ny, nz)：这一点的法向（平面 (0, 0, 1)，星球是这一点自己）
export function fjordSegField(px: number, py: number, pz: number, nx: number, ny: number, nz: number, ax: number, ay: number, az: number, ar: number, bx: number, by: number, bz: number, br: number, wst: number, nd: number, kw: number): number {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const wx = px - ax;
  const wy = py - ay;
  const wz = pz - az;
  const uu = ux * ux + uy * uy + uz * uz;
  let t = uu > 0 ? (wx * ux + wy * uy + wz * uz) / uu : 0;
  t = Math.min(1, Math.max(0, t));
  const dx = wx - t * ux;
  const dy = wy - t * uy;
  const dz = wz - t * uz;
  let ex = ny * uz - nz * uy;
  let ey = nz * ux - nx * uz;
  let ez = nx * uy - ny * ux;
  const el = Math.sqrt(ex * ex + ey * ey + ez * ez);
  if (el > 0) {
    ex /= el;
    ey /= el;
    ez /= el;
  }
  const l = dx * ex + dy * ey + dz * ez;
  const rest = Math.max(0, dx * dx + dy * dy + dz * dz - l * l);
  const r0 = (ar + (br - ar) * t) * wst;
  const lo = l - FJ.LAT * r0 * nd;
  const d = Math.sqrt(lo * lo + rest);
  const rr = r0 * (1 + FJ.WOB * (2 * Math.abs(nd) - FJ.WOB_C));
  return (d - rr) * kw;
}
// 一段带子最远伸到半径的几倍（中线挪开、变宽都算上，细节噪声最大 0.9375）
export const FJ_REACH = 1 + FJ.LAT * 0.9375 + FJ.WOB * (2 * 0.9375 - FJ.WOB_C);

// 这一点所有段里最小的海岸场（没有段时 Infinity）；fjBest[0] 是最小的那一段的入海口（海格），fjBest[1] 是那一段的序号
export const fjBest = new Float64Array(2);
export function fjordField(tex: Float32Array, rank: number, px: number, py: number, pz: number, nx: number, ny: number, nz: number, wst: number, nd: number, kw: number): number {
  const off = tex[4 * rank];
  const cnt = tex[4 * rank + 1];
  let best = Infinity;
  let bi = -1;
  for (let k = 0; k < cnt; k++) {
    const o = 4 * (off + 3 * k);
    const f = fjordSegField(px, py, pz, nx, ny, nz, tex[o], tex[o + 1], tex[o + 2], tex[o + 3], tex[o + 4], tex[o + 5], tex[o + 6], tex[o + 7], wst, nd, kw);
    if (f < best) {
      best = f;
      bi = k;
    }
  }
  fjBest[0] = bi >= 0 ? tex[4 * (off + 3 * bi) + 8] : -1;
  fjBest[1] = bi;
  return best;
}

// fjordField 的下界（细节噪声取哪个值都不会更小）：到段的距离减去半径 × FJ_REACH。只看正负的捷径（描河）用
export function fjordFieldBound(tex: Float32Array, rank: number, px: number, py: number, pz: number, wst: number, kw: number): number {
  const off = tex[4 * rank];
  const cnt = tex[4 * rank + 1];
  let best = Infinity;
  for (let k = 0; k < cnt; k++) {
    const o = 4 * (off + 3 * k);
    const f = segBound(px, py, pz, tex[o], tex[o + 1], tex[o + 2], tex[o + 3], tex[o + 4], tex[o + 5], tex[o + 6], tex[o + 7], wst, kw);
    if (f < best) best = f;
  }
  return best;
}
function segBound(px: number, py: number, pz: number, ax: number, ay: number, az: number, ar: number, bx: number, by: number, bz: number, br: number, wst: number, kw: number): number {
  const ux = bx - ax;
  const uy = by - ay;
  const uz = bz - az;
  const wx = px - ax;
  const wy = py - ay;
  const wz = pz - az;
  const uu = ux * ux + uy * uy + uz * uz;
  let t = uu > 0 ? (wx * ux + wy * uy + wz * uz) / uu : 0;
  t = Math.min(1, Math.max(0, t));
  const dx = wx - t * ux;
  const dy = wy - t * uy;
  const dz = wz - t * uz;
  return (Math.sqrt(dx * dx + dy * dy + dz * dz) - (ar + (br - ar) * t) * wst * FJ_REACH) * kw - 1;
}

// kw：一格的距离单位下的陡度
export const fjordK = (spDist: number) => FJ.SMAX / (FJ.EDGE * spDist);
