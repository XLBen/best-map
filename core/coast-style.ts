import type { BaseComponents } from './generate';
import { creationLat, glacialField, glacialKey } from './glacial';
import type { Mesh } from './mesh';
import { type FjordLayer, type FjordNet, FJ, buildFjordNet, fjordLayer } from './fjords';
import { fbm, fbm3, gradientNoise, gradientNoise3, mixSeed } from './rng';
import { baseComponentsOf } from './terrain';
import type { World } from './world';

// ---------- 海岸类型（第三十四轮） ----------
// 每格的几种海岸的权重（0–1），格子层级、只按生成器的分量与新建时的纬度定（不看陆海、陆地程度、改过的抬升）：
// 画陆地、放岛时幽灵海岸照旧准确（权重不变），改气候、堆山都不改它——海岸的样子是新建时定下的。
//   · 峡湾：冰盖到过（core/glacial.ts 的强度）、近处有高山（生成器造山带与丘陵的抬升，自己与一圈邻格取最大）。
//     画法（第三十六轮，core/fjords.ts）：这一带撒点连成谷网，按陆海淹掉连着海的一段，画成一条条带子（着色器、core/display.ts、导出同一个算式）；
//     海里离岸不远的地方冒出一片片岛礁；
//   · 沙坝海岸：纬度 < 60°、低抬升（被动大陆边缘）、陆壳上（宽大陆架），再按很低频的噪声只取约四成的岸段。
//     画法：海岸细节压平，岸外一条带缺口的细沙坝，后面是潟湖；
//   · 溺谷：没被冰盖刮过、丘陵海岸（中等抬升）、不是沙坝，约一半的岸段。只在描河里放宽河口的喇叭口（core/rivers.ts）；
//   · 三角洲：第三十三轮按推导认（core/delta.ts），这里不另算；
//   · 小湖群（不是海岸，借同一张纹理）：冰盖到过的低地上，格以下的噪声的峰画成水面（格还是陆地）。
// 着色器的海岸值纹理第三十四轮起是四个通道（RGBA32F）：r 海岸值、g 破碎度、b 小湖群与峡湾的表号（第三十六轮：有表的格是整数
// 1 + 256 × 表号 + 小湖群权重 × 255，没有表的格是负的小湖群权重 × 255）、a 沙坝（> 0）或岛礁（第三十六轮，负的峡湾权重）。b、a 就是这里的 packed。
// 峡湾的表（按陆海）在另一张纹理里（core/fjords.ts 的 fjordLayer）

export const STYLE = {
  // 峡湾：造山带与丘陵的抬升（自己与一圈邻格的最大）从 FJ_UP0 到 FJ_UP1 渐满，再乘冰盖的强度
  FJ_UP0: 0.12,
  FJ_UP1: 0.3,
  // 沙坝：纬度 BAR_LAT0 起渐渐没有、到 BAR_LAT1 没有；抬升 BAR_UP0 到 BAR_UP1 之间渐渐没有；陆壳程度 BAR_CRUST0 到 BAR_CRUST1 渐满
  BAR_LAT0: 54,
  BAR_LAT1: 62,
  BAR_UP0: 0.012,
  BAR_UP1: 0.045,
  BAR_CRUST0: 0.5,
  BAR_CRUST1: 0.9,
  // 岸段的噪声：波长约 SEG_KM，超过 BAR_SEG（沙坝）、RIA_SEG（溺谷）的段才有，渐变宽 SEG_W
  SEG_KM: 700,
  BAR_SEG: 0.02,
  RIA_SEG: 0.0,
  SEG_W: 0.08,
  // 溺谷：抬升 RIA_UP0 到 RIA_UP1 渐满、RIA_UP2 到 RIA_UP3 渐渐没有（高山海岸不算）；乘 (1 − 冰盖)、(1 − 沙坝)
  RIA_UP0: 0.03,
  RIA_UP1: 0.07,
  RIA_UP2: 0.25,
  RIA_UP3: 0.4,
};

export interface CoastStyle {
  // 每格两个数（着色器海岸值纹理的 b、a）：b 有峡湾表的格 1 + 256 × 表号 + round(小湖群 × 255)，别的格 −round(小湖群 × 255)；
  // a 沙坝（> 0）或 −峡湾权重（岛礁；两样不会同时有：沙坝要低抬升、峡湾要高抬升）
  packed: Float32Array;
  // 谷网（第三十六轮，core/fjords.ts）；没有峡湾时为 null
  net: FjordNet | null;
  fjord: Float32Array;
  barrier: Float32Array;
  ria: Float32Array;
  speck: Float32Array;
}

