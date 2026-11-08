// 放岛（第八十三轮从 core/terrain.ts 原样搬出）：岛的种类与大小、形状、印上去、碎岛；湖的查看
import { type IslandType, DEFAULT_ISLAND_TYPE, islandTypeById, islandCode, type IslandShape, LAGOON_BIT } from './island-types';
import type { World } from './world';
import { CommandError } from './errors';
import { z } from 'zod';
import { type Mesh, findCell } from './mesh';
import { nearestCell } from './sphere';
import { coastNoiseField, coastSeed, COAST_AMP, isLandValue } from './terrain-coast';
import { type Noise2, mixSeed, gradientNoise, mulberry32, fbm, smoothstep } from './rng';
import { type V3, toUnit, localOffset } from './geo';
import { landAfter } from './terrain-brush';

// ---------- 放岛 ----------

// 岛的种类在 island-types.ts（第十四轮：内置的大陆岛、低平岛、珊瑚岛、小礁，和用户自己的）。命令里记种类的 id；
// 放岛时按这种岛的形状、高低、岩石长出陆地，并在新长出的陆地（环礁还有潟湖的海格）上记下种类（causes.islandType）。
// 第十四轮去掉了火山岛（以后另做地标）

// 世界里一种岛都没有时放的普通的岛（第三十轮）：同大陆岛的说法，编号 0
const PLAIN_ISLAND: IslandType = { id: DEFAULT_ISLAND_TYPE, name: '岛', shape: 'rugged', height: 'hilly', province: 'land' };

// 这一种岛与它的编号：世界里没有岛的种类时是普通的岛；有、但没有这一种时报错
export function typeOfSpec(world: World, kind: string): { t: IslandType; code: number } {
  const t = islandTypeById(world.small, kind);
  if (!t) {
    if (!world.small.islandTypes?.length) return { t: PLAIN_ISLAND, code: 0 };
    throw new CommandError(kind === 'volcanic' ? '没有火山岛了，换一种岛' : `没有“${kind}”这种岛`);
  }
  return { t, code: islandCode(world.small, kind) };
}

// 命令里的种类要有：没有时报错
export function checkIslandKind(world: World, kind: string): void {
  typeOfSpec(world, kind);
}

// 岛的名字（提示、历史里用）
export function islandTypeName(world: World, kind: string): string {
  return islandTypeById(world.small, kind)?.name ?? kind;
}

export const roundKm = (v: number) => (v >= 100 ? Math.round(v / 10) * 10 : Math.round(v));

// 岛的大小：海岸线的半径（km），连续可调，放出来的岛平均就这么大
export const islandSizeSchema = z.number().min(0.1).max(20000);
// 种类：内置的或自己的岛的 id（执行时查有没有这一种）
export const islandKindSchema = z.string().min(1).max(64).default(DEFAULT_ISLAND_TYPE);

export const islandSchema = z.object({
  x: z.number(),
  y: z.number(),
  kind: islandKindSchema,
  size: islandSizeSchema,
  // 同一选项、同一 variant → 同一个形状；每放一个岛换下一个 variant。
  // 岛的形状与位置无关：鼠标移动时预览的轮廓跟着走、不变形，拖大拖小是同一个岛等比例缩放
  variant: z.number().int().min(0).default(0),
});
export type IslandSpec = z.output<typeof islandSchema>;

// 岛、画笔等大小的参照尺度（km）：一块地区是地图的高；整个星球取半圈经线的一半（与格距相当的地区地图同一个量级）
function refKm(world: World): number {
  return world.mesh.kind === 'sphere' ? world.kmPerUnit / 2 : world.mesh.height * world.kmPerUnit;
}

// 最小的岛（格，海岸线的半径）：与最小的画笔一样是 0.4 格，就是一格陆地（放不出陆地时岛心那一格成陆，见 islandStamp）。
// 第十三轮：几种岛一样（以前 0.75 格、珊瑚岛 1.5 格）；一格大的环礁在这一格里画出环和潟湖（渲染按岛的种类）
export const ISLAND_MIN_CELLS = 0.4;

