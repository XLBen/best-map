import { MinHeap } from './heap';
import { provinceLand } from './island-types';
import { graphDistanceOwner, ringDistance } from './mesh';
import { mixSeed, mulberry32 } from './rng';
import type { Derived, ProvinceMeta, World } from './world';
import { type ProvinceRules, provinceSeed, worldProvinceRules } from './province-rules';
import { provinceTargets, SEA, LAND, WASTE, LAKE, KIND_OF_CLASS, type ProvinceClass, classOfKind, countryKeys, lakeCells, components, provinceName, setProvinceName, takenNames, nameProvinces } from './province-kinds';
export { PROVINCE_KINDS, PROVINCE_KIND_INFO, provinceTargets, classOfKind, countryKeys, lakeCells, renameProvince, nameNewProvince, summarizeProvinces } from './province-kinds';
export type { ProvinceKind, ProvinceClass, ProvinceSummary } from './province-kinds';

// 省份 = 格的聚类。自动划分用加权区域生长：跨河、跨山脊代价高，所以边界自然贴着河与山脊；不跨海岸。
// 规则（第七十八轮起是资源库里的“省份划分”，见 province-rules.ts）：大小、按地形调整大小、无人区、湖（单独成省 / 并进旁边的陆地省）、近海小远洋大、沿河沿山脊的代价。
// 格分三类，省份不跨类：海、陆地（含无人区）、湖（湖单独成省时）。海永远不和陆地、湖同省；
// 湖“并进陆地省”时湖面的格算陆地。归海省的岛（小礁一类，见 island-types.ts）是陆地格，但算海：并进旁边的海省。
// 划分结果是“原因”的一部分（用户可编辑）：
//   · 默认固定种子，“换一种划分”才换；
//   · 重新划分一片只动这一片，别处的省份编号与名字不变；
//   · 陆海变化后由 repairProvinces 就近修补，不会整体重算抹掉手工修改。

function cellClasses(world: World, d: Derived, rules: ProvinceRules, pland: Uint8Array): Uint8Array {
  const { mesh } = world;
  const n = mesh.n;
  const cls = new Uint8Array(n);
  for (let i = 0; i < n; i++) cls[i] = pland[i] ? LAND : SEA;
  const target = provinceTargets(world, rules);
  if (rules.lakeMode === 'separate') {
    const lake = lakeCells(world, d);
    for (let i = 0; i < n; i++) if (lake[i]) cls[i] = LAKE;
  }
  if (rules.wasteland) {
    const waste = (i: number) => cls[i] === LAND && (d.tWarm[i] < 0 || d.moisture[i] < 0.06 || d.elevation[i] > 3500);
    for (const comp of components(world, waste)) if (comp.length >= target.land * 0.6) for (const c of comp) cls[c] = WASTE;
  }
  return cls;
}

// 每格的“疏密系数”：省份目标大小的倍数
function densityFactors(world: World, d: Derived, rules: ProvinceRules, cls: Uint8Array, land: Uint8Array): Float32Array {
  const { mesh, small } = world;
  const n = mesh.n;
  const f = new Float32Array(n).fill(1);
  const thr = small.planet.riverThreshold;
  let coastDist: Int32Array | null = null;
  if (rules.seaByDistance) {
    const coast: number[] = [];
    for (let i = 0; i < n; i++) {
      if (land[i]) continue;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        if (land[mesh.adj[e]]) {
          coast.push(i);
          break;
        }
      }
    }
    coastDist = ringDistance(mesh, coast, Infinity, (j) => !land[j]);
  }
  for (let i = 0; i < n; i++) {
    switch (cls[i]) {
      case SEA: {
        const dist = coastDist ? coastDist[i] : 0;
        f[i] = coastDist && dist >= 0 ? 1 + Math.min(3, Math.max(0, (dist - 2) / 4)) : 1;
        break;
      }
      case WASTE:
        f[i] = 4;
        break;
      case LAKE:
        f[i] = 2.5;
        break;
      default: {
        if (!rules.varied) break;
        let coastal = false;
        for (let e = mesh.off[i]; e < mesh.off[i + 1] && !coastal; e++) if (!land[mesh.adj[e]]) coastal = true;
        const fertile = coastal || d.discharge[i] >= thr * 3 || (d.elevation[i] < 300 && d.moisture[i] > 0.5);
        if (d.elevation[i] > 1500 || d.slope[i] > 20) f[i] = 1.6;
        else if (d.moisture[i] < 0.25 || d.tMean[i] < -2) f[i] = 1.8;
        else if (fertile) f[i] = 0.6;
      }
    }
  }
  return f;
}

