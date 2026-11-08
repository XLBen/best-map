import { type BaseComponents, type GenModel, type Reroll, buildModel, coneFields, emptyBaseComponents, resolvedParams, sampleComponentRange, sampleComponents, withParams } from './generate';
import { type PlanetModel, buildPlanetModel, planetConeFields, resolvedPlanetParams, samplePlanetComponents, samplePlanetRange, withPlanetParams } from './planet-gen';
import { formDigest, hasFormScripts } from './planet-form';
import { type ScriptIssue, scriptsEnabled } from './script';
import { type Mesh, type SphereMesh } from './mesh';
import { clamp } from './rng';
import { coastValueAt } from './subcell';
import type { World } from './world';
import { COAST_AMP, coastSeed, coastNoiseField, isLandValue, lagoonTest, fillSeaPockets } from './terrain-coast';
export { COAST_AMP, coastSeed, coastNoiseField, POCKET_MAX, lagoonTest, fillSeaPockets, POCKET_LAKE_MIN, pocketLakes } from './terrain-coast';
export { strokeProfile, landStroke, restoreKeep, restoredLandDelta, restoreStroke, landPatch, previewLand, crackBlockSize, crackAt, crackHalfWidth, crackSeed, fragmentStroke, restoredFragment, brushCore, fragmentAfter, reliefStroke } from './terrain-brush';
export type { StrokeResult, LandPatch, FragMode, FragResult } from './terrain-brush';
export { checkIslandKind, islandTypeName, roundKm, islandSchema, islandSizeRangeKm, sizeText, mapScaleKm, brushRangeKm, lakeRangeKm, reachRangeKm, defaultIslandKm, centerCell, reefLandDelta, islandGeometry, islandCellTarget, islandCore, islandRadiusOf, islandStamp, footprintOf, fragStamp } from './islands';
export type { IslandSpec, StampResult, IslandGeometry, LakeView, LakeSource } from './islands';
export { lakeIslandStamp, placeIsland, chainSchema, chainFragAt, CHAIN_STYLES, chainStyle, chainIslands, combineStamps } from './island-chains';
export type { ChainSpec, ChainStyle } from './island-chains';

// 地形“原因”的组合：
//   landness = 生成的地壳高度 − 海平面 + 用户编辑（landDelta）
//   陆地 = landness + 海岸噪声 × 破碎度 > 0
// 海岸噪声是固定的（只取决于种子与位置），画笔、放岛、渲染、导出都用它，所以预览与结果一致。

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
  landness: Float32Array;
  uplift: Float32Array;
  erod: Float32Array;
  // 基准面（第三十二轮）：T + “山多高” × Tp（米），见 reliefFields
  T: Float32Array;
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
// 计时（tools/bench.ts 用，累加的毫秒）：生成器采样（新建、重画一片、缓存没有时重新采样）
export const terrainLaps = { sample: 0 };
// 海平面分位数要用的排序，按不含重画的地壳高度（分量的 seaB0，同一个模型的各份分量共用一个数组）缓存：
// 重画一片、撤销、重做都不再重排（第三十二轮：重画一片不挪海平面）。留两份，最近用的在前：
// 拖“海岸破碎度”时世界本身（旧值）与预览（新值）交替要用
const seaOrders = new WeakMap<Float32Array, SeaOrder[]>();

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
    const ts = performance.now();
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
      landness: new Float32Array(n),
      uplift: new Float32Array(n),
      erod: new Float32Array(n),
      T: new Float32Array(n),
      seaLevel: 0,
    };
    baseCache.set(world, cache);
    terrainLaps.sample += performance.now() - ts;
  }
  const comp = cache.components;
  if (!gen || !comp || !cache.model) {
    cache.landness.fill(-3000);
    cache.uplift.fill(0);
    cache.erod.fill(1);
    cache.T.fill(0);
    cache.seaLevel = 0;
    return cache;
  }
  cache.seaLevel = composeBase(world, cache, composeParams(world, cache, {}), cache.landness, cache.uplift, cache.T);
  cache.erod.set(comp.erod);
  return cache;
}

