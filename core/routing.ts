import { MinHeap } from './heap';
import type { Mesh } from './mesh';

// 汇流路由：Priority-Flood 填洼后按最陡下降确定每格的下游。
// 结果保证无环、全部流向出口；order 中下游格总在上游格之前。
export interface Routing {
  // 填洼后的水面高度（洼地被填到溢出口）
  water: Float64Array;
  // 下游格；出口格指向相邻的非活动格（海），贴图边的出口为 -1
  receiver: Int32Array;
  // 到下游格的边（adj 中的下标）；没有下游或下游不是邻格时为 -1
  edge: Int32Array;
  order: Int32Array;
  count: number;
}

export function route(mesh: Mesh, h: ArrayLike<number>, active: Uint8Array, forced?: Int32Array, terminal?: Uint8Array): Routing {
  return new Router(mesh, active, forced, terminal).route(h);
}

// 第八十八轮（提速）：逐格的几段循环放进模块里的小函数（原样照搬，结果逐值相同）。以前写在构造函数与 route 里：
// 水文的路由多半一步只求一次，有了画的河（强制方向）以后头一次走到没走过的分支时整个 route 退回解释执行，
// 后面几次改一笔（放湖、挪纬度）的路由慢三四倍；小函数各自编译优化，一处退回不拖累别的

// 活动格（按编号写进 cells）与其中的出口格（与非活动格相邻、贴图边或另外当作出口的，标进 outlet、写进 outlets）。
// 返回活动格数，出口格数写进 count[0]
function activeCells(mesh: Mesh, active: Uint8Array, terminal: Uint8Array | null, cells: Int32Array, outlets: Int32Array, outlet: Uint8Array, count: Int32Array): number {
  const { off, adj, boundary } = mesh;
  let nc = 0;
  let no = 0;
  for (let i = 0; i < mesh.n; i++) {
    if (!active[i]) continue;
    cells[nc++] = i;
    let out = boundary[i] === 1 || (terminal !== null && terminal[i] === 1);
    for (let e = off[i]; e < off[i + 1] && !out; e++) if (!active[adj[e]]) out = true;
    if (out) {
      outlet[i] = 1;
      outlets[no++] = i;
    }
  }
  count[0] = no;
  return nc;
}

// 活动格回到求之前的样子（不活动的格在构造时定好、从不改）
function resetCells(cells: Int32Array, water: Float64Array, receiver: Int32Array, edge: Int32Array, pop: Int32Array, sink: Uint8Array, closed: Uint8Array): void {
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    water[i] = -Infinity;
    receiver[i] = -1;
    edge[i] = -1;
    pop[i] = -1;
    sink[i] = 0;
    closed[i] = 0;
  }
}

// 有强制方向的活动格与到强制下游的边（与按边逐个比对的结果相同：取最后一条指向它的边）；消失的那一格不再往下流
function forcedOf(mesh: Mesh, cells: Int32Array, forced: Int32Array, terminal: Uint8Array | null, fc: number[], fe: number[]): void {
  const { off, adj } = mesh;
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    if (forced[i] < 0 || (terminal !== null && terminal[i] === 1)) continue;
    let edge = -1;
    for (let e = off[i]; e < off[i + 1]; e++) if (adj[e] === forced[i]) edge = e;
    fc.push(i);
    fe.push(edge);
  }
}

// 出口格先入堆，下游指向最低的相邻非活动格
function seedOutlets(mesh: Mesh, h: ArrayLike<number>, active: Uint8Array, outlets: Int32Array, water: Float64Array, receiver: Int32Array, edge: Int32Array, closed: Uint8Array, heap: MinHeap): void {
  const { off, adj } = mesh;
  for (let k = 0; k < outlets.length; k++) {
    const i = outlets[k];
    let lowest = -1;
    let lowestEdge = -1;
    for (let e = off[i]; e < off[i + 1]; e++) {
      const j = adj[e];
      if (!active[j] && (lowest < 0 || h[j] < h[lowest])) {
        lowest = j;
        lowestEdge = e;
      }
    }
    receiver[i] = lowest;
    edge[i] = lowestEdge;
    water[i] = h[i];
    closed[i] = 1;
    heap.push(i, h[i]);
  }
}

// 从堆里的格开始淹：依次弹出最低的格，未入堆的活动邻格以 max(自身高度, 当前水面) 入堆。返回已弹出的格数
function flood(mesh: Mesh, h: ArrayLike<number>, water: Float64Array, pop: Int32Array, closed: Uint8Array, heap: MinHeap, counter: number): number {
  const { off, adj } = mesh;
  while (heap.size) {
    const c = heap.pop();
    pop[c] = counter++;
    const wc = water[c];
    for (let e = off[c]; e < off[c + 1]; e++) {
      const j = adj[e];
      if (closed[j]) continue;
      closed[j] = 1;
      water[j] = Math.max(h[j], wc);
      heap.push(j, water[j]);
    }
  }
  return counter;
}

