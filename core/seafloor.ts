// 海底的深度（第八十三轮从 core/elevation.ts 原样搬出）：大陆架、陆坡、陆隆，只重算改动附近
import { type Mesh, graphDistance, HeapLite } from './mesh';
import { gradientNoise3, mixSeed, fbm3, gradientNoise, fbm, smoothstep } from './rng';
import { LAYOUT_R } from './planet-gen';
import { type SeafloorMemoEntry, coastAttrs, oceanSteps } from './seafloor-coast';
import type { World } from './world';
import { seabedFields } from './terrain';
import { bitsOf } from './elevation-solve';

// ---------- 海底（第十二轮） ----------
// 海格的深度不再直接取地壳高度，而是按离岸的距离（只走海格的图距离）给出真实的剖面：
//   大陆架：从岸边几米缓缓变深到陆架坡折（约 −130 m，−85 到 −175），上面只有几十米的起伏；
//     宽度随地方变（约 40–190 km）：陆壳上（被动大陆边缘）宽，洋壳上的岛、挨着高山的海岸（活动边缘）窄到几 km，
//     大陆块大的宽、小岛窄；
//     淹没在水下的陆壳（被动大陆边缘）上，大陆架一直宽到洋壳为止（最多约 360 km）；
//   陆坡：坡折之外 50–90 km 降到约 −3000 m（网格粗时至少一格多宽，不会一格就掉下去）；
//   陆隆：再往外几百 km 慢慢降到洋底的目标深度。
// 洋底的目标深度来自生成器（terrain.ts 的 seabedFields）：随离洋中脊变深（−2600 到 −5500 m）、海沟 −7000 到 −10000 m、
// 海山；陆壳上（淹没的大陆、画出来的海）浅得多。画的海、画的陆地都只按离岸距离与这些场算，所以和自然的海岸一样。
// 陆地一格不动，海陆的分界也不动（只看 causes.land）。结果只取决于陆海、landness、海岸附近的抬升与生成器，
// 与上一次逐字节相同的输入直接用上一次的结果（拖滑块、改气候、只改陆上抬升时不重算）

// 海底的几个噪声（每格一个值）：只取决于网格与种子，按网格缓存
interface SeaNoise {
  // 大陆架宽度的低频变化、坡折深度、架上的起伏；i：岛架宽度沿岸的变化（波长几百 km，岛的四周宽窄不一）
  w: Float32Array;
  b: Float32Array;
  s: Float32Array;
  i: Float32Array;
}
const seaNoiseCache = new WeakMap<Mesh, Map<number, SeaNoise>>();

function seaNoise(mesh: Mesh, seed: number): SeaNoise {
  let bySeed = seaNoiseCache.get(mesh);
  if (!bySeed) seaNoiseCache.set(mesh, (bySeed = new Map()));
  let f = bySeed.get(seed);
  if (f) return f;
  const n = mesh.n;
  f = { w: new Float32Array(n), b: new Float32Array(n), s: new Float32Array(n), i: new Float32Array(n) };
  if (mesh.kind === 'sphere') {
    const nw = gradientNoise3(mixSeed(seed, 121));
    const nb = gradientNoise3(mixSeed(seed, 122));
    const ns = gradientNoise3(mixSeed(seed, 123));
    const ni = gradientNoise3(mixSeed(seed, 124));
    for (let i = 0; i < n; i++) {
      const px = mesh.p[3 * i] * LAYOUT_R;
      const py = mesh.p[3 * i + 1] * LAYOUT_R;
      const pz = mesh.p[3 * i + 2] * LAYOUT_R;
      f.w[i] = fbm3(nw, px, py, pz, 3, 3);
      f.b[i] = fbm3(nb, px, py, pz, 6, 2);
      f.s[i] = fbm3(ns, px, py, pz, 40, 3);
      f.i[i] = fbm3(ni, px, py, pz, 16, 3);
    }
  } else {
    const nw = gradientNoise(mixSeed(seed, 121));
    const nb = gradientNoise(mixSeed(seed, 122));
    const ns = gradientNoise(mixSeed(seed, 123));
    const ni = gradientNoise(mixSeed(seed, 124));
    for (let i = 0; i < n; i++) {
      const x = mesh.x[i];
      const y = mesh.y[i];
      f.w[i] = fbm(nw, x, y, 3, 3);
      f.b[i] = fbm(nb, x, y, 6, 2);
      f.s[i] = fbm(ns, x, y, 40, 3);
      f.i[i] = fbm(ni, x, y, 16, 3);
    }
  }
  if (bySeed.size >= 2) bySeed.delete(bySeed.keys().next().value!);
  bySeed.set(seed, f);
  return f;
}
const seafloorMemo = new WeakMap<Mesh, SeafloorMemoEntry[]>();
// 测试用：on = false 时不读也不写缓存；reused：直接用上一次的结果，partial：只重算改动附近，computed：整个重算
export const seafloorStats = { on: true, reused: 0, partial: 0, computed: 0, coast: 0 };

