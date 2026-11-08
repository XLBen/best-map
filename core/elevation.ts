// 高程：计算的入口、记下来的上一次、收尾（第八十三轮拆开：求解 elevation-solve.ts，海底 seafloor.ts / seafloor-coast.ts，湖与河床 elevation-lakes.ts；这里照旧全部导出）
import { type Mesh, graphDistance } from './mesh';
import { LAYOUT_R } from './planet-gen';
import { fbm, fbm3, gradientNoise, gradientNoise3, mixSeed } from './rng';
import { reliefFields } from './terrain';
import { FREE_HEIGHT, type World } from './world';
import { RAW_TO_M, bitsOf, solveLand } from './elevation-solve';
import { lagoonFloor } from './seafloor-coast';
import { seafloor } from './seafloor';
import { carvePocketLakes, lakeBedShape, lakeRadiusUnits } from './elevation-lakes';
export { UPLIFT_FLOOR, windwardFactor, SOLVE, plainsOn, carvePits } from './elevation-solve';
export { lagoonFloor, oceanSteps } from './seafloor-coast';
export { seafloorStats, seafloor, seafloorSameLand } from './seafloor';
export { carvePocketLakes, lakeBedShape, lakeArea, placedLakeAnchor, placedLakeCell, waterLevel, bedLevels, userLakeMask, sinkMask, carveBeds } from './elevation-lakes';

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
  // 新建时的纬度（迎风的一侧按它定）
  wind: string;
  land: Uint8Array;
  uplift: Uint32Array;
  erod: Uint32Array;
  // 基准面、洼地（第三十二轮，按位）
  T: Uint32Array;
  pit: Uint32Array;
  h: Float64Array;
  coastKm: Float64Array;
}
const elevMemo = new WeakMap<Mesh, ElevationMemoEntry[]>();
// 测试用：on = false 时不读也不写缓存；reused、computed：逐块比过后复用、重算的陆块数（快路上没动过的陆块不逐块比，不计进 reused）；
// fast = false 时不走快路（每块陆地逐块比，第三十一轮以前的做法；结果相同）
export const elevationMemo = { on: true, fast: true, reused: 0, computed: 0 };
// 计时（tools/bench.ts 用，累加的毫秒）：认陆块与比对记忆、求解、收尾（换成米、海底、湖）
export const elevationLaps = { scan: 0, solve: 0, finish: 0 };

// 求解的输入（按位）：海陆、抬升、岩性、基准面、洼地
interface SolveInputs {
  land: Uint8Array;
  uplift: Uint32Array;
  erod: Uint32Array;
  T: Uint32Array;
  pit: Uint32Array;
}

// 迎风的键：地区按新建时的纬度范围，整个星球固定
const windKey = (world: World) => (world.settings.globe ? 'globe' : `${world.settings.latNorth},${world.settings.latSouth}`);

// 基准面、洼地（米）：没有生成器时全是 0
function reliefInputs(world: World): { T: Float32Array; pit: Float32Array } {
  const rel = reliefFields(world);
  if (rel) return rel;
  const zero = new Float32Array(world.mesh.n);
  return { T: zero, pit: zero };
}

