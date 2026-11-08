// 河的折线（第八十三轮从 core/rivers.ts 原样搬出）：类型、平滑与曲流、编码、画的河的导线、几何小工具
import { vnoise } from './subcell';
import { type Mesh, findCell } from './mesh';
import { type World, COURSE_MAX_POINTS, type Guide, type Derived } from './world';
import { wrapDelta } from './geo';

export interface RiverLine {
  points: [number, number][];
  // 每个点处的流量（m³/s）
  flow: number[];
  // 每个点在哪一格（离它最近的那个沿河的点所在的格）：入海、入湖画到两格之间的那一点算河口那格，
  // 画到别的河上的最后一点算汇合的那格。点一下河选中它、把支流接到画的河上时用
  cells?: number[];
  // 画的河：每个点的粗细倍数（粗细；在终点消失的河最后一格收细）。省略为 1
  mul?: number[];
  // 画的河（有折线的河道）：河道的 id
  guide?: string;
  // 每个点是哪一种河（与 derived.riverType 相同：0 普通，k + 1 是第 k 种河流类型）。只在世界里有河流类型时才有；
  // 画到别的河上的最后一点算这条河自己的类型（带类型的支流画到汇合处为止都是它的样子）
  type?: number[];
  // 起点：'source' 是源头（画的时候收尖），'lake' 是从湖岸流出（不收尖）；省略的（接着画的线、截下的一段）两样都不是
  head?: 'source' | 'lake';
  // 最后一点在海、湖的岸线上（画的时候河口略张开、平头收在岸线上）
  mouth?: boolean;
  // 汇入别的河（最后一点画在那条河的线上）：那条河在 traceRivers 结果里的下标
  into?: number;
  // 别的河汇进来的地方：在这条线上的位置（第 k 段上 t 处记作 k + t）。画带子时这几处前后约半格不加细小的弯曲，
  // 支流的最后一点就落在画出来的中线上（三角洲分出去的一股从哪里分出去也记在这里）
  joins?: number[];
  // 三角洲分出去的一股（第三十三轮，只是画法）：从哪条河（traceRivers 结果里的下标）分出去。
  // 它的格都是那条河的河口那一格：点它选中那条河
  branch?: number;
  // 溺谷（第三十四轮，只是画法）：入海的河口在溺谷海岸上（core/coast-style.ts 的 ria），河口的喇叭口画得更宽、更长
  ria?: boolean;
  // 断流（第五十七轮，只是画法）：河到这里没水了，尾巴收尖。只有用了断流的世界里才有
  tail?: boolean;
}

// 点 (x, y) 到折线 line 第 from 到 to 个点之间那几段上最近的点：p 是那一点，k 是第几段，d 是距离。
// 整个星球（sphere）：每段按经度就近比，p 与 x 在同一份上
export function snapOnto(
  line: readonly (readonly [number, number])[],
  x: number,
  y: number,
  from = 0,
  to = line.length - 1,
  sphere = false,
): { p: [number, number]; k: number; t: number; d: number } | null {
  let best: { p: [number, number]; k: number; t: number; d: number } | null = null;
  for (let k = Math.max(0, from); k < Math.min(to, line.length - 1); k++) {
    const [ax, ay] = line[k];
    const [bx, by] = line[k + 1];
    const shift = sphere ? 2 * Math.round((x - ax) / 2) : 0;
    const r = segProject(x - shift, y, ax, ay, bx, by);
    if (best && r.d >= best.d) continue;
    best = { p: [ax + (bx - ax) * r.t + shift, ay + (by - ay) * r.t], k, t: r.t, d: r.d };
  }
  return best;
}

// 记下别的河在线上第 k 段 t 处（pos = k + t）汇进来（见 RiverLine.joins）
export function markJoin(line: RiverLine, pos: number): void {
  (line.joins ??= []).push(pos);
}
// 河口附近（最后约 1.5 格）接出来的线上任何地方最多转多少（度）：按相隔 1/4 格的前后两段弦量（见 maxTurn）
export const MOUTH_MAX_TURN = 60;
export const TURN_CHORD = 0.25;

