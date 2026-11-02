import { type Mesh, ringDistance } from './mesh';
import { smoothstep } from './rng';

// 第四十六轮从 climate.ts 原样搬来，climate.ts 照旧导出

// ---------- 山挡风：高山让风拐弯（平面与球面共用） ----------

// 两季的风（东、南分量）
type SeasonWinds = readonly [readonly [ArrayLike<number>, ArrayLike<number>], readonly [ArrayLike<number>, ArrayLike<number>]];

// 平滑到约 radiusKm 要几遍（格距 spacingKm）：一遍扩散约走 √2 格，n 遍约 √(2n) 格，所以 n ≈ (r / 格距)² / 2。
// 至少一遍：格很粗（比如每格 100 km 的星球）时也不会变成不平滑
export function smoothPasses(radiusKm: number, spacingKm: number): number {
  return Math.max(1, Math.round((radiusKm / spacingKm) ** 2 / 2));
}

// 地形雨看的山体尺度：陆地高程先平滑到约 200 km（平面与球面共用）
export const OROGRAPHIC_KM = 200;

// 山挡风的变化量平滑几遍：约 150 km（迎风的气流在山前就开始拐）；格很密时封顶 48 遍
export function windDeflectPasses(spacingKm: number): number {
  return Math.min(48, smoothPasses(150, spacingKm));
}

// 按局地 Froude 数（风速 / (浮力频率 × 山高)，风 1 = 10 m/s、N = 0.01/s）判断山挡不挡得住风：
//   · 挡住的翻山分量去掉（至少留 5%，不会变成静风）；背风坡只去掉一半
//   · 迎风坡被挡住的气流顺着山走：北半球向左拐、南半球向右拐（障碍急流），自转反向时反过来
//   · 迎风、背风处风变小，顺山走的急流保持风速
// 只平滑变化量 Δ（固定遍数 passes，见 windDeflectPasses）：离山远的地方 Δ 正好是 0，风与没有这一步逐位相同。
// hPos：平滑到约 200 km 的陆地高程（m），hx、hy：它的梯度（m/km，东、南分量）；winds：两季的背景风。
// strength 为 0 时调用方整段跳过（与旧算法逐值相同）。返回两季平滑后的 Δ（东、南分量）
export function deflectWind(
  mesh: Mesh,
  lat: Float64Array,
  hPos: Float64Array,
  hx: Float64Array,
  hy: Float64Array,
  strength: number,
  rotation: number,
  passes: number,
  winds: SeasonWinds,
): [Float64Array, Float64Array][] {
  const n = mesh.n;
  // 每格四个数挨着放（夏东、夏南、冬东、冬南）：平滑时一格的邻居只读一遍
  let cur = new Float64Array(4 * n);
  // 第三十五轮（提速）：逐格的几段放进小函数（原样照搬，结果逐值相同）
  const seedBuf = new Int32Array(n);
  const ns = deflectSeeds(n, lat, hPos, hx, hy, strength, rotation, winds, cur, seedBuf);
  const out: [Float64Array, Float64Array][] = [
    [new Float64Array(n), new Float64Array(n)],
    [new Float64Array(n), new Float64Array(n)],
  ];
  if (!ns) return out;
  // 与 smoothPass 同样的一轮扩散，只算离有变化的格 passes 步以内的格：更远的格在这几遍里一直是 0。
  // 同理第 it 遍里离得比 it + 1 步远的格也还是 0：按步数排好，每遍只算到 it + 1 步（结果与全算逐位相同；
  // 1500 km 宽、格很密的图上要算满 48 遍，省约四分之一）
  const reach = ringDistance(mesh, seedBuf.subarray(0, ns), passes);
  // within[r]：离有变化的格不超过 r 步的格数；active 按步数排（同一步数里按下标）
  const within = new Int32Array(passes + 1);
  for (let i = 0; i < n; i++) if (reach[i] >= 0) within[reach[i]]++;
  for (let r = 1; r <= passes; r++) within[r] += within[r - 1];
  const active = new Int32Array(within[passes]);
  const slot = new Int32Array(passes + 1);
  for (let r = 1; r <= passes; r++) slot[r] = within[r - 1];
  for (let i = 0; i < n; i++) if (reach[i] >= 0) active[slot[reach[i]]++] = i;
  const { off, adj } = mesh;
  let next = new Float64Array(4 * n);
  // 按下标走类型数组，比 for…of 快约三成
  for (let it = 0; it < passes; it++) {
    deflectPass(off, adj, active, within[Math.min(passes, it + 1)], cur, next);
    const t = cur;
    cur = next;
    next = t;
  }
  deflectOut(active, cur, out[0][0], out[0][1], out[1][0], out[1][1]);
  return out;
}

