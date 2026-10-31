import type { Delaunay } from 'd3-delaunay';
import { type Mesh, type PlaneMesh, findCell, gradient } from './mesh';
import { type SphereView, viewOf } from './sphere';
import { landPixelCells } from './island-types';
import { deltaBulge } from './delta';
import { displayCoast } from './display';
import { LOOK, SKERRY_REACH, barrierBump, barrierIsle, styleDetail, fjordData, landStyle, skerryIsle, speckApply, speckK, speckW, styleAt } from './coast-style';
import { type FjordLayer, fjordField, fjordFieldBound, fjordK, sphereProvDel } from './fjords';
import { COAST_AMP, coastNoiseField, coastSeed } from './terrain';
import type { World } from './world';

// 格以下的细节：屏幕渲染（着色器里有一份同样的实现）与导出共用同一套整数哈希噪声和判定规则，
// 所以屏幕上看到的海岸、边界与导出的位图一致。
//   · 海岸：三角形内插值的“海岸值” + 噪声 × 权重；权重在格中心为 0，所以每个格的陆海与模拟完全一致
//   · 边界：按扭曲后的坐标找最近的格，省份与生态的边界是自然曲线而不是六边形

// 与 GLSL 版本逐位一致的 32 位整数哈希
export function hashU(x: number, y: number): number {
  return hashAB(lcg(x), lcg(y)) >>> 0;
}

// 哈希按有符号 32 位整数算（与 >>> 0 的写法逐位相同）。第一步 lcg 只与一个坐标有关，
// 一格的几个角、同一列 / 同一行的像素可以共用
function lcg(v: number): number {
  return (Math.imul(v, 1664525) + 1013904223) | 0;
}

// 二维哈希的其余部分：a = lcg(x)，b = lcg(y)
function hashAB(a: number, b: number): number {
  a = (a + Math.imul(b, 1664525)) | 0;
  b = (b + Math.imul(a, 1664525)) | 0;
  a ^= a >>> 16;
  b ^= b >>> 16;
  a = (a + Math.imul(b, 1664525)) | 0;
  b = (b + Math.imul(a, 1664525)) | 0;
  a ^= a >>> 16;
  b ^= b >>> 16;
  return a ^ b;
}

const unit = (h: number) => (h & 0xffffff) / 16777216;

// 值噪声，输出 [-1, 1]
export function vnoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const x0 = lcg(ix);
  const x1 = lcg(ix + 1);
  const y0 = lcg(iy);
  const y1 = lcg(iy + 1);
  const a = unit(hashAB(x0, y0));
  const b = unit(hashAB(x1, y0));
  const c = unit(hashAB(x0, y1));
  const d = unit(hashAB(x1, y1));
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}

export function fbmSub(x: number, y: number, octaves: number): number {
  let s = 0;
  let amp = 0.5;
  let px = x;
  let py = y;
  for (let k = 0; k < octaves; k++) {
    s += amp * vnoise(px, py);
    px = px * 2.03 + 17.1;
    py = py * 2.03 - 9.3;
    amp *= 0.5;
  }
  return s;
}

// 海岸细节噪声：从半个格到 1/16 格
export function coastDetail(x: number, y: number, spacing: number): number {
  return fbmSub((x / spacing) * 2.1, (y / spacing) * 2.1, 4);
}

// 边界扭曲（地图单位）：约半个格，足以把六边形的边扭成自然的曲线
const WARP_AMP = 0.6;
const WARP_FREQ = 0.9;
export function warpOffset(x: number, y: number, spacing: number): [number, number] {
  const f = WARP_FREQ / spacing;
  return [WARP_AMP * spacing * fbmSub(x * f + 3.7, y * f, 3), WARP_AMP * spacing * fbmSub(x * f, y * f - 5.1, 3)];
}

// ---------- 整个星球：在球面位置上取三维噪声（着色器里有一份逐位一致的实现）----------
// 每一份平铺的副本、导出的图都取同样的值：东西接缝、两极都没有断口

export function hashU3(x: number, y: number, z: number): number {
  const a = lcg(x);
  const b = lcg(y);
  const c = lcg(z);
  return hash3R((a + Math.imul(b, 1664525)) | 0, (b + Math.imul(c, 1664525)) | 0, c) >>> 0;
}

// 三维哈希第一轮更新 a、b 之后的部分（a 只与 x、y 有关，b 只与 y、z 有关，一格的几个角共用）；c = lcg(z)
function hash3R(a: number, b: number, c: number): number {
  c = (c + Math.imul(a, 1664525)) | 0;
  a ^= a >>> 16;
  b ^= b >>> 16;
  c ^= c >>> 16;
  a = (a + Math.imul(b, 1664525)) | 0;
  b = (b + Math.imul(c, 1664525)) | 0;
  c = (c + Math.imul(a, 1664525)) | 0;
  a ^= a >>> 16;
  b ^= b >>> 16;
  c ^= c >>> 16;
  return a ^ b ^ c;
}

// 一格八个角的值写进 out[o … o+7]（顺序同 vnoise3 的 a … h）：x0 … z1 是格点坐标的 lcg，mz0 / mz1 = imul(z0 / z1, 1664525)
function corners3(x0: number, x1: number, y0: number, y1: number, z0: number, mz0: number, z1: number, mz1: number, out: Float64Array, o: number) {
  const my0 = Math.imul(y0, 1664525);
  const my1 = Math.imul(y1, 1664525);
  const a00 = (x0 + my0) | 0;
  const a10 = (x1 + my0) | 0;
  const a01 = (x0 + my1) | 0;
  const a11 = (x1 + my1) | 0;
  const b00 = (y0 + mz0) | 0;
  const b10 = (y1 + mz0) | 0;
  const b01 = (y0 + mz1) | 0;
  const b11 = (y1 + mz1) | 0;
  out[o] = unit(hash3R(a00, b00, z0));
  out[o + 1] = unit(hash3R(a10, b00, z0));
  out[o + 2] = unit(hash3R(a01, b10, z0));
  out[o + 3] = unit(hash3R(a11, b10, z0));
  out[o + 4] = unit(hash3R(a00, b01, z1));
  out[o + 5] = unit(hash3R(a10, b01, z1));
  out[o + 6] = unit(hash3R(a01, b11, z1));
  out[o + 7] = unit(hash3R(a11, b11, z1));
}

