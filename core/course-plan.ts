// 画的河照着画的线走（第八十三轮从 core/select.ts 原样搬出）：描线、截断、成环、汇合、穿过别的河
import { type Mesh, findCell } from './mesh';
import { type Pt, type CourseOptions, type CoursePlan, emptyPlan, isRiverCell, upstreamOf, type CourseEnd, pathToTarget, type CourseCrossing } from './course-base';
import { type World, COURSE_MAX_POINTS, type Derived, type Guide } from './world';
import { douglasPeucker, dedupePoints as dedupe, roundPoint as roundPt, pathSamples, courseStep, ownsCell, segProject } from './rivers';
import { sinkNearSelf, SINK_LOOP } from './course-overlap';
import { wrapDelta } from './geo';
import { sinkMask, bedLevels, userLakeMask, waterLevel } from './elevation';

function adjacent(mesh: Mesh, a: number, b: number): boolean {
  for (let e = mesh.off[a]; e < mesh.off[a + 1]; e++) if (mesh.adj[e] === b) return true;
  return false;
}

// 两格之间的距离平方（比远近用）：整个星球按球面上的弦长
function cellDist2(mesh: Mesh, a: number, b: number): number {
  if (mesh.kind === 'sphere') return (mesh.p[3 * a] - mesh.p[3 * b]) ** 2 + (mesh.p[3 * a + 1] - mesh.p[3 * b + 1]) ** 2 + (mesh.p[3 * a + 2] - mesh.p[3 * b + 2]) ** 2;
  return (mesh.x[a] - mesh.x[b]) ** 2 + (mesh.y[a] - mesh.y[b]) ** 2;
}

// 磨圆拐角（Chaikin，保留两端）：去掉鼠标的锯齿
function chaikinPts(pts: readonly Pt[], iterations: number): Pt[] {
  let out = pts.slice();
  for (let it = 0; it < iterations && out.length >= 3; it++) {
    const p: Pt[] = [out[0]];
    for (let k = 0; k + 1 < out.length; k++) {
      const [ax, ay] = out[k];
      const [bx, by] = out[k + 1];
      p.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
    }
    p.push(out[out.length - 1]);
    out = p;
  }
  return out;
}

// 画的线 → 存下的折线：磨圆两遍，再化简（容差取 0.03 格与一个屏幕像素中大的那个；点太多时放宽，最多 1500 个点），
// 坐标取整到存的精度。max：最多留几个点（重画一段时要给前后不动的两段留出位置）
export function simplifyStroke(world: World, stroke: readonly (readonly [number, number])[], px = 0, max = COURSE_MAX_POINTS): [number, number][] {
  const smooth = chaikinPts(stroke.map((p) => [p[0], p[1]] as Pt), 2);
  let tol = Math.max(0.03 * world.mesh.spacing, px);
  let out = douglasPeucker(smooth, tol);
  // 留一点余地：截掉绕回的圈时会多出一两个点
  const limit = Math.max(2, max - 20);
  while (out.length > limit) {
    tol *= 1.5;
    out = douglasPeucker(smooth, tol);
  }
  return dedupe(out.map(roundPt));
}

// 折线经过的格。prefix：前面已经定下的格（重画一段时不动的那段），折线从它的最后一格里开始。
// 停下的情形：进了海或湖（stop 是落进去的第一个取样点）、出了平面地图（stop 是出去前的最后一个取样点）、
// 回到了走过的格（loop：第 j 个取样点回到了第 k 格）
export interface Trace {
  cells: number[];
  x: number[];
  y: number[];
  seg: number[];
  // 每个取样点落在 cells 的第几格
  at: number[];
  stop: number;
  exit: boolean;
  loop: { j: number; k: number } | null;
}

