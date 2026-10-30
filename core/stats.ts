import type { World } from './world';

// 地形的统计量，用于检验生成结果是否符合真实世界的分布规律（测试与 tools/terrain-stats.ts 共用）
export interface TerrainStats {
  landFraction: number;
  landmasses: number;
  // 最大陆块占全部陆地面积的比例
  largestShare: number;
  // 除最大的几块大陆之外的陆块（面积小于最大陆块 5%）
  islands: number;
  // 岛屿面积累积分布 N(>A) ∝ A^-k 的拟合指数
  powerLawK: number;
  // 海岸边数 / 等面积圆的周长（以格边计）
  coastRoughness: number;
  // 每个陆块的面积（格数），从大到小
  sizes: number[];
}

function landmassSizes(world: World): number[] {
  const { mesh, causes } = world;
  const comp = new Int32Array(mesh.n).fill(-1);
  const sizes: number[] = [];
  for (let i = 0; i < mesh.n; i++) {
    if (!causes.land[i] || comp[i] >= 0) continue;
    const q = [i];
    comp[i] = sizes.length;
    for (let h = 0; h < q.length; h++) {
      const a = q[h];
      for (let e = mesh.off[a]; e < mesh.off[a + 1]; e++) {
        const b = mesh.adj[e];
        if (causes.land[b] && comp[b] < 0) {
          comp[b] = sizes.length;
          q.push(b);
        }
      }
    }
    sizes.push(q.length);
  }
  return sizes.sort((a, b) => b - a);
}

export function terrainStats(world: World): TerrainStats {
  const { mesh, causes } = world;
  const sizes = landmassSizes(world);
  const land = sizes.reduce((a, b) => a + b, 0);
  let coastEdges = 0;
  for (let i = 0; i < mesh.n; i++) {
    if (!causes.land[i]) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (!causes.land[mesh.adj[e]]) coastEdges++;
  }
  const islandSizes = sizes.filter((s) => s < (sizes[0] ?? 0) * 0.05);
  return {
    landFraction: land / mesh.n,
    landmasses: sizes.length,
    largestShare: land ? sizes[0] / land : 0,
    islands: islandSizes.length,
    powerLawK: fitPowerLaw(islandSizes),
    coastRoughness: land ? coastEdges / (2 * Math.sqrt(Math.PI * land)) : 0,
    sizes,
  };
}

// 对 log N(>A) ~ -k log A 做最小二乘（只用 A ≥ 2 的点，单格岛受格子离散影响太大）
function fitPowerLaw(sizes: number[]): number {
  const s = sizes.filter((a) => a >= 2).sort((a, b) => b - a);
  if (s.length < 8) return NaN;
  const xs: number[] = [];
  const ys: number[] = [];
  s.forEach((a, k) => {
    if (k > 0 && s[k - 1] === a) return;
    xs.push(Math.log(a));
    ys.push(Math.log(k + 1));
  });
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let k = 0; k < n; k++) {
    sxy += (xs[k] - mx) * (ys[k] - my);
    sxx += (xs[k] - mx) ** 2;
  }
  return sxx > 0 ? -sxy / sxx : NaN;
}

// ======================================================================================
// 第三十一轮：和地球比的统计（tools/realism-report.ts 用；第三十二到三十五轮的测试按它们定区间）
// 都是纯函数：先把世界整理成 StatsInput（statsInput），统计只看这几个数组，所以单元测试能用手搭的小网
// ======================================================================================

// 最小二乘直线 y = intercept + slope·x
export function linearFit(xs: ArrayLike<number>, ys: ArrayLike<number>): { slope: number; intercept: number; r2: number } {
  const n = xs.length;
  if (n < 2) return { slope: NaN, intercept: NaN, r2: NaN };
  let mx = 0;
  let my = 0;
  for (let k = 0; k < n; k++) {
    mx += xs[k];
    my += ys[k];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let k = 0; k < n; k++) {
    sxy += (xs[k] - mx) * (ys[k] - my);
    sxx += (xs[k] - mx) ** 2;
    syy += (ys[k] - my) ** 2;
  }
  if (!(sxx > 0)) return { slope: NaN, intercept: NaN, r2: NaN };
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, r2: syy > 0 ? (sxy * sxy) / (sxx * syy) : 1 };
}

