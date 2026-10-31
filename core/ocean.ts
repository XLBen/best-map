import { type SphereMesh, gradGeo, gradientAt, graphDistanceAvoid } from './mesh';
import { clamp, smoothstep } from './rng';
import { PLANET_SWEEPS, buildFlowSphere } from './sphere-flow';
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
// 环流强度随大洋宽度增长，很宽时饱和
const widthSat = (D: number) => LD * (1 - Math.exp(-D / LD));

// 每个网格留两份：撤销一笔海陆修改时直接用上一份
const resultCache = new WeakMap<SphereMesh, { key: string; land: Uint8Array; result: OceanResult }[]>();
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
  const list = resultCache.get(mesh) ?? [];
  for (const c of list) if (c.key === key && sameLand(c.land, land)) return c.result;

  const n = mesh.n;
  const R = kmPerUnit / Math.PI;
  const rot = planet.rotation;

  // 第三十二轮（提速）：各段拆成小函数（小函数里的循环很快就被编译优化；整段写在一个大函数里时，
  // 一段段循环常常还没编译好就走完了），每段原样照搬，结果逐值相同
  // 1. 挡海流的陆地：够大的陆块，再做一次闭运算（填掉一格宽的海峡）
  const steer = steerMask(mesh, land, kmPerUnit);
  const ocean = new Uint8Array(n);
  seaMaskOf(n, land, ocean);

  // 2. 经纬格上每行的海岸距离
  const { cols, rows, cells } = pixels(mesh);
  const { dE, dW, open } = rowCoastDistances(cols, rows, cells, steer, R);

  // 3. 流函数（km）
  const psiPx = streamRaster(cols, rows, cells, steer, dE, dW, open, planet.tilt, rot);
  // 插值回格上（挡流的陆地上为 0，海岸就是流线），再在海上平滑两遍
  const psi = streamCells(mesh, steer, psiPx, cols, rows);

  // 没有陆地挡的纬度附近：只有风吹流（1.5° 内全是，4.5° 外没有）
  const openDist = new Float64Array(rows).fill(Infinity);
  for (let r = 0; r < rows; r++) {
    for (let r2 = 0; r2 < rows; r2++) if (open[r2]) openDist[r] = Math.min(openDist[r], (Math.abs(r - r2) * 180) / rows);
  }

  // 4. 海流
  const cE = new Float64Array(n);
  const cS = new Float64Array(n);
  oceanCurrents(mesh, inp, ocean, psi, openDist, rows, rot, kmPerUnit, cE, cS);

  // 5. 上涌
  const dUp = upwelling(mesh, inp, ocean, steer, dE, dW, open, cols, rows, rot, kmPerUnit);

  // 6. 海面温度：平衡温度顺着海流输送
  const teq = new Float64Array(n);
  addInto(n, inp.tAnn, dUp, teq);
  const flowC = buildFlowSphere(mesh, cE, cS, { lag: 'all', mask: ocean });
  // 稳态输运的专用写法：陆地格一直是 teq，不用扫；海上每格回到平衡的比例先算好，
  // 每遍按输运图的入流表（上游来源与权重）只做加权平均
  const fac = new Float64Array(n);
  relaxFactors(n, ocean, cE, cS, inp.spacingKm, fac);
  const sst = Float64Array.from(teq);
  sstSweeps(n, ocean, flowC, teq, fac, sst);
  // 去掉每条纬度带的平均偏离：按纬度的平衡温度是按地球的实测拟合的，已经含有洋流的平均作用，
  // 这里只保留洋流造成的东西差别（西侧暖、东侧冷、冷水舌……）。全是海的星球因此没有偏离
  const dSST1 = sstAnomaly(mesh, inp, ocean, sst);

  const result = { cE, cS, dSST1 };
  list.unshift({ key, land: land.slice(), result });
  resultCache.set(mesh, list.slice(0, 2));
  return result;
}

// 第三十五轮（提速）：computeOcean 里剩下的几段逐格循环放进小函数（原样照搬，结果逐值相同）
function seaMaskOf(n: number, land: Uint8Array, ocean: Uint8Array) {
  for (let i = 0; i < n; i++) ocean[i] = land[i] ? 0 : 1;
}

function addInto(n: number, a: Float64Array, b: Float64Array, out: Float64Array) {
  for (let i = 0; i < n; i++) out[i] = a[i] + b[i];
}

