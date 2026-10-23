import { FEATURE_INFO, type FeatureType, type GeoFeature } from '../../core/features';
import { circle as geoCircle, wrapX } from '../../core/geo';
import type { RiverStyle, RiverType } from '../../core/river-types';
import { type RiverLine, type RiverRibbon, guideShape, guidesSignature, riverRibbon, traceRivers } from '../../core/rivers';
import { coastSeed } from '../../core/terrain';
import type { World } from '../../core/world';
import type { Camera, RiverTex } from './renderer';
import { drawCurrents, drawWind } from './wind';

// 2D 画布上的矢量叠加：河流、河道引导、湖标记、风向、画笔、箭头、预览路径、地名。
// 海岸线、省份边界、选区轮廓在着色器里画（自然曲线）。
// 路径按地图单位预先构建成 Path2D，绘制时只换变换矩阵，平移缩放很便宜。

export interface OverlayPaths {
  // 地图上的河：每条河线一条带子（core/rivers.ts 的 riverRibbon），画的时候按镜头算出两岸
  rivers: RiverDraw[];
  guides: Path2D;
  lockedGuides: Path2D;
  // 在终点消失的河道的终点（水模式下画一个小圈）
  sinks: [number, number][];
}

// 一条要画的河：带子，与每个河线点是哪一种河（0 普通，k + 1 是第 k 种河流类型；没有河流类型时省略）
export interface RiverDraw {
  rb: RiverRibbon;
  type?: Uint8Array;
}

// ---------- 河的画法（地图上的河、预览的河共用，预览与结果画出来一样） ----------

// 河宽随放大变宽，一直到最大缩放（一格约 64 像素）：按“相当于 4 万格地区地图的缩放”算
function riverScale(world: World, zoom: number): number {
  return Math.max(0.7, Math.min(4, refZoom(world, zoom) / 1400));
}

// 河的颜色
export function riverStroke(style: 'realistic' | 'atlas'): string {
  return style === 'atlas' ? 'rgba(70, 110, 150, 0.95)' : 'rgba(52, 104, 168, 0.92)';
}
// 两岸的细线（压在河面下面，露出外侧的一半）
const BANK_COLOR = { realistic: 'rgba(24, 52, 88, 0.55)', atlas: 'rgba(48, 70, 92, 0.55)' };

// 一种河流类型画出来的颜色（地图集风格用 atlasColor）
export function riverTypeColor(t: Pick<RiverType, 'color' | 'atlasColor'>, style: 'realistic' | 'atlas'): string {
  return style === 'atlas' ? (t.atlasColor ?? t.color) : t.color;
}

// 按河流类型的画法沿中线描一条（虚线、双线、发光：整条河一笔，lw 是线宽，单位与路径相同）：
// 虚线（3 倍线宽一段、2 倍线宽一空）；双线（先描整条，再在中间描一道 0.45 倍宽的半透明白线）；发光（同色的 6 像素光晕）
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

// 一条河线 → 要画的河。scale：再乘的粗细（拖“粗细”时）；types：河流类型（带类型的点再乘类型的粗细）
function riverDraw(line: RiverLine, thr: number, spacing: number, types: readonly RiverType[] | null, scale = 1): RiverDraw {
  const tags = types && line.type ? line.type : null;
  const typeMul = (k: number) => {
    const t = tags ? tags[k] : 0;
    return scale * (t > 0 ? (types![t - 1]?.width ?? 1) : 1);
  };
  const rb = riverRibbon(line, thr, spacing, typeMul);
  if (!tags || !tags.some((t) => t > 0 && types![t - 1])) return { rb };
  return { rb, type: Uint8Array.from(tags) };
}

// 一串河线画成要画的河（预览的河、测试用；地图上的河见 buildPaths）
export function riverDraws(world: World, lines: RiverLine[]): RiverDraw[] {
  return lines.map((line) => riverDraw(line, world.small.planet.riverThreshold, world.mesh.spacing, null));
}