export function traceCourse(world: World, pts: readonly Pt[], prefix: readonly number[], water: (i: number) => boolean): Trace {
  const { mesh } = world;
  const s = pathSamples(pts, courseStep(mesh));
  const cells = prefix.slice();
  const pos = new Map<number, number>();
  cells.forEach((c, k) => pos.set(c, k));
  const out: Trace = { cells, x: s.x, y: s.y, seg: s.seg, at: [], stop: -1, exit: false, loop: null };
  const plane = mesh.kind === 'plane';
  let hint = cells.length ? cells[cells.length - 1] : 0;
  for (let j = 0; j < s.x.length; j++) {
    const x = s.x[j];
    const y = s.y[j];
    if (plane && (x < 0 || y < 0 || x > mesh.width || y > mesh.height)) {
      out.stop = j - 1;
      out.exit = true;
      return out;
    }
    const c = findCell(mesh, x, y, hint);
    hint = c;
    const last = cells.length ? cells[cells.length - 1] : -1;
    if (c === last) {
      out.at.push(cells.length - 1);
      continue;
    }
    // 跳过了格（擦过一个角）：补上两边都挨着的格，优先陆地、离两边近的；没有就贪心地走过去
    const add: number[] = [];
    if (last >= 0 && !adjacent(mesh, last, c)) {
      let best = -1;
      let bd = Infinity;
      for (let e = mesh.off[last]; e < mesh.off[last + 1]; e++) {
        const b = mesh.adj[e];
        if (!adjacent(mesh, b, c)) continue;
        const dd = cellDist2(mesh, b, last) + cellDist2(mesh, b, c) + (water(b) ? 1e6 : 0);
        if (dd < bd) {
          bd = dd;
          best = b;
        }
      }
      if (best >= 0) add.push(best);
      else {
        for (let cur = last, guard = 0; guard < 1000; guard++) {
          let next = -1;
          let nd = cellDist2(mesh, cur, c);
          for (let e = mesh.off[cur]; e < mesh.off[cur + 1]; e++) {
            const b = mesh.adj[e];
            const dd = cellDist2(mesh, b, c);
            if (dd < nd) {
              nd = dd;
              next = b;
            }
          }
          if (next < 0 || next === c) break;
          add.push(next);
          cur = next;
        }
      }
    }
    for (const b of add) {
      const k = pos.get(b);
      if (k !== undefined) {
        out.loop = { j, k };
        return out;
      }
      if (water(b)) {
        // 补上的格是水：停在上一个取样点
        out.stop = j - 1;
        return out;
      }
      pos.set(b, cells.length);
      cells.push(b);
    }
    const k = pos.get(c);
    if (k !== undefined) {
      out.loop = { j, k };
      return out;
    }
    pos.set(c, cells.length);
    cells.push(c);
    out.at.push(cells.length - 1);
    if (water(c) && cells.length > 1) {
      out.stop = j;
      return out;
    }
  }
  return out;
}

// 折线在第 j 个取样点处截断（截断点取整后要仍在同一格里，不然往后挪一个点）。返回截断后的折线与丢掉的部分
export function cutAt(world: World, pts: readonly Pt[], t: Trace, j: number): { pts: Pt[]; rest: Pt[] } {
  const { mesh } = world;
  const inside = (x: number, y: number) => mesh.kind === 'sphere' || (x >= 0 && y >= 0 && x <= mesh.width && y <= mesh.height);
  let q = j;
  const cell = findCell(mesh, t.x[j], t.y[j], t.cells[t.cells.length - 1]);
  for (let r = j; r < t.x.length && inside(t.x[r], t.y[r]) && findCell(mesh, t.x[r], t.y[r], cell) === cell; r++) {
    const [x, y] = roundPt([t.x[r], t.y[r]]);
    if (inside(x, y) && findCell(mesh, x, y, cell) === cell) {
      q = r;
      break;
    }
  }
  const p: Pt = [t.x[q], t.y[q]];
  return { pts: dedupe([...pts.slice(0, t.seg[q] + 1), roundPt(p)]), rest: [p, ...pts.slice(t.seg[q] + 1)] };
}

