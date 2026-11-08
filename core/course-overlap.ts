// 画的河的重叠分析（第八十三轮从 core/select.ts 原样搬出）
import { type Pt, type CoursePlan, isRiverCell } from './course-base';
import type { World, Derived } from './world';
import { pathSamples, courseStep, segProject } from './rivers';
import { wrapDelta } from './geo';
import { findCell } from './mesh';

// ---------- 重叠分析（第十三轮）：画出来的河会不会绕回自己旁边、贴着别的河流、终点挨着河，改道后旧河道还有没有水 ----------
// 只是提示（预览里黄色标出那一段，提示条、顶部的话里说一声）；只有“在终点消失、终点又回到自己旁边”这一种不让画（SINK_LOOP）

export const SINK_LOOP = '河会绕回自己旁边：画开一点，或汇入别的河';

export type OverlapKind = 'loop' | 'near-self' | 'alongside' | 'sink-self' | 'sink-river' | 'old-flowing';

export interface Overlap {
  kind: OverlapKind;
  // 标黄的那一段（地图单位，与画的线同一份）；old-flowing 没有（按 cells 标地图上的那几段河）
  points: Pt[];
  // old-flowing：旧河道里还有水的格；alongside、sink-river：贴着的那条河的一格
  cells: number[];
  // 贴着、挨着的是哪条画的河（自然的河为 null）
  guide: string | null;
}

// 别的河画出来的线（traceRivers 的结果；界面上传地图上现在的河）
export interface OverlapLine {
  points: readonly (readonly [number, number])[];
  cells?: readonly number[];
  guide?: string;
}

export interface OverlapOptions {
  lines?: readonly OverlapLine[];
  // 改的这条画的河自己（它现在的线不算别的河）
  self?: string | null;
  // 改的这条河自己的格（自然的河：线上这几格的那几段不算别的河）
  own?: readonly number[];
  // 改之前这条河的格（从源头往下）：改完不再是它的、还有支流的水的那段是 old-flowing
  old?: readonly number[];
}

const NEAR_SELF_GAP = 3;
const NEAR_SELF_DIST = 1;
const ALONG_DIST = 0.6;
const ALONG_LEN = 1.5;
const SINK_SELF_DIST = 1.2;
const SINK_RIVER_DIST = 1;

// 画的线上每隔四分之一格的点与从起点量起的长度
function samplesOf(world: World, path: readonly Pt[]): { x: number[]; y: number[]; seg: number[]; along: number[] } {
  const s = pathSamples(path, courseStep(world.mesh));
  const along = [0];
  for (let k = 1; k < s.x.length; k++) along.push(along[k - 1] + Math.hypot(s.x[k] - s.x[k - 1], s.y[k] - s.y[k - 1]));
  return { x: s.x, y: s.y, seg: s.seg, along };
}

// 在终点消失的河：终点离这条河自己 3 格以前的那段不到 1.2 格时，是离终点最近的那一个取样点的下标；否则 −1
export function sinkNearSelf(world: World, path: readonly Pt[]): number {
  if (path.length < 2) return -1;
  const sp = world.mesh.spacing;
  const sphere = world.mesh.kind === 'sphere';
  const S = samplesOf(world, path);
  const m = S.x.length - 1;
  const total = S.along[m];
  let best = -1;
  let bd = SINK_SELF_DIST * sp;
  for (let i = 0; i < m && S.along[i] < total - NEAR_SELF_GAP * sp; i++) {
    const dx = sphere ? wrapDelta(S.x[i] - S.x[m]) : S.x[i] - S.x[m];
    const dd = Math.hypot(dx, S.y[i] - S.y[m]);
    if (dd < bd) {
      bd = dd;
      best = i;
    }
  }
  return best;
}

