import { MinHeap } from './heap';
import { type Mesh, gradGeo, gradientAt } from './mesh';
import { type Noise2, type Noise3, fbm, fbm3, gradientNoise, gradientNoise3, mixSeed } from './rng';
import { FJ, type TileNet, type FjordNet, hash01, cellPos, segDist, P3, scratchOf } from './fjord-base';
import { cellPoints, dist3, linkBits } from './fjord-cells';
export { FJ, sphereProvDel, provOfTri, provOnEdge, segDist, candOf, fjordSegField, FJ_REACH, fjBest, fjordField, fjordFieldBound, fjordK } from './fjord-base';
export type { FjordNet } from './fjord-base';
export { fjordLayer, budgets, fjordSystems } from './fjord-layer';
export type { FjordLayer, FjordWet } from './fjord-layer';

// ---------- 峡湾（第三十六轮） ----------
// 第三十四轮的峡湾是一排排一样长、一样斜的短槽（噪声的零线沿坡向拉长，深入约一格）。真的峡湾是被淹的冰川谷：
// 少而长（主峡湾深入几格）、分汊（支谷从两旁接进来）、顺着谷弯曲、间距不匀，岸外是一片岛礁。这里：
//   1. 谷网（新建时定、按生成器）：冰川海岸一带（coast-style 的峡湾权重往外推两圈后 > ZONE 的格，陆、海都算）每格撒 NPC 个点，
//      点与本格、邻格的点连成图（连线不贴近格心，最长 LINK 格与 LINK_KM 取小）；按“谷底高度”V（地壳高度 b0 + 坡度 + 噪声）
//      从这一带的边上往里漫（priority flood），每个点流向漫到它的那个点：一棵棵树（谷网），汇水多的是主谷。点沿主谷平滑，
//      每段的中点取 Catmull–Rom 曲线上的（画成两小段，弯一点）。谷网按块建（平面约 TILE_KM 见方，星球按单位球上的立方格子），
//      谷不过块的边：一块只取决于这一块与邻格的生成器分量、网格、种子；重新生成一片时只重建峡湾权重、地壳高度变了的格碰到的块，
//      结果与整张重建逐值相同。陆海改了谷网不变；
//   2. 哪一段淹成峡湾（按陆海，几千到一两万个点走一遍）：都按 km，与格多大无关。陆上的点流进海里的点时，入海口的预算是
//      LEN_KM × 权重 × 地点的倍数（低频噪声）× 汇水因子（汇水面积不到 ACC_MOUTH_KM2 的不淹），最多 LEN_CAP_KM（约 350 km）；
//      主湾往上游每走一段减去这段的长度；支湾每个峡湾最多 MAX_ARMS 条（离入海口近的先），汇水面积至少 ACC_SIDE_KM2、
//      与主湾的夹角至少 ARM_ANGLE 度，长度不过汇合处主湾剩下的 ARM_FRAC 倍。往上游跑偏（与地壳往上的方向夹角超过 DIR_MAX）
//      的段、离入海口 COAST_KM 以外贴着海岸走（离海不到 COAST_K × 走过的长度）的段不淹：峡湾往内陆走、不顺着海岸走，
//      一个峡湾只在离岸约 350 km 的一带里，再往里的段不进表。预算在一段中间用完时淹到那里为止（圆头的峡湾头、短短的支湾）。
//      半宽按 km（HW_KM，汇水大的宽，越往入海口越宽）；
//   3. 画法（着色器与 CPU 同一个算式，fjordSegField）：淹着的每一小段是一条带，半宽 r 从入海口往里先宽后窄；
//      海岸场取 min(s, (d' − r') · K)，K 很大（离带子 EDGE 格以内就涨到 SMAX），带子以外一点都不改；
//      d' 是中线按海岸细节的噪声往一侧挪了 LAT × r 以后的距离，r' = r × 格心的权重 ×（1 + WOB × (2|nd| − WOB_C)）：岸弯弯曲曲、宽窄有变化。
//      哪几段可能碰到一点：每格一张表，收“最后一个顶点是这一格”的画面三角形碰得到的淹着的段；着色器拿最后一个顶点的表号（flat），
//      CPU 按找到的三角形取同一格（subcell.ts 的 located.prov；整个星球接缝外的影子三角形按三格对回画面上的那个）。
//      表按陆海每次重建，只收陆上的段（海里的段刻了也没有用）。
// 纹理（RGBA32F，TEX_W 宽）：前 nRank 个 texel 是有表的格（rank 按格编号，不随陆海变，打包进海岸值纹理的 b）的表头
// （第一段的位置、段数、0、0）；之后每小段三个 texel：(端点 0, r0)、(端点 1, r1)、(入海口的海格, 0, 0, 0)。
// 平面世界的端点是地图坐标（z = 0），整个星球是单位球上的点（距离是弧度）
// 各段耗时（测速用，毫秒，累加）；第八十八轮：“#build”“#reweigh”是整块重建、只重算预算的块数
export const fjLaps: Record<string, number> = {};
let lapT = 0;
function lap(name: string): void {
  const t = performance.now();
  fjLaps[name] = (fjLaps[name] ?? 0) + t - lapT;
  lapT = t;
}
const gOut = new Float64Array(2);

