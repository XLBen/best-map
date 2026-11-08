// 格以下的海岸（第八十三轮从 core/subcell.ts 原样搬出）：海岸值、破碎度、海岸类型与小湖群的画法、一点是不是陆地（着色器里有一份同样的实现）
import type { World } from './world';
import { coastSeed, coastNoiseField, COAST_AMP } from './terrain';
import type { Mesh } from './mesh';
import { deltaBulge } from './delta';
import { fbmSub, sphereOf, noiseK, fbmSub3, coastDetail } from './subcell-noise';
import { type FjordLayer, fjordField, fjordK, fjordFieldBound } from './fjords';
import { LOOK, SKERRY_REACH, skerryIsle, barrierBump, barrierIsle, speckW, speckK, speckApply, landStyle, styleAt, styleDetail, fjordData } from './coast-style';
import { locate } from './subcell-locate';

// 每格的“海岸值”：> 0 为陆地，与 causes.land 保持一致（含填掉的单格海洞）。
// 压缩到约 ±250 m：否则山地岛屿的格值相差几千米，海岸线几乎完全由线性插值决定，成了折线
const COAST_SQUASH = 250;

export function coastValues(world: World): Float32Array {
  const { mesh, causes } = world;
  const seed = coastSeed(world);
  const coast = coastNoiseField(mesh, seed);
  const amp = COAST_AMP * world.small.terrain.coastRoughness;
  // 上一次的结果（第三十三轮提速）：网格、种子、幅度相同时只重算陆地程度或陆海变了的格（逐格同一个算式，结果逐位相同）。
  // 每改一笔 Worker 描河、主线程画地形层都要算一遍，只改气候时一格都不用重算。比的是上一次的输入的副本（数组可能被就地改过）
  const c = lastCoast;
  if (c && c.mesh === mesh && c.seed === seed && c.amp === amp) {
    coastValuesUpdate(c.landness, c.land, c.s, causes.landness, causes.land, coast, amp, mesh.n);
    return c.s.slice();
  }
  const s = new Float32Array(mesh.n);
  for (let i = 0; i < mesh.n; i++) s[i] = coastValueAt(causes.landness[i], coast[i], amp, causes.land[i] !== 0);
  lastCoast = { mesh, seed, amp, landness: Float32Array.from(causes.landness), land: Uint8Array.from(causes.land), s: s.slice() };
  return s;
}
let lastCoast: { mesh: Mesh; seed: number; amp: number; landness: Float32Array; land: Uint8Array; s: Float32Array } | null = null;

// 陆地程度或陆海与记下的不同的格重算海岸值，记下的输入跟着更新（模块里的函数：逐格的循环很快被编译）
function coastValuesUpdate(oldL: Float32Array, oldLand: Uint8Array, s: Float32Array, landness: ArrayLike<number>, land: ArrayLike<number>, coast: Float32Array, amp: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const l = landness[i];
    const a = land[i];
    if (Object.is(l, oldL[i]) && a === oldLand[i]) continue;
    s[i] = coastValueAt(l, coast[i], amp, a !== 0);
    oldL[i] = l;
    oldLand[i] = a;
  }
}

// 画出来的每格海岸值（第三十三轮）：coastValues 再加上三角洲向海凸出的那一点（core/delta.ts 的 deltaBulge，按推导认三角洲）。
// 地形层、悬停、导出、河口找岸线都用这一份；幽灵海岸（coastPatch）照旧只按成因算改动的那几格
export function shownCoastValues(world: World): Float32Array {
  const s = coastValues(world);
  deltaBulge(world, s);
  return s;
}

// 一格的海岸值：landness、这格的海岸噪声、噪声幅度（COAST_AMP × 破碎度）、这格算不算陆地。
// 预览将来的海岸（还没改动世界）时按同一个算式逐格算
export function coastValueAt(landness: number, noise: number, amp: number, land: boolean): number {
  const v = landness + amp * noise;
  const signed = land ? Math.max(v, 1) : Math.min(v, -1);
  return COAST_SQUASH * Math.tanh(signed / COAST_SQUASH);
}

