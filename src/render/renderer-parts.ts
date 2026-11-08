// 渲染器共用的类型与小工具（第八十三轮从 src/render/renderer.ts 原样搬出）：编译、镜头、逐格的图层与打包、河的图层、投影的场景、场景目标、移动中的几个常数、格的范围、像素块
import { VS_QUAD } from './shaders/plane';
import { withoutFx } from './shaders/common';
import type { Proj } from './projection';
import type { SeamLayers } from '../../core/seams';
import type { Mesh } from '../../core/mesh';

// 合成程序：带花纹的编译不过时退回不带花纹的（见 withoutFx），只在控制台留一句
export function compileCompose(gl: WebGL2RenderingContext, fs: string): WebGLProgram {
  try {
    return compile(gl, VS_QUAD, fs);
  } catch (e) {
    console.warn('生态花纹的着色器编译不过，先不画花纹、发光：', e);
    return compile(gl, VS_QUAD, withoutFx(fs));
  }
}

export function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const make = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? '着色器编译失败');
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, make(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.bindAttribLocation(p, 1, 'aCell');
  gl.bindAttribLocation(p, 2, 'aBary');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? '着色器链接失败');
  return p;
}

export interface Camera {
  // 视图中心（地图单位）与缩放（像素 / 地图单位）
  x: number;
  y: number;
  zoom: number;
  // 整个星球的等面积、球形投影（第十三轮 G4）：镜头的 x、y 在投影平面上（见 projection.ts）；没有时是等距圆柱
  proj?: Proj;
}

// 高程纹理的一格：r 高程，g 水面的高程（水面格就是自己的高程；陆地格是挨着的水面里最浅的，没有给时 −2 m）。
// 陆海按海岸值（湖面 < 0）分
export function packElevation(out: Float32Array, elevation: Float32Array, coast: Float32Array, shore: Float32Array | null, from: number, to: number) {
  for (let i = from; i < to; i++) {
    out[2 * i] = elevation[i];
    out[2 * i + 1] = coast[i] <= 0 ? elevation[i] : shore ? shore[i] : -2;
  }
}

// 海岸值纹理的一格（第十八轮起两个通道，第三十四轮起四个：RGBA32F）：r 海岸值，g 破碎度（0–1，没有时 0），
// b、a 海岸类型与小湖群（core/display.ts 的 DisplayCoast.style、core/coast-style.ts 的 packed：b 峡湾或负的小湖群，a 沙坝；没有时 0）
export function packCoast(out: Float32Array, coast: Float32Array, frag: Float32Array | null | undefined, style: Float32Array | null | undefined, from: number, to: number) {
  for (let i = from; i < to; i++) {
    out[4 * i] = coast[i];
    out[4 * i + 1] = frag ? frag[i] : 0;
    out[4 * i + 2] = style ? style[2 * i] : 0;
    out[4 * i + 3] = style ? style[2 * i + 1] : 0;
  }
}

// 合成着色器的海岸值纹理（两个通道）：r 海岸值，g 破碎度
export function packCellCoast(out: Float32Array, coast: Float32Array, frag: Float32Array | null | undefined, from: number, to: number) {
  for (let i = from; i < to; i++) {
    out[2 * i] = coast[i];
    out[2 * i + 1] = frag ? frag[i] : 0;
  }
}

