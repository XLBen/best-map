// 从地形认出来的地物（第八十三轮从 core/features.ts 原样搬出）：群岛、半岛、海峡、海湾、海、湖、湖里的岛、河、山脉、平原、盆地；跨几次记下来
import { type Mesh, gradGeo, gradientAt } from './mesh';
import type { World, Derived } from './world';
import { type AddInput, mapAreaOf, components, areaOf, put, steps, withLabels, stableAnchor } from './features-base';

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
export function memoized<T>(mesh: Mesh, name: string, inputs: ArrayBufferView[], compute: () => T): T {
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

// 有没有记下这一段的这一份（不计入命中、不调整先后）
function memoHas(mesh: Mesh, name: string, inputs: ArrayBufferView[]): boolean {
  const key = inputs.map(bytesOf);
  const list = memo.get(mesh)?.get(name) ?? [];
  return list.some((m) => m.key.length === key.length && m.key.every((b, k) => sameBytes(b, key[k])));
}

// 分阶段算（预览在阶段之间让出线程）：先把只取决于海陆的那一段（陆块、半岛、海峡、海湾、海与洋）算好记下，
// 之后的 detectFeatures 直接用上。已经记下、或者缓存关着时什么都不做。返回是否算了
export function prepareFeatures(world: World): boolean {
  if (!featureMemo.on) return false;
  const key = [world.causes.land, Float64Array.of(world.kmPerUnit), world.causes.fragment ?? NO_FRAGMENT];
  if (memoHas(world.mesh, 'terrain', key)) return false;
  memoized(world.mesh, 'terrain', key, () => terrainInputs(world));
  return true;
}

// 没打碎过的世界：缓存的键里破碎度这一项（第十八轮）
export const NO_FRAGMENT = new Uint8Array(0);

// 碎岛（第十八轮）：破碎度至少这么多（0–255，约 0.25：深海里也冒得出碎岛，见 subcell.ts 的 fragCoast）的海格算“有碎岛的格”；
// 连成一片、至少 ISLET_MIN_CELLS 格的算一个列岛 / 群岛（挨着别的岛、碎岛三步海路以内的并在一起）
export const ISLET_FRAG = 64;
const ISLET_MIN_CELLS = 3;

// 陆块、群岛、半岛、海峡、海湾、海与洋：只取决于陆海（与碎岛：破碎度）。dLand：陆地格离海岸的步数（盆地也用）
export function terrainInputs(world: World): { list: AddInput[]; dLand: Int32Array } {
  const { mesh } = world;
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

  archipelagoInputs(world, list, masses, massOf, islandIdx);

  // 海岸距离（陆地内部、海内部各自）
  const { seaMask, coastLand, coastSea } = coastSplit(mesh, land);
  const dLand = steps(mesh, coastLand, landMask);
  const dSea = steps(mesh, coastSea, seaMask);

  // 半岛：开运算（腐蚀 r 步再膨胀 r 步）削掉的、连着大块陆地的部分
  peninsulaInputs(world, list, landMask, dLand);

  // 海峡：海做开运算削掉的窄处，两侧是不同的陆块（先于海湾识别，海湾不吞掉海峡）
  const straitMask = straitInputs(world, list, seaMask, dSea, massOf);

  // 海湾：闭运算（陆地膨胀 r 步再腐蚀 r 步）补出来的凹处
  bayInputs(world, list, seaMask, dSea, straitMask);

  // 海与洋：在离岸远的地方撒种子，按距离分区
  seaInputs(world, list, seaMask, dSea, mapKm2);
  return { list: withLabels(mesh, list), dLand };
}

// 以下几段是从 terrainInputs 拆出来的（第三十二轮提速：小函数里的循环很快就被编译优化，大函数里的一段段循环常常
// 还没编译好就走完了），每段原样照搬，结果逐值相同
function archipelagoInputs(world: World, list: AddInput[], masses: number[][], massOf: Int32Array, islandIdx: number[]) {
  const { mesh } = world;
  const n = mesh.n;
  const land = world.causes.land;
  const frag = world.causes.fragment;
  let isles: number[][] = [];
  if (frag) {
    const mask = new Uint8Array(n);
    let any = false;
    for (let i = 0; i < n; i++) {
      if (!land[i] && frag[i] >= ISLET_FRAG) {
        mask[i] = 1;
        any = true;
      }
    }
    if (any) isles = components(mesh, mask);
  }
  const M = masses.length;
  const parent = [...masses.map((_, k) => k), ...isles.map((_, k) => M + k)];
  const find = (k: number): number => (parent[k] === k ? k : (parent[k] = find(parent[k])));
  const sea = new Uint8Array(n);
  for (let i = 0; i < n; i++) sea[i] = land[i] ? 0 : 1;
  const owner = new Int32Array(n).fill(-1);
  const dist = new Int32Array(n).fill(-1);
  const q: number[] = [];
  const isIsland = new Uint8Array(masses.length);
  for (const k of islandIdx) isIsland[k] = 1;
  const isleOf = new Int32Array(isles.length ? n : 0).fill(-1);
  isles.forEach((cells, k) => {
    for (const c of cells) isleOf[c] = M + k;
  });
  for (let i = 0; i < n; i++) {
    if (isles.length && isleOf[i] >= 0) {
      owner[i] = isleOf[i];
      dist[i] = 0;
      q.push(i);
      continue;
    }
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
  // 碎岛的片：并进它们所在的组（没有岛的组也建一个）
  const isleGroups = new Map<number, number[]>();
  isles.forEach((_, k) => {
    const r = find(M + k);
    const g = isleGroups.get(r) ?? [];
    g.push(k);
    isleGroups.set(r, g);
    if (!groups.has(r)) groups.set(r, []);
  });
  for (const [r, g] of groups) {
    const ig = isleGroups.get(r) ?? [];
    const isleCells = ig.reduce((a, k) => a + isles[k].length, 0);
    if (g.length < 4 && isleCells < ISLET_MIN_CELLS) continue;
    const cells = [...g.flatMap((k) => masses[k]), ...ig.flatMap((k) => isles[k])];
    // 名字记在最大的岛上（没有岛时在最大的一片碎岛上）：碎岛并进来，原来的群岛不改名
    const anchor = g.length
      ? stableAnchor(masses[g.reduce((a, b) => (masses[a].length >= masses[b].length ? a : b))])
      : stableAnchor(isles[ig.reduce((a, b) => (isles[a].length >= isles[b].length ? a : b))]);
    put(list, 'archipelago', cells, 7 + Math.log10(areaOf(world, cells)), [], anchor);
  }
}

// 海陆交界的格：海格表（1 是海）、挨着海的陆格、挨着陆地的海格（按编号）
function coastSplit(mesh: Mesh, land: Uint8Array): { seaMask: Uint8Array; coastLand: number[]; coastSea: number[] } {
  const n = mesh.n;
  const seaMask = new Uint8Array(n);
  const coastLand: number[] = [];
  const coastSea: number[] = [];
  for (let i = 0; i < n; i++) {
    seaMask[i] = land[i] ? 0 : 1;
    let edge = false;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) if (land[mesh.adj[e]] !== land[i]) edge = true;
    if (edge) (land[i] ? coastLand : coastSea).push(i);
  }
  return { seaMask, coastLand, coastSea };
}

function peninsulaInputs(world: World, list: AddInput[], landMask: Uint8Array, dLand: Int32Array) {
  const { mesh } = world;
  const n = mesh.n;
  const land = world.causes.land;
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

function straitInputs(world: World, list: AddInput[], seaMask: Uint8Array, dSea: Int32Array, massOf: Int32Array): Uint8Array {
  const { mesh } = world;
  const n = mesh.n;
  const land = world.causes.land;
  const straitMask = new Uint8Array(n);
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
  return straitMask;
}

function bayInputs(world: World, list: AddInput[], seaMask: Uint8Array, dSea: Int32Array, straitMask: Uint8Array) {
  const { mesh } = world;
  const n = mesh.n;
  const land = world.causes.land;
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

function seaInputs(world: World, list: AddInput[], seaMask: Uint8Array, dSea: Int32Array, mapKm2: number) {
  const { mesh } = world;
  const n = mesh.n;
  const land = world.causes.land;
  const globe = mesh.kind === 'sphere';
  // 第三十五轮（提速）：格表、队列换成类型化数组，逐格的几段放进小函数（先后不变，结果逐值相同）
  const seaBuf = new Int32Array(n);
  const ns = seaCellsOf(n, land, seaBuf);
  const seaCells = seaBuf.subarray(0, ns);
  if (ns) {
    const seaKm2 = areaOf(world, seaCells);
    // 整个星球按面积比例分区（星球大小不影响分法）
    const k = globe ? Math.max(3, Math.min(18, Math.round((seaKm2 / mapKm2) * 22))) : Math.max(1, Math.min(12, Math.round(seaCells.length / 2600)));
    const spacing = Math.max(4, Math.round(Math.sqrt(seaCells.length / k) * 0.8));
    // 候选种子按离岸从远到近、同距离按编号排（计数排序）；离岸不到 1 步的不当种子
    const order = farFirst(seaCells, dSea);
    // 每个种子 spacing 步海路以内的格不再当种子：只走到 spacing 步，走过的格按种子的序号标记（不必每次清空）
    const blocked = new Uint8Array(n);
    const stamp = new Int32Array(n);
    const dist = new Int32Array(n);
    const q = new Int32Array(n);
    const seeds: number[] = [];
    const most = Math.ceil(k * 1.5);
    for (let o = 0; o < order.length; o++) {
      const c = order[o];
      if (seeds.length >= most) break;
      if (blocked[c]) continue;
      seeds.push(c);
      blockAround(mesh.off, mesh.adj, seaMask, spacing, seeds.length, c, blocked, stamp, dist, q);
    }
    // 多源 BFS 分区
    const owner = new Int32Array(n).fill(-1);
    seaOwners(mesh.off, mesh.adj, land, seeds, owner, q);
    const regions: number[][] = seeds.map(() => []);
    for (let r = 0; r < ns; r++) {
      const c = seaCells[r];
      if (owner[c] >= 0) regions[owner[c]].push(c);
    }
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

// 海格（按编号，写进 out），返回个数
function seaCellsOf(n: number, land: Uint8Array, out: Int32Array): number {
  let m = 0;
  for (let i = 0; i < n; i++) if (!land[i]) out[m++] = i;
  return m;
}

// 离岸 1 步以上的海格，按离岸从远到近、同距离按编号（计数排序）
function farFirst(seaCells: Int32Array, dSea: Int32Array): Int32Array {
  let maxD = 0;
  for (let k = 0; k < seaCells.length; k++) maxD = Math.max(maxD, dSea[seaCells[k]]);
  const at = new Int32Array(maxD + 1);
  for (let k = 0; k < seaCells.length; k++) {
    const c = seaCells[k];
    if (dSea[c] >= 1) at[maxD - dSea[c] + 1]++;
  }
  for (let b = 1; b <= maxD; b++) at[b] += at[b - 1];
  const order = new Int32Array(at[maxD]);
  for (let k = 0; k < seaCells.length; k++) {
    const c = seaCells[k];
    if (dSea[c] >= 1) order[at[maxD - dSea[c]]++] = c;
  }
  return order;
}

// 第 s 个种子 c：spacing 步海路以内的格标成不再当种子（走过的格标上 s）
function blockAround(off: Int32Array, adj: Int32Array, seaMask: Uint8Array, spacing: number, s: number, c: number, blocked: Uint8Array, stamp: Int32Array, dist: Int32Array, q: Int32Array) {
  stamp[c] = s;
  dist[c] = 0;
  blocked[c] = 1;
  q[0] = c;
  for (let h = 0, t = 1; h < t; h++) {
    const x = q[h];
    if (dist[x] >= spacing) continue;
    for (let e = off[x]; e < off[x + 1]; e++) {
      const j = adj[e];
      if (seaMask[j] && stamp[j] !== s) {
        stamp[j] = s;
        dist[j] = dist[x] + 1;
        blocked[j] = 1;
        q[t++] = j;
      }
    }
  }
}

// 从种子起多源宽度优先，海格归先到的种子
function seaOwners(off: Int32Array, adj: Int32Array, land: Uint8Array, seeds: number[], owner: Int32Array, q: Int32Array) {
  let t = 0;
  for (let idx = 0; idx < seeds.length; idx++) {
    owner[seeds[idx]] = idx;
    q[t++] = seeds[idx];
  }
  for (let h = 0; h < t; h++) {
    const c = q[h];
    for (let e = off[c]; e < off[c + 1]; e++) {
      const j = adj[e];
      if (!land[j] && owner[j] < 0) {
        owner[j] = owner[c];
        q[t++] = j;
      }
    }
  }
}

// 湖里的岛（第十五轮）：四周全是湖面的干陆地（陆格里不是湖面的连通块，挨着的格都是湖面，不挨地图边）。
// 陆块按陆海分，湖面也是陆格，所以湖里的岛不会单独成为陆块：这里另外认出来，与海里的岛一样是“岛”（大小、标签同一个规则）。
// 只取决于陆海与湖面；没有这样的地方时什么都不加（与以前逐值相同）
// 从 s 出发只走干陆地（陆格、不是湖面）：整块都只挨着湖面（不挨海、不在地图边上）时返回格数，格在 queue 的前面，comp 标成 s；
// 否则返回 0，走过的格标成 −2（“不是”：挨着它的干陆地也不是）。comp 是 −1 的格还没走过
function enclosedDry(mesh: Mesh, land: Uint8Array, lake: Uint8Array, comp: Int32Array, queue: Int32Array, s: number): number {
  const { off, adj, boundary } = mesh;
  let len = 0;
  queue[len++] = s;
  comp[s] = s;
  let open = boundary[s] === 1;
  for (let h = 0; h < len && !open; h++) {
    const c = queue[h];
    for (let e = off[c]; e < off[c + 1]; e++) {
      const j = adj[e];
      if (land[j] && lake[j] !== 1) {
        const cj = comp[j];
        if (cj === -1) {
          comp[j] = s;
          queue[len++] = j;
          if (boundary[j] === 1) open = true;
        } else if (cj === -2) open = true;
      } else if (!land[j]) open = true;
      if (open) break;
    }
  }
  if (!open) return len;
  for (let k = 0; k < len; k++) comp[queue[k]] = -2;
  return 0;
}

// 导出给测试（features-memo：与以前的整块走一遍的写法逐值相同）
export function lakeIslandInputs(world: World, d: Derived): AddInput[] {
  const { mesh } = world;
  const n = mesh.n;
  const land = world.causes.land;
  const avgCellKm2 = mapAreaOf(world) / n;
  const list: AddInput[] = [];
  // 挨着湖面的干陆地格才可能是湖里的岛：从它们出发只走干陆地，碰到不是湖面的邻格（海、地图边）就不是。
  // 第三十二轮（提速）：起点只在湖面的邻格里找（邻接是对称的：挨着湖面的格就是湖面格的邻格），按编号从小到大，
  // 与以前逐格找的先后相同；走的时候一碰到海、地图边就停下，走过的格标成“不是”（同一块干陆地从别的格出发时碰到它们也就停下），
  // 不再把整块大陆的干陆地走一遍。是湖里的岛的那几块照旧整块走完，起点、格、先后都与以前相同
  const seeds = lakeShoreSeeds(mesh, land, d.lake);
  if (!seeds) return list;
  const comp = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  for (let k = 0; k < seeds.length; k++) {
    const s = seeds[k];
    if (comp[s] !== -1) continue;
    const len = enclosedDry(mesh, land, d.lake, comp, queue, s);
    if (len < 2) continue;
    const cells = Array.from(queue.subarray(0, len)).sort((a, b) => a - b);
    const area = areaOf(world, cells);
    const tags = [area > avgCellKm2 * 400 ? 'large' : area < avgCellKm2 * 6 ? 'small' : ''];
    put(list, 'island', cells, 4 + Math.log10(area), tags.filter(Boolean), undefined, cells.length < 120 ? 'islet' : undefined);
  }
  return withLabels(mesh, list);
}

// 挨着湖面（d.lake 为 1）的干陆地格（陆格、不是湖面），按编号从小到大；没有湖面时为 null
function lakeShoreSeeds(mesh: Mesh, land: Uint8Array, lake: Uint8Array): Int32Array | null {
  const n = mesh.n;
  const { off, adj } = mesh;
  let count = 0;
  for (let i = 0; i < n; i++) if (lake[i] === 1) count++;
  if (!count) return null;
  const mark = new Uint8Array(n);
  let m = 0;
  for (let i = 0; i < n; i++) {
    if (lake[i] !== 1) continue;
    for (let e = off[i]; e < off[i + 1]; e++) {
      const j = adj[e];
      if (!mark[j] && land[j] && lake[j] !== 1) {
        mark[j] = 1;
        m++;
      }
    }
  }
  const out = new Int32Array(m);
  for (let i = 0, k = 0; k < m; i++) if (mark[i]) out[k++] = i;
  return out;
}

// 湖：只取决于湖面与高度（没挖河床的地形）
export function lakeInputs(world: World, d: Derived, terrain: ArrayLike<number>): AddInput[] {
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
// 导出给测试（features-memo：与以前建整张上游表的写法逐值相同）
export function riverInputs(world: World, d: Derived): AddInput[] {
  const n = world.mesh.n;
  const land = world.causes.land;
  const thr = world.small.planet.riverThreshold;
  const list: AddInput[] = [];
  // 第三十二轮（提速）：不再建每格的整张上游表，一遍就记下每格“流量最大的上游”（够河的门槛、不是湖面；
  // 一样大时取编号小的：按编号从小到大逐个比，与以前在按编号排好的上游里挑相同）与河口
  const best = new Int32Array(n).fill(-1);
  const mouths = riverHeads(n, land, d.receiver, d.lake, d.discharge, thr, best);
  mouths.sort((a, b) => d.discharge[b] - d.discharge[a]);
  for (const m of mouths.slice(0, 40)) {
    const stem: number[] = [m];
    for (let c = best[m], guard = 0; c >= 0 && guard < n; c = best[c], guard++) stem.push(c);
    if (stem.length < 6) continue;
    const q = d.discharge[m];
    const size = q > thr * 40 ? 'big' : q > thr * 6 ? '' : 'small';
    put(list, 'river', stem, 6 + Math.log10(q), size ? [size] : [], m, 'river');
  }
  return list;
}

// 每格流量最大的上游（best，没有为 −1）；返回河口（流量够门槛 3 倍、下游是海或湖面的陆格，按编号）
function riverHeads(n: number, land: Uint8Array, receiver: Int32Array, lake: Uint8Array, discharge: Float32Array, thr: number, best: Int32Array): number[] {
  const mouths: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue;
    const r = receiver[i];
    if (r >= 0 && land[r] && lake[i] !== 1 && discharge[i] >= thr) {
      const b = best[r];
      if (b < 0 || discharge[i] > discharge[b]) best[r] = i;
    }
    if (lake[i] === 1 || discharge[i] < thr * 3) continue;
    if (r < 0 || !land[r] || lake[r] === 1) mouths.push(i);
  }
  return mouths;
}

// 坡度（m/km），与水文里算的 d.slope 同一个算式（结果逐值相同）。按没挖河床的地形认高原、平原时用
function slopeOf(world: World, elevation: ArrayLike<number>): Float32Array {
  const { mesh, kmPerUnit } = world;
  const n = mesh.n;
  const land = world.causes.land;
  const hPos = new Float64Array(n);
  for (let i = 0; i < n; i++) hPos[i] = land[i] ? elevation[i] : 0;
  const out = new Float32Array(n);
  landSlopes(mesh, gradGeo(mesh), hPos, land, kmPerUnit, out);
  return out;
}

// 第三十五轮（提速）：陆格的坡度按 gradientAt（与 gradient 逐值相同，不每格分配数组），循环放在小函数里
function landSlopes(mesh: Mesh, g: ReturnType<typeof gradGeo>, hPos: Float64Array, land: Uint8Array, kmPerUnit: number, out: Float32Array) {
  const v = new Float64Array(2);
  for (let i = 0; i < mesh.n; i++) {
    if (!land[i]) continue;
    gradientAt(mesh, g, hPos, i, v);
    out[i] = Math.hypot(v[0], v[1]) / kmPerUnit;
  }
}

// 没挖河床的地形的坡度：没有画的河时就是水文算好的那份（两者逐值相同），有的话按地形另算（按内容缓存）
export function terrainSlope(world: World, d: Derived, terrain: Float32Array): ArrayLike<number> {
  if (terrain === d.elevation || !world.small.guides.length) return d.slope;
  return memoized(world.mesh, 'slope', [world.causes.land, terrain], () => slopeOf(world, terrain));
}

// 山脉与主峰；高原；平原；盆地：只取决于陆海、湖面、高度、坡度（dLand 由陆海算出）。
// 高度、坡度按没挖河床的地形（elevation、slope）：画的峡谷不会把山脉切成两段、换掉主峰，山名不变
// 第三十二轮（提速）：分成三小段、各按它实际读的数组缓存（山脉与主峰按山地的格与高度；高原、平原按两张格表；
// 盆地按陆海与高度，不看湖面）。湖面随气候涨落（内流湖）时，多半只有平原那一张表变了，盆地那几遍取最大不用重算。
// withLabels 逐个地物各算各的，所以分段标注后接起来与整个一起标注逐值相同；先后照旧：山脉与主峰、高原、平原、盆地
export function reliefInputs(world: World, d: Derived, dLand: Int32Array, elevation: Float32Array, slope: ArrayLike<number>): AddInput[] {
  const { mesh } = world;
  const n = mesh.n;
  const land = world.causes.land;
  const km = Float64Array.of(world.kmPerUnit);
  const mountain = new Uint8Array(n);
  const plateau = new Uint8Array(n);
  const plain = new Uint8Array(n);
  reliefMasks(n, land, d.lake, elevation, slope, mountain, plateau, plain);
  const ranges = memoized(mesh, 'relief-range', [mountain, elevation, km], () => withLabels(mesh, rangeInputs(world, mountain, elevation)));
  const flats = memoized(mesh, 'relief-flat', [plateau, plain, km], () => withLabels(mesh, flatInputs(world, plateau, plain)));
  const basins = memoized(mesh, 'relief-basin', [land, elevation, km], () => withLabels(mesh, basinInputs(world, dLand, elevation)));
  return [...ranges, ...flats, ...basins];
}

// 山地（1300 m 以上、不是湖面的陆格）、高原、平原的格表
function reliefMasks(n: number, land: Uint8Array, lake: Uint8Array, elevation: Float32Array, slope: ArrayLike<number>, mountain: Uint8Array, plateau: Uint8Array, plain: Uint8Array) {
  for (let i = 0; i < n; i++) mountain[i] = land[i] && lake[i] !== 1 && elevation[i] >= 1300 ? 1 : 0;
  for (let i = 0; i < n; i++) {
    if (!land[i] || lake[i] === 1) continue;
    if (elevation[i] >= 1200 && slope[i] <= 8) plateau[i] = 1;
    if (elevation[i] <= 400 && slope[i] <= 2.5) plain[i] = 1;
  }
}

// 山脉与主峰
function rangeInputs(world: World, mountain: Uint8Array, elevation: Float32Array): AddInput[] {
  const list: AddInput[] = [];
  for (const cells of components(world.mesh, mountain)) {
    if (cells.length < 6) continue;
    let peak = cells[0];
    for (const c of cells) if (elevation[c] > elevation[peak]) peak = c;
    const volcanic = cells.length < 40 && elevation[peak] > 1500;
    put(list, 'range', cells, 6.5 + Math.log10(areaOf(world, cells)), volcanic ? ['volcanic'] : []);
    if (elevation[peak] >= 2600 || (volcanic && elevation[peak] >= 1500)) {
      put(list, 'peak', [peak], 5 + elevation[peak] / 3000, volcanic ? ['volcanic'] : [], peak, 'peak');
    }
  }
  return list;
}

// 高原；平原（最大的 8 片）
function flatInputs(world: World, plateau: Uint8Array, plain: Uint8Array): AddInput[] {
  const { mesh } = world;
  const list: AddInput[] = [];
  for (const cells of components(mesh, plateau)) if (cells.length >= 15) put(list, 'plateau', cells, 6 + Math.log10(areaOf(world, cells)));
  const plains = components(mesh, plain).filter((c) => c.length >= 40).sort((a, b) => b.length - a.length).slice(0, 8);
  for (const cells of plains) put(list, 'plain', cells, 5.5 + Math.log10(areaOf(world, cells)));
  return list;
}

// 盆地：被高出很多的地形围住的低地（只取决于陆海与高度；dLand 由陆海算出）
function basinInputs(world: World, dLand: Int32Array, elevation: Float32Array): AddInput[] {
  const { mesh } = world;
  const n = mesh.n;
  const land = world.causes.land;
  const list: AddInput[] = [];
  const near = nearMax(mesh, land, elevation);
  const basin = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (land[i] && elevation[i] < 900 && near[i] - elevation[i] > 1400 && dLand[i] > 3) basin[i] = 1;
  for (const cells of components(mesh, basin)) if (cells.length >= 20) put(list, 'basin', cells, 5.5 + Math.log10(areaOf(world, cells)));
  return list;
}

// 每个陆格附近的最高：先取自己与邻格的最高，再在陆格之间传四遍（每遍取自己与邻格上一遍的最高；海格一直是 0）。
// 与以前的写法（每遍先复制一份再逐个取最大）逐值相同：每格取最大的先后一样，只是两份数组轮换、不再复制（导出给测试）
export function nearMax(mesh: Mesh, land: Uint8Array, elevation: Float32Array): Float64Array {
  const n = mesh.n;
  const { off, adj } = mesh;
  let near = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (!land[i]) continue;
    let mx = elevation[i];
    for (let e = off[i]; e < off[i + 1]; e++) mx = Math.max(mx, elevation[adj[e]]);
    near[i] = mx;
  }
  let next = new Float64Array(n);
  for (let pass = 0; pass < 4; pass++) {
    nearPass(n, off, adj, land, near, next);
    const t = near;
    near = next;
    next = t;
  }
  return near;
}

function nearPass(n: number, off: Int32Array, adj: Int32Array, land: Uint8Array, near: Float64Array, next: Float64Array) {
  for (let i = 0; i < n; i++) {
    let v = near[i];
    if (land[i]) for (let e = off[i]; e < off[i + 1]; e++) v = Math.max(v, near[adj[e]]);
    next[i] = v;
  }
}
