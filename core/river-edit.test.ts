import { describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import type { Command } from './commands';
import { Engine } from './engine';
import { previewWorldOf } from './preview-world';
import {
  type EditResult,
  type EditTarget,
  type RiverEdit,
  controlHandles,
  deleteHandle,
  dragHandle,
  editCommand,
  editPoint,
  editRole,
  guideTarget,
  insertHandle,
  joinAtFirst,
  naturalTarget,
  strokeEdit,
} from './river-edit';
import { decodePath, encodePath, traceRivers } from './rivers';
import { applyPackCommands } from './packs';

import { type CoursePlan, isRiverCell, planCourse, riverStem } from './select';
import { continents, FANTASY_PACK } from './testing/fixtures';
import type { Guide, World } from './world';

// 第十一轮：在原来的河上直接改。每种改法之后还是同一条河（同一个 id、名字、大小、类型），河道数不变，
// 改动以外的折线逐点不变；自然的河改一次后固定成一条画的河（名字照旧，支流照旧汇入）；
// 画的河整条是河；预览的河网 = 执行后的河网；撤销、重放一致

type Pt = [number, number];

function line(a: Pt, b: Pt, n = 30): Pt[] {
  const out: Pt[] = [];
  for (let k = 0; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  return out;
}
const poly = (...pts: Pt[]): Pt[] => pts.slice(0, -1).flatMap((p, k) => line(p, pts[k + 1], 15).slice(0, -1)).concat([pts[pts.length - 1]]);

const at = (w: World, c: number): Pt => [w.mesh.x[c], w.mesh.y[c]];
const land = (w: World, c: number) => c >= 0 && w.causes.land[c] === 1 && w.derived.lake[c] !== 1;

const riverCells = (w: World) => [...Array(w.mesh.n).keys()].filter((i) => isRiverCell(w, w.derived, i));

function followed(w: World, cells: readonly number[]): boolean {
  for (let k = 0; k + 1 < cells.length && w.causes.land[cells[k]]; k++) if (w.derived.receiver[cells[k]] !== cells[k + 1]) return false;
  return true;
}

// 一条画的河：从一格陆地往东画 12 格、弯弯曲曲（不碰别的河），画完接着流或在终点消失
function drawnRiver(w: World, end: 'flow' | 'sink' = 'flow'): CoursePlan {
  const { mesh, derived: d } = w;
  const s = mesh.spacing;
  for (let i = 0; i < mesh.n; i += 11) {
    if (!land(w, i) || isRiverCell(w, d, i) || d.elevation[i] < 400) continue;
    const [x, y] = at(w, i);
    const stroke = poly([x, y], [x + 3 * s, y + 1.5 * s], [x + 6 * s, y - 0.5 * s], [x + 9 * s, y + 1.5 * s], [x + 12 * s, y + 0.5 * s]);
    const p = planCourse(w, d, stroke, { endOnLand: end, px: s / 20 });
    if (!p.blocked && p.drawn >= 10 && !p.crossings.length && !p.reroute && !p.merge && p.uphill < 20 && (end === 'flow' ? p.drawn < p.cells.length - 1 : p.end === 'sink')) return p;
  }
  throw new Error('找不到能画的河');
}

function withDrawn(end: 'flow' | 'sink' = 'flow'): { eng: Engine; w: World; g: Guide } {
  const eng = continents();
  const w = eng.world;
  const p = drawnRiver(w, end);
  eng.exec({
    op: 'add_guide',
    guide: { cells: p.cells, path: encodePath(p.path), locked: true, spring: true, flow: 3, name: '', type: undefined, ...(p.end === 'sink' ? { end: 'sink' as const } : {}) },
  });
  const g = w.small.guides[w.small.guides.length - 1];
  return { eng, w, g };
}

const spacing = (w: World) => w.mesh.spacing;
const opts = (w: World, endOnLand: 'flow' | 'sink' = 'sink') => ({ endOnLand, px: spacing(w) / 20, tol: 0.7 * spacing(w) });

// 折线上从源头量起 f（0–1）处的点
function pointAt(P: readonly Pt[], f: number): Pt {
  let total = 0;
  for (let k = 0; k + 1 < P.length; k++) total += Math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]);
  let acc = 0;
  for (let k = 0; k + 1 < P.length; k++) {
    const l = Math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]);
    if (acc + l >= f * total) {
      const t = l ? (f * total - acc) / l : 0;
      return [P[k][0] + (P[k + 1][0] - P[k][0]) * t, P[k][1] + (P[k + 1][1] - P[k][1]) * t];
    }
    acc += l;
  }
  return P[P.length - 1];
}

// 折线在 f 处的法向
function normalAt(P: readonly Pt[], f: number): Pt {
  const a = pointAt(P, Math.max(0, f - 0.05));
  const b = pointAt(P, Math.min(1, f + 0.05));
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  return [-(b[1] - a[1]) / l, (b[0] - a[0]) / l];
}

const ok = (r: EditResult): r is RiverEdit => !('blocked' in r);

