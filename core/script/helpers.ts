import { clamp as clampRange, fbm as fbmKernel, fbm3 as fbm3Kernel, gradientNoise, gradientNoise3, mixSeed, type Noise2, noise2, type Noise3, noise3 as noise3Kernel, smoothstep as smoothKernel } from '../rng';
import { type ScriptKind, VAR_BY_NAME } from './format';
import { POISONED, SHADOW } from './shadow';
import type { BiomeInputs, ScriptInputs } from './inputs';

// 脚本里能调的辅助函数（rand、noise、field、river、biome……）和它们的运行状态 RUN、遮住全局名字用的替身（第一百零一轮从 core/script.ts 原样搬来；describe 原来在“运行”一节，颜色的报错也要用，跟着搬到这里）

// ---------- 辅助函数 ----------

// 一次运行的状态。脚本同步地一段一段跑，所以全模块一份就够；辅助函数从这里读当前格与种子
interface RunState {
  active: boolean;
  kind: ScriptKind;
  cell: number;
  worldSeed: number;
  ownerHash: number;
  // 上一次 k 对应的种子（同一个 k 连续调用很常见）
  lastK: number;
  lastSeed: number;
  inputs: ScriptInputs | null;
  globe: boolean;
  // fbmAt、地形脚本的 rand 用的位置（第一次用到时才取）
  posReady: boolean;
  px: ArrayLike<number> | null;
  py: ArrayLike<number> | null;
  pz: ArrayLike<number> | null;
  mx: ArrayLike<number> | null;
  my: ArrayLike<number> | null;
  noise2: Map<number, Noise2>;
  noise3: Map<number, Noise3>;
  fields: Map<string, ArrayLike<number>>;
  rivers: Map<string, ArrayLike<number> | null>;
  biomeShares: Map<string, ArrayLike<number>>;
  // 布局脚本的 rand()：一条随机流
  stream: (() => number) | null;
  // 返回值不对时记下它（生成说明用）
  bad: unknown;
}

const RUN: RunState = {
  active: false,
  kind: 'placement',
  cell: 0,
  worldSeed: 0,
  ownerHash: 0,
  lastK: NaN,
  lastSeed: 0,
  inputs: null,
  globe: false,
  posReady: false,
  px: null,
  py: null,
  pz: null,
  mx: null,
  my: null,
  noise2: new Map(),
  noise3: new Map(),
  fields: new Map(),
  rivers: new Map(),
  biomeShares: new Map(),
  stream: null,
  bad: undefined,
};

// mixSeed 的一步（展开写，避免每次调用都分配参数数组）；mixStep(mixStep(0x811c9dc5, a), b) >>> 0 = mixSeed(a, b)
function mixStep(h: number, p: number): number {
  h = Math.imul(h ^ (p >>> 0), 0x01000193);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  return h ^ (h >>> 15);
}

// 第 k 组噪声、随机数的种子：mixSeed(世界种子, hashString(seedKey ?? 所属 id), k)
function seedFor(k: number): number {
  if (k !== RUN.lastK) {
    RUN.lastK = k;
    RUN.lastSeed = mixSeed(RUN.worldSeed, RUN.ownerHash, k);
  }
  return RUN.lastSeed;
}

function noise2For(k: number): Noise2 {
  const s = seedFor(k);
  let n = RUN.noise2.get(s);
  if (!n) RUN.noise2.set(s, (n = gradientNoise(s)));
  return n;
}

function noise3For(k: number): Noise3 {
  const s = seedFor(k);
  let n = RUN.noise3.get(s);
  if (!n) RUN.noise3.set(s, (n = gradientNoise3(s)));
  return n;
}

// 层数取 1–12 的整数（防止写错成很大的数卡住）
const octaves = (oct: number) => (oct >= 1 ? Math.min(12, Math.floor(oct)) : 1);

function bindPositions(): void {
  const inp = RUN.inputs;
  RUN.posReady = true;
  if (!inp) return;
  const arr = (key: string) => {
    const v = inp.get(key);
    return v !== undefined && typeof v === 'object' ? (v as ArrayLike<number>) : null;
  };
  RUN.px = arr('px');
  RUN.py = arr('py');
  RUN.pz = arr('pz');
  if (!RUN.globe) {
    RUN.mx = arr('x');
    RUN.my = arr('y');
  }
}

// 位置量化后再哈希（地形脚本）：缩略图与成品世界在同一位置得到同一个随机数，与格的编号无关
const quant = (v: number) => Math.round(v * 32768);

