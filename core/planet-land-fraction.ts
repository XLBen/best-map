// 星球上每格周围的陆地比例（第八十三轮从 core/planet-climate.ts 原样搬出）：经纬栅格上模糊再取回每格
import type { SphereMesh } from './mesh';

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
  for (const c of list) if (c.kmPerUnit === kmPerUnit && sameU8(c.land, land)) return c.result;
  const px = pixelCells(mesh);
  const grid = new Float64Array(ROWS * COLS);
  for (let k = 0; k < grid.length; k++) grid[k] = land[px[k]];
  const sigmaKm = 0.463 * 1500;
  // 一个像素在南北方向上的 km（地图高 1 = kmPerUnit，ROWS 个像素）
  const pxKm = kmPerUnit / ROWS;
  const tmp = new Float64Array(ROWS * COLS);
  // 东西方向：首尾相接，核宽随 cos 纬度变宽；宽到超过一圈时就是整行平均
  for (let r = 0; r < ROWS; r++) blurRow(grid, tmp, r, sigmaKm, pxKm);
  // 南北方向：两端截断（按实际参与的权重归一）
  const blurred = blurColumns(tmp, sigmaKm, pxKm);
  // 双线性插值回到格上
  const out = sampleGrid(mesh, blurred);
  list.unshift({ land: land.slice(), kmPerUnit, result: out });
  // 每个网格留两份（预览用的副本不会把正在用的挤掉）
  fracCache.set(mesh, list.slice(0, 2));
  return out;
}

// 第三十二轮（提速）：landFractionSphere、sphereLand 里的几段循环拆成小函数（很快就被编译优化），原样照搬，结果逐值相同。
// 第三十五轮（提速）：东西方向首尾相接的列号查表（以前每次取两次余数），南北方向的权重每个 d 先算一次（以前每个像素都重算 exp）；
// 加的先后、每一项的值都不变，结果逐值相同（rewrite-identity）
// 列号 t（−BLUR_PAD ≤ t < COLS + BLUR_PAD）首尾相接后的列：WRAP[t + BLUR_PAD]。核的半径不超过 ceil(3 × COLS / 2)
const BLUR_PAD = Math.ceil((3 * COLS) / 2);
const WRAP = Int32Array.from({ length: COLS + 2 * BLUR_PAD }, (_, k) => ((((k - BLUR_PAD) % COLS) + COLS) % COLS));

// 东西方向的一行
function blurRow(grid: Float64Array, tmp: Float64Array, r: number, sigmaKm: number, pxKm: number) {
  const cosLat = Math.sin(((r + 0.5) / ROWS) * Math.PI);
  const s = sigmaKm / (pxKm * Math.max(cosLat, 1e-3));
  if (s > COLS / 2) {
    let m = 0;
    for (let c = 0; c < COLS; c++) m += grid[r * COLS + c];
    m /= COLS;
    for (let c = 0; c < COLS; c++) tmp[r * COLS + c] = m;
    return;
  }
  const rad = Math.ceil(3 * s);
  const w = new Float64Array(2 * rad + 1);
  let wsum = 0;
  for (let d = -rad; d <= rad; d++) {
    const v = Math.exp(-(d * d) / (2 * s * s));
    w[d + rad] = v;
    wsum += v;
  }
  const row = r * COLS;
  for (let c = 0; c < COLS; c++) {
    let acc = 0;
    const base = c + BLUR_PAD;
    for (let d = -rad; d <= rad; d++) acc += w[d + rad] * grid[row + WRAP[base + d]];
    tmp[row + c] = acc / wsum;
  }
}

// 南北方向
function blurColumns(tmp: Float64Array, sigmaKm: number, pxKm: number): Float64Array {
  const s = sigmaKm / pxKm;
  const rad = Math.ceil(3 * s);
  const vs = new Float64Array(2 * rad + 1);
  for (let d = -rad; d <= rad; d++) vs[d + rad] = Math.exp(-(d * d) / (2 * s * s));
  const blurred = new Float64Array(ROWS * COLS);
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      let acc = 0;
      let wsum = 0;
      for (let d = -rad; d <= rad; d++) {
        const rr = r + d;
        if (rr < 0 || rr >= ROWS) continue;
        const v = vs[d + rad];
        acc += v * tmp[rr * COLS + c];
        wsum += v;
      }
      blurred[r * COLS + c] = acc / wsum;
    }
  }
  return blurred;
}

// 双线性插值回到格上
function sampleGrid(mesh: SphereMesh, blurred: Float64Array): Float64Array {
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
  return out;
}
export const sameU8 = (a: Uint8Array, b: Uint8Array) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
