// 求解用的降水代理（第八十六轮）：下切与洼地按“这里湿不湿”变。
// 气候读高程（computeClimate 在高程之后），求解不能读气候，否则成了圈。这里用一个在高程之前就算得出的便宜的量估降水：
//   P = 纬度带 × 海洋气团（顺着盛行风在陆上走了多远）× 雨影（上风方向挡着的山比这里高多少）。
//   · 纬度带：与 climate.ts 的 planeStatic 同一个式子（赤道辐合带湿、副高 27° 干、风暴带 52° 湿），年平均（不挪赤道辐合带），
//     高纬再乘一个冷的减弱（冷空气含水少）；
//   · 盛行风：与 elevation-solve.ts 的 windEast 相同（信风带、极地往西吹，西风带往东吹），只看东西方向。格按东西坐标排一次序
//     （按网格缓存），顺风扫一遍：每格从上风的邻格里走过的陆路最短的那一格接过“走过的陆路”与“挡着的山”（邻格是海时都是 0）；
//     整个星球东西相接，扫两遍（第二遍接上绕过接缝的）；
//   · 雨影：上风方向的山（抬升 + 基准面，原始单位）比这一格高出的部分，按 SHADOW_KM 随距离衰减。
// 纬度是新建时的（与迎风、高程记忆的键相同），只看这块陆地自己的格（海格是 0）、抬升与基准面：
// 一块陆地的结果只取决于它自己，高程的记忆照旧按陆块复用。改气候、挪纬度不改高程（与以前一样）。
// 求解里的用法（elevation-solve.ts）：
//   · 汇水面积按 wet = clamp(P / P_REF, W_MIN, 1) 加权成“流量”：干处的河水少、下切弱，湿处照旧；
//   · 干的内陆（离海够远、P 低）按岩性的噪声（fk 高处岩性软）多出平底的洼地，上游来沙也按 wet 减少：
//     干的洼地填不满，水文按气候蓄成内流湖或干盐湖
import type { Mesh } from './mesh';
import { smoothstep } from './rng';
import { latitudeOf, type World } from './world';

export const PRECIP = {
  // 海洋气团随走过的陆路衰减（km）与衰减到底的比例
  MARINE_KM: 1600,
  MARINE_FLOOR: 0.12,
  // 雨影：挡着的山比这里高出多少（原始单位）时降水减半，与挡着的山随距离衰减（km）
  SHADOW_H: 0.35,
  SHADOW_KM: 900,
  // 高纬的冷：从 COLD0 到 COLD1 度降水乘到 1 − COLD
  COLD0: 55,
  COLD1: 85,
  COLD: 0.55,
};

export const WET = {
  // 流量的权重 clamp(P / P_REF, W_MIN, 1)：只减不加（湿处与以前一样）
  P_REF: 0.8,
  W_MIN: 0.7,
  // 干：P 从 ARID0 降到 ARID1 渐渐算满
  ARID0: 0.45,
  ARID1: 0.18,
  // 干的洼地：深（米，按默认的“最高的山”6000 m）、岩性噪声 (fk − 1) / 0.25 的门槛与过渡、离海 COAST0 到 COAST1 km 渐满
  DRY_D: 300,
  DRY_T: 0.1,
  DRY_W: 0.3,
  COAST0: 150,
  COAST1: 500,
  // 上面三样乘起来从 G0 到 G1 挖满：过渡窄，洼地的底差不多平
  G0: 0.3,
  G1: 0.45,
};

// 纬度带（年平均）：planeStatic 的 conv × subs × storm（d 取纬度，不挪赤道辐合带），再乘高纬的冷
export function latRain(lat: number): number {
  const a = Math.abs(lat);
  const conv = 1 + 1.6 * Math.exp(-((lat / 9) ** 2));
  const subs = 1 - 0.75 * Math.exp(-(((a - 27) / 9) ** 2));
  const storm = 1 + 0.45 * Math.exp(-(((a - 52) / 11) ** 2));
  return conv * subs * storm * (1 - PRECIP.COLD * smoothstep(PRECIP.COLD0, PRECIP.COLD1, a));
}