function rand(k = 0): number {
  const st = RUN;
  if (st.stream) return st.stream();
  const s = seedFor(k);
  if (st.kind === 'crust') {
    if (!st.posReady) bindPositions();
    if (st.px && st.py && st.pz) {
      const c = st.cell;
      return (mixStep(mixStep(mixStep(mixStep(0x811c9dc5, s), quant(st.px[c])), quant(st.py[c])), quant(st.pz[c])) >>> 0) / 4294967296;
    }
  }
  return (mixStep(mixStep(0x811c9dc5, s), st.cell) >>> 0) / 4294967296;
}

function fbmAt(freq: number, oct = 3, k = 0): number {
  const st = RUN;
  if (!st.posReady) bindPositions();
  const c = st.cell;
  if (st.globe) {
    if (!st.px || !st.py || !st.pz) throw new Error('这里没有格的位置，不能用 fbmAt（用 fbm3）');
    return fbm3Kernel(noise3For(k), st.px[c], st.py[c], st.pz[c], freq / Math.PI, octaves(oct), 0.5);
  }
  if (!st.mx || !st.my) throw new Error('这里没有格的位置，不能用 fbmAt（用 fbm）');
  return fbmKernel(noise2For(k), st.mx[c], st.my[c], freq, octaves(oct), 0.5);
}

function field(name: string): number {
  const st = RUN;
  let a = st.fields.get(name);
  if (!a) {
    const key = String(name);
    a = st.inputs?.field?.(key);
    if (!a) {
      const v = VAR_BY_NAME.get(key);
      const got = v && !v.scalar ? st.inputs?.get(v.key) : undefined;
      if (got !== undefined && typeof got === 'object') a = got as ArrayLike<number>;
    }
    if (!a) throw new Error(`没有自定义场“${key}”`);
    st.fields.set(name, a);
  }
  return a[st.cell];
}

// 离某种河多近（0–1）。由引擎的 inputs.river 提供；没有这种河（或还没有河流类型）时为 0
function river(typeId: string): number {
  const st = RUN;
  let a = st.rivers.get(typeId);
  if (a === undefined) {
    a = st.inputs?.river?.(String(typeId)) ?? null;
    st.rivers.set(typeId, a);
  }
  return a ? a[st.cell] : 0;
}

// 地图上有没有这种河（任何地方）。与 river() 读同一份河岸场：这种河出现、消失时引擎记着的结果整个重算
function hasRiver(typeId: string): boolean {
  const st = RUN;
  let a = st.rivers.get(typeId);
  if (a === undefined) {
    a = st.inputs?.river?.(String(typeId)) ?? null;
    st.rivers.set(typeId, a);
  }
  return a !== null;
}

// 生态（第十二轮）：只在河流、湖泊类型的 match 里有（按不计水体类型的一遍植被，见 vegetation.ts 的 baseBiomes）
function biomeInputs(name: string): BiomeInputs {
  const b = RUN.inputs?.biomes;
  if (!b) throw new Error(`${name}() 只能在河流类型、湖泊类型的规则里用`);
  return b;
}

function biome(id: string): number {
  const key = String(id);
  let a = RUN.biomeShares.get(key);
  if (!a) RUN.biomeShares.set(key, (a = biomeInputs('biome').share(key)));
  return a[RUN.cell];
}

const dominantBiome = (): string => biomeInputs('dominantBiome').dominant(RUN.cell);

function biomeAtSource(): string {
  const b = biomeInputs('biomeAtSource');
  if (!b.atSource) throw new Error('biomeAtSource() 只在河流类型的规则里有（湖用 dominantBiome()）');
  return b.atSource(RUN.cell);
}

function biomeAtMouth(): string {
  const b = biomeInputs('biomeAtMouth');
  if (!b.atMouth) throw new Error('biomeAtMouth() 只在河流类型的规则里有（湖用 dominantBiome()）');
  return b.atMouth(RUN.cell);
}

// 离某种湖多近、地图上有没有这种湖（第九轮）：与河岸场同一条路，键是 'lake:类型'（见 river-types.ts 的 riverProvider）
const nearLake = (typeId: string): number => river(`lake:${String(typeId)}`);
const hasLake = (typeId: string): boolean => hasRiver(`lake:${String(typeId)}`);

type Rgb = [number, number, number];

