import { axis, unwrapped } from '../features';
import { HeapLite } from '../mesh';
import type { CountryMeta, Derived, World } from '../world';
import { countryList } from './countries';
import { cultureById, cultureGroupById, dimensionValues, worldDimensions, worldEra } from './era';
import { type Faction, categoryName, eraFactions, governmentById } from './government';
import { SLOTS } from './groups';
import { cellKm2 } from './space';
import { countryCities } from './settlements';

// 国家的推导与给界面的（第二十三轮）：
//   derived.country：每格的国家编号（countryList 的下标 + 1，0 无主），陆地按 causes.country，海按时代的 seaClaimKm（离谁家的海岸近、
//     不超过这么远的海归谁；离无主的海岸近的不归谁）；
//   countryGroups：画国界的分组（与省份的 provinceGroups 同样每格两个值，给渲染器的第二张分组纹理）；
//   countryColors / countryMapColors：编号 → 颜色（地图上附庸用宗主的浅色）；
//   countryStats / countryFactions / countryLabel：档案的统计、派系的影响力、沿领土排的国名

const rgb = (hex: string): [number, number, number] => {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

// 上一次算的时候的输入（领土、陆海的副本、各国的编号、领海）：都没变时照用上一份
interface LayerMemo {
  country: Int32Array;
  land: Uint8Array;
  key: string;
}
const memo = new WeakMap<Uint16Array, LayerMemo>();

function sameArr(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// 算国家的一层（没有国家时去掉它）
export function computeCountryLayer(world: World, d: Derived) {
  const { causes, small, mesh } = world;
  const c = causes.country;
  if (!c || !small.countries) {
    delete d.country;
    return;
  }
  const list = countryList(small);
  const claim = worldEra(small)?.seaClaimKm ?? 0;
  const key = `${list.map((m) => m.id).join(',')}|${claim}`;
  const prev = d.country ? memo.get(d.country) : undefined;
  if (prev && prev.key === key && sameArr(prev.country, c) && sameArr(prev.land, causes.land)) return;
  const n = mesh.n;
  const code = new Map(list.map((m, k) => [m.id, k + 1]));
  const out = new Uint16Array(n);
  for (let i = 0; i < n; i++) if (causes.land[i] && c[i] >= 0) out[i] = code.get(c[i]) ?? 0;
  if (claim > 0) territorialSea(world, out, claim);
  d.country = prev && sameArr(d.country!, out) ? d.country : out;
  memo.set(d.country!, { country: c.slice(), land: causes.land.slice(), key });
}

// 领海：从海岸往外按 km 走，离谁家的海岸近归谁（无主的海岸也算一家，它近的海不归谁）
function territorialSea(world: World, out: Uint16Array, claim: number) {
  const { mesh, causes } = world;
  const n = mesh.n;
  const km = world.kmPerUnit;
  const land = causes.land;
  const dist = new Float64Array(n).fill(Infinity);
  // −1 是无主的海岸
  const owner = new Int32Array(n).fill(-2);
  const heap = new HeapLite(1024);
  for (let i = 0; i < n; i++) {
    if (land[i]) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (!land[j]) continue;
      const dd = mesh.dist[e] * km * 0.5;
      const o = out[j] || -1;
      if (dd < dist[i] || (dd === dist[i] && o < owner[i])) {
        dist[i] = dd;
        owner[i] = o;
      }
    }
    if (owner[i] !== -2 && dist[i] <= claim) heap.push(i, dist[i]);
  }
  while (heap.size) {
    const i = heap.pop();
    const di = heap.lastKey;
    if (di > dist[i]) continue;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (land[j]) continue;
      const nd = di + mesh.dist[e] * km;
      if (nd > claim || nd >= dist[j]) continue;
      dist[j] = nd;
      owner[j] = owner[i];
      heap.push(j, nd);
    }
  }
  for (let i = 0; i < n; i++) if (!land[i] && owner[i] > 0 && dist[i] <= claim) out[i] = owner[i];
}

// 编号 → 国家（0 是 null）
export function countryCodes(world: Pick<World, 'small'>): (CountryMeta | null)[] {
  return [null, ...countryList(world.small)];
}

// 编号 → 国家自己的颜色（0 为 null）
export function countryColors(world: Pick<World, 'small'>): ([number, number, number] | null)[] {
  return countryCodes(world).map((m) => (m ? rgb(m.color) : null));
}

