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
  rivers: { path: Path2D; width: number; pts?: Float32Array }[];
  // 带类型的河（第三批）：按（类型，宽度 × 类型的粗细）分档，type 是 derived.riverType 的值（第 type − 1 种）。
  // 只在世界里有河流类型时才有；带类型的河段不在 rivers 里
  typed?: { path: Path2D; width: number; type: number; pts?: Float32Array }[];
  guides: Path2D;
  lockedGuides: Path2D;
  // 在终点消失的河道的终点（水模式下画一个小圈）
  sinks: [number, number][];
}

// ---------- 河的画法（地图上的河、预览的河共用，预览与结果画出来一样） ----------

// 河宽随放大变宽，一直到最大缩放（一格约 64 像素）：按“相当于 4 万格地区地图的缩放”算
function riverScale(world: World, zoom: number): number {
  return Math.max(0.7, Math.min(4, refZoom(world, zoom) / 1400));
}

// 一段河的宽度档（屏幕像素，未乘 riverScale）：每 1/4 像素一档。mul 是画的河的粗细倍数
function riverBucket(flow: number, thr: number, mul = 1): number {
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
function strokeRiverStyle(ctx: CanvasRenderingContext2D, path: Path2D, lw: number, color: string, style: RiverStyle, dpr: number): void {
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

// Path2D 加上记下来的点（移动中按画面裁掉看不见的部分，见 culledPath）：每一笔一串点，笔与笔之间隔一对 NaN
class RecPath {
  path = new Path2D();
  pts: number[] = [];
  moveTo(x: number, y: number) {
    this.path.moveTo(x, y);
    if (this.pts.length) this.pts.push(Number.NaN, Number.NaN);
    this.pts.push(x, y);
  }
  lineTo(x: number, y: number) {
    this.path.lineTo(x, y);
    this.pts.push(x, y);
  }
}

// 只留与这块地方（地图单位）相交的那几笔
function culledPath(pts: Float32Array, x0: number, y0: number, x1: number, y1: number): Path2D {
  const p = new Path2D();
  const n = pts.length;
  for (let i = 0; i < n; ) {
    let j = i;
    let ax = Infinity;
    let bx = -Infinity;
    let ay = Infinity;
    let by = -Infinity;
    while (j < n && !Number.isNaN(pts[j])) {
      ax = Math.min(ax, pts[j]);
      bx = Math.max(bx, pts[j]);
      ay = Math.min(ay, pts[j + 1]);
      by = Math.max(by, pts[j + 1]);
      j += 2;
    }
    if (bx >= x0 && ax <= x1 && by >= y0 && ay <= y1) {
      p.moveTo(pts[i], pts[i + 1]);
      for (let k = i + 2; k < j; k += 2) p.lineTo(pts[k], pts[k + 1]);
    }
    i = j + 2;
  }
  return p;
}

// 把河的折线按宽度档加进 Path2D（每段一条子路径，圆头）。scale：再乘的粗细（拖“粗细”时）。
// 整个星球：每段按起点挪到 [0, 2) 里那一份（展开的河可以伸出很远，平铺的副本只看 [-0.6, 2.6]）
function addRiver(buckets: Map<number, RecPath>, line: RiverLine, thr: number, sphere: boolean, scale = 1) {
  const { points, flow, mul } = line;
  for (let k = 0; k + 1 < points.length; k++) {
    const key = riverBucket((flow[k] + flow[k + 1]) / 2, thr, (mul ? (mul[k] + mul[k + 1]) / 2 : 1) * scale);
    let p = buckets.get(key);
    if (!p) buckets.set(key, (p = new RecPath()));
    const shift = sphere ? 2 * Math.floor(points[k][0] / 2) : 0;
    p.moveTo(points[k][0] - shift, points[k][1]);
    p.lineTo(points[k + 1][0] - shift, points[k + 1][1]);
  }
}

const sortedBuckets = (buckets: Map<number, RecPath>) => [...buckets].sort((a, b) => a[0] - b[0]).map(([width, r]) => ({ path: r.path, width, pts: new Float32Array(r.pts) }));

// 带类型的河段（第三批）：按（类型，宽度档）分，同一档里连着的几段画成一条折线（虚线不在每段重新开始）。
// 普通的河段照旧放进 plain（与没有河流类型时一样）
interface TypedBuckets {
  map: Map<string, { rec: RecPath; width: number; type: number }>;
}
function addTypedRiver(plain: Map<number, RecPath>, typed: TypedBuckets, line: RiverLine, thr: number, sphere: boolean, types: readonly RiverType[], scale = 1) {
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
      if (!p) plain.set(key, (p = new RecPath()));
      p.moveTo(points[k][0] - shift, points[k][1]);
      p.lineTo(points[k + 1][0] - shift, points[k + 1][1]);
      lastKey = '';
      continue;
    }
    const width = riverBucket((flow[k] + flow[k + 1]) / 2, thr, m * (spec.width ?? 1));
    const key = `${t}|${width}`;
    let b = typed.map.get(key);
    if (!b) typed.map.set(key, (b = { rec: new RecPath(), width, type: t }));
    // 与上一段同一档、同一份平铺：接着画；否则另起一笔
    if (key !== lastKey || shift !== lastShift) b.rec.moveTo(points[k][0] - shift, points[k][1]);
    b.rec.lineTo(points[k + 1][0] - shift, points[k + 1][1]);
    lastKey = key;
    lastShift = shift;
  }
}