// 可调的半径范围（km）：最小一格（见 ISLAND_MIN_CELLS），最大是地图高度的 20%。各种岛一样；一格的岛（小礁）不看大小。
// 碎岛（第十八轮）最小到 0.15 格（比一格小得多的一小片）
export function islandSizeRangeKm(world: World, kind?: string): [number, number] {
  const cellKm = world.mesh.spacing * world.kmPerUnit;
  const mapKm = refKm(world);
  const frag = kind !== undefined && islandTypeById(world.small, kind)?.shape === 'frag';
  return [cellKm * (frag ? FRAG_MIN_CELLS : ISLAND_MIN_CELLS), Math.max(cellKm * 3, mapKm * 0.2)];
}
const FRAG_MIN_CELLS = 0.15;

// 画笔、岛的大小写给人看（第十三轮：都写直径）：不到半格的半径只涂一格、只放一格陆地，写“一格 ≈ N km”
export function sizeText(world: World, radiusKm: number): string {
  const cellKm = world.mesh.spacing * world.kmPerUnit;
  return radiusKm < cellKm * 0.5 ? `一格 ≈ ${roundKm(cellKm)} km` : `${roundKm(radiusKm * 2)} km`;
}

// 地图的尺度（km）：宽、格距。整个星球按半圈（πR，约 2 万 km）算，
// 这样类地星球的默认画笔约 700 km、最大约 4,000 km
export function mapScaleKm(world: World): { width: number; cell: number } {
  const width = world.mesh.kind === 'sphere' ? world.kmPerUnit : world.mesh.width * world.kmPerUnit;
  return { width, cell: world.mesh.spacing * world.kmPerUnit };
}

// 画笔半径的范围（km）：随地图尺度。最小的笔刷只涂鼠标下那一格（不到半格时，见 brushCells）
export function brushRangeKm(world: World): [number, number] {
  const { width, cell } = mapScaleKm(world);
  return [cell * 0.4, width * 0.2];
}

// 湖的半径范围（km）：最小半格，就是只淹一格的小湖（见 lakeRadiusUnits）
export function lakeRangeKm(world: World): [number, number] {
  const { width, cell } = mapScaleKm(world);
  return [cell * 0.5, Math.max(cell * 4, width * 0.05)];
}

// 自然融入的过渡范围（km）：最小一格半
export function reachRangeKm(world: World): [number, number] {
  const { width, cell } = mapScaleKm(world);
  return [Math.max(cell * 1.5, width * 0.005), Math.min(5000, width * 0.2)];
}

// 新世界里“放岛”默认的大小：岛心半径约 4.8 格或地图尺度的 2.6%（取大的），换算成海岸线的半径
export function defaultIslandKm(world: World): number {
  const [lo, hi] = islandSizeRangeKm(world);
  const cellKm = world.mesh.spacing * world.kmPerUnit;
  const core = Math.max(cellKm * 2.2, refKm(world) * 0.012) * 2.2;
  return Math.min(hi, Math.max(lo, core * SHORE.round));
}

export interface StampResult {
  cells: number[];
  landDelta: number[];
  upliftDelta: number[];
  // 可蚀性的增量（岛的岩石软硬，见 island-types.ts）
  erodDelta: number[];
  // 记下的岛的种类（编号，0 不改）：新长出的陆地、环礁潟湖的海格
  types: number[];
  // 岛的轮廓（预览用）：放岛后会是陆地的格
  footprint: number[];
  // 湖里的岛定下的高度（m，海拔，与 cells 对齐；NaN 是没定）。只有放在湖面上的岛才有（见 lakeIslandStamp）
  heights?: number[];
  // 岛链里没放成的岛（岛心在干的陆地上、湖太窄），见 combineStamps
  skipped?: number;
  // 碎岛（第十八轮）：这些格的破碎度抬到 value（0–255，只抬不降，与 cells 无关：碎岛不改陆度）
  frag?: { cells: number[]; value: number[] };
}

