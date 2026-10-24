import type { Command, GuidePatch } from './commands';
import { wrapDelta } from './geo';
import { findCell } from './mesh';
import { courseStep, dedupePoints as dedupe, douglasPeucker, encodePath, guidePoints, ownsCell, pathSamples, roundPoint as roundPt, snapOnto, stemPath } from './rivers';
import {
  type CourseOptions,
  type CoursePlan,
  TOO_LONG,
  continueFrom,
  courseEstimates,
  courseFrom,
  crossingsOf,
  cutLoop,
  emptyPlan,
  endCourseAt,
  isRiverCell,
  endIn,
  loopPoints,
  endKind,
  flowsBack,
  planCourse,
  pointsTo,
  projectOn,
  riverStem,
  simplifyStroke,
  traceCourse,
} from './select';
import { COURSE_MAX_POINTS, type Derived, type Guide, type World } from './world';

// 改一条河（第十一轮）：在原来的河上直接改，还是同一条河（同一个河道 id、名字、大小、类型、粗细）。
// 改的是河的控制点（折线 guidePoints：画的河是画的线再接上顺地势流下去的那段，自然的河是固定时会存的那条线），
// 格从折线重新算：只换改到的那一段，前后的格、折线逐点不变。
//   · 拖控制点：只改这一点两边的那一小段（两边的弯弯曲曲跟着这一点整体转一下、拉长缩短，不变成直线）；
//   · 在河上重画一笔（strokeEdit）：从河上某点起笔，回到同一条河上只换中间那段；停在别处是从起笔处改道；
//     从源头起笔挪源头，从终点起笔往下游接长。
// 自然的河第一次改时固定下来（一条 add_guide：主干连同改好的那段，沿用它的地名，名字不变）

type Pt = [number, number];

// 改一条河道（与 update_guide 相同：null 删掉这一项）
export function applyPatch(g: Guide, patch: GuidePatch): Guide {
  const out: Record<string, unknown> = { ...g, ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === null) delete out[k];
  return out as Guide;
}

export interface EditTarget {
  // 画的河道（还没固定的自然的河是按它的主干造出来的河道，id 为 ''）
  guide: Guide;
  natural: boolean;
  // 控制点（guidePoints；整个星球上沿河连续展开）
  points: Pt[];
  // 前几个点是存下的折线（之后是顺地势流下去的那段，按格算出来的）
  stored: number;
  // 每个控制点在第几格（guide.cells 的下标；点不在河道的格里时为 −1，不能当作改的起止点）
  at: number[];
  // 这条河自己的格（最后一格是它汇入的地方时不算）
  own: number[];
  // 改之前地图上写的名字（自动起的；用户起的名字为 undefined）与按规则成了哪一种河：改了以后照旧叫它、还是这一种
  // （名字记进 autoName、类型记进 type，见 editCommand），不因为走向、大小变了重新起名、换类型
  autoName?: string;
  // 那个名字的原文（第二十轮，记进 autoOrig）
  autoOrig?: string;
  ruleType?: string;
}

// 这条河现在按规则是哪一种（河上的格里最多的那种；普通的河、没有河流类型时为 undefined）
export function ruleTypeOf(world: World, d: Derived, cells: readonly number[]): string | undefined {
  const rt = d.riverType;
  const types = world.small.riverTypes;
  if (!rt || !types?.length) return undefined;
  const count = new Map<number, number>();
  for (const c of cells) if (isRiverCell(world, d, c)) count.set(rt[c], (count.get(rt[c]) ?? 0) + 1);
  let best = 0;
  let bn = 0;
  for (const [v, k] of count) if (k > bn || (k === bn && v < best)) [best, bn] = [v, k];
  return best > 0 ? types[best - 1]?.id : undefined;
}

function targetOf(world: World, g: Guide, natural: boolean): EditTarget {
  const { mesh } = world;
  const points = guidePoints(world, g);
  const C = g.cells;
  const pos = new Map<number, number>();
  C.forEach((c, k) => pos.set(c, k));
  let hint = C[0];
  let prev = 0;
  const at = points.map(([x, y]) => {
    hint = findCell(mesh, x, y, hint);
    const k = pos.get(hint);
    if (k === undefined || k < prev) return -1;
    prev = k;
    return k;
  });
  return { guide: g, natural, points, stored: g.path ? Math.min(points.length, g.path.length / 2) : points.length, at, own: C.filter((_, i) => ownsCell(g, i)) };
}

// 画的河（或固定下来的河）
export function guideTarget(world: World, g: Guide): EditTarget {
  const T = targetOf(world, g, false);
  const f = world.derived.features.find((x) => x.guide === g.id);
  if (f?.name && !f.custom && !g.name) {
    T.autoName = f.name;
    if (f.orig) T.autoOrig = f.orig;
  }
  if (!g.type) T.ruleType = ruleTypeOf(world, world.derived, T.own);
  return T;
}

