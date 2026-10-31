import { type BaseComponents, type Resample, type Reroll, type WorldType, type Worldgen, type WorldgenInput, copyComponents, emptyBaseComponents, oceanFloor, worldgenSchema } from './generate';
import type { SphereMesh } from './mesh';
import { type PlanetForm, mergeProfile } from './planet-form';
import { type ReliefInput, type ReliefOut, RIFT_W, type TectonicRaster, type TectonicSample, buildTectonics, cachedTectonics, reliefAt, sampleTectonics } from './relief';
import { ISTHMUS_PAD, RIDGE_W, SHELF, WIGGLE, closeGap, eHard, eSoft, escNear, isthmusC, isthmusW, reliefNear, ridgeOpen, shelfWidth, triWidth } from './outline';
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

export interface PlanetProfile {
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

// 一种星球原来的配方（星球形态编辑器的滑块按它显示形态没改的项）。给出的是副本
export function planetProfile(type: WorldType): PlanetProfile {
  return structuredClone(PLANET_PROFILES[type]);
}

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
  // 第三十五轮：裂开的大陆块两半的板块互为 sib，别的是 −1（见 generate.ts）
  sib: number;
}

interface Block {
  c: V3;
  // 中心处的外法向、长轴、短轴（单位向量）
  n: V3;
  u: V3;
  v: V3;
  r: number;
  e: number;
  // 属于哪一块（半岛的瓣算它的母块；第三十二轮：缝合线只在不同的块之间）。建好模型时填
  fam?: number;
  // 第三十五轮：三角形的半岛（往外收窄的程度，0 或没有是椭圆）
  tri?: number;
}

// 第三十五轮：裂开、漂移的大陆块（见 outline.ts、generate.ts 的 Rift）。漂移前：裂谷线过 c、沿 t（指向极），法向 n 指向 + 那一半；
// 两半绕欧拉极（单位轴 a）各转 ±phi（离极沿 m 不到 ramp 时渐渐不转）；cb、R：漂移后这一族块可能到的范围（弦长）
export interface Rift {
  fam: number;
  c: V3;
  t: V3;
  n: V3;
  kappa: number;
  a: V3;
  m: V3;
  phi: number;
  ramp: number;
  D: number;
  red: boolean;
  cb: V3;
  R: number;
}

// 第三十五轮：块与块之间的地峡（折线 pts：x, y, z……，布局坐标）
export interface Isthmus {
  pts: Float64Array;
  cum: Float64Array;
  w: number;
  cb: V3;
  R: number;
}

// 块内的老缝合线（第三十二轮）：块的局部坐标（长轴、短轴）里一条直线
interface SutureLine {
  block: number;
  cos: number;
  sin: number;
  off: number;
}

// 带陡崖的穹隆（第三十二轮）
interface SwellSpot {
  c: V3;
  r: number;
  h: number;
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
  // 第三十二轮：大格局的低频噪声
  big: Noise3;
  plat: Noise3;
  sag: Noise3;
  // 第三十五轮：裂谷线的弯曲
  rift: Noise3;
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
    big: n(15),
    plat: n(16),
    sag: n(17),
    rift: n(18),
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
  // 第三十二轮：块内的缝合线、穹隆；板块的栅格（第一次采样时建，按种子、类型、形态缓存）
  sutures: SutureLine[];
  swells: SwellSpot[];
  tect?: TectonicRaster;
  // 第三十五轮：裂开的块、每一族对应哪一处裂开（没有是 −1）、地峡
  rifts: Rift[];
  famRift: number[];
  isthmi: Isthmus[];
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


// ---------- 第三十五轮：裂开的大陆块与地峡（见 outline.ts；与 generate.ts 同一个做法，两半绕欧拉极转开） ----------

// 一个块的场（与以前的 blockField 里的式子相同）；三角形的半岛往外收窄
function blockF(b: Block, qx: number, qy: number, qz: number): number {
  const dx = qx - b.c[0];
  const dy = qy - b.c[1];
  const dz = qz - b.c[2];
  const du = dx * b.u[0] + dy * b.u[1] + dz * b.u[2];
  let dv = dx * b.v[0] + dy * b.v[1] + dz * b.v[2];
  const dn = dx * b.n[0] + dy * b.n[1] + dz * b.n[2];
  if (b.tri) dv /= triWidth(du / (Math.sqrt(b.e) * b.r), b.tri);
  return 1 - Math.sqrt((du * du) / b.e + dv * dv * b.e + dn * dn) / b.r;
}

const MAX_RIFTS = 8;
interface DriftState {
  inb: Uint8Array;
  sg: Float64Array;
  uq: Float64Array;
  px: Float64Array;
  py: Float64Array;
  pz: Float64Array;
  x: Float64Array;
  disp: Float64Array;
  ws: Float64Array;
  wsl: Float64Array;
}
const driftState = (): DriftState => ({
  inb: new Uint8Array(MAX_RIFTS),
  sg: new Float64Array(MAX_RIFTS),
  uq: new Float64Array(MAX_RIFTS),
  px: new Float64Array(MAX_RIFTS),
  py: new Float64Array(MAX_RIFTS),
  pz: new Float64Array(MAX_RIFTS),
  x: new Float64Array(MAX_RIFTS),
  disp: new Float64Array(MAX_RIFTS),
  ws: new Float64Array(MAX_RIFTS),
  wsl: new Float64Array(MAX_RIFTS),
});
// 采样用的一份、famField / blockField 用的一份
const DS = driftState();
const DF = driftState();

// 按方向量（先投回球面：扭曲有沿半径的分量，切口不随它挪）
function riftU(r: Rift, wig: Noise3 | null, px: number, py: number, pz: number): number {
  const L = LAYOUT_R / (Math.sqrt(px * px + py * py + pz * pz) || 1);
  const x = px * L;
  const y = py * L;
  const z = pz * L;
  const ax = x - r.c[0];
  const ay = y - r.c[1];
  const az = z - r.c[2];
  const along = ax * r.t[0] + ay * r.t[1] + az * r.t[2];
  let u = ax * r.n[0] + ay * r.n[1] + az * r.n[2] + r.kappa * along * along;
  if (wig) u += WIGGLE.amp * fbm3(wig, x, y, z, WIGGLE.freq, WIGGLE.oct, WIGGLE.gain);
  return u;
}

// 绕单位轴 a 转 ang（右手），结果写进 RV
const RV: V3 = [0, 0, 0];
function rotate(a: V3, ang: number, x: number, y: number, z: number) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  const d = (a[0] * x + a[1] * y + a[2] * z) * (1 - c);
  RV[0] = x * c + (a[1] * z - a[2] * y) * s + a[0] * d;
  RV[1] = y * c + (a[2] * x - a[0] * z) * s + a[1] * d;
  RV[2] = z * c + (a[0] * y - a[1] * x) * s + a[2] * d;
}