export type Pt = [number, number];

// 折线上转得最急的地方（度）：沿线每隔 chord / 4 取点，量每一点前后各一段弦（长 chord）的方向差。
// from：从线头量起这么远以后的点才算
export function maxTurn(P: readonly (readonly [number, number])[], chord: number, from = 0): number {
  if (P.length < 2 || !(chord > 0)) return 0;
  const h = chord / 4;
  // 取样点放在反复用的数组里（每个河口都要量几次；不在这里新建闭包）
  let n = 0;
  n = pushTurn(n, P[0][0], P[0][1], 0);
  let acc = 0;
  let next = h;
  for (let k = 0; k + 1 < P.length; k++) {
    const dx = P[k + 1][0] - P[k][0];
    const dy = P[k + 1][1] - P[k][1];
    const l = Math.hypot(dx, dy);
    if (l <= 0) continue;
    while (next <= acc + l) {
      const t = (next - acc) / l;
      n = pushTurn(n, P[k][0] + dx * t, P[k][1] + dy * t, next);
      next += h;
    }
    acc += l;
  }
  if (acc - turnS[n - 1] > 1e-3 * h) n = pushTurn(n, P[P.length - 1][0], P[P.length - 1][1], acc);
  let worst = 0;
  for (let i = 4; i + 4 < n; i++) {
    if (turnS[i] < from) continue;
    const ax = turnX[i] - turnX[i - 4];
    const ay = turnY[i] - turnY[i - 4];
    const bx = turnX[i + 4] - turnX[i];
    const by = turnY[i + 4] - turnY[i];
    const c = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
    worst = Math.max(worst, (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI);
  }
  return worst;
}
let turnX = new Float64Array(256);
let turnY = new Float64Array(256);
let turnS = new Float64Array(256);

// maxTurn 的取样点放进反复用的数组（不够时加倍），返回新的个数
function pushTurn(n: number, x: number, y: number, s: number): number {
  if (n >= turnX.length) {
    turnX = growF64(turnX);
    turnY = growF64(turnY);
    turnS = growF64(turnS);
  }
  turnX[n] = x;
  turnY[n] = y;
  turnS[n] = s;
  return n + 1;
}

function growF64(a: Float64Array): Float64Array<ArrayBuffer> {
  const b = new Float64Array(a.length * 2);
  b.set(a);
  return b;
}

// 从 A（方向 ta）到 B（到 B 时的方向 tb，都是单位向量）的三次 Hermite 曲线，每隔约 step 取一点（不含 A，含 B）
// sa、sb：两头的切向量再乘的倍数（默认按两点的距离；起点的小一点少鼓出去，终点的大一点早一点顺着终点的方向）
export function hermite(A: readonly [number, number], ta: readonly [number, number], B: readonly [number, number], tb: readonly [number, number], step: number, sa = 1, sb = 1): Pt[] {
  const L = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const count = Math.max(2, Math.ceil(L / step));
  const out: Pt[] = [];
  for (let j = 1; j <= count; j++) {
    const u = j / count;
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    out.push(j === count ? [B[0], B[1]] : [h00 * A[0] + h10 * L * sa * ta[0] + h01 * B[0] + h11 * L * sb * tb[0], h00 * A[1] + h10 * L * sa * ta[1] + h01 * B[1] + h11 * L * sb * tb[1]]);
  }
  return out;
}

// 线上第 k 个点处顺流的方向（单位向量）
export function dirAt(P: readonly (readonly [number, number])[], k: number): Pt {
  const a = k > 0 ? P[k - 1] : P[k];
  const b = k > 0 ? P[k] : P[Math.min(P.length - 1, k + 1)];
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
}

// 线上第 k 个点往前约 0.3 格的那几个点（量接出来的一段与原来的线接得急不急时带上）
export function before(P: readonly (readonly [number, number])[], k: number, sp: number): Pt[] {
  let c = k;
  for (let s = 0; c > 0 && s < 0.3 * sp; c--) s += Math.hypot(P[c][0] - P[c - 1][0], P[c][1] - P[c - 1][1]);
  return P.slice(c, k + 1).map((p) => [p[0], p[1]] as Pt);
}

export const lineLength = (P: readonly (readonly [number, number])[]) => {
  let s = 0;
  for (let k = 0; k + 1 < P.length; k++) s += Math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]);
  return s;
};

