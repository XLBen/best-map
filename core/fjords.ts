import { MinHeap } from './heap';
import { type Mesh, gradGeo, gradientAt } from './mesh';
import { fbm, fbm3, gradientNoise, gradientNoise3, mixSeed } from './rng';
import { tangentBasis, viewOf } from './sphere';

// ---------- 峡湾（第三十六轮） ----------
// 第三十四轮的峡湾是一排排一样长、一样斜的短槽（噪声的零线沿坡向拉长，深入约一格）。真的峡湾是被淹的冰川谷：
// 少而长（主峡湾深入几格）、分汊（支谷从两旁接进来）、顺着谷弯曲、间距不匀，岸外是一片岛礁。这里：
//   1. 谷网（新建时定、按生成器）：冰川海岸一带（coast-style 的峡湾权重往外推两圈后 > ZONE 的格，陆、海都算）每格撒 NPC 个点，
//      点与本格、邻格的点连成图（连线不贴近格心）；按“谷底高度”V（地壳高度 b0 + 坡度 + 每格一两个起伏的噪声）从这一带的边上往里漫
//      （priority flood），每个点流向漫到它的那个点：一棵棵树（谷网），汇水多的是主谷，支谷从两旁接进来。点沿主谷平滑几遍，
//      每段的中点取 Catmull–Rom 曲线上的（画成两小段，弯一点）。只取决于网格、种子、生成器的分量与新建时的纬度，陆海改了谷网不变；
//   2. 哪一段淹成峡湾（按陆海，谷里的点所在的格的陆海变了才重算，几千到一两万个点走一遍）：陆上的点流进海里的点时，
//      入海口的预算是 LEN × 权重 × 地点的倍数（低频噪声：有的地方长、有的地方短）× 汇水因子（汇水不到 ACC_MOUTH 个点的不淹），
//      最多 LEN_CAP 格；往上游每走一段减去这段的长度，主谷一路减下去，支谷再与自己的上限（汇水不到 ACC_SIDE 的没有）取小。
//      预算还是正的点淹着，淹着的点的下游一定淹着（连着海）；预算在一段中间用完时淹到那里为止（圆头的峡湾头、短短的支湾）；
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
  // 两点相连的最长距离（格）、连线离两头的格心至少多远（格）
  LINK: 0.9,
  CENTER_GAP: 0.2,
  // 谷底高度的噪声：频率（每格）、幅度（地壳高度每格的变化 × V_NOISE + V_NOISE0 m）
  V_FREQ: 0.6,
  V_NOISE: 0.9,
  V_NOISE0: 60,
  // 汇水（点数）至少 ACC_MIN 才算谷；ACC1 个点时长度、宽度的汇水因子（√(汇水 / ACC1)）满
  ACC_MIN: 2,
  ACC1: 20,
  // 支谷汇水不到 ACC_SIDE 个点的不淹（不然满是一根根小刺）；直接流进海里的谷汇水不到 ACC_MOUTH 个点的不淹（一个个小缺口）
  ACC_SIDE: 8,
  ACC_MOUTH: 8,
  // 入海口的预算：LEN 格 × 权重 × 地点的倍数（LEN_M0 + 2 × LEN_M1 × 噪声，噪声频率 LEN_FREQ 每格，夹在 M_MIN 到 M_MAX）× 汇水因子，
  // 最多 LEN_CAP 格
  LEN: 9,
  LEN_M0: 0.85,
  LEN_M1: 0.75,
  LEN_FREQ: 0.25,
  M_MIN: 0.35,
  M_MAX: 1.2,
  LEN_CAP: 7,
  // 支谷的上限再乘 SIDE0 + SIDE1 × 随机
  SIDE0: 0.3,
  SIDE1: 0.45,
  // 半宽（格）：HW × (HW_A + (1 − HW_A) × 汇水因子)；离头 TAPER 格以内收窄到 TAPER_MIN；海里的点 × SEA_W；
  // 越往外（预算越多）越宽：× (WIDEN0 + WIDEN1 × min(1, 预算 / LEN))
  HW: 0.065,
  HW_A: 0.5,
  TAPER: 0.8,
  TAPER_MIN: 0.65,
  // 入海口往海里延长 MOUTH 格
  MOUTH: 0.4,
  // 沿主谷平滑几遍
  SMOOTH: 4,
  // 预算在一段中间用完时，头上的半径是下游那头的 HEAD 倍（圆头）
  HEAD: 0.6,
  WIDEN0: 0.75,
  WIDEN1: 0.6,
  SEA_W: 1.4,
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

