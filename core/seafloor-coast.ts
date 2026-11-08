// 海底要用的岸边属性（第八十三轮从 core/elevation.ts 原样搬出）：陆块大小、岸边海格的抬升、离岸的步数、潟湖底
import { seabedFields, lagoonTest } from './terrain';
import type { World } from './world';
import { smoothstep } from './rng';

export interface SeafloorMemoEntry {
  seed: number;
  kmPerUnit: number;
  fields: ReturnType<typeof seabedFields>;
  land: Uint8Array;
  landness: Float32Array;
  landDelta: Float32Array;
  uplift: Float32Array;
  // 每个陆格所在陆块的大小系数（海格为 0）：改了一小片海陆时只重新数挨着改动的陆块
  lsize: Float32Array;
  // 每个岸边海格挨着的陆地的抬升（最大）与陆块大小系数；不是岸边的格为 0。toOcean：每个海格离洋壳的格数
  up: Float32Array;
  size: Float32Array;
  toOcean: Int32Array;
  // 离岸距离与最近的岸边格；W、A 每一遍平滑的结果（[0] 是平滑之前的）；结果
  dist: Float64Array;
  owner: Int32Array;
  W: Float32Array[];
  A: Float32Array[];
  z: Float32Array;
}

// 环礁的潟湖（第十三轮；第十四轮起按岛的种类认：记着环礁形状的种类的海格，见 terrain.ts 的 lagoonTest）
// 是潟湖或环上的缺口，海底是浅浅的珊瑚砂：挨着陆地的约 −15 m，往里每格深 12 m，最深 −50 m（按格号带一点起伏）。
// 在海底的剖面（seafloor）之后改，不进它的缓存
export function lagoonFloor(world: World, elevation: Float32Array) {
  const { mesh, causes } = world;
  const { off, adj } = mesh;
  const n = mesh.n;
  const land = causes.land;
  const isLagoon = lagoonTest(world);
  let step: Int32Array | null = null;
  const queue: number[] = [];
  for (let i = 0; i < n; i++) {
    if (land[i] || !isLagoon(i)) continue;
    step ??= new Int32Array(n).fill(-1);
    for (let e = off[i]; e < off[i + 1]; e++) {
      if (land[adj[e]]) {
        step[i] = 0;
        queue.push(i);
        break;
      }
    }
  }
  if (!step) return;
  for (let h = 0; h < queue.length; h++) {
    const i = queue[h];
    for (let e = off[i]; e < off[i + 1]; e++) {
      const j = adj[e];
      if (land[j] || step[j] >= 0 || !isLagoon(j)) continue;
      step[j] = step[i] + 1;
      queue.push(j);
    }
  }
  for (let i = 0; i < n; i++) {
    if (land[i] || !isLagoon(i)) continue;
    // 和陆地不连着的（只有潟湖本身、很少见）按最深算
    const k = step[i] < 0 ? 3 : step[i];
    const jitter = ((Math.imul(i + 1, 0x9e3779b1) >>> 0) / 4294967296 - 0.5) * 6;
    elevation[i] = -Math.min(50, 15 + 12 * k + jitter);
  }
}

// 陆块的大小系数：“边长”（面积的平方根）150 km 以下算小岛，1200 km 以上算大陆
const landSize = (area: number) => smoothstep(150, 1200, Math.sqrt(area));

