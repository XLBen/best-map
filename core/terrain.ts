import { z } from 'zod';
import { type BaseComponents, type GenModel, buildModel, coneFields, sampleComponents } from './generate';
import { type V3, arc, fromUnit, localOffset, slerp, toUnit, wrapX } from './geo';
import { LAYOUT_R, type PlanetModel, buildPlanetModel, planetConeFields, samplePlanetComponents } from './planet-gen';
import type { Mesh, SphereMesh } from './mesh';
import { clamp, fbm, fbm3, gradientNoise, gradientNoise3, mixSeed, mulberry32 } from './rng';
import type { World } from './world';

// 地形“原因”的组合：
//   landness = 生成的地壳高度 − 海平面 + 用户编辑（landDelta）
//   陆地 = landness + 海岸噪声 × 破碎度 > 0
// 海岸噪声是固定的（只取决于种子与位置），画笔、放岛、渲染、导出都用它，所以预览与结果一致。

// 海岸噪声的幅度（m）；乘以“海岸风格”的破碎度
export const COAST_AMP = 180;

export const COAST_STYLES = { smooth: 0.35, natural: 1, rugged: 1.8 } as const;

interface ConeField {
  coneB: Float32Array;
  coneU: Float32Array;
}

// 海平面分位数要用的排序（只取决于海岸破碎度）：拖“陆地多少”时不用每次重排
interface SeaOrder {
  rough: number;
  eff: Float64Array;
  order: number[];
  cum: Float64Array;
  total: number;
  max: number;
}

interface BaseCache {
  key: string;
  model: GenModel | PlanetModel | null;
  components: BaseComponents | null;
  // 按火山锥个数缓存几份（拖“岛多少”时来回切换不用重算）
  cones: Map<number, ConeField>;
  sea: SeaOrder | null;
  landness: Float32Array;
  uplift: Float32Array;
  erod: Float32Array;
  seaLevel: number;
}

// 组合基础场要用的参数：陆地多少、岛多少、山多高、海岸破碎度
export interface ComposeParams {
  landFraction: number;
  islands: number;
  mountains: number;
  rough: number;
}

const baseCache = new WeakMap<World, BaseCache>();
const coastCache = new WeakMap<Mesh, Map<number, Float32Array>>();

export function coastSeed(world: World): number {
  return world.small.terrain.gen?.seed ?? world.settings.seed;
}

export function coastNoiseAt(seed: number): (x: number, y: number) => number {
  const noise = gradientNoise(mixSeed(seed, 909));
  return (x, y) => fbm(noise, x, y, 45, 4, 0.6);
}

