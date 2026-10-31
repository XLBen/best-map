import { z } from 'zod';
import type { Mesh } from './mesh';
import { type ReliefInput, type ReliefOut, RIFT_W, type TectonicRaster, type TectonicSample, buildTectonics, cachedTectonics, reliefAt, sampleTectonics } from './relief';
import { planetFormSchema } from './planet-form';
import { ISTHMUS_PAD, RIDGE_W, SHELF, WIGGLE, closeGap, eHard, eSoft, escNear, isthmusC, isthmusW, reliefNear, ridgeOpen, shelfWidth, triWidth } from './outline';
import { type Noise2, clamp, fbm, gradientNoise, mixSeed, mulberry32, smoothstep } from './rng';
import type { ScriptIssue } from './script';
import { WORLD_TYPES, type WorldType } from './world-types';

// 随机世界：先造“地壳高度”，再定海平面。
//   大陆块（不规则、带域扭曲与分形起伏）→ 大陆架、陆坡、深海
//   板块边界 → 洋中脊、海沟、裂谷、分段的造山带（含次级山脉与高原）
//   火山锥（热点岛链、岛弧、海山），高度取重尾分布 → 岛屿大小自然呈幂律
// 可预期性：
//   · 所有随机都按地图上的位置取，结果与格数无关（4000 格的缩略图与 4 万格的成品格局一致）
//   · 陆地比例只决定海平面（陆地多少单调嵌套）；“岛多少”只增减排好序的火山锥；“山多高”只缩放造山带

// 定义在 world-types.ts（星球形态的 schema 也要用，见那里的说明）；这里照旧导出
export { WORLD_TYPES, type WorldType };

export const WORLD_TYPE_INFO: Record<WorldType, { name: string; hint: string }> = {
  archipelago: { name: '群岛之海', hint: '大片海洋里散布着大大小小的岛，有火山岛链' },
  continent: { name: '一块大陆', hint: '一块主大陆，周围有些岛屿' },
  continents: { name: '几块大陆', hint: '像地球：几块大小不一的大陆和许多岛' },
  fragmented: { name: '破碎大陆', hint: '浅海上的破碎陆地，像东南亚或爱琴海' },
  inland_sea: { name: '内海', hint: '陆地环抱着一片内海，像地中海' },
  ocean: { name: '空白海洋', hint: '一片海，自己来画' },
};

export const rerollSchema = z.object({
  x: z.number(),
  y: z.number(),
  // 半径（地图单位）
  radius: z.number().positive(),
  variant: z.number().int().min(1),
});
export type Reroll = z.output<typeof rerollSchema>;

export const worldgenSchema = z.object({
  seed: z.number().int().min(0).max(0xffffffff).default(1),
  type: z.enum(WORLD_TYPES).default('continents'),
  // 省略时取世界类型的默认值
  landFraction: z.number().min(0).max(0.85).optional(),
  islands: z.number().min(0).max(1).optional(),
  mountains: z.number().min(0).max(2).default(1),
  rerolls: z.array(rerollSchema).default([]),
  // 星球形态（第八轮第三批，只用于整个星球）：从 type 这种星球改起的参数与脚本。没有时解析结果与以前逐字节相同
  form: planetFormSchema.optional(),
});
export type Worldgen = z.output<typeof worldgenSchema>;
export type WorldgenInput = z.input<typeof worldgenSchema>;

interface Profile {
  landFraction: number;
  islands: number;
  plates: [number, number];
  // 大陆块：个数、半径（地图高度为 1 的单位）
  blocks: [number, number];
  radius: [number, number];
  // 主块（“一块大陆”）
  main?: [number, number];
  // 大陆从海岸往内陆抬升的快慢（m / 单位大陆场）与近地表起伏幅度（m）
  rise: number;
  relief: number;
  hotspots: [number, number];
  seamounts: number;
  ring?: boolean;
}

const PROFILES: Record<WorldType, Profile> = {
  continents: { landFraction: 0.32, islands: 0.6, plates: [8, 12], blocks: [4, 6], radius: [0.14, 0.3], rise: 1500, relief: 620, hotspots: [2, 4], seamounts: 130 },
  continent: { landFraction: 0.3, islands: 0.35, plates: [6, 9], blocks: [1, 3], radius: [0.07, 0.14], main: [0.4, 0.48], rise: 1500, relief: 620, hotspots: [1, 3], seamounts: 70 },
  archipelago: { landFraction: 0.13, islands: 0.8, plates: [6, 9], blocks: [11, 16], radius: [0.045, 0.12], rise: 700, relief: 620, hotspots: [3, 5], seamounts: 150 },
  fragmented: { landFraction: 0.28, islands: 0.55, plates: [10, 14], blocks: [9, 14], radius: [0.08, 0.2], rise: 650, relief: 720, hotspots: [2, 3], seamounts: 110 },
  inland_sea: { landFraction: 0.45, islands: 0.3, plates: [6, 8], blocks: [6, 8], radius: [0.16, 0.23], rise: 1400, relief: 600, hotspots: [1, 2], seamounts: 50, ring: true },
  ocean: { landFraction: 0, islands: 0, plates: [6, 9], blocks: [0, 0], radius: [0.1, 0.2], rise: 1000, relief: 300, hotspots: [3, 5], seamounts: 140 },
};

export function resolvedParams(p: Worldgen): Worldgen & { landFraction: number; islands: number } {
  const prof = PROFILES[p.type];
  return { ...p, landFraction: p.landFraction ?? prof.landFraction, islands: p.islands ?? prof.islands };
}

interface Plate {
  x: number;
  y: number;
  vx: number;
  vy: number;
  // 功率图权重：让板块大小不一
  weight: number;
  // 洋壳密度：汇聚时密度大的一侧俯冲
  density: number;
  // 第三十五轮：裂开的大陆块两半的板块互为 sib（它们之间的离散交界按裂谷线画，不按板块的平分线），别的是 −1
  sib: number;
}

interface Block {
  x: number;
  y: number;
  r: number;
  e: number;
  cos: number;
  sin: number;
  // 属于哪一块（半岛的瓣算它的母块）：缝合线只在不同的块之间
  fam: number;
  // 第三十五轮：三角形的半岛（往外收窄的程度，0 是椭圆）
  tri: number;
}

// 第三十五轮：裂开、漂移的大陆块（见 outline.ts）。漂移前的坐标系：裂谷线过 (ox, oy)、沿 (tx, ty)，法向 (nx, ny) 指向 + 那一半，
// 弯曲 kappa（u = 法向距离 + kappa·沿线距离² + 噪声）；两半绕极 (px, py) 各转 ±phi（phi 的正负已定好：+ 那一半转 +phi 往 +n 走），
// 离极沿 (mx, my) 不到 ramp 时渐渐不转；D：块中心处两半分开多远；(cx, cy, R)：漂移后这一族块可能到的范围
export interface Rift {
  fam: number;
  ox: number;
  oy: number;
  tx: number;
  ty: number;
  nx: number;
  ny: number;
  kappa: number;
  px: number;
  py: number;
  mx: number;
  my: number;
  phi: number;
  ramp: number;
  D: number;
  red: boolean;
  cx: number;
  cy: number;
  R: number;
}

// 第三十五轮：块与块之间的地峡（折线 pts：x0, y0, x1, y1……；半宽 w；累计长度 cum；外接圆）
export interface Isthmus {
  pts: Float64Array;
  cum: Float64Array;
  w: number;
  cx: number;
  cy: number;
  R: number;
}

// 块内的老缝合线（第三十二轮）：块的局部坐标里一条直线（方向、离中心的偏移，按块半径）
interface SutureLine {
  block: number;
  cos: number;
  sin: number;
  off: number;
}

// 带陡崖的穹隆（第三十二轮）
interface SwellSpot {
  x: number;
  y: number;
  r: number;
  h: number;
}

export interface Cone {
  x: number;
  y: number;
  r: number;
  h: number;
  rank: number;
  kind: 'hotspot' | 'arc' | 'seamount';
}

interface NoiseSet {
  warpA: Noise2;
  warpB: Noise2;
  warpC: Noise2;
  warpD: Noise2;
  block: Noise2;
  relief: Noise2;
  ocean: Noise2;
  seg: Noise2;
  ridge: Noise2;
  hills: Noise2;
  erod: Noise2;
  cone: Noise2;
  // 第三十二轮：大格局的低频噪声（盆地与隆起、高原分段、洼地）
  big: Noise2;
  plat: Noise2;
  sag: Noise2;
  // 第三十五轮：裂谷线的弯曲
  rift: Noise2;
}

function noiseSet(seed: number, variant: number): NoiseSet {
  const n = (k: number) => gradientNoise(mixSeed(seed, variant, k));
  return { warpA: n(1), warpB: n(2), warpC: n(3), warpD: n(4), block: n(5), relief: n(6), ocean: n(7), seg: n(8), ridge: n(9), hills: n(10), erod: n(11), cone: n(12), big: n(13), plat: n(14), sag: n(15), rift: n(16) };
}

