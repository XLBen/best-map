import type { GuidePatch } from './commands';
import { bedLevels, sinkMask, userLakeMask, waterLevel } from './elevation';
import { arc, fromUnit, localOffset, toUnit, wrapDelta } from './geo';
import { type Mesh, findCell, graphDistanceOwner } from './mesh';
import {
  courseStep,
  decodePath,
  dedupePoints as dedupe,
  douglasPeucker,
  encodePath,
  guidePoints,
  ownsCell,
  pathSamples,
  roundPoint as roundPt,
  roundPathValue,
  segProject,
  stemPath,
} from './rivers';
import { isVegetated } from './vegetation';
import { COURSE_MAX_POINTS, type Derived, type Guide, type World } from './world';

// 选区与延伸：所有结果都是明确的格列表，交给命令保存，保证重放与推导状态无关

// 画的河的控制点、固定自然的河时存的折线（实现在 rivers.ts，画法与路径一处一份）
export { guidePoints, stemPath } from './rivers';

// 整个星球：一串（已展开的）经度的平均值，格的经度在它附近展开后再按平面的办法判断
function meanX(points: [number, number][]): number {
  let s = 0;
  for (const p of points) s += p[0];
  return s / points.length;
}
const unwrappedX = (mesh: Mesh, ref: number) => (mesh.kind === 'sphere' ? (i: number) => ref + wrapDelta(mesh.x[i] - ref) : null);

export function provinceCells(world: World, id: number): number[] {
  const out: number[] = [];
  const p = world.causes.province;
  for (let i = 0; i < p.length; i++) if (p[i] === id) out.push(i);
  return out;
}

// 拖动扩张：从一片区域向外“长”，长多远由拖动距离决定。
// 按“距离 × 不适宜程度 × 偏离拖动方向的程度”的代价从小到大依次加入，顺序固定，
// 所以拖动时的预览就是松手后的结果。方向从 origin（按下的位置，省略时取区域中心）量起
export function growRegion(
  world: World,
  d: Derived,
  region: number[],
  species: number,
  reachKm: number,
  direction: [number, number] | null,
  origin?: [number, number],
): number[] {
  const { mesh, causes } = world;
  if (!region.length || reachKm <= 0) return [];
  const S = world.small.species.length;
  const land = causes.land[region[0]];
  const inRegion = new Set(region);
  let cx = 0;
  let cy = 0;
  if (origin) [cx, cy] = origin;
  else if (mesh.kind === 'sphere') {
    // 整个星球：区域中心取单位向量的平均
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (const c of region) {
      sx += mesh.p[3 * c];
      sy += mesh.p[3 * c + 1];
      sz += mesh.p[3 * c + 2];
    }
    const l = Math.hypot(sx, sy, sz) || 1;
    [cx, cy] = fromUnit([sx / l, sy / l, sz / l]);
  } else {
    for (const c of region) {
      cx += mesh.x[c];
      cy += mesh.y[c];
    }
    cx /= region.length;
    cy /= region.length;
  }
  const dl = direction ? Math.hypot(direction[0], direction[1]) : 0;
  // 整个星球：方向在起点的切平面里比较（拖动方向的东西分量乘 cos 纬度）
  const sphere = mesh.kind === 'sphere' ? mesh : null;
  const o = sphere ? toUnit(cx, cy) : null;
  const dirE = sphere && direction ? wrapDelta(direction[0]) * Math.sin(Math.PI * cy) : 0;
  const dirS = sphere && direction ? direction[1] : 0;
  const dlS = Math.hypot(dirE, dirS);
  const { dist } = graphDistanceOwner(mesh, region, reachKm / world.kmPerUnit, (_i, j, e) => {
    if (causes.land[j] !== land || (species >= 0 && !isVegetated(world, d, j))) return Infinity;
    const suit = species >= 0 ? d.suit[j * S + species] : 1;
    let c = mesh.dist[e] * (1 + 3 * (1 - suit));
    if (sphere && o && dlS > 0) {
      const [ve, vs] = localOffset(o, [sphere.p[3 * j], sphere.p[3 * j + 1], sphere.p[3 * j + 2]]);
      const vl = Math.hypot(ve, vs) || 1;
      const cos = (ve * dirE + vs * dirS) / (vl * dlS);
      c *= 1 + 1.5 * (1 - cos);
    } else if (!sphere && dl > 0) {
      const vx = mesh.x[j] - cx;
      const vy = mesh.y[j] - cy;
      const vl = Math.hypot(vx, vy) || 1;
      const cos = (vx * direction![0] + vy * direction![1]) / (vl * dl);
      c *= 1 + 1.5 * (1 - cos);
    }
    return c;
  });
  const out: number[] = [];
  for (let i = 0; i < mesh.n; i++) if (Number.isFinite(dist[i]) && !inRegion.has(i)) out.push(i);
  return out;
}

