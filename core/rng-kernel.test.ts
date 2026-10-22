import { describe, expect, it } from 'vitest';
import { fbm, fbm3, gradientNoise, gradientNoise3, mulberry32, noise2, noise3 } from './rng';

// 无闭包的噪声内核必须与原来的写法逐位相同（含零的正负号）：
// 下面原样保留改写前的 hash2 / hash3 / gradientNoise / gradientNoise3 / fbm / fbm3 作对照

function oldHash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

type OldNoise2 = (x: number, y: number) => number;

const OLD_GRAD_X = new Float64Array(256);
const OLD_GRAD_Y = new Float64Array(256);
for (let k = 0; k < 256; k++) {
  const a = ((k + 0.5) / 256) * Math.PI * 2;
  OLD_GRAD_X[k] = Math.cos(a);
  OLD_GRAD_Y[k] = Math.sin(a);
}

function oldGradientNoise(seed: number): OldNoise2 {
  const s = seed >>> 0;
  const grad = (ix: number, iy: number, dx: number, dy: number) => {
    const k = oldHash2(ix, iy, s) & 255;
    return OLD_GRAD_X[k] * dx + OLD_GRAD_Y[k] * dy;
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

function oldFbm(noise: OldNoise2, x: number, y: number, frequency: number, octaves: number, gain = 0.5): number {
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

function oldHash3(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x1b873593) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

const OLD_G3X = [1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0, 1, -1, 0, 0];
const OLD_G3Y = [1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, 1, -1, -1];
const OLD_G3Z = [0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1, 0, 0, 1, -1];
const OLD_NOISE3_SCALE = 1.125;

type OldNoise3 = (x: number, y: number, z: number) => number;

function oldGradientNoise3(seed: number): OldNoise3 {
  const s = seed >>> 0;
  const grad = (ix: number, iy: number, iz: number, dx: number, dy: number, dz: number) => {
    const k = oldHash3(ix, iy, iz, s) & 15;
    return OLD_G3X[k] * dx + OLD_G3Y[k] * dy + OLD_G3Z[k] * dz;
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
    return (c0 + (c1 - c0) * w) * OLD_NOISE3_SCALE;
  };
}

function oldFbm3(noise: OldNoise3, x: number, y: number, z: number, frequency: number, octaves: number, gain = 0.5): number {
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

// ---------- 对照 ----------

const SEEDS = [0, 1, 7, 0x7fffffff, 0x80000000, 0xffffffff, 0x1234abcd, -1, -123456789, 2 ** 32 + 5, 3.7];

// 各种坐标：大范围随机、小范围随机、格点、半格点、负零、接近格点的值、超出 2^31 与 2^53 的大数
function coords(rand: () => number, count: number): number[] {
  const out: number[] = [0, -0, 0.5, -0.5, 1, -1, 1e-300, -1e-300, 1 - 2 ** -53, -(2 ** -53), 2 ** 31, -(2 ** 31), 2 ** 31 - 0.5, 2 ** 32 + 0.25, 2 ** 53, -(2 ** 53), 2 ** 53 + 2, 1e300, -1e300];
  for (let k = 0; k < count; k++) {
    const r = rand();
    if (r < 0.3) out.push((rand() * 2 - 1) * 1e5);
    else if (r < 0.55) out.push((rand() * 2 - 1) * 8);
    else if (r < 0.7) out.push(Math.round((rand() * 2 - 1) * 1e5));
    else if (r < 0.85) out.push(Math.round((rand() * 2 - 1) * 1e5) + 0.5);
    else if (r < 0.95) out.push(Math.round((rand() * 2 - 1) * 100) + (rand() - 0.5) * 1e-12);
    else out.push((rand() * 2 - 1) * 2 ** (31 + rand() * 30));
  }
  return out;
}

// 记下第一个不同的地方，便于定位；Object.is 区分 +0 与 −0、NaN 自等
// （说明文字只在出错时才拼，拼字符串比算噪声还慢）
function firstMismatch(n: number, get: (k: number) => [number, number, () => string]): string | null {
  for (let k = 0; k < n; k++) {
    const [a, b, label] = get(k);
    if (!Object.is(a, b)) return `${label()}: 新 ${a} 旧 ${b}`;
  }
  return null;
}

describe('无闭包的噪声内核与原写法逐位相同', () => {
  it('二维：单点与闭包', () => {
    const rand = mulberry32(11);
    const xs = coords(rand, 10000);
    const ys = coords(rand, 10000);
    let checked = 0;
    for (const seed of SEEDS) {
      const old = oldGradientNoise(seed);
      const now = gradientNoise(seed);
      const s = seed >>> 0;
      expect(now.seed).toBe(s);
      // 所有 x 与 y 两两组合太多：错位配对，并额外把每个 x 与几个特殊 y 配对
      const bad = firstMismatch(xs.length * 4, (k) => {
        const x = xs[k % xs.length];
        const y = k < xs.length ? ys[k] : ys[(k * 7 + (k >> 3)) % 19];
        const o = old(x, y);
        const a = k & 1 ? noise2(s, x, y) : now(x, y);
        checked++;
        return [a, o, () => `seed ${seed} (${x}, ${y})`];
      });
      expect(bad).toBeNull();
    }
    expect(checked).toBeGreaterThan(400000);
  });

  // 格点、半格点、大数、NaN 与无穷两两（三三）组合：小数部分为 0 时只剩零的正负号能看出角点哈希的差别
  const LATTICE = [0, -0, 1, -1, 0.5, -0.5, 2, -3, 12345, -99999, 1e5, -1e5 - 0.5, 2 ** 31 - 1, 2 ** 31, -(2 ** 31), 2 ** 32, 2 ** 52 + 0.5, 2 ** 53, -(2 ** 53), 2 ** 53 + 2, 2 ** 60, -(2 ** 60), 1e300, NaN, Infinity, -Infinity];

  it('二维：格点组合', () => {
    for (const seed of SEEDS) {
      const old = oldGradientNoise(seed);
      const s = seed >>> 0;
      const bad = firstMismatch(LATTICE.length ** 2, (k) => {
        const x = LATTICE[k % LATTICE.length];
        const y = LATTICE[Math.floor(k / LATTICE.length)];
        return [noise2(s, x, y), old(x, y), () => `seed ${seed} (${x}, ${y})`];
      });
      expect(bad).toBeNull();
    }
  });

  it('三维：单点与闭包', () => {
    const rand = mulberry32(12);
    const xs = coords(rand, 10000);
    const ys = coords(rand, 10000);
    const zs = coords(rand, 10000);
    let checked = 0;
    for (const seed of SEEDS) {
      const old = oldGradientNoise3(seed);
      const now = gradientNoise3(seed);
      const s = seed >>> 0;
      expect(now.seed).toBe(s);
      const bad = firstMismatch(xs.length * 4, (k) => {
        const x = xs[k % xs.length];
        const y = k < xs.length ? ys[k] : ys[(k * 7 + (k >> 3)) % 19];
        const z = k < 2 * xs.length ? zs[k % zs.length] : zs[(k * 5 + (k >> 2)) % 19];
        const o = old(x, y, z);
        const a = k & 1 ? noise3(s, x, y, z) : now(x, y, z);
        checked++;
        return [a, o, () => `seed ${seed} (${x}, ${y}, ${z})`];
      });
      expect(bad).toBeNull();
    }
    expect(checked).toBeGreaterThan(400000);
  });

  it('三维：格点组合', () => {
    for (const seed of SEEDS) {
      const old = oldGradientNoise3(seed);
      const s = seed >>> 0;
      const bad = firstMismatch(LATTICE.length ** 3, (k) => {
        const x = LATTICE[k % LATTICE.length];
        const y = LATTICE[Math.floor(k / LATTICE.length) % LATTICE.length];
        const z = LATTICE[Math.floor(k / LATTICE.length ** 2)];
        return [noise3(s, x, y, z), old(x, y, z), () => `seed ${seed} (${x}, ${y}, ${z})`];
      });
      expect(bad).toBeNull();
    }
  });

  // 代码里用到的频率、层数与增益
  const FREQS = [0.8, 1.2, 1.5, 1.6, 1.7, 2.5, 2.6, 3, 3.5, 4.2, 5, 5.5, 6, 7, 9, 10, 25, 45, 1.6 / 0.37, 0.8 / 0.05];
  const GAINS = [0.5, 0.55, 0.6, 0.62];

  it('fbm：各层数、增益，以及不带种子的函数照常调用', () => {
    const rand = mulberry32(13);
    for (const seed of SEEDS) {
      const old = oldGradientNoise(seed);
      const now = gradientNoise(seed);
      // 不带 seed 的普通函数（走原来的调用方式）
      const plain = (x: number, y: number) => now(x, y);
      const bad = firstMismatch(12000, (k) => {
        const r = rand();
        const x = r < 0.6 ? (rand() * 2 - 1) * 3 : r < 0.8 ? (rand() * 2 - 1) * 1e5 : Math.round(rand() * 40 - 20) * 0.5;
        const y = r < 0.6 ? (rand() * 2 - 1) * 3 : r < 0.8 ? (rand() * 2 - 1) * 1e5 : Math.round(rand() * 40 - 20) * 0.5;
        const f = FREQS[k % FREQS.length];
        const oct = 1 + (k % 9);
        const gain = GAINS[(k >> 2) % GAINS.length];
        const o = gain === 0.5 && k & 8 ? oldFbm(old, x, y, f, oct) : oldFbm(old, x, y, f, oct, gain);
        const a = k % 3 === 2 ? fbm(plain, x, y, f, oct, gain) : gain === 0.5 && k & 8 ? fbm(now, x, y, f, oct) : fbm(now, x, y, f, oct, gain);
        return [a, o, () => `seed ${seed} fbm(${x}, ${y}, ${f}, ${oct}, ${gain})`];
      });
      expect(bad).toBeNull();
    }
  });

  it('fbm3：各层数、增益，以及不带种子的函数照常调用', () => {
    const rand = mulberry32(14);
    for (const seed of SEEDS) {
      const old = oldGradientNoise3(seed);
      const now = gradientNoise3(seed);
      const plain = (x: number, y: number, z: number) => now(x, y, z);
      const bad = firstMismatch(12000, (k) => {
        const r = rand();
        const pick = () => (r < 0.6 ? (rand() * 2 - 1) * 1.3 : r < 0.8 ? (rand() * 2 - 1) * 1e5 : Math.round(rand() * 40 - 20) * 0.5);
        const x = pick();
        const y = pick();
        const z = pick();
        const f = FREQS[k % FREQS.length];
        const oct = 1 + (k % 9);
        const gain = GAINS[(k >> 2) % GAINS.length];
        const o = gain === 0.5 && k & 8 ? oldFbm3(old, x, y, z, f, oct) : oldFbm3(old, x, y, z, f, oct, gain);
        const a = k % 3 === 2 ? fbm3(plain, x, y, z, f, oct, gain) : gain === 0.5 && k & 8 ? fbm3(now, x, y, z, f, oct) : fbm3(now, x, y, z, f, oct, gain);
        return [a, o, () => `seed ${seed} fbm3(${x}, ${y}, ${z}, ${f}, ${oct}, ${gain})`];
      });
      expect(bad).toBeNull();
    }
  });
});