// 三线性插值（与 vnoise3 的写法相同）
function trilerp(cn: Float64Array, o: number, u: number, v: number, w: number): number {
  const a = cn[o];
  const b = cn[o + 1];
  const c = cn[o + 2];
  const d = cn[o + 3];
  const e = cn[o + 4];
  const f = cn[o + 5];
  const g = cn[o + 6];
  const h = cn[o + 7];
  const x00 = a + (b - a) * u;
  const x10 = c + (d - c) * u;
  const x01 = e + (f - e) * u;
  const x11 = g + (h - g) * u;
  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;
  return (y0 + (y1 - y0) * w) * 2 - 1;
}

const corner8 = new Float64Array(8);

export function vnoise3(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const w = fz * fz * (3 - 2 * fz);
  const z0 = lcg(iz);
  const z1 = lcg(iz + 1);
  corners3(lcg(ix), lcg(ix + 1), lcg(iy), lcg(iy + 1), z0, Math.imul(z0, 1664525), z1, Math.imul(z1, 1664525), corner8, 0);
  return trilerp(corner8, 0, u, v, w);
}

export function fbmSub3(x: number, y: number, z: number, octaves: number): number {
  let s = 0;
  let amp = 0.5;
  let px = x;
  let py = y;
  let pz = z;
  for (let k = 0; k < octaves; k++) {
    s += amp * vnoise3(px, py, pz);
    px = px * 2.03 + 17.1;
    py = py * 2.03 - 9.3;
    pz = pz * 2.03 + 5.7;
    amp *= 0.5;
  }
  return s;
}

// 显示坐标 → 球面上的点（与着色器的 sphereOf 相同的公式）
function sphereOf(x: number, y: number): [number, number, number] {
  const lon = Math.PI * (x - 1);
  const colat = Math.PI * Math.min(1, Math.max(0, y));
  const s = Math.sin(colat);
  return [s * Math.cos(lon), s * Math.sin(lon), Math.cos(colat)];
}

// 噪声的频率：一个噪声单位约是一格（单位球上格距是 spacing · π 弧度）
const noiseK = (spacing: number) => 1 / (Math.PI * spacing);

export function coastDetail3(x: number, y: number, spacing: number): number {
  const [px, py, pz] = sphereOf(x, y);
  const k = noiseK(spacing) * 2.1;
  return fbmSub3(px * k, py * k, pz * k, 4);
}

// 边界扭曲：噪声在球面上取，偏移量按地图单位（与平面世界一样约半个格）
export function warpOffset3(x: number, y: number, spacing: number): [number, number] {
  const [px, py, pz] = sphereOf(x, y);
  const f = WARP_FREQ * noiseK(spacing);
  return [WARP_AMP * spacing * fbmSub3(px * f + 3.7, py * f, pz * f, 3), WARP_AMP * spacing * fbmSub3(px * f, py * f - 5.1, pz * f, 3)];
}

// 冲沟在一个坐标平面上的样子（与着色器的 gullyPlane 相同）
function gullyPlane(qx: number, qy: number, dx: number, dy: number): number {
  const l = Math.hypot(dx, dy);
  const ux = l > 1e-4 ? dx / l : 1;
  const uy = l > 1e-4 ? dy / l : 0;
  const rx = qx * -uy + qy * ux;
  const ry = qx * ux + qy * uy;
  let g = 0;
  let a = 0.5;
  let fx = 4;
  let fy = 1.1;
  for (let k = 0; k < 3; k++) {
    g += a * (1 - Math.abs(vnoise(rx * fx + k * 7.3, ry * fy + 1.7)));
    a *= 0.5;
    fx *= 2;
    fy *= 2;
  }
  return g;
}

// 整个星球的地表细节（导出高度图用）：冲沟按三个坐标平面混合（每个平面上沿坡向的投影拉长），起伏用三维噪声
export function terrainDetail3(x: number, y: number, h: number, gE: number, gS: number, spacing: number, land: boolean): number {
  const [px, py, pz] = sphereOf(x, y);
  const k = noiseK(spacing);
  if (!land) return Math.min(h + fbmSub3(px * k * 1.3, py * k * 1.3, pz * k * 1.3, 3) * 25, -2);
  const lon = Math.PI * (x - 1);
  const colat = Math.PI * Math.min(1, Math.max(0, y));
  const bumps = fbmSub3(px * k * 1.7 + 5, py * k * 1.7 + 5, pz * k * 1.7 + 5, 4);
  return landDetail3(px, py, pz, Math.cos(lon), Math.sin(lon), Math.sin(colat), h, gE, gS, spacing, bumps);
}

// 陆地部分：(px, py, pz) 是 sphereOf 的结果，cl / sl 是经度的余弦 / 正弦，sc 是余纬的正弦（余纬的余弦就是 pz），
// bumps 是起伏噪声 fbmSub3(p·k·1.7 + 5, 4) 的值
function landDetail3(px: number, py: number, pz: number, cl: number, sl: number, sc: number, h: number, gE: number, gS: number, spacing: number, bumps: number): number {
  const k = noiseK(spacing);
  const gm = Math.hypot(gE, gS);
  const relief = gm * spacing;
  // 东向 e 与南向 sv
  const e0 = -sl;
  const e1 = cl;
  const e2 = 0;
  const sv0 = pz * cl;
  const sv1 = pz * sl;
  const sv2 = -sc;
  const de = gm > 1e-3 ? gE / gm : 1;
  const ds = gm > 1e-3 ? gS / gm : 0;
  const D0 = de * e0 + ds * sv0;
  const D1 = de * e1 + ds * sv1;
  const D2 = de * e2 + ds * sv2;
  let nx = px * px;
  let ny = py * py;
  let nz = pz * pz;
  nx *= nx;
  ny *= ny;
  nz *= nz;
  const ns = nx + ny + nz;
  nx /= ns;
  ny /= ns;
  nz /= ns;
  let g = 0;
  if (nx > 0.02) g += nx * gullyPlane(py * k, pz * k, D1, D2);
  if (ny > 0.02) g += ny * gullyPlane(pz * k, px * k, D2, D0);
  if (nz > 0.02) g += nz * gullyPlane(px * k, py * k, D0, D1);
  const gully = (g - 0.44) * relief * 0.55;
  return Math.max(h + gully + bumps * (14 + 0.05 * Math.max(h, 0)), 2);
}