// 两个升序的格列表合成一个升序列表
function mergeSorted(a: number[], b: number[]): number[] {
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) out.push(a[i] < b[j] ? a[i++] : b[j++]);
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}

// 在 region 里的格上重新划分（region 外的省份不动），新省份用新编号；返回新省份的编号
function partition(world: World, d: Derived, rules: ProvinceRules, seed: number, region: Uint8Array, salt: number): number[] {
  const { mesh, causes, small } = world;
  const n = mesh.n;
  const province = causes.province;
  const pland = provinceLand(world);
  const cls = cellClasses(world, d, rules, pland);
  const dens = densityFactors(world, d, rules, cls, pland);
  const target = provinceTargets(world, rules);
  const baseOf = (i: number) => (cls[i] === SEA ? target.sea : target.land);
  const rand = mulberry32(mixSeed(seed, 401, salt));
  const riverQ = small.planet.riverThreshold;
  // 不跨国界（第二十三轮）
  const ck = countryKeys(world, pland);

  // 种子：随机顺序遍历，与已选种子相距不足 r 步（同类格里）的跳过（近似泊松盘）
  const cells: number[] = [];
  for (let i = 0; i < n; i++) if (region[i]) cells.push(i);
  for (let k = cells.length - 1; k > 0; k--) {
    const j = Math.floor(rand() * (k + 1));
    [cells[k], cells[j]] = [cells[j], cells[k]];
  }
  const blocked = new Uint8Array(n);
  const stamp = new Int32Array(n).fill(-1);
  const seeds: number[] = [];
  for (const s of cells) {
    if (blocked[s]) continue;
    seeds.push(s);
    const r = Math.max(1, Math.round(Math.sqrt(baseOf(s) * dens[s]) * 0.75));
    // 有界的广度优先：只走 r 步
    let frontier = [s];
    stamp[s] = seeds.length;
    blocked[s] = 1;
    for (let step = 0; step < r && frontier.length; step++) {
      const next: number[] = [];
      for (const c of frontier) {
        for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
          const j = mesh.adj[e];
          if (stamp[j] === seeds.length || !region[j] || cls[j] !== cls[s] || (ck && ck[j] !== ck[s])) continue;
          stamp[j] = seeds.length;
          blocked[j] = 1;
          next.push(j);
        }
      }
      frontier = next;
    }
  }

  const isRiver = (i: number) => d.discharge[i] >= riverQ;
  const cost = (i: number, j: number, e: number) => {
    if (!region[j] || cls[i] !== cls[j] || (ck && ck[i] !== ck[j])) return Infinity;
    let c = mesh.dist[e];
    if (cls[i] === LAND || cls[i] === WASTE) {
      const dh = Math.abs(d.elevation[j] - d.elevation[i]);
      c *= 1 + rules.ridgeCost * (dh / 400 + Math.max(0, d.elevation[j] - 1500) / 3000);
      if (isRiver(j) !== isRiver(i)) c *= 1 + rules.riverCost;
    }
    return c;
  };
  const { owner } = graphDistanceOwner(mesh, seeds, Infinity, cost);
  const seedToProvince = new Map<number, number>();
  const fresh: number[] = [];
  for (const s of seeds) {
    const id = small.nextProvince++;
    seedToProvince.set(s, id);
    small.provinces[id] = { name: '', locked: false, land: pland[s] === 1, kind: KIND_OF_CLASS[cls[s]] };
    fresh.push(id);
  }
  // 顺便记下每个新省份的格（按编号升序），下面算边界、并入都只走这些格
  const cellsOf = new Map<number, number[]>(fresh.map((id) => [id, []]));
  for (let i = 0; i < n; i++) {
    if (!region[i]) continue;
    province[i] = owner[i] >= 0 ? seedToProvince.get(owner[i])! : -1;
    if (province[i] >= 0) cellsOf.get(province[i])!.push(i);
  }

  // 太小的新省份并入共享边界最长的同类新省份（不碰区域外的省份）
  const freshSet = new Set(fresh);
  const sizes = provinceSizes(world);
  const seedOf = new Map<number, number>();
  for (const [s, id] of seedToProvince) seedOf.set(id, s);
  const order = [...fresh].sort((a, b) => (sizes.get(a) ?? 0) - (sizes.get(b) ?? 0) || a - b);
  for (const id of order) {
    const meta = small.provinces[id];
    if (!meta) continue;
    const size = sizes.get(id) ?? 0;
    const s = seedOf.get(id)!;
    if (size >= baseOf(s) * dens[s] * 0.3) continue;
    const own = cellsOf.get(id)!;
    const border = new Map<number, number>();
    for (const i of own) {
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const p = province[mesh.adj[e]];
        if (ck && ck[mesh.adj[e]] !== ck[i]) continue;
        if (p >= 0 && p !== id && freshSet.has(p) && small.provinces[p]?.kind === meta.kind) border.set(p, (border.get(p) ?? 0) + mesh.edgeLen[e]);
      }
    }
    let best = -1;
    let bl = 0;
    for (const [p, l] of border) {
      if (l > bl || (l === bl && p < best)) {
        bl = l;
        best = p;
      }
    }
    if (best < 0) continue;
    for (const i of own) province[i] = best;
    cellsOf.set(best, mergeSorted(cellsOf.get(best)!, own));
    cellsOf.delete(id);
    sizes.set(best, (sizes.get(best) ?? 0) + size);
    sizes.delete(id);
    delete small.provinces[id];
    freshSet.delete(id);
  }
  const before = small.nextProvince;
  let lake: Uint8Array | null = null;
  if (rules.lakeMode === 'separate') {
    lake = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (cls[i] === LAKE) lake[i] = 1;
  }
  fillUnassigned(world, lake);
  for (let id = before; id < small.nextProvince; id++) if (small.provinces[id]) freshSet.add(id);
  const out = [...freshSet].filter((id) => small.provinces[id]).sort((a, b) => a - b);
  nameProvinces(world, out);
  return out;
}

