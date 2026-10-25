import type { World } from '../../../core/world';
import type { OverlayState } from '../../render/overlay';
import { nameMode, overlays } from '../../state';
import { hasCountries } from '../countries';
import { roadSet, settleMarks, settleShow } from '../settlements';

// 城市、道路、地标、自定义点（第二十四轮）给叠加层的几项：屏幕与导出整张地图共用。
// political：人文图；editing：“城市”一类开着（地理图上也画城市、全部地标；导出不算）
export function settleOverlay(w: World, o: { political: boolean; editing: boolean }): Pick<OverlayState, 'settlements' | 'settleNames' | 'cellSize' | 'roads'> {
  const ov = overlays.value;
  const show = settleShow({ political: o.political, countries: hasCountries(w), editing: o.editing, cities: ov.cities, landmarks: ov.landmarks });
  const marks = show.cities || show.points || show.landmarks !== 'none' ? settleMarks(w, nameMode.value, show) : null;
  return {
    settlements: marks?.length ? marks : null,
    settleNames: ov.labels,
    cellSize: w.mesh.spacing,
    roads: ov.roads ? (roadSet(w)?.draw ?? null) : null,
  };
}