// 超越概率的幂律指数：P(V ≥ v) ∝ v^−τ，在 [lo, hi] 里按对数等距取 points 个点拟合 τ。有效的点少于 3 个时 NaN
export function exceedanceExponent(values: ArrayLike<number>, lo: number, hi: number, points = 12): number {
  const v = Float64Array.from(values).sort();
  const n = v.length;
  if (!n || !(hi > lo) || !(lo > 0)) return NaN;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let k = 0; k < points; k++) {
    const a = lo * Math.pow(hi / lo, k / (points - 1));
    // 第一个 ≥ a 的下标（二分）
    let l = 0;
    let r = n;
    while (l < r) {
      const m = (l + r) >> 1;
      if (v[m] < a) l = m + 1;
      else r = m;
    }
    const count = n - l;
    if (count < 1) break;
    xs.push(Math.log(a));
    ys.push(Math.log(count / n));
  }
  return xs.length >= 3 ? -linearFit(xs, ys).slope : NaN;
}

// 大小的幂律 N(>A) ∝ A^−k（湖、岛）：与 terrainStats 的 powerLawK 同一个拟合（A 以格为单位，只用 ≥ 2 的，少于 8 个时 NaN）
export const sizePowerLaw = fitPowerLaw;

// 盒维数：mask 里标 1 的像素（海岸线），格子边长 sizes（像素）时有 N 个格子里有它，log N 对 log(1/s) 的斜率。
// rows：只数这几行（整个星球只看中低纬，等距圆柱的高纬被拉宽）
export function boxCountDimension(mask: Uint8Array, width: number, height: number, sizes = [2, 4, 8, 16, 32, 64], rows: [number, number] = [0, height]): number {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of sizes) {
    const bw = Math.ceil(width / s);
    const seen = new Uint8Array(bw * Math.ceil(height / s));
    let count = 0;
    for (let y = rows[0]; y < rows[1]; y++) {
      const row = y * width;
      const brow = Math.floor(y / s) * bw;
      for (let x = 0; x < width; x++) {
        if (!mask[row + x]) continue;
        const b = brow + Math.floor(x / s);
        if (!seen[b]) {
          seen[b] = 1;
          count++;
        }
      }
    }
    if (count > 0) {
      xs.push(Math.log(1 / s));
      ys.push(Math.log(count));
    }
  }
  return xs.length >= 3 ? linearFit(xs, ys).slope : NaN;
}

// 栅格的海岸线：陆地像素里四邻有海的（wrap：左右两边相接，整个星球）
export function coastPixels(land: Uint8Array, width: number, height: number, wrap = false): Uint8Array {
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (!land[p]) continue;
      const l = x > 0 ? p - 1 : wrap ? p + width - 1 : -1;
      const r = x < width - 1 ? p + 1 : wrap ? p - width + 1 : -1;
      const u = y > 0 ? p - width : -1;
      const d = y < height - 1 ? p + width : -1;
      if ((l >= 0 && !land[l]) || (r >= 0 && !land[r]) || (u >= 0 && !land[u]) || (d >= 0 && !land[d])) out[p] = 1;
    }
  }
  return out;
}

// 统计要用的世界数据（都按格）：
//   land 陆地（湖面算陆地）；elevation 地面的高程（m，湖格用水面）；receiver 下游的陆格（-1 没有：流进海、在终点消失）；
//   stepKm 到下游的距离；areaKm 面积；lake 0 / 1 湖面 / 2 干涸的内流湖底；off、adj、distKm（km）是网格的邻接；
//   edge 地图的边（一块地区的边上的格：水从这里流出地图，不算内流）
export interface StatsInput {
  n: number;
  land: Uint8Array;
  edge: Uint8Array;
  elevation: Float64Array;
  receiver: Int32Array;
  stepKm: Float64Array;
  areaKm: Float64Array;
  lake: Uint8Array;
  off: Int32Array;
  adj: Int32Array;
  distKm: Float64Array;
}

