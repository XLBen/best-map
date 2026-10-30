import { HeapLite, type Mesh } from './mesh';
import type { Routing } from './routing';

// ---------- 平原与河口（第三十三轮） ----------
// 高程求解（elevation.ts 的 solveLand）在扩散、挖洼地之后再走一遍：冲积平原、冲积扇、三角洲平原。
// 只用这一块陆地自己的东西（最后一轮的流向与汇水面积 A、高程、抬升），不读气候、流量：改气候永远不改高程。
// 每一步的结果与陆块之间的先后无关（平原按压之前的高度、沿流向流进的干流；扇取各扇的最高；三角洲取各三角洲的最低），
// 所以按陆块记忆（只重算改到的陆块）照旧逐值相同。米都按默认的“最高的山”6000 m（与基准面、洼地相同）

export const PLAINS = {
  // 冲积平原：干流（A ≥ 2 万 km²）两旁宽 W = max(0.05·√A km, 0.75 格) 以内（从干流那一格的边上量，即格心距离减一格：挨着干流的一圈总算）、
  // 比干流高出不到 40 m + 4 m/km·W 的格压低到干流加 25% 的高差（计划写的是 40 m + 0.02·W：W 按 km 时几乎就是 40 m，
  // 格大时挨着大河的格平均高出几十到一百多米，压不到几格；按 m 时又是一千多米，把山谷也压平了）
  TRUNK_KM2: 2e4,
  W_K: 0.05,
  W_CELLS: 0.75,
  REL_M: 40,
  REL_W: 4,
  KEEP: 0.25,
  // 汇水面积到这么大（km²）的干流才压满（见 lowerToTrunk）
  FULL_KM2: 1e5,
  // 只有低于这么高（m）的干流有冲积平原（高原、山里的大河在谷里，不铺平原）
  TRUNK_MAX_M: 1500,
  // 汇水面积不到干流这么多倍的支流（干流格）也算这条干流的平原
  TRIB_RATIO: 0.5,
  // 冲积扇：河出山口（抬升从强变弱、坡度骤减、A ≥ 500 km²）处，扇顶在出山的那一点（山口两格的中间高度），
  // 半径 0.5·√A km、坡降 3·(A/1e3)^−0.35 m/km 的锥，最多垫高 150 m；半径不到 0.8 格时不做（细地图上多）
  FAN_KM2: 500,
  FAN_R: 0.5,
  FAN_G: 3,
  FAN_G_EXP: -0.35,
  FAN_MAX_M: 150,
  FAN_MIN_CELLS: 0.8,
  // 山口：河穿过抬升 FAN_UP 的等值线（上游那格 ≥、山口那格 <），山口往下约半个扇的半径的坡度不到上游那段的这么多倍
  // （细地图上抬升、坡度都是一格一格慢慢变的：只比相邻的两格时一片海域上几乎找不到山口）
  FAN_UP: 0.2,
  FAN_SLOPE_RATIO: 0.4,
  // 扇面只垫高汇水面积不到扇的河这么多倍的格（更大的干流把扇冲走）
  FAN_A_MUL: 2,
  // 三角洲平原：A ≥ 10 万 km² 的河口，r = 0.12·√A km 以内（同样从河口那格的边上量：格心距离减一格）、60 m 以下（大河放宽，见 DELTA_MAX_EXP）的格压到 1–7 m 的湿地
  // （干流 1–4 m，别的格 4–7 m）
  DELTA_KM2: 1e5,
  DELTA_R: 0.12,
  DELTA_MAX_M: 60,
  // 大河来的沙多，三角洲平原铺得进更高一点的海岸：门槛按 (A/1e5)^0.3 放宽，最多 150 m（格大时一格的平均高度含着岸边的丘陵）
  DELTA_MAX_EXP: 0.3,
  DELTA_MAX_CAP_M: 150,
  DELTA_LOW_M: 1,
  DELTA_RISE_M: 3,
  // 改过的格不低于原来的下游（不新造洼地）：至少高出这么多（m）
  EPS_M: 0.5,
};

// 计数（测试、tools/realism.ts 看）：求解时做了几个扇、压低了几格平原、几格三角洲（只算重算的陆块）
export const plainStats = { fans: 0, flood: 0, delta: 0, deltas: 0, raised: 0 };