export interface GenModel {
  kind?: undefined;
  params: ReturnType<typeof resolvedParams>;
  profile: Profile;
  width: number;
  height: number;
  plates: Plate[];
  blocks: Block[];
  meanR: number;
  // 全部火山锥，按排序：“岛多少”取前 N 个
  cones: Cone[];
  noise: NoiseSet;
  variants: Map<number, NoiseSet>;
  // 第三十二轮：块内的缝合线、穹隆；板块的栅格（第一次采样时建，按种子与类型缓存）
  sutures: SutureLine[];
  swells: SwellSpot[];
  tect?: TectonicRaster;
  // 第三十五轮：裂开的块、每一族（母块的编号）对应哪一处裂开（没有是 −1）、地峡
  rifts: Rift[];
  famRift: number[];
  isthmi: Isthmus[];
}

const range = (rand: () => number, [a, b]: [number, number]) => a + (b - a) * rand();
const irange = (rand: () => number, [a, b]: [number, number]) => a + Math.floor((b - a + 1) * rand());

export function buildModel(input: WorldgenInput, width: number, height = 1): GenModel {
  const params = resolvedParams(worldgenSchema.parse(input));
  const profile = PROFILES[params.type];
  const seed = params.seed;
  const noise = noiseSet(seed, 0);

  const randP = mulberry32(mixSeed(seed, 101));
  const plates: Plate[] = [];
  const plateCount = irange(randP, profile.plates);
  for (let k = 0; k < plateCount; k++) {
    const a = randP() * Math.PI * 2;
    const sp = 0.35 + 0.65 * randP();
    plates.push({ x: randP() * width, y: randP() * height, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, weight: randP() * 0.03, density: randP(), sib: -1 });
  }

  const randB = mulberry32(mixSeed(seed, 102));
  const blocks: Block[] = [];
  const addBlock = (x: number, y: number, r: number, e: number) => {
    const a = randB() * Math.PI;
    blocks.push({ x, y, r, e, cos: Math.cos(a), sin: Math.sin(a), fam: blocks.length, tri: 0 });
  };
  if (profile.ring) {
    const cx = width / 2;
    const cy = height / 2;
    const ringR = 0.3 + 0.04 * randB();
    const count = irange(randB, profile.blocks);
    for (let k = 0; k < count; k++) {
      const a = (k / count) * Math.PI * 2 + randB() * 0.5;
      addBlock(cx + Math.cos(a) * ringR * 1.35, cy + Math.sin(a) * ringR, range(randB, profile.radius), 1 + 0.5 * randB());
    }
  } else {
    // 先定半径：按世界类型的默认陆地比例统一缩放（用类型默认值而不是滑块值，拖“陆地多少”时格局不变）。
    // 随机出来的块太小时陆地凑不够，海平面又不能降进深海
    const count = irange(randB, profile.blocks);
    const radii: number[] = [];
    if (profile.main) radii.push(range(randB, profile.main));
    for (let k = 0; k < count; k++) radii.push(range(randB, profile.radius));
    let area = 0;
    for (const r of radii) area += Math.PI * r * r;
    const scale = Math.min(1.6, Math.max(0.75, Math.sqrt((profile.landFraction * width * height * 1.8) / area)));
    radii.forEach((r0, k) => {
      const r = r0 * scale;
      // 再找位置：16 个候选里挑离已有块边缘最远的，几块大陆之间留出大洋，而不是连成一整块
      let best: [number, number] = [width / 2, height / 2];
      let bestScore = -Infinity;
      for (let t = 0; t < 16; t++) {
        const x = width * (0.08 + 0.84 * randB());
        const y = height * (0.1 + 0.8 * randB());
        let near = 1;
        for (const b of blocks) near = Math.min(near, Math.hypot(x - b.x, y - b.y) - 1.25 * (r + b.r));
        const score = near + randB() * 0.03;
        if (score > bestScore) {
          bestScore = score;
          best = [x, y];
        }
      }
      // 小陆块拉长了就成了细棍，限制它的长宽比
      const e = profile.main && k === 0 ? 1 + 0.35 * randB() : 1 + (r < 0.12 ? 0.3 : 0.6) * randB();
      addBlock(best[0], best[1], r, e);
    });
  }
  const meanR = blocks.length ? blocks.reduce((s, b) => s + b.r, 0) / blocks.length : 0.2;
  // 半岛：大陆块向外伸出的狭长瓣（像斯堪的纳维亚、意大利、朝鲜半岛），中尺度的轮廓因此有伸有缩
  const randL = mulberry32(mixSeed(seed, 104));
  // 第三十五轮：四成的半岛是三角形（另一串随机数，半岛的位置、大小不变）
  const randT = mulberry32(mixSeed(seed, 107));
  const parents = blocks.slice();
  for (const b of parents) {
    if (b.r < 0.12) continue;
    const lobes = 1 + Math.floor(randL() * 3);
    for (let k = 0; k < lobes; k++) {
      const a = randL() * Math.PI * 2;
      const dist = b.r * (0.75 + 0.35 * randL());
      const lr = b.r * (0.22 + 0.22 * randL());
      const e = 1.8 + 1.4 * randL();
      // 瓣沿径向拉长：e 作用在块的局部 u 轴上，所以把方向设成径向
      const tri = randT() < 0.4 ? 0.7 + 0.2 * randT() : 0;
      blocks.push({ x: b.x + Math.cos(a) * dist, y: b.y + Math.sin(a) * dist, r: lr, e, cos: Math.cos(a), sin: Math.sin(a), fam: b.fam, tri });
    }
  }
  // 第三十二轮：块内的老缝合线（较大的块里 0–1 条）、带陡崖的穹隆（另一串随机数，前面的格局不变）
  const randS = mulberry32(mixSeed(seed, 105));
  const sutures: SutureLine[] = [];
  parents.forEach((b, k) => {
    if (b.r < 0.15 || randS() < 0.4) return;
    const a = randS() * Math.PI;
    sutures.push({ block: k, cos: Math.cos(a), sin: Math.sin(a), off: (randS() - 0.5) * 0.8 });
  });
  const swells: SwellSpot[] = [];
  const bigOnes = parents.filter((b) => b.r >= 0.1);
  const swellCount = bigOnes.length ? 1 + Math.floor(randS() * Math.min(4, 1 + bigOnes.length / 2)) : 0;
  for (let k = 0; k < swellCount; k++) {
    const b = bigOnes[Math.floor(randS() * bigOnes.length)];
    const a = randS() * Math.PI * 2;
    const d = b.r * 0.6 * Math.sqrt(randS());
    swells.push({ x: b.x + Math.cos(a) * d, y: b.y + Math.sin(a) * d, r: 0.06 + 0.07 * randS(), h: 700 + 700 * randS() });
  }

  const model: GenModel = { params, profile, width, height, plates, blocks, meanR, cones: [], noise, variants: new Map(), sutures, swells, rifts: [], famRift: parents.map(() => -1), isthmi: [] };
  // 第三十五轮：裂开、漂移的大陆块（板块跟着碎块走）、块与块之间的地峡（各自另一串随机数）
  buildRifts(model, parents.length, mulberry32(mixSeed(seed, 106)));
  buildIsthmi(model, parents.length, mulberry32(mixSeed(seed, 108)));
  model.cones = buildCones(model);
  return model;
}

// ---------- 第三十五轮：裂开的大陆块与地峡（见 outline.ts） ----------

// 一个块的场（1 在中心，0 在边上）；三角形的半岛往外收窄
function blockF(b: Block, x: number, y: number): number {
  const dx = x - b.x;
  const dy = y - b.y;
  const se = Math.sqrt(b.e);
  const u = (dx * b.cos + dy * b.sin) / se;
  let v = (-dx * b.sin + dy * b.cos) * se;
  if (b.tri > 0) v /= triWidth(u / b.r, b.tri);
  return 1 - Math.hypot(u, v) / b.r;
}

// 一点相对一处裂开：在不在范围里、哪一半、漂移前的位置、往这一半里面量的离切口的距离、大陆架与陆坡的宽
const MAX_RIFTS = 8;
interface DriftState {
  inb: Uint8Array;
  sg: Float64Array;
  uq: Float64Array;
  px: Float64Array;
  py: Float64Array;
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
  x: new Float64Array(MAX_RIFTS),
  disp: new Float64Array(MAX_RIFTS),
  ws: new Float64Array(MAX_RIFTS),
  wsl: new Float64Array(MAX_RIFTS),
});
// 采样用的一份、famField / blockField 用的一份（采样时 blockField 也要算，不能共用）
const DS = driftState();
const DF = driftState();