// 一次画的河：画布上要描的几样东西（按颜色合成一笔：同色的带子一次填，交汇处不会叠出深色）
interface RiverPaint {
  banks: Path2D | null;
  // 细于一个像素的河：沿中线描（颜色|线宽 → 路径；lw 是 CSS 像素）
  thin: Map<string, { path: Path2D; color: string; lw: number }>;
  fills: Map<string, Path2D>;
  // 虚线、双线、发光的河：每条一笔
  styled: { path: Path2D; color: string; lw: number; style: RiverStyle }[];
}

// 每次加一条河用的几个数组（按最长的河分配，反复用）
let scratch = { length: 0, idx: new Int32Array(0), bx: new Float64Array(0), by: new Float64Array(0) };

// 把要画的河加进 paint。k：半宽（屏幕像素）合多少地图单位；unit：一个 CSS 像素合多少地图单位；
// view：看得见的范围（地图单位，第 0 份），null 不裁（预览的河：调用方按副本挪好了变换）；sphere：整个星球（按副本平移 2）
function addRiverPaint(
  paint: RiverPaint,
  d: RiverDraw,
  k: number,
  unit: number,
  scale: number,
  view: [number, number, number, number] | null,
  sphere: boolean,
  colorOf: (t: number) => { color: string; style: RiverStyle },
  step = 0.7 * unit,
) {
  const rb = d.rb;
  const n = rb.x.length;
  if (n < 2) return;
  const margin = rb.maxHw * k + 2 * unit;
  let c0 = 0;
  let c1 = 0;
  if (view) {
    if (rb.y1 + margin < view[1] || rb.y0 - margin > view[3]) return;
    if (sphere) {
      c0 = Math.ceil((view[0] - rb.x1 - margin) / 2);
      c1 = Math.min(c0 + 6, Math.floor((view[2] - rb.x0 + margin) / 2));
    } else if (rb.x1 + margin < view[0] || rb.x0 - margin > view[2]) return;
  }
  // 屏幕上相隔不到 0.7 像素的点不要（看全图时一格只有几个像素）
  const dmin = step;
  const thin = 2 * rb.maxHw * scale < 1;
  const wide = 2 * rb.maxHw * scale >= 2.5;
  const S = rb.s;
  if (scratch.length < n) scratch = { length: n, idx: new Int32Array(n), bx: new Float64Array(n), by: new Float64Array(n) };
  const { idx, bx, by } = scratch;
  for (let cp = c0; cp <= c1; cp++) {
    const dx = 2 * cp;
    for (let i0 = 0; i0 < n - 1; ) {
      // 同一种河的一段（相邻两段共用分界的点）
      const t = d.type ? d.type[rb.src[i0]] : 0;
      let i1 = i0 + 1;
      while (i1 < n - 1 && (d.type ? d.type[rb.src[i1]] : 0) === t) i1++;
      let m = 0;
      idx[m++] = i0;
      for (let i = i0 + 1; i < i1; i++) if (S[i] - S[idx[m - 1]] >= dmin) idx[m++] = i;
      idx[m++] = i1;
      const { color, style } = colorOf(t);
      const X = rb.x;
      const Y = rb.y;
      if (style !== 'solid' || thin) {
        let sum = 0;
        for (let i = i0; i <= i1; i++) sum += rb.hw[i];
        const lw = Math.max(0.25, Math.round(((2 * sum) / (i1 - i0 + 1)) * scale * 4) / 4);
        let path: Path2D;
        if (style !== 'solid') paint.styled.push({ path: (path = new Path2D()), color, lw: lw * unit, style });
        else {
          const key = `${color}|${lw}`;
          let e = paint.thin.get(key);
          if (!e) paint.thin.set(key, (e = { path: new Path2D(), color, lw }));
          path = e.path;
        }
        path.moveTo(X[idx[0]] + dx, Y[idx[0]]);
        for (let j = 1; j < m; j++) path.lineTo(X[idx[j]] + dx, Y[idx[j]]);
      } else {
        let f = paint.fills.get(color);
        if (!f) paint.fills.set(color, (f = new Path2D()));
        // 两岸的点（左岸 ox + ux，右岸 ox − ux）
        for (let j = 0; j < m; j++) {
          const i = idx[j];
          const o = rb.hw[i] * k;
          bx[j] = rb.nx[i] * o;
          by[j] = rb.ny[i] * o;
        }
        f.moveTo(X[idx[0]] + dx + bx[0], Y[idx[0]] + by[0]);
        for (let j = 1; j < m; j++) f.lineTo(X[idx[j]] + dx + bx[j], Y[idx[j]] + by[j]);
        for (let j = m - 1; j >= 0; j--) f.lineTo(X[idx[j]] + dx - bx[j], Y[idx[j]] - by[j]);
        f.closePath();
        if (wide) {
          paint.banks ??= new Path2D();
          const b = paint.banks;
          b.moveTo(X[idx[0]] + dx + bx[0], Y[idx[0]] + by[0]);
          for (let j = 1; j < m; j++) b.lineTo(X[idx[j]] + dx + bx[j], Y[idx[j]] + by[j]);
          b.moveTo(X[idx[0]] + dx - bx[0], Y[idx[0]] - by[0]);
          for (let j = 1; j < m; j++) b.lineTo(X[idx[j]] + dx - bx[j], Y[idx[j]] - by[j]);
        }
      }
      i0 = i1;
    }
  }
}