export interface PlainInputs {
  mesh: Mesh;
  todo: Uint8Array;
  land: Uint8Array;
  // 每格的抬升（原始的 causes.uplift）与面积（km²）
  up: Float32Array;
  areaKm: Float64Array;
  // 最后一轮的流向与汇水面积（km²）
  r: Routing;
  A: Float64Array;
  kmPerUnit: number;
  // 米换成求解的原始单位
  mToRaw: number;
  // 洼地场（米）：超过 PIT_M 的格是洼地（挖过的洼地不动）
  pitM: Float32Array;
}

// 洼地里的格（与 elevation.ts 的 inPit 同一个门槛）：模块里的函数，不是每次新建的闭包
const PIT_M = 30;
function inPit(x: PlainInputs, i: number): boolean {
  return x.todo[i] === 1 && x.pitM[i] > PIT_M;
}

// 平原、扇、三角洲，改 h（求解的原始单位）。只动 todo 里的格
export function applyPlains(x: PlainInputs, h: Float64Array): void {
  const { mesh } = x;
  const n = mesh.n;
  const changed = new Uint8Array(n);
  const buf = searchFor(n);
  const h0 = h.slice();
  floodplains(x, h, changed, buf);
  fans(x, h, changed, buf);
  deltas(x, h, changed, buf);
  keepDrainage(x, h, h0, changed);
}

// 有界的最短路（只走 todo 里的格，按边长 km）：结果写进 dist、owner；reached 是到过的格（含起点）。
// 缓冲区按格数留着（各次求解共用一份），用一个印记分开各次（不每次清零）
let shared: Search | null = null;
function searchFor(n: number): Search {
  if (!shared || shared.mark.length !== n || shared.stamp > 1e9) shared = new Search(n);
  return shared;
}

class Search {
  dist: Float64Array;
  owner: Int32Array;
  mark: Int32Array;
  done: Int32Array;
  stamp = 0;
  reached: Int32Array;
  count = 0;
  heap: HeapLite;
  constructor(n: number) {
    this.dist = new Float64Array(n);
    this.owner = new Int32Array(n);
    this.mark = new Int32Array(n);
    this.done = new Int32Array(n);
    this.reached = new Int32Array(n);
    this.heap = new HeapLite(256);
  }
  begin() {
    this.stamp++;
    this.count = 0;
    this.heap.size = 0;
  }
  seed(i: number, owner: number) {
    this.mark[i] = this.stamp;
    this.dist[i] = 0;
    this.owner[i] = owner;
    this.reached[this.count++] = i;
    this.heap.push(i, 0);
  }
}

// 从 buf 里已放好的起点出发，limit 以内（km，按起点的数组或一个数）。skip 里汇水面积超过 skipA 的格不走
function expand(mesh: Mesh, todo: Uint8Array, kmPerUnit: number, buf: Search, limit: Float64Array | number, skip: Uint8Array | null, A: Float64Array | null = null, skipA = 0) {
  const { off, adj, dist: md } = mesh;
  const { dist, owner, mark, done, heap, reached } = buf;
  const st = buf.stamp;
  while (heap.size) {
    const i = heap.pop();
    if (done[i] === st) continue;
    done[i] = st;
    const di = dist[i];
    const oi = owner[i];
    const lim = typeof limit === 'number' ? limit : limit[oi];
    for (let e = off[i], end = off[i + 1]; e < end; e++) {
      const j = adj[e];
      if (todo[j] !== 1 || (skip !== null && skip[j] === 1 && (A === null || A[j] > skipA))) continue;
      const nd = di + md[e] * kmPerUnit;
      if (nd > lim) continue;
      if (mark[j] !== st) {
        mark[j] = st;
        dist[j] = nd;
        owner[j] = oi;
        reached[buf.count++] = j;
        heap.push(j, nd);
      } else if (done[j] !== st && (nd < dist[j] || (nd === dist[j] && oi < owner[j]))) {
        dist[j] = nd;
        owner[j] = oi;
        heap.push(j, nd);
      }
    }
  }
}

