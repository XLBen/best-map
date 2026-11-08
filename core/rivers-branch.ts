// 三角洲分出去的几股（第八十三轮从 core/rivers.ts 原样搬出）
import type { World } from './world';
import type { DisplayCoast } from './display';
import { type RiverLine, type Pt, backAlong, riverWidth, markJoin, lineLength, dirAt, hermite, maxTurn, before, TURN_CHORD, MOUTH_MAX_TURN, snapOnto, segCross } from './rivers-line';
import { deltaMouths, DELTA_DRAW } from './delta';
import { MOUTH_SEP } from './rivers-mouth';
import { memoActive, keyStart, keyAdd, keyAddPts, memoPeek, MISS, memoMissStart, memoPut } from './coast-memo';
import { seawardNormal, circleShores, byPrefer, allLand } from './rivers-shore';

// ---------- 三角洲的分汊（第三十三轮，只改画法） ----------
// 三角洲的河口（core/delta.ts 的 deltaMouths：大河、河口压成了三角洲平原）、流量至少是门槛的 8 倍的自然的河，
// 在河口往回约 1.6–2.4 格处分出 1–4 股（连主流 2–5 股，流量每翻一倍多一股），各自沿岸线的法向入海：
// 河口落在岸线上离主流的河口约 0.8、1.5 格（左右交替）的地方（shoreOnCircle），用三次 Hermite 曲线从分汊处顺着主流的方向弯过去
// （hermite，终点沿 seawardNormal）。每一股都要在陆地上、不急转、不与别的河相交、离别的河口至少 0.6 格，不然不画这一股。
// 主流留 40–60% 的水（按河口那格定），其余的平分给分出去的几股；主流在分汊以后画细一些（粗细倍数）。
// 分出去的线的格都是主流河口那一格（点它选中主流），branch 记着主流的下标，入海（mouth），不是源头
const BRANCH_BACK = [1.6, 2.4];
const BRANCH_RADII = [0.8, 0.8, 1.5, 1.5];
const BRANCH_MAX = 4;
// 分出去的一股最后六成离主流至少这么远（格）：两条带子不贴在一起
const BRANCH_GAP = 0.3;

export function withBranches(world: World, f: DisplayCoast, lines: RiverLine[]): RiverLine[] {
  const mouths = deltaMouths(world);
  if (!mouths.length) return lines;
  const at = new Set(mouths);
  const thr = world.small.planet.riverThreshold;
  const out: RiverLine[] = [];
  // 已有的河口（各股的河口离它们至少 MOUTH_SEP 格）
  const ends = new PointGrid(MOUTH_SEP * world.mesh.spacing);
  for (const l of lines) if (l.mouth && l.points.length) ends.add(l.points[l.points.length - 1]);
  // 每条线的外接框（找附近的线、可能相交的线时先按框筛：框不挨着的一定没有点在附近、一定不相交）
  const boxes = lines.map(boxOfPts);
  const made: Box[] = [];
  lines.forEach((M, mi) => {
    if (M.guide !== undefined || !M.mouth || !M.cells?.length || M.points.length < 3) return;
    const c = M.cells[M.cells.length - 1];
    if (!at.has(c)) return;
    const q = M.flow[M.flow.length - 1];
    if (!(q >= DELTA_DRAW.FLOW * thr)) return;
    const want = Math.min(BRANCH_MAX, 1 + Math.floor(Math.log2(q / (DELTA_DRAW.FLOW * thr))));
    const got = branchesOf(world, f, lines, boxes, M, mi, c, want, ends, out, made);
    for (const b of got) {
      out.push(b);
      made.push(boxOfPts(b));
    }
  });
  return out.length ? [...lines, ...out] : lines;
}

type Box = [number, number, number, number];
function boxOfPts(l: { points: readonly (readonly [number, number])[] }): Box {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of l.points) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  return [x0, x1, y0, y1];
}
const boxesMeet = (a: Box, b: Box) => a[0] <= b[1] && b[0] <= a[1] && a[2] <= b[3] && b[2] <= a[3];