// 沿当前汇流方向从一格走到海或终点：“锁定河道”用
export function traceRiver(world: World, d: Derived, start: number): number[] {
  const path = [start];
  let cur = start;
  const seen = new Set(path);
  while (true) {
    const r = d.receiver[cur];
    if (r < 0 || seen.has(r)) break;
    path.push(r);
    seen.add(r);
    if (!world.causes.land[r]) break;
    cur = r;
  }
  return path;
}

// 画河的结果：路线、流到哪里、是不是改道、改道后哪些河段会变干。
// 预览与松手后执行的命令用的是同一条路线
export type RiverEnd = 'sea' | 'lake' | 'river' | 'edge';

export interface RiverPlan {
  // 相邻格组成的路线，第一格是起点
  cells: number[];
  // 最后流到哪里：海、湖、汇入别的河、从地图边上流出去；画不出时为 null
  end: RiverEnd | null;
  // 汇入的那一格（end 为 river 时）
  join: number;
  // 从一条河上开始画：这条河从这里改走画的路线
  reroute: boolean;
  // 改道后原来的河道里会变干的格（按原来的流向排列）。估算：没算改道后地势跟着变的部分
  dried: number[];
  // 画不出来的原因
  blocked: string | null;
  // 改道的路线和原来的流向一模一样：什么都不会变
  same: boolean;
}

// 屏幕上画出来的河：陆地、不是湖、流量不低于门槛
export function isRiverCell(world: World, d: Derived, i: number): boolean {
  return world.causes.land[i] === 1 && d.lake[i] !== 1 && d.discharge[i] >= world.small.planet.riverThreshold;
}

// 一格的上游（流经它的水从哪些格来），含它自己
function upstreamOf(world: World, d: Derived, cell: number): Uint8Array {
  const n = world.mesh.n;
  const off = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) if (d.receiver[i] >= 0) off[d.receiver[i] + 1]++;
  for (let i = 0; i < n; i++) off[i + 1] += off[i];
  const donors = new Int32Array(off[n]);
  const fill = off.slice(0, n);
  for (let i = 0; i < n; i++) if (d.receiver[i] >= 0) donors[fill[d.receiver[i]]++] = i;
  const up = new Uint8Array(n);
  up[cell] = 1;
  const queue = [cell];
  for (let h = 0; h < queue.length; h++) {
    const c = queue[h];
    for (let k = off[c]; k < off[c + 1]; k++) {
      const j = donors[k];
      if (!up[j]) {
        up[j] = 1;
        queue.push(j);
      }
    }
  }
  return up;
}

// 画河：沿拖动经过的格连成一条相邻格的路径（贪心地走向下一个点；德劳内图上一定走得到）。
// 河不会交叉：路线碰到海、湖或别的河就停在那里（汇入）；画到的终点还在陆地上，就顺着地势流下去，
// 同样流到第一条河就汇入。起点本身是河时是“改道”：这条河从这里改走画的路线，
// 它自己的上游不能接（水会绕成圈）。路径不自交，第一格必须是陆地
export function planRiver(world: World, d: Derived, points: number[]): RiverPlan {
  const { mesh, causes } = world;
  const plan: RiverPlan = { cells: [], end: null, join: -1, reroute: false, dried: [], blocked: null, same: false };
  const start = points[0];
  if (start === undefined || start < 0) return plan;
  if (!causes.land[start] || d.lake[start] === 1) return { ...plan, blocked: '要从陆地上开始' };
  const thr = world.small.planet.riverThreshold;
  const isWater = (i: number) => !causes.land[i] || d.lake[i] === 1;
  const isRiver = (i: number) => isRiverCell(world, d, i);
  const reroute = isRiver(start);
  const up = reroute ? upstreamOf(world, d, start) : null;
  const upRiver = (i: number) => up !== null && up[i] === 1 && isRiver(i);
  const canJoin = (i: number) => i !== start && isRiver(i) && !upRiver(i);
  const stops = (i: number) => isWater(i) || canJoin(i);
  // 从地图边上流出去的格
  const edge = (i: number) => causes.land[i] === 1 && mesh.boundary[i] === 1 && d.receiver[i] < 0;

  const path: number[] = [];
  const pos = new Map<number, number>();
  const push = (c: number) => {
    const k = pos.get(c);
    if (k !== undefined) {
      // 绕回到画过的地方：剪掉这个圈
      for (const r of path.splice(k + 1)) pos.delete(r);
      return;
    }
    pos.set(c, path.length);
    path.push(c);
  };
  const done = () => path.length > 1 && stops(path[path.length - 1]);
  let blocked: string | null = null;
  push(start);
  for (const target of points.slice(1)) {
    if (done() || blocked) break;
    let c = path[path.length - 1];
    // 整个星球：按球面上的弦长走（在球面 Delaunay 图上贪心一定走得到）
    const d2 =
      mesh.kind === 'sphere'
        ? (a: number, b: number) => (mesh.p[3 * a] - mesh.p[3 * b]) ** 2 + (mesh.p[3 * a + 1] - mesh.p[3 * b + 1]) ** 2 + (mesh.p[3 * a + 2] - mesh.p[3 * b + 2]) ** 2
        : (a: number, b: number) => (mesh.x[a] - mesh.x[b]) ** 2 + (mesh.y[a] - mesh.y[b]) ** 2;
    for (let guard = 0; c !== target && guard < 10000; guard++) {
      let best = -1;
      let bd = d2(c, target);
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
        const j = mesh.adj[e];
        const dd = d2(j, target);
        if (dd < bd) {
          bd = dd;
          best = j;
        }
      }
      if (best < 0) break;
      c = best;
      push(c);
      if (c !== start && upRiver(c)) {
        blocked = '不能接回自己的上游';
        break;
      }
      if (done()) break;
    }
  }
  if (!blocked && !done()) {
    // 顺着现在的流向流下去；会绕回路线或流进改道的这条河的上游时，改走避开它们的最省力路径
    let c = path[path.length - 1];
    let loop = false;
    for (let guard = 0; guard < mesh.n; guard++) {
      const r = d.receiver[c];
      if (r < 0) break;
      if (pos.has(r) || upRiver(r)) {
        loop = true;
        break;
      }
      push(r);
      c = r;
      if (stops(r)) break;
    }
    if (loop) {
      const rest = pathToTarget(world, d, c, (i) => pos.has(i) || upRiver(i), (i) => stops(i) || edge(i));
      for (const r of rest.slice(1)) push(r);
    }
  }
  const last = path[path.length - 1];
  const end: RiverEnd | null =
    blocked || path.length < 2 ? null : isWater(last) ? (causes.land[last] ? 'lake' : 'sea') : canJoin(last) ? 'river' : edge(last) ? 'edge' : null;
  plan.cells = path;
  plan.end = end;
  plan.join = end === 'river' ? last : -1;
  plan.reroute = reroute;
  plan.blocked = blocked ?? (path.length > 1 && end === null ? '水流不出去' : null);
  if (reroute && end) {
    plan.same = path.every((c, k) => k === path.length - 1 || d.receiver[c] === path[k + 1]);
    // 原来的河道少了起点的水：一路往下，直到入海、入湖，或者回到新路线上（截弯取直，水又回来了）
    const q0 = d.discharge[start];
    const onPath = new Set(path);
    for (let c = d.receiver[start], guard = 0; c >= 0 && !isWater(c) && !onPath.has(c) && guard < mesh.n; c = d.receiver[c], guard++) {
      if (d.discharge[c] >= thr && d.discharge[c] - q0 < thr) plan.dried.push(c);
    }
  }
  return plan;
}

