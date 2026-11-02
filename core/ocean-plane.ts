import { type Mesh, findCell } from './mesh';
import { clamp, smoothstep } from './rng';
import { zonalBelt } from './ocean';

// 区域地图的洋流（第四十六轮）。与整个星球的 ocean.ts 同一个道理、同一组系数，只是在一张粗的经纬格（栅格）上算：
//   风推着海面转成大圈（北半球顺时针），回流挤在大洋西侧成为又窄又快的暖流，东侧又宽又慢的寒流；
//   风把表层海水推离海岸时近岸冷水上涌；海面温度顺着海流输送，约 1000–2000 km 内回到按纬度的平衡；
//   海温的偏离再随风带上陆地（约 1200 km 内衰减，山会挡住），沿岸一圈另和邻格平均（海风）。
// 和星球不同的地方：
//   - 区域没有“绕星球一圈”：地图左右两边外面是海时（地图外面是海），当作外面还有 EXT_KM 宽的海；不是海时图边就是海岸
//   - 每条纬度带的平均偏离（按纬度的平衡温度已经含着它）按“这一行的海 + 图外假想的海”平均：地图只占大洋的一段时不至于把偏离全扣掉
//   - 全在栅格上算（像素约 2.5 格宽、长边最多 160 个像素），只在海陆变了时重算海上那部分（按海陆缓存两份）；
//     带上陆地那部分随高程、风变，每次重算气候的地形部分时现算（几毫秒）
// 洋流强弱为 0 时不算（与没有这一步逐值相同）

const DEG = Math.PI / 180;
// 西边界流的宽度、大洋宽度的饱和尺度（km），ψ 的梯度换成海流的系数：与 ocean.ts 相同
const DELTA = 400;
const LD = 8000;
const KAPPA = 0.08;
// 地图外面是海时，图边外面当作还有多宽的海（km）
export const EXT_KM = 3000;
// 每条纬度带按多宽的海平均（图外是海时，这一行的海不到这么宽就用偏离为 0 的假想海补足）
const BAND_KM = 20000;
const widthSat = (D: number) => LD * (1 - Math.exp(-D / LD));

// ---------- 栅格 ----------
export interface PlaneGrid {
  cols: number;
  rows: number;
  // 一个像素的宽、高（地图单位）
  pw: number;
  ph: number;
  // 每个像素中心所在的格
  cells: Int32Array;
  // 每格双线性取值的左上角像素与两个方向的比例（只取决于网格）
  k0: Int32Array;
  tx: Float64Array;
  ty: Float64Array;
}

const gridCache = new WeakMap<Mesh, PlaneGrid>();
// 栅格：像素约 2.5 格宽，长边最多 160 个像素
export function planeGrid(mesh: Mesh): PlaneGrid {
  let g = gridCache.get(mesh);
  if (g) return g;
  const p = Math.max(2.5 * mesh.spacing, Math.max(mesh.width, mesh.height) / 160);
  const cols = Math.max(4, Math.round(mesh.width / p));
  const rows = Math.max(4, Math.round(mesh.height / p));
  const pw = mesh.width / cols;
  const ph = mesh.height / rows;
  const cells = new Int32Array(cols * rows);
  let hint = 0;
  for (let r = 0; r < rows; r++) {
    // 蛇形走：相邻的像素挨着，查格很快
    for (let k = 0; k < cols; k++) {
      const c = r % 2 ? cols - 1 - k : k;
      hint = findCell(mesh, (c + 0.5) * pw, (r + 0.5) * ph, hint);
      cells[r * cols + c] = hint;
    }
  }
  const n = mesh.n;
  const k0 = new Int32Array(n);
  const tx = new Float64Array(n);
  const ty = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const fx = clamp(mesh.x[i] / pw - 0.5, 0, cols - 1);
    const fy = clamp(mesh.y[i] / ph - 0.5, 0, rows - 1);
    const c0 = Math.min(cols - 2, Math.floor(fx));
    const r0 = Math.min(rows - 2, Math.floor(fy));
    k0[i] = r0 * cols + c0;
    tx[i] = fx - c0;
    ty[i] = fy - r0;
  }
  g = { cols, rows, pw, ph, cells, k0, tx, ty };
  gridCache.set(mesh, g);
  return g;
}

