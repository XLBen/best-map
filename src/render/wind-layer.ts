import type { World } from '../../core/world';
import { type Frame, MOTION_LAYER_MARGIN, MOTION_LAYER_SCALE, MOTION_LAYER_ZOOM, type OverlayState, overlayDebug, perf } from './overlay-base';
import { EE_K, GLOBE_G, POINT_COEFS, type Proj, effectiveZoom, inverse, pointCoefs, screenToPlane, worldToScreen, wrapLon } from './projection';
import type { Camera } from './renderer';
import { CURRENT_STYLE, type FlowLine, type FlowProject, WIND_STYLE, currentLines, dropWindQueue, strokeFlows, windEpoch, windLines } from './wind';

// 风与洋流的流线画到叠加层上（第四十六轮；第四十八轮起是图层里两个独立的开关，都关着时 OverlayState.wind / currents 为 false，这里一笔不画、一块不算，位图也放掉）。
// 三种投影都画：等距圆柱、一块地区直接按地图坐标画；等面积、球形按一个盖住看得见的经纬范围的等距圆柱镜头取线（同一套块的缓存），
// 逐点投影到屏幕上（球的背面、等面积的左右两边断开）。
// 位图：
//   - 停稳：画进一张与叠加层一样大的位图，镜头、场、季节、算好的块（windEpoch）都没变时只贴这张（鼠标移动、画笔拖动时不重描几千条线）
//   - 移动中：画进一张四周多出 MOTION_LAYER_MARGIN、半分辨率的位图，镜头还在边距之内、缩放没变太多、投影的朝向没变时挪一挪、缩一缩贴上
//     （等距圆柱、一块地区的平移缩放，投影里的缩放）；转球、转等面积的中央经线时朝向每帧都变，按移动中的画法（不描深色的边）直接画
//   - 导出整张地图、没有画布的环境（测试）：直接画

interface FlowBitmap {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  key: unknown[];
  cam: Camera;
}
let rest: FlowBitmap | null = null;
let moving: FlowBitmap | null = null;
// 上一次画的是哪几层（第四十八轮）；空串是都没开
let shown = '';

const hasCanvas = () => typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined';

function bitmap(old: FlowBitmap | null, w: number, h: number): FlowBitmap {
  if (old && old.canvas.width === w && old.canvas.height === h) return old;
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  return { canvas, ctx, key: [], cam: { x: 0, y: 0, zoom: 1 } };
}

const sameKey = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((v, i) => v === b[i]);

// 画什么（不含镜头）：场的数组、陆海（洋流碰到陆地停）、开关、季节、算好了几块
function flowKey(world: World, st: OverlayState): unknown[] {
  const d = world.derived;
  return [world.mesh, d.windSX, d.windSY, d.windWX, d.windWY, d.currentX, d.sstAnom, world.causes.land, st.wind, !!st.currents, st.wind ? st.flowSeason : null, windEpoch()];
}

// 测试用：位图的命中、重画次数
export const flowStats = { paints: 0, pastes: 0, direct: 0 };

// 画进 ctx（已清空的位图，或叠加层本身）：画布是 cw × ch 个 CSS 像素、每个 CSS 像素 dev 个设备像素，镜头在画布中间。
// light：不描深色的边（移动中直接画时）
function paint(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, world: World, cam: Camera, st: OverlayState, cw: number, ch: number, dev: number, light: boolean, lazy: (() => void) | undefined) {
  const c2 = ctx as CanvasRenderingContext2D;
  if (!cam.proj || world.mesh.kind !== 'sphere') {
    const z = cam.zoom * dev;
    ctx.setTransform(z, 0, 0, z, (cw / 2 - cam.x * cam.zoom) * dev, (ch / 2 - cam.y * cam.zoom) * dev);
    const size = { cw, ch };
    if (st.wind) strokeFlows(c2, windLines(world, cam, st.flowSeason, size, lazy), WIND_STYLE, 1 / z, undefined, Infinity, light);
    if (st.currents) strokeFlows(c2, currentLines(world, cam, size, lazy), CURRENT_STYLE, 1 / z, undefined, Infinity, light);
    return;
  }
  const pc = cam as Camera & { proj: Proj };
  const box = lonLatBox(pc, cw, ch);
  if (!box) return;
  // 盖住看得见的经纬范围的等距圆柱镜头：疏密按画面中心的比例
  const ez = effectiveZoom(pc);
  const vcam: Camera = { x: (box[0] + box[1]) / 2, y: (box[2] + box[3]) / 2, zoom: ez };
  const size = { cw: (box[1] - box[0]) * ez, ch: (box[3] - box[2]) * ez };
  ctx.setTransform(dev, 0, 0, dev, 0, 0);
  const project = projector(pc, cw, ch);
  // 线宽与等距圆柱一样按设备像素（一个 CSS 像素 dev 个）
  if (st.wind) strokeFlows(c2, windLines(world, vcam, st.flowSeason, size, lazy), WIND_STYLE, 1 / dev, project, 80, light);
  if (st.currents) strokeFlows(c2, currentLines(world, vcam, size, lazy), CURRENT_STYLE, 1 / dev, project, 80, light);
}

