import { describe, expect, it } from 'vitest';
import { digestWorld } from '../tools/hash';
import type { Command } from './commands';
import { Engine } from './engine';
import { BRANCH_SHARE, branchCourse, guideTarget, naturalTarget, sourceCourse } from './river-edit';
import { encodePath, snapOnto, traceRivers } from './rivers';
import { isRiverCell, planCourse, riverStem } from './select';
import { continents } from './testing/fixtures';
import type { World } from './world';

// 第十三轮：一条河分一股出去（分流、三角洲），一条河加一个源头（同一个名字）

type Pt = [number, number];
const at = (w: World, c: number): Pt => [w.mesh.x[c], w.mesh.y[c]];

function line(a: Pt, b: Pt, n = 30): Pt[] {
  const out: Pt[] = [];
  for (let k = 0; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  return out;
}

// 最大的自然河的主干，与它中下游的一格
function bigRiver(w: World) {
  const d = w.derived;
  const f = d.features.filter((x) => x.type === 'river' && x.guide === undefined).sort((a, b) => b.cells.length - a.cells.length)[0];
  const stem = riverStem(w, d, f.cells[Math.floor(f.cells.length / 2)]);
  return stem;
}

// 从主干的第 k 格垂直于河往外画 len 格（左右两边先试左边）：分一股出去
function branchFrom(w: World, k: number, len: number, side: number, endOnLand: 'flow' | 'sink' = 'flow') {
  const stem = bigRiver(w);
  const T = naturalTarget(w, w.derived, stem.cells[k])!;
  const c = stem.cells[k];
  const a = stem.cells[k - 1];
  const b = stem.cells[k + 1];
  const dx = w.mesh.x[b] - w.mesh.x[a];
  const dy = w.mesh.y[b] - w.mesh.y[a];
  const l = Math.hypot(dx, dy) || 1;
  const sp = w.mesh.spacing;
  const [x, y] = at(w, c);
  const stroke = line([x, y], [x + ((-dy / l) * side + (dx / l) * 0.5) * len * sp, y + ((dx / l) * side + (dy / l) * 0.5) * len * sp]);
  return { T, r: branchCourse(w, w.derived, T, stroke, { endOnLand }), stem };
}

function branchCmd(plan: { cells: number[]; path: Pt[]; end: string | null }, share = BRANCH_SHARE): Command {
  return {
    op: 'add_guide',
    guide: { cells: plan.cells, path: encodePath(plan.path), locked: true, spring: false, name: '', branch: { share }, ...(plan.end === 'sink' ? { end: 'sink' as const } : {}) },
  };
}

function findBranch(w: World) {
  const stem = bigRiver(w);
  for (let k = Math.floor(stem.cells.length * 0.5); k < stem.cells.length - 4; k++)
    for (const side of [1, -1]) {
      const got = branchFrom(w, k, 5, side, 'sink');
      if (!('blocked' in got.r) && got.r.plan.crossings.length === 0 && got.r.plan.cells.length >= 4) return { ...got, r: got.r, k };
    }
  throw new Error('找不到能分出去的地方');
}

describe('分一股出去', () => {
  it('水真的分开：分出去的一股带走 share × 分出处的水，干流往下少这么多；单一下游、流域不变', () => {
    const eng = continents();
    const w0 = eng.world;
    const { r, stem } = findBranch(w0);
    const s = r.cell;
    const q0 = w0.derived.discharge.slice();
    const recv0 = w0.derived.receiver.slice();
    const below = w0.derived.receiver[s];
    eng.exec(branchCmd(r.plan));
    const w = eng.world;
    const d = w.derived;
    const g = w.small.guides[w.small.guides.length - 1];
    expect(g.branch?.share).toBe(BRANCH_SHARE);
    expect(g.cells[0]).toBe(s);
    // 分出的那一格的流向不变（还是干流的下一格）
    expect(d.receiver[s]).toBe(recv0[s]);
    const Qs = d.discharge[s];
    // 分出去的一股：至少是分出处水量的 share（再加上一路上本来的水）
    expect(d.discharge[g.cells[1]]).toBeGreaterThanOrEqual(BRANCH_SHARE * Qs * 0.999);
    // 干流下一格少了 share × Q[s]（原来的水减去分走的）
    const want = Math.max(0, q0[below] - (q0[s] - Qs) - BRANCH_SHARE * Qs);
    expect(Math.abs(d.discharge[below] - want) / want).toBeLessThan(0.01);
    expect(d.discharge[below]).toBeLessThan(q0[below] - 0.2 * BRANCH_SHARE * Qs);
    // 上游不受影响
    const up = stem.cells[stem.cells.indexOf(s) - 2];
    expect(d.discharge[up]).toBeCloseTo(q0[up], 6);
    // 画出来：分出去的一股从干流画出来的线上起
    const lines = traceRivers(w);
    const mine = lines.filter((l) => l.guide === g.id);
    expect(mine.length).toBeGreaterThan(0);
    const p = mine[0].points[0];
    const trunk = lines.filter((l) => l.guide === undefined && l.cells?.includes(s));
    expect(trunk.length).toBeGreaterThan(0);
    expect(Math.min(...trunk.map((l) => snapOnto(l.points, p[0], p[1])!.d))).toBeLessThan(1e-9);
    // 干流照常画过分出的那一格（没有在那里断开）
    expect(trunk.some((l) => l.cells!.indexOf(s) > 0 && l.cells!.indexOf(s) < l.cells!.length - 1)).toBe(true);
    // 重放逐值相同；撤销回到原样
    expect(digestWorld(w)).toEqual(digestWorld(Engine.fromDoc(eng.toDoc(), w.mesh).world));
    eng.undo();
    expect(Array.from(eng.world.derived.discharge)).toEqual(Array.from(q0));
  });

  it('没有分流的世界：流量与原来逐值相同（不经过分流那一步）', () => {
    const eng = continents();
    const before = digestWorld(eng.world);
    eng.exec({ op: 'set_planet', patch: {} });
    expect(digestWorld(eng.world)).toEqual(before);
  });

  it('分出去又画回这条河的下游：水回到干流（汇合以下不变）', () => {
    const eng = continents();
    const w0 = eng.world;
    const stem = bigRiver(w0);
    const d0 = w0.derived;
    // 从第 k 格分出去，绕一个弯画回第 k + 5 格
    let done = false;
    for (let k = Math.floor(stem.cells.length * 0.4); k < stem.cells.length - 8 && !done; k++) {
      for (const side of [1, -1]) {
        const T = naturalTarget(w0, d0, stem.cells[k])!;
        const a = at(w0, stem.cells[k]);
        const b = at(w0, stem.cells[k + 5]);
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const mid: Pt = [(a[0] + b[0]) / 2 - dy * 0.5 * side, (a[1] + b[1]) / 2 + dx * 0.5 * side];
        const r = branchCourse(w0, d0, T, [...line(a, mid, 15), ...line(mid, b, 15).slice(1)], { endOnLand: 'flow' });
        if ('blocked' in r || r.plan.end !== 'river' || r.plan.crossings.length) continue;
        const join = r.plan.join;
        const ji = stem.cells.indexOf(join);
        const si = stem.cells.indexOf(r.cell);
        if (ji <= si + 1 || si < 0) continue;
        const after = stem.cells[Math.min(stem.cells.length - 2, ji + 2)];
        const q0 = d0.discharge[after];
        const qTrunk = d0.discharge[stem.cells[si + 1]];
        eng.exec(branchCmd(r.plan));
        const d = eng.world.derived;
        // 汇合以下：水回来了（只差一路上本来的水的变化，挖河床不改产流）
        expect(Math.abs(d.discharge[after] - q0) / q0).toBeLessThan(0.02);
        // 两格之间的干流少了一股
        expect(d.discharge[stem.cells[si + 1]]).toBeLessThan(qTrunk * 0.85);
        done = true;
        break;
      }
    }
    expect(done).toBe(true);
  });

  it('从别处起笔、一直画在河上：不分', () => {
    const w = continents().world;
    const stem = bigRiver(w);
    const T = naturalTarget(w, w.derived, stem.cells[5])!;
    const r = branchCourse(w, w.derived, T, [at(w, stem.cells[5]), at(w, stem.cells[6]), at(w, stem.cells[7])], { endOnLand: 'flow' });
    expect('blocked' in r).toBe(true);
  });
});

describe('加一个源头', () => {
  it('画的源头算这条河的一部分：同一个名字，不单独成一条河；改名跟着走', () => {
    const eng = continents();
    const w0 = eng.world;
    const stem = bigRiver(w0);
    // 先把这条河固定成画的河（有名字）
    eng.exec({ op: 'add_guide', guide: { id: 'main', cells: stem.cells, path: encodePath(stem.cells.map((c) => at(w0, c))), locked: true, spring: false, name: '' } });
    const w1 = eng.world;
    const T = guideTarget(w1, w1.small.guides[0]);
    // 从主干三成处往旁边画出去 5 格
    let made = false;
    for (let k = Math.floor(stem.cells.length * 0.3); k < stem.cells.length * 0.7 && !made; k++) {
      for (const side of [1, -1]) {
        const c = stem.cells[k];
        const a = stem.cells[k - 1];
        const b = stem.cells[k + 1];
        const dx = w1.mesh.x[b] - w1.mesh.x[a];
        const dy = w1.mesh.y[b] - w1.mesh.y[a];
        const l = Math.hypot(dx, dy) || 1;
        const sp = w1.mesh.spacing;
        const [x, y] = at(w1, c);
        const stroke = line([x, y], [x + (-dy / l) * side * 5 * sp - (dx / l) * 2 * sp, y + (dx / l) * side * 5 * sp - (dy / l) * 2 * sp]);
        const r = sourceCourse(w1, w1.derived, T, stroke, {});
        if ('blocked' in r || r.plan.crossings.length) continue;
        expect(r.plan.end).toBe('river');
        expect(T.own).toContain(r.plan.join);
        eng.exec({ op: 'add_guide', guide: { id: 'src', cells: r.plan.cells, path: encodePath(r.plan.path), locked: true, spring: true, flow: 2, name: '', sourceOf: 'main' } });
        made = true;
        break;
      }
    }
    expect(made).toBe(true);
    const w = eng.world;
    const fs = w.derived.features.filter((f) => f.guide === 'main' || f.guide === 'src');
    expect(fs.length).toBe(1);
    const f = fs[0];
    expect(f.name).toBeTruthy();
    const src = w.small.guides.find((g) => g.id === 'src')!;
    // 源头那段的格在这条河的地物里
    const own = src.cells.slice(0, -1).filter((c) => isRiverCell(w, w.derived, c));
    expect(own.length).toBeGreaterThan(1);
    for (const c of own) expect(Array.from(f.cells)).toContain(c);
    // 改名：源头那段也叫新名字（同一个地物）
    eng.exec({ op: 'update_guide', id: 'main', patch: { name: '长源河' } });
    expect(eng.world.derived.features.find((x) => x.cells.includes(own[0]) && x.type === 'river')?.name).toBe('长源河');
    // 删掉主干：源头自己成一条河（有自己的名字）
    eng.exec({ op: 'remove_guide', id: 'main' });
    expect(eng.world.derived.features.some((x) => x.guide === 'src')).toBe(true);
  });

  it('画的线另一头在别的河上：不让加', () => {
    const w = continents().world;
    const stem = bigRiver(w);
    const T = naturalTarget(w, w.derived, stem.cells[10])!;
    const other = traceRivers(w).find((l) => l.guide === undefined && !l.cells!.some((c) => stem.cells.includes(c)) && l.points.length > 20)!;
    const far = other.points[Math.floor(other.points.length / 2)];
    const r = sourceCourse(w, w.derived, T, line(at(w, stem.cells[10]), far), {});
    expect('blocked' in r).toBe(true);
  });
});

// 新画一条河的命令（只为测试）
export const plain = (w: World, stroke: Pt[]) => planCourse(w, w.derived, stroke, { endOnLand: 'flow' });