export interface CellLayers {
  // 平滑层颜色（alpha：陆地为“沙质”程度，海为海水暖度）
  smooth: Uint8Array;
  // 对岸的颜色：陆地格是相邻水面的颜色，水面格是相邻陆地的颜色（没有对岸就是自己的）
  other: Uint8Array;
  elevation: Float32Array;
  // 水面的高程（第十三轮修）：陆地格上是挨着它的水面格里最浅的高程（画水深、浅水只按水面，见 colors.ts 的 shoreElevation）；
  // 水面格上不用（照 elevation）。省略时陆地格按 −2 m
  shore?: Float32Array;
  coast: Float32Array;
  // 每格的破碎度（0–1，第十八轮，core/display.ts 的 displayCoast）；没打碎过时为 null
  frag?: Float32Array | null;
  // 海岸类型与小湖群（第三十四轮，core/display.ts 的 displayCoast 的 style，每格两个数）；省略、null 时没有
  style?: Float32Array | null;
  // 峡湾（第三十六轮，core/fjords.ts 的 fjordLayer 的 tex：RGBA，TEX_W 宽、整行）；省略、null 时没有
  fjord?: Float32Array | null;
  grad: Float32Array;
  // 海底的坡度（每格两个值，地图坐标；陆地、湖为 0）：海的晕渲。省略时没有
  seaGrad?: Float32Array;
  // 分类平涂（alpha = 覆盖度），null 不画
  flat: Uint8Array | null;
  // 分组（省份），画分组边界；每格两个值（分组编号、切线用的标记，见 colors.ts 的 provinceGroups）；null 不画
  group: Float32Array | null;
  // 剪刀切过的线（core/seams.ts）：切线附近按在线的哪一边换格；没有切线时为 null
  seams?: SeamLayers | null;
  // 国界的分组（第二十三轮，colors.ts 的 countryBorderGroups）：每格两个值；省略、null 不画
  countryGroup?: Float32Array | null;
  shade: number;
  rock: number;
  // 海面也是数据（第十四轮，海水温度底图）：着色器不给浅水加青绿、地图册画风不把海涂平，海面就是每格的颜色
  seaData?: boolean;
  coastAmp: number;
  // 岛的样子（colors.ts 的 lithLayer）：每格 RGBA 字节；省略时全是 0
  lith?: Uint8Array | null;
  // 破碎的陆地归哪一格的省（colors.ts 的 landCellLayer）：每格 RGBA 字节；省略时着色器照旧用那个水面格
  landCell?: Uint8Array | null;
  // 生态的花纹与发光（colors.ts 的 fxLayers）：每格 RGBA 字节与 256 行 × 3 纹素的调色板；没有时为 null（整段跳过）
  fx?: Uint8Array | null;
  fxPalette?: Float32Array | null;
  // 离边界远的格（第三十九轮，near.ts 的 nearLayer）：每格 RGBA 字节，r、g、b 是省份、国家、集团往外几步之内没有会与它连成线的格；省略、null 时不跳过
  near?: Uint8Array | null;
}
// 描格（第三十七轮）：离格心几格以内的像素才算 focusAt（描出的范围一块地区不过约 1.9 格，星球两极附近约 2.9 格，core/display-cell.test.ts 查）。
// 第八十六轮：测试的星球北极边上有了一个湖，湖面的像素离湖格约 3.4 格（两极附近按经纬度铺开的画面），3.2 → 3.7（测试留 0.25 格的余量）
export const FOCUS_REACH = 3.7;

// 河的图层（第十三轮，overlay.ts 的 riverLayer 画的）：一张预乘之前的 RGBA 画布，合成时只混进画成陆地的像素。
// version 变了才重新上传；toUv：地图单位 → 这张图上的位置（0–1，v 向上），u = x·a + b，v = y·c + d
export interface RiverTex {
  source: HTMLCanvasElement | OffscreenCanvas;
  version: number;
  toUv: [number, number, number, number];
}

export type V4 = [number, number, number, number];
// 一块像素（x, y, 宽, 高；GL 的 y 向上）
export type Rect = [number, number, number, number];

// 等面积、球形投影的场景（第十三轮 G4）：等距圆柱的一块 [x0, x1] × [y0, y1]（x 可以伸出 [0, 2)，整圈时是 [0, 2]），
// 每地图单位 zx、zy 个像素（东西、南北可以不同：看极点附近时东西方向不必那么密），W × H 像素。
// reqZx、reqZy：按需要的密度要的（受纹理大小、像素总数所限，实际的 zx、zy 可能小一些）。view：地图单位 → 场景的裁剪空间
export interface ProjScene {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  zx: number;
  zy: number;
  reqZx: number;
  reqZy: number;
  W: number;
  H: number;
  view: V4;
  full: boolean;
  // 极地的场景（1 北极、−1 南极，见 projection.ts 的 SceneNeed）：x0..x1、y0..y1 是以极点为中心的平面上的范围
  pole: 0 | 1 | -1;
  key: string;
}

// 投影时的河的图层要画的那一块（场景的范围、密度，像素）；dpr：每个 CSS 像素几个像素（河宽按 CSS 像素算）
export interface RiverScene {
  x0: number;
  y0: number;
  zx: number;
  zy: number;
  W: number;
  H: number;
  dpr: number;
  pole: 0 | 1 | -1;
  key: string;
}