// 转的角度：离极（沿 m 往块那边）不到 ramp 时渐渐不转，过了极不转
function riftAngle(r: Rift, x: number, y: number, z: number): number {
  const L = Math.sqrt(x * x + y * y + z * z) || 1;
  return r.phi * smoothstep(0, r.ramp, (x * r.m[0] + y * r.m[1] + z * r.m[2]) / L);
}

function riftAt(r: Rift, wig: Noise3 | null, qx: number, qy: number, qz: number, k: number, o: DriftState) {
  const dx = qx - r.cb[0];
  const dy = qy - r.cb[1];
  const dz = qz - r.cb[2];
  if (dx * dx + dy * dy + dz * dz >= r.R * r.R) {
    o.inb[k] = 0;
    return;
  }
  o.inb[k] = 1;
  const uq = riftU(r, wig, qx, qy, qz);
  const sg = uq >= 0 ? 1 : -1;
  // 转回漂移前（−角度）
  rotate(r.a, -sg * riftAngle(r, qx, qy, qz), qx, qy, qz);
  const Px = RV[0];
  const Py = RV[1];
  const Pz = RV[2];
  const disp = Math.sqrt((qx - Px) ** 2 + (qy - Py) ** 2 + (qz - Pz) ** 2);
  o.uq[k] = uq;
  o.sg[k] = sg;
  o.px[k] = Px;
  o.py[k] = Py;
  o.pz[k] = Pz;
  o.disp[k] = disp;
  o.x[k] = closeGap(sg * riftU(r, wig, Px, Py, Pz), disp);
  o.ws[k] = shelfWidth(disp, SHELF.wsMax, SHELF.wsK);
  o.wsl[k] = shelfWidth(disp, SHELF.wslMax, SHELF.wslK);
}

function prepRifts(m: PlanetModel, wig: Noise3 | null, qx: number, qy: number, qz: number, o: DriftState) {
  const rifts = m.rifts;
  for (let k = 0; k < rifts.length; k++) riftAt(rifts[k], wig, qx, qy, qz, k, o);
}

// 漂移前的一点在 sg 那一半上漂移后的位置（建模型时用：转的角度按漂移前的位置取）
function driftForward(r: Rift, sg: number, p: V3): V3 {
  rotate(r.a, sg * riftAngle(r, p[0], p[1], p[2]), p[0], p[1], p[2]);
  return [RV[0], RV[1], RV[2]];
}

// 地峡：到折线（三维的点）的距离与沿线的位置（0–1）
const IS = { d: 0, t: 0 };
function isthmusDist(l: Isthmus, x: number, y: number, z: number) {
  const p = l.pts;
  let best = Infinity;
  let bt = 0;
  for (let s = 0; s + 5 < p.length; s += 3) {
    const ax = p[s];
    const ay = p[s + 1];
    const az = p[s + 2];
    const bx = p[s + 3] - ax;
    const by = p[s + 4] - ay;
    const bz = p[s + 5] - az;
    const L2 = bx * bx + by * by + bz * bz || 1e-12;
    const t = Math.max(0, Math.min(1, ((x - ax) * bx + (y - ay) * by + (z - az) * bz) / L2));
    const dx = x - ax - t * bx;
    const dy = y - ay - t * by;
    const dz = z - az - t * bz;
    const d = dx * dx + dy * dy + dz * dz;
    if (d < best) {
      best = d;
      const seg = s / 3;
      bt = (l.cum[seg] + t * (l.cum[seg + 1] - l.cum[seg])) / l.cum[l.cum.length - 1];
    }
  }
  IS.d = Math.sqrt(best);
  IS.t = bt;
}

// 一族块漂移后在 q 处的场（不含噪声；裂开的按切口截，不加弯曲噪声）
function famField(m: PlanetModel, fam: number, x: number, y: number, z: number): number {
  const k = m.famRift[fam] ?? -1;
  if (k >= 0) {
    riftAt(m.rifts[k], null, x, y, z, k, DF);
    if (!DF.inb[k]) return -1;
  }
  let c = -1;
  for (const b of m.blocks) {
    if (b.fam !== fam) continue;
    const s = k < 0 ? blockF(b, x, y, z) : Math.min(blockF(b, DF.px[k], DF.py[k], DF.pz[k]), eHard(DF.x[k], DF.ws[k], DF.wsl[k]));
    if (s > c) c = s;
  }
  return c;
}

function famFieldPre(m: PlanetModel, fam: number, x: number, y: number, z: number): number {
  let c = -1;
  for (const b of m.blocks) if (b.fam === fam) c = Math.max(c, blockF(b, x, y, z));
  return c;
}

function famReach(m: PlanetModel, fam: number, o: V3): number {
  let reach = 0;
  for (const b of m.blocks) {
    if (b.fam !== fam) continue;
    const se = Math.sqrt(b.e);
    reach = Math.max(reach, len(add(b.c, scale(o, -1))) + 2.1 * b.r * Math.max(se, 1 / se) * (b.tri ? 1.3 : 1));
  }
  return reach;
}

