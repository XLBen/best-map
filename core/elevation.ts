import { MinHeap } from './heap';
import { HeapLite, type Mesh, graphDistance } from './mesh';
import { LAYOUT_R } from './planet-gen';
import { fbm, fbm3, gradientNoise, gradientNoise3, mixSeed, mulberry32, smoothstep } from './rng';
import { Router, accumulate } from './routing';
import { seabedFields } from './terrain';
import type { World } from './world';

// 高程 = 抬升与河流下切的稳态（stream power law，n = 1）：
//   dh/dt = U − K·A^m·S = 0  ⇒  沿河道 h_i = h_下游 + U_i·L / (K_i·A_i^m)
// 河网取决于高程、高程又取决于河网，交替迭代到河网稳定。
// 这样得到的山谷是树枝状的、坡度随汇水面积变缓，与真实地貌的统计规律一致。
const M = 0.45;
// 原始单位到米的换算：抬升 1.0、约 600 km 宽的山带峰高约为 mountainScale
const RAW_TO_M = 1 / 3.4;
const ITERATIONS = 12;

export interface ElevationResult {
  elevation: Float32Array;
  // 陆格到最近海岸的距离（km）。只用到陆上的，所以只沿陆格算；海格与到不了海的陆格为 1e5
  coastKm: Float64Array;
}

// 每格的噪声因子：抬升、可蚀性的倍数与初始高程的起伏。只取决于网格与种子，
// 所以按网格缓存（每个网格只留两个种子），编辑地形时不再重算这三个分形噪声场
interface NoiseFactors {
  fu: Float64Array;
  fk: Float64Array;
  fs: Float64Array;
}
const noiseCache = new WeakMap<Mesh, Map<number, NoiseFactors>>();

function noiseFactors(mesh: Mesh, seed: number): NoiseFactors {
  let bySeed = noiseCache.get(mesh);
  if (!bySeed) noiseCache.set(mesh, (bySeed = new Map()));
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

// 按陆块复用（第九轮 A2）：一块陆地（陆格的连通块）的高程只取决于它自己——海岸距离只沿陆格走、路由与
// 汇水只在它里面（出口指向海，海格的 h 是 0）、扩散只看它的陆格与海（0）、噪声与面积只取决于网格。
// 路由的洪泛顺序在两块陆地之间会交错，但同一块陆地里任意两格的先后只取决于这块陆地本身（同高时按入堆先后，
// 入堆先后又由同一块里更早弹出的格决定，出口按编号入堆），所以只算一部分陆块时，这些陆块的每一格逐值相同。
// 记下最近两次的输入（海陆、抬升、岩性）与结果（扩散后的 h、海岸距离）：一块陆地的格、它外面一圈的海、
// 格上的抬升与岩性都与某一次逐字节相同时直接用那一次的值，其余的陆块（改过的、新出现的）一起重算。
interface ElevationMemoEntry {
  seed: number;
  kmPerUnit: number;
  land: Uint8Array;
  uplift: Uint32Array;
  erod: Uint32Array;
  h: Float64Array;
  coastKm: Float64Array;
}
const elevMemo = new WeakMap<Mesh, ElevationMemoEntry[]>();
// 测试用：on = false 时不读也不写缓存；reused、computed：复用、重算的陆块数
export const elevationMemo = { on: true, reused: 0, computed: 0 };

const bitsOf = (a: Float32Array) => new Uint32Array(a.buffer, a.byteOffset, a.length);

// 陆块 cells（land 的一个连通块）在 e 里是同一块、抬升与岩性逐位相同
function sameComponent(mesh: Mesh, land: Uint8Array, uplift: Uint32Array, erod: Uint32Array, cells: Int32Array, e: ElevationMemoEntry): boolean {
  const { off, adj } = mesh;
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k];
    if (e.land[c] !== 1 || e.uplift[c] !== uplift[c] || e.erod[c] !== erod[c]) return false;
    for (let q = off[c]; q < off[c + 1]; q++) {
      const j = adj[q];
      if (!land[j] && e.land[j]) return false;
    }
  }
  return true;
}

export function computeElevation(world: World): ElevationResult {
  const { mesh, causes, kmPerUnit } = world;
  const n = mesh.n;
  const land = causes.land;
  const seed = world.settings.seed;
  const { fu, fk, fs } = noiseFactors(mesh, seed);
  const upBits = bitsOf(causes.uplift);
  const erBits = bitsOf(causes.erod);

  // 要算的陆格（todo = 1）；能复用的陆块直接写进 h、coastKm
  const h = new Float64Array(n);
  const coastKm = new Float64Array(n).fill(1e5);
  const todo = new Uint8Array(n);
  const entries = elevationMemo.on ? (elevMemo.get(mesh) ?? []).filter((e) => e.seed === seed && e.kmPerUnit === kmPerUnit) : [];
  let todoCount = 0;
  {
    const seen = new Uint8Array(n);
    const queue = new Int32Array(n);
    for (let s = 0; s < n; s++) {
      if (!land[s] || seen[s]) continue;
      let len = 0;
      queue[len++] = s;
      seen[s] = 1;
      for (let q = 0; q < len; q++) {
        const c = queue[q];
        for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
          const j = mesh.adj[e];
          if (land[j] && !seen[j]) {
            seen[j] = 1;
            queue[len++] = j;
          }
        }
      }
      const cells = queue.subarray(0, len);
      const hit = entries.find((e) => sameComponent(mesh, land, upBits, erBits, cells, e));
      if (hit) {
        elevationMemo.reused++;
        for (let k = 0; k < len; k++) {
          const c = cells[k];
          h[c] = hit.h[c];
          coastKm[c] = hit.coastKm[c];
        }
      } else {
        elevationMemo.computed++;
        for (let k = 0; k < len; k++) todo[cells[k]] = 1;
        todoCount += len;
      }
    }
  }
  // 缓存关掉时照旧总是走一遍（没有陆地也路由 12 轮），与原来的每一步相同
  if (todoCount > 0 || !elevationMemo.on) solveLand(world, todo, fu, fk, fs, h, coastKm);
  if (elevationMemo.on) {
    const entry: ElevationMemoEntry = { seed, kmPerUnit, land: land.slice(), uplift: upBits.slice(), erod: erBits.slice(), h: h.slice(), coastKm: coastKm.slice() };
    elevMemo.set(mesh, [entry, ...(elevMemo.get(mesh) ?? [])].slice(0, 2));
  }
  return finishElevation(world, h, coastKm);
}

