// 地物的种类与格图工具（第八十三轮从 core/features.ts 原样搬出）：种类表、地物的类型、连通块、步数、锚点、主轴、情境、标注放在哪
import type { RegionKind, World, Derived } from './world';
import { type Mesh, findCell } from './mesh';

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

// 第七十一轮：大类地物的类型字跟着生态的名字（以前是沙漠、冻原、冰原、沼泽）。只是类型字（地名表、圈地名、features.csv 的类型一列）；
// 第七十六轮：中文地名风格的模板也跟着改（“某某荒漠”“某某苔原”“某某冰盖”）

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
  desert: { label: '荒漠', group: 'nature' },
  forest: { label: '森林', group: 'nature' },
  tundra: { label: '苔原', group: 'nature' },
  icecap: { label: '冰盖', group: 'nature' },
  wetland: { label: '沼泽湿地', group: 'nature' },
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
  desert: { label: '荒漠', type: 'desert' },
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
  // 涂出来的生态区、自带地名设定的生态自然长成的一片：那种生态的 id（别的自然形成的地物没有这一项）
  species?: string;
  // 画的河（有名字的河道）：河道的 id
  guide?: string;
  // 自己写的类型字（第十四轮）：起名时按改过的名字、画的河、圈的地名填上；没有时 featureLabel 按类型
  label?: string;
  // 删掉了名字（第十六轮）：地图上、导出的图片和 features.csv 里不标，“地名 ⋯ → 删掉的地名”里能恢复
  hidden?: true;
  // 名字的原文（第二十轮）：按音译式、带读音表的地名风格起的名字才有（Karvilsburg）
  orig?: string;
  // 自己选的地名风格（第二十轮）：不是世界默认的时才有
  style?: string;
}

export interface FeatureOverride {
  name?: string;
  // 重抽名字时的盐
  salt?: number;
  // 名字前面的类型字（第十四轮）：自己写的，比如“圣山”
  label?: string;
  // 删掉了这个地名（第十六轮）：地物还在，只是不标
  hidden?: true;
  // 自己起的名字的原文（第二十轮）：改名时一起写；只改中文名时去掉
  orig?: string;
  // 这个地物用的地名风格（第二十轮，见 name-styles.ts 的 styleFor）
  style?: string;
}

// ---------- 格图工具 ----------

// 第三十五轮（提速）：连通块、步数距离的队列换成类型化数组、循环放进小函数（走的先后不变，结果逐值相同）
export function components(mesh: Mesh, mask: Uint8Array): number[][] {
  const seen = new Uint8Array(mesh.n);
  const out: number[][] = [];
  const q = new Int32Array(mesh.n);
  for (let i = 0; i < mesh.n; i++) {
    if (!mask[i] || seen[i]) continue;
    const len = floodComponent(mesh.off, mesh.adj, mask, seen, q, i);
    out.push(Array.from(q.subarray(0, len)));
  }
  return out;
}

// 从 s 起走 mask 里的连通块（宽度优先，格写进 q），返回格数
function floodComponent(off: Int32Array, adj: Int32Array, mask: Uint8Array, seen: Uint8Array, q: Int32Array, s: number): number {
  let t = 0;
  q[t++] = s;
  seen[s] = 1;
  for (let h = 0; h < t; h++) {
    const c = q[h];
    for (let e = off[c]; e < off[c + 1]; e++) {
      const j = adj[e];
      if (mask[j] && !seen[j]) {
        seen[j] = 1;
        q[t++] = j;
      }
    }
  }
  return t;
}

// 在 allowed 内从 sources 出发的步数距离（不可达为 -1）
export function steps(mesh: Mesh, sources: ArrayLike<number>, allowed: Uint8Array, max = Infinity): Int32Array {
  const d = new Int32Array(mesh.n).fill(-1);
  const q = new Int32Array(mesh.n);
  let t = 0;
  for (let k = 0; k < sources.length; k++) {
    const s = sources[k];
    if (d[s] < 0) {
      d[s] = 0;
      q[t++] = s;
    }
  }
  stepsFrom(mesh.off, mesh.adj, allowed, max, d, q, t);
  return d;
}

function stepsFrom(off: Int32Array, adj: Int32Array, allowed: Uint8Array, max: number, d: Int32Array, q: Int32Array, t: number) {
  for (let h = 0; h < t; h++) {
    const c = q[h];
    if (d[c] >= max) continue;
    for (let e = off[c]; e < off[c + 1]; e++) {
      const j = adj[e];
      if (allowed[j] && d[j] < 0) {
        d[j] = d[c] + 1;
        q[t++] = j;
      }
    }
  }
}

