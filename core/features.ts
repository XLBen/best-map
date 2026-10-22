import { type Mesh, findCell, gradient } from './mesh';
import { DEFAULT_PACK, type WordPack, generateName, hashString } from './names';
import { guideBody, guideLine } from './rivers';
import { DEFAULT_SPECIES, type Species } from './species';
import type { Derived, Guide, RegionKind, World } from './world';

// 地理要素识别：在格图上找出大陆、岛、群岛、半岛、海、洋、湾、海峡、湖、大河、山脉、主峰、
// 高原、平原、盆地、沙漠、森林、冻原、冰原、沼泽、涂出来的生态区，按文字包起名。
// 是推导层：每次地形或气候变化后重算。名字由“类型 + 锚点格（要素内部离边界最远的格）+ 种子”确定，
// 小改动不会让名字乱跳；用户改过的名字先按“同类型、同锚点”、再按“同类型、包含原锚点”匹配到重算后的要素上。

export const FEATURE_TYPES = [
  'continent',
  'island',
  'archipelago',
  'peninsula',
  'ocean',
  'sea',
  'bay',
  'strait',
  'lake',
  'river',
  'range',
  'peak',
  'plateau',
  'plain',
  'basin',
  'desert',
  'forest',
  'tundra',
  'icecap',
  'wetland',
  // 涂出来的草原、稀树草原、灌丛、自定义生态（类型名就是生态的名字）
  'biome',
  // 用户圈的地区、放的点状地名
  'region',
  'spot',
] as const;
export type FeatureType = (typeof FEATURE_TYPES)[number];

export const FEATURE_INFO: Record<FeatureType, { label: string; group: 'land' | 'water' | 'relief' | 'nature' }> = {
  continent: { label: '大陆', group: 'land' },
  island: { label: '岛', group: 'land' },
  archipelago: { label: '群岛', group: 'land' },
  peninsula: { label: '半岛', group: 'land' },
  ocean: { label: '洋', group: 'water' },
  sea: { label: '海', group: 'water' },
  bay: { label: '湾', group: 'water' },
  strait: { label: '海峡', group: 'water' },
  lake: { label: '湖', group: 'water' },
  river: { label: '河', group: 'water' },
  range: { label: '山脉', group: 'relief' },
  peak: { label: '山峰', group: 'relief' },
  plateau: { label: '高原', group: 'relief' },
  plain: { label: '平原', group: 'relief' },
  basin: { label: '盆地', group: 'relief' },
  desert: { label: '沙漠', group: 'nature' },
  forest: { label: '森林', group: 'nature' },
  tundra: { label: '冻原', group: 'nature' },
  icecap: { label: '冰原', group: 'nature' },
  wetland: { label: '沼泽', group: 'nature' },
  biome: { label: '生态区', group: 'nature' },
  region: { label: '地区', group: 'land' },
  spot: { label: '地点', group: 'land' },
};

// 用户圈的区块：类型决定按哪种地物起名、标注的样式
export const REGION_KIND_INFO: Record<RegionKind, { label: string; type: FeatureType }> = {
  region: { label: '地区', type: 'region' },
  plain: { label: '平原', type: 'plain' },
  highland: { label: '山地', type: 'range' },
  forest: { label: '森林', type: 'forest' },
  desert: { label: '沙漠', type: 'desert' },
  sea: { label: '海域', type: 'sea' },
  spot: { label: '地点', type: 'spot' },
};

export interface GeoFeature {
  key: string;
  type: FeatureType;
  anchor: number;
  cells: Int32Array;
  areaKm2: number;
  // 标注位置（地图单位）、方向（弧度）、沿方向的长度（地图单位）
  x: number;
  y: number;
  angle: number;
  span: number;
  tags: string[];
  importance: number;
  name: string;
  custom: boolean;
  // 河流：沿河标注用的折线
  line?: [number, number][];
  // 用户圈的区块、放的地名：对应的区块 id
  region?: string;
  // 涂出来的生态区：涂的生态的 id（自然形成的地物没有这一项）
  species?: string;
  // 画的河（有名字的河道）：河道的 id
  guide?: string;
}

export interface FeatureOverride {
  name?: string;
  // 重抽名字时的盐
  salt?: number;
}

// ---------- 格图工具 ----------

function components(mesh: Mesh, mask: Uint8Array): number[][] {
  const seen = new Uint8Array(mesh.n);
  const out: number[][] = [];
  for (let i = 0; i < mesh.n; i++) {
    if (!mask[i] || seen[i]) continue;
    const q = [i];
    seen[i] = 1;
    for (let h = 0; h < q.length; h++) {
      const c = q[h];
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
        const j = mesh.adj[e];
        if (mask[j] && !seen[j]) {
          seen[j] = 1;
          q.push(j);
        }
      }
    }
    out.push(q);
  }
  return out;
}

// 在 allowed 内从 sources 出发的步数距离（不可达为 -1）
function steps(mesh: Mesh, sources: number[], allowed: Uint8Array, max = Infinity): Int32Array {
  const d = new Int32Array(mesh.n).fill(-1);
  const q: number[] = [];
  for (const s of sources) {
    if (d[s] < 0) {
      d[s] = 0;
      q.push(s);
    }
  }
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    if (d[c] >= max) continue;
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
      const j = mesh.adj[e];
      if (allowed[j] && d[j] < 0) {
        d[j] = d[c] + 1;
        q.push(j);
      }
    }
  }
  return d;
}

// 锚点（决定名字）：要素里“优先级”最高的格。每格的优先级是固定的随机数，
// 所以要素的形状变了，只要这一格还在要素里，名字就不变——在海中间放个岛、把岛画大一点，名字都不会跳。
// （“离边界最远的格”恰好是最常被放岛、被改动的地方，不适合当锚点）
function priority(c: number): number {
  let h = Math.imul(c + 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
function stableAnchor(cells: ArrayLike<number>): number {
  let best = cells[0];
  let bp = priority(best);
  for (let k = 1; k < cells.length; k++) {
    const p = priority(cells[k]);
    if (p > bp || (p === bp && cells[k] < best)) {
      bp = p;
      best = cells[k];
    }
  }
  return best;
}

// 同上，但跳过已被同类地物用作锚点的格（used），优先级可以加盐（salt：涂出来的生态区按生态加盐，
// 同一片格涂成别的生态时锚点也换掉）。都被用过时返回 -1
function freeAnchor(cells: ArrayLike<number>, used: Set<number>, salt = 0): number {
  let best = -1;
  let bp = 0;
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k];
    if (used.has(c)) continue;
    const p = priority(c ^ salt);
    if (best < 0 || p > bp || (p === bp && c < best)) {
      bp = p;
      best = c;
    }
  }
  return best;
}

// 整个星球：地物可能跨过经度 ±180°。在经度上最大的空白处切开，把切口东边的格加 2（展开），
// 再求质心与主轴，所以跨接缝的地物标注也落在地物上；一块地区返回 null（用原坐标）
function unwrapped(mesh: Mesh, cells: ArrayLike<number>): Float64Array | null {
  if (mesh.kind !== 'sphere' || !cells.length) return null;
  const BINS = 720;
  const occ = new Uint8Array(BINS);
  for (let k = 0; k < cells.length; k++) occ[Math.min(BINS - 1, Math.floor((mesh.x[cells[k]] / 2) * BINS))] = 1;
  // 最长的一段空白（首尾相接）
  let bestLen = 0;
  let bestStart = -1;
  for (let b = 0; b < BINS; b++) {
    if (occ[b] || !occ[(b + BINS - 1) % BINS]) continue;
    let l = 0;
    while (l < BINS && !occ[(b + l) % BINS]) l++;
    if (l > bestLen) {
      bestLen = l;
      bestStart = b;
    }
  }
  // 绕星球一整圈（没有空白）：从第一格的对面切开
  const cut = bestStart < 0 ? mesh.x[cells[0]] + 1 - 2 * Math.floor((mesh.x[cells[0]] + 1) / 2) : ((bestStart + bestLen / 2) / BINS) * 2;
  const out = new Float64Array(cells.length);
  for (let k = 0; k < cells.length; k++) {
    const x = mesh.x[cells[k]];
    out[k] = x < cut ? x + 2 : x;
  }
  return out;
}

const wrapX = (x: number) => x - 2 * Math.floor(x / 2);
const wrapDelta = (d: number) => d - 2 * Math.round(d / 2);

