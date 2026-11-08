import { sameBytes } from './content-memo';
import type { Mesh } from './mesh';
import { type Routing, route } from './routing';

// ---------- 水文的路由按陆块记（第八十八轮） ----------
// 水文每次高程变了都整张求一遍路由（core/hydrology.ts）。陆块之间隔着海（不活动的格），路由在一块陆地里的结果
// （水面、下游、到下游的边、陆块里的先后）只取决于这块陆地的格、它们与挨着的海格的高度、强制方向与在哪里消失：
//   · Priority-Flood 的堆按（高度，入堆的先后）出堆：一块陆地的格的出堆先后与只淹这一块时相同（别的陆块的格插在中间，
//     这一块的格之间的先后不变；入堆的高度不低于刚出堆的）；
//   · 最陡下降、平地按出堆先后比的只是邻格（同一块陆地）；
//   · 有强制方向时的拓扑序从根按编号广度优先，一块陆地的格之间的先后同样不变；没有出口的陆块各取自己最低的格当汇点。
// 所以：没变的陆块照用上一次的结果，变了的几块（连成的一份活动格）一起求一次，再拼起来。拼起来的 order 是各陆块依次接上
// （不是整张求时各块交错的先后）：水文只按陆块里的先后累加、找流域（同一块里的先后不变），结果逐值相同（hydro-speed 测试）。
// 变了的格超过一半时整张求一次，再按陆块分开记下

interface Part {
  // 这块陆地的格（升序）、挨着的不活动的格（升序）
  cells: Int32Array;
  outer: Int32Array;
  // 键：格与挨着的格的高度（按原来的类型逐字节比）、强制方向、在哪里消失
  h: Float32Array;
  forced: Int32Array;
  term: Uint8Array;
  // 结果（按 cells 的下标）与这块陆地里的先后（格的编号）
  water: Float64Array;
  receiver: Int32Array;
  edge: Int32Array;
  order: Int32Array;
}

interface Store {
  land: Uint8Array;
  // 每块陆地（按最小的格编号）的格、挨着的格
  comps: { cells: Int32Array; outer: Int32Array }[];
  parts: Map<number, Part>;
}
const stores = new WeakMap<Mesh, Store>();

// 测试用：关掉（每次整张求）
export const routeParts = { on: true };
export const routePartStats = { reused: 0, solved: 0 };

export function routeByParts(mesh: Mesh, h: Float32Array, active: Uint8Array, forced: Int32Array, terminal: Uint8Array | undefined): Routing {
  if (!routeParts.on) return route(mesh, h, active, forced, terminal);
  let st = stores.get(mesh);
  if (!st || !sameBytes(st.land, active)) {
    // 陆海变了（画陆地、放岛）：重新认陆块；格一格不差的陆块（挨着的海格也就一样）照用记着的那一份
    const comps = componentsOf(mesh, active);
    const parts = new Map<number, Part>();
    if (st) {
      for (const c of comps) {
        const p = st.parts.get(c.cells[0]);
        if (p && sameBytes(p.cells, c.cells)) parts.set(c.cells[0], { ...p, cells: c.cells, outer: c.outer });
      }
    }
    st = { land: active.slice(), comps, parts };
    stores.set(mesh, st);
  }
  const n = mesh.n;
  const hits: (Part | null)[] = st.comps.map((c) => {
    const p = st!.parts.get(c.cells[0]);
    return p && samePart(p, c.cells, h, forced, terminal) ? p : null;
  });
  let missing = 0;
  let total = 0;
  st.comps.forEach((c, k) => {
    total += c.cells.length;
    if (hits[k]) routePartStats.reused++;
    else missing += c.cells.length;
  });
  if (missing > 0) {
    // 变了的陆块一起求一次（变得多时整张求）
    let sub: Uint8Array = active;
    if (missing * 2 <= total) {
      sub = new Uint8Array(n);
      st.comps.forEach((c, k) => {
        if (!hits[k]) for (let q = 0; q < c.cells.length; q++) sub[c.cells[q]] = 1;
      });
    }
    const r = route(mesh, h, sub, forced, terminal);
    // 每格在这次的先后里的位置，按陆块取出各自的先后
    const at = new Int32Array(n).fill(-1);
    for (let k = 0; k < r.count; k++) at[r.order[k]] = k;
    st.comps.forEach((c, k) => {
      if (hits[k]) return;
      const p = partOf(c.cells, c.outer, h, forced, terminal, r, at);
      st!.parts.set(c.cells[0], p);
      hits[k] = p;
      routePartStats.solved++;
    });
  }
  // 拼起来
  const water = new Float64Array(n).fill(-Infinity);
  const receiver = new Int32Array(n).fill(-1);
  const edge = new Int32Array(n).fill(-1);
  let count = 0;
  for (const p of hits) count += p!.order.length;
  const order = new Int32Array(count);
  let o = 0;
  for (const p of hits) {
    placePart(p!, water, receiver, edge);
    order.set(p!.order, o);
    o += p!.order.length;
  }
  return { water, receiver, edge, order, count };
}

