import type { Mesh } from '../mesh';
import { type CellInputs, RIVER } from './rules';

// 人文的几层按格记下（第三十五轮提速）：自动的地形类别、资源每格只取决于这一格的输入（干不干、挨海 / 河 / 湖的标记、纬度、
// 主导的生态、高程、坡度、年均温、湿润指数、地形湿度；资源另看这一格生效的类别）与规则、种子。
// 改一笔多半只改几成的格（画河、放湖只改几百格），所以记下上一次的输入（复制一份，按位比）与结果，
// 规则、种子相同时只重算输入变了的格，别的格照抄上一次的结果（与整个重算逐值相同，见 r35-speed 测试）。
// 按网格只记最近的一份：别的世界（预览、副本）在同一个网格上算过也没关系，按记下的输入比，只是要重算的格多一些。
// on = false：每次整个重算（测试用）
// partial / full：只重算一部分格 / 整个重算的次数；lastChanged：最近一次输入变了的格数（测试用）
export const humanCellMemo = { on: true, partial: 0, full: 0, lastChanged: -1 };

export interface CellSnap {
  n: number;
  dry: Uint8Array;
  flags: Uint8Array;
  biome: Int16Array;
  // 纬度、高程、坡度、年均温、湿润指数、地形湿度按位（Float32 的位）
  lat: Uint32Array;
  elev: Uint32Array;
  slope: Uint32Array;
  temp: Uint32Array;
  moist: Uint32Array;
  wet: Uint32Array;
}

export interface HumanCellEntry {
  snap: CellSnap;
  classKey: string;
  auto: Uint8Array;
  resKey: string;
  cls: Uint8Array;
  rAuto: Uint8Array;
  // 宜居度（另看有河的格的流量）
  habKey: string;
  hab: Float32Array;
  discharge: Float32Array;
}

const memo = new WeakMap<Mesh, HumanCellEntry>();

export function cellMemoOf(mesh: Mesh): HumanCellEntry | undefined {
  return humanCellMemo.on ? memo.get(mesh) : undefined;
}

export function setCellMemo(mesh: Mesh, e: HumanCellEntry): void {
  if (humanCellMemo.on) memo.set(mesh, e);
}

// 按位看的 Float32 数组（不是 Float32Array 时为 null：不记）
function bits(a: ArrayLike<number>): Uint32Array | null {
  return a instanceof Float32Array ? new Uint32Array(a.buffer, a.byteOffset, a.length) : null;
}

// 输入的位视图（都是 Float32Array / Int16Array 时才有）
function views(x: CellInputs): Omit<CellSnap, 'n'> | null {
  const lat = bits(x.lat);
  const elev = bits(x.elevation);
  const slope = bits(x.slope);
  const temp = bits(x.temp);
  const moist = bits(x.moisture);
  const wet = bits(x.wetness);
  if (!lat || !elev || !slope || !temp || !moist || !wet || !(x.biome instanceof Int16Array)) return null;
  return { dry: x.dry, flags: x.flags, biome: x.biome, lat, elev, slope, temp, moist, wet };
}

// 这一次的输入复制一份（之后推导里的数组会就地改）
export function snapInputs(x: CellInputs): CellSnap | null {
  const v = views(x);
  if (!v) return null;
  return {
    n: x.n,
    dry: v.dry.slice(),
    flags: v.flags.slice(),
    biome: v.biome.slice(),
    lat: v.lat.slice(),
    elev: v.elev.slice(),
    slope: v.slope.slice(),
    temp: v.temp.slice(),
    moist: v.moist.slice(),
    wet: v.wet.slice(),
  };
}

// 输入与记下的不同的格（按编号从小到大）。两次都不是干的陆地的格结果都是 0，不算；格数不同、输入不是按位能比的数组时为 null
export function changedInputs(s: CellSnap, x: CellInputs): Int32Array | null {
  if (s.n !== x.n) return null;
  const v = views(x);
  if (!v) return null;
  const out = new Int32Array(x.n);
  const m = diffCells(s, v, x.n, out);
  return out.slice(0, m);
}

function diffCells(s: CellSnap, v: Omit<CellSnap, 'n'>, n: number, out: Int32Array): number {
  const { dry, flags, biome, lat, elev, slope, temp, moist, wet } = v;
  let m = 0;
  for (let i = 0; i < n; i++) {
    const d = dry[i];
    if (d !== s.dry[i]) out[m++] = i;
    else if (d && (flags[i] !== s.flags[i] || biome[i] !== s.biome[i] || elev[i] !== s.elev[i] || slope[i] !== s.slope[i] || temp[i] !== s.temp[i] || moist[i] !== s.moist[i] || wet[i] !== s.wet[i] || lat[i] !== s.lat[i])) out[m++] = i;
  }
  return m;
}

// 资源要重算的格：输入变了的格，加上生效的类别变了的格（按编号从小到大）
export function withClassChanges(changed: Int32Array, cls: Uint8Array, prevCls: Uint8Array): Int32Array {
  const n = cls.length;
  const out = new Int32Array(n);
  let m = 0;
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (k < changed.length && changed[k] === i) {
      out[m++] = i;
      k++;
    } else if (cls[i] !== prevCls[i]) out[m++] = i;
  }
  return out.slice(0, m);
}

// 宜居度要重算的格：touched（按编号从小到大），加上这一次有河、流量（按位）变了的干陆地格
export function withRiverChanges(touched: Int32Array, x: CellInputs, discharge: Float32Array, prev: Float32Array): Int32Array {
  const n = x.n;
  const a = new Uint32Array(discharge.buffer, discharge.byteOffset, n);
  const b = new Uint32Array(prev.buffer, prev.byteOffset, n);
  const out = new Int32Array(n);
  const m = riverDiff(touched, x.dry, x.flags, a, b, n, out);
  return out.slice(0, m);
}

function riverDiff(touched: Int32Array, dry: Uint8Array, flags: Uint8Array, a: Uint32Array, b: Uint32Array, n: number, out: Int32Array): number {
  let m = 0;
  let k = 0;
  for (let i = 0; i < n; i++) {
    if (k < touched.length && touched[k] === i) {
      out[m++] = i;
      k++;
    } else if (dry[i] && flags[i] & RIVER && a[i] !== b[i]) out[m++] = i;
  }
  return m;
}
