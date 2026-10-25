import { arcUnits, densify, circle as geoCircle } from '../../core/geo';
import type { RiverLine } from '../../core/rivers';
import type { World } from '../../core/world';
import { type Frame, type LabelBox, type OverlayPaths, type OverlayState, type Shape, PROVINCE_LABEL_COLOR, drawLabels, drawScaleBar, hasLabels, refZoom, riverDraw, riverScale, riverStroke, riverTypeColor } from './overlay';
import { ROAD_SMOOTH_PX, type RoadDraw, roadStyle } from './settle-draw';
import { type Proj, type ProjCamera, effectiveZoom, inverse, screenToPlane, screenToWorld, trueScale, worldToScreen } from './projection';

// 等面积、球形投影时的叠加层（第十三轮 G4）：点按投影算，线沿大圆加密后逐点投影（球的背面、等面积的左右两边断开）。
// 画的是：河道与湖的标记、经纬网、工具的图形、省名、地名、比例尺（画面中心那里的比例）。
// 风、洋流不画（图层里说明只在等距圆柱里显示）；河由渲染器合成（见 renderer.ts 的投影的合成）

type Cam = ProjCamera & { proj: Proj };

// 地图单位 → 屏幕（CSS 像素）
interface Projector {
  cam: Cam;
  cw: number;
  ch: number;
  // 相当于等距圆柱的缩放（工具按它算像素大小的图形）
  zoom: number;
  at: (x: number, y: number) => [number, number] | null;
}

function projector(cam: Cam, cw: number, ch: number): Projector {
  return { cam, cw, ch, zoom: effectiveZoom(cam), at: (x, y) => worldToScreen(cam, cw, ch, x, y) };
}

// 屏幕上相邻两点差这么多（CSS 像素）就断开：等面积的左右两边（经度 ±180°）在屏幕上隔着整个椭圆
const JUMP_PX = 80;

// 一串点（地图单位）按投影连成线：看不见的点、跳到另一边的断开。geodesic：每段沿大圆加密（每段约 6 像素）
function projPath(ctx: CanvasRenderingContext2D, P: Projector, pts: readonly [number, number][], closed: boolean, geodesic = true) {
  if (pts.length < 2) return;
  const list = closed ? [...pts, pts[0]] : (pts as [number, number][]);
  const dense = geodesic ? densify(list as [number, number][], 6 / P.zoom) : list;
  let last: [number, number] | null = null;
  for (const [x, y] of dense) {
    const s = P.at(x, y);
    if (!s) {
      last = null;
      continue;
    }
    if (!last || Math.hypot(s[0] - last[0], s[1] - last[1]) > JUMP_PX) ctx.moveTo(s[0], s[1]);
    else ctx.lineTo(s[0], s[1]);
    last = s;
  }
}

// 画面上看得见的经纬范围（度，经度在中央经线附近展开；看得见极点时经度是整圈）
function visibleBox(P: Projector): { lon0: number; lon1: number; lat0: number; lat1: number } {
  const { cam, cw, ch } = P;
  const N = 16;
  const c = (cam.proj.lon0 * 180) / Math.PI;
  let lon0 = Infinity;
  let lon1 = -Infinity;
  let lat0 = Infinity;
  let lat1 = -Infinity;
  for (let j = 0; j <= N; j++) {
    for (let i = 0; i <= N; i++) {
      const [u, v] = screenToPlane(cam, cw, ch, (cw * i) / N, (ch * j) / N);
      const w = inverse(cam.proj, u, v);
      if (!w) continue;
      let lon = (w[0] - 1) * 180;
      lon = c + (lon - c - 360 * Math.round((lon - c) / 360));
      const lat = 90 - w[1] * 180;
      lon0 = Math.min(lon0, lon);
      lon1 = Math.max(lon1, lon);
      lat0 = Math.min(lat0, lat);
      lat1 = Math.max(lat1, lat);
    }
  }
  if (!Number.isFinite(lon0)) return { lon0: 0, lon1: -1, lat0: 0, lat1: -1 };
  const pad = 360 / N;
  const onScreen = (s: [number, number] | null) => !!s && s[0] >= 0 && s[0] <= cw && s[1] >= 0 && s[1] <= ch;
  if (onScreen(P.at(1, 0))) lat1 = 90;
  if (onScreen(P.at(1, 1))) lat0 = -90;
  if (lat1 >= 90 || lat0 <= -90 || lon1 - lon0 + 2 * pad >= 360) return { lon0: c - 180, lon1: c + 180, lat0: Math.max(-90, lat0 - pad), lat1: Math.min(90, lat1 + pad) };
  return { lon0: lon0 - pad, lon1: lon1 + pad, lat0: Math.max(-90, lat0 - pad), lat1: Math.min(90, lat1 + pad) };
}