// 一条河的几股：成了的（至少一股）才改主流（分汊处记进 joins，之后变细）
// 分汊的几何（在哪一处分、成了哪几股）跨几次描河记下来（第三十三轮提速）：它只取决于主流的点、河口那格、想分几股、
// 画面上的海岸场（记下读到的格，见 core/coast-memo.ts）与几样“问别处”的答案——已有的河口在不在附近、附近别的河的线与这一股相不相交、
// 这一次已经分出去的几股与它相不相交。问过的都记在 log 里，下一次描河时照样再问一遍（按那时的 ends、lines、made），
// 答得都一样才用记下的（算的过程一样，结果就逐位相同）。流量、粗细、joins 每次照常改
const Q_BRANCH = 8;
interface BranchAsk {
  // 0：ends.near(p[0])；1：附近别的河的线与 p 相交；2：这一次已经分出去的几股与 p 相交
  kind: number;
  p: Pt[];
  r: boolean;
}
interface BranchPlan {
  // 在 BRANCH_BACK 的第几个分汊处分（−1 不分）
  back: number;
  got: { pts: Pt[]; end: Pt }[];
  log: BranchAsk[];
}

function branchesOf(world: World, f: DisplayCoast, lines: RiverLine[], boxes: Box[], M: RiverLine, mi: number, c: number, want: number, ends: PointGrid, made: RiverLine[], madeBoxes: Box[]): RiverLine[] {
  const sp = world.mesh.spacing;
  const P = M.points;
  let plan: BranchPlan;
  if (memoActive()) {
    keyStart(Q_BRANCH);
    keyAdd(c);
    keyAdd(want);
    keyAddPts(P, 0, P.length);
    const m = memoPeek(f);
    if (m !== MISS && planHolds(m as BranchPlan, lines, boxes, M, ends, made, madeBoxes, sp)) plan = m as BranchPlan;
    else {
      memoMissStart();
      plan = planBranches(world, f, lines, boxes, M, c, want, ends, made, madeBoxes, []);
      memoPut(f, plan);
    }
  } else plan = planBranches(world, f, lines, boxes, M, c, want, ends, made, madeBoxes, null);
  if (plan.back < 0) return [];
  const S = backAlong(P, BRANCH_BACK[plan.back] * sp);
  const got = plan.got.map((g) => ({ pts: g.pts.map((p) => [p[0], p[1]] as Pt), end: [g.end[0], g.end[1]] as Pt }));
  // 主流：分汊以后的水只剩 share，画细一些
  const share = 0.4 + 0.2 * unitHash(c);
  const q = M.flow[M.flow.length - 1];
  const each = (1 - share) / got.length;
  const k0 = S.k + 1;
  const ratio = riverWidth(q * share, world.small.planet.riverThreshold) / riverWidth(q, world.small.planet.riverThreshold);
  const mul = M.mul ? M.mul.slice() : M.points.map(() => 1);
  for (let k = k0; k < P.length; k++) {
    M.flow[k] *= share;
    mul[k] *= ratio;
  }
  M.mul = mul;
  markJoin(M, S.k + S.t);
  for (const g of got) ends.add(g.end);
  return got.map((g) => {
    const points: Pt[] = [[S.p[0], S.p[1]], ...g.pts];
    const line: RiverLine = { points, flow: points.map(() => q * each), cells: points.map(() => c), mouth: true, branch: mi };
    if (M.type) {
      const t = M.type[M.type.length - 1];
      line.type = points.map(() => t);
    }
    return line;
  });
}

// 记下的分汊：按现在的已有河口、别的河、已经分出去的几股再问一遍，答得都与记下的一样
function planHolds(plan: BranchPlan, lines: RiverLine[], boxes: Box[], M: RiverLine, ends: PointGrid, made: RiverLine[], madeBoxes: Box[], sp: number): boolean {
  for (const a of plan.log) {
    const r = a.kind === 0 ? ends.near(a.p[0]) : a.kind === 1 ? crossesNearLines(a.p, lines, boxes, M, sp) : crossesMade(a.p, made, madeBoxes);
    if (r !== a.r) return false;
  }
  return true;
}

