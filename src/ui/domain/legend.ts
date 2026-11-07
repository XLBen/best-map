import { signal } from '@preact/signals';
import { RESOURCE_NONE, blocList, blocOf, countryCodes, countryMapColors, humanLegend, valueLayer, worldDimensions, worldResources, worldTerrainClasses } from '../../../core/human';
import { shownBloc } from './blocs';
import { countryRows } from './countries';
import type { World } from '../../../core/world';
import { NO_BLOC, NO_RESOURCE, densityRgb, habitRgb } from '../../render/colors';
import { WIND_STYLE } from '../../render/wind';
import type { ViewMode } from '../../state';
import type { LegendItem } from '../components/Legend';

// 图例（第二十一轮）：按格着色、一格一类的底图（地形类别、资源、生态分区；第七十二轮加了地貌）列出世界里有的几类，按格数从多到少。
// 以后的文化、国家底图也用它：给出 {color, label, count?} 就行。
// 第二十二轮：文化圈、文化组、时代的每一维按人数（count 是人数：右边的百分比是占总人口多少）；宜居度、人口密度是色带上的几档
// 第二十三轮：国家按人口列前 LEGEND_TOP 个（颜色是地图上的：附庸是宗主的浅色），其余合成“其他”；没有人时按格数。
// 第二十六轮：联邦（地图上一种颜色）合成一行写联邦的名字；同盟模式按集团列，不在集团里的合成一行灰色

export interface LegendData {
  title: string;
  items: LegendItem[];
}

const hex = (c: readonly number[]) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;

// 每个编号有几格（只数干的陆地：陆地、不是湖面）。
// 第七十九轮：按 编号数组、陆地、湖 三个数组缓存（地貌的图例在每一笔之后都要；换生态的名字颜色、换内容时不重数）；
// 0–255 的编号数在定长的表里（以前每格一次 Map 的读写），别的（-1 之类）照旧进 Map。结果只按编号取，先后无关
const countMemo = new WeakMap<object, { land: object; lake: object; n: Map<number, number> }>();
function countCodes(w: World, codes: ArrayLike<number>): Map<number, number> {
  const land = w.causes.land;
  const lake = w.derived.lake;
  const hit = countMemo.get(codes);
  if (hit && hit.land === land && hit.lake === lake) return hit.n;
  const out = new Map<number, number>();
  const low = new Uint32Array(256);
  for (let i = 0; i < codes.length; i++) {
    if (!land[i] || lake[i] === 1) continue;
    const v = codes[i];
    if (v >>> 0 < 256) low[v]++;
    else out.set(v, (out.get(v) ?? 0) + 1);
  }
  for (let v = 0; v < 256; v++) if (low[v]) out.set(v, low[v]);
  countMemo.set(codes, { land, lake, n: out });
  return out;
}

const byCount = (a: LegendItem, b: LegendItem) => (b.count ?? 0) - (a.count ?? 0);