const sortedTyped = (t: TypedBuckets) =>
  [...t.map.values()].sort((a, b) => a.width - b.width || a.type - b.type).map((b) => ({ path: b.rec.path, width: b.width, type: b.type, pts: new Float32Array(b.rec.pts) }));

// 一串河线画成按宽度分档的 Path2D（预览的河用；地图上的河见 buildPaths）
export function riverPaths(world: World, lines: RiverLine[]): { path: Path2D; width: number }[] {
  const buckets = new Map<number, RecPath>();
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

// 拖一条画的河的“粗细”时先这样画（不等 worker，立即看到）；hide：先不画它（拖“大小”、改这条河时用预览的样子代替）。
// cells（改一条自然的河时）：自然的河上两头都在这些格里的那几段先不画（id 为 ''）
export interface RiverStyleOverride {
  id: string;
  width?: number;
  hide?: boolean;
  cells?: ReadonlySet<number>;
}

// 一条河线上两头的格都在 cells 里的那几段（keep 为 false 时是其余的段）：拆成几条线
export function splitRiverLine(line: RiverLine, cells: ReadonlySet<number>, keep: boolean): RiverLine[] {
  const out: RiverLine[] = [];
  const c = line.cells;
  if (!c) return keep ? [] : [line];
  let cur: number[] = [];
  const flush = () => {
    if (cur.length > 1) {
      const pick = <T>(a: T[] | undefined) => (a ? cur.map((k) => a[k]) : undefined);
      const piece: RiverLine = { points: pick(line.points)!, flow: pick(line.flow)!, cells: pick(line.cells) };
      if (line.mul) piece.mul = pick(line.mul);
      if (line.type) piece.type = pick(line.type);
      if (line.guide !== undefined) piece.guide = line.guide;
      out.push(piece);
    }
    cur = [];
  };
  for (let k = 0; k + 1 < line.points.length; k++) {
    const inside = cells.has(c[k]) && cells.has(c[k + 1]);
    if (inside === keep) {
      if (!cur.length) cur.push(k);
      cur.push(k + 1);
    } else flush();
  }
  flush();
  return out;
}

// 河的路径缓存的键：描河读的数组（流量、流向、湖面、高程、陆海；推导换了就换）、河的门槛、
// 河道的内容（每次快照的河道数组都是新的，按内容认）、拖粗细时的临时样子。只改了名字的轻快照不重画，改了粗细的会重画。
// 预览世界（地图画将来的样子）只换了内容变了的数组：流量没变、湖面或高程变了的预览也不会错用当前世界的河
export function riverPathsKey(world: World, override: RiverStyleOverride | null): unknown[] {
  return [
    ...riverLinesKey(world),
    override ? `${override.id}|${override.width ?? ''}|${override.hide ? 1 : 0}` : '',
    override?.cells ?? null,
    // 河流类型（第三批）：类型的颜色、画法、粗细（按内容）
    riverTypesSignature(world.small.riverTypes),
  ];
}

// 河的折线（traceRivers）读的：上面那些数组、门槛、河道的内容，和每格是哪一种河（推导换了就换）。
// 河流类型的颜色、画法、粗细不改折线：只改这几项时不重新描河（大星球上描一遍要几十毫秒），只重新分档
function riverLinesKey(world: World): unknown[] {
  return [
    world.mesh,
    world.derived.discharge,
    world.derived.receiver,
    world.derived.lake,
    world.derived.elevation,
    world.causes.land,
    world.small.planet.riverThreshold,
    guidesSignature(world.small.guides),
    world.derived.riverType,
  ];
}

// 河流类型里影响画法的几项（没有河流类型时为 ''）
function riverTypesSignature(types: readonly RiverType[] | undefined): string {
  return types?.length ? JSON.stringify(types.map((t) => [t.id, t.color, t.atlasColor ?? '', t.style ?? 'solid', t.width ?? 1])) : '';
}

export const samePathsKey = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((k, i) => k === b[i]);

// 地图上的河的折线（traceRivers），按 riverLinesKey 缓存。只在主线程用：worker 里水文就地改写流量数组，
// 按数组认会认错。留最近用过的两份：地图画预览世界（将来的河）时，点河、河的光照旧按当前世界的河算，
// 预览世界一份份换（拖着调整面板的滑块）也不会把当前世界的那份挤掉、来回重描
const linesMemo: { key: unknown[]; lines: RiverLine[] }[] = [];
export function riverLines(world: World): RiverLine[] {
  const key = riverLinesKey(world);
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
  const buckets = new Map<number, RecPath>();
  const own = override ? small.guides.find((g) => g.id === override.id) : undefined;
  // 带类型的河（第三批）：只在世界里有河流类型时分开画
  const types = small.riverTypes?.length && world.derived.riverType ? small.riverTypes : null;
  const typed: TypedBuckets = { map: new Map() };
  const add = (line: RiverLine, scale = 1) => (types && line.type ? addTypedRiver(buckets, typed, line, thr, sphere, types, scale) : addRiver(buckets, line, thr, sphere, scale));
  for (const line of riverLines(world)) {
    if (override?.cells && line.guide === undefined) for (const piece of splitRiverLine(line, override.cells, false)) add(piece);
    else if (!override || line.guide !== override.id) add(line);
    else if (!override.hide) add(line, override.width !== undefined ? override.width / (own?.width ?? 1) : 1);
  }
  const rivers = sortedBuckets(buckets);
  const guides = new Path2D();
  const lockedGuides = new Path2D();
  const sinks: [number, number][] = [];
  for (const g of small.guides) {
    // 改着的这条河：标记也先不画（预览画改好的样子）
    if (override?.hide && g.id === override.id) continue;
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
  // 镜头正在动（渲染器按低分辨率画的那几帧）：底层的河挪用缓存的那张、地名沿用排好的版面，停稳后按原样画
  motion?: boolean;
  // 导出图片：底层的河直接画（不贴缓存），与原来逐像素相同
  exact?: boolean;
  // 导出整张地图（.png）：画在一张离屏的大画布上，按这个虚拟窗口（cw × ch 个 CSS 像素，每个 CSS 像素 dpr 个像素）画，
  // 不清空画布（直接画在底图上）、不用也不动屏幕上的缓存；地名排整张图、不伸出图外，整个星球只排一份
  frame?: Frame;
}

export interface Frame {
  cw: number;
  ch: number;
  dpr: number;
}

// 画布的大小（CSS 像素）与每个 CSS 像素几个像素：导出时按给的虚拟窗口，否则按屏幕上的画布
function frameOf(ctx: { canvas: { clientWidth: number; clientHeight: number } }, st?: { frame?: Frame }): Frame {
  if (st?.frame) return st.frame;
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  return { cw: ctx.canvas.clientWidth, ch: ctx.canvas.clientHeight, dpr };
}

// 整个星球的平铺图：屏幕上看得见的副本（x 平移 2k）。河、画的河展开后可能伸出 [0, 2) 一点，所以多算一点
function copiesFor(cam: Camera, cw: number): number[] {
  const halfW = cw / 2 / cam.zoom;
  const k0 = Math.ceil((cam.x - halfW - 2.6) / 2);
  const k1 = Math.floor((cam.x + halfW + 0.6) / 2);
  const out: number[] = [];
  for (let k = k0; k <= k1 && out.length < 7; k++) out.push(k);
  return out;
}

// 整个星球的格比同样格数的地区地图小：按格距把缩放换算成“相当于 4 万格地区地图的缩放”，
// 河宽、何时标省名和山峰都按它算（一块地区照旧用原来的缩放）
function refZoom(world: World, zoom: number): number {
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

// 叠加层最底下的那一层（河、画的河道标记、湖标记）：只随画出来的世界、河的路径、镜头、选项变。
// 停稳时画进一张与叠加层一样大的离屏画布缓存着（画笔拖动、鼠标移动时不重描几万段河），先清空再画、
// 整张原样贴回，与直接画在叠加层上逐像素相同；移动中按 MOTION_LAYER_SCALE 的分辨率、四周多画 MOTION_LAYER_MARGIN，
// 镜头还在边距之内、缩放没变太多时把这一张挪一挪、缩一缩贴上，停下以后（停稳的那一帧）再按原样画
const MOTION_LAYER_SCALE = 0.5;
const MOTION_LAYER_MARGIN = 0.25;
const MOTION_LAYER_ZOOM = 1.3;
interface BackLayer {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  key: unknown[];
  cam: Camera;
  soft: boolean;
  // 缓存里已经画好（停稳的那一张第一次没变时才画）
  ready: boolean;
  // 画它时每个 CSS 像素几个像素（页面缩放变了、画布像素数没变时也要重画）
  dpr: number;
}
let restLayer: BackLayer | null = null;
let motionLayer: BackLayer | null = null;

// 开发用（src/render/bench.ts 的 overlayBench）：底层改用软件画的画布，测速时能同步量到画它花的时间
export const overlayDebug = { softLayers: false };

function makeLayer(w: number, h: number, dpr: number): BackLayer {
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d', overlayDebug.softLayers ? { willReadFrequently: true } : undefined) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
  return { canvas, ctx, key: [], cam: { x: 0, y: 0, zoom: 1 }, soft: overlayDebug.softLayers, ready: false, dpr };
}

// 底层的河与标记，画进 ctx：画布是 cw × ch 个 CSS 像素、每个 CSS 像素 dev 个像素，镜头在画布中间
// cull：只描画布上看得见的那几笔（移动中的底层用；停稳的照原样整条描，逐像素与原来相同）
function drawBack(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, world: World, paths: OverlayPaths, cam: Camera, st: OverlayState, cw: number, ch: number, dev: number, cull = false) {
  const z = cam.zoom * dev;
  const sphere = world.mesh.kind === 'sphere';
  const ks = sphere ? copiesFor(cam, cw) : [0];
  const setT = (k: number) => ctx.setTransform(z, 0, 0, z, (cw / 2 - (cam.x - 2 * k) * cam.zoom) * dev, (ch / 2 - cam.y * cam.zoom) * dev);
  const px = 1 / z;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const scale = riverScale(world, cam.zoom);
  const color = riverStroke(st.style);
  // 看得见的范围（地图单位，第 0 份；四周多留 48 个 CSS 像素给线宽、发光）。不到半个星球宽时才裁
  const m = 48 / cam.zoom;
  const vx0 = cam.x - cw / 2 / cam.zoom - m;
  const vx1 = cam.x + cw / 2 / cam.zoom + m;
  const vy0 = cam.y - ch / 2 / cam.zoom - m;
  const vy1 = cam.y + ch / 2 / cam.zoom + m;
  const clip = cull && vx1 - vx0 < (sphere ? 1 : world.mesh.width / 2);
  const pathOf = (r: { path: Path2D; pts?: Float32Array }, k: number) => (clip && r.pts ? culledPath(r.pts, vx0 - 2 * k, vy0, vx1 - 2 * k, vy1) : r.path);
  for (const k of ks) {
    setT(k);
    if (st.rivers) {
      ctx.strokeStyle = color;
      for (const r of paths.rivers) {
        ctx.lineWidth = r.width * scale * px * dev;
        ctx.stroke(pathOf(r, k));
      }
      // 带类型的河：各按自己的颜色、画法
      if (paths.typed) {
        const types = world.small.riverTypes ?? [];
        for (const r of paths.typed) {
          const t = types[r.type - 1];
          if (t) strokeRiverStyle(ctx as CanvasRenderingContext2D, pathOf(r, k), r.width * scale * px * dev, riverTypeColor(t, st.style), t.style ?? 'solid', dev);
        }
      }
    }
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
  return [paths, world.small.lakes, world.mesh, st.rivers, st.markers, st.style, world.small.riverTypes, world.small.planet.riverThreshold];
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
      drawBack(L.ctx, world, paths, cam, st, cw, ch, dpr, true);
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
  if (!samePathsKey(key, L.key) || !fits(L.cam)) {
    L.ctx.setTransform(1, 0, 0, 1, 0, 0);
    L.ctx.clearRect(0, 0, W, H);
    drawBack(L.ctx, world, paths, cam, st, lw, lh, dev, true);
    L.key = key;
    L.cam = { ...cam };
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

export function drawOverlay(ctx: CanvasRenderingContext2D, world: World, paths: OverlayPaths, cam: Camera, st: OverlayState): LabelBox[] {
  const canvas = ctx.canvas;
  const f = frameOf(ctx, st);
  const { cw, ch, dpr } = f;
  if (!st.frame && (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr))) {
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (!st.frame) ctx.clearRect(0, 0, canvas.width, canvas.height);
  const z = cam.zoom * dpr;
  const sphere = world.mesh.kind === 'sphere';
  // 整个星球：每一份看得见的副本各画一遍（一块地区只有 k = 0）
  const ks = sphere ? copiesFor(cam, cw) : [0];
  // 地图单位 → 设备像素（第 k 份副本向右平移 2k）
  const setT = (k: number) => ctx.setTransform(z, 0, 0, z, (cw / 2 - (cam.x - 2 * k) * cam.zoom) * dpr, (ch / 2 - cam.y * cam.zoom) * dpr);
  const px = 1 / z;
  const rz = refZoom(world, cam.zoom);

  const scale = riverScale(world, cam.zoom);
  const river = { scale, color: riverStroke(st.style) };
  // 河、河道标记、湖标记（缓存着的底层）
  pasteBack(ctx, world, paths, cam, st);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  setT(0);

  if (st.wind) drawWind(ctx, world, cam, st.season, px * dpr, f);
  if (st.currents && sphere) drawCurrents(ctx, world, cam, px * dpr, f);
  if (st.latitude) {
    if (sphere) drawGraticule(ctx, cam, ks, f, !!st.frame);
    else drawLatitude(ctx, world, cam, st.latitude, f);
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
        if (sx < -50 || sy < -20 || sx > cw * dpr + 50 || sy > ch * dpr + 20) continue;
        ctx.fillStyle = (l.kind && PROVINCE_LABEL_COLOR[l.kind]) || 'rgba(20,20,20,0.85)';
        ctx.strokeText(l.text, sx, sy);
        ctx.fillText(l.text, sx, sy);
      }
    }
  }
  // 导出整个星球：地名只排一份（图就是一整圈）
  const boxes = st.features ? drawLabels(ctx, cam, st, st.frame ? [0] : ks, rz) : [];
  if (st.scaleBar) {
    if (sphere) {
      // 平铺图上东西方向的比例随纬度变：取画面中心那条纬线上的比例，并写明是哪条纬线
      const lat = Math.max(-85, Math.min(85, 90 - 180 * cam.y));
      const where = Math.abs(lat) < 2 ? '赤道' : `${lat > 0 ? '北' : '南'}纬 ${Math.round(Math.abs(lat))}°`;
      drawScaleBar(ctx, cam, st.kmPerUnit * Math.cos((lat * Math.PI) / 180), st.cornerLift, f, where);
    } else drawScaleBar(ctx, cam, st.kmPerUnit, st.cornerLift, f);
  }
  return boxes;
}

// 整个星球的经纬网：经线、纬线的间隔随缩放变（每条线之间至少约 60 像素），回归线、极圈用虚线并写上名字
// exporting：导出整张地图（上面没有顶栏挡着，经度写在图的最上边）
function drawGraticule(ctx: CanvasRenderingContext2D, cam: Camera, ks: number[], f: Frame, exporting = false) {
  const { cw, ch, dpr } = f;
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
      label(name, x + 3, Math.max(top, exporting ? 0 : 70) + 8, 'left');
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
function drawLatitude(ctx: CanvasRenderingContext2D, world: World, cam: Camera, lat: { north: number; south: number }, f: Frame) {
  const { cw, ch, dpr } = f;
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
function drawScaleBar(ctx: CanvasRenderingContext2D, cam: Camera, kmPerUnit: number, lift: number, f: Frame, where?: string) {
  const { ch, dpr } = f;
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
// key：整个键；base：键里除了镜头的部分（移动中沿用排好的版面时比它）；cam：排的时候的镜头
let layout: { key: string; base: string; cam: Camera; features: GeoFeature[] | null; placed: PlacedLabel[]; boxes: LabelBox[] } | null = null;

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
  const { cw, ch: chh } = frameOf(ctx, st);
  const exporting = !!st.frame;
  const base = `${cw}|${chh}|${st.kmPerUnit}|${st.labelTypes ? [...st.labelTypes].join(',') : '*'}|${st.hoverLabel ?? ''}`;
  const key = `${cam.x}|${cam.y}|${cam.zoom}|${ks.join(',')}|${base}`;
  if (!exporting && layout && layout.key === key && layout.features === st.features) return layout;
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
    for (const [x0, y0] of spots) {
      let sx = x0 + shift;
      let sy = y0;
      // 导出整张地图：整个字在图里（伸出边的往里挪；比图还大的不标）
      if (exporting) {
        if (2 * hw > cw || 2 * hh > chh) continue;
        sx = Math.max(hw, Math.min(cw - hw, sx));
        sy = Math.max(hh, Math.min(chh - hh, sy));
      }
      const box = { key: f.key, x0: sx - hw, y0: sy - hh, x1: sx + hw, y1: sy + hh };
      if (boxes.some((b) => b.x0 < box.x1 && b.x1 > box.x0 && b.y0 < box.y1 && b.y1 > box.y0)) continue;
      boxes.push(box);
      placed.push({ key: f.key, chars, widths, spacing, total, font, color: f.custom ? '#7a1f5c' : style.color, x: sx, y: sy, angle });
    }
  }
  const out = { key, base, cam: { ...cam }, features: st.features, placed, boxes };
  if (!exporting) layout = out;
  return out;
}

// 移动中：镜头离排版面时挪了不到这么多（CSS 像素）、缩放变了不到这么多倍时，沿用排好的版面，整体挪一挪、缩一缩
const MOTION_LABEL_SHIFT = 160;
const MOTION_LABEL_ZOOM = 1.15;

function drawLabels(ctx: CanvasRenderingContext2D, cam: Camera, st: OverlayState, ks: number[], rz: number): LabelBox[] {
  const { cw, ch: chh, dpr } = frameOf(ctx, st);
  // 版面上的位置（CSS 像素）→ 现在的位置：x · r + ox
  let r = 1;
  let ox = 0;
  let oy = 0;
  let placed: PlacedLabel[];
  let boxes: LabelBox[];
  const L = layout;
  const base = `${cw}|${chh}|${st.kmPerUnit}|${st.labelTypes ? [...st.labelTypes].join(',') : '*'}|${st.hoverLabel ?? ''}`;
  const zr = L ? cam.zoom / L.cam.zoom : 0;
  if (
    st.motion &&
    !st.frame &&
    L &&
    L.base === base &&
    L.features === st.features &&
    zr < MOTION_LABEL_ZOOM &&
    zr > 1 / MOTION_LABEL_ZOOM &&
    Math.abs(L.cam.x - cam.x) * cam.zoom < MOTION_LABEL_SHIFT &&
    Math.abs(L.cam.y - cam.y) * cam.zoom < MOTION_LABEL_SHIFT
  ) {
    r = zr;
    ox = cw / 2 - (cw / 2) * r + (L.cam.x - cam.x) * cam.zoom;
    oy = chh / 2 - (chh / 2) * r + (L.cam.y - cam.y) * cam.zoom;
    placed = L.placed;
    boxes = L.boxes.map((b) => ({ key: b.key, x0: b.x0 * r + ox, y0: b.y0 * r + oy, x1: b.x1 * r + ox, y1: b.y1 * r + oy }));
  } else ({ placed, boxes } = placeLabels(ctx, cam, st, ks, rz));
  if (r === 1 && ox === 0 && oy === 0) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  else ctx.setTransform(dpr * r, 0, 0, dpr * r, dpr * ox, dpr * oy);
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
