// 改画的河（第八十三轮从 core/select.ts 原样搬出）：并入、接上、延长、改道、终点与提醒、河干
import { type CoursePlan, type Pt, type CourseOptions, emptyPlan, isRiverCell, type CourseEnd } from './course-base';
import { type Guide, type World, type Derived, COURSE_MAX_POINTS } from './world';
import type { GuidePatch } from './commands';
import { decodePath, roundPathValue, encodePath, dedupePoints as dedupe, segProject, guidePoints, roundPoint as roundPt, ownsCell, stemPath } from './rivers';
import { findCell } from './mesh';
import { simplifyStroke, traceCourse, cutLoop, flowsBack, TOO_LONG, crossingsOf, courseEstimates, courseFrom, cutAt } from './course-plan';

// 汇进一条画的、有泉水的河的源头（plan.merge）：成为它的上游，名字、大小照旧。返回 update_guide 的 patch
export function mergeCourse(plan: CoursePlan, g: Guide): GuidePatch {
  let tail = g.path ? decodePath(g.path) : [];
  // 整个星球：接上去的那段整圈地挪到画的线这一份（平面上挪 0）
  const shift = tail.length && plan.path.length ? 2 * Math.round((plan.path[plan.path.length - 1][0] - tail[0][0]) / 2) : 0;
  if (shift) tail = tail.map(([x, y]) => [roundPathValue(x + shift), y]);
  return { cells: [...plan.cells.slice(0, -1), ...g.cells], path: encodePath(dedupe([...plan.path, ...tail])) };
}

// 点在折线上的投影：第几段、段上的位置、距离、从起点量起的长度
export function projectOn(pts: readonly Pt[], x: number, y: number): { seg: number; t: number; d: number; along: number; p: Pt } {
  let best = { seg: 0, t: 0, d: Infinity, along: 0, p: pts[0] };
  let acc = 0;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k];
    const [bx, by] = pts[k + 1];
    const len = Math.hypot(bx - ax, by - ay);
    const r = segProject(x, y, ax, ay, bx, by);
    if (r.d < best.d) best = { seg: k, t: r.t, d: r.d, along: acc + r.t * len, p: [ax + (bx - ax) * r.t, ay + (by - ay) * r.t] };
    acc += len;
  }
  return best;
}

