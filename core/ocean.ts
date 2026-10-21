import { type SphereMesh, gradient, graphDistance } from './mesh';
import { clamp, smoothstep } from './rng';
import { PLANET_SWEEPS, buildFlowSphere, solveTransportSphere } from './sphere-flow';
import type { World } from './world';

// 简化的洋流（只用于整个星球）。给人看的说法：
//   风推着海面走。每个大洋里，信风和西风让海水转成一个大圈（北半球顺时针，南半球逆时针）；
//   回流挤在大洋西侧，成为又窄又快的暖流，沿大陆东岸流向高纬；大洋东侧是又宽又慢的寒流，
//   沿大陆西岸流向赤道，那里风把表层海水推离岸边、冷水上涌，海岸凉爽干燥。
//   西风把暖水带到高纬大陆的西岸，冬天比同纬度的东岸暖和。没有陆地挡着的纬度，海水绕星球一圈。
// 做法：
//   1. 挡海流的陆地：够大的陆块（小岛不挡），窄于约一格的海峡当作闭合
//   2. 在经纬格上，每一行算出每个海上像素到东、西两边海岸的距离（东西方向首尾相接）
//   3. 流函数 ψ（Sverdrup 平衡）：风应力随纬度的变化决定每行环流的强度，从自转决定的那一侧海岸（地球是东岸）
//      开始积分；大洋西侧收成约 400 km 宽的边界流；很宽的大洋会饱和
//   4. 海流 = ψ 的旋转梯度 + 顺风偏转约 30° 的风吹流；没有陆地挡的纬度只有风吹流
//   5. 上涌：风把表层海水推离海岸时近岸变冷；赤道上大洋东部有冷水舌
//   6. 海面温度：按纬度的平衡温度（含上涌）顺着海流输送，约 1000–2000 km 内回到平衡

export interface OceanResult {
  // 全年平均的表层海流（东、南分量，约 0–4）
  cE: Float64Array;
  cS: Float64Array;
  // 洋流强弱为 1 时的海面温度偏离（°C）；陆地上为 0
  dSST1: Float64Array;
}

export interface OceanInputs {
  lat: Float64Array;
  // 按纬度的年均辐射平衡温度（不含海流）
  tAnn: Float64Array;
  // 全年平均的风（东、南分量）
  wE: Float64Array;
  wS: Float64Array;
  spacingKm: Float64Array;
}

const DEG = Math.PI / 180;
// 西边界流的宽度、大洋宽度的饱和尺度（km）
const DELTA = 400;
const LD = 8000;
// ψ 的梯度换成海流速度的系数
const KAPPA = 0.08;

const resultCache = new WeakMap<SphereMesh, { key: string; land: Uint8Array; result: OceanResult }>();
const pixelCache = new WeakMap<SphereMesh, { cols: number; rows: number; cells: Int32Array }>();

function pixels(mesh: SphereMesh): { cols: number; rows: number; cells: Int32Array } {
  let p = pixelCache.get(mesh);
  if (p) return p;
  const step = clamp(0.7 * mesh.spacing * 180, 0.25, 2);
  const cols = Math.round(360 / step);
  const rows = Math.round(180 / step);
  const cells = new Int32Array(cols * rows);
  let hint = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      hint = mesh.locate(((c + 0.5) / cols) * 2, (r + 0.5) / rows, hint);
      cells[r * cols + c] = hint;
    }
  }
  p = { cols, rows, cells };
  pixelCache.set(mesh, p);
  return p;
}

// 纬向风带（两个季节平均，不含季风）：与气候里的风同一个公式
function zonalBelt(latDeg: number, tilt: number, rotation: number): number {
  let sum = 0;
  for (const sigma of [1, -1]) {
    const d = latDeg - sigma * 0.35 * tilt;
    const ad = Math.min(90, Math.abs(d));
    const r = 90 - Math.abs(latDeg);
    sum += -Math.cos((Math.PI * ad) / 45) * rotation * (ad < 22.5 ? 0.8 : 1) * Math.min(1, r / 12) ** 2;
  }
  return sum / 2;
}

