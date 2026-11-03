import { computeLook } from './biome-look';
import { ScriptSession, placementSlots, worldSeedOf } from './biome-scripts';
import { graphDistance } from './mesh';
import { LAKE_PREFIX, lakeBank } from './lake-types';
import { riverBank, riverProvider } from './river-types';
import { planetFormIssues } from './terrain';
import { type ScriptIssue, scriptsEnabled, worldInputs } from './script';
import { worldLatitude, type Derived, type World } from './world';
import { type Species, type Tolerance, speciesTolerances, trapezoid } from './species';

// 植被：每种类型的适宜度 = 各耐受曲线之积；得分 = 适宜度 × 竞争力 × 可达；
// 份额 ∝ 得分^k（k 为锐度），主导类型 = 份额最大者。
// 在一个格上 A、B 都能活时谁赢由竞争力和 k 决定，结果对用户透明（见 explainCell）。

export type FieldGetter = (i: number) => number;

export function fieldGetter(world: World, d: Derived, field: string): FieldGetter {
  if (field.startsWith('river:')) {
    // 河岸场（第三批）：离这种河多近，0–1。没有这种河时为 0
    const arr = riverBank(world, d, field.slice(6));
    return arr ? (i) => arr[i] : () => 0;
  }
  if (field.startsWith(LAKE_PREFIX)) {
    // 湖岸场（第九轮）：离这种湖多近，0–1。没有这种湖时为 0
    const arr = lakeBank(world, d, field.slice(LAKE_PREFIX.length));
    return arr ? (i) => arr[i] : () => 0;
  }
  if (field.startsWith('field:')) {
    const name = field.slice(6);
    const arr = world.causes.fields[name];
    const corr = d.corrF[name];
    if (!arr) return () => 0;
    return corr ? (i) => arr[i] + corr[i] : (i) => arr[i];
  }
  switch (field) {
    case 'tMean':
      return (i) => d.tMean[i];
    case 'tWarm':
      return (i) => d.tWarm[i];
    case 'tCold':
      return (i) => d.tCold[i];
    case 'precip':
      return (i) => d.precip[i];
    case 'moisture':
      return (i) => d.moisture[i];
    case 'seasonality':
      return (i) => d.seasonality[i];
    case 'elevation':
      return (i) => Math.max(0, d.elevation[i]);
    case 'slope':
      return (i) => d.slope[i];
    case 'discharge':
      return (i) => d.discharge[i];
    case 'wetness':
      return (i) => d.wetness[i];
    case 'continentality':
      return (i) => d.continentality[i];
    case 'lat':
      return (i) => Math.abs(worldLatitude(world, world.mesh.y[i]));
    default:
      return () => 0;
  }
}

// ---------- 第十二轮：长在哪里、自然生成 ----------

// 一块陆地（cell 所在、四邻相连的陆地格，湖也算陆地）。cell 不是陆地时为空
export function landmassCells(world: World, cell: number): Uint8Array {
  const { mesh } = world;
  const n = mesh.n;
  const land = world.causes.land;
  const out = new Uint8Array(n);
  if (cell < 0 || cell >= n || land[cell] !== 1) return out;
  const stack = [cell];
  out[cell] = 1;
  while (stack.length) {
    const i = stack.pop()!;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (!out[j] && land[j] === 1) {
        out[j] = 1;
        stack.push(j);
      }
    }
  }
  return out;
}

// 生态的范围（只在一个岛上：按现在的海陆重新认那块陆地；圈的格）。没有范围时为 null
export function rangeMask(world: World, sp: Pick<Species, 'range'>): Uint8Array | null {
  const r = sp.range;
  if (!r) return null;
  if (r.kind === 'island') return landmassCells(world, r.cell);
  const out = new Uint8Array(world.mesh.n);
  for (const c of r.cells) if (c < out.length) out[c] = 1;
  return out;
}

// 不自然生成的生态能长的格：涂了它的格（自然融入、强制都算）
export function paintedMask(world: World, id: string): Uint8Array {
  const out = new Uint8Array(world.mesh.n);
  for (const c of world.small.constraints) if (c.species === id) for (const i of c.cells) if (i < out.length) out[i] = 1;
  return out;
}

