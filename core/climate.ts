import { buildFlow, edgeDirs, hasMeshAux, meshAux } from './climate-flow';
import { insolationTable, radiativeTemp, smoothPass } from './climate-physics';
import { ContentMemo, sameBytes } from './content-memo';
import { type Mesh, gradientField } from './mesh';
import { clamp, smoothstep } from './rng';
import { NO_SAT, type PlaneSea, planeGrid, planeSea } from './ocean-plane';
import { type Derived, type World, worldLatitude } from './world';
import { OROGRAPHIC_KM, deflectWind, smoothPasses, windDeflectPasses } from './wind-deflect';

// 第四十六轮：几块按职责搬到别的文件（代码原样），这里照旧导出
export { type Flow, type PlaneFlow, kahnOrder } from './climate-flow';
export { insolationTable, radiativeTemp, smoothPass } from './climate-physics';
export { ContentMemo } from './content-memo';
export { OROGRAPHIC_KM, deflectWind, smoothPasses, windDeflectPasses } from './wind-deflect';

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

// 这两个每格每季都要调，留在这个文件里（搬走后 Node 里 finalizeClimate 量到慢约 0.7 ms）
// 相对饱和水汽量（25 °C 为 1）
export function saturation(t: number): number {
  return Math.exp(0.045 * (clamp(t, -40, 40) - 25));
}

export function petHalf(t: number): number {
  return t >= 0 ? 100 + 24 * t : 100 * Math.exp(t / 8);
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
  // 偏转前的两季背景风（第四十六轮：区域的洋流用，按海陆缓存的那一份）
  baseWinds: Float32Array[];
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

  const t: PlaneTerrain = { lat, written: written.map((a) => a.slice()), flows, edges, edgeW, dKm: spacingKm, e150, e900, rain, lee, baseWinds };
  planeMemo.keep(mesh, [land.slice(), elevation.slice(), lat], params, t);
  return t;
}

// 空闲预热（第三十一轮，见 engine.ts 的 warmSteps）：只取决于网格、纬度与海陆的几样（网格的邻接反查与扫描顺序、
// 边的方向、格距、背景风带与日照、大尺度的陆地占比与偏转前的风）先算好放进缓存，打开后的第一笔不用等。
// 与 computeClimate 里用到时现算的是同一份。返回是否算了
export function prepareClimatePlane(world: World): boolean {
  const { mesh, causes, kmPerUnit, small } = world;
  const fresh = !hasMeshAux(mesh) || !(landFracCache.get(mesh) ?? []).some((c) => c.kmPerUnit === kmPerUnit && c.land.length === causes.land.length && c.land.every((v, i) => v === causes.land[i]));
  if (!fresh) return false;
  meshAux(mesh);
  edgeDirs(mesh);
  const lat = new Float64Array(mesh.n);
  for (let i = 0; i < mesh.n; i++) lat[i] = worldLatitude(world, mesh.y[i]);
  planeGeo(mesh, kmPerUnit);
  planeSun(mesh, lat, small.planet.tilt, small.planet.solar);
  planeWinds(mesh, planeStatic(mesh, lat, small.planet.tilt, small.planet.rotation, kmPerUnit), landFraction(mesh, causes.land, kmPerUnit));
  // 洋流（第四十六轮）：栅格（每个像素在哪一格）与只取决于海陆的那一份（打开后第一笔不用等）
  if (small.planet.currents > 0) {
    planeGrid(mesh);
    planeSeaOf(world, lat, null);
  }
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
  // 洋流（第四十六轮，见 ocean-plane.ts）：海上直接改变海温，陆上是风带来的海洋影响。强弱为 0 时整段跳过（与没有洋流逐值相同）
  const sea = planet.currents > 0 ? planeSeaOf(world, lat, out, tr.baseWinds) : null;
  const satSea = sea ? seaSaturation(n, land, sun, sea) : null;
  // 这个进程里第一次算洋流时，海面饱和水汽量那一遍也空算几遍（只在改海陆时才跑的循环先编译好，见 ocean-plane.ts 的 warmed）
  if (sea && !satWarmed) {
    satWarmed = true;
    for (let k = 0; k < 3; k++) seaSaturation(n, land, sun, { ...sea, sat: [], satFor: NO_SAT });
  }
  if (sea) currentTemps(n, land, sea, base.tS, base.tW);
  else {
    out.currentX.fill(0);
    out.currentY.fill(0);
    out.sstAnom.fill(0);
  }

  // 降水：每格的降落比例、饱和量先算好（与逐遍现算的值相同），输运时每遍只做加权平均与逐格的收支
  for (let si = 0; si < 2; si++) {
    const T = si === 0 ? base.tS : base.tW;
    const P = si === 0 ? base.pS : base.pW;
    const rain = tr.rain[si];
    const lee = tr.lee[si];
    const satO = satSea ? satSea[si] : sun.satOcean[si];
    const fall = new Float64Array(n);
    const lim = new Float64Array(n);
    const evap = new Float64Array(n);
    if (sea) planeRainSetupCur(n, land, T, rain, lee, sea.x[si], satO, dKm, planet.humidity, fall, lim, evap);
    else planeRainSetup(n, land, T, rain, lee, satO, dKm, planet.humidity, fall, lim, evap);
    // 图外来流：图外是海时取当地海面饱和量
    const num0 = new Float64Array(n);
    edgeMoisture(tr.edges[si], tr.edgeW[si], planet.humidity, satO, num0);
    const removed = new Float64Array(n);
    moistSweeps(tr, si, orders, num0, land, fall, lim, evap, removed);
    precipOf(n, removed, causes.moistOffset, P);
  }
  return base;
}