// 整个星球：同样的频率，在球面的布局坐标上取三维噪声（没有接缝）
export function coastNoiseAt3(seed: number): (x: number, y: number, z: number) => number {
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

// 生成器的结果：按参数缓存。陆地比例、岛多少、山多高变化时只重新组合，不重新采样
export function ensureBase(world: World): BaseCache {
  const { mesh } = world;
  const gen = world.small.terrain.gen;
  const n = mesh.n;
  const sampleKey = gen ? JSON.stringify({ seed: gen.seed, type: gen.type, rerolls: gen.rerolls, n, w: mesh.width }) : `blank:${n}`;
  let cache = baseCache.get(world);
  if (!cache || cache.key !== sampleKey) {
    // 整个星球用球面版本的生成器（planet-gen.ts）
    const model = !gen ? null : mesh.kind === 'sphere' ? buildPlanetModel(gen) : buildModel(gen, mesh.width, mesh.height);
    cache = {
      key: sampleKey,
      model,
      components: !model ? null : model.kind === 'planet' ? samplePlanetComponents(model, mesh as SphereMesh) : sampleComponents(model, mesh),
      cones: new Map(),
      sea: null,
      landness: new Float32Array(n),
      uplift: new Float32Array(n),
      erod: new Float32Array(n),
      seaLevel: 0,
    };
    baseCache.set(world, cache);
  }
  const comp = cache.components;
  if (!gen || !comp || !cache.model) {
    cache.landness.fill(-3000);
    cache.uplift.fill(0);
    cache.erod.fill(1);
    cache.seaLevel = 0;
    return cache;
  }
  cache.seaLevel = composeBase(world, cache, composeParams(world, cache, {}), cache.landness, cache.uplift);
  cache.erod.set(comp.erod);
  return cache;
}

function composeParams(world: World, cache: BaseCache, patch: Partial<ComposeParams>): ComposeParams {
  const gen = world.small.terrain.gen!;
  const p = cache.model!.params;
  return {
    landFraction: patch.landFraction ?? gen.landFraction ?? p.landFraction,
    islands: patch.islands ?? gen.islands ?? p.islands,
    mountains: patch.mountains ?? gen.mountains,
    rough: patch.rough ?? world.small.terrain.coastRoughness,
  };
}

function conesFor(world: World, cache: BaseCache, count: number): ConeField {
  let c = cache.cones.get(count);
  if (!c) {
    const m = cache.model!;
    c = m.kind === 'planet' ? planetConeFields(m, world.mesh as SphereMesh, count) : coneFields(m, world.mesh, count);
    // 只留最近用过的几份
    if (cache.cones.size >= 4) cache.cones.delete(cache.cones.keys().next().value!);
    cache.cones.set(count, c);
  }
  return c;
}

// 海平面：按面积加权的分位数，只看地壳本身（不含造山带与火山锥），所以“岛多少”“山多高”不会挪动别处的海岸
function seaLevelFor(world: World, cache: BaseCache, landFraction: number, rough: number): number {
  const { mesh } = world;
  const n = mesh.n;
  let s = cache.sea;
  if (!s || s.rough !== rough) {
    const comp = cache.components!;
    const coast = coastNoiseField(mesh, world.small.terrain.gen!.seed);
    const eff = new Float64Array(n);
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
      eff[i] = comp.b0[i] + COAST_AMP * rough * coast[i];
      max = Math.max(max, eff[i]);
    }
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => eff[a] - eff[b]);
    let total = 0;
    for (let i = 0; i < n; i++) total += mesh.area[i];
    // 按排好的顺序逐个累加面积（与逐格累加到目标为止的写法结果相同）
    const cum = new Float64Array(n);
    let acc = 0;
    for (let k = 0; k < n; k++) {
      acc += mesh.area[order[k]];
      cum[k] = acc;
    }
    s = cache.sea = { rough, eff, order, cum, total, max };
  }
  let seaLevel: number;
  if (landFraction <= 0) seaLevel = s.max + 1;
  else {
    const target = (1 - landFraction) * s.total;
    if (s.cum[n - 1] < target) seaLevel = s.eff[s.order[n - 1]];
    else {
      // 第一个累计面积达到目标的位置
      let lo = 0;
      let hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (s.cum[mid] >= target) hi = mid;
        else lo = mid + 1;
      }
      seaLevel = s.eff[s.order[lo]];
    }
  }
  // 海平面不低于大陆架：陆地不够时宁可少一点陆地，也不让洋中脊浮出水面变成长条岛
  return Math.max(seaLevel, -120);
}

// 按参数组合基础的 landness 与抬升（写进 outL / outU，返回海平面）。生成世界与“调整”的预览共用
function composeBase(world: World, cache: BaseCache, p: ComposeParams, outL: Float32Array, outU: Float32Array): number {
  const comp = cache.components!;
  const coneCount = Math.round(p.islands * cache.model!.cones.length);
  const { coneB, coneU } = conesFor(world, cache, coneCount);
  const seaLevel = seaLevelFor(world, cache, p.landFraction, p.rough);
  const mountains = p.mountains;
  for (let i = 0; i < world.mesh.n; i++) {
    outL[i] = comp.b0[i] - seaLevel + mountains * comp.mountB[i] + coneB[i];
    outU[i] = clamp(mountains * (0.95 * comp.mountU[i] + comp.hillU[i]) + coneU[i], 0, 1.6);
  }
  return seaLevel;
}

export function isLandValue(landness: number, coast: number, rough: number): boolean {
  return landness + COAST_AMP * rough * coast > 0;
}

// 由基础场与用户编辑得到最终的 landness、抬升、岩性与陆海掩码（写回 causes 的同名数组）
export function resolveTerrain(world: World) {
  const base = ensureBase(world);
  const { causes, mesh } = world;
  const n = mesh.n;
  const coast = coastNoiseField(mesh, coastSeed(world));
  const rough = world.small.terrain.coastRoughness;
  for (let i = 0; i < n; i++) {
    const L = base.landness[i] + causes.landDelta[i];
    causes.landness[i] = L;
    causes.uplift[i] = clamp(base.uplift[i] + causes.upliftDelta[i], 0, 2);
    causes.erod[i] = clamp(base.erod[i] + causes.erodDelta[i], 0.1, 5);
    causes.land[i] = isLandValue(L, coast[i], rough) ? 1 : 0;
  }
  fillTinyHoles(mesh, causes.land);
}

