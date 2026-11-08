// 星球生成的设置与模型的类型（第八十三轮从 core/planet-gen.ts 原样搬出）：布局坐标、各类型的参数、板块与大陆块、三维噪声、球面上的向量小工具
import type { WorldType, Worldgen } from './generate';
import { mergeProfile, type PlanetForm } from './planet-form';
import { type Noise3, gradientNoise3, mixSeed, fbm3 } from './rng';
import type { ScriptIssue } from './script';
import type { TectonicRaster } from './relief';
import { tangentBasis } from './sphere';

export const LAYOUT_R = 2 / Math.PI;
// 布局坐标下整个球面的面积（4πρ²）
export const LAYOUT_AREA = 4 * Math.PI * LAYOUT_R * LAYOUT_R;

export type V3 = [number, number, number];

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
export function profileOf(p: Worldgen): PlanetProfile {
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

export function tuningOf(form: PlanetForm | undefined): PlanetTuning {
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

export interface Plate {
  c: V3;
  // 角速度（欧拉轴 × 转速）
  w: V3;
  weight: number;
  density: number;
  // 第三十五轮：裂开的大陆块两半的板块互为 sib，别的是 −1（见 generate.ts）
  sib: number;
}

export interface Block {
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
export interface SutureLine {
  block: number;
  cos: number;
  sin: number;
  off: number;
}

// 带陡崖的穹隆（第三十二轮）
export interface SwellSpot {
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

export interface NoiseSet3 {
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

export function noiseSet3(seed: number, variant: number): NoiseSet3 {
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

export const range = (rand: () => number, [a, b]: [number, number]) => a + (b - a) * rand();
export const irange = (rand: () => number, [a, b]: [number, number]) => a + Math.floor((b - a + 1) * rand());

export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const len = (a: V3) => Math.sqrt(dot(a, a));
export const unit = (a: V3): V3 => scale(a, 1 / (len(a) || 1));

// 球面上均匀的随机点（布局坐标）
export function randomPoint(rand: () => number): V3 {
  const z = 2 * rand() - 1;
  const phi = 2 * Math.PI * rand();
  const r = Math.sqrt(Math.max(0, 1 - z * z));
  return [r * Math.cos(phi) * LAYOUT_R, r * Math.sin(phi) * LAYOUT_R, z * LAYOUT_R];
}

// 点 c 处、方位角 a（从东向南转）的切向单位向量
export function tangentAt(c: V3, a: number): V3 {
  const n = unit(c);
  const [ex, ey, ez, sx, sy, sz] = tangentBasis(n[0], n[1], n[2]);
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  return [ca * ex + sa * sx, ca * ey + sa * sy, ca * ez + sa * sz];
}

// 从 c 沿切向 dir 走过布局距离 dist（沿大圆）；返回终点与终点处的前进方向
export function walk(c: V3, dir: V3, dist: number): { p: V3; t: V3 } {
  const n = unit(c);
  const th = dist / LAYOUT_R;
  const ct = Math.cos(th);
  const st = Math.sin(th);
  const p = scale(add(scale(n, ct), scale(dir, st)), LAYOUT_R);
  const t = add(scale(n, -st), scale(dir, ct));
  return { p, t };
}

export function makeBlock(c: V3, u: V3, r: number, e: number): Block {
  const n = unit(c);
  // 长轴取切向分量（防止数值误差），短轴与它垂直
  const ut = unit(add(u, scale(n, -dot(u, n))));
  const v = cross(ut, n);
  return { c, n, u: ut, v, r, e };
}

export const DEG = Math.PI / 180;

export function warp(ns: NoiseSet3, x: number, y: number, z: number): V3 {
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
