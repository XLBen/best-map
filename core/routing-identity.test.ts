import { describe, expect, it } from 'vitest';
import { digest } from '../tools/hash';
import { type ElevationResult, computeElevation, elevationMemo } from './elevation';
import { MinHeap } from './heap';
import { type Mesh, graphDistance } from './mesh';
import { LAYOUT_R } from './planet-gen';
import { fbm, fbm3, gradientNoise, gradientNoise3, mixSeed, mulberry32 } from './rng';
import { Router, type Routing, route } from './routing';
import { engineFor, meshFor } from './testing/fixtures';
import type { Guide, LakeSpec, World } from './world';

// 汇流路由提速（活动格表、出口格与缓冲区在高程的各轮间复用，下游的边随路由给出，堆用空位法，
// 汇水面积不变的格沿用上一轮的 A^m，海岸距离只沿陆格算）后，结果与原来的写法逐值一致。
// 文件末尾是 402e638 的 MinHeap、route、computeElevation 的原样拷贝（只改了名字）

const PLANE = { cells: 3000, seed: 4, aspect: 1.5 };
const SPHERE = { cells: 3000, seed: 4, globe: true, aspect: 2, latNorth: 90, latSouth: -90 };

describe('最小堆与原来的写法弹出顺序相同', () => {
  it('同优先级先进先出，NaN、±0、±Infinity 也一样；清空后重用与新建的相同', () => {
    const rnd = mulberry32(7);
    const special = [0, -0, 1, 2, 2.5, Infinity, -Infinity, Number.NaN];
    const a = new MinHeap(4);
    for (let round = 0; round < 24; round++) {
      a.clear();
      const b = new OldHeap(4);
      const got: number[] = [];
      const want: number[] = [];
      for (let k = 0; k < 3000; k++) {
        if (a.size === 0 || rnd() < 0.55) {
          const key = round % 3 === 0 ? special[Math.floor(rnd() * special.length)] : round % 3 === 1 ? Math.floor(rnd() * 12) : rnd();
          a.push(k, key);
          b.push(k, key);
        } else {
          got.push(a.pop(), a.lastKey);
          want.push(b.pop(), b.lastKey);
        }
      }
      while (a.size) {
        got.push(a.pop(), a.lastKey);
        want.push(b.pop(), b.lastKey);
      }
      expect(b.size).toBe(0);
      expect(got.length).toBe(want.length);
      expect(got.every((v, k) => Object.is(v, want[k]))).toBe(true);
    }
  });
});

// 几块陆地，中间挖几个湖（湖边的格也是出口）；一半格随机；全是陆地；全是海
function masks(mesh: Mesh): Record<string, Uint8Array> {
  const n = mesh.n;
  const rnd = mulberry32(11);
  const pick = () => Math.floor(rnd() * n);
  const near = graphDistance(mesh, [pick(), pick(), pick(), pick()], 0.25);
  const hole = graphDistance(mesh, [pick(), pick(), pick()], 0.06);
  const blobs = new Uint8Array(n);
  const speckle = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    blobs[i] = near[i] <= 0.25 && !(hole[i] <= 0.06) ? 1 : 0;
    speckle[i] = rnd() < 0.5 ? 1 : 0;
  }
  return { blobs, speckle, all: new Uint8Array(n).fill(1), none: new Uint8Array(n) };
}

// 平滑的起伏、取整后大片等高（平地与洼地）、完全平坦、Float32（水文用的高程）、逐格随机（到处是洼地）
function fields(mesh: Mesh): ArrayLike<number>[] {
  const n = mesh.n;
  const smooth = new Float64Array(n);
  if (mesh.kind === 'sphere') {
    const g = gradientNoise3(5);
    for (let i = 0; i < n; i++) smooth[i] = fbm3(g, mesh.p[3 * i], mesh.p[3 * i + 1], mesh.p[3 * i + 2], 3, 4);
  } else {
    const g = gradientNoise(5);
    for (let i = 0; i < n; i++) smooth[i] = fbm(g, mesh.x[i], mesh.y[i], 4, 4);
  }
  const rnd = mulberry32(13);
  return [smooth, smooth.map((v) => Math.round(v * 4)), new Float64Array(n), Float32Array.from(smooth, (v) => v * 1000 + 200), Float64Array.from(smooth, () => rnd())];
}

