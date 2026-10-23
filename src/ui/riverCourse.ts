import { signal } from '@preact/signals';
import type { Command, GuidePatch } from '../../core/commands';
import type { PreviewResult } from '../../core/engine';
import { lakeArea } from '../../core/elevation';
import type { GeoFeature } from '../../core/features';
import { PLAIN_RIVER } from '../../core/river-types';
import { arcUnits, wrapX } from '../../core/geo';
import { type GuideLine, type RiverLine, centrePoints, cutPathAtCell, encodePath, guideLine, guideShape, ownsCell, smoothCourse, snapOnto, stemPath } from '../../core/rivers';
import {
  type CourseEnd,
  type CoursePlan,
  type RiverPlan,
  endCourseAt,
  extendCourse,
  extendPoint,
  guideEnd,
  guideFlow,
  guideWarnings,
  isRiverCell,
  mergeCourse,
  planCourse,
  planRiver,
  rerouteCourse,
  riverStem,
  spliceCourse,
} from '../../core/select';
import { roundKm as km } from '../../core/terrain';
import type { Guide, World } from '../../core/world';
import type { HighlightLayer } from '../render/colors';
import { type Shape, riverLines } from '../render/overlay';
import {
  type RiverRef,
  cancelPreviews,
  cursorHint,
  exec,
  measure,
  options,
  previewCommand,
  redrawTick,
  riverPending,
  riverStyleOverride,
  selectedRiver,
  showToast,
  tool,
  world,
} from '../state';
import { type Pointer, type Preview, type ToolHandler, groupCount, isBusy, pathKm, riverSizeName, worldId } from './tools';

// 画河、选河、删河：
//   · 顺地势：点源头起一条河，拖出路线时河沿着路线找路（与以前一样）；
//   · 自定义走向：按住画出河道，河完全照着画的线走（core/select.ts 的 planCourse），松手前就画出松手后的样子；
//   · 点一下已有的河就选中它（底部条换成这条河的名字、大小……），在选中的画的河上按住拖是重画这一段；
//   · 穿过别的河时松手后先问一句：截走它 / 到这里汇入 / 取消。
// 预览的河与地图上的河同一个画法（'river' 图形）；手停下来 150 毫秒后在 worker 里确切地算一遍，
// 换上确切的流量、会变干和新出现的河段、挖出的峡谷，松手时直接采用这个结果

const EMPTY: Preview = { layers: [], shapes: [], hint: null };
type RGB = [number, number, number];
const RED: RGB = [235, 80, 70];
const BLUE: RGB = [70, 150, 235];
// 挖出的河床（峡谷）
const CARVED: RGB = [150, 95, 55];
const RED_LINE = 'rgba(235, 80, 70, 0.95)';
const WHITE_LINE = 'rgba(255, 255, 255, 0.85)';
// 选中、悬停的河：沿河一道淡黄的光
const GLOW = 'rgba(255, 226, 120, 0.5)';

// 点中一条河：离画出来的线几个屏幕像素以内
const PICK_PX = 8;
// 在选中的画的河上按住拖是重画一段：离它的线 min(10 像素, 0.6 格) 以内（缩小看时不会离得很远也算）
export const spliceTol = (w: World, zoom: number) => Math.min(10 / zoom, 0.6 * w.mesh.spacing);

const water = (w: World, c: number) => !w.causes.land[c] || w.derived.lake[c] === 1;

// ---------- 地名：每格在哪条有名字的河上、哪个湖里 ----------

interface FeatureIndex {
  rivers: Map<number, GeoFeature[]>;
  lakes: Map<number, GeoFeature>;
  guides: Map<string, GeoFeature>;
}
const featureCache = new WeakMap<World, FeatureIndex>();
function featureIndex(w: World): FeatureIndex {
  let ix = featureCache.get(w);
  if (ix) return ix;
  ix = { rivers: new Map(), lakes: new Map(), guides: new Map() };
  for (const f of w.derived.features) {
    if (f.type === 'river') {
      if (f.guide !== undefined) ix.guides.set(f.guide, f);
      for (const c of f.cells) {
        const list = ix.rivers.get(c);
        if (list) list.push(f);
        else ix.rivers.set(c, [f]);
      }
    } else if (f.type === 'lake') for (const c of f.cells) ix.lakes.set(c, f);
  }
  featureCache.set(w, ix);
  return ix;
}

// 画的河的地名（有名字的河道才有）
export const guideFeature = (w: World, id: string) => featureIndex(w).guides.get(id);
// 这一格上的自然大河（有地名的）
export const naturalFeatureAt = (w: World, cell: number) => featureIndex(w).rivers.get(cell)?.find((f) => f.guide === undefined);
// 这一格上的河叫什么（画的河、自然的河都算；not：不算这一条）
const riverNameAt = (w: World, cell: number, not?: GeoFeature) => featureIndex(w).rivers.get(cell)?.find((f) => f !== not && f.name)?.name || null;
const lakeNameAt = (w: World, cell: number) => featureIndex(w).lakes.get(cell)?.name || null;
export const guideOf = (w: World, id: string) => w.small.guides.find((g) => g.id === id);

// 流到哪里：入海、流进「青湖」、汇入「赤江」……quoted 为 false 时不带引号
export function destText(w: World, kind: CourseEnd | 'unknown' | null, cell: number, quoted = true, self?: GeoFeature): string {
  const q = (n: string) => (quoted ? `「${n}」` : n);
  switch (kind) {
    case 'sea':
      return '入海';
    case 'lake': {
      const n = cell >= 0 ? lakeNameAt(w, cell) : null;
      return n ? `流进${q(n)}` : '流进湖里';
    }
    case 'river': {
      const n = cell >= 0 ? riverNameAt(w, cell, self) : null;
      return n ? `汇入${q(n)}` : '汇入一条河';
    }
    case 'edge':
      return '流出地图';
    case 'sink':
      // 说的是整条河（悬停在终点那一格上时另说“在这里消失”，见 riverLabel）
      return '最后在终点消失';
    default:
      return '水流不出去';
  }
}

// 高度写成好读的数：一千米以上取整到百米，以下取整到 50 米
const meters = (m: number) => `约 ${(Math.max(50, Math.round(m / (m >= 1000 ? 100 : 50)) * (m >= 1000 ? 100 : 50))).toLocaleString()} m`;

// ---------- 认河：鼠标下是哪条河 ----------

// 画的河画出来的线（guideLine），按世界缓存
const lineCache = new WeakMap<World, Map<Guide, GuideLine>>();
export function lineOf(w: World, g: Guide): GuideLine {
  let m = lineCache.get(w);
  if (!m) lineCache.set(w, (m = new Map()));
  let l = m.get(g);
  if (!l) m.set(g, (l = guideLine(w, g)));
  return l;
}

// 还没执行的河道（预览里执行后的样子）画出来的线：跟着那个河道对象，用完就丢
const tempLines = new WeakMap<Guide, GuideLine>();
function tempLine(w: World, g: Guide): GuideLine {
  let l = tempLines.get(g);
  if (!l) tempLines.set(g, (l = guideLine(w, g)));
  return l;
}

// 自然的河的线的外框（先粗筛，鼠标移动时不必每条都投影）
const boxes = new WeakMap<RiverLine, [number, number, number, number]>();
function boxOf(line: RiverLine): [number, number, number, number] {
  let b = boxes.get(line);
  if (!b) {
    b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of line.points) {
      b[0] = Math.min(b[0], x);
      b[1] = Math.min(b[1], y);
      b[2] = Math.max(b[2], x);
      b[3] = Math.max(b[3], y);
    }
    boxes.set(line, b);
  }
  return b;
}

export interface RiverHit {
  ref: RiverRef;
  // 离线多远（地图单位）
  d: number;
}

// 鼠标附近的河：画的河优先（照画出来的线认），再找自然的河（地图上画出来的线，线上每一点都知道在哪一格）。
// 线都离得远时，鼠标下那一格是河也算（放得很大时宽宽的大河）
export function riverAt(w: World, x: number, y: number, tol: number, cell = -1): RiverHit | null {
  const sphere = w.mesh.kind === 'sphere';
  let best: RiverHit | null = null;
  for (const g of w.small.guides) {
    const L = lineOf(w, g);
    const h = snapOnto(L.points, x, y, 0, L.points.length - 1, sphere);
    if (h && h.d <= tol && (!best || h.d < best.d)) best = { ref: { kind: 'guide', id: g.id }, d: h.d };
  }
  if (best) return best;
  for (const line of riverLines(w)) {
    if (line.guide !== undefined || !line.cells || line.points.length < 2) continue;
    const b = boxOf(line);
    if (y < b[1] - tol || y > b[3] + tol || (!sphere && (x < b[0] - tol || x > b[2] + tol))) continue;
    const h = snapOnto(line.points, x, y, 0, line.points.length - 1, sphere);
    if (!h || h.d > tol || (best && h.d >= best.d)) continue;
    // 投影点离线段哪一头近，就是哪一格；那一格不是河（入海的那一点）时取另一头。
    // 整个星球：鼠标可能在平铺的另一份上（投影点跟着挪了整圈），挪回线所在的那一份再比
    const [ax, ay] = line.points[h.k];
    const [bx, by] = line.points[h.k + 1];
    const px = sphere ? h.p[0] - 2 * Math.round((h.p[0] - ax) / 2) : h.p[0];
    const near = Math.hypot(px - ax, h.p[1] - ay) <= Math.hypot(px - bx, h.p[1] - by);
    let c = line.cells[near ? h.k : h.k + 1];
    if (!isRiverCell(w, w.derived, c)) c = line.cells[near ? h.k + 1 : h.k];
    // 线的最后一格是它汇入的那条河的（汇合处）：点在这一小段上算这条河自己的（不然选中的是那条大河）
    const tail = line.cells[line.cells.length - 1];
    for (let j = line.cells.length - 2; c === tail && j >= 0; j--) if (line.cells[j] !== tail) c = line.cells[j];
    if (isRiverCell(w, w.derived, c)) best = { ref: { kind: 'natural', cell: c }, d: h.d };
  }
  if (best || cell < 0 || !isRiverCell(w, w.derived, cell)) return best;
  const g = guideAt(w, cell);
  return { ref: g ? { kind: 'guide', id: g.id } : { kind: 'natural', cell }, d: tol };
}

