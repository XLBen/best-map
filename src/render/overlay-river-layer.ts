import type { World } from '../../core/world';
import { copiesFor, makeLayer, MOTION_LAYER_MARGIN, MOTION_LAYER_SCALE, MOTION_LAYER_ZOOM, overlayDebug, type OverlayPaths } from './overlay-base';
import type { Camera, RiverScene, RiverTex } from './renderer';
import { type MapStyle, mapStyleKey } from '../../core/map-style';
import { addRiverPaint, LOW_ZOOM_CELL_PX, lowZoomStrokes, newPaint, riverScale, riverStroke, samePathsKey, strokeRiverPaint, strokeRiverStyle, typeColors } from './overlay-rivers';

// 河画进叠加层或离屏的河的图层（第四十一轮从 overlay.ts 原样搬来）

// 河，画进 ctx：画布是 cw × ch 个 CSS 像素、每个 CSS 像素 dev 个像素，镜头在画布中间。河只加画布上看得见的那几条（按外接框裁）
export function drawRivers(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, world: World, paths: OverlayPaths, cam: Camera, style: MapStyle, cw: number, ch: number, dev: number) {
  const z = cam.zoom * dev;
  const sphere = world.mesh.kind === 'sphere';
  const ks = sphere ? copiesFor(cam, cw) : [0];
  const setT = (k: number) => ctx.setTransform(z, 0, 0, z, (cw / 2 - (cam.x - 2 * k) * cam.zoom) * dev, (ch / 2 - cam.y * cam.zoom) * dev);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // 看得见的范围（地图单位，第 0 份；四周多留 48 个 CSS 像素给线宽、发光）
  const m = 48 / cam.zoom;
  const view: [number, number, number, number] = [cam.x - cw / 2 / cam.zoom - m, cam.y - ch / 2 / cam.zoom - m, cam.x + cw / 2 / cam.zoom + m, cam.y + ch / 2 / cam.zoom + m];
  drawRiversWith(ctx, world, paths, cam.zoom, ks, setT, view, sphere, style, dev);
}

// 河，画进 ctx：zoom 是每地图单位几个 CSS 像素（河宽、何时按低缩放的画法），ks 是要画的副本，setT(k) 设好第 k 份的变换，
// view 是看得见的范围（地图单位，第 0 份）
export function drawRiversWith(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  world: World,
  paths: OverlayPaths,
  zoom: number,
  ks: number[],
  setT: (k: number) => void,
  view: [number, number, number, number],
  sphere: boolean,
  style: MapStyle,
  dev: number,
) {
  // 每条河按看得见的副本各加一份（坐标里平移 2），同色的带子一次填
  setT(0);
  const scale = riverScale(world, zoom);
  const unit = 1 / zoom;
  const colorOf = typeColors(world.small.riverTypes ?? [], style, riverStroke(style));
  const low = world.mesh.spacing * zoom < LOW_ZOOM_CELL_PX;
  const paint = newPaint();
  if (low) {
    // 整个世界的河缓存着（第 0 份的坐标）：每份看得见的副本各描一遍
    const cached = lowZoomStrokes(paths, world.mesh.spacing * zoom, world.mesh.spacing, style, colorOf, world.small.riverTypes);
    ctx.lineJoin = 'round';
    for (const k of ks) {
      setT(k);
      ctx.lineCap = 'butt';
      for (const e of cached.plain.values()) {
        ctx.strokeStyle = e.color;
        ctx.lineWidth = e.w * scale * unit;
        ctx.stroke(e.path);
      }
      for (const e of cached.styled) strokeRiverStyle(ctx as CanvasRenderingContext2D, e.path, e.w * scale * unit, e.color, e.style, dev);
    }
    setT(0);
  } else for (const d of paths.rivers) addRiverPaint(paint, d, scale * unit, unit, scale, view, sphere, colorOf);
  if (!low) strokeRiverPaint(ctx as CanvasRenderingContext2D, paint, unit, style, dev);
}

