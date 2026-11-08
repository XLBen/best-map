// 陆地高程的求解（第八十三轮从 core/elevation.ts 原样搬出）：抬升与下切的稳态迭代、迎风坡、洼地
import { smoothstep } from './rng';
import { type World, latitudeOf } from './world';
import { gradGeo, graphDistanceSame, type Mesh } from './mesh';
import { Router, accumulate, type Routing } from './routing';
import { applyPlains } from './plains';
import { dryPits, wetWeights } from './elevation-precip';
import { glacialFieldOf, iceStrength } from './glacial';
import { glacialLegacy, glacialScourInSolve } from './glacial-legacy';

// 高程 = 抬升与河流下切的稳态（stream power law，n = 1）：
//   dh/dt = U − K·A^m·S = 0  ⇒  沿河道 h_i = h_下游 + U_i·L / (K_i·A_i^m)
// 河网取决于高程、高程又取决于河网，交替迭代到河网稳定。
// 这样得到的山谷是树枝状的、坡度随汇水面积变缓，与真实地貌的统计规律一致。
const M = 0.45;
// 原始单位到米的换算：抬升 1.0、约 600 km 宽的山带峰高约为 mountainScale
export const RAW_TO_M = 1 / 3.4;
const ITERATIONS = 12;
// 第三十二轮：基准面 T、洼地 pit 是米（按默认的“最高的山”6000 m），求解时换成原始单位（“最高的山”照旧只是缩放）
const M_TO_RAW = 3.4 / 6000;
// 基础抬升（让平原也有起伏）与抬升的倍数：第三十二轮有了基准面（大陆倾斜、高原都垫在下面），
// 从 0.035 与 1 降下来，高度分布照旧像地球（200 m 以下约 1/4，2000 m 以上约 1/10）
const BASE_UPLIFT = 0.012;
const UPLIFT_SCALE = 0.72;
// 高度大致与（UPLIFT_FLOOR + 抬升）成正比（界面按它估计堆山堆高了多少，见 src/ui/edits.ts）
export const UPLIFT_FLOOR = BASE_UPLIFT / UPLIFT_SCALE;
// 初始高程按离海距离的缓坡（每 km）：第三十二轮以前是 0.002，固定的 12 轮一开始就把水引向最近的海岸、河往四面放射；
// 现在小得多，一开始按基准面（大陆倾斜）汇流
const INIT_SLOPE = 0.0001;
// 初始高程加上这么多基准面
const INIT_T = 0.9;
// 基准面作软底：每格往上补到 T 的比例 1 − exp(−L / (KNICK_KM · √(A / 1e4)))（大河切出峡谷、小溪留在高原面上），
// 离海 COAST_FADE_KM 以内逐渐减弱
const KNICK_KM = 40;
const COAST_FADE_KM = 80;
// 地图边上（地区）的出口：基准面是 0.8·T，不再当海
const EDGE_BASE = 0.8;
// 挖洼地：上游来沙（抬升 × 面积，km²）× SED_FILL 与洼地容积（深 m × 面积 km²）的比 f，挖 pit·(1 − f)
const SED_FILL = 10;
// 迎风一侧更易蚀（按新建时的纬度定盛行风）：可蚀性最多 × (1 + WINDWARD)
const WINDWARD = 0.35;

export const bitsOf = (a: Float32Array) => new Uint32Array(a.buffer, a.byteOffset, a.length);

// 迎风（第三十二轮）：按新建时的纬度定的盛行风往东（+1）还是往西（−1）吹：信风带、极地往西，西风带往东
function windEast(latDeg: number): number {
  const a = Math.abs(latDeg);
  return 2 * smoothstep(25, 35, a) * (1 - smoothstep(55, 65, a)) - 1;
}