export function statsInput(world: World): StatsInput {
  const { mesh, causes, derived: d, kmPerUnit } = world;
  const n = mesh.n;
  const elevation = new Float64Array(n);
  const receiver = new Int32Array(n).fill(-1);
  const stepKm = new Float64Array(n);
  const areaKm = new Float64Array(n);
  const distKm = new Float64Array(mesh.adj.length);
  for (let e = 0; e < mesh.adj.length; e++) distKm[e] = mesh.dist[e] * kmPerUnit;
  for (let i = 0; i < n; i++) {
    areaKm[i] = mesh.area[i] * kmPerUnit * kmPerUnit;
    if (!causes.land[i]) {
      elevation[i] = d.elevation[i];
      continue;
    }
    elevation[i] = d.lake[i] === 1 ? Math.max(d.elevation[i], d.water[i]) : d.elevation[i];
    const j = d.receiver[i];
    if (j < 0 || !causes.land[j]) continue;
    receiver[i] = j;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (mesh.adj[e] === j) stepKm[i] = distKm[e];
  }
  return { n, land: causes.land, edge: mesh.boundary, elevation, receiver, stepKm, areaKm, lake: d.lake, off: mesh.off, adj: mesh.adj, distKm };
}

// 高度分布（陆地，按面积）
export interface Hypsometry {
  below200: number;
  below500: number;
  above2000: number;
  meanM: number;
}
export function hypsometry(s: StatsInput): Hypsometry {
  let total = 0;
  let a200 = 0;
  let a500 = 0;
  let a2000 = 0;
  let sum = 0;
  for (let i = 0; i < s.n; i++) {
    if (!s.land[i]) continue;
    const a = s.areaKm[i];
    const h = s.elevation[i];
    total += a;
    sum += a * h;
    if (h < 200) a200 += a;
    if (h < 500) a500 += a;
    if (h > 2000) a2000 += a;
  }
  return total ? { below200: a200 / total, below500: a500 / total, above2000: a2000 / total, meanM: sum / total } : { below200: 0, below500: 0, above2000: 0, meanM: 0 };
}

// 陆格的拓扑序：出口（没有下游的陆格）在前，每格排在它的下游之后
function upstreamOrder(s: StatsInput): Int32Array {
  const { n, land, receiver } = s;
  const head = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) if (land[i] && receiver[i] >= 0) head[receiver[i] + 1]++;
  for (let i = 0; i < n; i++) head[i + 1] += head[i];
  const up = new Int32Array(head[n]);
  const fill = head.slice(0, n);
  for (let i = 0; i < n; i++) if (land[i] && receiver[i] >= 0) up[fill[receiver[i]]++] = i;
  const order: number[] = [];
  for (let i = 0; i < n; i++) if (land[i] && receiver[i] < 0) order.push(i);
  for (let q = 0; q < order.length; q++) {
    const c = order[q];
    for (let k = head[c]; k < head[c + 1]; k++) order.push(up[k]);
  }
  return Int32Array.from(order);
}

// 流域（按出口）：面积、最长流路（km，从最远的格沿下游走到出口）与它的源头
export interface Basin {
  outlet: number;
  areaKm: number;
  lengthKm: number;
  source: number;
}
export interface Drainage {
  // 每格所在流域的出口（不是陆地的为 -1）
  outlet: Int32Array;
  // 每格的汇水面积（km²，含自己）
  drainKm: Float64Array;
  // 按面积从大到小
  basins: Basin[];
  landKm: number;
}
export function drainage(s: StatsInput): Drainage {
  const { n, land, receiver, stepKm, areaKm } = s;
  const order = upstreamOrder(s);
  const outlet = new Int32Array(n).fill(-1);
  const toOutlet = new Float64Array(n);
  const drainKm = new Float64Array(n);
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const j = receiver[i];
    outlet[i] = j >= 0 ? outlet[j] : i;
    toOutlet[i] = j >= 0 ? toOutlet[j] + stepKm[i] : 0;
  }
  for (let k = order.length - 1; k >= 0; k--) {
    const i = order[k];
    drainKm[i] += areaKm[i];
    const j = receiver[i];
    if (j >= 0) drainKm[j] += drainKm[i];
  }
  const byOutlet = new Map<number, Basin>();
  let landKm = 0;
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue;
    landKm += areaKm[i];
    const o = outlet[i];
    let b = byOutlet.get(o);
    if (!b) byOutlet.set(o, (b = { outlet: o, areaKm: 0, lengthKm: 0, source: o }));
    b.areaKm += areaKm[i];
    if (toOutlet[i] > b.lengthKm) {
      b.lengthKm = toOutlet[i];
      b.source = i;
    }
  }
  const basins = [...byOutlet.values()].sort((a, b) => b.areaKm - a.areaKm || a.outlet - b.outlet);
  return { outlet, drainKm, basins, landKm };
}