// 每格在哪一块（只看格心的位置）：平面按 TILE_KM 见方的格子，星球按单位球上 TILE_KM 的立方格子。按网格与比例尺缓存
const tileCache = new WeakMap<Mesh, { km: number; tile: Float64Array; cells: Map<number, Int32Array> }>();
// 每块的全部格（升序）
function tileInfo(mesh: Mesh, kmPerUnit: number): { tile: Float64Array; cells: Map<number, Int32Array> } {
  const c = tileCache.get(mesh);
  if (c && c.km === kmPerUnit) return c;
  const tile = new Float64Array(mesh.n);
  if (mesh.kind === 'sphere') {
    const s = kmPerUnit / Math.PI / FJ.TILE_KM;
    for (let i = 0; i < mesh.n; i++) {
      const ix = Math.floor(mesh.p[3 * i] * s) + 512;
      const iy = Math.floor(mesh.p[3 * i + 1] * s) + 512;
      const iz = Math.floor(mesh.p[3 * i + 2] * s) + 512;
      tile[i] = (ix * 1024 + iy) * 1024 + iz;
    }
  } else {
    const s = kmPerUnit / FJ.TILE_KM;
    for (let i = 0; i < mesh.n; i++) tile[i] = (Math.floor(mesh.x[i] * s) + 512) * 1024 + Math.floor(mesh.y[i] * s) + 512;
  }
  const lists = new Map<number, number[]>();
  for (let i = 0; i < mesh.n; i++) {
    let l = lists.get(tile[i]);
    if (!l) lists.set(tile[i], (l = []));
    l.push(i);
  }
  const cells = new Map<number, Int32Array>();
  for (const [k, l] of lists) cells.set(k, Int32Array.from(l));
  const out = { km: kmPerUnit, tile, cells };
  tileCache.set(mesh, out);
  return out;
}

// 一块里谷网一带的格（升序）
function zoneCellsOf(all: Int32Array, wz: Float32Array): Int32Array {
  let k = 0;
  for (let q = 0; q < all.length; q++) if (wz[all[q]] > FJ.ZONE) k++;
  const out = new Int32Array(k);
  k = 0;
  for (let q = 0; q < all.length; q++) if (wz[all[q]] > FJ.ZONE) out[k++] = all[q];
  return out;
}

interface Ctx {
  mesh: Mesh;
  seed: number;
  sph: boolean;
  sp: number;
  spDist: number;
  kmCell: number;
  wz: Float32Array;
  b0: Float32Array;
  tile: Float64Array;
  geo: ReturnType<typeof gradGeo>;
}

// fj：每格的峡湾权重（coast-style 的 fjord）；b0：地壳高度；kmPerUnit：比例尺。没有一格在谷网里时 null。
// prev、dirty（重画一片）：只重建有 dirty 的格的块，别的块照用 prev 的（每块只取决于这一块与邻格的输入，结果与整个重建逐值相同）。
// dirty 要盖住峡湾权重变了的格往外三圈、地壳高度变了的格往外一圈（推两圈的一带、坡度、边上的点与邻格的权重）
// b0Dirty（第八十八轮）：地壳高度变了的格往外一圈（给了时，要重建的块里一带的格与上一份相同、其中没有这样的格，就照用几何、只重算预算）
export function buildFjordNet(mesh: Mesh, seed: number, kmPerUnit: number, fj: Float32Array, b0: Float32Array, prev: FjordNet | null = null, dirty: Uint8Array | null = null, b0Dirty: Uint8Array | null = null): FjordNet | null {
  const sph = mesh.kind === 'sphere';
  const sp = mesh.spacing;
  const spDist = sph ? Math.PI * sp : sp;
  lapT = performance.now();
  // 谷网的一带：峡湾权重往外推两圈（每圈 × GROW），谷能伸进海里（入海口不被岸边一两格堵住）
  let wz: Float32Array;
  if (prev && dirty) {
    // 推两圈的权重只在 dirty 的格里重算（每格只取决于两圈以内的峡湾权重）
    wz = prev.wz.slice();
    regrow(mesh, fj, dirty, wz);
  } else wz = growZone(mesh, fj);
  const info = tileInfo(mesh, kmPerUnit);
  const tile = info.tile;
  // 要（重）建的块：整个重建时是全部的块；重画一片时是有 dirty 的格的块（谷网一带只在 dirty 的格里变，别的块的格不变）
  const old = new Map<number, TileNet>();
  if (prev) for (const t of prev.tiles) old.set(t.key, t);
  const redo = new Set<number>();
  if (prev && dirty) {
    dirtyTiles(dirty, tile, redo);
  } else for (const k of info.cells.keys()) redo.add(k);
  const fresh = new Map<number, Int32Array>();
  for (const k of redo) {
    const z = zoneCellsOf(info.cells.get(k)!, wz);
    if (z.length) fresh.set(k, z);
  }
  // 要重建的块前后都不在谷网一带里：谷网不变（只换推两圈的权重，那些格都不到 ZONE；块、表号、碰得到的格都照用）
  if (prev && dirty && !fresh.size && !hasAny(old, redo)) {
    lap('grow');
    return { ...prev, wz };
  }
  const keySet = new Set<number>(fresh.keys());
  for (const k of old.keys()) if (!redo.has(k)) keySet.add(k);
  lap('grow');
  if (!keySet.size) return null;
  const keys = [...keySet].sort((a, b) => a - b);
  const ctx: Ctx = { mesh, seed, sph, sp, spDist, kmCell: sp * kmPerUnit, wz, b0, tile, geo: gradGeo(mesh) };
  const tiles: TileNet[] = [];
  for (const k of keys) {
    const z = fresh.get(k);
    const o = old.get(k);
    if (!z) tiles.push(o!);
    else if (o && b0Dirty && fjordGeoReuse.on && sameGeometry(o, z, b0Dirty)) {
      tiles.push(reweighTile(ctx, o));
      fjLaps['#reweigh'] = (fjLaps['#reweigh'] ?? 0) + 1;
    } else {
      tiles.push(buildTile(ctx, k, z));
      fjLaps['#build'] = (fjLaps['#build'] ?? 0) + 1;
    }
  }
  lap('tiles');
  // 一带变了的格（只在 dirty 的格里）：有表的格只在它们附近重算（一个都没有时表号照用上一份）
  let flips: number[] | null = null;
  if (prev && dirty) {
    flips = flipsOf(dirty, wz, prev.wz);
  }
  const net = assemble(ctx, tiles, prev, flips);
  lap('assemble');
  return net;
}

