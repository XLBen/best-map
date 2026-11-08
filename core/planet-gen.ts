import { type BaseComponents, type Resample, type WorldgenInput, copyComponents, worldgenSchema } from './generate';
import type { SphereMesh } from './mesh';
import { type PlanetForm } from './planet-form';
import { clamp, fbm3, mixSeed, mulberry32 } from './rng';
import { type ScriptIssue, runSetup, scriptsEnabled } from './script';
import { tangentBasis, toUnit } from './sphere';
import { LAYOUT_R, LAYOUT_AREA, type V3, profileOf, resolvedPlanetParams, tuningOf, type Plate, type Block, type SutureLine, type SwellSpot, type PlanetCone, noiseSet3, type PlanetModel, range, irange, dot, cross, scale, add, len, unit, randomPoint, tangentAt, walk, makeBlock, DEG, warp } from './planet-gen-model';
import { buildRifts, buildIsthmi } from './planet-gen-rifts';
import { blockField, power, type PlateInfo, pairInfo } from './planet-gen-sample';
import { emptyComponents, placed, rerollDist, sampleCell, sampleWithCrust } from './planet-gen-crust';
export { LAYOUT_R, planetProfile, resolvedPlanetParams } from './planet-gen-model';
export type { PlanetProfile, Rift, Isthmus, PlanetCone, PlanetModel } from './planet-gen-model';
export { warpedAtPlanet, isthmusNearPlanet, riftFramesPlanet } from './planet-gen-rifts';

// 整个星球的世界生成：与 generate.ts 同一套“地壳高度 + 海平面”的做法，搬到球面上。
//   · 布局坐标 Q = 单位向量 × 2/π（球半径 ρ = 2/π）。这样 10 万格星球的格距和 4 万格的地区地图几乎一样，
//     generate.ts 里按“每格”调好的宽度、频率、阈值都照用；布局与星球大小无关（大小只影响 km）
//   · 噪声是三维的，在球面上取值：没有东西接缝，两极也不会被拉伸
//   · 板块绕各自的欧拉轴转动，速度 v = ω × Q；距离一律用弦长
//   · 所有随机都在建模型时一次取好，每格的值只取决于它在球面上的位置，所以缩略图与成品格局一致