// 质心与主轴方向、长度；elong：主轴与次轴方向上散布的比（越大越狭长）。
// xs：整个星球上展开后的经度坐标（与 cells 对齐）；结果的 x 绕回 [0, 2)
function axis(mesh: Mesh, cells: ArrayLike<number>, xs: Float64Array | null = null): { x: number; y: number; angle: number; span: number; elong: number } {
  if (xs) {
    const r = axisOf(cells.length, (k) => xs[k], (k) => mesh.y[cells[k]]);
    r.x = wrapX(r.x);
    return r;
  }
  let x = 0;
  let y = 0;
  for (let k = 0; k < cells.length; k++) {
    x += mesh.x[cells[k]];
    y += mesh.y[cells[k]];
  }
  x /= cells.length;
  y /= cells.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k];
    const dx = mesh.x[c] - x;
    const dy = mesh.y[c] - y;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  sxx /= cells.length;
  syy /= cells.length;
  sxy /= cells.length;
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  let angle = Math.abs(sxy) < 1e-12 ? (sxx >= syy ? 0 : Math.PI / 2) : Math.atan2(l1 - sxx, sxy);
  // 文字不倒着写
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle < -Math.PI / 2) angle += Math.PI;
  const l2 = Math.max(0, tr - l1);
  return { x, y, angle, span: 4 * Math.sqrt(l1), elong: Math.sqrt(l1 / Math.max(l2, 1e-12)) };
}

// 同上，坐标由函数给出（整个星球用）
function axisOf(m: number, X: (k: number) => number, Y: (k: number) => number): { x: number; y: number; angle: number; span: number; elong: number } {
  let x = 0;
  let y = 0;
  for (let k = 0; k < m; k++) {
    x += X(k);
    y += Y(k);
  }
  x /= m;
  y /= m;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let k = 0; k < m; k++) {
    const dx = X(k) - x;
    const dy = Y(k) - y;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  sxx /= m;
  syy /= m;
  sxy /= m;
  const tr = sxx + syy;
  const det = sxx * syy - sxy * sxy;
  const l1 = tr / 2 + Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  let angle = Math.abs(sxy) < 1e-12 ? (sxx >= syy ? 0 : Math.PI / 2) : Math.atan2(l1 - sxx, sxy);
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle < -Math.PI / 2) angle += Math.PI;
  const l2 = Math.max(0, tr - l1);
  return { x, y, angle, span: 4 * Math.sqrt(l1), elong: Math.sqrt(l1 / Math.max(l2, 1e-12)) };
}

// 情境标签（寒、热、干、湿、高）：按地物里陆地格的平均气候；全是水时只看冷热。
// 高不高按没挖河床的地形（terrain）看：画一条峡谷不会让地名换一套字
function tagsOf(world: World, d: Derived, cells: ArrayLike<number>, terrain: ArrayLike<number> = d.elevation): string[] {
  const land = world.causes.land;
  let t = 0;
  let m = 0;
  let h = 0;
  let cnt = 0;
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k];
    if (!land[c]) continue;
    t += d.tMean[c];
    m += Math.min(d.moisture[c], 4);
    h += Math.max(0, terrain[c]);
    cnt++;
  }
  if (!cnt) {
    for (let k = 0; k < cells.length; k++) t += d.tMean[cells[k]];
    t /= cells.length;
    return t < 2 ? ['cold'] : t > 24 ? ['hot'] : [];
  }
  t /= cnt;
  m /= cnt;
  h /= cnt;
  const tags: string[] = [];
  if (t < 0) tags.push('cold');
  if (t > 22) tags.push('hot');
  if (m < 0.35) tags.push('dry');
  if (m > 1.6) tags.push('wet');
  if (h > 2200) tags.push('high');
  return tags;
}

// ---------- 识别 ----------

// 一次 add 的输入。各段先把输入记下来，再逐个 add（标签按当前的气候算，名字每次重起）
interface AddInput {
  type: FeatureType;
  cells: Int32Array;
  importance: number;
  tags: string[];
  anchor?: number;
  // river：沿河标注；peak：标在峰顶；islet：小岛，最高处超过 1400 m 时加“火山”（随高度变，add 时再看）
  mark?: 'river' | 'peak' | 'islet';
  // 标注放在这一格（质心落在地物外面时才有，见 withLabels）
  labelCell?: number;
  // 涂出来的生态区：涂的生态的下标
  species?: number;
}

// 各段的输入只取决于少数几个推导数组（陆海、高度、湖、坡度、河道、生态）：这些数组逐字节没变时直接用上次
// 记下的（只改气候时省掉大半）。按网格、按段各留两份（预览用的副本不会把正在用的挤掉）；
// 记下的是新建的数组（格子存成 Int32Array，不占 JS 堆），只读，不与推导数组共用（推导数组之后会被就地改写）
const memo = new WeakMap<Mesh, Map<string, { key: Uint8Array[]; value: unknown }[]>>();
// 测试用：on = false 时不读也不写缓存，每次从头算；hits：命中的段数
export const featureMemo = { on: true, hits: 0 };

const bytesOf = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

// 逐字节相同（-0 与 0、不同的 NaN 都算不同）；对齐时 4 个字节一比
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let k = 0;
  if (a.byteOffset % 4 === 0 && b.byteOffset % 4 === 0) {
    const m = a.length >> 2;
    const x = new Int32Array(a.buffer, a.byteOffset, m);
    const y = new Int32Array(b.buffer, b.byteOffset, m);
    for (let i = 0; i < m; i++) if (x[i] !== y[i]) return false;
    k = m * 4;
  }
  for (; k < a.length; k++) if (a[k] !== b[k]) return false;
  return true;
}

// 输入（类型数组；数值放进 Float64Array）与记下的某一份逐字节相同时用它的结果，否则算一遍再记下
function memoized<T>(mesh: Mesh, name: string, inputs: ArrayBufferView[], compute: () => T): T {
  if (!featureMemo.on) return compute();
  const key = inputs.map(bytesOf);
  let byName = memo.get(mesh);
  if (!byName) memo.set(mesh, (byName = new Map()));
  const list = byName.get(name) ?? [];
  // 同一段的键可能长短不一（生态区：没涂过时只看大类）
  const hit = list.find((m) => m.key.length === key.length && m.key.every((b, k) => sameBytes(b, key[k])));
  if (hit) {
    featureMemo.hits++;
    byName.set(name, [hit, ...list.filter((m) => m !== hit)]);
    return hit.value as T;
  }
  const value = compute();
  byName.set(name, [{ key: key.map((b) => b.slice()), value }, ...list].slice(0, 2));
  return value;
}

// 记下一次 add 的输入
function put(list: AddInput[], type: FeatureType, cells: number[], importance: number, tags: string[] = [], anchor?: number, mark?: AddInput['mark']) {
  list.push({ type, cells: Int32Array.from(cells), importance, tags, anchor, mark });
}

// 标注放在地物自己的格上：质心所在的格不属于地物（弯月形的海、中间被涂成别的生态的森林）时，改放在离边界最远的格；
// 质心在地物里的照旧标在质心。在各段的缓存里算好（只在输入变了时算），不是每次编辑都算。
// 群岛（岛与岛之间本来就是海）、河（沿河标注）、山峰（标在峰顶）不算
function withLabels(mesh: Mesh, list: AddInput[]): AddInput[] {
  for (const a of list) {
    if (a.mark === 'river' || a.mark === 'peak' || a.type === 'archipelago') continue;
    const ax = axis(mesh, a.cells, unwrapped(mesh, a.cells));
    const c = findCell(mesh, mesh.kind === 'sphere' ? wrapX(ax.x) : ax.x, ax.y);
    if (!a.cells.includes(c)) a.labelCell = innermost(mesh, a.cells, ax.x, ax.y);
  }
  return list;
}

// 面积（km²），逐格相加
function areaOf(world: World, cells: ArrayLike<number>): number {
  const { mesh, kmPerUnit } = world;
  let s = 0;
  for (let k = 0; k < cells.length; k++) s += mesh.area[cells[k]] * kmPerUnit * kmPerUnit;
  return s;
}

// 整张图的面积（km²）：整个星球的面积是 4πR²（宽 × 高不是）
function mapAreaOf(world: World): number {
  const { mesh, kmPerUnit } = world;
  return mesh.kind === 'sphere' ? mesh.totalArea * kmPerUnit * kmPerUnit : mesh.width * mesh.height * kmPerUnit * kmPerUnit;
}

