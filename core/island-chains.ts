// 湖里的岛、成串的岛、几次放岛合在一起（第八十三轮从 core/terrain.ts 原样搬出）
import { type IslandType, islandTypeById, SHARDS_ISLAND_TYPE } from './island-types';
import { type IslandGeometry, islandRadiusOf, type IslandSpec, type LakeView, type StampResult, typeOfSpec, centerCell, EMPTY_STAMP, fragStamp, lakeOf, islandGeometry, type LakeSource, onMap, islandStamp, islandKindSchema, islandSizeSchema, ISLAND_MIN_CELLS, footprintOf } from './islands';
import { clamp, fbm, mulberry32, mixSeed } from './rng';
import type { World } from './world';
import { z } from 'zod';
import { type V3, toUnit, arc, wrapX, slerp, fromUnit } from './geo';
import { coastSeed } from './terrain-coast';

// 一格高出湖面多少（m）：r 离岛心（0 岛心，1 岛的边上），按这种岛的高低；g 按岛的大小（100 km 为 1）
function lakeIsleHeight(t: IslandType, dd: number, geo: IslandGeometry | null, k: number, sizeKm: number): number {
  if (t.shape === 'cell') return 2;
  if (t.shape === 'ring') return 1 + 3 * Math.max(0, 1 - Math.abs(dd - 0.8) / 0.16);
  const u = Math.max(0, 1 - islandRadiusOf(t, dd));
  const g = clamp(Math.sqrt(sizeKm / 100), 0.5, 1.6);
  if (t.height === 'flat') return 2 + 10 * u;
  if (t.height === 'high') return 5 + 900 * g * Math.pow(u, 1.4);
  const n = geo && k >= 0 ? fbm(geo.shape, geo.dx[k] / geo.R + 1, geo.dy[k] / geo.R, 3, 3) : 0;
  return 3 + 250 * g * Math.pow(u, 1.2) * Math.max(0.2, 0.6 + 0.4 * n);
}

// 剩下的湖面连成一片：被岛隔开的每一块从离得最近的地方（穿过最少的岛格）打开一个口子，口子上的格不抬。
// 主块是最大的一块（一样大取最小格编号小的）；按块的最小格编号依次打开。0-1 广度优先：走岛格算一步，走湖面不算
function keepLakeOpen(world: World, lake: number[], raised: Set<number>): void {
  const { mesh } = world;
  const inLake = new Set(lake);
  for (;;) {
    const part = new Map<number, number>();
    const parts: number[][] = [];
    for (const s of lake) {
      if (raised.has(s) || part.has(s)) continue;
      const id = parts.length;
      const cells = [s];
      part.set(s, id);
      for (let h = 0; h < cells.length; h++) {
        const c = cells[h];
        for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
          const j = mesh.adj[e];
          if (inLake.has(j) && !raised.has(j) && !part.has(j)) {
            part.set(j, id);
            cells.push(j);
          }
        }
      }
      parts.push(cells);
    }
    if (parts.length <= 1) return;
    let main = 0;
    for (let p = 1; p < parts.length; p++) if (parts[p].length > parts[main].length) main = p;
    const from = main === 0 ? 1 : 0;
    // 从这一块出发，找到主块里的格为止。按代价一层一层走：走湖面不加代价（排进这一层），走岛格加一（排进下一层）
    const dist = new Map<number, number>();
    const prev = new Map<number, number>();
    let layer = [...parts[from]].sort((a, b) => a - b);
    for (const c of layer) dist.set(c, 0);
    let next: number[] = [];
    let cost = 0;
    let hit = -1;
    for (let q = 0; hit < 0; q++) {
      if (q >= layer.length) {
        if (!next.length) break;
        layer = next;
        next = [];
        q = -1;
        cost++;
        continue;
      }
      const c = layer[q];
      if (dist.get(c)! < cost) continue;
      if (part.get(c) === main) {
        hit = c;
        break;
      }
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
        const j = mesh.adj[e];
        if (!inLake.has(j)) continue;
        const w = raised.has(j) ? 1 : 0;
        if (dist.has(j) && dist.get(j)! <= cost + w) continue;
        dist.set(j, cost + w);
        prev.set(j, c);
        (w ? next : layer).push(j);
      }
    }
    if (hit < 0) return;
    for (let c: number | undefined = hit; c !== undefined; c = prev.get(c)) raised.delete(c);
  }
}