// 整体自动划分（按世界的省份划分、这个种子）。锁定的省份保持不动
export function generateProvinces(world: World, d: Derived, seed: number) {
  const { mesh, causes, small } = world;
  small.provinceSeed = seed;
  const rules = worldProvinceRules(small);
  const locked = new Set(
    Object.entries(small.provinces)
      .filter(([, m]) => m.locked)
      .map(([k]) => Number(k)),
  );
  const region = new Uint8Array(mesh.n);
  if (!locked.size) {
    causes.province.fill(-1);
    small.provinces = {};
    small.nextProvince = 0;
    region.fill(1);
  } else {
    for (let i = 0; i < mesh.n; i++) if (!locked.has(causes.province[i])) region[i] = 1;
    for (const id of Object.keys(small.provinces).map(Number)) if (!locked.has(id)) delete small.provinces[id];
  }
  partition(world, d, rules, seed, region, 0);
}

// 一笔涂到的格会重新划分哪些省份：被涂到一半以上、没锁定的省份
export function regenTargets(world: World, cells: number[]): number[] {
  const { causes, small } = world;
  const hit = new Map<number, number>();
  for (const i of new Set(cells)) {
    const p = causes.province[i];
    if (p >= 0 && !small.provinces[p]?.locked) hit.set(p, (hit.get(p) ?? 0) + 1);
  }
  const sizes = provinceSizes(world);
  return [...hit]
    .filter(([p, k]) => k >= (sizes.get(p) ?? 1) * 0.5)
    .map(([p]) => p)
    .sort((a, b) => a - b);
}