// 陆地里被海岸噪声戳出的单格“海”洞并回陆地（真正的内海、海湾都比这大）。
// 只看“四周全是陆地”这一条：陆地越多越容易满足，所以陆地比例调大时旧陆地一定被完整包含
function fillTinyHoles(mesh: Mesh, land: Uint8Array) {
  const fill: number[] = [];
  for (let i = 0; i < mesh.n; i++) {
    if (land[i] || mesh.boundary[i]) continue;
    let enclosed = true;
    for (let e = mesh.off[i]; e < mesh.off[i + 1] && enclosed; e++) if (!land[mesh.adj[e]]) enclosed = false;
    if (enclosed) fill.push(i);
  }
  for (const i of fill) land[i] = 1;
}

// “调整”面板拖滑块时的预览：按新的陆地多少 / 岛多少 / 山多高 / 海岸破碎度组合一遍，
// 返回会变成陆地、变成海的格，以及抬升变化明显的格。不改动世界与缓存里的结果；
// 松手后执行的 set_worldgen / set_coast_style 走同一个组合，所以结果与预览逐格一致
export interface TerrainPreview {
  gained: number[];
  lost: number[];
  relief: { cells: number[]; delta: number[] };
}

export type TerrainPatch = Partial<ComposeParams>;

export function previewTerrain(world: World, patch: TerrainPatch): TerrainPreview {
  const out: TerrainPreview = { gained: [], lost: [], relief: { cells: [], delta: [] } };
  const cache = ensureBase(world);
  const { mesh, causes } = world;
  const n = mesh.n;
  const rough = patch.rough ?? world.small.terrain.coastRoughness;
  const L = new Float32Array(n);
  const U = new Float32Array(n);
  if (world.small.terrain.gen && cache.components && cache.model) composeBase(world, cache, composeParams(world, cache, patch), L, U);
  else {
    L.fill(-3000);
    U.fill(0);
  }
  const coast = coastNoiseField(mesh, coastSeed(world));
  const land = new Uint8Array(n);
  for (let i = 0; i < n; i++) land[i] = isLandValue(L[i] + causes.landDelta[i], coast[i], rough) ? 1 : 0;
  fillTinyHoles(mesh, land);
  for (let i = 0; i < n; i++) {
    if (land[i] && !causes.land[i]) out.gained.push(i);
    else if (!land[i] && causes.land[i]) out.lost.push(i);
    if (!land[i]) continue;
    const d = clamp(U[i] + causes.upliftDelta[i], 0, 2) - causes.uplift[i];
    if (Math.abs(d) > 0.02) {
      out.relief.cells.push(i);
      out.relief.delta.push(d);
    }
  }
  return out;
}

// ---------- 画笔：画陆地 / 画海 ----------

// 画笔中心 70% 半径内一定变成陆地（海）；70%–100% 是自然的海岸过渡带；画笔外不变。
// 过渡带中间很平、两头很陡：海岸噪声在整条过渡带里决定海岸线的位置，
// 画出来的是有湾有岬的海岸，而不是笔画形状的光滑圆边
export function strokeProfile(t: number, rough: number): number {
  const m = COAST_AMP * Math.max(rough, 0.2) + 60;
  if (t <= 0.7) return m;
  const u = 1 - (2 * Math.min(1, t - 0.7)) / 0.3;
  const v = Math.max(-1, Math.min(1, u));
  return m * Math.sign(v) * Math.pow(Math.abs(v), 2.5);
}

export interface StrokeResult {
  cells: number[];
  delta: number[];
}

// t：每格到画笔中心的归一化距离（0 中心，1 边缘）
export function landStroke(world: World, cells: number[], t: number[], mode: 'land' | 'sea'): StrokeResult {
  const rough = world.small.terrain.coastRoughness;
  const out: StrokeResult = { cells: [], delta: [] };
  cells.forEach((i, k) => {
    const P = strokeProfile(t[k], rough);
    const L = world.causes.landness[i];
    const d = mode === 'land' ? Math.max(0, P - L) : Math.min(0, -P - L);
    if (d !== 0) {
      out.cells.push(i);
      out.delta.push(d);
    }
  });
  return out;
}