// 空闲预热（第三十一轮，Worker 打开世界后空闲时，见 engine.ts 的 warmSteps）：分段把生成器的采样放进按网格的缓存
// （sampledCache），再让这个世界的缓存命中它（ensureBase），连同海岸噪声、海底的场。之后的第一笔不用再采样整个地图。
// 分段采的分量与一次采完逐值相同（generate.ts 的 sampleComponentRange、planet-gen.ts 的 samplePlanetRange），
// 放进缓存的与 ensureBase 自己采样后放进去的是同一份东西，所以结果不变。cells：每段多少格
export function* warmTerrainSteps(world: World, cells = 8000): Generator<void> {
  const { mesh } = world;
  const gen = world.small.terrain.gen;
  // 星球形态带脚本（布局、地形）时不预热：脚本只在用户的操作里跑（看门狗、“正在运行脚本”的提示都按操作来），留给第一笔
  if (hasFormScripts(gen?.form) && scriptsEnabled()) return;
  const { sampleKey, shapeKey } = baseKeys(world);
  if (gen && sampledBaseMemo.on && baseCache.get(world)?.key !== sampleKey && !sampledCache.get(mesh)?.some((s) => s.key === sampleKey)) {
    const model = mesh.kind === 'sphere' ? buildPlanetModel(gen) : buildModel(gen, mesh.width, mesh.height);
    yield;
    const components: BaseComponents = emptyBaseComponents(mesh.n);
    for (let from = 0; from < mesh.n; from += cells) {
      const to = Math.min(mesh.n, from + cells);
      if (model.kind === 'planet') {
        // 有地形脚本时（上面已经不预热了；安全模式下脚本不运行，照常分段）
        if (!samplePlanetRange(model, mesh as SphereMesh, components, from, to)) return;
      } else sampleComponentRange(model, mesh, components, from, to);
      yield;
    }
    // 别的世界、预览在这期间放进了同一个键（不会，Worker 收到请求就停下预热；保险起见）就不再放
    if (!sampledCache.get(mesh)?.some((s) => s.key === sampleKey)) {
      const list = sampledCache.get(mesh) ?? [];
      sampledCache.set(mesh, [{ key: sampleKey, shapeKey, model, components, cones: new Map() }, ...list].slice(0, 2));
    }
  }
  // 海底的场（顺带让这个世界的缓存命中上面的采样：seabedFields 先 ensureBase）、海岸噪声
  seabedFields(world);
  coastNoiseField(mesh, coastSeed(world));
  yield;
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

// 大格局（第三十二轮，见 relief.ts）：每格的基准面 T（米，含“山多高”× 高原）与洼地 pit（米）。高程的求解用（elevation.ts）。
// 没有生成器（空白世界）时为 null：没有基准面与洼地。只读
export function reliefFields(world: World): { T: Float32Array; pit: Float32Array } | null {
  const cache = ensureBase(world);
  if (!world.small.terrain.gen || !cache.components || !cache.model) return null;
  return { T: cache.T, pit: cache.components.pit };
}

// 生成器的分量（只读）：先找这个世界的缓存，再找按网格缓存的采样（同一个键），都没有时才 ensureBase（第三十四轮，海岸类型用：
// 画面上每算一次海岸场都要问一次，世界的浅副本也问，不能每次都重新组合）。没有生成器时为 null
export function baseComponentsOf(world: World): BaseComponents | null {
  if (!world.small.terrain.gen) return null;
  const key = baseKeys(world).sampleKey;
  const cache = baseCache.get(world);
  if (cache && cache.key === key) return cache.components;
  const s = sampledCache.get(world.mesh)?.find((e) => e.key === key);
  if (s) return s.components;
  return ensureBase(world).components;
}

// 洼地（米）：只读缓存里这个世界的分量（水文用，不重新组合；缓存不是这个世界的就先 ensureBase）。没有生成器时为 null
export function pitField(world: World): Float32Array | null {
  if (!world.small.terrain.gen) return null;
  const cache = baseCache.get(world);
  if (cache && cache.key === baseKeys(world).sampleKey) return cache.components?.pit ?? null;
  return ensureBase(world).components?.pit ?? null;
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

// 海平面：按面积加权的分位数，只看地壳本身（不含造山带与火山锥），所以“岛多少”“山多高”不会挪动别处的海岸。
// 第三十二轮起按不含重画的地壳高度（seaB0）：重画一片不挪海平面，圈外的海岸、陆地一格不变（只重算圈里碰到的陆块）
function seaLevelFor(world: World, cache: BaseCache, landFraction: number, rough: number): number {
  const { mesh } = world;
  const n = mesh.n;
  const comp = cache.components!;
  let list = seaOrders.get(comp.seaB0) ?? [];
  let s = list.find((e) => e.rough === rough);
  if (!s) {
    const coast = coastNoiseField(mesh, world.small.terrain.gen!.seed);
    const eff = new Float64Array(n);
    let max = -Infinity;
    for (let i = 0; i < n; i++) {
      eff[i] = comp.seaB0[i] + COAST_AMP * rough * coast[i];
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
  if (list[0] !== s) {
    list = [s, ...list.filter((e) => e !== s)].slice(0, 2);
    seaOrders.set(comp.seaB0, list);
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

// 山带的抬升集中到中间（第八十六轮）：造山带的抬升 m 换成 m²(1 + BELT_M0) / (m + BELT_M0)：m = 1 不变，
// 山带两侧的缓坡（m 约 0.1–0.4）低一半左右，高地集中在山带的中间，不再是一大片高的山前。只换抬升，地壳高度（陆海）不变
export const BELT = { M0: 0.4 };
// 测试退回第八十五轮时 BELT.M0 = 0：原样返回 m
export function beltCore(m: number): number {
  if (BELT.M0 === 0) return m;
  return m <= 0 ? 0 : (m * m * (1 + BELT.M0)) / (m + BELT.M0);
}

// 按参数组合基础的 landness 与抬升（写进 outL / outU，返回海平面）。生成世界与“调整”的预览共用
function composeBase(world: World, cache: BaseCache, p: ComposeParams, outL: Float32Array, outU: Float32Array, outT?: Float32Array): number {
  const comp = cache.components!;
  const model = cache.model!;
  // 星球形态的布局脚本加的岛排在最前，总是露出来；“岛多少”只增减其余的火山锥（没有形态时 fixed 为 0，与以前相同）
  const fixed = model.kind === 'planet' ? model.fixedCones : 0;
  const coneCount = fixed + Math.round(p.islands * (model.cones.length - fixed));
  const { coneB, coneU } = conesFor(world, cache, coneCount);
  const seaLevel = seaLevelFor(world, cache, p.landFraction, p.rough);
  const mountains = p.mountains;
  composeCells(world.mesh.n, comp.b0, comp.mountB, comp.mountU, comp.hillU, coneB, coneU, seaLevel, mountains, BELT.M0, outL, outU);
  // 基准面：“山多高”只缩放高原
  if (outT) for (let i = 0; i < world.mesh.n; i++) outT[i] = comp.T[i] + mountains * comp.Tp[i];
  return seaLevel;
}

// 第八十八轮（提速）：composeBase 逐格的那一段放进模块里的小函数，beltCore 的算式写在循环里（M0 取一次；与调用 beltCore 逐值相同）
function composeCells(n: number, b0: Float32Array, mountB: Float32Array, mountU: Float32Array, hillU: Float32Array, coneB: Float32Array, coneU: Float32Array, seaLevel: number, mountains: number, M0: number, outL: Float32Array, outU: Float32Array): void {
  for (let i = 0; i < n; i++) {
    outL[i] = b0[i] - seaLevel + mountains * mountB[i] + coneB[i];
    const m = mountU[i];
    const belt = M0 === 0 ? m : m <= 0 ? 0 : (m * m * (1 + M0)) / (m + M0);
    outU[i] = clamp(mountains * (0.95 * belt + hillU[i]) + coneU[i], 0, 1.6);
  }
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
  fillSeaPockets(mesh, causes.land, lagoonTest(world));
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
    // 与 ensureBase 里重画变了时同一条路：模型换参数、只重算新的重画圈、火山锥照用、海平面不变。
    // 用一份临时的缓存，世界的缓存不动
    const r = patch.reroll;
    const next = { ...gen, rerolls: [...gen.rerolls, { x: r.x, y: r.y, radius: r.radius, variant: r.variant }] };
    const model = cache.model.kind === 'planet' ? withPlanetParams(cache.model, next) : withParams(cache.model, next);
    const re = { from: cache.components, changed: [r] };
    const components = model.kind === 'planet' ? samplePlanetComponents(model, mesh as SphereMesh, re) : sampleComponents(model, mesh, re);
    cache = { ...cache, model, components };
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
  fillSeaPockets(mesh, land, lagoonTest(world));
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