// 强制方向：没有；全是 -1；沿邻格的随机路线（会走回头路形成环）；成对互指的环；跳到不相邻的格（常是非活动格）
function forcings(mesh: Mesh, active: Uint8Array): (Int32Array | undefined)[] {
  const n = mesh.n;
  const rnd = mulberry32(17);
  const walks = new Int32Array(n).fill(-1);
  for (let g = 0; g < 12; g++) {
    let c = Math.floor(rnd() * n);
    for (let s = 0; s < 25; s++) {
      const deg = mesh.off[c + 1] - mesh.off[c];
      const next = mesh.adj[mesh.off[c] + Math.floor(rnd() * deg)];
      walks[c] = next;
      c = next;
    }
  }
  const cycles = new Int32Array(n).fill(-1);
  for (let k = 0; k < 40; k++) {
    const a = Math.floor(rnd() * n);
    const b = mesh.adj[mesh.off[a]];
    if (!active[a] || !active[b]) continue;
    cycles[a] = b;
    cycles[b] = a;
  }
  const far = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) if (rnd() < 0.05) far[i] = Math.floor(rnd() * n);
  return [undefined, new Int32Array(n).fill(-1), walks, cycles, far];
}

function expectSame(got: Routing, want: RoutingOld, mesh: Mesh, label: string) {
  expect(got.count, label).toBe(want.count);
  expect(digest(got.order), label).toBe(digest(want.order));
  expect(digest(got.receiver), label).toBe(digest(want.receiver));
  expect(digest(got.water), label).toBe(digest(want.water));
  // 下游的边：与原来高程里按边逐个比对的规则相同（最后一条指向下游的边；没有下游或不相邻为 -1）
  const edge = new Int32Array(mesh.n).fill(-1);
  for (let i = 0; i < mesh.n; i++) {
    const j = want.receiver[i];
    if (j >= 0) for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (mesh.adj[e] === j) edge[i] = e;
  }
  expect(digest(got.edge), label).toBe(digest(edge));
}

describe('汇流路由与原来的写法逐值一致', () => {
  it.each([
    ['一块地区', PLANE],
    ['整个星球', SPHERE],
  ] as const)('%s：各种活动格、高度与强制方向', (_, settings) => {
    const mesh = meshFor(settings);
    // 邻接里每个邻格只出现一次：最陡下降与出口找到的边就是唯一指向下游的边
    for (let i = 0; i < mesh.n; i++) {
      const seen = new Set<number>();
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) seen.add(mesh.adj[e]);
      expect(seen.size).toBe(mesh.off[i + 1] - mesh.off[i]);
    }
    const hs = fields(mesh);
    let cycled = 0;
    for (const [name, active] of Object.entries(masks(mesh))) {
      for (const [f, forced] of forcings(mesh, active).entries()) {
        // 同一个 Router 依次算各个高度：复用的缓冲区不留上一次的痕迹
        const router = new Router(mesh, active, forced);
        for (const [k, h] of hs.entries()) {
          const label = `${name} 强制方向 ${f} 高度 ${k}`;
          const want = routeOld(mesh, h, active, forced);
          expectSame(route(mesh, h, active, forced), want, mesh, label);
          expectSame(router.route(h), want, mesh, `${label}（复用）`);
          if (forced) for (let i = 0; i < mesh.n; i++) if (active[i] && forced[i] >= 0 && want.receiver[i] !== forced[i]) cycled++;
        }
      }
    }
    // 确实走到了“强制方向成环、恢复自然方向”的分支
    expect(cycled).toBeGreaterThan(0);
  });
});