// 改一段：在画好的河 g 上按住重画。stroke 的两端都在河上（离折线 tol 以内）时替换中间那段，
// 前后两段的格与折线都不变；只有起点在河上时替换从起点往下的整段（终点照常处理）。从下游往上游画的倒过来。
// 名字、大小等都留着（只改 cells、path，以及终点）
export function spliceCourse(
  world: World,
  d: Derived,
  g: Guide,
  stroke: readonly (readonly [number, number])[],
  opts: CourseOptions & { tol: number },
): { patch: GuidePatch; plan: CoursePlan } | { blocked: string } {
  const { mesh, causes } = world;
  if (stroke.length < 2) return { blocked: '画得太短' };
  const P0 = guidePoints(world, g);
  if (P0.length < 2) return { blocked: '这里改不了' };
  let raw = stroke.map((p) => [p[0], p[1]] as Pt);
  // 整个星球：画的线整圈地挪到折线所在的那一份
  if (mesh.kind === 'sphere') {
    let best = 0;
    let bd = Infinity;
    for (const s of [-4, -2, 0, 2, 4]) {
      const dd = projectOn(P0, raw[0][0] + s, raw[0][1]).d;
      if (dd < bd) {
        bd = dd;
        best = s;
      }
    }
    if (best) raw = raw.map(([x, y]) => [x + best, y]);
  }
  let p0 = projectOn(P0, raw[0][0], raw[0][1]);
  if (p0.d > opts.tol) return { blocked: '要从河上开始画' };
  let pe = projectOn(P0, raw[raw.length - 1][0], raw[raw.length - 1][1]);
  const middle = pe.d <= opts.tol && Math.abs(pe.along - p0.along) >= mesh.spacing;
  if (middle && pe.along < p0.along) {
    raw = raw.reverse();
    [p0, pe] = [pe, p0];
  }
  const C = g.cells;
  // 投影点所在的格要在河道上；不在（没有折线的河道的格心连线擦过别的格）就挪到最近的折点
  const indexOf = (p: { seg: number; t: number; p: Pt }): { k: number; p: Pt } => {
    const r = roundPt(p.p);
    const k = C.indexOf(findCell(mesh, r[0], r[1]));
    if (k >= 0) return { k, p: r };
    const v = P0[p.t < 0.5 ? p.seg : p.seg + 1];
    return { k: C.indexOf(findCell(mesh, v[0], v[1])), p: v };
  };
  const a = indexOf(p0);
  if (a.k < 0) return { blocked: '这里改不了' };
  const water = (i: number) => !causes.land[i] || d.lake[i] === 1;
  const prefixPath = dedupe([...P0.slice(0, p0.seg + 1), a.p]);
  // 新画的一段少用点：接上前后不动的两段后不超过能存的点数
  const keep = middle ? P0.length - (pe.seg - p0.seg) + 2 : p0.seg + 2;
  const drawn = simplifyStroke(world, raw, opts.px, COURSE_MAX_POINTS - keep);
  const sub = { ...opts, ignoreGuide: g.id };

  if (middle) {
    const b = indexOf(pe);
    if (b.k <= a.k) return { blocked: '这一段太短' };
    let Q = dedupe([a.p, ...drawn.slice(1, -1), b.p]);
    let t = traceCourse(world, Q, C.slice(0, a.k + 1), water);
    // 新画的一段自己绕了圈：剪掉（碰到前面不动的那段就画不了）
    for (let iter = 0; t.loop && iter < 40; iter++) {
      const next = cutLoop(Q, t, a.k + 1);
      if (!next) return { blocked: '新画的一段碰到了河自己' };
      Q = next;
      t = traceCourse(world, Q, C.slice(0, a.k + 1), water);
    }
    const suffix = C.slice(b.k);
    const lastIn = t.cells[t.cells.length - 1];
    const clean = !t.loop && t.stop < 0 && lastIn === C[b.k];
    if (clean) {
      const mid = t.cells.slice(a.k + 1, -1);
      const tail = new Set(suffix);
      if (mid.some((c) => tail.has(c))) return { blocked: '新画的一段碰到了河自己' };
      const cells = [...C.slice(0, a.k + 1), ...mid, ...suffix];
      // 这条河汇入的河、流进的湖往下流会经过新画的一段：水会绕成圈
      if (flowsBack(world, d, cells[cells.length - 1], new Set(mid))) return { blocked: '这样水会绕成圈' };
      // 后面不动的那段：原来画的折线到哪里，改后也到哪里（再往后照旧是顺地势流下去的那段）；
      // 改到了流下去的那段里时，后面的点也存下来，画出来不动
      const nPath = g.path ? g.path.length / 2 : P0.length;
      const path = dedupe([...prefixPath, ...Q.slice(1), ...P0.slice(pe.seg + 1, pe.seg + 1 < nPath ? nPath : P0.length)]);
      if (path.length > COURSE_MAX_POINTS) return { blocked: TOO_LONG };
      const plan: CoursePlan = { ...emptyPlan(), cells, path, drawn: cells.length - 1, end: endKind(world, d, g, cells), join: -1 };
      plan.join = plan.end === 'river' ? cells[cells.length - 1] : -1;
      const old = new Set(C);
      plan.crossings = crossingsOf(world, d, cells, a.k + 1, a.k + 1 + mid.length, (c) => old.has(c), g.id);
      const est = courseEstimates(world, d.elevation, cells, g.end === 'sink');
      plan.gorge = est.gorge;
      plan.uphill = est.uphill;
      return { patch: { cells, path: encodePath(path) }, plan };
    }
    // 中途进了海、湖，或者没回到河上：当作替换从起点往下的整段
  }
  const Q = dedupe([a.p, ...drawn.slice(1)]);
  const plan = courseFrom(world, d, { cells: C.slice(0, a.k + 1), path: prefixPath }, Q, sub, false);
  if (plan.blocked) return { blocked: plan.blocked };
  const patch: GuidePatch = { cells: plan.cells, path: encodePath(plan.path) };
  if (plan.end === 'sink') patch.end = 'sink';
  else if (g.end) patch.end = null;
  return { patch, plan };
}

