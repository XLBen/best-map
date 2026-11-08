import { describe, expect, it } from 'vitest';
import { blendRgb } from '../../core/biome-look';
import { lakeDepth } from '../../core/display';
import type { Engine } from '../../core/engine';
import { hexToRgb } from '../../core/export';
import { worldDimensions } from '../../core/human';
import { ISLAND_CODE_MASK, allIslandTypes, islandTint } from '../../core/island-types';
import { seamLayers } from '../../core/seams';
import { COAST_AMP } from '../../core/terrain';
import { SEA_ICE, seaIceAt } from '../../core/sea-ice';
import { continents, humanExec, seededEngine, snapshot } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import type { ViewMode } from '../state';
import {
  COLORS_INTERNALS,
  type ColorOptions,
  SEA_TEMP_LAKE,
  SEA_TEMP_LAND,
  baseKey,
  baseLayers,
  cellLayers,
  countryBorderGroups,
  densityLevel,
  fragColors,
  fxLayers,
  humanFlat,
  landCellLayer,
  lithLayer,
  modeKey,
  modeLayers,
  provinceFlat,
  provinceGroups,
  tempRgb,
  terrainLikeMode,
} from './colors';
import type { CellLayers } from './renderer';

// 第三十九轮：cellLayers 拆成底子（baseLayers）与每种模式的一层（modeLayers）。下面留着第三十八轮（b4aeaae）的 cellLayers 原文，
// 拼起来的结果与它逐值相同（每一维除外：每一维的底子改成与文化相同，单独查）。底子按 baseKey、模式的那一层按 modeKey 缓存：
// 同一个键的两种选项算出来逐值相同

const { humanMode, ramp, SEA, HYPSO, TEMP, PRECIP, MOIST, DIVERGE, HABIT, DENSITY, UNIT, warmth, snowAmount, staticLayers, fillOther, ISLAND_TINT } = COLORS_INTERNALS;
type RGB = [number, number, number];