// 整个星球：点所在的显示三角形与重心坐标（三角网见 sphere.ts 的 viewOf）。
// 同一个三角形里对应同一格的角（极点那一行的影子点）权重合并，与着色器一致
function locateSphere(view: SphereView, r2: Float64Array, x: number, y: number, hint: number, provDel: Int32Array | null = null): number {
  const xw = x - 2 * Math.floor(x / 2);
  const yc = Math.min(1, Math.max(0, y));
  const dl = view.delaunay;
  const start = hint >= 0 && hint < view.cellOf.length ? hint : 0;
  const nearV = within(dl, r2, xw, yc, start) ? start : dl.find(xw, yc, start);
  const near = view.cellOf[nearV];
  let found = around(dl, view.x, view.y, nearV, xw, yc, 64);
  // 退回：看最近点在 Delaunay 上的邻居
  if (!found) {
    for (const v of dl.neighbors(nearV)) {
      if (around(dl, view.x, view.y, v, xw, yc, 64)) {
        found = true;
        break;
      }
    }
  }
  if (!found) {
    li[0] = li[1] = li[2] = near;
    lw[0] = 1;
    lw[1] = lw[2] = 0;
    located.prov = near;
    return near;
  }
  located.prov = provDel ? provDel[lt] : view.cellOf[li[2]];
  const ca = view.cellOf[li[0]];
  let cb = view.cellOf[li[1]];
  let cc = view.cellOf[li[2]];
  let w0 = lw[0];
  let w1 = lw[1];
  let w2 = lw[2];
  if (cb === ca) {
    w0 = w0 + w1;
    w1 = 0;
  }
  if (cc === ca) {
    w0 = w0 + w2;
    w2 = 0;
  } else if (cc === cb && cb !== ca) {
    w1 = w1 + w2;
    w2 = 0;
  }
  if (w1 === 0) cb = ca;
  if (w2 === 0) cc = cb === ca && w1 === 0 ? ca : cb;
  li[0] = ca;
  li[1] = cb;
  li[2] = cc;
  lw[0] = w0;
  lw[1] = w1;
  lw[2] = w2;
  return near;
}

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

// ---------- 点所在的三角形 ----------
// 结果写进 li / lw（三个角与重心坐标），返回最近的格：逐像素调用时不新建对象和闭包
const li = new Int32Array(3);
const lw = new Float64Array(3);
// 找到的 Delaunay 三角形的编号（tryTri 记下）与它的“最后一个顶点的格”（第三十六轮：着色器按它取峡湾的表，见 core/fjords.ts 的 provOfTri）；
// 退回最近的格时是那一格
let lt = -1;
export const located = { prov: -1 };

// 三角形 t 是否含点 (x, y)：含则把三个角（点编号）与重心坐标写进 li / lw
function tryTri(triangles: Uint32Array, X: Float64Array, Y: Float64Array, t: number, x: number, y: number): boolean {
  const a = triangles[3 * t];
  const b = triangles[3 * t + 1];
  const c = triangles[3 * t + 2];
  const ax = X[a];
  const ay = Y[a];
  const v0x = X[b] - ax;
  const v0y = Y[b] - ay;
  const v1x = X[c] - ax;
  const v1y = Y[c] - ay;
  const v2x = x - ax;
  const v2y = y - ay;
  const den = v0x * v1y - v1x * v0y;
  if (Math.abs(den) < 1e-18) return false;
  // 任一个坐标为负就不含：先算出来的先判
  const wb = (v2x * v1y - v1x * v2y) / den;
  if (wb < -1e-9) return false;
  const wc = (v0x * v2y - v2x * v0y) / den;
  if (wc < -1e-9) return false;
  const wa = 1 - wb - wc;
  if (wa < -1e-9) return false;
  li[0] = a;
  li[1] = b;
  li[2] = c;
  lw[0] = wa;
  lw[1] = wb;
  lw[2] = wc;
  lt = t;
  return true;
}

// 绕点 v 一圈的三角形里找含点 (x, y) 的
function around(dl: { triangles: Uint32Array; halfedges: Int32Array; inedges: Int32Array }, X: Float64Array, Y: Float64Array, v: number, x: number, y: number, guards: number): boolean {
  const e0 = dl.inedges[v];
  if (e0 < 0) return false;
  let e = e0;
  for (let guard = 0; guard < guards; guard++) {
    if (tryTri(dl.triangles, X, Y, Math.floor(e / 3), x, y)) return true;
    const next = e % 3 === 2 ? e - 2 : e + 1;
    e = dl.halfedges[next];
    if (e < 0 || e === e0) break;
  }
  return false;
}

// 最近点查找（Delaunay.find）的捷径：点到起点 i 的距离不到 i 与最近邻点距离的一半时，没有别的点比 i 更近，
// find 从 i 出发第一步就停在 i，所以直接返回 i，结果与 find 完全相同。
// r2[i] 是这个半径（略缩一点，留出舍入误差）的平方；按三角网缓存（三角网建好后不再变）
const findRadii = new WeakMap<Delaunay<number>, Float64Array>();
function findRadius2(dl: Delaunay<number>): Float64Array {
  let r2 = findRadii.get(dl);
  if (r2) return r2;
  const P = dl.points;
  r2 = new Float64Array(P.length / 2);
  // 点共线时 d3 走另一套逻辑，不用捷径
  if (!(dl as Delaunay<number> & { collinear?: Int32Array }).collinear) {
    for (let i = 0; i < r2.length; i++) {
      if (dl.inedges[i] === -1) continue;
      let m = Infinity;
      for (const j of dl.neighbors(i)) m = Math.min(m, Math.hypot(P[2 * j] - P[2 * i], P[2 * j + 1] - P[2 * i + 1]));
      if (m < Infinity) r2[i] = (0.5 * m * (1 - 1e-7)) ** 2;
    }
  }
  findRadii.set(dl, r2);
  return r2;
}