// 颜色：[r, g, b]（0–255）或 '#rrggbb' / '#rgb'；不认识时为 null
export function parseColor(v: unknown): Rgb | null {
  if (typeof v === 'string') {
    const m = /^#([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(v.trim());
    if (!m) return null;
    const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  if (Array.isArray(v) || ArrayBuffer.isView(v)) {
    const a = v as ArrayLike<unknown>;
    if (a.length < 3) return null;
    const r = a[0];
    const g = a[1];
    const b = a[2];
    if (typeof r !== 'number' || typeof g !== 'number' || typeof b !== 'number') return null;
    return [r, g, b];
  }
  return null;
}

function colorOf(v: unknown): Rgb {
  const c = parseColor(v);
  if (!c) throw new Error(`颜色格式不对：${describe(v)}（要 [r, g, b] 或 '#rrggbb'）`);
  return c;
}

export const HELPERS = Object.freeze({
  noise: (x: number, y: number, k = 0) => noise2(seedFor(k), x, y),
  fbm: (x: number, y: number, oct = 4, gain = 0.5, k = 0) => fbmKernel(noise2For(k), x, y, 1, octaves(oct), gain),
  noise3: (x: number, y: number, z: number, k = 0) => noise3Kernel(seedFor(k), x, y, z),
  fbm3: (x: number, y: number, z: number, oct = 4, gain = 0.5, k = 0) => fbm3Kernel(noise3For(k), x, y, z, 1, octaves(oct), gain),
  fbmAt,
  rand,
  field,
  river,
  hasRiver,
  nearLake,
  hasLake,
  biome,
  dominantBiome,
  biomeAtSource,
  biomeAtMouth,
  smoothstep: (a: number, b: number, v: number) => (a === b ? (v < a ? 0 : 1) : smoothKernel(a, b, v)),
  clamp: (v: number, lo = 0, hi = 1) => clampRange(v, lo, hi),
  mix: (a: number, b: number, t: number) => a + (b - a) * t,
  step: (edge: number, v: number) => (v < edge ? 0 : 1),
  mixColor: (a: unknown, b: unknown, t: number): Rgb => {
    const x = colorOf(a);
    const y = colorOf(b);
    return [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t];
  },
  rgb: (r: unknown, g?: number, b?: number): Rgb => (typeof r === 'string' ? colorOf(r) : colorOf([r, g, b])),
});
export const HELPER_NAMES = Object.keys(HELPERS);
// 函数本身、以及函数声明带的 prototype 对象也冻结：脚本不能在 noise.foo、rand.prototype.foo 上记东西
// （那样就和计算顺序、和上一次运行有关了）
for (const f of Object.values(HELPERS) as unknown as { prototype?: unknown }[]) {
  Object.freeze(f);
  if (f.prototype) Object.freeze(f.prototype);
}

// Math 的冻结副本，没有 random
const SAFE_MATH = Object.freeze(
  Object.fromEntries(
    Object.getOwnPropertyNames(Math)
      .filter((k) => k !== 'random')
      .map((k) => [k, (Math as unknown as Record<string, unknown>)[k]]),
  ),
);

// 一碰就报错的替身（Date、performance……）：读属性、调用、new 都抛出带名字的错误，出错提示据此说“不能用时间”。
// 所有 13 种操作都拦下（handler 本身是个代理，问哪种操作都给 fail），目标也冻结：
// 否则 Object.defineProperty(Date, 'memo', …) 会落到目标上，变成能跨运行保存的东西
function poison(name: string): unknown {
  const fail = (): never => {
    throw new TypeError(`${name} is not available in scripts`);
  };
  return new Proxy(Object.freeze(function () {}), new Proxy({}, { get: () => fail }));
}
export const SHADOW_VALUES: unknown[] = SHADOW.map((n) => (n === 'Math' ? SAFE_MATH : n in POISONED ? poison(n) : undefined));

// 返回值的简短描述（报错用）。返回值是脚本给的，可能是会抛错的代理：这里绝不抛错
export function describe(v: unknown): string {
  try {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    if (typeof v === 'number') return Number.isNaN(v) ? 'NaN' : String(v);
    if (typeof v === 'string') return `文字 "${v.length > 20 ? `${v.slice(0, 20)}…` : v}"`;
    if (typeof v === 'boolean') return String(v);
    if (Array.isArray(v) || ArrayBuffer.isView(v)) return `有 ${(v as ArrayLike<unknown>).length} 项的数组`;
    if (typeof v === 'function') return '函数';
    return '对象';
  } catch {
    return '对象';
  }
}

// 第一百零一轮（拆文件时唯一新写的一行）：别的文件（compile.ts、run.ts）经这个别名拿同一个 RUN。不直接导出 RUN：在 Node 的模块里，
// 导出的名字每次读都要过一道，本文件里的辅助函数每格读它好几次（量到颜色脚本慢约 3%）；打包后的程序里各文件并成一个，没有这回事
export const RUN_STATE = RUN;