// 陆块、群岛、半岛、海峡、海湾、海与洋：只取决于陆海。dLand：陆地格离海岸的步数（盆地也用）
function terrainInputs(world: World): { list: AddInput[]; dLand: Int32Array } {
  const { mesh, kmPerUnit } = world;
  const n = mesh.n;
  const land = world.causes.land;
  const globe = mesh.kind === 'sphere';
  const mapKm2 = mapAreaOf(world);
  const avgCellKm2 = mapKm2 / n;
  const list: AddInput[] = [];

  // 陆块
  const landMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) landMask[i] = land[i];
  const masses = components(mesh, landMask);
  const massOf = new Int32Array(n).fill(-1);
  masses.forEach((cells, k) => {
    for (const c of cells) massOf[c] = k;
  });
  // 整个星球：约 1.25% 的星球面积（类地星球约 640 万 km²：澳大利亚算大陆，格陵兰算岛）
  const continentKm2 = globe ? Math.max(1.5e6, mapKm2 * 0.0125) : Math.max(1.5e6, mapKm2 * 0.06);
  const islandIdx: number[] = [];
  masses.forEach((cells, k) => {
    const area = areaOf(world, cells);
    if (area >= continentKm2) put(list, 'continent', cells, 10 + Math.log10(area));
    else if (cells.length >= 2) {
      islandIdx.push(k);
      const tags = [area > avgCellKm2 * 400 ? 'large' : area < avgCellKm2 * 6 ? 'small' : ''];
      put(list, 'island', cells, 4 + Math.log10(area), tags.filter(Boolean), undefined, cells.length < 120 ? 'islet' : undefined);
    }
  });

  // 群岛：相距不超过 3 步海路的岛连成一组，4 个以上为群岛
  {
    const parent = masses.map((_, k) => k);
    const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k])));
    const sea = new Uint8Array(n);
    for (let i = 0; i < n; i++) sea[i] = land[i] ? 0 : 1;
    const owner = new Int32Array(n).fill(-1);
    const dist = new Int32Array(n).fill(-1);
    const q: number[] = [];
    const isIsland = new Uint8Array(masses.length);
    for (const k of islandIdx) isIsland[k] = 1;
    for (let i = 0; i < n; i++) {
      if (!land[i] || !isIsland[massOf[i]]) continue;
      owner[i] = massOf[i];
      dist[i] = 0;
      q.push(i);
    }
    for (let h = 0; h < q.length; h++) {
      const c = q[h];
      if (dist[c] >= 3) continue;
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
        const j = mesh.adj[e];
        if (owner[j] >= 0) {
          if (owner[j] !== owner[c]) parent[find(owner[j])] = find(owner[c]);
          continue;
        }
        if (!sea[j]) continue;
        owner[j] = owner[c];
        dist[j] = dist[c] + 1;
        q.push(j);
      }
    }
    const groups = new Map<number, number[]>();
    for (const k of islandIdx) {
      const r = find(k);
      const g = groups.get(r) ?? [];
      g.push(k);
      groups.set(r, g);
    }
    for (const g of groups.values()) {
      if (g.length < 4) continue;
      const cells = g.flatMap((k) => masses[k]);
      const biggest = g.reduce((a, b) => (masses[a].length >= masses[b].length ? a : b));
      put(list, 'archipelago', cells, 7 + Math.log10(areaOf(world, cells)), [], stableAnchor(masses[biggest]));
    }
  }

  // 海岸距离（陆地内部、海内部各自）
  const seaMask = new Uint8Array(n);
  const coastLand: number[] = [];
  const coastSea: number[] = [];
  for (let i = 0; i < n; i++) {
    seaMask[i] = land[i] ? 0 : 1;
    let edge = false;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (land[mesh.adj[e]] !== land[i]) edge = true;
    if (edge) (land[i] ? coastLand : coastSea).push(i);
  }
  const dLand = steps(mesh, coastLand, landMask);
  const dSea = steps(mesh, coastSea, seaMask);

  // 半岛：开运算（腐蚀 r 步再膨胀 r 步）削掉的、连着大块陆地的部分
  {
    const taken = new Uint8Array(n);
    for (const r of [6, 3]) {
      const core: number[] = [];
      for (let i = 0; i < n; i++) if (land[i] && dLand[i] >= r) core.push(i);
      if (!core.length) continue;
      const opened = steps(mesh, core, landMask, r);
      const rest = new Uint8Array(n);
      for (let i = 0; i < n; i++) rest[i] = land[i] && opened[i] < 0 && !taken[i] ? 1 : 0;
      for (const cells of components(mesh, rest)) {
        if (cells.length < Math.max(12, r * r)) continue;
        // 连着开运算后保留的陆地（半岛，不是独立小岛）
        let attached = false;
        for (const c of cells) for (let e = mesh.off[c]; e < mesh.off[c + 1] && !attached; e++) if (opened[mesh.adj[e]] >= 0) attached = true;
        if (!attached) continue;
        for (const c of cells) taken[c] = 1;
        put(list, 'peninsula', cells, 5 + Math.log10(areaOf(world, cells)));
      }
    }
  }

  // 海峡：海做开运算削掉的窄处，两侧是不同的陆块（先于海湾识别，海湾不吞掉海峡）
  const straitMask = new Uint8Array(n);
  {
    const core: number[] = [];
    for (let i = 0; i < n; i++) if (!land[i] && dSea[i] >= 2) core.push(i);
    const opened = steps(mesh, core, seaMask, 2);
    const narrow = new Uint8Array(n);
    for (let i = 0; i < n; i++) narrow[i] = !land[i] && opened[i] < 0 ? 1 : 0;
    for (const cells of components(mesh, narrow)) {
      if (cells.length < 2 || cells.length > 250) continue;
      const shores = new Set<number>();
      for (const c of cells) for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) if (land[mesh.adj[e]]) shores.add(massOf[mesh.adj[e]]);
      if (shores.size < 2) continue;
      for (const c of cells) straitMask[c] = 1;
      put(list, 'strait', cells, 5.5);
    }
  }

  // 海湾：闭运算（陆地膨胀 r 步再腐蚀 r 步）补出来的凹处
  {
    const taken = new Uint8Array(n);
    for (const r of [7, 3]) {
      const far: number[] = [];
      for (let i = 0; i < n; i++) if (!land[i] && (dSea[i] < 0 || dSea[i] > r)) far.push(i);
      if (!far.length) continue;
      const fromFar = steps(mesh, far, seaMask, r);
      const bay = new Uint8Array(n);
      for (let i = 0; i < n; i++) bay[i] = !land[i] && fromFar[i] < 0 && !taken[i] && !straitMask[i] ? 1 : 0;
      for (const cells of components(mesh, bay)) {
        if (cells.length < Math.max(5, r * 2)) continue;
        for (const c of cells) taken[c] = 1;
        put(list, 'bay', cells, 5.5 + Math.log10(areaOf(world, cells)), cells.length > 60 ? ['large'] : []);
      }
    }
  }

  // 海与洋：在离岸远的地方撒种子，按距离分区
  {
    const seaCells: number[] = [];
    for (let i = 0; i < n; i++) if (!land[i]) seaCells.push(i);
    if (seaCells.length) {
      let seaKm2 = 0;
      for (const c of seaCells) seaKm2 += mesh.area[c] * kmPerUnit * kmPerUnit;
      // 整个星球按面积比例分区（星球大小不影响分法）
      const k = globe ? Math.max(3, Math.min(18, Math.round((seaKm2 / mapKm2) * 22))) : Math.max(1, Math.min(12, Math.round(seaCells.length / 2600)));
      const spacing = Math.max(4, Math.round(Math.sqrt(seaCells.length / k) * 0.8));
      // 候选种子按离岸从远到近、同距离按编号排（计数排序）；离岸不到 1 步的不当种子
      let maxD = 0;
      for (const c of seaCells) maxD = Math.max(maxD, dSea[c]);
      const at = new Int32Array(maxD + 1);
      for (const c of seaCells) if (dSea[c] >= 1) at[maxD - dSea[c] + 1]++;
      for (let b = 1; b <= maxD; b++) at[b] += at[b - 1];
      const order = new Int32Array(at[maxD]);
      for (const c of seaCells) if (dSea[c] >= 1) order[at[maxD - dSea[c]]++] = c;
      // 每个种子 spacing 步海路以内的格不再当种子：只走到 spacing 步，走过的格按种子的序号标记（不必每次清空）
      const blocked = new Uint8Array(n);
      const stamp = new Int32Array(n);
      const dist = new Int32Array(n);
      const q = new Int32Array(n);
      const seeds: number[] = [];
      for (const c of order) {
        if (seeds.length >= Math.ceil(k * 1.5)) break;
        if (blocked[c]) continue;
        seeds.push(c);
        const s = seeds.length;
        stamp[c] = s;
        dist[c] = 0;
        blocked[c] = 1;
        q[0] = c;
        for (let h = 0, t = 1; h < t; h++) {
          const x = q[h];
          if (dist[x] >= spacing) continue;
          for (let e = mesh.off[x]; e < mesh.off[x + 1]; e++) {
            const j = mesh.adj[e];
            if (seaMask[j] && stamp[j] !== s) {
              stamp[j] = s;
              dist[j] = dist[x] + 1;
              blocked[j] = 1;
              q[t++] = j;
            }
          }
        }
      }
      // 多源 BFS 分区
      const owner = new Int32Array(n).fill(-1);
      const queue: number[] = [];
      seeds.forEach((s, idx) => {
        owner[s] = idx;
        queue.push(s);
      });
      for (let h = 0; h < queue.length; h++) {
        const c = queue[h];
        for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
          const j = mesh.adj[e];
          if (!land[j] && owner[j] < 0) {
            owner[j] = owner[c];
            queue.push(j);
          }
        }
      }
      const regions: number[][] = seeds.map(() => []);
      for (const c of seaCells) if (owner[c] >= 0) regions[owner[c]].push(c);
      const totalSea = seaCells.length;
      regions.forEach((cells) => {
        if (cells.length < 12) return;
        let meanD = 0;
        for (const c of cells) meanD += Math.max(0, dSea[c]);
        meanD /= cells.length;
        const ocean = globe ? areaOf(world, cells) > mapKm2 * 0.035 && meanD > 6 : cells.length > totalSea * 0.18 && meanD > 6;
        put(list, ocean ? 'ocean' : 'sea', cells, (ocean ? 9.5 : 7.5) + Math.log10(areaOf(world, cells)));
      });
    }
  }
  return { list: withLabels(mesh, list), dLand };
}