// 点 (x, y) 离点 i 是否近到 dl.find(x, y, i) 必定返回 i
function within(dl: Delaunay<number>, r2: Float64Array, x: number, y: number, i: number): boolean {
  const dx = x - dl.points[2 * i];
  const dy = y - dl.points[2 * i + 1];
  return dx * dx + dy * dy < r2[i];
}

function locatePlane(mesh: PlaneMesh, r2: Float64Array, x: number, y: number, hint: number): number {
  const dl = mesh.delaunay;
  const near = within(dl, r2, x, y, hint) ? hint : dl.find(x, y, hint);
  // 先看与最近格相邻的三角形，再看邻居的
  if (around(dl, mesh.x, mesh.y, near, x, y, 32)) {
    located.prov = li[2];
    return near;
  }
  for (let e = mesh.off[near]; e < mesh.off[near + 1]; e++) {
    if (around(dl, mesh.x, mesh.y, mesh.adj[e], x, y, 32)) {
      located.prov = li[2];
      return near;
    }
  }
  li[0] = li[1] = li[2] = near;
  lw[0] = 1;
  lw[1] = lw[2] = 0;
  located.prov = near;
  return near;
}

// 点所在的 Delaunay 三角形与重心坐标；找不到（地图边缘外）时退回最近的格
// prov：这个三角形的“最后一个顶点的格”（峡湾的表按它取，第三十六轮）
export function locate(mesh: Mesh, x: number, y: number, hint: number): { i: [number, number, number]; w: [number, number, number]; nearest: number; prov: number } {
  let nearest: number;
  if (mesh.kind === 'sphere') {
    const view = viewOf(mesh);
    nearest = locateSphere(view, findRadius2(view.delaunay), x, y, hint, sphereProvDel(mesh));
  } else nearest = locatePlane(mesh, findRadius2(mesh.delaunay), x, y, hint);
  return { i: [li[0], li[1], li[2]], w: [lw[0], lw[1], lw[2]], nearest, prov: located.prov };
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

// 着色器里的地表细节（沿坡向的冲沟 + 小起伏）的同一实现，供导出高度图使用
export function terrainDetail(x: number, y: number, h: number, gx: number, gy: number, spacing: number, land: boolean): number {
  if (!land) return Math.min(h + fbmSub((x / spacing) * 1.3, (y / spacing) * 1.3, 3) * 25, -2);
  return landDetail(x, y, h, gx, gy, spacing, fbmSub((x / spacing) * 1.7 + 5, (y / spacing) * 1.7 + 5, 4));
}

// 陆地部分；bumps 是起伏噪声 fbmSub((x / spacing) · 1.7 + 5, …, 4) 的值
function landDetail(x: number, y: number, h: number, gx: number, gy: number, spacing: number, bumps: number): number {
  const gm = Math.hypot(gx, gy);
  const relief = gm * spacing;
  const dx = gm > 1e-3 ? gx / gm : 1;
  const dy = gm > 1e-3 ? gy / gm : 0;
  const qx = (x * -dy + y * dx) / spacing;
  const qy = (x * dx + y * dy) / spacing;
  let g = 0;
  let a = 0.5;
  let fx = 4;
  let fy = 1.1;
  for (let k = 0; k < 3; k++) {
    g += a * (1 - Math.abs(vnoise(qx * fx + k * 7.3, qy * fy + 1.7)));
    a *= 0.5;
    fx *= 2;
    fy *= 2;
  }
  const gully = (g - 0.44) * relief * 0.55;
  return Math.max(h + gully + bumps * (14 + 0.05 * Math.max(h, 0)), 2);
}

// ---------- 栅格化逐像素用的噪声 ----------
// 与上面 coastDetail / warpOffset / terrainDetail（及三维版本）逐位相同，只是把只与列、只与行有关的部分
// （格点、插值系数、哈希的第一步）预先算好，逐像素不再新建数组

// 平面世界的一个 fbm 通道：fbmSub(列的 x 坐标, 行的 y 坐标, octaves)。
// 格子比像素宽的八度，先把这一行用到的格点值算成两排（下一行还在这排格点上就接着用），逐像素只查表
class SepFbm {
  private readonly W: number;
  private readonly octaves: number;
  // 按八度 × 列：插值系数、两侧格点 x 的 lcg、在格点排里的下标
  private readonly u: Float64Array;
  private readonly x0: Int32Array;
  private readonly x1: Int32Array;
  private readonly j: Int32Array;
  // 按八度：当前行的插值系数、两侧格点 y 的 lcg、格点 y
  private readonly v: Float64Array;
  private readonly y0: Int32Array;
  private readonly y1: Int32Array;
  private readonly iy: Float64Array;
  // 成排的八度：两排格点值（iy 与 iy + 1，各 span 个，从 ixMin 起）；其余为 null
  private readonly rows: (Float64Array | null)[] = [];
  private readonly ixMin: Float64Array;
  private readonly span: Int32Array;

  constructor(xs: Float64Array, octaves: number) {
    const W = xs.length;
    this.W = W;
    this.octaves = octaves;
    this.u = new Float64Array(octaves * W);
    this.x0 = new Int32Array(octaves * W);
    this.x1 = new Int32Array(octaves * W);
    this.j = new Int32Array(octaves * W);
    this.v = new Float64Array(octaves);
    this.y0 = new Int32Array(octaves);
    this.y1 = new Int32Array(octaves);
    this.iy = new Float64Array(octaves).fill(NaN);
    this.ixMin = new Float64Array(octaves);
    this.span = new Int32Array(octaves);
    const px = Float64Array.from(xs);
    const ix = new Float64Array(W);
    for (let k = 0; k < octaves; k++) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let c = 0; c < W; c++) {
        const i = Math.floor(px[c]);
        const fx = px[c] - i;
        this.u[k * W + c] = fx * fx * (3 - 2 * fx);
        this.x0[k * W + c] = lcg(i);
        this.x1[k * W + c] = lcg(i + 1);
        ix[c] = i;
        lo = Math.min(lo, i);
        hi = Math.max(hi, i);
        px[c] = px[c] * 2.03 + 17.1;
      }
      // 一排格点不到列数的两倍时成排算更省
      const span = hi - lo + 2;
      if (W > 0 && span < 2 * W) {
        this.rows.push(new Float64Array(2 * span));
        this.ixMin[k] = lo;
        this.span[k] = span;
        for (let c = 0; c < W; c++) this.j[k * W + c] = ix[c] - lo;
      } else this.rows.push(null);
    }
  }

  // 换行：y 是这一行第一个八度的坐标
  setRow(y: number) {
    let py = y;
    for (let k = 0; k < this.octaves; k++) {
      const iy = Math.floor(py);
      const fy = py - iy;
      this.v[k] = fy * fy * (3 - 2 * fy);
      const y0 = lcg(iy);
      const y1 = lcg(iy + 1);
      this.y0[k] = y0;
      this.y1[k] = y1;
      const row = this.rows[k];
      if (row && iy !== this.iy[k]) {
        const span = this.span[k];
        const lo = this.ixMin[k];
        // 往下挪了一排格点：原来的第二排成了第一排
        if (iy === this.iy[k] + 1) row.copyWithin(0, span, 2 * span);
        else for (let t = 0; t < span; t++) row[t] = unit(hashAB(lcg(lo + t), y0));
        for (let t = 0; t < span; t++) row[span + t] = unit(hashAB(lcg(lo + t), y1));
      }
      this.iy[k] = iy;
      py = py * 2.03 - 9.3;
    }
  }

  // 第 c 列的值
  at(c: number): number {
    const W = this.W;
    let s = 0;
    let amp = 0.5;
    for (let k = 0; k < this.octaves; k++) {
      const q = k * W + c;
      const u = this.u[q];
      const v = this.v[k];
      const row = this.rows[k];
      let a: number;
      let b: number;
      let cc: number;
      let d: number;
      if (row) {
        const j = this.j[q];
        const span = this.span[k];
        a = row[j];
        b = row[j + 1];
        cc = row[span + j];
        d = row[span + j + 1];
      } else {
        const x0 = this.x0[q];
        const x1 = this.x1[q];
        const y0 = this.y0[k];
        const y1 = this.y1[k];
        a = unit(hashAB(x0, y0));
        b = unit(hashAB(x1, y0));
        cc = unit(hashAB(x0, y1));
        d = unit(hashAB(x1, y1));
      }
      s += amp * ((a + (b - a) * u + (cc - a) * v + (a - b - cc + d) * u * v) * 2 - 1);
      amp *= 0.5;
    }
    return s;
  }
}

