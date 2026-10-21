import { type Mesh } from './mesh';
import { DEFAULT_PACK, type WordPack, generateName, hashString } from './names';
import type { Derived, RegionKind, World } from './world';

// 地理要素识别：在格图上找出大陆、岛、群岛、半岛、海、洋、湾、海峡、湖、大河、山脉、主峰、
// 高原、平原、盆地、沙漠、森林、冻原、冰原、沼泽，按文字包起名。
// 是推导层：每次地形或气候变化后重算。名字由“类型 + 锚点格（要素内部离边界最远的格）+ 种子”确定，
// 小改动不会让名字乱跳；用户改过的名字按“同类型、包含原锚点”匹配到重算后的要素上。

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

// 情境标签（寒、热、干、湿、高）：按地物里陆地格的平均气候；全是水时只看冷热
function tagsOf(world: World, d: Derived, cells: ArrayLike<number>): string[] {
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
    h += Math.max(0, d.elevation[c]);
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

export function detectFeatures(world: World, d: Derived): GeoFeature[] {
  const { mesh, causes, small, kmPerUnit } = world;
  const n = mesh.n;
  const land = causes.land;
  const cellKm2 = (i: number) => mesh.area[i] * kmPerUnit * kmPerUnit;
  const areaOf = (cells: number[]) => cells.reduce((s, c) => s + cellKm2(c), 0);
  const globe = mesh.kind === 'sphere';
  // 整个星球的面积是 4πR²（宽 × 高不是）
  const mapKm2 = globe ? mesh.totalArea * kmPerUnit * kmPerUnit : mesh.width * mesh.height * kmPerUnit * kmPerUnit;
  const avgCellKm2 = mapKm2 / n;
  const out: GeoFeature[] = [];

  const climateTags = (cells: number[]) => tagsOf(world, d, cells);

  const add = (type: FeatureType, cells: number[], importance: number, extraTags: string[] = [], anchor?: number) => {
    if (!cells.length) return;
    const a = anchor ?? stableAnchor(cells);
    const ax = axis(mesh, cells, unwrapped(mesh, cells));
    out.push({
      key: `${type}:${a}`,
      type,
      anchor: a,
      cells: Int32Array.from(cells),
      areaKm2: areaOf(cells),
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
    const area = areaOf(cells);
    if (area >= continentKm2) add('continent', cells, 10 + Math.log10(area));
    else if (cells.length >= 2) {
      islandIdx.push(k);
      let maxH = 0;
      for (const c of cells) maxH = Math.max(maxH, d.elevation[c]);
      const tags = [area > avgCellKm2 * 400 ? 'large' : area < avgCellKm2 * 6 ? 'small' : ''];
      if (maxH > 1400 && cells.length < 120) tags.push('volcanic');
      add('island', cells, 4 + Math.log10(area), tags.filter(Boolean));
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
      add('archipelago', cells, 7 + Math.log10(areaOf(cells)), [], stableAnchor(masses[biggest]));
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
        add('peninsula', cells, 5 + Math.log10(areaOf(cells)));
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
      add('strait', cells, 5.5);
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
        add('bay', cells, 5.5 + Math.log10(areaOf(cells)), cells.length > 60 ? ['large'] : []);
      }
    }
  }

  // 海与洋：在离岸远的地方撒种子，按距离分区
  {
    const seaCells: number[] = [];
    for (let i = 0; i < n; i++) if (!land[i]) seaCells.push(i);
    if (seaCells.length) {
      let seaKm2 = 0;
      for (const c of seaCells) seaKm2 += cellKm2(c);
      // 整个星球按面积比例分区（星球大小不影响分法）
      const k = globe ? Math.max(3, Math.min(18, Math.round((seaKm2 / mapKm2) * 22))) : Math.max(1, Math.min(12, Math.round(seaCells.length / 2600)));
      const spacing = Math.max(4, Math.round(Math.sqrt(seaCells.length / k) * 0.8));
      const order = [...seaCells].sort((a, b) => dSea[b] - dSea[a] || a - b);
      const blocked = new Uint8Array(n);
      const seeds: number[] = [];
      for (const c of order) {
        if (seeds.length >= Math.ceil(k * 1.5)) break;
        if (blocked[c] || dSea[c] < 1) continue;
        seeds.push(c);
        const near = steps(mesh, [c], seaMask, spacing);
        for (let i = 0; i < n; i++) if (near[i] >= 0) blocked[i] = 1;
      }
      // 多源 BFS 分区
      const owner = new Int32Array(n).fill(-1);
      const q: number[] = [];
      seeds.forEach((s, idx) => {
        owner[s] = idx;
        q.push(s);
      });
      for (let h = 0; h < q.length; h++) {
        const c = q[h];
        for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
          const j = mesh.adj[e];
          if (!land[j] && owner[j] < 0) {
            owner[j] = owner[c];
            q.push(j);
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
        const ocean = globe ? areaOf(cells) > mapKm2 * 0.035 && meanD > 6 : cells.length > totalSea * 0.18 && meanD > 6;
        add(ocean ? 'ocean' : 'sea', cells, (ocean ? 9.5 : 7.5) + Math.log10(areaOf(cells)));
      });
    }
  }

  // 湖
  {
    const lakeMask = new Uint8Array(n);
    for (let i = 0; i < n; i++) lakeMask[i] = d.lake[i] === 1 ? 1 : 0;
    for (const cells of components(mesh, lakeMask)) {
      const area = areaOf(cells);
      const tags = [area > avgCellKm2 * 30 ? 'large' : ''];
      let h = 0;
      for (const c of cells) h += d.elevation[c];
      if (h / cells.length > 2000) tags.push('high');
      add('lake', cells, 5 + Math.log10(area), tags.filter(Boolean));
    }
  }

  // 大河：从河口沿流量最大的支流上溯
  {
    const thr = small.planet.riverThreshold;
    const donors: number[][] = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
      const r = d.receiver[i];
      if (land[i] && r >= 0 && land[r]) donors[r].push(i);
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
        for (const j of donors[c]) if (d.lake[j] !== 1 && d.discharge[j] >= thr && (best < 0 || d.discharge[j] > d.discharge[best])) best = j;
        if (best < 0) break;
        stem.push(best);
        c = best;
      }
      if (stem.length < 6) continue;
      const q = d.discharge[m];
      const size = q > thr * 40 ? 'big' : q > thr * 6 ? '' : 'small';
      const before = out.length;
      add('river', stem, 6 + Math.log10(q), size ? [size] : [], m);
      // 标注沿河中段
      const f = out[before];
      const line = stem.map((s) => [mesh.x[s], mesh.y[s]] as [number, number]).reverse();
      // 整个星球：沿河展开经度，跨过接缝的河也是连续的一条线
      if (globe) for (let k = 1; k < line.length; k++) line[k][0] = line[k - 1][0] + wrapDelta(line[k][0] - line[k - 1][0]);
      f.line = line;
      const mid = Math.floor(line.length / 2);
      f.x = globe ? wrapX(line[mid][0]) : line[mid][0];
      f.y = line[mid][1];
    }
  }

  // 山脉与主峰；高原；平原；盆地
  {
    const mountain = new Uint8Array(n);
    for (let i = 0; i < n; i++) mountain[i] = land[i] && d.lake[i] !== 1 && d.elevation[i] >= 1300 ? 1 : 0;
    for (const cells of components(mesh, mountain)) {
      if (cells.length < 6) continue;
      let peak = cells[0];
      for (const c of cells) if (d.elevation[c] > d.elevation[peak]) peak = c;
      const volcanic = cells.length < 40 && d.elevation[peak] > 1500;
      add('range', cells, 6.5 + Math.log10(areaOf(cells)), volcanic ? ['volcanic'] : []);
      if (d.elevation[peak] >= 2600 || (volcanic && d.elevation[peak] >= 1500)) {
        add('peak', [peak], 5 + d.elevation[peak] / 3000, volcanic ? ['volcanic'] : [], peak);
        out[out.length - 1].x = mesh.x[peak];
        out[out.length - 1].y = mesh.y[peak];
      }
    }
    const plateau = new Uint8Array(n);
    const plain = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!land[i] || d.lake[i] === 1) continue;
      if (d.elevation[i] >= 1200 && d.slope[i] <= 8) plateau[i] = 1;
      if (d.elevation[i] <= 400 && d.slope[i] <= 2.5) plain[i] = 1;
    }
    for (const cells of components(mesh, plateau)) if (cells.length >= 15) add('plateau', cells, 6 + Math.log10(areaOf(cells)));
    const plains = components(mesh, plain).filter((c) => c.length >= 40).sort((a, b) => b.length - a.length).slice(0, 8);
    for (const cells of plains) add('plain', cells, 5.5 + Math.log10(areaOf(cells)));
    // 盆地：被高出很多的地形围住的低地
    const basin = new Uint8Array(n);
    const near = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      if (!land[i]) continue;
      let mx = d.elevation[i];
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) mx = Math.max(mx, d.elevation[mesh.adj[e]]);
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
    for (let i = 0; i < n; i++) if (land[i] && d.elevation[i] < 900 && near[i] - d.elevation[i] > 1400 && dLand[i] > 3) basin[i] = 1;
    for (const cells of components(mesh, basin)) if (cells.length >= 20) add('basin', cells, 5.5 + Math.log10(areaOf(cells)));
  }

  // 大片生态区
  {
    const S = small.species;
    const group = (s: number) => {
      if (s < 0) return '';
      const sp = S[s];
      if (sp.id === 'ice') return 'icecap';
      if (sp.terrain === 'desert') return 'desert';
      if (sp.terrain === 'forest' || sp.terrain === 'jungle') return 'forest';
      if (sp.terrain === 'arctic') return 'tundra';
      if (sp.terrain === 'marsh') return 'wetland';
      return '';
    };
    for (const g of ['desert', 'forest', 'tundra', 'icecap', 'wetland'] as const) {
      const mask = new Uint8Array(n);
      for (let i = 0; i < n; i++) mask[i] = land[i] && group(d.dominant[i]) === g ? 1 : 0;
      const min = g === 'wetland' ? 12 : 30;
      const comps = components(mesh, mask)
        .filter((c) => c.length >= min)
        .sort((a, b) => b.length - a.length)
        .slice(0, 10);
      for (const cells of comps) add(g, cells, 5 + Math.log10(areaOf(cells)));
    }
  }

  out.push(...regionFeatures(world, d));
  assignNames(world, out);
  return out;
}