// 几格将来的海岸值（幽灵海岸）：landness、land 是这几格改动后的值（见 terrain.ts 的 landPatch），
// 与改动后 coastValues 里这几格逐格同一个算式，所以预览画出的海岸线就是结果
export function coastPatch(world: World, cells: ArrayLike<number>, landness: ArrayLike<number>, land: ArrayLike<number>): Float32Array {
  const noise = coastNoiseField(world.mesh, coastSeed(world));
  const amp = COAST_AMP * world.small.terrain.coastRoughness;
  const out = new Float32Array(cells.length);
  for (let k = 0; k < cells.length; k++) out[k] = coastValueAt(landness[k], noise[cells[k]], amp, land[k] !== 0);
  return out;
}

// 格以下的海岸细节幅度（m）：山地海岸更曲折，平原海岸更平滑
export function coastDetailAmp(world: World, elevation: number): number {
  const rough = world.small.terrain.coastRoughness;
  const rugged = Math.min(1, Math.max(0, elevation / 1200));
  return COAST_AMP * rough * (0.55 + 0.9 * rugged);
}

// ---------- 破碎度（第十八轮）----------
// 每格的破碎度 f（causes.fragment / 255）在三角形里按重心插值成 fv。fv > 0 的像素（着色器里有一份同样的实现，
// 见 src/render/renderer.ts 的 FRAG_GLSL；fv = 0 的地方不走这里，与以前逐位相同）：
//   s = clamp(sv, −D, D) + 海岸细节 + weight · FRAG_AMP · q · m
//   · q = 1 − (1 − fv)³：fv → 0 时为 0（碎与不碎的交界没有断口），fv 大一点就很快起作用；
//   · D = mix(FRAG_D_MAX, FRAG_D_MIN, q)：插值的海岸值压到 ±D 以内——深海、内陆都离“海岸线”近了，
//     加上的噪声才冒得出碎岛、裂得开水道（FRAG_D_MAX 比海岸值的上限 250 大，q 很小时不压）；
//   · m = clamp(|n| · FRAG_G, 0, 1) · 2 − 1，n 是一层更细的噪声（fragNoise，约 1/3 格到 1/20 格）：|n| 大的地方（噪声的峰和谷）
//     冒出一颗颗碎岛，|n| ≈ 0 的地方（噪声的零线，一条条弯曲的线）是陆上的裂缝；
//   · weight 与海岸细节的相同（格心为 0）：格心的陆海与这一格一致，气候、河流、生态照旧按整格算。
// 碎岛只是画出来的（所在的格还是海）
export const FRAG_D_MAX = 260;
export const FRAG_D_MIN = 20;
export const FRAG_AMP = 200;
export const FRAG_G = 3;
// 碎岛噪声的频率（每格几个噪声单位）与偏移（与海岸细节的噪声错开）
export const FRAG_FREQ = 1.3;
export const FRAG_OFF: readonly [number, number, number] = [31.7, -13.9, 7.3];

// sv：插值的海岸值；det：海岸细节（weight · 幅度 · coastDetail）；fv：插值的破碎度（> 0）；weight：海岸细节的权重；n：fragNoise
export function fragCoast(sv: number, det: number, fv: number, weight: number, n: number): number {
  const u = 1 - fv;
  const q = 1 - u * u * u;
  const d = FRAG_D_MAX + (FRAG_D_MIN - FRAG_D_MAX) * q;
  const c = Math.min(d, Math.max(-d, sv));
  const m = Math.min(1, Math.max(0, Math.abs(n) * FRAG_G)) * 2 - 1;
  return c + det + weight * FRAG_AMP * q * m;
}

// 碎岛的噪声（平面世界）
export function fragNoise(x: number, y: number, spacing: number): number {
  return fbmSub((x / spacing) * FRAG_FREQ + FRAG_OFF[0], (y / spacing) * FRAG_FREQ + FRAG_OFF[1], 3);
}