// 干流（A ≥ TRUNK_KM2）的格
function trunkMask(x: PlainInputs): Uint8Array {
  const { r, A } = x;
  const trunk = new Uint8Array(x.mesh.n);
  for (let k = 0; k < r.count; k++) {
    const i = r.order[k];
    if (A[i] >= PLAINS.TRUNK_KM2) trunk[i] = 1;
  }
  return trunk;
}

// 冲积平原：低处的干流两旁 W 以内（各干流的范围合起来）的格，按它沿流向流进干流的那一格（汇水面积至少是它的 2 倍、
// 至少 TRUNK_KM2 的第一格）的高度压低：压低以后它仍流进那条干流，不顺着平原另起一条平行的河（不打乱流域）。
// 洼地、挨着洼地的格（湖岸）、洼地的溢出口不动
function floodplains(x: PlainInputs, h: Float64Array, changed: Uint8Array, buf: Search) {
  const { mesh, todo, A, kmPerUnit, r } = x;
  const n = mesh.n;
  const cellKm = mesh.spacing * kmPerUnit;
  const trunk = trunkMask(x);
  const near = new Uint8Array(n);
  const claimed: number[] = [];
  for (let k = 0; k < r.count; k++) {
    const t = r.order[k];
    if (!trunk[t] || h[t] > PLAINS.TRUNK_MAX_M * x.mToRaw || inPit(x, t)) continue;
    // W（km）；从干流那一格的边上量：搜索的上限是格心距离 W 加一格（挨着干流的一圈总在里面）。
    // 小得多的支流（汇水面积不到它的一半）流进来的那几格也在这条大河的平原上
    const W = Math.max(PLAINS.W_K * Math.sqrt(A[t]), PLAINS.W_CELLS * cellKm);
    buf.begin();
    buf.seed(t, t);
    expand(mesh, todo, kmPerUnit, buf, W + cellKm, trunk, A, A[t] * PLAINS.TRIB_RATIO);
    markNear(buf, near, claimed);
  }
  if (claimed.length) lowerToTrunk(x, h, changed, claimed, cellKm);
}

function markNear(buf: Search, near: Uint8Array, claimed: number[]) {
  const { reached, count } = buf;
  for (let k = 1; k < count; k++) {
    const c = reached[k];
    if (near[c]) continue;
    near[c] = 1;
    claimed.push(c);
  }
}

// 挨着洼地（湖岸）
function besidePit(x: PlainInputs, c: number): boolean {
  const { off, adj } = x.mesh;
  for (let e = off[c]; e < off[c + 1]; e++) if (inPit(x, adj[e])) return true;
  return false;
}

// 洼地里、挨着洼地的格：它或者它的一个邻格比自己的下游低（求解留下的洼地，水文按气候蓄成湖）。
// 压低湖岸会把湖放干、抬高会改湖面，都不动
function isSpill(x: PlainInputs, h: Float64Array, c: number): boolean {
  if (hollow(x, h, c)) return true;
  const { off, adj } = x.mesh;
  for (let e = off[c]; e < off[c + 1]; e++) if (hollow(x, h, adj[e])) return true;
  return false;
}

function hollow(x: PlainInputs, h: Float64Array, j: number): boolean {
  if (x.todo[j] !== 1) return false;
  const r = x.r.receiver[j];
  return r >= 0 && x.land[r] === 1 && h[j] < h[r];
}

// 沿流向流进的干流格：汇水面积至少是 c 的 1/TRIB_RATIO 倍、至少 TRUNK_KM2 的第一格；先流进海、洼地、走了 16 步还没到的为 −1
const ENTRY_STEPS = 16;
function entryOf(x: PlainInputs, c: number): number {
  const { r, A, land } = x;
  const need = Math.max(PLAINS.TRUNK_KM2, A[c] / PLAINS.TRIB_RATIO);
  let j = r.receiver[c];
  for (let step = 0; step < ENTRY_STEPS; step++) {
    if (j < 0 || !land[j] || inPit(x, j)) return -1;
    if (A[j] >= need) return j;
    j = r.receiver[j];
  }
  return -1;
}

