import { z } from 'zod';
import { graphDistanceOwner, ringDistance } from './mesh';
import { DEFAULT_PACK, generateName, hashString } from './names';
import { mixSeed, mulberry32 } from './rng';
import type { Derived, World } from './world';

// 省份 = 格的聚类。自动划分用加权区域生长：跨河、跨山脊代价高，所以边界自然贴着河与山脊；不跨海岸。
// 规则可配置：大小（小 · 中 · 大）、按地形调整大小、无人区、湖省、近海小远洋大。
// 划分结果是“原因”的一部分（用户可编辑）：
//   · 默认固定种子，“换一种划分”才换；
//   · 重新划分一片只动这一片，别处的省份编号与名字不变；
//   · 陆海变化后由 repairProvinces 就近修补，不会整体重算抹掉手工修改。

export const PROVINCE_KINDS = ['land', 'wasteland', 'lake', 'sea'] as const;
export type ProvinceKind = (typeof PROVINCE_KINDS)[number];
export const PROVINCE_KIND_INFO: Record<ProvinceKind, { name: string; hint: string }> = {
  land: { name: '陆地', hint: '普通的陆地省份' },
  wasteland: { name: '无人区', hint: '冰原、深漠、高山：游戏里通常不能进入' },
  lake: { name: '湖', hint: '大湖单独成省' },
  sea: { name: '海域', hint: '海上的省份' },
};

const ruleFields = {
  size: z.enum(['small', 'medium', 'large']),
  // 按地形调整大小：平原、河谷、海岸省份小，山地、荒漠大
  varied: z.boolean(),
  // 冰原、深漠、高山合成大片无人区
  wasteland: z.boolean(),
  // 大湖单独成省
  lakes: z.boolean(),
  // 近海海域小、远洋海域大
  seaByDistance: z.boolean(),
  riverCost: z.number().min(0).max(20),
  ridgeCost: z.number().min(0).max(20),
  seed: z.number().int().min(0),
};
export const provinceRulesSchema = z.object({
  size: ruleFields.size.default('medium'),
  varied: ruleFields.varied.default(true),
  wasteland: ruleFields.wasteland.default(true),
  lakes: ruleFields.lakes.default(true),
  seaByDistance: ruleFields.seaByDistance.default(true),
  riverCost: ruleFields.riverCost.default(4),
  ridgeCost: ruleFields.ridgeCost.default(2),
  seed: ruleFields.seed.default(1),
});
// 命令里的规则补丁：只含给出的项（zod 4 的 partial 会给带默认值的项补上默认值，盖掉原来的规则）
export const provinceRulesPatchSchema = z.object(ruleFields).partial();
export type ProvinceRules = z.output<typeof provinceRulesSchema>;
export const DEFAULT_PROVINCE_RULES: ProvinceRules = provinceRulesSchema.parse({});

const SIZE_CELLS = { small: 20, medium: 40, large: 80 } as const;

// 目标大小（格数）：按 4 万格标定，格数不同时等比缩放，所以省份的个数与网格精细度无关。
// 整个星球不缩放：“中”约 40 格（类地星球约 20 万 km²，一个星球约七百个陆地省）
export function provinceTargets(world: World, rules: ProvinceRules): { land: number; sea: number } {
  const base = SIZE_CELLS[rules.size] * (world.mesh.kind === 'sphere' ? 1 : world.mesh.n / 40000);
  return { land: Math.max(3, base), sea: Math.max(6, base * (rules.seaByDistance ? 2 : 4)) };
}

// 格的类别：0 海，1 陆地，2 无人区，3 湖。省份只在同类格里生长
const SEA = 0;
const LAND = 1;
const WASTE = 2;
const LAKE = 3;
const KIND_OF_CLASS: ProvinceKind[] = ['sea', 'land', 'wasteland', 'lake'];

function components(world: World, mask: (i: number) => boolean): number[][] {
  const { mesh } = world;
  const seen = new Uint8Array(mesh.n);
  const out: number[][] = [];
  for (let i = 0; i < mesh.n; i++) {
    if (seen[i] || !mask(i)) continue;
    const q = [i];
    seen[i] = 1;
    for (let h = 0; h < q.length; h++) {
      for (let e = mesh.off[q[h]]; e < mesh.off[q[h] + 1]; e++) {
        const j = mesh.adj[e];
        if (!seen[j] && mask(j)) {
          seen[j] = 1;
          q.push(j);
        }
      }
    }
    out.push(q);
  }
  return out;
}

