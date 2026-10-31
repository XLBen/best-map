import { MinHeap } from './heap';
import { type Mesh, gradGeo, gradientAt } from './mesh';
import { type Noise2, type Noise3, fbm, fbm3, gradientNoise, gradientNoise3, mixSeed } from './rng';
import { tangentBasis, viewOf } from './sphere';

// ---------- 峡湾（第三十六轮） ----------
// 第三十四轮的峡湾是一排排一样长、一样斜的短槽（噪声的零线沿坡向拉长，深入约一格）。真的峡湾是被淹的冰川谷：
// 少而长（主峡湾深入几格）、分汊（支谷从两旁接进来）、顺着谷弯曲、间距不匀，岸外是一片岛礁。这里：
//   1. 谷网（新建时定、按生成器）：冰川海岸一带（coast-style 的峡湾权重往外推两圈后 > ZONE 的格，陆、海都算）每格撒 NPC 个点，
//      点与本格、邻格的点连成图（连线不贴近格心，最长 LINK 格与 LINK_KM 取小）；按“谷底高度”V（地壳高度 b0 + 坡度 + 噪声）
//      从这一带的边上往里漫（priority flood），每个点流向漫到它的那个点：一棵棵树（谷网），汇水多的是主谷。点沿主谷平滑，
//      每段的中点取 Catmull–Rom 曲线上的（画成两小段，弯一点）。谷网按块建（平面约 TILE_KM 见方，星球按单位球上的立方格子），
//      谷不过块的边：一块只取决于这一块与邻格的生成器分量、网格、种子；重新生成一片时只重建峡湾权重、地壳高度变了的格碰到的块，
//      结果与整张重建逐值相同。陆海改了谷网不变；
//   2. 哪一段淹成峡湾（按陆海，几千到一两万个点走一遍）：都按 km，与格多大无关。陆上的点流进海里的点时，入海口的预算是
//      LEN_KM × 权重 × 地点的倍数（低频噪声）× 汇水因子（汇水面积不到 ACC_MOUTH_KM2 的不淹），最多 LEN_CAP_KM（约 350 km）；
//      主湾往上游每走一段减去这段的长度；支湾每个峡湾最多 MAX_ARMS 条（离入海口近的先），汇水面积至少 ACC_SIDE_KM2、
//      与主湾的夹角至少 ARM_ANGLE 度，长度不过汇合处主湾剩下的 ARM_FRAC 倍。往上游跑偏（与地壳往上的方向夹角超过 DIR_MAX）
//      的段、离入海口 COAST_KM 以外贴着海岸走（离海不到 COAST_K × 走过的长度）的段不淹：峡湾往内陆走、不顺着海岸走，
//      一个峡湾只在离岸约 350 km 的一带里，再往里的段不进表。预算在一段中间用完时淹到那里为止（圆头的峡湾头、短短的支湾）。
//      半宽按 km（HW_KM，汇水大的宽，越往入海口越宽）；
//   3. 画法（着色器与 CPU 同一个算式，fjordSegField）：淹着的每一小段是一条带，半宽 r 从入海口往里先宽后窄；
//      海岸场取 min(s, (d' − r') · K)，K 很大（离带子 EDGE 格以内就涨到 SMAX），带子以外一点都不改；
//      d' 是中线按海岸细节的噪声往一侧挪了 LAT × r 以后的距离，r' = r × 格心的权重 ×（1 + WOB × (2|nd| − WOB_C)）：岸弯弯曲曲、宽窄有变化。
//      哪几段可能碰到一点：每格一张表，收“最后一个顶点是这一格”的画面三角形碰得到的淹着的段；着色器拿最后一个顶点的表号（flat），
//      CPU 按找到的三角形取同一格（subcell.ts 的 located.prov；整个星球接缝外的影子三角形按三格对回画面上的那个）。
//      表按陆海每次重建，只收陆上的段（海里的段刻了也没有用）。
// 纹理（RGBA32F，TEX_W 宽）：前 nRank 个 texel 是有表的格（rank 按格编号，不随陆海变，打包进海岸值纹理的 b）的表头
// （第一段的位置、段数、0、0）；之后每小段三个 texel：(端点 0, r0)、(端点 1, r1)、(入海口的海格, 0, 0, 0)。
// 平面世界的端点是地图坐标（z = 0），整个星球是单位球上的点（距离是弧度）

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
interface TileNet {
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

const sm01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// 0–1 的哈希
function hash01(seed: number, a: number, b: number, c: number): number {
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
function cellPos(mesh: Mesh, i: number, out: Float64Array, o: number): void {
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

const P3 = new Float64Array(6);
// 各段耗时（测速用，毫秒，累加）
export const fjLaps: Record<string, number> = {};
let lapT = 0;
function lap(name: string): void {
  const t = performance.now();
  fjLaps[name] = (fjLaps[name] ?? 0) + t - lapT;
  lapT = t;
}
const gOut = new Float64Array(2);

// 每格在哪一块（只看格心的位置）：平面按 TILE_KM 见方的格子，星球按单位球上 TILE_KM 的立方格子。按网格与比例尺缓存
const tileCache = new WeakMap<Mesh, { km: number; tile: Float64Array; cells: Map<number, Int32Array> }>();
// 每块的全部格（升序）
function tileInfo(mesh: Mesh, kmPerUnit: number): { tile: Float64Array; cells: Map<number, Int32Array> } {
  const c = tileCache.get(mesh);
  if (c && c.km === kmPerUnit) return c;
  const tile = new Float64Array(mesh.n);
  if (mesh.kind === 'sphere') {
    const s = kmPerUnit / Math.PI / FJ.TILE_KM;
    for (let i = 0; i < mesh.n; i++) {
      const ix = Math.floor(mesh.p[3 * i] * s) + 512;
      const iy = Math.floor(mesh.p[3 * i + 1] * s) + 512;
      const iz = Math.floor(mesh.p[3 * i + 2] * s) + 512;
      tile[i] = (ix * 1024 + iy) * 1024 + iz;
    }
  } else {
    const s = kmPerUnit / FJ.TILE_KM;
    for (let i = 0; i < mesh.n; i++) tile[i] = (Math.floor(mesh.x[i] * s) + 512) * 1024 + Math.floor(mesh.y[i] * s) + 512;
  }
  const lists = new Map<number, number[]>();
  for (let i = 0; i < mesh.n; i++) {
    let l = lists.get(tile[i]);
    if (!l) lists.set(tile[i], (l = []));
    l.push(i);
  }
  const cells = new Map<number, Int32Array>();
  for (const [k, l] of lists) cells.set(k, Int32Array.from(l));
  const out = { km: kmPerUnit, tile, cells };
  tileCache.set(mesh, out);
  return out;
}

// 一块里谷网一带的格（升序）
function zoneCellsOf(all: Int32Array, wz: Float32Array): Int32Array {
  let k = 0;
  for (let q = 0; q < all.length; q++) if (wz[all[q]] > FJ.ZONE) k++;
  const out = new Int32Array(k);
  k = 0;
  for (let q = 0; q < all.length; q++) if (wz[all[q]] > FJ.ZONE) out[k++] = all[q];
  return out;
}

// 建块、找碰得到的格时共用的缓冲（按网格）：local 是格在这一块里的编号（−1 不在，用完还原）
interface Scratch {
  local: Int32Array;
  mark: Int32Array;
  stamp: Int32Array;
  pstamp: Int32Array;
  tick: number;
}
const scratchCache = new WeakMap<Mesh, Scratch>();
function scratchOf(mesh: Mesh): Scratch {
  let s = scratchCache.get(mesh);
  if (!s) {
    s = { local: new Int32Array(mesh.n).fill(-1), mark: new Int32Array(mesh.n).fill(-1), stamp: new Int32Array(mesh.n), pstamp: new Int32Array(mesh.n), tick: 0 };
    scratchCache.set(mesh, s);
  }
  return s;
}

interface Ctx {
  mesh: Mesh;
  seed: number;
  sph: boolean;
  sp: number;
  spDist: number;
  kmCell: number;
  wz: Float32Array;
  b0: Float32Array;
  tile: Float64Array;
  geo: ReturnType<typeof gradGeo>;
}

// fj：每格的峡湾权重（coast-style 的 fjord）；b0：地壳高度；kmPerUnit：比例尺。没有一格在谷网里时 null。
// prev、dirty（重画一片）：只重建有 dirty 的格的块，别的块照用 prev 的（每块只取决于这一块与邻格的输入，结果与整个重建逐值相同）。
// dirty 要盖住峡湾权重变了的格往外三圈、地壳高度变了的格往外一圈（推两圈的一带、坡度、边上的点与邻格的权重）
export function buildFjordNet(mesh: Mesh, seed: number, kmPerUnit: number, fj: Float32Array, b0: Float32Array, prev: FjordNet | null = null, dirty: Uint8Array | null = null): FjordNet | null {
  const n = mesh.n;
  const sph = mesh.kind === 'sphere';
  const sp = mesh.spacing;
  const spDist = sph ? Math.PI * sp : sp;
  lapT = performance.now();
  // 谷网的一带：峡湾权重往外推两圈（每圈 × GROW），谷能伸进海里（入海口不被岸边一两格堵住）
  let wz: Float32Array;
  if (prev && dirty) {
    // 推两圈的权重只在 dirty 的格里重算（每格只取决于两圈以内的峡湾权重）
    wz = prev.wz.slice();
    for (let i = 0; i < n; i++) if (dirty[i]) wz[i] = grownAt(mesh, fj, i);
  } else wz = growZone(mesh, fj);
  const info = tileInfo(mesh, kmPerUnit);
  const tile = info.tile;
  // 要（重）建的块：整个重建时是全部的块；重画一片时是有 dirty 的格的块（谷网一带只在 dirty 的格里变，别的块的格不变）
  const old = new Map<number, TileNet>();
  if (prev) for (const t of prev.tiles) old.set(t.key, t);
  const redo = new Set<number>();
  if (prev && dirty) {
    for (let i = 0; i < n; i++) if (dirty[i]) redo.add(tile[i]);
  } else for (const k of info.cells.keys()) redo.add(k);
  const fresh = new Map<number, Int32Array>();
  for (const k of redo) {
    const z = zoneCellsOf(info.cells.get(k)!, wz);
    if (z.length) fresh.set(k, z);
  }
  // 要重建的块前后都不在谷网一带里：谷网不变（只换推两圈的权重，那些格都不到 ZONE；块、表号、碰得到的格都照用）
  if (prev && dirty && !fresh.size && !hasAny(old, redo)) {
    lap('grow');
    return { ...prev, wz };
  }
  const keySet = new Set<number>(fresh.keys());
  for (const k of old.keys()) if (!redo.has(k)) keySet.add(k);
  lap('grow');
  if (!keySet.size) return null;
  const keys = [...keySet].sort((a, b) => a - b);
  const ctx: Ctx = { mesh, seed, sph, sp, spDist, kmCell: sp * kmPerUnit, wz, b0, tile, geo: gradGeo(mesh) };
  const tiles: TileNet[] = [];
  for (const k of keys) {
    const z = fresh.get(k);
    tiles.push(z ? buildTile(ctx, k, z) : old.get(k)!);
  }
  lap('tiles');
  // 一带变了的格（只在 dirty 的格里）：有表的格只在它们附近重算（一个都没有时表号照用上一份）
  let flips: number[] | null = null;
  if (prev && dirty) {
    flips = [];
    for (let i = 0; i < n; i++) if (dirty[i] && wz[i] > FJ.ZONE !== prev.wz[i] > FJ.ZONE) flips.push(i);
  }
  const net = assemble(ctx, tiles, prev, flips);
  lap('assemble');
  return net;
}

function hasAny(m: Map<number, unknown>, keys: Set<number>): boolean {
  for (const k of keys) if (m.has(k)) return true;
  return false;
}

// 一块：撒点、连线、漫、汇水、平滑、中点、长度与预算、两个标记
function buildTile(ctx: Ctx, key: number, cells: Int32Array): TileNet {
  const { mesh, seed, sph, spDist, kmCell, tile } = ctx;
  const sc = scratchOf(mesh);
  const local = sc.local;
  for (let z = 0; z < cells.length; z++) local[cells[z]] = z;
  const NPC = FJ.NPC;
  const N = cells.length * NPC;
  const pos = new Float64Array(3 * N);
  const V = new Float64Array(N);
  const owner = new Int32Array(N);
  // 每格往上的方向（三维，每格的高差 m）
  const up = new Float64Array(3 * cells.length);
  const vn2 = sph ? null : gradientNoise(mixSeed(seed, 3602));
  const vn3 = sph ? gradientNoise3(mixSeed(seed, 3602)) : null;
  for (let z = 0; z < cells.length; z++) placeCell(ctx, cells[z], z, pos, V, owner, up, vn2, vn3);
  // 连线：本格与同一块里的邻格的点，LINK 格以内、离要看的格心都至少 CENTER_GAP 格
  const linkOff = new Int32Array(N + 1);
  const links: number[] = [];
  const per: number[][] = [];
  for (let k = 0; k < NPC; k++) per.push([]);
  const centers = new Float64Array(3 * 16);
  for (let z = 0; z < cells.length; z++) {
    const c = cells[z];
    for (let k = 0; k < NPC; k++) per[k].length = 0;
    for (let e = mesh.off[c] - 1; e < mesh.off[c + 1]; e++) {
      const j = e < mesh.off[c] ? c : mesh.adj[e];
      if (local[j] < 0 || tile[j] !== key) continue;
      const nc = linkCenters(mesh, c, j, sc.mark, centers);
      for (let k = 0; k < NPC; k++) addLinks(local, pos, z * NPC + k, j, centers, nc, spDist, kmCell, per[k]);
    }
    for (let k = 0; k < NPC; k++) {
      const u = z * NPC + k;
      for (const w of per[k]) links.push(w);
      linkOff[u + 1] = links.length;
    }
  }
  const link = Int32Array.from(links);
  // 从边上往里漫：有不在这一块谷网一带里的邻格的格的点先进堆，按谷底高度
  const recv = new Int32Array(N).fill(-1);
  const seen = new Uint8Array(N);
  const keyV = new Float64Array(N);
  const popOrder = new Int32Array(N);
  const heap = new MinHeap(N);
  for (let z = 0; z < cells.length; z++) {
    const c = cells[z];
    let edge = false;
    for (let e = mesh.off[c]; e < mesh.off[c + 1] && !edge; e++) {
      const j = mesh.adj[e];
      if (local[j] < 0 || tile[j] !== key) edge = true;
    }
    if (!edge) continue;
    for (let k = 0; k < NPC; k++) {
      const u = z * NPC + k;
      seen[u] = 1;
      keyV[u] = V[u];
      heap.push(u, V[u]);
    }
  }
  let popped = flood(heap, link, linkOff, V, keyV, seen, recv, popOrder, 0);
  for (let u = 0; u < N && popped < N; u++) {
    if (seen[u]) continue;
    let lo = u;
    for (let w = u; w < N; w++) if (!seen[w] && V[w] < V[lo]) lo = w;
    seen[lo] = 1;
    keyV[lo] = V[lo];
    heap.push(lo, V[lo]);
    popped = flood(heap, link, linkOff, V, keyV, seen, recv, popOrder, popped);
  }
  for (let z = 0; z < cells.length; z++) local[cells[z]] = -1;
  // 汇水、主支、谷里的点
  const acc = new Float32Array(N).fill(1);
  for (let q = N - 1; q >= 0; q--) {
    const u = popOrder[q];
    if (recv[u] >= 0) acc[recv[u]] += acc[u];
  }
  const main = new Int32Array(N).fill(-1);
  for (let q = 0; q < N; q++) {
    const u = popOrder[q];
    const v = recv[u];
    if (acc[u] < FJ.ACC_MIN || v < 0) continue;
    const m = main[v];
    if (m < 0 || acc[u] > acc[m] || (acc[u] === acc[m] && u < m)) main[v] = u;
  }
  const ord: number[] = [];
  for (let q = 0; q < N; q++) {
    const u = popOrder[q];
    if (acc[u] >= FJ.ACC_MIN) ord.push(u);
  }
  const order = Int32Array.from(ord);
  smoothNet(mesh, pos, owner, order, recv, main, sph, FJ.SMOOTH, spDist);
  const mid = midpoints(pos, order, recv, main, sph, N);
  const t: TileNet = {
    key,
    n: N,
    pos,
    mid,
    owner,
    recv,
    order,
    len: new Float32Array(N),
    lc: new Float32Array(N),
    lsea: new Float32Array(N),
    lcs: new Float32Array(N).fill(-1),
    hw: new Float32Array(N),
    isMain: new Uint8Array(N),
    dirOk: new Uint8Array(N),
    cands: new Array<Int32Array | null>(N).fill(null),
  };
  const ln2 = sph ? null : gradientNoise(mixSeed(seed, 3604));
  const ln3 = sph ? gradientNoise3(mixSeed(seed, 3604)) : null;
  for (let q = 0; q < order.length; q++) nodeBudget(ctx, t, cells, acc, main, up, order[q], ln2, ln3);
  return t;
}

// 撒点：格 c（块里第 z 格）的 NPC 个点，绕格心一圈（起始角随机、每个再抖一点），离格心 R0 + R1 × 随机 格；谷底高度；往上的方向
function placeCell(ctx: Ctx, c: number, z: number, pos: Float64Array, V: Float64Array, owner: Int32Array, up: Float64Array, vn2: Noise2 | null, vn3: Noise3 | null): void {
  const { mesh, seed, sph, sp, spDist, b0, geo } = ctx;
  const NPC = FJ.NPC;
  gradientAt(mesh, geo, b0, c, gOut);
  const gx = gOut[0];
  const gy = gOut[1];
  const slope = Math.hypot(gx, gy) * sp;
  const amp = FJ.V_NOISE * slope + FJ.V_NOISE0;
  const th0 = 2 * Math.PI * hash01(seed, 3601, c, 99);
  let ex = 1;
  let ey = 0;
  let ez = 0;
  let sx = 0;
  let sy = 1;
  let sz = 0;
  if (mesh.kind === 'sphere') [ex, ey, ez, sx, sy, sz] = tangentBasis(mesh.p[3 * c], mesh.p[3 * c + 1], mesh.p[3 * c + 2]);
  up[3 * z] = (gx * ex + gy * sx) * sp;
  up[3 * z + 1] = (gx * ey + gy * sy) * sp;
  up[3 * z + 2] = (gx * ez + gy * sz) * sp;
  for (let k = 0; k < NPC; k++) {
    const u = z * NPC + k;
    const th = th0 + (2 * Math.PI * (k + 0.6 * (hash01(seed, 3601, c, k) - 0.5))) / NPC;
    const rho = (FJ.R0 + FJ.R1 * hash01(seed, 3603, c, k)) * sp;
    const dx = rho * Math.cos(th);
    const dy = rho * Math.sin(th);
    let nz: number;
    if (mesh.kind === 'sphere') {
      let qx = mesh.p[3 * c] + Math.PI * (dx * ex + dy * sx);
      let qy = mesh.p[3 * c + 1] + Math.PI * (dx * ey + dy * sy);
      let qz = mesh.p[3 * c + 2] + Math.PI * (dx * ez + dy * sz);
      const l = Math.sqrt(qx * qx + qy * qy + qz * qz);
      qx /= l;
      qy /= l;
      qz /= l;
      pos[3 * u] = qx;
      pos[3 * u + 1] = qy;
      pos[3 * u + 2] = qz;
      nz = fbm3(vn3!, qx / spDist, qy / spDist, qz / spDist, FJ.V_FREQ, 2);
    } else {
      const x = mesh.x[c] + dx;
      const y = mesh.y[c] + dy;
      pos[3 * u] = x;
      pos[3 * u + 1] = y;
      pos[3 * u + 2] = 0;
      nz = fbm(vn2!, x / sp, y / sp, FJ.V_FREQ, 2);
    }
    V[u] = b0[c] + gx * dx + gy * dy + amp * nz;
    owner[u] = nearestOwner(mesh, c, pos, u);
  }
  void sph;
}

// 一个点的长度（km）、预算、半宽与两个标记
function nodeBudget(ctx: Ctx, t: TileNet, cells: Int32Array, acc: Float32Array, main: Int32Array, up: Float64Array, u: number, ln2: Noise2 | null, ln3: Noise3 | null): void {
  const { mesh, seed, sph, sp, spDist, kmCell, wz } = ctx;
  const { pos, recv } = t;
  const v = recv[u];
  const z = Math.floor(u / FJ.NPC);
  const c = cells[z];
  if (v >= 0) t.len[u] = (dist3(pos, u, v) / spDist) * kmCell;
  const x = pos[3 * u];
  const y = pos[3 * u + 1];
  const zz = pos[3 * u + 2];
  const m = Math.min(FJ.M_MAX, Math.max(FJ.M_MIN, FJ.LEN_M0 + FJ.LEN_M1 * (sph ? fbm3(ln3!, x / spDist, y / spDist, zz / spDist, FJ.LEN_FREQ, 2) : fbm(ln2!, x / sp, y / sp, FJ.LEN_FREQ, 2)) * 2));
  // 汇水按 km²（一个点约 0.866 格距² / NPC）：格多大都一样
  const area = acc[u] * ((0.866 * kmCell * kmCell) / FJ.NPC);
  const af = Math.sqrt(Math.min(1, area / FJ.ACC1_KM2));
  let wm = wz[c];
  for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) if (wz[mesh.adj[e]] > wm) wm = wz[mesh.adj[e]];
  t.lsea[u] = Math.min(FJ.LEN_CAP_KM, FJ.LEN_KM * wm * m);
  t.lc[u] = area < FJ.ACC_MOUTH_KM2 ? 0 : Math.min(FJ.LEN_CAP_KM, FJ.LEN_KM * wz[c] * m * af);
  t.hw[u] = (FJ.HW_KM * (FJ.HW_A + (1 - FJ.HW_A) * af)) / kmCell;
  if (v < 0) return;
  t.isMain[u] = main[v] === u ? 1 : 0;
  // 往上游的方向与往上的方向的夹角
  const dx = x - pos[3 * v];
  const dy = y - pos[3 * v + 1];
  const dz = zz - pos[3 * v + 2];
  const gl = Math.hypot(up[3 * z], up[3 * z + 1], up[3 * z + 2]);
  const dl = Math.hypot(dx, dy, dz);
  t.dirOk[u] = gl < FJ.DIR_FLAT_KM * kmCell || dx * up[3 * z] + dy * up[3 * z + 1] + dz * up[3 * z + 2] >= COS_DIR * gl * dl ? 1 : 0;
  // 支湾：汇水够、与汇合处往上游的主支夹角够大
  if (t.isMain[u] || area < FJ.ACC_SIDE_KM2) return;
  const mm = main[v];
  const mx = pos[3 * mm] - pos[3 * v];
  const my = pos[3 * mm + 1] - pos[3 * v + 1];
  const mz = pos[3 * mm + 2] - pos[3 * v + 2];
  const ml = Math.hypot(mx, my, mz);
  if (dx * mx + dy * my + dz * mz <= COS_ARM * dl * ml) t.lcs[u] = FJ.LEN_KM * wz[c] * m * af * (FJ.SIDE0 + FJ.SIDE1 * hash01(seed, 3605, c, u % FJ.NPC));
}
const COS_DIR = Math.cos((FJ.DIR_MAX * Math.PI) / 180);
const COS_ARM = Math.cos((FJ.ARM_ANGLE * Math.PI) / 180);

// 每段的中点（Catmull–Rom：(−P0 + 9 P1 + 9 P2 − P3) / 16，P0 是 u 的主支（没有时 u 往外延），P3 是 v 的下游（没有时 v 往外延））
function midpoints(pos: Float64Array, order: Int32Array, recv: Int32Array, main: Int32Array, sph: boolean, N: number): Float64Array {
  const mid = new Float64Array(3 * N);
  for (let q = 0; q < order.length; q++) {
    const u = order[q];
    const v = recv[u];
    if (v < 0) continue;
    const p0 = main[u];
    const p3 = recv[v];
    for (let k = 0; k < 3; k++) {
      const P1 = pos[3 * u + k];
      const P2 = pos[3 * v + k];
      const P0 = p0 >= 0 ? pos[3 * p0 + k] : 2 * P1 - P2;
      const Q3 = p3 >= 0 ? pos[3 * p3 + k] : 2 * P2 - P1;
      mid[3 * u + k] = (-P0 + 9 * P1 + 9 * P2 - Q3) / 16;
    }
    if (sph) {
      const l = Math.hypot(mid[3 * u], mid[3 * u + 1], mid[3 * u + 2]);
      mid[3 * u] /= l;
      mid[3 * u + 1] /= l;
      mid[3 * u + 2] /= l;
    }
  }
  return mid;
}

// 各块拼成一份：点的编号接起来；有表的格是谷网一带往外 RANK_RINGS 圈（两极附近 RANK_RINGS_POLAR 圈），按格编号排表号
function assemble(ctx: Ctx, tiles: TileNet[], prev: FjordNet | null, flips: number[] | null): FjordNet {
  const { mesh, wz } = ctx;
  const n = mesh.n;
  let N = 0;
  let No = 0;
  for (const t of tiles) {
    N += t.n;
    No += t.order.length;
  }
  const net: FjordNet = {
    tiles,
    n: N,
    pos: new Float64Array(3 * N),
    mid: new Float64Array(3 * N),
    owner: new Int32Array(N),
    recv: new Int32Array(N),
    order: new Int32Array(No),
    len: new Float32Array(N),
    lc: new Float32Array(N),
    lsea: new Float32Array(N),
    lcs: new Float32Array(N),
    hw: new Float32Array(N),
    isMain: new Uint8Array(N),
    dirOk: new Uint8Array(N),
    nodeTile: new Int32Array(N),
    nodeLocal: new Int32Array(N),
    cands: new Array<Int32Array | null>(N),
    rank: new Int32Array(0),
    nRank: 0,
    ring: new Int8Array(0),
    watch: new Int32Array(0),
    wz,
    spDist: ctx.spDist,
    kmCell: ctx.kmCell,
    sph: ctx.sph,
    mesh,
  };
  let off = 0;
  let oo = 0;
  for (let ti = 0; ti < tiles.length; ti++) {
    const t = tiles[ti];
    net.pos.set(t.pos, 3 * off);
    net.mid.set(t.mid, 3 * off);
    net.owner.set(t.owner, off);
    net.len.set(t.len, off);
    net.lc.set(t.lc, off);
    net.lsea.set(t.lsea, off);
    net.lcs.set(t.lcs, off);
    net.hw.set(t.hw, off);
    net.isMain.set(t.isMain, off);
    net.dirOk.set(t.dirOk, off);
    for (let u = 0; u < t.n; u++) {
      net.recv[off + u] = t.recv[u] >= 0 ? t.recv[u] + off : -1;
      net.nodeTile[off + u] = ti;
      net.nodeLocal[off + u] = u;
      net.cands[off + u] = t.cands[u];
    }
    for (let q = 0; q < t.order.length; q++) net.order[oo++] = t.order[q] + off;
    off += t.n;
  }
  // 有表的格：整个重建时从头数；重画一片时一带一格都没变就照用上一份，不然只在变了的格附近重算圈数（ringsNear）
  if (prev && flips && !flips.length) {
    net.ring = prev.ring;
    net.rank = prev.rank;
    net.nRank = prev.nRank;
  } else {
    let same = false;
    if (prev && flips) {
      net.ring = prev.ring.slice();
      same = ringsNear(mesh, wz, net.ring, flips);
    } else {
      net.ring = new Int8Array(n).fill(-1);
      ringsAll(mesh, wz, net.ring);
    }
    if (same) {
      // 有表的格还是那些（只是圈数变了）：表号照用
      net.rank = prev!.rank;
      net.nRank = prev!.nRank;
    } else {
      net.rank = new Int32Array(n).fill(-1);
      let k = 0;
      for (let i = 0; i < n; i++) if (net.ring[i] >= 0) net.rank[i] = k++;
      net.nRank = k;
    }
  }
  // 陆海只看这些格：谷里的点所在的格与它们两圈以内的格（离海多远看两圈）
  const watchSet = new Uint8Array(n);
  const watch: number[] = [];
  for (let q = 0; q < net.order.length; q++) {
    const o = net.owner[net.order[q]];
    if (watchSet[o]) continue;
    watchSet[o] = 1;
    watch.push(o);
  }
  ringsOut(mesh, watch, 2, watchSet);
  net.watch = Int32Array.from(watch);
  return net;
}

// 每格离谷网一带几圈（ring 先全是 −1）：一带往外 RANK_RINGS 圈，两极附近的格往外推到 RANK_RINGS_POLAR 圈
function ringsAll(mesh: Mesh, wz: Float32Array, ring: Int8Array): void {
  let front: number[] = [];
  for (let i = 0; i < mesh.n; i++) {
    if (!(wz[i] > FJ.ZONE)) continue;
    ring[i] = 0;
    front.push(i);
  }
  for (let r = 1; r <= FJ.RANK_RINGS_POLAR && front.length; r++) {
    const next: number[] = [];
    for (const c of front) {
      if (r > FJ.RANK_RINGS && !polarCell(mesh, c)) continue;
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
        const j = mesh.adj[e];
        if (ring[j] >= 0) continue;
        ring[j] = r;
        next.push(j);
      }
    }
    front = next;
  }
}

// 一带只在 flips 这几格变了：一格离一带几圈只看它 RANK_RINGS_POLAR 圈以内的格，所以只有离 flips 这么多圈以内的格（A）可能变。
// A 里重算：A 里一带的格是 0；A 外挨着 A 的有表的格按原来的圈数往 A 里推（同 ringsAll，按圈数从小到大）。
// 返回有表的格是不是还是那些
function ringsNear(mesh: Mesh, wz: Float32Array, ring: Int8Array, flips: number[]): boolean {
  const inA = new Uint8Array(mesh.n);
  const A = flips.slice();
  for (const c of A) inA[c] = 1;
  ringsOut(mesh, A, FJ.RANK_RINGS_POLAR, inA);
  const R = FJ.RANK_RINGS_POLAR;
  const buckets: number[][] = [];
  for (let r = 0; r <= R; r++) buckets.push([]);
  const had = new Uint8Array(A.length);
  for (let q = 0; q < A.length; q++) {
    const c = A[q];
    had[q] = ring[c] >= 0 ? 1 : 0;
    ring[c] = wz[c] > FJ.ZONE ? 0 : -1;
  }
  const seen = new Uint8Array(mesh.n);
  for (const c of A) {
    if (ring[c] === 0) buckets[0].push(c);
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
      const j = mesh.adj[e];
      if (inA[j] || seen[j] || ring[j] < 0) continue;
      seen[j] = 1;
      buckets[ring[j]].push(j);
    }
  }
  for (let r = 0; r < R; r++) {
    const b = buckets[r];
    for (let q = 0; q < b.length; q++) {
      const c = b[q];
      if (r >= FJ.RANK_RINGS && !polarCell(mesh, c)) continue;
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
        const j = mesh.adj[e];
        if (!inA[j] || ring[j] >= 0) continue;
        ring[j] = r + 1;
        buckets[r + 1].push(j);
      }
    }
  }
  for (let q = 0; q < A.length; q++) if ((ring[A[q]] >= 0 ? 1 : 0) !== had[q]) return false;
  return true;
}