// 从一格出发到最近的目标格，避开 avoid 中的格，偏好下坡
function pathToTarget(world: World, d: Derived, from: number, avoid: (i: number) => boolean, target: (i: number) => boolean): number[] {
  const { mesh } = world;
  const { dist } = graphDistanceOwner(mesh, [from], Infinity, (i, j, e) => {
    if (avoid(j) || (i !== from && target(i))) return Infinity;
    const up = Math.max(0, d.elevation[j] - d.elevation[i]);
    return mesh.dist[e] * (1 + up / 50);
  });
  let to = -1;
  for (let i = 0; i < mesh.n; i++) if (i !== from && target(i) && Number.isFinite(dist[i]) && (to < 0 || dist[i] < dist[to])) to = i;
  if (to < 0) return [from];
  const path = [to];
  let cur = to;
  for (let guard = 0; cur !== from && guard < mesh.n; guard++) {
    let best = -1;
    let bd = dist[cur];
    for (let e = mesh.off[cur]; e < mesh.off[cur + 1]; e++) {
      const j = mesh.adj[e];
      if (dist[j] < bd) {
        bd = dist[j];
        best = j;
      }
    }
    if (best < 0) break;
    path.push(best);
    cur = best;
  }
  return path.reverse();
}

// 圈一片：圈里的格与边上的过渡带。t 的含义与画笔相同（≤ 0.7 一定变，0.7–1 是海岸过渡带，
// 由海岸噪声决定海岸线在哪），所以圈出来的海岸也有自然的湾和岬：圈的边线上 t = 0.85，
// 往里一个带宽降到 0.7，往外一个带宽升到 1。t 保留三位小数（要写进命令）
export function lassoBandKm(world: World): number {
  const cellKm = world.mesh.spacing * world.kmPerUnit;
  // 整个星球按半圈（πR）算，与画笔的范围一致
  const widthKm = world.mesh.kind === 'sphere' ? world.kmPerUnit : world.mesh.width * world.kmPerUnit;
  return Math.max(cellKm * 1.2, widthKm * 0.005);
}

