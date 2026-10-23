import { MinHeap } from './heap';
import { HeapLite, type Mesh, graphDistance } from './mesh';
import { LAYOUT_R } from './planet-gen';
import { fbm, fbm3, gradientNoise, gradientNoise3, mixSeed, smoothstep } from './rng';
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

  // 湖：挖一个碗形洼地，由水文按溢出口蓄水。
  // 以紧贴湖面的一圈格里最低的为基准往下挖：它就是溢出口，湖面 = 它的高度，
  // 所以湖面正好是 lakeArea 给出的那些格（预览就是结果），边上也至少有 1 m 深
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
    for (let i = 0; i < n; i++) {
      if (!inside(i)) continue;
      const t = d[i] / rUnits;
      const bowl = rim - 1 - lake.depth * (1 - t * t);
      elevation[i] = Math.max(1, Math.min(elevation[i], bowl));
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
  fields: object | null;
  land: Uint8Array;
  landness: Float32Array;
  landDelta: Float32Array;
  uplift: Float32Array;
  // 每个岸边海格挨着的陆地的抬升（最大）与陆块大小系数；不是岸边的格为 0
  up: Float32Array;
  size: Float32Array;
  z: Float32Array;
}
const seafloorMemo = new WeakMap<Mesh, SeafloorMemoEntry[]>();
// 测试用：on = false 时不读也不写缓存；reused、computed：复用、重算的次数
export const seafloorStats = { on: true, reused: 0, computed: 0 };

