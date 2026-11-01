import type { Frame, OverlayPaths, OverlayState, ProvinceLabel, Shape } from './overlay-base';
import { type MapStyle, mapStyleKey } from '../../core/map-style';
import type { World } from '../../core/world';
import type { Camera } from './renderer';
import { settleImageEpoch } from './settle-draw';
import { windEpoch } from './wind';

// 屏幕上的静态那一层的键（第四十轮；第四十一轮从 overlay.ts 原样搬来）

// ---------- 屏幕上的静态那一层（第四十轮） ----------

// 叠加层的选项哪些进静态的键：static 进键；shapes 是每次比的图形；internal 是画法自己的（移动中、导出，不进键、另看）。
// 新加一项选项时这张表不写全编译不过
export const FIELD_KIND: { [K in keyof Required<OverlayState>]: 'static' | 'shapes' | 'internal' } = {
  rivers: 'static',
  wind: 'static',
  markers: 'static',
  season: 'static',
  style: 'static',
  shapes: 'shapes',
  provinceLabels: 'static',
  features: 'static',
  labelTypes: 'static',
  nameMode: 'static',
  peaks: 'static',
  countries: 'static',
  settlements: 'static',
  settleNames: 'static',
  settleStrong: 'static',
  cellSize: 'static',
  roads: 'static',
  kmPerUnit: 'static',
  hoverLabel: 'static',
  scaleBar: 'static',
  cornerLift: 'static',
  latitude: 'static',
  currents: 'static',
  motion: 'internal',
  motionEpoch: 'internal',
  exact: 'static',
  frame: 'internal',
  lazy: 'internal',
};
export const overlayFieldKinds = FIELD_KIND;
export const STATIC_FIELDS = (Object.keys(FIELD_KIND) as (keyof OverlayState)[]).filter((k) => FIELD_KIND[k] === 'static');

// 每帧新建、内容相同的几样换成上一次的同一个值：省名的数组（按元素逐个比）、地名的类型（Set，按内容）、纬度、画风（按 mapStyleKey）
export let lastProvinceLabels: readonly ProvinceLabel[] = [];
export function sameRef<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
export function fieldKey(k: keyof OverlayState, v: unknown): unknown {
  if (v instanceof Set) return [...v].sort().join(',');
  if (k === 'provinceLabels') {
    const l = v as ProvinceLabel[];
    if (!sameRef(l, lastProvinceLabels)) lastProvinceLabels = l;
    return lastProvinceLabels;
  }
  if (k === 'latitude') return v ? `${(v as { north: number }).north}|${(v as { south: number }).south}` : null;
  if (k === 'style') return mapStyleKey(v as MapStyle);
  if (k === 'settleStrong') return v ? (v as readonly string[]).join('|') : null;
  return v;
}

// 字体加载完成（字宽、字形变了）：静态的那一层要重画
export let fontEpoch = 0;
if (typeof document !== 'undefined') document.fonts?.addEventListener?.('loadingdone', () => fontEpoch++);

// 静态的键：世界、路径、镜头、画布的大小、开始时画布上的 textBaseline（省名照用上一帧留下的，见 drawScreen）、
// 选项里 static 的那些，字体、小图、风与洋流的流线（空闲时算好了几块）
export function staticKey(world: World, paths: OverlayPaths, cam: Camera, st: OverlayState, f: Frame, canvas: { width: number; height: number }, baseline: unknown): unknown[] {
  const p = cam.proj;
  const key: unknown[] = [world, paths, cam.x, cam.y, cam.zoom, p?.kind, p?.lon0, p?.lat0, f.cw, f.ch, f.dpr, canvas.width, canvas.height, baseline, fontEpoch, settleImageEpoch(), windEpoch()];
  for (const k of STATIC_FIELDS) key.push(fieldKey(k, st[k]));
  return key;
}

// 两份工具的图形画出来一样（每帧都是新的对象：按每一项比）
export function sameShapes(a: readonly Shape[], b: readonly Shape[] | null): boolean {
  if (!b) return false;
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameShape(a[i], b[i])) return false;
  return true;
}
export const sameNums = (a: ArrayLike<number> | undefined, b: ArrayLike<number> | undefined) => {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
export function sameShape(a: Shape, b: Shape): boolean {
  if (a === b) return true;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as (keyof Shape)[]);
  for (const k of keys) {
    const x = a[k];
    const y = b[k];
    if (x === y) continue;
    if (k === 'points') {
      const p = x as [number, number][] | undefined;
      const q = y as [number, number][] | undefined;
      if (!p || !q || p.length !== q.length) return false;
      for (let i = 0; i < p.length; i++) if (p[i] !== q[i] && (p[i][0] !== q[i][0] || p[i][1] !== q[i][1])) return false;
      continue;
    }
    if (k === 'cells' || k === 'flow' || k === 'mul') {
      if (!sameNums(x as number[] | undefined, y as number[] | undefined)) return false;
      continue;
    }
    return false;
  }
  return true;
}