// 描出 paint：两岸的细线、细的河、同色的带子（一次填）、虚线 / 双线 / 发光的河。unit：一个 CSS 像素合多少地图单位
function strokeRiverPaint(ctx: CanvasRenderingContext2D, paint: RiverPaint, unit: number, style: 'realistic' | 'atlas', dpr: number) {
  ctx.lineJoin = 'round';
  if (paint.banks) {
    ctx.lineCap = 'butt';
    ctx.strokeStyle = BANK_COLOR[style];
    ctx.lineWidth = 1.1 * unit;
    ctx.stroke(paint.banks);
  }
  ctx.lineCap = 'round';
  for (const e of paint.thin.values()) {
    ctx.strokeStyle = e.color;
    ctx.lineWidth = e.lw * unit;
    ctx.stroke(e.path);
  }
  for (const [color, path] of paint.fills) {
    ctx.fillStyle = color;
    ctx.fill(path);
  }
  for (const e of paint.styled) strokeRiverStyle(ctx, e.path, e.lw, e.color, e.style, dpr);
}

const newPaint = (): RiverPaint => ({ banks: null, thin: new Map(), fills: new Map(), styled: [] });

// 缩小到一格不到 6 个像素时（河多、每条只占几个像素，看不出两岸和弯曲）：整个世界的河沿中线按宽度分档描，
// 一次加好缓存着（第 0 份的坐标，与缩放无关：线宽按档 × 现在的系数，点隔多远分三档），每帧只描。
// Path2D 每加一个点要约一微秒，看全图时有几万个点，每帧现加会卡；放大以后只加看得见的那几条，每帧现加带子
const LOW_ZOOM_CELL_PX = 6;
interface LowZoomStrokes {
  // 颜色|宽度档（CSS 像素，未乘系数）→ 路径
  plain: Map<string, { path: Path2D; color: string; w: number }>;
  styled: { path: Path2D; color: string; w: number; style: RiverStyle }[];
}
const lowZoomCaches = new WeakMap<OverlayPaths, { key: string; types: unknown; v: LowZoomStrokes }[]>();
function lowZoomStrokes(paths: OverlayPaths, cellPx: number, spacing: number, style: 'realistic' | 'atlas', colorOf: (t: number) => { color: string; style: RiverStyle }, types: unknown): LowZoomStrokes {
  const lod = cellPx < 2 ? 0.5 : cellPx < 4 ? 0.25 : 0.125;
  const key = `${lod}|${style}`;
  let list = lowZoomCaches.get(paths);
  if (!list) lowZoomCaches.set(paths, (list = []));
  const hit = list.find((e) => e.key === key && e.types === types);
  if (hit) return hit.v;
  const v: LowZoomStrokes = { plain: new Map(), styled: [] };
  const dmin = lod * spacing;
  const bucket = (hw: number) => Math.max(0.25, Math.round(2 * hw * 4) / 4);
  for (const d of paths.rivers) {
    const rb = d.rb;
    const n = rb.x.length;
    for (let i0 = 0; i0 < n - 1; ) {
      const t = d.type ? d.type[rb.src[i0]] : 0;
      let i1 = i0 + 1;
      while (i1 < n - 1 && (d.type ? d.type[rb.src[i1]] : 0) === t) i1++;
      const { color, style: st } = colorOf(t);
      if (st !== 'solid') {
        let sum = 0;
        for (let i = i0; i <= i1; i++) sum += rb.hw[i];
        const path = new Path2D();
        path.moveTo(rb.x[i0], rb.y[i0]);
        let last = i0;
        for (let i = i0 + 1; i <= i1; i++) if (i === i1 || rb.s[i] - rb.s[last] >= dmin) path.lineTo(rb.x[(last = i)], rb.y[i]);
        v.styled.push({ path, color, w: (2 * sum) / (i1 - i0 + 1), style: st });
      } else {
        // 宽度档相同的一段一笔（相邻两段共用分界的点）
        for (let a = i0; a < i1; ) {
          const w = bucket(rb.hw[a]);
          let b = a + 1;
          while (b < i1 && bucket(rb.hw[b]) === w) b++;
          const k = `${color}|${w}`;
          let e = v.plain.get(k);
          if (!e) v.plain.set(k, (e = { path: new Path2D(), color, w }));
          e.path.moveTo(rb.x[a], rb.y[a]);
          let last = a;
          for (let i = a + 1; i <= b; i++) if (i === b || rb.s[i] - rb.s[last] >= dmin) e.path.lineTo(rb.x[(last = i)], rb.y[i]);
          a = b;
        }
      }
      i0 = i1;
    }
  }
  list.unshift({ key, types, v });
  list.length = Math.min(list.length, 3);
  return v;
}