// 只重新划分这些省份占的地方（按世界的规则与种子）；新省份用新编号，别处不变
export function regenerateProvinces(world: World, d: Derived, ids: number[]): number[] {
  const { mesh, causes, small } = world;
  const set = new Set(ids);
  const region = new Uint8Array(mesh.n);
  for (let i = 0; i < mesh.n; i++) if (set.has(causes.province[i])) region[i] = 1;
  for (const id of ids) delete small.provinces[id];
  // 用当前的下一个编号做盐：同样的操作重放结果相同，再做一次又是新的划分
  return partition(world, d, worldProvinceRules(small), provinceSeed(small), region, small.nextProvince + 1);
}

// 第三十五轮（提速）：先按编号数在类型化数组里（编号一直往上加，不会比格数大太多；太大时照旧逐格放进 Map），
// 再按每个编号第一次出现的先后放进 Map：键、值与插入的先后都与逐格 set 的 Map 相同
export function provinceSizes(world: World): Map<number, number> {
  const prov = world.causes.province;
  const max = maxOf(prov);
  if (max > 4 * prov.length + 1024) {
    const sizes = new Map<number, number>();
    for (const p of prov) if (p >= 0) sizes.set(p, (sizes.get(p) ?? 0) + 1);
    return sizes;
  }
  const count = new Int32Array(max + 1);
  const order = new Int32Array(max + 1);
  const m = countIds(prov, count, order);
  const sizes = new Map<number, number>();
  for (let k = 0; k < m; k++) sizes.set(order[k], count[order[k]]);
  return sizes;
}

function maxOf(a: Int32Array): number {
  let max = -1;
  for (let i = 0; i < a.length; i++) if (a[i] > max) max = a[i];
  return max;
}

// 每个编号的格数；order：编号第一次出现的先后，返回个数
function countIds(prov: Int32Array, count: Int32Array, order: Int32Array): number {
  let m = 0;
  for (let i = 0; i < prov.length; i++) {
    const p = prov[i];
    if (p < 0) continue;
    if (count[p]++ === 0) order[m++] = p;
  }
  return m;
}

