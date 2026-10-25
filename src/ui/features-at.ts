import type { GeoFeature } from '../../core/features';
import type { World } from '../../core/world';

// 每格属于哪些地理要素，按世界缓存
const featureCache = new WeakMap<World, Map<number, GeoFeature[]>>();
export function featuresAt(w: World, cell: number): GeoFeature[] {
  let m = featureCache.get(w);
  if (!m) {
    m = new Map();
    for (const f of w.derived.features) {
      for (const c of f.cells) {
        const l = m.get(c);
        if (l) l.push(f);
        else m.set(c, [f]);
      }
    }
    featureCache.set(w, m);
  }
  return m.get(cell) ?? [];
}