// 盛行风往东（+1）还是往西（−1）：与 elevation-solve.ts 的 windEast 相同
export function windEastAt(latDeg: number): number {
  const a = Math.abs(latDeg);
  return 2 * smoothstep(25, 35, a) * (1 - smoothstep(55, 65, a)) - 1;
}

// 新建时的纬度（度）：地区按 settings 的南北边，整个星球按格的位置（与 windwardFactor 相同）
export function solveLat(world: World, i: number): number {
  const { mesh } = world;
  return mesh.kind === 'sphere' ? (Math.asin(Math.max(-1, Math.min(1, mesh.p[3 * i + 2]))) * 180) / Math.PI : latitudeOf(world.settings, mesh.y[i]);
}

// 按网格、比例尺、新建时的纬度缓存的几样：按东西坐标排的格、每条边往东的位移（地区是 x 的差，星球是切平面里的东分量）、
// 每格的纬度带与盛行风。排序按 (x, 编号)：先按 x 分进 n 个桶（计数排序），桶里再插入排序（每桶平均一格），与整体排序的先后相同
interface SweepGeo {
  key: string;
  order: Int32Array;
  east: Float64Array;
  rain: Float64Array;
  we: Float64Array;
}
const geoCache = new WeakMap<Mesh, SweepGeo>();
function sortByX(x: Float64Array, n: number): Int32Array {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < n; i++) {
    if (x[i] < lo) lo = x[i];
    if (x[i] > hi) hi = x[i];
  }
  const scale = hi > lo ? (n - 1) / (hi - lo) : 0;
  const bucket = new Int32Array(n);
  const start = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const b = Math.min(n - 1, Math.floor((x[i] - lo) * scale));
    bucket[i] = b;
    start[b + 1]++;
  }
  for (let b = 0; b < n; b++) start[b + 1] += start[b];
  const fill = start.slice(0, n);
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[fill[bucket[i]]++] = i;
  for (let b = 0; b < n; b++) {
    for (let k = start[b] + 1; k < start[b + 1]; k++) {
      const v = order[k];
      let q = k - 1;
      while (q >= start[b] && (x[order[q]] > x[v] || (x[order[q]] === x[v] && order[q] > v))) {
        order[q + 1] = order[q];
        q--;
      }
      order[q + 1] = v;
    }
  }
  return order;
}
function sweepGeo(world: World): SweepGeo {
  const { mesh, kmPerUnit } = world;
  const s = world.settings;
  const key = `${kmPerUnit}|${mesh.kind === 'sphere' ? 'globe' : `${s.latNorth},${s.latSouth}`}`;
  let g = geoCache.get(mesh);
  if (g && g.key === key) return g;
  const n = mesh.n;
  const x = mesh.x;
  const order = g ? g.order : sortByX(x, n);
  const east = g ? g.east : new Float64Array(mesh.adj.length);
  if (!g) {
    if (mesh.kind === 'sphere') east.set(mesh.edx);
    else for (let i = 0; i < n; i++) for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) east[e] = x[mesh.adj[e]] - x[i];
  }
  const rain = new Float64Array(n);
  const we = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lat = solveLat(world, i);
    rain[i] = latRain(lat);
    we[i] = windEastAt(lat);
  }
  g = { key, order, east, rain, we };
  geoCache.set(mesh, g);
  return g;
}

// 一格从上风的邻格接过走过的陆路与挡着的山（dir = 1：风往东吹，上风在西边）
function sweepCell(i: number, dir: number, off: Int32Array, adj: Int32Array, dist: Float64Array, km: number, east: Float64Array, land: Uint8Array, todo: Uint8Array, road: Float64Array, sh: Float64Array, hgt: Float64Array) {
  let best = Infinity;
  let bestSh = 0;
  for (let e = off[i]; e < off[i + 1]; e++) {
    if (east[e] * dir >= 0) continue;
    const j = adj[e];
    const L = dist[e] * km;
    if (land[j] !== 1) {
      if (L * 0.5 < best) {
        best = L * 0.5;
        bestSh = 0;
      }
    } else if (todo[j] === 1) {
      const r = road[j] + L;
      if (r < best) {
        best = r;
        const m = sh[j] > hgt[j] ? sh[j] : hgt[j];
        bestSh = m > 0 ? m * Math.exp(-L / PRECIP.SHADOW_KM) : 0;
      }
    }
  }
  if (best < Infinity) {
    road[i] = best;
    sh[i] = bestSh;
  }
}

