import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import { type Command, Dirty, truncateGuide } from './commands';
import { Engine } from './engine';
import { exportPackage } from './export';
import { findCell } from './mesh';
import { DEFAULT_PACK, generateName, hashString } from './names';
import { displayCoast, displayCoastAt } from './display';
import { type RiverLine, decodePath, encodePath, guideBody, guideLine, snapOnto, traceRivers } from './rivers';
import { type CoursePlan, isRiverCell, planCourse, riverStem, stemPath } from './select';
import { continents, engineFor } from './testing/fixtures';
import type { Guide, World } from './world';

// 第八轮第二批：画的河怎么画、叫什么。画的河照存下的折线画（屏幕、PNG、rivers.bmp 同一套），
// 自然的支流画到它的线上；有名字的河道是地物，第二轮起名，固定的自然河名字、颜色照旧

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

// 横穿最大的山脉（过它的最高峰，垂直于山脉的走向），两头各伸出 6 格：在这个世界上一头入海
function acrossRange(w: World): Pt[] {
  const { mesh, derived: d } = w;
  const range = d.features.filter((f) => f.type === 'range').sort((a, b) => b.cells.length - a.cells.length)[0];
  let peak = range.cells[0];
  for (const c of range.cells) if (d.elevation[c] > d.elevation[peak]) peak = c;
  const ang = range.angle + Math.PI / 2;
  const L = 6 * mesh.spacing;
  const [x, y] = at(w, peak);
  return line([x - Math.cos(ang) * L, y - Math.sin(ang) * L], [x + Math.cos(ang) * L, y + Math.sin(ang) * L]);
}

// 一条汇入自然大河中段的河：从河边 4–6 格外的陆地直着画到河上，不穿过别的河
function joinStroke(w: World): CoursePlan {
  const { mesh, derived: d } = w;
  for (const f of d.features.filter((x) => x.type === 'river')) {
    const T = f.cells[Math.floor(f.cells.length / 2)];
    for (let i = 0; i < mesh.n; i++) {
      if (!w.causes.land[i] || d.lake[i] === 1 || isRiverCell(w, d, i)) continue;
      const dist = Math.hypot(mesh.x[i] - mesh.x[T], mesh.y[i] - mesh.y[T]) / mesh.spacing;
      if (dist < 4 || dist > 6) continue;
      const plan = planCourse(w, d, line(at(w, i), at(w, T)), { endOnLand: 'flow' });
      if (!plan.blocked && plan.end === 'river' && plan.join === T && !plan.crossings.length && !plan.reroute) return plan;
    }
  }
  throw new Error('找不到汇入的河');
}

// 导出的 rivers.bmp（24 位，自下而上）里是河的像素（红色分量为 0）
function riverPixels(w: World, eng: Engine, width = 256, height = 128): { x: number; y: number }[] {
  const pkg = exportPackage(w, eng.toDoc(), { width, height, seaLevelGray: 95, maxElevation: 6000 });
  const bmp = unzipSync(pkg.zip)['rivers.bmp'];
  const row = Math.ceil((width * 3) / 4) * 4;
  const out: { x: number; y: number }[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (bmp[54 + (height - 1 - y) * row + x * 3 + 2] === 0) out.push({ x, y });
  }
  return out;
}

const courseOf = (lines: RiverLine[], id: string) => lines.filter((l) => l.guide === id);
const near = (lines: RiverLine[], [x, y]: Pt, skip?: RiverLine) =>
  Math.min(...lines.filter((l) => l !== skip).map((l) => snapOnto(l.points, x, y)?.d ?? Infinity));

