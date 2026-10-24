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
  { id: 'seaTemp', label: '海水温度', hint: '海面的冷暖，与“气温”同一条色带；整个星球上看得出暖流、寒流。陆地是灰的' },
  { id: 'moisture', label: '湿润程度', more: true },
  { id: 'wetness', label: '地形湿度', more: true },
  { id: 'continentality', label: '离海远近', more: true },
  { id: 'corrT', label: '涂生态时的温度调整', more: true },
  { id: 'corrP', label: '涂生态时的降水调整', more: true },
  { id: 'suitability', label: '某种生态的适宜程度', more: true, hint: '越亮越适合下面选的那种生态' },
  { id: 'uplift', label: '抬升', more: true },
];

// “某种生态的适宜程度”看哪一种（第十四轮：底图下面自己选，不再靠“生态”面板里选中的）：
// 选过的那种还在就是它，否则是第一种
export function suitabilityFocus(species: readonly { id: string }[], cur: string | null): string | null {
  return cur && species.some((s) => s.id === cur) ? cur : (species[0]?.id ?? null);
}

export type OverlayKey = 'labels' | 'rivers' | 'borders' | 'wind' | 'currents' | 'scale' | 'latitude' | 'edits';

// planetLabel / planetHint：整个星球上的说法；planetOnly：只在整个星球上出现
export const OVERLAYS: { key: OverlayKey; label: string; hint?: string; planetLabel?: string; planetHint?: string; planetOnly?: boolean }[] = [
  { key: 'labels', label: '地名' },
  { key: 'rivers', label: '河流' },
  { key: 'borders', label: '省份边界', hint: '在省份底图或省份工具里显示' },
  { key: 'wind', label: '风向' },
  { key: 'currents', label: '洋流', hint: '暖流偏橙、寒流偏蓝', planetOnly: true },
  { key: 'scale', label: '比例尺', hint: '左下角；导出的图片里也有' },
  { key: 'edits', label: '我改过的地方', hint: '地形橙、气候蓝、生态绿、河湖青' },
  { key: 'latitude', label: '纬度刻度', hint: '地图左边每 10° 一格，回归线、极圈', planetLabel: '经纬网', planetHint: '经线、纬线，回归线、极圈' },
];

export const LABEL_GROUPS: { group: LabelGroup; label: string }[] = [
  { group: 'land', label: '大陆、岛、半岛' },
  { group: 'water', label: '海、湾、海峡、河、湖' },
  { group: 'relief', label: '山脉、山峰、高原、平原' },
  { group: 'nature', label: '森林、沙漠、冻原、沼泽' },
  // 省名不是地物：默认不标（省份类工具打开时屏幕上照样标着，帮着选省；导出只看这里）
  { group: 'provinces', label: '省名' },
  { group: 'seaProvinces', label: '海域的省名' },
];

// 按图层的设定要标的省名（第十三轮修）：打开“地名”与其中的“省名”才标；海域的省另要打开“海域的省名”。
// 屏幕上（省份类工具没开时）与导出的图都按它，导出不看开着的是哪类工具
export function layerProvinceLabels<T extends { kind?: string }>(labels: readonly T[], labelsOn: boolean, groups: ReadonlySet<LabelGroup>): T[] {
  if (!labelsOn || !groups.has('provinces')) return [];
  return groups.has('seaProvinces') ? [...labels] : labels.filter((l) => l.kind !== 'sea');
}

export const SEASONS: [Season, string][] = [
  ['annual', '全年'],
  ['summer', '北半球夏'],
  ['winter', '北半球冬'],
];
