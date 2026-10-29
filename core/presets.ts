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

// 整个星球的生成器种类叫什么（历史里的“新世界“像地球””、形态的“从哪种星球改起”）。这是算法的说法，不是内容：
// 向导里选的星球是“通用 ▸ 星球形态”里的形态（第三十轮，见 packs/planet-forms.ts；以前写死在这里的 PLANET_TYPES）。
// 海洋星球与空白星球是同一种生成器（ocean），按岛多少分
const PLANET_KIND_NAMES: Record<WorldType, string> = {
  continents: '像地球',
  continent: '一块超大陆',
  fragmented: '破碎大陆',
  archipelago: '群岛星球',
  inland_sea: '内海',
  ocean: '空白星球',
};
export function planetKindName(type: WorldType, islands?: number): string {
  return type === 'ocean' && (islands ?? 0) > 0 ? '海洋星球' : PLANET_KIND_NAMES[type];
}
// 向导里选的星球：一个星球形态（资源库里的键，见 src/ui/forms.ts），所以是字符串
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

// 第十七轮：新建的整个星球每格约 100 km（相邻两格中心的平均距离，就是“一格 ≈ 100 km”里的那个数），格数随半径：
// 小 1.78 万、类地 6.26 万、大 13.92 万。以前一律 10 万格（类地每格约 79 km）。格数在建世界时定下，已有的世界不变。
export const PLANET_CELL_KM = 100;
// 球面网格（core/sphere.ts，松弛过的斐波那契点）上相邻格的平均距离比同样格数的正六边形网格长约 3.1%（实测 1.030–1.032），
// 格数要多乘它的平方
const SPHERE_SPACING_RATIO = 1.031;

// 半径 radiusKm 的星球每格约 cellKm：正六边形网格每格面积 √3/2·d²，铺满 4πR²；取到百格
export function planetCells(radiusKm: number, cellKm = PLANET_CELL_KM): number {
  const d = cellKm / SPHERE_SPACING_RATIO;
  return Math.max(1000, Math.round((8 * Math.PI * radiusKm * radiusKm) / (Math.sqrt(3) * d * d) / 100) * 100);
}

export function planetSettings(size: PlanetSize, cells = planetCells(PLANET_SIZES[size].radiusKm)): Partial<Settings> {
  return { cells, aspect: 2, seed: 1, globe: true, radiusKm: PLANET_SIZES[size].radiusKm, latNorth: 90, latSouth: -90 };
}
