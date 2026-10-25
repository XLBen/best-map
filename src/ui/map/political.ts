import { countryLabels, dimensionValues, regionLabels, valueLayer, worldCultureGroups, worldCultures, worldDimensions } from '../../../core/human';
import { type NameMode, nameLines } from '../../../core/name-display';
import type { World } from '../../../core/world';
import { type CountryLabelDraw, REGION_KEY } from '../../render/overlay';
import { countryLabelLines } from '../countries';
import type { RegionSource } from './modes';

// 片区名（第二十三轮的国名，第二十五轮推广到文化、文化组、每一维的取值）：沿片区的中线弯着写。屏幕与导出的图共用

// 文化等片区：少于这么多格的一片不标；第二大的一片不小于最大一片的这么多时也标（海外的同一文化）
export const REGION_MIN_CELLS = 3;
export const REGION_SECOND = 0.35;

// 每格的平均面积（地图单位²），按网格缓存
const meshCellArea = new WeakMap<object, number>();
function cellArea(w: World): number {
  let unit = meshCellArea.get(w.mesh);
  if (unit === undefined) {
    let a = 0;
    for (let i = 0; i < w.mesh.n; i++) a += w.mesh.area[i];
    unit = a / Math.max(1, w.mesh.n);
    meshCellArea.set(w.mesh, unit);
  }
  return unit;
}
// 平铺图上东西方向按纬度拉宽：屏幕上的面积 = 真的面积 ÷ cos 纬度
const screenArea = (w: World, cells: number, y: number) => cells * cellArea(w) * (w.mesh.kind === 'sphere' ? 1 / Math.max(0.05, Math.sin(Math.PI * Math.min(1, Math.max(0, y)))) : 1);

// 国名：每国一个（主体上的中线、大小），按领土、各国的档案、中文 / 原文缓存（同样的输入给同一个数组：地名的版面不必重排）
let countryMemo: { key: unknown[]; out: CountryLabelDraw[] } | null = null;
export function countryDraws(w: World, nm: NameMode): CountryLabelDraw[] {
  const key = [w.causes.country, w.small.countries, w.causes.land, nm, w.mesh];
  if (countryMemo && countryMemo.key.every((k, i) => k === key[i])) return countryMemo.out;
  const out = countryLabels(w).flatMap((l): CountryLabelDraw[] => {
    const m = w.small.countries?.[l.id];
    if (!m) return [];
    return [{ key: `country:${l.id}`, lines: countryLabelLines(m, nm), path: l.path, area: screenArea(w, l.cells, l.y) }];
  });
  countryMemo = { key, out };
  return out;
}

// 片区名的键（文化、文化组、每一维）：'region:culture:frankish'，第二片后面加 ':2'
export { REGION_KEY };

// 一种片区的编码（每格的编号：0 没有）与编号对应的名字（编号 = 下标 + 1）
function regionSource(w: World, src: Exclude<RegionSource, 'country'>): { codes: ArrayLike<number> | undefined; codeKey: unknown; items: readonly { id: string; name: string; orig?: string }[] } {
  const d = w.derived;
  if (src === 'culture') return { codes: d.popCulture, codeKey: d.popCulture, items: worldCultures(w.small) };
  if (src === 'cultureGroup') return { codes: d.popCultureGroup, codeKey: d.popCultureGroup, items: worldCultureGroups(w.small) };
  const dim = src.slice(4);
  const k = worldDimensions(w.small).findIndex((x) => x.id === dim);
  return { codes: k >= 0 ? valueLayer(w, k) : undefined, codeKey: k >= 0 ? d.popValue : undefined, items: dimensionValues(w.small, dim) };
}

// 片区名：国家是国名；文化、文化组、每一维是这一种的名字（有原文时按中文 / 原文 / 两者）。按种类各缓存一份
// （编码、名字表、陆海、中文 / 原文、网格都没变时给同一个数组），来回换模式不重算
const regionMemo = new Map<string, { key: unknown[]; out: CountryLabelDraw[] }>();
export function regionDraws(w: World, src: RegionSource, nm: NameMode): CountryLabelDraw[] {
  if (src === 'country') return countryDraws(w, nm);
  const { codes, codeKey, items } = regionSource(w, src);
  if (!codes) return [];
  const key = [codeKey, items, w.causes.land, nm, w.mesh];
  const hit = regionMemo.get(src);
  if (hit && hit.key.every((k, i) => k === key[i])) return hit.out;
  const out = regionLabels(w, codes, { ids: items.map((_, k) => k + 1), minCells: REGION_MIN_CELLS, second: REGION_SECOND }).map((l): CountryLabelDraw => {
    const it = items[l.id - 1];
    return { key: `${REGION_KEY}${src}:${it.id}${l.part ? ':2' : ''}`, lines: nameLines(it.name, it.orig, nm), path: l.path, area: screenArea(w, l.cells, l.y) };
  });
  regionMemo.set(src, { key, out });
  return out;
}