const sm01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// 岸段的噪声（只取决于网格、种子、比例尺与新建时的纬度），按网格缓存
interface SegNoise {
  key: string;
  bar: Float32Array;
  ria: Float32Array;
}
const segCache = new WeakMap<Mesh, SegNoise>();
function segNoise(world: World): SegNoise {
  const { mesh } = world;
  const key = glacialKey(world);
  const hit = segCache.get(mesh);
  if (hit && hit.key === key) return hit;
  const n = mesh.n;
  const bar = new Float32Array(n);
  const ria = new Float32Array(n);
  const seed = world.settings.seed;
  const f = 1 / STYLE.SEG_KM;
  if (mesh.kind === 'sphere') {
    const R = world.kmPerUnit / Math.PI;
    const a = gradientNoise3(mixSeed(seed, 3411));
    const b = gradientNoise3(mixSeed(seed, 3412));
    for (let i = 0; i < n; i++) {
      const x = mesh.p[3 * i] * R;
      const y = mesh.p[3 * i + 1] * R;
      const z = mesh.p[3 * i + 2] * R;
      bar[i] = fbm3(a, x, y, z, f, 2);
      ria[i] = fbm3(b, x, y, z, f, 2);
    }
  } else {
    const km = world.kmPerUnit;
    const a = gradientNoise(mixSeed(seed, 3411));
    const b = gradientNoise(mixSeed(seed, 3412));
    for (let i = 0; i < n; i++) {
      bar[i] = fbm(a, mesh.x[i] * km, mesh.y[i] * km, f, 2);
      ria[i] = fbm(b, mesh.x[i] * km, mesh.y[i] * km, f, 2);
    }
  }
  const out = { key, bar, ria };
  segCache.set(mesh, out);
  return out;
}

// 按网格缓存：键是新建时的纬度等（glacialKey）与生成器的分量。分量换了（重画一片、撤销重画）时只重算三样输入变了的格附近
interface Entry {
  key: string;
  comp: BaseComponents;
  style: CoastStyle;
}
const cache = new WeakMap<Mesh, Entry[]>();
// 测试用：关掉海岸类型（第三十四轮以前的画法）
export const coastStyleOn = { on: true };

export function coastStyle(world: World): CoastStyle | null {
  if (!coastStyleOn.on) return null;
  const comp = baseComponentsOf(world);
  if (!comp) return null;
  const { mesh } = world;
  const key = glacialKey(world);
  const list = cache.get(mesh) ?? [];
  const hit = list.find((e) => e.comp === comp && e.key === key);
  if (hit) return hit.style;
  const prev = list.find((e) => e.key === key);
  const style = prev ? updateStyle(world, comp, prev.comp, prev.style) : computeStyle(world, comp, null);
  cache.set(mesh, [{ key, comp, style }, ...list.filter((e) => e !== hit)].slice(0, 3));
  return style;
}

// 这个世界的海岸类型已经在缓存里（预热时用：已有时不让出）
export function coastStyleCached(world: World): boolean {
  if (!coastStyleOn.on) return true;
  const comp = baseComponentsOf(world);
  if (!comp) return true;
  const key = glacialKey(world);
  const hit = (cache.get(world.mesh) ?? []).find((e) => e.comp === comp && e.key === key);
  return !!hit && (!hit.style.net || !!wetCache.get(hit.style.net)?.out);
}

// 整份算
function computeStyle(world: World, comp: BaseComponents, cells: Int32Array | null): CoastStyle {
  const n = world.mesh.n;
  const style: CoastStyle = { packed: new Float32Array(2 * n), net: null, fjord: new Float32Array(n), barrier: new Float32Array(n), ria: new Float32Array(n), speck: new Float32Array(n) };
  styleCells(world, comp, style, cells);
  style.net = buildFjordNet(world.mesh, world.settings.seed, style.fjord, comp.b0);
  packStyle(style, world.mesh.n);
  return style;
}

// b、a（表号要等谷网建好）
function packStyle(st: CoastStyle, n: number): void {
  const rank = st.net ? st.net.rank : null;
  for (let i = 0; i < n; i++) {
    const g = Math.round(st.speck[i] * 255);
    const rk = rank ? rank[i] : -1;
    st.packed[2 * i] = rk >= 0 ? 1 + 256 * rk + g : -g;
    const bar = st.barrier[i];
    st.packed[2 * i + 1] = bar > 0 ? bar : st.fjord[i] > 0 ? -st.fjord[i] : 0;
  }
}