// 未归属的格：先就近并入同类、未锁定且不太大的相邻省份，剩下的成片区域各自生长为新省份。
// lake：湖面的格（湖单独成省时，见 lakeCells）。不给时陆上的格都算陆地：只并进陆地、无人区省份，不会并进湖省
export function fillUnassigned(world: World, lake: Uint8Array | null = null) {
  const { mesh, causes, small } = world;
  const n = mesh.n;
  const province = causes.province;
  const sizes = provinceSizes(world);
  const targets = provinceTargets(world, worldProvinceRules(small));
  const pland = provinceLand(world);
  const classOf = (i: number): ProvinceClass => (!pland[i] ? 'sea' : lake?.[i] ? 'lake' : 'land');
  const target = (c: ProvinceClass) => (c === 'sea' ? targets.sea : targets.land);
  // 同一个国家（第二十三轮；没有国家时都算）
  const ck = countryKeys(world, pland);
  // 一格并入相邻的同类、未锁定、不太大的省份里最小的那个；并不进去返回 false
  const join = (i: number): boolean => {
    const cls = classOf(i);
    let best = -1;
    let bestSize = Infinity;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const p = province[mesh.adj[e]];
      if (p < 0 || (ck && ck[mesh.adj[e]] !== ck[i])) continue;
      const meta = small.provinces[p];
      if (!meta || meta.locked || classOfKind(meta.kind) !== cls) continue;
      const sz = sizes.get(p) ?? 0;
      if (sz < target(cls) * 1.5 && sz < bestSize) {
        best = p;
        bestSize = sz;
      }
    }
    if (best < 0) return false;
    province[i] = best;
    sizes.set(best, bestSize + 1);
    return true;
  };
  // 结果等于“按编号一遍遍整体重扫，直到不再变化”，但只看可能变化的格：省份只会变大，
  // 一格这一遍并不进去，下一遍也并不进去，除非其间有邻格有了省份（邻接是对称的）。
  // 格 j 有了省份时：编号比 j 大的未归属邻格这一遍还会轮到，小的留到下一遍；每一遍仍按编号从小到大
  const queued = new Int32Array(n);
  const heap = new MinHeap();
  let pass = 1;
  let later: number[] = [];
  const wake = (j: number) => {
    for (let e = mesh.off[j]; e < mesh.off[j + 1]; e++) {
      const i = mesh.adj[e];
      if (province[i] >= 0) continue;
      if (i < j) {
        if (queued[i] !== pass + 1) {
          queued[i] = pass + 1;
          later.push(i);
        }
      } else if (pass > 1 && queued[i] !== pass) {
        queued[i] = pass;
        heap.push(i, i);
      }
    }
  };
  // 第一遍逐格看
  let changed = false;
  for (let i = 0; i < n; i++) {
    if (province[i] < 0 && join(i)) {
      changed = true;
      wake(i);
    }
  }
  while (changed) {
    changed = false;
    pass++;
    for (const i of later) heap.push(i, i);
    later = [];
    while (heap.size) {
      const i = heap.pop();
      if (province[i] < 0 && join(i)) {
        changed = true;
        wake(i);
      }
    }
  }
  // 剩余成片区域：按目标大小切成新省份
  // 已用的名字只在第一次起名时收集一次，之后每起一个名字就加进去（与每次重新收集的结果相同）
  let taken: Set<string> | null = null;
  for (let i = 0; i < n; i++) {
    if (province[i] >= 0) continue;
    const land = pland[i] === 1;
    const cls = classOf(i);
    const id = small.nextProvince++;
    const meta: ProvinceMeta = { name: '', locked: false, land, kind: cls };
    small.provinces[id] = meta;
    const queue = [i];
    province[i] = id;
    let count = 1;
    for (let h = 0; h < queue.length && count < target(cls); h++) {
      const c = queue[h];
      for (let e = mesh.off[c]; e < mesh.off[c + 1] && count < target(cls); e++) {
        const j = mesh.adj[e];
        if (province[j] < 0 && classOf(j) === cls && (!ck || ck[j] === ck[i])) {
          province[j] = id;
          queue.push(j);
          count++;
        }
      }
    }
    // 格都划好之后再起名，名字才能按省内地形取字。新编号此前没有格用过，队列里正是这个省份的格；
    // 按编号排好，取字时的累加顺序与扫全图收集时相同
    taken ??= takenNames(world);
    queue.sort((a, b) => a - b);
    setProvinceName(meta, provinceName(world, id, queue, meta.kind, taken));
    // 空名字不算已用（重新收集时会被滤掉）
    if (!meta.name) taken.delete('');
  }
}

// 陆海改变后：类别不符的格移出原省份，再修补。这时还不知道湖在哪里（湖是推导出来的）：
// 变成陆地的格只并进陆地省；湖与陆地之间的整理由引擎在推导算好之后做（见 lakeProvinceFix）
export function repairProvinces(world: World) {
  const { causes, small } = world;
  const pland = provinceLand(world);
  // 第三十五轮（提速）：每个编号的省份是陆地省（1）、海省（0）还是没有了（2，陆海不是真假时也算：一定对不上）先查一次（编号太大时照旧逐格查）
  const max = maxOf(causes.province);
  if (max > 4 * causes.province.length + 1024) {
    for (let i = 0; i < causes.province.length; i++) {
      const p = causes.province[i];
      if (p < 0) continue;
      const meta = small.provinces[p];
      if (!meta || meta.land !== (pland[i] === 1)) causes.province[i] = -1;
    }
  } else {
    const kind = new Uint8Array(max + 1).fill(2);
    for (let p = 0; p <= max; p++) {
      const meta = small.provinces[p];
      if (meta) kind[p] = meta.land === true ? 1 : meta.land === false ? 0 : 2;
    }
    dropMismatched(causes.province, pland, kind);
  }
  fillUnassigned(world);
  dropEmptyProvinces(world);
}