describe('画的线就是河', () => {
  it('画的河照它的线画（guideLine），自然的支流画到它的线上，汇入别的河时画到那条河的线上', () => {
    const eng = continents();
    const w = eng.world;
    eng.exec(courseCmd(planCourse(w, w.derived, acrossRange(w), { endOnLand: 'flow' }), { id: 'river-a' }));
    eng.exec(courseCmd(joinStroke(w), { id: 'river-b' }));
    const lines = traceRivers(w);
    for (const id of ['river-a', 'river-b']) {
      const g = w.small.guides.find((x) => x.id === id)!;
      const gl = guideLine(w, g);
      const runs = courseOf(lines, id);
      expect(runs.length).toBeGreaterThan(0);
      for (const r of runs) {
        // 每一段都是画的线上连续的一截（汇入别的河的最后一点接到那条河上；入海、入湖的最后一点在画的线上、画面上的岸线处）
        const k0 = gl.points.findIndex((p) => p[0] === r.points[0][0] && p[1] === r.points[0][1]);
        expect(k0).toBeGreaterThanOrEqual(0);
        const m = (id === 'river-b' && r === runs[runs.length - 1]) || r.mouth ? r.points.length - 1 : r.points.length;
        expect(r.points.slice(0, m)).toEqual(gl.points.slice(k0, k0 + m));
        if (r.mouth) {
          const end = r.points[r.points.length - 1];
          expect(snapOnto(gl.points, end[0], end[1])!.d).toBeLessThan(1e-9);
          const f = displayCoast(w);
          const prev = r.points[r.points.length - 2];
          const dx = end[0] - prev[0];
          const dy = end[1] - prev[1];
          const l = Math.hypot(dx, dy);
          const eps = 2e-3 * w.mesh.spacing;
          expect(displayCoastAt(w, f, end[0] - (dx / l) * eps, end[1] - (dy / l) * eps).v).toBeGreaterThan(0);
          expect(displayCoastAt(w, f, end[0] + (dx / l) * eps, end[1] + (dy / l) * eps).v).toBeLessThanOrEqual(0);
        }
        expect(r.flow.length).toBe(r.points.length);
        expect(r.mul).toEqual(r.points.map(() => 1));
      }
      // 陆地上看得见是河的格都由这条河画（自然的河不再沿它重画一遍）
      const body = new Set(guideBody(w, w.derived, g));
      for (const l of lines) {
        if (l.guide) continue;
        const walked = l.cells!.filter((c, k, a) => k === 0 || c !== a[k - 1]);
        expect(walked.slice(1, -1).some((c) => body.has(c))).toBe(false);
      }
    }
    // 自然的支流：最后一点在画的河的线上
    const a = courseOf(lines, 'river-a');
    const aBody = new Set(guideBody(w, w.derived, w.small.guides[0]));
    const tributaries = lines.filter((l) => !l.guide && aBody.has(l.cells![l.cells!.length - 1]));
    expect(tributaries.length).toBeGreaterThan(0);
    for (const t of tributaries) expect(near(a, t.points[t.points.length - 1])).toBeLessThan(1e-9);
    // 汇入别的河：最后一点在那条河的线上
    const b = courseOf(lines, 'river-b');
    const last = b[b.length - 1];
    expect(near(lines, last.points[last.points.length - 1], last)).toBeLessThan(1e-9);
  });

  it('拐直角：两条长直边夹着的拐角照画的走（离画的线不到半格），沿途的格都由画的河画', () => {
    const eng = continents();
    const w = eng.world;
    const { mesh } = w;
    const s = mesh.spacing;
    // 缩得很小时画的（一个屏幕像素合 0.15 格）：化简后只剩拐角一个点
    let plan: CoursePlan | null = null;
    for (let i = 0; i < mesh.n && !plan; i += 37) {
      if (!w.causes.land[i] || isRiverCell(w, w.derived, i)) continue;
      const [x, y] = at(w, i);
      const p = planCourse(w, w.derived, [...line([x, y], [x + 12 * s, y], 60), ...line([x + 12 * s, y], [x + 12 * s, y + 12 * s], 60).slice(1)], { endOnLand: 'sink', px: 0.15 * s });
      if (!p.blocked && p.path.length === 3 && !p.crossings.length && !p.reroute && p.end === 'sink') plan = p;
    }
    expect(plan).not.toBeNull();
    eng.exec(courseCmd(plan!, { id: 'river-a' }));
    const g = w.small.guides[0];
    const gl = guideLine(w, g);
    for (const p of decodePath(g.path!)) expect(snapOnto(gl.points, p[0], p[1])!.d).toBeLessThan(0.3 * s);
    expect(gl.cellIdx[gl.cellIdx.length - 1]).toBe(g.cells.length - 1);
    const body = new Set(guideBody(w, w.derived, g));
    for (const l of traceRivers(w)) {
      if (l.guide) continue;
      const walked = l.cells!.filter((c, k, a) => k === 0 || c !== a[k - 1]);
      expect(walked.slice(1, -1).some((c) => body.has(c))).toBe(false);
    }
  });

  it('画的河比它流进的那条小河大：从它的线上接着往下画，下游那格还有别的支流流进来也不断开', () => {
    const base = continents();
    const w0 = base.world;
    const { mesh } = w0;
    const d0 = w0.derived;
    const isR = (i: number) => isRiverCell(w0, d0, i);
    // 流进的那格 L 往下一格 r 还有别的支流
    const donors = (r: number) => {
      let k = 0;
      for (let e = mesh.off[r]; e < mesh.off[r + 1]; e++) if (d0.receiver[mesh.adj[e]] === r && isR(mesh.adj[e])) k++;
      return k;
    };
    let plan: CoursePlan | null = null;
    for (let L = 0; L < mesh.n && !plan; L++) {
      const r = d0.receiver[L];
      if (!isR(L) || r < 0 || !isR(r) || donors(r) < 2) continue;
      for (let i = 0; i < mesh.n && !plan; i++) {
        if (!w0.causes.land[i] || d0.lake[i] === 1 || isR(i)) continue;
        const dist = Math.hypot(mesh.x[i] - mesh.x[L], mesh.y[i] - mesh.y[L]) / mesh.spacing;
        if (dist < 4 || dist > 6) continue;
        const p = planCourse(w0, d0, line(at(w0, i), at(w0, L)), { endOnLand: 'flow' });
        if (!p.blocked && p.end === 'river' && p.join === L && !p.crossings.length && !p.reroute) plan = p;
      }
    }
    expect(plan).not.toBeNull();
    base.exec(courseCmd(plan!, { id: 'river-a', flow: 200 }));
    const w = base.world;
    const L = plan!.join;
    const lines = traceRivers(w);
    const runs = courseOf(lines, 'river-a');
    const tail = runs[runs.length - 1];
    // 终点那格算画的河的（它比流进来的都大），往下由从它的线上接出去的那条画，两条线连着
    expect(tail.cells![tail.cells!.length - 1]).toBe(L);
    const end = tail.points[tail.points.length - 1];
    const next = lines.find((l) => !l.guide && l.points[0][0] === end[0] && l.points[0][1] === end[1]);
    expect(next).toBeDefined();
    expect(next!.cells).toContain(w.derived.receiver[L]);
  });

  it('在终点消失：最后一格收细；粗细加倍，导出的 rivers.bmp 里河更宽', () => {
    const eng = continents();
    const w = eng.world;
    const plan = planCourse(w, w.derived, acrossRange(w), { endOnLand: 'flow' });
    eng.exec(courseCmd(plan, { id: 'river-a' }));
    // 导出 800 像素宽：河宽按 0.5 倍，原来一像素的河加粗后两三像素
    const thin = riverPixels(w, eng, 800, 400).length;
    eng.exec({ op: 'update_guide', id: 'river-a', patch: { width: 4 } });
    const runs = courseOf(traceRivers(w), 'river-a');
    expect(runs.every((r) => r.mul!.every((m) => m === 4))).toBe(true);
    expect(riverPixels(w, eng, 800, 400).length).toBeGreaterThan(thin + 50);
    // 到海之前在陆地上停下、在那里消失
    const k = plan.cells.findIndex((c) => !w.causes.land[c]);
    const cut = truncateGuide(w, w.small.guides[0], k - 3);
    eng.exec({ op: 'update_guide', id: 'river-a', patch: { cells: cut.cells, path: cut.path, end: 'sink', width: null } });
    const sink = courseOf(traceRivers(w), 'river-a');
    const tail = sink[sink.length - 1].mul!;
    expect(tail[tail.length - 1]).toBeCloseTo(0.3, 6);
    expect(tail[0]).toBe(1);
  });

  it('整个星球跨接缝：存下的折线、画出来的线都连续，rivers.bmp 的左右两边都有这条河', () => {
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
    eng.exec(courseCmd(plan!, { id: 'river-a' }));
    const g = w.small.guides[0];
    // 存下的折线沿河展开经度：相邻两点不会差出一整圈，跨过了 x = 2
    const path = decodePath(g.path!);
    for (let k = 1; k < path.length; k++) expect(Math.abs(path[k][0] - path[k - 1][0])).toBeLessThan(0.5);
    expect(path[0][0]).toBeLessThan(2);
    expect(path[path.length - 1][0]).toBeGreaterThan(2);
    const lines = traceRivers(w);
    const runs = courseOf(lines, 'river-a');
    expect(runs.length).toBeGreaterThan(0);
    // 画出来的线没有绕一整圈的一段（自然的河在两极附近格被拉长，只看不跨接缝）；画的河每段不到两格
    for (const l of lines) for (let k = 1; k < l.points.length; k++) expect(Math.abs(l.points[k][0] - l.points[k - 1][0])).toBeLessThan(0.5);
    for (const r of runs) {
      for (let k = 1; k < r.points.length; k++) expect(Math.hypot(r.points[k][0] - r.points[k - 1][0], r.points[k][1] - r.points[k - 1][1])).toBeLessThan(2 * mesh.spacing);
    }
    expect(Math.max(...runs.flatMap((r) => r.points.map((p) => p[0])))).toBeGreaterThan(2);
    // 画的这一段跨过了接缝：导出的图左右两边（3 像素以内）这几行里都有河
    const W = 256;
    const H = 128;
    const drawn = runs.flatMap((r) => r.points.filter((p) => findCell(mesh, p[0], p[1]) >= 0));
    const y0 = Math.floor(Math.min(...drawn.map((p) => p[1])) * H) - 2;
    const y1 = Math.ceil(Math.max(...drawn.map((p) => p[1])) * H) + 2;
    const px = riverPixels(w, eng, W, H).filter((p) => p.y >= y0 && p.y <= y1);
    expect(px.some((p) => p.x < 3)).toBe(true);
    expect(px.some((p) => p.x >= W - 3)).toBe(true);
  });
});