// 自然的河：这一格所在的主干（riverStem）当作一条固定下来的河道，名字沿用它的地名键（naming 由界面给；省略时按地物找）
// 固定下来时：名字记下（autoName，用户改过名的照旧跟着那条改名），按规则成了哪一种河也记下（type）
export function naturalTarget(world: World, d: Derived, cell: number, naming?: { nameKey: string; autoName?: string; autoOrig?: string } | { name: string }): EditTarget | null {
  const stem = riverStem(world, d, cell);
  if (stem.cells.length < 2) return null;
  let name = naming;
  if (!name) {
    const f = d.features.find((x) => x.type === 'river' && x.guide === undefined && x.cells.includes(cell));
    name = f ? { nameKey: f.key, ...(f.name && !f.custom ? { autoName: f.name, ...(f.orig ? { autoOrig: f.orig } : {}) } : {}) } : { name: '' };
  }
  const own = stem.end === 'river' ? stem.cells.slice(0, -1) : stem.cells;
  const type = ruleTypeOf(world, d, own);
  const g = { id: '', cells: stem.cells, path: stemPath(world, stem.cells), locked: true, spring: false, ...name, ...(type ? { type } : {}) } as Guide;
  return targetOf(world, g, true);
}

// 改的起止点：在河道的第 k 格里的一点 p，折线到第 seg 个控制点为止再接上 p（前面不动的折线），之后接 seg + 1 起的点
export interface Anchor {
  k: number;
  p: Pt;
  seg: number;
}

const vertexAnchor = (T: EditTarget, i: number): Anchor => ({ k: T.at[i], p: T.points[i], seg: i });

// 离 i 最近、在河道格里的控制点
function nearestInside(T: EditTarget, i: number): number {
  for (let r = 0; r < T.points.length; r++) {
    if (i - r >= 0 && T.at[i - r] >= 0) return i - r;
    if (i + r < T.points.length && T.at[i + r] >= 0) return i + r;
  }
  return -1;
}

// 整个星球：点整圈地挪到离折线最近的那一份
function alignTo(world: World, P: readonly Pt[], p: Pt): number {
  if (world.mesh.kind !== 'sphere') return 0;
  let best = 0;
  let bd = Infinity;
  for (const s of [-4, -2, 0, 2, 4]) {
    const dd = projectOn(P, p[0] + s, p[1]).d;
    if (dd < bd) {
      bd = dd;
      best = s;
    }
  }
  return best;
}

// 一点在河上的位置（悬停、按下、拖控制点都用它）：投影到控制点折线上，along 是从源头量起的长度，total 是全长
export interface EditPoint {
  seg: number;
  t: number;
  d: number;
  along: number;
  total: number;
  p: Pt;
}
export function editPoint(world: World, T: EditTarget, x: number, y: number): EditPoint {
  const P = T.points;
  const s = alignTo(world, P, [x, y]);
  const r = projectOn(P, x + s, y);
  let total = 0;
  for (let k = 0; k + 1 < P.length; k++) total += Math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]);
  return { ...r, total };
}

// 从河上哪里起笔：源头附近（tol 以内）是挪源头，终点附近是往下游接长，其余是从这里改（悬停与按下同一个判定）
export type EditRole = 'source' | 'end' | 'middle';
// 很短的河两头都在 tol 以内时按离哪头近
export function editRole(e: EditPoint, tol: number): EditRole {
  const toEnd = e.total - e.along;
  if (e.along <= tol && e.along <= toEnd) return 'source';
  if (toEnd <= tol) return 'end';
  if (e.along <= tol) return 'source';
  return 'middle';
}

// 投影点 → 起止点：投影点所在的格要在河道上；不在时挪到最近的、在河道格里的控制点
function anchorAt(world: World, T: EditTarget, e: { seg: number; t: number; p: Pt }): Anchor | null {
  const C = T.guide.cells;
  const r = roundPt(e.p);
  const c = findCell(world.mesh, r[0], r[1], C[Math.max(0, T.at[e.seg])]);
  const k = C.indexOf(c);
  const lo = T.at.slice(0, e.seg + 1).reduce((m, v) => Math.max(m, v), 0);
  if (k >= lo) return { k, p: r, seg: e.seg };
  const i = nearestInside(T, e.t < 0.5 ? e.seg : Math.min(e.seg + 1, T.points.length - 1));
  return i >= 0 ? vertexAnchor(T, i) : null;
}

const prefixPath = (T: EditTarget, a: Anchor): Pt[] => dedupe([...T.points.slice(0, a.seg + 1), a.p]);

// b 之后的折线：b 在存下的折线里时只存到存下的末端（之后照旧是顺地势流下去的那段）；改到了流下去的那段里时后面的点也存下来
const suffixPath = (T: EditTarget, b: Anchor): Pt[] => T.points.slice(b.seg + 1, b.seg + 1 < T.stored ? T.stored : T.points.length);

export type EditKind = 'splice' | 'reroute' | 'extend' | 'source' | 'shorten' | 'bend';

export interface RiverEdit {
  kind: EditKind;
  // update_guide 的 patch（格、折线，终点变了时连终点）
  patch: GuidePatch;
  plan: CoursePlan;
  // 没能照画的走的原因（比如中间穿过了海，河在那里入海）：预览里写出来
  note: string | null;
  // 这条河原来的格里，改完不再是它的（会变干的旧河道，估计）
  dropped: number[];
}
export type EditResult = RiverEdit | { blocked: string };

export interface EditOptions extends Pick<CourseOptions, 'endOnLand' | 'px'> {
  // 画回同一条河上算“回到河上”：离控制点折线多远以内（地图单位，界面给 14 个屏幕像素）
  tol: number;
}

