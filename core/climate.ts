import { type Mesh, gradientField, ringDistance } from './mesh';
import { clamp, smoothstep } from './rng';
import { type Derived, type World, worldLatitude } from './world';

// 气候：少参数的物理过程模型，不对地球的海陆形状做拟合，换一块大陆也成立。
//   温度 = 日照（纬度、季节）→ 辐射平衡温度；海陆热惯性由“海洋气团占比”（大陆度）调节；海拔直减
//   风   = 三圈环流的纬向风带随季节南北摆动 + 大陆夏季热低压（季风）；高山挡住的风顺着山走（山挡风）
//   降水 = 水汽沿风向在格图上输运：海上蒸发补充，陆上按速率降落；
//          抬升冷却使饱和水汽量下降，多出的水汽在迎风坡降下 → 背风坡雨影自然出现
// 两个季节：s = 北半球夏半年，w = 北半球冬半年。

export interface ClimateBase {
  tS: Float32Array;
  tW: Float32Array;
  pS: Float32Array;
  pW: Float32Array;
}

export let SWEEPS = 32;
export const setSweeps = (v: number) => (SWEEPS = v);
const cache = new WeakMap<Mesh, { rev: Int32Array; orders: Int32Array[] }>();

// rev[e]：邻接项 e（i→j）在 j 的邻接表中指回 i 的那一项
function meshAux(mesh: Mesh) {
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

// 陆地占比的平滑很耗时（几百轮扩散），陆海不变时复用结果；每个网格留两份，撤销一笔海陆修改时直接用上一份
const landFracCache = new WeakMap<Mesh, { kmPerUnit: number; land: Uint8Array; result: Float64Array }[]>();

function landFraction(mesh: Mesh, land: Uint8Array, kmPerUnit: number): Float64Array {
  const list = landFracCache.get(mesh) ?? [];
  for (const c of list) if (c.kmPerUnit === kmPerUnit && c.land.length === land.length && c.land.every((v, i) => v === land[i])) return c.result;
  const n = mesh.n;
  let landFrac = new Float64Array(n);
  for (let i = 0; i < n; i++) landFrac[i] = land[i];
  const iters = Math.min(400, smoothPasses(1500, mesh.spacing * kmPerUnit));
  let tmp = new Float64Array(n);
  for (let it = 0; it < iters; it++) {
    smoothPass(mesh, landFrac, tmp);
    const t = landFrac;
    landFrac = tmp;
    tmp = t;
  }
  list.unshift({ kmPerUnit, land: land.slice(), result: landFrac });
  landFracCache.set(mesh, list.slice(0, 2));
  return landFrac;
}

// 一轮扩散：dst[i] = (src[i] + Σ 邻居) / (1 + 邻居数)。四格交错、各用一个累加器，
// 每格仍按原来的邻接顺序从 src[i] 加起（结果逐值相同），四条浮点加法链互不等待，快不少（球面的气候也用）
export function smoothPass(mesh: Mesh, src: Float64Array, dst: Float64Array) {
  const { n, off, adj } = mesh;
  let i = 0;
  for (; i + 4 <= n; i += 4) {
    const a0 = off[i];
    const a1 = off[i + 1];
    const a2 = off[i + 2];
    const a3 = off[i + 3];
    const a4 = off[i + 4];
    const d0 = a1 - a0;
    const d1 = a2 - a1;
    const d2 = a3 - a2;
    const d3 = a4 - a3;
    let m = d0 < d1 ? d0 : d1;
    if (d2 < m) m = d2;
    if (d3 < m) m = d3;
    let s0 = src[i];
    let s1 = src[i + 1];
    let s2 = src[i + 2];
    let s3 = src[i + 3];
    for (let k = 0; k < m; k++) {
      s0 += src[adj[a0 + k]];
      s1 += src[adj[a1 + k]];
      s2 += src[adj[a2 + k]];
      s3 += src[adj[a3 + k]];
    }
    for (let k = m; k < d0; k++) s0 += src[adj[a0 + k]];
    for (let k = m; k < d1; k++) s1 += src[adj[a1 + k]];
    for (let k = m; k < d2; k++) s2 += src[adj[a2 + k]];
    for (let k = m; k < d3; k++) s3 += src[adj[a3 + k]];
    dst[i] = s0 / (1 + a1 - a0);
    dst[i + 1] = s1 / (1 + a2 - a1);
    dst[i + 2] = s2 / (1 + a3 - a2);
    dst[i + 3] = s3 / (1 + a4 - a3);
  }
  for (; i < n; i++) {
    let s = src[i];
    for (let e = off[i]; e < off[i + 1]; e++) s += src[adj[e]];
    dst[i] = s / (1 + off[i + 1] - off[i]);
  }
}

// 日平均日照（W/m²）
function dailyInsolation(latDeg: number, declDeg: number, s0: number): number {
  const phi = (latDeg * Math.PI) / 180;
  const dec = (declDeg * Math.PI) / 180;
  const x = clamp(-Math.tan(phi) * Math.tan(dec), -1, 1);
  const h0 = Math.acos(x);
  return Math.max(0, (s0 / Math.PI) * (h0 * Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.sin(h0)));
}

type Insolation = (lat: number) => { ann: number; s: number; w: number };
// 最近一次的表：只改冷暖干湿、湿度、直减率时倾角与日照不变，不必重算
let lastIns: { tilt: number; solar: number; table: Insolation } | null = null;

// 按纬度预计算全年平均与两个半年的平均日照
export function insolationTable(tilt: number, solar: number): Insolation {
  if (lastIns && Object.is(lastIns.tilt, tilt) && Object.is(lastIns.solar, solar)) return lastIns.table;
  const s0 = 1361 * solar;
  const lats = 361;
  const ann = new Float64Array(lats);
  const sum = new Float64Array(lats);
  const win = new Float64Array(lats);
  const steps = 48;
  for (let k = 0; k < lats; k++) {
    const lat = -90 + k * 0.5;
    let a = 0;
    let s = 0;
    let w = 0;
    for (let t = 0; t < steps; t++) {
      const decl = tilt * Math.sin((2 * Math.PI * (t + 0.5)) / steps);
      const q = dailyInsolation(lat, decl, s0);
      a += q;
      if (t < steps / 2) s += q;
      else w += q;
    }
    ann[k] = a / steps;
    sum[k] = s / (steps / 2);
    win[k] = w / (steps / 2);
  }
  // 每格都要查一次：线性插值直接写开，不在每次查询里新建闭包
  const table: Insolation = (lat) => {
    const f = (clamp(lat, -90, 90) + 90) * 2;
    const k = Math.min(lats - 2, Math.floor(f));
    const t = f - k;
    return { ann: ann[k] + (ann[k + 1] - ann[k]) * t, s: sum[k] + (sum[k + 1] - sum[k]) * t, w: win[k] + (win[k + 1] - win[k]) * t };
  };
  lastIns = { tilt, solar, table };
  return table;
}

// 年均温与年均日照的关系，按地球的赤道（27 °C）、45°（11 °C）、极地（-18 °C）三点拟合；
// 日照变了（倾角、太阳常数）温度跟着变
export function radiativeTemp(q: number): number {
  const qq = Math.min(q, 520);
  return -77.12 + 0.4071 * qq - 0.000378 * qq * qq;
}

// 相对饱和水汽量（25 °C 为 1）
export function saturation(t: number): number {
  return Math.exp(0.045 * (clamp(t, -40, 40) - 25));
}

export function petHalf(t: number): number {
  return t >= 0 ? 100 + 24 * t : 100 * Math.exp(t / 8);
}

// ---------- 按内容做键的缓存 ----------

// 每个网格留两份（预览用的副本不会把正在用的挤掉），命中的挪到最前；格数超过 bigMesh 的网格只留一份。
// 键里的数组按字节比较（-0 与 0、不同的 NaN 都算不同），参数按 Object.is；存进去的数组都是私有的副本，取出后只读。
// on = false 时既不用也不存（测试里用来得到从头算的结果）
export class ContentMemo<T> {
  on = true;
  hit = 0;
  miss = 0;
  private store = new WeakMap<Mesh, { arrays: ArrayBufferView[]; params: unknown[]; value: T }[]>();
  private readonly bigMesh: number;

  constructor(bigMesh = Infinity) {
    this.bigMesh = bigMesh;
  }

  find(mesh: Mesh, arrays: ArrayBufferView[], params: unknown[]): T | null {
    if (!this.on) return null;
    const list = this.store.get(mesh) ?? [];
    for (let k = 0; k < list.length; k++) {
      const c = list[k];
      if (!c.params.every((v, j) => Object.is(v, params[j])) || !c.arrays.every((a, j) => sameBytes(a, arrays[j]))) continue;
      list.splice(k, 1);
      list.unshift(c);
      this.hit++;
      return c.value;
    }
    this.miss++;
    return null;
  }

  // 有没有这一份（不计入命中、不调整先后）
  peek(mesh: Mesh, arrays: ArrayBufferView[], params: unknown[]): boolean {
    if (!this.on) return false;
    const list = this.store.get(mesh) ?? [];
    return list.some((c) => c.params.every((v, j) => Object.is(v, params[j])) && c.arrays.every((a, j) => sameBytes(a, arrays[j])));
  }

  // arrays：键里的数组，给私有的副本
  keep(mesh: Mesh, arrays: ArrayBufferView[], params: unknown[], value: T) {
    if (!this.on) return;
    const list = this.store.get(mesh) ?? [];
    list.unshift({ arrays, params, value });
    this.store.set(mesh, list.slice(0, mesh.n > this.bigMesh ? 1 : 2));
  }

  clear() {
    this.store = new WeakMap();
  }
}

function sameBytes(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.byteLength !== b.byteLength) return false;
  // 长度、起点都是 4 的倍数时 4 字节一组比
  const wide = a.byteLength % 4 === 0 && a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0;
  const x = wide ? new Int32Array(a.buffer, a.byteOffset, a.byteLength / 4) : new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = wide ? new Int32Array(b.buffer, b.byteOffset, b.byteLength / 4) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

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

// ---------- 气候里只取决于地形的部分 ----------

// 一季的输运图：入流表（按格，见 PlaneFlow）与权重之和（从图外来流的权重加起）
interface Inflow {
  order: Int32Array;
  koff: Int32Array;
  src: Int32Array;
  w: Float64Array;
  den: Float64Array;
}

// 风、输运图、大陆度、地形对降水的影响：只取决于海陆、高程、各格纬度、倾角、自转、图外是不是海、山挡风、比例尺与扫描遍数。
// 只改冷暖干湿、湿度、直减率、日照时原样复用
interface PlaneTerrain {
  lat: Float64Array;
  // 写进推导的（windSX、windSY、windWX、windWY、continentality 的顺序）
  written: Float32Array[];
  flows: Inflow[];
  // 两季从图外吹进来的格与图外来流的权重（图外是海时才有）
  edges: Int32Array[];
  edgeW: Float64Array[];
  // 格距（km）与按格距在约 150 km、900 km 上降下、回到饱和的比例
  dKm: Float64Array;
  e150: Float64Array;
  e900: Float64Array;
  // 两季降水速率里只取决于纬度的部分（辐合 × 副高下沉 × 风暴带）与背风的抑制（不在背风处为 1）
  rain: Float64Array[];
  lee: Float64Array[];
}

// 一份约每万格 2 MB：大网格只留一份
export const planeMemo = new ContentMemo<PlaneTerrain>(60000);

const SEASONS = [1, -1] as const;
const itczOf = (sigma: number, tilt: number) => sigma * 0.35 * tilt;

// ---------- 分层缓存（第三十一轮，与星球的 sphereStatic / sphereLand 同一个做法）----------
// 抬山、改岩性、放湖时海陆、纬度都不变：格距、背景风带、季风、降水里只取决于纬度的部分、偏转前的风都照用。
// 数值与逐格现算的完全相同（同样的运算、同样的先后），只是不再每次都算。planeLayers.on = false 时每次现算（测试用）
export const planeLayers = { on: true };

// 只取决于网格与比例尺：每格的平均格距（km）与按它算的几个比例
interface PlaneGeo {
  kmPerUnit: number;
  spacingKm: Float64Array;
  decay: Float64Array;
  e150: Float64Array;
  e900: Float64Array;
}
const geoCache = new WeakMap<Mesh, PlaneGeo>();
function planeGeo(mesh: Mesh, kmPerUnit: number): PlaneGeo {
  const hit = geoCache.get(mesh);
  if (planeLayers.on && hit && hit.kmPerUnit === kmPerUnit) return hit;
  const n = mesh.n;
  const spacingKm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) s += mesh.dist[e];
    spacingKm[i] = (s / Math.max(1, mesh.off[i + 1] - mesh.off[i])) * kmPerUnit;
  }
  const decay = new Float64Array(n);
  const e150 = new Float64Array(n);
  const e900 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    decay[i] = Math.exp(-spacingKm[i] / 1500);
    e150[i] = 1 - Math.exp(-spacingKm[i] / 150);
    e900[i] = 1 - Math.exp(-spacingKm[i] / 900);
  }
  const g = { kmPerUnit, spacingKm, decay, e150, e900 };
  if (planeLayers.on) geoCache.set(mesh, g);
  return g;
}