// 数值大小指海岸线的半径：轮廓平均落在这个距离上。岛心半径 R 与海岸线的比例按形状不同
// （地势在 R 以外再延伸约三分之一才入海；环礁的外缘在 R 以内一点）
const SHORE: Record<IslandShape, number> = { round: 4 / 3, long: 4 / 3, rugged: 4 / 3, ring: 0.96, cell: 1, frag: 1 };
// 形状的种子（第十四轮：每种形状一个固定的数，不按种类在列表里的位置：去掉、加上一种岛，别的岛形状不变）。
// 与以前的序号相同：圆 0（原来的火山岛）、不规则 1（大陆岛）、长条 2（低平岛）、环礁 3（珊瑚岛）
const SHAPE_SEED: Record<IslandShape, number> = { round: 0, rugged: 1, long: 2, ring: 3, cell: 4, frag: 5 };

// 小礁那一格的海岸值约 +95 m（250·tanh(100/250)）。四周深海约 −250 m，海岸线落在每条边离格心约 0.28 处，
// 屏幕和导出都画成约半格宽的小岛（实测约占这一格面积的四分之一）
const REEF_V = 100;
// 海岸曲折调到 0 到 2 时，后两项至少留这么多（m）：改海岸曲折时海平面会挪动十来米
const REEF_KEEP = 30;

// 岛心所在的格：整个星球按球面上最近的格（与 toUnit 同一个换算）
export function centerCell(mesh: Mesh, x: number, y: number): number {
  return mesh.kind === 'sphere' ? nearestCell(mesh, x, y) : findCell(mesh, x, y);
}

// 一格的岛（小礁）：只把岛心那一格抬成陆地，不看大小和形状。陆度取 max(REEF_V − a·k, REEF_KEEP − 2·COAST_AMP·k, REEF_KEEP)：
// 第一项让现在的海岸值是 REEF_V；后两项保证海岸曲折调到 0 到 2 之间它都还在
// 一格的岛那一格要加的陆度（见 reefStamp）
export function reefLandDelta(world: World, c: number): number {
  const k = coastNoiseField(world.mesh, coastSeed(world))[c];
  const a = COAST_AMP * world.small.terrain.coastRoughness;
  const target = Math.max(REEF_V - a * k, REEF_KEEP - 2 * COAST_AMP * k, REEF_KEEP);
  return Math.max(0, target - world.causes.landness[c]);
}

function reefStamp(world: World, spec: IslandSpec, t: IslandType, code: number): StampResult {
  const { mesh, causes } = world;
  const out: StampResult = { cells: [], landDelta: [], upliftDelta: [], erodDelta: [], types: [], footprint: [] };
  const c = centerCell(mesh, spec.x, spec.y);
  if (causes.land[c]) return out;
  out.cells.push(c);
  out.landDelta.push(reefLandDelta(world, c));
  out.upliftDelta.push(0);
  out.erodDelta.push(t.rock === undefined ? 0 : t.rock - causes.erod[c]);
  out.types.push(code);
  out.footprint = footprintOf(world, out);
  return out;
}

// 岛的轮廓的几何（第十五轮从 islandStamp 里拆出来，湖里的岛也用它）：岛心附近每格相对岛心的位置（东、南，地图单位）
// 与“按形状量的距离” dd（岛心半径 R 的倍数，噪声让边缘有湾有岬）。只列 dd 的原始距离 d ≤ 1.9 的格，按编号排
export interface IslandGeometry {
  R: number;
  // 岛心所在的格
  c0: number;
  // 形状的噪声（起伏的丘陵也用它）
  shape: Noise2;
  cells: number[];
  dx: number[];
  dy: number[];
  dd: number[];
}

