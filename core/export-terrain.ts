// 导出用的地形（第七十一轮从 export.ts 分出来，加上中文名）：生态的 terrain 写的就是这些 id，
// 导出的地形图（terrain.png）按它着色。界面里写中文名，存的还是 id（和 Paradox 地形的通用类别同名）。
// 颜色不是游戏自带的索引调色板，导入游戏前需按其 terrain 定义重新映射。先后就是以前 TERRAIN_COLORS 的先后
export interface ExportTerrain {
  id: string;
  label: string;
  rgb: [number, number, number];
}

export const EXPORT_TERRAINS: readonly ExportTerrain[] = [
  { id: 'ocean', label: '海洋', rgb: [8, 31, 130] },
  { id: 'lake', label: '湖', rgb: [55, 90, 220] },
  { id: 'arctic', label: '极地', rgb: [235, 235, 235] },
  { id: 'tundra', label: '苔原', rgb: [190, 200, 175] },
  { id: 'forest', label: '森林', rgb: [40, 110, 40] },
  { id: 'plains', label: '平原', rgb: [150, 190, 80] },
  { id: 'steppe', label: '草原', rgb: [200, 190, 110] },
  { id: 'desert', label: '荒漠', rgb: [230, 210, 140] },
  { id: 'jungle', label: '丛林', rgb: [20, 80, 30] },
  { id: 'savanna', label: '稀树草原', rgb: [190, 180, 70] },
  { id: 'hills', label: '丘陵', rgb: [140, 120, 80] },
  { id: 'highlands', label: '高原', rgb: [170, 150, 110] },
  { id: 'mountains', label: '山地', rgb: [100, 90, 90] },
  { id: 'marsh', label: '沼泽', rgb: [80, 120, 100] },
  { id: 'glacier', label: '冰川', rgb: [250, 252, 255] },
];

// 生态能选的（海洋、湖是水面，不是生态的）
export const BIOME_TERRAINS: readonly ExportTerrain[] = EXPORT_TERRAINS.filter((t) => t.id !== 'ocean' && t.id !== 'lake');

// 中文名；不认识的 id 原样
export const exportTerrainLabel = (id: string): string => EXPORT_TERRAINS.find((t) => t.id === id)?.label ?? id;
