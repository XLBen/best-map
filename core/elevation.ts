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

// 湖的半径（地图单位）：至少一格半，保证小湖也是一片水面
export function lakeRadiusUnits(world: World, radiusKm: number): number {
  return Math.max(radiusKm / world.kmPerUnit, world.mesh.spacing * 1.5);
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