export function lassoStroke(world: World, points: [number, number][]): { cells: number[]; t: number[] } {
  const { mesh } = world;
  const out: { cells: number[]; t: number[] } = { cells: [], t: [] };
  const m = points.length;
  if (m < 3) return out;
  const band = lassoBandKm(world) / world.kmPerUnit;
  // 整个星球：圈的点已经展开（连续），格的经度在圈附近展开后照平面的办法算
  const X = unwrappedX(mesh, meanX(points));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  x0 -= band;
  y0 -= band;
  x1 += band;
  y1 += band;
  // 边按网格分桶：算离边多远只看附近的边；算在不在圈里只看同一行的边（向右的射线数交点）
  const g = Math.max(band, mesh.spacing);
  const cols = Math.max(1, Math.ceil((x1 - x0) / g));
  const rows = Math.max(1, Math.ceil((y1 - y0) / g));
  const near: number[][] = Array.from({ length: cols * rows }, () => []);
  const rowEdges: number[][] = Array.from({ length: rows }, () => []);
  const col = (x: number) => Math.min(cols - 1, Math.max(0, Math.floor((x - x0) / g)));
  const row = (y: number) => Math.min(rows - 1, Math.max(0, Math.floor((y - y0) / g)));
  for (let k = 0; k < m; k++) {
    const [ax, ay] = points[k];
    const [bx, by] = points[(k + 1) % m];
    for (let r = row(Math.min(ay, by) - band); r <= row(Math.max(ay, by) + band); r++) {
      for (let c = col(Math.min(ax, bx) - band); c <= col(Math.max(ax, bx) + band); c++) near[r * cols + c].push(k);
    }
    for (let r = row(Math.min(ay, by)); r <= row(Math.max(ay, by)); r++) rowEdges[r].push(k);
  }
  for (let i = 0; i < mesh.n; i++) {
    const px = X ? X(i) : mesh.x[i];
    const py = mesh.y[i];
    if (px < x0 || px > x1 || py < y0 || py > y1) continue;
    let inside = false;
    for (const k of rowEdges[row(py)]) {
      const [ax, ay] = points[k];
      const [bx, by] = points[(k + 1) % m];
      if (ay > py !== by > py && px < ax + ((py - ay) / (by - ay)) * (bx - ax)) inside = !inside;
    }
    let dist = Infinity;
    for (const k of near[row(py) * cols + col(px)]) {
      const [ax, ay] = points[k];
      const [bx, by] = points[(k + 1) % m];
      const dx = bx - ax;
      const dy = by - ay;
      const l2 = dx * dx + dy * dy;
      const u = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
      dist = Math.min(dist, Math.hypot(px - ax - u * dx, py - ay - u * dy));
    }
    if (!inside && dist >= band) continue;
    const s = inside ? Math.min(dist, band) : -dist;
    const t = s >= band ? 0 : 0.85 - 0.15 * (s / band);
    out.cells.push(i);
    out.t.push(Math.round(Math.min(1, t) * 1000) / 1000);
  }
  return out;
}

// 圈里的格（格中心在圈内）：按行分桶，每格只和同一行的边数交点。按编号排好
export function ringCells(world: World, points: [number, number][]): number[] {
  const { mesh } = world;
  const m = points.length;
  if (m < 3) return [];
  let y0 = Infinity;
  let y1 = -Infinity;
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  const g = mesh.spacing * 2;
  const X = unwrappedX(mesh, meanX(points));
  const rows = Math.max(1, Math.ceil((y1 - y0) / g));
  const row = (y: number) => Math.min(rows - 1, Math.max(0, Math.floor((y - y0) / g)));
  const rowEdges: number[][] = Array.from({ length: rows }, () => []);
  for (let k = 0; k < m; k++) {
    const ay = points[k][1];
    const by = points[(k + 1) % m][1];
    for (let r = row(Math.min(ay, by)); r <= row(Math.max(ay, by)); r++) rowEdges[r].push(k);
  }
  const out: number[] = [];
  for (let i = 0; i < mesh.n; i++) {
    const px = X ? X(i) : mesh.x[i];
    const py = mesh.y[i];
    if (px < x0 || px > x1 || py < y0 || py > y1) continue;
    let inside = false;
    for (const k of rowEdges[row(py)]) {
      const [ax, ay] = points[k];
      const [bx, by] = points[(k + 1) % m];
      if (ay > py !== by > py && px < ax + ((py - ay) / (by - ay)) * (bx - ax)) inside = !inside;
    }
    if (inside) out.push(i);
  }
  return out;
}

// 圈绕着极点几圈（整个星球）：沿圈走一周经度一共变了多少个整圈。不为 0 时这个圈在平铺图上围不住任何地方
export function ringWinding(points: [number, number][]): number {
  let total = 0;
  for (let k = 0; k < points.length; k++) {
    const a = points[k][0];
    const b = points[(k + 1) % points.length][0];
    total += wrapDelta(b - a);
  }
  return Math.round(total / 2);
}

// 剪刀：画的折线是一道墙。省内相邻两格的连线和折线相交，这条连接就断开，再求连通块，
// 所以线经过的格不会被“吃掉”，切口就在线所在的位置（精度半格）。
// 线的两端没出省界时，沿着两端的方向延长到省界外。切成几块就是几个省：最大的一块留原来的省，
// 其余每块各成一个新省；只有一格的碎块并回最大的那块。锁定的省份不切。
// 只有线在这一端所在的省里走了足够长（至少两格，并且至少是线长的四分之一）才延长这一端：
// 从邻省外一格画起时，这一端只在邻省里走了一格，不延长，邻省不会被切开。
// extend: false 时不延长（切线命令收到的是界面上已经延长、化简好的线）
export interface CutResult {
  // 实际用来切的线（含两端的延长）；before / after：两端各延长了几个点
  line: [number, number][];
  before: number;
  after: number;
  // 每个被切开的省：parts[0] 留原省，其余每块成一个新省
  plans: { id: number; parts: number[][] }[];
}