// 执行改法并检查：还是同一条河（id、名字、大小、类型、粗细），河道数不变，新河道整条是河、水照着走；撤销还原、重放一致
function checkSame(eng: Engine, T: EditTarget, e: RiverEdit, what: string) {
  const w = eng.world;
  const before = JSON.stringify(w.small);
  const count = w.small.guides.length;
  const g0 = T.guide;
  const name0 = w.derived.features.find((f) => f.guide === g0.id)?.name;
  const cmd = editCommand(T, e, what);
  expect(cmd.op, what).toBe('update_guide');
  eng.exec(cmd);
  expect(w.small.guides.length, what).toBe(count);
  const g = w.small.guides.find((x) => x.id === g0.id)!;
  expect(g, what).toBeDefined();
  for (const k of ['name', 'nameKey', 'spring', 'flow', 'type', 'width', 'salt', 'locked'] as const) expect(g[k], `${what}：${k}`).toEqual(g0[k]);
  expect(w.derived.features.find((f) => f.guide === g.id)?.name, what).toBe(name0);
  expect(g.cells, what).toEqual(e.patch.cells);
  // 整条是河（湖、海里的不算），水照着走
  for (const c of g.cells) if (land(w, c)) expect(isRiverCell(w, w.derived, c), `${what}：${c}`).toBe(true);
  expect(followed(w, g.cells), what).toBe(true);
  expect(digestWorld(w)).toEqual(digestWorld(Engine.fromDoc(eng.toDoc(), w.mesh).world));
  eng.undo();
  expect(JSON.stringify(w.small), what).toBe(before);
}

// 两条折线开头（结尾）有多少点逐点相同
const samePrefix = (a: readonly Pt[], b: readonly Pt[]) => {
  let k = 0;
  while (k < a.length && k < b.length && a[k][0] === b[k][0] && a[k][1] === b[k][1]) k++;
  return k;
};
const sameSuffix = (a: readonly Pt[], b: readonly Pt[]) => samePrefix(a.slice().reverse(), b.slice().reverse());

