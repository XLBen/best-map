import { type ClimateBase, ContentMemo, deflectWind, insolationTable, radiativeTemp, saturation, smoothPass, windDeflectPasses } from './climate';
import { type SphereMesh, gradient, ringDistance } from './mesh';
import { computeOcean } from './ocean';
import { PLANET_SWEEPS, type SphereFlow, buildFlowSphere } from './sphere-flow';
import { clamp, smoothstep } from './rng';
import { type Derived, type World, worldLatitude } from './world';

// 整个星球的气候：与 climate.ts 同一套过程模型（日照 → 温度，三圈环流 + 季风 → 风，水汽沿风输运 → 降水），
// 差别只在球面上必须不同的地方：
//   · 风、方向都用每格自己的“东、南”切向分量；两极附近风逐渐减弱为零（极地高压），不会绕着极点打转
//   · 没有地图边：没有图外来的水汽，所有水汽都来自星球上的海
//   · 纬向风带是绕星球一圈的环：跨过经度 180° 且顺着风带的边保留为“滞后边”（读上一遍的值），
//     风带因此首尾相接、迭代收敛；风弱、风向杂乱处的局部小环照旧剪断。相互指向的两格只保留较强的一边，
//     这条规则与处理顺序无关，所以不会在某个经度留下一条痕迹
//   · 扫描固定遍数：一处修改不会因为迭代次数变化而改动无关的地方
//   · 季风用的大尺度陆地占比在 2° 经纬格上做东西方向首尾相接的高斯模糊（比几百轮格上扩散快得多）

export { PLANET_SWEEPS, buildFlowSphere, sphereAux } from './sphere-flow';

// ---------- 大尺度陆地占比（季风用） ----------

const ROWS = 90;
const COLS = 180;
const pixelCache = new WeakMap<SphereMesh, Int32Array>();
const fracCache = new WeakMap<SphereMesh, { land: Uint8Array; kmPerUnit: number; result: Float64Array }[]>();

// 2° 经纬格每个像素中心所在的格（只取决于网格）
function pixelCells(mesh: SphereMesh): Int32Array {
  let px = pixelCache.get(mesh);
  if (px) return px;
  px = new Int32Array(ROWS * COLS);
  let hint = 0;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      hint = mesh.locate(((c + 0.5) / COLS) * 2, (r + 0.5) / ROWS, hint);
      px[r * COLS + c] = hint;
    }
  }
  pixelCache.set(mesh, px);
  return px;
}