const water = (world: World, d: Derived, i: number) => !world.causes.land[i] || d.lake[i] === 1;

function finish(world: World, T: EditTarget, kind: EditKind, plan: CoursePlan, patch: GuidePatch, note: string | null = null): RiverEdit {
  const now = new Set(plan.cells);
  const dropped = T.own.filter((c) => !now.has(c) && world.causes.land[c]);
  return { kind, patch, plan, note, dropped };
}

// 河道上的一段换成新画的 mid（从 a 到 b，a 在前）：前后两段的格与折线都不动。
// 新画的一段没能回到 b（中途进了海、湖，出了地图）时返回 fallback 与原因：照实际会发生的从 a 改道
function spliceSection(world: World, d: Derived, T: EditTarget, a: Anchor, b: Anchor, mid: readonly Pt[], kind: EditKind): EditResult | { fallback: string } {
  const C = T.guide.cells;
  if (b.k <= a.k) return { blocked: '这一段太短' };
  const wet = (i: number) => water(world, d, i);
  let Q = dedupe([a.p, ...mid.map(roundPt), b.p]);
  let t = traceCourse(world, Q, C.slice(0, a.k + 1), wet);
  const loops: Pt[][] = [];
  for (let iter = 0; t.loop && iter < 40; iter++) {
    const next = cutLoop(Q, t, a.k + 1);
    if (!next) return { blocked: '新画的一段碰到了河自己' };
    loops.push(loopPoints(t));
    Q = next;
    t = traceCourse(world, Q, C.slice(0, a.k + 1), wet);
  }
  if (t.loop) return { blocked: '线太乱，换个画法' };
  const lastIn = t.cells[t.cells.length - 1];
  if (lastIn !== C[b.k]) {
    if (t.exit) return { fallback: '出了地图' };
    if (t.stop >= 0 && wet(lastIn)) return { fallback: world.causes.land[lastIn] ? '穿过湖：河在这里流进湖' : '穿过海：河在这里入海' };
    return { fallback: '没回到河上' };
  }
  const midCells = t.cells.slice(a.k + 1, -1);
  const tail = C.slice(b.k);
  const tailSet = new Set(tail);
  if (midCells.some((c) => tailSet.has(c))) return { blocked: '新画的一段碰到了河自己' };
  const cells = [...C.slice(0, a.k + 1), ...midCells, ...tail];
  if (flowsBack(world, d, cells[cells.length - 1], new Set(midCells))) return { blocked: '这样水会绕成圈' };
  const pre = prefixPath(T, a);
  const path = dedupe([...pre, ...Q.slice(1), ...suffixPath(T, b)]);
  if (path.length > COURSE_MAX_POINTS) return { blocked: TOO_LONG };
  const plan: CoursePlan = { ...emptyPlan(), cells, path, drawn: cells.length - 1, end: endKind(world, d, T.guide, cells), loops };
  plan.changed = [pre.length - 1, Math.min(path.length - 1, pre.length - 1 + Q.length - 1)];
  plan.join = plan.end === 'river' ? cells[cells.length - 1] : -1;
  const old = new Set(C);
  plan.crossings = crossingsOf(world, d, cells, a.k + 1, a.k + 1 + midCells.length, (c) => old.has(c), T.natural ? undefined : T.guide.id);
  const est = courseEstimates(world, d.elevation, cells, T.guide.end === 'sink');
  plan.gorge = est.gorge;
  plan.uphill = est.uphill;
  return finish(world, T, kind, plan, { cells, path: encodePath(path) });
}

// 从 a 起改走 input（input 的第一点就是 a.p）：a 以前的格、折线不动，之后照着走；终点按 opts（陆地上接着流还是消失；
// 进海、进湖、到别的河上就在那里结束）。stroke：input 是手画的线（先磨圆、化简，刚起笔擦过前一两格时从擦过的那格接上）
function rerouteFrom(world: World, d: Derived, T: EditTarget, a: Anchor, input: readonly Pt[], opts: CourseOptions, kind: EditKind, stroke: boolean, note: string | null = null): EditResult {
  const C = T.guide.cells;
  const sub: CourseOptions = { ...opts, ...(T.natural ? {} : { ignoreGuide: T.guide.id }), reroute: { own: T.own } };
  let plan: CoursePlan;
  if (stroke) {
    const baseTo = (k: number): Pt[] => (k === a.k ? prefixPath(T, a) : endIn(world, pointsTo(world, C, T.points, k), C[k]));
    plan = continueFrom(world, d, C, a.k, baseTo, input.map((p) => [p[0], p[1]] as Pt), sub, false);
  } else {
    const base = prefixPath(T, a);
    plan = courseFrom(world, d, { cells: C.slice(0, a.k + 1), path: base }, dedupe([base[base.length - 1], ...input.slice(1).map(roundPt)]), sub, false);
  }
  if (plan.blocked) return { blocked: plan.blocked };
  if (plan.cells.length < 2) return { blocked: '画得太短' };
  const patch: GuidePatch = { cells: plan.cells, path: encodePath(plan.path) };
  if (plan.end === 'sink') patch.end = 'sink';
  else if (T.guide.end) patch.end = null;
  return finish(world, T, kind, plan, patch, note);
}