export function cutProvinces(world: World, raw: [number, number][], opts: { extend?: boolean } = {}): CutResult {
  const { mesh, causes, small } = world;
  const out: CutResult = { line: raw, before: 0, after: 0, plans: [] };
  if (raw.length < 2) return out;
  const cuttable = (id: number) => id >= 0 && !!small.provinces[id] && !small.provinces[id].locked;
  const sphere = mesh.kind === 'sphere';
  // 整个星球东西相接：只看南北
  const inside = (x: number, y: number) => (sphere ? y >= 0 && y <= 1 : x >= 0 && y >= 0 && x <= mesh.width && y <= mesh.height);
  let rawLength = 0;
  for (let k = 0; k + 1 < raw.length; k++) rawLength += Math.hypot(raw[k + 1][0] - raw[k][0], raw[k + 1][1] - raw[k][1]);
  // 从一端沿线往回走（每步 0.3 格），一直在省 id 里的那一段有多长
  const runFromEnd = (fromEnd: boolean, id: number) => {
    const step = mesh.spacing * 0.3;
    let run = 0;
    let hint = 0;
    for (let k = 0; k + 1 < raw.length; k++) {
      const [x0, y0] = fromEnd ? raw[raw.length - 1 - k] : raw[k];
      const [x1, y1] = fromEnd ? raw[raw.length - 2 - k] : raw[k + 1];
      const len = Math.hypot(x1 - x0, y1 - y0);
      const steps = Math.max(1, Math.ceil(len / step));
      for (let j = 1; j <= steps; j++) {
        const x = x0 + ((x1 - x0) * j) / steps;
        const y = y0 + ((y1 - y0) * j) / steps;
        if (!inside(x, y)) return run;
        hint = findCell(mesh, x, y, hint);
        if (causes.province[hint] !== id) return run;
        run += len / steps;
      }
    }
    return run;
  };
  // 两端延长：沿端点附近一段的方向一步半格往外走，直到出了端点所在的省
  const extend = (end: [number, number], from: [number, number], fromEnd: boolean): [number, number][] => {
    if (opts.extend === false) return [];
    const id = causes.province[findCell(mesh, end[0], end[1])];
    if (!cuttable(id)) return [];
    if (runFromEnd(fromEnd, id) < Math.max(2 * mesh.spacing, 0.25 * rawLength)) return [];
    const dx = end[0] - from[0];
    const dy = end[1] - from[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return [];
    const step = mesh.spacing * 0.5;
    let [x, y] = end;
    for (let k = 0; k < 4000; k++) {
      x += (dx / len) * step;
      y += (dy / len) * step;
      if (!inside(x, y) || causes.province[findCell(mesh, x, y)] !== id) return [[x + (dx / len) * step, y + (dy / len) * step]];
    }
    return [];
  };
  // 方向取端点往回约三格处，手抖不影响
  const back = (pts: [number, number][], fromEnd: boolean): [number, number] => {
    const reach = mesh.spacing * 3;
    const end = fromEnd ? pts[pts.length - 1] : pts[0];
    for (let k = 1; k < pts.length; k++) {
      const p = fromEnd ? pts[pts.length - 1 - k] : pts[k];
      if (Math.hypot(p[0] - end[0], p[1] - end[1]) >= reach) return p;
    }
    return fromEnd ? pts[0] : pts[pts.length - 1];
  };
  const head = extend(raw[0], back(raw, false), false).reverse();
  const tail = extend(raw[raw.length - 1], back(raw, true), true);
  const line: [number, number][] = [...head, ...raw, ...tail];
  out.line = line;
  out.before = head.length;
  out.after = tail.length;
  // 线经过哪些省
  const ids = new Set<number>();
  for (let k = 0; k + 1 < line.length; k++) {
    const [x0, y0] = line[k];
    const [x1, y1] = line[k + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (mesh.spacing * 0.3)));
    let hint = 0;
    for (let j = 0; j <= steps; j++) {
      const x = x0 + ((x1 - x0) * j) / steps;
      const y = y0 + ((y1 - y0) * j) / steps;
      if (!inside(x, y)) continue;
      hint = findCell(mesh, x, y, hint);
      if (cuttable(causes.province[hint])) ids.add(causes.province[hint]);
    }
  }
  // 线段相交：点在线上算在正的一侧，规则一致，不会两边都算或都不算
  const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax) >= 0 ? 1 : -1);
  const segs = line.slice(0, -1).map((p, k) => {
    const q = line[k + 1];
    return { ax: p[0], ay: p[1], bx: q[0], by: q[1], x0: Math.min(p[0], q[0]), x1: Math.max(p[0], q[0]), y0: Math.min(p[1], q[1]), y1: Math.max(p[1], q[1]) };
  });
  const blocked = (a: number, b: number) => {
    if (sphere) {
      // 两格之间的连线展开到同一边；越过极点的连线（经度差很大）不算被切
      const ax0 = mesh.x[a];
      const bx0 = ax0 + wrapDelta(mesh.x[b] - ax0);
      if (Math.abs(bx0 - ax0) > 0.5) return false;
      const ay = mesh.y[a];
      const by = mesh.y[b];
      for (const g of segs) {
        // 把连线平移到线段所在的那一份
        const shift = 2 * Math.round(((g.ax + g.bx) / 2 - (ax0 + bx0) / 2) / 2);
        const ax = ax0 + shift;
        const bx = bx0 + shift;
        if (g.x1 < Math.min(ax, bx) || g.x0 > Math.max(ax, bx) || g.y1 < Math.min(ay, by) || g.y0 > Math.max(ay, by)) continue;
        if (orient(g.ax, g.ay, g.bx, g.by, ax, ay) !== orient(g.ax, g.ay, g.bx, g.by, bx, by) && orient(ax, ay, bx, by, g.ax, g.ay) !== orient(ax, ay, bx, by, g.bx, g.by)) return true;
      }
      return false;
    }
    const ax = mesh.x[a];
    const ay = mesh.y[a];
    const bx = mesh.x[b];
    const by = mesh.y[b];
    const x0 = Math.min(ax, bx);
    const x1 = Math.max(ax, bx);
    const y0 = Math.min(ay, by);
    const y1 = Math.max(ay, by);
    for (const g of segs) {
      if (g.x1 < x0 || g.x0 > x1 || g.y1 < y0 || g.y0 > y1) continue;
      if (orient(g.ax, g.ay, g.bx, g.by, ax, ay) !== orient(g.ax, g.ay, g.bx, g.by, bx, by) && orient(ax, ay, bx, by, g.ax, g.ay) !== orient(ax, ay, bx, by, g.bx, g.by)) return true;
    }
    return false;
  };
  // 省内连通块：wall 为 true 时线是墙
  const components = (cells: number[], id: number, wall: boolean) => {
    const of = new Map<number, number>();
    const comps: number[][] = [];
    for (const c of cells) {
      if (of.has(c)) continue;
      const q = [c];
      of.set(c, comps.length);
      for (let h = 0; h < q.length; h++) {
        const u = q[h];
        for (let e = mesh.off[u]; e < mesh.off[u + 1]; e++) {
          const v = mesh.adj[e];
          if (causes.province[v] !== id || of.has(v) || (wall && blocked(u, v))) continue;
          of.set(v, comps.length);
          q.push(v);
        }
      }
      comps.push(q);
    }
    return { of, comps };
  };
  for (const id of ids) {
    const cells = provinceCells(world, id);
    // 原来就分成几块的省（比如几个岛）：只看被线切开的那一块，别的飞地不算新切出来的
    const natural = components(cells, id, false).of;
    const byNatural = new Map<number, number[][]>();
    for (const piece of components(cells, id, true).comps) {
      const k = natural.get(piece[0])!;
      byNatural.set(k, [...(byNatural.get(k) ?? []), piece]);
    }
    const keep: number[] = [];
    const pieces: number[][] = [];
    for (const group of byNatural.values()) {
      group.sort((a, b) => b.length - a.length);
      // 每块里最大的留在原省；只有一格的碎块也并回去
      keep.push(...group[0]);
      for (const piece of group.slice(1)) {
        if (piece.length < 2) keep.push(...piece);
        else pieces.push(piece);
      }
    }
    if (pieces.length) out.plans.push({ id, parts: [keep, ...pieces] });
  }
  return out;
}