// 只算 todo 里的陆块（若干个完整的陆块）：写进 h（扩散后的）与 coastKm，别的格不动
function solveLand(world: World, todo: Uint8Array, fu: Float64Array, fk: Float64Array, fs: Float64Array, h: Float64Array, coastKm: Float64Array) {
  const { mesh, causes, kmPerUnit } = world;
  const n = mesh.n;
  const land = causes.land;
  const sphere = mesh.kind === 'sphere' ? mesh : null;

  // 海岸距离：从挨海的陆格出发只走陆格（陆上的距离与海上互不影响，海上的用不到）
  const coastCells: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!todo[i]) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      if (land[mesh.adj[e]] !== land[i]) {
        coastCells.push(i);
        break;
      }
    }
  }
  const coast = graphDistance(mesh, coastCells, Infinity, (i, j, e) => (land[i] === land[j] ? mesh.dist[e] : Infinity));
  for (let i = 0; i < n; i++) if (todo[i]) coastKm[i] = Number.isFinite(coast[i]) ? coast[i] * kmPerUnit : 1e5;

  const u = new Float64Array(n);
  const K = new Float64Array(n);
  const areaKm = new Float64Array(n);
  // 汇水面积加一个按地图面积取的常数：源头格的面积随格数变化，不加的话格越密山越高
  // 整个星球按布局尺度（半圈经线的一半）算，和同样格距的地区地图相当
  const areaReg = sphere ? (mesh.totalArea * (kmPerUnit / 2) * (kmPerUnit / 2)) / 20000 : (mesh.width * mesh.height * kmPerUnit * kmPerUnit) / 20000;
  for (let i = 0; i < n; i++) {
    if (!todo[i]) continue;
    // 基础抬升让平原也有起伏；噪声打破对称，使河网各不相同
    u[i] = (0.035 + causes.uplift[i]) * fu[i];
    K[i] = causes.erod[i] * fk[i];
    areaKm[i] = mesh.area[i] * kmPerUnit * kmPerUnit;
  }
  // 画的河不改地形的求解：求解之后再挖河床（carveBeds），周围的山不动

  // 初始高程：按离海距离给一个缓坡加噪声（固定初值，结果只取决于原因）
  for (let i = 0; i < n; i++) {
    if (!todo[i]) continue;
    h[i] = coastKm[i] * 0.002 * (0.3 + u[i]) + 0.05 * (1 + fs[i]);
  }

  // 固定轮数：每个流域的计算只取决于它自己，在一处编辑不会因为“全局收敛轮数”变化而改动远处的地形
  // 活动格与强制方向各轮相同：路由的出口、缓冲区只建一次
  // 传一张全是 -1 的强制方向表（没有哪格强制）：与不传时的路由在平局时的先后不同，一直是这样算的，金标准按它记
  const router = new Router(mesh, todo, new Int32Array(n).fill(-1));
  const A = new Float64Array(n);
  // A^m 很费时：汇水面积与上一轮完全相同的格（源头格每轮都是）沿用上一轮的值
  const lastA = new Float64Array(n).fill(-1);
  const powA = new Float64Array(n);
  for (let it = 0; it < ITERATIONS; it++) {
    const r = router.route(h);
    accumulate(r, areaKm, A);
    for (let k = 0; k < r.count; k++) {
      const i = r.order[k];
      const j = r.receiver[i];
      const baseH = j >= 0 && land[j] ? h[j] : 0;
      // 到下游的距离；没有下游或下游不是邻格时取格距
      const e = r.edge[i];
      const L = e >= 0 ? mesh.dist[e] * kmPerUnit : kmPerUnit * mesh.spacing;
      if (A[i] !== lastA[i]) {
        lastA[i] = A[i];
        powA[i] = Math.pow(A[i] + areaReg, M);
      }
      h[i] = baseH + (u[i] * L) / (K[i] * powA[i]);
    }
  }

  // 坡面过程：轻度扩散，削掉单格尖峰
  const tmp = Float64Array.from(h);
  for (let pass = 0; pass < 2; pass++) {
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
    h.set(tmp);
  }
}

// 扩散后的 h 换成米、海底取地壳高度、挖用户放的湖
function finishElevation(world: World, h: Float64Array, coastKm: Float64Array): ElevationResult {
  const { mesh, causes, small } = world;
  const n = mesh.n;
  const land = causes.land;
  const scale = small.planet.mountainScale * RAW_TO_M;
  const elevation = new Float32Array(n);
  for (let i = 0; i < n; i++) if (land[i]) elevation[i] = Math.max(2, h[i] * scale);
  // 海底：按离岸距离的大陆架 → 陆架坡折 → 陆坡 → 陆隆 → 深海（见 seafloor）
  seafloor(world, elevation);

  // 湖：挖一个洼地，由水文按溢出口蓄水。
  // 以紧贴湖面的一圈格里最低的为基准往下挖：它就是溢出口，湖面 = 它的高度，
  // 所以湖面正好是 lakeArea 给出的那些格（预览就是结果），边上也至少有 1 m 深。
  // 湖底的形状（第十二轮）：岸边一圈浅滩（湖岸带），往里陡陡地落下去，中间是湖盆，湖盆里有一两个更深的地方
  // （位置按种子与湖的位置定，结果确定）；最深处正好是给的深度。湖深时湖底可以低于海平面（像死海、里海）
  for (const lake of small.lakes) {
    const c = lake.cell;
    if (!land[c]) continue;
    const rUnits = lakeRadiusUnits(world, lake.radius);
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
    const cells: number[] = [];
    for (let i = 0; i < n; i++) if (inside(i)) cells.push(i);
    const f = lakeBedShape(world, c, rUnits, cells, d);
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k];
      elevation[i] = Math.min(elevation[i], rim - 1 - lake.depth * f[k]);
    }
  }
  return { elevation, coastKm };
}

