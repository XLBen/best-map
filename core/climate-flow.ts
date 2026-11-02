import type { Mesh } from './mesh';

// 平面的输运图（第四十六轮从 climate.ts 原样搬来，climate.ts 照旧导出 Flow、PlaneFlow、kahnOrder）：网格的邻接反查与扫描顺序、边的方向、
// 每季按风建入流表、沿风向的拓扑序

const cache = new WeakMap<Mesh, { rev: Int32Array; orders: Int32Array[] }>();

// rev[e]：邻接项 e（i→j）在 j 的邻接表中指回 i 的那一项
export function meshAux(mesh: Mesh) {
  let aux = cache.get(mesh);
  if (aux) return aux;
  const rev = new Int32Array(mesh.adj.length);
  for (let i = 0; i < mesh.n; i++) {
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      for (let f = mesh.off[j]; f < mesh.off[j + 1]; f++) {
        if (mesh.adj[f] === i) {
          rev[e] = f;
          break;
        }
      }
    }
  }
  const idx = Array.from({ length: mesh.n }, (_, i) => i);
  const byX = Int32Array.from([...idx].sort((a, b) => mesh.x[a] - mesh.x[b]));
  const byY = Int32Array.from([...idx].sort((a, b) => mesh.y[a] - mesh.y[b]));
  const orders = [byX, Int32Array.from(byX).reverse(), byY, Int32Array.from(byY).reverse()];
  aux = { rev, orders };
  cache.set(mesh, aux);
  return aux;
}

export const hasMeshAux = (mesh: Mesh) => cache.has(mesh);

export interface Flow {
  // 与 adj 对齐：格 i 出流分给邻居 adj[e] 的比例
  frac: Float64Array;
  // 沿风向的拓扑序（上风在前）；风场有环时环上的格按 x 顺序补在后面
  order: Int32Array;
}

// 平面的输运图另带入流表（按格）：格 i 的上风来源 src[koff[i]..koff[i+1]) 与权重 w（即 frac(来源→i)），
// 按 i 的邻接顺序、只含权重 > 0 的边
export interface PlaneFlow extends Flow {
  koff: Int32Array;
  src: Int32Array;
  w: Float64Array;
}

// 每条邻接项 e（i→adj[e]）的单位方向（地图单位）：只取决于网格（第三十一轮按网格缓存；与逐边现算的是同一个值）
const edgeDirCache = new WeakMap<Mesh, { ex: Float64Array; ey: Float64Array }>();
export function edgeDirs(mesh: Mesh): { ex: Float64Array; ey: Float64Array } {
  let d = edgeDirCache.get(mesh);
  if (d) return d;
  const E = mesh.adj.length;
  const ex = new Float64Array(E);
  const ey = new Float64Array(E);
  for (let i = 0; i < mesh.n; i++) {
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      ex[e] = (mesh.x[j] - mesh.x[i]) / mesh.dist[e];
      ey[e] = (mesh.y[j] - mesh.y[i]) / mesh.dist[e];
    }
  }
  d = { ex, ey };
  edgeDirCache.set(mesh, d);
  return d;
}

export function buildFlow(mesh: Mesh, wx: Float32Array, wy: Float32Array): PlaneFlow {
  const { n, off, adj, edgeLen, boundary, inwardX, inwardY } = mesh;
  const E = adj.length;
  const { ex, ey } = edgeDirs(mesh);
  const frac = new Float64Array(E);
  const dots = new Float64Array(32);
  // 参与排序的边（有风的格把水汽送往下风的邻格）与每格的入度：在算权重的同时记下（第三十一轮，与之后另扫一遍相同）
  const em = new Uint8Array(E);
  const indeg = new Int32Array(n);
  // 第三十五轮（提速）：逐格的几段放进小函数（原样照搬，结果逐值相同）
  for (let i = 0; i < n; i++) flowCell(i, off, adj, edgeLen, ex, ey, boundary, inwardX, inwardY, wx, wy, frac, dots, em, indeg);

  const order = kahnOrder(mesh, em, indeg);
  // 只保留顺着拓扑序往下游的输送：风弱、风向杂乱的地方格与格会互相指向，
  // 水汽在环里来回累积会算出离谱的降水（格越小越严重）。去掉逆序的边后输送图无环，
  // 水汽顺风走一遍；流进死角的那部分视为随上升气流带走
  const pos = new Int32Array(n);
  for (let k = 0; k < n; k++) pos[order[k]] = k;
  cutUpstream(n, off, adj, pos, frac);
  const { rev } = meshAux(mesh);
  const koff = new Int32Array(n + 1);
  const src = new Int32Array(E);
  const w = new Float64Array(E);
  const p = inflowByCell(n, off, adj, rev, frac, koff, src, w);
  return { frac, order, koff, src: src.slice(0, p), w: w.slice(0, p) };
}

