// 格以下的噪声（第八十三轮从 core/subcell.ts 原样搬出）：与 GLSL 逐位一致的整数哈希、值噪声、分形、域扭曲、地形的细节；平面与球面两套

// 与 GLSL 版本逐位一致的 32 位整数哈希
export function hashU(x: number, y: number): number {
  return hashAB(lcg(x), lcg(y)) >>> 0;
}

// 哈希按有符号 32 位整数算（与 >>> 0 的写法逐位相同）。第一步 lcg 只与一个坐标有关，
// 一格的几个角、同一列 / 同一行的像素可以共用
export function lcg(v: number): number {
  return (Math.imul(v, 1664525) + 1013904223) | 0;
}

// 二维哈希的其余部分：a = lcg(x)，b = lcg(y)
export function hashAB(a: number, b: number): number {
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

export const unit = (h: number) => (h & 0xffffff) / 16777216;

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
export const WARP_AMP = 0.6;
export const WARP_FREQ = 0.9;
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
export function corners3(x0: number, x1: number, y0: number, y1: number, z0: number, mz0: number, z1: number, mz1: number, out: Float64Array, o: number) {
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
export function trilerp(cn: Float64Array, o: number, u: number, v: number, w: number): number {
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
export function sphereOf(x: number, y: number): [number, number, number] {
  const lon = Math.PI * (x - 1);
  const colat = Math.PI * Math.min(1, Math.max(0, y));
  const s = Math.sin(colat);
  return [s * Math.cos(lon), s * Math.sin(lon), Math.cos(colat)];
}

// 噪声的频率：一个噪声单位约是一格（单位球上格距是 spacing · π 弧度）
export const noiseK = (spacing: number) => 1 / (Math.PI * spacing);

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
export function landDetail3(px: number, py: number, pz: number, cl: number, sl: number, sc: number, h: number, gE: number, gS: number, spacing: number, bumps: number): number {
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

// 着色器里的地表细节（沿坡向的冲沟 + 小起伏）的同一实现，供导出高度图使用
export function terrainDetail(x: number, y: number, h: number, gx: number, gy: number, spacing: number, land: boolean): number {
  if (!land) return Math.min(h + fbmSub((x / spacing) * 1.3, (y / spacing) * 1.3, 3) * 25, -2);
  return landDetail(x, y, h, gx, gy, spacing, fbmSub((x / spacing) * 1.7 + 5, (y / spacing) * 1.7 + 5, 4));
}

// 陆地部分；bumps 是起伏噪声 fbmSub((x / spacing) · 1.7 + 5, …, 4) 的值
export function landDetail(x: number, y: number, h: number, gx: number, gy: number, spacing: number, bumps: number): number {
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
