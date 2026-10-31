import { type Mesh, findCell } from '../../core/mesh';
import { viewOf } from '../../core/sphere';

// ---------- 离边界远的格（第三十九轮）----------
// 合成着色器画省界、国界、帝国的外沿时，每个像素在周围的环上取几个点（provAt），看取到的格是不是另一个省、国家、集团。
// 离边界远的像素取到的格都连不成线：这里给每格记“往外几步之内没有会与它连成线的格”，着色器在保证得了的时候不取。
//
// 保证（开发说明“图层提速（第三十九轮）”）：
//   · 编号层画的是格的多边形（一块地区是网格的 Voronoi 多边形，整个星球是显示用的三角网的 Voronoi 多边形、左右再画几份），
//     这里叫“画出来的格”。图 G：画出来挨着的格连一条边（一块地区是网格的邻接；星球另加显示用的三角网里挨着的格）。
//   · ρ_h：画出来的格里，G 上隔 h 步的两格多边形之间最近的距离（地图单位，取遍整张网格的最小值，nearRho）。
//     从格 c 里一点 P 到 G 上隔 h 步以上的格里一点 Q 的线段，沿途经过的格在 G 上一步一步走，一定先经过隔 h 步的一格，
//     所以 |PQ| ≥ ρ_h：离 P 不到 ρ_h 的点都落在隔不到 h 步的格里。
//   · 对值为 A 的格，“危险”的格：带着与 A 同一类的另一个值（会与 A 连成线），或者总危险（两极的格、剪刀切过的格：切线附近会换格）。
//     一格带的值是它自己的值，水面格另带它的 landCellOf（画成陆地的像素找不到陆地格时取的格）的值。
//     每格记 H = 在 G 上离最近的危险的格几步（hopsByValue）：隔不到 H 步的格带的值都连不成线。
//   · 着色器里的像素 P 的格是 id、省份格 pc：pc 就是 id 时，环上的每个取样（半径 r 个像素）取到的格是：
//     扭曲后的那一格（离 P 不过 r）、它的 landCellOf；画成陆地、格是水面格时往外找的陆地格（没扭曲的位置再往外 0.6 格，
//     离 P 不过 |w| + r + 0.6 格）；画成水面、格是陆地格时往外找的水面格（离 P 不过 |w| + r + 1.2 格）。
//     再加两次编号层纹素的取整（各约 0.71 个场景像素）。前两种离 P 不过 rA = |w| + r + 0.6 格 + 取整，比 ρ_(H) 近；
//     后一种离 P 不过 rW = |w| + r + 1.2 格 + 取整，比 ρ_(H水) 近（H水 只数水面格）时，取到的格都画不出线：
//     直接跳过与照算的结果逐像素相同（near.test.ts 在真实的世界上逐像素对照）。

// 记几圈（着色器里 uNearRho 的长度 − 1）；ρ_h 按多边形算到 NEAR_EXACT 圈，再往外按 ρ_(a+b) ≥ ρ_a + ρ_b 推
export const NEAR_MAX = 12;
const NEAR_EXACT = 6;

// 画出来的格：每格的多边形（可以有几块：星球上接缝两边的副本、两极的影子点），坐标是编号层画的 float32
interface Drawn {
  // 第 c 格的几块：pieces[pieceOff[c] .. pieceOff[c + 1])，每块是 xy[off[k] .. off[k + 1]) 的 (x, y) 对
  pieceOff: Int32Array;
  pieces: Int32Array;
  off: Int32Array;
  xy: Float32Array;
  // 每块的外接矩形（x0, x1, y0, y1）与外接圆（圆心取矩形的中心：cx, cy, r）
  box: Float64Array;
  disc: Float64Array;
  // 整个星球：x 方向每 2 重复
  period: number;
}

// 图 G（CSR）：一块地区就是网格的邻接；整个星球另加显示用的三角网里挨着的两格
export interface NearGraph {
  off: Int32Array;
  adj: Int32Array;
}

