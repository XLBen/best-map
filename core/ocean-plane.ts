import { type Mesh, findCell } from './mesh';
import { clamp, smoothstep } from './rng';
import { zonalBelt } from './ocean';
import { chamfer, rowDistances, smoothRows, smoothSea, steerPx } from './ocean-raster';

// 区域地图的洋流（第四十六轮）。与整个星球的 ocean.ts 同一个道理、同一组系数，只是在一张粗的经纬格（栅格）上算：
//   风推着海面转成大圈（北半球顺时针），回流挤在大洋西侧成为又窄又快的暖流，东侧又宽又慢的寒流；
//   风把表层海水推离海岸时近岸冷水上涌；海面温度顺着海流输送，约 1000–2000 km 内回到按纬度的平衡；
//   海温的偏离再随（偏转前的）背景风带上陆地（约 1200 km 内衰减；不按高度、不跟着山挡风拐），沿岸一圈另和邻格平均（海风）。
// 和星球不同的地方：
//   - 区域没有“绕星球一圈”：地图左右两边外面是海时（地图外面是海），当作外面还有 EXT_KM 宽的海；不是海时图边就是海岸
//   - 每条纬度带的平均偏离（按纬度的平衡温度已经含着它）按“这一行的海 + 图外假想的海”平均：地图只占大洋的一段时不至于把偏离全扣掉
//   - 全在栅格上算（像素约 3 格宽、长边最多 128 个像素），按像素上取到的输入（陆海、平衡温度、背景风、纬度）缓存：
//     只改高程、冷暖、干湿，或改海陆没改到像素中心时都不重算（第四十六轮续，见开发说明第46轮的“缓存”）
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
// 栅格：像素约 3 格宽，长边最多 128 个像素
export function planeGrid(mesh: Mesh): PlaneGrid {
  let g = gridCache.get(mesh);
  if (g) return g;
  const p = Math.max(3 * mesh.spacing, Math.max(mesh.width, mesh.height) / 128);
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
  // 两季平均的背景风（东、南分量，每格）；或者给两季的（夏东、夏南、冬东、冬南），按像素取平均（与先逐格平均相同）
  wE?: ArrayLike<number>;
  wS?: ArrayLike<number>;
  seasons?: Float32Array[];
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
  // 像素上两季的背景风（夏东、夏南、冬东、冬南；给了两季的风时才有）与按洋流强弱记下的带上陆地的两季偏离
  seasonPx: Float64Array[] | null;
  carry: Map<number, Float64Array[]>;
  // 离海 passes 个像素以内的陆地（海风）
  near: Uint8Array;
  passes: number;
}

// 只取决于像素的陆海（与图外是不是海、像素大小）的几样：挡流的陆地、到东西海岸的距离、到挡流陆地的距离与它平滑后的样子、
// 近海的陆地。按像素的陆海记两份：挪纬度、改轴倾角、日照时照用
interface LandParts {
  landPx: Uint8Array;
  key: string;
  steer: Uint8Array;
  dE: Float64Array;
  dW: Float64Array;
  dist: Float64Array;
  sm: Float64Array;
  near: Uint8Array;
  passes: number;
}
const landPartsCache = new WeakMap<PlaneGrid, LandParts[]>();
function landParts(grid: PlaneGrid, landPx: Uint8Array, minPx: number, ext: number, pwKm: number, phKm: number): LandParts {
  const key = `${minPx}|${ext}|${pwKm}|${phKm}`;
  const list = landPartsCache.get(grid) ?? [];
  if (planeOceanCache.on) for (const c of list) if (c.key === key && sameU8(c.landPx, landPx)) return c;
  const { cols, rows } = grid;
  const N = cols * rows;
  const steer = steerPx(landPx, cols, rows, minPx);
  const dE = new Float64Array(N);
  const dW = new Float64Array(N);
  rowDistances(steer, cols, rows, pwKm, ext, dE, dW);
  const dist = chamfer(steer, cols, rows, pwKm, phKm);
  // 挡流的陆地（0 / 1）与四邻平均两遍，梯度朝陆地，反过来就是朝海的方向
  const sm = new Float64Array(N);
  for (let k = 0; k < N; k++) sm[k] = steer[k];
  for (let pass = 0; pass < 2; pass++) smoothSea(sm, new Uint8Array(N), cols, rows);
  const passes = clamp(Math.round(150 / Math.sqrt(pwKm * phKm)), 1, 6);
  const near = new Uint8Array(N);
  const sea = new Uint8Array(N);
  for (let k = 0; k < N; k++) sea[k] = landPx[k] ? 0 : 1;
  const d1 = chamfer(sea, cols, rows, 1, 1);
  for (let k = 0; k < N; k++) near[k] = landPx[k] && d1[k] <= passes ? 1 : 0;
  const v: LandParts = { landPx: landPx.slice(), key, steer, dE, dW, dist, sm, near, passes };
  if (planeOceanCache.on) landPartsCache.set(grid, [v, ...list].slice(0, 2));
  return v;
}