export function buildPlanetModel(input: WorldgenInput): PlanetModel {
  const params = resolvedPlanetParams(worldgenSchema.parse(input));
  const form = params.form;
  const profile = profileOf(params);
  const seed = params.seed;
  const noise = noiseSet3(seed, 0);

  const randP = mulberry32(mixSeed(seed, 101, 0x3d));
  const plates: Plate[] = [];
  const plateCount = irange(randP, profile.plates);
  for (let k = 0; k < plateCount; k++) {
    const c = randomPoint(randP);
    const nc = unit(c);
    // 欧拉轴不要离板块中心太近（否则板块原地打转）
    let axis = unit(randomPoint(randP));
    for (let t = 0; t < 20 && Math.abs(dot(axis, nc)) > Math.cos((25 * Math.PI) / 180); t++) axis = unit(randomPoint(randP));
    const sp = 0.35 + 0.65 * randP();
    const sinA = Math.sqrt(Math.max(1e-6, 1 - dot(axis, nc) ** 2));
    plates.push({ c, w: scale(axis, sp / (LAYOUT_R * sinA)), weight: randP() * 0.03, density: randP(), sib: -1 });
  }

  const randB = mulberry32(mixSeed(seed, 102, 0x3d));
  const blocks: Block[] = [];
  if (profile.ring) {
    // 环形大陆：围着一个随机中心，环抱一片内海
    const c0 = randomPoint(randB);
    const ringR = 0.45 + 0.05 * randB();
    const count = irange(randB, profile.blocks);
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2 + randB() * 0.5;
      const { p, t } = walk(c0, tangentAt(c0, a), ringR);
      blocks.push(makeBlock(p, t, range(randB, profile.radius), 1 + 0.5 * randB()));
    }
  } else {
    const count = irange(randB, profile.blocks);
    const radii: number[] = [];
    if (profile.main) radii.push(range(randB, profile.main));
    for (let k = 0; k < count; k++) radii.push(range(randB, profile.radius));
    let area = 0;
    for (const r of radii) area += Math.PI * r * r;
    const sc = Math.min(1.6, Math.max(0.75, Math.sqrt((profile.landFraction * LAYOUT_AREA * 1.8) / Math.max(area, 1e-9))));
    radii.forEach((r0, k) => {
      const r = r0 * sc;
      let best: V3 = randomPoint(randB);
      let bestScore = -Infinity;
      for (let t = 0; t < 16; t++) {
        const c = randomPoint(randB);
        let score: number;
        if (profile.attach && k > 0 && blocks.length) {
          // 贴在主块的边上：离主块边缘越近越好
          const main = blocks[0];
          score = -Math.abs(len(add(c, scale(main.c, -1))) - (main.r * 0.9 + r * 0.5));
        } else {
          let near = 1;
          for (const b of blocks) near = Math.min(near, len(add(c, scale(b.c, -1))) - 1.25 * (r + b.r));
          score = near;
        }
        score += randB() * 0.03;
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      const e = profile.main && k === 0 ? 1 + 0.35 * randB() : 1 + (r < 0.12 ? 0.3 : 0.6) * randB();
      blocks.push(makeBlock(best, tangentAt(best, randB() * Math.PI), r, e));
    });
  }
  // 星球形态的布局脚本：在配方的大陆块之后、半岛之前运行，可以加大陆块、加岛，或者清空原来的
  const issues: ScriptIssue[] | undefined = form ? [] : undefined;
  // 第三十五轮：只裂配方原来的块（布局脚本加的块不裂）
  const profileBlocks = new Set(blocks);
  const setup = form && issues ? formSetup(form, seed, blocks, issues) : null;
  if (setup) blocks.splice(0, blocks.length, ...setup.blocks);
  const meanR = blocks.length ? blocks.reduce((s, b) => s + b.r, 0) / blocks.length : 0.2;
  // 半岛：大陆块沿大圆向外伸出的狭长瓣
  const randL = mulberry32(mixSeed(seed, 104, 0x3d));
  // 第三十五轮：四成的半岛是三角形（另一串随机数）
  const randT = mulberry32(mixSeed(seed, 107, 0x3d));
  const parents = blocks.slice();
  for (const b of parents) {
    if (b.r < 0.12) continue;
    if (setup?.noLobes.has(b)) continue;
    const lobes = 1 + Math.floor(randL() * 3);
    for (let k = 0; k < lobes; k++) {
      const a = randL() * Math.PI * 2;
      const dist = b.r * (0.75 + 0.35 * randL());
      const lr = b.r * (0.22 + 0.22 * randL());
      const e = 1.8 + 1.4 * randL();
      const { p, t } = walk(b.c, tangentAt(b.c, a), dist);
      const tri = randT() < 0.4 ? 0.7 + 0.2 * randT() : 0;
      blocks.push({ ...makeBlock(p, t, lr, e), fam: parents.indexOf(b), tri });
    }
  }
  parents.forEach((b, k) => (b.fam = k));
  // 第三十二轮：块内的老缝合线（较大的块里 0–1 条）、带陡崖的穹隆（另一串随机数，前面的格局不变）
  const randS = mulberry32(mixSeed(seed, 105, 0x3d));
  const sutures: SutureLine[] = [];
  parents.forEach((b, k) => {
    if (b.r < 0.15 || randS() < 0.4) return;
    const a = randS() * Math.PI;
    sutures.push({ block: k, cos: Math.cos(a), sin: Math.sin(a), off: (randS() - 0.5) * 0.8 });
  });
  const swells: SwellSpot[] = [];
  const bigOnes = parents.filter((b) => b.r >= 0.1);
  const swellCount = bigOnes.length ? 2 + Math.floor(randS() * Math.min(5, 1 + bigOnes.length / 2)) : 0;
  for (let k = 0; k < swellCount; k++) {
    const b = bigOnes[Math.floor(randS() * bigOnes.length)];
    const { p } = walk(b.c, tangentAt(b.c, randS() * Math.PI * 2), b.r * 0.6 * Math.sqrt(randS()));
    swells.push({ c: p, r: 0.06 + 0.07 * randS(), h: 700 + 700 * randS() });
  }

  const model: PlanetModel = {
    kind: 'planet',
    params,
    profile,
    plates,
    blocks,
    meanR,
    cones: [],
    noise,
    variants: new Map(),
    tuning: tuningOf(form),
    replace: form?.crustMode === 'replace' && form.scripts?.crust !== undefined,
    fixedCones: 0,
    issues,
    sutures,
    swells,
    rifts: [],
    famRift: parents.map(() => -1),
    isthmi: [],
  };
  // 第三十五轮：裂开、漂移的大陆块（板块跟着碎块走）、块与块之间的地峡（各自另一串随机数）
  buildRifts(model, parents, profileBlocks, mulberry32(mixSeed(seed, 106, 0x3d)));
  buildIsthmi(model, parents, mulberry32(mixSeed(seed, 108, 0x3d)));
  // 布局脚本加的岛排在最前（rank −1），clearIslands() 之后不要原来的火山锥
  const natural = setup && !setup.natural ? [] : buildCones(model);
  model.cones = setup && setup.islands.length ? [...setup.islands, ...natural] : natural;
  model.fixedCones = setup ? setup.islands.length : 0;
  return model;
}