// ---------- 海上那部分（只取决于海陆、纬度、风带、比例尺、图外是不是海）----------
export interface PlaneOceanInputs {
  land: Uint8Array;
  // 每一行像素中心的纬度（按 y）
  latAt: (y: number) => number;
  // 每格的年均辐射平衡温度（不含海流）
  tAnn: Float64Array;
  // 两季平均的背景风（东、南分量，每格）
  wE: ArrayLike<number>;
  wS: ArrayLike<number>;
  tilt: number;
  rotation: number;
  outsideOcean: boolean;
  kmPerUnit: number;
}

export interface PlaneOcean {
  grid: PlaneGrid;
  // 像素：陆地（含小岛）、挡海流的陆地
  landPx: Uint8Array;
  steer: Uint8Array;
  // 像素：海流（东、南）、洋流强弱为 1 时海面温度的偏离（°C，陆地为 0）
  cE: Float64Array;
  cS: Float64Array;
  dSST1: Float64Array;
  // 每格（海格；陆地为 0）
  cellE: Float32Array;
  cellS: Float32Array;
  cellD: Float64Array;
}

// tAnnRef、wRef：传进来的那个数组（分层缓存开着时是同一个对象，先按它认，认不出再逐值比）
const oceanCache = new WeakMap<Mesh, { land: Uint8Array; key: string; lat: Float64Array; tAnnRef: ArrayLike<number>; wRef: ArrayLike<number>; tAnn: Float64Array; wE: Float64Array; wS: Float64Array; result: PlaneOcean }[]>();
// 测试用：false 时不读也不写缓存
export const planeOceanCache = { on: true };

const sameU8 = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
const sameNum = (a: Float64Array, b: ArrayLike<number>) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
};

export function planeOcean(mesh: Mesh, inp: PlaneOceanInputs): PlaneOcean {
  const grid = planeGrid(mesh);
  const { cols, rows, ph, cells } = grid;
  const rowLat = new Float64Array(rows);
  for (let r = 0; r < rows; r++) rowLat[r] = inp.latAt((r + 0.5) * ph);
  const key = `${inp.tilt}|${inp.rotation}|${inp.outsideOcean}|${inp.kmPerUnit}`;
  const list = oceanCache.get(mesh) ?? [];
  if (planeOceanCache.on) {
    for (const c of list) if (c.key === key && sameU8(c.land, inp.land) && sameNum(c.lat, rowLat) && (c.tAnnRef === inp.tAnn || sameNum(c.tAnn, inp.tAnn)) && (c.wRef === inp.wE || (sameNum(c.wE, inp.wE) && sameNum(c.wS, inp.wS)))) return c.result;
  }
  const N = cols * rows;
  const pwKm = grid.pw * inp.kmPerUnit;
  const phKm = ph * inp.kmPerUnit;
  const rot = inp.rotation;
  // 各段拆成小函数（小函数里的循环很快就被编译优化，见第三十二轮）
  // 1. 陆地、挡海流的陆地（够大的陆块，再填掉一像素宽的海峡）；每像素的平衡温度与风
  const landPx = new Uint8Array(N);
  const tAnn = new Float64Array(N);
  const wE = new Float64Array(N);
  const wS = new Float64Array(N);
  gatherPx(cells, inp.land, inp.tAnn, inp.wE, inp.wS, landPx, tAnn, wE, wS);
  const mapKm2 = mesh.width * mesh.height * inp.kmPerUnit * inp.kmPerUnit;
  const steer = steerPx(landPx, cols, rows, Math.min(1.5e5, 0.01 * mapKm2) / (pwKm * phKm));
  // 2. 每行到东、西两边海岸的距离（km）
  const dE = new Float64Array(N);
  const dW = new Float64Array(N);
  rowDistances(steer, cols, rows, pwKm, inp.outsideOcean ? EXT_KM : 0, dE, dW);
  // 3. 流函数（km）：Sverdrup 平衡，西侧收成边界流；南北方向平滑约 1.5°，再在海上平滑两遍
  const psi = streamPx(steer, rowLat, dE, dW, cols, rows, inp.tilt, rot);
  // 4. 海流 = ψ 的旋转梯度 + 顺风偏转约 30° 的风吹流
  const cE = new Float64Array(N);
  const cS = new Float64Array(N);
  currentsPx(psi, landPx, rowLat, wE, wS, cols, rows, pwKm, phKm, rot, cE, cS);
  // 5. 上涌（海面温度的降低，°C）
  const dUp = upwellPx(steer, landPx, rowLat, wE, wS, dE, dW, cols, rows, pwKm, phKm, rot);
  // 6. 海面温度：平衡温度顺着海流输送（半拉格朗日，每步约 150 km，正反交替扫约 3000 km）
  const teq = new Float64Array(N);
  for (let k = 0; k < N; k++) teq[k] = tAnn[k] + (landPx[k] ? 0 : dUp[k]);
  const sst = sstPx(teq, landPx, cE, cS, cols, rows, pwKm, phKm);
  // 7. 去掉每条纬度带的平均偏离（这一行的海 + 图外假想的偏离为 0 的海），限在 ±10 °C
  const dSST1 = bandAnomaly(sst, tAnn, landPx, cols, rows, inp.outsideOcean ? BAND_KM / pwKm : 0);
  // 每格（海格）：按像素中心双线性取，只用海上的像素
  const n = mesh.n;
  const cellE = new Float32Array(n);
  const cellS = new Float32Array(n);
  const cellD = new Float64Array(n);
  seaCells(grid, landPx, cE, cS, dSST1, inp.land, cellE, cellS, cellD);
  const result: PlaneOcean = { grid, landPx, steer, cE, cS, dSST1, cellE, cellS, cellD };
  if (planeOceanCache.on) {
    list.unshift({ land: inp.land.slice(), key, lat: rowLat, tAnnRef: inp.tAnn, wRef: inp.wE, tAnn: inp.tAnn.slice(), wE: Float64Array.from(inp.wE), wS: Float64Array.from(inp.wS), result });
    oceanCache.set(mesh, list.slice(0, 2));
  }
  return result;
}

