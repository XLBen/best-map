import { wrapDelta } from './geo';
import { type Mesh, findCell } from './mesh';
import { vnoise } from './subcell';
import { COURSE_MAX_POINTS, type Derived, type Guide, type World } from './world';

// 河流折线：从源头顺流追到入海口、湖或与已画的河汇合处；加轻微的曲流并做 Chaikin 平滑。
// 屏幕与导出共用，所以导出的 rivers.bmp 与屏幕上的河一致。
// 画的河（有折线的河道）照存下的折线画（再平滑一遍），自然的支流画到它的线上为止

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
}

// 支流从这一点接着画（画的河流到了别的河都不经过的地方：从它的线上接出去）
interface Lead {
  cell: number;
  p: [number, number];
  flow: number;
  from: number;
}

export function traceRivers(world: World): RiverLine[] {
  const { mesh, derived: d, causes, small } = world;
  const n = mesh.n;
  const thr = small.planet.riverThreshold;
  const isRiver = (i: number) => causes.land[i] === 1 && d.lake[i] !== 1 && d.discharge[i] >= thr;
  const hasRiverDonor = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!isRiver(i)) continue;
    const r = d.receiver[i];
    if (r >= 0 && isRiver(r)) hasRiverDonor[r] = 1;
  }
  const sources: number[] = [];
  for (let i = 0; i < n; i++) if (isRiver(i) && !hasRiverDonor[i]) sources.push(i);
  // 源头高的先画：干流通常源远流长，支流画到汇合处为止
  sources.sort((a, b) => d.elevation[b] - d.elevation[a]);
  const visited = new Uint8Array(n);
  const lines: RiverLine[] = [];
  // 整个星球：沿河展开经度（每一点取离上一点最近的那一份），跨过经度 180° 的河也是连续的一条线；
  // 画的时候每一份平铺的副本各画一遍
  const sphere = mesh.kind === 'sphere';
  const xAt = (c: number, ref: number) => (sphere ? ref + (mesh.x[c] - ref - 2 * Math.round((mesh.x[c] - ref) / 2)) : mesh.x[c]);
  // 画的河先定下来（沿途的格算画过了）；没有画的河时什么都不做，自然的河逐位照旧
  const course = small.guides.some((g) => g.path) ? courseIndex(world, isRiver, visited) : null;
  // 河流类型（第三批）：每个点带上是哪一种河。没有河流类型时不带（点、流量照旧逐位不变）
  const rt = d.riverType;
  const walk = (s: number, lead?: Lead) => {
    const pts: [number, number][] = [];
    const flow: number[] = [];
    const cells: number[] = [];
    const tags: number[] | undefined = rt ? [] : undefined;
    // 画到别的河上的那一点：算这条河自己的类型（前一点的）
    const own = () => (tags && tags.length ? tags[tags.length - 1] : 0);
    let c = s;
    let cx = mesh.x[s];
    // 前面接着画的线已经流过这一格：只画到这一格（与支流画到画过的格一样），不然画的河在这里断开
    const reached = lead !== undefined && visited[s] === 1;
    if (lead) {
      pts.push(lead.p);
      flow.push(lead.flow);
      cells.push(lead.from);
      tags?.push(rt![lead.from]);
      cx = lead.p[0];
      if (reached) {
        pts.push([xAt(s, cx), mesh.y[s]]);
        flow.push(d.discharge[s]);
        cells.push(s);
        tags?.push(own());
      }
    }
    for (let guard = 0; guard < n && !reached; guard++) {
      cx = xAt(c, cx);
      pts.push([cx, mesh.y[c]]);
      flow.push(d.discharge[c]);
      cells.push(c);
      tags?.push(rt![c]);
      visited[c] = 1;
      const r = d.receiver[c];
      if (r < 0) break;
      if (!causes.land[r] || d.lake[r] === 1) {
        // 入海、入湖：画到两格之间
        pts.push([(cx + xAt(r, cx)) / 2, (mesh.y[c] + mesh.y[r]) / 2]);
        flow.push(d.discharge[c]);
        cells.push(c);
        tags?.push(rt![c]);
        break;
      }
      if (!isRiver(r)) break;
      if (visited[r]) {
        // 汇入画的河时画到它的线上（不是那一格的格心）
        pts.push(course?.snap(r, cx, mesh.y[c]) ?? [xAt(r, cx), mesh.y[r]]);
        flow.push(d.discharge[r]);
        cells.push(r);
        tags?.push(own());
        break;
      }
      c = r;
    }
    if (pts.length < 2) return;
    const line = smoothCourse(pts, flow, mesh.spacing, cells, tags);
    lines.push(line);
    course?.own(line);
  };
  if (course) for (const lead of course.leads) walk(lead.cell, lead);
  for (const s of sources) {
    if (visited[s]) continue;
    walk(s);
  }
  if (!course) return lines;
  course.finish();
  if (rt) course.tag(rt);
  // 画的河画在自然的河之后
  return [...lines, ...course.lines];
}