// 这一格在哪条画的河上（它汇入的地方不算，在终点消失的河的终点算）；后画的优先
export function guideAt(w: World, cell: number): Guide | undefined {
  for (let n = w.small.guides.length - 1; n >= 0; n--) {
    const g = w.small.guides[n];
    const k = g.cells.indexOf(cell);
    if (k >= 0 && ownsCell(g, k)) return g;
  }
  return undefined;
}

// 一条折线按段的起点挪进 [0, 2)（整个星球）：挪的份数变了就另起一条，平铺的副本才画得全
export function wrappedLines(w: World, pts: readonly [number, number][]): [number, number][][] {
  if (w.mesh.kind !== 'sphere') return pts.length > 1 ? [pts.slice()] : [];
  const out: [number, number][][] = [];
  let cur = Number.NaN;
  let line: [number, number][] = [];
  for (let k = 0; k + 1 < pts.length; k++) {
    const shift = 2 * Math.floor(pts[k][0] / 2);
    if (shift !== cur) {
      line = [[pts[k][0] - shift, pts[k][1]]];
      out.push(line);
      cur = shift;
    }
    line.push([pts[k + 1][0] - cur, pts[k + 1][1]]);
  }
  return out;
}

const lineShapes = (w: World, pts: readonly [number, number][], style: Omit<Shape, 'kind' | 'points'>): Shape[] =>
  wrappedLines(w, pts).map((points): Shape => ({ kind: 'line', points, ...style }));

// 自然的河的主干（选中、悬停、固定时用），按世界、格缓存
const stemCache = new WeakMap<World, Map<number, ReturnType<typeof riverStem>>>();
export function stemOf(w: World, cell: number) {
  let m = stemCache.get(w);
  if (!m) stemCache.set(w, (m = new Map()));
  let s = m.get(cell);
  if (!s) m.set(cell, (s = riverStem(w, w.derived, cell)));
  return s;
}

// 选中、悬停的河沿河亮一道光：画的河照它画出来的线，自然的河照地图上画出来的线里属于它主干的那几段
const glowCache = new WeakMap<World, Map<string, Shape[]>>();
export function riverGlow(w: World, ref: RiverRef): Shape[] {
  // 自然的河按主干认：沿着同一条河移动鼠标不必重算
  const stem = ref.kind === 'natural' ? stemOf(w, ref.cell).cells : null;
  const key = ref.kind === 'guide' ? `g:${ref.id}` : `n:${stem![0]}:${stem![stem!.length - 1]}`;
  let m = glowCache.get(w);
  if (!m) glowCache.set(w, (m = new Map()));
  let out = m.get(key);
  if (out) return out;
  const style = { color: GLOW, width: 9 };
  if (ref.kind === 'guide') {
    const g = guideOf(w, ref.id);
    out = g ? lineShapes(w, guideShape(w, g), style) : [];
  } else {
    const on = new Set(stem);
    // 汇入别的河的那一格是那条河的：只亮这条河自己流到那里的一段，不亮到那条河上
    const join = stemOf(w, ref.cell).end === 'river' ? stem![stem!.length - 1] : -1;
    out = [];
    for (const line of riverLines(w)) {
      if (line.guide !== undefined || !line.cells) continue;
      let run: [number, number][] = [];
      line.points.forEach((p, k) => {
        const c = line.cells![k];
        if (on.has(c) && (c !== join || run.length)) run.push(p);
        else {
          if (run.length > 1) out!.push(...lineShapes(w, run, style));
          run = [];
        }
      });
      if (run.length > 1) out.push(...lineShapes(w, run, style));
    }
  }
  m.set(key, out);
  return out;
}

// ---------- 一条河的说明（悬停的一句话、底部条、河流列表） ----------

export interface RiverInfo {
  // 地名；没有时为 null
  name: string | null;
  feature: GeoFeature | null;
  // 小河 / 中等的河 / 大河（“河流多少”门槛的几倍）与流量（m³/s）
  size: string;
  flow: number;
  km: number;
  dest: string;
  warnings: string[];
  // 河上的格（画的河是河道，自然的河是主干）
  cells: number[];
  // 在终点消失（终点是 cells 的最后一格）
  sink: boolean;
}

const infoCache = new WeakMap<World, Map<string, RiverInfo | null>>();
export function riverInfo(w: World, ref: RiverRef): RiverInfo | null {
  const key = ref.kind === 'guide' ? `g:${ref.id}` : `n:${ref.cell}`;
  let m = infoCache.get(w);
  if (!m) infoCache.set(w, (m = new Map()));
  if (m.has(key)) return m.get(key)!;
  const d = w.derived;
  const thr = w.small.planet.riverThreshold;
  let info: RiverInfo | null = null;
  if (ref.kind === 'guide') {
    const g = guideOf(w, ref.id);
    if (g) {
      const f = guideFeature(w, g.id) ?? null;
      const total = guideFlow(w, d, g).total;
      const end = guideEnd(w, d, g);
      info = {
        // 没有自己地名的画的河：写它所在的那条自然大河的名字
        name: guideName(w, g),
        feature: f,
        size: riverSizeName(total),
        flow: total * thr,
        km: pathKm(w, lineOf(w, g).points),
        dest: destText(w, end.kind, end.cell, true, f ?? undefined),
        warnings: guideWarnings(w, d, g),
        cells: g.cells,
        sink: end.kind === 'sink',
      };
    }
  } else if (isRiverCell(w, d, ref.cell)) {
    const stem = stemOf(w, ref.cell);
    const f = naturalFeatureAt(w, ref.cell) ?? null;
    // 大小按汇入别的河之前的那一格（汇合的那格是那条更大的河的）
    const own = stem.end === 'river' ? stem.cells.slice(0, -1) : stem.cells;
    let q = 0;
    for (const c of own) if (isRiverCell(w, d, c)) q = Math.max(q, d.discharge[c]);
    const last = stem.cells[stem.cells.length - 1];
    info = {
      name: f?.name || null,
      feature: f,
      size: riverSizeName(q / thr),
      flow: q,
      km: pathKm(w, centrePoints(w, stem.cells)),
      dest: destText(w, stem.end, stem.end === 'river' ? stem.join : stem.end === 'lake' ? last : -1, true, f ?? undefined),
      warnings: [],
      cells: stem.cells,
      sink: stem.end === 'sink',
    };
  }
  m.set(key, info);
  return info;
}

// 悬停时的一句话：“赤江 · 中等的河 · 汇入「青河」”。cell：鼠标下那一格（在终点消失的河，停在终点上时说“在这里消失”）
export const riverLabel = (ref: RiverRef, info: RiverInfo, cell = -1) =>
  `${info.name ?? (ref.kind === 'guide' ? '画的河' : '一条河')} · ${info.size} · ${info.sink && cell >= 0 && cell === info.cells[info.cells.length - 1] ? '在这里消失' : info.dest}`;

// ---------- 命令 ----------

// 改一条河道（与 update_guide 相同：null 删掉这一项）
export function applyPatch(g: Guide, patch: GuidePatch): Guide {
  const out: Record<string, unknown> = { ...g, ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === null) delete out[k];
  return out as Guide;
}

// 新河从一条自然的河上开始（改道）时沿用那条河的名字：有地名的沿用它的地名键（名字、标注颜色都不变），
// 没有时按文字包自动起名
export function inheritedName(w: World, start: number): { name: string } | { nameKey: string } {
  const f = naturalFeatureAt(w, start);
  return f ? { nameKey: f.key } : { name: '' };
}

// 从一条画过的河（或固定下来的河）的源头改道就是重画它：改的是同一条河道（update_guide），
// 名字（自动起的也一样，键是河道 id）、大小、粗细、类型都照旧。不是从哪条河道的源头开始时为 undefined
export const sourceGuide = (w: World, start: number) => w.small.guides.find((g) => g.cells[0] === start);

// 重画时补上的名字：没有名字的画的河与新画的河一样沿用那条自然河的地名键或自动起名
const namingFor = (w: World, g: Guide, start: number): GuidePatch => (g.name !== undefined || g.nameKey !== undefined ? {} : inheritedName(w, start));

// 画的河现在叫什么（没名字时为 null）
export const guideName = (w: World, g: Guide) => guideFeature(w, g.id)?.name || riverNameAt(w, g.cells[Math.floor(g.cells.length / 2)]) || null;

// 一路加进来的水（门槛的倍数）在河道上每格的估计：源头有泉水 1.2 倍，其余沿路平均加进来（与水文相同）
function springProfile(w: World, cells: readonly number[], spring: boolean, flow: number | undefined): number[] {
  if (!spring) return cells.map(() => 0);
  const thr = w.small.planet.riverThreshold;
  const extra = Math.max(0, (flow ?? 1.2) - 1.2) * thr;
  const body = Math.max(1, cells.slice(0, -1).filter((c) => !water(w, c)).length);
  return cells.map((_, k) => 1.2 * thr + (extra * Math.min(k + 1, body)) / body);
}

// 新画的河选的河流类型（画河工具条上选的；那种类型已经删掉了时为普通的河）
export function chosenRiverType(w: World): { type: string } | Record<string, never> {
  const id = options.value.riverType;
  return id && (id === PLAIN_RIVER ? w.small.riverTypes?.some((t) => !!t.scripts?.match) : w.small.riverTypes?.some((t) => t.id === id)) ? { type: id } : {};
}

// 一条河道画出来按哪一种河流类型（预览照这种河画）
export const riverTypeOfGuide = (w: World, g: Pick<Guide, 'type'> | null | undefined) => (g?.type ? w.small.riverTypes?.find((t) => t.id === g.type) : undefined);

// 一笔画出来的河：规划、松手后执行的命令（确切预览用的也是它）、执行后这条河的样子与估计的流量
export interface Course {
  // new：新画的河、改道（从自然的河的源头）、从源头重画；splice：重画一段；merge：接到一条画的河的源头前面；
  // extend：从一条画的河的终点往下游接长；reroute：从一条河中间改道（还是这一条河，见 rerouteOf）
  kind: 'new' | 'splice' | 'merge' | 'extend' | 'reroute';
  plan: CoursePlan | null;
  blocked: string | null;
  cmd: Command | null;
  // 命令的 JSON：确切预览的键
  key: string;
  // 执行后这条河道的样子（画预览用）；画不出来时为 null
  after: Guide | null;
  // after.cells 每格估计的流量
  estimate: number[];
  // 重画、接上的那条河现在的名字
  name: string | null;
  // 画的线（画不出来时照它画一道红虚线）
  raw: [number, number][];
}