export function cellClasses(world: World, d: Derived, rules: ProvinceRules): Uint8Array {
  const { mesh, causes } = world;
  const n = mesh.n;
  const cls = new Uint8Array(n);
  for (let i = 0; i < n; i++) cls[i] = causes.land[i] ? LAND : SEA;
  const target = provinceTargets(world, rules);
  if (rules.lakes) {
    for (const comp of components(world, (i) => causes.land[i] === 1 && d.lake[i] === 1)) if (comp.length >= 3) for (const c of comp) cls[c] = LAKE;
  }
  if (rules.wasteland) {
    const waste = (i: number) => cls[i] === LAND && (d.tWarm[i] < 0 || d.moisture[i] < 0.06 || d.elevation[i] > 3500);
    for (const comp of components(world, waste)) if (comp.length >= target.land * 0.6) for (const c of comp) cls[c] = WASTE;
  }
  return cls;
}

// 每格的“疏密系数”：省份目标大小的倍数
function densityFactors(world: World, d: Derived, rules: ProvinceRules, cls: Uint8Array): Float32Array {
  const { mesh, causes, small } = world;
  const n = mesh.n;
  const f = new Float32Array(n).fill(1);
  const thr = small.planet.riverThreshold;
  let coastDist: Int32Array | null = null;
  if (rules.seaByDistance) {
    const coast: number[] = [];
    for (let i = 0; i < n; i++) {
      if (causes.land[i]) continue;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        if (causes.land[mesh.adj[e]]) {
          coast.push(i);
          break;
        }
      }
    }
    coastDist = ringDistance(mesh, coast, Infinity, (j) => !causes.land[j]);
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
        for (let e = mesh.off[i]; e < mesh.off[i + 1] && !coastal; e++) if (!causes.land[mesh.adj[e]]) coastal = true;
        const fertile = coastal || d.discharge[i] >= thr * 3 || (d.elevation[i] < 300 && d.moisture[i] > 0.5);
        if (d.elevation[i] > 1500 || d.slope[i] > 20) f[i] = 1.6;
        else if (d.moisture[i] < 0.25 || d.tMean[i] < -2) f[i] = 1.8;
        else if (fertile) f[i] = 0.6;
      }
    }
  }
  return f;
}

// 在 region 里的格上重新划分（region 外的省份不动），新省份用新编号；返回新省份的编号
function partition(world: World, d: Derived, rules: ProvinceRules, region: Uint8Array, salt: number): number[] {
  const { mesh, causes, small } = world;
  const n = mesh.n;
  const province = causes.province;
  const cls = cellClasses(world, d, rules);
  const dens = densityFactors(world, d, rules, cls);
  const target = provinceTargets(world, rules);
  const baseOf = (i: number) => (cls[i] === SEA ? target.sea : target.land);
  const rand = mulberry32(mixSeed(rules.seed, 401, salt));
  const riverQ = small.planet.riverThreshold;

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
          if (stamp[j] === seeds.length || !region[j] || cls[j] !== cls[s]) continue;
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
    if (!region[j] || cls[i] !== cls[j]) return Infinity;
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
    small.provinces[id] = { name: '', locked: false, land: causes.land[s] === 1, kind: KIND_OF_CLASS[cls[s]] };
    fresh.push(id);
  }
  for (let i = 0; i < n; i++) if (region[i]) province[i] = owner[i] >= 0 ? seedToProvince.get(owner[i])! : -1;

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
    const border = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      if (province[i] !== id) continue;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const p = province[mesh.adj[e]];
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
    for (let i = 0; i < n; i++) if (province[i] === id) province[i] = best;
    sizes.set(best, (sizes.get(best) ?? 0) + size);
    sizes.delete(id);
    delete small.provinces[id];
    freshSet.delete(id);
  }
  const before = small.nextProvince;
  fillUnassigned(world);
  for (let id = before; id < small.nextProvince; id++) if (small.provinces[id]) freshSet.add(id);
  const out = [...freshSet].filter((id) => small.provinces[id]).sort((a, b) => a - b);
  nameProvinces(world, out);
  return out;
}