// 整个星球的一个 fbm 通道：fbmSub3(x, y, 行的 z 坐标, octaves)。z 只与行有关：各八度 z 的格点、插值系数、
// 哈希的第一步在行首算好。格子比像素宽得多的八度记住上一格八个角的值，相邻像素落在同一格就不再哈希
class RowFbm3 {
  private readonly octaves: number;
  // 各八度每单位球面长度有几个格（第一个八度是 freq）
  private readonly freq: Float64Array;
  private readonly w: Float64Array;
  private readonly z0: Int32Array;
  private readonly z1: Int32Array;
  private readonly mz0: Int32Array;
  private readonly mz1: Int32Array;
  // 这一行是否记住上一格（像素间距不到格宽的 0.35），以及记住的格点 x、y 与八个角
  private readonly keep: Uint8Array;
  private readonly kx: Float64Array;
  private readonly ky: Float64Array;
  private readonly cn: Float64Array;

  constructor(octaves: number, freq: number) {
    this.octaves = octaves;
    this.freq = new Float64Array(octaves);
    for (let k = 0, f = freq; k < octaves; k++, f *= 2.03) this.freq[k] = f;
    this.w = new Float64Array(octaves);
    this.z0 = new Int32Array(octaves);
    this.z1 = new Int32Array(octaves);
    this.mz0 = new Int32Array(octaves);
    this.mz1 = new Int32Array(octaves);
    this.keep = new Uint8Array(octaves);
    this.kx = new Float64Array(octaves);
    this.ky = new Float64Array(octaves);
    this.cn = new Float64Array(8 * (octaves + 1));
  }

  // 换行：z 是这一行第一个八度的坐标，step 是这一行相邻像素在单位球面上的间距
  setRow(z: number, step: number) {
    let pz = z;
    for (let k = 0; k < this.octaves; k++) {
      const iz = Math.floor(pz);
      const fz = pz - iz;
      this.w[k] = fz * fz * (3 - 2 * fz);
      const z0 = lcg(iz);
      const z1 = lcg(iz + 1);
      this.z0[k] = z0;
      this.z1[k] = z1;
      this.mz0[k] = Math.imul(z0, 1664525);
      this.mz1[k] = Math.imul(z1, 1664525);
      this.keep[k] = step * this.freq[k] < 0.35 ? 1 : 0;
      this.kx[k] = NaN;
      pz = pz * 2.03 + 5.7;
    }
  }

