import type { Derived, PopTuple, World } from '../world';
import { type Culture, type CultureGroup, type PopValue, cultureById, dimensionValues, worldCultureGroups, worldCultures, worldDimensions, worldEra } from './era';
import { SLOTS, readComp } from './groups';
import { cellKm2, nearestBy } from './space';

// 人口的几层（第二十二轮，推导）：人口密度、占多数的文化 / 文化组 / 每一维的取值、最近的文化。
// 文化圈的图层就是“每格人口里占多数的文化”：用人口笔刷放一群移民，文化圈跟着变。每次重算都按原因从头算（几毫秒），
// 内容与上一份相同时沿用上一份的数组（地名的风格按数组缓存，见 culture-style.ts）

// 群体编号 → 文化、文化组、每一维取值的编号（0 是认不出：停用了的文化、取值）
interface TupleCodes {
  culture: Uint16Array;
  group: Uint16Array;
  values: Uint16Array[];
}

const codeCache = new WeakMap<object, { key: unknown[]; codes: TupleCodes }>();
function tupleCodes(world: Pick<World, 'small'>): TupleCodes {
  const small = world.small;
  const groups = small.popGroups ?? {};
  const key = [small.content?.culture, small.content?.cultureGroup, small.content?.popValue, small.content?.era, small.human?.era];
  const hit = codeCache.get(groups);
  if (hit && hit.key.every((k, q) => k === key[q])) return hit.codes;
  let max = 0;
  for (const k of Object.keys(groups)) max = Math.max(max, Number(k));
  const cultures = worldCultures(small);
  const cg = worldCultureGroups(small);
  const dims = worldDimensions(small);
  const cIdx = new Map(cultures.map((c, k) => [c.id, k + 1]));
  const gIdx = new Map(cg.map((g, k) => [g.id, k + 1]));
  const vIdx = dims.map((dim) => new Map(dimensionValues(small, dim.id).map((v, k) => [v.id, k + 1])));
  const codes: TupleCodes = { culture: new Uint16Array(max + 1), group: new Uint16Array(max + 1), values: dims.map(() => new Uint16Array(max + 1)) };
  for (const [k, t] of Object.entries(groups)) {
    const code = Number(k);
    codes.culture[code] = cIdx.get(t.culture) ?? 0;
    const c = cultureById(small, t.culture);
    codes.group[code] = c ? (gIdx.get(c.group) ?? 0) : 0;
    dims.forEach((dim, q) => (codes.values[q][code] = vIdx[q].get(t.values[dim.id]) ?? 0));
  }
  codeCache.set(groups, { key, codes });
  return codes;
}

// 两个数组的内容逐字节相同（对齐时按 4 字节比）
function same(a: ArrayBufferView | undefined, b: ArrayBufferView): boolean {
  if (!a || a.byteLength !== b.byteLength || a.constructor !== b.constructor) return false;
  const n = a.byteLength;
  if (n % 4 === 0 && a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0) {
    const x = new Int32Array(a.buffer, a.byteOffset, n / 4);
    const y = new Int32Array(b.buffer, b.byteOffset, n / 4);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }
  const x = new Uint8Array(a.buffer, a.byteOffset, n);
  const y = new Uint8Array(b.buffer, b.byteOffset, n);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return false;
  return true;
}

// 4 个格位里按编号表 tab 合起来最多的那个编号（一样多时编号小的）；都认不出时为 0
function top(gs: Uint16Array, ss: Uint8Array, o: number, tab: Uint16Array): number {
  let best = 0;
  let bs = 0;
  for (let a = 0; a < SLOTS; a++) {
    const g = gs[o + a];
    if (!g) break;
    const c = tab[g] ?? 0;
    if (!c) continue;
    let s = 0;
    for (let b = 0; b < SLOTS; b++) if (gs[o + b] && tab[gs[o + b]] === c) s += ss[o + b];
    if (s > bs || (s === bs && c < best)) {
      bs = s;
      best = c;
    }
  }
  return best;
}

// 上一次算的时候的原因（人数、群体、占比的副本）与算出来的几个数组：按 popCulture 记。下一次推导里还是这几个数组时
// （内容只取决于那时的原因），只重算原因变了的格（笔刷只改几十格）
interface LayerMemo {
  codes: TupleCodes;
  pop: Float32Array;
  gs: Uint16Array;
  ss: Uint8Array;
  out: { density: Float32Array; group: Uint16Array; value: Uint16Array; near: Uint16Array };
}
const layerMemo = new WeakMap<Uint16Array, LayerMemo>();

