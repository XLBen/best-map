import { RESOURCE_NONE, countryCodes, countryMapColors, humanLegend, valueLayer, worldDimensions, worldResources, worldTerrainClasses } from '../../core/human';
import { countryRows } from './countries';
import { speciesColor } from '../../core/species';
import type { World } from '../../core/world';
import { NO_RESOURCE, densityRgb, habitRgb } from '../render/colors';
import type { ViewMode } from '../state';
import type { LegendItem } from './components/Legend';

// 图例（第二十一轮）：按格着色、一格一类的底图（地形类别、资源、生态分区）列出世界里有的几类，按格数从多到少。
// 以后的文化、国家底图也用它：给出 {color, label, count?} 就行。
// 第二十二轮：文化圈、文化组、时代的每一维按人数（count 是人数：右边的百分比是占总人口多少）；宜居度、人口密度是色带上的几档
// 第二十三轮：国家按人口列前 LEGEND_TOP 个（颜色是地图上的：附庸是宗主的浅色），其余合成“其他”；没有人时按格数

export interface LegendData {
  title: string;
  items: LegendItem[];
}

const hex = (c: readonly number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

// 每个编号有几格（只数干的陆地：陆地、不是湖面）
function countCodes(w: World, codes: ArrayLike<number>): Map<number, number> {
  const { causes, derived: d } = w;
  const out = new Map<number, number>();
  for (let i = 0; i < codes.length; i++) {
    if (!causes.land[i] || d.lake[i] === 1) continue;
    out.set(codes[i], (out.get(codes[i]) ?? 0) + 1);
  }
  return out;
}

const byCount = (a: LegendItem, b: LegendItem) => (b.count ?? 0) - (a.count ?? 0);

// 国家的图例列几个
export const LEGEND_TOP = 12;

function countryLegend(w: World): LegendData | null {
  const rows = countryRows(w);
  if (!rows.length) return null;
  const codes = countryCodes(w);
  const colors = countryMapColors(w);
  const colorOf = new Map(codes.map((m, k) => [m?.id ?? -1, colors[k]]));
  const anyPop = rows.some((r) => (r.stats?.population ?? 0) > 0);
  const count = (r: (typeof rows)[number]) => (anyPop ? (r.stats?.population ?? 0) : (r.stats?.cells ?? 0));
  const sorted = anyPop ? rows : [...rows].sort((a, b) => count(b) - count(a));
  const items: LegendItem[] = sorted.slice(0, LEGEND_TOP).map((r) => ({ color: hex(colorOf.get(r.meta.id) ?? [153, 153, 153]), label: r.meta.name, count: count(r) }));
  const rest = sorted.slice(LEGEND_TOP).reduce((a, r) => a + count(r), 0);
  if (sorted.length > LEGEND_TOP) items.push({ color: 'transparent', label: `其他 ${sorted.length - LEGEND_TOP} 国`, count: rest });
  return { title: '国家', items };
}

function compute(w: World, mode: ViewMode): LegendData | null {
  const d = w.derived;
  switch (mode) {
    case 'terrainClass': {
      if (!d.terrainClass) return null;
      const list = worldTerrainClasses(w.small);
      const n = countCodes(w, d.terrainClass);
      const items = list.flatMap((c, k) => (n.get(k + 1) ? [{ color: c.color, label: c.name, count: n.get(k + 1)! }] : []));
      return { title: '地形类别', items: items.sort(byCount) };
    }
    case 'resource': {
      if (!d.resource) return null;
      const list = worldResources(w.small);
      const n = countCodes(w, d.resource);
      const items = list.flatMap((r, k) => (n.get(k + 1) ? [{ color: r.color, label: r.name, count: n.get(k + 1)! }] : []));
      const none = (n.get(0) ?? 0) + (n.get(RESOURCE_NONE) ?? 0);
      // 没有资源的陆地排在最后
      return { title: '资源', items: [...items.sort(byCount), ...(none ? [{ color: hex(NO_RESOURCE), label: '无', count: none }] : [])] };
    }
    case 'culture':
    case 'cultureGroup': {
      if (!w.small.human) return null;
      const items = humanLegend(w, mode).map((x) => ({ color: x.color, label: x.name, count: x.pop }));
      return { title: mode === 'culture' ? '文化' : '文化组', items };
    }
    case 'country':
      return countryLegend(w);
    case 'habitability':
      return { title: '宜居度', items: HABIT_STEPS.map(([v, label]) => ({ color: hex(habitRgb(v)), label })) };
    case 'popDensity':
      if (!w.small.human) return null;
      return { title: '人口密度', items: DENSITY_STEPS.map(([v, label]) => ({ color: hex(densityRgb(v)), label })) };
    case 'dominant': {
      const n = countCodes(w, d.dominant);
      const items = w.small.species.flatMap((s, k) => (n.get(k) ? [{ color: speciesColor(s), label: s.name || s.id, count: n.get(k)! }] : []));
      return { title: '生态分区', items: items.sort(byCount) };
    }
  }
  if (mode.startsWith('dim:')) {
    const dim = worldDimensions(w.small).find((x) => x.id === mode.slice(4));
    if (!dim || !w.small.human) return null;
    return { title: dim.label, items: humanLegend(w, dim.id).map((x) => ({ color: x.color, label: x.name, count: x.pop })) };
  }
  return null;
}

// 宜居度、人口密度的几档（色带上取的值、写的字）
const HABIT_STEPS: [number, string][] = [
  [0.9, '很宜居'],
  [0.6, '宜居'],
  [0.35, '一般'],
  [0.15, '较差'],
  [0.02, '荒凉'],
];
const DENSITY_STEPS: [number, string][] = [
  [300, '100 人/km² 以上'],
  [30, '10–100'],
  [3, '1–10'],
  [0.3, '不到 1'],
  [0, '无人'],
];

// 底图用的数组（缓存的键）：没有时没有图例
function layerArray(w: World, mode: ViewMode): object | null | undefined {
  const d = w.derived;
  switch (mode) {
    case 'terrainClass':
      return d.terrainClass;
    case 'resource':
      return d.resource;
    case 'dominant':
      return d.dominant;
    case 'culture':
      return d.popCulture;
    case 'cultureGroup':
      return d.popCultureGroup;
    case 'habitability':
      return d.habitability;
    case 'popDensity':
      return d.popDensity;
    case 'country':
      return d.country;
  }
  if (mode.startsWith('dim:')) {
    const k = worldDimensions(w.small).findIndex((x) => x.id === mode.slice(4));
    return k >= 0 ? valueLayer(w, k) && d.popValue : null;
  }
  return null;
}

// 人数的编号：按人口密度的数组（人数变了它才换成新的数组；causes.popTotal 在引擎里是就地改的）
const popIds = new WeakMap<object, number>();
let nextPopId = 1;
function popKey(w: World): number {
  const p = w.derived.popDensity;
  if (!p) return 0;
  let id = popIds.get(p);
  if (!id) popIds.set(p, (id = nextPopId++));
  return id;
}

// 按着色用到的数组缓存（同一个世界换底图、来回切换不重数）
const cache = new WeakMap<object, Map<string, LegendData | null>>();
export function legendFor(w: World, mode: ViewMode): LegendData | null {
  const arr = layerArray(w, mode);
  if (!arr) return null;
  let m = cache.get(arr);
  if (!m) cache.set(arr, (m = new Map()));
  // 小数据里的名字、颜色：改了地形类别、资源、生态的颜色名字时数组可能不变
  // 人口的几层：只改人数时 popCulture 不变（按人口密度的数组认），名字、颜色在文化、取值里
  const pop = mode === 'culture' || mode === 'cultureGroup' || mode.startsWith('dim:') ? `|${popKey(w)}|${JSON.stringify([w.small.content?.culture, w.small.content?.cultureGroup, w.small.content?.popValue, w.small.human?.era])}` : '';
  // 国家：人数、名字、颜色、宗主（领土没变时 derived.country 照用同一个数组）
  const cty = mode === 'country' ? `|${popKey(w)}|${Object.values(w.small.countries ?? {}).map((m) => `${m.id}:${m.name}:${m.color}:${m.overlord ?? ''}`).join(',')}|${w.causes.popTotal ? '' : 'nopop'}` : '';
  const key = `${mode}${cty}|${JSON.stringify(w.small.content?.terrainClass ?? null)}|${JSON.stringify(w.small.content?.resource ?? null)}|${w.small.species.map((s) => `${s.name}:${speciesColor(s)}`).join(',')}${pop}`;
  if (!m.has(key)) m.set(key, compute(w, mode));
  return m.get(key)!;
}
