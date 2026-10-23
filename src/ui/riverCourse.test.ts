import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Command } from '../../core/commands';
import { findCell } from '../../core/mesh';
import { type CoursePlan, endCourseAt, extendCourse, isRiverCell, planCourse, planRiver, rerouteCourse, riverStem, spliceCourse } from '../../core/select';
import { continents, engineFor } from '../../core/testing/fixtures';
import type { World } from '../../core/world';
import { riverLines } from '../render/overlay';
import { busy, exec, previewCommand, riverPending, riverStyleOverride, selectedRiver, setOptions, toast, world } from '../state';
import { lineOf, naturalFeatureAt, newCourse, pinCommand, rerouteOf, riverAt, riverInfo, riverTool, spliceTol, unwaterTool } from './riverCourse';
import type { Pointer } from './tools';

// 画河的手势：自定义走向一笔 → 松手发的命令与预览是同一份；穿过别的河时先问一句（截走它 / 到这里汇入 / 取消，
// 回车、Esc、Shift）；点一下河选中它；在选中的画的河上拖是重画一段；固定自然的河名字不变

// 命令不真的发给引擎（这里没有 worker）：只看工具发了什么；确切预览不回来
vi.mock('../state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../state')>()),
  exec: vi.fn(async () => true),
  previewCommand: vi.fn(async () => null),
}));

type Pt = [number, number];
// 一格 20 个屏幕像素
const PX_PER_CELL = 20;
const zoomOf = (w: World) => PX_PER_CELL / w.mesh.spacing;

function ptr(w: World, [x, y]: Pt, shift = false): Pointer {
  const z = zoomOf(w);
  const inside = x >= 0 && y >= 0 && x <= w.mesh.width && y <= w.mesh.height;
  return { x, y, cell: inside ? findCell(w.mesh, x, y) : -1, sx: x * z, sy: y * z, shift, alt: false };
}

// 一条直线，点与点隔 7 个屏幕像素以上（工具每一点都记下：拖开 6 像素才算拖、每 2 像素以上记一点）
function line(w: World, a: Pt, b: Pt): Pt[] {
  const n = Math.max(2, Math.floor((Math.hypot(b[0] - a[0], b[1] - a[1]) * zoomOf(w)) / 7));
  const out: Pt[] = [];
  for (let k = 0; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  return out;
}

function drag(t: ReturnType<typeof riverTool>, w: World, pts: Pt[], shift = false) {
  t.down?.(ptr(w, pts[0]));
  for (const p of pts.slice(1)) t.move?.(ptr(w, p, shift), true);
  return t.up?.(ptr(w, pts[pts.length - 1], shift));
}

const at = (w: World, c: number): Pt => [w.mesh.x[c], w.mesh.y[c]];
const opts = (w: World) => ({ endOnLand: 'sink' as const, px: 1 / zoomOf(w) });

// 横穿一条自然的大河（垂直于它的流向，两头各 4 格，都在陆地上、不是河）
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
    const ca = findCell(mesh, ...a);
    if (!w.causes.land[ca] || d.lake[ca] === 1 || isRiverCell(w, d, ca)) continue;
    const plan = planCourse(w, d, stroke, opts(w));
    if (!plan.blocked && plan.end === 'sink' && plan.crossings.length === 1 && !plan.reroute && !plan.merge) return { stroke, plan };
  }
  throw new Error('找不到横穿一条大河的线');
}

