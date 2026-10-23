import { describe, expect, it, vi } from 'vitest';
import { digestWorld } from '../tools/hash';
import { type Command, Dirty, commandSchema, guideDirty, truncateGuide } from './commands';
import { Engine } from './engine';
import { lakeArea, waterLevel } from './elevation';
import { findCell } from './mesh';
import { route } from './routing';
import { courseLine, courseStep, decodePath, encodePath, pathSamples, smoothCourse } from './rivers';
import { type CoursePlan, continueCourse, endCourseAt, guideEnd, guideFlow, guidePoints, guideWarnings, isRiverCell, planCourse, riverStem, spliceCourse, stemPath } from './select';
import { continents, engineFor } from './testing/fixtures';
import { type Guide, guideSchema, type World } from './world';

// 第八轮第二批：自定义走向的河。河完全照着画的线走，只挖河床（周围的地形、气候、山名都不变），
// 可以在终点消失、截走别的河、改一段、固定自然的河

type Pt = [number, number];

function line(a: Pt, b: Pt, n = 40): Pt[] {
  const out: Pt[] = [];
  for (let k = 0; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  return out;
}

const at = (w: World, c: number): Pt => [w.mesh.x[c], w.mesh.y[c]];

// 松手后执行的命令：新画的河一律只挖河床、自动起名
function courseCmd(plan: CoursePlan, extra: Partial<Guide> = {}): Command {
  return {
    op: 'add_guide',
    guide: { cells: plan.cells, path: encodePath(plan.path), locked: true, spring: true, flow: 2, name: '', ...(plan.end === 'sink' ? { end: 'sink' } : {}), ...extra },
  };
}

// 陆地上每一格都流向河道的下一格
function followed(w: World, cells: readonly number[]): boolean {
  for (let k = 0; k + 1 < cells.length && w.causes.land[cells[k]]; k++) if (w.derived.receiver[cells[k]] !== cells[k + 1]) return false;
  return true;
}

const riverSet = (w: World) => [...Array(w.mesh.n).keys()].filter((i) => isRiverCell(w, w.derived, i)).join(',');
const relief = (w: World) =>
  w.derived.features
    .filter((f) => f.type === 'range' || f.type === 'peak')
    .map((f) => `${f.key}=${f.name}`)
    .join('|');

// 横穿最大的山脉（过它的最高峰，垂直于山脉的走向），两头各伸出 6 格：在这个世界上一头入海
function acrossRange(w: World): { stroke: Pt[]; peak: number } {
  const { mesh, derived: d } = w;
  const range = d.features.filter((f) => f.type === 'range').sort((a, b) => b.cells.length - a.cells.length)[0];
  let peak = range.cells[0];
  for (const c of range.cells) if (d.elevation[c] > d.elevation[peak]) peak = c;
  const ang = range.angle + Math.PI / 2;
  const L = 6 * mesh.spacing;
  const [x, y] = at(w, peak);
  return { stroke: line([x - Math.cos(ang) * L, y - Math.sin(ang) * L], [x + Math.cos(ang) * L, y + Math.sin(ang) * L]), peak };
}

// 从低处往高处画：起点比终点低至少 minUp 米，终点在陆地上（不是河、湖）；找不到时返回 null
function uphillStroke(w: World, end: 'sink' | 'river', minUp: number): { plan: CoursePlan; stroke: Pt[] } | null {
  const { mesh, derived: d, causes } = w;
  const targets = [...Array(mesh.n).keys()]
    .filter((i) => causes.land[i] && d.lake[i] !== 1 && d.elevation[i] > 800 && isRiverCell(w, d, i) === (end === 'river'))
    .sort((a, b) => d.elevation[b] - d.elevation[a]);
  for (const T of targets.slice(0, 200)) {
    for (let i = 0; i < mesh.n; i++) {
      if (!causes.land[i] || d.lake[i] === 1 || isRiverCell(w, d, i)) continue;
      const dist = Math.hypot(mesh.x[i] - mesh.x[T], mesh.y[i] - mesh.y[T]) / mesh.spacing;
      if (dist < 3 || dist > 7 || d.elevation[i] > d.elevation[T] - minUp) continue;
      const stroke = line(at(w, i), at(w, T));
      const plan = planCourse(w, d, stroke, { endOnLand: 'sink' });
      if (plan.blocked || plan.end !== end || plan.crossings.length || plan.uphill < minUp) continue;
      if (end === 'river' && plan.join !== T) continue;
      return { plan, stroke };
    }
  }
  return null;
}

describe('画的河的数据', () => {
  it('河道、命令逐字照存，截断时只动有的项；写错的项名直接报错；同一格两次、id 重复都拒绝', () => {
    const g0 = { id: 'river-3', cells: [5, 6, 7], locked: true, spring: true, flow: 4 };
    expect(JSON.stringify(guideSchema.parse(g0))).toBe(JSON.stringify(g0));
    const cmd = { op: 'add_guide', guide: { cells: [5, 6, 7], locked: false, spring: false }, reroute: true, label: '让河改道' };
    expect(JSON.stringify(commandSchema.parse(cmd))).toBe(JSON.stringify(cmd));
    const w = continents().world;
    expect(JSON.stringify(truncateGuide(w, guideSchema.parse(g0), 1))).toBe(JSON.stringify({ ...g0, cells: [5, 6] }));
    const eng = continents();
    const plan = planCourse(eng.world, eng.world.derived, acrossRange(eng.world).stroke, { endOnLand: 'flow' });
    eng.exec(courseCmd(plan, { id: 'river-x' }));
    expect(() => eng.exec(courseCmd(plan, { id: 'river-x' }))).toThrow('已存在');
    const [a, b] = plan.cells;
    expect(() => eng.exec({ op: 'add_guide', guide: { cells: [a, b, a], locked: true, spring: true } })).toThrow('同一格两次');
    eng.exec({ op: 'update_guide', id: 'river-x', patch: { width: 2 } });
    // 写错的项名直接报错
    expect(() => eng.exec({ op: 'update_guide', id: eng.world.small.guides[0].id, patch: { widht: 2 } as never })).toThrow('参数无效');
  });

  it('update_guide 按改了什么重算；撤销后小数据逐字还原；重放一致', () => {
    const eng = continents();
    const w = eng.world;
    const plan = planCourse(w, w.derived, acrossRange(w).stroke, { endOnLand: 'flow' });
    // 另一条画的河（没有折线，顺地势画的那种）：一条与画的河不相干的大河的主干
    const other = w.derived.features.find((f) => f.type === 'river' && !plan.cells.some((c) => f.cells.includes(c)))!;
    const valley = riverStem(w, w.derived, other.anchor).cells;
    expect(valley.length).toBeGreaterThan(4);
    eng.exec(courseCmd(plan, { id: 'river-a' }));
    eng.exec({ op: 'add_guide', guide: { id: 'old-1', cells: valley, locked: true, spring: false } });
    const steps: [Command, Dirty][] = [
      [{ op: 'update_guide', id: 'river-a', patch: { name: '赤江' } }, Dirty.Names],
      [{ op: 'update_guide', id: 'river-a', patch: { salt: 2 } }, Dirty.Names],
      [{ op: 'update_guide', id: 'river-a', patch: { width: 2.5 } }, Dirty.None],
      [{ op: 'update_guide', id: 'river-a', patch: { flow: 6 } }, Dirty.Vegetation],
      [{ op: 'update_guide', id: 'river-a', patch: { cells: plan.cells.slice(0, -1), end: 'sink' } }, Dirty.Vegetation],
      [{ op: 'update_guide', id: 'river-a', patch: { type: 'blood' } }, Dirty.Vegetation],
      [{ op: 'update_guide', id: 'river-a', patch: { name: null } }, Dirty.Vegetation],
      // 改了走向：只挖河床，不用重算高程与气候
      [{ op: 'update_guide', id: 'old-1', patch: { cells: valley.slice(0, -1) } }, Dirty.Vegetation],
    ];
    const smalls: string[] = [JSON.stringify(w.small)];
    eng.takeRecomputed();
    for (const [cmd, dirty] of steps) {
      eng.exec(cmd);
      expect(eng.takeRecomputed(), JSON.stringify(cmd)).toBe(dirty);
      smalls.push(JSON.stringify(eng.world.small));
    }
    expect(eng.world.small.guides.find((g) => g.id === 'river-a')).not.toHaveProperty('name');
    expect(digestWorld(eng.world)).toEqual(digestWorld(Engine.fromDoc(eng.toDoc(), w.mesh).world));
    for (let k = steps.length; k > 0; k--) {
      eng.undo();
      expect(JSON.stringify(eng.world.small)).toBe(smalls[k - 1]);
    }
    expect(digestWorld(eng.world)).toEqual(digestWorld(Engine.fromDoc(eng.toDoc(), w.mesh).world));
    // 规则本身：只看有关的几项
    const g = guideSchema.parse({ id: 'r', cells: [1, 2] });
    expect(guideDirty([g], [{ ...g, width: 2 }])).toBe(Dirty.None);
    expect(guideDirty([g], [{ ...g, path: [0, 0, 1, 1] }])).toBe(Dirty.Names);
    expect(guideDirty([g], [{ ...g, nameKey: 'river:9' }])).toBe(Dirty.Vegetation);
    expect(guideDirty([g], [])).toBe(Dirty.Vegetation);
  });

  it('截走画过的河：它从第一次碰到的地方截断，折线也截在那里；撤销还原', () => {
    const eng = continents();
    const w = eng.world;
    const { mesh } = w;
    // B：往东画一段，不碰别的河
    let B: CoursePlan | null = null;
    for (let i = 0; i < mesh.n && !B; i += 7) {
      if (!w.causes.land[i] || w.derived.continentality[i] < 0.5 || isRiverCell(w, w.derived, i)) continue;
      const p = planCourse(w, w.derived, line(at(w, i), [mesh.x[i] + 14 * mesh.spacing, mesh.y[i] + 2 * mesh.spacing]), { endOnLand: 'flow' });
      if (!p.blocked && p.drawn >= 12 && !p.crossings.length && !p.reroute) B = p;
    }
    eng.exec(courseCmd(B!, { id: 'river-b' }));
    const before = JSON.stringify(w.small);
    // A：从南往北穿过 B 的中段
    const mid = B!.cells[Math.floor(B!.drawn / 2)];
    const A = planCourse(w, w.derived, line([mesh.x[mid] - 0.5 * mesh.spacing, mesh.y[mid] - 5 * mesh.spacing], [mesh.x[mid] + 0.5 * mesh.spacing, mesh.y[mid] + 5 * mesh.spacing]), {
      endOnLand: 'flow',
    });
    expect(A.blocked).toBeNull();
    const hit = A.crossings.find((x) => x.guide === 'river-b')!;
    expect(hit).toBeDefined();
    eng.exec({ ...courseCmd(A), capture: true } as Command);
    const b = w.small.guides.find((g) => g.id === 'river-b')!;
    const k = B!.cells.findIndex((c) => A.cells.slice(1, -1).includes(c));
    expect(b.cells).toEqual(B!.cells.slice(0, k + 1));
    // 折线截在 B 第一次进这格的地方
    const path = decodePath(b.path!);
    expect(findCell(mesh, ...path[path.length - 1])).toBe(b.cells[b.cells.length - 1]);
    expect(path.length).toBeLessThanOrEqual(B!.path.length + 1);
    // B 现在汇入 A，A 完全照着画的走
    expect(followed(w, A.cells)).toBe(true);
    expect(guideEnd(w, w.derived, b).kind).toBe('river');
    eng.undo();
    expect(JSON.stringify(w.small)).toBe(before);
  });
});

describe('只挖河床', () => {
  it('横穿最高的山入海：只有河道格变低、沿程不增，气候逐字节不变，水完全照着画的走，河道上没有湖', () => {
    const eng = continents();
    const w = eng.world;
    const d = w.derived;
    const plan = planCourse(w, d, acrossRange(w).stroke, { endOnLand: 'flow' });
    expect(plan.end).toBe('sea');
    expect(plan.gorge).toBeGreaterThan(1000);
    const before = { elevation: d.elevation.slice(), tS: d.tS.slice(), pS: d.pS.slice(), precip: d.precip.slice() };
    eng.exec(courseCmd(plan));
    const on = new Set(plan.cells);
    let lowered = 0;
    for (let i = 0; i < w.mesh.n; i++) {
      if (d.elevation[i] === before.elevation[i]) continue;
      expect(on.has(i), `格 ${i} 不在河道上却变了`).toBe(true);
      expect(d.elevation[i]).toBeLessThan(before.elevation[i]);
      lowered++;
    }
    expect(lowered).toBeGreaterThan(2);
    const body = plan.cells.filter((c) => w.causes.land[c]);
    for (let k = 1; k < body.length; k++) expect(d.elevation[body[k]]).toBeLessThanOrEqual(d.elevation[body[k - 1]]);
    expect(Buffer.from(d.tS.buffer).equals(Buffer.from(before.tS.buffer))).toBe(true);
    expect(Buffer.from(d.pS.buffer).equals(Buffer.from(before.pS.buffer))).toBe(true);
    expect(Buffer.from(d.precip.buffer).equals(Buffer.from(before.precip.buffer))).toBe(true);
    expect(followed(w, plan.cells)).toBe(true);
    expect(body.filter((c) => d.lake[c] === 1)).toEqual([]);
    // 只重算了水文起的几层
    expect(eng.lastTimings.elevation).toBeUndefined();
    expect(eng.lastTimings.climate).toBeUndefined();
  });

  it('往高处画到消失：照样完全按画的走，终点格的下游是 -1', () => {
    const eng = continents();
    const w = eng.world;
    const found = uphillStroke(w, 'sink', 300)!;
    expect(found).not.toBeNull();
    const { plan } = found;
    eng.exec(courseCmd(plan));
    const sink = plan.cells[plan.cells.length - 1];
    expect(followed(w, plan.cells)).toBe(true);
    expect(w.derived.receiver[sink]).toBe(-1);
    // 原来比终点高的格压平到比终点略高，不会挖到沿途最低处
    const before = continents().world.derived.elevation;
    for (const c of plan.cells.slice(0, -1)) if (before[c] > before[sink]) expect(w.derived.elevation[c]).toBeGreaterThan(w.derived.elevation[sink]);
    const g = w.small.guides[0];
    expect(guideEnd(w, w.derived, g).kind).toBe('sink');
    expect(guideWarnings(w, w.derived, g)).toEqual([]);
  });

  it('往高处汇入：照样完全按画的走，汇入的那条河不改道、不变干', () => {
    const eng = continents();
    const w = eng.world;
    const found = uphillStroke(w, 'river', 300)!;
    expect(found).not.toBeNull();
    const { plan } = found;
    const recv = w.derived.receiver[plan.join];
    const rivers = new Set(riverSet(w).split(','));
    eng.exec(courseCmd(plan));
    expect(followed(w, plan.cells)).toBe(true);
    expect(w.derived.receiver[plan.join]).toBe(recv);
    const now = new Set(riverSet(w).split(','));
    expect([...rivers].filter((c) => !now.has(c))).toEqual([]);
    expect(guideEnd(w, w.derived, w.small.guides[0])).toEqual({ kind: 'river', cell: plan.join });
  });

  it('在这里消失：终点以下的水少了；去掉“消失”水又流下去；撤销还原', () => {
    const eng = continents();
    const w = eng.world;
    // 横穿山脉入海的那条河，在入海前两格消失（顺坡而下，终点在陆地上）
    const plan = planCourse(w, w.derived, acrossRange(w).stroke, { endOnLand: 'flow' });
    const cells = plan.cells.slice(0, -2);
    eng.exec({ op: 'add_guide', guide: { id: 'river-s', cells, locked: true, spring: true, flow: 2, name: '', end: 'sink' } });
    expect(followed(w, cells)).toBe(true);
    const sink = cells[cells.length - 1];
    expect(w.derived.receiver[sink]).toBe(-1);
    const sinkQ = w.derived.discharge[sink];
    const digest = digestWorld(w);
    eng.exec({ op: 'update_guide', id: 'river-s', patch: { end: null } });
    const below = w.derived.receiver[sink];
    expect(below).toBeGreaterThanOrEqual(0);
    const flowing = w.derived.discharge[below];
    expect(cells).not.toContain(below);
    eng.undo();
    expect(digestWorld(w)).toEqual(digest);
    expect(w.derived.receiver[sink]).toBe(-1);
    expect(flowing - w.derived.discharge[below]).toBeGreaterThan(sinkQ * 0.9);
  });

  it('消失的河改回接着流：从画到的那格顺着地势流下去，流下去的那段也是这条河的格，水照着走、折线不动', () => {
    const eng = continents();
    const w = eng.world;
    const { mesh, derived: d } = w;
    // 一笔不碰别的河、画到陆地上就消失的河（起点不是河，终点也不在别的河上）
    let plan: CoursePlan | null = null;
    for (let c = 0; c < mesh.n && !plan; c += 7) {
      if (!w.causes.land[c] || d.lake[c] === 1 || isRiverCell(w, d, c) || d.elevation[c] < 300) continue;
      const p = planCourse(w, d, line(at(w, c), [mesh.x[c] + 4 * mesh.spacing, mesh.y[c] + 1.5 * mesh.spacing]), { endOnLand: 'sink' });
      if (!p.blocked && p.end === 'sink' && !p.crossings.length && !p.reroute && p.cells.length >= 4) plan = p;
    }
    expect(plan).not.toBeNull();
    eng.exec(courseCmd(plan!));
    const g = w.small.guides[0];
    expect(w.derived.receiver[g.cells[g.cells.length - 1]]).toBe(-1);
    const r = continueCourse(w, w.derived, g);
    if ('blocked' in r) throw new Error(r.blocked);
    expect(r.patch.cells!.slice(0, g.cells.length)).toEqual(g.cells);
    expect(r.patch.cells!.length).toBeGreaterThan(g.cells.length);
    expect(new Set(r.patch.cells).size).toBe(r.patch.cells!.length);
    expect(['sea', 'lake', 'river', 'edge']).toContain(r.plan.end);
    eng.exec({ op: 'update_guide', id: g.id, patch: r.patch });
    const after = w.small.guides[0];
    expect(after.end).toBeUndefined();
    expect(after.path).toEqual(g.path);
    expect(followed(w, after.cells)).toBe(true);
    // 流得出去（汇入的那条小河的上游可能被这段截走，那时就顺着它一直流到海里）
    expect(['sea', 'lake', 'river', 'edge']).toContain(guideEnd(w, w.derived, after).kind);
    expect(digestWorld(w)).toEqual(digestWorld(Engine.fromDoc(eng.toDoc(), w.mesh).world));
  });

  it('峡谷不让山改名：横穿最高的山脉之后，山脉、山峰的名字一个不变', () => {
    const eng = continents();
    const w = eng.world;
    const before = relief(w);
    const { stroke, peak } = acrossRange(w);
    // 一直画到海里；只画到山那边一点就消失
    for (const [end, s] of [
      ['flow', stroke],
      ['sink', stroke.slice(0, Math.ceil(stroke.length * 0.7))],
    ] as const) {
      const e = continents();
      const plan = planCourse(e.world, e.world.derived, s, { endOnLand: end });
      expect(plan.cells).toContain(peak);
      e.exec(courseCmd(plan));
      expect(e.world.derived.elevation[peak]).toBeLessThan(w.derived.elevation[peak] - 1000);
      expect(relief(e.world)).toBe(before);
    }
  });

  it('用户放的湖里不挖：出了湖从头算起，湖下游的河床不跟着湖底挖下去', () => {
    const eng = continents();
    const w = eng.world;
    const plan = planCourse(w, w.derived, acrossRange(w).stroke, { endOnLand: 'flow' });
    eng.exec(courseCmd(plan));
    const body = plan.cells.filter((c) => w.causes.land[c]);
    const c = body[Math.floor(body.length / 2)];
    eng.exec({ op: 'add_lake', lake: { cell: c, radius: 1, depth: 300, perennial: true } });
    const bowl = new Set(lakeArea(w, c, 1));
    const k = body.findIndex((x) => bowl.has(x));
    let last = k;
    while (last + 1 < body.length && bowl.has(body[last + 1])) last++;
    // 湖下游的格：不低于湖下游那段自己的累计最小值（与没有画的河时的地形比）
    const terrain = Engine.fromDoc({ ...eng.toDoc(), commands: eng.toDoc().commands.filter((x) => x.op !== 'add_guide') }, w.mesh).world.derived.elevation;
    let run = Infinity;
    for (const x of body.slice(last + 1)) {
      run = Math.min(run, terrain[x]);
      expect(w.derived.elevation[x]).toBeGreaterThanOrEqual(Math.fround(run) - 1e-3);
    }
    expect(digestWorld(w)).toEqual(digestWorld(Engine.fromDoc(eng.toDoc(), w.mesh).world));
  });
});

describe('流进湖、汇入', () => {
  it('终点的水面（挖河床时不挖到它以下）与路由填洼后的水面逐值相同', () => {
    const eng = continents();
    const w = eng.world;
    const C = [...Array(w.mesh.n).keys()].find((i) => w.causes.land[i] && w.derived.continentality[i] > 0.7)!;
    eng.exec({ op: 'add_lake', lake: { cell: C, radius: 40, depth: 300, perennial: true } });
    const h = w.derived.elevation;
    const r = route(w.mesh, h, w.causes.land);
    let lake = 0;
    for (let i = 0; i < w.mesh.n; i += 5) {
      if (!w.causes.land[i]) continue;
      expect(waterLevel(w.mesh, w.causes.land, h, i)).toBe(r.water[i]);
      if (r.water[i] > h[i]) lake++;
    }
    for (const c of lakeArea(w, C, 40)) expect(waterLevel(w.mesh, w.causes.land, h, c)).toBe(r.water[c]);
    expect(lake).toBeGreaterThan(0);
  });

  it('流进湖：河床不挖到湖面以下，湖不顺着河道倒流，水照着画的走（翻过一道坡流进湖也一样）', () => {
    const base = continents();
    const w0 = base.world;
    const { mesh } = w0;
    // 内陆高处放湖，从四面画进去；只看往高处流进湖的（起点比湖面低，挖到湖底就会让湖从河道倒流出去）
    const cand = [...Array(mesh.n).keys()].filter((i) => w0.causes.land[i] && w0.derived.continentality[i] > 0.6 && w0.derived.elevation[i] > 600 && !isRiverCell(w0, w0.derived, i));
    let checked = 0;
    for (const C of cand.filter((_, k) => k % 41 === 0)) {
      if (checked >= 4) break;
      const eng = base.clone();
      eng.exec({ op: 'add_lake', lake: { cell: C, radius: 30, depth: 200, perennial: true } });
      const w = eng.world;
      const lake = [...Array(mesh.n).keys()].filter((i) => w.derived.lake[i] === 1).join(',');
      for (let a = 0; a < 8 && checked < 4; a++) {
        const R = 7 * mesh.spacing;
        const plan = planCourse(w, w.derived, line([mesh.x[C] + Math.cos(a * 0.8) * R, mesh.y[C] + Math.sin(a * 0.8) * R], at(w, C)), { endOnLand: 'flow' });
        if (plan.blocked || plan.end !== 'lake' || plan.crossings.length || plan.reroute || plan.uphill < 30) continue;
        const e = eng.clone();
        e.exec(courseCmd(plan));
        expect(followed(e.world, plan.cells)).toBe(true);
        expect([...Array(mesh.n).keys()].filter((i) => e.world.derived.lake[i] === 1).join(',')).toBe(lake);
        // 河道上最后一格陆地仍比湖面高
        const body = plan.cells.slice(0, -1);
        const end = plan.cells[plan.cells.length - 1];
        expect(e.world.derived.elevation[body[body.length - 1]]).toBeGreaterThan(e.world.derived.water[end]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('到这里汇入：河道截在第一次穿过的那条河上，照着走；汇入的河不改道', () => {
    const eng = continents();
    const w = eng.world;
    const { mesh } = w;
    let plan: CoursePlan | null = null;
    for (let i = 0; i < mesh.n && !plan; i += 11) {
      if (!w.causes.land[i] || w.derived.continentality[i] < 0.5 || isRiverCell(w, w.derived, i)) continue;
      const p = planCourse(w, w.derived, line(at(w, i), [mesh.x[i] + 16 * mesh.spacing, mesh.y[i] - 3 * mesh.spacing]), { endOnLand: 'flow' });
      if (!p.blocked && !p.reroute && p.crossings.length && p.crossings[0].guide === null && p.crossings[0].from > 2) plan = p;
    }
    expect(plan).not.toBeNull();
    const k = plan!.crossings[0].from;
    const joined = endCourseAt(w, w.derived, plan!, k);
    expect(joined.blocked).toBeNull();
    expect(joined.end).toBe('river');
    expect(joined.cells).toEqual(plan!.cells.slice(0, k + 1));
    expect(joined.crossings).toEqual([]);
    expect(joined.cut).not.toBeNull();
    // 折线截在第一次进汇合那格的地方：取样点都在河道里
    const smp = pathSamples(joined.path, courseStep(mesh));
    for (let j = 0; j < smp.x.length; j++) expect(joined.cells).toContain(findCell(mesh, smp.x[j], smp.y[j]));
    expect(findCell(mesh, ...joined.path[joined.path.length - 1])).toBe(joined.join);
    const recv = w.derived.receiver[joined.join];
    eng.exec(courseCmd(joined));
    expect(followed(w, joined.cells)).toBe(true);
    expect(w.derived.receiver[joined.join]).toBe(recv);
    expect(guideEnd(w, w.derived, w.small.guides[0])).toEqual({ kind: 'river', cell: joined.join });
  });

  it('改一段时绕成圈的拦下：这条河汇入的河往下流会经过新画的一段', () => {
    // G 沿着一条河 R 往上游画，在 J 汇入 R；再把 G 中间的一段改成横穿 J 下游的 R：水会 G → R → G 绕圈
    const base = continents();
    const w0 = base.world;
    const { mesh } = w0;
    let checked = 0;
    for (const f of w0.derived.features.filter((x) => x.type === 'river')) {
      const stem = riverStem(w0, w0.derived, f.anchor).cells.filter((c) => w0.causes.land[c]);
      if (stem.length < 16) continue;
      for (const side of [1, -1]) {
        for (const i of [stem.length - 3, stem.length - 5]) {
          const x = stem[i];
          const J = stem[i - 9];
          const len = Math.hypot(mesh.x[J] - mesh.x[x], mesh.y[J] - mesh.y[x]);
          const nx = (-(mesh.y[J] - mesh.y[x]) / len) * side * mesh.spacing;
          const ny = ((mesh.x[J] - mesh.x[x]) / len) * side * mesh.spacing;
          const P: Pt = [mesh.x[x] + 2.2 * nx, mesh.y[x] + 2.2 * ny];
          const Q: Pt = [mesh.x[J] + 2.2 * nx, mesh.y[J] + 2.2 * ny];
          const plan = planCourse(w0, w0.derived, [...line(P, Q), ...line(Q, at(w0, J), 10).slice(1)], { endOnLand: 'sink' });
          if (plan.blocked || plan.end !== 'river' || plan.crossings.length || plan.reroute) continue;
          const eng = base.clone();
          eng.exec(courseCmd(plan, { id: 'river-g' }));
          const w = eng.world;
          const along = (t: number): Pt => [P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t];
          const M: Pt = [mesh.x[x] - 0.8 * nx, mesh.y[x] - 0.8 * ny];
          const r = spliceCourse(w, w.derived, w.small.guides[0], [...line(along(0.12), M, 30), ...line(M, along(0.5), 30).slice(1)], { endOnLand: 'sink', tol: 0.5 * mesh.spacing });
          if (!('blocked' in r)) {
            // 没有横穿 R：照常改，水照着走
            if (r.patch.cells!.some((c) => stem.includes(c))) throw new Error('横穿了 J 下游的河却没有拦下');
            continue;
          }
          if (r.blocked === '这样水会绕成圈') checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('定大小：拖到的就是这条河的总水量（自然流来的水加上画的河自己加的）', () => {
    const eng = continents();
    const w = eng.world;
    const plan = planCourse(w, w.derived, acrossRange(w).stroke, { endOnLand: 'flow' });
    eng.exec(courseCmd(plan, { id: 'river-f' }));
    const g = () => w.small.guides[0];
    const { total, natural } = guideFlow(w, w.derived, g());
    expect(total - natural).toBeCloseTo(2, 6);
    for (const target of [natural + 5, natural + 20]) {
      eng.exec({ op: 'update_guide', id: 'river-f', patch: { flow: Math.max(1.2, target - natural) } });
      expect(guideFlow(w, w.derived, g()).total).toBeCloseTo(target, 6);
    }
    // 最左边“顺其自然”：不再加水
    eng.exec({ op: 'update_guide', id: 'river-f', patch: { spring: false, flow: null } });
    expect(guideFlow(w, w.derived, g()).total).toBeCloseTo(natural, 6);
  });
});

describe('画的线就是河道', () => {
  it('画的线经过的格就是河道：折线上的取样点都在河道里，格相邻、不重复，起点就在画的第一点下面', () => {
    const w = continents().world;
    const { mesh } = w;
    const inland = [...Array(mesh.n).keys()].filter((i) => w.causes.land[i] && w.derived.lake[i] !== 1 && w.derived.continentality[i] > 0.55);
    let checked = 0;
    for (const s of inland.filter((_, k) => k % 97 === 0).slice(0, 12)) {
      // 弯弯曲曲的线，中间绕一个圈（半径一格半）
      const [x0, y0] = at(w, s);
      const stroke: Pt[] = [];
      for (let k = 0; k <= 120; k++) {
        const t = k / 120;
        const u = t > 0.4 && t < 0.6 ? ((t - 0.4) / 0.2) * 2 * Math.PI : 0;
        stroke.push([x0 + t * 12 * mesh.spacing + Math.sin(u) * 1.5 * mesh.spacing, y0 + Math.sin(t * 7) * 2 * mesh.spacing + (1 - Math.cos(u)) * 1.5 * mesh.spacing]);
      }
      const plan = planCourse(w, w.derived, stroke, { endOnLand: 'flow' });
      if (plan.blocked || plan.reversed) continue;
      checked++;
      const drawn = new Set(plan.cells.slice(0, plan.drawn + 1));
      const smp = pathSamples(plan.path, courseStep(mesh));
      for (let k = 0; k < smp.x.length; k++) expect(drawn.has(findCell(mesh, smp.x[k], smp.y[k]))).toBe(true);
      expect(new Set(plan.cells).size).toBe(plan.cells.length);
      for (let k = 0; k + 1 < plan.cells.length; k++) {
        let adj = false;
        for (let e = mesh.off[plan.cells[k]]; e < mesh.off[plan.cells[k] + 1]; e++) if (mesh.adj[e] === plan.cells[k + 1]) adj = true;
        expect(adj).toBe(true);
      }
      expect(plan.cells[0]).toBe(findCell(mesh, ...stroke[0]));
      expect(plan.path.length).toBeLessThanOrEqual(1500);
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('从河口往上画：倒过来，河从内陆流到海里；多画进海里的部分丢掉', () => {
    const eng = continents();
    const w = eng.world;
    const { stroke } = acrossRange(w);
    const forward = planCourse(w, w.derived, stroke, { endOnLand: 'flow' });
    // 从入海的那格（海上）画起，画回内陆的起点
    const sea = forward.cells[forward.cells.length - 1];
    expect(w.causes.land[sea]).toBe(0);
    const plan = planCourse(w, w.derived, line(at(w, sea), forward.path[0]), { endOnLand: 'flow' });
    expect(forward.reversed).toBe(false);
    expect(plan.reversed).toBe(true);
    expect(plan.end).toBe('sea');
    expect(plan.cells[0]).toBe(forward.cells[0]);
    expect(plan.cut).not.toBeNull();
    expect(w.causes.land[plan.cells[plan.cells.length - 1]]).toBe(0);
  });

  it('改一段时前后两段不变：格和折线都原样留着，水照着新画的走', () => {
    const eng = continents();
    const w = eng.world;
    const { mesh } = w;
    let B: CoursePlan | null = null;
    for (let i = 0; i < mesh.n && !B; i += 7) {
      if (!w.causes.land[i] || w.derived.continentality[i] < 0.5 || isRiverCell(w, w.derived, i)) continue;
      const p = planCourse(w, w.derived, line(at(w, i), [mesh.x[i] + 14 * mesh.spacing, mesh.y[i] + 2 * mesh.spacing]), { endOnLand: 'flow' });
      if (!p.blocked && p.drawn >= 12 && !p.crossings.length && !p.reroute) B = p;
    }
    eng.exec(courseCmd(B!, { id: 'river-b', name: '青河' }));
    const g = w.small.guides[0];
    const [p0, p1] = [B!.path[0], B!.path[B!.path.length - 1]];
    const pt = (f: number): Pt => [p0[0] + (p1[0] - p0[0]) * f, p0[1] + (p1[1] - p0[1]) * f];
    const a = pt(0.2);
    const b = pt(0.7);
    // 从下游往上游画也一样（倒过来）
    for (const reverse of [false, true]) {
      const detour: Pt[] = [];
      for (let k = 0; k <= 40; k++) {
        const t = k / 40;
        detour.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - Math.sin(Math.PI * t) * 2.5 * mesh.spacing]);
      }
      if (reverse) detour.reverse();
      const r = spliceCourse(w, w.derived, g, detour, { endOnLand: 'flow', tol: 0.5 * mesh.spacing });
      if ('blocked' in r) throw new Error(r.blocked);
      const cells = r.patch.cells!;
      const ka = g.cells.indexOf(findCell(mesh, ...a));
      const kb = g.cells.indexOf(findCell(mesh, ...b));
      expect(cells.slice(0, ka + 1)).toEqual(g.cells.slice(0, ka + 1));
      expect(cells.slice(cells.length - (g.cells.length - kb))).toEqual(g.cells.slice(kb));
      expect(cells).not.toEqual(g.cells);
      // 折线：前面的折点、后面的折点都原样（这条线只有两头两个折点）
      const path = decodePath(r.patch.path!);
      expect(path[0]).toEqual(B!.path[0]);
      expect(path[path.length - 1]).toEqual(B!.path[B!.path.length - 1]);
      const e = eng.clone();
      e.exec({ op: 'update_guide', id: 'river-b', patch: r.patch });
      const after = e.world.small.guides[0];
      expect(after.name).toBe('青河');
      expect(after.flow).toBe(2);
      expect(followed(e.world, after.cells)).toBe(true);
    }
  });

  it('顺地势流下去的那段、没有折线的河道也能改一段：没改的地方格不变，画出来也不动', () => {
    const eng = continents();
    const w = eng.world;
    const { mesh } = w;
    // 画一小段就松手，之后顺地势流下去很长一段
    let plan: CoursePlan | null = null;
    for (let i = 0; i < mesh.n && !plan; i += 7) {
      if (!w.causes.land[i] || w.derived.continentality[i] < 0.5 || isRiverCell(w, w.derived, i)) continue;
      const p = planCourse(w, w.derived, line(at(w, i), [mesh.x[i] + 2.5 * mesh.spacing, mesh.y[i]], 10), { endOnLand: 'flow' });
      if (!p.blocked && !p.reroute && !p.crossings.length && p.cells.length - p.drawn >= 12 && p.end === 'sea') plan = p;
    }
    expect(plan).not.toBeNull();
    // 一条新画的（只有一小段折线），一条没有折线的
    for (const g of [
      guideSchema.parse({ ...(courseCmd(plan!) as { guide: object }).guide, id: 'river-n' }),
      guideSchema.parse({ id: 'river-o', cells: plan!.cells, locked: true, spring: true }),
    ]) {
      const e = continents();
      e.exec({ op: 'add_guide', guide: g });
      const ew = e.world;
      const P0 = guidePoints(ew, g);
      // 改流下去的那段的中间：从第 drawn+3 格到第 drawn+8 格绕一下
      const ka = plan!.drawn + 3;
      const kb = plan!.drawn + 8;
      const [a, b] = [at(ew, plan!.cells[ka]), at(ew, plan!.cells[kb])];
      const nx = -(b[1] - a[1]);
      const ny = b[0] - a[0];
      const l = Math.hypot(nx, ny);
      const detour: Pt[] = [];
      for (let k = 0; k <= 40; k++) {
        const t = k / 40;
        const o = Math.sin(Math.PI * t) * 2 * mesh.spacing;
        detour.push([a[0] + (b[0] - a[0]) * t + (nx / l) * o, a[1] + (b[1] - a[1]) * t + (ny / l) * o]);
      }
      const r = spliceCourse(ew, ew.derived, g, detour, { endOnLand: 'flow', tol: 0.5 * mesh.spacing });
      if ('blocked' in r) throw new Error(r.blocked);
      const cells = r.patch.cells!;
      expect(cells.slice(0, ka + 1)).toEqual(g.cells.slice(0, ka + 1));
      expect(cells.slice(cells.length - (g.cells.length - kb))).toEqual(g.cells.slice(kb));
      // 改后的折线：前面一段的点与原来画出来的控制点相同，后面一段也是
      const path = decodePath(r.patch.path!);
      const ia = P0.findIndex((p) => findCell(mesh, ...p) === g.cells[ka]);
      expect(path.slice(0, ia)).toEqual(P0.slice(0, ia));
      expect(path.slice(path.length - 3)).toEqual(P0.slice(P0.length - 3));
      e.exec({ op: 'update_guide', id: g.id, patch: r.patch });
      const after = ew.small.guides[0];
      expect(followed(ew, after.cells)).toBe(true);
    }
  });

  it('整个星球跨接缝：折线连续、起点在 [0, 2) 里，格相邻，水照着走', () => {
    const eng = engineFor({ seed: 4, cells: 4000, globe: true, aspect: 2, latNorth: 90, latSouth: -90 });
    eng.exec({ op: 'set_worldgen', params: { seed: 4, type: 'continents' }, reset: true });
    const w = eng.world;
    const { mesh } = w;
    let plan: CoursePlan | null = null;
    for (let i = 0; i < mesh.n && !plan; i++) {
      if (!w.causes.land[i] || mesh.x[i] < 1.93 || mesh.y[i] < 0.25 || mesh.y[i] > 0.75) continue;
      // 画的线从接缝的另一份开始（x 减了 2）
      const p = planCourse(w, w.derived, line([mesh.x[i] - 2, mesh.y[i]], [mesh.x[i] - 2 + 0.15, mesh.y[i]]), { endOnLand: 'flow' });
      if (!p.blocked && p.drawn >= 5 && Math.max(...p.path.map((q) => q[0])) > 2.005) plan = p;
    }
    expect(plan).not.toBeNull();
    expect(plan!.path[0][0]).toBeGreaterThanOrEqual(0);
    expect(plan!.path[0][0]).toBeLessThan(2);
    const smp = pathSamples(plan!.path, courseStep(mesh));
    const drawn = new Set(plan!.cells.slice(0, plan!.drawn + 1));
    for (let k = 0; k < smp.x.length; k++) {
      expect(drawn.has(findCell(mesh, smp.x[k], smp.y[k]))).toBe(true);
      if (k) expect(Math.abs(smp.x[k] - smp.x[k - 1])).toBeLessThan(mesh.spacing);
    }
    eng.exec(courseCmd(plan!));
    expect(followed(w, plan!.cells)).toBe(true);
    expect(digestWorld(w)).toEqual(digestWorld(Engine.fromDoc(eng.toDoc(), mesh).world));
  });
});

describe('固定自然的河', () => {
  it('固定后河格集合不变：几条大河的主干固定下来（只挖河床、不加水），河、高程都不变', () => {
    const w0 = continents().world;
    const rivers = w0.derived.features.filter((f) => f.type === 'river').slice(0, 4);
    expect(rivers.length).toBe(4);
    for (const f of rivers) {
      const eng = continents();
      const w = eng.world;
      const stem = riverStem(w, w.derived, f.anchor);
      expect(stem.cells).toContain(f.anchor);
      expect(stem.end).not.toBeNull();
      const set = riverSet(w);
      const elevation = w.derived.elevation.slice();
      eng.exec({ op: 'add_guide', guide: { cells: stem.cells, path: stemPath(w, stem.cells), locked: true, spring: false, nameKey: f.key } });
      expect(riverSet(w)).toBe(set);
      let changed = 0;
      for (let i = 0; i < w.mesh.n; i++) if (w.derived.elevation[i] !== elevation[i]) changed++;
      expect(changed).toBeLessThanOrEqual(3);
      expect(guideWarnings(w, w.derived, w.small.guides[0])).toEqual([]);
      // 存下的折线按画的河的画法画出来，与原来那条自然的河的画法（格心、入海画到两格之间）一样
      const pts = stem.cells.map((c) => at(w, c));
      if (!w.causes.land[stem.cells[stem.cells.length - 1]]) {
        const [a, b] = pts.slice(-2);
        pts[pts.length - 1] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      }
      const flow = pts.map(() => 1);
      const want = smoothCourse(pts, flow, w.mesh.spacing).points;
      const got = courseLine(decodePath(stemPath(w, stem.cells)), flow).points;
      expect(got.length).toBe(want.length);
      for (let k = 0; k < got.length; k++) expect(Math.hypot(got[k][0] - want[k][0], got[k][1] - want[k][1])).toBeLessThan(1e-4);
    }
  });
});

describe('重算出错时整步不生效（第三批）', () => {
  // 下一次重算整个算完（地形、气候的底子都换成了新的）之后才出错，只出错一次：底子也要回到执行前的
  const breakAfterNextUpdate = (e: Engine) => {
    const self = e as unknown as { recompute?: () => unknown };
    const recompute = (Engine.prototype as unknown as { recompute: () => unknown }).recompute;
    self.recompute = function (this: Engine) {
      delete self.recompute;
      recompute.call(this);
      throw new Error('重算出了意外');
    };
  };
  const state = (e: Engine) => ({ digest: digestWorld(e.world), history: e.history, stateId: e.stateId });

  for (const cache of [true, false]) {
    it(`有只挖河床的河时（${cache ? '存着推导' : '没存推导'}）：改地形、改河出错都回到执行前；之后改河、改气候按的还是没挖河床的地形，与重放一致`, () => {
      const eng = continents();
      if (!cache) eng.undoCache = 0;
      const w = eng.world;
      const { stroke, peak } = acrossRange(w);
      const plan = planCourse(w, w.derived, stroke, { endOnLand: 'flow' });
      eng.exec(courseCmd(plan));
      const id = w.small.guides[w.small.guides.length - 1].id;
      const mesh = w.mesh;
      const around = [...Array(mesh.n).keys()].filter((i) => Math.hypot(mesh.x[i] - mesh.x[peak], mesh.y[i] - mesh.y[peak]) < 4 * mesh.spacing);
      // 改地形（从高程重算：地形底子换成新的之后出错）
      let before = state(eng);
      breakAfterNextUpdate(eng);
      expect(() => eng.exec({ op: 'paint_relief', cells: around, t: around.map(() => 0), strength: -1.5 })).toThrow('重算出了意外');
      expect(state(eng)).toEqual(before);
      // 改河（只从水文重算，读存着的地形底子）
      before = state(eng);
      breakAfterNextUpdate(eng);
      expect(() => eng.exec({ op: 'update_guide', id, patch: { flow: 9 } })).toThrow('重算出了意外');
      expect(state(eng)).toEqual(before);
      eng.exec({ op: 'update_guide', id, patch: { flow: 9 } });
      expect(followed(w, plan.cells)).toBe(true);
      eng.exec({ op: 'set_planet', patch: { humidity: 1.2 } });
      expect(digestWorld(eng.world)).toEqual(digestWorld(Engine.fromDoc(eng.toDoc(), mesh).world));
    });
  }
});

describe('预览', () => {
  it('预览就是结果：每格流量、消失的河、挖低的格与执行后相同；松手直接采用，与重放一致', () => {
    const eng = continents();
    const w = eng.world;
    const plan = planCourse(w, w.derived, acrossRange(w).stroke, { endOnLand: 'flow' });
    const cmd = courseCmd(plan);
    const before = { river: riverSet(w).split(',').map(Number), elevation: w.derived.elevation.slice() };
    const p = eng.preview(cmd);
    expect(p.guide).toBeDefined();
    expect(p.guide!.followed).toBe(true);
    expect(p.carved.cells.every((c) => plan.cells.includes(c))).toBe(true);
    expect(p.carved.maxDrop).toBeGreaterThan(1000);
    const update = vi.spyOn(eng, 'update');
    eng.exec(cmd);
    // 采用预览：不再重算
    expect(update).not.toHaveBeenCalled();
    update.mockRestore();
    expect(p.guide!.flow).toEqual(plan.cells.map((c) => w.derived.discharge[c]));
    const now = new Set(riverSet(w).split(',').map(Number));
    expect(p.riverRemoved).toEqual(before.river.filter((c) => !now.has(c)));
    const carved = [...Array(w.mesh.n).keys()].filter((i) => before.elevation[i] - w.derived.elevation[i] >= 1);
    expect(p.carved.cells).toEqual(carved);
    expect(digestWorld(w)).toEqual(digestWorld(Engine.fromDoc(eng.toDoc(), w.mesh).world));
    // 改一条河也一样
    const id = w.small.guides[0].id;
    const q = eng.preview({ op: 'update_guide', id, patch: { flow: 8 } });
    eng.exec({ op: 'update_guide', id, patch: { flow: 8 } });
    expect(q.guide!.flow).toEqual(plan.cells.map((c) => w.derived.discharge[c]));
    expect(digestWorld(w)).toEqual(digestWorld(Engine.fromDoc(eng.toDoc(), w.mesh).world));
  });
});
