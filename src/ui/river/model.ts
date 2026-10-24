import type { Command } from '../../../core/commands';
import { type EditResult, type EditTarget, type Extra, type RiverEdit, BRANCH_SHARE, applyPatch, editCommand, editedGuide, ruleTypeOf } from '../../../core/river-edit';
import { PLAIN_RIVER } from '../../../core/river-types';
import { centrePoints, encodePath, ownsCell, stemPath } from '../../../core/rivers';
import { type CoursePlan, type Overlap, mergeCourse, overlapsOf } from '../../../core/select';
import { roundKm as km } from '../../../core/terrain';
import { matchesNaturally } from '../../../core/water-types';
import type { Guide, World } from '../../../core/world';
import { riverLines } from '../../render/overlay';
import { type RiverRef, options } from '../../state';
import { pathKm } from '../tools';
import { destText, guideName, guideOf, meters, quoted, riverInfo, riverNameAt, stemFeature, stemNaming, stemOf, water } from './query';

// 一笔河、改一条河、分一股出去、加一个源头：松手后执行的命令（确切预览用的也是它）、执行后这条河的样子与估计的流量。
// 只按世界与画的线算，不碰界面的状态（新画的河的大小、类型按底部条上的选项）

// 画的线停在陆地上时的两种终点（第十四轮：短的叫法“流下去”“停在这”，细的说法在悬停的提示里）。
// 底部条的“终点”和选中的河“⋯ → 终点”同用
export const RIVER_END_HINTS = {
  flow: '线停在陆地上时，河顺着地势接着往低处流，直到入海、入湖或汇进别的河',
  sink: '河就在你画的线的终点结束，不再往下流',
} as const;

// 一路加进来的水（门槛的倍数）在河道上每格的估计：源头有泉水 1.2 倍，其余沿路平均加进来（与水文相同）
export function springProfile(w: World, cells: readonly number[], spring: boolean, flow: number | undefined): number[] {
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
export const riverTypeOfGuide = (w: World, g: Pick<Guide, 'type'> | null | undefined) => (g?.type ? w.small.riverTypes?.find((t) => t.id === g.type) : undefined);

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

export const blocked = (text: string, raw: [number, number][], plan: CoursePlan | null = null): Course => ({ kind: 'new', plan, blocked: text, cmd: null, key: '', after: null, estimate: [], name: null, raw });

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
export function touchWords(w: World, plan: CoursePlan | null, done: boolean): string {
  if (!plan || plan.touch === undefined) return '';
  const name = quoted(riverNameAt(w, plan.touch), '那条河');
  return done ? `没穿过${name}，不截走它` : `没穿过${name}：在碰到它的地方汇入，不截走它`;
}

// “截走「赤江」”“删掉「白水」”（穿过不止一条时“等 3 条河”；第一条没有名字时“截走 3 条河”）；没穿过别的河时为 ''
export function captureWords(w: World, plan: CoursePlan | null, after: Guide | null, self: string | null, done: boolean): string {
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
export const DEEP_GORGE = 1500;
// 改完顶部说的：挖出了峡谷（松手后褐色的格就看不见了，说一声）
const gorgeWords = (m: number) => `挖出了峡谷（最深${meters(m)}）`;

// 改的这条河叫什么：画的河按它的名字，自然的河按它主干上的地名（不是点到的那一格上的：汇合处那一格算在大河上）
function targetName(w: World, T: EditTarget, _ref: RiverRef): string | null {
  if (!T.natural) return guideName(w, T.guide);
  return T.guide.name || T.guide.autoName || stemFeature(w, T.own)?.name || null;
}

// 怎么改的（悬停、拖动时说的、历史里记的）
export type EditHow = 'stroke' | 'source' | 'end' | 'bend' | 'plus' | 'delete';

// 改一条河：命令、执行后的样子（还是同一条河）。how：从哪里改的（拖控制点、重画一笔）
export function editCourse(w: World, T: EditTarget, ref: RiverRef, r: EditResult, raw: [number, number][], how: EditHow): Course {
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

// 自然的河加源头时先固定下来：河道 id（不与已有的重复）
function pinId(w: World, T: EditTarget): string {
  const base = `stem-${T.guide.cells[0]}-${T.guide.cells[T.guide.cells.length - 1]}`;
  let id = base;
  for (let k = 2; w.small.guides.some((g) => g.id === id); k++) id = `${base}-${k}`;
  return id;
}

// 分一股出去、加一个源头：命令、执行后新的那条河道的样子与估计的流量
export function extraCourse(w: World, T: EditTarget, ref: RiverRef, r: Extra | { blocked: string }, raw: [number, number][], kind: 'branch' | 'source'): Course {
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

// ---------- 重叠分析的说法 ----------

// 一处重叠怎么说（一句短话；拖的时候黄色标出那一段，所以不再说“离远一点”之类的办法）；done：松手后顶部说的
export function overlapWords(w: World, o: Overlap, done: boolean): string | null {
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

// 拖的时候算重叠分析，松手后顶部那句话里带上
export function withOverlaps(w: World, c: Course): Course {
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
export function destOf(w: World, plan: CoursePlan, quotedName = true): string {
  const last = plan.cells.length - 1;
  if (plan.end === 'sink') return '停在这里';
  const where = destText(w, plan.end, plan.end === 'river' ? plan.join : plan.cells[last], quotedName);
  return plan.drawn < last ? `之后顺地势${where}` : where;
}

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