// 高斯模糊：σ ≈ 0.46 × 1500 km，与平面世界里 (1500 km / 格距)² / 2 轮格上扩散的宽度相同
export function landFractionSphere(mesh: SphereMesh, land: Uint8Array, kmPerUnit: number): Float64Array {
  const list = fracCache.get(mesh) ?? [];
  for (const c of list) if (c.kmPerUnit === kmPerUnit && c.land.length === land.length && c.land.every((v, i) => v === land[i])) return c.result;
  const px = pixelCells(mesh);
  const grid = new Float64Array(ROWS * COLS);
  for (let k = 0; k < grid.length; k++) grid[k] = land[px[k]];
  const sigmaKm = 0.463 * 1500;
  // 一个像素在南北方向上的 km（地图高 1 = kmPerUnit，ROWS 个像素）
  const pxKm = kmPerUnit / ROWS;
  const tmp = new Float64Array(ROWS * COLS);
  // 东西方向：首尾相接，核宽随 cos 纬度变宽；宽到超过一圈时就是整行平均
  for (let r = 0; r < ROWS; r++) {
    const cosLat = Math.sin(((r + 0.5) / ROWS) * Math.PI);
    const s = sigmaKm / (pxKm * Math.max(cosLat, 1e-3));
    if (s > COLS / 2) {
      let m = 0;
      for (let c = 0; c < COLS; c++) m += grid[r * COLS + c];
      m /= COLS;
      for (let c = 0; c < COLS; c++) tmp[r * COLS + c] = m;
      continue;
    }
    const rad = Math.ceil(3 * s);
    const w: number[] = [];
    let wsum = 0;
    for (let d = -rad; d <= rad; d++) {
      const v = Math.exp(-(d * d) / (2 * s * s));
      w.push(v);
      wsum += v;
    }
    for (let c = 0; c < COLS; c++) {
      let acc = 0;
      for (let d = -rad; d <= rad; d++) acc += w[d + rad] * grid[r * COLS + ((((c + d) % COLS) + COLS) % COLS)];
      tmp[r * COLS + c] = acc / wsum;
    }
  }
  // 南北方向：两端截断（按实际参与的权重归一）
  const s = sigmaKm / pxKm;
  const rad = Math.ceil(3 * s);
  const blurred = new Float64Array(ROWS * COLS);
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      let acc = 0;
      let wsum = 0;
      for (let d = -rad; d <= rad; d++) {
        const rr = r + d;
        if (rr < 0 || rr >= ROWS) continue;
        const v = Math.exp(-(d * d) / (2 * s * s));
        acc += v * tmp[rr * COLS + c];
        wsum += v;
      }
      blurred[r * COLS + c] = acc / wsum;
    }
  }
  // 双线性插值回到格上
  const n = mesh.n;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const fx = (mesh.x[i] / 2) * COLS - 0.5;
    const fy = Math.min(ROWS - 1, Math.max(0, mesh.y[i] * ROWS - 0.5));
    const c0 = Math.floor(fx);
    const r0 = Math.min(ROWS - 2, Math.floor(fy));
    const tx = fx - c0;
    const ty = fy - r0;
    const ca = ((c0 % COLS) + COLS) % COLS;
    const cb = (ca + 1) % COLS;
    const a = r0 * COLS;
    const b = (r0 + 1) * COLS;
    out[i] = (blurred[a + ca] * (1 - tx) + blurred[a + cb] * tx) * (1 - ty) + (blurred[b + ca] * (1 - tx) + blurred[b + cb] * tx) * ty;
  }
  list.unshift({ land: land.slice(), kmPerUnit, result: out });
  // 每个网格留两份（预览用的副本不会把正在用的挤掉）
  fracCache.set(mesh, list.slice(0, 2));
  return out;
}

// ---------- 整个星球的气候 ----------

// 输运图里输运要用的部分（入流表，见 SphereFlow）
type Inflow = Pick<SphereFlow, 'order' | 'koff' | 'src' | 'w' | 'den'>;

// 只取决于地形的部分：风、输运图、大陆度、洋流（海温的偏离与它随风带上陆地的部分）、地形对降水的影响，以及
// 不含直减率、冷暖微调的温度。只取决于海陆、高程、各格纬度、倾角、自转、日照、洋流强弱、山挡风、比例尺与扫描遍数，
// 只改冷暖干湿、湿度、直减率时原样复用
interface SphereTerrain {
  // 写进推导的（windSX、windSY、windWX、windWY、continentality、currentX、currentY、sstAnom 的顺序）
  written: Float32Array[];
  flows: Inflow[];
  // 格距（km）与按格距在约 150 km、900 km 上降下、回到饱和的比例
  dKm: Float64Array;
  e150: Float64Array;
  e900: Float64Array;
  // 两季：年均温加季节振幅（不含直减率与微调）、洋流带来的增减（没有洋流时为 null）、海面温度的饱和水汽量
  t0: Float64Array[];
  add: Float64Array[] | null;
  satSea: Float64Array[];
  // 两季降水速率里只取决于纬度的部分（辐合 × 副高下沉 × 风暴带）、背风的抑制（不在背风处为 1）、洋流的影响
  rain: Float64Array[];
  lee: Float64Array[];
  cur: Float64Array[] | null;
}

// 一份约每万格 2.7 MB：大网格只留一份
export const sphereMemo = new ContentMemo<SphereTerrain>(60000);

const SEASONS = [1, -1] as const;
const itczOf = (sigma: number, tilt: number) => sigma * 0.35 * tilt;