// 岸边海格的属性：up = 挨着的陆格的抬升（最大，没有为 0）、size = 挨着的陆格所在陆块的大小系数（最大）；
// lsize = 每个陆格所在陆块的大小系数（海格为 0）；flips = 与 base 比陆海变了的格（没有 base 时为 null）。
// 有 base 时只重算改动附近，与整个重算逐位相同：
//   陆块：只有含陆海变了的格、或挨着它的陆块会变（别的陆块与上一次是同一组格，面积也就相同）；
//     重新数时与 landComponents 一样从块里编号最小的格起按同样的顺序加面积，面积逐位相同（块的编号不影响结果）；
//   一个海格的 up、size 只取决于挨着的格的陆海、抬升、陆块大小系数：只重算挨着这些变了的格的海格
export function coastAttrs(world: World, base: SeafloorMemoEntry | undefined): { up: Float32Array; size: Float32Array; lsize: Float32Array; flips: number[] | null } {
  const { mesh, causes, kmPerUnit } = world;
  const n = mesh.n;
  const land = causes.land;
  const uplift = causes.uplift;
  const { off, adj } = mesh;
  if (!base) {
    const up = new Float32Array(n);
    const size = new Float32Array(n);
    const lsize = new Float32Array(n);
    const [comp, area] = landComponents(world);
    const compSize = Float32Array.from(area, landSize);
    for (let i = 0; i < n; i++) {
      if (land[i]) {
        lsize[i] = compSize[comp[i]];
        continue;
      }
      for (let e = off[i], end = off[i + 1]; e < end; e++) {
        const j = adj[e];
        if (!land[j]) continue;
        if (uplift[j] > up[i]) up[i] = uplift[j];
        const sz = compSize[comp[j]];
        if (sz > size[i]) size[i] = sz;
      }
    }
    return { up, size, lsize, flips: null };
  }
  // 变了的格：陆海变了的、抬升（按位）变了的陆格，再加陆块大小系数变了的陆格
  const flips: number[] = [];
  const dirty: number[] = [];
  const ub = new Uint32Array(uplift.buffer, uplift.byteOffset, n);
  const eb = new Uint32Array(base.uplift.buffer, base.uplift.byteOffset, n);
  const bl = base.land;
  for (let i = 0; i < n; i++) {
    if (land[i] !== bl[i]) {
      flips.push(i);
      dirty.push(i);
    } else if (land[i] && ub[i] !== eb[i]) dirty.push(i);
  }
  const lsize = base.lsize.slice();
  if (flips.length) {
    const k2 = kmPerUnit * kmPerUnit;
    const done = new Uint8Array(n);
    const again = new Uint8Array(n);
    const queue = new Int32Array(n);
    // 从 s 起按 landComponents 的顺序走一个陆块：格在 queue[0, len) 里，返回 len 与面积
    let a = 0;
    const flood = (s: number, mark: Uint8Array): number => {
      let len = 0;
      a = 0;
      queue[len++] = s;
      mark[s] = 1;
      for (let q = 0; q < len; q++) {
        const c = queue[q];
        a += mesh.area[c] * k2;
        for (let e = off[c], end = off[c + 1]; e < end; e++) {
          const j = adj[e];
          if (land[j] && !mark[j]) {
            mark[j] = 1;
            queue[len++] = j;
          }
        }
      }
      return len;
    };
    const recount = (s: number) => {
      if (!land[s] || done[s]) return;
      let len = flood(s, done);
      let first = s;
      for (let k = 0; k < len; k++) if (queue[k] < first) first = queue[k];
      if (first !== s) len = flood(first, again);
      const v = Math.fround(landSize(a));
      for (let k = 0; k < len; k++) {
        const c = queue[k];
        if (lsize[c] !== v) {
          lsize[c] = v;
          dirty.push(c);
        }
      }
    };
    for (const i of flips) {
      if (!land[i]) lsize[i] = 0;
      recount(i);
      for (let e = off[i], end = off[i + 1]; e < end; e++) recount(adj[e]);
    }
  }
  const up = base.up.slice();
  const size = base.size.slice();
  const mark = new Uint8Array(n);
  const redo = (i: number) => {
    if (mark[i]) return;
    mark[i] = 1;
    up[i] = 0;
    size[i] = 0;
    if (land[i]) return;
    for (let e = off[i], end = off[i + 1]; e < end; e++) {
      const j = adj[e];
      if (!land[j]) continue;
      if (uplift[j] > up[i]) up[i] = uplift[j];
      const sz = lsize[j];
      if (sz > size[i]) size[i] = sz;
    }
  };
  for (const c of dirty) {
    redo(c);
    for (let e = off[c], end = off[c + 1]; e < end; e++) redo(adj[e]);
  }
  return { up, size, lsize, flips };
}

