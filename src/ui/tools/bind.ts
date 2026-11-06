import type { World } from '../../../core/world';
import { selectedProvince, setOptions } from '../../state';
import { bindTools } from '../defs/tools';
import { riverTool, unwaterTool } from '../river/tool';
import { climateEraseTool, climateTool, fieldTool, pickClimate, pickField } from './climate';
import { countryMergeTool, countrySelectTool, newCountryTool, pickTerritory, territoryTool } from './countries';
import { cultureTool, hearthTool, pickCulture, pickPop, popTool } from './culture';
import { classEraser, countryClear, countryEraser, fieldEraser, popClear, popEraser, resourceClear, resourceEraser } from './erasers';
import { pickClass, pickResource, resourceTool, terrainClassTool } from './human';
import { regionTool, renameTool, spotTool } from './names';
import { biomeTool, eraseTool, growTool, rangePick, rangeTool } from './nature';
import { pointerTool } from './pointer';
import { brushNew, provinceBrushTool, provinceCutTool, provinceRegenTool, provinceSelectTool } from './provinces';
import { cityTool, deleteSelected, landmarkTool, pointTool, roadTool } from './settlements';
import { chainTool, fragmentTool, islandTool, landTool, pickLand, reliefTool, restoreTool, rerollTool } from './terrain';
import { lakeTool } from './water';

// 每个工具做什么（第六十九轮从 defs/tools.ts 的工具表里分出来）：地图上的工具对象（create）、吸管（pick）、橡皮擦（eraser）、Delete（del）。
// 工具表只写工具是什么，不引用 tools/；这里登记进去（register-all.ts 引用一次）。表里的每个工具都要有一条（类型查着）

const pickSpecies = (w: World, cell: number) => {
  const s = w.derived.dominant[cell];
  const sp = s >= 0 ? w.small.species[s] : null;
  if (!sp) return null;
  setOptions({ biome: sp.id });
  return sp.name;
};

// 橡皮擦（第二十七轮）：地形、气候、生态沿用原来的“恢复”“擦除冷暖干湿”“擦除生态”，人文的见 tools/erasers.ts
const TERRAIN_ERASER = { auto: () => restoreTool() };
const CLIMATE_ERASER = { auto: () => climateEraseTool() };
const NATURE_ERASER = { auto: () => eraseTool() };
const HUMAN_ERASER = { auto: popEraser, clear: popClear };

bindTools({
  land: { pick: pickLand, eraser: TERRAIN_ERASER, create: () => landTool() },
  island: { eraser: TERRAIN_ERASER, create: () => islandTool() },
  chain: { eraser: TERRAIN_ERASER, create: () => chainTool() },
  relief: { eraser: TERRAIN_ERASER, create: () => reliefTool() },
  fragment: { eraser: TERRAIN_ERASER, create: () => fragmentTool() },
  reroll: { create: () => rerollTool() },
  biome: { pick: pickSpecies, eraser: NATURE_ERASER, create: () => biomeTool() },
  // 拖的是鼠标下的那一片生态：没有要吸的
  grow: { eraser: NATURE_ERASER, create: () => growTool() },
  terrainClass: { pick: pickClass, eraser: { auto: classEraser }, create: () => terrainClassTool() },
  temp: { pick: (w, cell) => pickClimate('temp', w, cell), eraser: CLIMATE_ERASER, create: () => climateTool('temp') },
  moist: { pick: (w, cell) => pickClimate('moist', w, cell), eraser: CLIMATE_ERASER, create: () => climateTool('moist') },
  range: {
    // 离开选生态的范围：不选了
    onLeave(): void {
      rangePick.value = null;
    },
    watch: (): unknown => rangePick.value,
    create: () => rangeTool(),
  },
  resource: { pick: pickResource, eraser: { auto: resourceEraser, clear: resourceClear }, create: () => resourceTool() },
  field: { pick: pickField, eraser: { auto: fieldEraser }, create: () => fieldTool() },
  river: { create: (env) => riverTool(env.zoom) },
  lake: { create: () => lakeTool() },
  unwater: { create: (env) => unwaterTool(env.zoom) },
  pselect: { create: () => provinceSelectTool() },
  pbrush: {
    onLeave(): void {
      brushNew.value = false;
    },
    pick: (w, cell) => {
      const id = w.causes.province[cell];
      if (id < 0 || !w.small.provinces[id]) return null;
      selectedProvince.value = id;
      brushNew.value = false;
      return w.small.provinces[id].name;
    },
    // 省份没有“生成时的样子”可以退回：恢复自动是重新划分涂到的省份
    eraser: { auto: () => provinceRegenTool() },
    create: () => provinceBrushTool(),
  },
  pcut: { create: (env) => provinceCutTool(env.zoom) },
  pregen: { create: () => provinceRegenTool() },
  rename: { create: (env) => renameTool(env.hitLabel) },
  area: { create: (env) => regionTool(env.hitLabel) },
  spot: { create: (env) => spotTool(env.hitLabel, env.zoom) },
  culture: { pick: pickCulture, eraser: HUMAN_ERASER, create: () => cultureTool() },
  pop: { pick: pickPop, eraser: HUMAN_ERASER, create: () => popTool() },
  hearth: { create: (env) => hearthTool(env.zoom) },
  cselect: { create: (env) => countrySelectTool(env.zoom) },
  territory: { pick: pickTerritory, eraser: { auto: countryEraser, clear: countryClear }, create: (env) => territoryTool(env.zoom) },
  newCountry: { create: (env) => newCountryTool(env.zoom) },
  cmerge: { create: (env) => countryMergeTool(env.zoom) },
  city: { del: () => deleteSelected(['city', 'point']), create: (env) => cityTool(env.zoom) },
  road: { del: () => deleteSelected(['road']), create: (env) => roadTool(env.zoom) },
  landmark: { del: () => deleteSelected(['landmark']), create: (env) => landmarkTool(env.zoom) },
  point: { del: () => deleteSelected(['point']), create: (env) => pointTool(env.zoom) },
  pointer: { create: (env) => pointerTool(env.zoom) },
});