// ---------- 用户圈的区块 ----------

// 区块里离边界（含地图边）最远的格：标注放在这里，弯月形的区块字也不会落到外面。并列时取离质心近的
function innermost(mesh: Mesh, cells: ArrayLike<number>, cx: number, cy: number): number {
  const inside = new Set<number>();
  for (let k = 0; k < cells.length; k++) inside.add(cells[k]);
  const dist = new Map<number, number>();
  const q: number[] = [];
  for (const c of inside) {
    let edge = mesh.boundary[c] === 1;
    for (let e = mesh.off[c]; e < mesh.off[c + 1] && !edge; e++) if (!inside.has(mesh.adj[e])) edge = true;
    if (edge) {
      dist.set(c, 0);
      q.push(c);
    }
  }
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
      const j = mesh.adj[e];
      if (inside.has(j) && !dist.has(j)) {
        dist.set(j, dist.get(c)! + 1);
        q.push(j);
      }
    }
  }
  let best = cells[0];
  let bd = -1;
  let br = Infinity;
  for (const [c, dd] of dist) {
    const r = (mesh.kind === 'sphere' ? wrapDelta(mesh.x[c] - cx) : mesh.x[c] - cx) ** 2 + (mesh.y[c] - cy) ** 2;
    if (dd > bd || (dd === bd && (r < br || (r === br && c < best)))) {
      best = c;
      bd = dd;
      br = r;
    }
  }
  return best;
}