const graphs = new WeakMap<Mesh, NearGraph>();
export function nearGraph(mesh: Mesh): NearGraph {
  const hit = graphs.get(mesh);
  if (hit) return hit;
  let g: NearGraph = { off: mesh.off, adj: mesh.adj };
  if (mesh.kind === 'sphere') {
    // 显示用的三角网的每条边换成两格（格号小的 · n + 大的），去掉同一格、网格里本来就挨着的，排序去重
    const view = viewOf(mesh);
    const t = view.delaunay.triangles;
    const n = mesh.n;
    const pairs: number[] = [];
    for (let k = 0; k < t.length; k++) {
      const a = view.cellOf[t[k]];
      const b = view.cellOf[t[k % 3 === 2 ? k - 2 : k + 1]];
      if (a === b) continue;
      let near = false;
      for (let e = mesh.off[a]; e < mesh.off[a + 1] && !near; e++) near = mesh.adj[e] === b;
      if (!near) pairs.push(a < b ? a * n + b : b * n + a);
    }
    if (pairs.length) {
      const sorted = Float64Array.from(pairs).sort();
      const extra = new Int32Array(n + 1);
      const uniq: number[] = [];
      for (let k = 0; k < sorted.length; k++) {
        if (k && sorted[k] === sorted[k - 1]) continue;
        const a = Math.floor(sorted[k] / n);
        const b = sorted[k] - a * n;
        uniq.push(a, b);
        extra[a + 1]++;
        extra[b + 1]++;
      }
      const off = new Int32Array(n + 1);
      for (let i = 0; i < n; i++) off[i + 1] = off[i] + (mesh.off[i + 1] - mesh.off[i]) + extra[i + 1];
      const adj = new Int32Array(off[n]);
      const fill = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        let o = off[i];
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) adj[o++] = mesh.adj[e];
        fill[i] = o;
      }
      for (let k = 0; k < uniq.length; k += 2) {
        adj[fill[uniq[k]]++] = uniq[k + 1];
        adj[fill[uniq[k + 1]]++] = uniq[k];
      }
      g = { off, adj };
    }
  }
  graphs.set(mesh, g);
  return g;
}

function drawnCells(mesh: Mesh): Drawn {
  const n = mesh.n;
  let off: Int32Array;
  let xy: Float32Array;
  let cellOfPiece: Int32Array;
  if (mesh.kind === 'sphere') {
    const p = viewOf(mesh).polygons();
    off = p.off;
    xy = p.xy;
    cellOfPiece = p.cell;
  } else {
    off = mesh.polyOff;
    xy = mesh.poly;
    cellOfPiece = Int32Array.from({ length: n }, (_, i) => i);
  }
  const m = off.length - 1;
  const count = new Int32Array(n + 1);
  for (let k = 0; k < m; k++) if (off[k + 1] > off[k]) count[cellOfPiece[k] + 1]++;
  for (let i = 0; i < n; i++) count[i + 1] += count[i];
  const pieces = new Int32Array(count[n]);
  const fill = count.slice(0, n);
  const box = new Float64Array(4 * m);
  const disc = new Float64Array(3 * m);
  for (let k = 0; k < m; k++) {
    if (off[k + 1] <= off[k]) continue;
    pieces[fill[cellOfPiece[k]]++] = k;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (let v = off[k]; v < off[k + 1]; v++) {
      x0 = Math.min(x0, xy[2 * v]);
      x1 = Math.max(x1, xy[2 * v]);
      y0 = Math.min(y0, xy[2 * v + 1]);
      y1 = Math.max(y1, xy[2 * v + 1]);
    }
    box.set([x0, x1, y0, y1], 4 * k);
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    let r = 0;
    for (let v = off[k]; v < off[k + 1]; v++) r = Math.max(r, Math.hypot(xy[2 * v] - cx, xy[2 * v + 1] - cy));
    disc.set([cx, cy, r], 3 * k);
  }
  return { pieceOff: count, pieces, off, xy, box, disc, period: mesh.kind === 'sphere' ? 2 : 0 };
}

// 点 (px, py) 到线段 (ax, ay)–(bx, by) 的距离的平方
function segDist2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l = dx * dx + dy * dy;
  let t = l > 0 ? ((px - ax) * dx + (py - ay) * dy) / l : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + t * dx - px;
  const ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