// 一种河的颜色与画法：0 是普通的河（color），k + 1 是第 k 种河流类型
function typeColors(types: readonly RiverType[], style: 'realistic' | 'atlas', plain: string): (t: number) => { color: string; style: RiverStyle } {
  return (t) => {
    const spec = t > 0 ? types[t - 1] : undefined;
    return spec ? { color: riverTypeColor(spec, style), style: spec.style ?? 'solid' } : { color: plain, style: 'solid' };
  };
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
      // 源头、河口还在这一段上时照样收尖、张开
      if (line.head && cur[0] === 0) piece.head = line.head;
      if (line.mouth && cur[cur.length - 1] === line.points.length - 1) piece.mouth = true;
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

// 河的折线（traceRivers）读的：上面那些数组、门槛、河道的内容，每格是哪一种河（推导换了就换），和画面上的岸线。
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
    // 河口画到画面上的岸线（core/display.ts 的 shoreCrossing）：岸线跟着陆地程度、海岸破碎度、海岸的种子、湖面走
    world.causes.landness,
    world.derived.water,
    world.small.terrain.coastRoughness,
    coastSeed(world),
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
  const own = override ? small.guides.find((g) => g.id === override.id) : undefined;
  // 带类型的河（第三批）：只在世界里有河流类型时分开画
  const types = small.riverTypes?.length && world.derived.riverType ? small.riverTypes : null;
  const rivers: RiverDraw[] = [];
  const add = (line: RiverLine, scale = 1) => rivers.push(riverDraw(line, thr, mesh.spacing, types, scale));
  for (const line of riverLines(world)) {
    if (override?.cells && line.guide === undefined) for (const piece of splitRiverLine(line, override.cells, false)) add(piece);
    else if (!override || line.guide !== override.id) add(line);
    else if (!override.hide) add(line, override.width !== undefined ? override.width / (own?.width ?? 1) : 1);
  }
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
  return { rivers, guides, lockedGuides, sinks };
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
  // river：起点是源头（收尖）还是湖岸；最后一点在岸线上（河口略张开）。见 RiverLine
  head?: 'source' | 'lake';
  mouth?: boolean;
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
  // 河画在叠加层上（屏幕、导出的地图上河由渲染器合成，只画在陆地上：MapView 给 false，见 riverLayer）
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
  // 渲染器移动中的场景重画到第几次了（Renderer.motionEpoch）：变了就在同一帧重画底层的河、重排地名
  motionEpoch?: number;
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
// 与渲染器移动中的场景同样的边距、缩放（同一帧重建，见 motionEpoch）
const MOTION_LAYER_MARGIN = 0.35;
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
  // 移动中的那张：画它时渲染器的 motionEpoch
  epoch?: number;
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

// 河，画进 ctx：画布是 cw × ch 个 CSS 像素、每个 CSS 像素 dev 个像素，镜头在画布中间。河只加画布上看得见的那几条（按外接框裁）
function drawRivers(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, world: World, paths: OverlayPaths, cam: Camera, style: 'realistic' | 'atlas', cw: number, ch: number, dev: number) {
  const z = cam.zoom * dev;
  const sphere = world.mesh.kind === 'sphere';
  const ks = sphere ? copiesFor(cam, cw) : [0];
  const setT = (k: number) => ctx.setTransform(z, 0, 0, z, (cw / 2 - (cam.x - 2 * k) * cam.zoom) * dev, (ch / 2 - cam.y * cam.zoom) * dev);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // 看得见的范围（地图单位，第 0 份；四周多留 48 个 CSS 像素给线宽、发光）
  const m = 48 / cam.zoom;
  const view: [number, number, number, number] = [cam.x - cw / 2 / cam.zoom - m, cam.y - ch / 2 / cam.zoom - m, cam.x + cw / 2 / cam.zoom + m, cam.y + ch / 2 / cam.zoom + m];
  // 每条河按看得见的副本各加一份（坐标里平移 2），同色的带子一次填
  setT(0);
  const scale = riverScale(world, cam.zoom);
  const unit = 1 / cam.zoom;
  const colorOf = typeColors(world.small.riverTypes ?? [], style, riverStroke(style));
  const low = world.mesh.spacing * cam.zoom < LOW_ZOOM_CELL_PX;
  const paint = newPaint();
  if (low) {
    // 整个世界的河缓存着（第 0 份的坐标）：每份看得见的副本各描一遍
    const cached = lowZoomStrokes(paths, world.mesh.spacing * cam.zoom, world.mesh.spacing, style, colorOf, world.small.riverTypes);
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

// ---------- 河的图层（第十三轮）：画进一张离屏画布，交给渲染器在合成一步里按每像素的陆海混进地图 ----------
// 海面、湖面上不画（河口正好停在岸线），排在省份着色、晕渲之后，海岸线、省界、高亮之前（见 renderer.ts 的 FS_COMPOSE）。
// 停稳时是与地图画布一样大的一张；移动中按 MOTION_LAYER_SCALE 的分辨率、四周多画 MOTION_LAYER_MARGIN，镜头还在边距之内、
// 缩放没变太多时照用（渲染器按 toUv 挪一挪、缩一缩取），渲染器移动中的场景重画时同一帧重画。导出整张地图时每块另画一张
interface RiverCache {
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
let riverRest: RiverCache | null = null;
let riverMotion: RiverCache | null = null;
let riverTile: RiverCache | null = null;
// 每画一次河的图层加一（渲染器按它决定要不要重新上传）
let riverVersion = 0;

function riverCache(old: RiverCache | null, W: number, H: number): RiverCache {
  if (old && old.canvas.width === W && old.canvas.height === H && old.soft === overlayDebug.softLayers) return old;
  const L = makeLayer(W, H, 1);
  return { canvas: L.canvas, ctx: L.ctx, key: [], cam: { x: 0, y: 0, zoom: 1 }, cw: 0, ch: 0, dev: 0, soft: L.soft, version: -1 };
}

function paintRivers(L: RiverCache, world: World, paths: OverlayPaths, cam: Camera, style: 'realistic' | 'atlas', cw: number, ch: number, dev: number, key: unknown[]) {
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
function riverTex(L: RiverCache): RiverTex {
  const c = L.cam;
  const z = c.zoom * L.dev;
  const W = L.canvas.width;
  const H = L.canvas.height;
  return { source: L.canvas, version: L.version, toUv: [z / W, ((L.cw / 2 - c.x * c.zoom) * L.dev) / W, -z / H, 1 - ((L.ch / 2 - c.y * c.zoom) * L.dev) / H] };
}

const riverKey = (world: World, paths: OverlayPaths, style: string): unknown[] => [paths, world.mesh, style, world.small.riverTypes, world.small.planet.riverThreshold];

// 屏幕上的河。screen：地图的画布（像素数与 CSS 大小）；motion：渲染器这一帧按移动中的画法画（或刚停下的那一帧）
export function riverLayer(
  world: World,
  paths: OverlayPaths,
  cam: Camera,
  st: { style: 'realistic' | 'atlas'; motion?: boolean; motionEpoch?: number },
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
export function riverLayerTile(world: World, paths: OverlayPaths, cam: Camera, style: 'realistic' | 'atlas', T: number, dpr: number): RiverTex {
  const L = (riverTile = riverCache(riverTile, T, T));
  paintRivers(L, world, paths, cam, style, T / dpr, T / dpr, dpr, riverKey(world, paths, style));
  return riverTex(L);
}

// 导出完放掉那一块的画布
export function releaseRiverTile() {
  riverTile = null;
}

// st.rivers：河画在叠加层上（测试、测速用；屏幕与导出的地图上河由渲染器合成，见 riverLayer，MapView 这里给 false）
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
        // 导出整张地图：每个省名只标中心落在图里的那一份（分界线附近不标两遍）
        if (st.frame && (sx < 0 || sx >= cw * dpr)) continue;
        ctx.fillStyle = (l.kind && PROVINCE_LABEL_COLOR[l.kind]) || 'rgba(20,20,20,0.85)';
        ctx.strokeText(l.text, sx, sy);
        ctx.fillText(l.text, sx, sy);
      }
    }
  }
  // 导出整个星球：图就是一整圈（分界线可以在任何经度），每个地名只在中心落在图里的那一份上排
  const boxes = st.features ? drawLabels(ctx, cam, st, ks, rz) : [];
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

// 预览的河：与地图上的河同一套画法（带子、宽度、颜色，见 riverDraw）。带子按图形的点数组缓存（光、预览的图形沿用同一个数组时不重算）
const shapeDraws = new WeakMap<object, { key: string; d: RiverDraw }>();
function drawRiverShape(ctx: CanvasRenderingContext2D, world: World, sh: Shape, unit: number, river: { scale: number; color: string }, style: 'realistic' | 'atlas') {
  const pts = sh.points;
  const flow = sh.flow;
  if (!pts || !flow || pts.length < 2) return;
  ctx.setLineDash([]);
  const rt = sh.riverType;
  const color = sh.color ?? (rt ? riverTypeColor(rt, style) : river.color);
  const thr = world.small.planet.riverThreshold;
  const key = `${thr}|${world.mesh.spacing}|${rt?.width ?? 1}|${sh.head ?? ''}|${sh.mouth ? 1 : 0}`;
  let hit = shapeDraws.get(pts);
  if (!hit || hit.key !== key || hit.d.rb.x.length === 0) {
    const line: RiverLine = { points: pts, flow, ...(sh.mul ? { mul: sh.mul } : {}), ...(sh.head ? { head: sh.head } : {}), ...(sh.mouth ? { mouth: true } : {}) };
    hit = { key, d: riverDraw(line, thr, world.mesh.spacing, rt ? [rt] : null, 1) };
    if (rt) hit.d = { rb: hit.d.rb, type: new Uint8Array(pts.length).fill(1) };
    shapeDraws.set(pts, hit);
  }
  const d = hit.d;
  // 整个星球：按起点挪到 [0, 2) 里那一份（调用方按每份副本挪好了变换）
  const shift = world.mesh.kind === 'sphere' ? 2 * Math.floor(pts[0][0] / 2) : 0;
  const paint = newPaint();
  const dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
  const colorOf = (t: number) => (t > 0 && rt ? { color, style: rt.style ?? 'solid' } : { color, style: 'solid' as RiverStyle });
  ctx.save();
  if (shift) ctx.transform(1, 0, 0, 1, -shift, 0);
  addRiverPaint(paint, d, river.scale * unit, unit, river.scale, null, false, colorOf);
  strokeRiverPaint(ctx, paint, unit, style, dpr);
  ctx.restore();
  if (!sh.arrow) return;
  // 河口的小箭头：比河稍宽，顺着最后一段
  const rb = d.rb;
  const n = rb.x.length;
  const [x1, y1] = [rb.x[n - 1] - shift, rb.y[n - 1]];
  const back = Math.max(0, n - 4);
  const [x0, y0] = [rb.x[back] - shift, rb.y[back]];
  const w = 2 * rb.hw[n - 1] * river.scale;
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
// key：整个键；base：键里除了镜头的部分（移动中沿用排好的版面时比它）；cam：排的时候的镜头；
// epoch：移动中排的那一次渲染器的 motionEpoch（停稳时排的为 undefined）
let layout: { key: string; base: string; cam: Camera; features: GeoFeature[] | null; placed: PlacedLabel[]; boxes: LabelBox[]; epoch?: number } | null = null;

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
  const key = `${cam.x}|${cam.y}|${cam.zoom}|${ks.join(',')}|${base}|${st.motion ? 'm' : ''}`;
  if (!exporting && layout && layout.key === key && layout.features === st.features) return layout;
  const toScreen = (x: number, y: number): [number, number] => [(x - cam.x) * cam.zoom + cw / 2, (y - cam.y) * cam.zoom + chh / 2];
  // 移动中：画面四周再多排一圈（与渲染器移动中的场景一样宽），挪到下一次重排之前露出来的地方也有地名
  const mx = 100 + (st.motion && !exporting ? MOTION_LAYER_MARGIN * cw : 0);
  const my = 40 + (st.motion && !exporting ? MOTION_LAYER_MARGIN * chh : 0);
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
      if (x < -mx || y < -my || x > cw + mx || y > chh + my) continue;
      // 导出整张地图：只要中心落在图里的那一份（整个星球的图是一整圈，分界线两边的副本不标两遍）
      if (exporting && (x < 0 || x >= cw)) continue;
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
  const out = { key, base, cam: { ...cam }, features: st.features, placed, boxes, epoch: st.motion ? st.motionEpoch : undefined };
  if (!exporting) layout = out;
  return out;
}

// 移动中：沿用排好的版面，整体挪一挪、缩一缩；渲染器重画移动中的场景时（motionEpoch 变了）在同一帧重排。
// 没有 motionEpoch 时（测试、开发用的测速）照旧：挪了不到这么多（CSS 像素）、缩放变了不到这么多倍时沿用
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
    (st.motionEpoch !== undefined
      ? // 同一次场景（开始动的第一帧场景就重画了：地名也在这一帧按带边距的范围重排）
        L.epoch === st.motionEpoch &&
        zr < MOTION_LAYER_ZOOM &&
        zr > 1 / MOTION_LAYER_ZOOM
      : zr < MOTION_LABEL_ZOOM && zr > 1 / MOTION_LABEL_ZOOM && Math.abs(L.cam.x - cam.x) * cam.zoom < MOTION_LABEL_SHIFT && Math.abs(L.cam.y - cam.y) * cam.zoom < MOTION_LABEL_SHIFT)
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
