import { type Mesh, type SphereMesh, findCell, gradient } from './mesh';
import { viewOf } from './sphere';
import { COAST_AMP, coastNoiseField, coastSeed } from './terrain';
import type { World } from './world';

// 格以下的细节：屏幕渲染（着色器里有一份同样的实现）与导出共用同一套整数哈希噪声和判定规则，
// 所以屏幕上看到的海岸、边界与导出的位图一致。
//   · 海岸：三角形内插值的“海岸值” + 噪声 × 权重；权重在格中心为 0，所以每个格的陆海与模拟完全一致
//   · 边界：按扭曲后的坐标找最近的格，省份与生态的边界是自然曲线而不是六边形

// 与 GLSL 版本逐位一致的 32 位整数哈希
export function hashU(x: number, y: number): number {
  let a = (Math.imul(x >>> 0, 1664525) + 1013904223) >>> 0;
  let b = (Math.imul(y >>> 0, 1664525) + 1013904223) >>> 0;
  a = (a + Math.imul(b, 1664525)) >>> 0;
  b = (b + Math.imul(a, 1664525)) >>> 0;
  a = (a ^ (a >>> 16)) >>> 0;
  b = (b ^ (b >>> 16)) >>> 0;
  a = (a + Math.imul(b, 1664525)) >>> 0;
  b = (b + Math.imul(a, 1664525)) >>> 0;
  a = (a ^ (a >>> 16)) >>> 0;
  b = (b ^ (b >>> 16)) >>> 0;
  return (a ^ b) >>> 0;
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
  const a = unit(hashU(ix, iy));
  const b = unit(hashU(ix + 1, iy));
  const c = unit(hashU(ix, iy + 1));
  const d = unit(hashU(ix + 1, iy + 1));
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
  let a = (Math.imul(x >>> 0, 1664525) + 1013904223) >>> 0;
  let b = (Math.imul(y >>> 0, 1664525) + 1013904223) >>> 0;
  let c = (Math.imul(z >>> 0, 1664525) + 1013904223) >>> 0;
  for (let r = 0; r < 2; r++) {
    a = (a + Math.imul(b, 1664525)) >>> 0;
    b = (b + Math.imul(c, 1664525)) >>> 0;
    c = (c + Math.imul(a, 1664525)) >>> 0;
    a = (a ^ (a >>> 16)) >>> 0;
    b = (b ^ (b >>> 16)) >>> 0;
    c = (c ^ (c >>> 16)) >>> 0;
  }
  return (a ^ b ^ c) >>> 0;
}

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
  const a = unit(hashU3(ix, iy, iz));
  const b = unit(hashU3(ix + 1, iy, iz));
  const c = unit(hashU3(ix, iy + 1, iz));
  const d = unit(hashU3(ix + 1, iy + 1, iz));
  const e = unit(hashU3(ix, iy, iz + 1));
  const f = unit(hashU3(ix + 1, iy, iz + 1));
  const g = unit(hashU3(ix, iy + 1, iz + 1));
  const h = unit(hashU3(ix + 1, iy + 1, iz + 1));
  const x00 = a + (b - a) * u;
  const x10 = c + (d - c) * u;
  const x01 = e + (f - e) * u;
  const x11 = g + (h - g) * u;
  const y0 = x00 + (x10 - x00) * v;
  const y1 = x01 + (x11 - x01) * v;
  return (y0 + (y1 - y0) * w) * 2 - 1;
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
  const gm = Math.hypot(gE, gS);
  const relief = gm * spacing;
  const lon = Math.PI * (x - 1);
  const colat = Math.PI * Math.min(1, Math.max(0, y));
  const e = [-Math.sin(lon), Math.cos(lon), 0];
  const sv = [Math.cos(colat) * Math.cos(lon), Math.cos(colat) * Math.sin(lon), -Math.sin(colat)];
  const de = gm > 1e-3 ? gE / gm : 1;
  const ds = gm > 1e-3 ? gS / gm : 0;
  const D = [de * e[0] + ds * sv[0], de * e[1] + ds * sv[1], de * e[2] + ds * sv[2]];
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
  if (nx > 0.02) g += nx * gullyPlane(py * k, pz * k, D[1], D[2]);
  if (ny > 0.02) g += ny * gullyPlane(pz * k, px * k, D[2], D[0]);
  if (nz > 0.02) g += nz * gullyPlane(px * k, py * k, D[0], D[1]);
  const gully = (g - 0.44) * relief * 0.55;
  const bumps = fbmSub3(px * k * 1.7 + 5, py * k * 1.7 + 5, pz * k * 1.7 + 5, 4) * (14 + 0.05 * Math.max(h, 0));
  return Math.max(h + gully + bumps, 2);
}