// tAnnRef、wRef：传进来的那个数组（分层缓存开着时是同一个对象，先按它认，认不出再逐值比）
// 第四十六轮（续）：按栅格上取到的输入认（像素的陆海、平衡温度、风，各行的纬度）：改海陆没改到哪个像素中心时整份照用
const oceanCache = new WeakMap<Mesh, { key: string; lat: Float64Array; px: Float64Array[]; landPx: Uint8Array; result: PlaneOcean }[]>();
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
  const N = cols * rows;
  const key = `${inp.tilt}|${inp.rotation}|${inp.outsideOcean}|${inp.kmPerUnit}`;
  // 1. 每像素的陆地、平衡温度与风（两季的风另记下，带上陆地用）。先取进按栅格留着的一份草稿（命中时什么都不新开），
  // 没命中再复制出来
  const sc = scratchOf(grid, !!inp.seasons);
  for (let r = 0; r < rows; r++) sc.rowLat[r] = inp.latAt((r + 0.5) * ph);
  if (inp.seasons && sc.seasons) gatherSeasons(cells, inp.land, inp.tAnn, inp.seasons, sc.landPx, sc.px[0], sc.px[1], sc.px[2], sc.seasons);
  else gatherPx(cells, inp.land, inp.tAnn, inp.wE!, inp.wS!, sc.landPx, sc.px[0], sc.px[1], sc.px[2]);
  const list = oceanCache.get(mesh) ?? [];
  if (planeOceanCache.on) {
    for (let k = 0; k < list.length; k++) {
      const c = list[k];
      if (c.key === key && c.px.length === sc.all.length && sameU8(c.landPx, sc.landPx) && sameNum(c.lat, sc.rowLat) && c.px.every((a, j) => sameNum(a, sc.all[j]))) {
        list.splice(k, 1);
        list.unshift(c);
        return c.result;
      }
    }
  }
  const rowLat = sc.rowLat.slice();
  const landPx = sc.landPx.slice();
  const [tAnn, wE, wS] = sc.px.map((a) => a.slice());
  const seasonPx = sc.seasons ? sc.seasons.map((a) => a.slice()) : null;
  const px = [tAnn, wE, wS, ...(seasonPx ?? [])];
  const pwKm = grid.pw * inp.kmPerUnit;
  const phKm = ph * inp.kmPerUnit;
  const rot = inp.rotation;
  // 各段拆成小函数（小函数里的循环很快就被编译优化，见第三十二轮）
  // 挡海流的陆地（够大的陆块，再填掉一像素宽的海峡）
  const mapKm2 = mesh.width * mesh.height * inp.kmPerUnit * inp.kmPerUnit;
  const lp = landParts(grid, landPx, Math.min(1.5e5, 0.01 * mapKm2) / (pwKm * phKm), inp.outsideOcean ? EXT_KM : 0, pwKm, phKm);
  const { steer, dE, dW } = lp;
  // 2. 每行到东、西两边海岸的距离（km）
  // 3. 流函数（km）：Sverdrup 平衡，西侧收成边界流；南北方向平滑约 1.5°，再在海上平滑两遍
  const psi = streamPx(steer, rowLat, dE, dW, cols, rows, inp.tilt, rot);
  // 4. 海流 = ψ 的旋转梯度 + 顺风偏转约 30° 的风吹流
  const cE = new Float64Array(N);
  const cS = new Float64Array(N);
  currentsPx(psi, landPx, rowLat, wE, wS, cols, rows, pwKm, phKm, rot, cE, cS);
  // 5. 上涌（海面温度的降低，°C）
  const dUp = upwellPx(lp, landPx, rowLat, wE, wS, cols, rows, pwKm, phKm, rot);
  // 6. 海面温度：平衡温度顺着海流输送（半拉格朗日，每步约 150 km，正反交替扫约 3000 km）
  const teq = new Float64Array(N);
  for (let k = 0; k < N; k++) teq[k] = tAnn[k] + (landPx[k] ? 0 : dUp[k]);
  const sst = sstPx(teq, landPx, cE, cS, cols, rows, pwKm, phKm);
  // 7. 去掉每条纬度带的平均偏离（这一行的海 + 图外假想的偏离为 0 的海），限在 ±10 °C
  const dSST1 = bandAnomaly(sst, tAnn, landPx, cols, rows, inp.outsideOcean ? BAND_KM / pwKm : 0);
  // 回到格上在 seaOf 里（与带上陆地的一遍算）
  const result: PlaneOcean = { grid, landPx, steer, cE, cS, dSST1, seasonPx, carry: new Map(), near: lp.near, passes: lp.passes };
  if (planeOceanCache.on) {
    list.unshift({ key, lat: rowLat, px, landPx, result });
    oceanCache.set(mesh, list.slice(0, 2));
  }
  return result;
}

