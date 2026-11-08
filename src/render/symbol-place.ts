import type { World } from '../../core/world';

// 手绘画风的符号（第八十七轮）：山、丘陵、森林画成小符号的位置。不碰画布（Node 里能测），画法在 overlay-symbols.ts。
//
// 候选：每格一个（放大后第 k 档每格 4^k 个，按 2^k × 2^k 的抖动格点铺在格心四周），只看这一格自己的几个数（cellCodes）：
//   山：海拔 ≥ 1000 m，并且比邻格高出 150 m 以上或海拔 ≥ 2000 m；越高越大。丘陵：海拔 ≥ 250 m、起伏 ≥ 80 m（或海拔 ≥ 600 m）
//   森林：主导的生态是森林一类（group: forest，或地表是 forest、jungle）；年均温 < 3 °C 画针叶（三角），热带雨林一类画圆的一丛，
//   别的画阔叶。森林只留约一半的候选（比山稀）
//   每个候选一个圆（足迹，半径 r），两个符号的圆不相交（画出来的符号都在自己的圆里）。
// 不重叠又只看附近（确定、改一处只动那一片）：按优先级的两轮“比周围都大就留下”：
//   第一轮：和它相交的候选里它的优先级最高就留下；第二轮：和留下的都不相交的候选里再按同样的规则留一批。
//   山先于丘陵（优先级 2 + 大小、1 + …），森林在山、丘陵之后：和留下的山、丘陵都不相交的森林候选里按同样的规则留一轮。
//   优先级里的随机数按世界种子、格号、第几个候选、第几档算（与镜头、先后无关）。
// 缓存：按块（tile，第 k 档边长 TILE / 2^k 格距）算、按块缓存；一块的结果只取决于它四周 HALO 以内的格，键是这一片格的编码的哈希
// （按第 0 档的块预先合好）：改了高程只有那一片的块重算，别的块原样留着（同一个对象）

export const enum Sym {
  Mountain = 0,
  Hill = 1,
  Broadleaf = 2,
  Conifer = 3,
  Jungle = 4,
}

export interface SymbolTile {
  level: number;
  tx: number;
  ty: number;
  // 这一片格的编码的哈希（键）
  hash: number;
  // 每个符号 5 个数：x、y（地图单位）、足迹的半径、种类（Sym）、大小与随机（大小 0–1 的整数部分 × 1000 + 随机 0–1）
  syms: Float64Array;
  count: number;
}

// 一块的边长（第 0 档，格距）；第 k 档每格 4^k 个候选、块的边长 / 2^k、半径 / 2^k
export const TILE = 16;
export const MAX_LEVEL = 2;
// 足迹的半径（格距；第 0 档）
const R_MOUNT0 = 0.85;
const R_MOUNT1 = 1.2;
const R_HILL0 = 0.6;
const R_HILL1 = 0.3;
const R_FOREST = 0.7;
const R_MAX = R_MOUNT0 + R_MOUNT1;
// 一块的结果只取决于四周多远以内的候选（见文件开头：两轮、森林再一轮）：8 个最大半径 + 2 个森林的半径，再加候选离格心的 0.75 格
export const HALO = 8 * R_MAX + 2 * R_FOREST + 0.75;

// ---------- 每格的编码 ----------

// 每格一个数：0 没有符号；低 3 位是种类 + 1，再 7 位是大小（0–100）
export function cellCodes(world: World): Uint32Array {
  const { mesh, causes, derived: d, small } = world;
  const n = mesh.n;
  const out = new Uint32Array(n);
  const elev = d.elevation;
  const species = small.species;
  // 每种生态画成哪种树（0 不画）
  const treeOf = species.map((sp) => {
    const s = sp as { group?: string; terrain?: string };
    if (s.terrain === 'jungle') return Sym.Jungle + 1;
    if (s.group === 'forest' || s.terrain === 'forest') return Sym.Broadleaf + 1;
    return 0;
  });
  for (let i = 0; i < n; i++) {
    if (!causes.land[i] || d.lake[i] === 1) continue;
    const e = elev[i];
    let rel = 0;
    for (let k = mesh.off[i]; k < mesh.off[i + 1]; k++) {
      const v = e - elev[mesh.adj[k]];
      if (v > rel) rel = v;
    }
    if (e >= 1000 && (rel >= 150 || e >= 2000)) {
      out[i] = Sym.Mountain + 1 + (Math.round(Math.min(1, (e - 1000) / 3500) * 100) << 3);
      continue;
    }
    if (e >= 250 && (rel >= 80 || e >= 600)) {
      out[i] = Sym.Hill + 1 + (Math.round(Math.min(1, rel / 300) * 100) << 3);
      continue;
    }
    const dom = d.dominant[i];
    let t = dom >= 0 ? (treeOf[dom] ?? 0) : 0;
    if (t === Sym.Broadleaf + 1 && d.tMean[i] < 3) t = Sym.Conifer + 1;
    if (t) out[i] = t;
  }
  return out;
}