// 从线尾往回量 back 远的那一点：第 k 段上 t 处（k + t），量不到时为线头
export function backAlong(P: readonly (readonly [number, number])[], back: number, lim = 0): { k: number; t: number; p: Pt } {
  let s = 0;
  for (let k = P.length - 2; k >= lim; k--) {
    const l = Math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]);
    if (s + l >= back) {
      const t = l > 0 ? 1 - (back - s) / l : 0;
      return { k, t, p: [P[k][0] + (P[k + 1][0] - P[k][0]) * t, P[k][1] + (P[k + 1][1] - P[k][1]) * t] };
    }
    s += l;
  }
  return { k: lim, t: 0, p: [P[lim][0], P[lim][1]] };
}

// 线段 p1p2 与 q1q2 相交
// （第三十三轮提速：叉积是模块里的函数，不在每次调用里新建闭包；分汊的检查每次描河要调几十万次）
export function segCross(p1: readonly [number, number], p2: readonly [number, number], q1: readonly [number, number], q2: readonly [number, number]): boolean {
  const d1 = orient(q1, q2, p1);
  const d2 = orient(q1, q2, p2);
  const d3 = orient(p1, p2, q1);
  const d4 = orient(p1, p2, q2);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}
const orient = (a: readonly [number, number], b: readonly [number, number], c: readonly [number, number]) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

// 河道的样子：中间点加轻微的曲流，再做三遍 Chaikin 平滑。pts 是沿河的点（格心、入海口），
// flow 是每个点的流量，spacing 是格距；cells（可省略）是每个点所在的格，平滑后每个点取离它最近的原来那点的格。
// 自然的河、画的河、预览都用它，画出来的样子才一致。不改动传进来的数组
// tags（可省略）：每个点是哪一种河，平滑后与 cells 一样取原来那点的（见 RiverLine.type）
export function smoothCourse(pts: readonly [number, number][], flow: number[], spacing: number, cells?: number[], tags?: number[]): RiverLine {
  // 三遍平滑：放大到最大（一格约 64 像素）时也看不出折角
  return chaikin({ points: meander(pts, spacing), flow, cells, ...(tags ? { type: tags } : {}) }, 3);
}

// 画的河（有 path）的样子：存下的折线不再加曲流，只做同样的三遍平滑。固定自然的河时存的是加过曲流的点
// （见 stemPath），所以画出来与原来那条自然的河一模一样。不改动传进来的数组
export function courseLine(pts: readonly [number, number][], flow: number[]): RiverLine {
  return chaikin({ points: pts.slice(), flow }, 3);
}

// 曲流：中间点沿垂直方向错开一点（按位置取噪声，结果确定）。前一点已经错开过，按错开后的位置算。
// 固定一条自然的河时存下的折线就是这一步的结果（再平滑一遍就是原来画出来的样子）。不改动传进来的数组
function meander(pts: readonly [number, number][], spacing: number): [number, number][] {
  const points = pts.slice();
  const amp = 0.22 * spacing;
  for (let k = 1; k < points.length - 1; k++) {
    const [x0, y0] = points[k - 1];
    const [x1, y1] = points[k + 1];
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    const off = amp * vnoise(points[k][0] / spacing * 0.9 + 11.1, points[k][1] / spacing * 0.9);
    points[k] = [points[k][0] - ((y1 - y0) / len) * off, points[k][1] + ((x1 - x0) / len) * off];
  }
  return points;
}