// 在画到的地方消失的河改成“接着流”：从画到的那格起顺着地势流下去（与画的时候选“画完接着流”一样，
// 流下去的那段也是这条河的格），画的折线不动。返回 update_guide 的 patch
export function continueCourse(world: World, d: Derived, g: Guide): { patch: GuidePatch; plan: CoursePlan } | { blocked: string } {
  if (!g.path) return { blocked: '这里改不了' };
  const pts = decodePath(g.path);
  const last = pts[pts.length - 1];
  const m = g.cells.indexOf(findCell(world.mesh, last[0], last[1], g.cells[g.cells.length - 1]));
  if (m < 1) return { blocked: '这里改不了' };
  const plan = courseFrom(world, d, { cells: g.cells.slice(0, m + 1), path: pts }, [last], { endOnLand: 'flow', ignoreGuide: g.id }, false);
  if (plan.blocked) return { blocked: plan.blocked };
  return { patch: { cells: plan.cells, end: null }, plan };
}

// 往下游接着画：从哪条画的河的哪一格（g.cells 的下标）接上。在终点消失的河的终点；画完接着流的河画的线的末端
// （之后顺地势流下去的那段换成新画的）。汇入别的河、入海、进湖的终点不算（那一格是别的河、海、湖的）
export function extendPoint(world: World, cell: number): { guide: Guide; k: number } | null {
  if (cell < 0) return null;
  const { mesh } = world;
  for (let n = world.small.guides.length - 1; n >= 0; n--) {
    const g = world.small.guides[n];
    const last = g.cells.length - 1;
    if (g.end === 'sink' && g.cells[last] === cell) return { guide: g, k: last };
    if (!g.path) continue;
    const pts = decodePath(g.path);
    const [x, y] = pts[pts.length - 1];
    const m = g.cells.indexOf(findCell(mesh, x, y, g.cells[last]));
    if (m >= 1 && m < last && g.cells[m] === cell && world.causes.land[cell] && world.derived.lake[cell] !== 1) return { guide: g, k: m };
  }
  return null;
}

// 从一条画的河的终点（extendPoint）起笔：接长这条河（update_guide：格、折线接上，终点换成这一笔的终点；
// 名字、大小、类型、泉水都不变）。从海、湖往这一点画的倒过来。起点不是这样的一点时为 null
export function extendCourse(
  world: World,
  d: Derived,
  stroke: readonly (readonly [number, number])[],
  opts: CourseOptions,
): { guide: Guide; patch: GuidePatch; plan: CoursePlan } | { guide: Guide; blocked: string } | null {
  const { mesh, causes } = world;
  if (stroke.length < 2) return null;
  const water = (i: number) => !causes.land[i] || d.lake[i] === 1;
  let raw = stroke.map((p) => [p[0], p[1]] as Pt);
  if (mesh.kind === 'plane') {
    const [x, y] = raw[0];
    if (x < 0 || y < 0 || x > mesh.width || y > mesh.height) return null;
  }
  const first = findCell(mesh, raw[0][0], raw[0][1]);
  const lastCell = findCell(mesh, raw[raw.length - 1][0], raw[raw.length - 1][1]);
  const reversed = water(first) && !water(lastCell);
  if (reversed) raw = raw.reverse();
  const at = extendPoint(world, reversed ? lastCell : first);
  if (!at) return null;
  const g = at.guide;
  const C = g.cells;
  const P0 = guidePoints(world, g);
  // 不动的那段折线：到接上的第 k 格为止（最后一点在那一格里）
  const baseTo = (k: number): Pt[] => endIn(world, k === C.length - 1 ? P0 : k === at.k ? decodePath(g.path!) : pointsTo(world, C, P0, k), C[k]);
  const plan = continueFrom(world, d, C, at.k, baseTo, raw, { ...opts, ignoreGuide: g.id }, reversed);
  if (plan.blocked) return { guide: g, blocked: plan.blocked };
  const patch: GuidePatch = { cells: plan.cells, path: encodePath(plan.path) };
  if (plan.end === 'sink') patch.end = 'sink';
  else if (g.end) patch.end = null;
  return { guide: g, patch, plan };
}