export function islandGeometry(world: World, spec: IslandSpec, t: IslandType): IslandGeometry {
  const { mesh } = world;
  const R = spec.size / SHORE[t.shape] / world.kmPerUnit;
  // 形状只取决于形状这一项与 variant：噪声按“相对岛心、以半径为单位”的坐标取，所以换位置不变形、改大小是等比例缩放
  const sphere = mesh.kind === 'sphere' ? mesh : null;
  const seed = mixSeed(coastSeed(world), 778, spec.variant, SHAPE_SEED[t.shape]);
  const shape = gradientNoise(seed);
  const rand = mulberry32(seed);
  // 不规则的拉长一点、长条的拉得更长，都旋转；圆的、环礁接近圆形
  // 碎岛（第十八轮）的一片和不规则的岛一样：拉长一点、边上有湾有岬
  const elong = t.shape === 'rugged' || t.shape === 'frag' ? 1 + 0.8 * rand() : t.shape === 'long' ? 1.3 + 0.9 * rand() : 1 + 0.15 * rand();
  const ang = rand() * Math.PI;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const irregular = t.shape === 'rugged' || t.shape === 'frag' ? 0.45 : t.shape === 'long' ? 0.25 : 0.18;
  const reach = R * 1.9;
  // 整个星球：在岛心的切平面里取位置（等距方位投影），高纬度、接缝上的岛形状大小都和赤道上一样
  const center: V3 | null = sphere ? toUnit(spec.x, spec.y) : null;
  const near = sphere ? Math.cos(Math.min(1, reach * elong) * Math.PI) : 0;
  // 只在岛的附近找格：从岛心那一格往外走到 reach·elong 再多两格，按编号排好，
  // 与原来逐格扫描整张图的结果、顺序都相同（岛链里几十个小岛时不再每个都扫一遍整张图）
  const c0 = centerCell(mesh, spec.x, spec.y);
  const limit = reach * elong + 2 * mesh.spacing;
  const cosLimit = Math.cos(Math.min(1, limit) * Math.PI);
  const within = (i: number) =>
    sphere && center
      ? sphere.p[3 * i] * center[0] + sphere.p[3 * i + 1] * center[1] + sphere.p[3 * i + 2] * center[2] >= cosLimit
      : Math.hypot(mesh.x[i] - spec.x, mesh.y[i] - spec.y) <= limit;
  const nearby: number[] = [];
  if (within(c0)) {
    const seen = new Set<number>([c0]);
    nearby.push(c0);
    for (let h = 0; h < nearby.length; h++) {
      const c = nearby[h];
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
        const j = mesh.adj[e];
        if (seen.has(j)) continue;
        seen.add(j);
        if (within(j)) nearby.push(j);
      }
    }
    nearby.sort((a, b) => a - b);
  }
  const geo: IslandGeometry = { R, c0, shape, cells: [], dx: [], dy: [], dd: [] };
  for (const i of nearby) {
    let dx: number;
    let dy: number;
    if (sphere && center) {
      const p: V3 = [sphere.p[3 * i], sphere.p[3 * i + 1], sphere.p[3 * i + 2]];
      if (p[0] * center[0] + p[1] * center[1] + p[2] * center[2] < near) continue;
      [dx, dy] = localOffset(center, p);
    } else {
      dx = mesh.x[i] - spec.x;
      dy = mesh.y[i] - spec.y;
    }
    if (Math.abs(dx) > reach * elong || Math.abs(dy) > reach * elong) continue;
    const u = (dx * ca + dy * sa) / Math.sqrt(elong);
    const v = (-dx * sa + dy * ca) * Math.sqrt(elong);
    const d = Math.hypot(u, v) / R;
    if (d > 1.9) continue;
    // 轮廓：噪声让边缘有湾有岬
    geo.cells.push(i);
    geo.dx.push(dx);
    geo.dy.push(dy);
    geo.dd.push(d * (1 + irregular * fbm(shape, dx / R, dy / R, 1.6, 3)));
  }
  return geo;
}

// 海里的岛的轮廓里一格的样子：海岸值的目标与抬升。core 见 islandCore
export function islandCellTarget(t: IslandType, dd: number, core: number, geo: IslandGeometry, k: number): { target: number; lift: number } {
  // 平的岛内圈只比海岸高一点，起伏、高的岛高得多
  const bump = t.height === 'flat' ? 40 : 400;
  if (t.shape === 'ring') {
    // 环礁：一圈陆地，中间潟湖，外侧很快变深。潟湖的海岸值是 −core（海岸噪声怎么调都还是海），
    // 深浅由海底的后处理定（浅浅的十几到几十米，见 elevation.ts 的 lagoonFloor）。总是平的
    const band = Math.abs(dd - 0.8);
    return { target: band < 0.16 ? core * 0.6 : dd < 0.8 ? -core : -core * 2, lift: 0 };
  }
  const target = dd < 1 ? core + (1 - dd) * bump : core - (dd - 1) * 3 * core;
  // 高：中间隆起成山（抬升从中心往外很快变小）；起伏：丘陵（抬升随噪声起伏）
  const R = geo.R;
  const lift =
    t.height === 'high'
      ? 0.5 * Math.pow(Math.max(0, 1 - dd), 1.4)
      : t.height === 'hilly'
        ? 0.25 * Math.max(0, 1 - dd) * (0.6 + 0.4 * fbm(geo.shape, geo.dx[k] / R + 1, geo.dy[k] / R, 3, 3))
        : 0;
  return { target, lift };
}

