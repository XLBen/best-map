import { describe, expect, it } from 'vitest';
import type { Command } from './commands';
import { encodePath, guideLine, traceRivers } from './rivers';
import { type CoursePlan, guideEnd, isRiverCell, planCourse } from './select';
import { continents } from './testing/fixtures';
import type { Guide, World } from './world';

// 第十三轮：贴着别的河画（离它的线不到半格、跟着它走一段、画到它旁边为止）不截走它，在第一次碰到它的地方汇入；
// 只有画的线从它的一侧穿到另一侧才算穿过（截走它）。截走的河剩下的上游照样流下去（流进截走它的河）

type Pt = [number, number];

function line(a: Pt, b: Pt, n = 40): Pt[] {
  const out: Pt[] = [];
  for (let k = 0; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  return out;
}

const at = (w: World, c: number): Pt => [w.mesh.x[c], w.mesh.y[c]];

function courseCmd(plan: CoursePlan, extra: Partial<Guide> = {}): Command {
  return {
    op: 'add_guide',
    guide: { cells: plan.cells, path: encodePath(plan.path), locked: true, spring: true, flow: 2, name: '', ...(plan.end === 'sink' ? { end: 'sink' } : {}), ...extra },
  };
}

// 一条往东画的河 B（不碰别的河、14 格左右、接着流）
function riverB() {
  const eng = continents();
  const w = eng.world;
  const { mesh } = w;
  let B: CoursePlan | null = null;
  for (let i = 0; i < mesh.n && !B; i += 7) {
    if (!w.causes.land[i] || w.derived.continentality[i] < 0.5 || isRiverCell(w, w.derived, i)) continue;
    const p = planCourse(w, w.derived, line(at(w, i), [mesh.x[i] + 14 * mesh.spacing, mesh.y[i] + 2 * mesh.spacing]), { endOnLand: 'flow' });
    if (!p.blocked && p.drawn >= 12 && !p.crossings.length && !p.reroute) B = p;
  }
  eng.exec(courseCmd(B!, { id: 'river-b' }));
  return { eng, w, B: B! };
}

// B 画出来的线往一侧（side = ±1）挪开 off 格：从第 k0 到第 k1 个点
function besideB(w: World, side: number, off: number, k0: number, k1: number): Pt[] {
  const g = w.small.guides.find((x) => x.id === 'river-b')!;
  const P = guideLine(w, g).points;
  const sp = w.mesh.spacing;
  const out: Pt[] = [];
  for (let k = k0; k <= k1 && k < P.length; k++) {
    const a = P[Math.max(0, k - 1)];
    const b = P[Math.min(P.length - 1, k + 1)];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    out.push([P[k][0] - ((b[1] - a[1]) / l) * side * off * sp, P[k][1] + ((b[0] - a[0]) / l) * side * off * sp]);
  }
  return out;
}

describe('贴着别的河画不截走它（第十三轮）', () => {
  it('从一侧画过来、贴着它走一段、又从同一侧离开，在它旁边消失：不截走，在第一次碰到它的地方汇入；B 一点不变', () => {
    const { eng, w } = riverB();
    const { mesh } = w;
    const g0 = structuredClone(w.small.guides.find((x) => x.id === 'river-b')!);
    let tried = 0;
    for (const side of [1, -1]) {
      // 从 B 一侧 3 格外斜着画过来，贴着 B（离它的线 0.25 格）往下游走约 6 格
      const along = besideB(w, side, 0.25, 6, 20);
      const s0 = along[0];
      const g = w.small.guides.find((x) => x.id === 'river-b')!;
      const P = guideLine(w, g).points;
      const a = P[5];
      const b = P[7];
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const start: Pt = [s0[0] - ((b[1] - a[1]) / l) * side * 3 * mesh.spacing - ((b[0] - a[0]) / l) * 2 * mesh.spacing, s0[1] + ((b[0] - a[0]) / l) * side * 3 * mesh.spacing - ((b[1] - a[1]) / l) * 2 * mesh.spacing];
      // 最后从同一侧离开 B，停在它旁边的陆地上（不在 B 上）
      const e0 = along[along.length - 1];
      const away = besideB(w, side, 2, 21, 24);
      const stroke = [...line(start, s0, 20), ...along.slice(1), ...line(e0, away[away.length - 1], 10).slice(1)];
      const plan = planCourse(w, w.derived, stroke, { endOnLand: 'sink' });
      if (plan.blocked || plan.reroute) continue;
      tried++;
      // 不截走 B
      expect(plan.crossings.some((x) => x.guide === 'river-b')).toBe(false);
      // 碰到了 B：在那里汇入（碰到的那一格是 B 的）
      expect(plan.end).toBe('river');
      expect(g.cells).toContain(plan.join);
      expect(plan.touch).toBe(plan.join);
      eng.exec(courseCmd(plan, { id: `river-a${side}` }));
      const b2 = w.small.guides.find((x) => x.id === 'river-b')!;
      expect(b2.cells).toEqual(g0.cells);
      expect(b2.path).toEqual(g0.path);
      expect(guideEnd(w, w.derived, b2).kind).toBe(guideEnd(w, w.derived, g0).kind);
      eng.undo();
    }
    expect(tried).toBeGreaterThan(0);
  });

  it('横穿过去照样截走；截走的河剩下的上游流进截走它的河（新河在终点消失也一样），每条画的河都流得出去', () => {
    const { eng, w, B } = riverB();
    const { mesh } = w;
    const mid = B.cells[Math.floor(B.drawn / 2)];
    for (const end of ['flow', 'sink'] as const) {
      const A = planCourse(w, w.derived, line([mesh.x[mid] - 0.5 * mesh.spacing, mesh.y[mid] - 5 * mesh.spacing], [mesh.x[mid] + 0.5 * mesh.spacing, mesh.y[mid] + 5 * mesh.spacing]), { endOnLand: end });
      expect(A.blocked).toBeNull();
      expect(A.touch).toBeUndefined();
      expect(A.crossings.some((x) => x.guide === 'river-b')).toBe(true);
      eng.exec({ ...courseCmd(A, { id: 'river-a' }), capture: true } as Command);
      const b = w.small.guides.find((g) => g.id === 'river-b')!;
      expect(b.cells.length).toBeLessThan(B.cells.length);
      // B 剩下的上游流进 A
      expect(guideEnd(w, w.derived, b).kind).toBe('river');
      expect(A.cells).toContain(b.cells[b.cells.length - 1]);
      for (const g of w.small.guides) expect(guideEnd(w, w.derived, g).kind).not.toBe('unknown');
      // 画出来：B 的线汇入 A 的线（不停在陆地上）
      const lines = traceRivers(w);
      const lb = lines.filter((l) => l.guide === 'river-b');
      const last = lb[lb.length - 1];
      expect(last.into).toBeDefined();
      expect(lines[last.into!].guide).toBe('river-a');
      eng.undo();
    }
  });
});