// 湖：只取决于湖面与高度（没挖河床的地形）
function lakeInputs(world: World, d: Derived, terrain: ArrayLike<number>): AddInput[] {
  const { mesh } = world;
  const n = mesh.n;
  const avgCellKm2 = mapAreaOf(world) / n;
  const list: AddInput[] = [];
  const lakeMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) lakeMask[i] = d.lake[i] === 1 ? 1 : 0;
  for (const cells of components(mesh, lakeMask)) {
    const area = areaOf(world, cells);
    const tags = [area > avgCellKm2 * 30 ? 'large' : ''];
    let h = 0;
    for (const c of cells) h += terrain[c];
    if (h / cells.length > 2000) tags.push('high');
    put(list, 'lake', cells, 5 + Math.log10(area), tags.filter(Boolean));
  }
  return withLabels(mesh, list);
}

// 大河：从河口沿流量最大的支流上溯。只取决于陆海、流向、流量、湖面与河的门槛
function riverInputs(world: World, d: Derived): AddInput[] {
  const n = world.mesh.n;
  const land = world.causes.land;
  const thr = world.small.planet.riverThreshold;
  const list: AddInput[] = [];
  // 每格的上游（CSR：donors[donorAt[c] .. donorAt[c + 1])），同一格的上游按编号从小到大
  const donorAt = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) {
    const r = d.receiver[i];
    if (land[i] && r >= 0 && land[r]) donorAt[r + 1]++;
  }
  for (let i = 0; i < n; i++) donorAt[i + 1] += donorAt[i];
  const donors = new Int32Array(donorAt[n]);
  const fill = donorAt.slice(0, n);
  for (let i = 0; i < n; i++) {
    const r = d.receiver[i];
    if (land[i] && r >= 0 && land[r]) donors[fill[r]++] = i;
  }
  const mouths: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!land[i] || d.lake[i] === 1 || d.discharge[i] < thr * 3) continue;
    const r = d.receiver[i];
    if (r < 0 || !land[r] || d.lake[r] === 1) mouths.push(i);
  }
  mouths.sort((a, b) => d.discharge[b] - d.discharge[a]);
  for (const m of mouths.slice(0, 40)) {
    const stem: number[] = [m];
    let c = m;
    for (let guard = 0; guard < n; guard++) {
      let best = -1;
      for (let e = donorAt[c]; e < donorAt[c + 1]; e++) {
        const j = donors[e];
        if (d.lake[j] !== 1 && d.discharge[j] >= thr && (best < 0 || d.discharge[j] > d.discharge[best])) best = j;
      }
      if (best < 0) break;
      stem.push(best);
      c = best;
    }
    if (stem.length < 6) continue;
    const q = d.discharge[m];
    const size = q > thr * 40 ? 'big' : q > thr * 6 ? '' : 'small';
    put(list, 'river', stem, 6 + Math.log10(q), size ? [size] : [], m, 'river');
  }
  return list;
}

// 坡度（m/km），与水文里算的 d.slope 同一个算式（结果逐值相同）。按没挖河床的地形认高原、平原时用
function slopeOf(world: World, elevation: ArrayLike<number>): Float32Array {
  const { mesh, kmPerUnit } = world;
  const n = mesh.n;
  const land = world.causes.land;
  const hPos = new Float64Array(n);
  for (let i = 0; i < n; i++) hPos[i] = land[i] ? elevation[i] : 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue;
    const [gx, gy] = gradient(mesh, hPos, i);
    out[i] = Math.hypot(gx, gy) / kmPerUnit;
  }
  return out;
}

// 没挖河床的地形的坡度：没有只挖河床的河时就是水文算好的那份（两者逐值相同），有的话按地形另算（按内容缓存）
function terrainSlope(world: World, d: Derived, terrain: Float32Array): ArrayLike<number> {
  if (terrain === d.elevation || !world.small.guides.some((g) => g.carve === 'bed')) return d.slope;
  return memoized(world.mesh, 'slope', [world.causes.land, terrain], () => slopeOf(world, terrain));
}

// 山脉与主峰；高原；平原；盆地：只取决于陆海、湖面、高度、坡度（dLand 由陆海算出）。
// 高度、坡度按没挖河床的地形（elevation、slope）：画的峡谷不会把山脉切成两段、换掉主峰，山名不变
function reliefInputs(world: World, d: Derived, dLand: Int32Array, elevation: ArrayLike<number>, slope: ArrayLike<number>): AddInput[] {
  const { mesh } = world;
  const n = mesh.n;
  const land = world.causes.land;
  const list: AddInput[] = [];
  const mountain = new Uint8Array(n);
  for (let i = 0; i < n; i++) mountain[i] = land[i] && d.lake[i] !== 1 && elevation[i] >= 1300 ? 1 : 0;
  for (const cells of components(mesh, mountain)) {
    if (cells.length < 6) continue;
    let peak = cells[0];
    for (const c of cells) if (elevation[c] > elevation[peak]) peak = c;
    const volcanic = cells.length < 40 && elevation[peak] > 1500;
    put(list, 'range', cells, 6.5 + Math.log10(areaOf(world, cells)), volcanic ? ['volcanic'] : []);
    if (elevation[peak] >= 2600 || (volcanic && elevation[peak] >= 1500)) {
      put(list, 'peak', [peak], 5 + elevation[peak] / 3000, volcanic ? ['volcanic'] : [], peak, 'peak');
    }
  }
  const plateau = new Uint8Array(n);
  const plain = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!land[i] || d.lake[i] === 1) continue;
    if (elevation[i] >= 1200 && slope[i] <= 8) plateau[i] = 1;
    if (elevation[i] <= 400 && slope[i] <= 2.5) plain[i] = 1;
  }
  for (const cells of components(mesh, plateau)) if (cells.length >= 15) put(list, 'plateau', cells, 6 + Math.log10(areaOf(world, cells)));
  const plains = components(mesh, plain).filter((c) => c.length >= 40).sort((a, b) => b.length - a.length).slice(0, 8);
  for (const cells of plains) put(list, 'plain', cells, 5.5 + Math.log10(areaOf(world, cells)));
  // 盆地：被高出很多的地形围住的低地
  const basin = new Uint8Array(n);
  const near = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue;
    let mx = elevation[i];
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) mx = Math.max(mx, elevation[mesh.adj[e]]);
    near[i] = mx;
  }
  for (let pass = 0; pass < 4; pass++) {
    const next = Float64Array.from(near);
    for (let i = 0; i < n; i++) {
      if (!land[i]) continue;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) next[i] = Math.max(next[i], near[mesh.adj[e]]);
    }
    near.set(next);
  }
  for (let i = 0; i < n; i++) if (land[i] && elevation[i] < 900 && near[i] - elevation[i] > 1400 && dLand[i] > 3) basin[i] = 1;
  for (const cells of components(mesh, basin)) if (cells.length >= 20) put(list, 'basin', cells, 5.5 + Math.log10(areaOf(world, cells)));
  return withLabels(mesh, list);
}