function lowerToTrunk(x: PlainInputs, h: Float64Array, changed: Uint8Array, claimed: number[], cellKm: number) {
  const eps = PLAINS.EPS_M * x.mToRaw;
  // 1. 每格想压到多高（target）：都按压之前的高度算（与先后无关；h 在算完所有格之前不动）
  const cells: number[] = [];
  const target: number[] = [];
  for (let k = 0; k < claimed.length; k++) {
    const c = claimed[k];
    if (inPit(x, c) || besidePit(x, c) || isSpill(x, h, c)) continue;
    const t = entryOf(x, c);
    if (t < 0 || h[t] > PLAINS.TRUNK_MAX_M * x.mToRaw) continue;
    const W = Math.max(PLAINS.W_K * Math.sqrt(x.A[t]), PLAINS.W_CELLS * cellKm);
    const gap = h[c] - h[t];
    const cap = (PLAINS.REL_M + PLAINS.REL_W * W) * x.mToRaw;
    if (gap <= 0 || gap >= 2 * cap) continue;
    // 高出不到 cap 的压到 25%；cap 到 2·cap 之间的逐渐少压（平原的边上是缓缓抬起的阶地，不是一道陡坎）。
    // 汇水面积从 TRUNK_KM2 到 FULL_KM2 的干流压得从轻到重（对数）：小的干流真实的平原只有几 km 宽，格大时铺满一圈会把整片低地压平、打乱流域
    const flat = gap <= cap ? PLAINS.KEEP * gap : PLAINS.KEEP * cap + (gap - cap) * (2 - PLAINS.KEEP);
    const str = Math.min(1, Math.log(x.A[t] / PLAINS.TRUNK_KM2) / Math.log(PLAINS.FULL_KM2 / PLAINS.TRUNK_KM2));
    cells.push(c);
    target.push(h[t] + gap + (flat - gap) * str);
  }
  if (!cells.length) return;
  // 2. 不低于挨着它的格（不流进它的）的下游：干流不改道流进平原、不抄近路，别的河的水不被引过来（不打乱流域）。
  //    下游也压低了的按压低以后的高度（平原上的格可以一起低下去），所以要几遍（每遍都按上一遍的结果，与先后无关）。
  //    就在 h 上改（别的格不动），压之前的高度另存一份
  const m = cells.length;
  const before = new Float64Array(m);
  const next = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const c = cells[k];
    before[k] = h[c];
    h[c] = Math.min(before[k], target[k]);
  }
  for (let it = 0; it < FLOOR_PASSES; it++) {
    floorPass(x, cells, target, before, h, next, eps);
    for (let k = 0; k < m; k++) h[cells[k]] = next[k];
  }
  let lowered = 0;
  for (let k = 0; k < m; k++) {
    if (h[cells[k]] >= before[k]) continue;
    changed[cells[k]] = 1;
    lowered++;
  }
  plainStats.flood += lowered;
}

const FLOOR_PASSES = 3;

// 一遍：每格按现在的高度（cur）算出这一遍的高度，写进 next（按 cells 的下标）
function floorPass(x: PlainInputs, cells: number[], target: number[], before: Float64Array, cur: Float64Array, next: Float64Array, eps: number) {
  for (let k = 0; k < cells.length; k++) next[k] = Math.min(before[k], Math.max(target[k], floorOf(x, cur, cells[k]) + eps));
}

// c 最低能压到多高：挨着它的格（不流进 c 的）的下游里最高的（流进海的算 0；hh：现在的高度）。
// 压低以后挨着它的格（干流、支流、别的流域）照旧流向原来的下游，不改道流进平原。
// （试过放开同一段河上几步之内就进干流的邻格：大河两旁只再低 2 m，汇水面积超越指数从 0.63 变成 0.74，流域被打乱，没有用）
function floorOf(x: PlainInputs, hh: Float64Array, c: number): number {
  const { mesh, r, land, todo } = x;
  let f = -Infinity;
  for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
    const j = mesh.adj[e];
    if (todo[j] !== 1) continue;
    const rj = r.receiver[j];
    if (rj === c) continue;
    const hr = rj >= 0 ? (land[rj] ? hh[rj] : 0) : hh[j];
    if (hr > f) f = hr;
  }
  return f;
}