// ---------- 海底（第十二轮） ----------
// 海格的深度不再直接取地壳高度，而是按离岸的距离（只走海格的图距离）给出真实的剖面：
//   大陆架：从岸边几米缓缓变深到陆架坡折（约 −130 m，−85 到 −175），上面只有几十米的起伏；
//     宽度随地方变（约 40–190 km）：陆壳上（被动大陆边缘）宽，洋壳上的岛、挨着高山的海岸（活动边缘）窄到几 km，
//     大陆块大的宽、小岛窄；
//     淹没在水下的陆壳（被动大陆边缘）上，大陆架一直宽到洋壳为止（最多约 360 km）；
//   陆坡：坡折之外 50–90 km 降到约 −3000 m（网格粗时至少一格多宽，不会一格就掉下去）；
//   陆隆：再往外几百 km 慢慢降到洋底的目标深度。
// 洋底的目标深度来自生成器（terrain.ts 的 seabedFields）：随离洋中脊变深（−2600 到 −5500 m）、海沟 −7000 到 −10000 m、
// 海山；陆壳上（淹没的大陆、画出来的海）浅得多。画的海、画的陆地都只按离岸距离与这些场算，所以和自然的海岸一样。
// 陆地一格不动，海陆的分界也不动（只看 causes.land）。结果只取决于陆海、landness、海岸附近的抬升与生成器，
// 与上一次逐字节相同的输入直接用上一次的结果（拖滑块、改气候、只改陆上抬升时不重算）

// 海底的几个噪声（每格一个值）：只取决于网格与种子，按网格缓存
interface SeaNoise {
  // 大陆架宽度的低频变化、坡折深度、架上的起伏
  w: Float32Array;
  b: Float32Array;
  s: Float32Array;
}
const seaNoiseCache = new WeakMap<Mesh, Map<number, SeaNoise>>();

function seaNoise(mesh: Mesh, seed: number): SeaNoise {
  let bySeed = seaNoiseCache.get(mesh);
  if (!bySeed) seaNoiseCache.set(mesh, (bySeed = new Map()));
  let f = bySeed.get(seed);
  if (f) return f;
  const n = mesh.n;
  f = { w: new Float32Array(n), b: new Float32Array(n), s: new Float32Array(n) };
  if (mesh.kind === 'sphere') {
    const nw = gradientNoise3(mixSeed(seed, 121));
    const nb = gradientNoise3(mixSeed(seed, 122));
    const ns = gradientNoise3(mixSeed(seed, 123));
    for (let i = 0; i < n; i++) {
      const px = mesh.p[3 * i] * LAYOUT_R;
      const py = mesh.p[3 * i + 1] * LAYOUT_R;
      const pz = mesh.p[3 * i + 2] * LAYOUT_R;
      f.w[i] = fbm3(nw, px, py, pz, 3, 3);
      f.b[i] = fbm3(nb, px, py, pz, 6, 2);
      f.s[i] = fbm3(ns, px, py, pz, 40, 3);
    }
  } else {
    const nw = gradientNoise(mixSeed(seed, 121));
    const nb = gradientNoise(mixSeed(seed, 122));
    const ns = gradientNoise(mixSeed(seed, 123));
    for (let i = 0; i < n; i++) {
      const x = mesh.x[i];
      const y = mesh.y[i];
      f.w[i] = fbm(nw, x, y, 3, 3);
      f.b[i] = fbm(nb, x, y, 6, 2);
      f.s[i] = fbm(ns, x, y, 40, 3);
    }
  }
  if (bySeed.size >= 2) bySeed.delete(bySeed.keys().next().value!);
  bySeed.set(seed, f);
  return f;
}

interface SeafloorMemoEntry {
  seed: number;
  kmPerUnit: number;
  fields: ReturnType<typeof seabedFields>;
  land: Uint8Array;
  landness: Float32Array;
  landDelta: Float32Array;
  uplift: Float32Array;
  // 每个陆格所在陆块的大小系数（海格为 0）：改了一小片海陆时只重新数挨着改动的陆块
  lsize: Float32Array;
  // 每个岸边海格挨着的陆地的抬升（最大）与陆块大小系数；不是岸边的格为 0。toOcean：每个海格离洋壳的格数
  up: Float32Array;
  size: Float32Array;
  toOcean: Int32Array;
  // 离岸距离与最近的岸边格；W、A 每一遍平滑的结果（[0] 是平滑之前的）；结果
  dist: Float64Array;
  owner: Int32Array;
  W: Float32Array[];
  A: Float32Array[];
  z: Float32Array;
}
const seafloorMemo = new WeakMap<Mesh, SeafloorMemoEntry[]>();
// 测试用：on = false 时不读也不写缓存；reused：直接用上一次的结果，partial：只重算改动附近，computed：整个重算
export const seafloorStats = { on: true, reused: 0, partial: 0, computed: 0 };

// 生成器的两个场按内容比（重新打开的世界是另一份数组，内容相同）
function sameFields(a: { ocean: Float32Array; shelf: Float32Array } | null, b: { ocean: Float32Array; shelf: Float32Array } | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return sameArray(a.ocean, b.ocean) && sameArray(a.shelf, b.shelf);
}