// 点状地名的情境：海边、河边、山上、海上、寒冷
function spotTags(world: World, d: Derived, c: number): string[] {
  const { mesh, causes } = world;
  const tags: string[] = [];
  let coast = false;
  for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) if (causes.land[mesh.adj[e]] !== causes.land[c]) coast = true;
  if (!causes.land[c]) tags.push('sea');
  else {
    if (coast) tags.push('coastal');
    if (d.lake[c] !== 1 && d.discharge[c] >= world.small.planet.riverThreshold) tags.push('river');
    if (d.elevation[c] >= 1300) tags.push('mountain');
  }
  if (d.tMean[c] < 0) tags.push('cold');
  return tags;
}

// 用户的区块变成地物：标注在离边界最远的格，狭长的（主轴比次轴长一倍以上）沿主轴写；
// 重要度高于所有自动识别的地物，标注时先放
export function regionFeatures(world: World, d: Derived): GeoFeature[] {
  const { mesh, kmPerUnit } = world;
  return world.small.regions.map((r) => {
    const cells = Int32Array.from(r.cells);
    let areaKm2 = 0;
    for (const c of cells) areaKm2 += mesh.area[c] * kmPerUnit * kmPerUnit;
    const type = REGION_KIND_INFO[r.kind].type;
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
      f.tags = spotTags(world, d, cells[0]);
      return f;
    }
    const ax = axis(mesh, cells, unwrapped(mesh, cells));
    const c = innermost(mesh, cells, ax.x, ax.y);
    f.x = mesh.x[c];
    f.y = mesh.y[c];
    f.span = ax.span;
    f.angle = ax.elong >= 2 ? ax.angle : 0;
    f.tags = tagsOf(world, d, cells);
    f.importance = 20 + Math.log10(Math.max(1, areaKm2)) / 10;
    return f;
  });
}