// 这种生态能长的格（范围 ∩ 不自然生成时涂过的格）；不受这两样限制时为 null
export function allowedCells(world: World, sp: Species): Uint8Array | null {
  const range = rangeMask(world, sp);
  if (sp.natural !== false) return range;
  const painted = paintedMask(world, sp.id);
  if (range) for (let i = 0; i < painted.length; i++) painted[i] &= range[i];
  return painted;
}

// 这一格为什么长不了这种生态（可达为 0 时）：范围外、没涂（不自然生成）、扩散不到
export function unreachableWhy(world: World, sp: Species, i: number): 'range' | 'natural' | 'dispersal' {
  const range = rangeMask(world, sp);
  if (range && !range[i]) return 'range';
  if (sp.natural === false && !paintedMask(world, sp.id)[i]) return 'natural';
  return 'dispersal';
}

export function isVegetated(world: World, d: Derived, i: number): boolean {
  return world.causes.land[i] === 1 && d.lake[i] !== 1;
}

// 侵占（第三批）：生态 s 在它侵占的目标适宜的地方得分 ×(1 + strength × 目标里最高的适宜度)。
// 每种生态的目标（下标，去掉自己和找不到的）与强度；没有生态侵占时为 null（走原来的算法）
export type InvadeTable = ({ targets: Int32Array; strength: number } | null)[];
export function invadeTable(species: readonly Species[]): InvadeTable | null {
  let any = false;
  const out = species.map((sp, s) => {
    const inv = sp.effects?.invade;
    if (!inv || !(inv.strength > 0)) return null;
    const targets = [...new Set(inv.targets.map((id) => species.findIndex((x) => x.id === id)))].filter((t) => t >= 0 && t !== s).sort((a, b) => a - b);
    if (!targets.length) return null;
    any = true;
    return { targets: Int32Array.from(targets), strength: inv.strength };
  });
  return any ? out : null;
}

// 生态 s 在格 i 的侵占倍数（不侵占的为 1）。suit 是 n × S 的适宜度
export function invadeBoost(table: InvadeTable, suit: ArrayLike<number>, S: number, i: number, s: number): number {
  const b = table[s];
  if (!b) return 1;
  let m = 0;
  for (let k = 0; k < b.targets.length; k++) {
    const v = suit[i * S + b.targets[k]];
    if (v > m) m = v;
  }
  return 1 + b.strength * m;
}

// 长在哪里的脚本的系数（第三批）：脚本没关掉、有生态带这种脚本时，对每个长植被的格运行，
// 写进 d.placeF（n × P，P 为带脚本的生态个数，见 placementSlots；不长植被的格为 1）。
// 脚本出错时这一段按没有脚本处理（系数 1），说明记进 issues。没有这种脚本时 placeF 为 undefined
function computePlacement(world: World, d: Derived, issues: ScriptIssue[], session: () => ScriptSession): { slot: Int32Array; P: number; placeF: Float32Array } | null {
  const species = world.small.species;
  const { slot, P } = scriptsEnabled() ? placementSlots(species) : { slot: null, P: 0 };
  if (!slot || P === 0) {
    // 赋 undefined 而不是 delete（对象的形状不变）；从来没有脚本的世界里根本没有这个键
    if (d.placeF !== undefined) d.placeF = undefined;
    return null;
  }
  const n = world.mesh.n;
  const placeF = d.placeF?.length === n * P ? d.placeF : new Float32Array(n * P);
  placeF.fill(1);
  const mask = new Uint8Array(n);
  const list: number[] = [];
  for (let i = 0; i < n; i++) {
    if (isVegetated(world, d, i)) {
      mask[i] = 1;
      list.push(i);
    }
  }
  const cells = Int32Array.from(list);
  const inputs = worldInputs(world, d, { river: riverProvider(world, d) });
  const seed = worldSeedOf(world);
  species.forEach((sp, s) => {
    const p = slot[s];
    if (p < 0) return;
    const r = session().run('placement', sp, sp.scripts!.placement!.src, inputs, cells, mask, seed);
    if (!r.ok) {
      issues.push(r.issue);
      return;
    }
    for (let j = 0; j < cells.length; j++) {
      const i = cells[j];
      placeF[i * P + p] = r.out[i];
    }
  });
  d.placeF = placeF;
  return { slot, P, placeF };
}