const xOf = (lon: number) => 1 + lon / 180;
const yOf = (lat: number) => (90 - lat) / 180;

// 经纬网：间隔随缩放（每条线之间至少约 60 像素），回归线、极圈用虚线。字标在中央经线、赤道上
function drawGraticule(ctx: CanvasRenderingContext2D, P: Projector, f: Frame) {
  const { dpr } = f;
  const step = [1, 2, 5, 10, 15, 30].find((d) => (d * P.zoom) / 180 >= 60) ?? 30;
  const box = visibleBox(P);
  if (box.lon1 < box.lon0) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineWidth = 1;
  ctx.font = '500 11px system-ui, "PingFang SC", sans-serif';
  ctx.lineJoin = 'round';
  // 线上的点每隔多少度：线间隔的 1/8，整圈最多约 720 个点
  const fine = Math.max(step / 8, (box.lon1 - box.lon0) / 720, 0.05);
  const fineLat = Math.max(step / 8, (box.lat1 - box.lat0) / 360, 0.05);
  const parallel = (lat: number) => {
    const pts: [number, number][] = [];
    for (let lon = box.lon0; lon < box.lon1 + fine; lon += fine) pts.push([xOf(Math.min(lon, box.lon1)), yOf(lat)]);
    ctx.beginPath();
    projPath(ctx, P, pts, false, false);
    ctx.stroke();
  };
  const meridian = (lon: number) => {
    const pts: [number, number][] = [];
    for (let lat = box.lat0; lat < box.lat1 + fineLat; lat += fineLat) pts.push([xOf(lon), yOf(Math.min(lat, box.lat1))]);
    ctx.beginPath();
    projPath(ctx, P, pts, false, false);
    ctx.stroke();
  };
  for (let lat = -90 + step; lat < 90; lat += step) {
    if (lat < box.lat0 || lat > box.lat1) continue;
    ctx.strokeStyle = lat === 0 ? 'rgba(255, 255, 255, 0.5)' : 'rgba(255, 255, 255, 0.22)';
    parallel(lat);
  }
  for (let lon = Math.ceil(box.lon0 / step) * step; lon < box.lon1 && lon < box.lon0 + 360; lon += step) {
    const l = ((((lon + 180) % 360) + 360) % 360) - 180;
    ctx.strokeStyle = l === 0 ? 'rgba(255, 255, 255, 0.5)' : 'rgba(255, 255, 255, 0.22)';
    meridian(lon);
  }
  const special: [number, string][] = [
    [66.56, '北极圈'],
    [23.44, '北回归线'],
    [-23.44, '南回归线'],
    [-66.56, '南极圈'],
  ];
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  for (const [lat] of special) if (lat >= box.lat0 && lat <= box.lat1) parallel(lat);
  ctx.setLineDash([]);
  const label = (text: string, s: [number, number] | null) => {
    if (!s || s[0] < 0 || s[1] < 0 || s[0] > P.cw || s[1] > P.ch) return;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(15, 20, 28, 0.6)';
    ctx.strokeText(text, s[0] + 3, s[1] - 7);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fillText(text, s[0] + 3, s[1] - 7);
  };
  // 纬度标在画面中心的经线上，经度标在画面中心的纬线上（看不见时标在赤道上）
  const mid = screenToWorld(P.cam, P.cw, P.ch, P.cw / 2, P.ch / 2);
  const midLon = mid.inside ? (mid.x - 1) * 180 : (P.cam.proj.lon0 * 180) / Math.PI;
  const midLat = mid.inside ? Math.max(-80, Math.min(80, 90 - mid.y * 180)) : 0;
  for (let lat = -90 + step; lat < 90; lat += step) {
    if (lat >= box.lat0 && lat <= box.lat1) label(lat === 0 ? '0°' : `${Math.abs(lat)}°${lat > 0 ? 'N' : 'S'}`, P.at(xOf(midLon), yOf(lat)));
  }
  for (let lon = Math.ceil(box.lon0 / step) * step; lon < box.lon1 && lon < box.lon0 + 360; lon += step) {
    const l = ((((lon + 180) % 360) + 360) % 360) - 180;
    const name = l === 0 ? '0°' : l === -180 ? '180°' : `${Math.abs(l)}°${l > 0 ? 'E' : 'W'}`;
    label(name, P.at(xOf(lon), yOf(midLat)));
  }
  for (const [lat, name] of special) if (lat >= box.lat0 && lat <= box.lat1) label(name, P.at(xOf(midLon + 6 * step), yOf(lat)));
}