// 分量换了：三样输入（造山带、丘陵的抬升，地壳高度）逐格比，变了的格与两圈邻格重算（抬升取一圈邻格的最大、方向按一圈邻格的坡度）；
// 没变的格照抄上一份（同样的输入、同一个算式）
function updateStyle(world: World, comp: BaseComponents, was: BaseComponents, old: CoastStyle): CoastStyle {
  const { mesh } = world;
  const n = mesh.n;
  const mark = new Uint8Array(n);
  const front: number[] = [];
  for (let i = 0; i < n; i++) {
    if (comp.mountU[i] !== was.mountU[i] || comp.hillU[i] !== was.hillU[i] || comp.b0[i] !== was.b0[i]) {
      mark[i] = 1;
      front.push(i);
    }
  }
  const style: CoastStyle = { packed: old.packed.slice(), net: old.net, fjord: old.fjord.slice(), barrier: old.barrier.slice(), ria: old.ria.slice(), speck: old.speck.slice() };
  if (!front.length) return style;
  for (let ring = 0; ring < 2; ring++) {
    const next: number[] = [];
    for (const c of front) {
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
        const j = mesh.adj[e];
        if (!mark[j]) {
          mark[j] = 1;
          next.push(j);
        }
      }
    }
    front.push(...next);
  }
  const cells: number[] = [];
  for (let i = 0; i < n; i++) if (mark[i]) cells.push(i);
  styleCells(world, comp, style, Int32Array.from(cells));
  // 谷网：峡湾权重或谷网里的格的地壳高度变了才重建（只看重算的格）
  let redo = false;
  for (const i of cells) {
    if (style.fjord[i] !== old.fjord[i] || ((style.fjord[i] > FJ.ZONE || old.fjord[i] > FJ.ZONE) && comp.b0[i] !== was.b0[i])) {
      redo = true;
      break;
    }
  }
  if (redo) style.net = buildFjordNet(mesh, world.settings.seed, style.fjord, comp.b0);
  packStyle(style, n);
  return style;
}

// 算 cells 这些格（null：全部）的权重
function styleCells(world: World, comp: BaseComponents, st: CoastStyle, cells: Int32Array | null): void {
  const { mesh } = world;
  const S = STYLE;
  const gl = glacialField(world);
  const seg = segNoise(world);
  const { mountU, hillU, b0 } = comp;
  const count = cells ? cells.length : mesh.n;
  for (let k = 0; k < count; k++) {
    const i = cells ? cells[k] : k;
    let up = mountU[i] + hillU[i];
    for (let e = mesh.off[i]; e < mesh.off[i + 1]; e++) {
      const j = mesh.adj[e];
      const u = mountU[j] + hillU[j];
      if (u > up) up = u;
    }
    const g = gl.g[i];
    const lat = Math.abs(creationLat(world, i));
    const fj = g * sm01((up - S.FJ_UP0) / (S.FJ_UP1 - S.FJ_UP0));
    const crust = sm01(((b0[i] + 2300) / 1800 - S.BAR_CRUST0) / (S.BAR_CRUST1 - S.BAR_CRUST0));
    const bar = (1 - sm01((lat - S.BAR_LAT0) / (S.BAR_LAT1 - S.BAR_LAT0))) * (1 - sm01((up - S.BAR_UP0) / (S.BAR_UP1 - S.BAR_UP0))) * crust * sm01((seg.bar[i] - S.BAR_SEG) / S.SEG_W);
    const ria = (1 - g) * (1 - bar) * sm01((up - S.RIA_UP0) / (S.RIA_UP1 - S.RIA_UP0)) * (1 - sm01((up - S.RIA_UP2) / (S.RIA_UP3 - S.RIA_UP2))) * sm01((seg.ria[i] - S.RIA_SEG) / S.SEG_W);
    st.fjord[i] = fj;
    st.barrier[i] = bar;
    st.ria[i] = ria;
    st.speck[i] = g;
  }
}

// ---------- 按陆海定的一份：峡湾淹到哪里（第三十六轮） ----------
// 每格的 b、a 不随陆海变（表号是谷网的、不看陆海），按陆海判的那一套（导出、悬停的陆海）与画面用的都是 packed。
// 第三十四轮的“峡湾只在挨着海的陆格上”换成谷网按陆海淹到哪里（core/fjords.ts 的 fjordLayer）
export function landStyle(world: World): Float32Array | null {
  const style = coastStyle(world);
  return style ? style.packed : null;
}