// 可蚀性的迎风倍数（1 到 1 + WINDWARD）：抬升沿盛行风的方向变高（山的迎风坡）的格更易蚀，分水岭被推向背风一侧。
// 只看陆上的邻格（一块陆地的结果只取决于它自己）；只要东西方向的分量（与 gradientAt 同一个最小二乘，南北取 0 的近似）。
// 纬度是新建时的（地区按 settings 的南北边，不看之后挪的纬度；整个星球按格的位置）
export function windwardFactor(world: World, geo: ReturnType<typeof gradGeo>, i: number): number {
  const { mesh, causes } = world;
  const land = causes.land;
  const up = causes.uplift;
  let bx = 0;
  for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
    const j = mesh.adj[e];
    if (land[j]) bx += geo.wdx[e] * (up[j] - up[i]);
  }
  if (bx === 0 || Math.abs(geo.det[i]) < 1e-30) return 1;
  const gx = (geo.syy[i] * bx) / geo.det[i];
  const lat = mesh.kind === 'sphere' ? (Math.asin(Math.max(-1, Math.min(1, mesh.p[3 * i + 2]))) * 180) / Math.PI : latitudeOf(world.settings, mesh.y[i]);
  return 1 + WINDWARD * Math.max(0, Math.min(1, (gx * windEast(lat)) / 8));
}

// 求解的几个常数（routing-identity 测试里照旧写法的那一份要用）
export const SOLVE = { BASE_UPLIFT, UPLIFT_SCALE, INIT_SLOPE, INIT_T, KNICK_KM, COAST_FADE_KM, EDGE_BASE, M_TO_RAW };