// 第八十八轮（提速）：buildFjordNet 里逐格的几段放进模块里的小函数（原样照搬）
// dirty 的格重算推两圈的权重
function regrow(mesh: Mesh, fj: Float32Array, dirty: Uint8Array, wz: Float32Array): void {
  for (let i = 0; i < dirty.length; i++) if (dirty[i]) wz[i] = grownAt(mesh, fj, i);
}

// dirty 的格所在的块
function dirtyTiles(dirty: Uint8Array, tile: Float64Array, redo: Set<number>): void {
  let last = NaN;
  for (let i = 0; i < dirty.length; i++) {
    if (!dirty[i] || tile[i] === last) continue;
    last = tile[i];
    redo.add(last);
  }
}

// 一带变了的格（只在 dirty 的格里）
function flipsOf(dirty: Uint8Array, wz: Float32Array, was: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < dirty.length; i++) if (dirty[i] && wz[i] > FJ.ZONE !== was[i] > FJ.ZONE) out.push(i);
  return out;
}

function hasAny(m: Map<number, unknown>, keys: Set<number>): boolean {
  for (const k of keys) if (m.has(k)) return true;
  return false;
}

// 一块：撒点、连线、漫、汇水、平滑、中点、长度与预算、两个标记
function buildTile(ctx: Ctx, key: number, cells: Int32Array): TileNet {
  const { mesh, seed, sph, spDist, kmCell, tile } = ctx;
  const sc = scratchOf(mesh);
  const local = sc.local;
  for (let z = 0; z < cells.length; z++) local[cells[z]] = z;
  const NPC = FJ.NPC;
  const N = cells.length * NPC;
  const pos = new Float64Array(3 * N);
  const V = new Float64Array(N);
  const owner = new Int32Array(N);
  // 每格往上的方向（三维，每格的高差 m）
  const up = new Float64Array(3 * cells.length);
  for (let z = 0; z < cells.length; z++) placeCell(ctx, cells[z], z, pos, V, owner, up);
  // 连线：本格与同一块里的邻格的点，LINK 格以内、离要看的格心都至少 CENTER_GAP 格（第八十八轮：连不连按网格记着，core/fjord-cells.ts）
  const linkOff = new Int32Array(N + 1);
  const links: number[] = [];
  for (let z = 0; z < cells.length; z++) {
    const c = cells[z];
    for (let k = 0; k < NPC; k++) {
      const u = z * NPC + k;
      for (let e = mesh.off[c] - 1; e < mesh.off[c + 1]; e++) {
        const j = e < mesh.off[c] ? c : mesh.adj[e];
        if (local[j] < 0 || tile[j] !== key) continue;
        const row = (linkBits(mesh, seed, kmCell, c, e < mesh.off[c] ? -1 : e) >> (k * NPC)) & ((1 << NPC) - 1);
        if (row === 0) continue;
        const base = local[j] * NPC;
        for (let k2 = 0; k2 < NPC; k2++) if (row & (1 << k2)) links.push(base + k2);
      }
      linkOff[u + 1] = links.length;
    }
  }
  const link = Int32Array.from(links);
  // 从边上往里漫：有不在这一块谷网一带里的邻格的格的点先进堆，按谷底高度
  const recv = new Int32Array(N).fill(-1);
  const seen = new Uint8Array(N);
  const keyV = new Float64Array(N);
  const popOrder = new Int32Array(N);
  const heap = new MinHeap(N);
  for (let z = 0; z < cells.length; z++) {
    const c = cells[z];
    let edge = false;
    for (let e = mesh.off[c]; e < mesh.off[c + 1] && !edge; e++) {
      const j = mesh.adj[e];
      if (local[j] < 0 || tile[j] !== key) edge = true;
    }
    if (!edge) continue;
    for (let k = 0; k < NPC; k++) {
      const u = z * NPC + k;
      seen[u] = 1;
      keyV[u] = V[u];
      heap.push(u, V[u]);
    }
  }
  let popped = flood(heap, link, linkOff, V, keyV, seen, recv, popOrder, 0);
  for (let u = 0; u < N && popped < N; u++) {
    if (seen[u]) continue;
    let lo = u;
    for (let w = u; w < N; w++) if (!seen[w] && V[w] < V[lo]) lo = w;
    seen[lo] = 1;
    keyV[lo] = V[lo];
    heap.push(lo, V[lo]);
    popped = flood(heap, link, linkOff, V, keyV, seen, recv, popOrder, popped);
  }
  for (let z = 0; z < cells.length; z++) local[cells[z]] = -1;
  // 汇水、主支、谷里的点
  const acc = new Float32Array(N).fill(1);
  for (let q = N - 1; q >= 0; q--) {
    const u = popOrder[q];
    if (recv[u] >= 0) acc[recv[u]] += acc[u];
  }
  const main = new Int32Array(N).fill(-1);
  for (let q = 0; q < N; q++) {
    const u = popOrder[q];
    const v = recv[u];
    if (acc[u] < FJ.ACC_MIN || v < 0) continue;
    const m = main[v];
    if (m < 0 || acc[u] > acc[m] || (acc[u] === acc[m] && u < m)) main[v] = u;
  }
  const ord: number[] = [];
  for (let q = 0; q < N; q++) {
    const u = popOrder[q];
    if (acc[u] >= FJ.ACC_MIN) ord.push(u);
  }
  const order = Int32Array.from(ord);
  smoothNet(mesh, pos, owner, order, recv, main, sph, FJ.SMOOTH, spDist);
  const mid = midpoints(pos, order, recv, main, sph, N);
  const t: TileNet = {
    key,
    n: N,
    pos,
    mid,
    owner,
    recv,
    order,
    len: new Float32Array(N),
    lc: new Float32Array(N),
    lsea: new Float32Array(N),
    lcs: new Float32Array(N).fill(-1),
    hw: new Float32Array(N),
    isMain: new Uint8Array(N),
    dirOk: new Uint8Array(N),
    cands: new Array<Int32Array | null>(N).fill(null),
    geo: { cells, m: new Float64Array(N), area: new Float64Array(N), af: new Float64Array(N), side: new Float64Array(N).fill(NaN) },
  };
  const ln2 = sph ? null : gradientNoise(mixSeed(seed, 3604));
  const ln3 = sph ? gradientNoise3(mixSeed(seed, 3604)) : null;
  for (let q = 0; q < order.length; q++) nodeBudget(ctx, t, cells, acc, main, up, order[q], ln2, ln3);
  return t;
}