// 每条线每一点只取决于它自己的几个数（经纬度的三角函数、等面积的系数）：按线的点数组记一份，每帧只做乘加
// （与 projection.ts 的 forward 同一个算式，见 pointCoefs）
const coefs = new WeakMap<object, Float64Array>();
function coefsOf(pts: [number, number][]): Float64Array {
  let c = coefs.get(pts);
  if (!c) {
    c = new Float64Array(pts.length * POINT_COEFS);
    for (let k = 0; k < pts.length; k++) pointCoefs(pts[k][0], pts[k][1], c, k * POINT_COEFS);
    coefs.set(pts, c);
  }
  return c;
}

function projector(cam: Camera & { proj: Proj }, cw: number, ch: number): FlowProject {
  const p = cam.proj;
  const z = cam.zoom;
  const ox = cw / 2 - cam.x * z;
  const oy = ch / 2 - cam.y * z;
  if (p.kind === 'globe') {
    const cl0 = Math.cos(p.lon0);
    const sl0 = Math.sin(p.lon0);
    const s0 = Math.sin(p.lat0);
    const c0 = Math.cos(p.lat0);
    return (line: FlowLine, xs, ys, ok) => {
      const c = coefsOf(line.pts);
      let any = false;
      for (let k = 0, o = 0; k < line.pts.length; k++, o += POINT_COEFS) {
        // cos、sin(经度 − lon0)
        const cd = c[o + 1] * cl0 + c[o + 2] * sl0;
        const sd = c[o + 2] * cl0 - c[o + 1] * sl0;
        const sl = c[o + 3];
        const cl = c[o + 4];
        if (s0 * sl + c0 * cl * cd < 0) {
          ok[k] = 0;
          continue;
        }
        xs[k] = (1 + GLOBE_G * cl * sd) * z + ox;
        ys[k] = (0.5 - GLOBE_G * (c0 * sl - s0 * cl * cd)) * z + oy;
        ok[k] = 1;
        any = true;
      }
      return any;
    };
  }
  return (line: FlowLine, xs, ys, ok) => {
    const c = coefsOf(line.pts);
    for (let k = 0, o = 0; k < line.pts.length; k++, o += POINT_COEFS) {
      const l = wrapLon(c[o] - p.lon0);
      xs[k] = (1 + EE_K * l * c[o + 5]) * z + ox;
      ys[k] = (0.5 - EE_K * c[o + 6]) * z + oy;
      ok[k] = 1;
    }
    return true;
  };
}

// 投影时画面上看得见的范围（地图坐标 x0, x1, y0, y1；x 在中央经线附近展开，看得见极点时是整圈）。整个画面都在投影之外时为 null
function lonLatBox(cam: Camera & { proj: Proj }, cw: number, ch: number): [number, number, number, number] | null {
  const N = 14;
  const xc = 1 + cam.proj.lon0 / Math.PI;
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const [u, v] = screenToPlane(cam, cw, ch, (cw * i) / N, (ch * j) / N);
      const w = inverse(cam.proj, u, v);
      if (!w) continue;
      const x = xc + (w[0] - xc - 2 * Math.round((w[0] - xc) / 2));
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, w[1]);
      y1 = Math.max(y1, w[1]);
    }
  }
  // 球形：画面中心不在球上、网格点都落在球外（放得很大时）也取不到。这时按画面中心的一点
  if (!Number.isFinite(x0)) return null;
  const pad = 2 / N;
  const onScreen = (s: [number, number] | null) => !!s && s[0] >= 0 && s[0] <= cw && s[1] >= 0 && s[1] <= ch;
  if (onScreen(worldToScreen(cam, cw, ch, 1, 0))) y0 = 0;
  if (onScreen(worldToScreen(cam, cw, ch, 1, 1))) y1 = 1;
  if (y0 <= 0 || y1 >= 1 || x1 - x0 + 2 * pad >= 2) return [xc - 1, xc + 1, Math.max(0, y0 - pad / 2), Math.min(1, y1 + pad / 2)];
  return [x0 - pad, x1 + pad, Math.max(0, y0 - pad / 2), Math.min(1, y1 + pad / 2)];
}

// 测试用：两张位图还留着没有
export const flowBitmapsHeld = () => !!rest || !!moving;

// 两个开关都关了（第四十八轮）：放掉两张位图，丢掉排着的块（算好的块还在各自的缓存里，有上限，跟着世界一起没；再打开时不用重算）
export function releaseFlows() {
  if (!rest && !moving && !shown) return;
  rest = null;
  moving = null;
  shown = '';
  dropWindQueue();
}