// 生成器的两个场按内容比（重新打开的世界是另一份数组，内容相同）
function sameFields(a: { ocean: Float32Array; shelf: Float32Array } | null, b: { ocean: Float32Array; shelf: Float32Array } | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return sameArray(a.ocean, b.ocean) && sameArray(a.shelf, b.shelf);
}

function sameArray(a: Float32Array | Uint8Array | Int32Array, b: Float32Array | Uint8Array | Int32Array): boolean {
  if (a.length !== b.length) return false;
  // 按位比（NaN、−0 都按位算）：四字节一组
  if (a instanceof Float32Array) {
    const x = new Uint32Array(a.buffer, a.byteOffset, a.length);
    const y = new Uint32Array(b.buffer, b.byteOffset, b.length);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// 海底剖面的参数（km、m）
const SHELF_KM = 85;
const SHELF_MIN_KM = 4;
const SHELF_MAX_KM = 360;
const BREAK_M = 130;
const RISE_KM = 800;
const SMOOTH_PASSES = 3;

// 海格的高程写进 elevation（陆格不动）。
// 一格的结果只取决于离它不远的地方：离岸距离只走到 limit（再远就是洋底的目标深度），宽度、活动程度再平滑三圈。
// 所以改了一小片海陆时，只重算离改动 limit 加几格以内的格（其余照用上一次的结果），与整个重算逐位相同：
// 离岸距离按 Dijkstra（边长都为正时解唯一），最近的岸边格在距离相同时取编号小的（与弹出的先后无关）
export function seafloor(world: World, elevation: Float32Array) {
  const { mesh, causes, kmPerUnit } = world;
  const n = mesh.n;
  const land = causes.land;
  const { off, adj } = mesh;
  const seed = world.settings.seed;
  const fields = seabedFields(world);

  // 与上一次（或上上次）的输入逐字节相同：直接用那一次的结果。抬升变了的时候先看海岸上的抬升变没变。
  // 生成器的场按内容比：重新打开的世界另有一份（内容相同），比上了就换成这一份，下次直接按对象比
  const entries = seafloorStats.on
    ? (seafloorMemo.get(mesh) ?? []).filter((e) => {
        if (e.seed !== seed || e.kmPerUnit !== kmPerUnit) return false;
        if (e.fields === fields) return true;
        if (!sameFields(e.fields, fields)) return false;
        e.fields = fields;
        return true;
      })
    : [];
  const same = entries.filter((e) => sameArray(e.land, land) && sameArray(e.landness, causes.landness) && sameArray(e.landDelta, causes.landDelta));
  const reuse = (e: SeafloorMemoEntry) => {
    seafloorStats.reused++;
    // 照用的那一次放到最前：下一次改动多半从它改起（撤销后再画），只重算改动附近时以它为准
    const list = seafloorMemo.get(mesh)!;
    if (list[0] !== e) seafloorMemo.set(mesh, [e, ...list.filter((x) => x !== e)]);
    for (let i = 0; i < n; i++) if (!land[i]) elevation[i] = e.z[i];
  };
  const hit = same.find((e) => sameArray(e.uplift, causes.uplift));
  if (hit) return reuse(hit);
  // 只有陆上的抬升变了（海陆、陆块都不变）：岸边海格的属性只取决于挨着海的陆格的抬升，
  // 那些陆格的抬升（按位）都没变就照用（与下面按 up、size 比的结果相同，只是不必扫整个海岸、数陆块）
  if (same.length) {
    const ub = new Uint32Array(causes.uplift.buffer, causes.uplift.byteOffset, n);
    for (const e of same) {
      const eb = new Uint32Array(e.uplift.buffer, e.uplift.byteOffset, n);
      let ok = true;
      for (let i = 0; i < n && ok; i++) {
        if (ub[i] === eb[i] || !land[i]) continue;
        for (let q = off[i], end = off[i + 1]; q < end; q++) {
          if (!land[adj[q]]) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        e.uplift = causes.uplift.slice();
        return reuse(e);
      }
    }
  }

  // 岸边的海格（挨着陆地）与它们的属性：挨着的陆地的抬升（高山海岸 = 活动边缘）、陆块的大小。
  // 有上一次（同样的生成器场）的结果时只重算改动附近（见 coastAttrs），结果与整个重算逐位相同
  const base = entries[0];
  const { up, size, lsize, flips } = coastAttrs(world, base);
  const hit2 = same.find((e) => sameArray(e.up, up) && sameArray(e.size, size));
  if (hit2) {
    // 只是陆上的抬升变了：结果照旧，记下这次的抬升
    hit2.uplift = causes.uplift.slice();
    return reuse(hit2);
  }

  const cellKm = mesh.spacing * kmPerUnit;
  const md = mesh.dist;
  // 离岸再远（大陆架最宽 + 陆坡 + 陆隆），剖面已经到了洋底的目标深度：只走到这么远
  const riseKm = Math.max(RISE_KM, 2.5 * cellKm);
  const limit = (SHELF_MAX_KM + Math.max(110, 1.2 * cellKm) + riseKm + cellKm) / kmPerUnit;

  // 每个海格离洋壳多远（只走海格，按格数；陆壳上的海一直宽到洋壳为止，最多 SHELF_MAX_KM）：
  // 宽的大陆架就是淹在水下的陆壳，陆架坡折在陆壳的边上
  const toOcean = oceanSteps(world, fields, Math.ceil(SHELF_MAX_KM / cellKm), base, flips);

  // 陆海与上一次相同（只有岸边的属性、landness 变了，比如海岸上堆山）：离岸距离与最近的岸边格照用，
  // 只重算属性变了的岸边格管着的格（再往外三圈平滑）与 landness 变了的海格（第三十五轮提速）
  if (base && flips && !flips.length && seafloorSameLand.on) {
    const r = sameLandSeafloor(world, fields, base, up, size, toOcean, cellKm, riseKm);
    for (let i = 0; i < n; i++) if (!land[i]) elevation[i] = r.z[i];
    seafloorStats.coast++;
    if (seafloorStats.on) {
      const entry: SeafloorMemoEntry = {
        seed,
        kmPerUnit,
        fields,
        lsize,
        land: land.slice(),
        landness: causes.landness.slice(),
        landDelta: causes.landDelta.slice(),
        uplift: causes.uplift.slice(),
        up,
        size,
        toOcean,
        dist: base.dist,
        owner: base.owner,
        W: r.W,
        A: r.A,
        z: r.z,
      };
      seafloorMemo.set(mesh, [entry, ...(seafloorMemo.get(mesh) ?? [])].slice(0, 2));
    }
    return;
  }

  // 只重算改动附近：从上一次（同样的生成器场）的结果改起。改动 = 陆海变了的格、landness 变了的海格、
  // 属性（抬升、陆块大小、离洋壳）变了的海格；要重算的是离它们 limit 加十格以内的格（平滑三圈也够，只会多算，不会少算）
  let region: Uint8Array | null = null;
  let rlist: Int32Array | null = null;
  // 第三十五轮（提速）：逐格的几段放进小函数（原样照搬，结果逐值相同）；“第 k 个要重算的格”以前是两种闭包，现在是一张格表
  if (base) {
    const seedBuf = new Int32Array(n);
    const ns = changedSeas(n, land, causes.landness, causes.landDelta, up, size, toOcean, base, seedBuf);
    if (ns * 16 < n) {
      const reach = graphDistance(mesh, seedBuf.subarray(0, ns), limit + 10 * mesh.spacing);
      region = new Uint8Array(n);
      const count = reached(n, reach, region);
      // 改动太大（要重算的格超过一半）：整个重算更快
      if (count * 2 > n) region = null;
      else {
        rlist = new Int32Array(count);
        for (let i = 0, k = 0; i < n; i++) if (region[i]) rlist[k++] = i;
      }
    }
  }
  // 要重算的格（按编号从小到大）：只重算改动附近时是重算区里的格，否则是所有格
  const todo = rlist ? rlist.length : n;
  const list = rlist ?? allCells(n);
  // 岸边的海格（挨着陆地）：Dijkstra 的起点
  const srcBuf = new Int32Array(todo);
  const sources = srcBuf.subarray(0, shoreSeas(list, todo, off, adj, land, srcBuf));
  const prev = region ? base : undefined;

  // 只走海格的图距离与最近的岸边格（Dijkstra，走到 limit 为止；距离相同时取编号小的岸边格）
  const dist = prev ? prev.dist.slice() : new Float64Array(n).fill(Infinity);
  const owner = prev ? prev.owner.slice() : new Int32Array(n).fill(-1);
  {
    const heap = new HeapLite(Math.max(1024, sources.length * 2));
    if (region && rlist) {
      for (let k = 0; k < rlist.length; k++) {
        const i = rlist[k];
        dist[i] = Infinity;
        owner[i] = -1;
      }
      // 重算区外紧挨着它的海格：照用上一次的距离（它们离改动都超过 limit，不会变）；按编号入堆
      const rim: number[] = [];
      const seen = new Uint8Array(n);
      for (let k = 0; k < rlist.length; k++) {
        const r = rlist[k];
        for (let e = off[r], end = off[r + 1]; e < end; e++) {
          const i = adj[e];
          if (region[i] || seen[i] || land[i] || owner[i] < 0) continue;
          seen[i] = 1;
          rim.push(i);
        }
      }
      rim.sort((a, b) => a - b);
      for (const i of rim) heap.push(i, dist[i]);
    }
    for (let k = 0; k < sources.length; k++) {
      const s = sources[k];
      dist[s] = 0;
      owner[s] = s;
      heap.push(s, 0);
    }
    if (region) seaDijkstraIn(off, adj, md, land, region, limit, dist, owner, heap);
    else seaDijkstra(off, adj, md, land, limit, dist, owner, heap);
  }

  const noise = seaNoise(mesh, seed);
  const ctx: SeaCtx = { up, size, toOcean, fields, noise, cellKm, kmPerUnit, riseKm, landness: causes.landness, landDelta: causes.landDelta };
  // 每个海格的大陆架宽度 W、活动程度 A：先按最近的岸边格取，再在海上平滑几遍（岸边格换了的地方不留台阶）
  const Ws: Float32Array[] = [];
  const As: Float32Array[] = [];
  const W0 = prev ? prev.W[0].slice() : new Float32Array(n);
  const A0 = prev ? prev.A[0].slice() : new Float32Array(n);
  const cells = new Int32Array(todo);
  const nc = shelfStart(ctx, list, todo, owner, W0, A0, cells);
  Ws.push(W0);
  As.push(A0);
  // 坡折深度只取决于这一格的噪声，本来就是平滑的；宽度与活动程度按岸边格取，要平滑
  for (let pass = 1; pass <= SMOOTH_PASSES; pass++) {
    const Wp = Ws[pass - 1];
    const Ap = As[pass - 1];
    const W2 = prev ? prev.W[pass].slice() : new Float32Array(n);
    const A2 = prev ? prev.A[pass].slice() : new Float32Array(n);
    if (rlist) {
      // 重算区里没走到的格：清零（与整个重算时相同）
      for (let k = 0; k < rlist.length; k++) {
        const i = rlist[k];
        if (owner[i] < 0) {
          W2[i] = 0;
          A2[i] = 0;
        }
      }
    }
    smoothShelf(off, adj, owner, cells, nc, Wp, Ap, W2, A2);
    Ws.push(W2);
    As.push(A2);
  }
  const W = Ws[SMOOTH_PASSES];
  const A = As[SMOOTH_PASSES];

  const z = prev ? prev.z.slice() : new Float32Array(n);
  depthsOf(ctx, list, todo, land, owner, dist, W, A, z);
  for (let i = 0; i < n; i++) if (!land[i]) elevation[i] = z[i];
  if (region) seafloorStats.partial++;
  else seafloorStats.computed++;
  if (seafloorStats.on) {
    const entry: SeafloorMemoEntry = {
      seed,
      kmPerUnit,
      fields,
      lsize,
      land: land.slice(),
      landness: causes.landness.slice(),
      landDelta: causes.landDelta.slice(),
      uplift: causes.uplift.slice(),
      up,
      size,
      toOcean,
      dist,
      owner,
      W: Ws,
      A: As,
      z,
    };
    seafloorMemo.set(mesh, [entry, ...(seafloorMemo.get(mesh) ?? [])].slice(0, 2));
  }
}

// 海底剖面逐格要读的东西（第三十五轮提速：逐格的几段放进小函数，两条路共用）
interface SeaCtx {
  up: Float32Array;
  size: Float32Array;
  toOcean: Int32Array;
  fields: ReturnType<typeof seabedFields>;
  noise: SeaNoise;
  cellKm: number;
  kmPerUnit: number;
  riseKm: number;
  landness: Float32Array;
  landDelta: Float32Array;
}

// 海格 i（最近的岸边格 o）平滑之前的大陆架宽度 W 与活动程度 A
function shelfAt(c: SeaCtx, i: number, o: number, W0: Float32Array, A0: Float32Array) {
  const { noise, fields } = c;
  const act = smoothstep(0.35, 1, c.up[o]);
  const wBase = SHELF_KM * Math.exp(0.8 * noise.w[i]);
  // 岛架：按陆块大小（洋壳上的小岛只有几 km），沿岸宽窄不一（×0.5–×1.6，按这一格的位置，小岛的岛架不是一个圆）；
  // 陆架：一直到洋壳（至少有一半的 wBase）
  const wIsland = (SHELF_MIN_KM + (wBase - SHELF_MIN_KM) * 0.85 * c.size[o]) * Math.min(1.6, Math.max(0.5, Math.exp(2.2 * noise.i[i])));
  let wCont = 0;
  if (fields && fields.shelf[o] > 0) {
    const t = c.toOcean[o];
    const toCrust = t < 0 ? SHELF_MAX_KM : t * c.cellKm;
    wCont = fields.shelf[o] * Math.min(SHELF_MAX_KM, Math.max(0.5 * wBase, toCrust * (0.85 + 0.15 * noise.w[i])));
  }
  W0[i] = Math.max(SHELF_MIN_KM, Math.max(wIsland, wCont) * (1 - 0.75 * act));
  A0[i] = act;
}

// 平滑一遍（cells[0, count) 里的格，读 Wp、Ap，写 W2、A2）
function smoothShelf(off: Int32Array, adj: Int32Array, owner: Int32Array, cells: Int32Array, count: number, Wp: Float32Array, Ap: Float32Array, W2: Float32Array, A2: Float32Array) {
  for (let k = 0; k < count; k++) {
    const i = cells[k];
    let sw = 0;
    let sa = 0;
    let m = 0;
    for (let e = off[i], end = off[i + 1]; e < end; e++) {
      const j = adj[e];
      if (owner[j] < 0) continue;
      sw += Wp[j];
      sa += Ap[j];
      m++;
    }
    W2[i] = m ? 0.5 * Wp[i] + (0.5 * sw) / m : Wp[i];
    A2[i] = m ? 0.5 * Ap[i] + (0.5 * sa) / m : Ap[i];
  }
}

// 海格 i 的深度（m）
function seaDepth(c: SeaCtx, i: number, owner: Int32Array, dist: Float64Array, W: Float32Array, A: Float32Array): number {
  const { noise, fields, cellKm, riseKm } = c;
  // 洋底的目标深度：陆壳上（淹没的大陆）按地壳本身的高度，画成海的陆地是一个海盆；洋壳上取生成器的洋底
  const shelfW = fields ? smoothstep(0.3, 0.7, fields.shelf[i]) : 0;
  const ocean = fields ? fields.ocean[i] : -4800 + 260 * noise.b[i];
  const crust = c.landness[i] - c.landDelta[i];
  // 淹没的陆壳离岸远了（大陆架以外）：陆缘台地，约 −400 到 −1600 m（像西兰洲、罗科尔海台）；
  // 画成海的陆地（原来在海面以上）：约 −1100 m 的海盆
  const tCont = -(400 + 1300 * (1 - Math.exp(Math.min(0, crust) / 600))) - 700 * smoothstep(-150, 150, crust) - 150 * noise.w[i];
  const T = shelfW * tCont + (1 - shelfW) * ocean;
  let h: number;
  if (owner[i] < 0) h = T;
  else {
    const dk = dist[i] * c.kmPerUnit + 0.5 * cellKm;
    const w = W[i];
    // 陆架坡折的深度（负数）
    const b = -(BREAK_M + 45 * noise.b[i]);
    // 架上的起伏：岸边几乎没有，往外到几十米
    const N = 22 * noise.s[i];
    if (dk <= w) {
      const u = dk / w;
      h = -(2 + (-b - 2) * Math.pow(u, 0.85)) + N * u;
    } else {
      const x = dk - w;
      const S = Math.max((90 - 40 * A[i]) * (0.85 + 0.3 * (0.5 + 0.5 * noise.b[i])), 1.2 * cellKm);
      // 陆坡（S 以内降到六成）+ 陆隆（riseKm 以内慢慢降完）
      const G = 0.6 * smoothstep(0, S, x) + 0.4 * smoothstep(0, riseKm, x);
      h = b + (T - b) * G + N * (1 - G);
    }
  }
  return Math.max(-11000, Math.min(-1, h));
}

// 第三十五轮（提速）：seafloor 里几段逐格的循环（原样照搬）。
// 与 base 比陆海变了的格、属性或 landness 变了的海格（按编号，写进 out），返回个数
function changedSeas(n: number, land: Uint8Array, landness: Float32Array, landDelta: Float32Array, up: Float32Array, size: Float32Array, toOcean: Int32Array, base: SeafloorMemoEntry, out: Int32Array): number {
  const bLand = base.land;
  const bLandness = base.landness;
  const bLandDelta = base.landDelta;
  const bUp = base.up;
  const bSize = base.size;
  const bTo = base.toOcean;
  let m = 0;
  for (let i = 0; i < n; i++) {
    if (land[i] !== bLand[i]) out[m++] = i;
    else if (!land[i]) {
      if (landness[i] !== bLandness[i] || landDelta[i] !== bLandDelta[i] || up[i] !== bUp[i] || size[i] !== bSize[i] || toOcean[i] !== bTo[i]) out[m++] = i;
    }
  }
  return m;
}

// 走得到的格标进 region，返回个数
function reached(n: number, reach: Float64Array, region: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (reach[i] < Infinity) {
      region[i] = 1;
      count++;
    }
  }
  return count;
}

// 0, 1, …, n − 1
function allCells(n: number): Int32Array {
  const a = new Int32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  return a;
}

// list 的前 todo 格里挨着陆地的海格（写进 out），返回个数
function shoreSeas(list: Int32Array, todo: number, off: Int32Array, adj: Int32Array, land: Uint8Array, out: Int32Array): number {
  let m = 0;
  for (let k = 0; k < todo; k++) {
    const i = list[k];
    if (land[i]) continue;
    for (let e = off[i], end = off[i + 1]; e < end; e++) {
      if (land[adj[e]]) {
        out[m++] = i;
        break;
      }
    }
  }
  return m;
}

// 只走海格的 Dijkstra（走到 limit 为止；距离相同时取编号小的岸边格）
function seaDijkstra(off: Int32Array, adj: Int32Array, md: Float64Array, land: Uint8Array, limit: number, dist: Float64Array, owner: Int32Array, heap: HeapLite) {
  while (heap.size) {
    const i = heap.pop();
    const di = heap.lastKey;
    if (di > dist[i]) continue;
    const oi = owner[i];
    for (let e = off[i], end = off[i + 1]; e < end; e++) {
      const j = adj[e];
      if (land[j]) continue;
      const nd = di + md[e];
      if (nd > limit) continue;
      if (nd < dist[j]) {
        dist[j] = nd;
        owner[j] = oi;
        heap.push(j, nd);
      } else if (nd === dist[j] && oi < owner[j]) owner[j] = oi;
    }
  }
}

// 同上，只在重算区里走
function seaDijkstraIn(off: Int32Array, adj: Int32Array, md: Float64Array, land: Uint8Array, region: Uint8Array, limit: number, dist: Float64Array, owner: Int32Array, heap: HeapLite) {
  while (heap.size) {
    const i = heap.pop();
    const di = heap.lastKey;
    if (di > dist[i]) continue;
    const oi = owner[i];
    for (let e = off[i], end = off[i + 1]; e < end; e++) {
      const j = adj[e];
      if (land[j] || !region[j]) continue;
      const nd = di + md[e];
      if (nd > limit) continue;
      if (nd < dist[j]) {
        dist[j] = nd;
        owner[j] = oi;
        heap.push(j, nd);
      } else if (nd === dist[j] && oi < owner[j]) owner[j] = oi;
    }
  }
}

// 平滑之前的 W、A（list 的前 todo 格；没走到的格为 0），有岸边格的格写进 cells，返回个数
function shelfStart(ctx: SeaCtx, list: Int32Array, todo: number, owner: Int32Array, W0: Float32Array, A0: Float32Array, cells: Int32Array): number {
  let nc = 0;
  for (let k = 0; k < todo; k++) {
    const i = list[k];
    const o = owner[i];
    if (o < 0) {
      W0[i] = 0;
      A0[i] = 0;
      continue;
    }
    cells[nc++] = i;
    shelfAt(ctx, i, o, W0, A0);
  }
  return nc;
}

// 深度（list 的前 todo 格；陆格为 0）
function depthsOf(ctx: SeaCtx, list: Int32Array, todo: number, land: Uint8Array, owner: Int32Array, dist: Float64Array, W: Float32Array, A: Float32Array, z: Float32Array) {
  for (let k = 0; k < todo; k++) {
    const i = list[k];
    z[i] = land[i] ? 0 : seaDepth(ctx, i, owner, dist, W, A);
  }
}

// 测试用：false 时陆海不变也走原来的路（只重算改动附近）
export const seafloorSameLand = { on: true };

// 陆海与 base 相同（第三十五轮提速）：离岸距离、最近的岸边格只取决于陆海，照用 base 的。
// 平滑之前的 W、A 只取决于最近的岸边格的属性（up、size、toOcean）与这一格的噪声：只重算属性变了的岸边格管着的格；
// 第 p 遍平滑只重算第 p − 1 遍重算过的格与它们挨着的格（都只在有岸边格的格里）；深度只重算 W、A 重算过的格与 landness 变了的海格。
// 别的格的输入与 base 逐位相同，照抄 base 的结果，与整个重算逐位相同（seabed 测试的“海岸上堆山”、rewrite-identity）
function sameLandSeafloor(world: World, fields: ReturnType<typeof seabedFields>, base: SeafloorMemoEntry, up: Float32Array, size: Float32Array, toOcean: Int32Array, cellKm: number, riseKm: number): { W: Float32Array[]; A: Float32Array[]; z: Float32Array } {
  const { mesh, causes, kmPerUnit } = world;
  const n = mesh.n;
  const { off, adj } = mesh;
  const land = causes.land;
  const owner = base.owner;
  const dist = base.dist;
  const ctx: SeaCtx = { up, size, toOcean, fields, noise: seaNoise(mesh, world.settings.seed), cellKm, kmPerUnit, riseKm, landness: causes.landness, landDelta: causes.landDelta };
  // 属性变了的岸边格
  const bad = new Uint8Array(n);
  let anyBad = false;
  for (let i = 0; i < n; i++) {
    if (up[i] !== base.up[i] || size[i] !== base.size[i] || toOcean[i] !== base.toOcean[i]) {
      bad[i] = 1;
      anyBad = true;
    }
  }
  const mark = new Uint8Array(n);
  let cells = new Int32Array(0);
  let count = 0;
  const W: Float32Array[] = [base.W[0]];
  const A: Float32Array[] = [base.A[0]];
  if (anyBad) {
    cells = new Int32Array(n);
    count = ownedBy(owner, bad, n, mark, cells);
    const W0 = base.W[0].slice();
    const A0 = base.A[0].slice();
    for (let k = 0; k < count; k++) shelfAt(ctx, cells[k], owner[cells[k]], W0, A0);
    W[0] = W0;
    A[0] = A0;
  }
  for (let pass = 1; pass <= SMOOTH_PASSES; pass++) {
    if (!count) {
      W.push(base.W[pass]);
      A.push(base.A[pass]);
      continue;
    }
    count = growOwned(off, adj, owner, mark, cells, count);
    const W2 = base.W[pass].slice();
    const A2 = base.A[pass].slice();
    smoothShelf(off, adj, owner, cells, count, W[pass - 1], A[pass - 1], W2, A2);
    W.push(W2);
    A.push(A2);
  }
  // 深度：W、A 重算过的格，加上 landness、landDelta（按位）变了的海格
  const z = base.z.slice();
  const Wf = W[SMOOTH_PASSES];
  const Af = A[SMOOTH_PASSES];
  for (let k = 0; k < count; k++) {
    const i = cells[k];
    z[i] = seaDepth(ctx, i, owner, dist, Wf, Af);
  }
  const lb = bitsOf(causes.landness);
  const db = bitsOf(causes.landDelta);
  const blb = bitsOf(base.landness);
  const bdb = bitsOf(base.landDelta);
  for (let i = 0; i < n; i++) {
    if (land[i] || mark[i]) continue;
    if (lb[i] !== blb[i] || db[i] !== bdb[i]) z[i] = seaDepth(ctx, i, owner, dist, Wf, Af);
  }
  return { W, A, z };
}

// 最近的岸边格属性变了的格（按编号），标进 mark，写进 cells，返回个数
function ownedBy(owner: Int32Array, bad: Uint8Array, n: number, mark: Uint8Array, cells: Int32Array): number {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const o = owner[i];
    if (o >= 0 && bad[o]) {
      mark[i] = 1;
      cells[m++] = i;
    }
  }
  return m;
}

// 再加上挨着的、有岸边格的格（标进 mark，接在 cells 后面），返回新的个数
function growOwned(off: Int32Array, adj: Int32Array, owner: Int32Array, mark: Uint8Array, cells: Int32Array, count: number): number {
  let m = count;
  for (let k = 0; k < count; k++) {
    const i = cells[k];
    for (let e = off[i], end = off[i + 1]; e < end; e++) {
      const j = adj[e];
      if (mark[j] || owner[j] < 0) continue;
      mark[j] = 1;
      cells[m++] = j;
    }
  }
  return m;
}