// 测试、测速用：关掉照用几何（第八十八轮以前：要重建的块都整块重建）
export const fjordGeoReuse = { on: true };

// 第八十八轮：几何照用（一带的格、地壳高度都没变），只按现在的峡湾权重重算三个预算（与 nodeBudget 同一个函数 nodeWeights：逐值相同）。
// 别的数组（连同用到时才算的碰得到的格）与上一份共用：它们只取决于几何
function reweighTile(ctx: Ctx, old: TileNet): TileNet {
  const N = old.n;
  const t: TileNet = { ...old, lc: new Float32Array(N), lsea: new Float32Array(N), lcs: new Float32Array(N).fill(-1) };
  const { geo, order } = t;
  for (let q = 0; q < order.length; q++) {
    const u = order[q];
    nodeWeights(ctx, t, geo.cells[Math.floor(u / FJ.NPC)], u);
  }
  return t;
}

// 几何能不能照用：这一块的一带的格与上一份的相同，其中没有一格的地壳高度（连同一圈邻格的，b0Dirty）变了
function sameGeometry(old: TileNet, cells: Int32Array, b0Dirty: Uint8Array): boolean {
  const was = old.geo.cells;
  if (was.length !== cells.length) return false;
  for (let k = 0; k < cells.length; k++) if (was[k] !== cells[k] || b0Dirty[cells[k]]) return false;
  return true;
}