// 叠加层里画风与洋流（ctx 的变换之后由调用的一方重设）
export function drawFlows(ctx: CanvasRenderingContext2D, world: World, cam: Camera, st: OverlayState, f: Frame) {
  if (!st.wind && !st.currents) return;
  // 开关变了（比如关了风、洋流还开着）：排着的块里可能有关掉的那一层的。丢掉，下面画的时候还要的会重新排
  const which = st.wind ? (st.currents ? 'both' : 'wind') : 'currents';
  if (which !== shown) {
    if (shown) dropWindQueue();
    shown = which;
  }
  const t0 = perf ? performance.now() : 0;
  const { cw, ch, dpr } = f;
  if (st.frame || !hasCanvas() || overlayDebug.noFlowBitmap) {
    flowStats.direct++;
    paint(ctx, world, cam, st, cw, ch, dpr, false, st.lazy);
  } else if (!st.motion) pasteRest(ctx, world, cam, st, f);
  else pasteMoving(ctx, world, cam, st, f);
  if (perf) perf.cpu('flows', performance.now() - t0);
}

function pasteRest(ctx: CanvasRenderingContext2D, world: World, cam: Camera, st: OverlayState, f: Frame) {
  const { cw, ch, dpr } = f;
  const canvas = ctx.canvas;
  const L = (rest = bitmap(rest, canvas.width, canvas.height));
  const p = cam.proj;
  const key = [...flowKey(world, st), cam.x, cam.y, cam.zoom, p?.kind, p?.lon0, p?.lat0, cw, ch, dpr];
  if (!sameKey(key, L.key)) {
    L.ctx.setTransform(1, 0, 0, 1, 0, 0);
    L.ctx.clearRect(0, 0, L.canvas.width, L.canvas.height);
    paint(L.ctx, world, cam, st, cw, ch, dpr, false, st.lazy);
    // 画的时候缺块（排进了队）：键里的 windEpoch 是旧的，算好以后 epoch 变了再画
    L.key = [...flowKey(world, st), cam.x, cam.y, cam.zoom, p?.kind, p?.lon0, p?.lat0, cw, ch, dpr];
    flowStats.paints++;
  } else flowStats.pastes++;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(L.canvas, 0, 0);
}

function pasteMoving(ctx: CanvasRenderingContext2D, world: World, cam: Camera, st: OverlayState, f: Frame) {
  const { cw, ch, dpr } = f;
  const lw = cw * (1 + 2 * MOTION_LAYER_MARGIN);
  const lh = ch * (1 + 2 * MOTION_LAYER_MARGIN);
  const dev = dpr * MOTION_LAYER_SCALE;
  const W = Math.max(1, Math.round(lw * dev));
  const H = Math.max(1, Math.round(lh * dev));
  const L = (moving = bitmap(moving, W, H));
  const p = cam.proj;
  const c0 = L.cam;
  const sameProj = (!p && !c0.proj) || (!!p && !!c0.proj && p.kind === c0.proj.kind && p.lon0 === c0.proj.lon0 && p.lat0 === c0.proj.lat0);
  // 转球、转中央经线：朝向每帧都变，挪位图不对。按移动中的画法直接画（新的块照样空闲时算）
  if (p && !sameProj && c0.proj) {
    L.cam = { ...cam };
    L.key = [];
    flowStats.direct++;
    paint(ctx, world, cam, st, cw, ch, dpr, true, st.lazy);
    return;
  }
  const key = [...flowKey(world, st), cw, ch, dpr];
  const fits = sameProj && cam.zoom / c0.zoom <= MOTION_LAYER_ZOOM && c0.zoom / cam.zoom <= MOTION_LAYER_ZOOM && Math.abs(cam.x - c0.x) + cw / 2 / cam.zoom <= lw / 2 / c0.zoom && Math.abs(cam.y - c0.y) + ch / 2 / cam.zoom <= lh / 2 / c0.zoom;
  if (!fits || !sameKey(key, L.key)) {
    L.ctx.setTransform(1, 0, 0, 1, 0, 0);
    L.ctx.clearRect(0, 0, W, H);
    paint(L.ctx, world, cam, st, lw, lh, dev, false, st.lazy);
    L.key = [...flowKey(world, st), cw, ch, dpr];
    L.cam = { ...cam };
    flowStats.paints++;
  } else flowStats.pastes++;
  // 位图的一个像素 → 叠加层的像素
  const c = L.cam;
  const a = (dpr * cam.zoom) / (dev * c.zoom);
  const bx = dpr * ((c.x - cam.x) * cam.zoom - (lw / 2) * (cam.zoom / c.zoom) + cw / 2);
  const by = dpr * ((c.y - cam.y) * cam.zoom - (lh / 2) * (cam.zoom / c.zoom) + ch / 2);
  ctx.setTransform(a, 0, 0, a, bx, by);
  ctx.drawImage(L.canvas, 0, 0);
}