// 换掉源头一段：head 是新的源头到 b 的折线（最后一点是 b.p），b 往下的格、折线不动
function headSection(world: World, d: Derived, T: EditTarget, head: readonly Pt[], b: Anchor): EditResult {
  const { mesh } = world;
  const C = T.guide.cells;
  const wet = (i: number) => water(world, d, i);
  let Q = dedupe([...head.slice(0, -1).map(roundPt), b.p]);
  const src = findCell(mesh, Q[0][0], Q[0][1], C[b.k]);
  if (wet(src)) return { blocked: '源头要在陆地上' };
  let t = traceCourse(world, Q, [], wet);
  const loops: Pt[][] = [];
  for (let iter = 0; t.loop && iter < 40; iter++) {
    const next = cutLoop(Q, t, 0);
    if (!next) return { blocked: '线太乱，换个画法' };
    loops.push(loopPoints(t));
    Q = next;
    t = traceCourse(world, Q, [], wet);
  }
  if (t.exit) return { blocked: '源头要在地图上' };
  if (t.loop || t.cells[t.cells.length - 1] !== C[b.k]) return { blocked: t.stop >= 0 ? '新源头穿过了海或湖' : '这里改不了' };
  const headCells = t.cells.slice(0, -1);
  // 源头落在别的河上：那条河会被从中间截断、下游却还标着它（截走只认新河道中间的格），不让这样改
  if (headCells.length && isRiverCell(world, d, headCells[0]) && !T.own.includes(headCells[0])) return { blocked: '源头不能在别的河上：先选中那条河再加源头' };
  const tail = C.slice(b.k);
  const tailSet = new Set(tail);
  if (headCells.some((c) => tailSet.has(c))) return { blocked: '新画的一段碰到了河自己' };
  const cells = [...headCells, ...tail];
  if (cells.length < 2) return { blocked: '河太短' };
  const path = dedupe([...Q, ...suffixPath(T, b)]);
  if (path.length > COURSE_MAX_POINTS) return { blocked: TOO_LONG };
  const plan: CoursePlan = { ...emptyPlan(), cells, path, drawn: cells.length - 1, end: endKind(world, d, T.guide, cells), loops };
  plan.changed = [0, Math.min(path.length - 1, Q.length - 1)];
  plan.join = plan.end === 'river' ? cells[cells.length - 1] : -1;
  const old = new Set(C);
  plan.crossings = crossingsOf(world, d, cells, 0, headCells.length, (c) => old.has(c), T.natural ? undefined : T.guide.id);
  const est = courseEstimates(world, d.elevation, cells, T.guide.end === 'sink');
  plan.gorge = est.gorge;
  plan.uphill = est.uphill;
  return finish(world, T, 'source', plan, { cells, path: encodePath(path) });
}

// 终点挪回河上的 a（缩短）：a 以下不要了，河在这里消失
function shortenTo(world: World, d: Derived, T: EditTarget, a: Anchor): EditResult {
  const C = T.guide.cells;
  if (a.k < 1) return { blocked: '河太短' };
  if (water(world, d, C[a.k])) return { blocked: '这里不能结束' };
  const cells = C.slice(0, a.k + 1);
  const path = prefixPath(T, a);
  const plan: CoursePlan = { ...emptyPlan(), cells, path, drawn: cells.length - 1, end: 'sink' };
  plan.changed = [path.length - 1, path.length - 1];
  const est = courseEstimates(world, d.elevation, cells, true);
  plan.gorge = est.gorge;
  plan.uphill = est.uphill;
  return finish(world, T, 'shorten', plan, { cells, path: encodePath(path), end: 'sink' });
}

// 中间的点：从 a 到 b，原来的弯曲跟着 from → to 整体转一下、拉长缩短（以 pivot 为不动点的相似变换）
function similar(pivot: Pt, from: Pt, to: Pt): (p: Pt) => Pt {
  const ux = from[0] - pivot[0];
  const uy = from[1] - pivot[1];
  const vx = to[0] - pivot[0];
  const vy = to[1] - pivot[1];
  const l2 = ux * ux + uy * uy;
  if (l2 < 1e-12) return (p) => [p[0] + to[0] - from[0], p[1] + to[1] - from[1]];
  // (v / u) 当作复数
  const re = (vx * ux + vy * uy) / l2;
  const im = (vy * ux - vx * uy) / l2;
  return ([x, y]) => {
    const dx = x - pivot[0];
    const dy = y - pivot[1];
    return [pivot[0] + dx * re - dy * im, pivot[1] + dx * im + dy * re];
  };
}

// 第 i 个控制点挪到 to，i0、i1 是两边相邻的控制点（不动）：之间的点跟着变（不含 i0、i1）
function bent(P: readonly Pt[], i0: number, i: number, i1: number, to: Pt): Pt[] {
  const left = similar(P[i0], P[i], to);
  const right = similar(P[i1], P[i], to);
  return [...P.slice(i0 + 1, i).map(left), to, ...P.slice(i + 1, i1).map(right)];
}