export function computeOcean(world: World, inp: OceanInputs): OceanResult {
  const mesh = world.mesh as SphereMesh;
  const { causes, small, kmPerUnit } = world;
  const land = causes.land;
  const planet = small.planet;
  const key = `${planet.tilt}|${planet.rotation}|${planet.solar}|${kmPerUnit}`;
  const hit = resultCache.get(mesh);
  if (hit && hit.key === key && hit.land.length === land.length && hit.land.every((v, i) => v === land[i])) return hit.result;

  const n = mesh.n;
  const R = kmPerUnit / Math.PI;
  const rot = planet.rotation;

  // 1. 挡海流的陆地：够大的陆块，再做一次闭运算（填掉一格宽的海峡）
  const steer = new Uint8Array(n);
  {
    const minKm2 = mesh.totalArea * kmPerUnit * kmPerUnit * 2.9e-4;
    const seen = new Uint8Array(n);
    for (let s = 0; s < n; s++) {
      if (!land[s] || seen[s]) continue;
      const q = [s];
      seen[s] = 1;
      let area = 0;
      for (let h = 0; h < q.length; h++) {
        const c = q[h];
        area += mesh.area[c] * kmPerUnit * kmPerUnit;
        for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
          const j = mesh.adj[e];
          if (land[j] && !seen[j]) {
            seen[j] = 1;
            q.push(j);
          }
        }
      }
      if (area >= minKm2) for (const c of q) steer[c] = 1;
    }
    const dil = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (steer[i]) dil[i] = 1;
      else for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (steer[mesh.adj[e]]) dil[i] = 1;
    }
    for (let i = 0; i < n; i++) {
      if (steer[i] || !dil[i]) continue;
      let all = true;
      for (let e = mesh.off[i]; e < mesh.off[i + 1] && all; e++) if (!dil[mesh.adj[e]]) all = false;
      if (all) steer[i] = 1;
    }
  }
  const ocean = new Uint8Array(n);
  for (let i = 0; i < n; i++) ocean[i] = land[i] ? 0 : 1;

  // 2. 经纬格上每行的海岸距离
  const { cols, rows, cells } = pixels(mesh);
  const dE = new Float64Array(cols * rows);
  const dW = new Float64Array(cols * rows);
  const open = new Uint8Array(rows);
  for (let r = 0; r < rows; r++) {
    const lat = 90 - ((r + 0.5) / rows) * 180;
    const pxKm = (360 / cols) * DEG * R * Math.max(Math.cos(lat * DEG), 1e-3);
    let any = false;
    for (let c = 0; c < cols; c++) if (steer[cells[r * cols + c]]) any = true;
    if (!any) {
      open[r] = 1;
      continue;
    }
    let d = Infinity;
    for (let t = 2 * cols - 1; t >= 0; t--) {
      const c = t % cols;
      d = steer[cells[r * cols + c]] ? 0 : d + pxKm;
      if (t < cols) dE[r * cols + c] = d;
    }
    d = Infinity;
    for (let t = 0; t < 2 * cols; t++) {
      const c = t % cols;
      d = steer[cells[r * cols + c]] ? 0 : d + pxKm;
      if (t >= cols) dW[r * cols + c] = d;
    }
  }

  // 3. 流函数（km）
  const psiPx = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    if (open[r]) continue;
    const lat = 90 - ((r + 0.5) / rows) * 180;
    const h = 0.125;
    const tp = (zonalBelt(lat + h, planet.tilt, rot) - zonalBelt(lat - h, planet.tilt, rot)) / (2 * h * DEG);
    const G = (tp / Math.max(Math.cos(lat * DEG), 0.2)) * (1 - smoothstep(65, 80, Math.abs(lat)));
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      if (steer[cells[k]]) continue;
      const S = (D: number) => LD * (1 - Math.exp(-D / LD));
      psiPx[k] = G * (rot > 0 ? S(dE[k]) * (1 - Math.exp(-dW[k] / DELTA)) : S(dW[k]) * (1 - Math.exp(-dE[k] / DELTA)));
    }
  }
  // 南北方向平滑约 1.5°
  {
    const k = Math.max(1, Math.round(0.75 / (180 / rows)));
    const tmp = new Float64Array(cols * rows);
    for (let c = 0; c < cols; c++) {
      for (let r = 0; r < rows; r++) {
        let s = 0;
        let m = 0;
        for (let d = -k; d <= k; d++) {
          const rr = r + d;
          if (rr < 0 || rr >= rows) continue;
          s += psiPx[rr * cols + c];
          m++;
        }
        tmp[r * cols + c] = s / m;
      }
    }
    psiPx.set(tmp);
  }
  // 插值回格上（挡流的陆地上为 0，海岸就是流线），再在海上平滑两遍
  const sample = (arr: Float64Array, x: number, y: number) => {
    const fx = (x / 2) * cols - 0.5;
    const fy = Math.min(rows - 1, Math.max(0, y * rows - 0.5));
    const c0 = Math.floor(fx);
    const r0 = Math.min(rows - 2, Math.floor(fy));
    const tx = fx - c0;
    const ty = fy - r0;
    const ca = ((c0 % cols) + cols) % cols;
    const cb = (ca + 1) % cols;
    const g = (r: number, c: number) => arr[r * cols + c];
    return (g(r0, ca) * (1 - tx) + g(r0, cb) * tx) * (1 - ty) + (g(r0 + 1, ca) * (1 - tx) + g(r0 + 1, cb) * tx) * ty;
  };
  const psi = new Float64Array(n);
  for (let i = 0; i < n; i++) psi[i] = steer[i] ? 0 : sample(psiPx, mesh.x[i], mesh.y[i]);
  for (let pass = 0; pass < 2; pass++) {
    const next = Float64Array.from(psi);
    for (let i = 0; i < n; i++) {
      if (steer[i]) continue;
      let s = psi[i];
      let m = 1;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        s += psi[mesh.adj[e]];
        m++;
      }
      next[i] = s / m;
    }
    psi.set(next);
  }

  // 没有陆地挡的纬度附近：只有风吹流（1.5° 内全是，4.5° 外没有）
  const openDist = new Float64Array(rows).fill(Infinity);
  for (let r = 0; r < rows; r++) {
    for (let r2 = 0; r2 < rows; r2++) if (open[r2]) openDist[r] = Math.min(openDist[r], (Math.abs(r - r2) * 180) / rows);
  }

  // 4. 海流
  const cE = new Float64Array(n);
  const cS = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!ocean[i]) continue;
    const lat = inp.lat[i];
    const r = Math.min(rows - 1, Math.max(0, Math.floor(mesh.y[i] * rows)));
    const wOpen = 1 - smoothstep(1.5, 4.5, openDist[r]);
    // ψ 的旋转梯度：向东 = −∂ψ/∂北 = ∂ψ/∂南，向北 = ∂ψ/∂东（梯度换成每 km）
    const [gE, gS] = gradient(mesh, psi, i);
    const pe = (gS / kmPerUnit) * KAPPA;
    const ps = (-gE / kmPerUnit) * KAPPA;
    // 风吹流：北半球偏到风向右侧（南半球左侧）约 30°，赤道附近不偏
    const h = Math.sign(lat) * rot;
    const th = h * 30 * DEG * Math.tanh(Math.abs(lat) / 6);
    const ct = Math.cos(th);
    const st = Math.sin(th);
    const k = 0.25 * (1 + 1.5 * wOpen);
    const de = k * (inp.wE[i] * ct - inp.wS[i] * st);
    const ds = k * (inp.wE[i] * st + inp.wS[i] * ct);
    cE[i] = (1 - wOpen) * pe + de;
    cS[i] = (1 - wOpen) * ps + ds;
  }

  // 5. 上涌
  const dUp = new Float64Array(n);
  {
    // 离挡流陆地的距离（km，300 km 以内）与指向海里的方向
    const coastSeeds: number[] = [];
    for (let i = 0; i < n; i++) if (steer[i]) coastSeeds.push(i);
    const dc = graphDistance(mesh, coastSeeds, 300 / kmPerUnit, (_a, b, e) => (steer[b] ? Infinity : mesh.dist[e]));
    const sm = new Float64Array(n);
    for (let i = 0; i < n; i++) sm[i] = steer[i];
    for (let pass = 0; pass < 2; pass++) {
      const next = Float64Array.from(sm);
      for (let i = 0; i < n; i++) {
        let s = sm[i];
        let m = 1;
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
          s += sm[mesh.adj[e]];
          m++;
        }
        next[i] = s / m;
      }
      sm.set(next);
    }
    for (let i = 0; i < n; i++) {
      if (!ocean[i]) continue;
      const lat = inp.lat[i];
      const h = Math.sign(lat) * rot;
      // 沿岸：风把表层水推离海岸（Ekman 输送在风向右侧 90°）
      const dKm = Number.isFinite(dc[i]) ? dc[i] * kmPerUnit : Infinity;
      if (dKm < 300) {
        const [gE, gS] = gradient(mesh, sm, i);
        const gl = Math.hypot(gE, gS);
        if (gl > 1e-9) {
          const nE = -gE / gl;
          const nS = -gS / gl;
          const mE = -h * inp.wS[i];
          const mS = h * inp.wE[i];
          const U = Math.max(0, mE * nE + mS * nS) * Math.exp(-dKm / 120) * smoothstep(3, 8, Math.abs(lat));
          dUp[i] -= 5 * U;
        }
      }
      // 赤道：信风把表层水推向大洋西部，东部冷水上涌
      if (Math.abs(lat) < 12) {
        const r = Math.min(rows - 1, Math.max(0, Math.floor(mesh.y[i] * rows)));
        let east = 0.5;
        if (!open[r]) {
          const e = sample(dE, mesh.x[i], mesh.y[i]);
          const w = sample(dW, mesh.x[i], mesh.y[i]);
          if (Number.isFinite(e + w) && e + w > 0) east = rot > 0 ? w / (e + w) : e / (e + w);
        }
        const U = Math.max(0, -rot * inp.wE[i]) * Math.exp(-((lat / 4) ** 2)) * east;
        dUp[i] -= 3 * U;
      }
    }
  }

  // 6. 海面温度：平衡温度顺着海流输送
  const teq = new Float64Array(n);
  for (let i = 0; i < n; i++) teq[i] = inp.tAnn[i] + dUp[i];
  const flowC = buildFlowSphere(mesh, cE, cS, { lag: 'all', mask: ocean });
  const sst = solveTransportSphere(
    mesh,
    flowC,
    PLANET_SWEEPS.ocean,
    (i, T) => {
      if (!ocean[i]) return teq[i];
      const lambda = 1500 * Math.sqrt(clamp(Math.hypot(cE[i], cS[i]) / 0.5, 0.5, 2));
      return T + (teq[i] - T) * (1 - Math.exp(-inp.spacingKm[i] / lambda));
    },
    (i) => teq[i],
    (i) => teq[i],
  );
  // 去掉每条纬度带的平均偏离：按纬度的平衡温度是按地球的实测拟合的，已经含有洋流的平均作用，
  // 这里只保留洋流造成的东西差别（西侧暖、东侧冷、冷水舌……）。全是海的星球因此没有偏离
  const BINS = 90;
  const sum = new Float64Array(BINS);
  const wsum = new Float64Array(BINS);
  const binOf = (lat: number) => Math.min(BINS - 1, Math.max(0, Math.floor(((lat + 90) / 180) * BINS)));
  for (let i = 0; i < n; i++) {
    if (!ocean[i]) continue;
    const b = binOf(inp.lat[i]);
    sum[b] += mesh.area[i] * (sst[i] - inp.tAnn[i]);
    wsum[b] += mesh.area[i];
  }
  const mean = new Float64Array(BINS);
  for (let b = 0; b < BINS; b++) mean[b] = wsum[b] > 0 ? sum[b] / wsum[b] : 0;
  // 在带中心之间线性插值，带的交界处不会跳
  const meanAt = (lat: number) => {
    const f = ((lat + 90) / 180) * BINS - 0.5;
    const b0 = Math.min(BINS - 2, Math.max(0, Math.floor(f)));
    const t = clamp(f - b0, 0, 1);
    return mean[b0] * (1 - t) + mean[b0 + 1] * t;
  };
  const dSST1 = new Float64Array(n);
  for (let i = 0; i < n; i++) dSST1[i] = ocean[i] ? clamp(sst[i] - inp.tAnn[i] - meanAt(inp.lat[i]), -10, 10) : 0;

  const result = { cE, cS, dSST1 };
  resultCache.set(mesh, { key, land: land.slice(), result });
  return result;
}
