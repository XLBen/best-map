import { arc, fromUnit, localOffset, toUnit, wrapDelta } from './geo';
import { type Mesh, findCell, graphDistanceOwner, ringDistance } from './mesh';
import { isVegetated } from './vegetation';
import type { Derived, World } from './world';

// 选区与延伸：所有结果都是明确的格列表，交给命令保存，保证重放与推导状态无关

// 整个星球：一串（已展开的）经度的平均值，格的经度在它附近展开后再按平面的办法判断
function meanX(points: [number, number][]): number {
  let s = 0;
  for (const p of points) s += p[0];
  return s / points.length;
}
const unwrappedX = (mesh: Mesh, ref: number) => (mesh.kind === 'sphere' ? (i: number) => ref + wrapDelta(mesh.x[i] - ref) : null);

export interface FloodOptions {
  sameClass?: boolean;
  sameDominant?: boolean;
  sameBasin?: boolean;
  sameProvince?: boolean;
  maxSlope?: number;
  maxSteps?: number;
}

export function floodSelect(world: World, d: Derived, seed: number, o: FloodOptions): number[] {
  const { causes } = world;
  const allow = (j: number) =>
    (!o.sameClass || causes.land[j] === causes.land[seed]) &&
    (!o.sameDominant || d.dominant[j] === d.dominant[seed]) &&
    (!o.sameBasin || d.basin[j] === d.basin[seed]) &&
    (!o.sameProvince || causes.province[j] === causes.province[seed]) &&
    (o.maxSlope === undefined || d.slope[j] <= o.maxSlope);
  const dist = ringDistance(world.mesh, [seed], o.maxSteps ?? Infinity, allow);
  const out: number[] = [];
  for (let i = 0; i < dist.length; i++) if (dist[i] >= 0) out.push(i);
  return out;
}

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

// 河道引导路径：两格之间偏好下坡、避开海的最短路径
export function riverPath(world: World, d: Derived, from: number, target: number): number[] {
  const { mesh, causes } = world;
  // 终点在海上：落到离点击处最近的近岸海格，河在那里入海
  let to = target;
  if (!causes.land[target]) {
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < mesh.n; i++) {
      if (causes.land[i]) continue;
      let coastal = false;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (causes.land[mesh.adj[e]]) coastal = true;
      if (!coastal) continue;
      const dd = (mesh.x[i] - mesh.x[target]) ** 2 + (mesh.y[i] - mesh.y[target]) ** 2;
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    }
    if (best < 0) return [];
    to = best;
  }
  const { dist } = graphDistanceOwner(mesh, [from], Infinity, (i, j, e) => {
    if (!causes.land[j] && j !== to) return Infinity;
    const up = Math.max(0, d.elevation[j] - d.elevation[i]);
    return mesh.dist[e] * (1 + up / 50);
  });
  if (!Number.isFinite(dist[to])) return [];
  // 回溯：从终点每次走到满足 dist[j] + cost = dist[i] 的邻居
  const path = [to];
  let cur = to;
  let guard = mesh.n;
  while (cur !== from && guard-- > 0) {
    let best = -1;
    let bd = Infinity;
    for (let e = mesh.off[cur]; e < mesh.off[cur + 1]; e++) {
      const j = mesh.adj[e];
      if (dist[j] < bd) {
        bd = dist[j];
        best = j;
      }
    }
    if (best < 0 || bd >= dist[cur]) break;
    path.push(best);
    cur = best;
  }
  return path.reverse();
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
