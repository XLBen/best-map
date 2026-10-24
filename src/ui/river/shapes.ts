import type { PreviewResult } from '../../../core/engine';
import { wrapX } from '../../../core/geo';
import type { EditTarget } from '../../../core/river-edit';
import { type GuideLine, type RiverLine, cutAtJoin, projectNear } from '../../../core/rivers';
import { isRiverCell } from '../../../core/select';
import type { Guide, World } from '../../../core/world';
import type { HighlightLayer } from '../../render/colors';
import { type Shape, riverLines, splitRiverLine } from '../../render/overlay';
import type { RiverRef } from '../../state';
import type { RGB } from '../tools';
import type { Course } from './model';
import { plusAt, stemOf, water } from './query';

// 河的画法：选中、悬停的河的光，控制点，执行后这条河的样子，会变干、贴着别的河的河段

export const RED: RGB = [235, 80, 70];
export const RED_LINE = 'rgba(235, 80, 70, 0.95)';
export const WHITE_LINE = 'rgba(255, 255, 255, 0.85)';
// 会变干的河段：灰色虚线的影子
const GHOST_LINE = 'rgba(200, 200, 200, 0.9)';
// 没能照画的走的那段（比如中途进了海）：黄色
export const YELLOW_LINE = 'rgba(255, 210, 70, 0.95)';
// 选中、悬停的河：沿河一道淡黄的光
const GLOW = 'rgba(255, 226, 120, 0.5)';

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

export const lineShapes = (w: World, pts: readonly [number, number][], style: Omit<Shape, 'kind' | 'points'>): Shape[] =>
  wrappedLines(w, pts).map((points): Shape => ({ kind: 'line', points, ...style }));

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

// 地图上现在的河里 cells 这些格上的那几段：黄色（改道后还有水的旧河道）
export function yellowRiverShapes(w: World, cells: ReadonlySet<number>): Shape[] {
  if (!cells.size) return [];
  const out: Shape[] = [];
  for (const line of riverLines(w)) for (const piece of splitRiverLine(line, cells, true)) out.push(...lineShapes(w, piece.points, { color: YELLOW_LINE, width: 2.5, dashed: true }));
  return out;
}

export function overlapShapes(w: World, c: Course): Shape[] {
  const out: Shape[] = [];
  for (const o of c.overlaps ?? []) {
    if (o.points.length > 1) out.push(...lineShapes(w, o.points, { color: YELLOW_LINE, width: 4 }));
    if (o.kind === 'old-flowing') out.push(...yellowRiverShapes(w, new Set(o.cells)));
  }
  return out;
}

// 控制点的样子：源头空心圆、终点实心圆、弯点小圆点，弯点之间淡淡的“+”。hot：鼠标停着的那个（大一点）
export function handleShapes(w: World, T: EditTarget, H: readonly number[], zoom: number, hot: { j: number; plus: boolean } | null): Shape[] {
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

// 执行后这条河画出来的样子（与地图上画的河同一个画法，见 core/rivers.ts 的 courseIndex）：照画出来的线（guideLine），流量按格；
// 入海、入湖画到进水的第一点为止；停在终点的最后一格收细到三成；汇入别的河时画到那条河的线上（cutAtJoin，与地图上相同）
export function courseRiver(w: World, line: GuideLine, g: Guide, flow: readonly number[], self: string | null): { points: [number, number][]; flow: number[]; mul: number[]; cells: number[] } {
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
export function ghostShapes(w: World, cells: ReadonlySet<number>): Shape[] {
  if (!cells.size) return [];
  const out: Shape[] = [];
  for (const line of riverLines(w)) for (const piece of splitRiverLine(line, cells, true)) out.push(...lineShapes(w, piece.points, { color: GHOST_LINE, width: 2, dashed: true }));
  return out;
}

// 确切结果里的变化：红色是不再是河的格
export function exactLayers(x: PreviewResult): HighlightLayer[] {
  return [{ cells: x.riverRemoved, color: RED, alpha: 0.8 }];
}

// 圈画在哪里：整个星球上挪进 [0, 2)（画的线展开后可能伸出很远，平铺的副本只画 [0, 2) 附近的）
export const ringAt = (w: World, x: number, y: number, r: number, width: number): Shape => ({
  kind: 'circle',
  x: w.mesh.kind === 'sphere' ? wrapX(x) : x,
  y,
  r,
  color: 'rgba(255, 255, 255, 0.95)',
  width,
});
