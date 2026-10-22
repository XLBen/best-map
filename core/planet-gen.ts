import { type BaseComponents, type Resample, type Reroll, type WorldType, type Worldgen, type WorldgenInput, copyComponents, worldgenSchema } from './generate';
import type { SphereMesh } from './mesh';
import { type PlanetForm, mergeProfile } from './planet-form';
import { type Noise3, clamp, fbm3, gradientNoise3, mixSeed, mulberry32, smoothstep } from './rng';
import { type ScriptIssue, arrayInputs, runScript, runSetup, scriptsEnabled } from './script';
import { tangentBasis, toUnit } from './sphere';

// 整个星球的世界生成：与 generate.ts 同一套“地壳高度 + 海平面”的做法，搬到球面上。
//   · 布局坐标 Q = 单位向量 × 2/π（球半径 ρ = 2/π）。这样 10 万格星球的格距和 4 万格的地区地图几乎一样，
//     generate.ts 里按“每格”调好的宽度、频率、阈值都照用；布局与星球大小无关（大小只影响 km）
//   · 噪声是三维的，在球面上取值：没有东西接缝，两极也不会被拉伸
//   · 板块绕各自的欧拉轴转动，速度 v = ω × Q；距离一律用弦长
//   · 所有随机都在建模型时一次取好，每格的值只取决于它在球面上的位置，所以缩略图与成品格局一致

export const LAYOUT_R = 2 / Math.PI;
// 布局坐标下整个球面的面积（4πρ²）
const LAYOUT_AREA = 4 * Math.PI * LAYOUT_R * LAYOUT_R;

type V3 = [number, number, number];

interface PlanetProfile {
  landFraction: number;
  islands: number;
  plates: [number, number];
  blocks: [number, number];
  radius: [number, number];
  // 主块：“一块超大陆”的主体
  main?: [number, number];
  // 其余的块贴在主块边上（连成一整块），而不是彼此远离
  attach?: boolean;
  rise: number;
  relief: number;
  hotspots: [number, number];
  seamounts: number;
  ring?: boolean;
}

// 整个星球的面积约是 2:1 地区地图的 2.5 倍，块、热点、海山的个数相应多一些
const PLANET_PROFILES: Record<WorldType, PlanetProfile> = {
  continents: { landFraction: 0.29, islands: 0.6, plates: [12, 18], blocks: [6, 9], radius: [0.16, 0.32], rise: 1500, relief: 620, hotspots: [5, 9], seamounts: 330 },
  continent: { landFraction: 0.3, islands: 0.35, plates: [10, 14], blocks: [3, 5], radius: [0.12, 0.2], main: [0.55, 0.65], attach: true, rise: 1500, relief: 620, hotspots: [3, 6], seamounts: 180 },
  archipelago: { landFraction: 0.11, islands: 0.8, plates: [10, 16], blocks: [28, 40], radius: [0.045, 0.12], rise: 700, relief: 620, hotspots: [8, 12], seamounts: 380 },
  fragmented: { landFraction: 0.28, islands: 0.55, plates: [16, 22], blocks: [22, 32], radius: [0.08, 0.2], rise: 650, relief: 720, hotspots: [5, 8], seamounts: 280 },
  inland_sea: { landFraction: 0.4, islands: 0.3, plates: [10, 14], blocks: [8, 11], radius: [0.16, 0.23], rise: 1400, relief: 600, hotspots: [3, 5], seamounts: 150, ring: true },
  ocean: { landFraction: 0, islands: 0, plates: [10, 16], blocks: [0, 0], radius: [0.1, 0.2], rise: 1000, relief: 300, hotspots: [8, 12], seamounts: 360 },
};

// 这种星球的配方：星球形态改过的项换成形态的值（type 与 form.base 相同由 set_worldgen 保证）
function profileOf(p: Worldgen): PlanetProfile {
  return mergeProfile(PLANET_PROFILES[p.type], p.form?.profile);
}

export function resolvedPlanetParams(p: Worldgen): Worldgen & { landFraction: number; islands: number } {
  const prof = profileOf(p);
  return { ...p, landFraction: p.landFraction ?? prof.landFraction, islands: p.islands ?? prof.islands };
}

