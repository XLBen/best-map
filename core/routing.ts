import { MinHeap } from './heap';
import type { Mesh } from './mesh';

// 汇流路由：Priority-Flood 填洼后按最陡下降确定每格的下游。
// 结果保证无环、全部流向出口；order 中下游格总在上游格之前。
export interface Routing {
  // 填洼后的水面高度（洼地被填到溢出口）
  water: Float64Array;
  // 下游格；出口格指向相邻的非活动格（海），贴图边的出口为 -1
  receiver: Int32Array;
  order: Int32Array;
  count: number;
}

export function route(mesh: Mesh, h: ArrayLike<number>, active: Uint8Array, forced?: Int32Array): Routing {
  const n = mesh.n;
  const water = new Float64Array(n).fill(-Infinity);
  const receiver = new Int32Array(n).fill(-1);
  const pop = new Int32Array(n).fill(-1);
  const heap = new MinHeap(n);
  const visited = new Uint8Array(n);
  // 终端汇点：没有出口可流的活动区里最低的格（只在整个星球全是陆地这类情况出现）
  const sink = new Uint8Array(n);

  // 出口：与非活动格相邻或贴图边的活动格
  for (let i = 0; i < n; i++) {
    if (!active[i]) continue;
    let outlet = mesh.boundary[i] === 1;
    let lowest = -1;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (!active[j]) {
        outlet = true;
        if (lowest < 0 || h[j] < h[lowest]) lowest = j;
      }
    }
    if (outlet) {
      receiver[i] = lowest;
      water[i] = h[i];
      visited[i] = 1;
      heap.push(i, h[i]);
    }
  }
  let counter = 0;
  const flood = () => {
    while (heap.size) {
      const c = heap.pop();
      pop[c] = counter++;
      const wc = water[c];
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
        const j = mesh.adj[e];
        if (!active[j] || visited[j]) continue;
        visited[j] = 1;
        water[j] = Math.max(h[j], wc);
        heap.push(j, water[j]);
      }
    }
  };
  flood();
  // 还有活动格没被淹到：它们所在的区域既不挨海也不贴图边（整个星球全是陆地时）。
  // 取其中最低的格作为终端汇点（水在那里消失），再接着淹。一块地区的地图上陆地总挨着海或图边，不会走到这里
  if (counter < countActive(active)) {
    for (;;) {
      let low = -1;
      for (let i = 0; i < n; i++) if (active[i] && !visited[i] && (low < 0 || h[i] < h[low])) low = i;
      if (low < 0) break;
      sink[low] = 1;
      receiver[low] = -1;
      water[low] = h[low];
      visited[low] = 1;
      heap.push(low, h[low]);
      flood();
    }
  }

  // 最陡下降；平地上沿洪泛顺序流向更早被淹到的格（即朝出口方向）
  for (let i = 0; i < n; i++) {
    if (!active[i] || pop[i] < 0 || receiver[i] >= 0 || isOutlet(i)) continue;
    let best = -1;
    let bestSlope = -1;
    let bestPop = Infinity;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (!active[j] || pop[j] < 0) continue;
      const dw = water[i] - water[j];
      if (dw < 0 || (dw === 0 && pop[j] > pop[i])) continue;
      const slope = dw / mesh.dist[e];
      if (slope > bestSlope || (slope === bestSlope && pop[j] < bestPop)) {
        best = j;
        bestSlope = slope;
        bestPop = pop[j];
      }
    }
    receiver[i] = best;
  }
  function isOutlet(i: number) {
    if (mesh.boundary[i] || sink[i]) return true;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (!active[mesh.adj[e]]) return true;
    return false;
  }

  if (forced) {
    const natural = Int32Array.from(receiver);
    for (let i = 0; i < n; i++) if (active[i] && forced[i] >= 0) receiver[i] = forced[i];
    const result = topoOrder(mesh, receiver, active);
    if (result.count < countActive(active)) {
      // 强制方向造成了环：把环上的格恢复为自然方向
      const reached = new Uint8Array(n);
      for (let k = 0; k < result.count; k++) reached[result.order[k]] = 1;
      for (let i = 0; i < n; i++) if (active[i] && !reached[i]) receiver[i] = natural[i];
      const again = topoOrder(mesh, receiver, active);
      return { water, receiver, order: again.order, count: again.count };
    }
    return { water, receiver, order: result.order, count: result.count };
  }
  // 无强制方向时洪泛顺序本身就是拓扑序
  const order = new Int32Array(counter);
  for (let i = 0; i < n; i++) if (pop[i] >= 0) order[pop[i]] = i;
  return { water, receiver, order, count: counter };
}

function countActive(active: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < active.length; i++) c += active[i];
  return c;
}

// 从根（下游不是活动格）出发沿上游方向广度优先，得到下游在前的顺序
function topoOrder(mesh: Mesh, receiver: Int32Array, active: Uint8Array): { order: Int32Array; count: number } {
  const n = mesh.n;
  const donorCount = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const r = receiver[i];
    if (active[i] && r >= 0 && active[r]) donorCount[r + 1]++;
  }
  for (let i = 0; i < n; i++) donorCount[i + 1] += donorCount[i];
  const donors = new Int32Array(donorCount[n]);
  const fill = donorCount.slice(0, n);
  for (let i = 0; i < n; i++) {
    const r = receiver[i];
    if (active[i] && r >= 0 && active[r]) donors[fill[r]++] = i;
  }
  const order = new Int32Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const r = receiver[i];
    if (active[i] && (r < 0 || !active[r])) order[count++] = i;
  }
  for (let h = 0; h < count; h++) {
    const c = order[h];
    for (let k = donorCount[c]; k < donorCount[c + 1]; k++) order[count++] = donors[k];
  }
  return { order, count };
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