// 放在湖面上的一个岛（岛心那一格是湖面：view.lake[c0] === 1）。放不下（湖太窄，岛心附近没有不挨岸的湖面格）时 cells 为空
export function lakeIslandStamp(world: World, spec: IslandSpec, view: LakeView): StampResult {
  const { t, code } = typeOfSpec(world, spec.kind);
  const { mesh } = world;
  const c0 = centerCell(mesh, spec.x, spec.y);
  if (view.lake[c0] !== 1 || !world.causes.land[c0]) return EMPTY_STAMP;
  if (t.shape === 'frag') return fragStamp(world, spec, view);
  const lake = lakeOf(world, c0, view);
  const inLake = new Set(lake);
  // 不挨湖岸、地图边的湖面格才能抬（岛四周留一圈湖面）
  const inner = (i: number) => {
    if (!inLake.has(i) || mesh.boundary[i]) return false;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (!inLake.has(mesh.adj[e])) return false;
    return true;
  };
  let level = -Infinity;
  for (const i of lake) level = Math.max(level, view.water[i]);
  const height = new Map<number, number>();
  const geo = t.shape === 'cell' ? null : islandGeometry(world, spec, t);
  if (geo) {
    for (let k = 0; k < geo.cells.length; k++) {
      const i = geo.cells[k];
      const dd = geo.dd[k];
      const up = t.shape === 'ring' ? Math.abs(dd - 0.8) < 0.16 : islandRadiusOf(t, dd) < 1;
      if (up && inner(i)) height.set(i, lakeIsleHeight(t, dd, geo, k, spec.size));
    }
  }
  // 一格的岛，或者太小、一格都没抬起来：只抬岛心那一格
  if (!height.size && inner(c0)) {
    const k = geo ? geo.cells.indexOf(c0) : -1;
    height.set(c0, lakeIsleHeight(t, t.shape === 'ring' ? 0.8 : 0, geo, k, spec.size));
  }
  if (!height.size) return EMPTY_STAMP;
  const raised = new Set(height.keys());
  keepLakeOpen(world, lake, raised);
  const cells = [...raised].sort((a, b) => a - b);
  return {
    cells,
    landDelta: cells.map(() => 0),
    upliftDelta: cells.map(() => 0),
    erodDelta: cells.map(() => 0),
    types: cells.map(() => code),
    footprint: cells.slice(),
    heights: cells.map((i) => Math.fround(level + Math.max(1, height.get(i)!))),
  };
}

// 放一个岛（命令、预览共用）：岛心在海里按海里的岛（islandStamp，与以前逐值相同）；在湖面上按湖里的岛；
// 在干的陆地上也按 islandStamp（与以前相同：只在挨着海时长出新的陆地）。lake：岛心在湖面上时为 true
export function placeIsland(world: World, spec: IslandSpec, lakes: LakeSource): { stamp: StampResult; lake: boolean } {
  const c0 = centerCell(world.mesh, spec.x, spec.y);
  if (!world.causes.land[c0] || !onMap(world, spec)) return { stamp: islandStamp(world, spec), lake: false };
  const view = lakes();
  if (!view || view.lake[c0] !== 1) return { stamp: islandStamp(world, spec), lake: false };
  return { stamp: lakeIslandStamp(world, spec, view), lake: true };
}