// 锚点（决定名字）：要素里“优先级”最高的格。每格的优先级是固定的随机数，
// 所以要素的形状变了，只要这一格还在要素里，名字就不变——在海中间放个岛、把岛画大一点，名字都不会跳。
// （“离边界最远的格”恰好是最常被放岛、被改动的地方，不适合当锚点）。锚点格被涂掉、地物长大多出优先级更高的格时
// 键会换，但原有地物的名字照旧（见文件末尾“名字跟着地方走”）。锚点的取法不改：存档里改过的名字按这个键记着
function priority(c: number): number {
  let h = Math.imul(c + 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}
export function stableAnchor(cells: ArrayLike<number>): number {
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
export function freeAnchor(cells: ArrayLike<number>, used: Set<number>, salt = 0): number {
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
export function unwrapped(mesh: Mesh, cells: ArrayLike<number>): Float64Array | null {
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

export const wrapX = (x: number) => x - 2 * Math.floor(x / 2);
export const wrapDelta = (d: number) => d - 2 * Math.round(d / 2);

// 质心与主轴方向、长度；elong：主轴与次轴方向上散布的比（越大越狭长）。
// xs：整个星球上展开后的经度坐标（与 cells 对齐）；结果的 x 绕回 [0, 2)
export function axis(mesh: Mesh, cells: ArrayLike<number>, xs: Float64Array | null = null): { x: number; y: number; angle: number; span: number; elong: number } {
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
export function tagsOf(world: World, d: Derived, cells: ArrayLike<number>, terrain: ArrayLike<number> = d.elevation): string[] {
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
export interface AddInput {
  type: FeatureType;
  cells: Int32Array;
  importance: number;
  tags: string[];
  anchor?: number;
  // river：沿河标注；peak：标在峰顶；islet：小岛，最高处超过 1400 m 时加“火山”（随高度变，add 时再看）
  mark?: 'river' | 'peak' | 'islet';
  // 标注放在这一格（质心落在地物外面时才有，见 withLabels）
  labelCell?: number;
  // 涂出来的生态区、自带地名设定的生态自然长成的一片：那种生态的下标
  species?: number;
}

// 记下一次 add 的输入
export function put(list: AddInput[], type: FeatureType, cells: number[], importance: number, tags: string[] = [], anchor?: number, mark?: AddInput['mark']) {
  list.push({ type, cells: Int32Array.from(cells), importance, tags, anchor, mark });
}

// 标注放在地物自己的格上：质心所在的格不属于地物（弯月形的海、中间被涂成别的生态的森林）时，改放在离边界最远的格；
// 质心在地物里的照旧标在质心。在各段的缓存里算好（只在输入变了时算），不是每次编辑都算。
// 群岛（岛与岛之间本来就是海）、河（沿河标注）、山峰（标在峰顶）不算
export function withLabels(mesh: Mesh, list: AddInput[]): AddInput[] {
  for (const a of list) {
    if (a.mark === 'river' || a.mark === 'peak' || a.type === 'archipelago') continue;
    const ax = axis(mesh, a.cells, unwrapped(mesh, a.cells));
    const c = findCell(mesh, mesh.kind === 'sphere' ? wrapX(ax.x) : ax.x, ax.y);
    if (!a.cells.includes(c)) a.labelCell = innermost(mesh, a.cells, ax.x, ax.y);
  }
  return list;
}

// 面积（km²），逐格相加
export function areaOf(world: World, cells: ArrayLike<number>): number {
  const { mesh, kmPerUnit } = world;
  let s = 0;
  for (let k = 0; k < cells.length; k++) s += mesh.area[cells[k]] * kmPerUnit * kmPerUnit;
  return s;
}

// 整张图的面积（km²）：整个星球的面积是 4πR²（宽 × 高不是）
export function mapAreaOf(world: World): number {
  const { mesh, kmPerUnit } = world;
  return mesh.kind === 'sphere' ? mesh.totalArea * kmPerUnit * kmPerUnit : mesh.width * mesh.height * kmPerUnit * kmPerUnit;
}

// 区块里离边界（含地图边）最远的格：标注放在这里，弯月形的区块字也不会落到外面。并列时取离质心近的
// （再并列取编号小的，所以结果与遍历的先后无关）。临时数组按网格各留一份，用完把用过的格清回去
const innerScratch = new WeakMap<Mesh, { inside: Uint8Array; dist: Int32Array }>();
export function innermost(mesh: Mesh, cells: ArrayLike<number>, cx: number, cy: number): number {
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