// 画笔：圆形范围内的格、到中心的归一化距离 t（0 中心，1 边缘）与平滑衰减的权重
// 只在画笔附近往外找（不分配整张图大小的数组），格按编号排列。
// 画笔不到一格半时，鼠标下的那一格 t = 0：最小的笔刷正好涂一格，而且一定涂得到；
// 不到半格时只涂鼠标下那一格
export function brushCells(world: World, cx: number, cy: number, radiusKm: number): { cells: number[]; t: number[]; weights: number[] } {
  const { mesh, kmPerUnit } = world;
  const r = radiusKm / kmPerUnit;
  const center = findCell(mesh, cx, cy);
  if (r < mesh.spacing * 0.5) return { cells: [center], t: [0], weights: [1] };
  const reach = r + mesh.spacing;
  // 整个星球：到画笔中心的球面距离（地图单位），所以画笔在高纬度、接缝上也是真实大小的圆
  const c0 = mesh.kind === 'sphere' ? toUnit(cx, cy) : null;
  const dist =
    mesh.kind === 'sphere' && c0
      ? (i: number) => arc(c0, [mesh.p[3 * i], mesh.p[3 * i + 1], mesh.p[3 * i + 2]]) / Math.PI
      : (i: number) => Math.hypot(mesh.x[i] - cx, mesh.y[i] - cy);
  const seen = new Set<number>([center]);
  const queue = [center];
  const found: number[] = [];
  for (let h = 0; h < queue.length; h++) {
    const c = queue[h];
    if (dist(c) <= r) found.push(c);
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
      const j = mesh.adj[e];
      if (seen.has(j)) continue;
      seen.add(j);
      if (dist(j) <= reach) queue.push(j);
    }
  }
  const tiny = r < mesh.spacing * 1.5;
  if (tiny && !found.includes(center)) found.push(center);
  found.sort((a, b) => a - b);
  const cells: number[] = [];
  const t: number[] = [];
  const weights: number[] = [];
  for (const i of found) {
    const u = tiny && i === center ? 0 : Math.min(1, dist(i) / r);
    cells.push(i);
    t.push(u);
    weights.push(1 - u * u * (3 - 2 * u));
  }
  return { cells, t, weights };
}