// 剪掉绕回去的圈：从这一格里最后一个取样点直接跳到回来的那个点（两点在同一格里，连线不出这一格）。
// 圈在不能动的那段里时返回 null
export function cutLoop(pts: readonly Pt[], t: Trace, fixed: number): Pt[] | null {
  const { j, k } = t.loop!;
  if (k < fixed - 1) return null;
  let a = j - 1;
  while (a >= 0 && t.at[a] > k) a--;
  if (a < 0) return null;
  const A = roundPt([t.x[a], t.y[a]]);
  if (t.seg[a] === t.seg[j]) return dedupe([...pts.slice(0, t.seg[a] + 1), A]);
  const J = roundPt([t.x[j], t.y[j]]);
  return dedupe([...pts.slice(0, t.seg[a] + 1), A, J, ...pts.slice(t.seg[j] + 1)]);
}

// 剪掉的圈：从这一格里最后一个取样点到回来的那个点（cutLoop 剪掉的那一段）的取样点
export function loopPoints(t: Trace): Pt[] {
  const { j, k } = t.loop!;
  let a = j - 1;
  while (a >= 0 && t.at[a] > k) a--;
  const out: Pt[] = [];
  for (let q = Math.max(0, a); q <= j && q < t.x.length; q++) out.push([t.x[q], t.y[q]]);
  return out;
}

// 画自定义走向的河：stroke 是画的线（地图单位；整个星球上 x 连续展开）。预览与松手后的命令用同一个结果。
// 从海、湖往陆地上画的倒过来（从河口往上游画）；起点在一条河上是改道
export function planCourse(world: World, d: Derived, stroke: readonly (readonly [number, number])[], opts: CourseOptions): CoursePlan {
  const { mesh, causes } = world;
  if (stroke.length < 2) return { ...emptyPlan(), blocked: '画得太短' };
  const water = (i: number) => !causes.land[i] || d.lake[i] === 1;
  let raw = stroke.map((p) => [p[0], p[1]] as Pt);
  if (mesh.kind === 'plane') {
    const [x, y] = raw[0];
    if (x < 0 || y < 0 || x > mesh.width || y > mesh.height) return { ...emptyPlan(), blocked: '要从地图上开始' };
  }
  const first = findCell(mesh, raw[0][0], raw[0][1]);
  const lastCell = findCell(mesh, raw[raw.length - 1][0], raw[raw.length - 1][1]);
  const reversed = water(first) && !water(lastCell);
  if (reversed) raw = raw.reverse();
  // 整个星球：起点挪到 [0, 2) 里（整圈地挪，位置不变）
  if (mesh.kind === 'sphere') {
    const shift = 2 * Math.floor(raw[0][0] / 2);
    if (shift) raw = raw.map(([x, y]) => [x - shift, y]);
  }
  const pts = simplifyStroke(world, raw, opts.px);
  if (pts.length < 2) return { ...emptyPlan(), reversed, blocked: '画得太短' };
  return courseFrom(world, d, { cells: [], path: [] }, pts, opts, reversed);
}

// 重画一段后折线的点数超出能存的
export const TOO_LONG = '河太长，这一段改不了';

// 这条画的河自己的格（它汇入的那一格是别的河的，不算：穿过、汇入那一格照常算作碰到那条河）
const guideCells = (world: World, id: string | undefined) => {
  const g = id ? world.small.guides.find((x) => x.id === id) : undefined;
  return new Set(g ? g.cells.filter((_, i) => ownsCell(g, i)) : []);
};