// list 里的格往外 rings 圈加进 list（mark 标着已在的）
function ringsOut(mesh: Mesh, list: number[], rings: number, mark: Uint8Array): void {
  let from = 0;
  for (let r = 0; r < rings; r++) {
    const to = list.length;
    for (let q = from; q < to; q++) {
      const c = list[q];
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
        const j = mesh.adj[e];
        if (mark[j]) continue;
        mark[j] = 1;
        list.push(j);
      }
    }
    from = to;
  }
}

function polarCell(mesh: Mesh, c: number): boolean {
  return mesh.kind === 'sphere' && Math.abs(mesh.p[3 * c + 2]) > 0.95;
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

// 一格推两圈后的权重：两圈以内 GROW^圈数 × 峡湾权重的最大（与 growZone 推两遍相同）
function grownAt(mesh: Mesh, fj: Float32Array, i: number): number {
  let m = fj[i];
  for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
    const j = mesh.adj[e];
    // 与推两遍（每遍存成 float32）逐位相同
    const a = Math.fround(FJ.GROW * fj[j]);
    if (a > m) m = a;
    for (let f = mesh.off[j]; f < mesh.off[j + 1]; f++) {
      const b = Math.fround(FJ.GROW * Math.fround(FJ.GROW * fj[mesh.adj[f]]));
      if (b > m) m = b;
    }
  }
  return m;
}