function sameArray(a: Float32Array | Uint8Array | Int32Array, b: Float32Array | Uint8Array | Int32Array): boolean {
  if (a.length !== b.length) return false;
  // 按位比（NaN、−0 都按位算）：四字节一组
  if (a instanceof Float32Array) {
    const x = new Uint32Array(a.buffer, a.byteOffset, a.length);
    const y = new Uint32Array(b.buffer, b.byteOffset, b.length);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// 海底剖面的参数（km、m）
const SHELF_KM = 85;
const SHELF_MIN_KM = 4;
const SHELF_MAX_KM = 360;
const BREAK_M = 130;
const RISE_KM = 800;
const SMOOTH_PASSES = 3;

// 海格的高程写进 elevation（陆格不动）。
// 一格的结果只取决于离它不远的地方：离岸距离只走到 limit（再远就是洋底的目标深度），宽度、活动程度再平滑三圈。
// 所以改了一小片海陆时，只重算离改动 limit 加几格以内的格（其余照用上一次的结果），与整个重算逐位相同：
// 离岸距离按 Dijkstra（边长都为正时解唯一），最近的岸边格在距离相同时取编号小的（与弹出的先后无关）
export function seafloor(world: World, elevation: Float32Array) {
  const { mesh, causes, kmPerUnit } = world;
  const n = mesh.n;
  const land = causes.land;
  const { off, adj } = mesh;
  const seed = world.settings.seed;
  const fields = seabedFields(world);

  // 与上一次（或上上次）的输入逐字节相同：直接用那一次的结果。抬升变了的时候先看海岸上的抬升变没变。
  // 生成器的场按内容比：重新打开的世界另有一份（内容相同），比上了就换成这一份，下次直接按对象比
  const entries = seafloorStats.on
    ? (seafloorMemo.get(mesh) ?? []).filter((e) => {
        if (e.seed !== seed || e.kmPerUnit !== kmPerUnit) return false;
        if (e.fields === fields) return true;
        if (!sameFields(e.fields, fields)) return false;
        e.fields = fields;
        return true;
      })
    : [];
  const same = entries.filter((e) => sameArray(e.land, land) && sameArray(e.landness, causes.landness) && sameArray(e.landDelta, causes.landDelta));
  const reuse = (e: SeafloorMemoEntry) => {
    seafloorStats.reused++;
    // 照用的那一次放到最前：下一次改动多半从它改起（撤销后再画），只重算改动附近时以它为准
    const list = seafloorMemo.get(mesh)!;
    if (list[0] !== e) seafloorMemo.set(mesh, [e, ...list.filter((x) => x !== e)]);
    for (let i = 0; i < n; i++) if (!land[i]) elevation[i] = e.z[i];
  };
  const hit = same.find((e) => sameArray(e.uplift, causes.uplift));
  if (hit) return reuse(hit);
  // 只有陆上的抬升变了（海陆、陆块都不变）：岸边海格的属性只取决于挨着海的陆格的抬升，
  // 那些陆格的抬升（按位）都没变就照用（与下面按 up、size 比的结果相同，只是不必扫整个海岸、数陆块）
  if (same.length) {
    const ub = new Uint32Array(causes.uplift.buffer, causes.uplift.byteOffset, n);
    for (const e of same) {
      const eb = new Uint32Array(e.uplift.buffer, e.uplift.byteOffset, n);
      let ok = true;
      for (let i = 0; i < n && ok; i++) {
        if (ub[i] === eb[i] || !land[i]) continue;
        for (let q = off[i], end = off[i + 1]; q < end; q++) {
          if (!land[adj[q]]) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        e.uplift = causes.uplift.slice();
        return reuse(e);
      }
    }
  }

  // 岸边的海格（挨着陆地）与它们的属性：挨着的陆地的抬升（高山海岸 = 活动边缘）、陆块的大小。
  // 有上一次（同样的生成器场）的结果时只重算改动附近（见 coastAttrs），结果与整个重算逐位相同
  const base = entries[0];
  const { up, size, lsize, flips } = coastAttrs(world, base);
  const hit2 = same.find((e) => sameArray(e.up, up) && sameArray(e.size, size));
  if (hit2) {
    // 只是陆上的抬升变了：结果照旧，记下这次的抬升
    hit2.uplift = causes.uplift.slice();
    return reuse(hit2);
  }

  const cellKm = mesh.spacing * kmPerUnit;
  const md = mesh.dist;
  // 离岸再远（大陆架最宽 + 陆坡 + 陆隆），剖面已经到了洋底的目标深度：只走到这么远
  const riseKm = Math.max(RISE_KM, 2.5 * cellKm);
  const limit = (SHELF_MAX_KM + Math.max(110, 1.2 * cellKm) + riseKm + cellKm) / kmPerUnit;

  // 每个海格离洋壳多远（只走海格，按格数；陆壳上的海一直宽到洋壳为止，最多 SHELF_MAX_KM）：
  // 宽的大陆架就是淹在水下的陆壳，陆架坡折在陆壳的边上
  const toOcean = oceanSteps(world, fields, Math.ceil(SHELF_MAX_KM / cellKm), base, flips);

  // 只重算改动附近：从上一次（同样的生成器场）的结果改起。改动 = 陆海变了的格、landness 变了的海格、
  // 属性（抬升、陆块大小、离洋壳）变了的海格；要重算的是离它们 limit 加十格以内的格（平滑三圈也够，只会多算，不会少算）
  let region: Uint8Array | null = null;
  let rlist: Int32Array | null = null;
  if (base) {
    const seeds: number[] = [];
    const landness = causes.landness;
    const landDelta = causes.landDelta;
    const bLand = base.land;
    const bLandness = base.landness;
    const bLandDelta = base.landDelta;
    const bUp = base.up;
    const bSize = base.size;
    const bTo = base.toOcean;
    for (let i = 0; i < n; i++) {
      if (land[i] !== bLand[i]) seeds.push(i);
      else if (!land[i]) {
        if (landness[i] !== bLandness[i] || landDelta[i] !== bLandDelta[i] || up[i] !== bUp[i] || size[i] !== bSize[i] || toOcean[i] !== bTo[i]) seeds.push(i);
      }
    }
    if (seeds.length * 16 < n) {
      const reach = graphDistance(mesh, seeds, limit + 10 * mesh.spacing);
      region = new Uint8Array(n);
      let count = 0;
      for (let i = 0; i < n; i++) {
        if (reach[i] < Infinity) {
          region[i] = 1;
          count++;
        }
      }
      // 改动太大（要重算的格超过一半）：整个重算更快
      if (count * 2 > n) region = null;
      else {
        rlist = new Int32Array(count);
        for (let i = 0, k = 0; i < n; i++) if (region[i]) rlist[k++] = i;
      }
    }
  }
  // 要重算的格（按编号从小到大）：只重算改动附近时是重算区里的格，否则是所有格
  const todo = rlist ? rlist.length : n;
  const at = rlist ? (k: number) => rlist![k] : (k: number) => k;
  // 岸边的海格（挨着陆地）：Dijkstra 的起点
  const sources: number[] = [];
  for (let k = 0; k < todo; k++) {
    const i = at(k);
    if (land[i]) continue;
    for (let e = off[i], end = off[i + 1]; e < end; e++) {
      if (land[adj[e]]) {
        sources.push(i);
        break;
      }
    }
  }
  const prev = region ? base : undefined;

  // 只走海格的图距离与最近的岸边格（Dijkstra，走到 limit 为止；距离相同时取编号小的岸边格）
  const dist = prev ? prev.dist.slice() : new Float64Array(n).fill(Infinity);
  const owner = prev ? prev.owner.slice() : new Int32Array(n).fill(-1);
  {
    const heap = new HeapLite(Math.max(1024, sources.length * 2));
    if (region && rlist) {
      for (let k = 0; k < rlist.length; k++) {
        const i = rlist[k];
        dist[i] = Infinity;
        owner[i] = -1;
      }
      // 重算区外紧挨着它的海格：照用上一次的距离（它们离改动都超过 limit，不会变）；按编号入堆
      const rim: number[] = [];
      const seen = new Uint8Array(n);
      for (let k = 0; k < rlist.length; k++) {
        const r = rlist[k];
        for (let e = off[r], end = off[r + 1]; e < end; e++) {
          const i = adj[e];
          if (region[i] || seen[i] || land[i] || owner[i] < 0) continue;
          seen[i] = 1;
          rim.push(i);
        }
      }
      rim.sort((a, b) => a - b);
      for (const i of rim) heap.push(i, dist[i]);
    }
    for (const s of sources) {
      dist[s] = 0;
      owner[s] = s;
      heap.push(s, 0);
    }
    while (heap.size) {
      const i = heap.pop();
      const di = heap.lastKey;
      if (di > dist[i]) continue;
      const oi = owner[i];
      for (let e = off[i], end = off[i + 1]; e < end; e++) {
        const j = adj[e];
        if (land[j] || (region && !region[j])) continue;
        const nd = di + md[e];
        if (nd > limit) continue;
        if (nd < dist[j]) {
          dist[j] = nd;
          owner[j] = oi;
          heap.push(j, nd);
        } else if (nd === dist[j] && oi < owner[j]) owner[j] = oi;
      }
    }
  }

  const noise = seaNoise(mesh, seed);
  // 每个海格的大陆架宽度 W、活动程度 A：先按最近的岸边格取，再在海上平滑几遍（岸边格换了的地方不留台阶）
  const Ws: Float32Array[] = [];
  const As: Float32Array[] = [];
  const W0 = prev ? prev.W[0].slice() : new Float32Array(n);
  const A0 = prev ? prev.A[0].slice() : new Float32Array(n);
  const cells: number[] = [];
  for (let k = 0; k < todo; k++) {
    const i = at(k);
    const o = owner[i];
    if (o < 0) {
      W0[i] = 0;
      A0[i] = 0;
      continue;
    }
    cells.push(i);
    const act = smoothstep(0.35, 1, up[o]);
    const wBase = SHELF_KM * Math.exp(0.8 * noise.w[i]);
    // 岛架：按陆块大小（洋壳上的小岛只有几 km）；陆架：一直到洋壳（至少有一半的 wBase）
    const wIsland = SHELF_MIN_KM + (wBase - SHELF_MIN_KM) * 0.85 * size[o];
    let wCont = 0;
    if (fields && fields.shelf[o] > 0) {
      const t = toOcean[o];
      const toCrust = t < 0 ? SHELF_MAX_KM : t * cellKm;
      wCont = fields.shelf[o] * Math.min(SHELF_MAX_KM, Math.max(0.5 * wBase, toCrust * (0.85 + 0.15 * noise.w[i])));
    }
    W0[i] = Math.max(SHELF_MIN_KM, Math.max(wIsland, wCont) * (1 - 0.75 * act));
    A0[i] = act;
  }
  Ws.push(W0);
  As.push(A0);
  // 坡折深度只取决于这一格的噪声，本来就是平滑的；宽度与活动程度按岸边格取，要平滑
  for (let pass = 1; pass <= SMOOTH_PASSES; pass++) {
    const Wp = Ws[pass - 1];
    const Ap = As[pass - 1];
    const W2 = prev ? prev.W[pass].slice() : new Float32Array(n);
    const A2 = prev ? prev.A[pass].slice() : new Float32Array(n);
    if (rlist) {
      // 重算区里没走到的格：清零（与整个重算时相同）
      for (let k = 0; k < rlist.length; k++) {
        const i = rlist[k];
        if (owner[i] < 0) {
          W2[i] = 0;
          A2[i] = 0;
        }
      }
    }
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k];
      let sw = 0;
      let sa = 0;
      let m = 0;
      for (let e = off[i], end = off[i + 1]; e < end; e++) {
        const j = adj[e];
        if (owner[j] < 0) continue;
        sw += Wp[j];
        sa += Ap[j];
        m++;
      }
      W2[i] = m ? 0.5 * Wp[i] + (0.5 * sw) / m : Wp[i];
      A2[i] = m ? 0.5 * Ap[i] + (0.5 * sa) / m : Ap[i];
    }
    Ws.push(W2);
    As.push(A2);
  }
  const W = Ws[SMOOTH_PASSES];
  const A = As[SMOOTH_PASSES];

  const z = prev ? prev.z.slice() : new Float32Array(n);
  for (let k = 0; k < todo; k++) {
    const i = at(k);
    if (land[i]) {
      z[i] = 0;
      continue;
    }
    // 洋底的目标深度：陆壳上（淹没的大陆）按地壳本身的高度，画成海的陆地是一个海盆；洋壳上取生成器的洋底
    const shelfW = fields ? smoothstep(0.3, 0.7, fields.shelf[i]) : 0;
    const ocean = fields ? fields.ocean[i] : -4800 + 260 * noise.b[i];
    const crust = causes.landness[i] - causes.landDelta[i];
    // 淹没的陆壳离岸远了（大陆架以外）：陆缘台地，约 −400 到 −1600 m（像西兰洲、罗科尔海台）；
    // 画成海的陆地（原来在海面以上）：约 −1100 m 的海盆
    const tCont = -(400 + 1300 * (1 - Math.exp(Math.min(0, crust) / 600))) - 700 * smoothstep(-150, 150, crust) - 150 * noise.w[i];
    const T = shelfW * tCont + (1 - shelfW) * ocean;
    let h: number;
    if (owner[i] < 0) h = T;
    else {
      const dk = dist[i] * kmPerUnit + 0.5 * cellKm;
      const w = W[i];
      // 陆架坡折的深度（负数）
      const b = -(BREAK_M + 45 * noise.b[i]);
      // 架上的起伏：岸边几乎没有，往外到几十米
      const N = 22 * noise.s[i];
      if (dk <= w) {
        const u = dk / w;
        h = -(2 + (-b - 2) * Math.pow(u, 0.85)) + N * u;
      } else {
        const x = dk - w;
        const S = Math.max((90 - 40 * A[i]) * (0.85 + 0.3 * (0.5 + 0.5 * noise.b[i])), 1.2 * cellKm);
        // 陆坡（S 以内降到六成）+ 陆隆（riseKm 以内慢慢降完）
        const G = 0.6 * smoothstep(0, S, x) + 0.4 * smoothstep(0, riseKm, x);
        h = b + (T - b) * G + N * (1 - G);
      }
    }
    z[i] = Math.max(-11000, Math.min(-1, h));
  }
  for (let i = 0; i < n; i++) if (!land[i]) elevation[i] = z[i];
  if (region) seafloorStats.partial++;
  else seafloorStats.computed++;
  if (seafloorStats.on) {
    const entry: SeafloorMemoEntry = {
      seed,
      kmPerUnit,
      fields,
      lsize,
      land: land.slice(),
      landness: causes.landness.slice(),
      landDelta: causes.landDelta.slice(),
      uplift: causes.uplift.slice(),
      up,
      size,
      toOcean,
      dist,
      owner,
      W: Ws,
      A: As,
      z,
    };
    seafloorMemo.set(mesh, [entry, ...(seafloorMemo.get(mesh) ?? [])].slice(0, 2));
  }
}

// 陆块的大小系数：“边长”（面积的平方根）150 km 以下算小岛，1200 km 以上算大陆
const landSize = (area: number) => smoothstep(150, 1200, Math.sqrt(area));

// 岸边海格的属性：up = 挨着的陆格的抬升（最大，没有为 0）、size = 挨着的陆格所在陆块的大小系数（最大）；
// lsize = 每个陆格所在陆块的大小系数（海格为 0）；flips = 与 base 比陆海变了的格（没有 base 时为 null）。
// 有 base 时只重算改动附近，与整个重算逐位相同：
//   陆块：只有含陆海变了的格、或挨着它的陆块会变（别的陆块与上一次是同一组格，面积也就相同）；
//     重新数时与 landComponents 一样从块里编号最小的格起按同样的顺序加面积，面积逐位相同（块的编号不影响结果）；
//   一个海格的 up、size 只取决于挨着的格的陆海、抬升、陆块大小系数：只重算挨着这些变了的格的海格
function coastAttrs(world: World, base: SeafloorMemoEntry | undefined): { up: Float32Array; size: Float32Array; lsize: Float32Array; flips: number[] | null } {
  const { mesh, causes, kmPerUnit } = world;
  const n = mesh.n;
  const land = causes.land;
  const uplift = causes.uplift;
  const { off, adj } = mesh;
  if (!base) {
    const up = new Float32Array(n);
    const size = new Float32Array(n);
    const lsize = new Float32Array(n);
    const [comp, area] = landComponents(world);
    const compSize = Float32Array.from(area, landSize);
    for (let i = 0; i < n; i++) {
      if (land[i]) {
        lsize[i] = compSize[comp[i]];
        continue;
      }
      for (let e = off[i], end = off[i + 1]; e < end; e++) {
        const j = adj[e];
        if (!land[j]) continue;
        if (uplift[j] > up[i]) up[i] = uplift[j];
        const sz = compSize[comp[j]];
        if (sz > size[i]) size[i] = sz;
      }
    }
    return { up, size, lsize, flips: null };
  }
  // 变了的格：陆海变了的、抬升（按位）变了的陆格，再加陆块大小系数变了的陆格
  const flips: number[] = [];
  const dirty: number[] = [];
  const ub = new Uint32Array(uplift.buffer, uplift.byteOffset, n);
  const eb = new Uint32Array(base.uplift.buffer, base.uplift.byteOffset, n);
  const bl = base.land;
  for (let i = 0; i < n; i++) {
    if (land[i] !== bl[i]) {
      flips.push(i);
      dirty.push(i);
    } else if (land[i] && ub[i] !== eb[i]) dirty.push(i);
  }
  const lsize = base.lsize.slice();
  if (flips.length) {
    const k2 = kmPerUnit * kmPerUnit;
    const done = new Uint8Array(n);
    const again = new Uint8Array(n);
    const queue = new Int32Array(n);
    // 从 s 起按 landComponents 的顺序走一个陆块：格在 queue[0, len) 里，返回 len 与面积
    let a = 0;
    const flood = (s: number, mark: Uint8Array): number => {
      let len = 0;
      a = 0;
      queue[len++] = s;
      mark[s] = 1;
      for (let q = 0; q < len; q++) {
        const c = queue[q];
        a += mesh.area[c] * k2;
        for (let e = off[c], end = off[c + 1]; e < end; e++) {
          const j = adj[e];
          if (land[j] && !mark[j]) {
            mark[j] = 1;
            queue[len++] = j;
          }
        }
      }
      return len;
    };
    const recount = (s: number) => {
      if (!land[s] || done[s]) return;
      let len = flood(s, done);
      let first = s;
      for (let k = 0; k < len; k++) if (queue[k] < first) first = queue[k];
      if (first !== s) len = flood(first, again);
      const v = Math.fround(landSize(a));
      for (let k = 0; k < len; k++) {
        const c = queue[k];
        if (lsize[c] !== v) {
          lsize[c] = v;
          dirty.push(c);
        }
      }
    };
    for (const i of flips) {
      if (!land[i]) lsize[i] = 0;
      recount(i);
      for (let e = off[i], end = off[i + 1]; e < end; e++) recount(adj[e]);
    }
  }
  const up = base.up.slice();
  const size = base.size.slice();
  const mark = new Uint8Array(n);
  const redo = (i: number) => {
    if (mark[i]) return;
    mark[i] = 1;
    up[i] = 0;
    size[i] = 0;
    if (land[i]) return;
    for (let e = off[i], end = off[i + 1]; e < end; e++) {
      const j = adj[e];
      if (!land[j]) continue;
      if (uplift[j] > up[i]) up[i] = uplift[j];
      const sz = lsize[j];
      if (sz > size[i]) size[i] = sz;
    }
  };
  for (const c of dirty) {
    redo(c);
    for (let e = off[c], end = off[c + 1]; e < end; e++) redo(adj[e]);
  }
  return { up, size, lsize, flips };
}

// 每个海格离洋壳多远（只走海格的格数，最多 steps；再远、陆格为 −1）。
// 有 base（同样的生成器场）时只重算离陆海变了的格 steps 格以内的格：再远的格，最短的路（不超过 steps 格）上没有变了的格，
// 与上一次相同。重算区里的格从洋壳格（0）与区外紧挨着的格（上一次的格数 + 1）起按层走，最短格数唯一，与整个重算逐位相同
function oceanSteps(world: World, fields: ReturnType<typeof seabedFields>, steps: number, base: SeafloorMemoEntry | undefined, flips: number[] | null): Int32Array {
  const { mesh, causes } = world;
  const n = mesh.n;
  const land = causes.land;
  const { off, adj } = mesh;
  if (!fields) return new Int32Array(n).fill(-1);
  if (base && flips) {
    if (!flips.length) return base.toOcean.slice();
    const near = new Uint8Array(n);
    const list: number[] = [];
    for (const f of flips) {
      near[f] = 1;
      list.push(f);
    }
    for (let s = 0, head = 0; s < steps && list.length * 2 <= n; s++) {
      const end = list.length;
      for (; head < end; head++) {
        const i = list[head];
        for (let e = off[i], stop = off[i + 1]; e < stop; e++) {
          const j = adj[e];
          if (!near[j]) {
            near[j] = 1;
            list.push(j);
          }
        }
      }
    }
    if (list.length * 2 <= n) {
      const toOcean = base.toOcean.slice();
      const far = steps + 1;
      const buckets: number[][] = [];
      for (let s = 0; s <= steps; s++) buckets.push([]);
      for (const i of list) toOcean[i] = land[i] ? -1 : far;
      for (const i of list) {
        if (land[i]) continue;
        if (fields.shelf[i] < 0.5) {
          toOcean[i] = 0;
          buckets[0].push(i);
          continue;
        }
        let best = far;
        for (let e = off[i], end = off[i + 1]; e < end; e++) {
          const j = adj[e];
          if (near[j] || land[j]) continue;
          const t = toOcean[j];
          if (t >= 0 && t < steps && t + 1 < best) best = t + 1;
        }
        if (best < far) {
          toOcean[i] = best;
          buckets[best].push(i);
        }
      }
      for (let s = 0; s < steps; s++) {
        for (const i of buckets[s]) {
          if (toOcean[i] !== s) continue;
          for (let e = off[i], end = off[i + 1]; e < end; e++) {
            const j = adj[e];
            if (!near[j] || land[j] || toOcean[j] <= s + 1) continue;
            toOcean[j] = s + 1;
            buckets[s + 1].push(j);
          }
        }
      }
      for (const i of list) if (toOcean[i] === far) toOcean[i] = -1;
      return toOcean;
    }
  }
  const toOcean = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let len = 0;
  for (let i = 0; i < n; i++) {
    if (!land[i] && fields.shelf[i] < 0.5) {
      toOcean[i] = 0;
      queue[len++] = i;
    }
  }
  for (let q = 0; q < len; q++) {
    const i = queue[q];
    if (toOcean[i] >= steps) continue;
    for (let e = off[i]; e < off[i + 1]; e++) {
      const j = adj[e];
      if (land[j] || toOcean[j] >= 0) continue;
      toOcean[j] = toOcean[i] + 1;
      queue[len++] = j;
    }
  }
  return toOcean;
}

// 陆地的连通块：每格的块编号（海格 −1）与每块的面积（km²）
function landComponents(world: World): [Int32Array, number[]] {
  const { mesh, causes, kmPerUnit } = world;
  const n = mesh.n;
  const land = causes.land;
  const comp = new Int32Array(n).fill(-1);
  const area: number[] = [];
  const queue = new Int32Array(n);
  const k2 = kmPerUnit * kmPerUnit;
  for (let s = 0; s < n; s++) {
    if (!land[s] || comp[s] >= 0) continue;
    const id = area.length;
    let len = 0;
    let a = 0;
    queue[len++] = s;
    comp[s] = id;
    for (let q = 0; q < len; q++) {
      const c = queue[q];
      a += mesh.area[c] * k2;
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
        const j = mesh.adj[e];
        if (land[j] && comp[j] < 0) {
          comp[j] = id;
          queue[len++] = j;
        }
      }
    }
    area.push(a);
  }
  return [comp, area];
}