// 只算 todo 里的陆块（若干个完整的陆块）：写进 h（扩散后的）与 coastKm，别的格不动。
// T、pit：基准面、洼地（米，第三十二轮）
export function solveLand(world: World, todo: Uint8Array, fu: Float64Array, fk: Float64Array, fs: Float64Array, Tm: Float32Array, pitM: Float32Array, h: Float64Array, coastKm: Float64Array) {
  const { mesh, causes, kmPerUnit } = world;
  const n = mesh.n;
  const land = causes.land;
  const sphere = mesh.kind === 'sphere' ? mesh : null;

  // 海岸距离：从挨海的陆格出发只走陆格（陆上的距离与海上互不影响，海上的用不到）
  // 第三十五轮（提速）：逐格的几段放进小函数（原样照搬）；海岸距离用专门的函数，
  // 与传闭包 (i, j, e) => (land[i] === land[j] ? mesh.dist[e] : Infinity) 逐值相同
  const coastBuf = new Int32Array(n);
  const coast = graphDistanceSame(mesh, coastBuf.subarray(0, todoCoast(n, mesh.off, mesh.adj, todo, land, coastBuf)), Infinity, land);
  coastKmOf(n, todo, coast, kmPerUnit, coastKm);

  const u = new Float64Array(n);
  const K = new Float64Array(n);
  const areaKm = new Float64Array(n);
  // 汇水面积加一个按地图面积取的常数：源头格的面积随格数变化，不加的话格越密山越高
  // 整个星球按布局尺度（半圈经线的一半）算，和同样格距的地区地图相当
  const areaReg = sphere ? (mesh.totalArea * (kmPerUnit / 2) * (kmPerUnit / 2)) / 20000 : (mesh.width * mesh.height * kmPerUnit * kmPerUnit) / 20000;
  // 基准面（原始单位）与离海的减弱
  const T = new Float64Array(n);
  const fade = new Float64Array(n);
  const geo = gradGeo(mesh);
  const up = causes.uplift;
  for (let i = 0; i < n; i++) if (todo[i]) solveInputs(world, geo, i, fu, fk, Tm, coastKm, u, K, areaKm, T, fade);
  // 降水（第八十六轮，见 elevation-precip.ts）：汇水面积按降水代理加权成流量（湿处下切多、干处少）
  const wet = new Float64Array(n);
  const areaQ = new Float64Array(n);
  const dry = new Float32Array(n);
  const anyDry = wetWeights(world, todo, T, coastKm, fk, areaKm, wet, areaQ, dry);
  // 画的河不改地形的求解：求解之后再挖河床（carveBeds），周围的山不动

  // 初始高程：按离海距离给一个缓坡加噪声，再加上大半个基准面（固定的 12 轮一开始就按大陆倾斜汇流；固定初值，结果只取决于原因）
  initHeights(n, todo, coastKm, u, fs, T, fade, h);

  // 固定轮数：每个流域的计算只取决于它自己，在一处编辑不会因为“全局收敛轮数”变化而改动远处的地形
  // 活动格与强制方向各轮相同：路由的出口、缓冲区只建一次
  // 传一张全是 -1 的强制方向表（没有哪格强制）：与不传时的路由在平局时的先后不同，一直是这样算的，金标准按它记
  const router = new Router(mesh, todo, new Int32Array(n).fill(-1));
  const A = new Float64Array(n);
  // A^m 很费时：汇水面积与上一轮完全相同的格（源头格每轮都是）沿用上一轮的值
  const lastA = new Float64Array(n).fill(-1);
  const powA = new Float64Array(n);
  // 软底补的比例 1 − exp(−L / (KNICK_KM·√(A/1e4)))：汇水面积、到下游的距离与上一轮相同时沿用（与 A^m 一样）
  const lam = new Float64Array(n);
  const lamA = new Float64Array(n).fill(-1);
  const lamL = new Float64Array(n).fill(-1);
  const edge = mesh.boundary;
  const st: SolveState = { u, K, A, T, fade, lastA, powA, lam, lamA, lamL, areaReg, kmPerUnit };
  let r = router.route(h);
  for (let it = 0; it < ITERATIONS; it++) {
    if (it > 0) r = router.route(h);
    accumulate(r, areaQ, A);
    solvePass(mesh, r, land, edge, st, h);
  }
  // 平原、洼地按真的面积（km²）：最后一轮的流向再累加一次
  accumulate(r, areaKm, A);
  // 干的洼地（第八十六轮）：只挖小流域里、上游不大的那些（不把大流域的上游截成内流区）
  const pitL = anyDry ? dryPits(world, todo, r, A, pitM, dry) : pitM;

  // 坡面过程：轻度扩散，削掉单格尖峰
  const tmp = Float64Array.from(h);
  for (let pass = 0; pass < 2; pass++) {
    diffusePass(mesh, todo, land, h, tmp);
    h.set(tmp);
  }

  carvePits(world, todo, r, u, areaKm, pitL, fade, h, wet);
  // 平原与河口（第三十三轮）：冲积平原、冲积扇、三角洲平原，按最后一轮的流向与汇水面积一遍过
  if (plainsOn.on) applyPlains({ mesh, todo, land, up, areaKm, r, A, kmPerUnit, mToRaw: M_TO_RAW, pitM: pitL }, h);
  // 冰川刻蚀（第三十四轮）：第八十六轮起不在这里挖，按现在的冷暖在流水线里另挖（core/glacial.ts 的 scourTerrain）。
  // 测试退回第八十五轮时（glacialLegacy）照旧在这里挖
  if (glacialLegacy.on) glacialScourInSolve(glacialFieldOf(world, iceStrength(world, true)), mesh, todo, land, coastKm, kmPerUnit, M_TO_RAW, h);
}

// 第三十五轮（提速）：solveLand 开头几段逐格的循环（原样照搬，结果逐值相同）。
// 挨海的要算的陆格（按编号，写进 out），返回个数
function todoCoast(n: number, off: Int32Array, adj: Int32Array, todo: Uint8Array, land: Uint8Array, out: Int32Array): number {
  let m = 0;
  for (let i = 0; i < n; i++) {
    if (!todo[i]) continue;
    for (let e = off[i]; e < off[i + 1]; e++) {
      if (land[adj[e]] !== land[i]) {
        out[m++] = i;
        break;
      }
    }
  }
  return m;
}

// 离海岸的 km（走不到海的为 1e5）
function coastKmOf(n: number, todo: Uint8Array, coast: Float64Array, kmPerUnit: number, coastKm: Float64Array) {
  for (let i = 0; i < n; i++) if (todo[i]) coastKm[i] = Number.isFinite(coast[i]) ? coast[i] * kmPerUnit : 1e5;
}