describe('拖控制点：只改那一小段', () => {
  it('拖弯点、加弯点、删弯点：同一条河，两边以外的折线逐点不变', () => {
    const { eng, w, g } = withDrawn('sink');
    const T = guideTarget(w, g);
    const H = controlHandles(T, 0.05 * spacing(w), 1.5 * spacing(w));
    expect(H[0]).toBe(0);
    expect(H[H.length - 1]).toBe(T.points.length - 1);
    expect(H.length).toBeGreaterThanOrEqual(4);
    const P = T.points;
    let tried = 0;
    for (let j = 1; j < H.length - 1; j++) {
      for (const side of [1, -1]) {
        const f = H[j] / (P.length - 1);
        const nrm = normalAt(P, f);
        const to: Pt = [P[H[j]][0] + side * nrm[0] * 1.2 * spacing(w), P[H[j]][1] + side * nrm[1] * 1.2 * spacing(w)];
        const e = dragHandle(w, w.derived, T, H, j, to, opts(w));
        if (!ok(e) || e.plan.crossings.length) continue;
        expect(e.kind).toBe('bend');
        const path = decodePath(e.patch.path!);
        // 拖的那一点在新折线上；前一个控制点以前、后一个控制点以后逐点不变
        expect(path.some((p) => Math.hypot(p[0] - to[0], p[1] - to[1]) < 1e-4)).toBe(true);
        expect(samePrefix(path, P)).toBeGreaterThanOrEqual(H[j - 1] + 1);
        expect(sameSuffix(path, P)).toBeGreaterThanOrEqual(P.length - H[j + 1]);
        // 格也一样：前后两段不动
        const k0 = T.at[H[j - 1]];
        const k1 = T.at[H[j + 1]];
        expect(e.patch.cells!.slice(0, k0 + 1)).toEqual(g.cells.slice(0, k0 + 1));
        expect(e.patch.cells!.slice(-(g.cells.length - k1))).toEqual(g.cells.slice(k1));
        checkSame(eng, T, e, '拖弯点');
        tried++;
        break;
      }
      if (tried) break;
    }
    expect(tried).toBe(1);
    // 加一个弯点
    let added = false;
    for (let j = 0; j + 1 < H.length && !added; j++) {
      const m = pointAt(P, (H[j] + H[j + 1]) / 2 / (P.length - 1));
      const nrm = normalAt(P, (H[j] + H[j + 1]) / 2 / (P.length - 1));
      const e = insertHandle(w, w.derived, T, H, j, [m[0] + nrm[0] * spacing(w), m[1] + nrm[1] * spacing(w)]);
      if (!ok(e) || e.plan.crossings.length) continue;
      const path = decodePath(e.patch.path!);
      expect(samePrefix(path, P)).toBeGreaterThanOrEqual(H[j] + 1);
      expect(sameSuffix(path, P)).toBeGreaterThanOrEqual(P.length - H[j + 1]);
      checkSame(eng, T, e, '加弯点');
      added = true;
    }
    expect(added).toBe(true);
    // 删一个弯点
    let deleted = false;
    for (let j = 1; j < H.length - 1 && !deleted; j++) {
      const e = deleteHandle(w, w.derived, T, H, j);
      if (!ok(e) || e.plan.crossings.length) continue;
      const path = decodePath(e.patch.path!);
      expect(path.some((p) => p[0] === P[H[j]][0] && p[1] === P[H[j]][1])).toBe(false);
      expect(samePrefix(path, P)).toBeGreaterThanOrEqual(H[j - 1] + 1);
      expect(sameSuffix(path, P)).toBeGreaterThanOrEqual(P.length - H[j + 1]);
      checkSame(eng, T, e, '删弯点');
      deleted = true;
    }
    expect(deleted).toBe(true);
  });

  it('拖源头（往上游接长、往下游缩短）、拖终点（缩短、拖到陆地上在那里结束）：同一条河', () => {
    const { eng, w, g } = withDrawn('sink');
    const T = guideTarget(w, g);
    const H = controlHandles(T, 0.05 * spacing(w), 1.5 * spacing(w));
    const P = T.points;
    // 源头往上游（往画的反方向）挪两格
    const dir: Pt = [P[0][0] - P[1][0], P[0][1] - P[1][1]];
    const l = Math.hypot(...dir);
    let up: RiverEdit | null = null;
    // 第三十三轮：地形变了，挪 2、1.5、3 格都碰上别的河，多试几个距离
    for (const r of [2, 1.5, 3, 1, 2.5, 4]) {
      const e = dragHandle(w, w.derived, T, H, 0, [P[0][0] + (dir[0] / l) * r * spacing(w), P[0][1] + (dir[1] / l) * r * spacing(w)], opts(w));
      if (ok(e) && !e.plan.crossings.length) {
        up = e;
        break;
      }
    }
    expect(up).not.toBeNull();
    expect(up!.kind).toBe('source');
    const k1 = T.at[H[1]];
    expect(up!.patch.cells!.slice(-(g.cells.length - k1))).toEqual(g.cells.slice(k1));
    expect(sameSuffix(decodePath(up!.patch.path!), P)).toBeGreaterThanOrEqual(P.length - H[1]);
    checkSame(eng, T, up!, '源头往上游');
    // 源头挪到河上往下游：缩短
    const down = dragHandle(w, w.derived, T, H, 0, pointAt(P, 0.4), opts(w));
    if (!ok(down)) throw new Error(down.blocked);
    expect(down.kind).toBe('source');
    expect(g.cells.slice(-down.patch.cells!.length)).toEqual(down.patch.cells);
    expect(down.dropped.length).toBeGreaterThan(0);
    checkSame(eng, T, down, '源头往下游');
    // 终点挪回河上：缩短，在那里消失
    const back = dragHandle(w, w.derived, T, H, H.length - 1, pointAt(P, 0.6), opts(w));
    if (!ok(back)) throw new Error(back.blocked);
    expect(back.kind).toBe('shorten');
    expect(back.patch.end).toBe('sink');
    expect(g.cells.slice(0, back.patch.cells!.length)).toEqual(back.patch.cells);
    checkSame(eng, T, back, '终点缩短');
    // 终点拖到旁边的陆地上：在那里结束（消失）
    let moved: RiverEdit | null = null;
    for (const side of [1, -1]) {
      const nrm = normalAt(P, 1);
      const to: Pt = [P[P.length - 1][0] + side * nrm[0] * 2 * spacing(w), P[P.length - 1][1] + side * nrm[1] * 2 * spacing(w)];
      const e = dragHandle(w, w.derived, T, H, H.length - 1, to, opts(w));
      if (ok(e) && !e.plan.crossings.length && e.plan.end === 'sink') {
        moved = e;
        break;
      }
    }
    expect(moved).not.toBeNull();
    checkSame(eng, T, moved!, '终点挪到陆地上');
  });
});