// 高程：原样；加引导河道（有环、流进海、跳格、同一格在两条河里）与湖（一个放在海上）；全是陆地；全是海；零散小岛
function variants(w: World): Record<string, World> {
  const { mesh, causes } = w;
  const n = mesh.n;
  const rnd = mulberry32(23);
  const landCells: number[] = [];
  for (let i = 0; i < n; i++) if (causes.land[i]) landCells.push(i);
  const anyLand = () => landCells[Math.floor(rnd() * landCells.length)];
  const guides: Guide[] = [];
  for (let g = 0; g < 10; g++) {
    let c = anyLand();
    const cells = [c];
    for (let s = 0; s < 30; s++) {
      const deg = mesh.off[c + 1] - mesh.off[c];
      c = mesh.adj[mesh.off[c] + Math.floor(rnd() * deg)];
      cells.push(c);
    }
    guides.push({ id: `g${g}`, cells, locked: true, spring: g % 2 === 0 });
  }
  const a = anyLand();
  const b = mesh.adj[mesh.off[a]];
  const c = mesh.adj[mesh.off[b]];
  guides.push({ id: 'loop', cells: [a, b, c, a, b], locked: true, spring: false });
  guides.push({ id: 'jump', cells: [anyLand(), anyLand(), guides[0].cells[3]], locked: true, spring: false });
  const lakes: LakeSpec[] = [];
  for (let k = 0; k < 3; k++) lakes.push({ id: `l${k}`, cell: anyLand(), radius: 60 + 80 * k, depth: 100, perennial: true });
  const sea = causes.land.indexOf(0);
  if (sea >= 0) lakes.push({ id: 'sea', cell: sea, radius: 100, depth: 100, perennial: true });
  const withLand = (land: Uint8Array, small = w.small): World => ({ ...w, causes: { ...causes, land }, small });
  const edited = { ...w.small, guides, lakes };
  const speckle = new Uint8Array(n);
  for (let i = 0; i < n; i++) speckle[i] = rnd() < 0.3 ? 1 : 0;
  return {
    原样: w,
    河道与湖: withLand(causes.land, edited),
    全是陆地: withLand(new Uint8Array(n).fill(1), edited),
    全是海: withLand(new Uint8Array(n), { ...w.small, guides: guides.slice(0, 3), lakes: [] }),
    零散小岛: withLand(speckle, { ...edited, lakes: [] }),
  };
}

// 高程每一轮开始时的高度（Float64）。只比 Float32 的结果看不出末位的差别，所以逐轮比
let trace: string[] = [];
function routeOld(mesh: Mesh, h: ArrayLike<number>, active: Uint8Array, forced?: Int32Array): RoutingOld {
  trace.push(digest(h));
  return routeOldImpl(mesh, h, active, forced);
}

describe('高程与原来的写法逐值一致', () => {
  it.each([
    ['一块地区', { cells: 4000, seed: 3 }],
    ['整个星球', { cells: 4000, seed: 5, globe: true, aspect: 2, latNorth: 90, latSouth: -90 }],
  ] as const)('%s', (_, settings) => {
    const eng = engineFor(settings);
    eng.exec({ op: 'set_worldgen', params: { seed: 3, type: 'continents' }, reset: true });
    const routeNew = Router.prototype.route;
    try {
      Router.prototype.route = function (this: Router, h: ArrayLike<number>) {
        trace.push(digest(h));
        return routeNew.call(this, h);
      };
      for (const [label, w] of Object.entries(variants(eng.world))) {
        trace = [];
        const want = computeElevationOld(w);
        const wantTrace = trace;
        trace = [];
        // 逐轮比路由的输入：按陆块复用的缓存关掉（开着时只算改过的陆块，每轮的 h 只有那几块）
        elevationMemo.on = false;
        const got = computeElevation(w);
        elevationMemo.on = true;
        expect(trace.length, label).toBe(12);
        expect(trace, label).toEqual(wantTrace);
        expect(digest(got.elevation), label).toBe(digest(want.elevation));
        // 海岸距离只沿陆格算：陆格与原来相同，海格不再算（1e5）
        const coast = Float64Array.from(want.coastKm, (v, i) => (w.causes.land[i] ? v : 1e5));
        expect(digest(got.coastKm), label).toBe(digest(coast));
        // 缓存开着（复用上一个变体里没变的陆块）：结果相同
        const memo = computeElevation(w);
        expect(digest(memo.elevation), label).toBe(digest(want.elevation));
        expect(digest(memo.coastKm), label).toBe(digest(coast));
      }
    } finally {
      Router.prototype.route = routeNew;
    }
  });
});

// ---- 以下是 402e638 的原样拷贝（只改了名字），不要改它 ----
// 唯一的例外（第九轮去掉旧存档兼容）：computeElevationOld 里画的河不再强制汇流、不再让岩性变软
// （画的河都只挖河床，高程求解不看它们），湖的最小半径从一格半改成半格。其余一字未动