// 漂移前的坐标系里离裂谷线的 u（wig 为 null 时不加弯曲噪声：只给“哪边是大陆”这类粗略的判断用）
function riftU(r: Rift, wig: Noise2 | null, x: number, y: number): number {
  const ax = x - r.ox;
  const ay = y - r.oy;
  const along = ax * r.tx + ay * r.ty;
  let u = ax * r.nx + ay * r.ny + r.kappa * along * along;
  if (wig) u += WIGGLE.amp * fbm(wig, x, y, WIGGLE.freq, WIGGLE.oct, WIGGLE.gain);
  return u;
}

function riftAt(r: Rift, wig: Noise2 | null, qx: number, qy: number, k: number, o: DriftState) {
  const dx = qx - r.cx;
  const dy = qy - r.cy;
  if (dx * dx + dy * dy >= r.R * r.R) {
    o.inb[k] = 0;
    return;
  }
  o.inb[k] = 1;
  const uq = riftU(r, wig, qx, qy);
  const sg = uq >= 0 ? 1 : -1;
  const ex = qx - r.px;
  const ey = qy - r.py;
  const phi = sg * r.phi * smoothstep(0, r.ramp, ex * r.mx + ey * r.my);
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  // 转回漂移前（−phi）
  const Px = r.px + c * ex + s * ey;
  const Py = r.py - s * ex + c * ey;
  const disp = Math.hypot(qx - Px, qy - Py);
  o.uq[k] = uq;
  o.sg[k] = sg;
  o.px[k] = Px;
  o.py[k] = Py;
  o.disp[k] = disp;
  o.x[k] = closeGap(sg * riftU(r, wig, Px, Py), disp);
  o.ws[k] = shelfWidth(disp, SHELF.wsMax, SHELF.wsK);
  o.wsl[k] = shelfWidth(disp, SHELF.wslMax, SHELF.wslK);
}

function prepRifts(m: GenModel, wig: Noise2 | null, qx: number, qy: number, o: DriftState) {
  const rifts = m.rifts;
  for (let k = 0; k < rifts.length; k++) riftAt(rifts[k], wig, qx, qy, k, o);
}

// 漂移前的一点 (x, y) 在 sg 那一半上漂移后的位置（建模型时用：转的角度按漂移前的位置取，与逐点的逆映射差一点点）
function driftForward(r: Rift, sg: number, x: number, y: number): [number, number] {
  const ex = x - r.px;
  const ey = y - r.py;
  const phi = sg * r.phi * smoothstep(0, r.ramp, ex * r.mx + ey * r.my);
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  return [r.px + c * ex - s * ey, r.py + s * ex + c * ey];
}

// 地峡：到折线的距离与沿线的位置（0–1）
const IS = { d: 0, t: 0 };
function isthmusDist(l: Isthmus, x: number, y: number) {
  const p = l.pts;
  let best = Infinity;
  let bt = 0;
  for (let s = 0; s + 3 < p.length; s += 2) {
    const ax = p[s];
    const ay = p[s + 1];
    const bx = p[s + 2] - ax;
    const by = p[s + 3] - ay;
    const L2 = bx * bx + by * by || 1e-12;
    const t = Math.max(0, Math.min(1, ((x - ax) * bx + (y - ay) * by) / L2));
    const dx = x - ax - t * bx;
    const dy = y - ay - t * by;
    const d = dx * dx + dy * dy;
    if (d < best) {
      best = d;
      const seg = s >> 1;
      bt = (l.cum[seg] + t * (l.cum[seg + 1] - l.cum[seg])) / l.cum[l.cum.length - 1];
    }
  }
  IS.d = Math.sqrt(best);
  IS.t = bt;
}

// 一族块（母块 fam 与它的半岛）漂移后在 (x, y) 处的场（不含噪声；裂开的按切口截，不加弯曲噪声）
function famField(m: GenModel, fam: number, x: number, y: number): number {
  const k = m.famRift[fam];
  const F = famsOf(m);
  if (k >= 0) {
    riftAt(m.rifts[k], null, x, y, k, DF);
    if (!DF.inb[k]) return -1;
  } else {
    // 离这一族的范围以外场 < −1（不改最大值）：不算
    const dx = x - F.cx[fam];
    const dy = y - F.cy[fam];
    if (dx * dx + dy * dy > F.reach[fam] * F.reach[fam]) return -1;
  }
  let c = -1;
  for (const b of F.blocks[fam]) {
    const s = k < 0 ? blockF(b, x, y) : Math.min(blockF(b, DF.px[k], DF.py[k]), eHard(DF.x[k], DF.ws[k], DF.wsl[k]));
    if (s > c) c = s;
  }
  return c;
}

// 漂移前一族块的场（不截）
function famFieldPre(m: GenModel, fam: number, x: number, y: number): number {
  let c = -1;
  for (const b of famsOf(m).blocks[fam]) c = Math.max(c, blockF(b, x, y));
  return c;
}

// 每一族的块（按原来的先后）与漂移前的范围（母块中心起；范围外场 < −1），建模型时按块的数组缓存
interface Fams {
  blocks: Block[][];
  cx: number[];
  cy: number[];
  reach: number[];
}
const famCache = new WeakMap<Block[], Fams>();
function famsOf(m: GenModel): Fams {
  let F = famCache.get(m.blocks);
  if (!F) {
    const n = m.famRift.length;
    F = { blocks: Array.from({ length: n }, () => []), cx: [], cy: [], reach: [] };
    for (const b of m.blocks) F.blocks[b.fam].push(b);
    for (let f = 0; f < n; f++) {
      F.cx.push(m.blocks[f].x);
      F.cy.push(m.blocks[f].y);
      F.reach.push(famReach(m, f, m.blocks[f].x, m.blocks[f].y));
    }
    famCache.set(m.blocks, F);
  }
  return F;
}

// 这一族块漂移前的范围（离裂谷线原点；场 > −1.1 的地方都在里面：范围外加上噪声也是深海）
function famReach(m: GenModel, fam: number, ox: number, oy: number): number {
  let reach = 0;
  for (const o of m.blocks) {
    if (o.fam !== fam) continue;
    const se = Math.sqrt(o.e);
    reach = Math.max(reach, Math.hypot(o.x - ox, o.y - oy) + 2.1 * o.r * Math.max(se, 1 / se) * (o.tri ? 1.3 : 1));
  }
  return reach;
}

// 一处裂开的候选：块 b 的第 t 个方向、红海一类（red）或大西洋一类、块中心处分开 D（draws：这个块的几个随机数）
function riftCandidate(m: GenModel, fam: number, b: Block, draws: number[], red: boolean, t: number, D: number): { r: Rift; reach: number } {
  const se = Math.sqrt(b.e);
  const ang = (draws[3] + t * 0.25) * Math.PI;
  const tx = Math.cos(ang);
  const ty = Math.sin(ang);
  const nx = -ty;
  const ny = tx;
  const off = (draws[4] - 0.5) * 0.4 * b.r;
  const ox = b.x + nx * off;
  const oy = b.y + ny * off;
  const kappa = ((draws[5] - 0.5) * 1.6) / b.r;
  const delta = red ? b.r * se * (0.8 + 0.5 * draws[6]) : b.r * (3 + 3 * draws[6]);
  const end = draws[7] < 0.5 ? 1 : -1;
  const px = ox + tx * delta * end;
  const py = oy + ty * delta * end;
  const mx = -tx * end;
  const my = -ty * end;
  // + 那一半转 +phi 要往 +n 走：(o − 极) 逆时针转 90° 与 n 同向时 phi 为正
  const sgn = Math.sign(-(oy - py) * nx + (ox - px) * ny) || 1;
  const reach = famReach(m, fam, ox, oy);
  const phi = sgn * (D / (2 * delta));
  return { r: { fam, ox, oy, tx, ty, nx, ny, kappa, px, py, mx, my, phi, ramp: 0.4 * delta, D, red, cx: ox, cy: oy, R: reach + Math.abs(phi) * (delta + reach) + 0.05 }, reach };
}

