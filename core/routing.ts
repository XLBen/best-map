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

export function route(mesh: Mesh, h: ArrayLike<number>, active: Uint8Array, forced?: Int32Array): Routing {
  return new Router(mesh, active, forced).route(h);
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

  constructor(mesh: Mesh, active: Uint8Array, forced?: Int32Array) {
    const n = mesh.n;
    this.mesh = mesh;
    this.active = active;
    this.forced = forced;
    const cells = new Int32Array(n);
    const outlets = new Int32Array(n);
    const outlet = new Uint8Array(n);
    let nc = 0;
    let no = 0;
    for (let i = 0; i < n; i++) {
      if (!active[i]) continue;
      cells[nc++] = i;
      let out = mesh.boundary[i] === 1;
      for (let e = mesh.off[i]; e < mesh.off[i + 1] && !out; e++) if (!active[mesh.adj[e]]) out = true;
      if (out) {
        outlet[i] = 1;
        outlets[no++] = i;
      }
    }
    this.cells = cells.subarray(0, nc);
    this.outlets = outlets.subarray(0, no);
    this.outlet = outlet;
    const fc: number[] = [];
    const fe: number[] = [];
    if (forced) {
      for (let k = 0; k < nc; k++) {
        const i = cells[k];
        if (forced[i] < 0) continue;
        // 与按边逐个比对的结果相同：取最后一条指向它的边
        let edge = -1;
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (mesh.adj[e] === forced[i]) edge = e;
        fc.push(i);
        fe.push(edge);
      }
    }
    this.forcedCells = Int32Array.from(fc);
    this.forcedEdge = Int32Array.from(fe);
    this.water = new Float64Array(n);
    this.receiver = new Int32Array(n);
    this.edge = new Int32Array(n);
    this.pop = new Int32Array(n);
    this.closed = new Uint8Array(n);
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
    const { off, adj, dist } = mesh;
    water.fill(-Infinity);
    receiver.fill(-1);
    edge.fill(-1);
    pop.fill(-1);
    sink.fill(0);
    closed.fill(1);
    for (let k = 0; k < cells.length; k++) closed[cells[k]] = 0;
    heap.clear();

    // 出口格先入堆，下游指向最低的相邻非活动格
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
    let counter = this.flood(h, 0);
    // 还有活动格没被淹到：它们所在的区域既不挨海也不贴图边（整个星球全是陆地时）。
    // 取其中最低的格作为终端汇点（水在那里消失），再接着淹。一块地区的地图上陆地总挨着海或图边，不会走到这里
    if (counter < cells.length) {
      for (;;) {
        let low = -1;
        for (let k = 0; k < cells.length; k++) {
          const i = cells[k];
          if (!closed[i] && (low < 0 || h[i] < h[low])) low = i;
        }
        if (low < 0) break;
        sink[low] = 1;
        receiver[low] = -1;
        water[low] = h[low];
        closed[low] = 1;
        heap.push(low, h[low]);
        counter = this.flood(h, counter);
      }
    }

    // 最陡下降；平地上沿洪泛顺序流向更早被淹到的格（即朝出口方向）
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

    if (this.forced) {
      const { forced, forcedCells, forcedEdge, natural, naturalEdge } = this;
      natural.set(receiver);
      naturalEdge.set(edge);
      for (let k = 0; k < forcedCells.length; k++) {
        receiver[forcedCells[k]] = forced[forcedCells[k]];
        edge[forcedCells[k]] = forcedEdge[k];
      }
      let count = this.topoOrder();
      if (count < cells.length) {
        // 强制方向造成了环：把环上的格恢复为自然方向
        const reached = new Uint8Array(mesh.n);
        for (let k = 0; k < count; k++) reached[order[k]] = 1;
        for (let k = 0; k < cells.length; k++) {
          const i = cells[k];
          if (reached[i]) continue;
          receiver[i] = natural[i];
          edge[i] = naturalEdge[i];
        }
        count = this.topoOrder();
      }
      return { water, receiver, edge, order, count };
    }
    // 无强制方向时洪泛顺序本身就是拓扑序
    for (let k = 0; k < cells.length; k++) if (pop[cells[k]] >= 0) order[pop[cells[k]]] = cells[k];
    return { water, receiver, edge, order: order.subarray(0, counter), count: counter };
  }

  // 从堆里的格开始淹：依次弹出最低的格，未入堆的活动邻格以 max(自身高度, 当前水面) 入堆。返回已弹出的格数
  private flood(h: ArrayLike<number>, counter: number): number {
    const { water, pop, closed, heap } = this;
    const { off, adj } = this.mesh;
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

  // 从根（下游不是活动格）出发沿上游方向广度优先，得到下游在前的顺序。返回排到的格数（有环时少于活动格数）
  private topoOrder(): number {
    const { active, cells, receiver, order, start, donors } = this;
    const n = this.mesh.n;
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
