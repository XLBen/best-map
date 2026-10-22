import { type Flow, kahnOrder } from './climate';
import type { SphereMesh } from './mesh';

// 球面上的输运图与稳态输运（水汽随风、海温随海流）：与 climate.ts 的 buildFlow / solveTransport 同一种做法，
// 区别是方向用每格的切平面分量、绕星球一圈的环保留为“滞后边”、扫描固定遍数（见 planet-climate.ts 的说明）

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

export interface SphereFlow extends Flow {
  lagged: Uint8Array;
}

export interface FlowOptions {
  // seam：只有跨过经度 180°、顺着风带的边滞后（风）；all：所有逆序的边都滞后（洋流的环流是真实的闭环）
  lag: 'seam' | 'all';
  // 只有 mask = 1 的格参与（洋流只在海上）
  mask?: Uint8Array;
}

export function buildFlowSphere(mesh: SphereMesh, wx: ArrayLike<number>, wy: ArrayLike<number>, o: FlowOptions): SphereFlow {
  const { rev, dirE, dirS, seam } = sphereAux(mesh);
  const n = mesh.n;
  const E = mesh.adj.length;
  const frac = new Float64Array(E);
  const diffuse = 0.15;
  const calm = new Uint8Array(n);
  const mask = o.mask;
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) continue;
    const a = mesh.off[i];
    const b = mesh.off[i + 1];
    const mag = Math.hypot(wx[i], wy[i]);
    const ux = mag > 1e-6 ? wx[i] / mag : 0;
    const uy = mag > 1e-6 ? wy[i] / mag : 0;
    let sum = 0;
    let fwdLen = 0;
    for (let e = a; e < b; e++) {
      if (mask && !mask[mesh.adj[e]]) continue;
      const dot = ux * dirE[e] + uy * dirS[e];
      if (dot > 0) {
        frac[e] = dot * dot * mesh.edgeLen[e];
        sum += frac[e];
        fwdLen += mesh.edgeLen[e];
      }
    }
    if (sum <= 0) {
      let total = 0;
      for (let e = a; e < b; e++) if (!mask || mask[mesh.adj[e]]) total += mesh.edgeLen[e];
      for (let e = a; e < b; e++) frac[e] = !mask || mask[mesh.adj[e]] ? (0.6 * mesh.edgeLen[e]) / (total || 1) : 0;
      calm[i] = 1;
      continue;
    }
    for (let e = a; e < b; e++) {
      if (frac[e] <= 0) continue;
      frac[e] = (1 - diffuse) * (frac[e] / sum) + (diffuse * mesh.edgeLen[e]) / fwdLen;
    }
  }
  // 相互指向的两格只保留较强的一边（与处理顺序无关）
  for (let i = 0; i < n; i++) {
    if (calm[i]) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      const f = rev[e];
      if (calm[j] || frac[e] <= 0 || frac[f] <= 0) continue;
      if (frac[e] < frac[f] || (frac[e] === frac[f] && i > j)) frac[e] = 0;
    }
  }
  const lagged = new Uint8Array(E);
  if (o.lag === 'seam') {
    for (let i = 0; i < n; i++) {
      if (calm[i]) continue;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        if (!seam[e] || frac[e] <= 0) continue;
        const j = mesh.adj[e];
        if (calm[j]) continue;
        // 向东跨过接缝时 x 从近 2 变成近 0（风速只在接缝上的边才要算）
        const s = mesh.x[j] < mesh.x[i] ? 1 : -1;
        const mi = Math.hypot(wx[i], wy[i]);
        const mj = Math.hypot(wx[j], wy[j]);
        if ((s * wx[i]) / mi > 0.3 && (s * wx[j]) / mj > 0.3) lagged[e] = 1;
      }
    }
  }
  const em = new Uint8Array(E);
  for (let i = 0; i < n; i++) {
    if (calm[i]) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (frac[e] > 0 && !lagged[e]) em[e] = 1;
  }
  const order = kahnOrder(mesh, em);
  const pos = new Int32Array(n);
  for (let k = 0; k < n; k++) pos[order[k]] = k;
  for (let i = 0; i < n; i++) {
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      if (frac[e] <= 0 || pos[mesh.adj[e]] >= pos[i]) continue;
      if (o.lag === 'all') lagged[e] = 1;
      else if (!lagged[e]) frac[e] = 0;
    }
  }
  return { frac, order, lagged };
}

// 稳态输运：沿拓扑序扫描固定遍数；滞后边的源头排在后面，读到的是上一遍的值。
// init：第一遍里滞后边读到的值；fallback：没有任何上风来源的格（辐散中心）
export function solveTransportSphere(
  mesh: SphereMesh,
  flow: Flow,
  sweeps: number,
  step: (i: number, inflow: number) => number,
  init: (i: number) => number,
  fallback: (i: number) => number,
): Float64Array {
  const n = mesh.n;
  const { rev } = sphereAux(mesh);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = init(i);
  const { frac, order } = flow;
  for (let s = 0; s < sweeps; s++) {
    for (let k = 0; k < n; k++) {
      const i = order[k];
      let num = 0;
      let den = 0;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const f = frac[rev[e]];
        if (f <= 0) continue;
        num += out[mesh.adj[e]] * f;
        den += f;
      }
      out[i] = step(i, den > 1e-9 ? num / den : fallback(i));
    }
  }
  return out;
}

