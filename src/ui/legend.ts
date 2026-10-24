import { RESOURCE_NONE, worldResources, worldTerrainClasses } from '../../core/human';
import { speciesColor } from '../../core/species';
import type { World } from '../../core/world';
import { NO_RESOURCE } from '../render/colors';
import type { ViewMode } from '../state';
import type { LegendItem } from './components/Legend';

// 图例（第二十一轮）：按格着色、一格一类的底图（地形类别、资源、生态分区）列出世界里有的几类，按格数从多到少。
// 以后的文化、国家底图也用它：给出 {color, label, count?} 就行

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
    case 'dominant': {
      const n = countCodes(w, d.dominant);
      const items = w.small.species.flatMap((s, k) => (n.get(k) ? [{ color: speciesColor(s), label: s.name || s.id, count: n.get(k)! }] : []));
      return { title: '生态分区', items: items.sort(byCount) };
    }
  }
  return null;
}

// 按着色用到的数组缓存（同一个世界换底图、来回切换不重数）
const cache = new WeakMap<object, Map<string, LegendData | null>>();
export function legendFor(w: World, mode: ViewMode): LegendData | null {
  const d = w.derived;
  const arr = mode === 'terrainClass' ? d.terrainClass : mode === 'resource' ? d.resource : mode === 'dominant' ? d.dominant : null;
  if (!arr) return null;
  let m = cache.get(arr);
  if (!m) cache.set(arr, (m = new Map()));
  // 小数据里的名字、颜色：改了地形类别、资源、生态的颜色名字时数组可能不变
  const key = `${mode}|${JSON.stringify(w.small.content?.terrainClass ?? null)}|${JSON.stringify(w.small.content?.resource ?? null)}|${w.small.species.map((s) => `${s.name}:${speciesColor(s)}`).join(',')}`;
  if (!m.has(key)) m.set(key, compute(w, mode));
  return m.get(key)!;
}