export const chainSchema = z.object({
  // 折线顶点（地图单位）
  points: z.array(z.tuple([z.number(), z.number()])).min(2),
  kind: islandKindSchema,
  size: islandSizeSchema,
  // 0.5 稀疏，1 正常，2 密集
  density: z.number().min(0.2).max(3).default(1),
  variant: z.number().int().min(0).default(0),
  // 碎岛的比例（第十八轮，0–1）：按链上的编号把这么多的岛换成碎岛（见 chainKind），不用随机；种类本身是碎岛时全是碎岛
  fragRatio: z.number().min(0).max(1).optional(),
});
export type ChainSpec = z.output<typeof chainSchema>;

// 链上第 k 个岛是不是碎岛：比例 r 的岛均匀地换（r = 0.5 时每隔一个，r = 1 全换）
export const chainFragAt = (k: number, r: number) => r > 0 && Math.floor((k + 1) * r + 1e-9) > Math.floor(k * r + 1e-9);

// 链上第 k 个岛的种类：种类本身是碎岛（形状“碎”）时总是它；否则按比例换成内置的碎岛
function chainKind(world: World, spec: ChainSpec, k: number): string {
  const r = spec.fragRatio ?? 0;
  if (!r || islandTypeById(world.small, spec.kind)?.shape === 'frag' || !islandTypeById(world.small, SHARDS_ISLAND_TYPE)) return spec.kind;
  return chainFragAt(k, r) ? SHARDS_ISLAND_TYPE : spec.kind;
}

// 岛链里小一号的岛最小多大（km）：与放岛的最小值相同，一格（太小时岛心那一格成陆）
function chainMinKm(world: World): number {
  return world.mesh.spacing * world.kmPerUnit * ISLAND_MIN_CELLS;
}

// 岛链的排列（第十二轮）：沿线的位置（0–1）、大小、向两侧的错落（以岛的半径计）。
// 第 0 种是原来的均匀排开（不变）；之后几种轮着换：错落着排（间距忽大忽小，偶尔空一个）、几个成团（团里挨得近、有的连在一起）、
// 由大到小（像夏威夷那样一头大一头小，间距跟着岛变）、疏密不定（间距随机，个数也多一两个）。每画一条岛链换下一种，一眼看得出不一样
export const CHAIN_STYLES = ['even', 'jitter', 'clusters', 'taper', 'random'] as const;
export type ChainStyle = (typeof CHAIN_STYLES)[number];
export function chainStyle(variant: number): ChainStyle {
  return variant <= 0 ? 'even' : CHAIN_STYLES[1 + ((variant - 1) % 4)];
}

// 错落 = u × 岛的半径 × spread（分开存，第 0 种的算式与原来逐位相同）
interface ChainSlot {
  t: number;
  size: number;
  u: number;
  spread: number;
}

// 大小按幂律：大约 15% 大一号，45% 小一号
const chainSize = (u: number, baseKm: number, minKm: number) => (u < 0.15 ? baseKm * 2 : u < 0.6 ? baseKm : Math.max(minKm, baseKm / 2));

