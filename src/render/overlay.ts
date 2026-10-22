import { FEATURE_INFO, type FeatureType, type GeoFeature } from '../../core/features';
import { circle as geoCircle, wrapX } from '../../core/geo';
import type { RiverStyle, RiverType } from '../../core/river-types';
import { type RiverLine, guideShape, guidesSignature, riverWidth, traceRivers } from '../../core/rivers';
import type { World } from '../../core/world';
import type { Camera } from './renderer';
import { drawCurrents, drawWind } from './wind';

// 2D 画布上的矢量叠加：河流、河道引导、湖标记、风向、画笔、箭头、预览路径、地名。
// 海岸线、省份边界、选区轮廓在着色器里画（自然曲线）。
// 路径按地图单位预先构建成 Path2D，绘制时只换变换矩阵，平移缩放很便宜。

export interface OverlayPaths {
  // 河流按宽度分档，每档一条 Path2D
  rivers: { path: Path2D; width: number }[];
  // 带类型的河（第三批）：按（类型，宽度 × 类型的粗细）分档，type 是 derived.riverType 的值（第 type − 1 种）。
  // 只在世界里有河流类型时才有；带类型的河段不在 rivers 里
  typed?: { path: Path2D; width: number; type: number }[];
  guides: Path2D;
  lockedGuides: Path2D;
  // 在终点消失的河道的终点（水模式下画一个小圈）
  sinks: [number, number][];
}

// ---------- 河的画法（地图上的河、预览的河共用，预览与结果画出来一样） ----------

// 河宽随放大变宽，一直到最大缩放（一格约 64 像素）：按“相当于 4 万格地区地图的缩放”算
export function riverScale(world: World, zoom: number): number {
  return Math.max(0.7, Math.min(4, refZoom(world, zoom) / 1400));
}

// 一段河的宽度档（屏幕像素，未乘 riverScale）：每 1/4 像素一档。mul 是画的河的粗细倍数
export function riverBucket(flow: number, thr: number, mul = 1): number {
  return Math.max(0.25, Math.round(riverWidth(flow, thr) * mul * 4) / 4);
}

// 河的颜色
export function riverStroke(style: 'realistic' | 'atlas'): string {
  return style === 'atlas' ? 'rgba(70, 110, 150, 0.95)' : 'rgba(52, 104, 168, 0.92)';
}

// 一种河流类型画出来的颜色（地图集风格用 atlasColor）
export function riverTypeColor(t: Pick<RiverType, 'color' | 'atlasColor'>, style: 'realistic' | 'atlas'): string {
  return style === 'atlas' ? (t.atlasColor ?? t.color) : t.color;
}

// 按河流类型的画法描一档河（lw 是线宽，单位与路径相同）：
// 实线；虚线（3 倍线宽一段、2 倍线宽一空）；双线（先描整条，再在中间描一道 0.45 倍宽的半透明白线）；发光（同色的 6 像素光晕）
export function strokeRiverStyle(ctx: CanvasRenderingContext2D, path: Path2D, lw: number, color: string, style: RiverStyle, dpr: number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  if (style === 'dashed') {
    ctx.setLineDash([3 * lw, 2 * lw]);
    ctx.stroke(path);
    ctx.setLineDash([]);
    return;
  }
  if (style === 'glow') {
    ctx.shadowBlur = 6 * dpr;
    ctx.shadowColor = color;
    ctx.stroke(path);
    ctx.shadowBlur = 0;
    ctx.shadowColor = 'transparent';
    return;
  }
  ctx.stroke(path);
  if (style === 'double') {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.lineWidth = 0.45 * lw;
    ctx.stroke(path);
  }
}