function chaikin(line: RiverLine, iterations: number): RiverLine {
  let { points, flow, cells } = line;
  let rounds = 0;
  for (let it = 0; it < iterations; it++) {
    if (points.length < 3) break;
    rounds++;
    const p: [number, number][] = [points[0]];
    const f: number[] = [flow[0]];
    const t: number[] | undefined = cells ? [cells[0]] : undefined;
    for (let k = 0; k + 1 < points.length; k++) {
      const [ax, ay] = points[k];
      const [bx, by] = points[k + 1];
      p.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
      f.push(flow[k] * 0.75 + flow[k + 1] * 0.25, flow[k] * 0.25 + flow[k + 1] * 0.75);
      t?.push(cells![k], cells![k + 1]);
    }
    p.push(points[points.length - 1]);
    f.push(flow[flow.length - 1]);
    t?.push(cells![cells!.length - 1]);
    points = p;
    flow = f;
    cells = t;
  }
  const out: RiverLine = cells ? { points, flow, cells } : { points, flow };
  if (line.type) out.type = doubledTags(line.type, rounds);
  return out;
}

// 每个点的类型跟着平滑展开（和 cells 同样的规则：每个点取原来那点的）。第五十六轮（提速）：算完再一次展开，不跟着每一遍往数组里加；
// 整条线一种类型（绝大多数）时直接填
function doubledTags(type: readonly number[], rounds: number): number[] {
  const m = type.length;
  let single = true;
  for (let k = 1; k < m && single; k++) single = type[k] === type[0];
  if (single) return new Array<number>(m * 2 ** rounds).fill(m ? type[0] : 0);
  let cur: number[] = type as number[];
  for (let it = 0; it < rounds; it++) {
    const L = cur.length;
    const g = new Array<number>(2 * L);
    g[0] = cur[0];
    for (let k = 0; k + 1 < L; k++) {
      g[2 * k + 1] = cur[k];
      g[2 * k + 2] = cur[k + 1];
    }
    g[2 * L - 1] = cur[L - 1];
    cur = g;
  }
  return rounds ? cur : [...type];
}

// 河宽（屏幕像素，未乘缩放系数）
export function riverWidth(flow: number, threshold: number): number {
  return 0.3 + 0.42 * Math.log2(flow / threshold + 1);
}

// ---------- 画的河道折线（第八轮：自定义走向） ----------

// 存的是整数：地图单位 × 1e5（约 100–200 m，不到一格的百分之一），JSON 短，存取往返逐位相同
const PATH_SCALE = 1e5;

export const roundPathValue = (v: number) => Math.round(v * PATH_SCALE) / PATH_SCALE;
export const roundPoint = (p: readonly [number, number]): [number, number] => [roundPathValue(p[0]), roundPathValue(p[1])];

export function encodePath(pts: readonly (readonly [number, number])[]): number[] {
  const out: number[] = [];
  for (const [x, y] of pts) out.push(Math.round(x * PATH_SCALE), Math.round(y * PATH_SCALE));
  return out;
}

export function decodePath(path: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k + 1 < path.length; k += 2) out.push([path[k] / PATH_SCALE, path[k + 1] / PATH_SCALE]);
  return out;
}

// 去掉相邻的重复点
export function dedupePoints(pts: [number, number][]): [number, number][] {
  return pts.filter((p, k) => k === 0 || p[0] !== pts[k - 1][0] || p[1] !== pts[k - 1][1]);
}

// 点到线段的距离，以及投影点在线段上的位置 t（0–1）
export function segProject(px: number, py: number, ax: number, ay: number, bx: number, by: number): { d: number; t: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return { d: Math.hypot(px - ax - t * dx, py - ay - t * dy), t };
}

