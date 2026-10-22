import { MinHeap } from './heap';
import { type Mesh, graphDistance } from './mesh';
import { LAYOUT_R } from './planet-gen';
import { fbm, fbm3, gradientNoise, gradientNoise3, mixSeed } from './rng';
import { Router, accumulate } from './routing';
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

export function computeElevation(world: World): ElevationResult {
  const { mesh, causes, small, kmPerUnit } = world;
  const n = mesh.n;
  const land = causes.land;
  const sphere = mesh.kind === 'sphere' ? mesh : null;
  const { fu, fk, fs } = noiseFactors(mesh, world.settings.seed);

  // 海岸距离：从挨海的陆格出发只走陆格（陆上的距离与海上互不影响，海上的用不到）
  const coastCells: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue;
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
  const forced = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    // 基础抬升让平原也有起伏；噪声打破对称，使河网各不相同
    u[i] = (0.035 + causes.uplift[i]) * fu[i];
    K[i] = causes.erod[i] * fk[i];
    areaKm[i] = mesh.area[i] * kmPerUnit * kmPerUnit;
  }
  for (const g of small.guides) {
    // 只挖河床的河不改地形的求解：求解之后再挖（carveBeds），周围的山不动
    if (g.carve === 'bed') continue;
    for (let k = 0; k < g.cells.length - 1; k++) {
      const a = g.cells[k];
      const b = g.cells[k + 1];
      if (land[a]) forced[a] = b;
      // 引导河道的岩性更软，下切更深
      K[a] *= 3;
    }
  }

  // 初始高程：按离海距离给一个缓坡加噪声（固定初值，结果只取决于原因）
  const h = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue;
    h[i] = coastKm[i] * 0.002 * (0.3 + u[i]) + 0.05 * (1 + fs[i]);
  }

  // 固定轮数：每个流域的计算只取决于它自己，在一处编辑不会因为“全局收敛轮数”变化而改动远处的地形
  // 活动格与强制方向各轮相同：路由的出口、缓冲区只建一次
  const router = new Router(mesh, land, forced);
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
  const scale = small.planet.mountainScale * RAW_TO_M;
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
    const rUnits = lakeRadiusUnits(world, lake.radius, lake.exact);
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

// 湖的半径（地图单位）：旧湖至少一格半，保证小湖也是一片水面；
// 第八轮起的新湖（exact）至少半格：半径不到一格时只淹放湖的那一格
export function lakeRadiusUnits(world: World, radiusKm: number, exact?: boolean): number {
  return Math.max(radiusKm / world.kmPerUnit, world.mesh.spacing * (exact ? 0.5 : 1.5));
}

// 放湖后会被淹的格（预览用）：与挖洼地用同一个范围，所以预览就是结果
export function lakeArea(world: World, cell: number, radiusKm: number, exact?: boolean): number[] {
  const { mesh, causes } = world;
  if (!causes.land[cell]) return [];
  const rUnits = lakeRadiusUnits(world, radiusKm, exact);
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
  for (const l of world.small.lakes) for (const c of lakeArea(world, l.cell, l.radius, l.exact)) mask[c] = 1;
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

// 在自然求解的地形上挖出所有只挖河床的河（按画的先后，后画的看到的是先画的挖过的）。只往低里挖：
// 河道以外的格一格不动，所以气候、山名照旧按没挖过的地形算（见 Engine.update）
export function carveBeds(world: World, elevation: Float32Array) {
  const beds = world.small.guides.filter((g) => g.carve === 'bed');
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