// 海上每格回到平衡的比例
function relaxFactors(n: number, ocean: Uint8Array, cE: Float64Array, cS: Float64Array, spacingKm: Float64Array, fac: Float64Array) {
  for (let i = 0; i < n; i++) {
    if (!ocean[i]) continue;
    const lambda = 1500 * Math.sqrt(clamp(Math.hypot(cE[i], cS[i]) / 0.5, 0.5, 2));
    fac[i] = 1 - Math.exp(-spacingKm[i] / lambda);
  }
}

// 逐格相同（与 every 逐格比相同）
function sameLand(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// 1. 挡海流的陆地：够大的陆块，再做一次闭运算（填掉一格宽的海峡）
function steerMask(mesh: SphereMesh, land: Uint8Array, kmPerUnit: number): Uint8Array {
  const n = mesh.n;
  const steer = new Uint8Array(n);
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
  return steer;
}

// 2. 经纬格上每行的海岸距离（东、西两边，km）；open：这一行没有挡流的陆地
function rowCoastDistances(cols: number, rows: number, cells: Int32Array, steer: Uint8Array, R: number): { dE: Float64Array; dW: Float64Array; open: Uint8Array } {
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
  return { dE, dW, open };
}

// 3. 流函数（km）的经纬格，南北方向平滑约 1.5°
function streamRaster(cols: number, rows: number, cells: Int32Array, steer: Uint8Array, dE: Float64Array, dW: Float64Array, open: Uint8Array, tilt: number, rot: number): Float64Array {
  const psiPx = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    if (open[r]) continue;
    const lat = 90 - ((r + 0.5) / rows) * 180;
    const h = 0.125;
    const tp = (zonalBelt(lat + h, tilt, rot) - zonalBelt(lat - h, tilt, rot)) / (2 * h * DEG);
    const G = (tp / Math.max(Math.cos(lat * DEG), 0.2)) * (1 - smoothstep(65, 80, Math.abs(lat)));
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      if (steer[cells[k]]) continue;
      psiPx[k] = G * (rot > 0 ? widthSat(dE[k]) * (1 - Math.exp(-dW[k] / DELTA)) : widthSat(dW[k]) * (1 - Math.exp(-dE[k] / DELTA)));
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
  return psiPx;
}

// 经纬格上双线性插值（东西首尾相接）
function sampleRaster(arr: Float64Array, cols: number, rows: number, x: number, y: number): number {
  const fx = (x / 2) * cols - 0.5;
  const fy = Math.min(rows - 1, Math.max(0, y * rows - 0.5));
  const c0 = Math.floor(fx);
  const r0 = Math.min(rows - 2, Math.floor(fy));
  const tx = fx - c0;
  const ty = fy - r0;
  const ca = ((c0 % cols) + cols) % cols;
  const cb = (ca + 1) % cols;
  const a = r0 * cols;
  const b = (r0 + 1) * cols;
  return (arr[a + ca] * (1 - tx) + arr[a + cb] * tx) * (1 - ty) + (arr[b + ca] * (1 - tx) + arr[b + cb] * tx) * ty;
}

// 流函数插值回格上（挡流的陆地上为 0，海岸就是流线），再在海上平滑两遍
function streamCells(mesh: SphereMesh, steer: Uint8Array, psiPx: Float64Array, cols: number, rows: number): Float64Array {
  const n = mesh.n;
  const psi = new Float64Array(n);
  for (let i = 0; i < n; i++) psi[i] = steer[i] ? 0 : sampleRaster(psiPx, cols, rows, mesh.x[i], mesh.y[i]);
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
  return psi;
}

// 4. 海流 = ψ 的旋转梯度 + 顺风偏转的风吹流（梯度用 gradientAt：与 gradient 逐值相同）
function oceanCurrents(mesh: SphereMesh, inp: OceanInputs, ocean: Uint8Array, psi: Float64Array, openDist: Float64Array, rows: number, rot: number, kmPerUnit: number, cE: Float64Array, cS: Float64Array) {
  const n = mesh.n;
  const geo = gradGeo(mesh);
  const g = new Float64Array(2);
  for (let i = 0; i < n; i++) {
    if (!ocean[i]) continue;
    const lat = inp.lat[i];
    const r = Math.min(rows - 1, Math.max(0, Math.floor(mesh.y[i] * rows)));
    const wOpen = 1 - smoothstep(1.5, 4.5, openDist[r]);
    // ψ 的旋转梯度：向东 = −∂ψ/∂北 = ∂ψ/∂南，向北 = ∂ψ/∂东（梯度换成每 km）
    gradientAt(mesh, geo, psi, i, g);
    const gE = g[0];
    const gS = g[1];
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
}

// 5. 上涌（海面温度的降低，°C，负数）
function upwelling(mesh: SphereMesh, inp: OceanInputs, ocean: Uint8Array, steer: Uint8Array, dE: Float64Array, dW: Float64Array, open: Uint8Array, cols: number, rows: number, rot: number, kmPerUnit: number): Float64Array {
  const n = mesh.n;
  const dUp = new Float64Array(n);
  // 离挡流陆地的距离（km，300 km 以内）与指向海里的方向
  const coastSeeds: number[] = [];
  for (let i = 0; i < n; i++) if (steer[i]) coastSeeds.push(i);
  // 第三十五轮（提速）：专门的函数，与传闭包 (_a, b, e) => (steer[b] ? Infinity : mesh.dist[e]) 逐值相同
  const dc = graphDistanceAvoid(mesh, coastSeeds, 300 / kmPerUnit, steer);
  const sm = smoothSteer(mesh, steer);
  upwellCells(mesh, gradGeo(mesh), inp, ocean, dc, sm, dE, dW, open, cols, rows, rot, kmPerUnit, dUp);
  return dUp;
}

// 第三十五轮（提速）：上涌的两段逐格的循环放进小函数（原样照搬，结果逐值相同）。
// 挡流的陆地（0 / 1）与邻格平均两遍（每格都写，所以每遍不必先复制一份）
function smoothSteer(mesh: SphereMesh, steer: Uint8Array): Float64Array {
  const n = mesh.n;
  const { off, adj } = mesh;
  const sm = new Float64Array(n);
  for (let i = 0; i < n; i++) sm[i] = steer[i];
  const next = new Float64Array(n);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      let s = sm[i];
      let m = 1;
      for (let e = off[i]; e < off[i + 1]; e++) {
        s += sm[adj[e]];
        m++;
      }
      next[i] = s / m;
    }
    sm.set(next);
  }
  return sm;
}