// 地图上的颜色：附庸用宗主（一层层往上找到最上面的）的浅色——往白色挪 1 − (1 − lighten)^层数（默认 lighten 0.45，
// 附庸的附庸更浅），再掺两成自己的颜色（同一个宗主的几个附庸也分得开）。不是附庸的用自己的颜色
export function countryMapColors(world: Pick<World, 'small'>, lighten = 0.45): ([number, number, number] | null)[] {
  const metas = world.small.countries ?? {};
  return countryCodes(world).map((m) => {
    if (!m) return null;
    let top = m;
    let depth = 0;
    for (; top.overlord !== undefined && metas[top.overlord] && depth < 600; depth++) top = metas[top.overlord];
    if (!depth) return rgb(m.color);
    const f = 1 - Math.pow(1 - lighten, depth);
    const own = rgb(m.color);
    return rgb(top.color).map((v, q) => Math.round(0.8 * (v + (255 - v) * f) + 0.2 * own[q])) as [number, number, number];
  });
}

// 编号 → 宗主的编号（不是附庸为 0）
export function countryOverlords(world: Pick<World, 'small'>): Int32Array {
  const codes = countryCodes(world);
  const index = new Map(codes.map((m, k) => [m?.id ?? -1, k]));
  return Int32Array.from(codes, (m) => (m?.overlord !== undefined ? (index.get(m.overlord) ?? 0) : 0));
}

// 画国界的分组：每格两个值（同 provinceGroups 的布局，第二个总是 0）。有国家的格（陆地、领海）是编号，无主的陆地是 0，
// 不归谁的海是 −1（与它挨着不画国界：海岸线由地形画）。分组不同的相邻两格之间画国界
export function countryGroups(world: World): Float32Array {
  const { mesh, causes, derived } = world;
  const out = new Float32Array(mesh.n * 2);
  const code = derived.country;
  for (let i = 0; i < mesh.n; i++) out[2 * i] = code?.[i] ? code[i] : causes.land[i] ? 0 : -1;
  return out;
}

// ---------- 统计 ----------

export interface CountryStats {
  id: number;
  // 陆地的格数（湖面也算）、面积（km²，干的陆地）、湖面的面积
  cells: number;
  areaKm2: number;
  lakeKm2: number;
  population: number;
  // 人 / km²
  density: number;
  // 省份的个数（这个国家的陆地省）
  provinces: number;
  // 各文化、文化组、每一维的取值的人数（从多到少；“其他”不算）
  cultures: { id: string; name: string; color: string; people: number; share: number }[];
  cultureGroups: { id: string; name: string; color: string; people: number; share: number }[];
  values: { dimension: string; label: string; items: { id: string; name: string; color: string; people: number; share: number }[] }[];
  // 主流文化的人、不在兼容文化组里的人、住在海边的人占多少
  primaryShare: number;
  minorityShare: number;
  coastalShare: number;
  // 城市（第二十四轮）：城市的个数、首都与陪都（城市的编号，首都在前；没有城市时为空）
  cities: number;
  capitals: number[];
}

