import type { GeoFeature } from '../../../core/features';
import { type EditPoint, type EditRole, type EditTarget, controlHandles, editPoint, editRole, guideTarget, midHandle, naturalTarget } from '../../../core/river-edit';
import { type GuideLine, type RiverLine, centrePoints, guideLine, ownsCell, snapOnto } from '../../../core/rivers';
import { type CourseEnd, type GuideIssue, branchedOff, guideEnd, guideFlow, guideIssues, isRiverCell, riverStem } from '../../../core/select';
import type { Guide, World } from '../../../core/world';
import { riverLines } from '../../render/overlay';
import { type RiverRef, selectedRiver } from '../../state';
import { pathKm, riverSizeName } from '../tools';

// 认河与河的说明：鼠标下是哪条河、选中的河的控制点、一条河叫什么、多大、流到哪里（画河工具、河流列表、悬停卡片共用）

// 起笔吸到河上：离河的线几个屏幕像素以内（悬停发光、写名字，按下去改的就是它）
export const SNAP_PX = 14;
// 控制点：点中的范围、“+”点中的范围、控制点之间至少隔多远、化简的容差（屏幕像素）
export const HANDLE_PX = 9;
const PLUS_PX = 6;
const HANDLE_GAP_PX = 40;
const HANDLE_TOL_PX = 4;

// 水面（海、湖）
export const water = (w: World, c: number) => !w.causes.land[c] || w.derived.lake[c] === 1;

// ---------- 地名：每格在哪条有名字的河上、哪个湖里 ----------

interface FeatureIndex {
  rivers: Map<number, GeoFeature[]>;
  lakes: Map<number, GeoFeature>;
  guides: Map<string, GeoFeature>;
}
const featureCache = new WeakMap<World, FeatureIndex>();
export function featureIndex(w: World): FeatureIndex {
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
export const riverNameAt = (w: World, cell: number, not?: GeoFeature) => featureIndex(w).rivers.get(cell)?.find((f) => f !== not && f.name)?.name || null;
export const lakeNameAt = (w: World, cell: number) => featureIndex(w).lakes.get(cell)?.name || null;
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
export const meters = (m: number) => `约 ${(Math.max(50, Math.round(m / (m >= 1000 ? 100 : 50)) * (m >= 1000 ? 100 : 50))).toLocaleString()} m`;

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
export function tempLine(w: World, g: Guide): GuideLine {
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
export function guideAt(w: World, cell: number): Guide | undefined {
  for (let n = w.small.guides.length - 1; n >= 0; n--) {
    const g = w.small.guides[n];
    const k = g.cells.indexOf(cell);
    if (k >= 0 && ownsCell(g, k)) return g;
  }
  return undefined;
}


// 自然的河的主干（选中、悬停、固定时用），按世界、格缓存
const stemCache = new WeakMap<World, Map<number, ReturnType<typeof riverStem>>>();
export function stemOf(w: World, cell: number) {
  let m = stemCache.get(w);
  if (!m) stemCache.set(w, (m = new Map()));
  let s = m.get(cell);
  if (!s) m.set(cell, (s = riverStem(w, w.derived, cell)));
  return s;
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

// 画的河现在叫什么（没名字时为 null）
export const guideName = (w: World, g: Guide) => guideFeature(w, g.id)?.name || riverNameAt(w, g.cells[Math.floor(g.cells.length / 2)]) || null;

export const quoted = (name: string | null, fallback: string) => (name ? `「${name}」` : fallback);

// 一条自然的河的主干（自己的格）是哪条有名字的自然大河：主干上的格一半以上在那条河的地物里。没有时为 null
// （汇合处的小支流不会顶着大河的名字）
export function stemFeature(w: World, own: readonly number[]): GeoFeature | null {
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
export function stemNaming(w: World, f: GeoFeature | null): { nameKey: string; autoName?: string } | { name: string; autoName?: string } {
  if (!f) return { name: '' };
  const auto = f.name && !f.custom ? { autoName: f.name } : {};
  if (w.small.guides.some((g) => g.nameKey === f.key)) return { name: '', ...auto };
  return { nameKey: f.key, ...auto };
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
export const setSticky = (v: typeof sticky) => {
  sticky = v;
};
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
export function plusAt(T: EditTarget, H: readonly number[], j: number): [number, number] {
  const P = T.points;
  const m = midHandle(T, H[j], H[j + 1]);
  if (m >= 0) return P[m];
  const a = P[H[j]];
  const b = P[H[j + 1]];
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

// 两点之间的距离（地图单位；整个星球按经度就近比）
export const near = (w: World, a: readonly [number, number], x: number, y: number) => {
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
export function snapToOther(w: World, T: EditTarget, x: number, y: number, tol: number): [number, number] | null {
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