const blocked = (text: string, raw: [number, number][], plan: CoursePlan | null = null): Course => ({ kind: 'new', plan, blocked: text, cmd: null, key: '', after: null, estimate: [], name: null, raw });

const quoted = (name: string | null, fallback: string) => (name ? `「${name}」` : fallback);

// 新画的一条河（或接到一条画的河的源头前面）
export function newCourse(w: World, plan: CoursePlan, raw: [number, number][]): Course {
  if (plan.blocked || plan.cells.length < 2) return blocked(plan.blocked ?? '这里画不出河', raw, plan);
  const capture = plan.crossings.some((x) => x.guide !== null);
  const len = km(pathKm(w, plan.path));
  const merged = plan.merge && !plan.reroute ? guideOf(w, plan.merge) : undefined;
  if (merged) {
    // 汇进一条画的、有泉水的河的源头：成为它的上游，名字、大小照旧
    const patch = mergeCourse(plan, merged);
    const after = applyPatch(merged, patch);
    const name = guideName(w, merged);
    const cmd: Command = { op: 'update_guide', id: merged.id, patch, ...(capture ? { capture: true } : {}), label: `接上了${quoted(name, '一条画的河')}（约 ${len} km）` };
    // 新画的那段：本来的水加上源头的泉水；接上的那段照旧（已经含着它的水）
    const head = plan.cells.length - 1;
    const prof = springProfile(w, after.cells, true, merged.flow);
    let q = 0;
    const estimate = after.cells.map((c, k) => (q = Math.max(q, w.derived.discharge[c] + (k < head ? prof[k] : 0))));
    return { kind: 'merge', plan, blocked: null, cmd, key: JSON.stringify(cmd), after, estimate, name, raw };
  }
  const where = destOf(w, plan);
  const d = w.derived;
  // 改道的河带着起点原来的水
  const rerouted = () => plan.cells.map((c) => Math.max(d.discharge[plan.cells[0]], d.discharge[c]));
  const src = plan.reroute ? sourceGuide(w, plan.cells[0]) : undefined;
  if (src) {
    const patch: GuidePatch = { cells: plan.cells, path: encodePath(plan.path), ...namingFor(w, src, plan.cells[0]) };
    if (plan.end === 'sink') patch.end = 'sink';
    else if (src.end) patch.end = null;
    const name = guideName(w, src);
    const cmd: Command = { op: 'update_guide', id: src.id, patch, ...(capture ? { capture: true } : {}), label: `重画了${quoted(name, '一条画的河')}（约 ${len} km，${where}）` };
    return { kind: 'new', plan, blocked: null, cmd, key: JSON.stringify(cmd), after: applyPatch(src, patch), estimate: rerouted(), name, raw };
  }
  const guide = {
    cells: plan.cells,
    path: encodePath(plan.path),
    locked: true,
    spring: !plan.reroute,
    ...(plan.reroute ? {} : { flow: options.value.riverFlow }),
    ...(plan.reroute ? inheritedName(w, plan.cells[0]) : { name: '' }),
    ...(plan.end === 'sink' ? { end: 'sink' as const } : {}),
    ...chosenRiverType(w),
  };
  const cmd: Command = {
    op: 'add_guide',
    guide,
    ...(plan.reroute ? { reroute: true } : {}),
    ...(capture ? { capture: true } : {}),
    label: `${plan.reroute ? '让河改道' : '画了一条河'}（约 ${len} km，${where}）`,
  };
  const after = { id: '', ...guide } as Guide;
  const estimate = plan.reroute ? rerouted() : springProfile(w, plan.cells, true, options.value.riverFlow).map((q, k) => d.discharge[plan.cells[k]] + q);
  return { kind: 'new', plan, blocked: null, cmd, key: JSON.stringify(cmd), after, estimate, name: null, raw };
}

// 重画一条画的河的一段，或从它的终点往下游接长（extend）：名字、大小照旧
export function spliceOf(w: World, g: Guide, patch: GuidePatch, plan: CoursePlan, raw: [number, number][], kind: 'splice' | 'extend' = 'splice'): Course {
  const capture = plan.crossings.some((x) => x.guide !== null);
  const name = guideName(w, g);
  const label =
    kind === 'extend'
      ? `${quoted(name, '一条画的河')}往下游接长了（约 ${km(pathKm(w, raw))} km，${patch.end === 'sink' ? '到这里消失' : destOf(w, plan)}）`
      : `重画了${quoted(name, '一条河')}的一段（约 ${km(pathKm(w, raw))} km）`;
  const cmd: Command = { op: 'update_guide', id: g.id, patch, ...(capture ? { capture: true } : {}), label };
  const after = applyPatch(g, patch);
  // 原来河道上的格照旧（已经含着这条河的水）；新画的格带着上游流下来的水（沿河往下只增不减）
  const pos = new Set(g.cells);
  let q = 0;
  const estimate = after.cells.map((c) => (q = pos.has(c) ? w.derived.discharge[c] : Math.max(q, w.derived.discharge[c])));
  return { kind, plan, blocked: null, cmd, key: JSON.stringify(cmd), after, estimate, name, raw };
}

// 从一条河中间改道（core/select.ts 的 rerouteCourse）：还是这一条河。画的河改这条河道（名字、id、大小、类型都照旧）；
// 自然的河固定成一条画的河（主干从源头到起笔的那一格，再接上新画的一段），沿用它的地名（像“固定这条河”）
export function rerouteOf(w: World, g: Guide | null, plan: CoursePlan, raw: [number, number][]): Course {
  if (plan.blocked || plan.cells.length < 2) return blocked(plan.blocked ?? '这里画不出河', raw, plan);
  const capture = plan.crossings.some((x) => x.guide !== null);
  const label = (name: string | null, fallback: string) => `${quoted(name, fallback)}从这里改道（约 ${km(pathKm(w, raw))} km，${destOf(w, plan)}）`;
  // 起笔以上照旧，往下带着起笔那一格的水（沿河往下只增不减）
  let q = 0;
  const estimate = plan.cells.map((c) => (q = Math.max(q, w.derived.discharge[c])));
  const patch: GuidePatch = { cells: plan.cells, path: encodePath(plan.path) };
  if (plan.end === 'sink') patch.end = 'sink';
  else if (g?.end) patch.end = null;
  if (g) {
    const name = guideName(w, g);
    const cmd: Command = { op: 'update_guide', id: g.id, patch, ...(capture ? { capture: true } : {}), label: label(name, '一条画的河') };
    return { kind: 'reroute', plan, blocked: null, cmd, key: JSON.stringify(cmd), after: applyPatch(g, patch), estimate, name, raw };
  }
  const f = naturalFeatureAt(w, plan.cells[plan.rerouteAt]) ?? null;
  const guide = {
    cells: plan.cells,
    path: patch.path!,
    locked: true,
    spring: false,
    ...(f ? { nameKey: f.key } : { name: '' }),
    ...(plan.end === 'sink' ? { end: 'sink' as const } : {}),
  };
  const cmd: Command = { op: 'add_guide', guide, ...(capture ? { capture: true } : {}), label: label(f?.name || null, '一条河') };
  return { kind: 'reroute', plan, blocked: null, cmd, key: JSON.stringify(cmd), after: { id: '', ...guide } as Guide, estimate, name: f?.name || null, raw };
}

// 画好以后顶部说的话：画的时候汇入的那条河还没有名字（常常是新河的水加进去它才够大、才起了名字）时说的是“汇入一条河”，
// 换成改好的世界里河流列表说的（汇入「黄青河」）。不用换时为 null
export function namedDest(after: World, cmd: Command, known: ReadonlySet<string>, said: string): string | null {
  if (!said.includes('汇入一条河')) return null;
  const id = cmd.op === 'update_guide' ? cmd.id : cmd.op === 'add_guide' ? after.small.guides.find((g) => !known.has(g.id))?.id : undefined;
  const info = id ? riverInfo(after, { kind: 'guide', id }) : null;
  return info?.dest.startsWith('汇入「') ? said.replace('汇入一条河', info.dest) : null;
}

// 终点怎么说（新画的河）：画到陆地上接着流的是“之后顺地势入海”
function destOf(w: World, plan: CoursePlan, quotedName = true): string {
  const last = plan.cells.length - 1;
  if (plan.end === 'sink') return '到这里消失';
  const where = destText(w, plan.end, plan.end === 'river' ? plan.join : plan.cells[last], quotedName);
  return plan.drawn < last ? `之后顺地势${where}` : where;
}

// 穿过的别的河（改道、重画的这条河自己不算）
function otherCrossings(c: Course): CoursePlan['crossings'] {
  const self = c.cmd?.op === 'update_guide' ? c.cmd.id : null;
  return (c.plan?.crossings ?? []).filter((x) => !self || x.guide !== self);
}

// 截走的画的河会不会整条去掉（与 commands.ts 的 captureBy 相同：碰到的是它的源头）
function captureDeletes(w: World, after: Guide, id: string): boolean {
  const g = guideOf(w, id);
  if (!g) return false;
  const inner = new Set(after.cells.slice(1, -1).filter((c) => w.causes.land[c]));
  return g.cells.findIndex((c, i) => ownsCell(g, i) && inner.has(c)) === 0;
}

// 穿过的那条河叫什么
function crossingName(w: World, x: CoursePlan['crossings'][number]): string | null {
  if (x.guide) {
    const g = guideOf(w, x.guide);
    if (g) return guideName(w, g);
  }
  return riverNameAt(w, x.cell);
}

// “会截走「赤江」”“会删掉「白水」”（穿过不止一条时“等 3 条河”；第一条没有名字时“会截走 3 条河”）
export function captureText(w: World, c: Course): string {
  const xs = otherCrossings(c);
  if (!xs.length || !c.after) return '';
  const x = xs[0];
  const name = crossingName(w, x);
  const verb = x.guide && captureDeletes(w, c.after, x.guide) ? '会删掉' : '会截走';
  if (xs.length > 1) return name ? `${verb}「${name}」等 ${xs.length} 条河` : `${verb} ${xs.length} 条河`;
  return `${verb}${quoted(name, verb === '会删掉' ? '一条画的河' : '一条河')}`;
}