// 地名的类型名：用户的区块按它自己的类型（山地、地点……），其余按地物类型
export function featureLabel(world: World, f: GeoFeature): string {
  const r = f.region ? world.small.regions.find((x) => x.id === f.region) : undefined;
  return r ? REGION_KIND_INFO[r.kind].label : FEATURE_INFO[f.type].label;
}

// 圈出来的一块像什么：大半是水 → 海域；陆地里一半以上是山 / 沙漠 / 森林，或大多是低平地 → 平原；否则是地区
export function guessRegionKind(world: World, d: Derived, cells: ArrayLike<number>): Exclude<RegionKind, 'spot'> {
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
    if (d.elevation[c] >= 1300) high++;
    if (d.elevation[c] <= 400 && d.slope[c] <= 2.5) flat++;
  }
  if (water > cells.length * 0.6) return 'sea';
  if (!n) return 'region';
  if (high > n * 0.5) return 'highland';
  if (desert > n * 0.5) return 'desert';
  if (forest > n * 0.5) return 'forest';
  if (flat > n * 0.6) return 'plain';
  return 'region';
}

// 按文字包起名；用户改过的名字优先
export function assignNames(world: World, features: GeoFeature[]) {
  const pack: WordPack = world.small.wordPack ?? DEFAULT_PACK;
  const overrides = world.small.featureNames;
  const byType = new Map<string, [number, FeatureOverride][]>();
  for (const [key, ov] of Object.entries(overrides)) {
    const [type, a] = key.split(':');
    const list = byType.get(type) ?? [];
    list.push([Number(a), ov]);
    byType.set(type, list);
  }
  const taken = new Set<string>();
  const seed = world.small.terrain.gen?.seed ?? world.settings.seed;
  const regions = new Map(world.small.regions.map((r) => [r.id, r]));
  // 重要的先起名，同名时让给重要的
  const order = [...features].sort((a, b) => b.importance - a.importance || a.key.localeCompare(b.key));
  for (const f of order) {
    const r = f.region ? regions.get(f.region) : undefined;
    if (r) {
      // 用户的区块：起了名就用，没起名按文字包自动起（文字包里没有这一类时按省份的模板）
      f.custom = !!r.name;
      if (r.name) taken.add(r.name);
      const type = pack.types[f.type] ? f.type : 'province';
      f.name = r.name || generateName(pack, type, f.tags, hashString(`${seed}:${f.key}:${r.salt}`), taken);
      continue;
    }
    let ov: FeatureOverride | undefined;
    const cand = byType.get(f.type);
    if (cand) {
      for (const [a, o] of cand) {
        if (a === f.anchor || f.cells.includes(a)) {
          ov = o;
          break;
        }
      }
    }
    if (ov?.name) {
      f.name = ov.name;
      f.custom = true;
      taken.add(ov.name);
      continue;
    }
    f.custom = false;
    f.name = generateName(pack, f.type, f.tags, hashString(`${seed}:${f.key}:${ov?.salt ?? 0}`), taken);
  }
}