function gatherPx(cells: Int32Array, land: Uint8Array, tA: Float64Array, e: ArrayLike<number>, sN: ArrayLike<number>, landPx: Uint8Array, tAnn: Float64Array, wE: Float64Array, wS: Float64Array) {
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k];
    landPx[k] = land[c];
    tAnn[k] = tA[c];
    wE[k] = e[c];
    wS[k] = sN[c];
  }
}

// 每行到东、西两边海岸的距离（km）；图边：图外是海时外面还有 ext km 的海，否则图边就是海岸
function rowDistances(steer: Uint8Array, cols: number, rows: number, pwKm: number, ext: number, dE: Float64Array, dW: Float64Array) {
  for (let r = 0; r < rows; r++) {
    let d = ext;
    for (let c = cols - 1; c >= 0; c--) {
      const k = r * cols + c;
      d = steer[k] ? 0 : d + pwKm;
      dE[k] = d;
    }
    d = ext;
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      d = steer[k] ? 0 : d + pwKm;
      dW[k] = d;
    }
  }
}

function streamPx(steer: Uint8Array, rowLat: Float64Array, dE: Float64Array, dW: Float64Array, cols: number, rows: number, tilt: number, rot: number): Float64Array {
  const N = cols * rows;
  const psi = new Float64Array(N);
  for (let r = 0; r < rows; r++) {
    const lat = rowLat[r];
    const h = 0.125;
    const tp = (zonalBelt(lat + h, tilt, rot) - zonalBelt(lat - h, tilt, rot)) / (2 * h * DEG);
    const G = (tp / Math.max(Math.cos(lat * DEG), 0.2)) * (1 - smoothstep(65, 80, Math.abs(lat)));
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      if (steer[k]) continue;
      psi[k] = G * (rot > 0 ? widthSat(dE[k]) * (1 - Math.exp(-dW[k] / DELTA)) : widthSat(dW[k]) * (1 - Math.exp(-dE[k] / DELTA)));
    }
  }
  const degPerRow = rows > 1 ? Math.abs(rowLat[1] - rowLat[0]) : 1;
  smoothRows(psi, cols, rows, Math.max(1, Math.round(0.75 / Math.max(degPerRow, 1e-6))));
  for (let k = 0; k < N; k++) if (steer[k]) psi[k] = 0;
  for (let pass = 0; pass < 2; pass++) smoothSea(psi, steer, cols, rows);
  return psi;
}

