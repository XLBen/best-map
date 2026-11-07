import { M_RANGE, type Rect, T_RANGE } from '../../../core/species';
import { isVegetated } from '../../../core/vegetation';
import type { World } from '../../../core/world';

// 生态编辑器上面的气候图（第七十二轮从 ClimateChart.tsx 搬来，算法不变）：横轴年均温、纵轴“干 ←→ 湿”（湿润程度，对数）。
// 每种生态是一个色块（最适合的冷暖干湿），底图是世界上所有陆地格的分布

export const W = 340;
export const H = 250;
export const PAD = { l: 30, r: 8, t: 8, b: 28 };
const T_MIN = T_RANGE[0];
const T_MAX = T_RANGE[1];
const M_MIN = 0.03;
const M_MAX = 8;
const LM0 = Math.log(M_MIN);
const LM1 = Math.log(M_MAX);
export const PW = W - PAD.l - PAD.r;
export const PH = H - PAD.t - PAD.b;

export const xOf = (t: number) => PAD.l + ((Math.max(T_MIN, Math.min(T_MAX, t)) - T_MIN) / (T_MAX - T_MIN)) * PW;
const tOf = (px: number) => T_MIN + ((px - PAD.l) / PW) * (T_MAX - T_MIN);
export const yOf = (m: number) => PAD.t + (1 - (Math.log(Math.max(M_MIN, Math.min(M_MAX, m))) - LM0) / (LM1 - LM0)) * PH;
const mOf = (py: number) => Math.exp(LM0 + (1 - (py - PAD.t) / PH) * (LM1 - LM0));

export type Px = { x0: number; x1: number; y0: number; y1: number };

// 色块在图上的像素范围；碰到图边表示“不限”
export function rectPx(r: Rect): Px {
  return {
    x0: r.t0 <= T_RANGE[0] ? xOf(T_MIN) : xOf(r.t0),
    x1: r.t1 >= T_RANGE[1] ? xOf(T_MAX) : xOf(r.t1),
    y0: r.m1 >= M_RANGE[1] ? yOf(M_MAX) : yOf(r.m1),
    y1: r.m0 <= M_RANGE[0] ? yOf(M_MIN) : yOf(r.m0),
  };
}

const SNAP = 5;
export function rectFromPx(x0: number, x1: number, y0: number, y1: number): Rect {
  const round = (v: number, k: number) => Math.round(v * k) / k;
  const t0 = x0 <= PAD.l + SNAP ? T_RANGE[0] : round(tOf(x0), 2);
  const t1 = x1 >= W - PAD.r - SNAP ? T_RANGE[1] : round(tOf(x1), 2);
  const m1 = y0 <= PAD.t + SNAP ? M_RANGE[1] : round(mOf(y0), 100);
  const m0 = y1 >= H - PAD.b - SNAP ? M_RANGE[0] : round(mOf(y1), 100);
  return { t0: Math.min(t0, t1 - 0.5), t1, m0: Math.min(m0, m1 * 0.95), m1 };
}

// 拖动：按下时的范围加上挪了多少（move 整块挪，resize 只挪按着的边），不出图
export type DragMode = { mode: 'move' | 'resize'; edges: { l: boolean; r: boolean; t: boolean; b: boolean } };
export function dragPx(px: Px, d: DragMode, dx: number, dy: number): Px {
  let { x0, x1, y0, y1 } = px;
  if (d.mode === 'move') {
    const sx = Math.max(PAD.l - x0, Math.min(W - PAD.r - x1, dx));
    const sy = Math.max(PAD.t - y0, Math.min(H - PAD.b - y1, dy));
    return { x0: x0 + sx, x1: x1 + sx, y0: y0 + sy, y1: y1 + sy };
  }
  if (d.edges.l) x0 = Math.max(PAD.l, Math.min(x1 - 4, x0 + dx));
  if (d.edges.r) x1 = Math.min(W - PAD.r, Math.max(x0 + 4, x1 + dx));
  if (d.edges.t) y0 = Math.max(PAD.t, Math.min(y1 - 4, y0 + dy));
  if (d.edges.b) y1 = Math.min(H - PAD.b, Math.max(y0 + 4, y1 + dy));
  return { x0, x1, y0, y1 };
}