export interface ProjCompose {
  proj: Proj;
  scene: ProjScene;
  // 一个平面单位合几个画面像素；投影之外的颜色（屏幕上是背景色，导出时透明）
  planePx: number;
  outside: V4;
}

// 极地的场景：一极的三角形、Voronoi（见 Renderer.polarGeometry）；只画离那一极这么远（地图单位，到极点的弧长 / π）以内的
export type PolarGeom = { tri: WebGLVertexArrayObject; triCount: number; fan: WebGLVertexArrayObject; fanCount: number };
export const POLAR_REACH = 0.95;

// 屏幕上投影之外的背景（与地图之外的颜色相同）
export const PROJ_BG: V4 = [0.08, 0.1, 0.14, 1];

// 按需要的密度定一块场景。factor：密度打几折（移动中 0.5）；grow：四周多画范围的几分之一（整圈时不加）；
// limit：纹理的边长上限；budget：像素总数上限
export function planScene(need: { x0: number; x1: number; y0: number; y1: number; zx: number; zy: number; full: boolean; pole?: 0 | 1 | -1 }, factor: number, grow: number, limit: number, budget: number): ProjScene {
  const pole = need.pole ?? 0;
  // 密度取 2 的 1/4 次方的整数倍（往上取）：镜头动一点点时要的密度不变，场景照用
  const q = (z: number) => Math.pow(2, Math.ceil(Math.log2(Math.max(z, 1e-9)) * 4) / 4);
  const reqZx = q(need.zx * factor);
  const reqZy = q(need.zy * factor);
  let { x0, x1, y0, y1 } = need;
  let full = need.full;
  if (pole) {
    // 极地：以极点为中心的正方形，四周一样多画，半径不超过 1（另一极）
    const R = Math.min(POLAR_REACH, Math.max(x1, x1 * (1 + grow)));
    x0 = y0 = -R;
    x1 = y1 = R;
  } else if (!full) {
    const gx = (x1 - x0) * grow;
    x0 -= gx;
    x1 += gx;
    if (x1 - x0 >= 2) {
      full = true;
      x0 = 0;
      x1 = 2;
    }
  }
  if (!pole) {
    const gy = (y1 - y0) * grow;
    y0 = Math.max(0, y0 - gy);
    y1 = Math.min(1, y1 + gy);
  }
  const s = Math.min(1, limit / ((x1 - x0) * reqZx), limit / ((y1 - y0) * reqZy), Math.sqrt(budget / ((x1 - x0) * reqZx * (y1 - y0) * reqZy)));
  const zx = reqZx * s;
  const zy = reqZy * s;
  const W = Math.max(1, Math.min(limit, Math.ceil((x1 - x0) * zx)));
  const H = Math.max(1, Math.min(limit, Math.ceil((y1 - y0) * zy)));
  // 按整像素取了整：右、下边跟着挪（密度不变）
  x1 = x0 + W / zx;
  y1 = y0 + H / zy;
  const sx = (2 * zx) / W;
  const sy = (-2 * zy) / H;
  return { x0, x1, y0, y1, zx, zy, reqZx, reqZy, W, H, view: [sx, sy, -1 - x0 * sx, 1 - y0 * sy], full, pole, key: `${pole}|${x0}|${x1}|${y0}|${y1}|${zx}|${zy}|${W}x${H}` };
}

// 场景 sc 还能不能用：盖住要的范围（整圈的盖住一切；x 按 2 绕回比），要的密度够（minF 折以上），停稳时也不能密太多（maxF 倍以下）
export function sceneFits(sc: ProjScene, need: { x0: number; x1: number; y0: number; y1: number; zx: number; zy: number; pole?: 0 | 1 | -1 }, minF: number, maxF: number): boolean {
  if (sc.pole !== (need.pole ?? 0)) return false;
  if (sc.reqZx < minF * need.zx || sc.reqZy < minF * need.zy) return false;
  if (sc.reqZx > maxF * need.zx && sc.reqZy > maxF * need.zy) return false;
  if (need.y0 < sc.y0 - 1e-9 || need.y1 > sc.y1 + 1e-9) return false;
  if (sc.full) return true;
  if (sc.pole) return need.x0 >= sc.x0 - 1e-9 && need.x1 <= sc.x1 + 1e-9;
  const sh = 2 * Math.floor((need.x0 - sc.x0) / 2);
  return need.x0 - sh >= sc.x0 - 1e-9 && need.x1 - sh <= sc.x1 + 1e-9 && need.x1 - need.x0 <= 2;
}