function currentsPx(psi: Float64Array, landPx: Uint8Array, rowLat: Float64Array, wE: Float64Array, wS: Float64Array, cols: number, rows: number, pwKm: number, phKm: number, rot: number, cE: Float64Array, cS: Float64Array) {
  for (let r = 0; r < rows; r++) {
    const lat = rowLat[r];
    const hs = Math.sign(lat) * rot;
    const th = hs * 30 * DEG * Math.tanh(Math.abs(lat) / 6);
    const ct = Math.cos(th);
    const st = Math.sin(th);
    const r0 = Math.max(0, r - 1);
    const r1 = Math.min(rows - 1, r + 1);
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      if (landPx[k]) continue;
      const c0 = Math.max(0, c - 1);
      const c1 = Math.min(cols - 1, c + 1);
      const gx = (psi[r * cols + c1] - psi[r * cols + c0]) / ((c1 - c0) * pwKm);
      const gy = (psi[r1 * cols + c] - psi[r0 * cols + c]) / ((r1 - r0) * phKm);
      const e = gy * KAPPA + 0.25 * (wE[k] * ct - wS[k] * st);
      const s = -gx * KAPPA + 0.25 * (wE[k] * st + wS[k] * ct);
      // 东西走向的海岸旁 ψ 在一个像素里从 0 跳到大洋里的值：限在星球上的范围（约 4）以内
      const m = Math.hypot(e, s);
      const f = m > 4 ? 4 / m : 1;
      cE[k] = e * f;
      cS[k] = s * f;
    }
  }
}

function sstPx(teq: Float64Array, landPx: Uint8Array, cE: Float64Array, cS: Float64Array, cols: number, rows: number, pwKm: number, phKm: number): Float64Array {
  const N = cols * rows;
  const pxKm = Math.sqrt(pwKm * phKm);
  const sst = Float64Array.from(teq);
  const stepKm = Math.max(1, 150 / pxKm) * pxKm;
  const fac = new Float64Array(N);
  const ux = new Float64Array(N);
  const uy = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    if (landPx[k]) continue;
    const s = Math.hypot(cE[k], cS[k]);
    const lambda = 1500 * Math.sqrt(clamp(s / 0.5, 0.5, 2));
    fac[k] = 1 - Math.exp(-stepKm / lambda);
    if (s > 0.02) {
      // 上游一步（像素）：东西按像素宽换算
      ux[k] = (-(cE[k] / s) * stepKm) / pwKm;
      uy[k] = (-(cS[k] / s) * stepKm) / phKm;
    }
  }
  const iters = Math.min(40, Math.ceil(3000 / stepKm));
  const st = stencil(landPx, 0, ux, uy, teq, cols, rows);
  for (let it = 0; it < iters; it++) advectSweep(sst, st, fac, it % 2 === 1);
  return sst;
}

// 一遍：海上像素取上游一步处的值，再往平衡温度回 fac
// 半拉格朗日的一步每遍都取同一处（上游一步）：先把要更新的像素排成一列，记下取值处的左上角像素与比例
// （与 sample 同一个算式：k0 = −1 原地不动，−2 出了图、取 out），每遍只做加权平均
interface Stencil {
  cols: number;
  list: Int32Array;
  k0: Int32Array;
  tx: Float64Array;
  ty: Float64Array;
  out: Float64Array;
  teq: Float64Array;
}
// want：要更新的是陆地（1）还是海（0）的像素；outside：出了图取哪里的值（按最近的像素）
function stencil(landPx: Uint8Array, want: number, ux: Float64Array, uy: Float64Array, outside: Float64Array, cols: number, rows: number, skipStill = false): Stencil {
  const N = cols * rows;
  let m = 0;
  const list = new Int32Array(N);
  for (let k = 0; k < N; k++) if (landPx[k] === want && !(skipStill && ux[k] === 0 && uy[k] === 0)) list[m++] = k;
  const st: Stencil = { cols, list: list.slice(0, m), k0: new Int32Array(m), tx: new Float64Array(m), ty: new Float64Array(m), out: new Float64Array(m), teq: outside };
  for (let j = 0; j < m; j++) {
    const k = st.list[j];
    if (ux[k] === 0 && uy[k] === 0) {
      st.k0[j] = -1;
      continue;
    }
    const c = k % cols;
    const r = (k - c) / cols;
    const fx = c + ux[k];
    const fy = r + uy[k];
    if (fx < 0 || fy < 0 || fx > cols - 1 || fy > rows - 1) {
      st.k0[j] = -2;
      st.out[j] = outside[Math.min(rows - 1, Math.max(0, Math.round(fy))) * cols + Math.min(cols - 1, Math.max(0, Math.round(fx)))];
      continue;
    }
    const c0 = Math.min(cols - 2, Math.floor(fx));
    const r0 = Math.min(rows - 2, Math.floor(fy));
    st.k0[j] = r0 * cols + c0;
    st.tx[j] = fx - c0;
    st.ty[j] = fy - r0;
  }
  return st;
}