// 岛的内圈的海岸值（m）：海岸曲折怎么调都还是陆地
export const islandCore = (world: World) => COAST_AMP * Math.max(world.small.terrain.coastRoughness, 0.2) + 60;

// 按形状量的距离换成“离岛心”（0 岛心，1 岛的边上：海岸线大约落在这里）
export const islandRadiusOf = (t: IslandType, dd: number) => dd / SHORE[t.shape];

// 太小、一格陆地都放不出来时（大小不到 1.5 格才会发生），把岛心那一格抬成陆地
export function islandStamp(world: World, spec: IslandSpec): StampResult {
  const { t, code } = typeOfSpec(world, spec.kind);
  if (t.shape === 'cell') return reefStamp(world, spec, t, code);
  if (t.shape === 'frag') return fragStamp(world, spec, null);
  const { mesh, causes } = world;
  const ring = t.shape === 'ring';
  const rough = world.small.terrain.coastRoughness;
  const geo = islandGeometry(world, spec, t);
  const { c0 } = geo;
  const core = islandCore(world);
  const out: StampResult = { cells: [], landDelta: [], upliftDelta: [], erodDelta: [], types: [], footprint: [] };
  // 环礁的环与潟湖里的海格（岛心半径的 0.96 倍以内）：记上这种岛（潟湖的海底画成浅水）
  const coral: boolean[] = [];
  // 潟湖里（环以内）原来是海的格
  const lagoonish: boolean[] = [];
  for (let k = 0; k < geo.cells.length; k++) {
    const i = geo.cells[k];
    const dd = geo.dd[k];
    const { target, lift } = islandCellTarget(t, dd, core, geo, k);
    const L = causes.landness[i];
    let delta = 0;
    // 放岛只添陆地（第十三轮修）：潟湖里的海格两头都改（深海抬到 −core，浅滩压到 −core），
    // 原来就是陆地的格（挨着的岛、大陆）一格不动，不会被潟湖挖掉
    const inner = ring && dd < 0.8 - 0.16;
    if (inner && !causes.land[i]) delta = target - L;
    else delta = Math.max(0, target - L);
    const reefy = ring && dd < 0.96;
    if (delta === 0 && lift === 0 && !reefy) continue;
    out.cells.push(i);
    out.landDelta.push(delta);
    out.upliftDelta.push(lift);
    coral.push(reefy);
    lagoonish.push(inner && !causes.land[i]);
  }
  // 先按“潟湖里的海格都是潟湖”算轮廓：围住的小块海是潟湖时不并回陆地（见 fillSeaPockets）
  out.erodDelta = out.cells.map(() => 0);
  out.types = out.cells.map((_, k) => (lagoonish[k] ? code | LAGOON_BIT : 0));
  out.footprint = footprintOf(world, out);
  // 太小、一格陆地都没放出来：岛心那一格抬到岛的内圈高度（海岸值至少约 60 m）。
  // 岛心在地图外（岛链画出了地图边）时没有“岛心那一格”，不补：否则地图边上会多出一格一格的小岛
  const cellKm = mesh.spacing * world.kmPerUnit;
  if (onMap(world, spec) && !out.footprint.length && spec.size < cellKm * 1.5) {
    const coast = coastNoiseField(mesh, coastSeed(world));
    if (!causes.land[c0] && !isLandValue(causes.landness[c0], coast[c0], rough)) {
      const need = Math.max(0, core - causes.landness[c0]);
      const k = out.cells.indexOf(c0);
      if (k >= 0) out.landDelta[k] = Math.max(out.landDelta[k], need);
      else {
        let at = 0;
        while (at < out.cells.length && out.cells[at] < c0) at++;
        out.cells.splice(at, 0, c0);
        out.landDelta.splice(at, 0, need);
        out.upliftDelta.splice(at, 0, 0);
        out.erodDelta.splice(at, 0, 0);
        out.types.splice(at, 0, 0);
        coral.splice(at, 0, false);
        lagoonish.splice(at, 0, false);
      }
      out.footprint = footprintOf(world, out);
    }
  }
  // 岩石与种类：新长出的陆地（原来就是陆地的不动）、环礁的潟湖与环上的海格设成这种岛的可蚀性（没写岩石时不改），记上种类
  const erod = t.rock ?? null;
  const fresh = new Set(out.footprint);
  // 潟湖的海格要被环围住：挨着的格里至少六成是陆地（放岛以后）或别的潟湖格；环太小、开口太大时这一格还是深海
  // （一格大的环礁在格里画潟湖，见 colors.ts 的 lithLayer）
  const sea = new Set(out.cells.filter((i, k) => coral[k] && !fresh.has(i) && !causes.land[i]));
  const lagoon = new Set<number>();
  for (const i of sea) {
    let a = 0;
    let t = 0;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      t++;
      if (fresh.has(j) || causes.land[j] || sea.has(j)) a++;
    }
    if (a >= 0.6 * t) lagoon.add(i);
  }
  const mine = (f: Set<number>, i: number) => !causes.land[i] && (f.has(i) || lagoon.has(i));
  const erodOf = (f: Set<number>) => out.cells.map((i) => (erod === null || !mine(f, i) ? 0 : erod - causes.erod[i]));
  // 潟湖的海格（不在新长出的陆地里）另加 LAGOON_BIT
  const typesOf = (f: Set<number>) => out.cells.map((i) => (!mine(f, i) ? 0 : f.has(i) ? code : code | LAGOON_BIT));
  out.erodDelta = erodOf(fresh);
  out.types = typesOf(fresh);
  if (ring) {
    // 按真正的潟湖再算一次轮廓：没被环围住的小块海照常并回陆地（与执行后 resolveTerrain 的结果相同）
    out.footprint = footprintOf(world, out);
    const f = new Set(out.footprint);
    out.erodDelta = erodOf(f);
    out.types = typesOf(f);
  }
  return out;
}