// 没被淹到的活动格里最低的（没有时 −1）
function lowestOpen(h: ArrayLike<number>, cells: Int32Array, closed: Uint8Array): number {
  let low = -1;
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    if (!closed[i] && (low < 0 || h[i] < h[low])) low = i;
  }
  return low;
}

// 最陡下降；平地上沿洪泛顺序流向更早被淹到的格（即朝出口方向）
function descend(mesh: Mesh, cells: Int32Array, outlet: Uint8Array, sink: Uint8Array, water: Float64Array, pop: Int32Array, receiver: Int32Array, edge: Int32Array): void {
  const { off, adj, dist } = mesh;
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    if (pop[i] < 0 || outlet[i] || sink[i]) continue;
    const wi = water[i];
    const pi = pop[i];
    let best = -1;
    let bestEdge = -1;
    let bestSlope = -1;
    let bestPop = Infinity;
    for (let e = off[i]; e < off[i + 1]; e++) {
      const j = adj[e];
      // 非活动格与没被淹到的格 pop 都是 -1
      const pj = pop[j];
      if (pj < 0) continue;
      const dw = wi - water[j];
      if (dw < 0 || (dw === 0 && pj > pi)) continue;
      const slope = dw / dist[e];
      if (slope > bestSlope || (slope === bestSlope && pj < bestPop)) {
        best = j;
        bestEdge = e;
        bestSlope = slope;
        bestPop = pj;
      }
    }
    receiver[i] = best;
    edge[i] = bestEdge;
  }
}

// 强制方向换上去
function applyForced(forced: Int32Array, forcedCells: Int32Array, forcedEdge: Int32Array, receiver: Int32Array, edge: Int32Array): void {
  for (let k = 0; k < forcedCells.length; k++) {
    receiver[forcedCells[k]] = forced[forcedCells[k]];
    edge[forcedCells[k]] = forcedEdge[k];
  }
}

// 强制方向造成了环：没排到的格（环上的）恢复为自然方向
function undoCycles(n: number, cells: Int32Array, order: Int32Array, count: number, natural: Int32Array, naturalEdge: Int32Array, receiver: Int32Array, edge: Int32Array): void {
  const reached = new Uint8Array(n);
  for (let k = 0; k < count; k++) reached[order[k]] = 1;
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    if (reached[i]) continue;
    receiver[i] = natural[i];
    edge[i] = naturalEdge[i];
  }
}

// 无强制方向时洪泛顺序本身就是拓扑序
function popOrder(cells: Int32Array, pop: Int32Array, order: Int32Array): void {
  for (let k = 0; k < cells.length; k++) if (pop[cells[k]] >= 0) order[pop[cells[k]]] = cells[k];
}

// 从根（下游不是活动格）出发沿上游方向广度优先，得到下游在前的顺序。返回排到的格数（有环时少于活动格数）
function topoOrder(n: number, active: Uint8Array, cells: Int32Array, receiver: Int32Array, order: Int32Array, start: Int32Array, donors: Int32Array): number {
  // 先按下游数上游格，同时按编号收集根；再从后往前填，每组内仍按编号从小到大
  start.fill(0);
  let count = 0;
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    const r = receiver[i];
    if (r >= 0 && active[r]) start[r]++;
    else order[count++] = i;
  }
  for (let i = 1; i <= n; i++) start[i] += start[i - 1];
  for (let k = cells.length - 1; k >= 0; k--) {
    const i = cells[k];
    const r = receiver[i];
    if (r >= 0 && active[r]) donors[--start[r]] = i;
  }
  // 现在 r 的上游格是 donors[start[r] .. start[r + 1])
  for (let q = 0; q < count; q++) {
    const c = order[q];
    for (let k = start[c]; k < start[c + 1]; k++) order[count++] = donors[k];
  }
  return count;
}

// 同一组活动格与强制方向下反复求路由（高程迭代用）：活动格表、出口格与缓冲区只建一次。
// 结果的数组下次调用时会被覆盖；活动格与强制方向在用它的期间不能改
export class Router {
  private readonly mesh: Mesh;
  private readonly active: Uint8Array;
  private readonly forced: Int32Array | undefined;
  // 活动格（按编号）；其中的出口格：与非活动格相邻或贴图边
  private readonly cells: Int32Array;
  private readonly outlets: Int32Array;
  private readonly outlet: Uint8Array;
  // 有强制方向的活动格（按编号）与到强制下游的边
  private readonly forcedCells: Int32Array;
  private readonly forcedEdge: Int32Array;
  private readonly water: Float64Array;
  private readonly receiver: Int32Array;
  private readonly edge: Int32Array;
  private readonly pop: Int32Array;
  // 非活动或已入堆的格
  private readonly closed: Uint8Array;
  // 终端汇点：没有出口可流的活动区里最低的格（只在整个星球全是陆地这类情况出现）
  private readonly sink: Uint8Array;
  private readonly heap: MinHeap;
  private readonly order: Int32Array;
  // 按下游分组的上游格（CSR），排拓扑序用
  private readonly start: Int32Array;
  private readonly donors: Int32Array;
  private readonly natural: Int32Array;
  private readonly naturalEdge: Int32Array;