// 把河的折线按宽度档加进 Path2D（每段一条子路径，圆头）。scale：再乘的粗细（拖“粗细”时）。
// 整个星球：每段按起点挪到 [0, 2) 里那一份（展开的河可以伸出很远，平铺的副本只看 [-0.6, 2.6]）
function addRiver(buckets: Map<number, Path2D>, line: RiverLine, thr: number, sphere: boolean, scale = 1) {
  const { points, flow, mul } = line;
  for (let k = 0; k + 1 < points.length; k++) {
    const key = riverBucket((flow[k] + flow[k + 1]) / 2, thr, (mul ? (mul[k] + mul[k + 1]) / 2 : 1) * scale);
    let p = buckets.get(key);
    if (!p) buckets.set(key, (p = new Path2D()));
    const shift = sphere ? 2 * Math.floor(points[k][0] / 2) : 0;
    p.moveTo(points[k][0] - shift, points[k][1]);
    p.lineTo(points[k + 1][0] - shift, points[k + 1][1]);
  }
}

const sortedBuckets = (buckets: Map<number, Path2D>) => [...buckets].sort((a, b) => a[0] - b[0]).map(([width, path]) => ({ path, width }));

// 带类型的河段（第三批）：按（类型，宽度档）分，同一档里连着的几段画成一条折线（虚线不在每段重新开始）。
// 普通的河段照旧放进 plain（与没有河流类型时一样）
interface TypedBuckets {
  map: Map<string, { path: Path2D; width: number; type: number }>;
}
function addTypedRiver(plain: Map<number, Path2D>, typed: TypedBuckets, line: RiverLine, thr: number, sphere: boolean, types: readonly RiverType[], scale = 1) {
  const { points, flow, mul, type } = line;
  let lastKey = '';
  let lastShift = Number.NaN;
  for (let k = 0; k + 1 < points.length; k++) {
    const t = type![k];
    const spec = t > 0 ? types[t - 1] : undefined;
    const m = (mul ? (mul[k] + mul[k + 1]) / 2 : 1) * scale;
    const shift = sphere ? 2 * Math.floor(points[k][0] / 2) : 0;
    if (!spec) {
      const key = riverBucket((flow[k] + flow[k + 1]) / 2, thr, m);
      let p = plain.get(key);
      if (!p) plain.set(key, (p = new Path2D()));
      p.moveTo(points[k][0] - shift, points[k][1]);
      p.lineTo(points[k + 1][0] - shift, points[k + 1][1]);
      lastKey = '';
      continue;
    }
    const width = riverBucket((flow[k] + flow[k + 1]) / 2, thr, m * (spec.width ?? 1));
    const key = `${t}|${width}`;
    let b = typed.map.get(key);
    if (!b) typed.map.set(key, (b = { path: new Path2D(), width, type: t }));
    // 与上一段同一档、同一份平铺：接着画；否则另起一笔
    if (key !== lastKey || shift !== lastShift) b.path.moveTo(points[k][0] - shift, points[k][1]);
    b.path.lineTo(points[k + 1][0] - shift, points[k + 1][1]);
    lastKey = key;
    lastShift = shift;
  }
}

const sortedTyped = (t: TypedBuckets) => [...t.map.values()].sort((a, b) => a.width - b.width || a.type - b.type);

// 一串河线画成按宽度分档的 Path2D（预览的河用；地图上的河见 buildPaths）
export function riverPaths(world: World, lines: RiverLine[]): { path: Path2D; width: number }[] {
  const buckets = new Map<number, Path2D>();
  for (const line of lines) addRiver(buckets, line, world.small.planet.riverThreshold, world.mesh.kind === 'sphere');
  return sortedBuckets(buckets);
}

// 一条连续的折线加进 Path2D（河道的虚线标记：虚线不在每段重新开始）。整个星球：按段的起点挪到 [0, 2) 里，
// 挪的份数变了才另起一笔
function addPolyline(p: Path2D, pts: readonly [number, number][], sphere: boolean) {
  let cur = Number.NaN;
  for (let k = 0; k + 1 < pts.length; k++) {
    const shift = sphere ? 2 * Math.floor(pts[k][0] / 2) : 0;
    if (shift !== cur) {
      p.moveTo(pts[k][0] - shift, pts[k][1]);
      cur = shift;
    }
    p.lineTo(pts[k + 1][0] - cur, pts[k + 1][1]);
  }
}

// 拖一条画的河的“粗细”时先这样画（不等 worker，立即看到）；hide：先不画它（拖“大小”时用预览的样子代替）
export interface RiverStyleOverride {
  id: string;
  width?: number;
  hide?: boolean;
}

