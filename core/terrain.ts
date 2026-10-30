import { z } from 'zod';
import { type BaseComponents, type GenModel, type Reroll, buildModel, coneFields, emptyBaseComponents, resolvedParams, sampleComponentRange, sampleComponents, withParams } from './generate';
import { type V3, arc, fromUnit, localOffset, slerp, toUnit, wrapX } from './geo';
import { LAYOUT_R, type PlanetModel, buildPlanetModel, planetConeFields, resolvedPlanetParams, samplePlanetComponents, samplePlanetRange, withPlanetParams } from './planet-gen';
import { formDigest, hasFormScripts } from './planet-form';
import { type ScriptIssue, scriptsEnabled } from './script';
import { type Mesh, type SphereMesh, findCell } from './mesh';
import { type Noise2, clamp, fbm, fbm3, gradientNoise, gradientNoise3, mixSeed, mulberry32, smoothstep } from './rng';
import { nearestCell } from './sphere';
import { coastValueAt } from './subcell';
import { CommandError } from './errors';
import { DEFAULT_ISLAND_TYPE, type IslandShape, type IslandType, LAGOON_BIT, SHARDS_ISLAND_TYPE, islandCode, islandTypeById } from './island-types';
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
const coastCache = new WeakMap<Mesh, Map<number, Float32Array>>();
// 海平面分位数要用的排序，按不含重画的地壳高度（分量的 seaB0，同一个模型的各份分量共用一个数组）缓存：
// 重画一片、撤销、重做都不再重排（第三十二轮：重画一片不挪海平面）。留两份，最近用的在前：
// 拖“海岸破碎度”时世界本身（旧值）与预览（新值）交替要用
const seaOrders = new WeakMap<Float32Array, SeaOrder[]>();

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
  for (let i = 0; i < world.mesh.n; i++) {
    outL[i] = comp.b0[i] - seaLevel + mountains * comp.mountB[i] + coneB[i];
    outU[i] = clamp(mountains * (0.95 * comp.mountU[i] + comp.hillU[i]) + coneU[i], 0, 1.6);
  }
  // 基准面：“山多高”只缩放高原
  if (outT) for (let i = 0; i < world.mesh.n; i++) outT[i] = comp.T[i] + mountains * comp.Tp[i];
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
  fillSeaPockets(mesh, causes.land, lagoonTest(world));
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
function seaPocket(mesh: Mesh, isSea: (i: number) => boolean, isLagoon: (i: number) => boolean, start: number): number[] | null {
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
// 与以前逐格找、找到的块标上不再找逐值相同（并回陆地的格一样）。导出给测试（r32-speed）
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

// 应用 landness 增量后的陆海掩码（只算受影响的格），与 resolveTerrain 用同一规则（含小块海的填补，见 fillSeaPockets），
// 所以预览与结果逐格一致。after：受影响的格在改动后是不是陆地。typeAfter：放岛时记上岛的种类的格改后的种类（潟湖按它认）
function landAfter(world: World, cells: number[], delta: number[], typeAfter?: ReadonlyMap<number, number>): Map<number, boolean> {
  const { mesh, causes } = world;
  const coast = coastNoiseField(mesh, coastSeed(world));
  const rough = world.small.terrain.coastRoughness;
  const d = new Map<number, number>();
  cells.forEach((i, k) => d.set(i, (d.get(i) ?? 0) + delta[k]));
  const raw = (i: number) => isLandValue(causes.landness[i] + (d.get(i) ?? 0), coast[i], rough);
  const isSea = (i: number) => !raw(i);
  const isLagoon = lagoonTest(world, typeAfter);
  // 小块海的填补看邻居，所以改动格的邻居也可能变
  const touched = new Set<number>();
  // 有格从陆地变成海时，原来填掉的小块海可能连上了大海（又是海了）
  let opened = false;
  for (const i of d.keys()) {
    touched.add(i);
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) touched.add(mesh.adj[e]);
    if (!raw(i) && isLandValue(causes.landness[i], coast[i], rough)) opened = true;
  }
  const after = new Map<number, boolean>();
  for (const i of [...touched].sort((a, b) => a - b)) {
    if (after.has(i)) continue;
    if (raw(i)) {
      after.set(i, true);
      continue;
    }
    const p = seaPocket(mesh, isSea, isLagoon, i);
    if (p) {
      for (const c of p) after.set(c, true);
      continue;
    }
    after.set(i, false);
    if (!opened) continue;
    // 这一块海不是小块：离它 POCKET_MAX 步以内、原来填成陆地的海格都在这一块里，变回海
    let ring = [i];
    const seen = new Set<number>(ring);
    for (let step = 0; step < POCKET_MAX && ring.length; step++) {
      const next: number[] = [];
      for (const c of ring) {
        for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
          const j = mesh.adj[e];
          if (seen.has(j) || !isSea(j)) continue;
          seen.add(j);
          next.push(j);
          if (causes.land[j] === 1 && !after.has(j)) after.set(j, false);
        }
      }
      ring = next;
    }
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

// 岛的种类在 island-types.ts（第十四轮：内置的大陆岛、低平岛、珊瑚岛、小礁，和用户自己的）。命令里记种类的 id；
// 放岛时按这种岛的形状、高低、岩石长出陆地，并在新长出的陆地（环礁还有潟湖的海格）上记下种类（causes.islandType）。
// 第十四轮去掉了火山岛（以后另做地标）

// 世界里一种岛都没有时放的普通的岛（第三十轮）：同大陆岛的说法，编号 0
const PLAIN_ISLAND: IslandType = { id: DEFAULT_ISLAND_TYPE, name: '岛', shape: 'rugged', height: 'hilly', province: 'land' };

// 这一种岛与它的编号：世界里没有岛的种类时是普通的岛；有、但没有这一种时报错
function typeOfSpec(world: World, kind: string): { t: IslandType; code: number } {
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
const islandSizeSchema = z.number().min(0.1).max(20000);
// 种类：内置的或自己的岛的 id（执行时查有没有这一种）
const islandKindSchema = z.string().min(1).max(64).default(DEFAULT_ISLAND_TYPE);

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
const ISLAND_MIN_CELLS = 0.4;

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

// ---------- 打碎（第十八轮） ----------
// 打碎笔刷（命令 fragment）。两种：
//   · 裂成碎块（blocks）：圈里的陆地按一张固定的裂缝图裂开——裂缝图是按世界种子、格的位置定的一张“碎玻璃”：
//     一层抖动过的格点（间距 = 碎块的大小）的 Voronoi，每一块是一个碎块，块与块之间的边是裂缝。离裂缝不到半宽的陆地格
//     变成海（真的海峡：landness 像画海一样压到海岸噪声怎么调都还是海，河、生态跟着变），块里的陆地不动；
//     碎块的大小随画笔（半径的 0.7 → 0.35 倍）与力度（越大越碎），至少 3.5 格；裂缝的半宽 0.6–0.95 格（力度越大越宽，
//     至少一格宽：挨着的两格不会隔着裂缝都是陆地），画笔外圈（七成半径以外）渐渐收窄、断开，碎块连回圈外的陆地。
//     裂开后孤零零的单格陆地也变成海（成了碎岛）。原来的陆地（碎块、裂缝）的破碎度同时抬高：碎块里一点点，
//     碎块的边上与裂缝里多一些（两岸支离破碎、水道里有几颗碎岛）；圈里原来的海不碰；
//   · 只打碎海岸（coast）：陆海都不动，只抬离海岸一两格以内的破碎度（力度大时两格）：海岸支离破碎，外面撒一圈碎岛。
//     离岸远的海、内陆不碰。
// 破碎度只抬不降；力度 0.1–1。结果只取决于世界的种子、格的位置与命令里的参数，重放逐值相同
export type FragMode = 'blocks' | 'coast';
export interface FragResult {
  // landness 的增量（裂开的格）
  cells: number[];
  delta: number[];
  // 将来的破碎度（0–255；只列变了的格）
  frag: { cells: number[]; value: number[] };
  // 裂开的格（变成海的陆地格，含孤零零的单格）
  cracked: number[];
}

// 画笔的外圈渐变（与画陆地的 0.7 倍半径一致）：中间 1，边上降到 0
const fragProfile = (t: number) => 1 - smoothstep(0.7, 1, t);

// 碎块的大小（地图单位）：radiusKm 是画笔半径
export function crackBlockSize(world: World, radiusKm: number, strength: number): number {
  const s = clamp(strength, 0, 1);
  return Math.max(3.5 * world.mesh.spacing, (radiusKm / world.kmPerUnit) * (0.7 - 0.35 * s));
}

// 裂缝图：格 i 离最近的裂缝（抖动格点的 Voronoi 的边）有多远（地图单位），与它在哪一块（最近的格点的哈希）。
// 平面按 (x, y)；整个星球在单位球面的三维位置上取格点（间距 B·π），所以没有接缝、两极也一样
export function crackAt(world: World, i: number, B: number, seed: number): { d: number; block: number } {
  const { mesh } = world;
  const sphere = mesh.kind === 'sphere';
  const g = sphere ? B * Math.PI : B;
  const px = sphere ? mesh.p[3 * i] : mesh.x[i];
  const py = sphere ? mesh.p[3 * i + 1] : mesh.y[i];
  const pz = sphere ? mesh.p[3 * i + 2] : 0;
  const gx = Math.floor(px / g);
  const gy = Math.floor(py / g);
  const gz = Math.floor(pz / g);
  const R = 2;
  const pts: number[] = [];
  const ids: number[] = [];
  for (let dz = sphere ? -R : 0; dz <= (sphere ? R : 0); dz++) {
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const ix = gx + dx;
        const iy = gy + dy;
        const iz = gz + dz;
        const h1 = mixSeed(seed, ix, iy, iz);
        const h2 = mixSeed(h1, 7);
        const h3 = mixSeed(h1, 11);
        pts.push((ix + 0.1 + (0.8 * (h1 & 0xffff)) / 65536) * g, (iy + 0.1 + (0.8 * (h2 & 0xffff)) / 65536) * g, sphere ? (iz + 0.1 + (0.8 * (h3 & 0xffff)) / 65536) * g : 0);
        ids.push(h1);
      }
    }
  }
  const m = ids.length;
  let best = 0;
  let bd = Infinity;
  for (let k = 0; k < m; k++) {
    const d = (pts[3 * k] - px) ** 2 + (pts[3 * k + 1] - py) ** 2 + (pts[3 * k + 2] - pz) ** 2;
    if (d < bd) {
      bd = d;
      best = k;
    }
  }
  // 到 Voronoi 的边的距离：对每个别的格点，到两点的垂直平分线（面）的距离，取最小
  let edge = Infinity;
  const ax = pts[3 * best];
  const ay = pts[3 * best + 1];
  const az = pts[3 * best + 2];
  for (let k = 0; k < m; k++) {
    if (k === best) continue;
    const ex = pts[3 * k] - ax;
    const ey = pts[3 * k + 1] - ay;
    const ez = pts[3 * k + 2] - az;
    const len = Math.sqrt(ex * ex + ey * ey + ez * ez);
    const dk = (pts[3 * k] - px) ** 2 + (pts[3 * k + 1] - py) ** 2 + (pts[3 * k + 2] - pz) ** 2;
    edge = Math.min(edge, (dk - bd) / (2 * len));
  }
  // 整个星球：三维的距离换回地图单位
  return { d: sphere ? edge / Math.PI : edge, block: ids[best] };
}