// 风向、洋流（第四十六轮；第四十八轮起是图层里两个独立的开关）：风按快慢三档（与 render/wind.ts 画的线宽、浓淡相同），洋流按冷暖。
// 只列开着的那一层；都关着时没有这张图例
const WIND_ITEMS: LegendItem[] = [
  { color: WIND_STYLE.colors[0][0], label: '弱风', line: 1 },
  { color: WIND_STYLE.colors[0][1], label: '中等的风', line: 1.6 },
  { color: WIND_STYLE.colors[0][2], label: '强风', line: 2.4 },
];
const CURRENT_ITEMS: LegendItem[] = [
  { color: 'rgb(255, 150, 100)', label: '暖流', line: 3 },
  { color: 'rgb(130, 195, 255)', label: '寒流', line: 3 },
  { color: 'rgb(170, 225, 215)', label: '不冷不暖的洋流', line: 3 },
];
export function flowLegend(wind: boolean, currents: boolean): LegendData | null {
  if (!wind && !currents) return null;
  return { title: wind && currents ? '风向与洋流' : wind ? '风向' : '洋流', items: [...(wind ? WIND_ITEMS : []), ...(currents ? CURRENT_ITEMS : [])] };
}
// 图例下面的一句话：季节只管风；洋流强弱是 0 时地图上没有洋流
export function flowHint(wind: boolean, currents: boolean, strength: number): string {
  if (currents && strength === 0) return '洋流强弱是 0：没有洋流';
  if (currents) return wind ? '季节只换风，洋流是全年平均的' : '洋流是全年平均的，不随季节变';
  return '这里的季节只换风，不影响地貌的雪';
}

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
  // 联邦的成员邦合成一行（在盟主的位置上）
  const units: LegendItem[] = [];
  const fedRow = new Map<number, LegendItem>();
  for (const r of rows) {
    const fed = blocOf(w, r.meta.id, 'federation');
    if (!fed) {
      units.push({ color: hex(colorOf.get(r.meta.id) ?? [153, 153, 153]), label: r.meta.name, count: count(r) });
      continue;
    }
    const it = fedRow.get(fed.id);
    if (it) it.count = (it.count ?? 0) + count(r);
    else {
      const x = { color: hex(colorOf.get(r.meta.id) ?? [153, 153, 153]), label: fed.name, count: count(r) };
      fedRow.set(fed.id, x);
      units.push(x);
    }
  }
  const sorted = [...units].sort(byCount);
  const items = sorted.slice(0, LEGEND_TOP);
  const rest = sorted.slice(LEGEND_TOP).reduce((a, r) => a + (r.count ?? 0), 0);
  if (sorted.length > LEGEND_TOP) items.push({ color: 'transparent', label: `其他 ${sorted.length - LEGEND_TOP} 国`, count: rest });
  return { title: '国家', items };
}