// 全部国家的统计（一遍算完）
export function allCountryStats(world: World): Map<number, CountryStats> {
  const { mesh, causes, small, derived: d } = world;
  const out = new Map<number, CountryStats>();
  const c = causes.country;
  const metas = small.countries;
  if (!c || !metas) return out;
  const dims = worldDimensions(small);
  interface Acc {
    cells: number;
    area: number;
    lake: number;
    pop: number;
    other: number;
    cult: Map<string, number>;
    vals: Map<string, number>[];
    primary: number;
    minority: number;
    coastal: number;
    provinces: Set<number>;
  }
  const acc = new Map<number, Acc>();
  for (const m of Object.values(metas)) acc.set(m.id, { cells: 0, area: 0, lake: 0, pop: 0, other: 0, cult: new Map(), vals: dims.map(() => new Map()), primary: 0, minority: 0, coastal: 0, provinces: new Set() });
  const pop = causes.popTotal;
  const gs = causes.popGroup;
  const ss = causes.popShare;
  const groups = small.popGroups ?? {};
  const groupOfCulture = new Map<string, string | undefined>();
  const gOf = (culture: string) => {
    if (!groupOfCulture.has(culture)) groupOfCulture.set(culture, cultureById(small, culture)?.group);
    return groupOfCulture.get(culture);
  };
  for (let i = 0; i < mesh.n; i++) {
    const a = acc.get(c[i]);
    if (!a || !causes.land[i]) continue;
    const m = metas[c[i]];
    a.cells++;
    const km2 = cellKm2(world, i);
    if (d.lake[i] === 1) a.lake += km2;
    else a.area += km2;
    if (causes.province[i] >= 0) a.provinces.add(causes.province[i]);
    const p = pop?.[i] ?? 0;
    if (!(p > 0) || !gs || !ss) continue;
    a.pop += p;
    let coast = false;
    for (let e = mesh.off[i]; e < mesh.off[i + 1] && !coast; e++) if (!causes.land[mesh.adj[e]]) coast = true;
    if (coast) a.coastal += p;
    let known = 0;
    for (let k = 0; k < SLOTS; k++) {
      const g = gs[i * SLOTS + k];
      if (!g) break;
      const t = groups[g];
      const people = (p * ss[i * SLOTS + k]) / 255;
      known += people;
      if (!t) continue;
      a.cult.set(t.culture, (a.cult.get(t.culture) ?? 0) + people);
      dims.forEach((dim, q) => {
        const v = t.values[dim.id];
        if (v) a.vals[q].set(v, (a.vals[q].get(v) ?? 0) + people);
      });
      if (t.culture === m.primaryCulture) a.primary += people;
      const grp = gOf(t.culture);
      if (!grp || !m.acceptedGroups.includes(grp)) a.minority += people;
    }
    a.other += Math.max(0, p - known);
  }
  const towns = countryCities(world);
  for (const [id, a] of acc) {
    const total = a.pop;
    const share = (v: number) => (total > 0 ? v / total : 0);
    const sorted = (mp: Map<string, number>) => [...mp].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
    const cultures = sorted(a.cult).map(([cid, people]) => {
      const cu = cultureById(small, cid);
      return { id: cid, name: cu?.name ?? cid, color: cu?.color ?? '#999999', people, share: share(people) };
    });
    const gm = new Map<string, number>();
    for (const x of cultures) {
      const g = gOf(x.id);
      if (g) gm.set(g, (gm.get(g) ?? 0) + x.people);
    }
    const cultureGroups = sorted(gm).map(([gid, people]) => {
      const g = cultureGroupById(small, gid);
      return { id: gid, name: g?.name ?? gid, color: g?.color ?? '#999999', people, share: share(people) };
    });
    const values = dims.map((dim, q) => ({
      dimension: dim.id,
      label: dim.label,
      items: sorted(a.vals[q]).map(([vid, people]) => {
        const v = dimensionValues(small, dim.id).find((x) => x.id === vid);
        return { id: vid, name: v?.name ?? vid, color: v?.color ?? '#999999', people, share: share(people) };
      }),
    }));
    out.set(id, {
      id,
      cells: a.cells,
      areaKm2: a.area,
      lakeKm2: a.lake,
      population: total,
      density: a.area > 0 ? total / a.area : 0,
      provinces: a.provinces.size,
      cultures,
      cultureGroups,
      values,
      primaryShare: share(a.primary),
      minorityShare: share(a.minority),
      coastalShare: share(a.coastal),
      cities: towns.get(id)?.cities ?? 0,
      capitals: towns.get(id)?.capitals ?? [],
    });
  }
  return out;
}

export const countryStats = (world: World, id: number): CountryStats | undefined => allCountryStats(world).get(id);

// ---------- 派系 ----------

export interface FactionInfluence {
  id: string;
  name: string;
  color: string;
  influence: number;
}

// 一个派系的基础影响力：政体的类别里写了的取平均，一个都没写时用 default
function baseOf(f: Faction, categories: readonly string[]): number {
  const hits = categories.map((c) => f.base[c]).filter((v): v is number => v !== undefined);
  if (hits.length) return hits.reduce((a, b) => a + b, 0) / hits.length;
  return f.base.default ?? 0;
}