describe('在河上重画一笔', () => {
  it('从河中间起笔画回同一条河（下游、上游方向）：只换中间那段；画到陆地上：从起笔处改道', () => {
    const { eng, w, g } = withDrawn('sink');
    const T = guideTarget(w, g);
    const P = T.points;
    let done = 0;
    for (const side of [1, -1]) {
      const a = pointAt(P, 0.3);
      const b = pointAt(P, 0.65);
      const n = normalAt(P, 0.47);
      const mid: Pt = [(a[0] + b[0]) / 2 + side * n[0] * 1.5 * spacing(w), (a[1] + b[1]) / 2 + side * n[1] * 1.5 * spacing(w)];
      for (const reverse of [false, true]) {
        const stroke = reverse ? poly(b, mid, a) : poly(a, mid, b);
        const e = strokeEdit(w, w.derived, T, stroke, opts(w));
        if (!ok(e) || e.plan.crossings.length) continue;
        expect(e.kind, `reverse=${reverse}`).toBe('splice');
        const path = decodePath(e.patch.path!);
        const pa = editPoint(w, T, ...a);
        const pb = editPoint(w, T, ...b);
        expect(samePrefix(path, P)).toBeGreaterThanOrEqual(pa.seg + 1);
        expect(sameSuffix(path, P)).toBeGreaterThanOrEqual(P.length - pb.seg - 1);
        // 终点照旧
        expect(e.patch.end).toBeUndefined();
        expect(e.patch.cells![e.patch.cells!.length - 1]).toBe(g.cells[g.cells.length - 1]);
        checkSame(eng, T, e, reverse ? '画回上游' : '画回下游');
        done++;
      }
      if (done) break;
    }
    expect(done).toBe(2);
    // 画到旁边的陆地上：从起笔处改道，起笔以前的折线不动，之后在画到的地方消失
    let rerouted = false;
    for (const side of [1, -1]) {
      const a = pointAt(P, 0.5);
      const n = normalAt(P, 0.5);
      const e = strokeEdit(w, w.derived, T, line(a, [a[0] + side * n[0] * 3 * spacing(w), a[1] + side * n[1] * 3 * spacing(w)], 20), opts(w));
      if (!ok(e) || e.plan.crossings.length || e.plan.end !== 'sink') continue;
      expect(e.kind).toBe('reroute');
      expect(samePrefix(decodePath(e.patch.path!), P)).toBeGreaterThanOrEqual(editPoint(w, T, ...a).seg + 1);
      expect(e.dropped.length).toBeGreaterThan(0);
      checkSame(eng, T, e, '改道到陆地');
      rerouted = true;
      break;
    }
    expect(rerouted).toBe(true);
  });

  it('改道到海里、到别的河上；从终点起笔往下游接长；从源头起笔往上游接长', () => {
    const { eng, w, g } = withDrawn('sink');
    const { mesh, derived: d } = w;
    const T = guideTarget(w, g);
    const P = T.points;
    const mid = pointAt(P, 0.5);
    // 最近的海、最近的另一条河（自然的大河）
    let sea = -1;
    let river = -1;
    let bs = Infinity;
    let br = Infinity;
    const mine = new Set(g.cells);
    for (let i = 0; i < mesh.n; i++) {
      const dd = Math.hypot(mesh.x[i] - mid[0], mesh.y[i] - mid[1]);
      if (!w.causes.land[i] && dd < bs) {
        bs = dd;
        sea = i;
      }
      if (isRiverCell(w, d, i) && !mine.has(i) && d.discharge[i] > 3 * w.small.planet.riverThreshold && dd < br) {
        br = dd;
        river = i;
      }
    }
    const kinds: string[] = [];
    for (const [target, end] of [
      [sea, 'sea'],
      [river, 'river'],
    ] as const) {
      for (const f of [0.5, 0.3, 0.7, 0.2, 0.8]) {
        const a = pointAt(P, f);
        const e0 = strokeEdit(w, w.derived, T, line(a, at(w, target), 40), opts(w));
        const e = ok(e0) && end === 'river' ? joinAtFirst(w, d, T, e0) : e0;
        if (!ok(e) || e.plan.end !== end) continue;
        expect(e.kind).toBe('reroute');
        checkSame(eng, T, e, `改道到${end}`);
        kinds.push(end);
        break;
      }
    }
    expect(kinds).toEqual(['sea', 'river']);
    // 从终点往外画：接长
    const E = P[P.length - 1];
    let extended = false;
    for (let k = 0; k < 16 && !extended; k++) {
      const ang = (k * Math.PI) / 8;
      const e = strokeEdit(w, w.derived, T, line(E, [E[0] + 3 * spacing(w) * Math.cos(ang), E[1] + 3 * spacing(w) * Math.sin(ang)], 20), opts(w));
      if (!ok(e) || e.plan.crossings.length || e.patch.cells!.length <= g.cells.length) continue;
      expect(e.kind).toBe('extend');
      expect(e.patch.cells!.slice(0, g.cells.length)).toEqual(g.cells);
      checkSame(eng, T, e, '接长');
      extended = true;
    }
    expect(extended).toBe(true);
    // 从源头往外画：源头往上游接长，原来的河道一格不动
    let headed = false;
    for (let k = 0; k < 16 && !headed; k++) {
      const ang = (k * Math.PI) / 8;
      const e = strokeEdit(w, w.derived, T, line(P[0], [P[0][0] + 3 * spacing(w) * Math.cos(ang), P[0][1] + 3 * spacing(w) * Math.sin(ang)], 20), opts(w));
      if (!ok(e) || e.plan.crossings.length || e.patch.cells!.length <= g.cells.length) continue;
      expect(e.kind).toBe('source');
      expect(e.patch.cells!.slice(-g.cells.length)).toEqual(g.cells);
      expect(sameSuffix(decodePath(e.patch.path!), P)).toBe(P.length);
      checkSame(eng, T, e, '源头接长');
      headed = true;
    }
    expect(headed).toBe(true);
  });
});