// ---------- 第三十八轮的原文（只把名字改成 oldCellLayers） ----------
function oldCellLayers(world: World, o: ColorOptions): CellLayers {
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
      // 例外（第八十六轮）：地貌一类的底图上冷海盖一层海冰（core/sea-ice.ts），照 colors.ts 的写法
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
    switch (o.mode) {
      case 'terrain':
      case 'dominant':
      case 'provinces':
      case 'terrainClass':
      case 'resource':
      case 'culture':
      case 'cultureGroup':
      case 'country':
      case 'bloc': {
        // 植被按份额混色（有颜色脚本时用它算好的 d.look），积雪按季节覆盖
        c = d.look && d.look[i * 4 + 3] ? [d.look[i * 4], d.look[i * 4 + 1], d.look[i * 4 + 2]] : blendRgb(d.share, i, speciesRgb);
        // 放的岛的种类选了颜色：岛上的地画成这个颜色（植被的颜色留一点；积雪照样盖上）
        const code = causes.islandType[i] & ISLAND_CODE_MASK;
        const tint = anyTint && code ? tints[code - 1] : null;
        if (tint) c = [c[0] + (tint[0] - c[0]) * ISLAND_TINT, c[1] + (tint[1] - c[1]) * ISLAND_TINT, c[2] + (tint[2] - c[2]) * ISLAND_TINT];
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
      case 'habitability':
        c = ramp(HABIT, d.habitability?.[i] ?? 0);
        shade = 0.4;
        break;
      case 'popDensity':
        c = ramp(DENSITY, densityLevel(d.popDensity?.[i] ?? 0));
        shade = 0.4;
        break;
      default: {
        if (o.mode.startsWith('dim:')) {
          // 时代的一维：底下是地貌（同文化圈）
          c = d.look && d.look[i * 4 + 3] ? [d.look[i * 4], d.look[i * 4 + 1], d.look[i * 4 + 2]] : blendRgb(d.share, i, speciesRgb);
        } else if (o.mode.startsWith('field:')) {
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
  else if (humanMode(o.mode)) flat = humanFlat(world, o.mode);

  // 省界：剪刀切过的地方按切线画（切线附近按在线的哪一边分省，见 core/seams.ts）
  const seams = o.borders || o.mode === 'provinces' ? seamLayers(world, causes.province, small.provinceSeams) : null;
  const group = o.borders || o.mode === 'provinces' ? provinceGroups(world, causes.province, seams) : null;
  const countryGroup = o.countryBorders ? countryBorderGroups(world, o.mode === 'country') : null;
  const st = staticLayers(world);
  // 对岸的颜色（fillOther）：着色器里陆地像素只用陆色、水面像素只用水色，海岸两边的颜色不再互相渗
  const other = new Uint8Array(n * 4);
  // 破碎的格（第十八轮）：没有对岸时，碎岛、裂缝画成什么颜色（见 fragColors）
  const alt = st.frag ? { frag: st.frag, rgba: fragColors(world, o.mode, o.season, smooth, st.coast, st.frag) } : null;
  for (let i = 0; i < n; i++) fillOther(mesh, smooth, st.coast, other, i, alt);
  const fx = fxLayers(world, o);
  return {
    lith: terrainLike ? lithLayer(world) : null,
    landCell: group ? landCellLayer(world) : null,
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
    flat,
    group,
    seams,
    countryGroup,
    shade,
    rock,
    seaData: seaTemp,
    coastAmp: COAST_AMP * small.terrain.coastRoughness,
    fx: fx?.fx ?? null,
    fxPalette: fx?.palette ?? null,
  };
}

// ---------- 对照 ----------

const GROUPS = [
  { id: 'germanic', weight: 3 },
  { id: 'chinese', weight: 3 },
  { id: 'altaic', weight: 1.5 },
];
const WORLDS: [string, () => World][] = [
  [
    '一块地区',
    () =>
      snapshot('r39-layers:region', () => {
        const e = continents({ provinces: true });
        humanExec(e, { op: 'generate_human', packs: [['medieval']], groups: GROUPS, countries: { seed: 3 } });
        return e;
      }).world,
  ],
  [
    '整个星球',
    () =>
      snapshot('r39-layers:planet', (): Engine => {
        const e = seededEngine({ cells: 3000, seed: 7, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
        e.exec({ op: 'set_worldgen', params: { seed: 7, type: 'continents' }, reset: true });
        e.exec({ op: 'generate_provinces', seed: 3 });
        humanExec(e, { op: 'generate_human', packs: [['medieval']], groups: GROUPS, countries: { seed: 3 } });
        return e;
      }).world,
  ],
];

const FIELDS: (keyof CellLayers)[] = ['smooth', 'other', 'elevation', 'shore', 'coast', 'frag', 'style', 'fjord', 'grad', 'seaGrad', 'flat', 'group', 'countryGroup', 'shade', 'rock', 'seaData', 'coastAmp', 'lith', 'landCell', 'fx', 'fxPalette'];
const same = (a: unknown, b: unknown): boolean => {
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    const x = a as unknown as ArrayLike<number>;
    const y = b as unknown as ArrayLike<number>;
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i])) return false;
    return true;
  }
  return (a ?? null) === (b ?? null);
};
function modesOf(w: World): ViewMode[] {
  const dims = worldDimensions(w.small).map((d) => `dim:${d.id}` as ViewMode);
  return ['terrain', 'dominant', 'elevation', 'temperature', 'seaTemp', 'precip', 'moisture', 'wetness', 'continentality', 'corrT', 'corrP', 'suitability', 'provinces', 'uplift', 'terrainClass', 'resource', 'habitability', 'popDensity', 'culture', 'cultureGroup', 'country', 'bloc', ...dims];
}

describe('第三十九轮：底子与每种模式的一层', () => {
  for (const [label, build] of WORLDS) {
    it(`${label}：拼起来与第三十八轮的 cellLayers 逐值相同（各模式、季节、关注的物种、省界与国界开关）；每一维的底子与文化的相同`, () => {
      const w = build();
      const species = w.small.species.map((s) => s.id);
      const bad: string[] = [];
      let checked = 0;
      for (const mode of modesOf(w)) {
        for (const season of ['annual', 'summer', 'winter'] as const) {
          for (const focusSpecies of [null, species[1] ?? null]) {
            for (const borders of [false, true]) {
              for (const countryBorders of [false, true]) {
                const o: ColorOptions = { mode, season, focusSpecies, borders, countryBorders };
                const a = oldCellLayers(w, o);
                const b = cellLayers(w, o);
                checked++;
                for (const f of FIELDS) {
                  if (mode.startsWith('dim:') && (f === 'smooth' || f === 'other')) continue;
                  if (!same(a[f], b[f])) bad.push(`${mode} ${season} ${focusSpecies} ${borders} ${countryBorders}: ${f}`);
                }
                // 拼的方式：底子 + 模式的那一层
                const base = baseLayers(w, o) as CellLayers;
                const ml = modeLayers(w, o) as CellLayers;
                for (const f of FIELDS) if (!same(b[f], f in base ? base[f] : ml[f])) bad.push(`${mode}: 拼的 ${f}`);
              }
            }
          }
        }
      }
      expect(bad.slice(0, 8)).toEqual([]);
      expect(checked).toBeGreaterThan(200);
    }, 300_000);

    it(`${label}：同一个 baseKey 的底子、同一个 modeKey 的那一层逐值相同；键里只有用得上的选项`, () => {
      const w = build();
      const species = w.small.species.map((s) => s.id);
      const seen = new Map<string, CellLayers>();
      const seenMode = new Map<string, CellLayers>();
      const bad: string[] = [];
      for (const mode of modesOf(w)) {
        for (const season of ['annual', 'winter'] as const) {
          for (const focusSpecies of [null, species[1] ?? null]) {
            for (const borders of [false, true]) {
              const o: ColorOptions = { mode, season, focusSpecies, borders, countryBorders: borders };
              const bk = baseKey(o);
              const base = baseLayers(w, o) as CellLayers;
              const hit = seen.get(bk);
              if (hit) for (const f of ['smooth', 'other', 'shade', 'rock', 'seaData', 'lith'] as const) if (!same(hit[f], base[f])) bad.push(`${bk} ${mode}: ${f}`);
              seen.set(bk, base);
              const mk = modeKey(o);
              const ml = modeLayers(w, o) as CellLayers;
              const mh = seenMode.get(mk);
              if (mh) for (const f of ['flat', 'group', 'countryGroup', 'landCell', 'fx'] as const) if (!same(mh[f], ml[f])) bad.push(`${mk} ${mode}: ${f}`);
              seenMode.set(mk, ml);
            }
          }
        }
      }
      expect(bad).toEqual([]);
      // 地形类与人文的模式共用一份底子（按季节），每一维与文化相同
      const dim = modesOf(w).find((m) => m.startsWith('dim:'))!;
      for (const m of ['terrain', 'dominant', 'provinces', 'terrainClass', 'resource', 'culture', 'cultureGroup', 'country', 'bloc', dim] as ViewMode[]) {
        expect(terrainLikeMode(m)).toBe(true);
        expect(baseKey({ mode: m, season: 'annual', focusSpecies: 'x' })).toBe('terrain|annual');
      }
      const o = (mode: ViewMode): ColorOptions => ({ mode, season: 'annual', focusSpecies: null, borders: true, countryBorders: true });
      const cu = baseLayers(w, o('culture'));
      const di = baseLayers(w, o(dim));
      expect(same(cu.smooth, di.smooth) && same(cu.other, di.other)).toBe(true);
      // 关注的物种只进“适宜程度”的键，季节只进气温、降水、海水温度与地形类的
      expect(baseKey({ mode: 'elevation', season: 'winter', focusSpecies: 'x' })).toBe('elevation');
      expect(baseKey({ mode: 'temperature', season: 'winter', focusSpecies: 'x' })).toBe('temperature|winter');
      expect(baseKey({ mode: 'suitability', season: 'winter', focusSpecies: 'x' })).toBe('suitability|x');
      expect(modeKey({ mode: 'culture', season: 'winter', focusSpecies: 'x', borders: true, countryBorders: true })).toBe(modeKey({ mode: 'culture', season: 'summer', focusSpecies: null, borders: true, countryBorders: true }));
      expect(modeKey({ mode: 'terrain', season: 'winter', focusSpecies: null, borders: false })).not.toBe(modeKey({ mode: 'terrain', season: 'summer', focusSpecies: null, borders: false }));
    }, 300_000);
  }
});
