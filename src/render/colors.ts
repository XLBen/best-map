import { blendRgb } from '../../core/biome-look';
import { hexToRgb } from '../../core/export';
import { gradient } from '../../core/mesh';
import { coastValues } from '../../core/subcell';
import { COAST_AMP } from '../../core/terrain';
import { type World, provinceColor } from '../../core/world';
import type { Season, ViewMode } from '../state';
import type { CellLayers } from './renderer';

// 每种视图模式下每格的颜色：平滑层（在三角形内插值）与分类层（按扭曲后的格平涂），以及渲染需要的其他逐格数据

type RGB = [number, number, number];

function ramp(stops: [number, RGB][], v: number): RGB {
  if (v <= stops[0][0]) return stops[0][1];
  for (let k = 1; k < stops.length; k++) {
    if (v <= stops[k][0]) {
      const [a, ca] = stops[k - 1];
      const [b, cb] = stops[k];
      const t = (v - a) / (b - a);
      return [ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t];
    }
  }
  return stops[stops.length - 1][1];
}

const SEA: [number, RGB][] = [
  [-6500, [14, 26, 56]],
  [-4000, [22, 44, 86]],
  [-2000, [30, 62, 112]],
  [-400, [40, 84, 136]],
  [-120, [50, 100, 148]],
  [0, [62, 116, 156]],
];
const HYPSO: [number, RGB][] = [
  [0, [96, 140, 88]],
  [300, [140, 168, 104]],
  [900, [200, 190, 130]],
  [1800, [176, 140, 98]],
  [3000, [150, 120, 104]],
  [4500, [210, 205, 205]],
  [6500, [250, 250, 250]],
];
const TEMP: [number, RGB][] = [
  [-35, [60, 30, 120]],
  [-15, [70, 110, 210]],
  [0, [170, 215, 240]],
  [10, [240, 236, 170]],
  [20, [240, 160, 70]],
  [30, [200, 50, 40]],
  [40, [110, 10, 30]],
];
const PRECIP: [number, RGB][] = [
  [0, [150, 100, 60]],
  [150, [210, 180, 110]],
  [400, [220, 220, 150]],
  [800, [130, 190, 110]],
  [1500, [50, 150, 120]],
  [2500, [40, 100, 170]],
  [4500, [60, 50, 150]],
];
const MOIST: [number, RGB][] = [
  [0, [160, 100, 60]],
  [0.2, [220, 190, 120]],
  [0.5, [220, 220, 150]],
  [1, [120, 180, 100]],
  [2, [40, 130, 110]],
  [4, [40, 80, 160]],
];
const DIVERGE: [number, RGB][] = [
  [-1, [40, 80, 200]],
  [0, [150, 150, 145]],
  [1, [200, 50, 40]],
];
const UNIT: [number, RGB][] = [
  [0, [30, 30, 60]],
  [0.25, [60, 80, 160]],
  [0.5, [60, 160, 140]],
  [0.75, [200, 210, 90]],
  [1, [250, 240, 200]],
];

export interface ColorOptions {
  mode: ViewMode;
  season: Season;
  focusSpecies: string | null;
  borders: boolean;
}

// 与视图模式无关、只取决于世界的逐格数据，按世界缓存。
// 湖在画面上是水面：海岸值取负（有岸线、有格以下的岸线细节）、高程取负的水深（浅水边）、坡度为 0
// 按高程数组缓存（只改了名字、省份的轻快照沿用同一个数组）
const staticCache = new WeakMap<Float32Array, { coast: Float32Array; grad: Float32Array; elevation: Float32Array }>();

const isLake = (world: World, i: number) => world.causes.land[i] === 1 && world.derived.lake[i] === 1;
// 湖水深（m），至少 2 m
const lakeDepth = (world: World, i: number) => Math.max(2, world.derived.water[i] - world.derived.elevation[i]);

function staticLayers(world: World) {
  let c = staticCache.get(world.derived.elevation);
  if (c) return c;
  const { mesh, derived: d, causes } = world;
  const coast = coastValues(world);
  const elevation = d.elevation.slice();
  const grad = new Float32Array(mesh.n * 2);
  const h = new Float64Array(mesh.n);
  for (let i = 0; i < mesh.n; i++) {
    h[i] = causes.land[i] ? Math.max(0, d.elevation[i]) : 0;
    if (isLake(world, i)) {
      h[i] = Math.max(0, d.water[i]);
      coast[i] = -Math.max(60, Math.abs(coast[i]));
      elevation[i] = -lakeDepth(world, i);
    }
  }
  for (let i = 0; i < mesh.n; i++) {
    if (!causes.land[i] || isLake(world, i)) continue;
    const [gx, gy] = gradient(mesh, h, i);
    grad[2 * i] = gx;
    grad[2 * i + 1] = gy;
  }
  c = { coast, grad, elevation };
  staticCache.set(world.derived.elevation, c);
  return c;
}

