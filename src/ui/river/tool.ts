import { signal } from '@preact/signals';
import type { Command } from '../../../core/commands';
import { findCell } from '../../../core/mesh';
import { type EditTarget, BRANCH_SHARE, branchCourse, deleteHandle, dragHandle, editPoint, editRole, insertHandle, joinAtFirst, sourceCourse, strokeEdit } from '../../../core/river-edit';
import { type GuideLine, centrePoints, smoothCourse, stemPath } from '../../../core/rivers';
import { type RiverPlan, endCourseAt, planCourse, planRiver } from '../../../core/select';
import { roundKm as km } from '../../../core/terrain';
import type { World } from '../../../core/world';
import type { HighlightLayer } from '../../render/colors';
import type { Shape } from '../../render/overlay';
import { type RiverRef, cancelPreviews, exec, options, redrawTick, riverStyleOverride, selectedRiver, showToast, world } from '../../state';
import { barPreview, clearBarPreview } from '../barPreview';
import { Exact, type ExactView } from '../domain/exact';
import { EMPTY, type Pointer, type Preview, type RGB, type ToolHandler, isBusy, worldId } from '../tools';
import { previewRiverBar, riverBarView } from './bar';
import {
  type Course,
  type EditHow,
  blocked,
  chosenRiverType,
  editCourse,
  extraCourse,
  namedDest,
  newCourse,
  pinCommand,
  riverTypeOfGuide,
  springProfile,
  withOverlaps,
} from './model';
import { type RiverPick, HANDLE_PX, SNAP_PX, destText, guideOf, handlesOf, near, pick, plusAt, riverInfo, riverLabel, setSticky, snapToOther, targetOf, tempLine, water } from './query';
import { RED_LINE, WHITE_LINE, handleShapes, lineShapes, overlapShapes, ringAt, riverGlow } from './shapes';
import { courseHint, courseShapes, goneEstimate, handleHint, roleHint } from './course-view';
import { execAndSelect, riverCutPick } from './actions';

// 画河、选河、改河、删河（第十一轮：在原来的河上直接改，所见即所得）。一条记得住的规则：
//   · 从河上起笔（离河的线 14 个屏幕像素以内，不随缩放变）= 改这条河；从别处起笔 = 画新的河。不管选没选中、哪种走向都一样；
//     悬停与按下用同一个判定（pick），悬停时就写着松手后会怎样；
//   · 改一条河永远还是同一条河（同一个河道、名字、大小、类型、粗细），自然的河第一次改时固定下来（名字照旧）；
//   · 选中的河上有控制点（源头、终点、弯点，弯点之间有“+”）：拖控制点只改它两边的那一小段，双击弯点删掉它；
//   · 不再先问一句：拖的时候地图上就是改完的样子（改着的这条河立刻按将来的样子画、原来的样子先不画，
//     会变干的河段是灰色虚线；手停下来后在 worker 里算出将来的整个世界，地图上所有的河都按它画），松手就改，顶部的提示带“撤销”。
// 顺地势、自定义走向只管新画的河；改已有的河总是照着画的线走

// 挖出的河床（峡谷）
const CARVED: RGB = [150, 95, 55];
// 排着队（或松手前世界变了）的一笔认不出要改的河：不改，说一声
const LOST = '河刚变了，没改成：再拖一次';
// 双击弯点删掉它：两下之间不超过这么久（毫秒）
const DOUBLE_MS = 400;

// 选中一条河后按了底部条上的“分一股出去”“加一个源头”：下一笔从这条河上起笔画（Esc 不加了）
export const riverAddMode = signal<'branch' | 'source' | null>(null);

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
    const where = p.end ? ` · ${destText(w, p.end, p.end === 'river' ? p.join : p.cells[p.cells.length - 1])}` : '';
    const guide = { cells: p.cells, path: stemPath(w, p.cells), locked: true, spring: true, flow: options.value.riverFlow, name: '', ...chosenRiverType(w) };
    return { op: 'add_guide', guide, label: `画河 · 约 ${flowLen(w, p)} km${where}` };
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
    if (p.reroute) return { layers: [], shapes: [], hint: '这里已有河：按住往外画是改河', warn: true };
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
      if (h?.kind !== 'river') course = { ...blocked('从选中的河上起笔', pr.pts.slice()), kind: mode };
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
      const busyText = '正在计算…';
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
          setSticky(c.sticky ? { id, z: Math.round(Math.log2(zoom()) * 4), pts: c.sticky } : null);
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
      await exec(cmd, '正在计算…', undefined, (after, said) => namedDest(after, cmd, known, said));
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
    if (p?.reroute) return showToast('这里已有河：按住往外画是改河', true);
    if (!p || p.cells.length < 2) return showToast('这里画不出河', true);
    if (p.blocked) return showToast(p.blocked, true);
    if (p.same) return showToast('河本来就这么流');
    await runFlow(w, p);
  };

  // 点一下（没拖开）：点在控制点上什么都不做（双击弯点删掉它）；点在河上选中它；选着一条河时点别处只是取消选择；
  // 否则顺地势在这里点源头起一条河，自定义走向不放河（要按住拖出河道）
  const click = async (w: World, pr: Press) => {
    const p = pr.start;
    const h = pr.hit;
    if (pr.kind === 'extra') return showToast(pr.mode === 'source' ? '从选中的河上起笔，往外画出源头' : '从选中的河上起笔，往外画出一股');
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
    if (options.value.riverMode === 'course') return showToast('按住拖动画河');
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
        else clearBarPreview();
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
          showToast('已排队');
        }
        return;
      }
      if (riverCutPick.value) {
        const c = cutCell(w, p);
        const cut = c >= 0 ? pinCommand(w, c, true) : null;
        clearBarPreview();
        if (!cut) return showToast('点选中的河，选从哪里往下删除', true);
        riverCutPick.value = false;
        void execAndSelect(cut.cmd, '正在计算…');
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
      clearBarPreview();
    },
    leave() {
      pointer = null;
    },
    // 鼠标离开地图后预览还留着：松手后还在算的那一笔（画河不排队：结果换上之前一直显示松手时的样子，不闪回原样）、底部条上的预览
    keep: () => !!committing || barPreview.value?.kind === 'river',
    escape() {
      if (riverAddMode.value) {
        riverAddMode.value = null;
        return true;
      }
      if (!riverCutPick.value) return false;
      riverCutPick.value = false;
      clearBarPreview();
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
        return { ...held, shapes: [...held.shapes, ...next.shapes], hint: `已排队：${next.hint ?? ''}` };
      }
      // 底部条上改这条河的预览（拖大小、悬停“从这里往下去掉”，在 ../barPreview.ts 的通道里）：画河工具自己画
      // （正在画一笔、松手后还在算时不画它）
      const bar = barPreview.value;
      if (bar?.kind === 'river' && !press) return { ...riverBarView(w, bar, zoom()), hint: riverCutPick.value ? '从这里往下删除' : null };
      if (!pointer) return EMPTY;
      if (riverCutPick.value) return { layers: [], shapes: [], hint: '点选中的河：从那里往下删除' };
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
            ? `从这里往外画：分出约 ${Math.round(BRANCH_SHARE * 100)}% 的水`
            : '从这里往外画：另一头是新的源头';
        return { layers: [], shapes: riverGlow(w, sel), hint: on ? what : `在选中的河上起笔：${mode === 'branch' ? '分出一股' : '加源头'}`, ...(on ? {} : { caution: true }) };
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