// 在河上重画一笔：stroke 的第一点在河上（界面已经吸到河上）。按起笔的位置与画到哪里：
//   · 源头起笔：画到河上（往下游）是把源头挪到那里（缩短）；画到别处是源头往上游接长，照画的线流到原来的源头；
//   · 终点起笔：往下游接长（终点按 opts：陆地上接着流或消失，进海、湖、到别的河上就在那里结束）；
//   · 中间起笔：画回同一条河上（下游、上游都行）只换两点之间那一段；停在别处是从起笔处改道。
// 中间那段没能回到河上（穿过了海、湖）时照实际会发生的改道，note 写明原因
export function strokeEdit(world: World, d: Derived, T: EditTarget, stroke: readonly (readonly [number, number])[], opts: EditOptions): EditResult {
  const { mesh } = world;
  if (stroke.length < 2) return { blocked: '画得太短' };
  const P = T.points;
  if (P.length < 2) return { blocked: '这里改不了' };
  let raw = stroke.map((p) => [p[0], p[1]] as Pt);
  const s = alignTo(world, P, raw[0]);
  if (s) raw = raw.map(([x, y]) => [x + s, y]);
  const e0 = editPoint(world, T, raw[0][0], raw[0][1]);
  const L = raw[raw.length - 1];
  const ee = editPoint(world, T, L[0], L[1]);
  const role = editRole(e0, opts.tol);
  if (role === 'source' && T.guide.branch) return { blocked: BRANCH_HEAD };
  const course: CourseOptions = { endOnLand: opts.endOnLand, px: opts.px };
  const back = ee.d <= opts.tol;
  if (role === 'source') {
    if (back && ee.along >= Math.max(mesh.spacing, opts.tol)) {
      const b = anchorAt(world, T, ee);
      if (!b) return { blocked: '这里改不了' };
      return headSection(world, d, T, [b.p], b);
    }
    const drawn = simplifyStroke(world, raw, opts.px, COURSE_MAX_POINTS - (P.length - 1));
    return headSection(world, d, T, [...drawn.slice(1).reverse(), P[0]], vertexAnchor(T, 0));
  }
  if (role === 'end') {
    const C = T.guide.cells;
    const k = T.own.length - 1;
    if (k < 0) return { blocked: '这里改不了' };
    const baseTo = (j: number): Pt[] => endIn(world, j === C.length - 1 ? P.slice() : pointsTo(world, C, P, j), C[j]);
    const sub: CourseOptions = { ...course, ...(T.natural ? {} : { ignoreGuide: T.guide.id }) };
    const plan = continueFrom(world, d, C, k, baseTo, raw, sub, false);
    if (plan.blocked) return { blocked: plan.blocked };
    const patch: GuidePatch = { cells: plan.cells, path: encodePath(plan.path) };
    if (plan.end === 'sink') patch.end = 'sink';
    else if (T.guide.end) patch.end = null;
    return finish(world, T, 'extend', plan, patch);
  }
  let a = anchorAt(world, T, e0);
  if (!a) return { blocked: '这里改不了' };
  if (back && Math.abs(ee.along - e0.along) >= mesh.spacing) {
    let b = anchorAt(world, T, ee);
    let pts = raw;
    if (b && b.k < a.k) {
      [a, b] = [b, a];
      pts = raw.slice().reverse();
    }
    if (b && b.k > a.k) {
      const drawn = simplifyStroke(world, pts, opts.px, COURSE_MAX_POINTS - (P.length - (b.seg - a.seg)) - 2);
      const r = spliceSection(world, d, T, a, b, drawn.slice(1, -1), 'splice');
      if (!('fallback' in r)) return r;
      return rerouteFrom(world, d, T, a, [a.p, ...drawn.slice(1)], course, 'reroute', false, r.fallback);
    }
  }
  return rerouteFrom(world, d, T, a, [a.p, ...raw.slice(1)], course, 'reroute', true);
}

// 选中的河上的控制点：控制点折线化简（容差 tol）后，相邻两点至少隔 gap（地图单位，界面给约 40 个屏幕像素）。
// 都是能当作改的起止点的点（在河道的格里），源头、终点一定有。返回控制点的下标
export function controlHandles(T: EditTarget, tol: number, gap: number): number[] {
  const P = T.points;
  const n = P.length;
  if (n < 2) return [];
  const idx = new Map<string, number>();
  P.forEach((p, i) => idx.set(`${p[0]},${p[1]}`, i));
  const kept = douglasPeucker(P, tol).map((p) => idx.get(`${p[0]},${p[1]}`) ?? -1);
  const ins = (i: number) => (i <= 0 || i >= n - 1 ? i : T.at[i] >= 0 ? i : nearestInside(T, i));
  const cand = [...new Set(kept.map(ins).filter((i) => i > 0 && i < n - 1))].sort((x, y) => x - y);
  const dist = (i: number, j: number) => Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1]);
  const out = [0];
  for (const i of cand) if (dist(out[out.length - 1], i) >= gap) out.push(i);
  while (out.length > 1 && dist(out[out.length - 1], n - 1) < gap) out.pop();
  out.push(n - 1);
  return out;
}

// 两个控制点之间的“+”放在哪个点上（折线上离两点中间最近的控制点；之间没有点时为 −1，放在两点连线的中点）
export function midHandle(T: EditTarget, i0: number, i1: number): number {
  if (i1 - i0 < 2) return -1;
  const P = T.points;
  let total = 0;
  const acc = [0];
  for (let k = i0; k < i1; k++) acc.push((total += Math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1])));
  let best = i0 + 1;
  for (let k = i0 + 1; k < i1; k++) if (Math.abs(acc[k - i0] - total / 2) < Math.abs(acc[best - i0] - total / 2)) best = k;
  return T.at[best] >= 0 ? best : -1;
}