// 只取决于各格纬度、倾角、自转、比例尺：两季的背景风（纬向、经向）、季风的系数、降水里只取决于纬度的部分
interface PlaneStatic {
  lat: Float64Array;
  params: number[];
  u0: Float64Array[];
  v0: Float64Array[];
  kf: Float64Array[];
  rain: Float64Array[];
}
const planeStaticCache = new WeakMap<Mesh, PlaneStatic>();
function planeStatic(mesh: Mesh, lat: Float64Array, tilt: number, rotation: number, kmPerUnit: number): PlaneStatic {
  const params = [tilt, rotation, kmPerUnit];
  const hit = planeStaticCache.get(mesh);
  if (planeLayers.on && hit && hit.params.every((v, k) => Object.is(v, params[k])) && sameBytes(hit.lat, lat)) return hit;
  const n = mesh.n;
  const u0 = [new Float64Array(n), new Float64Array(n)];
  const v0 = [new Float64Array(n), new Float64Array(n)];
  const kf = [new Float64Array(n), new Float64Array(n)];
  const rain = [new Float64Array(n), new Float64Array(n)];
  const L = 1500 / kmPerUnit;
  SEASONS.forEach((sigma, si) => {
    const phiC = itczOf(sigma, tilt);
    for (let i = 0; i < n; i++) {
      const d = lat[i] - phiC;
      const ad = Math.min(90, Math.abs(d));
      u0[si][i] = -Math.cos((Math.PI * ad) / 45) * rotation * (ad < 22.5 ? 0.8 : 1);
      const toward = ad < 67.5 ? 0.3 * Math.sin((2 * Math.PI * ad) / 45) : 0.25;
      v0[si][i] = d > 0 ? toward : -toward;
      // 季风：夏半球风吹向大陆，冬半球吹离大陆
      const summer = Math.sign(lat[i]) === sigma;
      const g = Math.exp(-(((Math.abs(lat[i]) - 22) / 12) ** 2));
      kf[si][i] = (summer ? 1.1 : -0.25) * g * L;
      // 降水里只取决于纬度的部分（辐合 × 副高下沉 × 风暴带）
      const ar = Math.abs(d);
      const conv = 1 + 1.6 * Math.exp(-((d / 9) ** 2));
      const subs = 1 - 0.75 * Math.exp(-(((ar - 27) / 9) ** 2));
      const storm = 1 + 0.45 * Math.exp(-(((ar - 52) / 11) ** 2));
      rain[si][i] = conv * subs * storm;
    }
  });
  const st = { lat: lat.slice(), params, u0, v0, kf, rain };
  if (planeLayers.on) planeStaticCache.set(mesh, st);
  return st;
}