// 确切结果里不再是河的格分成三份：改道的那条河原来的下游、截走的河的下游，其余的是旁边的小河（集水区被新河抢走，
// 水并进新河，它们汇进原来那条河之前的一段变干）。这条河自己的格、重画、接长的这条河原来的河道不算
interface Dried {
  reroute: number[];
  capture: number[];
  side: number[];
}
function driedParts(w: World, c: Course, x: PreviewResult): Dried {
  const d = w.derived;
  const own = new Set(c.after?.cells ?? []);
  const plan = c.plan;
  // 从一格顺着现在的流向往下（到海、湖为止）
  const below = (from: number, out: Set<number>) => {
    for (let i = d.receiver[from], guard = 0; i >= 0 && !water(w, i) && guard < w.mesh.n; i = d.receiver[i], guard++) out.add(i);
  };
  const rer = new Set<number>();
  if (plan?.reroute && plan.cells.length) below(plan.cells[plan.rerouteAt], rer);
  const cap = new Set<number>();
  for (const k of plan?.crossings ?? []) for (let j = k.from; j <= k.to; j++) below(plan!.cells[j], cap);
  // 重画、接长的这条河原来的河道（和它原来的终点往下）
  const old = new Set<number>();
  const g = c.cmd?.op === 'update_guide' ? guideOf(w, c.cmd.id) : undefined;
  if (g) {
    for (const i of g.cells) old.add(i);
    below(g.cells[g.cells.length - 1], old);
  }
  const out: Dried = { reroute: [], capture: [], side: [] };
  for (const i of x.riverRemoved) {
    if (own.has(i)) continue;
    if (rer.has(i) || old.has(i)) out.reroute.push(i);
    else if (cap.has(i)) out.capture.push(i);
    else out.side.push(i);
  }
  return out;
}

const cellsKm = (w: World, n: number) => km(n * w.mesh.spacing * w.kmPerUnit);

// 截走后下游变干多长（km）：有确切结果时按它，否则按估计
function driedKm(w: World, c: Course, x: PreviewResult | null): number {
  if (x && c.after) return cellsKm(w, driedParts(w, c, x).capture.length);
  return cellsKm(w, new Set((c.plan?.crossings ?? []).flatMap((k) => k.dried)).size);
}

// 旁边的小河并进来：“旁边的小河会并进来（3 格）”；没有确切结果、没有这样的格时为 null
export function sideText(w: World, c: Course, x: PreviewResult | null): string | null {
  if (!x || !c.after) return null;
  const n = driedParts(w, c, x).side.length;
  return n ? `旁边的小河会并进来（${n} 格）` : null;
}

// 起笔在一条河上（不是从画的河的终点接长）：松手后要先确认。
// 在它中间：“从这里改道：「赤江」下游约 300 km 会变干” + 改道；在一条画的河的源头：重画整条「赤江」
export interface StartNote {
  text: string;
  label: string;
}
export function startNote(w: World, c: Course, x: PreviewResult | null): StartNote | null {
  const plan = c.plan;
  if ((c.kind !== 'new' && c.kind !== 'reroute') || !plan?.reroute || !plan.cells.length) return null;
  const start = plan.cells[plan.rerouteAt];
  const src = c.kind === 'new' ? sourceGuide(w, start) : undefined;
  if (src) {
    const name = quoted(guideName(w, src), '这条画的河');
    return { text: `从源头起笔：${name}原来的河道不要了，照新画的走`, label: `重画整条${name}` };
  }
  const name = quoted(c.kind === 'reroute' ? c.name : startRiverName(w, start), '这条河');
  const n = x && c.after ? driedParts(w, c, x).reroute.length : plan.dried.length;
  return { text: n ? `从这里改道：${name}下游约 ${cellsKm(w, n).toLocaleString()} km 会变干` : `从这里改道：${name}从这里起照新画的走`, label: '改道' };
}

// 这一格上的河叫什么（画的河优先）
function startRiverName(w: World, cell: number): string | null {
  const g = guideAt(w, cell);
  return (g && guideName(w, g)) || riverNameAt(w, cell);
}

// 自定义走向起笔的那一点：鼠标在一条河上（悬停时写着它的名字）、脚下那一格却不是这条河的格时（在画出来的线的拐点上、
// 源头外一两格），挪到这条河上离它最近的那一格的格心。悬停时说会怎样、按下去以后怎么画，用的都是这一点（startHint 跟着它说）
export function courseStart(w: World, x: number, y: number, cell: number, tol: number): { x: number; y: number; cell: number } {
  const here = { x, y, cell };
  if (cell < 0 || water(w, cell) || isRiverCell(w, w.derived, cell) || extendPoint(w, cell)) return here;
  const hit = riverAt(w, x, y, tol, cell);
  if (!hit) return here;
  let c = -1;
  if (hit.ref.kind === 'natural') c = hit.ref.cell;
  else {
    const g = guideOf(w, hit.ref.id);
    if (!g) return here;
    const L = lineOf(w, g);
    const h = snapOnto(L.points, x, y, 0, L.points.length - 1, w.mesh.kind === 'sphere');
    if (!h) return here;
    const [ax, ay] = L.points[h.k];
    const [bx, by] = L.points[h.k + 1] ?? L.points[h.k];
    const px = w.mesh.kind === 'sphere' ? h.p[0] - 2 * Math.round((h.p[0] - ax) / 2) : h.p[0];
    let i = L.cellIdx[Math.hypot(px - ax, h.p[1] - ay) <= Math.hypot(px - bx, h.p[1] - by) ? h.k : Math.min(h.k + 1, L.cellIdx.length - 1)];
    // 它汇入的那一格是别的河的：退回它自己的最后一格
    if (!ownsCell(g, i)) i--;
    c = i >= 0 ? g.cells[i] : -1;
  }
  if (c < 0 || water(w, c)) return here;
  const cx = w.mesh.x[c] + (w.mesh.kind === 'sphere' ? 2 * Math.round((x - w.mesh.x[c]) / 2) : 0);
  return { x: cx, y: w.mesh.y[c], cell: c };
}

// 鼠标停在一条河上（自定义走向）：从这里起笔会怎样（接在“赤江 · 中等的河 · 入海”后面）。warn：要先确认的
export function startHint(w: World, cell: number): { text: string; warn: boolean } | null {
  if (extendPoint(w, cell)) return { text: '从这里起笔：往下游接着画这条河', warn: false };
  if (cell < 0 || !isRiverCell(w, w.derived, cell)) return null;
  if (sourceGuide(w, cell)) return { text: '从这里起笔：重画整条河（松手后确认）', warn: true };
  return { text: '从这里起笔：改道，下游会变干（松手后确认）', warn: true };
}

// 等着确认时底部条上的话：“从这里改道：「赤江」下游约 300 km 会变干 · 会截走「白水」（下游约 80 km 变干） · 旁边的小河会并进来（3 格）”
export function pendingText(w: World, c: Course, x: PreviewResult | null): string {
  const parts: string[] = [];
  const st = startNote(w, c, x);
  if (st) parts.push(st.text);
  if (otherCrossings(c).length) {
    const dried = driedKm(w, c, x);
    parts.push(`${captureText(w, c)}${dried ? `（下游约 ${dried.toLocaleString()} km 变干）` : ''}`);
  }
  const side = sideText(w, c, x);
  if (side) parts.push(side);
  return parts.join(' · ');
}

// 顺地势从一条河中间改道（planRiver 的 reroute，起点不是画的河的源头）：还是这一条河。
// 画的河：改这条河道（update_guide；id、名字、大小、类型照旧），起点以上的格（和画的折线）不动，之后照新拖的路线走；
// 自然的河：主干从源头到起点再接上新的路线，固定成一条画的河，沿用它的地名（像“固定这条河”）。
// 新路线汇回这条河自己往下的那段时，后面照它原来的河道接上（不然又断成两条）。
// 起点在自然的河的源头、找不到这条河时为 null（照旧另起一条改道的河）
export function flowReroute(w: World, p: RiverPlan, lenKm: number): Command | null {
  const start = p.cells[0];
  let g: Guide | undefined;
  let k = -1;
  for (let n = w.small.guides.length - 1; n >= 0 && !g; n--) {
    const x = w.small.guides[n];
    const i = x.cells.indexOf(start);
    if (i >= 0 && ownsCell(x, i)) {
      g = x;
      k = i;
    }
  }
  let old: number[];
  let own: (j: number) => boolean;
  if (g) {
    if (k <= 0) return null;
    const G = g;
    old = G.cells;
    own = (j) => ownsCell(G, j);
  } else {
    const stem = stemOf(w, start);
    k = stem.cells.indexOf(start);
    if (k <= 0) return null;
    old = stem.cells;
    own = (j) => j < old.length - 1 || stem.end !== 'river';
  }
  const cells = [...old.slice(0, k), ...p.cells];
  let back = false;
  const j = p.end === 'river' ? old.indexOf(p.join) : -1;
  if (j > k && own(j)) {
    const rest = old.slice(j + 1);
    const seen = new Set(cells);
    if (!rest.some((c) => seen.has(c))) {
      cells.push(...rest);
      back = true;
    }
  }
  const where = back ? '，之后照原来的河道走' : p.end ? `，${destText(w, p.end, p.end === 'river' ? p.join : p.cells[p.cells.length - 1])}` : '';
  if (g) {
    const patch: GuidePatch = { cells };
    // 画的折线只留起点以前的那段（之后是顺地势的格）；折线没画到起点时照旧
    if (g.path) {
      const cut = cutPathAtCell(w.mesh, g.path, start);
      if (cut) patch.path = cut;
    }
    if (g.end) patch.end = null;
    return { op: 'update_guide', id: g.id, patch, label: `${quoted(guideName(w, g), '一条画的河')}从这里改道（约 ${lenKm} km${where}）` };
  }
  const f = naturalFeatureAt(w, start);
  const guide = { cells, locked: true, spring: false, ...(f ? { nameKey: f.key } : { name: '' }) };
  return { op: 'add_guide', guide, label: `${quoted(f?.name || null, '一条河')}从这里改道（约 ${lenKm} km${where}）` };
}

// ---------- 预览 ----------

