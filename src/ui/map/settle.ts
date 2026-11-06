import type { World } from '../../../core/world';
import type { OverlayState } from '../../render/overlay';
import type { SettleMark } from '../../render/settle-draw';
import { nameMode, overlays, pinnedCell, selectedCountry, selectedSettle, tool } from '../../state';
import { hasCountries } from '../domain/countries';
import { markKey, roadSet, settleMarks, settleShow } from '../domain/settlements';
import type { Preview } from '../tools';
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

// “城市”工具选中的城市：地图上照旧写名字
export function settleKey(): string | null {
  const r = selectedSettle.value;
  return r && (r.kind === 'city' || r.kind === 'point') ? markKey(r.kind, r.id) : null;
}

// 照最醒目的画的点（第四十二轮）：鼠标下的点、选中的城市，选中、钉住、指针停着的国家的首都（淡一些的城市、首都照原样画）。
// 同样的内容给同一个数组
// 每个地图视图一份；pointer：鼠标下的点（不在地图上时为 null）
export function settleStrongMarks(pointer: () => { cell: number } | null): (w: World, preview: Preview) => readonly string[] | null {
  let strongMemo: { key: string; out: readonly string[] } | null = null;
  function settleStrong(w: World, preview: Preview): readonly string[] | null {
    const out: string[] = [];
    if (preview.mark) out.push(preview.mark);
    const sk = settleKey();
    if (sk && sk !== preview.mark) out.push(sk);
    const country = w.causes.country;
    if (w.small.cities && country) {
      const add = (id: number | null | undefined) => {
        if (id !== null && id !== undefined && id >= 0 && !out.includes(`country:${id}`)) out.push(`country:${id}`);
      };
      add(selectedCountry.value);
      const pin = pinnedCell.value;
      if (pin >= 0 && pin < country.length) add(country[pin]);
      const p = pointer();
      if (tool.value === 'pointer' && p && p.cell >= 0 && p.cell < country.length) add(country[p.cell]);
    }
    if (!out.length) return null;
    const key = out.join('|');
    if (strongMemo?.key !== key) strongMemo = { key, out };
    return strongMemo.out;
  }
  return settleStrong;
}