// 陆块 cells（land 的一个连通块）在 e 里是同一块、抬升、岩性、基准面、洼地逐位相同
function sameComponent(mesh: Mesh, x: SolveInputs, cells: Int32Array, e: ElevationMemoEntry): boolean {
  const { off, adj } = mesh;
  const { land, uplift, erod, T, pit } = x;
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k];
    if (e.land[c] !== 1 || e.uplift[c] !== uplift[c] || e.erod[c] !== erod[c] || e.T[c] !== T[c] || e.pit[c] !== pit[c]) return false;
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
  const t0 = performance.now();
  const { fu, fk, fs } = noiseFactors(mesh, seed);
  const rel = reliefInputs(world);
  const x: SolveInputs = { land, uplift: bitsOf(causes.uplift), erod: bitsOf(causes.erod), T: bitsOf(rel.T), pit: bitsOf(rel.pit) };
  const wind = windKey(world);

  // 要算的陆格（todo = 1）；能复用的陆块直接写进 h、coastKm
  const h = new Float64Array(n);
  const coastKm = new Float64Array(n).fill(1e5);
  const todo = new Uint8Array(n);
  const entries = elevationMemo.on ? (elevMemo.get(mesh) ?? []).filter((e) => e.seed === seed && e.kmPerUnit === kmPerUnit && e.wind === wind) : [];
  let todoCount = 0;
  if (entries.length && elevationMemo.fast) todoCount = fromMemo(world, x, entries, h, coastKm, todo);
  else {
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
      const hit = entries.find((e) => sameComponent(mesh, x, cells, e));
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
  const t1 = performance.now();
  // 缓存关掉时照旧总是走一遍（没有陆地也路由 12 轮），与原来的每一步相同
  if (todoCount > 0 || !elevationMemo.on) solveLand(world, todo, fu, fk, fs, rel.T, rel.pit, h, coastKm);
  if (elevationMemo.on) {
    const entry: ElevationMemoEntry = { seed, kmPerUnit, wind, land: land.slice(), uplift: x.uplift.slice(), erod: x.erod.slice(), T: x.T.slice(), pit: x.pit.slice(), h: h.slice(), coastKm: coastKm.slice() };
    elevMemo.set(mesh, [entry, ...(elevMemo.get(mesh) ?? [])].slice(0, 2));
  }
  const t2 = performance.now();
  const out = finishElevation(world, h, coastKm);
  const t3 = performance.now();
  elevationLaps.scan += t1 - t0;
  elevationLaps.solve += t2 - t1;
  elevationLaps.finish += t3 - t2;
  return out;
}

// 空闲预热（第三十一轮，Worker 打开世界后空闲时，见 engine.ts 的 warmSteps）：按现在的海陆、抬升、岩性分段求解，
// 放进记忆（与 computeElevation 从头算时放进去的逐值相同：一块陆地的结果只取决于它自己，分几段算与一次算完相同）。
// 之后的第一笔只重算改到的陆块。记忆里已经有这一份时什么都不做。cells：每段至少多少个陆格（按整块陆地分段）。
// 开始时把海陆、抬升、岩性复制一份，各段都按这一份算（预热中途世界变了也不会拼出不一致的一份）
export function* warmElevationSteps(world: World, cells = 0): Generator<void> {
  if (!elevationMemo.on) return;
  const { mesh, causes, kmPerUnit } = world;
  const n = mesh.n;
  const seed = world.settings.seed;
  const land = causes.land.slice();
  const upBits = bitsOf(causes.uplift).slice();
  const erBits = bitsOf(causes.erod).slice();
  const rel = reliefInputs(world);
  const T = rel.T.slice();
  const pit = rel.pit.slice();
  const tBits = bitsOf(T);
  const pBits = bitsOf(pit);
  const wind = windKey(world);
  const list = elevMemo.get(mesh) ?? [];
  if (list.some((e) => e.seed === seed && e.kmPerUnit === kmPerUnit && e.wind === wind && sameValues(e.land, land) && sameValues(e.uplift, upBits) && sameValues(e.erod, erBits) && sameValues(e.T, tBits) && sameValues(e.pit, pBits))) return;
  const frozen: World = { ...world, causes: { ...causes, land, uplift: new Float32Array(upBits.buffer), erod: new Float32Array(erBits.buffer) } };
  const { fu, fk, fs } = noiseFactors(mesh, seed);
  yield;
  let landCells = 0;
  for (let i = 0; i < n; i++) landCells += land[i];
  const chunk = Math.max(cells, 2000, Math.ceil(landCells / 4));
  const h = new Float64Array(n);
  const coastKm = new Float64Array(n).fill(1e5);
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let todo = new Uint8Array(n);
  let count = 0;
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
    for (let k = 0; k < len; k++) todo[queue[k]] = 1;
    count += len;
    if (count >= chunk) {
      solveLand(frozen, todo, fu, fk, fs, T, pit, h, coastKm);
      todo = new Uint8Array(n);
      count = 0;
      yield;
    }
  }
  if (count > 0) solveLand(frozen, todo, fu, fk, fs, T, pit, h, coastKm);
  const entry: ElevationMemoEntry = { seed, kmPerUnit, wind, land, uplift: upBits, erod: erBits, T: tBits, pit: pBits, h, coastKm };
  elevMemo.set(mesh, [entry, ...(elevMemo.get(mesh) ?? [])].slice(0, 2));
  yield;
  // 海底（收尾里最慢的一段）也有按内容的记忆：按现在的世界算一遍，写进一个用完就丢的数组
  seafloor(world, new Float32Array(n));
  yield;
}