// 裂缝的半宽（地图单位）
export const crackHalfWidth = (world: World, strength: number) => world.mesh.spacing * (0.6 + 0.35 * clamp(strength, 0, 1));
// 裂缝图的种子（世界的海岸种子）
export const crackSeed = (world: World) => mixSeed(coastSeed(world), 1818);

export function fragmentStroke(world: World, cells: number[], t: number[], strength: number, mode: FragMode, radiusKm: number): FragResult {
  const { mesh, causes } = world;
  const s = clamp(strength, 0, 1);
  const out: FragResult = { cells: [], delta: [], frag: { cells: [], value: [] }, cracked: [] };
  const old = causes.fragment;
  const target = new Map<number, number>();
  const raise = (i: number, f: number) => {
    const v = Math.round(255 * clamp(f, 0, 1));
    if (v > (target.get(i) ?? (old ? old[i] : 0))) target.set(i, v);
  };
  if (mode === 'coast') {
    // 离海岸几步（陆海按 causes.land，湖面算陆地）：0 是挨着对岸的格
    const rings = s < 0.55 ? 1 : 2;
    const inBrush = new Map<number, number>();
    cells.forEach((i, k) => inBrush.set(i, t[k]));
    const step = new Map<number, number>();
    let front: number[] = [];
    for (const i of cells) {
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        if (causes.land[mesh.adj[e]] !== causes.land[i]) {
          step.set(i, 0);
          front.push(i);
          break;
        }
      }
    }
    for (let r = 1; r <= rings && front.length; r++) {
      const next: number[] = [];
      for (const c of front) {
        for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
          const j = mesh.adj[e];
          if (step.has(j) || !inBrush.has(j)) continue;
          step.set(j, r);
          next.push(j);
        }
      }
      front = next;
    }
    const fs = 0.3 + 0.6 * s;
    for (const [i, r] of step) raise(i, fs * (1 - r / (rings + 1)) * fragProfile(inBrush.get(i)!) * (causes.land[i] ? 0.8 : 1));
  } else {
    const B = crackBlockSize(world, radiusKm, s);
    const W = crackHalfWidth(world, s);
    const seed = crackSeed(world);
    const crack = new Set<number>();
    const tOf = new Map<number, number>();
    cells.forEach((i, k) => {
      tOf.set(i, t[k]);
      // 圈里原来的海不碰
      if (!causes.land[i]) return;
      const prof = t[k] <= 0.7 ? 1 : clamp((1 - t[k]) / 0.3, 0, 1);
      const c = crackAt(world, i, B, seed);
      if (c.d < W * prof) crack.add(i);
      // 破碎度：碎块的边上多一点，块里一点点（裂缝里的在下面）
      raise(i, (c.d < W + mesh.spacing ? 0.15 + 0.25 * s : 0.06 + 0.14 * s) * fragProfile(t[k]));
    });
    // 裂开之后孤零零的单格陆地（四周都是海或裂缝）也变成海：成了碎岛
    for (const i of cells) {
      if (!causes.land[i] || crack.has(i)) continue;
      let alone = true;
      for (let e = mesh.off[i]; e < mesh.off[i + 1] && alone; e++) {
        const j = mesh.adj[e];
        if (causes.land[j] && !crack.has(j)) alone = false;
      }
      if (alone) crack.add(i);
    }
    const m = COAST_AMP * Math.max(world.small.terrain.coastRoughness, 0.2) + 60;
    for (const i of [...crack].sort((a, b) => a - b)) {
      // 像画海一样：landness 压到 −m（海岸噪声怎么调都还是海）
      const d = Math.min(0, -m - causes.landness[i]);
      out.cracked.push(i);
      if (d !== 0) {
        out.cells.push(i);
        out.delta.push(d);
      }
      raise(i, (0.15 + 0.25 * s) * fragProfile(tOf.get(i)!));
    }
  }
  for (const [i, v] of [...target].sort((a, b) => a[0] - b[0])) {
    out.frag.cells.push(i);
    out.frag.value.push(v);
  }
  return out;
}