// 河的路径缓存的键：描河读的数组（流量、流向、湖面、高程、陆海；推导换了就换）、河的门槛、
// 河道的内容（每次快照的河道数组都是新的，按内容认）、拖粗细时的临时样子。只改了名字的轻快照不重画，改了粗细的会重画。
// 预览世界（地图画将来的样子）只换了内容变了的数组：流量没变、湖面或高程变了的预览也不会错用当前世界的河
export function riverPathsKey(world: World, override: RiverStyleOverride | null): unknown[] {
  return [
    world.mesh,
    world.derived.discharge,
    world.derived.receiver,
    world.derived.lake,
    world.derived.elevation,
    world.causes.land,
    world.small.planet.riverThreshold,
    guidesSignature(world.small.guides),
    override ? `${override.id}|${override.width ?? ''}|${override.hide ? 1 : 0}` : '',
    // 河流类型（第三批）：类型的颜色、画法、粗细（按内容），每格是哪一种（推导换了就换）
    riverTypesSignature(world.small.riverTypes),
    world.derived.riverType,
  ];
}

// 河流类型里影响画法的几项（没有河流类型时为 ''）
export function riverTypesSignature(types: readonly RiverType[] | undefined): string {
  return types?.length ? JSON.stringify(types.map((t) => [t.id, t.color, t.atlasColor ?? '', t.style ?? 'solid', t.width ?? 1])) : '';
}

export const samePathsKey = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((k, i) => k === b[i]);

// 地图上的河的折线（traceRivers），按 riverPathsKey 缓存。只在主线程用：worker 里水文就地改写流量数组，
// 按数组认会认错。留最近用过的两份：地图画预览世界（将来的河）时，点河、河的光照旧按当前世界的河算，
// 预览世界一份份换（拖着调整面板的滑块）也不会把当前世界的那份挤掉、来回重描
const linesMemo: { key: unknown[]; lines: RiverLine[] }[] = [];
export function riverLines(world: World): RiverLine[] {
  const key = riverPathsKey(world, null);
  const at = linesMemo.findIndex((m) => samePathsKey(m.key, key));
  if (at >= 0) {
    const [hit] = linesMemo.splice(at, 1);
    linesMemo.unshift(hit);
    return hit.lines;
  }
  const lines = traceRivers(world);
  linesMemo.unshift({ key, lines });
  linesMemo.length = Math.min(linesMemo.length, 2);
  return lines;
}

export function buildPaths(world: World, override: RiverStyleOverride | null = null): OverlayPaths {
  const { mesh, small } = world;
  const thr = small.planet.riverThreshold;
  const sphere = mesh.kind === 'sphere';
  const buckets = new Map<number, Path2D>();
  const own = override ? small.guides.find((g) => g.id === override.id) : undefined;
  // 带类型的河（第三批）：只在世界里有河流类型时分开画
  const types = small.riverTypes?.length && world.derived.riverType ? small.riverTypes : null;
  const typed: TypedBuckets = { map: new Map() };
  const add = (line: RiverLine, scale = 1) => (types && line.type ? addTypedRiver(buckets, typed, line, thr, sphere, types, scale) : addRiver(buckets, line, thr, sphere, scale));
  for (const line of riverLines(world)) {
    if (!override || line.guide !== override.id) add(line);
    else if (!override.hide) add(line, override.width !== undefined ? override.width / (own?.width ?? 1) : 1);
  }
  const rivers = sortedBuckets(buckets);
  const guides = new Path2D();
  const lockedGuides = new Path2D();
  const sinks: [number, number][] = [];
  for (const g of small.guides) {
    // 画出来的那条线（与河一致；整个星球上沿线展开经度，跨过接缝的线是连续的）
    const pts = guideShape(world, g);
    addPolyline(g.locked ? lockedGuides : guides, pts, sphere);
    if (g.end === 'sink' && pts.length) {
      const [x, y] = pts[pts.length - 1];
      sinks.push([sphere ? wrapX(x) : x, y]);
    }
  }
  return types ? { rivers, typed: sortedTyped(typed), guides, lockedGuides, sinks } : { rivers, guides, lockedGuides, sinks };
}