// 一个点的三个预算（只这几样读峡湾权重）：海里的预算、入海口的预算，支湾的上限（是支湾的点）
function nodeWeights(ctx: Ctx, t: TileNet, c: number, u: number): void {
  const { mesh, wz } = ctx;
  const { m, area, af, side } = t.geo;
  let wm = wz[c];
  for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) if (wz[mesh.adj[e]] > wm) wm = wz[mesh.adj[e]];
  t.lsea[u] = Math.min(FJ.LEN_CAP_KM, FJ.LEN_KM * wm * m[u]);
  t.lc[u] = area[u] < FJ.ACC_MOUTH_KM2 ? 0 : Math.min(FJ.LEN_CAP_KM, FJ.LEN_KM * wz[c] * m[u] * af[u]);
  const s = side[u];
  if (s === s) t.lcs[u] = FJ.LEN_KM * wz[c] * m[u] * af[u] * s;
}

// 撒点：格 c（块里第 z 格）的 NPC 个点，绕格心一圈（起始角随机、每个再抖一点），离格心 R0 + R1 × 随机 格；谷底高度；往上的方向。
// 第八十八轮：点的位置、位移、噪声、最近的格心按网格记着（core/fjord-cells.ts 的 cellPoints，算式不变），这里只读地壳高度那部分
function placeCell(ctx: Ctx, c: number, z: number, pos: Float64Array, V: Float64Array, owner: Int32Array, up: Float64Array): void {
  const { mesh, seed, sp, b0, geo } = ctx;
  const NPC = FJ.NPC;
  gradientAt(mesh, geo, b0, c, gOut);
  const gx = gOut[0];
  const gy = gOut[1];
  const slope = Math.hypot(gx, gy) * sp;
  const amp = FJ.V_NOISE * slope + FJ.V_NOISE0;
  const P = cellPoints(mesh, seed, c);
  const B = P.basis;
  const b = 6 * c;
  up[3 * z] = (gx * B[b] + gy * B[b + 3]) * sp;
  up[3 * z + 1] = (gx * B[b + 1] + gy * B[b + 4]) * sp;
  up[3 * z + 2] = (gx * B[b + 2] + gy * B[b + 5]) * sp;
  for (let k = 0; k < NPC; k++) {
    const u = z * NPC + k;
    const q = c * NPC + k;
    pos[3 * u] = P.pos[3 * q];
    pos[3 * u + 1] = P.pos[3 * q + 1];
    pos[3 * u + 2] = P.pos[3 * q + 2];
    V[u] = b0[c] + gx * P.dx[q] + gy * P.dy[q] + amp * P.nz[q];
    owner[u] = P.owner[q];
  }
}

// 一个点的长度（km）、预算、半宽与两个标记
function nodeBudget(ctx: Ctx, t: TileNet, cells: Int32Array, acc: Float32Array, main: Int32Array, up: Float64Array, u: number, ln2: Noise2 | null, ln3: Noise3 | null): void {
  const { sph, sp, spDist, kmCell } = ctx;
  const { pos, recv, geo } = t;
  const v = recv[u];
  const z = Math.floor(u / FJ.NPC);
  const c = cells[z];
  if (v >= 0) t.len[u] = (dist3(pos, u, v) / spDist) * kmCell;
  const x = pos[3 * u];
  const y = pos[3 * u + 1];
  const zz = pos[3 * u + 2];
  const m = Math.min(FJ.M_MAX, Math.max(FJ.M_MIN, FJ.LEN_M0 + FJ.LEN_M1 * (sph ? fbm3(ln3!, x / spDist, y / spDist, zz / spDist, FJ.LEN_FREQ, 2) : fbm(ln2!, x / sp, y / sp, FJ.LEN_FREQ, 2)) * 2));
  // 汇水按 km²（一个点约 0.866 格距² / NPC）：格多大都一样
  const area = acc[u] * ((0.866 * kmCell * kmCell) / FJ.NPC);
  const af = Math.sqrt(Math.min(1, area / FJ.ACC1_KM2));
  geo.m[u] = m;
  geo.area[u] = area;
  geo.af[u] = af;
  t.hw[u] = (FJ.HW_KM * (FJ.HW_A + (1 - FJ.HW_A) * af)) / kmCell;
  if (v >= 0) nodeGeometry(ctx, t, main, up, u, v, z, c, x, y, zz, area);
  nodeWeights(ctx, t, c, u);
}

// 一个点往下游的那一段的几何：主支、方向有没有跑偏、是不是支湾（是的话记下支湾的随机倍数）
function nodeGeometry(ctx: Ctx, t: TileNet, main: Int32Array, up: Float64Array, u: number, v: number, z: number, c: number, x: number, y: number, zz: number, area: number): void {
  const { seed, kmCell } = ctx;
  const { pos } = t;
  t.isMain[u] = main[v] === u ? 1 : 0;
  // 往上游的方向与往上的方向的夹角
  const dx = x - pos[3 * v];
  const dy = y - pos[3 * v + 1];
  const dz = zz - pos[3 * v + 2];
  const gl = Math.hypot(up[3 * z], up[3 * z + 1], up[3 * z + 2]);
  const dl = Math.hypot(dx, dy, dz);
  t.dirOk[u] = gl < FJ.DIR_FLAT_KM * kmCell || dx * up[3 * z] + dy * up[3 * z + 1] + dz * up[3 * z + 2] >= COS_DIR * gl * dl ? 1 : 0;
  // 支湾：汇水够、与汇合处往上游的主支夹角够大
  if (t.isMain[u] || area < FJ.ACC_SIDE_KM2) return;
  const mm = main[v];
  const mx = pos[3 * mm] - pos[3 * v];
  const my = pos[3 * mm + 1] - pos[3 * v + 1];
  const mz = pos[3 * mm + 2] - pos[3 * v + 2];
  const ml = Math.hypot(mx, my, mz);
  if (dx * mx + dy * my + dz * mz <= COS_ARM * dl * ml) t.geo.side[u] = FJ.SIDE0 + FJ.SIDE1 * hash01(seed, 3605, c, u % FJ.NPC);
}
const COS_DIR = Math.cos((FJ.DIR_MAX * Math.PI) / 180);
const COS_ARM = Math.cos((FJ.ARM_ANGLE * Math.PI) / 180);

