import type { Derived, World } from '../world';
import { findPeaks, peakList } from './peaks';
import { distributeResources, effectiveResources, worldResources } from './resources';
import { cellInputs } from './rules';
import { classifyTerrain, effectiveClasses, worldTerrainClasses } from './terrain-class';
import { computeHabitability } from './habitability';
import { computePopLayers } from './layers';
import { computeCountryLayer } from './country-layers';

// 人文的几层（第二十一轮）：只读自然的推导，不反向影响自然的部分。
// 引擎在自然的推导（植被之后、地物识别之后）算好后算一遍（natural）；只画地形类别、资源、改它们的内容时（Dirty.Human）
// 只算这一段，自然的推导没变：自动的类别、资源在规则没变时照用上一份（按数组记下当时的规则）。
// 每次都换上新的数组（不就地改）：撤销缓存、发给主线程的上一份照旧可以共用

// 自动的类别、资源是按什么算的（数组 → 规则的标识；资源另记当时生效的类别）
const classMemo = new WeakMap<Uint8Array, string>();
const resourceMemo = new WeakMap<Uint8Array, { key: string; cls: Uint8Array }>();

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function computeHuman(world: World, d: Derived, natural = true): void {
  const x = cellInputs(world, d);
  const classes = worldTerrainClasses(world.small);
  const species = JSON.stringify(world.small.species.map((sp) => [sp.id, sp.terrain]));
  const classKey = `${species}|${JSON.stringify(classes)}`;
  const reuse = !natural && classMemo.get(d.terrainClassAuto) === classKey;
  const auto = reuse ? d.terrainClassAuto : classifyTerrain(x, classes, world.small.species);
  if (!reuse) classMemo.set(auto, classKey);
  const cls = effectiveClasses(auto, world.causes.terrainClass, x.dry, classes.length);
  const resources = worldResources(world.small);
  const resKey = `${classKey}|${world.small.terrain.gen?.seed ?? world.settings.seed}|${JSON.stringify(resources)}`;
  const prev = natural ? undefined : resourceMemo.get(d.resourceAuto);
  let rAuto: Uint8Array;
  if (prev && prev.key === resKey && sameBytes(prev.cls, cls)) rAuto = d.resourceAuto;
  else {
    rAuto = distributeResources(
      world,
      x,
      cls,
      resources,
      classes.map((c) => c.id),
    );
    resourceMemo.set(rAuto, { key: resKey, cls });
  }
  d.terrainClassAuto = auto;
  // 没画过时与自动的是同一份数组：发给主线程、撤销缓存都只算一份
  d.terrainClass = cls;
  d.resourceAuto = rAuto;
  d.resource = effectiveResources(rAuto, world.causes.resource, x.dry, resources.length);
  d.peak = findPeaks(world.mesh, d.elevation, x.dry, cls, classes);
  // 第二十二轮：宜居度（自然、地形类别变了才重算）与人口的几层（按原因从头算）
  d.habitability = computeHabitability(world, d, x, cls, classes, natural);
  computePopLayers(world, d);
  // 第二十三轮：国家的一层（领土、领海）
  computeCountryLayer(world, d);
}

// 每个省份里格数最多的地形类别、资源（没有资源的格不算；一格资源都没有时为 null）。导出的 provinces_summary.csv 用
export function provinceHuman(world: World, d: Derived): Map<number, { terrainClass: string | null; resource: string | null }> {
  const classes = worldTerrainClasses(world.small);
  const resources = worldResources(world.small);
  const count = new Map<number, { c: Map<number, number>; r: Map<number, number> }>();
  const prov = world.causes.province;
  for (let i = 0; i < prov.length; i++) {
    const p = prov[i];
    if (p < 0) continue;
    let e = count.get(p);
    if (!e) count.set(p, (e = { c: new Map(), r: new Map() }));
    if (d.terrainClass[i]) e.c.set(d.terrainClass[i], (e.c.get(d.terrainClass[i]) ?? 0) + 1);
    if (d.resource[i]) e.r.set(d.resource[i], (e.r.get(d.resource[i]) ?? 0) + 1);
  }
  // 一样多时编号小的
  const top = (m: Map<number, number>) => {
    let best = 0;
    let bc = 0;
    for (const [k, v] of m) {
      if (v > bc || (v === bc && k < best)) {
        best = k;
        bc = v;
      }
    }
    return best;
  };
  const out = new Map<number, { terrainClass: string | null; resource: string | null }>();
  for (const [p, e] of count) out.set(p, { terrainClass: classes[top(e.c) - 1]?.id ?? null, resource: resources[top(e.r) - 1]?.id ?? null });
  return out;
}

// 图层的颜色：编号 → [r, g, b]（0 为 null：水面、没有资源）
export function classColors(world: Pick<World, 'small'>): ([number, number, number] | null)[] {
  return [null, ...worldTerrainClasses(world.small).map((c) => rgb(c.color))];
}
export function resourceColors(world: Pick<World, 'small'>): ([number, number, number] | null)[] {
  return [null, ...worldResources(world.small).map((r) => rgb(r.color))];
}
function rgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export { cellArchive, cellName, peakFeatureAt, peakMarks, type CellArchive } from './cells';
export { PEAK_MIN, peakList } from './peaks';