// 只取决于海陆（加上上面那一层）：偏转前的两季的风（写进推导的 Float32，windSX、windSY、windWX、windWY 的顺序）。
// 按陆地占比的那份数组认（陆地占比按海陆缓存，同样的海陆是同一个数组）；留两份（撤销一笔改海陆时还能用上）
const planeWindCache = new WeakMap<PlaneStatic, { landFrac: Float64Array; winds: Float32Array[] }[]>();
function planeWinds(mesh: Mesh, st: PlaneStatic, landFrac: Float64Array): Float32Array[] {
  const list = planeWindCache.get(st) ?? [];
  const hit = planeLayers.on ? list.find((c) => c.landFrac === landFrac) : undefined;
  if (hit) return hit.winds;
  const n = mesh.n;
  // 陆地占比的梯度，两个季节共用
  const lfX = new Float64Array(n);
  const lfY = new Float64Array(n);
  gradientField(mesh, landFrac, lfX, lfY);
  const winds = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  for (let si = 0; si < 2; si++) {
    const wx = winds[2 * si];
    const wy = winds[2 * si + 1];
    const u0 = st.u0[si];
    const v0 = st.v0[si];
    const kf = st.kf[si];
    for (let i = 0; i < n; i++) {
      let u = u0[i];
      let v = v0[i];
      const k = kf[i];
      u += k * lfX[i];
      v += k * lfY[i];
      const mag = Math.hypot(u, v);
      const lim = 1.3;
      if (mag > lim) {
        u *= lim / mag;
        v *= lim / mag;
      }
      wx[i] = u;
      wy[i] = v;
    }
  }
  if (planeLayers.on) planeWindCache.set(st, [{ landFrac, winds }, ...list].slice(0, 2));
  return winds;
}

