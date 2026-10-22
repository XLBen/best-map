import { FEATURE_INFO, type FeatureType, type GeoFeature } from '../../core/features';
import { circle as geoCircle } from '../../core/geo';
import { riverWidth, traceRivers } from '../../core/rivers';
import type { World } from '../../core/world';
import type { Camera } from './renderer';
import { drawCurrents, drawWind } from './wind';

// 2D 画布上的矢量叠加：河流、河道引导、湖标记、风向、画笔、箭头、预览路径、地名。
// 海岸线、省份边界、选区轮廓在着色器里画（自然曲线）。
// 路径按地图单位预先构建成 Path2D，绘制时只换变换矩阵，平移缩放很便宜。

export interface OverlayPaths {
  // 河流按宽度分档，每档一条 Path2D
  rivers: { path: Path2D; width: number }[];
  guides: Path2D;
  lockedGuides: Path2D;
}

export function buildPaths(world: World): OverlayPaths {
  const { mesh, small } = world;
  const thr = small.planet.riverThreshold;
  const buckets = new Map<number, Path2D>();
  for (const line of traceRivers(world)) {
    for (let k = 0; k + 1 < line.points.length; k++) {
      const w = riverWidth((line.flow[k] + line.flow[k + 1]) / 2, thr);
      const key = Math.round(w * 4) / 4;
      let p = buckets.get(key);
      if (!p) buckets.set(key, (p = new Path2D()));
      p.moveTo(line.points[k][0], line.points[k][1]);
      p.lineTo(line.points[k + 1][0], line.points[k + 1][1]);
    }
  }
  const rivers = [...buckets].sort((a, b) => a[0] - b[0]).map(([width, path]) => ({ path, width }));
  const guides = new Path2D();
  const lockedGuides = new Path2D();
  const sphere = mesh.kind === 'sphere';
  for (const g of small.guides) {
    const p = g.locked ? lockedGuides : guides;
    // 整个星球：沿线展开经度，跨过接缝的线是连续的
    let px = 0;
    g.cells.forEach((c, k) => {
      const x = sphere && k > 0 ? px + (mesh.x[c] - px - 2 * Math.round((mesh.x[c] - px) / 2)) : mesh.x[c];
      px = x;
      if (k === 0) p.moveTo(x, mesh.y[c]);
      else p.lineTo(x, mesh.y[c]);
    });
  }
  return { rivers, guides, lockedGuides };
}

// 工具预览的矢量图形（地图单位）
export interface Shape {
  kind: 'circle' | 'line' | 'arrow' | 'cells';
  x?: number;
  y?: number;
  r?: number;
  points?: [number, number][];
  cells?: number[];
  color?: string;
  // 线宽（屏幕像素）
  width?: number;
  dashed?: boolean;
  // 整个星球：圆是球面上真实大小的圆（画笔），投影到平铺图上（高纬度是横向拉长的椭圆）
  geodesic?: boolean;
  // 实心的圆（小礁的预览）
  fill?: boolean;
}

export interface OverlayState {
  rivers: boolean;
  wind: boolean;
  // 画过的河与湖的标记（水模式）
  markers: boolean;
  season: 'annual' | 'summer' | 'winter';
  style: 'realistic' | 'atlas';
  shapes: Shape[];
  provinceLabels: { x: number; y: number; text: string }[];
  // 地名标注；labelTypes 为 null 时显示全部类型
  features: GeoFeature[] | null;
  labelTypes: Set<FeatureType> | null;
  kmPerUnit: number;
  // 鼠标悬停或选中的地名（高亮）
  hoverLabel: string | null;
  // 左下角的比例尺；底部条伸到左下角时往上抬多少（CSS 像素）
  scaleBar: boolean;
  cornerLift: number;
  // 纬度刻度：地图上下边的实际纬度（含挪动）；null 不画。整个星球画经纬网
  latitude: { north: number; south: number } | null;
  // 洋流流线（整个星球）
  currents?: boolean;
}