// 每个要算的陆格的降水代理 P（写进 out；别的格不动）。hgt：每格的“山”（抬升 + 基准面，原始单位），coastKm：离海岸的 km
export function precipProxy(world: World, todo: Uint8Array, hgt: Float64Array, coastKm: Float64Array, out: Float64Array): void {
  const { mesh, causes } = world;
  const n = mesh.n;
  const land = causes.land;
  const g = sweepGeo(world);
  const { off, adj, dist } = mesh;
  const km = world.kmPerUnit;
  const east = g.east;
  // 只扫要算的格（按东西坐标的先后）
  let m = 0;
  const list = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    const i = g.order[k];
    if (todo[i] === 1) list[m++] = i;
  }
  // road：走过的陆路（km，扫不到时按到最近海岸的距离）；sh：上风方向挡着的山
  const road = new Float64Array(n);
  const sh = new Float64Array(n);
  for (let k = 0; k < m; k++) road[list[k]] = coastKm[list[k]];
  const we = g.we;
  const passes = mesh.kind === 'sphere' ? 2 : 1;
  for (let p = 0; p < passes; p++) {
    for (let k = 0; k < m; k++) {
      const i = list[k];
      if (we[i] >= 0) sweepCell(i, 1, off, adj, dist, km, east, land, todo, road, sh, hgt);
    }
    for (let k = m - 1; k >= 0; k--) {
      const i = list[k];
      if (we[i] < 0) sweepCell(i, -1, off, adj, dist, km, east, land, todo, road, sh, hgt);
    }
  }
  const floor = PRECIP.MARINE_FLOOR;
  const inv = 1 / PRECIP.MARINE_KM;
  const invH = 1 / PRECIP.SHADOW_H;
  for (let k = 0; k < m; k++) {
    const i = list[k];
    const marine = floor + (1 - floor) * Math.exp(-road[i] * inv);
    const over = sh[i] - hgt[i];
    out[i] = (g.rain[i] * marine) / (over > 0 ? 1 + over * invH : 1);
  }
}

// 求解用的几样：wet（流量的权重）、areaQ = 面积 × wet；返回洼地场（米）：生成器的洼地，再在干的内陆按岩性的噪声
// （fk 高处岩性软，是盆地）挖平底的洼地（两者取深的）。没有干的洼地时返回 pitM 本身
// 测试用：关掉（第八十五轮的求解：流量不加权、没有干的洼地）
export const precipOn = { on: true };
export function wetWeights(world: World, todo: Uint8Array, T: Float64Array, coastKm: Float64Array, fk: Float64Array, pitM: Float32Array, areaKm: Float64Array, wet: Float64Array, areaQ: Float64Array): Float32Array {
  const { mesh, causes } = world;
  const n = mesh.n;
  if (!precipOn.on) {
    for (let i = 0; i < n; i++) {
      if (!todo[i]) continue;
      wet[i] = 1;
      areaQ[i] = areaKm[i];
    }
    return pitM;
  }
  const up = causes.uplift;
  const hgt = new Float64Array(n);
  for (let i = 0; i < n; i++) if (todo[i]) hgt[i] = up[i] + Math.max(0, T[i]);
  const P = new Float64Array(n);
  precipProxy(world, todo, hgt, coastKm, P);
  let pit: Float32Array = pitM;
  for (let i = 0; i < n; i++) {
    if (!todo[i]) continue;
    const w = Math.min(1, Math.max(WET.W_MIN, P[i] / WET.P_REF));
    wet[i] = w;
    areaQ[i] = areaKm[i] * w;
    const arid = smoothstep(WET.ARID0, WET.ARID1, P[i]);
    if (arid <= 0) continue;
    const g = arid * smoothstep(WET.DRY_T, WET.DRY_T + WET.DRY_W, (fk[i] - 1) / 0.25) * smoothstep(WET.COAST0, WET.COAST1, coastKm[i]);
    const d = WET.DRY_D * smoothstep(WET.G0, WET.G1, g);
    if (d <= pit[i]) continue;
    if (pit === pitM) pit = pitM.slice();
    pit[i] = d;
  }
  return pit;
}