// Douglas–Peucker 化简：离保留下来的折线不超过 tol
export function douglasPeucker(pts: readonly [number, number][], tol: number): [number, number][] {
  const n = pts.length;
  if (n <= 2) return pts.slice();
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let best = -1;
    let bd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = segProject(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]).d;
      if (d > bd) {
        bd = d;
        best = i;
      }
    }
    if (best < 0) continue;
    keep[best] = 1;
    stack.push([a, best], [best, b]);
  }
  return pts.filter((_, i) => keep[i]);
}

// 沿折线取点的间隔：四分之一格。河道经过哪些格、在哪里截断都按这些点算
export const courseStep = (mesh: Mesh) => mesh.spacing * 0.25;

// 沿折线每隔 step 取一点：每段按段长等分（含两端，相邻两段共用的端点只取一次）。
// seg：点在第几段上。同一条折线在哪里取，点都逐位相同
export function pathSamples(pts: readonly (readonly [number, number])[], step: number): { x: number[]; y: number[]; seg: number[] } {
  const out = { x: [] as number[], y: [] as number[], seg: [] as number[] };
  if (!pts.length) return out;
  out.x.push(pts[0][0]);
  out.y.push(pts[0][1]);
  out.seg.push(0);
  for (let k = 0; k + 1 < pts.length; k++) {
    const [x0, y0] = pts[k];
    const [x1, y1] = pts[k + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / step));
    for (let j = 1; j <= steps; j++) {
      out.x.push(x0 + ((x1 - x0) * j) / steps);
      out.y.push(y0 + ((y1 - y0) * j) / steps);
      out.seg.push(k);
    }
  }
  return out;
}

// 折线在第一次走进这一格的地方截断（截断点是落在这格里的第一个取样点，按存的精度取整后仍在这格里）。
// 折线从来没进过这一格时返回 null（这一格在画完之后顺地势流下去的那段里）
export function cutPathAtCell(mesh: Mesh, path: readonly number[], cell: number): number[] | null {
  const pts = decodePath(path);
  const s = pathSamples(pts, courseStep(mesh));
  let hint = 0;
  for (let k = 0; k < s.x.length; k++) {
    hint = findCell(mesh, s.x[k], s.y[k], hint);
    if (hint !== cell) continue;
    const x = roundPathValue(s.x[k]);
    const y = roundPathValue(s.y[k]);
    if (findCell(mesh, x, y, cell) !== cell) continue;
    const out = pts.slice(0, s.seg[k] + 1);
    const last = out[out.length - 1];
    if (last[0] !== x || last[1] !== y) out.push([x, y]);
    // 截在起点那格：至少留下两个点
    if (out.length < 2) out.push([x, y]);
    return encodePath(out);
  }
  return null;
}

// 一串格的格心（整个星球上沿河连续展开，接在 start 后面）；到了海或湖就画到两格之间为止，与自然的河的画法相同
export function centrePoints(world: World, cells: readonly number[], start?: [number, number]): [number, number][] {
  const { mesh, causes } = world;
  const lake = world.derived.lake;
  const sphere = mesh.kind === 'sphere';
  const pts: [number, number][] = start ? [start] : [];
  for (const c of cells) {
    const prev = pts.length ? pts[pts.length - 1][0] : mesh.x[c];
    const x = sphere ? prev + wrapDelta(mesh.x[c] - prev) : mesh.x[c];
    if (pts.length && (!causes.land[c] || lake[c] === 1)) {
      const [px, py] = pts[pts.length - 1];
      pts.push([(px + x) / 2, (py + mesh.y[c]) / 2]);
      break;
    }
    pts.push([x, mesh.y[c]]);
  }
  return pts;
}

// 固定一条自然的河时存下的折线：与画自然的河同样的点（格心，入海、入湖的画到两格之间）加上同样的曲流，
// 再平滑一遍就是原来屏幕上的样子。点太多时化简
export function stemPath(world: World, cells: readonly number[]): number[] {
  const { mesh } = world;
  const sphere = mesh.kind === 'sphere';
  const wavy = meander(centrePoints(world, cells), mesh.spacing);
  let out = wavy;
  for (let tol = 0.03 * mesh.spacing; out.length > COURSE_MAX_POINTS; tol *= 1.5) out = douglasPeucker(wavy, tol);
  if (sphere && out.length) {
    const shift = 2 * Math.floor(out[0][0] / 2);
    if (shift) out = out.map(([x, y]) => [x - shift, y]);
  }
  return encodePath(dedupePoints(out.map(roundPoint)));
}