// 地壳细节里可以由星球形态调的字面量。没有形态时就是这些值本身（同一个双精度数、同样的运算顺序），结果逐位不变
interface PlanetTuning {
  // 碰撞带、大陆边缘山带的宽度（布局单位，再乘宽窄起伏）
  wc: number;
  wm: number;
  // 板块边界只看这么近的（山带加宽时跟着放宽，免得山带被截断）
  reach: number;
  // 洋中脊抬升、大陆裂谷下陷、海沟深度（m）
  ridgeH: number;
  riftH: number;
  trenchH: number;
  // 丘陵的强弱
  hills: number;
}

const DEFAULT_TUNING: PlanetTuning = Object.freeze({ wc: 0.055, wm: 0.032, reach: 0.3, ridgeH: 1700, riftH: 900, trenchH: 2600, hills: 0.12 });

function tuningOf(form: PlanetForm | undefined): PlanetTuning {
  if (!form) return DEFAULT_TUNING;
  const t = form.tuning ?? {};
  const bw = t.beltWidth ?? 1;
  // 倍数为 1 时乘出来的就是原来的字面量（乘 1 是精确的）
  return {
    wc: DEFAULT_TUNING.wc * bw,
    wm: DEFAULT_TUNING.wm * bw,
    reach: DEFAULT_TUNING.reach * Math.max(1, bw),
    ridgeH: DEFAULT_TUNING.ridgeH * (t.ridge ?? 1),
    riftH: DEFAULT_TUNING.riftH * (t.rift ?? 1),
    trenchH: DEFAULT_TUNING.trenchH * (t.trench ?? 1),
    hills: DEFAULT_TUNING.hills * (t.hills ?? 1),
  };
}

interface Plate {
  c: V3;
  // 角速度（欧拉轴 × 转速）
  w: V3;
  weight: number;
  density: number;
}

interface Block {
  c: V3;
  // 中心处的外法向、长轴、短轴（单位向量）
  n: V3;
  u: V3;
  v: V3;
  r: number;
  e: number;
}

export interface PlanetCone {
  c: V3;
  r: number;
  h: number;
  rank: number;
  kind: 'hotspot' | 'arc' | 'seamount';
}

interface NoiseSet3 {
  warpA: Noise3;
  warpB: Noise3;
  warpC: Noise3;
  warpD: Noise3;
  warpE: Noise3;
  warpF: Noise3;
  block: Noise3;
  relief: Noise3;
  ocean: Noise3;
  seg: Noise3;
  ridge: Noise3;
  hills: Noise3;
  erod: Noise3;
  cone: Noise3;
}

function noiseSet3(seed: number, variant: number): NoiseSet3 {
  const n = (k: number) => gradientNoise3(mixSeed(seed, variant, k, 0x3d));
  return {
    warpA: n(1),
    warpB: n(2),
    warpC: n(3),
    warpD: n(4),
    block: n(5),
    relief: n(6),
    ocean: n(7),
    seg: n(8),
    ridge: n(9),
    hills: n(10),
    erod: n(11),
    cone: n(12),
    warpE: n(13),
    warpF: n(14),
  };
}

export interface PlanetModel {
  kind: 'planet';
  params: ReturnType<typeof resolvedPlanetParams>;
  profile: PlanetProfile;
  plates: Plate[];
  blocks: Block[];
  meanR: number;
  cones: PlanetCone[];
  noise: NoiseSet3;
  variants: Map<number, NoiseSet3>;
  tuning: PlanetTuning;
  // 形态的 crustMode 是 'replace'、又有地形脚本：脚本算的那几遍不算板块边界（地形完全由脚本决定）。
  // 脚本没有运行（安全模式）或那一遍出了错，就按没有脚本算，板块边界照算
  replace: boolean;
  // cones 最前面有几个是布局脚本加的岛：它们总是露出来，“岛多少”只增减其余的
  fixedCones: number;
  // 星球形态的布局脚本这次出的问题（没有形态时为 undefined）。普通的 JSON，只给界面看
  issues: ScriptIssue[] | undefined;
}

const range = (rand: () => number, [a, b]: [number, number]) => a + (b - a) * rand();
const irange = (rand: () => number, [a, b]: [number, number]) => a + Math.floor((b - a + 1) * rand());

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const len = (a: V3) => Math.sqrt(dot(a, a));
const unit = (a: V3): V3 => scale(a, 1 / (len(a) || 1));

// 球面上均匀的随机点（布局坐标）
function randomPoint(rand: () => number): V3 {
  const z = 2 * rand() - 1;
  const phi = 2 * Math.PI * rand();
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return [r * Math.cos(phi) * LAYOUT_R, r * Math.sin(phi) * LAYOUT_R, z * LAYOUT_R];
}