// 整体自动划分。锁定的省份保持不动
export function generateProvinces(world: World, d: Derived, rules: ProvinceRules) {
  const { mesh, causes, small } = world;
  small.provinceRules = rules;
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
  partition(world, d, rules, region, 0);
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

// 只重新划分这些省份占的地方；新省份用新编号，别处不变
export function regenerateProvinces(world: World, d: Derived, ids: number[]): number[] {
  const { mesh, causes, small } = world;
  const set = new Set(ids);
  const region = new Uint8Array(mesh.n);
  for (let i = 0; i < mesh.n; i++) if (set.has(causes.province[i])) region[i] = 1;
  for (const id of ids) delete small.provinces[id];
  // 用当前的下一个编号做盐：同样的操作重放结果相同，再做一次又是新的划分
  return partition(world, d, small.provinceRules, region, small.nextProvince + 1);
}

export function provinceSizes(world: World): Map<number, number> {
  const sizes = new Map<number, number>();
  for (const p of world.causes.province) if (p >= 0) sizes.set(p, (sizes.get(p) ?? 0) + 1);
  return sizes;
}

// 未归属的格：先就近并入同类、未锁定且不太大的相邻省份，剩下的成片区域各自生长为新省份
export function fillUnassigned(world: World) {
  const { mesh, causes, small } = world;
  const n = mesh.n;
  const province = causes.province;
  const sizes = provinceSizes(world);
  const targets = provinceTargets(world, small.provinceRules);
  const target = (land: boolean) => (land ? targets.land : targets.sea);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < n; i++) {
      if (province[i] >= 0) continue;
      const land = causes.land[i] === 1;
      let best = -1;
      let bestSize = Infinity;
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const p = province[mesh.adj[e]];
        if (p < 0) continue;
        const meta = small.provinces[p];
        if (!meta || meta.locked || meta.land !== land) continue;
        const sz = sizes.get(p) ?? 0;
        if (sz < target(land) * 1.5 && sz < bestSize) {
          best = p;
          bestSize = sz;
        }
      }
      if (best >= 0) {
        province[i] = best;
        sizes.set(best, bestSize + 1);
        changed = true;
      }
    }
  }
  // 剩余成片区域：按目标大小切成新省份
  for (let i = 0; i < n; i++) {
    if (province[i] >= 0) continue;
    const land = causes.land[i] === 1;
    const id = small.nextProvince++;
    small.provinces[id] = { name: '', locked: false, land, kind: land ? 'land' : 'sea' };
    const queue = [i];
    province[i] = id;
    let count = 1;
    for (let h = 0; h < queue.length && count < target(land); h++) {
      const c = queue[h];
      for (let e = mesh.off[c]; e < mesh.off[c + 1] && count < target(land); e++) {
        const j = mesh.adj[e];
        if (province[j] < 0 && (causes.land[j] === 1) === land) {
          province[j] = id;
          queue.push(j);
          count++;
        }
      }
    }
    // 格都划好之后再起名，名字才能按省内地形取字
    nameNewProvince(world, id);
  }
}