// 一处裂开的候选（见 generate.ts 的 riftCandidate）
function riftCandidate(m: PlanetModel, fam: number, b: Block, draws: number[], red: boolean, tr: number, D: number): { r: Rift; reach: number } {
  const se = Math.sqrt(b.e);
  const t0 = tangentAt(b.c, (draws[3] + tr * 0.25) * Math.PI);
  const end = draws[7] < 0.5 ? 1 : -1;
  const t = scale(t0, end);
  const n = unit(cross(t, unit(b.c)));
  const c = scale(unit(add(b.c, scale(n, (draws[4] - 0.5) * 0.4 * b.r))), LAYOUT_R);
  const kappa = ((draws[5] - 0.5) * 1.6) / b.r;
  const delta = Math.min(Math.PI / 2, (red ? b.r * se * (0.8 + 0.5 * draws[6]) : b.r * (3 + 3 * draws[6])) / LAYOUT_R);
  const cu = unit(c);
  // 极：从 c 沿 t 走 delta（弧度）；+ 那一半绕极转 +phi 往 n 走（a × ĉ = sin δ · t × ĉ）
  const a: V3 = unit(add(scale(cu, Math.cos(delta)), scale(unit(add(t, scale(cu, -dot(t, cu)))), Math.sin(delta))));
  const nn = unit(cross(a, cu));
  const mm = unit(add(cu, scale(a, -dot(cu, a))));
  const reach = famReach(m, fam, c);
  const phi = D / 2 / (LAYOUT_R * Math.sin(delta));
  return { r: { fam, c, t: unit(cross(cu, nn)), n: nn, kappa, a, m: mm, phi, ramp: 0.4 * Math.sin(delta), D, red, cb: c, R: reach + phi * LAYOUT_R + 0.05 }, reach };
}

// 裂开（每个够大的块取固定的几个随机数，不管成不成；试法与 generate.ts 的 buildRifts 相同）。布局脚本加的块不裂（profileBlocks 里的才裂）
function buildRifts(m: PlanetModel, parents: Block[], profileBlocks: Set<Block>, rand: () => number) {
  const { profile } = m;
  for (let fam = 0; fam < parents.length; fam++) {
    const b = parents[fam];
    const draws = Array.from({ length: 8 }, () => rand());
    if (b.r < 0.14 || draws[0] >= 0.5 || (profile.main && fam === 0) || !profileBlocks.has(b) || m.rifts.length >= MAX_RIFTS) continue;
    let made: Rift | null = null;
    for (const red of draws[1] < 0.5 ? [true] : [false, true]) {
      const want = red ? 0.02 + 0.03 * draws[2] : 0.15 + 0.25 * draws[2];
      const minD = red ? 0.02 : 0.06;
      for (let tr = 0; tr < 4 && !(made && made.D >= want); tr++) {
        for (let D = want; D >= minD - 1e-9; D = D > minD && D * 0.75 < minD ? minD : D * 0.75) {
          if (made && D <= made.D) break;
          const { r, reach } = riftCandidate(m, fam, b, draws, red, tr, D);
          if (riftClear(m, r, reach)) {
            made = r;
            break;
          }
          if (D === minD) break;
        }
      }
      if (made) break;
    }
    if (!made) continue;
    m.famRift[fam] = m.rifts.length;
    m.rifts.push(made);
  }
  if (m.rifts.length) fragmentPlates(m, rand);
  for (const s of m.swells) {
    for (const r of m.rifts) {
      if (famFieldPre(m, r.fam, s.c[0], s.c[1], s.c[2]) < -0.2) continue;
      s.c = driftForward(r, riftU(r, null, s.c[0], s.c[1], s.c[2]) >= 0 ? 1 : -1, s.c);
      break;
    }
  }
}

// 漂移前这一族块的格点（在 c 的切平面上铺，投回球面；场 > −0.1），带上在哪一半
function famSamples(m: PlanetModel, r: Rift, reach: number): { p: V3; f: number; sg: number }[] {
  const out: { p: V3; f: number; sg: number }[] = [];
  const step = reach / 16;
  for (let i = -16; i <= 16; i++) {
    for (let j = -16; j <= 16; j++) {
      const p = scale(unit(add(r.c, add(scale(r.t, i * step), scale(r.n, j * step)))), LAYOUT_R);
      const f = famFieldPre(m, r.fam, p[0], p[1], p[2]);
      if (f > -0.1) out.push({ p, f, sg: riftU(r, null, p[0], p[1], p[2]) >= 0 ? 1 : -1 });
    }
  }
  return out;
}

// 漂移后不压到别的块上（见 generate.ts 的 riftClear）
function riftClear(m: PlanetModel, r: Rift, reach: number): boolean {
  const other = (p: V3) => {
    let o = -1;
    for (let f = 0; f < m.famRift.length; f++) if (f !== r.fam) o = Math.max(o, famField(m, f, p[0], p[1], p[2]));
    return o;
  };
  for (const s of famSamples(m, r, reach)) {
    const after = other(driftForward(r, s.sg, s.p));
    if (after > -0.3 && after > other(s.p) + 0.02) return false;
  }
  return true;
}

// 板块跟着碎块走（见 generate.ts）：落在碎块中间的板块去掉，两半的重心各放一个板块，绕同一个欧拉极往两边转（0.9–1.2）
function fragmentPlates(m: PlanetModel, rand: () => number) {
  const halves: { c: V3; w: V3 }[] = [];
  for (const r of m.rifts) {
    const pts = famSamples(m, r, famReach(m, r.fam, r.c));
    for (const sg of [1, -1]) {
      let sum: V3 = [0, 0, 0];
      let w = 0;
      for (const s of pts) {
        if (s.sg !== sg || s.f <= 0) continue;
        sum = add(sum, scale(s.p, s.f));
        w += s.f;
      }
      const pre = w ? scale(unit(sum), LAYOUT_R) : scale(unit(add(r.c, scale(r.n, sg * 0.1))), LAYOUT_R);
      const c = scale(unit(driftForward(r, sg, pre)), LAYOUT_R);
      const sinA = Math.sqrt(Math.max(1e-6, 1 - dot(r.a, unit(c)) ** 2));
      halves.push({ c, w: scale(r.a, sg / (LAYOUT_R * sinA)) });
    }
  }
  const inFragment = (p: V3) => m.rifts.some((r) => famField(m, r.fam, p[0], p[1], p[2]) > 0.4);
  const kept = m.plates.filter((p) => !inFragment(p.c));
  const base = kept.length;
  for (const h of halves) {
    const sp = 0.9 + 0.3 * rand();
    kept.push({ c: h.c, w: scale(h.w, sp), weight: 0.035, density: rand(), sib: -1 });
  }
  for (let h = 0; h < halves.length; h += 2) {
    kept[base + h].sib = base + h + 1;
    kept[base + h + 1].sib = base + h;
  }
  m.plates.splice(0, m.plates.length, ...kept);
}

