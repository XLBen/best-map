import type { Mesh } from './mesh';
import { fbm, fbm3, gradientNoise, gradientNoise3, mixSeed } from './rng';
import { tangentBasis } from './sphere';
import { FJ, hash01, cellPos, segDist, P3, scratchOf } from './fjord-base';

// ---------- 谷网里每格的点与连线（第八十八轮：按网格记下来） ----------
// 谷网的块（core/fjords.ts 的 buildTile）每次重建都要撒点、连线。撒在哪里、相对格心的位移、谷底的噪声、离哪格的格心最近
// 只取决于网格与种子；两格的点之间连不连只取决于这些点、网格（要看的格心）与比例尺（最长的连线）——都与一带、地壳高度无关。
// 这里按格（连线按“格、哪一个邻格”）用到时才算、记下来，块重建时照抄（与 placeCell、addLinks 原来的算式逐值相同）。
// 挪纬度、涂冷暖改了冰盖时谷网的一带挪动，碰到的块要整块重建：这几样不用再算

const NPC = FJ.NPC;

// 每格的点（第 c 格的第 k 个点在 c × NPC + k）：位置（三个数）、相对格心的位移（切平面里的 dx、dy）、谷底噪声、最近的格心；
// 每格的切平面基（六个数：东 ex ey ez、北 sx sy sz；平面是 1 0 0 0 1 0）
export interface CellPoints {
  seed: number;
  done: Uint8Array;
  pos: Float64Array;
  dx: Float64Array;
  dy: Float64Array;
  nz: Float64Array;
  owner: Int32Array;
  basis: Float64Array;
}
const ptsCache = new WeakMap<Mesh, CellPoints>();

// 这一格的点（没算过时现算）。返回整份（按 c × NPC + k 取）
export function cellPoints(mesh: Mesh, seed: number, c: number): CellPoints {
  let P = ptsCache.get(mesh);
  if (!P || P.seed !== seed) {
    const n = mesh.n;
    P = { seed, done: new Uint8Array(n), pos: new Float64Array(3 * NPC * n), dx: new Float64Array(NPC * n), dy: new Float64Array(NPC * n), nz: new Float64Array(NPC * n), owner: new Int32Array(NPC * n), basis: new Float64Array(6 * n) };
    ptsCache.set(mesh, P);
  }
  if (!P.done[c]) placePoints(mesh, seed, c, P);
  return P;
}

// 噪声函数（按种子留一份）
let noiseFor: { seed: number; n2: ReturnType<typeof gradientNoise>; n3: ReturnType<typeof gradientNoise3> | null; sph: boolean } | null = null;

// 与第八十七轮的 placeCell 里不读地壳高度的那部分相同
function placePoints(mesh: Mesh, seed: number, c: number, P: CellPoints): void {
  const sph = mesh.kind === 'sphere';
  const sp = mesh.spacing;
  const spDist = sph ? Math.PI * sp : sp;
  if (!noiseFor || noiseFor.seed !== seed || noiseFor.sph !== sph) {
    noiseFor = { seed, sph, n2: gradientNoise(mixSeed(seed, 3602)), n3: sph ? gradientNoise3(mixSeed(seed, 3602)) : null };
  }
  const vn2 = noiseFor.n2;
  const vn3 = noiseFor.n3;
  const th0 = 2 * Math.PI * hash01(seed, 3601, c, 99);
  let ex = 1;
  let ey = 0;
  let ez = 0;
  let sx = 0;
  let sy = 1;
  let sz = 0;
  if (sph) [ex, ey, ez, sx, sy, sz] = tangentBasis(mesh.p[3 * c], mesh.p[3 * c + 1], mesh.p[3 * c + 2]);
  const b = 6 * c;
  P.basis[b] = ex;
  P.basis[b + 1] = ey;
  P.basis[b + 2] = ez;
  P.basis[b + 3] = sx;
  P.basis[b + 4] = sy;
  P.basis[b + 5] = sz;
  for (let k = 0; k < NPC; k++) {
    const q = c * NPC + k;
    const th = th0 + (2 * Math.PI * (k + 0.6 * (hash01(seed, 3601, c, k) - 0.5))) / NPC;
    const rho = (FJ.R0 + FJ.R1 * hash01(seed, 3603, c, k)) * sp;
    const dx = rho * Math.cos(th);
    const dy = rho * Math.sin(th);
    let nz: number;
    if (sph) {
      let qx = mesh.p[3 * c] + Math.PI * (dx * ex + dy * sx);
      let qy = mesh.p[3 * c + 1] + Math.PI * (dx * ey + dy * sy);
      let qz = mesh.p[3 * c + 2] + Math.PI * (dx * ez + dy * sz);
      const l = Math.sqrt(qx * qx + qy * qy + qz * qz);
      qx /= l;
      qy /= l;
      qz /= l;
      P.pos[3 * q] = qx;
      P.pos[3 * q + 1] = qy;
      P.pos[3 * q + 2] = qz;
      nz = fbm3(vn3!, qx / spDist, qy / spDist, qz / spDist, FJ.V_FREQ, 2);
    } else {
      const x = mesh.x[c] + dx;
      const y = mesh.y[c] + dy;
      P.pos[3 * q] = x;
      P.pos[3 * q + 1] = y;
      P.pos[3 * q + 2] = 0;
      nz = fbm(vn2, x / sp, y / sp, FJ.V_FREQ, 2);
    }
    P.dx[q] = dx;
    P.dy[q] = dy;
    P.nz[q] = nz;
    P.owner[q] = nearestOwner(mesh, c, P.pos, q);
  }
  P.done[c] = 1;
}

