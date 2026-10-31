import { clamp, smoothstep } from './rng';

// 大格局（第三十二轮）：板块的栅格与基准面 T、洼地 pit 的逐格式子。地区（generate.ts）与整个星球（planet-gen.ts）共用。
//
// 板块的栅格：把板块空间（扭曲后的板块坐标）铺成栅格，标出交界、汇聚强度、哪边在上，从汇聚交界做距离变换。
// 每格按自己的板块坐标查：离汇聚交界多远（dConv）、在上盘还是下盘、汇聚多强、是不是碰撞带。
// 以前按“这一对板块的平分线”算的距离（bd）离交界远了就不对（第二近的板块会突变，造出假的陡崖），
// 所以远处的格局（大陆倾斜、高原、前陆凹槽）都按栅格；离交界很近的（裂谷、裂谷肩）照旧按 bd。
// 栅格只取决于种子与类型（与格数无关），按键缓存，缩略图与成品共用一份。
//
// 基准面 T（米，以默认的“最高的山”为准；求解时换成原始单位，见 elevation.ts 的 solveLand）：
//   T_base 低起伏的隆起与盆地、T_swell 带陡崖的穹隆、T_tilt 大陆倾斜（汇聚边高）、T_plat 上盘的高原（分段）、
//   前陆凹槽（下盘、高原外侧）、T_esc 被动边缘的大陡崖、T_shoulder 裂谷肩。只在陆壳上（乘 contW），洋壳上是 0，
//   所以在海上画出来的陆地不带这些。高原另存（Tp），“山多高”只缩放它。
// 洼地 pit（米）：裂谷里分段的长洼地、内陆的凹陷；求解时按上游来沙挖（见 elevation.ts）。

export interface TectonicRaster {
  W: number;
  H: number;
  wrapX: boolean;
  // 离最近的汇聚交界的距离（板块坐标的单位）
  dist: Float32Array;
  // 抹平过的：在那条交界的上盘（1）/ 下盘（1）、交界的汇聚强度、是不是碰撞带（两边都是陆壳）
  up: Float32Array;
  low: Float32Array;
  conv: Float32Array;
  coll: Float32Array;
}

// 交界一格的属性：汇聚强度（负为离散）、上盘与下盘的板块、碰撞带
export interface BoundaryInfo {
  conv: number;
  upper: number;
  lower: number;
  coll: boolean;
  // 至少一边是陆壳（大陆边缘或碰撞带）：只有这样的交界让大陆倾斜。大洋里的俯冲带（岛弧）不算
  cont: boolean;
}

