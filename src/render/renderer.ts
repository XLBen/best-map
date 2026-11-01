import { FALLBACK_MAP_STYLE, type MapStyle, mapStyleKey, styleRgba } from '../../core/map-style';
import type { CellFocus } from '../../core/display';
import type { Mesh } from '../../core/mesh';
import type { SeamLayers } from '../../core/seams';
import { fromUnit } from '../../core/geo';
import { viewOf } from '../../core/sphere';
import type { GhostLayers } from './colors';
import { nearLayerSteps, nearRhoStep } from './near';
import type { Perf } from './perf';
import { effectiveZoom, planeBounds, type Proj, sceneNeed, screenToWorld as projScreenToWorld, worldToScreen as projWorldToScreen } from './projection';
import { TEX_W, withoutFx } from './shaders/common';
import { FS_COMPOSE } from './shaders/compose';
import { FS_ID, FS_SEAM, FS_TERRAIN, VS_CELL, VS_ID, VS_QUAD, VS_SEAM } from './shaders/plane';
import { FS_COMPOSE_PLANET, FS_COMPOSE_PROJ, FS_TERRAIN_PLANET, FS_TERRAIN_POLAR, VS_CELL_PLANET, VS_CELL_POLAR, VS_ID_PLANET, VS_ID_POLAR, VS_SEAM_POLAR } from './shaders/sphere';

// WebGL2 渲染：
//   1. 编号层：Voronoi 多边形写入每个像素属于哪一格
//   2. 地形层：Delaunay 三角形（不共享顶点，带重心坐标）。颜色、高程、海岸值、坡度在三角形内插值；
//      格以下补海岸细节与沿坡向的冲沟纹理（噪声在格中心为 0，陆海与模拟一致）→ 离屏的颜色、高度、坡度。
//      陆地像素只用陆色、水面像素只用水色（每格另带一份“对岸的颜色”），颜色不跨海岸互相渗；
//      晕渲的大尺度坡度用插值后的格坡度，没有三角形折面；海岸线在这里画成抗锯齿的细线
//   3. 切线层：剪刀切省时画的线（core/seams.ts）。每段一个长方形，像素写入离它最近的那一段与在线的哪一边
//      （深度 = 距离 / 带宽，近的胜）
//   4. 合成：晕渲、陡坡露岩、两种风格；按扭曲后的坐标取格，画分类平涂（主导生态、省份）、
//      分组边界（省份）、高亮与轮廓。边界因此是自然的曲线而不是六边形；切线附近按在线的哪一边换格，省界就是画的线
// 1、2 只在镜头、图层、窗口大小变了时重画，3 另外在切线变了时重画；鼠标移动、高亮变化只重画合成层。
// 海岸噪声与 core/subcell.ts 逐位一致，导出的位图与屏幕一致。
// 着色器源码在 shaders/（第四十一轮拆出来）：common 片段、plane 平面的程序、compose 合成、sphere 星球 / 极地 / 投影