// 从 base（不动的那段：格与折线）的最后一格接着画 pts（第一点在那一格里）。base 是空的时候是一条新画的河：
// 起点要在陆地上，在一条河上就是改道
export function courseFrom(world: World, d: Derived, base: { cells: number[]; path: Pt[] }, input: Pt[], opts: CourseOptions, reversed: boolean): CoursePlan {
  const { mesh, causes } = world;
  const plan: CoursePlan = { ...emptyPlan(), reversed };
  const water = (i: number) => !causes.land[i] || d.lake[i] === 1;
  const isRiver = (i: number) => isRiverCell(world, d, i);
  const ignore = guideCells(world, opts.ignoreGuide);
  const fixed = base.cells.length;
  if (!fixed && water(findCell(mesh, input[0][0], input[0][1]))) return { ...plan, blocked: '要从陆地上开始' };

  // 折线 → 格：截掉进海、进湖、出地图之后的部分，剪掉绕回的圈，直到折线从头到尾都能照着走
  let pts = input;
  let leftMap = false;
  let trace: Trace | null = null;
  for (let iter = 0; iter < 40 && !trace; iter++) {
    const t = traceCourse(world, pts, base.cells, water);
    if (t.loop) {
      const next = cutLoop(pts, t, fixed);
      if (!next) return { ...plan, blocked: '新画的一段碰到了河自己' };
      plan.loops.push(loopPoints(t));
      pts = next;
    } else if (t.stop >= 0 && t.stop < t.x.length - 1) {
      leftMap ||= t.exit;
      const c = cutAt(world, pts, t, t.stop);
      plan.cut ??= c.rest;
      pts = c.pts;
    } else if (t.stop < 0 && t.exit) return { ...plan, blocked: '要从地图上开始' };
    else trace = t;
  }
  if (!trace) return { ...plan, blocked: '线太乱，换个画法' };
  const cells = trace.cells;
  if (cells.length < 2) return { ...plan, blocked: '画得太短' };
  plan.path = fixed ? [...base.path, ...pts.slice(1)] : pts;
  // 剪了很多圈之后点数可能超出能存的
  if (plan.path.length > COURSE_MAX_POINTS) return { ...plan, blocked: fixed ? TOO_LONG : '线太乱，换个画法' };
  const pos = new Map<number, number>();
  cells.forEach((c, k) => pos.set(c, k));
  const start = cells[0];
  // 改道：新画的河从一条河上起笔，或者接着画的那段是一条河的上游（opts.reroute），从它的最后一格改道
  const reroute = fixed ? !!opts.reroute : isRiver(start) && !ignore.has(start);
  plan.reroute = reroute;
  plan.rerouteAt = fixed && reroute ? fixed - 1 : 0;
  const from = cells[plan.rerouteAt];
  const own = new Set(opts.reroute?.own ?? []);

  // 改道：原来的河往下的那段（截弯取直时会经过，不算交叉）；它的上游不能汇入（水会绕成圈）。
  // 穿过上游的支流没关系：那条支流从这里起照着画的走
  const chain = new Set<number>();
  let up: Uint8Array | null = null;
  if (reroute) {
    for (let c = d.receiver[from], guard = 0; c >= 0 && !water(c) && guard < mesh.n; c = d.receiver[c], guard++) chain.add(c);
    up = upstreamOf(world, d, from);
  }
  // 改道的这条河自己往下的那段（opts.reroute 时）：流进它的河（比如紧挨着旧河道的一条小支流）也不汇入——
  // 汇进去水又回到旧河道上，这条河就断成了两条；顺着流下去，到了旧河道上还是这一条河
  const ownDown = new Set([...chain].filter((c) => own.has(c)));
  const intoOwn = (i: number) => {
    if (!ownDown.size) return false;
    for (let c = i, guard = 0; c >= 0 && !water(c) && guard < mesh.n; c = d.receiver[c], guard++) if (ownDown.has(c)) return true;
    return false;
  };
  // 能汇入的河：不是这条河道上的格、不是重画的那条河自己、不是改道的这条河的上游，也不是改道的这条河自己往下的那段
  const joinable = (i: number) => isRiver(i) && !ignore.has(i) && !(up && up[i]) && !own.has(i) && !intoOwn(i);

  // 终点
  const L = cells[cells.length - 1];
  plan.drawn = cells.length - 1;
  let end: CourseEnd | null = null;
  if (water(L)) end = causes.land[L] ? 'lake' : 'sea';
  else if (L !== start && joinable(L)) end = 'river';
  else if (leftMap && mesh.boundary[L] === 1) end = 'edge';
  else if (opts.endOnLand === 'sink') end = 'sink';
  else {
    // 顺着现在的流向接着流；会绕回河道或流进改道的这条河的上游时，改走避开它们的最省力路径
    const edge = (i: number) => causes.land[i] === 1 && mesh.boundary[i] === 1 && d.receiver[i] < 0;
    const stops = (i: number) => water(i) || (joinable(i) && !pos.has(i));
    const push = (c: number) => {
      pos.set(c, cells.length);
      cells.push(c);
    };
    let c = L;
    let loop = false;
    const follow = () => {
      loop = false;
      for (let guard = 0; guard < mesh.n; guard++) {
        const r = d.receiver[c];
        // 流到这里就没了（在终点消失的河的终点，比如把消失的河改回接着流）：也改走最省力的路径
        if (r < 0) {
          loop = !edge(c);
          break;
        }
        if (pos.has(r) || (up && up[r])) {
          loop = true;
          break;
        }
        const stop = stops(r);
        push(r);
        c = r;
        if (stop) break;
      }
    };
    follow();
    const avoid = (i: number) => pos.has(i) || (up !== null && up[i] === 1);
    if (loop) {
      // 改道时最省力的路径回到了这条河原来往下的那段上：之后照它原来的流向走（还是这一条河）
      const rest = pathToTarget(world, d, c, avoid, (i) => stops(i) || edge(i) || ownDown.has(i));
      for (const r of rest.slice(1)) push(r);
      c = cells[cells.length - 1];
      if (ownDown.has(c)) {
        follow();
        if (loop) for (const r of pathToTarget(world, d, c, avoid, (i) => stops(i) || edge(i)).slice(1)) push(r);
      }
    }
    const last = cells[cells.length - 1];
    end = water(last) ? (causes.land[last] ? 'lake' : 'sea') : last !== L && joinable(last) ? 'river' : edge(last) ? 'edge' : null;
  }
  plan.end = end;
  if (!end) return { ...plan, cells, blocked: '水流不出去' };
  // 在终点消失、终点又回到了这条河自己旁边（画了一个圈）：画出来是一个圈，水却在那里没了，不让这样画
  if (end === 'sink' && sinkNearSelf(world, plan.path) >= 0) return { ...plan, cells, blocked: SINK_LOOP };
  // 画到一条河上汇入：在画的线第一次碰到那条河（同一流域）的地方结束。斜着画过去时常常先擦过它的一两格，
  // 画到的那格在它们上游，照画到的那格汇入水会绕成圈；先擦过的格也不该算作截走它
  if (end === 'river' && plan.drawn === cells.length - 1) {
    const k = joinCut(world, d, cells, Math.max(1, fixed), joinable);
    if (k < 0) return { ...plan, cells, blocked: '这样水会绕成圈' };
    if (k < cells.length - 1) {
      const j = trace.at.findIndex((a) => a === k);
      const c = j >= 0 ? cutAt(world, pts, trace, j) : null;
      if (c) {
        plan.path = fixed ? [...base.path, ...c.pts.slice(1)] : c.pts;
        plan.cut = c.rest;
      }
      for (const x of cells.splice(k + 1)) pos.delete(x);
      plan.drawn = k;
    }
  }
  if (end === 'river') {
    plan.join = cells[cells.length - 1];
    plan.merge = world.small.guides.find((g) => g.id !== opts.ignoreGuide && canMerge(plan, g))?.id ?? null;
  }
  // 汇入的河、流进的湖往下流会回到这条河上（比如从湖的出口流进湖）：水会绕成圈
  if ((end === 'river' || end === 'lake') && flowsBack(world, d, cells[cells.length - 1], pos)) return { ...plan, cells, blocked: '这样水会绕成圈' };
  plan.cells = cells;
  // 穿过别的河（改道时原来那条河往下的那段不算）；改道后原来的河道会变干的那段
  plan.crossings = crossingsOf(world, d, cells, Math.max(1, fixed), plan.drawn, (c) => ignore.has(c) || chain.has(c), opts.ignoreGuide);
  // 碰到别的画的河却没有穿过去（贴着它走、又从同一侧离开，或者走到它上面就停了）：不截走它（不动画好的河），
  // 在第一次碰到它的地方汇入（第十三轮）。只有画的线从它的一侧穿到另一侧才算穿过（截走它）。
  // 自然的河照旧：碰到就是水流进新河（没有存下的河道可截，水文自己会接上）
  const touch = plan.crossings.find((x) => x.guide !== null && !crossesOver(world, d, plan.path, cells, x));
  if (touch) {
    const joined: CoursePlan = { ...endCourseAt(world, d, { ...plan, cells, end }, touch.from), touch: touch.cell };
    if (!joined.blocked) {
      if (reroute) joined.dried = driedBelow(world, d, d.receiver[from], d.discharge[from], new Set(joined.cells));
      if (fixed) joined.changed = [Math.max(0, base.path.length - 1), joined.path.length - 1];
      return joined;
    }
  }
  if (reroute) plan.dried = driedBelow(world, d, d.receiver[from], d.discharge[from], pos);

  // 估算挖多深、往高处流多少
  const est = courseEstimates(world, d.elevation, cells, end === 'sink');
  plan.gorge = est.gorge;
  plan.uphill = est.uphill;
  if (fixed) plan.changed = [Math.max(0, base.path.length - 1), plan.path.length - 1];
  return plan;
}