describe('自然的河', () => {
  it('改一次后固定成一条画的河：名字照旧，原来的支流照旧汇入，河道多一条；撤销还原', () => {
    const eng = continents();
    const w = eng.world;
    const d = w.derived;
    const thr = w.small.planet.riverThreshold;
    const named = d.features.filter((f) => f.type === 'river' && f.name && f.guide === undefined).sort((a, b) => b.cells.length - a.cells.length);
    let done = false;
    for (const f of named.slice(0, 8)) {
      const cell = Array.from(f.cells).find((c) => isRiverCell(w, d, c) && d.discharge[c] > 2 * thr);
      if (cell === undefined) continue;
      const T = naturalTarget(w, d, cell)!;
      expect(T.natural).toBe(true);
      const H = controlHandles(T, 0.05 * spacing(w), 2 * spacing(w));
      if (H.length < 5) continue;
      const P = T.points;
      const j = Math.floor(H.length / 2);
      // 支流：流进主干、在改的那段以上的河
      const tribs = [...Array(w.mesh.n).keys()].filter((c) => isRiverCell(w, d, c) && !T.guide.cells.includes(c) && T.guide.cells.indexOf(d.receiver[c]) >= 0 && T.guide.cells.indexOf(d.receiver[c]) <= T.at[H[j - 1]]);
      const recv = tribs.map((c) => d.receiver[c]);
      for (const side of [1, -1]) {
        const n = normalAt(P, H[j] / (P.length - 1));
        const e = dragHandle(w, d, T, H, j, [P[H[j]][0] + side * n[0] * spacing(w), P[H[j]][1] + side * n[1] * spacing(w)], opts(w));
        if (!ok(e) || e.plan.crossings.length) continue;
        const before = JSON.stringify(w.small);
        const count = w.small.guides.length;
        const cmd = editCommand(T, e, '改了一条自然的河');
        expect(cmd.op).toBe('add_guide');
        if (cmd.op !== 'add_guide') throw new Error();
        expect(cmd.guide.nameKey).toBe(f.key);
        expect(cmd.guide.locked).toBe(true);
        eng.exec(cmd);
        expect(w.small.guides.length).toBe(count + 1);
        const g = w.small.guides[w.small.guides.length - 1];
        expect(w.derived.features.find((x) => x.guide === g.id)?.name).toBe(f.name);
        // 同名的自然河没了（还是一条河）
        expect(w.derived.features.filter((x) => x.name === f.name).length).toBe(1);
        expect(tribs.map((c) => w.derived.receiver[c])).toEqual(recv);
        for (const c of tribs) expect(isRiverCell(w, w.derived, c)).toBe(true);
        for (const c of g.cells) if (land(w, c)) expect(isRiverCell(w, w.derived, c)).toBe(true);
        expect(digestWorld(w)).toEqual(digestWorld(Engine.fromDoc(eng.toDoc(), w.mesh).world));
        // 再改一次：改的是这条画的河（update_guide），不再多一条
        const T2 = guideTarget(w, g);
        const H2 = controlHandles(T2, 0.05 * spacing(w), 2 * spacing(w));
        const e2 = dragHandle(w, w.derived, T2, H2, 1, [T2.points[H2[1]][0] + 0.3 * spacing(w), T2.points[H2[1]][1]], opts(w));
        if (ok(e2)) checkSame(eng, T2, e2, '再改一次');
        eng.undo();
        expect(JSON.stringify(w.small)).toBe(before);
        done = true;
        break;
      }
      if (done) break;
    }
    expect(done).toBe(true);
  });
});

describe('所见即所得', () => {
  it('画的河整条是河：往高处画、水被截走，画的线一路都画出来', () => {
    const eng = continents();
    const w = eng.world;
    const { mesh, derived: d } = w;
    // 往高处画到消失（本来没有水的地方）
    let plan: CoursePlan | null = null;
    for (let i = 0; i < mesh.n && !plan; i += 13) {
      if (!land(w, i) || isRiverCell(w, d, i) || d.elevation[i] > 600) continue;
      for (let k = 0; k < 8 && !plan; k++) {
        const ang = (k * Math.PI) / 4;
        const p = planCourse(w, d, line(at(w, i), [mesh.x[i] + 6 * mesh.spacing * Math.cos(ang), mesh.y[i] + 6 * mesh.spacing * Math.sin(ang)]), { endOnLand: 'sink' });
        if (!p.blocked && p.end === 'sink' && !p.crossings.length && !p.reroute && p.uphill > 100 && p.cells.length >= 6) plan = p;
      }
    }
    expect(plan).not.toBeNull();
    // 没有泉水（不加水）：照样整条是河
    eng.exec({ op: 'add_guide', guide: { cells: plan!.cells, path: encodePath(plan!.path), locked: true, spring: false, end: 'sink' } });
    const g = w.small.guides[w.small.guides.length - 1];
    for (const c of g.cells) expect(isRiverCell(w, w.derived, c)).toBe(true);
    // 画出来的线覆盖整条河道
    const lines = traceRivers(w).filter((l) => l.guide === g.id);
    const drawn = new Set(lines.flatMap((l) => l.cells!));
    for (const c of g.cells) expect(drawn.has(c)).toBe(true);
  });

  it('预览的河网（previewWorld）= 执行后的河网，逐格、画出来的线逐点', () => {
    const { eng, w, g } = withDrawn('sink');
    const T = guideTarget(w, g);
    const P = T.points;
    let e: RiverEdit | null = null;
    for (const side of [1, -1]) {
      const a = pointAt(P, 0.5);
      const n = normalAt(P, 0.5);
      const r = strokeEdit(w, w.derived, T, line(a, [a[0] + side * n[0] * 4 * spacing(w), a[1] + side * n[1] * 4 * spacing(w)], 20), opts(w, 'flow'));
      if (ok(r)) {
        e = r;
        break;
      }
    }
    expect(e).not.toBeNull();
    const cmd: Command = editCommand(T, e!, '改道');
    const pv = eng.previewWorld(cmd);
    const future = previewWorldOf(w, pv.patch);
    const lines = JSON.stringify(traceRivers(future));
    const cells = riverCells(future);
    eng.exec(cmd);
    expect(riverCells(w)).toEqual(cells);
    expect(JSON.stringify(traceRivers(w))).toBe(lines);
  });
});

