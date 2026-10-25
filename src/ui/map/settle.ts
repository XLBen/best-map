import type { World } from '../../../core/world';
import type { OverlayState } from '../../render/overlay';
import type { SettleMark } from '../../render/settle-draw';
import { nameMode, overlays } from '../../state';
import { hasCountries } from '../countries';
import { roadSet, settleMarks, settleShow } from '../settlements';
import type { ModeDef } from './modes';

// 城市、道路、地标、自定义点（第二十四轮）给叠加层的几项：屏幕与导出整张地图共用。
// mode：地图模式的那一行（第二十五轮）；editing：“城市”一类开着（城市、全部地标都画；导出不算）；selected：选中的那一座写名字；
// roadEdit：“道路”工具开着（道路照清楚的样子画）
export interface SettleOverlayOptions {
  mode: ModeDef;
  editing: boolean;
  selected?: string | null;
  roadEdit?: boolean;
}

// 地图上画着的点（指针、“城市”一类的工具按它认鼠标下的）
export function shownMarks(w: World, o: SettleOverlayOptions): SettleMark[] {
  const ov = overlays.value;
  const show = settleShow({ mode: o.mode, countries: hasCountries(w), editing: o.editing, cities: ov.cities, landmarks: ov.landmarks, selected: o.selected });
  return show.cities !== 'none' || show.points || show.landmarks !== 'none' ? settleMarks(w, nameMode.value, show) : [];
}

export function settleOverlay(w: World, o: SettleOverlayOptions): Pick<OverlayState, 'settlements' | 'settleNames' | 'cellSize' | 'roads'> {
  const ov = overlays.value;
  const marks = shownMarks(w, o);
  const roads = ov.roads ? roadSet(w) : null;
  return {
    settlements: marks.length ? marks : null,
    settleNames: ov.labels,
    cellSize: w.mesh.spacing,
    roads: roads ? (o.roadEdit ? roads.clear : roads.draw) : null,
  };
}
