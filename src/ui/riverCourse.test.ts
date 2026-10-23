import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '../../core/commands';
import { findCell } from '../../core/mesh';
import { PLAIN_RIVER } from '../../core/river-types';
import { previewWorldOf } from '../../core/preview-world';
import { controlHandles, deleteHandle, guideTarget } from '../../core/river-edit';
import { type CoursePlan, endCourseAt, isRiverCell, planCourse, riverStem } from '../../core/select';
import { continents, engineFor } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { riverLines } from '../render/overlay';
import { busy, exec, previewCommand, previewWorld, riverStyleOverride, selectedRiver, setOptions, toast, world } from '../state';
import {
  BY_RULES,
  SNAP_PX,
  chosenRiverType,
  handlesOf,
  lineOf,
  namedDest,
  newCourse,
  pick,
  pinCommand,
  riverAt,
  riverCutPick,
  riverGlow,
  riverInfo,
  riverLabel,
  riverTool,
  targetOf,
  unwaterTool,
} from './riverCourse';
import type { Pointer } from './tools';

// 画河的手势（第十一轮）：从河上起笔（离河的线 14 个屏幕像素以内，不随缩放变）是改这条河，从别处起笔是画新的河；
// 悬停与按下同一个判定；改一条河还是同一条河（自然的河固定下来、名字照旧）；不再先问一句，松手就改；
// 选中的河有控制点，拖它只改那一段，双击弯点删掉它；自定义走向在空地上点一下不放河

// 命令不真的发给引擎（这里没有 worker）：只看工具发了什么；确切预览默认不回来
vi.mock('../state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state')>()),
  exec: vi.fn(async () => true),
  previewCommand: vi.fn(async () => null),
  previewWorld: vi.fn(async () => null),
}));

type Pt = [number, number];
// 一格 20 个屏幕像素
const PX_PER_CELL = 20;
const zoomOf = (w: World) => PX_PER_CELL / w.mesh.spacing;

function ptr(w: World, [x, y]: Pt, extra: Partial<Pointer> = {}, z = zoomOf(w)): Pointer {
  const inside = w.mesh.kind === 'sphere' || (x >= 0 && y >= 0 && x <= w.mesh.width && y <= w.mesh.height);
  return { x, y, cell: inside ? findCell(w.mesh, x, y) : -1, sx: x * z, sy: y * z, shift: false, alt: false, ...extra };
}

