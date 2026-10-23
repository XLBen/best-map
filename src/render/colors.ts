import { blendRgb, cellFx, fxPalette, fxSet } from '../../core/biome-look';
import { hexToRgb } from '../../core/export';
import { gradient } from '../../core/mesh';
import type { ProvinceKind } from '../../core/provinces';
import { type ProvinceSeam, type SeamLayers, seamLayers, seamsAfterCut } from '../../core/seams';
import type { LakeType } from '../../core/lake-types';
import type { Visual } from '../../core/species';
import { displayCoast, lakeCoast, lakeDepth } from '../../core/display';
import { coastPatch } from '../../core/subcell';
import { COAST_AMP, type TerrainPreview, landPatch } from '../../core/terrain';
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
// 按用到的数组缓存：高程、湖、水面、陆海、陆地程度（只改了名字、省份的轻快照沿用同一批数组）。
// 预览世界只换变了的数组：整体干湿的预览高程不变、湖变了，不能只看高程，否则会画出旧的湖
type StaticLayers = { coast: Float32Array; grad: Float32Array; elevation: Float32Array };
const staticCache = new WeakMap<Float32Array, { inputs: ArrayBufferView[]; value: StaticLayers }[]>();

const isLake = (world: World, i: number) => world.causes.land[i] === 1 && world.derived.lake[i] === 1;
// 湖水深、湖面的海岸值：见 core/display.ts（河口按同一份海岸场找岸线）
// 水面的暖度（浅水颜色用，放在颜色的 alpha 里）
const warmth = (world: World, i: number) => Math.round(255 * Math.min(1, Math.max(0, (world.derived.tMean[i] - 14) / 12)));
// 积雪盖住多少（0–1）：按季节取最暖那一季（全年看暖季）的气温，0 °C 以下越冷越白，−6 °C 全白
function snowAmount(world: World, season: Season, i: number): number {
  const d = world.derived;
  const snowT = season === 'winter' ? Math.min(d.tS[i], d.tW[i]) : season === 'summer' ? Math.max(d.tS[i], d.tW[i]) : d.tWarm[i];
  return snowT < 0 ? Math.min(1, -snowT / 6) : 0;
}
const terrainLikeMode = (mode: ViewMode) => mode === 'terrain' || mode === 'dominant' || mode === 'provinces';

function staticLayers(world: World): StaticLayers {
  const inputs = [world.derived.lake, world.derived.water, world.causes.land, world.causes.landness];
  let list = staticCache.get(world.derived.elevation);
  if (!list) staticCache.set(world.derived.elevation, (list = []));
  const hit = list.find((e) => e.inputs.every((a, k) => a === inputs[k]));
  if (hit) return hit.value;
  const c = computeStatic(world);
  // 同一份高程最多留两份（当前世界与预览世界）
  list.unshift({ inputs, value: c });
  list.length = Math.min(list.length, 2);
  return c;
}

