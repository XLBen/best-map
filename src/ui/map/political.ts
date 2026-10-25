import type { FeatureType, GeoFeature } from '../../../core/features';
import { countryLabels } from '../../../core/human';
import type { NameMode } from '../../../core/name-display';
import type { World } from '../../../core/world';
import type { CountryLabelDraw } from '../../render/overlay';
import { countryLabelLines } from '../countries';

// 人文图（第二十三轮）在地图上多画的字：国名（沿领土的中线），自然的地名只留几类。屏幕与导出的图共用

// 人文图里标的自然地名：海、湾、海峡、湖、山脉（用户自己的地名照旧都标）
export const POLITICAL_TYPES: ReadonlySet<FeatureType> = new Set<FeatureType>(['ocean', 'sea', 'bay', 'strait', 'lake', 'range', 'region', 'spot']);

let politicalMemo: { from: GeoFeature[]; out: GeoFeature[] } | null = null;
export function politicalFeatures(list: GeoFeature[]): GeoFeature[] {
  if (politicalMemo?.from === list) return politicalMemo.out;
  politicalMemo = { from: list, out: list.filter((f) => POLITICAL_TYPES.has(f.type) || f.custom || !!f.region) };
  return politicalMemo.out;
}

// 国名：每国一个（主体上的中线、大小），按领土、各国的档案、中文 / 原文缓存（同样的输入给同一个数组：地名的版面不必重排）
let countryMemo: { key: unknown[]; out: CountryLabelDraw[] } | null = null;
const meshCellArea = new WeakMap<object, number>();
export function countryDraws(w: World, nm: NameMode): CountryLabelDraw[] {
  const key = [w.causes.country, w.small.countries, w.causes.land, nm, w.mesh];
  if (countryMemo && countryMemo.key.every((k, i) => k === key[i])) return countryMemo.out;
  let unit = meshCellArea.get(w.mesh);
  if (unit === undefined) {
    let a = 0;
    for (let i = 0; i < w.mesh.n; i++) a += w.mesh.area[i];
    unit = a / Math.max(1, w.mesh.n);
    meshCellArea.set(w.mesh, unit);
  }
  const sphere = w.mesh.kind === 'sphere';
  const out = countryLabels(w).flatMap((l): CountryLabelDraw[] => {
    const m = w.small.countries?.[l.id];
    if (!m) return [];
    // 平铺图上东西方向按纬度拉宽：屏幕上的面积 = 真的面积 ÷ cos 纬度
    const stretch = sphere ? 1 / Math.max(0.05, Math.sin(Math.PI * Math.min(1, Math.max(0, l.y)))) : 1;
    return [{ key: `country:${l.id}`, lines: countryLabelLines(m, nm), path: l.path, area: l.cells * unit! * stretch }];
  });
  countryMemo = { key, out };
  return out;
}