// 第五十五轮（提速）：一遍里要用的几块地方留着下一遍接着用，不每遍都新开（每遍约 2 MB，会提早引来垃圾回收）。一次只算一遍，算完没人再读
interface VegScratch {
  n: number;
  fields: Float64Array[];
  keep: Int32Array;
  val: Float64Array;
}
let scratch: VegScratch | null = null;
function scratchFor(n: number): VegScratch {
  if (scratch?.n !== n) scratch = { n, fields: [], keep: new Int32Array(n), val: new Float64Array(n) };
  return scratch;
}

// extraIssues：这一遍里别处出的脚本问题（河流、湖泊类型的 match 脚本，见 river-types.ts 的 typeRivers、lake-types.ts 的 typeLakes），排在星球形态的之后。
// look 为 false 时不算颜色脚本（引擎在不是最后一遍的那几遍里不算：之后的一遍会整个重算 d.look；最后再用 finishLook 补上）
export function computeVegetation(world: World, d: Derived, extraIssues: readonly ScriptIssue[] = [], opts: { look?: boolean } = {}) {
  const { mesh, small } = world;
  const n = mesh.n;
  const species = small.species;
  const S = species.length;
  if (d.share.length !== n * S) {
    d.share = new Float32Array(n * S);
    d.suit = new Float32Array(n * S);
    d.reach = new Uint8Array(n * S);
  }
  // 能长植被的格（陆地、不是湖）先算好
  const land = world.causes.land;
  const lake = d.lake;
  const veg = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) if ((veg[i] = land[i] === 1 && lake[i] !== 1 ? 1 : 0)) count++;
  const vegCells = new Int32Array(count);
  for (let i = 0, k = 0; i < n; i++) if (veg[i]) vegCells[k++] = i;
  // 每个用到的场在能长植被的格上的值，一个场一份（与逐格调用取值函数的值完全相同：双精度存下，不经过单精度）
  const values = new Map<string, Float64Array>();
  const tolerances = species.map(speciesTolerances);
  const pad = scratchFor(n);
  for (const tols of tolerances) {
    for (const t of tols) {
      if (values.has(t.field)) continue;
      // 只读能长植被的格（别的格是上一次留下的，没人读）
      const arr = (pad.fields[values.size] ??= new Float64Array(n));
      fillField(fieldGetter(world, d, t.field), vegCells, count, arr);
      values.set(t.field, arr);
    }
  }
  // 脚本出的问题（不挡操作：出错的脚本这一次按没有脚本处理）。星球形态的脚本的问题（地形那一步记下的）排在最前
  const issues: ScriptIssue[] = [...planetFormIssues(world, d.scriptIssues), ...extraIssues];
  // 长在哪里、颜色两种脚本共用一次运行（各输入与上次的差别只算一次，最后一起记下）；用到脚本时才开
  const run: { session?: ScriptSession } = {};
  const sessionOf = () => (run.session ??= new ScriptSession(world));
  const place = computePlacement(world, d, issues, sessionOf);

  const suit = d.suit;
  const reach = d.reach;
  const { keep, val } = pad;
  // 不长植被的格：适宜度 0、可达 1（下面只算长植被的格）
  suit.fill(0);
  reach.fill(1);
  for (let s = 0; s < S; s++) {
    const sp = species[s];
    const tols = tolerances[s];
    const K = tols.length;
    const fields = tols.map((t) => values.get(t.field)!);
    // 长在哪里的脚本：适宜度再乘上它的系数（没有脚本的生态 p 为 −1，与原来逐值相同）
    const p = place ? place.slot[s] : -1;
    const placeF = place ? place.placeF : null;
    const P = place ? place.P : 0;
    suitability(vegCells, count, tols, fields, K, p, placeF, P, suit, S, s, keep, val);
    if (sp.dispersal) {
      const disp = sp.dispersal;
      const limit = disp.range / world.kmPerUnit;
      const origins = disp.origins.filter((c) => c < n);
      const dist = graphDistance(mesh, origins, limit, (_i, j, e) => {
        const water = !veg[j];
        const poor = suit[j * S + s] < 0.2;
        return mesh.dist[e] * (water ? disp.seaCost : poor ? disp.gapCost : 1);
      });
      for (let i = 0; i < n; i++) reach[i * S + s] = dist[i] <= limit ? 1 : 0;
    }
    // 第十二轮：长在哪里（只在一个岛上 / 圈的范围里）、不自然生成（只长在涂了它的格里）。都没有时不碰 reach（逐值不变）
    const allowed = allowedCells(world, sp);
    if (allowed) for (let i = 0; i < n; i++) if (!allowed[i]) reach[i * S + s] = 0;
  }

  const k = small.planet.vegSharpness;
  // 侵占：所有适宜度都算好之后，按目标的适宜度提高得分（不回头影响适宜度，没有反馈）。没有生态侵占时走原来的算法
  const invade = invadeTable(species);
  const comp = Float64Array.from(species, (sp) => sp.competition);
  const share = d.share;
  const dominant = d.dominant;
  d.overridden.fill(0);
  vegShares(n, S, veg, suit, reach, comp, k, invade, share, dominant);
  // 第五十五轮：写了高度范围的世界不留下没有生态的陆地格（兜底）。一种都没写时不走这里，和以前逐值相同
  if (species.some((sp) => sp.height)) fillBare(mesh, species, veg, share, dominant);

  // 硬覆盖：直接改结果，标为例外
  for (const c of small.constraints) {
    if (c.mode !== 'override') continue;
    const s = species.findIndex((sp) => sp.id === c.species);
    if (s < 0) continue;
    for (const i of c.cells) {
      if (i >= n || !veg[i]) continue;
      for (let t = 0; t < S; t++) share[i * S + t] = t === s ? 1 : 0;
      dominant[i] = s;
      d.overridden[i] = 1;
    }
  }

  // 颜色脚本（第三批）：按最后的份额算每格的颜色，写进 d.look（没有颜色脚本时为 undefined）
  if (opts.look !== false) computeLook(world, d, issues, sessionOf);
  run.session?.finish();
  // 没有问题时为 undefined（与 placeF 一样只在曾经有过时才赋值：从来没有脚本的世界里没有这个键）
  if (issues.length) d.scriptIssues = issues;
  else if (d.scriptIssues !== undefined) d.scriptIssues = undefined;
}

