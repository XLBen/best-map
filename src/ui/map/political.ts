import { blocCells, blocList, capitalLook, countryLabels, countryList, dimensionValues, regionLabels, valueLayer, worldCultureGroups, worldCultures, worldDimensions } from '../../../core/human';
import type { BlocKind } from '../../../core/world';
import { type NameMode, nameLines } from '../../../core/name-display';
import type { World } from '../../../core/world';
import { type CountryLabelDraw, REGION_KEY } from '../../render/overlay';
import { countryLabelLines } from '../domain/countries';
import type { RegionSource } from './modes';

// 片区名（第二十三轮的国名，第二十五轮推广到文化、文化组、每一维的取值）：沿片区的中线弯着写。屏幕与导出的图共用。
// 第四十轮：几何（每一片的中线、大小：regionLabels，地区约 20–40 毫秒）与字（名字、中文 / 原文）分开缓存——几何只随每格的编号、
// 陆海、网格、编号的个数变，改名、换中文 / 原文只重新配字；屏幕上第一次切到要它的模式时几何在空闲时算（regionDraws 的 lazy）

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

// ---------- 几何（第四十轮） ----------

// 一片的几何：编号、第几片（文化等的第二片）、中线、屏幕上的大小
interface Geo {
  id: number;
  part: 0 | 1;
  path: [number, number][];
  area: number;
}
// 每种几何（'country'、'bloc:federation'、'bloc:alliance,empire,federation'、文化、文化组、'dim:…'）留最近的一份
const geoMemo = new Map<string, { key: unknown[]; out: Geo[] }>();
const sameKey = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((k, i) => k === b[i]);

// 一种几何的键与算法（不算）
interface GeoSpec {
  name: string;
  key: unknown[];
  run: () => Geo[];
}

// 国家的编号连成的字（按编号排）、集团的成员与种类连成的字：按国家、集团的对象缓存（第八十轮：每帧不再排一遍、拼一遍）
const idSigs = new WeakMap<object, string>();
function countryIds(w: World): string {
  const metas = w.small.countries;
  if (!metas) return '';
  let s = idSigs.get(metas);
  if (s === undefined) idSigs.set(metas, (s = countryList(w.small).map((m) => m.id).join(',')));
  return s;
}
const blocSigs = new WeakMap<object, string>();
function blocSig(w: World): string {
  const blocs = w.small.blocs;
  if (!blocs) return '';
  let s = blocSigs.get(blocs);
  if (s === undefined) blocSigs.set(blocs, (s = blocs.map((b) => `${b.id}:${b.kind}:${b.members.join('.')}`).join(',')));
  return s;
}

function countryGeo(w: World): GeoSpec {
  return {
    name: 'country',
    key: [w.causes.country, w.causes.land, w.mesh, countryIds(w)],
    run: () => countryLabels(w).map((l) => ({ id: l.id, part: 0 as const, path: l.path, area: screenArea(w, l.cells, l.y) })),
  };
}

// 集团（kinds 里的，按 kinds 的先后认一国在哪一个）：每格的集团（blocCells）读领土、每格的国家、集团的成员与种类、国家的编号
function blocGeo(w: World, kinds: readonly BlocKind[]): GeoSpec {
  return {
    name: `bloc:${kinds.join(',')}`,
    key: [w.causes.country, w.derived.country, w.causes.land, w.mesh, blocSig(w), countryIds(w)],
    run: () => {
      const list = blocList(w.small).filter((b) => kinds.includes(b.kind));
      if (!list.length || !w.causes.country) return [];
      return regionLabels(w, blocCells(w, kinds), { ids: list.map((b) => b.id), minCells: REGION_MIN_CELLS }).map((l) => ({ id: l.id, part: l.part, path: l.path, area: screenArea(w, l.cells, l.y) }));
    },
  };
}