  at(x: number, y: number): number {
    let s = 0;
    let amp = 0.5;
    let px = x;
    let py = y;
    for (let k = 0; k < this.octaves; k++) {
      const ix = Math.floor(px);
      const iy = Math.floor(py);
      const fx = px - ix;
      const fy = py - iy;
      const u = fx * fx * (3 - 2 * fx);
      const v = fy * fy * (3 - 2 * fy);
      // 不记的八度用最后一格当临时位置
      const keep = this.keep[k] === 1;
      const o = keep ? 8 * k : 8 * this.octaves;
      if (!keep || ix !== this.kx[k] || iy !== this.ky[k]) {
        corners3(lcg(ix), lcg(ix + 1), lcg(iy), lcg(iy + 1), this.z0[k], this.mz0[k], this.z1[k], this.mz1[k], this.cn, o);
        if (keep) {
          this.kx[k] = ix;
          this.ky[k] = iy;
        }
      }
      s += amp * trilerp(this.cn, o, u, v, this.w[k]);
      px = px * 2.03 + 17.1;
      py = py * 2.03 - 9.3;
      amp *= 0.5;
    }
    return s;
  }
}

// 逐像素的噪声：海岸细节、地表细节、边界扭曲（写进 warpOut）。c 是列，行由 row(y) 切换
interface PixelNoise {
  row(y: number): void;
  coast(c: number): number;
  // 碎岛的噪声（fragNoise / fragNoise3）：只在建的时候说要（有破碎度）时才有
  frag(c: number): number;
  terrain(c: number, h: number, gx: number, gy: number, land: boolean): number;
  warp(c: number): void;
}

const warpOut = new Float64Array(2);

// 平面世界：与 coastDetail、terrainDetail、warpOffset 相同
class PlaneNoise implements PixelNoise {
  private readonly xs: Float64Array;
  private readonly spacing: number;
  private readonly f: number;
  private readonly coastN: SepFbm;
  private readonly warpX: SepFbm;
  private readonly warpY: SepFbm;
  private readonly bumps: SepFbm;
  private readonly sea: SepFbm;
  private readonly fragN: SepFbm | null;
  private y = 0;

  constructor(xs: Float64Array, spacing: number, frag: boolean) {
    this.xs = xs;
    this.spacing = spacing;
    const f = WARP_FREQ / spacing;
    this.f = f;
    this.coastN = new SepFbm(xs.map((x) => (x / spacing) * 2.1), 4);
    this.warpX = new SepFbm(xs.map((x) => x * f + 3.7), 3);
    this.warpY = new SepFbm(xs.map((x) => x * f), 3);
    this.bumps = new SepFbm(xs.map((x) => (x / spacing) * 1.7 + 5), 4);
    this.sea = new SepFbm(xs.map((x) => (x / spacing) * 1.3), 3);
    this.fragN = frag ? new SepFbm(xs.map((x) => (x / spacing) * FRAG_FREQ + FRAG_OFF[0]), 3) : null;
  }

  row(y: number) {
    const spacing = this.spacing;
    this.y = y;
    this.coastN.setRow((y / spacing) * 2.1);
    this.warpX.setRow(y * this.f);
    this.warpY.setRow(y * this.f - 5.1);
    this.bumps.setRow((y / spacing) * 1.7 + 5);
    this.sea.setRow((y / spacing) * 1.3);
    this.fragN?.setRow((y / spacing) * FRAG_FREQ + FRAG_OFF[1]);
  }

  coast(c: number) {
    return this.coastN.at(c);
  }

  frag(c: number) {
    return this.fragN!.at(c);
  }

  terrain(c: number, h: number, gx: number, gy: number, land: boolean) {
    if (!land) return Math.min(h + this.sea.at(c) * 25, -2);
    return landDetail(this.xs[c], this.y, h, gx, gy, this.spacing, this.bumps.at(c));
  }

  warp(c: number) {
    warpOut[0] = WARP_AMP * this.spacing * this.warpX.at(c);
    warpOut[1] = WARP_AMP * this.spacing * this.warpY.at(c);
  }
}

// 整个星球：与 coastDetail3、terrainDetail3、warpOffset3 相同。每列经度的三角函数只算一次，余纬的在行首算
class SphereNoise implements PixelNoise {
  private readonly spacing: number;
  private readonly k: number;
  private readonly kCoast: number;
  private readonly f: number;
  private readonly cosLon: Float64Array;
  private readonly sinLon: Float64Array;
  // 赤道上相邻像素的经度差（弧度）
  private readonly dLon: number;
  private readonly coastN: RowFbm3;
  private readonly warpX: RowFbm3;
  private readonly warpY: RowFbm3;
  private readonly bumps: RowFbm3;
  private readonly sea: RowFbm3;
  private readonly kFrag: number;
  private readonly fragN: RowFbm3 | null;
  // 当前行余纬的正弦、余弦
  private sc = 0;
  private cc = 0;

  constructor(xs: Float64Array, spacing: number, mapWidth: number, frag: boolean) {
    this.spacing = spacing;
    const k = noiseK(spacing);
    this.k = k;
    this.kCoast = noiseK(spacing) * 2.1;
    this.f = WARP_FREQ * noiseK(spacing);
    this.cosLon = xs.map((x) => Math.cos(Math.PI * (x - 1)));
    this.sinLon = xs.map((x) => Math.sin(Math.PI * (x - 1)));
    this.dLon = (Math.PI * mapWidth) / xs.length;
    this.coastN = new RowFbm3(4, this.kCoast);
    this.warpX = new RowFbm3(3, this.f);
    this.warpY = new RowFbm3(3, this.f);
    this.bumps = new RowFbm3(4, k * 1.7);
    this.sea = new RowFbm3(3, k * 1.3);
    this.kFrag = noiseK(spacing) * FRAG_FREQ;
    this.fragN = frag ? new RowFbm3(3, this.kFrag) : null;
  }

  row(y: number) {
    const colat = Math.PI * Math.min(1, Math.max(0, y));
    const sc = Math.sin(colat);
    const cc = Math.cos(colat);
    this.sc = sc;
    this.cc = cc;
    const step = sc * this.dLon;
    this.coastN.setRow(cc * this.kCoast, step);
    this.warpX.setRow(cc * this.f, step);
    this.warpY.setRow(cc * this.f, step);
    this.bumps.setRow(cc * this.k * 1.7 + 5, step);
    this.sea.setRow(cc * this.k * 1.3, step);
    this.fragN?.setRow(cc * this.kFrag + FRAG_OFF[2], step);
  }

