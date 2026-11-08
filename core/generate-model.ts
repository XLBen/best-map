// 随机世界的设置与模型的类型（第八十三轮从 core/generate.ts 原样搬出）：世界类型、生成设置的 schema、各类型的参数、板块与大陆块、噪声
import { type WorldType, WORLD_TYPES } from './world-types';
import { z } from 'zod';
import { planetFormSchema } from './planet-form';
import { type Noise2, gradientNoise, mixSeed, fbm } from './rng';
import type { TectonicRaster } from './relief';

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

export const PROFILES: Record<WorldType, Profile> = {
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

export interface Plate {
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

export interface Block {
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
export interface SutureLine {
  block: number;
  cos: number;
  sin: number;
  off: number;
}

// 带陡崖的穹隆（第三十二轮）
export interface SwellSpot {
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

export interface NoiseSet {
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

export function noiseSet(seed: number, variant: number): NoiseSet {
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

export const range = (rand: () => number, [a, b]: [number, number]) => a + (b - a) * rand();
export const irange = (rand: () => number, [a, b]: [number, number]) => a + Math.floor((b - a + 1) * rand());

export function warp(ns: NoiseSet, x: number, y: number): [number, number] {
  let qx = x + 0.16 * fbm(ns.warpA, x, y, 1.2, 4);
  let qy = y + 0.16 * fbm(ns.warpB, x + 5.2, y + 1.3, 1.2, 4);
  const wx = fbm(ns.warpC, qx, qy, 4.2, 3);
  const wy = fbm(ns.warpD, qx + 3.1, qy - 2.7, 4.2, 3);
  qx += 0.045 * wx;
  qy += 0.045 * wy;
  return [qx, qy];
}