// 一处“穿过别的河”（crossingsOf 的 x）是不是真的穿过去了：画的线进那条河的格之前、出来之后的两点在它的两侧
// （那条河按格心连成的线：碰到的几格往上游、下游各多两格）。贴着它走又从同一侧离开、走到它上面就停了、
// 顺着它的线进出（离线不到 0.15 格，分不出哪一侧）都不算
export function crossesOver(world: World, d: Derived, path: readonly Pt[], cells: readonly number[], x: CourseCrossing): boolean {
  const { mesh } = world;
  const sphere = mesh.kind === 'sphere';
  const run = new Set(cells.slice(x.from, x.to + 1).filter((c) => isRiverCell(world, d, c)));
  if (!run.size) return false;
  // 那条河：碰到的格里水最少的一格往上游两格（沿水最多的那条支流），再顺流往下，过了碰到的格再多两格
  let top = -1;
  for (const c of run) if (top < 0 || d.discharge[c] < d.discharge[top]) top = c;
  for (let k = 0; k < 2; k++) {
    let up = -1;
    for (let e = mesh.off[top]; e < mesh.off[top + 1]; e++) {
      const j = mesh.adj[e];
      if (d.receiver[j] === top && isRiverCell(world, d, j) && (up < 0 || d.discharge[j] > d.discharge[up])) up = j;
    }
    if (up < 0) break;
    top = up;
  }
  const chain: number[] = [];
  let left = run.size;
  let extra = 2;
  for (let c = top, guard = 0; c >= 0 && guard < mesh.n && world.causes.land[c]; c = d.receiver[c], guard++) {
    chain.push(c);
    if (run.has(c)) left--;
    if (left <= 0 && extra-- <= 0) break;
  }
  if (chain.length < 2) return false;
  // 画的线上每隔四分之一格的点在哪一格：进那几格之前的最后一点、出来之后的第一点
  const S = pathSamples(path, courseStep(mesh));
  const inRun = new Uint8Array(S.x.length);
  let hint = cells[0];
  let first = -1;
  let last = -1;
  for (let j = 0; j < S.x.length; j++) {
    hint = findCell(mesh, S.x[j], S.y[j], hint);
    if (run.has(hint)) {
      inRun[j] = 1;
      if (first < 0) first = j;
      last = j;
    }
  }
  if (first <= 0 || last < 0 || last >= S.x.length - 1) return false;
  // 一点在那条河的哪一侧：离它最近的那一段（格心连线）的左右；离线太近为 0
  const side = (px: number, py: number) => {
    let best = Infinity;
    let sgn = 0;
    for (let k = 0; k + 1 < chain.length; k++) {
      const a = chain[k];
      const b = chain[k + 1];
      const ax = sphere ? px + wrapDelta(mesh.x[a] - px) : mesh.x[a];
      const bx = ax + (sphere ? wrapDelta(mesh.x[b] - mesh.x[a]) : mesh.x[b] - mesh.x[a]);
      const r = segProject(px, py, ax, mesh.y[a], bx, mesh.y[b]);
      if (r.d >= best) continue;
      best = r.d;
      const cr = (bx - ax) * (py - mesh.y[a]) - (mesh.y[b] - mesh.y[a]) * (px - ax);
      sgn = r.d < 0.15 * mesh.spacing ? 0 : Math.sign(cr);
    }
    return sgn;
  };
  const before = side(S.x[first - 1], S.y[first - 1]);
  const after = side(S.x[last + 1], S.y[last + 1]);
  return before !== 0 && after !== 0 && before !== after;
}

