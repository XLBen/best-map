// 色带与几样共用的小工具（第八十三轮从 src/render/colors.ts 原样搬出）：高度、海、温度、降水等色带，湖、冷暖、积雪，模式的种类，碎岛与裂缝的颜色
import type { ViewMode, Season } from '../state';
import type { World } from '../../core/world';

export type RGB = [number, number, number];

export function ramp(stops: [number, RGB][], v: number): RGB {
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

export const SEA: [number, RGB][] = [
  [-6500, [14, 26, 56]],
  [-4000, [22, 44, 86]],
  [-2000, [30, 62, 112]],
  [-400, [40, 84, 136]],
  [-120, [50, 100, 148]],
  [0, [62, 116, 156]],
];
export const HYPSO: [number, RGB][] = [
  [0, [96, 140, 88]],
  [300, [140, 168, 104]],
  [900, [200, 190, 130]],
  [1800, [176, 140, 98]],
  [3000, [150, 120, 104]],
  [4500, [210, 205, 205]],
  [6500, [250, 250, 250]],
];
// 气温、海水温度底图的颜色（°C）
export function tempRgb(v: number): RGB {
  return ramp(TEMP, v);
}

// 海水温度底图里的陆地、湖面（第十四轮）：不带颜色的灰
export const SEA_TEMP_LAND: RGB = [150, 150, 150];
export const SEA_TEMP_LAKE: RGB = [120, 120, 120];

export const TEMP: [number, RGB][] = [
  [-35, [60, 30, 120]],
  [-15, [70, 110, 210]],
  [0, [170, 215, 240]],
  [10, [240, 236, 170]],
  [20, [240, 160, 70]],
  [30, [200, 50, 40]],
  [40, [110, 10, 30]],
];
export const PRECIP: [number, RGB][] = [
  [0, [150, 100, 60]],
  [150, [210, 180, 110]],
  [400, [220, 220, 150]],
  [800, [130, 190, 110]],
  [1500, [50, 150, 120]],
  [2500, [40, 100, 170]],
  [4500, [60, 50, 150]],
];
export const MOIST: [number, RGB][] = [
  [0, [160, 100, 60]],
  [0.2, [220, 190, 120]],
  [0.5, [220, 220, 150]],
  [1, [120, 180, 100]],
  [2, [40, 130, 110]],
  [4, [40, 80, 160]],
];
export const DIVERGE: [number, RGB][] = [
  [-1, [40, 80, 200]],
  [0, [150, 150, 145]],
  [1, [200, 50, 40]],
];
// 宜居度（0–1，第二十二轮）：荒凉的褐灰 → 黄 → 绿
export const HABIT: [number, RGB][] = [
  [0, [90, 70, 60]],
  [0.15, [170, 120, 80]],
  [0.35, [220, 200, 110]],
  [0.6, [130, 190, 90]],
  [1, [40, 130, 70]],
];
// 人口密度（人 / km²，按对数取 log10(1 + 密度)，同导出的 population.png）：无人是暗的，越密越亮越红
export const DENSITY: [number, RGB][] = [
  [0, [40, 40, 52]],
  [0.5, [70, 90, 140]],
  [1, [90, 160, 160]],
  [1.5, [210, 200, 110]],
  [2, [235, 140, 60]],
  [3, [200, 40, 50]],
];
export const densityLevel = (d: number) => Math.log10(1 + Math.max(0, d));
// 图例用：宜居度、人口密度色带上一个值的颜色
export const habitRgb = (v: number): RGB => ramp(HABIT, v);
export const densityRgb = (d: number): RGB => ramp(DENSITY, densityLevel(d));

export const UNIT: [number, RGB][] = [
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
  // 国界（第二十三轮）：国家、文化等地图模式与“国家”一类的工具里画（浓淡在渲染器的 countryAlpha）；省略为不画
  countryBorders?: boolean;
}

export const isLake = (world: World, i: number) => world.causes.land[i] === 1 && world.derived.lake[i] === 1;
// 湖水深、湖面的海岸值：见 core/display.ts（河口按同一份海岸场找岸线）
// 水面的暖度（浅水颜色用，放在颜色的 alpha 里）
export const warmth = (world: World, i: number) => Math.round(255 * Math.min(1, Math.max(0, (world.derived.tMean[i] - 14) / 12)));
// 积雪盖住多少（0–1）：按季节取最暖那一季（全年看暖季）的气温，0 °C 以下越冷越白，−6 °C 全白
export function snowAmount(world: World, season: Season, i: number): number {
  const d = world.derived;
  const snowT = season === 'winter' ? Math.min(d.tS[i], d.tW[i]) : season === 'summer' ? Math.max(d.tS[i], d.tW[i]) : d.tWarm[i];
  return snowT < 0 ? Math.min(1, -snowT / 6) : 0;
}
// 地形类别、资源（第二十一轮）：底下是地貌（晕渲、露岩），上面按格平涂；不画生态的花纹（看得清数据）
// 第二十二轮：文化圈（按文化、按文化组）与时代的每一维也是这样（没有人的陆地不着色，看得到地貌）
// 第二十三轮：国家（附庸用宗主的浅色，领海淡淡地涂在海上）；第二十六轮：同盟（集团的颜色，不在集团里的国家灰色）
export type HumanFlatMode = 'terrainClass' | 'resource' | 'culture' | 'cultureGroup' | 'country' | 'bloc' | `dim:${string}`;
export const humanMode = (mode: ViewMode): mode is HumanFlatMode =>
  mode === 'terrainClass' || mode === 'resource' || mode === 'culture' || mode === 'cultureGroup' || mode === 'country' || mode === 'bloc' || mode.startsWith('dim:');
export const terrainLikeMode = (mode: ViewMode) => mode === 'terrain' || mode === 'dominant' || mode === 'provinces' || humanMode(mode);

// 放的岛自己选的颜色盖住植被颜色的多少
export const ISLAND_TINT = 0.8;

// ---------- 碎岛与裂缝的颜色（第十八轮） ----------
// 着色器里陆地像素用“陆色”、水面像素用“水色”，水面格的陆色是对岸（挨着的陆地格）的颜色。破碎的格里画出来的碎岛、裂缝
// 常常没有对岸（四周全是海的碎岛、陆地中间的裂缝），以前会画成自己的颜色（海里的陆地像素是海色）。这里给它们一个说得通的颜色：
//   · 水面格（碎岛）：往外 FRAG_RINGS 圈里最近的陆地格的颜色（附近的气候、生态）；附近没有陆地时按这一格的气候：
//     冷的是冻原，干热的是沙地，别的是草地，再按季节盖上雪（数据底图里用中性的灰）；
//   · 陆地格（裂缝）：往外最近的水面格的颜色；附近没有时是浅海的颜色。
// 只给破碎度 > 0 的格（别处与以前逐位相同）；alpha 与平滑层的一样（陆地是沙质：碎岛低，边上一圈沙滩）
const FRAG_RINGS = 6;
// 往外找的时候记“这一格这一次看过了”：每次找一个新的编号，数组按格数留一份（幽灵海岸每动一下都要找几格）
let fragMark = new Int32Array(0);
let fragStamp = 0;
export function fragColors(world: World, mode: ViewMode, season: Season, smooth: Uint8Array, coast: Float32Array, frag: Float32Array, only?: Iterable<number>): Uint8Array {
  const { mesh, derived: d } = world;
  const n = mesh.n;
  const out = new Uint8Array(n * 4);
  const terrainLike = terrainLikeMode(mode);
  const depthColors = terrainLike || mode === 'elevation' || mode === 'uplift';
  if (fragMark.length !== n) {
    fragMark = new Int32Array(n);
    fragStamp = 0;
  }
  const mark = fragMark;
  let ring: number[] = [];
  let next: number[] = [];
  const nearest = (i: number, wantLand: boolean): number => {
    if (++fragStamp > 0x7ffffff0) {
      mark.fill(0);
      fragStamp = 1;
    }
    const stamp = fragStamp;
    ring = [i];
    mark[i] = stamp;
    for (let r = 0; r < FRAG_RINGS; r++) {
      next = [];
      let best = -1;
      let bd = Infinity;
      for (const c of ring) {
        for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
          const j = mesh.adj[e];
          if (mark[j] === stamp) continue;
          mark[j] = stamp;
          next.push(j);
          const isLand = coast[j] > 0;
          if (isLand !== wantLand) continue;
          const dx = mesh.kind === 'sphere' ? mesh.x[j] - mesh.x[i] - 2 * Math.round((mesh.x[j] - mesh.x[i]) / 2) : mesh.x[j] - mesh.x[i];
          const dd = dx * dx + (mesh.y[j] - mesh.y[i]) ** 2;
          if (dd < bd || (dd === bd && j < best)) {
            bd = dd;
            best = j;
          }
        }
      }
      if (best >= 0) return best;
      ring = next;
    }
    return -1;
  };
  const put = (i: number, c: RGB, a: number) => {
    out[i * 4] = Math.round(c[0]);
    out[i * 4 + 1] = Math.round(c[1]);
    out[i * 4 + 2] = Math.round(c[2]);
    out[i * 4 + 3] = a;
  };
  const one = (i: number) => {
    if (!(frag[i] > 0)) return;
    const wet = coast[i] <= 0;
    const j = nearest(i, wet);
    if (j >= 0) {
      for (let c = 0; c < 4; c++) out[i * 4 + c] = smooth[j * 4 + c];
      return;
    }
    if (!wet) {
      put(i, depthColors ? ramp(SEA, -40) : [40, 50, 70], warmth(world, i));
      return;
    }
    if (mode === 'seaTemp') return put(i, SEA_TEMP_LAND, 255);
    if (mode === 'elevation') return put(i, ramp(HYPSO, 5), 200);
    if (!terrainLike) return put(i, [140, 140, 140], 200);
    // 按这一格的气候：冷的冻原、干热的沙地、别的草地；积雪按季节
    const t = d.tMean[i];
    const p = d.precip[i];
    let c: RGB = t < -2 ? [150, 156, 138] : p < 250 && t > 12 ? [214, 196, 150] : t < 6 ? [118, 138, 102] : [104, 142, 84];
    const k = snowAmount(world, season, i);
    if (k > 0) c = [c[0] + (245 - c[0]) * k, c[1] + (248 - c[1]) * k, c[2] + (250 - c[2]) * k];
    put(i, c, 200);
  };
  if (only) for (const i of only) one(i);
  else for (let i = 0; i < n; i++) one(i);
  return out;
}