// 区域的洋流（第四十六轮）：用偏转前的背景风（与星球相同，山挡风不改洋流；带上陆地也按它，见 ocean-plane.ts）
// out 为 null 时只算、放进缓存（空闲预热）；bw：偏转前的两季背景风（planeTerrain 记着，没有时现取，都在缓存里）
function planeSeaOf(world: World, lat: Float64Array, out: Derived | null, bw?: Float32Array[]): PlaneSea {
  const { mesh, causes, small, kmPerUnit } = world;
  const planet = small.planet;
  if (!bw) bw = planeWinds(mesh, planeStatic(mesh, lat, planet.tilt, planet.rotation, kmPerUnit), landFraction(mesh, causes.land, kmPerUnit));
  const sun = planeSun(mesh, lat, planet.tilt, planet.solar);
  const sea = planeSea(mesh, {
    land: causes.land,
    latAt: (y) => worldLatitude(world, y),
    tAnn: sun.tAnn,
    seasons: bw,
    tilt: planet.tilt,
    rotation: planet.rotation,
    outsideOcean: planet.outsideOcean,
    kmPerUnit,
    strength: planet.currents,
  });
  if (!out) return sea;
  out.currentX.set(sea.cellE);
  out.currentY.set(sea.cellS);
  sstAnomOut(causes.land, sea.x[0], sea.x[1], out.sstAnom);
  return sea;
}

let satWarmed = false;
// 两季海面温度的饱和水汽量（海格加上洋流的增减），记在洋流那一份上（按日照那一份认）。陆格就是日照那一份里的（同一个算式），只算海格
function seaSaturation(n: number, land: Uint8Array, sun: PlaneSun, sea: PlaneSea): Float64Array[] {
  if (sea.sat.length && sea.satFor === sun.oceanT[0]) return sea.sat;
  const sat = sea.sat.length && sea.sat[0].length === n ? sea.sat : [new Float64Array(n), new Float64Array(n)];
  for (let si = 0; si < 2; si++) {
    sat[si].set(sun.satOcean[si]);
    seaSat(n, land, sun.oceanT[si], sea.x[0], sat[si]);
  }
  sea.sat = sat;
  sea.satFor = planeLayers.on ? sun.oceanT[0] : NO_SAT;
  return sat;
}
function seaSat(n: number, land: Uint8Array, oceanT: Float64Array, sst: Float64Array, out: Float64Array) {
  for (let i = 0; i < n; i++) if (!land[i]) out[i] = saturation(oceanT[i] + sst[i]);
}

// 洋流带来的增减（与星球相同：先写进 Float32 再加）：海上直接改变海温，陆上是风带来的海洋影响的八成
function currentTemps(n: number, land: Uint8Array, sea: PlaneSea, tS: Float32Array, tW: Float32Array) {
  const [x0, x1] = sea.x;
  for (let i = 0; i < n; i++) {
    tS[i] += land[i] ? 0.8 * x0[i] : x0[i];
    tW[i] += land[i] ? 0.8 * x1[i] : x1[i];
  }
}

// 写进推导的海温偏离：海上是海温的增减，陆上是两季带上来的偏离的平均的八成
function sstAnomOut(land: Uint8Array, x0: Float64Array, x1: Float64Array, out: Float32Array) {
  for (let i = 0; i < land.length; i++) out[i] = land[i] ? (0.8 * (x0[i] + x1[i])) / 2 : x0[i];
}

// 与 planeRainSetup 相同，降水速率再乘洋流的倍数 clamp(1 + 0.06·x, 0.5, 1.25)（与星球的 rainSetup 同一个写法）
function planeRainSetupCur(n: number, land: Uint8Array, T: Float32Array, rain: Float64Array, lee: Float64Array, x: Float64Array, satO: Float64Array, dKm: Float64Array, humidity: number, fall: Float64Array, lim: Float64Array, evap: Float64Array) {
  for (let i = 0; i < n; i++) {
    const warmth = 0.45 + 0.55 * smoothstep(-10, 25, T[i]);
    const r = ((rain[i] * warmth) / 1800) * lee[i] * clamp(1 + 0.06 * x[i], 0.5, 1.25);
    fall[i] = 1 - Math.exp(-r * dKm[i]);
    if (land[i]) {
      lim[i] = humidity * saturation(T[i]) * 1.1;
      evap[i] = smoothstep(0, 25, T[i]);
    } else lim[i] = humidity * satO[i];
  }
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