const BIOMES = ['desert', 'forest', 'tundra', 'icecap', 'wetland'] as const;
type BiomeGroup = (typeof BIOMES)[number];

// 一种生态属于哪一大类：冰盖是冰原，其余按导出用的地形类别；草原、稀树草原、灌丛等都不是（''）
function speciesGroup(sp: Species): BiomeGroup | '' {
  if (sp.id === 'ice') return 'icecap';
  if (sp.terrain === 'desert') return 'desert';
  if (sp.terrain === 'forest' || sp.terrain === 'jungle') return 'forest';
  if (sp.terrain === 'arctic') return 'tundra';
  if (sp.terrain === 'marsh') return 'wetland';
  return '';
}

// 每格属于哪一大类（BIOMES 里的下标 + 1，0 为都不是）
function biomesOf(world: World, d: Derived): Uint8Array {
  const n = world.mesh.n;
  const land = world.causes.land;
  const kindOf = world.small.species.map((sp) => (BIOMES as readonly string[]).indexOf(speciesGroup(sp)) + 1);
  const biome = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (land[i] && d.dominant[i] >= 0) biome[i] = kindOf[d.dominant[i]];
  return biome;
}

const BUILTIN_SPECIES = new Set(DEFAULT_SPECIES.map((sp) => sp.id));

// 涂出来的一片生态按哪种地物识别、叫什么、怎么起名，只在这里定（生态以后自带地名设定时也接在这里）：
// - 内置且有大类的生态（针叶林、热带雨林、荒漠……）：沿用大类的类型和模板，热带的（jungle）带“热”，模板里有雨林；
// - 其余（温带草原、稀树草原、地中海灌木、自定义的生态）：类型是“生态区”，
//   模板先找文字包里的 biome.<id>，再找 biome，文字包里都没有（导入的旧文字包）时用内置包的模板和词表。
// 类型名（地名表、底部条）就是生态的名字；模板里的 {__species} 换成它
export function speciesFeature(sp: Species): { type: FeatureType; label: string; tags: string[]; naming: (pack: WordPack) => { pack: WordPack; type: string } } {
  const group = speciesGroup(sp);
  const type: FeatureType = group && BUILTIN_SPECIES.has(sp.id) ? group : 'biome';
  const label = sp.name || FEATURE_INFO[type].label;
  const naming = (pack: WordPack) => {
    if (type !== 'biome') return { pack: withSpecies(pack, label), type };
    for (const p of [pack, DEFAULT_PACK]) {
      const t = p.types[`biome.${sp.id}`] ? `biome.${sp.id}` : p.types.biome ? 'biome' : '';
      if (t) return { pack: withSpecies(p, label), type: t };
    }
    return { pack: withSpecies(DEFAULT_PACK, label), type: 'biome' };
  };
  return { type, label, tags: sp.terrain === 'jungle' ? ['hot'] : [], naming };
}

// 文字包加上只有一项的词表 __species（生态的名字）；按文字包、名字各留一份
const speciesPacks = new WeakMap<WordPack, Map<string, WordPack>>();
function withSpecies(pack: WordPack, name: string): WordPack {
  let byName = speciesPacks.get(pack);
  if (!byName) speciesPacks.set(pack, (byName = new Map()));
  let p = byName.get(name);
  if (!p) byName.set(name, (p = { ...pack, lists: { ...pack.lists, __species: [name] } }));
  return p;
}

// 生态区这一段的缓存键里每种生态的样子（speciesFeature 给出的类型、标签，以及 id：锚点按 id 加盐）
function speciesKey(species: Species[]): Int32Array {
  const out = new Int32Array(species.length * 3);
  species.forEach((sp, s) => {
    const f = speciesFeature(sp);
    out[s * 3] = FEATURE_TYPES.indexOf(f.type);
    out[s * 3 + 1] = f.tags.length;
    out[s * 3 + 2] = hashString(sp.id);
  });
  return out;
}

// 涂上去、并且涂成了的格：每格是涂的生态的下标（后涂的盖住先涂的），没涂或没涂成为 -1。一格都没有时为 null
function paintedOf(world: World, d: Derived): Int16Array | null {
  const n = world.mesh.n;
  const land = world.causes.land;
  const species = world.small.species;
  let out: Int16Array | null = null;
  for (const c of world.small.constraints) {
    const s = species.findIndex((sp) => sp.id === c.species);
    if (s < 0) continue;
    for (const i of c.cells) {
      if (i >= n || !land[i] || d.dominant[i] !== s) continue;
      if (!out) out = new Int16Array(n).fill(-1);
      out[i] = s;
    }
  }
  return out;
}

// 涂过的世界里，生态区还要看的几样（都在缓存的键里）
interface Paint {
  // 每格涂的生态（paintedOf）
  painted: Int16Array;
  // 每格的主导生态、陆海
  dominant: Int16Array;
  land: Uint8Array;
}