// 两块凸多边形（不相交，可以相碰）之间最近的距离的平方：一块的顶点到另一块的边，两个方向都看；第二块整体挪 sx
function pieceDist2(D: Drawn, a: number, b: number, sx: number, best: number): number {
  const { off, xy } = D;
  let d = best;
  for (let pass = 0; pass < 2; pass++) {
    const p = pass ? b : a;
    const q = pass ? a : b;
    const ps = pass ? sx : 0;
    const qs = pass ? 0 : sx;
    for (let v = off[p]; v < off[p + 1]; v++) {
      const px = xy[2 * v] + ps;
      const py = xy[2 * v + 1];
      for (let e = off[q]; e < off[q + 1]; e++) {
        const f = e + 1 < off[q + 1] ? e + 1 : off[q];
        const s = segDist2(px, py, xy[2 * e] + qs, xy[2 * e + 1], xy[2 * f] + qs, xy[2 * f + 1]);
        if (s < d) d = s;
      }
    }
  }
  return d;
}

// 多边形之间距离的下界：两块外接矩形之间、外接圆之间的距离取大的，第二块挪 sx
function boxDist(D: Drawn, a: number, b: number, sx: number): number {
  const A = 4 * a;
  const B = 4 * b;
  const gx = Math.max(0, D.box[B] + sx - D.box[A + 1], D.box[A] - D.box[B + 1] - sx);
  const gy = Math.max(0, D.box[B + 2] - D.box[A + 3], D.box[A + 2] - D.box[B + 3]);
  const ex = D.disc[3 * b] + sx - D.disc[3 * a];
  const ey = D.disc[3 * b + 1] - D.disc[3 * a + 1];
  const dc = Math.sqrt(ex * ex + ey * ey) - D.disc[3 * a + 2] - D.disc[3 * b + 2];
  return Math.max(Math.sqrt(gx * gx + gy * gy), dc);
}

// 格 c、d 画出来的多边形之间最近的距离；比 best 远时可以只给 best（剪枝）
function cellDist(D: Drawn, c: number, d: number, best: number): number {
  let out = best;
  for (let i = D.pieceOff[c]; i < D.pieceOff[c + 1]; i++) {
    const a = D.pieces[i];
    for (let j = D.pieceOff[d]; j < D.pieceOff[d + 1]; j++) {
      const b = D.pieces[j];
      // 整个星球：第二块挪到离第一块最近的那一份，再看左右各一份（两极附近的格横跨很宽）
      const base = D.period ? -D.period * Math.round((D.box[4 * b] + D.box[4 * b + 1] - D.box[4 * a] - D.box[4 * a + 1]) / (2 * D.period)) : 0;
      // 左右的那两份离得比一周的一半还远，只有两块加起来很宽（两极的格）时才可能更近
      const s1 = D.period && D.box[4 * a + 1] - D.box[4 * a] + D.box[4 * b + 1] - D.box[4 * b] > 0.5 * D.period ? 1 : 0;
      for (let s = -s1; s <= s1; s++) {
        const sx = base + s * D.period;
        if (boxDist(D, a, b, sx) >= out) continue;
        const d2 = pieceDist2(D, a, b, sx, out * out);
        if (d2 < out * out) out = Math.sqrt(d2);
      }
    }
  }
  return out;
}