// 裂开（随机数每个够大的块取固定的几个，不管成不成：后面的块的格局不随前面的成败变）。
// 先按抽到的一类试四个方向，取开得最大的（开不到想要的就小一些，红海一类最小 0.02、大西洋一类最小 0.06）；
// 大西洋一类哪个方向都开不了时（会压到别的块上）改成红海一类再试；还不行就不裂（不压过去：几块大陆连成一块时最大的陆块
// 占到陆地的九成以上；最窄的红海一类在星球上只有两格宽，两岸对不准）
function buildRifts(m: GenModel, parentCount: number, rand: () => number) {
  const { blocks, profile } = m;
  for (let fam = 0; fam < parentCount; fam++) {
    const b = blocks[fam];
    const draws = Array.from({ length: 8 }, () => rand());
    if (b.r < 0.14 || draws[0] >= 0.5 || (profile.main && fam === 0) || m.rifts.length >= MAX_RIFTS) continue;
    let made: Rift | null = null;
    for (const red of draws[1] < 0.5 ? [true] : [false, true]) {
      const want = red ? 0.02 + 0.03 * draws[2] : 0.15 + 0.25 * draws[2];
      const minD = red ? 0.02 : 0.06;
      for (let t = 0; t < 4 && !(made && made.D >= want); t++) {
        for (let D = want; D >= minD - 1e-9; D = D > minD && D * 0.75 < minD ? minD : D * 0.75) {
          if (made && D <= made.D) break;
          const { r, reach } = riftCandidate(m, fam, b, draws, red, t, D);
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
  // 穹隆跟着它所在的那一半走
  for (const s of m.swells) {
    for (const r of m.rifts) {
      if (famFieldPre(m, r.fam, s.x, s.y) < -0.2) continue;
      [s.x, s.y] = driftForward(r, riftU(r, null, s.x, s.y) >= 0 ? 1 : -1, s.x, s.y);
      break;
    }
  }
}

// 漂移前这一族块的格点（场 > −0.1），带上在哪一半
function famSamples(m: GenModel, r: Rift, reach: number): { x: number; y: number; f: number; sg: number }[] {
  const out: { x: number; y: number; f: number; sg: number }[] = [];
  const step = reach / 16;
  for (let i = -16; i <= 16; i++) {
    for (let j = -16; j <= 16; j++) {
      const x = r.ox + i * step;
      const y = r.oy + j * step;
      const f = famFieldPre(m, r.fam, x, y);
      if (f > -0.1) out.push({ x, y, f, sg: riftU(r, null, x, y) >= 0 ? 1 : -1 });
    }
  }
  return out;
}

// 漂移后不压到别的块上：每个格点移过去以后，别的块（已经裂开的按漂移后）的场 < −0.3（加上噪声也多半是海），或者不比没移时大 0.02 以上
// （本来就挨着别的块的地方照样能裂）
// 格点与没移时别的块的场只取决于方向（裂谷线的原点、弯曲），按方向记下（同一个方向试几个 D 时不重算）
let clearMemo: { key: string; pts: { x: number; y: number; f: number; sg: number }[]; pre: Float64Array } | null = null;
function otherField(m: GenModel, fam: number, x: number, y: number): number {
  let o = -1;
  for (let f = 0; f < m.famRift.length; f++) if (f !== fam) o = Math.max(o, famField(m, f, x, y));
  return o;
}
function riftClear(m: GenModel, r: Rift, reach: number): boolean {
  const key = `${r.fam}:${r.ox}:${r.oy}:${r.tx}:${r.ty}:${r.kappa}:${reach}:${m.rifts.length}`;
  if (!clearMemo || clearMemo.key !== key) {
    const pts = famSamples(m, r, reach);
    clearMemo = { key, pts, pre: new Float64Array(pts.length).fill(Number.NaN) };
  }
  const { pts, pre } = clearMemo;
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k];
    const [x, y] = driftForward(r, p.sg, p.x, p.y);
    const after = otherField(m, r.fam, x, y);
    if (after <= -0.3) continue;
    if (Number.isNaN(pre[k])) pre[k] = otherField(m, r.fam, p.x, p.y);
    if (after > pre[k] + 0.02) return false;
  }
  return true;
}

// 板块跟着碎块走：落在碎块中间（场 > 0.4）的板块去掉，两半的重心各放一个板块，速度是漂移的方向、比一般的板块快
// （0.9–1.2：前缘因此是汇聚的安第斯式大陆边缘），两半的板块互为 sib。碎块边上的板块留着（与以前一样有块内的交界、山带；
// 全去掉时碎块上没有了山带与高原，区域 2000 m 以上 11% → 9%、高原指数 1.1% → 0.85%）
function fragmentPlates(m: GenModel, rand: () => number) {
  const halves: { x: number; y: number; vx: number; vy: number }[] = [];
  for (const r of m.rifts) {
    const pts = famSamples(m, r, famReach(m, r.fam, r.ox, r.oy));
    for (const sg of [1, -1]) {
      let sx = 0;
      let sy = 0;
      let w = 0;
      for (const p of pts) {
        if (p.sg !== sg || p.f <= 0) continue;
        sx += p.x * p.f;
        sy += p.y * p.f;
        w += p.f;
      }
      if (!w) {
        sx = r.ox + sg * r.nx * 0.1;
        sy = r.oy + sg * r.ny * 0.1;
        w = 1;
      }
      const [x, y] = driftForward(r, sg, sx / w, sy / w);
      // 漂移的方向：绕极转的速度方向
      const ex = x - r.px;
      const ey = y - r.py;
      const s = Math.sign(r.phi) * sg;
      const L = Math.hypot(ex, ey) || 1;
      halves.push({ x, y, vx: (-ey / L) * s, vy: (ex / L) * s });
    }
  }
  const inFragment = (x: number, y: number) => m.rifts.some((r) => famField(m, r.fam, x, y) > 0.4);
  const kept = m.plates.filter((p) => !inFragment(p.x, p.y));
  const base = kept.length;
  for (const f of halves) {
    const sp = 0.9 + 0.3 * rand();
    kept.push({ x: f.x, y: f.y, vx: f.vx * sp, vy: f.vy * sp, weight: 0.035, density: rand(), sib: -1 });
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

// 地峡：每张图 1–2 处，连在两块不同的大陆之间（从两块场 ≥ 0.2 的地方起、中间隔着海、长 0.04–0.4，两端再往块里伸 0.06）
const ISTHMUS_TYPES = new Set<WorldType>(['continents', 'continent', 'fragmented', 'inland_sea']);
function buildIsthmi(m: GenModel, parentCount: number, rand: () => number) {
  const want = rand() < 0.5 ? 1 : 2;
  const bend = Array.from({ length: 6 }, () => rand());
  if (!ISTHMUS_TYPES.has(m.params.type)) return;
  // 候选的块：没裂开的母块中心、裂开的两半（漂移后）
  const pieces: { x: number; y: number; fam: number; area: number }[] = [];
  for (let fam = 0; fam < parentCount; fam++) {
    const b = m.blocks[fam];
    const k = m.famRift[fam];
    if (k < 0) {
      pieces.push({ x: b.x, y: b.y, fam, area: famArea(m.blocks, fam) });
      continue;
    }
    const r = m.rifts[k];
    for (const sg of [1, -1]) {
      const [x, y] = driftForward(r, sg, b.x + sg * r.nx * b.r * 0.45, b.y + sg * r.ny * b.r * 0.45);
      pieces.push({ x, y, fam, area: famArea(m.blocks, fam) / 2 });
    }
  }
  // 连在一起的块（并查集）
  const up = pieces.map((_, k) => k);
  const ta = (k: number): number => (up[k] === k ? k : (up[k] = ta(up[k])));
  const join = (a: number, b: number) => {
    up[ta(a)] = ta(b);
  };
  const cands: { a: number; b: number; ax: number; ay: number; bx: number; by: number; L: number }[] = [];
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      const A = pieces[i];
      const B = pieces[j];
      if (A.fam === B.fam) continue;
      const dist = Math.hypot(B.x - A.x, B.y - A.y);
      if (dist > 1.4) continue;
      const N = Math.ceil(dist / 0.004);
      const fa: number[] = [];
      const fb: number[] = [];
      for (let s = 0; s <= N; s++) {
        const x = A.x + ((B.x - A.x) * s) / N;
        const y = A.y + ((B.y - A.y) * s) / N;
        fa.push(famField(m, A.fam, x, y));
        fb.push(famField(m, B.fam, x, y));
      }
      // 从 A 往 B 走出 A（场 < 0.2）的前一点、从 B 往 A 走出 B 的前一点；中间要有海
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
      const L = ((sb - sa) / N) * dist;
      if (L < 0.04 || L > 0.4) continue;
      cands.push({ a: i, b: j, ax: A.x + ((B.x - A.x) * sa) / N, ay: A.y + ((B.y - A.y) * sa) / N, bx: A.x + ((B.x - A.x) * sb) / N, by: A.y + ((B.y - A.y) * sb) / N, L });
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
    const dx = (c.bx - c.ax) / c.L;
    const dy = (c.by - c.ay) / c.L;
    // 两端再往块里伸 0.06；中点往一侧弯（长度的 0.25–0.5）
    const ax = c.ax - dx * 0.06;
    const ay = c.ay - dy * 0.06;
    const bx = c.bx + dx * 0.06;
    const by = c.by + dy * 0.06;
    const amt = c.L * (0.25 + 0.25 * bend[made * 3 + 1]) * (bend[made * 3] < 0.5 ? -1 : 1);
    const kx = (ax + bx) / 2 - dy * amt;
    const ky = (ay + by) / 2 + dx * amt;
    const K = 16;
    const pts = new Float64Array(2 * (K + 1));
    const cum = new Float64Array(K + 1);
    for (let s = 0; s <= K; s++) {
      const t = s / K;
      pts[2 * s] = (1 - t) * (1 - t) * ax + 2 * t * (1 - t) * kx + t * t * bx;
      pts[2 * s + 1] = (1 - t) * (1 - t) * ay + 2 * t * (1 - t) * ky + t * t * by;
      if (s) cum[s] = cum[s - 1] + Math.hypot(pts[2 * s] - pts[2 * s - 2], pts[2 * s + 1] - pts[2 * s - 1]);
    }
    const w = 0.012 + 0.006 * bend[made * 3 + 2];
    const cx = (ax + bx) / 2;
    const cy = (ay + by) / 2;
    let R = 0;
    for (let s = 0; s <= K; s++) R = Math.max(R, Math.hypot(pts[2 * s] - cx, pts[2 * s + 1] - cy));
    m.isthmi.push({ pts, cum, w, cx, cy, R: R + w + ISTHMUS_PAD });
  }
}

// 地峡的大陆场（不加噪声）与压低起伏的权重（写进 IW）
const IW = { c: -1, w: 0 };
function isthmiAt(m: GenModel, x: number, y: number) {
  IW.c = -1;
  IW.w = 0;
  for (const l of m.isthmi) {
    const dx = x - l.cx;
    const dy = y - l.cy;
    if (dx * dx + dy * dy >= l.R * l.R) continue;
    isthmusDist(l, x, y);
    IW.c = Math.max(IW.c, isthmusC(IS.d, l.w));
    IW.w = Math.max(IW.w, isthmusW(IS.d, l.w, IS.t));
  }
}

// 统计用（tools/realism.ts）：每条地峡到扭曲后的一点的距离 ÷ 半宽
export function isthmusNear(m: GenModel, qx: number, qy: number): number[] {
  return m.isthmi.map((l) => {
    isthmusDist(l, qx, qy);
    return IS.d / l.w;
  });
}

// 统计用：地图上一点（未扭曲）扭曲后的位置
export function warpedAt(m: GenModel, x: number, y: number): [number, number] {
  return warp(m.noise, x, y);
}

// 统计用：地图上一点（未扭曲）相对每处裂开：[第几处, 哪一半, 漂移前 x, y, 离切口的 x, 漂移前这一族块的场, 漂移后离原来的裂谷线的 u]，
// 不在范围里的不列
export function riftFrames(m: GenModel, x: number, y: number): [number, number, number, number, number, number, number][] {
  const [qx, qy] = warp(m.noise, x, y);
  prepRifts(m, m.noise.rift, qx, qy, DF);
  const out: [number, number, number, number, number, number, number][] = [];
  for (let k = 0; k < m.rifts.length; k++) {
    if (!DF.inb[k]) continue;
    out.push([k, DF.sg[k], DF.px[k], DF.py[k], DF.x[k], famFieldPre(m, m.rifts[k].fam, DF.px[k], DF.py[k]), DF.uq[k]]);
  }
  return out;
}


// 大陆场（不含噪声）：1 在块中心，0 在块边缘，负值在块外。
// 第三十五轮：裂开的块按漂移后的位置（漂移前的场按切口截；不加裂谷线的弯曲噪声：只给“哪边是大陆”这类判断用）、加上地峡
function blockField(m: GenModel, x: number, y: number): number {
  const nr = m.rifts.length;
  if (nr) prepRifts(m, null, x, y, DF);
  let c = -1;
  for (const b of m.blocks) {
    const k = nr ? m.famRift[b.fam] : -1;
    let s: number;
    if (k < 0) s = blockF(b, x, y);
    else if (!DF.inb[k]) continue;
    else s = Math.min(blockF(b, DF.px[k], DF.py[k]), eHard(DF.x[k], DF.ws[k], DF.wsl[k]));
    if (s > c) c = s;
  }
  if (m.isthmi.length) {
    isthmiAt(m, x, y);
    if (IW.c > c) c = IW.c;
  }
  return c;
}

// 大陆场与缝合线（第三十二轮）：最近的块（与 blockField 逐值相同）、不同的块里最近的那个（两者差不多时是两块相接的缝合线），
// 块内的缝合线：到最近的一条的距离（地图单位）与这块的场
// 第三十五轮：裂开的块在漂移前的位置上算（每处裂开先 prepRifts 到 DS），s1、s2 用按切口截过的（eSoft）；
// 另记没裂开的块的场的最大（oth）、每处裂开那一族块不截的场（fk）与 fk 最大的那一处（best，没有是 −1）
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
function blockPair(m: GenModel, wig: Noise2, x: number, y: number, out: BlockPair) {
  const nr = m.rifts.length;
  if (nr) {
    prepRifts(m, wig, x, y, DS);
    out.fk.fill(-1);
  }
  let s1 = -1;
  let f1 = -1;
  let s2 = -1;
  let oth = -1;
  for (const b of m.blocks) {
    const k = nr ? m.famRift[b.fam] : -1;
    let s: number;
    if (k < 0) {
      s = blockF(b, x, y);
      if (s > oth) oth = s;
    } else {
      if (!DS.inb[k]) continue;
      const f = blockF(b, DS.px[k], DS.py[k]);
      if (f > out.fk[k]) out.fk[k] = f;
      s = Math.min(f, eSoft(DS.x[k], DS.ws[k], DS.wsl[k]));
    }
    if (s > s1) {
      if (b.fam !== f1) s2 = s1;
      s1 = s;
      f1 = b.fam;
    } else if (b.fam !== f1 && s > s2) s2 = s;
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
    const k = nr ? m.famRift[b.fam] : -1;
    if (k >= 0 && !DS.inb[k]) continue;
    const cx = k < 0 ? x : DS.px[k];
    const cy = k < 0 ? y : DS.py[k];
    const dx = cx - b.x;
    const dy = cy - b.y;
    const d = Math.abs(dx * l.cos + dy * l.sin - l.off * b.r);
    if (d < out.inner) {
      out.inner = d;
      out.innerS = blockF(b, cx, cy);
    }
  }
}

// 板块的栅格（第三十二轮，见 relief.ts）：板块坐标铺满地图外扩 0.3 的范围，每像素约 0.0068（宽 2 的地图 384 列）
const TECT_PAD = 0.3;
function tectonicsOf(m: GenModel): TectonicRaster {
  if (m.tect) return m.tect;
  const key = `flat:${m.params.seed}:${m.params.type}:${m.width}:${m.height}`;
  m.tect = cachedTectonics(key, () => {
    const px = (m.width + 2 * TECT_PAD) / 384;
    const W = 384;
    const H = Math.ceil((m.height + 2 * TECT_PAD) / px);
    const pos = new Float64Array(W * H * 2);
    const plate = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const k = y * W + x;
        const X = -TECT_PAD + (x + 0.5) * px;
        const Y = -TECT_PAD + (y + 0.5) * px;
        pos[2 * k] = X;
        pos[2 * k + 1] = Y;
        plate[k] = nearestPlate(m, X, Y);
      }
    }
    return buildTectonics(W, H, false, 2, pos, plate, (k, a, b) => {
      const X = pos[2 * k];
      const Y = pos[2 * k + 1];
      const pa = m.plates[a];
      const pb = m.plates[b];
      const L = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1e-6;
      const nx = (pb.x - pa.x) / L;
      const ny = (pb.y - pa.y) / L;
      const conv = (pa.vx - pb.vx) * nx + (pa.vy - pb.vy) * ny;
      const ca = blockField(m, X - 0.04 * nx, Y - 0.04 * ny);
      const cb = blockField(m, X + 0.04 * nx, Y + 0.04 * ny);
      const upper = Math.abs(ca - cb) > 0.06 ? (ca > cb ? a : b) : pa.density < pb.density ? a : b;
      return { conv, upper, lower: upper === a ? b : a, coll: ca > 0.02 && cb > 0.02, cont: ca > 0.02 || cb > 0.02 };
    });
  });
  return m.tect;
}
const TS: TectonicSample = { dist: 0, up: 0, low: 0, conv: 0, coll: 0 };
const RI: ReliefInput = { c: 0, contW: 0, t: TS, widthMod: 1, nBase: 0, nPlat: 0, nPlatW: 0, nEsc: 0, nSag: 0, nRift: 0, swellR: 9, swellH: 0, riftAxis: 0, shoulder: 0, plates: true, esc: 0 };
const RO: ReliefOut = { T: 0, Tp: 0, pit: 0, rift: 0, erodMul: 1 };

function warp(ns: NoiseSet, x: number, y: number): [number, number] {
  let qx = x + 0.16 * fbm(ns.warpA, x, y, 1.2, 4);
  let qy = y + 0.16 * fbm(ns.warpB, x + 5.2, y + 1.3, 1.2, 4);
  const wx = fbm(ns.warpC, qx, qy, 4.2, 3);
  const wy = fbm(ns.warpD, qx + 3.1, qy - 2.7, 4.2, 3);
  qx += 0.045 * wx;
  qy += 0.045 * wy;
  return [qx, qy];
}

interface PlateInfo {
  a: number;
  b: number;
  // 到板块边界的距离（地图单位）
  bd: number;
  conv: number;
  nx: number;
  ny: number;
}

function nearestPlate(m: GenModel, x: number, y: number): number {
  let a = 0;
  let da = Infinity;
  m.plates.forEach((p, k) => {
    const d = (x - p.x) ** 2 + (y - p.y) ** 2 - p.weight;
    if (d < da) {
      da = d;
      a = k;
    }
  });
  return a;
}

function plateAt(m: GenModel, x: number, y: number): PlateInfo {
  let a = 0;
  let b = 1;
  let da = Infinity;
  let db = Infinity;
  m.plates.forEach((p, k) => {
    const d = (x - p.x) ** 2 + (y - p.y) ** 2 - p.weight;
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
  const pa = m.plates[a];
  const pb = m.plates[b];
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const L = Math.hypot(dx, dy) || 1e-6;
  const nx = dx / L;
  const ny = dy / L;
  return { a, b, bd: (db - da) / (2 * L), conv: (pa.vx - pb.vx) * nx + (pa.vy - pb.vy) * ny, nx, ny };
}

// 本侧在汇聚边界上是否为上覆板块（造山、岛弧在这一侧；另一侧俯冲成海沟）
function overrides(m: GenModel, qx: number, qy: number, pi: PlateInfo, c: number): { over: boolean; bothCont: boolean } {
  const cOther = blockField(m, qx + 2 * pi.bd * pi.nx, qy + 2 * pi.bd * pi.ny);
  const bothCont = c > 0.02 && cOther > 0.02;
  if (Math.abs(c - cOther) > 0.06) return { over: c > cOther, bothCont };
  return { over: m.plates[pi.a].density < m.plates[pi.b].density, bothCont };
}

function buildCones(m: GenModel): Cone[] {
  const { width, height, profile } = m;
  const rand = mulberry32(mixSeed(m.params.seed, 103));
  const cones: Cone[] = [];
  // 热点岛链：沿板块运动方向，越老越矮
  const hotspots = irange(rand, profile.hotspots);
  for (let h = 0; h < hotspots; h++) {
    let px = rand() * width;
    let py = rand() * height;
    for (let t = 0; t < 12; t++) {
      if (blockField(m, px, py) < -0.08) break;
      px = rand() * width;
      py = rand() * height;
    }
    const pi = plateAt(m, px, py);
    const pl = m.plates[pi.a];
    const sp = Math.hypot(pl.vx, pl.vy) || 1;
    const dx = pl.vx / sp;
    const dy = pl.vy / sp;
    const len = 4 + Math.floor(rand() * 7);
    const h0 = 4700 + rand() * 2300;
    const r0 = 0.02 + rand() * 0.012;
    const chainRank = rand();
    for (let i = 0; i < len; i++) {
      const jitter = (rand() - 0.5) * 0.012;
      cones.push({
        x: px + dx * i * 0.03 - dy * jitter,
        y: py + dy * i * 0.03 + dx * jitter,
        r: r0 * (1 - 0.05 * i) * (0.85 + 0.3 * rand()),
        h: h0 * Math.exp(-i / 3.2) * (0.8 + 0.4 * rand()),
        rank: chainRank + i * 0.015,
        kind: 'hotspot',
      });
    }
  }
  // 岛弧：汇聚边界上覆一侧、离边界一定距离的弧形岛串
  const step = 0.028;
  for (let gy = step / 2; gy < height; gy += step) {
    for (let gx = step / 2; gx < width; gx += step) {
      const x = gx + (rand() - 0.5) * step * 0.8;
      const y = gy + (rand() - 0.5) * step * 0.8;
      const r1 = rand();
      const r2 = rand();
      const r3 = rand();
      const [qx, qy] = warp(m.noise, x, y);
      const c = blockField(m, qx, qy);
      if (c > 0.04) continue;
      const pi = plateAt(m, qx, qy);
      if (pi.conv < 0.25 || Math.abs(pi.bd - 0.034) > 0.011) continue;
      if (!overrides(m, qx, qy, pi, c).over) continue;
      cones.push({ x, y, r: 0.011 + 0.016 * r1, h: Math.min(6800, 3400 * Math.pow(Math.max(r2, 1e-3), -0.32)), rank: r3, kind: 'arc' });
    }
  }
  // 海山：成簇或沿断裂带成串（真实海山很少均匀散布），大多没出水面，少数成岛；
  // 重尾的高度分布让岛的大小呈幂律
  let made = 0;
  while (made < profile.seamounts) {
    const cx = rand() * width;
    const cy = rand() * height;
    const clusterRank = rand();
    const linear = rand() < 0.4;
    const ang = rand() * Math.PI;
    const count = 3 + Math.floor(rand() * 7);
    for (let k = 0; k < count && made < profile.seamounts; k++, made++) {
      const along = linear ? (k - count / 2) * 0.022 : 0;
      const x = cx + Math.cos(ang) * along + (rand() - 0.5) * (linear ? 0.012 : 0.07);
      const y = cy + Math.sin(ang) * along + (rand() - 0.5) * (linear ? 0.012 : 0.07);
      const u = Math.max(rand(), 1e-4);
      const r = 0.009 + 0.02 * rand();
      const h = Math.min(7800, 1900 * Math.pow(u, -0.42));
      const rank = clusterRank + rand() * 0.05;
      cones.push({ x, y, r, h, rank, kind: 'seamount' });
    }
  }
  // 伴生小锥：贴着大锥长出来，岛的轮廓因此不再是圆
  const satellites: Cone[] = [];
  for (const c of cones) {
    const k = Math.floor(rand() * 3);
    for (let s = 0; s < k; s++) {
      const a = rand() * Math.PI * 2;
      const dist = c.r * (0.6 + 0.6 * rand());
      satellites.push({ x: c.x + Math.cos(a) * dist, y: c.y + Math.sin(a) * dist, r: c.r * (0.35 + 0.35 * rand()), h: c.h * (0.55 + 0.3 * rand()), rank: c.rank + 1e-6, kind: c.kind });
    }
  }
  return [...cones, ...satellites].sort((p, q) => p.rank - q.rank);
}

// 每格的生成结果分量；海平面与各滑块在 composeBase 里组合，滑块变化时不必重算这些
export interface BaseComponents {
  // 地壳高度（不含造山带与火山锥，m）
  b0: Float32Array;
  // 造山带对地壳高度与抬升的贡献（“山多高”= 1 时）
  mountB: Float32Array;
  mountU: Float32Array;
  hillU: Float32Array;
  erod: Float32Array;
  // 洋底的目标深度（m，与 b0 同一个基准，不含火山锥）：随离洋中脊变深（洋壳年龄）、海沟。
  // 只给海底的后处理用（见 elevation.ts 的 seafloor），不影响陆海与陆地
  sea: Float32Array;
  // 第三十二轮（见 relief.ts）：基准面 T（不含高原）、高原 Tp（“山多高”= 1 时）、洼地 pit，都是米，只在陆壳上
  T: Float32Array;
  Tp: Float32Array;
  pit: Float32Array;
  // 洼地里裂谷的那一部分（米；统计裂谷湖用）
  rift: Float32Array;
  // 不含重画的地壳高度（海平面按它定）：重画一片不挪海平面，只重算圈里的陆块。同一个模型的各份分量共用这一个数组（只读）
  seaB0: Float32Array;
  // 星球形态的地形脚本这次出的问题（出错的那一遍按没有脚本算，见 planet-gen.ts）。普通的 JSON，只给界面看；没有地形脚本时不存在
  issues?: ScriptIssue[];
}

// 局部重算：只重算 changed 这些重画圈里的格，其余格照抄 from。
// 圈外的格，覆盖它的重画都在新旧两组共同的前缀里（顺序也相同），所以值逐位不变
export interface Resample {
  from: BaseComponents;
  changed: Reroll[];
}

export const copyComponents = (c: BaseComponents): BaseComponents => ({
  b0: c.b0.slice(),
  mountB: c.mountB.slice(),
  mountU: c.mountU.slice(),
  hillU: c.hillU.slice(),
  erod: c.erod.slice(),
  sea: c.sea.slice(),
  T: c.T.slice(),
  Tp: c.Tp.slice(),
  pit: c.pit.slice(),
  rift: c.rift.slice(),
  // 不随重画变：共用（重算圈里的格时写进去的是同一个值）
  seaB0: c.seaB0,
});

// 换了重画、种子与类型不变：板块、大陆块、火山锥、噪声只取决于种子与类型（和地图大小），照用，只换参数
export function withParams(m: GenModel, input: WorldgenInput): GenModel {
  return { ...m, params: resolvedParams(worldgenSchema.parse(input)) };
}

export function sampleComponents(m: GenModel, mesh: Mesh, re?: Resample): BaseComponents {
  const n = mesh.n;
  const out: BaseComponents = re ? copyComponents(re.from) : emptyBaseComponents(n);
  const rerolls = m.params.rerolls;
  for (let i = 0; i < n; i++) {
    const x = mesh.x[i];
    const y = mesh.y[i];
    // 与 sampleCell 里同一个“在圈内”的判断
    if (re && re.changed.every((r) => Math.hypot(x - r.x, y - r.y) >= r.radius)) continue;
    sampleCell(m, rerolls, x, y, out, i);
  }
  return out;
}

// 空闲预热（第三十一轮，见 terrain.ts 的 warmTerrainSteps）：从头采样的一段格 [from, to)，写进 out（新建的空分量）。
// 每格与 sampleComponents 不带 re 时的那一格是同一个调用，分几段采完与一次采完逐值相同
export function sampleComponentRange(m: GenModel, mesh: Mesh, out: BaseComponents, from: number, to: number) {
  const rerolls = m.params.rerolls;
  for (let i = from; i < to; i++) sampleCell(m, rerolls, mesh.x[i], mesh.y[i], out, i);
}

export const emptyBaseComponents = (n: number): BaseComponents => ({
  b0: new Float32Array(n),
  mountB: new Float32Array(n),
  mountU: new Float32Array(n),
  hillU: new Float32Array(n),
  erod: new Float32Array(n),
  sea: new Float32Array(n),
  T: new Float32Array(n),
  Tp: new Float32Array(n),
  pit: new Float32Array(n),
  rift: new Float32Array(n),
  seaB0: new Float32Array(n),
});

// 一格：原来的噪声，再按顺序叠上覆盖它的各次重画
function sampleCell(m: GenModel, rerolls: Reroll[], x: number, y: number, out: BaseComponents, i: number) {
  sampleInto(m, m.noise, x, y, out, i);
  out.seaB0[i] = out.b0[i];
  // 重画这一片：区域内换一套噪声，边缘羽化
  for (const r of rerolls) {
    const d = Math.hypot(x - r.x, y - r.y);
    if (d >= r.radius) continue;
    let ns = m.variants.get(r.variant);
    if (!ns) {
      ns = noiseSet(m.params.seed, r.variant);
      m.variants.set(r.variant, ns);
    }
    const tmp = emptyBaseComponents(1);
    sampleInto(m, ns, x, y, tmp, 0);
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

// 洋底的目标深度（第十二轮）：板块冷却——洋壳离洋中脊越远越老、越深（轴部约 −2600 m，远处约 −5300 m），
// age 是到最近的离散边界的距离（扩张快的洋中脊更宽：距离按扩张速度缩短）；海沟处往下拉到 −7000 到 −10000 m；
// 再加深海丘陵的起伏。ridgeH、trenchH 是洋中脊、海沟的强弱（星球形态可以调，地区地图是 1700、2600）
export function oceanFloor(age: number, trench: number, ridgeH: number, trenchH: number, lo: number, hi: number): number {
  let z = -5300 + 2700 * (ridgeH / 1700) * Math.exp(-age / 0.12);
  z += 200 * lo + 110 * hi;
  return z + trench * (trenchH / 2600) * 0.8 * (-10200 - z);
}

function sampleInto(m: GenModel, ns: NoiseSet, x: number, y: number, out: BaseComponents, i: number) {
  const prof = m.profile;
  const [qx, qy] = warp(ns, x, y);
  // c：定海陆的大陆场；cs：“形状”场（造山、基准面、丘陵用；第三十五轮：裂开的海岸上与 c 不同，见 outline.ts）。
  // (nqx, nqy)：大陆的噪声在哪里取——裂开的那一族块占上风时是漂移前的位置（两岸的海岸、起伏对得上），离开时渐渐回到 (qx, qy)
  let c = -1;
  let cs = -1;
  let nqx = qx;
  let nqy = qy;
  let reliefW = 1;
  let esc = 0;
  let isW = 0;
  let ridgeR = 0;
  let ageR = 1;
  if (m.blocks.length) {
    // 大陆场，顺带缝合线（第三十二轮）
    blockPair(m, ns.rift, qx, qy, BP);
    const nr = m.rifts.length;
    const kb = nr ? BP.best : -1;
    if (kb >= 0) {
      // 这一族占上风、又离它不远（范围的边上场 < −1，渐渐不用漂移前的位置，不出接缝）
      const wN = smoothstep(-0.15, 0.15, BP.fk[kb] - BP.oth) * smoothstep(-0.6, -0.35, BP.fk[kb]);
      nqx = qx + wN * (DS.px[kb] - qx);
      nqy = qy + wN * (DS.py[kb] - qy);
      reliefW = 1 - wN * (1 - reliefNear(DS.x[kb]));
      esc = wN * escNear(DS.x[kb]);
    }
    // 低频造大半岛、大海湾，中频让海岸参差
    const f = 1 / Math.max(0.1, m.meanR);
    const N = 0.42 * fbm(ns.block, nqx, nqy, 1.5 * f, 4, 0.55) + 0.18 * fbm(ns.hills, nqx + 9.1, nqy - 4.3, 6 * f, 4, 0.62);
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
        // 缝里的洋中脊：按漂移后的位置离原来的裂谷线（两半对称地转开，中线就是原来的线），两侧海底的年龄对称
        const r = m.rifts[k];
        const open = ridgeOpen(DS.disp[k]) * (1 - smoothstep(0.75, 1, Math.hypot(qx - r.cx, qy - r.cy) / r.R));
        if (open > 0) {
          const uq = DS.uq[k];
          ridgeR = Math.max(ridgeR, open * Math.exp(-((uq / RIDGE_W) ** 2)));
          ageR = Math.min(ageR, Math.abs(uq) + 0.5 * (1 - open));
        }
      }
    }
    // 地峡只在原来的噪声里有：重新生成一片（另一套噪声）圈到地峡上时它跟着重新生成（可能断开）
    if (m.isthmi.length && ns === m.noise) {
      isthmiAt(m, qx, qy);
      if (IW.c > c) c = IW.c;
      if (IW.c > cs) cs = IW.c;
      isW = IW.w;
      reliefW *= 1 - 0.7 * isW;
    }
  }

  // 地壳：大陆架 → 陆坡 → 深海
  const slopeW = 0.08;
  let B: number;
  // 海岸带（大陆架外缘到沿海平原）坡度平缓，海平面附近的起伏因此能塑造出曲折的海岸和近岸小岛；再往内陆才抬升
  if (c >= 0) B = -140 + 650 * Math.min(c, 0.16) + prof.rise * Math.max(0, c - 0.16);
  else if (c >= -slopeW) B = -140 - 3800 * smoothstep(0, 1, -c / slopeW);
  else B = -3940;
  const rw = smoothstep(-slopeW, 0.06, c);
  // 分形起伏（H≈0.7）：低频造出半岛海湾，高频一直细到格尺度，海岸因此是分形的
  B += prof.relief * rw * reliefW * fbm(ns.relief, nqx, nqy, 2.6, 9, 0.62);
  B += 230 * (1 - rw) * fbm(ns.ocean, qx, qy, 5, 4);

  // 板块边界：在更弯曲的坐标里求，边界因此蜿蜒而不是直线
  const px = qx + 0.07 * fbm(ns.seg, qx + 11.3, qy, 1.7, 3) + 0.022 * fbm(ns.ridge, qx, qy + 4.4, 5.5, 2);
  const py = qy + 0.07 * fbm(ns.seg, qx, qy - 7.9, 1.7, 3) + 0.022 * fbm(ns.ridge, qx - 2.2, qy, 5.5, 2);
  const oceanW = 1 - smoothstep(-0.12, 0, cs);
  const contW = smoothstep(-0.02, 0.1, cs);
  // 宽度、高度沿走向变化；分段（有缺口）；脊状噪声造出支脉
  const widthMod = 0.65 + 0.7 * (0.5 + 0.5 * fbm(ns.hills, px * 0.7, py * 0.7, 2.5, 2));
  const seg = smoothstep(-0.35, 0.3, fbm(ns.seg, qx, qy, 3.5, 3));
  const ridged = 1 - Math.abs(fbm(ns.ridge, qx, qy, 10, 4));
  const wc = 0.055 * widthMod;
  const wm = 0.032 * widthMod;
  const belt = (bd: number, w: number) => Math.exp(-((bd / w) ** 2)) + 0.5 * Math.exp(-(((bd - 2.4 * w) / (0.6 * w)) ** 2));
  // 对周围每条边界分别求贡献再取最大：离边界远时“第二近的板块”会突变，只看一条边界会把山带齐刷刷切断
  const a = nearestPlate(m, px, py);
  const pa = m.plates[a];
  const da = (px - pa.x) ** 2 + (py - pa.y) ** 2 - pa.weight;
  let ridge = 0;
  let rift = 0;
  let trench = 0;
  let mm = 0;
  // 到最近的离散边界的距离（按扩张速度缩放）：洋壳的年龄
  let age = 1;
  // 裂谷轴（窄）、裂谷肩（两侧）：离交界很近，按 bd
  let riftAxis = 0;
  let shoulder = 0;
  for (let b = 0; b < m.plates.length; b++) {
    if (b === a) continue;
    const pb = m.plates[b];
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const L = Math.hypot(dx, dy) || 1e-6;
    const db = (px - pb.x) ** 2 + (py - pb.y) ** 2 - pb.weight;
    const bd = (db - da) / (2 * L);
    if (bd > 0.3) continue;
    const nx = dx / L;
    const ny = dy / L;
    const conv = (pa.vx - pb.vx) * nx + (pa.vy - pb.vy) * ny;
    if (conv < 0) {
      // 裂开的两半之间：洋中脊、裂谷按裂谷线画（上面的 ridgeR、ageR），不按板块的平分线
      if (pb.sib === a) continue;
      const div = Math.min(1, -conv);
      ridge = Math.max(ridge, div * Math.exp(-((bd / 0.04) ** 2)));
      rift = Math.max(rift, div * Math.exp(-((bd / 0.025) ** 2)));
      riftAxis = Math.max(riftAxis, div * Math.exp(-((bd / RIFT_W) ** 2)));
      shoulder = Math.max(shoulder, div * Math.exp(-(((bd - 0.042) / 0.018) ** 2)));
      age = Math.min(age, bd / (0.45 + 0.55 * div));
      continue;
    }
    // 两侧的大陆程度连续混合：碰撞带（两侧都是大陆）、大陆边缘山脉（本侧大陆、对侧大洋）、海沟（本侧大洋）
    const cOther = blockField(m, qx + 2 * bd * nx, qy + 2 * bd * ny);
    const wb = smoothstep(-0.02, 0.1, cOther);
    const cv = Math.min(1.3, conv);
    const subducts = (1 - contW) * Math.max(wb, pa.density > pb.density ? 1 : 0);
    trench = Math.max(trench, Math.min(1, cv) * Math.exp(-(((bd - 0.012) / 0.012) ** 2)) * subducts);
    const collision = contW * wb;
    const margin = contW * (1 - wb);
    const shape = collision * (belt(bd, wc) + 0.45 * Math.exp(-((bd / (3 * wc)) ** 2))) + margin * belt(bd, wm);
    mm = Math.max(mm, cv * shape);
  }
  ridge = Math.max(ridge, ridgeR);
  age = Math.min(age, ageR);
  B += 1700 * ridge * oceanW - 900 * rift * contW * (1 - isW) - 2600 * trench * oceanW;
  const mountU0 = mm * (0.3 + 0.7 * seg) * (0.55 + 0.6 * ridged);
  const mountB = 1600 * mountU0 * smoothstep(-0.05, 0.05, cs);
  // 老山（第三十二轮）：两块相接处与块内的缝合线上低矮的抬升（不改地壳高度、不改海陆）；沿缝合线的岩性条纹 → 格子状水系
  let suture = 0;
  let stripe = 0;
  if (m.blocks.length) {
    const gap = BP.s1 - BP.s2;
    const pair = smoothstep(0.0, 0.08, BP.s2);
    const inner = smoothstep(0.1, 0.3, BP.innerS);
    suture = Math.max(pair * Math.exp(-((gap / 0.035) ** 2)), inner * Math.exp(-((BP.inner / 0.025) ** 2)));
    const zone = Math.max(pair * Math.exp(-((gap / 0.07) ** 2)), inner * Math.exp(-((BP.inner / 0.05) ** 2)));
    const across = pair * Math.exp(-((gap / 0.07) ** 2)) >= inner * Math.exp(-((BP.inner / 0.05) ** 2)) ? gap : BP.inner;
    stripe = zone * Math.sin((across / 0.022) * Math.PI * 2);
  }
  // 老山的抬升放在丘陵里（不改造山带、不改地壳高度）
  const oldU = 0.22 * suture * ridged * contW;
  // 大格局：基准面、高原、洼地、岩性的倍数
  const t = tectonicsOf(m);
  const pxSize = (m.width + 2 * TECT_PAD) / t.W;
  sampleTectonics(t, (px + TECT_PAD) / pxSize - 0.5, (py + TECT_PAD) / pxSize - 0.5, TS);
  let swellR = 9;
  let swellH = 0;
  if (m.swells.length) {
    const wob = 1 + 0.25 * fbm(ns.plat, qx - 3.3, qy + 8.8, 6, 2);
    for (const s of m.swells) {
      const r = (Math.hypot(qx - s.x, qy - s.y) * wob) / s.r;
      if (r < swellR) {
        swellR = r;
        swellH = s.h;
      }
    }
  }
  RI.c = cs;
  RI.contW = contW;
  RI.widthMod = widthMod;
  // 大陆的低频噪声（隆起与盆地、陡崖分段、凹陷）在漂移前的位置上取；高原分段、裂谷分段跟着板块（漂移后）
  RI.nBase = fbm(ns.big, nqx, nqy, 2.2, 3);
  RI.nPlat = fbm(ns.plat, qx, qy, 3, 2);
  RI.nPlatW = fbm(ns.plat, qx + 5.3, qy - 2.1, 2, 2);
  RI.nEsc = fbm(ns.big, nqx - 7.7, nqy + 3.3, 3, 2);
  RI.nSag = fbm(ns.sag, nqx, nqy, 2.6, 3);
  RI.nRift = fbm(ns.sag, qx + 4.4, qy - 6.6, 3.5, 2);
  RI.swellR = swellR;
  RI.swellH = swellH;
  RI.riftAxis = riftAxis * contW;
  RI.shoulder = shoulder;
  RI.plates = true;
  RI.esc = esc;
  reliefAt(RI, RO);
  out.b0[i] = B;
  out.mountB[i] = mountB;
  out.mountU[i] = mountU0;
  out.hillU[i] = 0.12 * Math.max(0, fbm(ns.hills, nqx, nqy, 6, 4)) * contW + oldU;
  out.erod[i] = clamp((1 + 0.45 * fbm(ns.erod, x + 7.7, y - 3.1, 6, 3)) * RO.erodMul * (1 + 0.45 * stripe), 0.4, 1.8);
  out.sea[i] = oceanFloor(age, trench, 1700, 2600, fbm(ns.ocean, qx - 4.1, qy + 2.3, 3, 4), fbm(ns.ocean, qx + 6.2, qy - 8.4, 24, 3));
  out.T[i] = RO.T;
  out.Tp[i] = RO.Tp;
  out.pit[i] = RO.pit;
  out.rift[i] = RO.rift;
}

// 前 N 个火山锥对每格地壳高度与抬升的贡献（火山锥用未扭曲的坐标，保持圆形）
export function coneFields(m: GenModel, mesh: Mesh, count: number): { coneB: Float32Array; coneU: Float32Array } {
  const n = mesh.n;
  const coneB = new Float32Array(n);
  const coneU = new Float32Array(n);
  const cones = m.cones.slice(0, count);
  if (!cones.length) return { coneB, coneU };
  // 均匀网格加速：每格只看附近的锥
  const cs = 0.06;
  const gw = Math.ceil(m.width / cs) + 1;
  const gh = Math.ceil(m.height / cs) + 1;
  const grid: number[][] = Array.from({ length: gw * gh }, () => []);
  cones.forEach((c, k) => {
    const r = c.r * 1.4;
    for (let gx = Math.max(0, Math.floor((c.x - r) / cs)); gx <= Math.min(gw - 1, Math.floor((c.x + r) / cs)); gx++) {
      for (let gy = Math.max(0, Math.floor((c.y - r) / cs)); gy <= Math.min(gh - 1, Math.floor((c.y + r) / cs)); gy++) grid[gy * gw + gx].push(k);
    }
  });
  for (let i = 0; i < n; i++) {
    const x = mesh.x[i];
    const y = mesh.y[i];
    const g = Math.min(gh - 1, Math.max(0, Math.floor(y / cs))) * gw + Math.min(gw - 1, Math.max(0, Math.floor(x / cs)));
    for (const k of grid[g]) {
      const c = cones[k];
      const d = Math.hypot(x - c.x, y - c.y);
      // 轮廓不规则：按位置取噪声，岛有湾有岬
      const re = c.r * (1 + 0.45 * fbm(m.noise.cone, x, y, 0.8 / c.r, 3));
      if (d >= re) continue;
      const t = 1 - d / re;
      coneB[i] += c.h * Math.pow(t, 1.5);
      coneU[i] += 1.1 * (c.h / 6500) * Math.pow(t, 1.3);
    }
  }
  return { coneB, coneU };
}