// 湖底的形状：每格的深度占最深处的比例（0–1，最深的那格是 1）。t 是到湖心的距离占半径的比例：
//   t > 0.75 是湖岸带的浅滩（最多一成半），0.75 到 0.4 陡陡地落下去，0.4 以内是湖盆；
//   湖盆里一两个更深的地方：位置、大小按种子与放湖的格定
export function lakeBedShape(world: World, center: number, rUnits: number, cells: readonly number[], d: ArrayLike<number>): Float64Array {
  const { mesh } = world;
  const rand = mulberry32(mixSeed(world.settings.seed, center, 0x1a4e));
  const deeps: { x: number; y: number; w: number; h: number }[] = [];
  const count = rand() < 0.45 ? 2 : 1;
  for (let k = 0; k < count; k++) {
    const a = rand() * Math.PI * 2;
    const r = rUnits * (0.05 + 0.3 * rand());
    deeps.push({ x: mesh.x[center] + Math.cos(a) * r, y: mesh.y[center] + Math.sin(a) * r, w: rUnits * (0.25 + 0.2 * rand()), h: k === 0 ? 1 : 0.6 + 0.3 * rand() });
  }
  const out = new Float64Array(cells.length);
  let max = 0;
  for (let k = 0; k < cells.length; k++) {
    const i = cells[k];
    const t = Math.min(1, d[i] / rUnits);
    let deep = 0;
    for (const p of deeps) {
      let dx = mesh.x[i] - p.x;
      if (mesh.kind === 'sphere') dx -= 2 * Math.round(dx / 2);
      const dy = mesh.y[i] - p.y;
      deep = Math.max(deep, p.h * Math.exp(-(dx * dx + dy * dy) / (p.w * p.w)));
    }
    const f = 0.15 * smoothstep(1, 0.75, t) + 0.7 * smoothstep(0.75, 0.4, t) + 0.15 * deep * smoothstep(0.75, 0.3, t);
    out[k] = f;
    max = Math.max(max, f);
  }
  if (max > 0) for (let k = 0; k < out.length; k++) out[k] /= max;
  return out;
}

