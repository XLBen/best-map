// 按标记重算推导的流水线（第八十三轮从 core/engine.ts 的 Engine.recompute 原样搬出，this 换成 e）：
//   高程 → 气候（基础）→ [约束求解 → 修正场] → 水文 → 植被 → 人文 → 地物；每算完一个阶段停一下（yield）
import { type ClimateEffects, computeClimate, finalizeClimate } from './climate';
import { Dirty } from './commands';
import { checkConstraints, type SolveResult, solveConstraints } from './constraints';
import { computeClimateSphere, prepareClimateSphere } from './planet-climate';
import { carveBeds, computeElevation, glacialTerrain, rememberCoast, userLakeMask } from './elevation';
import { iceStrength, sameIce } from './glacial';
import { glacialLegacy } from './glacial-legacy';
import { assignNames, detectFeatures, guideFeatures, prepareFeatures, regionFeatures } from './features';
import { computeEffects } from './effects';
import { computeHydrology, shapeLakeBeds } from './hydrology';
import { typeLakes } from './lake-types';
import { stopCells, typeRivers } from './river-types';
import { waterPlan } from './water-types';
import { worldSeedOf } from './biome-scripts';
import { baseBiomes, computeVegetation, finishLook } from './vegetation';
import { newScriptPass } from './biome-scripts';
import { computeHuman } from './human';
import { type Derived, type World, emptyDerived } from './world';
import type { Timings, EngineBase } from './engine-types';
import { privatize } from './engine-helpers';

// 统计（测试用）：一共算了多少遍“气候 → 水文 → 河的类型 → 植被”
export const passStats = { passes: 0 };

// 流水线读写的引擎状态（Engine 的同名字段；私有的几项由 Engine.recompute 转交）
export interface RecomputeState {
  world: World;
  base: EngineBase | null;
  solve: SolveResult;
  dirty: Dirty;
  recomputed: Dirty;
  sharedDerived: boolean;
  features: boolean;
  lastTimings: Timings;
}