  coast(c: number) {
    const k = this.kCoast;
    return this.coastN.at(this.sc * this.cosLon[c] * k, this.sc * this.sinLon[c] * k);
  }

  frag(c: number) {
    const k = this.kFrag;
    return this.fragN!.at(this.sc * this.cosLon[c] * k + FRAG_OFF[0], this.sc * this.sinLon[c] * k + FRAG_OFF[1]);
  }

  terrain(c: number, h: number, gx: number, gy: number, land: boolean) {
    const px = this.sc * this.cosLon[c];
    const py = this.sc * this.sinLon[c];
    const k = this.k;
    if (!land) return Math.min(h + this.sea.at(px * k * 1.3, py * k * 1.3) * 25, -2);
    return landDetail3(px, py, this.cc, this.cosLon[c], this.sinLon[c], this.sc, h, gx, gy, this.spacing, this.bumps.at(px * k * 1.7 + 5, py * k * 1.7 + 5));
  }

  warp(c: number) {
    const px = this.sc * this.cosLon[c];
    const py = this.sc * this.sinLon[c];
    const f = this.f;
    warpOut[0] = WARP_AMP * this.spacing * this.warpX.at(px * f + 3.7, py * f);
    warpOut[1] = WARP_AMP * this.spacing * this.warpY.at(px * f, py * f - 5.1);
  }
}

export interface Raster {
  width: number;
  height: number;
  land: Uint8Array;
  // 高程（m），含与屏幕一致的细节
  elevation: Float32Array;
  // 分类数据（省份、生态）取的格：坐标扭曲后的最近格，且陆海类别与像素一致
  cell: Int32Array;
  // 画成小湖群的水面的陆地像素（第三十四轮：格还是陆地，导出按湖画）；没有小湖群的世界里全是 0
  lakeDot: Uint8Array;
}

// 每隔这么多行报一次进度
const PROGRESS_ROWS = 16;

// onProgress（可选）：每隔几行报一次完成的比例（0–1），不影响结果
export function rasterizeWorld(world: World, width: number, height: number, onProgress?: (fraction: number) => void): Raster {
  const { mesh, causes, derived } = world;
  const s = shownCoastValues(world);
  const grad = new Float32Array(mesh.n * 2);
  {
    const h = new Float64Array(mesh.n);
    for (let i = 0; i < mesh.n; i++) h[i] = causes.land[i] ? Math.max(0, derived.elevation[i]) : 0;
    for (let i = 0; i < mesh.n; i++) {
      if (!causes.land[i]) continue;
      // 与 colors.ts 的 staticLayers 相同
      const [gx, gy] = gradient(mesh, h, i);
      grad[2 * i] = gx;
      grad[2 * i + 1] = gy;
    }
  }
  const out: Raster = { width, height, land: new Uint8Array(width * height), elevation: new Float32Array(width * height), cell: new Int32Array(width * height), lakeDot: new Uint8Array(width * height) };
  // 海岸类型（第三十四轮）：没有生成器时为 null，逐像素照旧
  const packed = landStyle(world);
  const st = new Float64Array(7);
  // 峡湾（第三十六轮）：按陆海淹到哪里
  const fjl = packed ? fjordData(world) : null;
  // 画面上的海岸场（小湖群按它判）
  const fd = packed ? displayCoast(world) : null;
  const stw = new Float64Array(7);
  const sp = mesh.spacing;
  const outLand = out.land;
  const outElev = out.elevation;
  const outCell = out.cell;
  const elev = derived.elevation;
  const landOf = causes.land;
  // 画成陆地、邻格里又没有陆地格的像素（破碎的陆地）取那一格离它最近的陆地省的格（第十四轮，与屏幕相同）
  const landCell = landPixelCells(world);
  // 破碎度（第十八轮）：没打碎过时为 null，逐像素照旧
  const frag = fragLand(world);
  const sphere = mesh.kind === 'sphere';
  const view = mesh.kind === 'sphere' ? viewOf(mesh) : null;
  const provDel = sphereProvDel(mesh);
  const dl = view ? view.delaunay : (mesh as PlaneMesh).delaunay;
  const r2 = findRadius2(dl);
  const xs = new Float64Array(width);
  for (let px = 0; px < width; px++) xs[px] = ((px + 0.5) / width) * mesh.width;
  const noise: PixelNoise = sphere ? new SphereNoise(xs, mesh.spacing, mesh.width, !!frag) : new PlaneNoise(xs, mesh.spacing, !!frag);
  let hint = 0;
  for (let py = 0; py < height; py++) {
    const y = ((py + 0.5) / height) * mesh.height;
    noise.row(y);
    for (let px = 0; px < width; px++) {
      const x = xs[px];
      const near = view ? locateSphere(view, r2, x, y, hint, provDel) : locatePlane(mesh as PlaneMesh, r2, x, y, hint);
      const prov = located.prov;
      hint = near;
      const a = li[0];
      const b = li[1];
      const c = li[2];
      const wa = lw[0];
      const wb = lw[1];
      const wc = lw[2];
      const sv = s[a] * wa + s[b] * wb + s[c] * wc;
      const h = elev[a] * wa + elev[b] * wb + elev[c] * wc;
      const weight = Math.min(1, Math.max(0, (1 - Math.max(wa, wb, wc)) * 2.2));
      if (packed) styleAt(packed, s, a, b, c, wa, wb, wc, st, prov);
      const nd = noise.coast(px);
      const det = weight * coastDetailAmp(world, Math.max(0, h)) * (packed ? styleDetail(st[4], st[2]) : 1) * nd;
      // 破碎的地方（fv > 0）按 fragCoast；别处与以前逐位相同
      const fv = frag ? frag[a] * wa + frag[b] * wb + frag[c] * wc : 0;
      let total = fv > 0 ? fragCoast(sv, det, fv, weight, noise.frag(px)) : sv + det;
      // 峡湾、沙坝（第三十四轮）；小湖群只标出来（格还是陆地）
      if (packed) {
        total = styledCoast(sphere, x, y, sp, total, sv, h, st, false, nd, fjl);
        // 小湖群按画面上的海岸场判（湖面取负、湖的高程取负的水深，与屏幕、悬停相同）：只在冰盖到过的陆地像素上算
        if (total > 0 && st[3] > 0 && fd) {
          const fc = fd.coast;
          const fe = fd.elevation;
          const hw = fe[a] * wa + fe[b] * wb + fe[c] * wc;
          const svw = fc[a] * wa + fc[b] * wb + fc[c] * wc;
          styleAt(fd.style!, fc, a, b, c, wa, wb, wc, stw, prov);
          const detw = weight * coastDetailAmp(world, Math.max(0, hw)) * styleDetail(stw[4], stw[2]) * nd;
          const fvw = fd.frag ? fd.frag[a] * wa + fd.frag[b] * wb + fd.frag[c] * wc : 0;
          let sw = fvw > 0 ? fragCoast(svw, detw, fvw, weight, noise.frag(px)) : svw + detw;
          sw = styledCoast(sphere, x, y, sp, sw, svw, hw, stw, false, nd, fd.fjord);
          if (sw > 0 && stw[3] > 0 && speckApply(sw, speckAt(sphere, x, y, sp, sw, hw, stw[3])) <= 0) out.lakeDot[py * width + px] = 1;
        }
      }
      const land = total > 0;
      const gx = grad[2 * a] * wa + grad[2 * b] * wb + grad[2 * c] * wc;
      const gy = grad[2 * a + 1] * wa + grad[2 * b + 1] * wb + grad[2 * c + 1] * wc;
      const p = py * width + px;
      outLand[p] = land ? 1 : 0;
      if (fv > 0) outElev[p] = land ? Math.max(noise.terrain(px, h, gx, gy, true), fragIsleHeight(total)) : noise.terrain(px, fragSeaDepth(h, fv), gx, gy, false);
      else outElev[p] = noise.terrain(px, h, gx, gy, land);
      // 分类：扭曲坐标下的最近格；陆海类别与像素不一致时换成最近的同类邻格
      noise.warp(px);
      const qx = x + warpOut[0];
      const qy = sphere ? Math.min(1, Math.max(0, y + warpOut[1])) : y + warpOut[1];
      // 扭曲后的点离最近格的中心足够近时 findCell 必定返回它（整个星球：与 mesh.locate 同样绕回经度）
      const near2 = sphere ? within(dl, r2, qx - 2 * Math.floor(qx / 2), qy, near) : within(dl, r2, qx, qy, near);
      let cell = near2 ? near : findCell(mesh, qx, qy, near);
      // 破碎的海格里画成陆地的像素（碎岛）归这一格（海省，第十八轮；与屏幕的 provCell 同一条规则）
      if ((landOf[cell] === 1) !== land && !(land && frag && frag[cell] > 0)) {
        cell = sameKindCell(mesh, landOf, land, cell, near, x, y);
        // 海上的像素永远不取陆地格（第十三轮）：窄的海湾里邻格都是陆地时，沿网格的相邻往外找最近的海格
        if (!land && landOf[cell] === 1) cell = nearestSeaCell(mesh, landOf, cell, x, y);
        else if (land && landOf[cell] !== 1 && landCell[cell] >= 0) cell = landCell[cell];
      }
      outCell[p] = cell;
    }
    if (onProgress && ((py + 1) % PROGRESS_ROWS === 0 || py === height - 1)) onProgress((py + 1) / height);
  }
  return out;
}