// 谷网（只取决于网格、种子、生成器的分量与新建时的纬度）
export interface FjordNet {
  // 点数（含不在谷里的）
  n: number;
  // 平滑后的位置（平面 z = 0；星球单位向量）
  pos: Float64Array;
  // 每段（u → recv[u]）的中点：Catmull–Rom 曲线上（上游接主支、下游接下游的下游）
  mid: Float64Array;
  // 所在的格（判海、陆）
  owner: Int32Array;
  // 下游的点（−1：出口）
  recv: Int32Array;
  // 谷里的点，从下游到上游（漫的先后）
  order: Int32Array;
  // 到下游的点的长度（格）
  len: Float32Array;
  // 自己的上限（格；下游是陆上的点、自己是支谷时用 lcs）、海里的预算（格）、半宽（格）
  lc: Float32Array;
  lcs: Float32Array;
  lsea: Float32Array;
  hw: Float32Array;
  // 每段（上游的点 u → recv[u]）碰得到的格（CSR，按 u 编号）
  candOff: Int32Array;
  cand: Int32Array;
  // 每格的表号（−1 没有）、有表的格数
  rank: Int32Array;
  nRank: number;
  // 谷里的点所在的格（陆海只看这些格）
  watch: Int32Array;
  // 往外推了两圈的峡湾权重（谷网的一带）
  wz: Float32Array;
  // 一格的距离单位（平面：格距；星球：π × 格距 弧度）
  spDist: number;
  sph: boolean;
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

// fj：每格的峡湾权重（coast-style 的 fjord）；b0：地壳高度。没有一格在谷网里时 null
export function buildFjordNet(mesh: Mesh, seed: number, fj: Float32Array, b0: Float32Array): FjordNet | null {
  const n = mesh.n;
  const sph = mesh.kind === 'sphere';
  const sp = mesh.spacing;
  const spDist = sph ? Math.PI * sp : sp;
  // 谷网的一带：峡湾权重往外推两圈（每圈 × GROW），谷能伸进海里（入海口不被岸边一两格堵住）
  lapT = performance.now();
  const wz = growZone(mesh, fj);
  lap('grow');
  const zoneIdx = new Int32Array(n).fill(-1);
  const zone: number[] = [];
  for (let i = 0; i < n; i++) {
    if (wz[i] > FJ.ZONE) {
      zoneIdx[i] = zone.length;
      zone.push(i);
    }
  }
  if (!zone.length) return null;
  const NPC = FJ.NPC;
  const N = zone.length * NPC;
  const pos = new Float64Array(3 * N);
  const V = new Float64Array(N);
  const owner = new Int32Array(N);
  const geo = gradGeo(mesh);
  const vn2 = sph ? null : gradientNoise(mixSeed(seed, 3602));
  const vn3 = sph ? gradientNoise3(mixSeed(seed, 3602)) : null;
  // 撒点：每格 NPC 个，绕格心一圈（起始角随机、每个再抖一点），离格心 R0 + R1 × 随机 格
  for (let z = 0; z < zone.length; z++) {
    const c = zone[z];
    gradientAt(mesh, geo, b0, c, gOut);
    const gx = gOut[0];
    const gy = gOut[1];
    const slope = Math.hypot(gx, gy) * sp;
    const amp = FJ.V_NOISE * slope + FJ.V_NOISE0;
    const th0 = 2 * Math.PI * hash01(seed, 3601, c, 99);
    for (let k = 0; k < NPC; k++) {
      const u = z * NPC + k;
      const th = th0 + (2 * Math.PI * (k + 0.6 * (hash01(seed, 3601, c, k) - 0.5))) / NPC;
      const rho = (FJ.R0 + FJ.R1 * hash01(seed, 3603, c, k)) * sp;
      const dx = rho * Math.cos(th);
      const dy = rho * Math.sin(th);
      let nz: number;
      if (sph) {
        const m = mesh as Extract<Mesh, { kind: 'sphere' }>;
        const px = m.p[3 * c];
        const py = m.p[3 * c + 1];
        const pz = m.p[3 * c + 2];
        const [ex, ey, ez, sx, sy, sz] = tangentBasis(px, py, pz);
        // 切平面里的位移（地图单位 × π = 弧度）
        let qx = px + Math.PI * (dx * ex + dy * sx);
        let qy = py + Math.PI * (dx * ey + dy * sy);
        let qz = pz + Math.PI * (dx * ez + dy * sz);
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
  }
  lap('place');
  // 连线：本格与邻格（都在谷网里）的点，LINK 格以内、离两头的格心都至少 CENTER_GAP 格
  // 要看的格心：c 与 j，j ≠ c 时再加两格共同的邻格（别的格心离这样的连线都远）
  const linkOff = new Int32Array(N + 1);
  const links: number[] = [];
  const per: number[][] = [];
  for (let k = 0; k < NPC; k++) per.push([]);
  const centers = new Float64Array(3 * 16);
  const nbMark = new Int32Array(n).fill(-1);
  for (let z = 0; z < zone.length; z++) {
    const c = zone[z];
    for (let k = 0; k < NPC; k++) per[k].length = 0;
    for (let e = mesh.off[c] - 1; e < mesh.off[c + 1]; e++) {
      const j = e < mesh.off[c] ? c : mesh.adj[e];
      if (zoneIdx[j] < 0) continue;
      const nc = linkCenters(mesh, c, j, nbMark, centers);
      for (let k = 0; k < NPC; k++) addLinks(zoneIdx, pos, z * NPC + k, j, centers, nc, spDist, per[k]);
    }
    for (let k = 0; k < NPC; k++) {
      const u = z * NPC + k;
      for (const w of per[k]) links.push(w);
      linkOff[u + 1] = links.length;
    }
  }
  const link = Int32Array.from(links);
  lap('link');
  // 从这一带的边上往里漫：边上的格（有不在谷网里的邻格）的点先进堆，按谷底高度
  const recv = new Int32Array(N).fill(-1);
  const seen = new Uint8Array(N);
  const key = new Float64Array(N);
  const popOrder = new Int32Array(N);
  const heap = new MinHeap(N);
  for (let z = 0; z < zone.length; z++) {
    const c = zone[z];
    let edge = false;
    for (let e = mesh.off[c]; e < mesh.off[c + 1] && !edge; e++) if (zoneIdx[mesh.adj[e]] < 0) edge = true;
    if (!edge) continue;
    for (let k = 0; k < NPC; k++) {
      const u = z * NPC + k;
      seen[u] = 1;
      key[u] = V[u];
      heap.push(u, V[u]);
    }
  }
  let popped = flood(heap, link, linkOff, V, key, seen, recv, popOrder, 0);
  // 没有边的一片（整片都在谷网里，几乎不会有）：从最低的点开始
  for (let u = 0; u < N && popped < N; u++) {
    if (seen[u]) continue;
    let lo = u;
    for (let w = u; w < N; w++) if (!seen[w] && V[w] < V[lo]) lo = w;
    seen[lo] = 1;
    key[lo] = V[lo];
    heap.push(lo, V[lo]);
    popped = flood(heap, link, linkOff, V, key, seen, recv, popOrder, popped);
  }
  lap('flood');
  // 汇水（点数）：从上游往下游加
  const acc = new Float32Array(N).fill(1);
  for (let q = N - 1; q >= 0; q--) {
    const u = popOrder[q];
    if (recv[u] >= 0) acc[recv[u]] += acc[u];
  }
  // 主支：汇水最多的上游点
  const main = new Int32Array(N).fill(-1);
  for (let q = 0; q < N; q++) {
    const u = popOrder[q];
    const v = recv[u];
    if (acc[u] < FJ.ACC_MIN || v < 0) continue;
    const m = main[v];
    if (m < 0 || acc[u] > acc[m] || (acc[u] === acc[m] && u < m)) main[v] = u;
  }
  // 谷里的点（汇水够的），从下游到上游
  const ord: number[] = [];
  for (let q = 0; q < N; q++) {
    const u = popOrder[q];
    if (acc[u] >= FJ.ACC_MIN) ord.push(u);
  }
  const order = Int32Array.from(ord);
  // 沿主谷平滑两遍（下游的点与主支的平均，挪一半）
  smoothNet(mesh, pos, owner, order, recv, main, sph, FJ.SMOOTH, spDist);
  // 每段的中点（Catmull–Rom：(−P0 + 9 P1 + 9 P2 − P3) / 16，P0 是 u 的主支（没有时 u 往外延），P3 是 v 的下游（没有时 v 往外延））
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
  // 长度、上限、预算、半宽
  const len = new Float32Array(N);
  const lc = new Float32Array(N);
  const lcs = new Float32Array(N);
  const lsea = new Float32Array(N);
  const hw = new Float32Array(N);
  const ln2 = sph ? null : gradientNoise(mixSeed(seed, 3604));
  const ln3 = sph ? gradientNoise3(mixSeed(seed, 3604)) : null;
  for (let q = 0; q < order.length; q++) {
    const u = order[q];
    const v = recv[u];
    if (v >= 0) len[u] = dist3(pos, u, v) / spDist;
    const x = pos[3 * u];
    const y = pos[3 * u + 1];
    const z = pos[3 * u + 2];
    const m = FJ.LEN_M0 + FJ.LEN_M1 * (sph ? fbm3(ln3!, x / spDist, y / spDist, z / spDist, FJ.LEN_FREQ, 2) : fbm(ln2!, x / sp, y / sp, FJ.LEN_FREQ, 2)) * 2;
    const c = zone[Math.floor(u / NPC)];
    const base = FJ.LEN * wz[c] * Math.min(FJ.M_MAX, Math.max(FJ.M_MIN, m));
    const af = Math.sqrt(Math.min(1, acc[u] / FJ.ACC1));
    const isSide = v >= 0 && main[v] !== u;
    const side = !isSide ? 1 : acc[u] < FJ.ACC_SIDE ? 0 : FJ.SIDE0 + FJ.SIDE1 * hash01(seed, 3605, u, 0);
    // 海里的预算按这一格与邻格里最大的权重（往外推的几圈权重打了折，入海口在那里时峡湾不该因此变短）
    let wm = wz[c];
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) if (wz[mesh.adj[e]] > wm) wm = wz[mesh.adj[e]];
    lsea[u] = Math.min(FJ.LEN_CAP, FJ.LEN * wm * Math.min(FJ.M_MAX, Math.max(FJ.M_MIN, m)));
    // 直接流进海里的谷汇水不到 ACC_MOUTH 个点的不淹（一个个小缺口；峡湾是大谷）
    lc[u] = acc[u] < FJ.ACC_MOUTH ? 0 : base * af;
    // 主谷往上游不再另设上限（预算从入海口一路减下来）；支谷 × side
    lcs[u] = isSide ? base * af * side : Infinity;
    hw[u] = FJ.HW * (FJ.HW_A + (1 - FJ.HW_A) * af);
  }
  lap('smooth');
  // 每段碰得到的格
  const star = starRadius(mesh);
  const stars = starTris(mesh);
  const candOff = new Int32Array(N + 1);
  const cand: number[] = [];
  const stamp = new Int32Array(n).fill(-1);
  const pstamp = new Int32Array(n).fill(-1);
  const rank = new Int32Array(n).fill(-1);
  const inNet = new Uint8Array(N);
  for (let q = 0; q < order.length; q++) inNet[order[q]] = 1;
  const queue: number[] = [];
  for (let u = 0; u < N; u++) {
    const v = recv[u];
    if (inNet[u] && v >= 0 && inNet[v]) {
      const rInf = Math.max(hw[u], hw[v]) * FJ.SEA_W * FJ_REACH + FJ.EDGE;
      candidates(stars, mesh, star, pos, mid, u, v, owner[u], owner[v], rInf, spDist, Math.min(FJ.MOUTH / Math.max(len[u], 1e-6), 4), sph, stamp, pstamp, queue, cand, rank);
    }
    candOff[u + 1] = cand.length;
  }
  lap('cand');
  // 表号按格编号
  let nRank = 0;
  for (let i = 0; i < n; i++) if (rank[i] >= 0) rank[i] = nRank++;
  const watchSet = new Uint8Array(n);
  const watch: number[] = [];
  for (let q = 0; q < order.length; q++) {
    const o = owner[order[q]];
    if (!watchSet[o]) {
      watchSet[o] = 1;
      watch.push(o);
    }
  }
  return { n: N, pos, owner, recv, order, len, lc, lcs, lsea, hw, candOff, cand: Int32Array.from(cand), rank, nRank, watch: Int32Array.from(watch), wz, spDist, sph, mid };
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
function addLinks(zoneIdx: Int32Array, pos: Float64Array, u: number, j: number, centers: Float64Array, nc: number, spDist: number, out: number[]): void {
  const base = zoneIdx[j] * FJ.NPC;
  const lim = FJ.LINK * spDist;
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
function nearStar(stars: Stars, c: number, ux: number, uy: number, uz: number, mx: number, my: number, mz: number, vx: number, vy: number, vz: number, rInf: number, spDist: number, u: number, pstamp: Int32Array, out: number[], rank: Int32Array): void {
  const { off, tri, cen, rad, prov } = stars;
  for (let k = off[c]; k < off[c + 1]; k++) {
    const t = tri[k];
    const p = prov[t];
    if (pstamp[p] === u) continue;
    const px = cen[3 * t];
    const py = cen[3 * t + 1];
    const pz = cen[3 * t + 2];
    const d = Math.min(segDist(px, py, pz, ux, uy, uz, mx, my, mz), segDist(px, py, pz, mx, my, mz, vx, vy, vz)) / spDist;
    if (d > rad[t] + rInf) continue;
    pstamp[p] = u;
    out.push(p);
    rank[p] = 0;
  }
}

function candidates(stars: Stars, mesh: Mesh, star: Float32Array, pos: Float64Array, mid: Float64Array, u: number, v: number, ou: number, ov: number, rInf: number, spDist: number, ext: number, sph: boolean, stamp: Int32Array, pstamp: Int32Array, queue: number[], out: number[], rank: Int32Array): void {
  queue.length = 0;
  queue.push(ou);
  stamp[ou] = u;
  if (stamp[ov] !== u) {
    stamp[ov] = u;
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
    if (d <= star[c] + rInf) nearStar(stars, c, ux, uy, uz, mx, my, mz, vx, vy, vz, rInf, spDist, u, pstamp, out, rank);
    if (d > star[c] + rInf + 1) continue;
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
      const j = mesh.adj[e];
      if (stamp[j] === u) continue;
      stamp[j] = u;
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
  const B = new Float32Array(N).fill(-1);
  const r = new Float32Array(N);
  const mouth = new Int32Array(N).fill(-1);
  budgets(net, land, B, r, mouth);
  // 每格的段数
  const count = new Int32Array(net.nRank);
  let entries = 0;
  for (let u = 0; u < N; u++) {
    if (!wetEdge(net, land, B, u)) continue;
    for (let k = net.candOff[u]; k < net.candOff[u + 1]; k++) {
      const rk = net.rank[net.cand[k]];
      if (count[rk] + 2 <= FJ.MAX_LIST) {
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
  for (let u = 0; u < N; u++) {
    if (!wetEdge(net, land, B, u)) continue;
    for (let k = net.candOff[u]; k < net.candOff[u + 1]; k++) {
      const rk = net.rank[net.cand[k]];
      if (fill[rk] >= count[rk]) continue;
      const o = 4 * (tex[4 * rk] + 3 * fill[rk]);
      fill[rk] += 2;
      writeEntry(net, land, B, r, mouth, u, tex, o);
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

// 每个点的预算（> 0 淹着）（统计用：tools/realism.ts 的 fjordStats）
export function fjordBudgets(net: FjordNet, land: ArrayLike<number>): Float32Array {
  const B = new Float32Array(net.n).fill(-1);
  budgets(net, land, B, new Float32Array(net.n), new Int32Array(net.n).fill(-1));
  return B;
}

// 预算：海里的点 lsea；陆上的点 min(下游的, 自己的上限) − 这段长；半径按预算收窄
function budgets(net: FjordNet, land: ArrayLike<number>, B: Float32Array, r: Float32Array, mouth: Int32Array): void {
  const { order, recv, owner, len, lc, lcs, lsea, hw, spDist } = net;
  for (let q = 0; q < order.length; q++) {
    const u = order[q];
    const o = owner[u];
    if (!land[o]) {
      B[u] = lsea[u];
      r[u] = hw[u] * FJ.SEA_W * spDist;
      mouth[u] = o;
      continue;
    }
    const v = recv[u];
    if (v < 0 || B[v] <= 0) continue;
    const b = Math.min(B[v], land[owner[v]] ? lcs[u] : lc[u]) - len[u];
    B[u] = b;
    if (b > 0) {
      r[u] = hw[u] * (FJ.TAPER_MIN + (1 - FJ.TAPER_MIN) * sm01(b / FJ.TAPER)) * (FJ.WIDEN0 + FJ.WIDEN1 * Math.min(1, b / FJ.LEN)) * spDist;
      mouth[u] = mouth[v];
    } else B[u] = b;
  }
}

// 段 u → recv[u] 画不画：u 是陆上的点，且 u 淹着，或 recv[u] 淹着且预算在这段中间用完（剩下的够 STUB_MIN）
function wetEdge(net: FjordNet, land: ArrayLike<number>, B: Float32Array, u: number): boolean {
  const v = net.recv[u];
  if (v < 0 || net.candOff[u + 1] === net.candOff[u]) return false;
  // 海里的点往下游的段不画（刻海面没有用；入海口那一段往海里延长了，穿过岸外的岛礁）
  if (!land[net.owner[u]]) return false;
  if (B[u] > 0) return true;
  if (B[v] <= 0) return false;
  return stubOf(net, land, B, u, v) > FJ.STUB_MIN;
}

// 预算在段 u → v 中间用完时淹到的比例
function stubOf(net: FjordNet, land: ArrayLike<number>, B: Float32Array, u: number, v: number): number {
  return Math.min(B[v], land[net.owner[v]] ? net.lcs[u] : net.lc[u]) / net.len[u];
}

// 一段写成两小段（中点在 Catmull–Rom 曲线上，弯一点）：下游那头 A → 中点 M → 上游那头 U
function writeEntry(net: FjordNet, land: ArrayLike<number>, B: Float32Array, r: Float32Array, mouth: Int32Array, u: number, tex: Float32Array, o: number): void {
  const { pos, recv, mid } = net;
  const v = recv[u];
  // 上游那头（u，没淹到时只到预算用完的地方，圆头）
  let t = 1;
  let ru = r[u];
  if (B[u] <= 0) {
    t = Math.min(1, stubOf(net, land, B, u, v));
    ru = FJ.HEAD * r[v];
  }
  // 陆上的点流进海里的点：下游那头往海里延长 MOUTH 格（海里的点所在的格是海，那一点却可能还画成陆地：峡湾一直通到水面）
  if (B[u] > 0 && land[net.owner[u]] && !land[net.owner[v]]) extend(pos, u, v, Math.min(FJ.MOUTH / Math.max(net.len[u], 1e-6), 4), net.sph, P3, 0);
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
  const m = mouth[v];
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