function planeTerrain(world: World, elevation: Float32Array, out: Derived): PlaneTerrain {
  const { mesh, causes, small, kmPerUnit } = world;
  const n = mesh.n;
  const planet = small.planet;
  const land = causes.land;
  const lat = new Float64Array(n);
  latitudesOf(world, lat);
  const written = [out.windSX, out.windSY, out.windWX, out.windWY, out.continentality];
  // 山挡风：0 时风直接翻过山
  const terrainWind = planet.terrainWind;
  const params = [planet.tilt, planet.rotation, planet.outsideOcean, kmPerUnit, SWEEPS, terrainWind];
  const hit = planeMemo.find(mesh, [land, elevation, lat], params);
  if (hit) {
    written.forEach((a, k) => a.set(hit.written[k]));
    return hit;
  }
  const aux = meshAux(mesh);
  const geo = planeGeo(mesh, kmPerUnit);
  const spacingKm = geo.spacingKm;
  const st = planeStatic(mesh, lat, planet.tilt, planet.rotation, kmPerUnit);

  // 大尺度陆地占比（约 1500 km 平滑），季风用
  const landFrac = landFraction(mesh, land, kmPerUnit);
  const baseWinds = planeWinds(mesh, st, landFrac);

  // 高程梯度（m/km），陆地用于地形抬升判断。先平滑到约 200 km 尺度：
  // 地形雨看的是山体整体的迎风背风，不是单格尺度的谷与脊，否则会出现逐格交替的条纹
  const hx = new Float64Array(n);
  const hy = new Float64Array(n);
  let hPos = new Float64Array(n);
  landHeights(n, land, elevation, hPos);
  {
    const passes = smoothPasses(OROGRAPHIC_KM, mesh.spacing * kmPerUnit);
    let next = new Float64Array(n);
    for (let it = 0; it < passes; it++) {
      smoothPass(mesh, hPos, next);
      const t = hPos;
      hPos = next;
      next = t;
    }
  }
  gradientField(mesh, hPos, hx, hy);
  perKm(n, hx, hy, kmPerUnit);

  const winds: [Float32Array, Float32Array][] = [
    [out.windSX, out.windSY],
    [out.windWX, out.windWY],
  ];
  // 背景风带 + 季风（偏转前，按海陆缓存）
  out.windSX.set(baseWinds[0]);
  out.windSY.set(baseWinds[1]);
  out.windWX.set(baseWinds[2]);
  out.windWY.set(baseWinds[3]);
  // 山挡风：为 0 时整段跳过（与没有这一步逐值相同）。图边来流、背风、大陆度、输运都跟着拐过的风走
  if (terrainWind > 0) {
    const delta = deflectWind(mesh, lat, hPos, hx, hy, terrainWind, planet.rotation, windDeflectPasses(mesh.spacing * kmPerUnit), [winds[0], winds[1]]);
    for (let si = 0; si < 2; si++) addDelta(n, winds[si][0], winds[si][1], delta[si][0], delta[si][1]);
  }

  // 每个季节的输运权重：格 i 的出流按风向分给下风方向的邻居，另有一小部分各向均匀扩散
  const flow = winds.map(([wx, wy]) => buildFlow(mesh, wx, wy));
  // 图外来流：作为一个虚拟的上风邻居参与平均
  const edges: Int32Array[] = [];
  const edgeW: Float64Array[] = [];
  for (const [wx, wy] of winds) {
    const list = new Int32Array(n);
    const ew = new Float64Array(n);
    const m = planet.outsideOcean ? edgeInflow(n, mesh.boundary, mesh.inwardX, mesh.inwardY, wx, wy, list, ew) : 0;
    edges.push(list.slice(0, m));
    edgeW.push(ew);
  }
  const flows = flow.map((f, si): Inflow => ({ order: f.order, koff: f.koff, src: f.src, w: f.w, den: inflowDen(n, f.koff, f.w, edgeW[si]) }));

  // 大陆度：海洋气团示踪量随风深入陆地后衰减
  const decay = geo.decay;
  const marine = new Float64Array(n);
  for (let si = 0; si < 2; si++) addHalfClamped(n, marine, marineSweeps(flows[si], aux.orders, edges[si], edgeW[si], land, decay));
  continentalityOf(n, land, marine, out.continentality);

  // 降水里只取决于地形的部分：只取决于纬度的那一份（rain）在上面的分层缓存里，这里是背风的抑制
  const rain = st.rain;
  const lee = [new Float64Array(n), new Float64Array(n)];
  for (let si = 0; si < 2; si++) leeOf(n, land, winds[si][0], winds[si][1], hx, hy, lee[si]);
  const { e150, e900 } = geo;

  const t: PlaneTerrain = { lat, written: written.map((a) => a.slice()), flows, edges, edgeW, dKm: spacingKm, e150, e900, rain, lee };
  planeMemo.keep(mesh, [land.slice(), elevation.slice(), lat], params, t);
  return t;
}