// Hack 律 L = c·A^h：用面积不小于 minKm 的流域按对数拟合 h。少于 5 个时 NaN
export function hackExponent(basins: Basin[], minKm: number): number {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const b of basins) {
    if (b.areaKm < minKm || !(b.lengthKm > 0)) continue;
    xs.push(Math.log(b.areaKm));
    ys.push(Math.log(b.lengthKm));
  }
  return xs.length >= 5 ? linearFit(xs, ys).slope : NaN;
}

export function median(values: number[]): number {
  if (!values.length) return NaN;
  const v = [...values].sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// 连通块（按网格的邻接）：inside(i) 的格连成的每一块
export function components(s: Pick<StatsInput, 'n' | 'off' | 'adj'>, inside: (i: number) => boolean): number[][] {
  const seen = new Uint8Array(s.n);
  const out: number[][] = [];
  for (let i = 0; i < s.n; i++) {
    if (seen[i] || !inside(i)) continue;
    const q = [i];
    seen[i] = 1;
    for (let h = 0; h < q.length; h++) {
      const c = q[h];
      for (let e = s.off[c]; e < s.off[c + 1]; e++) {
        const j = s.adj[e];
        if (!seen[j] && inside(j)) {
          seen[j] = 1;
          q.push(j);
        }
      }
    }
    out.push(q);
  }
  return out;
}

// 内流区：水流不到海的陆地（占陆地面积的比例）：沿下游会流进一片有干涸湖底（lake = 2：入流不够蒸发的内流湖）的洼地的，
// 或者终点在陆地中间（没有下游、不挨海、也不在地图边上：在终点消失的河）的
export function endorheicShare(s: StatsInput, d: Drainage): number {
  const { n, land, edge, receiver, lake, off, adj, areaKm } = s;
  const closed = new Uint8Array(n);
  for (const comp of components(s, (i) => land[i] === 1 && lake[i] !== 0)) {
    if (comp.some((c) => lake[c] === 2)) for (const c of comp) closed[c] = 1;
  }
  for (let i = 0; i < n; i++) {
    if (!land[i] || receiver[i] >= 0 || edge[i]) continue;
    let sea = false;
    for (let e = off[i]; e < off[i + 1]; e++) if (!land[adj[e]]) sea = true;
    if (!sea) closed[i] = 1;
  }
  const order = upstreamOrder(s);
  const endo = new Uint8Array(n);
  let km = 0;
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    const j = receiver[i];
    endo[i] = closed[i] || (j >= 0 && endo[j]) ? 1 : 0;
    if (endo[i]) km += areaKm[i];
  }
  return d.landKm ? km / d.landKm : 0;
}

// 高原指数：高于 minM、局部起伏小（与每个邻格的高差按距离折合到每 100 km 都不到 maxRelief 米）的陆地占陆地面积的比例
export function plateauShare(s: StatsInput, landKm: number, minM = 2500, maxRelief = 600): number {
  const { n, land, elevation, off, adj, distKm, areaKm } = s;
  let km = 0;
  for (let i = 0; i < n; i++) {
    if (!land[i] || elevation[i] <= minM) continue;
    let worst = 0;
    for (let e = off[i]; e < off[i + 1]; e++) {
      const j = adj[e];
      const h = land[j] ? elevation[j] : 0;
      worst = Math.max(worst, (Math.abs(h - elevation[i]) / distKm[e]) * 100);
    }
    if (worst < maxRelief) km += areaKm[i];
  }
  return landKm ? km / landKm : 0;
}

