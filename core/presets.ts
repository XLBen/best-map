import type { WorldType } from './generate';
import type { Settings } from './world';

// 新建世界的预设：地图多大、放在星球的哪个纬度。地图的宽高由纬度跨度决定（kmPerUnit 由纬度跨度推出）
export const MAP_SIZES = {
  islands: { name: '一片群岛', hint: '约 1500 公里宽，适合做几个岛', km: 1500 },
  region: { name: '一片海域', hint: '约 5000 公里宽，像地中海或加勒比海', km: 5000 },
  continent: { name: '一个大洲', hint: '约 1.2 万公里宽，像欧亚大陆的一大块', km: 12000 },
  hemisphere: { name: '半个星球', hint: '约 1.8 万公里宽，从极地到赤道', km: 18000 },
} as const;
export type MapSize = keyof typeof MAP_SIZES;

// 四个快捷位置：地图的中心放在哪个纬度（地图里本来就跨好几个气候带，这只是放在星球上的哪里）
export const CLIMATE_ZONES = {
  tropical: { name: '热带', hint: '炎热多雨，雨林、稀树草原', lat: 8 },
  subtropical: { name: '亚热带', hint: '温暖，有沙漠也有常绿林', lat: 26 },
  temperate: { name: '温带', hint: '四季分明，森林与草原', lat: 46 },
  polar: { name: '寒带', hint: '寒冷，针叶林、苔原与冰川', lat: 64 },
} as const;
export type ClimateZone = keyof typeof CLIMATE_ZONES;

// 星球上的气候带（南北对称，按纬度的绝对值）：向导里画在星球竖条上，也用来说地图跨了哪几个带
export const LAT_BELTS: { name: string; from: number; to: number; color: string }[] = [
  { name: '热带', from: 0, to: 23.5, color: '#6fa85a' },
  { name: '亚热带', from: 23.5, to: 35, color: '#cdb877' },
  { name: '温带', from: 35, to: 55, color: '#8db37a' },
  { name: '寒带', from: 55, to: 66.5, color: '#7fa7a6' },
  { name: '极地', from: 66.5, to: 90, color: '#dfe8ef' },
];

// 地图南北跨多少度（地图的宽高比固定，跨度由大小决定）
export function latSpan(size: MapSize, aspect = 2): number {
  return MAP_SIZES[size].km / aspect / 111.2;
}

// 中心纬度限制在地图不出两极的范围里（最多到南北纬 85°）
export function clampCenter(size: MapSize, center: number, aspect = 2): number {
  const half = latSpan(size, aspect) / 2;
  return Math.max(-85 + half, Math.min(85 - half, center));
}

// “北纬 46°”“赤道”“南纬 12°”
export function latText(lat: number): string {
  const r = Math.round(lat);
  return r === 0 ? '赤道' : `${r > 0 ? '北' : '南'}纬 ${Math.abs(r)}°`;
}

// 一段纬度跨了哪几个气候带（从北往南，不重复）
export function beltsIn(north: number, south: number): string[] {
  const out: string[] = [];
  for (let lat = north; lat >= south - 1e-9; lat -= 0.5) {
    const a = Math.abs(lat);
    const b = LAT_BELTS.find((x) => a >= x.from && a <= x.to)!;
    if (!out.includes(b.name)) out.push(b.name);
  }
  return out;
}

// 地图的中心放在 center 纬度
export function settingsAt(size: MapSize, center: number, cells: number, aspect = 2): Partial<Settings> {
  const span = latSpan(size, aspect);
  const c = clampCenter(size, center, aspect);
  const north = c + span / 2;
  const south = c - span / 2;
  return { cells, aspect, seed: 1, latNorth: Math.round(north * 100) / 100, latSouth: Math.round(south * 100) / 100 };
}

export function settingsFor(size: MapSize, zone: ClimateZone, cells: number, aspect = 2): Partial<Settings> {
  return settingsAt(size, CLIMATE_ZONES[zone].lat, cells, aspect);
}

// 每种世界类型推荐的默认大小与快捷位置
export const TYPE_DEFAULTS: Record<WorldType, { size: MapSize; zone: ClimateZone }> = {
  archipelago: { size: 'region', zone: 'tropical' },
  continent: { size: 'continent', zone: 'temperate' },
  continents: { size: 'hemisphere', zone: 'temperate' },
  fragmented: { size: 'region', zone: 'tropical' },
  inland_sea: { size: 'region', zone: 'subtropical' },
  ocean: { size: 'islands', zone: 'tropical' },
};

// —— 整个星球 ——

// 星球的类型：生成器的类型 + 岛多少（海洋星球 = 空白海洋里只有火山岛露出海面）
export const PLANET_TYPES = [
  { key: 'continents', name: '像地球', hint: '几块大小不一的大陆，许多岛', type: 'continents', islands: undefined },
  { key: 'continent', name: '一块超大陆', hint: '一块巨大的大陆，周围是大洋', type: 'continent', islands: undefined },
  { key: 'fragmented', name: '破碎大陆', hint: '许多中小块陆地和浅海', type: 'fragmented', islands: undefined },
  { key: 'archipelago', name: '群岛星球', hint: '几乎全是海，散布着群岛', type: 'archipelago', islands: undefined },
  { key: 'ocean_islands', name: '海洋星球', hint: '一片大洋，只有火山岛露出海面', type: 'ocean', islands: 0.7 },
  { key: 'blank', name: '空白星球', hint: '全是海，自己来画', type: 'ocean', islands: undefined },
] as const satisfies readonly { key: string; name: string; hint: string; type: WorldType; islands: number | undefined }[];
// 向导里选的星球：PLANET_TYPES 里的一种（key），或者一个星球形态（资源库里的键，见 src/ui/forms.ts），所以是字符串
export type PlanetTypeKey = (typeof PLANET_TYPES)[number]['key'];
export type PlanetType = string;

// 星球的大小：只改变 km，不改变布局（同一颗星球放大缩小）
export const PLANET_SIZES = {
  small: { name: '小', radiusKm: 3400 },
  earth: { name: '类地', radiusKm: 6371 },
  large: { name: '大', radiusKm: 9500 },
} as const;
export type PlanetSize = keyof typeof PLANET_SIZES;

// “赤道一圈约 4 万 km”
export function equatorText(radiusKm: number): string {
  return `赤道一圈约 ${Math.round((2 * Math.PI * radiusKm) / 1000) / 10} 万 km`;
}

export function planetSettings(size: PlanetSize, cells: number): Partial<Settings> {
  return { cells, aspect: 2, seed: 1, globe: true, radiusKm: PLANET_SIZES[size].radiusKm, latNorth: 90, latSouth: -90 };
}