// 冲积扇：先找山口，再按每个山口的锥垫高（各扇取最高）
function fans(x: PlainInputs, h: Float64Array, changed: Uint8Array, buf: Search) {
  const { mesh, todo, A, kmPerUnit, mToRaw } = x;
  const cellKm = mesh.spacing * kmPerUnit;
  // 山口那一格 → 流出山口的河的汇水面积（几条河从同一格出山时取最大的）
  const apexA = new Map<number, number>();
  const apexTop = new Map<number, number>();
  findApexes(x, h, cellKm, apexA, apexTop);
  if (!apexA.size) return;
  // 锥按垫高之前的高度算：h 在各扇都算完之前不动
  const fanH = new Float64Array(mesh.n).fill(-Infinity);
  const apexes = [...apexA.keys()].sort((a, b) => a - b);
  for (const j of apexes) {
    const a = apexA.get(j)!;
    const R = PLAINS.FAN_R * Math.sqrt(a);
    const g = PLAINS.FAN_G * Math.pow(a / 1e3, PLAINS.FAN_G_EXP) * mToRaw;
    buf.begin();
    buf.seed(j, j);
    expand(mesh, todo, kmPerUnit, buf, R, null);
    coneUp(x, buf, h, fanH, apexTop.get(j)!, g, PLAINS.FAN_A_MUL * A[j]);
  }
  plainStats.fans += apexes.length;
  for (let i = 0; i < mesh.n; i++) {
    if (fanH[i] > h[i]) {
      h[i] = fanH[i];
      changed[i] = 1;
    }
  }
}

// 山口：河从抬升 ≥ FAN_UP 的格 i 流到抬升不到它的格 j（穿过山前那条抬升的等值线），A_i 够大（半径够 0.8 格），
// 山口往下（j 往下游约半个扇的半径、至少一格）的平均坡度不到 i → j 那段的 FAN_SLOPE_RATIO 倍。
// 扇顶在山口，高度取 i、j 的中间（出山的那一点）；几条河从同一格出山时取最大的
function findApexes(x: PlainInputs, h: Float64Array, cellKm: number, out: Map<number, number>, top: Map<number, number>) {
  const { mesh, todo, up, A, r, kmPerUnit } = x;
  const minA = Math.max(PLAINS.FAN_KM2, ((PLAINS.FAN_MIN_CELLS * cellKm) / PLAINS.FAN_R) ** 2);
  for (let k = 0; k < r.count; k++) {
    const i = r.order[k];
    if (A[i] < minA || up[i] < PLAINS.FAN_UP) continue;
    const j = r.receiver[i];
    if (j < 0 || todo[j] !== 1 || inPit(x, j) || up[j] >= PLAINS.FAN_UP) continue;
    const e = r.edge[i];
    const Li = e >= 0 ? mesh.dist[e] * kmPerUnit : cellKm;
    const Si = (h[i] - h[j]) / Li;
    if (!(Si > 0)) continue;
    const Sj = slopeBelow(x, h, j, Math.max(cellKm, 0.5 * PLAINS.FAN_R * Math.sqrt(A[i])), cellKm);
    if (Sj >= PLAINS.FAN_SLOPE_RATIO * Si) continue;
    const prev = out.get(j);
    if (prev === undefined || A[i] > prev) out.set(j, A[i]);
    const z = 0.5 * (h[i] + h[j]);
    const pt = top.get(j);
    if (pt === undefined || z > pt) top.set(j, z);
  }
}

// 从 j 沿流向往下走约 len km（到海、地图边为止）的平均坡度
function slopeBelow(x: PlainInputs, h: Float64Array, j: number, len: number, cellKm: number): number {
  const { mesh, r, land, todo, kmPerUnit } = x;
  let q = j;
  let dist = 0;
  while (dist < len) {
    const nq = r.receiver[q];
    if (nq < 0 || !land[nq] || todo[nq] !== 1) break;
    const e = r.edge[q];
    dist += e >= 0 ? mesh.dist[e] * kmPerUnit : cellKm;
    q = nq;
  }
  return dist > 0 ? (h[j] - h[q]) / dist : 0;
}