function computeStatic(world: World): StaticLayers {
  const { mesh, derived: d, causes } = world;
  // 海岸值与高程（湖面取负）：与河口找岸线用的是同一份（core/display.ts 的 displayCoast）
  const { coast, elevation } = displayCoast(world);
  const grad = new Float32Array(mesh.n * 2);
  const h = new Float64Array(mesh.n);
  for (let i = 0; i < mesh.n; i++) {
    h[i] = causes.land[i] ? Math.max(0, d.elevation[i]) : 0;
    if (isLake(world, i)) h[i] = Math.max(0, d.water[i]);
  }
  for (let i = 0; i < mesh.n; i++) {
    if (!causes.land[i] || isLake(world, i)) continue;
    const [gx, gy] = gradient(mesh, h, i);
    grad[2 * i] = gx;
    grad[2 * i + 1] = gy;
  }
  return { coast, grad, elevation };
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
  const terrainLike = terrainLikeMode(o.mode);
  if (terrainLike) rock = 1;

  for (let i = 0; i < n; i++) {
    const land = causes.land[i] === 1;
    if (!land) {
      // alpha：海水暖度，决定浅水的颜色
      put(smooth, i, terrainLike || o.mode === 'elevation' || o.mode === 'uplift' ? ramp(SEA, d.elevation[i]) : [40, 50, 70], warmth(world, i));
      continue;
    }
    if (d.lake[i] === 1) {
      // 湖面：和海一样按水深取色（alpha：水的暖度）；数据底图里用固定的湖蓝
      put(smooth, i, terrainLike || o.mode === 'elevation' || o.mode === 'uplift' ? ramp(SEA, -lakeDepth(world, i) * 2) : lakeColor, warmth(world, i));
      continue;
    }
    // alpha：地表的“沙质”程度（越干越沙），决定海边有没有沙滩
    const sandy = Math.round(255 * Math.min(1, Math.max(0, 1 - d.moisture[i] / 0.8)));
    let c: RGB;
    switch (o.mode) {
      case 'terrain':
      case 'dominant':
      case 'provinces': {
        // 植被按份额混色（有颜色脚本时用它算好的 d.look），积雪按季节覆盖
        c = d.look && d.look[i * 4 + 3] ? [d.look[i * 4], d.look[i * 4 + 1], d.look[i * 4 + 2]] : blendRgb(d.share, i, speciesRgb);
        if (d.lake[i] === 2) c = playaColor;
        const k = snowAmount(world, o.season, i);
        if (k > 0) c = [c[0] + (245 - c[0]) * k, c[1] + (248 - c[1]) * k, c[2] + (250 - c[2]) * k];
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
  } else if (o.mode === 'provinces') flat = provinceFlat(world, causes.province);

  // 省界：剪刀切过的地方按切线画（切线附近按在线的哪一边分省，见 core/seams.ts）
  const seams = o.borders || o.mode === 'provinces' ? seamLayers(world, causes.province, small.provinceSeams) : null;
  const group = o.borders || o.mode === 'provinces' ? provinceGroups(world, causes.province, seams) : null;
  const st = staticLayers(world);
  // 对岸的颜色（fillOther）：着色器里陆地像素只用陆色、水面像素只用水色，海岸两边的颜色不再互相渗
  const other = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) fillOther(mesh, smooth, st.coast, other, i);
  const fx = fxLayers(world, o);
  return {
    smooth,
    other,
    elevation: st.elevation,
    coast: st.coast,
    grad: st.grad,
    flat,
    group,
    seams,
    shade,
    rock,
    coastAmp: COAST_AMP * small.terrain.coastRoughness,
    fx: fx?.fx ?? null,
    fxPalette: fx?.palette ?? null,
  };
}

// 小数据里着色用到的部分连成一个字符串（MapView 着色缓存的键之一）：省份类型、切线、生态的颜色与外观（花纹、发光、种子）、海岸曲折。
// 只改生态外观的一步什么都不重算（轻快照，推导数组不变），靠外观这一段重新着色；只改名字、地名设定时不变，不重新着色
export function colorSignature(small: World['small']): string {
  const kinds = Object.entries(small.provinces).map(([p, m]) => `${p}:${m.kind}`);
  const seams = (small.provinceSeams ?? []).map((s) => s.id);
  const colors = small.species.map((s) => s.color);
  const looks = small.species.map((s) => (s.visual ? `${s.id}:${s.seedKey ?? ''}:${JSON.stringify(s.visual)}` : ''));
  return `${kinds.join(',')}|${seams.join(',')}|${colors.join(',')}|${small.terrain.coastRoughness}|${looks.join(',')}`;
}

// ---------- 生态的花纹与发光（第三批） ----------
// 每格一个 RGBA 字节：R = 份额最大的有花纹的生态在调色板里的行 + 1（0 没有花纹），G = 它的份额 × 255
// （被雪、盐壳盖住的部分不算），B = Σ 份额 × 发光强度 × 255，A = 发光颜色取的那一行 + 1（0 不发光）。
// 调色板见 core/biome-look.ts 的 fxPalette。只在地形类的着色（地形、主导生态、省份）里画；
// 没有一种生态有花纹或发光时为 null（着色器整段跳过，画面与以前逐像素相同）。
// overrides：拖花纹、发光滑块时按 id 换上的外观（主线程上立即画，不必等引擎）
export function fxLayers(world: World, o: Pick<ColorOptions, 'mode' | 'season'>, overrides?: ReadonlyMap<string, Visual>): { fx: Uint8Array; palette: Float32Array } | null {
  if (!terrainLikeMode(o.mode)) return null;
  const { mesh, causes, derived: d, small } = world;
  const set = fxSet(small.species, mesh.kind === 'sphere', overrides);
  if (!set) return null;
  const n = mesh.n;
  const S = small.species.length;
  const fx = new Uint8Array(n * 4);
  const cf = new Float64Array(4);
  for (let i = 0; i < n; i++) {
    if (!causes.land[i] || d.lake[i] === 1) continue;
    cellFx(set, d.share, i, S, cf);
    const cover = d.lake[i] === 2 ? 0 : 1 - snowAmount(world, o.season, i);
    const o4 = i * 4;
    fx[o4] = cf[0] + 1;
    fx[o4 + 1] = cf[0] >= 0 ? Math.round(255 * Math.min(1, cf[1]) * cover) : 0;
    fx[o4 + 2] = Math.round(255 * cf[2]);
    fx[o4 + 3] = cf[3] + 1;
  }
  return { fx, palette: fxPalette(set) };
}

// ---------- 湖泊类型的颜色（第九轮） ----------
// 每格一个 RGBA 字节：RGB 是这种湖的颜色（地图集风格用 atlasColor），A 的低两位是水面的画法（1 染色、2 像干湖底那样的盐壳），
// 再两位是陆上的（1 湖岸的光晕、2 干涸湖底的盐壳），16 是发光（湖面亮一些）。湖岸那一圈陆地格也带上水面的画法：
// 湖岸线在格以下（不是格的边），落在岸边那格里的水面像素也要染上。
// 只在地形类的着色里画；世界里没有湖泊类型（或者一个带类型的湖都没有）时为 null（着色器整段跳过，画面与以前逐像素相同）
export const LAKE_WATER_TINT = 1;
export const LAKE_WATER_CRUST = 2;
export const LAKE_LAND_GLOW = 4;
const LAKE_LAND_CRUST = 8;
export const LAKE_GLOW = 16;

// 一种湖画出来的颜色（地图集风格用 atlasColor）
export function lakeTypeColor(t: Pick<LakeType, 'color' | 'atlasColor'>, style: 'realistic' | 'atlas'): string {
  return style === 'atlas' ? (t.atlasColor ?? t.color) : t.color;
}

// 湖泊类型里影响画法的几项（没有时为 ''）
export function lakeTypesSignature(types: readonly LakeType[] | undefined): string {
  return types?.length ? JSON.stringify(types.map((t) => [t.id, t.color, t.atlasColor ?? '', t.style ?? 'solid'])) : '';
}

export function lakeTintLayer(world: World, o: Pick<ColorOptions, 'mode'>, style: 'realistic' | 'atlas'): Uint8Array | null {
  const types = world.small.lakeTypes;
  const lt = world.derived.lakeType;
  if (!types?.length || !lt || !terrainLikeMode(o.mode)) return null;
  const { mesh, causes, derived: d } = world;
  const n = mesh.n;
  const rgb = types.map((t) => hexToRgb(lakeTypeColor(t, style)));
  const out = new Uint8Array(n * 4);
  let any = false;
  const put = (i: number, k: number, bits: number) => {
    const o4 = i * 4;
    out[o4] = rgb[k][0];
    out[o4 + 1] = rgb[k][1];
    out[o4 + 2] = rgb[k][2];
    out[o4 + 3] |= bits;
  };
  // 这一格挨着海、或者挨着别的湖（不是第 v 种）的湖面
  const sharesWater = (j: number, v: number) => {
    for (let f = mesh.off[j]; f < mesh.off[j + 1]; f++) {
      const k = mesh.adj[f];
      if (!causes.land[k] || (d.lake[k] === 1 && lt[k] !== v)) return true;
    }
    return false;
  };
  for (let i = 0; i < n; i++) {
    const v = lt[i];
    if (!v || !causes.land[i]) continue;
    const t = types[v - 1];
    if (!t) continue;
    any = true;
    const playa = t.style === 'playa';
    const glow = t.style === 'glow' ? LAKE_GLOW : 0;
    const water = playa ? LAKE_WATER_CRUST : LAKE_WATER_TINT;
    if (d.lake[i] !== 1) {
      // 干涸的湖底：陆上的盐壳带上这种湖的颜色（挨着海、别的湖时水面像素不染）
      put(i, v - 1, LAKE_LAND_CRUST | (sharesWater(i, v) ? 0 : water));
      continue;
    }
    put(i, v - 1, water | glow);
    // 湖岸那一圈：水面像素照湖的画法；发光的湖岸上一圈光晕。
    // 岸边那格也挨着别的湖（不是这一种）时不染水面：那格里的水面像素可能是那个湖的
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (lt[j] || !causes.land[j]) continue;
      const bits = (sharesWater(j, v) ? 0 : water | glow) | (glow ? LAKE_LAND_GLOW : 0);
      if (bits && (out[j * 4 + 3] === 0 || glow)) put(j, v - 1, bits);
    }
  }
  return any ? out : null;
}

