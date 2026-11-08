import { blendRgb, cellFx, fxPalette, fxSet } from '../../core/biome-look';
import { hexToRgb } from '../../core/export';
import { gradient } from '../../core/mesh';
import { seamLayers } from '../../core/seams';
import type { LakeType } from '../../core/lake-types';
import { type MapStyle, typeColor } from '../../core/map-style';
import type { Visual } from '../../core/species';
import { displayCoast, lakeDepth } from '../../core/display';
import { COAST_AMP } from '../../core/terrain';
import { ISLAND_CODE_MASK, allIslandTypes, islandTint } from '../../core/island-types';
import { type World } from '../../core/world';
import type { ViewMode } from '../state';
import type { CellLayers } from './renderer';
import { SEA_ICE, seaIceAt } from '../../core/sea-ice';
import { type RGB, ramp, SEA, HYPSO, tempRgb, SEA_TEMP_LAND, SEA_TEMP_LAKE, TEMP, PRECIP, MOIST, DIVERGE, HABIT, DENSITY, densityLevel, UNIT, type ColorOptions, isLake, warmth, snowAmount, humanMode, terrainLikeMode, ISLAND_TINT, fragColors } from './color-ramps';
import { humanFlat, countryBorderGroups, lithLayer, landCellLayer, provinceFlat, provinceGroups } from './colors-human';
import { fillOther } from './ghost-buffer';
export { tempRgb, SEA_TEMP_LAND, SEA_TEMP_LAKE, densityLevel, habitRgb, densityRgb, terrainLikeMode, fragColors } from './color-ramps';
export type { ColorOptions, HumanFlatMode } from './color-ramps';
export { NO_RESOURCE, COUNTRY_ALPHA, SEA_CLAIM_ALPHA, ISLET_FLAT, NO_BLOC, humanFlat, FEDERATION_GROUP, countryBorderGroups, lithLayer, landCellLayer, colorSignature, provinceFlat, provinceGroups, groupPreview, highlightColors, provinceScale } from './colors-human';
export type { HighlightLayer } from './colors-human';
export { editGhost, terrainGhost, GhostBuffer, ghostLayers } from './ghost-buffer';
export type { GhostEdit, GhostPatch, GhostLayers } from './ghost-buffer';

// 每种视图模式下每格的颜色：平滑层（在三角形内插值）与分类层（按扭曲后的格平涂），以及渲染需要的其他逐格数据

// 与视图模式无关、只取决于世界的逐格数据，按世界缓存。
// 湖在画面上是水面：海岸值取负（有岸线、有格以下的岸线细节）、高程取负的水深（浅水边）、坡度为 0
// 按用到的数组缓存：高程、湖、水面、陆海、陆地程度（只改了名字、省份的轻快照沿用同一批数组）。
// 预览世界只换变了的数组：整体干湿的预览高程不变、湖变了，不能只看高程，否则会画出旧的湖
type StaticLayers = { coast: Float32Array; frag: Float32Array | null; style: Float32Array | null; fjord: Float32Array | null; grad: Float32Array; seaGrad: Float32Array; elevation: Float32Array; shore: Float32Array };
const staticCache = new WeakMap<Float32Array, { inputs: unknown[]; value: StaticLayers }[]>();

// 每种生态的颜色（RGB，按世界里的先后）：底图的生态色、生态平涂共用
const speciesRgbOf = (small: World['small']): RGB[] => small.species.map((s) => hexToRgb(s.color));

function staticLayers(world: World): StaticLayers {
  const inputs: unknown[] = [world.derived.lake, world.derived.water, world.causes.land, world.causes.landness, world.causes.fragment, world.small.terrain.gen?.rerolls];
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
  const { coast, elevation, frag, style, fjord } = displayCoast(world);
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
  // 海底的坡度（海的晕渲）：按海底高程，陆地（含湖）当作 0 m
  const seaGrad = new Float32Array(mesh.n * 2);
  const hs = new Float64Array(mesh.n);
  for (let i = 0; i < mesh.n; i++) hs[i] = causes.land[i] ? 0 : Math.min(0, d.elevation[i]);
  for (let i = 0; i < mesh.n; i++) {
    if (causes.land[i]) continue;
    const [gx, gy] = gradient(mesh, hs, i);
    seaGrad[2 * i] = gx;
    seaGrad[2 * i + 1] = gy;
  }
  return { coast, frag, style, fjord: fjord ? fjord.tex : null, grad, seaGrad, elevation, shore: shoreElevation(world.mesh, coast, elevation) };
}

