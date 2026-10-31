import { type Flow, kahnOrder } from './climate';
import type { SphereMesh } from './mesh';

// 球面上的输运图（水汽随风、海温随海流）：与 climate.ts 的 buildFlow 同一种做法，
// 区别是方向用每格的切平面分量、绕星球一圈的环保留为“滞后边”（见 planet-climate.ts 的说明）。
// 稳态输运沿拓扑序扫描固定遍数（PLANET_SWEEPS）；滞后边的源头排在后面，读到的是上一遍的值

export const PLANET_SWEEPS = { wind: 4, ocean: 6 };

interface SphereAux {
  rev: Int32Array;
  // 与 adj 对齐：本格切平面里指向邻格的单位方向（东、南分量）
  dirE: Float64Array;
  dirS: Float64Array;
  // 这条边跨过经度 ±180°
  seam: Uint8Array;
}

const auxCache = new WeakMap<SphereMesh, SphereAux>();

export function sphereAux(mesh: SphereMesh): SphereAux {
  let a = auxCache.get(mesh);
  if (a) return a;
  const E = mesh.adj.length;
  const rev = new Int32Array(E);
  const dirE = new Float64Array(E);
  const dirS = new Float64Array(E);
  const seam = new Uint8Array(E);
  for (let i = 0; i < mesh.n; i++) {
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      for (let f = mesh.off[j]; f < mesh.off[j + 1]; f++) {
        if (mesh.adj[f] === i) {
          rev[e] = f;
          break;
        }
      }
      const l = Math.hypot(mesh.edx[e], mesh.edy[e]) || 1;
      dirE[e] = mesh.edx[e] / l;
      dirS[e] = mesh.edy[e] / l;
      if (Math.abs(mesh.x[j] - mesh.x[i]) > 1) seam[e] = 1;
    }
  }
  a = { rev, dirE, dirS, seam };
  auxCache.set(mesh, a);
  return a;
}

// ---------- 输运图 ----------

// 入流表（按拓扑序的位置 k）：第 k 格 order[k] 的上风来源 src[koff[k]..koff[k+1]) 与权重 w（即 frac(来源→该格)），
// 按该格的邻接顺序、只含权重 > 0 的边；den[k] 是权重之和（与逐遍现加的顺序相同）
export interface SphereFlow extends Flow {
  lagged: Uint8Array;
  koff: Int32Array;
  src: Int32Array;
  w: Float64Array;
  den: Float64Array;
}

export interface FlowOptions {
  // seam：只有跨过经度 180°、顺着风带的边滞后（风）；all：所有逆序的边都滞后（洋流的环流是真实的闭环）
  lag: 'seam' | 'all';
  // 只有 mask = 1 的格参与（洋流只在海上）
  mask?: Uint8Array;
}

export function buildFlowSphere(mesh: SphereMesh, wx: ArrayLike<number>, wy: ArrayLike<number>, o: FlowOptions): SphereFlow {
  const { rev, dirE, dirS, seam } = sphereAux(mesh);
  const { n, off, adj, edgeLen, x } = mesh;
  const E = adj.length;
  const frac = new Float64Array(E);
  const calm = new Uint8Array(n);
  const mask = o.mask ?? null;
  // 第三十五轮（提速）：一段段逐格的循环放进小函数（原样照搬，结果逐值相同；见开发说明“还没编译好的代码”）
  if (mask) flowFracMasked(n, off, adj, edgeLen, dirE, dirS, wx, wy, mask, frac, calm);
  else flowFrac(n, off, edgeLen, dirE, dirS, wx, wy, frac, calm);
  // 相互指向的两格只保留较强的一边（与处理顺序无关）
  keepStronger(n, off, adj, rev, calm, frac);
  // 滞后边（seam：跨过接缝、顺着风带的），参与排序的边与每格的入度：一遍扫完（第三十一轮，与分开扫几遍相同）
  const lagged = new Uint8Array(E);
  const em = new Uint8Array(E);
  const indeg = new Int32Array(n);
  markEdges(n, off, adj, seam, x, wx, wy, o.lag === 'seam', calm, frac, lagged, em, indeg);
  const order = kahnOrder(mesh, em, indeg);
  const pos = new Int32Array(n);
  for (let k = 0; k < n; k++) pos[order[k]] = k;
  cutBackward(n, off, adj, pos, o.lag === 'all', frac, lagged);
  const koff = new Int32Array(n + 1);
  const src = new Int32Array(E);
  const w = new Float64Array(E);
  const den = new Float64Array(n);
  const p = inflowTable(n, off, adj, rev, order, frac, koff, src, w, den);
  return { frac, order, lagged, koff, src: src.slice(0, p), w: w.slice(0, p), den };
}

const DIFFUSE = 0.15;

