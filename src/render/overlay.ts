import { mapStyleKey } from '../../core/map-style';
import type { World } from '../../core/world';
import { type BackLayer, copiesFor, type Frame, frameOf, type LabelBox, makeLayer, MOTION_LAYER_MARGIN, MOTION_LAYER_SCALE, MOTION_LAYER_ZOOM, overlayDebug, type OverlayPaths, type OverlayState, perf, PROVINCE_LABEL_COLOR, refZoom, type Shape } from './overlay-base';
import { drawGraticule, drawLatitude, drawScaleBar } from './overlay-grid';
import { drawLabels, hasLabels } from './overlay-labels';
import { projectedParts } from './overlay-proj';
import { drawRivers } from './overlay-river-layer';
import { riverScale, riverStroke, samePathsKey } from './overlay-rivers';
import { drawShape, resetPen } from './overlay-shapes';
import { sameShapes, staticKey } from './overlay-static';
import type { Proj } from './projection';
import type { Camera } from './renderer';
import { drawRoads } from './settle-draw';
import { drawFlows, releaseFlows } from './wind-layer';

// 2D 画布上的矢量叠加：河流、河道引导、湖标记、风与洋流（wind-layer.ts）、画笔、箭头、预览路径、地名。
// 海岸线、省份边界、选区轮廓在着色器里画（自然曲线）。
// 路径按地图单位预先构建成 Path2D，绘制时只换变换矩阵，平移缩放很便宜。
// 第四十一轮拆成几个文件（代码原样搬），这里留底层的缓存、drawOverlay / overlayParts、屏幕上的静态那一层，并照旧导出全部：
//   overlay-base 类型、画布大小、地名的框、测速 · overlay-rivers 河线与路径 · overlay-river-layer 河的图层
//   overlay-static 静态的键 · overlay-grid 经纬网、比例尺 · overlay-shapes 工具的图形
//   overlay-labels 地名、山峰、城市 · overlay-country-labels 国名、片区名 · overlay-proj 投影时的画法
export { type OverlayPaths, type Shape, type ProvinceLabel, PROVINCE_LABEL_COLOR, type OverlayState, type Frame, refZoom, type LabelBox, overlayDebug, setOverlayPerf } from './overlay-base';
export { riverScale, riverStroke, riverTypeColor, riverDraws, type RiverStyleOverride, splitRiverLine, riverPathsKey, samePathsKey, riverLines, seedRivers, reseedRivers, buildPaths } from './overlay-rivers';
export { riverLayer, riverLayerTile, riverLayerScene, releaseRiverTile } from './overlay-river-layer';
export { overlayFieldKinds, staticKey, sameShapes } from './overlay-static';
export { drawScaleBar } from './overlay-grid';
export { hasLabels, SETTLE_KEY, placeLabels, drawLabels, PEAK_KEY, peakLabels } from './overlay-labels';
export { type CountryLabelDraw, COUNTRY_KEY, REGION_KEY, COUNTRY_MIN_PX, COUNTRY_MAX_PX, smoothPath, layoutAlong, countryLineText } from './overlay-country-labels';
// 一条要画的河（带子与每个河线点的类型）、一条河线画成要画的河：在 core/river-pack.ts（Worker 里描好的河也用它）
export type { RiverDraw } from '../../core/river-pack';
export { riverDraw } from '../../core/river-pack';

let restLayer: BackLayer | null = null;
let motionLayer: BackLayer | null = null;