// ρ_h（h = 0 .. NEAR_MAX，地图单位）：G 上隔 h 步的两格画出来的多边形之间最近的距离，取遍整张网格。
// ρ_0 = −1（自己不稳），ρ_1 = 0（挨着）。按网格记住。一块地区 4 万格约 0.25 秒、类地星球约 0.6 秒：
// 渲染器在空闲时分几步算（nearRhoStep），算好之前不跳过；测试、导出直接算完（nearRho）
interface RhoJob {
  D: Drawn;
  G: NearGraph;
  fixed: Uint8Array;
  // 每格离总不稳的格几步：从一格往外数到那一圈就停
  reach: Uint8Array;
  best: Float64Array;
  mark: Int32Array;
  // 一圈圈往外：queue[ring0 .. ring1) 是这一圈
  queue: Int32Array;
  c: number;
}
const rhos = new WeakMap<Mesh, Float64Array>();
const jobs = new WeakMap<Mesh, RhoJob>();
export function nearRho(mesh: Mesh): Float64Array {
  return nearRhoStep(mesh, Infinity)!;
}
// 算 ms 毫秒左右；算完了返回 ρ，没算完返回 null（下次接着算）
export function nearRhoStep(mesh: Mesh, ms: number): Float64Array | null {
  const hit = rhos.get(mesh);
  if (hit) return hit;
  const t0 = performance.now();
  const n = mesh.n;
  let J = jobs.get(mesh);
  if (!J) {
    const G = nearGraph(mesh);
    const fixed = nearFixed(mesh);
    const reach = new Uint8Array(n).fill(255);
    hops(G, n, fixed, reach, 0, 1);
    J = { D: drawnOf(mesh), G, fixed, reach, best: new Float64Array(NEAR_EXACT + 1).fill(Infinity), mark: new Int32Array(n).fill(-1), queue: new Int32Array(n), c: 0 };
    jobs.set(mesh, J);
  }
  const { D, G, fixed, reach, best, mark, queue } = J;
  for (; J.c < n; J.c++) {
    const c = J.c;
    if ((c & 255) === 0 && performance.now() - t0 > ms) return null;
    if (fixed[c] || D.pieceOff[c + 1] === D.pieceOff[c]) continue;
    mark[c] = c;
    queue[0] = c;
    let ring0 = 0;
    let ring1 = 1;
    for (let h = 1; h <= NEAR_EXACT; h++) {
      let tail = ring1;
      let stop = false;
      for (let q = ring0; q < ring1; q++) {
        const u = queue[q];
        for (let e: number = G.off[u]; e < G.off[u + 1]; e++) {
          const v = G.adj[e];
          if (mark[v] === c) continue;
          mark[v] = c;
          queue[tail++] = v;
          if (fixed[v]) stop = true;
        }
      }
      // 每一对算一次：两边都数得到这一圈时从格号小的一边算，只有一边数得到时从那一边算。
      // 隔两步的两格常常碰在一个顶点上（ρ_2 = 0），不算；下界已经不比现在最近的近时不算多边形
      if (h >= 3) {
        for (let q = ring1; q < tail; q++) {
          const d = queue[q];
          if (d > c || reach[d] < h) best[h] = cellDist(D, c, d, best[h]);
        }
      }
      // 这一圈有总不稳的格：c 的 H 不会超过 h，再往外的几圈用不着（也不经过两极的格把整个极圈都数进来）
      if (stop) break;
      ring0 = ring1;
      ring1 = tail;
    }
  }
  const rho = new Float64Array(NEAR_MAX + 1);
  rho[0] = -1;
  rho[1] = 0;
  for (let h = 2; h <= NEAR_MAX; h++) {
    // 隔 h 步以上的格一定经过隔 h 步的格：ρ_h 也是到隔 h 步以上的格的下界；h 大时按 ρ_(a+b) ≥ ρ_a + ρ_b 推
    let r = h <= NEAR_EXACT && Number.isFinite(best[h]) ? best[h] : 0;
    for (let a = 1; a < h; a++) r = Math.max(r, rho[a] + rho[h - a]);
    // 不比少一步的近（单调）
    rho[h] = Math.max(r, rho[h - 1]);
  }
  rhos.set(mesh, rho);
  jobs.delete(mesh);
  return rho;
}