// 控制点 P0（河道 C 的）截到第 k 格为止
export function pointsTo(world: World, C: readonly number[], P0: Pt[], k: number): Pt[] {
  const t = traceCourse(world, P0, [], () => false);
  const j = t.at.findIndex((a) => t.cells[a] === C[k]);
  return j >= 0 ? cutAt(world, P0, t, j).pts : P0.slice(0, 1);
}

// 折线的最后一点要在 cell 里：不在时补上那一格的格心（整个星球上挪到折线末端那一份）
export function endIn(world: World, base: Pt[], cell: number): Pt[] {
  const { mesh } = world;
  const tail = base[base.length - 1];
  if (tail && findCell(mesh, tail[0], tail[1], cell) === cell) return base;
  const ref = tail ? tail[0] : mesh.x[cell];
  return dedupe([...base, roundPt([mesh.x[cell] + 2 * Math.round((ref - mesh.x[cell]) / 2) * (mesh.kind === 'sphere' ? 1 : 0), mesh.y[cell]])]);
}

// 从河道 C 的第 k 格接着画 raw（已经倒好方向）：C 的前 k + 1 格与它们的折线（baseTo(k)）不动，之后照着画的走。
// 刚起笔就擦过第 k 格前的一两格（格是斜着排的，从河上往旁边画常常这样）：从擦过的那一格接上，它后面原来的那一小段换成新画的
export function continueFrom(world: World, d: Derived, C: readonly number[], k0: number, baseTo: (k: number) => Pt[], raw: Pt[], opts: CourseOptions, reversed: boolean): CoursePlan {
  const { mesh, causes } = world;
  const water = (i: number) => !causes.land[i] || d.lake[i] === 1;
  let k = k0;
  let base = baseTo(k);
  // 整个星球：画的线整圈地挪到折线末端所在的那一份
  if (mesh.kind === 'sphere') {
    const shift = 2 * Math.round((base[base.length - 1][0] - raw[0][0]) / 2);
    if (shift) raw = raw.map(([x, y]) => [x + shift, y]);
  }
  const room = COURSE_MAX_POINTS - base.length;
  if (room < 2) return { ...emptyPlan(), reversed, blocked: TOO_LONG };
  let input = simplifyStroke(world, raw, opts.px, room);
  if (input.length < 2) return { ...emptyPlan(), reversed, blocked: '画得太短' };
  for (let iter = 0; iter < 3; iter++) {
    // 折线：从不动的那段的末端接到画的线的第一点（两点在同一格里，连线不出这一格），再照着画的走
    const Q = dedupe([base[base.length - 1], ...input]);
    const t = traceCourse(world, Q, C.slice(0, k + 1), water);
    const L = t.loop;
    if (!L || L.k >= k || L.k < Math.max(1, k - 3) || t.cells.length - (k + 1) > 3) break;
    const c = C[L.k];
    let p = roundPt([t.x[L.j], t.y[L.j]]);
    if (findCell(mesh, p[0], p[1], c) !== c) p = roundPt([mesh.x[c] + (mesh.kind === 'sphere' ? 2 * Math.round((t.x[L.j] - mesh.x[c]) / 2) : 0), mesh.y[c]]);
    k = L.k;
    base = baseTo(k);
    input = [p, ...Q.slice(t.seg[L.j] + 1)];
  }
  return courseFrom(world, d, { cells: C.slice(0, k + 1), path: base }, dedupe([base[base.length - 1], ...input]), opts, reversed);
}