// 一格的出流比例（写进 frac）、参与排序的边与入度
function flowCell(i: number, off: Int32Array, adj: Int32Array, edgeLen: Float64Array, ex: Float64Array, ey: Float64Array, boundary: Uint8Array, inwardX: Float32Array, inwardY: Float32Array, wx: Float32Array, wy: Float32Array, frac: Float64Array, dots: Float64Array, em: Uint8Array, indeg: Int32Array) {
  const diffuse = 0.15;
  const a = off[i];
  const b = off[i + 1];
  const mag = Math.hypot(wx[i], wy[i]);
  const ux = mag > 1e-6 ? wx[i] / mag : 0;
  const uy = mag > 1e-6 ? wy[i] / mag : 0;
  let sum = 0;
  let fwdLen = 0;
  for (let e = a; e < b; e++) {
    const dot = ux * ex[e] + uy * ey[e];
    dots[e - a] = dot;
    if (dot > 0) {
      frac[e] = dot * dot * edgeLen[e];
      sum += frac[e];
      fwdLen += edgeLen[e];
    } else frac[e] = 0;
  }
  if (sum <= 0) {
    // 无风：均匀分给所有邻居（这些边不参与排序，否则会和邻居互成环）。
    // 无风带是下沉气流，空气偏干：只传出六成，两格之间来回传递的环因此不会越积越多
    let total = 0;
    for (let e = a; e < b; e++) total += edgeLen[e];
    for (let e = a; e < b; e++) frac[e] = (0.6 * edgeLen[e]) / total;
    return;
  }
  // 贴图边的格：吹向图外的部分流失
  const lostShare = boundary[i] ? Math.max(0, -(ux * inwardX[i] + uy * inwardY[i])) * 0.5 : 0;
  const keep = 1 - lostShare;
  // 侧向扩散只给下风一侧的邻居：不回流，按拓扑序扫描一遍即可推进
  for (let e = a; e < b; e++) {
    if (dots[e - a] <= 0) continue;
    const f = keep * ((1 - diffuse) * (frac[e] / sum) + (diffuse * edgeLen[e]) / fwdLen);
    frac[e] = f;
    // Kahn 拓扑排序：边 i→j 当 i 有风且把水汽送往下风的 j
    if (f > 0) {
      em[e] = 1;
      indeg[adj[e]]++;
    }
  }
}

// 逆着拓扑序的边去掉
function cutUpstream(n: number, off: Int32Array, adj: Int32Array, pos: Int32Array, frac: Float64Array) {
  for (let i = 0; i < n; i++) {
    const pi = pos[i];
    for (let e = off[i], end = off[i + 1]; e < end; e++) if (frac[e] > 0 && pos[adj[e]] < pi) frac[e] = 0;
  }
}

// 入流表（按格）：返回边数
function inflowByCell(n: number, off: Int32Array, adj: Int32Array, rev: Int32Array, frac: Float64Array, koff: Int32Array, src: Int32Array, w: Float64Array): number {
  let p = 0;
  for (let i = 0; i < n; i++) {
    for (let e = off[i], end = off[i + 1]; e < end; e++) {
      const f = frac[rev[e]];
      if (f <= 0) continue;
      src[p] = adj[e];
      w[p++] = f;
    }
    koff[i + 1] = p;
  }
  return p;
}

// Kahn 拓扑排序（球面的 sphere-flow.ts 也用）：em[e] = 1 的边 i→adj[e] 参与排序。
// 风场里有环时，放入剩余入度最小的格（打断环的代价最小）。待放的格按入度分桶、桶内先进先出，
// 出桶顺序与按（入度，入堆先后）出堆的最小堆完全相同；桶里允许过期项，取出时跳过
// given：调用方在标 em 的同时数好的每格入度（第三十一轮，省掉再扫一遍所有的边；这里会就地改它）
export function kahnOrder(mesh: Mesh, em: Uint8Array, given?: Int32Array): Int32Array {
  const n = mesh.n;
  const { off, adj } = mesh;
  let indeg = given;
  if (!indeg) {
    indeg = new Int32Array(n);
    for (let i = 0; i < n; i++) for (let e = off[i]; e < off[i + 1]; e++) if (em[e]) indeg[adj[e]]++;
  }
  // 入度只减不增，每格进桶 k 至多一次，且只在初始入度 ≥ k 时：按这个上限给每个桶分一段
  let maxD = 0;
  for (let i = 0; i < n; i++) if (indeg[i] > maxD) maxD = indeg[i];
  const cnt = new Int32Array(maxD + 1);
  for (let i = 0; i < n; i++) cnt[indeg[i]]++;
  const bHead = new Int32Array(maxD + 2);
  const bTail = new Int32Array(maxD + 2);
  let size = 0;
  let atLeast = n - cnt[0];
  for (let k = 1; k <= maxD; k++) {
    bHead[k] = bTail[k] = size;
    size += atLeast;
    atLeast -= cnt[k];
  }
  const q = new Int32Array(size);
  let minB = maxD + 1;
  const order = new Int32Array(n);
  const placed = new Uint8Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < n; i++) {
    const d = indeg[i];
    if (d === 0) {
      order[tail++] = i;
      placed[i] = 1;
    } else {
      q[bTail[d]++] = i;
      if (d < minB) minB = d;
    }
  }
  while (tail < n) {
    while (head < tail) {
      const i = order[head++];
      for (let e = off[i]; e < off[i + 1]; e++) {
        if (!em[e]) continue;
        const j = adj[e];
        if (placed[j]) continue;
        const d = --indeg[j];
        if (d === 0) {
          order[tail++] = j;
          placed[j] = 1;
        } else {
          q[bTail[d]++] = j;
          if (d < minB) minB = d;
        }
      }
    }
    if (tail >= n) break;
    for (;;) {
      while (bHead[minB] === bTail[minB]) minB++;
      const c = q[bHead[minB]++];
      if (!placed[c] && indeg[c] === minB) {
        order[tail++] = c;
        placed[c] = 1;
        break;
      }
    }
  }
  return order;
}