// 省份没有了、或者省份的陆海与这一格的不同：这一格先不归哪个省
function dropMismatched(province: Int32Array, pland: Uint8Array, kind: Uint8Array) {
  for (let i = 0; i < province.length; i++) {
    const p = province[i];
    if (p < 0) continue;
    const k = kind[p];
    if (k === 2 || (k === 1) !== (pland[i] === 1)) province[i] = -1;
  }
}

// 省份跟着国界切开（第二十三轮）：陆地省（陆地、无人区、湖省）里格数最多的那个国家（无主也算一个）留着这个省；
// 别的国家在这个省里的格按连成的块，小块（不到目标大小的四分之一）并进挨着的、同一个国家、同一类、没锁定的省里接壤最长的那个，
// 别的成新的省（编号接着往后，按格编号最小的先；新省按格起名，名字由命令记下）。锁定的省照样切（锁定只管自动重划）。
// 只看原因，执行、重放都一样。返回新建的省。没有国家的世界什么都不做
export function fitProvincesToCountries(world: World): number[] {
  const { mesh, causes, small } = world;
  const pland = provinceLand(world);
  const ck = countryKeys(world, pland);
  if (!ck) return [];
  const province = causes.province;
  const n = mesh.n;
  // 每个陆地省里各国家的格数
  const counts = new Map<number, Map<number, number>>();
  for (let i = 0; i < n; i++) {
    const p = province[i];
    if (p < 0 || !pland[i] || !small.provinces[p]?.land) continue;
    let m = counts.get(p);
    if (!m) counts.set(p, (m = new Map()));
    m.set(ck[i], (m.get(ck[i]) ?? 0) + 1);
  }
  const split = new Map<number, number>();
  for (const [p, m] of counts) {
    if (m.size < 2) continue;
    let best = -3;
    let bc = 0;
    for (const [k, v] of m) if (v > bc || (v === bc && k < best)) {
      bc = v;
      best = k;
    }
    split.set(p, best);
  }
  if (!split.size) return [];
  const target = provinceTargets(world, worldProvinceRules(small)).land;
  const seen = new Uint8Array(n);
  const fresh: number[] = [];
  for (let s = 0; s < n; s++) {
    const p = province[s];
    if (seen[s] || p < 0 || !split.has(p) || ck[s] === split.get(p)) continue;
    // 这一块：同一个省、同一个国家、连着的格
    const key = ck[s];
    const cells: number[] = [];
    const stack = [s];
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      cells.push(i);
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (!seen[j] && province[j] === p && ck[j] === key) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    cells.sort((a, b) => a - b);
    const meta = small.provinces[p];
    let into = -1;
    if (cells.length < target * 0.25) {
      const border = new Map<number, number>();
      for (const i of cells) {
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
          const j = mesh.adj[e];
          const q = province[j];
          // 只并进只属于这个国家的省（还要切的省按它留下的国家算）
          if (q < 0 || q === p || ck[j] !== key || (split.has(q) && split.get(q) !== key)) continue;
          const mq = small.provinces[q];
          if (!mq || mq.locked || !mq.land || classOfKind(mq.kind) !== classOfKind(meta.kind)) continue;
          border.set(q, (border.get(q) ?? 0) + 1);
        }
      }
      let bc = 0;
      for (const [q, v] of border) if (v > bc || (v === bc && q < into)) {
        bc = v;
        into = q;
      }
    }
    if (into < 0) {
      into = small.nextProvince++;
      small.provinces[into] = { name: '', locked: false, land: true, kind: meta.kind };
      fresh.push(into);
    }
    for (const i of cells) province[i] = into;
  }
  dropEmptyProvinces(world);
  nameProvinces(world, fresh);
  return fresh;
}

function dropEmptyProvinces(world: World) {
  const sizes = provinceSizes(world);
  for (const id of Object.keys(world.small.provinces).map(Number)) if (!sizes.has(id)) delete world.small.provinces[id];
}