// 整个星球的平铺图：屏幕上看得见的副本（x 平移 2k）。河、画的河展开后可能伸出 [0, 2) 一点，所以多算一点
export function copiesFor(cam: Camera, cw: number): number[] {
  const halfW = cw / 2 / cam.zoom;
  const k0 = Math.ceil((cam.x - halfW - 2.6) / 2);
  const k1 = Math.floor((cam.x + halfW + 0.6) / 2);
  const out: number[] = [];
  for (let k = k0; k <= k1 && out.length < 7; k++) out.push(k);
  return out;
}

// 整个星球的格比同样格数的地区地图小：按格距把缩放换算成“相当于 4 万格地区地图的缩放”，
// 河宽、何时标省名和山峰都按它算（一块地区照旧用原来的缩放）
export function refZoom(world: World, zoom: number): number {
  return world.mesh.kind === 'sphere' ? (zoom * world.mesh.spacing) / 0.0076 : zoom;
}

// 一次绘制里实际画出来的地名的屏幕范围（CSS 像素），供点击命中
export interface LabelBox {
  key: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export function drawOverlay(ctx: CanvasRenderingContext2D, world: World, paths: OverlayPaths, cam: Camera, st: OverlayState): LabelBox[] {
  const canvas = ctx.canvas;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const z = cam.zoom * dpr;
  const sphere = world.mesh.kind === 'sphere';
  // 整个星球：每一份看得见的副本各画一遍（一块地区只有 k = 0）
  const ks = sphere ? copiesFor(cam, cw) : [0];
  // 地图单位 → 设备像素（第 k 份副本向右平移 2k）
  const setT = (k: number) => ctx.setTransform(z, 0, 0, z, (cw / 2 - (cam.x - 2 * k) * cam.zoom) * dpr, (ch / 2 - cam.y * cam.zoom) * dpr);
  setT(0);
  const px = 1 / z;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const rz = refZoom(world, cam.zoom);

  for (const k of ks) {
    setT(k);
    if (st.rivers) {
      ctx.strokeStyle = st.style === 'atlas' ? 'rgba(70, 110, 150, 0.95)' : 'rgba(52, 104, 168, 0.92)';
      // 河宽随放大变宽，一直到最大缩放（一格约 64 像素）
      const scale = Math.max(0.7, Math.min(4, rz / 1400));
      for (const r of paths.rivers) {
        ctx.lineWidth = r.width * scale * px * dpr;
        ctx.stroke(r.path);
      }
    }
    if (st.markers) {
      // 画过的河：细虚线标出走向是固定的
      ctx.setLineDash([5 * px * dpr, 4 * px * dpr]);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.lineWidth = 1.2 * px * dpr;
      ctx.stroke(paths.guides);
      ctx.stroke(paths.lockedGuides);
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      ctx.strokeStyle = 'rgba(30,80,140,0.95)';
      ctx.lineWidth = 1.5 * px * dpr;
      for (const l of world.small.lakes) {
        ctx.beginPath();
        ctx.arc(world.mesh.x[l.cell], world.mesh.y[l.cell], 4 * px * dpr, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }
  setT(0);

  if (st.wind) drawWind(ctx, world, cam, st.season, px * dpr);
  if (st.currents && sphere) drawCurrents(ctx, world, cam, px * dpr);
  if (st.latitude) {
    if (sphere) drawGraticule(ctx, cam, ks);
    else drawLatitude(ctx, world, cam, st.latitude);
  }

  for (const k of ks) {
    setT(k);
    for (const sh of st.shapes) drawShape(ctx, world, sh, px * dpr);
  }

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
        if (sx < -50 || sy < -20 || sx > canvas.width + 50 || sy > canvas.height + 20) continue;
        ctx.strokeText(l.text, sx, sy);
        ctx.fillText(l.text, sx, sy);
      }
    }
  }
  const boxes = st.features ? drawLabels(ctx, cam, st, ks, rz) : [];
  if (st.scaleBar) {
    if (sphere) {
      // 平铺图上东西方向的比例随纬度变：取画面中心那条纬线上的比例，并写明是哪条纬线
      const lat = Math.max(-85, Math.min(85, 90 - 180 * cam.y));
      const where = Math.abs(lat) < 2 ? '赤道' : `${lat > 0 ? '北' : '南'}纬 ${Math.round(Math.abs(lat))}°`;
      drawScaleBar(ctx, cam, st.kmPerUnit * Math.cos((lat * Math.PI) / 180), st.cornerLift, where);
    } else drawScaleBar(ctx, cam, st.kmPerUnit, st.cornerLift);
  }
  return boxes;
}

// 整个星球的经纬网：经线、纬线的间隔随缩放变（每条线之间至少约 60 像素），回归线、极圈用虚线并写上名字
function drawGraticule(ctx: CanvasRenderingContext2D, cam: Camera, ks: number[]) {
  const canvas = ctx.canvas;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const sx = (x: number) => (x - cam.x) * cam.zoom + cw / 2;
  const sy = (y: number) => (y - cam.y) * cam.zoom + ch / 2;
  const yOf = (lat: number) => (90 - lat) / 180;
  const xOf = (lon: number) => 1 + lon / 180;
  // 每度合多少像素（经纬方向相同）
  const pxPerDeg = cam.zoom / 180;
  const step = [1, 2, 5, 10, 15, 30].find((d) => d * pxPerDeg >= 60) ?? 30;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '500 11px system-ui, "PingFang SC", sans-serif';
  ctx.lineJoin = 'round';
  const label = (text: string, x: number, y: number, align: CanvasTextAlign) => {
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(15, 20, 28, 0.6)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fillText(text, x, y);
  };
  const top = Math.max(sy(0), 0);
  const bottom = Math.min(sy(1), ch);
  // 纬线
  ctx.lineWidth = 1;
  for (let lat = -90 + step; lat < 90; lat += step) {
    const y = sy(yOf(lat));
    if (y < 0 || y > ch) continue;
    ctx.strokeStyle = lat === 0 ? 'rgba(255, 255, 255, 0.5)' : 'rgba(255, 255, 255, 0.22)';
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(cw, y);
    ctx.stroke();
    label(lat === 0 ? '0°' : `${Math.abs(lat)}°${lat > 0 ? 'N' : 'S'}`, 8, y - 7, 'left');
  }
  // 经线（每份副本各画一遍）
  for (const k of ks) {
    for (let lon = -180; lon < 180; lon += step) {
      const x = sx(xOf(lon) + 2 * k);
      if (x < -1 || x > cw + 1) continue;
      ctx.strokeStyle = lon === 0 ? 'rgba(255, 255, 255, 0.5)' : 'rgba(255, 255, 255, 0.22)';
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      const name = lon === 0 ? '0°' : lon === -180 ? '180°' : `${Math.abs(lon)}°${lon > 0 ? 'E' : 'W'}`;
      label(name, x + 3, Math.max(top, 70) + 8, 'left');
    }
  }
  // 回归线、极圈
  const special: [number, string][] = [
    [66.56, '北极圈'],
    [23.44, '北回归线'],
    [-23.44, '南回归线'],
    [-66.56, '南极圈'],
  ];
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  for (const [lat, name] of special) {
    const y = sy(yOf(lat));
    if (y < 0 || y > ch) continue;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(cw, y);
    ctx.stroke();
    label(name, 54, y - 8, 'left');
  }
  ctx.setLineDash([]);
}

// 纬度刻度：地图左边每 10° 一格；回归线、极圈画一道淡淡的虚线横穿地图
function drawLatitude(ctx: CanvasRenderingContext2D, world: World, cam: Camera, lat: { north: number; south: number }) {
  const canvas = ctx.canvas;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const { mesh } = world;
  const yOf = (l: number) => ((lat.north - l) / (lat.north - lat.south)) * mesh.height;
  const sx = (x: number) => (x - cam.x) * cam.zoom + cw / 2;
  const sy = (y: number) => (y - cam.y) * cam.zoom + ch / 2;
  const left = Math.max(8, sx(0));
  const right = Math.min(cw, sx(mesh.width));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '500 11px system-ui, "PingFang SC", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  const label = (text: string, x: number, y: number) => {
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(15, 20, 28, 0.6)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.fillText(text, x, y);
  };
  const special: [number, string][] = [
    [66.56, '北极圈'],
    [23.44, '北回归线'],
    [0, '赤道'],
    [-23.44, '南回归线'],
    [-66.56, '南极圈'],
  ];
  ctx.setLineDash([6, 5]);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
  for (const [l, name] of special) {
    if (l > lat.north || l < lat.south) continue;
    const y = sy(yOf(l));
    if (y < 0 || y > ch) continue;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
    label(name, left + 46, y - 8);
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.lineWidth = 1.5;
  for (let l = Math.ceil(lat.south / 10) * 10; l <= lat.north; l += 10) {
    const y = sy(yOf(l));
    if (y < 0 || y > ch) continue;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(left + 10, y);
    ctx.stroke();
    label(l === 0 ? '0°' : `${Math.abs(l)}°${l > 0 ? 'N' : 'S'}`, left + 13, y);
  }
}

// 比例尺：左下角（尺子按钮右边），长度取 1、2、5 乘 10 的整数次方公里，屏幕上不超过 140 像素。
// 画在地图画布上，所以导出的图片里也有
function drawScaleBar(ctx: CanvasRenderingContext2D, cam: Camera, kmPerUnit: number, lift: number, where?: string) {
  const canvas = ctx.canvas;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const ch = canvas.clientHeight;
  const kmPerPx = kmPerUnit / cam.zoom;
  const max = 140 * kmPerPx;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  const len = [5, 2, 1].map((m) => m * pow).find((v) => v <= max) ?? pow;
  const px = len / kmPerPx;
  const x0 = 54;
  const y0 = ch - 24 - lift;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = 'rgba(20, 24, 30, 0.85)';
  ctx.fillRect(x0 - 1, y0 - 1, px + 2, 7);
  ctx.fillStyle = '#f2efe6';
  ctx.fillRect(x0, y0, px / 2, 5);
  ctx.fillStyle = '#3a414b';
  ctx.fillRect(x0 + px / 2, y0, px / 2, 5);
  ctx.font = '500 11.5px system-ui, "PingFang SC", sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const text = where ? `${len.toLocaleString()} km · ${where}` : `${len.toLocaleString()} km`;
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.strokeText(text, x0 + px + 6, y0 + 2.5);
  ctx.fillStyle = '#1e2226';
  ctx.fillText(text, x0 + px + 6, y0 + 2.5);
}

// unit：一个屏幕像素合多少地图单位
function drawShape(ctx: CanvasRenderingContext2D, world: World, sh: Shape, unit: number) {
  const color = sh.color ?? 'rgba(255,255,255,0.9)';
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = (sh.width ?? 1.5) * unit;
  ctx.setLineDash(sh.dashed ? [6 * unit, 4 * unit] : []);
  const { mesh } = world;
  if (sh.kind === 'circle' && sh.geodesic && mesh.kind === 'sphere' && sh.x !== undefined && sh.y !== undefined && sh.r !== undefined) {
    const { pts, pole } = geoCircle(sh.x, sh.y, sh.r);
    ctx.beginPath();
    pts.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    // 包住极点的圆在平铺图上是一条横贯的曲线：不闭合
    if (!pole) ctx.closePath();
    ctx.stroke();
  } else if (sh.kind === 'circle' && sh.x !== undefined && sh.y !== undefined && sh.r !== undefined) {
    ctx.beginPath();
    ctx.arc(sh.x, sh.y, sh.r, 0, Math.PI * 2);
    if (sh.fill) ctx.fill();
    ctx.stroke();
  } else if ((sh.kind === 'line' || sh.kind === 'arrow') && sh.points && sh.points.length > 1) {
    ctx.beginPath();
    sh.points.forEach(([x, y], k) => (k === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
    if (sh.kind === 'arrow') {
      const [x1, y1] = sh.points[sh.points.length - 1];
      const [x0, y0] = sh.points[sh.points.length - 2];
      const a = Math.atan2(y1 - y0, x1 - x0);
      const hs = 12 * unit;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x1 - hs * Math.cos(a - 0.4), y1 - hs * Math.sin(a - 0.4));
      ctx.lineTo(x1 - hs * Math.cos(a + 0.4), y1 - hs * Math.sin(a + 0.4));
      ctx.fill();
    }
  } else if (sh.kind === 'cells' && sh.cells && sh.cells.length > 1) {
    ctx.beginPath();
    // 整个星球：沿线展开经度
    let px = 0;
    sh.cells.forEach((c, k) => {
      const x = mesh.kind === 'sphere' && k > 0 ? px + (mesh.x[c] - px - 2 * Math.round((mesh.x[c] - px) / 2)) : mesh.x[c];
      px = x;
      if (k === 0) ctx.moveTo(x, mesh.y[c]);
      else ctx.lineTo(x, mesh.y[c]);
    });
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

const LABEL_STYLE: Record<'land' | 'water' | 'relief' | 'nature', { color: string; italic: boolean; spacing: number }> = {
  land: { color: '#1e2226', italic: false, spacing: 0 },
  water: { color: '#1f4f7a', italic: true, spacing: 0.15 },
  relief: { color: '#5a3b1e', italic: false, spacing: 0.35 },
  nature: { color: '#3d4f22', italic: true, spacing: 0.2 },
};

// 地名：按重要度从高到低放，和已放的重叠就跳过；字号随屏幕上的大小。
// 排版（逐字测宽、避让）按镜头缓存：鼠标移动时不重排，只重画
interface PlacedLabel {
  key: string;
  chars: string[];
  widths: number[];
  spacing: number;
  total: number;
  font: string;
  color: string;
  x: number;
  y: number;
  angle: number;
}
let layout: { key: string; features: GeoFeature[] | null; placed: PlacedLabel[]; boxes: LabelBox[] } | null = null;

// 每个字的宽度按字体缓存：平移、缩放的每一帧不必再量（字体加载完成后清空重量）
const glyphs = new Map<string, number>();
if (typeof document !== 'undefined') document.fonts?.addEventListener?.('loadingdone', () => glyphs.clear());
function glyphWidth(ctx: CanvasRenderingContext2D, font: string, c: string): number {
  const key = `${font}|${c}`;
  let w = glyphs.get(key);
  if (w === undefined) {
    w = ctx.measureText(c).width;
    glyphs.set(key, w);
  }
  return w;
}

function placeLabels(ctx: CanvasRenderingContext2D, cam: Camera, st: OverlayState, ks: number[], rz: number): { placed: PlacedLabel[]; boxes: LabelBox[] } {
  const canvas = ctx.canvas;
  const cw = canvas.clientWidth;
  const chh = canvas.clientHeight;
  const key = `${cam.x}|${cam.y}|${cam.zoom}|${cw}|${chh}|${st.kmPerUnit}|${ks.join(',')}|${st.labelTypes ? [...st.labelTypes].join(',') : '*'}`;
  if (layout && layout.key === key && layout.features === st.features) return layout;
  const toScreen = (x: number, y: number): [number, number] => [(x - cam.x) * cam.zoom + cw / 2, (y - cam.y) * cam.zoom + chh / 2];
  const placed: PlacedLabel[] = [];
  const boxes: LabelBox[] = [];
  const features = [...(st.features ?? [])].sort((a, b) => b.importance - a.importance);
  for (const f of features) {
    if (!f.name || (st.labelTypes && !st.labelTypes.has(f.type))) continue;
    // 在屏幕上有多大；山峰、用户放的点状地名没有大小（山峰放大到一定程度才标，地点总是标）
    const point = f.type === 'peak' || f.type === 'spot';
    const sizePx = f.type === 'river' ? f.span * cam.zoom : point ? 0 : (Math.sqrt(f.areaKm2) / st.kmPerUnit) * cam.zoom;
    const minPx = f.type === 'continent' || f.type === 'ocean' ? 25 : f.type === 'river' ? 90 : point ? 0 : 45;
    if (f.type === 'peak' ? rz < 1600 : sizePx < minPx) continue;
    // 整个星球：每份副本上都可能看得见（相隔一整圈，彼此不会挤在一起）
    const spots: [number, number][] = [];
    for (const k of ks) {
      const [x, y] = toScreen(f.x + 2 * k, f.y);
      if (x < -100 || y < -40 || x > cw + 100 || y > chh + 40) continue;
      spots.push([x, y]);
    }
    if (!spots.length) continue;
    const group = FEATURE_INFO[f.type].group;
    const style = LABEL_STYLE[group];
    const base = f.type === 'continent' || f.type === 'ocean' ? 15 : f.type === 'river' || f.type === 'peak' ? 10.5 : 11;
    const grow = minPx > 0 ? Math.max(0, Math.log2(Math.max(1, sizePx / minPx))) * 2.6 : 0;
    const fontPx = Math.round(Math.min(f.type === 'continent' || f.type === 'ocean' ? 30 : 20, base + grow));
    const font = `${style.italic ? 'italic ' : ''}${f.type === 'continent' || f.type === 'ocean' ? 600 : 500} ${fontPx}px system-ui, "PingFang SC", sans-serif`;
    ctx.font = font;
    const text = f.type === 'peak' ? `▲ ${f.name}` : f.type === 'spot' ? `• ${f.name}` : f.name;
    const chars = [...text];
    const wide = f.type === 'range' || f.type === 'continent' || f.type === 'ocean' || f.type === 'region';
    const spacing = (f.type === 'region' ? 0.3 : style.spacing) * fontPx * (wide ? 2 : 1);
    const widths = chars.map((c) => glyphWidth(ctx, font, c));
    const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
    // 地点：圆点落在放的位置上，字在右边
    const shift = f.type === 'spot' ? total / 2 - widths[0] / 2 : 0;
    // 狭长的地物沿主轴写，其余横写（用户圈的区块只在明显狭长时才斜着写，见 regionFeatures）
    let angle = 0;
    if (f.type === 'river' && f.line && f.line.length > 2) {
      const mid = Math.floor(f.line.length / 2);
      const a = f.line[Math.max(0, mid - 2)];
      const b = f.line[Math.min(f.line.length - 1, mid + 2)];
      const dxl = b[0] - a[0];
      angle = Math.atan2(b[1] - a[1], dxl - 2 * Math.round(dxl / 2));
      if (angle > Math.PI / 2) angle -= Math.PI;
      if (angle < -Math.PI / 2) angle += Math.PI;
    } else if (f.region ? f.angle !== 0 && f.span * cam.zoom > total * 1.4 : (f.type === 'range' || f.type === 'peninsula' || f.type === 'strait') && f.span * cam.zoom > total * 1.4) {
      angle = f.angle;
    }
    const hw = (Math.abs(Math.cos(angle)) * total + Math.abs(Math.sin(angle)) * fontPx) / 2 + 3;
    const hh = (Math.abs(Math.sin(angle)) * total + Math.abs(Math.cos(angle)) * fontPx) / 2 + 2;
    for (const [x0, sy] of spots) {
      const sx = x0 + shift;
      const box = { key: f.key, x0: sx - hw, y0: sy - hh, x1: sx + hw, y1: sy + hh };
      if (boxes.some((b) => b.x0 < box.x1 && b.x1 > box.x0 && b.y0 < box.y1 && b.y1 > box.y0)) continue;
      boxes.push(box);
      placed.push({ key: f.key, chars, widths, spacing, total, font, color: f.custom ? '#7a1f5c' : style.color, x: sx, y: sy, angle });
    }
  }
  layout = { key, features: st.features, placed, boxes };
  return layout;
}

function drawLabels(ctx: CanvasRenderingContext2D, cam: Camera, st: OverlayState, ks: number[], rz: number): LabelBox[] {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const { placed, boxes } = placeLabels(ctx, cam, st, ks, rz);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  for (const l of placed) {
    ctx.save();
    ctx.translate(l.x, l.y);
    ctx.rotate(l.angle);
    ctx.font = l.font;
    // 先给整串字描边，再统一填字：后一个字的描边不会啃掉前一个字
    ctx.strokeStyle = st.hoverLabel === l.key ? 'rgba(255, 236, 140, 0.95)' : 'rgba(255, 255, 255, 0.72)';
    let x = -l.total / 2;
    l.chars.forEach((c, k) => {
      ctx.strokeText(c, x, 0);
      x += l.widths[k] + l.spacing;
    });
    ctx.fillStyle = l.color;
    x = -l.total / 2;
    l.chars.forEach((c, k) => {
      ctx.fillText(c, x, 0);
      x += l.widths[k] + l.spacing;
    });
    ctx.restore();
  }
  return boxes;
}