// 恢复原样（地形、气候的橡皮擦）：每格保留原改动的比例。t 是到画笔中心的归一化距离。
// 和画笔一样，中间 70% 全收回（0），只有最外一圈渐变到不动（1），
// 所以沿原来的笔画擦一遍就干净了
export function restoreKeep(t: number): number {
  const u = Math.max(0, Math.min(1, (t - 0.7) / 0.3));
  return u * u * (3 - 2 * u);
}

// 恢复后的陆地改动量：剩下的零头归零（擦过的地方不留看不见的残余）。命令与预览共用
export function restoredLandDelta(d: number, t: number): number {
  const v = d * restoreKeep(t);
  return Math.abs(v) < 0.5 ? 0 : v;
}

// 恢复原样后 landness 的增量（只含真的有改动的格），预览与命令共用
export function restoreStroke(world: World, cells: number[], t: number[]): StrokeResult {
  const out: StrokeResult = { cells: [], delta: [] };
  cells.forEach((i, k) => {
    const d = world.causes.landDelta[i];
    if (d === 0) return;
    out.cells.push(i);
    out.delta.push(restoredLandDelta(d, t[k]) - d);
  });
  return out;
}

// 应用 landness 增量后的陆海掩码（只算受影响的格），与 resolveTerrain 用同一规则（含单格洞的填补），
// 所以预览与结果逐格一致。after：受影响的格在改动后是不是陆地
export function landAfter(world: World, cells: number[], delta: number[]): Map<number, boolean> {
  const { mesh, causes } = world;
  const coast = coastNoiseField(mesh, coastSeed(world));
  const rough = world.small.terrain.coastRoughness;
  const d = new Map<number, number>();
  cells.forEach((i, k) => d.set(i, (d.get(i) ?? 0) + delta[k]));
  const raw = (i: number) => isLandValue(causes.landness[i] + (d.get(i) ?? 0), coast[i], rough);
  // 单格洞的填补看邻居，所以改动格的邻居也可能变
  const touched = new Set<number>();
  for (const i of d.keys()) {
    touched.add(i);
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) touched.add(mesh.adj[e]);
  }
  const after = new Map<number, boolean>();
  for (const i of touched) {
    let land = raw(i);
    if (!land && !mesh.boundary[i]) {
      land = true;
      for (let e = mesh.off[i]; e < mesh.off[i + 1] && land; e++) if (!raw(mesh.adj[e])) land = false;
    }
    after.set(i, land);
  }
  return after;
}

export function previewLand(world: World, cells: number[], delta: number[]): { gained: number[]; lost: number[] } {
  const gained: number[] = [];
  const lost: number[] = [];
  for (const [i, land] of landAfter(world, cells, delta)) {
    const now = world.causes.land[i] === 1;
    if (land && !now) gained.push(i);
    if (!land && now) lost.push(i);
  }
  return { gained, lost };
}

// ---------- 放岛 ----------

export const ISLAND_KINDS = ['volcanic', 'continental', 'low', 'atoll'] as const;
export type IslandKind = (typeof ISLAND_KINDS)[number];
export const ISLAND_KIND_INFO: Record<IslandKind, { name: string; hint: string }> = {
  volcanic: { name: '火山岛', hint: '圆形，中间有高高的火山' },
  continental: { name: '大陆岛', hint: '形状不规则，有丘陵' },
  low: { name: '低平岛', hint: '平坦低矮，多沙洲' },
  atoll: { name: '珊瑚岛', hint: '环形的低矮岛，中间是潟湖' },
};
export const ISLAND_SIZES = ['small', 'medium', 'large'] as const;

// 给人看的公里数：百公里以上取整到十
export const roundKm = (v: number) => (v >= 100 ? Math.round(v / 10) * 10 : Math.round(v));
export type IslandSize = (typeof ISLAND_SIZES)[number];

// 岛的大小：海岸线的半径（km），连续可调，放出来的岛平均就这么大。
// 旧存档里是“小·中·大”三档，照旧按原来的公式和形状重放
export const islandSizeSchema = z.union([z.enum(ISLAND_SIZES), z.number().min(0.1).max(20000)]);
export type IslandSizeSpec = z.output<typeof islandSizeSchema>;