// 一族块的大致面积（π r²，母块加上半岛）：地峡不把太多块连成一块
function famArea(blocks: Block[], fam: number): number {
  let a = 0;
  for (const b of blocks) if (b.fam === fam) a += Math.PI * b.r * b.r;
  return a;
}

// 地峡（见 generate.ts 的 buildIsthmi）：沿两块之间的大圆走
const ISTHMUS_TYPES = new Set<WorldType>(['continents', 'continent', 'fragmented', 'inland_sea']);
function buildIsthmi(m: PlanetModel, parents: Block[], rand: () => number) {
  const want = rand() < 0.5 ? 1 : 2;
  const bend = Array.from({ length: 6 }, () => rand());
  if (!ISTHMUS_TYPES.has(m.params.type)) return;
  const pieces: { p: V3; fam: number; area: number }[] = [];
  for (let fam = 0; fam < parents.length; fam++) {
    const b = parents[fam];
    const k = m.famRift[fam];
    if (k < 0) {
      pieces.push({ p: b.c, fam, area: famArea(m.blocks, fam) });
      continue;
    }
    const r = m.rifts[k];
    for (const sg of [1, -1]) pieces.push({ p: driftForward(r, sg, scale(unit(add(b.c, scale(r.n, sg * b.r * 0.45))), LAYOUT_R)), fam, area: famArea(m.blocks, fam) / 2 });
  }
  const at = (A: V3, B: V3, t: number): V3 => scale(unit(add(scale(A, 1 - t), scale(B, t))), LAYOUT_R);
  // 连在一起的块（并查集）
  const up = pieces.map((_, k) => k);
  const ta = (k: number): number => (up[k] === k ? k : (up[k] = ta(up[k])));
  const join = (a: number, b: number) => {
    up[ta(a)] = ta(b);
  };
  const cands: { a: number; b: number; pa: V3; pb: V3; L: number }[] = [];
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const A = pieces[i];
      const B = pieces[j];
      if (A.fam === B.fam) continue;
      const chord = len(add(B.p, scale(A.p, -1)));
      if (chord > 1.0) continue;
      const dist = 2 * LAYOUT_R * Math.asin(Math.min(1, chord / (2 * LAYOUT_R)));
      const N = Math.ceil(dist / 0.004);
      const fa: number[] = [];
      const fb: number[] = [];
      for (let s = 0; s <= N; s++) {
        const p = at(A.p, B.p, s / N);
        fa.push(famField(m, A.fam, p[0], p[1], p[2]));
        fb.push(famField(m, B.fam, p[0], p[1], p[2]));
      }
      if (fa[0] < 0.2 || fb[N] < 0.2) continue;
      let sa = 0;
      while (sa < N && fa[sa + 1] >= 0.2) sa++;
      let sb = N;
      while (sb > 0 && fb[sb - 1] >= 0.2) sb--;
      // 两块的场重叠（本来就连着）：算一块
      if (sb <= sa) {
        join(i, j);
        continue;
      }
      let sea = false;
      for (let s = sa; s <= sb && !sea; s++) if (Math.max(fa[s], fb[s]) < 0) sea = true;
      if (!sea) {
        // 中间没有海（本来就挨着）：算一块
        join(i, j);
        continue;
      }
      const pa = at(A.p, B.p, sa / N);
      const pb = at(A.p, B.p, sb / N);
      const L = len(add(pb, scale(pa, -1)));
      if (L < 0.04 || L > 0.4) continue;
      cands.push({ a: i, b: j, pa, pb, L });
    }
  }
  cands.sort((p, q) => p.L - q.L);
  const used = new Set<number>();
  let total = 0;
  for (const q of pieces) total += q.area;
  for (const c of cands) {
    const made = m.isthmi.length;
    if (made >= want) break;
    // 不连成太大的一块（连起来的块加起来不过所有块的四成：地球上最大的亚非欧约占陆地 57%，块之外还有噪声长出来的陆地），也不连已经连着的
    if (used.has(c.a) || used.has(c.b) || ta(c.a) === ta(c.b)) continue;
    let sum = 0;
    for (let k = 0; k < pieces.length; k++) if (ta(k) === ta(c.a) || ta(k) === ta(c.b)) sum += pieces[k].area;
    if (sum > 0.4 * total) continue;
    used.add(c.a);
    used.add(c.b);
    join(c.a, c.b);
    const dir = scale(add(c.pb, scale(c.pa, -1)), 1 / c.L);
    const ea = scale(unit(add(c.pa, scale(dir, -0.06))), LAYOUT_R);
    const eb = scale(unit(add(c.pb, scale(dir, 0.06))), LAYOUT_R);
    const mid = scale(unit(add(ea, eb)), LAYOUT_R);
    const side = unit(cross(unit(mid), dir));
    const amt = c.L * (0.25 + 0.25 * bend[made * 3 + 1]) * (bend[made * 3] < 0.5 ? -1 : 1);
    const k = add(mid, scale(side, amt));
    const K = 16;
    const pts = new Float64Array(3 * (K + 1));
    const cum = new Float64Array(K + 1);
    for (let s = 0; s <= K; s++) {
      const t = s / K;
      const p = scale(unit(add(add(scale(ea, (1 - t) * (1 - t)), scale(k, 2 * t * (1 - t))), scale(eb, t * t))), LAYOUT_R);
      pts.set(p, 3 * s);
      if (s) cum[s] = cum[s - 1] + Math.hypot(pts[3 * s] - pts[3 * s - 3], pts[3 * s + 1] - pts[3 * s - 2], pts[3 * s + 2] - pts[3 * s - 1]);
    }
    const w = 0.015 + 0.007 * bend[made * 3 + 2];
    let R = 0;
    for (let s = 0; s <= K; s++) R = Math.max(R, Math.hypot(pts[3 * s] - mid[0], pts[3 * s + 1] - mid[1], pts[3 * s + 2] - mid[2]));
    m.isthmi.push({ pts, cum, w, cb: mid, R: R + w + ISTHMUS_PAD });
  }
}

