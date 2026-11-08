// 按陆海定哪一段淹成峡湾、写成给着色器的一层（第八十三轮从 core/fjords.ts 原样搬出）
import { type FjordNet, candOf, FJ, sm01, cellPos, P3, extend } from './fjord-base';

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