function advectSweep(sst: Float64Array, st: Stencil, fac: Float64Array, back: boolean) {
  const { list, k0, tx, ty, out, cols } = st;
  const m = list.length;
  for (let q = 0; q < m; q++) {
    const j = back ? m - 1 - q : q;
    const k = list[j];
    const a = k0[j];
    // 原地不动（流得太慢）、出了图、正常的双线性：与 sample 同一个算式
    const up = a === -1 ? sst[k] : a === -2 ? out[j] : (sst[a] * (1 - tx[j]) + sst[a + 1] * tx[j]) * (1 - ty[j]) + (sst[a + cols] * (1 - tx[j]) + sst[a + cols + 1] * tx[j]) * ty[j];
    sst[k] = up + (st.teq[k] - up) * fac[k];
  }
}

// 每行的平均偏离（加上 virtual 个偏离为 0 的假想海像素）去掉，限在 ±10 °C
function bandAnomaly(sst: Float64Array, tAnn: Float64Array, landPx: Uint8Array, cols: number, rows: number, band: number): Float64Array {
  const dSST1 = new Float64Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    let sum = 0;
    let m = 0;
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      if (landPx[k]) continue;
      sum += sst[k] - tAnn[k];
      m++;
    }
    const virtual = Math.max(0, band - m);
    const mean = m + virtual > 0 ? sum / (m + virtual) : 0;
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      if (!landPx[k]) dSST1[k] = clamp(sst[k] - tAnn[k] - mean, -10, 10);
    }
  }
  return dSST1;
}

// 每个海格的海流、偏离：四个像素里只用海上的，按双线性的权重重新归一；四个都是陆地时为 0
function seaCells(g: PlaneGrid, landPx: Uint8Array, cE: Float64Array, cS: Float64Array, d: Float64Array, land: Uint8Array, outE: Float32Array, outS: Float32Array, outD: Float64Array) {
  const { cols, k0: K, tx: TX, ty: TY } = g;
  for (let i = 0; i < land.length; i++) {
    if (land[i]) continue;
    const k0 = K[i];
    const tx = TX[i];
    const ty = TY[i];
    let e = 0;
    let s = 0;
    let t = 0;
    let w = 0;
    for (let j = 0; j < 4; j++) {
      const k = k0 + (j & 1) + (j >> 1) * cols;
      const wk = (j & 1 ? tx : 1 - tx) * (j >> 1 ? ty : 1 - ty);
      if (landPx[k] || wk <= 0) continue;
      e += cE[k] * wk;
      s += cS[k] * wk;
      t += d[k] * wk;
      w += wk;
    }
    if (w > 1e-9) {
      outE[i] = e / w;
      outS[i] = s / w;
      outD[i] = t / w;
    }
  }
}

// 挡海流的陆地：面积够大（像素数 ≥ minPx）的陆块，再填掉一像素宽的海峡（四周的像素都挨着陆地的海像素）
function steerPx(landPx: Uint8Array, cols: number, rows: number, minPx: number): Uint8Array {
  const N = cols * rows;
  const steer = new Uint8Array(N);
  const seen = new Uint8Array(N);
  const q = new Int32Array(N);
  for (let s = 0; s < N; s++) {
    if (!landPx[s] || seen[s]) continue;
    let len = 0;
    q[len++] = s;
    seen[s] = 1;
    for (let h = 0; h < len; h++) {
      const k = q[h];
      const c = k % cols;
      const r = (k - c) / cols;
      for (let t = 0; t < 4; t++) {
        const j = t === 0 ? (c > 0 ? k - 1 : -1) : t === 1 ? (c < cols - 1 ? k + 1 : -1) : t === 2 ? (r > 0 ? k - cols : -1) : r < rows - 1 ? k + cols : -1;
        if (j >= 0 && landPx[j] && !seen[j]) {
          seen[j] = 1;
          q[len++] = j;
        }
      }
    }
    if (len >= minPx) for (let h = 0; h < len; h++) steer[q[h]] = 1;
  }
  const dil = new Uint8Array(N);
  for (let k = 0; k < N; k++) {
    const c = k % cols;
    const r = (k - c) / cols;
    dil[k] = steer[k] || (c > 0 && steer[k - 1]) || (c < cols - 1 && steer[k + 1]) || (r > 0 && steer[k - cols]) || (r < rows - 1 && steer[k + cols]) ? 1 : 0;
  }
  const out = steer.slice();
  for (let k = 0; k < N; k++) {
    if (steer[k] || !dil[k]) continue;
    const c = k % cols;
    const r = (k - c) / cols;
    if ((c === 0 || dil[k - 1]) && (c === cols - 1 || dil[k + 1]) && (r === 0 || dil[k - cols]) && (r === rows - 1 || dil[k + cols])) out[k] = 1;
  }
  return out;
}