// 总算不稳的格（只按网格）：整个星球两极的那两格（在图上是两极的一整行影子点，画出来有几百块、挨着整整一圈的格）。
// nearLayer 把它们记成不稳，nearRho 不从它们往外数、数到它们就停：H ≥ h 的格隔不到 h 步的格里没有它们
const fixeds = new WeakMap<Mesh, Uint8Array>();
const FIXED_WIDE = 4;
export function nearFixed(mesh: Mesh): Uint8Array {
  let f = fixeds.get(mesh);
  if (!f) {
    f = new Uint8Array(mesh.n);
    if (mesh.kind === 'sphere') {
      f[mesh.north] = 1;
      f[mesh.south] = 1;
      // 高纬（画出来比 FIXED_WIDE 格还宽）的格：外接矩形太宽，算 ρ 时剪不了枝
      const D = drawnOf(mesh);
      for (let c = 0; c < mesh.n; c++) {
        for (let i = D.pieceOff[c]; i < D.pieceOff[c + 1]; i++) {
          const k = D.pieces[i];
          if (D.box[4 * k + 1] - D.box[4 * k] > FIXED_WIDE * mesh.spacing) f[c] = 1;
        }
      }
    }
    fixeds.set(mesh, f);
  }
  return f;
}

// H：每格在 G 上离最近的不稳的格几步（不稳的格 0；一个不稳的都没有时 255），写进 out 的第 ch 个字节（每格 stride 个）
function hops(G: NearGraph, n: number, bad: Uint8Array, out: Uint8Array, ch: number, stride = 4) {
  const dist = new Uint8Array(n).fill(255);
  const queue = new Int32Array(n);
  let tail = 0;
  for (let i = 0; i < n; i++) {
    if (!bad[i]) continue;
    dist[i] = 0;
    queue[tail++] = i;
  }
  for (let head = 0; head < tail; head++) {
    const u = queue[head];
    const h = dist[u] + 1;
    if (h >= 255) break;
    for (let e = G.off[u]; e < G.off[u + 1]; e++) {
      const v = G.adj[e];
      if (dist[v] !== 255) continue;
      dist[v] = h;
      queue[tail++] = v;
    }
  }
  for (let i = 0; i < n; i++) out[stride * i + ch] = dist[i];
}

// 一个值属于哪一类（与着色器的边界规则相同：只有同一类里两个不同的值之间才画线）；−1 是哪一类都不是（连不成线）。
//   省界：陆地省（> 0）一类，别的（海省 < 0、未划分 0）一类；国界：陆地（0 无主，正的是国家）一类，领海（≥ 65535.5）一类，
//   不归谁的海（−1）不算；帝国的外沿：≥ 0 的都是一类，海（−1）不算
const FIELD_PROVINCE = 0;
const FIELD_COUNTRY = 1;
const FIELD_BLOC = 2;
function classOf(field: number, v: number): number {
  if (field === FIELD_PROVINCE) return v > 0 ? 1 : 0;
  if (field === FIELD_COUNTRY) return v < 0 ? -1 : v >= 65535.5 ? 1 : 0;
  return v < 0 ? -1 : 0;
}

// H：每格往外几步之内没有“危险”的格（危险的格就在自己这里时 0；最多记 15）。
// 对值为 A（第 K 类）的格，危险的格是：带着第 K 类里另一个值（≠ A）的格，或者总不稳的格（两极、剪刀切过的格）。
// 一格带的值：自己的值；水面格另带它的 landCellOf 的值（画成陆地的像素在附近找不到陆地格时取那一格）。
// water：只数水面格带的自己的值（provCell 给画成水面的像素往外 1.2 格找的只有水面格；总不稳的格照样算）。
// 别的类的值（陆地省旁边的海省、国家旁边不归谁的海……）连不成线，不算危险。
// 按类各做一遍多源的广度优先：每格记离它最近的两个不同的值与距离，A 的格的 H 就是离它最近的另一个值的距离。
// 写进 out 的第 ch 个字节的低四位（water 时高四位）
// 广度优先用的几张表（一次 nearLayer 里各遍共用）：每格离它最近的两个不同的值与距离，队列（每格最多进两次）
interface HopScratch {
  l1: Float64Array;
  l2: Float64Array;
  d1: Uint8Array;
  d2: Uint8Array;
  qn: Int32Array;
  ql: Float64Array;
  qd: Uint8Array;
  tail: number;
}
const NONE = 255;
function hopScratch(n: number): HopScratch {
  return { l1: new Float64Array(n), l2: new Float64Array(n), d1: new Uint8Array(n), d2: new Uint8Array(n), qn: new Int32Array(2 * n), ql: new Float64Array(2 * n), qd: new Uint8Array(2 * n), tail: 0 };
}
// 一格收下一个值（与它已经记的不同、还没记满两个时），收下了进队
function takeLabel(S: HopScratch, i: number, L: number, d: number) {
  if (S.d1[i] === NONE) {
    S.l1[i] = L;
    S.d1[i] = d;
  } else if (S.d2[i] === NONE && !(L === S.l1[i])) {
    S.l2[i] = L;
    S.d2[i] = d;
  } else return;
  S.qn[S.tail] = i;
  S.ql[S.tail] = L;
  S.qd[S.tail++] = d;
}