// ---------- 河的图层（第十三轮）：画进一张离屏画布，交给渲染器在合成一步里按每像素的陆海混进地图 ----------
// 海面、湖面上不画（河口正好停在岸线），排在省份着色、晕渲之后，海岸线、省界、高亮之前（见 renderer.ts 的 FS_COMPOSE）。
// 停稳时是与地图画布一样大的一张；移动中按 MOTION_LAYER_SCALE 的分辨率、四周多画 MOTION_LAYER_MARGIN，镜头还在边距之内、
// 缩放没变太多时照用（渲染器按 toUv 挪一挪、缩一缩取），渲染器移动中的场景重画时同一帧重画。导出整张地图时每块另画一张
export interface RiverCache {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  key: unknown[];
  cam: Camera;
  // 画它时的虚拟画布（CSS 像素）与每个 CSS 像素几个像素
  cw: number;
  ch: number;
  dev: number;
  soft: boolean;
  version: number;
  epoch?: number;
}
export let riverRest: RiverCache | null = null;
export let riverMotion: RiverCache | null = null;
export let riverTile: RiverCache | null = null;
// 每画一次河的图层加一（渲染器按它决定要不要重新上传）
export let riverVersion = 0;

export function riverCache(old: RiverCache | null, W: number, H: number): RiverCache {
  if (old && old.canvas.width === W && old.canvas.height === H && old.soft === overlayDebug.softLayers) return old;
  const L = makeLayer(W, H, 1);
  return { canvas: L.canvas, ctx: L.ctx, key: [], cam: { x: 0, y: 0, zoom: 1 }, cw: 0, ch: 0, dev: 0, soft: L.soft, version: -1 };
}

export function paintRivers(L: RiverCache, world: World, paths: OverlayPaths, cam: Camera, style: MapStyle, cw: number, ch: number, dev: number, key: unknown[]) {
  L.ctx.setTransform(1, 0, 0, 1, 0, 0);
  L.ctx.clearRect(0, 0, L.canvas.width, L.canvas.height);
  drawRivers(L.ctx, world, paths, cam, style, cw, ch, dev);
  L.ctx.setTransform(1, 0, 0, 1, 0, 0);
  L.key = key;
  L.cam = { ...cam };
  L.cw = cw;
  L.ch = ch;
  L.dev = dev;
  L.version = ++riverVersion;
}

// 地图单位 → 这张图上的位置（0–1，v 向上：上传时上下翻转）
export function riverTex(L: RiverCache): RiverTex {
  const c = L.cam;
  const z = c.zoom * L.dev;
  const W = L.canvas.width;
  const H = L.canvas.height;
  return { source: L.canvas, version: L.version, toUv: [z / W, ((L.cw / 2 - c.x * c.zoom) * L.dev) / W, -z / H, 1 - ((L.ch / 2 - c.y * c.zoom) * L.dev) / H] };
}

export const riverKey = (world: World, paths: OverlayPaths, style: MapStyle): unknown[] => [paths, world.mesh, mapStyleKey(style), world.small.riverTypes, world.small.planet.riverThreshold];

// 屏幕上的河。screen：地图的画布（像素数与 CSS 大小）；motion：渲染器这一帧按移动中的画法画（或刚停下的那一帧）
export function riverLayer(
  world: World,
  paths: OverlayPaths,
  cam: Camera,
  st: { style: MapStyle; motion?: boolean; motionEpoch?: number },
  screen: { width: number; height: number; clientWidth: number; clientHeight: number },
): RiverTex {
  const cw = screen.clientWidth || 1;
  const ch = screen.clientHeight || 1;
  const dpr = screen.width / cw || 1;
  const key = riverKey(world, paths, st.style);
  if (!st.motion) {
    const L = (riverRest = riverCache(riverRest, screen.width, screen.height));
    const c = L.cam;
    if (!samePathsKey(key, L.key) || c.x !== cam.x || c.y !== cam.y || c.zoom !== cam.zoom || L.cw !== cw || L.ch !== ch || L.dev !== dpr) paintRivers(L, world, paths, cam, st.style, cw, ch, dpr, key);
    return riverTex(L);
  }
  const lw = cw * (1 + 2 * MOTION_LAYER_MARGIN);
  const lh = ch * (1 + 2 * MOTION_LAYER_MARGIN);
  const dev = dpr * MOTION_LAYER_SCALE;
  const L = (riverMotion = riverCache(riverMotion, Math.max(1, Math.round(lw * dev)), Math.max(1, Math.round(lh * dev))));
  const c = L.cam;
  const fits = cam.zoom / c.zoom <= MOTION_LAYER_ZOOM && Math.abs(cam.x - c.x) + cw / 2 / cam.zoom <= lw / 2 / c.zoom && Math.abs(cam.y - c.y) + ch / 2 / cam.zoom <= lh / 2 / c.zoom;
  if (!samePathsKey(key, L.key) || !fits || L.cw !== lw || L.ch !== lh || L.dev !== dev || (st.motionEpoch !== undefined && L.epoch !== st.motionEpoch)) {
    paintRivers(L, world, paths, cam, st.style, lw, lh, dev, key);
    L.epoch = st.motionEpoch;
  }
  return riverTex(L);
}