// 按下的地方离哪条边近：近边就是拉伸，否则整块挪
export function dragModeAt(px: Px, x: number, y: number): DragMode {
  const near = (a: number, b: number) => Math.abs(a - b) < 6;
  const edges = { l: near(x, px.x0), r: near(x, px.x1), t: near(y, px.y0), b: near(y, px.y1) };
  return { mode: edges.l || edges.r || edges.t || edges.b ? 'resize' : 'move', edges };
}

export const fmtT = (t: number, edge: number) => (t === edge ? '不限' : `${Math.round(t)} °C`);
export const fmtM = (m: number, edge: number) => (m === edge ? '不限' : m.toFixed(2));
// 占比：有但不到 1% 时写“<1%”，不写成看起来像没长出来的 0%
export const fmtShare = (share: number) => (share > 0 && share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`);

export const T_TICKS = [-30, -20, -10, 0, 10, 20, 30];
export const M_TICKS: [number, string][] = [
  [0.1, '0.1'],
  [0.3, '0.3'],
  [1, '1'],
  [3, '3'],
];

// 第七十九轮：两份缓存按用到的数组认（以前按世界对象：每份快照都是新的世界，拖一下色块、改一项都要把所有的格再过一遍）。
// 主线程的推导数组没变时是同一个对象（Worker 只发变了的，见 state/worker-host.ts 的 completeSnapshot）
const sameRefs = (a: readonly unknown[], b: readonly unknown[]) => a.every((v, k) => v === b[k]);

// 世界上陆地格在图上的分布（底图）：每个像素的 RGBA，按 年均温、湿润、陆地、湖 四个数组缓存。画的时候包成 ImageData
const densityCache = new WeakMap<object, { deps: unknown[]; img: Uint8ClampedArray<ArrayBuffer> }>();
export function densityPixels(w: World): Uint8ClampedArray<ArrayBuffer> {
  const deps = [w.derived.moisture, w.causes.land, w.derived.lake];
  const hit = densityCache.get(w.derived.tMean);
  if (hit && sameRefs(hit.deps, deps)) return hit.img;
  const counts = new Float32Array(W * H);
  let max = 0;
  const d = w.derived;
  for (let i = 0; i < w.mesh.n; i++) {
    if (!isVegetated(w, d, i)) continue;
    const px = Math.round(xOf(d.tMean[i]));
    const py = Math.round(yOf(d.moisture[i]));
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const k = (py + dy) * W + px + dx;
        if (k < 0 || k >= counts.length) continue;
        counts[k] += dx === 0 && dy === 0 ? 1 : 0.4;
        max = Math.max(max, counts[k]);
      }
    }
  }
  const img = new Uint8ClampedArray(W * H * 4);
  for (let k = 0; k < counts.length; k++) {
    if (!counts[k]) continue;
    img[k * 4] = 230;
    img[k * 4 + 1] = 230;
    img[k * 4 + 2] = 230;
    img[k * 4 + 3] = Math.round(200 * Math.sqrt(counts[k] / max));
  }
  densityCache.set(w.derived.tMean, { deps, img });
  return img;
}

// 每种生态占陆地的多少（按 small.species 的下标）：按 生态、陆地、湖 三个数组缓存
const shareCache = new WeakMap<object, { deps: unknown[]; m: Map<number, number> }>();
export function biomeShares(w: World): Map<number, number> {
  const deps = [w.causes.land, w.derived.lake];
  const hit = shareCache.get(w.derived.dominant);
  if (hit && sameRefs(hit.deps, deps)) return hit.m;
  const m = new Map<number, number>();
  let total = 0;
  for (let i = 0; i < w.mesh.n; i++) {
    if (!isVegetated(w, w.derived, i)) continue;
    total++;
    const s = w.derived.dominant[i];
    if (s >= 0) m.set(s, (m.get(s) ?? 0) + 1);
  }
  for (const [k, v] of m) m.set(k, v / Math.max(1, total));
  shareCache.set(w.derived.dominant, { deps, m });
  return m;
}