// 第 i 格的几层
function layerCell(world: World, codes: TupleCodes, i: number, out: { density: Float32Array; culture: Uint16Array; group: Uint16Array; value: Uint16Array }) {
  const { causes } = world;
  const pop = causes.popTotal!;
  const n = world.mesh.n;
  const D = codes.values.length;
  if (!(pop[i] > 0)) {
    out.density[i] = 0;
    out.culture[i] = 0;
    out.group[i] = 0;
    for (let q = 0; q < D; q++) out.value[q * n + i] = 0;
    return;
  }
  const gs = causes.popGroup!;
  const ss = causes.popShare!;
  out.density[i] = pop[i] / cellKm2(world, i);
  const o = i * SLOTS;
  out.culture[i] = top(gs, ss, o, codes.culture);
  out.group[i] = top(gs, ss, o, codes.group);
  for (let q = 0; q < D; q++) out.value[q * n + i] = top(gs, ss, o, codes.values[q]);
}

// 变了的格（与上一次的副本比）；比不了时为 null
function changedSince(m: LayerMemo, pop: Float32Array, gs: Uint16Array, ss: Uint8Array): number[] | null {
  if (m.pop.length !== pop.length || m.gs.length !== gs.length || gs.byteOffset % 4 || ss.byteOffset % 4 || pop.byteOffset % 4) return null;
  const n = pop.length;
  const p0 = new Int32Array(m.pop.buffer, 0, n);
  const p1 = new Int32Array(pop.buffer, pop.byteOffset, n);
  const g0 = new Int32Array(m.gs.buffer, 0, n * 2);
  const g1 = new Int32Array(gs.buffer, gs.byteOffset, n * 2);
  const s0 = new Int32Array(m.ss.buffer, 0, n);
  const s1 = new Int32Array(ss.buffer, ss.byteOffset, n);
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (p0[i] !== p1[i] || g0[2 * i] !== g1[2 * i] || g0[2 * i + 1] !== g1[2 * i + 1] || s0[i] !== s1[i]) out.push(i);
  return out;
}

// 算人口的几层（没有人文时去掉它们）
export function computePopLayers(world: World, d: Derived) {
  const { causes, small, mesh } = world;
  const pop = causes.popTotal;
  const gs = causes.popGroup;
  const ss = causes.popShare;
  if (!small.human || !pop || !gs || !ss) {
    delete d.popDensity;
    delete d.popCulture;
    delete d.popCultureGroup;
    delete d.popValue;
    delete d.cultureNear;
    return;
  }
  const n = mesh.n;
  const codes = tupleCodes(world);
  const D = codes.values.length;
  const prev = d.popCulture ? layerMemo.get(d.popCulture) : undefined;
  const mine = prev && prev.codes === codes && prev.out.density === d.popDensity && prev.out.group === d.popCultureGroup && prev.out.value === d.popValue && prev.out.near === d.cultureNear;
  const changed = mine ? changedSince(prev, pop, gs, ss) : null;
  if (changed && !changed.length) return;
  let out: { density: Float32Array; culture: Uint16Array; group: Uint16Array; value: Uint16Array };
  if (changed) {
    // 只重算变了的格
    out = { density: d.popDensity!.slice(), culture: d.popCulture!.slice(), group: d.popCultureGroup!.slice(), value: d.popValue!.slice() };
    for (const i of changed) layerCell(world, codes, i, out);
  } else {
    out = { density: new Float32Array(n), culture: new Uint16Array(n), group: new Uint16Array(n), value: new Uint16Array(n * D) };
    for (let i = 0; i < n; i++) if (pop[i] > 0) layerCell(world, codes, i, out);
  }
  const culture = same(d.popCulture, out.culture) ? d.popCulture! : out.culture;
  // 最近的文化：从有人的格（占多数的文化认得出）往外按步数扩，海、没人的地方也有。占多数的文化没变时照用上一份
  let near = d.cultureNear;
  if (!near || culture !== d.popCulture) {
    const c = out.culture;
    const fresh = Uint16Array.from(nearestBy(mesh, (i) => c[i] > 0, (i) => c[i], 0));
    near = same(near, fresh) ? near! : fresh;
  }
  d.popDensity = same(d.popDensity, out.density) ? d.popDensity : out.density;
  d.popCulture = culture;
  d.popCultureGroup = same(d.popCultureGroup, out.group) ? d.popCultureGroup : out.group;
  d.popValue = same(d.popValue, out.value) ? d.popValue : out.value;
  d.cultureNear = near;
  layerMemo.set(culture, { codes, pop: pop.slice(), gs: gs.slice(), ss: ss.slice(), out: { density: d.popDensity!, group: d.popCultureGroup!, value: d.popValue!, near } });
}