export const islandSchema = z.object({
  x: z.number(),
  y: z.number(),
  kind: z.enum(ISLAND_KINDS).default('volcanic'),
  size: islandSizeSchema.default('medium'),
  // 同一选项、同一 variant → 同一个形状；“换个形状”就是换 variant。
  // 数值大小的岛形状与位置无关：鼠标移动时预览的轮廓跟着走、不变形，拖大拖小是同一个岛等比例缩放
  variant: z.number().int().min(0).default(0),
});
export type IslandSpec = z.output<typeof islandSchema>;

// 岛、画笔等大小的参照尺度（km）：一块地区是地图的高；整个星球取半圈经线的一半（与格距相当的地区地图同一个量级）
export function refKm(world: World): number {
  return world.mesh.kind === 'sphere' ? world.kmPerUnit / 2 : world.mesh.height * world.kmPerUnit;
}

// 岛的半径（km）：数值大小就是它本身；旧的三档是岛心半径，随地图尺度与格的大小变化，保证小岛也至少有几格
export function islandRadiusKm(world: World, size: IslandSizeSpec): number {
  if (typeof size === 'number') return size;
  const cellKm = world.mesh.spacing * world.kmPerUnit;
  const mapKm = refKm(world);
  const small = Math.max(cellKm * 2.2, mapKm * 0.012);
  return size === 'small' ? small : size === 'medium' ? small * 2.2 : small * 4.5;
}

// 可调的半径范围（km）：最小约 1.5 格，最大是地图高度的 20%
export function islandSizeRangeKm(world: World): [number, number] {
  const cellKm = world.mesh.spacing * world.kmPerUnit;
  const mapKm = refKm(world);
  return [cellKm * 1.5, Math.max(cellKm * 3, mapKm * 0.2)];
}

// 新世界里“放岛”默认的大小：与旧的“中”档看起来一样大
export function defaultIslandKm(world: World): number {
  const [lo, hi] = islandSizeRangeKm(world);
  return Math.min(hi, Math.max(lo, islandRadiusKm(world, 'medium') * SHORE.volcanic));
}

export interface StampResult {
  cells: number[];
  landDelta: number[];
  upliftDelta: number[];
  // 岛的轮廓（预览用）：放岛后会是陆地的格
  footprint: number[];
}

// 数值大小指海岸线的半径：轮廓平均落在这个距离上。岛心半径 R 与海岸线的比例按种类不同
// （高岛的地势在 R 以外再延伸约三分之一才入海；环礁的外缘在 R 以内一点）
const SHORE: Record<IslandKind, number> = { volcanic: 4 / 3, continental: 4 / 3, low: 4 / 3, atoll: 0.96 };