describe('画的河的名字', () => {
  it('没有名字的河道不成为地物，自然的大河照旧标、地名一个不变', () => {
    const eng = continents();
    const w = eng.world;
    const f = w.derived.features.find((x) => x.type === 'river')!;
    const stem = riverStem(w, w.derived, f.anchor);
    // 没有折线、没有名字的河道：不成为地物，地名照旧由自然的河识别
    eng.exec({ op: 'add_guide', guide: { cells: stem.cells, locked: true, spring: false } });
    expect(w.derived.features.some((x) => x.guide)).toBe(false);
    // 存了折线但没有名字：也不成为地物，地名一个不变
    eng.undo();
    const before = w.derived.features.map((x) => `${x.key}=${x.name}`);
    eng.exec({ op: 'add_guide', guide: { cells: stem.cells, path: stemPath(w, stem.cells), locked: true, spring: false } });
    expect(w.derived.features.some((x) => x.guide)).toBe(false);
    expect(w.derived.features.map((x) => `${x.key}=${x.name}`)).toEqual(before);
  });

  it('新画的河有名字、不抢别的地名；改名只改它，与从头识别一样', () => {
    const eng = continents();
    const w = eng.world;
    const others = (ww: World) => new Map(ww.derived.features.filter((f) => f.type !== 'river').map((f) => [f.key, f.name]));
    const before = others(w);
    eng.exec(courseCmd(planCourse(w, w.derived, acrossRange(w), { endOnLand: 'flow' }), { id: 'river-a' }));
    const f = w.derived.features.find((x) => x.guide === 'river-a')!;
    expect(f.type).toBe('river');
    expect(f.key).toBe('guide:river-a');
    expect(f.name).not.toBe('');
    expect(f.custom).toBe(false);
    expect(f.line!.length).toBeGreaterThan(5);
    // 别的地名（河以外）一个不变：画的河在第二轮起名
    for (const [k, name] of others(w)) if (before.has(k)) expect(name).toBe(before.get(k));
    // 预览里的名字就是起好的名字
    const p = eng.preview({ op: 'update_guide', id: 'river-a', patch: { salt: 3 } });
    eng.exec({ op: 'update_guide', id: 'river-a', patch: { salt: 3 } });
    expect(p.guide!.name).toBe(w.derived.features.find((x) => x.guide === 'river-a')!.name);
    // 改名：只重新起名，只有它变
    const was = w.derived.features.map((x) => `${x.key}=${x.name}|${x.custom}`);
    eng.takeRecomputed();
    eng.exec({ op: 'update_guide', id: 'river-a', patch: { name: '赤江' } });
    expect(eng.takeRecomputed()).toBe(Dirty.Names);
    const now = w.derived.features.map((x) => `${x.key}=${x.name}|${x.custom}`);
    expect(now.filter((x, k) => x !== was[k])).toEqual(['guide:river-a=赤江|true']);
    // 只重新起名的结果与从头识别（重放）的逐值相同
    expect(digestWorld(w)).toEqual(digestWorld(Engine.fromDoc(eng.toDoc(), w.mesh).world));
  });

  it('新画的河、河的水量变了，先画的河不换名（自动起的河名常常撞名，第二轮里画的河按画的先后起名）', () => {
    const eng = continents();
    const w = eng.world;
    const { mesh } = w;
    // 在陆地深处往东南画一条，不穿过别的河
    const draw = (id: string, flow: number, skip: number) => {
      for (let i = skip; i < mesh.n; i += 53) {
        if (!w.causes.land[i] || w.derived.continentality[i] < 0.5 || isRiverCell(w, w.derived, i)) continue;
        const plan = planCourse(w, w.derived, line(at(w, i), [mesh.x[i] + 12 * mesh.spacing, mesh.y[i] + 3 * mesh.spacing]), { endOnLand: 'flow' });
        if (plan.blocked || plan.crossings.length || plan.reroute || plan.end === 'river') continue;
        eng.exec(courseCmd(plan, { id, flow }));
        return;
      }
      throw new Error('画不出河');
    };
    const feature = (id: string) => w.derived.features.find((f) => f.guide === id)!;
    // 两条中等的河（大小的标签不变：自动起的名字随标签变）
    draw('river-a', 10, 0);
    draw('river-b', 25, 7);
    const fa = feature('river-a');
    const fb = feature('river-b');
    expect(fb.importance).toBeGreaterThan(fa.importance);
    // 找一对盐：两条河自动起的第一个名字相同（后画的那条更重要）
    const seed = w.small.terrain.gen?.seed ?? w.settings.seed;
    const first = (f: typeof fa, salt: number) => generateName(DEFAULT_PACK, 'river', f.tags, hashString(`${seed}:${f.key}:${salt}`));
    const bNames = new Map<string, number>();
    for (let s = 0; s < 300; s++) if (!bNames.has(first(fb, s))) bNames.set(first(fb, s), s);
    // 不是别的（先起名的）地物已经用了的名字
    const taken = new Set(w.derived.features.filter((f) => !f.guide).map((f) => f.name));
    let sa = 0;
    while (sa < 3000 && (!bNames.has(first(fa, sa)) || taken.has(first(fa, sa)))) sa++;
    expect(sa).toBeLessThan(3000);
    const x = first(fa, sa);
    eng.exec({ op: 'update_guide', id: 'river-a', patch: { name: '', salt: sa } });
    eng.exec({ op: 'update_guide', id: 'river-b', patch: { name: '', salt: bNames.get(x)! } });
    // 撞名时先画的河留着这个名字，后画的换一个
    expect(feature('river-a').name).toBe(x);
    const y = feature('river-b').name;
    expect(y).not.toBe(x);
    // 两条河的水量对调（谁更重要也对调了），名字都不变
    eng.exec({ op: 'update_guide', id: 'river-b', patch: { flow: 10 } });
    eng.exec({ op: 'update_guide', id: 'river-a', patch: { flow: 25 } });
    expect(feature('river-a').importance).toBeGreaterThan(feature('river-b').importance);
    expect(feature('river-a').tags).toEqual(fa.tags);
    expect(feature('river-b').tags).toEqual(fb.tags);
    expect(feature('river-a').name).toBe(x);
    expect(feature('river-b').name).toBe(y);
    expect(digestWorld(w)).toEqual(digestWorld(Engine.fromDoc(eng.toDoc(), w.mesh).world));
  });

  it('同一条河只标一次；固定一条河，名字、颜色照旧（改过的名字、换过的名字也照旧），别的地名不变', () => {
    const base = continents();
    const rivers = base.world.derived.features.filter((f) => f.type === 'river').slice(0, 3);
    rivers.forEach((f, i) => {
      const eng = base.clone();
      const w = eng.world;
      if (i === 1) eng.exec({ op: 'rename_feature', key: f.key, name: '青河' });
      if (i === 2) eng.exec({ op: 'reroll_feature', key: f.key });
      const old = w.derived.features.find((x) => x.key === f.key)!;
      const before = new Map(w.derived.features.map((x) => [x.key, `${x.name}|${x.custom}`]));
      const stem = riverStem(w, w.derived, f.anchor);
      eng.exec({ op: 'add_guide', guide: { cells: stem.cells, path: stemPath(w, stem.cells), locked: true, spring: false, nameKey: f.key } });
      const withMouth = w.derived.features.filter((x) => x.type === 'river' && x.cells.includes(f.anchor));
      expect(withMouth.length).toBe(1);
      const g = withMouth[0];
      expect(g.guide).toBe(w.small.guides[0].id);
      expect(g.name).toBe(old.name);
      expect(g.custom).toBe(old.custom);
      expect(g.importance).toBe(old.importance);
      expect(w.derived.features.some((x) => x.key === f.key)).toBe(false);
      for (const x of w.derived.features) if (!x.guide) expect(`${x.key}=${`${x.name}|${x.custom}`}`).toBe(`${x.key}=${before.get(x.key)}`);
      expect(digestWorld(w)).toEqual(digestWorld(Engine.fromDoc(eng.toDoc(), w.mesh).world));
    });
  });
});