// 低平地（第三十三轮）：低于 maxM、平坦（与陆上邻格的高差按距离折合到每 100 km，平均不到 maxRelief 米）的陆地占陆地面积的比例
export function lowFlatShare(s: StatsInput, landKm: number, maxM = 200, maxRelief = 50): number {
  const { n, land, elevation, off, adj, distKm, areaKm } = s;
  let km = 0;
  for (let i = 0; i < n; i++) {
    if (!land[i] || elevation[i] >= maxM) continue;
    let sum = 0;
    let count = 0;
    for (let e = off[i]; e < off[i + 1]; e++) {
      const j = adj[e];
      if (!land[j]) continue;
      sum += (Math.abs(elevation[j] - elevation[i]) / distKm[e]) * 100;
      count++;
    }
    if (count && sum / count < maxRelief) km += areaKm[i];
  }
  return landKm ? km / landKm : 0;
}

// 大干流两旁（第三十三轮）：汇水面积 ≥ minKm、低于 maxM 的干流格（不是湖面），它的陆上邻格里不是河的那些（不是湖面、
// 汇水面积不到 riverKm：支流、同一条河的上下游不算）比它高多少（m，低的算 0）的平均。冲积平原上两旁几乎一样高
export function trunkRise(s: StatsInput, d: Drainage, minKm = 1e5, maxM = 300, riverKm = 2e4): number {
  const { n, land, lake, elevation, off, adj } = s;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!land[i] || lake[i] === 1 || d.drainKm[i] < minKm || elevation[i] >= maxM) continue;
    for (let e = off[i]; e < off[i + 1]; e++) {
      const j = adj[e];
      if (!land[j] || lake[j] === 1 || d.drainKm[j] >= riverKm) continue;
      sum += Math.max(0, elevation[j] - elevation[i]);
      count++;
    }
  }
  return count ? sum / count : NaN;
}

// 前 k 个流域里每个陆格的汇水面积
function inTop(s: StatsInput, d: Drainage, k: number): number[] {
  const top = new Set(d.basins.slice(0, k).map((b) => b.outlet));
  const out: number[] = [];
  for (let i = 0; i < s.n; i++) if (s.land[i] && top.has(d.outlet[i])) out.push(d.drainKm[i]);
  return out;
}

// 和地球比的一组统计（第三十一轮）。coastDim：海岸线的盒维数（要先栅格化，见 tools/realism-report.ts），不给时 NaN
export interface RealismStats {
  landShare: number;
  below200: number;
  below500: number;
  above2000: number;
  meanM: number;
  // 最大、前五个流域占陆地面积的比例
  basinTop1: number;
  basinTop5: number;
  // 最长的流路（km）与它除以所在陆块的等面积圆直径
  longestKm: number;
  longestPerDiameter: number;
  // Hack 律的指数（面积 ≥ 20 格的流域）
  hack: number;
  // 面积前十的流域 L/√A 的中位数
  lOverSqrtA: number;
  // 汇水面积的超越概率指数（10 格到最大流域的 1/20）
  exceedance: number;
  // 同一个指数只数前十个流域里的格（第三十二轮：地球的 0.43–0.45 是在大流域里量的，整个陆地还算上沿海的许多小流域）
  exceedanceBasins: number;
  endorheic: number;
  lakes: number;
  lakeShare: number;
  lakeSizeK: number;
  plateau: number;
  // 第三十三轮：低平地占比（200 m 以下、与邻格的起伏平均每 100 km 不到 50 m）、
  // 低处（300 m 以下）的大干流（A ≥ 10 万 km²）两旁不是河的格平均高出多少（m）
  lowFlat: number;
  trunkRise: number;
  coastDim: number;
}