// 一种片区的编码（每格的编号：0 没有）与编号对应的名字（编号 = 下标 + 1）
function regionSource(w: World, src: Exclude<RegionSource, 'country' | 'bloc'>): { codes: ArrayLike<number> | undefined; codeKey: unknown[]; items: readonly { id: string; name: string; orig?: string }[] } {
  const d = w.derived;
  if (src === 'culture') return { codes: d.popCulture, codeKey: [d.popCulture], items: worldCultures(w.small) };
  if (src === 'cultureGroup') return { codes: d.popCultureGroup, codeKey: [d.popCultureGroup], items: worldCultureGroups(w.small) };
  const dim = src.slice(4);
  const k = worldDimensions(w.small).findIndex((x) => x.id === dim);
  return { codes: k >= 0 ? valueLayer(w, k) : undefined, codeKey: k >= 0 ? [d.popValue, k] : [undefined], items: dimensionValues(w.small, dim) };
}

function valueGeo(w: World, src: Exclude<RegionSource, 'country' | 'bloc'>, codes: ArrayLike<number>, codeKey: unknown[], count: number): GeoSpec {
  return {
    name: src,
    key: [...codeKey, count, w.causes.land, w.mesh],
    run: () =>
      regionLabels(w, codes, { ids: Array.from({ length: count }, (_, k) => k + 1), minCells: REGION_MIN_CELLS, second: REGION_SECOND }).map((l) => ({
        id: l.id,
        part: l.part,
        path: l.path,
        area: screenArea(w, l.cells, l.y),
      })),
  };
}

// 取一种几何：缓存里是这一份就给它；没有时当场算——除非给了 lazy、并且这一种以前一份都没算过（第一次切到这个模式）：
// 那时排进空闲时算，给 null，算好了调 lazy（以前算过、只是输入变了的——编辑时——照旧当场算，免得片区名闪一下）
function geometry(spec: GeoSpec, lazy?: () => void): Geo[] | null {
  const hit = geoMemo.get(spec.name);
  if (hit && sameKey(hit.key, spec.key)) return hit.out;
  if (lazy && !hit) {
    later(spec, lazy);
    return null;
  }
  const out = spec.run();
  geoMemo.set(spec.name, { key: spec.key, out });
  return out;
}

type Idle = (cb: () => void, o?: { timeout: number }) => number;
const pending = new Map<string, { spec: GeoSpec; done: Set<() => void> }>();
function later(spec: GeoSpec, lazy: () => void) {
  const p = pending.get(spec.name);
  if (p) {
    p.spec = spec;
    p.done.add(lazy);
    return;
  }
  pending.set(spec.name, { spec, done: new Set([lazy]) });
  const run = () => {
    const q = pending.get(spec.name);
    pending.delete(spec.name);
    if (!q) return;
    if (!geoMemo.has(q.spec.name)) geoMemo.set(q.spec.name, { key: q.spec.key, out: q.spec.run() });
    for (const f of q.done) f();
  };
  const ric = (globalThis as { requestIdleCallback?: Idle }).requestIdleCallback;
  if (ric) ric(run, { timeout: 300 });
  else setTimeout(run, 0);
}

// 测试用：几何全扔掉（下一次当场算或排队）
export function clearRegionGeometry() {
  geoMemo.clear();
  pending.clear();
  drawMemo.clear();
}

// ---------- 配上字 ----------

// 配好字的：按几何（同一个数组）、名字表（国家、集团、取值的对象）、中文 / 原文认，同样的给同一个数组（地名的版面不必重排）
const drawMemo = new Map<string, { key: unknown[]; out: CountryLabelDraw[] }>();
function withText(name: string, key: unknown[], make: () => CountryLabelDraw[]): CountryLabelDraw[] {
  const hit = drawMemo.get(name);
  if (hit && sameKey(hit.key, key)) return hit.out;
  const out = make();
  drawMemo.set(name, { key, out });
  return out;
}