// 活动格连成的块（按最小的格编号的先后），每块的格（升序）与挨着的不活动的格（升序）
function componentsOf(mesh: Mesh, active: Uint8Array): { cells: Int32Array; outer: Int32Array }[] {
  const n = mesh.n;
  const { off, adj } = mesh;
  const label = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const seenOut = new Int32Array(n).fill(-1);
  const out: { cells: Int32Array; outer: Int32Array }[] = [];
  for (let s = 0; s < n; s++) {
    if (!active[s] || label[s] >= 0) continue;
    const id = out.length;
    let len = 0;
    queue[len++] = s;
    label[s] = id;
    const outer: number[] = [];
    for (let q = 0; q < len; q++) {
      const c = queue[q];
      for (let e = off[c]; e < off[c + 1]; e++) {
        const j = adj[e];
        if (active[j]) {
          if (label[j] < 0) {
            label[j] = id;
            queue[len++] = j;
          }
        } else if (seenOut[j] !== id) {
          seenOut[j] = id;
          outer.push(j);
        }
      }
    }
    const cells = queue.slice(0, len).sort();
    out.push({ cells, outer: Int32Array.from(outer).sort() });
  }
  return out;
}

// 这块陆地的键与上一次的相同
function samePart(p: Part, cells: Int32Array, h: Float32Array, forced: Int32Array, terminal: Uint8Array | undefined): boolean {
  if (p.cells !== cells) return false;
  const m = cells.length;
  for (let k = 0; k < m; k++) {
    const i = cells[k];
    if (!sameF32(p.h[k], h[i]) || p.forced[k] !== forced[i] || p.term[k] !== (terminal ? terminal[i] : 0)) return false;
  }
  const outer = p.outer;
  for (let k = 0; k < outer.length; k++) if (!sameF32(p.h[m + k], h[outer[k]])) return false;
  return true;
}

// 逐位相同（−0 与 0、NaN 也分开：与按字节比的键一样严）
const f32 = new Float32Array(2);
const u32 = new Uint32Array(f32.buffer);
function sameF32(a: number, b: number): boolean {
  if (a !== b) return a !== a && b !== b && ((f32[0] = a), (f32[1] = b), u32[0] === u32[1]);
  if (a !== 0) return true;
  f32[0] = a;
  f32[1] = b;
  return u32[0] === u32[1];
}

// 从这次求的结果里取出一块陆地的
function partOf(cells: Int32Array, outer: Int32Array, h: Float32Array, forced: Int32Array, terminal: Uint8Array | undefined, r: Routing, at: Int32Array): Part {
  const m = cells.length;
  const hv = new Float32Array(m + outer.length);
  const fv = new Int32Array(m);
  const tv = new Uint8Array(m);
  const water = new Float64Array(m);
  const receiver = new Int32Array(m);
  const edge = new Int32Array(m);
  let cnt = 0;
  for (let k = 0; k < m; k++) {
    const i = cells[k];
    hv[k] = h[i];
    fv[k] = forced[i];
    tv[k] = terminal ? terminal[i] : 0;
    water[k] = r.water[i];
    receiver[k] = r.receiver[i];
    edge[k] = r.edge[i];
    if (at[i] >= 0) cnt++;
  }
  for (let k = 0; k < outer.length; k++) hv[m + k] = h[outer[k]];
  // 这块陆地的格按这次的先后排（都排到了时就是全部的格）
  const pos = new Int32Array(cnt);
  let w = 0;
  for (let k = 0; k < m; k++) if (at[cells[k]] >= 0) pos[w++] = at[cells[k]];
  pos.sort();
  const order = new Int32Array(cnt);
  for (let k = 0; k < cnt; k++) order[k] = r.order[pos[k]];
  return { cells, outer, h: hv, forced: fv, term: tv, water, receiver, edge, order };
}

function placePart(p: Part, water: Float64Array, receiver: Int32Array, edge: Int32Array): void {
  const { cells } = p;
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    water[i] = p.water[k];
    receiver[i] = p.receiver[k];
    edge[i] = p.edge[k];
  }
}