// ---------- 星球形态的布局脚本 ----------

// 布局脚本最多加到这么多大陆块、这么多岛（防止写错的循环把模型撑得很大、每格都要算很久）
const MAX_FORM_BLOCKS = 120;
const MAX_FORM_ISLANDS = 300;

interface SetupOutcome {
  // 运行之后的大陆块（含配方原来的、脚本加的）
  blocks: Block[];
  // 脚本说了 lobes: false 的块：不长半岛
  noLobes: Set<Block>;
  islands: PlanetCone[];
  // false：脚本调用了 clearIslands()，不要原来的火山锥
  natural: boolean;
}

// 经纬度（度）→ 布局坐标
function latLonPoint(lat: number, lon: number): V3 {
  return scale(toUnit(lon / 180 + 1, (90 - lat) / 180), LAYOUT_R);
}

// 布局脚本里 addBlock、addIsland 收的对象的各项（英文名、中文名都能用），编辑器的“变量和例子”也用这张表
export interface SetupField {
  key: string;
  zh: string;
  label: string;
  unit?: string;
  // 数值的范围与省略时的值；lo 为 undefined 的是 true / false
  lo?: number;
  hi?: number;
  def?: number | boolean;
}
const SETUP_FIELDS: Record<'addBlock' | 'addIsland', readonly SetupField[]> = {
  addBlock: [
    { key: 'lat', zh: '纬度', label: '中心的纬度（北纬为正）', unit: '°', lo: -90, hi: 90 },
    { key: 'lon', zh: '经度', label: '中心的经度（东经为正）', unit: '°', lo: -1e6, hi: 1e6 },
    { key: 'size', zh: '大小', label: '半径（从球心看的角度；30 约是一个大洲）', unit: '°', lo: 1, hi: 90 },
    { key: 'stretch', zh: '拉长', label: '长轴是短轴的几倍（1 是圆的）', lo: 1, hi: 5, def: 1 },
    { key: 'angle', zh: '方向', label: '长轴的方向（0 东西向，90 南北向）', unit: '°', lo: -1e6, hi: 1e6, def: 0 },
    { key: 'lobes', zh: '半岛', label: '长不长半岛（true / false）', def: true },
  ],
  addIsland: [
    { key: 'lat', zh: '纬度', label: '纬度（北纬为正）', unit: '°', lo: -90, hi: 90 },
    { key: 'lon', zh: '经度', label: '经度（东经为正）', unit: '°', lo: -1e6, hi: 1e6 },
    { key: 'height', zh: '高度', label: '火山从海底起的高度（深海里要超过约 4000 才露出海面）', unit: 'm', lo: 100, hi: 7000, def: 5000 },
    { key: 'size', zh: '大小', label: '半径（从球心看的角度）', unit: '°', lo: 0.2, hi: 10, def: 1.5 },
  ],
};