// 集团的名字（第二十六轮）：几何里的集团各一个，沿它整片领土的中线写（一个国家在几种集团里时按 kinds 的先后算，见 blocGeo）
function blocText(w: World, geo: Geo[], nm: NameMode): CountryLabelDraw[] {
  const byId = new Map(blocList(w.small).map((b) => [b.id, b]));
  return geo.map((g): CountryLabelDraw => {
    const b = byId.get(g.id)!;
    return { key: `${REGION_KEY}bloc:${b.id}`, lines: nameLines(b.name, b.orig, nm), path: g.path, area: g.area };
  });
}

// 国名：每国一个（主体上的中线、大小），按领土、各国的档案、集团、中文 / 原文缓存（同样的输入给同一个数组：地名的版面不必重排）。
// 第二十六轮：联邦整片写联邦的名字，和国名一起按大小先后排——联邦的名字最大、先排，缩小时成员邦的名字挤不下，放大了才出现。
// 第八十九轮：国名的最大字号按国家的等级分几档（与首都名字的字号倍数相同，core/human/tiers.ts 的 capitalLook：最高的一级 1，城邦级 0.75）
export function countryDraws(w: World, nm: NameMode, lazy?: () => void): CountryLabelDraw[] {
  return countryDrawsLazy(w, nm, lazy) ?? [];
}
function countryDrawsLazy(w: World, nm: NameMode, lazy?: () => void): CountryLabelDraw[] | null {
  const geo = geometry(countryGeo(w), lazy);
  const fed = geometry(blocGeo(w, ['federation']), lazy);
  if (!geo || !fed) return null;
  return withText('country', [geo, fed, w.small.countries, w.small.blocs, w.small.content, nm], () => {
    const out = geo.flatMap((g): CountryLabelDraw[] => {
      const m = w.small.countries?.[g.id];
      if (!m) return [];
      const scale = capitalLook(w.small, m.tier).label;
      return [{ key: `country:${g.id}`, lines: countryLabelLines(m, nm), path: g.path, area: g.area, ...(scale !== 1 ? { scale } : {}) }];
    });
    out.push(...blocText(w, fed, nm));
    return out;
  });
}

// 同盟模式的片区名：同盟、帝国、联邦（同盟在前：与 blocMapColors 的颜色一致）
export const BLOC_REGION_KINDS: readonly BlocKind[] = ['alliance', 'empire', 'federation'];

// 片区名的键（文化、文化组、每一维）：'region:culture:frankish'，第二片后面加 ':2'
export { REGION_KEY };

// 片区名：国家是国名；文化、文化组、每一维是这一种的名字（有原文时按中文 / 原文 / 两者）。按种类各缓存一份
// （编码、名字表、陆海、中文 / 原文、网格都没变时给同一个数组），来回换模式不重算。
// lazy（屏幕上）：这一种的几何第一次要时空闲时算，这一帧给 null（不画片区名），算好了调 lazy；导出、测试不给，当场算
export function regionDraws(w: World, src: RegionSource, nm: NameMode): CountryLabelDraw[];
export function regionDraws(w: World, src: RegionSource, nm: NameMode, lazy: () => void): CountryLabelDraw[] | null;
export function regionDraws(w: World, src: RegionSource, nm: NameMode, lazy?: () => void): CountryLabelDraw[] | null {
  if (src === 'country') return countryDrawsLazy(w, nm, lazy);
  if (src === 'bloc') {
    const geo = geometry(blocGeo(w, BLOC_REGION_KINDS), lazy);
    if (!geo) return null;
    return withText(src, [geo, w.small.blocs, nm], () => blocText(w, geo, nm));
  }
  const { codes, codeKey, items } = regionSource(w, src);
  if (!codes) return [];
  const geo = geometry(valueGeo(w, src, codes, codeKey, items.length), lazy);
  if (!geo) return null;
  return withText(src, [geo, items, nm], () =>
    geo.map((g): CountryLabelDraw => {
      const it = items[g.id - 1];
      return { key: `${REGION_KEY}${src}:${it.id}${g.part ? ':2' : ''}`, lines: nameLines(it.name, it.orig, nm), path: g.path, area: g.area };
    }),
  );
}