// 一格的求解输入：抬升、可蚀性（含迎风）、面积、基准面、离海的减弱
function solveInputs(world: World, geo: ReturnType<typeof gradGeo>, i: number, fu: Float64Array, fk: Float64Array, Tm: Float32Array, coastKm: Float64Array, u: Float64Array, K: Float64Array, areaKm: Float64Array, T: Float64Array, fade: Float64Array) {
  const { mesh, causes, kmPerUnit } = world;
  // 基础抬升让平原也有起伏；噪声打破对称，使河网各不相同
  u[i] = (BASE_UPLIFT + UPLIFT_SCALE * causes.uplift[i]) * fu[i];
  K[i] = causes.erod[i] * fk[i] * windwardFactor(world, geo, i);
  areaKm[i] = mesh.area[i] * kmPerUnit * kmPerUnit;
  T[i] = Tm[i] * M_TO_RAW;
  fade[i] = smoothstep(0, COAST_FADE_KM, coastKm[i]);
}

// 初始高程
function initHeights(n: number, todo: Uint8Array, coastKm: Float64Array, u: Float64Array, fs: Float64Array, T: Float64Array, fade: Float64Array, h: Float64Array) {
  for (let i = 0; i < n; i++) {
    if (!todo[i]) continue;
    h[i] = coastKm[i] * INIT_SLOPE * (0.3 + u[i]) + 0.05 * (1 + fs[i]) + INIT_T * T[i] * fade[i];
  }
}

// 测试用：关掉平原与河口（第三十三轮以前的求解）
export const plainsOn = { on: true };

// 第三十二轮（提速）：solveLand 每一轮沿河往上求高、坡面扩散的一遍拆成小函数（很快就被编译优化；
// 写在大函数里时，前几次求解常常还没编译好就算完了），原样照搬，结果逐值相同
interface SolveState {
  u: Float64Array;
  K: Float64Array;
  A: Float64Array;
  T: Float64Array;
  fade: Float64Array;
  lastA: Float64Array;
  powA: Float64Array;
  lam: Float64Array;
  lamA: Float64Array;
  lamL: Float64Array;
  areaReg: number;
  kmPerUnit: number;
}

// 一轮：按这一轮的流向，从出口往上游逐格求高
function solvePass(mesh: Mesh, r: Routing, land: Uint8Array, edge: Uint8Array, st: SolveState, h: Float64Array) {
  const { u, K, A, T, fade, lastA, powA, lam, lamA, lamL, areaReg, kmPerUnit } = st;
  for (let k = 0; k < r.count; k++) {
    const i = r.order[k];
    const j = r.receiver[i];
    // 下游是陆格：它的高；挨海：0；地图边上（地区，没有下游）：0.8·T
    const baseH = j >= 0 ? (land[j] ? h[j] : 0) : edge[i] ? EDGE_BASE * Math.max(0, T[i]) * fade[i] : 0;
    // 到下游的距离；没有下游或下游不是邻格时取格距
    const e = r.edge[i];
    const L = e >= 0 ? mesh.dist[e] * kmPerUnit : kmPerUnit * mesh.spacing;
    if (A[i] !== lastA[i]) {
      lastA[i] = A[i];
      powA[i] = Math.pow(A[i] + areaReg, M);
    }
    let hi = baseH + (u[i] * L) / (K[i] * powA[i]);
    // 基准面作软底：往上补到 T 的一部分（小溪几乎补满，留在高原面上；大河补得少，切出峡谷）
    const gap = T[i] - hi;
    if (gap > 0 && fade[i] > 0) {
      if (A[i] !== lamA[i] || L !== lamL[i]) {
        lamA[i] = A[i];
        lamL[i] = L;
        lam[i] = fade[i] * (1 - Math.exp(-L / (KNICK_KM * Math.sqrt(A[i] / 1e4))));
      }
      hi += gap * lam[i];
    }
    h[i] = hi;
  }
}