// ---------- 随机数（按格号、第几个、第几档、种子） ----------

function hash32(a: number, b: number, c: number, seed: number): number {
  let h = (Math.imul(a, 0x9e3779b1) ^ Math.imul(b + 0x7f4a7c15, 0x85ebca6b) ^ Math.imul(c + 0x165667b1, 0xc2b2ae35) ^ seed) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}
const unit = (h: number) => h / 4294967296;

// ---------- 网格上的桶（按格心） ----------

interface Buckets {
  size: number;
  nx: number;
  ny: number;
  start: Int32Array;
  cells: Int32Array;
}
const bucketCache = new WeakMap<object, Buckets>();
function bucketsOf(mesh: World['mesh']): Buckets {
  let b = bucketCache.get(mesh);
  if (b) return b;
  const size = mesh.spacing * 4;
  const nx = Math.max(1, Math.ceil(mesh.width / size));
  const ny = Math.max(1, Math.ceil(mesh.height / size));
  const count = new Int32Array(nx * ny + 1);
  const at = new Int32Array(mesh.n);
  for (let i = 0; i < mesh.n; i++) {
    const bx = Math.min(nx - 1, Math.max(0, Math.floor(mesh.x[i] / size)));
    const by = Math.min(ny - 1, Math.max(0, Math.floor(mesh.y[i] / size)));
    at[i] = by * nx + bx;
    count[at[i] + 1]++;
  }
  for (let k = 0; k < nx * ny; k++) count[k + 1] += count[k];
  const fill = count.slice(0, nx * ny);
  const cells = new Int32Array(mesh.n);
  for (let i = 0; i < mesh.n; i++) cells[fill[at[i]]++] = i;
  b = { size, nx, ny, start: count, cells };
  bucketCache.set(mesh, b);
  return b;
}

// ---------- 一个世界的符号 ----------

export interface SymbolSet {
  world: World;
  // 算它时的几个数组（引擎就地换掉推导时世界还是同一个对象：按它们认）
  inputs: unknown[];
  codes: Uint32Array;
  // 第 0 档每块的编码的哈希（nbx × nby）
  blockHash: Uint32Array;
  nbx: number;
  nby: number;
  seed: number;
}

// 同一个网格、同一种子的块的缓存（每档一张表）：换了世界（快照）时键相同的块原样留着
interface TileStore {
  seed: number;
  levels: Map<number, SymbolTile>[];
}
const stores = new WeakMap<object, TileStore>();
const sets = new WeakMap<World, SymbolSet>();
// 每档最多留多少块（看全图约一两百块；放大后块小，留多一些）
const STORE_MAX = 6000;