// 水面的高程（第十三轮修，地形层画水深、浅水用）：水面格（海岸值 ≤ 0，含湖）是自己的高程；
// 陆地格是挨着它的水面格里最浅的那格的高程（至多 −2 m），不挨水面的陆地格 −2 m。
// 画在陆地格三角形里的水（格以下的海岸细节戳出来的水、陡岛四周）按它插值，水深只来自水面格，不会被陆地的高程抬成一片浅水
export function shoreElevation(mesh: World['mesh'], coast: Float32Array, elevation: Float32Array): Float32Array {
  const out = new Float32Array(mesh.n);
  for (let i = 0; i < mesh.n; i++) {
    if (coast[i] <= 0) {
      out[i] = elevation[i];
      continue;
    }
    let best = -Infinity;
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      if (coast[j] <= 0) best = Math.max(best, elevation[j]);
    }
    out[i] = Number.isFinite(best) ? Math.min(-2, best) : -2;
  }
  return out;
}

// ---------- 底子与每种模式的一层（第三十九轮） ----------
// 以前每次换模式都整份重算 cellLayers、整份重新上传、地形层整张重画。拆成两部分：
//   底子（baseLayers）：地形层读的平滑层、对岸的颜色、岩性、静态层（高程、海岸值、坡度、峡湾……），与晕渲、露岩的强弱。
//     地形类与人文的模式（地貌、主导生态、省份、地形类别、资源、文化、文化组、每一维、国家、同盟）共用一份，
//     只看季节（积雪）；别的数据底图各一份（季节只进用得上它的几种：气温、降水、海水温度；关注的物种只进“适宜程度”）。
//   每种模式的一层（modeLayers）：合成着色器读的平涂、省份的分组与切线、国界的分组、花纹与发光、landCell
//   （离边界远的格由渲染器在空闲时按这一层算，见 near.ts）。
// MapView 按 baseKey、modeKey 各缓存几份；渲染器按对象是不是同一个来上传，底子没变时不重画地形层
export type BaseLayers = Pick<CellLayers, 'smooth' | 'other' | 'elevation' | 'shore' | 'coast' | 'frag' | 'style' | 'fjord' | 'grad' | 'seaGrad' | 'shade' | 'rock' | 'seaData' | 'coastAmp' | 'lith'>;
export type ModeLayers = Pick<CellLayers, 'flat' | 'group' | 'seams' | 'countryGroup' | 'fx' | 'fxPalette' | 'landCell'>;

// 平滑层的颜色按季节变的几种数据底图
const SEASONAL_DATA = new Set<ViewMode>(['temperature', 'precip', 'seaTemp']);

// 底子的键：同一个键的模式（同一个世界里）底子逐值相同
export function baseKey(o: Pick<ColorOptions, 'mode' | 'season' | 'focusSpecies'>): string {
  if (terrainLikeMode(o.mode)) return `terrain|${o.season}`;
  if (SEASONAL_DATA.has(o.mode)) return `${o.mode}|${o.season}`;
  if (o.mode === 'suitability') return `suitability|${o.focusSpecies ?? ''}`;
  return o.mode;
}

// 每种模式的一层的键：平涂（按模式）、花纹（地形、主导生态、省份按季节）、省界（开没开）、国界（开没开，国家模式另带集团）
export function modeKey(o: ColorOptions): string {
  const flat = o.mode === 'dominant' || o.mode === 'provinces' || humanMode(o.mode) ? o.mode : '';
  const fx = terrainLikeMode(o.mode) && !humanMode(o.mode) ? o.season : '';
  const groups = o.borders || o.mode === 'provinces' ? 'g' : '';
  const country = o.countryBorders ? (o.mode === 'country' ? 'cb' : 'c') : '';
  return `${flat}|${fx}|${groups}|${country}`;
}

export function cellLayers(world: World, o: ColorOptions): CellLayers {
  return { ...baseLayers(world, o), ...modeLayers(world, o) };
}