// 第三十二轮（提速）：computeVegetation 里的几段逐格的循环拆成小函数（小函数里的循环很快就被编译优化；
// 写在大函数里时，前几次常常还没编译好就算完了），原样照搬，结果逐值相同
// 一个场在能长植被的格上的值
function fillField(get: FieldGetter, vegCells: Int32Array, count: number, arr: Float64Array) {
  for (let q = 0; q < count; q++) {
    const i = vegCells[q];
    arr[i] = get(i);
  }
}

// 一种生态在能长植被的格上的适宜度（耐受曲线相乘，再乘上长在哪里的脚本的系数）。
// 第五十五轮（提速：多了两种生态、十几条高度曲线）：一条曲线一遍，下一条只看上一条留下的格（多数格被年均温、湿度卡掉，算都不用算）；
// 适宜度是 0 的格不写（suit 算之前清成了 0）。曲线的先后、乘的先后和以前一样，结果逐值相同（biome-legacy.test.ts）。
// keep、val 是一次 computeVegetation 共用的两块地方（至少 count 长）
export function suitability(vegCells: Int32Array, count: number, tols: readonly Tolerance[], fields: Float64Array[], K: number, p: number, placeF: Float32Array | null, P: number, suit: Float32Array, S: number, s: number, keep: Int32Array, val: Float64Array) {
  if (K === 0) {
    for (let q = 0; q < count; q++) {
      const i = vegCells[q];
      suit[i * S + s] = p >= 0 ? placeF![i * P + p] : 1;
    }
    return;
  }
  val.fill(1, 0, count);
  let m = count;
  for (let k = 0; k < K && m > 0; k++) {
    const t = tols[k];
    m = narrow(k === 0 ? vegCells : keep, m, t.min, t.optLow, t.optHigh, t.max, fields[k], keep, val, suit, S, s);
  }
  for (let q = 0; q < m; q++) {
    const i = keep[q];
    suit[i * S + s] = p >= 0 ? val[q] * placeF![i * P + p] : val[q];
  }
}