// 整个星球：点所在的显示三角形与重心坐标（三角网见 sphere.ts 的 viewOf）。
// 同一个三角形里对应同一格的角（极点那一行的影子点）权重合并，与着色器一致
function locateSphere(mesh: SphereMesh, x: number, y: number, hint: number): { i: [number, number, number]; w: [number, number, number]; nearest: number } {
  const view = viewOf(mesh);
  const xw = x - 2 * Math.floor(x / 2);
  const yc = Math.min(1, Math.max(0, y));
  const dl = view.delaunay;
  const nearV = dl.find(xw, yc, hint >= 0 && hint < view.cellOf.length ? hint : 0);
  const near = view.cellOf[nearV];
  const { triangles, halfedges, inedges } = dl;
  const tryTri = (t: number) => {
    const a = triangles[3 * t];
    const b = triangles[3 * t + 1];
    const c = triangles[3 * t + 2];
    const ax = view.x[a];
    const ay = view.y[a];
    const v0x = view.x[b] - ax;
    const v0y = view.y[b] - ay;
    const v1x = view.x[c] - ax;
    const v1y = view.y[c] - ay;
    const v2x = xw - ax;
    const v2y = yc - ay;
    const den = v0x * v1y - v1x * v0y;
    if (Math.abs(den) < 1e-18) return null;
    const wb = (v2x * v1y - v1x * v2y) / den;
    const wc = (v0x * v2y - v2x * v0y) / den;
    const wa = 1 - wb - wc;
    if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) return null;
    const ca = view.cellOf[a];
    let cb = view.cellOf[b];
    let cc = view.cellOf[c];
    let w: [number, number, number] = [wa, wb, wc];
    if (cb === ca) w = [w[0] + w[1], 0, w[2]];
    if (cc === ca) w = [w[0] + w[2], w[1], 0];
    else if (cc === cb && cb !== ca) w = [w[0], w[1] + w[2], 0];
    if (w[1] === 0) cb = ca;
    if (w[2] === 0) cc = cb === ca && w[1] === 0 ? ca : cb;
    return { i: [ca, cb, cc] as [number, number, number], w, nearest: near };
  };
  const around = (v: number) => {
    const e0 = inedges[v];
    if (e0 < 0) return null;
    let e = e0;
    for (let guard = 0; guard < 64; guard++) {
      const r = tryTri(Math.floor(e / 3));
      if (r) return r;
      const next = e % 3 === 2 ? e - 2 : e + 1;
      e = halfedges[next];
      if (e < 0 || e === e0) break;
    }
    return null;
  };
  const r = around(nearV);
  if (r) return r;
  // 退回：看最近点在 Delaunay 上的邻居
  for (const v of dl.neighbors(nearV)) {
    const r2 = around(v);
    if (r2) return r2;
  }
  return { i: [near, near, near], w: [1, 0, 0], nearest: near };
}

// 每格的“海岸值”：> 0 为陆地，与 causes.land 保持一致（含填掉的单格海洞）。
// 压缩到约 ±250 m：否则山地岛屿的格值相差几千米，海岸线几乎完全由线性插值决定，成了折线
export const COAST_SQUASH = 250;