// 南北方向 ±k 行平均
function smoothRows(a: Float64Array, cols: number, rows: number, k: number) {
  const tmp = new Float64Array(a.length);
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      let s = 0;
      let m = 0;
      for (let d = -k; d <= k; d++) {
        const rr = r + d;
        if (rr < 0 || rr >= rows) continue;
        s += a[rr * cols + c];
        m++;
      }
      tmp[r * cols + c] = s / m;
    }
  }
  a.set(tmp);
}

// 海上与四邻平均一遍（挡流的陆地不动，作为 0 参与平均）
function smoothSea(a: Float64Array, steer: Uint8Array, cols: number, rows: number) {
  const next = Float64Array.from(a);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      if (steer[k]) continue;
      let s = a[k];
      let m = 1;
      if (c > 0) (s += a[k - 1]), m++;
      if (c < cols - 1) (s += a[k + 1]), m++;
      if (r > 0) (s += a[k - cols]), m++;
      if (r < rows - 1) (s += a[k + cols]), m++;
      next[k] = s / m;
    }
  }
  a.set(next);
}


// 上涌：近岸（挡流的陆地 300 km 以内）风把表层海水推离海岸；赤道上信风把表层水推向大洋西部、东部冷水上涌
function upwellPx(steer: Uint8Array, landPx: Uint8Array, rowLat: Float64Array, wE: Float64Array, wS: Float64Array, dE: Float64Array, dW: Float64Array, cols: number, rows: number, pwKm: number, phKm: number, rot: number): Float64Array {
  const N = cols * rows;
  const dUp = new Float64Array(N);
  const dist = chamfer(steer, cols, rows, pwKm, phKm);
  // 挡流的陆地（0 / 1）与四邻平均两遍，梯度朝陆地，反过来就是朝海的方向
  const sm = new Float64Array(N);
  for (let k = 0; k < N; k++) sm[k] = steer[k];
  for (let pass = 0; pass < 2; pass++) smoothSea(sm, new Uint8Array(N), cols, rows);
  for (let r = 0; r < rows; r++) {
    const lat = rowLat[r];
    const h = Math.sign(lat) * rot;
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      if (landPx[k]) continue;
      const dKm = dist[k];
      if (dKm < 300) {
        const gx = (sm[r * cols + Math.min(cols - 1, c + 1)] - sm[r * cols + Math.max(0, c - 1)]) / ((Math.min(cols - 1, c + 1) - Math.max(0, c - 1)) * pwKm);
        const gy = (sm[Math.min(rows - 1, r + 1) * cols + c] - sm[Math.max(0, r - 1) * cols + c]) / ((Math.min(rows - 1, r + 1) - Math.max(0, r - 1)) * phKm);
        const gl = Math.hypot(gx, gy);
        if (gl > 1e-12) {
          const nE = -gx / gl;
          const nS = -gy / gl;
          const mE = -h * wS[k];
          const mS = h * wE[k];
          const U = Math.max(0, mE * nE + mS * nS) * Math.exp(-dKm / 120) * smoothstep(3, 8, Math.abs(lat));
          dUp[k] -= 5 * U;
        }
      }
      if (Math.abs(lat) < 12) {
        const e = dE[k];
        const w = dW[k];
        const east = e + w > 0 ? (rot > 0 ? w / (e + w) : e / (e + w)) : 0.5;
        const U = Math.max(0, -rot * wE[k]) * Math.exp(-((lat / 4) ** 2)) * east;
        dUp[k] -= 3 * U;
      }
    }
  }
  return dUp;
}