// 执行后这条河画出来的样子：照画出来的线（guideLine），流量按格；入海、入湖画到进水的第一点为止；
// 在终点消失的最后一格收细到三成（与 traceRivers 的画法相同）
function courseRiver(w: World, line: GuideLine, g: Guide, flow: readonly number[]): { points: [number, number][]; flow: number[]; mul: number[] } {
  const { points, cellIdx } = line;
  const width = g.width ?? 1;
  const out = { points: [] as [number, number][], flow: [] as number[], mul: [] as number[] };
  for (let k = 0; k < points.length; k++) {
    const i = cellIdx[k];
    if (water(w, g.cells[i])) {
      if (i > 0 && out.points.length) {
        out.points.push(points[k]);
        out.flow.push(flow[i - 1]);
        out.mul.push(width);
      }
      break;
    }
    out.points.push(points[k]);
    out.flow.push(flow[i]);
    out.mul.push(width);
  }
  if (g.end === 'sink') {
    const len = w.mesh.spacing;
    let s = 0;
    for (let k = out.points.length - 1; k >= 0 && s < len; k--) {
      out.mul[k] = width * (0.3 + (0.7 * s) / len);
      if (k > 0) s += Math.hypot(out.points[k][0] - out.points[k - 1][0], out.points[k][1] - out.points[k - 1][1]);
    }
  }
  return out;
}

// 确切的预览：停下来一会儿（delay 毫秒）后在 worker 里执行这条命令，算好后换上。同一个世界上同一条命令只算一次
// （命令里没有世界：撤销了别的一步之后同一条命令要重新算，旧的结果不再用）
export class RiverExact {
  private wanted = '';
  // 要的这一条是照哪个世界算的
  private at: World | null = null;
  // 这一条已经发给 worker 了（还在等着的计时器不算）
  private sent = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private got: { key: string; at: World | null; r: PreviewResult } | null = null;
  // 算好一条（还是要的这一条）时再做的事
  onGot: ((key: string, r: PreviewResult) => void) | null = null;
  // delay 为 0：现在就算（同一条还在等计时器时也提前）
  want(key: string, cmd: Command, delay = 150) {
    const at = world.value;
    if (key === this.wanted && at === this.at && (this.sent || (this.timer && delay > 0))) return;
    this.wanted = key;
    this.at = at;
    this.sent = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const run = () => {
      this.timer = null;
      this.sent = true;
      void previewCommand(cmd).then((r) => {
        if (this.wanted !== key || this.at !== at) return;
        // 没算成（排队时被新的预览顶掉了）：下次再要时重新算
        if (!r) {
          this.sent = false;
          return;
        }
        this.got = { key, at, r };
        this.onGot?.(key, r);
        redrawTick.value++;
      });
    };
    if (delay <= 0) run();
    else this.timer = setTimeout(run, delay);
  }
  get(key: string): PreviewResult | null {
    return this.got?.key === key && this.got.at === world.value ? this.got.r : null;
  }
  // 松手执行了：还在等计时器的不必再算（执行时自己会算；已经发出去的照样算完，worker 直接采用）
  hold() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  reset() {
    this.hold();
    this.wanted = '';
    this.at = null;
    this.sent = false;
    this.got = null;
  }
}

// 确切结果里的变化：红色是不再是河的格，蓝色是别处新出现的河，褐色是挖出的河床，浅蓝是新出现的湖面
function exactLayers(x: PreviewResult, own: readonly number[]): HighlightLayer[] {
  const on = new Set(own);
  const layers: HighlightLayer[] = [
    { cells: x.riverRemoved, color: RED, alpha: 0.8 },
    { cells: x.riverAdded.filter((c) => !on.has(c)), color: BLUE, alpha: 0.7 },
  ];
  if (x.carved.cells.length) layers.push({ cells: x.carved.cells, color: CARVED, alpha: 0.5 });
  if (x.lakeAdded.length) layers.push({ cells: x.lakeAdded, color: [70, 140, 220], alpha: 0.6 });
  return layers;
}

// 圈画在哪里：整个星球上挪进 [0, 2)（画的线展开后可能伸出很远，平铺的副本只画 [0, 2) 附近的）
const ringAt = (w: World, x: number, y: number, r: number, width: number): Shape => ({
  kind: 'circle',
  x: w.mesh.kind === 'sphere' ? wrapX(x) : x,
  y,
  r,
  color: 'rgba(255, 255, 255, 0.95)',
  width,
});

// 一笔河的预览图形：执行后的河（宽度按流量，河口有箭头）、上面一道白色虚线（水模式里的标记）、
// 丢掉的那段灰色虚线、汇入处一个白圈、消失处一个小圈；还没有确切结果时，估计会变干的河段画红色虚线
function courseShapes(w: World, c: Course, x: PreviewResult | null, zoom: number, line: GuideLine): { shapes: Shape[]; layers: HighlightLayer[] } {
  const shapes: Shape[] = [];
  const layers: HighlightLayer[] = [];
  if (!c.after) {
    shapes.push(...lineShapes(w, c.raw, { color: RED_LINE, width: 2, dashed: true }));
    return { shapes, layers };
  }
  const plan = c.plan;
  if (x) layers.push(...exactLayers(x, c.after.cells));
  else if (plan) {
    const dried = [...plan.dried, ...plan.crossings.flatMap((k) => k.dried)];
    if (dried.length) layers.push({ cells: dried, color: RED, alpha: 0.6 });
    for (const k of plan.crossings) if (k.dried.length) shapes.push({ kind: 'cells', cells: [k.cell, ...k.dried], color: RED_LINE, width: 3, dashed: true });
    if (plan.dried.length) shapes.push({ kind: 'cells', cells: [plan.cells[plan.rerouteAt], ...plan.dried], color: RED_LINE, width: 3, dashed: true });
  }
  const flow = x?.guide && x.guide.flow.length === c.after.cells.length ? x.guide.flow : c.estimate;
  const r = courseRiver(w, line, c.after, flow);
  if (r.points.length > 1) shapes.push({ kind: 'river', points: r.points, flow: r.flow, mul: r.mul, arrow: c.after.end !== 'sink', riverType: riverTypeOfGuide(w, c.after) });
  shapes.push(...lineShapes(w, line.points, { color: WHITE_LINE, width: 1.2, dashed: true }));
  if (plan?.cut) shapes.push(...lineShapes(w, plan.cut, { color: 'rgba(205, 205, 205, 0.85)', width: 2, dashed: true }));
  const tail = line.points[line.points.length - 1];
  if (plan?.end === 'river' && plan.join >= 0 && tail) shapes.push(ringAt(w, w.mesh.x[plan.join], w.mesh.y[plan.join], 7 / zoom, 2));
  if (c.after.end === 'sink' && tail) shapes.push(ringAt(w, tail[0], tail[1], 4 / zoom, 1.5));
  return { shapes, layers };
}

// 画着的时候鼠标旁的一句话（先说画不了的原因，再说会截走别的河、往高处流，最后是名字、流到哪、多长、挖多深）
function courseHint(w: World, c: Course, x: PreviewResult | null, line: GuideLine, shift: boolean): { text: string; warn?: boolean } {
  if (c.blocked || !c.plan || !c.after) return { text: c.blocked ?? '这里画不出河', warn: true };
  const plan = c.plan;
  const side = sideText(w, c, x);
  const st = startNote(w, c, x);
  // 从一条河中间、源头起笔：松手后先确认（同时穿过别的河时一起说）
  if (st) return { text: [st.text, plan.crossings.length ? captureText(w, c) : '', side ?? '', '松手后确认'].filter(Boolean).join(' · '), warn: true };
  if (plan.crossings.length) return { text: shift ? captureText(w, c) : `${captureText(w, c)} · 松手后确认`, warn: true };
  if (plan.uphill >= 20) return { text: `这段河有一段往高处流（${meters(plan.uphill)}）`, warn: true };
  const name = x?.guide?.name || c.name || (plan.reroute ? '改道' : '新河');
  let text = `${name} · ${c.kind === 'new' ? destOf(w, plan) : riverEndText(w, c)} · ${km(pathKm(w, line.points)).toLocaleString()} km`;
  const gorge = x ? x.carved.maxDrop : plan.gorge;
  if (gorge >= 100) text += ` · 穿山挖出峡谷（最深${meters(gorge)}）`;
  if (x?.guide && !x.guide.followed) text += ' · 有一段没法按画的走';
  if (side) text += ` · ${side}`;
  return { text: x ? text : `${text}…` };
}

// 重画、接上之后这条河流到哪（接到一条画的河的源头上：那条河往上游接长了，不是“汇入”它）
function riverEndText(w: World, c: Course): string {
  const plan = c.plan!;
  if (c.kind === 'merge') return '往上游接长';
  const end = c.after?.end === 'sink' ? '到这里消失' : destOf(w, plan);
  return c.kind === 'extend' ? `往下游接长，${end}` : end;
}

// ---------- 底部条上改一条河时的预览（拖大小、悬停“从这里往下去掉”） ----------

export interface RiverBarPreview {
  key: string;
  cmd: Command;
  // 改完后的河道；估计的每格流量
  after: Guide;
  estimate: number[];
}
export const riverBarPreview = signal<RiverBarPreview | null>(null);
const barExact = new RiverExact();

// 先画估计的样子，停 delay 毫秒后换成确切的
export function previewRiverBar(cmd: Command, after: Guide, estimate: number[], delay = 150) {
  const key = JSON.stringify(cmd);
  if (riverBarPreview.value?.key !== key) {
    riverBarPreview.value = { key, cmd, after, estimate };
    redrawTick.value++;
  }
  // 同一条命令也再要一次：世界变了（别的一步算完了）时要重新算，没变时 RiverExact 自己不重复算
  barExact.want(key, cmd, delay);
}

export function clearRiverBarPreview() {
  if (!riverBarPreview.value) return;
  riverBarPreview.value = null;
  barExact.reset();
  redrawTick.value++;
}

// 松手执行了：还没发出去的确切预览不必再算（预览照旧画着，直到结果换上）
export const holdRiverBarPreview = () => barExact.hold();

// 拖“大小”时估计的每格流量：原来加进来的水换成新的
export function flowEstimate(w: World, g: Guide, spring: boolean, flow: number | undefined): number[] {
  const old = springProfile(w, g.cells, g.spring, g.flow);
  const add = springProfile(w, g.cells, spring, flow);
  return g.cells.map((c, k) => Math.max(0, w.derived.discharge[c] - old[k] + add[k]));
}