// 工具预览的矢量图形（地图单位）
export interface Shape {
  kind: 'circle' | 'line' | 'arrow' | 'cells' | 'river';
  x?: number;
  y?: number;
  r?: number;
  points?: [number, number][];
  cells?: number[];
  // river：与地图上的河同样画（宽度按流量分档、随缩放变宽，颜色照河的颜色，除非给了 color）。
  // flow 是每个点的流量，mul 是每个点的粗细倍数；arrow：河口画一个小箭头（看得出往哪流）
  flow?: number[];
  mul?: number[];
  arrow?: boolean;
  color?: string;
  // 线宽（屏幕像素）
  width?: number;
  dashed?: boolean;
  // river：按这种河流类型的画法、颜色、粗细画（画河时选了类型的预览）
  riverType?: RiverType;
  // 整个星球：圆是球面上真实大小的圆（画笔），投影到平铺图上（高纬度是横向拉长的椭圆）
  geodesic?: boolean;
  // 实心的圆（小礁的预览）
  fill?: boolean;
}

// 省份名字：无人区灰色、湖省蓝色（不用斜体：中文的斜体是把字硬拉斜）
export interface ProvinceLabel {
  x: number;
  y: number;
  text: string;
  kind?: 'land' | 'wasteland' | 'lake' | 'sea';
}
const PROVINCE_LABEL_COLOR: Record<string, string> = { wasteland: 'rgba(95,95,95,0.95)', lake: 'rgba(40,95,160,0.95)' };

export interface OverlayState {
  rivers: boolean;
  wind: boolean;
  // 画过的河与湖的标记（水模式）
  markers: boolean;
  season: 'annual' | 'summer' | 'winter';
  style: 'realistic' | 'atlas';
  shapes: Shape[];
  provinceLabels: ProvinceLabel[];
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