// 脚本传进来的对象：每项只读一次，读到的值复制下来再检查；不对时抛出中文说明（整段脚本按出错处理，行号是调用的那一行）
function specOf(fn: 'addBlock' | 'addIsland', spec: unknown): Record<string, unknown> {
  if (spec === null || typeof spec !== 'object') throw new Error(`${fn} 要一个对象，比如 ${fn}({ lat: 30, lon: 0, size: ${fn === 'addBlock' ? 20 : 2} })`);
  const o = spec as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const f of SETUP_FIELDS[fn]) {
    let v = o[f.key];
    if (v === undefined) v = o[f.zh];
    if (v === undefined) v = f.def;
    const name = `${fn} 的 ${f.key}（${f.zh}）`;
    if (f.lo === undefined) {
      if (typeof v !== 'boolean') throw new Error(`${name}要是 true 或 false`);
    } else {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name}要是一个数${v === undefined ? '（没有写）' : ''}`);
      if (v < f.lo || v > f.hi!) throw new Error(`${name}要在 ${f.lo} 到 ${f.hi} 之间（写的是 ${v}）`);
    }
    out[f.key] = v;
  }
  return out;
}

// 原来的大陆块，给脚本看的样子：中心的经纬度、半径（度）
function blockInfo(b: Block): { lat: number; lon: number; size: number } {
  return { lat: Math.asin(clamp(b.n[2], -1, 1)) / DEG, lon: Math.atan2(b.n[1], b.n[0]) / DEG, size: b.r / LAYOUT_R / DEG };
}

// 运行布局脚本。脚本出错（含超出上限、参数不对）时整段按没有脚本处理：返回 null，问题记进 issues。
// 安全模式下不运行，也不记问题（与生态的脚本一样：安全模式有自己的横幅）
function formSetup(form: PlanetForm, seed: number, blocks: Block[], issues: ScriptIssue[]): SetupOutcome | null {
  const src = form.scripts?.setup?.src;
  if (src === undefined || !scriptsEnabled()) return null;
  // 先记在草稿上，脚本正常结束才用：中途出错时前面加的块也不算
  let staged = blocks.slice();
  const noLobes = new Set<Block>();
  let islands: PlanetCone[] = [];
  let natural = true;
  const values: Record<string, unknown> = {
    seed,
    globe: true,
    blocks: blocks.map(blockInfo),
    addBlock: (spec: unknown) => {
      const o = specOf('addBlock', spec) as { lat: number; lon: number; size: number; stretch: number; angle: number; lobes: boolean };
      if (staged.length >= MAX_FORM_BLOCKS) throw new Error(`大陆块最多 ${MAX_FORM_BLOCKS} 块`);
      const c = latLonPoint(o.lat, o.lon);
      const b = makeBlock(c, tangentAt(c, o.angle * DEG), o.size * DEG * LAYOUT_R, o.stretch);
      staged.push(b);
      if (!o.lobes) noLobes.add(b);
    },
    clearBlocks: () => {
      staged = [];
    },
    addIsland: (spec: unknown) => {
      const o = specOf('addIsland', spec) as { lat: number; lon: number; height: number; size: number };
      if (islands.length >= MAX_FORM_ISLANDS) throw new Error(`岛最多 ${MAX_FORM_ISLANDS} 个`);
      islands.push({ c: latLonPoint(o.lat, o.lon), r: o.size * DEG * LAYOUT_R, h: o.height, rank: -1, kind: 'hotspot' });
    },
    clearIslands: () => {
      islands = [];
      natural = false;
    },
  };
  const r = runSetup({ src }, { owner: form.name, id: form.id, seedKey: form.seedKey, seed, values });
  if (!r.ok) {
    issues.push(r.issue);
    return null;
  }
  return { blocks: staged, noLobes, islands, natural };
}

function plateAt(m: PlanetModel, x: number, y: number, z: number): PlateInfo {
  let a = 0;
  let b = 1;
  let da = Infinity;
  let db = Infinity;
  m.plates.forEach((p, k) => {
    const d = power(p, x, y, z);
    if (d < da) {
      db = da;
      b = a;
      da = d;
      a = k;
    } else if (d < db) {
      db = d;
      b = k;
    }
  });
  return pairInfo(m, a, b, da, db, x, y, z);
}

function overrides(m: PlanetModel, q: V3, pi: PlateInfo, c: number): { over: boolean; bothCont: boolean } {
  const cOther = blockField(m, q[0] + 2 * pi.bd * pi.n[0], q[1] + 2 * pi.bd * pi.n[1], q[2] + 2 * pi.bd * pi.n[2]);
  const bothCont = c > 0.02 && cOther > 0.02;
  if (Math.abs(c - cOther) > 0.06) return { over: c > cOther, bothCont };
  return { over: m.plates[pi.a].density < m.plates[pi.b].density, bothCont };
}

// 从 c 出发在切平面里偏移 (de, ds)（布局单位）后投回球面
function offsetOnSphere(c: V3, de: number, ds: number): V3 {
  const n = unit(c);
  const [ex, ey, ez, sx, sy, sz] = tangentBasis(n[0], n[1], n[2]);
  const p: V3 = [c[0] + de * ex + ds * sx, c[1] + de * ey + ds * sy, c[2] + de * ez + ds * sz];
  return scale(unit(p), LAYOUT_R);
}

function buildCones(m: PlanetModel): PlanetCone[] {
  const { profile } = m;
  const rand = mulberry32(mixSeed(m.params.seed, 103, 0x3d));
  const cones: PlanetCone[] = [];
  // 热点岛链：沿板块运动方向排成大圆上的一串，越老越矮
  const hotspots = irange(rand, profile.hotspots);
  for (let h = 0; h < hotspots; h++) {
    let p = randomPoint(rand);
    for (let t = 0; t < 12; t++) {
      if (blockField(m, p[0], p[1], p[2]) < -0.08) break;
      p = randomPoint(rand);
    }
    const pi = plateAt(m, p[0], p[1], p[2]);
    const v = cross(m.plates[pi.a].w, p);
    const dir = len(v) > 1e-9 ? unit(v) : tangentAt(p, 0);
    const side = cross(unit(p), dir);
    const count = 4 + Math.floor(rand() * 7);
    const h0 = 4700 + rand() * 2300;
    const r0 = 0.02 + rand() * 0.012;
    const chainRank = rand();
    for (let i = 0; i < count; i++) {
      const jitter = (rand() - 0.5) * 0.012;
      const at = walk(p, dir, i * 0.03).p;
      const c = scale(unit(add(at, scale(side, jitter))), LAYOUT_R);
      cones.push({
        c,
        r: r0 * (1 - 0.05 * i) * (0.85 + 0.3 * rand()),
        h: h0 * Math.exp(-i / 3.2) * (0.8 + 0.4 * rand()),
        rank: chainRank + i * 0.015,
        kind: 'hotspot',
      });
    }
  }
  // 岛弧：在汇聚边界上覆的一侧、离边界一定距离。候选点是均匀铺满球面的斐波那契点阵（只取决于种子）
  const step = 0.028;
  const N = Math.round(LAYOUT_AREA / (step * step));
  let cg = 1;
  let sg = 0;
  for (let k = 0; k < N; k++) {
    const z = 1 - (2 * k + 1) / N;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    const base: V3 = [r * cg * LAYOUT_R, r * sg * LAYOUT_R, z * LAYOUT_R];
    const nc = cg * -0.73736887807831974 - sg * 0.67549029426152385;
    const ns = sg * -0.73736887807831974 + cg * 0.67549029426152385;
    const nl = Math.sqrt(nc * nc + ns * ns);
    cg = nc / nl;
    sg = ns / nl;
    const p = offsetOnSphere(base, (rand() - 0.5) * step * 0.8, (rand() - 0.5) * step * 0.8);
    const r1 = rand();
    const r2 = rand();
    const r3 = rand();
    const q = warp(m.noise, p[0], p[1], p[2]);
    const c = blockField(m, q[0], q[1], q[2]);
    if (c > 0.04) continue;
    const pi = plateAt(m, q[0], q[1], q[2]);
    if (pi.conv < 0.25 || Math.abs(pi.bd - 0.034) > 0.011) continue;
    if (!overrides(m, q, pi, c).over) continue;
    cones.push({ c: p, r: 0.011 + 0.016 * r1, h: Math.min(6800, 3400 * Math.pow(Math.max(r2, 1e-3), -0.32)), rank: r3, kind: 'arc' });
  }
  // 海山：成簇或沿断裂带成串；重尾的高度分布让岛的大小呈幂律
  let made = 0;
  while (made < profile.seamounts) {
    const center = randomPoint(rand);
    const clusterRank = rand();
    const linear = rand() < 0.4;
    const ang = rand() * Math.PI;
    const count = 3 + Math.floor(rand() * 7);
    for (let k = 0; k < count && made < profile.seamounts; k++, made++) {
      const along = linear ? (k - count / 2) * 0.022 : 0;
      const de = Math.cos(ang) * along + (rand() - 0.5) * (linear ? 0.012 : 0.07);
      const ds = Math.sin(ang) * along + (rand() - 0.5) * (linear ? 0.012 : 0.07);
      const c = offsetOnSphere(center, de, ds);
      const u = Math.max(rand(), 1e-4);
      const r = 0.009 + 0.02 * rand();
      const h = Math.min(7800, 1900 * Math.pow(u, -0.42));
      const rank = clusterRank + rand() * 0.05;
      cones.push({ c, r, h, rank, kind: 'seamount' });
    }
  }
  // 伴生小锥：岛的轮廓因此不再是圆
  const satellites: PlanetCone[] = [];
  for (const c of cones) {
    const k = Math.floor(rand() * 3);
    for (let s = 0; s < k; s++) {
      const a = rand() * Math.PI * 2;
      const dist = c.r * (0.6 + 0.6 * rand());
      satellites.push({ c: offsetOnSphere(c.c, Math.cos(a) * dist, Math.sin(a) * dist), r: c.r * (0.35 + 0.35 * rand()), h: c.h * (0.55 + 0.3 * rand()), rank: c.rank + 1e-6, kind: c.kind });
    }
  }
  return [...cones, ...satellites].sort((p, q) => p.rank - q.rank);
}

// 换了重画、种子与类型不变：板块、大陆块、火山锥、噪声只取决于种子与类型，照用，只换参数
export function withPlanetParams(m: PlanetModel, input: WorldgenInput): PlanetModel {
  return { ...m, params: resolvedPlanetParams(worldgenSchema.parse(input)) };
}

// re：只重算 re.changed 这些重画圈里的格，其余格照抄 re.from（见 generate.ts 的 Resample）
export function samplePlanetComponents(m: PlanetModel, mesh: SphereMesh, re?: Resample): BaseComponents {
  // 星球形态的地形脚本（安全模式下不运行：结果与没有地形脚本相同，也不记问题，与生态的脚本一样）
  const crust = m.params.form?.scripts?.crust;
  if (crust && scriptsEnabled()) return sampleWithCrust(m, mesh, crust.src, re);
  const n = mesh.n;
  const out = re ? copyComponents(re.from) : emptyComponents(n);
  const rerolls = placed(m.params.rerolls);
  const changed = re ? placed(re.changed) : [];
  const tmp = emptyComponents(1);
  for (let i = 0; i < n; i++) {
    const px = mesh.p[3 * i];
    const py = mesh.p[3 * i + 1];
    const pz = mesh.p[3 * i + 2];
    // 与 sampleCell 里同一个“在圈内”的判断
    if (re && changed.every((r) => rerollDist(r, px, py, pz) >= r.radius)) continue;
    sampleCell(m, rerolls, px, py, pz, out, i, tmp);
  }
  return out;
}

// 空闲预热（第三十一轮，见 terrain.ts 的 warmTerrainSteps）：从头采样的一段格 [from, to)，写进 out（新建的空分量）。
// 每格与 samplePlanetComponents 不带 re 时的那一格是同一个调用（临时的分量每次用前整个写过），分段与一次采完逐值相同。
// 有地形脚本时不能分段（脚本按整个星球跑），返回 false、什么都不做
export function samplePlanetRange(m: PlanetModel, mesh: SphereMesh, out: BaseComponents, from: number, to: number): boolean {
  if (m.params.form?.scripts?.crust && scriptsEnabled()) return false;
  const rerolls = placed(m.params.rerolls);
  const tmp = emptyComponents(1);
  for (let i = from; i < to; i++) sampleCell(m, rerolls, mesh.p[3 * i], mesh.p[3 * i + 1], mesh.p[3 * i + 2], out, i, tmp);
  return true;
}

// 前 N 个火山锥对每格地壳高度与抬升的贡献（不扭曲坐标，保持圆形）
export function planetConeFields(m: PlanetModel, mesh: SphereMesh, count: number): { coneB: Float32Array; coneU: Float32Array } {
  const n = mesh.n;
  const coneB = new Float32Array(n);
  const coneU = new Float32Array(n);
  const cones = m.cones.slice(0, count);
  if (!cones.length) return { coneB, coneU };
  // 三维均匀网格加速
  const cs = 0.06;
  const lo = -LAYOUT_R - cs;
  const g = Math.ceil((2 * LAYOUT_R + 2 * cs) / cs) + 1;
  const grid = new Map<number, number[]>();
  const key = (ix: number, iy: number, iz: number) => (ix * g + iy) * g + iz;
  cones.forEach((c, k) => {
    const r = c.r * 1.4;
    for (let ix = Math.floor((c.c[0] - r - lo) / cs); ix <= Math.floor((c.c[0] + r - lo) / cs); ix++) {
      for (let iy = Math.floor((c.c[1] - r - lo) / cs); iy <= Math.floor((c.c[1] + r - lo) / cs); iy++) {
        for (let iz = Math.floor((c.c[2] - r - lo) / cs); iz <= Math.floor((c.c[2] + r - lo) / cs); iz++) {
          const kk = key(ix, iy, iz);
          const list = grid.get(kk);
          if (list) list.push(k);
          else grid.set(kk, [k]);
        }
      }
    }
  });
  for (let i = 0; i < n; i++) {
    const x = mesh.p[3 * i] * LAYOUT_R;
    const y = mesh.p[3 * i + 1] * LAYOUT_R;
    const z = mesh.p[3 * i + 2] * LAYOUT_R;
    const list = grid.get(key(Math.floor((x - lo) / cs), Math.floor((y - lo) / cs), Math.floor((z - lo) / cs)));
    if (!list) continue;
    for (const k of list) {
      const c = cones[k];
      const d = Math.sqrt((x - c.c[0]) ** 2 + (y - c.c[1]) ** 2 + (z - c.c[2]) ** 2);
      const re = c.r * (1 + 0.45 * fbm3(m.noise.cone, x, y, z, 0.8 / c.r, 3));
      if (d >= re) continue;
      const t = 1 - d / re;
      coneB[i] += c.h * Math.pow(t, 1.5);
      coneU[i] += 1.1 * (c.h / 6500) * Math.pow(t, 1.3);
    }
  }
  return { coneB, coneU };
}