// 画到一条河上汇入时在河道的第几格结束：画的线第一次碰到这条河的那一格（同一流域、顺流几格就到汇入的那条河上：
// 同一条河上游、下游的格，或马上就汇进去的支流）；从那里汇入水会绕成圈时往后挪，都不行时为 −1。
// 隔得远的支流不算（照常是穿过它，问截不截走）
function joinCut(world: World, d: Derived, cells: readonly number[], lo: number, joinable: (i: number) => boolean): number {
  const { mesh, causes } = world;
  const last = cells.length - 1;
  const L = cells[last];
  const down = new Set<number>();
  for (let c = L, guard = 0; c >= 0 && causes.land[c] && guard < mesh.n; c = d.receiver[c], guard++) down.add(c);
  const near = (x: number, steps: number) => {
    for (let c = x, k = 0; c >= 0 && k <= steps; c = d.receiver[c], k++) if (down.has(c)) return true;
    return false;
  };
  const tries: number[] = [];
  for (let k = lo; k < last; k++) if (joinable(cells[k]) && d.basin[cells[k]] === d.basin[L] && near(cells[k], last - k + 3)) tries.push(k);
  tries.push(last);
  return tries.find((k) => !flowsBack(world, d, cells[k], new Set(cells.slice(0, k + 1)))) ?? -1;
}