export function baseLayers(world: World, o: Pick<ColorOptions, 'mode' | 'season' | 'focusSpecies'>): BaseLayers {
  const { mesh, causes, derived: d, small } = world;
  const n = mesh.n;
  const smooth = new Uint8Array(n * 4);
  let shade = 1;
  let rock = 0;
  const S = small.species.length;
  const speciesRgb = speciesRgbOf(small);
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
  // 岛的种类自己选的颜色（第十四轮）：按编号查（没有自己选颜色的种类为 null）
  const tints = allIslandTypes(small).map((t) => islandTint(t));
  const anyTint = tints.some((t) => t !== null);

  const seaTemp = o.mode === 'seaTemp';
  if (seaTemp) shade = 0.4;
  for (let i = 0; i < n; i++) {
    const land = causes.land[i] === 1;
    if (!land) {
      // alpha：海水暖度，决定浅水的颜色。海水温度底图：海面按海水的冷暖（整个星球上已含洋流），与“气温”同一条色带
      let c: RGB = seaTemp ? tempRgb(seasonal(d.tMean, d.tS, d.tW, i)) : terrainLike || o.mode === 'elevation' || o.mode === 'uplift' ? ramp(SEA, d.elevation[i]) : [40, 50, 70];
      // 海冰（第八十六轮，core/sea-ice.ts）：地貌一类的底图上，冷海按季节盖一层浅色（着色器里浅水的颜色不再盖过它）
      if (terrainLike) {
        const k = seaIceAt(d, i, o.season) * SEA_ICE.ALPHA;
        if (k > 0) c = [c[0] + (SEA_ICE.RGB[0] - c[0]) * k, c[1] + (SEA_ICE.RGB[1] - c[1]) * k, c[2] + (SEA_ICE.RGB[2] - c[2]) * k];
      }
      put(smooth, i, c, warmth(world, i));
      continue;
    }
    // 海水温度底图：陆地、湖面都是灰的（只看海）
    if (seaTemp) {
      put(smooth, i, d.lake[i] === 1 ? SEA_TEMP_LAKE : SEA_TEMP_LAND, 255);
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
    if (terrainLike) {
      // 地貌、主导生态、省份与人文的底图（地形类别、资源、文化、文化组、每一维、国家、同盟）：
      // 植被按份额混色（有颜色脚本时用它算好的 d.look），积雪按季节覆盖。第三十九轮：每一维也走这里（以前少了岛的颜色、干湖、雪）
      c = d.look && d.look[i * 4 + 3] ? [d.look[i * 4], d.look[i * 4 + 1], d.look[i * 4 + 2]] : blendRgb(d.share, i, speciesRgb);
      // 放的岛的种类选了颜色：岛上的地画成这个颜色（植被的颜色留一点；积雪照样盖上）
      const code = causes.islandType[i] & ISLAND_CODE_MASK;
      const tint = anyTint && code ? tints[code - 1] : null;
      if (tint) c = [c[0] + (tint[0] - c[0]) * ISLAND_TINT, c[1] + (tint[1] - c[1]) * ISLAND_TINT, c[2] + (tint[2] - c[2]) * ISLAND_TINT];
      if (d.lake[i] === 2) c = playaColor;
      const k = snowAmount(world, o.season, i);
      if (k > 0) c = [c[0] + (245 - c[0]) * k, c[1] + (248 - c[1]) * k, c[2] + (250 - c[2]) * k];
    } else {
      switch (o.mode) {
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
        case 'habitability':
          c = ramp(HABIT, d.habitability?.[i] ?? 0);
          shade = 0.4;
          break;
        case 'popDensity':
          c = ramp(DENSITY, densityLevel(d.popDensity?.[i] ?? 0));
          shade = 0.4;
          break;
        default: {
          if (o.mode.startsWith('field:')) {
            const name = o.mode.slice(6);
            const v = (causes.fields[name]?.[i] ?? 0) + (d.corrF[name]?.[i] ?? 0);
            c = ramp(UNIT, v);
            shade = 0.4;
          } else c = [128, 128, 128];
        }
      }
    }
    put(smooth, i, c, sandy);
  }

  const st = staticLayers(world);
  // 对岸的颜色（fillOther）：着色器里陆地像素只用陆色、水面像素只用水色，海岸两边的颜色不再互相渗
  const other = new Uint8Array(n * 4);
  // 破碎的格（第十八轮）：没有对岸时，碎岛、裂缝画成什么颜色（见 fragColors）
  const alt = st.frag ? { frag: st.frag, rgba: fragColors(world, o.mode, o.season, smooth, st.coast, st.frag) } : null;
  for (let i = 0; i < n; i++) fillOther(mesh, smooth, st.coast, other, i, alt);
  return {
    lith: terrainLike ? lithLayer(world) : null,
    smooth,
    other,
    elevation: st.elevation,
    shore: st.shore,
    coast: st.coast,
    frag: st.frag,
    style: st.style,
    fjord: st.fjord,
    grad: st.grad,
    seaGrad: st.seaGrad,
    shade,
    rock,
    seaData: seaTemp,
    coastAmp: COAST_AMP * small.terrain.coastRoughness,
  };
}

export function modeLayers(world: World, o: ColorOptions): ModeLayers {
  const { causes, small } = world;
  let flat: Uint8Array | null = null;
  if (o.mode === 'dominant') {
    const { derived: d, mesh } = world;
    const n = mesh.n;
    const speciesRgb = speciesRgbOf(small);
    flat = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const s = d.dominant[i];
      if (s < 0) continue;
      const c = speciesRgb[s];
      flat[i * 4] = c[0];
      flat[i * 4 + 1] = c[1];
      flat[i * 4 + 2] = c[2];
      flat[i * 4 + 3] = d.overridden[i] ? 255 : 220;
    }
  } else if (o.mode === 'provinces') flat = provinceFlat(world, causes.province);
  else if (humanMode(o.mode)) flat = humanFlat(world, o.mode);

  // 省界：剪刀切过的地方按切线画（切线附近按在线的哪一边分省，见 core/seams.ts）
  const seams = o.borders || o.mode === 'provinces' ? seamLayers(world, causes.province, small.provinceSeams) : null;
  const group = o.borders || o.mode === 'provinces' ? provinceGroups(world, causes.province, seams) : null;
  const countryGroup = o.countryBorders ? countryBorderGroups(world, o.mode === 'country') : null;
  const landCell = group ? landCellLayer(world) : null;
  const fx = fxLayers(world, o);
  return {
    landCell,
    flat,
    group,
    seams,
    countryGroup,
    fx: fx?.fx ?? null,
    fxPalette: fx?.palette ?? null,
  };
}