function chainLayout(rand: () => number, count0: number, baseKm: number, minKm: number, variant: number): ChainSlot[] {
  const style = chainStyle(variant);
  const out: ChainSlot[] = [];
  if (style === 'even') {
    // 原来的排法（rand 的用法一点不变：先取所有大小，再逐个取错落）
    const sizes: number[] = [];
    for (let k = 0; k < count0; k++) sizes.push(chainSize(rand(), baseKm, minKm));
    for (let k = 0; k < count0; k++) out.push({ t: (k + 0.5) / count0, size: sizes[k], u: rand() - 0.5, spread: 1.4 });
    return out;
  }
  if (style === 'jitter') {
    const count = Math.max(1, count0 + Math.round((rand() - 0.5) * 2.2));
    for (let k = 0; k < count; k++) {
      const t = (k + 0.5 + (rand() - 0.5) * 0.75) / count;
      const size = chainSize(rand(), baseKm, minKm);
      const u = rand() - 0.5;
      // 偶尔空一个（至少留两个）
      if (count > 2 && rand() < 0.15) continue;
      out.push({ t, size, u, spread: 1.8 });
    }
  } else if (style === 'clusters') {
    const count = Math.max(1, count0 + Math.round(rand() * 2));
    const groups = Math.max(1, Math.min(count, 2 + Math.floor(rand() * 3)));
    // 团的中心：大致均匀、带一点错落
    const centers: number[] = [];
    for (let g = 0; g < groups; g++) centers.push((g + 0.5 + (rand() - 0.5) * 0.5) / groups);
    // 团里挨得很近（约原来间距的 0.45 倍，大一点的岛会连在一起）
    const step = 0.45 / count0;
    for (let k = 0; k < count; k++) {
      const g = k % groups;
      const within = Math.floor(k / groups);
      const inGroup = Math.ceil((count - g) / groups);
      const t = centers[g] + (within - (inGroup - 1) / 2) * step + (rand() - 0.5) * step * 0.5;
      out.push({ t: Math.min(0.98, Math.max(0.02, t)), size: chainSize(rand(), baseKm, minKm), u: rand() - 0.5, spread: 2.2 });
    }
  } else if (style === 'taper') {
    // 一头大一头小：大小从 2 倍降到最小，间距跟着岛的大小
    const count = Math.max(1, count0 + Math.round((rand() - 0.5) * 2));
    const flip = rand() < 0.5;
    const sizes: number[] = [];
    for (let k = 0; k < count; k++) {
      const f = count === 1 ? 0 : k / (count - 1);
      sizes.push(Math.max(minKm, baseKm * 2 * Math.pow(0.25, f) * (0.85 + rand() * 0.3)));
    }
    let acc = 0;
    const at: number[] = [];
    for (let k = 0; k < count; k++) {
      acc += k === 0 ? sizes[0] * 0.5 : (sizes[k - 1] + sizes[k]) * 0.5;
      at.push(acc);
    }
    const total = acc + sizes[count - 1] * 0.5;
    for (let k = 0; k < count; k++) {
      const t = at[k] / total;
      out.push({ t: flip ? 1 - t : t, size: sizes[k], u: rand() - 0.5, spread: 1.2 });
    }
  } else {
    // 疏密不定：间距按随机（指数分布）抽，个数多一两个
    const count = Math.max(1, count0 + 1 + Math.floor(rand() * 2));
    const gaps: number[] = [];
    let sum = 0;
    for (let k = 0; k <= count; k++) {
      const g = -Math.log(1 - rand() * 0.95) + 0.15;
      gaps.push(g);
      sum += g;
    }
    let acc = 0;
    for (let k = 0; k < count; k++) {
      acc += gaps[k];
      out.push({ t: acc / sum, size: chainSize(rand(), baseKm, minKm), u: rand() - 0.5, spread: 1.6 });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

// 排列换了陆地的总量大致不变（第十二轮修）：第 1 种起按第 0 种（同一条线、同样的个数）的岛的面积之和（大小的平方和）
// 等比例缩放各个岛，所以几种排列的陆地一样多（最小的岛不再缩）；第 0 种不变
function chainSlots(seedOf: (variant: number) => number, count: number, baseKm: number, minKm: number, variant: number, extra: number): ChainSlot[] {
  const slots = chainLayout(mulberry32(seedOf(variant)), count, baseKm, minKm, variant);
  if (variant <= 0 || !slots.length) return slots;
  const ref = chainLayout(mulberry32(seedOf(0)), count, baseKm, minKm, 0);
  const area = (list: ChainSlot[]) => list.reduce((a, s) => a + s.size * s.size, 0);
  const scale = Math.sqrt(area(ref) / area(slots)) * extra;
  return slots.map((s) => ({ ...s, size: Math.max(minKm, s.size * scale) }));
}

// 岛链不并进原有的陆地（第十二轮修）：岛心离原来的陆地太近时把岛缩小到碰不到它（岛的轮廓按最长约 1.6 倍大小、再空一格），
// 缩到比最小的岛还小、或岛心就在陆地上时不放这个岛。岛心在湖面上（第十五轮，给了 lakes 时）：照样放，大小不变
const CHAIN_REACH = 1.6;
function avoidLand(world: World, islands: IslandSpec[], minKm: number, lakes?: LakeSource): IslandSpec[] {
  const { mesh, causes, kmPerUnit } = world;
  const cellKm = mesh.spacing * kmPerUnit;
  const out: IslandSpec[] = [];
  for (const spec of islands) {
    if (lakes) {
      const c = centerCell(mesh, spec.x, spec.y);
      if (causes.land[c]) {
        if (onMap(world, spec) && lakes()?.lake[c] === 1) out.push(spec);
        continue;
      }
    }
    const maxKm = spec.size * CHAIN_REACH + cellKm;
    const d = nearestLandKm(world, spec.x, spec.y, maxKm);
    if (d >= maxKm) {
      out.push(spec);
      continue;
    }
    const size = (d - cellKm) / CHAIN_REACH;
    if (size < minKm || causes.land[centerCell(mesh, spec.x, spec.y)]) continue;
    out.push({ ...spec, size });
  }
  return out;
}

// 离 (x, y) 最近的陆格有多远（km，按格心）；maxKm 以内没有陆地时返回 maxKm。从那一格往外只走 maxKm 以内的格
function nearestLandKm(world: World, x: number, y: number, maxKm: number): number {
  const { mesh, causes, kmPerUnit } = world;
  const sphere = mesh.kind === 'sphere' ? mesh : null;
  const center: V3 | null = sphere ? toUnit(x, y) : null;
  const distKm = (i: number) => {
    if (sphere && center) {
      const dot = sphere.p[3 * i] * center[0] + sphere.p[3 * i + 1] * center[1] + sphere.p[3 * i + 2] * center[2];
      return (Math.acos(Math.max(-1, Math.min(1, dot))) / Math.PI) * kmPerUnit;
    }
    return Math.hypot(mesh.x[i] - x, mesh.y[i] - y) * kmPerUnit;
  };
  const c0 = centerCell(mesh, x, y);
  let best = maxKm;
  const seen = new Set<number>([c0]);
  const queue = [c0];
  for (let h = 0; h < queue.length; h++) {
    const c = queue[h];
    const dc = distKm(c);
    if (causes.land[c] && dc < best) best = dc;
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
      const j = mesh.adj[e];
      if (seen.has(j)) continue;
      seen.add(j);
      if (distKm(j) <= maxKm + mesh.spacing * kmPerUnit) queue.push(j);
    }
  }
  return best;
}

// 岛链：沿折线放一串岛，大小按幂律（少数大岛、许多小岛），左右略有错落；排列按 variant 换（见 chainLayout）。
// lakes（第十五轮）：岛心落在湖面上的岛照样放（大小不变，按湖里的岛放，见 lakeIslandStamp）；不给时、或岛心在干的陆地上时不放。
// 只在有岛心落在陆格上时才取湖面（整条链都在海上时与以前逐值相同）
export function chainIslands(world: World, spec: ChainSpec, lakes?: LakeSource): IslandSpec[] {
  const minKm = chainMinKm(world);
  const raw = (s: ChainSpec, scale: number) => avoidLand(world, (world.mesh.kind === 'sphere' ? chainIslandsSphere : chainIslandsFlat)(world, s, scale), minKm, lakes);
  const islands = raw(spec, 1);
  if (spec.variant <= 0) return islands;
  // 按面积之和缩放之后，小岛成陆的格数不与面积成比例、有的岛不放（离原有的陆地太近）：再按实际新长出的陆格数与第 0 种比一次，
  // 差得多（±15% 以外）时整条链再缩放一次（只数海里的岛：湖里的岛不长出新的陆格）
  const gained = (all: IslandSpec[]) => {
    const list = all.filter((s) => !world.causes.land[centerCell(world.mesh, s.x, s.y)]);
    if (!list.length) return 0;
    let c = 0;
    for (const i of combineStamps(world, list).footprint) if (!world.causes.land[i]) c++;
    return c;
  };
  const g0 = gained(raw({ ...spec, variant: 0 }, 1));
  const gv = gained(islands);
  if (!g0 || !gv || Math.abs(gv / g0 - 1) < 0.15) return islands;
  return raw(spec, Math.min(2, Math.max(0.5, Math.sqrt(g0 / gv))));
}

function chainIslandsFlat(world: World, spec: ChainSpec, scale: number): IslandSpec[] {
  const pts = spec.points;
  let total = 0;
  const seg: number[] = [];
  for (let k = 0; k + 1 < pts.length; k++) {
    const l = Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
    seg.push(l);
    total += l;
  }
  const baseKm = spec.size;
  const baseR = baseKm / world.kmPerUnit;
  const spacing = (baseR * 2.6) / spec.density;
  const count = Math.max(1, Math.round(total / spacing));
  const seedOf = (v: number) => mixSeed(coastSeed(world), 555, Math.round(pts[0][0] * 1e4), Math.round(pts[0][1] * 1e4), v);
  const minKm = chainMinKm(world);
  const slots = chainSlots(seedOf, count, baseKm, minKm, spec.variant, scale);
  const out: IslandSpec[] = [];
  for (let k = 0; k < slots.length; k++) {
    let s = slots[k].t * total;
    let j = 0;
    while (j < seg.length - 1 && s > seg[j]) {
      s -= seg[j];
      j++;
    }
    const [x0, y0] = pts[j];
    const [x1, y1] = pts[j + 1];
    const t = seg[j] > 0 ? s / seg[j] : 0;
    const nx = -(y1 - y0) / (seg[j] || 1);
    const ny = (x1 - x0) / (seg[j] || 1);
    const off = slots[k].u * baseR * slots[k].spread;
    // 岛的形状与位置无关，岛链里每个岛要用不同的 variant（也避开单独放岛用的那些）
    const variant = 1_000_000 + spec.variant * 1000 + k;
    out.push({ x: x0 + (x1 - x0) * t + nx * off, y: y0 + (y1 - y0) * t + ny * off, kind: chainKind(world, spec, k), size: slots[k].size, variant });
  }
  return out;
}

// 整个星球上的岛链：折线各段是大圆弧，沿弧插值，向两侧的错落沿弧的法向
function chainIslandsSphere(world: World, spec: ChainSpec, scale: number): IslandSpec[] {
  const pts = spec.points.map(([x, y]) => toUnit(x, y));
  let total = 0;
  const seg: number[] = [];
  for (let k = 0; k + 1 < pts.length; k++) {
    const l = arc(pts[k], pts[k + 1]) / Math.PI;
    seg.push(l);
    total += l;
  }
  const baseKm = spec.size;
  const baseR = baseKm / world.kmPerUnit;
  const spacing = (baseR * 2.6) / spec.density;
  const count = Math.max(1, Math.round(total / spacing));
  const x0 = wrapX(spec.points[0][0]);
  const seedOf = (v: number) => mixSeed(coastSeed(world), 555, Math.round(x0 * 1e4), Math.round(spec.points[0][1] * 1e4), v);
  const minKm = chainMinKm(world);
  const slots = chainSlots(seedOf, count, baseKm, minKm, spec.variant, scale);
  const out: IslandSpec[] = [];
  for (let k = 0; k < slots.length; k++) {
    let s = slots[k].t * total;
    let j = 0;
    while (j < seg.length - 1 && s > seg[j]) {
      s -= seg[j];
      j++;
    }
    const a = pts[j];
    const b = pts[j + 1];
    const t = seg[j] > 0 ? s / seg[j] : 0;
    const at = slerp(a, b, t);
    // 法向：大圆的轴 a × b（在弧上处处与弧垂直）
    let nx = a[1] * b[2] - a[2] * b[1];
    let ny = a[2] * b[0] - a[0] * b[2];
    let nz = a[0] * b[1] - a[1] * b[0];
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= nl;
    ny /= nl;
    nz /= nl;
    const off = slots[k].u * baseR * slots[k].spread * Math.PI;
    const q: V3 = [at[0] + nx * off, at[1] + ny * off, at[2] + nz * off];
    const ql = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2]);
    const [x, y] = fromUnit([q[0] / ql, q[1] / ql, q[2] / ql]);
    out.push({ x, y, kind: chainKind(world, spec, k), size: slots[k].size, variant: 1_000_000 + spec.variant * 1000 + k });
  }
  return out;
}