// 岛的轮廓：放岛后在受影响范围内是陆地的格。types（与 cells 对齐，可省）：放岛记上的种类，潟湖的海格按它认
export function footprintOf(world: World, r: { cells: number[]; landDelta: number[]; types?: number[] }): number[] {
  const out: number[] = [];
  let types: Map<number, number> | undefined;
  if (r.types?.length) {
    types = new Map();
    r.cells.forEach((i, k) => {
      if (r.types![k]) types!.set(i, r.types![k]);
    });
  }
  for (const [i, land] of landAfter(world, r.cells, r.landDelta, types)) if (land) out.push(i);
  return out.sort((a, b) => a - b);
}

// ---------- 碎岛（第十八轮） ----------
// 放下去不把格变成陆地：只把一片海（岛心在湖面上时是这个湖的湖面）的破碎度抬高，画出一片比一格小的碎岛（见 subcell.ts 的 fragCoast）。
// 这一片的轮廓与不规则的岛一样（islandGeometry：拉长一点、边上有湾有岬，每放一片换一个样子），半径就是大小（至少约 0.75 格，
// 小的碎岛也碰得到岛心附近的几格）；里面约四成的面积画成碎岛，往外渐渐变稀。
// 只抬不降；不改陆度、抬升、岩石，也不记岛的种类（格还是海：碎岛归海省，一片起一个名字，见 features.ts）
const FRAG_ISLE_CORE = 0.55;
export function fragStamp(world: World, spec: IslandSpec, view: LakeView | null): StampResult {
  const { mesh, causes } = world;
  const out: StampResult = { cells: [], landDelta: [], upliftDelta: [], erodDelta: [], types: [], footprint: [], frag: { cells: [], value: [] } };
  if (!onMap(world, spec)) return out;
  const c0 = centerCell(mesh, spec.x, spec.y);
  const lake = view && view.lake[c0] === 1 && causes.land[c0] ? new Set(lakeOf(world, c0, view)) : null;
  const ok = (i: number) => (lake ? lake.has(i) : !causes.land[i]);
  if (!ok(c0)) return out;
  const { t } = typeOfSpec(world, spec.kind);
  const size = Math.max(spec.size, mesh.spacing * world.kmPerUnit * 0.75);
  const geo = islandGeometry(world, { ...spec, size }, t);
  const old = causes.fragment;
  const at = new Map<number, number>();
  for (let k = 0; k < geo.cells.length; k++) {
    const i = geo.cells[k];
    if (!ok(i)) continue;
    const f = FRAG_ISLE_CORE * (1 - smoothstep(0.35, 1, geo.dd[k]));
    if (f > 0) at.set(i, f);
  }
  // 岛心那一格总是有
  at.set(c0, Math.max(at.get(c0) ?? 0, FRAG_ISLE_CORE));
  for (const i of [...at.keys()].sort((a, b) => a - b)) {
    const v = Math.round(255 * at.get(i)!);
    if (v < 4 || (old && old[i] >= v)) continue;
    out.frag!.cells.push(i);
    out.frag!.value.push(v);
  }
  return out;
}

