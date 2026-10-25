import { dimensionValues, valueLayer, worldCultureGroups, worldCultures, worldDimensions } from '../../../core/human';
import type { World } from '../../../core/world';
import type { SettleMark } from '../../render/settle-draw';
import { pinCell, selectedCountry, selectedSettle, world } from '../../state';
import { blocAt, blocHereText, selectBloc } from '../blocs';
import { countryAt, countryOf } from '../countries';
import { featuresAt } from '../features-at';
import { type MapKind, mapKind, modeDef, modeOf } from '../map/modes';
import { shownMarks } from '../map/settle';
import { cellPxOf, pickMark, refOfKey, settleHoverText } from '../settlements';
import { EMPTY, type Pointer, type ToolHandler } from './api';
import { selectCountry } from './countries';
import { HIT_PX, HOVER, ring, selectSettle, selectedRing } from './settlements';

// 指针（第二十五轮）：只看、不改。点城市、地标、点打开它的档案；国家模式里点国家打开国家档案并钉住这一格；
// 同盟模式（第二十六轮）里点到集团打开集团的档案，不在集团里的国家打开国家档案；
// 别的地方钉住这一格（右下角“这里”的档案）。鼠标旁一句话写这里是什么，跟着地图模式

const cellOf = (p: Pointer) => p.shown?.here ?? p.cell;

// 地图上画着的城市、地标、点（与地图同一份）
const marksOf = (w: World) => shownMarks(w, { mode: modeDef(modeOf(w)), editing: false });

// 一格是什么（跟着模式）：国家、文化、文化组、某一维的取值、人口密度；地理模式是这里的地名。没什么可说时 null
export function pointerText(w: World, cell: number, kind: MapKind = modeOf(w, mapKind.value)): string | null {
  if (cell < 0 || cell >= w.mesh.n) return null;
  const d = w.derived;
  const land = !!w.causes.land[cell] && d.lake[cell] !== 1;
  if (kind === 'country') {
    const id = countryAt(w, cell);
    return id !== null ? (countryOf(w, id)?.name ?? null) : land ? '无主地' : null;
  }
  if (kind === 'bloc') return blocHereText(w, cell);
  if (kind === 'culture' || kind === 'cultureGroup') {
    const code = (kind === 'culture' ? d.popCulture : d.popCultureGroup)?.[cell] ?? 0;
    const items = kind === 'culture' ? worldCultures(w.small) : worldCultureGroups(w.small);
    return code ? (items[code - 1]?.name ?? null) : land ? '无人' : null;
  }
  if (kind === 'popDensity') {
    const v = d.popDensity?.[cell] ?? 0;
    if (!land) return null;
    return v > 0 ? `每平方千米 ${v < 10 ? v.toFixed(1) : Math.round(v)} 人` : '无人';
  }
  if (kind.startsWith('dim:')) {
    const dim = kind.slice(4);
    const k = worldDimensions(w.small).findIndex((x) => x.id === dim);
    const code = k >= 0 ? (valueLayer(w, k)?.[cell] ?? 0) : 0;
    return code ? (dimensionValues(w.small, dim)[code - 1]?.name ?? null) : land ? '无人' : null;
  }
  // 地理：这一格所在的最小的有名字的地方（河除外）
  const f = featuresAt(w, cell)
    .filter((x) => x.name && !x.hidden && x.type !== 'river')
    .sort((a, b) => a.areaKm2 - b.areaKm2)[0];
  return f?.name ?? null;
}

export function pointerTool(zoom: () => number): ToolHandler {
  let pointer: Pointer | null = null;
  let hot: SettleMark | null = null;
  const find = (w: World, p: Pointer) => pickMark(w, marksOf(w), p.x, p.y, HIT_PX / zoom(), cellPxOf(w, zoom()));
  return {
    drags: false,
    move(p) {
      pointer = p;
      const w = world.value;
      hot = w && p.cell >= 0 ? find(w, p) : null;
    },
    leave() {
      pointer = null;
      hot = null;
    },
    click(p) {
      const w = world.value;
      if (!w || p.cell < 0) return;
      // 1. 城市、地标、点：打开它的档案
      const m = find(w, p);
      const ref = m && refOfKey(m.key);
      if (ref) {
        selectSettle(ref);
        return;
      }
      const cell = cellOf(p);
      // 2. 国家模式里点到国家：打开国家档案，同时钉住这一格
      if (modeOf(w) === 'country') {
        const id = countryAt(w, cell);
        if (id !== null) selectCountry(id);
      }
      // 同盟模式里点到集团：打开集团的档案；不在集团里的国家打开国家档案
      if (modeOf(w) === 'bloc') {
        const b = blocAt(w, cell);
        const id = countryAt(w, cell);
        if (b) {
          selectedCountry.value = id;
          selectBloc(b.id);
        } else if (id !== null) selectCountry(id);
      }
      // 3. 钉住这一格：右下角“这里”的档案
      pinCell(cell);
    },
    backdrop() {
      const w = world.value;
      if (!w || !selectedSettle.value) return null;
      return { layers: [], shapes: selectedRing(marksOf(w), zoom(), ['city', 'point', 'landmark']) };
    },
    preview() {
      const w = world.value;
      if (!w || !pointer || pointer.cell < 0) return EMPTY;
      if (hot) {
        const ref = refOfKey(hot.key);
        return { layers: [], shapes: [ring(hot.x, hot.y, 11, zoom(), HOVER)], hint: ref ? settleHoverText(w, ref) : null };
      }
      return { ...EMPTY, hint: pointerText(w, cellOf(pointer)) };
    },
  };
}