// 空闲预热（第三十一轮，见 engine.ts 的 warmSteps）：只取决于网格、纬度与海陆的几样（网格的邻接反查与扫描顺序、
// 边的方向、格距、背景风带与日照、大尺度的陆地占比与偏转前的风）先算好放进缓存，打开后的第一笔不用等。
// 与 computeClimate 里用到时现算的是同一份。返回是否算了
export function prepareClimatePlane(world: World): boolean {
  const { mesh, causes, kmPerUnit, small } = world;
  const fresh = !cache.has(mesh) || !(landFracCache.get(mesh) ?? []).some((c) => c.kmPerUnit === kmPerUnit && c.land.length === causes.land.length && c.land.every((v, i) => v === causes.land[i]));
  if (!fresh) return false;
  meshAux(mesh);
  edgeDirs(mesh);
  const lat = new Float64Array(mesh.n);
  for (let i = 0; i < mesh.n; i++) lat[i] = worldLatitude(world, mesh.y[i]);
  planeGeo(mesh, kmPerUnit);
  planeSun(mesh, lat, small.planet.tilt, small.planet.solar);
  planeWinds(mesh, planeStatic(mesh, lat, small.planet.tilt, small.planet.rotation, kmPerUnit), landFraction(mesh, causes.land, kmPerUnit));
  return true;
}

// 温度里只取决于各格纬度、倾角、日照的部分（第三十一轮按网格缓存一份，与逐格现算的相同）：
// 年均辐射平衡温度、两季的振幅项 k·(q季 − q年)（高纬的季节振幅更大：极昼极夜）、海面温度与它的饱和水汽量（湿度之前）
interface PlaneSun {
  lat: Float64Array;
  params: number[];
  tAnn: Float64Array;
  kSeason: Float64Array[];
  oceanT: Float64Array[];
  satOcean: Float64Array[];
}
const sunCache = new WeakMap<Mesh, PlaneSun>();
function planeSun(mesh: Mesh, lat: Float64Array, tilt: number, solar: number): PlaneSun {
  const params = [tilt, solar];
  const hit = sunCache.get(mesh);
  if (planeLayers.on && hit && hit.params.every((v, k) => Object.is(v, params[k])) && sameBytes(hit.lat, lat)) return hit;
  const n = mesh.n;
  const ins = insolationTable(tilt, solar);
  const tAnn = new Float64Array(n);
  const kSeason = [new Float64Array(n), new Float64Array(n)];
  const oceanT = [new Float64Array(n), new Float64Array(n)];
  const satOcean = [new Float64Array(n), new Float64Array(n)];
  for (let i = 0; i < n; i++) {
    const q = ins(lat[i]);
    const t = radiativeTemp(q.ann);
    const k = 0.09 * (1 + (0.4 * Math.abs(lat[i])) / 90);
    tAnn[i] = t;
    kSeason[0][i] = k * (q.s - q.ann);
    kSeason[1][i] = k * (q.w - q.ann);
    oceanT[0][i] = t + kSeason[0][i] * 0.3;
    oceanT[1][i] = t + kSeason[1][i] * 0.3;
    satOcean[0][i] = saturation(oceanT[0][i]);
    satOcean[1][i] = saturation(oceanT[1][i]);
  }
  const sun = { lat: lat.slice(), params, tAnn, kSeason, oceanT, satOcean };
  if (planeLayers.on) sunCache.set(mesh, sun);
  return sun;
}

