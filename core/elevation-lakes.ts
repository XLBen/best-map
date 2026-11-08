// 湖与河床（第八十三轮从 core/elevation.ts 原样搬出）：小洼地的湖、湖床的形状、画的湖、只挖河床
import type { World } from './world';
import { pocketLakes } from './terrain';
import { mulberry32, mixSeed, smoothstep } from './rng';
import { graphDistance, type Mesh } from './mesh';
import { MinHeap } from './heap';

// 小块海挖成的湖有多深（m）：水文认湖要 3 m 以上
const POCKET_DEPTH = 5;

// 并回陆地的小块海（三格以上，见 terrain.ts 的 fillSeaPockets）挖成湖：比四周最低的岸低 POCKET_DEPTH，
// 水文按溢出口蓄水，河流进湖、从出口接着流向大海
export function carvePocketLakes(world: World, elevation: Float32Array) {
  const { mesh, causes } = world;
  const land = causes.land;
  for (const cells of pocketLakes(world)) {
    const inside = new Set(cells);
    let rim = Infinity;
    for (const i of cells) {
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (!inside.has(j)) rim = Math.min(rim, land[j] ? elevation[j] : 0);
      }
    }
    if (!Number.isFinite(rim)) continue;
    for (const i of cells) elevation[i] = Math.min(elevation[i], rim - 1 - POCKET_DEPTH);
  }
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
export function lakeRadiusUnits(world: World, radiusKm: number): number {
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

// 放的湖在水文里认哪一格（第十五轮）：放湖的那一格；那一格不再是水面时（湖心放了岛、抬高了），
// 取湖的碗里（与挖洼地同一个范围）离它最近的水面格（一样近取编号小的）；碗里一格水面都没有时还是放湖的那一格。
// 这样湖心有岛的湖照旧是“放的湖”（常年蓄满、不算太小的湖）
export function placedLakeAnchor(world: World, lake: { cell: number; radius: number }, isWater: (i: number) => boolean): number {
  if (isWater(lake.cell)) return lake.cell;
  const { mesh, causes } = world;
  const rUnits = lakeRadiusUnits(world, lake.radius);
  const d = graphDistance(mesh, [lake.cell], rUnits);
  let best = -1;
  for (let i = 0; i < mesh.n; i++) if (causes.land[i] && d[i] <= rUnits && isWater(i) && (best < 0 || d[i] < d[best])) best = i;
  return best < 0 ? lake.cell : best;
}

// 推导算好之后，放的湖认哪一格（湖类型、选中湖时用）：同上，按推导里的湖（湖面、干涸的湖底都算）
export function placedLakeCell(world: World, lake: { cell: number; radius: number }, dLake: ArrayLike<number>): number {
  return lake.cell < world.mesh.n ? placedLakeAnchor(world, lake, (i) => dLake[i] !== 0) : lake.cell;
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