// core/heap.ts
class OldHeap {
  private items: Int32Array;
  private keys: Float64Array;
  private order: Float64Array;
  private counter = 0;
  size = 0;

  constructor(capacity = 1024) {
    this.items = new Int32Array(capacity);
    this.keys = new Float64Array(capacity);
    this.order = new Float64Array(capacity);
  }

  private less(a: number, b: number): boolean {
    const ka = this.keys[a];
    const kb = this.keys[b];
    return ka < kb || (ka === kb && this.order[a] < this.order[b]);
  }

  private swap(a: number, b: number) {
    const i = this.items[a];
    this.items[a] = this.items[b];
    this.items[b] = i;
    const k = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = k;
    const o = this.order[a];
    this.order[a] = this.order[b];
    this.order[b] = o;
  }

  push(item: number, key: number) {
    if (this.size === this.items.length) {
      const grow = (arr: Int32Array | Float64Array) => {
        const next = new (arr.constructor as Int32ArrayConstructor | Float64ArrayConstructor)(arr.length * 2);
        next.set(arr);
        return next;
      };
      this.items = grow(this.items) as Int32Array;
      this.keys = grow(this.keys) as Float64Array;
      this.order = grow(this.order) as Float64Array;
    }
    let i = this.size++;
    this.items[i] = item;
    this.keys[i] = key;
    this.order[i] = this.counter++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }

