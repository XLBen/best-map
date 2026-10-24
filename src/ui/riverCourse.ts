import { signal } from '@preact/signals';
import type { Command } from '../../core/commands';
import type { PreviewResult } from '../../core/engine';
import { lakeArea } from '../../core/elevation';
import type { GeoFeature } from '../../core/features';
import { arcUnits, wrapX } from '../../core/geo';
import { findCell } from '../../core/mesh';
import {
  type EditPoint,
  type EditResult,
  type EditRole,
  type EditTarget,
  type RiverEdit,
  type Extra,
  BRANCH_SHARE,
  applyPatch,
  branchCourse,
  sourceCourse,
  controlHandles,
  deleteHandle,
  dragHandle,
  editCommand,
  editPoint,
  editRole,
  editedGuide,
  guideTarget,
  insertHandle,
  joinAtFirst,
  midHandle,
  naturalTarget,
  ruleTypeOf,
  strokeEdit,
} from '../../core/river-edit';
import { PLAIN_RIVER } from '../../core/river-types';
import { matchesNaturally } from '../../core/water-types';
import { type GuideLine, type RiverLine, centrePoints, cutAtJoin, encodePath, guideLine, ownsCell, projectNear, smoothCourse, snapOnto, stemPath } from '../../core/rivers';
import { type CourseEnd, type CoursePlan, type GuideIssue, type Overlap, type RiverPlan, branchedOff, endCourseAt, guideEnd, guideFlow, guideIssues, isRiverCell, mergeCourse, overlapsOf, planCourse, planRiver, riverStem } from '../../core/select';
import { roundKm as km } from '../../core/terrain';
import type { Guide, World } from '../../core/world';
import type { HighlightLayer } from '../render/colors';
import { type Shape, riverLines, splitRiverLine } from '../render/overlay';
import {
  type RiverRef,
  cancelPreviews,
  cursorHint,
  exec,
  measure,
  options,
  previewCommand,
  redrawTick,
  riverStyleOverride,
  selectedRiver,
  showToast,
  tool,
  world,
} from '../state';
import { Exact, type ExactView } from './exact';
import { type Pointer, type Preview, type ToolHandler, isBusy, pathKm, riverSizeName, worldId } from './tools';

export { applyPatch } from '../../core/river-edit';


// 画的线停在陆地上时的两种终点（第十四轮：短的叫法“流下去”“停在这”，细的说法在悬停的提示里）。
// 底部条的“终点”和选中的河“⋯ → 终点”同用
export const RIVER_END_HINTS = {
  flow: '线停在陆地上时，河顺着地势接着往低处流，直到入海、入湖或汇进别的河',
  sink: '河就在你画的线的终点结束，不再往下流',
} as const;

// 画河、选河、改河、删河（第十一轮：在原来的河上直接改，所见即所得）。一条记得住的规则：
//   · 从河上起笔（离河的线 14 个屏幕像素以内，不随缩放变）= 改这条河；从别处起笔 = 画新的河。不管选没选中、哪种走向都一样；
//     悬停与按下用同一个判定（pick），悬停时就写着松手后会怎样；
//   · 改一条河永远还是同一条河（同一个河道、名字、大小、类型、粗细），自然的河第一次改时固定下来（名字照旧）；
//   · 选中的河上有控制点（源头、终点、弯点，弯点之间有“+”）：拖控制点只改它两边的那一小段，双击弯点删掉它；
//   · 不再先问一句：拖的时候地图上就是改完的样子（改着的这条河立刻按将来的样子画、原来的样子先不画，
//     会变干的河段是灰色虚线；手停下来后在 worker 里算出将来的整个世界，地图上所有的河都按它画），松手就改，顶部的提示带“撤销”。
// 顺地势、自定义走向只管新画的河；改已有的河总是照着画的线走

const EMPTY: Preview = { layers: [], shapes: [], hint: null };
type RGB = [number, number, number];
const RED: RGB = [235, 80, 70];
// 挖出的河床（峡谷）
const CARVED: RGB = [150, 95, 55];
const RED_LINE = 'rgba(235, 80, 70, 0.95)';
const WHITE_LINE = 'rgba(255, 255, 255, 0.85)';
// 会变干的河段：灰色虚线的影子
const GHOST_LINE = 'rgba(200, 200, 200, 0.9)';
// 没能照画的走的那段（比如中途进了海）：黄色
const YELLOW_LINE = 'rgba(255, 210, 70, 0.95)';
// 选中、悬停的河：沿河一道淡黄的光
const GLOW = 'rgba(255, 226, 120, 0.5)';