// 湖与陆地省份的整理（第十二轮）：按现在的湖（推导里的湖面，见 lakeCells）把格放进对的省份——
//   湖单独成省：湖面的格不在湖省里的移出来，并进挨着的湖省或成新的湖省；湖省里已经不是湖的格（湖删了、干了、改小了）
//     并进挨着的陆地省；
//   湖并进陆地省：湖省里的格都并进挨着的陆地省（湖省没了）。
// 锁定的省份不动。省份编号、新省名与改动的格记进 ProvinceFix：引擎在推导算好之后调用它，并把结果记进命令，
// 重放时照着记下的改（不用推导）。什么都不用改时返回 null（世界不变）
export interface ProvinceFix {
  // 改了省份的格与它们的新省份（按格编号升序）
  cells: number[];
  to: number[];
  // 新建的省份（编号 → 信息，含名字）
  add: Record<string, ProvinceMeta>;
  // 删掉的（没有格了的）省份
  drop: number[];
  next: number;
}

export function lakeProvinceFix(world: World, d: Derived): ProvinceFix | null {
  const { causes, small } = world;
  const n = world.mesh.n;
  const province = causes.province;
  const separate = worldProvinceRules(small).lakeMode === 'separate';
  const lake = separate ? lakeCells(world, d) : null;
  const before = province.slice();
  const metasBefore = new Set(Object.keys(small.provinces));
  const pland = provinceLand(world);
  let moved = 0;
  for (let i = 0; i < n; i++) {
    const p = province[i];
    if (p < 0 || !pland[i]) continue;
    const meta = small.provinces[p];
    if (!meta || meta.locked) continue;
    const want: ProvinceClass = lake?.[i] ? 'lake' : 'land';
    if (classOfKind(meta.kind) !== want) {
      province[i] = -1;
      moved++;
    }
  }
  if (!moved) return null;
  const next0 = small.nextProvince;
  fillUnassigned(world, lake);
  dropEmptyProvinces(world);
  const fix: ProvinceFix = { cells: [], to: [], add: {}, drop: [], next: small.nextProvince };
  for (let i = 0; i < n; i++) {
    if (province[i] !== before[i]) {
      fix.cells.push(i);
      fix.to.push(province[i]);
    }
  }
  for (const [id, meta] of Object.entries(small.provinces)) if (Number(id) >= next0) fix.add[id] = { ...meta };
  for (const id of metasBefore) if (!small.provinces[Number(id)]) fix.drop.push(Number(id));
  return fix;
}

// 照着记下的整理改（重放、重做时）：与 lakeProvinceFix 当时的结果逐格相同
export function applyProvinceFix(world: World, fix: ProvinceFix) {
  const { causes, small } = world;
  for (const [id, meta] of Object.entries(fix.add)) small.provinces[Number(id)] = { ...meta };
  for (let k = 0; k < fix.cells.length; k++) causes.province[fix.cells[k]] = fix.to[k];
  for (const id of fix.drop) delete small.provinces[id];
  small.nextProvince = Math.max(small.nextProvince, fix.next);
}

// 一个省份拆成两半：取相距最远的两格为种子，按图距离各自生长
export function splitCells(world: World, cells: number[]): [number[], number[]] {
  const { mesh } = world;
  const set = new Set(cells);
  const within = (j: number) => set.has(j);
  const far = (from: number) => {
    const dist = ringDistance(mesh, [from], Infinity, within);
    let best = from;
    for (const c of cells) if (dist[c] > dist[best]) best = c;
    return best;
  };
  const a = far(cells[0]);
  const b = far(a);
  const { owner } = graphDistanceOwner(mesh, [a, b], Infinity, (_i, j, e) => (set.has(j) ? mesh.dist[e] : Infinity));
  const left: number[] = [];
  const right: number[] = [];
  for (const c of cells) (owner[c] === a ? left : right).push(c);
  return [left, right];
}

// 省份是否连通（编辑后检查用）
export function isConnected(world: World, cells: number[]): boolean {
  if (!cells.length) return true;
  const set = new Set(cells);
  const dist = ringDistance(world.mesh, [cells[0]], Infinity, (j) => set.has(j));
  return cells.every((c) => dist[c] >= 0);
}