// 乘上一条曲线（梯形，同 species.ts 的 trapezoid），留下还大于 0 的格
function narrow(cells: Int32Array, m: number, min: number, optLow: number, optHigh: number, max: number, field: Float64Array, keep: Int32Array, val: Float64Array, suit: Float32Array, S: number, s: number): number {
  const rise = optLow - min;
  const fall = max - optHigh;
  let out = 0;
  for (let q = 0; q < m; q++) {
    const i = cells[q];
    const x = field[i];
    if (x < min || x > max) continue;
    const f = x < optLow ? (rise === 0 ? 1 : (x - min) / rise) : x > optHigh ? (fall === 0 ? 1 : (max - x) / fall) : 1;
    const v = val[q] * f;
    if (v > 0) {
      keep[out] = i;
      val[out++] = v;
    } else if (v !== 0) {
      // 算不出数的曲线（不该有）：和以前一样记下这个数
      suit[i * S + s] = v;
    }
  }
  return out;
}

// 每格各生态的份额与主导生态（侵占：按目标的适宜度提高得分）。
// 第五十五轮（提速）：一格里只有几种生态的适宜度不是 0，只碰这几种（得分是 0 的份额就是 0，先整个清成 0），结果逐值相同
export function vegShares(n: number, S: number, veg: Uint8Array, suit: Float32Array, reach: Uint8Array, comp: Float64Array, k: number, invade: InvadeTable | null, share: Float32Array, dominant: Int16Array) {
  share.fill(0);
  const live = new Int32Array(S);
  for (let i = 0; i < n; i++) {
    if (!veg[i]) {
      dominant[i] = -1;
      continue;
    }
    const row = i * S;
    let total = 0;
    let best = -2;
    let bestScore = 0;
    let L = 0;
    for (let s = 0; s < S; s++) {
      const v = suit[row + s];
      if (v === 0) continue;
      const score = invade ? v * comp[s] * reach[row + s] * invadeBoost(invade, suit, S, i, s) : v * comp[s] * reach[row + s];
      if (!(score > 0)) continue;
      const w = Math.pow(score, k);
      share[row + s] = w;
      total += w;
      live[L++] = s;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    if (total > 0) for (let q = 0; q < L; q++) share[row + live[q]] /= total;
    dominant[i] = best;
  }
}

// 兜底：没有任何生态能长的陆地格（得分都是 0，dominant 是 −2），取最近的长着生态的格的那一种，份额 1。
// 一圈一圈往里填：一圈里每格看邻居（按邻接的先后）里第一个长着生态的，一圈填完再填下一圈，结果只取决于这一遍的 dominant。
// 只从哪里都能长的生态传出去（只长在某处、不自然生成的不传）。这种格通常只有几十个，只碰它们和它们的邻居。
// 四周没有能传的（小岛上全是这种格、隔着海）：再从全世界一圈一圈找过来（隔着海也找）；世界里没有这样的生态时留着 −2
function fillBare(mesh: World['mesh'], species: readonly Species[], veg: Uint8Array, share: Float32Array, dominant: Int16Array) {
  const n = mesh.n;
  const S = species.length;
  let left: number[] = [];
  for (let i = 0; i < n; i++) if (veg[i] && dominant[i] < 0) left.push(i);
  if (!left.length) return;
  const free = species.map((sp) => sp.natural !== false && !sp.range && !sp.dispersal);
  const { off, adj } = mesh;
  while (left.length) {
    const next: number[] = [];
    const got: number[] = [];
    for (const i of left) {
      let s = -1;
      for (let e = off[i]; e < off[i + 1] && s < 0; e++) {
        const t = dominant[adj[e]];
        if (t >= 0 && free[t]) s = t;
      }
      if (s < 0) next.push(i);
      else got.push(i, s);
    }
    if (!got.length) break;
    for (let k = 0; k < got.length; k += 2) {
      dominant[got[k]] = got[k + 1];
      share[got[k] * S + got[k + 1]] = 1;
    }
    left = next;
  }
  if (left.length) fillFar(mesh, free, veg, S, share, dominant, left.length);
}

// 隔着海的：每格离得最近的生态，从全世界长着生态的格一圈一圈传出去
function fillFar(mesh: World['mesh'], free: readonly boolean[], veg: Uint8Array, S: number, share: Float32Array, dominant: Int16Array, count: number) {
  const n = mesh.n;
  const near = new Int16Array(n).fill(-1);
  let front: number[] = [];
  for (let i = 0; i < n; i++) {
    if (dominant[i] >= 0 && free[dominant[i]]) {
      near[i] = dominant[i];
      front.push(i);
    }
  }
  let left = count;
  while (front.length && left > 0) {
    const next: number[] = [];
    for (const i of front) {
      const s = near[i];
      for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
        const j = mesh.adj[e];
        if (near[j] >= 0) continue;
        near[j] = s;
        next.push(j);
        if (veg[j] && dominant[j] < 0) {
          dominant[j] = s;
          share[j * S + s] = 1;
          left--;
        }
      }
    }
    front = next;
  }
}