// pos：每个像素中心在板块空间的位置（dim 维，按行），plate：每个像素最近的板块。
// pair(k, a, b)：像素 k（属于板块 a）与邻像素的板块 b 之间的交界
export function buildTectonics(W: number, H: number, wrapX: boolean, dim: 2 | 3, pos: Float64Array, plate: Uint8Array, pair: (k: number, a: number, b: number) => BoundaryInfo): TectonicRaster {
  const N = W * H;
  const dist = new Float32Array(N).fill(Infinity);
  const src = new Int32Array(N).fill(-1);
  const info: BoundaryInfo[] = [];
  const srcInfo = new Int32Array(N).fill(-1);
  // 交界：右邻、下邻的板块不同的一对像素，两格都是源
  const mark = (k: number, j: number) => {
    const a = plate[k];
    const b = plate[j];
    const bi = pair(k, a, b);
    if (bi.conv <= 0.05 || !bi.cont) return;
    for (const p of [k, j]) {
      if (srcInfo[p] >= 0) continue;
      srcInfo[p] = info.length;
      info.push(bi);
      dist[p] = 0;
      src[p] = p;
    }
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = y * W + x;
      const xr = x + 1 < W ? x + 1 : wrapX ? 0 : -1;
      if (xr >= 0 && plate[y * W + xr] !== plate[k]) mark(k, y * W + xr);
      if (y + 1 < H && plate[k + W] !== plate[k]) mark(k, k + W);
    }
  }
  // 距离变换：两遍的倒角（8 邻，每行的步长按像素的位置算：星球上越往两极东西越窄），东西相接时再来一遍。
  // 误差几个百分点，之后还要抹平，够用；比 Dijkstra 快一个数量级
  const pd = (a: number, b: number) => {
    let q = 0;
    for (let c = 0; c < dim; c++) q += (pos[a * dim + c] - pos[b * dim + c]) ** 2;
    return Math.sqrt(q);
  };
  const wH = new Float64Array(H);
  const wV = new Float64Array(H);
  const wD = new Float64Array(H);
  for (let y = 0; y < H; y++) {
    wH[y] = pd(y * W, y * W + 1);
    if (y > 0) {
      wV[y] = pd((y - 1) * W, y * W);
      wD[y] = pd((y - 1) * W, y * W + 1);
    }
  }
  const D = new Float64Array(N).fill(Infinity);
  for (let k = 0; k < N; k++) if (src[k] >= 0) D[k] = 0;
  const relax = (k: number, j: number, w: number) => {
    const nd = D[j] + w;
    if (nd < D[k]) {
      D[k] = nd;
      src[k] = src[j];
    }
  };
  const xm = (x: number) => (x > 0 ? x - 1 : wrapX ? W - 1 : -1);
  const xp = (x: number) => (x + 1 < W ? x + 1 : wrapX ? 0 : -1);
  for (let round = 0; round < (wrapX ? 2 : 1); round++) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const k = y * W + x;
        const l = xm(x);
        const r = xp(x);
        if (l >= 0) relax(k, y * W + l, wH[y]);
        if (y > 0) {
          relax(k, k - W, wV[y]);
          if (l >= 0) relax(k, (y - 1) * W + l, wD[y]);
          if (r >= 0) relax(k, (y - 1) * W + r, wD[y]);
        }
      }
    }
    for (let y = H - 1; y >= 0; y--) {
      for (let x = W - 1; x >= 0; x--) {
        const k = y * W + x;
        const l = xm(x);
        const r = xp(x);
        if (r >= 0) relax(k, y * W + r, wH[y]);
        if (y + 1 < H) {
          relax(k, k + W, wV[y + 1]);
          if (l >= 0) relax(k, (y + 1) * W + l, wD[y + 1]);
          if (r >= 0) relax(k, (y + 1) * W + r, wD[y + 1]);
        }
      }
    }
  }
  for (let k = 0; k < N; k++) dist[k] = D[k];
  const up = new Float32Array(N);
  const low = new Float32Array(N);
  const conv = new Float32Array(N);
  const coll = new Float32Array(N);
  for (let k = 0; k < N; k++) {
    if (src[k] < 0) {
      dist[k] = 10;
      continue;
    }
    const bi = info[srcInfo[src[k]]];
    up[k] = plate[k] === bi.upper ? 1 : 0;
    low[k] = plate[k] === bi.lower ? 1 : 0;
    conv[k] = Math.min(1.3, bi.conv);
    coll[k] = bi.coll ? 1 : 0;
  }
  // 抹平：最近的交界换了一条时属性不突变（不会造出假的陡崖）
  for (const f of [up, low, conv, coll]) blur(f, W, H, wrapX, 3);
  return { W, H, wrapX, dist, up, low, conv, coll };
}

// 3×3 的盒式平均，passes 遍（先横后竖，可分离；边上按有的格平均）
function blur(f: Float32Array, W: number, H: number, wrapX: boolean, passes: number) {
  const tmp = new Float32Array(f.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < H; y++) {
      const o = y * W;
      for (let x = 0; x < W; x++) {
        let q = f[o + x];
        let c = 1;
        if (x > 0) {
          q += f[o + x - 1];
          c++;
        } else if (wrapX) {
          q += f[o + W - 1];
          c++;
        }
        if (x + 1 < W) {
          q += f[o + x + 1];
          c++;
        } else if (wrapX) {
          q += f[o];
          c++;
        }
        tmp[o + x] = q / c;
      }
    }
    for (let y = 0; y < H; y++) {
      const o = y * W;
      for (let x = 0; x < W; x++) {
        let q = tmp[o + x];
        let c = 1;
        if (y > 0) {
          q += tmp[o - W + x];
          c++;
        }
        if (y + 1 < H) {
          q += tmp[o + W + x];
          c++;
        }
        f[o + x] = q / c;
      }
    }
  }
}