export function cellLayers(world: World, o: ColorOptions): CellLayers {
  const { mesh, causes, derived: d, small } = world;
  const n = mesh.n;
  const smooth = new Uint8Array(n * 4);
  let flat: Uint8Array | null = null;
  let shade = 1;
  let rock = 0;
  const S = small.species.length;
  const speciesRgb = small.species.map((s) => hexToRgb(s.color));
  const put = (arr: Uint8Array, i: number, c: RGB, a = 255) => {
    arr[i * 4] = c[0];
    arr[i * 4 + 1] = c[1];
    arr[i * 4 + 2] = c[2];
    arr[i * 4 + 3] = a;
  };
  const lakeColor: RGB = [70, 125, 175];
  const playaColor: RGB = [226, 218, 196];
  const seasonal = (annual: Float32Array, s: Float32Array, w: Float32Array, i: number, half = false) =>
    o.season === 'summer' ? (half ? s[i] * 2 : s[i]) : o.season === 'winter' ? (half ? w[i] * 2 : w[i]) : annual[i];
  const terrainLike = o.mode === 'terrain' || o.mode === 'dominant' || o.mode === 'provinces';
  if (terrainLike) rock = 1;

  for (let i = 0; i < n; i++) {
    const land = causes.land[i] === 1;
    if (!land) {
      // alpha：海水暖度，决定浅水的颜色
      const warm = Math.round(255 * Math.min(1, Math.max(0, (d.tMean[i] - 14) / 12)));
      put(smooth, i, terrainLike || o.mode === 'elevation' || o.mode === 'uplift' ? ramp(SEA, d.elevation[i]) : [40, 50, 70], warm);
      continue;
    }
    if (d.lake[i] === 1) {
      // 湖面：和海一样按水深取色（alpha：水的暖度）；数据底图里用固定的湖蓝
      const warm = Math.round(255 * Math.min(1, Math.max(0, (d.tMean[i] - 14) / 12)));
      put(smooth, i, terrainLike || o.mode === 'elevation' || o.mode === 'uplift' ? ramp(SEA, -lakeDepth(world, i) * 2) : lakeColor, warm);
      continue;
    }
    // alpha：地表的“沙质”程度（越干越沙），决定海边有没有沙滩
    const sandy = Math.round(255 * Math.min(1, Math.max(0, 1 - d.moisture[i] / 0.8)));
    let c: RGB;
    switch (o.mode) {
      case 'terrain':
      case 'dominant':
      case 'provinces': {
        // 植被按份额混色，积雪按季节覆盖
        c = blendRgb(d.share, i, speciesRgb);
        if (d.lake[i] === 2) c = playaColor;
        const snowT = o.season === 'winter' ? Math.min(d.tS[i], d.tW[i]) : o.season === 'summer' ? Math.max(d.tS[i], d.tW[i]) : d.tWarm[i];
        if (snowT < 0) {
          const k = Math.min(1, -snowT / 6);
          c = [c[0] + (245 - c[0]) * k, c[1] + (248 - c[1]) * k, c[2] + (250 - c[2]) * k];
        }
        break;
      }
      case 'elevation':
        c = ramp(HYPSO, d.elevation[i]);
        break;
      case 'uplift':
        c = ramp(UNIT, causes.uplift[i] / 1.3);
        break;
      case 'temperature':
        c = ramp(TEMP, seasonal(d.tMean, d.tS, d.tW, i));
        shade = 0.4;
        break;
      case 'precip':
        c = ramp(PRECIP, seasonal(d.precip, d.pS, d.pW, i, true));
        shade = 0.4;
        break;
      case 'moisture':
        c = ramp(MOIST, d.moisture[i]);
        shade = 0.4;
        break;
      case 'wetness':
        c = ramp(UNIT, (d.wetness[i] - 12) / 14);
        shade = 0.3;
        break;
      case 'continentality':
        c = ramp(UNIT, d.continentality[i]);
        shade = 0.3;
        break;
      case 'corrT':
        c = ramp(DIVERGE, (d.corrT[i] + causes.tempOffset[i]) / 10);
        shade = 0.4;
        break;
      case 'corrP':
        c = ramp(DIVERGE, -(d.corrP[i] + causes.moistOffset[i]) / 1.5);
        shade = 0.4;
        break;
      case 'suitability': {
        const s = small.species.findIndex((sp) => sp.id === o.focusSpecies);
        c = s >= 0 ? ramp(UNIT, d.suit[i * S + s]) : [80, 80, 80];
        shade = 0.4;
        break;
      }
      default: {
        if (o.mode.startsWith('field:')) {
          const name = o.mode.slice(6);
          const v = (causes.fields[name]?.[i] ?? 0) + (d.corrF[name]?.[i] ?? 0);
          c = ramp(UNIT, v);
          shade = 0.4;
        } else c = [128, 128, 128];
      }
    }
    put(smooth, i, c, sandy);
  }

  if (o.mode === 'dominant') {
    flat = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const s = d.dominant[i];
      if (s >= 0) put(flat, i, speciesRgb[s], d.overridden[i] ? 255 : 220);
    }
  } else if (o.mode === 'provinces') {
    flat = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const p = causes.province[i];
      if (p < 0) continue;
      const kind = small.provinces[p]?.kind;
      // 无人区偏灰、湖省偏蓝，一眼能和普通省份分开
      if (kind === 'wasteland') {
        const c = provinceColor(p);
        put(flat, i, [(c[0] + 2 * 150) / 3, (c[1] + 2 * 150) / 3, (c[2] + 2 * 150) / 3], 170);
      } else if (kind === 'lake') put(flat, i, [70, 125, 190], 150);
      else put(flat, i, provinceColor(p), causes.land[i] ? 140 : 70);
    }
  }

  let group: Float32Array | null = null;
  if (o.borders || o.mode === 'provinces') {
    group = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = causes.province[i];
      group[i] = p < 0 ? 0 : causes.land[i] ? p + 1 : -(p + 1);
    }
  }
  const st = staticLayers(world);
  // 对岸的颜色：陆地格取相邻水面格的平均色，水面格取相邻陆地格的平均色（含 alpha）。
  // 着色器里陆地像素只用陆色、水面像素只用水色，海岸两边的颜色不再互相渗
  const other = smooth.slice();
  for (let i = 0; i < n; i++) {
    const wet = st.coast[i] <= 0;
    let k = 0;
    const sum = [0, 0, 0, 0];
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (st.coast[j] <= 0 === wet) continue;
      for (let c = 0; c < 4; c++) sum[c] += smooth[j * 4 + c];
      k++;
    }
    if (k) for (let c = 0; c < 4; c++) other[i * 4 + c] = Math.round(sum[c] / k);
  }
  return {
    smooth,
    other,
    elevation: st.elevation,
    coast: st.coast,
    grad: st.grad,
    flat,
    group,
    shade,
    rock,
    coastAmp: COAST_AMP * small.terrain.coastRoughness,
  };
}

export interface HighlightLayer {
  cells: number[];
  values?: number[];
  color: RGB;
  alpha?: number;
  // 斜线：没能做到的格
  pattern?: 'fill' | 'hatch';
}

// 高亮层：选区、预览、没涂成的格、变化。后面的层盖住前面的层。
// alpha 字节的编码：1–127 为平涂的不透明度，129–255 为斜线的不透明度（着色器按此解码）
export function highlightColors(world: World, layers: HighlightLayer[]): Uint8Array | null {
  if (!layers.length) return null;
  const n = world.mesh.n;
  const out = new Uint8Array(n * 4);
  for (const l of layers) {
    const a = l.alpha ?? 0.45;
    const hatch = l.pattern === 'hatch';
    l.cells.forEach((i, k) => {
      if (i < 0 || i >= n) return;
      const v = Math.max(0, Math.min(1, l.values ? l.values[k] : 1));
      const level = Math.round(127 * a * v);
      if (level <= 0) return;
      out[i * 4] = l.color[0];
      out[i * 4 + 1] = l.color[1];
      out[i * 4 + 2] = l.color[2];
      out[i * 4 + 3] = hatch ? 128 + level : level;
    });
  }
  return out;
}
