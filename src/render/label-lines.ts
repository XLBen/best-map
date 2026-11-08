import type { FeatureType, GeoFeature } from '../../core/features';
import type { World } from '../../core/world';

// 海名、湖名沿着水写的那条线（第八十九轮）：按地物的格算一条弯的中线（地图坐标），叠加层排地名时投到屏幕上、字沿它排（见 label-place.ts）。
// 只随地物（同一个数组）与网格变：按世界的地物数组缓存，每帧不重算

// 沿着水弯着写的地物
export const CURVED_WATER: ReadonlySet<FeatureType> = new Set<FeatureType>(['ocean', 'sea', 'bay', 'strait', 'lake']);
// 地物的键 → 中线（地图坐标，5–7 个点；星球上按标注点展开经度，x 可能伸出 [0, 2)）
export type FeatureLines = ReadonlyMap<string, readonly [number, number][]>;

// 中线分几段
const BINS = 6;
// 少于这么多格的不算（小湖、小湾横着写）
const MIN_CELLS = 8;

const memo = new WeakMap<readonly GeoFeature[], { mesh: unknown; out: FeatureLines }>();
export function featureLinesOf(world: World): FeatureLines {
  const list = world.derived.features;
  const hit = memo.get(list);
  if (hit && hit.mesh === world.mesh) return hit.out;
  const out = new Map<string, [number, number][]>();
  for (const f of list) {
    if (!CURVED_WATER.has(f.type) || f.cells.length < MIN_CELLS) continue;
    const line = waterLine(world, f);
    if (line) out.set(f.key, line);
  }
  memo.set(list, { mesh: world.mesh, out });
  return out;
}

// 一片水的中线：标注点附近（半径约是这片水的“半径”的 0.75 倍、最多 30 格）的格按主轴分成 BINS 段，每段取格在法线方向上的中位数，
// 前后各平均一下。某一段里离中线上那一点最近的格也隔着 1.5 格以上（U 形的海、绕着岛的海峡：中位数落在陆上）时不要（横着写）
export function waterLine(world: World, f: GeoFeature): [number, number][] | null {
  const { mesh } = world;
  const sphere = mesh.kind === 'sphere';
  const sp = mesh.spacing;
  const ax = f.x;
  const ay = f.y;
  const R = Math.min(0.75 * Math.sqrt(f.cells.length) * sp, 30 * sp);
  const xs: number[] = [];
  const ys: number[] = [];
  for (let k = 0; k < f.cells.length; k++) {
    const c = f.cells[k];
    let x = mesh.x[c];
    if (sphere) x += 2 * Math.round((ax - x) / 2);
    const y = mesh.y[c];
    if ((x - ax) * (x - ax) + (y - ay) * (y - ay) > R * R) continue;
    xs.push(x);
    ys.push(y);
  }
  const n = xs.length;
  if (n < MIN_CELLS) return null;
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < n; k++) {
    cx += xs[k];
    cy += ys[k];
  }
  cx /= n;
  cy /= n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let k = 0; k < n; k++) {
    const dx = xs[k] - cx;
    const dy = ys[k] - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const a = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const t = new Float64Array(n);
  const v = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const dx = xs[k] - ax;
    const dy = ys[k] - ay;
    t[k] = dx * ux + dy * uy;
    v[k] = -dx * uy + dy * ux;
  }
  const sorted = Float64Array.from(t).sort();
  const t0 = sorted[Math.floor(0.05 * (n - 1))];
  const t1 = sorted[Math.ceil(0.95 * (n - 1))];
  if (!(t1 - t0 > 3 * sp)) return null;
  const w = (t1 - t0) / BINS;
  const bins: number[][] = Array.from({ length: BINS }, () => []);
  for (let k = 0; k < n; k++) {
    const b = Math.floor((t[k] - t0) / w);
    if (b >= 0 && b < BINS) bins[b].push(k);
  }
  const mid: number[] = [];
  for (let b = 0; b < BINS; b++) {
    const ks = bins[b];
    if (!ks.length) return null;
    const vs = ks.map((k) => v[k]).sort((p, q) => p - q);
    mid.push(vs[Math.floor((vs.length - 1) / 2)]);
  }
  // 中线上的点离这一段最近的格不远
  for (let b = 0; b < BINS; b++) {
    const tm = t0 + (b + 0.5) * w;
    let best = Infinity;
    for (const k of bins[b]) best = Math.min(best, (t[k] - tm) * (t[k] - tm) + (v[k] - mid[b]) * (v[k] - mid[b]));
    if (best > 2.25 * sp * sp) return null;
  }
  const out: [number, number][] = [];
  for (let b = 0; b < BINS; b++) {
    const vb = b === 0 ? (2 * mid[0] + mid[1]) / 3 : b === BINS - 1 ? (2 * mid[b] + mid[b - 1]) / 3 : (mid[b - 1] + 2 * mid[b] + mid[b + 1]) / 4;
    const tb = t0 + (b + 0.5) * w;
    out.push([ax + tb * ux - vb * uy, ay + tb * uy + vb * ux]);
  }
  return out;
}

// 河名沿着河写：河的折线（地物的 line，格心连成的）前后几个点平均两遍，拐来拐去的小弯抹平。按地物缓存
const riverMemo = new WeakMap<GeoFeature, [number, number][]>();
export function smoothRiver(f: GeoFeature): [number, number][] | null {
  const line = f.line;
  if (!line || line.length < 3) return null;
  let out = riverMemo.get(f);
  if (out) return out;
  // 星球上：折线从一端展开经度，挪到中点与标注点同一份（与 features.ts 的 f.x 相差 2 的整数倍）
  const dx = 2 * Math.round((f.x - line[Math.floor(line.length / 2)][0]) / 2);
  let pts: [number, number][] = line.map((p) => [p[0] + dx, p[1]]);
  for (let pass = 0; pass < 2; pass++) {
    const next: [number, number][] = [];
    for (let k = 0; k < pts.length; k++) {
      let x = 0;
      let y = 0;
      let c = 0;
      for (let j = Math.max(0, k - 3); j <= Math.min(pts.length - 1, k + 3); j++) {
        x += pts[j][0];
        y += pts[j][1];
        c++;
      }
      next.push(k === 0 || k === pts.length - 1 ? pts[k] : [x / c, y / c]);
    }
    pts = next;
  }
  out = pts;
  riverMemo.set(f, out);
  return out;
}