// 恢复原样（第十八轮）：破碎度按画笔权重退回（中间全收回，边上渐变），剩下不到 4（约 1.5%）的零头归零
export function restoredFragment(v: number, t: number): number {
  const r = Math.round(v * restoreKeep(t));
  return r < 4 ? 0 : r;
}

// 画笔中心七成半径以内的格（t ≤ 0.7：画陆地 / 海一定变成陆地、海，恢复原样完全恢复的那一圈）。
// 画陆地 / 海、恢复原样时这些格记着的岛的种类、破碎度清掉（见 commands.ts 的 applyTerrain）
export const brushCore = (cells: number[], t: number[]) => cells.filter((_, k) => t[k] <= 0.7);

// 画陆地 / 海（restore 为 false）、恢复原样之后这些格将来的破碎度（预览用；与命令同一个规则）：恢复原样先按画笔权重退回，
// 画笔中心（brushCore）、陆海变了的格（changed）清零。没打碎过、什么都不变时为 undefined
export function fragmentAfter(world: World, cells: number[], t: number[], changed: number[], restore: boolean): { cells: number[]; value: number[] } | undefined {
  const f = world.causes.fragment;
  if (!f) return undefined;
  const core = new Set(brushCore(cells, t));
  const out: number[] = [];
  const value: number[] = [];
  cells.forEach((i, k) => {
    const v = core.has(i) ? 0 : restore ? restoredFragment(f[i], t[k]) : f[i];
    if (v !== f[i]) {
      out.push(i);
      value.push(v);
    }
  });
  for (const i of changed) {
    if (f[i]) {
      out.push(i);
      value.push(0);
    }
  }
  return out.length ? { cells: out, value } : undefined;
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

const EMPTY_STAMP: StampResult = { cells: [], landDelta: [], upliftDelta: [], erodDelta: [], types: [], footprint: [] };

// 岛心在不在地图上（一块地区的地图边外没有岛心那一格）
function onMap(world: World, spec: { x: number; y: number }): boolean {
  const { mesh } = world;
  return mesh.kind === 'sphere' || (spec.x >= 0 && spec.x <= mesh.width && spec.y >= 0 && spec.y <= mesh.height);
}

// 同一个湖：从 c0 起连成一片的湖面格，水面与 c0 相差不到半米（内流湖的水面格之间最多差 0.5 m；挨着的两个湖一般差得多）
const SAME_LAKE_M = 0.51;
function lakeOf(world: World, c0: number, view: LakeView): number[] {
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

// 堆山 / 压低：抬升的增量，中心最大，平滑衰减到边缘
export function reliefStroke(cells: number[], t: number[], strength: number): { cells: number[]; delta: number[] } {
  return { cells, delta: t.map((v) => strength * (1 - v * v) * (1 - v * v)) };
}