// 固定一条自然的河（downFrom：只固定到这一格为止，在这里消失，下游的水没了）：沿用它的地名键，名字、颜色不变
export function pinCommand(w: World, cell: number, downFrom = false): { cmd: Command; after: Guide; estimate: number[] } | null {
  const stem = stemOf(w, cell);
  const i = stem.cells.indexOf(cell);
  const cells = downFrom ? stem.cells.slice(0, i + 1) : stem.cells;
  if (cells.length < 2 || i < 0) return null;
  const f = naturalFeatureAt(w, cell);
  const guide = {
    cells,
    path: stemPath(w, cells),
    locked: true,
    spring: false,
    ...(f ? { nameKey: f.key } : { name: '' }),
    ...(downFrom ? { end: 'sink' as const } : {}),
  };
  const name = quoted(f?.name || null, '一条河');
  const label = downFrom
    ? `${name}从这里往下去掉了（约 ${km(pathKm(w, centrePoints(w, stem.cells.slice(i))))} km）`
    : `固定了${name}（约 ${km(pathKm(w, centrePoints(w, cells)))} km）`;
  return { cmd: { op: 'add_guide', guide, label }, after: { id: '', ...guide } as Guide, estimate: cells.map((c) => w.derived.discharge[c]) };
}

// 选中一条河（河流列表、地名栏里点的）：换到画河工具，底部条换成这条河的设置
export function selectRiver(ref: RiverRef) {
  if (tool.value !== 'river') {
    tool.value = 'river';
    cursorHint.value = null;
    measure.value = null;
  }
  selectedRiver.value = ref;
}

// 执行一条加河道的命令，成功后选中新加的那条
export async function execAndSelect(cmd: Command, label: string): Promise<boolean> {
  cancelPreviews();
  const before = new Set(world.value?.small.guides.map((g) => g.id) ?? []);
  const ok = await exec(cmd, label);
  const g = ok ? world.value?.small.guides.find((x) => !before.has(x.id)) : undefined;
  if (g) selectedRiver.value = { kind: 'guide', id: g.id };
  return ok;
}

function barPreviewShapes(w: World, b: RiverBarPreview, zoom: number): Preview {
  const x = barExact.get(b.key);
  const line = tempLine(w, b.after);
  const flow = x?.guide && x.guide.flow.length === b.after.cells.length ? x.guide.flow : b.estimate;
  const r = courseRiver(w, line, b.after, flow);
  const shapes: Shape[] = [];
  if (r.points.length > 1) shapes.push({ kind: 'river', points: r.points, flow: r.flow, mul: r.mul, riverType: riverTypeOfGuide(w, b.after) });
  if (b.after.end === 'sink' && r.points.length) {
    const [tx, ty] = r.points[r.points.length - 1];
    shapes.push(ringAt(w, tx, ty, 4 / zoom, 1.5));
  }
  return { layers: x ? exactLayers(x, b.after.cells) : [], shapes, hint: null };
}

// ---------- 画河工具 ----------

interface Press {
  // flow：顺地势拖出路线；course：自定义走向画一条新河；splice：在选中的画的河上重画一段
  kind: 'flow' | 'course' | 'splice';
  start: Pointer;
  // 画的线（地图单位；整个星球上连续展开）
  pts: [number, number][];
  // 上一个记下的点在屏幕上的位置
  last: [number, number];
  // 出了平面地图：不再记点
  out: boolean;
  // 顺地势拖过的格
  cells: number[];
  moved: boolean;
  guide: string | null;
  // 自定义走向从一条画的河的终点接长：预览时先不画的那条河
  hid?: string | null;
}