// 每个海格离洋壳多远（只走海格的格数，最多 steps；再远、陆格为 −1）。
// 有 base（同样的生成器场）时只重算离陆海变了的格 steps 格以内的格：再远的格，最短的路（不超过 steps 格）上没有变了的格，
// 与上一次相同。重算区里的格从洋壳格（0）与区外紧挨着的格（上一次的格数 + 1）起按层走，最短格数唯一，与整个重算逐位相同
export function oceanSteps(world: World, fields: ReturnType<typeof seabedFields>, steps: number, base: SeafloorMemoEntry | undefined, flips: number[] | null): Int32Array {
  const { mesh, causes } = world;
  const n = mesh.n;
  const land = causes.land;
  const { off, adj } = mesh;
  if (!fields) return new Int32Array(n).fill(-1);
  if (base && flips) {
    if (!flips.length) return base.toOcean.slice();
    const near = new Uint8Array(n);
    const list: number[] = [];
    for (const f of flips) {
      near[f] = 1;
      list.push(f);
    }
    for (let s = 0, head = 0; s < steps && list.length * 2 <= n; s++) {
      const end = list.length;
      for (; head < end; head++) {
        const i = list[head];
        for (let e = off[i], stop = off[i + 1]; e < stop; e++) {
          const j = adj[e];
          if (!near[j]) {
            near[j] = 1;
            list.push(j);
          }
        }
      }
    }
    if (list.length * 2 <= n) {
      const toOcean = base.toOcean.slice();
      const far = steps + 1;
      const buckets: number[][] = [];
      for (let s = 0; s <= steps; s++) buckets.push([]);
      for (const i of list) toOcean[i] = land[i] ? -1 : far;
      for (const i of list) {
        if (land[i]) continue;
        if (fields.shelf[i] < 0.5) {
          toOcean[i] = 0;
          buckets[0].push(i);
          continue;
        }
        let best = far;
        for (let e = off[i], end = off[i + 1]; e < end; e++) {
          const j = adj[e];
          if (near[j] || land[j]) continue;
          const t = toOcean[j];
          if (t >= 0 && t < steps && t + 1 < best) best = t + 1;
        }
        if (best < far) {
          toOcean[i] = best;
          buckets[best].push(i);
        }
      }
      for (let s = 0; s < steps; s++) {
        for (const i of buckets[s]) {
          if (toOcean[i] !== s) continue;
          for (let e = off[i], end = off[i + 1]; e < end; e++) {
            const j = adj[e];
            if (!near[j] || land[j] || toOcean[j] <= s + 1) continue;
            toOcean[j] = s + 1;
            buckets[s + 1].push(j);
          }
        }
      }
      for (const i of list) if (toOcean[i] === far) toOcean[i] = -1;
      return toOcean;
    }
  }
  const toOcean = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let len = 0;
  for (let i = 0; i < n; i++) {
    if (!land[i] && fields.shelf[i] < 0.5) {
      toOcean[i] = 0;
      queue[len++] = i;
    }
  }
  for (let q = 0; q < len; q++) {
    const i = queue[q];
    if (toOcean[i] >= steps) continue;
    for (let e = off[i]; e < off[i + 1]; e++) {
      const j = adj[e];
      if (land[j] || toOcean[j] >= 0) continue;
      toOcean[j] = toOcean[i] + 1;
      queue[len++] = j;
    }
  }
  return toOcean;
}

// 陆地的连通块：每格的块编号（海格 −1）与每块的面积（km²）
function landComponents(world: World): [Int32Array, number[]] {
  const { mesh, causes, kmPerUnit } = world;
  const n = mesh.n;
  const land = causes.land;
  const comp = new Int32Array(n).fill(-1);
  const area: number[] = [];
  const queue = new Int32Array(n);
  const k2 = kmPerUnit * kmPerUnit;
  for (let s = 0; s < n; s++) {
    if (!land[s] || comp[s] >= 0) continue;
    const id = area.length;
    let len = 0;
    let a = 0;
    queue[len++] = s;
    comp[s] = id;
    for (let q = 0; q < len; q++) {
      const c = queue[q];
      a += mesh.area[c] * k2;
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
        const j = mesh.adj[e];
        if (land[j] && comp[j] < 0) {
          comp[j] = id;
          queue[len++] = j;
        }
      }
    }
    area.push(a);
  }
  return [comp, area];
}