// ---------- 自定义走向（第八轮）：河完全照着画的线走 ----------
//
// 画的线先磨圆、化简成折线（存进命令的就是它），河道是折线经过的格：沿折线每隔四分之一格取一点，
// 每点所在的格依次连起来（跳过了格就用两边都挨着的格补上）。所以屏幕上画的线、存下的折线、河道三者一致。
// 碰到别的河不停，照着画的走（会截走那条河，界面上先问一句）；进海、进湖就结束，多画的丢掉

export type CourseEnd = 'sea' | 'lake' | 'river' | 'edge' | 'sink';

export interface CourseCrossing {
  // 河道上穿过别的河的那一段（cells 的下标，含两端）
  from: number;
  to: number;
  // 穿过的第一格（按它找那条河的名字）
  cell: number;
  // 这一段属于哪条画的河；自然的河为 null
  guide: string | null;
  // 截走以后下游会变干的格（估算，按原来的流向排列）
  dried: number[];
}

export interface CoursePlan {
  // 相邻格组成的河道：画的线经过的格，再加上画完之后顺地势流下去的那段（endOnLand 为 flow 时）
  cells: number[];
  // 画的折线（已化简、取整）：存进命令的是 encodePath(path)。折线上每隔四分之一格取的点都落在 cells 里
  path: [number, number][];
  // 画的线到 cells 的第几格为止（之后是顺地势流下去的那段）
  drawn: number;
  // 流到哪里；画不出时为 null
  end: CourseEnd | null;
  // 汇入的那一格（end 为 river 时），否则 -1
  join: number;
  // 从一条河上开始画：这条河从这里改走画的路线（命令里的 reroute）
  reroute: boolean;
  // 改道从 cells 的第几格起（新画的河是 0；从一条河中间改道、河的上游一起留着时是上游的格数，见 rerouteCourse）
  rerouteAt: number;
  // 终点是一条画的、有泉水的河的源头：接到它前面，成为同一条河（见 mergeCourse）
  merge: string | null;
  crossings: CourseCrossing[];
  // 改道后原来的河道里会变干的格（估算）
  dried: number[];
  // 丢掉的那段线（进了海、湖或出了地图之后画的），灰色显示
  cut: [number, number][] | null;
  // 从海、湖往陆地上画的（从河口往上游画）：已经倒过来了
  reversed: boolean;
  // 估算（按现在的高程，挖法与 bedLevels 相同）：穿山挖出的峡谷最深多少米；有一段要往高处流多少米
  gorge: number;
  uphill: number;
  // 画不出来的原因
  blocked: string | null;
  // 画的线绕回了自己走过的格、剪掉的圈（每个圈是那一段取样点）：预览里黄色标出来，提示一声（第十三轮）
  loops: [number, number][][];
  // 这一笔新画的是 path 的第几个点到第几个点（重画一段、接着画时前后不动的不算；省略为整条）：重叠分析只看这一段
  changed?: [number, number];
  // 贴着别的河画、没有穿过去：在第一次碰到它的地方汇入（不截走它），这是碰到的那一格（第十三轮）
  touch?: number;
}

export interface CourseOptions {
  // 画到的终点还在陆地上时：顺着地势接着流（flow），还是在那里消失（sink）
  endOnLand: 'flow' | 'sink';
  // 画的时候一个屏幕像素合多少地图单位：化简的容差不小于它（缩小时画的手抖不记下来）
  px?: number;
  // 这条画的河自己的格不算交叉、不能汇入（重画它的一段时）
  ignoreGuide?: string;
  // 接着画的那段（base）是一条河从源头到起笔的那一格：从它的最后一格改道（见 rerouteCourse）。
  // own：这条河自己的格（往下的那段不能汇入：画到上面时顺着流下去，还是这一条河）
  reroute?: { own: readonly number[] };
}

type Pt = [number, number];

export const emptyPlan = (): CoursePlan => ({
  cells: [],
  path: [],
  drawn: 0,
  end: null,
  join: -1,
  reroute: false,
  rerouteAt: 0,
  merge: null,
  crossings: [],
  dried: [],
  cut: null,
  reversed: false,
  gorge: 0,
  uphill: 0,
  blocked: null,
  loops: [],
});

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
  if (stroke.length < 2) return { ...emptyPlan(), blocked: '画得太短了' };
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
  if (pts.length < 2) return { ...emptyPlan(), reversed, blocked: '画得太短了' };
  return courseFrom(world, d, { cells: [], path: [] }, pts, opts, reversed);
}