// 从一条河中间起笔（不是画的河的源头、不是画的河能接长的终点）：这条河从源头到起笔的那一格不动，从那里改走画的路线，
// 还是同一条河。画的河：改这条河道（update_guide 的 patch：格、折线、终点；名字、大小、类型都照旧）；
// 自然的河：主干从源头到这一格加上新画的一段，固定成一条画的河（像“固定这条河”，沿用它的地名）。
// 起笔不在河上、在画的河的源头（重画整条，见 planCourse）、在自然的河的源头时为 null
export function rerouteCourse(
  world: World,
  d: Derived,
  stroke: readonly (readonly [number, number])[],
  opts: CourseOptions,
): { guide: Guide | null; plan: CoursePlan; patch: GuidePatch } | null {
  const { mesh, causes } = world;
  if (stroke.length < 2) return null;
  const water = (i: number) => !causes.land[i] || d.lake[i] === 1;
  let raw = stroke.map((p) => [p[0], p[1]] as Pt);
  if (mesh.kind === 'plane') {
    const [x, y] = raw[0];
    if (x < 0 || y < 0 || x > mesh.width || y > mesh.height) return null;
  }
  const first = findCell(mesh, raw[0][0], raw[0][1]);
  const lastCell = findCell(mesh, raw[raw.length - 1][0], raw[raw.length - 1][1]);
  const reversed = water(first) && !water(lastCell);
  if (reversed) raw = raw.reverse();
  const start = reversed ? lastCell : first;
  if (!isRiverCell(world, d, start) || extendPoint(world, start)) return null;
  let g: Guide | null = null;
  let k = -1;
  for (let n = world.small.guides.length - 1; n >= 0 && !g; n--) {
    const x = world.small.guides[n];
    const i = x.cells.indexOf(start);
    if (i >= 0 && ownsCell(x, i)) {
      g = x;
      k = i;
    }
  }
  let C: readonly number[];
  let baseTo: (k: number) => Pt[];
  let own: number[];
  if (g) {
    if (k === 0) return null;
    const G = g;
    C = G.cells;
    const P0 = guidePoints(world, G);
    baseTo = (j) => endIn(world, pointsTo(world, C, P0, j), C[j]);
    own = C.filter((_, i) => ownsCell(G, i));
  } else {
    const stem = riverStem(world, d, start);
    k = stem.cells.indexOf(start);
    if (k <= 0) return null;
    C = stem.cells;
    baseTo = (j) => endIn(world, decodePath(stemPath(world, C.slice(0, j + 1))), C[j]);
    own = stem.end === 'river' ? C.slice(0, -1) : C.slice();
  }
  const plan = continueFrom(world, d, C, k, baseTo, raw, { ...opts, ...(g ? { ignoreGuide: g.id } : {}), reroute: { own } }, reversed);
  const patch: GuidePatch = { cells: plan.cells, path: encodePath(plan.path) };
  if (plan.end === 'sink') patch.end = 'sink';
  else if (g?.end) patch.end = null;
  return { guide: g, plan, patch };
}

// 一条河道现在流到哪里（不看画的线，只看格）
export function endKind(world: World, d: Derived, g: Guide, cells: readonly number[]): CourseEnd | null {
  const e = guideEnd(world, d, { ...g, cells: [...cells] });
  return e.kind === 'unknown' ? null : e.kind;
}