// 每个海格的上涌（写进 dUp）
function upwellCells(mesh: SphereMesh, geo: ReturnType<typeof gradGeo>, inp: OceanInputs, ocean: Uint8Array, dc: Float64Array, sm: Float64Array, dE: Float64Array, dW: Float64Array, open: Uint8Array, cols: number, rows: number, rot: number, kmPerUnit: number, dUp: Float64Array) {
  const n = mesh.n;
  const g = new Float64Array(2);
  for (let i = 0; i < n; i++) {
    if (!ocean[i]) continue;
    const lat = inp.lat[i];
    const h = Math.sign(lat) * rot;
    // 沿岸：风把表层水推离海岸（Ekman 输送在风向右侧 90°）
    const dKm = Number.isFinite(dc[i]) ? dc[i] * kmPerUnit : Infinity;
    if (dKm < 300) {
      gradientAt(mesh, geo, sm, i, g);
      const gE = g[0];
      const gS = g[1];
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
        const e = sampleRaster(dE, cols, rows, mesh.x[i], mesh.y[i]);
        const w = sampleRaster(dW, cols, rows, mesh.x[i], mesh.y[i]);
        if (Number.isFinite(e + w) && e + w > 0) east = rot > 0 ? w / (e + w) : e / (e + w);
      }
      const U = Math.max(0, -rot * inp.wE[i]) * Math.exp(-((lat / 4) ** 2)) * east;
      dUp[i] -= 3 * U;
    }
  }
}

// 6. 海面温度的稳态输运（写进 sst，初值是平衡温度）
function sstSweeps(n: number, ocean: Uint8Array, flowC: ReturnType<typeof buildFlowSphere>, teq: Float64Array, fac: Float64Array, sst: Float64Array) {
  const { order, koff, src, w: srcW, den } = flowC;
  for (let s = 0; s < PLANET_SWEEPS.ocean; s++) {
    for (let k = 0; k < n; k++) {
      const i = order[k];
      if (!ocean[i]) continue;
      let num = 0;
      for (let p = koff[k]; p < koff[k + 1]; p++) num += sst[src[p]] * srcW[p];
      const T = den[k] > 1e-9 ? num / den[k] : teq[i];
      sst[i] = T + (teq[i] - T) * fac[i];
    }
  }
}

// 去掉每条纬度带的平均偏离（在带中心之间线性插值，带的交界处不会跳），限在 ±10 °C
function sstAnomaly(mesh: SphereMesh, inp: OceanInputs, ocean: Uint8Array, sst: Float64Array): Float64Array {
  const n = mesh.n;
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
  return dSST1;
}
