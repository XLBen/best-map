import { humanLayers, worldDimensions } from '../../../core/human';
import type { World } from '../../../core/world';
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
  { id: 'terrainClass', label: '地形类别' },
  { id: 'resource', label: '资源', hint: '灰色是没有资源的陆地' },
  { id: 'temperature', label: '气温' },
  { id: 'precip', label: '降水' },
  { id: 'elevation', label: '海拔' },
  { id: 'seaTemp', label: '海水温度', hint: '海面的冷暖，色带同“气温”' },
  { id: 'moisture', label: '湿润程度', more: true },
  { id: 'wetness', label: '地形湿度', more: true },
  { id: 'continentality', label: '离海远近', more: true },
  { id: 'corrT', label: '涂生态时的温度调整', more: true },
  { id: 'corrP', label: '涂生态时的降水调整', more: true },
  { id: 'suitability', label: '某种生态的适宜程度', more: true, hint: '越亮越适合下面选的那种生态' },
  { id: 'uplift', label: '抬升', more: true },
];

// 人文的底图（第二十二轮，图层面板里单独一组）：宜居度总有；生成过人文时还有文化圈（按文化 / 按文化组，图层面板里一个按钮加一个切换）、
// 时代的每一维（dim:维度 id：宗教、种族……，按世界的时代列出）、人口密度
// 第二十三轮：有国家时最前面是“国家”
export function humanViews(w: Pick<World, 'small'>): ViewDef[] {
  const country: ViewDef[] = w.small.human?.countryRules && w.small.countries ? [{ id: 'country', label: '国家', hint: '附庸用宗主的浅色' }] : [];
  return [...country, ...humanLayers(w).flatMap((l): ViewDef[] => {
    if (l.id === 'cultureGroup') return [];
    if (l.id === 'culture') return [{ id: 'culture', label: '文化圈' }];
    if (l.id === 'popDensity' || l.id === 'habitability') return [{ id: l.id, label: l.label }];
    return [{ id: `dim:${l.id}`, label: l.label }];
  })];
}

// 文化圈按文化还是按文化组
export const CULTURE_VIEWS: [ViewMode, string][] = [
  ['culture', '按文化'],
  ['cultureGroup', '按文化组'],
];

// 这个世界里有没有这一层（人文的几层在没有人文的世界里没有，宜居度除外）
export function viewAvailable(w: Pick<World, 'small'>, id: ViewMode): boolean {
  if (id === 'culture' || id === 'cultureGroup' || id === 'popDensity') return !!w.small.human;
  if (id === 'country') return !!w.small.human?.countryRules && !!w.small.countries;
  if (id.startsWith('dim:')) return !!w.small.human && worldDimensions(w.small).some((d) => d.id === id.slice(4));
  return true;
}

// “某种生态的适宜程度”看哪一种（第十四轮：底图下面自己选，不再靠“生态”面板里选中的）：
// 选过的那种还在就是它，否则是第一种
export function suitabilityFocus(species: readonly { id: string }[], cur: string | null): string | null {
  return cur && species.some((s) => s.id === cur) ? cur : (species[0]?.id ?? null);
}

export type OverlayKey = 'labels' | 'rivers' | 'borders' | 'wind' | 'currents' | 'scale' | 'latitude' | 'edits' | 'peaks' | 'roads' | 'cities' | 'landmarks';

// planetLabel / planetHint：整个星球上的说法；planetOnly：只在整个星球上出现；settle：世界里有城市、道路、地标或自定义点时才出现（第二十四轮）
export const OVERLAYS: { key: OverlayKey; label: string; hint?: string; planetLabel?: string; planetHint?: string; planetOnly?: boolean; settle?: boolean }[] = [
  { key: 'labels', label: '地名' },
  { key: 'rivers', label: '河流' },
  { key: 'borders', label: '省份边界', hint: '省份底图或省份工具里显示' },
  { key: 'peaks', label: '山峰', hint: '放大后标名字' },
  { key: 'roads', label: '道路', hint: '放大后才画小路', settle: true },
  { key: 'cities', label: '城市', hint: '人文图里显示；缩小时只有首都与大城市', settle: true },
  { key: 'landmarks', label: '地标', hint: '含自定义点；地理图只显示自然的地标', settle: true },
  { key: 'wind', label: '风向' },
  { key: 'currents', label: '洋流', hint: '暖流偏橙、寒流偏蓝', planetOnly: true },
  { key: 'scale', label: '比例尺', hint: '左下角，导出的图片里也有' },
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
  { group: 'seaProvinces', label: '海省的省名' },
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