// 湖的半径（地图单位）：至少半格，半径不到一格时只淹放湖的那一格
function lakeRadiusUnits(world: World, radiusKm: number): number {
  return Math.max(radiusKm / world.kmPerUnit, world.mesh.spacing * 0.5);
}

// 放湖后会被淹的格（预览用）：与挖洼地用同一个范围，所以预览就是结果
export function lakeArea(world: World, cell: number, radiusKm: number): number[] {
  const { mesh, causes } = world;
  if (!causes.land[cell]) return [];
  const rUnits = lakeRadiusUnits(world, radiusKm);
  const d = graphDistance(mesh, [cell], rUnits);
  const out: number[] = [];
  for (let i = 0; i < mesh.n; i++) if (causes.land[i] && d[i] <= rUnits) out.push(i);
  return out;
}

// ---------- 只挖河床（第八轮） ----------

// 一格的水面高度（与路由填洼后的水面逐值相同）：从这格起按高低往外淹，水面是淹过的格里最高的，
// 淹到出口（挨海、贴图边、在终点消失的格）为止。不在洼地里时就是这格的高度。
// 只淹附近：先淹低的格，过了溢出口就顺着往下走到出口
export function waterLevel(mesh: Mesh, land: Uint8Array, elevation: ArrayLike<number>, cell: number, terminal?: Uint8Array): number {
  const seen = new Uint8Array(mesh.n);
  const heap = new MinHeap(256);
  heap.push(cell, elevation[cell]);
  seen[cell] = 1;
  let level = -Infinity;
  // 一直淹不到出口（整个星球全是陆地时）：路由把最低的格当作汇点，水面是淹到它时的高度
  let low = cell;
  let lowLevel = elevation[cell];
  while (heap.size) {
    const c = heap.pop();
    level = Math.max(level, elevation[c]);
    if (elevation[c] < elevation[low]) {
      low = c;
      lowLevel = level;
    }
    let out = mesh.boundary[c] === 1 || terminal?.[c] === 1;
    for (let e = mesh.off[c]; e < mesh.off[c + 1] && !out; e++) if (!land[mesh.adj[e]]) out = true;
    if (out) return level;
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
      const j = mesh.adj[e];
      if (seen[j] || !land[j]) continue;
      seen[j] = 1;
      heap.push(j, elevation[j]);
    }
  }
  return lowLevel;
}