// 省份着色的平涂：每省一种颜色；无人区偏灰、湖省偏蓝，一眼能和普通省份分开。
// kindOf：省的类型（预览里还没有的新省，取它切出来的那个省的类型）。每个省的颜色只算一次：
// 剪刀、涂省拖动时每动一下都要整张重算，十万格的星球上逐格查类型、建颜色数组要几十毫秒
export function provinceFlat(world: World, province: Int32Array, kindOf = (p: number) => world.small.provinces[p]?.kind): Uint8Array {
  const { mesh, causes } = world;
  const flat = new Uint8Array(mesh.n * 4);
  // 每个省：颜色与陆地、海上的不透明度
  const look = new Map<number, [number, number, number, number, number]>();
  for (let i = 0; i < mesh.n; i++) {
    const p = province[i];
    if (p < 0) continue;
    let v = look.get(p);
    if (!v) {
      const kind = kindOf(p);
      const c = provinceColor(p);
      if (kind === 'wasteland') v = [(c[0] + 2 * 150) / 3, (c[1] + 2 * 150) / 3, (c[2] + 2 * 150) / 3, 170, 170];
      else if (kind === 'lake') v = [70, 125, 190, 150, 150];
      else v = [c[0], c[1], c[2], 140, 70];
      look.set(p, v);
    }
    flat[i * 4] = v[0];
    flat[i * 4 + 1] = v[1];
    flat[i * 4 + 2] = v[2];
    flat[i * 4 + 3] = causes.land[i] ? v[3] : v[4];
  }
  return flat;
}