// 点 c 处、方位角 a（从东向南转）的切向单位向量
function tangentAt(c: V3, a: number): V3 {
  const n = unit(c);
  const [ex, ey, ez, sx, sy, sz] = tangentBasis(n[0], n[1], n[2]);
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  return [ca * ex + sa * sx, ca * ey + sa * sy, ca * ez + sa * sz];
}

// 从 c 沿切向 dir 走过布局距离 dist（沿大圆）；返回终点与终点处的前进方向
function walk(c: V3, dir: V3, dist: number): { p: V3; t: V3 } {
  const n = unit(c);
  const th = dist / LAYOUT_R;
  const ct = Math.cos(th);
  const st = Math.sin(th);
  const p = scale(add(scale(n, ct), scale(dir, st)), LAYOUT_R);
  const t = add(scale(n, -st), scale(dir, ct));
  return { p, t };
}

function makeBlock(c: V3, u: V3, r: number, e: number): Block {
  const n = unit(c);
  // 长轴取切向分量（防止数值误差），短轴与它垂直
  const ut = unit(add(u, scale(n, -dot(u, n))));
  const v = cross(ut, n);
  return { c, n, u: ut, v, r, e };
}

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
    plates.push({ c, w: scale(axis, sp / (LAYOUT_R * sinA)), weight: randP() * 0.03, density: randP() });
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
  const setup = form && issues ? formSetup(form, seed, blocks, issues) : null;
  if (setup) blocks.splice(0, blocks.length, ...setup.blocks);
  const meanR = blocks.length ? blocks.reduce((s, b) => s + b.r, 0) / blocks.length : 0.2;
  // 半岛：大陆块沿大圆向外伸出的狭长瓣
  const randL = mulberry32(mixSeed(seed, 104, 0x3d));
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
      blocks.push(makeBlock(p, t, lr, e));
    }
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
  };
  // 布局脚本加的岛排在最前（rank −1），clearIslands() 之后不要原来的火山锥
  const natural = setup && !setup.natural ? [] : buildCones(model);
  model.cones = setup && setup.islands.length ? [...setup.islands, ...natural] : natural;
  model.fixedCones = setup ? setup.islands.length : 0;
  return model;
}

// ---------- 星球形态的布局脚本 ----------

// 布局脚本最多加到这么多大陆块、这么多岛（防止写错的循环把模型撑得很大、每格都要算很久）
export const MAX_FORM_BLOCKS = 120;
export const MAX_FORM_ISLANDS = 300;

interface SetupOutcome {
  // 运行之后的大陆块（含配方原来的、脚本加的）
  blocks: Block[];
  // 脚本说了 lobes: false 的块：不长半岛
  noLobes: Set<Block>;
  islands: PlanetCone[];
  // false：脚本调用了 clearIslands()，不要原来的火山锥
  natural: boolean;
}