const inputsOf = (w: World): unknown[] => [w.mesh, w.causes.land, w.derived.elevation, w.derived.lake, w.derived.dominant, w.derived.tMean, w.small.species, w.settings.seed];
export function symbolSet(world: World): SymbolSet {
  let s = sets.get(world);
  const inputs = inputsOf(world);
  if (s && s.inputs.every((v, k) => v === inputs[k])) return s;
  const { mesh } = world;
  const codes = cellCodes(world);
  const bs = TILE * mesh.spacing;
  const nbx = Math.max(1, Math.ceil(mesh.width / bs));
  const nby = Math.max(1, Math.ceil(mesh.height / bs));
  const blockHash = new Uint32Array(nbx * nby).fill(2166136261);
  for (let i = 0; i < mesh.n; i++) {
    const c = codes[i];
    if (!c) continue;
    const bx = Math.min(nbx - 1, Math.max(0, Math.floor(mesh.x[i] / bs)));
    const by = Math.min(nby - 1, Math.max(0, Math.floor(mesh.y[i] / bs)));
    const k = by * nbx + bx;
    blockHash[k] = Math.imul(blockHash[k] ^ hash32(i, c, 0, 0), 16777619) >>> 0;
  }
  s = { world, inputs, codes, blockHash, nbx, nby, seed: world.settings.seed | 0 };
  sets.set(world, s);
  return s;
}

function storeOf(set: SymbolSet): TileStore {
  const mesh = set.world.mesh;
  let st = stores.get(mesh);
  if (!st || st.seed !== set.seed) {
    st = { seed: set.seed, levels: Array.from({ length: MAX_LEVEL + 1 }, () => new Map()) };
    stores.set(mesh, st);
  }
  return st;
}

// 第 k 档一块的边长（地图单位）
export const tileSize = (spacing: number, level: number) => (TILE * spacing) / (1 << level);

// 一块四周 HALO 以内的第 0 档的块的哈希合起来
function regionHash(set: SymbolSet, level: number, tx: number, ty: number): number {
  const sp = set.world.mesh.spacing;
  const ts = tileSize(sp, level);
  const halo = (HALO * sp) / (1 << level);
  const bs = TILE * sp;
  const bx0 = Math.max(0, Math.floor((tx * ts - halo) / bs));
  const by0 = Math.max(0, Math.floor((ty * ts - halo) / bs));
  const bx1 = Math.min(set.nbx - 1, Math.floor(((tx + 1) * ts + halo) / bs));
  const by1 = Math.min(set.nby - 1, Math.floor(((ty + 1) * ts + halo) / bs));
  let h = hash32(level, tx, ty, set.seed);
  for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) h = Math.imul(h ^ set.blockHash[by * set.nbx + bx], 16777619) >>> 0;
  return h;
}

// 第 k 档的一块（缓存里键相同时原样给回同一个对象）
export function symbolTile(set: SymbolSet, level: number, tx: number, ty: number): SymbolTile {
  const store = storeOf(set);
  const map = store.levels[level];
  const id = ty * 65536 + tx;
  const hash = regionHash(set, level, tx, ty);
  const hit = map.get(id);
  if (hit && hit.hash === hash) {
    // 最近用过的放到最后（超过上限时先丢最久没用的）
    map.delete(id);
    map.set(id, hit);
    return hit;
  }
  const t = placeTile(set, level, tx, ty, hash);
  map.delete(id);
  map.set(id, t);
  if (map.size > STORE_MAX) for (const k of map.keys()) {
    map.delete(k);
    if (map.size <= STORE_MAX) break;
  }
  return t;
}

// 看得见的块（地图单位的矩形 x0..x1、y0..y1）
export function tilesIn(set: SymbolSet, level: number, x0: number, y0: number, x1: number, y1: number): SymbolTile[] {
  const { mesh } = set.world;
  const ts = tileSize(mesh.spacing, level);
  const nx = Math.ceil(mesh.width / ts);
  const ny = Math.ceil(mesh.height / ts);
  const tx0 = Math.max(0, Math.floor(x0 / ts));
  const ty0 = Math.max(0, Math.floor(y0 / ts));
  const tx1 = Math.min(nx - 1, Math.floor(x1 / ts));
  const ty1 = Math.min(ny - 1, Math.floor(y1 / ts));
  const out: SymbolTile[] = [];
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) out.push(symbolTile(set, level, tx, ty));
  return out;
}

// ---------- 一块的放法 ----------

// 候选（一片里的）：位置、半径、优先级、种类、大小
interface Cands {
  n: number;
  x: Float64Array;
  y: Float64Array;
  r: Float64Array;
  prio: Float64Array;
  kind: Uint8Array;
  size: Float64Array;
  rand: Float64Array;
}