// 扭曲有沿半径的分量：按方向量（先投回球面），地峡的宽窄不随扭曲变
const IW = { c: -1, w: 0 };
function isthmiAt(m: PlanetModel, qx: number, qy: number, qz: number) {
  IW.c = -1;
  IW.w = 0;
  const L = LAYOUT_R / (Math.sqrt(qx * qx + qy * qy + qz * qz) || 1);
  const x = qx * L;
  const y = qy * L;
  const z = qz * L;
  for (const l of m.isthmi) {
    const dx = x - l.cb[0];
    const dy = y - l.cb[1];
    const dz = z - l.cb[2];
    if (dx * dx + dy * dy + dz * dz >= l.R * l.R) continue;
    isthmusDist(l, x, y, z);
    IW.c = Math.max(IW.c, isthmusC(IS.d, l.w));
    IW.w = Math.max(IW.w, isthmusW(IS.d, l.w, IS.t));
  }
}

// 统计用（tools/realism.ts）：一点（单位球上的格心）扭曲后的位置（布局坐标）
export function warpedAtPlanet(m: PlanetModel, px: number, py: number, pz: number): V3 {
  return warp(m.noise, px * LAYOUT_R, py * LAYOUT_R, pz * LAYOUT_R);
}

// 统计用：每条地峡到扭曲后的一点的距离 ÷ 半宽
export function isthmusNearPlanet(m: PlanetModel, q: V3): number[] {
  const L = LAYOUT_R / (Math.hypot(q[0], q[1], q[2]) || 1);
  return m.isthmi.map((l) => {
    isthmusDist(l, q[0] * L, q[1] * L, q[2] * L);
    return IS.d / l.w;
  });
}