export function realismStats(s: StatsInput, coastDim = NaN): RealismStats {
  const d = drainage(s);
  const hyps = hypsometry(s);
  let total = 0;
  let landCells = 0;
  for (let i = 0; i < s.n; i++) {
    total += s.areaKm[i];
    if (s.land[i]) landCells++;
  }
  const top = d.basins;
  const share = (k: number) => (d.landKm ? top.slice(0, k).reduce((a, b) => a + b.areaKm, 0) / d.landKm : 0);
  // 每格所在陆块（含湖面）的面积
  const massKm = new Float64Array(s.n);
  for (const m of components(s, (i) => s.land[i] === 1)) {
    let a = 0;
    for (const c of m) a += s.areaKm[c];
    for (const c of m) massKm[c] = a;
  }
  let longest: Basin | null = null;
  for (const b of top) if (!longest || b.lengthKm > longest.lengthKm) longest = b;
  const diameter = longest ? 2 * Math.sqrt(massKm[longest.outlet] / Math.PI) : 0;
  const cell = landCells ? d.landKm / landCells : 1;
  const drains: number[] = [];
  for (let i = 0; i < s.n; i++) if (s.land[i]) drains.push(d.drainKm[i]);
  const lakeKm = components(s, (i) => s.land[i] === 1 && s.lake[i] === 1).map((c) => c.reduce((a, k) => a + s.areaKm[k], 0));
  return {
    landShare: total ? d.landKm / total : 0,
    ...hyps,
    basinTop1: share(1),
    basinTop5: share(5),
    longestKm: longest?.lengthKm ?? 0,
    longestPerDiameter: longest && diameter ? longest.lengthKm / diameter : NaN,
    hack: hackExponent(top, 20 * cell),
    lOverSqrtA: median(top.slice(0, 10).filter((b) => b.areaKm > 0).map((b) => b.lengthKm / Math.sqrt(b.areaKm))),
    exceedance: exceedanceExponent(drains, 10 * cell, Math.max(20 * cell, (top[0]?.areaKm ?? 0) / 20)),
    exceedanceBasins: exceedanceExponent(inTop(s, d, 10), 10 * cell, Math.max(20 * cell, (top[0]?.areaKm ?? 0) / 20)),
    endorheic: endorheicShare(s, d),
    lakes: lakeKm.length,
    lakeShare: d.landKm ? lakeKm.reduce((a, b) => a + b, 0) / d.landKm : 0,
    lakeSizeK: fitPowerLaw(lakeKm.map((a) => a / cell)),
    plateau: plateauShare(s, d.landKm),
    lowFlat: lowFlatShare(s, d.landKm),
    trunkRise: trunkRise(s, d),
    coastDim,
  };
}

// 地球的参考值（tools/realism-report.ts 与生成的并排列出；出处与算法见开发说明“和地球比”）
export const EARTH_REFERENCE: Record<keyof RealismStats, string> = {
  landShare: '29%',
  below200: '≈25%',
  below500: '≈47%',
  above2000: '8–11%',
  meanM: '≈840',
  basinTop1: '4.7%',
  basinTop5: '≈14%',
  longestKm: '6650',
  longestPerDiameter: '0.75–1.35',
  hack: '0.5–0.6',
  lOverSqrtA: '≈3 (2.4–3.7)',
  exceedance: '0.43–0.45',
  exceedanceBasins: '0.43–0.45',
  endorheic: '≈18%',
  lakes: '—',
  lakeShare: '2–4%',
  lakeSizeK: '≈1 (0.8–1.2)',
  plateau: '≈2%',
  lowFlat: '—',
  trunkRise: '< 30',
  coastDim: '≈1.2 (1.02–1.5)',
};

// 一片格的长宽比（第三十二轮，裂谷湖用）：按面积加权的二阶矩的两个主轴，每格再算上自己（当成面积为 a 的方格，a/12）。
// 长 L、宽 W 的矩形得 L/W。xs、ys：格心（km，平面），areas：每格的面积（km²）
export function elongation(xs: ArrayLike<number>, ys: ArrayLike<number>, areas: ArrayLike<number>): number {
  let A = 0;
  let mx = 0;
  let my = 0;
  for (let k = 0; k < xs.length; k++) {
    A += areas[k];
    mx += areas[k] * xs[k];
    my += areas[k] * ys[k];
  }
  if (!(A > 0)) return NaN;
  mx /= A;
  my /= A;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let k = 0; k < xs.length; k++) {
    const dx = xs[k] - mx;
    const dy = ys[k] - my;
    sxx += areas[k] * (dx * dx + areas[k] / 12);
    syy += areas[k] * (dy * dy + areas[k] / 12);
    sxy += areas[k] * dx * dy;
  }
  const tr = (sxx + syy) / 2;
  const det = Math.sqrt(Math.max(0, ((sxx - syy) / 2) ** 2 + sxy * sxy));
  const l1 = tr + det;
  const l2 = tr - det;
  return l2 > 0 ? Math.sqrt(l1 / l2) : NaN;
}