// 拖第 j 个控制点（handles[j]）到 to：
//   · 源头：挪源头（拖到河上往下游是缩短）；
//   · 终点：挪终点（拖到河上往回是缩短，在那里消失；拖进海、湖就在那里入海、入湖；拖到别的河上就汇入它，界面先吸到它的线上；
//     停在陆地上就在那里消失）；
//   · 中间的弯点：只改它两边相邻两个控制点之间的那一段
export function dragHandle(world: World, d: Derived, T: EditTarget, handles: readonly number[], j: number, to: Pt, opts: EditOptions): EditResult {
  const P = T.points;
  const n = handles.length;
  if (n < 2 || j < 0 || j >= n) return { blocked: '这里改不了' };
  const s = alignTo(world, P, to);
  const q: Pt = [to[0] + s, to[1]];
  const i = handles[j];
  const e = editPoint(world, T, q[0], q[1]);
  if (j === 0 && T.guide.branch) return { blocked: BRANCH_HEAD };
  if (j === 0) {
    if (e.d <= opts.tol && e.along >= Math.max(world.mesh.spacing, opts.tol)) {
      const b = anchorAt(world, T, e);
      return b ? headSection(world, d, T, [b.p], b) : { blocked: '这里改不了' };
    }
    const i1 = handles[1];
    const f = similar(P[i1], P[0], q);
    return headSection(world, d, T, [...P.slice(0, i1).map(f), P[i1]], vertexAnchor(T, i1));
  }
  const i0 = handles[j - 1];
  if (j === n - 1) {
    if (e.d <= opts.tol && e.total - e.along >= Math.max(world.mesh.spacing, opts.tol)) {
      const a = anchorAt(world, T, e);
      return a ? shortenTo(world, d, T, a) : { blocked: '这里改不了' };
    }
    const f = similar(P[i0], P[i], q);
    return rerouteFrom(world, d, T, vertexAnchor(T, i0), [P[i0], ...P.slice(i0 + 1, i).map(f), q], { endOnLand: 'sink', px: opts.px }, 'reroute', false);
  }
  return bendSection(world, d, T, i0, handles[j + 1], bent(P, i0, i, handles[j + 1], q));
}

// 在第 j 与 j + 1 个控制点之间加一个控制点，拖到 to
export function insertHandle(world: World, d: Derived, T: EditTarget, handles: readonly number[], j: number, to: Pt): EditResult {
  const P = T.points;
  if (j < 0 || j + 1 >= handles.length) return { blocked: '这里改不了' };
  const s = alignTo(world, P, to);
  const q: Pt = [to[0] + s, to[1]];
  const i0 = handles[j];
  const i1 = handles[j + 1];
  const m = midHandle(T, i0, i1);
  return bendSection(world, d, T, i0, i1, m < 0 ? [q] : bent(P, i0, m, i1, q));
}

// 删掉第 j 个控制点（中间的弯点）：它两边那一段照着两边的点拉直（中间的弯曲跟着变，不变成一条直线）
export function deleteHandle(world: World, d: Derived, T: EditTarget, handles: readonly number[], j: number): EditResult {
  const P = T.points;
  if (j <= 0 || j >= handles.length - 1) return { blocked: '源头、终点不能删' };
  const i0 = handles[j - 1];
  const i = handles[j];
  const i1 = handles[j + 1];
  const [ax, ay] = P[i0];
  const [bx, by] = P[i1];
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((P[i][0] - ax) * dx + (P[i][1] - ay) * dy) / l2));
  const q: Pt = [ax + dx * t, ay + dy * t];
  return bendSection(world, d, T, i0, i1, bent(P, i0, i, i1, q).filter((p) => p !== q));
}

function bendSection(world: World, d: Derived, T: EditTarget, i0: number, i1: number, mid: Pt[]): EditResult {
  const a = vertexAnchor(T, i0);
  const b = vertexAnchor(T, i1);
  const r = spliceSection(world, d, T, a, b, mid, 'bend');
  if (!('fallback' in r)) return r;
  // 中间穿过了海、湖：河在那里入海、入湖（之后的不要了）
  return rerouteFrom(world, d, T, a, [a.p, ...mid, b.p, ...T.points.slice(i1 + 1)], { endOnLand: T.guide.end === 'sink' ? 'sink' : 'flow' }, 'reroute', false, r.fallback);
}

// 在第一次碰到的别的河那里汇入（按住 Alt 松手）：只对从某点改道、接长有用（中间一段、源头一段穿过别的河照旧截走）
export function joinAtFirst(world: World, d: Derived, T: EditTarget, e: RiverEdit): EditResult {
  if ((e.kind !== 'reroute' && e.kind !== 'extend') || !e.plan.crossings.length) return e;
  const plan = endCourseAt(world, d, e.plan, e.plan.crossings[0].from);
  if (plan.blocked) return { blocked: plan.blocked };
  const patch: GuidePatch = { cells: plan.cells, path: encodePath(plan.path) };
  if (T.guide.end) patch.end = null;
  return finish(world, T, e.kind, plan, patch, e.note);
}

// ---------- 分一股出去、加一个源头（第十三轮） ----------