// 陆海改变后：类别不符的格移出原省份，再修补
export function repairProvinces(world: World) {
  const { causes, small } = world;
  for (let i = 0; i < causes.province.length; i++) {
    const p = causes.province[i];
    if (p < 0) continue;
    const meta = small.provinces[p];
    if (!meta || meta.land !== (causes.land[i] === 1)) causes.province[i] = -1;
  }
  fillUnassigned(world);
  // 删除已经没有格的省份
  const sizes = provinceSizes(world);
  for (const id of Object.keys(small.provinces).map(Number)) if (!sizes.has(id)) delete small.provinces[id];
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

// 省份名来自文字包：按省内的地形取字（沿海、沿河、山地、干旱、寒冷；海域、无人区、湖另有模板）
function provinceTags(world: World, cells: number[], kind: ProvinceKind): string[] {
  if (kind === 'sea') return ['sea'];
  const { mesh, causes, derived: d, small } = world;
  const thr = small.planet.riverThreshold;
  let coastal = false;
  let river = false;
  let h = 0;
  let m = 0;
  let t = 0;
  for (const c of cells) {
    for (let e = mesh.off[c]; e < mesh.off[c + 1] && !coastal; e++) if (!causes.land[mesh.adj[e]]) coastal = true;
    if (d.discharge[c] >= thr * 3) river = true;
    h += Math.max(0, d.elevation[c]);
    m += Math.min(4, d.moisture[c]);
    t += d.tMean[c];
  }
  const k = Math.max(1, cells.length);
  const tags: string[] = kind === 'wasteland' ? ['waste'] : [];
  if (coastal && kind === 'land') tags.push('coastal');
  if (river && kind === 'land') tags.push('river');
  if (h / k > 1500) tags.push('mountain');
  if (m / k < 0.35) tags.push('dry');
  if (t / k < 0) tags.push('cold');
  return tags;
}

function provinceName(world: World, id: number, cells: number[], kind: ProvinceKind, taken: Set<string>): string {
  const seed = world.small.terrain.gen?.seed ?? world.settings.seed;
  const pack = world.small.wordPack ?? DEFAULT_PACK;
  const tags = provinceTags(world, cells, kind);
  // 湖省用湖的命名模板
  const type = kind === 'lake' && pack.types.lake ? 'lake' : 'province';
  return generateName(pack, type, tags, hashString(`${seed}:province:${id}`), taken);
}

function cellsByProvince(world: World): Map<number, number[]> {
  const m = new Map<number, number[]>();
  const p = world.causes.province;
  for (let i = 0; i < p.length; i++) {
    if (p[i] < 0) continue;
    const l = m.get(p[i]) ?? [];
    l.push(i);
    m.set(p[i], l);
  }
  return m;
}

function nameProvinces(world: World, ids: number[]) {
  const byId = cellsByProvince(world);
  const taken = new Set(Object.values(world.small.provinces).map((p) => p.name).filter(Boolean));
  for (const id of ids) {
    const meta = world.small.provinces[id];
    if (!meta || meta.name) continue;
    meta.name = provinceName(world, id, byId.get(id) ?? [], meta.kind, taken);
  }
}

export function nameNewProvince(world: World, id: number) {
  const meta = world.small.provinces[id];
  if (!meta || meta.name) return;
  const cells: number[] = [];
  for (let i = 0; i < world.causes.province.length; i++) if (world.causes.province[i] === id) cells.push(i);
  const taken = new Set(Object.values(world.small.provinces).map((p) => p.name).filter(Boolean));
  meta.name = provinceName(world, id, cells, meta.kind, taken);
}

export interface ProvinceSummary {
  id: number;
  name: string;
  land: boolean;
  kind: ProvinceKind;
  locked: boolean;
  cells: number;
  // 主导类型（按格数）与 Paradox 地形
  species: string | null;
  terrain: string;
  meanElevation: number;
}

// 省份地形：格内主导类型的多数；山地、丘陵按海拔与坡度另判；无人区、湖、海各有类别
export function summarizeProvinces(world: World, d: Derived): Map<number, ProvinceSummary> {
  const { mesh, causes, small } = world;
  const out = new Map<number, ProvinceSummary>();
  const counts = new Map<number, Map<number, number>>();
  const elev = new Map<number, number>();
  const slope = new Map<number, number>();
  for (let i = 0; i < mesh.n; i++) {
    const p = causes.province[i];
    if (p < 0) continue;
    let m = counts.get(p);
    if (!m) counts.set(p, (m = new Map()));
    m.set(d.dominant[i], (m.get(d.dominant[i]) ?? 0) + 1);
    elev.set(p, (elev.get(p) ?? 0) + Math.max(0, d.elevation[i]));
    slope.set(p, (slope.get(p) ?? 0) + d.slope[i]);
  }
  for (const [p, m] of counts) {
    const meta = small.provinces[p] ?? { name: '', locked: false, land: false, kind: 'sea' as const };
    let total = 0;
    let best = -1;
    let bc = -1;
    for (const [s, c] of m) {
      total += c;
      if (s >= 0 && c > bc) {
        bc = c;
        best = s;
      }
    }
    const meanE = (elev.get(p) ?? 0) / total;
    const meanS = (slope.get(p) ?? 0) / total;
    const sp = best >= 0 ? small.species[best] : null;
    let terrain = meta.land ? (sp?.terrain ?? 'plains') : 'ocean';
    if (meta.kind === 'lake') terrain = 'lake';
    else if (meta.kind === 'wasteland') terrain = 'wasteland';
    else if (meta.land && (meanE > 2200 || meanS > 25)) terrain = 'mountains';
    else if (meta.land && (meanE > 900 || meanS > 12) && terrain !== 'arctic') terrain = 'hills';
    out.set(p, { id: p, name: meta.name, land: meta.land, kind: meta.kind, locked: meta.locked, cells: total, species: sp?.id ?? null, terrain, meanElevation: meanE });
  }
  return out;
}