// 一条只挖河床的河挖完之后各格的高度（与 cells 对齐，不挖的格是原来的高度）：
// 从源头往下取累计最小值，但不低于终点的水面（往上游每格再高 1 cm），终点那格不动——
//   h_k = min(E_k, max(min(E_0..E_k), W_终点 + 0.01·(终点 − k)))
// 往高处画的河因此被压平到比终点略高，而不是挖到沿途最低处：水不会在终点前倒流、绕成圈；
// 流进湖的河不会挖到湖面以下，湖不会顺着河道倒流出去。
// 终点是第一格不是陆地的格（入海、流出画的范围），全是陆地时是最后一格；它的水面见 waterLevel（海是它自己的高度）。
// skip：不挖的格（用户放的湖的碗）：碗前的那段按湖面算（碗是那段的终点），出了碗累计最小值从头算起。
// terminal：在终点消失的格（路由里的出口）
export function bedLevels(
  mesh: Mesh,
  land: Uint8Array,
  elevation: ArrayLike<number>,
  cells: readonly number[],
  skip?: Uint8Array,
  terminal?: Uint8Array,
): Float64Array {
  const out = Float64Array.from(cells, (c) => elevation[c]);
  let last = cells.length - 1;
  for (let k = 0; k < cells.length; k++) {
    if (!land[cells[k]]) {
      last = k;
      break;
    }
  }
  let run = Infinity;
  // 这一段流到哪一格（下一个湖的碗或终点）、那里的水面
  let to = -1;
  let level = 0;
  for (let k = 0; k < last; k++) {
    if (skip?.[cells[k]]) {
      run = Infinity;
      continue;
    }
    if (to < k) {
      to = k;
      while (to < last && !skip?.[cells[to]]) to++;
      const c = cells[to];
      level = land[c] ? waterLevel(mesh, land, elevation, c, terminal) : out[to];
    }
    const e = out[k];
    run = Math.min(run, e);
    out[k] = Math.min(e, Math.max(run, level + 0.01 * (to - k)));
  }
  return out;
}