// 峡湾权重往外推 GROW_RINGS 圈，每圈乘 GROW
export function growZone(mesh: Mesh, fj: Float32Array): Float32Array {
  let cur = Float32Array.from(fj);
  for (let r = 0; r < FJ.GROW_RINGS; r++) {
    const next = cur.slice();
    for (let i = 0; i < mesh.n; i++) {
      let m = 0;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (cur[mesh.adj[e]] > m) m = cur[mesh.adj[e]];
      if (FJ.GROW * m > next[i]) next[i] = FJ.GROW * m;
    }
    cur = next;
  }
  return cur;
}

// 点 u 所在的格：生成它的格 c 与 c 的邻格里离它最近的
function nearestOwner(mesh: Mesh, c: number, pos: Float64Array, u: number): number {
  let best = c;
  cellPos(mesh, c, P3, 0);
  let bd = d2(pos, u, P3);
  for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
    const j = mesh.adj[e];
    cellPos(mesh, j, P3, 0);
    const d = d2(pos, u, P3);
    if (d < bd) {
      bd = d;
      best = j;
    }
  }
  return best;
}

function d2(pos: Float64Array, u: number, p: Float64Array): number {
  const dx = pos[3 * u] - p[0];
  const dy = pos[3 * u + 1] - p[1];
  const dz = pos[3 * u + 2] - p[2];
  return dx * dx + dy * dy + dz * dz;
}