// 按格距分桶的线段（找离一点近的线段用）
function segmentGrid(world: World, lines: readonly OverlapLine[], skip: (line: OverlapLine, k: number) => boolean) {
  const sp = world.mesh.spacing;
  const sphere = world.mesh.kind === 'sphere';
  const X = (x: number) => (sphere ? x - 2 * Math.floor(x / 2) : x);
  const cols = sphere ? Math.ceil(2 / sp) : Math.ceil(world.mesh.width / sp) + 1;
  const buckets = new Map<number, { l: number; k: number }[]>();
  const key = (i: number, j: number) => j * (cols + 2) + (sphere ? ((i % cols) + cols) % cols : i);
  lines.forEach((line, l) => {
    const P = line.points;
    for (let k = 0; k + 1 < P.length; k++) {
      if (skip(line, k)) continue;
      const ax = X(P[k][0]);
      const bx = ax + (P[k + 1][0] - P[k][0]);
      const i0 = Math.floor((Math.min(ax, bx) - ALONG_DIST * sp) / sp);
      const i1 = Math.floor((Math.max(ax, bx) + ALONG_DIST * sp) / sp);
      const j0 = Math.floor((Math.min(P[k][1], P[k + 1][1]) - ALONG_DIST * sp) / sp);
      const j1 = Math.floor((Math.max(P[k][1], P[k + 1][1]) + ALONG_DIST * sp) / sp);
      for (let i = i0; i <= i1; i++)
        for (let j = j0; j <= j1; j++) {
          const b = buckets.get(key(i, j));
          if (b) b.push({ l, k });
          else buckets.set(key(i, j), [{ l, k }]);
        }
    }
  });
  // 离 (x, y) 最近的线段：哪条线、第几段、多远
  return (x: number, y: number): { l: number; k: number; d: number } | null => {
    const px = X(x);
    const b = buckets.get(key(Math.floor(px / sp), Math.floor(y / sp)));
    if (!b) return null;
    let best: { l: number; k: number; d: number } | null = null;
    for (const { l, k } of b) {
      const P = lines[l].points;
      const ax = X(P[k][0]);
      const bx = ax + (P[k + 1][0] - P[k][0]);
      const shift = sphere ? 2 * Math.round((px - ax) / 2) : 0;
      const r = segProject(px - shift, y, ax, P[k][1], bx, P[k + 1][1]);
      if (!best || r.d < best.d) best = { l, k, d: r.d };
    }
    return best;
  };
}

const gridCache = new WeakMap<readonly OverlapLine[], Map<string, ReturnType<typeof segmentGrid>>>();