function sameArray(a: Float32Array | Uint8Array, b: Float32Array | Uint8Array): boolean {
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

// 海格的高程写进 elevation（陆格不动）
export function seafloor(world: World, elevation: Float32Array) {
  const { mesh, causes, kmPerUnit } = world;
  const n = mesh.n;
  const land = causes.land;
  const { off, adj } = mesh;
  const seed = world.settings.seed;
  const fields = seabedFields(world);

  // 与上一次（或上上次）的输入逐字节相同：直接用那一次的结果。抬升变了的时候先看海岸上的抬升变没变
  const entries = seafloorStats.on ? (seafloorMemo.get(mesh) ?? []).filter((e) => e.seed === seed && e.kmPerUnit === kmPerUnit && e.fields === fields) : [];
  const same = entries.filter((e) => sameArray(e.land, land) && sameArray(e.landness, causes.landness) && sameArray(e.landDelta, causes.landDelta));
  const reuse = (e: SeafloorMemoEntry) => {
    seafloorStats.reused++;
    for (let i = 0; i < n; i++) if (!land[i]) elevation[i] = e.z[i];
  };
  const hit = same.find((e) => sameArray(e.uplift, causes.uplift));
  if (hit) return reuse(hit);

  // 岸边的海格（挨着陆地）与它们的属性：挨着的陆地的抬升（高山海岸 = 活动边缘）、陆块的大小
  const up = new Float32Array(n);
  const size = new Float32Array(n);
  const sources: number[] = [];
  let comp: Int32Array | null = null;
  let compArea: number[] = [];
  for (let i = 0; i < n; i++) {
    if (land[i]) continue;
    let coastal = false;
    for (let e = off[i]; e < off[i + 1]; e++) {
      const j = adj[e];
      if (!land[j]) continue;
      if (!comp) [comp, compArea] = landComponents(world);
      coastal = true;
      if (causes.uplift[j] > up[i]) up[i] = causes.uplift[j];
      // 陆块的“边长”（面积的平方根）150 km 以下算小岛，1200 km 以上算大陆
      const sz = smoothstep(150, 1200, Math.sqrt(compArea[comp[j]]));
      if (sz > size[i]) size[i] = sz;
    }
    if (coastal) sources.push(i);
  }
  const hit2 = same.find((e) => sameArray(e.up, up) && sameArray(e.size, size));
  if (hit2) {
    // 只是陆上的抬升变了：结果照旧，记下这次的抬升
    hit2.uplift = causes.uplift.slice();
    return reuse(hit2);
  }
  seafloorStats.computed++;

  // 只走海格的图距离与最近的岸边格（Dijkstra，走到 limit 为止）
  const cellKm = mesh.spacing * kmPerUnit;
  const md = mesh.dist;
  // 离岸再远（大陆架最宽 + 陆坡 + 陆隆），剖面已经到了洋底的目标深度：只走到这么远
  const riseKm = Math.max(RISE_KM, 2.5 * cellKm);
  const limit = (SHELF_MAX_KM + Math.max(110, 1.2 * cellKm) + riseKm + cellKm) / kmPerUnit;
  const dist = new Float64Array(n).fill(Infinity);
  const owner = new Int32Array(n).fill(-1);
  {
    const heap = new HeapLite(Math.max(1024, sources.length * 2));
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
        if (land[j]) continue;
        const nd = di + md[e];
        if (nd < dist[j] && nd <= limit) {
          dist[j] = nd;
          owner[j] = oi;
          heap.push(j, nd);
        }
      }
    }
  }

  const noise = seaNoise(mesh, seed);
  // 岸边格离洋壳多远（只走海格，按格数；陆壳上的海一直宽到洋壳为止，最多 SHELF_MAX_KM）：
  // 宽的大陆架就是淹在水下的陆壳，陆架坡折在陆壳的边上
  const toOcean = new Int32Array(n).fill(-1);
  if (fields) {
    const queue = new Int32Array(n);
    let len = 0;
    for (let i = 0; i < n; i++) {
      if (!land[i] && fields.shelf[i] < 0.5) {
        toOcean[i] = 0;
        queue[len++] = i;
      }
    }
    const steps = Math.ceil(SHELF_MAX_KM / cellKm);
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
  }
  // 每个海格的大陆架宽度 W、坡折深度 B（负数）、活动程度 A：先按最近的岸边格取，再在海上平滑几遍（岸边格换了的地方不留台阶）
  let W = new Float32Array(n);
  let B = new Float32Array(n);
  let A = new Float32Array(n);
  const reached: number[] = [];
  for (let i = 0; i < n; i++) {
    if (owner[i] < 0) continue;
    reached.push(i);
    const o = owner[i];
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
    W[i] = Math.max(SHELF_MIN_KM, Math.max(wIsland, wCont) * (1 - 0.75 * act));
    B[i] = -(BREAK_M + 45 * noise.b[i]);
    A[i] = act;
  }
  {
    // 坡折深度 B 只取决于这一格的噪声，本来就是平滑的；宽度与活动程度按岸边格取，要平滑
    let W2 = new Float32Array(n);
    let A2 = new Float32Array(n);
    const cells = Int32Array.from(reached);
    for (let pass = 0; pass < 3; pass++) {
      for (let k = 0; k < cells.length; k++) {
        const i = cells[k];
        let sw = 0;
        let sa = 0;
        let m = 0;
        for (let e = off[i], end = off[i + 1]; e < end; e++) {
          const j = adj[e];
          if (owner[j] < 0) continue;
          sw += W[j];
          sa += A[j];
          m++;
        }
        W2[i] = m ? 0.5 * W[i] + (0.5 * sw) / m : W[i];
        A2[i] = m ? 0.5 * A[i] + (0.5 * sa) / m : A[i];
      }
      [W, W2] = [W2, W];
      [A, A2] = [A2, A];
    }
  }

  const z = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (land[i]) continue;
    // 洋底的目标深度：陆壳上（淹没的大陆）按地壳本身的高度，画成海的陆地是一个约 −1100 m 的海盆；洋壳上取生成器的洋底
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
      const b = B[i];
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
    elevation[i] = z[i];
  }
  if (seafloorStats.on) {
    const entry: SeafloorMemoEntry = {
      seed,
      kmPerUnit,
      fields,
      land: land.slice(),
      landness: causes.landness.slice(),
      landDelta: causes.landDelta.slice(),
      uplift: causes.uplift.slice(),
      up,
      size,
      z,
    };
    seafloorMemo.set(mesh, [entry, ...(seafloorMemo.get(mesh) ?? [])].slice(0, 2));
  }
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