// 到挡流陆地的距离（km，两遍的倒角距离：横、竖、斜各按像素的宽高算）
function chamfer(seed: Uint8Array, cols: number, rows: number, pwKm: number, phKm: number): Float64Array {
  const N = cols * rows;
  const d = new Float64Array(N);
  for (let k = 0; k < N; k++) d[k] = seed[k] ? 0 : Infinity;
  const dg = Math.hypot(pwKm, phKm);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = r * cols + c;
      let v = d[k];
      if (c > 0) v = Math.min(v, d[k - 1] + pwKm);
      if (r > 0) {
        v = Math.min(v, d[k - cols] + phKm);
        if (c > 0) v = Math.min(v, d[k - cols - 1] + dg);
        if (c < cols - 1) v = Math.min(v, d[k - cols + 1] + dg);
      }
      d[k] = v;
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const k = r * cols + c;
      let v = d[k];
      if (c < cols - 1) v = Math.min(v, d[k + 1] + pwKm);
      if (r < rows - 1) {
        v = Math.min(v, d[k + cols] + phKm);
        if (c < cols - 1) v = Math.min(v, d[k + cols + 1] + dg);
        if (c > 0) v = Math.min(v, d[k + cols - 1] + dg);
      }
      d[k] = v;
    }
  }
  return d;
}

// ---------- 带上陆地（随两季偏转前的风、洋流强弱变，与海上那部分一样只在改海陆时重算）----------
// 海上像素的偏离（洋流强弱 × dSST1，限在 ±14 °C）顺着这一季的背景风吹上陆地：每步约 150 km，按距离衰减（约 1200 km），
// 走约 2000 km；离海约 150 km 内的陆地再与四邻平均几遍（海风）。返回像素上的偏离（海上是海温的偏离）。
// 与星球不同：不按高度衰减、不跟着山挡风拐（这样改高程时不用重算；星球上山会挡住）
export function carryAnomaly(oc: PlaneOcean, strength: number, windX: ArrayLike<number>, windY: ArrayLike<number>, kmPerUnit: number): Float64Array {
  const { grid, landPx, dSST1 } = oc;
  const { cols, rows, cells } = grid;
  const N = cols * rows;
  const pwKm = grid.pw * kmPerUnit;
  const phKm = grid.ph * kmPerUnit;
  const pxKm = Math.sqrt(pwKm * phKm);
  const A = new Float64Array(N);
  for (let k = 0; k < N; k++) if (!landPx[k]) A[k] = clamp(strength * dSST1[k], -14, 14);
  const stepPx = Math.max(1, 150 / pxKm);
  const stepKm = stepPx * pxKm;
  const ux = new Float64Array(N);
  const uy = new Float64Array(N);
  const decay = Math.exp(-stepKm / 1200);
  for (let k = 0; k < N; k++) {
    if (!landPx[k]) continue;
    const c = cells[k];
    const u = windX[c];
    const v = windY[c];
    const s = Math.hypot(u, v);
    if (s > 0.02) {
      ux[k] = (-(u / s) * stepKm) / pwKm;
      uy[k] = (-(v / s) * stepKm) / phKm;
    }
  }
  const zero = new Float64Array(N);
  const iters = Math.min(30, Math.ceil(2000 / stepKm));
  const st = stencil(landPx, 1, ux, uy, zero, cols, rows, true);
  for (let it = 0; it < iters; it++) carrySweep(A, st, decay, it % 2 === 1);
  // 海风：离海 passes 个像素以内的陆地与四邻平均
  const passes = clamp(Math.round(150 / pxKm), 1, 6);
  const near = new Uint8Array(N);
  {
    const dist = chamfer(Uint8Array.from(landPx, (v) => (v ? 0 : 1)), cols, rows, 1, 1);
    for (let k = 0; k < N; k++) near[k] = landPx[k] && dist[k] <= passes ? 1 : 0;
  }
  for (let pass = 0; pass < passes; pass++) {
    const next = Float64Array.from(A);
    for (let k = 0; k < N; k++) {
      if (!near[k]) continue;
      const c = k % cols;
      const r = (k - c) / cols;
      let s = 0;
      let m = 0;
      if (c > 0) (s += A[k - 1]), m++;
      if (c < cols - 1) (s += A[k + 1]), m++;
      if (r > 0) (s += A[k - cols]), m++;
      if (r < rows - 1) (s += A[k + cols]), m++;
      next[k] = 0.5 * A[k] + (0.5 * s) / Math.max(1, m);
    }
    A.set(next);
  }
  return A;
}