// 一笔河、改一条河的重叠分析（见上）。plan 是画好的结果（画不出来的不分析）
export function overlapsOf(world: World, d: Derived, plan: CoursePlan, opts: OverlapOptions = {}): Overlap[] {
  const out: Overlap[] = [];
  for (const pts of plan.loops) if (pts.length >= 2) out.push({ kind: 'loop', points: pts, cells: [], guide: null });
  if (plan.blocked || plan.path.length < 2) return out;
  const { mesh } = world;
  const sp = mesh.spacing;
  const sphere = mesh.kind === 'sphere';
  const S = samplesOf(world, plan.path);
  const m = S.x.length;
  const total = S.along[m - 1];
  const sink = plan.end === 'sink';
  // 新画的那一段在取样点里的范围
  const [pa, pb] = plan.changed ?? [0, plan.path.length - 1];
  let c0 = 0;
  while (c0 < m - 1 && S.seg[c0] < pa) c0++;
  let c1 = m - 1;
  while (c1 > c0 && S.seg[c1] >= pb) c1--;
  if (pb >= plan.path.length - 1) c1 = m - 1;
  const fresh = (j: number) => j >= c0 && j <= c1;
  // 按长度分组连着的点：flag[j] 相同（非 −1）的一串
  const runs = (flag: Int32Array, minLen: number): { from: number; to: number; v: number }[] => {
    const res: { from: number; to: number; v: number }[] = [];
    for (let j = 0; j < m; j++) {
      if (flag[j] < 0) continue;
      let e = j;
      while (e + 1 < m && flag[e + 1] === flag[j]) e++;
      if (S.along[e] - S.along[j] >= minLen) res.push({ from: j, to: e, v: flag[j] });
      j = e;
    }
    return res;
  };
  const pts = (a: number, b: number): Pt[] => {
    const r: Pt[] = [];
    for (let j = a; j <= b; j++) r.push([S.x[j], S.y[j]]);
    return r;
  };
  // 绕回自己旁边：离 3 格以前的那段不到 1 格
  const cols = new Map<number, number[]>();
  const X = (x: number) => (sphere ? x - 2 * Math.floor(x / 2) : x);
  const ncol = Math.ceil((sphere ? 2 : mesh.width) / sp) + 2;
  const bkey = (i: number, j: number) => j * (ncol + 2) + (sphere ? ((i % ncol) + ncol) % ncol : i);
  const near = new Int32Array(m).fill(-1);
  for (let j = 0; j < m; j++) {
    const gx = Math.floor(X(S.x[j]) / sp);
    const gy = Math.floor(S.y[j] / sp);
    for (let a = -1; a <= 1 && near[j] < 0; a++)
      for (let b = -1; b <= 1 && near[j] < 0; b++) {
        for (const i of cols.get(bkey(gx + a, gy + b)) ?? []) {
          if (S.along[j] - S.along[i] <= NEAR_SELF_GAP * sp || (!fresh(i) && !fresh(j))) continue;
          const dx = sphere ? wrapDelta(S.x[i] - S.x[j]) : S.x[i] - S.x[j];
          if (Math.hypot(dx, S.y[i] - S.y[j]) < NEAR_SELF_DIST * sp) {
            near[j] = 1;
            break;
          }
        }
      }
    const k = bkey(gx, gy);
    const list = cols.get(k);
    if (list) list.push(j);
    else cols.set(k, [j]);
  }
  const selfEnd = sink ? sinkNearSelf(world, plan.path) : -1;
  for (const r of runs(near, 0.25 * sp)) {
    // 在终点消失的河最后绕回来的那段算 sink-self（不让画），不再重复说
    if (selfEnd >= 0 && r.to === m - 1) continue;
    out.push({ kind: 'near-self', points: pts(r.from, r.to), cells: [], guide: null });
  }
  if (selfEnd >= 0) {
    let a = m - 1;
    while (a > 0 && S.along[m - 1] - S.along[a - 1] < 1.5 * sp) a--;
    out.push({ kind: 'sink-self', points: pts(a, m - 1), cells: [], guide: null });
  }
  // 贴着别的河流：连着 1.5 格以上离别的河的线不到 0.6 格。起笔、汇入处附近不算（从河上起笔、画到河上汇入本来就挨着）
  if (opts.lines?.length) {
    const lines = opts.lines;
    // 同一份线、同一条河反复分析（拖动时）只建一次
    const o = opts.own ?? [];
    const gk = `${opts.self ?? ''}|${o.length}:${o[0] ?? -1}:${o[o.length - 1] ?? -1}`;
    let gm = gridCache.get(lines);
    if (!gm) gridCache.set(lines, (gm = new Map()));
    let grid = gm.get(gk);
    if (!grid) {
      const own = new Set(o);
      grid = segmentGrid(world, lines, (line, k) => {
        if (opts.self && line.guide === opts.self) return true;
        const c = line.cells;
        return !!c && own.size > 0 && own.has(c[k]) && own.has(c[k + 1]);
      });
      if (gm.size > 8) gm.clear();
      gm.set(gk, grid);
    }
    const at = new Int32Array(m).fill(-1);
    const hitOf: ({ l: number; k: number } | null)[] = new Array(m).fill(null);
    const head = S.along[c0] + 1.0 * sp;
    const tail = plan.end === 'river' ? 1.5 * sp : 0;
    // 穿过别的河的那几格（截走它，另外说）不算贴着
    const crossed = new Set<number>();
    for (const x of plan.crossings) for (let k = x.from; k <= x.to; k++) crossed.add(plan.cells[k]);
    let hint = plan.cells[0] ?? 0;
    for (let j = c0; j <= c1; j++) {
      if (S.along[j] < head || S.along[j] > total - tail) continue;
      if (crossed.size) {
        hint = findCell(mesh, S.x[j], S.y[j], hint);
        if (crossed.has(hint)) continue;
      }
      const h = grid(S.x[j], S.y[j]);
      if (h && h.d < ALONG_DIST * sp) {
        at[j] = h.l;
        hitOf[j] = h;
      }
    }
    for (const r of runs(at, ALONG_LEN * sp)) {
      const line = lines[r.v];
      const h = hitOf[r.from]!;
      out.push({ kind: 'alongside', points: pts(r.from, r.to), cells: line.cells ? [line.cells[h.k]] : [], guide: line.guide ?? null });
    }
    if (sink && selfEnd < 0) {
      const h = grid(S.x[m - 1], S.y[m - 1]);
      if (h && h.d < SINK_RIVER_DIST * sp) {
        const line = lines[h.l];
        let a = m - 1;
        while (a > 0 && S.along[m - 1] - S.along[a - 1] < 0.75 * sp) a--;
        out.push({ kind: 'sink-river', points: pts(a, m - 1), cells: line.cells ? [line.cells[h.k]] : [], guide: line.guide ?? null });
      }
    }
  }
  // 改道后旧河道还有支流的水：会成为另一条河（看上去像一段牛轭）
  if (opts.old?.length) {
    const now = new Set(plan.cells);
    const thr = world.small.planet.riverThreshold;
    const old = opts.old;
    const first = old.findIndex((c) => !now.has(c) && world.causes.land[c] === 1 && d.lake[c] !== 1);
    if (first > 0) {
      const lost = d.discharge[old[first - 1]];
      const wet = old.slice(first).filter((c) => !now.has(c) && isRiverCell(world, d, c) && d.discharge[c] - lost >= thr);
      if (wet.length) out.push({ kind: 'old-flowing', points: [], cells: wet, guide: null });
    }
  }
  return out;
}