// 坡面扩散的一遍（读 h、写 tmp）
function diffusePass(mesh: Mesh, todo: Uint8Array, land: Uint8Array, h: Float64Array, tmp: Float64Array) {
  const n = mesh.n;
  for (let i = 0; i < n; i++) {
    if (!todo[i]) continue;
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
}

// 洼地场超过这么多（米）的格连成一片洼地
const PIT_MIN_M = 30;
const PIT_MIN_CELLS = 3;

// 洼地里的格（要算的陆格、洼地场超过 PIT_MIN_M）：写成模块里的函数，不是每次新建的闭包（第三十二轮提速）
function inPit(todo: Uint8Array, pitM: Float32Array, i: number): boolean {
  return todo[i] === 1 && pitM[i] > PIT_MIN_M;
}

// 挖洼地（第三十二轮）：一片洼地（洼地场超过 PIT_MIN_M 的格连成的块）按四周最低的岸取平底，
// 再按流进这片洼地的沙（抬升 × 面积，沿最后一轮的流向累加：外面流进来的加上洼地里自己的）与它的容积（深 × 面积）的比 f
// 往下挖 pit·(1 − f)：山上来的沙填满的成了平原（平到岸的高度），孤立的留成平底的洼地；
// 水文按气候定它是湖、内流湖还是干盐湖。
// 挨着海的洼地不取平底（岸是海），只往下挖。只动 todo 里的格，结果只取决于这块陆地
export function carvePits(world: World, todo: Uint8Array, r: Routing, u: Float64Array, areaKm: Float64Array, pitM: Float32Array, fade: Float64Array, h: Float64Array, wet?: Float64Array) {
  const { mesh, causes } = world;
  const n = mesh.n;
  const land = causes.land;
  const { off, adj } = mesh;
  // 只看路由排到的格（就是 todo 里的格）：一片洼地的结果与别的洼地、先后都无关
  const { order, count } = r;
  let any = false;
  for (let k = 0; k < count && !any; k++) if (pitM[order[k]] > PIT_MIN_M) any = true;
  if (!any) return;
  const sed = new Float64Array(n);
  for (let k = 0; k < count; k++) {
    const i = order[k];
    sed[i] = u[i] * areaKm[i] * (wet ? wet[i] : 1);
  }
  const S = new Float64Array(n);
  accumulate(r, sed, S);
  const seen = new Uint8Array(n);
  const queue: number[] = [];
  for (let k = 0; k < count; k++) {
    const s0 = order[k];
    if (seen[s0] || !inPit(todo, pitM, s0)) continue;
    queue.length = 0;
    queue.push(s0);
    seen[s0] = 1;
    let rim = Infinity;
    let coastal = false;
    for (let q = 0; q < queue.length; q++) {
      const c = queue[q];
      for (let e = off[c]; e < off[c + 1]; e++) {
        const j = adj[e];
        if (inPit(todo, pitM, j)) {
          if (!seen[j]) {
            seen[j] = 1;
            queue.push(j);
          }
        } else if (!land[j]) coastal = true;
        else rim = Math.min(rim, h[j]);
      }
    }
    // 只擦到一两格的不挖（不留一格一格的小坑）
    if (queue.length < PIT_MIN_CELLS) continue;
    // 流进来的沙与容积
    let supply = 0;
    let volume = 0;
    for (const c of queue) {
      supply += sed[c];
      volume += pitM[c] * areaKm[c];
      for (let e = off[c]; e < off[c + 1]; e++) {
        const j = adj[e];
        if (todo[j] && !inPit(todo, pitM, j) && r.receiver[j] === c) supply += S[j];
      }
    }
    const f = Math.min(1, (supply * SED_FILL) / volume);
    for (const c of queue) {
      const depth = pitM[c] * M_TO_RAW * (1 - f) * fade[c];
      h[c] = coastal || !Number.isFinite(rim) ? h[c] - depth : Math.min(h[c], rim - depth);
    }
  }
}