export function riverTool(zoom: () => number): ToolHandler {
  let pointer: Pointer | null = null;
  let press: Press | null = null;
  let committing: Course | RiverPlan | null = null;
  let flowCache: { key: string; plan: RiverPlan } | null = null;
  let courseCache: { key: string; course: Course; line: GuideLine | null } | null = null;
  const exact = new RiverExact();
  // 穿过了别的河、等着确认的那一笔；view：地图上显示截走的样子还是汇入的样子
  let pending: { course: Course; join: Course | null; view: 'capture' | 'join' } | null = null;
  // 顺地势从一条河上拖出去（改道、从画的河的源头重画）、等着确认的那一笔：拖过的格
  let flowPending: number[] | null = null;

  // ---- 顺地势（与以前相同，只是新河只挖河床、自动起名） ----
  const flowPlan = (w: World, cells: number[]): RiverPlan | null => {
    if (!cells.length) return null;
    const key = `${worldId(w)}|${cells.join(',')}`;
    if (flowCache?.key !== key) flowCache = { key, plan: planRiver(w, w.derived, cells) };
    return flowCache.plan;
  };
  const flowLen = (w: World, p: RiverPlan) => km(p.cells.length * w.mesh.spacing * w.kmPerUnit);
  // 松手后执行的命令（确切预览用的也是它）。从画过的河的源头改道等于重画它：同一条河道，泉水、大小、名字照旧
  // （顺地势找的路不是画的线：原来的折线不要了）
  const flowCommand = (w: World, p: RiverPlan): Command => {
    const where = p.end ? `，${destText(w, p.end, p.end === 'river' ? p.join : p.cells[p.cells.length - 1])}` : '';
    const src = p.reroute ? sourceGuide(w, p.cells[0]) : undefined;
    if (src) {
      const patch: GuidePatch = { cells: p.cells, ...namingFor(w, src, p.cells[0]) };
      if (src.path) patch.path = null;
      if (src.end) patch.end = null;
      return { op: 'update_guide', id: src.id, patch, label: `重画了${quoted(guideName(w, src), '一条画的河')}（约 ${flowLen(w, p)} km${where}）` };
    }
    // 从一条河中间改道：还是这一条河（与自定义走向一样，见 flowReroute）
    const mid = p.reroute ? flowReroute(w, p, flowLen(w, p)) : null;
    if (mid) return mid;
    const guide = p.reroute
      ? { cells: p.cells, locked: true, spring: false, ...inheritedName(w, p.cells[0]), ...chosenRiverType(w) }
      : { cells: p.cells, locked: true, spring: true, flow: options.value.riverFlow, name: '', ...chosenRiverType(w) };
    const label = `${p.reroute ? '让河改道' : '画了一条河'}（约 ${flowLen(w, p)} km${where}）`;
    return { op: 'add_guide', guide, ...(p.reroute ? { reroute: true } : {}), label };
  };
  // 估计的流量（松手后的样子）：改道的河带着原来那条河的水；新画的河源头有泉水，选的大小沿路平均加进来
  const flowOf = (w: World, p: RiverPlan): number[] => {
    const d = w.derived;
    if (p.reroute) return p.cells.map((c) => Math.max(d.discharge[p.cells[0]], d.discharge[c]));
    return springProfile(w, p.cells, true, options.value.riverFlow).map((q, k) => d.discharge[p.cells[k]] + q);
  };
  const flowShapes = (w: World, p: RiverPlan, estimate: boolean): Shape[] => {
    const { mesh } = w;
    const color = p.blocked ? RED_LINE : p.same ? 'rgba(210, 210, 210, 0.85)' : undefined;
    const shapes: Shape[] = [];
    if (estimate && p.dried.length) shapes.push({ kind: 'cells', cells: [p.cells[0], ...p.dried], color: RED_LINE, width: 3, dashed: true });
    if (p.cells.length > 1) {
      // 与松手后地图上的河同样画（格心加曲流再平滑，宽度按流量），上面是水模式里那条白色虚线
      const pts = centrePoints(w, p.cells);
      const q = flowOf(w, p);
      const line = smoothCourse(
        pts,
        pts.map((_, k) => q[!water(w, p.cells[k]) ? k : Math.max(0, k - 1)]),
        mesh.spacing,
      );
      // 改道的是一条画的河：照它的类型画；新河照工具条上选的
      const src = p.reroute ? sourceGuide(w, p.cells[0]) : undefined;
      const rtype = src ? riverTypeOfGuide(w, src) : riverTypeOfGuide(w, chosenRiverType(w) as { type?: string });
      shapes.push({ kind: 'river', points: line.points, flow: line.flow, color, arrow: true, riverType: rtype });
      shapes.push(...lineShapes(w, line.points, { color: WHITE_LINE, width: 1.2, dashed: true }));
    }
    if (p.end === 'river') shapes.push(ringAt(w, mesh.x[p.join], mesh.y[p.join], 7 / zoom(), 2));
    return shapes;
  };
  const flowPreview = (w: World, cells: number[]): Preview => {
    const p = flowPlan(w, cells);
    if (!p) return EMPTY;
    const len = flowLen(w, p);
    const where = destText(w, p.end, p.end === 'river' ? p.join : p.cells[p.cells.length - 1]);
    if (p.blocked) return { layers: [], shapes: flowShapes(w, p, false), hint: p.blocked, warn: true };
    if (p.same) return { layers: [], shapes: flowShapes(w, p, false), hint: '河本来就这么流', warn: true };
    if (!p.reroute) return { layers: [], shapes: flowShapes(w, p, false), hint: `→ ${where} · ${len} km` };
    // 改道：路线停下来 150 毫秒后算确切的结果
    const cmd = flowCommand(w, p);
    const key = JSON.stringify(cmd);
    exact.want(key, cmd);
    const src = sourceGuide(w, p.cells[0]);
    const head = `${src ? `重画${quoted(guideName(w, src), '这条河')}` : '改道'} → ${where} · ${len} km`;
    const x = exact.get(key);
    if (!x) {
      const dried = p.dried.length ? ` · 旧河道约 ${km(p.dried.length * w.mesh.spacing * w.kmPerUnit)} km 变干` : '';
      return { layers: [], shapes: flowShapes(w, p, true), hint: `${head}${dried}…` };
    }
    const onPath = new Set(p.cells);
    const added = x.riverAdded.filter((c) => !onPath.has(c));
    // 分开说：这条河原来的下游变干多少；别处跟着变的（多半是河挪了一格）有几处
    const old = new Set<number>();
    for (let c = w.derived.receiver[p.cells[0]]; c >= 0 && !water(w, c) && !old.has(c); c = w.derived.receiver[c]) old.add(c);
    const dried = x.riverRemoved.filter((c) => old.has(c));
    const others = groupCount(w, [...x.riverRemoved.filter((c) => !old.has(c)), ...added]);
    return {
      layers: [
        { cells: x.riverRemoved, color: RED, alpha: 0.8 },
        { cells: added, color: BLUE, alpha: 0.7 },
      ],
      shapes: flowShapes(w, p, false),
      hint: head + (dried.length ? ` · 旧河道 ${km(dried.length * w.mesh.spacing * w.kmPerUnit)} km 变干` : '') + (others ? ` · 另有 ${others} 处河道变` : ''),
    };
  };

  // ---- 自定义走向、重画一段：规划按笔画的点数缓存 ----
  const courseNow = (w: World, pr: Press): { course: Course; line: GuideLine | null } => {
    const o = options.value;
    const key = `${worldId(w)}|${pr.kind}|${pr.guide ?? ''}|${pr.pts.length}|${o.riverEnd}|${o.riverFlow}`;
    if (courseCache?.key === key) return courseCache;
    const px = 1 / zoom();
    let course: Course;
    if (pr.kind === 'splice') {
      const g = pr.guide ? guideOf(w, pr.guide) : undefined;
      const r = g ? spliceCourse(w, w.derived, g, pr.pts, { endOnLand: g.end === 'sink' ? 'sink' : 'flow', px, tol: spliceTol(w, zoom()) }) : { blocked: '这条河已经不在了' };
      course = 'blocked' in r ? blocked(r.blocked, pr.pts.slice()) : spliceOf(w, g!, r.patch, r.plan, pr.pts.slice());
    } else {
      // 从一条画的河的终点（在终点消失的河的终点、画的线的末端）起笔：往下游接长这条河，不是改道
      const ext = extendCourse(w, w.derived, pr.pts, { endOnLand: o.riverEnd, px });
      // 从一条河中间起笔：从这里改道，还是这一条河
      const rr = ext ? null : rerouteCourse(w, w.derived, pr.pts, { endOnLand: o.riverEnd, px });
      if (ext) course = 'blocked' in ext ? blocked(ext.blocked, pr.pts.slice()) : spliceOf(w, ext.guide, ext.patch, ext.plan, pr.pts.slice(), 'extend');
      else if (rr) course = rerouteOf(w, rr.guide, rr.plan, pr.pts.slice());
      else course = newCourse(w, planCourse(w, w.derived, pr.pts, { endOnLand: o.riverEnd, px }), pr.pts.slice());
      // 接长、改道一条画的河时原来那条河先不画（预览画的是改好后的整条河）
      const hide = ext && !('blocked' in ext) ? ext.guide.id : rr?.guide && !rr.plan.blocked ? rr.guide.id : null;
      const cur = riverStyleOverride.value;
      if (hide && cur?.id !== hide) riverStyleOverride.value = { id: hide, hide: true };
      else if (!hide && cur?.hide && pr.hid === cur.id) riverStyleOverride.value = null;
      pr.hid = hide;
    }
    courseCache = { key, course, line: course.after ? tempLine(w, course.after) : null };
    return courseCache;
  };

  const coursePreview = (w: World, c: Course, line: GuideLine | null, shift: boolean, fetch = true): Preview => {
    if (fetch && c.cmd) exact.want(c.key, c.cmd);
    const x = c.cmd ? exact.get(c.key) : null;
    if (!line || !c.after) {
      const { shapes } = courseShapes(w, c, x, zoom(), { points: [], cellIdx: [] });
      return { layers: [], shapes, hint: c.blocked ?? '这里画不出河', warn: true };
    }
    const { shapes, layers } = courseShapes(w, c, x, zoom(), line);
    const h = courseHint(w, c, x, line, shift);
    return { layers, shapes, hint: h.text, warn: h.warn };
  };

  // 执行；重画、接上的那条河还选着
  const commit = async (c: Course) => {
    if (!c.cmd) return;
    // 排着队还没发出去的预览不要了（手一停就松开时，计时器还没到：不然它会在执行之后再算一遍）；
    // 已经在算的这一条算完后直接采用
    exact.hold();
    cancelPreviews();
    committing = c;
    try {
      const w = world.value;
      const known = new Set(w?.small.guides.map((g) => g.id) ?? []);
      await exec(c.cmd, c.kind === 'reroute' || (c.kind === 'new' && c.plan?.reroute) ? '正在改道…' : c.kind === 'splice' ? '正在重画…' : '正在计算河流…', undefined, undefined, (after, said) =>
        namedDest(after, c.cmd!, known, said),
      );
    } finally {
      committing = null;
      exact.reset();
      courseCache = null;
      riverStyleOverride.value = null;
      redrawTick.value++;
    }
  };

  // 穿过了别的河、从一条河中间或源头起笔：底部条问一句；松手时就开始算确切结果
  const ask = (w: World, c: Course) => {
    // 确切结果回来后，底部条上写的变干多长换成确切的
    exact.onGot = (key, r) => {
      if (key === c.key && pending?.course === c && riverPending.value) riverPending.value = { ...riverPending.value, text: pendingText(w, c, r) };
    };
    exact.want(c.key, c.cmd!, 0);
    const plan = c.plan!;
    const jp = plan.crossings.length ? endCourseAt(w, w.derived, plan, plan.crossings[0].from) : null;
    let join: Course | null = null;
    if (jp && !jp.blocked) {
      if (c.kind === 'reroute') join = rerouteOf(w, c.cmd?.op === 'update_guide' ? (guideOf(w, c.cmd.id) ?? null) : null, jp, c.raw);
      else if ((c.kind === 'splice' || c.kind === 'extend') && c.cmd?.op === 'update_guide') {
        const g = guideOf(w, c.cmd.id);
        if (g) {
          const patch: GuidePatch = { cells: jp.cells, path: encodePath(jp.path) };
          if (g.end) patch.end = null;
          join = spliceOf(w, g, patch, jp, c.raw, c.kind);
        }
      } else join = newCourse(w, jp, c.raw);
      if (join?.blocked) join = null;
    }
    pending = { course: c, join, view: 'capture' };
    const done = () => {
      pending = null;
      exact.onGot = null;
      riverPending.value = null;
      redrawTick.value++;
    };
    const st = startNote(w, c, null);
    riverPending.value = {
      text: pendingText(w, c, exact.get(c.key)),
      ...(st ? { confirm: st.label } : {}),
      capture: () => {
        done();
        return commit(c);
      },
      join: join
        ? () => {
            done();
            return commit(join!);
          }
        : null,
      cancel: () => {
        done();
        exact.reset();
        cancelPreviews();
        riverStyleOverride.value = null;
      },
      showJoin: (on) => {
        if (!pending) return;
        pending.view = on && pending.join ? 'join' : 'capture';
        const v = pending.view === 'join' ? pending.join! : pending.course;
        exact.want(v.key, v.cmd!, 0);
        redrawTick.value++;
      },
    };
  };

  // 点一下：点在河上是选中它；选着一条河时点别处只是取消选择；否则在这里点源头起一条顺地势的河
  const click = async (w: World, p: Pointer) => {
    const hit = riverAt(w, p.x, p.y, PICK_PX / zoom(), p.cell);
    if (hit) {
      selectedRiver.value = hit.ref;
      return;
    }
    if (selectedRiver.value) {
      selectedRiver.value = null;
      return;
    }
    if (p.cell < 0) return;
    if (water(w, p.cell)) return showToast('河要从陆地上开始', true);
    await flowUp(w, [p.cell], false);
  };

  const flowUp = async (w: World, cells: number[], moved: boolean) => {
    const p = flowPlan(w, cells);
    exact.hold();
    cancelPreviews();
    if (water(w, cells[0])) return showToast('河要从陆地上开始', true);
    if (p?.reroute && !moved) return showToast('这里已经有河：按住往外拖，让它从这里改道');
    if (!p || p.cells.length < 2) return showToast('这里画不出河', true);
    if (p.blocked) return showToast(p.blocked, true);
    if (p.same) return showToast('河本来就这么流，没有改');
    // 从一条河上拖出去：与自定义走向一样先问一句（改道 / 重画整条「赤江」 / 取消）
    if (p.reroute) return askFlow(w, cells, p);
    await runFlow(w, p);
  };
  const runFlow = async (w: World, p: RiverPlan) => {
    committing = p;
    try {
      const cmd = flowCommand(w, p);
      const known = new Set(w.small.guides.map((g) => g.id));
      await exec(cmd, p.reroute ? '正在改道…' : '正在计算河流…', undefined, undefined, (after, said) => namedDest(after, cmd, known, said));
    } finally {
      committing = null;
      exact.reset();
    }
  };
  // 底部条上的话：从中间改道时原来的下游变干多长（有确切结果时按它）；从画的河的源头是重画整条
  const flowNote = (w: World, p: RiverPlan, x: PreviewResult | null): StartNote => {
    const start = p.cells[0];
    const src = sourceGuide(w, start);
    if (src) {
      const name = quoted(guideName(w, src), '这条画的河');
      return { text: `从源头起笔：${name}原来的河道不要了，照新拖的走`, label: `重画整条${name}` };
    }
    const name = quoted(startRiverName(w, start), '这条河');
    let n = p.dried.length;
    if (x) {
      const old = new Set<number>();
      for (let c = w.derived.receiver[start]; c >= 0 && !water(w, c) && !old.has(c); c = w.derived.receiver[c]) old.add(c);
      n = x.riverRemoved.filter((c) => old.has(c)).length;
    }
    return { text: n ? `从这里改道：${name}下游约 ${cellsKm(w, n).toLocaleString()} km 会变干` : `从这里改道：${name}从这里起照新拖的走`, label: '改道' };
  };
  const askFlow = (w: World, cells: number[], p: RiverPlan) => {
    const cmd = flowCommand(w, p);
    const key = JSON.stringify(cmd);
    exact.want(key, cmd, 0);
    flowPending = cells;
    exact.onGot = (k, r) => {
      if (k === key && flowPending === cells && riverPending.value) riverPending.value = { ...riverPending.value, text: flowNote(w, p, r).text };
    };
    const done = () => {
      flowPending = null;
      exact.onGot = null;
      riverPending.value = null;
      redrawTick.value++;
    };
    const note = flowNote(w, p, exact.get(key));
    riverPending.value = {
      text: note.text,
      confirm: note.label,
      capture: () => {
        done();
        return runFlow(w, p);
      },
      join: null,
      cancel: () => {
        done();
        exact.reset();
        cancelPreviews();
      },
      showJoin: () => {},
    };
  };

  return {
    drags: true,
    down(p) {
      const w = world.value;
      if (!w || isBusy() || committing) return;
      // 等着确认时又按了一下：不截了（这一下不做别的）
      if (riverPending.value) {
        riverPending.value.cancel();
        return;
      }
      if (p.cell < 0) return;
      let kind: Press['kind'] = options.value.riverMode === 'course' ? 'course' : 'flow';
      let guide: string | null = null;
      const sel = selectedRiver.value;
      const g = sel?.kind === 'guide' ? guideOf(w, sel.id) : undefined;
      if (g) {
        const L = lineOf(w, g);
        const h = snapOnto(L.points, p.x, p.y, 0, L.points.length - 1, w.mesh.kind === 'sphere');
        if (h && h.d <= spliceTol(w, zoom())) {
          kind = 'splice';
          guide = g.id;
        }
      }
      // 自定义走向：起笔的点与悬停时说的是同一点（在一条河边上按下时挪到这条河上，见 courseStart）
      const s0 = kind === 'course' ? courseStart(w, p.x, p.y, p.cell, PICK_PX / zoom()) : p;
      press = { kind, start: p, pts: [[s0.x, s0.y]], last: [p.sx, p.sy], out: false, cells: [p.cell], moved: false, guide };
      pointer = p;
      courseCache = null;
      exact.reset();
    },
    move(p, pressed) {
      pointer = p;
      const w = world.value;
      const pr = press;
      if (!pressed || !pr || !w) return;
      // 手抖不算拖：在河上点一下是选中它
      if (!pr.moved && Math.hypot(p.sx - pr.start.sx, p.sy - pr.start.sy) > 6) {
        pr.moved = true;
        if (pr.kind === 'splice') riverStyleOverride.value = { id: pr.guide!, hide: true };
        else selectedRiver.value = null;
      }
      if (!pr.moved) return;
      // 画的线：每移动 2 个屏幕像素以上记一点；出了平面地图记下出去的那一点后不再记。整个星球南北不超出两极
      if (!pr.out && Math.hypot(p.sx - pr.last[0], p.sy - pr.last[1]) > 2) {
        const y = w.mesh.kind === 'sphere' ? Math.min(1, Math.max(0, p.y)) : p.y;
        pr.pts.push([p.x, y]);
        pr.last = [p.sx, p.sy];
        if (w.mesh.kind === 'plane' && (p.x < 0 || p.y < 0 || p.x > w.mesh.width || p.y > w.mesh.height)) pr.out = true;
      }
      if (pr.kind === 'flow' && p.cell >= 0 && pr.cells[pr.cells.length - 1] !== p.cell) pr.cells.push(p.cell);
    },
    async up(p) {
      const w = world.value;
      const pr = press;
      press = null;
      if (!w || !pr || committing) return;
      if (!pr.moved) return click(w, pr.start);
      if (pr.kind === 'flow') return flowUp(w, pr.cells, true);
      const { course: c } = courseNow(w, pr);
      if (!c.cmd || c.blocked || !c.plan) {
        exact.reset();
        cancelPreviews();
        riverStyleOverride.value = null;
        showToast(c.blocked ?? '这里画不出河', true);
        return;
      }
      // 从一条河中间、源头起笔（改道、重画整条）：一定先问一句；穿过别的河：按住 Shift 松手直接截走，否则先问一句
      if (startNote(w, c, null) || (c.plan.crossings.length && !p.shift)) {
        ask(w, c);
        return;
      }
      await commit(c);
    },
    cancel() {
      press = null;
      courseCache = null;
      exact.reset();
      cancelPreviews();
      if (!pending) riverStyleOverride.value = null;
    },
    leave() {
      pointer = null;
    },
    // 鼠标离开地图后预览还留着：等着确认截不截走、底部条上的预览，以及松手后还在算的那一笔
    // （画河不排队：结果换上之前一直显示松手时的样子，不闪回原样）
    keep: () => !!pending || !!flowPending || !!committing || !!riverBarPreview.value,
    escape() {
      if (!riverPending.value) return false;
      riverPending.value.cancel();
      return true;
    },
    enter() {
      if (!riverPending.value) return false;
      void riverPending.value.capture();
      return true;
    },
    preview() {
      const w = world.value;
      if (!w) return EMPTY;
      if (flowPending) return { ...flowPreview(w, flowPending), hint: null };
      if (pending) {
        const v = pending.view === 'join' && pending.join ? pending.join : pending.course;
        const line = v.after ? tempLine(w, v.after) : null;
        const pv = coursePreview(w, v, line, false, false);
        return { ...pv, hint: null };
      }
      if (committing) {
        if ('kind' in committing) {
          const line = committing.after ? tempLine(w, committing.after) : null;
          return { ...coursePreview(w, committing, line, false, false), hint: '正在计算…' };
        }
        return { layers: [], shapes: flowShapes(w, committing, false), hint: '正在计算…' };
      }
      const bar = riverBarPreview.value;
      if (bar && !press) return barPreviewShapes(w, bar, zoom());
      if (!pointer) return EMPTY;
      const pr = press;
      if (pr?.moved) {
        if (pr.kind === 'flow') return water(w, pr.cells[0]) ? { layers: [], shapes: [], hint: '河要从陆地上开始', warn: true } : flowPreview(w, pr.cells);
        const { course, line } = courseNow(w, pr);
        return coursePreview(w, course, line, pointer.shift);
      }
      // 悬停（或按下还没拖开）：鼠标下的河亮一下，写出它是哪条河；在选中的画的河上写怎么重画
      const at = pr?.start ?? pointer;
      const hit = riverAt(w, at.x, at.y, PICK_PX / zoom(), at.cell);
      const sel = selectedRiver.value;
      if (hit) {
        if (sel?.kind === 'guide' && hit.ref.kind === 'guide' && hit.ref.id === sel.id && hit.d <= spliceTol(w, zoom())) return { layers: [], shapes: [], hint: '从这里拖是重画这一段' };
        const info = riverInfo(w, hit.ref);
        // 自定义走向：写出从这里起笔会怎样（接长、改道、重画整条）；起笔的那一格与按下去以后用的相同
        const act = options.value.riverMode === 'course' ? startHint(w, courseStart(w, at.x, at.y, at.cell, PICK_PX / zoom()).cell) : null;
        const label = info ? riverLabel(hit.ref, info, at.cell) : null;
        const hint = act ? (label ? `${label} · ${act.text}` : act.text) : label;
        return { layers: [], shapes: riverGlow(w, hit.ref), hint, ...(act?.warn ? { warn: true } : {}) };
      }
      // 选着一条河时点别处只是取消选择：不预览新河
      if (sel || at.cell < 0) return EMPTY;
      if (options.value.riverMode === 'flow' && !water(w, at.cell)) return flowPreview(w, [at.cell]);
      return EMPTY;
    },
  };
}