export function coastValues(world: World): Float32Array {
  const { mesh, causes } = world;
  const coast = coastNoiseField(mesh, coastSeed(world));
  const amp = COAST_AMP * world.small.terrain.coastRoughness;
  const s = new Float32Array(mesh.n);
  for (let i = 0; i < mesh.n; i++) {
    const v = causes.landness[i] + amp * coast[i];
    const signed = causes.land[i] ? Math.max(v, 1) : Math.min(v, -1);
    s[i] = COAST_SQUASH * Math.tanh(signed / COAST_SQUASH);
  }
  return s;
}

// 格以下的海岸细节幅度（m）：山地海岸更曲折，平原海岸更平滑
export function coastDetailAmp(world: World, elevation: number): number {
  const rough = world.small.terrain.coastRoughness;
  const rugged = Math.min(1, Math.max(0, elevation / 1200));
  return COAST_AMP * rough * (0.55 + 0.9 * rugged);
}

// 点所在的 Delaunay 三角形与重心坐标；找不到（地图边缘外）时退回最近的格
export function locate(mesh: Mesh, x: number, y: number, hint: number): { i: [number, number, number]; w: [number, number, number]; nearest: number } {
  if (mesh.kind === 'sphere') return locateSphere(mesh, x, y, hint);
  const near = mesh.delaunay.find(x, y, hint);
  const { triangles, halfedges, inedges } = mesh.delaunay;
  const tryTri = (t: number) => {
    const a = triangles[3 * t];
    const b = triangles[3 * t + 1];
    const c = triangles[3 * t + 2];
    const ax = mesh.x[a];
    const ay = mesh.y[a];
    const v0x = mesh.x[b] - ax;
    const v0y = mesh.y[b] - ay;
    const v1x = mesh.x[c] - ax;
    const v1y = mesh.y[c] - ay;
    const v2x = x - ax;
    const v2y = y - ay;
    const den = v0x * v1y - v1x * v0y;
    if (Math.abs(den) < 1e-18) return null;
    const wb = (v2x * v1y - v1x * v2y) / den;
    const wc = (v0x * v2y - v2x * v0y) / den;
    const wa = 1 - wb - wc;
    if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) return null;
    return { i: [a, b, c] as [number, number, number], w: [wa, wb, wc] as [number, number, number], nearest: near };
  };
  // 先看与最近格相邻的三角形，再看邻居的
  const around = (v: number) => {
    const e0 = inedges[v];
    if (e0 < 0) return null;
    let e = e0;
    for (let guard = 0; guard < 32; guard++) {
      const r = tryTri(Math.floor(e / 3));
      if (r) return r;
      const next = e % 3 === 2 ? e - 2 : e + 1;
      e = halfedges[next];
      if (e < 0 || e === e0) break;
    }
    return null;
  };
  const r = around(near);
  if (r) return r;
  for (let e = mesh.off[near]; e < mesh.off[near + 1]; e++) {
    const r2 = around(mesh.adj[e]);
    if (r2) return r2;
  }
  return { i: [near, near, near], w: [1, 0, 0], nearest: near };
}

// 一个点是陆地还是海：与着色器的判定相同
export function pointIsLand(world: World, s: Float32Array, elevation: Float32Array, x: number, y: number, hint: number): { land: boolean; nearest: number; height: number } {
  const loc = locate(world.mesh, x, y, hint);
  const [a, b, c] = loc.i;
  const [wa, wb, wc] = loc.w;
  const sv = s[a] * wa + s[b] * wb + s[c] * wc;
  const h = elevation[a] * wa + elevation[b] * wb + elevation[c] * wc;
  const wmax = Math.max(wa, wb, wc);
  const weight = Math.min(1, (1 - wmax) * 2.2);
  const total = sv + weight * coastDetailAmp(world, Math.max(0, h)) * coastDetail(x, y, world.mesh.spacing);
  return { land: total > 0, nearest: loc.nearest, height: h };
}