// 分组（画省界）：每格两个值。第一个：陆地省份 = 编号 + 1，海域省份 = −(编号 + 1)，未划分 = 0；
// 第二个：切线附近这一格能不能按切线换（seams.ts 的 ok，没有切线时都是 0）
export function provinceGroups(world: World, province: Int32Array, seams: SeamLayers | null = null): Float32Array {
  const { mesh, causes } = world;
  const group = new Float32Array(mesh.n * 2);
  for (let i = 0; i < mesh.n; i++) {
    const p = province[i];
    group[2 * i] = p < 0 ? 0 : causes.land[i] ? p + 1 : -(p + 1);
    if (seams) group[2 * i + 1] = seams.ok[i];
  }
  return group;
}

// 省份预览（剪刀、涂省、合并、重划）：这些格换成将来的省（剪刀还多几条将来的切线 seams），返回整份分组、
// （省份着色时的）平涂与切线，交给 Renderer.setGroupPreview。着色器照此画出将来真实的省界，用的是和结果相同的编码、扭曲与切线规则。
// 重划、重新划分时给整份将来的省份数组 province、将来全部的切线 seamList 与各省 metas（Worker 里的省份预览算好的），
// cells、ids 再改在它上面
export function groupPreview(
  world: World,
  change: {
    cells: ArrayLike<number>;
    ids: ArrayLike<number>;
    seams?: Omit<ProvinceSeam, 'id'>[];
    province?: Int32Array;
    seamList?: readonly ProvinceSeam[] | null;
    metas?: Record<number, { kind: ProvinceKind }>;
  },
  mode: ViewMode,
): { group: Float32Array; flat: Uint8Array | null; seams: SeamLayers | null } {
  const base = change.province ?? world.causes.province;
  const province = base.slice();
  for (let k = 0; k < change.cells.length; k++) province[change.cells[k]] = change.ids[k];
  const known = (p: number) => (change.metas ? change.metas[p] : undefined) ?? world.small.provinces[p];
  // 还没有的新省（剪刀切出来的几块）：类型随它切出来的那个省（与 cut_province 里按多数取的相同：一块只来自一个省）
  const born = new Map<number, ProvinceKind | undefined>();
  for (let k = 0; k < change.cells.length; k++) {
    const id = change.ids[k];
    if (!known(id) && !born.has(id)) born.set(id, known(base[change.cells[k]])?.kind);
  }
  const kindOf = (p: number) => known(p)?.kind ?? born.get(p);
  // 剪刀：与切线命令记下的一样（seamsAfterCut：原有的切线也管切出来的新省，再加这一刀的几条）
  let k = 0;
  const existing = change.seamList !== undefined ? (change.seamList ?? undefined) : world.small.provinceSeams;
  const list = seamsAfterCut(existing, change.seams ?? [], () => `preview-${k++}`);
  const seams = seamLayers(world, province, list);
  return { group: provinceGroups(world, province, seams), flat: mode === 'provinces' ? provinceFlat(world, province, kindOf) : null, seams };
}