function sphereTerrain(world: World, elevation: Float32Array, out: Derived): SphereTerrain {
  const { causes, small, kmPerUnit } = world;
  const mesh = world.mesh as SphereMesh;
  const n = mesh.n;
  const planet = small.planet;
  const land = causes.land;
  const lat = new Float64Array(n);
  for (let i = 0; i < n; i++) lat[i] = worldLatitude(world, mesh.y[i]);
  const strength = planet.currents ?? 1;
  // 山挡风：旧存档里没有这一项，按 0（风直接翻过山）
  const terrainWind = planet.terrainWind ?? 0;
  const written = [out.windSX, out.windSY, out.windWX, out.windWY, out.continentality, out.currentX, out.currentY, out.sstAnom];
  const params = [planet.tilt, planet.rotation, planet.solar, strength, kmPerUnit, PLANET_SWEEPS.wind, PLANET_SWEEPS.ocean, terrainWind];
  const hit = sphereMemo.find(mesh, [land, elevation, lat], params);
  if (hit) {
    written.forEach((a, k) => a.set(hit.written[k]));
    return hit;
  }
  const ins = insolationTable(planet.tilt, planet.solar);
  const spacingKm = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) s += mesh.dist[e];
    spacingKm[i] = (s / Math.max(1, mesh.off[i + 1] - mesh.off[i])) * kmPerUnit;
  }

  const landFrac = landFractionSphere(mesh, land, kmPerUnit);
  // 陆地占比的梯度（东、南分量，每地图单位）：季风用，两个季节共用
  const lfE = new Float64Array(n);
  const lfS = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const [gx, gy] = gradient(mesh, landFrac, i);
    lfE[i] = gx;
    lfS[i] = gy;
  }

  // 高程梯度（m/km），先平滑到约 200 km 尺度
  const hx = new Float64Array(n);
  const hy = new Float64Array(n);
  let hPos = new Float64Array(n);
  for (let i = 0; i < n; i++) hPos[i] = land[i] ? Math.max(0, elevation[i]) : 0;
  {
    const passes = Math.max(1, Math.round(((200 / kmPerUnit / mesh.spacing) ** 2) / 2));
    let next = new Float64Array(n);
    for (let it = 0; it < passes; it++) {
      smoothPass(mesh, hPos, next);
      const t = hPos;
      hPos = next;
      next = t;
    }
  }
  for (let i = 0; i < n; i++) {
    const [gx, gy] = gradient(mesh, hPos, i);
    hx[i] = gx / kmPerUnit;
    hy[i] = gy / kmPerUnit;
  }

  const winds: [Float32Array, Float32Array][] = [
    [out.windSX, out.windSY],
    [out.windWX, out.windWY],
  ];
  // 山挡风打开时：两季还没乘极地衰减的风（双精度）与每格的衰减，先偏转、再乘衰减（偏转不会漏到极点上）
  const raw = terrainWind > 0 ? winds.map((): [Float64Array, Float64Array] => [new Float64Array(n), new Float64Array(n)]) : null;
  const taper = terrainWind > 0 ? new Float64Array(n) : null;
  SEASONS.forEach((sigma, si) => {
    const [wx, wy] = winds[si];
    const phiC = itczOf(sigma, planet.tilt);
    for (let i = 0; i < n; i++) {
      const d = lat[i] - phiC;
      const ad = Math.min(90, Math.abs(d));
      // 离极点 12° 内纬向风逐渐减弱：近极点的风变成向外吹的极地高压
      const r = 90 - Math.abs(lat[i]);
      let uZonal = -Math.cos((Math.PI * ad) / 45) * planet.rotation * (ad < 22.5 ? 0.8 : 1);
      uZonal *= Math.min(1, r / 12) ** 2;
      const toward = ad < 67.5 ? 0.3 * Math.sin((2 * Math.PI * ad) / 45) : 0.25;
      let u = uZonal;
      let v = d > 0 ? toward : -toward;
      const L = 1500 / kmPerUnit;
      const summer = Math.sign(lat[i]) === sigma;
      const g = Math.exp(-(((Math.abs(lat[i]) - 22) / 12) ** 2));
      const k = (summer ? 1.1 : -0.25) * g * L;
      u += k * lfE[i];
      v += k * lfS[i];
      const mag = Math.hypot(u, v);
      const lim = 1.3;
      if (mag > lim) {
        u *= lim / mag;
        v *= lim / mag;
      }
      // 极点上风为零（整个矢量在离极点 4° 内平滑地减到零）
      const t = Math.min(1, r / 4) ** 2;
      wx[i] = u * t;
      wy[i] = v * t;
      if (raw && taper) {
        raw[si][0][i] = u;
        raw[si][1][i] = v;
        taper[i] = t;
      }
    }
  });
  // 山挡风：为 0 时整段跳过（与没有这一步逐值相同）。洋流照旧用背景风（上面写好的值）的两季平均，
  // 所以洋流和它的缓存都不变；大陆度、海温上岸、背风、输运都跟着拐过的风走
  let background: [Float64Array, Float64Array] | null = null;
  if (raw && taper) {
    background = [new Float64Array(n), new Float64Array(n)];
    for (let i = 0; i < n; i++) {
      background[0][i] = (out.windSX[i] + out.windWX[i]) / 2;
      background[1][i] = (out.windSY[i] + out.windWY[i]) / 2;
    }
    const delta = deflectWind(mesh, lat, hPos, hx, hy, terrainWind, planet.rotation, windDeflectPasses(mesh.spacing * kmPerUnit), [raw[0], raw[1]]);
    raw.forEach(([u, v], si) => {
      const [wx, wy] = winds[si];
      const [du, dv] = delta[si];
      for (let i = 0; i < n; i++) {
        if (du[i] === 0 && dv[i] === 0) continue;
        wx[i] = (u[i] + du[i]) * taper[i];
        wy[i] = (v[i] + dv[i]) * taper[i];
      }
    });
  }

  const flows = winds.map(([wx, wy]) => buildFlowSphere(mesh, wx, wy, { lag: 'seam' }));

  // 大陆度：海洋气团示踪量随风深入陆地后衰减
  const marineInit = new Float64Array(n);
  const decay = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    marineInit[i] = land[i] ? 0.5 : 1;
    if (land[i]) decay[i] = Math.exp(-spacingKm[i] / 1500);
  }
  const marine = new Float64Array(n);
  for (let si = 0; si < 2; si++) {
    const m = landSweeps(flows[si], land, marineInit, decay);
    for (let i = 0; i < n; i++) marine[i] += 0.5 * clamp(m[i], 0, 1);
  }
  for (let i = 0; i < n; i++) out.continentality[i] = land[i] ? 1 - marine[i] : 0;

  // 洋流：海面温度的偏离，再由风带上陆地。洋流强弱为 0 时整段跳过，结果与没有洋流逐值相同
  let dSST: Float64Array | null = null;
  let anomaly: Float64Array[] | null = null;
  if (strength > 0) {
    const tAnn = new Float64Array(n);
    const wE = new Float64Array(n);
    const wS = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      tAnn[i] = radiativeTemp(ins(lat[i]).ann);
      wE[i] = background ? background[0][i] : (out.windSX[i] + out.windWX[i]) / 2;
      wS[i] = background ? background[1][i] : (out.windSY[i] + out.windWY[i]) / 2;
    }
    const oc = computeOcean(world, { lat, tAnn, wE, wS, spacingKm });
    const sst = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      sst[i] = clamp(strength * oc.dSST1[i], -14, 14);
      out.currentX[i] = oc.cE[i];
      out.currentY[i] = oc.cS[i];
    }
    dSST = sst;
    // 海温的偏离随风带上陆地：约 1200 km 内衰减，山会挡住
    const sstInit = new Float64Array(n);
    const sstDecay = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      sstInit[i] = land[i] ? 0 : sst[i];
      if (land[i]) sstDecay[i] = Math.exp((-spacingKm[i] * (1 + Math.max(0, elevation[i]) / 800)) / 1200);
    }
    anomaly = flows.map((f) => landSweeps(f, land, sstInit, sstDecay));
    // 海风：吹离岸风的海岸也受海的影响（沿岸约 150 km 内和邻格平均）
    let meanSpacing = 0;
    for (let i = 0; i < n; i++) meanSpacing += spacingKm[i];
    meanSpacing /= n;
    const passes = Math.max(1, Math.round(150 / meanSpacing));
    const seaCells: number[] = [];
    for (let i = 0; i < n; i++) if (!land[i]) seaCells.push(i);
    const ring = ringDistance(mesh, seaCells, passes);
    for (const A of anomaly) {
      for (let pass = 0; pass < passes; pass++) {
        const next = Float64Array.from(A);
        for (let i = 0; i < n; i++) {
          if (!land[i] || ring[i] < 0) continue;
          let s = 0;
          let m = 0;
          for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
            s += A[mesh.adj[e]];
            m++;
          }
          next[i] = 0.5 * A[i] + (0.5 * s) / Math.max(1, m);
        }
        A.set(next);
      }
    }
  } else {
    out.currentX.fill(0);
    out.currentY.fill(0);
  }
  for (let i = 0; i < n; i++) out.sstAnom[i] = dSST && anomaly ? (land[i] ? (0.8 * (anomaly[0][i] + anomaly[1][i])) / 2 : dSST[i]) : 0;

  // 温度里只取决于地形的部分；洋流：海上直接改变海温，陆上是风带来的海洋影响
  const t0 = [new Float64Array(n), new Float64Array(n)];
  const add = dSST && anomaly ? [new Float64Array(n), new Float64Array(n)] : null;
  const satSea = [new Float64Array(n), new Float64Array(n)];
  for (let i = 0; i < n; i++) {
    const q = ins(lat[i]);
    const tAnn = radiativeTemp(q.ann);
    const amp = land[i] ? 0.3 + 0.7 * out.continentality[i] : 0.3;
    const k = 0.09 * (1 + (0.4 * Math.abs(lat[i])) / 90);
    t0[0][i] = tAnn + k * (q.s - q.ann) * amp;
    t0[1][i] = tAnn + k * (q.w - q.ann) * amp;
    let oS = tAnn + k * (q.s - q.ann) * 0.3;
    let oW = tAnn + k * (q.w - q.ann) * 0.3;
    if (add && dSST && anomaly) {
      if (land[i]) {
        add[0][i] = 0.8 * anomaly[0][i];
        add[1][i] = 0.8 * anomaly[1][i];
      } else {
        add[0][i] = dSST[i];
        add[1][i] = dSST[i];
        oS += dSST[i];
        oW += dSST[i];
      }
    }
    satSea[0][i] = saturation(oS);
    satSea[1][i] = saturation(oW);
  }

  // 降水里只取决于地形的部分
  const rain = [new Float64Array(n), new Float64Array(n)];
  const lee = [new Float64Array(n), new Float64Array(n)];
  const cur = dSST && anomaly ? [new Float64Array(n), new Float64Array(n)] : null;
  for (let si = 0; si < 2; si++) {
    const [wx, wy] = winds[si];
    const phiC = itczOf(SEASONS[si], planet.tilt);
    for (let i = 0; i < n; i++) {
      const d = lat[i] - phiC;
      const ad = Math.abs(d);
      const conv = 1 + 1.6 * Math.exp(-((d / 9) ** 2));
      const subs = 1 - 0.75 * Math.exp(-(((ad - 27) / 9) ** 2));
      const storm = 1 + 0.45 * Math.exp(-(((ad - 52) / 11) ** 2));
      rain[si][i] = conv * subs * storm;
      lee[si][i] = 1;
      if (land[i]) {
        const wm = Math.hypot(wx[i], wy[i]) || 1;
        const up = (wx[i] * hx[i] + wy[i] * hy[i]) / wm;
        if (up < 0) lee[si][i] = Math.exp(up / 1.5);
      }
      // 冷水海岸空气稳定（多雾少雨），暖流上空对流更强
      if (cur && dSST && anomaly) cur[si][i] = clamp(1 + 0.06 * (land[i] ? anomaly[si][i] : dSST[i]), 0.5, 1.25);
    }
  }
  const e150 = new Float64Array(n);
  const e900 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    e150[i] = 1 - Math.exp(-spacingKm[i] / 150);
    e900[i] = 1 - Math.exp(-spacingKm[i] / 900);
  }

  // 只留输运要用的入流表（frac、lagged 不再用到）
  const kept = flows.map(({ order, koff, src, w, den }): Inflow => ({ order, koff, src, w, den }));
  const t: SphereTerrain = { written: written.map((a) => a.slice()), flows: kept, dKm: spacingKm, e150, e900, t0, add, satSea, rain, lee, cur };
  sphereMemo.keep(mesh, [land.slice(), elevation.slice(), lat], params, t);
  return t;
}