// 第十二轮：不计水体类型的一遍植被的主导生态（河、湖类型“只在这些生态里出现”、脚本里的 biome() 用它）。
// 在 d 的一份浅副本上算（河岸、湖岸场都当作没有），不改 d；结果只取决于这一遍的气候、水文，重放、撤销都一样
export function baseBiomes(world: World, d: Derived): Int16Array {
  const n = world.mesh.n;
  const S = world.small.species.length;
  const tmp: Derived = {
    ...d,
    riverType: undefined,
    lakeType: undefined,
    share: new Float32Array(n * S),
    suit: new Float32Array(n * S),
    reach: new Uint8Array(n * S),
    dominant: new Int16Array(n).fill(-1),
    overridden: new Uint8Array(n),
    placeF: undefined,
    look: undefined,
    scriptIssues: undefined,
  };
  computeVegetation(world, tmp, [], { look: false });
  return tmp.dominant;
}

// 不算颜色脚本的那一遍（computeVegetation 的 look 为 false）之后补上颜色：与那一遍里直接算逐值相同
// （颜色脚本的问题排在最后，接在那一遍记下的问题之后）
export function finishLook(world: World, d: Derived) {
  const issues: ScriptIssue[] = d.scriptIssues ? [...d.scriptIssues] : [];
  const before = issues.length;
  const run: { session?: ScriptSession } = {};
  computeLook(world, d, issues, () => (run.session ??= new ScriptSession(world)));
  run.session?.finish();
  if (issues.length !== before) d.scriptIssues = issues;
}

export interface CellExplanation {
  species: string;
  name: string;
  // 适宜度（已经乘上了长在哪里的脚本的系数）
  suitability: number;
  competition: number;
  reachable: boolean;
  score: number;
  share: number;
  // 每条耐受曲线的取值与因子，便于看出谁卡住了
  factors: { field: string; value: number; factor: number; range: [number, number, number, number] }[];
  // 长在哪里的脚本在这一格的系数：引擎算好存着的，与适宜度里乘上的是同一个数（这种生态没有脚本时没有这一项）
  placement?: number;
  // 侵占的倍数（这种生态不侵占别的生态时没有这一项）
  boost?: number;
  // 长不了的原因（可达为 0 时）：范围外、不自然生成又没涂、扩散不到
  why?: 'range' | 'natural' | 'dispersal';
}

export function explainCell(world: World, d: Derived, i: number): CellExplanation[] {
  const species = world.small.species;
  const S = species.length;
  const n = world.mesh.n;
  // 只读引擎存着的结果：主线程不运行脚本
  const { slot, P } = placementSlots(species);
  const placeF = P > 0 && d.placeF?.length === n * P ? d.placeF : null;
  const invade = invadeTable(species);
  return species
    .map((sp, s) => {
      const factors = speciesTolerances(sp).map((t) => {
        const value = fieldGetter(world, d, t.field)(i);
        return { field: t.field, value, factor: trapezoid(t, value), range: [t.min, t.optLow, t.optHigh, t.max] as [number, number, number, number] };
      });
      const suit = d.suit[i * S + s] ?? 0;
      const reachable = (d.reach[i * S + s] ?? 1) === 1;
      const boost = invade?.[s] ? invadeBoost(invade, d.suit, S, i, s) : undefined;
      const out: CellExplanation = {
        species: sp.id,
        name: sp.name || sp.id,
        suitability: suit,
        competition: sp.competition,
        reachable,
        score: suit * sp.competition * (reachable ? 1 : 0) * (boost ?? 1),
        share: d.share[i * S + s] ?? 0,
        factors,
      };
      if (placeF && slot[s] >= 0) out.placement = placeF[i * P + slot[s]];
      if (boost !== undefined) out.boost = boost;
      if (!reachable) out.why = unreachableWhy(world, sp, i);
      return out;
    })
    .sort((a, b) => b.score - a.score);
}