// 审查后补的（第十一轮）：改河不悄悄截断别的画的河、补水只补真的照着走的那段、重放一致、
// 自然的河在汇合处不断开、名字和类型照旧、汇进来的河不抢走下游的名字
describe('改河的边角', () => {
  it('从一条画的支流的终点往外接长、穿过它汇入的那条画的河：算作截走那条河（截在那里），那条河下游不留着假的河', () => {
    const { eng, w, g: G } = withDrawn('sink');
    const { mesh: m } = w;
    const s = m.spacing;
    // 画的支流 H，汇入 G 的中间一格 X
    const X = G.cells[Math.floor(G.cells.length / 2)];
    let H: Guide | null = null;
    for (const ang of [Math.PI / 2, -Math.PI / 2, Math.PI / 3, -Math.PI / 3, 2, -2]) {
      const a: Pt = [m.x[X] + 4 * s * Math.cos(ang), m.y[X] + 4 * s * Math.sin(ang)];
      const p = planCourse(w, w.derived, line(a, at(w, X)), { endOnLand: 'flow', px: s / 20 });
      if (p.blocked || p.end !== 'river' || p.crossings.length || p.reroute || p.merge || p.cells[p.cells.length - 1] !== X) continue;
      eng.exec({ op: 'add_guide', guide: { cells: p.cells, path: encodePath(p.path), locked: true, spring: true, flow: 1.2, name: '' } });
      H = w.small.guides[w.small.guides.length - 1];
      break;
    }
    expect(H).not.toBeNull();
    const TH = guideTarget(w, H!);
    const E = TH.points[TH.points.length - 1];
    const P0 = TH.points[0];
    const l = Math.hypot(E[0] - P0[0], E[1] - P0[1]);
    const e = strokeEdit(w, w.derived, TH, line(E, [E[0] + ((E[0] - P0[0]) / l) * 3 * s, E[1] + ((E[1] - P0[1]) / l) * 3 * s], 20), opts(w));
    if (!ok(e)) throw new Error(e.blocked);
    expect(e.patch.cells).toContain(X);
    // 穿过 X：记作穿过 G，命令截走它
    expect(e.plan.crossings.some((x) => x.guide === G.id)).toBe(true);
    const cmd = editCommand(TH, e, '接长');
    expect(cmd).toMatchObject({ capture: true });
    eng.exec(cmd);
    const G2 = w.small.guides.find((x) => x.id === G.id)!;
    // G 截在新河道第一次碰到它的地方，汇进新河道
    expect(G2.cells.length).toBeLessThan(G.cells.length);
    expect(e.patch.cells).toContain(G2.cells[G2.cells.length - 1]);
    for (const c of G2.cells.slice(0, -1)) expect(isRiverCell(w, w.derived, c)).toBe(true);
  });

  it('源头不能挪到别的河上；补水只补水照着这条河道走的那段（被后画的河接管的那格以下照样变干）', () => {
    const { eng, w, g: A } = withDrawn('sink');
    const s = spacing(w);
    // 另一条画的河 B，源头挪到 A 的中间：不让
    let B: Guide | null = null;
    const PA = guideTarget(w, A).points;
    for (const f of [0.5, 0.4, 0.6, 0.3, 0.7]) {
      for (const side of [1, -1]) {
        if (B) break;
        const a = pointAt(PA, f);
        const n = normalAt(PA, f);
        const p = planCourse(w, w.derived, line([a[0] + side * n[0] * 2.5 * s, a[1] + side * n[1] * 2.5 * s], [a[0] + side * n[0] * 9 * s, a[1] + side * n[1] * 9 * s]), {
          endOnLand: 'sink',
          px: s / 20,
        });
        if (p.blocked || p.crossings.length || p.reroute || p.merge || p.end !== 'sink' || p.cells.length < 4) continue;
        eng.exec({ op: 'add_guide', guide: { cells: p.cells, path: encodePath(p.path), locked: true, spring: true, flow: 1.2, name: '', end: 'sink' } });
        B = w.small.guides[w.small.guides.length - 1];
      }
    }
    expect(B).not.toBeNull();
    const TB = guideTarget(w, B!);
    const H = controlHandles(TB, 0.05 * s, 1.5 * s);
    const r = dragHandle(w, w.derived, TB, H, 0, pointAt(PA, 0.5), opts(w));
    expect('blocked' in r && r.blocked.startsWith('源头不能在别的河上：')).toBe(true);
    // 一条不截走的河道（脚本、旧命令能这样写）从 A 的中间一格接管：A 那格以下不再补水
    const k = Math.floor(A.cells.length / 2);
    const c = A.cells[k];
    const other = Array.from(w.mesh.adj.slice(w.mesh.off[c], w.mesh.off[c + 1])).find((j) => land(w, j) && !A.cells.includes(j) && !B!.cells.includes(j));
    expect(other).toBeDefined();
    eng.exec({ op: 'add_guide', guide: { cells: [c, other!], locked: true, spring: false, end: 'sink' } });
    const below = A.cells.slice(k + 1).filter((x) => land(w, x));
    expect(below.some((x) => !isRiverCell(w, w.derived, x))).toBe(true);
    expect(digestWorld(w)).toEqual(digestWorld(Engine.fromDoc(eng.toDoc(), w.mesh).world));
  });

  it('只加上折线（同样的格）也从水文起重算：一步一步改与从头重放逐值一致', () => {
    const eng = continents();
    const w = eng.world;
    const p = drawnRiver(w, 'sink');
    eng.exec({ op: 'add_guide', guide: { cells: p.cells, locked: true, spring: false, end: 'sink' } });
    const g = w.small.guides[w.small.guides.length - 1];
    eng.exec({ op: 'update_guide', id: g.id, patch: { path: encodePath(p.path) } });
    for (const c of g.cells) if (land(w, c)) expect(isRiverCell(w, w.derived, c)).toBe(true);
    expect(digestWorld(w)).toEqual(digestWorld(Engine.fromDoc(eng.toDoc(), w.mesh).world));
  });

  it('很短的河：起笔离哪头近就是哪头（不总是源头）', () => {
    const e = { seg: 0, t: 0.9, d: 0, along: 9, total: 10, p: [0, 0] as Pt };
    expect(editRole(e, 20)).toBe('end');
    expect(editRole({ ...e, along: 1 }, 20)).toBe('source');
    expect(editRole({ ...e, along: 5, total: 100 }, 2)).toBe('middle');
  });
});