// 按栅格留一份取输入的草稿（各行纬度、像素的陆地、平衡温度、平均风，两季的风）
interface Scratch {
  rowLat: Float64Array;
  landPx: Uint8Array;
  px: Float64Array[];
  seasons: Float64Array[] | null;
  all: Float64Array[];
}
const scratchCache = new WeakMap<PlaneGrid, Scratch[]>();
function scratchOf(grid: PlaneGrid, seasons: boolean): Scratch {
  let pair = scratchCache.get(grid);
  if (!pair) scratchCache.set(grid, (pair = []));
  const k = seasons ? 1 : 0;
  let sc = pair[k];
  if (!sc) {
    const N = grid.cols * grid.rows;
    const f = () => new Float64Array(N);
    const px = [f(), f(), f()];
    const ss = seasons ? [f(), f(), f(), f()] : null;
    sc = pair[k] = { rowLat: new Float64Array(grid.rows), landPx: new Uint8Array(N), px, seasons: ss, all: [...px, ...(ss ?? [])] };
  }
  return sc;
}

function gatherSeasons(cells: Int32Array, land: Uint8Array, tA: Float64Array, w: Float32Array[], landPx: Uint8Array, tAnn: Float64Array, wE: Float64Array, wS: Float64Array, out: Float64Array[]) {
  const [sx, sy, wx, wy] = w;
  const [a, b, c2, d] = out;
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k];
    landPx[k] = land[c];
    tAnn[k] = tA[c];
    a[k] = sx[c];
    b[k] = sy[c];
    c2[k] = wx[c];
    d[k] = wy[c];
    wE[k] = (sx[c] + wx[c]) / 2;
    wS[k] = (sy[c] + wy[c]) / 2;
  }
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
  const iters = Math.min(40, Math.ceil(2500 / stepKm));
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