// 大片生态区：只取决于每格的大类。涂过生态时：
// - 每个大类的连通块 G 里，没涂的格最多的那种生态是“周围自然的生态”（没涂的格太少时不认）；
// - 涂的生态与它不同的格（不在任何大类里的也算）按生态连成块，8 格以上的成为自己的地物（涂出来的生态区），
//   锚点按生态加盐、名字种子里带上生态，第二轮起名（不抢原有地物的名字）；
// - G 去掉这些块剩下的仍是原来的地物，锚点只在“没涂的格 + 被 G 包住的涂抹洞”里取：
//   在森林中间涂别的生态、在森林里补涂同一种，锚点都不动；往外涂出去的部分不算，森林往外长名字也不变。
//   涂抹连着森林外面、又盖住了原来锚点的（在森林边上涂一片），没涂的部分换一个锚点、换名字；
//   改气候（温度画笔、自然融入的影响范围）让锚点那一格不再是森林时也一样（用户起的名字只要原锚点还在这片地物里就留得住）
function natureInputs(world: World, biome: Uint8Array, paint: Paint | null): AddInput[] {
  const { mesh } = world;
  const n = mesh.n;
  const list: AddInput[] = [];
  // 各大类的连通块；gOf：每格属于第几块
  const groups: { k: number; cells: number[] }[] = [];
  const gOf = new Int32Array(n).fill(-1);
  for (let k = 0; k < BIOMES.length; k++) {
    const mask = new Uint8Array(n);
    for (let i = 0; i < n; i++) mask[i] = biome[i] === k + 1 ? 1 : 0;
    for (const cells of components(mesh, mask)) {
      for (const c of cells) gOf[c] = groups.length;
      groups.push({ k, cells });
    }
  }
  const painted = paint?.painted;
  // 涂出来的生态区（下标 → 格）与它们占的格；每块的锚点取值范围（没涂过的块就是它自己）
  const regions: { s: number; cells: number[] }[] = [];
  const kept = new Uint8Array(n);
  const domain: (number[] | null)[] = groups.map(() => null);
  if (paint && painted) {
    const S = world.small.species.length;
    // 周围自然的生态：没涂的格里最多的那种（并列取下标小的）；没涂的格不到 max(8, 1/4) 时不认（-1），
    // 免得一两格自然长出的同种生态让涂的块在“生态区”和“原来的地物”之间来回跳
    const nat = new Int32Array(groups.length).fill(-1);
    const count = new Int32Array(Math.max(1, S));
    groups.forEach((g, gi) => {
      count.fill(0);
      let unpainted = 0;
      for (const c of g.cells) {
        if (painted[c] >= 0) continue;
        unpainted++;
        if (paint.dominant[c] >= 0) count[paint.dominant[c]]++;
      }
      if (unpainted === g.cells.length || unpainted < Math.max(8, g.cells.length * 0.25)) return;
      let best = -1;
      for (let s = 0; s < S; s++) if (count[s] > (best < 0 ? 0 : count[best])) best = s;
      nat[gi] = best;
    });
    // 外来的格：涂的生态与周围自然的不同
    const foreign = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (painted[i] >= 0 && (gOf[i] < 0 || nat[gOf[i]] !== painted[i])) foreign[i] = 1;
    // 同一种生态连成的块：8 格以上，每种取最大的 10 块
    const seen = new Uint8Array(n);
    const bySpecies = new Map<number, number[][]>();
    for (let i = 0; i < n; i++) {
      if (!foreign[i] || seen[i]) continue;
      const s = painted[i];
      const q = [i];
      seen[i] = 1;
      for (let h = 0; h < q.length; h++) {
        const c = q[h];
        for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
          const j = mesh.adj[e];
          if (foreign[j] && !seen[j] && painted[j] === s) {
            seen[j] = 1;
            q.push(j);
          }
        }
      }
      const l = bySpecies.get(s) ?? [];
      l.push(q);
      bySpecies.set(s, l);
    }
    for (const s of [...bySpecies.keys()].sort((a, b) => a - b)) {
      const comps = bySpecies
        .get(s)!
        .filter((c) => c.length >= 8)
        .sort((a, b) => b.length - a.length)
        .slice(0, 10);
      for (const cells of comps) {
        regions.push({ s, cells });
        for (const c of cells) kept[c] = 1;
      }
    }
    // 锚点的取值范围：没涂的格，加上被它包住的涂抹洞（涂过的格连成的块，挨着的没涂的陆地全属于这一块；
    // 湖不算外面，海、地图边算外面）。往外涂出去的块挨着别的陆地，不算
    groups.forEach((g, gi) => {
      if (g.cells.some((c) => painted[c] >= 0)) domain[gi] = g.cells.filter((c) => painted[c] < 0);
    });
    const seenP = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (painted[i] < 0 || seenP[i]) continue;
      const q = [i];
      seenP[i] = 1;
      let owner = -1;
      let enclosed = true;
      for (let h = 0; h < q.length; h++) {
        const c = q[h];
        if (mesh.boundary[c]) enclosed = false;
        for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
          const j = mesh.adj[e];
          if (painted[j] >= 0) {
            if (!seenP[j]) {
              seenP[j] = 1;
              q.push(j);
            }
            continue;
          }
          // 湖（陆上主导生态为 -1 的只有湖；什么都长不了的格是 -2，算外面）
          if (paint.land[j] && paint.dominant[j] === -1) continue;
          const gj = gOf[j];
          if (gj < 0 || (owner >= 0 && owner !== gj)) enclosed = false;
          else owner = gj;
        }
      }
      if (!enclosed || owner < 0) continue;
      // 逐格加（大星球上一个洞可能有几万格，展开成参数会超出调用栈）
      const dom = (domain[owner] ??= groups[owner].cells.filter((c) => painted[c] < 0));
      for (const c of q) dom.push(c);
    }
  }
  // 原来的地物：每个大类按剩下的格数取最大的 10 块（没涂过时与原来完全相同）
  const usedBy = new Map<FeatureType, Set<number>>();
  const usedOf = (t: FeatureType) => {
    let u = usedBy.get(t);
    if (!u) usedBy.set(t, (u = new Set()));
    return u;
  };
  for (let k = 0; k < BIOMES.length; k++) {
    const g = BIOMES[k];
    const min = g === 'wetland' ? 12 : 30;
    const rests: { gi: number; cells: number[] }[] = [];
    groups.forEach((G, gi) => {
      if (G.k !== k) return;
      const cells = regions.length ? G.cells.filter((c) => !kept[c]) : G.cells;
      if (cells.length >= min) rests.push({ gi, cells });
    });
    rests.sort((a, b) => b.cells.length - a.cells.length);
    const used = usedOf(g);
    for (const { gi, cells } of rests.slice(0, 10)) {
      const dom = domain[gi];
      let anchor = stableAnchor(dom?.length ? dom : cells);
      if (used.has(anchor)) anchor = freeAnchor(cells, used);
      if (anchor < 0) continue;
      used.add(anchor);
      put(list, g, cells, 5 + Math.log10(areaOf(world, cells)), [], anchor);
    }
  }
  // 涂出来的生态区：重要度比同样大的自然地物高一点（刚涂的标注优先放上）
  for (const { s, cells } of regions) {
    const sp = world.small.species[s];
    const info = speciesFeature(sp);
    const used = usedOf(info.type);
    const anchor = freeAnchor(cells, used, hashString(sp.id));
    if (anchor < 0) continue;
    used.add(anchor);
    list.push({ type: info.type, cells: Int32Array.from(cells), importance: 6 + Math.log10(areaOf(world, cells)), tags: info.tags, anchor, species: s });
  }
  return withLabels(mesh, list);
}

// terrain：没挖河床的地形（引擎里自然求解的高程）。山脉、山峰、高原、平原、盆地、湖的高低和“高”这个标签都按它认，
// 所以画一条峡谷不会让山改名；省略时用推导的高程（没有只挖河床的河时两者逐值相同）
export function detectFeatures(world: World, d: Derived, terrain: Float32Array = d.elevation): GeoFeature[] {
  const { mesh, causes, small, kmPerUnit } = world;
  const globe = mesh.kind === 'sphere';
  const out: GeoFeature[] = [];

  const climateTags = (cells: Int32Array) => tagsOf(world, d, cells, terrain);

  const add = (type: FeatureType, cells: Int32Array, importance: number, extraTags: string[] = [], anchor?: number) => {
    if (!cells.length) return;
    const a = anchor ?? stableAnchor(cells);
    const ax = axis(mesh, cells, unwrapped(mesh, cells));
    out.push({
      key: `${type}:${a}`,
      type,
      anchor: a,
      cells: cells.slice(),
      areaKm2: areaOf(world, cells),
      x: ax.x,
      y: ax.y,
      angle: ax.angle,
      span: ax.span,
      tags: [...new Set([...climateTags(cells), ...extraTags])],
      importance,
      name: '',
      custom: false,
    });
  };

  // 按记下的输入逐个 add
  const replay = (list: AddInput[]) => {
    for (const a of list) {
      let tags = a.tags;
      if (a.mark === 'islet') {
        let maxH = 0;
        for (const c of a.cells) maxH = Math.max(maxH, terrain[c]);
        if (maxH > 1400) tags = [...tags, 'volcanic'];
      }
      const before = out.length;
      add(a.type, a.cells, a.importance, tags, a.anchor);
      if (out.length === before) continue;
      const f = out[before];
      if (a.species !== undefined) f.species = small.species[a.species].id;
      if (a.labelCell !== undefined) {
        f.x = mesh.x[a.labelCell];
        f.y = mesh.y[a.labelCell];
      }
      if (a.mark === 'peak') {
        f.x = mesh.x[a.cells[0]];
        f.y = mesh.y[a.cells[0]];
      } else if (a.mark === 'river') {
        // 标注沿河中段
        const line = Array.from(a.cells, (s) => [mesh.x[s], mesh.y[s]] as [number, number]).reverse();
        // 整个星球：沿河展开经度，跨过接缝的河也是连续的一条线
        if (globe) for (let k = 1; k < line.length; k++) line[k][0] = line[k - 1][0] + wrapDelta(line[k][0] - line[k - 1][0]);
        f.line = line;
        const mid = Math.floor(line.length / 2);
        f.x = globe ? wrapX(line[mid][0]) : line[mid][0];
        f.y = line[mid][1];
      }
    }
  };

  // 各段按它实际读的数组缓存（数值放进 Float64Array）；段的先后就是地物的先后
  const km = Float64Array.of(kmPerUnit);
  const coast = memoized(mesh, 'terrain', [causes.land, km], () => terrainInputs(world));
  replay(coast.list);
  replay(memoized(mesh, 'lake', [d.lake, terrain, km], () => lakeInputs(world, d, terrain)));
  const rivers = memoized(mesh, 'river', [causes.land, d.receiver, d.discharge, d.lake, Float64Array.of(small.planet.riverThreshold)], () => riverInputs(world, d));
  // 有名字的画的河占了的自然大河不再单独标（同一条河只标一次）；没有这种河时照旧
  const named = namedGuideCells(world, d);
  replay(named ? rivers.filter((a) => !coveredBy(a, named)) : rivers);
  // 坡度由地形、陆海算出，所以不进键（只在这一段要重算时才取）
  replay(memoized(mesh, 'relief', [causes.land, d.lake, terrain, km], () => reliefInputs(world, d, coast.dLand, terrain, terrainSlope(world, d, terrain))));
  const biome = biomesOf(world, d);
  // 没涂过生态时只看大类（与原来相同）；涂过时还要看涂了什么、每格的主导生态、陆海与每种生态的样子
  const painted = paintedOf(world, d);
  if (!painted) replay(memoized(mesh, 'nature', [biome, km], () => natureInputs(world, biome, null)));
  else {
    const paint = { painted, dominant: d.dominant, land: causes.land };
    replay(memoized(mesh, 'nature', [biome, painted, d.dominant, causes.land, speciesKey(small.species), km], () => natureInputs(world, biome, paint)));
  }

  out.push(...regionFeatures(world, d, terrain), ...guideFeatures(world, d, terrain));
  assignNames(world, out);
  return out;
}

