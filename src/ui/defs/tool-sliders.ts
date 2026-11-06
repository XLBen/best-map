import { islandSizeRangeKm, roundKm, sizeText } from '../../../core/terrain';
import { islandTypeById, liveIslandKind } from '../../../core/island-types';
import type { World } from '../../../core/world';
import { brushRange, lakeRange, options, reachRange } from '../../state';
import { RIVER_END_HINTS } from '../river/model';
import { CLIMATE_MAX, climateEffect, climateKind, fmtFlow, riverSizeName, snapRadiusKm } from './tool-values';
import type { SliderDef } from './types';

// 工具表（tools.ts）里的滑块和底部条上常用的几项（第六十九轮从 tools.ts 分出来）

// ---------- 滑块 ----------

export const fmtKm = (v: number) => String(roundKm(v));

// 画笔、岛、岛链的大小都写直径（第十三轮统一）；最小都是一格，写“一格 ≈ N km”（滑块存的是半径）
export const BRUSH: SliderDef = {
  key: 'brushKm',
  label: '直径',
  range: brushRange,
  scale: 'log',
  snap: snapRadiusKm,
  format: (v, w) => sizeText(w, v),
};

// 岛的大小写成直径：碎岛（第十八轮）可以比一格小，直接写多少 km；别的岛不到半格写“一格 ≈ N km”
export const islandSizeText = (w: World, kind: string, v: number) => {
  const r = Math.max(islandSizeRangeKm(w, kind)[0], v);
  return islandTypeById(w.small, liveIslandKind(w, kind))?.shape === 'frag' ? `${fmtKm(r * 2)} km` : sizeText(w, r);
};

// 各种岛的最小值相同（一格，碎岛更小）；一格的岛（小礁）不用调大小
export const ISLAND: SliderDef = {
  key: 'islandKm',
  label: '直径',
  range: (w) => islandSizeRangeKm(w, options.value.islandKind),
  scale: 'log',
  snap: snapRadiusKm,
  format: (v, w) => islandSizeText(w, options.value.islandKind, v),
  enabled: (w) => islandTypeById(w.small, liveIslandKind(w, options.value.islandKind))?.shape !== 'cell',
};

// 岛链自己的大小：放岛时选了小礁、调了大小都不影响岛链
export const CHAIN_SIZE: SliderDef = {
  key: 'chainKm',
  label: '直径',
  range: (w) => islandSizeRangeKm(w, options.value.chainKind),
  scale: 'log',
  snap: snapRadiusKm,
  format: (v, w) => islandSizeText(w, options.value.chainKind, v),
};

export const LAKE: SliderDef = {
  key: 'lakeKm',
  label: '直径',
  range: lakeRange,
  scale: 'log',
  snap: snapRadiusKm,
  format: (v) => `${fmtKm(v * 2)} km`,
};

// 自然融入：周围多远跟着平滑过渡（“强制”时用不上，不显示）
export const REACH: SliderDef = {
  key: 'reachKm',
  label: '过渡',
  range: reachRange,
  scale: 'log',
  snap: (v) => roundKm(v),
  format: (v) => `${fmtKm(v)} km`,
  enabled: () => options.value.biomeMode === 'natural',
};

export const RIVER: SliderDef = {
  key: 'riverFlow',
  label: '大小',
  range: () => [1, 80],
  scale: 'log',
  snap: (v) => (v < 10 ? Math.round(v * 10) / 10 : Math.round(v)),
  format: (v, w) => `${riverSizeName(v)} ${fmtFlow(v * w.small.planet.riverThreshold)} m³/s`,
};

export const percent = (v: number, base: number) => `${Math.round((v / base) * 100)}%`;

// 冷暖、干湿的力度（各有各的）：数值写成会升降多少度、雨水多少
export const CLIMATE_AMOUNT = (group: 'temp' | 'moist'): SliderDef => ({
  key: group === 'temp' ? 'tempAmount' : 'moistAmount',
  label: '力度',
  range: () => [0.25, CLIMATE_MAX],
  scale: 'log',
  snap: (v) => Math.round(v * 20) / 20,
  format: (v) => climateEffect(climateKind(group, options.value), v).short,
});

// ---------- 底部条上常用的几项 ----------

export const biomeModes = {
  kind: 'choice' as const,
  key: 'biomeMode' as const,
  options: [
    { value: 'natural', label: '自然融入', hint: '调整冷暖干湿，让它长出来' },
    { value: 'force', label: '强制', hint: '只改涂到的格，气候和河流不变' },
  ],
};

// 画河：顺地势还是自定义走向；画的线停在陆地上时“流下去”还是“停在这”（第十四轮改成短的叫法，细的说法在悬停的提示里）
export const riverModes = {
  kind: 'choice' as const,
  key: 'riverMode' as const,
  label: '走向',
  options: [
    { value: 'flow', label: '顺地势', hint: '点击源头，河顺地势流' },
    { value: 'course', label: '自定义走向', hint: '按住画出河道，河照着走' },
  ],
};
export const riverEnds = {
  kind: 'choice' as const,
  key: 'riverEnd' as const,
  label: '终点',
  options: [
    { value: 'flow', label: '流下去', hint: RIVER_END_HINTS.flow },
    { value: 'sink', label: '停在这', hint: RIVER_END_HINTS.sink },
  ],
};

// 新建国家：点省份还是圈一片（第六十九轮从 panels/countries.tsx 搬来）
export const NEW_COUNTRY_SHAPES = {
  kind: 'choice' as const,
  key: 'newCountryShape' as const,
  options: [
    { value: 'province', label: '点省份', hint: '这个省份成为新国家' },
    { value: 'lasso', label: '圈一片', hint: '圈住的陆地成为新国家' },
  ],
};