// 分汊的几何：在哪一处分、成了哪几股（log 不为 null 时记下问别处的答案）
function planBranches(world: World, f: DisplayCoast, lines: RiverLine[], boxes: Box[], M: RiverLine, c: number, want: number, ends: PointGrid, made: RiverLine[], madeBoxes: Box[], log: BranchAsk[] | null): BranchPlan {
  const none: BranchPlan = { back: -1, got: [], log: log ?? [] };
  const sp = world.mesh.spacing;
  const P = M.points;
  const E = P[P.length - 1];
  const nE = seawardNormal(world, f, E, c);
  if (!nE) return none;
  const tangent: Pt = [-nE[1], nE[0]];
  const total = lineLength(P);
  // 各股河口的候选（只取决于主流的河口，两种分汊的位置共用）与那里岸线的法向
  // （同一个半径的圆只找一次交点，左右两侧共用）
  const cands: (Pt | undefined)[] = new Array(BRANCH_RADII.length);
  const circles = new Map<number, { hi: number; p: Pt }[]>();
  const normals = new Map<Pt, Pt | null>();
  for (let bi = 0; bi < BRANCH_BACK.length; bi++) {
    const back = BRANCH_BACK[bi];
    if (back * sp > 0.6 * total) continue;
    const S = backAlong(P, back * sp);
    const tS = dirAt(P, Math.min(P.length - 1, S.k + 1));
    const got: { pts: Pt[]; end: Pt }[] = [];
    const taken: Pt[] = [];
    for (let b = 0; b < BRANCH_RADII.length && got.length < want; b++) {
      const side = b % 2 === 0 ? 1 : -1;
      const prefer: Pt = [tangent[0] * side, tangent[1] * side];
      if (!(b in cands)) {
        const R = BRANCH_RADII[b];
        if (!circles.has(R)) circles.set(R, circleShores(world, f, E, R * sp, c));
        cands[b] = byPrefer(circles.get(R)!, prefer)[0];
      }
      const T = cands[b];
      if (!T) continue;
      // 只要在 prefer 那一侧（与河口的法向夹角不到 100°）
      const vx = T[0] - E[0];
      const vy = T[1] - E[1];
      if (vx * prefer[0] + vy * prefer[1] <= 0.2 * Math.hypot(vx, vy)) continue;
      const near = ends.near(T);
      log?.push({ kind: 0, p: [T], r: near });
      if (near || nearAny(taken, T, MOUTH_SEP * sp)) continue;
      if (!normals.has(T)) normals.set(T, seawardNormal(world, f, T, c));
      const pts = branchPath(world, f, lines, boxes, M, S, tS, T, normals.get(T)!, c, got.map((g) => g.pts), made, madeBoxes, log);
      if (!pts) continue;
      got.push({ pts, end: T });
      taken.push(T);
    }
    if (!got.length) continue;
    return { back: bi, got, log: log ?? [] };
  }
  return none;
}

// 一股的线（不含分汊那一点）：在陆地上、不急转、不与别的线相交、离主流够远，不然 null
function branchPath(
  world: World,
  f: DisplayCoast,
  lines: RiverLine[],
  boxes: Box[],
  M: RiverLine,
  S: { k: number; t: number; p: Pt },
  tS: Pt,
  T: Pt,
  n: Pt | null,
  hint: number,
  others: Pt[][],
  made: RiverLine[],
  madeBoxes: Box[],
  log: BranchAsk[] | null,
): Pt[] | null {
  const sp = world.mesh.spacing;
  if (!n) return null;
  const L = Math.hypot(T[0] - S.p[0], T[1] - S.p[1]);
  if (L < 0.5 * sp) return null;
  // 最后一小段沿法向的直线，之前从主流的方向弯过来（与 mouthLeg 相同）
  const straight = Math.min(0.35 * sp, 0.4 * L);
  const Q: Pt = [T[0] - n[0] * straight, T[1] - n[1] * straight];
  const pts = hermite(S.p, tS, Q, n, sp / 8);
  const ns = Math.max(1, Math.ceil(straight / (sp / 8)));
  for (let j = 1; j <= ns; j++) pts.push(j === ns ? [T[0], T[1]] : [Q[0] + (T[0] - Q[0]) * (j / ns), Q[1] + (T[1] - Q[1]) * (j / ns)]);
  // 几样检查都要过（与先后无关）：先查只算几何的，最后才查每一点在不在陆地上（要找格、插值，最费时）
  const P = M.points;
  if (maxTurn([...before(P, S.k, sp), S.p, ...pts], TURN_CHORD * sp) > MOUTH_MAX_TURN) return null;
  // 最后六成离主流（分汊以后的那段）够远
  const tail: Pt[] = [S.p, ...P.slice(S.k + 1)];
  const from = Math.floor(pts.length * 0.4);
  for (let j = from; j < pts.length; j++) {
    const h = snapOnto(tail, pts[j][0], pts[j][1], 0, tail.length - 1, world.mesh.kind === 'sphere');
    if (h && h.d < BRANCH_GAP * sp) return null;
  }
  // 不与别的线（主流分汊以后的那段、已经分出去的几股、别的河）相交
  const line: Pt[] = [S.p, ...pts];
  if (polylinesCross(line, tail)) return null;
  for (const o of others) if (polylinesCross(line, [S.p, ...o])) return null;
  const crossMade = crossesMade(line, made, madeBoxes);
  log?.push({ kind: 2, p: line, r: crossMade });
  if (crossMade) return null;
  const crossNear = crossesNearLines(line, lines, boxes, M, sp);
  log?.push({ kind: 1, p: line, r: crossNear });
  if (crossNear) return null;
  if (!allLand(world, f, pts, pts.length - 1, hint)) return null;
  return pts;
}