// 起笔吸到河上：离河的线几个屏幕像素以内（悬停发光、写名字，按下去改的就是它）
export const SNAP_PX = 14;
// 控制点：点中的范围、“+”点中的范围、控制点之间至少隔多远、化简的容差（屏幕像素）
const HANDLE_PX = 9;
const PLUS_PX = 6;
const HANDLE_GAP_PX = 40;
const HANDLE_TOL_PX = 4;
// 排着队（或松手前世界变了）的一笔认不出要改的河：不改，说一声
const LOST = '这一笔没改上：河刚变了，再拖一次';
// 双击弯点删掉它：两下之间不超过这么久（毫秒）
const DOUBLE_MS = 400;

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
function destText(w: World, kind: CourseEnd | 'unknown' | null, cell: number, quoted = true, self?: GeoFeature): string {
  const q = (n: string) => (quoted ? `「${n}」` : n);
  switch (kind) {
    case 'sea':
      return '入海';
    case 'lake': {
      const n = cell >= 0 ? lakeNameAt(w, cell) : null;
      return n ? `流进${q(n)}` : '流进湖里';
    }
    case 'river': {
      // 汇合的那一格可能算在汇进来的河上（它比上游大时）：再看下游那一格，是被汇入的那条河的
      const n = cell >= 0 ? riverNameAt(w, cell, self) || riverNameAt(w, w.derived.receiver[cell], self) : null;
      return n ? `汇入${q(n)}` : '汇入一条河';
    }
    case 'edge':
      return '流出地图';
    case 'sink':
      // 说的是整条河（悬停在终点那一格上时另说“停在这里”，见 riverLabel）
      return '最后停在终点';
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

// 鼠标附近的河：画的河照画出来的线认，自然的河照地图上画出来的线（线上每一点都知道在哪一格）。
// 几条河都在 tol 以内时（汇合处）按离得多近、再偏向画得宽的那条：水量每翻一倍，算作近 2 个屏幕像素
// （tol 是 14 个屏幕像素），所以点在大河上不会选中挨着它的一两格的小支流。
// 线都离得远时，鼠标下那一格是河也算（放得很大时宽宽的大河）
export function riverAt(w: World, x: number, y: number, tol: number, cell = -1): RiverHit | null {
  const sphere = w.mesh.kind === 'sphere';
  const thr = w.small.planet.riverThreshold;
  const bias = (2 * tol) / SNAP_PX;
  const d = w.derived;
  let best: (RiverHit & { score: number }) | null = null;
  const consider = (ref: RiverRef, dist: number, q: number) => {
    const score = dist - bias * Math.log2(Math.max(0, q) / thr + 1);
    if (!best || score < best.score) best = { ref, d: dist, score };
  };
  for (const g of w.small.guides) {
    const L = lineOf(w, g);
    const h = snapOnto(L.points, x, y, 0, L.points.length - 1, sphere);
    if (!h || h.d > tol) continue;
    const c = g.cells[L.cellIdx[h.k] ?? 0];
    consider({ kind: 'guide', id: g.id }, h.d, d.discharge[c]);
  }
  for (const line of riverLines(w)) {
    if (line.guide !== undefined || !line.cells || line.points.length < 2) continue;
    const b = boxOf(line);
    if (y < b[1] - tol || y > b[3] + tol || (!sphere && (x < b[0] - tol || x > b[2] + tol))) continue;
    const h = snapOnto(line.points, x, y, 0, line.points.length - 1, sphere);
    if (!h || h.d > tol) continue;
    // 投影点离线段哪一头近，就是哪一格；那一格不是河（入海的那一点）时取另一头。
    // 整个星球：鼠标可能在平铺的另一份上（投影点跟着挪了整圈），挪回线所在的那一份再比
    const [ax, ay] = line.points[h.k];
    const [bx, by] = line.points[h.k + 1];
    const px = sphere ? h.p[0] - 2 * Math.round((h.p[0] - ax) / 2) : h.p[0];
    const near = Math.hypot(px - ax, h.p[1] - ay) <= Math.hypot(px - bx, h.p[1] - by);
    let c = line.cells[near ? h.k : h.k + 1];
    if (!isRiverCell(w, d, c)) c = line.cells[near ? h.k + 1 : h.k];
    // 线的最后一格是它汇入的那条河的（汇合处）：点在这一小段上算这条河自己的（不然选中的是那条大河）
    const tail = line.cells[line.cells.length - 1];
    for (let j = line.cells.length - 2; c === tail && j >= 0; j--) if (line.cells[j] !== tail) c = line.cells[j];
    // 水量按认出来的那一格（支流画到汇合处的最后一点带的是大河的流量）
    if (isRiverCell(w, d, c)) consider({ kind: 'natural', cell: c }, h.d, d.discharge[c]);
  }
  if (best) {
    const b: RiverHit & { score: number } = best;
    return { ref: b.ref, d: b.d };
  }
  if (cell < 0 || !isRiverCell(w, d, cell)) return null;
  const g = guideAt(w, cell);
  return { ref: g ? { kind: 'guide', id: g.id } : { kind: 'natural', cell }, d: tol };
}

// 这一格在哪条画的河上（它汇入的地方不算，停在终点的河的终点算）；后画的优先
function guideAt(w: World, cell: number): Guide | undefined {
  for (let n = w.small.guides.length - 1; n >= 0; n--) {
    const g = w.small.guides[n];
    const k = g.cells.indexOf(cell);
    if (k >= 0 && ownsCell(g, k)) return g;
  }
  return undefined;
}

// 一条折线按段的起点挪进 [0, 2)（整个星球）：挪的份数变了就另起一条，平铺的副本才画得全
function wrappedLines(w: World, pts: readonly [number, number][]): [number, number][][] {
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
function stemOf(w: World, cell: number) {
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
  // 一道淡黄的光，上面照地图上的画法再画一遍这条河（河还是蓝的，不被光盖成灰色——灰色是“会变干”）
  const style = { color: GLOW, width: 9 };
  const pieces: RiverLine[] = [];
  if (ref.kind === 'guide') {
    for (const line of riverLines(w)) if (line.guide === ref.id) pieces.push(line);
  } else {
    const on = new Set(stem);
    // 汇入别的河的那一格是那条河的：只亮这条河自己流到那里的一段，不亮到那条河上
    const join = stemOf(w, ref.cell).end === 'river' ? stem![stem!.length - 1] : -1;
    for (const line of riverLines(w)) {
      if (line.guide !== undefined || !line.cells) continue;
      let run: number[] = [];
      const flush = () => {
        if (run.length > 1) {
          const pick = <T,>(a: T[] | undefined) => (a ? run.map((k) => a[k]) : undefined);
          pieces.push({ points: pick(line.points)!, flow: pick(line.flow)!, cells: pick(line.cells), ...(line.type ? { type: pick(line.type) } : {}) });
        }
        run = [];
      };
      line.points.forEach((_, k) => {
        const c = line.cells![k];
        if (on.has(c) && (c !== join || run.length)) run.push(k);
        else flush();
      });
      flush();
    }
  }
  out = [];
  for (const p of pieces) out.push(...lineShapes(w, p.points, style));
  const types = w.small.riverTypes ?? [];
  for (const p of pieces) {
    const t = p.type?.[0];
    out.push({ kind: 'river', points: p.points, flow: p.flow, ...(p.mul ? { mul: p.mul } : {}), ...(t ? { riverType: types[t - 1] } : {}) });
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
  // 提醒的原因与出问题的那几格（底部条上的提醒点一下标出来，见 core/select.ts 的 guideIssues）
  issues: GuideIssue[];
  // 这条河上分出去了几成水（分出的地方的总水量里；没有分出去时为 0）
  split: number;
  // 河上的格（画的河是河道，自然的河是主干）
  cells: number[];
  // 停在终点（终点是 cells 的最后一格）
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
      const { total, split } = guideFlow(w, d, g);
      const end = guideEnd(w, d, g);
      const issues = guideIssues(w, d, g);
      info = {
        // 没有自己地名的画的河：写它所在的那条自然大河的名字
        name: guideName(w, g),
        feature: f,
        size: riverSizeName(total),
        flow: total * thr,
        km: pathKm(w, lineOf(w, g).points),
        dest: sourceDest(w, g) ?? destText(w, end.kind, end.cell, true, f ?? undefined),
        warnings: issues.map((x) => x.text),
        issues,
        split,
        cells: g.cells,
        sink: end.kind === 'sink',
      };
    }
  } else if (isRiverCell(w, d, ref.cell)) {
    const stem = stemOf(w, ref.cell);
    // 大小按汇入别的河之前的那一格（汇合的那格是那条更大的河的）
    const own = stem.end === 'river' ? stem.cells.slice(0, -1) : stem.cells;
    // 名字按主干（点到汇合处那一格时不顶着大河的名字）
    const f = stemFeature(w, own);
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
      issues: [],
      split: branchedOff(w, d, own).split,
      cells: stem.cells,
      sink: stem.end === 'sink',
    };
  }
  m.set(key, info);
  return info;
}

// 另一个源头（sourceOf）：它是哪条河的源头（那条河还在时）
function sourceDest(w: World, g: Guide): string | null {
  const p = g.sourceOf !== undefined ? guideOf(w, g.sourceOf) : undefined;
  if (!p) return null;
  return `是${quoted(guideName(w, p), '一条河')}的又一个源头`;
}

// 悬停时的一句话：“赤江 · 中等的河 · 汇入「青河」”。cell：鼠标下那一格（停在终点的河，停在终点上时说“停在这里”）
export const riverLabel = (ref: RiverRef, info: RiverInfo, cell = -1) =>
  `${info.name ?? (ref.kind === 'guide' ? '画的河' : '一条河')} · ${info.size} · ${info.sink && cell >= 0 && cell === info.cells[info.cells.length - 1] ? '停在这里' : info.dest}`;


// ---------- 命令 ----------

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

// 新画的河“按规则”（画河工具条上要自己选；默认是普通的河）
export const BY_RULES = '*rules';

// 有没有哪一种河会按规则自己出现（写了 match 脚本，或只选了“只在这些生态里”；关掉了自然生成的不算）
export const hasRiverRules = (w: World) => (w.small.riverTypes ?? []).some(matchesNaturally);

// 新画的河选的河流类型（画河工具条上选的；默认、那种类型已经删掉了时为普通的河）。普通的河总是写成 plain
// （工具条上写着“普通”画的河，以后加了规则、只选了生态的类型也不变成别的河）；有规则并选了“按规则”时才不写类型
export function chosenRiverType(w: World): { type: string } | Record<string, never> {
  const id = options.value.riverType;
  if (id === BY_RULES && hasRiverRules(w)) return {};
  if (id && id !== PLAIN_RIVER && id !== BY_RULES && w.small.riverTypes?.some((t) => t.id === id)) return { type: id };
  return { type: PLAIN_RIVER };
}

// 一条河道画出来按哪一种河流类型（预览照这种河画）
const riverTypeOfGuide = (w: World, g: Pick<Guide, 'type'> | null | undefined) => (g?.type ? w.small.riverTypes?.find((t) => t.id === g.type) : undefined);

// 一笔画出来的河、改一条河：松手后执行的命令（确切预览用的也是它）、执行后这条河的样子与估计的流量
export interface Course {
  // new：新画的河；merge：接到一条画的河的源头前面（成为它的上游）；edit：改一条已有的河（还是同一条河）；
  // branch：从选中的河上分一股出去；source：给选中的河加一个源头（第十三轮）
  kind: 'new' | 'merge' | 'edit' | 'branch' | 'source';
  plan: CoursePlan | null;
  blocked: string | null;
  cmd: Command | null;
  // 命令的 JSON：确切预览的键
  key: string;
  // 执行后这条河道的样子（画预览用）；画不出来时为 null
  after: Guide | null;
  // after.cells 每格估计的流量
  estimate: number[];
  // 改的、接上的那条河现在的名字
  name: string | null;
  // 画的线（画不出来时照它画一道红虚线）
  raw: [number, number][];
  // 改一条河：改的是哪条、怎么改的
  target?: EditTarget;
  edit?: RiverEdit;
  // 拖控制点：松手后这条河上的控制点（拖的那个在松手的地方），改完以后照用（见 stickyHandles）
  sticky?: [number, number][];
  // 重叠分析（第十三轮）：绕回自己旁边、贴着别的河流……预览里黄色标出来，提示条、顶部的话里说一声
  overlaps?: Overlap[];
  // 加一个源头：松手后选中哪条河道（自然的河先固定成这条）
  selectAfter?: string;
}

const blocked = (text: string, raw: [number, number][], plan: CoursePlan | null = null): Course => ({ kind: 'new', plan, blocked: text, cmd: null, key: '', after: null, estimate: [], name: null, raw });

const quoted = (name: string | null, fallback: string) => (name ? `「${name}」` : fallback);

// 穿过的别的河（改的这条河自己不算）
function otherCrossings(plan: CoursePlan | null, self: string | null): CoursePlan['crossings'] {
  return (plan?.crossings ?? []).filter((x) => !self || x.guide !== self);
}

// 穿过的那条河叫什么
function crossingName(w: World, x: CoursePlan['crossings'][number]): string | null {
  if (x.guide) {
    const g = guideOf(w, x.guide);
    if (g) return guideName(w, g);
  }
  return riverNameAt(w, x.cell);
}

// 截走的画的河会不会整条去掉（与 commands.ts 的 captureBy 相同：碰到的是它的源头）
function captureDeletes(w: World, after: Guide, id: string): boolean {
  const g = guideOf(w, id);
  if (!g) return false;
  const inner = new Set(after.cells.slice(1, -1).filter((c) => w.causes.land[c]));
  return g.cells.findIndex((c, i) => ownsCell(g, i) && inner.has(c)) === 0;
}

// 贴着一条画的河、没穿过去（在碰到它的地方汇入，不截走它，第十三轮）：一句话；不是这样时为 ''
function touchWords(w: World, plan: CoursePlan | null, done: boolean): string {
  if (!plan || plan.touch === undefined) return '';
  const name = quoted(riverNameAt(w, plan.touch), '那条河');
  return done ? `没穿过${name}，不截走它` : `没穿过${name}：在碰到它的地方汇入，不截走它`;
}

// “截走「赤江」”“删掉「白水」”（穿过不止一条时“等 3 条河”；第一条没有名字时“截走 3 条河”）；没穿过别的河时为 ''
function captureWords(w: World, plan: CoursePlan | null, after: Guide | null, self: string | null, done: boolean): string {
  const xs = otherCrossings(plan, self);
  if (!xs.length || !after) return '';
  const x = xs[0];
  const name = crossingName(w, x);
  const del = !!x.guide && captureDeletes(w, after, x.guide);
  const verb = done ? (del ? '删掉了' : '截走了') : del ? '会删掉' : '会截走';
  if (xs.length > 1) return name ? `${verb}「${name}」等 ${xs.length} 条河` : `${verb} ${xs.length} 条河`;
  return `${verb}${quoted(name, del ? '一条画的河' : '一条河')}`;
}

// 新画的一条河（或接到一条画的河的源头前面）
export function newCourse(w: World, plan: CoursePlan, raw: [number, number][]): Course {
  if (plan.blocked || plan.cells.length < 2) return blocked(plan.blocked ?? '这里画不出河', raw, plan);
  // 从河上起笔的一笔是改那条河（pick 认得出来），不会到这里；万一到了也不另起一条
  if (plan.reroute) return blocked('从河上起笔是改这条河', raw, plan);
  const capture = plan.crossings.some((x) => x.guide !== null);
  const len = km(pathKm(w, plan.path));
  const merged = plan.merge ? guideOf(w, plan.merge) : undefined;
  if (merged) {
    // 汇进一条画的、有泉水的河的源头：成为它的上游，名字、大小照旧
    const patch = mergeCourse(plan, merged);
    const after = applyPatch(merged, patch);
    const name = guideName(w, merged);
    const cap = captureWords(w, plan, after, merged.id, true);
    const cmd: Command = { op: 'update_guide', id: merged.id, patch, ...(capture ? { capture: true } : {}), label: `接上了${quoted(name, '一条画的河')}（约 ${len} km）${cap ? ` · ${cap}` : ''}` };
    // 新画的那段：本来的水加上源头的泉水；接上的那段照旧（已经含着它的水）
    const head = plan.cells.length - 1;
    const prof = springProfile(w, after.cells, true, merged.flow);
    let q = 0;
    const estimate = after.cells.map((c, k) => (q = Math.max(q, w.derived.discharge[c] + (k < head ? prof[k] : 0))));
    return { kind: 'merge', plan, blocked: null, cmd, key: JSON.stringify(cmd), after, estimate, name, raw };
  }
  const where = destOf(w, plan);
  const d = w.derived;
  const guide = {
    cells: plan.cells,
    path: encodePath(plan.path),
    locked: true,
    spring: true,
    flow: options.value.riverFlow,
    name: '',
    ...(plan.end === 'sink' ? { end: 'sink' as const } : {}),
    ...chosenRiverType(w),
  };
  const after = { id: '', ...guide } as Guide;
  const cap = captureWords(w, plan, after, null, true) || touchWords(w, plan, true);
  const cmd: Command = { op: 'add_guide', guide, ...(capture ? { capture: true } : {}), label: `画了一条河（约 ${len} km，${where}）${cap ? ` · ${cap}` : ''}${plan.gorge >= 100 ? ` · ${gorgeWords(plan.gorge)}` : ''}` };
  const estimate = springProfile(w, plan.cells, true, options.value.riverFlow).map((q, k) => d.discharge[plan.cells[k]] + q);
  return { kind: 'new', plan, blocked: null, cmd, key: JSON.stringify(cmd), after, estimate, name: null, raw };
}

// 挖得这么深（米）以上时，拖的时候黄色提醒
const DEEP_GORGE = 1500;
// 改完顶部说的：挖出了峡谷（松手后褐色的格就看不见了，说一声）
const gorgeWords = (m: number) => `挖出了峡谷（最深${meters(m)}）`;

// 改的这条河叫什么：画的河按它的名字，自然的河按它主干上的地名（不是点到的那一格上的：汇合处那一格算在大河上）
function targetName(w: World, T: EditTarget, _ref: RiverRef): string | null {
  if (!T.natural) return guideName(w, T.guide);
  return T.guide.name || T.guide.autoName || stemFeature(w, T.own)?.name || null;
}

// 一条自然的河的主干（自己的格）是哪条有名字的自然大河：主干上的格一半以上在那条河的地物里。没有时为 null
// （汇合处的小支流不会顶着大河的名字）
function stemFeature(w: World, own: readonly number[]): GeoFeature | null {
  const count = new Map<GeoFeature, number>();
  let n = 0;
  for (const c of own) {
    if (!isRiverCell(w, w.derived, c)) continue;
    n++;
    for (const f of featureIndex(w).rivers.get(c) ?? []) if (f.guide === undefined) count.set(f, (count.get(f) ?? 0) + 1);
  }
  let best: GeoFeature | null = null;
  let bn = 0;
  for (const [f, k] of count) if (k > bn) [best, bn] = [f, k];
  return best && bn * 2 >= n ? best : null;
}

// 固定一条自然的河时的名字：沿用那条河的地名键，记下现在的名字（autoName）。那个键已经有一条画的河用着
// （改道后剩下的旧河道还叫着那个键的地名）时不再用它，只记下名字，不会两条河同一个键
function stemNaming(w: World, f: GeoFeature | null): { nameKey: string; autoName?: string } | { name: string; autoName?: string } {
  if (!f) return { name: '' };
  const auto = f.name && !f.custom ? { autoName: f.name } : {};
  if (w.small.guides.some((g) => g.nameKey === f.key)) return { name: '', ...auto };
  return { nameKey: f.key, ...auto };
}

// 怎么改的（悬停、拖动时说的、历史里记的）
type EditHow = 'stroke' | 'source' | 'end' | 'bend' | 'plus' | 'delete';

// 改一条河：命令、执行后的样子（还是同一条河）。how：从哪里改的（拖控制点、重画一笔）
function editCourse(w: World, T: EditTarget, ref: RiverRef, r: EditResult, raw: [number, number][], how: EditHow): Course {
  if ('blocked' in r) return { ...blocked(r.blocked, raw), target: T };
  const name = targetName(w, T, ref);
  const n = quoted(name, T.natural ? '这条河' : '这条画的河');
  const after = editedGuide(T, r);
  const len = km(pathKm(w, raw));
  const dest = r.patch.end === 'sink' ? '停在这里' : destOf(w, r.plan);
  let label: string;
  switch (r.kind) {
    case 'splice':
      label = `重画了${n}的一段（约 ${len} km）`;
      break;
    case 'extend':
      label = `${n}往下游接长了（约 ${len} km，${dest}）`;
      break;
    case 'source':
      label = `挪了${n}的源头`;
      break;
    case 'shorten':
      label = `${n}缩短了，停在这里`;
      break;
    case 'reroute':
      label = how === 'end' ? `挪了${n}的终点（${dest}）` : how === 'stroke' ? `${n}从这里改道（约 ${len} km，${dest}）` : `改了${n}的走向（${dest}）`;
      break;
    default:
      label = how === 'delete' ? `删掉了${n}的一个弯点` : `改了${n}的走向`;
  }
  const cap = captureWords(w, r.plan, after, T.natural ? null : T.guide.id, true) || touchWords(w, r.plan, true);
  if (cap) label += ` · ${cap}`;
  if (r.plan.gorge >= 100) label += ` · ${gorgeWords(r.plan.gorge)}`;
  if (T.natural) label += '（固定下来）';
  const cmd = editCommand(T, r, label.slice(0, 200));
  // 原来河道上的格照旧（已经含着这条河的水）；新画的格带着上游流下来的水（沿河往下只增不减）；画的河整条是河
  const thr = w.small.planet.riverThreshold;
  const old = new Set(T.guide.cells);
  let q = 0;
  const estimate = after.cells.map((c) => Math.max(thr, (q = old.has(c) ? w.derived.discharge[c] : Math.max(q, w.derived.discharge[c]))));
  return { kind: 'edit', plan: r.plan, blocked: null, cmd, key: JSON.stringify(cmd), after, estimate, name, raw, target: T, edit: r };
}

// ---------- 分一股出去、加一个源头（第十三轮） ----------

// 选中一条河后按了底部条上的“分一股出去”“加一个源头”：下一笔从这条河上起笔画（Esc 不加了）
export const riverAddMode = signal<'branch' | 'source' | null>(null);

// 自然的河加源头时先固定下来：河道 id（不与已有的重复）
function pinId(w: World, T: EditTarget): string {
  const base = `stem-${T.guide.cells[0]}-${T.guide.cells[T.guide.cells.length - 1]}`;
  let id = base;
  for (let k = 2; w.small.guides.some((g) => g.id === id); k++) id = `${base}-${k}`;
  return id;
}

// 分一股出去、加一个源头：命令、执行后新的那条河道的样子与估计的流量
function extraCourse(w: World, T: EditTarget, ref: RiverRef, r: Extra | { blocked: string }, raw: [number, number][], kind: 'branch' | 'source'): Course {
  if ('blocked' in r) return { ...blocked(r.blocked, raw), kind, target: T };
  const plan = r.plan;
  const d = w.derived;
  const name = targetName(w, T, ref);
  const n = quoted(name, '这条河');
  const len = km(pathKm(w, plan.path));
  const type = T.guide.type ?? T.ruleType;
  const typed = type ? { type } : chosenRiverType(w);
  if (kind === 'branch') {
    const guide = {
      cells: plan.cells,
      path: encodePath(plan.path),
      locked: true,
      spring: false,
      name: '',
      branch: { share: BRANCH_SHARE },
      ...(plan.end === 'sink' ? { end: 'sink' as const } : {}),
      ...typed,
    };
    const after = { id: '', ...guide } as Guide;
    const cap = captureWords(w, plan, after, null, true) || touchWords(w, plan, true);
    const cmd: Command = { op: 'add_guide', guide, ...(plan.crossings.some((x) => x.guide !== null) ? { capture: true } : {}), label: `从${n}分出一股（约 ${Math.round(BRANCH_SHARE * 100)}% 的水，约 ${len} km，${destOf(w, plan)}）${cap ? ` · ${cap}` : ''}` };
    // 分出去的水：分出处的 share，再加上一路上本来的水
    const q = BRANCH_SHARE * d.discharge[r.cell];
    const estimate = plan.cells.map((c, k) => (k === 0 ? q : d.discharge[c] + q));
    return { kind, plan, blocked: null, cmd, key: JSON.stringify(cmd), after, estimate, name, raw, target: T };
  }
  // 加一个源头：画的这段算这条河的一部分（同名）；自然的河先固定下来（一步，撤销一起撤）
  const parent = T.natural ? pinId(w, T) : T.guide.id;
  const guide = {
    cells: plan.cells,
    path: encodePath(plan.path),
    locked: true,
    spring: true,
    flow: options.value.riverFlow,
    name: '',
    sourceOf: parent,
    ...typed,
  };
  const after = { id: '', ...guide } as Guide;
  const cap = captureWords(w, plan, after, null, true) || touchWords(w, plan, true);
  const label = `给${n}加了一个源头（约 ${len} km）${cap ? ` · ${cap}` : ''}`;
  const add: Command = { op: 'add_guide', guide, ...(plan.crossings.some((x) => x.guide !== null) ? { capture: true } : {}), label };
  let cmd: Command = add;
  if (T.natural) {
    const { id: _, ...pinned } = T.guide;
    cmd = { op: 'batch', label, commands: [{ op: 'add_guide', guide: { ...pinned, id: parent }, label: `固定了${n}` }, add] };
  }
  const estimate = springProfile(w, plan.cells, true, options.value.riverFlow).map((q, k) => d.discharge[plan.cells[k]] + q);
  return { kind, plan, blocked: null, cmd, key: JSON.stringify(cmd), after, estimate, name, raw, target: T, selectAfter: parent };
}

// ---------- 重叠分析的说法、标法 ----------

// 一处重叠怎么说（一句短话；拖的时候黄色标出那一段，所以不再说“离远一点”之类的办法）；done：松手后顶部说的
function overlapWords(w: World, o: Overlap, done: boolean): string | null {
  const other = () => {
    const g = o.guide ? guideOf(w, o.guide) : undefined;
    const n = g ? guideName(w, g) : o.cells.length ? riverNameAt(w, o.cells[0]) : null;
    return quoted(n, '别的河');
  };
  switch (o.kind) {
    case 'loop':
      return done ? null : '剪掉了一个绕回来的圈（黄色）';
    case 'near-self':
      return done ? '有一段绕回了自己旁边' : '有一段绕回了自己旁边（黄色）';
    case 'alongside':
      return done ? `有一段贴着${other()}流` : `贴着${other()}流（黄色）`;
    case 'sink-river':
      return done ? `终点挨着${other()}` : `终点挨着${other()}（黄色）`;
    case 'old-flowing':
      return null;
    default:
      return null;
  }
}

// 地图上现在的河里 cells 这些格上的那几段：黄色（改道后还有水的旧河道）
function yellowRiverShapes(w: World, cells: ReadonlySet<number>): Shape[] {
  if (!cells.size) return [];
  const out: Shape[] = [];
  for (const line of riverLines(w)) for (const piece of splitRiverLine(line, cells, true)) out.push(...lineShapes(w, piece.points, { color: YELLOW_LINE, width: 2.5, dashed: true }));
  return out;
}

function overlapShapes(w: World, c: Course): Shape[] {
  const out: Shape[] = [];
  for (const o of c.overlaps ?? []) {
    if (o.points.length > 1) out.push(...lineShapes(w, o.points, { color: YELLOW_LINE, width: 4 }));
    if (o.kind === 'old-flowing') out.push(...yellowRiverShapes(w, new Set(o.cells)));
  }
  return out;
}

// 拖的时候算重叠分析，松手后顶部那句话里带上
function withOverlaps(w: World, c: Course): Course {
  if (!c.plan || !c.cmd || c.blocked) return c;
  const T = c.target;
  const self = T && !T.natural ? T.guide.id : null;
  // 分一股出去、加一个源头：干流（选中的那条河）挨着起笔处不算
  const own = T && (T.natural || c.kind === 'branch' || c.kind === 'source') ? T.own : undefined;
  const overlaps = overlapsOf(w, w.derived, c.plan, {
    lines: riverLines(w),
    self: c.kind === 'branch' || c.kind === 'source' ? (T && !T.natural ? T.guide.id : null) : self,
    ...(own ? { own } : {}),
    ...(c.kind === 'edit' && T ? { old: T.guide.cells } : {}),
  });
  if (!overlaps.length) return c;
  // 顶部只多说一句（最要紧的那处）；已经说了截走、碰到就汇入的不再说贴着
  const words = [...new Set(overlaps.map((o) => overlapWords(w, o, true)).filter((x): x is string => !!x))].slice(0, 1);
  let cmd = c.cmd;
  const c0 = c.cmd;
  const said = 'label' in c0 && typeof c0.label === 'string' ? c0.label : '';
  if (words.length && said && !/截走|删掉了|没穿过去/.test(said)) {
    const label = `${said} · ${words[0]}`.slice(0, 200);
    if (c0.op === 'batch') {
      const list = c0.commands;
      cmd = { ...c0, label, commands: list.map((x, k) => (k === list.length - 1 && 'label' in x ? ({ ...x, label } as Command) : x)) };
    } else cmd = { ...c0, label } as Command;
  }
  return { ...c, cmd, key: JSON.stringify(cmd), overlaps };
}

// 画好以后顶部说的话：画的时候汇入的那条河还没有名字（常常是新河的水加进去它才够大、才起了名字）时说的是“汇入一条河”，
// 换成改好的世界里河流列表说的（汇入「黄青河」）。不用换时为 null
export function namedDest(after: World, cmd: Command, known: ReadonlySet<string>, said: string): string | null {
  if (!said.includes('汇入一条河')) return null;
  const id = cmd.op === 'update_guide' ? cmd.id : cmd.op === 'add_guide' ? after.small.guides.find((g) => !known.has(g.id))?.id : undefined;
  const info = id ? riverInfo(after, { kind: 'guide', id }) : null;
  return info?.dest.startsWith('汇入「') ? said.replace('汇入一条河', info.dest) : null;
}

// 终点怎么说：画到陆地上接着流的是“之后顺地势入海”
function destOf(w: World, plan: CoursePlan, quotedName = true): string {
  const last = plan.cells.length - 1;
  if (plan.end === 'sink') return '停在这里';
  const where = destText(w, plan.end, plan.end === 'river' ? plan.join : plan.cells[last], quotedName);
  return plan.drawn < last ? `之后顺地势${where}` : where;
}

// ---------- 改哪条河：认河、控制点 ----------

// 一条河（画的河、自然的河的主干）当作改的对象：按世界缓存（自然的河按主干认，沿着同一条河移动鼠标不必重算）
const targetCache = new WeakMap<World, Map<string, EditTarget | null>>();
export function targetOf(w: World, ref: RiverRef): EditTarget | null {
  let m = targetCache.get(w);
  if (!m) targetCache.set(w, (m = new Map()));
  let key: string;
  if (ref.kind === 'guide') key = `g:${ref.id}`;
  else {
    const stem = stemOf(w, ref.cell).cells;
    if (stem.length < 2) return null;
    key = `n:${stem[0]}:${stem[stem.length - 1]}`;
  }
  if (m.has(key)) return m.get(key)!;
  let T: EditTarget | null = null;
  if (ref.kind === 'guide') {
    const g = guideOf(w, ref.id);
    T = g ? guideTarget(w, g) : null;
  } else {
    const stem = stemOf(w, ref.cell);
    T = naturalTarget(w, w.derived, ref.cell, stemNaming(w, stemFeature(w, stem.end === 'river' ? stem.cells.slice(0, -1) : stem.cells)));
  }
  m.set(key, T);
  return T;
}

// 选中的河的控制点（控制点的下标）：按缩放分档缓存
const handleCache = new WeakMap<EditTarget, { z: number; H: number[] }>();
export function handlesOf(T: EditTarget, zoom: number): number[] {
  const z = Math.round(Math.log2(zoom) * 4);
  const hit = handleCache.get(T);
  if (hit && hit.z === z) return hit.H;
  const zz = 2 ** (z / 4);
  const H = stickyHandles(T, z) ?? controlHandles(T, HANDLE_TOL_PX / zz, HANDLE_GAP_PX / zz);
  handleCache.set(T, { z, H });
  return H;
}

// 拖完控制点以后控制点不跳：记下拖的时候的那几个点（拖的那个换成松手的地方），改好的河上这些点都还在时照用
let sticky: { id: string; z: number; pts: [number, number][] } | null = null;
function stickyHandles(T: EditTarget, z: number): number[] | null {
  if (!sticky || T.natural || sticky.id !== T.guide.id || sticky.z !== z) return null;
  const P = T.points;
  const same = (a: readonly [number, number], b: readonly [number, number]) => Math.abs(a[1] - b[1]) < 2e-5 && Math.abs(a[0] - b[0] - 2 * Math.round((a[0] - b[0]) / 2)) < 2e-5;
  const out = new Set([0, P.length - 1]);
  for (const q of sticky.pts.slice(1, -1)) {
    const i = P.findIndex((p) => same(p, q));
    if (i < 0 || T.at[i] < 0) return null;
    out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

// 两个控制点之间的“+”在哪里
function plusAt(T: EditTarget, H: readonly number[], j: number): [number, number] {
  const P = T.points;
  const m = midHandle(T, H[j], H[j + 1]);
  if (m >= 0) return P[m];
  const a = P[H[j]];
  const b = P[H[j + 1]];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

// 两点之间的距离（地图单位；整个星球按经度就近比）
const near = (w: World, a: readonly [number, number], x: number, y: number) => {
  const dx = w.mesh.kind === 'sphere' ? x - a[0] - 2 * Math.round((x - a[0]) / 2) : x - a[0];
  return Math.hypot(dx, y - a[1]);
};

// 鼠标下是什么：选中的河的控制点（或“+”）、一条河（离线 14 个屏幕像素以内；选中的河优先），都不是时为 null。
// 悬停时说的、按下去以后做的都按它（同一个判定）
export type RiverPick =
  | { kind: 'handle'; ref: RiverRef; T: EditTarget; H: number[]; j: number; plus: boolean }
  | { kind: 'river'; ref: RiverRef; T: EditTarget; e: EditPoint; role: EditRole };

export function pick(w: World, x: number, y: number, cell: number, zoom: number): RiverPick | null {
  const tol = SNAP_PX / zoom;
  const sel = selectedRiver.value;
  const ST = sel ? targetOf(w, sel) : null;
  if (sel && ST) {
    const H = handlesOf(ST, zoom);
    const P = ST.points;
    let best: { j: number; plus: boolean; d: number } | null = null;
    H.forEach((i, j) => {
      const d = near(w, P[i], x, y);
      if (d <= HANDLE_PX / zoom && (!best || d < best.d)) best = { j, plus: false, d };
    });
    if (!best)
      for (let j = 0; j + 1 < H.length; j++) {
        const d = near(w, plusAt(ST, H, j), x, y);
        if (d <= PLUS_PX / zoom && (!best || d < best.d)) best = { j, plus: true, d };
      }
    if (best) {
      const b: { j: number; plus: boolean } = best;
      return { kind: 'handle', ref: sel, T: ST, H, j: b.j, plus: b.plus };
    }
    const e = editPoint(w, ST, x, y);
    if (e.d <= tol) return { kind: 'river', ref: sel, T: ST, e, role: editRole(e, tol) };
  }
  const hit = riverAt(w, x, y, tol, cell);
  if (!hit) return null;
  const T = targetOf(w, hit.ref);
  if (!T) return null;
  const e = editPoint(w, T, x, y);
  return { kind: 'river', ref: hit.ref, T, e, role: editRole(e, tol) };
}

// 拖终点时吸到别的河的线上（离线 tol 以内）：吸到的点；不在别的河旁边（或在这条河自己上）时为 null
function snapToOther(w: World, T: EditTarget, x: number, y: number, tol: number): [number, number] | null {
  if (editPoint(w, T, x, y).d <= tol) return null;
  const sphere = w.mesh.kind === 'sphere';
  let best: { p: [number, number]; d: number } | null = null;
  for (const g of w.small.guides) {
    if (!T.natural && g.id === T.guide.id) continue;
    const L = lineOf(w, g);
    const h = snapOnto(L.points, x, y, 0, L.points.length - 1, sphere);
    if (h && h.d <= tol && (!best || h.d < best.d)) best = h;
  }
  const own = new Set(T.own);
  for (const line of riverLines(w)) {
    if (line.guide !== undefined || line.points.length < 2) continue;
    const h = snapOnto(line.points, x, y, 0, line.points.length - 1, sphere);
    if (!h || h.d > tol || (best && h.d >= best.d)) continue;
    // 这条自然的河自己的线不算
    if (T.natural && line.cells && own.has(line.cells[h.k]) && own.has(line.cells[h.k + 1])) continue;
    best = h;
  }
  return best ? best.p : null;
}

// 控制点的样子：源头空心圆、终点实心圆、弯点小圆点，弯点之间淡淡的“+”。hot：鼠标停着的那个（大一点）
function handleShapes(w: World, T: EditTarget, H: readonly number[], zoom: number, hot: { j: number; plus: boolean } | null): Shape[] {
  const P = T.points;
  const out: Shape[] = [];
  const X = (x: number) => (w.mesh.kind === 'sphere' ? wrapX(x) : x);
  const dark = 'rgba(20, 28, 36, 0.75)';
  for (let j = 0; j + 1 < H.length; j++) {
    const [x, y] = plusAt(T, H, j);
    const big = hot?.plus && hot.j === j ? 1.3 : 1;
    const r = (5.5 * big) / zoom;
    out.push({ kind: 'circle', x: X(x), y, r, color: 'rgba(255, 255, 255, 0.75)', width: 1, fill: true });
    out.push({ kind: 'circle', x: X(x), y, r, color: dark, width: 1 });
    out.push({ kind: 'line', points: [[X(x) - r * 0.55, y], [X(x) + r * 0.55, y]], color: dark, width: 1.6 });
    out.push({ kind: 'line', points: [[X(x), y - r * 0.55], [X(x), y + r * 0.55]], color: dark, width: 1.6 });
  }
  H.forEach((i, j) => {
    const [x, y] = P[i];
    const big = hot && !hot.plus && hot.j === j ? 1.4 : 1;
    if (j === 0) {
      out.push({ kind: 'circle', x: X(x), y, r: (5.5 * big) / zoom, color: dark, width: 4.5 });
      out.push({ kind: 'circle', x: X(x), y, r: (5.5 * big) / zoom, color: 'rgba(255, 255, 255, 0.95)', width: 2.2 });
    } else {
      const r = ((j === H.length - 1 ? 5 : 3.6) * big) / zoom;
      out.push({ kind: 'circle', x: X(x), y, r, color: 'rgba(255, 255, 255, 0.95)', width: 1, fill: true });
      out.push({ kind: 'circle', x: X(x), y, r, color: dark, width: 1.2 });
    }
  });
  return out;
}

// 悬停在控制点上时说的话
function handleHint(h: Extract<RiverPick, { kind: 'handle' }>): string {
  if (h.plus) return '拖动：在这里加一个弯点';
  if (h.j === 0) return '拖动挪源头（往外接长，拖到河上往下游缩短）';
  if (h.j === h.H.length - 1) return '拖动挪终点（拖回河上缩短，拖到别的河上汇入，拖进海、湖里入海、入湖）';
  return '拖动改这一段 · 双击删掉这个弯点';
}

// 悬停在河上时：从这里起笔会怎样（接在“赤江 · 中等的河 · 入海”后面）
function roleHint(h: Extract<RiverPick, { kind: 'river' }>): string {
  const t =
    h.role === 'source'
      ? '从这里起笔：挪源头（往外画接长，画到河上缩短）'
      : h.role === 'end'
        ? '从这里起笔：往下游接长'
        : '从这里起笔：改这条河（画回河上只换这一段，画到别处从这里改道）';
  return h.T.natural ? `${t} · 改了以后它就固定下来` : t;
}

// ---------- 预览 ----------

// 执行后这条河画出来的样子（与地图上画的河同一个画法，见 core/rivers.ts 的 courseIndex）：照画出来的线（guideLine），流量按格；
// 入海、入湖画到进水的第一点为止；停在终点的最后一格收细到三成；汇入别的河时画到那条河的线上（cutAtJoin，与地图上相同）
function courseRiver(w: World, line: GuideLine, g: Guide, flow: readonly number[], self: string | null): { points: [number, number][]; flow: number[]; mul: number[]; cells: number[] } {
  const { points, cellIdx } = line;
  const width = g.width ?? 1;
  const out = { points: [] as [number, number][], flow: [] as number[], mul: [] as number[], cells: [] as number[] };
  for (let k = 0; k < points.length; k++) {
    const i = cellIdx[k];
    if (water(w, g.cells[i])) {
      if (i > 0 && out.points.length) {
        out.points.push(points[k]);
        out.flow.push(flow[i - 1]);
        out.mul.push(width);
        out.cells.push(g.cells[i - 1]);
      }
      break;
    }
    out.points.push(points[k]);
    out.flow.push(flow[i]);
    out.mul.push(width);
    out.cells.push(g.cells[i]);
  }
  if (g.end === 'sink') {
    const len = w.mesh.spacing;
    let s = 0;
    for (let k = out.points.length - 1; k >= 0 && s < len; k--) {
      out.mul[k] = width * (0.3 + (0.7 * s) / len);
      if (k > 0) s += Math.hypot(out.points[k][0] - out.points[k - 1][0], out.points[k][1] - out.points[k - 1][1]);
    }
    return out;
  }
  // 汇入别的河：画到那条河（地图上现在的线里经过汇合那格的，不是这条河自己的）的线上
  const L = g.cells[g.cells.length - 1];
  if (!water(w, L) && isRiverCell(w, w.derived, L) && out.cells[out.cells.length - 1] === L) {
    const other = riverLines(w).find((l) => (self === null || l.guide !== self) && l.cells && l.cells.indexOf(L) >= 0 && l.cells.indexOf(L) < l.cells.length - 1);
    if (other) cutAtJoin(out, L, (x, y) => projectNear(other, L, x, y, w.mesh.spacing, w.mesh.kind === 'sphere'));
  }
  return out;
}

// 地图上现在的河里，cells 这些格上的那几段画成灰色虚线（会变干的河段的影子）
function ghostShapes(w: World, cells: ReadonlySet<number>): Shape[] {
  if (!cells.size) return [];
  const out: Shape[] = [];
  for (const line of riverLines(w)) for (const piece of splitRiverLine(line, cells, true)) out.push(...lineShapes(w, piece.points, { color: GHOST_LINE, width: 2, dashed: true }));
  return out;
}

// 确切预览：停下来一会儿（delay 毫秒）后在 worker 里执行这条命令，算好后换上。同一个世界上同一条命令只算一次
// （底部条上拖“大小”、悬停“从这里往下去掉”、删除河湖用；画河、改河用将来的整个世界，见 riverTool）
class RiverExact {
  private wanted = '';
  private at: World | null = null;
  private sent = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private got: { key: string; at: World | null; r: PreviewResult } | null = null;
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

// 确切结果里的变化：红色是不再是河的格
function exactLayers(x: PreviewResult): HighlightLayer[] {
  return [{ cells: x.riverRemoved, color: RED, alpha: 0.8 }];
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

// 还没有确切结果时估计会变干的格：这条河原来的河道里不再是它的、截走的河的下游、改道后原来的下游
function goneEstimate(c: Course): Set<number> {
  const plan = c.plan;
  const gone = new Set<number>([...(c.edit?.dropped ?? []), ...(plan?.crossings.flatMap((k) => k.dried) ?? []), ...(plan?.dried ?? [])]);
  for (const k of c.after?.cells ?? []) gone.delete(k);
  return gone;
}

// 改掉的那段（缩短、改道后原来的下游）还有别的河流进来：它还是河，会成为另一条河（另起名字）。有确切结果时按它
function leftoverFed(w: World, c: Course, ex: ExactView | null): boolean {
  const dropped = c.edit?.dropped ?? [];
  if (!dropped.length) return false;
  const d = w.derived;
  if (ex) {
    const removed = new Set(ex.result.riverRemoved);
    return dropped.some((x) => isRiverCell(w, d, x) && !removed.has(x));
  }
  const D = new Set(dropped);
  const own = new Set(c.after?.cells ?? []);
  const { mesh } = w;
  for (const x of dropped)
    for (let e = mesh.off[x]; e < mesh.off[x + 1]; e++) {
      const j = mesh.adj[e];
      if (d.receiver[j] === x && !D.has(j) && !own.has(j) && isRiverCell(w, d, j)) return true;
    }
  return false;
}

// 一笔河、改一条河的预览图形。确切的将来世界到了（ex）：地图按它画所有的河，这里只画会变干的河段的影子（灰色虚线）、
// 改的这条河的白色虚线标记、汇入处的白圈；还没到：改的这条河立刻按将来的样子画（与地图同一套画法），原来的样子先不画
// （riverStyleOverride），估计会变干的河段（原来的河道、截走的河的下游）画成灰色虚线
function courseShapes(w: World, c: Course, ex: ExactView | null, zoom: number, line: GuideLine): Shape[] {
  const shapes: Shape[] = [];
  if (!c.after) return lineShapes(w, c.raw, { color: RED_LINE, width: 2, dashed: true });
  const plan = c.plan;
  const own = new Set(c.after.cells);
  const self = c.target && !c.target.natural ? c.target.guide.id : null;
  const r = courseRiver(w, line, c.after, c.estimate, self);
  if (ex) {
    const gone = new Set(ex.result.riverRemoved.filter((k) => !own.has(k)));
    shapes.push(...ghostShapes(w, gone));
  } else {
    shapes.push(...ghostShapes(w, goneEstimate(c)));
    if (r.points.length > 1) shapes.push({ kind: 'river', points: r.points, flow: r.flow, mul: r.mul, arrow: c.after.end !== 'sink', riverType: riverTypeOfGuide(w, c.after) });
  }
  // 白色虚线标记：将来的世界到了时地图自己画（与松手后一样），这里不再叠一道；没能照画的走时黄色
  if (!ex || c.edit?.note) shapes.push(...lineShapes(w, line.points, { color: c.edit?.note ? YELLOW_LINE : WHITE_LINE, width: c.edit?.note ? 2 : 1.2, dashed: true }));
  if (plan?.cut) shapes.push(...lineShapes(w, plan.cut, { color: 'rgba(205, 205, 205, 0.85)', width: 2, dashed: true }));
  const tail = r.points[r.points.length - 1];
  if (plan?.end === 'river' && tail) shapes.push(ringAt(w, tail[0], tail[1], 7 / zoom, 2));
  if (c.after.end === 'sink' && tail) shapes.push(ringAt(w, tail[0], tail[1], 4 / zoom, 1.5));
  return shapes;
}

// 拖动时鼠标旁的一句话：名字 · 怎么改 · 流到哪 · 多长，会截走的河、没能照画的走的原因；还在估计时末尾“…”
function courseHint(w: World, c: Course, ex: ExactView | null, line: GuideLine, alt: boolean): { text: string; warn?: boolean; caution?: boolean } {
  if (c.blocked || !c.plan || !c.after) return { text: c.blocked ?? '这里画不出河', warn: true };
  const plan = c.plan;
  const self = c.target && !c.target.natural ? c.target.guide.id : null;
  const parts: string[] = [];
  const name = ex?.result.guide?.name || c.name;
  if (c.kind === 'edit' && c.edit) {
    const what: Record<RiverEdit['kind'], string> = {
      splice: '重画这一段',
      reroute: '从这里改道',
      extend: '往下游接长',
      source: '挪源头',
      shorten: '缩短，停在这里',
      bend: '改这一段',
    };
    parts.push(quoted(name, c.target?.natural ? '这条河' : '这条画的河'), what[c.edit.kind]);
    if (c.edit.kind !== 'shorten' && c.edit.kind !== 'splice' && c.edit.kind !== 'bend' && c.edit.kind !== 'source') parts.push(c.after.end === 'sink' ? '停在这里' : destOf(w, plan));
  } else if (c.kind === 'branch' || c.kind === 'source') {
    parts.push(quoted(c.name, '这条河'), c.kind === 'branch' ? `分一股出去（约 ${Math.round(BRANCH_SHARE * 100)}% 的水）` : '加一个源头（同一条河）');
    if (c.kind === 'branch') parts.push(destOf(w, plan));
    parts.push(`${km(pathKm(w, line.points)).toLocaleString()} km`);
  } else {
    parts.push(name || '新河', c.kind === 'merge' ? '往上游接长' : destOf(w, plan));
    parts.push(`${km(pathKm(w, line.points)).toLocaleString()} km`);
  }
  // 要留意的只说一句（最要紧的那件）：截走别的河 > 碰到画的河就汇入（没穿过去） > 改不了的原因 > 重叠（黄色那段） > 往高处流 > 下面那段还有水。
  // 截走与“贴着它”不同时说（不再一边说截走、一边说离远一点）
  const cap = captureWords(w, plan, c.after, self, false);
  const notes = [
    cap ? (alt ? cap : `${cap}：横穿过去了（按住 Alt 松手改为汇入）`) : '',
    touchWords(w, plan, false),
    c.edit?.note ?? '',
    ...(c.overlaps ?? []).map((o) => (cap && o.kind === 'alongside' ? null : overlapWords(w, o, false))),
    plan.uphill >= 20 ? `有一段往高处流（${meters(plan.uphill)}）` : '',
    // 缩短、改道后原来的下游（改一段时换下来的那一小段不说）
    c.edit && (c.edit.kind === 'shorten' || c.edit.kind === 'reroute') && leftoverFed(w, c, ex) ? '下面那段还有支流的水，会成为另一条河' : '',
  ].filter((x): x is string => !!x);
  const caution = notes.length > 0;
  if (caution) parts.push(notes[0]);
  const gorge = ex ? ex.result.carved.maxDrop : plan.gorge;
  let deep = false;
  if (gorge >= DEEP_GORGE) {
    // 挖得很深（往往是一小段拖过了山）：黄色提醒，不拦着
    parts.push(`这一段要穿山挖很深（约 ${Math.round(gorge / 100) * 100} m${ex ? '，褐色的格' : ''}）`);
    deep = true;
  } else if (gorge >= 100) parts.push(`穿山挖出峡谷（最深${meters(gorge)}${ex ? '，褐色的格' : ''}）`);
  if (c.target?.natural) parts.push('改了以后它就固定下来');
  let text = parts.join(' · ');
  // 汇入的河在改好的世界里才有名字时，与松手后顶部说的用同一个办法换上（namedDest）
  if (ex && c.cmd) text = namedDest(ex.world, c.cmd, new Set(w.small.guides.map((g) => g.id)), text) ?? text;
  // 还在估计、汇入的河还没有名字时不说“汇入一条河”（松手后会写出名字）：等算好了再说汇入哪条
  if (!ex) text = text.replace('之后顺地势汇入一条河', '之后顺地势流下去').replace(' · 汇入一条河', '').replace('汇入一条河', '汇入别的河');
  return { text: ex ? text : `${text}…`, ...(caution || deep ? { caution: true } : {}) };
}

// ---------- 底部条上改一条河时的预览（拖大小、悬停“从这里往下去掉”） ----------

export interface RiverBarPreview {
  key: string;
  cmd: Command;
  // 改完后的河道；估计的每格流量
  after: Guide;
  estimate: number[];
}
const riverBarPreview = signal<RiverBarPreview | null>(null);
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

// 固定一条自然的河（downFrom：只固定到这一格为止，停在这里，下游的水没了）：沿用它的地名键，名字、颜色不变
export function pinCommand(w: World, cell: number, downFrom = false): { cmd: Command; after: Guide; estimate: number[] } | null {
  const stem = stemOf(w, cell);
  const i = stem.cells.indexOf(cell);
  const cells = downFrom ? stem.cells.slice(0, i + 1) : stem.cells;
  if (cells.length < 2 || i < 0) return null;
  const own = stem.end === 'river' ? stem.cells.slice(0, -1) : stem.cells;
  const f = stemFeature(w, own);
  // 名字、按规则成了哪一种河都记下（固定以后不因为别处的改动换名字、换类型）
  const type = ruleTypeOf(w, w.derived, own);
  const guide = {
    cells,
    path: stemPath(w, cells),
    locked: true,
    spring: false,
    ...stemNaming(w, f),
    ...(downFrom ? { end: 'sink' as const } : {}),
    ...(type ? { type } : {}),
  };
  const name = quoted(f?.name || null, '一条河');
  const label = downFrom
    ? `${name}从这里往下去掉了（约 ${km(pathKm(w, centrePoints(w, stem.cells.slice(i))))} km）`
    : `固定了${name}（约 ${km(pathKm(w, centrePoints(w, cells)))} km）`;
  return { cmd: { op: 'add_guide', guide, label }, after: { id: '', ...guide } as Guide, estimate: cells.map((c) => w.derived.discharge[c]) };
}

// “从这里往下去掉”：点了按钮以后在选中的自然的河上点一下选位置（悬停时预览）
export const riverCutPick = signal(false);

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
  const r = courseRiver(w, line, b.after, flow, b.after.id || null);
  const shapes: Shape[] = [];
  if (r.points.length > 1) shapes.push({ kind: 'river', points: r.points, flow: r.flow, mul: r.mul, riverType: riverTypeOfGuide(w, b.after) });
  if (b.after.end === 'sink' && r.points.length) {
    const [tx, ty] = r.points[r.points.length - 1];
    shapes.push(ringAt(w, tx, ty, 4 / zoom, 1.5));
  }
  return { layers: x ? exactLayers(x) : [], shapes, hint: null };
}

// ---------- 画河工具 ----------

interface Press {
  // flow：顺地势画新河；course：自定义走向画新河；edit：从一条河上起笔重画一笔；handle：拖选中的河的控制点；
  // extra：按了“分一股出去”“加一个源头”以后从选中的河上起笔画（mode 是哪一样）
  kind: 'flow' | 'course' | 'edit' | 'handle' | 'extra';
  mode?: 'branch' | 'source';
  start: Pointer;
  // 按下时鼠标下是什么（edit、handle 时有）
  hit: RiverPick | null;
  // 画的线（地图单位；整个星球上连续展开）。edit：第一点吸在河上
  pts: [number, number][];
  // 上一个记下的点在屏幕上的位置
  last: [number, number];
  // 出了平面地图：不再记点
  out: boolean;
  // 顺地势拖过的格
  cells: number[];
  moved: boolean;
  // 拖控制点：拖到哪里（拖终点时吸到别的河的线上）
  to: [number, number] | null;
  alt: boolean;
  // 按下时的世界：之后世界换了（上一笔改完了）要按新的世界重新认河（retarget），不拿旧的河去改
  world: World;
  // 重新认河没认出来：这一笔不改
  lost?: boolean;
}

export function riverTool(zoom: () => number): ToolHandler {
  let pointer: Pointer | null = null;
  let press: Press | null = null;
  let committing: { course: Course | null; flow: RiverPlan | null } | null = null;
  let flowCache: { key: string; plan: RiverPlan } | null = null;
  let courseCache: { key: string; course: Course; line: GuideLine | null; shapes: Map<string, Shape[]> } | null = null;
  // 确切的将来世界（停一下后在 worker 里算；指针一动就停下正在算的，不排队）
  const ex = new Exact();
  // 上一次点在弯点上（双击删掉它）
  let lastTap: { at: number; key: string } | null = null;

  // ---- 顺地势画新河 ----
  const flowPlan = (w: World, cells: number[]): RiverPlan | null => {
    if (!cells.length) return null;
    const key = `${worldId(w)}|${cells.join(',')}`;
    if (flowCache?.key !== key) flowCache = { key, plan: planRiver(w, w.derived, cells) };
    return flowCache.plan;
  };
  const flowLen = (w: World, p: RiverPlan) => km(p.cells.length * w.mesh.spacing * w.kmPerUnit);
  // 松手后执行的命令（确切预览用的也是它）：存下折线（与固定自然的河一样的线），所以也有“粗细”，整条是河
  const flowCommand = (w: World, p: RiverPlan): Command => {
    const where = p.end ? `，${destText(w, p.end, p.end === 'river' ? p.join : p.cells[p.cells.length - 1])}` : '';
    const guide = { cells: p.cells, path: stemPath(w, p.cells), locked: true, spring: true, flow: options.value.riverFlow, name: '', ...chosenRiverType(w) };
    return { op: 'add_guide', guide, label: `画了一条河（约 ${flowLen(w, p)} km${where}）` };
  };
  // 估计的流量（松手后的样子）：源头有泉水，选的大小沿路平均加进来
  const flowOf = (w: World, p: RiverPlan): number[] => springProfile(w, p.cells, true, options.value.riverFlow).map((q, k) => w.derived.discharge[p.cells[k]] + q);
  const flowShapes = (w: World, p: RiverPlan, live: boolean): Shape[] => {
    const { mesh } = w;
    const color = p.blocked ? RED_LINE : p.same ? 'rgba(210, 210, 210, 0.85)' : undefined;
    const shapes: Shape[] = [];
    if (p.cells.length > 1) {
      const pts = centrePoints(w, p.cells);
      const q = flowOf(w, p);
      const line = smoothCourse(
        pts,
        pts.map((_, k) => q[!water(w, p.cells[k]) ? k : Math.max(0, k - 1)]),
        mesh.spacing,
      );
      if (live) shapes.push({ kind: 'river', points: line.points, flow: line.flow, color, arrow: true, riverType: riverTypeOfGuide(w, chosenRiverType(w) as { type?: string }) });
      shapes.push(...lineShapes(w, line.points, { color: WHITE_LINE, width: 1.2, dashed: true }));
    }
    if (p.end === 'river') shapes.push(ringAt(w, mesh.x[p.join], mesh.y[p.join], 7 / zoom(), 2));
    return shapes;
  };
  const flowPreview = (w: World, cells: number[], exact: boolean): Preview => {
    const p = flowPlan(w, cells);
    if (!p) return EMPTY;
    if (p.reroute) return { layers: [], shapes: [], hint: '这里已经有河：按住往外画是改这条河', warn: true };
    const len = flowLen(w, p);
    const where = destText(w, p.end, p.end === 'river' ? p.join : p.cells[p.cells.length - 1]);
    if (p.blocked) return { layers: [], shapes: flowShapes(w, p, true), hint: p.blocked, warn: true };
    if (p.same) return { layers: [], shapes: flowShapes(w, p, true), hint: '河本来就这么流', warn: true };
    let view: ExactView | null = null;
    if (exact && p.cells.length > 1) {
      const cmd = flowCommand(w, p);
      const key = JSON.stringify(cmd);
      ex.want(key, () => cmd, 150);
      const v = ex.view;
      view = v && v.key === key ? v : null;
    }
    return { layers: [], shapes: flowShapes(w, p, !view), hint: `→ ${where} · ${len} km${exact && !view ? '…' : ''}`, world: view?.world ?? null };
  };

  // ---- 自定义走向画新河、改一条河：按笔画的点数、拖到的点缓存 ----
  // 世界换了（上一笔改完了，比如自然的河刚固定成了一条画的河）：按新的世界在起笔的地方重新认河。
  // 认出来的不是同一种（控制点、河）时为 false：这一笔不改（绝不拿旧的河再新建一条）
  // 自然的河改了一笔以后固定成了哪条画的河（主干的两头 → 河道 id）：排着队的下一笔按它认，不靠位置猜
  const replaced = new Map<string, string>();
  const stemKey = (T: EditTarget) => `${T.guide.cells[0]}:${T.guide.cells[T.guide.cells.length - 1]}`;
  // 世界换了以后，原来要改的那条河现在是哪条：画的河还在就是它；自然的河刚固定成了画的河时是那条画的河；
  // 还是自然的河（别的笔没改它）时是同一条主干。都不是时为 null（不拿旁边别的河凑数）
  const resolveRiver = (w: World, old: RiverPick): RiverRef | null => {
    if (old.ref.kind === 'guide') return guideOf(w, old.ref.id) ? old.ref : null;
    const id = replaced.get(stemKey(old.T));
    if (id) return guideOf(w, id) ? { kind: 'guide', id } : null;
    // 别处固定了它（比如点了“固定这条河”）：沿用它的地名键的、或者河道里有它原来的格六成以上的那条画的河
    const own = old.T.own;
    const key = old.T.guide.nameKey;
    const pinned = w.small.guides.find((g) => {
      if (key !== undefined && g.nameKey === key) return true;
      const set = new Set(g.cells);
      return own.filter((c) => set.has(c)).length >= 0.6 * own.length;
    });
    if (pinned) return { kind: 'guide', id: pinned.id };
    const T = targetOf(w, old.ref);
    return T && stemKey(T) === stemKey(old.T) ? old.ref : null;
  };

  // 世界换了（上一笔改完了，比如自然的河刚固定成了一条画的河）：按新的世界重新认河。
  // 拖源头、终点按“这条河的第一个、最后一个点”认（总认得出）；弯点、“+”找新的河上离起笔最近的（几个像素以内）；
  // 从河上起笔按起笔的地方认。认不出来时为 false：这一笔不改（绝不拿旧的河再新建一条），提示一声
  const retarget = (w: World, pr: Press): boolean => {
    if (pr.lost) return false;
    if (pr.world === w) return true;
    pr.world = w;
    if (pr.kind !== 'edit' && pr.kind !== 'handle' && pr.kind !== 'extra') return true;
    if (pr.kind === 'extra' && !pr.hit) return true;
    const old = pr.hit;
    const lose = () => {
      pr.lost = true;
      return false;
    };
    if (!old) return lose();
    if (pr.kind === 'handle' && old.kind === 'handle') {
      const ref = resolveRiver(w, old);
      const T = ref ? targetOf(w, ref) : null;
      if (!ref || !T) return lose();
      const z = zoom();
      const H = handlesOf(T, z);
      let j = -1;
      if (!old.plus && old.j === 0) j = 0;
      else if (!old.plus && old.j === old.H.length - 1) j = H.length - 1;
      else {
        let bd = (HANDLE_PX + 4) / z;
        for (let k = 0; k < H.length - (old.plus ? 1 : 0); k++) {
          if (!old.plus && (k === 0 || k === H.length - 1)) continue;
          const d = near(w, old.plus ? plusAt(T, H, k) : T.points[H[k]], pr.start.x, pr.start.y);
          if (d <= bd) [j, bd] = [k, d];
        }
      }
      if (j < 0 || H.length < 2) return lose();
      pr.hit = { kind: 'handle', ref, T, H, j, plus: old.plus };
      return true;
    }
    // 从河上起笔：还是认原来那条河（画的河、刚固定成的画的河），起笔点投影到它上面
    const ref = resolveRiver(w, old);
    const T = ref ? targetOf(w, ref) : null;
    if (!ref || !T) return lose();
    const e = editPoint(w, T, pr.start.x, pr.start.y);
    if (e.d > (2 * SNAP_PX) / zoom()) return lose();
    const h: RiverPick = { kind: 'river', ref, T, e, role: editRole(e, SNAP_PX / zoom()) };
    pr.hit = h;
    pr.pts[0] = [w.mesh.kind === 'sphere' ? h.e.p[0] + 2 * Math.round((pr.pts[0][0] - h.e.p[0]) / 2) : h.e.p[0], h.e.p[1]];
    return true;
  };

  const courseNow = (w: World, pr: Press): { course: Course; line: GuideLine | null; shapes: Map<string, Shape[]> } => {
    const o = options.value;
    if (!retarget(w, pr)) {
      courseCache = { key: '', course: blocked(LOST, pr.pts.slice()), line: null, shapes: new Map() };
      return courseCache;
    }
    const tail = pr.pts[pr.pts.length - 1];
    const ref = pr.hit ? (pr.hit.ref.kind === 'guide' ? pr.hit.ref.id : pr.hit.T.guide.cells[0]) : '';
    const key = `${worldId(w)}|${pr.kind}${pr.mode ?? ''}|${ref}|${pr.pts.length}|${tail[0]},${tail[1]}|${pr.to?.join(',') ?? ''}|${o.riverEnd}|${o.riverFlow}|${pr.alt ? 1 : 0}|${zoom()}`;
    if (courseCache?.key === key) return courseCache;
    const z = zoom();
    const eo = { endOnLand: o.riverEnd, px: 1 / z, tol: SNAP_PX / z };
    let course: Course;
    const h = pr.hit;
    if (pr.kind === 'handle' && h?.kind === 'handle' && pr.to) {
      const r = h.plus ? insertHandle(w, w.derived, h.T, h.H, h.j, pr.to) : dragHandle(w, w.derived, h.T, h.H, h.j, pr.to, eo);
      const how: EditHow = h.plus ? 'plus' : h.j === 0 ? 'source' : h.j === h.H.length - 1 ? 'end' : 'bend';
      course = editCourse(w, h.T, h.ref, r, [h.T.points[h.H[h.j]], pr.to], how);
      const pts = h.H.map((i) => h.T.points[i]);
      if (h.plus) pts.splice(h.j + 1, 0, pr.to);
      else pts[h.j] = pr.to;
      course.sticky = pts;
    } else if (pr.kind === 'edit' && h?.kind === 'river') {
      let r = strokeEdit(w, w.derived, h.T, pr.pts, eo);
      if (pr.alt && !('blocked' in r)) r = joinAtFirst(w, w.derived, h.T, r);
      course = editCourse(w, h.T, h.ref, r, pr.pts.slice(), 'stroke');
    } else if (pr.kind === 'extra') {
      const mode = pr.mode ?? 'branch';
      if (h?.kind !== 'river') course = { ...blocked('从选中的这条河上起笔', pr.pts.slice()), kind: mode };
      else {
        const r = mode === 'branch' ? branchCourse(w, w.derived, h.T, pr.pts, { endOnLand: o.riverEnd, px: 1 / z }) : sourceCourse(w, w.derived, h.T, pr.pts, { px: 1 / z });
        course = extraCourse(w, h.T, h.ref, r, pr.pts.slice(), mode);
      }
    } else {
      let plan = planCourse(w, w.derived, pr.pts, { endOnLand: o.riverEnd, px: 1 / z });
      // 按住 Alt：在第一次碰到的河那里汇入（不截走它）
      if (pr.alt && !plan.blocked && plan.crossings.length) plan = endCourseAt(w, w.derived, plan, plan.crossings[0].from);
      course = newCourse(w, plan, pr.pts.slice());
    }
    course = withOverlaps(w, course);
    courseCache = { key, course, line: course.after ? tempLine(w, course.after) : null, shapes: new Map() };
    // 分一股出去、加一个源头：选中的那条河照样画着（它不变，只是少了、多了一股水）
    if (!committing) hideFor(pr.kind === 'extra' ? null : pr.hit, course);
    return courseCache;
  };

  // 拖的时候地图上先不画的：改着的这条河原来的样子（画的河按 id；自然的河按它主干上的格），
  // 估计会变干的河段（截走的河的下游、原来的下游；画成灰色虚线的影子）。内容没变时不换（换了要重描所有的河）
  let hideKey = '';
  const hideFor = (h: RiverPick | null, c: Course | null) => {
    const T = h?.T;
    const cells = new Set<number>([...(T?.natural ? T.own : []), ...(c?.after ? goneEstimate(c) : [])]);
    const key = `${T && !T.natural ? T.guide.id : ''}|${[...cells].sort((a, b) => a - b).join(',')}`;
    if (key === hideKey && riverStyleOverride.value) return;
    hideKey = key;
    const withCells = cells.size ? { cells } : {};
    riverStyleOverride.value = T && !T.natural ? { id: T.guide.id, hide: true, ...withCells } : cells.size ? { id: '', ...withCells } : null;
  };


  const coursePreview = (w: World, c: Course, line: GuideLine | null, alt: boolean, fetch: boolean, shapesMemo?: Map<string, Shape[]>): Preview => {
    if (fetch && c.cmd) ex.want(c.key, () => c.cmd, 150);
    const v = ex.view;
    const view = v && c.cmd && v.key === c.key ? v : null;
    if (!line || !c.after) return { layers: [], shapes: lineShapes(w, c.raw, { color: RED_LINE, width: 2, dashed: true }), hint: c.blocked ?? '这里画不出河', warn: true };
    const sk = view ? 'x' : 'e';
    let shapes = shapesMemo?.get(sk);
    if (!shapes) {
      shapes = [...courseShapes(w, c, view, zoom(), line), ...overlapShapes(w, c)];
      shapesMemo?.set(sk, shapes);
    }
    const h = courseHint(w, c, view, line, alt);
    // 挖出的河床（峡谷）在地图上标出来（不只写在提示里）
    const layers: HighlightLayer[] = view && view.result.carved.cells.length ? [{ cells: view.result.carved.cells, color: CARVED, alpha: 0.45 }] : [];
    return { layers, shapes, hint: h.text, warn: h.warn, caution: h.caution, world: view?.world ?? null };
  };

  // 执行；改的这条河（自然的河固定下来以后是那条画的河）选中着
  const commit = async (c: Course) => {
    if (!c.cmd) return;
    // 正在算的就是这一条：worker 算完直接采用；还在等计时器的不要了
    ex.stop();
    cancelPreviews();
    committing = { course: c, flow: null };
    try {
      const w = world.value;
      const known = new Set(w?.small.guides.map((g) => g.id) ?? []);
      const busyText = c.kind === 'edit' ? '正在改河…' : '正在计算河流…';
      const ok = await exec(c.cmd, busyText, undefined, (after, said) => namedDest(after, c.cmd!, known, said));
      if (ok && (c.kind === 'branch' || c.kind === 'source')) {
        riverAddMode.value = null;
        if (c.selectAfter && world.value?.small.guides.some((g) => g.id === c.selectAfter)) selectedRiver.value = { kind: 'guide', id: c.selectAfter };
      }
      if (ok && c.kind === 'edit') {
        const id = c.cmd.op === 'update_guide' ? c.cmd.id : world.value?.small.guides.find((g) => !known.has(g.id))?.id;
        if (id && world.value?.small.guides.some((g) => g.id === id)) {
          if (c.target?.natural) replaced.set(stemKey(c.target), id);
          selectedRiver.value = { kind: 'guide', id };
          sticky = c.sticky ? { id, z: Math.round(Math.log2(zoom()) * 4), pts: c.sticky } : null;
        }
      }
    } finally {
      committing = null;
      ex.clear();
      courseCache = null;
      hideKey = '';
      riverStyleOverride.value = null;
      redrawTick.value++;
    }
    await drain();
  };

  // 上一笔还在算时画的下一笔：排着队，上一笔改完后按改好的世界重新认河、重新算，接着改（不丢掉）
  const queued: Press[] = [];
  const drain = async () => {
    const pr = queued.shift();
    const w = world.value;
    if (!pr || !w) return;
    if (pr.kind === 'flow') return flowUp(w, pr.cells);
    if (!retarget(w, pr)) {
      showToast(LOST, true);
      return drain();
    }
    courseCache = null;
    const { course } = courseNow(w, pr);
    if (!course.cmd || course.blocked) {
      riverStyleOverride.value = null;
      showToast(course.blocked ?? '这里画不出河', true);
      return drain();
    }
    await commit(course);
  };

  const runFlow = async (w: World, p: RiverPlan) => {
    committing = { course: null, flow: p };
    ex.stop();
    cancelPreviews();
    try {
      const cmd = flowCommand(w, p);
      const known = new Set(w.small.guides.map((g) => g.id));
      await exec(cmd, '正在计算河流…', undefined, (after, said) => namedDest(after, cmd, known, said));
    } finally {
      committing = null;
      ex.clear();
      redrawTick.value++;
    }
    await drain();
  };

  const flowUp = async (w: World, cells: number[]) => {
    const p = flowPlan(w, cells);
    if (water(w, cells[0])) return showToast('河要从陆地上开始', true);
    if (p?.reroute) return showToast('这里已经有河：按住往外画是改这条河', true);
    if (!p || p.cells.length < 2) return showToast('这里画不出河', true);
    if (p.blocked) return showToast(p.blocked, true);
    if (p.same) return showToast('河本来就这么流，没有改');
    await runFlow(w, p);
  };

  // 点一下（没拖开）：点在控制点上什么都不做（双击弯点删掉它）；点在河上选中它；选着一条河时点别处只是取消选择；
  // 否则顺地势在这里点源头起一条河，自定义走向不放河（要按住拖出河道）
  const click = async (w: World, pr: Press) => {
    const p = pr.start;
    const h = pr.hit;
    if (pr.kind === 'extra') return showToast(pr.mode === 'source' ? '从选中的河上起笔，往外画出新的源头（Esc 不加了）' : '从选中的河上起笔，往外画出分出去的一股（Esc 不分了）');
    if (h?.kind === 'handle') {
      if (h.plus || h.j === 0 || h.j === h.H.length - 1) return;
      const key = `${h.ref.kind === 'guide' ? h.ref.id : h.T.guide.cells[0]}|${h.H[h.j]}`;
      const now = performance.now();
      if (lastTap && lastTap.key === key && now - lastTap.at < DOUBLE_MS) {
        lastTap = null;
        const c = editCourse(w, h.T, h.ref, deleteHandle(w, w.derived, h.T, h.H, h.j), [], 'delete');
        if (c.blocked) return showToast(c.blocked, true);
        return commit(c);
      }
      lastTap = { at: now, key };
      return;
    }
    if (h) {
      selectedRiver.value = h.ref;
      return;
    }
    if (selectedRiver.value) {
      selectedRiver.value = null;
      return;
    }
    if (p.cell < 0) return;
    if (water(w, p.cell)) return showToast('河要从陆地上开始', true);
    if (options.value.riverMode === 'course') return showToast('按住拖动画一条河');
    await flowUp(w, [p.cell]);
  };

  // “从这里往下去掉”：鼠标下选中的那条自然的河上的一格（不在它上面时为 -1）
  const cutCell = (w: World, p: Pointer): number => {
    const sel = selectedRiver.value;
    if (sel?.kind !== 'natural') return -1;
    const T = targetOf(w, sel);
    if (!T) return -1;
    const e = editPoint(w, T, p.x, p.y);
    if (e.d > SNAP_PX / zoom()) return -1;
    // 投影点所在的格（是这条河的）；不是时取这条河上离它最近的一格
    const own = T.own.filter((c) => !water(w, c));
    const c = findCell(w.mesh, e.p[0], e.p[1], own[0]);
    if (own.includes(c)) return c;
    let best = -1;
    let bd = Infinity;
    for (const k of own) {
      const d = near(w, [w.mesh.x[k], w.mesh.y[k]], e.p[0], e.p[1]);
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    return best;
  };

  return {
    drags: true,
    down(p) {
      const w = world.value;
      // 上一笔还在算（committing）时照样能画下一笔：松手后排着队
      if (!w || (!committing && isBusy())) return;
      const mode = riverAddMode.value;
      const sel = selectedRiver.value;
      let h: RiverPick | null;
      let kind: Press['kind'];
      if (mode && sel) {
        // 分一股出去、加一个源头：从选中的河上起笔（第一点吸到河上）
        const ST = targetOf(w, sel);
        const tol = SNAP_PX / zoom();
        const e = ST ? editPoint(w, ST, p.x, p.y) : null;
        h = ST && e && e.d <= tol ? { kind: 'river', ref: sel, T: ST, e, role: editRole(e, tol) } : null;
        kind = 'extra';
      } else {
        h = riverCutPick.value ? null : pick(w, p.x, p.y, p.cell, zoom());
        kind = h?.kind === 'handle' ? 'handle' : h ? 'edit' : options.value.riverMode === 'course' ? 'course' : 'flow';
      }
      // 从河上起笔：第一点吸到河上（整个星球上挪回鼠标那一份）
      let s0: [number, number] = [p.x, p.y];
      if (h?.kind === 'river') {
        const sx = w.mesh.kind === 'sphere' ? h.e.p[0] + 2 * Math.round((p.x - h.e.p[0]) / 2) : h.e.p[0];
        s0 = [sx, h.e.p[1]];
      }
      press = { kind, ...(kind === 'extra' && mode ? { mode } : {}), start: p, hit: h, pts: [s0], last: [p.sx, p.sy], out: false, cells: [p.cell], moved: false, to: null, alt: p.alt, world: w };
      pointer = p;
      courseCache = null;
      if (!committing) ex.clear();
    },
    move(p, pressed) {
      pointer = p;
      const w = world.value;
      if (!w) return;
      // “从这里往下去掉”选位置：悬停时预览
      if (riverCutPick.value && !pressed) {
        const c = cutCell(w, p);
        const cut = c >= 0 ? pinCommand(w, c, true) : null;
        if (cut) previewRiverBar(cut.cmd, cut.after, cut.estimate);
        else clearRiverBarPreview();
        return;
      }
      const pr = press;
      if (!pressed || !pr) return;
      pr.alt = p.alt;
      // 手抖不算拖：在河上点一下是选中它
      if (!pr.moved && Math.hypot(p.sx - pr.start.sx, p.sy - pr.start.sy) > 6) {
        pr.moved = true;
        if ((pr.kind === 'edit' || pr.kind === 'handle') && !committing) hideFor(pr.hit, null);
        else if (pr.kind !== 'edit' && pr.kind !== 'handle' && pr.kind !== 'extra') selectedRiver.value = null;
      }
      if (!pr.moved) return;
      if (pr.kind === 'handle' && pr.hit?.kind === 'handle') {
        const h = pr.hit;
        // 拖终点：吸到别的河的线上（汇入它）
        const snapped = !h.plus && h.j === h.H.length - 1 ? snapToOther(w, h.T, p.x, p.y, SNAP_PX / zoom()) : null;
        pr.to = snapped ?? [p.x, p.y];
        return;
      }
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
      if (!w) return;
      if (committing) {
        if (pr?.moved && !riverCutPick.value) {
          pr.alt = p.alt;
          queued.push(pr);
          showToast('排着队：上一笔改完就接着改这一笔');
        }
        return;
      }
      if (riverCutPick.value) {
        const c = cutCell(w, p);
        const cut = c >= 0 ? pinCommand(w, c, true) : null;
        clearRiverBarPreview();
        if (!cut) return showToast('在选中的这条河上点一下，选从哪里往下去掉', true);
        riverCutPick.value = false;
        void execAndSelect(cut.cmd, '正在计算河流…');
        return;
      }
      if (!pr) return;
      pr.alt = p.alt;
      if (!pr.moved) return click(w, pr);
      if (pr.kind === 'flow') {
        ex.stop();
        return flowUp(w, pr.cells);
      }
      const { course: c } = courseNow(w, pr);
      if (!c.cmd || c.blocked || !c.plan) {
        ex.clear();
        cancelPreviews();
        hideKey = '';
        riverStyleOverride.value = null;
        courseCache = null;
        showToast(c.blocked ?? '这里画不出河', true);
        return;
      }
      await commit(c);
    },
    cancel() {
      press = null;
      queued.length = 0;
      courseCache = null;
      hideKey = '';
      ex.clear();
      cancelPreviews();
      riverStyleOverride.value = null;
      riverCutPick.value = false;
      riverAddMode.value = null;
      clearRiverBarPreview();
    },
    leave() {
      pointer = null;
    },
    // 鼠标离开地图后预览还留着：松手后还在算的那一笔（画河不排队：结果换上之前一直显示松手时的样子，不闪回原样）、底部条上的预览
    keep: () => !!committing || !!riverBarPreview.value,
    escape() {
      if (riverAddMode.value) {
        riverAddMode.value = null;
        return true;
      }
      if (!riverCutPick.value) return false;
      riverCutPick.value = false;
      clearRiverBarPreview();
      return true;
    },
    // 选中的河一直画着控制点（拖着的时候不画：画的是改好的样子）
    backdrop() {
      const w = world.value;
      const sel = selectedRiver.value;
      if (!w || !sel || committing || (press?.moved && (press.kind === 'edit' || press.kind === 'handle')) || riverCutPick.value) return null;
      const T = targetOf(w, sel);
      if (!T) return null;
      const z = zoom();
      const H = handlesOf(T, z);
      const at = !press && pointer && !riverAddMode.value ? pick(w, pointer.x, pointer.y, pointer.cell, z) : null;
      const hot = at?.kind === 'handle' ? { j: at.j, plus: at.plus } : null;
      return { layers: [], shapes: handleShapes(w, T, H, z, hot) };
    },
    preview() {
      const w = world.value;
      if (!w) return EMPTY;
      if (committing) {
        // 松手后还在算：一直画着松手时的样子（不闪回原样）；又画了下一笔时也画出来（排着队，不先算确切结果）
        const c = committing.course;
        let held: Preview;
        if (c) {
          const line = c.after ? tempLine(w, c.after) : null;
          held = { ...coursePreview(w, c, line, false, false), hint: '正在计算…' };
        } else {
          const v = ex.view;
          held = { layers: [], shapes: committing.flow ? flowShapes(w, committing.flow, !v) : [], hint: '正在计算…', world: v?.world ?? null };
        }
        const pr = press;
        if (!pr?.moved) return held;
        const next =
          pr.kind === 'flow'
            ? flowPreview(w, pr.cells, false)
            : (() => {
                const { course, line } = courseNow(w, pr);
                return coursePreview(w, course, line, pr.alt, false);
              })();
        return { ...held, shapes: [...held.shapes, ...next.shapes], hint: `排着队：${next.hint ?? ''}` };
      }
      const bar = riverBarPreview.value;
      if (bar && !press) return { ...barPreviewShapes(w, bar, zoom()), hint: riverCutPick.value ? '点一下：从这里往下去掉' : null };
      if (!pointer) return EMPTY;
      if (riverCutPick.value) return { layers: [], shapes: [], hint: '在选中的这条河上点一下：从那里往下去掉（Esc 不去掉了）' };
      const pr = press;
      if (pr?.moved) {
        if (pr.kind === 'flow') return water(w, pr.cells[0]) ? { layers: [], shapes: [], hint: '河要从陆地上开始', warn: true } : flowPreview(w, pr.cells, true);
        const { course, line, shapes } = courseNow(w, pr);
        return coursePreview(w, course, line, pr.alt, true, shapes);
      }
      // 按了“分一股出去”“加一个源头”：说从哪里起笔、会怎样
      const mode = riverAddMode.value;
      const sel = selectedRiver.value;
      if (mode && sel) {
        const at = pr?.start ?? pointer;
        const ST = targetOf(w, sel);
        const on = ST ? editPoint(w, ST, at.x, at.y).d <= SNAP_PX / zoom() : false;
        const what =
          mode === 'branch'
            ? `从这里起笔画出去：分一股水出去（约 ${Math.round(BRANCH_SHARE * 100)}%），画到海里、湖里、别的河上，也可以画回这条河的下游`
            : '从这里起笔往外画：画的另一头是新的源头，水流进这条河（同一条河、同一个名字）';
        return { layers: [], shapes: riverGlow(w, sel), hint: on ? what : `在选中的河上起笔（${mode === 'branch' ? '分一股出去' : '加一个源头'} · Esc 不${mode === 'branch' ? '分' : '加'}了）`, ...(on ? {} : { caution: true }) };
      }
      // 悬停（或按下还没拖开）：鼠标下的控制点、河亮一下，写出是哪条河、从这里起笔会怎样
      const at = pr?.start ?? pointer;
      const h = pr ? pr.hit : pick(w, at.x, at.y, at.cell, zoom());
      if (h?.kind === 'handle') return { layers: [], shapes: [], hint: handleHint(h) };
      if (h) {
        const info = riverInfo(w, h.ref);
        const label = info ? riverLabel(h.ref, info, at.cell) : null;
        const act = roleHint(h);
        return { layers: [], shapes: riverGlow(w, h.ref), hint: label ? `${label} · ${act}` : act };
      }
      // 选着一条河时点别处只是取消选择：不预览新河
      if (selectedRiver.value || at.cell < 0) return EMPTY;
      if (options.value.riverMode === 'flow' && !water(w, at.cell)) return flowPreview(w, [at.cell], false);
      return EMPTY;
    },
  };
}

// ---------- 删除河湖 ----------

// 删掉一条画的河：提示条写它的名字（预览与执行同一条命令，执行时直接采用预览）
function removeCmd(w: World, id: string): Command {
  const g = guideOf(w, id);
  return { op: 'remove_guide', id, label: `删掉了${quoted(g ? guideName(w, g) : null, '一条画的河')}` };
}

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
        await exec(t.kind === 'guide' ? removeCmd(w, t.id) : { op: 'remove_lake', id: t.id }, '正在计算…');
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
      const cmd: Command = removeCmd(w, t.id);
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

