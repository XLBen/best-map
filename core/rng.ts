// 可复现的随机数与噪声。所有随机性都从世界种子派生，保证命令重放结果逐值一致。

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 由多个整数得到一个新种子，用于给各个子系统分配独立的随机流
export function mixSeed(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const p of parts) {
    h = Math.imul(h ^ (p >>> 0), 0x01000193);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return h >>> 0;
}

// 二维噪声：调用本身之外还带着种子，fbm 读到 seed 就直接调用内核 noise2（没有时照常调用函数本身）
export type Noise2 = { (x: number, y: number): number; seed?: number };

// 256 个均匀分布的单位梯度方向，按哈希查表，比每次算三角函数快得多
const GRAD_X = new Float64Array(256);
const GRAD_Y = new Float64Array(256);
for (let k = 0; k < 256; k++) {
  const a = ((k + 0.5) / 256) * Math.PI * 2;
  GRAD_X[k] = Math.cos(a);
  GRAD_Y[k] = Math.sin(a);
}

// 二维梯度噪声的内核（不经闭包，四个角全部展开）。
// 格点哈希 h = imul(x, 0x27d4eb2d) ^ imul(y, 0x165667b1) ^ seed，再混合两轮；
// 每个轴的乘积只算一次，种子先异或进 y 项（异或满足结合律，逐位相同）。
// ix + 1 照旧先按浮点加再进 imul，坐标很大时也与逐角点计算一致
export function noise2(s: number, x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const fx1 = fx - 1;
  const fy1 = fy - 1;
  const hx0 = Math.imul(ix, 0x27d4eb2d);
  const hx1 = Math.imul(ix + 1, 0x27d4eb2d);
  const hy0 = Math.imul(iy, 0x165667b1) ^ s;
  const hy1 = Math.imul(iy + 1, 0x165667b1) ^ s;
  let h = hx0 ^ hy0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  let k = (h ^ (h >>> 16)) & 255;
  const n00 = GRAD_X[k] * fx + GRAD_Y[k] * fy;
  h = hx1 ^ hy0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  k = (h ^ (h >>> 16)) & 255;
  const n10 = GRAD_X[k] * fx1 + GRAD_Y[k] * fy;
  h = hx0 ^ hy1;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  k = (h ^ (h >>> 16)) & 255;
  const n01 = GRAD_X[k] * fx + GRAD_Y[k] * fy1;
  h = hx1 ^ hy1;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  k = (h ^ (h >>> 16)) & 255;
  const n11 = GRAD_X[k] * fx1 + GRAD_Y[k] * fy1;
  const a = n00 + (n10 - n00) * u;
  const b = n01 + (n11 - n01) * u;
  return (a + (b - a) * v) * 1.41;
}

// 二维梯度噪声，输出约在 [-1, 1]
export function gradientNoise(seed: number): Noise2 {
  const s = seed >>> 0;
  const noise: Noise2 = (x, y) => noise2(s, x, y);
  noise.seed = s;
  return noise;
}