export function islandStamp(world: World, spec: IslandSpec): StampResult {
  const { mesh, causes } = world;
  const R = (typeof spec.size === 'string' ? islandRadiusKm(world, spec.size) : spec.size / SHORE[spec.kind]) / world.kmPerUnit;
  const rough = world.small.terrain.coastRoughness;
  // 旧的三档：形状随位置变（保持旧存档逐值重放）。数值大小：形状只取决于种类与 variant，
  // 噪声按“相对岛心、以半径为单位”的坐标取，所以换位置不变形、改大小是等比例缩放。
  // 整个星球上一律按数值大小的做法（星球没有旧存档）
  const sphere = mesh.kind === 'sphere' ? mesh : null;
  const legacy = typeof spec.size === 'string' && !sphere;
  const kindIdx = ISLAND_KINDS.indexOf(spec.kind);
  const seed = legacy
    ? mixSeed(coastSeed(world), 777, Math.round(spec.x * 1e4), Math.round(spec.y * 1e4), spec.variant, kindIdx)
    : mixSeed(coastSeed(world), 778, spec.variant, kindIdx);
  const shape = gradientNoise(seed);
  const rand = mulberry32(seed);
  // 大陆岛拉长、旋转；火山岛接近圆形
  const elong = spec.kind === 'continental' ? 1 + 0.8 * rand() : spec.kind === 'low' ? 1.3 + 0.9 * rand() : 1 + 0.15 * rand();
  const ang = rand() * Math.PI;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const irregular = spec.kind === 'continental' ? 0.45 : spec.kind === 'low' ? 0.25 : 0.18;
  const core = COAST_AMP * Math.max(rough, 0.2) + 60;
  const out: StampResult = { cells: [], landDelta: [], upliftDelta: [], footprint: [] };
  const reach = R * 1.9;
  // 整个星球：在岛心的切平面里取位置（等距方位投影），高纬度、接缝上的岛形状大小都和赤道上一样
  const center: V3 | null = sphere ? toUnit(spec.x, spec.y) : null;
  const near = sphere ? Math.cos(Math.min(1, reach * elong) * Math.PI) : 0;
  for (let i = 0; i < mesh.n; i++) {
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
    const dd = d * (1 + irregular * (legacy ? fbm(shape, mesh.x[i], mesh.y[i], 1.6 / R, 3) : fbm(shape, dx / R, dy / R, 1.6, 3)));
    let target: number;
    let lift = 0;
    if (spec.kind === 'atoll') {
      // 环礁：一圈陆地，中间潟湖（浅水），外侧很快变深
      const ring = Math.abs(dd - 0.8);
      target = ring < 0.16 ? core * 0.6 : dd < 0.8 ? -30 : -core * 2;
    } else {
      target = dd < 1 ? core + (1 - dd) * (spec.kind === 'low' ? 40 : 400) : core - (dd - 1) * 3 * core;
      if (spec.kind === 'volcanic') lift = 1.1 * Math.pow(Math.max(0, 1 - dd), 1.4);
      else if (spec.kind === 'continental')
        lift = 0.25 * Math.max(0, 1 - dd) * (0.6 + 0.4 * (legacy ? fbm(shape, mesh.x[i] + 3, mesh.y[i], 3 / R, 3) : fbm(shape, dx / R + 1, dy / R, 3, 3)));
    }
    const L = causes.landness[i];
    let delta = 0;
    if (spec.kind === 'atoll' && dd < 0.8 - 0.16) delta = Math.min(0, target - L);
    else delta = Math.max(0, target - L);
    if (delta === 0 && lift === 0) continue;
    out.cells.push(i);
    out.landDelta.push(delta);
    out.upliftDelta.push(lift);
  }
  out.footprint = footprintOf(world, out);
  return out;
}

// 岛的轮廓：放岛后在受影响范围内是陆地的格
function footprintOf(world: World, r: { cells: number[]; landDelta: number[] }): number[] {
  const out: number[] = [];
  for (const [i, land] of landAfter(world, r.cells, r.landDelta)) if (land) out.push(i);
  return out.sort((a, b) => a - b);
}

export const chainSchema = z.object({
  // 折线顶点（地图单位）
  points: z.array(z.tuple([z.number(), z.number()])).min(2),
  kind: z.enum(ISLAND_KINDS).default('volcanic'),
  size: islandSizeSchema.default('medium'),
  // 0.5 稀疏，1 正常，2 密集
  density: z.number().min(0.2).max(3).default(1),
  variant: z.number().int().min(0).default(0),
});
export type ChainSpec = z.output<typeof chainSchema>;

// 岛链：沿折线放一串岛，大小按幂律（少数大岛、许多小岛），左右略有错落
export function chainIslands(world: World, spec: ChainSpec): IslandSpec[] {
  if (world.mesh.kind === 'sphere') return chainIslandsSphere(world, spec);
  const pts = spec.points;
  let total = 0;
  const seg: number[] = [];
  for (let k = 0; k + 1 < pts.length; k++) {
    const l = Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
    seg.push(l);
    total += l;
  }
  const baseKm = islandRadiusKm(world, spec.size);
  const baseR = baseKm / world.kmPerUnit;
  const spacing = (baseR * 2.6) / spec.density;
  const count = Math.max(1, Math.round(total / spacing));
  const rand = mulberry32(mixSeed(coastSeed(world), 555, Math.round(pts[0][0] * 1e4), Math.round(pts[0][1] * 1e4), spec.variant));
  const legacy = typeof spec.size === 'string';
  const minKm = islandSizeRangeKm(world)[0];
  const sizes: IslandSizeSpec[] = [];
  for (let k = 0; k < count; k++) {
    const u = rand();
    // 重尾：大约 15% 大一号，45% 小一号
    if (typeof spec.size === 'string') sizes.push(u < 0.15 ? bigger(spec.size) : u < 0.6 ? spec.size : smaller(spec.size));
    else sizes.push(u < 0.15 ? baseKm * 2 : u < 0.6 ? baseKm : Math.max(minKm, baseKm / 2));
  }
  const out: IslandSpec[] = [];
  for (let k = 0; k < count; k++) {
    let s = ((k + 0.5) / count) * total;
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
    const off = (rand() - 0.5) * baseR * 1.4;
    // 数值大小的岛形状与位置无关，岛链里每个岛要用不同的 variant（也避开单独放岛用的那些）
    const variant = legacy ? spec.variant * 1000 + k : 1_000_000 + spec.variant * 1000 + k;
    out.push({ x: x0 + (x1 - x0) * t + nx * off, y: y0 + (y1 - y0) * t + ny * off, kind: spec.kind, size: sizes[k], variant });
  }
  return out;
}