function hopsByValue(G: NearGraph, n: number, vals: Float32Array, k: number, field: number, cut: Uint8Array, coast: Float32Array, land: Int32Array | null, water: boolean, out: Uint8Array, ch: number, S: HopScratch) {
  const U = Number.NaN;
  const shift = water ? 4 : 0;
  for (let K = 0; K < (field === FIELD_BLOC ? 1 : 2); K++) {
    S.d1.fill(NONE);
    S.d2.fill(NONE);
    S.tail = 0;
    for (let i = 0; i < n; i++) {
      if (cut[i]) {
        takeLabel(S, i, U, 0);
        continue;
      }
      if (water && !(coast[i] < 0)) continue;
      const v = vals[2 * i + k];
      if (classOf(field, v) === K) takeLabel(S, i, v, 0);
      if (!water && land && coast[i] < 0 && land[i] >= 0) {
        const lv = vals[2 * land[i] + k];
        if (classOf(field, lv) === K) takeLabel(S, i, lv, 0);
      }
    }
    for (let head = 0; head < S.tail; head++) {
      const u = S.qn[head];
      const L = S.ql[head];
      const d = S.qd[head] + 1;
      // H 最多记 15：再远的不用传（没收到第二个值的格记 15）
      if (d > 15) continue;
      for (let e = G.off[u]; e < G.off[u + 1]; e++) takeLabel(S, G.adj[e], L, d);
    }
    const { l1, d1, d2 } = S;
    for (let i = 0; i < n; i++) {
      const v = vals[2 * i + k];
      if (cut[i] || classOf(field, v) !== K) continue;
      // 自己的值在这一类：离它最近的另一个值（最近的就是自己的值时看第二个）
      const h = l1[i] === v ? d2[i] : d1[i];
      out[4 * i + ch] |= (h < 15 ? h : 15) << shift;
    }
  }
}

// 一层的值都一样（比如不是国家模式时集团的那一层全是 0）、没有总危险的格时，每格都是 15
function uniform(vals: Float32Array, k: number, n: number, cut: Uint8Array): boolean {
  const v0 = vals[k];
  for (let i = 0; i < n; i++) if (cut[i] || vals[2 * i + k] !== v0) return false;
  return true;
}

// landCellOf 的表（colors.ts 的 landCellLayer：格号 + 1 写在 rgb）
function landTable(landCell: Uint8Array | null | undefined, n: number): Int32Array | null {
  if (!landCell) return null;
  const t = new Int32Array(n);
  for (let i = 0; i < n; i++) t[i] = landCell[4 * i] + landCell[4 * i + 1] * 256 + landCell[4 * i + 2] * 65536 - 1;
  return t;
}

// 每格 RGBA 字节：r 省份（分组）、g 国家、b 集团往外几步之内没有会与它连成线的格（见 hopsByValue）：
// 低四位数全部的格，高四位只数水面格；没有那一层时 0。
// group、country 是合成着色器读的分组、国界的分组（每格两个值），coast 是它读的海岸值（< 0 是水面格），landCell 是 landCellOf 的表
export function nearLayer(mesh: Mesh, group: Float32Array | null, country: Float32Array | null | undefined, coast: Float32Array, landCell: Uint8Array | null | undefined): Uint8Array {
  const job = nearLayerSteps(mesh, group, country, coast, landCell);
  for (const step of job.steps) step();
  return job.out;
}