// ---------- 气候用的一份（climate.ts 的 computeClimate 调）----------
export interface PlaneSea {
  // 每格：海流（东、南）、海面温度的增减（海格，°C）、两季带上陆地的偏离（陆格）
  cellE: Float32Array;
  cellS: Float32Array;
  sst: Float64Array;
  anomaly: Float64Array[];
  // 两季降水速率的倍数：冷水海岸空气稳定（多雾少雨），暖流上空对流更强（与星球相同的系数）
  cur: Float64Array[];
  // 两季温度的增减（海上是海温的增减，陆上是带上来的偏离的八成）、写进推导的海温偏离（陆上是两季平均的八成）
  add: Float64Array[];
  sstAnom: Float32Array;
}

export interface PlaneSeaInputs extends PlaneOceanInputs {
  strength: number;
  // 两季偏转前的背景风（东、南分量，每格）
  winds: [ArrayLike<number>, ArrayLike<number>][];
}

// 按（海上那份、强弱）缓存两份：海上那份按海陆、纬度、背景风认出来，两季的背景风也只取决于这些
const seaCache = new WeakMap<PlaneOcean, { strength: number; value: PlaneSea }[]>();

export function planeSea(mesh: Mesh, inp: PlaneSeaInputs): PlaneSea {
  const oc = planeOcean(mesh, inp);
  const list = seaCache.get(oc) ?? [];
  if (planeOceanCache.on) {
    const hit = list.find((c) => c.strength === inp.strength);
    if (hit) return hit.value;
  }
  const A = inp.winds.map(([wx, wy]) => carryAnomaly(oc, inp.strength, wx, wy, inp.kmPerUnit));
  const n = mesh.n;
  const two = () => [new Float64Array(n), new Float64Array(n)];
  const value: PlaneSea = { cellE: oc.cellE, cellS: oc.cellS, sst: new Float64Array(n), anomaly: two(), cur: two(), add: two(), sstAnom: new Float32Array(n) };
  seaOut(oc.grid, inp.land, inp.strength, oc.cellD, A[0], A[1], value);
  if (planeOceanCache.on) seaCache.set(oc, [{ strength: inp.strength, value }, ...list].slice(0, 2));
  return value;
}

// 每格一遍：海格的海温增减；陆格两季带上来的偏离（像素上双线性）；两季降水的倍数
function seaOut(g: PlaneGrid, land: Uint8Array, strength: number, cellD: Float64Array, A0: Float64Array, A1: Float64Array, v: PlaneSea) {
  const { cols, k0: K, tx: TX, ty: TY } = g;
  const [a0, a1] = v.anomaly;
  const [c0, c1] = v.cur;
  const [d0, d1] = v.add;
  const sst = v.sst;
  const sa = v.sstAnom;
  for (let i = 0; i < land.length; i++) {
    if (!land[i]) {
      const t = clamp(strength * cellD[i], -14, 14);
      sst[i] = t;
      c0[i] = c1[i] = clamp(1 + 0.06 * t, 0.5, 1.25);
      d0[i] = d1[i] = t;
      sa[i] = t;
      continue;
    }
    const k = K[i];
    const tx = TX[i];
    const ty = TY[i];
    const w00 = (1 - tx) * (1 - ty);
    const w01 = tx * (1 - ty);
    const w10 = (1 - tx) * ty;
    const w11 = tx * ty;
    const x0 = A0[k] * w00 + A0[k + 1] * w01 + A0[k + cols] * w10 + A0[k + cols + 1] * w11;
    const x1 = A1[k] * w00 + A1[k + 1] * w01 + A1[k + cols] * w10 + A1[k + cols + 1] * w11;
    a0[i] = x0;
    a1[i] = x1;
    c0[i] = clamp(1 + 0.06 * x0, 0.5, 1.25);
    c1[i] = clamp(1 + 0.06 * x1, 0.5, 1.25);
    d0[i] = 0.8 * x0;
    d1[i] = 0.8 * x1;
    sa[i] = (0.8 * (x0 + x1)) / 2;
  }
}

// 一遍：陆上像素取上风一步处的值，按距离衰减（出了图是 0）
function carrySweep(A: Float64Array, st: Stencil, decay: number, back: boolean) {
  const { list, k0, tx, ty, out, cols } = st;
  const m = list.length;
  for (let q = 0; q < m; q++) {
    const j = back ? m - 1 - q : q;
    const a = k0[j];
    const v = a === -2 ? out[j] : (A[a] * (1 - tx[j]) + A[a + 1] * tx[j]) * (1 - ty[j]) + (A[a + cols] * (1 - tx[j]) + A[a + cols + 1] * tx[j]) * ty[j];
    A[list[j]] = v * decay;
  }
}