// 栅格在像素坐标 (fx, fy)（像素中心为整数）处的双线性插值
export interface TectonicSample {
  dist: number;
  up: number;
  low: number;
  conv: number;
  coll: number;
}
export function sampleTectonics(r: TectonicRaster, fx: number, fy: number, out: TectonicSample) {
  const { W, H } = r;
  fy = clamp(fy, 0, H - 1);
  if (!r.wrapX) fx = clamp(fx, 0, W - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.min(H - 2, Math.floor(fy));
  const tx = fx - x0;
  const ty = fy - y0;
  const xa = r.wrapX ? ((x0 % W) + W) % W : Math.min(W - 1, x0);
  const xb = r.wrapX ? (xa + 1) % W : Math.min(W - 1, x0 + 1);
  const k00 = y0 * W + xa;
  const k10 = y0 * W + xb;
  const k01 = (y0 + 1) * W + xa;
  const k11 = (y0 + 1) * W + xb;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;
  const at = (f: Float32Array) => f[k00] * w00 + f[k10] * w10 + f[k01] * w01 + f[k11] * w11;
  out.dist = at(r.dist);
  out.up = at(r.up);
  out.low = at(r.low);
  out.conv = at(r.conv);
  out.coll = at(r.coll);
}

// 按键缓存几份栅格（同一个种子、类型的缩略图与成品共用）
const rasterCache = new Map<string, TectonicRaster>();
export function cachedTectonics(key: string, build: () => TectonicRaster): TectonicRaster {
  let r = rasterCache.get(key);
  if (r) {
    rasterCache.delete(key);
    rasterCache.set(key, r);
    return r;
  }
  r = build();
  rasterCache.set(key, r);
  if (rasterCache.size > 4) rasterCache.delete(rasterCache.keys().next().value!);
  return r;
}

// 穹隆（带陡崖的隆起）：中心、半径（地图单位）、高（m）
export interface Swell {
  r: number;
  h: number;
}

// 一格的大格局：调用方先算好噪声与栅格，这里只是式子
export interface ReliefInput {
  // 大陆场（含噪声）与陆壳程度
  c: number;
  contW: number;
  // 栅格查到的
  t: TectonicSample;
  // 山带宽窄（与造山带同一个 widthMod）
  widthMod: number;
  // 低频噪声（约 −0.7 到 0.7）：盆地与隆起、高原分段与宽窄、陡崖分段、洼地
  nBase: number;
  nPlat: number;
  nPlatW: number;
  nEsc: number;
  nSag: number;
  nRift: number;
  // 穹隆：到中心的距离 / 半径（最近的一个）与它的高
  swellR: number;
  swellH: number;
  // 离散交界（按 bd）：裂谷轴、裂谷肩
  riftAxis: number;
  shoulder: number;
  // 算不算板块（星球形态的 crustMode 'replace' 时为 false：板块来的几项都是 0）
  plates: boolean;
  // 第三十五轮：裂开的海岸往里一带（0–0.5）：被动边缘的大陡崖的分段、“离活动边缘多远”至少这么多（见 outline.ts 的 escNear）
  esc: number;
}

export interface ReliefOut {
  // 基准面（不含高原）、高原（“山多高”= 1 时）、洼地（m）
  T: number;
  Tp: number;
  pit: number;
  // 洼地里裂谷的那一部分
  rift: number;
  // 岩性的倍数（地盾硬、盆地软）
  erodMul: number;
}

// 各项的强弱（米、地图单位）。按 tools/realism-report.ts 的 6 个种子 × {区域、星球} 校准（见开发说明“大格局与长河”）
// 低起伏的隆起与盆地
const BASE_H = 420;
// 大陆倾斜：汇聚边的高度、随离汇聚交界的距离衰减的长度
const TILT_H = 800;
const TILT_L = 0.2;
// 倾斜、穹隆、隆起从海岸往内陆抬起：大陆场 0.02 → RAMP_C
const RAMP_C = 0.6;
// 上盘的高原：高、分段的门槛（越低高原越多）、离交界多远开始变低
const PLAT_H = 3400;
const PLAT_SEG = -0.12;
const PLAT_EDGE = 0.07;
// 前陆凹槽的深
const TROUGH_H = 550;
// 被动边缘的大陡崖、裂谷肩的高
const ESC_H = 650;
const SHOULDER_H = 750;
// 内陆凹陷：深、噪声的门槛（越高越少）
const SAG_D = 650;
const SAG_T = 0.18;
// 裂谷的洼地：深；沿裂谷分段的噪声门槛与过渡（过渡窄：一段里深浅一样，湖能沿着整段铺开）
const RIFT_D = 1000;
const RIFT_SEG = -0.1;
const RIFT_SEG_W = 0.06;
// 裂谷轴洼地的半宽（地图单位，按 bd）：窄，湖细长
export const RIFT_W = 0.006;

export function reliefAt(p: ReliefInput, o: ReliefOut) {
  const { c, contW, t } = p;
  if (contW <= 0) {
    o.T = 0;
    o.Tp = 0;
    o.pit = 0;
    o.rift = 0;
    o.erodMul = 1;
    return;
  }
  const dC = p.plates ? t.dist : 10;
  // 内陆程度、离活动边缘多远（被动）
  const inner = smoothstep(0.1, 0.4, c);
  const passive = Math.max(smoothstep(0.18, 0.45, dC), p.esc);
  // 低起伏的隆起与盆地
  const Tbase = BASE_H * p.nBase;
  // 带陡崖的穹隆：顶上平、边上陡
  const Tswell = p.swellH * (1 - smoothstep(0.72, 1, p.swellR));
  // 大陆倾斜：汇聚边高、被动边低
  const Ttilt = p.plates ? TILT_H * Math.exp(-dC / TILT_L) : 0;
  let Tp = 0;
  let trough = 0;
  if (p.plates && dC < 0.4) {
    const cv = Math.min(1, t.conv / 0.6);
    // 上盘的高原：从山带里面起，平顶，外缘一道陡崖；分段（只有一部分交界有高原）
    const seg = smoothstep(PLAT_SEG, PLAT_SEG + 0.25, p.nPlat);
    const edge = PLAT_EDGE + 0.1 * (0.5 + 0.5 * p.nPlatW);
    const prof = smoothstep(0.012, 0.04, dC) * (1 - smoothstep(edge, edge + 0.03, dC));
    Tp = PLAT_H * t.up * seg * cv * prof;
    // 前陆凹槽：下盘挨着山带的外侧、上盘高原（没有高原时山带）的外侧，大河顺着山脚走
    const beltW = 0.055 * p.widthMod;
    const lowC = 1.3 * beltW;
    const upC = seg > 0.5 ? edge + 0.035 : 1.6 * beltW;
    trough = -TROUGH_H * cv * (t.low * Math.exp(-(((dC - lowC) / 0.035) ** 2)) + t.up * Math.exp(-(((dC - upC) / 0.035) ** 2)));
  }
  // 被动边缘的大陡崖：离海岸不远的一道台阶（分段），台阶上是向内陆缓降的边缘隆起（内陆是盆地，河往内陆流）
  const Tesc = ESC_H * passive * smoothstep(0.07, 0.12, c) * (1 - 0.7 * smoothstep(0.12, 0.4, c)) * Math.max(smoothstep(-0.15, 0.2, p.nEsc), p.esc);
  // 裂谷肩
  const Tsh = p.plates ? SHOULDER_H * p.shoulder : 0;
  // 离海岸越近越低（海岸都是低的，只有活动边缘的山带高）：倾斜、穹隆、隆起从海岸往内陆渐渐抬起
  const ramp = smoothstep(0.02, RAMP_C, c);
  o.T = contW * (ramp * (Math.max(0, Tbase) + Tswell + Ttilt) + Math.min(0, Tbase) + Tesc + Tsh + trough);
  o.Tp = contW * Tp;
  // 洼地：裂谷里分段的长洼地；内陆被动的地方的凹陷
  const pitRift = p.plates ? RIFT_D * p.riftAxis * smoothstep(RIFT_SEG, RIFT_SEG + RIFT_SEG_W, p.nRift) : 0;
  const pitSag = SAG_D * inner * passive * smoothstep(SAG_T, SAG_T + 0.2, p.nSag);
  o.pit = contW * Math.max(pitRift, pitSag);
  o.rift = contW * pitRift;
  // 岩性：地盾（内陆、离活动边缘远、隆起）硬，盆地软
  const shield = inner * passive * smoothstep(0, 0.3, p.nBase);
  const basin = smoothstep(0, -0.3, p.nBase) * inner;
  o.erodMul = clamp(1 - 0.3 * shield + 0.5 * basin, 0.6, 1.6);
}