// 一组场景目标：地形层（颜色、高度）、编号层、切线层（带深度）
export interface SceneTarget {
  w: number;
  h: number;
  fbo: WebGLFramebuffer;
  fboId: WebGLFramebuffer;
  fboSeam: WebGLFramebuffer;
  color: WebGLTexture;
  height: WebGLTexture;
  id: WebGLTexture;
  seam: WebGLTexture;
  depth: WebGLRenderbuffer;
}

// 镜头停下多久以后按停稳的画法（全分辨率）补画一帧（毫秒）：触控板平移中间的小停顿不算停下
export const SETTLE_MS = 250;
// 移动中：场景、合成按画布的几分之一分辨率画；场景四周各多画画面宽高的几分之一（平移时挪用）；
// 放大到场景画的时候的几倍以内照样挪用（再大就太糊，重画）
export const MOTION_SCALE = 0.5;
export const MOTION_MARGIN = 0.35;
export const MOTION_MAX_ZOOM_IN = 1.3;

// 每格的三角形（地形层）在地图上伸到多远：相对格中心的 minDx, maxDx, minDy, maxDy。
// 整个星球的显示网格里，接缝外的影子三角形按离格最近的那一份算（经度差挪到 ±1 以内）
export function cellBoxes(mesh: Mesh, tp: Float32Array, tc: Float32Array, sphere: boolean): Float32Array {
  const box = new Float32Array(mesh.n * 4);
  for (let t = 0; t + 2 < tc.length; t += 3) {
    const xa = tp[2 * t];
    const xb = tp[2 * t + 2];
    const xc = tp[2 * t + 4];
    const ya = tp[2 * t + 1];
    const yb = tp[2 * t + 3];
    const yc = tp[2 * t + 5];
    const minX = Math.min(xa, xb, xc);
    const maxX = Math.max(xa, xb, xc);
    const minY = Math.min(ya, yb, yc);
    const maxY = Math.max(ya, yb, yc);
    for (let k = 0; k < 3; k++) {
      const c = tc[t + k];
      const cx = mesh.x[c];
      const cy = mesh.y[c];
      const shift = sphere ? 2 * Math.round(((minX + maxX) / 2 - cx) / 2) : 0;
      box[4 * c] = Math.min(box[4 * c], minX - shift - cx);
      box[4 * c + 1] = Math.max(box[4 * c + 1], maxX - shift - cx);
      box[4 * c + 2] = Math.min(box[4 * c + 2], minY - cy);
      box[4 * c + 3] = Math.max(box[4 * c + 3], maxY - cy);
    }
  }
  return box;
}

// 一块地图（设备像素的范围，GL 的 y 向上）→ 画面上的一块：四周多 3 个像素，边落在偶数上，夹在画面之内；空的不要
export function pixelRect(x0: number, x1: number, y0: number, y1: number, w: number, h: number): Rect[] {
  const l = Math.max(0, 2 * Math.floor((Math.min(x0, x1) - 3) / 2));
  const r = Math.min(w, 2 * Math.ceil((Math.max(x0, x1) + 3) / 2));
  const b = Math.max(0, 2 * Math.floor((Math.min(y0, y1) - 3) / 2));
  const t = Math.min(h, 2 * Math.ceil((Math.max(y0, y1) + 3) / 2));
  return r > l && t > b ? [[l, b, r - l, t - b]] : [];
}

// 几块合并：两块的外接矩形不比两块加起来大时合成一块（鼠标跨到旁边一格时新旧两块大半重叠）
export function mergeRects(list: Rect[]): Rect[] {
  const out = list.slice();
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      for (let j = i + 1; j < out.length && !merged; j++) {
        const a = out[i];
        const b = out[j];
        const l = Math.min(a[0], b[0]);
        const bt = Math.min(a[1], b[1]);
        const r = Math.max(a[0] + a[2], b[0] + b[2]);
        const t = Math.max(a[1] + a[3], b[1] + b[3]);
        if ((r - l) * (t - bt) > a[2] * a[3] + b[2] * b[3]) continue;
        out[i] = [l, bt, r - l, t - bt];
        out.splice(j, 1);
        merged = true;
      }
    }
  }
  return out;
}