// 用户放的湖淹到的格（湖的碗）
export function userLakeMask(world: World): Uint8Array {
  const mask = new Uint8Array(world.mesh.n);
  for (const l of world.small.lakes) for (const c of lakeArea(world, l.cell, l.radius)) mask[c] = 1;
  return mask;
}

// 在终点消失的河的终点（路由里当作出口）；没有这种河时为 null
export function sinkMask(world: World): Uint8Array | null {
  const land = world.causes.land;
  let mask: Uint8Array | null = null;
  for (const g of world.small.guides) {
    const end = g.cells[g.cells.length - 1];
    if (g.end !== 'sink' || !land[end]) continue;
    mask ??= new Uint8Array(world.mesh.n);
    mask[end] = 1;
  }
  return mask;
}

// 在自然求解的地形上挖出所有画的河的河床（按画的先后，后画的看到的是先画的挖过的）。只往低里挖：
// 河道以外的格一格不动，所以气候、山名照旧按没挖过的地形算（见 Engine.update）
export function carveBeds(world: World, elevation: Float32Array) {
  const beds = world.small.guides;
  if (!beds.length) return;
  const land = world.causes.land;
  const skip = world.small.lakes.length ? userLakeMask(world) : undefined;
  const terminal = sinkMask(world) ?? undefined;
  for (const g of beds) {
    const h = bedLevels(world.mesh, land, elevation, g.cells, skip, terminal);
    g.cells.forEach((c, k) => {
      if (h[k] < elevation[c]) elevation[c] = h[k];
    });
  }
}