// ---------- 画的河 ----------

// 有名字的河道（有 name 或 nameKey）：画的河、固定下来的自然河
const named = (g: Guide) => g.name !== undefined || g.nameKey !== undefined;

// 有名字的画的河自己的格（见 rivers.ts 的 guideBody）；没有这种河时为 null
function namedGuideCells(world: World, d: Derived): Uint8Array | null {
  let mask: Uint8Array | null = null;
  for (const g of world.small.guides) {
    if (!named(g)) continue;
    mask ??= new Uint8Array(world.mesh.n);
    for (const c of guideBody(world, d, g)) mask[c] = 1;
  }
  return mask;
}

// 自然的大河是不是就是画的那条：河口在画的河里，或者一半以上的格在里面
function coveredBy(a: AddInput, mask: Uint8Array): boolean {
  if (a.type !== 'river') return false;
  if (a.anchor !== undefined && mask[a.anchor]) return true;
  let k = 0;
  for (const c of a.cells) k += mask[c];
  return k * 2 >= a.cells.length;
}

// 沿折线每隔 step 取一点（含两端）：标注的位置、方向按它（与自然的河按格心一样，点大致均匀）
function alongLine(pts: readonly [number, number][], step: number): [number, number][] {
  if (pts.length < 2) return pts.map((p) => [p[0], p[1]]);
  const out: [number, number][] = [[pts[0][0], pts[0][1]]];
  let need = step;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k];
    const [bx, by] = pts[k + 1];
    const len = Math.hypot(bx - ax, by - ay);
    let t = 0;
    while (len - t >= need) {
      t += need;
      need = step;
      out.push([ax + ((bx - ax) * t) / len, ay + ((by - ay) * t) / len]);
    }
    need -= len - t;
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (tail[0] !== last[0] || tail[1] !== last[1]) out.push([last[0], last[1]]);
  return out;
}

// 有名字的画的河变成地物（键 guide:河道 id，类型是河）：格是这条河自己的格（从河口往上排），标注在画出来的线的中段。
// 标签、大小、重要度与自然的大河同一个算法，所以固定一条自然的河之后名字、先后都不变（见 assignNames）。
// terrain 同 detectFeatures。没有名字的河道（旧存档里画的河都是）不算，旧存档的地名不变
export function guideFeatures(world: World, d: Derived, terrain: Float32Array = d.elevation): GeoFeature[] {
  const { mesh } = world;
  const thr = world.small.planet.riverThreshold;
  const globe = mesh.kind === 'sphere';
  const out: GeoFeature[] = [];
  for (const g of world.small.guides) {
    if (!named(g)) continue;
    const cells = Int32Array.from(guideBody(world, d, g).reverse());
    if (!cells.length) continue;
    const mouth = cells[0];
    const q = Math.max(d.discharge[mouth], thr);
    const size = q > thr * 40 ? 'big' : q > thr * 6 ? '' : 'small';
    const ax = axis(mesh, cells, unwrapped(mesh, cells));
    const line = alongLine(guideLine(world, g).points, mesh.spacing);
    const mid = line[Math.floor(line.length / 2)];
    out.push({
      key: `guide:${g.id}`,
      type: 'river',
      anchor: mouth,
      cells,
      areaKm2: areaOf(world, cells),
      x: globe ? wrapX(mid[0]) : mid[0],
      y: mid[1],
      angle: ax.angle,
      span: ax.span,
      tags: [...new Set([...tagsOf(world, d, cells, terrain), ...(size ? [size] : [])])],
      importance: 6 + Math.log10(q),
      name: '',
      custom: false,
      line,
      guide: g.id,
    });
  }
  return out;
}

// ---------- 用户圈的区块 ----------

// 区块里离边界（含地图边）最远的格：标注放在这里，弯月形的区块字也不会落到外面。并列时取离质心近的
// （再并列取编号小的，所以结果与遍历的先后无关）。临时数组按网格各留一份，用完把用过的格清回去
const innerScratch = new WeakMap<Mesh, { inside: Uint8Array; dist: Int32Array }>();
function innermost(mesh: Mesh, cells: ArrayLike<number>, cx: number, cy: number): number {
  let scratch = innerScratch.get(mesh);
  if (!scratch) innerScratch.set(mesh, (scratch = { inside: new Uint8Array(mesh.n), dist: new Int32Array(mesh.n).fill(-1) }));
  const { inside, dist } = scratch;
  for (let k = 0; k < cells.length; k++) inside[cells[k]] = 1;
  const q: number[] = [];
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k];
    if (dist[c] >= 0) continue;
    let edge = mesh.boundary[c] === 1;
    for (let e = mesh.off[c]; e < mesh.off[c + 1] && !edge; e++) if (!inside[mesh.adj[e]]) edge = true;
    if (edge) {
      dist[c] = 0;
      q.push(c);
    }
  }
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
      const j = mesh.adj[e];
      if (inside[j] && dist[j] < 0) {
        dist[j] = dist[c] + 1;
        q.push(j);
      }
    }
  }
  let best = cells[0];
  let bd = -1;
  let br = Infinity;
  for (const c of q) {
    const dd = dist[c];
    const r = (mesh.kind === 'sphere' ? wrapDelta(mesh.x[c] - cx) : mesh.x[c] - cx) ** 2 + (mesh.y[c] - cy) ** 2;
    if (dd > bd || (dd === bd && (r < br || (r === br && c < best)))) {
      best = c;
      bd = dd;
      br = r;
    }
  }
  for (const c of q) dist[c] = -1;
  for (let k = 0; k < cells.length; k++) inside[cells[k]] = 0;
  return best;
}

// 点状地名的情境：海边、河边、山上、海上、寒冷（山上不山上按没挖河床的地形看）
function spotTags(world: World, d: Derived, c: number, terrain: ArrayLike<number>): string[] {
  const { mesh, causes } = world;
  const tags: string[] = [];
  let coast = false;
  for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) if (causes.land[mesh.adj[e]] !== causes.land[c]) coast = true;
  if (!causes.land[c]) tags.push('sea');
  else {
    if (coast) tags.push('coastal');
    if (d.lake[c] !== 1 && d.discharge[c] >= world.small.planet.riverThreshold) tags.push('river');
    if (terrain[c] >= 1300) tags.push('mountain');
  }
  if (d.tMean[c] < 0) tags.push('cold');
  return tags;
}

// 用户的区块变成地物：标注在离边界最远的格，狭长的（主轴比次轴长一倍以上）沿主轴写；
// 重要度高于所有自动识别的地物，标注时先放。
// 类型“自动”的区块每次按圈里现在的地形重新判断（涂成沙漠就变成沙漠）；类型变了，自动起的名字也跟着换一套模板
// （改冷暖干湿让它跨过判断的门槛时也一样），用户起的名字不变。terrain 同 detectFeatures
export function regionFeatures(world: World, d: Derived, terrain: Float32Array = d.elevation): GeoFeature[] {
  const { mesh, kmPerUnit } = world;
  return world.small.regions.map((r) => {
    const cells = Int32Array.from(r.cells);
    let areaKm2 = 0;
    for (const c of cells) areaKm2 += mesh.area[c] * kmPerUnit * kmPerUnit;
    const kind = r.auto && r.kind !== 'spot' ? guessRegionKind(world, d, cells, terrain, terrainSlope(world, d, terrain)) : r.kind;
    const type = REGION_KIND_INFO[kind].type;
    const f: GeoFeature = {
      key: `region:${r.id}`,
      type,
      anchor: cells[0],
      cells,
      areaKm2,
      x: mesh.x[cells[0]],
      y: mesh.y[cells[0]],
      angle: 0,
      span: 0,
      tags: [],
      importance: 21,
      name: '',
      custom: false,
      region: r.id,
    };
    if (r.kind === 'spot') {
      if (r.at) [f.x, f.y] = r.at;
      f.tags = spotTags(world, d, cells[0], terrain);
      return f;
    }
    const ax = axis(mesh, cells, unwrapped(mesh, cells));
    const c = innermost(mesh, cells, ax.x, ax.y);
    f.x = mesh.x[c];
    f.y = mesh.y[c];
    f.span = ax.span;
    f.angle = ax.elong >= 2 ? ax.angle : 0;
    f.tags = tagsOf(world, d, cells, terrain);
    f.importance = 20 + Math.log10(Math.max(1, areaKm2)) / 10;
    return f;
  });
}