// 合成程序：带花纹的编译不过时退回不带花纹的（见 withoutFx），只在控制台留一句
function compileCompose(gl: WebGL2RenderingContext, fs: string): WebGLProgram {
  try {
    return compile(gl, VS_QUAD, fs);
  } catch (e) {
    console.warn('生态花纹的着色器编译不过，先不画花纹、发光：', e);
    return compile(gl, VS_QUAD, withoutFx(fs));
  }
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
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

export type { MapStyle } from '../../core/map-style';

// 画风（第三十八轮）在合成着色器里的 uniform：颜色按 r / 255 上传（float32 与第三十七轮写在着色器里的常数逐位相同，测试查）。
// 按画风对象记住，每帧只上传
export interface StyleUniforms {
  landTint: Float32Array;
  shadeTint: number;
  shadeDark: Float32Array;
  shadeLight: Float32Array;
  seaTiers: number;
  seaTier: Float32Array;
  seaDepth: Float32Array;
  isobath: Float32Array;
  seaShade: Float32Array;
  tierShade: Float32Array;
  glowGain: number;
  coastLine: Float32Array;
  provLine: Float32Array;
  countryLine: Float32Array;
}
const styleUniformCache = new WeakMap<object, StyleUniforms>();
const unitRgb = (c: string): number[] => {
  const v = styleRgba(c) ?? [0, 0, 0, 1];
  return [v[0] / 255, v[1] / 255, v[2] / 255];
};
// 明暗 x + y · shade：y 是“海的明暗”，x = 1 − y（在 JS 里按双精度减，与以前写的 0.86、0.94 一样）
const shadePair = (k: number) => new Float32Array([1 - k, k]);
export function styleUniforms(style: MapStyle): StyleUniforms {
  let u = styleUniformCache.get(style);
  if (!u) {
    u = {
      landTint: new Float32Array([...unitRgb(style.landTint), style.landTintAmount]),
      shadeTint: style.landShade === 'tinted' ? 1 : 0,
      shadeDark: new Float32Array(unitRgb(style.shadeDark)),
      shadeLight: new Float32Array(unitRgb(style.shadeLight)),
      seaTiers: style.sea === 'tiers' ? 1 : 0,
      seaTier: new Float32Array([style.tier1, style.tier2, style.tier3, style.tier4].flatMap(unitRgb)),
      seaDepth: new Float32Array([style.depth2, style.depth3, style.depth4]),
      isobath: new Float32Array([...unitRgb(style.isobath), style.isobathAmount]),
      seaShade: shadePair(style.seaShade),
      tierShade: shadePair(style.tierShade),
      glowGain: style.glow,
      coastLine: new Float32Array([...unitRgb(style.coastLine), style.coastAmount]),
      provLine: new Float32Array(unitRgb(style.provinceLine)),
      countryLine: new Float32Array(unitRgb(style.countryLine)),
    };
    styleUniformCache.set(style, u);
  }
  return u;
}
// 描格（第三十七轮）：离格心几格以内的像素才算 focusAt（描出的范围一块地区不过约 1.9 格，星球两极附近约 2.9 格，core/display-cell.test.ts 查）
export const FOCUS_REACH = 3.2;

// 河的图层（第十三轮，overlay.ts 的 riverLayer 画的）：一张预乘之前的 RGBA 画布，合成时只混进画成陆地的像素。
// version 变了才重新上传；toUv：地图单位 → 这张图上的位置（0–1，v 向上），u = x·a + b，v = y·c + d
export interface RiverTex {
  source: HTMLCanvasElement | OffscreenCanvas;
  version: number;
  toUv: [number, number, number, number];
}

type V4 = [number, number, number, number];
// 一块像素（x, y, 宽, 高；GL 的 y 向上）
type Rect = [number, number, number, number];

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

interface ProjCompose {
  proj: Proj;
  scene: ProjScene;
  // 一个平面单位合几个画面像素；投影之外的颜色（屏幕上是背景色，导出时透明）
  planePx: number;
  outside: V4;
}

// 极地的场景：一极的三角形、Voronoi（见 Renderer.polarGeometry）；只画离那一极这么远（地图单位，到极点的弧长 / π）以内的
type PolarGeom = { tri: WebGLVertexArrayObject; triCount: number; fan: WebGLVertexArrayObject; fanCount: number };
const POLAR_REACH = 0.95;

// 屏幕上投影之外的背景（与地图之外的颜色相同）
const PROJ_BG: V4 = [0.08, 0.1, 0.14, 1];

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
interface SceneTarget {
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
const MOTION_SCALE = 0.5;
const MOTION_MARGIN = 0.35;
const MOTION_MAX_ZOOM_IN = 1.3;

// 每格的三角形（地形层）在地图上伸到多远：相对格中心的 minDx, maxDx, minDy, maxDy。
// 整个星球的显示网格里，接缝外的影子三角形按离格最近的那一份算（经度差挪到 ±1 以内）
function cellBoxes(mesh: Mesh, tp: Float32Array, tc: Float32Array, sphere: boolean): Float32Array {
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

export class Renderer {
  private gl: WebGL2RenderingContext;
  private progId: WebGLProgram;
  private progTerrain: WebGLProgram;
  private progCompose: WebGLProgram;
  private progSeam: WebGLProgram;
  // 整个星球用的三个程序（第一次遇到星球时才编译）
  private planetProgs: { id: WebGLProgram; terrain: WebGLProgram; compose: WebGLProgram } | null = null;
  private planet = false;
  // 星球几何在 x 方向上的范围（含接缝外的一点），用来算要画哪几份副本
  private xRange: [number, number] = [0, 2];
  private triVao: WebGLVertexArrayObject | null = null;
  private triCount = 0;
  private fanVao: WebGLVertexArrayObject | null = null;
  private fanCount = 0;
  private tex: Record<'color' | 'other' | 'elev' | 'coast' | 'cellCoast' | 'grad' | 'seaGrad' | 'flat' | 'highlight' | 'group' | 'segData' | 'fx' | 'fxPal' | 'tint' | 'river' | 'lith' | 'landCell' | 'country' | 'fj' | 'near', WebGLTexture>;
  // 河的图层：每帧问一次（参数：这一帧是不是按移动中的样子取；投影时另给场景的那一块），null 不画河。现在上传着的是哪一张、哪个版本
  riverLayer: ((motion: boolean, scene?: RiverScene) => RiverTex | null) | null = null;
  // 等面积、球形投影（第十三轮 G4）：场景目标（用到时才分配）、现在的场景，与各层画的是哪个键（同停稳的那几个）
  private projT: SceneTarget | null = null;
  private projScene: ProjScene | null = null;
  private pIdKey = '';
  private pTerrainKey = '';
  private pTerrainStatic = '';
  private pSeamKey = '';
  private pComposeKey = '';
  private progProj: WebGLProgram | null = null;
  // 极地的场景：程序（用到时才编译）与球面上真实的三角形、Voronoi（按网格缓存）
  private polarProgs: { id: WebGLProgram; terrain: WebGLProgram; seam: WebGLProgram } | null = null;
  private polarGeom: { mesh: Mesh; north: PolarGeom | null; south: PolarGeom | null } | null = null;
  private riverShown: { source: unknown; version: number } | null = null;
  // 场景（编号层、地形层、切线层）：停稳时画在与画布一样大的一组目标上；移动中画在低分辨率、带边距的另一组上
  private rest: SceneTarget;
  private moving: SceneTarget;
  // 移动中的合成画面（低分辨率），画好后放大拷到画布上
  private out: { fbo: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number };
  // 切线：每段一个实例（两端、前后两段的端点、前后有没有段）。setLayers 给的与现在显示的（剪刀拖动时多一条）
  private seamVao: WebGLVertexArrayObject;
  private seamBuf: WebGLBuffer;
  private seamCount = 0;
  private seamBand = 0;
  private seamX: [number, number] = [0, 0];
  private seamsBase: SeamLayers | null = null;
  private seamsShown: SeamLayers | null = null;
  private seamVersion = 0;
  private seamKey = '';
  private mesh: Mesh | null = null;
  private hasFlat = false;
  private hasGroup = false;
  private hasLandCell = false;
  private hasCountry = false;
  private hasHighlight = false;
  private shade = 1;
  private rock = 1;
  // 海面也是数据（海水温度底图）：见 CellLayers.seaData
  private seaData = false;
  private coastAmp = 180;
  // 画风（第三十八轮）：世界在用的那一种（core/map-style.ts 的 worldMapStyle）
  style: MapStyle = FALLBACK_MAP_STYLE;
  detail = 1;
  // 平涂是省份着色、高亮是省份工具的：切线附近也按换过的格取（否则按像素自己的格）
  flatByGroup = false;
  // 省界的浓淡（0–1，国家、文化等地图模式里淡一些）
  provinceAlpha = 1;
  // 国界的浓淡（第二十五轮：文化等地图模式里细而淡）
  countryAlpha = 1;
  highlightByGroup = false;
  camera: Camera = { x: 1, y: 0.5, zoom: 500 };
  // 晕渲的夸张倍数（全图时）：真实的山坡很缓，不夸张就看不出起伏
  relief = 24;
  // 每个省大约几格宽（√ 省份格数的中位数，MapView 在省份变了时算）：缩小时省界按它淡出
  provinceScale = 1;
  // 场景（编号层、地形层）与合成画面的版本：没变就不重画
  private layersVersion = 0;
  private highlightVersion = 0;
  // 描格（第三十七轮，setFocus）：鼠标下的格、钉住的格与它们的键
  private focus: [CellFocus | null, CellFocus | null] = [null, null];
  private focusKey = '|';
  private meshVersion = 0;
  // 停稳的编号层、地形层画的是哪个键：编号层只看网格、画布、镜头；地形层另看图层、细节、海岸幅度
  private idKey = '';
  private terrainKey = '';
  private terrainStatic = '';
  // 地形层自上次画完后哪些格的输入变了（幽灵海岸：只重画这些格所在的那一块）；'full' 整张重画
  private dirtyCells: 'full' | Set<number> = 'full';
  // 每格的三角形（地形层）在地图上伸到多远（相对格中心：minDx, maxDx, minDy, maxDy），算重画哪一块用
  private cellBox: Float32Array | null = null;
  private composeKey = '';
  // 移动中（镜头在 SETTLE_MS 之内动过）：低分辨率画、平移时挪用带边距的场景。lastCam 是上一帧的镜头，movedAt 是它最后一次变的时候
  private lastCam = '';
  private movedAt = -Infinity;
  // 移动中的场景是按哪个镜头、哪些输入画的（同样的输入、镜头还在边距之内就不重画）
  private movingScene: { cam: Camera; key: string } | null = null;
  // 移动中的场景每重画一次加一：叠加层的河、地名在同一帧跟着重画（几样缓存同时重建，卡一下而不是先后卡几下）
  motionEpoch = 0;
  // 这一帧是停下后补画的第一帧（停稳的画法）：叠加层这一帧先照移动中的样子贴，下一帧再按停稳的画（两样重活分在两帧）
  justSettled = false;
  private wasMoving = false;
  // 分组、平涂：setLayers 给的底子与现在显示的（省份预览覆盖时不同）。换预览时只上传变了的行
  private groupBase: Float32Array | null = null;
  private groupShown: Float32Array | null = null;
  private flatBase: Uint8Array | null = null;
  private flatShown: Uint8Array | null = null;
  private groupVersion = 0;
  // 幽灵海岸（colors.ts 的 GhostBuffer）：setLayers 给的底子，现在显示着幽灵的那些行，幽灵的海岸细节幅度
  private base: CellLayers | null = null;
  private ghostRows: number[] = [];
  private ghostCells: number[] = [];
  private ghostAmp: number | null = null;
  private ghostGroup: Float32Array | null = null;
  private ghostFlat: Uint8Array | null = null;
  // 生态的花纹与发光：setLayers 给的，与现在显示的（拖花纹、发光滑块时主线程上换的）
  private fxBase: { fx: Uint8Array | null; palette: Float32Array | null } = { fx: null, palette: null };
  private fxShown: { fx: Uint8Array | null; palette: Float32Array | null } = { fx: null, palette: null };
  private fxVersion = 0;
  // 湖泊类型的颜色（colors.ts 的 lakeTintLayer）：没有时为 null（着色器整段跳过）
  private tintShown: Uint8Array | null = null;
  private tintVersion = 0;
  // uniform 的位置按程序记住（第三十九轮：以前每合成一次调约 70 次 getUniformLocation）
  private locs = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  // 每张逐格的纹理现在传上去的是哪几个数组（setLayers 按对象是不是同一个来上传，第三十九轮）；
  // 幽灵海岸、省份预览只改了几行的记成 null（下一次 setLayers 整张重传）
  private shownDeps: Record<string, unknown[] | null> = {};
  // 只有合成读的那几层（平涂、分组、国界、花纹、landCell、离边界远的格、晕渲的强弱）的版本：进合成的键，不重画地形层
  private modeVersion = 0;
  // 离边界远的格（第三十九轮，near.ts）：传上去的那一份（null 没有），与这张网格的 ρ（空闲时算，没算好时 null）
  private nearShown: Uint8Array | null = null;
  private nearRho: Float32Array | null = null;
  private rhoTimer: ReturnType<typeof setTimeout> | null = null;
  // 按图层对象记住算过的离边界远的格（同一个对象：MapView 按模式缓存着拼好的图层），与还没算的那一次
  private nearMemo = new WeakMap<CellLayers, Uint8Array>();
  private nearTimer: ReturnType<typeof setTimeout> | null = null;
  // 描格（第三十七轮）那一遍（第三十九轮）：画布上现在描的是哪一个键、描在哪几块（停稳的与投影的各一份）
  private focusDrawn = { key: '', rects: [] as Rect[] };
  // 测速（第三十九轮，perf.ts；网址带 ?perf 时 MapView 给）
  perf: Perf | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('浏览器不支持 WebGL2');
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('浏览器不支持浮点渲染目标（EXT_color_buffer_float）');
    this.gl = gl;
    this.progId = compile(gl, VS_ID, FS_ID);
    this.progTerrain = compile(gl, VS_CELL, FS_TERRAIN);
    this.progCompose = compileCompose(gl, FS_COMPOSE);
    this.progSeam = compile(gl, VS_SEAM, FS_SEAM);
    const t = () => this.makeTex();
    this.tex = { color: t(), other: t(), elev: t(), coast: t(), cellCoast: t(), grad: t(), seaGrad: t(), flat: t(), highlight: t(), group: t(), segData: t(), fx: t(), fxPal: t(), tint: t(), river: this.makeTex(true), lith: t(), landCell: t(), country: t(), fj: t(), near: t() };
    this.rest = this.makeTarget();
    this.moving = this.makeTarget();
    this.out = { fbo: gl.createFramebuffer()!, tex: this.makeTex(), w: 0, h: 0 };
    // 每段的数据先放一个空纹素：还没有切线时合成程序照样绑着它，不能是没有内容的纹理
    gl.bindTexture(gl.TEXTURE_2D, this.tex.segData);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(4));
    // 花纹的两张纹理也先放一个空纹素（没有花纹时合成程序照样绑着它们）
    gl.bindTexture(gl.TEXTURE_2D, this.tex.fx);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.bindTexture(gl.TEXTURE_2D, this.tex.fxPal);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 1, 1, 0, gl.RGBA, gl.FLOAT, new Float32Array(4));
    // 河的图层、离边界远的格也先放一个空纹素
    for (const t of [this.tex.river, this.tex.near]) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    }
    // 切线：长方形的四个角（每个顶点一个），与每段的实例数据：10 个数（aSeg 4、aNb 4、aEnds 2）
    this.seamVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.seamVao);
    const corners = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 1, 2, 3]), gl.STATIC_DRAW);
    const cornerLoc = gl.getAttribLocation(this.progSeam, 'aCorner');
    gl.enableVertexAttribArray(cornerLoc);
    gl.vertexAttribPointer(cornerLoc, 1, gl.FLOAT, false, 0, 0);
    this.seamBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.seamBuf);
    const attr = (name: string, size: number, offset: number) => {
      const loc = gl.getAttribLocation(this.progSeam, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 40, offset);
      gl.vertexAttribDivisor(loc, 1);
    };
    attr('aSeg', 4, 0);
    attr('aNb', 4, 16);
    attr('aEnds', 2, 32);
    gl.bindVertexArray(null);
  }

  private loc(p: WebGLProgram, name: string): WebGLUniformLocation | null {
    let m = this.locs.get(p);
    if (!m) this.locs.set(p, (m = new Map()));
    let l = m.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(p, name);
      m.set(name, l);
    }
    return l;
  }

  // 这张纹理传上去的还是不是这几个数组；不是时记下新的，返回 true（调用方去上传）
  private fresh(slot: string, ...deps: unknown[]): boolean {
    const was = this.shownDeps[slot];
    if (was && was.length === deps.length && was.every((d, k) => d === deps[k])) return false;
    this.shownDeps[slot] = deps;
    return true;
  }

  private makeTex(linear = false): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    const f = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  setMesh(mesh: Mesh) {
    if (this.mesh === mesh) return;
    this.mesh = mesh;
    this.layersVersion++;
    this.meshVersion++;
    this.dirtyCells = 'full';
    // 换了网格：逐格的纹理都要重传（格数变了），离边界远的格按新网格的 ρ（空闲时算）
    this.shownDeps = {};
    this.fjShown = undefined;
    this.nearRho = null;
    this.scheduleRho(mesh);
    this.planet = mesh.kind === 'sphere';
    if (mesh.kind === 'sphere') {
      this.setSphereMesh(mesh);
      return;
    }
    // Delaunay 三角形，不共享顶点，每个顶点带重心坐标的一个分量
    const tris = mesh.triangles;
    const tp = new Float32Array(tris.length * 2);
    const tc = new Float32Array(tris.length);
    const tb = new Float32Array(tris.length * 3);
    for (let k = 0; k < tris.length; k++) {
      const c = tris[k];
      tp[2 * k] = mesh.x[c];
      tp[2 * k + 1] = mesh.y[c];
      tc[k] = c;
      tb[3 * k + (k % 3)] = 1;
    }
    this.triVao = this.makeVao(tp, tc, tb);
    this.triCount = tris.length;
    this.cellBox = cellBoxes(mesh, tp, tc, false);
    // Voronoi：每个多边形以格中心做扇形三角化（编号层）
    const vp: number[] = [];
    const vc: number[] = [];
    for (let i = 0; i < mesh.n; i++) {
      const a = mesh.polyOff[i];
      const b = mesh.polyOff[i + 1];
      const m = b - a;
      for (let k = 0; k < m; k++) {
        const k2 = (k + 1) % m;
        vp.push(mesh.x[i], mesh.y[i], mesh.poly[2 * (a + k)], mesh.poly[2 * (a + k) + 1], mesh.poly[2 * (a + k2)], mesh.poly[2 * (a + k2) + 1]);
        vc.push(i, i, i);
      }
    }
    this.fanVao = this.makeVao(new Float32Array(vp), new Float32Array(vc), new Float32Array(vc.length * 3));
    this.fanCount = vc.length;
  }

  // 整个星球：显示用的三角网（含接缝两侧、两极的影子点，对应回真实的格）。
  // 同一个三角形里对应同一格的角共用一个重心坐标分量，与导出（subcell.ts）的权重合并一致
  private setSphereMesh(mesh: Extract<Mesh, { kind: 'sphere' }>) {
    const gl = this.gl;
    if (!this.planetProgs) {
      this.planetProgs = {
        id: compile(gl, VS_ID_PLANET, FS_ID),
        terrain: compile(gl, VS_CELL_PLANET, FS_TERRAIN_PLANET),
        compose: compileCompose(gl, FS_COMPOSE_PLANET),
      };
    }
    const view = viewOf(mesh);
    const tris = view.triangles;
    const tp = new Float32Array(tris.length * 2);
    const tc = new Float32Array(tris.length);
    const tb = new Float32Array(tris.length * 3);
    let x0 = Infinity;
    let x1 = -Infinity;
    for (let t = 0; t < tris.length; t += 3) {
      const c0 = view.cellOf[tris[t]];
      const c1 = view.cellOf[tris[t + 1]];
      for (let k = 0; k < 3; k++) {
        const v = tris[t + k];
        const c = view.cellOf[v];
        tp[2 * (t + k)] = view.x[v];
        tp[2 * (t + k) + 1] = view.y[v];
        tc[t + k] = c;
        const slot = c === c0 ? 0 : c === c1 ? 1 : k;
        tb[3 * (t + k) + slot] = 1;
        x0 = Math.min(x0, view.x[v]);
        x1 = Math.max(x1, view.x[v]);
      }
    }
    this.triVao = this.makeVao(tp, tc, tb);
    this.triCount = tris.length;
    this.cellBox = cellBoxes(mesh, tp, tc, true);
    // 编号层：Voronoi 多边形（凸），从第一个顶点扇形三角化
    const polys = view.polygons();
    let count = 0;
    for (let q = 0; q + 1 < polys.off.length; q++) count += Math.max(0, polys.off[q + 1] - polys.off[q] - 2) * 3;
    const vp = new Float32Array(count * 2);
    const vc = new Float32Array(count);
    let o = 0;
    for (let q = 0; q + 1 < polys.off.length; q++) {
      const a = polys.off[q];
      const b = polys.off[q + 1];
      for (let k = a + 1; k + 1 < b; k++) {
        for (const v of [a, k, k + 1]) {
          vp[2 * o] = polys.xy[2 * v];
          vp[2 * o + 1] = polys.xy[2 * v + 1];
          vc[o] = polys.cell[q];
          o++;
        }
      }
    }
    this.fanVao = this.makeVao(vp, vc, new Float32Array(count * 3));
    this.fanCount = count;
    this.xRange = [Math.min(x0, 0), Math.max(x1, 2)];
  }

  private makeVao(pos: Float32Array, cell: Float32Array, bary: Float32Array): WebGLVertexArrayObject {
    const gl = this.gl;
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const attr = (loc: number, data: Float32Array, size: number) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    };
    attr(0, pos, 2);
    attr(1, cell, 1);
    attr(2, bary, 3);
    gl.bindVertexArray(null);
    return vao;
  }

  // 峡湾纹理（第三十六轮）：整行的 RGBA32F（core/fjords.ts 的 fjordLayer）；同一份不重新上传，没有时一个 0 的 texel
  private fjShown: Float32Array | null | undefined = undefined;
  private uploadFj(data: Float32Array | null) {
    if (data === this.fjShown) return;
    this.fjShown = data;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex.fj);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const d = data && data.length >= 4 * TEX_W ? data : new Float32Array(4 * TEX_W);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEX_W, d.length / (4 * TEX_W), 0, gl.RGBA, gl.FLOAT, d);
  }

  // ρ（near.ts 的 nearRho）在空闲时一小段一小段地算（类地星球约 0.6 秒）；算好之前合成照算环上的点（结果一样，只是慢）
  private scheduleRho(mesh: Mesh) {
    if (this.rhoTimer) clearTimeout(this.rhoTimer);
    const step = () => {
      this.rhoTimer = null;
      if (this.mesh !== mesh) return;
      const r = nearRhoStep(mesh, 6);
      if (!r) {
        this.rhoTimer = setTimeout(step, 16);
        return;
      }
      // 着色器里按 float32 比：往小里收一点，取整、舍入不会让保证的距离变远
      this.nearRho = Float32Array.from(r, (v) => (v > 0 ? v * (1 - 1e-4) : v));
    };
    this.rhoTimer = setTimeout(step, 50);
  }

  // 离边界远的格（near.ts 的 nearLayer：地区约 15–25 毫秒、星球约 30–55 毫秒）不在换图层的那一帧里算：图层停下 40 毫秒后在空闲时
  // 分几步算（每步几毫秒，步与步之间让出线程），算好时图层还是那一份才用上（之前照取环上的点，画出来一样）。编辑时图层每一笔都换，算不上也不耽误
  private scheduleNear(l: CellLayers) {
    if (this.nearTimer) clearTimeout(this.nearTimer);
    const mesh = this.mesh;
    let job: ReturnType<typeof nearLayerSteps> | null = null;
    let k = 0;
    const step = () => {
      this.nearTimer = null;
      if (this.base !== l || this.mesh !== mesh || !mesh) return;
      const t = performance.now();
      job ??= nearLayerSteps(mesh, l.group, l.countryGroup, l.coast, l.landCell);
      if (k < job.steps.length) job.steps[k++]();
      this.perf?.cpu('near', performance.now() - t);
      if (k < job.steps.length) {
        this.nearTimer = setTimeout(step, 0);
        return;
      }
      this.nearMemo.set(l, job.out);
      this.useNear(l);
    };
    this.nearTimer = setTimeout(step, 40);
  }
  private useNear(l: CellLayers) {
    const mesh = this.mesh;
    if (!mesh || (!l.group && !l.countryGroup)) return;
    let near = this.nearMemo.get(l);
    if (!near) {
      const job = nearLayerSteps(mesh, l.group, l.countryGroup, l.coast, l.landCell);
      for (const st of job.steps) st();
      near = job.out;
      this.nearMemo.set(l, near);
    }
    if (this.fresh('near', near)) this.upload(this.tex.near, near, mesh.n, 4);
    this.nearShown = near;
  }

  // 测试、导出：现在就把 ρ 与这一份图层的离边界远的格算完
  prepareNear() {
    if (this.mesh && !this.nearRho) {
      if (this.rhoTimer) clearTimeout(this.rhoTimer);
      this.rhoTimer = null;
      const r = nearRhoStep(this.mesh, Infinity)!;
      this.nearRho = Float32Array.from(r, (v) => (v > 0 ? v * (1 - 1e-4) : v));
    }
    if (this.base && !this.nearShown) {
      if (this.nearTimer) clearTimeout(this.nearTimer);
      this.nearTimer = null;
      this.useNear(this.base);
    }
  }

  private upload(tex: WebGLTexture, data: Uint8Array | Float32Array, n: number, channels: 1 | 2 | 4) {
    const gl = this.gl;
    const rows = Math.ceil(n / TEX_W);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    if (data instanceof Float32Array) {
      const padded = new Float32Array(TEX_W * rows * channels);
      padded.set(data.subarray(0, n * channels));
      if (channels === 1) gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, TEX_W, rows, 0, gl.RED, gl.FLOAT, padded);
      else if (channels === 2) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, TEX_W, rows, 0, gl.RG, gl.FLOAT, padded);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEX_W, rows, 0, gl.RGBA, gl.FLOAT, padded);
    } else {
      const padded = new Uint8Array(TEX_W * rows * 4);
      padded.set(data.subarray(0, n * 4));
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, TEX_W, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, padded);
    }
  }

  // 高程纹理（两个通道：高程、水面的高程）的打包：setLayers 的一份与幽灵用的一份
  private elevPack = new Float32Array(0);
  private elevGhost: Float32Array | null = null;
  // 海岸值纹理（海岸值、破碎度）的打包：同上
  private coastPack = new Float32Array(0);
  private coastGhost: Float32Array | null = null;
  // 合成着色器读的海岸值、破碎度（两个通道）：同上
  private cellCoastPack = new Float32Array(0);
  private cellCoastGhost: Float32Array | null = null;

  // 换图层（第三十九轮）：按对象是不是同一个来上传（换模式时底子多半没变）；地形层读的变了才加 layersVersion（重画地形层），
  // 只有合成读的变了只加 modeVersion（只重新合成）。幽灵海岸、省份预览在这之后都没了，调用方要重新给
  setLayers(l: CellLayers) {
    const n = this.mesh?.n ?? 0;
    let terrain = false;
    let mode = false;
    if (this.fresh('color', l.smooth)) {
      this.upload(this.tex.color, l.smooth, n, 4);
      terrain = true;
    }
    if (this.fresh('other', l.other)) {
      this.upload(this.tex.other, l.other, n, 4);
      terrain = true;
    }
    if (this.fresh('elev', l.elevation, l.coast, l.shore)) {
      this.elevPack = new Float32Array(n * 2);
      packElevation(this.elevPack, l.elevation, l.coast, l.shore ?? null, 0, n);
      this.upload(this.tex.elev, this.elevPack, n, 2);
      terrain = true;
    }
    this.elevGhost = null;
    if (this.fresh('coast', l.coast, l.frag, l.style)) {
      this.coastPack = new Float32Array(n * 4);
      packCoast(this.coastPack, l.coast, l.frag, l.style, 0, n);
      this.upload(this.tex.coast, this.coastPack, n, 4);
      terrain = true;
    }
    this.coastGhost = null;
    // 合成着色器只读海岸值、破碎度（provCell 一个像素要查十几次）：另一张两个通道的（RGBA32F 的那张读起来多一倍的带宽，合成慢约三成）
    if (this.fresh('cellCoast', l.coast, l.frag)) {
      this.cellCoastPack = new Float32Array(n * 2);
      packCellCoast(this.cellCoastPack, l.coast, l.frag, 0, n);
      this.upload(this.tex.cellCoast, this.cellCoastPack, n, 2);
      mode = true;
    }
    this.cellCoastGhost = null;
    // 峡湾的纹理自己记着传上去的是哪一份（幽灵海岸也换它）
    const fj = this.fjShown;
    this.uploadFj(l.fjord ?? null);
    if (this.fjShown !== fj) terrain = true;
    if (this.fresh('grad', l.grad)) {
      this.upload(this.tex.grad, l.grad, n, 2);
      terrain = true;
    }
    if (this.fresh('seaGrad', l.seaGrad ?? null)) {
      this.upload(this.tex.seaGrad, l.seaGrad ?? new Float32Array(n * 2), n, 2);
      terrain = true;
    }
    if (this.fresh('lith', l.lith ?? null)) {
      this.upload(this.tex.lith, l.lith ?? new Uint8Array(n * 4), n, 4);
      terrain = true;
    }
    if (this.fresh('landCell', l.landCell ?? null)) {
      if (l.landCell) this.upload(this.tex.landCell, l.landCell, n, 4);
      mode = true;
    }
    if (this.fresh('flat', l.flat)) {
      if (l.flat) this.upload(this.tex.flat, l.flat, n, 4);
      mode = true;
    }
    if (this.fresh('group', l.group)) {
      if (l.group) this.upload(this.tex.group, l.group, n, 2);
      mode = true;
    }
    if (this.fresh('country', l.countryGroup ?? null)) {
      if (l.countryGroup) this.upload(this.tex.country, l.countryGroup, n, 2);
      mode = true;
    }
    // 离边界远的格：算过的照用，没算过的空闲时算（只决定跳不跳过，画出来一样：不进合成的键）
    const near = l.near ?? this.nearMemo.get(l) ?? null;
    if (near && this.fresh('near', near)) this.upload(this.tex.near, near, n, 4);
    this.nearShown = near;
    if (!near && (l.group || l.countryGroup)) this.scheduleNear(l);
    this.hasLandCell = !!l.landCell;
    this.hasFlat = !!l.flat;
    this.hasGroup = !!l.group;
    this.hasCountry = !!l.countryGroup;
    this.groupBase = this.groupShown = l.group;
    this.flatBase = this.flatShown = l.flat;
    this.seamsBase = l.group ? (l.seams ?? null) : null;
    this.showSeams(this.seamsBase);
    // 露岩（地形层的饱和度也看它）、海面是数据（地形层也看它）变了要重画地形层；晕渲的强弱只在合成里
    if (l.rock !== this.rock || !!l.seaData !== this.seaData) terrain = true;
    if (l.shade !== this.shade) mode = true;
    this.shade = l.shade;
    this.rock = l.rock;
    this.seaData = !!l.seaData;
    this.coastAmp = l.coastAmp;
    this.base = l;
    if (terrain) {
      this.layersVersion++;
      this.dirtyCells = 'full';
    }
    if (mode) this.modeVersion++;
    this.ghostCells = [];
    this.ghostRows = [];
    this.ghostAmp = null;
    this.ghostGroup = null;
    this.ghostFlat = null;
    // 花纹与发光：与现在显示的是同一份时不重传（调用方的外观覆盖随后照样给）
    this.fxBase = { fx: l.fx ?? null, palette: l.fxPalette ?? null };
    this.setFx(this.fxBase.fx, this.fxBase.palette);
  }

  // 生态的花纹与发光：拖花纹、发光滑块时主线程上换一份（colors.ts 的 fxLayers 带上覆盖的外观），null 回到 setLayers 给的。
  // 同一份不重新上传；setLayers 之后回到它给的，调用方要重新给
  setFx(fx: Uint8Array | null, palette: Float32Array | null) {
    if (fx === this.fxShown.fx && palette === this.fxShown.palette) return;
    this.fxShown = { fx, palette };
    this.fxVersion++;
    if (!fx || !palette) return;
    const gl = this.gl;
    this.upload(this.tex.fx, fx, this.mesh?.n ?? 0, 4);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.fxPal);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 3, palette.length / 12, 0, gl.RGBA, gl.FLOAT, palette);
  }

  // 湖泊类型的颜色与画法（每格 RGBA 字节，见 colors.ts 的 lakeTintLayer）；null 不画。同一份不重新上传
  setTint(tint: Uint8Array | null) {
    if (tint === this.tintShown) return;
    this.tintShown = tint;
    this.tintVersion++;
    if (tint) this.upload(this.tex.tint, tint, this.mesh?.n ?? 0, 4);
  }

  // 幽灵海岸：几格的地形输入（颜色、对岸的颜色、高程、海岸值，与平涂、分组）换成将来的样子，着色器照此画出将来真实的海岸线；
  // null 回到 setLayers 给的。g 的数组是持久的缓冲，g.cells 是现在与底子不同的格：只上传这些格与上一次不同的格所在的行。
  // 省份预览（setGroupPreview）显示着的时候平涂、分组听省份预览的。setLayers 之后幽灵就没了，调用方要重新给
  setGhost(g: GhostLayers | null) {
    const base = this.base;
    if (!base) return;
    const now = new Set<number>();
    if (g) for (const i of g.cells) now.add(Math.floor(i / TEX_W));
    const rows = [...new Set([...this.ghostRows, ...now])].sort((a, b) => a - b);
    const amp = g?.coastAmp ?? null;
    if (!rows.length && amp === this.ghostAmp) return;
    // 峡湾（第三十六轮）：幽灵里按将来的陆海重算过（colors.ts 的 GhostBuffer），与上一次的不同才上传
    this.uploadFj(g?.fjord !== undefined ? g.fjord : (base.fjord ?? null));
    const src = g ?? { smooth: base.smooth, other: base.other, elevation: base.elevation, coast: base.coast, frag: base.frag ?? null, flat: base.flat, group: base.group, style: base.style ?? null };
    // 这几张只改了几行：与哪个数组都对不上了（下一次 setLayers 整张重传）
    for (const k of ['color', 'other', 'elev', 'coast', 'cellCoast']) this.shownDeps[k] = null;
    this.uploadRows(this.tex.color, src.smooth, rows, 4);
    this.uploadRows(this.tex.other, src.other, rows, 4);
    // 高程与水面的高程按行打包（陆海按这一份的海岸值分）
    if (!this.elevGhost) this.elevGhost = this.elevPack.slice();
    for (const r of rows) packElevation(this.elevGhost, src.elevation, src.coast, base.shore ?? null, r * TEX_W, Math.min(src.coast.length, (r + 1) * TEX_W));
    this.uploadRows(this.tex.elev, this.elevGhost, rows, 2);
    if (!this.coastGhost) this.coastGhost = this.coastPack.slice();
    // 海岸类型（第三十四轮）：幽灵里峡湾按将来的陆海重算过（colors.ts 的 GhostBuffer）
    for (const r of rows) packCoast(this.coastGhost, src.coast, src.frag, src.style, r * TEX_W, Math.min(src.coast.length, (r + 1) * TEX_W));
    this.uploadRows(this.tex.coast, this.coastGhost, rows, 4);
    if (!this.cellCoastGhost) this.cellCoastGhost = this.cellCoastPack.slice();
    for (const r of rows) packCellCoast(this.cellCoastGhost, src.coast, src.frag, r * TEX_W, Math.min(src.coast.length, (r + 1) * TEX_W));
    this.uploadRows(this.tex.cellCoast, this.cellCoastGhost, rows, 2);
    // 平涂、分组：显示着的是底子或上一次的幽灵时才换
    if (this.groupBase && src.group && (this.groupShown === this.groupBase || this.groupShown === this.ghostGroup)) {
      this.uploadRows(this.tex.group, src.group, rows, 2);
      this.groupShown = g ? src.group : this.groupBase;
      this.shownDeps.group = null;
      this.groupVersion++;
    }
    if (this.flatBase && src.flat && (this.flatShown === this.flatBase || this.flatShown === this.ghostFlat)) {
      this.uploadRows(this.tex.flat, src.flat, rows, 4);
      this.flatShown = g ? src.flat : this.flatBase;
      this.shownDeps.flat = null;
      this.groupVersion++;
    }
    this.ghostGroup = g?.group ?? null;
    this.ghostFlat = g?.flat ?? null;
    // 地形层只重画输入变了的格（上一次的幽灵与这一次的）；海岸细节幅度变了整张重画
    const cells = g ? g.cells : [];
    if (amp !== this.ghostAmp) this.dirtyCells = 'full';
    else if (this.dirtyCells !== 'full') {
      for (const c of this.ghostCells) this.dirtyCells.add(c);
      for (const c of cells) this.dirtyCells.add(c);
    }
    this.ghostCells = Array.from(cells);
    this.ghostRows = [...now];
    this.ghostAmp = amp;
    this.layersVersion++;
  }

  // 只上传这几行（每行 TEX_W 格；连着的几行一次传）
  private uploadRows(tex: WebGLTexture, data: Uint8Array | Float32Array, rows: number[], channels: 1 | 2 | 4) {
    if (!rows.length) return;
    const gl = this.gl;
    const per = TEX_W * channels;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (let k = 0; k < rows.length; ) {
      const r = rows[k];
      let r1 = r + 1;
      while (k + 1 < rows.length && rows[k + 1] === r1) {
        k++;
        r1++;
      }
      k++;
      // 最后一行不满时补齐
      let src: Uint8Array | Float32Array = data.subarray(r * per, Math.min(data.length, r1 * per));
      if (src.length < (r1 - r) * per) {
        const padded = data instanceof Float32Array ? new Float32Array((r1 - r) * per) : new Uint8Array((r1 - r) * per);
        padded.set(src);
        src = padded;
      }
      if (channels === 1) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r, TEX_W, r1 - r, gl.RED, gl.FLOAT, src);
      else if (channels === 2) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r, TEX_W, r1 - r, gl.RG, gl.FLOAT, src);
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r, TEX_W, r1 - r, gl.RGBA, data instanceof Float32Array ? gl.FLOAT : gl.UNSIGNED_BYTE, src);
    }
  }

  // 省份预览：整份分组（与平涂、切线）换成将来的样子，着色器照此画出真实的新省界；null 回到 setLayers 给的。
  // 没有画分组边界时不管。setLayers 之后预览就没了，调用方要重新给
  setGroupPreview(p: { group: Float32Array; flat: Uint8Array | null; seams?: SeamLayers | null } | null) {
    if (!this.groupBase || !this.groupShown) return;
    const group = p ? p.group : this.groupBase;
    const flat = p && p.flat && this.flatBase ? p.flat : this.flatBase;
    const seams = p ? (p.seams ?? null) : this.seamsBase;
    if (group === this.groupShown && flat === this.flatShown && seams === this.seamsShown) return;
    this.uploadChanged(this.tex.group, this.groupShown, group, 2);
    this.groupShown = group;
    this.shownDeps.group = null;
    if (flat && this.flatShown && flat !== this.flatShown) {
      this.uploadChanged(this.tex.flat, this.flatShown, flat, 4);
      this.flatShown = flat;
      this.shownDeps.flat = null;
    }
    this.showSeams(seams);
    this.groupVersion++;
  }

  // 切线：每段的几何（实例数据）与两边的省（gL, gR, repL, repR 一段一个纹素）
  private showSeams(L: SeamLayers | null) {
    if (L === this.seamsShown) return;
    this.seamsShown = L;
    this.seamVersion++;
    const m = L ? L.segs.count : 0;
    this.seamCount = m;
    if (!L || !m) return;
    const gl = this.gl;
    const S = L.segs;
    const inst = new Float32Array(m * 10);
    const data = new Float32Array(m * 4);
    let x0 = Infinity;
    let x1 = -Infinity;
    for (let s = 0; s < m; s++) {
      inst.set([S.ax[s], S.ay[s], S.bx[s], S.by[s], S.px[s], S.py[s], S.nx[s], S.ny[s], S.hasPrev[s], S.hasNext[s]], s * 10);
      data.set([L.gL[s], L.gR[s], L.repL[s], L.repR[s]], s * 4);
      x0 = Math.min(x0, S.ax[s], S.bx[s]);
      x1 = Math.max(x1, S.ax[s], S.bx[s]);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.seamBuf);
    gl.bufferData(gl.ARRAY_BUFFER, inst, gl.DYNAMIC_DRAW);
    const rows = Math.ceil(m / TEX_W);
    const padded = new Float32Array(TEX_W * rows * 4);
    padded.set(data);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.segData);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TEX_W, rows, 0, gl.RGBA, gl.FLOAT, padded);
    this.seamBand = L.band;
    this.seamX = [x0, x1];
  }

  // 只上传与现在显示的不同的那些行（每行 TEX_W 格）：涂省、剪刀每动一下只改一小片
  private uploadChanged(tex: WebGLTexture, before: Float32Array | Uint8Array, after: Float32Array | Uint8Array, channels: 2 | 4) {
    const gl = this.gl;
    const n = this.mesh?.n ?? 0;
    const rows = Math.ceil(n / TEX_W);
    const per = TEX_W * channels;
    const differs = (r: number) => {
      const end = Math.min(n * channels, (r + 1) * per);
      for (let k = r * per; k < end; k++) if (before[k] !== after[k]) return true;
      return false;
    };
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (let r = 0; r < rows; ) {
      if (!differs(r)) {
        r++;
        continue;
      }
      let r1 = r + 1;
      while (r1 < rows && differs(r1)) r1++;
      // 最后一行不满时补齐
      let src: Float32Array | Uint8Array = after.subarray(r * per, Math.min(after.length, r1 * per));
      if (src.length < (r1 - r) * per) {
        const padded = after instanceof Float32Array ? new Float32Array((r1 - r) * per) : new Uint8Array((r1 - r) * per);
        padded.set(src);
        src = padded;
      }
      if (channels === 2) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r, TEX_W, r1 - r, gl.RG, gl.FLOAT, src);
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, r, TEX_W, r1 - r, gl.RGBA, gl.UNSIGNED_BYTE, src);
      r = r1;
    }
  }

  // 河的图层：换了画布或版本才上传（上下翻转、预乘 alpha：线性插值时透明处不发黑，合成按预乘混）
  private useRiver(r: RiverTex | null): RiverTex | null {
    if (!r) return null;
    const s = this.riverShown;
    if (s && s.source === r.source && s.version === r.version) return r;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex.river);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, r.source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.riverShown = { source: r.source, version: r.version };
    return r;
  }

  setHighlight(h: Uint8Array | null) {
    this.highlightVersion++;
    this.hasHighlight = !!h;
    if (h) this.upload(this.tex.highlight, h, this.mesh?.n ?? 0, 4);
  }

  // 描格（第三十七轮）：鼠标下的格与钉住的格，各描出画成陆地（land）或水面的那一部分（合成着色器的 focusAt）。
  // null 不描。第三十九轮：focusKey 不在合成的键里，变了时只在新旧两处的那几块里重新合成（见 composeFocus）
  setFocus(hover: CellFocus | null, pinned: CellFocus | null) {
    const n = this.mesh?.n ?? 0;
    const ok = (f: CellFocus | null) => (f && f.cell >= 0 && f.cell < n ? f : null);
    const h = ok(hover);
    const p = ok(pinned);
    this.focus = [h, p];
    this.focusKey = `${h ? `${h.cell}${h.land ? 'L' : 'W'}` : ''}|${p ? `${p.cell}${p.land ? 'L' : 'W'}` : ''}`;
  }

  // 地图单位 → 裁剪空间（停稳：与画布一样大的目标）
  private viewUniform(): V4 {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const dpr = w / this.canvas.clientWidth || 1;
    const z = this.camera.zoom * dpr;
    const sx = (2 * z) / w;
    const sy = (-2 * z) / h;
    return [sx, sy, -this.camera.x * sx, -this.camera.y * sy];
  }

  private makeTarget(): SceneTarget {
    const gl = this.gl;
    return {
      w: 0,
      h: 0,
      fbo: gl.createFramebuffer()!,
      fboId: gl.createFramebuffer()!,
      fboSeam: gl.createFramebuffer()!,
      color: this.makeTex(true),
      height: this.makeTex(),
      id: this.makeTex(),
      seam: this.makeTex(),
      depth: gl.createRenderbuffer()!,
    };
  }

  // 一组场景目标按大小分配；大小变了返回 true
  private sizeTarget(t: SceneTarget, w: number, h: number): boolean {
    const gl = this.gl;
    if (t.w === w && t.h === h) return false;
    t.w = w;
    t.h = h;
    gl.bindTexture(gl.TEXTURE_2D, t.color);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, t.height);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, w, h, 0, gl.RGBA, gl.FLOAT, null);
    gl.bindTexture(gl.TEXTURE_2D, t.id);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.color, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, t.height, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fboId);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.id, 0);
    // 切线层：段号与哪一边（RGBA8），深度 = 到段的距离 / 带宽
    gl.bindTexture(gl.TEXTURE_2D, t.seam);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, t.depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT32F, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fboSeam);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.seam, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, t.depth);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }

  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }

  // 画一帧。镜头在 SETTLE_MS 之内动过时按移动中的画法画（低分辨率，平移时挪用带边距的场景），返回 true：
  // 调用方要在 SETTLE_MS 之后再画一次，那时按停稳的画法补上全分辨率的（与原来逐像素相同）。
  // still：不管镜头动没动都按停稳的画法画（导出图片、截图）
  render(kmPerUnit: number, opts: { still?: boolean } = {}): boolean {
    const mesh = this.mesh;
    if (!mesh || !this.triVao || !this.fanVao) return false;
    this.resize();
    const cam = this.camera;
    const proj = this.planet ? cam.proj : undefined;
    const camKey = `${cam.x}|${cam.y}|${cam.zoom}${proj ? `|${proj.kind}|${proj.lon0}|${proj.lat0}` : ''}`;
    const now = performance.now();
    if (camKey !== this.lastCam) {
      if (this.lastCam) this.movedAt = now;
      this.lastCam = camKey;
    }
    // 等面积、球形投影：另一条路（场景按需要的范围、密度画，合成时反算投影）
    if (proj) {
      const moving = !opts.still && now - this.movedAt < SETTLE_MS;
      this.justSettled = this.wasMoving && !moving && !opts.still;
      if (!opts.still) this.wasMoving = moving;
      this.renderProjected(kmPerUnit, moving);
      return moving;
    }
    if (this.projT) this.leaveProjected();
    if (!opts.still && now - this.movedAt < SETTLE_MS) {
      this.renderMoving(kmPerUnit);
      this.wasMoving = true;
      this.justSettled = false;
      return true;
    }
    // 导出、截图（still）不算停下：真正停下的那一帧照样分两帧补画
    this.justSettled = this.wasMoving && !opts.still;
    if (!opts.still) this.wasMoving = false;
    this.renderStill(kmPerUnit);
    return false;
  }

  // 放大后晕渲不必夸张那么多：一格 8 像素以内照旧，越放大越缓（一格 64 像素时约一半）
  private reliefNow(): number {
    return this.reliefAt(this.planet ? effectiveZoom(this.camera) : this.camera.zoom);
  }
  private reliefAt(zoom: number): number {
    const cellCss = this.mesh!.spacing * zoom;
    return this.relief / (1 + 0.4 * Math.max(0, Math.log2(cellCss / 8)));
  }

  // 整个星球：屏幕上看得见的那几份副本（x 平移 2 的倍数）。halfW：画面的半宽（地图单位）
  private copiesFor(camX: number, halfW: number): [number, number] {
    if (!this.planet) return [0, 1];
    const copy0 = Math.ceil((camX - halfW - this.xRange[1]) / 2);
    const copy1 = Math.floor((camX + halfW - this.xRange[0]) / 2);
    return [copy0, Math.max(1, Math.min(7, copy1 - copy0 + 1))];
  }

  // 停稳的画法：画布大小的场景，编号层只在网格、画布、镜头变了时重画，地形层另在图层变了时重画
  // （只有幽灵海岸改了几格时只重画那几格的三角形盖住的一块），切线层在切线变了时重画；合成每次重画
  private renderStill(kmPerUnit: number) {
    const gl = this.gl;
    const mesh = this.mesh!;
    const t = this.rest;
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.sizeTarget(t, w, h);
    const view = this.viewUniform();
    const cam = this.camera;
    const dpr = w / this.canvas.clientWidth || 1;
    const relief = this.reliefNow();
    // 幽灵海岸带着将来的海岸细节幅度（拖海岸曲折时）
    const coastAmp = this.ghostAmp ?? this.coastAmp;
    // 带上 dpr：页面缩放变了而画布像素数没变（CSS 大小跟着反过来变）时也要重画
    const idKey = `${this.meshVersion}|${w}x${h}|${dpr}|${cam.x}|${cam.y}|${cam.zoom}`;
    const terrainStatic = `${idKey}|${this.detail}|${coastAmp}|${kmPerUnit}`;
    const terrainKey = `${terrainStatic}|${this.layersVersion}`;
    const halfW = this.canvas.clientWidth / 2 / cam.zoom;
    const [copy0, copies] = this.copiesFor(cam.x, halfW);
    // 切线层：镜头、窗口、切线变了才重画
    const hasSeams = this.hasGroup && this.seamCount > 0;
    const seamKey = hasSeams ? `${w}x${h}|${dpr}|${cam.x}|${cam.y}|${cam.zoom}|${this.seamVersion}` : '';
    // 河的图层：停稳的那张（刚停下的那一帧就画好：照用移动中的那张的话，下一帧换上停稳的那张时要整张再合成一次，比画河慢得多）
    const river = this.riverLayer?.(false) ?? null;
    const riverKey = river ? `${river.version}|${river.toUv.join(',')}` : '';
    // 描格不在键里（第三十九轮）：鼠标跨格时只重画描格那几块（composeFocus）
    const composeKey = `${terrainKey}|${seamKey}|${this.highlightVersion}|${this.groupVersion}|${this.modeVersion}|${this.fxVersion}|${this.tintVersion}|${mapStyleKey(this.style)}|${relief}|${this.flatByGroup}|${this.highlightByGroup}|${this.provinceScale}|${this.provinceAlpha}|${this.countryAlpha}|${riverKey}`;
    const cellPx = mesh.spacing * cam.zoom * dpr;
    // 画面没有任何变化：画布保留着上一帧（preserveDrawingBuffer），什么都不用画；只有描格变了时只补那几块
    if (composeKey === this.composeKey) {
      if (this.focusKey !== this.focusDrawn.key) {
        gl.disable(gl.BLEND);
        gl.viewport(0, 0, w, h);
        this.composeFocus(this.focusRects(view, w, h, null), (rects) => this.compose(null, t, view, [1, 1, 0, 0], [1 / w, 1 / h], cellPx, 1, 1, relief, hasSeams, this.useRiver(river), null, rects));
      } else this.perf?.note('compose:none');
      return;
    }
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, w, h);
    if (idKey !== this.idKey) {
      this.idKey = idKey;
      this.drawId(t, view, copy0, copies);
    }
    if (terrainKey !== this.terrainKey) {
      const rects = terrainStatic === this.terrainStatic && this.dirtyCells !== 'full' ? this.dirtyRects(this.dirtyCells, view, w, h) : null;
      this.terrainKey = terrainKey;
      this.terrainStatic = terrainStatic;
      this.dirtyCells = new Set();
      this.perf?.note(rects ? 'terrain:rects' : 'terrain:full');
      this.drawTerrain(t, view, 1 / (cam.zoom * dpr), copy0, copies, coastAmp, kmPerUnit, rects);
    }
    if (hasSeams && seamKey !== this.seamKey) {
      this.seamKey = seamKey;
      this.drawSeams(t, view, cam.x, halfW);
    }
    this.composeKey = composeKey;
    this.perf?.note('compose:full');
    this.compose(null, t, view, [1, 1, 0, 0], [1 / w, 1 / h], cellPx, 1, 1, relief, hasSeams, this.useRiver(river));
    this.focusDrawn = { key: this.focusKey, rects: this.focusRects(view, w, h, null) };
  }

  // 描格那一遍（第三十九轮）：画布上别处与上一次整张合成的相同，只有新旧描格的几块要重画。在这几块里（scissor）照原样再合成一次：
  // 同一个着色器、同样的输入（描格的 uniform 换成新的），每个像素的结果与整张重画逐字节相同（tools/compose-ab.mjs 在无头 Chrome 里对照）
  private composeFocus(rects: Rect[], draw: (rects: Rect[]) => void) {
    const all = mergeRects([...this.focusDrawn.rects, ...rects]);
    this.focusDrawn = { key: this.focusKey, rects };
    if (!all.length) return;
    this.perf?.note('compose:focus');
    draw(all);
  }

  // 描格的格（鼠标下的、钉住的）离格心 FOCUS_REACH 格以内的像素（着色器的 nearFocus）在画面上的几块（设备像素，GL 的 y 向上；
  // 四周多留几个像素，边落在偶数上：2×2 一组的像素整组都在里面，fwidth 与整张画时相同）。pj：投影
  private focusRects(view: V4, w: number, h: number, pj: ProjCompose | null): Rect[] {
    const mesh = this.mesh;
    const out: Rect[] = [];
    if (!mesh) return out;
    const r = FOCUS_REACH * mesh.spacing;
    for (const f of this.focus) {
      if (!f || f.cell >= mesh.n) continue;
      const cx = mesh.x[f.cell];
      const cy = mesh.y[f.cell];
      if (pj) {
        out.push(...this.projFocusRects(cx, cy, r, w, h));
        continue;
      }
      const px = (x: number) => (x * view[0] + view[2] + 1) * 0.5 * w;
      const py = (y: number) => (y * view[1] + view[3] + 1) * 0.5 * h;
      if (!this.planet) {
        out.push(...pixelRect(px(cx - r), px(cx + r), py(cy + r), py(cy - r), w, h));
        continue;
      }
      // 整个星球：按球面上的弦长（着色器的 nearFocus：弦长 < π · r）→ 角半径 θ；包着极点时整行，否则经度最多差 asin(sin θ / sin 余纬)。
      // 南北在地图之外（y < 0、> 1）的像素没有格，不描
      const th = 2 * Math.asin(Math.min(1, (Math.PI * r) / 2));
      const y0 = Math.max(0, cy - th / Math.PI);
      const y1 = Math.min(1, cy + th / Math.PI);
      const s = Math.sin(Math.PI * cy);
      const pole = y0 <= 0 || y1 >= 1 || Math.sin(th) >= s;
      if (pole) {
        out.push(...pixelRect(0, w, py(y1), py(y0), w, h));
        continue;
      }
      const dx = (Math.asin(Math.sin(th) / s) / Math.PI) * 1.01 + 1e-6;
      // 每一份副本（左右相隔 2）
      const left = (-1 - view[2]) / view[0];
      const right = (1 - view[2]) / view[0];
      for (let k = Math.ceil((left - cx - dx) / 2); k <= Math.floor((right - cx + dx) / 2) && out.length < 16; k++) {
        out.push(...pixelRect(px(cx + 2 * k - dx), px(cx + 2 * k + dx), py(y1), py(y0), w, h));
      }
    }
    return out;
  }

  // 投影：沿球面上的那一圈（角半径略大一点）取 64 个点投到画面上，外接矩形再加相邻两点的间距；
  // 有点在球的背面、跨过等面积投影的边（相邻两点在画面上隔得很远）时整张
  private projFocusRects(cx: number, cy: number, r: number, w: number, h: number): Rect[] {
    const th = 2 * Math.asin(Math.min(1, (Math.PI * r) / 2)) * 1.02;
    const full: Rect[] = [[0, 0, w, h]];
    if (th >= Math.PI / 2) return full;
    const lon = Math.PI * (cx - 1);
    const colat = Math.PI * Math.min(1, Math.max(0, cy));
    const C = [Math.sin(colat) * Math.cos(lon), Math.sin(colat) * Math.sin(lon), Math.cos(colat)];
    // 切平面里的两个方向（极点上随便取一个东）
    const E = Math.sin(colat) > 1e-9 ? [-Math.sin(lon), Math.cos(lon), 0] : [0, 1, 0];
    const N = [C[1] * E[2] - C[2] * E[1], C[2] * E[0] - C[0] * E[2], C[0] * E[1] - C[1] * E[0]];
    const cw = this.canvas.clientWidth || 1;
    const ch = this.canvas.clientHeight || 1;
    const dpr = w / cw;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    let gap = 0;
    let prev: [number, number] | null = null;
    const K = 64;
    for (let k = 0; k <= K; k++) {
      const a = (2 * Math.PI * k) / K;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const P = [0, 1, 2].map((i) => Math.cos(th) * C[i] + Math.sin(th) * (ca * E[i] + sa * N[i]));
      const x = 1 + Math.atan2(P[1], P[0]) / Math.PI;
      const y = Math.acos(Math.max(-1, Math.min(1, P[2]))) / Math.PI;
      const sp = projWorldToScreen(this.camera, cw, ch, x, y);
      if (!sp || !Number.isFinite(sp[0]) || !Number.isFinite(sp[1])) return full;
      const q: [number, number] = [sp[0] * dpr, h - sp[1] * dpr];
      if (prev) gap = Math.max(gap, Math.hypot(q[0] - prev[0], q[1] - prev[1]));
      prev = q;
      x0 = Math.min(x0, q[0]);
      x1 = Math.max(x1, q[0]);
      y0 = Math.min(y0, q[1]);
      y1 = Math.max(y1, q[1]);
    }
    if (gap > Math.min(w, h) / 4) return full;
    return pixelRect(x0 - gap, x1 + gap, y0 - gap, y1 + gap, w, h);
  }

  // 移动中的画法：场景按 MOTION_SCALE 的分辨率、四周各多画 MOTION_MARGIN 画在另一组目标上；镜头还在边距之内、
  // 放大不到 MOTION_MAX_ZOOM_IN 倍、输入没变时不重画场景，只按新镜头合成（平移、小幅缩放就是挪一挪、缩一缩那张场景）。
  // 合成也按低分辨率画，再放大拷到画布上
  private renderMoving(kmPerUnit: number) {
    const gl = this.gl;
    const mesh = this.mesh!;
    const cam = this.camera;
    const cw = this.canvas.clientWidth || 1;
    const ch = this.canvas.clientHeight || 1;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const dpr = w / cw || 1;
    // 合成画面与场景的大小（像素），k：一个 CSS 像素合几个这样的像素
    const k = dpr * MOTION_SCALE;
    const ow = Math.max(1, Math.round(cw * k));
    const oh = Math.max(1, Math.round(ch * k));
    const sw = Math.round(ow * (1 + 2 * MOTION_MARGIN));
    const sh = Math.round(oh * (1 + 2 * MOTION_MARGIN));
    if (this.sizeTarget(this.moving, sw, sh)) this.movingScene = null;
    if (this.out.w !== ow || this.out.h !== oh) {
      this.out.w = ow;
      this.out.h = oh;
      gl.bindTexture(gl.TEXTURE_2D, this.out.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, ow, oh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.out.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.out.tex, 0);
    }
    const coastAmp = this.ghostAmp ?? this.coastAmp;
    const hasSeams = this.hasGroup && this.seamCount > 0;
    const key = `${this.meshVersion}|${sw}x${sh}|${k}|${this.layersVersion}|${this.detail}|${coastAmp}|${kmPerUnit}|${hasSeams ? this.seamVersion : -1}`;
    gl.disable(gl.BLEND);
    let sc = this.movingScene;
    // 现在的画面（地图单位的半宽、半高）是否还在场景里
    const fits = (c: Camera) => {
      const z = c.zoom * k;
      return cam.zoom / c.zoom <= MOTION_MAX_ZOOM_IN && Math.abs(cam.x - c.x) + cw / 2 / cam.zoom <= sw / 2 / z && Math.abs(cam.y - c.y) + ch / 2 / cam.zoom <= sh / 2 / z;
    };
    if (!sc || sc.key !== key || !fits(sc.cam)) {
      sc = { cam: { ...cam }, key };
      this.movingScene = sc;
      this.motionEpoch++;
      const z = cam.zoom * k;
      const sx = (2 * z) / sw;
      const sy = (-2 * z) / sh;
      const view: V4 = [sx, sy, -cam.x * sx, -cam.y * sy];
      const halfW = sw / 2 / z;
      const [copy0, copies] = this.copiesFor(cam.x, halfW);
      gl.viewport(0, 0, sw, sh);
      this.drawId(this.moving, view, copy0, copies);
      this.drawTerrain(this.moving, view, 1 / z, copy0, copies, coastAmp, kmPerUnit, null);
      if (hasSeams) this.drawSeams(this.moving, view, cam.x, halfW);
    }
    // 合成：画面上的位置（0–1）→ 场景上的位置
    const c0 = sc.cam;
    const z0 = c0.zoom * k;
    const z1 = cam.zoom * k;
    const ax = (ow / z1) * (z0 / sw);
    const ay = (oh / z1) * (z0 / sh);
    const xf: V4 = [ax, ay, ((cam.x - c0.x) * z0) / sw - 0.5 * ax + 0.5, 0.5 - ((cam.y - c0.y) * z0) / sh - 0.5 * ay];
    const sx = (2 * z1) / ow;
    const sy = (-2 * z1) / oh;
    const view: V4 = [sx, sy, -cam.x * sx, -cam.y * sy];
    gl.viewport(0, 0, ow, oh);
    const river = this.useRiver(this.riverLayer?.(true) ?? null);
    this.compose(this.out.fbo, this.moving, view, xf, [1 / ow, 1 / oh], mesh.spacing * z1, w / ow, (z1 / z0) * (w / ow), this.reliefNow(), hasSeams, river);
    // 放大拷到画布上
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.out.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, ow, oh, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // 停下来时一定按停稳的画法重画
    this.composeKey = '';
  }

  // ---------- 等面积、球形投影（第十三轮 G4） ----------

  // 极地的场景的程序（第一次用到时才编译）
  private polarPrograms() {
    if (!this.polarProgs) {
      const gl = this.gl;
      const seam = compile(gl, VS_SEAM_POLAR, FS_SEAM);
      this.polarProgs = { id: compile(gl, VS_ID_POLAR, FS_ID), terrain: compile(gl, VS_CELL_POLAR, FS_TERRAIN_POLAR), seam };
      // 切线的实例数据按名字找位置：极地的程序与平面的程序要一致（同一个 VAO）
      for (const name of ['aCorner', 'aSeg', 'aNb', 'aEnds']) {
        if (gl.getAttribLocation(seam, name) !== gl.getAttribLocation(this.progSeam, name)) throw new Error(`切线的属性位置不一致：${name}`);
      }
    }
    return this.polarProgs;
  }

  // 球面上真实的三角形（地形层）与 Voronoi 多边形（编号层，从格中心到相邻两个三角形的外心扇形三角化），顶点是世界坐标。
  // 只要离这一极 POLAR_REACH 以内的（另一极附近在这个平面上是一圈，那里的三角形会横跨整个平面）；按网格、按极缓存
  private polarGeometry(pole: 1 | -1) {
    const mesh = this.mesh!;
    if (this.polarGeom?.mesh !== mesh) {
      if (this.polarGeom) {
        for (const g of [this.polarGeom.north, this.polarGeom.south]) {
          if (!g) continue;
          this.gl.deleteVertexArray(g.tri);
          this.gl.deleteVertexArray(g.fan);
        }
      }
      this.polarGeom = { mesh, north: null, south: null };
    }
    const cached = pole > 0 ? this.polarGeom.north : this.polarGeom.south;
    if (cached) return cached;
    if (mesh.kind !== 'sphere') throw new Error('只有整个星球有极地的场景');
    const far = (y: number) => (pole > 0 ? y : 1 - y) > POLAR_REACH;
    const tris = mesh.triangles;
    const tp: number[] = [];
    const tc: number[] = [];
    const tb: number[] = [];
    for (let t = 0; t + 2 < tris.length; t += 3) {
      if (far(mesh.y[tris[t]]) || far(mesh.y[tris[t + 1]]) || far(mesh.y[tris[t + 2]])) continue;
      for (let k = 0; k < 3; k++) {
        const c = tris[t + k];
        tp.push(mesh.x[c], mesh.y[c]);
        tc.push(c);
        tb.push(k === 0 ? 1 : 0, k === 1 ? 1 : 0, k === 2 ? 1 : 0);
      }
    }
    const P = mesh.p;
    const fp: number[] = [];
    const fc: number[] = [];
    const order: number[] = [];
    for (let i = 0; i < mesh.n; i++) {
      if (far(mesh.y[i])) continue;
      const a = mesh.off[i];
      const b = mesh.off[i + 1];
      // 邻格按方向（本格切平面里的东、南）排一圈
      order.length = 0;
      for (let k = a; k < b; k++) order.push(k);
      order.sort((u, v) => Math.atan2(mesh.edy[u], mesh.edx[u]) - Math.atan2(mesh.edy[v], mesh.edx[v]));
      const ax = P[3 * i];
      const ay = P[3 * i + 1];
      const az = P[3 * i + 2];
      const ver: [number, number][] = [];
      for (let m = 0; m < order.length; m++) {
        const j = mesh.adj[order[m]];
        const k = mesh.adj[order[(m + 1) % order.length]];
        const ux = P[3 * j] - ax;
        const uy = P[3 * j + 1] - ay;
        const uz = P[3 * j + 2] - az;
        const vx = P[3 * k] - ax;
        const vy = P[3 * k + 1] - ay;
        const vz = P[3 * k + 2] - az;
        let cx = uy * vz - uz * vy;
        let cy = uz * vx - ux * vz;
        let cz = ux * vy - uy * vx;
        const l = Math.hypot(cx, cy, cz) || 1;
        const sg = cx * ax + cy * ay + cz * az < 0 ? -1 / l : 1 / l;
        cx *= sg;
        cy *= sg;
        cz *= sg;
        ver.push(fromUnit([cx, cy, cz]));
      }
      for (let m = 0; m < ver.length; m++) {
        const q = ver[(m + 1) % ver.length];
        fp.push(mesh.x[i], mesh.y[i], ver[m][0], ver[m][1], q[0], q[1]);
        fc.push(i, i, i);
      }
    }
    const g = {
      tri: this.makeVao(new Float32Array(tp), new Float32Array(tc), new Float32Array(tb)),
      triCount: tc.length,
      fan: this.makeVao(new Float32Array(fp), new Float32Array(fc), new Float32Array(fc.length * 3)),
      fanCount: fc.length,
    };
    if (pole > 0) this.polarGeom.north = g;
    else this.polarGeom.south = g;
    return g;
  }

  // 现在画的是极地的场景（球面上的 Voronoi）：鼠标下的格按球面上真正最近的格取（与画出来的一致）
  polarPick(): boolean {
    return !!(this.planet && this.camera.proj && this.projScene?.pole);
  }

  // 投影的合成程序（第一次用到时才编译）
  private projProgram(): WebGLProgram {
    this.progProj ??= compileCompose(this.gl, FS_COMPOSE_PROJ);
    return this.progProj;
  }

  // 现在的投影场景（开发用的测速、测试看）
  get projectedScene(): ProjScene | null {
    return this.projScene;
  }

  // 回到等距圆柱：放掉投影的场景
  private leaveProjected() {
    if (this.projT) this.sizeTarget(this.projT, 1, 1);
    this.projScene = null;
    this.pIdKey = this.pTerrainKey = this.pTerrainStatic = this.pSeamKey = this.pComposeKey = '';
  }

  // 场景按 sc 画（编号层、地形层、切线层；同停稳的画法：哪一层的输入变了才重画那一层，幽灵海岸只重画改了的几格那一块）
  private drawProjScene(t: SceneTarget, sc: ProjScene, kmPerUnit: number, hasSeams: boolean, force: boolean) {
    const gl = this.gl;
    const coastAmp = this.ghostAmp ?? this.coastAmp;
    if (this.sizeTarget(t, sc.W, sc.H)) force = true;
    const idKey = `${this.meshVersion}|${sc.key}`;
    const terrainStatic = `${idKey}|${this.detail}|${coastAmp}|${kmPerUnit}`;
    const terrainKey = `${terrainStatic}|${this.layersVersion}`;
    const seamKey = hasSeams ? `${sc.key}|${this.seamVersion}` : '';
    const cx = (sc.x0 + sc.x1) / 2;
    const halfW = (sc.x1 - sc.x0) / 2;
    const [copy0, copies] = this.copiesFor(cx, halfW);
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, sc.W, sc.H);
    if (force || idKey !== this.pIdKey) {
      this.pIdKey = idKey;
      this.drawId(t, sc.view, copy0, copies, sc.pole);
    }
    if (force || terrainKey !== this.pTerrainKey) {
      // 幽灵海岸只改了几格：只重画那几格的一块（极地的场景整张重画）
      const rects = !force && !sc.pole && terrainStatic === this.pTerrainStatic && this.dirtyCells !== 'full' ? this.dirtyRects(this.dirtyCells, sc.view, sc.W, sc.H) : null;
      this.pTerrainKey = terrainKey;
      this.pTerrainStatic = terrainStatic;
      this.dirtyCells = new Set();
      this.drawTerrain(t, sc.view, 1 / Math.max(sc.zx, sc.zy), copy0, copies, coastAmp, kmPerUnit, rects, sc.pole);
    }
    if (hasSeams && (force || seamKey !== this.pSeamKey)) {
      this.pSeamKey = seamKey;
      this.drawSeams(t, sc.view, cx, halfW, sc.pole);
    }
  }

  // 投影的画法：要的范围、密度（sceneNeed）→ 现在的场景还能用就只重新合成（转动球、平移时多半如此），
  // 不能用就按要的重画一块（移动中密度打五折、四周多画一圈）。合成按每个像素反算投影；移动中按低分辨率合成再放大
  private renderProjected(kmPerUnit: number, moving: boolean) {
    const gl = this.gl;
    const mesh = this.mesh!;
    const cam = this.camera;
    const proj = cam.proj!;
    const cw = this.canvas.clientWidth || 1;
    const ch = this.canvas.clientHeight || 1;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const dpr = w / cw || 1;
    // 等距圆柱的两组场景先放掉（占显存）；回到等距圆柱时重新分配、重画
    if (this.rest.w > 1 || this.moving.w > 1) {
      this.sizeTarget(this.rest, 1, 1);
      this.sizeTarget(this.moving, 1, 1);
      this.movingScene = null;
      this.idKey = this.terrainKey = this.terrainStatic = this.seamKey = this.composeKey = '';
    }
    this.projT ??= this.makeTarget();
    const t = this.projT;
    const hasSeams = this.hasGroup && this.seamCount > 0;
    const need = sceneNeed({ ...cam, proj }, cw, ch, 3 * mesh.spacing);
    let sc = this.projScene;
    if (need) {
      const dn = { ...need, zx: need.zx * dpr, zy: need.zy * dpr };
      if (!sc || !sceneFits(sc, dn, moving ? 0.45 : 0.9, moving ? Infinity : 2.2)) {
        const limit = Math.min(this.exportLimit(), 8192);
        const budget = Math.min(8e6, Math.max(2.5e6, 1.3 * w * h)) * (moving ? 0.5 : 1);
        sc = planScene(dn, moving ? 0.5 : 1, moving ? MOTION_MARGIN : 0.1, limit, budget);
        this.projScene = sc;
        this.motionEpoch++;
      }
    }
    if (sc) this.drawProjScene(t, sc, kmPerUnit, hasSeams, false);
    // 合成
    const k = moving ? dpr * MOTION_SCALE : dpr;
    const ow = moving ? Math.max(1, Math.round(cw * k)) : w;
    const oh = moving ? Math.max(1, Math.round(ch * k)) : h;
    const z1 = cam.zoom * k;
    const sx = (2 * z1) / ow;
    const sy = (-2 * z1) / oh;
    const view: V4 = [sx, sy, -cam.x * sx, -cam.y * sy];
    const relief = this.reliefAt(effectiveZoom(cam));
    const river = sc ? (this.riverLayer?.(moving, { x0: sc.x0, y0: sc.y0, zx: sc.zx, zy: sc.zy, W: sc.W, H: sc.H, dpr, pole: sc.pole, key: sc.key }) ?? null) : null;
    const riverKey = river ? `${river.version}|${river.toUv.join(',')}` : '';
    const pj: ProjCompose | null = sc ? { proj, scene: sc, planePx: z1, outside: PROJ_BG } : null;
    if (!moving) {
      // 描格不在键里（第三十九轮）：变了时只重画那几块
      const key = `${this.pTerrainKey}|${this.pSeamKey}|${sc?.key}|${w}x${h}|${dpr}|${cam.x}|${cam.y}|${cam.zoom}|${proj.kind}|${proj.lon0}|${proj.lat0}|${this.highlightVersion}|${this.groupVersion}|${this.modeVersion}|${this.fxVersion}|${this.tintVersion}|${mapStyleKey(this.style)}|${relief}|${this.flatByGroup}|${this.highlightByGroup}|${this.provinceScale}|${this.provinceAlpha}|${this.countryAlpha}|${riverKey}`;
      if (key === this.pComposeKey) {
        if (this.focusKey !== this.focusDrawn.key) {
          if (!pj) {
            this.focusDrawn = { key: this.focusKey, rects: [] };
            return;
          }
          gl.disable(gl.BLEND);
          gl.viewport(0, 0, w, h);
          this.composeFocus(this.focusRects(view, w, h, pj), (rects) => this.compose(null, t, view, [1, 1, 0, 0], [1 / w, 1 / h], 0, 1, 1, relief, hasSeams, this.useRiver(river), pj, rects));
        } else this.perf?.note('compose:none');
        return;
      }
      this.pComposeKey = key;
      this.perf?.note('compose:full');
    } else this.pComposeKey = '';
    if (!sc) {
      // 画面上没有地图（镜头在投影外面）：只有背景
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, w, h);
      gl.clearColor(PROJ_BG[0], PROJ_BG[1], PROJ_BG[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      this.focusDrawn = { key: this.focusKey, rects: [] };
      return;
    }
    if (!pj) return;
    if (moving) {
      if (this.out.w !== ow || this.out.h !== oh) {
        this.out.w = ow;
        this.out.h = oh;
        gl.bindTexture(gl.TEXTURE_2D, this.out.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, ow, oh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.out.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.out.tex, 0);
      }
      gl.viewport(0, 0, ow, oh);
      this.compose(this.out.fbo, t, view, [1, 1, 0, 0], [1 / ow, 1 / oh], 0, w / ow, 1, relief, hasSeams, this.useRiver(river), pj);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.out.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      gl.blitFramebuffer(0, 0, ow, oh, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.LINEAR);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return;
    }
    gl.viewport(0, 0, w, h);
    this.compose(null, t, view, [1, 1, 0, 0], [1 / w, 1 / h], 0, 1, 1, relief, hasSeams, this.useRiver(river), pj);
    this.focusDrawn = { key: this.focusKey, rects: this.focusRects(view, w, h, pj) };
  }

  // 导出整张地图（投影）：先按整张图要的密度画一块场景（整圈），再一块块合成。cam 是虚拟镜头（CSS 像素），
  // 整张图 W × H 像素、每个 CSS 像素 dpr 个。tile(x, y, T) 返回那一块 T × T 的 RGBA（从上到下）；投影之外透明。
  // river：按场景那一块画河（MapView 给）；用完 releaseExport
  beginProjectedExport(kmPerUnit: number, cam: Camera & { proj: Proj }, W: number, H: number, dpr: number, river: ((s: RiverScene) => RiverTex | null) | null): { scene: ProjScene; tile: (x: number, y: number, T: number) => Uint8Array } {
    const gl = this.gl;
    const mesh = this.mesh;
    if (!mesh || !this.triVao || !this.fanVao) throw new Error('还没有地图');
    const need = sceneNeed(cam, W / dpr, H / dpr, 3 * mesh.spacing);
    if (!need) throw new Error('图上没有地图');
    const limit = Math.min(this.exportLimit(), 16384);
    const sc = planScene({ ...need, zx: need.zx * dpr, zy: need.zy * dpr }, 1, 0, limit, 12e6);
    if (!this.exp) this.exp = { scene: this.makeTarget(), fbo: gl.createFramebuffer()!, tex: this.makeTex(), w: 0, h: 0 };
    const E = this.exp;
    const hasSeams = this.hasGroup && this.seamCount > 0;
    // 导出用的场景目标：键另记（不碰屏幕上的那一份）
    const keys = [this.pIdKey, this.pTerrainKey, this.pTerrainStatic, this.pSeamKey];
    const dirty = this.dirtyCells;
    this.dirtyCells = 'full';
    this.drawProjScene(E.scene, sc, kmPerUnit, hasSeams, true);
    [this.pIdKey, this.pTerrainKey, this.pTerrainStatic, this.pSeamKey] = keys;
    this.dirtyCells = dirty;
    this.pComposeKey = '';
    const rt = river ? this.useRiver(river({ x0: sc.x0, y0: sc.y0, zx: sc.zx, zy: sc.zy, W: sc.W, H: sc.H, dpr, pole: sc.pole, key: `export|${sc.key}` })) : null;
    const relief = this.reliefAt(effectiveZoom(cam));
    const Z = cam.zoom * dpr;
    const pj: ProjCompose = { proj: cam.proj, scene: sc, planePx: Z, outside: [0, 0, 0, 0] };
    const tile = (x: number, y: number, T: number) => {
      if (E.w !== T || E.h !== T) {
        E.w = T;
        E.h = T;
        gl.bindTexture(gl.TEXTURE_2D, E.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, T, T, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.bindFramebuffer(gl.FRAMEBUFFER, E.fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, E.tex, 0);
      }
      // 平面 → 这一块的裁剪空间：像素 = (平面 − 镜头) · Z + 整张图的中心 − 这一块的左上角
      const sx = (2 * Z) / T;
      const sy = (-2 * Z) / T;
      const view: V4 = [sx, sy, ((-cam.x * Z + W / 2 - x) * 2) / T - 1, 1 - ((-cam.y * Z + H / 2 - y) * 2) / T];
      gl.disable(gl.BLEND);
      gl.viewport(0, 0, T, T);
      this.compose(E.fbo, E.scene, view, [1, 1, 0, 0], [1 / T, 1 / T], 0, 1, 1, relief, hasSeams, rt, pj);
      const px = new Uint8Array(T * T * 4);
      gl.readPixels(0, 0, T, T, gl.RGBA, gl.UNSIGNED_BYTE, px);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const out = new Uint8Array(px.length);
      const row = T * 4;
      for (let r = 0; r < T; r++) out.set(px.subarray((T - 1 - r) * row, (T - r) * row), r * row);
      return out;
    };
    return { scene: sc, tile };
  }

  // ---------- 导出整张地图（.png）：离屏一块块画，读回像素 ----------

  // 一块场景（T + 2m）最大多少像素：纹理、渲染缓冲、视口的上限里最小的
  exportLimit(): number {
    const gl = this.gl;
    const vp = gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array;
    return Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) as number, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE) as number, vp[0], vp[1]);
  }

  // 导出用的一组场景目标与合成画面（画完 releaseExport 放掉）
  private exp: { scene: SceneTarget; fbo: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number } | null = null;

  // 按停稳的画法（全分辨率，同样的着色器）画一块：tv 见 export-plan.ts 的 tileView；zoom 是虚拟镜头的缩放（CSS 像素 / 地图单位），
  // dpr 是每个 CSS 像素合几个图上的像素。返回 T × T 的 RGBA，从上到下一行行。
  // 画的是渲染器现在的图层（调用方先换成干净的：不带高亮、预览、幽灵海岸）；屏幕上的画布、停稳时的场景不动
  // river：这一块的河（overlay.ts 的 riverLayerTile），null 不画
  renderTile(kmPerUnit: number, tv: { scene: V4; out: V4; xf: V4; cx: number; halfW: number; S: number }, T: number, zoom: number, dpr: number, river: RiverTex | null = null): Uint8Array {
    const gl = this.gl;
    const mesh = this.mesh;
    if (!mesh || !this.triVao || !this.fanVao) throw new Error('还没有地图');
    if (!this.exp) {
      this.exp = { scene: this.makeTarget(), fbo: gl.createFramebuffer()!, tex: this.makeTex(), w: 0, h: 0 };
    }
    const E = this.exp;
    this.sizeTarget(E.scene, tv.S, tv.S);
    if (E.w !== T || E.h !== T) {
      E.w = T;
      E.h = T;
      gl.bindTexture(gl.TEXTURE_2D, E.tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, T, T, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, E.fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, E.tex, 0);
    }
    const Z = zoom * dpr;
    const coastAmp = this.ghostAmp ?? this.coastAmp;
    const hasSeams = this.hasGroup && this.seamCount > 0;
    const [copy0, copies] = this.copiesFor(tv.cx, tv.halfW);
    gl.disable(gl.BLEND);
    gl.viewport(0, 0, tv.S, tv.S);
    this.drawId(E.scene, tv.scene, copy0, copies);
    this.drawTerrain(E.scene, tv.scene, 1 / Z, copy0, copies, coastAmp, kmPerUnit, null);
    if (hasSeams) this.drawSeams(E.scene, tv.scene, tv.cx, tv.halfW);
    gl.viewport(0, 0, T, T);
    this.compose(E.fbo, E.scene, tv.out, tv.xf, [1 / T, 1 / T], mesh.spacing * Z, 1, 1, this.reliefAt(zoom), hasSeams, this.useRiver(river));
    const px = new Uint8Array(T * T * 4);
    gl.readPixels(0, 0, T, T, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // GL 的第 0 行在下面：倒过来
    const out = new Uint8Array(px.length);
    const row = T * 4;
    for (let r = 0; r < T; r++) out.set(px.subarray((T - 1 - r) * row, (T - r) * row), r * row);
    return out;
  }

  releaseExport() {
    const E = this.exp;
    if (!E) return;
    const gl = this.gl;
    const s = E.scene;
    for (const t of [s.color, s.height, s.id, s.seam, E.tex]) gl.deleteTexture(t);
    for (const f of [s.fbo, s.fboId, s.fboSeam, E.fbo]) gl.deleteFramebuffer(f);
    gl.deleteRenderbuffer(s.depth);
    this.exp = null;
  }

  // 1. 编号层
  // pole：极地的场景（球面上的 Voronoi，以极点为中心的平面）
  private drawId(t: SceneTarget, view: V4, copy0: number, copies: number, pole: 0 | 1 | -1 = 0) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fboId);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    if (pole) {
      const g = this.polarGeometry(pole);
      const prog = this.polarPrograms().id;
      gl.useProgram(prog);
      gl.uniform4fv(this.loc(prog, 'uView'), view);
      gl.uniform1f(this.loc(prog, 'uPole'), pole);
      gl.bindVertexArray(g.fan);
      gl.drawArrays(gl.TRIANGLES, 0, g.fanCount);
      return;
    }
    const pp = this.planet ? this.planetProgs : null;
    const pid = pp ? pp.id : this.progId;
    gl.useProgram(pid);
    gl.uniform4fv(this.loc(pid, 'uView'), view);
    // 编号层的顶点着色器（VS_ID）不读纹理：不必绑，也不会与写入目标形成反馈环
    gl.bindVertexArray(this.fanVao);
    if (pp) {
      gl.uniform1i(this.loc(pid, 'uCopy0'), copy0);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, this.fanCount, copies);
    } else gl.drawArrays(gl.TRIANGLES, 0, this.fanCount);
  }

  // 2. 地形层。pixel：一个目标像素合多少地图单位。rects：只重画这几块（设备像素，GL 的 y 向上）；null 整张
  private drawTerrain(t: SceneTarget, view: V4, pixel: number, copy0: number, copies: number, coastAmp: number, kmPerUnit: number, rects: Rect[] | null, pole: 0 | 1 | -1 = 0) {
    const gl = this.gl;
    const mesh = this.mesh!;
    if (rects && !rects.length) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    const pp = this.planet ? this.planetProgs : null;
    const pt = pole ? this.polarPrograms().terrain : pp ? pp.terrain : this.progTerrain;
    gl.useProgram(pt);
    gl.uniform4fv(this.loc(pt, 'uView'), view);
    gl.uniform1f(this.loc(pt, 'uSpacing'), mesh.spacing);
    gl.uniform1f(this.loc(pt, 'uCoastAmp'), coastAmp);
    gl.uniform1f(this.loc(pt, 'uDetail'), this.detail);
    gl.uniform1f(this.loc(pt, 'uPixel'), pixel);
    gl.uniform1f(this.loc(pt, 'uMetersPerUnit'), kmPerUnit * 1000);
    this.bindTex(pt, 'uColor', this.tex.color, 0);
    this.bindTex(pt, 'uElev', this.tex.elev, 1);
    this.bindTex(pt, 'uCoast', this.tex.coast, 2);
    this.bindTex(pt, 'uGrad', this.tex.grad, 3);
    this.bindTex(pt, 'uOther', this.tex.other, 4);
    this.bindTex(pt, 'uSeaGrad', this.tex.seaGrad, 5);
    this.bindTex(pt, 'uLith', this.tex.lith, 6);
    this.bindTex(pt, 'uFj', this.tex.fj, 7);
    gl.uniform1f(this.loc(pt, 'uSat'), this.rock ? 1.1 : 1);
    gl.uniform1i(this.loc(pt, 'uSeaData'), this.seaData ? 1 : 0);
    const polar = pole ? this.polarGeometry(pole) : null;
    gl.bindVertexArray(polar ? polar.tri : this.triVao);
    if (pp) {
      gl.uniform1i(this.loc(pt, 'uCopy0'), copy0);
      gl.uniform1f(this.loc(pt, 'uNoiseK'), 1 / (Math.PI * mesh.spacing));
    }
    if (polar) gl.uniform1f(this.loc(pt, 'uPole'), pole);
    this.perf?.gpuBegin('terrain');
    if (rects) gl.enable(gl.SCISSOR_TEST);
    for (const r of rects ?? [null]) {
      if (r) gl.scissor(r[0], r[1], r[2], r[3]);
      gl.clearBufferfv(gl.COLOR, 0, [0.08, 0.1, 0.14, 0]);
      gl.clearBufferfv(gl.COLOR, 1, [-4000, -1, 0, 0]);
      if (polar) gl.drawArrays(gl.TRIANGLES, 0, polar.triCount);
      else if (pp) gl.drawArraysInstanced(gl.TRIANGLES, 0, this.triCount, copies);
      else gl.drawArrays(gl.TRIANGLES, 0, this.triCount);
    }
    gl.disable(gl.SCISSOR_TEST);
    this.perf?.gpuEnd('terrain');
  }

  // 3. 切线层：每段画一个长方形，片元算到段的距离与在哪一边，近的胜（深度测试 LESS，同样近时先画的段号小的胜）
  private drawSeams(t: SceneTarget, view: V4, camX: number, halfW: number, pole: 0 | 1 | -1 = 0) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fboSeam);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.DEPTH, 0, [1]);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.depthMask(true);
    const ps = pole ? this.polarPrograms().seam : this.progSeam;
    gl.useProgram(ps);
    gl.uniform4fv(this.loc(ps, 'uView'), view);
    gl.uniform1f(this.loc(ps, 'uBand'), this.seamBand);
    if (pole) gl.uniform1f(this.loc(ps, 'uPole'), pole);
    gl.bindVertexArray(this.seamVao);
    // 整个星球：线（经度展开后可能超出 [0, 2)）在屏幕上看得见的那几份（极地的场景只要一份）
    let k0 = 0;
    let k1 = 0;
    if (this.planet && !pole) {
      k0 = Math.ceil((camX - halfW - this.seamX[1] - this.seamBand) / 2);
      k1 = Math.min(k0 + 6, Math.floor((camX + halfW - this.seamX[0] + this.seamBand) / 2));
    }
    for (let k = k0; k <= k1; k++) {
      gl.uniform1f(this.loc(ps, 'uShift'), 2 * k);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.seamCount);
    }
    gl.disable(gl.DEPTH_TEST);
  }

  // 4. 合成：画进 fb（null 是画布）。xf：画面上的位置 → 场景 t 上的位置；texel：画面一个像素（0–1）；
  // cellPx：一格合画面几个像素；pxScale：画面一个像素合几个屏幕像素；scenePx：场景一个像素合几个屏幕像素
  // river：已上传的河的图层（null 不画）
  // pj：等面积、球形投影（view 是投影平面 → 画面，场景 t 是 pj.scene 那一块等距圆柱）
  // rects：只画这几块（描格那一遍，第三十九轮）；null 整张
  private compose(fb: WebGLFramebuffer | null, t: SceneTarget, view: V4, xf: V4, texel: [number, number], cellPx: number, pxScale: number, scenePx: number, relief: number, hasSeams: boolean, river: RiverTex | null, pj: ProjCompose | null = null, rects: Rect[] | null = null) {
    const gl = this.gl;
    const mesh = this.mesh!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    if (fb) gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    const pp = this.planet ? this.planetProgs : null;
    const pc = pj ? this.projProgram() : pp ? pp.compose : this.progCompose;
    gl.useProgram(pc);
    if (pj) {
      const p = pj.proj;
      const S = pj.scene;
      gl.uniform1i(this.loc(pc, 'uProj'), p.kind === 'globe' ? 2 : 1);
      gl.uniform4f(this.loc(pc, 'uProjP'), p.lon0, Math.sin(p.lat0), Math.cos(p.lat0), 0);
      gl.uniform2f(this.loc(pc, 'uPx'), texel[0], texel[1]);
      gl.uniform2f(this.loc(pc, 'uSceneZ'), S.zx, S.zy);
      gl.uniform4fv(this.loc(pc, 'uSceneView'), S.view);
      gl.uniform1f(this.loc(pc, 'uSceneX0'), S.x0);
      gl.uniform1f(this.loc(pc, 'uScenePole'), S.pole);
      gl.uniform4fv(this.loc(pc, 'uOutside'), pj.outside);
      gl.uniform1f(this.loc(pc, 'uPlanePx'), pj.planePx);
    }
    if (pp) gl.uniform1f(this.loc(pc, 'uNoiseK'), 1 / (Math.PI * mesh.spacing));
    this.bindTex(pc, 'uSceneColor', t.color, 0);
    this.bindTex(pc, 'uSceneHeight', t.height, 1);
    this.bindTex(pc, 'uIdTex', t.id, 2);
    this.bindTex(pc, 'uFlat', this.tex.flat, 3);
    this.bindTex(pc, 'uHighlight', this.tex.highlight, 4);
    this.bindTex(pc, 'uGroup', this.tex.group, 5);
    this.bindTex(pc, 'uSeam', t.seam, 6);
    this.bindTex(pc, 'uSegData', this.tex.segData, 7);
    gl.uniform1i(this.loc(pc, 'uHasSeams'), hasSeams ? 1 : 0);
    gl.uniform1i(this.loc(pc, 'uFlatByGroup'), this.flatByGroup ? 1 : 0);
    gl.uniform1i(this.loc(pc, 'uHighlightByGroup'), this.highlightByGroup ? 1 : 0);
    gl.uniform2f(this.loc(pc, 'uTexel'), texel[0], texel[1]);
    gl.uniform4fv(this.loc(pc, 'uView'), view);
    gl.uniform4fv(this.loc(pc, 'uSceneXf'), xf);
    gl.uniform1f(this.loc(pc, 'uPxScale'), pxScale);
    gl.uniform1f(this.loc(pc, 'uScenePx'), scenePx);
    gl.uniform1f(this.loc(pc, 'uSpacing'), mesh.spacing);
    gl.uniform1f(this.loc(pc, 'uRelief'), relief);
    gl.uniform1f(this.loc(pc, 'uCellPx'), cellPx);
    gl.uniform1f(this.loc(pc, 'uProvScale'), this.provinceScale);
    gl.uniform1f(this.loc(pc, 'uProvAlpha'), this.provinceAlpha);
    gl.uniform1f(this.loc(pc, 'uCountryAlpha'), this.countryAlpha);
    gl.uniform1f(this.loc(pc, 'uShade'), this.shade);
    gl.uniform1f(this.loc(pc, 'uRock'), this.rock);
    const su = styleUniforms(this.style);
    gl.uniform4fv(this.loc(pc, 'uLandTint'), su.landTint);
    gl.uniform1i(this.loc(pc, 'uShadeTint'), su.shadeTint);
    gl.uniform3fv(this.loc(pc, 'uShadeDark'), su.shadeDark);
    gl.uniform3fv(this.loc(pc, 'uShadeLight'), su.shadeLight);
    gl.uniform1i(this.loc(pc, 'uSeaTiers'), su.seaTiers);
    gl.uniform3fv(this.loc(pc, 'uSeaTier'), su.seaTier);
    gl.uniform3fv(this.loc(pc, 'uSeaDepth'), su.seaDepth);
    gl.uniform4fv(this.loc(pc, 'uIsobath'), su.isobath);
    gl.uniform2fv(this.loc(pc, 'uSeaShade'), su.seaShade);
    gl.uniform2fv(this.loc(pc, 'uTierShade'), su.tierShade);
    gl.uniform1f(this.loc(pc, 'uGlowGain'), su.glowGain);
    gl.uniform4fv(this.loc(pc, 'uCoastLine'), su.coastLine);
    gl.uniform3fv(this.loc(pc, 'uProvLine'), su.provLine);
    gl.uniform3fv(this.loc(pc, 'uCountryLine'), su.countryLine);
    gl.uniform1i(this.loc(pc, 'uSeaData'), this.seaData ? 1 : 0);
    gl.uniform1i(this.loc(pc, 'uHasFlat'), this.hasFlat ? 1 : 0);
    gl.uniform1i(this.loc(pc, 'uHasGroup'), this.hasGroup ? 1 : 0);
    gl.uniform1i(this.loc(pc, 'uHasHighlight'), this.hasHighlight ? 1 : 0);
    // 描格（第三十七轮）：格号 · 2 + 陆 1 / 水 0；格心与半径（2.5 格以外的像素不算）
    const focus = this.focus.map((f) => (f && f.cell < mesh.n ? f : null));
    const fk = focus.map((f) => (f ? f.cell * 2 + (f.land ? 1 : 0) : -1));
    gl.uniform2i(this.loc(pc, 'uFocus'), fk[0], fk[1]);
    const fc = new Float32Array(6);
    focus.forEach((f, k) => {
      if (!f) return;
      fc[3 * k] = mesh.x[f.cell];
      fc[3 * k + 1] = mesh.y[f.cell];
      fc[3 * k + 2] = FOCUS_REACH * mesh.spacing;
    });
    gl.uniform3fv(this.loc(pc, 'uFocusC'), fc);
    gl.uniform1f(this.loc(pc, 'uFocusSphere'), this.planet ? 1 : 0);
    const hasFx = !!(this.fxShown.fx && this.fxShown.palette);
    this.bindTex(pc, 'uFx', this.tex.fx, 8);
    this.bindTex(pc, 'uFxPal', this.tex.fxPal, 9);
    gl.uniform1i(this.loc(pc, 'uHasFx'), hasFx ? 1 : 0);
    this.bindTex(pc, 'uTint', this.tex.tint, 10);
    this.bindTex(pc, 'uLandCell', this.tex.landCell, 14);
    this.bindTex(pc, 'uCountry', this.tex.country, 13);
    gl.uniform1i(this.loc(pc, 'uHasCountry'), this.hasCountry ? 1 : 0);
    gl.uniform1i(this.loc(pc, 'uHasLandCell'), this.hasLandCell ? 1 : 0);
    gl.uniform1i(this.loc(pc, 'uHasTint'), this.tintShown ? 1 : 0);
    this.bindTex(pc, 'uCellCoast', this.tex.cellCoast, 11);
    this.bindTex(pc, 'uRiver', this.tex.river, 12);
    gl.uniform1i(this.loc(pc, 'uHasRiver'), river ? 1 : 0);
    if (river && pj) {
      // 投影：河的图层画在场景那一块上（同样的范围、大小），按场景上的位置取
      gl.uniform4f(this.loc(pc, 'uRiverXf'), 1, 1, 0, 0);
    } else if (river) {
      // 画面上的位置（0–1）→ 地图单位 → 河的那张图上的位置（双精度在这里算好，着色器里只乘加一次）
      const [a, b, c, d] = river.toUv;
      gl.uniform4f(this.loc(pc, 'uRiverXf'), (2 * a) / view[0], (2 * c) / view[1], ((-1 - view[2]) / view[0]) * a + b, ((-1 - view[3]) / view[1]) * c + d);
    }
    // 离边界远的格（第三十九轮）：图层、ρ 都有，显示的分组就是那一份（没有省份预览、幽灵海岸），投影时只在等距圆柱、整圈的场景里
    const nearOn = !!(this.nearShown && this.nearRho && this.groupShown === this.groupBase && this.seamsShown === this.seamsBase && !this.ghostRows.length && (!pj || (!pj.scene.pole && pj.scene.full)));
    this.bindTex(pc, 'uNear', this.tex.near, 15);
    gl.uniform1i(this.loc(pc, 'uNearOn'), nearOn ? 1 : 0);
    if (nearOn) gl.uniform1fv(this.loc(pc, 'uNearRho'), this.nearRho!);
    gl.bindVertexArray(null);
    const label = rects ? 'focus' : 'compose';
    this.perf?.gpuBegin(label);
    if (rects) {
      gl.enable(gl.SCISSOR_TEST);
      for (const r of rects) {
        gl.scissor(r[0], r[1], r[2], r[3]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.SCISSOR_TEST);
    } else gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.perf?.gpuEnd(label);
  }

  // 幽灵海岸改了的这几格：地形层要重画的几块（设备像素，GL 的 y 向上，四周多 2 像素）。
  // 这几格的三角形盖住的范围（cellBox）就是它们会变的全部像素；太多、跨得太宽时返回 null（整张重画）
  private dirtyRects(cells: Set<number>, view: V4, w: number, h: number): Rect[] | null {
    const mesh = this.mesh!;
    const box = this.cellBox;
    if (!box || cells.size > mesh.n / 8) return null;
    if (!cells.size) return [];
    const sphere = this.planet;
    let ref = Number.NaN;
    let x0 = Infinity;
    let x1 = -Infinity;
    let y0 = Infinity;
    let y1 = -Infinity;
    for (const c of cells) {
      let x = mesh.x[c];
      // 整个星球：经度在第一格附近展开
      if (sphere) {
        if (Number.isNaN(ref)) ref = x;
        x = ref + (x - ref - 2 * Math.round((x - ref) / 2));
      }
      x0 = Math.min(x0, x + box[4 * c]);
      x1 = Math.max(x1, x + box[4 * c + 1]);
      y0 = Math.min(y0, mesh.y[c] + box[4 * c + 2]);
      y1 = Math.max(y1, mesh.y[c] + box[4 * c + 3]);
    }
    if (sphere && x1 - x0 > 1) return null;
    const px = (x: number) => (x * view[0] + view[2] + 1) * 0.5 * w;
    const py = (y: number) => (y * view[1] + view[3] + 1) * 0.5 * h;
    const bottom = Math.max(0, Math.floor(py(y1)) - 2);
    const top = Math.min(h, Math.ceil(py(y0)) + 2);
    if (top <= bottom) return [];
    // 整个星球：每一份副本（左右相隔 2）上各一块
    let m0 = 0;
    let m1 = 0;
    if (sphere) {
      const period = view[0] * w;
      m0 = Math.ceil((-2 - px(x1)) / period);
      m1 = Math.floor((w + 2 - px(x0)) / period);
    }
    const rects: Rect[] = [];
    for (let m = m0; m <= m1 && rects.length < 8; m++) {
      const left = Math.max(0, Math.floor(px(x0 + 2 * m)) - 2);
      const right = Math.min(w, Math.ceil(px(x1 + 2 * m)) + 2);
      if (right > left) rects.push([left, bottom, right - left, top - bottom]);
    }
    return rects;
  }

  private bindTex(prog: WebGLProgram, name: string, tex: WebGLTexture, unit: number) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.loc(prog, name), unit);
  }

  // 屏幕坐标（CSS 像素，相对画布）→ 地图单位
  // 屏幕坐标（CSS 像素，相对画布）→ 地图单位。投影时在投影之外给最近的边上的一点（是不是在地图上看 pick）
  screenToWorld(px: number, py: number): [number, number] {
    const c = this.camera;
    if (this.planet && c.proj) {
      const p = projScreenToWorld(c, this.canvas.clientWidth, this.canvas.clientHeight, px, py);
      return [p.x, p.y];
    }
    return [c.x + (px - this.canvas.clientWidth / 2) / c.zoom, c.y + (py - this.canvas.clientHeight / 2) / c.zoom];
  }

  // 屏幕上的一点在不在投影之内（等距圆柱时总是 true，南北、东西之内由调用方另看）
  onProjection(px: number, py: number): boolean {
    const c = this.camera;
    return !(this.planet && c.proj) || projScreenToWorld(c, this.canvas.clientWidth, this.canvas.clientHeight, px, py).inside;
  }

  // 地图单位 → 屏幕坐标；投影时球的背面给 NaN
  worldToScreen(x: number, y: number): [number, number] {
    const c = this.camera;
    if (this.planet && c.proj) return projWorldToScreen(c, this.canvas.clientWidth, this.canvas.clientHeight, x, y) ?? [Number.NaN, Number.NaN];
    return [(x - c.x) * c.zoom + this.canvas.clientWidth / 2, (y - c.y) * c.zoom + this.canvas.clientHeight / 2];
  }

  // 整张图放进画布；inset：四周被浮层挡住、要留出来的边（CSS 像素）。投影时放进的是投影的整个形状（朝向不变）
  fit(mesh: Mesh, inset = { top: 0, right: 0, bottom: 0, left: 0 }) {
    const cw = Math.max(100, (this.canvas.clientWidth || 800) - inset.left - inset.right);
    const ch = Math.max(100, (this.canvas.clientHeight || 600) - inset.top - inset.bottom);
    const proj = mesh.kind === 'sphere' ? this.camera.proj : undefined;
    if (proj) {
      const [u0, u1, v0, v1] = planeBounds(proj);
      const zoom = Math.min(cw / (u1 - u0), ch / (v1 - v0)) * 0.98;
      this.camera = { x: (u0 + u1) / 2 - (inset.left - inset.right) / 2 / zoom, y: (v0 + v1) / 2 - (inset.top - inset.bottom) / 2 / zoom, zoom, proj };
      return;
    }
    const zoom = Math.min(cw / mesh.width, ch / mesh.height) * 0.98;
    this.camera = {
      x: mesh.width / 2 - (inset.left - inset.right) / 2 / zoom,
      y: mesh.height / 2 - (inset.top - inset.bottom) / 2 / zoom,
      zoom,
    };
  }
}

// 一块地图（设备像素的范围，GL 的 y 向上）→ 画面上的一块：四周多 3 个像素，边落在偶数上，夹在画面之内；空的不要
function pixelRect(x0: number, x1: number, y0: number, y1: number, w: number, h: number): Rect[] {
  const l = Math.max(0, 2 * Math.floor((Math.min(x0, x1) - 3) / 2));
  const r = Math.min(w, 2 * Math.ceil((Math.max(x0, x1) + 3) / 2));
  const b = Math.max(0, 2 * Math.floor((Math.min(y0, y1) - 3) / 2));
  const t = Math.min(h, 2 * Math.ceil((Math.max(y0, y1) + 3) / 2));
  return r > l && t > b ? [[l, b, r - l, t - b]] : [];
}

// 几块合并：两块的外接矩形不比两块加起来大时合成一块（鼠标跨到旁边一格时新旧两块大半重叠）
function mergeRects(list: Rect[]): Rect[] {
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