// 一条画的河现在流到哪里：入海、流进湖、汇入别的河（cell 是汇合的那一格）、流出地图、在终点消失；
// 都不是时为 unknown（水流不出去）。按现在的流向看，所以地形改了之后也是真的
export function guideEnd(world: World, d: Derived, g: Guide): { kind: CourseEnd | 'unknown'; cell: number } {
  const { mesh, causes } = world;
  const thr = world.small.planet.riverThreshold;
  const cells = g.cells;
  for (const c of cells) if (!causes.land[c]) return { kind: 'sea', cell: c };
  const last = cells[cells.length - 1];
  if (g.end === 'sink') return { kind: 'sink', cell: last };
  const mine = new Set(cells);
  // 从终点顺流往下：除了这条河流来的水，别处流进来的也够一条河（汇入别的河、接上一条河的源头），就是汇合处
  for (let c = last, prev = cells[cells.length - 2], guard = 0; guard < mesh.n; guard++) {
    if (d.lake[c] === 1) return { kind: 'lake', cell: c };
    if (isRiverCell(world, d, c) && d.discharge[c] - d.discharge[prev] >= thr) return { kind: 'river', cell: c };
    const r = d.receiver[c];
    if (r < 0) return { kind: mesh.boundary[c] === 1 ? 'edge' : 'unknown', cell: c };
    if (!causes.land[r]) return { kind: 'sea', cell: r };
    if (mine.has(r)) return { kind: 'unknown', cell: c };
    mine.add(r);
    prev = c;
    c = r;
  }
  return { kind: 'unknown', cell: last };
}

// 河流列表、底部条上的提醒：text 是一句短话，why 是悬停时说的原因，cells 是出问题的那几格（点一下在地图上标出来）
export interface GuideIssue {
  text: string;
  why: string;
  cells: number[];
}

// 河流列表里的提醒（只要短话）
export function guideWarnings(world: World, d: Derived, g: Guide): string[] {
  return guideIssues(world, d, g).map((x) => x.text);
}

export function guideIssues(world: World, d: Derived, g: Guide): GuideIssue[] {
  const { causes } = world;
  const land = causes.land;
  const thr = world.small.planet.riverThreshold;
  const cells = g.cells;
  const out: GuideIssue[] = [];
  const sea = cells.slice(0, -1).filter((c) => !land[c]);
  if (sea.length) out.push({ text: '有一段在海里', why: '有几格成了海：水在那里入海', cells: sea });
  // 没按画的走的那一段：从水第一次不流向河道下一格的地方起，到又回到河道上为止
  let off: number[] = [];
  let dry = false;
  for (let k = 0; k + 1 < cells.length && land[cells[k]]; k++) {
    const c = cells[k];
    if (d.receiver[c] !== cells[k + 1] && !off.length) {
      off = [c];
      for (let j = k + 1; j < cells.length && land[cells[j]] && d.receiver[cells[j - 1]] !== cells[j]; j++) off.push(cells[j]);
    }
    if (d.lake[c] !== 1 && d.discharge[c] < thr) dry = true;
  }
  if (off.length) {
    // 为什么：后画的河从这里经过（截走了它）、流进了湖，还是照画的走水会绕成圈（那几格按地势流）
    const later = world.small.guides.slice(world.small.guides.findIndex((x) => x.id === g.id) + 1);
    const taker = later.find((x) => x.cells.some((c, i) => ownsCell(x, i) && c === off[0]));
    const why = taker
      ? `这里被后画的“${taker.name || '另一条河'}”截走了：重画这一段，或改那条河`
      : d.lake[off[0]] === 1
        ? '这一段成了湖：水从湖的出口流出'
        : '照画的走会绕回自己，这几格按地势流：重画这一段';
    out.push({ text: '有一段没按画的走', why, cells: off });
  }
  if (g.spring && dry) out.push({ text: '有一段水被截走了', why: '上游被别的河截走，几格没有水', cells: cells.filter((c) => land[c] && d.lake[c] !== 1 && d.discharge[c] < thr) });
  if (guideEnd(world, d, g).kind === 'unknown') out.push({ text: '水流不出去', why: '终点后流不到海、湖或别的河：画过去，或选“终点：停在这”', cells: [cells[cells.length - 1]] });
  return out;
}