// 一个扇（含山口那一格）：锥面 top − g·d，不高过原来加 FAN_MAX_M；只垫汇水面积不到 amax 的格、不动洼地和洼地的溢出口（湖面不变）
function coneUp(x: PlainInputs, buf: Search, h0: Float64Array, fanH: Float64Array, top: number, g: number, amax: number) {
  const { reached, dist, count } = buf;
  const cap = PLAINS.FAN_MAX_M * x.mToRaw;
  for (let k = 0; k < count; k++) {
    const c = reached[k];
    if (x.A[c] > amax || inPit(x, c) || isSpill(x, h0, c)) continue;
    const z = Math.min(h0[c] + cap, top - g * dist[c]);
    if (z > h0[c] && z > fanH[c]) fanH[c] = z;
  }
}

// 三角洲平原：A ≥ DELTA_KM2 的河口（流进海的那一格），r 以内、DELTA_MAX_M（大河放宽）以下的格压到 1–7 m（各三角洲取最低）
function deltas(x: PlainInputs, h: Float64Array, changed: Uint8Array, buf: Search) {
  const { mesh, todo, land, A, r, kmPerUnit, mToRaw } = x;
  const cellKm = mesh.spacing * kmPerUnit;
  const mouths: number[] = [];
  for (let k = 0; k < r.count; k++) {
    const i = r.order[k];
    const j = r.receiver[i];
    if (j < 0 || land[j] || A[i] < PLAINS.DELTA_KM2 || inPit(x, i)) continue;
    mouths.push(i);
  }
  if (!mouths.length) return;
  // 按压低之前的高度算：h 在各三角洲都算完之前不动
  const low = new Float64Array(mesh.n).fill(Infinity);
  for (const m of mouths) {
    const R = PLAINS.DELTA_R * Math.sqrt(A[m]);
    buf.begin();
    buf.seed(m, m);
    expand(mesh, todo, kmPerUnit, buf, R + cellKm, null);
    const topM = Math.min(PLAINS.DELTA_MAX_CAP_M, PLAINS.DELTA_MAX_M * Math.pow(A[m] / PLAINS.DELTA_KM2, PLAINS.DELTA_MAX_EXP));
    deltaLow(x, buf, h, low, R, cellKm, mToRaw, A[m], topM * mToRaw);
  }
  plainStats.deltas += mouths.length;
  let count = 0;
  for (let i = 0; i < mesh.n; i++) {
    if (low[i] < h[i]) {
      h[i] = low[i];
      changed[i] = 1;
      count++;
    }
  }
  plainStats.delta += count;
}

// 干流（汇水面积至少是河口的一半）压到 1–4 m（离河口越远越高），别的格再高 DELTA_RISE_M：干流一直是三角洲上最低的一路，
// 不从平原上另找出海口（不改流域）
function deltaLow(x: PlainInputs, buf: Search, h0: Float64Array, low: Float64Array, R: number, cellKm: number, mToRaw: number, Am: number, top: number) {
  const { reached, dist, count } = buf;
  for (let k = 0; k < count; k++) {
    const c = reached[k];
    if (h0[c] >= top || inPit(x, c) || besidePit(x, c) || isSpill(x, h0, c)) continue;
    const t = Math.min(1, Math.max(0, dist[c] - cellKm) / Math.max(R, 1e-9));
    const z = (PLAINS.DELTA_LOW_M + PLAINS.DELTA_RISE_M * (x.A[c] * 2 >= Am ? t : 1 + t)) * mToRaw;
    if (z < low[c]) low[c] = z;
  }
}

// 改过的格不低于原来的下游（按最后一轮的流向，从出口往上游）：平原、三角洲不新造洼地，扇不堵住流进来的支流。
// 挖过的洼地不动；本来就比下游低的格（求解留下的洼地、小块海挖成的湖）也不动。h0：平原与河口之前的高度
function keepDrainage(x: PlainInputs, h: Float64Array, h0: Float64Array, changed: Uint8Array) {
  const { r, land } = x;
  const eps = PLAINS.EPS_M * x.mToRaw;
  for (let k = 0; k < r.count; k++) {
    const i = r.order[k];
    const j = r.receiver[i];
    if (j < 0 || !land[j] || (changed[i] === 0 && changed[j] === 0) || inPit(x, i) || h0[i] < h0[j]) continue;
    if (h[i] < h[j] + eps) {
      plainStats.raised++;
      h[i] = h[j] + eps;
      changed[i] = 1;
    }
  }
}