// 每段的中点（Catmull–Rom：(−P0 + 9 P1 + 9 P2 − P3) / 16，P0 是 u 的主支（没有时 u 往外延），P3 是 v 的下游（没有时 v 往外延））
function midpoints(pos: Float64Array, order: Int32Array, recv: Int32Array, main: Int32Array, sph: boolean, N: number): Float64Array {
  const mid = new Float64Array(3 * N);
  for (let q = 0; q < order.length; q++) {
    const u = order[q];
    const v = recv[u];
    if (v < 0) continue;
    const p0 = main[u];
    const p3 = recv[v];
    for (let k = 0; k < 3; k++) {
      const P1 = pos[3 * u + k];
      const P2 = pos[3 * v + k];
      const P0 = p0 >= 0 ? pos[3 * p0 + k] : 2 * P1 - P2;
      const Q3 = p3 >= 0 ? pos[3 * p3 + k] : 2 * P2 - P1;
      mid[3 * u + k] = (-P0 + 9 * P1 + 9 * P2 - Q3) / 16;
    }
    if (sph) {
      const l = Math.hypot(mid[3 * u], mid[3 * u + 1], mid[3 * u + 2]);
      mid[3 * u] /= l;
      mid[3 * u + 1] /= l;
      mid[3 * u + 2] /= l;
    }
  }
  return mid;
}

// 各块拼成一份：点的编号接起来；有表的格是谷网一带往外 RANK_RINGS 圈（两极附近 RANK_RINGS_POLAR 圈），按格编号排表号
function assemble(ctx: Ctx, tiles: TileNet[], prev: FjordNet | null, flips: number[] | null): FjordNet {
  const { mesh, wz } = ctx;
  const n = mesh.n;
  let N = 0;
  let No = 0;
  for (const t of tiles) {
    N += t.n;
    No += t.order.length;
  }
  const net: FjordNet = {
    tiles,
    n: N,
    pos: new Float64Array(3 * N),
    mid: new Float64Array(3 * N),
    owner: new Int32Array(N),
    recv: new Int32Array(N),
    order: new Int32Array(No),
    len: new Float32Array(N),
    lc: new Float32Array(N),
    lsea: new Float32Array(N),
    lcs: new Float32Array(N),
    hw: new Float32Array(N),
    isMain: new Uint8Array(N),
    dirOk: new Uint8Array(N),
    nodeTile: new Int32Array(N),
    nodeLocal: new Int32Array(N),
    cands: new Array<Int32Array | null>(N),
    rank: new Int32Array(0),
    nRank: 0,
    ring: new Int8Array(0),
    watch: new Int32Array(0),
    wz,
    spDist: ctx.spDist,
    kmCell: ctx.kmCell,
    sph: ctx.sph,
    mesh,
  };
  let off = 0;
  let oo = 0;
  for (let ti = 0; ti < tiles.length; ti++) {
    const t = tiles[ti];
    net.pos.set(t.pos, 3 * off);
    net.mid.set(t.mid, 3 * off);
    net.owner.set(t.owner, off);
    net.len.set(t.len, off);
    net.lc.set(t.lc, off);
    net.lsea.set(t.lsea, off);
    net.lcs.set(t.lcs, off);
    net.hw.set(t.hw, off);
    net.isMain.set(t.isMain, off);
    net.dirOk.set(t.dirOk, off);
    oo = copyNodes(net, t, ti, off, oo);
    off += t.n;
  }
  // 有表的格：整个重建时从头数；重画一片时一带一格都没变就照用上一份，不然只在变了的格附近重算圈数（ringsNear）
  if (prev && flips && !flips.length) {
    net.ring = prev.ring;
    net.rank = prev.rank;
    net.nRank = prev.nRank;
  } else {
    let same = false;
    if (prev && flips) {
      net.ring = prev.ring.slice();
      same = ringsNear(mesh, wz, net.ring, flips);
    } else {
      net.ring = new Int8Array(n).fill(-1);
      ringsAll(mesh, wz, net.ring);
    }
    if (same) {
      // 有表的格还是那些（只是圈数变了）：表号照用
      net.rank = prev!.rank;
      net.nRank = prev!.nRank;
    } else {
      net.rank = new Int32Array(n).fill(-1);
      let k = 0;
      for (let i = 0; i < n; i++) if (net.ring[i] >= 0) net.rank[i] = k++;
      net.nRank = k;
    }
  }
  // 陆海只看这些格：谷里的点所在的格与它们两圈以内的格（离海多远看两圈）
  const watchSet = new Uint8Array(n);
  const watch = ownersOf(net, watchSet);
  ringsOut(mesh, watch, 2, watchSet);
  net.watch = Int32Array.from(watch);
  return net;
}