// 离点 u 最近的格心：c 与它的邻格里
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

export function dist3(pos: Float64Array, u: number, v: number): number {
  const dx = pos[3 * u] - pos[3 * v];
  const dy = pos[3 * u + 1] - pos[3 * v + 1];
  const dz = pos[3 * u + 2] - pos[3 * v + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ---------- 连线 ----------
// 格 c 的点与格 j（c 自己，或 c 的第 e 条边的邻格）的点连不连：每对 (k, k2) 一位（k × NPC + k2），按“格、边”记。
// 槽：c 自己是 c，第 e 条边是 n + e
interface LinkBits {
  seed: number;
  kmCell: number;
  done: Uint8Array;
  bits: Uint16Array;
}
const linkCache = new WeakMap<Mesh, LinkBits>();
const centers = new Float64Array(3 * 16);

// 格 c 的点与格 j 的点（e < 0：j 是 c 自己；否则 j 是 mesh.adj[e]）连不连的位
export function linkBits(mesh: Mesh, seed: number, kmCell: number, c: number, e: number): number {
  let L = linkCache.get(mesh);
  if (!L || L.seed !== seed || L.kmCell !== kmCell) {
    const m = mesh.n + mesh.adj.length;
    L = { seed, kmCell, done: new Uint8Array(m), bits: new Uint16Array(m) };
    linkCache.set(mesh, L);
  }
  const slot = e < 0 ? c : mesh.n + e;
  if (L.done[slot]) return L.bits[slot];
  const j = e < 0 ? c : mesh.adj[e];
  const P = cellPoints(mesh, seed, c);
  cellPoints(mesh, seed, j);
  const nc = linkCenters(mesh, c, j, scratchOf(mesh).mark, centers);
  let bits = 0;
  for (let k = 0; k < NPC; k++) bits |= linkRow(P.pos, c * NPC + k, j, j === c ? k : -1, nc, mesh, kmCell) << (k * NPC);
  L.bits[slot] = bits;
  L.done[slot] = 1;
  return bits;
}

// 点 u 与格 j 的 NPC 个点（跳过第 skip 个：同一格里的自己）连不连（第八十七轮的 addLinks，按位返回）
function linkRow(pos: Float64Array, u: number, j: number, skip: number, nc: number, mesh: Mesh, kmCell: number): number {
  const sph = mesh.kind === 'sphere';
  const spDist = sph ? Math.PI * mesh.spacing : mesh.spacing;
  const base = j * NPC;
  const lim = Math.min(FJ.LINK, FJ.LINK_KM / kmCell) * spDist;
  const gap = FJ.CENTER_GAP * spDist;
  const ux = pos[3 * u];
  const uy = pos[3 * u + 1];
  const uz = pos[3 * u + 2];
  let out = 0;
  for (let k = 0; k < NPC; k++) {
    if (k === skip) continue;
    const w = base + k;
    if (dist3(pos, u, w) > lim) continue;
    const wx = pos[3 * w];
    const wy = pos[3 * w + 1];
    const wz = pos[3 * w + 2];
    let ok = true;
    for (let q = 0; q < nc && ok; q++) if (segDist(centers[3 * q], centers[3 * q + 1], centers[3 * q + 2], ux, uy, uz, wx, wy, wz) < gap) ok = false;
    if (ok) out |= 1 << k;
  }
  return out;
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