// 一股（line）与这一次已经分出去的几股相不相交
function crossesMade(line: readonly Pt[], made: RiverLine[], madeBoxes: Box[]): boolean {
  const own = boxOfPts({ points: line });
  for (let k = 0; k < made.length; k++) if (boxesMeet(own, madeBoxes[k]) && polylinesCross(line, made[k].points)) return true;
  return false;
}

// 一股（line）与附近别的河（不算主流 M；有一点在这一股外扩一格的框里）的线相不相交：框不挨着的一定没有
function crossesNearLines(line: readonly Pt[], lines: RiverLine[], boxes: Box[], M: RiverLine, sp: number): boolean {
  const own = boxOfPts({ points: line });
  const near: Box = [own[0] - sp, own[1] + sp, own[2] - sp, own[3] + sp];
  for (let k = 0; k < lines.length; k++) {
    const o = lines[k];
    if (o === M || !boxesMeet(near, boxes[k])) continue;
    const Q2 = o.points;
    let hit = false;
    for (const p of Q2) if (p[0] >= near[0] && p[0] <= near[1] && p[1] >= near[2] && p[1] <= near[3]) hit = true;
    if (hit && polylinesCross(line, Q2)) return true;
  }
  return false;
}

// 两条折线有没有相交的段（segCross）：模块里的函数，不是每次新建的闭包。
// B 的一段的外接框不挨着 A 的外接框时一定不相交，跳过（结果与逐段都比相同）
function polylinesCross(A: readonly (readonly [number, number])[], B: readonly (readonly [number, number])[]): boolean {
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const p of A) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  for (let b = 0; b + 1 < B.length; b++) {
    const p = B[b];
    const q = B[b + 1];
    if (Math.max(p[0], q[0]) < x0 || Math.min(p[0], q[0]) > x1 || Math.max(p[1], q[1]) < y0 || Math.min(p[1], q[1]) > y1) continue;
    for (let a = 0; a + 1 < A.length; a++) if (segCross(A[a], A[a + 1], p, q)) return true;
  }
  return false;
}

// 一组点按边长 r 的方格分桶：离 p 不到 r 的点只在 p 所在的格与周围八格里（与逐个比相同）
class PointGrid {
  private cells = new Map<string, Pt[]>();
  constructor(private r: number) {}
  add(p: Pt) {
    const k = `${Math.floor(p[0] / this.r)},${Math.floor(p[1] / this.r)}`;
    const b = this.cells.get(k);
    if (b) b.push(p);
    else this.cells.set(k, [p]);
  }
  near(p: Pt): boolean {
    const gx = Math.floor(p[0] / this.r);
    const gy = Math.floor(p[1] / this.r);
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++) {
        const list = this.cells.get(`${gx + a},${gy + b}`);
        if (list && nearAny(list, p, this.r)) return true;
      }
    return false;
  }
}

// 离 p 不到 r 的点有没有
function nearAny(list: readonly Pt[], p: Pt, r: number): boolean {
  for (const e of list) if (Math.hypot(e[0] - p[0], e[1] - p[1]) < r) return true;
  return false;
}

// 一格编号的 0–1 散列（主流留多少水）
function unitHash(c: number): number {
  let h = Math.imul(c ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