// 一条河少了 q0 的水之后，从 from 往下会变干的格（估算，按原来的流向）：到海、湖或回到河道上为止
function driedBelow(world: World, d: Derived, from: number, q0: number, ours: { has(c: number): boolean }): number[] {
  const { causes, mesh } = world;
  const thr = world.small.planet.riverThreshold;
  const out: number[] = [];
  for (let c = from, guard = 0; c >= 0 && causes.land[c] && d.lake[c] !== 1 && !ours.has(c) && guard < mesh.n; c = d.receiver[c], guard++) {
    if (d.discharge[c] >= thr && d.discharge[c] - q0 < thr) out.push(c);
  }
  return out;
}

// 河道 cells 的第 from 到 to − 1 格里穿过别的河的地方：连着的几格（同一流域）算一处，skip 的格不算。
// 每处记下属于哪条画的河（ignoreGuide 自己的不算），估算截走后下游会变干的格
export function crossingsOf(world: World, d: Derived, cells: readonly number[], from: number, to: number, skip: (c: number) => boolean, ignoreGuide?: string): CourseCrossing[] {
  const ours = new Set(cells);
  const owner = new Map<number, string>();
  for (const g of world.small.guides) if (g.id !== ignoreGuide) g.cells.forEach((c, i) => ownsCell(g, i) && owner.set(c, g.id));
  const out: CourseCrossing[] = [];
  for (let k = from; k < to; k++) {
    const c = cells[k];
    if (!isRiverCell(world, d, c) || skip(c)) continue;
    const last = out[out.length - 1];
    if (last && last.to === k - 1 && d.basin[cells[k - 1]] === d.basin[c]) last.to = k;
    else out.push({ from: k, to: k, cell: c, guide: null, dried: [] });
  }
  for (const x of out) {
    // 那条河原来从哪一格流出这一段：它下游少了这么多水
    let exit = -1;
    for (let k = x.from; k <= x.to; k++) {
      const c = cells[k];
      x.guide ??= owner.get(c) ?? null;
      const r = d.receiver[c];
      if (r >= 0 && !ours.has(r) && (exit < 0 || d.discharge[c] > d.discharge[exit])) exit = c;
    }
    if (exit >= 0) x.dried = driedBelow(world, d, d.receiver[exit], d.discharge[exit], ours);
  }
  return out;
}