// 一条直线，点与点隔 7 个屏幕像素以上（工具每一点都记下：拖开 6 像素才算拖、每 2 像素以上记一点）
function line(w: World, a: Pt, b: Pt): Pt[] {
  const n = Math.max(2, Math.floor((Math.hypot(b[0] - a[0], b[1] - a[1]) * zoomOf(w)) / 7));
  const out: Pt[] = [];
  for (let k = 0; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  return out;
}

function drag(t: ReturnType<typeof riverTool>, w: World, pts: Pt[], extra: Partial<Pointer> = {}) {
  t.down?.(ptr(w, pts[0]));
  for (const p of pts.slice(1)) t.move?.(ptr(w, p, extra), true);
  return t.up?.(ptr(w, pts[pts.length - 1], extra));
}

const at = (w: World, c: number): Pt => [w.mesh.x[c], w.mesh.y[c]];
const opts = (w: World) => ({ endOnLand: 'sink' as const, px: 1 / zoomOf(w) });

// 横穿一条自然的大河（垂直于它的流向，两头各 4 格，都在陆地上、离别的河远）
function acrossRiver(w: World): { stroke: Pt[]; plan: CoursePlan } {
  const { mesh, derived: d } = w;
  const thr = w.small.planet.riverThreshold;
  for (let c = 0; c < mesh.n; c++) {
    const r = d.receiver[c];
    if (!isRiverCell(w, d, c) || d.discharge[c] < 4 * thr || r < 0 || !isRiverCell(w, d, r)) continue;
    const dx = mesh.x[r] - mesh.x[c];
    const dy = mesh.y[r] - mesh.y[c];
    const len = Math.hypot(dx, dy);
    const L = 4 * mesh.spacing;
    const a: Pt = [mesh.x[c] - (dy / len) * L, mesh.y[c] + (dx / len) * L];
    const b: Pt = [mesh.x[c] + (dy / len) * L, mesh.y[c] - (dx / len) * L];
    const stroke = line(w, a, b);
    if (riverAt(w, a[0], a[1], SNAP_PX / zoomOf(w))) continue;
    const ca = findCell(mesh, ...a);
    if (!w.causes.land[ca] || d.lake[ca] === 1 || isRiverCell(w, d, ca)) continue;
    const plan = planCourse(w, d, stroke, opts(w));
    if (!plan.blocked && plan.end === 'sink' && plan.crossings.length === 1 && !plan.reroute && !plan.merge) return { stroke, plan };
  }
  throw new Error('找不到横穿一条大河的线');
}

// 一笔不碰任何河、不往高处流的河（3–5 格），画到陆地上；起笔离别的河远（不会吸到河上）
function quietStroke(w: World, endOnLand: 'sink' | 'flow' = 'sink'): { stroke: Pt[]; plan: CoursePlan } {
  const { mesh, derived: d } = w;
  for (let c = 0; c < mesh.n; c += 7) {
    if (!w.causes.land[c] || d.lake[c] === 1 || isRiverCell(w, d, c) || d.elevation[c] < 300) continue;
    if (riverAt(w, mesh.x[c], mesh.y[c], (SNAP_PX + 4) / zoomOf(w))) continue;
    const stroke = line(w, at(w, c), [mesh.x[c] + 4 * mesh.spacing, mesh.y[c] + 1.5 * mesh.spacing]);
    const plan = planCourse(w, d, stroke, { endOnLand, px: 1 / zoomOf(w) });
    if (plan.blocked || plan.crossings.length || plan.reroute || plan.merge || plan.cells.length < 4 || plan.uphill >= 20) continue;
    if (endOnLand === 'sink' ? plan.end !== 'sink' : plan.drawn >= plan.cells.length - 1) continue;
    return { stroke, plan };
  }
  throw new Error('找不到一笔安静的河');
}

const lastExec = () => vi.mocked(exec).mock.calls[vi.mocked(exec).mock.calls.length - 1][0] as Command;

function setup() {
  const eng = continents();
  const w = eng.world;
  world.value = w;
  selectedRiver.value = null;
  riverCutPick.value = false;
  riverStyleOverride.value = null;
  setOptions({ riverMode: 'course', riverEnd: 'sink', riverFlow: 4 });
  vi.mocked(exec).mockClear();
  vi.mocked(previewCommand).mockClear();
  vi.mocked(previewWorld).mockClear();
  return { eng, w, t: riverTool(() => zoomOf(w)) };
}

// 先画好一条弯弯曲曲的河（12 格，在终点消失），世界换成画好之后的
function withDrawn() {
  const { eng } = setup();
  const w0 = eng.world;
  const { mesh, derived: d } = w0;
  const s = mesh.spacing;
  for (let i = 0; i < mesh.n; i += 11) {
    if (!w0.causes.land[i] || d.lake[i] === 1 || isRiverCell(w0, d, i) || d.elevation[i] < 400) continue;
    const [x, y] = at(w0, i);
    const stroke = [
      ...line(w0, [x, y], [x + 3 * s, y + 1.5 * s]),
      ...line(w0, [x + 3 * s, y + 1.5 * s], [x + 6 * s, y - 0.5 * s]).slice(1),
      ...line(w0, [x + 6 * s, y - 0.5 * s], [x + 9 * s, y + 1.5 * s]).slice(1),
      ...line(w0, [x + 9 * s, y + 1.5 * s], [x + 12 * s, y + 0.5 * s]).slice(1),
    ];
    const plan = planCourse(w0, d, stroke, opts(w0));
    if (plan.blocked || plan.end !== 'sink' || plan.crossings.length || plan.reroute || plan.merge || plan.uphill >= 20 || plan.cells.length < 10) continue;
    eng.exec(newCourse(w0, plan, stroke).cmd!);
    const w = eng.world;
    world.value = w;
    const g = w.small.guides[w.small.guides.length - 1];
    vi.mocked(exec).mockClear();
    return { eng, w, g, t: riverTool(() => zoomOf(w)) };
  }
  throw new Error('画不出一条弯弯曲曲的河');
}

beforeEach(() => {
  riverCutPick.value = false;
});

describe('自定义走向：画的线就是河', () => {
  it('预览是与地图同样画法的河（带河口的箭头、白色虚线），松手发的命令就是这条：只挖河床、自动起名、在终点消失', async () => {
    const { w, t } = setup();
    const { stroke, plan } = quietStroke(w);
    t.down?.(ptr(w, stroke[0]));
    for (const p of stroke.slice(1)) t.move?.(ptr(w, p), true);
    const pv = t.preview();
    expect(pv.shapes.some((s) => s.kind === 'river')).toBe(true);
    expect(pv.shapes.some((s) => s.kind === 'line' && s.dashed)).toBe(true);
    expect(pv.hint).toMatch(/^新河 · 到这里消失 · [\d,]+ km/);
    await t.up?.(ptr(w, stroke[stroke.length - 1]));
    expect(exec).toHaveBeenCalledTimes(1);
    const cmd = lastExec();
    expect(cmd).toEqual(newCourse(w, plan, stroke).cmd);
    expect(cmd).toMatchObject({ op: 'add_guide', guide: { cells: plan.cells, locked: true, spring: true, flow: 4, name: '', end: 'sink' } });
    if (cmd.op !== 'add_guide') throw new Error();
    expect(cmd.guide.path!.every((v) => Number.isInteger(v))).toBe(true);
  });

  it('画到陆地上选“画完接着流”：之后顺地势流下去的格也在河道里，提示写“之后顺地势……”', async () => {
    const { w, t } = setup();
    setOptions({ riverEnd: 'flow' });
    const { stroke, plan } = quietStroke(w, 'flow');
    t.down?.(ptr(w, stroke[0]));
    for (const p of stroke.slice(1)) t.move?.(ptr(w, p), true);
    expect(t.preview().hint).toMatch(/^新河 · 之后顺地势/);
    await t.up?.(ptr(w, stroke[stroke.length - 1]));
    const cmd = lastExec();
    expect(cmd).toEqual(newCourse(w, plan, stroke).cmd);
    if (cmd.op !== 'add_guide') throw new Error();
    expect(cmd.guide.end).toBeUndefined();
    expect(cmd.guide.cells.length).toBeGreaterThan(plan.drawn + 1);
  });

  it('松手后还在算：鼠标离开地图也一直画着松手时的那条河（画河不排队，不闪回原样），算完才去掉', async () => {
    const { w, t } = setup();
    const { stroke } = quietStroke(w);
    let finish: (ok: boolean) => void = () => {};
    vi.mocked(exec).mockImplementationOnce(() => new Promise<boolean>((r) => (finish = r)));
    t.down?.(ptr(w, stroke[0]));
    for (const p of stroke.slice(1)) t.move?.(ptr(w, p), true);
    const up = t.up?.(ptr(w, stroke[stroke.length - 1]));
    expect(exec).toHaveBeenCalledTimes(1);
    t.leave?.();
    expect(t.keep?.()).toBe(true);
    const held = t.preview();
    expect(held.shapes.some((s) => s.kind === 'river')).toBe(true);
    expect(held.hint).toBe('正在计算…');
    finish(true);
    await up;
    expect(t.keep?.()).toBe(false);
    expect(t.preview().shapes).toEqual([]);
  });

  it('前面的编辑还在算（排着队）：画河要按算好的世界来，不开始画、不执行，提示“还在计算上一步”；算完照常', async () => {
    const { w, t } = setup();
    const { stroke } = quietStroke(w);
    busy.value = '正在计算…';
    try {
      await drag(t, w, stroke);
      expect(exec).not.toHaveBeenCalled();
      expect(toast.value?.text).toBe('还在计算上一步，稍等一下');
    } finally {
      busy.value = null;
    }
    await drag(t, w, stroke);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('在空地上点一下：自定义走向不放河，提示“按住拖动画一条河”；顺地势放一条新河（有折线，所以也有粗细）', async () => {
    const { w, t } = setup();
    const { stroke } = quietStroke(w);
    t.down?.(ptr(w, stroke[0]));
    await t.up?.(ptr(w, [stroke[0][0] + 0.1 * w.mesh.spacing, stroke[0][1]]));
    expect(exec).not.toHaveBeenCalled();
    expect(toast.value?.text).toBe('按住拖动画一条河');
    setOptions({ riverMode: 'flow' });
    // 顺地势悬停时先有预览
    t.move?.(ptr(w, stroke[0]), false);
    expect(t.preview().shapes.some((s) => s.kind === 'river')).toBe(true);
    t.down?.(ptr(w, stroke[0]));
    await t.up?.(ptr(w, stroke[0]));
    expect(exec).toHaveBeenCalledTimes(1);
    const cmd = lastExec();
    if (cmd.op !== 'add_guide') throw new Error();
    expect(cmd.guide.path?.length).toBeGreaterThan(0);
    expect(cmd.guide).toMatchObject({ spring: true, flow: 4, name: '' });
  });
});

describe('穿过别的河：不再先问一句', () => {
  it('松手就截走：命令就是预览的那条，顶部的话写“截走了……”（提示条带撤销）', async () => {
    const { w, t } = setup();
    const { stroke, plan } = acrossRiver(w);
    t.down?.(ptr(w, stroke[0]));
    for (const p of stroke.slice(1)) t.move?.(ptr(w, p), true);
    const hint = t.preview().hint!;
    expect(hint).toMatch(/会截走/);
    expect(hint).toContain('按住 Alt');
    await t.up?.(ptr(w, stroke[stroke.length - 1]));
    expect(exec).toHaveBeenCalledTimes(1);
    const cmd = lastExec();
    expect(cmd).toEqual(newCourse(w, plan, stroke).cmd);
    expect(cmd.op === 'add_guide' && cmd.label).toMatch(/截走了/);
  });

  it('按住 Alt 松手：在第一次碰到的那条河那里汇入', async () => {
    const { w, t } = setup();
    const { stroke, plan } = acrossRiver(w);
    await drag(t, w, stroke, { alt: true });
    const cmd = lastExec();
    const join = endCourseAt(w, w.derived, plan, plan.crossings[0].from);
    expect(cmd).toEqual(newCourse(w, join, stroke).cmd);
    if (cmd.op !== 'add_guide') throw new Error();
    expect(cmd.guide.cells[cmd.guide.cells.length - 1]).toBe(join.join);
  });
});

describe('认河：悬停与按下同一个判定，14 个屏幕像素以内都吸得上（不随缩放变）', () => {
  // 一条自然的大河的线上一点，与线的法向
  // 离别的河的线都在 3 格以外
  function onLine(w: World): { p: Pt; n: Pt; cell: number } {
    const lines = riverLines(w);
    for (const L of lines) {
      if (L.guide !== undefined || !L.cells || L.points.length < 40) continue;
      const k = Math.floor(L.points.length / 2);
      const [px, py] = L.points[k];
      const crowded = lines.some((o) => o !== L && o.points.some(([x, y]) => Math.hypot(x - px, y - py) < 3 * w.mesh.spacing));
      if (crowded) continue;
      const [ax, ay] = L.points[k - 1];
      const [bx, by] = L.points[k + 1];
      const l = Math.hypot(bx - ax, by - ay);
      if (!l || !isRiverCell(w, w.derived, L.cells[k])) continue;
      return { p: L.points[k], n: [-(by - ay) / l, (bx - ax) / l], cell: L.cells[k] };
    }
    throw new Error('找不到自然的大河');
  }

  it('拉远、拉近：离线 12 个屏幕像素都吸到同一条河上', () => {
    const { w } = setup();
    const { p, n } = onLine(w);
    for (const px of [5, 20, 80]) {
      const z = px / w.mesh.spacing;
      const on = pick(w, p[0], p[1], findCell(w.mesh, ...p), z);
      expect(on?.kind, `${px} 像素一格`).toBe('river');
      for (const side of [1, -1]) {
        const q: Pt = [p[0] + (side * n[0] * 12) / z, p[1] + (side * n[1] * 12) / z];
        const h = pick(w, q[0], q[1], findCell(w.mesh, ...q), z);
        expect(h?.T, `${px} 像素一格，偏 ${side * 12} 像素`).toBe(on!.T);
      }
    }
    // 拉远时离线 20 个屏幕像素（4 格）就不算在河上了（吸附的范围不随缩放变大）
    const z = 5 / w.mesh.spacing;
    const far: Pt = [p[0] + (n[0] * 20) / z, p[1] + (n[1] * 20) / z];
    expect(pick(w, far[0], far[1], findCell(w.mesh, ...far), z)).toBeNull();
  });

  it('在河边上（脚下那一格不是河）悬停：说从这里起笔会怎样；按下去拖出去改的就是这条河（固定下来，名字照旧）', async () => {
    const { w, t } = setup();
    const { p, n } = onLine(w);
    const z = zoomOf(w);
    let s: Pt | null = null;
    for (const side of [1, -1]) {
      const q: Pt = [p[0] + (side * n[0] * 10) / z, p[1] + (side * n[1] * 10) / z];
      if (!isRiverCell(w, w.derived, findCell(w.mesh, ...q))) s = q;
    }
    if (!s) s = [p[0] + (n[0] * 10) / z, p[1] + (n[1] * 10) / z];
    t.move?.(ptr(w, s), false);
    const hover = t.preview();
    expect(hover.hint).toContain('从这里起笔：');
    expect(hover.hint).toContain('改了以后它就固定下来');
    const h = pick(w, s[0], s[1], findCell(w.mesh, ...s), z)!;
    expect(h.kind).toBe('river');
    // 往旁边画 4 格
    let done = false;
    for (const side of [1, -1]) {
      const end: Pt = [s[0] + side * n[0] * 4 * w.mesh.spacing, s[1] + side * n[1] * 4 * w.mesh.spacing];
      vi.mocked(exec).mockClear();
      await drag(t, w, line(w, s, end));
      if (!vi.mocked(exec).mock.calls.length) continue;
      const cmd = lastExec();
      if (cmd.op !== 'add_guide') throw new Error(cmd.op);
      expect(cmd.guide.locked).toBe(true);
      expect(cmd.guide.spring).toBe(false);
      if (h.T.guide.nameKey) expect(cmd.guide.nameKey).toBe(h.T.guide.nameKey);
      // 起笔以上照旧是这条河
      expect(cmd.guide.cells[0]).toBe(h.T.guide.cells[0]);
      expect(riverStyleOverride.value).toBeNull();
      done = true;
      break;
    }
    expect(done).toBe(true);
  });
});

describe('选中的河：控制点', () => {
  it('拖弯点：拖的时候原来的样子先不画、画将来的样子；松手直接改（update_guide，同一条河），不问；改完还选着它', async () => {
    const { w, g, t } = withDrawn();
    selectedRiver.value = { kind: 'guide', id: g.id };
    const T = targetOf(w, { kind: 'guide', id: g.id })!;
    const H = handlesOf(T, zoomOf(w));
    expect(H.length).toBeGreaterThanOrEqual(3);
    // 控制点一直画着
    expect(t.backdrop?.()?.shapes.some((s) => s.kind === 'circle')).toBe(true);
    let done = false;
    for (let j = 1; j < H.length - 1 && !done; j++) {
      const P = T.points[H[j]];
      for (const dy of [1, -1]) {
        const to: Pt = [P[0], P[1] + dy * 0.8 * w.mesh.spacing];
        vi.mocked(exec).mockClear();
        t.move?.(ptr(w, P), false);
        expect(t.preview().hint).toContain('双击删掉');
        t.down?.(ptr(w, P));
        for (const q of line(w, P, to).slice(1)) t.move?.(ptr(w, q), true);
        expect(riverStyleOverride.value).toEqual({ id: g.id, hide: true });
        const pv = t.preview();
        if (pv.warn) {
          t.cancel?.();
          continue;
        }
        expect(pv.shapes.some((s) => s.kind === 'river')).toBe(true);
        // 拖着的时候控制点不画（画的是改好的样子）
        expect(t.backdrop?.()).toBeNull();
        await t.up?.(ptr(w, to));
        expect(exec).toHaveBeenCalledTimes(1);
        const cmd = lastExec();
        expect(cmd).toMatchObject({ op: 'update_guide', id: g.id });
        if (cmd.op !== 'update_guide') throw new Error();
        // 只改走向；名字定下来（autoName），以后不因为走向变了换名字
        expect(Object.keys(cmd.patch).filter((k) => k !== 'autoName').sort()).toEqual(['cells', 'path']);
        if (cmd.patch.autoName !== undefined) expect(cmd.patch.autoName).toBe(w.derived.features.find((f) => f.guide === g.id)?.name);
        expect(selectedRiver.value).toEqual({ kind: 'guide', id: g.id });
        expect(riverStyleOverride.value).toBeNull();
        done = true;
        break;
      }
    }
    expect(done).toBe(true);
  });

  it('双击弯点删掉它；点一下控制点什么都不做', async () => {
    const { w, g, t } = withDrawn();
    selectedRiver.value = { kind: 'guide', id: g.id };
    const T = targetOf(w, { kind: 'guide', id: g.id })!;
    const H = handlesOf(T, zoomOf(w));
    let j = -1;
    for (let k = 1; k < H.length - 1 && j < 0; k++) if (!('blocked' in deleteHandle(w, w.derived, T, H, k))) j = k;
    expect(j).toBeGreaterThan(0);
    const P = T.points[H[j]];
    t.down?.(ptr(w, P));
    await t.up?.(ptr(w, P));
    expect(exec).not.toHaveBeenCalled();
    expect(selectedRiver.value).toEqual({ kind: 'guide', id: g.id });
    t.down?.(ptr(w, P));
    await t.up?.(ptr(w, P));
    expect(exec).toHaveBeenCalledTimes(1);
    const cmd = lastExec();
    expect(cmd).toMatchObject({ op: 'update_guide', id: g.id });
    expect(cmd.op === 'update_guide' && cmd.label).toContain('删掉了');
  });

  it('从河中间画到旁边的陆地上：从这里改道，还是同一条河；拖的时候原来的下游画成灰色虚线', async () => {
    const { w, g, t } = withDrawn();
    const T = guideTarget(w, g);
    const P = T.points;
    const mid = P[Math.floor(P.length / 2)];
    let done = false;
    for (let k = 0; k < 8 && !done; k++) {
      const ang = (k * Math.PI) / 4;
      const end: Pt = [mid[0] + 3 * w.mesh.spacing * Math.cos(ang), mid[1] + 3 * w.mesh.spacing * Math.sin(ang)];
      vi.mocked(exec).mockClear();
      t.down?.(ptr(w, mid));
      for (const q of line(w, mid, end).slice(1)) t.move?.(ptr(w, q), true);
      const pv = t.preview();
      if (pv.warn || !pv.hint?.includes('从这里改道') || pv.hint.includes('截走')) {
        t.cancel?.();
        continue;
      }
      expect(pv.shapes.some((s) => s.kind === 'line' && s.dashed && s.color?.startsWith('rgba(200, 200, 200'))).toBe(true);
      await t.up?.(ptr(w, end));
      const cmd = lastExec();
      expect(cmd).toMatchObject({ op: 'update_guide', id: g.id });
      expect(cmd.op === 'update_guide' && cmd.label).toContain('从这里改道');
      done = true;
    }
    expect(done).toBe(true);
  });

  it('停一下后地图画将来的整个世界（previewWorld），松手执行的就是它预览的那条命令', async () => {
    const { eng, w, g, t } = withDrawn();
    selectedRiver.value = { kind: 'guide', id: g.id };
    const T = targetOf(w, { kind: 'guide', id: g.id })!;
    const H = handlesOf(T, zoomOf(w));
    const P = T.points[H[1]];
    const to: Pt = [P[0], P[1] + 0.6 * w.mesh.spacing];
    vi.mocked(previewWorld).mockImplementation(async (cmd) => {
      const pv = eng.clone().previewWorld(cmd);
      return { result: pv.result, world: previewWorldOf(w, pv.patch), base: w };
    });
    try {
      t.down?.(ptr(w, P));
      for (const q of line(w, P, to).slice(1)) t.move?.(ptr(w, q), true);
      t.preview();
      await vi.waitFor(() => expect(t.preview().world).toBeTruthy(), { timeout: 3000 });
      const pv = t.preview();
      // 将来的世界里改的那条河在：地图按它画，这里不再另画一条河
      expect(pv.shapes.some((s) => s.kind === 'river')).toBe(false);
      expect(pv.hint?.endsWith('…')).toBe(false);
      const asked = vi.mocked(previewWorld).mock.calls[vi.mocked(previewWorld).mock.calls.length - 1][0];
      await t.up?.(ptr(w, to));
      expect(lastExec()).toEqual(asked);
    } finally {
      vi.mocked(previewWorld).mockImplementation(async () => null);
    }
  });

  it('“从这里往下去掉”：点了按钮后悬停预览，在河上点一下才去掉；Esc 不去掉了', async () => {
    const { w, t } = setup();
    const f = w.derived.features.find((x) => x.type === 'river' && x.name && x.cells.length > 8 && x.guide === undefined)!;
    const cells = riverStem(w, w.derived, Array.from(f.cells).find((c) => isRiverCell(w, w.derived, c))!).cells;
    const cell = cells[Math.floor(cells.length / 2)];
    selectedRiver.value = { kind: 'natural', cell };
    riverCutPick.value = true;
    t.move?.(ptr(w, at(w, cell)), false);
    expect(t.preview().hint).toBe('点一下：从这里往下去掉');
    expect(t.escape?.()).toBe(true);
    expect(riverCutPick.value).toBe(false);
    riverCutPick.value = true;
    t.move?.(ptr(w, at(w, cell)), false);
    t.down?.(ptr(w, at(w, cell)));
    await t.up?.(ptr(w, at(w, cell)));
    const cmd = lastExec();
    if (cmd.op !== 'add_guide') throw new Error();
    expect(cmd.guide.end).toBe('sink');
    expect(cmd).toEqual(pinCommand(w, cell, true)!.cmd);
    expect(riverCutPick.value).toBe(false);
  });
});

describe('点一下河就选中它', () => {
  it('点在河上选中（悬停时写出是哪条河）；选着时点空地只是取消选择，不画新河', async () => {
    const { w, t } = setup();
    const d = w.derived;
    const thr = w.small.planet.riverThreshold;
    const c = [...Array(w.mesh.n).keys()].find((i) => isRiverCell(w, d, i) && d.discharge[i] > 3 * thr)!;
    t.move?.(ptr(w, at(w, c)), false);
    expect(t.preview().hint).toMatch(/ · (小河|中等的河|大河) · /);
    t.down?.(ptr(w, at(w, c)));
    await t.up?.(ptr(w, at(w, c)));
    expect(selectedRiver.value?.kind).toBe('natural');
    expect(riverInfo(w, selectedRiver.value!)).not.toBeNull();
    const { stroke } = quietStroke(w);
    t.down?.(ptr(w, stroke[0]));
    await t.up?.(ptr(w, stroke[0]));
    expect(selectedRiver.value).toBeNull();
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('整个星球：鼠标在平铺的另一份上', () => {
  it('点中的是同一格（不是线段另一头的那格），认出的是同一条河', () => {
    const eng = engineFor({ seed: 4, cells: 4000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    const w = eng.world;
    world.value = w;
    selectedRiver.value = null;
    const d = w.derived;
    let checked = 0;
    for (const L of riverLines(w)) {
      if (L.guide !== undefined || !L.cells) continue;
      for (let k = 0; k + 2 < L.points.length && checked < 20; k++) {
        const [ax, ay] = L.points[k];
        const [bx, by] = L.points[k + 1];
        const a = L.cells[k];
        if (a === L.cells[k + 1] || bx <= ax || !isRiverCell(w, d, a) || !isRiverCell(w, d, L.cells[k + 1])) continue;
        const x = ax + (bx - ax) * 0.2;
        const y = ay + (by - ay) * 0.2;
        const tol = 0.2 * w.mesh.spacing;
        const here = riverAt(w, x, y, tol);
        if (here?.ref.kind !== 'natural' || here.ref.cell !== a) continue;
        expect(riverAt(w, x + 2, y, tol)?.ref).toEqual(here.ref);
        expect(riverAt(w, x - 2, y, tol)?.ref).toEqual(here.ref);
        const z = 20 / w.mesh.spacing;
        const p0 = pick(w, x, y, findCell(w.mesh, x, y), z);
        const p1 = pick(w, x + 2, y, findCell(w.mesh, x, y), z);
        expect(p1?.ref).toEqual(p0?.ref);
        if (p0?.kind === 'river' && p1?.kind === 'river') expect(p1.e.along).toBeCloseTo(p0.e.along, 6);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(5);
  });
});

describe('固定自然的河', () => {
  it('沿用它的地名键：固定后名字、颜色（不是“改过的名字”）都不变', () => {
    const eng = continents();
    const w = eng.world;
    const f = w.derived.features.find((x) => x.type === 'river' && x.name && x.cells.length > 6)!;
    const cell = Array.from(f.cells).find((c) => isRiverCell(w, w.derived, c))!;
    const pin = pinCommand(w, cell)!;
    expect(pin.cmd).toMatchObject({ op: 'add_guide', guide: { locked: true, spring: false, nameKey: f.key } });
    eng.exec(pin.cmd);
    const g = eng.world.small.guides[eng.world.small.guides.length - 1];
    const gf = eng.world.derived.features.find((x) => x.guide === g.id)!;
    expect(gf.name).toBe(f.name);
    expect(gf.custom).toBe(false);
  });

  it('从这里往下去掉：固定到这一格，在这里消失', () => {
    const w = continents().world;
    const f = w.derived.features.find((x) => x.type === 'river' && x.name && x.cells.length > 6)!;
    const cells = Array.from(f.cells).filter((c) => isRiverCell(w, w.derived, c));
    const cell = cells[Math.floor(cells.length / 2)];
    const cut = pinCommand(w, cell, true)!;
    if (cut.cmd.op !== 'add_guide') throw new Error();
    expect(cut.cmd.guide.end).toBe('sink');
    expect(cut.cmd.guide.cells[cut.cmd.guide.cells.length - 1]).toBe(cell);
  });
});

describe('删除河湖：按画出来的线认河', () => {
  it('鼠标在画的河的线上：整条线标红、写“删掉这条河”，停一下后算删掉后真正变干的格；点一下删掉它', async () => {
    const eng = continents();
    const w0 = eng.world;
    world.value = w0;
    const { plan, stroke } = quietStroke(w0);
    eng.exec(newCourse(w0, plan, stroke).cmd!);
    const w = eng.world;
    world.value = w;
    const g = w.small.guides[w.small.guides.length - 1];
    selectedRiver.value = { kind: 'guide', id: g.id };
    vi.mocked(exec).mockClear();
    vi.mocked(previewCommand).mockClear();
    vi.useFakeTimers();
    try {
      const t = unwaterTool(() => zoomOf(w));
      const L = lineOf(w, g).points;
      const p = ptr(w, L[Math.floor(L.length / 2)]);
      t.move?.(p, false);
      const pv = t.preview();
      expect(pv.hint).toBe('删掉这条河');
      expect(pv.shapes.some((s) => s.kind === 'line' && s.points!.length >= L.length - 1)).toBe(true);
      expect(previewCommand).not.toHaveBeenCalled();
      vi.advanceTimersByTime(300);
      const name = w.derived.features.find((f) => f.guide === g.id)?.name;
      const removal = { op: 'remove_guide', id: g.id, label: `删掉了「${name}」` };
      expect(previewCommand).toHaveBeenCalledWith(removal);
      await t.click?.(p);
      expect(lastExec()).toEqual(removal);
      expect(selectedRiver.value).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('说法', () => {
  it('画完就消失的河：停在终点那一格上说“在这里消失”，别处说“最后在终点消失”', () => {
    const { eng, w: w0 } = setup();
    const { plan, stroke } = quietStroke(w0);
    eng.exec(newCourse(w0, plan, stroke).cmd!);
    const w = eng.world;
    world.value = w;
    const g = w.small.guides[w.small.guides.length - 1];
    expect(g.end).toBe('sink');
    const ref = { kind: 'guide' as const, id: g.id };
    const info = riverInfo(w, ref)!;
    expect(riverLabel(ref, info, g.cells[g.cells.length - 1])).toMatch(/在这里消失$/);
    expect(riverLabel(ref, info, g.cells[1])).toMatch(/最后在终点消失$/);
    expect(info.dest).toBe('最后在终点消失');
  });

  it('画好以后顶部说汇入哪条河时用改好的世界里的名字（画的时候那条河还没名字，说的是“汇入一条河”）', () => {
    const { eng, w } = setup();
    const { mesh } = w;
    for (const f of w.derived.features) {
      if (f.type !== 'river' || !f.name || f.guide !== undefined) continue;
      const T = f.cells[Math.floor(f.cells.length / 2)];
      for (let a = 0; a < 8; a++) {
        const ang = (a * Math.PI) / 4;
        const s = line(w, [mesh.x[T] + 4 * mesh.spacing * Math.cos(ang), mesh.y[T] + 4 * mesh.spacing * Math.sin(ang)], at(w, T));
        const plan = planCourse(w, w.derived, s, opts(w));
        if (plan.blocked || plan.end !== 'river' || plan.crossings.length || plan.reroute || plan.merge) continue;
        const cmd = newCourse(w, plan, s).cmd!;
        const known = new Set(w.small.guides.map((g) => g.id));
        eng.exec(cmd);
        const said = namedDest(eng.world, cmd, known, '画了一条河（约 3 km，汇入一条河）');
        const id = eng.world.small.guides.find((g) => !known.has(g.id))!.id;
        const dest = riverInfo(eng.world, { kind: 'guide', id })!.dest;
        expect(dest).toMatch(/^汇入「/);
        expect(said).toBe(`画了一条河（约 3 km，${dest}）`);
        expect(namedDest(eng.world, cmd, known, '画了一条河（约 3 km，入海）')).toBeNull();
        return;
      }
    }
    throw new Error('找不到汇入一条有名字的河的一笔');
  });
});

// 控制点：同一条河（同一个世界）上同一个缩放给同样的控制点；拉近后更密
describe('控制点的疏密', () => {
  it('按屏幕上约 40 像素一个：拉近后更多，源头、终点总在', () => {
    const { w, g } = withDrawn();
    const T = guideTarget(w, g);
    const far = handlesOf(T, 5 / w.mesh.spacing);
    const nearH = handlesOf(T, 60 / w.mesh.spacing);
    expect(nearH.length).toBeGreaterThanOrEqual(far.length);
    for (const H of [far, nearH]) {
      expect(H[0]).toBe(0);
      expect(H[H.length - 1]).toBe(T.points.length - 1);
    }
    expect(controlHandles(T, 0, 0).length).toBeGreaterThan(2);
  });
});

describe('审查后补的', () => {
  it('上一笔还在算时又画了一笔：排着队，上一笔改完后按改好的世界接着改（不丢掉）', async () => {
    const { w, t } = setup();
    const { stroke } = quietStroke(w);
    let finish: (ok: boolean) => void = () => {};
    vi.mocked(exec).mockImplementationOnce(() => new Promise<boolean>((r) => (finish = r)));
    t.down?.(ptr(w, stroke[0]));
    for (const p of stroke.slice(1)) t.move?.(ptr(w, p), true);
    const first = t.up?.(ptr(w, stroke[stroke.length - 1]));
    expect(exec).toHaveBeenCalledTimes(1);
    // 第二笔：往旁边挪两格再画一遍
    const s2 = stroke.map(([x, y]) => [x, y + 2 * w.mesh.spacing] as Pt);
    t.down?.(ptr(w, s2[0]));
    for (const p of s2.slice(1)) t.move?.(ptr(w, p), true);
    expect(t.preview().hint).toMatch(/^排着队：/);
    await t.up?.(ptr(w, s2[s2.length - 1]));
    expect(exec).toHaveBeenCalledTimes(1);
    expect(toast.value?.text).toContain('排着队');
    finish(true);
    await first;
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(2));
  });

  it('拖完弯点以后控制点不跳：拖的那个就在松手的地方，别的控制点还是原来那几个', async () => {
    const { eng, w, g, t } = withDrawn();
    selectedRiver.value = { kind: 'guide', id: g.id };
    const T = targetOf(w, { kind: 'guide', id: g.id })!;
    const H = handlesOf(T, zoomOf(w));
    vi.mocked(exec).mockImplementation(async (cmd) => {
      eng.exec(cmd as Command);
      // 界面上每次结果都是新的世界对象（按世界缓存的认河、控制点要重算）
      world.value = { ...eng.world };
      return true;
    });
    try {
      for (let j = 1; j < H.length - 1; j++) {
        const P = T.points[H[j]];
        const to: Pt = [P[0], P[1] + 0.6 * w.mesh.spacing];
        t.down?.(ptr(w, P));
        for (const q of line(w, P, to).slice(1)) t.move?.(ptr(w, q), true);
        if (t.preview().warn) {
          t.cancel?.();
          continue;
        }
        await t.up?.(ptr(w, to));
        const w2 = world.value!;
        const T2 = targetOf(w2, { kind: 'guide', id: g.id })!;
        const H2 = handlesOf(T2, zoomOf(w2));
        expect(H2.length).toBe(H.length);
        const moved = T2.points[H2[j]];
        expect(Math.hypot(moved[0] - to[0], moved[1] - to[1])).toBeLessThan(1e-4);
        for (const k of [0, H.length - 1]) expect(T2.points[H2[k]]).toEqual(T.points[H[k]]);
        return;
      }
      throw new Error('没有能拖的弯点');
    } finally {
      vi.mocked(exec).mockImplementation(async () => true);
    }
  });

  it('选中、悬停的河：一道光下面照样画出蓝色的河（不被光盖成灰色）', () => {
    const { w } = setup();
    const c = [...Array(w.mesh.n).keys()].find((i) => isRiverCell(w, w.derived, i) && w.derived.discharge[i] > 3 * w.small.planet.riverThreshold)!;
    const shapes = riverGlow(w, { kind: 'natural', cell: c });
    expect(shapes.some((s) => s.kind === 'line')).toBe(true);
    expect(shapes.some((s) => s.kind === 'river')).toBe(true);
    // 河画在光的上面
    expect(shapes.findIndex((s) => s.kind === 'river')).toBeGreaterThan(shapes.findIndex((s) => s.kind === 'line'));
  });
});

describe('复测后补的', () => {
  it('点在汇合处：选中的是大河，不是挨着它的一两格的小支流', () => {
    const { w } = setup();
    const d = w.derived;
    const thr = w.small.planet.riverThreshold;
    let checked = 0;
    for (const L of riverLines(w)) {
      if (L.guide !== undefined || !L.cells || L.points.length < 2) continue;
      const tail = L.cells[L.cells.length - 1];
      const own = L.cells[L.cells.length - 2];
      // 小支流（门槛的 1–2 倍）汇进大河（10 倍以上）的那一点
      if (!isRiverCell(w, d, own) || d.discharge[own] > 2 * thr || d.discharge[tail] < 10 * thr) continue;
      const [x, y] = L.points[L.points.length - 1];
      const z = zoomOf(w);
      const h = riverAt(w, x, y, SNAP_PX / z, findCell(w.mesh, x, y));
      expect(h).not.toBeNull();
      const stem = riverStem(w, d, h!.ref.kind === 'natural' ? h!.ref.cell : -1).cells;
      expect(stem.includes(tail)).toBe(true);
      expect(stem.includes(own)).toBe(false);
      if (++checked >= 5) break;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('按下时还是自然的河、松手前它已经固定成画的河（上一笔改完了）：改的是那条画的河，不再新建一条', async () => {
    const { eng, w, t } = setup();
    const f = w.derived.features.filter((x) => x.type === 'river' && x.name && x.guide === undefined).sort((a, b) => b.cells.length - a.cells.length)[0];
    const cell = Array.from(f.cells).find((c) => isRiverCell(w, w.derived, c) && w.derived.discharge[c] > 2 * w.small.planet.riverThreshold)!;
    selectedRiver.value = { kind: 'natural', cell };
    const T = targetOf(w, { kind: 'natural', cell })!;
    const H = handlesOf(T, zoomOf(w));
    const j = Math.floor(H.length / 2);
    const P = T.points[H[j]];
    t.down?.(ptr(w, P));
    const to: Pt = [P[0], P[1] + 0.5 * w.mesh.spacing];
    for (const q of line(w, P, to).slice(1)) t.move?.(ptr(w, q), true);
    // 这时上一笔改完了：这条河固定成了画的河，选着它
    eng.exec(pinCommand(w, cell)!.cmd);
    const g = eng.world.small.guides[eng.world.small.guides.length - 1];
    world.value = { ...eng.world };
    selectedRiver.value = { kind: 'guide', id: g.id };
    await t.up?.(ptr(w, to));
    const calls = vi.mocked(exec).mock.calls;
    // 改的是那条画的河（同一个 id），绝不另加一条
    expect(calls.length).toBe(1);
    const cmd = lastExec();
    expect(cmd.op).toBe('update_guide');
    if (cmd.op === 'update_guide') expect(cmd.id).toBe(g.id);
  });

  it('有河流类型的规则时，新画的河默认是普通的河（不按规则变成血河），“按规则”要自己选', () => {
    const { eng, w } = setup();
    eng.exec({ op: 'set_river_type', type: { id: 'blood', name: '血河', color: '#8f1414', scripts: { match: { api: 1, src: 'return 流量 > 3 * 河流门槛;' } } } });
    world.value = { ...eng.world };
    setOptions({ riverType: '' });
    expect(chosenRiverType(world.value)).toEqual({ type: PLAIN_RIVER });
    setOptions({ riverType: BY_RULES });
    expect(chosenRiverType(world.value)).toEqual({});
    setOptions({ riverType: 'blood' });
    expect(chosenRiverType(world.value)).toEqual({ type: 'blood' });
    setOptions({ riverType: '' });
    void w;
  });

  it('穿山挖出峡谷的一笔：松手后顶部说“挖出了峡谷（最深约 N m）”', () => {
    const { w } = setup();
    const { mesh, derived: d } = w;
    for (let i = 0; i < mesh.n; i += 5) {
      if (!w.causes.land[i] || d.elevation[i] < 1500) continue;
      for (let k = 0; k < 8; k++) {
        const ang = (k * Math.PI) / 4;
        const a: Pt = [mesh.x[i] - 4 * mesh.spacing * Math.cos(ang), mesh.y[i] - 4 * mesh.spacing * Math.sin(ang)];
        const b: Pt = [mesh.x[i] + 4 * mesh.spacing * Math.cos(ang), mesh.y[i] + 4 * mesh.spacing * Math.sin(ang)];
        const s = line(w, a, b);
        const plan = planCourse(w, d, s, opts(w));
        if (plan.blocked || plan.reroute || plan.merge || plan.gorge < 100) continue;
        const c = newCourse(w, plan, s);
        expect(c.cmd?.op === 'add_guide' && c.cmd.label).toContain('挖出了峡谷（最深约');
        return;
      }
    }
    throw new Error('找不到穿山的一笔');
  });
});