// 有坡的格两季的风被山挡住、拐弯的变化量（写进 cur，有变化的格写进 seeds，返回个数）
function deflectSeeds(n: number, lat: Float64Array, hPos: Float64Array, hx: Float64Array, hy: Float64Array, strength: number, rotation: number, winds: SeasonWinds, cur: Float64Array, seeds: Int32Array): number {
  let m = 0;
  for (let i = 0; i < n; i++) if (deflectAt(i, lat, hPos, hx, hy, strength, rotation, winds, cur)) seeds[m++] = i;
  return m;
}

// 一格：有变化时返回 true
function deflectAt(i: number, lat: Float64Array, hPos: Float64Array, hx: Float64Array, hy: Float64Array, strength: number, rotation: number, winds: SeasonWinds, cur: Float64Array): boolean {
  const g = Math.sqrt(hx[i] * hx[i] + hy[i] * hy[i]);
  if (g <= 0.5) return false;
  // 指向上坡的单位向量；a > 0 迎风坡，a < 0 背风坡
  const nx = hx[i] / g;
  const ny = hy[i] / g;
  const h = Math.max(hPos[i], 1);
  const slope = smoothstep(0.5, 4, g);
  let touched = false;
  for (let s = 0; s < 2; s++) {
    const u0 = winds[s][0][i];
    const v0 = winds[s][1][i];
    const m0 = Math.sqrt(u0 * u0 + v0 * v0);
    // 无风的格没有方向可改（下面要除以风速）
    if (m0 < 1e-9) continue;
    const fr = (1000 * m0) / h;
    if (fr >= 1.6) continue;
    const a = u0 * nx + v0 * ny;
    let beta = Math.min(0.95, strength * 0.85 * (1 - smoothstep(0.4, 1.6, fr)) * slope);
    if (a < 0) beta *= 0.5;
    if (beta <= 0) continue;
    let u1 = u0 - beta * a * nx;
    let v1 = v0 - beta * a * ny;
    if (a > 0) {
      // 东、南分量里 (ny, −nx) 是面朝上坡时的左手边；赤道附近没有偏转
      const c = rotation * Math.sign(lat[i]) * Math.min(1, Math.abs(Math.sin((lat[i] * Math.PI) / 180)) / 0.5);
      u1 += 0.7 * beta * a * c * ny;
      v1 -= 0.7 * beta * a * c * nx;
    }
    const k = (m0 * (1 - 0.5 * beta * (a / m0) ** 2)) / Math.sqrt(u1 * u1 + v1 * v1);
    cur[4 * i + 2 * s] = u1 * k - u0;
    cur[4 * i + 2 * s + 1] = v1 * k - v0;
    touched = true;
  }
  return touched;
}

// 一遍扩散（active 的前 m 格，读 cur、写 next）
function deflectPass(off: Int32Array, adj: Int32Array, active: Int32Array, m: number, cur: Float64Array, next: Float64Array) {
  for (let k = 0; k < m; k++) {
    const i = active[k];
    const b = 4 * i;
    let s0 = cur[b];
    let s1 = cur[b + 1];
    let s2 = cur[b + 2];
    let s3 = cur[b + 3];
    const e0 = off[i];
    const e1 = off[i + 1];
    for (let e = e0; e < e1; e++) {
      const j = 4 * adj[e];
      s0 += cur[j];
      s1 += cur[j + 1];
      s2 += cur[j + 2];
      s3 += cur[j + 3];
    }
    const den = 1 + e1 - e0;
    next[b] = s0 / den;
    next[b + 1] = s1 / den;
    next[b + 2] = s2 / den;
    next[b + 3] = s3 / den;
  }
}

// 两季的结果（东、南分量）
function deflectOut(active: Int32Array, cur: Float64Array, sx: Float64Array, sy: Float64Array, wx: Float64Array, wy: Float64Array) {
  for (let k = 0; k < active.length; k++) {
    const i = active[k];
    sx[i] = cur[4 * i];
    sy[i] = cur[4 * i + 1];
    wx[i] = cur[4 * i + 2];
    wy[i] = cur[4 * i + 3];
  }
}
