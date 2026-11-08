import { type Mesh, type PlaneMesh, findCell, gradient } from './mesh';
import { viewOf } from './sphere';
import { landPixelCells } from './island-types';
import { displayCoast } from './display';
import { styleDetail, fjordData, landStyle, speckApply, styleAt } from './coast-style';
import { sphereProvDel } from './fjords';
import type { World } from './world';
import { lcg, hashAB, unit, WARP_AMP, WARP_FREQ, corners3, trilerp, noiseK, landDetail3, landDetail } from './subcell-noise';
import { locateSphere, li, lw, located, findRadius2, within, locatePlane } from './subcell-locate';
import { shownCoastValues, coastDetailAmp, FRAG_FREQ, FRAG_OFF, fragCoast, fragIsleHeight, fragSeaDepth, fragLand, styledCoast, speckAt } from './subcell-coast';
export { hashU, vnoise, fbmSub, coastDetail, warpOffset, hashU3, vnoise3, fbmSub3, coastDetail3, warpOffset3, terrainDetail3, terrainDetail } from './subcell-noise';
export { located, locate } from './subcell-locate';
export { coastValues, shownCoastValues, coastValueAt, coastPatch, coastDetailAmp, FRAG_D_MAX, FRAG_D_MIN, FRAG_AMP, FRAG_G, FRAG_FREQ, FRAG_OFF, fragCoast, fragNoise, fragNoise3, fragIsleHeight, fragSeaDepth, fragValues, bytesHash, fragLand, styledCoast, speckAt, styleMayFlip, pointIsLand } from './subcell-coast';

// 格以下的细节：屏幕渲染（着色器里有一份同样的实现）与导出共用同一套整数哈希噪声和判定规则，
// 所以屏幕上看到的海岸、边界与导出的位图一致。
//   · 海岸：三角形内插值的“海岸值” + 噪声 × 权重；权重在格中心为 0，所以每个格的陆海与模拟完全一致
//   · 边界：按扭曲后的坐标找最近的格，省份与生态的边界是自然曲线而不是六边形

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
