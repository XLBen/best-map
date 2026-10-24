import { beltsIn, latText } from '../../../core/presets';
import type { Planet, World } from '../../../core/world';
import type { AdjustmentDef } from './types';

// “调整”面板：整个世界的参数（气候与河流）。拖着停一下先看松手后的样子，松手执行一条可撤销的命令。
// 地形（陆地多少、岛多少、山多高、海岸曲折、最高的山）第十四轮起只在新建向导里定（wizardTerrain.ts）；
// 那几条命令（set_worldgen、set_coast_style、set_planet 的 mountainScale）引擎里照旧有，旧的记录照样重放

const level = (v: number, words: [string, string, string, string]) => (v < 0.25 ? words[0] : v < 0.5 ? words[1] : v < 0.8 ? words[2] : words[3]);

function planet(key: keyof Planet, label: string, hint: string, range: [number, number], step: number, format: (v: number) => string, scale: 'log' | 'linear' = 'linear'): AdjustmentDef {
  return {
    id: key,
    group: '气候与河流',
    label,
    hint,
    available: () => true,
    read: (w) => Number(w.small.planet[key]),
    range,
    scale,
    step,
    format,
    command: (_w, v) => ({ op: 'set_planet', patch: { [key]: v } }),
    preview: 'world',
    busyLabel: '正在重算气候…',
  };
}

// 河流多少：滑块往右河越多（画成河的最小水流越小）
const RIVER_MAX = 3000;
const RIVER_MIN = 10;
const riverPos = (thr: number) => Math.log(RIVER_MAX / thr) / Math.log(RIVER_MAX / RIVER_MIN);
const riverThr = (p: number) => Math.round(RIVER_MAX * Math.pow(RIVER_MIN / RIVER_MAX, p));

// 地图在星球上的位置：中心纬度。跨度不变，只整体南北挪；最多挪到地图边上南北纬 85°
const baseCenter = (w: World) => (w.settings.latNorth + w.settings.latSouth) / 2;
const halfSpan = (w: World) => Math.abs(w.settings.latNorth - w.settings.latSouth) / 2;
const LATITUDE: AdjustmentDef = {
  id: 'latitude',
  group: '气候与河流',
  label: '地图在星球上的位置',
  hint: '整张地图往北或往南挪：越往极地越冷。地图里本来就跨好几个气候带，这里只是挪它在星球上的位置',
  available: () => true,
  // 整个星球没有“放在哪个纬度”
  hidden: (w) => !!w.settings.globe,
  read: (w) => baseCenter(w) + w.small.planet.latShift,
  range: [-80, 80],
  rangeOf: (w) => [Math.min(0, -85 + halfSpan(w)), Math.max(0, 85 - halfSpan(w))],
  step: 0.5,
  format: (v) => `中心在${latText(v)}`,
  note: (w, v) => latitudeNote(w, v),
  command: (w, v) => ({ op: 'set_planet', patch: { latShift: Math.round((v - baseCenter(w)) * 10) / 10 } }),
  // 不经过 planet()：单独给上预览
  preview: 'world',
  busyLabel: '正在重算气候…',
};

// 调整面板里纬度一项的说明：跨了哪几个气候带
function latitudeNote(w: World, center: number): string {
  const h = halfSpan(w);
  return `${latText(center + h)} — ${latText(center - h)}，包括 ${beltsIn(center + h, center - h).join('、')}`;
}

export const ADJUSTMENTS: AdjustmentDef[] = [
  LATITUDE,
  planet('solar', '整体冷暖', '太阳亮度：整个世界更热或更冷', [0.7, 1.3], 0.01, (v) => `${v < 0.97 ? '偏冷' : v > 1.03 ? '偏热' : '和地球差不多'}（×${v.toFixed(2)}）`),
  planet('humidity', '整体干湿', '整个世界的水汽更多或更少', [0.2, 3], 0.05, (v) => `${v < 0.8 ? '偏干' : v > 1.25 ? '偏湿' : '适中'}（×${v.toFixed(2)}）`, 'log'),
  planet('tilt', '四季分明', '轴倾角：越大冬夏差别越大，雨带摆得越远', [0, 60], 0.5, (v) => `轴倾角 ${v.toFixed(1)}°`),
  planet('lapse', '越高越冷', '山上比山下冷多少', [2, 10], 0.1, (v) => `每升高 1 km 冷 ${v.toFixed(1)} °C`),
  {
    ...planet('riverThreshold', '河流多少', '多大的水流才画成河：往右河越多', [0, 1], 0.01, (p) => `${level(p, ['很少', '较少', '较多', '很多'])}（≥ ${riverThr(p)} m³/s 画成河）`),
    read: (w: World) => riverPos(w.small.planet.riverThreshold),
    command: (_w: World, p: number) => ({ op: 'set_planet', patch: { riverThreshold: riverThr(p) } }),
    busyLabel: '正在重算河流…',
  },
  {
    ...planet('currents', '洋流强弱', '暖流、寒流和冷水上涌对沿海冷暖、干湿的影响：0 是没有洋流', [0, 2], 0.05, (v) => (v === 0 ? '没有洋流' : `${v < 0.7 ? '偏弱' : v > 1.3 ? '偏强' : '和地球差不多'}（×${v.toFixed(2)}）`)),
    // 只有整个星球算洋流
    hidden: (w: World) => !w.settings.globe,
  },
  planet('terrainWind', '山挡风', '高山让风拐弯：迎风坡的风顺着山走，背风坡风小雨少。0 是风直接翻过山', [0, 2], 0.05, (v) => (v === 0 ? '不挡（风直接翻山）' : `${v < 0.7 ? '偏弱' : v > 1.3 ? '偏强' : '和地球差不多'}（×${v.toFixed(2)}）`)),
  planet('vegSharpness', '生态边界', '小：几种生态混交过渡；大：泾渭分明', [0.5, 12], 0.5, (v) => (v < 3 ? `柔和（${v}）` : v < 7 ? `适中（${v}）` : `分明（${v}）`)),
];

// 两个开关（整个星球没有“地图外面”）
export const PLANET_TOGGLES: { key: 'rotation' | 'outsideOcean'; label: string; read: (w: World) => boolean; patch: (on: boolean) => Partial<Planet>; hidden?: (w: World) => boolean }[] = [
  { key: 'rotation', label: '反向自转（信风变成西风）', read: (w) => w.small.planet.rotation === -1, patch: (on) => ({ rotation: on ? -1 : 1 }) },
  { key: 'outsideOcean', label: '地图外面是海（从图边吹来的风带着水汽）', read: (w) => w.small.planet.outsideOcean, patch: (on) => ({ outsideOcean: on }), hidden: (w) => !!w.settings.globe },
];