// 导出整张地图的一块：T × T 像素、每个 CSS 像素 dpr 个像素，镜头 cam 在这一块的中间（export-plan.ts 的 tileView 的 cx、cy）
export function riverLayerTile(world: World, paths: OverlayPaths, cam: Camera, style: MapStyle, T: number, dpr: number): RiverTex {
  const L = (riverTile = riverCache(riverTile, T, T));
  paintRivers(L, world, paths, cam, style, T / dpr, T / dpr, dpr, riverKey(world, paths, style));
  return riverTex(L);
}

// 等面积、球形投影（第十三轮 G4）：河画在渲染器的场景那一块等距圆柱上（东西、南北的密度可以不同），合成时按投影取。
// 场景没变就不重画；exporting：导出用另一张画布（不挤掉屏幕上的那一张）
export function riverLayerScene(world: World, paths: OverlayPaths, sc: RiverScene, style: MapStyle, exporting = false): RiverTex {
  const L = exporting ? (riverTile = riverCache(riverTile, sc.W, sc.H)) : (riverRest = riverCache(riverRest, sc.W, sc.H));
  const key = [...riverKey(world, paths, style), sc.key, sc.dpr];
  if (exporting || !samePathsKey(key, L.key)) {
    const ctx = L.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, L.canvas.width, L.canvas.height);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // 河宽按 CSS 像素：每地图单位 zy / dpr 个 CSS 像素
    const zoom = sc.zy / sc.dpr;
    if (sc.pole) {
      drawRiversPolar(ctx, world, paths, sc, style, zoom);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      L.key = key;
      L.version = ++riverVersion;
      return { source: L.canvas, version: L.version, toUv: [0, 0, 0, 0] };
    }
    const x1 = sc.x0 + sc.W / sc.zx;
    const y1 = sc.y0 + sc.H / sc.zy;
    const m = 48 / zoom;
    const ks: number[] = [];
    for (let k = Math.ceil((sc.x0 - 2.6) / 2); k <= Math.floor((x1 + 0.6) / 2) && ks.length < 7; k++) ks.push(k);
    const setT = (k: number) => ctx.setTransform(sc.zx, 0, 0, sc.zy, (2 * k - sc.x0) * sc.zx, -sc.y0 * sc.zy);
    drawRiversWith(ctx, world, paths, zoom, ks, setT, [sc.x0 - m, sc.y0 - m, x1 + m, y1 + m], world.mesh.kind === 'sphere', style, sc.dpr);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    L.key = key;
    L.version = ++riverVersion;
  }
  return { source: L.canvas, version: L.version, toUv: [sc.zx / sc.W, (-sc.x0 * sc.zx) / sc.W, -sc.zy / sc.H, 1 + (sc.y0 * sc.zy) / sc.H] };
}