// 工具的图形。river：地图上的河现在的宽度系数与颜色
function drawShape(ctx: CanvasRenderingContext2D, world: World, sh: Shape, P: Projector, river: { scale: number; color: string }, style: 'realistic' | 'atlas') {
  if (sh.kind === 'river') {
    drawRiverShape(ctx, world, sh, P, river, style);
    return;
  }
  const color = sh.color ?? 'rgba(255,255,255,0.9)';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = sh.width ?? 1.5;
  ctx.setLineDash(sh.dashed ? [6, 4] : []);
  const { mesh } = world;
  if (sh.kind === 'circle' && sh.x !== undefined && sh.y !== undefined && sh.r !== undefined) {
    ctx.beginPath();
    if (sh.geodesic) {
      // 球面上真实大小的圆（画笔）
      const { pts, pole } = geoCircle(sh.x, sh.y, sh.r);
      projPath(ctx, P, pts, !pole);
    } else {
      // 按像素定大小的小圆（控制点、标记）：半径是“像素 / 缩放”，按相当于等距圆柱的缩放还原成像素
      const s = P.at(sh.x, sh.y);
      if (!s) return;
      ctx.arc(s[0], s[1], sh.r * P.zoom, 0, Math.PI * 2);
    }
    if (sh.fill) ctx.fill();
    ctx.stroke();
  } else if ((sh.kind === 'line' || sh.kind === 'arrow') && sh.points && sh.points.length > 1) {
    ctx.beginPath();
    projPath(ctx, P, sh.points, false);
    ctx.stroke();
    if (sh.kind === 'arrow') {
      const n = sh.points.length;
      const b = P.at(sh.points[n - 1][0], sh.points[n - 1][1]);
      const a = P.at(sh.points[n - 2][0], sh.points[n - 2][1]);
      if (a && b) arrowHead(ctx, a, b, 12, 0.4);
    }
  } else if (sh.kind === 'cells' && sh.cells && sh.cells.length > 1) {
    ctx.beginPath();
    projPath(
      ctx,
      P,
      sh.cells.map((c) => [mesh.x[c], mesh.y[c]] as [number, number]),
      false,
    );
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

// 道路（第二十四轮）：逐点投影（球的背面断开）；小路放大后才画，缩小时画没平滑的折线；
// 头、中、尾三点都在背面或都在画面同一边之外的不画
function drawRoadsProjected(ctx: CanvasRenderingContext2D, r: RoadDraw, P: Projector, cellPx: number, style: 'realistic' | 'atlas') {
  ctx.save();
  const m = 20;
  const off = (q: [number, number] | null) => (!q ? 0 : q[0] < -m ? 1 : q[0] > P.cw + m ? 2 : q[1] < -m ? 3 : q[1] > P.ch + m ? 4 : -1);
  const shown = (l: [number, number][]) => {
    const s = [l[0], l[l.length >> 1], l[l.length - 1]].map((p) => off(P.at(p[0], p[1])));
    return s.some((x) => x === -1) || !(s[0] === s[1] && s[1] === s[2]);
  };
  const stroke = (lines: [number, number][][]) => {
    ctx.beginPath();
    for (const l of lines) if (l.length > 1 && shown(l)) projPath(ctx, P, l, false, false);
    ctx.stroke();
  };
  const rs = roadStyle(r, style);
  if (cellPx >= r.minorPx && r.minor.length) {
    ctx.strokeStyle = rs.minor.color;
    ctx.lineWidth = rs.minor.width;
    ctx.setLineDash(rs.minor.dash);
    stroke(r.minor);
  }
  ctx.setLineDash([]);
  const smooth = cellPx >= ROAD_SMOOTH_PX;
  const major = smooth ? r.major : r.majorRaw;
  if (major.length) {
    if (smooth && rs.major.casing) {
      ctx.strokeStyle = rs.major.casing.color;
      ctx.lineWidth = rs.major.casing.width;
      stroke(major);
    }
    ctx.strokeStyle = rs.major.color;
    ctx.lineWidth = rs.major.width;
    stroke(major);
  }
  ctx.restore();
}

function arrowHead(ctx: CanvasRenderingContext2D, from: [number, number], to: [number, number], hs: number, spread: number) {
  const a = Math.atan2(to[1] - from[1], to[0] - from[0]);
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(to[0] + Math.cos(a) * hs * 0.2, to[1] + Math.sin(a) * hs * 0.2);
  ctx.lineTo(to[0] - hs * Math.cos(a - spread), to[1] - hs * Math.sin(a - spread));
  ctx.lineTo(to[0] - hs * Math.cos(a + spread), to[1] - hs * Math.sin(a + spread));
  ctx.closePath();
  ctx.fill();
}

// 预览的河：沿中线按宽度（与地图上的河同样按流量分档、随缩放变宽）描，宽度相同的一段一笔
function drawRiverShape(ctx: CanvasRenderingContext2D, world: World, sh: Shape, P: Projector, river: { scale: number; color: string }, style: 'realistic' | 'atlas') {
  const pts = sh.points;
  const flow = sh.flow;
  if (!pts || !flow || pts.length < 2) return;
  ctx.setLineDash([]);
  const rt = sh.riverType;
  const color = sh.color ?? (rt ? riverTypeColor(rt, style) : river.color);
  const line: RiverLine = { points: pts, flow, ...(sh.mul ? { mul: sh.mul } : {}), ...(sh.head ? { head: sh.head } : {}), ...(sh.mouth ? { mouth: true } : {}) };
  const rb = riverDraw(line, world.small.planet.riverThreshold, world.mesh.spacing, rt ? [rt] : null, 1).rb;
  const n = rb.x.length;
  if (n < 2) return;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const widthAt = (i: number) => Math.max(0.8, Math.round(2 * rb.hw[i] * river.scale * 2) / 2);
  for (let i0 = 0; i0 < n - 1; ) {
    const lw = widthAt(i0);
    let i1 = i0 + 1;
    while (i1 < n - 1 && widthAt(i1) === lw) i1++;
    const seg: [number, number][] = [];
    for (let i = i0; i <= i1; i++) seg.push([rb.x[i], rb.y[i]]);
    ctx.lineWidth = lw;
    ctx.beginPath();
    projPath(ctx, P, seg, false);
    ctx.stroke();
    i0 = i1;
  }
  if (!sh.arrow) return;
  const back = Math.max(0, n - 4);
  const a = P.at(rb.x[back], rb.y[back]);
  const b = P.at(rb.x[n - 1], rb.y[n - 1]);
  if (a && b) arrowHead(ctx, a, b, Math.max(8, 2.4 * 2 * rb.hw[n - 1] * river.scale), 0.45);
}

// 画过的河道（细虚线）、湖的标记、在终点消失的河的终点
function drawMarkers(ctx: CanvasRenderingContext2D, world: World, paths: OverlayPaths, P: Projector) {
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 1.2;
  for (const g of paths.guideLines ?? []) {
    ctx.beginPath();
    projPath(ctx, P, g.pts, false);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.strokeStyle = 'rgba(30,80,140,0.95)';
  ctx.lineWidth = 1.5;
  for (const l of world.small.lakes) {
    const s = P.at(world.mesh.x[l.cell], world.mesh.y[l.cell]);
    if (!s) continue;
    ctx.beginPath();
    ctx.arc(s[0], s[1], 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
  for (const [x, y] of paths.sinks) {
    const s = P.at(x, y);
    if (!s) continue;
    ctx.beginPath();
    ctx.arc(s[0], s[1], 3, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// 画面中心那里每个 CSS 像素合多少公里（东西、南北两个方向的平均；中心不在地图上时为 0）
export function kmPerPxAtCenter(cam: Cam, cw: number, ch: number, kmPerUnit: number): number {
  const c = screenToWorld(cam, cw, ch, cw / 2, ch / 2);
  const r = screenToWorld(cam, cw, ch, cw / 2 + 1, ch / 2);
  const d = screenToWorld(cam, cw, ch, cw / 2, ch / 2 + 1);
  if (!c.inside || !r.inside || !d.inside) return 0;
  return ((arcUnits(c.x, c.y, r.x, r.y) + arcUnits(c.x, c.y, d.x, d.y)) / 2) * kmPerUnit;
}

export function drawOverlayProjected(ctx: CanvasRenderingContext2D, world: World, paths: OverlayPaths, cam: Cam, st: OverlayState, f: Frame): LabelBox[] {
  const { cw, ch, dpr } = f;
  const P = projector(cam, cw, ch);
  const rz = refZoom(world, P.zoom);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (st.markers) drawMarkers(ctx, world, paths, P);
  if (st.latitude) drawGraticule(ctx, P, f);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const river = { scale: riverScale(world, P.zoom), color: riverStroke(st.style) };
  if (st.roads) drawRoadsProjected(ctx, st.roads, P, world.mesh.spacing * P.zoom, st.style);
  for (const sh of st.shapes) drawShape(ctx, world, sh, P, river, st.style);
  if (st.provinceLabels.length && rz > 900) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = `${11 * dpr}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 3 * dpr;
    for (const l of st.provinceLabels) {
      const s = P.at(l.x, l.y);
      if (!s) continue;
      // 球形的边上（斜着看、挤在一起）不标
      if (cam.proj.kind === 'globe' && trueScale(cam.proj, l.x, l.y) < 0.35 * Math.PI * 0.5) continue;
      const sx = s[0] * dpr;
      const sy = s[1] * dpr;
      if (sx < -50 || sy < -20 || sx > cw * dpr + 50 || sy > ch * dpr + 20) continue;
      ctx.fillStyle = (l.kind && PROVINCE_LABEL_COLOR[l.kind]) || 'rgba(20,20,20,0.85)';
      ctx.strokeText(l.text, sx, sy);
      ctx.fillText(l.text, sx, sy);
    }
  }
  const boxes = hasLabels(st) ? drawLabels(ctx, cam, st, [0], rz) : [];
  if (st.scaleBar) {
    const kmPerPx = kmPerPxAtCenter(cam, cw, ch, st.kmPerUnit);
    if (kmPerPx > 0) drawScaleBar(ctx, { x: 0, y: 0, zoom: 1 }, kmPerPx, st.cornerLift, f, '画面中心');
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return boxes;
}