// 上涌：近岸（挡流的陆地 300 km 以内）风把表层海水推离海岸；赤道上信风把表层水推向大洋西部、东部冷水上涌
function upwellPx(lp: LandParts, landPx: Uint8Array, rowLat: Float64Array, wE: Float64Array, wS: Float64Array, cols: number, rows: number, pwKm: number, phKm: number, rot: number): Float64Array {
  const N = cols * rows;
  const dUp = new Float64Array(N);
  const { dist, sm, dE, dW } = lp;
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

// ---------- 带上陆地（随两季偏转前的风、洋流强弱变，与海上那部分一样只在改海陆时重算）----------
// 海上像素的偏离（洋流强弱 × dSST1，限在 ±14 °C）顺着这一季的背景风吹上陆地：每步约 150 km，按距离衰减（约 1200 km），
// 走约 2000 km；离海约 150 km 内的陆地再与四邻平均几遍（海风）。返回像素上的偏离（海上是海温的偏离）。
// 与星球不同：不按高度衰减、不跟着山挡风拐（这样改高程时不用重算；星球上山会挡住）
export function carryAnomaly(oc: PlaneOcean, strength: number, windX: Float64Array, windY: Float64Array, kmPerUnit: number): Float64Array {
  const { grid, landPx, dSST1 } = oc;
  const { cols, rows } = grid;
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
    const u = windX[k];
    const v = windY[k];
    const s = Math.hypot(u, v);
    if (s > 0.02) {
      ux[k] = (-(u / s) * stepKm) / pwKm;
      uy[k] = (-(v / s) * stepKm) / phKm;
    }
  }
  const zero = new Float64Array(N);
  const iters = Math.min(30, Math.ceil(1500 / stepKm));
  const st = stencil(landPx, 1, ux, uy, zero, cols, rows, true);
  for (let it = 0; it < iters; it++) carrySweep(A, st, decay, it % 2 === 1);
  // 海风：离海 passes 个像素以内的陆地与四邻平均
  const { near, passes } = oc;
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
  // 每格：海流（东、南）；两季的偏离 x（海格是海温的增减，两季相同；陆格是这一季带上来的偏离）。
  // 由它算（climate.ts）：温度的增减（陆上八成）、降水速率的倍数 clamp(1 + 0.06·x, 0.5, 1.25)、写进推导的偏离（陆上两季平均的八成）
  cellE: Float32Array;
  cellS: Float32Array;
  x: Float64Array[];
  // 两季海面的饱和水汽量（climate.ts 按日照那一份算好放这里；satFor 是算它时日照那一份的数组，没算过时是空的）。
  // 两项一开始就是数组、之后只换内容：字段的类型变了（null → 数组）会让读这个对象的、已经编译好的函数作废，
  // 下一次改海陆时回到格上的那一遍又要从头编译（量到 8–16 ms）
  sat: Float64Array[];
  satFor: Float64Array;
}

export interface PlaneSeaInputs extends PlaneOceanInputs {
  strength: number;
  // 两季偏转前的背景风（夏东、夏南、冬东、冬南，每格）
  seasons: Float32Array[];
}

// 每格的那一份按（海上那份、强弱、格的陆海）认，留 SEA_KEEP 份；挤掉的那份的数组拿来装新的（每次改海陆不再新开 10 个整图大小的数组）
const SEA_KEEP = 2;
const seaCache = new WeakMap<Mesh, { oc: PlaneOcean; strength: number; land: Uint8Array; value: PlaneSea }[]>();

// 这个进程里第一次算（新建、打开）时再空算几遍：几段循环先编译好，之后改海陆的每一笔不冷（结果扔掉，与缓存无关）
// 预热时也走一遍“拿挤掉的那份的数组来装”的路（两条路都先编译好），最后那一份留作下一次新开时用的数组（spare）
let warmed = false;
export const NO_SAT = new Float64Array(0);
let spare: PlaneSea | null = null;

export function planeSea(mesh: Mesh, inp: PlaneSeaInputs): PlaneSea {
  const oc = planeOcean(mesh, inp);
  const list = seaCache.get(mesh) ?? [];
  if (planeOceanCache.on) {
    for (let k = 0; k < list.length; k++) {
      const c = list[k];
      if (c.oc === oc && c.strength === inp.strength && sameU8(c.land, inp.land)) {
        list.splice(k, 1);
        list.unshift(c);
        return c.value;
      }
    }
  }
  let old = planeOceanCache.on && list.length >= SEA_KEEP ? list.pop()!.value : null;
  if (!old && planeOceanCache.on && spare && spare.x[0].length === mesh.n) {
    old = spare;
    spare = null;
  }
  const value = seaOf(mesh, inp, oc, old);
  if (planeOceanCache.on) {
    list.unshift({ oc, strength: inp.strength, land: inp.land.slice(), value });
    seaCache.set(mesh, list);
  }
  if (planeOceanCache.on && !warmed) {
    warmed = true;
    planeOceanCache.on = false;
    try {
      let w: PlaneSea | null = null;
      for (let k = 0; k < 3; k++) w = seaOf(mesh, inp, planeOcean(mesh, inp), w);
      spare = w;
    } finally {
      planeOceanCache.on = true;
    }
  }
  return value;
}