// 重画一段后折线的点数超出能存的
export const TOO_LONG = '这条河太长了，这一段改不了';

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
      if (!next) return { ...plan, blocked: '新画的一段碰到了这条河自己' };
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
  if (!trace) return { ...plan, blocked: '画的线太乱了，换个画法' };
  const cells = trace.cells;
  if (cells.length < 2) return { ...plan, blocked: '画得太短了' };
  plan.path = fixed ? [...base.path, ...pts.slice(1)] : pts;
  // 剪了很多圈之后点数可能超出能存的
  if (plan.path.length > COURSE_MAX_POINTS) return { ...plan, blocked: fixed ? TOO_LONG : '画的线太乱了，换个画法' };
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

// ---------- 重叠分析（第十三轮）：画出来的河会不会绕回自己旁边、贴着别的河流、终点挨着河，改道后旧河道还有没有水 ----------
// 只是提示（预览里黄色标出那一段，提示条、顶部的话里说一声）；只有“在终点消失、终点又回到自己旁边”这一种不让画（SINK_LOOP）

export const SINK_LOOP = '这样河会绕回自己旁边：画开一点，或者画到别的河上汇入';

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
  if (stroke.length < 2) return { blocked: '画得太短了' };
  const P0 = guidePoints(world, g);
  if (P0.length < 2) return { blocked: '没法从这里改' };
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
  if (p0.d > opts.tol) return { blocked: '要从这条河上开始画' };
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
  if (a.k < 0) return { blocked: '没法从这里改' };
  const water = (i: number) => !causes.land[i] || d.lake[i] === 1;
  const prefixPath = dedupe([...P0.slice(0, p0.seg + 1), a.p]);
  // 新画的一段少用点：接上前后不动的两段后不超过能存的点数
  const keep = middle ? P0.length - (pe.seg - p0.seg) + 2 : p0.seg + 2;
  const drawn = simplifyStroke(world, raw, opts.px, COURSE_MAX_POINTS - keep);
  const sub = { ...opts, ignoreGuide: g.id };

  if (middle) {
    const b = indexOf(pe);
    if (b.k <= a.k) return { blocked: '这一段太短了' };
    let Q = dedupe([a.p, ...drawn.slice(1, -1), b.p]);
    let t = traceCourse(world, Q, C.slice(0, a.k + 1), water);
    // 新画的一段自己绕了圈：剪掉（碰到前面不动的那段就画不了）
    for (let iter = 0; t.loop && iter < 40; iter++) {
      const next = cutLoop(Q, t, a.k + 1);
      if (!next) return { blocked: '新画的一段碰到了这条河自己' };
      Q = next;
      t = traceCourse(world, Q, C.slice(0, a.k + 1), water);
    }
    const suffix = C.slice(b.k);
    const lastIn = t.cells[t.cells.length - 1];
    const clean = !t.loop && t.stop < 0 && lastIn === C[b.k];
    if (clean) {
      const mid = t.cells.slice(a.k + 1, -1);
      const tail = new Set(suffix);
      if (mid.some((c) => tail.has(c))) return { blocked: '新画的一段碰到了这条河自己' };
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
  if (!g.path) return { blocked: '没法从这里改' };
  const pts = decodePath(g.path);
  const last = pts[pts.length - 1];
  const m = g.cells.indexOf(findCell(world.mesh, last[0], last[1], g.cells[g.cells.length - 1]));
  if (m < 1) return { blocked: '没法从这里改' };
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
  if (input.length < 2) return { ...emptyPlan(), reversed, blocked: '画得太短了' };
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
  if (sea.length) out.push({ text: '有一段在海里', why: '河道有几格后来成了海（改了陆海）：那几格不画河，水在那里入海', cells: sea });
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
      ? `从这里起这一格是后画的「${taker.name || '另一条画的河'}」的：水跟着它走了（它截走了这一段）。重画这一段，或者删掉、改那条河`
      : d.lake[off[0]] === 1
        ? '这一段后来成了湖：水流进湖里，从湖的出口流出去'
        : '照画的走水会绕回自己（地形改过以后常有），这几格按地势流了：重画这一段';
    out.push({ text: '有一段没按画的走', why, cells: off });
  }
  if (g.spring && dry) out.push({ text: '有一段水被截走了', why: '画的河里有几格没有水了（上游被别的河截走）', cells: cells.filter((c) => land[c] && d.lake[c] !== 1 && d.discharge[c] < thr) });
  if (guideEnd(world, d, g).kind === 'unknown') out.push({ text: '水流不出去', why: '终点之后顺着地势流不到海、湖、别的河：画到海里、湖里或别的河上，或者让它停在终点（底部“终点：停在这”）', cells: [cells[cells.length - 1]] });
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

