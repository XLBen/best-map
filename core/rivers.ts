import { type Mesh, findCell } from './mesh';
import { vnoise } from './subcell';
import type { World } from './world';

// 河流折线：从源头顺流追到入海口、湖或与已画的河汇合处；加轻微的曲流并做 Chaikin 平滑。
// 屏幕与导出共用，所以导出的 rivers.bmp 与屏幕上的河一致。

export interface RiverLine {
  points: [number, number][];
  // 每个点处的流量（m³/s）
  flow: number[];
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
  for (const s of sources) {
    const pts: [number, number][] = [];
    const flow: number[] = [];
    let c = s;
    let cx = mesh.x[s];
    for (let guard = 0; guard < n; guard++) {
      cx = xAt(c, cx);
      pts.push([cx, mesh.y[c]]);
      flow.push(d.discharge[c]);
      visited[c] = 1;
      const r = d.receiver[c];
      if (r < 0) break;
      if (!causes.land[r] || d.lake[r] === 1) {
        // 入海、入湖：画到两格之间
        pts.push([(cx + xAt(r, cx)) / 2, (mesh.y[c] + mesh.y[r]) / 2]);
        flow.push(d.discharge[c]);
        break;
      }
      if (!isRiver(r)) break;
      if (visited[r]) {
        pts.push([xAt(r, cx), mesh.y[r]]);
        flow.push(d.discharge[r]);
        break;
      }
      c = r;
    }
    if (pts.length < 2) continue;
    lines.push(smoothCourse(pts, flow, mesh.spacing));
  }
  return lines;
}

// 河道的样子：中间点加轻微的曲流，再做三遍 Chaikin 平滑。pts 是沿河的点（格心、入海口），
// flow 是每个点的流量，spacing 是格距。自然的河、画的河、预览都用它，画出来的样子才一致。不改动传进来的数组
export function smoothCourse(pts: readonly [number, number][], flow: number[], spacing: number): RiverLine {
  // 三遍平滑：放大到最大（一格约 64 像素）时也看不出折角
  return chaikin({ points: meander(pts, spacing), flow }, 3);
}

// 画的河（有 path）的样子：存下的折线不再加曲流，只做同样的三遍平滑。固定自然的河时存的是加过曲流的点
// （见 select.ts 的 stemPath），所以画出来与原来那条自然的河一模一样。不改动传进来的数组
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
  let { points, flow } = line;
  for (let it = 0; it < iterations; it++) {
    if (points.length < 3) break;
    const p: [number, number][] = [points[0]];
    const f: number[] = [flow[0]];
    for (let k = 0; k + 1 < points.length; k++) {
      const [ax, ay] = points[k];
      const [bx, by] = points[k + 1];
      p.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
      f.push(flow[k] * 0.75 + flow[k + 1] * 0.25, flow[k] * 0.25 + flow[k + 1] * 0.75);
    }
    p.push(points[points.length - 1]);
    f.push(flow[flow.length - 1]);
    points = p;
    flow = f;
  }
  return { points, flow };
}

// 河宽（屏幕像素，未乘缩放系数）
export function riverWidth(flow: number, threshold: number): number {
  return 0.3 + 0.42 * Math.log2(flow / threshold + 1);
}

// ---------- 画的河道折线（第八轮：自定义走向） ----------

// 存的是整数：地图单位 × 1e5（约 100–200 m，不到一格的百分之一），JSON 短，存取往返逐位相同
export const PATH_SCALE = 1e5;

export const roundPathValue = (v: number) => Math.round(v * PATH_SCALE) / PATH_SCALE;

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
