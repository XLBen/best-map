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

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export type Noise2 = (x: number, y: number) => number;

// 256 个均匀分布的单位梯度方向，按哈希查表，比每次算三角函数快得多
const GRAD_X = new Float64Array(256);
const GRAD_Y = new Float64Array(256);
for (let k = 0; k < 256; k++) {
  const a = ((k + 0.5) / 256) * Math.PI * 2;
  GRAD_X[k] = Math.cos(a);
  GRAD_Y[k] = Math.sin(a);
}

// 二维梯度噪声，输出约在 [-1, 1]
export function gradientNoise(seed: number): Noise2 {
  const s = seed >>> 0;
  const grad = (ix: number, iy: number, dx: number, dy: number) => {
    const k = hash2(ix, iy, s) & 255;
    return GRAD_X[k] * dx + GRAD_Y[k] * dy;
  };
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const u = fade(fx);
    const v = fade(fy);
    const n00 = grad(ix, iy, fx, fy);
    const n10 = grad(ix + 1, iy, fx - 1, fy);
    const n01 = grad(ix, iy + 1, fx, fy - 1);
    const n11 = grad(ix + 1, iy + 1, fx - 1, fy - 1);
    const a = n00 + (n10 - n00) * u;
    const b = n01 + (n11 - n01) * u;
    return (a + (b - a) * v) * 1.41;
  };
}

// 分形叠加：frequency 为第一层每单位长度的周期数
export function fbm(noise: Noise2, x: number, y: number, frequency: number, octaves: number, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = frequency;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * f + o * 17.3, y * f - o * 9.1);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

// ---------- 三维噪声（整个星球用：在球面上取值，东西接缝、两极都没有断口）----------

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x1b873593) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// 梯度取立方体的 12 条棱方向（补成 16 个，Perlin 的做法），只查表、不用三角函数
const G3X = [1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0, 1, -1, 0, 0];
const G3Y = [1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, 1, -1, -1];
const G3Z = [0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1, 0, 0, 1, -1];
// 让三维噪声的标准差与二维的相同（一次标定，之后固定）
export const NOISE3_SCALE = 1.125;

export type Noise3 = (x: number, y: number, z: number) => number;

export function gradientNoise3(seed: number): Noise3 {
  const s = seed >>> 0;
  const grad = (ix: number, iy: number, iz: number, dx: number, dy: number, dz: number) => {
    const k = hash3(ix, iy, iz, s) & 15;
    return G3X[k] * dx + G3Y[k] * dy + G3Z[k] * dz;
  };
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y, z) => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);
    const fx = x - ix;
    const fy = y - iy;
    const fz = z - iz;
    const u = fade(fx);
    const v = fade(fy);
    const w = fade(fz);
    const n000 = grad(ix, iy, iz, fx, fy, fz);
    const n100 = grad(ix + 1, iy, iz, fx - 1, fy, fz);
    const n010 = grad(ix, iy + 1, iz, fx, fy - 1, fz);
    const n110 = grad(ix + 1, iy + 1, iz, fx - 1, fy - 1, fz);
    const n001 = grad(ix, iy, iz + 1, fx, fy, fz - 1);
    const n101 = grad(ix + 1, iy, iz + 1, fx - 1, fy, fz - 1);
    const n011 = grad(ix, iy + 1, iz + 1, fx, fy - 1, fz - 1);
    const n111 = grad(ix + 1, iy + 1, iz + 1, fx - 1, fy - 1, fz - 1);
    const a0 = n000 + (n100 - n000) * u;
    const b0 = n010 + (n110 - n010) * u;
    const a1 = n001 + (n101 - n001) * u;
    const b1 = n011 + (n111 - n011) * u;
    const c0 = a0 + (b0 - a0) * v;
    const c1 = a1 + (b1 - a1) * v;
    return (c0 + (c1 - c0) * w) * NOISE3_SCALE;
  };
}

// 三维分形叠加（与 fbm 相同的叠法，每层再错开一点）
export function fbm3(noise: Noise3, x: number, y: number, z: number, frequency: number, octaves: number, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = frequency;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * f + o * 17.3, y * f - o * 9.1, z * f + o * 5.3);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number) => clamp(v, 0, 1);
export const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