// 整数数组逐个相同（抬升、岩性比的是 Float32 的位）
function sameValues(a: Uint8Array | Uint32Array, b: Uint8Array | Uint32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// 记忆的快路（第三十一轮）：先整份照用最近的一份（entries[0]），再只看与它不同的格（海陆不同，或陆格的抬升、岩性按位不同）
// 碰到的陆块：一块陆地与 entries[0] 逐块比（sameComponent）不相同，当且仅当它的格或挨着它的海格里有这样的格。
// 所以没碰到的陆块就是逐块比时会用 entries[0] 的那些（值相同），只有碰到的陆块再与别的几份逐块比、比不上的重算。
// 现在是海、那一份里是陆地的格退回海的初值（h 0、离海 1e5）。不用把整个地图的陆块都找一遍、逐格比一遍。
// 返回要重算的陆格数（todo 里标好）
function fromMemo(world: World, x: SolveInputs, entries: ElevationMemoEntry[], h: Float64Array, coastKm: Float64Array, todo: Uint8Array): number {
  const { mesh } = world;
  const n = mesh.n;
  const { land, uplift: upBits, erod: erBits, T, pit } = x;
  const { off, adj } = mesh;
  const e0 = entries[0];
  h.set(e0.h);
  coastKm.set(e0.coastKm);
  // 要找的陆块的起点：与 e0 不同的陆格，与 e0 不同的海格挨着的陆格
  const seeds: number[] = [];
  const l0 = e0.land;
  const u0 = e0.uplift;
  const r0 = e0.erod;
  const T0 = e0.T;
  const p0 = e0.pit;
  for (let i = 0; i < n; i++) {
    if (land[i]) {
      if (l0[i] !== 1 || u0[i] !== upBits[i] || r0[i] !== erBits[i] || T0[i] !== T[i] || p0[i] !== pit[i]) seeds.push(i);
    } else if (l0[i]) {
      h[i] = 0;
      coastKm[i] = 1e5;
      for (let e = off[i]; e < off[i + 1]; e++) if (land[adj[e]]) seeds.push(adj[e]);
    }
  }
  if (!seeds.length) return 0;
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  const rest = entries.slice(1);
  let todoCount = 0;
  for (const s of seeds) {
    if (seen[s]) continue;
    let len = 0;
    queue[len++] = s;
    seen[s] = 1;
    for (let q = 0; q < len; q++) {
      const c = queue[q];
      for (let e = off[c]; e < off[c + 1]; e++) {
        const j = adj[e];
        if (land[j] && !seen[j]) {
          seen[j] = 1;
          queue[len++] = j;
        }
      }
    }
    const cells = queue.subarray(0, len);
    const hit = rest.find((e) => sameComponent(mesh, x, cells, e));
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
  return todoCount;
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
  lagoonFloor(world, elevation);
  carvePocketLakes(world, elevation);

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
  // 湖里的岛定下的高度（第十五轮，见 terrain.ts 的 lakeIslandStamp）：陆地格上直接换成它（高出湖面的格是干的陆地，
  // 湖照旧按溢出口蓄水：岛不碰湖岸、不碰溢出口，别的格的高程一格不变）。
  // 放在挖湖之后：放的湖里的岛不会被湖底挖掉。没有往湖里放过岛时没有这个数组，什么都不做
  const fixed = causes.islandHeight;
  if (fixed) for (let i = 0; i < n; i++) if (land[i] && fixed[i] !== FREE_HEIGHT) elevation[i] = fixed[i];
  return { elevation, coastKm };
}
