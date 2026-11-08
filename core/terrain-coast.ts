// 海岸线的噪声与陆海的判定（第八十三轮从 core/terrain.ts 原样搬出）：海岸噪声场、潟湖、填掉小海湾、小洼地的湖
import type { Mesh } from './mesh';
import type { World } from './world';
import { gradientNoise, mixSeed, fbm, gradientNoise3, fbm3 } from './rng';
import { LAYOUT_R } from './planet-gen';
import { LAGOON_BIT } from './island-types';

// 海岸噪声的幅度（m）；乘以“海岸风格”的破碎度
export const COAST_AMP = 180;
const coastCache = new WeakMap<Mesh, Map<number, Float32Array>>();

export function coastSeed(world: World): number {
  return world.small.terrain.gen?.seed ?? world.settings.seed;
}

function coastNoiseAt(seed: number): (x: number, y: number) => number {
  const noise = gradientNoise(mixSeed(seed, 909));
  return (x, y) => fbm(noise, x, y, 45, 4, 0.6);
}

// 整个星球：同样的频率，在球面的布局坐标上取三维噪声（没有接缝）
function coastNoiseAt3(seed: number): (x: number, y: number, z: number) => number {
  const noise = gradientNoise3(mixSeed(seed, 909));
  return (x, y, z) => fbm3(noise, x, y, z, 45, 4, 0.6);
}

export function coastNoiseField(mesh: Mesh, seed: number): Float32Array {
  let bySeed = coastCache.get(mesh);
  if (!bySeed) coastCache.set(mesh, (bySeed = new Map()));
  let f = bySeed.get(seed);
  if (!f) {
    f = new Float32Array(mesh.n);
    if (mesh.kind === 'sphere') {
      const at = coastNoiseAt3(seed);
      for (let i = 0; i < mesh.n; i++) f[i] = at(mesh.p[3 * i] * LAYOUT_R, mesh.p[3 * i + 1] * LAYOUT_R, mesh.p[3 * i + 2] * LAYOUT_R);
    } else {
      const at = coastNoiseAt(seed);
      for (let i = 0; i < mesh.n; i++) f[i] = at(mesh.x[i], mesh.y[i]);
    }
    bySeed.set(seed, f);
  }
  return f;
}

export function isLandValue(landness: number, coast: number, rough: number): boolean {
  return landness + COAST_AMP * rough * coast > 0;
}

// 陆地里围住的小块“海”并回陆地（第十三轮：以前只填单格的洞）。一块海（海格的连通块）不挨地图边、
// 不超过 POCKET_MAX 格时不是真正的海：两三格的“内海”会把流进来的大河整条吞掉（河在海里就到头了）。
// 这样的小块并回陆地；三格以上的在高程里挖成湖（elevation.ts 的 pocketLakes），河流进湖、从湖的出口接着流向大海；
// 两格以下的就是平地，河照常流过。环礁的潟湖（记着环礁形状的岛的种类的海格，见 island-types.ts）不算（单格的洞照旧填）。
// 整个星球没有地图边：只看大小。陆地越多海块越小，所以陆地比例调大时旧陆地一定被完整包含（与原来的单格洞相同）
export const POCKET_MAX = 6;
// 潟湖：放环礁时记上 LAGOON_BIT 的海格（第十四轮：以前按可蚀性 ≥ 4.6 认，涂了很软的岩石的海也会当成潟湖）
export function lagoonTest(world: Pick<World, 'causes'>, typeAfter?: ReadonlyMap<number, number>): (i: number) => boolean {
  const t = world.causes.islandType;
  return typeAfter ? (i) => ((typeAfter.get(i) ?? t[i]) & LAGOON_BIT) !== 0 : (i) => (t[i] & LAGOON_BIT) !== 0;
}
// 从 start（一格海）起找它所在的海块：是要并回陆地的小块时返回块里的格（按找到的先后），否则 null。
// 最多走 POCKET_MAX + 1 格就有结论，所以每格都调一次也不慢；结果只取决于海块本身，与从哪一格起找无关
export function seaPocket(mesh: Mesh, isSea: (i: number) => boolean, isLagoon: (i: number) => boolean, start: number): number[] | null {
  if (mesh.boundary[start]) return null;
  const cells = [start];
  let lagoon = isLagoon(start);
  for (let h = 0; h < cells.length; h++) {
    const c = cells[h];
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
      const j = mesh.adj[e];
      if (!isSea(j) || cells.includes(j)) continue;
      if (mesh.boundary[j] || cells.length >= POCKET_MAX) return null;
      cells.push(j);
      if (isLagoon(j)) lagoon = true;
    }
  }
  return cells.length > 1 && lagoon ? null : cells;
}