// 同 nearLayer，分成几步（每一层的陆海两类各一步，每步约几毫秒）：渲染器在空闲时一步一步做，每步之间让出线程
export function nearLayerSteps(mesh: Mesh, group: Float32Array | null, country: Float32Array | null | undefined, coast: Float32Array, landCell: Uint8Array | null | undefined): { out: Uint8Array; steps: (() => void)[] } {
  const n = mesh.n;
  const G = nearGraph(mesh);
  const out = new Uint8Array(n * 4);
  const land = landTable(landCell, n);
  // 总危险的格：两极的格、剪刀切过的格（切线附近会换成另一边的格）
  const cut = nearFixed(mesh).slice();
  if (group) for (let i = 0; i < n; i++) if (group[2 * i + 1] >= 0.5) cut[i] = 1;
  const S = hopScratch(n);
  const steps: (() => void)[] = [];
  const pass = (vals: Float32Array, k: number, field: number, ch: number) => {
    if (uniform(vals, k, n, cut)) {
      steps.push(() => {
        for (let i = 0; i < n; i++) out[4 * i + ch] = 0xff;
      });
      return;
    }
    steps.push(() => hopsByValue(G, n, vals, k, field, cut, coast, land, false, out, ch, S));
    steps.push(() => hopsByValue(G, n, vals, k, field, cut, coast, land, true, out, ch, S));
  };
  if (group) pass(group, 0, FIELD_PROVINCE, 0);
  if (country) {
    pass(country, 0, FIELD_COUNTRY, 1);
    pass(country, 1, FIELD_BLOC, 2);
  }
  return { out, steps };
}

// ---------- 测试用：画出来的格 ----------

// 一点 (x, y)（地图单位）落在画出来的哪一格（编号层的规则：多边形；整个星球 x 每 2 重复）；不在任何格里时 −1。
// hint：上一次找到的一格（先看它，不是时从最近的格往外几圈找）
export function drawnCellAt(mesh: Mesh, x: number, y: number, hint: number): number {
  const D = drawnOf(mesh);
  const G = nearGraph(mesh);
  const xs = D.period ? x - D.period * Math.floor(x / D.period) : x;
  const inside = (k: number, px: number) => {
    const { off, xy } = D;
    let sign = 0;
    for (let v = off[k]; v < off[k + 1]; v++) {
      const f = v + 1 < off[k + 1] ? v + 1 : off[k];
      const cr = (xy[2 * f] - xy[2 * v]) * (y - xy[2 * v + 1]) - (xy[2 * f + 1] - xy[2 * v + 1]) * (px - xy[2 * v]);
      if (cr === 0) continue;
      const s = cr > 0 ? 1 : -1;
      if (sign && s !== sign) return false;
      sign = s;
    }
    return true;
  };
  const test = (c: number) => {
    for (let i = D.pieceOff[c]; i < D.pieceOff[c + 1]; i++) {
      const k = D.pieces[i];
      for (const sx of D.period ? [0, D.period, -D.period] : [0]) {
        const px = xs + sx;
        if (px < D.box[4 * k] || px > D.box[4 * k + 1] || y < D.box[4 * k + 2] || y > D.box[4 * k + 3]) continue;
        if (inside(k, px)) return true;
      }
    }
    return false;
  };
  if (hint >= 0 && hint < mesh.n && test(hint)) return hint;
  // 从最近的格（Voronoi 的规则）往外几圈找：画出来的多边形是 float32 的，边上差一点
  const start = findCell(mesh, x, Math.min(mesh.height, Math.max(0, y)), hint >= 0 && hint < mesh.n ? hint : 0);
  const seen = new Set<number>([start]);
  let ring = [start];
  for (let r = 0; r < 4; r++) {
    for (const c of ring) if (test(c)) return c;
    const next: number[] = [];
    for (const u of ring) {
      for (let e = G.off[u]; e < G.off[u + 1]; e++) {
        const v = G.adj[e];
        if (seen.has(v)) continue;
        seen.add(v);
        next.push(v);
      }
    }
    ring = next;
  }
  return -1;
}
const drawns = new WeakMap<Mesh, Drawn>();
function drawnOf(mesh: Mesh): Drawn {
  let d = drawns.get(mesh);
  if (!d) drawns.set(mesh, (d = drawnCells(mesh)));
  return d;
}