// 按陆海淹到哪里的峡湾纹理（core/fjords.ts）。只看谷网里的点所在的格的陆海：都没变时还是上一份（同一个对象）
interface Wet {
  landAt: Uint8Array;
  out: FjordLayer | null;
}
const wetCache = new WeakMap<FjordNet, Wet>();
export function fjordData(world: World): FjordLayer | null {
  const style = coastStyle(world);
  const net = style?.net;
  if (!net) return null;
  return fjordDataFor(net, world.causes.land, world.mesh.n);
}

export function fjordDataFor(net: FjordNet, land: ArrayLike<number>, n: number): FjordLayer {
  let w = wetCache.get(net);
  if (!w) {
    w = { landAt: new Uint8Array(net.watch.length), out: null };
    wetCache.set(net, w);
  }
  if (w.out && sameAt(net.watch, w.landAt, land)) return w.out;
  const out = fjordLayer(net, land, n);
  for (let k = 0; k < net.watch.length; k++) w.landAt[k] = land[net.watch[k]];
  w.out = out;
  return out;
}

function sameAt(cells: Int32Array, at: Uint8Array, a: ArrayLike<number>): boolean {
  for (let k = 0; k < cells.length; k++) if (a[cells[k]] !== at[k]) return false;
  return true;
}

// 画面上的一份（core/display.ts 的 DisplayCoast.style、着色器）：再把湖面格的沙坝去掉（湖里不画沙坝）。
// lakes：有沙坝权重的湖格（displayCoast 认湖面时顺带记下的，升序）。没有时就是 ls；与上一次的 ls、lakes 相同时还是上一份
let lastLakes: { ls: Float32Array; lakes: number[]; out: Float32Array } | null = null;
export function withoutLakeBarriers(ls: Float32Array, lakes: number[]): Float32Array {
  if (!lakes.length) return ls;
  const c = lastLakes;
  if (c && c.ls === ls && c.lakes.length === lakes.length && c.lakes.every((v, k) => v === lakes[k])) return c.out;
  const out = ls.slice();
  for (const i of lakes) out[2 * i + 1] = 0;
  lastLakes = { ls, lakes, out };
  return out;
}

// 画面上的一份（测试用，与 displayCoast 的 style 相同）
export function displayStyle(world: World): Float32Array | null {
  const ls = landStyle(world);
  if (!ls) return null;
  const { causes, derived: d } = world;
  const lakes: number[] = [];
  for (let i = 0; i < world.mesh.n; i++) if (causes.land[i] === 1 && d.lake[i] === 1 && ls[2 * i + 1] !== 0) lakes.push(i);
  return withoutLakeBarriers(ls, lakes);
}

// ---------- 画法（着色器里有一份同样的算式：src/render/renderer.ts 的 STYLE_GLSL，测试把它换成 JS 逐个比）----------

// 每格的 b 拆开：峡湾的表号（−1 没有）、小湖群的权重
export function decodeStyleB(b: number, out: Float64Array, o: number): void {
  if (b > 0.5) {
    const q = b - 1;
    const rk = Math.floor(q / 256);
    out[o] = rk;
    out[o + 1] = (q - 256 * rk) / 255;
  } else {
    out[o] = -1;
    out[o + 1] = -b / 255;
  }
}