export interface HighlightLayer {
  cells: number[];
  values?: number[];
  color: RGB;
  alpha?: number;
  // hatch：斜线（没能做到的格）；outline：只描出这些格的外沿，不填色（alpha、values 用不上）
  pattern?: 'fill' | 'hatch' | 'outline';
}

// 高亮层：选区、预览、没涂成的格、变化。后面的层盖住前面的层。
// alpha 字节的编码：1–127 为平涂的不透明度，128 为只描边，129–255 为斜线的不透明度（着色器按此解码）
export function highlightColors(world: World, layers: HighlightLayer[]): Uint8Array | null {
  if (!layers.length) return null;
  const n = world.mesh.n;
  const out = new Uint8Array(n * 4);
  for (const l of layers) {
    const a = l.alpha ?? 0.45;
    const hatch = l.pattern === 'hatch';
    const outline = l.pattern === 'outline';
    l.cells.forEach((i, k) => {
      if (i < 0 || i >= n) return;
      const v = Math.max(0, Math.min(1, l.values ? l.values[k] : 1));
      const level = outline ? 0 : Math.round(127 * a * v);
      if (level <= 0 && !outline) return;
      out[i * 4] = l.color[0];
      out[i * 4 + 1] = l.color[1];
      out[i * 4 + 2] = l.color[2];
      out[i * 4 + 3] = outline ? 128 : hatch ? 128 + level : level;
    });
  }
  return out;
}