// 整个星球：在球面上取
export function fragNoise3(x: number, y: number, spacing: number): number {
  const [px, py, pz] = sphereOf(x, y);
  const k = noiseK(spacing) * FRAG_FREQ;
  return fbmSub3(px * k + FRAG_OFF[0], py * k + FRAG_OFF[1], pz * k + FRAG_OFF[2], 3);
}

// 碎岛上的高度（m）：离岸越远越高一点（几米到三十来米），边上一圈是沙滩。着色器里同一个算式
export const fragIsleHeight = (s: number) => 2 + 0.5 * Math.min(s, 60);
// 破碎的海面浅一些（只是画法，模拟的海底不变）：fv = 1 时水深只剩 15%
export const fragSeaDepth = (h: number, fv: number) => h * (1 - 0.85 * fv);

// 每格的破碎度（0–1）；没打碎过（没有数组、全是 0）时为 null（调用方照旧算，与以前逐位相同）。
// lakesDry：湖面格按 0 算（按 causes.land 判陆海的那一套：湖面算陆地，湖里的碎岛只在画面的海岸场里，见 display.ts 的 displayCoast）
export function fragValues(world: World, lakesDry: boolean): Float32Array | null {
  const f = world.causes.fragment;
  if (!f) return null;
  let any = false;
  for (let i = 0; i < f.length && !any; i++) if (f[i]) any = true;
  if (!any) return null;
  const out = new Float32Array(f.length);
  const { land } = world.causes;
  const lake = world.derived.lake;
  for (let i = 0; i < f.length; i++) out[i] = lakesDry && land[i] === 1 && lake[i] === 1 ? 0 : f[i] / 255;
  return out;
}

// 字节数组的内容摘要（FNV）：引擎就地改破碎度、陆海数组（同一个对象），缓存按内容认
export function bytesHash(h: number, a: Uint8Array | undefined): number {
  if (!a) return Math.imul(h ^ 0xff, 16777619) >>> 0;
  for (let i = 0; i < a.length; i++) h = Math.imul(h ^ a[i], 16777619);
  return h >>> 0;
}

// 按陆海判（湖面算陆地）用的每格破碎度：按破碎度、陆海、湖面的内容缓存（悬停每动一下都要用；摘要几万格不到 1 毫秒）
const fragLandCache = new WeakMap<object, { key: number; value: Float32Array | null }>();
export function fragLand(world: World): Float32Array | null {
  const f = world.causes.fragment;
  if (!f) return null;
  const key = bytesHash(bytesHash(bytesHash(2166136261, f), world.causes.land), world.derived.lake);
  const c = fragLandCache.get(world.mesh);
  if (c && c.key === key) return c.value;
  const value = fragValues(world, true);
  fragLandCache.set(world.mesh, { key, value });
  return value;
}