// 一点（三角形的三个角与重心坐标）的权重，写进 out：[峡湾的表号（−1 没有）, 格心的权重, 0, 小湖群, 沙坝,
// 三个角的 |海岸值| 的插值, 岛礁]（与着色器的顶点着色器拆开再插值相同）。prov：这个三角形的最后一个顶点的格（着色器的 flat 取它的表号；
// 它的表含碰得到这个三角形的全部段，见 core/fjords.ts）。coast：这一套海岸场的每格海岸值（沙坝、岛礁离岸多远按它）
const dec = new Float64Array(2);
export function styleAt(packed: Float32Array, coast: Float32Array, a: number, b: number, c: number, wa: number, wb: number, wc: number, out: Float64Array, prov: number): void {
  out[0] = -1;
  out[1] = out[2] = out[3] = out[4] = out[6] = 0;
  // 三个角都没有（多数地方）：不必拆（|海岸值| 只给沙坝、岛礁用，它们的权重是 0）
  if (packed[2 * a] === 0 && packed[2 * a + 1] === 0 && packed[2 * b] === 0 && packed[2 * b + 1] === 0 && packed[2 * c] === 0 && packed[2 * c + 1] === 0 && packed[2 * prov] === 0) {
    out[5] = 0;
    return;
  }
  const pa = packed[2 * prov];
  if (pa > 0.5) out[0] = Math.floor((pa - 1) / 256);
  addCorner(packed, a, wa, out);
  addCorner(packed, b, wb, out);
  addCorner(packed, c, wc, out);
  out[5] = Math.abs(coast[a]) * wa + Math.abs(coast[b]) * wb + Math.abs(coast[c]) * wc;
  // 格心附近渐渐不画（格心的陆海与这一格一致：河的起点、河口、点选都按格心）
  const k = styleWeight(Math.max(wa, wb, wc));
  out[1] = k;
  // 岛礁的权重不乘 k 的一份（峡湾海岸的海岸细节按它放大，与沙坝压平一样不看格心）
  out[2] = out[6];
  out[3] *= k;
  out[4] *= k;
  out[6] *= k;
}

// 海岸类型、小湖群在格心为 0、离格心不远就是 1 的权重（wmax：重心坐标里最大的那个；着色器里同一个算式）
export function styleWeight(wmax: number): number {
  return Math.min(1, Math.max(0, (1 - wmax) * LOOK.STYLE_CENTER));
}
function addCorner(packed: Float32Array, i: number, w: number, out: Float64Array): void {
  decodeStyleB(packed[2 * i], dec, 0);
  out[3] += w * dec[1];
  const a = packed[2 * i + 1];
  if (a > 0) out[4] += w * a;
  else out[6] -= w * a;
}

// 这几样画法的常数（着色器里同一组）
export const LOOK = {
  // 格心附近（重心坐标最大的那个超过 1 − 1/STYLE_CENTER）渐渐不画
  STYLE_CENTER: 6,
  // 沙坝海岸的海岸细节压到 1 − BAR_SMOOTH
  BAR_SMOOTH: 0.8,
  // 岛礁（第三十六轮，峡湾海岸的海里）：每格 SK_FREQ 的噪声超过门槛 SK_T0 + SK_T1 × 离岸（海岸场 ÷ R，R 是三个角的 |海岸值| 的插值，至少 SK_RMIN）
  // + (1 − 权重) × SK_TK 的地方冒出来（渐变 SK_W），冒到 SK_H
  SK_FREQ: 2.6,
  SK_OFF: [-23.9, 7.7, 15.3] as const,
  SK_T0: 0.05,
  SK_T1: 0.4,
  SK_TK: 0.25,
  SK_W: 0.05,
  SK_H: 25,
  SK_RMIN: 40,
  // 峡湾海岸的海岸细节放大 1 + SK_ROUGH × 权重
  SK_ROUGH: 1.6,
  SK_ROUGH_K: 2,
  // 沙坝：离岸多远按三角形三个角的 |海岸值| 的插值 R（至少 BAR_RMIN）量：水面一侧海岸场在 −BAR_MID·R 附近（±BAR_HALF·R）冒出来，
  // 冒 BAR_LIFT·R（岸线到水面格的格心大约四成半处，一格的两三成；各处的海岸值相差很大，按固定的值量时有的贴着岸、有的在一格多以外）；
  // 全是水面格的三角形里 R 就是 −s，冒不出来。缺口的噪声（每格 BAR_FREQ）在 BAR_GAP 以下渐渐是缺口
  BAR_MID: 0.45,
  BAR_HALF: 0.15,
  BAR_LIFT: 0.75,
  BAR_RMIN: 40,
  // 潟湖（只是颜色）：海岸场在 −LAG_OUT·R 以内，往外 LAG_W·R 渐渐没有
  LAG_OUT: 0.5,
  LAG_W: 0.12,
  BAR_FREQ: 0.9,
  BAR_OFF: [-7.3, 12.9, 3.1] as const,
  BAR_GAP: -0.1,
  BAR_GAP_W: 0.25,
  // 小湖群：每格 SPK_FREQ 的噪声超过 SPK_T + (1 − 权重)·SPK_TW（渐变 SPK_W）的地方画成水面；低于 SPK_H0 m 满、到 SPK_H0 + SPK_H1 没有；离岸（海岸场 SPK_S0 起，渐变 SPK_S1）
  SPK_FREQ: 5,
  SPK_OFF: [19.3, 4.1, -6.7] as const,
  SPK_T: 0.3,
  SPK_TW: 0.45,
  SPK_W: 0.03,
  SPK_H0: 200,
  SPK_H1: 400,
  // 贴着海平面的低地（三角洲平原 1–7 m）不画：低于 SPK_LOW0 m 没有、往上 SPK_LOW1 m 渐满（冰川湖在刮过的地盾上；三角洲分汊的几股要走在陆地上）
  SPK_LOW0: 10,
  SPK_LOW1: 30,
  SPK_S0: 150,
  SPK_S1: 60,
  SPK_DEPTH: 30,
};