export function* recomputeDerived(e: RecomputeState): Generator<void, Derived> {
  e.recomputed = Math.max(e.recomputed, e.dirty) as Dirty;
  const w = e.world;
  // 推导里的数组可能与撤销缓存共用：先各复制一份再就地重算（地物、冲突列表照旧共用：之后整个换上新的）
  if (e.sharedDerived && e.dirty > Dirty.Human) {
    privatize(w.derived);
    e.sharedDerived = false;
  }
  const d = w.derived;
  if (e.dirty === Dirty.Names || e.dirty === Dirty.Human) {
    // 只画了地形类别、资源（第二十一轮）：自然的推导不动，人文的几层换上新算的数组（不就地改，可以与撤销缓存共用）。
    // 同一步里可能还改了名字（批量），所以照样重新起名
    if (e.dirty === Dirty.Human) {
      const t0 = performance.now();
      computeHuman(w, d, false);
      e.lastTimings = { ...e.lastTimings, human: performance.now() - t0 };
    }
    // 只改了名字、用户的区块或画的河的折线：自动识别的地物不变，换上新的区块、画的河再重新起名。
    // （画的河有没有名字、占了哪些格变了的时候不走这里，所以哪些自然的河不单独标也不变。）
    // 地物对象可能和副本（Engine.clone、撤销缓存）共用，起名会改它们的名字，所以先各复制一份
    const terrain = e.base?.terrain;
    d.features = [...d.features.filter((f) => !f.region && !f.guide).map((f) => ({ ...f })), ...regionFeatures(w, d, terrain), ...guideFeatures(w, d, terrain)];
    assignNames(w, d.features);
    e.dirty = Dirty.None;
    return d;
  }
  const t0 = performance.now();
  const timings: Timings = { total: 0 };
  let t = t0;
  const lap = (k: keyof Timings) => {
    const now = performance.now();
    timings[k] = now - t;
    t = now;
  };
  let terrain = e.base?.terrain;
  let climate = e.dirty >= Dirty.Climate;
  if (e.dirty >= Dirty.Elevation || !terrain) {
    // 总是从固定初值求解：推导只取决于原因，与编辑历史无关，重放与撤销都逐值一致
    const el = computeElevation(w);
    terrain = el.elevation;
    rememberCoast(terrain, el.coastKm);
    climate = true;
    lap('elevation');
    yield;
  }
  if (climate || !e.base) {
    // 整个星球：只取决于纬度、海陆的两层先算（改了海陆时这一段很长），算完让出一次（预览可以在这里停下）
    if (w.mesh.kind === 'sphere') {
      const a = performance.now();
      if (prepareClimateSphere(w, terrain)) {
        const spent = performance.now() - a;
        yield;
        t = performance.now() - spent;
      }
    }
    // 整个星球用球面版本（没有地图边，风带绕星球一圈）。按没挖河床的地形算：画河不改变气候
    const base = w.mesh.kind === 'sphere' ? computeClimateSphere(w, terrain, d) : computeClimate(w, terrain, d);
    e.base = { ...base, terrain };
    // 冰盖（第八十六轮）：按现在的纬度、冷暖笔刷、太阳（core/glacial.ts）。没变时还是原来的数组
    const ice = iceStrength(w, glacialLegacy.on);
    if (!sameIce(ice, d.ice)) d.ice = ice;
    lap('climate');
    yield;
  }
  // 推导里的高程 = 地形挖出冰川的小洼（第八十六轮）、再挖出只挖河床的河。每次都从地形重新挖，结果只取决于原因；
  // 气候按没挖冰川的地形算（冷暖笔刷改冰川时不用重算气候的地形那一层）
  d.elevation.set(glacialLegacy.on ? terrain : glacialTerrain(w, terrain, d.ice));
  carveBeds(w, d.elevation);
  if (d.share.length !== w.mesh.n * w.small.species.length) {
    const fresh = emptyDerived(w.mesh.n, w.small.species.length);
    d.share = fresh.share;
    d.suit = fresh.suit;
    d.reach = fresh.reach;
  }
  // 一遍：气候（加上修正场、对周围的影响）→ 水文 → 河的类型 → 植被
  const base = e.base;
  const seed = worldSeedOf(w);
  const water = waterPlan(w.small);
  // 第一遍不计水体类型的生态（water.reuseFirstBase 的世界，后面几遍的类型读它）
  let firstBase: Int16Array | null = null;
  const pass = (eff: ClimateEffects | null) => {
    passStats.passes++;
    finalizeClimate(w, base, d, eff);
    computeHydrology(w, d.elevation, d);
    // 断流（第五十六轮）：按这一遍的水和不计水体类型的生态定下哪些格断流，再算一遍水（汇流有缓存，高程、流向不变）。
    // 单向的，不迭代：结果只取决于原因，撤销、重放都一样。不用断流的世界不走这里
    let bio: Int16Array | null = null;
    // 这一遍的编号：脚本的两遍读到的输入相同，比较快照的结果复用（biome-scripts.ts）。水变了换一个
    let scriptPass = newScriptPass();
    if (water.stops) {
      bio = baseBiomes(w, d, true, !!eff, scriptPass);
      const cut = stopCells(w, d, seed, bio);
      if (cut) {
        computeHydrology(w, d.elevation, d, cut);
        bio = null;
        scriptPass = newScriptPass();
      }
    }
    // 河流类型（第三批）、湖泊类型（第九轮）：没有时什么都不做；match 脚本出的问题交给植被一起记下
    const typeWater = (biomes: Int16Array | null) => {
      const issues = typeRivers(w, d, seed, biomes);
      const lakeIssues = typeLakes(w, d, seed, biomes);
      return lakeIssues.length ? [...issues, ...lakeIssues] : issues;
    };
    // 颜色脚本只在全部几遍算完之后算一次（finishLook）：每一遍都整个重算 d.look，前几遍的没人用
    // 第十二轮：类型要读生态时按不计水体类型的一遍植被。第五十六轮（提速）：生态不读河岸、湖岸时那一遍和真的植被逐值相同，
    // 只算一遍，算完再定类型（core/water-rules.test.ts 查着逐位相同）
    if (water.biomes && !water.baseFirst) computeVegetation(w, d, [], { look: false, after: () => typeWater(d.dominant), effect: !!eff, pass: scriptPass });
    else {
      if (water.biomes) {
        bio ??= (water.reuseFirstBase ? firstBase : null) ?? baseBiomes(w, d, true, !!eff, scriptPass);
        if (water.reuseFirstBase) firstBase = bio;
      }
      computeVegetation(w, d, typeWater(bio), { look: false, effect: !!eff, pass: scriptPass });
    }
  };
  // 先在无修正的气候上算一遍水文与植被，得到求解器需要的湿度、可达性
  d.corrT.fill(0);
  d.corrP.fill(0);
  for (const k of Object.keys(d.corrF)) delete d.corrF[k];
  pass(null);
  lap('hydrology');
  yield;
  // 生态、河对周围的影响（第三批）：按第一遍的结果算一次，之后的求解和最后一遍都在加了影响的气候上算
  // （没有这种影响时为 null，下面照原来的样子）
  const eff = computeEffects(w, d);
  e.solve = { plans: [] };
  if (w.small.constraints.some((c) => c.mode === 'constraint')) {
    // 水文随修正场变化会影响湿地等类型，最多再迭代一轮
    for (let round = 0; round < 2; round++) {
      e.solve = solveConstraints(w, base, d, eff);
      pass(eff);
      yield;
      const failing = e.solve.plans.some((p) => p.anchors.some((k) => d.dominant[p.cells[k]] !== p.target));
      if (!failing) break;
    }
    lap('solve');
  } else if (eff) {
    pass(eff);
    yield;
  }
  // 颜色脚本在修湖底之前算（第十三轮修）：与长在哪里的脚本读到同一份高程，脚本按格记住的结果不会因为湖底每次整段重算
  finishLook(w, d);
  // 自然湖的湖底按离岸距离修深（只改湖格的 d.elevation；水文、植被已经算完，见 hydrology.ts 的 shapeLakeBeds）
  shapeLakeBeds(w, d, w.small.lakes.length ? userLakeMask(w) : null);
  d.conflicts = checkConstraints(w, d, e.solve);
  lap('vegetation');
  // 人文的几层（第二十一轮）：按自然的推导算。第二十二轮挪到认地物之前：地名跟着当地的文化，起名要看人口的几层
  computeHuman(w, d);
  lap('human');
  // 只取决于海陆的那一段地物先认（改了海陆时这一段很长），认完让出一次
  if (e.features) {
    const a = performance.now();
    if (prepareFeatures(w)) {
      const spent = performance.now() - a;
      yield;
      t = performance.now() - spent;
    }
  }
  // 山脉、山峰、盆地按没挖河床的地形认：峡谷不会让山改名
  if (e.features) d.features = detectFeatures(w, d, terrain);
  lap('features');
  timings.total = performance.now() - t0;
  e.lastTimings = timings;
  e.dirty = Dirty.None;
  return d;
}