// 从 from 顺着现在的流向往下，会不会回到 ours 里的格
export function flowsBack(world: World, d: Derived, from: number, ours: { has(c: number): boolean }): boolean {
  for (let c = d.receiver[from], guard = 0; c >= 0 && world.causes.land[c] && guard < world.mesh.n; c = d.receiver[c], guard++) if (ours.has(c)) return true;
  return false;
}

// 按 bedLevels 的挖法估算：穿山挖出的峡谷最深多少米；河道上最低处到终点的水面要往高处流多少米。
// sink：在终点消失（终点是出口）
export function courseEstimates(world: World, elevation: ArrayLike<number>, cells: readonly number[], sink: boolean): { gorge: number; uphill: number } {
  const { mesh } = world;
  const land = world.causes.land;
  const terminal = sinkMask(world) ?? new Uint8Array(mesh.n);
  if (sink) terminal[cells[cells.length - 1]] = 1;
  const h = bedLevels(mesh, land, elevation, cells, world.small.lakes.length ? userLakeMask(world) : undefined, terminal);
  let last = cells.length - 1;
  for (let k = 0; k < cells.length; k++) {
    if (!land[cells[k]]) {
      last = k;
      break;
    }
  }
  let gorge = 0;
  let low = Infinity;
  for (let k = 0; k < last; k++) {
    gorge = Math.max(gorge, elevation[cells[k]] - h[k]);
    low = Math.min(low, elevation[cells[k]]);
  }
  const end = cells[last];
  const level = land[end] ? waterLevel(mesh, land, elevation, end, terminal) : elevation[end];
  return { gorge, uphill: Number.isFinite(low) ? Math.max(0, level - low) : 0 };
}

// “到这里汇入”：河道在第 k 格（穿过的那条河上）结束。折线截在第一次进这格的地方
export function endCourseAt(world: World, d: Derived, plan: CoursePlan, k: number): CoursePlan {
  if (k <= 0 || k >= plan.cells.length) return plan;
  const cells = plan.cells.slice(0, k + 1);
  const join = cells[k];
  const t = traceCourse(world, plan.path, [], () => false);
  const j = t.at.findIndex((a) => t.cells[a] === join);
  const cut = j >= 0 ? cutAt(world, plan.path, t, j) : null;
  const est = courseEstimates(world, d.elevation, cells, false);
  // 汇入的是改道的这条河自己的上游（穿过它的支流时）：水会绕成圈
  const loop = flowsBack(world, d, join, new Set(cells));
  return {
    ...plan,
    cells,
    path: cut ? cut.pts : plan.path,
    drawn: Math.min(plan.drawn, k),
    cut: cut ? cut.rest : plan.cut,
    end: isRiverCell(world, d, join) ? 'river' : plan.end,
    join,
    merge: world.small.guides.find((g) => canMerge({ join, path: cut ? cut.pts : plan.path }, g))?.id ?? null,
    crossings: plan.crossings.filter((x) => x.to < k),
    gorge: est.gorge,
    uphill: est.uphill,
    blocked: loop ? '这样水会绕成圈' : null,
  };
}

// 能不能接到画的河 g 前面（plan.merge）：汇入的是它（有泉水）的源头，接起来的折线不超过能存的点数
function canMerge(plan: { join: number; path: readonly Pt[] }, g: Guide): boolean {
  return g.spring && g.cells[0] === plan.join && plan.path.length + (g.path ? g.path.length / 2 : 0) <= COURSE_MAX_POINTS;
}