// ---------- 海岸类型与小湖群的画法（第三十四轮，core/coast-style.ts；着色器里有一份同样的实现）----------
// st：这一点的 [峡湾的表号, 格心的权重, 0, 小湖群, 沙坝, |海岸值|, 岛礁]（styleAt）。s：海岸场（已含海岸细节、破碎），sv：插值的海岸值，h：插值的高程（m）。
// display：画面上的海岸场（湖面算水，含小湖群）；按陆海判（湖面算陆地）的那一套不画小湖群。x 在整个星球上已绕回 [0, 2)。
// nd：这一点的海岸细节噪声（coastDetail，峡湾的岸按它起伏）；fj：按陆海淹到哪里的峡湾（core/fjords.ts，第三十六轮）
export function styledCoast(sphere: boolean, x: number, y: number, sp: number, s: number, sv: number, h: number, st: Float64Array, display: boolean, nd: number, fj: FjordLayer | null): number {
  const L = LOOK;
  // 岛礁（第三十六轮）在峡湾之前：峡湾一直刻到海里，穿过岸外的岛礁
  if (st[6] > 0 && s <= 0 && -s < SKERRY_REACH * Math.max(st[5], L.SK_RMIN)) s = skerryIsle(s, st[6], sphere ? sphereNoise(x, y, sp, L.SK_FREQ, L.SK_OFF) : planeNoise(x, y, sp, L.SK_FREQ, L.SK_OFF), st[5]);
  // 峡湾只刻陆地（水面上刻了也还是水面）
  if (st[0] >= 0 && s > 0 && fj) {
    const f = fjordAt(sphere, x, y, sp, st[0], sv > 0 ? st[1] : 1, nd, fj);
    if (f < s) s = f;
  }
  if (st[4] > 0) {
    const bump = barrierBump(s, st[5]);
    if (bump > 0) s = barrierIsle(s, st[4], sphere ? sphereNoise(x, y, sp, L.BAR_FREQ, L.BAR_OFF) : planeNoise(x, y, sp, L.BAR_FREQ, L.BAR_OFF), bump, st[5]);
  }
  if (display && st[3] > 0) {
    const w = speckW(s, st[3], h);
    if (w > 0) {
      const k = speckK(w, sphere ? sphereNoise(x, y, sp, L.SPK_FREQ, L.SPK_OFF) : planeNoise(x, y, sp, L.SPK_FREQ, L.SPK_OFF));
      if (k > 0) s = speckApply(s, k);
    }
  }
  return s;
}

// 峡湾：这一点所有淹着的段里最小的海岸场（core/fjords.ts 的 fjordField；整个星球在单位球上量）
// rank：表号；k：格心附近渐渐不刻（陆地格的格心照旧是陆地；插值的海岸值 ≤ 0 的地方不必）
function fjordAt(sphere: boolean, x: number, y: number, sp: number, rank: number, k: number, nd: number, fj: FjordLayer): number {
  // 这一格的表是空的（谷网里没淹着的地方）：不必算位置
  if (fj.tex[4 * rank + 1] === 0) return Infinity;
  if (sphere) {
    const lon = Math.PI * (x - 1);
    const colat = Math.PI * Math.min(1, Math.max(0, y));
    const sc = Math.sin(colat);
    const px = sc * Math.cos(lon);
    const py = sc * Math.sin(lon);
    const pz = Math.cos(colat);
    return fjordField(fj.tex, rank, px, py, pz, px, py, pz, k, nd, fjordK(Math.PI * sp));
  }
  return fjordField(fj.tex, rank, x, y, 0, 0, 0, 1, k, nd, fjordK(sp));
}

// 小湖群画成水面的程度（导出的栅格标出这些像素）：与 styledCoast 里的同一个算式
export function speckAt(sphere: boolean, x: number, y: number, sp: number, s: number, h: number, spk: number): number {
  const L = LOOK;
  const w = speckW(s, spk, h);
  if (w <= 0) return 0;
  return speckK(w, sphere ? sphereNoise(x, y, sp, L.SPK_FREQ, L.SPK_OFF) : planeNoise(x, y, sp, L.SPK_FREQ, L.SPK_OFF));
}