// 同盟模式：每个集团一行（人数是成员的总和），不在集团里的国家合成一行
function blocLegend(w: World): LegendData | null {
  const rows = countryRows(w);
  if (!rows.length || !blocList(w.small).length) return null;
  const anyPop = rows.some((r) => (r.stats?.population ?? 0) > 0);
  const count = (r: (typeof rows)[number]) => (anyPop ? (r.stats?.population ?? 0) : (r.stats?.cells ?? 0));
  const byBloc = new Map<number, LegendItem>();
  let none = 0;
  for (const r of rows) {
    const b = shownBloc(w, r.meta.id);
    if (!b) {
      none += count(r);
      continue;
    }
    const it = byBloc.get(b.id);
    if (it) it.count = (it.count ?? 0) + count(r);
    else byBloc.set(b.id, { color: b.color, label: b.name, count: count(r) });
  }
  const items = [...byBloc.values()].sort(byCount);
  if (none > 0) items.push({ color: hex(NO_BLOC), label: '不在其中', count: none });
  return { title: '同盟', items };
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
    case 'bloc':
      return blocLegend(w);
    case 'habitability':
      return { title: '宜居度', items: HABIT_STEPS.map(([v, label]) => ({ color: hex(habitRgb(v)), label })) };
    case 'popDensity':
      if (!w.small.human) return null;
      return { title: '人口密度', items: DENSITY_STEPS.map(([v, label]) => ({ color: hex(densityRgb(v)), label })) };
    // 第七十二轮：地貌也有图例。地貌的陆地按生态着色（加上起伏、雪），列的和生态分区一样
    case 'dominant':
    case 'terrain': {
      const n = countCodes(w, d.dominant);
      const items = w.small.species.flatMap((s, k) => (n.get(k) ? [{ color: s.color, label: s.name || s.id, count: n.get(k)! }] : []));
      return { title: mode === 'terrain' ? '地貌' : '生态分区', items: items.sort(byCount) };
    }
  }
  if (mode.startsWith('dim:')) {
    const dim = worldDimensions(w.small).find((x) => x.id === mode.slice(4));
    if (!dim || !w.small.human) return null;
    // 第四十三轮：取值有组时写上组（“天主教（基督教）”）
    return { title: dim.label, items: humanLegend(w, dim.id).map((x) => ({ color: x.color, label: x.group ? `${x.name}（${x.group}）` : x.name, count: x.pop })) };
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
    case 'terrain':
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
    case 'bloc':
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

// 图例用到的小数据（缓存的键）。小数据里的名字、颜色：改了地形类别、资源、生态的颜色名字时数组可能不变。
// 第七十九轮：内容（small.content 的各种）按对象比（内容是不可变的，改了就是新的对象，见 core/small-copy.ts；
// 主线程收到的快照里内容没换时也是同一个对象，见 src/content-post.ts），以前每次画图例都把地形类别、资源的表 JSON.stringify 两遍
function depsOf(w: World, mode: ViewMode): unknown[] {
  const c = w.small.content;
  const out: unknown[] = [c?.terrainClass, c?.resource, w.small.species.map((s) => `${s.name}:${s.color}`).join(',')];
  // 人口的几层：只改人数时 popCulture 不变（按人口密度的数组认），名字、颜色在文化、取值里
  if (mode === 'culture' || mode === 'cultureGroup' || mode.startsWith('dim:')) out.push(popKey(w), c?.culture, c?.cultureGroup, c?.popValue, w.small.human?.era);
  // 国家：人数、名字、颜色、宗主（领土没变时 derived.country 照用同一个数组）
  // 第二十六轮：集团（联邦合成一行、同盟模式）：set_bloc 只改它（小数据里的，主线程每份快照是新的对象，按字比）
  if (mode === 'country' || mode === 'bloc')
    out.push(popKey(w), Object.values(w.small.countries ?? {}).map((m) => `${m.id}:${m.name}:${m.color}:${m.overlord ?? ''}`).join(','), !w.causes.popTotal, JSON.stringify(w.small.blocs ?? null));
  return out;
}
const sameDeps = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((v, k) => v === b[k]);

// 按着色用到的数组缓存（同一个世界换底图、来回切换不重数）：每个数组、每种底图记最近的一份
const cache = new WeakMap<object, Map<ViewMode, { deps: unknown[]; data: LegendData | null }>>();
export function legendFor(w: World, mode: ViewMode): LegendData | null {
  const arr = layerArray(w, mode);
  if (!arr) return null;
  let m = cache.get(arr);
  if (!m) cache.set(arr, (m = new Map()));
  const deps = depsOf(w, mode);
  const hit = m.get(mode);
  if (hit && sameDeps(hit.deps, deps)) return hit.data;
  const data = compute(w, mode);
  m.set(mode, { deps, data });
  return data;
}

// 按格数的几种底图（地貌、生态分区、地形类别、资源）：这一份要不要重数所有的格（第七十九轮：要重数时，
// 图例先留着上一份，空闲时再数，见下面的 shownLegend；别的底图照旧当场算）
const COUNTED: Partial<Record<ViewMode, (w: World) => ArrayLike<number> | undefined>> = {
  terrain: (w) => w.derived.dominant,
  dominant: (w) => w.derived.dominant,
  terrainClass: (w) => w.derived.terrainClass,
  resource: (w) => w.derived.resource,
};
export function legendNeedsCount(w: World, mode: ViewMode): boolean {
  const codes = COUNTED[mode]?.(w);
  if (!codes) return false;
  const hit = countMemo.get(codes);
  return !hit || hit.land !== w.causes.land || hit.lake !== w.derived.lake;
}

// 地图上显示的图例（shell/MapLegend.tsx 用）：同一种底图、要重数所有的格时（画了一笔，生态的数组换了），先显示上一份，
// 浏览器空闲时数好再换上（requestIdleCallback；没有它的环境、测试里当场算，同 legendFor）
type Idle = (cb: () => void, o?: { timeout: number }) => number;
const legendTick = signal(0);
let shown: { mode: ViewMode; data: LegendData | null } | null = null;
let pending: { w: World; mode: ViewMode } | null = null;
export function shownLegend(w: World, mode: ViewMode): LegendData | null {
  void legendTick.value;
  const ric = (globalThis as { requestIdleCallback?: Idle }).requestIdleCallback;
  if (ric && shown?.mode === mode && legendNeedsCount(w, mode)) {
    if (!pending)
      ric(
        () => {
          const p = pending;
          pending = null;
          if (p) legendFor(p.w, p.mode);
          legendTick.value++;
        },
        { timeout: 300 },
      );
    pending = { w, mode };
    return shown.data;
  }
  const data = legendFor(w, mode);
  shown = { mode, data };
  return data;
}