function gather(set: SymbolSet, level: number, x0: number, y0: number, x1: number, y1: number): Cands {
  const { mesh } = set.world;
  const sp = mesh.spacing;
  const b = bucketsOf(mesh);
  const m = 1 << level;
  const per = m * m;
  const pad = sp;
  const bx0 = Math.max(0, Math.floor((x0 - pad) / b.size));
  const by0 = Math.max(0, Math.floor((y0 - pad) / b.size));
  const bx1 = Math.min(b.nx - 1, Math.floor((x1 + pad) / b.size));
  const by1 = Math.min(b.ny - 1, Math.floor((y1 + pad) / b.size));
  const list: number[] = [];
  for (let by = by0; by <= by1; by++)
    for (let bx = bx0; bx <= bx1; bx++) {
      const k = by * b.nx + bx;
      for (let q = b.start[k]; q < b.start[k + 1]; q++) if (set.codes[b.cells[q]]) list.push(b.cells[q]);
    }
  const cap = list.length * per;
  const c: Cands = { n: 0, x: new Float64Array(cap), y: new Float64Array(cap), r: new Float64Array(cap), prio: new Float64Array(cap), kind: new Uint8Array(cap), size: new Float64Array(cap), rand: new Float64Array(cap) };
  const scale = sp / m;
  for (const i of list) {
    const code = set.codes[i];
    const kind = (code & 7) - 1;
    const size = (code >>> 3) / 100;
    for (let j = 0; j < per; j++) {
      const h1 = hash32(i, j, level, set.seed);
      const h2 = hash32(i, j, level + 17, set.seed ^ 0x5bd1e995);
      // 森林只留约一半的候选
      const forest = kind >= Sym.Broadleaf;
      if (forest && unit(h2) < 0.45) continue;
      const gx = j % m;
      const gy = (j / m) | 0;
      const x = mesh.x[i] + ((gx + 0.5) / m - 0.5) * sp + (unit(h1) - 0.5) * 0.5 * scale;
      const y = mesh.y[i] + ((gy + 0.5) / m - 0.5) * sp + (unit(hash32(h1, j, 3, set.seed)) - 0.5) * 0.5 * scale;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const rr = kind === Sym.Mountain ? R_MOUNT0 + R_MOUNT1 * size : kind === Sym.Hill ? R_HILL0 + R_HILL1 * size : R_FOREST;
      const k = c.n++;
      c.x[k] = x;
      c.y[k] = y;
      c.r[k] = rr * scale;
      c.kind[k] = kind;
      c.size[k] = size;
      c.rand[k] = unit(h2);
      // 山 2 + 大小，丘陵 1，森林 0（森林另一轮），再加一点随机；同优先级按格号、第几个（几乎碰不到）
      c.prio[k] = (kind === Sym.Mountain ? 2 + size : kind === Sym.Hill ? 1 + 0.5 * size : 0) + 0.35 * unit(h1) + (i * per + j) * 1e-12;
    }
  }
  return c;
}

// 一部分候选（only 里的）按格子分桶，查和 k 相交的（两圆的距离 < 半径之和）。cell 不小于这一部分的最大半径加上要查的候选的最大半径
function grid(c: Cands, only: (k: number) => boolean, x0: number, y0: number, x1: number, y1: number, cell: number) {
  const nx = Math.max(1, Math.ceil((x1 - x0) / cell) + 1);
  const ny = Math.max(1, Math.ceil((y1 - y0) / cell) + 1);
  const head = new Int32Array(nx * ny).fill(-1);
  const next = new Int32Array(c.n);
  const at = (x: number, y: number) => Math.min(ny - 1, Math.max(0, Math.floor((y - y0) / cell))) * nx + Math.min(nx - 1, Math.max(0, Math.floor((x - x0) / cell)));
  for (let k = 0; k < c.n; k++) {
    if (!only(k)) continue;
    const g = at(c.x[k], c.y[k]);
    next[k] = head[g];
    head[g] = k;
  }
  const each = (k: number, fn: (j: number) => boolean | void) => {
    const gx = Math.min(nx - 1, Math.max(0, Math.floor((c.x[k] - x0) / cell)));
    const gy = Math.min(ny - 1, Math.max(0, Math.floor((c.y[k] - y0) / cell)));
    for (let yy = Math.max(0, gy - 1); yy <= Math.min(ny - 1, gy + 1); yy++)
      for (let xx = Math.max(0, gx - 1); xx <= Math.min(nx - 1, gx + 1); xx++)
        for (let j = head[yy * nx + xx]; j >= 0; j = next[j]) {
          if (j === k) continue;
          const dx = c.x[j] - c.x[k];
          const dy = c.y[j] - c.y[k];
          const rs = c.r[j] + c.r[k];
          if (dx * dx + dy * dy < rs * rs && fn(j) === true) return true;
        }
    return false;
  };
  return each;
}