// 在最近格、扭曲后那一格的邻格、最近格的邻格里取离像素最近的同类格；都不同类时保持原格
function sameKindCell(mesh: Mesh, landOf: Uint8Array, land: boolean, cell: number, near: number, x: number, y: number): number {
  let best = -1;
  let bd = Infinity;
  let d = sameKindDist(mesh, landOf, land, near, x, y);
  if (d < bd) {
    bd = d;
    best = near;
  }
  for (let e = mesh.off[cell]; e < mesh.off[cell + 1]; e++) {
    d = sameKindDist(mesh, landOf, land, mesh.adj[e], x, y);
    if (d < bd) {
      bd = d;
      best = mesh.adj[e];
    }
  }
  for (let e = mesh.off[near]; e < mesh.off[near + 1]; e++) {
    d = sameKindDist(mesh, landOf, land, mesh.adj[e], x, y);
    if (d < bd) {
      bd = d;
      best = mesh.adj[e];
    }
  }
  return best >= 0 ? best : cell;
}

// 从格 start 起沿网格的相邻一圈圈往外找，第一圈里有海格时取离像素最近的那个；一直没有（没有海的世界）时保持原格
const SEA_SEARCH_RINGS = 64;
export function nearestSeaCell(mesh: Mesh, landOf: Uint8Array, start: number, x: number, y: number): number {
  const seen = new Set<number>([start]);
  let frontier = [start];
  for (let ring = 0; ring < SEA_SEARCH_RINGS && frontier.length; ring++) {
    const next: number[] = [];
    let best = -1;
    let bd = Infinity;
    for (const c of frontier) {
      for (let e = mesh.off[c]; e < mesh.off[c + 1]; e++) {
        const j = mesh.adj[e];
        if (seen.has(j)) continue;
        seen.add(j);
        next.push(j);
        const d = sameKindDist(mesh, landOf, false, j, x, y);
        if (d < bd || (d === bd && j < best)) {
          bd = d;
          best = j;
        }
      }
    }
    if (best >= 0) return best;
    frontier = next;
  }
  return start;
}

// 格 j 与像素同类时返回到像素的距离平方，不同类返回 Infinity（不参与比较）
function sameKindDist(mesh: Mesh, landOf: Uint8Array, land: boolean, j: number, x: number, y: number): number {
  if ((landOf[j] === 1) !== land) return Infinity;
  const dxj = mesh.kind === 'sphere' ? mesh.x[j] - x - 2 * Math.round((mesh.x[j] - x) / 2) : mesh.x[j] - x;
  return dxj ** 2 + (mesh.y[j] - y) ** 2;
}