// 第 k 维（时代的维度的先后）占多数的取值：popValue 里的那一段（不复制）
export function valueLayer(world: Pick<World, 'mesh' | 'derived'>, k: number): Uint16Array | undefined {
  const v = world.derived.popValue;
  const n = world.mesh.n;
  return v && v.length >= (k + 1) * n ? v.subarray(k * n, (k + 1) * n) : undefined;
}

// ---------- 给界面的 ----------

export interface LegendEntry {
  code: number;
  id: string;
  name: string;
  color: string;
  // 这一项占多数的格里一共多少人
  pop: number;
  cells: number;
}

// 图例：文化、文化组、某一维的取值（按人数从多到少；没有人的不列）。layer：'culture' | 'cultureGroup' | 维度的 id
export function humanLegend(world: World, layer: string): LegendEntry[] {
  const { small, derived: d, causes } = world;
  const pop = causes.popTotal;
  let arr: Uint16Array | undefined;
  let items: readonly { id: string; name: string; color: string }[];
  if (layer === 'culture') {
    arr = d.popCulture;
    items = worldCultures(small);
  } else if (layer === 'cultureGroup') {
    arr = d.popCultureGroup;
    items = worldCultureGroups(small);
  } else {
    const k = worldDimensions(small).findIndex((x) => x.id === layer);
    arr = k >= 0 ? valueLayer(world, k) : undefined;
    items = dimensionValues(small, layer);
  }
  if (!arr || !pop) return [];
  const p = new Float64Array(items.length + 1);
  const c = new Int32Array(items.length + 1);
  for (let i = 0; i < arr.length; i++) {
    if (!arr[i]) continue;
    p[arr[i]] += pop[i];
    c[arr[i]]++;
  }
  const out: LegendEntry[] = [];
  items.forEach((x, k) => {
    if (c[k + 1]) out.push({ code: k + 1, id: x.id, name: x.name, color: x.color, pop: p[k + 1], cells: c[k + 1] });
  });
  return out.sort((a, b) => b.pop - a.pop || a.code - b.code);
}

// 图层的颜色：编号 → [r, g, b]（0 为 null）。layer 同 humanLegend
export function humanColors(world: Pick<World, 'small'>, layer: string): ([number, number, number] | null)[] {
  const { small } = world;
  const items: readonly { color: string }[] = layer === 'culture' ? worldCultures(small) : layer === 'cultureGroup' ? worldCultureGroups(small) : dimensionValues(small, layer);
  return [null, ...items.map((x) => rgb(x.color))];
}
function rgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// 人口的图层有哪些（界面的底图列表）：文化、文化组、每一维、人口密度、宜居度
export function humanLayers(world: Pick<World, 'small'>): { id: string; label: string }[] {
  if (!world.small.human) return [{ id: 'habitability', label: '宜居度' }];
  return [
    { id: 'culture', label: '文化' },
    { id: 'cultureGroup', label: '文化组' },
    ...worldDimensions(world.small).map((x) => ({ id: x.id, label: x.label })),
    { id: 'popDensity', label: '人口密度' },
    { id: 'habitability', label: '宜居度' },
  ];
}

// 一个群体的说明（档案、图例用）
export interface GroupInfo {
  code: number;
  culture: { id: string; name: string; color: string } | null;
  group: { id: string; name: string; color: string } | null;
  values: { dimension: string; label: string; id: string; name: string; color: string }[];
  // “文化 · 宗教 · ……”
  label: string;
}

export function groupInfo(world: Pick<World, 'small'>, code: number, tuple?: PopTuple): GroupInfo {
  const small = world.small;
  const t = tuple ?? small.popGroups?.[code];
  if (!t) return { code, culture: null, group: null, values: [], label: '其他' };
  const c: Culture | undefined = cultureById(small, t.culture);
  const g: CultureGroup | undefined = c ? worldCultureGroups(small).find((x) => x.id === c.group) : undefined;
  const values = worldDimensions(small).flatMap((dim) => {
    const id = t.values[dim.id];
    if (!id) return [];
    const v: PopValue | undefined = dimensionValues(small, dim.id).find((x) => x.id === id);
    return [{ dimension: dim.id, label: dim.label, id, name: v?.name ?? id, color: v?.color ?? '#999999' }];
  });
  const name = c?.name ?? t.culture;
  return {
    code,
    culture: { id: t.culture, name, color: c?.color ?? '#999999' },
    group: g ? { id: g.id, name: g.name, color: g.color } : null,
    values,
    label: [name, ...values.map((v) => v.name)].join(' · '),
  };
}