// 多个岛依次叠加（后一个看见前一个的结果，海岸值与岩性都是），返回合并后的增量。
// lakes（第十五轮）：岛心在陆格上的岛按湖里的岛放（岛心在湖面上，见 lakeIslandStamp；后一个看见前一个占掉的湖面），
// 岛心在干的陆地上、湖太窄的不放（记进 skipped）。不给时每个岛都按海里的岛放（与以前逐值相同）。
// 只在有岛心落在陆格上时才取湖面。定下的高度后放的岛说了算
export function combineStamps(world: World, specs: IslandSpec[], lakes?: LakeSource): StampResult {
  const { causes, mesh } = world;
  const saved = new Map<number, [number, number, number]>();
  const acc = new Map<number, { land: number; lift: number; erod: number; type: number; h: number }>();
  // 碎岛的破碎度：后放的与先放的取大的
  const fragAcc = new Map<number, number>();
  let fixed = false;
  let skipped = 0;
  // 这条命令里的湖面（湖里放了岛的格不再是湖面），第一次用到时才复制
  let view: LakeView | null | undefined;
  try {
    for (const spec of specs) {
      let r: StampResult;
      const c = lakes ? centerCell(mesh, spec.x, spec.y) : -1;
      if (lakes && causes.land[c]) {
        if (view === undefined) {
          const v = lakes();
          view = v && { lake: Uint8Array.from(v.lake), water: v.water };
        }
        r = view && view.lake[c] === 1 && onMap(world, spec) ? lakeIslandStamp(world, spec, view) : EMPTY_STAMP;
        if (!r.cells.length && !r.frag?.cells.length) {
          skipped++;
          continue;
        }
        for (const i of r.cells) (view!.lake as Uint8Array)[i] = 0;
      } else r = islandStamp(world, spec);
      if (r.frag) r.frag.cells.forEach((i, k) => fragAcc.set(i, Math.max(fragAcc.get(i) ?? 0, r.frag!.value[k])));
      r.cells.forEach((i, k) => {
        if (!saved.has(i)) saved.set(i, [causes.landness[i], causes.erod[i], causes.islandType[i]]);
        causes.landness[i] += r.landDelta[k];
        causes.erod[i] += r.erodDelta[k];
        if (r.types[k]) causes.islandType[i] = r.types[k];
        const a = acc.get(i) ?? { land: 0, lift: 0, erod: 0, type: 0, h: NaN };
        a.land += r.landDelta[k];
        a.lift += r.upliftDelta[k];
        a.erod += r.erodDelta[k];
        if (r.types[k]) a.type = r.types[k];
        const h = r.heights?.[k];
        if (h !== undefined && !Number.isNaN(h)) {
          a.h = h;
          fixed = true;
        }
        acc.set(i, a);
      });
    }
  } finally {
    for (const [i, [l, e, t]] of saved) {
      causes.landness[i] = l;
      causes.erod[i] = e;
      causes.islandType[i] = t;
    }
  }
  const out: StampResult = { cells: [], landDelta: [], upliftDelta: [], erodDelta: [], types: [], footprint: [] };
  if (fixed) out.heights = [];
  for (const [i, a] of acc) {
    out.cells.push(i);
    out.landDelta.push(a.land);
    out.upliftDelta.push(a.lift);
    out.erodDelta.push(a.erod);
    out.types.push(a.type);
    out.heights?.push(a.h);
  }
  out.footprint = footprintOf(world, out);
  if (skipped) out.skipped = skipped;
  if (fragAcc.size) {
    const list = [...fragAcc].sort((a, b) => a[0] - b[0]);
    out.frag = { cells: list.map((e) => e[0]), value: list.map((e) => e[1]) };
  }
  return out;
}