// 沙坝海岸：海岸细节的倍数
export function barrierDetail(bw: number): number {
  return 1 - LOOK.BAR_SMOOTH * bw;
}
// 海岸细节的倍数：沙坝海岸压平，峡湾海岸（第三十六轮，岛礁的权重 sk）放大 1 + SK_ROUGH × min(1, SK_ROUGH_K × sk)（岸更曲折）。sk = 0 时与 barrierDetail 逐位相同
export function styleDetail(bw: number, sk: number): number {
  return barrierDetail(bw) * (1 + LOOK.SK_ROUGH * Math.min(1, LOOK.SK_ROUGH_K * sk));
}

// 岛礁（第三十六轮）：水面的一点（s ≤ 0）冒出来的程度按噪声 n 与离岸（−s ÷ R），k 权重，r 三个角的 |海岸值| 的插值
export function skerryIsle(s: number, k: number, n: number, r: number): number {
  const L = LOOK;
  const R = Math.max(r, L.SK_RMIN);
  const t = Math.min(1, Math.max(0, (n - (L.SK_T0 + (L.SK_T1 * -s) / R + (1 - k) * L.SK_TK)) / L.SK_W));
  const c = t * t * (3 - 2 * t);
  return s + c * (L.SK_H - s);
}
// 冒得出来的最远处（−s ÷ R）：噪声最大 0.75（两层）
export const SKERRY_REACH = (0.75 - LOOK.SK_T0) / LOOK.SK_T1;

// 沙坝：水面一侧离岸线一段（海岸场在 −BAR_MID·R 附近）的程度（0 时不冒、不必取噪声）。r 三个角的 |海岸值| 的插值
export function barrierBump(s: number, r: number): number {
  const L = LOOK;
  const R = Math.max(r, L.BAR_RMIN);
  return Math.max(0, 1 - Math.abs(s + L.BAR_MID * R) / (L.BAR_HALF * R));
}

// 冒出一条带缺口的细沙坝：bump 上面的程度，n 缺口的噪声
export function barrierIsle(s: number, bw: number, n: number, bump: number, r: number): number {
  const L = LOOK;
  const t = Math.min(1, Math.max(0, (n - L.BAR_GAP) / L.BAR_GAP_W));
  return s + bw * t * t * (3 - 2 * t) * L.BAR_LIFT * Math.max(r, L.BAR_RMIN) * bump;
}

// 小湖群的权重（冰盖、低地、离岸、不在三角洲那样贴着海平面的低地上；0 时不画、不必取噪声）。s 海岸场、spk 冰盖的权重、h 高程（m）
export function speckW(s: number, spk: number, h: number): number {
  const L = LOOK;
  const a = Math.min(1, Math.max(0, (h - L.SPK_H0) / L.SPK_H1));
  const b = Math.min(1, Math.max(0, (s - L.SPK_S0) / L.SPK_S1));
  const e = Math.min(1, Math.max(0, (h - L.SPK_LOW0) / L.SPK_LOW1));
  return spk * (1 - a * a * (3 - 2 * a)) * (b * b * (3 - 2 * b)) * (e * e * (3 - 2 * e));
}

// 小湖群：这一点画成水面的程度（0–1）。w 权重（> 0），n 噪声。权重只抬高噪声的门槛：权重弱的地方湖少，但每个湖都画满
// （权重直接乘进去时，峰不够高的地方只剩一圈岸线）
export function speckK(w: number, n: number): number {
  const L = LOOK;
  const c = Math.min(1, Math.max(0, (n - (L.SPK_T + (1 - w) * L.SPK_TW)) / L.SPK_W));
  return c * c * (3 - 2 * c);
}
export function speckApply(s: number, k: number): number {
  return s - k * (s + LOOK.SPK_DEPTH);
}
