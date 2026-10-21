import type { LabelGroup, Season, ViewMode } from '../../state';

// “图层”面板：底图着色、叠加在上面的东西、画风与季节

export interface ViewDef {
  id: ViewMode;
  label: string;
  // 收在“更多”里
  more?: boolean;
  hint?: string;
}

export const VIEWS: ViewDef[] = [
  { id: 'terrain', label: '地貌' },
  { id: 'dominant', label: '生态分区' },
  { id: 'provinces', label: '省份' },
  { id: 'temperature', label: '气温' },
  { id: 'precip', label: '降水' },
  { id: 'elevation', label: '海拔' },
  { id: 'moisture', label: '湿润程度', more: true },
  { id: 'wetness', label: '地形湿度', more: true },
  { id: 'continentality', label: '离海远近', more: true },
  { id: 'corrT', label: '涂生态时的温度调整', more: true },
  { id: 'corrP', label: '涂生态时的降水调整', more: true },
  { id: 'suitability', label: '某种生态的适宜程度', more: true, hint: '在“生态”里选中的那种：越亮越适合' },
  { id: 'uplift', label: '抬升', more: true },
];

export type OverlayKey = 'labels' | 'rivers' | 'borders' | 'wind' | 'currents' | 'scale' | 'latitude';

// planetLabel / planetHint：整个星球上的说法；planetOnly：只在整个星球上出现
export const OVERLAYS: { key: OverlayKey; label: string; hint?: string; planetLabel?: string; planetHint?: string; planetOnly?: boolean }[] = [
  { key: 'labels', label: '地名' },
  { key: 'rivers', label: '河流' },
  { key: 'borders', label: '省份边界', hint: '在省份底图或省份工具里显示' },
  { key: 'wind', label: '风向' },
  { key: 'currents', label: '洋流', hint: '暖流偏橙、寒流偏蓝', planetOnly: true },
  { key: 'scale', label: '比例尺', hint: '左下角；导出的图片里也有' },
  { key: 'latitude', label: '纬度刻度', hint: '地图左边每 10° 一格，回归线、极圈', planetLabel: '经纬网', planetHint: '经线、纬线，回归线、极圈' },
];

export const LABEL_GROUPS: { group: LabelGroup; label: string }[] = [
  { group: 'land', label: '大陆、岛、半岛' },
  { group: 'water', label: '海、湾、海峡、河、湖' },
  { group: 'relief', label: '山脉、山峰、高原、平原' },
  { group: 'nature', label: '森林、沙漠、冻原、沼泽' },
];

export const SEASONS: [Season, string][] = [
  ['annual', '全年'],
  ['summer', '北半球夏'],
  ['winter', '北半球冬'],
];