export function computeClimate(world: World, elevation: Float32Array, out: Derived): ClimateBase {
  const { mesh, causes, small } = world;
  const n = mesh.n;
  const planet = small.planet;
  const land = causes.land;
  const { orders } = meshAux(mesh);
  const tr = planeTerrain(world, elevation, out);
  const { lat, dKm } = tr;
  const sun = planeSun(mesh, lat, planet.tilt, planet.solar);

  // 温度
  const base: ClimateBase = { tS: new Float32Array(n), tW: new Float32Array(n), pS: new Float32Array(n), pW: new Float32Array(n) };
  const [kS, kW] = sun.kSeason;
  const tAnnOf = sun.tAnn;
  const cont = out.continentality;
  planeTemps(n, land, tAnnOf, kS, kW, cont, elevation, planet.lapse, causes.tempOffset, base.tS, base.tW);

  // 降水：每格的降落比例、饱和量先算好（与逐遍现算的值相同），输运时每遍只做加权平均与逐格的收支
  for (let si = 0; si < 2; si++) {
    const T = si === 0 ? base.tS : base.tW;
    const P = si === 0 ? base.pS : base.pW;
    const rain = tr.rain[si];
    const lee = tr.lee[si];
    const satO = sun.satOcean[si];
    const fall = new Float64Array(n);
    const lim = new Float64Array(n);
    const evap = new Float64Array(n);
    planeRainSetup(n, land, T, rain, lee, satO, dKm, planet.humidity, fall, lim, evap);
    // 图外来流：图外是海时取当地海面饱和量
    const num0 = new Float64Array(n);
    edgeMoisture(tr.edges[si], tr.edgeW[si], planet.humidity, satO, num0);
    const removed = new Float64Array(n);
    moistSweeps(tr, si, orders, num0, land, fall, lim, evap, removed);
    precipOf(n, removed, causes.moistOffset, P);
  }
  return base;
}

// 第三十五轮（提速）：planeTerrain、computeClimate 里剩下的几段逐格循环也放进小函数（原样照搬，结果逐值相同）。
// 每格的纬度（与逐格调 worldLatitude 相同）
function latitudesOf(world: World, lat: Float64Array) {
  const y = world.mesh.y;
  for (let i = 0; i < lat.length; i++) lat[i] = worldLatitude(world, y[i]);
}

// 陆地的高程（海与负的为 0）
function landHeights(n: number, land: Uint8Array, elevation: Float32Array, hPos: Float64Array) {
  for (let i = 0; i < n; i++) hPos[i] = land[i] ? Math.max(0, elevation[i]) : 0;
}

// 梯度换成每 km
function perKm(n: number, hx: Float64Array, hy: Float64Array, kmPerUnit: number) {
  for (let i = 0; i < n; i++) {
    hx[i] = hx[i] / kmPerUnit;
    hy[i] = hy[i] / kmPerUnit;
  }
}

// 风加上山挡风的变化量（变化量为 0 的格不动）
function addDelta(n: number, wx: Float32Array, wy: Float32Array, du: Float64Array, dv: Float64Array) {
  for (let i = 0; i < n; i++) {
    if (du[i] === 0 && dv[i] === 0) continue;
    wx[i] += du[i];
    wy[i] += dv[i];
  }
}

// 图外是海时从图外吹进来的格（写进 list，返回个数）与图外来流的权重
function edgeInflow(n: number, boundary: Uint8Array, inwardX: Float32Array, inwardY: Float32Array, wx: Float32Array, wy: Float32Array, list: Int32Array, ew: Float64Array): number {
  let m = 0;
  for (let i = 0; i < n; i++) {
    if (!boundary[i]) continue;
    const mag = Math.hypot(wx[i], wy[i]);
    if (mag < 1e-6) continue;
    const dot = (wx[i] * inwardX[i] + wy[i] * inwardY[i]) / mag;
    ew[i] = Math.max(0, dot);
    list[m++] = i;
  }
  return m;
}

// marine += 0.5 · clamp(m, 0, 1)
function addHalfClamped(n: number, marine: Float64Array, m: Float64Array) {
  for (let i = 0; i < n; i++) marine[i] += 0.5 * clamp(m[i], 0, 1);
}

// 大陆度（海上为 0）
function continentalityOf(n: number, land: Uint8Array, marine: Float64Array, out: Float32Array) {
  for (let i = 0; i < n; i++) out[i] = land[i] ? 1 - marine[i] : 0;
}

// 图外来流带进来的水汽
function edgeMoisture(edges: Int32Array, edgeW: Float64Array, humidity: number, satO: Float64Array, num0: Float64Array) {
  for (let k = 0; k < edges.length; k++) {
    const i = edges[k];
    num0[i] = edgeW[i] * (humidity * satO[i]);
  }
}