// 河的大小（“河流多少”门槛的几倍）：total 是终点前那格的流量，natural 是去掉这条河自己加的水之后的。
// 定大小时存 flow = max(1.2, 目标 − natural)，拖到的就是这条河的总水量。
// 这条河上分出去几股（第十三轮）：total 算上分出去的水（分出的地方的总水量，不是分走以后剩下的），
// split 是分出去的占分出的地方的多少（几股加起来；没有分出去时为 0）。分出去又流回这条河的不算
export function guideFlow(world: World, d: Derived, g: Guide): { total: number; natural: number; split: number } {
  const land = world.causes.land;
  const thr = world.small.planet.riverThreshold;
  let k = 0;
  while (k + 2 < g.cells.length && land[g.cells[k + 1]]) k++;
  const { added, split } = branchedOff(world, d, g.cells.slice(0, k + 1));
  const total = (d.discharge[g.cells[k]] + added) / thr;
  const own = g.spring && land[g.cells[0]] ? Math.max(1.2, g.flow ?? 1.2) : 0;
  return { total, natural: Math.max(0, total - own), split };
}

// 从这一串格（一条河从上往下）上分出去的水：added 是分走的（m³/s，流回这一串格的不算），split 是分走的占分出的地方的多少
export function branchedOff(world: World, d: Derived, cells: readonly number[]): { added: number; split: number } {
  const pos = new Map<number, number>();
  cells.forEach((c, i) => pos.set(c, i));
  let added = 0;
  let split = 0;
  for (const b of world.small.guides) {
    if (!b.branch || b.cells.length < 2) continue;
    const at = pos.get(b.cells[0]);
    if (at === undefined || at >= cells.length - 1) continue;
    // 分出去又流回来（汇回这一串格的下游）：水回到这条河上
    const back = b.cells.slice(1).some((c) => (pos.get(c) ?? -1) > at);
    if (back) continue;
    const q = b.branch.share * d.discharge[b.cells[0]];
    added += q;
    split += b.branch.share;
  }
  return { added, split };
}

// 一条自然的河的主干（选中、固定时用）：从这一格往上沿最大的支流到源头，往下沿干流到海、湖、地图边、
// 消失的地方，或者到汇入更大的河（含那一格，end 为 river、join 为它）。碰到画的河也停在那里
export function riverStem(world: World, d: Derived, cell: number): { cells: number[]; end: CourseEnd | null; join: number } {
  const { mesh, causes } = world;
  const thr = world.small.planet.riverThreshold;
  if (cell < 0 || !isRiverCell(world, d, cell)) return { cells: [], end: null, join: -1 };
  // 画的河自己的格（它汇入的那一格是这条自然的河的，不算：画的支流汇进来，主干照样穿过汇合处）
  const owned = new Uint8Array(mesh.n);
  for (const g of world.small.guides) g.cells.forEach((c, i) => ownsCell(g, i) && (owned[c] = 1));
  // 最大的支流（下游是它、流量够、不是湖；画的河不算，它是汇进来的支流）
  const biggest = (c: number) => {
    let best = -1;
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
      const j = mesh.adj[e];
      if (d.receiver[j] !== c || !causes.land[j] || d.lake[j] === 1 || d.discharge[j] < thr || owned[j]) continue;
      if (best < 0 || d.discharge[j] > d.discharge[best] || (d.discharge[j] === d.discharge[best] && j < best)) best = j;
    }
    return best;
  };
  const seen = new Set([cell]);
  const up: number[] = [];
  for (let c = cell, guard = 0; guard < mesh.n; guard++) {
    const j = biggest(c);
    if (j < 0 || owned[j] || seen.has(j)) break;
    up.push(j);
    seen.add(j);
    c = j;
  }
  const cells = [...up.reverse(), cell];
  for (let c = cell, guard = 0; guard < mesh.n; guard++) {
    const r = d.receiver[c];
    if (r < 0) return { cells, end: mesh.boundary[c] === 1 ? 'edge' : 'sink', join: -1 };
    if (seen.has(r)) break;
    cells.push(r);
    seen.add(r);
    if (!causes.land[r]) return { cells, end: 'sea', join: -1 };
    if (d.lake[r] === 1) return { cells, end: 'lake', join: -1 };
    if (owned[r] || biggest(r) !== c) return { cells, end: 'river', join: r };
    c = r;
  }
  return { cells, end: null, join: -1 };
}