export function computeClimateSphere(world: World, elevation: Float32Array, out: Derived): ClimateBase {
  const { causes, small } = world;
  const n = world.mesh.n;
  const planet = small.planet;
  const land = causes.land;
  const tr = sphereTerrain(world, elevation, out);
  const { dKm, e150, e900 } = tr;

  // 温度
  const base: ClimateBase = { tS: new Float32Array(n), tW: new Float32Array(n), pS: new Float32Array(n), pW: new Float32Array(n) };
  const [t0S, t0W] = tr.t0;
  for (let i = 0; i < n; i++) {
    const lapse = land[i] ? (planet.lapse * Math.max(0, elevation[i])) / 1000 : 0;
    const off = causes.tempOffset[i];
    base.tS[i] = t0S[i] - lapse + off;
    base.tW[i] = t0W[i] - lapse + off;
    if (tr.add) {
      base.tS[i] += tr.add[0][i];
      base.tW[i] += tr.add[1][i];
    }
  }

  // 降水：每格的降落比例、饱和量先算好（与逐遍现算的值相同），输运时每遍只做加权平均与逐格的收支
  for (let si = 0; si < 2; si++) {
    const T = si === 0 ? base.tS : base.tW;
    const P = si === 0 ? base.pS : base.pW;
    const rain = tr.rain[si];
    const lee = tr.lee[si];
    const cur = tr.cur ? tr.cur[si] : null;
    const satSea = tr.satSea[si];
    // fall：本格降落的比例；lim：陆上抬升冷却后的饱和量（cap），海上为海面饱和量；evap：陆面蒸散回补的比例
    const fall = new Float64Array(n);
    const lim = new Float64Array(n);
    const evap = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const warmth = 0.45 + 0.55 * smoothstep(-10, 25, T[i]);
      // 不在背风处 lee 为 1，乘上去数值不变
      let r = ((rain[i] * warmth) / 1800) * lee[i];
      if (cur) r *= cur[i];
      fall[i] = 1 - Math.exp(-r * dKm[i]);
      if (land[i]) {
        lim[i] = planet.humidity * saturation(T[i]) * 1.1;
        evap[i] = smoothstep(0, 25, T[i]);
      } else lim[i] = planet.humidity * satSea[i];
    }
    const { order, koff, src, w, den } = tr.flows[si];
    const removed = new Float64Array(n);
    // 水汽，初值：陆上为饱和量的一半，海上为海面饱和量
    const moist = new Float64Array(n);
    for (let i = 0; i < n; i++) moist[i] = land[i] ? 0.5 * lim[i] : lim[i];
    for (let s = 0; s < PLANET_SWEEPS.wind; s++) {
      for (let k = 0; k < n; k++) {
        const i = order[k];
        let num = 0;
        for (let q = koff[k]; q < koff[k + 1]; q++) num += moist[src[q]] * w[q];
        // 辐散中心是下沉气流：相对湿度约一半
        let m = den[k] > 1e-9 ? num / den[k] : land[i] ? (0.5 * lim[i]) / 1.1 : 0.5 * lim[i];
        let p = m * fall[i];
        m -= p;
        if (land[i]) {
          const cap = lim[i];
          if (m > cap) {
            const excess = (m - cap) * e150[i];
            p += excess;
            m -= excess;
          }
          m += p * 0.6 * evap[i];
        } else {
          const sat = lim[i];
          if (m > sat * 1.1) {
            const excess = (m - sat * 1.1) * e150[i];
            p += excess;
            m -= excess;
          }
          m += (sat - m) * e900[i];
        }
        removed[i] = p / dKm[i];
        moist[i] = Math.max(0, m);
      }
    }
    const off = causes.moistOffset;
    for (let i = 0; i < n; i++) P[i] = removed[i] * 1.7e6 * Math.exp(off[i]);
  }
  return base;
}

// 示踪量的稳态输运（与按格回调的通用写法逐值相同）：沿拓扑序扫描固定遍数，每格取上风各格的加权平均再乘上本格的衰减；
// 海上格的值一直是初值，只扫陆地格。没有任何上风来源的陆地格取 0
function landSweeps(f: Inflow, land: Uint8Array, init: Float64Array, decay: Float64Array): Float64Array {
  const n = land.length;
  const { order, koff, src, w, den } = f;
  const out = Float64Array.from(init);
  for (let s = 0; s < PLANET_SWEEPS.wind; s++) {
    for (let k = 0; k < n; k++) {
      const i = order[k];
      if (!land[i]) continue;
      let num = 0;
      for (let q = koff[k]; q < koff[k + 1]; q++) num += out[src[q]] * w[q];
      out[i] = (den[k] > 1e-9 ? num / den[k] : 0) * decay[i];
    }
  }
  return out;
}