// 统计用：单位球上的一点（格心）相对每处裂开：[第几处, 哪一半, 漂移前的位置（布局坐标）, 离切口的 x, 漂移前这一族块的场, 漂移后的 u]
export function riftFramesPlanet(m: PlanetModel, px: number, py: number, pz: number): [number, number, V3, number, number, number][] {
  const [qx, qy, qz] = warp(m.noise, px * LAYOUT_R, py * LAYOUT_R, pz * LAYOUT_R);
  prepRifts(m, m.noise.rift, qx, qy, qz, DF);
  const out: [number, number, V3, number, number, number][] = [];
  for (let k = 0; k < m.rifts.length; k++) {
    if (!DF.inb[k]) continue;
    out.push([k, DF.sg[k], [DF.px[k], DF.py[k], DF.pz[k]], DF.x[k], famFieldPre(m, m.rifts[k].fam, DF.px[k], DF.py[k], DF.pz[k]), DF.uq[k]]);
  }
  return out;
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

// 大陆场：1 在块中心，0 在块边缘，负值在块外（加上法向分量，球的另一面不会“折回来”）。
// 第三十五轮：裂开的块按漂移后的位置（不加裂谷线的弯曲噪声）、加上地峡（见 generate.ts 的 blockField）
function blockField(m: PlanetModel, qx: number, qy: number, qz: number): number {
  const nr = m.rifts.length;
  if (nr) prepRifts(m, null, qx, qy, qz, DF);
  let c = -1;
  for (const b of m.blocks) {
    const k = nr ? m.famRift[b.fam ?? -1] ?? -1 : -1;
    let s: number;
    if (k < 0) s = blockF(b, qx, qy, qz);
    else if (!DF.inb[k]) continue;
    else s = Math.min(blockF(b, DF.px[k], DF.py[k], DF.pz[k]), eHard(DF.x[k], DF.ws[k], DF.wsl[k]));
    if (s > c) c = s;
  }
  if (m.isthmi.length) {
    isthmiAt(m, qx, qy, qz);
    if (IW.c > c) c = IW.c;
  }
  return c;
}

// 大陆场与缝合线（第三十二轮，与 generate.ts 的 blockPair 同一个意思）：s1 与 blockField 逐值相同
interface BlockPair {
  s1: number;
  s2: number;
  inner: number;
  innerS: number;
  oth: number;
  best: number;
  fk: Float64Array;
}
const BP: BlockPair = { s1: -1, s2: -1, inner: 1, innerS: -1, oth: -1, best: -1, fk: new Float64Array(MAX_RIFTS) };
function blockPair(m: PlanetModel, wig: Noise3, qx: number, qy: number, qz: number, out: BlockPair) {
  const nr = m.rifts.length;
  if (nr) {
    prepRifts(m, wig, qx, qy, qz, DS);
    out.fk.fill(-1);
  }
  let s1 = -1;
  let f1 = -1;
  let s2 = -1;
  let oth = -1;
  for (const b of m.blocks) {
    const k = nr ? m.famRift[b.fam ?? -1] ?? -1 : -1;
    let s: number;
    if (k < 0) {
      s = blockF(b, qx, qy, qz);
      if (s > oth) oth = s;
    } else {
      if (!DS.inb[k]) continue;
      const fv = blockF(b, DS.px[k], DS.py[k], DS.pz[k]);
      if (fv > out.fk[k]) out.fk[k] = fv;
      s = Math.min(fv, eSoft(DS.x[k], DS.ws[k], DS.wsl[k]));
    }
    const f = b.fam ?? -2;
    if (s > s1) {
      if (f !== f1) s2 = s1;
      s1 = s;
      f1 = f;
    } else if (f !== f1 && s > s2) s2 = s;
  }
  out.s1 = s1;
  out.s2 = s2;
  out.oth = oth;
  out.best = -1;
  for (let k = 0; k < nr; k++) if (DS.inb[k] && out.fk[k] > -1 && (out.best < 0 || out.fk[k] > out.fk[out.best])) out.best = k;
  out.inner = 1;
  out.innerS = -1;
  for (const l of m.sutures) {
    const b = m.blocks[l.block];
    const k = nr ? m.famRift[b.fam ?? -1] ?? -1 : -1;
    if (k >= 0 && !DS.inb[k]) continue;
    const cx = k < 0 ? qx : DS.px[k];
    const cy = k < 0 ? qy : DS.py[k];
    const cz = k < 0 ? qz : DS.pz[k];
    const dx = cx - b.c[0];
    const dy = cy - b.c[1];
    const dz = cz - b.c[2];
    const du = dx * b.u[0] + dy * b.u[1] + dz * b.u[2];
    const dv = dx * b.v[0] + dy * b.v[1] + dz * b.v[2];
    const d = Math.abs(du * l.cos + dv * l.sin - l.off * b.r);
    if (d < out.inner) {
      out.inner = d;
      out.innerS = blockF(b, cx, cy, cz);
    }
  }
}

// 板块的栅格（第三十二轮，见 relief.ts）：等距圆柱 512 × 256，铺在球面的方向上（东西相接）
const TW = 512;
const TH = 256;
function tectonicsOf(m: PlanetModel): TectonicRaster {
  if (m.tect) return m.tect;
  const form = m.params.form;
  const key = `globe:${m.params.seed}:${m.params.type}:${form ? JSON.stringify(form) : ''}`;
  m.tect = cachedTectonics(key, () => {
    const pos = new Float64Array(TW * TH * 3);
    const plate = new Uint8Array(TW * TH);
    for (let y = 0; y < TH; y++) {
      const lat = Math.PI / 2 - ((y + 0.5) / TH) * Math.PI;
      for (let x = 0; x < TW; x++) {
        const lon = ((x + 0.5) / TW) * 2 * Math.PI - Math.PI;
        const k = y * TW + x;
        const X = Math.cos(lat) * Math.cos(lon) * LAYOUT_R;
        const Y = Math.cos(lat) * Math.sin(lon) * LAYOUT_R;
        const Z = Math.sin(lat) * LAYOUT_R;
        pos[3 * k] = X;
        pos[3 * k + 1] = Y;
        pos[3 * k + 2] = Z;
        plate[k] = nearestPlate(m, X, Y, Z);
      }
    }
    return buildTectonics(TW, TH, true, 3, pos, plate, (k, a, b) => {
      const X = pos[3 * k];
      const Y = pos[3 * k + 1];
      const Z = pos[3 * k + 2];
      const pi = pairInfo(m, a, b, power(m.plates[a], X, Y, Z), power(m.plates[b], X, Y, Z), X, Y, Z);
      const n = pi.n;
      const ca = blockField(m, X - 0.04 * n[0], Y - 0.04 * n[1], Z - 0.04 * n[2]);
      const cb = blockField(m, X + 0.04 * n[0], Y + 0.04 * n[1], Z + 0.04 * n[2]);
      const upper = Math.abs(ca - cb) > 0.06 ? (ca > cb ? a : b) : m.plates[a].density < m.plates[b].density ? a : b;
      return { conv: pi.conv, upper, lower: upper === a ? b : a, coll: ca > 0.02 && cb > 0.02, cont: ca > 0.02 || cb > 0.02 };
    });
  });
  return m.tect;
}
const TS: TectonicSample = { dist: 0, up: 0, low: 0, conv: 0, coll: 0 };
const RI: ReliefInput = { c: 0, contW: 0, t: TS, widthMod: 1, nBase: 0, nPlat: 0, nPlatW: 0, nEsc: 0, nSag: 0, nRift: 0, swellR: 9, swellH: 0, riftAxis: 0, shoulder: 0, plates: true, esc: 0 };
const RO: ReliefOut = { T: 0, Tp: 0, pit: 0, rift: 0, erodMul: 1 };

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

const emptyComponents = emptyBaseComponents;

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

// 一格：原来的噪声，再按顺序叠上覆盖它的各次重画
function sampleCell(m: PlanetModel, rerolls: PlacedReroll[], px: number, py: number, pz: number, out: BaseComponents, i: number, tmp: BaseComponents) {
  sampleInto(m, m.noise, px * LAYOUT_R, py * LAYOUT_R, pz * LAYOUT_R, out, i);
  out.seaB0[i] = out.b0[i];
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
    out.sea[i] += (tmp.sea[0] - out.sea[i]) * w;
    out.T[i] += (tmp.T[0] - out.T[i]) * w;
    out.Tp[i] += (tmp.Tp[0] - out.Tp[i]) * w;
    out.pit[i] += (tmp.pit[0] - out.pit[i]) * w;
    out.rift[i] += (tmp.rift[0] - out.rift[i]) * w;
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
  // 洋底的目标深度（见 generate.ts 的 oceanFloor）；地形脚本不改它
  sea: number;
  // 第三十二轮：基准面、高原、洼地（见 relief.ts）；地形脚本还不能改它们
  T: number;
  Tp: number;
  pit: number;
  rift: number;
}
const S: CellSample = { B: 0, mountB: 0, mountU: 0, hillU: 0, erod: 0, c: 0, sea: 0, T: 0, Tp: 0, pit: 0, rift: 0 };

function sampleInto(m: PlanetModel, ns: NoiseSet3, x: number, y: number, z: number, out: BaseComponents, i: number) {
  sampleRaw(m, ns, x, y, z, S, true);
  out.b0[i] = S.B;
  out.mountB[i] = S.mountB;
  out.mountU[i] = S.mountU;
  out.hillU[i] = S.hillU;
  out.erod[i] = S.erod;
  out.sea[i] = S.sea;
  out.T[i] = S.T;
  out.Tp[i] = S.Tp;
  out.pit[i] = S.pit;
  out.rift[i] = S.rift;
}

// 造山带对地壳高度的贡献（“山多高”= 1 时）。地形脚本改了山的强弱后按同一个式子重算
const mountBOf = (mountU: number, c: number) => 1600 * mountU * smoothstep(-0.05, 0.05, c);

// plates：算不算板块边界。只有地形脚本真的算了的那一遍（crustMode 'replace'）才不算
function sampleRaw(m: PlanetModel, ns: NoiseSet3, x: number, y: number, z: number, s: CellSample, plates: boolean) {
  const prof = m.profile;
  const t = m.tuning;
  const [qx, qy, qz] = warp(ns, x, y, z);
  // c：定海陆的大陆场；cs：“形状”场；(nqx, nqy, nqz)：大陆的噪声在哪里取（见 generate.ts 的 sampleInto）
  let c = -1;
  let cs = -1;
  let nqx = qx;
  let nqy = qy;
  let nqz = qz;
  let reliefW = 1;
  let esc = 0;
  let isW = 0;
  let ridgeR = 0;
  let ageR = 1;
  if (m.blocks.length) {
    // 大陆场，顺带缝合线（第三十二轮）
    blockPair(m, ns.rift, qx, qy, qz, BP);
    const nr = m.rifts.length;
    const kb = nr ? BP.best : -1;
    if (kb >= 0) {
      // 这一族占上风、又离它不远（范围的边上场 < −1，渐渐不用漂移前的位置，不出接缝）
      const wN = smoothstep(-0.15, 0.15, BP.fk[kb] - BP.oth) * smoothstep(-0.6, -0.35, BP.fk[kb]);
      nqx = qx + wN * (DS.px[kb] - qx);
      nqy = qy + wN * (DS.py[kb] - qy);
      nqz = qz + wN * (DS.pz[kb] - qz);
      reliefW = 1 - wN * (1 - reliefNear(DS.x[kb]));
      esc = wN * escNear(DS.x[kb]);
    }
    const f = 1 / Math.max(0.1, m.meanR);
    const N = 0.42 * fbm3(ns.block, nqx, nqy, nqz, 1.5 * f, 4, 0.55) + 0.18 * fbm3(ns.hills, nqx + 9.1, nqy - 4.3, nqz, 6 * f, 4, 0.62);
    if (!nr) {
      c = BP.s1 + N;
      cs = c;
    } else {
      c = BP.oth + N;
      cs = c;
      for (let k = 0; k < nr; k++) {
        if (!DS.inb[k]) continue;
        const v = BP.fk[k] + N;
        c = Math.max(c, Math.min(v, eHard(DS.x[k], DS.ws[k], DS.wsl[k])));
        cs = Math.max(cs, Math.min(v, eSoft(DS.x[k], DS.ws[k], DS.wsl[k])));
        // 缝里的洋中脊（两侧海底的年龄对称）
        const r = m.rifts[k];
        const open = ridgeOpen(DS.disp[k]) * (1 - smoothstep(0.75, 1, Math.hypot(qx - r.cb[0], qy - r.cb[1], qz - r.cb[2]) / r.R));
        if (open > 0) {
          const uq = DS.uq[k];
          ridgeR = Math.max(ridgeR, open * Math.exp(-((uq / RIDGE_W) ** 2)));
          ageR = Math.min(ageR, Math.abs(uq) + 0.5 * (1 - open));
        }
      }
    }
    // 地峡只在原来的噪声里有：重新生成一片（另一套噪声）圈到地峡上时它跟着重新生成（可能断开）
    if (m.isthmi.length && ns === m.noise) {
      isthmiAt(m, qx, qy, qz);
      if (IW.c > c) c = IW.c;
      if (IW.c > cs) cs = IW.c;
      isW = IW.w;
      reliefW *= 1 - 0.7 * isW;
    }
  }

  // 地壳：大陆架 → 陆坡 → 深海（与 generate.ts 相同）
  const slopeW = 0.08;
  let B: number;
  if (c >= 0) B = -140 + 650 * Math.min(c, 0.16) + prof.rise * Math.max(0, c - 0.16);
  else if (c >= -slopeW) B = -140 - 3800 * smoothstep(0, 1, -c / slopeW);
  else B = -3940;
  const rw = smoothstep(-slopeW, 0.06, c);
  B += prof.relief * rw * reliefW * fbm3(ns.relief, nqx, nqy, nqz, 2.6, 9, 0.62);
  B += 230 * (1 - rw) * fbm3(ns.ocean, qx, qy, qz, 5, 4);

  // 板块边界：在更弯曲的坐标里求
  const px = qx + 0.07 * fbm3(ns.seg, qx + 11.3, qy, qz, 1.7, 3) + 0.022 * fbm3(ns.ridge, qx, qy + 4.4, qz, 5.5, 2);
  const py = qy + 0.07 * fbm3(ns.seg, qx, qy - 7.9, qz, 1.7, 3) + 0.022 * fbm3(ns.ridge, qx - 2.2, qy, qz, 5.5, 2);
  const pz = qz + 0.07 * fbm3(ns.seg, qx, qy, qz + 6.1, 1.7, 3) + 0.022 * fbm3(ns.ridge, qx, qy, qz - 3.3, 5.5, 2);
  const oceanW = 1 - smoothstep(-0.12, 0, cs);
  const contW = smoothstep(-0.02, 0.1, cs);
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
  // 到最近的离散边界的距离（按扩张速度缩放）：洋壳的年龄
  let age = 1;
  // 裂谷轴（窄）、裂谷肩（两侧）：离交界很近，按 bd
  let riftAxis = 0;
  let shoulder = 0;
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
        // 裂开的两半之间：洋中脊、裂谷按裂谷线画（ridgeR、ageR），不按板块的平分线
        if (pb.sib === a) continue;
        const div = Math.min(1, -conv);
        ridge = Math.max(ridge, div * Math.exp(-((bd / 0.04) ** 2)));
        rift = Math.max(rift, div * Math.exp(-((bd / 0.025) ** 2)));
        riftAxis = Math.max(riftAxis, div * Math.exp(-((bd / RIFT_W) ** 2)));
        shoulder = Math.max(shoulder, div * Math.exp(-(((bd - 0.042) / 0.018) ** 2)));
        age = Math.min(age, bd / (0.45 + 0.55 * div));
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
  ridge = Math.max(ridge, ridgeR);
  age = Math.min(age, ageR);
  B += t.ridgeH * ridge * oceanW - t.riftH * rift * contW * (1 - isW) - t.trenchH * trench * oceanW;
  const mountU0 = mm * (0.3 + 0.7 * seg) * (0.55 + 0.6 * ridged);
  // 老山（第三十二轮）：两块相接处与块内的缝合线上低矮的抬升（放在丘陵里：不改地壳高度、不改海陆）；沿缝合线的岩性条纹。
  // 算板块时才有（crustMode 'replace' 的地形完全由脚本决定）
  let suture = 0;
  let stripe = 0;
  if (plates && m.blocks.length) {
    const gap = BP.s1 - BP.s2;
    const pair = smoothstep(0.0, 0.08, BP.s2);
    const inner = smoothstep(0.1, 0.3, BP.innerS);
    const pz2 = pair * Math.exp(-((gap / 0.07) ** 2));
    const iz2 = inner * Math.exp(-((BP.inner / 0.05) ** 2));
    suture = Math.max(pair * Math.exp(-((gap / 0.035) ** 2)), inner * Math.exp(-((BP.inner / 0.025) ** 2)));
    stripe = Math.max(pz2, iz2) * Math.sin(((pz2 >= iz2 ? gap : BP.inner) / 0.022) * Math.PI * 2);
  }
  // 老山的抬升放在丘陵里（不改造山带、不改地壳高度，地形脚本照原样返回时与没有脚本逐位相同）
  const oldU = 0.22 * suture * ridged * contW;
  // 大格局：基准面、高原、洼地、岩性的倍数（板块来的几项在 replace 时是 0）
  if (plates) {
    const pl = Math.hypot(px, py, pz) || 1;
    const lat = Math.asin(Math.max(-1, Math.min(1, pz / pl)));
    const lon = Math.atan2(py, px);
    sampleTectonics(tectonicsOf(m), ((lon + Math.PI) / (2 * Math.PI)) * TW - 0.5, ((Math.PI / 2 - lat) / Math.PI) * TH - 0.5, TS);
  }
  let swellR = 9;
  let swellH = 0;
  if (m.swells.length) {
    const wob = 1 + 0.25 * fbm3(ns.plat, qx - 3.3, qy + 8.8, qz, 6, 2);
    for (const sp of m.swells) {
      const r = (Math.hypot(qx - sp.c[0], qy - sp.c[1], qz - sp.c[2]) * wob) / sp.r;
      if (r < swellR) {
        swellR = r;
        swellH = sp.h;
      }
    }
  }
  RI.c = cs;
  RI.contW = contW;
  RI.widthMod = widthMod;
  // 大陆的低频噪声在漂移前的位置上取；高原分段、裂谷分段跟着板块
  RI.nBase = fbm3(ns.big, nqx, nqy, nqz, 2.2, 3);
  RI.nPlat = fbm3(ns.plat, qx, qy, qz, 3, 2);
  RI.nPlatW = fbm3(ns.plat, qx + 5.3, qy - 2.1, qz, 2, 2);
  RI.nEsc = fbm3(ns.big, nqx - 7.7, nqy + 3.3, nqz, 3, 2);
  RI.nSag = fbm3(ns.sag, nqx, nqy, nqz, 2.6, 3);
  RI.nRift = fbm3(ns.sag, qx + 4.4, qy - 6.6, qz, 3.5, 2);
  RI.swellR = swellR;
  RI.swellH = swellH;
  RI.riftAxis = riftAxis * contW;
  RI.shoulder = shoulder;
  RI.plates = plates;
  RI.esc = esc;
  reliefAt(RI, RO);
  s.B = B;
  s.mountB = mountBOf(mountU0, cs);
  s.mountU = mountU0;
  s.hillU = t.hills * Math.max(0, fbm3(ns.hills, nqx, nqy, nqz, 6, 4)) * contW + oldU;
  s.erod = clamp((1 + 0.45 * fbm3(ns.erod, x + 7.7, y - 3.1, z + 1.9, 6, 3)) * RO.erodMul * (1 + 0.45 * stripe), 0.4, 1.8);
  s.T = RO.T;
  s.Tp = RO.Tp;
  s.pit = RO.pit;
  s.rift = RO.rift;
  s.c = cs;
  s.sea = oceanFloor(age, trench, t.ridgeH, t.trenchH, fbm3(ns.ocean, qx - 4.1, qy + 2.3, qz + 1.1, 3, 4), fbm3(ns.ocean, qx + 6.2, qy - 8.4, qz - 0.7, 24, 3));
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
  sea: Float64Array;
  T: Float64Array;
  Tp: Float64Array;
  pit: Float64Array;
  rift: Float64Array;
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
    raw.sea[i] = S.sea;
    raw.T[i] = S.T;
    raw.Tp[i] = S.Tp;
    raw.pit[i] = S.pit;
    raw.rift[i] = S.rift;
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
  const raw: RawPass = {
    B: new Float64Array(n),
    mountB: new Float64Array(n),
    mountU: new Float64Array(n),
    hillU: new Float64Array(n),
    erod: new Float64Array(n),
    c: new Float64Array(n),
    sea: new Float64Array(n),
    T: new Float64Array(n),
    Tp: new Float64Array(n),
    pit: new Float64Array(n),
    rift: new Float64Array(n),
  };
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
    out.sea[i] = raw.sea[i];
    out.T[i] = raw.T[i];
    out.Tp[i] = raw.Tp[i];
    out.pit[i] = raw.pit[i];
    out.rift[i] = raw.rift[i];
    out.seaB0[i] = out.b0[i];
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
      out.sea[i] += (Math.fround(raw.sea[i]) - out.sea[i]) * w;
      out.T[i] += (Math.fround(raw.T[i]) - out.T[i]) * w;
      out.Tp[i] += (Math.fround(raw.Tp[i]) - out.Tp[i]) * w;
      out.pit[i] += (Math.fround(raw.pit[i]) - out.pit[i]) * w;
      out.rift[i] += (Math.fround(raw.rift[i]) - out.rift[i]) * w;
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