// 一块的点接到整份里（第八十八轮从 assemble 里搬出来的小函数，原样照搬）：下游、在哪一块、块里的编号、碰得到的格；谷里的点。返回 order 写到哪里
function copyNodes(net: FjordNet, t: TileNet, ti: number, off: number, oo: number): number {
  for (let u = 0; u < t.n; u++) {
    net.recv[off + u] = t.recv[u] >= 0 ? t.recv[u] + off : -1;
    net.nodeTile[off + u] = ti;
    net.nodeLocal[off + u] = u;
    net.cands[off + u] = t.cands[u];
  }
  for (let q = 0; q < t.order.length; q++) net.order[oo++] = t.order[q] + off;
  return oo;
}

// 谷里的点所在的格（按先后，不重复；标进 seen）
function ownersOf(net: FjordNet, seen: Uint8Array): number[] {
  const watch: number[] = [];
  for (let q = 0; q < net.order.length; q++) {
    const o = net.owner[net.order[q]];
    if (seen[o]) continue;
    seen[o] = 1;
    watch.push(o);
  }
  return watch;
}

// 每格离谷网一带几圈（ring 先全是 −1）：一带往外 RANK_RINGS 圈，两极附近的格往外推到 RANK_RINGS_POLAR 圈
function ringsAll(mesh: Mesh, wz: Float32Array, ring: Int8Array): void {
  let front: number[] = [];
  for (let i = 0; i < mesh.n; i++) {
    if (!(wz[i] > FJ.ZONE)) continue;
    ring[i] = 0;
    front.push(i);
  }
  for (let r = 1; r <= FJ.RANK_RINGS_POLAR && front.length; r++) {
    const next: number[] = [];
    for (const c of front) {
      if (r > FJ.RANK_RINGS && !polarCell(mesh, c)) continue;
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
        const j = mesh.adj[e];
        if (ring[j] >= 0) continue;
        ring[j] = r;
        next.push(j);
      }
    }
    front = next;
  }
}

// 一带只在 flips 这几格变了：一格离一带几圈只看它 RANK_RINGS_POLAR 圈以内的格，所以只有离 flips 这么多圈以内的格（A）可能变。
// A 里重算：A 里一带的格是 0；A 外挨着 A 的有表的格按原来的圈数往 A 里推（同 ringsAll，按圈数从小到大）。
// 返回有表的格是不是还是那些
function ringsNear(mesh: Mesh, wz: Float32Array, ring: Int8Array, flips: number[]): boolean {
  const inA = new Uint8Array(mesh.n);
  const A = flips.slice();
  for (const c of A) inA[c] = 1;
  ringsOut(mesh, A, FJ.RANK_RINGS_POLAR, inA);
  const R = FJ.RANK_RINGS_POLAR;
  const buckets: number[][] = [];
  for (let r = 0; r <= R; r++) buckets.push([]);
  const had = new Uint8Array(A.length);
  for (let q = 0; q < A.length; q++) {
    const c = A[q];
    had[q] = ring[c] >= 0 ? 1 : 0;
    ring[c] = wz[c] > FJ.ZONE ? 0 : -1;
  }
  const seen = new Uint8Array(mesh.n);
  for (const c of A) {
    if (ring[c] === 0) buckets[0].push(c);
    for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
      const j = mesh.adj[e];
      if (inA[j] || seen[j] || ring[j] < 0) continue;
      seen[j] = 1;
      buckets[ring[j]].push(j);
    }
  }
  for (let r = 0; r < R; r++) {
    const b = buckets[r];
    for (let q = 0; q < b.length; q++) {
      const c = b[q];
      if (r >= FJ.RANK_RINGS && !polarCell(mesh, c)) continue;
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
        const j = mesh.adj[e];
        if (!inA[j] || ring[j] >= 0) continue;
        ring[j] = r + 1;
        buckets[r + 1].push(j);
      }
    }
  }
  for (let q = 0; q < A.length; q++) if ((ring[A[q]] >= 0 ? 1 : 0) !== had[q]) return false;
  return true;
}

// list 里的格往外 rings 圈加进 list（mark 标着已在的）
function ringsOut(mesh: Mesh, list: number[], rings: number, mark: Uint8Array): void {
  let from = 0;
  for (let r = 0; r < rings; r++) {
    const to = list.length;
    for (let q = from; q < to; q++) {
      const c = list[q];
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
        const j = mesh.adj[e];
        if (mark[j]) continue;
        mark[j] = 1;
        list.push(j);
      }
    }
    from = to;
  }
}