// 一条河道上算作“这条河”的第 i 格：最后一格是它汇入的地方（那条河的）不算；在终点消失的河的终点算（水在那里消失，
// 别的河经过它也会被吞掉，所以截走、改道时要把它的“消失”去掉）
// 分出去的一股（branch）的第一格在干流上，也不是它的
export const ownsCell = (g: Pick<Guide, 'cells' | 'end' | 'branch'>, i: number) => (i < g.cells.length - 1 || g.end === 'sink') && !(i === 0 && g.branch);

// 一条画的河的控制点（courseLine 再平滑一遍就是画出来的样子）：画的折线，再接上画完之后顺地势流下去的那段
// （格心加上与自然的河相同的曲流）；没有折线的河道（顺地势画的）整条按格心（与固定自然的河时存的一样，见 stemPath）。
// 重画一段、接到它前面时都按它算，所以没改的地方画出来一点不动
export function guidePoints(world: World, g: Guide): [number, number][] {
  if (!g.path) return decodePath(stemPath(world, g.cells));
  const pts = decodePath(g.path);
  const last = pts[pts.length - 1];
  const m = g.cells.indexOf(findCell(world.mesh, last[0], last[1]));
  if (m < 0 || m >= g.cells.length - 1 || !world.causes.land[g.cells[m]] || world.derived.lake[g.cells[m]] === 1) return pts;
  const tail = meander(centrePoints(world, g.cells.slice(m + 1), last), world.mesh.spacing).slice(1);
  return dedupePoints([...pts, ...tail.map(roundPoint)]);
}

export interface GuideLine {
  // 画出来的样子（guideShape：控制点 guidePoints 再平滑），再每隔半格加密（形状不变）
  points: [number, number][];
  // 每个点落在河道的第几格（g.cells 的下标，沿河不减；平滑后擦过别的格时留在上一格）
  cellIdx: number[];
}

// 一条河道画出来的线：traceRivers 照它画画的河，河道的标记、点中哪条河、量长度、标地名都用它。
// 整个星球上 x 沿河连续展开（起点在 [0, 2) 里）
export function guideLine(world: World, g: Guide): GuideLine {
  const { mesh } = world;
  const smooth = guideShape(world, g);
  const step = 0.5 * mesh.spacing;
  const points: [number, number][] = smooth.length ? [smooth[0]] : [];
  for (let k = 0; k + 1 < smooth.length; k++) {
    const [ax, ay] = smooth[k];
    const [bx, by] = smooth[k + 1];
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / step);
    for (let j = 1; j < steps; j++) points.push([ax + ((bx - ax) * j) / steps, ay + ((by - ay) * j) / steps]);
    points.push(smooth[k + 1]);
  }
  const pos = new Map<number, number>();
  g.cells.forEach((c, k) => {
    if (!pos.has(c)) pos.set(c, k);
  });
  const cellIdx: number[] = [];
  let idx = 0;
  let hint = g.cells[0];
  for (const [x, y] of points) {
    hint = findCell(mesh, x, y, hint);
    const i = pos.get(hint);
    // 只往前走、一次最多跳几格：河道绕回自己附近时不会跳到下游去
    if (i !== undefined && i > idx && i <= idx + 6) idx = i;
    cellIdx.push(idx);
  }
  return { points, cellIdx };
}

// 一条河道画出来的线（不加密、不找格；河道的白色虚线标记用）
export function guideShape(world: World, g: Guide): [number, number][] {
  const pts = splitLong(guidePoints(world, g), world.mesh.spacing);
  return courseLine(pts, pts.map(() => 0)).points;
}