// 底层的河与标记，画进 ctx：画布是 cw × ch 个 CSS 像素、每个 CSS 像素 dev 个像素，镜头在画布中间。
// 河只加画布上看得见的那几条（按外接框裁）
function drawBack(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, world: World, paths: OverlayPaths, cam: Camera, st: OverlayState, cw: number, ch: number, dev: number) {
  const z = cam.zoom * dev;
  const sphere = world.mesh.kind === 'sphere';
  const ks = sphere ? copiesFor(cam, cw) : [0];
  const setT = (k: number) => ctx.setTransform(z, 0, 0, z, (cw / 2 - (cam.x - 2 * k) * cam.zoom) * dev, (ch / 2 - cam.y * cam.zoom) * dev);
  const px = 1 / z;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (st.rivers) {
    drawRivers(ctx, world, paths, cam, st.style, cw, ch, dev);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }
  for (const k of ks) {
    setT(k);
    if (st.markers) {
      // 画过的河：细虚线标出走向是固定的
      ctx.setLineDash([5 * px * dev, 4 * px * dev]);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.lineWidth = 1.2 * px * dev;
      ctx.stroke(paths.guides);
      ctx.stroke(paths.lockedGuides);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeStyle = 'rgba(30,80,140,0.95)';
      ctx.lineWidth = 1.5 * px * dev;
      for (const l of world.small.lakes) {
        ctx.beginPath();
        ctx.arc(world.mesh.x[l.cell], world.mesh.y[l.cell], 4 * px * dev, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      // 在终点消失的河：终点一个空心小圈
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 1.5 * px * dev;
      for (const [x, y] of paths.sinks) {
        ctx.beginPath();
        ctx.arc(x, y, 3 * px * dev, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
}

// 底层的键（镜头另比）：画出来的路径、湖标记、选项、河流类型的画法
function backKey(world: World, paths: OverlayPaths, st: OverlayState): unknown[] {
  return [paths, world.small.lakes, world.mesh, st.rivers, st.markers, mapStyleKey(st.style), world.small.riverTypes, world.small.planet.riverThreshold];
}

// 把底层贴到叠加层上（ctx 已清空、变换是单位矩阵）
function pasteBack(ctx: CanvasRenderingContext2D, world: World, paths: OverlayPaths, cam: Camera, st: OverlayState) {
  const canvas = ctx.canvas;
  const { cw, ch, dpr } = frameOf(ctx, st);
  const key = backKey(world, paths, st);
  if (!st.rivers && !st.markers) return;
  // 导出整张地图：直接画，不碰缓存
  if (st.frame) {
    drawBack(ctx, world, paths, cam, st, cw, ch, dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return;
  }
  if (!st.motion) {
    if (!restLayer || restLayer.canvas.width !== canvas.width || restLayer.canvas.height !== canvas.height || restLayer.soft !== overlayDebug.softLayers || restLayer.dpr !== dpr)
      restLayer = makeLayer(canvas.width, canvas.height, dpr);
    const L = restLayer;
    const c = L.cam;
    if (st.exact || !samePathsKey(key, L.key) || c.x !== cam.x || c.y !== cam.y || c.zoom !== cam.zoom) {
      // 变了（停下后的第一帧、换了世界……）或导出图片：直接画在叠加层上，与原来逐像素相同。
      // （先画进缓存再贴回会差一点点：叠加层上河与后画的字在同一遍里抗锯齿，分两张画布画时字边上差 1–13 级）
      drawBack(ctx, world, paths, cam, st, cw, ch, dpr);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      L.key = key;
      L.cam = { ...cam };
      L.ready = false;
      return;
    }
    // 没变（画笔拖动、鼠标移动）：第二帧起画进缓存，之后只贴
    if (!L.ready) {
      L.ctx.setTransform(1, 0, 0, 1, 0, 0);
      L.ctx.clearRect(0, 0, L.canvas.width, L.canvas.height);
      drawBack(L.ctx, world, paths, cam, st, cw, ch, dpr);
      L.ctx.setTransform(1, 0, 0, 1, 0, 0);
      L.ready = true;
    }
    ctx.drawImage(L.canvas, 0, 0);
    return;
  }
  // 移动中
  const lw = cw * (1 + 2 * MOTION_LAYER_MARGIN);
  const lh = ch * (1 + 2 * MOTION_LAYER_MARGIN);
  const dev = dpr * MOTION_LAYER_SCALE;
  const W = Math.max(1, Math.round(lw * dev));
  const H = Math.max(1, Math.round(lh * dev));
  if (!motionLayer || motionLayer.canvas.width !== W || motionLayer.canvas.height !== H || motionLayer.soft !== overlayDebug.softLayers || motionLayer.dpr !== dpr) motionLayer = makeLayer(W, H, dpr);
  const L = motionLayer;
  const fits = (c: Camera) =>
    cam.zoom / c.zoom <= MOTION_LAYER_ZOOM && Math.abs(cam.x - c.x) + cw / 2 / cam.zoom <= lw / 2 / c.zoom && Math.abs(cam.y - c.y) + ch / 2 / cam.zoom <= lh / 2 / c.zoom;
  if (!samePathsKey(key, L.key) || !fits(L.cam) || (st.motionEpoch !== undefined && L.epoch !== st.motionEpoch)) {
    L.ctx.setTransform(1, 0, 0, 1, 0, 0);
    L.ctx.clearRect(0, 0, W, H);
    drawBack(L.ctx, world, paths, cam, st, lw, lh, dev);
    L.key = key;
    L.cam = { ...cam };
    L.epoch = st.motionEpoch;
  }
  // 底层的一个像素 → 叠加层的像素
  const c0 = L.cam;
  const a = (dpr * cam.zoom) / (dev * c0.zoom);
  const bx = dpr * ((c0.x - cam.x) * cam.zoom - (lw / 2) * (cam.zoom / c0.zoom) + cw / 2);
  const by = dpr * ((c0.y - cam.y) * cam.zoom - (lh / 2) * (cam.zoom / c0.zoom) + ch / 2);
  ctx.setTransform(a, 0, 0, a, bx, by);
  ctx.drawImage(L.canvas, 0, 0);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

// st.rivers：河画在叠加层上（测试、测速用；屏幕与导出的地图上河由渲染器合成，见 riverLayer，MapView 这里给 false）
// 第四十轮：分成三段（overlayParts：底下、工具的图形、上面）；屏幕上静态的键（staticKey：世界、路径、镜头、画布、除了图形以外的选项……）
// 与图形都没变时什么都不画（画布上就是上一帧），别的时候照原样直接画（见 drawScreen）。移动中、导出照原样直接画
export function drawOverlay(ctx: CanvasRenderingContext2D, world: World, paths: OverlayPaths, cam: Camera, st: OverlayState): LabelBox[] {
  const canvas = ctx.canvas;
  const f = frameOf(ctx, st);
  const { cw, ch, dpr } = f;
  if (!st.frame && (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr))) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  if (st.frame) return drawDirect(ctx, world, paths, cam, st, f);
  return drawScreen(ctx, world, paths, cam, st, f);
}

// 叠加层的三段：under（底下）、shapes（工具的图形）、over（上面，返回排好的地名的框）。三段依次画在同一张画布上就是原来的 drawOverlay
export interface OverlayParts {
  under(ctx: CanvasRenderingContext2D): void;
  shapes(ctx: CanvasRenderingContext2D): void;
  over(ctx: CanvasRenderingContext2D): LabelBox[];
}

// 直接画（原来的做法）：清空，三段依次画
function drawDirect(ctx: CanvasRenderingContext2D, world: World, paths: OverlayPaths, cam: Camera, st: OverlayState, f: Frame): LabelBox[] {
  const canvas = ctx.canvas;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (!st.frame) ctx.clearRect(0, 0, canvas.width, canvas.height);
  const parts = overlayParts(world, paths, cam, st, f);
  parts.under(ctx);
  parts.shapes(ctx);
  return parts.over(ctx);
}

export function overlayParts(world: World, paths: OverlayPaths, cam: Camera, st: OverlayState, f: Frame): OverlayParts {
  // 等面积、球形投影（第十三轮 G4）：另画（点按投影算，线加密后逐点投影）
  if (cam.proj && world.mesh.kind === 'sphere') return projectedParts(world, paths, cam as Camera & { proj: Proj }, st, f);
  const { cw, ch, dpr } = f;
  const z = cam.zoom * dpr;
  const sphere = world.mesh.kind === 'sphere';
  // 整个星球：每一份看得见的副本各画一遍（一块地区只有 k = 0）
  const ks = sphere ? copiesFor(cam, cw) : [0];
  // 地图单位 → 设备像素（第 k 份副本向右平移 2k）
  const setT = (ctx: CanvasRenderingContext2D, k: number) => ctx.setTransform(z, 0, 0, z, (cw / 2 - (cam.x - 2 * k) * cam.zoom) * dpr, (ch / 2 - cam.y * cam.zoom) * dpr);
  const px = 1 / z;
  const rz = refZoom(world, cam.zoom);
  const scale = riverScale(world, cam.zoom);
  const river = { scale, color: riverStroke(st.style) };
  return {
    under(ctx) {
      // 河、河道标记、湖标记（缓存着的底层）
      pasteBack(ctx, world, paths, cam, st);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      // 风向、洋流（第四十八轮：图层里的开关；停稳时贴位图，都关着时放掉位图和排着的块，见 wind-layer.ts）
      if (st.wind || st.currents) drawFlows(ctx, world, cam, st, f);
      else releaseFlows();
      setT(ctx, 0);
      if (st.latitude) {
        if (sphere) drawGraticule(ctx, cam, ks, f, !!st.frame);
        else drawLatitude(ctx, world, cam, st.latitude, f);
      }
      // 道路（第二十四轮）：工具的图形、地名下面
      if (st.roads) {
        const hw = cw / 2 / cam.zoom;
        const hh = ch / 2 / cam.zoom;
        drawRoads(ctx, st.roads, ks, (k) => setT(ctx, k), px * dpr, world.mesh.spacing * cam.zoom, st.style, { x0: cam.x - hw, x1: cam.x + hw, y0: cam.y - hh, y1: cam.y + hh });
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
      }
    },
    shapes(ctx) {
      resetPen();
      for (const k of ks) {
        setT(ctx, k);
        for (const sh of st.shapes) drawShape(ctx, world, sh, px * dpr, river, st.style);
      }
    },
    over(ctx) {
      if (st.provinceLabels.length && rz > 900) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.font = `${11 * dpr}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(20,20,20,0.85)';
        ctx.strokeStyle = 'rgba(255,255,255,0.7)';
        ctx.lineWidth = 3 * dpr;
        for (const k of ks) {
          for (const l of st.provinceLabels) {
            const sx = ((l.x + 2 * k - cam.x) * cam.zoom + cw / 2) * dpr;
            const sy = ((l.y - cam.y) * cam.zoom + ch / 2) * dpr;
            if (sx < -50 || sy < -20 || sx > cw * dpr + 50 || sy > ch * dpr + 20) continue;
            // 导出整张地图：每个省名只标中心落在图里的那一份（分界线附近不标两遍）
            if (st.frame && (sx < 0 || sx >= cw * dpr)) continue;
            ctx.fillStyle = (l.kind && PROVINCE_LABEL_COLOR[l.kind]) || 'rgba(20,20,20,0.85)';
            ctx.strokeText(l.text, sx, sy);
            ctx.fillText(l.text, sx, sy);
          }
        }
      }
      // 导出整个星球：图就是一整圈（分界线可以在任何经度），每个地名只在中心落在图里的那一份上排
      const boxes = hasLabels(st) ? drawLabels(ctx, cam, st, ks, rz) : [];
      if (st.scaleBar) {
        if (sphere) {
          // 平铺图上东西方向的比例随纬度变：取画面中心那条纬线上的比例，并写明是哪条纬线
          const lat = Math.max(-85, Math.min(85, 90 - 180 * cam.y));
          const where = Math.abs(lat) < 2 ? '赤道' : `${lat > 0 ? '北' : '南'}纬 ${Math.round(Math.abs(lat))}°`;
          drawScaleBar(ctx, cam, st.kmPerUnit * Math.cos((lat * Math.PI) / 180), st.cornerLift, f, where);
        } else drawScaleBar(ctx, cam, st.kmPerUnit, st.cornerLift, f);
      }
      return boxes;
    },
  };
}



// 一张画布上一次画的是什么（按画布对象记：测速另画到别的画布上、测试的假画布互不影响）
interface ScreenCache {
  key: unknown[] | null;
  shapes: readonly Shape[] | null;
  boxes: LabelBox[];
}
const screens = new WeakMap<object, ScreenCache>();

// 屏幕上（停稳）：静态的键与图形都与上一次画的相同时什么都不画（画布上就是这一帧，逐像素相同）；否则照原样直接画。
// 不把哪一段画进离屏画布再贴回来：无头 Chrome 里量过，贴回的那几帧与直接画的读回来不逐字节相同（见开发说明）
function drawScreen(ctx: CanvasRenderingContext2D, world: World, paths: OverlayPaths, cam: Camera, st: OverlayState, f: Frame): LabelBox[] {
  const canvas = ctx.canvas;
  let sc = screens.get(canvas);
  if (!sc) screens.set(canvas, (sc = { key: null, shapes: null, boxes: [] }));
  const t0 = perf ? performance.now() : 0;
  // 移动中：照原样直接画（底层的河、地名按移动中的画法）；停下后的第一帧也直接画
  if (st.motion || overlayDebug.noStatic) {
    sc.key = null;
    const boxes = drawDirect(ctx, world, paths, cam, st, f);
    if (perf) (perf.note('overlay:motion'), perf.cpu('overlayStatic', performance.now() - t0));
    return boxes;
  }
  // 省名不设 textBaseline，照用画布上已有的（经纬网设的，或上一帧的地名、比例尺留下的）：它进键
  const key = staticKey(world, paths, cam, st, f, canvas, ctx.textBaseline);
  const same = !!sc.key && samePathsKey(key, sc.key);
  // 什么都没变：画布上就是这一帧
  if (same && sameShapes(st.shapes, sc.shapes)) {
    perf?.note('overlay:skip');
    return sc.boxes;
  }
  const boxes = drawDirect(ctx, world, paths, cam, st, f);
  sc.key = key;
  sc.shapes = st.shapes;
  sc.boxes = boxes;
  if (perf) {
    // 只有图形变了（画笔圈、悬停的圈跟着鼠标）记 overlayDynamic，静态的变了记 overlayStatic
    perf.note(same ? 'overlay:shapes' : 'overlay:direct');
    perf.cpu(same ? 'overlayDynamic' : 'overlayStatic', performance.now() - t0);
  }
  return boxes;
}

// 屏幕上的静态那一层作废（2D 画布的上下文丢了又恢复时：画布是空的）
export function resetOverlayCache(canvas: object) {
  screens.delete(canvas);
}