// 带上陆地的两季偏离（像素上）：按洋流强弱记在海上那份上
function carryOf(oc: PlaneOcean, strength: number, kmPerUnit: number): Float64Array[] {
  let A = planeOceanCache.on ? oc.carry.get(strength) : undefined;
  if (!A) {
    const w = oc.seasonPx!;
    A = [carryAnomaly(oc, strength, w[0], w[1], kmPerUnit), carryAnomaly(oc, strength, w[2], w[3], kmPerUnit)];
    if (planeOceanCache.on) {
      if (oc.carry.size >= 2) oc.carry.delete(oc.carry.keys().next().value as number);
      oc.carry.set(strength, A);
    }
  }
  return A;
}

// old：挤掉的那一份（它的数组拿来装这一份；每一项都重写）
function seaOf(mesh: Mesh, inp: PlaneSeaInputs, oc: PlaneOcean, old: PlaneSea | null): PlaneSea {
  const A = carryOf(oc, inp.strength, inp.kmPerUnit);
  const n = mesh.n;
  const f64 = (a?: Float64Array) => (a && a.length === n ? a : new Float64Array(n));
  const f32 = (a?: Float32Array) => (a && a.length === n ? a : new Float32Array(n));
  const value: PlaneSea = {
    cellE: f32(old?.cellE),
    cellS: f32(old?.cellS),
    x: [f64(old?.x[0]), f64(old?.x[1])],
    sat: old ? old.sat : [],
    satFor: NO_SAT,
  };
  seaOut(oc, inp.land, inp.strength, A[0], A[1], value);
  return value;
}

// 每格一遍（按网格记下的双线性的像素与比例）：
//   海格：海流与偏离只用四个像素里海上的那几个（重新归一，都是陆地时为 0），海温增减 = 强弱 × 偏离（限 ±14 °C）
//   陆格：两季带上来的偏离（四个像素都用）
function seaOut(oc: PlaneOcean, land: Uint8Array, strength: number, A0: Float64Array, A1: Float64Array, v: PlaneSea) {
  const { landPx, cE, cS, dSST1 } = oc;
  const { cols, k0: K, tx: TX, ty: TY } = oc.grid;
  const [x0s, x1s] = v.x;
  const { cellE, cellS } = v;
  for (let i = 0; i < land.length; i++) {
    const k = K[i];
    const tx = TX[i];
    const ty = TY[i];
    const w00 = (1 - tx) * (1 - ty);
    const w01 = tx * (1 - ty);
    const w10 = (1 - tx) * ty;
    const w11 = tx * ty;
    if (!land[i]) {
      let e = 0;
      let s = 0;
      let t = 0;
      let w = 0;
      if (!landPx[k] && w00 > 0) (e += cE[k] * w00), (s += cS[k] * w00), (t += dSST1[k] * w00), (w += w00);
      if (!landPx[k + 1] && w01 > 0) (e += cE[k + 1] * w01), (s += cS[k + 1] * w01), (t += dSST1[k + 1] * w01), (w += w01);
      if (!landPx[k + cols] && w10 > 0) (e += cE[k + cols] * w10), (s += cS[k + cols] * w10), (t += dSST1[k + cols] * w10), (w += w10);
      if (!landPx[k + cols + 1] && w11 > 0) (e += cE[k + cols + 1] * w11), (s += cS[k + cols + 1] * w11), (t += dSST1[k + cols + 1] * w11), (w += w11);
      const d = w > 1e-9 ? t / w : 0;
      cellE[i] = w > 1e-9 ? e / w : 0;
      cellS[i] = w > 1e-9 ? s / w : 0;
      const tt = clamp(strength * d, -14, 14);
      x0s[i] = x1s[i] = tt;
      continue;
    }
    cellE[i] = 0;
    cellS[i] = 0;
    x0s[i] = A0[k] * w00 + A0[k + 1] * w01 + A0[k + cols] * w10 + A0[k + cols + 1] * w11;
    x1s[i] = A1[k] * w00 + A1[k + 1] * w01 + A1[k + cols] * w10 + A1[k + cols + 1] * w11;
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