// 分出去的一股从干流上分出来的那一点不能挪
const BRANCH_HEAD = '分出的地方不能挪：删除后重新分';
// 分出去的一股默认分多少水
export const BRANCH_SHARE = 0.3;
export const BRANCH_FROM = '从河上往外画：分出一股';
export const SOURCE_FROM = '从河上往上游画：加源头';

export interface Extra {
  kind: 'branch' | 'source';
  plan: CoursePlan;
  // 分出去的那一格（branch）、源头汇入的那一格（source）
  cell: number;
}

// 画的线开头还在这条河自己的格里的那几点去掉（从河上起笔，在河上多走了几步再离开）：留下离开前的最后一点。
// 返回那一点所在的格与剩下的线；一直在河上时为 null
function leaveRiver(world: World, T: EditTarget, raw: readonly Pt[]): { cell: number; pts: Pt[] } | null {
  const own = new Set(T.own);
  let hint = T.guide.cells[0];
  let last = -1;
  let cell = -1;
  // 按每隔四分之一格的取样点看（画得快时线上只有几个点，两点之间还擦过这条河的格）
  const S = pathSamples(raw, courseStep(world.mesh));
  for (let k = 0; k < S.x.length; k++) {
    hint = findCell(world.mesh, S.x[k], S.y[k], hint);
    if (!own.has(hint)) break;
    last = k;
    cell = hint;
  }
  if (last >= 0) {
    if (last >= S.x.length - 1) return null;
    return { cell, pts: dedupe([[S.x[last], S.y[last]], ...raw.slice(S.seg[last] + 1).map((p) => [p[0], p[1]] as Pt)]) };
  }
  // 第一点吸在河画出来的线上，线擦过的是旁边一格：从离它最近的这条河的格（一格半以内）的格心接出去
  const { mesh } = world;
  let bd = 1.5 * mesh.spacing;
  for (const c of own) {
    const dx = mesh.kind === 'sphere' ? wrapDelta(mesh.x[c] - raw[0][0]) : mesh.x[c] - raw[0][0];
    const dd = Math.hypot(dx, mesh.y[c] - raw[0][1]);
    if (dd < bd && !water(world, world.derived, c)) [bd, cell] = [dd, c];
  }
  if (cell < 0) return null;
  const x = raw[0][0] + (mesh.kind === 'sphere' ? wrapDelta(mesh.x[cell] - raw[0][0]) : mesh.x[cell] - raw[0][0]);
  return { cell, pts: [roundPt([x, mesh.y[cell]]), ...raw.map((p) => [p[0], p[1]] as Pt)] };
}

// 从选中的河 T 上分一股出去：stroke 从河上起笔（第一点吸在河上）画出去，到海、湖、别的河（也可以画回这条河的下游：
// 分出去的水又流回来），陆地上按 opts 接着流或消失。分出的那一格是画的线离开这条河前的最后一格
export function branchCourse(world: World, d: Derived, T: EditTarget, stroke: readonly (readonly [number, number])[], opts: Pick<CourseOptions, 'endOnLand' | 'px'>): Extra | { blocked: string } {
  if (stroke.length < 2) return { blocked: '画得太短' };
  const left = leaveRiver(world, T, stroke.map((p) => [p[0], p[1]] as Pt));
  if (!left) return { blocked: '从河上起笔，往外画' };
  const s = left.cell;
  if (water(world, d, s)) return { blocked: '要从陆地上的河分出去' };
  const start = roundPt(left.pts[0]);
  const input = simplifyStroke(world, left.pts, opts.px);
  if (input.length < 2) return { blocked: '画得太短' };
  input[0] = start;
  const run = (pts: Pt[]) => courseFrom(world, d, { cells: [s], path: [start] }, dedupe(pts), { endOnLand: opts.endOnLand, px: opts.px }, false);
  // 顺着干流的方向分出去（第十三轮）：开头一段从分出的地方顺着干流往下游，渐渐离开干流接到画的线上（不像支流那样直直地横着出去）。
  // 这样画出来的格还要一样能用（不回到干流上、画得出来），不行时退一步（开头的方向取干流与画的方向之间），再不行照画的走
  for (const lead of [1, 0.5]) {
    const pts = tangentStart(world, T, input, lead);
    if (!pts) break;
    const plan = run(pts);
    if (!plan.blocked && plan.cells.length >= 2 && !T.own.includes(plan.cells[1])) return { kind: 'branch', plan, cell: s };
  }
  const plan = run(input);
  if (plan.blocked) return { blocked: plan.blocked };
  if (plan.cells.length < 2) return { blocked: '画得太短' };
  // 第二格又回到这条河上：没分出去
  if (T.own.includes(plan.cells[1])) return { blocked: '从河上起笔，往外画' };
  return { kind: 'branch', plan, cell: s };
}