// 一季的降水
function precipOf(n: number, removed: Float64Array, off: Float32Array, P: Float32Array) {
  for (let i = 0; i < n; i++) P[i] = removed[i] * 1.7e6 * Math.exp(off[i]);
}

// 第三十二轮（提速）：planeTerrain、computeClimate 里几段逐格的循环拆成小函数（小函数里的循环很快就被编译优化；
// 写在大函数里时，前几次常常还没编译好就算完了），原样照搬，结果逐值相同。
// 每格入流的权重之和（加上图外来流的权重）
function inflowDen(n: number, koff: Int32Array, w: Float64Array, edgeW: Float64Array): Float64Array {
  const den = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = edgeW[i];
    for (let p = koff[i]; p < koff[i + 1]; p++) s += w[p];
    den[i] = s;
  }
  return den;
}

// 一季的背风抑制（不在背风处为 1）
function leeOf(n: number, land: Uint8Array, wx: Float32Array, wy: Float32Array, hx: Float64Array, hy: Float64Array, ls: Float64Array) {
  for (let i = 0; i < n; i++) {
    ls[i] = 1;
    if (land[i]) {
      const wm = Math.hypot(wx[i], wy[i]) || 1;
      const up = (wx[i] * hx[i] + wy[i] * hy[i]) / wm;
      // 背风下沉气流抑制降水
      if (up < 0) ls[i] = Math.exp(up / 1.5);
    }
  }
}

// 两季温度（年均、季节振幅按大陆度、直减率、冷暖微调）
function planeTemps(n: number, land: Uint8Array, tAnnOf: Float64Array, kS: Float64Array, kW: Float64Array, cont: Float32Array, elevation: Float32Array, lapseRate: number, tOff: Float32Array, tS: Float32Array, tW: Float32Array) {
  for (let i = 0; i < n; i++) {
    const tAnn = tAnnOf[i];
    const amp = land[i] ? 0.3 + 0.7 * cont[i] : 0.3;
    const lapse = land[i] ? (lapseRate * Math.max(0, elevation[i])) / 1000 : 0;
    const off = tOff[i];
    tS[i] = tAnn + kS[i] * amp - lapse + off;
    tW[i] = tAnn + kW[i] * amp - lapse + off;
  }
}

// 每格降落的比例、饱和量、蒸散回补的比例
function planeRainSetup(n: number, land: Uint8Array, T: Float32Array, rain: Float64Array, lee: Float64Array, satO: Float64Array, dKm: Float64Array, humidity: number, fall: Float64Array, lim: Float64Array, evap: Float64Array) {
  for (let i = 0; i < n; i++) {
    const warmth = 0.45 + 0.55 * smoothstep(-10, 25, T[i]);
    // 不在背风处 lee 为 1，乘上去数值不变
    const r = ((rain[i] * warmth) / 1800) * lee[i];
    fall[i] = 1 - Math.exp(-r * dKm[i]);
    // 陆上：抬升冷却后的饱和量、蒸散回补的比例；海上：海面饱和量
    if (land[i]) {
      lim[i] = humidity * saturation(T[i]) * 1.1;
      evap[i] = smoothstep(0, 25, T[i]);
    } else lim[i] = humidity * satO[i];
  }
}

// 稳态输运：in_i = Σ_j out_j · frac(j→i) + 图外来流，out_i = 本格的收支(in_i)。
// 交替按拓扑序与 x、y 正反顺序做 Gauss-Seidel 扫描，沿风向一遍就能推进很远。
// 上风加权平均（半拉格朗日）：到达这一格的空气来自上风各格，取它们的平均，
// 所以水汽不会在风向杂乱处被“汇流”放大，也不超过上风的最大值；没有任何上风来源的格（辐散中心）取 0。
// 两种示踪量各写一个专用的循环：每格的系数先算好，入流按入流表累加（顺序与按邻接表现算相同，结果逐值相同）

// 海洋气团示踪量：海上格一直是 1，只扫陆地格。输运图的边都顺着拓扑序，第一遍里海上格总在读到它的格之前算好，
// 所以先填上 1；收敛判断从第三遍起，前两遍的变化量用不上
function marineSweeps(f: Inflow, orders: Int32Array[], edges: Int32Array, edgeW: Float64Array, land: Uint8Array, decay: Float64Array): Float64Array {
  const n = land.length;
  const { koff, src, w, den } = f;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) if (!land[i]) out[i] = 1;
  // 图外来流的量为 1
  const num0 = new Float64Array(n);
  for (const i of edges) num0[i] = edgeW[i];
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    let change = 0;
    const order = sweep % 2 === 0 ? f.order : orders[(sweep >> 1) % 4];
    for (let k = 0; k < n; k++) {
      const i = order[k];
      if (!land[i]) continue;
      let num = num0[i];
      for (let p = koff[i]; p < koff[i + 1]; p++) num += out[src[p]] * w[p];
      const inflow = den[i] > 1e-9 ? num / den[i] : 0;
      const v = inflow * decay[i];
      change = Math.max(change, Math.abs(v - out[i]));
      out[i] = v;
    }
    if (sweep >= 2 && change < 1e-4) break;
  }
  return out;
}