// 全部山峰的格，按海拔从高到低（按 derived.peak 缓存）
export const peakCells = (world: Pick<World, 'derived'>): Int32Array => peakList(world.derived.peak, world.derived.elevation);
export {
  CATEGORY_LABEL,
  FANTASY_RESOURCES,
  GENERAL_RESOURCES,
  RESOURCE_CATEGORIES,
  RESOURCE_NONE,
  type Resource,
  type ResourceCategory,
  resourceAt,
  resourceCode,
  resourceSchema,
  worldResources,
} from './resources';
export { BUILTIN_CLASSES, type TerrainClass, classAt, classCode, terrainClassSchema, worldTerrainClasses } from './terrain-class';
export { type CellRule, cellRuleSchema } from './rules';
// 第二十二轮：时代、文化、人口
export {
  type Culture,
  type CultureGroup,
  type Dimension,
  type Era,
  type PopValue,
  type Preference,
  cultureById,
  cultureGroupById,
  cultureGroupSchema,
  cultureSchema,
  dimensionValues,
  eraSchema,
  popValueById,
  popValueSchema,
  preferenceSchema,
  weightedList,
  worldCultureGroups,
  worldCultures,
  worldDimensions,
  worldEra,
  worldEras,
  worldPopValues,
} from './era';
export { BIOME_HABITABILITY, CLASS_HABITABILITY, biomeHabitability, classHabitability } from './habitability';
export { type HumanParams, defaultTotalPop, dryLandKm2, ensureHumanContent, generateHuman, humanStages, regenerateHuman, registerHumanStage, unregisterHumanStage } from './generate';
export { type GenContext, type GenGroup, type HumanStage } from './context';
export { SLOTS, type Share, readComp } from './groups';
export { type PopBrush, type PopFix, typicalTuple } from './population';
export {
  type CellPopulation,
  type GroupInfo,
  type LegendEntry,
  cellPopulation,
  groupInfo,
  humanColors,
  humanLayers,
  humanLegend,
  populationSummary,
  valueLayer,
} from './layers';
export { majorityCulture } from './culture-style';
// 第二十三轮：国家与政体
export {
  CATEGORY_NAMES,
  type Faction,
  type FactionDriver,
  type Government,
  type Title,
  categoryName,
  eraFactions,
  eraGovernments,
  factionById,
  factionSchema,
  governmentById,
  governmentSchema,
  pickTitle,
  titled,
  worldFactions,
  worldGovernments,
} from './government';
export { COUNTRY_KM2, DEFAULT_YEARS, MAX_COUNTRIES, countryList, ensureGovContent, sizeFactor, yearText } from './countries';
export { autoCapital, countryCells, type CountryPatch } from './country-edit';
export {
  type CountryLabel,
  type CountryStats,
  type FactionInfluence,
  allCountryStats,
  countryCodes,
  countryColors,
  countryFactions,
  countryGroups,
  countryLabels,
  countryMapColors,
  countryOverlords,
  countryStats,
  governmentInfo,
  labelGeometry,
  type RegionLabel,
  regionLabels,
} from './country-layers';
export { FLAG_EMBLEMS, FLAG_LAYOUTS, type FlagSpec, LAYOUT_COLORS, flagSchema, flagSvg, makeFlag } from './flags';
// 第二十四轮：城市、道路、地标、自定义点
export { type CityRank, LANDMARK_DETECTORS, LANDMARK_PLACES, type LandmarkDetector, type LandmarkPlace, type LandmarkType, type PointType, cityRankSchema, landmarkTypeSchema, pointTypeSchema } from './settle-types';
export { capitalRank, cityRankById, isMajorRank, landmarkTypeById, pointTypeById, rankFor, worldCityRanks, worldLandmarkTypes, worldPointTypes } from './settle-content';
export { BUILTIN_LANDMARK_TYPES, BUILTIN_POINT_TYPES, BUILTIN_RANKS } from '../packs/settlements';
export {
  type CityArchive,
  type CityInfo,
  type CityTable,
  MAX_CITIES,
  cityArchive,
  cityAt,
  cityList,
  cityName,
  cityTable,
  countryCities,
  hasCities,
} from './settlements';
export { type RoadPath, ROAD_KINDS, dragRoadHandle, roadHandles, roadKm, roadPaths, roadPoints, routeRoad, smoothRoad, spliceRoad, traceRoad } from './roads';
export { type LandmarkInfo, detect as detectLandmarks, landmarkArchive, landmarkList, landmarkName } from './landmarks';
export { type PointInfo, pointList } from './points';
export { type SettlementCounts, type SettlementPlan, generateSettlements, settlementRules } from './settle-gen';
export { settleInputs } from './settlements';
export { archiveJson, archiveMarkdown, cellLatLon, citiesCsv, hasSettlements, landmarksCsv, pointsCsv, roadsCsv, roadsGeojson } from './archive';
