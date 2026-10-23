import { z } from 'zod';
import { type BaseComponents, type GenModel, type Reroll, buildModel, coneFields, resolvedParams, sampleComponents, withParams } from './generate';
import { type V3, arc, fromUnit, localOffset, slerp, toUnit, wrapX } from './geo';
import { LAYOUT_R, type PlanetModel, buildPlanetModel, planetConeFields, resolvedPlanetParams, samplePlanetComponents, withPlanetParams } from './planet-gen';
import { formDigest } from './planet-form';
import type { ScriptIssue } from './script';
import { type Mesh, type SphereMesh, findCell } from './mesh';
import { clamp, fbm, fbm3, gradientNoise, gradientNoise3, mixSeed, mulberry32 } from './rng';
import { nearestCell } from './sphere';
import { coastValueAt } from './subcell';
import type { World } from './world';

// 地形“原因”的组合：
//   landness = 生成的地壳高度 − 海平面 + 用户编辑（landDelta）
//   陆地 = landness + 海岸噪声 × 破碎度 > 0
// 海岸噪声是固定的（只取决于种子与位置），画笔、放岛、渲染、导出都用它，所以预览与结果一致。

// 海岸噪声的幅度（m）；乘以“海岸风格”的破碎度
export const COAST_AMP = 180;

interface ConeField {
  coneB: Float32Array;
  coneU: Float32Array;
}

// 海平面分位数要用的排序（只取决于海岸破碎度）：拖“陆地多少”时不用每次重排
interface SeaOrder {
  rough: number;
  eff: Float64Array;
  order: Int32Array;
  cum: Float64Array;
  total: number;
  max: number;
}

interface BaseCache {
  key: string;
  // 不含重画的部分与网格：只有重画变了时只重算重画圈里的格
  shapeKey: string;
  mesh: Mesh;
  model: GenModel | PlanetModel | null;
  components: BaseComponents | null;
  // 按火山锥个数缓存几份（拖“岛多少”时来回切换不用重算）
  cones: Map<number, ConeField>;
  // 留两份，最近用的在前：拖“海岸破碎度”时世界本身（旧值）与预览（新值）交替要用
  sea: SeaOrder[];
  landness: Float32Array;
  uplift: Float32Array;
  erod: Float32Array;
  seaLevel: number;
  // 海底后处理要用的两个场（见 seabedFields）：按分量、火山锥、海平面缓存一份
  seabed?: { components: BaseComponents; cones: ConeField; seaLevel: number; fields: SeabedFields };
}

// 海底的后处理（elevation.ts 的 seafloor）要用的生成器信息，都按格：
//   ocean：洋底的目标深度（相对海平面，m）：随洋壳年龄变深、海沟、加上海山（火山锥）
//   shelf：这里的地壳有多“大陆”（0 洋壳，1 陆壳）：陆壳淹在水下就是宽的大陆架，洋壳上的岛只有窄窄的岛架
export interface SeabedFields {
  ocean: Float32Array;
  shelf: Float32Array;
}

// 组合基础场要用的参数：陆地多少、岛多少、山多高、海岸破碎度
export interface ComposeParams {
  landFraction: number;
  islands: number;
  mountains: number;
  rough: number;
}

const baseCache = new WeakMap<World, BaseCache>();
// 同一个网格上按采样的键留最近的两份生成器结果（模型、分量、火山锥），换了一个世界也能用（第九轮 A2）：
// 打开存档（重放）、撤销到新建之前再重做时，新的 World 不用把整个星球重新采样一遍。
// 分量只读（重画时另建一份）；模型的参数换成这个世界的（与重画时的做法相同），所以与重新采样逐值相同
interface SampledBase {
  key: string;
  shapeKey: string;
  model: GenModel | PlanetModel;
  components: BaseComponents;
  cones: Map<number, ConeField>;
}
const sampledCache = new WeakMap<Mesh, SampledBase[]>();
// 测试用：on = false 时不读也不写
export const sampledBaseMemo = { on: true, hits: 0 };
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