// 这一点的画法会不会改变海岸场的正负（只看正负的捷径不能走）：峡湾只把陆地刻成水、沙坝与岛礁只把水面冒成陆地、小湖群只在低地的陆地上
// display：画面上的那一套（画小湖群）；a：海岸细节最多能改多少（这一点的海岸场在 sv ± a 之间）。
// 按各自的算式取上下界：峡湾按这一点到淹着的段的距离（细节噪声取最大）；沙坝只在 −(MID ± HALF)·R 之间冒（只冒水面）；
// 岛礁只在离岸 SKERRY_REACH·R 以内；小湖群只在海岸场 > SPK_S0、高程在 SPK_LOW0 与 SPK_H0 + SPK_H1 之间
export function styleMayFlip(sphere: boolean, x: number, y: number, sp: number, st: Float64Array, sv: number, h: number, display: boolean, a: number, fj: FjordLayer | null): boolean {
  const L = LOOK;
  if (sv > 0) {
    if (st[0] >= 0 && fj && fjordBoundAt(sphere, x, y, sp, st[0], st[1], fj) < sv + a) return true;
    return display && st[3] > 0 && sv + a > L.SPK_S0 && h > L.SPK_LOW0 && h < L.SPK_H0 + L.SPK_H1;
  }
  const R = Math.max(st[5], L.BAR_RMIN);
  if (st[4] > 0 && sv + a > -(L.BAR_MID + L.BAR_HALF) * R && sv - a < -(L.BAR_MID - L.BAR_HALF) * R) return true;
  return st[6] > 0 && sv - a <= 0 && sv + a > -SKERRY_REACH * Math.max(st[5], L.SK_RMIN);
}
function fjordBoundAt(sphere: boolean, x: number, y: number, sp: number, rank: number, k: number, fj: FjordLayer): number {
  if (fj.tex[4 * rank + 1] === 0) return Infinity;
  if (sphere) {
    const lon = Math.PI * (x - 1);
    const colat = Math.PI * Math.min(1, Math.max(0, y));
    const sc = Math.sin(colat);
    return fjordFieldBound(fj.tex, rank, sc * Math.cos(lon), sc * Math.sin(lon), Math.cos(colat), k, fjordK(Math.PI * sp));
  }
  return fjordFieldBound(fj.tex, rank, x, y, 0, k, fjordK(sp));
}

function planeNoise(x: number, y: number, sp: number, freq: number, off: readonly [number, number, number]): number {
  return fbmSub((x / sp) * freq + off[0], (y / sp) * freq + off[1], 2);
}

function sphereNoise(x: number, y: number, sp: number, freq: number, off: readonly [number, number, number]): number {
  const [px, py, pz] = sphereOf(x, y);
  const k = noiseK(sp) * freq;
  return fbmSub3(px * k + off[0], py * k + off[1], pz * k + off[2], 2);
}

const stPt = new Float64Array(7);

// 一个点是陆地还是海：与着色器的判定相同
// frag（可选）：每格的破碎度（fragValues），省略时按没打碎算
export function pointIsLand(world: World, s: Float32Array, elevation: Float32Array, x: number, y: number, hint: number, frag: Float32Array | null = null): { land: boolean; nearest: number; height: number } {
  const loc = locate(world.mesh, x, y, hint);
  const [a, b, c] = loc.i;
  const [wa, wb, wc] = loc.w;
  const sv = s[a] * wa + s[b] * wb + s[c] * wc;
  const h = elevation[a] * wa + elevation[b] * wb + elevation[c] * wc;
  const wmax = Math.max(wa, wb, wc);
  const weight = Math.min(1, (1 - wmax) * 2.2);
  // 海岸类型（第三十四轮）：沙坝海岸压平海岸细节，峡湾、沙坝改海岸场（按陆海判，不画小湖群）
  const style = landStyle(world);
  if (style) styleAt(style, s, a, b, c, wa, wb, wc, stPt, loc.prov);
  const nd = coastDetail(x, y, world.mesh.spacing);
  const det = weight * coastDetailAmp(world, Math.max(0, h)) * (style ? styleDetail(stPt[4], stPt[2]) : 1) * nd;
  let total = sv + det;
  const fv = frag ? frag[a] * wa + frag[b] * wb + frag[c] * wc : 0;
  if (fv > 0) total = fragCoast(sv, det, fv, Math.min(1, Math.max(0, (1 - wmax) * 2.2)), world.mesh.kind === 'sphere' ? fragNoise3(x, y, world.mesh.spacing) : fragNoise(x, y, world.mesh.spacing));
  if (style) total = styledCoast(world.mesh.kind === 'sphere', world.mesh.kind === 'sphere' ? x - 2 * Math.floor(x / 2) : x, y, world.mesh.spacing, total, sv, h, stPt, false, nd, fjordData(world));
  return { land: total > 0, nearest: loc.nearest, height: h };
}