  // 返回堆顶元素；调用前需保证 size > 0
  pop(): number {
    const top = this.items[0];
    this.lastKey = this.keys[0];
    this.size--;
    if (this.size > 0) {
      this.items[0] = this.items[this.size];
      this.keys[0] = this.keys[this.size];
      this.order[0] = this.order[this.size];
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.size && this.less(l, m)) m = l;
        if (r < this.size && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  // 最近一次 pop 出的元素的优先级
  lastKey = 0;
}

// core/routing.ts
// 汇流路由：Priority-Flood 填洼后按最陡下降确定每格的下游。
// 结果保证无环、全部流向出口；order 中下游格总在上游格之前。
interface RoutingOld {
  // 填洼后的水面高度（洼地被填到溢出口）
  water: Float64Array;
  // 下游格；出口格指向相邻的非活动格（海），贴图边的出口为 -1
  receiver: Int32Array;
  order: Int32Array;
  count: number;
}

function routeOldImpl(mesh: Mesh, h: ArrayLike<number>, active: Uint8Array, forced?: Int32Array): RoutingOld {
  const n = mesh.n;
  const water = new Float64Array(n).fill(-Infinity);
  const receiver = new Int32Array(n).fill(-1);
  const pop = new Int32Array(n).fill(-1);
  const heap = new OldHeap(n);
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
  if (counter < countActiveOld(active)) {
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
    const result = topoOrderOld(mesh, receiver, active);
    if (result.count < countActiveOld(active)) {
      // 强制方向造成了环：把环上的格恢复为自然方向
      const reached = new Uint8Array(n);
      for (let k = 0; k < result.count; k++) reached[result.order[k]] = 1;
      for (let i = 0; i < n; i++) if (active[i] && !reached[i]) receiver[i] = natural[i];
      const again = topoOrderOld(mesh, receiver, active);
      return { water, receiver, order: again.order, count: again.count };
    }
    return { water, receiver, order: result.order, count: result.count };
  }
  // 无强制方向时洪泛顺序本身就是拓扑序
  const order = new Int32Array(counter);
  for (let i = 0; i < n; i++) if (pop[i] >= 0) order[pop[i]] = i;
  return { water, receiver, order, count: counter };
}

function countActiveOld(active: Uint8Array): number {
  let c = 0;
  for (let i = 0; i < active.length; i++) c += active[i];
  return c;
}

// 从根（下游不是活动格）出发沿上游方向广度优先，得到下游在前的顺序
function topoOrderOld(mesh: Mesh, receiver: Int32Array, active: Uint8Array): { order: Int32Array; count: number } {
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
function accumulateOld(r: RoutingOld, local: ArrayLike<number>, out: Float64Array | Float32Array) {
  for (let k = 0; k < r.count; k++) out[r.order[k]] = local[r.order[k]];
  for (let k = r.count - 1; k >= 0; k--) {
    const i = r.order[k];
    const j = r.receiver[i];
    if (j >= 0 && out !== undefined) {
      // 下游是非活动格（海）时不累加
      if (inOrderOld(r, j)) out[j] += out[i];
    }
  }
}

function inOrderOld(r: RoutingOld, j: number): boolean {
  return Number.isFinite(r.water[j]);
}

// core/elevation.ts
const M_OLD = 0.45;
// 原始单位到米的换算：抬升 1.0、约 600 km 宽的山带峰高约为 mountainScale
const RAW_TO_M_OLD = 1 / 3.4;
const ITERATIONS_OLD = 12;

// 每格的噪声因子：抬升、可蚀性的倍数与初始高程的起伏。只取决于网格与种子，
// 所以按网格缓存（每个网格只留两个种子），编辑地形时不再重算这三个分形噪声场
interface NoiseFactorsOld {
  fu: Float64Array;
  fk: Float64Array;
  fs: Float64Array;
}
const noiseCacheOld = new WeakMap<Mesh, Map<number, NoiseFactorsOld>>();

function noiseFactorsOld(mesh: Mesh, seed: number): NoiseFactorsOld {
  let bySeed = noiseCacheOld.get(mesh);
  if (!bySeed) noiseCacheOld.set(mesh, (bySeed = new Map()));
  let f = bySeed.get(seed);
  if (f) return f;
  const n = mesh.n;
  const fu = new Float64Array(n);
  const fk = new Float64Array(n);
  const fs = new Float64Array(n);
  if (mesh.kind === 'sphere') {
    // 整个星球：同样的频率，在球面的布局坐标上取三维噪声
    const noiseU = gradientNoise3(mixSeed(seed, 101));
    const noiseK = gradientNoise3(mixSeed(seed, 102));
    const noiseS = gradientNoise3(mixSeed(seed, 103));
    for (let i = 0; i < n; i++) {
      const px = mesh.p[3 * i] * LAYOUT_R;
      const py = mesh.p[3 * i + 1] * LAYOUT_R;
      const pz = mesh.p[3 * i + 2] * LAYOUT_R;
      fu[i] = 0.8 + 0.4 * (0.5 + 0.5 * fbm3(noiseU, px, py, pz, 7, 3));
      fk[i] = 0.75 + 0.5 * (0.5 + 0.5 * fbm3(noiseK, px, py, pz, 9, 3));
      fs[i] = fbm3(noiseS, px, py, pz, 25, 2);
    }
  } else {
    const noiseU = gradientNoise(mixSeed(seed, 101));
    const noiseK = gradientNoise(mixSeed(seed, 102));
    const noiseS = gradientNoise(mixSeed(seed, 103));
    for (let i = 0; i < n; i++) {
      const x = mesh.x[i];
      const y = mesh.y[i];
      fu[i] = 0.8 + 0.4 * (0.5 + 0.5 * fbm(noiseU, x, y, 7, 3));
      fk[i] = 0.75 + 0.5 * (0.5 + 0.5 * fbm(noiseK, x, y, 9, 3));
      fs[i] = fbm(noiseS, x, y, 25, 2);
    }
  }
  f = { fu, fk, fs };
  if (bySeed.size >= 2) bySeed.delete(bySeed.keys().next().value!);
  bySeed.set(seed, f);
  return f;
}

function computeElevationOld(world: World): ElevationResult {
  const { mesh, causes, small, kmPerUnit } = world;
  const n = mesh.n;
  const land = causes.land;
  const sphere = mesh.kind === 'sphere' ? mesh : null;
  const { fu, fk, fs } = noiseFactorsOld(mesh, world.settings.seed);

  // 海岸距离
  const coastCells: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      if (land[mesh.adj[e]] !== land[i]) {
        coastCells.push(i);
        break;
      }
    }
  }
  const coast = graphDistance(mesh, coastCells, Infinity, (i, j, e) => (land[i] === land[j] ? mesh.dist[e] : Infinity));
  const coastKm = new Float64Array(n);
  for (let i = 0; i < n; i++) coastKm[i] = Number.isFinite(coast[i]) ? coast[i] * kmPerUnit : 1e5;

  const u = new Float64Array(n);
  const K = new Float64Array(n);
  const areaKm = new Float64Array(n);
  // 汇水面积加一个按地图面积取的常数：源头格的面积随格数变化，不加的话格越密山越高
  // 整个星球按布局尺度（半圈经线的一半）算，和同样格距的地区地图相当
  const areaReg = sphere ? (mesh.totalArea * (kmPerUnit / 2) * (kmPerUnit / 2)) / 20000 : (mesh.width * mesh.height * kmPerUnit * kmPerUnit) / 20000;
  for (let i = 0; i < n; i++) {
    // 基础抬升让平原也有起伏；噪声打破对称，使河网各不相同
    u[i] = (0.035 + causes.uplift[i]) * fu[i];
    K[i] = causes.erod[i] * fk[i];
    areaKm[i] = mesh.area[i] * kmPerUnit * kmPerUnit;
  }

  // 初始高程：按离海距离给一个缓坡加噪声（固定初值，结果只取决于原因）
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue;
    h[i] = coastKm[i] * 0.002 * (0.3 + u[i]) + 0.05 * (1 + fs[i]);
  }