// ---------- 湖里的岛（第十五轮） ----------
// 湖面和海一样能放岛：每一种岛（内置的、自己的）都能点在湖面上，岛链也能画过湖。岛只占它岛心所在的那个湖：
//   · 只抬这个湖（连成一片、湖面一样高的湖面格）里的格，湖岸、别的湖一格不动；岛四周留一圈湖面（挨着湖岸、地图边的湖格不抬），
//     所以湖里的岛总是四周都是水、是一个有名字的岛（features.ts 的 lakeIslandInputs）；
//   · 剩下的湖面要连成一片（环礁的潟湖、被岛隔开的一块湖面：从离得最近的地方打开一个口子），湖面高度和溢出口都不变；
//   · 不改陆度、抬升、岩石（别的格的高程一格不变，湖照旧按溢出口蓄水），只记下这种岛（causes.islandType）与岛上每格的
//     海拔（湖面 + 高出湖面多少，causes.islandHeight，高程算完后直接换上，见 elevation.ts）。
// 高出湖面多少按这种岛的样子（形状、环礁的环、高低、大小）算，和海里同一种岛差不多：平的几米，起伏的几十到两三百米，
// 高的中间几百到一千多米，环礁的环一两米，一格的小礁两米。只取决于推导里的湖面（放岛那一刻的，命令里用 ensureDerived），
// 重放、撤销逐值相同。干盐湖（lake = 2）是陆地，不能放

// 推导里的湖面（lake = 1 是湖面）与水面高度
export interface LakeView {
  lake: ArrayLike<number>;
  water: ArrayLike<number>;
}
// 要用时才取湖面（命令里是 ensureDerived；批量命令里给 null：那时推导不是最新的，岛心在陆格上的岛不放）
export type LakeSource = () => LakeView | null;

export const EMPTY_STAMP: StampResult = { cells: [], landDelta: [], upliftDelta: [], erodDelta: [], types: [], footprint: [] };

// 岛心在不在地图上（一块地区的地图边外没有岛心那一格）
export function onMap(world: World, spec: { x: number; y: number }): boolean {
  const { mesh } = world;
  return mesh.kind === 'sphere' || (spec.x >= 0 && spec.x <= mesh.width && spec.y >= 0 && spec.y <= mesh.height);
}

// 同一个湖：从 c0 起连成一片的湖面格，水面与 c0 相差不到半米（内流湖的水面格之间最多差 0.5 m；挨着的两个湖一般差得多）
const SAME_LAKE_M = 0.51;
export function lakeOf(world: World, c0: number, view: LakeView): number[] {
  const { mesh, causes } = world;
  const level = view.water[c0];
  const seen = new Set<number>([c0]);
  const out = [c0];
  for (let h = 0; h < out.length; h++) {
    const c = out[h];
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
      const j = mesh.adj[e];
      if (seen.has(j) || !causes.land[j] || view.lake[j] !== 1 || Math.abs(view.water[j] - level) >= SAME_LAKE_M) continue;
      seen.add(j);
      out.push(j);
    }
  }
  return out.sort((a, b) => a - b);
}