describe('名字与汇合处', () => {
  // 一条有名字的自然大河的主干上的一格
  function namedRiver(w: World): { name: string; key: string; cell: number } {
    const d = w.derived;
    const f = d.features.filter((x) => x.type === 'river' && x.name && x.guide === undefined).sort((a, b) => b.cells.length - a.cells.length)[0];
    const cell = Array.from(f.cells).find((c) => isRiverCell(w, d, c) && d.discharge[c] > 2 * w.small.planet.riverThreshold)!;
    return { name: f.name, key: f.key, cell };
  }

  it('画的支流汇进一条自然的河：自然的河的主干照样穿过汇合处（选中、改它不会在汇合处断开）', () => {
    const eng = continents();
    const w = eng.world;
    const { cell } = namedRiver(w);
    const stem = riverStem(w, w.derived, cell);
    const m = w.mesh;
    let added = false;
    for (let k = Math.floor(stem.cells.length / 2); k < stem.cells.length - 3 && !added; k++) {
      const X = stem.cells[k];
      for (let e = m.off[X]; e < m.off[X + 1] && !added; e++) {
        const Y = m.adj[e];
        if (!land(w, Y) || isRiverCell(w, w.derived, Y) || stem.cells.includes(Y)) continue;
        for (let e2 = m.off[Y]; e2 < m.off[Y + 1] && !added; e2++) {
          const Z = m.adj[e2];
          if (!land(w, Z) || isRiverCell(w, w.derived, Z) || stem.cells.includes(Z) || Z === X) continue;
          eng.exec({ op: 'add_guide', guide: { cells: [Z, Y, X], path: encodePath([at(w, Z), at(w, Y), at(w, X)]), locked: true, spring: true, flow: 1.2, name: '' } });
          added = true;
        }
      }
    }
    expect(added).toBe(true);
    for (const c of [stem.cells[1], stem.cells[stem.cells.length - 3]]) {
      const s2 = riverStem(w, w.derived, c);
      expect(s2.cells[0]).toBe(stem.cells[0]);
      expect(s2.cells[s2.cells.length - 1]).toBe(stem.cells[stem.cells.length - 1]);
    }
  });

  it('自然的河改道：改的这条河还叫原来的名字（不是用户起的名字），剩下的旧河道另起名字', () => {
    const eng = continents();
    const w = eng.world;
    const { name, cell } = namedRiver(w);
    const T = naturalTarget(w, w.derived, cell)!;
    expect(T.guide.autoName).toBe(name);
    const P = T.points;
    let done = false;
    for (const f of [0.5, 0.4, 0.6, 0.3]) {
      for (const side of [1, -1]) {
        if (done) break;
        const a = pointAt(P, f);
        const n = normalAt(P, f);
        const e = strokeEdit(w, w.derived, T, line(a, [a[0] + side * n[0] * 5 * spacing(w), a[1] + side * n[1] * 5 * spacing(w)], 25), opts(w, 'flow'));
        if (!ok(e) || e.plan.crossings.length) continue;
        eng.exec(editCommand(T, e, '改道'));
        const g = w.small.guides[w.small.guides.length - 1];
        const gf = w.derived.features.find((x) => x.guide === g.id)!;
        expect(gf.name).toBe(name);
        expect(gf.custom).toBe(false);
        // 同名的只有它一个（剩下的旧河道有地名的话另起名字）
        expect(w.derived.features.filter((x) => x.name === name).length).toBe(1);
        // 再改一次（画的河了）：还叫这个名字
        const T2 = guideTarget(w, g);
        const H2 = controlHandles(T2, 0.05 * spacing(w), 2 * spacing(w));
        const e2 = dragHandle(w, w.derived, T2, H2, 1, [T2.points[H2[1]][0] + 0.4 * spacing(w), T2.points[H2[1]][1]], opts(w));
        if (ok(e2)) {
          eng.exec(editCommand(T2, e2, '再改'));
          expect(w.derived.features.find((x) => x.guide === g.id)?.name).toBe(name);
        }
        done = true;
      }
    }
    expect(done).toBe(true);
  });

  it('按规则是血河的自然的河：固定下来、改了以后还是血河（类型记下来）', () => {
    const eng = continents();
    eng.exec(applyPackCommands(eng.world, FANTASY_PACK));
    const w = eng.world;
    const d = w.derived;
    const types = w.small.riverTypes ?? [];
    const c = [...Array(w.mesh.n).keys()].find((i) => isRiverCell(w, d, i) && !!d.riverType && d.riverType[i] > 0 && riverStem(w, d, i).cells.length >= 6);
    expect(c).toBeDefined();
    const T = naturalTarget(w, d, c!)!;
    const id = T.guide.type!;
    expect(types.some((t) => t.id === id)).toBe(true);
    const H = controlHandles(T, 0.05 * spacing(w), 1.5 * spacing(w));
    let done = false;
    for (let j = 1; j < H.length - 1 && !done; j++) {
      const e = dragHandle(w, d, T, H, j, [T.points[H[j]][0] + 0.3 * spacing(w), T.points[H[j]][1]], opts(w));
      if (!ok(e) || e.plan.crossings.length) continue;
      eng.exec(editCommand(T, e, '改'));
      const g = w.small.guides[w.small.guides.length - 1];
      expect(g.type).toBe(id);
      const k = types.findIndex((t) => t.id === id) + 1;
      expect(g.cells.filter((x) => isRiverCell(w, w.derived, x)).every((x) => w.derived.riverType![x] === k)).toBe(true);
      done = true;
    }
    expect(done).toBe(true);
  });

  it('一条更大的画的河汇进自然的河：被汇入的河的下游照样叫原来的名字', () => {
    const eng = continents();
    const w = eng.world;
    const d = w.derived;
    const m = w.mesh;
    const s = m.spacing;
    const { name, key, cell } = namedRiver(w);
    const stem = riverStem(w, d, cell).cells;
    for (const X of stem.slice(Math.floor(stem.length / 4), Math.floor(stem.length / 2))) {
      for (let a = 0; a < 8; a++) {
        const ang = (a * Math.PI) / 4;
        const p = planCourse(w, d, line([m.x[X] + 5 * s * Math.cos(ang), m.y[X] + 5 * s * Math.sin(ang)], at(w, X)), { endOnLand: 'flow', px: s / 20 });
        if (p.blocked || p.end !== 'river' || p.crossings.length || p.reroute || p.merge || !stem.includes(p.join)) continue;
        eng.exec({ op: 'add_guide', guide: { cells: p.cells, path: encodePath(p.path), locked: true, spring: true, flow: 120, name: '' } });
        const f = w.derived.features.find((x) => x.key === key);
        expect(f?.name).toBe(name);
        // 它原来汇合处以上的上游也还是它（叫原来的名字）
        const up = stem.slice(0, stem.indexOf(X)).filter((c) => isRiverCell(w, w.derived, c) && !p.cells.includes(c));
        const inF = new Set(Array.from(f!.cells));
        expect(up.filter((c) => inF.has(c)).length).toBeGreaterThanOrEqual(Math.floor(up.length * 0.8));
        return;
      }
    }
    throw new Error('找不到汇入的一笔');
  });
});