const DEG = Math.PI / 180;

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
export const SETUP_FIELDS: Record<'addBlock' | 'addIsland', readonly SetupField[]> = {
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

// 大陆场：1 在块中心，0 在块边缘，负值在块外（加上法向分量，球的另一面不会“折回来”）
function blockField(m: PlanetModel, qx: number, qy: number, qz: number): number {
  let c = -1;
  for (const b of m.blocks) {
    const dx = qx - b.c[0];
    const dy = qy - b.c[1];
    const dz = qz - b.c[2];
    const du = dx * b.u[0] + dy * b.u[1] + dz * b.u[2];
    const dv = dx * b.v[0] + dy * b.v[1] + dz * b.v[2];
    const dn = dx * b.n[0] + dy * b.n[1] + dz * b.n[2];
    const s = 1 - Math.sqrt((du * du) / b.e + dv * dv * b.e + dn * dn) / b.r;
    if (s > c) c = s;
  }
  return c;
}

function warp(ns: NoiseSet3, x: number, y: number, z: number): V3 {
  let qx = x + 0.16 * fbm3(ns.warpA, x, y, z, 1.2, 4);
  let qy = y + 0.16 * fbm3(ns.warpB, x + 5.2, y + 1.3, z, 1.2, 4);
  let qz = z + 0.16 * fbm3(ns.warpE, x - 3.7, y, z + 2.9, 1.2, 4);
  const wx = fbm3(ns.warpC, qx, qy, qz, 4.2, 3);
  const wy = fbm3(ns.warpD, qx + 3.1, qy - 2.7, qz, 4.2, 3);
  const wz = fbm3(ns.warpF, qx, qy + 1.9, qz - 4.4, 4.2, 3);
  qx += 0.045 * wx;
  qy += 0.045 * wy;
  qz += 0.045 * wz;
  return [qx, qy, qz];
}

const power = (p: Plate, x: number, y: number, z: number) => (x - p.c[0]) ** 2 + (y - p.c[1]) ** 2 + (z - p.c[2]) ** 2 - p.weight;

function nearestPlate(m: PlanetModel, x: number, y: number, z: number): number {
  let a = 0;
  let da = Infinity;
  m.plates.forEach((p, k) => {
    const d = power(p, x, y, z);
    if (d < da) {
      da = d;
      a = k;
    }
  });
  return a;
}

interface PlateInfo {
  a: number;
  b: number;
  bd: number;
  conv: number;
  // 边界法向（点处的切向单位向量，指向另一块）
  n: V3;
}

// 一对板块在点 (x, y, z) 处：到边界的距离、汇聚速度（正为汇聚）、切向法向
function pairInfo(m: PlanetModel, a: number, b: number, da: number, db: number, x: number, y: number, z: number): PlateInfo {
  const pa = m.plates[a];
  const pb = m.plates[b];
  const d: V3 = [pb.c[0] - pa.c[0], pb.c[1] - pa.c[1], pb.c[2] - pa.c[2]];
  const L = len(d) || 1e-6;
  const P: V3 = [x, y, z];
  const ph = unit(P);
  const raw = scale(d, 1 / L);
  const nt0 = add(raw, scale(ph, -dot(raw, ph)));
  const ntl = len(nt0);
  const n: V3 = ntl > 1e-9 ? scale(nt0, 1 / ntl) : [0, 0, 0];
  const rel = cross([pa.w[0] - pb.w[0], pa.w[1] - pb.w[1], pa.w[2] - pb.w[2]], P);
  return { a, b, bd: (db - da) / (2 * L), conv: dot(rel, n), n };
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

const emptyComponents = (n: number): BaseComponents => ({
  b0: new Float32Array(n),
  mountB: new Float32Array(n),
  mountU: new Float32Array(n),
  hillU: new Float32Array(n),
  erod: new Float32Array(n),
});

// 换了重画、种子与类型不变：板块、大陆块、火山锥、噪声只取决于种子与类型，照用，只换参数
export function withPlanetParams(m: PlanetModel, input: WorldgenInput): PlanetModel {
  return { ...m, params: resolvedPlanetParams(worldgenSchema.parse(input)) };
}

type PlacedReroll = Reroll & { u: V3 };
const placed = (rerolls: Reroll[]): PlacedReroll[] => rerolls.map((r) => ({ ...r, u: toUnit(r.x, r.y) }));

// 单位球上的点到重画圈中心的距离（地图单位，即弧长 / π）
function rerollDist(r: PlacedReroll, px: number, py: number, pz: number): number {
  const cx = py * r.u[2] - pz * r.u[1];
  const cy = pz * r.u[0] - px * r.u[2];
  const cz = px * r.u[1] - py * r.u[0];
  return Math.atan2(Math.sqrt(cx * cx + cy * cy + cz * cz), px * r.u[0] + py * r.u[1] + pz * r.u[2]) / Math.PI;
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

// 一格：原来的噪声，再按顺序叠上覆盖它的各次重画
function sampleCell(m: PlanetModel, rerolls: PlacedReroll[], px: number, py: number, pz: number, out: BaseComponents, i: number, tmp: BaseComponents) {
  sampleInto(m, m.noise, px * LAYOUT_R, py * LAYOUT_R, pz * LAYOUT_R, out, i);
  // 重画这一片：球面上的圆（半径是地图单位，即弧长 / π）里换一套噪声，边缘羽化
  for (const r of rerolls) {
    const d = rerollDist(r, px, py, pz);
    if (d >= r.radius) continue;
    let ns = m.variants.get(r.variant);
    if (!ns) {
      ns = noiseSet3(m.params.seed, r.variant);
      m.variants.set(r.variant, ns);
    }
    sampleInto(m, ns, px * LAYOUT_R, py * LAYOUT_R, pz * LAYOUT_R, tmp, 0);
    const w = 1 - smoothstep(0.6, 1, d / r.radius);
    out.b0[i] += (tmp.b0[0] - out.b0[i]) * w;
    out.mountB[i] += (tmp.mountB[0] - out.mountB[i]) * w;
    out.mountU[i] += (tmp.mountU[0] - out.mountU[i]) * w;
    out.hillU[i] += (tmp.hillU[0] - out.hillU[i]) * w;
  }
}

// 一格的生成结果（双精度，写进 Float32 数组之前）。地形脚本要用双精度的原值，所以先算到这里
interface CellSample {
  B: number;
  mountB: number;
  mountU: number;
  hillU: number;
  erod: number;
  // 大陆场（地形脚本的 continent）
  c: number;
}
const S: CellSample = { B: 0, mountB: 0, mountU: 0, hillU: 0, erod: 0, c: 0 };

function sampleInto(m: PlanetModel, ns: NoiseSet3, x: number, y: number, z: number, out: BaseComponents, i: number) {
  sampleRaw(m, ns, x, y, z, S, true);
  out.b0[i] = S.B;
  out.mountB[i] = S.mountB;
  out.mountU[i] = S.mountU;
  out.hillU[i] = S.hillU;
  out.erod[i] = S.erod;
}

// 造山带对地壳高度的贡献（“山多高”= 1 时）。地形脚本改了山的强弱后按同一个式子重算
const mountBOf = (mountU: number, c: number) => 1600 * mountU * smoothstep(-0.05, 0.05, c);

// plates：算不算板块边界。只有地形脚本真的算了的那一遍（crustMode 'replace'）才不算
function sampleRaw(m: PlanetModel, ns: NoiseSet3, x: number, y: number, z: number, s: CellSample, plates: boolean) {
  const prof = m.profile;
  const t = m.tuning;
  const [qx, qy, qz] = warp(ns, x, y, z);
  let c = m.blocks.length ? blockField(m, qx, qy, qz) : -1;
  if (m.blocks.length) {
    const f = 1 / Math.max(0.1, m.meanR);
    c += 0.42 * fbm3(ns.block, qx, qy, qz, 1.5 * f, 4, 0.55) + 0.18 * fbm3(ns.hills, qx + 9.1, qy - 4.3, qz, 6 * f, 4, 0.62);
  }

  // 地壳：大陆架 → 陆坡 → 深海（与 generate.ts 相同）
  const slopeW = 0.08;
  let B: number;
  if (c >= 0) B = -140 + 650 * Math.min(c, 0.16) + prof.rise * Math.max(0, c - 0.16);
  else if (c >= -slopeW) B = -140 - 3800 * smoothstep(0, 1, -c / slopeW);
  else B = -3940;
  const rw = smoothstep(-slopeW, 0.06, c);
  B += prof.relief * rw * fbm3(ns.relief, qx, qy, qz, 2.6, 9, 0.62);
  B += 230 * (1 - rw) * fbm3(ns.ocean, qx, qy, qz, 5, 4);

  // 板块边界：在更弯曲的坐标里求
  const px = qx + 0.07 * fbm3(ns.seg, qx + 11.3, qy, qz, 1.7, 3) + 0.022 * fbm3(ns.ridge, qx, qy + 4.4, qz, 5.5, 2);
  const py = qy + 0.07 * fbm3(ns.seg, qx, qy - 7.9, qz, 1.7, 3) + 0.022 * fbm3(ns.ridge, qx - 2.2, qy, qz, 5.5, 2);
  const pz = qz + 0.07 * fbm3(ns.seg, qx, qy, qz + 6.1, 1.7, 3) + 0.022 * fbm3(ns.ridge, qx, qy, qz - 3.3, 5.5, 2);
  const oceanW = 1 - smoothstep(-0.12, 0, c);
  const contW = smoothstep(-0.02, 0.1, c);
  const widthMod = 0.65 + 0.7 * (0.5 + 0.5 * fbm3(ns.hills, px * 0.7, py * 0.7, pz * 0.7, 2.5, 2));
  const seg = smoothstep(-0.35, 0.3, fbm3(ns.seg, qx, qy, qz, 3.5, 3));
  const ridged = 1 - Math.abs(fbm3(ns.ridge, qx, qy, qz, 10, 4));
  const wc = t.wc * widthMod;
  const wm = t.wm * widthMod;
  const belt = (bd: number, w: number) => Math.exp(-((bd / w) ** 2)) + 0.5 * Math.exp(-(((bd - 2.4 * w) / (0.6 * w)) ** 2));
  let ridge = 0;
  let rift = 0;
  let trench = 0;
  let mm = 0;
  // 星球形态的 crustMode 'replace'：不算板块边界（山带、洋中脊、海沟、裂谷都没有）
  if (plates) {
    const a = nearestPlate(m, px, py, pz);
    const da = power(m.plates[a], px, py, pz);
    for (let b = 0; b < m.plates.length; b++) {
      if (b === a) continue;
      const db = power(m.plates[b], px, py, pz);
      const pa = m.plates[a];
      const pb = m.plates[b];
      const L = Math.sqrt((pb.c[0] - pa.c[0]) ** 2 + (pb.c[1] - pa.c[1]) ** 2 + (pb.c[2] - pa.c[2]) ** 2) || 1e-6;
      const bd = (db - da) / (2 * L);
      if (bd > t.reach) continue;
      const pi = pairInfo(m, a, b, da, db, px, py, pz);
      const conv = pi.conv;
      if (conv < 0) {
        const div = Math.min(1, -conv);
        ridge = Math.max(ridge, div * Math.exp(-((bd / 0.04) ** 2)));
        rift = Math.max(rift, div * Math.exp(-((bd / 0.025) ** 2)));
        continue;
      }
      const cOther = blockField(m, qx + 2 * bd * pi.n[0], qy + 2 * bd * pi.n[1], qz + 2 * bd * pi.n[2]);
      const wb = smoothstep(-0.02, 0.1, cOther);
      const cv = Math.min(1.3, conv);
      const subducts = (1 - contW) * Math.max(wb, pa.density > pb.density ? 1 : 0);
      trench = Math.max(trench, Math.min(1, cv) * Math.exp(-(((bd - 0.012) / 0.012) ** 2)) * subducts);
      const collision = contW * wb;
      const margin = contW * (1 - wb);
      const shape = collision * (belt(bd, wc) + 0.45 * Math.exp(-((bd / (3 * wc)) ** 2))) + margin * belt(bd, wm);
      mm = Math.max(mm, cv * shape);
    }
  }
  B += t.ridgeH * ridge * oceanW - t.riftH * rift * contW - t.trenchH * trench * oceanW;
  const mountU = mm * (0.3 + 0.7 * seg) * (0.55 + 0.6 * ridged);
  s.B = B;
  s.mountB = mountBOf(mountU, c);
  s.mountU = mountU;
  s.hillU = t.hills * Math.max(0, fbm3(ns.hills, qx, qy, qz, 6, 4)) * contW;
  s.erod = clamp(1 + 0.45 * fbm3(ns.erod, x + 7.7, y - 3.1, z + 1.9, 6, 3), 0.4, 1.8);
  s.c = c;
}

// ---------- 星球形态的地形脚本 ----------

// 每格在单位球面上的位置与经纬度（地形脚本的 px、py、pz、lat、lon），按网格缓存
type CellPositions = Record<'px' | 'py' | 'pz' | 'lat' | 'lon', Float64Array>;
const positionCache = new WeakMap<SphereMesh, CellPositions>();
function cellPositions(mesh: SphereMesh): CellPositions {
  let pos = positionCache.get(mesh);
  if (!pos) {
    const n = mesh.n;
    pos = { px: new Float64Array(n), py: new Float64Array(n), pz: new Float64Array(n), lat: new Float64Array(n), lon: new Float64Array(n) };
    for (let i = 0; i < n; i++) {
      const x = mesh.p[3 * i];
      const y = mesh.p[3 * i + 1];
      const z = mesh.p[3 * i + 2];
      pos.px[i] = x;
      pos.py[i] = y;
      pos.pz[i] = z;
      pos.lat[i] = Math.asin(clamp(z, -1, 1)) / DEG;
      pos.lon[i] = Math.atan2(y, x) / DEG;
    }
    positionCache.set(mesh, pos);
  }
  return pos;
}

// 一遍（原来的噪声，或某次重画的噪声）算出的双精度分量，按格编号存
interface RawPass {
  B: Float64Array;
  mountB: Float64Array;
  mountU: Float64Array;
  hillU: Float64Array;
  erod: Float64Array;
  c: Float64Array;
}

// 界面看的问题最多留几条（同一句话只留一条）
const MAX_ISSUES = 8;
function addIssue(issues: ScriptIssue[], issue: ScriptIssue) {
  if (issues.length < MAX_ISSUES && !issues.some((x) => x.message === issue.message)) issues.push(issue);
}

// 地形脚本每一遍的结果：pass[0] 是原来的噪声那一遍，pass[k + 1] 是 rerolls[k] 那一遍；null 为正常，否则是这一遍出的问题。
// 一遍的结果只取决于模型（种子、类型、形态）与这一遍自己的重画，与别的重画无关：局部重算时没变的那几遍照用
interface CrustPasses {
  rerolls: Reroll[];
  pass: (ScriptIssue | null)[];
}
const crustPasses = new WeakMap<BaseComponents, CrustPasses>();

// 一批格用某一套噪声算出的原值，写进 raw（按格编号）。plates 见 sampleRaw
function sampleCells(m: PlanetModel, ns: NoiseSet3, mesh: SphereMesh, cells: Int32Array, raw: RawPass, plates: boolean) {
  const p = mesh.p;
  for (let j = 0; j < cells.length; j++) {
    const i = cells[j];
    sampleRaw(m, ns, p[3 * i] * LAYOUT_R, p[3 * i + 1] * LAYOUT_R, p[3 * i + 2] * LAYOUT_R, S, plates);
    raw.B[i] = S.B;
    raw.mountB[i] = S.mountB;
    raw.mountU[i] = S.mountU;
    raw.hillU[i] = S.hillU;
    raw.erod[i] = S.erod;
    raw.c[i] = S.c;
  }
}

// 用某一套噪声（variant 0 是原来的，其余是重画）算一批格，再整批交给地形脚本，结果写回 raw（按格编号）。
// 脚本在任何一格出错（运行时出错、NaN、返回值不对），这一遍整遍按没有脚本算（raw 里是没有脚本时的原值：
// crustMode 'replace' 时板块边界也照算），返回出的问题。
// known：局部重算时这一遍上一次的结果（undefined 为新的一遍）。上一次出了错的不再运行，直接按没有脚本算；
// 上一次正常、这次却出错（脚本不纯）时返回 'redo'，由调用方从头算
function crustPass(m: PlanetModel, ns: NoiseSet3, variant: number, mesh: SphereMesh, cells: Int32Array, raw: RawPass, src: string, known: ScriptIssue | null | undefined): ScriptIssue | null | 'redo' {
  if (known) {
    sampleCells(m, ns, mesh, cells, raw, true);
    return known;
  }
  sampleCells(m, ns, mesh, cells, raw, !m.replace);
  const form = m.params.form!;
  const pos = cellPositions(mesh);
  const inputs = arrayInputs(
    mesh.n,
    { height: raw.B, mountains: raw.mountU, hills: raw.hillU, rock: raw.erod, continent: raw.c, lat: pos.lat, lon: pos.lon, px: pos.px, py: pos.py, pz: pos.pz, seed: m.params.seed, globe: true },
    { globe: true },
  );
  // 重画一片换一套噪声，脚本的 rand()、fbmAt() 也跟着换（种子里加上 variant）
  const seed = variant ? mixSeed(m.params.seed, variant, 0x3d) : m.params.seed;
  const r = runScript({ kind: 'crust', src }, { owner: form.name, id: form.id, seedKey: form.seedKey, seed, inputs, cells });
  if (!r.ok) {
    if (known === null) return 'redo';
    if (m.replace) sampleCells(m, ns, mesh, cells, raw, true);
    return r.issue;
  }
  const res = r.output;
  for (let j = 0; j < cells.length; j++) {
    const i = cells[j];
    raw.B[i] = res.height[j];
    raw.mountU[i] = res.mountains[j];
    raw.hillU[i] = res.hills[j];
    raw.erod[i] = res.rock[j];
    // 山的强弱没改时，与原来的值逐位相同
    raw.mountB[i] = mountBOf(res.mountains[j], raw.c[i]);
  }
  return null;
}

// 有地形脚本时的采样：与 samplePlanetComponents 的逐格写法同样的结果（脚本按没有处理时逐位相同），
// 只是先把一遍的格都算出来，整批交给脚本，再按原来的顺序叠上各次重画。重画的那一遍不叠岩性（与没有脚本时相同）。
//
// “一遍”是：原来的噪声对整个星球的每一格；每次重画的噪声对它圈里的每一格。出错按整遍算，所以结果只取决于
// 世界参数本身。重画一片时局部重算：只算变了的那些圈里的格；新的重画那一遍的格全在里面，整遍都算；
// 没变的那几遍（原来的噪声那一遍、共同前缀里的重画）照用上一次的结果——出过错的仍按没有脚本算，正常的
// 只对这些格运行（脚本对每格单独地算，局部算的与从头算的逐值相同）。所以撤销、重做、重放、检查点恢复的结果都一致
function sampleWithCrust(m: PlanetModel, mesh: SphereMesh, src: string, re?: Resample): BaseComponents {
  const prev = re ? crustPasses.get(re.from) : undefined;
  if (re && !prev) return sampleWithCrust(m, mesh, src);
  const n = mesh.n;
  const p = mesh.p;
  const out = re ? copyComponents(re.from) : emptyComponents(n);
  const rerolls = placed(m.params.rerolls);
  // 上一次的前几次重画与这次的相同：那几遍的结果照用
  let keep = 0;
  if (prev) while (keep < prev.rerolls.length && keep < rerolls.length && sameReroll(prev.rerolls[keep], rerolls[keep])) keep++;
  const changed = re ? placed(re.changed) : [];
  const todo: number[] = [];
  for (let i = 0; i < n; i++) {
    // 与 samplePlanetComponents 同一个“在圈内”的判断
    if (re && changed.every((r) => rerollDist(r, p[3 * i], p[3 * i + 1], p[3 * i + 2]) >= r.radius)) continue;
    todo.push(i);
  }
  const cells = Int32Array.from(todo);
  const raw: RawPass = { B: new Float64Array(n), mountB: new Float64Array(n), mountU: new Float64Array(n), hillU: new Float64Array(n), erod: new Float64Array(n), c: new Float64Array(n) };
  const pass: (ScriptIssue | null)[] = [];
  const first = crustPass(m, m.noise, 0, mesh, cells, raw, src, prev?.pass[0]);
  if (first === 'redo') return sampleWithCrust(m, mesh, src);
  pass.push(first);
  for (const i of todo) {
    out.b0[i] = raw.B[i];
    out.mountB[i] = raw.mountB[i];
    out.mountU[i] = raw.mountU[i];
    out.hillU[i] = raw.hillU[i];
    out.erod[i] = raw.erod[i];
  }
  // 重画这一片：一次一次地叠（每格叠的顺序与逐格写法相同），圈边羽化
  for (let k = 0; k < rerolls.length; k++) {
    const r = rerolls[k];
    const known = k < keep ? prev!.pass[k + 1] : undefined;
    const inside: number[] = [];
    const dist: number[] = [];
    for (const i of todo) {
      const d = rerollDist(r, p[3 * i], p[3 * i + 1], p[3 * i + 2]);
      if (d >= r.radius) continue;
      inside.push(i);
      dist.push(d);
    }
    if (!inside.length) {
      // 新的重画圈里一格也没有：从头算也是什么都不做
      pass.push(known ?? null);
      continue;
    }
    let ns = m.variants.get(r.variant);
    if (!ns) {
      ns = noiseSet3(m.params.seed, r.variant);
      m.variants.set(r.variant, ns);
    }
    const got = crustPass(m, ns, r.variant, mesh, Int32Array.from(inside), raw, src, known);
    if (got === 'redo') return sampleWithCrust(m, mesh, src);
    pass.push(got);
    for (let j = 0; j < inside.length; j++) {
      const i = inside[j];
      const w = 1 - smoothstep(0.6, 1, dist[j] / r.radius);
      // 逐格写法里重画的值先存进 Float32 的临时数组：这里同样先取整到单精度
      out.b0[i] += (Math.fround(raw.B[i]) - out.b0[i]) * w;
      out.mountB[i] += (Math.fround(raw.mountB[i]) - out.mountB[i]) * w;
      out.mountU[i] += (Math.fround(raw.mountU[i]) - out.mountU[i]) * w;
      out.hillU[i] += (Math.fround(raw.hillU[i]) - out.hillU[i]) * w;
    }
  }
  // 给界面看的问题：按遍的顺序，同一句话只留一条
  const issues: ScriptIssue[] = [];
  for (const x of pass) if (x) addIssue(issues, x);
  out.issues = issues;
  crustPasses.set(out, { rerolls: m.params.rerolls.map((r) => ({ ...r })), pass });
  return out;
}

// 同一次重画：逐字段比（与 terrain.ts 里的相同）
const sameReroll = (a: Reroll, b: Reroll) => Object.is(a.x, b.x) && Object.is(a.y, b.y) && Object.is(a.radius, b.radius) && Object.is(a.variant, b.variant);

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