// 极地的场景（以极点为中心的等距方位投影）上的河：逐点换到那个平面上（像素），两岸按换过去的中线在像素里算，
// 宽度与平面的河一样（按流量分档、随缩放变宽，CSS 像素）。虚线、双线、发光的河在这里按实线画
export function drawRiversPolar(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, world: World, paths: OverlayPaths, sc: RiverScene, style: MapStyle, zoom: number) {
  const pole = sc.pole as 1 | -1;
  const scale = riverScale(world, zoom);
  const colorOf = typeColors(world.small.riverTypes ?? [], style, riverStroke(style));
  const R = sc.x0 < 0 ? -sc.x0 : 1;
  const dev = sc.dpr;
  const fills = new Map<string, Path2D>();
  const thin = new Map<string, Path2D>();
  let px: Float64Array = new Float64Array(0);
  let py: Float64Array = new Float64Array(0);
  for (const d of paths.rivers) {
    const rb = d.rb;
    const n = rb.x.length;
    if (n < 2) continue;
    // 离极点太远（场景之外）的河不画
    const near = pole > 0 ? rb.y0 : 1 - rb.y1;
    if (near > R + 0.02) continue;
    if (px.length < n) {
      px = new Float64Array(n);
      py = new Float64Array(n);
    }
    for (let i = 0; i < n; i++) {
      const r = pole > 0 ? rb.y[i] : 1 - rb.y[i];
      const a = Math.PI * (rb.x[i] - 1);
      px[i] = (r * Math.cos(a) - sc.x0) * sc.zx;
      py[i] = (pole * r * Math.sin(a) - sc.y0) * sc.zy;
    }
    for (let i0 = 0; i0 < n - 1; ) {
      const t = d.type ? d.type[rb.src[i0]] : 0;
      let i1 = i0 + 1;
      while (i1 < n - 1 && (d.type ? d.type[rb.src[i1]] : 0) === t) i1++;
      const { color } = colorOf(t);
      // 相隔不到 0.7 像素的点不要
      const idx: number[] = [i0];
      for (let i = i0 + 1; i < i1; i++) if (Math.hypot(px[i] - px[idx[idx.length - 1]], py[i] - py[idx[idx.length - 1]]) >= 0.7 * dev) idx.push(i);
      idx.push(i1);
      let sum = 0;
      for (let i = i0; i <= i1; i++) sum += rb.hw[i];
      if (2 * (sum / (i1 - i0 + 1)) * scale < 1) {
        const lw = Math.max(0.25, Math.round(((2 * sum) / (i1 - i0 + 1)) * scale * 4) / 4);
        const k = `${color}|${lw}`;
        let p = thin.get(k);
        if (!p) thin.set(k, (p = new Path2D()));
        p.moveTo(px[idx[0]], py[idx[0]]);
        for (let j = 1; j < idx.length; j++) p.lineTo(px[idx[j]], py[idx[j]]);
      } else {
        let f = fills.get(color);
        if (!f) fills.set(color, (f = new Path2D()));
        const m = idx.length;
        const ox: number[] = [];
        const oy: number[] = [];
        for (let j = 0; j < m; j++) {
          const a = idx[Math.max(0, j - 1)];
          const b = idx[Math.min(m - 1, j + 1)];
          const tx = px[b] - px[a];
          const ty = py[b] - py[a];
          const tl = Math.hypot(tx, ty) || 1;
          const o = rb.hw[idx[j]] * scale * dev;
          ox.push((-ty / tl) * o);
          oy.push((tx / tl) * o);
        }
        f.moveTo(px[idx[0]] + ox[0], py[idx[0]] + oy[0]);
        for (let j = 1; j < m; j++) f.lineTo(px[idx[j]] + ox[j], py[idx[j]] + oy[j]);
        for (let j = m - 1; j >= 0; j--) f.lineTo(px[idx[j]] - ox[j], py[idx[j]] - oy[j]);
        f.closePath();
      }
      i0 = i1;
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const [k, p] of thin) {
    const [color, lw] = k.split('|');
    ctx.strokeStyle = color;
    ctx.lineWidth = Number(lw) * dev;
    ctx.stroke(p);
  }
  for (const [color, p] of fills) {
    ctx.fillStyle = color;
    ctx.fill(p);
  }
}

// 导出完放掉那一块的画布
export function releaseRiverTile() {
  riverTile = null;
}