// 分出去的一股顺着干流分出来的开头：从 input[0]（分出的地方）起，开头的方向是干流在那里往下游的方向（lead 为 1；
// 小于 1 时取它与画的方向之间），用一段三次 Bezier 曲线接到画的线上离起点约 1.2 格的那一点（到那里顺着画的线）。
// 画的方向与干流往下游的方向差得超过 100°（往上游分）时不改，返回 null
const BRANCH_LEAD = 1.2;
export function tangentStart(world: World, T: EditTarget, input: readonly Pt[], lead: number): Pt[] | null {
  const sp = world.mesh.spacing;
  const sphere = world.mesh.kind === 'sphere';
  const P0 = input[0];
  // 干流在那里往下游的方向
  const hit = snapOnto(T.points, P0[0], P0[1], 0, T.points.length - 1, sphere);
  if (!hit) return null;
  const a = T.points[hit.k];
  const b = T.points[hit.k + 1];
  const tl = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!(tl > 0)) return null;
  const td: Pt = [(b[0] - a[0]) / tl, (b[1] - a[1]) / tl];
  // 画的线上离起点约 1.2 格的那一点与那里的方向
  let acc = 0;
  let q = -1;
  let Q: Pt = [P0[0], P0[1]];
  for (let k = 0; k + 1 < input.length; k++) {
    const l = Math.hypot(input[k + 1][0] - input[k][0], input[k + 1][1] - input[k][1]);
    if (acc + l >= BRANCH_LEAD * sp) {
      const t = (BRANCH_LEAD * sp - acc) / l;
      Q = [input[k][0] + (input[k + 1][0] - input[k][0]) * t, input[k][1] + (input[k + 1][1] - input[k][1]) * t];
      q = k;
      break;
    }
    acc += l;
  }
  if (q < 0) return null;
  const ql = Math.hypot(input[q + 1][0] - input[q][0], input[q + 1][1] - input[q][1]) || 1;
  const tq: Pt = [(input[q + 1][0] - input[q][0]) / ql, (input[q + 1][1] - input[q][1]) / ql];
  const D = Math.hypot(Q[0] - P0[0], Q[1] - P0[1]);
  const dir: Pt = [(Q[0] - P0[0]) / (D || 1), (Q[1] - P0[1]) / (D || 1)];
  if (td[0] * dir[0] + td[1] * dir[1] < Math.cos((100 * Math.PI) / 180)) return null;
  let t0: Pt = [td[0] * lead + dir[0] * (1 - lead), td[1] * lead + dir[1] * (1 - lead)];
  const l0 = Math.hypot(t0[0], t0[1]) || 1;
  t0 = [t0[0] / l0, t0[1] / l0];
  const c1: Pt = [P0[0] + (t0[0] * D) / 3, P0[1] + (t0[1] * D) / 3];
  const c2: Pt = [Q[0] - (tq[0] * D) / 3, Q[1] - (tq[1] * D) / 3];
  const out: Pt[] = [[P0[0], P0[1]]];
  const N = 6;
  for (let j = 1; j <= N; j++) {
    const u = j / N;
    const v = 1 - u;
    out.push(
      roundPt([
        v * v * v * P0[0] + 3 * v * v * u * c1[0] + 3 * v * u * u * c2[0] + u * u * u * Q[0],
        v * v * v * P0[1] + 3 * v * v * u * c1[1] + 3 * v * u * u * c2[1] + u * u * u * Q[1],
      ]),
    );
  }
  return dedupe([...out, ...input.slice(q + 1).map((p) => [p[0], p[1]] as Pt)]);
}

// 给选中的河 T 加一个源头：stroke 从河上起笔往外（往上游）画，水从画的线的另一头流进这条河，算作这条河的一部分（同名）
export function sourceCourse(world: World, d: Derived, T: EditTarget, stroke: readonly (readonly [number, number])[], opts: Pick<CourseOptions, 'px'>): Extra | { blocked: string } {
  if (stroke.length < 2) return { blocked: '画得太短' };
  const left = leaveRiver(world, T, stroke.map((p) => [p[0], p[1]] as Pt));
  if (!left) return { blocked: '从河上起笔，往外画' };
  // 倒过来：从画的线的另一头流到这条河上
  const rev = left.pts.slice().reverse();
  const plan = planCourse(world, d, rev, { endOnLand: 'flow', px: opts.px });
  if (plan.blocked) return { blocked: plan.blocked };
  if (plan.reroute) return { blocked: '新的源头不能在别的河上' };
  if (plan.end !== 'river' || !T.own.includes(plan.join)) return { blocked: '要画回这条河上' };
  return { kind: 'source', plan, cell: plan.join };
}

// 改好的河道
export const editedGuide =(T: EditTarget, e: RiverEdit): Guide => applyPatch(T.guide, e.patch);

// 穿过的别的画的河（截走它们）
const editCaptures = (T: EditTarget, e: RiverEdit) => e.plan.crossings.some((x) => x.guide !== null && x.guide !== T.guide.id);

// 改一条河的命令：画的河是 update_guide（同一个 id）；自然的河是 add_guide（固定下来，连同改好的那段，沿用它的地名）
export function editCommand(T: EditTarget, e: RiverEdit, label: string): Command {
  const capture = editCaptures(T, e) ? { capture: true } : {};
  if (!T.natural) {
    // 名字、类型定下来：改了走向也还叫原来的名字、还是原来那一种
    const keep: GuidePatch = {};
    if (T.autoName && T.guide.autoName !== T.autoName) keep.autoName = T.autoName;
    if (T.autoOrig && T.guide.autoOrig !== T.autoOrig) keep.autoOrig = T.autoOrig;
    if (T.ruleType) keep.type = T.ruleType;
    return { op: 'update_guide', id: T.guide.id, patch: { ...e.patch, ...keep }, ...capture, label };
  }
  const { id: _, ...guide } = editedGuide(T, e);
  return { op: 'add_guide', guide, ...capture, label };
}