// 水汽：海上蒸发补充，陆上按速率降落；fall 为本格降落的比例，lim 为陆上抬升冷却后的饱和量或海面饱和量，
// evap 为陆面蒸散回补的比例。降下的量 / 格距写进 removed
function moistSweeps(
  tr: PlaneTerrain,
  si: number,
  orders: Int32Array[],
  num0: Float64Array,
  land: Uint8Array,
  fall: Float64Array,
  lim: Float64Array,
  evap: Float64Array,
  removed: Float64Array,
) {
  const n = land.length;
  const f = tr.flows[si];
  const { koff, src, w, den } = f;
  const { dKm, e150, e900 } = tr;
  const out = new Float64Array(n);
  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    let change = 0;
    const order = sweep % 2 === 0 ? f.order : orders[(sweep >> 1) % 4];
    for (let k = 0; k < n; k++) {
      const i = order[k];
      let num = num0[i];
      for (let q = koff[i]; q < koff[i + 1]; q++) num += out[src[q]] * w[q];
      let m = den[i] > 1e-9 ? num / den[i] : 0;
      let p = m * fall[i];
      m -= p;
      if (land[i]) {
        // 抬升冷却：超过当地饱和量的部分在约 150 km 的距离上降下（按距离而不是按格，结果与格的大小无关）
        const cap = lim[i];
        if (m > cap) {
          const excess = (m - cap) * e150[i];
          p += excess;
          m -= excess;
        }
        // 陆面蒸散回补一部分
        m += p * 0.6 * evap[i];
      } else {
        const sat = lim[i];
        // 超过饱和量的部分同样在约 150 km 内降下
        if (m > sat * 1.1) {
          const excess = (m - sat * 1.1) * e150[i];
          p += excess;
          m -= excess;
        }
        m += (sat - m) * e900[i];
      }
      removed[i] = p / dKm[i];
      const v = Math.max(0, m);
      change = Math.max(change, Math.abs(v - out[i]));
      out[i] = v;
    }
    if (sweep >= 2 && change < 1e-4) break;
  }
}

// 生态、河对周围的影响（effects.ts）：每格变暖变冷多少、降水的对数修正
export interface ClimateEffects {
  t: ArrayLike<number>;
  p: ArrayLike<number>;
}

// 把修正场（约束求解结果）叠到基础气候上，并计算派生的年值与指数。
// eff：生态、河对周围的影响，先加在基础气候上（与约束求解试算时的基础相同），再加修正场。
// 单独一个分支：没有影响时照原来的算式，逐值不变（加 0 也可能把 −0 变成 +0）
export function finalizeClimate(world: World, base: ClimateBase, out: Derived, eff?: ClimateEffects | null) {
  if (eff) {
    for (let i = 0; i < world.mesh.n; i++) {
      const eT = eff.t[i];
      const eP = Math.exp(eff.p[i]);
      const dT = out.corrT[i];
      const fP = Math.exp(out.corrP[i]);
      const tS = base.tS[i] + eT + dT;
      const tW = base.tW[i] + eT + dT;
      const pS = base.pS[i] * eP * fP;
      const pW = base.pW[i] * eP * fP;
      out.tS[i] = tS;
      out.tW[i] = tW;
      out.pS[i] = pS;
      out.pW[i] = pW;
      summarize(out, i, tS, tW, pS, pW);
    }
    return;
  }
  for (let i = 0; i < world.mesh.n; i++) {
    const dT = out.corrT[i];
    const fP = Math.exp(out.corrP[i]);
    const tS = base.tS[i] + dT;
    const tW = base.tW[i] + dT;
    const pS = base.pS[i] * fP;
    const pW = base.pW[i] * fP;
    out.tS[i] = tS;
    out.tW[i] = tW;
    out.pS[i] = pS;
    out.pW[i] = pW;
    summarize(out, i, tS, tW, pS, pW);
  }
}

// 约束求解的试算（core/constraints.ts）写了同一套算式，改这里时那里也要改
function summarize(out: Derived, i: number, tS: number, tW: number, pS: number, pW: number) {
  out.tMean[i] = (tS + tW) / 2;
  const summerWarm = tS >= tW;
  out.tWarm[i] = summerWarm ? tS : tW;
  out.tCold[i] = summerWarm ? tW : tS;
  const pWarm = summerWarm ? pS : pW;
  const pCold = summerWarm ? pW : pS;
  out.precip[i] = pS + pW;
  out.seasonality[i] = (pWarm - pCold) / (pWarm + pCold + 1);
  out.pet[i] = petHalf(tS) + petHalf(tW);
  // 蒸散分母设下限：极寒处 PET 趋近 0，湿润指数会变得没有意义的大
  out.moisture[i] = out.precip[i] / Math.max(out.pet[i], 120);
}

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
function edgeDirs(mesh: Mesh): { ex: Float64Array; ey: Float64Array } {
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

function buildFlow(mesh: Mesh, wx: Float32Array, wy: Float32Array): PlaneFlow {
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