function dist3(pos: Float64Array, u: number, v: number): number {
  const dx = pos[3 * u] - pos[3 * v];
  const dy = pos[3 * u + 1] - pos[3 * v + 1];
  const dz = pos[3 * u + 2] - pos[3 * v + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// 格 c、j 的点相连时要看的格心，写进 out，返回个数：c、j，j ≠ c 时加上两格共同的邻格
function linkCenters(mesh: Mesh, c: number, j: number, mark: Int32Array, out: Float64Array): number {
  let n = 0;
  cellPos(mesh, c, out, 0);
  n++;
  if (j === c) return n;
  cellPos(mesh, j, out, 3);
  n++;
  for (let e = mesh.off[j]; e < mesh.off[j + 1]; e++) mark[mesh.adj[e]] = j;
  for (let e = mesh.off[c]; e < mesh.off[c + 1] && n < 16; e++) {
    const k = mesh.adj[e];
    if (mark[k] === j) {
      cellPos(mesh, k, out, 3 * n);
      n++;
    }
  }
  return n;
}

// 点 u 与格 j 的各点相连：LINK 格以内、连线离要看的格心都至少 CENTER_GAP 格（格心附近不刻：styleWeight）
function addLinks(local: Int32Array, pos: Float64Array, u: number, j: number, centers: Float64Array, nc: number, spDist: number, kmCell: number, out: number[]): void {
  const base = local[j] * FJ.NPC;
  const lim = Math.min(FJ.LINK, FJ.LINK_KM / kmCell) * spDist;
  const gap = FJ.CENTER_GAP * spDist;
  const ux = pos[3 * u];
  const uy = pos[3 * u + 1];
  const uz = pos[3 * u + 2];
  for (let k = 0; k < FJ.NPC; k++) {
    const w = base + k;
    if (w === u) continue;
    if (dist3(pos, u, w) > lim) continue;
    const wx = pos[3 * w];
    const wy = pos[3 * w + 1];
    const wz = pos[3 * w + 2];
    let ok = true;
    for (let q = 0; q < nc && ok; q++) if (segDist(centers[3 * q], centers[3 * q + 1], centers[3 * q + 2], ux, uy, uz, wx, wy, wz) < gap) ok = false;
    if (ok) out.push(w);
  }
}

// 线段 u–w 离这几格的格心不到 CENTER_GAP 格
function nearCenter(mesh: Mesh, a: number, b: number, c: number, pos: Float64Array, u: number, w: number, spDist: number): boolean {
  const gap = FJ.CENTER_GAP * spDist;
  const ux = pos[3 * u];
  const uy = pos[3 * u + 1];
  const uz = pos[3 * u + 2];
  const wx = pos[3 * w];
  const wy = pos[3 * w + 1];
  const wz = pos[3 * w + 2];
  cellPos(mesh, a, P3, 0);
  if (segDist(P3[0], P3[1], P3[2], ux, uy, uz, wx, wy, wz) < gap) return true;
  cellPos(mesh, b, P3, 0);
  if (segDist(P3[0], P3[1], P3[2], ux, uy, uz, wx, wy, wz) < gap) return true;
  cellPos(mesh, c, P3, 0);
  return segDist(P3[0], P3[1], P3[2], ux, uy, uz, wx, wy, wz) < gap;
}

// 漫：弹出最低的，没到过的相邻点流向它（键至少比它高一点，平处也有方向）
function flood(heap: MinHeap, link: Int32Array, linkOff: Int32Array, V: Float64Array, key: Float64Array, seen: Uint8Array, recv: Int32Array, popOrder: Int32Array, popped: number): number {
  while (heap.size > 0) {
    const u = heap.pop();
    popOrder[popped++] = u;
    const ku = key[u];
    for (let e = linkOff[u]; e < linkOff[u + 1]; e++) {
      const w = link[e];
      if (seen[w]) continue;
      seen[w] = 1;
      recv[w] = u;
      const kw = V[w] > ku + 1e-3 ? V[w] : ku + 1e-3;
      key[w] = kw;
      heap.push(w, kw);
    }
  }
  return popped;
}

// 沿主谷平滑：有下游、有主支的点挪向两者的中点（一半），几遍；挪了以后连着它的两段离格心太近的不挪
function smoothNet(mesh: Mesh, pos: Float64Array, owner: Int32Array, order: Int32Array, recv: Int32Array, main: Int32Array, sph: boolean, passes: number, spDist: number): void {
  const tmp = new Float64Array(pos.length);
  for (let p = 0; p < passes; p++) {
    tmp.set(pos);
    for (let q = 0; q < order.length; q++) {
      const u = order[q];
      const v = recv[u];
      const m = main[u];
      if (v < 0 || m < 0) continue;
      let x = 0.5 * tmp[3 * u] + 0.25 * (tmp[3 * v] + tmp[3 * m]);
      let y = 0.5 * tmp[3 * u + 1] + 0.25 * (tmp[3 * v + 1] + tmp[3 * m + 1]);
      let z = 0.5 * tmp[3 * u + 2] + 0.25 * (tmp[3 * v + 2] + tmp[3 * m + 2]);
      if (sph) {
        const l = Math.sqrt(x * x + y * y + z * z);
        x /= l;
        y /= l;
        z /= l;
      }
      pos[3 * u] = x;
      pos[3 * u + 1] = y;
      pos[3 * u + 2] = z;
      if (nearCenter(mesh, owner[u], owner[v], owner[m], pos, u, v, spDist) || nearCenter(mesh, owner[u], owner[v], owner[m], pos, u, m, spDist)) {
        pos[3 * u] = tmp[3 * u];
        pos[3 * u + 1] = tmp[3 * u + 1];
        pos[3 * u + 2] = tmp[3 * u + 2];
      }
    }
  }
}

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
function extend(pos: Float64Array, u: number, v: number, ext: number, sph: boolean, out: Float64Array, o: number): void {
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

// ---------- 按陆海：哪一段淹成峡湾 ----------
// tex：着色器的峡湾纹理（RGBA，每 texel 四个数）；sig：每格的表的摘要（描河记下的查询按它验，没有表时 0）
export interface FjordLayer {
  tex: Float32Array;
  sig: Float64Array;
}

const TEX_W = 1024;

// land：每格的陆海（湖面算陆地）。按 net.order 从下游往上游走一遍
export function fjordLayer(net: FjordNet, land: ArrayLike<number>, nCells: number): FjordLayer {
  const N = net.n;
  const w = budgets(net, land);
  // 每格的段数（每段两小段）
  const count = new Int32Array(net.nRank);
  const wet = new Uint8Array(N);
  let entries = 0;
  for (let q = 0; q < net.order.length; q++) {
    const u = net.order[q];
    if (!wetEdge(net, land, w, u)) continue;
    wet[u] = 1;
    const cs = candOf(net, u);
    for (let k = 0; k < cs.length; k++) {
      const rk = net.rank[cs[k]];
      if (rk >= 0 && count[rk] + 2 <= FJ.MAX_LIST) {
        count[rk] += 2;
        entries += 2;
      }
    }
  }
  const texels = net.nRank + 3 * entries;
  const rows = Math.max(1, Math.ceil(texels / TEX_W));
  const tex = new Float32Array(rows * TEX_W * 4);
  const fill = new Int32Array(net.nRank);
  let at = net.nRank;
  for (let rk = 0; rk < net.nRank; rk++) {
    tex[4 * rk] = at;
    tex[4 * rk + 1] = count[rk];
    at += 3 * count[rk];
  }
  for (let q = 0; q < net.order.length; q++) {
    const u = net.order[q];
    if (!wet[u]) continue;
    const cs = net.cands[u]!;
    for (let k = 0; k < cs.length; k++) {
      const rk = net.rank[cs[k]];
      if (rk < 0 || fill[rk] >= count[rk]) continue;
      const o = 4 * (tex[4 * rk] + 3 * fill[rk]);
      fill[rk] += 2;
      writeEntry(net, land, w, u, tex, o);
    }
  }
  // 每格的表的摘要（FNV，按位）
  const sig = new Float64Array(nCells);
  const bits = new Uint32Array(tex.buffer);
  for (let c = 0; c < nCells; c++) {
    const rk = net.rank[c];
    if (rk < 0 || count[rk] === 0) continue;
    const o = 4 * tex[4 * rk];
    let h = 0x811c9dc5 ^ count[rk];
    for (let k = 0; k < 12 * count[rk]; k++) h = Math.imul(h ^ bits[o + k], 0x01000193);
    sig[c] = (h >>> 0) + 1;
  }
  return { tex, sig };
}

// 按陆海走一遍的结果：B 预算（km，> 0 淹着）、r 半径（距离单位）、mouth 入海口的海格、cap 这一段用的上限（km：入海口的、支湾的，
// 主湾 Infinity，不淹 0）、sys 属于哪个峡湾（入海口那个点）、path 从入海口往上游走过的长度（km）、arms 每个峡湾的支湾数
export interface FjordWet {
  B: Float32Array;
  r: Float32Array;
  mouth: Int32Array;
  cap: Float32Array;
  sys: Int32Array;
  path: Float32Array;
  arms: Int32Array;
}

// 预算：海里的点 lsea；陆上的点流进海里时按入海口的上限（lc），主湾往上游一路减下去，支湾（每个峡湾最多 MAX_ARMS 条，离入海口近的先）
// 不过汇合处主湾剩下的 ARM_FRAC 倍与自己的上限；往上游跑偏的段不淹。半径按预算先宽后窄
export function budgets(net: FjordNet, land: ArrayLike<number>): FjordWet {
  const N = net.n;
  const w: FjordWet = { B: new Float32Array(N).fill(-1), r: new Float32Array(N), mouth: new Int32Array(N).fill(-1), cap: new Float32Array(N), sys: new Int32Array(N).fill(-1), path: new Float32Array(N), arms: new Int32Array(N) };
  const { order } = net;
  for (let q = 0; q < order.length; q++) budgetAt(net, land, w, order[q]);
  return w;
}

function budgetAt(net: FjordNet, land: ArrayLike<number>, w: FjordWet, u: number): void {
  const { recv, owner, len, lc, lcs, lsea, hw, spDist, isMain, dirOk } = net;
  const { B } = w;
  const o = owner[u];
  if (!land[o]) {
    B[u] = lsea[u];
    w.r[u] = hw[u] * FJ.SEA_W * spDist;
    w.mouth[u] = o;
    return;
  }
  const v = recv[u];
  if (v < 0 || B[v] <= 0) return;
  let cap = 0;
  let sys = w.sys[v];
  if (!land[owner[v]]) {
    cap = lc[u];
    sys = u;
  } else if (isMain[u]) cap = Infinity;
  else if (lcs[u] > 0 && w.arms[sys] < FJ.MAX_ARMS) {
    cap = Math.min(lcs[u], FJ.ARM_FRAC * B[v]);
    if (Math.min(B[v], cap) > FJ.STUB_MIN * len[u]) w.arms[sys]++;
    else cap = 0;
  }
  if (!dirOk[u]) cap = 0;
  // 离入海口 COAST_KM 以外，离海（附近两圈里海格的格心）不到 COAST_K × 走过的长度的不淹：峡湾往内陆走，不顺着海岸走
  else if (cap > 0 && land[owner[v]]) {
    const p = w.path[v] + len[u];
    if (p > FJ.COAST_KM && seaDistKm(net, land, o, u, FJ.COAST_K * p) < FJ.COAST_K * p) cap = 0;
  }
  w.cap[u] = cap;
  w.sys[u] = sys;
  const b = Math.min(B[v], cap) - len[u];
  B[u] = b;
  if (b <= 0) return;
  w.r[u] = hw[u] * (FJ.TAPER_MIN + (1 - FJ.TAPER_MIN) * sm01(b / FJ.TAPER_KM)) * (FJ.WIDEN0 + FJ.WIDEN1 * Math.min(1, b / FJ.WIDEN_KM)) * spDist;
  w.mouth[u] = w.mouth[v];
  w.path[u] = (land[owner[v]] ? w.path[v] : 0) + len[u];
}

// 点 u 到格 c 与它两圈以内的海格的格心最近的距离（km）；找到比 enough 还近的就停
function seaDistKm(net: FjordNet, land: ArrayLike<number>, c: number, u: number, enough: number): number {
  const { mesh, pos, spDist, kmCell } = net;
  let best = Infinity;
  for (let e = mesh.off[c] - 1; e < mesh.off[c + 1] && best >= enough; e++) {
    const j = e < mesh.off[c] ? c : mesh.adj[e];
    for (let f = mesh.off[j] - 1; f < mesh.off[j + 1]; f++) {
      const k = f < mesh.off[j] ? j : mesh.adj[f];
      if (land[k]) continue;
      cellPos(mesh, k, P3, 0);
      const d = (Math.hypot(pos[3 * u] - P3[0], pos[3 * u + 1] - P3[1], pos[3 * u + 2] - P3[2]) / spDist) * kmCell;
      if (d < best) best = d;
    }
  }
  return best;
}

// 段 u → recv[u] 画不画：u 是陆上的点，且 u 淹着，或 recv[u] 淹着、这一段有上限且预算在这段中间用完（剩下的够 STUB_MIN）
function wetEdge(net: FjordNet, land: ArrayLike<number>, w: FjordWet, u: number): boolean {
  const v = net.recv[u];
  if (v < 0) return false;
  // 海里的点往下游的段不画（刻海面没有用；入海口那一段往海里延长了，穿过岸外的岛礁）
  if (!land[net.owner[u]]) return false;
  if (w.B[u] > 0) return true;
  if (w.B[v] <= 0 || w.cap[u] <= 0) return false;
  return stubOf(net, w, u, v) > FJ.STUB_MIN;
}

// 预算在段 u → v 中间用完时淹到的比例
function stubOf(net: FjordNet, w: FjordWet, u: number, v: number): number {
  return Math.min(w.B[v], w.cap[u]) / net.len[u];
}

// 一个个峡湾（统计用：tools/realism.ts 的 fjordStats）：入海口那个点、最长的一条往上游的长度（km，含头上淹到一半的）、支湾数
export function fjordSystems(net: FjordNet, land: ArrayLike<number>): { mouth: number; lengthKm: number; arms: number }[] {
  const w = budgets(net, land);
  const longest = new Map<number, number>();
  for (const u of net.order) {
    const s = w.sys[u];
    if (s < 0 || !land[net.owner[u]]) continue;
    const v = net.recv[u];
    let L = -1;
    if (w.B[u] > 0) L = w.path[u];
    else if (v >= 0 && w.B[v] > 0 && w.cap[u] > 0 && stubOf(net, w, u, v) > FJ.STUB_MIN) L = (land[net.owner[v]] ? w.path[v] : 0) + Math.min(w.B[v], w.cap[u]);
    if (L > (longest.get(s) ?? -1)) longest.set(s, L);
  }
  return [...longest.entries()].sort((a, b) => a[0] - b[0]).map(([m, L]) => ({ mouth: m, lengthKm: L, arms: w.arms[m] }));
}

// 一段写成两小段（中点在 Catmull–Rom 曲线上，弯一点）：下游那头 A → 中点 M → 上游那头 U
function writeEntry(net: FjordNet, land: ArrayLike<number>, w: FjordWet, u: number, tex: Float32Array, o: number): void {
  const { pos, recv, mid } = net;
  const { B, r } = w;
  const v = recv[u];
  // 上游那头（u，没淹到时只到预算用完的地方，圆头）
  let t = 1;
  let ru = r[u];
  if (B[u] <= 0) {
    t = Math.min(1, stubOf(net, w, u, v));
    ru = FJ.HEAD * r[v];
  }
  // 陆上的点流进海里的点：下游那头往海里延长 MOUTH 格（海里的点所在的格是海，那一点却可能还画成陆地：峡湾一直通到水面）
  if (B[u] > 0 && !land[net.owner[v]]) extend(pos, u, v, Math.min((FJ.MOUTH * net.kmCell) / Math.max(net.len[u], 1e-6), 4), net.sph, P3, 0);
  else {
    P3[0] = pos[3 * v];
    P3[1] = pos[3 * v + 1];
    P3[2] = pos[3 * v + 2];
  }
  // 头上（U）与中点（M）都在 v → 中点 → u 的折线上（没淹到时按比例 t 走到半路；与“碰得到哪几格”量的是同一条折线）
  let ux = pos[3 * u];
  let uy = pos[3 * u + 1];
  let uz = pos[3 * u + 2];
  let mx = mid[3 * u];
  let my = mid[3 * u + 1];
  let mz = mid[3 * u + 2];
  if (t < 1) {
    if (t <= 0.5) {
      const f = 2 * t;
      ux = pos[3 * v] + f * (mx - pos[3 * v]);
      uy = pos[3 * v + 1] + f * (my - pos[3 * v + 1]);
      uz = pos[3 * v + 2] + f * (mz - pos[3 * v + 2]);
      mx = 0.5 * (pos[3 * v] + ux);
      my = 0.5 * (pos[3 * v + 1] + uy);
      mz = 0.5 * (pos[3 * v + 2] + uz);
    } else {
      const f = 2 * t - 1;
      ux = mx + f * (ux - mx);
      uy = my + f * (uy - my);
      uz = mz + f * (uz - mz);
    }
  }
  const rm = 0.5 * (r[v] + ru);
  const m = w.mouth[v];
  tex[o] = P3[0];
  tex[o + 1] = P3[1];
  tex[o + 2] = P3[2];
  tex[o + 3] = r[v];
  tex[o + 4] = mx;
  tex[o + 5] = my;
  tex[o + 6] = mz;
  tex[o + 7] = rm;
  tex[o + 8] = m;
  tex[o + 12] = mx;
  tex[o + 13] = my;
  tex[o + 14] = mz;
  tex[o + 15] = rm;
  tex[o + 16] = ux;
  tex[o + 17] = uy;
  tex[o + 18] = uz;
  tex[o + 19] = ru;
  tex[o + 20] = m;
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