// 区块的地物类型 → 区块类型（自动判断的区块只记了地物类型）
const REGION_KIND_OF_TYPE = new Map((Object.keys(REGION_KIND_INFO) as RegionKind[]).map((k) => [REGION_KIND_INFO[k].type, k]));

// 地名的类型名：用户的区块按它（自动判断后）的类型（山地、地点……），涂出来的生态区是生态的名字，其余按地物类型
export function featureLabel(world: World, f: GeoFeature): string {
  const kind = f.region ? REGION_KIND_OF_TYPE.get(f.type) : undefined;
  if (kind) return REGION_KIND_INFO[kind].label;
  const sp = f.species ? world.small.species.find((x) => x.id === f.species) : undefined;
  return sp ? speciesFeature(sp).label : FEATURE_INFO[f.type].label;
}

// 圈出来的一块像什么：大半是水 → 海域；陆地里一半以上是山 / 沙漠 / 森林，或大多是低平地 → 平原；否则是地区。
// 高低、坡度按 elevation、slope（引擎里是没挖河床的地形：画一条峡谷不会让“山地”变成“地区”，换掉自动起的名字）
export function guessRegionKind(
  world: World,
  d: Derived,
  cells: ArrayLike<number>,
  elevation: ArrayLike<number> = d.elevation,
  slope: ArrayLike<number> = d.slope,
): Exclude<RegionKind, 'spot'> {
  const { causes, small } = world;
  let water = 0;
  let n = 0;
  let high = 0;
  let desert = 0;
  let forest = 0;
  let flat = 0;
  for (let k = 0; k < cells.length; k++) {
    const c = cells[k];
    if (!causes.land[c] || d.lake[c] === 1) {
      water++;
      continue;
    }
    n++;
    const terrain = d.dominant[c] >= 0 ? small.species[d.dominant[c]]?.terrain : '';
    if (terrain === 'desert') desert++;
    if (terrain === 'forest' || terrain === 'jungle') forest++;
    if (elevation[c] >= 1300) high++;
    if (elevation[c] <= 400 && slope[c] <= 2.5) flat++;
  }
  if (water > cells.length * 0.6) return 'sea';
  if (!n) return 'region';
  if (high > n * 0.5) return 'highland';
  if (desert > n * 0.5) return 'desert';
  if (forest > n * 0.5) return 'forest';
  if (flat > n * 0.6) return 'plain';
  return 'region';
}

// 固定下来的自然河：沿用那条河的地名键（nameKey）、自己没起名。它不是新的名字，就是原来那条河，
// 照原来的先后起名（名字与固定前一字不差），那条河改过的名字、换过的盐也照旧
const inherits = (g: Guide | undefined) => !!g && g.nameKey !== undefined && !g.name;

// 按文字包起名；用户改过的名字优先
export function assignNames(world: World, features: GeoFeature[]) {
  const pack: WordPack = world.small.wordPack ?? DEFAULT_PACK;
  const overrides = world.small.featureNames;
  const byType = new Map<string, [number, FeatureOverride, string][]>();
  for (const [key, ov] of Object.entries(overrides)) {
    const [type, a] = key.split(':');
    const list = byType.get(type) ?? [];
    list.push([Number(a), ov, key]);
    byType.set(type, list);
  }
  const taken = new Set<string>();
  const seed = world.small.terrain.gen?.seed ?? world.settings.seed;
  const regions = new Map(world.small.regions.map((r) => [r.id, r]));
  const species = new Map(world.small.species.map((sp) => [sp.id, sp]));
  const guides = new Map(world.small.guides.map((g) => [g.id, g]));
  // 新种类的地名：在原有的地名都起好之后第二轮再起，不会抢走原有地物的名字、引起一串换名。
  // 现在是涂出来的生态区、画的河（固定下来的自然河除外）；以后新加的种类（带类型的河……）也接在这里
  const secondPass = (f: GeoFeature) => f.species !== undefined || (f.guide !== undefined && !inherits(guides.get(f.guide)));
  // 重要的先起名，同名时让给重要的；新种类的放在第二轮。第二轮里画的河按画的先后起名（排在涂出来的生态区之后）：
  // 自动起的河名只有几百个，常常撞名，按重要度排的话新画了一条大河、或者河的水量变了，先画的河就会换名
  const byImportance = (a: GeoFeature, b: GeoFeature) => b.importance - a.importance || a.key.localeCompare(b.key);
  const drawnAt = new Map(world.small.guides.map((g, k) => [g.id, k]));
  const second = features.filter(secondPass);
  const order = [
    ...features.filter((f) => !secondPass(f)).sort(byImportance),
    ...second.filter((f) => f.guide === undefined).sort(byImportance),
    ...second.filter((f) => f.guide !== undefined).sort((a, b) => drawnAt.get(a.guide!)! - drawnAt.get(b.guide!)!),
  ];
  // 改过的名字落到哪个地物上：先找锚点相同的，再按上面的先后找包含原锚点的；每条只用一次
  // （森林被涂出一块别的生态时，名字留在锚点还在的那一边，不会两边都叫这个名字）
  const ovOf = new Map<GeoFeature, FeatureOverride>();
  // 固定下来的自然河用着的那条改名（不再落到别的地物上）。河道整条成了水、没有地物时不占，
  // 那条自然的河还在的话照旧用它
  const used = new Set<string>();
  for (const f of features) {
    const key = f.guide !== undefined ? guides.get(f.guide)?.nameKey : undefined;
    if (key !== undefined) used.add(key);
  }
  const match = (f: GeoFeature, ok: (a: number) => boolean) => {
    const hit = byType.get(f.type)?.find(([a, , key]) => !used.has(key) && ok(a));
    if (!hit) return;
    ovOf.set(f, hit[1]);
    used.add(hit[2]);
  };
  for (const f of order) if (!f.region && !f.guide) match(f, (a) => a === f.anchor);
  for (const f of order) if (!f.region && !f.guide && !ovOf.has(f)) match(f, (a) => f.cells.includes(a));
  for (const f of order) {
    const g = f.guide !== undefined ? guides.get(f.guide) : undefined;
    if (g) {
      // 画的河：起了名就用；'' 按文字包自动起（键是这条河道，固定的自然河是那条河原来的键）。
      // 只有 nameKey 的（固定下来、没自己起名的自然河）与原来那条河一样，那条河改过的名字也照旧
      const ov = inherits(g) && g.name === undefined ? overrides[g.nameKey!] : undefined;
      const fixed = g.name || ov?.name;
      f.custom = !!fixed;
      if (fixed) {
        f.name = fixed;
        taken.add(fixed);
      } else f.name = generateName(pack, f.type, f.tags, hashString(`${seed}:${g.nameKey ?? f.key}:${g.salt ?? ov?.salt ?? 0}`), taken);
      continue;
    }
    const r = f.region ? regions.get(f.region) : undefined;
    if (r) {
      // 用户的区块：起了名就用，没起名按文字包自动起（文字包里没有这一类时按省份的模板）
      f.custom = !!r.name;
      if (r.name) taken.add(r.name);
      const type = pack.types[f.type] ? f.type : 'province';
      f.name = r.name || generateName(pack, type, f.tags, hashString(`${seed}:${f.key}:${r.salt}`), taken);
      continue;
    }
    const ov = ovOf.get(f);
    if (ov?.name) {
      f.name = ov.name;
      f.custom = true;
      taken.add(ov.name);
      continue;
    }
    f.custom = false;
    const sp = f.species !== undefined ? species.get(f.species) : undefined;
    if (sp) {
      // 涂出来的生态区：模板按生态定，种子里带上生态（同一片格涂成别的生态，名字也换）
      const how = speciesFeature(sp).naming(pack);
      f.name = generateName(how.pack, how.type, f.tags, hashString(`${seed}:${f.key}:${sp.id}:${ov?.salt ?? 0}`), taken);
    } else f.name = generateName(pack, f.type, f.tags, hashString(`${seed}:${f.key}:${ov?.salt ?? 0}`), taken);
  }
}