function placeTile(set: SymbolSet, level: number, tx: number, ty: number, hash: number): SymbolTile {
  const sp = set.world.mesh.spacing;
  const ts = tileSize(sp, level);
  const halo = (HALO * sp) / (1 << level);
  const x0 = tx * ts - halo;
  const y0 = ty * ts - halo;
  const x1 = (tx + 1) * ts + halo;
  const y1 = (ty + 1) * ts + halo;
  const c = gather(set, level, x0, y0, x1, y1);
  const relief = (k: number) => c.kind[k] <= Sym.Hill;
  const forest = (k: number) => c.kind[k] > Sym.Hill;
  // 山、丘陵与森林各一张格子（森林的圆小得多，格子细，查得少）：相交的两圆的中心最远差两个半径之和，格子的边长不小于它
  const sc = 1 / (1 << level);
  const eachR = grid(c, relief, x0, y0, x1, y1, 2 * R_MAX * sp * sc);
  const eachF = grid(c, forest, x0, y0, x1, y1, 2 * R_FOREST * sp * sc);
  // 0 没定，1 留下，2 去掉（挨着留下的）
  const st = new Uint8Array(c.n);
  // 一轮：和它相交、还没定的同一类候选里它的优先级最高就留下；之后挨着留下的去掉
  const round = (pick: (k: number) => boolean, each: typeof eachR) => {
    const win: number[] = [];
    for (let k = 0; k < c.n; k++) {
      if (st[k] || !pick(k)) continue;
      if (!each(k, (j) => st[j] === 0 && c.prio[j] > c.prio[k])) win.push(k);
    }
    for (const k of win) st[k] = 1;
    for (let k = 0; k < c.n; k++) if (!st[k] && pick(k) && each(k, (j) => st[j] === 1)) st[k] = 2;
  };
  round(relief, eachR);
  round(relief, eachR);
  // 森林：挨着留下的山、丘陵的去掉（森林的圆加最大的山不超过山的格子），再留一轮
  for (let k = 0; k < c.n; k++) if (forest(k) && eachR(k, (j) => st[j] === 1)) st[k] = 2;
  round(forest, eachF);
  // 这一块里的（按 y 排：下面的后画）
  const keep: number[] = [];
  const tx0 = tx * ts;
  const ty0 = ty * ts;
  for (let k = 0; k < c.n; k++) if (st[k] === 1 && c.x[k] >= tx0 && c.x[k] < tx0 + ts && c.y[k] >= ty0 && c.y[k] < ty0 + ts) keep.push(k);
  keep.sort((a, b) => c.y[a] - c.y[b] || c.x[a] - c.x[b]);
  const syms = new Float64Array(keep.length * 5);
  keep.forEach((k, q) => {
    syms[q * 5] = c.x[k];
    syms[q * 5 + 1] = c.y[k];
    syms[q * 5 + 2] = c.r[k];
    syms[q * 5 + 3] = c.kind[k];
    syms[q * 5 + 4] = Math.round(c.size[k] * 100) * 1000 + Math.min(0.999, c.rand[k]);
  });
  return { level, tx, ty, hash, syms, count: keep.length };
}

// 一格在屏幕上多少像素时用第几档（放大后符号小一些、密一些）；太小（< 2.5 像素）时不画
export function symbolLevel(cellPx: number): number {
  if (cellPx < 2.5) return -1;
  return cellPx < 14 ? 0 : cellPx < 30 ? 1 : 2;
}