// 整个星球上的岛链：折线各段是大圆弧，沿弧插值，向两侧的错落沿弧的法向
function chainIslandsSphere(world: World, spec: ChainSpec): IslandSpec[] {
  const pts = spec.points.map(([x, y]) => toUnit(x, y));
  let total = 0;
  const seg: number[] = [];
  for (let k = 0; k + 1 < pts.length; k++) {
    const l = arc(pts[k], pts[k + 1]) / Math.PI;
    seg.push(l);
    total += l;
  }
  const baseKm = islandRadiusKm(world, spec.size);
  const baseR = baseKm / world.kmPerUnit;
  const spacing = (baseR * 2.6) / spec.density;
  const count = Math.max(1, Math.round(total / spacing));
  const x0 = wrapX(spec.points[0][0]);
  const rand = mulberry32(mixSeed(coastSeed(world), 555, Math.round(x0 * 1e4), Math.round(spec.points[0][1] * 1e4), spec.variant));
  const minKm = islandSizeRangeKm(world)[0];
  const sizes: IslandSizeSpec[] = [];
  for (let k = 0; k < count; k++) {
    const u = rand();
    sizes.push(u < 0.15 ? baseKm * 2 : u < 0.6 ? baseKm : Math.max(minKm, baseKm / 2));
  }
  const out: IslandSpec[] = [];
  for (let k = 0; k < count; k++) {
    let s = ((k + 0.5) / count) * total;
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
    const off = (rand() - 0.5) * baseR * 1.4 * Math.PI;
    const q: V3 = [at[0] + nx * off, at[1] + ny * off, at[2] + nz * off];
    const ql = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2]);
    const [x, y] = fromUnit([q[0] / ql, q[1] / ql, q[2] / ql]);
    out.push({ x, y, kind: spec.kind, size: sizes[k], variant: 1_000_000 + spec.variant * 1000 + k });
  }
  return out;
}

const bigger = (s: IslandSize): IslandSize => (s === 'small' ? 'medium' : 'large');
const smaller = (s: IslandSize): IslandSize => (s === 'large' ? 'medium' : 'small');

// 多个岛依次叠加（后一个看见前一个的结果），返回合并后的增量
export function combineStamps(world: World, specs: IslandSpec[]): StampResult {
  const { causes } = world;
  const landSaved = new Map<number, number>();
  const acc = new Map<number, { land: number; lift: number }>();
  for (const spec of specs) {
    const r = islandStamp(world, spec);
    r.cells.forEach((i, k) => {
      if (!landSaved.has(i)) landSaved.set(i, causes.landness[i]);
      causes.landness[i] += r.landDelta[k];
      const a = acc.get(i) ?? { land: 0, lift: 0 };
      a.land += r.landDelta[k];
      a.lift += r.upliftDelta[k];
      acc.set(i, a);
    });
  }
  for (const [i, v] of landSaved) causes.landness[i] = v;
  const out: StampResult = { cells: [], landDelta: [], upliftDelta: [], footprint: [] };
  for (const [i, a] of acc) {
    out.cells.push(i);
    out.landDelta.push(a.land);
    out.upliftDelta.push(a.lift);
  }
  out.footprint = footprintOf(world, out);
  return out;
}

// 堆山 / 压低：抬升的增量，中心最大，平滑衰减到边缘
export function reliefStroke(cells: number[], t: number[], strength: number): { cells: number[]; delta: number[] } {
  return { cells, delta: t.map((v) => strength * (1 - v * v) * (1 - v * v)) };
}