// 档案里的人口一栏
export interface CellPopulation {
  total: number;
  // 人 / km²
  density: number;
  // 手改过
  manual: boolean;
  // 前 4 个群体（占比 0–1、人数）与“其他”
  groups: (GroupInfo & { share: number; people: number })[];
  other: number;
  // 占多数的文化、文化组
  culture?: { id: string; name: string; color: string };
  cultureGroup?: { id: string; name: string; color: string };
}

export function cellPopulation(world: World, cell: number): CellPopulation | undefined {
  const { causes, small, derived: d } = world;
  if (!small.human || !causes.popTotal) return undefined;
  const total = causes.popTotal[cell];
  const comp = readComp(causes, cell);
  const groups = comp.filter((x) => x.code).map((x) => ({ ...groupInfo(world, x.code), share: x.s, people: x.s * total }));
  const other = comp.find((x) => !x.code)?.s ?? 0;
  const c = d.popCulture?.[cell] ? worldCultures(small)[d.popCulture[cell] - 1] : undefined;
  const g = d.popCultureGroup?.[cell] ? worldCultureGroups(small)[d.popCultureGroup[cell] - 1] : undefined;
  return {
    total,
    density: total / cellKm2(world, cell),
    manual: causes.popManual?.[cell] === 1,
    groups,
    other,
    ...(c ? { culture: { id: c.id, name: c.name, color: c.color } } : {}),
    ...(g ? { cultureGroup: { id: g.id, name: g.name, color: g.color } } : {}),
  };
}

// 世界的人口摘要：总人数、时代、各文化的人数
export function populationSummary(world: World): { total: number; era?: string; cultures: LegendEntry[] } | null {
  const pop = world.causes.popTotal;
  if (!world.small.human || !pop) return null;
  let total = 0;
  for (let i = 0; i < pop.length; i++) total += pop[i];
  return { total, era: worldEra(world.small)?.name, cultures: humanLegend(world, 'culture') };
}

// 每个省份的人口：总人数、人数最多的文化、文化组、每一维的取值（id；按每格的全部成分算，“其他”不算）。导出的 provinces_summary.csv 用
export function provincePopulation(world: World): Map<number, { population: number; culture: string; cultureGroup: string; values: string[] }> {
  const { causes, small } = world;
  const out = new Map<number, { population: number; culture: string; cultureGroup: string; values: string[] }>();
  const pop = causes.popTotal;
  const gs = causes.popGroup;
  const ss = causes.popShare;
  if (!small.human || !pop || !gs || !ss) return out;
  const codes = tupleCodes(world);
  const D = codes.values.length;
  const acc = new Map<number, { p: number; c: Map<number, number>; g: Map<number, number>; v: Map<number, number>[] }>();
  const prov = causes.province;
  const add = (m: Map<number, number>, k: number, v: number) => {
    if (k) m.set(k, (m.get(k) ?? 0) + v);
  };
  for (let i = 0; i < prov.length; i++) {
    const p = prov[i];
    if (p < 0 || !(pop[i] > 0)) continue;
    let e = acc.get(p);
    if (!e) acc.set(p, (e = { p: 0, c: new Map(), g: new Map(), v: Array.from({ length: D }, () => new Map()) }));
    e.p += pop[i];
    for (let k = 0; k < SLOTS; k++) {
      const g = gs[i * SLOTS + k];
      if (!g) break;
      const people = (pop[i] * ss[i * SLOTS + k]) / 255;
      add(e.c, codes.culture[g] ?? 0, people);
      add(e.g, codes.group[g] ?? 0, people);
      for (let q = 0; q < D; q++) add(e.v[q], codes.values[q][g] ?? 0, people);
    }
  }
  const best = (m: Map<number, number>) => {
    let b = 0;
    let bv = 0;
    for (const [k, v] of m) {
      if (v > bv || (v === bv && k < b)) {
        bv = v;
        b = k;
      }
    }
    return b;
  };
  const cultures = worldCultures(small);
  const groups = worldCultureGroups(small);
  const dims = worldDimensions(small);
  for (const [p, e] of acc) {
    out.set(p, {
      population: e.p,
      culture: cultures[best(e.c) - 1]?.id ?? '',
      cultureGroup: groups[best(e.g) - 1]?.id ?? '',
      values: dims.map((dim, q) => dimensionValues(small, dim.id)[best(e.v[q]) - 1]?.id ?? ''),
    });
  }
  return out;
}