// 分形叠加：frequency 为第一层每单位长度的周期数
export function fbm(noise: Noise2, x: number, y: number, frequency: number, octaves: number, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = frequency;
  const s = noise.seed;
  for (let o = 0; o < octaves; o++) {
    const nx = x * f + o * 17.3;
    const ny = y * f - o * 9.1;
    sum += amp * (s === undefined ? noise(nx, ny) : noise2(s, nx, ny));
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

// ---------- 三维噪声（整个星球用：在球面上取值，东西接缝、两极都没有断口）----------

// 梯度取立方体的 12 条棱方向（补成 16 个，Perlin 的做法），只查表、不用三角函数
const G3X = new Float64Array([1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0, 1, -1, 0, 0]);
const G3Y = new Float64Array([1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, 1, -1, -1]);
const G3Z = new Float64Array([0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1, 0, 0, 1, -1]);
// 让三维噪声的标准差与二维的相同（一次标定，之后固定）
const NOISE3_SCALE = 1.125;

export type Noise3 = { (x: number, y: number, z: number): number; seed?: number };

// 三维梯度噪声的内核（同 noise2）：格点哈希 h = imul(x, 0x27d4eb2d) ^ imul(y, 0x165667b1) ^ imul(z, 0x1b873593) ^ seed，
// 种子先异或进 z 项，x、y 两项的组合也只算一次
export function noise3(s: number, x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const w = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  const fx1 = fx - 1;
  const fy1 = fy - 1;
  const fz1 = fz - 1;
  const hx0 = Math.imul(ix, 0x27d4eb2d);
  const hx1 = Math.imul(ix + 1, 0x27d4eb2d);
  const hy0 = Math.imul(iy, 0x165667b1);
  const hy1 = Math.imul(iy + 1, 0x165667b1);
  const hz0 = Math.imul(iz, 0x1b873593) ^ s;
  const hz1 = Math.imul(iz + 1, 0x1b873593) ^ s;
  const h00 = hx0 ^ hy0;
  const h10 = hx1 ^ hy0;
  const h01 = hx0 ^ hy1;
  const h11 = hx1 ^ hy1;
  let h = h00 ^ hz0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  let k = (h ^ (h >>> 16)) & 15;
  const n000 = G3X[k] * fx + G3Y[k] * fy + G3Z[k] * fz;
  h = h10 ^ hz0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  k = (h ^ (h >>> 16)) & 15;
  const n100 = G3X[k] * fx1 + G3Y[k] * fy + G3Z[k] * fz;
  h = h01 ^ hz0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  k = (h ^ (h >>> 16)) & 15;
  const n010 = G3X[k] * fx + G3Y[k] * fy1 + G3Z[k] * fz;
  h = h11 ^ hz0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  k = (h ^ (h >>> 16)) & 15;
  const n110 = G3X[k] * fx1 + G3Y[k] * fy1 + G3Z[k] * fz;
  h = h00 ^ hz1;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  k = (h ^ (h >>> 16)) & 15;
  const n001 = G3X[k] * fx + G3Y[k] * fy + G3Z[k] * fz1;
  h = h10 ^ hz1;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  k = (h ^ (h >>> 16)) & 15;
  const n101 = G3X[k] * fx1 + G3Y[k] * fy + G3Z[k] * fz1;
  h = h01 ^ hz1;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  k = (h ^ (h >>> 16)) & 15;
  const n011 = G3X[k] * fx + G3Y[k] * fy1 + G3Z[k] * fz1;
  h = h11 ^ hz1;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  k = (h ^ (h >>> 16)) & 15;
  const n111 = G3X[k] * fx1 + G3Y[k] * fy1 + G3Z[k] * fz1;
  const a0 = n000 + (n100 - n000) * u;
  const b0 = n010 + (n110 - n010) * u;
  const a1 = n001 + (n101 - n001) * u;
  const b1 = n011 + (n111 - n011) * u;
  const c0 = a0 + (b0 - a0) * v;
  const c1 = a1 + (b1 - a1) * v;
  return (c0 + (c1 - c0) * w) * NOISE3_SCALE;
}

export function gradientNoise3(seed: number): Noise3 {
  const s = seed >>> 0;
  const noise: Noise3 = (x, y, z) => noise3(s, x, y, z);
  noise.seed = s;
  return noise;
}

// 三维分形叠加（与 fbm 相同的叠法，每层再错开一点）
export function fbm3(noise: Noise3, x: number, y: number, z: number, frequency: number, octaves: number, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = frequency;
  const s = noise.seed;
  for (let o = 0; o < octaves; o++) {
    const nx = x * f + o * 17.3;
    const ny = y * f - o * 9.1;
    const nz = z * f + o * 5.3;
    sum += amp * (s === undefined ? noise(nx, ny, nz) : noise3(s, nx, ny, nz));
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number) => clamp(v, 0, 1);
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