// 一笔不碰任何河、不往高处流的河（3–5 格），画到陆地上：endOnLand 为 sink 时在那里消失，为 flow 时之后顺地势流下去
function quietStroke(w: World, endOnLand: 'sink' | 'flow' = 'sink'): { stroke: Pt[]; plan: CoursePlan } {
  const { mesh, derived: d } = w;
  for (let c = 0; c < mesh.n; c += 7) {
    if (!w.causes.land[c] || d.lake[c] === 1 || isRiverCell(w, d, c) || d.elevation[c] < 300) continue;
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
  riverPending.value = null;
  setOptions({ riverMode: 'course', riverEnd: 'sink', riverFlow: 4 });
  vi.mocked(exec).mockClear();
  vi.mocked(previewCommand).mockClear();
  return { eng, w, t: riverTool(() => zoomOf(w)) };
}

beforeEach(() => {
  riverPending.value?.cancel();
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
    // 折线按整数存
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

  it('松手后还在算：鼠标离开地图也一直画着松手时的那条河（画河不排队，与“重画这一片”一样不闪回原样），算完才去掉', async () => {
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

  it('手抖（不到 6 像素）不算画：在空地上点一下是顺地势的新河（只挖河床、自动起名），不是自定义走向', async () => {
    const { w, t } = setup();
    const { stroke } = quietStroke(w);
    t.down?.(ptr(w, stroke[0]));
    await t.up?.(ptr(w, [stroke[0][0] + 0.1 * w.mesh.spacing, stroke[0][1]]));
    expect(exec).toHaveBeenCalledTimes(1);
    const cmd = lastExec();
    if (cmd.op !== 'add_guide') throw new Error();
    expect(cmd.guide.path).toBeUndefined();
    expect(cmd.guide).toMatchObject({ spring: true, flow: 4, name: '' });
  });
});

describe('穿过别的河：先问一句', () => {
  it('不按 Shift 松手：不执行，底部条写会截走哪条河，同时开始算截走后的确切结果', async () => {
    const { w, t } = setup();
    const { stroke, plan } = acrossRiver(w);
    t.down?.(ptr(w, stroke[0]));
    for (const p of stroke.slice(1)) t.move?.(ptr(w, p), true);
    expect(t.preview().hint).toMatch(/^会截走.+ · 松手后确认$/);
    await t.up?.(ptr(w, stroke[stroke.length - 1]));
    expect(exec).not.toHaveBeenCalled();
    expect(riverPending.value?.text).toMatch(/^会截走/);
    const cmd = newCourse(w, plan, stroke).cmd!;
    // 松手时就算：之后点“截走它”时 worker 直接采用这个结果
    expect(vi.mocked(previewCommand).mock.calls.some(([c]) => JSON.stringify(c) === JSON.stringify(cmd))).toBe(true);
    // 鼠标离开地图后预览也留着
    t.leave?.();
    expect(t.keep?.()).toBe(true);
    expect(t.preview().shapes.some((s) => s.kind === 'river')).toBe(true);
  });

  it('回车 = 截走它：执行的就是预览的那条命令', async () => {
    const { w, t } = setup();
    const { stroke, plan } = acrossRiver(w);
    await drag(t, w, stroke);
    expect(t.enter?.()).toBe(true);
    await Promise.resolve();
    expect(lastExec()).toEqual(newCourse(w, plan, stroke).cmd);
    expect(riverPending.value).toBeNull();
  });

  it('到这里汇入：河道在穿过的那条河上结束', async () => {
    const { w, t } = setup();
    const { stroke, plan } = acrossRiver(w);
    await drag(t, w, stroke);
    const join = riverPending.value!.join;
    expect(join).not.toBeNull();
    await join!();
    const want = newCourse(w, endCourseAt(w, w.derived, plan, plan.crossings[0].from), stroke).cmd!;
    expect(lastExec()).toEqual(want);
    if (want.op !== 'add_guide') throw new Error();
    expect(want.guide.cells[want.guide.cells.length - 1]).toBe(plan.cells[plan.crossings[0].from]);
    expect(want.guide.end).toBeUndefined();
  });

  it('Esc、取消、再按一下：什么都不做', async () => {
    const { w, t } = setup();
    const { stroke } = acrossRiver(w);
    await drag(t, w, stroke);
    expect(t.escape?.()).toBe(true);
    expect(riverPending.value).toBeNull();
    expect(t.escape?.()).toBe(false);
    await drag(t, w, stroke);
    riverPending.value!.cancel();
    expect(riverPending.value).toBeNull();
    await drag(t, w, stroke);
    // 等着确认时在地图上再按一下：只是不截了
    t.down?.(ptr(w, stroke[0]));
    expect(riverPending.value).toBeNull();
    await t.up?.(ptr(w, stroke[0]));
    expect(exec).not.toHaveBeenCalled();
  });

  it('按住 Shift 松手：直接截走', async () => {
    const { w, t } = setup();
    const { stroke, plan } = acrossRiver(w);
    await drag(t, w, stroke, true);
    expect(riverPending.value).toBeNull();
    expect(lastExec()).toEqual(newCourse(w, plan, stroke).cmd);
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

describe('在选中的画的河上拖是重画一段', () => {
  it('从河上拖出去再拖回河上：发 update_guide，只换中间那段，名字、大小照旧', async () => {
    const { eng, t: _t } = setup();
    void _t;
    const w0 = eng.world;
    const { plan, stroke } = quietStroke(w0);
    const long = planCourse(w0, w0.derived, [...stroke, ...line(w0, stroke[stroke.length - 1], [stroke[stroke.length - 1][0] + 4 * w0.mesh.spacing, stroke[stroke.length - 1][1]]).slice(1)], opts(w0));
    const use = !long.blocked && !long.crossings.length && long.cells.length > plan.cells.length ? long : plan;
    eng.exec(newCourse(w0, use, stroke).cmd!);
    const w = eng.world;
    world.value = w;
    const g = w.small.guides[w.small.guides.length - 1];
    selectedRiver.value = { kind: 'guide', id: g.id };
    const t = riverTool(() => zoomOf(w));
    const L = lineOf(w, g).points;
    // 从线上第 a 点出发，往旁边绕出去一格半，回到第 b 点
    let done = false;
    for (let a = 2; a < L.length / 2 && !done; a++) {
      for (let b = L.length - 3; b > a + 6 && !done; b--) {
        const [ax, ay] = L[a];
        const [bx, by] = L[b];
        const nx = -(by - ay);
        const ny = bx - ax;
        const nl = Math.hypot(nx, ny) || 1;
        const off = 1.5 * w.mesh.spacing;
        const mid: Pt = [(ax + bx) / 2 + (nx / nl) * off, (ay + by) / 2 + (ny / nl) * off];
        const s = [...line(w, [ax, ay], mid), ...line(w, mid, [bx, by]).slice(1)];
        const r = spliceCourse(w, w.derived, g, s, { endOnLand: 'sink', px: 1 / zoomOf(w), tol: spliceTol(w, zoomOf(w)) });
        if ('blocked' in r || r.plan.crossings.length) continue;
        vi.mocked(exec).mockClear();
        t.move?.(ptr(w, s[0]), false);
        expect(t.preview().hint).toBe('从这里拖是重画这一段');
        await drag(t, w, s);
        const cmd = lastExec();
        expect(cmd).toMatchObject({ op: 'update_guide', id: g.id, patch: r.patch });
        if (cmd.op !== 'update_guide') throw new Error();
        expect(Object.keys(cmd.patch).sort()).toEqual(['cells', 'path']);
        expect(selectedRiver.value).toEqual({ kind: 'guide', id: g.id });
        done = true;
      }
    }
    expect(done).toBe(true);
  });
});

describe('从画过的河的源头再画（没选中它时）', () => {
  // 先画好一条河，世界换成画好之后的
  function drawn() {
    const { eng, t: _t } = setup();
    void _t;
    const w0 = eng.world;
    const { plan, stroke } = quietStroke(w0);
    // 中等的河：重画后大小的标签多半不变
    setOptions({ riverFlow: 20 });
    eng.exec(newCourse(w0, plan, stroke).cmd!);
    const w = eng.world;
    world.value = w;
    const g = w.small.guides[w.small.guides.length - 1];
    const name = w.derived.features.find((f) => f.guide === g.id)!.name;
    return { eng, w, g, name, t: riverTool(() => zoomOf(w)) };
  }
  // 从这条河的源头往各个方向画 4 格，找一笔不碰别的河、画得出来的
  function fromSource(w: World, src: number, ok: (s: Pt[]) => boolean): Pt[] {
    for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI) / 8;
      const s = line(w, at(w, src), [w.mesh.x[src] + 4 * w.mesh.spacing * Math.cos(a), w.mesh.y[src] + 4 * w.mesh.spacing * Math.sin(a)]);
      if (ok(s)) return s;
    }
    throw new Error('从源头画不出来');
  }

  it('自定义走向：改的是同一条河道（update_guide），自动起的名字照旧（名字随大小、地形的标签变，标签没变时一字不差）', async () => {
    const { eng, w, g, name, t } = drawn();
    const tags = (e: typeof eng) => e.world.derived.features.find((f) => f.guide === g.id)?.tags.join();
    const s = fromSource(w, g.cells[0], (s) => {
      const p = planCourse(w, w.derived, s, opts(w));
      if (p.blocked || !p.reroute || p.crossings.length || p.cells.join() === g.cells.join()) return false;
      const e = eng.clone();
      e.exec(newCourse(w, p, s).cmd!);
      return tags(e) === tags(eng);
    });
    vi.mocked(exec).mockClear();
    // 从源头起笔：悬停时就写出会重画整条；松手后先问一句，点“重画整条「名字」”才改
    t.move?.(ptr(w, s[0]), false);
    expect(t.preview().hint).toContain('重画整条河');
    await drag(t, w, s);
    expect(exec).not.toHaveBeenCalled();
    expect(riverPending.value?.confirm).toBe(`重画整条「${name}」`);
    await riverPending.value!.capture();
    const cmd = lastExec();
    expect(cmd).toEqual(newCourse(w, planCourse(w, w.derived, s, opts(w)), s).cmd);
    expect(cmd).toMatchObject({ op: 'update_guide', id: g.id });
    if (cmd.op !== 'update_guide') throw new Error();
    expect(Object.keys(cmd.patch)).toEqual(expect.arrayContaining(['cells', 'path']));
    expect(cmd.patch.name).toBeUndefined();
    eng.exec(cmd);
    expect(eng.world.small.guides.map((x) => x.id)).toContain(g.id);
    expect(eng.world.derived.features.find((f) => f.guide === g.id)?.name).toBe(name);
  });

  it('顺地势：同样改这条河道，原来画的折线不要了', async () => {
    const { w, g, t } = drawn();
    setOptions({ riverMode: 'flow' });
    // 工具记下的是拖过的格
    const cellsOf = (s: Pt[]) => s.map((p) => findCell(w.mesh, p[0], p[1])).filter((c, k, a) => k === 0 || c !== a[k - 1]);
    const s = fromSource(w, g.cells[0], (s) => {
      const p = planRiver(w, w.derived, cellsOf(s));
      return !p.blocked && !p.same && p.reroute && p.cells.length > 2;
    });
    vi.mocked(exec).mockClear();
    await drag(t, w, s);
    const cmd = lastExec();
    expect(cmd).toMatchObject({ op: 'update_guide', id: g.id, patch: { cells: planRiver(w, w.derived, cellsOf(s)).cells, path: null } });
  });

  it('接到一条画的河的源头上：提示写“往上游接长”，不是“汇入”它自己', () => {
    const { w, g, t } = drawn();
    const src = g.cells[0];
    const tries: Pt[][] = [];
    for (let k = 0; k < 16; k++) {
      const a = (k * Math.PI) / 8;
      tries.push(line(w, [w.mesh.x[src] + 3 * w.mesh.spacing * Math.cos(a), w.mesh.y[src] + 3 * w.mesh.spacing * Math.sin(a)], at(w, src)));
    }
    const s = tries.find((s) => {
      const c = findCell(w.mesh, ...s[0]);
      if (!w.causes.land[c] || w.derived.lake[c] === 1 || isRiverCell(w, w.derived, c)) return false;
      const p = planCourse(w, w.derived, s, opts(w));
      return !p.blocked && p.merge === g.id && !p.crossings.length;
    });
    expect(s).toBeDefined();
    t.down?.(ptr(w, s![0]));
    for (const p of s!.slice(1)) t.move?.(ptr(w, p), true);
    const hint = t.preview().hint!;
    expect(hint).toContain('往上游接长');
    expect(hint).not.toContain('汇入');
    t.cancel?.();
  });
});

describe('整个星球：鼠标在平铺的另一份上', () => {
  it('点中的是同一格（不是线段另一头的那格）', () => {
    const eng = engineFor({ seed: 4, cells: 4000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    const w = eng.world;
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
      expect(previewCommand).toHaveBeenCalledWith({ op: 'remove_guide', id: g.id });
      await t.click?.(p);
      expect(lastExec()).toEqual({ op: 'remove_guide', id: g.id });
      expect(selectedRiver.value).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('续画（第九轮 B）：从一条河上起笔', () => {
  // 一条大河中间的一格，从它往旁边画 4 格的一笔：改道，不穿过别的河，下游会变干
  function middleStroke(w: World): { stroke: Pt[]; plan: CoursePlan } {
    const { mesh, derived: d } = w;
    const thr = w.small.planet.riverThreshold;
    for (let c = 0; c < mesh.n; c++) {
      const r = d.receiver[c];
      if (!isRiverCell(w, d, c) || d.discharge[c] < 3 * thr || r < 0 || !isRiverCell(w, d, r) || w.small.guides.length) continue;
      const dx = mesh.x[r] - mesh.x[c];
      const dy = mesh.y[r] - mesh.y[c];
      const len = Math.hypot(dx, dy);
      for (const side of [1, -1]) {
        const stroke = line(w, at(w, c), [mesh.x[c] - (side * dy * 4 * mesh.spacing) / len, mesh.y[c] + (side * dx * 4 * mesh.spacing) / len]);
        const plan = planCourse(w, d, stroke, opts(w));
        if (!plan.blocked && plan.reroute && plan.cells[0] === c && !plan.crossings.length && plan.dried.length >= 2) return { stroke, plan };
      }
    }
    throw new Error('找不到从大河中间起笔的一笔');
  }

  it('从河中间起笔：悬停时就说是改道；松手后不改，底部条问“从这里改道：「名字」下游约 N km 会变干”，点“改道”才改', async () => {
    const { w, t } = setup();
    const { stroke, plan } = middleStroke(w);
    t.move?.(ptr(w, stroke[0]), false);
    const hover = t.preview();
    expect(hover.hint).toContain('从这里起笔：改道');
    expect(hover.warn).toBe(true);
    t.down?.(ptr(w, stroke[0]));
    for (const p of stroke.slice(1)) t.move?.(ptr(w, p), true);
    expect(t.preview().hint).toMatch(/^从这里改道：.+ · 松手后确认$/);
    // Shift 也不跳过这一问
    await t.up?.(ptr(w, stroke[stroke.length - 1], true));
    expect(exec).not.toHaveBeenCalled();
    expect(riverPending.value?.confirm).toBe('改道');
    expect(riverPending.value?.text).toMatch(/^从这里改道：.+下游约 [\d,]+ km 会变干$/);
    expect(riverPending.value?.join).toBeNull();
    // 取消：什么都不做
    riverPending.value!.cancel();
    expect(riverPending.value).toBeNull();
    expect(exec).not.toHaveBeenCalled();
    // 再画一次，点“改道”：还是这一条河——主干从源头到起笔的那一格加上新画的一段，固定成一条画的河，沿用它的地名
    await drag(t, w, stroke);
    expect(exec).not.toHaveBeenCalled();
    await riverPending.value!.capture();
    const rr = rerouteCourse(w, w.derived, stroke, opts(w))!;
    expect(lastExec()).toEqual(rerouteOf(w, null, rr.plan, stroke).cmd);
    const cmd = lastExec();
    if (cmd.op !== 'add_guide') throw new Error(cmd.op);
    const stem = riverStem(w, w.derived, plan.cells[0]).cells;
    const k = stem.indexOf(plan.cells[0]);
    expect(k).toBeGreaterThan(0);
    expect(cmd.guide.cells.slice(0, k + 1)).toEqual(stem.slice(0, k + 1));
    expect(cmd.guide.cells.slice(k)).toEqual(plan.cells);
    expect(cmd.guide).toMatchObject({ spring: false, locked: true });
    const f = naturalFeatureAt(w, plan.cells[0]);
    if (f) expect(cmd.guide.nameKey).toBe(f.key);
    expect(riverPending.value).toBeNull();
  });

  it('从画的、在终点消失的河的终点起笔：往下游接长这条河（同一条河道，名字、大小照旧），不用确认', async () => {
    const { eng, w: w0 } = setup();
    const { plan, stroke } = quietStroke(w0);
    eng.exec(newCourse(w0, plan, stroke).cmd!);
    const w = eng.world;
    world.value = w;
    const g = w.small.guides[w.small.guides.length - 1];
    expect(g.end).toBe('sink');
    const T = g.cells[g.cells.length - 1];
    const t = riverTool(() => zoomOf(w));
    let s: Pt[] | null = null;
    let ext: ReturnType<typeof extendCourse> = null;
    for (let k = 0; k < 16 && !s; k++) {
      const a = (k * Math.PI) / 8;
      const c = line(w, at(w, T), [w.mesh.x[T] + 4 * w.mesh.spacing * Math.cos(a), w.mesh.y[T] + 4 * w.mesh.spacing * Math.sin(a)]);
      const x = extendCourse(w, w.derived, c, opts(w));
      if (x && !('blocked' in x) && !x.plan.crossings.length && x.plan.drawn > g.cells.length) {
        s = c;
        ext = x;
      }
    }
    expect(s).not.toBeNull();
    if (!ext || 'blocked' in ext) throw new Error();
    t.move?.(ptr(w, s![0]), false);
    expect(t.preview().hint).toContain('往下游接着画');
    t.down?.(ptr(w, s![0]));
    for (const p of s!.slice(1)) t.move?.(ptr(w, p), true);
    const pv = t.preview();
    expect(pv.hint).toContain('往下游接长');
    // 原来那条河先不画：预览画的是接长后的整条河
    expect(riverStyleOverride.value).toEqual({ id: g.id, hide: true });
    await t.up?.(ptr(w, s![s!.length - 1]));
    expect(riverPending.value).toBeNull();
    const cmd = lastExec();
    expect(cmd).toMatchObject({ op: 'update_guide', id: g.id, patch: ext.patch });
    if (cmd.op !== 'update_guide') throw new Error();
    expect(cmd.patch.cells!.slice(0, g.cells.length)).toEqual(g.cells);
    expect(cmd.label).toContain('往下游接长');
    expect(riverStyleOverride.value).toBeNull();
  });
});

describe('续画（第九轮 B）：抢走旁边小河的集水区', () => {
  it('确切结果里旁边的自然小河变干了（不是截走、改道的那条）：提示“旁边的小河会并进来（N 格）”', async () => {
    const { eng, w, t } = setup();
    const { mesh, derived: d } = w;
    // 找一笔不碰别的河、确切结果里有旁边的小河变干的
    let found: { stroke: Pt[]; side: number; r: Awaited<ReturnType<typeof previewCommand>> } | null = null;
    for (let c = 0; c < mesh.n && !found; c += 13) {
      if (!w.causes.land[c] || d.lake[c] === 1 || isRiverCell(w, d, c)) continue;
      const stroke = line(w, at(w, c), [mesh.x[c] + 6 * mesh.spacing, mesh.y[c] + 2 * mesh.spacing]);
      const plan = planCourse(w, d, stroke, opts(w));
      if (plan.blocked || plan.reroute || plan.merge || plan.crossings.length) continue;
      const course = newCourse(w, plan, stroke);
      const r = eng.preview(course.cmd!);
      const own = new Set(plan.cells);
      const side = r.riverRemoved.filter((i) => !own.has(i)).length;
      if (side) found = { stroke, side, r };
    }
    expect(found).not.toBeNull();
    vi.mocked(previewCommand).mockResolvedValue(found!.r);
    try {
      t.down?.(ptr(w, found!.stroke[0]));
      for (const p of found!.stroke.slice(1)) t.move?.(ptr(w, p), true);
      t.preview();
      await vi.waitFor(() => expect(t.preview().hint).toContain(`旁边的小河会并进来（${found!.side} 格）`), { timeout: 2000 });
      t.cancel?.();
    } finally {
      vi.mocked(previewCommand).mockResolvedValue(null);
    }
  });
});

describe('第九轮 C：从河中间改道还是同一条河；悬停与按下一致；顺地势也先问；说法', () => {
  // 先画好一条长一些的河（画完接着流），世界换成画好之后的
  function drawnLong() {
    const { eng } = setup();
    const w0 = eng.world;
    setOptions({ riverEnd: 'flow', riverFlow: 20 });
    const { plan, stroke } = quietStroke(w0, 'flow');
    eng.exec(newCourse(w0, plan, stroke).cmd!);
    const w = eng.world;
    world.value = w;
    const g = w.small.guides[w.small.guides.length - 1];
    const name = w.derived.features.find((f) => f.guide === g.id)?.name ?? null;
    return { eng, w, g, name, t: riverTool(() => zoomOf(w)) };
  }
  // 从画的河中间第 k 格往旁边画 4 格、不穿过别的河的一笔
  function fromMiddle(w: World, g: { cells: number[] }) {
    for (let k = 2; k < g.cells.length - 2; k++) {
      const c = g.cells[k];
      if (!isRiverCell(w, w.derived, c)) continue;
      for (let a = 0; a < 16; a++) {
        const ang = (a * Math.PI) / 8;
        const s = line(w, at(w, c), [w.mesh.x[c] + 4 * w.mesh.spacing * Math.cos(ang), w.mesh.y[c] + 4 * w.mesh.spacing * Math.sin(ang)]);
        const r = rerouteCourse(w, w.derived, s, { endOnLand: 'flow', px: 1 / zoomOf(w) });
        if (r && r.guide && !r.plan.blocked && !r.plan.crossings.length && r.plan.cells.join() !== g.cells.join()) return { s, k, r };
      }
    }
    throw new Error('从画的河中间画不出来');
  }

  it('自定义走向从一条画的河中间改道：还是这一条河（同一个 id、名字），从源头到起笔照旧，之后照新画的走；预览时原来那条先不画', async () => {
    const { eng, w, g, name, t } = drawnLong();
    const { s, k, r } = fromMiddle(w, g);
    vi.mocked(exec).mockClear();
    t.move?.(ptr(w, s[0]), false);
    expect(t.preview().hint).toContain('从这里起笔：改道');
    t.down?.(ptr(w, s[0]));
    for (const p of s.slice(1)) t.move?.(ptr(w, p), true);
    expect(t.preview().hint).toMatch(/^从这里改道：/);
    expect(riverStyleOverride.value).toEqual({ id: g.id, hide: true });
    await t.up?.(ptr(w, s[s.length - 1]));
    expect(exec).not.toHaveBeenCalled();
    expect(riverPending.value?.confirm).toBe('改道');
    // 不会说截走它自己
    expect(riverPending.value?.text).not.toContain('截走');
    await riverPending.value!.capture();
    const cmd = lastExec();
    expect(cmd).toEqual(rerouteOf(w, g, r.plan, s).cmd);
    if (cmd.op !== 'update_guide') throw new Error(cmd.op);
    expect(cmd.id).toBe(g.id);
    expect(cmd.patch.cells!.slice(0, k + 1)).toEqual(g.cells.slice(0, k + 1));
    expect(cmd.patch.name).toBeUndefined();
    expect(cmd.patch.flow).toBeUndefined();
    const before = eng.world.small.guides.length;
    eng.exec(cmd);
    expect(eng.world.small.guides.length).toBe(before);
    const after = eng.world.small.guides.find((x) => x.id === g.id)!;
    expect(after.flow).toBe(g.flow);
    expect(after.spring).toBe(g.spring);
    if (name) expect(eng.world.derived.features.find((f) => f.guide === g.id)?.name).toBe(name);
  });



});