// 每个省大约几格宽：√（省份格数的中位数）。缩小看时省界按它淡出（大省的边界留得久，小省的先淡）；没有省份时为 1
export function provinceScale(province: Int32Array): number {
  const counts = new Map<number, number>();
  for (let i = 0; i < province.length; i++) {
    const p = province[i];
    if (p >= 0) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  if (!counts.size) return 1;
  const sizes = [...counts.values()].sort((a, b) => a - b);
  return Math.sqrt(sizes[Math.floor(sizes.length / 2)]);
}

// ---------- 幽灵海岸 ----------
// 陆地、海的工具（画陆地、圈一片、恢复原样、放岛、岛链、放湖、“调整”里的地形滑块、重画这一片）在松手前、算的时候
// 就画出将来真实的海岸线：几格的地形输入（海岸值、高程、颜色、对岸的颜色，以及平涂、分组）换成将来的样子，着色器照常画。
// 海岸值与结果逐格相同（core/subcell.ts 的 coastPatch、core/terrain.ts 的 previewTerrain）；
// 变成陆地、变成海的格，颜色与高程在结果到来之前是估计：颜色取同类邻格的平均，高程取 ±40 m（海岸细节的幅度随高程变）

// 工具给的改动：这些格的 landness 将来加多少；lake：将来成湖的格
export interface GhostEdit {
  cells: number[];
  delta: number[];
  lake?: number[];
}

// 补丁：这些格（升序）将来的海岸值与陆海；lake：将来是湖面（海岸值照 staticLayers 的规则取负）
export interface GhostPatch {
  cells: Int32Array;
  coast: Float32Array;
  land: Uint8Array;
  lake?: Uint8Array;
}

// 工具的改动 → 补丁：landPatch 的那些格（改动的格与邻格，邻格可能因补单格海洞而变）再加上成湖的格。
// 原来的湖还是陆地时照旧画成湖面（湖会不会变要等结果）
export function editGhost(world: World, base: CellLayers, edit: GhostEdit): GhostPatch {
  const lp = landPatch(world, edit.cells, edit.delta);
  const coast = coastPatch(world, lp.cells, lp.landness, lp.land);
  const at = new Map<number, number>();
  lp.cells.forEach((i, k) => at.set(i, k));
  const lakes = new Set(edit.lake ?? []);
  const extra = [...lakes].filter((i) => !at.has(i));
  const cells = extra.length ? Int32Array.from([...lp.cells, ...extra]).sort() : lp.cells;
  const out: GhostPatch = { cells, coast: new Float32Array(cells.length), land: new Uint8Array(cells.length), lake: new Uint8Array(cells.length) };
  cells.forEach((i, k) => {
    const j = at.get(i);
    out.coast[k] = j !== undefined ? coast[j] : base.coast[i];
    out.land[k] = j !== undefined ? lp.land[j] : world.causes.land[i];
    out.lake![k] = out.land[k] && (lakes.has(i) || isLake(world, i)) ? 1 : 0;
  });
  return out;
}

// 整份将来的海岸（调整滑块、重画这一片）→ 补丁：海岸值与现在不同的格。原来的湖还是陆地时照旧画成湖面
export function terrainGhost(world: World, base: CellLayers, t: TerrainPreview): GhostPatch {
  const n = world.mesh.n;
  const gained = new Set(t.gained);
  const lost = new Set(t.lost);
  const cells: number[] = [];
  for (let i = 0; i < n; i++) {
    const land = gained.has(i) || (world.causes.land[i] === 1 && !lost.has(i));
    const c = land && isLake(world, i) ? lakeCoast(t.coast[i]) : t.coast[i];
    if (!Object.is(Math.fround(c), base.coast[i])) cells.push(i);
  }
  const out: GhostPatch = { cells: Int32Array.from(cells), coast: new Float32Array(cells.length), land: new Uint8Array(cells.length), lake: new Uint8Array(cells.length) };
  cells.forEach((i, k) => {
    const land = gained.has(i) || (world.causes.land[i] === 1 && !lost.has(i));
    out.coast[k] = t.coast[i];
    out.land[k] = land ? 1 : 0;
    out.lake![k] = land && isLake(world, i) ? 1 : 0;
  });
  return out;
}

export interface GhostLayers {
  smooth: Uint8Array;
  other: Uint8Array;
  elevation: Float32Array;
  coast: Float32Array;
  flat: Uint8Array | null;
  group: Float32Array | null;
  // 现在与底子不同的格（升序）：上传时只传这些格（与上一次不同的格）所在的行
  cells: Int32Array;
  // 将来的海岸细节幅度（海岸曲折的滑块）；没有时照旧
  coastAmp?: number;
}

// 持久的幽灵缓冲：底子的一份副本，每次只把上次改过的格还原、再写这次的补丁，不必每动一下都复制整张图。
// 底子（setLayers 给的图层）换了就新建一个
export class GhostBuffer {
  readonly smooth: Uint8Array;
  readonly other: Uint8Array;
  readonly elevation: Float32Array;
  readonly coast: Float32Array;
  readonly flat: Uint8Array | null;
  readonly group: Float32Array | null;
  // 上次写过的格
  private written: number[] = [];
  private mark: Uint8Array;

  constructor(
    readonly base: CellLayers,
    readonly mode: ViewMode,
  ) {
    this.smooth = base.smooth.slice();
    this.other = base.other.slice();
    this.elevation = base.elevation.slice();
    this.coast = base.coast.slice();
    this.flat = base.flat ? base.flat.slice() : null;
    this.group = base.group ? base.group.slice() : null;
    this.mark = new Uint8Array(base.coast.length);
  }

  apply(world: World, patch: GhostPatch | null, coastAmp?: number): GhostLayers {
    const { base } = this;
    for (const i of this.written) {
      this.mark[i] = 0;
      for (let c = 0; c < 4; c++) {
        this.smooth[i * 4 + c] = base.smooth[i * 4 + c];
        this.other[i * 4 + c] = base.other[i * 4 + c];
        if (this.flat) this.flat[i * 4 + c] = base.flat![i * 4 + c];
      }
      this.elevation[i] = base.elevation[i];
      this.coast[i] = base.coast[i];
      if (this.group) {
        this.group[2 * i] = base.group![2 * i];
        this.group[2 * i + 1] = base.group![2 * i + 1];
      }
    }
    this.written = [];
    if (patch) this.write(world, patch);
    const cells = Int32Array.from(this.written).sort();
    return { smooth: this.smooth, other: this.other, elevation: this.elevation, coast: this.coast, flat: this.flat, group: this.group, cells, coastAmp };
  }

  private touch(i: number) {
    if (this.mark[i]) return;
    this.mark[i] = 1;
    this.written.push(i);
  }

  private write(world: World, p: GhostPatch) {
    const { mesh } = world;
    const { base, smooth, coast, elevation } = this;
    // 变成陆地、变成海、新成湖的格
    const toLand: number[] = [];
    const toSea: number[] = [];
    const toLake: number[] = [];
    const flipped = new Uint8Array(mesh.n);
    for (let k = 0; k < p.cells.length; k++) {
      const i = p.cells[k];
      const lake = p.lake?.[k] === 1;
      const c = Math.fround(lake ? lakeCoast(p.coast[k]) : p.coast[k]);
      if (!Object.is(c, base.coast[i])) {
        coast[i] = c;
        this.touch(i);
      }
      // 湖变成了海：照海的样子画（海岸值本来就是负的）
      const lakeToSea = !p.land[k] && isLake(world, i);
      if (base.coast[i] <= 0 === c <= 0 && !lakeToSea) continue;
      flipped[i] = 1;
      (c > 0 ? toLand : lake ? toLake : toSea).push(i);
    }
    const terrainLike = this.mode === 'terrain' || this.mode === 'dominant' || this.mode === 'provinces';
    const depthColors = terrainLike || this.mode === 'elevation' || this.mode === 'uplift';
    const put = (i: number, rgb: RGB, a: number) => {
      smooth.set([Math.round(rgb[0]), Math.round(rgb[1]), Math.round(rgb[2]), a], i * 4);
      this.touch(i);
    };
    // 颜色：同类邻格（不是刚变过来的）的平均，往里最多推三层；推不到的用这种底图的默认色
    const fill = (list: number[], same: (j: number) => boolean, fallback: (i: number) => [RGB, number]) => {
      const known = new Uint8Array(mesh.n);
      let left = list;
      for (let pass = 0; pass < 3 && left.length; pass++) {
        const got: [number, number[]][] = [];
        const rest: number[] = [];
        for (const i of left) {
          const sum = [0, 0, 0, 0];
          let k = 0;
          for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
            const j = mesh.adj[e];
            if (!same(j) || (flipped[j] && !known[j])) continue;
            for (let c = 0; c < 4; c++) sum[c] += smooth[j * 4 + c];
            k++;
          }
          if (k) got.push([i, sum.map((v) => v / k)]);
          else rest.push(i);
        }
        for (const [i, s] of got) {
          put(i, [s[0], s[1], s[2]], Math.round(s[3]));
          known[i] = 1;
        }
        left = rest;
      }
      for (const i of left) put(i, ...fallback(i));
    };
    fill(
      toLand,
      (j) => coast[j] > 0,
      () => [depthColors ? ramp(HYPSO, 40) : [128, 128, 128], 128],
    );
    fill(
      toSea,
      (j) => coast[j] <= 0 && !(world.causes.land[j] === 1 && flipped[j] === 0),
      (i) => [depthColors ? ramp(SEA, -40) : [40, 50, 70], warmth(world, i)],
    );
    for (const i of toLake) put(i, depthColors ? ramp(SEA, -60) : [70, 125, 175], warmth(world, i));
    // 高程：新陆地至少 40 m、新海至少 40 m 深、新湖 30 m 深（海岸细节的幅度跟着高程）
    for (const i of toLand) elevation[i] = Math.max(base.elevation[i], 40);
    for (const i of toSea) elevation[i] = Math.min(base.elevation[i], -40);
    for (const i of toLake) elevation[i] = -30;
    // 平涂不画在变过的格上（湖还在原来的省里）；分组（省界）取同类邻省的，没有就不算哪个省
    for (const i of [...toLand, ...toSea, ...toLake]) if (this.flat) this.flat[i * 4 + 3] = 0;
    for (const i of [...toLand, ...toSea]) {
      if (!this.group) break;
      const land = coast[i] > 0;
      let g = 0;
      for (let e = mesh.off[i]; e < mesh.off[i + 1] && !g; e++) {
        const v = base.group![2 * mesh.adj[e]];
        if (!flipped[mesh.adj[e]] && v !== 0 && v > 0 === land) g = v;
      }
      this.group[2 * i] = g;
      this.group[2 * i + 1] = 0;
    }
    // 对岸的颜色：变过的格与它们的邻格重新取（与 cellLayers 同一个规则，用将来的海岸值分陆海）
    const redo = new Set<number>();
    for (const list of [toLand, toSea, toLake]) {
      for (const i of list) {
        redo.add(i);
        for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) redo.add(mesh.adj[e]);
      }
    }
    for (const i of redo) fillOther(mesh, smooth, coast, this.other, i);
    for (const i of redo) this.touch(i);
  }
}

// 一格对岸的颜色：陆地格取相邻水面格的平均色，水面格取相邻陆地格的平均色（含 alpha）；没有对岸就是自己的
function fillOther(mesh: World['mesh'], smooth: Uint8Array, coast: Float32Array, out: Uint8Array, i: number) {
  const wet = coast[i] <= 0;
  let k = 0;
  const sum = [0, 0, 0, 0];
  for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
    const j = mesh.adj[e];
    if (coast[j] <= 0 === wet) continue;
    for (let c = 0; c < 4; c++) sum[c] += smooth[j * 4 + c];
    k++;
  }
  for (let c = 0; c < 4; c++) out[i * 4 + c] = k ? Math.round(sum[c] / k) : smooth[i * 4 + c];
}

// 一次性的幽灵图层（测试、不必持久时用）
export function ghostLayers(world: World, base: CellLayers, patch: GhostPatch, mode: ViewMode, coastAmp?: number): GhostLayers {
  return new GhostBuffer(base, mode).apply(world, patch, coastAmp);
}