// 平滑之前把长于两格的直段等分到不长于一格：拐角只在一格上下磨圆（与自然的河一样）。
// 不然两条长直边夹着的拐角会被平滑切掉好几格，画出来的河离画的线、离水真正流过的格都很远。
// 固定自然的河时存的点本来就相隔一格左右，不受影响（整个星球两极附近拉长的格除外，那里只是稍圆一点）
function splitLong(pts: readonly [number, number][], spacing: number): [number, number][] {
  const out: [number, number][] = pts.length ? [pts[0]] : [];
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k];
    const [bx, by] = pts[k + 1];
    const len = Math.hypot(bx - ax, by - ay);
    if (len > 2 * spacing) {
      const steps = Math.ceil(len / spacing);
      for (let j = 1; j < steps; j++) out.push([ax + ((bx - ax) * j) / steps, ay + ((by - ay) * j) / steps]);
    }
    out.push(pts[k + 1]);
  }
  return out;
}

// 河道的内容签名：画河的路径缓存按它认（每次快照的河道数组都是新的，按对象认会每次重画）。
// 只看影响画法的几项：格、折线、粗细、终点、是否锁定、类型；改名字、水量不在里面（水量变了流量数组也变）
export function guidesSignature(guides: readonly Guide[]): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  const mix = (v: number) => {
    a = Math.imul(a ^ v, 0x01000193);
    b = Math.imul(b ^ v, 0x5bd1e995) ^ (b >>> 15);
  };
  const str = (t: string | undefined) => {
    mix(t === undefined ? -1 : t.length);
    if (t) for (let i = 0; i < t.length; i++) mix(t.charCodeAt(i));
  };
  for (const g of guides) {
    str(g.id);
    mix(g.cells.length);
    for (const c of g.cells) mix(c);
    mix(g.path ? g.path.length : -1);
    if (g.path) for (const v of g.path) mix(v);
    mix(Math.round((g.width ?? 1) * 1e4));
    mix(g.end === 'sink' ? 1 : 0);
    mix(g.locked ? 1 : 0);
    str(g.type);
    mix(g.branch ? Math.round(g.branch.share * 1e4) : -1);
  }
  return `${guides.length}:${(a >>> 0).toString(36)}:${(b >>> 0).toString(36)}`;
}

// 河道的最后一格是不是汇入了别的河：流进那一格的河里这条河不是最大的（与自然的河认干流的办法相同：
// 一样大时编号小的算干流），那一格算那条更大的河的。比它小的河在那里流进来时，那一格还是这条河的
export function joinsRiver(world: World, d: Derived, g: Guide): boolean {
  const { mesh, causes } = world;
  const thr = world.small.planet.riverThreshold;
  const cells = g.cells;
  const L = cells[cells.length - 1];
  const prev = cells[cells.length - 2];
  if (g.end === 'sink' || !causes.land[L] || d.lake[L] === 1) return false;
  for (let e = mesh.off[L]; e < mesh.off[L + 1]; e++) {
    const j = mesh.adj[e];
    if (j === prev || d.receiver[j] !== L || !causes.land[j] || d.lake[j] === 1 || d.discharge[j] < thr) continue;
    if (d.discharge[j] > d.discharge[prev] || (d.discharge[j] === d.discharge[prev] && j < prev)) return true;
  }
  return false;
}

// 一条画的河自己的格（地名、去掉重复的自然河名用）：河道上的陆地格，湖里的不算；
// 最后一格汇入别的河时那一格是那条河的，也不算。从源头往下排
export function guideBody(world: World, d: Derived, g: Guide): number[] {
  const land = world.causes.land;
  let cells = joinsRiver(world, d, g) ? g.cells.slice(0, -1) : g.cells;
  // 分出去的一股：第一格是干流的
  if (g.branch) cells = cells.slice(1);
  return cells.filter((c) => land[c] && d.lake[c] !== 1);
}