// 派系的影响力（0–1，加起来是 1）：自己定过的照用；否则 = 基础（按政体的类别）+ Σ 来源的权重 × 那部分人的比例，负的算 0，再归一
export function countryFactions(world: World, id: number, stats?: CountryStats): FactionInfluence[] {
  const small = world.small;
  const m = small.countries?.[id];
  if (!m) return [];
  const factions = eraFactions(small, worldEra(small));
  if (m.factions) {
    const known = factions.filter((f) => m.factions![f.id] !== undefined);
    const extra = Object.keys(m.factions).filter((k) => !known.some((f) => f.id === k));
    return [...known.map((f) => ({ id: f.id, name: f.name, color: f.color, influence: m.factions![f.id] })), ...extra.map((k) => ({ id: k, name: k, color: '#999999', influence: m.factions![k] }))];
  }
  if (!factions.length) return [];
  const st = stats ?? countryStats(world, id);
  const gov = governmentById(small, m.government);
  const cats = gov?.category ?? [];
  const valueShare = (dim: string, v: string) => st?.values.find((x) => x.dimension === dim)?.items.find((x) => x.id === v)?.share ?? 0;
  const raw = factions.map((f) => {
    let s = baseOf(f, cats);
    for (const dr of f.drivers ?? []) {
      // 几项都写了时取最窄的一项（数据只按单项分开记）
      const parts: number[] = [];
      if (dr.dimension && dr.value) parts.push(valueShare(dr.dimension, dr.value));
      if (dr.culture) parts.push(st?.cultures.find((x) => x.id === dr.culture)?.share ?? 0);
      if (dr.cultureGroup) parts.push(st?.cultureGroups.find((x) => x.id === dr.cultureGroup)?.share ?? 0);
      if (dr.primary) parts.push(st?.primaryShare ?? 0);
      if (dr.minority) parts.push(st?.minorityShare ?? 0);
      if (dr.coastal) parts.push(st?.coastalShare ?? 0);
      if (parts.length) s += dr.weight * Math.min(...parts);
    }
    return Math.max(0, s);
  });
  const sum = raw.reduce((a, b) => a + b, 0);
  return factions.map((f, k) => ({ id: f.id, name: f.name, color: f.color, influence: sum > 0 ? Math.round((raw[k] / sum) * 1000) / 1000 : 0 }));
}

// 政体的说明（档案用）：名字、类别的中文名
export function governmentInfo(world: Pick<World, 'small'>, id: string): { id: string; name: string; categories: string[]; description?: string } | undefined {
  const g = governmentById(world.small, id);
  return g ? { id: g.id, name: g.name, categories: g.category.map(categoryName), ...(g.description ? { description: g.description } : {}) } : undefined;
}

// ---------- 国名的位置 ----------

export interface CountryLabel {
  id: number;
  // 主体（最大的一块陆地）的格数
  cells: number;
  // 中心、主轴的方向（弧度，文字不倒着写）、主轴上的长度、狭长程度（地图坐标，同地物的标注）
  x: number;
  y: number;
  angle: number;
  span: number;
  elong: number;
  // 沿主体弯一点的中线（5 个点，从左到右）：国名沿它排
  path: [number, number][];
}

// 一片的名字的位置（第二十五轮，片区名：国名、文化名、文化组名、各维的取值名都用它）：编号相同、连着的陆地格连成一片，
// 每种编号取最大的一片；second 时第二大的一片够大（不小于最大的 second 倍，也不少于 minCells 格）时也标（海外的同一文化）。
// part：0 是最大的一片，1 是第二片。按 ids 的先后给出；不在 ids 里的编号不连（省时间）
export interface RegionLabel extends CountryLabel {
  part: 0 | 1;
}
export interface RegionLabelOptions {
  // 要标的编号（按这个先后给出）
  ids: readonly number[];
  // 少于这么多格的片不标（省略为 1）
  minCells?: number;
  // 第二片不小于最大一片的多少（省略：不标第二片）
  second?: number;
}
export function regionLabels(world: World, codes: ArrayLike<number>, opts: RegionLabelOptions): RegionLabel[] {
  const { mesh, causes } = world;
  const n = mesh.n;
  const wanted = new Set(opts.ids);
  const minCells = Math.max(1, opts.minCells ?? 1);
  const seen = new Uint8Array(n);
  const main = new Map<number, number[]>();
  const next = opts.second !== undefined ? new Map<number, number[]>() : null;
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (seen[s] || !causes.land[s] || codes[s] < 0) continue;
    const id = codes[s];
    if (!wanted.has(id)) continue;
    const comp: number[] = [];
    seen[s] = 1;
    stack.push(s);
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (!seen[j] && causes.land[j] && codes[j] === id) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    const cur = main.get(id);
    if (!cur || comp.length > cur.length) {
      main.set(id, comp);
      if (cur && next) next.set(id, cur);
    } else if (next) {
      const nx = next.get(id);
      if (!nx || comp.length > nx.length) next.set(id, comp);
    }
  }
  const out: RegionLabel[] = [];
  for (const id of opts.ids) {
    const cells = main.get(id);
    if (!cells || cells.length < minCells) continue;
    cells.sort((a, b) => a - b);
    out.push({ id, cells: cells.length, ...labelGeometry(world, cells), part: 0 });
    const more = next?.get(id);
    if (more && more.length >= minCells && more.length >= cells.length * opts.second!) {
      more.sort((a, b) => a - b);
      out.push({ id, cells: more.length, ...labelGeometry(world, more), part: 1 });
    }
  }
  return out;
}