// ---------- 生态的花纹与发光（第三批） ----------
// 每格一个 RGBA 字节：R = 份额最大的有花纹的生态在调色板里的行 + 1（0 没有花纹），G = 它的份额 × 255
// （被雪、盐壳盖住的部分不算），B = Σ 份额 × 发光强度 × 255，A = 发光颜色取的那一行 + 1（0 不发光）。
// 调色板见 core/biome-look.ts 的 fxPalette。只在地形类的着色（地形、主导生态、省份）里画；
// 没有一种生态有花纹或发光时为 null（着色器整段跳过，画面与以前逐像素相同）。
// overrides：拖花纹、发光滑块时按 id 换上的外观（主线程上立即画，不必等引擎）
export function fxLayers(world: World, o: Pick<ColorOptions, 'mode' | 'season'>, overrides?: ReadonlyMap<string, Visual>): { fx: Uint8Array; palette: Float32Array } | null {
  if (!terrainLikeMode(o.mode) || humanMode(o.mode)) return null;
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
// 每格一个 RGBA 字节：RGB 是这种湖的颜色（画风选了另一种颜色时用 atlasColor），A 的低两位是水面的画法（1 染色、2 像干湖底那样的盐壳），
// 再两位是陆上的（1 湖岸的光晕、2 干涸湖底的盐壳），16 是发光（湖面亮一些）。湖岸那一圈陆地格也带上水面的画法：
// 湖岸线在格以下（不是格的边），落在岸边那格里的水面像素也要染上。
// 只在地形类的着色里画；世界里没有湖泊类型（或者一个带类型的湖都没有）时为 null（着色器整段跳过，画面与以前逐像素相同）
export const LAKE_WATER_TINT = 1;
export const LAKE_WATER_CRUST = 2;
export const LAKE_LAND_GLOW = 4;
const LAKE_LAND_CRUST = 8;
export const LAKE_GLOW = 16;

// 一种湖画出来的颜色（画风选了另一种颜色时用 atlasColor，第三十八轮）
export function lakeTypeColor(t: Pick<LakeType, 'color' | 'atlasColor'>, style: Pick<MapStyle, 'typeColors'>): string {
  return typeColor(t, style);
}

// 湖泊类型里影响画法的几项（没有时为 ''）
export function lakeTypesSignature(types: readonly LakeType[] | undefined): string {
  return types?.length ? JSON.stringify(types.map((t) => [t.id, t.color, t.atlasColor ?? '', t.style ?? 'solid'])) : '';
}

export function lakeTintLayer(world: World, o: Pick<ColorOptions, 'mode'>, style: Pick<MapStyle, 'typeColors'>): Uint8Array | null {
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

// 测试用（src/render/layers-cache.test.ts 里留着的第三十八轮的 cellLayers 要用）：几张色带与内部的几个函数
export const COLORS_INTERNALS = { humanMode, ramp, SEA, HYPSO, TEMP, PRECIP, MOIST, DIVERGE, HABIT, DENSITY, UNIT, warmth, snowAmount, staticLayers, fillOther, ISLAND_TINT };