// 着色器里的地表细节（沿坡向的冲沟 + 小起伏）的同一实现，供导出高度图使用
export function terrainDetail(x: number, y: number, h: number, gx: number, gy: number, spacing: number, land: boolean): number {
  if (!land) return Math.min(h + fbmSub((x / spacing) * 1.3, (y / spacing) * 1.3, 3) * 25, -2);
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
  const bumps = fbmSub((x / spacing) * 1.7 + 5, (y / spacing) * 1.7 + 5, 4) * (14 + 0.05 * Math.max(h, 0));
  return Math.max(h + gully + bumps, 2);
}

export interface Raster {
  width: number;
  height: number;
  land: Uint8Array;
  // 高程（m），含与屏幕一致的细节
  elevation: Float32Array;
  // 分类数据（省份、生态）取的格：坐标扭曲后的最近格，且陆海类别与像素一致
  cell: Int32Array;
}

export function rasterizeWorld(world: World, width: number, height: number): Raster {
  const { mesh, causes, derived } = world;
  const s = coastValues(world);
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
  const out: Raster = { width, height, land: new Uint8Array(width * height), elevation: new Float32Array(width * height), cell: new Int32Array(width * height) };
  const sphere = mesh.kind === 'sphere';
  let hint = 0;
  for (let py = 0; py < height; py++) {
    const y = ((py + 0.5) / height) * mesh.height;
    for (let px = 0; px < width; px++) {
      const x = ((px + 0.5) / width) * mesh.width;
      const loc = locate(mesh, x, y, hint);
      hint = loc.nearest;
      const [a, b, c] = loc.i;
      const [wa, wb, wc] = loc.w;
      const sv = s[a] * wa + s[b] * wb + s[c] * wc;
      const h = derived.elevation[a] * wa + derived.elevation[b] * wb + derived.elevation[c] * wc;
      const weight = Math.min(1, Math.max(0, (1 - Math.max(wa, wb, wc)) * 2.2));
      const detail = sphere ? coastDetail3(x, y, mesh.spacing) : coastDetail(x, y, mesh.spacing);
      const land = sv + weight * coastDetailAmp(world, Math.max(0, h)) * detail > 0;
      const gx = grad[2 * a] * wa + grad[2 * b] * wb + grad[2 * c] * wc;
      const gy = grad[2 * a + 1] * wa + grad[2 * b + 1] * wb + grad[2 * c + 1] * wc;
      const p = py * width + px;
      out.land[p] = land ? 1 : 0;
      out.elevation[p] = sphere ? terrainDetail3(x, y, h, gx, gy, mesh.spacing, land) : terrainDetail(x, y, h, gx, gy, mesh.spacing, land);
      // 分类：扭曲坐标下的最近格；陆海类别与像素不一致时换成最近的同类邻格
      const [wx, wy] = sphere ? warpOffset3(x, y, mesh.spacing) : warpOffset(x, y, mesh.spacing);
      let cell = findCell(mesh, x + wx, sphere ? Math.min(1, Math.max(0, y + wy)) : y + wy, loc.nearest);
      if ((causes.land[cell] === 1) !== land) {
        let best = -1;
        let bd = Infinity;
        const consider = (j: number) => {
          if ((causes.land[j] === 1) !== land) return;
          const dxj = sphere ? mesh.x[j] - x - 2 * Math.round((mesh.x[j] - x) / 2) : mesh.x[j] - x;
          const d = dxj ** 2 + (mesh.y[j] - y) ** 2;
          if (d < bd) {
            bd = d;
            best = j;
          }
        };
        consider(loc.nearest);
        for (let e = mesh.off[cell]; e < mesh.off[cell + 1]; e++) consider(mesh.adj[e]);
        for (let e = mesh.off[loc.nearest]; e < mesh.off[loc.nearest + 1]; e++) consider(mesh.adj[e]);
        if (best >= 0) cell = best;
      }
      out.cell[p] = cell;
    }
  }
  return out;
}