function polarCell(mesh: Mesh, c: number): boolean {
  return mesh.kind === 'sphere' && Math.abs(mesh.p[3 * c + 2]) > 0.95;
}

// 一格推两圈后的权重：两圈以内 GROW^圈数 × 峡湾权重的最大（与 growZone 推两遍相同）
function grownAt(mesh: Mesh, fj: Float32Array, i: number): number {
  let m = fj[i];
  for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
    const j = mesh.adj[e];
    // 与推两遍（每遍存成 float32）逐位相同
    const a = Math.fround(FJ.GROW * fj[j]);
    if (a > m) m = a;
    for (let f = mesh.off[j]; f < mesh.off[j + 1]; f++) {
      const b = Math.fround(FJ.GROW * Math.fround(FJ.GROW * fj[mesh.adj[f]]));
      if (b > m) m = b;
    }
  }
  return m;
}

// 峡湾权重往外推 GROW_RINGS 圈，每圈乘 GROW
export function growZone(mesh: Mesh, fj: Float32Array): Float32Array {
  let cur = Float32Array.from(fj);
  for (let r = 0; r < FJ.GROW_RINGS; r++) {
    const next = cur.slice();
    for (let i = 0; i < mesh.n; i++) {
      let m = 0;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (cur[mesh.adj[e]] > m) m = cur[mesh.adj[e]];
      if (FJ.GROW * m > next[i]) next[i] = FJ.GROW * m;
    }
    cur = next;
  }
  return cur;
}






// 线段 u–w 离这几格的格心不到 CENTER_GAP 格
function nearCenter(mesh: Mesh, a: number, b: number, c: number, pos: Float64Array, u: number, w: number, spDist: number): boolean {
  const gap = FJ.CENTER_GAP * spDist;
  const ux = pos[3 * u];
  const uy = pos[3 * u + 1];
  const uz = pos[3 * u + 2];
  const wx = pos[3 * w];
  const wy = pos[3 * w + 1];
  const wz = pos[3 * w + 2];
  cellPos(mesh, a, P3, 0);
  if (segDist(P3[0], P3[1], P3[2], ux, uy, uz, wx, wy, wz) < gap) return true;
  cellPos(mesh, b, P3, 0);
  if (segDist(P3[0], P3[1], P3[2], ux, uy, uz, wx, wy, wz) < gap) return true;
  cellPos(mesh, c, P3, 0);
  return segDist(P3[0], P3[1], P3[2], ux, uy, uz, wx, wy, wz) < gap;
}

// 漫：弹出最低的，没到过的相邻点流向它（键至少比它高一点，平处也有方向）
function flood(heap: MinHeap, link: Int32Array, linkOff: Int32Array, V: Float64Array, key: Float64Array, seen: Uint8Array, recv: Int32Array, popOrder: Int32Array, popped: number): number {
  while (heap.size > 0) {
    const u = heap.pop();
    popOrder[popped++] = u;
    const ku = key[u];
    for (let e = linkOff[u]; e < linkOff[u + 1]; e++) {
      const w = link[e];
      if (seen[w]) continue;
      seen[w] = 1;
      recv[w] = u;
      const kw = V[w] > ku + 1e-3 ? V[w] : ku + 1e-3;
      key[w] = kw;
      heap.push(w, kw);
    }
  }
  return popped;
}

// 沿主谷平滑：有下游、有主支的点挪向两者的中点（一半），几遍；挪了以后连着它的两段离格心太近的不挪
function smoothNet(mesh: Mesh, pos: Float64Array, owner: Int32Array, order: Int32Array, recv: Int32Array, main: Int32Array, sph: boolean, passes: number, spDist: number): void {
  const tmp = new Float64Array(pos.length);
  for (let p = 0; p < passes; p++) {
    tmp.set(pos);
    for (let q = 0; q < order.length; q++) {
      const u = order[q];
      const v = recv[u];
      const m = main[u];
      if (v < 0 || m < 0) continue;
      let x = 0.5 * tmp[3 * u] + 0.25 * (tmp[3 * v] + tmp[3 * m]);
      let y = 0.5 * tmp[3 * u + 1] + 0.25 * (tmp[3 * v + 1] + tmp[3 * m + 1]);
      let z = 0.5 * tmp[3 * u + 2] + 0.25 * (tmp[3 * v + 2] + tmp[3 * m + 2]);
      if (sph) {
        const l = Math.sqrt(x * x + y * y + z * z);
        x /= l;
        y /= l;
        z /= l;
      }
      pos[3 * u] = x;
      pos[3 * u + 1] = y;
      pos[3 * u + 2] = z;
      if (nearCenter(mesh, owner[u], owner[v], owner[m], pos, u, v, spDist) || nearCenter(mesh, owner[u], owner[v], owner[m], pos, u, m, spDist)) {
        pos[3 * u] = tmp[3 * u];
        pos[3 * u + 1] = tmp[3 * u + 1];
        pos[3 * u + 2] = tmp[3 * u + 2];
      }
    }
  }
}