// 每个国家的国名位置（按主体：领土里最大的一块连着的陆地）
export function countryLabels(world: World): CountryLabel[] {
  const c = world.causes.country;
  if (!c || !world.small.countries) return [];
  return regionLabels(world, c, { ids: countryList(world.small).map((m) => m.id) }).map(({ part: _part, ...l }) => l);
}

// 一块格的标注：主轴，再沿主轴用二次曲线拟合垂直方向的偏移（弯得太厉害时压平），取 5 个点
export function labelGeometry(world: World, cells: readonly number[]): Omit<CountryLabel, 'id' | 'cells'> {
  const { mesh } = world;
  const xs = unwrapped(mesh, cells);
  const a = axis(mesh, cells, xs);
  const X = (k: number) => (xs ? xs[k] : mesh.x[cells[k]]);
  // 质心按展开的坐标（a.x 已经绕回）
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < cells.length; k++) {
    cx += X(k);
    cy += mesh.y[cells[k]];
  }
  cx /= cells.length;
  cy /= cells.length;
  const ux = Math.cos(a.angle);
  const uy = Math.sin(a.angle);
  // 最小二乘：s = p·t² + q·t + r
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let s3 = 0;
  let s4 = 0;
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let tmin = Infinity;
  let tmax = -Infinity;
  for (let k = 0; k < cells.length; k++) {
    const dx = X(k) - cx;
    const dy = mesh.y[cells[k]] - cy;
    const t = dx * ux + dy * uy;
    const s = -dx * uy + dy * ux;
    const t2 = t * t;
    s0 += 1;
    s1 += t;
    s2 += t2;
    s3 += t2 * t;
    s4 += t2 * t2;
    b0 += s;
    b1 += s * t;
    b2 += s * t2;
    tmin = Math.min(tmin, t);
    tmax = Math.max(tmax, t);
  }
  // 解 3 × 3 的方程（克拉默法则）
  const det3 = (m: number[]) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const M = [s4, s3, s2, s3, s2, s1, s2, s1, s0];
  const D = det3(M);
  let p = 0;
  let q = 0;
  let r = 0;
  if (Math.abs(D) > 1e-18) {
    p = det3([b2, s3, s2, b1, s2, s1, b0, s1, s0]) / D;
    q = det3([s4, b2, s2, s3, b1, s1, s2, b0, s0]) / D;
    r = det3([s4, s3, b2, s3, s2, b1, s2, s1, b0]) / D;
  }
  const half = Math.min(a.span / 2, (tmax - tmin) / 2) * 0.8;
  // 弯得太厉害时压平：两端的偏移不超过半长的 0.35
  const bend = Math.abs(p) * half * half;
  if (bend > 0.35 * half && bend > 0) p *= (0.35 * half) / bend;
  let path: [number, number][] = [];
  for (let k = 0; k < 5; k++) {
    const t = -half + (k * half) / 2;
    const s = p * t * t + q * t + r;
    path.push([cx + t * ux - s * uy, cy + t * uy + s * ux]);
  }
  // 从左到右（近乎竖着时弯曲会让两端左右颠倒）：按展开的坐标比，比完再绕回
  if (path[0][0] > path[4][0]) path.reverse();
  if (xs) path = path.map(([x, y]) => [x - 2 * Math.floor(x / 2), y]);
  return { x: a.x, y: a.y, angle: a.angle, span: a.span, elong: a.elong, path };
}