// 生成器结果的缓存键：sampleKey 变了要重新采样（只有重画变了时局部重算），shapeKey 变了要重建模型。
// 星球形态只在有的时候才加进键里：没有形态的世界，键与以前逐字节相同
function baseKeys(world: World): { sampleKey: string; shapeKey: string } {
  const { mesh } = world;
  const gen = world.small.terrain.gen;
  const n = mesh.n;
  const form = gen?.form ? { form: formDigest(gen.form) } : {};
  const sampleKey = gen ? JSON.stringify({ seed: gen.seed, type: gen.type, rerolls: gen.rerolls, n, w: mesh.width, ...form }) : `blank:${n}`;
  const shapeKey = gen ? JSON.stringify({ seed: gen.seed, type: gen.type, n, w: mesh.width, ...form }) : sampleKey;
  return { sampleKey, shapeKey };
}

// 生成器的结果：按参数缓存。陆地比例、岛多少、山多高变化时只重新组合，不重新采样
export function ensureBase(world: World): BaseCache {
  const { mesh } = world;
  const gen = world.small.terrain.gen;
  const n = mesh.n;
  const { sampleKey, shapeKey } = baseKeys(world);
  let cache = baseCache.get(world);
  if (!cache || cache.key !== sampleKey) {
    const old = cache;
    let model: GenModel | PlanetModel | null;
    let components: BaseComponents | null;
    let cones = new Map<number, ConeField>();
    const sampled = gen && sampledBaseMemo.on ? sampledCache.get(mesh)?.find((s) => s.key === sampleKey) : undefined;
    if (gen && sampled) {
      sampledBaseMemo.hits++;
      model = sampled.model.kind === 'planet' ? withPlanetParams(sampled.model, gen) : withParams(sampled.model, gen);
      components = sampled.components;
      cones = sampled.cones;
    } else if (gen && old && old.model && old.components && old.shapeKey === shapeKey && old.mesh === mesh) {
      // 只有重画变了（重画一片、撤销、重做）：模型与火山锥照用，只重算新旧两组不同的那些重画圈里的格
      model = old.model.kind === 'planet' ? withPlanetParams(old.model, gen) : withParams(old.model, gen);
      const was = old.model.params.rerolls;
      const now = model.params.rerolls;
      let p = 0;
      while (p < was.length && p < now.length && sameReroll(was[p], now[p])) p++;
      const re = { from: old.components, changed: [...was.slice(p), ...now.slice(p)] };
      components = model.kind === 'planet' ? samplePlanetComponents(model, mesh as SphereMesh, re) : sampleComponents(model, mesh, re);
      cones = old.cones;
    } else {
      // 整个星球用球面版本的生成器（planet-gen.ts）
      model = !gen ? null : mesh.kind === 'sphere' ? buildPlanetModel(gen) : buildModel(gen, mesh.width, mesh.height);
      components = !model ? null : model.kind === 'planet' ? samplePlanetComponents(model, mesh as SphereMesh) : sampleComponents(model, mesh);
    }
    if (gen && model && components && sampledBaseMemo.on && !sampled) {
      const list = sampledCache.get(mesh) ?? [];
      sampledCache.set(mesh, [{ key: sampleKey, shapeKey, model, components, cones }, ...list].slice(0, 2));
    }
    cache = {
      key: sampleKey,
      shapeKey,
      mesh,
      model,
      components,
      cones,
      sea: [],
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

// 海底后处理要用的场（见 SeabedFields）；没有生成器（空白世界）时为 null：洋底一律按远洋算。
// 只取决于生成器的分量、火山锥个数与海平面（陆地多少、岛多少、海岸破碎度），用户的编辑不改它们
export function seabedFields(world: World): SeabedFields | null {
  const cache = ensureBase(world);
  const comp = cache.components;
  const model = cache.model;
  if (!world.small.terrain.gen || !comp || !model) return null;
  const p = composeParams(world, cache, {});
  const fixed = model.kind === 'planet' ? model.fixedCones : 0;
  const cones = conesFor(world, cache, fixed + Math.round(p.islands * (model.cones.length - fixed)));
  const sb = cache.seabed;
  if (sb && sb.components === comp && sb.cones === cones && sb.seaLevel === cache.seaLevel) return sb.fields;
  const n = world.mesh.n;
  const ocean = new Float32Array(n);
  const shelf = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    ocean[i] = comp.sea[i] - cache.seaLevel + cones.coneB[i];
    // 地壳高度在 −2300 m 以下是洋壳，−500 m 以上是陆壳（大陆架、淹没的大陆）
    const t = clamp((comp.b0[i] + 2300) / 1800, 0, 1);
    shelf[i] = t * t * (3 - 2 * t);
  }
  const fields = { ocean, shelf };
  cache.seabed = { components: comp, cones, seaLevel: cache.seaLevel, fields };
  return fields;
}

// 星球形态的脚本这次出的问题（布局脚本、地形脚本；出错的那一部分已按没有脚本算）。没有形态、没有问题时为空。
// 普通的 JSON；植被那一步把它们放在 d.scriptIssues 的最前面，与生态的脚本的问题一起给界面看。
// 只读缓存，不重新采样。缓存不是按现在的参数算的（刚从检查点恢复、地形还没重新组合过）时，地形也就
// 没变过：照用 prev（上一次推导的 d.scriptIssues）里布局、地形两种脚本的问题
export function planetFormIssues(world: World, prev?: readonly ScriptIssue[]): ScriptIssue[] {
  if (!world.small.terrain.gen?.form) return [];
  const cache = baseCache.get(world);
  if (!cache || cache.key !== baseKeys(world).sampleKey) return (prev ?? []).filter((x) => x.kind === 'setup' || x.kind === 'crust');
  const model = cache.model;
  if (!model || model.kind !== 'planet') return [];
  return [...(model.issues ?? []), ...(cache.components?.issues ?? [])];
}

// 世界的副本（预览、测试的模板）共用原世界的生成器结果，不必重新采样整个生成器。
// 共用是安全的：ensureBase 每次都按调用它的世界重新组合缓存里的数组，读的地方都先调用它；
// 重画变了时另建一份缓存（局部重算复制原来的分量，不改动它），原世界的那一份不受影响
export function shareTerrainBase(from: World, to: World) {
  const cache = baseCache.get(from);
  if (cache) baseCache.set(to, cache);
}

// 同一次重画：逐字段比（−0 与 +0 也算不同，宁可多重算几格）
const sameReroll = (a: Reroll, b: Reroll) => Object.is(a.x, b.x) && Object.is(a.y, b.y) && Object.is(a.radius, b.radius) && Object.is(a.variant, b.variant);

// 没写的陆地比例、岛多少按现在的 gen 取类型的默认值，不取缓存模型里的：模型只在采样键变了时才换参数，
// 键没变时（比如撤销到重画之前、又撤掉了陆地比例）模型的参数还是建它那时的 gen 的
function composeParams(world: World, cache: BaseCache, patch: Partial<ComposeParams>): ComposeParams {
  const gen = world.small.terrain.gen!;
  const fallback = () => (cache.model!.kind === 'planet' ? resolvedPlanetParams(gen) : resolvedParams(gen));
  return {
    landFraction: patch.landFraction ?? gen.landFraction ?? fallback().landFraction,
    islands: patch.islands ?? gen.islands ?? fallback().islands,
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

// 小端机器上 Float64 的高 32 位在后一个字
const HI = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 1 : 0;

// 按值从小到大排好的下标，值相等时下标小的在前：与 Array.sort((a, b) => v[a] - v[b]) 的稳定排序逐个相同（v 里没有 NaN）。
// 基数排序：浮点数换成可按无符号整数比的 64 位键（−0 当 +0，负数全部取反、正数翻符号位），每轮 16 位，从低到高共 4 轮
export function sortedOrder(v: Float64Array): Int32Array {
  const n = v.length;
  const f = new Float64Array(n);
  // −0 + 0 = +0，其余不变
  for (let i = 0; i < n; i++) f[i] = v[i] + 0;
  const u = new Uint32Array(f.buffer);
  const hi = new Uint32Array(n);
  const lo = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const h = u[2 * i + HI];
    const l = u[2 * i + 1 - HI];
    if (h >>> 31) {
      hi[i] = ~h;
      lo[i] = ~l;
    } else {
      hi[i] = h | 0x80000000;
      lo[i] = l;
    }
  }
  let src = new Int32Array(n);
  let dst = new Int32Array(n);
  for (let i = 0; i < n; i++) src[i] = i;
  const count = new Int32Array(65536);
  for (let pass = 0; pass < 4; pass++) {
    const key = pass < 2 ? lo : hi;
    const shift = pass & 1 ? 16 : 0;
    count.fill(0);
    for (let i = 0; i < n; i++) count[(key[i] >>> shift) & 0xffff]++;
    // 这 16 位全都一样：这一轮不改变顺序
    if (n === 0 || count[(key[0] >>> shift) & 0xffff] === n) continue;
    let sum = 0;
    for (let d = 0; d < 65536; d++) {
      const c = count[d];
      count[d] = sum;
      sum += c;
    }
    for (let k = 0; k < n; k++) {
      const i = src[k];
      dst[count[(key[i] >>> shift) & 0xffff]++] = i;
    }
    [src, dst] = [dst, src];
  }
  return src;
}

// 海平面：按面积加权的分位数，只看地壳本身（不含造山带与火山锥），所以“岛多少”“山多高”不会挪动别处的海岸
function seaLevelFor(world: World, cache: BaseCache, landFraction: number, rough: number): number {
  const { mesh } = world;
  const n = mesh.n;
  let s = cache.sea.find((e) => e.rough === rough);
  if (!s) {
    const comp = cache.components!;
    const coast = coastNoiseField(mesh, world.small.terrain.gen!.seed);
    const eff = new Float64Array(n);
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
      eff[i] = comp.b0[i] + COAST_AMP * rough * coast[i];
      max = Math.max(max, eff[i]);
    }
    const order = sortedOrder(eff);
    let total = 0;
    for (let i = 0; i < n; i++) total += mesh.area[i];
    // 按排好的顺序逐个累加面积（与逐格累加到目标为止的写法结果相同）
    const cum = new Float64Array(n);
    let acc = 0;
    for (let k = 0; k < n; k++) {
      acc += mesh.area[order[k]];
      cum[k] = acc;
    }
    s = { rough, eff, order, cum, total, max };
  }
  // 最近用的放前面，只留两份
  if (cache.sea[0] !== s) cache.sea = [s, ...cache.sea.filter((e) => e !== s)].slice(0, 2);
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
  const model = cache.model!;
  // 星球形态的布局脚本加的岛排在最前，总是露出来；“岛多少”只增减其余的火山锥（没有形态时 fixed 为 0，与以前相同）
  const fixed = model.kind === 'planet' ? model.fixedCones : 0;
  const coneCount = fixed + Math.round(p.islands * (model.cones.length - fixed));
  const { coneB, coneU } = conesFor(world, cache, coneCount);
  const seaLevel = seaLevelFor(world, cache, p.landFraction, p.rough);
  const mountains = p.mountains;
  for (let i = 0; i < world.mesh.n; i++) {
    outL[i] = comp.b0[i] - seaLevel + mountains * comp.mountB[i] + coneB[i];
    outU[i] = clamp(mountains * (0.95 * comp.mountU[i] + comp.hillU[i]) + coneU[i], 0, 1.6);
  }
  return seaLevel;
}

function isLandValue(landness: number, coast: number, rough: number): boolean {
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
// 松手后执行的 set_worldgen / set_coast_style 走同一个组合，所以结果与预览逐格一致。
// “重画这一片”（patch.reroll）也走这里：与 reroll_region 同样只重算重画圈里的格、重新定海平面
export interface TerrainPreview {
  gained: number[];
  lost: number[];
  relief: { cells: number[]; delta: number[] };
  // 每格将来的海岸值：与执行后的 coastValues 逐位相同（幽灵海岸照此画出将来的海岸线）
  coast: Float32Array;
  // 将来的海岸破碎度（画海岸细节的幅度跟着它）
  rough: number;
  // 算这一份用了多久（毫秒，Worker 填）：太慢时工具不再自动预览
  ms?: number;
}

export type TerrainPatch = Partial<ComposeParams> & { reroll?: Reroll };

export function previewTerrain(world: World, patch: TerrainPatch): TerrainPreview {
  const { mesh, causes } = world;
  const n = mesh.n;
  const rough = patch.rough ?? world.small.terrain.coastRoughness;
  const out: TerrainPreview = { gained: [], lost: [], relief: { cells: [], delta: [] }, coast: new Float32Array(n), rough };
  let cache = ensureBase(world);
  const gen = world.small.terrain.gen;
  if (gen && cache.model && cache.components && patch.reroll) {
    // 与 ensureBase 里重画变了时同一条路：模型换参数、只重算新的重画圈、火山锥照用、海平面重新排序。
    // 用一份临时的缓存，世界的缓存不动
    const r = patch.reroll;
    const next = { ...gen, rerolls: [...gen.rerolls, { x: r.x, y: r.y, radius: r.radius, variant: r.variant }] };
    const model = cache.model.kind === 'planet' ? withPlanetParams(cache.model, next) : withParams(cache.model, next);
    const re = { from: cache.components, changed: [r] };
    const components = model.kind === 'planet' ? samplePlanetComponents(model, mesh as SphereMesh, re) : sampleComponents(model, mesh, re);
    cache = { ...cache, model, components, sea: [] };
  }
  const L = new Float32Array(n);
  const U = new Float32Array(n);
  if (gen && cache.components && cache.model) composeBase(world, cache, composeParams(world, cache, patch), L, U);
  else {
    L.fill(-3000);
    U.fill(0);
  }
  const coast = coastNoiseField(mesh, coastSeed(world));
  const land = new Uint8Array(n);
  for (let i = 0; i < n; i++) land[i] = isLandValue(L[i] + causes.landDelta[i], coast[i], rough) ? 1 : 0;
  fillTinyHoles(mesh, land);
  // 海岸值：与 resolveTerrain 写回的 landness（float32）、coastValues 同一个算式
  const amp = COAST_AMP * rough;
  for (let i = 0; i < n; i++) out.coast[i] = coastValueAt(Math.fround(L[i] + causes.landDelta[i]), coast[i], amp, land[i] === 1);
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
function landAfter(world: World, cells: number[], delta: number[]): Map<number, boolean> {
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

// 幽灵海岸要的补丁：landAfter 的那些格（改动的格与它们的邻格，按编号排好），改动后的 landness 与陆海。
// landness 按 float32 存（与 resolveTerrain 写回 causes.landness 的精度相同），交给 subcell.ts 的 coastPatch 算海岸值
export interface LandPatch {
  cells: Int32Array;
  landness: Float32Array;
  land: Uint8Array;
}

export function landPatch(world: World, cells: number[], delta: number[]): LandPatch {
  const d = new Map<number, number>();
  cells.forEach((i, k) => d.set(i, (d.get(i) ?? 0) + delta[k]));
  const after = [...landAfter(world, cells, delta)].sort((a, b) => a[0] - b[0]);
  const out: LandPatch = { cells: new Int32Array(after.length), landness: new Float32Array(after.length), land: new Uint8Array(after.length) };
  after.forEach(([i, land], k) => {
    out.cells[k] = i;
    out.landness[k] = world.causes.landness[i] + (d.get(i) ?? 0);
    out.land[k] = land ? 1 : 0;
  });
  return out;
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

// 岛链能用的种类；放岛另有“小礁”（只占一格，不进岛链）。新种类只往后加：种类的序号参与形状的种子
export const CHAIN_KINDS = ['volcanic', 'continental', 'low', 'atoll'] as const;
export const ISLAND_KINDS = [...CHAIN_KINDS, 'reef'] as const;
export type IslandKind = (typeof ISLAND_KINDS)[number];
export type ChainKind = (typeof CHAIN_KINDS)[number];
export const ISLAND_KIND_INFO: Record<IslandKind, { name: string; hint: string }> = {
  volcanic: { name: '火山岛', hint: '圆形，中间有高高的火山，暗色的玄武岩' },
  continental: { name: '大陆岛', hint: '形状不规则，有丘陵' },
  low: { name: '低平岛', hint: '平坦低矮，多沙洲和沼泽' },
  atoll: { name: '珊瑚岛', hint: '环形的白沙岛，中间是青绿色的浅潟湖' },
  reef: { name: '小礁', hint: '只占一格的白沙小岛，四周一圈浪花，画出来约半格大' },
};

// 每种岛的岩性（第十三轮）：放岛时把新长出的陆地（珊瑚岛还有潟湖）的可蚀性（causes.erod）设成这个值，
// 渲染按可蚀性给颜色（src/render/colors.ts 的 lithLayer），所以几种岛小到一两格也看得出来：
//   火山岛 0.45：硬的玄武岩，暗色（生成的地形里可蚀性在 0.4–1.8，低于 0.62 的很少）；
//   大陆岛不变（和周围的大陆一样）；
//   低平岛 3.2：软，蚀得低平，沙与沼泽；
//   小礁 4.3、珊瑚岛 4.8：珊瑚砂，白沙；珊瑚岛的潟湖（海格）也是 4.8，海底按它画成浅浅的青绿色潟湖（elevation.ts 的 lagoonFloor）
export const ISLAND_ERODIBILITY: Record<IslandKind, number | null> = { volcanic: 0.45, continental: null, low: 3.2, atoll: 4.8, reef: 4.3 };
// 给人看的公里数：百公里以上取整到十
export const roundKm = (v: number) => (v >= 100 ? Math.round(v / 10) * 10 : Math.round(v));

// 岛的大小：海岸线的半径（km），连续可调，放出来的岛平均就这么大
const islandSizeSchema = z.number().min(0.1).max(20000);

export const islandSchema = z.object({
  x: z.number(),
  y: z.number(),
  kind: z.enum(ISLAND_KINDS).default('volcanic'),
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
// 第十三轮：四种岛一样（以前 0.75 格、珊瑚岛 1.5 格）；一格大的珊瑚岛在这一格里画出环和潟湖（渲染按岩性）
const ISLAND_MIN_CELLS = 0.4;

// 可调的半径范围（km）：最小一格（见 ISLAND_MIN_CELLS），最大是地图高度的 20%。四种岛一样；小礁不看大小
export function islandSizeRangeKm(world: World, _kind: IslandKind = 'volcanic'): [number, number] {
  const cellKm = world.mesh.spacing * world.kmPerUnit;
  const mapKm = refKm(world);
  return [cellKm * ISLAND_MIN_CELLS, Math.max(cellKm * 3, mapKm * 0.2)];
}

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
  return Math.min(hi, Math.max(lo, core * SHORE.volcanic));
}

export interface StampResult {
  cells: number[];
  landDelta: number[];
  upliftDelta: number[];
  // 可蚀性的增量（岛的岩性，见 ISLAND_ERODIBILITY）
  erodDelta: number[];
  // 岛的轮廓（预览用）：放岛后会是陆地的格
  footprint: number[];
}

// 数值大小指海岸线的半径：轮廓平均落在这个距离上。岛心半径 R 与海岸线的比例按种类不同
// （高岛的地势在 R 以外再延伸约三分之一才入海；环礁的外缘在 R 以内一点）
const SHORE: Record<IslandKind, number> = { volcanic: 4 / 3, continental: 4 / 3, low: 4 / 3, atoll: 0.96, reef: 1 };

// 小礁那一格的海岸值约 +95 m（250·tanh(100/250)）。四周深海约 −250 m，海岸线落在每条边离格心约 0.28 处，
// 屏幕和导出都画成约半格宽的小岛（实测约占这一格面积的四分之一）
const REEF_V = 100;
// 海岸曲折调到 0 到 2 时，后两项至少留这么多（m）：改海岸曲折时海平面会挪动十来米
const REEF_KEEP = 30;

// 岛心所在的格：整个星球按球面上最近的格（与 toUnit 同一个换算）
function centerCell(mesh: Mesh, x: number, y: number): number {
  return mesh.kind === 'sphere' ? nearestCell(mesh, x, y) : findCell(mesh, x, y);
}

// 小礁：只把岛心那一格抬成陆地，不看大小和形状。陆度取 max(REEF_V − a·k, REEF_KEEP − 2·COAST_AMP·k, REEF_KEEP)：
// 第一项让现在的海岸值是 REEF_V；后两项保证海岸曲折调到 0 到 2 之间它都还在
function reefStamp(world: World, spec: IslandSpec): StampResult {
  const { mesh, causes } = world;
  const out: StampResult = { cells: [], landDelta: [], upliftDelta: [], erodDelta: [], footprint: [] };
  const c = centerCell(mesh, spec.x, spec.y);
  if (causes.land[c]) return out;
  const k = coastNoiseField(mesh, coastSeed(world))[c];
  const a = COAST_AMP * world.small.terrain.coastRoughness;
  const target = Math.max(REEF_V - a * k, REEF_KEEP - 2 * COAST_AMP * k, REEF_KEEP);
  out.cells.push(c);
  out.landDelta.push(Math.max(0, target - causes.landness[c]));
  out.upliftDelta.push(0);
  out.erodDelta.push(ISLAND_ERODIBILITY.reef! - causes.erod[c]);
  out.footprint = footprintOf(world, out);
  return out;
}

// 太小、一格陆地都放不出来时（大小不到 1.5 格才会发生），把岛心那一格抬成陆地
export function islandStamp(world: World, spec: IslandSpec): StampResult {
  if (spec.kind === 'reef') return reefStamp(world, spec);
  const { mesh, causes } = world;
  const R = spec.size / SHORE[spec.kind] / world.kmPerUnit;
  const rough = world.small.terrain.coastRoughness;
  // 形状只取决于种类与 variant：噪声按“相对岛心、以半径为单位”的坐标取，所以换位置不变形、改大小是等比例缩放
  const sphere = mesh.kind === 'sphere' ? mesh : null;
  const kindIdx = ISLAND_KINDS.indexOf(spec.kind);
  const seed = mixSeed(coastSeed(world), 778, spec.variant, kindIdx);
  const shape = gradientNoise(seed);
  const rand = mulberry32(seed);
  // 大陆岛拉长、旋转；火山岛接近圆形
  const elong = spec.kind === 'continental' ? 1 + 0.8 * rand() : spec.kind === 'low' ? 1.3 + 0.9 * rand() : 1 + 0.15 * rand();
  const ang = rand() * Math.PI;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const irregular = spec.kind === 'continental' ? 0.45 : spec.kind === 'low' ? 0.25 : 0.18;
  const core = COAST_AMP * Math.max(rough, 0.2) + 60;
  const out: StampResult = { cells: [], landDelta: [], upliftDelta: [], erodDelta: [], footprint: [] };
  // 珊瑚岛的环与潟湖里的海格（岛心半径的 0.96 倍以内）：岩性按珊瑚砂（潟湖的海底画成浅水）
  const coral: boolean[] = [];
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
    const dd = d * (1 + irregular * fbm(shape, dx / R, dy / R, 1.6, 3));
    let target: number;
    let lift = 0;
    if (spec.kind === 'atoll') {
      // 环礁：一圈陆地，中间潟湖，外侧很快变深。潟湖的海岸值是 −core（海岸噪声怎么调都还是海），
      // 深浅由海底的后处理定（浅浅的十几到几十米，见 elevation.ts 的 lagoonFloor）
      const ring = Math.abs(dd - 0.8);
      target = ring < 0.16 ? core * 0.6 : dd < 0.8 ? -core : -core * 2;
    } else {
      target = dd < 1 ? core + (1 - dd) * (spec.kind === 'low' ? 40 : 400) : core - (dd - 1) * 3 * core;
      // 火山岛（第十三轮）：硬的玄武岩（可蚀性 0.45，约为平常的一半）蚀得慢，抬升减半后与原来一样高；
      // 山顶有个火山口（抬升凹下去一点，山顶平缓）
      if (spec.kind === 'volcanic') lift = Math.max(0, 0.5 * Math.pow(Math.max(0, 1 - dd), 1.4) - 0.2 * Math.exp(-(dd / 0.12) * (dd / 0.12)));
      else if (spec.kind === 'continental')
        lift = 0.25 * Math.max(0, 1 - dd) * (0.6 + 0.4 * fbm(shape, dx / R + 1, dy / R, 3, 3));
    }
    const L = causes.landness[i];
    let delta = 0;
    // 潟湖两头都改：深海抬到 −core，原来的浅滩、陆地压到 −core
    if (spec.kind === 'atoll' && dd < 0.8 - 0.16) delta = target - L;
    else delta = Math.max(0, target - L);
    const reefy = spec.kind === 'atoll' && dd < 0.96;
    if (delta === 0 && lift === 0 && !reefy) continue;
    out.cells.push(i);
    out.landDelta.push(delta);
    out.upliftDelta.push(lift);
    coral.push(reefy);
  }
  out.footprint = footprintOf(world, out);
  // 太小、一格陆地都没放出来：岛心那一格抬到岛的内圈高度（海岸值至少约 60 m）。
  // 岛心在地图外（岛链画出了地图边）时没有“岛心那一格”，不补：否则地图边上会多出一格一格的小岛
  const cellKm = mesh.spacing * world.kmPerUnit;
  const onMap = sphere !== null || (spec.x >= 0 && spec.x <= mesh.width && spec.y >= 0 && spec.y <= mesh.height);
  if (onMap && !out.footprint.length && spec.size < cellKm * 1.5) {
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
        coral.splice(at, 0, false);
      }
      out.footprint = footprintOf(world, out);
    }
  }
  // 岩性：新长出的陆地（原来就是陆地的不动）、珊瑚岛的潟湖与环上的海格设成这种岛的可蚀性
  const erod = ISLAND_ERODIBILITY[spec.kind];
  const fresh = new Set(out.footprint);
  // 潟湖的海格要被环围住：挨着的格里至少六成是陆地（放岛以后）或别的潟湖格；环太小、开口太大时这一格还是深海
  // （一格大的珊瑚岛在格里画潟湖，见 colors.ts 的 lithLayer）
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
  out.erodDelta = out.cells.map((i) => (erod === null || causes.land[i] || !(fresh.has(i) || lagoon.has(i)) ? 0 : erod - causes.erod[i]));
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
  kind: z.enum(CHAIN_KINDS).default('volcanic'),
  size: islandSizeSchema,
  // 0.5 稀疏，1 正常，2 密集
  density: z.number().min(0.2).max(3).default(1),
  variant: z.number().int().min(0).default(0),
});
export type ChainSpec = z.output<typeof chainSchema>;

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
// 缩到比最小的岛还小、或岛心就在陆地上时不放这个岛
const CHAIN_REACH = 1.6;
function avoidLand(world: World, islands: IslandSpec[], minKm: number): IslandSpec[] {
  const { mesh, causes, kmPerUnit } = world;
  const cellKm = mesh.spacing * kmPerUnit;
  const out: IslandSpec[] = [];
  for (const spec of islands) {
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

// 岛链：沿折线放一串岛，大小按幂律（少数大岛、许多小岛），左右略有错落；排列按 variant 换（见 chainLayout）
export function chainIslands(world: World, spec: ChainSpec): IslandSpec[] {
  const minKm = chainMinKm(world);
  const raw = (s: ChainSpec, scale: number) => avoidLand(world, (world.mesh.kind === 'sphere' ? chainIslandsSphere : chainIslandsFlat)(world, s, scale), minKm);
  const islands = raw(spec, 1);
  if (spec.variant <= 0) return islands;
  // 按面积之和缩放之后，小岛成陆的格数不与面积成比例、有的岛不放（离原有的陆地太近）：再按实际新长出的陆格数与第 0 种比一次，
  // 差得多（±15% 以外）时整条链再缩放一次
  const gained = (list: IslandSpec[]) => {
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
    out.push({ x: x0 + (x1 - x0) * t + nx * off, y: y0 + (y1 - y0) * t + ny * off, kind: spec.kind, size: slots[k].size, variant });
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
    out.push({ x, y, kind: spec.kind, size: slots[k].size, variant: 1_000_000 + spec.variant * 1000 + k });
  }
  return out;
}


// 多个岛依次叠加（后一个看见前一个的结果，海岸值与岩性都是），返回合并后的增量
export function combineStamps(world: World, specs: IslandSpec[]): StampResult {
  const { causes } = world;
  const saved = new Map<number, [number, number]>();
  const acc = new Map<number, { land: number; lift: number; erod: number }>();
  for (const spec of specs) {
    const r = islandStamp(world, spec);
    r.cells.forEach((i, k) => {
      if (!saved.has(i)) saved.set(i, [causes.landness[i], causes.erod[i]]);
      causes.landness[i] += r.landDelta[k];
      causes.erod[i] += r.erodDelta[k];
      const a = acc.get(i) ?? { land: 0, lift: 0, erod: 0 };
      a.land += r.landDelta[k];
      a.lift += r.upliftDelta[k];
      a.erod += r.erodDelta[k];
      acc.set(i, a);
    });
  }
  for (const [i, [l, e]] of saved) {
    causes.landness[i] = l;
    causes.erod[i] = e;
  }
  const out: StampResult = { cells: [], landDelta: [], upliftDelta: [], erodDelta: [], footprint: [] };
  for (const [i, a] of acc) {
    out.cells.push(i);
    out.landDelta.push(a.land);
    out.upliftDelta.push(a.lift);
    out.erodDelta.push(a.erod);
  }
  out.footprint = footprintOf(world, out);
  return out;
}

// 堆山 / 压低：抬升的增量，中心最大，平滑衰减到边缘
export function reliefStroke(cells: number[], t: number[], strength: number): { cells: number[]; delta: number[] } {
  return { cells, delta: t.map((v) => strength * (1 - v * v) * (1 - v * v)) };
}