// 画的河在 traceRivers 里的那部分：按存下的折线画成几段（只画看得见是河的格：入海、入湖的那一点也画，
// 水被截走、在海里的那段不画），记下每一格是哪条线画的、在线上的哪几个点之间，
// 自然的支流画到画的河的线上，画的河汇入别的河时也画到那条河的线上
function courseIndex(world: World, isRiver: (i: number) => boolean, visited: Uint8Array) {
  const { mesh, derived: d, causes, small } = world;
  const n = mesh.n;
  const sphere = mesh.kind === 'sphere';
  const water = (c: number) => !causes.land[c] || d.lake[c] === 1;
  // 每格由哪条线画（先画的算）、在它的第几个点到第几个点之间
  const owner: (RiverLine | undefined)[] = new Array(n);
  const from = new Int32Array(n);
  const to = new Int32Array(n);
  const take = (line: RiverLine, k: number, c: number) => {
    if (owner[c] === undefined) {
      owner[c] = line;
      from[c] = to[c] = k;
    } else if (owner[c] === line) to[c] = k;
  };
  const guides = small.guides.filter((g) => g.path);
  // 每格在哪条画的河的河道上（终点那格除外：那是海、湖或者别的河；在终点消失的含终点）
  const bodyOf = new Int32Array(n).fill(-1);
  guides.forEach((g, gi) => {
    const m = g.end === 'sink' ? g.cells.length : g.cells.length - 1;
    for (let k = 0; k < m; k++) if (bodyOf[g.cells[k]] < 0) bodyOf[g.cells[k]] = gi;
  });
  const lines: RiverLine[] = [];
  const joins: { line: RiverLine; cell: number }[] = [];
  // 汇入别的河的画的河（每一段）汇入的那一格
  const joinCell = new Map<RiverLine, number>();
  guides.forEach((g, gi) => {
    const { points, cellIdx } = guideLine(world, g);
    const cells = g.cells;
    const last = cells.length - 1;
    const L = cells[last];
    // 终点那格是别的河的（汇入）：它不算这条河的格，这条河画到那条河的线上为止
    const join = g.end !== 'sink' && !water(L) && ((bodyOf[L] >= 0 && bodyOf[L] !== gi) || joinsRiver(world, d, g));
    const width = g.width ?? 1;
    const runs: RiverLine[] = [];
    let run: RiverLine | null = null;
    // 第 k 个点画在哪一段的第几个点
    const where: ({ run: RiverLine; j: number } | undefined)[] = new Array(points.length);
    for (let k = 0; k < points.length; k++) {
      const i = cellIdx[k];
      const c = cells[i];
      let q = -1;
      let tag = c;
      if (water(c)) {
        // 河口：画进海、湖的第一点（离岸不到半格，与自然的河画到两格之间差不多），流量按上一格。
        // 后来海、湖淹到了河道上时，不会一直画进水里
        if (i > 0 && isRiver(cells[i - 1]) && cellIdx[k - 1] !== i) {
          tag = cells[i - 1];
          q = d.discharge[tag];
        }
      } else if (isRiver(c)) q = d.discharge[join && i === last ? cells[last - 1] : c];
      if (q < 0) {
        run = null;
        continue;
      }
      if (!run) runs.push((run = { points: [], flow: [], cells: [], mul: [], guide: g.id }));
      where[k] = { run, j: run.points.length };
      run.points.push(points[k]);
      run.flow.push(q);
      run.cells!.push(tag);
      run.mul!.push(width);
    }
    const kept = runs.filter((r) => r.points.length >= 2);
    const tail = kept[kept.length - 1];
    if (tail && g.end === 'sink' && cellIdx[points.length - 1] === last && tail.points[tail.points.length - 1] === points[points.length - 1]) {
      // 在终点消失：最后一格的长度上收细到三成
      const len = mesh.spacing;
      let s = 0;
      for (let k = tail.points.length - 1; k >= 0 && s < len; k--) {
        tail.mul![k] = width * (0.3 + (0.7 * s) / len);
        if (k > 0) s += Math.hypot(tail.points[k][0] - tail.points[k - 1][0], tail.points[k][1] - tail.points[k - 1][1]);
      }
    }
    for (const r of kept) {
      r.cells!.forEach((c, k) => {
        if (join && c === L) return;
        if (owner[c] === undefined) visited[c] = 1;
        take(r, k, c);
      });
      lines.push(r);
      if (join) joinCell.set(r, L);
    }
    // 平滑后的线擦过去、一个点也没落进的格（画的线擦过一个角时补上的格）：算在下一个点那里
    for (let i = 0, k = 0; i < last; i++) {
      const c = cells[i];
      while (k < points.length && cellIdx[k] < i) k++;
      const at = where[k];
      if (owner[c] !== undefined || !isRiver(c) || !at || at.run.points.length < 2) continue;
      visited[c] = 1;
      take(at.run, at.j, c);
    }
    if (join && tail && tail.cells![tail.cells!.length - 1] === L) joins.push({ line: tail, cell: L });
  });

  // 画的河的水流到了画的河都不经过的格（比它流进的那条自然的河大、终点那格算它的，或者有一段没按画的走）：
  // 从它的线上接着往下画。那一格还有别的支流流进来也接着画（那条支流画到这里为止），不然线会断开一格；
  // 汇入别的河的那一格不接（画到那条河的线上，见 finish）
  const leads: Lead[] = [];
  const led = new Set<number>();
  for (const line of lines) {
    line.cells!.forEach((c, k) => {
      if (owner[c] !== line || to[c] !== k) return;
      const r = d.receiver[c];
      if (r < 0 || !isRiver(r) || visited[r] || led.has(r) || joinCell.get(line) === r) return;
      led.add(r);
      leads.push({ cell: r, p: [line.points[k][0], line.points[k][1]], flow: d.discharge[c], from: c });
    });
  }

  // 点 (x, y) 投影到格 c 所在那条线上 c 附近的几段（只在这几段里找，所以不会接到远处；隔得太远时不接）
  const project = (c: number, x: number, y: number) => {
    const o = owner[c];
    if (!o) return null;
    const hit = snapOnto(o.points, x, y, Math.max(0, from[c] - 1), Math.min(o.points.length - 1, to[c] + 1), sphere);
    return hit && hit.d <= 3 * mesh.spacing ? hit : null;
  };
  return {
    lines,
    leads,
    // 自然的河汇入画的河：画到它的线上
    snap(r: number, x: number, y: number): [number, number] | null {
      return owner[r]?.guide !== undefined ? (project(r, x, y)?.p ?? null) : null;
    },
    own(line: RiverLine) {
      line.cells!.forEach((c, k) => take(line, k, c));
    },
    // 河流类型：每个点按它的格；汇入别的河的那一格（那条河的）按这条河自己的
    tag(rt: Uint8Array) {
      for (const line of lines) {
        const L = joinCell.get(line);
        const t: number[] = [];
        for (const c of line.cells!) t.push(c === L && t.length ? t[t.length - 1] : rt[c]);
        line.type = t;
      }
    },
    // 画的河汇入别的河：在汇合的那格里离那条河的线最近的点截住，画到那条线上
    finish() {
      for (const { line, cell } of joins) {
        let best: { k: number; p: [number, number]; d: number } | null = null;
        for (let k = line.points.length - 1; k >= 0 && line.cells![k] === cell; k--) {
          const hit = project(cell, line.points[k][0], line.points[k][1]);
          if (hit && (!best || hit.d < best.d)) best = { k, p: hit.p, d: hit.d };
        }
        if (!best) continue;
        const keep = best.k + 1;
        line.points.length = keep;
        line.flow.length = keep;
        line.cells!.length = keep;
        line.mul!.length = keep;
        line.points.push(best.p);
        line.flow.push(line.flow[keep - 1]);
        line.cells!.push(cell);
        line.mul!.push(line.mul![keep - 1]);
      }
    },
  };
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
): { p: [number, number]; k: number; d: number } | null {
  let best: { p: [number, number]; k: number; d: number } | null = null;
  for (let k = Math.max(0, from); k < Math.min(to, line.length - 1); k++) {
    const [ax, ay] = line[k];
    const [bx, by] = line[k + 1];
    const shift = sphere ? 2 * Math.round((x - ax) / 2) : 0;
    const r = segProject(x - shift, y, ax, ay, bx, by);
    if (best && r.d >= best.d) continue;
    best = { p: [ax + (bx - ax) * r.t + shift, ay + (by - ay) * r.t], k, d: r.d };
  }
  return best;
}

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
export function meander(pts: readonly [number, number][], spacing: number): [number, number][] {
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
  let { points, flow, cells, type } = line;
  for (let it = 0; it < iterations; it++) {
    if (points.length < 3) break;
    const p: [number, number][] = [points[0]];
    const f: number[] = [flow[0]];
    const t: number[] | undefined = cells ? [cells[0]] : undefined;
    const g: number[] | undefined = type ? [type[0]] : undefined;
    for (let k = 0; k + 1 < points.length; k++) {
      const [ax, ay] = points[k];
      const [bx, by] = points[k + 1];
      p.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
      f.push(flow[k] * 0.75 + flow[k + 1] * 0.25, flow[k] * 0.25 + flow[k + 1] * 0.75);
      t?.push(cells![k], cells![k + 1]);
      g?.push(type![k], type![k + 1]);
    }
    p.push(points[points.length - 1]);
    f.push(flow[flow.length - 1]);
    t?.push(cells![cells!.length - 1]);
    g?.push(type![type!.length - 1]);
    points = p;
    flow = f;
    cells = t;
    type = g;
  }
  const out: RiverLine = cells ? { points, flow, cells } : { points, flow };
  if (type) out.type = type;
  return out;
}

// 河宽（屏幕像素，未乘缩放系数）
export function riverWidth(flow: number, threshold: number): number {
  return 0.3 + 0.42 * Math.log2(flow / threshold + 1);
}

// ---------- 画的河道折线（第八轮：自定义走向） ----------

// 存的是整数：地图单位 × 1e5（约 100–200 m，不到一格的百分之一），JSON 短，存取往返逐位相同
export const PATH_SCALE = 1e5;

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
  const cells = joinsRiver(world, d, g) ? g.cells.slice(0, -1) : g.cells;
  return cells.filter((c) => land[c] && d.lake[c] !== 1);
}