  // 固定轮数：每个流域的计算只取决于它自己，在一处编辑不会因为“全局收敛轮数”变化而改动远处的地形
  const active = land;
  const A = new Float64Array(n);
  for (let it = 0; it < ITERATIONS_OLD; it++) {
    const r = routeOld(mesh, h, active, new Int32Array(n).fill(-1));
    accumulateOld(r, areaKm, A);
    for (let k = 0; k < r.count; k++) {
      const i = r.order[k];
      const j = r.receiver[i];
      const baseH = j >= 0 && land[j] ? h[j] : 0;
      let L = kmPerUnit * mesh.spacing;
      if (j >= 0) {
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (mesh.adj[e] === j) L = mesh.dist[e] * kmPerUnit;
      }
      h[i] = baseH + (u[i] * L) / (K[i] * Math.pow(A[i] + areaReg, M_OLD));
    }
  }

  // 坡面过程：轻度扩散，削掉单格尖峰
  const scale = small.planet.mountainScale * RAW_TO_M_OLD;
  const elevation = new Float32Array(n);
  const tmp = Float64Array.from(h);
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < n; i++) {
      if (!land[i]) continue;
      let s = 0;
      let w = 0;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        const wt = mesh.edgeLen[e] / mesh.dist[e];
        s += wt * (land[j] ? h[j] : 0);
        w += wt;
      }
      tmp[i] = h[i] + 0.2 * (s / w - h[i]);
    }
    h.set(tmp);
  }
  for (let i = 0; i < n; i++) {
    if (land[i]) {
      elevation[i] = Math.max(2, h[i] * scale);
    } else {
      // 海底直接取地壳高度：大陆架、陆坡、深海平原、洋中脊、海沟都来自生成器
      elevation[i] = Math.min(-2, causes.landness[i]);
    }
  }

  // 湖：挖一个碗形洼地，由水文按溢出口蓄水。
  // 以紧贴湖面的一圈格里最低的为基准往下挖：它就是溢出口，湖面 = 它的高度，
  // 所以湖面正好是 lakeArea 给出的那些格（预览就是结果），边上也至少有 1 m 深
  for (const lake of small.lakes) {
    const c = lake.cell;
    if (!land[c]) continue;
    const rUnits = lakeRadiusUnitsOld(world, lake.radius);
    const d = graphDistance(mesh, [c], rUnits);
    const inside = (i: number) => land[i] && d[i] <= rUnits;
    let rim = Infinity;
    for (let i = 0; i < n; i++) {
      if (!inside(i)) continue;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (!inside(j)) rim = Math.min(rim, land[j] ? elevation[j] : 0);
      }
    }
    if (!Number.isFinite(rim)) rim = elevation[c];
    for (let i = 0; i < n; i++) {
      if (!inside(i)) continue;
      const t = d[i] / rUnits;
      const bowl = rim - 1 - lake.depth * (1 - t * t);
      elevation[i] = Math.max(1, Math.min(elevation[i], bowl));
    }
  }
  return { elevation, coastKm };
}

// 湖的半径（地图单位）：至少半格
function lakeRadiusUnitsOld(world: World, radiusKm: number): number {
  return Math.max(radiusKm / world.kmPerUnit, world.mesh.spacing * 0.5);
}

