import type { Mesh } from './mesh';
import { clamp } from './rng';

// 气候共用的几条式子（第四十六轮从 climate.ts 原样搬来，climate.ts 照旧导出）：扩散一轮、日照、辐射平衡温度

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