// 每条边的输送比例（没有 mask：所有格都参与）
function flowFrac(n: number, off: Int32Array, edgeLen: Float64Array, dirE: Float64Array, dirS: Float64Array, wx: ArrayLike<number>, wy: ArrayLike<number>, frac: Float64Array, calm: Uint8Array) {
  const diffuse = DIFFUSE;
  for (let i = 0; i < n; i++) {
    const a = off[i];
    const b = off[i + 1];
    const mag = Math.hypot(wx[i], wy[i]);
    const ux = mag > 1e-6 ? wx[i] / mag : 0;
    const uy = mag > 1e-6 ? wy[i] / mag : 0;
    let sum = 0;
    let fwdLen = 0;
    for (let e = a; e < b; e++) {
      const dot = ux * dirE[e] + uy * dirS[e];
      if (dot > 0) {
        const f = dot * dot * edgeLen[e];
        frac[e] = f;
        sum += f;
        fwdLen += edgeLen[e];
      }
    }
    if (sum <= 0) {
      let total = 0;
      for (let e = a; e < b; e++) total += edgeLen[e];
      for (let e = a; e < b; e++) frac[e] = (0.6 * edgeLen[e]) / (total || 1);
      calm[i] = 1;
      continue;
    }
    for (let e = a; e < b; e++) {
      if (frac[e] <= 0) continue;
      frac[e] = (1 - diffuse) * (frac[e] / sum) + (diffuse * edgeLen[e]) / fwdLen;
    }
  }
}

// 同上，只有 mask = 1 的格参与（洋流只在海上）
function flowFracMasked(n: number, off: Int32Array, adj: Int32Array, edgeLen: Float64Array, dirE: Float64Array, dirS: Float64Array, wx: ArrayLike<number>, wy: ArrayLike<number>, mask: Uint8Array, frac: Float64Array, calm: Uint8Array) {
  const diffuse = DIFFUSE;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const a = off[i];
    const b = off[i + 1];
    const mag = Math.hypot(wx[i], wy[i]);
    const ux = mag > 1e-6 ? wx[i] / mag : 0;
    const uy = mag > 1e-6 ? wy[i] / mag : 0;
    let sum = 0;
    let fwdLen = 0;
    for (let e = a; e < b; e++) {
      if (!mask[adj[e]]) continue;
      const dot = ux * dirE[e] + uy * dirS[e];
      if (dot > 0) {
        const f = dot * dot * edgeLen[e];
        frac[e] = f;
        sum += f;
        fwdLen += edgeLen[e];
      }
    }
    if (sum <= 0) {
      let total = 0;
      for (let e = a; e < b; e++) if (mask[adj[e]]) total += edgeLen[e];
      for (let e = a; e < b; e++) frac[e] = mask[adj[e]] ? (0.6 * edgeLen[e]) / (total || 1) : 0;
      calm[i] = 1;
      continue;
    }
    for (let e = a; e < b; e++) {
      if (frac[e] <= 0) continue;
      frac[e] = (1 - diffuse) * (frac[e] / sum) + (diffuse * edgeLen[e]) / fwdLen;
    }
  }
}

// 相互指向的两格只保留较强的一边（与处理顺序无关）
function keepStronger(n: number, off: Int32Array, adj: Int32Array, rev: Int32Array, calm: Uint8Array, frac: Float64Array) {
  for (let i = 0; i < n; i++) {
    if (calm[i]) continue;
    for (let e = off[i], end = off[i + 1]; e < end; e++) {
      const fe = frac[e];
      if (fe <= 0) continue;
      const j = adj[e];
      const ff = frac[rev[e]];
      if (calm[j] || ff <= 0) continue;
      if (fe < ff || (fe === ff && i > j)) frac[e] = 0;
    }
  }
}

// 滞后边、参与排序的边与每格的入度
function markEdges(n: number, off: Int32Array, adj: Int32Array, seam: Uint8Array, x: Float64Array, wx: ArrayLike<number>, wy: ArrayLike<number>, seamLag: boolean, calm: Uint8Array, frac: Float64Array, lagged: Uint8Array, em: Uint8Array, indeg: Int32Array) {
  for (let i = 0; i < n; i++) {
    if (calm[i]) continue;
    for (let e = off[i], end = off[i + 1]; e < end; e++) {
      if (frac[e] <= 0) continue;
      const j = adj[e];
      if (seamLag && seam[e] && !calm[j]) {
        // 向东跨过接缝时 x 从近 2 变成近 0（风速只在接缝上的边才要算）
        const s = x[j] < x[i] ? 1 : -1;
        const mi = Math.hypot(wx[i], wy[i]);
        const mj = Math.hypot(wx[j], wy[j]);
        if ((s * wx[i]) / mi > 0.3 && (s * wx[j]) / mj > 0.3) {
          lagged[e] = 1;
          continue;
        }
      }
      em[e] = 1;
      indeg[j]++;
    }
  }
}

// 逆着拓扑序的边：lagAll 时都滞后（洋流），否则不是滞后边的去掉
function cutBackward(n: number, off: Int32Array, adj: Int32Array, pos: Int32Array, lagAll: boolean, frac: Float64Array, lagged: Uint8Array) {
  for (let i = 0; i < n; i++) {
    const pi = pos[i];
    for (let e = off[i], end = off[i + 1]; e < end; e++) {
      if (frac[e] <= 0 || pos[adj[e]] >= pi) continue;
      if (lagAll) lagged[e] = 1;
      else if (!lagged[e]) frac[e] = 0;
    }
  }
}

// 入流表（按拓扑序的位置）：返回边数
function inflowTable(n: number, off: Int32Array, adj: Int32Array, rev: Int32Array, order: Int32Array, frac: Float64Array, koff: Int32Array, src: Int32Array, w: Float64Array, den: Float64Array): number {
  let p = 0;
  for (let k = 0; k < n; k++) {
    const i = order[k];
    let s = 0;
    for (let e = off[i], end = off[i + 1]; e < end; e++) {
      const f = frac[rev[e]];
      if (f <= 0) continue;
      src[p] = adj[e];
      w[p++] = f;
      s += f;
    }
    den[k] = s;
    koff[k + 1] = p;
  }
  return p;
}
