import { type RiverEdit, BRANCH_SHARE } from '../../../core/river-edit';
import type { GuideLine } from '../../../core/rivers';
import { isRiverCell } from '../../../core/select';
import { roundKm as km } from '../../../core/terrain';
import type { World } from '../../../core/world';
import type { Shape } from '../../render/overlay';
import type { ExactView } from '../domain/exact';
import { pathKm } from '../tools';
import {
  type Course,
  DEEP_GORGE,
  captureWords,
  destOf,
  namedDest,
  overlapWords,
  riverTypeOfGuide,
  touchWords,
} from './model';
import { type RiverPick, meters, quoted } from './query';
import { RED_LINE, WHITE_LINE, YELLOW_LINE, courseRiver, ghostShapes, lineShapes, ringAt } from './shapes';

// 画河时一笔的说明与图形（第七十轮从 river/tool.ts 分出来）：悬停在控制点、河上时说的话，拖动时的图形与鼠标旁的一句话

// 悬停在控制点上时说的话
export function handleHint(h: Extract<RiverPick, { kind: 'handle' }>): string {
  if (h.plus) return '拖动加弯点';
  if (h.j === 0) return '拖动挪源头';
  if (h.j === h.H.length - 1) return '拖动挪终点';
  return '拖动改这一段 · 双击删除弯点';
}

// 悬停在河上时：从这里起笔会怎样（接在“赤江 · 中等的河 · 入海”后面）
export function roleHint(h: Extract<RiverPick, { kind: 'river' }>): string {
  const t =
    h.role === 'source'
      ? '从这里起笔：挪源头'
      : h.role === 'end'
        ? '从这里起笔：往下游接长'
        : '从这里起笔：改这一段或改道';
  return h.T.natural ? `${t} · 改后锁定` : t;
}

// 还没有确切结果时估计会变干的格：这条河原来的河道里不再是它的、截走的河的下游、改道后原来的下游
export function goneEstimate(c: Course): Set<number> {
  const plan = c.plan;
  const gone = new Set<number>([...(c.edit?.dropped ?? []), ...(plan?.crossings.flatMap((k) => k.dried) ?? []), ...(plan?.dried ?? [])]);
  for (const k of c.after?.cells ?? []) gone.delete(k);
  return gone;
}

// 改掉的那段（缩短、改道后原来的下游）还有别的河流进来：它还是河，会成为另一条河（另起名字）。有确切结果时按它
export function leftoverFed(w: World, c: Course, ex: ExactView | null): boolean {
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
export function courseShapes(w: World, c: Course, ex: ExactView | null, zoom: number, line: GuideLine): Shape[] {
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
export function courseHint(w: World, c: Course, ex: ExactView | null, line: GuideLine, alt: boolean): { text: string; warn?: boolean; caution?: boolean } {
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
      shorten: '缩短',
      bend: '改这一段',
    };
    parts.push(quoted(name, c.target?.natural ? '河' : '画的河'), what[c.edit.kind]);
    if (c.edit.kind !== 'shorten' && c.edit.kind !== 'splice' && c.edit.kind !== 'bend' && c.edit.kind !== 'source') parts.push(c.after.end === 'sink' ? '停在这里' : destOf(w, plan));
  } else if (c.kind === 'branch' || c.kind === 'source') {
    parts.push(quoted(c.name, '河'), c.kind === 'branch' ? `分出一股 · 约 ${Math.round(BRANCH_SHARE * 100)}% 的水` : '加源头');
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
    cap ? (alt ? cap : `${cap} · 按住 Alt 改为汇入`) : '',
    touchWords(w, plan, false),
    c.edit?.note ?? '',
    ...(c.overlaps ?? []).map((o) => (cap && o.kind === 'alongside' ? null : overlapWords(w, o, false))),
    plan.uphill >= 20 ? `一段往高处流 · ${meters(plan.uphill)}` : '',
    // 缩短、改道后原来的下游（改一段时换下来的那一小段不说）
    c.edit && (c.edit.kind === 'shorten' || c.edit.kind === 'reroute') && leftoverFed(w, c, ex) ? '下游还有水，会成为另一条河' : '',
  ].filter((x): x is string => !!x);
  const caution = notes.length > 0;
  if (caution) parts.push(notes[0]);
  const gorge = ex ? ex.result.carved.maxDrop : plan.gorge;
  let deep = false;
  if (gorge >= DEEP_GORGE) {
    // 挖得很深（往往是一小段拖过了山）：黄色提醒，不拦着
    parts.push(`穿山挖很深 · 约 ${Math.round(gorge / 100) * 100} m`);
    deep = true;
  } else if (gorge >= 100) parts.push(`峡谷最深${meters(gorge)}`);
  if (c.target?.natural) parts.push('改后锁定');
  let text = parts.join(' · ');
  // 汇入的河在改好的世界里才有名字时，与松手后顶部说的用同一个办法换上（namedDest）
  if (ex && c.cmd) text = namedDest(ex.world, c.cmd, new Set(w.small.guides.map((g) => g.id)), text) ?? text;
  // 还在估计、汇入的河还没有名字时不说“汇入一条河”（松手后会写出名字）：等算好了再说汇入哪条
  if (!ex) text = text.replace('之后顺地势汇入别的河', '之后顺地势流下去').replace(' · 汇入别的河', '');
  return { text: ex ? text : `${text}…`, ...(caution || deep ? { caution: true } : {}) };
}