// ---------- 删除河湖 ----------

// 删掉画过的河或湖：找离鼠标最近的（屏幕上 12 像素以内；画的河按画出来的线认）。
// 停在同一条河上 300 毫秒后，确切地算出删掉后真正不再是河的格（红色）
export function unwaterTool(zoom: () => number): ToolHandler {
  let pointer: Pointer | null = null;
  const exact = new RiverExact();
  const target = (w: World): { kind: 'guide' | 'lake'; id: string; cells: number[] } | null => {
    if (!pointer) return null;
    const { mesh } = w;
    const tol = 12 / zoom();
    let best: { kind: 'guide' | 'lake'; id: string; cells: number[] } | null = null;
    let bd = tol;
    const sphere = mesh.kind === 'sphere';
    for (const l of w.small.lakes) {
      const dd = (sphere ? arcUnits(mesh.x[l.cell], mesh.y[l.cell], pointer.x, pointer.y) : Math.hypot(mesh.x[l.cell] - pointer.x, mesh.y[l.cell] - pointer.y)) - l.radius / w.kmPerUnit;
      if (dd < bd) {
        bd = Math.max(0, dd);
        best = { kind: 'lake', id: l.id, cells: lakeArea(w, l.cell, l.radius) };
      }
    }
    for (const g of w.small.guides) {
      const L = lineOf(w, g);
      const h = snapOnto(L.points, pointer.x, pointer.y, 0, L.points.length - 1, sphere);
      if (h && h.d < bd) {
        bd = h.d;
        best = { kind: 'guide', id: g.id, cells: g.cells };
      }
    }
    return best;
  };
  return {
    drags: false,
    move(p) {
      pointer = p;
    },
    leave() {
      pointer = null;
      exact.reset();
    },
    async click(p) {
      pointer = p;
      const w = world.value;
      if (!w || isBusy()) return;
      const t = target(w);
      if (!t) {
        showToast('这里没有画过的河或湖（自然的河可以用“画河”点中它，再“从这里往下去掉”）', true);
        return;
      }
      if (selectedRiver.value?.kind === 'guide' && selectedRiver.value.id === t.id) selectedRiver.value = null;
      exact.hold();
      cancelPreviews();
      try {
        await exec(t.kind === 'guide' ? { op: 'remove_guide', id: t.id } : { op: 'remove_lake', id: t.id }, '正在计算…');
      } finally {
        exact.reset();
      }
    },
    cancel() {
      exact.reset();
    },
    preview() {
      const w = world.value;
      if (!w || !pointer) return EMPTY;
      const t = target(w);
      // 离开了画的河：停在它上面时排着的确切预览不要了
      if (t?.kind !== 'guide') exact.reset();
      if (!t) return EMPTY;
      if (t.kind === 'lake') return { layers: [{ cells: t.cells, color: RED, alpha: 0.7 }], shapes: [], hint: '删掉这个湖' };
      const g = guideOf(w, t.id)!;
      const cmd: Command = { op: 'remove_guide', id: t.id };
      const key = JSON.stringify(cmd);
      exact.want(key, cmd, 300);
      const x = exact.get(key);
      const shapes = lineShapes(w, lineOf(w, g).points, { color: RED_LINE, width: 4 });
      if (!x) return { layers: [], shapes, hint: '删掉这条河' };
      // 删掉后这里还剩多少是河：水本来就会这么流的地方还是河
      const gone = new Set(x.riverRemoved);
      const body = g.cells.filter((c) => isRiverCell(w, w.derived, c));
      const left = body.filter((c) => !gone.has(c)).length;
      return {
        layers: [{ cells: x.riverRemoved, color: RED, alpha: 0.8 }],
        shapes,
        hint: left >= Math.max(2, body.length * 0.3) ? '删掉这条河（这里还会剩一条自然的河）' : '删掉这条河',
      };
    },
  };
}