  // terminal：另外当作出口的活动格（画的河在终点消失：水流到那里就没了，下游为 -1）。省略时与原来逐值相同
  constructor(mesh: Mesh, active: Uint8Array, forced?: Int32Array, terminal?: Uint8Array) {
    const n = mesh.n;
    this.mesh = mesh;
    this.active = active;
    this.forced = forced;
    const cells = new Int32Array(n);
    const outlets = new Int32Array(n);
    const outlet = new Uint8Array(n);
    const no = new Int32Array(1);
    const nc = activeCells(mesh, active, terminal ?? null, cells, outlets, outlet, no);
    this.cells = cells.subarray(0, nc);
    this.outlets = outlets.subarray(0, no[0]);
    this.outlet = outlet;
    const fc: number[] = [];
    const fe: number[] = [];
    if (forced) forcedOf(mesh, this.cells, forced, terminal ?? null, fc, fe);
    this.forcedCells = Int32Array.from(fc);
    this.forcedEdge = Int32Array.from(fe);
    // 不活动的格只在这里定一次（第八十八轮：每次求路由只重置活动格；route 从不写不活动的格，调用的一方只读结果）
    this.water = new Float64Array(n).fill(-Infinity);
    this.receiver = new Int32Array(n).fill(-1);
    this.edge = new Int32Array(n).fill(-1);
    this.pop = new Int32Array(n).fill(-1);
    this.closed = new Uint8Array(n).fill(1);
    this.sink = new Uint8Array(n);
    this.heap = new MinHeap(n);
    this.order = new Int32Array(n);
    this.start = new Int32Array(forced ? n + 1 : 0);
    this.donors = new Int32Array(forced ? n : 0);
    this.natural = new Int32Array(forced ? n : 0);
    this.naturalEdge = new Int32Array(forced ? n : 0);
  }

  route(h: ArrayLike<number>): Routing {
    const { mesh, active, cells, outlets, outlet, water, receiver, edge, pop, closed, sink, heap, order } = this;
    resetCells(cells, water, receiver, edge, pop, sink, closed);
    heap.clear();

    seedOutlets(mesh, h, active, outlets, water, receiver, edge, closed, heap);
    let counter = flood(mesh, h, water, pop, closed, heap, 0);
    // 还有活动格没被淹到：它们所在的区域既不挨海也不贴图边（整个星球全是陆地时）。
    // 取其中最低的格作为终端汇点（水在那里消失），再接着淹。一块地区的地图上陆地总挨着海或图边，不会走到这里
    if (counter < cells.length) {
      for (;;) {
        const low = lowestOpen(h, cells, closed);
        if (low < 0) break;
        sink[low] = 1;
        receiver[low] = -1;
        water[low] = h[low];
        closed[low] = 1;
        heap.push(low, h[low]);
        counter = flood(mesh, h, water, pop, closed, heap, counter);
      }
    }

    descend(mesh, cells, outlet, sink, water, pop, receiver, edge);

    if (this.forced) {
      const { forced, forcedCells, forcedEdge, natural, naturalEdge, start, donors } = this;
      natural.set(receiver);
      naturalEdge.set(edge);
      applyForced(forced, forcedCells, forcedEdge, receiver, edge);
      let count = topoOrder(mesh.n, active, cells, receiver, order, start, donors);
      if (count < cells.length) {
        undoCycles(mesh.n, cells, order, count, natural, naturalEdge, receiver, edge);
        count = topoOrder(mesh.n, active, cells, receiver, order, start, donors);
      }
      return { water, receiver, edge, order, count };
    }
    popOrder(cells, pop, order);
    return { water, receiver, edge, order: order.subarray(0, counter), count: counter };
  }
}

// 沿 order 逆序把每格的量累加到下游，得到汇流量
export function accumulate(r: Routing, local: ArrayLike<number>, out: Float64Array | Float32Array) {
  for (let k = 0; k < r.count; k++) out[r.order[k]] = local[r.order[k]];
  for (let k = r.count - 1; k >= 0; k--) {
    const i = r.order[k];
    const j = r.receiver[i];
    if (j >= 0 && out !== undefined) {
      // 下游是非活动格（海）时不累加
      if (inOrder(r, j)) out[j] += out[i];
    }
  }
}

function inOrder(r: Routing, j: number): boolean {
  return Number.isFinite(r.water[j]);
}