  const scale = riverScale(world, cam.zoom);
  const river = { scale, color: riverStroke(st.style) };
  for (const k of ks) {
    setT(k);
    if (st.rivers) {
      ctx.strokeStyle = river.color;
      for (const r of paths.rivers) {
        ctx.lineWidth = r.width * scale * px * dpr;
        ctx.stroke(r.path);
      }
      // 带类型的河：各按自己的颜色、画法
      if (paths.typed) {
        const types = world.small.riverTypes ?? [];
        for (const r of paths.typed) {
          const t = types[r.type - 1];
          if (t) strokeRiverStyle(ctx, r.path, r.width * scale * px * dpr, riverTypeColor(t, st.style), t.style ?? 'solid', dpr);
        }
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
      // 在终点消失的河：终点一个空心小圈
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = 1.5 * px * dpr;
      for (const [x, y] of paths.sinks) {
        ctx.beginPath();
        ctx.arc(x, y, 3 * px * dpr, 0, Math.PI * 2);
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
    for (const sh of st.shapes) drawShape(ctx, world, sh, px * dpr, river, st.style);
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
        ctx.fillStyle = (l.kind && PROVINCE_LABEL_COLOR[l.kind]) || 'rgba(20,20,20,0.85)';
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

// unit：一个屏幕像素合多少地图单位；river：地图上的河现在的宽度系数与颜色（river 图形照它画）
function drawShape(ctx: CanvasRenderingContext2D, world: World, sh: Shape, unit: number, river: { scale: number; color: string }, style: 'realistic' | 'atlas') {
  if (sh.kind === 'river') {
    drawRiverShape(ctx, world, sh, unit, river, style);
    return;
  }
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
    if (sh.fill && !pole) ctx.fill();
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

// 预览的河：与地图上的河同一套分档、宽度、颜色、圆头（见 addRiver）
function drawRiverShape(ctx: CanvasRenderingContext2D, world: World, sh: Shape, unit: number, river: { scale: number; color: string }, style: 'realistic' | 'atlas') {
  const pts = sh.points;
  const flow = sh.flow;
  if (!pts || !flow || pts.length < 2) return;
  ctx.setLineDash([]);
  const rt = sh.riverType;
  const color = sh.color ?? (rt ? riverTypeColor(rt, style) : river.color);
  if (rt) {
    // 选了河流类型：与地图上这种河同样画（粗细、颜色、画法）
    const typed: TypedBuckets = { map: new Map() };
    const line: RiverLine = { points: pts, flow, mul: sh.mul, type: pts.map(() => 1) };
    addTypedRiver(new Map(), typed, line, world.small.planet.riverThreshold, world.mesh.kind === 'sphere', [rt]);
    const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    for (const r of sortedTyped(typed)) strokeRiverStyle(ctx, r.path, r.width * river.scale * unit, color, rt.style ?? 'solid', dpr);
  } else {
    ctx.strokeStyle = color;
    for (const r of riverPaths(world, [{ points: pts, flow, mul: sh.mul }])) {
      ctx.lineWidth = r.width * river.scale * unit;
      ctx.stroke(r.path);
    }
  }
  if (!sh.arrow) return;
  // 河口的小箭头：比河稍宽，顺着最后一段
  const n = pts.length;
  const shift = world.mesh.kind === 'sphere' ? 2 * Math.floor(pts[n - 2][0] / 2) : 0;
  const [x1, y1] = [pts[n - 1][0] - shift, pts[n - 1][1]];
  const [x0, y0] = [pts[n - 2][0] - shift, pts[n - 2][1]];
  const w = riverBucket(flow[n - 1], world.small.planet.riverThreshold, (sh.mul?.[n - 1] ?? 1) * (rt?.width ?? 1)) * river.scale;
  const hs = Math.max(8, w * 2.4) * unit;
  const a = Math.atan2(y1 - y0, x1 - x0);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x1 + Math.cos(a) * hs * 0.5, y1 + Math.sin(a) * hs * 0.5);
  ctx.lineTo(x1 - hs * Math.cos(a - 0.45), y1 - hs * Math.sin(a - 0.45));
  ctx.lineTo(x1 - hs * Math.cos(a + 0.45), y1 - hs * Math.sin(a + 0.45));
  ctx.closePath();
  ctx.fill();
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

// 哪些地名标出来、放在哪里（按布局缓存；导出给测试用）
export function placeLabels(ctx: CanvasRenderingContext2D, cam: Camera, st: OverlayState, ks: number[], rz: number): { placed: PlacedLabel[]; boxes: LabelBox[] } {
  const canvas = ctx.canvas;
  const cw = canvas.clientWidth;
  const chh = canvas.clientHeight;
  const key = `${cam.x}|${cam.y}|${cam.zoom}|${cw}|${chh}|${st.kmPerUnit}|${ks.join(',')}|${st.labelTypes ? [...st.labelTypes].join(',') : '*'}|${st.hoverLabel ?? ''}`;
  if (layout && layout.key === key && layout.features === st.features) return layout;
  const toScreen = (x: number, y: number): [number, number] => [(x - cam.x) * cam.zoom + cw / 2, (y - cam.y) * cam.zoom + chh / 2];
  const placed: PlacedLabel[] = [];
  const boxes: LabelBox[] = [];
  // 用户自己的地名（圈的地区、放的地名、改过的名字）和悬停、选中的那个：总是标出来，最先放（避让时别的让它）
  const mine = (f: GeoFeature) => !!f.region || f.custom || f.key === st.hoverLabel;
  const features = [...(st.features ?? [])].sort((a, b) => Number(mine(b)) - Number(mine(a)) || b.importance - a.importance);
  for (const f of features) {
    if (!f.name || (st.labelTypes && !st.labelTypes.has(f.type))) continue;
    // 在屏幕上有多大；山峰、用户放的点状地名没有大小（山峰放大到一定程度才标，地点总是标）
    const point = f.type === 'peak' || f.type === 'spot';
    const sizePx = f.type === 'river' ? f.span * cam.zoom : point ? 0 : (Math.sqrt(f.areaKm2) / st.kmPerUnit) * cam.zoom;
    const minPx = f.type === 'continent' || f.type === 'ocean' ? 25 : f.type === 'river' ? 90 : point ? 0 : 45;
    if (!mine(f) && (f.type === 'peak' ? rz < 1600 : sizePx < minPx)) continue;
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