// 第三十二轮（提速）：先把每块海整块走一遍（类型化数组），挨地图边或超过 POCKET_MAX 格的整块跳过——以前对大洋里的每一格
// 都从它起找一遍（每次最多 7 格，但大洋有几万格）。seaPocket 的结果只取决于海块本身，所以只在每块的第一格（编号最小）上找一次，
// 与以前逐格找、找到的块标上不再找逐值相同（并回陆地的格一样）。导出给测试（features-memo）
export function fillSeaPockets(mesh: Mesh, land: Uint8Array, isLagoon: (i: number) => boolean) {
  const n = mesh.n;
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  const fill: number[] = [];
  const isSea = (i: number) => !land[i];
  for (let i = 0; i < n; i++) {
    if (land[i] || seen[i]) continue;
    if (!smallSea(mesh, land, seen, queue, i)) continue;
    const p = seaPocket(mesh, isSea, isLagoon, i);
    if (p) for (const c of p) fill.push(c);
  }
  for (const i of fill) land[i] = 1;
}

// 从 start 起把这块海整块走一遍（标进 seen）：不挨地图边、不超过 POCKET_MAX 格时为 true
function smallSea(mesh: Mesh, land: Uint8Array, seen: Uint8Array, queue: Int32Array, start: number): boolean {
  const { off, adj, boundary } = mesh;
  let len = 0;
  queue[len++] = start;
  seen[start] = 1;
  let edge = boundary[start] === 1;
  for (let h = 0; h < len; h++) {
    const c = queue[h];
    for (let e = off[c]; e < off[c + 1]; e++) {
      const j = adj[e];
      if (land[j] || seen[j]) continue;
      seen[j] = 1;
      queue[len++] = j;
      if (boundary[j] === 1) edge = true;
    }
  }
  return !edge && len <= POCKET_MAX;
}

// 并回陆地的小块海（三格以上的）：高程按它们挖成湖（elevation.ts 的 finishElevation）。
// 按格算：是陆格、按 landness 与海岸噪声本来是海的格就是填进来的（单格的洞、两格的小块不挖，见 POCKET_MAX）
export const POCKET_LAKE_MIN = 3;
// 并回陆地的海格：是陆格、按 landness 与海岸噪声本来是海（写成模块里的函数，不是每次新建的闭包；第三十二轮提速）
function filledSea(land: Uint8Array, landness: Float32Array, coast: Float32Array, rough: number, i: number): boolean {
  return land[i] === 1 && !isLandValue(landness[i], coast[i], rough);
}

export function pocketLakes(world: World): number[][] {
  const { mesh, causes } = world;
  const coast = coastNoiseField(mesh, coastSeed(world));
  const rough = world.small.terrain.coastRoughness;
  const seen = new Uint8Array(mesh.n);
  const out: number[][] = [];
  for (let s = 0; s < mesh.n; s++) {
    if (seen[s] || !filledSea(causes.land, causes.landness, coast, rough, s)) continue;
    const cells = [s];
    seen[s] = 1;
    for (let h = 0; h < cells.length; h++) {
      const c = cells[h];
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
        const j = mesh.adj[e];
        if (!seen[j] && filledSea(causes.land, causes.landness, coast, rough, j)) {
          seen[j] = 1;
          cells.push(j);
        }
      }
    }
    if (cells.length >= POCKET_LAKE_MIN) out.push(cells.sort((a, b) => a - b));
  }
  return out;
}
