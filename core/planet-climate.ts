import { type ClimateBase, insolationTable, radiativeTemp, saturation } from './climate';
import { type SphereMesh, gradient, ringDistance } from './mesh';
import { computeOcean } from './ocean';
import { PLANET_SWEEPS, buildFlowSphere, solveTransportSphere } from './sphere-flow';
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

export { PLANET_SWEEPS, buildFlowSphere, solveTransportSphere, sphereAux } from './sphere-flow';

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
    const g = (r: number, c: number) => blurred[r * COLS + c];
    out[i] = (g(r0, ca) * (1 - tx) + g(r0, cb) * tx) * (1 - ty) + (g(r0 + 1, ca) * (1 - tx) + g(r0 + 1, cb) * tx) * ty;
  }
  list.unshift({ land: land.slice(), kmPerUnit, result: out });
  // 每个网格留两份（预览用的副本不会把正在用的挤掉）
  fracCache.set(mesh, list.slice(0, 2));
  return out;
}

// ---------- 整个星球的气候 ----------

export function computeClimateSphere(world: World, elevation: Float32Array, out: Derived): ClimateBase {
  const { causes, small, kmPerUnit } = world;
  const mesh = world.mesh as SphereMesh;
  const n = mesh.n;
  const planet = small.planet;
  const land = causes.land;
  const ins = insolationTable(planet.tilt, planet.solar);
  const lat = new Float64Array(n);
  for (let i = 0; i < n; i++) lat[i] = worldLatitude(world, mesh.y[i]);
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
  const hPos = new Float64Array(n);
  for (let i = 0; i < n; i++) hPos[i] = land[i] ? Math.max(0, elevation[i]) : 0;
  {
    const passes = Math.max(1, Math.round(((200 / kmPerUnit / mesh.spacing) ** 2) / 2));
    const next = new Float64Array(n);
    for (let it = 0; it < passes; it++) {
      for (let i = 0; i < n; i++) {
        let s = hPos[i];
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) s += hPos[mesh.adj[e]];
        next[i] = s / (1 + mesh.off[i + 1] - mesh.off[i]);
      }
      hPos.set(next);
    }
  }
  for (let i = 0; i < n; i++) {
    const [gx, gy] = gradient(mesh, hPos, i);
    hx[i] = gx / kmPerUnit;
    hy[i] = gy / kmPerUnit;
  }

  const seasons = [1, -1] as const;
  const winds: [Float32Array, Float32Array][] = [
    [out.windSX, out.windSY],
    [out.windWX, out.windWY],
  ];
  const itczOf = (sigma: number) => sigma * 0.35 * planet.tilt;
  seasons.forEach((sigma, si) => {
    const [wx, wy] = winds[si];
    const phiC = itczOf(sigma);
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
    }
  });

  const flow = winds.map(([wx, wy]) => buildFlowSphere(mesh, wx, wy, { lag: 'seam' }));

  // 大陆度：海洋气团示踪量随风深入陆地后衰减
  const marine = new Float64Array(n);
  for (let si = 0; si < 2; si++) {
    const m = solveTransportSphere(
      mesh,
      flow[si],
      PLANET_SWEEPS.wind,
      (i, inflow) => (land[i] ? inflow * Math.exp(-spacingKm[i] / 1500) : 1),
      (i) => (land[i] ? 0.5 : 1),
      (i) => (land[i] ? 0 : 1),
    );
    for (let i = 0; i < n; i++) marine[i] += 0.5 * clamp(m[i], 0, 1);
  }
  for (let i = 0; i < n; i++) out.continentality[i] = land[i] ? 1 - marine[i] : 0;

  // 洋流：海面温度的偏离，再由风带上陆地。洋流强弱为 0 时整段跳过，结果与没有洋流逐值相同
  const strength = planet.currents ?? 1;
  let dSST: Float64Array | null = null;
  let anomaly: Float64Array[] | null = null;
  if (strength > 0) {
    const tAnn = new Float64Array(n);
    const wE = new Float64Array(n);
    const wS = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      tAnn[i] = radiativeTemp(ins(lat[i]).ann);
      wE[i] = (out.windSX[i] + out.windWX[i]) / 2;
      wS[i] = (out.windSY[i] + out.windWY[i]) / 2;
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
    anomaly = flow.map((f) =>
      solveTransportSphere(
        mesh,
        f,
        PLANET_SWEEPS.wind,
        (i, a) => (land[i] ? a * Math.exp((-spacingKm[i] * (1 + Math.max(0, elevation[i]) / 800)) / 1200) : sst[i]),
        (i) => (land[i] ? 0 : sst[i]),
        (i) => (land[i] ? 0 : sst[i]),
      ),
    );
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

  // 温度
  const base: ClimateBase = { tS: new Float32Array(n), tW: new Float32Array(n), pS: new Float32Array(n), pW: new Float32Array(n) };
  const oceanT: Float64Array[] = [new Float64Array(n), new Float64Array(n)];
  for (let i = 0; i < n; i++) {
    const q = ins(lat[i]);
    const tAnn = radiativeTemp(q.ann);
    const amp = land[i] ? 0.3 + 0.7 * out.continentality[i] : 0.3;
    const lapse = land[i] ? (planet.lapse * Math.max(0, elevation[i])) / 1000 : 0;
    const off = causes.tempOffset[i];
    const k = 0.09 * (1 + (0.4 * Math.abs(lat[i])) / 90);
    base.tS[i] = tAnn + k * (q.s - q.ann) * amp - lapse + off;
    base.tW[i] = tAnn + k * (q.w - q.ann) * amp - lapse + off;
    oceanT[0][i] = tAnn + k * (q.s - q.ann) * 0.3;
    oceanT[1][i] = tAnn + k * (q.w - q.ann) * 0.3;
    // 洋流：海上直接改变海温；陆上是风带来的海洋影响
    if (dSST && anomaly) {
      if (land[i]) {
        base.tS[i] += 0.8 * anomaly[0][i];
        base.tW[i] += 0.8 * anomaly[1][i];
      } else {
        base.tS[i] += dSST[i];
        base.tW[i] += dSST[i];
        oceanT[0][i] += dSST[i];
        oceanT[1][i] += dSST[i];
      }
    }
  }
  for (let i = 0; i < n; i++) out.sstAnom[i] = dSST && anomaly ? (land[i] ? (0.8 * (anomaly[0][i] + anomaly[1][i])) / 2 : dSST[i]) : 0;

  // 降水
  for (let si = 0; si < 2; si++) {
    const sigma = seasons[si];
    const [wx, wy] = winds[si];
    const T = si === 0 ? base.tS : base.tW;
    const P = si === 0 ? base.pS : base.pW;
    const phiC = itczOf(sigma);
    const rate = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const d = lat[i] - phiC;
      const ad = Math.abs(d);
      const conv = 1 + 1.6 * Math.exp(-((d / 9) ** 2));
      const subs = 1 - 0.75 * Math.exp(-(((ad - 27) / 9) ** 2));
      const storm = 1 + 0.45 * Math.exp(-(((ad - 52) / 11) ** 2));
      const warmth = 0.45 + 0.55 * smoothstep(-10, 25, T[i]);
      let r = (conv * subs * storm * warmth) / 1800;
      if (land[i]) {
        const wm = Math.hypot(wx[i], wy[i]) || 1;
        const up = (wx[i] * hx[i] + wy[i] * hy[i]) / wm;
        if (up < 0) r *= Math.exp(up / 1.5);
      }
      // 冷水海岸空气稳定（多雾少雨），暖流上空对流更强
      if (dSST && anomaly) r *= clamp(1 + 0.06 * (land[i] ? anomaly[si][i] : dSST[i]), 0.5, 1.25);
      rate[i] = r;
    }
    const satOcean = (i: number) => planet.humidity * saturation(oceanT[si][i]);
    const capOf = (i: number) => planet.humidity * saturation(T[i]) * 1.1;
    const removed = new Float64Array(n);
    solveTransportSphere(
      mesh,
      flow[si],
      PLANET_SWEEPS.wind,
      (i, inflow) => {
        const dKm = spacingKm[i];
        let m = inflow;
        let p = m * (1 - Math.exp(-rate[i] * dKm));
        m -= p;
        if (land[i]) {
          const cap = capOf(i);
          if (m > cap) {
            const excess = (m - cap) * (1 - Math.exp(-dKm / 150));
            p += excess;
            m -= excess;
          }
          m += p * 0.6 * smoothstep(0, 25, T[i]);
        } else {
          const sat = satOcean(i);
          if (m > sat * 1.1) {
            const excess = (m - sat * 1.1) * (1 - Math.exp(-dKm / 150));
            p += excess;
            m -= excess;
          }
          m += (sat - m) * (1 - Math.exp(-dKm / 900));
        }
        removed[i] = p / dKm;
        return Math.max(0, m);
      },
      (i) => (land[i] ? 0.5 * capOf(i) : satOcean(i)),
      // 辐散中心是下沉气流：相对湿度约一半
      (i) => (land[i] ? 0.5 * capOf(i) / 1.1 : 0.5 * satOcean(i)),
    );
    const off = causes.moistOffset;
    for (let i = 0; i < n; i++) P[i] = removed[i] * 1.7e6 * Math.exp(off[i]);
  }
  return base;
}
